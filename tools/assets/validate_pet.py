#!/usr/bin/env python3
"""Check Pet Pack v1 manifests; optionally inspect source PNG files.

This does not convert assets, render LVGL, or establish hardware acceptance.
"""

import argparse
import json
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = ROOT / "assets/pets/pet-pack.schema.json"
MAX_MANIFEST_BYTES = 64 * 1024
MAX_PNG_BYTES = 128 * 1024
MAX_UNIQUE_FRAMES = 64
FRAME_PIXEL_BYTES = 112 * 112 * 3
MAX_PACK_BYTES = 5 * 1024 * 1024 // 2


def validate_manifest(manifest):
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    Draft202012Validator(schema).validate(manifest)
    paths = {manifest["poster"]}
    for clip in manifest["clips"].values():
        paths.update(clip["frames"])
    if len(paths) > MAX_UNIQUE_FRAMES:
        raise ValueError("a pet pack may reference at most 64 unique PNG paths")
    pixel_bytes = len(paths) * FRAME_PIXEL_BYTES
    if pixel_bytes > MAX_PACK_BYTES:
        raise ValueError("estimated pixel payload exceeds 2.5 MiB")
    return paths, pixel_bytes


def validate_files(root, paths):
    from PIL import Image

    root = root.resolve()
    for relative in sorted(paths):
        path = (root / relative).resolve()
        if root not in path.parents:
            raise ValueError(f"asset path escapes pack directory: {relative}")
        if path.stat().st_size > MAX_PNG_BYTES:
            raise ValueError(f"PNG exceeds 128 KiB: {relative}")
        with path.open("rb") as source:
            header = source.read(26)
        if (header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR"
                or header[24:26] != bytes((8, 6))):
            raise ValueError(f"expected 8-bit/channel RGBA PNG: {relative}")
        with Image.open(path) as img:
            if img.format != "PNG" or img.mode != "RGBA":
                raise ValueError(f"expected an RGBA PNG: {relative}")
            if img.size != (128, 128) or getattr(img, "n_frames", 1) != 1:
                raise ValueError(f"expected one 128x128 frame: {relative}")
            img.load()
            bbox = img.getchannel("A").getbbox()
            if bbox is None:
                raise ValueError(f"frame is entirely transparent: {relative}")
            left, top, right, bottom = bbox
            if left < 8 or top < 8 or right > 120 or bottom > 120:
                raise ValueError(f"art must retain an 8px transparent margin: {relative}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--check-files", action="store_true")
    args = parser.parse_args()
    if args.manifest.stat().st_size > MAX_MANIFEST_BYTES:
        parser.error("manifest exceeds 64 KiB")
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    paths, pixel_bytes = validate_manifest(manifest)
    if args.check_files:
        validate_files(args.manifest.parent, paths)
    print(json.dumps({
        "asset_id": manifest["asset_id"],
        "manifest": "PASS",
        "unique_png_paths": len(paths),
        "estimated_pixel_payload_bytes": pixel_bytes,
        "source_files": "PASS" if args.check_files else "NOT_CHECKED",
        "compiled_size_and_playback": "NOT_VERIFIED",
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
