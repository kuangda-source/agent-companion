import { basename, join } from "node:path";
import { stat } from "node:fs/promises";
import type { Session } from "../../../../packages/protocol/src/index.ts";
import { addMessage, array, children, eventUUID, iso, JsonlReader, measured, newSession, number, object, project, ratio, string, tokens, type ObjectValue, type TranscriptSource } from "./common.ts";

export interface ClaudeJournal { session: Session; usageById: Map<string, { input: number; output: number; read: number; write: number }>; lastRequestInput: number | null; projectDir?: string }
export const initClaude = (): ClaudeJournal => ({ session: newSession("claude", "pending", "code-jsonl"), usageById: new Map(), lastRequestInput: null });
export function reduceClaude(j: ClaudeJournal, row: ObjectValue) {
  const s = j.session, at = iso(row.timestamp), m = object(row.message);
  if(typeof row.cwd==="string") j.projectDir=row.cwd;
  if (row.isSidechain === true) return;
  s.provider_session_id = string(row.sessionId) ?? s.provider_session_id;
  s.id = `claude:code-jsonl:${s.provider_session_id}`;
  s.project_name = project(row.cwd) ?? s.project_name;
  if (at) s.last_activity_at = at;
  if (row.type === "summary") s.title = string(row.summary) ?? s.title;
  if (row.type === "custom-title") s.title = string(row.customTitle) ?? s.title;
  if (row.type === "user" && row.isMeta !== true) {
    addMessage(s, "user", m.content, string(row.uuid) ?? `user:${at}`, at);
    if (s.title === "未命名会话" && s.messages.length) s.title = [...s.messages[0].text].slice(0, 64).join("");
    s.state = "unknown"; s.status_quality = "unknown"; s.status_source = "claude.user_message; runtime_not_observed";
  }
  if (row.type === "assistant") {
    s.model = string(m.model) ?? s.model;
    addMessage(s, "assistant", m.content, string(row.uuid) ?? `assistant:${at}`, at);
    const u = object(m.usage), id = string(m.id);
    const input = tokens(u.input_tokens), output = tokens(u.output_tokens), read = tokens(u.cache_read_input_tokens), write = tokens(u.cache_creation_input_tokens);
    if (id && input !== null && output !== null && read !== null && write !== null) {
      // Streaming updates reuse message.id; replace instead of double counting.
      j.usageById.set(id, { input, output, read, write });
      j.lastRequestInput = input + read + write;
      const totals = [...j.usageById.values()].reduce((a, b) => ({ input: a.input + b.input + b.read + b.write, output: a.output + b.output, read: a.read + b.read, write: a.write + b.write }), { input: 0, output: 0, read: 0, write: 0 });
      s.usage = {
        input_tokens: measured(totals.input, "claude.input + cache_read + cache_creation", at),
        output_tokens: measured(totals.output, "claude.message.usage.output_tokens", at),
        cache_read_tokens: measured(totals.read, "claude.message.usage.cache_read_input_tokens", at),
        cache_write_tokens: measured(totals.write, "claude.message.usage.cache_creation_input_tokens", at),
        cache_ratio: measured(ratio(totals.read, totals.input), "claude.cache_read / inclusive_input", at),
        context_ratio: measured(null, "claude.context_window_not_observed", null),
      };
    }
    // A transcript write/stop_reason alone is not a current Desktop runtime status.
    s.status_source = "claude.transcript; runtime_not_observed";
  }
  if (row.type === "system" && row.subtype === "turn_duration") {
    s.state = "completed"; s.status_quality = "confirmed"; s.status_source = "claude.system.turn_duration";
    s.status_observed_at = at;
    const duration = number(row.durationMs);
    s.run_duration_seconds = duration === null ? null : Math.floor(duration / 1000);
    s.completion_event_id = eventUUID(`claude:${s.provider_session_id}:${at}`);
    s.completion_event_at = at;
  }
  if (row.type === "result") {
    s.state = row.is_error === true ? "error" : "completed"; s.status_quality = "confirmed";
    s.status_source = "claude.result"; s.status_observed_at = at;
    s.completion_event_id = s.state === "completed" ? eventUUID(`claude:${s.provider_session_id}:${at}`) : null;
    s.completion_event_at = s.state === "completed" ? at : null;
  }
  const tools = array(m.content).map(object).filter(c => c.type === "tool_use");
  if (tools.some(t => t.name === "AskUserQuestion")) {
    s.state = "unknown"; s.status_quality = "unknown"; s.status_source = "claude.question_requested; settlement_not_observed";
  }
}

export class ClaudeAdapter {
  readonly sources = new Map<string,TranscriptSource>();
  private reader = new JsonlReader(initClaude, reduceClaude);
  constructor(private home: string) {}
  async collect(): Promise<{ sessions: Session[]; count: number }> {
    this.sources.clear();
    const standard = await children(join(this.home, ".claude/projects"), 1, name => /^[a-f0-9-]{36}\.jsonl$/.test(name));
    const desktop = await children(join(this.home, "Library/Application Support/Claude/claude-code-sessions"), 7, name => /^[a-f0-9-]{36}\.jsonl$/.test(name));
    const paths = [...new Set([...standard, ...desktop])];
    const metadata = await Promise.all(paths.map(async path => ({ path, time: (await stat(path)).mtimeMs })));
    metadata.sort((a, b) => b.time - a.time);
    this.reader.retain(metadata.slice(0, 30).map(m => m.path));
    const sessions: Session[] = [];
    for (const { path } of metadata.slice(0, 30)) {
      try {
        const parsed = await this.reader.read(path), s = structuredClone(parsed.value.session);
        if (s.provider_session_id === "pending") {
          s.provider_session_id = basename(path, ".jsonl"); s.id = `claude:code-jsonl:${s.provider_session_id}`;
        }
        s.transcript_truncated ||= parsed.truncated;
        this.sources.set(s.id,{path,project_dir:parsed.value.projectDir??null});
        sessions.push(s);
      } catch { /* An inaccessible session does not establish a runtime state. */ }
    }
    return { sessions, count: paths.length };
  }
}
