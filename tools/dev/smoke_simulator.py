#!/usr/bin/env python3
"""Exercise SDL input -> LVGL pointer -> card callback and capture its result."""

from pathlib import Path
import subprocess
import os
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
capture = ROOT / "reports/screenshots/environment-selected-grok.bmp"
capture.parent.mkdir(parents=True, exist_ok=True)
result = subprocess.run([
    str(ROOT / ".build/simulator/agent_companion_sim"),
    "--mock", "--gateway", os.environ.get("AGENT_COMPANION_MOCK_GATEWAY", "http://127.0.0.1:8876"), "--frames", "100", "--smoke-agent", "grok", "--capture", str(capture),
], capture_output=True, text=True, check=True, timeout=20)
if "MOCK selected_agent=GROK" not in result.stdout:
    raise RuntimeError("SDL click did not select the Grok card: " + result.stdout + result.stderr)
with Image.open(capture) as img:
    if img.size != (1024, 600):
        raise ValueError("unexpected capture size")
    img.save(capture.with_suffix(".png"))
print("PASS: SDL input -> LVGL card selection, 1024x600 capture")
