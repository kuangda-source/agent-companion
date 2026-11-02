#!/usr/bin/env python3
"""Exercise SDL input -> LVGL pointer -> card callback and capture its result."""

from pathlib import Path
import subprocess
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
capture = ROOT / "reports/screenshots/environment-selected-claude.bmp"
capture.parent.mkdir(parents=True, exist_ok=True)
result = subprocess.run([
    str(ROOT / ".build/simulator/agent_companion_sim"),
    "--mock", "--frames", "32", "--smoke-input", "--capture", str(capture),
], capture_output=True, text=True, check=True, timeout=20)
if "MOCK selected_agent=claude" not in result.stdout:
    raise RuntimeError("SDL click did not select the Claude card: " + result.stdout + result.stderr)
with Image.open(capture) as img:
    if img.size != (1024, 600):
        raise ValueError("unexpected capture size")
    img.save(capture.with_suffix(".png"))
print("PASS: SDL input -> LVGL card selection, 1024x600 capture")
