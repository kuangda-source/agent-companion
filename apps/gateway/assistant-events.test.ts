import {test,expect} from "bun:test";
import {Database} from "bun:sqlite";
import {mkdtempSync,mkdirSync,writeFileSync,appendFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Assistant} from "./src/assistant.ts";
import {AssistantEvents} from "./src/assistant-events.ts";
import {AssistantNotifications,type AttentionUpdate} from "./src/assistant-notifications.ts";
import {newSession,object,array} from "./src/adapters/common.ts";
import {MockState} from "./src/scenarios.ts";

function fixture(){
 const dir=mkdtempSync(join(tmpdir(),"ac-events-")),path=join(dir,"source.jsonl");let now=Date.now(),calls=0,mode="progress";
 const session=newSession("codex","synthetic","fixture");session.title="合成任务";session.last_activity_at=new Date(now).toISOString();session.state="running";
 const row=(text:string)=>JSON.stringify({type:"response_item",timestamp:new Date(now).toISOString(),payload:{type:"message",role:"assistant",channel:"commentary",content:[{type:"text",text}]}})+"\n";
 writeFileSync(path,row("开始整理合成项目"));mkdirSync(join(dir,"secrets"));writeFileSync(join(dir,"secrets/assistant-api-key"),"fixture-event-key");
 const mock=new MockState(),collector={current:()=>mock.current(),refresh:()=>mock.refresh(),detail:()=>session,sessions:()=>[session],source:()=>({path,project_dir:dir})};
 const request=async(_url:string,options:RequestInit)=>{
   calls++;const req=object(JSON.parse(String(options.body))),payload=object(JSON.parse(String(object(array(req.messages)[1]).content))),sessions=array(payload.sessions).map(object);
   const first=sessions[0]!,e=object(array(first.messages).at(-1)),ref=mode==="invalid"?"ref_invented":String(e.id),project_id=String(first.project_id);
   const attention=["open","rephrase","resolved"].includes(mode)?[{project_id,key:"review_request",status:mode==="resolved"?"resolved":"open",text:mode==="rephrase"?"请确认本轮结果，表述有所更新。":mode==="resolved"?"本轮结果已确认，关注事项解除。":"需要用户确认本轮结果。",source_ids:[ref]}]:[];
   const changes=mode==="milestone"?[{project_id,key:"first_milestone",kind:"milestone",text:"合成项目达成第一个里程碑。",source_ids:[ref]}]:[];
   return Response.json({model:"fixture-events",usage:{prompt_tokens:120,completion_tokens:30},choices:[{message:{content:JSON.stringify({projects:[{project_id,text:"合成项目进度更新。",source_ids:[ref]}],attention,changes,sessions:sessions.map(s=>({session_id:s.session_id,summary:"合成项目滚动摘要。",source_ids:[ref]}))})}}]});
 };
 const make=()=>{const a=new Assistant(collector,dir,request,{clock:()=>now});a.updateConfig({base_url:"https://api.example.org/v1",model:"fixture-model",enabled:true,auto_refresh:true});return a;};
 return{dir,collector,session,make,calls:()=>calls,advance:(ms:number)=>{now+=ms;},mode:(s:string)=>{mode=s;},append:(text="普通过程继续")=>{appendFileSync(path,row(text));session.last_activity_at=new Date(now).toISOString();},now:()=>now,remove:()=>rmSync(dir,{recursive:true})};
}
test("source events merge before analysis and ordinary progress updates context without a notification",async()=>{
 const f=fixture(),a=f.make();try{
   await a.tick();expect(f.calls()).toBe(0);expect(a.current().automation.pending_events).toBeGreaterThan(0);
   f.advance(15000);f.append();await a.tick();f.advance(15000);await a.tick();expect(f.calls()).toBe(0);
   f.advance(15000);await a.tick();await a.settled();expect(f.calls()).toBe(1);expect(a.current().status).toBe("ready");expect(a.messages()).toHaveLength(0);
   expect(a.current().briefing).not.toBeNull();expect(a.current().automation.suppressed_batches).toBe(1);
   f.advance(600000);await a.tick();await a.settled();expect(f.calls()).toBe(1);
 }finally{await a.shutdown();f.remove();}
});
test("new attention notifies once, rephrasing stays quiet, and explicit fresh resolution closes it",async()=>{
 const f=fixture(),a=f.make();try{
   f.mode("open");await a.tick();f.advance(30000);await a.tick();await a.settled();expect(a.messages()).toHaveLength(1);expect(a.current().attention_items).toHaveLength(1);
   f.advance(300000);f.mode("rephrase");f.append("仍在等待相同的用户确认");await a.tick();f.advance(30000);await a.tick();await a.settled();
   expect(f.calls()).toBe(2);expect(a.messages()).toHaveLength(1);expect(a.current().attention_items[0]?.text).toContain("表述有所更新");
   f.advance(300000);f.mode("resolved");f.append("用户已经确认，本事项解决");await a.tick();f.advance(30000);await a.tick();await a.settled();
   expect(a.current().attention_items).toHaveLength(0);expect(a.messages()).toHaveLength(2);expect(a.messages().at(-1)?.text).toContain("解除");
 }finally{await a.shutdown();f.remove();}
});
test("pending event batches and notification receipts survive restart without duplicate delivery",async()=>{
 const f=fixture();let a=f.make();try{
   f.mode("milestone");await a.tick();expect(f.calls()).toBe(0);await a.shutdown();
   f.advance(30000);a=f.make();await a.tick();await a.settled();expect(f.calls()).toBe(1);expect(a.messages()).toHaveLength(1);
   const id=a.messages()[0]!.id;await a.shutdown();a=f.make();f.advance(300000);await a.tick();await a.settled();
   expect(a.messages()).toHaveLength(1);expect(a.messages()[0]?.id).toBe(id);expect(f.calls()).toBe(1);
 }finally{await a.shutdown();f.remove();}
});
test("manual refresh bypasses merging, publishes full context, and a later replay stays quiet",async()=>{
 const f=fixture(),a=f.make();try{
   a.refresh();await a.settled();expect(f.calls()).toBe(1);expect(a.messages()[0]?.text).toContain("项目简报");
   f.advance(300000);await a.tick();await a.settled();expect(f.calls()).toBe(1);expect(a.messages()).toHaveLength(1);
 }finally{await a.shutdown();f.remove();}
});
test("invalid references never commit events as successful; explicit refresh retries through the same budget",async()=>{
 const f=fixture(),a=f.make();try{
   f.mode("invalid");await a.tick();f.advance(30000);await a.tick();await a.settled();expect(a.current().last_error).toBe("invalid_source_reference");expect(a.messages()).toHaveLength(0);
   const db=new Database(join(f.dir,"assistant.sqlite"),{readonly:true});expect(db.query<{n:number},[]>("SELECT COUNT(*) n FROM sources").get()?.n).toBe(0);db.close();
   f.mode("milestone");a.refresh();await a.settled();expect(a.current().status).toBe("ready");expect(f.calls()).toBe(2);expect(a.messages()).toHaveLength(1);
 }finally{await a.shutdown();f.remove();}
});
test("confirmed recent state changes get priority, unknown states never invent an urgent event",async()=>{
 const f=fixture(),a=f.make();try{
   a.refresh();await a.settled();f.advance(70000);f.session.state="waiting_user";f.session.status_quality="unknown";f.session.status_observed_at=new Date(f.now()).toISOString();
   await a.tick();expect(a.current().automation.pending_events).toBe(0);
   f.advance(15000);f.session.state="error";f.session.status_quality="confirmed";f.session.status_observed_at=new Date(f.now()).toISOString();await a.tick();expect(a.current().automation.pending_events).toBe(1);
   f.advance(30000);await a.tick();await a.settled();expect(a.current().status).toBe("ready");expect(f.calls()).toBe(2);
 }finally{await a.shutdown();f.remove();}
});
test("stale source evidence cannot resolve an active attention item or create a notification",()=>{
 const db=new Database(":memory:");db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE evidence(id TEXT PRIMARY KEY,project_id TEXT,timestamp TEXT);");
 const n=new AssistantNotifications(db),now=Date.now();const item:AttentionUpdate={key:"review",project_id:"project",status:"open",text:"确认结果",source_ids:["new"],source_at:now};
 try{expect(n.reconcile([item],[],new Set(["new"]),now)).toHaveLength(1);
   expect(n.reconcile([{...item,status:"resolved",source_ids:["old"],source_at:now-2000}],[],new Set(["fresh-other"]),now+1000)).toHaveLength(0);expect(n.list()).toHaveLength(1);
 }finally{db.close();}
});
test("durable local outbox delivers once",()=>{
 const db=new Database(":memory:");db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE sources(id TEXT PRIMARY KEY,cursor TEXT);");const events=new AssistantEvents(db);let deliveries=0;
 try{db.query("INSERT INTO assistant_event_outbox VALUES(?,?,'pending')").run("fixture",JSON.stringify({text:"合成通知",source_ids:[],operation_id:"op",turn_id:"turn"}));
   events.deliver(()=>deliveries++);events.deliver(()=>deliveries++);expect(deliveries).toBe(1);
 }finally{db.close();}
});
test("continuous source updates flush at the maximum merge window",async()=>{
 const f=fixture(),a=f.make();try{
   await a.tick();for(let i=0;i<8;i++){f.advance(15000);f.append("连续合成进度 "+i);await a.tick();await a.settled();}
   expect(f.calls()).toBe(1);expect(a.messages()).toHaveLength(0);expect(a.current().automation.pending_events).toBe(0);
 }finally{await a.shutdown();f.remove();}
});
test("an interrupted read-only assignment recovers into one committed notification",async()=>{
 const f=fixture();let a=f.make();try{
   f.mode("milestone");await a.tick();const db=new Database(join(f.dir,"assistant.sqlite"));
   const coordinator=new AssistantEvents(db,()=>f.now());expect(coordinator.prepare(true)).toHaveLength(1);
   db.close();await a.shutdown();f.advance(30000);a=f.make();await a.tick();await a.settled();
   expect(f.calls()).toBe(1);expect(a.messages()).toHaveLength(1);
   const check=new Database(join(f.dir,"assistant.sqlite"),{readonly:true});
   expect(check.query<{n:number},[]>("SELECT COUNT(*) n FROM assistant_event_jobs WHERE state='interrupted'").get()?.n).toBe(1);
   expect(check.query<{n:number},[]>("SELECT COUNT(*) n FROM assistant_event_outbox WHERE status='sent'").get()?.n).toBe(1);check.close();
 }finally{await a.shutdown();f.remove();}
});
test("event-triggered summaries retain the shared daily model budget",async()=>{
 const f=fixture(),a=f.make();try{
   a.updateConfig({daily_request_limit:1});await a.tick();f.advance(30000);await a.tick();await a.settled();
   f.advance(300000);f.append("新的合成内容");await a.tick();f.advance(30000);await a.tick();await a.settled();
   expect(a.current().last_error).toBe("daily_request_limit");expect(a.current().usage.requests).toBe(1);expect(f.calls()).toBe(1);
 }finally{await a.shutdown();f.remove();}
});
test("a late-arriving resolution is ordered by evidence time rather than summary refresh time",()=>{
 const db=new Database(":memory:");db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE evidence(id TEXT PRIMARY KEY,project_id TEXT,timestamp TEXT);");
 const n=new AssistantNotifications(db),now=Date.now(),item:AttentionUpdate={key:"review",project_id:"project",status:"open",text:"等待确认",source_ids:["first"],source_at:now};
 try{
   n.reconcile([item],[],new Set(["first"]),now+10000);n.reconcile([item],[],new Set(),now+30000);
   const updates=n.reconcile([{...item,status:"resolved",text:"已经确认",source_ids:["resolved"],source_at:now+20000}],[],new Set(["resolved"]),now+40000);
   expect(updates).toHaveLength(1);expect(n.list()).toHaveLength(0);
 }finally{db.close();}
});
test("same-source milestone aliases produce one notification and retain their topic receipts",()=>{
 const db=new Database(":memory:");db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE evidence(id TEXT PRIMARY KEY,project_id TEXT,timestamp TEXT);");
 const n=new AssistantNotifications(db),now=Date.now(),base={project_id:"project",text:"新版已经启动",source_ids:["source"],source_at:now};
 try{
   const updates=n.reconcile([],[{...base,key:"launch",kind:"milestone"},{...base,key:"ready",kind:"completed"}],new Set(["source"]),now);
   expect(updates).toHaveLength(1);expect(n.recentChanges()).toHaveLength(2);
   expect(n.reconcile([],[{...base,key:"third_alias",kind:"milestone"}],new Set(["source"]),now+1000)).toHaveLength(0);
 }finally{db.close();}
});
test("historical material is not introduced as a new active attention item",()=>{
 const db=new Database(":memory:");db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE evidence(id TEXT PRIMARY KEY,project_id TEXT,timestamp TEXT);");const n=new AssistantNotifications(db),now=Date.now();
 try{
   n.reconcile([{project_id:"project",key:"old",status:"open",text:"两天前缺少工具",source_ids:["old"],source_at:now-2*86400000}],[],new Set(["old"]),now);
   expect(n.list()).toHaveLength(0);
 }finally{db.close();}
});
