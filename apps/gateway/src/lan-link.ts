/** One paired screen over local TLS; management API stays on loopback. */
import {networkInterfaces,hostname} from "node:os";
import {join} from "node:path";
import {existsSync,mkdirSync,writeFileSync,readFileSync,chmodSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {timingSafeEqual,createHash} from "node:crypto";
import type {ServerWebSocket} from "bun";
import type {Collector} from "./state.ts";
import type {SettingsStore} from "./settings.ts";
import type {Assistant} from "./assistant.ts";
import {DeviceSession} from "./device-session.ts";
export const LAN_PORT=8737;
export function localHost(value:string){
 if(/^[a-z0-9](?:[a-z0-9.-]{0,98})\.local$/i.test(value))return true;
 const a=value.split('.').map(Number);return a.length===4&&a.every((v,i)=>Number.isInteger(v)&&v>=0&&v<=255&&String(v)===value.split('.')[i])&&(a[0]===10||a[0]===127||a[0]===192&&a[1]===168||a[0]===172&&a[1]>=16&&a[1]<=31||a[0]===169&&a[1]===254);
}
export function lanAddresses(){
 return Object.entries(networkInterfaces()).flatMap(([name,rows])=>/^(en\d+|bridge\d+)$/.test(name)?(rows??[]).filter(x=>x.family==='IPv4'&&!x.internal&&localHost(x.address)).map(x=>({interface:name,host:x.address})):[]);
}
interface Credentials{token:string;host:string}
interface Peer{seen:number;window:number;count:number}
export class LanLink {
 private server:ReturnType<typeof Bun.serve<Peer>>|null=null;
 private peer:ServerWebSocket<Peer>|null=null;
 private feed:DeviceSession;
 private credentials:Credentials;
 private directory:string;
 private timer:ReturnType<typeof setInterval>;
 private lastView=0;private lastPresence=0;private lastAck:number|null=null;private ackId=0;private error:string|null=null;
 private signature='';private closed=false;private nextStart=0;
 constructor(private runtime:string,collector:Collector,private settings:SettingsStore,assistant?:Assistant,private port=LAN_PORT){
  this.directory=join(runtime,'lan');mkdirSync(this.directory,{recursive:true,mode:0o700});chmodSync(this.directory,0o700);
  const path=join(this.directory,'pair.json'),hosts=lanAddresses();
  this.credentials=existsSync(path)?JSON.parse(readFileSync(path,'utf8')) as Credentials:{token:Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'),host:hosts[0]?.host??'127.0.0.1'};
  if(!/^[a-f0-9]{64}$/.test(this.credentials.token)||!localHost(this.credentials.host))throw new Error('invalid_lan_pair');this.save();
  this.feed=new DeviceSession(collector,settings,assistant);this.timer=setInterval(()=>this.tick(),1000);this.tick();
 }
 private save(){const p=join(this.directory,'pair.json');writeFileSync(p,JSON.stringify(this.credentials),{mode:0o600});chmodSync(p,0o600);}
 private openssl(args:string[]){const r=spawnSync('/usr/bin/openssl',args,{stdio:'pipe',timeout:10000});if(r.status!==0)throw new Error('lan_certificate_failed');}
 private certificate(hosts:string[]){
  const d=this.directory,ca=join(d,'ca.pem'),key=join(d,'ca-key.pem'),leaf=join(d,'server-key.pem');
  if(!existsSync(ca)){
   this.openssl(['ecparam','-name','prime256v1','-genkey','-noout','-out',key]);chmodSync(key,0o600);
   const cfg=join(d,'ca.cnf');writeFileSync(cfg,'[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=Agent Companion Local Pair\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n',{mode:0o600});
   this.openssl(['req','-new','-x509','-sha256','-days','3650','-key',key,'-out',ca,'-config',cfg]);chmodSync(ca,0o600);
  }
  if(!existsSync(leaf)){this.openssl(['ecparam','-name','prime256v1','-genkey','-noout','-out',leaf]);chmodSync(leaf,0o600);}
  const ext=join(d,'server.cnf');writeFileSync(ext,'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName='+hosts.map(h=>(/^\d+\./.test(h)?'IP:':'DNS:')+h).join(',')+'\n',{mode:0o600});
  const csr=join(d,'server.csr'),cert=join(d,'server.pem');this.openssl(['req','-new','-key',leaf,'-out',csr,'-subj','/CN=Agent Companion Screen']);
  this.openssl(['x509','-req','-in',csr,'-CA',ca,'-CAkey',key,'-set_serial','0x'+Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex'),'-days','365','-sha256','-extfile',ext,'-out',cert]);
  for(const p of [csr,cert])chmodSync(p,0o600);
  return {key:Bun.file(leaf),cert:readFileSync(cert,'utf8')+readFileSync(ca,'utf8')};
 }
 private tick(){
  if(this.closed)return;
  const enabled=['auto','wifi'].includes(this.settings.current().device.transport);
  if(!enabled){this.stopServer();return;}
  const host=hostname().replace(/\.local$/i,'')+'.local',hosts=[...new Set(['127.0.0.1',...(localHost(host)?[host]:[]),this.credentials.host,...lanAddresses().map(x=>x.host)])].sort();const signature=hosts.join(',');
  if(!this.server&&performance.now()<this.nextStart)return;
  if(!this.server||signature!==this.signature){
   try{this.stopServer();const tls=this.certificate(hosts);this.signature=signature;this.start(tls);this.error=null;}catch{this.error='lan_start_failed';this.nextStart=performance.now()+5000;return;}
  }
  const now=performance.now();if(this.peer&&now-this.peer.data.seen>=20000){const p=this.peer;this.peer=null;this.lastAck=null;p.close(4000,'heartbeat timeout');}
  if(this.peer&&now-this.lastPresence>=5000){this.lastPresence=now;this.peer.send(JSON.stringify({kind:'peer',mac_connected:true,device_connected:true}));}
  if(this.peer&&now-this.lastView>=2000){this.lastView=now;this.sendView();}
 }
 private start(tls:{key:Bun.BunFile;cert:string}){
  const expected=Buffer.from('Bearer '+this.credentials.token);
  this.server=Bun.serve<Peer>({hostname:'0.0.0.0',port:this.port,tls,
   fetch:(req,server)=>{
    const u=new URL(req.url),address=server.requestIP(req)?.address??'';const actual=Buffer.from(req.headers.get('authorization')??'');
    if(!localHost(address.replace(/^::ffff:/,''))||actual.length!==expected.length||!timingSafeEqual(actual,expected))return new Response('Unauthorized',{status:401});
    if(req.headers.get('origin')||u.search||u.pathname!=='/v1/device'||req.method!=='GET')return new Response('Not found',{status:404});
    if(this.peer)return new Response('Screen already connected',{status:409});
    if(server.upgrade(req,{data:{seen:performance.now(),window:performance.now(),count:0}}))return;return new Response('WebSocket required',{status:426});
   },
   websocket:{maxPayloadLength:4096,idleTimeout:45,sendPings:true,backpressureLimit:384*1024,closeOnBackpressureLimit:true,
    open:ws=>{if(this.peer){ws.close(1008,'occupied');return;}this.peer=ws;this.lastAck=null;ws.send(JSON.stringify({kind:'peer',mac_connected:true,device_connected:true}));this.sendView();},
    message:(ws,raw)=>{
     if(this.peer!==ws)return;const now=performance.now();if(now-ws.data.window>1000){ws.data.window=now;ws.data.count=0;}if(++ws.data.count>8){ws.close(1008,'rate limit');return;}
     let p:Record<string,unknown>;try{const v:unknown=JSON.parse(String(raw));if(!v||typeof v!=='object'||Array.isArray(v))throw 0;p=v as Record<string,unknown>;}catch{ws.close(1007,'JSON required');return;}ws.data.seen=now;
     if(p.kind==='heartbeat'&&Number.isSafeInteger(p.id)&&Number(p.id)>=0){ws.send(JSON.stringify({kind:'heartbeat',id:p.id,mac_connected:true,device_connected:true}));return;}
     if(p.kind==='applied'){const id=this.feed.acknowledge(p);if(id!==null){this.lastAck=Date.now();this.ackId=id;}return;}
     if(['theme','detail','assistant_refresh'].includes(String(p.kind))){if(this.feed.command(p))this.sendView();return;}
     if(['disconnected','snapshot_rejected','frame_timeout','frame_crc_error','frame_json_error','provision_rejected'].includes(String(p.kind)))return;
     ws.close(1008,'unsupported packet');
    },close:ws=>{if(this.peer===ws){this.peer=null;this.lastAck=null;}}
   }
  });
 }
 public pushView(){this.sendView();}
 private sendView(){const v=this.feed.encode();if(this.feed.error)this.error=this.feed.error;if(this.peer&&v&&this.peer.getBufferedAmount()<192*1024){this.peer.send(v.text);this.feed.sent(v.id,v.display);}}
 status(){const port=this.server?.port??this.port;return {enabled:['auto','wifi'].includes(this.settings.current().device.transport),listening:!!this.server,url:`wss://${this.credentials.host}:${port}/v1/device`,endpoints:lanAddresses().map(x=>({...x,url:`wss://${x.host}:${port}/v1/device`})),device_connected:!!this.peer,data_fresh:!!this.peer&&this.lastAck!==null&&Date.now()-this.lastAck<8000,last_applied_at:this.lastAck?new Date(this.lastAck).toISOString():null,last_applied_id:this.ackId,error:this.error,last_command:this.feed.lastCommand,certificate_sha256:existsSync(join(this.directory,'ca.pem'))?createHash('sha256').update(readFileSync(join(this.directory,'ca.pem'))).digest('hex'):null};}
 async provision(req:Request,usbAvailable:boolean){
  try{
   if(!usbAvailable)throw new Error('usb_bridge_required');if(!req.headers.get('content-type')?.startsWith('application/json'))throw new Error('json_required');const raw=await req.text();if(raw.length>256)throw new Error('request_too_large');const body:unknown=JSON.parse(raw);if(!body||typeof body!=='object'||Array.isArray(body))throw new Error('invalid_request');const o=body as Record<string,unknown>;
   if(Object.keys(o).some(k=>k!=='host')||typeof o.host!=='string'||(!localHost(o.host)||o.host.startsWith('127.')))throw new Error('invalid_lan_host');
   this.credentials.host=o.host;this.save();this.tick();if(!this.server)throw new Error('enable_lan_first');
   const request_id=crypto.randomUUID(),p=join(this.runtime,'link-pending.json');writeFileSync(p,JSON.stringify({kind:'link_config',request_id,expires_at:Date.now()+120000,lan_url:`wss://${o.host}:${this.port}/v1/device`,lan_token:this.credentials.token,lan_ca:readFileSync(join(this.directory,'ca.pem'),'utf8')}),{mode:0o600});chmodSync(p,0o600);
   return Response.json({status:'queued',request_id},{status:202});
  }catch(e){return Response.json({error:e instanceof Error?e.message:'invalid_request'},{status:400});}
 }
 private stopServer(){this.peer=null;this.lastAck=null;this.server?.stop(true);this.server=null;}
 close(){this.closed=true;clearInterval(this.timer);this.stopServer();}
}
