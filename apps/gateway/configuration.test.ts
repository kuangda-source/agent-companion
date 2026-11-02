import {test,expect} from "bun:test";
import {mkdtempSync,readFileSync,statSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {CredentialStore} from "./src/credentials.ts";
import {createLiveGateway} from "./src/server.ts";
import {MockState} from "./src/scenarios.ts";
import {SettingsStore} from "./src/settings.ts";
import {RemoteLink} from "./src/remote-link.ts";
import {Assistant} from "./src/assistant.ts";
import {DeepSeekBalance} from "./src/balance.ts";
const patch=(url:string,value:unknown)=>new Request(url,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(value)});
test("credentials require local auth, reject web origins, never echo secrets, and clear safely",async()=>{
 const dir=mkdtempSync(tmpdir()+"/ac-config-"),store=new CredentialStore(dir),gateway=createLiveGateway(new MockState(),"local-fixture-token",0,10000,new SettingsStore(),undefined,undefined,undefined,store);
 try{
  const url=new URL("api/v1/credentials",gateway.server.url).toString(),key="fixture-credential-only";
  expect((await fetch(patch(url,{service:"assistant",key}))).status).toBe(401);
  const req=patch(url,{service:"assistant",key});req.headers.set("Authorization","Bearer local-fixture-token");req.headers.set("Origin","https://untrusted.example");expect((await fetch(req)).status).toBe(403);
  const permitted=patch(url,{service:"assistant",key});permitted.headers.set("Authorization","Bearer local-fixture-token");const response=await fetch(permitted);expect(response.status).toBe(200);expect(await response.json()).toEqual({assistant:true,deepseek:false});
  expect(readFileSync(dir+"/secrets/assistant-api-key","utf8")).toBe(key);expect(statSync(dir+"/secrets/assistant-api-key").mode&0o777).toBe(0o600);
  expect((await store.response(patch(url,{service:"../escape",key}))).status).toBe(400);
  expect((await store.response(patch(url,{service:"deepseek",key:"bad"}))).status).toBe(400);
  expect(await (await store.response(patch(url,{service:"assistant",key:null}))).json()).toEqual({assistant:false,deepseek:false});
 }finally{gateway.close();rmSync(dir,{recursive:true,force:true});}
});
test("clean assistant starts disabled with empty provider fields and does not infer or call",async()=>{
 const dir=mkdtempSync(tmpdir()+"/ac-blank-"),assistant=new Assistant(new MockState(),dir,async()=>{throw new Error("unexpected_provider_call");});
 try{
  expect(assistant.configuration()).toMatchObject({enabled:false,base_url:"",model:"",has_key:false});
  expect(()=>assistant.updateConfig({enabled:true})).toThrow("invalid_assistant_config");
  assistant.updateConfig({base_url:"https://api.example.org/v1",model:"user-selected-model",enabled:true,auto_refresh:false});
  expect(assistant.current().status).toBe("unconfigured");
 }finally{await assistant.shutdown();rmSync(dir,{recursive:true,force:true});}
});
test("relay edits keep secrets private and require new credentials before changing host",async()=>{
 const dir=mkdtempSync(tmpdir()+"/ac-relay-config-"),remote=new RemoteLink(dir,new MockState(),new SettingsStore(),undefined,{tickMs:60000});
 try{
  const url="http://127.0.0.1/api/v1/connection/relay",config={enabled:false,url:"wss://relay.example.org/v1/link",mac_token:"a".repeat(64),device_token:"b".repeat(64)};
  expect((await remote.response(patch(url,config))).status).toBe(200);
  const response=await remote.response(new Request(url));expect(await response.json()).toEqual({enabled:false,url:config.url,has_mac_token:true,has_device_token:true});
  expect(statSync(dir+"/remote-link.json").mode&0o777).toBe(0o600);
  expect((await remote.response(patch(url,{enabled:false,url:"wss://different.example.org/v1/link"}))).status).toBe(400);
  expect(JSON.parse(readFileSync(dir+"/remote-link.json","utf8")).url).toBe(config.url);
  expect((await remote.response(patch(url,{enabled:false,url:config.url,mac_token:"",device_token:""}))).status).toBe(200);
  await remote.response(new Request(url,{method:"DELETE"}));expect(remote.configuration().has_mac_token).toBe(false);
  // A fresh local-only installation can provision Wi-Fi without any relay.
  writeFileSync(dir+"/board-bridge.status.json",JSON.stringify({updated_at:new Date().toISOString(),port:"test",mode:"network_only"}));
  expect((await remote.response(new Request("http://localhost/api/v1/connection/wifi",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ssid:"Example-WiFi",password:"example-password"})}))).status).toBe(202);
  expect(JSON.parse(readFileSync(dir+"/wifi-pending.json","utf8")).relay_url).toBe("");
 }finally{remote.close();rmSync(dir,{recursive:true,force:true});}
});
test("removing a balance key discards a pending response from the old account",async()=>{
 const dir=mkdtempSync(tmpdir()+"/ac-balance-reset-"),file=dir+"/key";writeFileSync(file,"sk-"+"x".repeat(32),{mode:0o600});
 let release:(r:Response)=>void=()=>{};const pending=new Promise<Response>(resolve=>{release=resolve;});
 const balance=new DeepSeekBalance(file,()=>pending);
 try{
  const reading=balance.refresh();await Bun.sleep(30);balance.reset();rmSync(file);
  release(Response.json({is_available:true,balance_infos:[{currency:"CNY",total_balance:"99",granted_balance:"0",topped_up_balance:"99"}]}));await reading;
  expect(balance.current().wallets).toHaveLength(0);expect(balance.current().observed_at).toBeNull();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
