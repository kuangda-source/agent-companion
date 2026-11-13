import {expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SpeechProvider,bailianRoot} from './src/speech-provider.ts';
import {assistantProviderBody,assistantSessionBatch} from './src/assistant-provider-options.ts';
import {VoiceBroadcasts} from './src/voice-broadcast.ts';
import {createLiveGateway} from './src/server.ts';
import {MockState} from './src/scenarios.ts';
import {CredentialStore} from './src/credentials.ts';

function fixture(){const dir=mkdtempSync(join(tmpdir(),'ac-speech-'));mkdirSync(join(dir,'secrets'));writeFileSync(join(dir,'secrets/tts-api-key'),'fixture-only-tts-key');return{dir,remove:()=>rmSync(dir,{recursive:true,force:true})};}
test('saving Bailian model and key while disabled makes zero TTS requests, including queued audio generation',async()=>{
 const f=fixture();let requests=0;const speech=new SpeechProvider(f.dir,undefined,async()=>{requests++;throw new Error('must not call');}),voice=new VoiceBroadcasts(f.dir,speech);
 try{speech.update({provider:'bailian',enabled:false,base_url:'https://dashscope.aliyuncs.com',model:'qwen-audio-3.1-tts-plus',voice:''});voice.update({enabled:true});voice.enqueue({id:'fixture',topic:'fixture',kind:'milestone',text:'fixture'});expect(await voice.prepareNext(true)).toBeNull();await expect(speech.synthesize('fixture','',new AbortController().signal)).rejects.toThrow('speech_disabled');expect(requests).toBe(0);expect(speech.configuration()).toMatchObject({enabled:false,has_key:true,requests_this_run:0});expect(JSON.stringify(speech.configuration())).not.toContain('fixture-only-tts-key');}finally{await voice.close();f.remove();}
});
test('mocked DashScope TTS uses exact model and 16k PCM, never forwards API key to signed audio download',async()=>{
 const f=fixture(),calls:{url:string;options:RequestInit|undefined}[]=[],pcm=new Uint8Array(3200);
 const speech=new SpeechProvider(f.dir,undefined,async(url,options)=>{calls.push({url:String(url),options});return calls.length===1?Response.json({output:{audio:{url:'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/fixture.pcm?signature=fixture'}}}):new Response(pcm);});
 try{speech.update({enabled:true,provider:'bailian',base_url:'https://dashscope.aliyuncs.com',model:'qwen-audio-3.1-tts-plus',voice:'fixture-voice'});expect(await speech.synthesize('播报短文','',new AbortController().signal)).toEqual(pcm);
 expect(JSON.parse(String(calls[0].options?.body))).toEqual({model:'qwen-audio-3.1-tts-plus',input:{text:'播报短文',voice:'fixture-voice',format:'pcm',sample_rate:16000}});expect(calls[1].url.startsWith('https://')).toBe(true);expect(calls[1].options?.headers).toBeUndefined();expect(calls[0].options?.redirect).toBe('error');expect(speech.configuration().requests_this_run).toBe(1);
 }finally{f.remove();}
});
test('untrusted endpoints and audio URLs are rejected and do not leak credentials',async()=>{
 const f=fixture();try{for(const value of ['http://dashscope.aliyuncs.com','https://evil.example','https://dashscope.aliyuncs.com@evil.example','https://dashscope.aliyuncs.com/private'])expect(()=>bailianRoot(value)).toThrow();let count=0;
 const speech=new SpeechProvider(f.dir,undefined,async()=>{count++;return Response.json({output:{audio:{url:'https://evil.example/audio'}}});});speech.update({enabled:true,provider:'bailian',base_url:'https://dashscope.aliyuncs.com',model:'qwen-audio-3.1-tts-plus',voice:'fixture'});await expect(speech.synthesize('fixture','',new AbortController().signal)).rejects.toThrow('speech_provider_failed');expect(count).toBe(1);
 }finally{f.remove();}
});
test('Qwen thinking budget is finite and provider scoped; conflicting effort fields and preserved reasoning are disabled',()=>{
 const config={base_url:'https://dashscope.aliyuncs.com/compatible-mode/v1',model:'qwen3.8-flash'},body=assistantProviderBody(config,{reasoning_effort:'xhigh',messages:[]},'chat');expect(body).toMatchObject({model:'qwen3.8-flash',enable_thinking:true,thinking_budget:1024,preserve_thinking:false,max_tokens:8000});expect('reasoning_effort' in body).toBe(false);expect(assistantProviderBody(config,{},'briefing')).toMatchObject({enable_thinking:false,preserve_thinking:false});
 expect(assistantSessionBatch(config)).toBe(1);expect(assistantSessionBatch({...config,base_url:'https://api.example/v1'})).toBe(2);
 const other=assistantProviderBody({...config,base_url:'https://api.example/v1'},{messages:[]});expect('thinking_budget' in other).toBe(false);expect(other.max_tokens).toBe(10000);
});
test('TTS provider configuration and key routes retain auth and save without synthesis',async()=>{
 const f=fixture();let count=0;const speech=new SpeechProvider(f.dir,undefined,async()=>{count++;throw new Error('no live calls');}),voice=new VoiceBroadcasts(f.dir,speech),credentials=new CredentialStore(f.dir),gateway=createLiveGateway(new MockState(),'fixture-token',0,60000,undefined,undefined,undefined,undefined,credentials,voice,speech),headers={Authorization:'Bearer fixture-token','Content-Type':'application/json'};
 try{const endpoint=new URL('/api/v1/voice/provider',gateway.server.url);expect((await fetch(endpoint)).status).toBe(401);expect((await fetch(endpoint,{method:'PATCH',headers:{...headers,Origin:'https://evil.example'},body:'{"enabled":true}'})).status).toBe(403);
 expect((await fetch(endpoint,{method:'PATCH',headers,body:JSON.stringify({enabled:false,provider:'bailian',base_url:'https://dashscope.aliyuncs.com',model:'qwen-audio-3.1-tts-plus'})})).status).toBe(200);
 const keyResponse=await fetch(new URL('/api/v1/credentials',gateway.server.url),{method:'PATCH',headers,body:JSON.stringify({service:'tts',key:'fixture-only-replacement-key'})});expect(keyResponse.status).toBe(200);expect(await keyResponse.text()).not.toContain('fixture-only-replacement-key');
 expect((await fetch(new URL('/api/v1/voice/test',gateway.server.url),{method:'POST',headers,body:'{}'})).status).toBe(409);expect(count).toBe(0);
 }finally{gateway.close();await voice.close();f.remove();}
});

test('native Qwen schema scopes citations to the correct session and removes truncating token limits',async()=>{
 const {briefingOutputSchema}=await import('./src/assistant-output-schema.ts');const e={id:'ref_own',session_id:'session',project_id:'project',title:'fixture',role:'user' as const,timestamp:null,text:'fixture'};
 const schema=briefingOutputSchema([{session_id:'session',project_id:'project'}],new Map([[e.id,e],['ref_related',{...e,id:'ref_related',session_id:'other'}],['ref_foreign',{...e,id:'ref_foreign',session_id:'foreign',project_id:'foreign'}]])) as any;
 expect(schema.properties.sessions.items.properties.source_ids.items.enum).toEqual(['ref_own']);expect(schema.properties.projects.items.properties.source_ids.items.enum).toEqual(['ref_own','ref_related']);expect(schema.required).toEqual(['projects','attention','changes','sessions']);
 const request=assistantProviderBody({base_url:'https://dashscope.aliyuncs.com/compatible-mode/v1',model:'qwen3.8-flash'},{max_completion_tokens:32},'briefing',schema);
 expect(request.response_format).toMatchObject({type:'json_schema',json_schema:{strict:true}});expect('max_tokens' in request).toBe(false);expect('max_completion_tokens' in request).toBe(false);expect(()=>briefingOutputSchema([{session_id:'missing',project_id:'project'}],new Map())).toThrow('no_readable_sources');
});

test('private audio cache keys include model voice and text; changed voice synthesizes only a new request',async()=>{
 const f=fixture();let calls=0;const pcm=new Uint8Array(100),speech=new SpeechProvider(f.dir,undefined,async(url)=>{calls++;return String(url).includes('/SpeechSynthesizer')?Response.json({output:{audio:{url:'https://dashscope-result-test.oss-cn-beijing.aliyuncs.com/fixture'}}}):new Response(pcm);});
 try{speech.update({enabled:true,provider:'bailian',base_url:'https://dashscope.aliyuncs.com',model:'fixture',voice:'one'});const signal=new AbortController().signal;await speech.synthesize('fixture','',signal);await speech.synthesize('fixture','',signal);expect(calls).toBe(2);speech.update({voice:'two'});await speech.synthesize('fixture','',signal);expect(calls).toBe(4);expect(speech.configuration().requests_this_run).toBe(2);}finally{f.remove();}
});
