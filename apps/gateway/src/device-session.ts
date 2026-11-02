import type { DisplayCommand } from "./display-sync.ts";
/** Business views shared by cloud and local device transports. */
import type {Collector} from "./state.ts";
import type {SettingsStore} from "./settings.ts";
import type {Assistant} from "./assistant.ts";
export function clipDeviceText(text:string) {
  if(Buffer.byteLength(text)<4096)return text;
  return new TextDecoder("utf-8",{fatal:false}).decode(Buffer.from(text).subarray(0,4000)).replace(/\uFFFD$/u,"")+"\n…（长消息已截短）";
}
const selections=new WeakMap<Collector,{id:string|null;boot:string;counter:number}>();
export class DeviceSession {
 lastCommand:{kind:string;status:"accepted"|"busy"|"failed";code:string|null;observed_at:string}|null=null;
 readonly boot:string; private selection:{id:string|null;boot:string;counter:number}; private pending=new Map<number,DisplayCommand|undefined>(); public error:string|null=null; private lastAck=0;
 constructor(private collector:Collector,private settings:SettingsStore,private assistant?:Assistant){let selected=selections.get(collector);if(!selected){selected={id:null,boot:crypto.randomUUID(),counter:0};selections.set(collector,selected);}this.selection=selected;this.boot=selected.boot;}
 acknowledge(p:Record<string,unknown>):number|null {
  if(p.gateway_boot_id===this.boot&&Number.isSafeInteger(p.id)&&Number(p.id)>this.lastAck&&this.pending.has(Number(p.id))){const display=this.pending.get(Number(p.id));if(display)this.settings.display.acknowledge(display,p.display);this.lastAck=Number(p.id);for(const id of this.pending.keys())if(id<=this.lastAck)this.pending.delete(id);return this.lastAck;}return null;
 }
 command(p:Record<string,unknown>):boolean {
  const kind=String(p.kind);
  const record=(status:"accepted"|"busy"|"failed",code:string|null=null)=>{this.lastCommand={kind,status,code,observed_at:new Date().toISOString()};};
  try{
   if(p.kind==="theme"&&["neon","comic","neumorphism"].includes(String(p.value))){this.settings.update({appearance:{theme:p.value}});record("accepted");return true;}
   if(p.kind==="detail"&&typeof p.id==="string"){this.selection.id=this.collector.detail(p.id)?p.id:null;record("accepted");return true;}
   if(p.kind==="assistant_refresh"){
    if(!this.assistant){record("failed","assistant_unavailable");return false;}
    this.assistant.refresh();record("accepted");return false;
   }
  }catch(error){
   const code=error instanceof Error?error.message:"device_command_failed";
   record(code==="assistant_busy"?"busy":"failed",["assistant_busy","assistant_closed","assistant_not_configured"].includes(code)?code:"device_command_failed");
   // Business errors stay within this command. The live view/heartbeat channel remains usable.
   return false;
  }
  return false;
 }
 sent(id:number,display?:DisplayCommand){this.pending.set(id,display);if(this.pending.size>64)this.pending.delete(this.pending.keys().next().value!);}
 encode():{id:number;text:string;seq:number;display:DisplayCommand}|null {
  this.error=null;const state=this.collector.current();if(state.data_source!=="live"||Math.abs(Date.now()-Date.parse(state.generated_at))>10000)return null;
  const a=this.assistant?.current();if(!a)return null;const settings=this.settings.current(),display=this.settings.display.command(settings.device);
  let detail=this.selection.id?this.collector.detail(this.selection.id):undefined;
  if(detail)detail={...detail,messages:detail.messages.slice(0,12).map(m=>({...m,text:clipDeviceText(m.text)})),transcript_truncated:detail.transcript_truncated||detail.messages.length>12||detail.messages.some(m=>Buffer.byteLength(m.text)>=4096)};
  const value={id:++this.selection.counter,gateway_boot_id:this.boot,sent_at:Date.now()/1000,state,assistant:{schema_version:1,data_source:"live",revision:a.revision,status:a.status,model:a.model,messages:a.messages.slice(-8).map(m=>({...m,text:clipDeviceText(m.text)}))},settings:{revision:settings.revision,appearance:settings.appearance,display},...(detail?{detail}:{})};
  const text=JSON.stringify(value);if(Buffer.byteLength(text)>192*1024){this.error="payload_or_backpressure_limit";return null;}return {id:value.id,text,seq:state.seq,display};
 }
}
