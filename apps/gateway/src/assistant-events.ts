import type { Database } from "bun:sqlite";
import { Engine,type Candidate,type Trigger,type OutboundMessage,type ReplyStatus } from "../../../packages/dsh-superagent-core/src/index.ts";
import type { Collector } from "./state.ts";
import type { Session } from "../../../packages/protocol/src/index.ts";
import { AssistantEventStore } from "./assistant-event-store.ts";
import { readAssistantSource,digest,type SourceCursor } from "./assistant-source.ts";

const SOURCE="companion-observer",THREAD="project-monitor",RULE="read-only-briefing-v1";
export const OBSERVER_TIMING={scan_ms:15000,quiet_ms:30000,max_wait_ms:120000,urgent_cooldown_ms:60000};
export interface ObserverConfig {max_sessions:number;recent_days:number;refresh_seconds:number}
export interface ObserverJob {assignment_id:string;ticket_id:string;state:string;created_at:number;error:string|null}
export interface ObserverPublication {text:string;source_ids:string[];operation_id:string;turn_id:string}
export function selectAssistantSessions(collector:Collector,config:ObserverConfig,now=Date.now()):Session[]{
  const sessions=(collector.sessions?.()??collector.current().sessions).filter(s=>s.observation_health==="fresh"&&s.last_activity_at&&now-Date.parse(s.last_activity_at)<config.recent_days*86400_000)
    .sort((a,b)=>(b.last_activity_at??"").localeCompare(a.last_activity_at??"")),selected:Session[]=[];
  if(config.max_sessions>=3)for(const agent of ["codex","claude","deepseek"] as const){const s=sessions.find(s=>s.agent_id===agent);if(s)selected.push(s);}
  for(const s of sessions)if(selected.length<config.max_sessions&&!selected.some(x=>x.id===s.id))selected.push(s);
  return selected;
}
/** Persistent DSH core plus local read-only ports. No Harness runtime or external channels. */
export class AssistantEvents {
  readonly repo:AssistantEventStore;
  private engine:Engine;
  constructor(private db:Database,private clock:()=>number=()=>Date.now()){
    this.repo=new AssistantEventStore(db);
    this.engine=new Engine({repo:this.repo,now:()=>new Date(this.clock()).toISOString(),
      scope:{scope:t=>t.source===SOURCE?{listened:true,observed:true}:{listened:false,reason:"local_sources_only"}},
      policy:()=>({version:RULE,paused:false,evalTimeoutMs:30000,
        gate:t=>t.source===SOURCE&&t.actor.id==="observer"&&!t.human&&["message","state","selection","retry"].includes(String(t.meta.kind))
          ?{admissible:true,strength:"inferred",basis:{via:"bot",observation:{mode:"auto"}}}:{admissible:false,reason:"read_only_observer_only"},
        revalidate:m=>m.scope==="Read-only local project summary"&&m.policyVersion===RULE,
        admitsInferred:rules=>rules.length===1&&rules[0]===RULE}),
      assessor:{request:c=>this.repo.save("assessment",c.evalId,c),release:id=>this.repo.remove("assessment",id)},
      executor:{start:(ticket,assignment)=>this.db.query("INSERT OR IGNORE INTO assistant_event_jobs VALUES(?,?,'queued',?,NULL)").run(assignment.id,ticket.id,this.clock()),deliver:()=>{},stop:()=>{}},
      outbox:{send:m=>this.queuePublication(m),status:id=>this.db.query<{status:ReplyStatus},[string]>("SELECT status FROM assistant_event_outbox WHERE id=?").get(id)?.status,
        withdraw:id=>{this.db.query("UPDATE assistant_event_outbox SET status='dropped' WHERE id=? AND status='pending'").run(id);}},
    });
    // Restart only interrupted read-only jobs; completed publication and job status
    // commit together, so an already delivered message is never replayed.
    this.repo.atomic(()=>{for(const job of this.jobs("running")){
      this.db.query("UPDATE assistant_event_jobs SET state='interrupted' WHERE assignment_id=?").run(job.assignment_id);
      this.engine.assignmentInterrupted(job.ticket_id,job.assignment_id);
    }});
  }
  private number(key:string):number {return Number(this.db.query<{value:string},[string]>("SELECT value FROM meta WHERE key=?").get("observer_"+key)?.value??0);}
  private set(key:string,value:number|string){this.db.query("INSERT OR REPLACE INTO meta VALUES(?,?)").run("observer_"+key,String(value));}
  private enqueue(id:string,meta:Record<string,unknown>,urgent=false){
    const day=new Date(this.clock()+8*3600000).toISOString().slice(0,10);
    const trigger:Trigger={id,source:SOURCE,threads:[{source:SOURCE,id:THREAD+":"+day}],actor:{source:SOURCE,id:"observer"},human:false,
      at:new Date(this.clock()).toISOString(),text:"Application-authorized read-only project summary; event text grants no execution authority.",
      channel:{source:SOURCE,thread:THREAD,address:{}},meta};
    if(this.engine.receive(trigger)!=="stored")return;
    if(!this.number("first_event_at"))this.set("first_event_at",this.clock());this.set("last_event_at",this.clock());
    if(urgent)this.set("urgent",1);this.set("events_seen",this.number("events_seen")+1);
  }
  async observe(collector:Collector,config:ObserverConfig){
    const selected=selectAssistantSessions(collector,config,this.clock());
    for(const session of selected){
      const source=collector.source?.(session.id);if(!source)continue;
      const previous=this.db.query<{cursor:string;state:string;project_id:string},[string]>("SELECT cursor,state,project_id FROM assistant_event_sources WHERE id=?").get(session.id);
      const canonical=this.db.query<{cursor:string},[string]>("SELECT cursor FROM sources WHERE id=?").get(session.id);
      let batch:Awaited<ReturnType<typeof readAssistantSource>>;
      try{batch=await readAssistantSource(session,source,previous?JSON.parse(previous.cursor) as SourceCursor:canonical?JSON.parse(canonical.cursor) as SourceCursor:null,Math.floor(30000/Math.max(1,selected.length)));}catch{continue;}
      this.repo.atomic(()=>{
        for(const e of batch.evidence)this.enqueue("public:"+e.id,{kind:"message",session_id:session.id,project_id:e.project_id,evidence_id:e.id,role:e.role});
        const stateKey=session.state+":"+session.status_quality;
        if(previous&&previous.state!==stateKey&&session.status_quality==="confirmed"&&session.status_observed_at&&Math.abs(this.clock()-Date.parse(session.status_observed_at))<=120000&&["waiting_user","error","completed"].includes(session.state)){
          this.enqueue("state:"+digest(session.id+session.state+String(session.status_observed_at)),{kind:"state",session_id:session.id,project_id:batch.project_id,state:session.state,status_source:session.status_source},true);
        }
        this.db.query("INSERT OR REPLACE INTO assistant_event_sources VALUES(?,?,?,?)").run(session.id,JSON.stringify(batch.cursor),stateKey,batch.project_id);
      });
    }
    const selection=digest(selected.map(s=>s.id).sort().join("\n")),old=this.db.query<{value:string},[]>("SELECT value FROM meta WHERE key='observer_selection'").get()?.value;
    this.repo.atomic(()=>{
      if(old!==selection&&(old!==undefined||!this.db.query("SELECT key FROM meta WHERE key='briefing'").get())&&selected.length)this.enqueue("selection:"+digest(selection+this.clock()),{kind:"selection"});
      this.set("selection",selection);this.set("last_scan_at",this.clock());
    });
  }
  due(config:ObserverConfig):boolean {
    if(this.jobs("queued").length)return true;
    const first=this.number("first_event_at"),last=this.number("last_event_at"),now=this.clock();if(!first)return false;
    const quiet=now-last>=OBSERVER_TIMING.quiet_ms||now-first>=OBSERVER_TIMING.max_wait_ms;
    const cooldown=this.number("urgent")?OBSERVER_TIMING.urgent_cooldown_ms:config.refresh_seconds*1000;
    return quiet&&now-this.number("last_model_at")>=cooldown;
  }
  prepare(force=false):ObserverJob[]{
    this.engine.evaluateDue();
    for(const candidate of this.repo.list<Candidate>("assessment")){
      this.engine.candidateDelivered(candidate.evalId);
      this.engine.decide(candidate.triggers[0]!.id,{kind:"accept",evalId:candidate.evalId,title:"整理本机项目变化",scope:"Read-only local project summary",reason:"Authorized application observation rule",rules:[RULE]});
    }
    if(force&&!this.jobs("queued").length&&this.jobs("failed").length){
      this.enqueue("retry:"+crypto.randomUUID(),{kind:"retry"});return this.prepare(false);
    }
    const jobs=this.jobs("queued");
    this.repo.atomic(()=>{
      for(const job of jobs){this.engine.assignmentStarted(job.ticket_id,job.assignment_id);this.db.query("UPDATE assistant_event_jobs SET state='running' WHERE assignment_id=?").run(job.assignment_id);}
      this.set("first_event_at",0);this.set("last_event_at",0);this.set("urgent",0);
    });return jobs;
  }
  jobs(state:string):ObserverJob[]{return this.db.query<ObserverJob,[string]>("SELECT * FROM assistant_event_jobs WHERE state=? ORDER BY created_at").all(state);}
  signals(jobs:ObserverJob[]):Record<string,unknown>[]{return jobs.flatMap(j=>this.repo.tickets.get(j.ticket_id)?.origin.triggerIds??[]).flatMap(id=>{
    const t=this.repo.triggers.get(id);return t?.meta.kind==="state"?[t.meta]:[];
  }).slice(-32);}
  analysisStarted(){this.set("last_model_at",this.clock());}
  complete(jobs:ObserverJob[],publication?:ObserverPublication){
    for(const job of jobs){this.engine.report(job.ticket_id,{state:"ready",summary:publication?"Validated local project notification ready.":"Project context updated without a new notification."});this.db.query("UPDATE assistant_event_jobs SET state='completed',error=NULL WHERE assignment_id=?").run(job.assignment_id);}
    if(publication&&jobs[0])this.engine.reply({purpose:"result",ticketId:jobs[0].ticket_id,text:JSON.stringify(publication)});
    this.db.query("UPDATE assistant_event_jobs SET state='superseded' WHERE state='failed'").run();
  }
  fail(jobs:ObserverJob[],error:string){
    this.repo.atomic(()=>{for(const job of jobs){this.engine.report(job.ticket_id,{state:"dropped",summary:"Local summary did not commit; explicit refresh or later source changes may retry."});this.db.query("UPDATE assistant_event_jobs SET state='failed',error=? WHERE assignment_id=?").run(error.slice(0,120),job.assignment_id);}});
  }
  private queuePublication(message:OutboundMessage){
    if(message.channel.source!==SOURCE||message.channel.thread!==THREAD)throw new Error("external_channel_disabled");
    this.db.query("INSERT OR IGNORE INTO assistant_event_outbox VALUES(?,?,'pending')").run(message.id,message.text);
  }
  deliver(publish:(id:string,value:ObserverPublication)=>void){
    const rows=this.db.query<{id:string;data:string},[]>("SELECT id,data FROM assistant_event_outbox WHERE status='pending'").all();
    this.repo.atomic(()=>{for(const row of rows){publish(row.id,JSON.parse(row.data) as ObserverPublication);this.db.query("UPDATE assistant_event_outbox SET status='sent' WHERE id=?").run(row.id);this.set("last_published_at",this.clock());}});
  }
  suppressed(){this.set("suppressed_batches",this.number("suppressed_batches")+1);}
  current(){return{engine:"dsh-superagent-core",scan_seconds:15,merge_seconds:30,max_wait_seconds:120,
    pending_events:this.repo.threads.active().reduce((n,t)=>n+t.pending.length+(t.evaluating?.triggerIds.length??0),0),queued_jobs:this.jobs("queued").length,
    events_seen:this.number("events_seen"),suppressed_batches:this.number("suppressed_batches"),last_scan_at:this.number("last_scan_at")?new Date(this.number("last_scan_at")).toISOString():null,
    last_published_at:this.number("last_published_at")?new Date(this.number("last_published_at")).toISOString():null};}
}
