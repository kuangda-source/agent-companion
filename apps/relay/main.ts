import { createRelay, type RelayConfig } from "./server.ts";
const file = process.env.AC_RELAY_CONFIG ?? "/etc/agent-companion/relay.json";
const relay = createRelay(await Bun.file(file).json() as RelayConfig, Number(process.env.PORT ?? 18736));
console.log("Agent Companion relay listening on loopback; no payload persistence");
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { relay.close(); process.exit(0); });
