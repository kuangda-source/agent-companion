/** Outbound one-Mac/one-screen link. Agent and model credentials never leave Gateway. */
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { Collector } from "./state.ts";
import type { SettingsStore } from "./settings.ts";
import type { Assistant } from "./assistant.ts";
export interface RemoteCredentials { enabled: boolean; url: string; mac_token: string; device_token: string }
export function validateRemote(c: RemoteCredentials) {
  const u = new URL(c.url);
  if (c.url.length>=160 || !/^wss:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?\/v1\/link$/.test(c.url) || u.protocol !== "wss:" || u.username || u.password || u.search || u.hash || u.pathname !== "/v1/link" || (u.port!==""&&Number(u.port)<1) || typeof c.enabled !== "boolean") throw new Error("invalid_relay_config");
  for (const token of [c.mac_token,c.device_token]) if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("invalid_role_credential");
  if(c.mac_token===c.device_token)throw new Error("distinct_role_credentials_required");
  return c;
}
export function wifiInput(v: unknown) {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("invalid_wifi");
  const o=v as Record<string,unknown>;
  if(Object.keys(o).some(k=>!["ssid","password"].includes(k)))throw new Error("unknown_field");
  if(typeof o.ssid!=="string"||Buffer.byteLength(o.ssid)<1||Buffer.byteLength(o.ssid)>32||/[\0\r\n]/.test(o.ssid))throw new Error("invalid_ssid");
  if(typeof o.password!=="string"||!((Buffer.byteLength(o.password)>=8&&Buffer.byteLength(o.password)<=63)||/^[a-f0-9]{64}$/i.test(o.password))||/[\0\r\n]/.test(o.password))throw new Error("invalid_password");
  return {ssid:o.ssid,password:o.password};
}
export {clipDeviceText} from "./device-session.ts";
import {DeviceSession} from "./device-session.ts";
interface RemoteLinkOptions { clock?:()=>number; socket?:(url:string,headers:{Authorization:string})=>WebSocket; tickMs?:number }
export class RemoteLink {
  private socket:WebSocket|null=null;
  private stopped=false;
  private connecting=false;
  private feed:DeviceSession;
  private nextConnect=0;
  private failures=0;
  private activeConfig="";
  private timer:ReturnType<typeof setInterval>;
  private lastInbound=0;
  private lastProbe=0;
  private probeId=0;
  private clock:()=>number;
  private statusValue={relay_url:null as string|null,configured:false,relay_connected:false,device_connected:false,last_applied_at:null as string|null,last_applied_id:0,last_source_seq:0,error:null as string|null};
  constructor(private runtime:string,private collector:Collector,private settings:SettingsStore,private assistant?:Assistant,private options:RemoteLinkOptions={}) {
    this.feed=new DeviceSession(collector,settings,assistant);this.clock=options.clock??(()=>performance.now());this.timer=setInterval(()=>this.tick(),options.tickMs??2000);this.tick();
  }
  private config(){const f=this.runtime+"/remote-link.json";return existsSync(f)?validateRemote(JSON.parse(readFileSync(f,"utf8")) as RemoteCredentials):null;}
  configuration(){const c=this.config();return {enabled:c?.enabled??false,url:c?.url??"",has_mac_token:!!c?.mac_token,has_device_token:!!c?.device_token};}
  private updateConfiguration(value:unknown){
    if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("invalid_relay_config");
    const v=value as Record<string,unknown>;
    if(Object.keys(v).some(k=>!["enabled","url","mac_token","device_token"].includes(k))||typeof v.url!=="string"||typeof v.enabled!=="boolean")throw new Error("invalid_relay_config");
    const old=this.config(),same=old?.url===v.url;
    const next=validateRemote({enabled:v.enabled,url:v.url,mac_token:typeof v.mac_token==="string"&&v.mac_token?v.mac_token:same?old!.mac_token:"",device_token:typeof v.device_token==="string"&&v.device_token?v.device_token:same?old!.device_token:""});
    const file=this.runtime+"/remote-link.json";writeFileSync(file+".tmp",JSON.stringify(next),{mode:0o600});chmodSync(file+".tmp",0o600);renameSync(file+".tmp",file);
    this.tick();return this.configuration();
  }
  status(){
    let usb:Record<string,unknown>|null=null;
    try {
      const s=JSON.parse(readFileSync(this.runtime+"/board-bridge.status.json","utf8")) as Record<string,unknown>;
      const age=Date.now()-Date.parse(String(s.updated_at)),ackAge=Date.now()-Date.parse(String(s.last_ack_utc));
      if(age>=-2000&&age<8000&&s.usb_connected!==false&&typeof s.port==='string')usb={port:s.port,mode:s.mode,provision:s.provision??null,network:s.network??null,link_config:s.link_config??null,display:s.display??null,last_ack_utc:s.last_ack_utc,last_ack:s.last_ack,error:s.error??null,data_fresh:s.mode==='usb_viewer'&&ackAge>=-2000&&ackAge<8000};
    }catch{}
    return {...this.statusValue,last_command:this.feed.lastCommand,data_fresh:this.statusValue.relay_connected&&this.statusValue.device_connected&&!!this.statusValue.last_applied_at&&Date.now()-Date.parse(this.statusValue.last_applied_at)<8000,device_connected:this.statusValue.device_connected&&this.statusValue.relay_connected,usb,provision_pending:existsSync(this.runtime+"/wifi-pending.json"),link_pending:existsSync(this.runtime+"/link-pending.json"),settings_applied:false};
  }
  async response(req:Request){
    const path=new URL(req.url).pathname,headers={"Cache-Control":"no-store"};
    if(path==="/api/v1/connection/relay"){
      try{
        if(req.method==="GET")return Response.json(this.configuration(),{headers});
        if(req.method==="DELETE"){rmSync(this.runtime+"/remote-link.json",{force:true});this.tick();return Response.json(this.configuration(),{headers});}
        if(req.method!=="PATCH")return Response.json({error:"method_not_allowed"},{status:405,headers});
        if(!req.headers.get("content-type")?.startsWith("application/json"))throw new Error("json_required");
        const raw=await req.text();if(raw.length>2048)throw new Error("invalid_relay_config");
        return Response.json(this.updateConfiguration(JSON.parse(raw)),{headers});
      }catch{return Response.json({error:"invalid_relay_config"},{status:400,headers});}
    }
    if(req.method==="GET"&&path==="/api/v1/connection")return Response.json(this.status(),{headers});
    if(req.method!=="POST"||path!=="/api/v1/connection/wifi")return Response.json({error:"not_found"},{status:404,headers});
    if(!req.headers.get("content-type")?.startsWith("application/json"))return Response.json({error:"json_required"},{status:415,headers});
    try {
      const raw=await req.text();if(raw.length>2048)throw new Error("too_large");const wifi=wifiInput(JSON.parse(raw));
      const c=this.config();
      const bridge=this.status().usb;if(!bridge)throw new Error("usb_bridge_not_connected");
      const id=crypto.randomUUID();const temp=this.runtime+"/wifi-pending.tmp";
      writeFileSync(temp,JSON.stringify({kind:"provision",request_id:id,expires_at:Date.now()+120000,...wifi,relay_url:c?.enabled?c.url:"",device_token:c?.enabled?c.device_token:""}),{mode:0o600});chmodSync(temp,0o600);renameSync(temp,this.runtime+"/wifi-pending.json");
      return Response.json({status:"queued",request_id:id},{status:202,headers});
    }catch(e){return Response.json({error:e instanceof Error?e.message:"invalid_wifi"},{status:400,headers});}
  }
  private discard(ws:WebSocket,error:string|null){
    if(this.socket!==ws)return;
    this.socket=null;this.connecting=false;this.statusValue.relay_connected=false;this.statusValue.device_connected=false;this.statusValue.last_applied_at=null;this.statusValue.error=error;
    this.nextConnect=this.clock()+Math.min(30000,1000*2**Math.min(this.failures++,5));ws.terminate();
  }
  private heartbeat(ws:WebSocket){
    if(this.clock()-this.lastProbe<5000)return;this.lastProbe=this.clock();ws.send(JSON.stringify({kind:"heartbeat",id:++this.probeId}));
  }
  private tick(){
    if(this.stopped)return;
    let c:RemoteCredentials|null;
    try {c=this.config();this.statusValue.configured=!!c?.enabled;this.statusValue.relay_url=c?.url??null;}catch{this.statusValue.error="invalid_relay_config";return;}
    const signature=JSON.stringify(c);
    if(signature!==this.activeConfig){if(this.socket)this.discard(this.socket,null);this.activeConfig=signature;this.nextConnect=0;this.failures=0;}
    if(!c?.enabled||this.settings.current().device.transport==="wifi"){if(this.socket)this.discard(this.socket,null);return;}
    if(this.socket?.readyState===WebSocket.OPEN){if(this.clock()-this.lastInbound>=20000){this.discard(this.socket,"relay_response_timeout");return;}this.heartbeat(this.socket);this.sendView();return;}
    if(this.connecting||this.clock()<this.nextConnect)return;
    this.connecting=true;
    try {
      const headers={Authorization:"Bearer "+c.mac_token};const ws=this.options.socket?this.options.socket(c.url,headers):new WebSocket(c.url,{headers});this.socket=ws;
      const timeout=setTimeout(()=>{if(ws.readyState!==WebSocket.OPEN)this.discard(ws,"relay_handshake_timeout");},10000);
      ws.onopen=()=>{clearTimeout(timeout);if(this.socket!==ws)return;this.connecting=false;this.failures=0;this.statusValue.relay_connected=true;this.statusValue.error=null;this.lastInbound=this.clock();this.lastProbe=this.clock()-5000;this.heartbeat(ws);this.sendView();};
      ws.onmessage=e=>{if(this.socket!==ws||typeof e.data!=="string"||e.data.length>4096)return;try{const p:unknown=JSON.parse(e.data);if(!p||typeof p!=="object"||Array.isArray(p))throw 0;this.lastInbound=this.clock();this.receive(p as Record<string,unknown>);}catch{this.statusValue.error="invalid_device_packet";}};
      ws.onerror=()=>{if(this.socket===ws)this.statusValue.error="relay_connection_failed";};
      ws.onclose=()=>{clearTimeout(timeout);if(this.socket===ws)this.discard(ws,"relay_connection_closed");};
    }catch{this.connecting=false;this.statusValue.error="relay_connection_failed";this.nextConnect=this.clock()+5000;}
  }
  private receive(p:Record<string,unknown>){
    if(p.kind==="peer"||p.kind==="heartbeat"){if(p.device_connected!==this.statusValue.device_connected)this.statusValue.last_applied_at=null;this.statusValue.device_connected=p.device_connected===true;if(p.kind==="peer"&&p.device_connected)this.sendView();return;}
    if(p.kind==="applied"){
      const id=this.feed.acknowledge(p);if(id!==null){this.statusValue.last_applied_id=id;this.statusValue.last_applied_at=new Date().toISOString();}return;
    }
    if(this.feed.command(p))this.sendView();
  }
  public pushView(){this.sendView();}
  private sendView(){
    const ws=this.socket;if(ws?.readyState!==WebSocket.OPEN||!this.statusValue.device_connected)return;const view=this.feed.encode();
    if(!view){if(this.feed.error)this.statusValue.error=this.feed.error;return;}
    if(ws.bufferedAmount>192*1024){this.statusValue.error="payload_or_backpressure_limit";return;}
    ws.send(view.text);this.feed.sent(view.id,view.display);this.statusValue.last_source_seq=view.seq;
  }
  close(){this.stopped=true;clearInterval(this.timer);this.socket?.close();}
}
