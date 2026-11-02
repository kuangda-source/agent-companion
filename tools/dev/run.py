#!/usr/bin/env python3
"""Start this project's gateway and native LVGL simulator; stop owned processes on exit."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = Path(os.environ.get("AGENT_COMPANION_RUNTIME", str(ROOT / ".runtime")))
parser = argparse.ArgumentParser()
parser.add_argument("--mock", action="store_true")
parser.add_argument("--animate", action="store_true")
parser.add_argument("--mock-phase",type=int,default=0)
args, simulator_args = parser.parse_known_args()
if args.animate and not args.mock:
    parser.error("--animate is a synthetic scenario; use --mock --animate")
port = int(os.environ.get("PORT", "8736"))
if not 1 <= port <= 65535:
    parser.error("PORT must be 1..65535")
command = [str(ROOT / ".tools/bin/bun"), "run", "apps/gateway/src/main.ts"]
if args.mock:
    command += ["--mock", "--mock-phase", str(args.mock_phase)]
if args.animate:
    command += ["--animate"]
gateway = subprocess.Popen(command, cwd=ROOT)
simulator = None
try:
    ready = False
    for _ in range(100):
        if gateway.poll() is not None:
            raise RuntimeError("Gateway stopped during startup; check PORT availability above")
        try:
            with urlopen("http://127.0.0.1:%d/api/v1/health" % port, timeout=0.5) as response:
                health = json.load(response)
            ready = health.get("data_source") == ("mock" if args.mock else "live")
        except (OSError, ValueError):
            pass
        if ready:
            break
        time.sleep(0.1)
    if not ready:
        raise RuntimeError("Gateway did not become ready")
    command = [str(ROOT / ".build/simulator/agent_companion_sim"), "--gateway", "http://127.0.0.1:%d" % port,
               "--token-file", str(RUNTIME / "gateway.token")]
    if args.mock:
        command += ["--mock"]
    simulator = subprocess.Popen(command + simulator_args, cwd=ROOT)
    raise SystemExit(simulator.wait())
except KeyboardInterrupt:
    pass
finally:
    for child in (simulator, gateway):
        if child and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
