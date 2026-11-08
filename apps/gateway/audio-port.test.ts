import {expect,test} from 'bun:test';
import {audioCRC,transmitAudio,type AudioInfo,type DeviceAudioPort,type AudioPacket,type AudioReply} from '../../packages/protocol/src/audio.ts';
import {parseRuntimeStatus} from './src/codex-runtime-status.ts';

test('software device receives bounded checked chunks and playback requires a device completion receipt',async()=>{
 const data=new Uint8Array(9000).map((_,i)=>i%256),id='fixture-delivery',info:AudioInfo={id:'audio',codec:'pcm_s16le',sample_rate:16000,channels:1,bytes:data.length,sha256:Bun.CryptoHasher.hash('sha256',data,'hex')},received:number[]=[],states:string[]=[];
 let offset=0;
 const port:DeviceAudioPort={device_id:'software-fixture',audio_protocol:1,exchange:async(packet)=>{
  if(packet.kind==='audio_start')return{delivery_id:id,state:'accepted'};
  if(packet.kind==='audio_chunk'){expect(packet.offset).toBe(offset);expect(packet.data.length).toBeLessThanOrEqual(2048);expect(packet.crc32).toBe(audioCRC(packet.data));received.push(...packet.data);offset+=packet.data.length;return{delivery_id:id,state:'chunk',next_offset:offset};}
  expect(new Uint8Array(received)).toEqual(data);expect(Bun.CryptoHasher.hash('sha256',new Uint8Array(received),'hex')).toBe(info.sha256);return{delivery_id:id,state:'played'};
 }};
 await transmitAudio(port,id,info,data,Date.now()+60000,new AbortController().signal,s=>states.push(s));expect(states).toEqual(['playing','played']);
 states.length=0;port.exchange=async packet=>({delivery_id:id,state:packet.kind==='audio_start'?'accepted':packet.kind==='audio_chunk'?'chunk':'playing',...(packet.kind==='audio_chunk'?{next_offset:packet.offset+packet.data.length}:{})});
 await expect(transmitAudio(port,id,info,data,Date.now()+60000,new AbortController().signal,s=>states.push(s))).rejects.toThrow('audio_completion_unconfirmed');expect(states).not.toContain('played');expect(states).toContain('unknown');
});
test('bad offset ACK aborts transfer without declaring playback',async()=>{
 const data=new Uint8Array(3200),info:AudioInfo={id:'a',codec:'pcm_s16le',sample_rate:16000,channels:1,bytes:3200,sha256:'a'.repeat(64)},states:string[]=[],port:DeviceAudioPort={device_id:'mock',audio_protocol:1,exchange:async p=>({delivery_id:'d',state:p.kind==='audio_start'?'accepted':'chunk',next_offset:999})};
 await expect(transmitAudio(port,'d',info,data,Date.now()+60000,new AbortController().signal,s=>states.push(s))).rejects.toThrow('audio_chunk_rejected');expect(states).toHaveLength(0);
});
test('official runtime flags distinguish user input, approvals, running and unloaded threads without exposing metadata',()=>{
 const statuses=parseRuntimeStatus({data:[{id:'approval',status:{type:'active',activeFlags:['waitingOnApproval']}},{id:'input',status:{type:'active',activeFlags:['waitingOnUserInput']}},{id:'running',status:{type:'active',activeFlags:[]}},{id:'unloaded',status:{type:'notLoaded'}},{id:'idle',status:{type:'idle'}}]});
 expect([...statuses]).toEqual([['approval','waiting_user'],['input','waiting_user'],['running','running']]);
});
