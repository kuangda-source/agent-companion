import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { AgentId, Capability, Measured, Message, Quality, Session, Usage } from "../../../../packages/protocol/src/index.ts";

export type ObjectValue = Record<string, unknown>;
/** Internal source pointer; never part of the public monitoring snapshot. */
export interface TranscriptSource { path: string; project_dir: string | null; compressed?: boolean; format?:"grok-replica" }
export const object = (v: unknown): ObjectValue => typeof v === "object" && v !== null && !Array.isArray(v) ? v as ObjectValue : {};
export const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
export const string = (v: unknown): string | null => typeof v === "string" ? v : null;
export const number = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
export const tokens = (v: unknown): number | null => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
export function iso(v: unknown): string | null {
  const time = typeof v === "number" ? v < 100_000_000_000 ? v * 1000 : v : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : null;
}
export function measured(value: number | null, source: string, at: string | null, quality: Quality = "confirmed"): Measured<number> {
  if (value !== null && at === null) return { value: null, quality: "unknown", source, observed_at: null };
  return { value, quality: value === null ? "unavailable" : quality, source, observed_at: value === null ? null : at };
}
export function usage(source: string): Usage {
  return {
    input_tokens: measured(null, source, null), output_tokens: measured(null, source, null),
    cache_read_tokens: measured(null, source, null), cache_write_tokens: measured(null, source, null),
    cache_ratio: measured(null, source, null), context_ratio: measured(null, source, null),
  };
}
export function ratio(n: number | null, d: number | null): number | null {
  return n !== null && d !== null && d > 0 && n <= d ? n / d : null;
}
export const capability = (quality: Quality, source: string, note: string): Capability => ({ quality, source, note });
export function eventUUID(input: string): string {
  const h = createHash("sha256").update(input).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function newSession(agent: AgentId, providerId: string, namespace: string): Session {
  return {
    id: `${agent}:${namespace}:${providerId}`, host_id: "local", agent_id: agent,
    provider_session_id: providerId, source_namespace: namespace, title: "未命名会话", project_name: null,
    model: null, state: "unknown", status_quality: "unknown", status_source: namespace,
    status_observed_at: null, observation_health: "fresh", last_activity_at: null, started_at: null,
    run_duration_seconds: null, completion_event_id: null, completion_event_at: null, usage: usage(namespace), messages: [], transcript_truncated: false,
  };
}
/** Display only public message parts. Never forward reasoning, tool, system or developer contents. */
export function publicText(parts: unknown): string {
  if (typeof parts === "string") return parts;
  return array(parts).flatMap(part => {
    const p = object(part);
    return ["text", "input_text", "output_text"].includes(String(p.type)) && typeof p.text === "string" ? [p.text] : [];
  }).join("\n");
}
export function redactSecrets(text: string): string {
  return text.replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/g,"[已隐藏私钥]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,240}\b/g,"[已隐藏 API Key]")
    .replace(/\b(?:AIza|gh[pousr]_)[A-Za-z0-9_-]{16,240}\b/g,"[已隐藏凭据]")
    .replace(/\bBearer\s+[A-Za-z0-9_.~+\/-]{12,}/gi,"Bearer [已隐藏凭据]")
    .replace(/((?:\bpassword\b|密码)["']?\s*(?:[=:：]|是|为)?\s*["']?)[A-Za-z0-9_./+~!@#$%^&*()=-]{6,}/gi,"$1[已隐藏凭据]")
    .replace(/((?:api[_ -]?key|access[_ -]?token|secret|password|密码|密钥)\s*[=:：]\s*["']?)[A-Za-z0-9_./+~-]{12,}/gi,"$1[已隐藏凭据]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/g,"$1[已隐藏凭据]@");
}
export function cleanPublicMessage(role: unknown, content: unknown): string | null {
  if (role !== "user" && role !== "assistant") return null;
  const text = publicText(content).trim();
  if (!text || /^<(environment_context|permissions instructions|skills_instructions|app-context|turn_aborted)>/.test(text) || text.startsWith("<codex_internal_context")) return null;
  let clean = text.replace(/<environment_context>[\s\S]*?<\/environment_context>/g, "").trim();
  const answer = /^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/.exec(clean);
  if (answer) {
    try {
      clean = array(JSON.parse(answer[1])).map(object).flatMap(v => typeof v.answer === "string" ? [`${typeof v.question === "string" ? `问题：${v.question}\n` : ""}回答：${v.answer}`] : []).join("\n\n");
    } catch { return null; }
  }
  return clean ? redactSecrets(clean) : null;
}
export function addMessage(session: Session, role: unknown, content: unknown, id: string, timestamp: string | null) {
  if (role !== "user" && role !== "assistant") return;
  const clean=cleanPublicMessage(role,content); if(!clean) return;
  const message: Message = { id, role, text: [...clean].slice(0, 2400).join(""), timestamp };
  if ([...clean].length > 2400) session.transcript_truncated = true;
  const last = session.messages.at(-1);
  if (last && last.role === role && last.text === message.text && last.timestamp === timestamp) return;
  const existing = session.messages.findIndex(m => m.id === id);
  if (existing >= 0) { session.messages[existing] = message; return; }
  session.messages.push(message);
  if (session.messages.length > 12) {
    // Preserve the latest human question even across a long sequence of progress replies.
    const latestUser = session.messages.findLastIndex(m => m.role === "user");
    session.messages.splice(latestUser === 0 ? 1 : 0, 1);
    session.transcript_truncated = true;
  }
}
export function* rows(text: string): Generator<ObjectValue> {
  // Reduce one row at a time instead of retaining every parsed prompt/tool object.
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start), end = newline < 0 ? text.length : newline;
    const line = text.slice(start, end); start = end + 1;
    if (!line.trim()) continue;
    try { yield object(JSON.parse(line)); } catch { /* Retry an in-flight row on the next source read. */ }
  }
}
/** Bounded tail; stat is a cache key only and never runtime-status evidence. */
export async function readTail(path: string, maxBytes = 8 * 1024 * 1024): Promise<{ text: string; truncated: boolean; key: string }> {
  const file = await open(path, "r");
  try {
    const s = await file.stat();
    const offset = Math.max(0, s.size - maxBytes);
    const buffer = Buffer.alloc(Math.min(s.size, maxBytes));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (offset > 0) text = text.slice(text.indexOf("\n") + 1);
    return { text, truncated: offset > 0, key: `${s.size}:${s.mtimeMs}` };
  } finally { await file.close(); }
}
export async function children(path: string, depth: number, match: (name: string) => boolean): Promise<string[]> {
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); } catch { return []; }
  const results: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory() && depth > 0 && !["node_modules", ".git", "credentials", "plugins", "skills-plugin"].includes(entry.name)) {
      results.push(...await children(child, depth - 1, match));
    } else if (entry.isFile() && match(entry.name)) results.push(child);
  }
  return results;
}
export async function exists(path: string): Promise<boolean> { try { return (await stat(path)).isFile(); } catch { return false; } }
export function project(cwd: unknown): string | null { return typeof cwd === "string" ? basename(cwd) : null; }

/** Live file-descriptor ownership, not lock-file existence or log mtime. */
export async function liveWriters(): Promise<Set<string>> {
  const proc = Bun.spawn(["/usr/sbin/lsof", "-nP", "-c", "codex", "-c", "DeepSeek", "-c", "dsh", "-c", "Claude", "-c", "claude", "-Fn"], { stdout: "pipe", stderr: "ignore" });
  const timeout = setTimeout(() => proc.kill(), 3000);
  try {
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return new Set(output.split("\n").filter(line => line.startsWith("n") && /\/(sessions|thread-writer-locks|projects)\//.test(line)).map(line => line.slice(1)));
  } finally { clearTimeout(timeout); }
}

/** Append-only reader: retain only reduced public data, never a raw transcript copy. */
export class JsonlReader<T> {
  private entries = new Map<string, { key: string; ino: number; offset: number; pending: Buffer; value: T; truncated: boolean }>();
  constructor(private init: () => T, private apply: (value: T, row: ObjectValue) => void) {}
  retain(paths: Iterable<string>) {
    const keep = new Set(paths);
    for (const path of this.entries.keys()) if (!keep.has(path)) this.entries.delete(path);
  }
  async read(path: string): Promise<{ value: T; truncated: boolean }> {
    const meta = await stat(path);
    const key = `${meta.size}:${meta.mtimeMs}`;
    let entry = this.entries.get(path);
    if (entry && entry.ino === meta.ino && entry.key === key) return entry;
    if (!entry || entry.ino !== meta.ino || meta.size < entry.offset) {
      const offset = meta.size > 128 * 1024 * 1024 ? Math.max(0, meta.size - 16 * 1024 * 1024) : 0;
      entry = { key: "", ino: meta.ino, offset, pending: Buffer.alloc(0), value: this.init(), truncated: offset > 0 };
      this.entries.set(path, entry);
    }
    const file = await open(path, "r");
    try {
      let skipFirst = entry.truncated && entry.offset === Math.max(0, meta.size - 16 * 1024 * 1024) && entry.key === "";
      while (entry.offset < meta.size) {
        const block = Buffer.alloc(Math.min(512 * 1024, meta.size - entry.offset));
        const { bytesRead } = await file.read(block, 0, block.length, entry.offset);
        if (bytesRead === 0) break;
        entry.offset += bytesRead;
        const data = Buffer.concat([entry.pending, block.subarray(0, bytesRead)]);
        let start = 0;
        for (let end = data.indexOf(10); end >= 0; end = data.indexOf(10, start)) {
          if (skipFirst) skipFirst = false;
          else if (end - start <= 4 * 1024 * 1024) {
            try { this.apply(entry.value, object(JSON.parse(data.subarray(start, end).toString("utf8")))); }
            catch { entry.truncated = true; }
          } else entry.truncated = true;
          start = end + 1;
        }
        entry.pending = data.subarray(start);
        if (entry.pending.length > 4 * 1024 * 1024) { entry.pending = Buffer.alloc(0); skipFirst = true; entry.truncated = true; }
      }
      entry.key = key;
      return entry;
    } finally {
      // subarray() retains the entire 512 KiB block, even for a zero-length tail.
      // Keep only an owned copy of the incomplete row between polls.
      entry.pending = entry.pending.length ? Buffer.from(entry.pending) : Buffer.alloc(0);
      await file.close();
    }
  }
}
