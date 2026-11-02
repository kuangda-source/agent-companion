#!/usr/bin/env python3
"""Install the pinned Mac simulator toolchain inside this project."""

import hashlib
import json
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from setup_fonts import prepare as prepare_fonts

ROOT = Path(__file__).resolve().parents[2]
LOCK = json.loads((ROOT / "dev-toolchain.lock.json").read_text())


def run(*args):
    print("+", " ".join(map(str, args)), flush=True)
    subprocess.run(list(map(str, args)), cwd=ROOT, check=True)


def download(item):
    target = ROOT / ".cache/downloads" / item["archive"]
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        partial = target.with_suffix(target.suffix + ".partial")
        req = urllib.request.Request(item["url"], headers={"User-Agent": "AgentCompanion-Dev-Setup"})
        print("Downloading", item["archive"], flush=True)
        with urllib.request.urlopen(req, timeout=60) as src, partial.open("wb") as dst:
            shutil.copyfileobj(src, dst)
        partial.replace(target)
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    if digest != item["sha256"]:
        raise ValueError("checksum mismatch: " + str(target))
    return target


def extract_source(archive, name, digest):
    destination = ROOT / ".deps" / name
    marker = destination / ".source-sha256"
    if destination.exists():
        if marker.exists() and marker.read_text().strip() == digest:
            return destination
        raise ValueError("existing source directory has no matching lock: " + str(destination))
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=destination.parent) as tmp:
        temp = Path(tmp).resolve()
        with tarfile.open(archive) as source:
            for member in source.getmembers():
                resolved = (temp / member.name).resolve()
                if temp not in resolved.parents or member.isdev():
                    raise ValueError("unsupported archive entry: " + member.name)
                if member.issym() or member.islnk():
                    base = resolved.parent if member.issym() else temp
                    linked = (base / member.linkname).resolve()
                    if temp not in linked.parents:
                        raise ValueError("archive link escapes extraction directory: " + member.name)
            source.extractall(temp)
        children = list(temp.iterdir())
        if len(children) != 1 or not children[0].is_dir():
            raise ValueError("expected one source directory")
        children[0].rename(destination)
    marker.write_text(digest + "\n")
    return destination


def main():
    if (platform.system(), platform.machine()) != ("Darwin", "arm64"):
        sys.exit("This lock targets Apple Silicon macOS; add a platform lock before using elsewhere.")
    if not shutil.which("clang") or not shutil.which("make"):
        sys.exit("Apple Command Line Tools are required (clang and make).")
    env = ROOT / ".venv-dev"
    if not (env / "bin/python").exists():
        run(sys.executable, "-m", "venv", env)
    run(env / "bin/python", "-m", "pip", "install", "--disable-pip-version-check", "-q", "-r", ROOT / "tools/dev-requirements.lock.txt")

    bun_archive = download(LOCK["bun"])
    bun = ROOT / ".tools/bin/bun"
    bun.parent.mkdir(parents=True, exist_ok=True)
    if not bun.exists():
        with zipfile.ZipFile(bun_archive) as archive, archive.open("bun-darwin-aarch64/bun") as src, bun.open("wb") as dst:
            shutil.copyfileobj(src, dst)
        bun.chmod(0o755)
    if subprocess.check_output([str(bun), "--version"], text=True).strip() != LOCK["bun"]["version"]:
        sys.exit("project Bun version does not match the lock")

    sdl = extract_source(download(LOCK["sdl2"]), "sdl2", LOCK["sdl2"]["sha256"])
    extract_source(download(LOCK["lvgl"]), "lvgl", LOCK["lvgl"]["sha256"])
    prepare_fonts()
    run(bun, "install", "--frozen-lockfile")
    cmake = env / "bin/cmake"
    prefix = ROOT / ".tools/sdl2"
    installed = prefix / "bin/sdl2-config"
    if not installed.exists():
        run(cmake, "-S", sdl, "-B", ROOT / ".build/sdl2", "-DCMAKE_BUILD_TYPE=Release",
            "-DCMAKE_OSX_ARCHITECTURES=arm64", "-DSDL_SHARED=OFF", "-DSDL_STATIC=ON",
            "-DSDL_TEST=OFF", "-DSDL_TESTS=OFF", "-DCMAKE_INSTALL_PREFIX=" + str(prefix))
        run(cmake, "--build", ROOT / ".build/sdl2", "--parallel", "4")
        run(cmake, "--install", ROOT / ".build/sdl2")
    if subprocess.check_output([str(installed), "--version"], text=True).strip() != LOCK["sdl2"]["version"]:
        sys.exit("project SDL2 version does not match the lock")
    print("Project-local toolchain ready. Run ./scripts/dev doctor, then ./scripts/dev build.", flush=True)


if __name__ == "__main__":
    main()
