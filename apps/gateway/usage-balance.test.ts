import { expect, test } from "bun:test";
import { appendFile, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeepSeekBalance, parseBalance } from "./src/balance.ts";
import { calendarDays, claudeUsage, codexUsage, deepseekUsage, UsageHistory } from "./src/usage-history.ts";
import { addMessage, newSession } from "./src/adapters/common.ts";

const observation = { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "25.13", granted_balance: "0.17", topped_up_balance: "24.96" }] };
test("balance validates decimals, polls once per minute, and retains stale data on failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "companion-balance-")), key = join(dir, "key");
  try {
    await writeFile(key, "" + "sk-" + "test-only-not-a-real-credential" + "", { mode: 0o600 });
    let calls = 0, fail = false;
    const balance = new DeepSeekBalance(key, async (url, init) => {
      expect(url).toBe("https://api.deepseek.com/user/balance");
      expect(init.redirect).toBe("error"); expect(init.method ?? "GET").toBe("GET");
      calls++;
      return fail ? new Response("rejected", { status: 401 }) : Response.json(observation);
    });
    const now = Date.parse("2026-10-30T10:00:00Z");
    await Promise.all([balance.refresh(now), balance.refresh(now)]);
    await balance.refresh(now + 59_999); expect(calls).toBe(1);
    expect(balance.current(now)).toMatchObject({ health: "fresh", wallets: [{ total: "25.13" }], budget: null });
    expect(balance.current(now + 300_000).health).toBe("stale");
    fail = true; await balance.refresh(now + 60_000);
    expect(balance.current(now + 60_000)).toMatchObject({ health: "stale", wallets: [{ total: "25.13" }], note: "余额查询密钥无效" });
    expect(JSON.stringify(balance.current(now))).not.toContain("sk-test");
    await chmod(key, 0o644); await balance.refresh(now + 120_000); expect(calls).toBe(2);
    expect(balance.current(now).note).toContain("仅当前用户可读");
    expect(() => parseBalance({ ...observation, balance_infos: [{ ...observation.balance_infos[0], total_balance: "NaN" }] }, new Date(now).toISOString())).toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("API key text is redacted at the public-message boundary", () => {
  const session = newSession("codex", "one", "test");
  addMessage(session, "user", "配置 " + "sk-" + "test-only-not-a-real-credential" + "，然后显示余额", "one", null);
  expect(session.messages[0].text).toBe("配置 [已隐藏 API Key]，然后显示余额");
});
const codexRow = (at: string, input: number, output: number, last?: { input_tokens: number; output_tokens: number }) => ({
  type: "event_msg", timestamp: at, payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: Math.floor(input * 0.8) }, last_token_usage: last } },
});
test("Codex deltas ignore repeated counters, use observed requests after resets, and count cache once", () => {
  const counter = { input: null, output: null };
  expect(codexUsage(codexRow("2026-10-29T01:00:00Z", 1000, 100), counter)).toMatchObject({ input: 1000, output: 100 });
  expect(codexUsage(codexRow("2026-10-29T01:00:01Z", 1000, 100), counter)).toBeNull();
  expect(codexUsage(codexRow("2026-10-30T01:00:00Z", 1400, 150), counter)).toMatchObject({ input: 400, output: 50 });
  expect(codexUsage(codexRow("2026-10-30T02:00:00Z", 30, 5, { input_tokens: 30, output_tokens: 5 }), counter)).toMatchObject({ input: 30, output: 5 });
  expect(codexUsage(codexRow("2026-10-30T03:00:00Z", 20, 4), counter)).toBeNull();
});
test("provider request usage normalizes cache exactly once and preserves stable dedup identities", () => {
  const at = "2026-10-30T10:00:00Z";
  const row = { type: "assistant", timestamp: at, message: { id: "api-one", usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 } } };
  expect(claudeUsage(row)).toMatchObject({ input: 160, output: 20 });
  expect(claudeUsage(row)?.id).toBe(claudeUsage({ ...row, timestamp: "2026-10-30T10:00:01Z" })?.id);
  expect(deepseekUsage({ type: "assistant/message", time: at, seq: 4, data: { message: { id: "request-one" }, usage: { inputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 50, outputTokens: 20, totalTokens: 180 } } }, "session-one")).toMatchObject({ input: 160, output: 20 });
});
test("daily ledger includes archived sessions, handles local midnight, deduplicates copies/streaming and resumes after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "companion-history-"));
  const now = "2026-10-30T10:00:00Z", cache = join(dir, "usage.sqlite");
  let history: UsageHistory | null = null;
  try {
    const folder = join(dir, ".codex/sessions/2026/10/30"), archived = join(dir, ".codex/archived_sessions");
    await mkdir(folder, { recursive: true }); await mkdir(archived, { recursive: true });
    const first = codexRow("2026-10-29T15:59:59Z", 100, 10), second = codexRow("2026-10-29T16:00:00Z", 150, 15, { input_tokens: 50, output_tokens: 5 });
    const path = join(folder, "rollout-one.jsonl"), original = [first, second].map(r => JSON.stringify(r) + "\n").join("");
    await writeFile(path, original); await writeFile(join(archived, "copy.jsonl"), original);
    await writeFile(join(archived, "resumed-fragment.jsonl"), JSON.stringify(second) + "\n");
    const dsh = join(dir, ".dsh/sessions/workspace/session-one"); await mkdir(dsh, { recursive: true });
    const request = { type: "assistant/message", time: "2026-10-30T01:00:00Z", seq: 2, data: { message: { id: "dsh-one" }, usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 100, cacheWriteTokens: 0 } } };
    await writeFile(join(dsh, "session.v4.jsonl.zstd"), Bun.zstdCompressSync(Buffer.from(JSON.stringify(request) + "\n")));
    history = new UsageHistory(dir, cache, "Asia/Shanghai"); await history.refresh(now);
    let stats = history.current();
    expect(stats.days.at(-2)?.tokens.codex).toBe(110);
    expect(stats.days.at(-1)?.tokens).toEqual({ codex: 55, claude: null, deepseek: 130, grok:null });
    expect(stats.status).toBe("partial"); expect(stats.agents.find(a => a.id === "claude")?.available).toBe(false);
    const third = JSON.stringify(codexRow("2026-10-30T01:00:00Z", 200, 20));
    await appendFile(path, third.slice(0, -1)); await history.refresh("2026-10-30T10:01:00Z");
    expect(history.current().days.at(-1)?.tokens.codex).toBe(55);
    await appendFile(path, "}\n"); await history.refresh("2026-10-30T10:02:00Z");
    expect(history.current().days.at(-1)?.tokens.codex).toBe(110);
    history.close(); history = new UsageHistory(dir, cache, "Asia/Shanghai"); await history.refresh("2026-10-30T10:03:00Z");
    expect(history.current().days.at(-1)?.tokens.codex).toBe(110);
    expect(calendarDays(now, "Asia/Shanghai")).toHaveLength(30);
    expect(calendarDays(now, "Asia/Shanghai")[0]).toBe("2026-10-01");
    expect(calendarDays("2026-10-30T16:00:00Z", "Asia/Shanghai").at(-1)).toBe("2026-10-31");
  } finally { history?.close(); await rm(dir, { recursive: true, force: true }); }
});
