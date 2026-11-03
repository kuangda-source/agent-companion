import { AGENT_IDS, DEFAULT_AGENT_IDS, type AgentId, type Session, type Snapshot, type State } from "../../../packages/protocol/src/index.ts";
import { eventUUID, measured, newSession } from "./adapters/common.ts";
import { summarize, type Collector } from "./state.ts";
import {selectedSnapshot} from "./agent-selection.ts";
import { emptyStatistics } from "./usage-history.ts";

/** Synthetic records stay in an explicitly labelled mode and use the live protocol. */
export class MockState implements Collector {
  private value: Snapshot;
  private started: number;
  constructor(private animate = false, private phase = 0, private selectedAgents:()=>AgentId[]=()=>DEFAULT_AGENT_IDS) { this.started=Date.now()-phase*1000; this.value = this.make(phase, 1); }
  private make(seconds: number, seq: number): Snapshot {
    const at = new Date().toISOString(), phase = Math.floor(seconds) % 24;
    const stateAt = (p: number): State => p < 4 ? "running" : p < 7 ? "waiting_user" : p < 10 ? "error" : p < 14 ? "running" : p < 17 ? "completed" : p < 20 ? "idle" : p < 22 ? "unknown" : "disconnected";
    const sessions = AGENT_IDS.flatMap((id, agentIndex) => Array.from({ length: 5 }, (_, index): Session => {
      const s = newSession(id, `mock-session-${index + 1}`, "mock");
      s.title = ["桌宠界面与状态同步", "Gateway 会话采集", "素材动作验收", "协议与连接恢复", "项目开发记录"][index];
      s.project_name = "模拟开发"; s.model = `${id}-demo`;
      s.state = index === 0 ? stateAt((phase + agentIndex * 6) % 24) : "completed";
      s.status_quality = s.state === "unknown" ? "unknown" : "confirmed"; s.status_source = "mock.scenario";
      s.status_observed_at = at; s.last_activity_at = at; s.started_at = new Date(Date.now() - 126_000).toISOString(); s.run_duration_seconds = 126;
      s.completion_event_id = s.state === "completed" ? eventUUID(`mock:${id}:${index}:${index === 0 ? Math.floor(seconds / 24) : 0}`) : null;
      s.completion_event_at = s.state === "completed" ? at : null;
      s.usage = {
        input_tokens: measured(18500 + index * 2800, "mock", at), output_tokens: measured(1200 + index * 350, "mock", at),
        cache_read_tokens: measured(9000, "mock", at), cache_write_tokens: measured(500, "mock", at),
        cache_ratio: measured(0.49, "mock", at), context_ratio: measured(0.23 + index * 0.08, "mock", at, "estimated"),
      };
      s.messages = [
        { id: "mock-user-1", role: "user", text: "把三家 Agent 的状态和对话接到桌宠界面，底部按钮先只做点击反馈。", timestamp: at },
        { id: "mock-assistant-1", role: "assistant", text: "已保留三宠、五会话和底部入口。运行时显示工作动作；等待输入、异常、完成和掉线都有对应反馈。", timestamp: at },
        { id: "mock-user-2", role: "user", text: "切换 Agent 后，另外两只桌宠也继续播放各自状态。", timestamp: at },
        { id: "mock-assistant-2", role: "assistant", text: "这是一段模拟对话，用于验证只读详情、中文排版和滚动。\n\n真实模式只展示本机已有的公开对话；没有可靠状态证据时显示未知，额度不可得时显示 —。", timestamp: at },
      ]; return s;
    }));
    const statistics = emptyStatistics(at);
    statistics.status = "ready"; statistics.generated_at = at; statistics.note = "MOCK 每日 Token 统计，非真实账户消耗";
    for (const a of statistics.agents) { a.available = true; a.source = "mock.daily_usage"; }
    statistics.days.forEach((d,i) => { d.tokens = { codex: (i % 7 + 1) * 420000, claude: (i % 5 + 1) * 190000, deepseek: (i % 9 + 1) * 160000, grok:(i%4+1)*100000 }; });
    return { schema_version: 1, data_source: "mock", seq, generated_at: at, sessions, token_statistics: statistics,
      agents: AGENT_IDS.map((id,index) => ({ ...summarize(id, sessions.filter(s => s.agent_id === id), 5, at), note: "MOCK 场景演示，非真实 Agent 记录",
        quota:[{window_minutes:10080,used_ratio:measured([0.2,0.5,0.8,0.3][index],"mock.quota",at),resets_at:new Date(Date.now()+7*86400_000).toISOString()}] })) };
  }
  current() { return selectedSnapshot(this.value,this.selectedAgents()); }
  detail(id: string) { return this.current().sessions.find(s => s.id === id); }
  async refresh() { this.value = this.make(this.animate ? (Date.now() - this.started) / 1000 : this.phase, this.value.seq + 1); return this.value; }
}
