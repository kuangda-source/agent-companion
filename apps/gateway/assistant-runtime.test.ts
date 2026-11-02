import { expect,test } from "bun:test";
import { bindAssistantEngines,builtinAssistantEngine,executeAssistantTask,type AssistantEngine,type AssistantEngineHost,type AssistantTask,type AssistantEvent } from "./src/assistant-runtime.ts";
import { assertAssistantHandoff,type AssistantStateSnapshot } from "./src/assistant-memory-contract.ts";

const task:AssistantTask={
  identity:{assistant_id:"app-assistant",owner_id:"local-owner",conversation_id:"app-conversation"},
  persona:{id:"butler",revision:3,instructions:"合成人格"},operation_id:"app-operation",turn_id:"app-turn",operation:"chat",input_source:"text",
  payload:{question:"合成问题"},response_format:'{"answer":"text","source_ids":[]}',
};
test("one engine owns a chat while briefing can use a different engine",async()=>{
  const calls:string[]=[],letta:AssistantEngine={id:"letta",operations:["chat"],execute:async()=>{calls.push("letta");return{answer:"合成回复",source_ids:[]};}};
  const bindings=bindAssistantEngines({chat:letta});
  expect(bindings.chat.id).toBe("letta");expect(bindings.briefing.id).toBe("builtin");
  const out=await executeAssistantTask(bindings.chat,task,async()=>{throw new Error("no second engine call");},new AbortController().signal);
  expect(out).toEqual({answer:"合成回复",source_ids:[]});expect(calls).toEqual(["letta"]);
  expect(()=>bindAssistantEngines({briefing:letta})).toThrow("unsupported_assistant_operation");
});
test("builtin adapter preserves the existing budgeted completion payload",async()=>{
  let seen:unknown;
  const out=await executeAssistantTask(builtinAssistantEngine,task,async(payload,format,signal)=>{
    seen=payload;expect(format).toBe(task.response_format);expect(signal.aborted).toBe(false);return {answer:"ok",source_ids:[]};
  },new AbortController().signal);
  expect(seen).toBe(task.payload);expect(out).toEqual({answer:"ok",source_ids:[]});
});
test("progress carries canonical turn IDs and drops duplicate and late chunks",async()=>{
  let retained:AssistantEngineHost|undefined;const events:AssistantEvent[]=[];
  const engine:AssistantEngine={id:"mastra",operations:["chat"],execute:async(_,host)=>{
    retained=host;host.emit({type:"text_delta",sequence:0,text:"甲"});host.emit({type:"text_delta",sequence:0,text:"重复"});host.emit({type:"text_delta",sequence:1,text:"乙"});return{answer:"甲乙",source_ids:[]};
  }};
  await executeAssistantTask(engine,task,async()=>null,new AbortController().signal,e=>events.push(e));
  retained!.emit({type:"text_delta",sequence:2,text:"过期"});
  expect(events).toHaveLength(2);expect(events[0].turn_id).toBe(task.turn_id);expect(events[0].conversation_id).toBe(task.identity.conversation_id);
  await expect(retained!.complete({},"json",new AbortController().signal)).rejects.toThrow("assistant_cancelled");
});
test("cancellation settles even if a backend ignores abort and its eventual result is discarded",async()=>{
  const abort=new AbortController();let host:AssistantEngineHost|undefined,release:((value:unknown)=>void)|undefined;let completed=false;
  const engine:AssistantEngine={id:"letta",operations:["chat"],execute:async(_,h)=>{host=h;return new Promise(resolve=>{release=resolve;});}};
  const pending=executeAssistantTask(engine,{...task,input_source:"voice"},async()=>{completed=true;return{};},abort.signal);
  abort.abort();await expect(pending).rejects.toThrow("assistant_cancelled");
  await expect(host!.complete({},"json",abort.signal)).rejects.toThrow("assistant_cancelled");
  release!({answer:"迟到的结果"});expect(completed).toBe(false);
});
test("a synchronous backend failure during abort stays scoped to cancellation",async()=>{
  const controller=new AbortController();
  const engine:AssistantEngine={id:"letta",operations:["chat"],execute(){controller.abort();throw new Error("backend failed synchronously");}};
  await expect(executeAssistantTask(engine,task,async()=>null,controller.signal)).rejects.toThrow("assistant_cancelled");
});
test("a model gateway lease cannot be reused for a different operation",async()=>{
  let closed=false;
  const engine:AssistantEngine={id:"letta",operations:["chat"],execute:async(_,host)=>host.openModelGateway!()};
  await expect(executeAssistantTask(engine,task,async()=>null,new AbortController().signal,undefined,{
    openModelGateway:async()=>({operation_id:"other-turn",base_url:"http://127.0.0.1:1",bearer_token:"fixture-only",expires_at:"2026-11-01T00:00:00.000Z",close:async()=>{closed=true;}}),
  })).rejects.toThrow("assistant_model_scope_mismatch");
  expect(closed).toBe(true);
});
test("a completed turn releases its model gateway credential",async()=>{
  let closed=false;
  const engine:AssistantEngine={id:"mastra",operations:["chat"],execute:async(_,host)=>{await host.openModelGateway!();return{answer:"ok",source_ids:[]};}};
  await executeAssistantTask(engine,task,async()=>null,new AbortController().signal,undefined,{
    openModelGateway:async()=>({operation_id:task.operation_id,base_url:"http://127.0.0.1:1",bearer_token:"fixture-only",expires_at:"2026-11-01T00:00:00.000Z",close:async()=>{closed=true;}}),
  });
  expect(closed).toBe(true);
});
test("handoff fixture keeps application identity and deletion tombstones independent of backend handles",()=>{
  const snapshot:AssistantStateSnapshot={schema_version:1,identity:{...task.identity},persona:{...task.persona},memory_revision:4,
    memories:[{id:"memory-1",kind:"preference",text:"",revision:4,status:"deleted",source:{conversation_id:"app-conversation",message_id:"message-1",timestamp:"2026-11-01T00:00:00.000Z"},updated_at:"2026-11-01T00:01:00.000Z",supersedes:null}],
    history:[],coverage:{history_complete:false,through_message_id:"message-1"},bindings:[{engine:"mastra",agent_handle:"vendor-agent",conversation_handle:"vendor-thread"}],
  };
  const transferred=structuredClone(snapshot);transferred.bindings.push({engine:"letta",agent_handle:"another-agent",conversation_handle:"another-thread"});
  const expected={identity:task.identity,memory_revision:4};
  expect(()=>assertAssistantHandoff(transferred,expected)).not.toThrow();
  expect(()=>assertAssistantHandoff(transferred,{...expected,memory_revision:5})).toThrow("stale_assistant_memory");
  transferred.identity.owner_id="another-owner";expect(()=>assertAssistantHandoff(transferred,expected)).toThrow("assistant_identity_mismatch");
  transferred.identity.owner_id=task.identity.owner_id;transferred.memories[0].text="不应恢复的已删偏好";
  expect(()=>assertAssistantHandoff(transferred,expected)).toThrow("deleted_assistant_memory_has_content");
});
