import { Database } from "bun:sqlite";
import { MockState } from "./scenarios.ts";
import { timingSafeEqual } from "node:crypto";
import type { Collector } from "./state.ts";
import type { Envelope } from "../../../packages/protocol/src/index.ts";
import { SettingsStore, settingsResponse } from "./settings.ts";
import { Assistant,assistantResponse } from "./assistant.ts";
import type { RemoteLink } from "./remote-link.ts";
import type { CredentialStore } from "./credentials.ts";
import type { LanLink } from "./lan-link.ts";

/** Environment bootstrap only: no real collector, account, model, or audio. */
export function createMockGateway(port = 8736, animate = false, phase = 0, settings = new SettingsStore()) {
  const collector = new MockState(animate,phase);
  const database = new Database(":memory:");
  const sqlite = database.query<{ ok: number }, []>("SELECT 1 AS ok").get()?.ok === 1;
  const server = Bun.serve<{ ready: boolean }>({
    hostname: "127.0.0.1",
    port,
    async fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (path === "/api/v1/settings") return settingsResponse(request, settings);
      if (path === "/api/v1/device" && request.method === "GET") return Response.json(settings.deviceStatus(), { headers: { "Cache-Control": "no-store" } });
      if (request.method !== "GET") {
        return Response.json({ error: "read_only_mock" }, { status: 405 });
      }
      if (path === "/api/v1/health") {
        return Response.json({ status: "ok", service: "agent-companion", data_source: "mock", sqlite, bun: Bun.version });
      }
      if (path === "/api/v1/state") return Response.json(collector.current());
      if (path === "/api/v1/usage/statistics") return Response.json(collector.current().token_statistics);
      if (path.startsWith("/api/v1/sessions/")) {
        const session=collector.detail(decodeURIComponent(path.slice("/api/v1/sessions/".length)));
        return session ? Response.json(session) : Response.json({error:"not_found"},{status:404});
      }
      if (path === "/ws/v1" && server.upgrade(request, { data: { ready: false } })) return;
      return Response.json({ error: "not_found", data_source: "mock" }, { status: 404 });
    },
    websocket: {
      maxPayloadLength: 1024,
      message(socket, message) {
        let input: unknown;
        try {
          input = JSON.parse(typeof message === "string" ? message : message.toString());
        } catch {
          socket.close(1007, "invalid JSON");
          return;
        }
        if (typeof input !== "object" || input === null || !("type" in input)) {
          socket.close(1008, "hello required");
          return;
        }
        if (input.type !== "hello" || !("protocol" in input) || input.protocol !== 1) {
          socket.close(1008, "protocol 1 hello required");
          return;
        }
        if (socket.data.ready) return;
        socket.data.ready = true;
        socket.subscribe("snapshot");
        socket.send(JSON.stringify({
          schema_version: 1,
          seq: collector.current().seq,
          type: "snapshot",
          timestamp: new Date().toISOString(),
          data: collector.current(),
        }));
      },
    },
  });
  const timer=setInterval(async () => {
    await collector.refresh();
    server.publish("snapshot",JSON.stringify({schema_version:1,type:"snapshot",seq:collector.current().seq,timestamp:collector.current().generated_at,data:collector.current()}));
  },1000);
  return {
    server,
    close() {
      clearInterval(timer);
      server.stop(true);
      database.close();
    },
  };
}

/** A local capability token protects conversation text even on loopback. */
export function createLiveGateway(collector: Collector, token: string, port = 8736, pollMs = 2000, settings = new SettingsStore(), assistant?:Assistant, remote?:RemoteLink,lan?:LanLink,credentials?:CredentialStore) {
  const expected = Buffer.from(`Bearer ${token}`);
  const authorized = (request: Request) => {
    const actual = Buffer.from(request.headers.get("authorization") ?? "");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const packet = (): Envelope => ({ schema_version: 1, type: "snapshot", seq: collector.current().seq, timestamp: collector.current().generated_at, data: collector.current() });
  const error = (code: string, status: number) => Response.json({ error: { code, message: code, retryable: status >= 500 }, request_id: crypto.randomUUID() }, { status });
  const server = Bun.serve<{ ready: boolean }>({
    hostname: "127.0.0.1", port,
    async fetch(request, server) {
      const url = new URL(request.url), path = url.pathname;
      if (path === "/api/v1/health" && request.method === "GET") return Response.json({ status: "ok", service: "agent-companion", data_source: "live", seq: collector.current().seq });
      if (!authorized(request)) return error("unauthorized", 401);
      const origin = request.headers.get("origin");
      if (origin && origin !== server.url.origin) return error("origin_denied", 403);
      if(path==="/api/v1/quotas/status"&&request.method==="GET")return Response.json(collector.quotaStatus?.()??{enabled:false},{headers:{"Cache-Control":"no-store"}});
      if(path==="/api/v1/quotas/refresh"&&request.method==="POST"){
        try{
          if(!request.headers.get("content-type")?.startsWith("application/json"))return error("json_required",415);
          const text=await request.text();if(text.length>256)return error("request_too_large",413);
          const value:unknown=JSON.parse(text);
          if(!value||typeof value!=="object"||Array.isArray(value))return error("invalid_quota_trigger",400);
          const body=value as Record<string,unknown>;
          if(Object.keys(body).length!==1||!["wake","manual"].includes(String(body.reason)))return error("invalid_quota_trigger",400);
          if(!collector.triggerQuota)return error("quota_monitor_unavailable",409);
          collector.triggerQuota(body.reason as "wake"|"manual");return Response.json({status:"queued"},{status:202,headers:{"Cache-Control":"no-store"}});
        }catch{return error("invalid_quota_trigger",400);}
      }
      if(path==="/api/v1/credentials"&&credentials)return credentials.response(request);
      if(path==="/api/v1/host-display"){
        if(request.method==="POST"){
          if(!request.headers.get("content-type")?.startsWith("application/json"))return error("json_required",415);
          try{const raw=await request.text();if(raw.length>1024)return error("display_too_large",413);const before=settings.display.command(settings.current().device);settings.display.observe(JSON.parse(raw));const after=settings.display.command(settings.current().device);if(before.revision!==after.revision){remote?.pushView();lan?.pushView();}}catch{return error("invalid_host_display",400);}
        }else if(request.method!=="GET")return error("method_not_allowed",405);
        const usb=remote?.status().usb;
        if(usb?.mode==="usb_viewer"&&usb.data_fresh)settings.display.acknowledge(settings.display.command(settings.current().device),usb.display);
        return Response.json(settings.display.status(settings.current().device),{headers:{"Cache-Control":"no-store"}});
      }
      if(path==="/api/v1/connection/lan"&&request.method==="POST"&&lan)return lan.provision(request,!!remote?.status().usb);
      if(path==="/api/v1/connection"&&request.method==="GET"&&remote){const r=remote.status(),l=lan?.status();return Response.json({...r,lan:l,relay_device_connected:r.device_connected,device_connected:r.device_connected||!!l?.device_connected,data_fresh:r.data_fresh||!!l?.data_fresh,active_transport:l?.data_fresh?"wifi":r.data_fresh?"relay":null,last_applied_at:l?.data_fresh?l.last_applied_at:r.last_applied_at,last_applied_id:l?.data_fresh?l.last_applied_id:r.last_applied_id},{headers:{"Cache-Control":"no-store"}});}
      if(path.startsWith("/api/v1/connection") && remote)return remote.response(request);
      if(path.startsWith("/api/v1/assistant") && assistant)return assistantResponse(request,assistant);
      if (path === "/api/v1/settings") return settingsResponse(request, settings);
      if (path === "/api/v1/device" && request.method === "GET") return Response.json({ ...settings.deviceStatus(), ...(lan?.status().data_fresh||remote?.status().data_fresh ? { connected:true, state:"connected_readonly", transport:lan?.status().data_fresh?"wifi":"relay", capabilities:["snapshot","assistant_feed","themes","session_detail","usage_statistics","scheduled_tasks"] } : {}) }, { headers: { "Cache-Control": "no-store" } });
      if (path === "/api/v1/device/apply" && request.method === "POST") return error("device_not_connected", 409);
      if (request.method !== "GET") return error("read_only", 405);
      let response: Response | undefined;
      if (path === "/api/v1/state") response = Response.json(collector.current());
      else if(path==="/api/v1/schedules") response=Response.json(collector.current().scheduled_tasks??null);
      else if (path === "/api/v1/usage/statistics") response = Response.json(collector.current().token_statistics);
      else if (path === "/api/v1/agents") response = Response.json(collector.current().agents);
      else if (path === "/api/v1/quotas") response = Response.json(collector.current().agents.map(a => ({ agent_id: a.id, windows: a.quota, balance: a.balance })));
      else if (path === "/api/v1/sessions") {
        const agent = url.searchParams.get("agent"), limit = Number(url.searchParams.get("limit") ?? 5);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) return error("invalid_limit", 400);
        response = Response.json(collector.current().sessions.filter(s => !agent || s.agent_id === agent).slice(0, limit));
      } else if (path.startsWith("/api/v1/sessions/")) {
        const messages = path.endsWith("/messages");
        const encoded = path.slice("/api/v1/sessions/".length, messages ? -"/messages".length : undefined);
        let id: string;
        try { id = decodeURIComponent(encoded); } catch { return error("invalid_id", 400); }
        const session = collector.detail(id);
        if (!session) return error("not_found", 404);
        response = Response.json(messages ? session.messages : session);
      } else if (path === "/ws/v1" && server.upgrade(request, { data: { ready: false } })) return;
      else return error("not_found", 404);
      response.headers.set("Cache-Control", "no-store");
      return response;
    },
    websocket: {
      maxPayloadLength: 2048, idleTimeout: 30,
      message(socket, message) {
        let v: unknown;
        try { v = JSON.parse(String(message)); } catch { socket.close(1007, "invalid JSON"); return; }
        if (typeof v !== "object" || v === null || !("type" in v)) { socket.close(1008, "hello required"); return; }
        if (v.type === "hello" && "protocol" in v && v.protocol === 1) {
          if (!socket.data.ready) { socket.data.ready = true; socket.subscribe("snapshot"); }
          socket.send(JSON.stringify(packet()));
        } else if (socket.data.ready && (v.type === "resync" || v.type === "heartbeat")) socket.send(JSON.stringify(packet()));
        else socket.close(1008, "protocol 1 hello required");
      },
    },
  });
  const timer = setInterval(async () => {
    try { await collector.refresh(); server.publish("snapshot", JSON.stringify(packet())); void assistant?.tick(); }
    catch { /* The next health check exposes the unchanged seq; never publish fabricated data. */ }
  }, pollMs);
  return { server, close() { clearInterval(timer); server.stop(true); assistant?.close(); } };
}
