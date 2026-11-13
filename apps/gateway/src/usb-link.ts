import {LinkAudio} from './link-audio.ts';
/** USB lifecycle and framed views. The native helper only moves bytes. */
import {chmodSync,existsSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {DeviceSession} from './device-session.ts';
import type {Collector} from './state.ts';
import type {SettingsStore} from './settings.ts';
import type {Assistant} from './assistant.ts';

export function usbCommand(value:Record<string,unknown>,now=Date.now()){
 return ['provision','link_config'].includes(String(value.kind))?{...value,sent_at:now/1000}:value;
}
export function usbFrame(value:unknown):Buffer {
 const body=Buffer.from(JSON.stringify(value));if(!body.length||body.length>192*1024)throw new Error('usb_frame_size');
 return Buffer.concat([Buffer.from(`AC1 ${body.length} ${Bun.hash.crc32(body).toString(16).padStart(8,'0')}\n`),body,Buffer.from('\n')]);
}
export class USBLink {
 private child:ReturnType<typeof Bun.spawn>|null=null;
 readonly audio:LinkAudio;private feed:DeviceSession;private timer:ReturnType<typeof setInterval>;private closed=false;private busy=false;
 private recognized=false;private pending='';private lastView=0;private nextOpen=0;private opened=0;private lastProvision=0;
 private value:Record<string,unknown>={usb_connected:false,connected:false,mode:'usb_viewer',port:null,error:null};
 private readonly helper:string;
 constructor(private runtime:string,collector:Collector,private settings:SettingsStore,assistant?:Assistant,helper?:string){
  this.feed=new DeviceSession(collector,settings,assistant,"usb");this.audio=new LinkAudio('paired-screen',this.feed.boot,p=>this.send(p),()=>this.feed.ownsDisplay()&&!!this.value.connected&&Date.now()-Date.parse(String(this.value.last_ack_utc))<8000&&this.mode()==='usb_viewer');
  this.helper=helper??[join(dirname(process.execPath),'agent-companion-usb'),resolve(import.meta.dir,'../../../.build/agent-companion-usb')].find(existsSync)??'';
  this.timer=setInterval(()=>void this.tick(),1000);void this.tick();
 }
 private save(){
  if(this.closed)return;
  const file=join(this.runtime,'board-bridge.status.json');
  writeFileSync(file+'.tmp',JSON.stringify({...this.value,pid:process.pid,updated_at:new Date().toISOString()}),{mode:0o600});chmodSync(file+'.tmp',0o600);renameSync(file+'.tmp',file);
 }
 private mode(){return ['usb','auto'].includes(this.settings.current().device.transport)?'usb_viewer':'network_only';}
 private send(value:unknown){if(!this.child||!this.recognized)return;const input=this.child.stdin;if(input&&typeof input!=='number')input.write(usbFrame(value));}
 private async tick(){
  if(this.closed||this.busy)return;this.busy=true;
  try{
   this.value.mode=this.mode();
   if(!this.child&&Date.now()>=this.nextOpen){
    this.nextOpen=Date.now()+3000;
    if(!this.helper){this.value.error='usb_component_missing';this.save();return;}
    const scan=Bun.spawn([this.helper,'--list'],{stdout:'pipe',stderr:'ignore'});
    const ports=(await new Response(scan.stdout).text()).trim().split(/\n/).filter(p=>/^\/dev\/cu\.usbmodem[\w.-]+$/.test(p));await scan.exited;
    if(this.closed)return;
    if(ports.length!==1){this.value.error=ports.length>1?'multiple_usb_boards':null;this.save();return;}
    this.recognized=false;this.pending='';this.opened=Date.now();
    const child=Bun.spawn([this.helper,'--port',ports[0]!],{stdin:'pipe',stdout:'pipe',stderr:'ignore'});this.child=child;
    this.value={usb_connected:true,connected:false,mode:this.mode(),port:ports[0],error:null};
    void this.read(child);
   }
   if(this.child){
    if(!this.recognized&&Date.now()-this.opened>20000){this.child.kill();this.value.error='usb_board_not_recognized';}
    if(this.recognized){
     for(const [filename,key] of [['wifi-pending.json','provision'],['link-pending.json','link_config']] as const){
      const path=join(this.runtime,filename);
      if(existsSync(path)){
       const value=JSON.parse(readFileSync(path,'utf8')) as Record<string,unknown>;
       if(Number(value.expires_at)<Date.now())rmSync(path,{force:true});
       else if(Date.now()-this.lastProvision>=5000){this.send(usbCommand(value));this.lastProvision=Date.now();this.value[key]={request_id:value.request_id,state:'sent'};}
      }
     }
     if(this.mode()==='usb_viewer'&&Date.now()-this.lastView>=2000){
      const view=this.feed.encode();if(view){this.send(JSON.parse(view.text));this.feed.sent(view.id,view.display);this.lastView=Date.now();this.value.sent=view.id;}
     }
    }
   }
   this.save();
  }catch{this.value.error='usb_io_failed';this.save();}finally{this.busy=false;}
 }
 private line(text:string){
  if(text.startsWith('AC_AUDIO_DEBUG ')){try{this.audio.deviceEvent=JSON.parse(text.slice(15));}catch{}return;}
  if(text.startsWith('AC_AUDIO_CAP ')){try{this.audio.negotiate(JSON.parse(text.slice(13)));}catch{}}
  if(text.startsWith('AC_AUDIO_REPLY ')){try{this.audio.receive(JSON.parse(text.slice(15)));}catch{}return;}
  if(/AC_EVT .*"version":"V1-board-|ac_device: (health|V1 shared UI)|^AC_LINK /.test(text))this.recognized=true;
  const ack=/^AC_ACK (\d+) /.exec(text);
  if(ack&&this.mode()==='usb_viewer'){
   const id=this.feed.acknowledge({id:Number(ack[1]),gateway_boot_id:this.feed.boot,display:this.value.display});
   if(id!==null){this.value.last_ack=id;this.value.last_ack_utc=new Date().toISOString();this.value.connected=true;}
  }
  for(const [prefix,key,file] of [['AC_DISPLAY ','display',''],['AC_NET ','network',''],['AC_PROVISION ','provision','wifi-pending.json'],['AC_LINK_CONFIG ','link_config','link-pending.json']] as const){
   if(!text.startsWith(prefix))continue;
   try{const value=JSON.parse(text.slice(prefix.length));this.value[key]=value;
    if(file&&value.state==='saved'){const path=join(this.runtime,file);if(existsSync(path)&&JSON.parse(readFileSync(path,'utf8')).request_id===value.request_id)rmSync(path,{force:true});}
   }catch{}
  }
  if(text.startsWith('AC_EVT ')){try{const command=JSON.parse(text.slice(7));if(command.kind==='ready'&&typeof command.version==='string')this.value.board_version=command.version;if(this.feed.command(command))this.lastView=0;}catch{}}
 }
 private async read(child:ReturnType<typeof Bun.spawn>){
  try{
   const output=child.stdout;if(!output||typeof output==='number')return;
   for await(const bytes of output){
    this.pending+=Buffer.from(bytes).toString('utf8');
    if(this.pending.length>65536){this.pending='';continue;}
    let end;while((end=this.pending.indexOf('\n'))>=0){const line=this.pending.slice(0,end).trim();this.pending=this.pending.slice(end+1);this.line(line);}
   }
  }catch{}finally{
   const code=await child.exited;
   if(this.child===child){this.audio.reset();this.child=null;this.recognized=false;this.value.usb_connected=false;this.value.connected=false;this.value.last_ack_utc=null;this.value.port=null;if(code)this.value.error='usb_transport_failed';this.nextOpen=Date.now()+2000;this.save();}
  }
 }
 close(){if(this.closed)return;clearInterval(this.timer);this.audio.reset();this.child?.kill();this.child=null;this.value.usb_connected=false;this.value.connected=false;this.value.last_ack_utc=null;this.value.port=null;this.save();this.closed=true;}
}
