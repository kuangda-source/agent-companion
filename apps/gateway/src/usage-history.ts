import { Database } from "bun:sqlite";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { AGENT_IDS, type AgentId, type TokenStatistics } from "../../../packages/protocol/src/index.ts";
import { children, eventUUID, iso, object, string, tokens, type ObjectValue } from "./adapters/common.ts";

export interface UsagePoint { id: string; at: string; input: number; output: number }
export interface Counter { input: number | null; output: number | null }
const sourceNames: Record<AgentId, string> = { codex: "codex.token_count cumulative deltas", claude: "claude.code message.id usage", deepseek: "dsh.assistant/message data.usage", grok:"grok.bot_cache: token usage unavailable" };
/** Cache reads are already included in Codex input_tokens. Never add them a second time. */
export function codexUsage(row: ObjectValue, previous: Counter): UsagePoint | null {
  const p = object(row.payload), info = object(p.info), total = object(info.total_token_usage), last = object(info.last_token_usage);
  if (row.type !== "event_msg" || p.type !== "token_count") return null;
  const input = tokens(total.input_tokens), output = tokens(total.output_tokens), at = iso(row.timestamp);
  if (input === null || output === null || !at) return null;
  const first = previous.input === null;
  const reset = !first && (input < previous.input! || output < previous.output!);
  // A copied/resumed fragment may start with an inherited cumulative counter.
  // Its first explicitly measured request belongs here; earlier consumption does not.
  const deltaInput = reset ? tokens(last.input_tokens) : first ? tokens(last.input_tokens) ?? input : input - previous.input!;
  const deltaOutput = reset ? tokens(last.output_tokens) : first ? tokens(last.output_tokens) ?? output : output - previous.output!;
  previous.input = input; previous.output = output;
  // Without a last-request observation a reset is a baseline, not new consumption.
  if (deltaInput === null || deltaOutput === null || deltaInput + deltaOutput === 0) return null;
  return { id: eventUUID(`codex:${at}:${input}:${output}`), at, input: deltaInput, output: deltaOutput };
}
export function claudeUsage(row: ObjectValue): UsagePoint | null {
  if (row.type !== "assistant") return null;
  const m = object(row.message), u = object(m.usage), id = string(m.id), at = iso(row.timestamp);
  const input = tokens(u.input_tokens), output = tokens(u.output_tokens), read = tokens(u.cache_read_input_tokens) ?? 0, write = tokens(u.cache_creation_input_tokens) ?? 0;
  if (!id || !at || input === null || output === null) return null;
  // Streaming rows and copied histories share message.id; the final observation replaces it.
  return { id: eventUUID(`claude:${id}`), at, input: input + read + write, output };
}
export function deepseekUsage(row: ObjectValue, session: string): UsagePoint | null {
  if (row.type !== "assistant/message") return null;
  const d = object(row.data), m = object(d.message), u = object(d.usage), at = iso(row.time);
  const input = tokens(u.inputTokens), output = tokens(u.outputTokens), read = tokens(u.cacheReadTokens) ?? 0, write = tokens(u.cacheWriteTokens) ?? 0;
  if (!at || input === null || output === null) return null;
  return { id: eventUUID(`deepseek:${string(m.id) ?? `${session}:${String(row.seq)}`}`), at, input: input + read + write, output };
}
export function calendarDays(now: string, timezone: string): string[] {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = formatter.formatToParts(new Date(now));
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  const today = Date.parse(`${part("year")}-${part("month")}-${part("day")}T12:00:00Z`);
  return Array.from({ length: 30 }, (_, i) => new Date(today - (29 - i) * 86400_000).toISOString().slice(0, 10));
}
export function emptyStatistics(now = new Date().toISOString(), timezone = Intl.DateTimeFormat().resolvedOptions().timeZone): TokenStatistics {
  return { status: "loading", timezone, generated_at: null,
    note: "正在读取本机历史用量；近 7/30 天均含今天，按本地自然日统计。",
    agents: AGENT_IDS.map(id => ({ id, available: false, partial: false, source: sourceNames[id] })),
    days: calendarDays(now, timezone).map(date => ({ date, tokens: { codex: null, claude: null, deepseek: null, grok:null } })),
  };
}
interface Cursor { path: string; agent: AgentId; ino: number; size: number; mtime: number; offset: number; input: number | null; output: number | null; partial: number }
interface StoredPoint { agent: AgentId; at: string; input: number; output: number }

/** Numeric-only local ledger. Sources are read-only; no prompts, replies, credentials or raw lines are persisted. */
export class UsageHistory {
  private db: Database;
  private value: TokenStatistics;
  private pending: Promise<void> | null = null;
  private scannedAt = -Infinity;
  constructor(private home: string, path = ":memory:", private timezone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; CREATE TABLE IF NOT EXISTS usage_sources(path TEXT PRIMARY KEY,agent TEXT,ino INTEGER,size INTEGER,mtime REAL,offset INTEGER,input INTEGER,output INTEGER,partial INTEGER); CREATE TABLE IF NOT EXISTS token_events(id TEXT PRIMARY KEY,agent TEXT,at TEXT,input INTEGER,output INTEGER,source_path TEXT); CREATE INDEX IF NOT EXISTS token_events_at ON token_events(at)");
    if (this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version === 0) {
      this.db.exec("DELETE FROM token_events; DELETE FROM usage_sources; PRAGMA user_version=1");
    }
    this.value = this.build(new Date().toISOString(), true);
  }
  current() { return this.value; }
  close() { this.db.close(); }
  async refresh(now = new Date().toISOString()): Promise<void> {
    if (this.pending) return this.pending;
    if (Date.parse(now) - this.scannedAt < 60_000) return;
    this.pending = this.scan(now);
    try { await this.pending; } finally { this.pending = null; }
  }
  private store(point: UsagePoint, agent: AgentId, path: string, now: string) {
    if (!Number.isSafeInteger(point.input + point.output) || Date.parse(point.at) > Date.parse(now) + 120_000) return;
    this.db.query("INSERT INTO token_events VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET input=CASE WHEN excluded.agent='codex' THEN MIN(input,excluded.input) ELSE MAX(input,excluded.input) END, output=CASE WHEN excluded.agent='codex' THEN MIN(output,excluded.output) ELSE MAX(output,excluded.output) END").run(point.id, agent, point.at, point.input, point.output, path);
  }
  private async scan(now: string) {
    let failed = false;
    try {
      const paths = await Promise.all([
        children(join(this.home, ".codex/sessions"), 4, n => n.endsWith(".jsonl")),
        children(join(this.home, ".codex/archived_sessions"), 4, n => n.endsWith(".jsonl")),
        children(join(this.home, ".claude/projects"), 5, n => n.endsWith(".jsonl")),
        children(join(this.home, "Library/Application Support/Claude/claude-code-sessions"), 8, n => n.endsWith(".jsonl")),
        children(join(this.home, ".dsh/sessions"), 2, n => n === "session.v4.jsonl.zstd"),
      ]);
      const sources = [...paths[0], ...paths[1]].map(path => ({ path, agent: "codex" as const }));
      const files: { path: string; agent: AgentId }[] = [...sources,
        ...[...paths[2], ...paths[3]].map(path => ({ path, agent: "claude" as const })),
        ...paths[4].map(path => ({ path, agent: "deepseek" as const }))];
      for (const { path, agent } of files) {
        try { await this.scanFile(path, agent, now); }
        catch { failed = true; this.db.query("UPDATE usage_sources SET partial=1 WHERE path=?").run(path); }
        // A first-time multi-GB import must not block HTTP snapshots, touches or the pets.
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      this.scannedAt = Date.parse(now);
      this.value = this.build(now, false, failed);
    } catch {
      this.value = { ...this.value, status: "failed", note: "历史统计读取失败，保留上次汇总" };
    }
  }
  private async scanFile(path: string, agent: AgentId, now: string) {
    const meta = await stat(path), old = this.db.query<Cursor, [string]>("SELECT * FROM usage_sources WHERE path=?").get(path);
    if (old && old.ino === meta.ino && old.size === meta.size && old.mtime === meta.mtimeMs) return;
    const reset = !old || old.ino !== meta.ino || meta.size < old.offset || (meta.size === old.size && old.mtime !== meta.mtimeMs);
    const cursor: Cursor = reset ? { path, agent, ino: meta.ino, size: 0, mtime: 0, offset: 0, input: null, output: null, partial: 0 } : { ...old };
    if (agent === "deepseek") {
      if (meta.size > 32 * 1024 * 1024) throw new Error("compressed_history_too_large");
      const data = Bun.zstdDecompressSync(await Bun.file(path).bytes());
      if (data.length > 128 * 1024 * 1024) throw new Error("history_too_large");
      let session = path;
      for (const line of data.toString("utf8").split("\n")) {
        if (!line.includes('"assistant/message"') && !line.includes('"session"')) continue;
        try {
          const row = object(JSON.parse(line));
          if (row.type === "session") session = string(row.id) ?? path;
          const point = deepseekUsage(row, session);
          if (point) this.store(point, agent, path, now);
        } catch { cursor.partial = 1; }
      }
      cursor.offset = meta.size;
    } else {
      const file = await open(path, "r");
      let position = cursor.offset, pending = Buffer.alloc(0), skipping = false;
      try {
        while (position < meta.size) {
          const block = Buffer.alloc(Math.min(1024 * 1024, meta.size - position));
          const { bytesRead } = await file.read(block, 0, block.length, position);
          if (!bytesRead) break;
          position += bytesRead;
          const data = Buffer.concat([pending, block.subarray(0, bytesRead)]);
          let start = 0;
          for (let end = data.indexOf(10); end >= 0; end = data.indexOf(10, start)) {
            if (!skipping && end - start <= 4 * 1024 * 1024) {
              const line = data.subarray(start, end).toString("utf8");
              if (line.includes(agent === "codex" ? '"token_count"' : '"usage"')) {
                try {
                  const row = object(JSON.parse(line));
                  const point = agent === "codex" ? codexUsage(row, cursor) : claudeUsage(row);
                  if (point) this.store(point, agent, path, now);
                } catch { cursor.partial = 1; }
              }
            }
            // Oversize prompt/tool lines are irrelevant to numeric usage; skip without storing them.
            skipping = false; start = end + 1;
          }
          pending = data.subarray(start);
          cursor.offset = position - pending.length;
          if (pending.length > 4 * 1024 * 1024) { pending = Buffer.alloc(0); skipping = true; }
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      } finally { await file.close(); }
      // A trailing incomplete row is retried from its last complete newline on the next poll.
    }
    this.db.query("INSERT OR REPLACE INTO usage_sources VALUES(?,?,?,?,?,?,?,?,?)").run(path, agent, meta.ino, meta.size, meta.mtimeMs, cursor.offset, cursor.input, cursor.output, cursor.partial);
  }
  private build(now: string, loading: boolean, failed = false): TokenStatistics {
    const value = emptyStatistics(now, this.timezone);
    const rows = this.db.query<StoredPoint, [string]>("SELECT agent,at,input,output FROM token_events WHERE at>=? ORDER BY at").all(new Date(Date.parse(now) - 32 * 86400_000).toISOString());
    const available = new Set(this.db.query<{ agent: AgentId }, []>("SELECT DISTINCT agent FROM token_events").all().map(r => r.agent));
    const partial = new Set(this.db.query<{ agent: AgentId }, []>("SELECT DISTINCT agent FROM usage_sources WHERE partial=1").all().map(r => r.agent));
    const format = new Intl.DateTimeFormat("en-CA", { timeZone: this.timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    for (const a of value.agents) { a.available = available.has(a.id); a.partial = partial.has(a.id); }
    for (const day of value.days) for (const id of AGENT_IDS) day.tokens[id] = available.has(id) ? 0 : null;
    for (const row of rows) {
      const parts = format.formatToParts(new Date(row.at)), p = (type: string) => parts.find(p => p.type === type)!.value;
      const day = value.days.find(d => d.date === `${p("year")}-${p("month")}-${p("day")}`);
      if (day) day.tokens[row.agent] = (day.tokens[row.agent] ?? 0) + row.input + row.output;
    }
    value.status = loading ? "loading" : failed || partial.size || available.size < AGENT_IDS.length ? "partial" : "ready";
    value.generated_at = rows.length || !loading ? now : null;
    value.note = "本机可读记录，含缓存输入 + 输出；近 7/30 天含今天，按本地自然日汇总。缺失来源不按零计。";
    return value;
  }
}
