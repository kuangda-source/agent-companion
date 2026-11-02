import type { Database } from "bun:sqlite";
import { digest } from "./assistant-source.ts";
import { object,array } from "./adapters/common.ts";

export type ChangeKind="decision"|"blocker"|"milestone"|"completed"|"resolved";
export interface AttentionUpdate {key:string;project_id:string;status:"open"|"resolved";text:string;source_ids:string[];source_at:number}
export interface ImportantChange {key:string;project_id:string;kind:ChangeKind;text:string;source_ids:string[];source_at:number}
export interface AttentionRecord {id:string;key:string;project_id:string;status:"open"|"resolved";text:string;source_ids:string[];cycle:number;updated_at:string}
interface Row extends Omit<AttentionRecord,"source_ids"> {refs:string;source_at:number}
/** Stable topic identities and notification receipts live in the app, never SDK memory. */
export class AssistantNotifications {
  constructor(private db:Database,private clock:()=>number=()=>Date.now()){db.exec(`CREATE TABLE IF NOT EXISTS assistant_attention(id TEXT PRIMARY KEY,key TEXT NOT NULL,project_id TEXT NOT NULL,status TEXT NOT NULL,text TEXT NOT NULL,refs TEXT NOT NULL,cycle INTEGER NOT NULL,updated_at TEXT NOT NULL,source_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS assistant_notice_keys(id TEXT PRIMARY KEY,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS assistant_change_topics(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,key TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,refs TEXT NOT NULL,updated_at TEXT NOT NULL);`);
    if(!db.query<{name:string},[]>("PRAGMA table_info(assistant_attention)").all().some(c=>c.name==="source_at")){
      db.exec("ALTER TABLE assistant_attention ADD COLUMN source_at INTEGER NOT NULL DEFAULT 0");
      for(const row of db.query<{id:string;refs:string},[]>("SELECT id,refs FROM assistant_attention").all()){
        const timestamps=(JSON.parse(row.refs) as string[]).map(id=>Date.parse(db.query<{timestamp:string},[string]>("SELECT timestamp FROM evidence WHERE id=?").get(id)?.timestamp??"")||0);
        db.query("UPDATE assistant_attention SET source_at=? WHERE id=?").run(Math.max(0,...timestamps),row.id);
      }
    }
    if(!db.query("SELECT key FROM meta WHERE key='observer_attention_seeded'").get())db.transaction(()=>{
      const old=db.query<{value:string},[]>("SELECT value FROM meta WHERE key='briefing'").get();
      for(const value of array(old?object(JSON.parse(old.value)).attention:[])){
        const item=object(value),refs=array(item.source_ids).filter((id):id is string=>typeof id==="string");
        if(typeof item.text!=="string"||item.text.startsWith("历史待确认")||!refs.length)continue;
        const source=db.query<{project_id:string;timestamp:string},[string]>("SELECT project_id,timestamp FROM evidence WHERE id=?").get(refs[0]!);
        if(!source||this.clock()-Date.parse(source.timestamp)>86400_000)continue;
        const key="legacy_"+digest(item.text).slice(0,24),id=digest(source.project_id+":"+key);
        db.query("INSERT OR IGNORE INTO assistant_attention VALUES(?,?,?,'open',?,?,0,?,?)").run(id,key,source.project_id,item.text,JSON.stringify(refs),source.timestamp,Date.parse(source.timestamp)||0);
      }
      db.query("INSERT OR REPLACE INTO meta VALUES('observer_attention_seeded','1')").run();
    })();}
  list(status:"open"|"resolved"="open"):AttentionRecord[]{return this.db.query<Row,[string]>("SELECT * FROM assistant_attention WHERE status=? ORDER BY updated_at DESC LIMIT 64").all(status).map(({refs,source_at,...row})=>({...row,text:source_at>0&&this.clock()-source_at>86400_000&&!row.text.startsWith("历史待确认")?"历史待确认："+row.text:row.text,source_ids:JSON.parse(refs) as string[]}));}
  recentChanges(){return this.db.query<{project_id:string;key:string;kind:ChangeKind;text:string},[]>("SELECT project_id,key,kind,text FROM assistant_change_topics ORDER BY updated_at DESC LIMIT 24").all();}
  private record(project:string,key:string):(AttentionRecord&{source_at:number})|undefined {const row=this.db.query<Row,[string]>("SELECT * FROM assistant_attention WHERE id=?").get(digest(project+":"+key));if(!row)return;const {refs,...item}=row;return{...item,source_ids:JSON.parse(refs) as string[]};}
  reconcile(attention:AttentionUpdate[],changes:ImportantChange[],changedEvidence:Set<string>,now:number):ImportantChange[]{
    const notifications:ImportantChange[]=[],timestamp=new Date(now).toISOString();
    const fresh=(item:{source_at:number;source_ids:string[]})=>item.source_at>0&&now-item.source_at<=86400_000&&item.source_at<=now+60000&&item.source_ids.some(id=>changedEvidence.has(id));
    const notify=(item:ImportantChange,cycle=0)=>{
      if(!fresh(item))return;
      const id=digest([item.project_id,item.key,item.kind,cycle].join(":"));
      this.db.query("INSERT OR REPLACE INTO assistant_change_topics VALUES(?,?,?,?,?,?,?)").run(id,item.project_id,item.key,item.kind,item.text,JSON.stringify(item.source_ids),timestamp);
      const inserted=this.db.query("INSERT OR IGNORE INTO assistant_notice_keys VALUES(?,?)").run(id,timestamp);
      if(!inserted.changes)return;
      if(["milestone","completed"].includes(item.kind)){
        const sourceKey=digest(item.project_id+":evidence:"+[...item.source_ids].sort().join(":"));
        if(!this.db.query("INSERT OR IGNORE INTO assistant_notice_keys VALUES(?,?)").run(sourceKey,timestamp).changes)return;
      }
      notifications.push(item);
    };
    for(const item of attention){
      const previous=this.record(item.project_id,item.key);
      if(item.status==="resolved"&&!previous)continue;
      if(!previous&&(item.source_at<=0||now-item.source_at>86400_000))continue;
      // Compare fact timestamps, not the time of a repeated summary refresh.
      if(previous&&item.source_at<previous.source_at)continue;
      if(previous&&previous.status!==item.status&&!fresh(item))continue;
      const cycle=(previous?.cycle??0)+(previous?.status==="resolved"&&item.status==="open"?1:0);
      this.db.query("INSERT OR REPLACE INTO assistant_attention VALUES(?,?,?,?,?,?,?,?,?)").run(digest(item.project_id+":"+item.key),item.key,item.project_id,item.status,item.text,JSON.stringify(item.source_ids),cycle,timestamp,item.source_at);
      if(item.status==="open"&&(!previous||previous.status==="resolved"))notify({...item,kind:"decision"},cycle);
      if(item.status==="resolved"&&previous?.status==="open")notify({...item,kind:"resolved"},cycle);
    }
    for(const change of changes){
      const item=this.record(change.project_id,change.key);
      // An open attention item was already emitted above; a rephrased blocker or
      // decision with that key does not become a second reminder.
      if(item&&["decision","blocker","resolved"].includes(change.kind))continue;
      if(["decision","blocker","resolved"].includes(change.kind)&&notifications.some(n=>n.project_id===change.project_id&&n.source_ids.some(id=>change.source_ids.includes(id))))continue;
      notify(change,item?.cycle??0);
    }
    return notifications;
  }
}
