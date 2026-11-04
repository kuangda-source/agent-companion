import { test, expect } from "bun:test";
import { createRelay, digest } from "../relay/server.ts";
import { RemoteLink, wifiInput, validateRemote, clipDeviceText } from "./src/remote-link.ts";
const mac="a".repeat(64),device="b".repeat(64);
function opened(url:string,token:string){return new Promise<WebSocket>((resolve,reject)=>{const ws=new WebSocket(url,{headers:{Authorization:"Bearer "+token}});ws.onopen=()=>resolve(ws);ws.onerror=()=>reject(new Error("connection failed"));});}
function message(ws:WebSocket,accept:(v:Record<string,unknown>)=>boolean=()=>true){return new Promise<Record<string,unknown>>((resolve,reject)=>{const t=setTimeout(()=>reject(new Error("message timeout")),2000);ws.onmessage=e=>{const v=JSON.parse(String(e.data)) as Record<string,unknown>;if(accept(v)){clearTimeout(t);resolve(v);}};});}
test("WiFi and relay credentials are bounded and kept distinct",()=>{
 expect(wifiInput({ssid:"测试热点",password:"password123"}).ssid).toBe("测试热点");
 for(const v of [{ssid:"a".repeat(33),password:"12345678"},{ssid:"ok",password:"short"},{ssid:"ok",password:"12345678",mac_token:mac},{ssid:"x\ny",password:"12345678"}])expect(()=>wifiInput(v)).toThrow();
 expect(()=>validateRemote({enabled:true,url:"ws://x/v1/link",mac_token:mac,device_token:device})).toThrow();
 expect(()=>validateRemote({enabled:true,url:"wss://x/v1/link?token=x",mac_token:mac,device_token:device})).toThrow();
 expect(()=>validateRemote({enabled:true,url:"wss://x/v1/link",mac_token:mac,device_token:mac})).toThrow();
 expect(Buffer.byteLength(clipDeviceText("测".repeat(3000)))).toBeLessThan(4096);
});
test("relay authenticates roles, forwards bounded views/gestures, rejects forbidden commands",async()=>{
 const r=createRelay({mac_sha256:digest(mac),device_sha256:digest(device)},0);const base=r.server.url.toString().replace(/\/$/,""),url=base.replace("http:","ws:")+"/v1/link";
 let a:WebSocket|undefined,b:WebSocket|undefined;
 try{
  expect((await fetch(base+"/v1/status")).status).toBe(401);
  expect((await fetch(base+"/v1/status",{headers:{Authorization:"Bearer "+device}})).status).toBe(404);
  a=await opened(url,mac);const ap=message(a,p=>p.device_connected===true);b=await opened(url,device);expect((await ap).device_connected).toBe(true);
  const get=message(b,p=>p.state!==undefined);a.send(JSON.stringify({id:1,gateway_boot_id:crypto.randomUUID(),sent_at:Date.now()/1000,state:{data_source:"live"}}));expect((await get).id).toBe(1);
  const reply=message(a,p=>p.kind==="theme");b.send(JSON.stringify({kind:"theme",value:"comic"}));expect((await reply).value).toBe("comic");
  const health=message(a,p=>p.kind==="disconnected");b.send(JSON.stringify({kind:"disconnected"}));expect((await health).kind).toBe("disconnected");expect(b.readyState).toBe(WebSocket.OPEN);
  const dropped=message(a,p=>p.kind==="snapshot_rejected");b.send(JSON.stringify({kind:"snapshot_rejected"}));expect((await dropped).kind).toBe("snapshot_rejected");expect(b.readyState).toBe(WebSocket.OPEN);
  const closed=new Promise<number>(resolve=>{b!.onclose=e=>resolve(e.code);});b.send(JSON.stringify({kind:"execute",command:"anything"}));expect(await closed).toBe(1008);
 }finally{a?.close();b?.close();r.close();}
});

test("application heartbeat reports the pair and expires a silent socket without stealing its new replacement",async()=>{
 let now=Date.now();const r=createRelay({mac_sha256:digest(mac),device_sha256:digest(device)},0,{now:()=>now});const base=r.server.url.toString().replace(/\/$/,""),url=base.replace("http:","ws:")+"/v1/link";let a:WebSocket|undefined,b:WebSocket|undefined,c:WebSocket|undefined;
 try{
  a=await opened(url,mac);b=await opened(url,device);
  now+=15000;const alive=message(a,p=>p.kind==="heartbeat");a.send(JSON.stringify({kind:"heartbeat",id:1}));expect((await alive).device_connected).toBe(true);
  now+=6000;const status=await (await fetch(base+"/v1/status",{headers:{Authorization:"Bearer "+mac}})).json() as Record<string,unknown>;expect(status.mac_connected).toBe(true);expect(status.device_connected).toBe(false);
  c=await opened(url,device);const pong=message(c,p=>p.kind==="heartbeat");c.send(JSON.stringify({kind:"heartbeat",id:2}));const answer=await pong;expect(answer.id).toBe(2);expect(answer.mac_connected).toBe(true);
 }finally{a?.close();b?.close();c?.close();r.close();}
});

test("USB-priority keeps relay available, reconnects a silent OPEN socket and requires a device apply receipt",async()=>{
 const {mkdtempSync,writeFileSync,rmSync}=await import("node:fs");const {tmpdir}=await import("node:os");const {SettingsStore}=await import("./src/settings.ts");const {MockState}=await import("./src/scenarios.ts");
 const dir=mkdtempSync(tmpdir()+"/ac-link-test-");writeFileSync(dir+"/remote-link.json",JSON.stringify({enabled:true,url:"wss://test.invalid/v1/link",mac_token:mac,device_token:device}));
 let connections=0,probes=0,now=100000;
 const silent=Bun.serve({hostname:"127.0.0.1",port:0,fetch(req,server){if(server.upgrade(req))return;return new Response("upgrade",{status:426});},websocket:{open(){connections++;},message(_ws,raw){if(JSON.parse(String(raw)).kind==="heartbeat")probes++;}}});
 const settings=new SettingsStore();expect(settings.current().device.transport).toBe('usb');
 const link=new RemoteLink(dir,new MockState(false,0),settings,undefined,{clock:()=>now,tickMs:5,socket:(_url,headers)=>new WebSocket(silent.url.toString().replace("http:","ws:"),{headers})});
 try{
  for(let i=0;i<100&&!link.status().relay_connected;i++)await Bun.sleep(5);
  expect(link.status().relay_connected).toBe(true);expect(link.status().data_fresh).toBe(false);expect(probes).toBeGreaterThanOrEqual(1);
  now+=21000;for(let i=0;i<100&&link.status().relay_connected;i++)await Bun.sleep(5);
  expect(link.status().error).toBe("relay_response_timeout");expect(link.status().relay_connected).toBe(false);
  now+=2000;for(let i=0;i<100&&connections<2;i++)await Bun.sleep(5);expect(connections).toBeGreaterThanOrEqual(2);expect(link.status().data_fresh).toBe(false);
 }finally{link.close();silent.stop(true);rmSync(dir,{recursive:true,force:true});}
});

test("relay sends periodic presence without extending a silent client's lease",async()=>{
 let now=100000;const r=createRelay({mac_sha256:digest(mac),device_sha256:digest(device)},0,{now:()=>now});const base=r.server.url.toString().replace(/\/$/,""),url=base.replace("http:","ws:")+"/v1/link";let ws:WebSocket|undefined;
 try{
  ws=new WebSocket(url,{headers:{Authorization:"Bearer "+device}});await message(ws,p=>p.kind==="peer");
  const next=message(ws,p=>p.kind==="peer");now+=6000;const presence=await next;expect(presence.device_connected).toBe(true);expect(presence.mac_connected).toBe(false);
  now+=15000;const state=await(await fetch(base+"/v1/status",{headers:{Authorization:"Bearer "+mac}})).json() as Record<string,unknown>;expect(state.device_connected).toBe(false);
 }finally{ws?.close();r.close();}
});
