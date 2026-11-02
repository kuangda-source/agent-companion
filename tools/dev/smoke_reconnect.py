#!/usr/bin/env python3
"""Exercise HTTP loss/restart, SDL rendering and the assistant/tools footer."""
import json
import os
from pathlib import Path
import re
import subprocess
import time
from urllib.request import urlopen
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
CAPTURES = ROOT / ".cache/reconnect"
CAPTURES.mkdir(parents=True, exist_ok=True)
env = dict(os.environ, PORT="8738")
gateway = simulator = None
actions = []

def start_gateway(log, completed=False):
    child = subprocess.Popen([str(ROOT / ".tools/bin/bun"), "apps/gateway/src/main.ts", "--mock", "--mock-phase", "14" if completed else "0"], cwd=ROOT, env=env, stdout=log, stderr=log)
    for _ in range(50):
        if child.poll() is not None:
            raise RuntimeError("Test gateway could not acquire port 8738")
        try:
            with urlopen("http://127.0.0.1:8738/api/v1/health", timeout=0.3) as response:
                if json.load(response)["data_source"] == "mock":
                    return child
        except (OSError, ValueError):
            pass
        time.sleep(0.1)
    child.terminate()
    child.wait(timeout=5)
    raise RuntimeError("Test gateway did not become ready")

try:
    with (CAPTURES / "gateway.log").open("w") as gateway_log, (CAPTURES / "simulator.log").open("w") as simulator_log:
        gateway = start_gateway(gateway_log)
        simulator = subprocess.Popen([str(ROOT / ".build/simulator/agent_companion_sim"), "--mock", "--gateway", "http://127.0.0.1:8738",
                                      "--frames", "2800", "--smoke-actions", "--capture-prefix", str(CAPTURES / "frame"), "--capture-every", "60"],
                                     cwd=ROOT, stdout=simulator_log, stderr=simulator_log)
        started = time.monotonic()
        stopped = restarted = False
        while simulator.poll() is None:
            elapsed = time.monotonic() - started
            if elapsed > 6 and not stopped:
                gateway.terminate()
                gateway.wait(timeout=5)
                stopped = True
                actions.append({"action": "stop_gateway", "elapsed_ms": round(elapsed * 1000)})
            if elapsed > 40 and not restarted:
                gateway = start_gateway(gateway_log, completed=True)
                restarted = True
                actions.append({"action": "restart_gateway", "elapsed_ms": round(elapsed * 1000)})
            if elapsed > 58:
                raise RuntimeError("Simulator exceeded bounded reconnect test time")
            time.sleep(0.1)
        if simulator.returncode != 0:
            raise RuntimeError("Simulator failed; see .cache/reconnect/simulator.log")
finally:
    for child in (simulator, gateway):
        if child and child.poll() is None:
            child.terminate()
            child.wait(timeout=5)

log = (CAPTURES / "simulator.log").read_text()
events = [{"health": state, "tick_ms": int(tick)} for state, tick in re.findall(r"UI transport=(\w+) at_ms=(\d+)", log)]
assert [event["health"] for event in events] == ["fresh", "stale", "disconnected", "fresh"], events
assert 23900 <= events[2]["tick_ms"] - events[1]["tick_ms"] <= 24100, events
assert log.count("UI assistant_messages=opened") == 1
for tool in ["pelican", "connectivity"]:
    assert log.count("UI tool_unavailable=" + tool) == 1, tool
captures = [(int(frame), int(tick)) for frame, tick in re.findall(r"CAPTURE frame=(\d+) tick_ms=(\d+)", log)]
artifacts = []
for index, event in enumerate(events):
    target = event["tick_ms"] + (200 if index == 3 else 1000)
    next_event = events[index + 1]["tick_ms"] if index + 1 < len(events) else float("inf")
    candidates = [(frame, tick) for frame, tick in captures if target <= tick < next_event]
    assert candidates, event
    frame, tick = candidates[0]
    name = ["fresh", "stale", "offline", "recovered"][index]
    dest = ROOT / ("reports/screenshots/reconnect-" + name + ".png")
    with Image.open(CAPTURES / ("frame-%04d.bmp" % frame)) as image:
        image.save(dest)
    artifacts.append({"health": name, "frame": frame, "tick_ms": tick, "path": str(dest.relative_to(ROOT))})
report = {"data_source": "mock", "actions": actions, "ui_health_events": events, "footer_interactions": "assistant + 2 tool entries", "captures": artifacts,
          "recovery_expected_expression": "idle, no historical celebration even with a fresh completion UUID",
          "note": "Actual HTTP outage and restart; mock task completes during the outage. No external App task was started."}
(ROOT / "reports/reconnect-proof.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
