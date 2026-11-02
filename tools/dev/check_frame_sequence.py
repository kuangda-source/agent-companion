#!/usr/bin/env python3
"""Match captured native frames to the actual compiled RGB565A8 animation data."""
import argparse
import json
from pathlib import Path
import re
from PIL import Image, ImageChops, ImageDraw, ImageStat

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("captures", type=Path)
parser.add_argument("--agent", choices=["codex", "claude", "deepseek"], required=True)
parser.add_argument("--state", default="running")
parser.add_argument("--still", action="store_true")
parser.add_argument("--report", type=Path, required=True)
args = parser.parse_args()
registry = (ROOT / "generated/pets/ac_pet_registry.c").read_text()
match = re.search(r"ac_pack_" + args.agent + "_" + args.state + r"\[\] = \{([\d,]+)\}", registry)
if not match:
    raise RuntimeError("Clip is absent from the generated registry")
ids = [int(value) for value in match[1].split(",")]
references = []
mask = Image.new("L", (112, 112), 255)
for index in ids:
    source = (ROOT / f"generated/pets/ac_img_{args.agent}_{index}.c").read_text()
    values = re.search(r"_map\[\] = \{(.*?)\};", source, re.S)[1]
    data = bytes(int(value, 16) for value in re.findall(r"0x([0-9a-fA-F]{2})", values))
    if len(data) != 112 * 112 * 3:
        raise RuntimeError("Unexpected compiled image stride or size")
    references.append(Image.frombytes("RGB", (112, 112), data[:112 * 112 * 2], "raw", "BGR;16"))
    alpha = Image.frombytes("L", (112, 112), data[112 * 112 * 2:])
    mask = ImageChops.darker(mask, alpha)
mask = mask.point(lambda value: 255 if value == 255 else 0)
# Exclude foreground status marks and the platform rim, retaining the hand/body.
draw = ImageDraw.Draw(mask)
draw.rectangle((86, 0, 111, 25), fill=0)
draw.rectangle((90, 80, 111, 111), fill=0)
draw.rectangle((0, 102, 111, 111), fill=0)
agent_row = ["codex", "claude", "deepseek"].index(args.agent)
paths = [path for path in sorted(args.captures.glob("frame-*.bmp")) if int(path.stem.split("-")[-1]) >= 30]
if not paths:
    raise RuntimeError("No captures after initial connection")
origin = None
rows = []
for path in paths:
    with Image.open(path) as capture:
        positions = [origin] if origin else [(x, y) for x in range(20, 25) for y in range(75 + agent_row * 150, 81 + agent_row * 150)]
        scores = []
        for x, y in positions:
            crop = capture.crop((x, y, x + 112, y + 112)).convert("RGB")
            for frame, reference in enumerate(references):
                error = sum(ImageStat.Stat(ImageChops.difference(crop, reference), mask=mask).mean) / 3
                scores.append((error, frame, (x, y)))
        error, frame, origin = min(scores)
        if error > 1:
            raise RuntimeError(f"Captured sprite does not match compiled data: {path}, error={error}")
        rows.append({"capture_frame": int(path.stem.split("-")[-1]), "clip_frame": frame, "error": round(error, 5)})
seen = sorted({row["clip_frame"] for row in rows})
expected = [0] if args.still else list(range(len(ids)))
if seen != expected:
    raise RuntimeError(f"Unexpected frame sequence: observed {seen}, expected {expected}")
report = {"agent": args.agent, "state": args.state, "mode": "reduced_motion" if args.still else "animation", "method": "opaque-pixel match to compiled RGB565A8 arrays", "origin": origin, "observed_clip_frames": seen, "max_pixel_error": max(row["error"] for row in rows), "samples": rows}
args.report.write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({key: value for key, value in report.items() if key != "samples"}))
