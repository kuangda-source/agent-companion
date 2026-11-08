import {chmodSync,existsSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {object} from './adapters/common.ts';
import {spoken,type TTSPort} from './voice-broadcast.ts';

export interface SpeechConfiguration {enabled:boolean;provider:'system'|'bailian';base_url:string;model:string;voice:string}
const initial=():SpeechConfiguration=>({enabled:false,provider:'system',base_url:'',model:'',voice:''});
export function bailianRoot(value:string):string {
 const url=new URL(value);
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname)||url.port||!(/^(dashscope|dashscope-intl)\.aliyuncs\.com$/.test(url.hostname)||/^[a-z0-9-]+\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(url.hostname)))throw new Error('invalid_speech_endpoint');
 return url.origin;
}
async function bounded(response:Response,limit:number):Promise<Uint8Array>{
 if(!response.ok||!response.body)throw new Error('speech_provider_failed');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{while(true){const value=await reader.read();if(value.done)break;size+=value.value.length;if(size>limit)throw new Error('speech_response_too_large');chunks.push(value.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
/** Separate opt-in TTS configuration; saving a model/key never starts synthesis. */
export class SpeechProvider implements TTSPort {
 private config:SpeechConfiguration;private networkRequests=0;
 constructor(private runtime:string,private system?:TTSPort,private request:(input:string|URL,init?:RequestInit)=>Promise<Response>=fetch){
  const path=join(runtime,'speech-config.json');this.config=existsSync(path)?{...initial(),...JSON.parse(readFileSync(path,'utf8'))}:initial();
 }
 private keyPath(){return join(this.runtime,'secrets/tts-api-key');}
 configuration(){return{...this.config,has_key:existsSync(this.keyPath()),requests_this_run:this.networkRequests};}
 available(){return this.config.enabled&&(this.config.provider==='system'?!!this.system:!!this.config.base_url&&!!this.config.model&&!!this.config.voice&&existsSync(this.keyPath()));}
 update(input:unknown){
  const p=object(input),next={...this.config};if(!Object.keys(p).length||Object.keys(p).some(k=>!(k in next)))throw new Error('invalid_speech_config');
  if(p.enabled!==undefined){if(typeof p.enabled!=='boolean')throw new Error('invalid_speech_config');next.enabled=p.enabled;}
  if(p.provider!==undefined){if(p.provider!=='system'&&p.provider!=='bailian')throw new Error('invalid_speech_config');next.provider=p.provider;}
  for(const key of ['model','voice'] as const)if(p[key]!==undefined){if(typeof p[key]!=='string'||p[key].length>120||/[\x00-\x1f]/.test(p[key]))throw new Error('invalid_speech_config');next[key]=p[key].trim();}
  if(p.base_url!==undefined){if(typeof p.base_url!=='string')throw new Error('invalid_speech_config');next.base_url=p.base_url?bailianRoot(p.base_url):'';}
  if(next.enabled&&next.provider==='bailian'&&(!next.base_url||!next.model||!next.voice||!existsSync(this.keyPath())))throw new Error('speech_not_configured');
  mkdirSync(this.runtime,{recursive:true,mode:0o700});const path=join(this.runtime,'speech-config.json');writeFileSync(path+'.tmp',JSON.stringify(next,null,2)+'\n',{mode:0o600});chmodSync(path+'.tmp',0o600);renameSync(path+'.tmp',path);this.config=next;return this.configuration();
 }
 async synthesize(text:string,voice:string,signal:AbortSignal){
  if(!this.available()||signal.aborted)throw new Error('speech_disabled');const config={...this.config};
  if(config.provider==='system')return this.system!.synthesize(text,config.voice||voice,signal);
  const key=readFileSync(this.keyPath(),'utf8').trim();if(!key)throw new Error('speech_not_configured');
  const root=bailianRoot(config.base_url),controller=new AbortController(),abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});const timeout=setTimeout(abort,45000);
  try{
   this.networkRequests++;
   const response=await this.request(root+'/api/v1/services/audio/tts/SpeechSynthesizer',{method:'POST',redirect:'error',signal:controller.signal,headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model:config.model,input:{text:spoken(text).replaceAll(key,'[已隐藏凭据]'),voice:config.voice,format:'pcm',sample_rate:16000}})});
   const raw=JSON.parse(new TextDecoder().decode(await bounded(response,65536))),audio=object(object(object(raw).output).audio);
   if(typeof audio.url!=='string')throw new Error('speech_invalid_response');const url=new URL(audio.url);
   if(url.username||url.password||url.port||url.hash||!/^dashscope-result-[a-z0-9-]+\.oss-[a-z0-9-]+\.aliyuncs\.com$/.test(url.hostname)||!['http:','https:'].includes(url.protocol))throw new Error('speech_invalid_download');
   url.protocol='https:'; // Signed OSS downloads use TLS and never receive the API key.
   const bytes=await bounded(await this.request(url,{redirect:'error',signal:controller.signal}),960000);
   if(bytes.length<2||bytes.length%2)throw new Error('speech_invalid_audio');return bytes;
  }catch{throw new Error(controller.signal.aborted?'speech_cancelled':'speech_provider_failed');}
  finally{clearTimeout(timeout);signal.removeEventListener('abort',abort);}
 }
}
