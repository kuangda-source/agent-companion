import { stat } from "node:fs/promises";
import type { AccountBalance } from "../../../packages/protocol/src/index.ts";
import { array, object } from "./adapters/common.ts";

const source = "deepseek.GET /user/balance";
type BalanceRequest = (url: string, init: RequestInit) => Promise<Response>;
const decimal = (v: unknown): v is string => typeof v === "string" && v.length <= 40 && /^-?\d+(?:\.\d+)?$/.test(v) && Number.isFinite(Number(v));
export function parseBalance(value: unknown, at: string): AccountBalance {
  const body = object(value);
  const wallets = array(body.balance_infos).map(value => {
    const w = object(value);
    if ((w.currency !== "CNY" && w.currency !== "USD") || !decimal(w.total_balance) || !decimal(w.granted_balance) || !decimal(w.topped_up_balance)) throw new Error("invalid_balance");
    return { currency: w.currency as "CNY" | "USD", total: w.total_balance, granted: w.granted_balance, topped_up: w.topped_up_balance };
  });
  if (typeof body.is_available !== "boolean" || wallets.length === 0 || wallets.length > 2 || new Set(wallets.map(w => w.currency)).size !== wallets.length) throw new Error("invalid_balance");
  return { health: "fresh", source, observed_at: at, wallets, budget: null, note: body.is_available ? "API 账户可用余额，含赠金" : "API 账户余额不足" };
}

/** The supplied key is read only here; it is never part of the public snapshot or a log. */
export class DeepSeekBalance {
  private value: AccountBalance = { health: "unknown", source, observed_at: null, wallets: [], budget: null, note: "未配置余额查询" };
  private generation=0;
  reset(){this.generation++;this.attemptedAt=-Infinity;this.value={health:"unknown",source,observed_at:null,wallets:[],budget:null,note:"未配置余额查询或等待新查询"};}
  private attemptedAt = -Infinity;
  private pending: Promise<void> | null = null;
  constructor(private keyFile: string, private request: BalanceRequest = fetch, private budget: AccountBalance["budget"] = null) {}
  current(now = Date.now()): AccountBalance {
    const value = structuredClone(this.value);
    if (value.observed_at && now - Date.parse(value.observed_at) >= 5 * 60_000) {
      value.health = "stale"; value.note = "余额观测已过期";
    }
    return value;
  }
  async refresh(now = Date.now()): Promise<void> {
    if (this.pending) return this.pending;
    if (now - this.attemptedAt < 60_000) return;
    this.attemptedAt = now;
    this.pending = this.read(now,this.generation);
    try { await this.pending; } finally { this.pending = null; }
  }
  private async read(now: number,generation:number) {
    try {
      const meta = await stat(this.keyFile);
      if (!meta.isFile() || (meta.mode & 0o077) !== 0) throw new Error("key_permissions");
      const key = (await Bun.file(this.keyFile).text()).trim();
      if (!/^sk-[A-Za-z0-9_-]{16,200}$/.test(key)) throw new Error("key_format");
      const response = await this.request("https://api.deepseek.com/user/balance", {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        redirect: "error", signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(response.status === 401 ? "key_rejected" : "balance_request_failed");
      const text = await response.text();
      if (text.length > 16_384) throw new Error("invalid_balance");
      const value=parseBalance(JSON.parse(text), new Date(now).toISOString());
      if(generation!==this.generation)return;
      this.value = value;
      this.value.budget = this.budget;
    } catch (error) {
      if(generation!==this.generation)return;
      const code = error instanceof Error ? error.message : "balance_request_failed";
      this.value.health = this.value.observed_at ? "stale" : "unknown";
      this.value.note = code === "key_rejected" ? "余额查询密钥无效" : code === "key_permissions" ? "密钥文件须仅当前用户可读" : code === "key_format" ? "余额查询密钥格式无效" : code.includes("ENOENT") ? "未配置余额查询" : "余额查询失败，等待自动重试";
    }
  }
}
