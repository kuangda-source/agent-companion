import {invalidOutput} from "./assistant-validation.ts";
import type {Database} from "bun:sqlite";
import type {Session} from "../../../packages/protocol/src/index.ts";
import {readAssistantSource,type Evidence,type SourceCursor} from "./assistant-source.ts";
import {array,object,redactSecrets,type TranscriptSource} from "./adapters/common.ts";

export interface SessionFact {key:string;text:string;source_ids:string[];observed_at:string|null;stage:"planned"|"reported"|"verified"|"accepted";status?:"open"|"resolved"}
export interface SessionFacts {current_task:SessionFact|null;latest_results:SessionFact[];open_questions:SessionFact[]}
interface Row {id:string;cursor:string;consumed:number;facts:string;revision:number}
export interface PendingSession {cursor:SourceCursor;evidence:Evidence[];through:number;project_id:string;partial:boolean}

/** Application-owned ingestion and summary receipts; model failures never consume inbox rows. */
export class SessionMemory {
  constructor(private db:Database){db.exec(`CREATE TABLE IF NOT EXISTS session_memory(id TEXT PRIMARY KEY,cursor TEXT NOT NULL,consumed INTEGER NOT NULL DEFAULT 0,facts TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS session_memory_inbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,session_id TEXT NOT NULL,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS session_memory_pending ON session_memory_inbox(session_id,seq);
    CREATE TABLE IF NOT EXISTS session_memory_receipts(id TEXT PRIMARY KEY,session_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS session_memory_history(session_id TEXT NOT NULL,revision INTEGER NOT NULL,note TEXT NOT NULL,PRIMARY KEY(session_id,revision));`);}
  private row(id:string){return this.db.query<Row,[string]>("SELECT * FROM session_memory WHERE id=?").get(id);}
  facts(id:string):SessionFacts {const row=this.row(id);return row?JSON.parse(row.facts):{current_task:null,latest_results:[],open_questions:[]};}
  prompt(id:string,maxChars:number){
    const all=this.facts(id),short=(f:SessionFact)=>({...f,text:[...f.text].slice(0,120).join(''),source_ids:f.source_ids.slice(0,2)});
    const result={current_task:all.current_task?short(all.current_task):null,latest_results:all.latest_results.slice(-3).map(short),open_questions:all.open_questions.filter(f=>f.status==='open').slice(-8).map(short),partial:false};
    while(JSON.stringify(result).length>maxChars&&(result.latest_results.length||result.open_questions.length)){result.partial=true;if(result.latest_results.length)result.latest_results.shift();else result.open_questions.shift();}
    result.partial ||= result.latest_results.length<all.latest_results.length||result.open_questions.length<all.open_questions.filter(f=>f.status==='open').length;return result;
  }
  async ingest(session:Session,source:TranscriptSource,canonical:SourceCursor|null,budget:number):Promise<PendingSession>{
    const previous=this.row(session.id),cursor=previous?JSON.parse(previous.cursor) as SourceCursor:canonical;
    const batch=await readAssistantSource(session,source,cursor,budget,{sequential:true});
    this.db.transaction(()=>{
      for(const e of batch.evidence)if(!this.db.query("SELECT id FROM session_memory_receipts WHERE id=?").get(e.id))this.db.query("INSERT OR IGNORE INTO session_memory_inbox(id,session_id,data) VALUES(?,?,?)").run(e.id,session.id,JSON.stringify(e));
      this.db.query("INSERT INTO session_memory(id,cursor,facts) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor").run(session.id,JSON.stringify(batch.cursor),JSON.stringify(this.facts(session.id)));
    })();
    const consumed=this.row(session.id)!.consumed,rows=this.db.query<{seq:number;data:string},[string,number]>("SELECT seq,data FROM session_memory_inbox WHERE session_id=? AND seq>? ORDER BY seq LIMIT 32").all(session.id,consumed);
    const evidence:Evidence[]=[];let through=consumed,available=budget;
    for(const row of rows){const e=JSON.parse(row.data) as Evidence,n=[...e.text].length;if(evidence.length&&n>available)break;evidence.push(e);available-=n;through=row.seq;if(available<=0)break;}
    return{...batch,evidence,through};
  }
  merge(id:string,value:unknown,allowed:Map<string,Evidence>):SessionFacts{
    const old=this.facts(id),patch=object(value);
    const parse=(v:unknown,issue=false):SessionFact=>{
      const f=object(v),refs=array(f.source_ids);
      if(typeof f.key!=="string"||!/^[-a-zA-Z0-9_.:]{1,100}$/.test(f.key))invalidOutput('memory_key');
      if(typeof f.text!=="string"||!f.text.trim()||[...f.text].length>600)invalidOutput('memory_text');
      if(!refs.length||refs.length>16||refs.some(r=>typeof r!=="string"||allowed.get(r)?.session_id!==id))invalidOutput('memory_refs');
      if(!["planned","reported","verified","accepted"].includes(String(f.stage)))invalidOutput('memory_stage');
      if(issue&&!["open","resolved"].includes(String(f.status)))invalidOutput('memory_status');
      const source_ids=[...new Set(refs as string[])],times=source_ids.map(r=>allowed.get(r)!.timestamp).filter((t):t is string=>!!t).sort();
      const stage=(f.stage==='verified'||f.stage==='accepted')&&!source_ids.some(r=>allowed.get(r)!.role==='user')?'reported':f.stage as SessionFact['stage'];
      return{key:f.key,text:redactSecrets(f.text),source_ids,observed_at:times.at(-1)??null,stage,...(issue?{status:f.status as "open"|"resolved"}:{})};
    };
    const update=(key:"latest_results"|"open_questions",limit:number)=>{
      if(patch[key]===undefined)return old[key];if(!Array.isArray(patch[key])||patch[key].length>12)invalidOutput('memory_shape');
      const changed=(patch[key] as unknown[]).map(v=>parse(v,key==="open_questions")),merged=new Map(old[key].map(f=>[f.key,f]));
      if(new Set(changed.map(f=>f.key)).size!==changed.length)invalidOutput('memory_duplicates');
      for(const f of changed){const before=merged.get(f.key);if(!before||String(f.observed_at??"")>=String(before.observed_at??"")){merged.delete(f.key);merged.set(f.key,f);}}
      const values=[...merged.values()];
      return key==="open_questions"?[...values.filter(f=>f.status==="resolved").slice(-limit),...values.filter(f=>f.status==="open")]:values.slice(-limit);
    };
    const task=patch.current_task===undefined||patch.current_task===null?old.current_task:parse(patch.current_task);
    return{current_task:old.current_task&&String(old.current_task.observed_at??'')>String(task?.observed_at??'')?old.current_task:task,latest_results:update("latest_results",12),open_questions:update("open_questions",24)};
  }
  /** Called inside the same transaction as accepted summaries and their references. */
  commit(id:string,through:number,facts:SessionFacts,note:unknown){
    const row=this.row(id);if(!row||through<row.consumed)throw new Error("stale_session_memory");
    const revision=row.revision+1;
    this.db.query("INSERT INTO session_memory_history VALUES(?,?,?)").run(id,revision,JSON.stringify({facts,note}));
    this.db.query("UPDATE session_memory SET consumed=?,facts=?,revision=? WHERE id=?").run(through,JSON.stringify(facts),revision,id);
    this.db.query("INSERT OR IGNORE INTO session_memory_receipts SELECT id,session_id FROM session_memory_inbox WHERE session_id=? AND seq<=?").run(id,through);
    this.db.query("DELETE FROM session_memory_inbox WHERE session_id=? AND seq<=?").run(id,through);
  }
  acknowledgeKnown(id:string,through:number){
    const row=this.row(id);if(!row||through<row.consumed)throw new Error('stale_session_memory');
    this.db.query('UPDATE session_memory SET consumed=? WHERE id=?').run(through,id);
    this.db.query("INSERT OR IGNORE INTO session_memory_receipts SELECT id,session_id FROM session_memory_inbox WHERE session_id=? AND seq<=?").run(id,through);
    this.db.query('DELETE FROM session_memory_inbox WHERE session_id=? AND seq<=?').run(id,through);
  }
  status(){return this.db.query<{sessions:number;pending:number},[]>("SELECT (SELECT COUNT(*) FROM session_memory) AS sessions,(SELECT COUNT(*) FROM session_memory_inbox) AS pending").get();}
}
