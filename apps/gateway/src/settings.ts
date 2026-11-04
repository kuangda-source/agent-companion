import { DisplaySync } from "./display-sync.ts";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {AGENT_IDS,DEFAULT_AGENT_IDS,type AgentId} from "../../../packages/protocol/src/index.ts";

export const themeIds = ["neon", "comic", "neumorphism"] as const;
export type ThemeId = typeof themeIds[number];
export interface Settings {
  schema_version: 1;
  revision: number;
  appearance: { theme: ThemeId; animations_enabled: boolean; show_scheduled_tasks:boolean; agent_ids:AgentId[] };
  device: { brightness: number; volume: number; sleep_after_seconds: number; transport: "auto" | "usb" | "wifi" | "relay"; relay_url: string; follow_host_brightness:boolean; follow_host_sleep:boolean };
}
const initial = (): Settings => ({ schema_version: 1, revision: 0,
  appearance: { theme: "neon", animations_enabled: true, show_scheduled_tasks:true, agent_ids:[...DEFAULT_AGENT_IDS] },
  device: { brightness: 75, volume: 50, sleep_after_seconds: 300, transport: "usb", relay_url: "", follow_host_brightness:true, follow_host_sleep:true } });
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_settings");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(k => !allowed.includes(k))) throw new Error("unknown_setting");
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}
function merged(current: Settings, input: unknown): Settings {
  const patch = record(input); keys(patch, ["appearance", "device"]);
  if (!Object.keys(patch).length) throw new Error("empty_settings");
  const result = structuredClone(current);
  if (patch.appearance !== undefined) {
    const a = record(patch.appearance); keys(a, ["theme", "animations_enabled", "show_scheduled_tasks", "agent_ids"]);
    if(a.agent_ids!==undefined){
      if(!Array.isArray(a.agent_ids)||a.agent_ids.length<1||a.agent_ids.length>3||new Set(a.agent_ids).size!==a.agent_ids.length||a.agent_ids.some(id=>!AGENT_IDS.includes(id)))throw new Error("invalid_agent_selection");
      result.appearance.agent_ids=[...a.agent_ids];
    }
    if (a.theme !== undefined) {
      if (!themeIds.includes(a.theme as ThemeId)) throw new Error("invalid_theme");
      result.appearance.theme = a.theme as ThemeId;
    }
    if(a.show_scheduled_tasks!==undefined){
      if(typeof a.show_scheduled_tasks!=="boolean")throw new Error("invalid_schedule_visibility");
      result.appearance.show_scheduled_tasks=a.show_scheduled_tasks;
    }
    if (a.animations_enabled !== undefined) {
      if (typeof a.animations_enabled !== "boolean") throw new Error("invalid_motion");
      result.appearance.animations_enabled = a.animations_enabled;
    }
  }
  if (patch.device !== undefined) {
    const d = record(patch.device); keys(d, ["brightness", "volume", "sleep_after_seconds", "transport", "relay_url", "follow_host_brightness", "follow_host_sleep"]);
    for(const key of ["follow_host_brightness","follow_host_sleep"] as const)if(d[key]!==undefined){if(typeof d[key]!=="boolean")throw new Error("invalid_display_sync");result.device[key]=d[key];}
    if (d.brightness !== undefined) { if (!integer(d.brightness, 5, 100)) throw new Error("invalid_brightness"); result.device.brightness = d.brightness; }
    if (d.volume !== undefined) { if (!integer(d.volume, 0, 100)) throw new Error("invalid_volume"); result.device.volume = d.volume; }
    if (d.sleep_after_seconds !== undefined) {
      if (typeof d.sleep_after_seconds !== "number" || ![0, 60, 300, 900, 1800].includes(d.sleep_after_seconds)) throw new Error("invalid_sleep");
      result.device.sleep_after_seconds = d.sleep_after_seconds;
    }
    if (d.transport !== undefined) {
      if (!["auto", "usb", "wifi", "relay"].includes(String(d.transport))) throw new Error("invalid_transport");
      result.device.transport = d.transport as Settings["device"]["transport"];
    }
    if (d.relay_url !== undefined) {
      if (typeof d.relay_url !== "string" || d.relay_url.length > 512) throw new Error("invalid_relay_url");
      if (d.relay_url) {
        const u = new URL(d.relay_url);
        if (u.protocol !== "wss:" || u.username || u.password || u.search || u.hash) throw new Error("invalid_relay_url");
      }
      result.device.relay_url = d.relay_url;
    }
  }
  return result;
}

/** This app's preferences only. Device values are desired settings, never an acknowledgement. */
export class SettingsStore {
  readonly display = new DisplaySync();
  private value = initial();
  constructor(private file?: string) {
    if (file && existsSync(file)) {
      const saved = record(JSON.parse(readFileSync(file, "utf8")));
      if (saved.schema_version !== 1 || !integer(saved.revision, 0, Number.MAX_SAFE_INTEGER)) throw new Error("unsupported_settings_file");
      const appearance = record(saved.appearance);
      const legacy = appearance.theme === "paper" ? "comic" : appearance.theme === "midnight" ? "neumorphism" : null;
      this.value = merged(this.value, { appearance: { ...appearance, ...(legacy ? { theme: legacy } : {}) }, device: saved.device });
      this.value.revision = saved.revision;
      if (legacy) this.update({ appearance: { theme: legacy } });
    }
  }
  current(): Settings { return structuredClone(this.value); }
  update(patch: unknown): Settings {
    const next = merged(this.value, patch); next.revision++;
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = this.file + ".tmp";
      writeFileSync(temporary, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 }); chmodSync(temporary, 0o600);
      renameSync(temporary, this.file);
    }
    this.value = next;
    return this.current();
  }
  deviceStatus() { return { connected: false, state: "not_connected", capabilities: [], applied_settings: null, desired_settings: this.current().device, pending: true }; }
}

export async function settingsResponse(request: Request, store: SettingsStore): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  if (request.method === "GET") return Response.json(store.current(), { headers });
  if (request.method !== "PATCH") return Response.json({ error: "method_not_allowed" }, { status: 405, headers });
  if (!request.headers.get("content-type")?.startsWith("application/json")) return Response.json({ error: "json_required" }, { status: 415, headers });
  try {
    const raw = await request.text();
    if (raw.length > 4096) return Response.json({ error: "settings_too_large" }, { status: 413, headers });
    return Response.json(store.update(JSON.parse(raw)), { headers });
  } catch { return Response.json({ error: "invalid_settings" }, { status: 400, headers }); }
}
