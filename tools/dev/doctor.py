#!/usr/bin/env python3
"""Inspect the local simulator prerequisites without touching external Apps."""

import hashlib
import argparse
import json
from pathlib import Path
import platform
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
LOCK = json.loads((ROOT / "dev-toolchain.lock.json").read_text())
parser=argparse.ArgumentParser()
parser.add_argument("--output",type=Path,default=ROOT / "reports/environment-doctor.json")
args=parser.parse_args()


def version(command):
    try:
        result = subprocess.run([str(part) for part in command], capture_output=True, text=True, timeout=15)
        return result.stdout.strip() if result.returncode == 0 else None
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None


versions = {
    "bun": version([ROOT / ".tools/bin/bun", "--version"]),
    "cmake": version([ROOT / ".venv-dev/bin/cmake", "--version"]),
    "sdl2": version([ROOT / ".tools/sdl2/bin/sdl2-config", "--version"]),
    "clang": version(["clang", "--version"]),
    "sdk": version(["xcrun", "--show-sdk-version"]),
}
checks = {
    "platform": (platform.system(), platform.machine()) == ("Darwin", "arm64"),
    "bun": versions["bun"] == LOCK["bun"]["version"],
    "cmake": bool(versions["cmake"] and versions["cmake"].splitlines()[0] == "cmake version " + LOCK["cmake"]),
    "sdl2": versions["sdl2"] == LOCK["sdl2"]["version"],
    "clang_and_sdk": bool(versions["clang"] and versions["sdk"]),
    "lvgl_source": (ROOT / ".deps/lvgl/.source-sha256").exists()
        and (ROOT / ".deps/lvgl/.source-sha256").read_text().strip() == LOCK["lvgl"]["sha256"],
    "python_asset_dependencies": version([ROOT / ".venv-dev/bin/python", "-c", "import PIL,jsonschema; print('ok')"]) == "ok",
    "typescript_dependencies": (ROOT / "node_modules/typescript/bin/tsc").exists(),
    "font_converter": (ROOT / "node_modules/lv_font_conv/lv_font_conv.js").exists(),
    "font_source": all((ROOT / ".cache/fonts" / name).exists()
        and hashlib.sha256((ROOT / ".cache/fonts" / name).read_bytes()).hexdigest() == digest
        for name,digest in LOCK["ui_font_mono"]["files"].items()),
    "font_license": (ROOT / LOCK["ui_font_mono"]["license"]).exists()
        and hashlib.sha256((ROOT / LOCK["ui_font_mono"]["license"]).read_bytes()).hexdigest() == LOCK["ui_font_mono"]["license_sha256"],
}
report = {
    "status": "PASS" if all(checks.values()) else "INCOMPLETE",
    "checks": checks,
    "versions": versions,
    "lvgl_version": LOCK["lvgl"]["version"],
    "simulator_built": (ROOT / ".build/simulator/agent_companion_sim").exists(),
    "ui_font_generated": all((ROOT / "generated/fonts" / name).exists() for name in ["ac_font_ui_16.c","ac_font_mono_13.c","ac_font_mono_20.c","ac_font_display_22.c"]),
    "real_agent_adapters": "READ_ONLY_CODE_PRESENT; run ./scripts/dev probe for live verification",
    "claude_code_real_session": "NOT_VERIFIED",
    "hardware": "NOT_VERIFIED",
}
path = args.output
path.parent.mkdir(exist_ok=True)
path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
print(json.dumps(report, indent=2, ensure_ascii=False))
sys.exit(0 if all(checks.values()) else 1)
