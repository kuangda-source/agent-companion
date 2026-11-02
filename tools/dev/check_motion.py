#!/usr/bin/env python3
"""Match actual SDL screenshots to the compiled PNG poses and measure their offsets."""
import argparse
from collections import defaultdict
import json
from pathlib import Path
import re
from PIL import Image, ImageChops, ImageStat

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument("captures", type=Path)
parser.add_argument("--agent", choices=["codex", "claude", "deepseek"], default="codex")
parser.add_argument("--report", type=Path, default=ROOT / "reports/motion-render-proof.json")
args = parser.parse_args()
registry = (ROOT / "generated/pets/ac_pet_registry.c").read_text()
references = []
for state, index in re.findall(r"static const uint16_t ac_pack_" + args.agent + r"_(\w+)\[\] = \{(\d+)\}", registry):
    image = Image.open(ROOT / ("generated/pets/ac_img_" + args.agent + "_" + index + ".png")).convert("RGBA")
    references.append((state, image.convert("RGB"), image.getchannel("A").point(lambda a: 255 if a > 253 else 0)))
results = []
for path in sorted(args.captures.glob("frame-*.bmp")):
    with Image.open(path) as frame:
        scores = []
        for state, image, mask in references:
            best = (999, None)
            for x in range(21, 26):
                for y in range(75 + ["codex", "claude", "deepseek"].index(args.agent)*150, 82 + ["codex", "claude", "deepseek"].index(args.agent)*150):
                    difference = ImageChops.difference(frame.crop((x, y, x + 112, y + 112)).convert("RGB"), image)
                    score = sum(ImageStat.Stat(difference, mask=mask).mean) / 3
                    if score < best[0]:
                        best = (score, (x, y))
            scores.append((best[0], state, best[1]))
        scores.sort()
        if scores[0][0] > 4:
            raise RuntimeError("Rendered pose did not match a compiled sprite: " + str(path))
        results.append({"frame": int(path.stem.split("-")[-1]), "expression": scores[0][1], "error": round(scores[0][0], 2),
                        "origin": scores[0][2], "next_pose_margin": round(scores[1][0] - scores[0][0], 2)})
if not results:
    raise RuntimeError("No SDL captures found")
report = {"agent": args.agent, "method": "Opaque sprite pixel comparison, RGB565 quantization tolerance, 5x7 translation search", "frames": results}
args.report.write_text(json.dumps(report, indent=2) + "\n")
groups = defaultdict(list)
for row in results:
    groups[row["expression"]].append(row)
print(json.dumps({key: {"frames": len(rows), "origins": sorted(set(tuple(r["origin"]) for r in rows)),
                        "max_pixel_error": max(r["error"] for r in rows)} for key, rows in groups.items()}, indent=2))
