/** Only initialize + account/rateLimits/read; never login, start a turn or consume resets. */
import {accessSync,constants} from "node:fs";
import {homedir} from "node:os";
import {join} from "node:path";
import type {QuotaWindow} from "../../../packages/protocol/src/index.ts";
import {object} from "./adapters/common.ts";

export function parseCodexRateLimits(value:unknown,at:string):QuotaWindow[]{
 const body=object(value),buckets=object(body.rateLimitsByLimitId);
 const quota=object(buckets.codex??body.rateLimits);
 if(quota.limitId!=="codex")throw new Error("codex_quota_unavailable");
 const windows:QuotaWindow[]=[];
 for(const value of [quota.primary,quota.secondary]){
  if(value==null)continue;
  const w=object(value),used=w.usedPercent,minutes=w.windowDurationMins,reset=w.resetsAt;
  if(typeof used!=="number"||!Number.isFinite(used)||used<0||used>100||typeof minutes!=="number"||!Number.isInteger(minutes)||minutes<=0||minutes>1_000_000||!(reset==null||typeof reset==="number"&&Number.isSafeInteger(reset)&&reset>0&&reset<4102444800))throw new Error("codex_quota_invalid");
  windows.push({window_minutes:minutes,used_ratio:{value:used/100,quality:"confirmed",source:"codex.account/rateLimits/read",observed_at:at},resets_at:typeof reset==="number"?new Date(reset*1000).toISOString():null,health:"fresh"});
 }
 if(!windows.length)throw new Error("codex_quota_unavailable");
 return windows;
}
export function codexExecutable():string|null{
 const paths=[process.env.CODEX_CLI_PATH,Bun.which("codex"),"/Applications/Codex.app/Contents/Resources/codex","/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex","/opt/homebrew/bin/codex","/usr/local/bin/codex",join(homedir(),".local/bin/codex")];
 for(const path of paths)if(path){try{accessSync(path,constants.X_OK);return path;}catch{}}
 return null;
}

/** A bounded subprocess is reaped after the single read, including timeout/cancellation. */
export async function quotaRpc(command:string[],signal:AbortSignal,timeoutMs=12000):Promise<unknown>{
 return codexReadonlyRpc(command,signal,{method:"account/rateLimits/read"},timeoutMs);
}
/** Explicit allowlist: no thread loading/resuming, provider requests or user actions. */
export async function codexReadonlyRpc(command:string[],signal:AbortSignal,request:{method:"account/rateLimits/read"|"thread/list";params?:Record<string,unknown>},timeoutMs=12000):Promise<unknown>{
 if(!["account/rateLimits/read","thread/list"].includes(request.method))throw new Error("codex_rpc_method_denied");
 if(signal.aborted)throw new Error("codex_quota_cancelled");
 const child=Bun.spawn(command,{stdin:"pipe",stdout:"pipe",stderr:"ignore"});
 let timedOut=false;
 let abortKill:ReturnType<typeof setTimeout>|undefined;
 const abort=()=>{child.kill();abortKill=setTimeout(()=>child.kill("SIGKILL"),1000);};signal.addEventListener("abort",abort,{once:true});
 const timeout=setTimeout(()=>{timedOut=true;child.kill();},timeoutMs);
 const hardKill=setTimeout(()=>child.kill("SIGKILL"),timeoutMs+1000);
 const reader=child.stdout.getReader(),decoder=new TextDecoder();let buffer="",bytes=0;
 const send=(v:unknown)=>child.stdin.write(JSON.stringify(v)+"\n");
 try{
  send({id:1,method:"initialize",params:{clientInfo:{name:"agent_companion",title:"Agent Companion",version:"0.4.2"},capabilities:{experimentalApi:false}}});
  let initialized=false;
  while(true){
   const chunk=await reader.read();if(chunk.done)break;
   bytes+=chunk.value.byteLength;if(bytes>256*1024)throw new Error("codex_quota_response_limit");
   buffer+=decoder.decode(chunk.value,{stream:true});
   let end:number;
   while((end=buffer.indexOf("\n"))>=0){
    const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let data:Record<string,unknown>;
    try{data=object(JSON.parse(line));}catch{continue;}
    if(data.id===1&&!initialized){
     if(data.error)throw new Error("codex_quota_initialize_failed");
     initialized=true;send({method:"initialized",params:{}});send({id:2,...request});
    }else if(data.id===2&&initialized){
     if(data.error)throw new Error("codex_quota_read_failed");
     return data.result;
    }
   }
  }
  throw new Error(signal.aborted?"codex_quota_cancelled":timedOut?"codex_quota_timeout":"codex_quota_process_exited");
 }finally{
  clearTimeout(timeout);signal.removeEventListener("abort",abort);
  child.stdin.end();child.kill();
  const cleanup=setTimeout(()=>child.kill("SIGKILL"),1000);
  await child.exited;clearTimeout(cleanup);clearTimeout(hardKill);clearTimeout(abortKill);
  await reader.cancel().catch(()=>{});reader.releaseLock();
 }
}
export class CodexQuotaReader {
 private mode:"proxy"|"stdio"="proxy";
 constructor(private executable=codexExecutable()){}
 async read(signal:AbortSignal):Promise<QuotaWindow[]>{
  if(!this.executable)throw new Error("codex_cli_not_found");
  let value:unknown;
  if(this.mode==="proxy"){
   try{value=await quotaRpc([this.executable,"app-server","proxy"],signal);}
   catch{if(signal.aborted)throw new Error("codex_quota_cancelled");this.mode="stdio";}
  }
  if(this.mode==="stdio")value=await quotaRpc([this.executable,"app-server","--listen","stdio://"],signal);
  return parseCodexRateLimits(value,new Date().toISOString());
 }
}
