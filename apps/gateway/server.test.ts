import { expect, test } from "bun:test";
import { createLiveGateway, createMockGateway } from "./src/server.ts";
import { MockState } from "./src/scenarios.ts";
import { array, object, string } from "./src/adapters/common.ts";

test("native SQLite, loopback HTTP and WebSocket snapshot work together", async () => {
  const gateway = createMockGateway(0);
  try {
    const base = gateway.server.url;
    const response = await fetch(new URL("/api/v1/health", base));
    expect(await response.json()).toMatchObject({ data_source: "mock", sqlite: true });
    const state = object(await (await fetch(new URL("/api/v1/state", base))).json());
    expect(state.data_source).toBe("mock");
    expect(state.agents).toHaveLength(3);
    const snapshot = await new Promise<unknown>((resolve, reject) => {
      const url = new URL("/ws/v1", base);
      url.protocol = "ws:";
      const socket = new WebSocket(url);
      const timeout = setTimeout(() => { socket.close(); reject(new Error("WebSocket timeout")); }, 2000);
      socket.onopen = () => socket.send(JSON.stringify({ type: "hello", protocol: 1 }));
      socket.onerror = () => { clearTimeout(timeout); reject(new Error("WebSocket failure")); };
      socket.onmessage = (event) => {
        clearTimeout(timeout);
        resolve(JSON.parse(String(event.data)));
        socket.close();
      };
    });
    expect(snapshot).toMatchObject({ type: "snapshot", data: { data_source: "mock" } });
    const rejected = await fetch(new URL("/api/v1/assistant/turn", base), { method: "POST" });
    expect(rejected.status).toBe(405);
  } finally {
    gateway.close();
  }
});

test("conversation endpoints reject missing/wrong tokens and hostile Origins; authenticated WS can resync", async () => {
  const token=crypto.randomUUID()+crypto.randomUUID(), collector=new MockState();
  const gateway=createLiveGateway(collector,token,0,50);
  try {
    const base=gateway.server.url;
    expect((await fetch(new URL("/api/v1/state",base))).status).toBe(401);
    expect((await fetch(new URL("/api/v1/usage/statistics",base))).status).toBe(401);
    expect((await fetch(new URL("/api/v1/state",base),{headers:{authorization:"Bearer wrong"}})).status).toBe(401);
    const headers={authorization:`Bearer ${token}`};
    const patch={method:"PATCH",body:JSON.stringify({appearance:{theme:"comic"}}),headers:{"Content-Type":"application/json"}};
    expect((await fetch(new URL("/api/v1/settings",base),patch)).status).toBe(401);
    expect((await fetch(new URL("/api/v1/settings",base),{...patch,headers:{...patch.headers,...headers,origin:"https://untrusted.example"}})).status).toBe(403);
    expect((await fetch(new URL("/api/v1/settings",base),{...patch,headers:{...patch.headers,...headers}})).status).toBe(200);
    expect((await fetch(new URL("/api/v1/device/apply",base),{method:"POST",headers})).status).toBe(409);
    expect((await fetch(new URL("/api/v1/state",base),{headers:{...headers,origin:"https://untrusted.example"}})).status).toBe(403);
    expect((await fetch(new URL("/api/v1/state",base),{headers,method:"POST"})).status).toBe(405);
    const displayURL=new URL("/api/v1/host-display",base), observation={display_id:1,display_name:"Test screen",brightness_ratio:.6,screen_awake:true,observed_at:new Date().toISOString()};
    expect((await fetch(displayURL)).status).toBe(401);
    expect((await fetch(displayURL,{method:"POST",headers:{...headers,"Content-Type":"application/json",origin:"https://untrusted.example"},body:JSON.stringify(observation)})).status).toBe(403);
    const display=await fetch(displayURL,{method:"POST",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify(observation)});
    expect(display.status).toBe(200);expect(await display.json()).toMatchObject({target:{brightness_percent:60,screen_on:true},in_sync:false});
    expect((await fetch(displayURL,{method:"POST",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify({...observation,brightness_ratio:2})})).status).toBe(400);
    const response=await fetch(new URL("/api/v1/state",base),{headers});
    expect(response.headers.get("cache-control")).toBe("no-store");
    const s=object(await response.json()); expect(s.data_source).toBe("mock");
    const usage=await fetch(new URL("/api/v1/usage/statistics",base),{headers});
    expect(usage.headers.get("cache-control")).toBe("no-store");
    expect(array(object(await usage.json()).days)).toHaveLength(30);
    const id=string(object(array(s.sessions)[0]).id)!;
    const detail=await fetch(new URL(`/api/v1/sessions/${encodeURIComponent(id)}`,base),{headers});
    expect(array(object(await detail.json()).messages).length).toBeGreaterThan(0);
    const seqs=await new Promise<number[]>((resolve,reject)=>{
      const url=new URL("/ws/v1",base); url.protocol="ws:";
      const socket=new WebSocket(url,{headers});
      const timeout=setTimeout(()=>{socket.close();reject(new Error("WS resync timeout"));},2000);
      const seen:number[]=[];
      socket.onopen=()=>socket.send(JSON.stringify({type:"hello",protocol:1}));
      socket.onerror=()=>{clearTimeout(timeout);reject(new Error("WS failure"));};
      socket.onmessage=e=>{
        const packet=JSON.parse(String(e.data)); seen.push(packet.seq);
        if(seen.length===2) socket.send(JSON.stringify({type:"resync"}));
        if(seen.length===3) { clearTimeout(timeout);socket.close();resolve(seen); }
      };
    });
    expect(seqs[1]).toBeGreaterThan(seqs[0]);
    expect(seqs[2]).toBeGreaterThanOrEqual(seqs[1]);
  } finally { gateway.close(); }
});
