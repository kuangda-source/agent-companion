import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {VoiceBroadcasts,cafPCM,spoken,type TTSPort} from './src/voice-broadcast.ts';
import {newSession} from './src/adapters/common.ts';
import {MockState} from './src/scenarios.ts';
import {createLiveGateway} from './src/server.ts';
import {initCodex,reduceCodex,CodexAdapter} from './src/adapters/codex.ts';

function fixture(tts:TTSPort={synthesize:async()=>new Uint8Array(3200)}){const dir=mkdtempSync(join(tmpdir(),'ac-voice-'));let now=Date.now();const voice=new VoiceBroadcasts(dir,tts,()=>now);return{voice,dir,now:()=>now,advance:(n:number)=>now+=n,close:async()=>{await voice.close();rmSync(dir,{recursive:true,force:true});}};}
test('ten failures create one priority zero alert, recovery permits a new cycle, restart preserves receipts',async()=>{
 const f=fixture();try{f.voice.update({enabled:true});
 const send=(i:number,kind:'tool_failed'|'tool_recovered'='tool_failed')=>f.voice.signal({id:String(i),topic:'same-error',session_id:'session',turn_id:'turn',at:new Date(f.now()).toISOString(),kind},'测试会话');
 for(let i=0;i<10;i++)send(i);expect(f.voice.list()).toHaveLength(1);expect(f.voice.list()[0].priority).toBe(0);
 send(11,'tool_recovered');expect(f.voice.list()[0].state).toBe('cancelled');for(let i=12;i<15;i++)send(i);expect(f.voice.list()).toHaveLength(2);
 const ready=await f.voice.prepareNext(true);expect(ready).not.toBeNull();expect(f.voice.receipt(ready!.notice_id,'played')).toBe(false);expect(f.voice.receipt(ready!.notice_id,'playing')).toBe(true);
 await f.voice.close();const restored=new VoiceBroadcasts(f.dir);expect(restored.list().some(n=>n.state==='unknown')).toBe(true);expect(restored.list().some(n=>n.state==='queued')).toBe(false);await restored.close();
 }finally{rmSync(f.dir,{recursive:true,force:true});}
});
test('answer cancellation during TTS cannot publish stale audio and no host playback is used',async()=>{
 let resolve!:(v:Uint8Array)=>void;const f=fixture({synthesize:()=>new Promise(r=>resolve=r)});try{f.voice.update({enabled:true});f.voice.enqueue({id:'wait',topic:'wait',kind:'input',text:'请回答'});const preparing=f.voice.prepareNext(true);f.voice.cancel('wait');resolve(new Uint8Array(1600));expect(await preparing).toBeNull();expect(f.voice.list()[0].state).toBe('cancelled');expect(f.voice.current()).toMatchObject({target:'device',device_audio_ready:false});}finally{await f.close();}
});
test('confirmed completion and quota rollover are emitted once; deadline alone and old quota are silent',async()=>{
 const f=fixture(),s=newSession('codex','a','rollout'),mock=new MockState();s.title='合成实验';s.status_quality='confirmed';s.state='running';s.started_at=new Date(f.now()-10000).toISOString();
 const snapshot=mock.current();snapshot.agents=snapshot.agents.filter(a=>a.id==='codex');const agent=snapshot.agents[0];
 const quota=(used:number,reset:number,at=f.now())=>({window_minutes:10080,health:'fresh' as const,resets_at:new Date(reset).toISOString(),used_ratio:{value:used,quality:'confirmed' as const,source:'fixture',observed_at:new Date(at).toISOString()}});
 agent.quota=[quota(.99,f.now()+1000)];const collector={current:()=>snapshot,sessions:()=>[s],refresh:()=>mock.refresh(),detail:()=>s};
 try{f.voice.update({enabled:true});f.voice.observe(collector);expect(f.voice.list()).toHaveLength(0);f.advance(2000);f.voice.observe(collector);expect(f.voice.list()).toHaveLength(0);
 s.state='completed';s.completion_event_id='end';s.completion_event_at=new Date(f.now()).toISOString();agent.quota=[quota(.01,f.now()+7*86400000)];f.voice.observe(collector);f.voice.observe(collector);expect(f.voice.list().map(n=>n.kind).sort()).toEqual(['completed','quota']);
 f.advance(21000);const prepared=await f.voice.prepareNext();expect(prepared).not.toBeNull();expect(f.voice.list().find(n=>n.id==='end')?.state).toBe('ready');
 }finally{await f.close();}
});
test('disabled, quiet hours and muted states prevent synthesis; expired items are cancelled',async()=>{
 let calls=0;const f=fixture({synthesize:async()=>{calls++;return new Uint8Array(100);}});try{expect(f.voice.enqueue({id:'a',topic:'a',kind:'input',text:'测试'})).toBe(false);f.voice.update({enabled:true,quiet_enabled:true,quiet_start:0,quiet_end:0});f.voice.enqueue({id:'a',topic:'a',kind:'input',text:'测试'});expect(await f.voice.prepareNext(true)).toBeNull();f.voice.update({quiet_enabled:false,muted:true});expect(await f.voice.prepareNext(true)).toBeNull();f.advance(120001);f.voice.expire();expect(f.voice.list()[0].state).toBe('cancelled');expect(calls).toBe(0);}finally{await f.close();}
});
test('voice endpoints require loopback token and trusted Origin and accept only fixed synthetic test text',async()=>{
 const f=fixture(),gateway=createLiveGateway(new MockState(),'fixture-token',0,60000,undefined,undefined,undefined,undefined,undefined,f.voice),headers={Authorization:'Bearer fixture-token','Content-Type':'application/json'};
 try{const url=(p:string)=>new URL('/api/v1/voice'+p,gateway.server.url);
 expect((await fetch(url(''))).status).toBe(401);expect((await fetch(url('/config'),{method:'PATCH',headers:{...headers,Origin:'https://evil.example'},body:'{"enabled":true}'})).status).toBe(403);
 expect((await fetch(url('/config'),{method:'PATCH',headers,body:'{"enabled":true}'})).status).toBe(200);
 expect((await fetch(url('/test'),{method:'POST',headers,body:'{"text":"arbitrary"}'})).status).toBe(400);
 expect((await fetch(url('/test'),{method:'POST',headers,body:'{}'})).status).toBe(202);await new Promise(r=>setTimeout(r,5));expect(f.voice.list()[0].state).toBe('ready');
 }finally{gateway.close();await f.close();}
});
test('explicit blocking request and async request have separate semantics and tool content never becomes a notice',()=>{
 const j=initCodex(),row=(type:string,payload:Record<string,unknown>)=>reduceCodex(j,{type,timestamp:new Date().toISOString(),payload});
 row('event_msg',{type:'task_started',turn_id:'turn'});row('response_item',{type:'function_call',name:'request_user_input',call_id:'blocking',arguments:'private tool arguments'});expect(j.pending.get('blocking')?.blocking).toBe(true);
 row('response_item',{type:'function_call_output',call_id:'blocking',output:'answer'});expect(j.pending.size).toBe(0);
 row('response_item',{type:'function_call',name:'request_user_input_async',call_id:'async'});expect(j.pending.get('async')?.blocking).toBe(false);
 row('event_msg',{type:'item_completed',item:{type:'CommandExecution',id:'cmd',status:'failed',command:['fixture-command'],aggregated_output:'sensitive output'}});
 expect(JSON.stringify(j.signals)).not.toContain('sensitive output');expect(j.signals.at(-1)?.kind).toBe('tool_failed');
 row('response_item',{type:'message',role:'user',content:[{type:'input_text',text:'<send_user_message_question_reply>'+JSON.stringify([{questionItemId:JSON.stringify(['request_user_input_async','async',0]),answer:'fixture'}])+'</send_user_message_question_reply>'}]});expect(j.pending.size).toBe(0);
});
test('spoken text redacts credentials and CAF rejects incorrect sample formats',()=>{
 expect(spoken('key sk-'+'a'.repeat(40))).not.toContain('a'.repeat(40));expect(()=>cafPCM(new Uint8Array(100))).toThrow('invalid_tts_audio');
});

test('prepared PCM reaches a software device port and only its playback receipt marks the queue played',async()=>{
 const f=fixture();try{f.voice.update({enabled:true});f.voice.enqueue({id:'end-to-end',topic:'software-only',kind:'completed',text:'本轮已结束。'});await f.voice.prepareNext(true);
 let bytes=0;const port:import('../../packages/protocol/src/audio.ts').DeviceAudioPort={device_id:'software-device',audio_protocol:1,exchange:async(p,_signal,update)=>{
  if(p.kind==='audio_start')return{delivery_id:p.delivery_id,state:'accepted'};
  if(p.kind==='audio_chunk'){bytes+=p.data.length;return{delivery_id:p.delivery_id,state:'chunk',next_offset:p.offset+p.data.length};}
  update?.({delivery_id:p.delivery_id,state:'playing'});return{delivery_id:p.delivery_id,state:'played'};
 }};
 expect(await f.voice.deliverTo(port,new AbortController().signal)).toBe(true);expect(bytes).toBe(3200);expect(f.voice.list()[0].state).toBe('played');
 }finally{await f.close();}
});

test('answer arriving during transfer aborts stale playback before audio_end',async()=>{
 const f=fixture();try{f.voice.update({enabled:true});f.voice.enqueue({id:'pending-input',topic:'question',kind:'input',text:'请回答'});await f.voice.prepareNext(true);let ends=0;
 const port:import('../../packages/protocol/src/audio.ts').DeviceAudioPort={device_id:'software-device',audio_protocol:1,exchange:async(p)=>{
  if(p.kind==='audio_start')return{delivery_id:p.delivery_id,state:'accepted'};
  if(p.kind==='audio_chunk'){f.voice.cancel('question');return{delivery_id:p.delivery_id,state:'chunk',next_offset:p.offset+p.data.length};}
  if(p.kind==='audio_end')ends++;return{delivery_id:p.delivery_id,state:'rejected'};
 }};
 expect(await f.voice.deliverTo(port,new AbortController().signal)).toBe(false);expect(ends).toBe(0);expect(f.voice.list()[0].state).toBe('cancelled');
 }finally{await f.close();}
});
