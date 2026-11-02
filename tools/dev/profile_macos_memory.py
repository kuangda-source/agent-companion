#!/usr/bin/env python3
"""Measure only this app's processes; no transcripts, tokens or environment values."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--samples", type=int, default=3)
parser.add_argument("--interval", type=float, default=10)
parser.add_argument("--app", type=Path, default=Path.home()/"Applications/AgentCompanion.app")
args = parser.parse_args()
if not 1 <= args.samples <= 12 or not 0 <= args.interval <= 60:
    parser.error("samples must be 1..12; interval must be 0..60 seconds")
paths = {
    str(args.app/"Contents/MacOS/AgentCompanion"): "controller",
    str(args.app/"Contents/Resources/bin/agent-companion-gateway"): "gateway",
    str(args.app/"Contents/Resources/bin/agent-companion-preview"): "preview",
}
report = {"metric": "vmmap physical footprint (MiB); RSS shown separately, shared mappings are not summed", "samples": []}
for index in range(args.samples):
    processes = []
    output = subprocess.check_output(["ps", "-axo", "pid=,ppid=,rss=,%cpu=,command="], text=True)
    for line in output.splitlines():
        fields = line.split(None, 4)
        if len(fields) != 5:
            continue
        pid, parent, rss, cpu, command = fields
        role = next((role for path, role in paths.items() if command == path or command.startswith(path+" ")), None)
        if not role:
            continue
        vm = subprocess.run(["vmmap", "-summary", pid], capture_output=True, text=True, timeout=15)
        def metric(label):
            match = re.search(r"^"+re.escape(label)+r":\s+([\d.]+)([KMG])", vm.stdout, re.M)
            return round(float(match[1])*{"K":1/1024,"M":1,"G":1024}[match[2]], 3) if match else None
        processes.append({"role": role, "pid": int(pid), "parent": int(parent), "rss_mib": round(int(rss)/1024, 3), "cpu_percent": float(cpu), "physical_mib": metric("Physical footprint"), "peak_physical_mib": metric("Physical footprint (peak)")})
    report["samples"].append({"at": datetime.now(timezone.utc).isoformat(), "processes": processes, "total_physical_mib": round(sum(p["physical_mib"] for p in processes), 3) if processes and all(p["physical_mib"] is not None for p in processes) else None})
    if index+1 < args.samples:
        time.sleep(args.interval)
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2)+"\n")
print(json.dumps(report, ensure_ascii=False))
