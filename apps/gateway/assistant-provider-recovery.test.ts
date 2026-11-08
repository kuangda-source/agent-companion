import {test,expect} from "bun:test";
import {Database} from "bun:sqlite";
import {AssistantProviderRecovery,providerErrorCode} from "./src/assistant-provider-recovery.ts";

test("transient provider failures use persistent capped backoff; success resets it",()=>{
 const db=new Database(":memory:");db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT)");let now=Date.now();
 try{
  let recovery=new AssistantProviderRecovery(db,()=>now);
  for(const delay of [5,10,20,40,60,60]){
   recovery.failed("provider_http_503");expect(recovery.ready()).toBe(false);
   expect(Date.parse(recovery.current().next_retry_at!)-now).toBe(delay*60000);
   recovery=new AssistantProviderRecovery(db,()=>now);expect(recovery.ready()).toBe(false);
   now+=delay*60000;expect(recovery.ready()).toBe(true);
  }
  recovery.failed("assistant_cancelled");expect(recovery.current().consecutive_failures).toBe(6);
  recovery.failed("invalid_source_reference");expect(recovery.current().consecutive_failures).toBe(6);
  recovery.reset();expect(recovery.pending()).toBe(false);expect(recovery.current().next_retry_at).toBeNull();
  expect(new AssistantProviderRecovery(db,()=>now).pending()).toBe(false);
 }finally{db.close();}
});

test("provider diagnosis is bounded and returns safe codes without arbitrary upstream text",async()=>{
 expect(await providerErrorCode(Response.json({error:{message:"No available accounts: fixture-private-account"}},{status:503}))).toBe("provider_no_accounts");
 expect(await providerErrorCode(Response.json({error:{message:"unrelated upstream failure"}},{status:503}))).toBe("provider_http_503");
 expect(await providerErrorCode(Response.json({error:{message:"No available accounts"}},{status:401}))).toBe("provider_http_401");
 expect(await providerErrorCode(new Response("No available accounts"+"x".repeat(20000),{status:503}))).toBe("provider_http_503");
 expect(await providerErrorCode(new Response('not-json',{status:503}))).toBe("provider_http_503");
});
