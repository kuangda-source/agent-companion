import { describe, expect, test } from "bun:test";
import { SettingsStore } from "./src/settings.ts";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockGateway } from "./src/server.ts";

describe("desktop and desired device settings", () => {
  test("upgrades replaced styles without losing device preferences", () => {
    const dir=mkdtempSync(join(tmpdir(),"ac-theme-migration-"));
    try {
      for(const [old,replacement] of [["paper","comic"],["midnight","neumorphism"]] as const) {
        const file=join(dir,"settings.json"), value=new SettingsStore().current();value.revision=7;value.device.brightness=38;value.appearance.animations_enabled=false;
        writeFileSync(file,JSON.stringify({...value,appearance:{...value.appearance,theme:old}}));
        const result=new SettingsStore(file).current();expect(result.appearance).toEqual({theme:replacement,animations_enabled:false});expect(result.device.brightness).toBe(38);expect(result.revision).toBe(8);
        expect(new SettingsStore(file).current()).toEqual(result);
      }
    } finally {rmSync(dir,{recursive:true});}
  });
  test("partial updates preserve independent changes, persist, and remain private", () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-settings-"));
    try {
      const file = join(dir, "settings.json"), a = new SettingsStore(file);
      a.update({ appearance: { theme: "comic" } });
      a.update({ device: { brightness: 35 } });
      a.update({ appearance: { animations_enabled: false } });
      const restored = new SettingsStore(file).current();
      expect(restored.appearance).toEqual({ theme: "comic", animations_enabled: false });
      expect(restored.device.brightness).toBe(35); expect(restored.revision).toBe(3);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(a.deviceStatus()).toMatchObject({ connected: false, pending: true, applied_settings: null });
    } finally { rmSync(dir, { recursive: true }); }
  });
  test("rejects unknown keys and invalid or credential-bearing settings without mutations", () => {
    const store = new SettingsStore(), before = store.current();
    for (const value of [{}, { api_key: "x" }, { appearance: { theme: "no" } }, { appearance: { animations_enabled: 1 } },
      { device: { brightness: 101 } }, { device: { volume: -1 } }, { device: { sleep_after_seconds: 12 } },
      { device: { relay_url: "ws://example.com" } }, { device: { relay_url: "wss://name:pass@example.com" } }, { device: { relay_url: "wss://example.com/?token=x" } }]) {
      expect(() => store.update(value)).toThrow(); expect(store.current()).toEqual(before);
    }
  });
  test("mock preferences stay separate and never acknowledge a physical device", async () => {
    const gateway = createMockGateway(0);
    try {
      const response = await fetch(new URL("api/v1/settings", gateway.server.url), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ appearance: { theme: "neumorphism" } }) });
      expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ appearance: { theme: "neumorphism" } });
      const device = await fetch(new URL("api/v1/device", gateway.server.url));
      expect(await device.json()).toMatchObject({ connected: false, applied_settings: null, pending: true });
    } finally { gateway.close(); }
  });
});
