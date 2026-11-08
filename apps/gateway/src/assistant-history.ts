import type {Database} from 'bun:sqlite';
import {array,object,redactSecrets} from './adapters/common.ts';
import {digest,type Evidence} from './assistant-source.ts';
import type {SessionFacts,SessionFact} from './session-memory.ts';
import type {ImportantChange} from './assistant-notifications.ts';

export const HISTORY_KINDS=['result','decision','failure','resolution','milestone','summary'] as const;
export type HistoryKind=typeof HISTORY_KINDS[number];
export interface HistoricalEvent {
  id:string;session_id:string;project_id:string;topic_key:string;kind:HistoryKind;title:string;text:string;
  stage:SessionFact['stage'];status:'open'|'resolved'|null;source_at:string|null;recorded_at:string;source_ids:string[];
}
interface Row extends Omit<HistoricalEvent,'source_ids'> {seq:number;refs:string;search_tokens:string}
export interface HistoryQuery {query?:string;kind?:string;project_id?:string;session_id?:string;since?:string;until?:string;limit?:number;offset?:number;agent_ids?:string[]}
interface Note {session_id:string;project_id:string;title:string;summary:string;source_ids:string[]}
const cut=(text:string,n:number)=>[...redactSecrets(text)].slice(0,n).join('');
const iso=(value:unknown)=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(Date.parse(value)).toISOString():null;
const failure=/(失败|错误|异常|报错|阻塞|超时|不足|故障|崩溃|failed|failure|error|timeout|out.of.memory|\boom\b)/i;
const segmenter=new Intl.Segmenter('zh',{granularity:'word'});

/** Unicode61 alone does not split Chinese sentences. Index overlapping Han
 * bigrams as well as code identifiers, with no embedding/model dependency. */
function terms(text:string,query=false):string[]{
  let value=cut(text,query?300:7000).normalize('NFKC').toLowerCase();
  if(query)value=value.replace(/请帮我|查一下|找一下|为什么|怎么回事|是什么|有没有|之前|上次|最近|历史|那个|这个|我们|一下|相关|过去|的|了|吗/g,' ');
  const found:string[]=[];
  for(const word of value.match(/[a-z0-9][a-z0-9_.-]{0,79}/g)??[]){
    if(!query||!['what','why','when','how','the','was','did','is','of','for','and','about'].includes(word))found.push(word,...word.split(/[_.-]/).filter(s=>s.length>1));
  }
  const grams=(run:string)=>{const chars=[...run];for(let i=0;i<chars.length-1;i++)found.push(chars[i]+chars[i+1]);};
  for(const run of value.match(/\p{Script=Han}+/gu)??[]){
    if(!query){grams(run);continue;}
    // Segment questions so “失败原因” also matches “失败，原因是…”.
    // Keep adjacent single-character technical words together (“显”“存”).
    let singles='';for(const part of segmenter.segment(run)){
      if([...part.segment].length===1){singles+=part.segment;continue;}
      grams(singles);singles='';grams(part.segment);
    }grams(singles);
  }
  return [...new Set(found)].slice(0,query?48:5000);
}
/** Search terms are data, never FTS query syntax. */
function match(text:string,strict=true){return terms(text,true).map(t=>'"'+t.replaceAll('"','""')+'"').join(strict?' AND ':' OR ');}
export function historicalExcerpt(text:string,query:string,max=600):string {
  const safe=redactSecrets(text),tokens=terms(query,true),lower=safe.toLowerCase();
  const at=tokens.map(t=>lower.indexOf(t)).find(n=>n>=0)??0;
  const start=Math.max(0,at-Math.min(100,Math.floor(max/4))),part=safe.slice(start,start+max);
  return (start?'…':'')+part+(start+max<safe.length?'…':'');
}

/** Searchable, app-owned observations derived only from accepted summaries.
 * This store never reads agent files, invokes a model or emits notifications. */
export class AssistantHistory {
  constructor(private db:Database){
    db.exec(`CREATE TABLE IF NOT EXISTS assistant_history_events(
      seq INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL,session_id TEXT NOT NULL,project_id TEXT NOT NULL,
      topic_key TEXT NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,text TEXT NOT NULL,stage TEXT NOT NULL,
      status TEXT,source_at TEXT,recorded_at TEXT NOT NULL,refs TEXT NOT NULL,search_tokens TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS assistant_history_topic ON assistant_history_events(session_id,topic_key,source_at);
      CREATE INDEX IF NOT EXISTS assistant_history_time ON assistant_history_events(source_at);
      CREATE VIRTUAL TABLE IF NOT EXISTS assistant_history_fts USING fts5(search_tokens,content='assistant_history_events',content_rowid='seq',tokenize='unicode61');
      CREATE TRIGGER IF NOT EXISTS assistant_history_insert AFTER INSERT ON assistant_history_events BEGIN
        INSERT INTO assistant_history_fts(rowid,search_tokens) VALUES(new.seq,new.search_tokens); END;
      CREATE TRIGGER IF NOT EXISTS assistant_history_update AFTER UPDATE ON assistant_history_events BEGIN
        INSERT INTO assistant_history_fts(assistant_history_fts,rowid,search_tokens) VALUES('delete',old.seq,old.search_tokens);
        INSERT INTO assistant_history_fts(rowid,search_tokens) VALUES(new.seq,new.search_tokens); END;`);
  }
  private evidence(id:string){return this.db.query<Evidence,[string]>('SELECT * FROM evidence WHERE id=?').get(id);}
  private decode(row:Row):HistoricalEvent {const {seq,refs,search_tokens,...event}=row;return {...event,source_ids:JSON.parse(refs) as string[]};}
  private put(input:Omit<HistoricalEvent,'id'>){
    const evidence=input.source_ids.map(id=>this.evidence(id));
    if(!evidence.length||evidence.some(e=>!e||e.project_id!==input.project_id||e.session_id!==input.session_id))throw new Error('invalid_source_reference');
    const text=cut(input.text,1000).trim();if(!text)return;
    const stage=(input.stage==='accepted'||input.stage==='verified')&&!evidence.some(e=>e!.role==='user')?'reported':input.stage;
    const id='event_'+digest(JSON.stringify([input.session_id,input.kind,stage,input.status,text.replace(/\s+/g,' ')])).slice(0,32);
    const existing=this.get(id),source_ids=[...new Set([...(existing?.source_ids??[]),...input.source_ids])].slice(0,16);
    if(existing&&JSON.stringify(existing.source_ids)===JSON.stringify(source_ids))return;
    const context=source_ids.slice(0,4).map(id=>cut(this.evidence(id)?.text??'',1200)).join('\n');
    const search=terms(input.title+' '+text+' '+context).join(' ');
    this.db.query(`INSERT INTO assistant_history_events(id,session_id,project_id,topic_key,kind,title,text,stage,status,source_at,recorded_at,refs,search_tokens)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET refs=excluded.refs,search_tokens=excluded.search_tokens`)
      .run(id,input.session_id,input.project_id,input.topic_key,input.kind,cut(input.title,160),text,stage,input.status,input.source_at,input.recorded_at,JSON.stringify(source_ids),search);
  }
  recordSession(note:Note,facts:SessionFacts,recordedAt=new Date().toISOString()){
    const evidence=note.source_ids.map(id=>this.evidence(id)).filter((e):e is Evidence=>!!e);
    const base={session_id:note.session_id,project_id:note.project_id,title:note.title,recorded_at:recordedAt};
    const observed=evidence.map(e=>iso(e.timestamp)).filter((s):s is string=>!!s).sort().at(-1)??null;
    this.put({...base,topic_key:'summary',kind:'summary',text:note.summary,source_ids:note.source_ids,source_at:observed,stage:'reported',status:null});
    for(const fact of facts.latest_results)this.put({...base,...fact,topic_key:'result:'+fact.key,kind:'result',status:null,source_at:iso(fact.observed_at)});
    for(const fact of facts.open_questions){
      if(fact.status!=='resolved'&&!failure.test(fact.text))continue;
      this.put({...base,...fact,topic_key:'issue:'+fact.key,kind:fact.status==='resolved'?'resolution':'failure',status:fact.status??null,source_at:iso(fact.observed_at)});
    }
  }
  recordChanges(changes:ImportantChange[],acceptedSessions:Set<string>,recordedAt=new Date().toISOString()){
    for(const change of changes){
      const sources=change.source_ids.map(id=>this.evidence(id));
      if(sources.some(e=>!e||e.project_id!==change.project_id||!acceptedSessions.has(e.session_id)))continue;
      for(const session_id of new Set(sources.map(e=>e!.session_id))){
        const own=sources.filter(e=>e!.session_id===session_id) as Evidence[];
        this.put({session_id,project_id:change.project_id,title:own[0].title,topic_key:'change:'+change.key,
          kind:change.kind==='blocker'?'failure':change.kind==='completed'?'result':change.kind==='resolved'?'resolution':change.kind,
          text:change.text,stage:'reported',status:change.kind==='resolved'?'resolved':change.kind==='blocker'?'open':null,
          source_at:own.map(e=>iso(e.timestamp)).filter((s):s is string=>!!s).sort().at(-1)??null,recorded_at:recordedAt,source_ids:own.map(e=>e.id)});
      }
    }
  }
  /** One local migration of already accepted data. No transcript replay or API
   * calls. Old revisions remain searchable after the rolling snapshot changes. */
  backfill(){
    if(this.db.query("SELECT key FROM meta WHERE key='history_events_backfill_v1'").get())return;
    this.db.transaction(()=>{
      let skipped=0;
      const migrate=(work:()=>void)=>{try{this.db.transaction(work)();}catch(error){if(error instanceof Error&&error.message==='invalid_source_reference')skipped++;else throw error;}};
      for(const row of this.db.query<{session_id:string;note:string},[]>('SELECT session_id,note FROM session_memory_history ORDER BY rowid').iterate()){
        const value=object(JSON.parse(row.note)),note=object(value.note),facts=object(value.facts);
        if(note.session_id===row.session_id&&Array.isArray(note.source_ids)&&typeof note.summary==='string')migrate(()=>this.recordSession(note as unknown as Note,{current_task:null,latest_results:array(facts.latest_results) as SessionFact[],open_questions:array(facts.open_questions) as SessionFact[]}));
      }
      for(const row of this.db.query<{note:string;updated_at:string},[]>('SELECT note,updated_at FROM sources').iterate()){
        const note=JSON.parse(row.note) as Note;migrate(()=>this.recordSession(note,{current_task:null,latest_results:[],open_questions:[]},row.updated_at));
      }
      const changes=this.db.query<{key:string;project_id:string;kind:ImportantChange['kind'];text:string;refs:string;updated_at:string},[]>('SELECT * FROM assistant_change_topics').all();
      const accepted=new Set(this.db.query<{id:string},[]>('SELECT id FROM sources').all().map(s=>s.id));
      for(const c of changes)this.recordChanges([{...c,source_ids:JSON.parse(c.refs),source_at:0}],accepted,c.updated_at);
      this.db.query("INSERT INTO meta VALUES('history_events_backfill_v1','1')").run();
      this.db.query("INSERT OR REPLACE INTO meta VALUES('history_events_backfill_skipped',?)").run(String(skipped));
    })();
  }
  status(){return {events:this.db.query<{n:number},[]>('SELECT count(*) AS n FROM assistant_history_events').get()!.n,search_engine:'sqlite_fts5',semantic_search:false};}
  get(id:string):HistoricalEvent|null {const row=this.db.query<Row,[string]>('SELECT * FROM assistant_history_events WHERE id=?').get(id);return row?this.decode(row):null;}
  search(input:HistoryQuery={}){
    const {query='',kind,project_id,session_id,since,until,limit=20,offset=0,agent_ids}=input;
    if(typeof query!=='string'||[...query].length>300||kind!==undefined&&!HISTORY_KINDS.includes(kind as HistoryKind)||!Number.isInteger(limit)||limit<1||limit>50||!Number.isInteger(offset)||offset<0||offset>10000||[project_id,session_id].some(s=>s!==undefined&&(typeof s!=='string'||s.length>200))||[since,until].some(t=>t!==undefined&&!iso(t))||since&&until&&Date.parse(since)>Date.parse(until))throw new Error('invalid_history_query');
    let matched=match(query);const where:string[]=[],params:(string|number)[]=[];
    if(query.trim()&&!matched)return {items:[] as HistoricalEvent[],total:0,has_more:false};
    const from='assistant_history_events e'+(matched?' JOIN assistant_history_fts ON assistant_history_fts.rowid=e.seq':'');
    if(matched){where.push('assistant_history_fts MATCH ?');params.push(matched);}
    for(const [field,value] of [['kind',kind],['project_id',project_id],['session_id',session_id]] as const)if(value!==undefined){where.push('e.'+field+'=?');params.push(value);}
    if(since){where.push('e.source_at>=?');params.push(iso(since)!);}if(until){where.push('e.source_at<=?');params.push(iso(until)!);}
    if(agent_ids){if(!agent_ids.length)return {items:[] as HistoricalEvent[],total:0,has_more:false};where.push('('+agent_ids.map(()=>"e.session_id LIKE ? ESCAPE '\\'").join(' OR ')+')');params.push(...agent_ids.map(a=>a.replace(/[\\%_]/g,'\\$&')+':%'));}
    const clause=where.length?' WHERE '+where.join(' AND '):'';
    const count=()=>this.db.query<{n:number},(string|number)[]>('SELECT count(*) AS n FROM '+from+clause).get(...params)!.n;
    let total=count();if(matched&&!total){matched=match(query,false);params[0]=matched;total=count();}
    const rank=matched?'assistant_history_fts.rank ASC,':'',preferText=matched&&[...query.trim()].length<=60;
    const preferred=preferText?"CASE WHEN e.text LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,":'';
    const rows=this.db.query<Row,(string|number)[]>('SELECT e.* FROM '+from+clause+' ORDER BY '+preferred+rank+'e.source_at DESC,e.seq DESC LIMIT ? OFFSET ?').all(...params,...(preferText?['%'+query.trim().replace(/[\\%_]/g,'\\$&')+'%']:[]),limit,offset);
    return {items:rows.map(row=>({...this.decode(row),text:cut(row.text,180)})),total,has_more:offset+rows.length<total};
  }
  recall(query:string,agentIds:string[]):HistoricalEvent[]{
    const hits=this.search({query:cut(query,300),limit:4,agent_ids:agentIds}).items,result=new Map<string,HistoricalEvent>();
    for(const hit of hits){
      result.set(hit.id,this.get(hit.id)!);
      const latest=this.db.query<Row,[string,string]>('SELECT * FROM assistant_history_events WHERE session_id=? AND topic_key=? ORDER BY source_at DESC,seq DESC LIMIT 1').get(hit.session_id,hit.topic_key);
      if(latest)result.set(latest.id,this.decode(latest));
      if(result.size>=6)break;
    }
    return [...result.values()].slice(0,6);
  }
}
