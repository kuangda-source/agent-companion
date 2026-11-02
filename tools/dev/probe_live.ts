/** Independent acceptance check against source files. Reports hashes/counts, never conversation bodies. */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFile, stat } from "node:fs/promises";
import type { Session, Snapshot } from "../../packages/protocol/src/index.ts";

const port=Number(process.env.PORT??8736);
if(!Number.isInteger(port)||port<1||port>65535) throw new Error("Invalid PORT");
const root=resolve(import.meta.dir,"../.."), home=homedir(), base=`http://127.0.0.1:${port}`;
const token=await readFile(join(root,".runtime/gateway.token"),"utf8");
const headers={authorization:`Bearer ${token}`};
function check(value:unknown,label:string):asserts value { if(!value) throw new Error(`Live acceptance failed: ${label}`); }
const response=await fetch(`${base}/api/v1/state`,{headers}); check(response.ok,"authenticated snapshot");
const raw=await response.text();
const validate=Bun.spawn([join(root,".venv-dev/bin/python"),join(root,"tools/dev/validate_snapshot.py")],{stdin:new TextEncoder().encode(raw),stdout:"pipe",stderr:"pipe"});
check(await validate.exited===0,`schema: ${await new Response(validate.stderr).text()}`);
const snapshot:Snapshot=JSON.parse(raw); check(snapshot.data_source==="live","source must be live");
check((await fetch(`${base}/api/v1/state`)).status===401,"unauthenticated conversation access denied");
check(((await stat(join(root,".runtime/gateway.token"))).mode & 0o777)===0o600,"runtime token is 0600");
const proc=Bun.spawn(["/usr/sbin/lsof","-nP","-c","codex","-c","DeepSeek","-Fn"],{stdout:"pipe",stderr:"ignore"});
const openFiles=new Set((await new Response(proc.stdout).text()).split("\n").filter(x=>x[0]==="n").map(x=>x.slice(1))); await proc.exited;
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
const sourceExcerpt=(s:string)=>[...s.trim()].slice(0,2400).join("");
type Row={type?:string;timestamp?:string;payload?:{type?:string;role?:string;channel?:string;content?:{type:string;text?:string}[];message?:string};seq?:number;data?:{turn?:number;reason?:{kind?:string};message?:{content:{type:string;text?:string}[]}}};
const sourceRows=(data:string):Row[]=>data.split("\n").flatMap(line=>{try{return [JSON.parse(line) as Row];}catch{return [];}});
const publicPart=(content:{type:string;text?:string}[]|undefined)=>content?.filter(p=>["text","input_text","output_text"].includes(p.type)).map(p=>p.text??"").join("\n").trim()??"";
const proofs:Record<string,unknown>[]=[];
const db=new Database(join(home,".codex/state_5.sqlite"),{readonly:true,create:false});
try {
  for(const summary of snapshot.sessions.filter(s=>s.agent_id!=="claude")) {
    const detail:Session=await (await fetch(`${base}/api/v1/sessions/${encodeURIComponent(summary.id)}`,{headers})).json() as Session;
    const last=detail.messages.findLast(m=>m.role==="assistant"); check(last,"public assistant message");
    let texts:string[]=[], terminal:Row|undefined;
    let writer=false;
    if(summary.agent_id==="codex") {
      const row=db.query<{rollout_path:string;title:string},[string]>("SELECT rollout_path,title FROM threads WHERE id=?").get(summary.provider_session_id);
      check(row,"provider ID exists in readonly source index");
      const lines=sourceRows(await readFile(row.rollout_path,"utf8"));
      texts=lines.flatMap(r=>{
        const p=r.payload;
        if(r.type==="response_item" && p?.type==="message" && p.role==="assistant" && (!p.channel || ["final","commentary"].includes(p.channel))) return [publicPart(p.content)];
        if(r.type==="event_msg" && p?.type==="agent_message") return [p.message??""];
        return [];
      });
      terminal=lines.findLast(r=>r.type==="event_msg" && ["task_started","task_complete","task_completed","turn_aborted"].includes(r.payload?.type??""));
      writer=openFiles.has(row.rollout_path) || openFiles.has(join(home,".codex/thread-writer-locks",summary.provider_session_id+".lock"));
      if(summary.state==="running") check(writer && ["task_started","turn_started"].includes(terminal?.payload?.type??""),"running requires unmatched start and a live writer FD");
    } else {
      const glob=new Bun.Glob(`*/${summary.provider_session_id}/session.v4.jsonl.zstd`);
      const files=[...glob.scanSync({cwd:join(home,".dsh/sessions"),absolute:true})]; check(files.length===1,"DeepSeek source identity");
      const lines=sourceRows(Bun.zstdDecompressSync(await Bun.file(files[0]).bytes()).toString("utf8"));
      texts=lines.filter(r=>r.type==="assistant/message").map(r=>publicPart(r.data?.message?.content));
      terminal=lines.findLast(r=>r.type==="turn/start" || r.type==="turn/end");
      if(summary.state==="completed") check(terminal?.type==="turn/end" && terminal.data?.reason?.kind==="completed","DeepSeek explicit terminal event");
    }
    check(texts.filter(Boolean).some(t=>hash(sourceExcerpt(t))===hash(last.text)),`public message matches source hash: ${summary.agent_id}:${summary.provider_session_id}`);
    proofs.push({agent:summary.agent_id,provider_session_id:summary.provider_session_id,state:summary.state,status_quality:summary.status_quality,
      source_terminal_type:terminal?.payload?.type??terminal?.type,live_writer:writer,public_message_count:detail.messages.length,
      public_message_hash:hash(last.text),source_message_match:true,context_quality:detail.usage.context_ratio.quality});
  }
} finally { db.close(); }
const report={observed_at:new Date().toISOString(),source:"live",schema:"PASS",snapshot_bytes:Buffer.byteLength(raw),authentication:"PASS",token_mode:"0600",
  agents:snapshot.agents.map(a=>({id:a.id,state:a.state,discovered:a.session_count,running:a.running_count,health:a.observation_health})),
  proofs,claude_code_real_acceptance:"NOT VERIFIED: user deferred until a usable Code session exists"};
await Bun.write(join(root,"reports/live-source-proof.json"),JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify({schema:"PASS",authentication:"PASS",snapshot_bytes:report.snapshot_bytes,source_message_matches:proofs.length,agents:report.agents},null,2));
