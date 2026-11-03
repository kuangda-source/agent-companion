import { homedir } from "node:os";
import { AGENT_IDS, DEFAULT_AGENT_IDS, STATUS_PRIORITY, type Agent, type AgentId, type Session, type Snapshot } from "../../../packages/protocol/src/index.ts";
import { capability, liveWriters, type TranscriptSource } from "./adapters/common.ts";
import {CodexQuotaMonitor,type QuotaRead} from "./codex-quota.ts";
import { CodexAdapter } from "./adapters/codex.ts";
import {selectedSnapshot} from "./agent-selection.ts";
import {GrokAdapter} from "./adapters/grok.ts";
import { ClaudeAdapter } from "./adapters/claude.ts";
import { DeepSeekAdapter } from "./adapters/deepseek.ts";
import { DeepSeekBalance } from "./balance.ts";
import { emptyStatistics, UsageHistory } from "./usage-history.ts";
import { join } from "node:path";
import type { AccountBalance } from "../../../packages/protocol/src/index.ts";
import { ScheduleReader, projectScheduledConversations } from "./schedules.ts";

const names: Record<AgentId, string> = { codex: "Codex", claude: "Claude", deepseek: "DeepSeek", grok:"Grok" };
export function sortSessions(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => STATUS_PRIORITY[a.state] - STATUS_PRIORITY[b.state] || (b.last_activity_at ?? "").localeCompare(a.last_activity_at ?? ""));
}
export function summarize(id: AgentId, sessions: Session[], count: number, at: string): Agent {
  const fresh = sessions.filter(s => s.observation_health === "fresh");
  // Strong active/attention states retain their priority. With no such task,
  // the latest observation determines the pet: an older completion must not
  // conceal a newer unsettled/unknown or disconnected conversation.
  const active = sortSessions(fresh.filter(s => s.status_quality === "confirmed" && ["running", "waiting_user", "error"].includes(s.state)))[0];
  const latest = [...sessions].sort((a,b) => (b.last_activity_at ?? "").localeCompare(a.last_activity_at ?? ""))[0];
  const best = active ?? latest;
  const hasMessages = sessions.some(s => s.messages.length > 0), hasStatus = sessions.some(s => s.status_quality === "confirmed");
  const source = id === "codex" ? "codex.rollout + readonly_sqlite + live_writer_fd" : id === "claude" ? "claude.code_jsonl" : id === "grok" ? "grok.bot_roster + public_replica" : "dsh.session_v4 + projection_cache";
  return {
    id, name: names[id], state: best?.state ?? "unknown", status_quality: best?.status_quality ?? "unknown", observation_health: best?.observation_health ?? "fresh",
    session_count: count, running_count: fresh.filter(s => s.state === "running").length,
    waiting_count: fresh.filter(s => s.state === "waiting_user").length, observed_at: at,
    note: id==="grok"?"Bot 名称与公开消息来自本地缓存；实时工作状态和 Token 未提供；额度每5分钟读取本地缓存":sessions.length ? fresh.length < sessions.length ? "部分记录暂时不可读；显示可确认信息" : "本机只读观察" : id === "claude" ? "未发现 Claude Code 会话；等待真实样本" : "未发现可读取的本地会话",
    capabilities: {
      sessions: capability(sessions.length ? "confirmed" : "unknown", source, sessions.length ? "已读取本机记录" : "无可验收样本"),
      messages: capability(hasMessages ? "confirmed" : "unknown", source, "仅显示用户与助手公开正文"),
      status: capability(hasStatus ? "confirmed" : "unknown", source, id === "claude" ? "历史完成可确认；运行中/审批待验证" : id === "grok" ? "本地缓存不含实时工作状态" : "显式生命周期；运行态核查存活 writer"),
      usage: capability(sessions.some(s => s.usage.input_tokens.value !== null) ? "confirmed" : "unavailable", source, "不可得字段为 null；上下文仅估计"),
    }, quota: [], balance: null,
  };
}

export interface Collector { refresh(): Promise<Snapshot>; current(): Snapshot; detail(id: string): Session | undefined; sessions?(): Session[]; source?(id:string): TranscriptSource | undefined; quotaStatus?():unknown; triggerQuota?(reason:"wake"|"manual"):void }
export class LiveState implements Collector {
  private codex: CodexAdapter;
  private quota:CodexQuotaMonitor;
  private claude: ClaudeAdapter;
  private deepseek: DeepSeekAdapter;
  private grok:GrokAdapter;
  private selectedAgents:()=>AgentId[];
  private history: UsageHistory;
  private balance: DeepSeekBalance | null;
  private value: Snapshot = { schema_version: 1, data_source: "live", seq: 0, generated_at: new Date().toISOString(), agents: [], sessions: [], token_statistics: emptyStatistics() };
  private all: Session[] = [];
  private refreshing = false;
  private schedules: ScheduleReader;
  constructor(home = homedir(), runtime?: string, budget: AccountBalance["budget"] = null, options:{quotaRead?:QuotaRead;selectedAgents?:()=>AgentId[]}={}) {
    this.selectedAgents=options.selectedAgents??(()=>DEFAULT_AGENT_IDS);
    this.grok=new GrokAdapter(home);
    this.schedules=new ScheduleReader(home);
    this.quota=new CodexQuotaMonitor(options.quotaRead,runtime?join(runtime,"codex-quota.json"):undefined);
    this.codex = new CodexAdapter(home); this.claude = new ClaudeAdapter(home); this.deepseek = new DeepSeekAdapter(home);
    this.history = new UsageHistory(home, runtime ? join(runtime, "token_usage.sqlite") : ":memory:");
    this.balance = runtime ? new DeepSeekBalance(join(runtime, "secrets/deepseek-api-key"), fetch, budget) : null;
  }
  quotaStatus(){return this.quota.status();}
  triggerQuota(reason:"wake"|"manual"){this.quota.trigger(reason);}
  async shutdownQuota(){await this.quota.close();}
  resetBalance(){this.balance?.reset();}
  current() { return selectedSnapshot(this.value,this.selectedAgents()); }
  sessions() { return this.all.filter(s=>this.selectedAgents().includes(s.agent_id)); }
  source(id:string) { return this.codex.sources.get(id)??this.claude.sources.get(id)??this.deepseek.sources.get(id)??this.grok.sources.get(id); }
  detail(id: string) { return this.sessions().find(s => s.id === id); }
  async refresh(): Promise<Snapshot> {
    if (this.refreshing) return this.current();
    this.refreshing = true;
    try {
      const at = new Date().toISOString();
      void this.history.refresh(at);
      void this.balance?.refresh();
      const writers = await liveWriters();
      const results = await Promise.allSettled([this.codex.collect(writers, at), this.claude.collect(), this.deepseek.collect(writers, at),this.grok.collect()]);
      const agents: Agent[] = [], all: Session[] = [];
      for (let i = 0; i < AGENT_IDS.length; ++i) {
        const id = AGENT_IDS[i], result = results[i];
        if (result.status === "fulfilled") {
          const agent = summarize(id, result.value.sessions, result.value.count, at);
          if (id==="codex"&&"quota" in result.value){this.quota.observe(agent.running_count>0,result.value.quota,result.value.sessions.filter(s=>s.state==="running"&&s.observation_health==="fresh").map(s=>s.id+":"+s.started_at));agent.quota=this.quota.current();}
          else if("quota" in result.value)agent.quota=result.value.quota;
          if (id === "deepseek") agent.balance = this.balance?.current() ?? null;
          agents.push(agent); all.push(...result.value.sessions);
        } else {
          const previous = this.value.agents.find(a => a.id === id);
          const agent = previous ? structuredClone(previous) : summarize(id, [], 0, at);
          if(id==="codex"){this.quota.tick();agent.quota=this.quota.current();}
          agent.observation_health = "stale"; agent.note = "来源读取失败；保留最后已知信息";
          agents.push(agent);
          all.push(...this.all.filter(s => s.agent_id === id).map(s => ({ ...s, observation_health: "stale" as const })));
        }
      }
      this.all = all;
      const scheduled_tasks=projectScheduledConversations(this.schedules.current(),all);
      this.value = { schema_version: 1, data_source: "live", seq: this.value.seq + 1, generated_at: at, agents, token_statistics: this.history.current(),scheduled_tasks,
        sessions: AGENT_IDS.flatMap(id => sortSessions(all.filter(s => s.agent_id === id)).slice(0, 5).map(s => ({
          ...s, messages: s.messages.slice(-1).map(m => ({ ...m, text: [...m.text].slice(0, 100).join("") })),
          transcript_truncated: s.transcript_truncated || s.messages.length > 1 || s.messages.some(m => [...m.text].length > 100),
        }))) };
      return this.current();
    } finally { this.refreshing = false; }
  }
}
