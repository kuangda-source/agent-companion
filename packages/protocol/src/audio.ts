/** Versioned transport-independent audio port. Real USB/LAN/relay adapters must
 * authenticate their peer and negotiate this capability before sending packets. */
export interface AudioInfo {id:string;codec:'pcm_s16le';sample_rate:16000;channels:1;bytes:number;sha256:string}
export type AudioPacket=
 |{kind:'audio_start';version:1;delivery_id:string;expires_at:number;audio:AudioInfo}
 |{kind:'audio_chunk';delivery_id:string;seq:number;offset:number;crc32:number;data:Uint8Array}
 |{kind:'audio_end'|'audio_cancel';delivery_id:string};
export interface AudioReply {delivery_id:string;state:'accepted'|'chunk'|'playing'|'played'|'rejected';next_offset?:number}
export interface DeviceAudioPort {
 device_id:string;audio_protocol:1;chunk_bytes?:number;window_size?:number;
 exchange(packet:AudioPacket,signal:AbortSignal,onPlayback?:(event:AudioReply)=>void):Promise<AudioReply>;
}
export function audioCRC(data:Uint8Array):number {let crc=0xffffffff;for(const b of data){crc^=b;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
/** Bounded chunks permit each link to schedule view/touch traffic in between. */
export async function transmitAudio(port:DeviceAudioPort,delivery:string,info:AudioInfo,data:Uint8Array,expiresAt:number,signal:AbortSignal,onState:(state:'playing'|'played'|'unknown')=>void,clock=()=>Date.now()){
 if(port.audio_protocol!==1||info.bytes!==data.byteLength||data.length>960000||data.length<2||data.length%2||info.sample_rate!==16000||info.channels!==1||info.codec!=='pcm_s16le'||!/^[a-f0-9]{64}$/.test(info.sha256))throw new Error('invalid_audio_transfer');
 let began=false;
 const exchange=async(packet:AudioPacket)=>{
  if(signal.aborted||clock()>=expiresAt)throw new Error('audio_cancelled');
  const controller=new AbortController(),abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});
  let timeout:ReturnType<typeof setTimeout>|undefined;
  try{
   const failed=new Promise<never>((_,reject)=>{controller.signal.addEventListener('abort',()=>reject(new Error('audio_cancelled')),{once:true});timeout=setTimeout(()=>controller.abort(),packet.kind==='audio_end'?35000:5000);});
   const response=await Promise.race([port.exchange(packet,controller.signal,event=>{if(event.delivery_id===delivery&&event.state==='playing'&&!began){began=true;onState('playing');}}),failed]);if(response.delivery_id!==delivery||response.state==='rejected')throw new Error('audio_rejected');return response;
  }finally{clearTimeout(timeout);signal.removeEventListener('abort',abort);}
 };
 try{
  if((await exchange({kind:'audio_start',version:1,delivery_id:delivery,expires_at:expiresAt,audio:info})).state!=='accepted')throw new Error('audio_start_rejected');
  let seq=0;const size=port.chunk_bytes??2048,window=port.window_size??1;
  if(!Number.isInteger(size)||size<2||size>16384||size%2||!Number.isInteger(window)||window<1||window>4)throw new Error('invalid_audio_window');
  for(let base=0;base<data.length;base+=size*window){
   const pending:Promise<void>[]=[];
   for(let offset=base;offset<Math.min(base+size*window,data.length);offset+=size){
    const chunk=data.subarray(offset,Math.min(offset+size,data.length));
    pending.push(exchange({kind:'audio_chunk',delivery_id:delivery,seq:seq++,offset,crc32:audioCRC(chunk),data:chunk}).then(ack=>{
     if(ack.state!=='chunk'||ack.next_offset!==offset+chunk.length)throw new Error('audio_chunk_rejected');
    }));
   }
   await Promise.all(pending);
  }
  // The adapter forwards asynchronous device start receipts before final completion.
  const reply=await exchange({kind:'audio_end',delivery_id:delivery});
  if(reply.state==='playing'){if(!began){began=true;onState('playing');}throw new Error('audio_completion_unconfirmed');}
  if(reply.state!=='played')throw new Error('audio_completion_unconfirmed');
  if(!began){began=true;onState('playing');}onState('played');
 }catch(error){if(began)onState('unknown');const stop=new AbortController();const limit=setTimeout(()=>stop.abort(),1000);try{await Promise.race([port.exchange({kind:'audio_cancel',delivery_id:delivery},stop.signal),new Promise<void>(r=>stop.signal.addEventListener('abort',()=>r(),{once:true}))]);}catch{}finally{clearTimeout(limit);stop.abort();}throw error;}
}
