import { open, stat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Session } from "../../../packages/protocol/src/index.ts";
import { array, cleanPublicMessage, iso, object, string, type ObjectValue, type TranscriptSource } from "./adapters/common.ts";

export const digest=(value:string)=>createHash("sha256").update(value).digest("hex");
export interface SourceCursor { inode:number; offset:number; size:number; modified:number; partial:boolean;stored_size?:number }
export interface Evidence { id:string; session_id:string; project_id:string; title:string; role:"user"|"assistant"; timestamp:string|null; text:string }
export interface SourceBatch { cursor:SourceCursor; evidence:Evidence[]; project_id:string; partial:boolean }
const BLOCK=1024*1024, HEAD=128*1024;

function publicRow(agent:Session["agent_id"],row:ObjectValue): {role:"user"|"assistant";text:string;timestamp:string|null;native:string|null;legacy:boolean}|null {
  let role:unknown,content:unknown,native:string|null=null,at=iso(row.timestamp??row.time),legacy=false;
  if(agent==="codex") {
    const p=object(row.payload);
    if(row.type==="response_item" && p.type==="message") {
      if(p.role==="assistant" && p.channel!==undefined && !["final","commentary"].includes(String(p.channel))) return null;
      role=p.role;content=p.content;native=string(p.id);
    } else if(row.type==="event_msg" && ["user_message","agent_message"].includes(String(p.type))) {
      role=p.type==="user_message"?"user":"assistant";content=p.message;legacy=true;
    } else return null;
  } else if(agent==="claude") {
    if(row.isSidechain===true || row.isMeta===true || !["user","assistant"].includes(String(row.type))) return null;
    role=row.type;content=object(row.message).content;native=string(row.uuid)??string(object(row.message).id);
  } else {
    const data=object(row.data);
    if(row.type==="user/message") {role="user";content=data.content;native=string(data.id)??String(row.seq);}
    else if(row.type==="assistant/message") {role="assistant";content=object(data.message).content;native=string(object(data.message).id)??String(row.seq);}
    else return null;
  }
  const text=cleanPublicMessage(role,content);
  return text && (role==="user" || role==="assistant")?{role,text,timestamp:at,native,legacy}:null;
}

/** Public-message reader independent of the 12-message UI cache.
 * Initial large histories use a labeled head/tail sample; subsequent reads advance
 * a durable byte cursor. Source pointers come only from the existing adapters. */
export async function readAssistantSource(session:Session,source:TranscriptSource,previous:SourceCursor|null,charBudget=4500):Promise<SourceBatch> {
  const meta=await stat(source.path);
  const canonical=source.project_dir?await realpath(source.project_dir).catch(()=>resolve(source.project_dir!)):session.id;
  const projectId="project_"+digest(canonical).slice(0,20);
  if(previous&&previous.inode===meta.ino&&previous.modified===meta.mtimeMs&&previous.offset===previous.size&&(previous.stored_size??(!source.compressed?previous.size:null))===meta.size)return{cursor:previous,evidence:[],project_id:projectId,partial:previous.partial};
  let full:Buffer|undefined;
  if(source.compressed) {
    if(meta.size>8*BLOCK) throw new Error("compressed_source_too_large");
    full=Buffer.from(Bun.zstdDecompressSync(await Bun.file(source.path).bytes()));
    if(full.length>128*BLOCK) throw new Error("expanded_source_too_large");
  }
  const size=full?.length??meta.size;
  const reset=!previous || previous.inode!==meta.ino || previous.offset>size || (previous.size===size && previous.modified!==meta.mtimeMs);
  if(!reset && previous.offset===size && previous.modified===meta.mtimeMs) return {cursor:previous,evidence:[],project_id:projectId,partial:previous.partial};
  const file=full?null:await open(source.path,"r");
  async function read(offset:number,length:number):Promise<Buffer> {
    if(full) return full.subarray(offset,offset+length);
    const buffer=Buffer.alloc(length);const {bytesRead}=await file!.read(buffer,0,length,offset);return buffer.subarray(0,bytesRead);
  }
  const parsed: (Evidence&{legacy:boolean})[]=[];
  let partial=previous?.partial??false,offset=0;
  function parse(buffer:Buffer,start:number,skipFirst:boolean) {
    let begin=skipFirst?buffer.indexOf(10)+1:0;
    if(skipFirst && !begin) return;
    for(let end=buffer.indexOf(10,begin);end>=0;end=buffer.indexOf(10,begin)) {
      try {
        const row=object(JSON.parse(buffer.subarray(begin,end).toString("utf8"))),message=publicRow(session.agent_id,row);
        if(message) parsed.push({id:"ref_"+digest(session.id+":"+(message.native??String(start+begin))+":"+message.role+":"+digest(message.text)).slice(0,24),session_id:session.id,
          project_id:projectId,title:session.title,role:message.role,timestamp:message.timestamp,text:[...message.text].slice(0,6000).join(""),legacy:message.legacy});
      } catch {partial=true;}
      begin=end+1;
    }
  }
  try {
    if(reset && size>BLOCK) {
      partial=true;
      parse(await read(0,Math.min(HEAD,size)),0,false);
      const start=Math.max(0,size-BLOCK),tail=await read(start,Math.min(BLOCK,size-start));
      parse(tail,start,start>0);offset=start+Math.max(0,tail.lastIndexOf(10)+1);
    } else if(!reset && size-previous.offset>BLOCK) {
      // Tool-heavy active chats can grow by megabytes between refreshes. Keep
      // a bounded delta plus the newest tail instead of lagging behind tools.
      partial=true;
      parse(await read(previous.offset,BLOCK/2),previous.offset,false);
      const start=size-BLOCK/2,tail=await read(start,BLOCK/2);
      parse(tail,start,true);offset=start+Math.max(0,tail.lastIndexOf(10)+1);
    } else {
      const start=reset?0:previous.offset,buffer=await read(start,Math.min(BLOCK,size-start));
      parse(buffer,start,false);offset=start+Math.max(0,buffer.lastIndexOf(10)+1);
      if(buffer.length===BLOCK && offset===start) {offset=start+buffer.length;partial=true;}
    }
  } finally {await file?.close();}
  const hasCanonical=parsed.some(e=>!e.legacy),unique=new Map<string,Evidence>();
  for(const e of parsed) if(!hasCanonical || !e.legacy) unique.set(e.id,e);
  const all=[...unique.values()];const selected:Evidence[]=[];
  let available=charBudget;
  const first=reset?all.find(e=>e.role==="user"):undefined;
  if(first) {const text=[...first.text].slice(0,Math.min(900,available)).join("");selected.push({...first,text});available-=[...text].length;partial ||= text!==first.text;}
  for(let i=all.length-1;i>=0 && available>0 && selected.length<32;--i) {
    const e=all[i];if(e.id===first?.id) continue;
    const text=[...e.text].slice(0,available).join("");selected.splice(first?1:0,0,{...e,text});available-=[...text].length;partial ||= text!==e.text;
  }
  partial ||= selected.length<all.length || offset<size;
  return {cursor:{inode:meta.ino,offset,size,modified:meta.mtimeMs,partial,stored_size:meta.size},evidence:selected,project_id:projectId,partial};
}
