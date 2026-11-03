import {AGENT_IDS,DEFAULT_AGENT_IDS,type AgentId,type Snapshot} from "../../../packages/protocol/src/index.ts";

/** Selection changes views and assistant scope; it never stops an external Agent. */
export function selectedSnapshot(snapshot:Snapshot,ids:AgentId[]=DEFAULT_AGENT_IDS):Snapshot {
 const enabled=new Set(ids),statistics=snapshot.token_statistics;
 const agents=ids.flatMap(id=>snapshot.agents.filter(a=>a.id===id));
 const sources=ids.flatMap(id=>statistics.agents.filter(a=>a.id===id));
 return {...snapshot,agents,sessions:snapshot.sessions.filter(s=>enabled.has(s.agent_id)),
  token_statistics:{...statistics,agents:sources,
   status:["loading","failed"].includes(statistics.status)?statistics.status:sources.length===ids.length&&sources.every(a=>a.available&&!a.partial)?"ready":"partial",
   days:statistics.days.map(day=>({...day,tokens:Object.fromEntries(AGENT_IDS.map(id=>[id,enabled.has(id)?day.tokens[id]??null:null])) as Record<AgentId,number|null>}))},
  ...(snapshot.scheduled_tasks?{scheduled_tasks:{...snapshot.scheduled_tasks,sources:snapshot.scheduled_tasks.sources.filter(a=>enabled.has(a.agent_id)),tasks:snapshot.scheduled_tasks.tasks.filter(t=>enabled.has(t.agent_id))}}:{})};
}
