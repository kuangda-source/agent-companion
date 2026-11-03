export const AGENT_IDS = ["codex", "claude", "deepseek", "grok"] as const;
export type AgentId = typeof AGENT_IDS[number];
export const DEFAULT_AGENT_IDS: AgentId[] = ["codex", "grok", "deepseek"];
export type Quality = "confirmed" | "estimated" | "unavailable" | "unknown";
export type State = "running" | "waiting_user" | "idle" | "completed" | "error" | "unknown" | "disconnected";
export type Health = "fresh" | "stale" | "disconnected" | "unknown";
export interface Measured<T> {
  value: T | null;
  quality: Quality;
  source: string;
  observed_at: string | null;
}
export interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: string | null;
}
export interface Usage {
  input_tokens: Measured<number>;
  output_tokens: Measured<number>;
  cache_read_tokens: Measured<number>;
  cache_write_tokens: Measured<number>;
  cache_ratio: Measured<number>;
  context_ratio: Measured<number>;
}
export interface Session {
  id: string;
  host_id: "local";
  agent_id: AgentId;
  provider_session_id: string;
  source_namespace: string;
  title: string;
  project_name: string | null;
  model: string | null;
  state: State;
  status_quality: Quality;
  status_source: string;
  status_observed_at: string | null;
  observation_health: Health;
  last_activity_at: string | null;
  started_at: string | null;
  run_duration_seconds: number | null;
  completion_event_id: string | null;
  completion_event_at: string | null;
  usage: Usage;
  messages: Message[];
  transcript_truncated: boolean;
}
export interface Capability {
  quality: Quality;
  source: string;
  note: string;
}
export interface QuotaWindow {
  health?: "fresh" | "stale";
  window_minutes: number;
  used_ratio: Measured<number>;
  resets_at: string | null;
}
export interface AccountBalance {
  health: Health;
  source: string;
  observed_at: string | null;
  note: string;
  wallets: { currency: "CNY" | "USD"; total: string; granted: string; topped_up: string }[];
  budget: { currency: "CNY" | "USD"; amount: number } | null;
}
export interface TokenStatistics {
  status: "loading" | "ready" | "partial" | "failed";
  timezone: string;
  generated_at: string | null;
  note: string;
  agents: { id: AgentId; available: boolean; partial: boolean; source: string }[];
  days: { date: string; tokens: Record<AgentId, number | null> }[];
}
export interface Agent {
  id: AgentId;
  name: string;
  state: State;
  status_quality: Quality;
  observation_health: Health;
  session_count: number;
  running_count: number;
  waiting_count: number;
  observed_at: string | null;
  note: string;
  capabilities: { sessions: Capability; messages: Capability; status: Capability; usage: Capability };
  quota: QuotaWindow[];
  balance: AccountBalance | null;
}
export interface Snapshot {
  schema_version: 1;
  data_source: "live" | "mock";
  seq: number;
  generated_at: string;
  agents: Agent[];
  sessions: Session[];
  token_statistics: TokenStatistics;
  scheduled_tasks?: ScheduledTasks;
}
export interface ScheduledTask {
  id:string; agent_id:AgentId; title:string; kind:"cron"|"heartbeat"|"unknown";
  status:"active"|"paused"|"unknown"; next_run_at:string|null; last_run_at:string|null;
  session_id:string|null; thread_title:string|null; source:string;
  conversation_state?:State|null;
}
export interface ScheduledTasks {
  status:"ready"|"failed"|"unavailable"; observed_at:string|null; as_of_epoch:number;
  sources:{agent_id:AgentId; quality:Quality; note:string}[]; tasks:ScheduledTask[];
}
export interface Envelope {
  schema_version: 1;
  type: "snapshot";
  seq: number;
  timestamp: string;
  data: Snapshot;
}
export const STATUS_PRIORITY: Record<State, number> = {
  error: 0, waiting_user: 1, running: 2, idle: 3, completed: 3, unknown: 4, disconnected: 5,
};
