#!/usr/bin/env python3
"""Install the pinned ESP32-P4 SDK in project-local directories. Never flashes hardware."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[2]
spec=json.loads((ROOT/"device-toolchain.lock.json").read_text())["esp_idf"]
sdk=ROOT/".deps"/("esp-idf-v"+spec["version"])
if shutil.disk_usage(ROOT).free < 8*1024**3:
    raise RuntimeError("ESP-IDF preparation requires at least 8 GiB free disk")
if not sdk.exists():
    subprocess.run(["git","clone","--depth","1","--branch","v"+spec["version"],spec["url"],str(sdk)],check=True)
actual=subprocess.check_output(["git","-C",str(sdk),"rev-parse","HEAD"],text=True).strip()
if actual!=spec["commit"]:
    raise RuntimeError("SDK checkout differs from device-toolchain.lock.json; refusing to reset it")
subprocess.run(["git","-C",str(sdk),"submodule","update","--init","--recursive","--depth","1","--jobs","1"],check=True)
env=os.environ|{"IDF_TOOLS_PATH":str(ROOT/".tools/esp-idf")}
subprocess.run([sys.executable,str(sdk/"tools/idf_tools.py"),"install","cmake","ninja"],env=env,check=True)
subprocess.run([str(sdk/"install.sh"),"esp32p4"],env=env,check=True)
print("Project-local ESP-IDF ready. No shell startup file or global SDK was changed.")
