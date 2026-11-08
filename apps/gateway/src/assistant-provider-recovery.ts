import type {Database} from "bun:sqlite";

const KEY="assistant_provider_recovery_v1";
const RETRYABLE=/^provider_(http_(408|429|5\d\d)|no_accounts|timeout|network_error)$/;
interface Recovery {consecutive_failures:number;last_error:string|null;last_failed_at:number;next_retry_at:number}
const empty=():Recovery=>({consecutive_failures:0,last_error:null,last_failed_at:0,next_retry_at:0});

/** Persist only safe error codes and retry times, never provider bodies or prompts. */
export class AssistantProviderRecovery {
 private value=empty();
 constructor(private db:Database,private clock:()=>number){
  try{
   const row=db.query<{value:string},[]>("SELECT value FROM meta WHERE key='assistant_provider_recovery_v1'").get();
   if(row){const v=JSON.parse(row.value) as Recovery;
    if(Number.isSafeInteger(v.consecutive_failures)&&v.consecutive_failures>0&&v.consecutive_failures<=1000&&typeof v.last_error==="string"&&RETRYABLE.test(v.last_error)&&Number.isFinite(v.last_failed_at)&&Number.isFinite(v.next_retry_at)&&v.last_failed_at>0&&v.next_retry_at>=v.last_failed_at)this.value=v;
   }
  }catch{} // A broken recovery record must not prevent local monitoring from starting.
 }
 private save(){this.db.query("INSERT OR REPLACE INTO meta VALUES(?,?)").run(KEY,JSON.stringify(this.value));}
 failed(code:string){
  if(!RETRYABLE.test(code))return;
  const count=Math.min(1000,this.value.consecutive_failures+1),now=this.clock();
  const delay=Math.min(60,5*2**Math.min(count-1,4))*60000;
  this.value={consecutive_failures:count,last_error:code,last_failed_at:now,next_retry_at:now+delay};this.save();
 }
 reset(){if(this.value.consecutive_failures){this.value=empty();this.save();}}
 pending(){return this.value.consecutive_failures>0;}
 ready(){return this.clock()>=this.value.next_retry_at;}
 current(){return{consecutive_failures:this.value.consecutive_failures,last_error:this.value.last_error,
  last_failed_at:this.value.last_failed_at?new Date(this.value.last_failed_at).toISOString():null,
  next_retry_at:this.value.next_retry_at?new Date(this.value.next_retry_at).toISOString():null};}
}

/** Recognize one actionable upstream condition without retaining arbitrary error text. */
export async function providerErrorCode(response:Response):Promise<string>{
 let code=`provider_http_${response.status}`;
 if(response.status!==503){await response.body?.cancel();return code;}
 const reader=response.body?.getReader();if(!reader)return code;
 try{
  const chunks:Uint8Array[]=[];let size=0;
  while(size<=16384){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>16384)return code;chunks.push(part.value);}
  const value=JSON.parse(Buffer.concat(chunks).toString("utf8")) as {error?:{message?:unknown}};
  if(typeof value?.error?.message==="string"&&/no available accounts/i.test(value.error.message))code="provider_no_accounts";
 }catch{}finally{await reader.cancel().catch(()=>{});}
 return code;
}
