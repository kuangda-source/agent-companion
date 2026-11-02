#!/usr/bin/env python3
"""Compile the pinned CJK monospace UI and terminal display faces."""
import hashlib
import json
import re
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
spec = json.loads((ROOT / "dev-toolchain.lock.json").read_text())["ui_font_mono"]
for name, digest in spec["files"].items():
    if hashlib.sha256((ROOT / ".cache/fonts" / name).read_bytes()).hexdigest() != digest:
        raise ValueError("Run python tools/dev/setup_fonts.py: font checksum mismatch")
sources = sorted((ROOT / "packages/ui").rglob("*.c")) + sorted((ROOT / "packages/ui/include").glob("*.h"))
symbols = "".join(sorted({c for path in sources for c in path.read_text() if ord(c) > 127}))
ranges = "0x20-0x024F,0x0370-0x03FF,0x2000-0x209F,0x2190-0x22FF,0x3000-0x303F,0x3400-0x4DBF,0x4E00-0x9FFF,0xFF00-0xFFEF"
faces = [("ac_font_ui_16",16,"Regular",True), ("ac_font_mono_13",13,"Regular",False),
         ("ac_font_mono_20",20,"Bold",False), ("ac_font_display_22",22,"Bold",False),
         ("ac_font_comic_13",13,"Bold",False), ("ac_font_comic_16",16,"Bold",True)]
for name,size,weight,full in faces:
    source = ROOT / ".cache/fonts" / ("SarasaTermSC-" + weight + ".ttf")
    output = ROOT / "generated/fonts" / (name + ".c")
    marker = output.with_suffix(".json")
    key = {"sha256":spec["files"][source.name],"symbols":symbols,"ranges":ranges if full else "0x20-0x024F", "size":size,"bpp":4,"converter":"1.5.3","line_height":20 if full else size+3,"base_line":4}
    if output.exists() and marker.exists() and json.loads(marker.read_text()) == key:
        continue
    output.parent.mkdir(parents=True,exist_ok=True)
    subprocess.run([str(ROOT / ".tools/bin/bun"),str(ROOT / "node_modules/lv_font_conv/lv_font_conv.js"),
        "--font",str(source),"--size",str(size),"--bpp","4","--format","lvgl",
        "--range",key["ranges"],"--symbols",symbols,"--no-compress","--no-kerning","--output",str(output)],check=True,cwd=ROOT)
    data = output.read_text()
    data,n = re.subn(r"\.line_height = \d+,", ".line_height = %d," % key["line_height"],data)
    data,m = re.subn(r"\.base_line = \d+,", ".base_line = 4,",data)
    if n != 1 or m != 1: raise ValueError("unexpected LVGL font metadata")
    output.write_text(data)
    marker.write_text(json.dumps(key,ensure_ascii=False,indent=2)+"\n")
print("Sarasa Term SC fonts ready: CJK 16 / terminal 13 / bold 20 / display 22")

sans_spec=json.loads((ROOT/"dev-toolchain.lock.json").read_text())["ui_font"]
source=ROOT/".cache/downloads"/sans_spec["archive"]
if hashlib.sha256(source.read_bytes()).hexdigest()!=sans_spec["sha256"]:
    raise ValueError("Source Han Sans checksum mismatch; run setup before building")
for size in (13,16,20,22):
    output=ROOT/"generated/fonts"/f"ac_font_sans_{size}.c";marker=output.with_suffix(".json")
    key={"sha256":sans_spec["sha256"],"symbols":symbols,"ranges":ranges if size==16 else "0x20-0x024F","size":size,"converter":"1.5.3"}
    if output.exists() and marker.exists() and json.loads(marker.read_text())==key:continue
    subprocess.run([str(ROOT/".tools/bin/bun"),str(ROOT/"node_modules/lv_font_conv/lv_font_conv.js"),"--font",str(source),"--size",str(size),"--bpp","4","--format","lvgl","--range",key["ranges"],"--symbols",symbols,"--no-compress","--output",str(output)],check=True,cwd=ROOT)
    data=output.read_text();data=re.sub(r"\.line_height = \d+,",f".line_height = {20 if size==16 else size+3},",data);data=re.sub(r"\.base_line = \d+,",".base_line = 4,",data)
    output.write_text(data);marker.write_text(json.dumps(key,ensure_ascii=False,indent=2)+"\n")
print("Source Han Sans themes ready: 13 / CJK 16 / 20 / 22")
