/** Internal application ports. These are not device DTOs or vendor SDK types. */
import type { AssistantMemoryReader } from "./assistant-memory-contract.ts";
export type AssistantEngineId = "builtin" | "mastra" | "letta";
export type AssistantOperation = "chat" | "briefing";
export interface AssistantIdentity {
  assistant_id: string;
  owner_id: string;
  conversation_id: string;
}
export interface PersonaSnapshot { id: string; revision: number; instructions: string }
export interface AssistantTask {
  identity: Readonly<AssistantIdentity>;
  persona: Readonly<PersonaSnapshot>;
  operation_id: string;
  turn_id: string;
  operation: AssistantOperation;
  input_source: "text" | "voice" | "background";
  /** Read-only domain context, already assembled by the application. */
  payload: unknown;
  response_format: string;
  model?: { id: string };
}
export type AssistantProgress =
  | { type: "text_delta"; sequence: number; text: string }
  | { type: "phase"; sequence: number; phase: "thinking" | "responding" };
export interface AssistantEvent {
  operation_id: string;
  turn_id: string;
  conversation_id: string;
  progress: AssistantProgress;
}
export type BudgetedCompletion = (payload: unknown, format: string, signal: AbortSignal) => Promise<unknown>;
/** For SDKs/processes that need an HTTP model endpoint. Token is a scoped gateway credential, not a provider key. */
export interface AssistantModelGatewayLease {
  operation_id: string;
  base_url: string;
  bearer_token: string;
  expires_at: string;
  close(): Promise<void>;
}
export interface AssistantEngineServices {
  memory?: AssistantMemoryReader;
  openModelGateway?: (task: Readonly<AssistantTask>, signal: AbortSignal) => Promise<AssistantModelGatewayLease>;
}
export interface AssistantEngineHost {
  signal: AbortSignal;
  /** Every foreground/background LLM call must pass the application's budget and ledger. */
  complete: BudgetedCompletion;
  emit: (progress: AssistantProgress) => void;
  memory?: AssistantMemoryReader;
  /** Reserved; adapters must reject unavailable access rather than use a private unmetered API client. */
  openModelGateway?: () => Promise<AssistantModelGatewayLease>;
}
export interface AssistantEngine {
  readonly id: AssistantEngineId;
  readonly operations: readonly AssistantOperation[];
  /** Untrusted result; the application still validates output and evidence IDs. */
  execute(task: Readonly<AssistantTask>, host: Readonly<AssistantEngineHost>): Promise<unknown>;
  close?():Promise<void>;
}
export type AssistantEngineOverrides = Partial<Record<AssistantOperation, AssistantEngine>>;
export interface AssistantRuntimeOptions extends AssistantEngineServices {
  engines?: AssistantEngineOverrides;
  onProgress?: (event: AssistantEvent) => void;
  clock?:()=>number;
}
export const builtinAssistantEngine: AssistantEngine = {
  id: "builtin", operations: ["chat", "briefing"],
  execute: (task, host) => host.complete(task.payload, task.response_format, host.signal),
};
export function bindAssistantEngines(overrides: AssistantEngineOverrides = {}): Record<AssistantOperation, AssistantEngine> {
  const bindings = { chat: overrides.chat ?? builtinAssistantEngine, briefing: overrides.briefing ?? builtinAssistantEngine };
  for (const operation of ["chat", "briefing"] as const) {
    if (!bindings[operation].operations.includes(operation)) throw new Error("unsupported_assistant_operation");
  }
  return bindings;
}

/** Scopes all progress to one turn. Late/cancelled/duplicate chunks never reach a future voice consumer. */
export async function executeAssistantTask(
  engine: AssistantEngine, task: AssistantTask, complete: BudgetedCompletion,
  signal: AbortSignal, onProgress?: (event: AssistantEvent) => void, services: AssistantEngineServices = {},
): Promise<unknown> {
  if (!engine.operations.includes(task.operation)) throw new Error("unsupported_assistant_operation");
  if (signal.aborted) throw new Error("assistant_cancelled");
  let active = true, sequence = -1;
  const leases:AssistantModelGatewayLease[]=[];
  let rejectAbort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => { rejectAbort = () => reject(new Error("assistant_cancelled")); });
  signal.addEventListener("abort", rejectAbort, { once: true });
  const checkedComplete: BudgetedCompletion = async (payload, format) => {
    if (!active || signal.aborted) throw new Error("assistant_cancelled");
    const result = await complete(payload, format, signal);
    if (!active || signal.aborted) throw new Error("assistant_cancelled");
    return result;
  };
  try {
    const execution = (async () => engine.execute(task, {
      signal, complete: checkedComplete,
      memory: services.memory,
      openModelGateway: services.openModelGateway ? async () => {
        if(!active||signal.aborted)throw new Error("assistant_cancelled");
        const lease=await services.openModelGateway!(task,signal);
        if(!active||signal.aborted){await lease.close();throw new Error("assistant_cancelled");}
        if(lease.operation_id!==task.operation_id){await lease.close();throw new Error("assistant_model_scope_mismatch");}
        leases.push(lease);
        return lease;
      } : undefined,
      emit(progress) {
        if (!active || signal.aborted || !Number.isSafeInteger(progress.sequence) || progress.sequence <= sequence) return;
        sequence = progress.sequence;
        onProgress?.({ operation_id: task.operation_id, turn_id: task.turn_id, conversation_id: task.identity.conversation_id, progress });
      },
    }))();
    const result = await Promise.race([execution, cancelled]);
    if (signal.aborted) throw new Error("assistant_cancelled");
    return result;
  } catch(error) {
    if(signal.aborted)throw new Error("assistant_cancelled");
    throw error;
  } finally {
    active = false; signal.removeEventListener("abort", rejectAbort);
    await Promise.allSettled(leases.map(lease=>Promise.resolve().then(()=>lease.close())));
  }
}
