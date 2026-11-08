import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import type { QuotaWindow, Session } from "../../../../packages/protocol/src/index.ts";
import { addMessage, eventUUID, exists, iso, JsonlReader, measured, newSession, number, object, project, ratio, string, tokens, type ObjectValue, type TranscriptSource } from "./common.ts";
import type {MonitorSignal} from "../monitor-signals.ts";
import type {CodexRuntimeStatus} from "../codex-runtime-status.ts";

interface ThreadRow { id: string; rollout_path: string; name: string | null; cwd: string; model: string | null; updated_at: number }
export interface CodexJournal {
  session: Session;
  openTurn: string | null;
  terminalAt: string | null;
  quota: QuotaWindow[];
  quotaObservedAt: string | null;
  pending:Map<string,{blocking:boolean;at:string}>;
  signals:MonitorSignal[];
}
export const initCodex = (): CodexJournal => ({ session: newSession("codex", "pending", "rollout"), openTurn: null, terminalAt: null, quota: [], quotaObservedAt: null,pending:new Map(),signals:[] });

export function reduceCodex(journal: CodexJournal, row: ObjectValue) {
  const p = object(row.payload), at = iso(row.timestamp), s = journal.session;
  const signal=(kind:MonitorSignal["kind"],id:string,topic:string,blocking?:boolean)=>{if(at){journal.signals.push({kind,id,topic,blocking,at,session_id:s.id,turn_id:journal.openTurn??"unknown"});if(journal.signals.length>64)journal.signals.shift();}};
  if(row.type==="response_item"&&p.type==="function_call"&&at&&typeof p.call_id==="string"){
    const name=String(p.name).split(".").at(-1)!;
    if(["request_user_input","request_user_input_async","request_permissions"].includes(name)){
      const blocking=name!=="request_user_input_async";journal.pending.set(p.call_id,{blocking,at});signal("input_requested",p.call_id,p.call_id,blocking);
    }
  }
  if(row.type==="response_item"&&p.type==="function_call_output"&&typeof p.call_id==="string"&&journal.pending.get(p.call_id)?.blocking){journal.pending.delete(p.call_id);signal("input_resolved",p.call_id+":resolved",p.call_id);}
  if(row.type==="response_item"&&p.type==="message"&&p.role==="user"){
    for(const part of Array.isArray(p.content)?p.content:[]){const text=object(part).text;if(typeof text!=="string"||!text.startsWith("<send_user_message_question_reply>"))continue;
      try{const values=JSON.parse(text.replace(/^<send_user_message_question_reply>\s*/,"").replace(/\s*<\/send_user_message_question_reply>$/, ""));for(const value of Array.isArray(values)?values:[]){let key=object(value).questionItemId;if(typeof key==="string")try{key=JSON.parse(key);}catch{}if(Array.isArray(key)&&typeof key[1]==="string"&&journal.pending.has(key[1])){journal.pending.delete(key[1]);signal("input_resolved",key[1]+":resolved",key[1]);}}}catch{}
    }
  }
  if (row.type === "turn_context") s.model = string(p.model) ?? s.model;
  if (row.type === "response_item" && p.type === "message") {
    if (p.role === "assistant" && p.channel !== undefined && !["final", "commentary"].includes(String(p.channel))) return;
    addMessage(s, p.role, p.content, `${s.agent_id}:${at}:${s.messages.length}:${String(p.role)}`, at);
  }
  if (row.type !== "event_msg") return;
  if (at) s.last_activity_at = at;
  if (p.type === "task_started" || p.type === "turn_started") {
    for(const id of journal.pending.keys())signal("input_resolved",id+":turn_start",id);journal.pending.clear();
    journal.openTurn = string(p.turn_id) ?? string(p.root_turn_id) ?? at;
    s.started_at = iso(p.started_at) ?? at;
    journal.terminalAt = null;
    s.state = "unknown"; // promoted only with live writer evidence on each observation
    s.status_source = "codex.task_started;writer_not_checked";
  } else if (["task_complete", "task_completed", "turn_complete", "turn_aborted", "task_failed"].includes(String(p.type))) {
    for(const id of journal.pending.keys())signal("input_resolved",id+":terminal",id);journal.pending.clear();
    journal.openTurn = null;
    journal.terminalAt = iso(p.completed_at) ?? at;
    s.state = p.type === "task_failed" ? "error" : p.type === "turn_aborted" ? "idle" : "completed";
    s.status_quality = "confirmed";
    s.status_source = `codex.${String(p.type)}`;
    s.status_observed_at = at;
    const duration = number(p.duration_ms);
    s.run_duration_seconds = duration === null ? null : Math.floor(duration / 1000);
    s.completion_event_id = s.state === "completed" ? eventUUID(`codex:${String(p.turn_id ?? p.root_turn_id)}:${at}`) : null;
    s.completion_event_at = s.state === "completed" ? journal.terminalAt : null;
  } else if(p.type==="item_completed"){
    const item=object(p.item),kind=String(item.type);
    if(["CommandExecution","McpToolCall"].includes(kind)&&["failed","completed"].includes(String(item.status))&&typeof item.id==="string"){
      const topic=eventUUID(kind+":"+(kind==="CommandExecution"?JSON.stringify(item.command):String(item.server)+":"+String(item.tool)));
      signal(item.status==="failed"?"tool_failed":"tool_recovered",item.id,topic);
    }
  } else if (p.type === "user_message" && s.messages.at(-1)?.text !== p.message) {
    addMessage(s, "user", p.message, `legacy-user:${at}`, at);
  } else if (p.type === "agent_message" && s.messages.at(-1)?.text !== p.message) {
    addMessage(s, "assistant", p.message, `legacy-assistant:${at}`, at);
  } else if (p.type === "token_count") {
    const info = object(p.info), total = object(info.total_token_usage), last = object(info.last_token_usage);
    const input = tokens(total.input_tokens), read = tokens(total.cached_input_tokens), write = tokens(total.cache_write_input_tokens);
    s.usage = {
      input_tokens: measured(input, "codex.total_token_usage.input_tokens (includes cache)", at),
      output_tokens: measured(tokens(total.output_tokens), "codex.total_token_usage.output_tokens", at),
      cache_read_tokens: measured(read, "codex.total_token_usage.cached_input_tokens", at),
      cache_write_tokens: measured(write, "codex.total_token_usage.cache_write_input_tokens", at),
      cache_ratio: measured(ratio(read, input), "codex.cache_read / inclusive_input", at),
      context_ratio: measured(ratio(tokens(last.input_tokens), tokens(info.model_context_window)), "codex.last_request_input / model_context_window", at, "estimated"),
    };
    const limits = object(p.rate_limits);
    // Other model-specific buckets must not replace the account's Codex allowance.
    // An absent rate_limits field is no new observation; retain the last valid one until expiry.
    if (limits.limit_id !== "codex" || at === null) return;
    const quota:QuotaWindow[] = [limits.primary, limits.secondary].flatMap(value => {
      const w = object(value), used = number(w.used_percent), minutes = number(w.window_minutes);
      if (used === null || used > 100 || minutes === null || minutes === 0 || !Number.isInteger(minutes)) return [];
      return [{ window_minutes: minutes, used_ratio: measured(used / 100, `codex.rate_limits.${String(limits.limit_id ?? "unknown")}`, at), resets_at: typeof w.resets_at === "number" ? iso(w.resets_at * 1000) : null }];
    });
    // Empty rate-limit events are not an observation of zero/unknown allowance.
    if(quota.length){journal.quotaObservedAt=at;journal.quota=quota;}
  }
}

/** A reset deadline triggers confirmation; it never implies a newly full allowance. */
export function currentCodexQuota(windows:QuotaWindow[],now:string):QuotaWindow[]{
 const clock=Date.parse(now);
 return windows.flatMap(window=>{
  const at=Date.parse(window.used_ratio.observed_at??"");
  if(!Number.isFinite(at)||at>clock+120000)return [];
  const reset=window.resets_at?Date.parse(window.resets_at):null;
  if(reset!==null&&!Number.isFinite(reset))return [];
  return [{...structuredClone(window),health:window.health==="stale"||reset!==null&&clock>=reset?"stale" as const:"fresh" as const}];
 });
}

export class CodexAdapter {
  readonly sources = new Map<string,TranscriptSource>();
  private reader = new JsonlReader(initCodex, reduceCodex);
  private lastGood = new Map<string, Session>();
  private observedSignals:MonitorSignal[]=[];
  signals(){return this.observedSignals;}
  constructor(private home: string) {}
  async collect(writers: Set<string>, now: string,runtime:ReadonlyMap<string,CodexRuntimeStatus>=new Map()): Promise<{ sessions: Session[]; count: number; quota: QuotaWindow[] }> {
    this.sources.clear();
    this.observedSignals=[];
    const path = join(this.home, ".codex/state_5.sqlite");
    if (!await exists(path)) { this.reader.retain([]); this.lastGood.clear(); return { sessions: [], count: 0, quota: [] }; }
    const db = new Database(path, { readonly: true, create: false });
    let threads: ThreadRow[];
    try { threads = db.query<ThreadRow, []>("SELECT id, rollout_path, name, cwd, model, updated_at FROM threads WHERE archived=0 ORDER BY updated_at DESC").all(); }
    finally { db.close(); }
    const activeIds = new Set([...writers].filter(p => p.includes("/thread-writer-locks/")).map(p => p.split("/").at(-1)?.replace(/\.lock$/, "")));
    const candidates = threads.filter((t, i) => i < 30 || activeIds.has(t.id));
    this.reader.retain(candidates.map(t => resolve(t.rollout_path)));
    const keep = new Set(candidates.map(t => t.id));
    for (const id of this.lastGood.keys()) if (!keep.has(id)) this.lastGood.delete(id);
    const sessions: Session[] = [];
    let quota: QuotaWindow[] = [];
    let quotaAt = "";
    for (const t of candidates) {
      const logPath = resolve(t.rollout_path);
      if (!logPath.startsWith(`${resolve(this.home, ".codex/sessions")}/`)) continue;
      this.sources.set(`codex:rollout:${t.id}`,{path:logPath,project_dir:t.cwd});
      try {
        const parsed = await this.reader.read(logPath), journal = parsed.value;
        const s = structuredClone(journal.session);
        s.id = `codex:rollout:${t.id}`; s.provider_session_id = t.id;
        // name is the sidebar conversation title; title contains the initial message preview.
        // Never derive a display title from message content when the sidebar name is absent.
        s.title = t.name?.trim() || "未命名会话"; s.project_name = project(t.cwd); s.model ??= t.model;
        this.observedSignals.push(...journal.signals.map(signal=>({...signal,session_id:s.id})));
        s.last_activity_at ??= iso(t.updated_at * 1000);
        s.transcript_truncated ||= parsed.truncated;
        if (journal.openTurn) {
          const live = writers.has(logPath) || activeIds.has(t.id);
          const pending=[...journal.pending.values()].find(p=>p.blocking);
          s.state = live ? pending?"waiting_user":"running" : "unknown";
          s.status_quality = live ? "confirmed" : "unknown";
          s.status_source = live ? pending?"codex.explicit_input_request + live_writer_fd":"codex.task_started + live_writer_fd" : "codex.unclosed_turn; no_live_writer";
          s.status_observed_at = pending&&live?pending.at:now;
          s.run_duration_seconds = s.started_at ? Math.max(0, Math.floor((Date.parse(now) - Date.parse(s.started_at)) / 1000)) : null;
        }
        const liveStatus=runtime.get(t.id);
        if(liveStatus){const changed=this.lastGood.get(t.id)?.state!==liveStatus;s.state=liveStatus;s.status_quality="confirmed";s.status_source="codex.thread/list.runtime_status";s.status_observed_at=changed?now:this.lastGood.get(t.id)?.status_observed_at??now;}
        const observed = journal.quotaObservedAt ?? "";
        if (observed > quotaAt) { quota = structuredClone(journal.quota); quotaAt = observed; }
        sessions.push(s);
        this.lastGood.set(t.id, s);
      } catch {
        const old = this.lastGood.get(t.id);
        if (old) sessions.push({ ...structuredClone(old), observation_health: "stale" });
      }
    }
    quota = currentCodexQuota(quota,now);
    return { sessions, count: threads.length, quota };
  }
}
