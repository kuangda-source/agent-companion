"""Install the pinned terminal and sans fonts without changing system fonts."""
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]

def prepare():
    lock = json.loads((ROOT / "dev-toolchain.lock.json").read_text())
    valid = lambda p, digest: p.exists() and hashlib.sha256(p.read_bytes()).hexdigest() == digest
    sans=lock["ui_font"];source=ROOT/".cache/downloads"/sans["archive"]
    source.parent.mkdir(parents=True,exist_ok=True)
    if not valid(source,sans["sha256"]):
        partial=source.with_suffix(".partial")
        subprocess.run(["curl","-fL","--retry","2","--connect-timeout","15","--max-time","120",sans["url"],"-o",str(partial)],check=True)
        if not valid(partial,sans["sha256"]):raise ValueError("sans font source checksum mismatch")
        partial.replace(source)
    spec = lock["ui_font_mono"]
    destination = ROOT / ".cache/fonts"
    destination.mkdir(parents=True, exist_ok=True)
    if all(valid(destination / name, digest) for name, digest in spec["files"].items()):
        return
    archive = ROOT / ".cache/downloads" / spec["archive"]
    archive.parent.mkdir(parents=True, exist_ok=True)
    if not valid(archive, spec["sha256"]):
        partial = archive.with_suffix(".partial")
        subprocess.run(["curl", "-fL", "--retry", "2", "--connect-timeout", "15", "--max-time", "120", spec["url"], "-o", str(partial)], check=True)
        if not valid(partial, spec["sha256"]):
            raise ValueError("terminal font archive checksum mismatch")
        partial.replace(archive)
    for name, digest in spec["files"].items():
        target = destination / name
        with target.open("wb") as out:
            subprocess.run(["bsdtar", "-xOf", str(archive), name], stdout=out, check=True)
        if not valid(target, digest):
            raise ValueError("terminal font source checksum mismatch: " + name)

if __name__ == "__main__":
    prepare()
