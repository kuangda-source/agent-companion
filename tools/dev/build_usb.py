#!/usr/bin/env python3
"""Build the native macOS serial transport; no Python runtime in the app."""
from pathlib import Path
import subprocess

ROOT=Path(__file__).resolve().parents[2]
output=ROOT/'.build/agent-companion-usb'
output.parent.mkdir(exist_ok=True)
subprocess.run(['clang','-O2','-Wall','-Wextra','-Werror','-mmacosx-version-min=13.0',
                str(ROOT/'tools/dev/usb_serial.c'),'-framework','IOKit','-framework','CoreFoundation','-o',str(output)],check=True)
print(output)
