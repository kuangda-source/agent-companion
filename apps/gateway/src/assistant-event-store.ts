import type { Database } from "bun:sqlite";
import type { Repositories,Trigger,TriggerDisposition,Thread,Ticket,Decision } from "../../../packages/dsh-superagent-core/src/index.ts";

/** Application SQLite adapter; upstream core has no access to provider files or tools. */
export class AssistantEventStore implements Repositories {
  constructor(readonly db:Database){
    db.exec(`CREATE TABLE IF NOT EXISTS assistant_event_records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS assistant_event_jobs(assignment_id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,error TEXT);
      CREATE TABLE IF NOT EXISTS assistant_event_outbox(id TEXT PRIMARY KEY,data TEXT NOT NULL,status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assistant_event_sources(id TEXT PRIMARY KEY,cursor TEXT NOT NULL,state TEXT NOT NULL,project_id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS assistant_event_jobs_state ON assistant_event_jobs(state);`);
  }
  atomic<T>(work:()=>T):T{return this.db.transaction(work)();}
  get<T>(kind:string,id:string):T|undefined {const row=this.db.query<{data:string},[string,string]>("SELECT data FROM assistant_event_records WHERE kind=? AND id=?").get(kind,id);return row?JSON.parse(row.data) as T:undefined;}
  save(kind:string,id:string,data:unknown){this.db.query("INSERT INTO assistant_event_records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data").run(kind,id,JSON.stringify(data));}
  remove(kind:string,id:string){this.db.query("DELETE FROM assistant_event_records WHERE kind=? AND id=?").run(kind,id);}
  list<T>(kind:string):T[]{return this.db.query<{data:string},[string]>("SELECT data FROM assistant_event_records WHERE kind=? ORDER BY rowid").all(kind).map(r=>JSON.parse(r.data) as T);}
  private activeRows<T>(kind:string,predicate:string):T[]{return this.db.query<{data:string},[string]>("SELECT data FROM assistant_event_records WHERE kind=? AND ("+predicate+") ORDER BY rowid").all(kind).map(r=>JSON.parse(r.data) as T);}
  readonly triggers={get:(id:string)=>this.get<Trigger>("trigger",id),save:(v:Trigger)=>this.save("trigger",v.id,v),disposition:(id:string)=>this.get<TriggerDisposition>("disposition",id),saveDisposition:(id:string,v:TriggerDisposition)=>this.save("disposition",id,v)};
  readonly threads={get:(id:string)=>this.get<Thread>("thread",id),save:(v:Thread)=>this.save("thread",v.key,v),list:()=>this.list<Thread>("thread"),
    active:()=>this.activeRows<Thread>("thread","json_array_length(data,'$.pending')>0 OR json_type(data,'$.evaluating')='object'")};
  readonly tickets={get:(id:string)=>this.get<Ticket>("ticket",id),save:(v:Ticket)=>this.save("ticket",v.id,v),list:()=>this.list<Ticket>("ticket").reverse(),
    open:()=>this.activeRows<Ticket>("ticket","json_type(data,'$.ended') IS NULL"),active:()=>this.activeRows<Ticket>("ticket","json_array_length(data,'$.undelivered')>0 OR json_extract(data,'$.assignments[#-1].state') IN ('pending','running')")};
  readonly decisions={get:(id:string)=>this.get<Decision>("decision",id),save:(v:Decision)=>this.save("decision",v.id,v),byThread:(id:string)=>this.db.query<{data:string},[string]>("SELECT data FROM assistant_event_records WHERE kind='decision' AND json_extract(data,'$.threadKey')=? ORDER BY rowid").all(id).map(r=>JSON.parse(r.data) as Decision)};
}
