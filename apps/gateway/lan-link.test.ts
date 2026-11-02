import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LanLink,localHost} from './src/lan-link.ts';
import {SettingsStore} from './src/settings.ts';
import {Assistant} from './src/assistant.ts';
import {MockState} from './src/scenarios.ts';
import type {Collector} from './src/state.ts';
function message(ws:WebSocket,predicate:(p:Record<string,unknown>)=>boolean){return new Promise<Record<string,unknown>>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('device message timeout')),4000);const handler=(e:MessageEvent)=>{const p=JSON.parse(String(e.data)) as Record<string,unknown>;if(predicate(p)){clearTimeout(timer);ws.removeEventListener('message',handler);resolve(p);}};ws.addEventListener('message',handler);});}
test('local WSS verifies CA/host, requires a separate screen token, hides management routes and requires applied ACK',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ac-lan-')),mock=new MockState(false,0),settings=new SettingsStore();settings.update({device:{transport:'wifi'}});
 const collector:Collector={current:()=>({...mock.current(),data_source:'live',generated_at:new Date().toISOString()}),refresh:async()=>({...mock.current(),data_source:'live',generated_at:new Date().toISOString()}),detail:id=>mock.detail(id)};
 const assistant=new Assistant(collector,dir);const lan=new LanLink(dir,collector,settings,assistant,0);let ws:WebSocket|undefined;
 try{
  const s=lan.status();expect(s.listening).toBe(true);const url=s.url.replace(new URL(s.url).hostname,'127.0.0.1'),ca=readFileSync(join(dir,'lan/ca.pem'),'utf8'),token=(JSON.parse(readFileSync(join(dir,'lan/pair.json'),'utf8')) as {token:string}).token;
  expect((await fetch(url.replace('wss:','https:'),{tls:{ca}})).status).toBe(401);
  expect((await fetch(url.replace('wss:','https:').replace('/v1/device','/api/v1/state'),{tls:{ca},headers:{Authorization:'Bearer '+token}})).status).toBe(404);
  let wrongHostFailed=false;try{await fetch(url.replace('wss:','https:').replace('127.0.0.1','localhost'),{tls:{ca}});}catch{wrongHostFailed=true;}expect(wrongHostFailed).toBe(true);
  ws=new WebSocket(url,{headers:{Authorization:'Bearer '+token},tls:{ca}});const view=await message(ws,p=>!!p.state);expect(lan.status().data_fresh).toBe(false);
  const pong=message(ws,p=>p.kind==='heartbeat');ws.send(JSON.stringify({kind:'heartbeat',id:1}));expect((await pong).mac_connected).toBe(true);expect(lan.status().data_fresh).toBe(false);
  ws.send(JSON.stringify({kind:'applied',id:view.id,gateway_boot_id:view.gateway_boot_id}));for(let i=0;i<100&&!lan.status().data_fresh;i++)await Bun.sleep(5);expect(lan.status().data_fresh).toBe(true);
  const ended=new Promise<number>(resolve=>{ws!.onclose=e=>resolve(e.code);});ws.send(JSON.stringify({kind:'execute',command:'forbidden'}));expect(await ended).toBe(1008);
  expect(localHost('8.8.8.8')).toBe(false);expect(localHost('host.local')).toBe(true);expect(localHost('host.local.evil.com')).toBe(false);
 }finally{ws?.close();lan.close();assistant.close();rmSync(dir,{recursive:true,force:true});}
});

test('LAN and relay share boot/order/selection while ACKs remain bound to the transport that sent a view',async()=>{
 const {DeviceSession}=await import('./src/device-session.ts');const dir=mkdtempSync(join(tmpdir(),'ac-wire-')),mock=new MockState(false,0),record=mock.current().sessions[0]!;
 const collector:Collector={current:()=>({...mock.current(),sessions:[],data_source:'live',generated_at:new Date().toISOString()}),refresh:async()=>({...mock.current(),data_source:'live',generated_at:new Date().toISOString()}),detail:id=>id===record.id?record:undefined};const assistant=new Assistant(collector,dir),settings=new SettingsStore();
 try{
  const a=new DeviceSession(collector,settings,assistant),b=new DeviceSession(collector,settings,assistant),first=a.encode()!,second=b.encode()!;a.sent(first.id);b.sent(second.id);expect(a.boot).toBe(b.boot);expect(second.id).toBeGreaterThan(first.id);
  const ack={gateway_boot_id:a.boot,id:first.id};expect(b.acknowledge(ack)).toBeNull();expect(a.acknowledge(ack)).toBe(first.id);
  a.command({kind:'detail',id:record.id});const view=JSON.parse(b.encode()!.text) as {detail?:{id:string}};expect(view.detail?.id).toBe(record.id);
  a.command({kind:'detail',id:'unobserved'});expect(JSON.parse(b.encode()!.text).detail).toBeUndefined();
 }finally{assistant.close();rmSync(dir,{recursive:true,force:true});}
});

test('busy assistant refresh cannot terminate the Gateway process or interrupt subsequent device traffic',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ac-busy-child-'));let ws:WebSocket|undefined;
 const child=Bun.spawn([process.execPath,join(import.meta.dir,'../../tests/fixtures/device-busy-harness.ts'),dir],{stdout:'pipe',stderr:'pipe'});
 try{
  const readyPath=join(dir,'ready.json');for(let i=0;i<300&&!await Bun.file(readyPath).exists();i++){if(child.exitCode!==null)throw new Error('test Gateway exited before ready');await Bun.sleep(10);}
  const ready=JSON.parse(readFileSync(readyPath,'utf8')) as {lan:string;health:string},ca=readFileSync(join(dir,'lan/ca.pem'),'utf8'),token=(JSON.parse(readFileSync(join(dir,'lan/pair.json'),'utf8')) as {token:string}).token;
  ws=new WebSocket(ready.lan,{headers:{Authorization:'Bearer '+token},tls:{ca}});let view=await message(ws,p=>!!p.state);const first=Number(view.id);
  ws.send(JSON.stringify({kind:'applied',id:view.id,gateway_boot_id:view.gateway_boot_id}));
  for(let i=0;i<5;i++)ws.send(JSON.stringify({kind:'assistant_refresh'}));
  for(let i=0;i<100;i++){const state=await (await fetch(ready.health)).json() as {refreshCalls:number;lan:{last_command:{status:string;code:string}}};if(state.refreshCalls===5){expect(state.lan.last_command).toMatchObject({status:'busy',code:'assistant_busy'});break;}await Bun.sleep(5);}
  // Busy commands do not emit five redundant views/ACKs and trip the device's rate limit.
  view=await message(ws,p=>!!p.state&&Number(p.id)>first);
  expect(Number(view.id)).toBeGreaterThan(first);expect(child.exitCode).toBeNull();
  ws.send(JSON.stringify({kind:'applied',id:view.id,gateway_boot_id:view.gateway_boot_id}));
  const pong=message(ws,p=>p.kind==='heartbeat');ws.send(JSON.stringify({kind:'heartbeat',id:1}));expect((await pong).mac_connected).toBe(true);
  const themed=message(ws,p=>!!p.state);ws.send(JSON.stringify({kind:'theme',value:'comic'}));await themed;
  const result=await (await fetch(ready.health)).json() as {alive:boolean;refreshCalls:number;theme:string;lan:{data_fresh:boolean;last_command:{status:string}}};
  expect(result).toMatchObject({alive:true,refreshCalls:5,theme:'comic',lan:{data_fresh:true}});expect(child.exitCode).toBeNull();
 }finally{ws?.close();child.kill('SIGTERM');await child.exited;rmSync(dir,{recursive:true,force:true});}
});
