import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Session } from "../../../../packages/protocol/src/index.ts";
import { addMessage, array, children, eventUUID, iso, measured, newSession, number, object, project, ratio, rows, string, tokens, type ObjectValue, type TranscriptSource } from "./common.ts";

export interface DshJournal { session: Session; openTurn: number | null; terminal: boolean; projectDir?: string }
export function reduceDeepSeek(j: DshJournal, row: ObjectValue) {
  const s = j.session, d = object(row.data), at = iso(row.time);
  if (row.type === "session") {
    if(typeof row.cwd==="string") j.projectDir=row.cwd;
    s.provider_session_id = string(row.id) ?? s.provider_session_id;
    s.id = `deepseek:harness-v4:${s.provider_session_id}`;
    s.project_name = project(row.cwd);
  }
  if (at) s.last_activity_at = at;
  if (row.type === "session/title") s.title = string(d.title) ?? string(row.data) ?? s.title;
  if (row.type === "turn/start") {
    j.openTurn = number(d.turn); j.terminal = false; s.started_at = at;
    s.state = "unknown";
  } else if (row.type === "turn/end") {
    j.openTurn = null; j.terminal = true;
    const kind = string(object(d.reason).kind);
    s.state = kind === "completed" ? "completed" : kind === "error" || kind === "failed" ? "error" : "idle";
    s.status_quality = "confirmed"; s.status_source = `dsh.turn/end:${kind ?? "unknown"}`;
    s.status_observed_at = at;
    s.run_duration_seconds = at && s.started_at ? Math.max(0, Math.floor((Date.parse(at) - Date.parse(s.started_at)) / 1000)) : null;
    if (s.state === "completed") { s.completion_event_id = eventUUID(`deepseek:${s.provider_session_id}:${String(d.turn)}:${at}`); s.completion_event_at = at; }
  } else if (row.type === "user/message") {
    addMessage(s, "user", d.content, string(d.id) ?? `user:${String(row.seq)}`, at);
  } else if (row.type === "assistant/message") {
    const m = object(d.message);
    addMessage(s, "assistant", m.content, string(m.id) ?? `assistant:${String(row.seq)}`, at);
  }
}

function applyCache(j: DshJournal, cache: ObjectValue, now: string, live: boolean) {
  const record = object(cache.record), fields = object(record.rows), s = j.session;
  const val = (key: string) => object(fields[key]).val;
  s.title = string(val("title")) ?? s.title;
  s.project_name ??= project(object(record.identity).cwd);
  s.model = string(object(object(val("modelSelection")).lastUsed).model);
  const u = object(val("tokenUsage")), totals = object(u.totals);
  const uncached = tokens(totals.uncachedInputTokens), read = tokens(totals.cacheReadTokens), write = tokens(totals.cacheWriteTokens);
  const input = uncached !== null && read !== null && write !== null ? uncached + read + write : null;
  const ctx = object(val("contextPressure")), at = s.last_activity_at;
  s.usage = {
    input_tokens: measured(input, "dsh.uncachedInput + cacheRead + cacheWrite", at),
    output_tokens: measured(tokens(totals.outputTokens), "dsh.tokenUsage.outputTokens", at),
    cache_read_tokens: measured(read, "dsh.tokenUsage.cacheReadTokens", at),
    cache_write_tokens: measured(write, "dsh.tokenUsage.cacheWriteTokens", at),
    cache_ratio: measured(ratio(read, input), "dsh.cacheRead / inclusiveInput", at),
    context_ratio: measured(ratio(number(ctx.pressureTokens), number(ctx.contextWindow)), "dsh.contextPressure.pressureTokens / contextWindow", at, "estimated"),
  };
  if (j.openTurn !== null) {
    const active = array(object(object(val("userQuestions")).questions).active);
    s.state = live ? active.length > 0 ? "waiting_user" : "running" : "unknown";
    s.status_quality = live ? "confirmed" : "unknown";
    s.status_source = live ? active.length > 0 ? "dsh.userQuestions.active + live_session_lock_fd" : "dsh.turn/start + live_session_lock_fd" : "dsh.unclosed_turn; no_live_writer";
    s.status_observed_at = now;
    s.run_duration_seconds = s.started_at ? Math.max(0, Math.floor((Date.parse(now) - Date.parse(s.started_at)) / 1000)) : null;
  }
}

export class DeepSeekAdapter {
  readonly sources = new Map<string,TranscriptSource>();
  private cache = new Map<string, { key: string; journal: DshJournal }>();
  private lastGood = new Map<string, Session>();
  constructor(private home: string) {}
  async collect(writers: Set<string>, now: string): Promise<{ sessions: Session[]; count: number }> {
    this.sources.clear();
    const files = await children(join(this.home, ".dsh/sessions"), 2, name => name === "session.v4.jsonl.zstd");
    const sessions: Session[] = [];
    const metadata = await Promise.all(files.map(async path => ({ path, modified: (await stat(path)).mtimeMs })));
    metadata.sort((a,b) => b.modified-a.modified);
    const candidates=metadata.filter(({path}, index) => index<50 || writers.has(path) || writers.has(join(dirname(path),"session.lock")));
    const keep = new Set(candidates.map(c => c.path));
    for (const path of this.cache.keys()) if (!keep.has(path)) this.cache.delete(path);
    for (const path of this.lastGood.keys()) if (!keep.has(path)) this.lastGood.delete(path);
    for (const {path} of candidates) {
      try {
        const meta = await stat(path), key = `${meta.size}:${meta.mtimeMs}`;
        let cached = this.cache.get(path);
        if (!cached || cached.key !== key) {
          if (meta.size > 32 * 1024 * 1024) continue;
          const data = Bun.zstdDecompressSync(await Bun.file(path).bytes());
          if (data.length > 128 * 1024 * 1024) continue;
          const journal: DshJournal = { session: newSession("deepseek", "pending", "harness-v4"), openTurn: null, terminal: false };
          for (const row of rows(data.toString("utf8"))) reduceDeepSeek(journal, row);
          cached = { key, journal }; this.cache.set(path, cached);
        }
        const journal = structuredClone(cached.journal);
        const id = journal.session.provider_session_id;
        const cacheFile = Bun.file(join(this.home, ".dsh/storages/session_projcache/sessions", `${id}.json`));
        const cacheData = await cacheFile.exists() ? object(await cacheFile.json()) : {};
        const live = writers.has(join(dirname(path), "session.lock")) || writers.has(path);
        applyCache(journal, cacheData, now, live);
        this.sources.set(journal.session.id,{path,project_dir:journal.projectDir??null,compressed:true});
        sessions.push(journal.session);
        this.lastGood.set(path, journal.session);
      } catch {
        const old = this.lastGood.get(path);
        if (old) sessions.push({ ...structuredClone(old), observation_health: "stale" });
      }
    }
    return { sessions, count: files.length };
  }
}
