import { expect,test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync,writeFileSync,appendFileSync,mkdirSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Assistant } from "./src/assistant.ts";
import { cleanPublicMessage,redactSecrets,newSession,object,array } from "./src/adapters/common.ts";
import { readAssistantSource } from "./src/assistant-source.ts";
import { MockState } from "./src/scenarios.ts";
import { createLiveGateway } from "./src/server.ts";
import type { AssistantEngine,AssistantTask } from "./src/assistant-runtime.ts";

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),"ac-assistant-")),path=join(dir,"public.jsonl");
  const session=newSession("codex","native-1","rollout");session.title="原始对话标题";session.last_activity_at=new Date().toISOString();
  const row=(content:string,role="user",channel="final")=>JSON.stringify({type:"response_item",timestamp:new Date().toISOString(),payload:{type:"message",role,channel,content:[{type:"text",text:content}]}})+"\n";
  writeFileSync(path,row("最初的目标：整理项目，不能发布。")+row("内部思维不得外发","assistant","analysis")+Array.from({length:25},(_,i)=>row("进展 "+i,"assistant")).join(""));
  mkdirSync(join(dir,"secrets"));writeFileSync(join(dir,"secrets/assistant-api-key"),"fixture-only-credential");
  const source={path,project_dir:dir};const mock=new MockState();
  const collector={refresh:()=>mock.refresh(),current:()=>mock.current(),detail:()=>session,sessions:()=>[session],source:()=>source};
  return {dir,path,session,row,source,collector,remove:()=>rmSync(dir,{recursive:true})};
}
function completion(payload:Record<string,unknown>,bad=false) {
  const sessions=array(payload.sessions).map(object),first=object(sessions[0]),e=object(array(first.messages)[0]);
  const id=bad?"ref_invented":String(e.id),session_id=String(first.session_id),project_id=String(first.project_id);
  return Response.json({model:"fixture-model",usage:{prompt_tokens:100,completion_tokens:50},choices:[{message:{content:JSON.stringify({projects:[{project_id,text:"已报告进展，尚待验收。",source_ids:[id]}],attention:[{text:"需要确认本轮结果。",source_ids:[id]}],sessions:[{session_id,summary:"仍需验收，不发布。",source_ids:[id]}]})}}]});
}
test("legacy briefing presentation removes fixed headings and trailing boilerplate without changing stored history",async()=>{
  const f=fixture(),a=new Assistant(f.collector,f.dir);const db=new Database(join(f.dir,"assistant.sqlite"));
  try{
    const legacy="项目动态（据公开对话）\n\n• 合成进展：结果需要复核。\n\n详情可在项目简报和来源中核对，Agent报告不代表独立验收。";
    db.query("INSERT INTO messages(id,role,kind,text,created_at,refs) VALUES('legacy','assistant','briefing',?,?,'[]')").run(legacy,new Date().toISOString());
    db.query("INSERT INTO messages(id,role,kind,text,created_at,refs) VALUES('user','user','chat',?,?,'[]')").run(legacy,new Date().toISOString());
    expect(a.messages()[0].text).toBe("• 合成进展：结果需要复核。");expect(a.messages()[1].text).toBe(legacy);
    expect(db.query<{text:string},[]>("SELECT text FROM messages WHERE id='legacy'").get()?.text).toBe(legacy);
  }finally{db.close();await a.shutdown();f.remove();}
});
test("public source includes the original goal beyond UI limits and excludes analysis, internal context and keys",async()=>{
  const f=fixture();try{
    const result=await readAssistantSource(f.session,f.source,null,10000);
    expect(result.evidence.some(e=>e.text.includes("最初的目标"))).toBe(true);
    expect(result.evidence.length).toBeGreaterThan(12);
    expect(result.evidence.some(e=>e.text.includes("内部思维"))).toBe(false);
    const second=await readAssistantSource(f.session,f.source,result.cursor);expect(second.evidence).toHaveLength(0);
    appendFileSync(f.path,f.row("后续修正：现在仅做本机演示。"));
    const next=await readAssistantSource(f.session,f.source,result.cursor);expect(next.evidence).toHaveLength(1);expect(next.evidence[0].text).toContain("后续修正");
    expect(cleanPublicMessage("user","<environment_context>internal</environment_context>")).toBeNull();
    const secret="sk-"+"a".repeat(40);expect(redactSecrets("key "+secret)).not.toContain(secret);
    expect(redactSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(redactSecrets("热点名称 Example 密码 fixture42")).not.toContain("fixture42");
    expect(redactSecrets('{"password":"fixture42"}')).not.toContain("fixture42");
  }finally{f.remove();}
});
test("summary is persisted, unchanged sources do not call the model again, follow-up receives source evidence",async()=>{
  const f=fixture();let calls=0;
  const assistant=new Assistant(f.collector,f.dir,async(_url,options)=>{
    calls++;const request=object(JSON.parse(String(options.body))),payload=object(JSON.parse(String(object(array(request.messages)[1]).content)));
    if(payload.question){const ref=object(array(payload.evidence)[0]).id;return Response.json({choices:[{message:{content:JSON.stringify({answer:`等待验收。[${ref}]`,source_ids:[ref]})}}]});}
    return completion(payload);
  });
  try{
    assistant.updateConfig({base_url:"https://api.example.org/v1",model:"fixture-model",enabled:true});assistant.refresh();await assistant.settled();
    expect(assistant.current().status).toBe("ready");expect(assistant.messages()).toHaveLength(1);expect(calls).toBe(1);
    assistant.refresh();await assistant.settled();expect(calls).toBe(1);
    assistant.ask("目前需要关注什么？");await assistant.settled();expect(assistant.messages()).toHaveLength(3);expect(assistant.messages().at(-1)?.source_ids.length).toBe(1);expect(assistant.messages().at(-1)?.text).toContain("[来源 1]");expect(assistant.messages().at(-1)?.text).not.toContain("ref_");
    assistant.close();const restored=new Assistant(f.collector,f.dir);expect(restored.messages()).toHaveLength(3);restored.close();
  }finally{f.remove();}
});
test("tool-heavy growth catches up to the newest public message within a bounded read",async()=>{
  const f=fixture();try{
    const first=await readAssistantSource(f.session,f.source,null,10000);
    appendFileSync(f.path,JSON.stringify({type:"response_item",payload:{type:"function_call_output",output:"x".repeat(2*1024*1024)}})+"\n"+f.row("最新修正：界面已经接通，不再是待接入。"));
    const next=await readAssistantSource(f.session,f.source,first.cursor);
    expect(next.evidence.some(e=>e.text.includes("最新修正"))).toBe(true);expect(next.partial).toBe(true);
    expect((await readAssistantSource(f.session,f.source,next.cursor)).evidence).toHaveLength(0);
  }finally{f.remove();}
});
test("invented references never commit a summary or advance the read cursor; request limit is enforced",async()=>{
  const f=fixture();let bad=true,calls=0;
  const assistant=new Assistant(f.collector,f.dir,async(_url,options)=>{calls++;const request=object(JSON.parse(String(options.body)));return completion(object(JSON.parse(String(object(array(request.messages)[1]).content))),bad);});
  try{
    assistant.updateConfig({base_url:"https://api.example.org/v1",model:"fixture-model",enabled:true,daily_request_limit:2});assistant.refresh();await assistant.settled();
    expect(assistant.current().last_error).toBe("invalid_source_reference");expect(assistant.messages()).toHaveLength(0);
    bad=false;assistant.refresh();await assistant.settled();expect(assistant.messages()).toHaveLength(1);
    appendFileSync(f.path,f.row("新的决定"));assistant.refresh();await assistant.settled();
    expect(assistant.current().last_error).toBe("daily_request_limit");expect(calls).toBe(2);expect(assistant.messages()).toHaveLength(1);
  }finally{assistant.close();f.remove();}
});
test("assistant endpoints keep authentication, Origin isolation and one request at a time",async()=>{
  const f=fixture(),assistant=new Assistant(f.collector,f.dir,async(_url,options)=>{
    await new Promise(r=>setTimeout(r,20));const request=object(JSON.parse(String(options.body)));return completion(object(JSON.parse(String(object(array(request.messages)[1]).content))));
  });assistant.updateConfig({base_url:"https://api.example.org/v1",model:"fixture-model",enabled:true});
  const gateway=createLiveGateway(f.collector,"test-token",0,60000,undefined,assistant);
  try{
    const url=new URL("/api/v1/assistant/refresh",gateway.server.url),headers={Authorization:"Bearer test-token","Content-Type":"application/json"};
    expect((await fetch(url,{method:"POST",body:"{}"})).status).toBe(401);
    expect((await fetch(url,{method:"POST",body:"{}",headers:{...headers,Origin:"https://outside.invalid"}})).status).toBe(403);
    expect((await fetch(url,{method:"POST",body:"{}",headers})).status).toBe(202);
    expect((await fetch(url,{method:"POST",body:"{}",headers})).status).toBe(409);
    await assistant.settled();
    const value=await (await fetch(new URL("/api/v1/assistant",gateway.server.url),{headers})).json();
    expect(JSON.stringify(value)).not.toContain("fixture-only-credential");
  }finally{gateway.close();f.remove();}
});
test("a busy provider does not crowd a second provider out of the recent-session budget",async()=>{
  const f=fixture(),deep={...f.session,id:"deepseek:fixture",agent_id:"deepseek" as const,last_activity_at:new Date(Date.now()-1000).toISOString()};
  const deepPath=join(f.dir,"deep.jsonl");writeFileSync(deepPath,JSON.stringify({type:"user/message",seq:1,time:new Date().toISOString(),data:{id:"deep-message",content:"第二家也有待处理工作"}})+"\n");
  const many=Array.from({length:8},(_,i)=>({...f.session,id:"codex:fixture:"+i}));
  let seen:string[]=[];
  const collector={...f.collector,sessions:()=>[...many,deep],source:(id:string)=>id===deep.id?{path:deepPath,project_dir:f.dir}:f.source};
  const assistant=new Assistant(collector,f.dir,async(_url,options)=>{
    const req=object(JSON.parse(String(options.body))),payload=object(JSON.parse(String(object(array(req.messages)[1]).content))),sessions=array(payload.sessions).map(object);
    seen=sessions.map(s=>String(s.agent_id));
    const notes=sessions.map(s=>({session_id:s.session_id,summary:"待处理，尚未验收。",source_ids:[object(array(s.messages)[0]).id]}));
    return Response.json({choices:[{message:{content:JSON.stringify({projects:[{project_id:sessions[0].project_id,text:"两家均有工作。",source_ids:notes.flatMap(n=>n.source_ids)}],attention:[],sessions:notes})}}]});
  });
  try{assistant.updateConfig({base_url:"https://api.example.org/v1",model:"fixture-model",enabled:true,max_sessions:3});assistant.refresh();await assistant.settled();expect(assistant.current().status).toBe("ready");expect(seen).toContain("deepseek");expect(seen).toHaveLength(2);expect(assistant.current().coverage).toMatchObject({selected:3,analyzed:2,partial:true});}
  finally{assistant.close();f.remove();}
});
test("attention backed only by old messages is labeled historical rather than a current blocker",async()=>{
  const f=fixture(),older=new Date(Date.now()-2*86400_000).toISOString();
  writeFileSync(f.path,f.row("旧记录：当时缺少工具链").replace(/"timestamp":"[^"]+"/,`"timestamp":"${older}"`));
  const assistant=new Assistant(f.collector,f.dir,async(_url,options)=>{
    const request=object(JSON.parse(String(options.body))),payload=object(JSON.parse(String(object(array(request.messages)[1]).content)));
    expect(typeof payload.current_time).toBe("string");return completion(payload);
  });
  try{assistant.updateConfig({base_url:"https://api.example.org/v1",model:"fixture-model",enabled:true});assistant.refresh();await assistant.settled();expect(assistant.current().status).toBe("ready");expect(assistant.messages()[0].text).toContain("历史待确认（截至");}
  finally{assistant.close();f.remove();}
});
test("runtime injection keeps canonical identity across restarts and preserves the shared budget gate",async()=>{
  const f=fixture();let requests=0,seen:AssistantTask|undefined;
  const engine:AssistantEngine={id:"letta",operations:["chat"],execute:async(task,host)=>{seen=task;return host.complete(task.payload,task.response_format,host.signal);}};
  const assistant=new Assistant(f.collector,f.dir,async(_url,options)=>{
    requests++;const request=object(JSON.parse(String(options.body)));return completion(object(JSON.parse(String(object(array(request.messages)[1]).content))));
  },{engines:{chat:engine}});
  try{
    const identity=assistant.identity();assistant.updateConfig({base_url:"https://api.example.org/v1",model:"fixture-model",enabled:true,daily_request_limit:1});assistant.refresh();await assistant.settled();
    const operation=assistant.ask("合成问题");await assistant.settled();
    expect(seen?.identity).toEqual(identity);expect(seen?.input_source).toBe("text");expect(JSON.stringify(seen)).not.toContain("fixture-only-credential");
    expect(seen?.operation_id).toBe(operation.operation_id);expect(seen?.turn_id).toBe(operation.turn_id);
    expect(requests).toBe(1);expect(assistant.current().last_error).toBe("daily_request_limit");
    const db=new Database(join(f.dir,"assistant.sqlite"),{readonly:true});
    const stored=db.query<{conversation_id:string;turn_id:string;operation_id:string},[]>("SELECT conversation_id,turn_id,operation_id FROM messages WHERE role='user' ORDER BY seq DESC LIMIT 1").get()!;
    expect(stored.conversation_id).toBe(identity.conversation_id);expect(stored.turn_id).toBe(operation.turn_id);expect(stored.operation_id).toBe(operation.operation_id);
    expect(db.query<{operation_id:string},[]>("SELECT operation_id FROM calls LIMIT 1").get()?.operation_id).toBeTruthy();db.close();
    assistant.close();const restored=new Assistant(f.collector,f.dir);expect(restored.identity()).toEqual(identity);restored.close();
  }finally{f.remove();}
});
test("cancelled engine results never append a late answer and the next turn can proceed",async()=>{
  const f=fixture();let release:((value:unknown)=>void)|undefined,count=0;
  const engine:AssistantEngine={id:"mastra",operations:["chat"],execute:async()=>{count++;return count===1?new Promise(resolve=>{release=resolve;}):{answer:"新的合成回答",source_ids:[]};}};
  const assistant=new Assistant(f.collector,f.dir,async()=>{throw new Error("unexpected model call");},{engines:{chat:engine}});
  try{
    assistant.updateConfig({base_url:"https://api.example.org/v1",model:"fixture-model",enabled:true});const first=assistant.ask("第一轮");expect(assistant.cancel(first.operation_id)).toBe(true);await assistant.settled();
    expect(assistant.current().last_error).toBe("assistant_cancelled");expect(assistant.messages()).toHaveLength(1);
    const second=assistant.ask("第二轮");expect(second.turn_id).not.toBe(first.turn_id);expect(assistant.cancel(first.operation_id)).toBe(false);
    await assistant.settled();release!({answer:"迟到的旧回答",source_ids:[]});await Promise.resolve();
    expect(assistant.current().status).toBe("ready");expect(assistant.messages()).toHaveLength(3);expect(assistant.messages().at(-1)?.text).toBe("新的合成回答");expect(assistant.cancel()).toBe(false);
  }finally{assistant.close();f.remove();}
});
test("legacy assistant databases preserve messages and add canonical correlation without inventing old turn IDs",()=>{
  const f=fixture();const path=join(f.dir,"assistant.sqlite"),old=new Database(path);
  old.exec(`CREATE TABLE messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,created_at TEXT NOT NULL,refs TEXT NOT NULL);
    CREATE TABLE calls(id INTEGER PRIMARY KEY,created_at TEXT NOT NULL,requested_model TEXT NOT NULL,returned_model TEXT,status TEXT NOT NULL,input_tokens INTEGER,output_tokens INTEGER);
    INSERT INTO messages(id,role,kind,text,created_at,refs) VALUES('old-message','user','chat','原有消息','2026-11-01T00:00:00.000Z','[]');`);old.close();
  const assistant=new Assistant(f.collector,f.dir),db=new Database(path,{readonly:true});
  try{
    const row=db.query<{conversation_id:string;turn_id:string|null;operation_id:string|null},[]>("SELECT conversation_id,turn_id,operation_id FROM messages").get()!;
    expect(assistant.messages()[0].text).toBe("原有消息");expect(row.conversation_id).toBe(assistant.identity().conversation_id);expect(row.turn_id).toBeNull();expect(row.operation_id).toBeNull();
    expect(db.query<{name:string},[]>("PRAGMA table_info(calls)").all().some(r=>r.name==="operation_id")).toBe(true);
  }finally{db.close();assistant.close();f.remove();}
});

test('a changed conversation updates only its own model context and retains other session memories',async()=>{
 const f=fixture(),other={...f.session,id:'codex:other',provider_session_id:'other',title:'second fixture'},path=join(f.dir,'other.jsonl');writeFileSync(path,f.row('另一个会话的目标'));
 const collector={...f.collector,sessions:()=>[f.session,other],source:(id:string)=>id===other.id?{path,project_dir:f.dir}:f.source};const seen:string[][]=[];
 const assistant=new Assistant(collector,f.dir,async(_url,options)=>{
  const request=object(JSON.parse(String(options.body))),payload=object(JSON.parse(String(object(array(request.messages)[1]).content))),sessions=array(payload.sessions).map(object);seen.push(sessions.map(s=>String(s.session_id)));
  const project=String(sessions[0].project_id),refs=sessions.map(s=>String(object(array(s.messages)[0]).id));
  return Response.json({choices:[{message:{content:JSON.stringify({projects:[{project_id:project,text:'fixture progress',source_ids:[refs[0]]}],attention:[],changes:[],sessions:sessions.map((s,i)=>({session_id:s.session_id,summary:'fixture summary',source_ids:[refs[i]],memory:{current_task:{key:'goal',text:'fixture goal',source_ids:[refs[i]],stage:'reported'},latest_results:[],open_questions:[]}}))})}}]});
 });
 try{assistant.updateConfig({enabled:true,base_url:'https://fixture.example/v1',model:'fixture-model'});assistant.refresh();await assistant.settled();expect(assistant.current().status).toBe('ready');
 appendFileSync(f.path,f.row('新结果，仅第一个会话变化。'));assistant.refresh();await assistant.settled();expect(seen[1]).toEqual([f.session.id]);expect(assistant.current().briefing?.sessions).toHaveLength(2);expect(assistant.sessionFacts(other.id).current_task?.text).toBe('fixture goal');
 }finally{assistant.close();f.remove();}
});

test('a temporarily unavailable voice queue does not undo accepted memory and retries from its durable outbox',async()=>{
 const f=fixture();let attempts=0;const assistant=new Assistant(f.collector,f.dir,async(_url,options)=>{const request=object(JSON.parse(String(options.body)));return completion(object(JSON.parse(String(object(array(request.messages)[1]).content))));});
 try{assistant.onImportantChange=()=>{attempts++;if(attempts===1)throw new Error('fixture queue offline');};assistant.updateConfig({enabled:true,base_url:'https://fixture.example/v1',model:'fixture-model'});assistant.refresh();await assistant.settled();expect(assistant.current().status).toBe('ready');expect(assistant.messages()).toHaveLength(1);expect(attempts).toBe(1);await assistant.tick();expect(attempts).toBe(2);expect(assistant.current().usage.requests).toBe(1);
 }finally{assistant.close();f.remove();}
});

test('backlog continues in bounded fair batches without new source messages',async()=>{
 const f=fixture();let now=Date.now();const sessions=Array.from({length:4},(_,i)=>({...f.session,id:'codex:batch:'+i,provider_session_id:'batch-'+i})),seen:string[][]=[];
 const collector={...f.collector,sessions:()=>sessions};
 const assistant=new Assistant(collector,f.dir,async(_url,options)=>{
  const body=object(JSON.parse(String(options.body))),payload=object(JSON.parse(String(object(array(body.messages)[1]).content))),items=array(payload.sessions).map(object);seen.push(items.map(s=>String(s.session_id)));
  return Response.json({choices:[{message:{content:JSON.stringify({projects:[{project_id:items[0].project_id,text:'fixture batch',source_ids:[object(array(items[0].messages)[0]).id]}],attention:[],changes:[],sessions:items.map(s=>({session_id:s.session_id,summary:'fixture summary',source_ids:[object(array(s.messages)[0]).id]}))})}}]});
 },{clock:()=>now});
 try{assistant.updateConfig({enabled:true,base_url:'https://fixture.example/v1',model:'fixture-model'});assistant.refresh();await assistant.settled();expect(seen[0]).toHaveLength(2);expect(assistant.current().coverage).toMatchObject({analyzed:2,partial:true});
 now+=61000;await assistant.tick();await assistant.settled();expect(seen[1]).toHaveLength(2);expect(seen[1].some(id=>seen[0].includes(id))).toBe(false);expect(assistant.current().briefing?.sessions).toHaveLength(4);expect(assistant.current().automation.incremental_memory?.pending).toBe(0);
 }finally{assistant.close();f.remove();}
});

test('missing one note preserves its pending increment while valid notes commit and repeated topics collapse',async()=>{
 const f=fixture(),sessions=[f.session,{...f.session,id:'codex:partial-other',provider_session_id:'partial-other'}];let call=0;
 const assistant=new Assistant({...f.collector,sessions:()=>sessions},f.dir,async(_url,options)=>{
  call++;const body=object(JSON.parse(String(options.body))),payload=object(JSON.parse(String(object(array(body.messages)[1]).content))),items=array(payload.sessions).map(object),first=items[0],ref=object(array(first.messages)[0]).id;
  const change={project_id:first.project_id,key:'same_topic',kind:'milestone',text:'fixture milestone',source_ids:[ref]};
  return Response.json({choices:[{message:{content:JSON.stringify({projects:[{project_id:first.project_id,text:'fixture summary',source_ids:[ref]}],attention:[],changes:[change,change],sessions:[{session_id:first.session_id,summary:'accepted one',source_ids:[ref]}]})}}]});
 });
 try{assistant.updateConfig({enabled:true,base_url:'https://fixture.example/v1',model:'fixture-model'});assistant.refresh();await assistant.settled();expect(assistant.current().status).toBe('ready');expect(assistant.current().briefing?.sessions).toHaveLength(1);expect(assistant.current().automation.incremental_memory!.pending).toBeGreaterThan(0);
 assistant.refresh();await assistant.settled();expect(assistant.current().status).toBe('ready');expect(assistant.current().briefing?.sessions).toHaveLength(2);expect(assistant.current().automation.incremental_memory?.pending).toBe(0);expect(call).toBe(2);
 }finally{assistant.close();f.remove();}
});

test('incremental model context excludes unrelated projects while retaining unchanged sessions of the same project',async()=>{
 const f=fixture(),b={...f.session,id:'codex:related',provider_session_id:'related'},c={...f.session,id:'codex:unrelated',provider_session_id:'unrelated'},pb=join(f.dir,'related.jsonl'),pc=join(f.dir,'unrelated.jsonl');writeFileSync(pb,f.row('related fixture goal'));writeFileSync(pc,f.row('unrelated fixture goal'));let last:Record<string,unknown>={};
 const collector={...f.collector,sessions:()=>[f.session,b,c],source:(id:string)=>id===b.id?{path:pb,project_dir:f.dir}:id===c.id?{path:pc,project_dir:join(f.dir,'another-project')}:f.source};
 const assistant=new Assistant(collector,f.dir,async(_url,options)=>{
  const body=object(JSON.parse(String(options.body))),payload=object(JSON.parse(String(object(array(body.messages)[1]).content)));last=payload;const items=array(payload.sessions).map(object),projects=new Map<string,Record<string,unknown>>();
  for(const s of items)projects.set(String(s.project_id),{project_id:s.project_id,text:'fixture project',source_ids:[object(array(s.messages)[0]).id]});
  return Response.json({choices:[{message:{content:JSON.stringify({projects:[...projects.values()],attention:[],changes:[],sessions:items.map(s=>({session_id:s.session_id,summary:'fixture summary',source_ids:[object(array(s.messages)[0]).id]}))})}}]});
 });
 try{assistant.updateConfig({enabled:true,base_url:'https://fixture.example/v1',model:'fixture-model',max_sessions:3});assistant.refresh();await assistant.settled();assistant.refresh();await assistant.settled();appendFileSync(f.path,f.row('new result only in first project'));assistant.refresh();await assistant.settled();expect(assistant.current().status).toBe('ready');expect(array(last.unchanged_session_summaries).map(v=>object(v).session_id)).toEqual([b.id]);expect(array(last.sessions).map(v=>object(v).session_id)).toEqual([f.session.id]);
 }finally{assistant.close();f.remove();}
});

test('an empty recent conversation does not starve a readable session in a single-session Qwen batch',async()=>{
 const f=fixture(),empty={...f.session,id:'codex:empty',provider_session_id:'empty',title:'empty fixture'},emptyPath=join(f.dir,'empty.jsonl');writeFileSync(emptyPath,'');let calls=0;
 const collector={...f.collector,sessions:()=>[empty,f.session],source:(id:string)=>id===empty.id?{path:emptyPath,project_dir:f.dir}:f.source};
 const assistant=new Assistant(collector,f.dir,async(_url,options)=>{calls++;const request=object(JSON.parse(String(options.body))),payload=object(JSON.parse(String(object(array(request.messages)[1]).content)));expect(array(payload.sessions).map(v=>object(v).session_id)).toEqual([f.session.id]);return completion(payload);});
 try{assistant.updateConfig({enabled:true,base_url:'https://dashscope.aliyuncs.com/compatible-mode/v1',model:'qwen3.8-flash'});assistant.refresh();await assistant.settled();expect(assistant.current().status).toBe('ready');expect(calls).toBe(1);expect(assistant.current().coverage).toMatchObject({selected:2,read:1,unavailable:1,analyzed:1,partial:true});
 }finally{assistant.close();f.remove();}
});
