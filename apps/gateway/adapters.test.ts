import { expect, test } from "bun:test";
import { CodexAdapter, initCodex, reduceCodex } from "./src/adapters/codex.ts";
import { Database } from "bun:sqlite";
import { initClaude, reduceClaude } from "./src/adapters/claude.ts";
import { reduceDeepSeek, type DshJournal } from "./src/adapters/deepseek.ts";
import { addMessage, iso, JsonlReader, newSession, ratio, rows } from "./src/adapters/common.ts";
import { mkdtemp, rm, appendFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarize } from "./src/state.ts";

test("agent pet uses the latest unknown/offline observation rather than an older completion", () => {
  const old=newSession("codex","old","test"), latest=newSession("codex","new","test");
  old.state="completed"; old.status_quality="confirmed"; old.last_activity_at="2026-10-30T07:00:00Z";
  latest.state="unknown"; latest.last_activity_at="2026-10-30T08:00:00Z";
  expect(summarize("codex",[old,latest],2,"2026-10-30T08:00:00Z").state).toBe("unknown");
  latest.state="disconnected"; latest.status_quality="confirmed";
  expect(summarize("codex",[old,latest],2,"2026-10-30T08:00:00Z").state).toBe("disconnected");
  old.state="running";
  expect(summarize("codex",[old,latest],2,"2026-10-30T08:00:00Z").state).toBe("running");
  old.observation_health="stale";
  expect(summarize("codex",[old,latest],2,"2026-10-30T08:00:00Z").state).toBe("disconnected");
});

test("Codex lifecycle does not infer runtime from a log write; counters include cache and timestamps accept seconds", () => {
  const j=initCodex();
  reduceCodex(j,{type:"event_msg",timestamp:"2026-10-30T07:00:00Z",payload:{type:"task_started",turn_id:"turn-1",started_at:1793343600}});
  expect(j.session.state).toBe("unknown"); expect(j.openTurn).toBe("turn-1");
  expect(j.session.started_at).toBe("2026-10-30T07:00:00.000Z");
  reduceCodex(j,{type:"event_msg",timestamp:"2026-10-30T07:00:01Z",payload:{type:"token_count",info:{total_token_usage:{input_tokens:10000,cached_input_tokens:6000,output_tokens:700},last_token_usage:{input_tokens:2000},model_context_window:10000}}});
  expect(j.session.state).toBe("unknown");
  expect(j.session.usage.input_tokens.value).toBe(10000); expect(j.session.usage.cache_ratio.value).toBe(0.6);
  expect(j.session.usage.context_ratio).toMatchObject({value:0.2,quality:"estimated"});
  expect(j.session.usage.cache_write_tokens.value).toBeNull();
  reduceCodex(j,{type:"event_msg",timestamp:"2026-10-30T07:00:02Z",payload:{type:"task_complete",turn_id:"turn-1",duration_ms:2000}});
  expect(j.session.state).toBe("completed"); expect(j.openTurn).toBeNull(); expect(j.session.completion_event_id).toHaveLength(36);
});

test("public-message boundary excludes reasoning, developer, tools and environment metadata", () => {
  const s=newSession("codex","test","test");
  addMessage(s,"developer","private instruction","d",null);
  addMessage(s,"assistant",[{type:"reasoning",text:"private thought"},{type:"tool_call",text:"secret"},{type:"text",text:"public reply"}],"a",null);
  addMessage(s,"user","<environment_context>local settings</environment_context>","e",null);
  expect(s.messages.map(m=>m.text)).toEqual(["public reply"]);
  addMessage(s,"assistant",[{type:"text",text:"updated public reply"}],"a",null);
  expect(s.messages).toHaveLength(1); expect(s.messages[0].text).toBe("updated public reply");
  addMessage(s,"user",'<send_user_message_question_reply>[{"questionItemId":"internal-id","question":"接哪类会话？","answer":"仍只接 Code"}]</send_user_message_question_reply>',"reply",null);
  expect(s.messages.at(-1)?.text).toBe("问题：接哪类会话？\n回答：仍只接 Code");
  addMessage(s,"user",'<codex_internal_context source="goal">continuation metadata</codex_internal_context>',"goal",null);
  expect(s.messages).toHaveLength(2);
});

test("DeepSeek explicit turn completion and public parts survive zstd-shaped records", () => {
  const j:DshJournal={session:newSession("deepseek","one","harness-v4"),openTurn:null,terminal:false};
  reduceDeepSeek(j,{type:"turn/start",time:1793343600000,data:{turn:4}});
  reduceDeepSeek(j,{type:"assistant/message",seq:5,time:1793343601000,data:{message:{id:"a",content:[{type:"reasoning",text:"hidden"},{type:"text",text:"visible"}]}}});
  expect(j.openTurn).toBe(4); expect(j.session.state).toBe("unknown");
  reduceDeepSeek(j,{type:"turn/end",time:1793343602000,data:{turn:4,reason:{kind:"completed"}}});
  expect(j.session.state).toBe("completed"); expect(j.session.messages[0].text).toBe("visible"); expect(j.session.run_duration_seconds).toBe(2);
});

test("Claude cache fields normalize to inclusive prompt and repeated API message IDs do not inflate totals", () => {
  const j=initClaude();
  const row={type:"assistant",sessionId:"code-one",timestamp:"2026-10-30T07:00:00Z",uuid:"a",message:{id:"api-one",model:"claude-test",content:[{type:"text",text:"公开消息"}],usage:{input_tokens:100,output_tokens:20,cache_read_input_tokens:600,cache_creation_input_tokens:300}}};
  reduceClaude(j,row); reduceClaude(j,row);
  expect(j.session.usage.input_tokens.value).toBe(1000); expect(j.session.usage.cache_ratio.value).toBe(0.6);
  expect(j.session.usage.context_ratio.value).toBeNull(); expect(j.session.state).toBe("unknown"); expect(j.session.messages).toHaveLength(1);
  reduceClaude(j,{type:"system",subtype:"turn_duration",timestamp:"2026-10-30T07:00:01Z",durationMs:1000});
  expect(j.session.state).toBe("completed");
});

test("append-only reader retries partial JSON and UTF-8 without replay or state inferred from mtime", async () => {
  const dir=await mkdtemp(join(tmpdir(),"companion-journal-")), path=join(dir,"session.jsonl");
  try {
    const reader=new JsonlReader(()=>({text:[] as string[]}), (v,r)=>{if(typeof r.text==="string")v.text.push(r.text);});
    await writeFile(path,'{"text":"第一条"}\n{"text":');
    expect((await reader.read(path)).value.text).toEqual(["第一条"]);
    await appendFile(path,'"第二条"}\n');
    expect((await reader.read(path)).value.text).toEqual(["第一条","第二条"]);
    expect((await reader.read(path)).value.text).toHaveLength(2);
    await writeFile(path,'{"text":"替换"}\n');
    expect((await reader.read(path)).value.text).toEqual(["替换"]);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("unknown and impossible ratios never become a plausible zero", () => {
  expect(ratio(null,100)).toBeNull(); expect(ratio(0,0)).toBeNull(); expect(ratio(101,100)).toBeNull(); expect(ratio(0,100)).toBe(0);
  expect(iso(1793343600)).toBe(iso(1793343600000));
});

test("reader eviction reloads reduced state and preserves a split UTF-8 tail", async () => {
  const dir=await mkdtemp(join(tmpdir(),"companion-eviction-")), path=join(dir,"session.jsonl");
  try {
    const reader=new JsonlReader(()=>({text:[] as string[]}), (v,r)=>{if(typeof r.text==="string")v.text.push(r.text);});
    const content=Buffer.from('{"text":"已完成"}\n{"text":"新消息"}\n');
    // The final UTF-8 character is split across separate file writes/polls.
    const cut=content.indexOf(Buffer.from("息"))+1;
    await writeFile(path,content.subarray(0,cut));
    expect((await reader.read(path)).value.text).toEqual(["已完成"]);
    await appendFile(path,content.subarray(cut));
    expect((await reader.read(path)).value.text).toEqual(["已完成","新消息"]);
    reader.retain([]);
    expect((await reader.read(path)).value.text).toEqual(["已完成","新消息"]);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("journal rows reduce lazily without retaining all parsed objects", () => {
  const iterator=rows('{"seq":1}\ninvalid\n\n{"seq":2}\n{"unfinished":');
  expect(iterator.next().value).toEqual({seq:1});
  expect(iterator.next().value).toEqual({seq:2});
  expect(iterator.next().done).toBe(true);
});

test("long progress sequences retain the latest user question and the newest public reply", () => {
  const s=newSession("deepseek","long-turn","test");
  addMessage(s,"user","请完成状态与对话接入","question",null);
  for(let i=0;i<30;++i) addMessage(s,"assistant",`公开进度 ${i}`,`reply-${i}`,null);
  expect(s.messages).toHaveLength(12); expect(s.messages[0].role).toBe("user");
  expect(s.messages.at(-1)?.text).toBe("公开进度 29"); expect(s.transcript_truncated).toBe(true);
  const streaming=newSession("claude","stream","test");
  addMessage(streaming,"assistant","partial","one",null);
  addMessage(streaming,"assistant","x".repeat(2500),"one",null);
  expect(streaming.messages[0].text).toHaveLength(2400); expect(streaming.transcript_truncated).toBe(true);
});

test("Codex uses the sidebar title, not the first message or project name", async () => {
  const home=await mkdtemp(join(tmpdir(),"companion-title-"));
  try {
    await mkdir(join(home,".codex/sessions"),{recursive:true});
    const path=join(home,".codex/sessions/one.jsonl"), at=new Date().toISOString();
    await writeFile(path,JSON.stringify({type:"event_msg",timestamp:at,payload:{type:"task_complete",turn_id:"one",duration_ms:1000}})+"\n");
    const db=new Database(join(home,".codex/state_5.sqlite"));
    db.exec("CREATE TABLE threads(id TEXT,rollout_path TEXT,title TEXT,name TEXT,cwd TEXT,model TEXT,updated_at INTEGER,archived INTEGER)");
    db.query("INSERT INTO threads VALUES(?,?,?,?,?,?,?,0)").run("one",path,"# Files mentioned by the user:\nfile metadata\n## My request:\n看一下这个方案，然后做一下开发规划","规划数据集数据库开发",join(home,"数据集数据库"),"test",Math.floor(Date.now()/1000));
    db.close();
    const adapter=new CodexAdapter(home);
    const result=await adapter.collect(new Set(),at);
    expect(result.sessions[0].title).toBe("规划数据集数据库开发");
    expect(result.sessions[0].project_name).toBe("数据集数据库");
    const update=new Database(join(home,".codex/state_5.sqlite"));
    update.exec("UPDATE threads SET name=NULL"); update.close();
    expect((await adapter.collect(new Set(),at)).sessions[0].title).toBe("未命名会话");
  } finally { await rm(home,{recursive:true,force:true}); }
});

test("Codex account quota does not mix model buckets or disappear on token-only records", () => {
  const j=initCodex();
  const record=(at:string,limits:unknown)=>reduceCodex(j,{type:"event_msg",timestamp:at,payload:{type:"token_count",rate_limits:limits}});
  record("2026-10-30T07:00:00Z",{limit_id:"codex",primary:{used_percent:64,window_minutes:10080,resets_at:1793774423},secondary:{used_percent:12,window_minutes:300,resets_at:1793774423}});
  expect(j.quota.map(w=>w.used_ratio.value)).toEqual([0.64,0.12]);
  record("2026-10-30T07:00:01Z",{limit_id:"other-model-pool",primary:{used_percent:99,window_minutes:10080}});
  record("2026-10-30T07:00:02Z",undefined);
  expect(j.quota[0].used_ratio.value).toBe(0.64); expect(j.quotaObservedAt).toBe("2026-10-30T07:00:00.000Z");
  record("2026-10-30T07:00:03Z",{limit_id:"codex",primary:null,secondary:null});
  expect(j.quota).toHaveLength(0); expect(j.quotaObservedAt).toBe("2026-10-30T07:00:03.000Z");
});
