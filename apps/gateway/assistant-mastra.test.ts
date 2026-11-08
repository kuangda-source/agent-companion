import { expect,test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync,mkdirSync,writeFileSync,rmSync,statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Assistant,assistantResponse } from "./src/assistant.ts";
import { MastraAssistantEngine } from "./src/assistant-mastra.ts";
import { AssistantModelGateway } from "./src/assistant-model-gateway.ts";
import { MockState } from "./src/scenarios.ts";
import { object,array,newSession } from "./src/adapters/common.ts";
import type { AssistantTask } from "./src/assistant-runtime.ts";
import { createLiveGateway } from "./src/server.ts";

function fixture(){
  const dir=mkdtempSync(join(tmpdir(),"ac-mastra-")),mock=new MockState();
  mkdirSync(join(dir,"secrets"));writeFileSync(join(dir,"secrets/assistant-api-key"),"fixture-credential-mastra");
  const collector={refresh:()=>mock.refresh(),current:()=>mock.current(),detail:()=>undefined,sessions:()=>[],source:()=>undefined};
  return{dir,collector,remove:()=>rmSync(dir,{recursive:true})};
}
function response(answer:string,refs:string[]=[]) {return Response.json({id:"fixture-completion",object:"chat.completion",model:"fixture-returned-model",created:1,choices:[{index:0,message:{role:"assistant",content:JSON.stringify({answer,source_ids:refs})},finish_reason:"stop"}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}});}
test("Mastra preserves safe provider outage diagnosis and recovery without SDK retrying",async()=>{
  const f=fixture();let calls=0;
  const assistant=new Assistant(f.collector,f.dir,async()=>{calls++;return Response.json({error:{message:"No available accounts: private-provider-detail"}},{status:503});},{engines:{chat:new MastraAssistantEngine(f.dir)}});
  try{
    assistant.updateConfig({base_url:"https://api.example.org/v1",model:"fixture-model",enabled:true});assistant.ask("合成连通性问题");await assistant.settled();
    expect(calls).toBe(1);expect(assistant.current().last_error).toBe("provider_no_accounts");expect(assistant.current().recovery.consecutive_failures).toBe(1);
    expect(assistant.current().usage.requests).toBe(1);expect(assistant.messages()).toHaveLength(1);expect(JSON.stringify(assistant.current())).not.toContain("private-provider-detail");
  }finally{await assistant.shutdown();f.remove();}
});
test("real Mastra SDK assembles confirmed preferences and accepted history, survives restart, and forgets deleted context",async()=>{
  const f=fixture(),requests:Record<string,unknown>[]=[];
  const make=()=>new Assistant(f.collector,f.dir,async(_url,options)=>{const body=object(JSON.parse(String(options.body)));requests.push(body);return response("合成回复");},{engines:{chat:new MastraAssistantEngine(f.dir)}});
  let assistant=make();
  try {
    assistant.updateConfig({base_url:"https://api.example.org/v1",model:"fixture-model",enabled:true,auto_refresh:false});assistant.setPersona("语气自然，回答干脆。");
    const pref=assistant.remember("合成偏好：叫我青松。");
    assistant.ask("第一轮合成问题");await assistant.settled();
    expect(assistant.current().last_error).toBeNull();expect(requests).toHaveLength(1);
    const first=JSON.stringify(requests[0]);expect(first).toContain("叫我青松");expect(first).toContain("回答干脆");
    expect(first.split("第一轮合成问题")).toHaveLength(2);expect(first).not.toContain("fixture-credential-mastra");
    expect(requests[0]?.model).toBe("fixture-model");expect(requests[0]?.stream).toBe(false);
    expect(array(requests[0]?.tools)).toHaveLength(0);
    await assistant.shutdown();assistant=make();
    expect(assistant.memory().items).toHaveLength(1);expect(assistant.messages()).toHaveLength(2);
    assistant.ask("第二轮合成问题");await assistant.settled();
    expect(assistant.current().status).toBe("ready");expect(JSON.stringify(requests[1])).toContain("第一轮合成问题");expect(JSON.stringify(requests[1])).toContain("合成回复");
    assistant.forget(pref.id);assistant.ask("第三轮合成问题");await assistant.settled();
    expect(assistant.current().status).toBe("ready");expect(JSON.stringify(requests[2])).not.toContain("青松");expect(JSON.stringify(requests[2])).not.toContain("第一轮合成问题");
    expect(assistant.memory().items).toHaveLength(0);expect(assistant.current().usage.requests).toBe(3);
    const db=new Database(join(f.dir,"assistant.sqlite"),{readonly:true});
    const calls=db.query<{operation_id:string},[]>("SELECT operation_id FROM calls").all();expect(new Set(calls.map(c=>c.operation_id)).size).toBe(3);db.close();
    expect(statSync(join(f.dir,"mastra-memory.sqlite")).mode&0o777).toBe(0o600);
    const mirror=new Database(join(f.dir,"mastra-memory.sqlite"),{readonly:true});
    expect(mirror.query<{n:number},[]>("SELECT COUNT(*) AS n FROM mastra_messages").get()?.n).toBe(0);mirror.close();
  }finally{await assistant.shutdown();f.remove();}
},30000);
test("Mastra calls share the application budget and invalid outputs never become accepted assistant history",async()=>{
  const f=fixture();let calls=0;
  const assistant=new Assistant(f.collector,f.dir,async()=>{calls++;return response("不能接受的合成回答",["ref_invented"]);},{engines:{chat:new MastraAssistantEngine(f.dir)}});
  try {
    assistant.updateConfig({base_url:"https://api.example.org/v1",model:"fixture-model",enabled:true,daily_request_limit:1});assistant.ask("第一轮");await assistant.settled();
    expect(assistant.current().last_error).toBe("invalid_source_reference");expect(assistant.messages()).toHaveLength(1);
    assistant.ask("下一轮");await assistant.settled();
    expect(assistant.current().last_error).toBe("daily_request_limit");expect(calls).toBe(1);
    expect(assistant.messages().every(m=>m.role==="user")).toBe(true);
  }finally{await assistant.shutdown();f.remove();}
},30000);
test("private SDK gateway locks the model, rejects tool/Origin requests and expires a completed lease",async()=>{
  let calls=0;const gateway=new AssistantModelGateway(async()=>{calls++;return object(await response("fixture").json());});
  const task:AssistantTask={identity:{assistant_id:"a",owner_id:"o",conversation_id:"c"},persona:{id:"p",revision:1,instructions:"p"},operation_id:"op",turn_id:"t",operation:"chat",input_source:"text",payload:{},response_format:"{}",model:{id:"fixture-model"}};
  const lease=gateway.open(task,new AbortController().signal),url=lease.base_url+"/chat/completions";
  const headers={Authorization:"Bearer "+lease.bearer_token,"Content-Type":"application/json"};
  const send=(body:unknown,extra={})=>fetch(url,{method:"POST",headers:{...headers,...extra},body:JSON.stringify(body)});
  try{
    expect((await send({model:"wrong",messages:[]})).status).toBe(400);
    expect((await send({model:"fixture-model",messages:[],tools:[{}]})).status).toBe(400);
    expect((await send({model:"fixture-model",messages:[]},{Origin:"https://untrusted.example"})).status).toBe(403);
    expect(calls).toBe(0);expect((await send({model:"fixture-model",messages:[]})).status).toBe(200);expect(calls).toBe(1);
    await lease.close();expect((await send({model:"fixture-model",messages:[]})).status).toBe(401);
  }finally{gateway.close();}
});
test("memory API validates explicit edits and persists persona without using model calls",async()=>{
  const f=fixture(),assistant=new Assistant(f.collector,f.dir,async()=>{throw new Error("unexpected_call");});
  const edit=(path:string,body:unknown,method="POST")=>assistantResponse(new Request("http://localhost/api/v1/assistant/"+path,{method,headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}),assistant);
  try {
    expect((await edit("memory",{text:"请用中文。"})).status).toBe(200);expect(assistant.memory().items).toHaveLength(1);
    expect((await edit("memory",{text:"sk-"+"a".repeat(32)})).status).toBe(400);
    expect((await edit("persona",{instructions:"自然，简短。"},"PATCH")).status).toBe(200);
    const id=assistant.memory().items[0]!.id;expect((await edit("memory",{id},"DELETE")).status).toBe(200);
    expect(assistant.memory().items).toHaveLength(0);expect(assistant.current().usage.requests).toBe(0);
  }finally{await assistant.shutdown();f.remove();}
});
test("Mastra provider cancellation settles the operation and cannot write a late assistant response",async()=>{
  const f=fixture();let started:()=>void=()=>{};const ready=new Promise<void>(resolve=>{started=resolve;});let calls=0;
  const assistant=new Assistant(f.collector,f.dir,async(_url,options)=>{
    calls++;if(calls>1)return response("下一轮合成回复");started();
    return new Promise<Response>((_resolve,reject)=>{options.signal?.addEventListener("abort",()=>reject(new Error("fixture_aborted")),{once:true});});
  },{engines:{chat:new MastraAssistantEngine(f.dir)}});
  try {
    assistant.updateConfig({base_url:"https://api.example.org/v1",model:"fixture-model",enabled:true});const operation=assistant.ask("取消这一轮合成问题");await ready;
    expect(assistant.cancel(operation.operation_id)).toBe(true);await assistant.settled();
    expect(assistant.current().last_error).toBe("assistant_cancelled");expect(assistant.messages()).toHaveLength(1);
    assistant.ask("继续下一轮");await assistant.settled();expect(assistant.current().status).toBe("ready");expect(assistant.messages().at(-1)?.text).toBe("下一轮合成回复");expect(calls).toBe(2);
  }finally{await assistant.shutdown();f.remove();}
},30000);
test("memory routes inherit the real Gateway token and Origin boundary",async()=>{
  const f=fixture(),assistant=new Assistant(f.collector,f.dir),gateway=createLiveGateway(f.collector,"fixture-local-token",0,60000,undefined,assistant);
  try{
    const url=new URL("/api/v1/assistant/memory",gateway.server.url),headers={Authorization:"Bearer fixture-local-token","Content-Type":"application/json"};
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url,{headers:{...headers,Origin:"https://untrusted.example"}})).status).toBe(403);
    expect((await fetch(url,{method:"POST",headers,body:JSON.stringify({text:"合成偏好"})})).status).toBe(200);
    const id=assistant.memory().items[0]!.id;expect((await fetch(url,{method:"DELETE",headers,body:JSON.stringify({id})})).status).toBe(200);
    expect(assistant.memory().items).toHaveLength(0);
  }finally{gateway.close();await assistant.shutdown();f.remove();}
});
test("Mastra retains history beyond six messages while project evidence remains transient context",async()=>{
  const f=fixture(),requests:Record<string,unknown>[]=[];
  const assistant=new Assistant(f.collector,f.dir,async(_url,options)=>{requests.push(object(JSON.parse(String(options.body))));return response("已读取合成项目证据",["ref_"+"a".repeat(24)]);},{engines:{chat:new MastraAssistantEngine(f.dir)}});
  try{
    assistant.updateConfig({base_url:"https://api.example.org/v1",model:"fixture-model",enabled:true});
    const db=new Database(join(f.dir,"assistant.sqlite"));
    for(let n=0;n<20;n++)db.query("INSERT INTO messages(id,role,kind,text,created_at,refs,conversation_id) VALUES(?,?,'chat',?,?, '[]',?)").run("fixture-history-"+n,n%2?"assistant":"user","第"+n+"条较早的合成历史",new Date(Date.now()-30000+n*1000).toISOString(),assistant.identity().conversation_id);
    db.query("INSERT INTO evidence VALUES(?,?,?,?,?,?,?)").run("ref_"+"a".repeat(24),"session","project","合成项目","user",new Date().toISOString(),"只应出现在临时项目上下文的证据-ONLY-PROJECT-892");db.close();
    assistant.ask("基于给出的证据回答");await assistant.settled();expect(assistant.current().status).toBe("ready");
    const body=JSON.stringify(requests[0]);expect(body).toContain("第0条较早的合成历史");expect(body).toContain("ONLY-PROJECT-892");
    const mirror=new Database(join(f.dir,"mastra-memory.sqlite"),{readonly:true});
    const messages=mirror.query("SELECT * FROM mastra_messages").all();expect(messages).toHaveLength(20);
    expect(JSON.stringify(messages)).not.toContain("ONLY-PROJECT-892");expect(JSON.stringify(messages)).not.toContain("已读取合成项目证据");mirror.close();
  }finally{await assistant.shutdown();f.remove();}
});
test("Mastra briefing uses one budgeted model request and never injects personal memory",async()=>{
  const f=fixture(),path=join(f.dir,"project.jsonl"),session=newSession("codex","synthetic-project","fixture");session.last_activity_at=new Date().toISOString();
  writeFileSync(path,JSON.stringify({type:"response_item",timestamp:new Date().toISOString(),payload:{type:"message",role:"user",content:[{type:"text",text:"合成项目：规划数据导出。"}]}})+"\n");
  const collector={...f.collector,detail:()=>session,sessions:()=>[session],source:()=>({path,project_dir:f.dir})},engine=new MastraAssistantEngine(f.dir);let wire="";
  const assistant=new Assistant(collector,f.dir,async(_url,options)=>{
    const request=object(JSON.parse(String(options.body)));wire=JSON.stringify(request);const message=array(request.messages).map(object).find(m=>m.role==="user")!;
    const content=typeof message.content==="string"?message.content:array(message.content).map(v=>String(object(v).text??"")).join("");
    const payload=object(JSON.parse(content)),input=object(array(payload.sessions)[0]),e=object(array(input.messages)[0]);
    return Response.json({model:"fixture",usage:{prompt_tokens:20,completion_tokens:10},choices:[{message:{role:"assistant",content:JSON.stringify({projects:[{project_id:input.project_id,text:"合成规划。",source_ids:[e.id]}],attention:[],changes:[],sessions:[{session_id:input.session_id,summary:"合成规划。",source_ids:[e.id]}]})}}]});
  },{engines:{chat:engine,briefing:engine}});
  try{
    assistant.updateConfig({base_url:"https://api.example.org/v1",model:"fixture-model",enabled:true});assistant.remember("此个人偏好不得进入项目整理上下文-PRIVATE-294");assistant.refresh();await assistant.settled();
    expect(assistant.current().status).toBe("ready");expect(assistant.current().runtime.briefing_engine).toBe("mastra");expect(assistant.current().usage.requests).toBe(1);
    expect(wire).not.toContain("PRIVATE-294");expect(assistant.messages()).toHaveLength(1);
  }finally{await assistant.shutdown();f.remove();}
});
