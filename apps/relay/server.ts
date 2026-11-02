import { createHash, timingSafeEqual } from "node:crypto";
import type { ServerWebSocket } from "bun";
export const MAX_VIEW = 192 * 1024;
type Role = "mac" | "device";
interface Peer { role: Role; count: number; window: number; seen: number }
export interface RelayConfig { mac_sha256: string; device_sha256: string }
export function digest(value: string) { return createHash("sha256").update(value).digest("hex"); }
export function createRelay(config: RelayConfig, port = 18736, options: { now?:()=>number; leaseMs?:number } = {}) {
  const clock=options.now??(()=>performance.now()),leaseMs=options.leaseMs??20000;
  for (const hash of [config.mac_sha256, config.device_sha256]) if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("invalid_role_hash");
  if(config.mac_sha256===config.device_sha256)throw new Error("distinct_role_credentials_required");
  const peers = new Map<Role, ServerWebSocket<Peer>>();
  let presenceAt=clock();
  let forwards = 0;
  const heartbeats={mac:0,device:0};
  const lastClosed:Partial<Record<Role,{code:number;at:number}>>={};
  function peerState(){return {kind:"peer",mac_connected:peers.has("mac"),device_connected:peers.has("device")};}
  function expired(){
    for(const [role,ws] of peers)if(clock()-ws.data.seen>=leaseMs){peers.delete(role);lastClosed[role]={code:4000,at:Date.now()};ws.close(4000,"heartbeat timeout");for(const other of peers.values())other.send(JSON.stringify(peerState()));}
  }
  const auth = (req: Request): Role | null => {
    const raw = req.headers.get("authorization") ?? "";
    if (!raw.startsWith("Bearer ") || raw.length > 200) return null;
    const hash = Buffer.from(digest(raw.slice(7)), "hex");
    for (const role of ["mac", "device"] as const) if (timingSafeEqual(hash, Buffer.from(config[`${role}_sha256`], "hex"))) return role;
    return null;
  };
  const server = Bun.serve<Peer>({
    hostname: "127.0.0.1", port,
    fetch(req, server) {
      const u = new URL(req.url);expired();
      if (u.pathname === "/health" && req.method === "GET") return Response.json({ service: "agent-companion-relay", status: "ok", protocol: 1 });
      const role = auth(req);
      if (!role) return new Response("Unauthorized", { status: 401 });
      if (u.search || u.hash || req.headers.get("origin")) return new Response("Invalid endpoint", { status: 403 });
      if (u.pathname === "/v1/status" && req.method === "GET" && role === "mac") return Response.json({ mac_connected: peers.has("mac"), device_connected: peers.has("device"), forwarded: forwards,heartbeats, mac_age_ms:peers.has("mac")?clock()-peers.get("mac")!.data.seen:null,device_age_ms:peers.has("device")?clock()-peers.get("device")!.data.seen:null,last_closed:lastClosed }, { headers: { "Cache-Control": "no-store" } });
      if (u.pathname !== "/v1/link" || req.method !== "GET") return new Response("Not found", { status: 404 });
      if (peers.has(role)) return new Response("Role already connected", { status: 409 });
      if (server.upgrade(req, { data: { role, count: 0, window: clock(), seen:clock() } })) return;
      return new Response("WebSocket required", { status: 426 });
    },
    websocket: {
      maxPayloadLength: MAX_VIEW, idleTimeout: 45, sendPings: true, backpressureLimit: MAX_VIEW * 2, closeOnBackpressureLimit: true,
      open(ws) {
        if(peers.has(ws.data.role)){ws.close(1008,"role occupied");return;}
        peers.set(ws.data.role, ws);
        for (const p of peers.values()) p.send(JSON.stringify({ kind: "peer", mac_connected: peers.has("mac"), device_connected: peers.has("device") }));
      },
      message(ws, raw) {
        if (peers.get(ws.data.role) !== ws) return;
        const now = clock();
        ws.data.seen=now;
        if (now - ws.data.window > 1000) { ws.data.window = now; ws.data.count = 0; }
        if (++ws.data.count > 8) { ws.close(1008, "rate limit"); return; }
        const text = typeof raw === "string" ? raw : raw.toString();
        let p: Record<string, unknown>;
        try { p = JSON.parse(text); if (!p || Array.isArray(p) || typeof p !== "object") throw 0; } catch { ws.close(1007, "JSON required"); return; }
        if(p.kind==="heartbeat"&&Number.isSafeInteger(p.id)&&Number(p.id)>=0){heartbeats[ws.data.role]++;ws.send(JSON.stringify({...peerState(),kind:"heartbeat",id:p.id}));return;}
        let valid = false;
        if (ws.data.role === "mac") {
          const state = p.state as Record<string, unknown> | undefined;
          valid = typeof p.gateway_boot_id === "string" && /^[a-f0-9-]{36}$/.test(p.gateway_boot_id) && Number.isSafeInteger(p.id) && Number(p.id) > 0 && typeof p.sent_at === "number" && Math.abs(Date.now() / 1000 - p.sent_at) < 15 && state?.data_source === "live" && p.capture === undefined;
        } else {
          valid = (p.kind === "theme" && ["neon", "comic", "neumorphism"].includes(String(p.value))) ||
            (p.kind === "detail" && typeof p.id === "string" && Buffer.byteLength(p.id) < 160) || p.kind === "assistant_refresh" ||
            ["disconnected","snapshot_rejected","frame_timeout","frame_crc_error","frame_json_error","provision_rejected"].includes(String(p.kind)) ||
            (p.kind === "applied" && Number.isSafeInteger(p.id) && typeof p.gateway_boot_id === "string");
        }
        if (!valid) { ws.close(1008, "unsupported packet"); return; }
        const other = peers.get(ws.data.role === "mac" ? "device" : "mac");
        if (other) { if(other.getBufferedAmount()>MAX_VIEW){other.close(1013,"slow peer");return;}other.send(text); forwards++; }
      },
      close(ws,code) {
        if (peers.get(ws.data.role) !== ws) return;
        peers.delete(ws.data.role);lastClosed[ws.data.role]={code,at:Date.now()};
        for (const p of peers.values()) p.send(JSON.stringify({ kind: "peer", mac_connected: peers.has("mac"), device_connected: peers.has("device") }));
      },
    },
  });
  const sweeper=setInterval(()=>{
    expired();
    /* Keep both directions active even when the Mac has no source view to send.
     * Presence is transport state only; clients still require a view/apply ACK. */
    if(clock()-presenceAt>=5000){presenceAt=clock();const value=JSON.stringify(peerState());for(const ws of peers.values())ws.send(value);}
  },1000);
  return { server, close() { clearInterval(sweeper);server.stop(true); } };
}
