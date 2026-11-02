import type { Database } from "bun:sqlite";
import type { AssistantIdentity,PersonaSnapshot } from "./assistant-runtime.ts";
import type { AssistantHistoryRecord,AssistantMemoryReader,AssistantMemoryRecord,AssistantStateSnapshot } from "./assistant-memory-contract.ts";
import { redactSecrets } from "./adapters/common.ts";

interface Row {id:string;kind:"preference"|"episode";text:string;revision:number;status:"active"|"deleted";source:string;updated_at:string;supersedes:string|null}
const DEFAULT_PERSONA:PersonaSnapshot={id:"project-butler",revision:1,instructions:"独立项目管家，用简洁中文回答。工作时先给结论，区分进展与待验收；闲聊时自然轻松。"};
function userText(value:string,max:number):string {
  const text=value.trim();if(!text||[...text].length>max)throw new Error("invalid_assistant_memory");
  if(redactSecrets(text)!==text)throw new Error("assistant_memory_contains_credential");return text;
}
export class AssistantUserMemory implements AssistantMemoryReader {
  constructor(private db:Database,private identity:AssistantIdentity,private history:()=>AssistantHistoryRecord[]) {
    db.exec(`CREATE TABLE IF NOT EXISTS user_memories(id TEXT PRIMARY KEY,kind TEXT NOT NULL,text TEXT NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL,source TEXT NOT NULL,updated_at TEXT NOT NULL,supersedes TEXT);`);
  }
  private check(identity:AssistantIdentity){if(identity.assistant_id!==this.identity.assistant_id||identity.owner_id!==this.identity.owner_id)throw new Error("assistant_identity_mismatch");}
  revision():number {return Number(this.db.query<{value:string},[]>("SELECT value FROM meta WHERE key='user_memory_revision'").get()?.value??0);}
  private nextRevision():number {const n=this.revision()+1;this.db.query("INSERT OR REPLACE INTO meta VALUES('user_memory_revision',?)").run(String(n));return n;}
  persona():PersonaSnapshot {const row=this.db.query<{value:string},[]>("SELECT value FROM meta WHERE key='assistant_persona'").get();return row?JSON.parse(row.value) as PersonaSnapshot:{...DEFAULT_PERSONA};}
  setPersona(instructions:string):PersonaSnapshot {
    const next={...this.persona(),instructions:userText(instructions,1200)};next.revision++;
    this.db.query("INSERT OR REPLACE INTO meta VALUES('assistant_persona',?)").run(JSON.stringify(next));return next;
  }
  records(includeDeleted=false):AssistantMemoryRecord[] {
    return this.db.query<Row,[number]>("SELECT * FROM user_memories WHERE ?=1 OR status='active' ORDER BY revision DESC").all(includeDeleted?1:0).map(({source,...r})=>({...r,source:JSON.parse(source) as AssistantMemoryRecord["source"]}));
  }
  view(){return{schema_version:1,revision:this.revision(),persona:this.persona(),items:this.records()};}
  remember(text:string,source:AssistantMemoryRecord["source"]):AssistantMemoryRecord {
    const value=userText(text,800),existing=this.records().find(r=>r.text===value);if(existing)return existing;
    if(this.records().length>=64)throw new Error("assistant_memory_limit");
    return this.db.transaction(()=>{
      const record:AssistantMemoryRecord={id:crypto.randomUUID(),kind:"preference",text:value,revision:this.nextRevision(),status:"active",source,updated_at:new Date().toISOString(),supersedes:null};
      this.db.query("INSERT INTO user_memories VALUES(?,?,?,?,?,?,?,?)").run(record.id,record.kind,record.text,record.revision,record.status,JSON.stringify(source),record.updated_at,null);return record;
    })();
  }
  forget(id:string):void {
    const row=this.records().find(r=>r.id===id);if(!row)throw new Error("assistant_memory_not_found");
    this.db.transaction(()=>{this.db.query("UPDATE user_memories SET text='',status='deleted',revision=?,updated_at=? WHERE id=?").run(this.nextRevision(),new Date().toISOString(),id);})();
  }
  contextCutoff():string {return this.records(true).filter(r=>r.status==="deleted").map(r=>r.updated_at).sort().at(-1)??"";}
  async recall(query:{identity:AssistantIdentity;text:string;limit:number}):Promise<AssistantMemoryRecord[]> {
    this.check(query.identity);return this.records().slice(0,Math.max(0,Math.min(64,query.limit)));
  }
  async exportState(identity:AssistantIdentity):Promise<AssistantStateSnapshot> {
    this.check(identity);const history=this.history();
    return{schema_version:1,identity:{...this.identity},persona:this.persona(),memory_revision:this.revision(),memories:this.records(true),history,
      coverage:{history_complete:false,through_message_id:history.at(-1)?.id??null},bindings:[]};
  }
}
