/** Strict relay allowlist. Audio carries neither management commands nor model credentials. */
const id=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(v);
const integer=(v:unknown,min:number,max:number)=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=max;
export function validAudioPacket(p:Record<string,unknown>,now=Date.now()){
 if(!id(p.delivery_id)||typeof p.gateway_boot_id!=='string'||!/^[a-f0-9-]{36}$/.test(p.gateway_boot_id)||typeof p.sent_at!=='number'||Math.abs(now/1000-p.sent_at)>=15)return false;
 const base=['kind','delivery_id','gateway_boot_id','sent_at'];let fields:string[]=[];
 if(p.kind==='audio_start'){
  const a=p.audio as Record<string,unknown>|undefined;fields=['version','expires_at','audio'];
  if(p.version!==1||!integer(p.expires_at,now+1,now+900000)||!a||Object.keys(a).some(k=>!['id','codec','sample_rate','channels','bytes','sha256'].includes(k))||!id(a.id)||a.codec!=='pcm_s16le'||a.sample_rate!==16000||a.channels!==1||!integer(a.bytes,2,960000)||Number(a.bytes)%2||typeof a.sha256!=='string'||!/^[a-f0-9]{64}$/.test(a.sha256))return false;
 }else if(p.kind==='audio_chunk'){
  fields=['seq','offset','crc32','data'];if(!integer(p.seq,0,480000)||!integer(p.offset,0,959998)||Number(p.offset)%2||!integer(p.crc32,0,4294967295)||typeof p.data!=='string'||!p.data.length||p.data.length>21848||p.data.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(p.data))return false;
 }else if(!['audio_end','audio_cancel'].includes(String(p.kind)))return false;
 return Object.keys(p).every(k=>base.includes(k)||fields.includes(k));
}
export function validAudioReply(p:Record<string,unknown>){return p.kind==='audio_reply'&&id(p.delivery_id)&&['accepted','chunk','playing','played','rejected'].includes(String(p.state))&&integer(p.next_offset,0,960000)&&Object.keys(p).every(k=>['kind','delivery_id','state','next_offset'].includes(k));}
