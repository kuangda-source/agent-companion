import {test,expect} from "bun:test";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {GrokAdapter,grokCacheKey,grokCachedQuota} from "./src/adapters/grok.ts";
import {readAssistantSource} from "./src/assistant-source.ts";
import {SettingsStore} from "./src/settings.ts";
import {MockState} from "./src/scenarios.ts";
import {createMockGateway} from "./src/server.ts";

function filename(key:string){let bits=0,value=0,out="";for(const byte of Buffer.from(key)){value=(value<<8)|byte;bits+=8;while(bits>=5){bits-=5;out+="abcdefghijklmnopqrstuvwxyz234567"[(value>>bits)&31];value&=(1<<bits)-1;}}if(bits)out+="abcdefghijklmnopqrstuvwxyz234567"[(value<<(5-bits))&31];return out+".blob";}
test("Grok quota uses the original cache time and is always labeled last-known",()=>{
 const cache={selectedTeamId:null,reading:{usage:{percentUsed:5.5,nextResetMs:1794318313233,hasNonZeroIncludedLimit:true},readAtMs:1793719900467}};
 const q=grokCachedQuota(cache)[0];expect(q.used_ratio.value).toBe(.055);expect(q.used_ratio.observed_at).toBe(new Date(cache.reading.readAtMs).toISOString());expect(q.health).toBe("stale");
 expect(grokCachedQuota({...cache,selectedTeamId:"different-scope"})).toEqual([]);expect(grokCachedQuota({reading:{usage:{percentUsed:101}}})).toEqual([]);
});
test("Grok Bot reads real-format roster/replicas without inventing runtime state or forwarding tools",async()=>{
 const home=mkdtempSync(join(tmpdir(),"ac-grok-")),root=join(home,"Library/Application Support/Grok Bot/sand-client-persistence");mkdirSync(root,{recursive:true});
 const scope="sand.client.slice.account.mock.",roster=join(root,filename(scope+"roster.last-roster")),replica=join(root,filename(scope+"transcript.replicas.bot-one"));
 const rows=[{id:"bot-one",name:"Example Bot",lastActivityAt:1793664000000,awaitingUserResponse:null},{id:"removed",name:"Removed",isRemovedFromSidebar:true}];
 const entries=[{kind:"message",id:"u1",role:"user",content:"Please inspect the example",timestampMs:1793664000000},{kind:"send-message",id:"a1",message:{type:"text",content:"Public update"},timestampMs:1793664001000},{kind:"send-message",id:"tool",message:{type:"local-tool-permission",content:"do not export"}},{kind:"event",id:"internal",event:{text:"do not export"}},{kind:"message",id:"reason",role:"system",content:"do not export"}];
 writeFileSync(roster,JSON.stringify({schemaVersion:4,value:{rows}}));writeFileSync(replica,JSON.stringify({schemaVersion:1,value:{entries}}));const original=readFileSync(replica);
 try{
  expect(grokCacheKey(filename(scope+"roster.last-roster"))).toBe(scope+"roster.last-roster");expect(grokCacheKey("secrets.json")).toBeNull();
  const adapter=new GrokAdapter(home),result=await adapter.collect(),session=result.sessions[0];expect(result.count).toBe(1);expect(session.title).toBe("Example Bot");expect(session.agent_id).toBe("grok");expect(session.messages.map(m=>m.role)).toEqual(["user","assistant"]);expect(JSON.stringify(session)).not.toContain("do not export");
  expect(session.state).toBe("unknown");expect(session.observation_health).toBe("fresh");expect(session.usage.input_tokens.value).toBeNull();expect(session.completion_event_id).toBeNull();
  const source=adapter.sources.get(session.id)!;const evidence=await readAssistantSource(session,source,null);expect(evidence.evidence).toHaveLength(2);expect(evidence.partial).toBe(true);expect((await readAssistantSource(session,source,evidence.cursor)).evidence).toHaveLength(0);expect(readFileSync(replica)).toEqual(original);
  writeFileSync(roster,JSON.stringify({schemaVersion:99,value:{rows}}));await expect(adapter.collect()).rejects.toThrow("grok_cache_schema_unsupported");
 }finally{rmSync(home,{recursive:true,force:true});}
});
test("Agent selection persists 1 to 3 unique known IDs and legacy settings migrate to Grok",()=>{
 const home=mkdtempSync(join(tmpdir(),"ac-agents-")),file=join(home,"settings.json");
 try{
  const store=new SettingsStore(file);expect(store.current().appearance.agent_ids).toEqual(["codex","grok","deepseek"]);
  for(const ids of [[],["codex","grok","deepseek","claude"],["grok","grok"],["other"]]){const before=store.current();expect(()=>store.update({appearance:{agent_ids:ids}})).toThrow();expect(store.current()).toEqual(before);}
  store.update({appearance:{agent_ids:["grok"]}});expect(new SettingsStore(file).current().appearance.agent_ids).toEqual(["grok"]);
  const old=store.current();delete (old.appearance as Partial<typeof old.appearance>).agent_ids;writeFileSync(file,JSON.stringify(old));expect(new SettingsStore(file).current().appearance.agent_ids).toEqual(["codex","grok","deepseek"]);
 }finally{rmSync(home,{recursive:true,force:true});}
});
test("display, daily totals and scheduled sources follow current selection, including Claude as an option",async()=>{
 const settings=new SettingsStore(),mock=new MockState(false,0,()=>settings.current().appearance.agent_ids);
 expect(mock.current().agents.map(a=>a.id)).toEqual(["codex","grok","deepseek"]);
 settings.update({appearance:{agent_ids:["grok"]}});const one=mock.current();expect(one.agents.map(a=>a.id)).toEqual(["grok"]);expect(one.sessions.every(s=>s.agent_id==="grok")).toBe(true);expect(one.token_statistics.agents.map(a=>a.id)).toEqual(["grok"]);expect(one.token_statistics.days[0].tokens.codex).toBeNull();
 settings.update({appearance:{agent_ids:["claude","codex"]}});expect(mock.current().agents.map(a=>a.id)).toEqual(["claude","codex"]);
 const gateway=createMockGateway(0,false,0,settings);
 try{const state=await(await fetch(new URL("api/v1/state",gateway.server.url))).json() as {agents:{id:string}[]};expect(state.agents.map((a:{id:string})=>a.id)).toEqual(["claude","codex"]);}finally{gateway.close();}
});
