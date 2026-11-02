/** Read-only scheduler metadata. Never reads prompts or creates/runs jobs. */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ScheduledTasks, ScheduledTask, Session } from "../../../packages/protocol/src/index.ts";
interface Row {id:string;name:string;status:string;next_run_at:number|null;last_run_at:number|null;kind:string;target_thread_id:string|null;run_thread:string|null}
const date=(n:number|null)=>typeof n==="number"&&Number.isFinite(n)&&n>=0?new Date(n).toISOString():null;
export class ScheduleReader {
 private last=0;
 private value:ScheduledTasks={status:"unavailable",observed_at:null,as_of_epoch:0,sources:[],tasks:[]};
 constructor(private home=homedir()){}
 current(now=Date.now()):ScheduledTasks {
  if(now-this.last<5000&&this.last)return {...this.value,as_of_epoch:now/1000};this.last=now;
  const sources:ScheduledTasks["sources"]=[{agent_id:"codex",quality:"unavailable",note:"未发现本机调度记录"},{agent_id:"claude",quality:"unavailable",note:"尚无可验收的 Claude Code 定时来源"},{agent_id:"deepseek",quality:"unavailable",note:"尚无可验收的 Harness 定时来源"}];
  const path=join(this.home,".codex/sqlite/codex-dev.db");
  if(!existsSync(path)){this.value={status:"unavailable",observed_at:null,as_of_epoch:now/1000,sources,tasks:[]};return this.value;}
  let db:Database|undefined,threads:Database|undefined;
  try{
   db=new Database(path,{readonly:true,create:false});
   const rows=db.query<Row,[]>(`SELECT a.id,a.name,a.status,a.next_run_at,a.last_run_at,a.kind,a.target_thread_id,
    (SELECT r.thread_id FROM automation_runs r WHERE r.automation_id=a.id ORDER BY r.created_at DESC LIMIT 1) AS run_thread
    FROM automations a WHERE a.status='ACTIVE' ORDER BY COALESCE(a.next_run_at,9223372036854775807),a.updated_at DESC LIMIT 256`).all();
   const tp=join(this.home,".codex/state_5.sqlite");if(existsSync(tp))threads=new Database(tp,{readonly:true,create:false});
   const seen=new Set<string>();const nearest:Row[]=[];
   for(const row of rows){const key=row.target_thread_id??row.run_thread??row.id;if(seen.has(key))continue;seen.add(key);nearest.push(row);if(nearest.length>=32)break;}
   const tasks:ScheduledTask[]=nearest.map(r=>{
    const id=r.target_thread_id??r.run_thread;let title:string|null=null;
    if(id&&threads)title=threads.query<{name:string|null},[string]>("SELECT name FROM threads WHERE id=?").get(id)?.name??null;
    return {id:"codex:automation:"+r.id,agent_id:"codex",title:r.name.trim()||"未命名定时任务",kind:r.kind==="cron"?"cron":r.kind==="heartbeat"?"heartbeat":"unknown",status:r.status==="ACTIVE"?"active":r.status==="PAUSED"?"paused":"unknown",next_run_at:r.status==="ACTIVE"?date(r.next_run_at):null,last_run_at:date(r.last_run_at),session_id:id?"codex:rollout:"+id:null,thread_title:title,source:"codex.sqlite.automations.next_run_at"};
   });
   sources[0]={agent_id:"codex",quality:"confirmed",note:"仅显示启用任务；每个对话保留最近一次计划，只读不触发"};
   this.value={status:"ready",observed_at:new Date(now).toISOString(),as_of_epoch:now/1000,sources,tasks};
  }catch{
   sources[0]={agent_id:"codex",quality:"unknown",note:"调度记录暂时不可读；保留上次信息"};
   this.value={...this.value,status:"failed",as_of_epoch:now/1000,sources};
  }finally{threads?.close();db?.close();}
  return this.value;
 }
}

/** Runtime observation wins over the next plan, even after the scheduler advances/deletes a fired job. */
export function projectScheduledConversations(feed:ScheduledTasks,sessions:readonly Session[]):ScheduledTasks {
 const byId=new Map(sessions.map(s=>[s.id,s]));
 return {...feed,tasks:feed.tasks.map(task=>{
  const session=task.session_id?byId.get(task.session_id):undefined;
  const busy=!!session&&["running","waiting_user","error"].includes(session.state);
  const conversation_state=busy?(session!.observation_health==="fresh"&&session!.status_quality==="confirmed"?session!.state:"unknown"):null;
  return {...task,session_id:session?task.session_id:null,conversation_state};
 })};
}
