#!/usr/bin/env python3
"""Import a user-supplied pet archive without overwriting project code/docs."""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import stat
import zipfile

from validate_pet import validate_files, validate_manifest

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("archive", type=Path)
args = parser.parse_args()
digest = hashlib.sha256(args.archive.read_bytes()).hexdigest()
destination = ROOT / "imports" / ("clea-pet-pack-" + digest[:12])
with zipfile.ZipFile(args.archive) as archive:
    members = archive.infolist()
    if sum(item.file_size for item in members) > 64 * 1024 * 1024:
        raise ValueError("pet import exceeds 64 MiB")
    names = {item.filename for item in members if not item.is_dir()}
    prefix = "agent_pet_pack/"
    for item in members:
        path = PurePosixPath(item.filename)
        if (path.is_absolute() or ".." in path.parts or "\\" in item.filename
                or not item.filename.startswith(prefix) or stat.S_ISLNK(item.external_attr >> 16)):
            raise ValueError("unsupported archive entry: " + item.filename)
    checksums = archive.read(prefix + "checksums.sha256").decode("utf-8").splitlines()
    checked = 0
    for line in checksums:
        expected, relative = line.split("  ", 1)
        name = prefix + relative
        if name not in names or hashlib.sha256(archive.read(name)).hexdigest() != expected:
            raise ValueError("checksum mismatch: " + relative)
        checked += 1
    if checked != len(names) - 1:
        raise ValueError("checksums must cover every file except checksums.sha256")
    destination.mkdir(parents=True, exist_ok=True)
    for item in members:
        if item.is_dir():
            continue
        target = destination / item.filename[len(prefix):]
        content = archive.read(item)
        if target.exists() and target.read_bytes() != content:
            raise ValueError("existing import changed: " + str(target))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)

packs = []
for manifest in sorted((destination / "assets/pets").glob("*/pet.json")):
    data = json.loads(manifest.read_text())
    paths, _ = validate_manifest(data)
    validate_files(manifest.parent, paths)
    target = ROOT / "assets/pets" / data["asset_id"]
    for source in manifest.parent.rglob("*"):
        if not source.is_file():
            continue
        output = target / source.relative_to(manifest.parent)
        if output.exists() and output.read_bytes() != source.read_bytes():
            raise ValueError("existing asset differs; retain and review: " + str(output))
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, output)
    packs.append(data["asset_id"])
report = {"archive": args.archive.name, "archive_sha256": digest,
          "checksums_verified": checked, "import_root": str(destination.relative_to(ROOT)),
          "packs": packs, "source_unchanged": True, "project_contract": "PASS"}
(ROOT / "reports/assets-import.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
