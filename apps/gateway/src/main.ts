import { createLiveGateway, createMockGateway } from "./server.ts";
import {CodexQuotaReader} from "./codex-quota-rpc.ts";
import { LiveState } from "./state.ts";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SettingsStore } from "./settings.ts";
import { Assistant } from "./assistant.ts";
import { MastraAssistantEngine } from "./assistant-mastra.ts";
import { RemoteLink } from "./remote-link.ts";
import { CredentialStore } from "./credentials.ts";
import { LanLink } from "./lan-link.ts";
import { USBLink } from "./usb-link.ts";

const port = Number(process.env.PORT ?? 8736);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
const mock = process.argv.includes("--mock"), probe = process.argv.includes("--probe");
const phaseIndex=process.argv.indexOf("--mock-phase");
const phase=phaseIndex<0?0:Number(process.argv[phaseIndex+1]);
if(!Number.isInteger(phase)||phase<0||phase>=24||(!mock&&phaseIndex>=0)) throw new Error("--mock-phase requires --mock and an integer 0..23");
const runtime = process.env.AGENT_COMPANION_RUNTIME ? resolve(process.env.AGENT_COMPANION_RUNTIME) : resolve(import.meta.dir, "../../../.runtime"), tokenFile = `${runtime}/gateway.token`;
if (!mock) { await mkdir(runtime, { recursive: true, mode: 0o700 }); await chmod(runtime, 0o700); }
const budgetAmount = Number(process.env.DEEPSEEK_BALANCE_BUDGET_CNY);
if (process.env.DEEPSEEK_BALANCE_BUDGET_CNY && (!Number.isFinite(budgetAmount) || budgetAmount <= 0)) throw new Error("Invalid DEEPSEEK_BALANCE_BUDGET_CNY");
const settings = new SettingsStore(mock ? undefined : `${runtime}/settings.json`);
const quotaReader=mock||probe?undefined:new CodexQuotaReader();
const state = new LiveState(undefined, mock ? undefined : runtime, budgetAmount > 0 ? { currency: "CNY", amount: budgetAmount } : null,{selectedAgents:()=>settings.current().appearance.agent_ids,quotaRead:quotaReader?(signal)=>quotaReader.read(signal):undefined});
if (!mock) await state.refresh();
if (probe) {
  console.log(JSON.stringify({ at: state.current().generated_at, data_source: "live", agents: state.current().agents,
    sessions: state.current().sessions.map(s => ({ agent_id: s.agent_id, provider_session_id: s.provider_session_id, state: s.state, status_quality: s.status_quality, status_source: s.status_source, messages: s.messages.length, input_tokens: s.usage.input_tokens.value })) }, null, 2));
  process.exit(0);
}
let token: string | null = null;
if (!mock) {
  await mkdir(runtime, { recursive: true, mode: 0o700 }); await chmod(runtime, 0o700);
  token = crypto.randomUUID() + crypto.randomUUID();
  // Publish token only after the port has been successfully acquired.
}
const mastra=mock?undefined:new MastraAssistantEngine(runtime);
const assistant=mock?undefined:new Assistant(state,runtime,fetch,{engines:{chat:mastra,briefing:mastra}});
const remote=mock?undefined:new RemoteLink(runtime,state,settings,assistant);
const lan=mock?undefined:new LanLink(runtime,state,settings,assistant);
const credentials=mock?undefined:new CredentialStore(runtime,service=>{if(service==="deepseek")state.resetBalance();});
const gateway = mock ? createMockGateway(port, process.argv.includes("--animate"),phase,settings) : createLiveGateway(state, token!, port,2000,settings,assistant,remote,lan,credentials);
const usb=mock?undefined:new USBLink(runtime,state,settings,assistant);
if (token) { await writeFile(tokenFile, token, { mode: 0o600 }); await chmod(tokenFile, 0o600); }
console.log(`${mock ? "MOCK" : "LIVE"} Gateway: ${gateway.server.url}api/v1/health`);
console.log(mock ? "Explicit simulation; no real records." : "Read-only local sessions; conversation endpoints require the local runtime token.");
async function stop() {
  usb?.close();
  remote?.close();
  lan?.close();
  gateway.close();
  await state.shutdownQuota();
  await assistant?.shutdown();
  if (token && await Bun.file(tokenFile).text().catch(() => "") === token) await rm(tokenFile, { force: true });
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
