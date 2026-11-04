#!/usr/bin/env python3
"""Compile validated PNG pet packs using the pinned official LVGL converter."""

import hashlib
import json
from pathlib import Path
import subprocess
import sys

from PIL import Image
from validate_pet import validate_manifest, validate_files
from pet_policy import compiled_loop, catalog_budget

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "generated/pets"
OUTPUT.mkdir(parents=True, exist_ok=True)
BINDINGS = json.loads((ROOT / "examples/config.example.json").read_text())["ui"]["pet_assets"]
STATES = ["idle", "running", "waiting", "error", "offline", "unknown", "celebrate"]
MOTION = {name: "AC_PET_MOTION_" + name.upper() for name in ["none", "breathe", "bob", "shake"]}
EFFECT = {name: "AC_PET_EFFECT_" + name.upper() for name in ["none", "activity_dots", "attention", "error_mark", "sparkle"]}
converter = ROOT / ".deps/lvgl/scripts/LVGLImage.py"
lines = ['#include "ac_pet_registry.h"', '#include <stddef.h>']
registry = []
reports = []
total_pixels = 0

for agent in ["codex", "claude", "deepseek", "grok"]:
    asset_id = BINDINGS.get(agent, "grok-placeholder")
    source = ROOT / "assets/pets" / asset_id
    manifest = source / "pet.json"
    if not manifest.exists():
        registry.append("NULL")
        reports.append({"agent": agent, "asset_id": asset_id, "status": "PLACEHOLDER"})
        continue
    data = json.loads(manifest.read_text())
    paths, _ = validate_manifest(data)
    validate_files(source, paths)
    hashes = {}
    frame_ids = {}
    names = []
    for relative in sorted(paths):
        raw = (source / relative).read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        if digest not in hashes:
            index = len(names)
            name = "ac_img_" + agent + "_" + str(index)
            png = OUTPUT / (name + ".png")
            c_file = OUTPUT / (name + ".c")
            marker = OUTPUT / (name + ".sha256")
            key = digest + ":112:RGB565A8:9.5.0:Pillow11.3.0:LANCZOS-RGBa"
            if not c_file.exists() or not marker.exists() or marker.read_text() != key:
                with Image.open(source / relative) as image:
                    resized = image.convert("RGBa").resize((112, 112), Image.Resampling.LANCZOS).convert("RGBA")
                    resized.save(png)
                subprocess.run([sys.executable, str(converter), "--ofmt", "C", "--cf", "RGB565A8",
                                "--compress", "NONE", "--name", name, "-o", str(OUTPUT), str(png)], check=True)
                marker.write_text(key)
            hashes[digest] = index
            names.append(name)
            lines.append("LV_IMAGE_DECLARE(" + name + ");")
        frame_ids[relative] = hashes[digest]
    prefix = "ac_pack_" + agent
    lines.append("static const lv_image_dsc_t *const " + prefix + "_images[] = {" + ",".join("&" + name for name in names) + "};")
    for state in STATES:
        clip = data["clips"].get(state)
        if clip:
            ids = ",".join(str(frame_ids[path]) for path in clip["frames"])
            lines.append("static const uint16_t " + prefix + "_" + state + "[] = {" + ids + "};")
    lines.extend([
        "static const ac_pet_pack_t " + prefix + " = {",
        ".asset_id=" + json.dumps(asset_id) + ", .asset_version=" + json.dumps(data["asset_version"]) + ",",
        ".unique_frame_count=" + str(len(names)) + ", .poster_frame_id=" + str(frame_ids[data["poster"]]) + ",",
        ".clips={",
    ])
    for state in STATES:
        clip = data["clips"].get(state)
        if clip:
            lines.append("[AC_PET_" + state.upper() + "]={.frame_ids=" + prefix + "_" + state +
                ",.frame_count=" + str(len(clip["frames"])) + ",.fps=" + str(clip["fps"]) +
                ",.loop=" + str(compiled_loop(agent,state,clip["loop"])).lower() + ",.motion=" + MOTION[clip.get("motion", "none")] +
                ",.effect=" + EFFECT[clip.get("effect", "none")] + "},")
    lines.append("}};")
    blink_ref = "NULL"
    details_path = source / "details.json"
    if details_path.exists():
        details = json.loads(details_path.read_text())
        if set(details) != {"schema_version", "blink"} or details["schema_version"] != 1:
            raise ValueError("unsupported local presentation metadata")
        blink = details["blink"]
        if set(blink) != {"source", "region", "expressions"} or blink["source"] not in frame_ids:
            raise ValueError("blink must reference an existing validated frame")
        region = blink["region"]
        if (not isinstance(region,list) or len(region) != 4 or any(type(v) is not int for v in region)
                or min(region) < 0 or min(region[2:]) == 0 or region[0]+region[2] > 112 or region[1]+region[3] > 112):
            raise ValueError("blink region must fit the 112px viewport")
        if not blink["expressions"] or not set(blink["expressions"]).issubset({"idle","running","waiting","unknown"}):
            raise ValueError("unsupported blink expression")
        mask = sum(1 << STATES.index(state) for state in set(blink["expressions"]))
        lines.append("static const ac_pet_blink_t " + prefix + "_blink={.frame_id=" + str(frame_ids[blink["source"]]) +
            ",.x=%d,.y=%d,.width=%d,.height=%d,.expression_mask=%d};" % (*region, mask))
        blink_ref = "&" + prefix + "_blink"
    lines.append("static const ac_pet_assets_t " + prefix + "_assets={.pack=&" + prefix + ",.frames=" + prefix + "_images,.blink=" + blink_ref + "};")
    registry.append("&" + prefix + "_assets")
    pixels = len(names) * 112 * 112 * 3
    if pixels > 2.5 * 1024 * 1024:
        raise ValueError("pet pixel budget exceeded")
    total_pixels += pixels
    reports.append({"agent": agent, "asset_id": asset_id, "source_asset_id":data["asset_id"], "status": "PASS",
                    "unique_frames": len(names), "pixel_payload_bytes": pixels,
                    "playback_overrides":{state:{"source_loop":clip["loop"],"compiled_loop":compiled_loop(agent,state,clip["loop"])} for state,clip in data["clips"].items() if clip["loop"]!=compiled_loop(agent,state,clip["loop"])}})

budget=catalog_budget([pack["pixel_payload_bytes"] for pack in reports if pack["status"]=="PASS"])
lines.append("const ac_pet_assets_t *ac_pet_assets_for_agent(ac_agent_id_t agent) {")
lines.append("static const ac_pet_assets_t *const packs[AC_AGENT_COUNT]={" + ",".join(registry) + "};")
lines.append("return agent >= 0 && agent < AC_AGENT_COUNT ? packs[agent] : NULL; }")
registry_source = OUTPUT / "ac_pet_registry.c"
content = "\n".join(lines) + "\n"
if not registry_source.exists() or registry_source.read_text() != content:
    registry_source.write_text(content)
(ROOT / "reports").mkdir(exist_ok=True)
(ROOT / "reports/pet-build.json").write_text(json.dumps({"packs": reports,
    "pixel_payload_bytes": total_pixels, "budget":budget, "format": "LVGL9.5.0 RGB565A8", "hardware": "NOT_VERIFIED"}, indent=2) + "\n")
print("Pet resources ready:", total_pixels, "pixel bytes")
