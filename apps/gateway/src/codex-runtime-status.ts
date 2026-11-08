import {codexExecutable,codexReadonlyRpc} from "./codex-quota-rpc.ts";
import {array,object} from "./adapters/common.ts";
export type CodexRuntimeStatus="running"|"waiting_user"|"error";
export function parseRuntimeStatus(value:unknown):Map<string,CodexRuntimeStatus>{
 const result=new Map<string,CodexRuntimeStatus>();
 for(const entry of array(object(value).data)){
  const thread=object(entry),status=object(thread.status);if(typeof thread.id!=="string")continue;
  if(status.type==="systemError")result.set(thread.id,"error");
  else if(status.type==="active"){
   const flags=array(status.activeFlags);result.set(thread.id,flags.includes("waitingOnApproval")||flags.includes("waitingOnUserInput")?"waiting_user":"running");
  }
 }return result;
}
/** Proxy only: a separate stdio server cannot attest to the desktop's live wait state. */
export class CodexRuntimeStatusReader {
 private value=new Map<string,CodexRuntimeStatus>();private at=0;private last=0;private pending:Promise<void>|null=null;private abort:AbortController|null=null;private closed=false;private failures=0;private next=0;
 constructor(private executable=codexExecutable(),private read=(signal:AbortSignal)=>codexReadonlyRpc([executable!,"app-server","proxy"],signal,{method:"thread/list",params:{limit:50,sortKey:"updated_at",useStateDbOnly:true,modelProviders:[],sourceKinds:["cli","vscode","exec","appServer","subAgent","subAgentReview","subAgentCompact","subAgentThreadSpawn","subAgentOther","unknown"]}},4000)){}
 current(){const now=Date.now();if(!this.closed&&this.executable&&!this.pending&&now>=this.next&&now-this.last>=5000){this.last=now;const controller=new AbortController();this.abort=controller;this.pending=this.read(controller.signal).then(raw=>{if(!this.closed){this.value=parseRuntimeStatus(raw);this.at=Date.now();this.failures=0;this.next=this.at+5000;}}).catch(()=>{this.value.clear();this.next=Date.now()+Math.min(60000,5000*2**Math.min(this.failures++,4));}).finally(()=>{this.pending=null;this.abort=null;});}return now-this.at<12000?this.value:new Map<string,CodexRuntimeStatus>();}
 async close(){this.closed=true;this.abort?.abort();await this.pending;}
}
