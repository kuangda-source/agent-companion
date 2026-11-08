import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,writeFileSync,appendFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionMemory} from './src/session-memory.ts';
import {newSession} from './src/adapters/common.ts';

function fixture(){const dir=mkdtempSync(join(tmpdir(),'ac-incremental-')),path=join(dir,'fixture.jsonl'),db=new Database(join(dir,'fixture.sqlite')),s=newSession('codex','f','rollout');const row=(text:string)=>JSON.stringify({type:'response_item',timestamp:new Date().toISOString(),payload:{type:'message',role:'assistant',channel:'final',content:[{type:'output_text',text}]}})+'\n';writeFileSync(path,row('initial goal'));return{db,dir,path,s,row,source:{path,project_dir:dir},memory:new SessionMemory(db),close:()=>{db.close();rmSync(dir,{recursive:true,force:true});}};}
test('ingestion survives model failure and restart; accepted summary advances an independent cursor',async()=>{
 const f=fixture();try{const a=await f.memory.ingest(f.s,f.source,null,1000);expect(a.evidence).toHaveLength(1);const restored=new SessionMemory(f.db),again=await restored.ingest(f.s,f.source,null,1000);expect(again.evidence[0].id).toBe(a.evidence[0].id);
 restored.commit(f.s.id,again.through,restored.facts(f.s.id),{summary:'accepted'});expect((await restored.ingest(f.s,f.source,null,1000)).evidence).toHaveLength(0);
 appendFileSync(f.path,f.row('new result'));const next=await restored.ingest(f.s,f.source,null,1000);expect(next.evidence).toHaveLength(1);expect(next.evidence[0].text).toBe('new result');expect(restored.status()?.pending).toBe(1);
 }finally{f.close();}
});
test('large incremental growth consumes public messages sequentially without jumping over middle results',async()=>{
 const f=fixture();try{const initial=await f.memory.ingest(f.s,f.source,null,800);f.memory.commit(f.s.id,initial.through,f.memory.facts(f.s.id),{});
 for(let i=0;i<75;i++)appendFileSync(f.path,f.row('result-'+i+' '+'x'.repeat(250)));
 appendFileSync(f.path,JSON.stringify({type:'response_item',payload:{type:'function_call_output',output:'x'.repeat(2*1024*1024)}})+'\n'+f.row('final result'));
 const collected:string[]=[];for(let page=0;page<60;page++){const b=await f.memory.ingest(f.s,f.source,null,800);collected.push(...b.evidence.map(e=>e.text));f.memory.commit(f.s.id,b.through,f.memory.facts(f.s.id),{});if(collected.includes('final result'))break;}
 expect(collected).toHaveLength(76);for(let i=0;i<75;i++)expect(collected.some(t=>t.startsWith('result-'+i+' '))).toBe(true);expect(collected.at(-1)).toBe('final result');
 }finally{f.close();}
});
test('structured facts retain unmentioned questions, track resolutions and reject cross-session evidence',async()=>{
 const f=fixture();try{const batch=await f.memory.ingest(f.s,f.source,null,1000),e=batch.evidence[0],allowed=new Map([[e.id,e]]),fact={key:'verify',text:'check result',stage:'reported',source_ids:[e.id],status:'open'};
 const facts=f.memory.merge(f.s.id,{open_questions:[fact]},allowed);f.memory.commit(f.s.id,batch.through,facts,{});expect(f.memory.merge(f.s.id,{open_questions:[]},allowed).open_questions[0].status).toBe('open');expect(f.memory.merge(f.s.id,{open_questions:[{...fact,status:'resolved'}]},allowed).open_questions[0].status).toBe('resolved');
 expect(()=>f.memory.merge(f.s.id,{current_task:{...fact,source_ids:['invented']}},allowed)).toThrow();
 }finally{f.close();}
});

test('known evidence replay can be acknowledged without rewriting facts or blocking later increments',async()=>{
 const f=fixture();try{const a=await f.memory.ingest(f.s,f.source,null,1000);f.memory.commit(f.s.id,a.through,f.memory.facts(f.s.id),{});
 f.db.query('UPDATE session_memory SET cursor=? WHERE id=?').run(JSON.stringify({...a.cursor,offset:0}),f.s.id);const replay=await f.memory.ingest(f.s,f.source,null,1000);expect(replay.evidence).toHaveLength(0);f.memory.acknowledgeKnown(f.s.id,replay.through);
 appendFileSync(f.path,f.row('new after replay'));expect((await f.memory.ingest(f.s,f.source,null,1000)).evidence.map(e=>e.text)).toEqual(['new after replay']);
 }finally{f.close();}
});

test('unresolved questions remain stored beyond the prompt budget without blocking later summaries',async()=>{
 const f=fixture();try{const batch=await f.memory.ingest(f.s,f.source,null,1000),e=batch.evidence[0],allowed=new Map([[e.id,e]]);
 for(let page=0;page<3;page++){const facts=f.memory.merge(f.s.id,{open_questions:Array.from({length:10},(_,i)=>({key:'question_'+(page*10+i),text:'fixture unresolved item',source_ids:[e.id],stage:'reported',status:'open'}))},allowed);f.memory.commit(f.s.id,batch.through,facts,{});}
 expect(f.memory.facts(f.s.id).open_questions).toHaveLength(30);expect(f.memory.prompt(f.s.id,1000).partial).toBe(true);expect(JSON.stringify(f.memory.prompt(f.s.id,1000)).length).toBeLessThanOrEqual(1000);
 }finally{f.close();}
});

test('same-topic duplicates merge references and equal-time conflicting states remain unconfirmed',async()=>{
 const {uniqueTopics}=await import('./src/assistant-validation.ts');const base={project_id:'fixture',key:'topic',source_at:100,source_ids:['one'],status:'open'};
 expect(uniqueTopics([base,{...base,source_ids:['two']}],v=>v.status)[0].source_ids).toEqual(['one','two']);
 expect(uniqueTopics([base,{...base,status:'resolved'}],v=>v.status)).toHaveLength(0);
 expect(uniqueTopics([{...base,source_at:200,status:'resolved'},base],v=>v.status)[0].status).toBe('resolved');
});
