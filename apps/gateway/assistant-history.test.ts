import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,appendFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AssistantHistory,historicalExcerpt} from './src/assistant-history.ts';
import {SessionMemory,type SessionFact} from './src/session-memory.ts';
import {AssistantNotifications} from './src/assistant-notifications.ts';
import {Assistant,assistantResponse} from './src/assistant.ts';
import {MastraAssistantEngine} from './src/assistant-mastra.ts';
import {MockState} from './src/scenarios.ts';
import {newSession,object,array} from './src/adapters/common.ts';
import {createLiveGateway} from './src/server.ts';

function store(){
 const db=new Database(':memory:');db.exec(`CREATE TABLE evidence(id TEXT PRIMARY KEY,session_id TEXT,project_id TEXT,title TEXT,role TEXT,timestamp TEXT,text TEXT);
 CREATE TABLE sources(id TEXT PRIMARY KEY,project_id TEXT,title TEXT,cursor TEXT,note TEXT,updated_at TEXT);CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);`);
 new SessionMemory(db);new AssistantNotifications(db);const history=new AssistantHistory(db);
 function save(text:string,index:number,options:{session?:string;project?:string;role?:string}={}){
  const id='ref_'+String(index).padStart(24,'0'),session_id=options.session??'codex:fixture:one',project_id=options.project??'project_fixture',timestamp=new Date(Date.UTC(2026,0,index+1)).toISOString();
  db.query('INSERT OR REPLACE INTO evidence VALUES(?,?,?,?,?,?,?)').run(id,session_id,project_id,'合成科研项目',options.role??'assistant',timestamp,text);
  const note={session_id,project_id,title:'合成科研项目',summary:'已报告的合成进展。',source_ids:[id]};
  const fact:SessionFact={key:'experiment',text,source_ids:[id],observed_at:timestamp,stage:'reported'};
  return {id,note,fact};
 }
 return {db,history,save};
}
test('Chinese and code-identifier search retrieve older results beyond the rolling snapshot and survive restart',()=>{
 const f=store();try{
  for(let i=0;i<20;i++){const x=f.save(i===0?'F19 对照实验失败，原因是显存不足，CUDA OOM。':'其他实验结果 '+i,i);f.history.recordSession(x.note,{current_task:null,latest_results:[x.fact],open_questions:[]});}
  const h=new AssistantHistory(f.db),chinese=h.search({query:'为什么上次实验显存不足',kind:'result'});
  expect(chinese.items.some(e=>e.text.includes('F19'))).toBe(true);expect(h.search({query:'F19',kind:'result'}).items).toHaveLength(1);
  expect(h.search({query:'cuda',kind:'result'}).items[0].text).toContain('OOM');expect(h.search({query:'不存在的独特量子物件'}).total).toBe(0);
  expect(JSON.stringify(chinese)).not.toContain('search_tokens');expect(JSON.stringify(h.get(chinese.items[0].id)!)).not.toContain('search_tokens');
 }finally{f.db.close();}
});
test('events keep failure and resolution versions; recall includes the newer state without discarding the original reason',()=>{
 const f=store();try{
  const old=f.save('F19 失败原因：显存不足，仍待修复。',1),next=f.save('F19 显存问题已解决，缩小批量后通过。',2);
  f.history.recordSession(old.note,{current_task:null,latest_results:[],open_questions:[{...old.fact,key:'memory_oom',status:'open'}]});
  f.history.recordSession(next.note,{current_task:null,latest_results:[],open_questions:[{...next.fact,key:'memory_oom',status:'resolved'}]});
  expect(f.history.search({kind:'failure'}).total).toBe(1);expect(f.history.search({kind:'resolution'}).total).toBe(1);
  const recalled=f.history.recall('F19 失败原因',['codex']);expect(recalled.some(e=>e.status==='open')).toBe(true);expect(recalled.some(e=>e.status==='resolved')).toBe(true);
  expect(f.history.recall('F19',['grok'])).toHaveLength(0);
 }finally{f.db.close();}
});
test('short Chinese queries require matching concepts and rank observation text ahead of incidental source mentions',()=>{
 const f=store();try{
  const disk=f.save('磁盘空间不足，和GPU无关。',1),direct=f.save('F19 失败，因为显存不足。',2),incidental=f.save('提及显存不足，但本条结果是另一个工作。',3);
  f.history.recordSession(disk.note,{current_task:null,latest_results:[disk.fact],open_questions:[]});
  f.history.recordSession(direct.note,{current_task:null,latest_results:[direct.fact],open_questions:[]});
  f.history.recordSession(incidental.note,{current_task:null,latest_results:[{...incidental.fact,text:'完成无关材料整理。'}],open_questions:[]});
  const found=f.history.search({query:'显存不足',kind:'result'});expect(found.total).toBe(2);expect(found.items[0].text).toContain('F19');expect(found.items.some(e=>e.text.includes('磁盘'))).toBe(false);
  expect(f.history.search({query:'F19 失败原因',kind:'result'}).items[0].text).toContain('F19');
 }finally{f.db.close();}
});
test('dedup, source ownership, redaction and transactional rollback apply to the index',()=>{
 const f=store();try{
  const x=f.save('合成失败原因 '+('sk-'+'x'.repeat(32)),1),facts={current_task:null,latest_results:[{...x.fact,stage:'verified' as const}],open_questions:[]};
  f.history.recordSession(x.note,facts);const n=f.history.status().events;f.history.recordSession(x.note,facts);expect(f.history.status().events).toBe(n);
  expect(f.history.search({kind:'result'}).items[0].stage).toBe('reported');expect(JSON.stringify(f.history.search())).not.toContain('x'.repeat(32));
  const alien=f.save('其他项目',3,{session:'grok:fixture:two',project:'project_other'});
  expect(()=>f.history.recordSession(x.note,{...facts,latest_results:[{...x.fact,source_ids:[alien.id]}]})).toThrow('invalid_source_reference');
  const fresh=f.save('应回滚的结果',4);expect(()=>f.db.transaction(()=>{f.history.recordSession(fresh.note,{current_task:null,latest_results:[fresh.fact],open_questions:[]});throw new Error('rollback');})()).toThrow();
  expect(f.history.search({query:'应回滚'}).total).toBe(0);expect(f.history.status().events).toBe(n);
 }finally{f.db.close();}
});
test('bounded FTS input, type/project/date filters and pagination never interpret raw query syntax',()=>{
 const f=store();try{
  for(let i=0;i<5;i++){const x=f.save('F19 对照结果 '+i,i);f.history.recordSession(x.note,{current_task:null,latest_results:[x.fact],open_questions:[]});}
  const page=f.history.search({query:'F19',kind:'result',limit:2});expect(page.total).toBe(5);expect(page.items).toHaveLength(2);expect(page.has_more).toBe(true);
  const next=f.history.search({query:'F19',kind:'result',limit:2,offset:2});expect(next.items.every(e=>!page.items.some(p=>p.id===e.id))).toBe(true);
  expect(f.history.search({project_id:'other'}).total).toBe(0);expect(f.history.search({kind:'result',since:'2026-01-03T00:00:00Z',until:'2026-01-04T00:00:00Z'}).total).toBe(2);
  expect(()=>f.history.search({query:'" OR * ); DROP TABLE evidence; --'})).not.toThrow();expect(()=>f.history.search({limit:51})).toThrow('invalid_history_query');expect(()=>f.history.search({since:'garbage'})).toThrow('invalid_history_query');
  expect(f.history.search({query:'？'}).total).toBe(0);expect(historicalExcerpt('a'.repeat(2000)+'OOM 真实失败原因','OOM',100)).toContain('OOM');
 }finally{f.db.close();}
});
test('backfill indexes accepted revisions, legacy summaries and decisions once without changing canonical memory',()=>{
 const f=store();try{
  const x=f.save('旧实验因显存不足失败。',1),note=JSON.stringify(x.note),facts={current_task:null,latest_results:[x.fact],open_questions:[]};
  f.db.query('INSERT INTO session_memory_history VALUES(?,?,?)').run(x.note.session_id,1,JSON.stringify({facts,note:x.note}));
  f.db.query('INSERT INTO sources VALUES(?,?,?,?,?,?)').run(x.note.session_id,x.note.project_id,x.note.title,'{"offset":100}',note,'2026-01-02T00:00:00Z');
  f.db.query('INSERT INTO assistant_change_topics VALUES(?,?,?,?,?,?,?)').run('fixture-topic',x.note.project_id,'choice','decision','选择 F19 作为对照方案。',JSON.stringify([x.id]),'2026-01-02T00:00:00Z');
  f.history.backfill();const count=f.history.status().events;expect(f.history.search({kind:'decision'}).total).toBe(1);expect(f.history.search({query:'显存不足',kind:'result'}).total).toBe(1);
  new AssistantHistory(f.db).backfill();expect(f.history.status().events).toBe(count);expect(f.db.query<{note:string},[]>('SELECT note FROM sources').get()!.note).toBe(note);
 }finally{f.db.close();}
});
test('missing legacy sources are skipped without losing canonical summaries or preventing startup',()=>{
 const f=store();try{
  const x=f.save('有来源的旧结果',1),broken={...x.note,source_ids:['ref_missing']};
  f.db.query('INSERT INTO session_memory_history VALUES(?,?,?)').run(x.note.session_id,1,JSON.stringify({facts:{},note:broken}));
  f.db.query('INSERT INTO sources VALUES(?,?,?,?,?,?)').run(x.note.session_id,x.note.project_id,x.note.title,'{}',JSON.stringify(x.note),'2026-01-02T00:00:00Z');
  expect(()=>f.history.backfill()).not.toThrow();expect(f.history.search().total).toBe(1);
  expect(f.db.query<{value:string},[]>("SELECT value FROM meta WHERE key='history_events_backfill_skipped'").get()!.value).toBe('1');
  expect(f.db.query<{n:number},[]>('SELECT count(*) AS n FROM session_memory_history').get()!.n).toBe(1);
 }finally{f.db.close();}
});

function appFixture(){
 const dir=mkdtempSync(join(tmpdir(),'ac-historical-')),path=join(dir,'public.jsonl'),mock=new MockState(),session=newSession('codex','synthetic-history','rollout');session.last_activity_at=new Date().toISOString();session.title='合成历史事件';
 const row=(text:string)=>JSON.stringify({type:'response_item',timestamp:new Date().toISOString(),payload:{type:'message',role:'assistant',channel:'final',content:[{type:'output_text',text}]}})+'\n';
 writeFileSync(path,row('F19 实验失败，因为显存不足。'));mkdirSync(join(dir,'secrets'));writeFileSync(join(dir,'secrets/assistant-api-key'),'fixture-history-credential');
 const collector={refresh:()=>mock.refresh(),current:()=>mock.current(),detail:()=>session,sessions:()=>[session],source:()=>({path,project_dir:dir})};
 return {dir,path,collector,session,row,remove:()=>rmSync(dir,{recursive:true,force:true})};
}
function body(options:RequestInit){const req=object(JSON.parse(String(options.body))),message=array(req.messages).map(object).find(m=>m.role==='user')!,content=typeof message.content==='string'?message.content:array(message.content).map(v=>String(object(v).text??'')).join('');return {req,payload:object(JSON.parse(content))};}
function summary(payload:Record<string,unknown>,invalid=false){
 const s=object(array(payload.sessions)[0]),e=object(array(s.messages)[0]),refs=[invalid?'ref_invented':e.id];
 return Response.json({choices:[{message:{content:JSON.stringify({projects:[{project_id:s.project_id,text:'合成实验报告。',source_ids:refs}],attention:[],changes:[{project_id:s.project_id,key:'baseline',kind:'decision',text:'选择 F19 做对照。',source_ids:refs}],sessions:[{session_id:s.session_id,summary:'合成实验尚待复核。',source_ids:refs,memory:{latest_results:[{key:'f19',text:'F19 失败，原因是显存不足。',source_ids:refs,stage:'reported'}]}}]})}}],usage:{prompt_tokens:100,completion_tokens:30}});
}
for(const engine of ['builtin','mastra'] as const)test(engine+' recalls older evidence beyond the recent window with one budgeted request and no event-ID citations',async()=>{
 const f=appFixture();let requests=0,wire='';const make=()=>new Assistant(f.collector,f.dir,async(_url,options)=>{
  requests++;if(requests===1)return summary(body(options).payload);
  wire=JSON.stringify(JSON.parse(String(options.body)));return Response.json({id:'fixture-history-completion',object:'chat.completion',model:'fixture-model',created:1,choices:[{index:0,message:{role:'assistant',content:JSON.stringify({answer:'根据历史来源，F19 当时因显存不足失败。',source_ids:[oldRef]})},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:30,total_tokens:130}});
 },{engines:engine==='mastra'?{chat:new MastraAssistantEngine(f.dir)}:undefined});
 let a=make(),oldRef='';try{
  a.updateConfig({base_url:'https://api.example.org/v1',model:'fixture-model',enabled:true,auto_refresh:false});a.refresh();await a.settled();expect(a.current().status).toBe('ready');
  const found=a.historicalEvents({query:'F19',kind:'result'});expect(found.items).toHaveLength(1);oldRef=found.items[0].source_ids[0];expect(requests).toBe(1);
  await a.shutdown();const db=new Database(join(f.dir,'assistant.sqlite'));
  // Move the original evidence outside both the latest 48 rows and latest summaries.
  db.query('DELETE FROM sources').run();db.query('UPDATE evidence SET timestamp=?').run('2020-01-01T00:00:00.000Z');
  for(let i=0;i<60;i++)db.query('INSERT INTO evidence VALUES(?,?,?,?,?,?,?)').run('ref_recent_'+i,f.session.id,'project_other','其他合成项目','assistant',new Date().toISOString(),'近期无关消息 '+i);
  db.close();a=make();a.ask('F19 上次失败的原因是什么？');await a.settled();
  expect(a.current().last_error).toBeNull();expect(requests).toBe(2);expect(wire).toContain(oldRef);expect(wire).toContain('historical_events');expect(wire).toContain('显存不足');expect(wire).not.toContain('search_tokens');expect(a.messages().at(-1)!.source_ids).toContain(oldRef);
 }finally{await a.shutdown();f.remove();}
},30000);
test('rejected summaries do not enter searchable history; authenticated local search needs no key or model call',async()=>{
 const f=appFixture();let invalid=true,calls=0;const a=new Assistant(f.collector,f.dir,async(_url,options)=>{calls++;return summary(body(options).payload,invalid);});
 const gateway=createLiveGateway(f.collector,'fixture-history-token',0,60000,undefined,a);
 try{
  a.updateConfig({base_url:'https://api.example.org/v1',model:'fixture-model',enabled:true,auto_refresh:false});a.refresh();await a.settled();expect(a.historicalEvents().total).toBe(0);
  invalid=false;a.refresh();await a.settled();expect(a.historicalEvents().total).toBeGreaterThan(0);const count=calls;a.updateConfig({enabled:false});
  const url=new URL('/api/v1/assistant/history?query=F19&kind=result',gateway.server.url),headers={Authorization:'Bearer fixture-history-token'};
  expect((await fetch(url)).status).toBe(401);expect((await fetch(url,{headers:{...headers,Origin:'https://outside.invalid'}})).status).toBe(403);
  const response=await fetch(url,{headers});expect(response.status).toBe(200);const result=object(await response.json()),hit=object(array(result.items)[0]);expect(result.items).toHaveLength(1);
  const detail=await fetch(new URL('/api/v1/assistant/history/'+hit.id,gateway.server.url),{headers});expect(detail.status).toBe(200);expect(object(await detail.json()).source_ids).toHaveLength(1);
  expect((await fetch(new URL('/api/v1/assistant/history?limit=500',gateway.server.url),{headers})).status).toBe(400);
  expect((await assistantResponse(new Request('http://localhost/api/v1/assistant/history?since=invalid'),a)).status).toBe(400);expect(calls).toBe(count);
 }finally{gateway.close();await a.shutdown();f.remove();}
});
