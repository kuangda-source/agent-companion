import type { AssistantEngineId, AssistantIdentity, PersonaSnapshot } from "./assistant-runtime.ts";

/** App-owned memory, distinct from monitored project facts and provider-private scratchpads. */
export interface AssistantMemoryRecord {
  id: string;
  kind: "preference" | "episode";
  text: string;
  revision: number;
  status: "active" | "deleted";
  source: { conversation_id: string; message_id: string | null; timestamp: string };
  updated_at: string;
  supersedes: string | null;
}
export interface AssistantHistoryRecord {
  id: string;
  conversation_id: string;
  turn_id: string | null;
  role: "user" | "assistant";
  text: string;
  created_at: string;
  source_ids: string[];
  delivery: { channel: "text" | "voice"; delivered_prefix_chars: number | null; interrupted: boolean | null };
}
export interface AssistantStateSnapshot {
  schema_version: 1;
  identity: AssistantIdentity;
  persona: PersonaSnapshot;
  memory_revision: number;
  memories: AssistantMemoryRecord[];
  history: AssistantHistoryRecord[];
  coverage: { history_complete: boolean; through_message_id: string | null };
  /** Backend handles are mappings, never replacements for application IDs. */
  bindings: { engine: AssistantEngineId; agent_handle: string; conversation_handle: string | null }[];
}
export interface AssistantMemoryPort {
  recall(query: { identity: AssistantIdentity; text: string; limit: number }): Promise<AssistantMemoryRecord[]>;
  /** Only application-approved changes; SDK-generated proposals are not approval. */
  apply(change: {
    identity: AssistantIdentity; operation_id: string; expected_revision: number;
    upsert: AssistantMemoryRecord[]; forget_ids: string[];
  }): Promise<{ revision: number }>;
  exportState(identity: AssistantIdentity): Promise<AssistantStateSnapshot>;
  /** Implementations must reject stale revisions and retain deletion tombstones. */
  importState(snapshot: AssistantStateSnapshot, options: {
    operation_id: string; expected_revision: number; dry_run: boolean;
  }): Promise<{ revision: number; applied: boolean }>;
}
export type AssistantMemoryReader = Pick<AssistantMemoryPort,"recall"|"exportState">;

/** Domain invariants after a backend adapter decodes an import. No vendor writes happen here. */
export function assertAssistantHandoff(snapshot: AssistantStateSnapshot, expected: {
  identity: AssistantIdentity; memory_revision: number;
}): void {
  if(snapshot.schema_version!==1)throw new Error("unsupported_assistant_state_version");
  for(const key of ["assistant_id","owner_id","conversation_id"] as const) {
    if(snapshot.identity[key]!==expected.identity[key])throw new Error("assistant_identity_mismatch");
  }
  if(!Number.isSafeInteger(snapshot.memory_revision)||snapshot.memory_revision<0||snapshot.memory_revision!==expected.memory_revision)throw new Error("stale_assistant_memory");
  const ids=new Set<string>();
  for(const item of snapshot.memories) {
    if(!item.id||ids.has(item.id))throw new Error("duplicate_assistant_memory");ids.add(item.id);
    if(!Number.isSafeInteger(item.revision)||item.revision<1||item.revision>snapshot.memory_revision)throw new Error("invalid_assistant_memory_revision");
    if(item.status==="deleted"&&item.text!=="")throw new Error("deleted_assistant_memory_has_content");
  }
  for(const item of snapshot.history) {
    const n=item.delivery.delivered_prefix_chars;
    if(n!==null&&(!Number.isSafeInteger(n)||n<0||n>[...item.text].length))throw new Error("invalid_assistant_delivery_position");
  }
}

/** Presentation/voice use the same turn IDs; audio data and speaker templates stay outside LLM memory. */
export interface AssistantVoicePort {
  submitFinalTranscript(input: {
    identity: AssistantIdentity; utterance_id: string; turn_id: string; text: string;
  }): Promise<{ operation_id: string }>;
  interrupt(input: { operation_id: string; turn_id: string }): Promise<void>;
  acknowledgePlayback(input: {
    turn_id: string; delivered_prefix_chars: number; interrupted: boolean;
  }): Promise<void>;
}
