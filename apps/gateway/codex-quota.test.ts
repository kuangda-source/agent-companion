import {test,expect} from "bun:test";
import {CodexQuotaMonitor,lowQuota,QUOTA_TIMING} from "./src/codex-quota.ts";
import {parseCodexRateLimits,quotaRpc} from "./src/codex-quota-rpc.ts";
import {mkdtempSync,rmSync,readFileSync,statSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {QuotaWindow} from "../../packages/protocol/src/index.ts";
const epoch=Date.parse("2026-11-01T00:00:00Z");
function quota(used:number,now:number,reset=now+7*86400_000):QuotaWindow[]{return [{window_minutes:10080,used_ratio:{value:used/100,quality:"confirmed",source:"codex.account/rateLimits/read",observed_at:new Date(now).toISOString()},resets_at:new Date(reset).toISOString(),health:"fresh"}];}
function fixture(used=81,file?:string){
 let now=epoch,value=used,calls=0,fail=false,reset=epoch+7*86400_000;
 const monitor=new CodexQuotaMonitor(async()=>{calls++;if(fail)throw new Error("provider response must not leak");return quota(value,now,reset);},file,()=>now);
 return {monitor,now:()=>now,advance:(n:number)=>{now+=n;},set:(n:number)=>{value=n;},calls:()=>calls,fail:(v:boolean)=>{fail=v;},reset:(n:number)=>{reset=n;}};
}
test("idle below 20 percent checks hourly and stops when the read restores at least 20 percent",async()=>{
 const f=fixture(81);f.monitor.observe(false,[]);await f.monitor.settled();expect(f.calls()).toBe(1);
 f.advance(QUOTA_TIMING.idle_low_ms-1);f.monitor.tick();await f.monitor.settled();expect(f.calls()).toBe(1);
 f.advance(1);f.set(80);f.monitor.tick();await f.monitor.settled();expect(f.calls()).toBe(2);expect(f.monitor.status().idle_low_balance).toBe(false);
 f.advance(QUOTA_TIMING.idle_low_ms);f.monitor.tick();await f.monitor.settled();expect(f.calls()).toBe(2);await f.monitor.close();
});
test("the strict 20 percent boundary avoids floating point subtraction errors and respects the tightest window",()=>{
 expect(lowQuota(quota(80,epoch))).toBe(false);expect(lowQuota(quota(80.01,epoch))).toBe(true);expect(lowQuota(quota(100,epoch))).toBe(true);
 expect(lowQuota([...quota(20,epoch),...quota(81,epoch)])).toBe(true);
});
test("active reads are per minute, local observations update immediately, and stopping confirms once",async()=>{
 const f=fixture(30);f.monitor.observe(true,[]);await f.monitor.settled();expect(f.calls()).toBe(1);
 f.advance(2000);f.monitor.observe(true,quota(40,f.now()));expect(f.monitor.current()[0].used_ratio.value).toBe(.4);expect(f.calls()).toBe(1);
 f.advance(58000);f.monitor.tick();await f.monitor.settled();expect(f.calls()).toBe(2);
 f.monitor.observe(false,[]);f.advance(10000);f.monitor.tick();await f.monitor.settled();expect(f.calls()).toBe(3);expect(f.monitor.status().last_reason).toBe("stopped");
 f.advance(3600_000);f.monitor.tick();await f.monitor.settled();expect(f.calls()).toBe(3);await f.monitor.close();
});
test("wake reads once, coalesces duplicate wake events, and idle high balance does not poll",async()=>{
 const f=fixture(50);f.monitor.observe(false,[]);await f.monitor.settled();f.advance(3600_000);f.monitor.tick();await f.monitor.settled();expect(f.calls()).toBe(1);
 f.monitor.trigger("wake");f.monitor.trigger("wake");await f.monitor.settled();expect(f.calls()).toBe(2);expect(f.monitor.status().last_reason).toBe("wake");
 f.advance(12000);f.monitor.tick();await f.monitor.settled();expect(f.calls()).toBe(2);await f.monitor.close();
});
test("an early reset at idle is detected before exhaustion and stops the hourly fallback",async()=>{
 const f=fixture(86);f.monitor.observe(false,[]);await f.monitor.settled();f.advance(3600_000);f.set(5);f.reset(f.now()+7*86400_000);f.monitor.tick();await f.monitor.settled();
 expect(f.monitor.current()[0].used_ratio.value).toBe(.05);expect(f.monitor.status().last_reason).toBe("idle_low");f.advance(3600_000);f.monitor.tick();await f.monitor.settled();expect(f.calls()).toBe(2);await f.monitor.close();
});
test("the reset deadline triggers a read without inventing a full allowance or repeating a failed query",async()=>{
 const f=fixture(50);f.reset(epoch+120000);f.monitor.observe(false,[]);await f.monitor.settled();f.fail(true);f.advance(120000);f.monitor.tick();await f.monitor.settled();
 expect(f.calls()).toBe(2);expect(f.monitor.current()[0].used_ratio.value).toBe(.5);expect(f.monitor.current()[0].health).toBe("stale");expect(f.monitor.status().last_error).toBe("codex_quota_read_failed");
 f.advance(120000);f.monitor.tick();await f.monitor.settled();expect(f.calls()).toBe(2);await f.monitor.close();
});
test("persistent last-known cache stays private and is restored without a 15 minute invalidation",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"ac-quota-cache-")),file=join(dir,"quota.json");
 try{const f=fixture(81,file);f.monitor.observe(false,[]);await f.monitor.settled();expect(statSync(file).mode&0o777).toBe(0o600);await f.monitor.close();
  const restored=new CodexQuotaMonitor(undefined,file,()=>epoch+3600_000);expect(restored.current()[0].used_ratio.value).toBe(.81);expect(restored.current()[0].health).toBe("fresh");await restored.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("an old-period log cannot undo an account-confirmed early reset",async()=>{
 const f=fixture(5);f.monitor.observe(false,[]);await f.monitor.settled();f.advance(2000);f.monitor.observe(false,quota(86,f.now(),epoch+5*86400_000));
 expect(f.monitor.current()[0].used_ratio.value).toBe(.05);
 for(let i=0;i<120;i++){f.advance(60_000);f.monitor.observe(false,quota(86,f.now(),epoch+5*86400_000));await f.monitor.settled();}
 expect(f.calls()).toBe(1);expect(f.monitor.status().idle_low_balance).toBe(false);await f.monitor.close();
});
test("quota RPC calls only initialization and quota read and reaps its child",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"ac-quota-rpc-")),file=join(dir,"receipt.json");
 try{const result=await quotaRpc([process.execPath,join(import.meta.dir,"../../tests/fixtures/quota-rpc.ts"),file],new AbortController().signal);
  expect(parseCodexRateLimits(result,new Date(epoch).toISOString())[0].used_ratio.value).toBe(.81);
  const receipt=JSON.parse(readFileSync(file,"utf8")) as {pid:number;methods:string[]};expect(receipt.methods).toEqual(["initialize","initialized","account/rateLimits/read"]);expect(()=>process.kill(receipt.pid,0)).toThrow();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("quota RPC timeout and cancellation terminate the owned process",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"ac-quota-timeout-")),file=join(dir,"receipt.json"),command=[process.execPath,join(import.meta.dir,"../../tests/fixtures/quota-rpc.ts"),file,"hang"];
 try{await expect(quotaRpc(command,new AbortController().signal,100)).rejects.toThrow("codex_quota_timeout");
  const control=new AbortController();const pending=quotaRpc(command,control.signal);setTimeout(()=>control.abort(),100);await expect(pending).rejects.toThrow("codex_quota_cancelled");
  const receipt=JSON.parse(readFileSync(file,"utf8")) as {pid:number};expect(()=>process.kill(receipt.pid,0)).toThrow();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("rate-limit parser rejects wrong buckets and malformed windows without returning account metadata",()=>{
 expect(()=>parseCodexRateLimits({rateLimits:{limitId:"other",primary:{usedPercent:10,windowDurationMins:300}}},new Date(epoch).toISOString())).toThrow();
 expect(()=>parseCodexRateLimits({rateLimits:{limitId:"codex",primary:{usedPercent:101,windowDurationMins:300}}},new Date(epoch).toISOString())).toThrow();
 const result=parseCodexRateLimits({rateLimitsByLimitId:{codex:{limitId:"codex",primary:{usedPercent:80,windowDurationMins:10080,resetsAt:1900000000}}},accountId:"not-exported",rateLimitResetCredits:{credits:[{id:"not-exported"}]}},new Date(epoch).toISOString());expect(JSON.stringify(result)).not.toContain("not-exported");
});

test("quota refresh routes retain local authentication, Origin and fixed-reason boundaries",async()=>{
 const {MockState}=await import("./src/scenarios.ts"),{createLiveGateway}=await import("./src/server.ts");
 const calls:string[]=[],collector=Object.assign(new MockState(),{quotaStatus:()=>({enabled:true}),triggerQuota:(reason:"wake"|"manual")=>calls.push(reason)});
 const gateway=createLiveGateway(collector,"quota-test-token",0);
 try{
  const url=new URL("api/v1/quotas/refresh",gateway.server.url),headers={"Content-Type":"application/json","Authorization":"Bearer quota-test-token"};
  expect((await fetch(url,{method:"POST",body:'{"reason":"wake"}'})).status).toBe(401);
  expect((await fetch(url,{method:"POST",headers:{...headers,Origin:"https://untrusted.example"},body:'{"reason":"wake"}'})).status).toBe(403);
  expect((await fetch(url,{method:"POST",headers,body:'{"reason":"account/logout"}'})).status).toBe(400);
  expect((await fetch(url,{method:"POST",headers,body:'{"reason":"wake","method":"turn/start"}'})).status).toBe(400);
  expect((await fetch(url,{method:"POST",headers,body:'{"reason":"wake"}'})).status).toBe(202);expect(calls).toEqual(["wake"]);
  expect(await(await fetch(new URL("api/v1/quotas/status",gateway.server.url),{headers})).json()).toEqual({enabled:true});
 }finally{gateway.close();}
});

test("a new running turn triggers confirmation even while another conversation is running",async()=>{
 const f=fixture(50);f.monitor.observe(true,[],["thread-a:turn-one"]);await f.monitor.settled();f.advance(10000);
 f.monitor.observe(true,[],["thread-a:turn-one","thread-b:turn-one"]);await f.monitor.settled();expect(f.calls()).toBe(2);expect(f.monitor.status().last_reason).toBe("started");
 f.advance(10000);f.monitor.observe(true,[],["thread-a:turn-two","thread-b:turn-one"]);await f.monitor.settled();expect(f.calls()).toBe(3);await f.monitor.close();
});
