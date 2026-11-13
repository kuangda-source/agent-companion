/** Audio packets share the authenticated view link, with independently bounded requests. */
import type {AudioPacket,AudioReply,DeviceAudioPort} from '../../../packages/protocol/src/audio.ts';
export class LinkAudio implements DeviceAudioPort {
 readonly audio_protocol=1 as const;readonly chunk_bytes=16384;readonly window_size=4;
 deviceEvent:unknown=null;
 private diagnostic:{sent:number;last_packet:string|null;last_reply:string|null;offset:number;error:string|null}={sent:0,last_packet:null,last_reply:null,offset:0,error:null};
 status(){return {...this.diagnostic,device_event:this.deviceEvent,ready:this.ready(),pending:this.pending.size};}
 private supported=false;private pending=new Map<string,{resolve:(v:AudioReply)=>void;reject:(e:Error)=>void;update?:((e:AudioReply)=>void);cleanup:()=>void}>();
 constructor(readonly device_id:string,private boot:string,private send:(p:unknown)=>void,private connected:()=>boolean){}
 negotiate(p:Record<string,unknown>){this.supported=p.audio_protocol===1;}
 ready(){return this.supported&&this.connected();}
 reset(){this.supported=false;for(const p of this.pending.values()){p.cleanup();p.reject(new Error('audio_link_closed'));}this.pending.clear();}
 receive(p:Record<string,unknown>){
  if(p.kind!=='audio_reply'||typeof p.delivery_id!=='string'||!['accepted','chunk','playing','played','rejected'].includes(String(p.state)))return false;
  this.diagnostic.last_reply=String(p.state);this.diagnostic.offset=Number(p.next_offset)||0;
  if(p.state==='rejected'){this.diagnostic.error='device_rejected';for(const [k,w] of this.pending)if(k.startsWith(p.delivery_id+':')){w.cleanup();this.pending.delete(k);if(k.endsWith(':cancel'))w.resolve(p as unknown as AudioReply);else w.reject(new Error('audio_rejected'));}return true;}
  const key=p.delivery_id+':'+(p.state==='chunk'?p.next_offset:p.state==='accepted'?'start':'end'),wait=this.pending.get(key);
  if(!wait)return true;const reply=p as unknown as AudioReply;
  if(p.state==='playing'){wait.update?.(reply);return true;}wait.cleanup();this.pending.delete(key);wait.resolve(reply);return true;
 }
 exchange(packet:AudioPacket,signal:AbortSignal,update?:(p:AudioReply)=>void):Promise<AudioReply>{
  if(!this.ready()||signal.aborted){this.diagnostic.error='device_unavailable';return Promise.reject(new Error('audio_device_unavailable'));}
  this.diagnostic.sent++;this.diagnostic.last_packet=packet.kind;this.diagnostic.error=null;
  const key=packet.delivery_id+':'+(packet.kind==='audio_chunk'?packet.offset+packet.data.length:packet.kind==='audio_start'?'start':packet.kind==='audio_cancel'?'cancel':'end');
  if(this.pending.has(key))return Promise.reject(new Error('audio_duplicate_request'));
  return new Promise((resolve,reject)=>{
   const abort=()=>{this.pending.delete(key);reject(new Error('audio_cancelled'));},cleanup=()=>signal.removeEventListener('abort',abort);
   signal.addEventListener('abort',abort,{once:true});this.pending.set(key,{resolve,reject,update,cleanup});
   try{this.send({...packet,...(packet.kind==='audio_chunk'?{data:Buffer.from(packet.data).toString('base64')} :{}),gateway_boot_id:this.boot,sent_at:Date.now()/1000});}catch{cleanup();this.pending.delete(key);reject(new Error('audio_send_failed'));}
  });
 }
}
