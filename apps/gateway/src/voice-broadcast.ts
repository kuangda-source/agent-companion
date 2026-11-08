import {Database} from 'bun:sqlite';
import {chmodSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Collector} from './state.ts';
import type {ImportantChange} from './assistant-notifications.ts';
import {digest} from './assistant-source.ts';
import {object,redactSecrets} from './adapters/common.ts';
import type {MonitorSignal} from './monitor-signals.ts';
import {transmitAudio,type DeviceAudioPort} from '../../../packages/protocol/src/audio.ts';

export type VoiceKind='input'|'error'|'completed'|'milestone'|'quota';
export type DeliveryState='queued'|'preparing'|'ready'|'playing'|'played'|'cancelled'|'failed'|'unknown';
export interface VoiceConfig {enabled:boolean;muted:boolean;quiet_enabled:boolean;quiet_start:number;quiet_end:number;provider:'system';voice:string}
export interface VoiceNotice {id:string;topic:string;session_id:string|null;kind:VoiceKind;priority:number;text:string;created_at:number;expires_at:number;not_before:number;state:DeliveryState;audio_id:string|null}
export interface VoiceAudio {id:string;codec:'pcm_s16le';sample_rate:16000;channels:1;bytes:number;sha256:string}
export interface TTSPort {synthesize(text:string,voice:string,signal:AbortSignal):Promise<Uint8Array>}
const initial=():VoiceConfig=>({enabled:false,muted:false,quiet_enabled:false,quiet_start:22*60,quiet_end:8*60,provider:'system',voice:''});
const TTL:Record<VoiceKind,number>={input:120000,error:120000,completed:600000,milestone:600000,quota:900000};
export function spoken(value:string,max=160){return [...redactSecrets(value).replace(/```[\s\S]*?```/g,'').replace(/https?:\/\/\S+/g,'').replace(/\[[^\]]*\]\([^)]*\)/g,'').replace(/[*#`>_]/g,'').replace(/\s+/g,' ').trim()].slice(0,max).join('');}

/** Durable event queue. No implicit host playback and no model credentials. */
export class VoiceBroadcasts {
  private db:Database;private config:VoiceConfig;private busy=false;private delivering=false;private deliveryTopic:string|null=null;private deliveryAbort:AbortController|null=null;private closed=false;private abort:AbortController|null=null;private observed=false;
  constructor(private runtime:string,private tts?:TTSPort,private clock:()=>number=()=>Date.now()){
    mkdirSync(runtime,{recursive:true,mode:0o700});this.db=new Database(join(runtime,'voice.sqlite'));chmodSync(join(runtime,'voice.sqlite'),0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS voice_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS voice_notices(id TEXT PRIMARY KEY,topic TEXT NOT NULL,session_id TEXT,kind TEXT NOT NULL,priority INTEGER NOT NULL,text TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,not_before INTEGER NOT NULL,state TEXT NOT NULL,audio_id TEXT);
      CREATE TABLE IF NOT EXISTS voice_seen(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS voice_faults(topic TEXT PRIMARY KEY,cycle INTEGER NOT NULL,count INTEGER NOT NULL,open INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS voice_audio(id TEXT PRIMARY KEY,data BLOB NOT NULL,info TEXT NOT NULL);`);
    const saved=this.get('config');this.config=saved?{...initial(),...JSON.parse(saved)}:initial();
    this.db.exec("UPDATE voice_notices SET state='unknown' WHERE state='playing'; UPDATE voice_notices SET state='queued' WHERE state='preparing'");
  }
  private get(key:string){return this.db.query<{value:string},[string]>('SELECT value FROM voice_meta WHERE key=?').get(key)?.value;}
  private set(key:string,value:unknown){this.db.query('INSERT OR REPLACE INTO voice_meta VALUES(?,?)').run(key,JSON.stringify(value));}
  configuration(){return {...this.config};}
  update(input:unknown){const p=object(input),next={...this.config};if(!Object.keys(p).length||Object.keys(p).some(k=>!(k in next)))throw new Error('invalid_voice_config');
    for(const key of ['enabled','muted','quiet_enabled'] as const)if(p[key]!==undefined){if(typeof p[key]!=='boolean')throw new Error('invalid_voice_config');next[key]=p[key];}
    for(const key of ['quiet_start','quiet_end'] as const)if(p[key]!==undefined){if(!Number.isInteger(p[key])||Number(p[key])<0||Number(p[key])>=1440)throw new Error('invalid_voice_config');next[key]=Number(p[key]);}
    if(p.provider!==undefined&&p.provider!=='system')throw new Error('invalid_voice_config');
    if(p.voice!==undefined){if(typeof p.voice!=='string'||p.voice.length>100||/[\x00-\x1f]/.test(p.voice))throw new Error('invalid_voice_config');next.voice=p.voice;}
    if(next.enabled!==this.config.enabled){this.observed=false;this.set('enabled_since',this.clock());this.db.exec("UPDATE voice_notices SET state='cancelled' WHERE state IN ('queued','ready','preparing')");}
    this.config=next;this.set('config',next);if(!next.enabled||next.muted){this.abort?.abort();this.deliveryAbort?.abort();}return this.configuration();
  }
  private quiet(){const date=new Date(this.clock()),minute=date.getHours()*60+date.getMinutes(),{quiet_start:a,quiet_end:b}=this.config;return this.config.quiet_enabled&&(a===b||(a<b?minute>=a&&minute<b:minute>=a||minute<b));}
  enqueue(input:{id:string;topic:string;session_id?:string|null;kind:VoiceKind;text:string;at?:number;delay?:number}){
    if(!this.config.enabled)return false;const now=this.clock(),at=input.at??now,text=spoken(input.text);if(!text||!Number.isFinite(at)||at>now+60000||now-at>TTL[input.kind])return false;
    const changed=this.db.query("INSERT OR IGNORE INTO voice_notices VALUES(?,?,?,?,?,?,?,?,?,'queued',NULL)").run(input.id,input.topic,input.session_id??null,input.kind,['input','error'].includes(input.kind)?0:input.kind==='quota'?2:1,text,at,at+TTL[input.kind],now+(input.delay??0));
    return changed.changes>0;
  }
  cancel(topic:string){this.db.query("UPDATE voice_notices SET state='cancelled' WHERE topic=? AND state IN ('queued','preparing','ready')").run(topic);if(this.deliveryTopic===topic)this.deliveryAbort?.abort();}
  signal(value:MonitorSignal,title:string){
    if(!this.config.enabled||this.clock()-Date.parse(value.at)>120000)return;
    if(!this.db.query('INSERT OR IGNORE INTO voice_seen VALUES(?)').run(value.session_id+':'+value.id+':'+value.kind).changes)return;
    const topic=value.session_id+':'+value.turn_id+':'+value.topic;
    if(value.kind==='input_resolved'){this.cancel(topic);return;}
    if(value.kind==='input_requested'){this.enqueue({id:digest('input:'+topic),topic,session_id:value.session_id,kind:'input',text:`${title}需要你${value.blocking?'回答或确认':'回答一个问题'}。`,at:Date.parse(value.at)});return;}
    const fault=this.db.query<{cycle:number;count:number;open:number},[string]>('SELECT * FROM voice_faults WHERE topic=?').get(topic)??{cycle:0,count:0,open:0};
    if(value.kind==='tool_recovered'){this.db.query('INSERT OR REPLACE INTO voice_faults VALUES(?,?,0,0)').run(topic,fault.cycle);this.cancel(topic);return;}
    const cycle=fault.cycle+(fault.open?0:1),count=fault.count+1;this.db.query('INSERT OR REPLACE INTO voice_faults VALUES(?,?,?,1)').run(topic,cycle,count);
    if(count>=3)this.enqueue({id:digest(topic+':fault:'+cycle),topic,session_id:value.session_id,kind:'error',text:`${title}出现重复错误，请查看当前任务。`,at:Date.parse(value.at)});
  }
  observe(collector:Collector){
    if(!this.config.enabled)return;
    const sessions=collector.sessions?.()??collector.current().sessions,now=this.clock();
    for(const s of sessions){
      const previous=this.get('session:'+s.id),old=previous?JSON.parse(previous) as {completion:string|null;state:string;started:string|null}:null;
      if(this.observed&&s.observation_health==='fresh'&&s.status_quality==='confirmed'){
        if(['running','completed','idle','error'].includes(s.state))this.cancel(s.id+':wait');
        if(s.state==='waiting_user'&&!s.status_source.includes('explicit_input_request')&&old&&old.state!=='waiting_user')this.enqueue({id:digest(s.id+':wait:'+s.started_at+':'+s.status_observed_at),topic:s.id+':wait',session_id:s.id,kind:'input',text:`${s.title}正在等待你的输入或确认。`,at:Date.parse(s.status_observed_at??'')});
        if(old&&s.completion_event_id&&s.completion_event_id!==old.completion){
          const message=s.messages.findLast(m=>m.role==='assistant'),at=Date.parse(s.completion_event_at??''),messageAt=Date.parse(message?.timestamp??''),reply=message&&messageAt>=Date.parse(s.started_at??'')&&Math.abs(at-messageAt)<120000?spoken(message.text,90):'';
          if(this.enqueue({id:s.completion_event_id,topic:s.id+':completed:'+s.completion_event_id,session_id:s.id,kind:'completed',text:`${spoken(s.title,40)}本轮已结束。${reply?'助手回复：'+reply:''}`,at,delay:20000}))this.set('completion-start:'+s.completion_event_id,s.started_at?Date.parse(s.started_at):at);
        }
      }
      this.set('session:'+s.id,{completion:s.completion_event_id,state:s.state,started:s.started_at});
    }
    for(const agent of collector.current().agents)for(const quota of agent.quota){
      const key='quota:'+agent.id+':'+quota.window_minutes,oldValue=this.get(key),old=oldValue?JSON.parse(oldValue) as {reset:string|null;used:number;at:string}:null;
      const used=quota.used_ratio.value,at=quota.used_ratio.observed_at;if(quota.health==='stale'||quota.used_ratio.quality!=='confirmed'||used===null||!at||now-Date.parse(at)>120000||Date.parse(at)>now+60000)continue;
      if(this.observed&&old&&Date.parse(at)>Date.parse(old.at)&&used<old.used&&quota.resets_at!==old.reset&&old.reset&&Date.parse(old.reset)<=Date.parse(at)&&quota.resets_at&&Date.parse(quota.resets_at)>Date.parse(at))this.enqueue({id:digest(key+':'+quota.resets_at),topic:key,kind:'quota',text:`${agent.name}的${quota.window_minutes%1440===0?quota.window_minutes/1440+'天':quota.window_minutes/60+'小时'}额度已重置。`,at:Date.parse(at)});
      this.set(key,{reset:quota.resets_at,used,at});
    }
    // The first snapshot is a baseline; do not replay historical tool/request events.
    const signals=collector.signals?.()??[];
    if(this.observed)for(const s of signals){const session=sessions.find(v=>v.id===s.session_id);if(session?.observation_health==='fresh')this.signal(s,session.title);}
    else for(const s of signals)this.db.query('INSERT OR IGNORE INTO voice_seen VALUES(?)').run(s.session_id+':'+s.id+':'+s.kind);
    this.observed=true;this.expire();
    const ids=new Set(sessions.map(s=>s.id));for(const n of this.list())if(n.session_id&&!ids.has(n.session_id)&&['queued','ready'].includes(n.state))this.cancel(n.topic);
  }
  important(change:ImportantChange,sessionId?:string){if(!['milestone','completed','blocker','decision','resolved'].includes(change.kind))return;
    if(change.source_at<Number(this.get('enabled_since')??this.clock())-120000)return;
    if(sessionId&&['milestone','completed'].includes(change.kind)&&this.enrichCompletion(sessionId,change.text,change.source_at))return;
    if(change.kind==='resolved')this.cancel(change.project_id+':'+change.key);
    this.enqueue({id:digest([change.project_id,change.key,change.kind,change.source_at].join(':')),topic:change.project_id+':'+change.key,session_id:sessionId,kind:['blocker','decision'].includes(change.kind)?'error':'milestone',text:'项目更新：'+change.text,delay:20000});}
  enrichCompletion(sessionId:string,text:string,sourceAt:number){
    const row=this.db.query<VoiceNotice,[string]>("SELECT * FROM voice_notices WHERE session_id=? AND kind='completed' AND state='queued' ORDER BY created_at DESC LIMIT 1").get(sessionId);
    const started=row?Number(this.get('completion-start:'+row.id)??row.created_at):0;
    if(row&&Number.isFinite(sourceAt)&&sourceAt>=started){this.db.query('UPDATE voice_notices SET text=? WHERE id=?').run(spoken(row.text.split('助手回复：')[0].split('简要结果：')[0]+'简要结果：'+text),row.id);return true;}return false;
  }
  expire(){this.db.query("UPDATE voice_notices SET state='cancelled' WHERE expires_at<=? AND state IN ('queued','ready','preparing')").run(this.clock());this.db.exec("DELETE FROM voice_audio WHERE id NOT IN (SELECT audio_id FROM voice_notices WHERE audio_id IS NOT NULL AND state IN ('ready','playing') UNION SELECT audio_id FROM (SELECT audio_id FROM voice_notices WHERE state='played' AND audio_id IS NOT NULL ORDER BY created_at DESC LIMIT 8))");}
  list(){return this.db.query<VoiceNotice,[]>("SELECT * FROM voice_notices ORDER BY created_at DESC LIMIT 80").all();}
  current(){this.expire();return{schema_version:1,configuration:this.configuration(),target:'device',device_audio_ready:false,status:!this.config.enabled?'disabled':this.config.muted?'muted':this.quiet()?'quiet':'awaiting_device_audio',notices:this.list(),tts_available:!!this.tts};}
  async prepareNext(force=false){
    if(this.closed||this.busy||!this.config.enabled||this.config.muted||this.quiet()||!this.tts)return null;this.expire();
    if(this.db.query<{n:number},[]>("SELECT COUNT(*) AS n FROM voice_notices WHERE state='ready'").get()!.n>=8)return null;
    const now=this.clock(),last=Number(this.get('last_prepared')??0);if(!force&&now-last<15000)return null;
    const notice=this.db.query<VoiceNotice,[number]>("SELECT * FROM voice_notices WHERE state='queued' AND not_before<=? ORDER BY priority,created_at LIMIT 1").get(now);if(!notice)return null;
    this.busy=true;const controller=new AbortController();this.abort=controller;
    this.db.query("UPDATE voice_notices SET state='preparing' WHERE id=?").run(notice.id);
    try{
      const pcm=await this.tts.synthesize(notice.text,this.config.voice,controller.signal);
      if(pcm.byteLength<2||pcm.byteLength>960000||pcm.byteLength%2)throw new Error('invalid_tts_audio');
      if(this.closed||controller.signal.aborted)return null;
      const fresh=this.db.query<VoiceNotice,[string]>('SELECT * FROM voice_notices WHERE id=?').get(notice.id)!;
      if(fresh.state!=='preparing'||fresh.expires_at<=this.clock())return null;
      const id=digest(Buffer.from(pcm).toString('base64')),info:VoiceAudio={id,codec:'pcm_s16le',sample_rate:16000,channels:1,bytes:pcm.byteLength,sha256:Bun.CryptoHasher.hash('sha256',pcm,'hex')};
      this.db.transaction(()=>{this.db.query('INSERT OR IGNORE INTO voice_audio VALUES(?,?,?)').run(id,pcm,JSON.stringify(info));this.db.query("UPDATE voice_notices SET state='ready',audio_id=? WHERE id=?").run(id,notice.id);this.set('last_prepared',this.clock());})();return{notice_id:notice.id,audio:info};
    }catch{if(!this.closed)this.db.query("UPDATE voice_notices SET state='failed' WHERE id=? AND state='preparing'").run(notice.id);return null;}
    finally{if(!this.closed)this.db.query("UPDATE voice_notices SET state='cancelled' WHERE id=? AND state='preparing'").run(notice.id);this.busy=false;this.abort=null;}
  }
  audio(id:string){const row=this.db.query<{data:Uint8Array;info:string},[string]>('SELECT * FROM voice_audio WHERE id=?').get(id);return row?{data:new Uint8Array(row.data),info:JSON.parse(row.info) as VoiceAudio}:null;}
  receipt(id:string,state:'playing'|'played'|'unknown'){
    const row=this.db.query<VoiceNotice,[string]>('SELECT * FROM voice_notices WHERE id=?').get(id);if(!row||!((row.state==='ready'&&state==='playing')||(row.state==='playing'&&['played','unknown'].includes(state))))return false;
    this.db.query('UPDATE voice_notices SET state=? WHERE id=?').run(state,id);return true;
  }
  /** Called only by a link adapter after authenticated device capability negotiation.
   * The current board does not advertise audio; production links do not call this yet. */
  async deliverTo(port:DeviceAudioPort,signal:AbortSignal){
    this.expire();if(this.delivering||this.closed||!this.config.enabled||this.config.muted||this.quiet())return false;
    const row=this.db.query<VoiceNotice,[]>("SELECT * FROM voice_notices WHERE state='ready' ORDER BY priority,created_at LIMIT 1").get();
    if(!row?.audio_id)return false;const audio=this.audio(row.audio_id);if(!audio)return false;
    this.delivering=true;this.deliveryTopic=row.topic;
    const controller=new AbortController();this.deliveryAbort=controller;const abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    try{await transmitAudio(port,row.id,audio.info,audio.data,row.expires_at,controller.signal,state=>this.receipt(row.id,state),this.clock);return true;}
    catch{return false;}finally{signal.removeEventListener('abort',abort);this.deliveryAbort=null;this.deliveryTopic=null;this.delivering=false;}
  }
  async close(){this.closed=true;this.abort?.abort();this.deliveryAbort?.abort();while(this.busy||this.delivering)await new Promise(r=>setTimeout(r,5));this.db.close();}
}

/** macOS renders PCM into a file; this command never plays it on the Mac. */
export class MacSystemTTS implements TTSPort {
  constructor(private directory:string){}
  async synthesize(text:string,voice:string,signal:AbortSignal){
    const dir=join(this.directory,'voice-temp');mkdirSync(dir,{recursive:true,mode:0o700});const id=crypto.randomUUID(),input=join(dir,id+'.txt'),output=join(dir,id+'.pcm');
    writeFileSync(input,spoken(text),{mode:0o600});
    const args=['/usr/bin/say','-f',input,'-o',output,'--file-format=caff','--data-format=LEI16@16000','--channels=1',...(voice?['-v',voice]:[])];
    let hard:ReturnType<typeof setTimeout>|undefined;
    const child=Bun.spawn(args,{stdout:'ignore',stderr:'ignore'}),abort=()=>{child.kill();hard=setTimeout(()=>child.kill('SIGKILL'),1000);};signal.addEventListener('abort',abort,{once:true});const timeout=setTimeout(abort,20000);
    try{if(signal.aborted)abort();if(await child.exited!==0||signal.aborted)throw new Error('tts_failed');return cafPCM(readFileSync(output));}
    finally{clearTimeout(timeout);clearTimeout(hard);signal.removeEventListener('abort',abort);const {unlinkSync}=await import('node:fs');for(const f of [input,output])try{unlinkSync(f);}catch{}}
  }
}
/** Strict CAF container reader for the fixed PCM format emitted by say. */
export function cafPCM(bytes:Uint8Array):Uint8Array {
  const b=Buffer.from(bytes);if(b.length<8||b.toString('ascii',0,4)!=='caff')throw new Error('invalid_tts_audio');let pos=8,valid=false;
  while(pos+12<=b.length){const kind=b.toString('ascii',pos,pos+4),size=Number(b.readBigInt64BE(pos+4));pos+=12;if(size<0||!Number.isSafeInteger(size)||pos+size>b.length)throw new Error('invalid_tts_audio');
    if(kind==='desc'){if(size!==32||b.readDoubleBE(pos)!==16000||b.toString('ascii',pos+8,pos+12)!=='lpcm'||b.readUInt32BE(pos+12)!==2||b.readUInt32BE(pos+16)!==2||b.readUInt32BE(pos+20)!==1||b.readUInt32BE(pos+24)!==1||b.readUInt32BE(pos+28)!==16)throw new Error('invalid_tts_audio');valid=true;}
    if(kind==='data'){if(!valid||size<6)return new Uint8Array();return new Uint8Array(b.subarray(pos+4,pos+size));}pos+=size;
  }throw new Error('invalid_tts_audio');
}
