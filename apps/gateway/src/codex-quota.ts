import {chmodSync,existsSync,readFileSync,renameSync,statSync,writeFileSync} from "node:fs";
import type {QuotaWindow} from "../../../packages/protocol/src/index.ts";
import {currentCodexQuota} from "./adapters/codex.ts";
import {array,object} from "./adapters/common.ts";
import {parseCodexRateLimits} from "./codex-quota-rpc.ts";

export const QUOTA_TIMING={active_ms:60_000,idle_low_ms:3600_000,minimum_gap_ms:10_000};
type Reason="startup"|"started"|"stopped"|"wake"|"manual"|"reset"|"active"|"idle_low";
export type QuotaRead=(signal:AbortSignal)=>Promise<QuotaWindow[]>;
function observed(windows:QuotaWindow[]){return Math.max(-Infinity,...windows.map(w=>Date.parse(w.used_ratio.observed_at??"")));}
export function lowQuota(windows:QuotaWindow[]){return windows.some(w=>typeof w.used_ratio.value==="number"&&w.used_ratio.value>.8);}

/** Network reads follow activity/events; idle low balance is strictly remaining <20%. */
export class CodexQuotaMonitor {
 private windows:QuotaWindow[]=[];
 private turns=new Set<string>();
 private active=false;private initialized=false;private closed=false;
 private reasons=new Set<Reason>(["startup"]);private resetAttempts=new Set<string>();
 private pending:Promise<void>|null=null;private abort:AbortController|null=null;
 private attempted:number|null=null;private successful:number|null=null;private error:string|null=null;
 private lastReason:Reason|null=null;private queries=0;
 constructor(private read?:QuotaRead,private file?:string,private clock=()=>Date.now()){
  if(file&&existsSync(file))try{
   if(statSync(file).size>16384)throw new Error("oversized_cache");
   const saved=object(JSON.parse(readFileSync(file,"utf8"))),at=saved.observed_at,rows=array(saved.windows);
   if(saved.schema_version!==1||typeof at!=="string"||!Number.isFinite(Date.parse(at))||Date.parse(at)>clock()+120000||rows.length<1||rows.length>2)throw new Error("invalid_cache");
   const convert=(v:unknown)=>{const w=object(v);return {usedPercent:typeof object(w.used_ratio).value==="number"?Number(object(w.used_ratio).value)*100:NaN,windowDurationMins:w.window_minutes,resetsAt:typeof w.resets_at==="string"?Date.parse(w.resets_at)/1000:null};};
   this.windows=parseCodexRateLimits({rateLimits:{limitId:"codex",primary:convert(rows[0]),secondary:rows[1]?convert(rows[1]):null}},at);
  }catch{this.error="codex_quota_cache_invalid";}
 }
 private save(){
  if(!this.file)return;
  const value={schema_version:1,observed_at:new Date(observed(this.windows)).toISOString(),windows:this.windows};
  writeFileSync(this.file+".tmp",JSON.stringify(value),{mode:0o600});chmodSync(this.file+".tmp",0o600);renameSync(this.file+".tmp",this.file);
 }
 observe(active:boolean,logs:QuotaWindow[],runningTurns?:string[]){
  if(this.closed)return;
  if(runningTurns){const next=new Set(runningTurns);if(this.initialized&&runningTurns.some(t=>!this.turns.has(t)))this.reasons.add("started");this.turns=next;}
  if(this.initialized&&active!==this.active)this.reasons.add(active?"started":"stopped");
  this.active=active;this.initialized=true;
  if(logs.length&&observed(logs)>observed(this.windows)){
   // A log with the old reset window must not undo an account-confirmed early reset.
   const conflict=this.windows.some(w=>w.used_ratio.source==="codex.account/rateLimits/read"&&logs.some(l=>l.window_minutes===w.window_minutes&&l.resets_at&&w.resets_at&&Math.abs(Date.parse(l.resets_at)-Date.parse(w.resets_at))>5000));
   // Rejected logs must not create their own polling loop; normal activity/reset events confirm.
   if(!conflict)this.windows=structuredClone(logs);
  }
  this.tick();
 }
 trigger(reason:"wake"|"manual"){
  if(this.closed||this.attempted!==null&&this.clock()-this.attempted<QUOTA_TIMING.minimum_gap_ms)return;
  this.reasons.add(reason);this.tick();
 }
 private resetDue(){return this.windows.filter(w=>w.resets_at&&Date.parse(w.resets_at)<=this.clock()&&!this.resetAttempts.has(w.resets_at));}
 tick(){
  if(this.closed||!this.read||this.pending)return;
  const now=this.clock();if(this.attempted!==null&&now-this.attempted<QUOTA_TIMING.minimum_gap_ms)return;
  const reset=this.resetDue();
  let reason:Reason|undefined=this.reasons.values().next().value;
  if(!reason&&reset.length)reason="reset";
  if(!reason&&this.attempted!==null&&now-this.attempted>=(this.active?QUOTA_TIMING.active_ms:QUOTA_TIMING.idle_low_ms)){
   if(this.active)reason="active";else if(lowQuota(this.windows))reason="idle_low";
  }
  if(!reason)return;
  for(const w of reset)this.resetAttempts.add(w.resets_at!);
  if(this.resetAttempts.size>32)this.resetAttempts=new Set([...this.resetAttempts].slice(-32));
  this.reasons.clear();this.lastReason=reason;this.attempted=now;this.queries++;
  const abort=new AbortController();this.abort=abort;
  // Always settle a throwing query within the monitor, independently of the view channel.
  this.pending=Promise.resolve().then(()=>this.read!(abort.signal)).then(windows=>{
   if(this.closed)return;
   if(!windows.length)throw new Error("codex_quota_unavailable");
   this.windows=structuredClone(windows);this.successful=this.clock();this.error=null;
   try{this.save();}catch{this.error="codex_quota_cache_failed";}
  }).catch(error=>{
   if(this.closed)return;
   const message=error instanceof Error?error.message:"";
   this.error=/^(codex_cli_not_found|codex_quota_[a-z_]+)$/.test(message)?message:"codex_quota_read_failed";
  }).finally(()=>{this.pending=null;this.abort=null;});
 }
 current(){
  const result=currentCodexQuota(this.windows,new Date(this.clock()).toISOString());
  if(this.error&&this.attempted!==null&&observed(result)<=this.attempted)for(const w of result)w.health="stale";
  return result;
 }
 status(){
  const now=this.clock(),times:number[]=[];
  if(this.read){
   if(this.reasons.size)times.push(Math.max(now,(this.attempted??-Infinity)+QUOTA_TIMING.minimum_gap_ms));
   if(this.attempted!==null&&(this.active||lowQuota(this.windows)))times.push(this.attempted+(this.active?QUOTA_TIMING.active_ms:QUOTA_TIMING.idle_low_ms));
   for(const w of this.windows)if(w.resets_at&&!this.resetAttempts.has(w.resets_at))times.push(Math.max(Date.parse(w.resets_at),(this.attempted??-Infinity)+QUOTA_TIMING.minimum_gap_ms));
  }
  const date=(n:number|null)=>n===null?null:new Date(n).toISOString();
  return {enabled:!!this.read,active:this.active,idle_low_balance:!this.active&&lowQuota(this.windows),idle_threshold_remaining_percent:20,idle_interval_seconds:3600,active_interval_seconds:60,in_flight:!!this.pending,last_reason:this.lastReason,last_attempt_at:date(this.attempted),last_success_at:date(this.successful),last_error:this.error,queries:this.queries,next_check_at:times.length?date(Math.max(now,Math.min(...times))):null};
 }
 async settled(){await this.pending;}
 async close(){this.closed=true;this.abort?.abort();await this.pending;}
}
