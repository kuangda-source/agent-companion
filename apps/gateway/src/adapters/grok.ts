import type {Message,QuotaWindow} from "../../../../packages/protocol/src/index.ts";
import {readdir,stat,readFile} from "node:fs/promises";
import {join} from "node:path";
import {addMessage,array,cleanPublicMessage,iso,newSession,object,redactSecrets,string,type TranscriptSource} from "./common.ts";

const ROOT="Library/Application Support/Grok Bot/sand-client-persistence";
export const GROK_QUOTA_INTERVAL_MS=5*60_000;
/** File names are base32 encoded logical cache keys, not authentication material. */
export function grokCacheKey(name:string):string|null {
 if(!/^[a-z2-7]+\.blob$/i.test(name)||name.length>512)return null;
 let bits=0,value=0;const bytes:number[]=[];
 for(const ch of name.slice(0,-5).toUpperCase()){
  const digit="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(ch);value=(value<<5)|digit;bits+=5;
  if(bits>=8){bits-=8;bytes.push((value>>bits)&255);value&=(1<<bits)-1;}
 }
 return new TextDecoder().decode(new Uint8Array(bytes));
}
/** Grok Bot public entries only. Widgets, tools, events and rich-text payloads stay local. */
export function grokPublicEntries(value:unknown):Message[]{
 const messages:Message[]=[];
 for(const raw of array(object(value).entries)){
  const row=object(raw),message=object(row.message);
  const role=row.kind==="send-message"&&message.type==="text"?"assistant":row.kind==="message"?row.role:null;
  const text=cleanPublicMessage(role,row.kind==="send-message"?message.content:row.content),id=string(row.id);
  if(!id||!text||(role!=="user"&&role!=="assistant")||row.isStreaming===true)continue;
  messages.push({id,role,text,timestamp:iso(row.timestampMs)});
 }
 return messages;
}
async function blob(path:string,schema:number){
 const meta=await stat(path);if(meta.size>4*1024*1024)throw new Error("grok_cache_too_large");
 const data=object(JSON.parse(await readFile(path,"utf8")));
 if(data.schemaVersion!==schema)throw new Error("grok_cache_schema_unsupported");
 return object(data.value);
}
export function grokCachedQuota(value:unknown):QuotaWindow[]{
 const cache=object(value),reading=object(cache.reading),usage=object(reading.usage),used=usage.percentUsed,at=iso(reading.readAtMs),reset=iso(usage.nextResetMs);
 if(cache.selectedTeamId!=null||usage.hasNonZeroIncludedLimit!==true||typeof used!=="number"||!Number.isFinite(used)||used<0||used>100||!at||!reset)return [];
 return [{window_minutes:10080,used_ratio:{value:used/100,quality:"confirmed",source:"grok.bot_cache.weekly_usage",observed_at:at},resets_at:reset,health:"stale"}];
}
export class GrokAdapter {
 readonly sources=new Map<string,TranscriptSource>();
 private quota:QuotaWindow[]=[];
 private quotaCheckedAt:number|null=null;
 constructor(private home:string,private clock=()=>Date.now()){}
 async collect(){
  const root=join(this.home,ROOT);let files:string[];
  try{files=await readdir(root);}catch(error){if(object(error).code==="ENOENT")return{sessions:[],count:0,quota:[] as QuotaWindow[]};throw error;}
  const keys=files.flatMap(name=>{const key=grokCacheKey(name);return key?[{name,key}]:[];});
  // Restrict discovery to the current Bot roster and public transcript replicas.
  const rosters=keys.filter(f=>f.key.endsWith(".roster.last-roster"));
  const sessions=[];this.sources.clear();
  for(const roster of rosters){
   const scope=roster.key.slice(0,-"roster.last-roster".length),value=await blob(join(root,roster.name),4);
   for(const raw of array(value.rows)){
    const row=object(raw),id=string(row.id);if(!id||row.isRemovedFromSidebar===true||row.isGroup===true)continue;
    const session=newSession("grok",id,"bot-cache");
    session.title=redactSecrets(string(row.name)?.trim()||"未命名 Bot");session.project_name="Grok Bot";
    session.last_activity_at=iso(row.lastActivityAt);session.status_source="grok.bot_roster; runtime_not_persisted";
    // Cached activity and a last assistant response are not a running/completion event.
    session.observation_health="unknown";
    const replica=keys.find(f=>f.key===scope+"transcript.replicas."+id);
    if(replica){
     try{
      const path=join(root,replica.name),replicaValue=await blob(path,1);
      session.observation_health="fresh";
      for(const message of grokPublicEntries(replicaValue))addMessage(session,message.role,message.text,message.id,message.timestamp);
      this.sources.set(session.id,{path,project_dir:null,format:"grok-replica"});
      session.transcript_truncated=true; // A local replica may contain only the loaded portion.
     }catch{session.transcript_truncated=true;}
    }
    sessions.push(session);
   }
  }
  const now=this.clock();
  if(this.quotaCheckedAt===null||now-this.quotaCheckedAt>=GROK_QUOTA_INTERVAL_MS){
   this.quotaCheckedAt=now;let next:QuotaWindow[]=[];
   for(const item of keys.filter(f=>f.key.endsWith(".weekly-usage.cache"))){
    try{const windows=grokCachedQuota(await blob(join(root,item.name),2));if(windows.length&&(!next.length||windows[0].used_ratio.observed_at!>next[0].used_ratio.observed_at!))next=windows;}catch{ /* Optional quota does not discard readable Bot records. */ }
   }
   this.quota=next;
  }
  return {sessions,count:sessions.length,quota:structuredClone(this.quota)};
 }
}
