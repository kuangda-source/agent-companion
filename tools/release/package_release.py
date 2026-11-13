#!/usr/bin/env python3
"""Package public Mac/ESP32-P4 artifacts; never read or export a device flash dump.

Only named build products and licenses are copied. Release copies lose debug
symbols and diagnostic source paths; installed software and user settings stay put.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import struct
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[2]
PATTERNS = [rb'(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{24,}', rb'(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}',
            # TLS libraries contain the standalone PEM delimiters for parsing.
            # Reject actual key payloads, while allowing those NUL-terminated literals.
            rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=\r\n]{32,}']


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def audit(path, private_values=()):
    data = path.read_bytes()
    if any(re.search(p, data) for p in PATTERNS):
        raise RuntimeError('Credential-shaped content: ' + path.name)
    if str(Path.home()).encode() in data:
        raise RuntimeError('Personal build path: ' + path.name)
    for label, value in private_values:
        if len(value) >= 8 and value.encode() in data:
            raise RuntimeError('Private configuration match (' + label + '): ' + path.name)


def diagnostic_paths(path):
    """Erase only NUL-terminated C-family __FILE__ literals, without moving bytes.

    The file must be an arm64 Mach-O. Any remaining personal path fails audit;
    runtime paths, credentials and arbitrary binary strings are never patched.
    """
    data = bytearray(path.read_bytes())
    if data[:4] != b'\xcf\xfa\xed\xfe':
        raise RuntimeError('Expected 64-bit Mach-O: ' + path.name)
    commands = struct.unpack_from('<I', data, 16)[0]
    offset = 32
    changed = 0
    for _ in range(commands):
        command, size = struct.unpack_from('<II', data, offset)
        if command == 0x19:  # LC_SEGMENT_64
            nsects = struct.unpack_from('<I', data, offset + 64)[0]
            for i in range(nsects):
                section = offset + 72 + i * 80
                name = bytes(data[section:section + 16]).rstrip(b'\0')
                if name != b'__cstring':
                    continue
                length = struct.unpack_from('<Q', data, section + 40)[0]
                begin = struct.unpack_from('<I', data, section + 48)[0]
                at, end = begin, begin + length
                while at < end:
                    stop = data.find(b'\0', at, end)
                    if stop < 0:
                        break
                    value = bytes(data[at:stop])
                    if str(Path.home()).encode() in value:
                        text = value.decode('utf8')
                        if not text.startswith('/') or Path(text).suffix not in {'.c', '.h', '.m', '.mm', '.cpp', '.cc', '.hpp', '.S'}:
                            raise RuntimeError('Non-diagnostic personal path: ' + path.name)
                        replacement = ('source/' + Path(text).name).encode()
                        if len(replacement) > len(value):
                            raise RuntimeError('Invalid diagnostic path length')
                        data[at:stop] = replacement + b'\0' * (len(value) - len(replacement))
                        changed += 1
                    at = stop + 1
        offset += size
    if changed:
        path.write_bytes(data)
    return changed


def private_values(runtime):
    values = []
    secrets = runtime / 'secrets'
    if secrets.exists():
        for p in secrets.iterdir():
            if p.is_file():
                values.append(('saved model credential', p.read_text().strip()))
    p = runtime / 'gateway.token'
    if p.exists():
        values.append(('local access token', p.read_text().strip()))
    for file, fields in [('remote-link.json', ['mac_token', 'device_token']),
                         ('lan/pair.json', ['token']), ('wifi-pending.json', ['ssid', 'password'])]:
        p = runtime / file
        if p.exists():
            obj = json.loads(p.read_text())
            for key in fields:
                if isinstance(obj.get(key), str):
                    values.append(('saved ' + key, obj[key]))
    p = runtime / 'remote-link.json'
    if p.exists():
        from urllib.parse import urlparse
        host = urlparse(json.loads(p.read_text()).get('url', '')).hostname
        if host:
            values.append(('personal relay hostname', host))
    return values


def licenses(dest):
    dest.mkdir(parents=True, exist_ok=True)
    for name in ['LICENSE', 'THIRD_PARTY_NOTICES.md']:
        shutil.copyfile(ROOT / name, dest / name)
    for p in (ROOT / 'assets/pets').glob('*/license.md'):
        shutil.copyfile(p, dest / (p.parent.name + '-license.md'))
        if (p.parent / 'provenance').is_dir():
            package = dest / p.parent.name
            package.mkdir()
            shutil.copyfile(p, package / 'license.md')
            shutil.copytree(p.parent / 'provenance', package / 'provenance')


def archive(directory, target):
    with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for p in sorted(directory.rglob('*')):
            if p.is_symlink():
                raise RuntimeError('Archive symlink not allowed')
            if p.is_file():
                z.write(p, p.relative_to(directory))
    with zipfile.ZipFile(target) as z:
        if z.testzip():
            raise RuntimeError('Archive verification failed')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', required=True, type=Path)
    parser.add_argument('--firmware', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--mac-version', default='0.4.19')
    parser.add_argument('--board-version', default='0.2.26')
    parser.add_argument('--source-commit', required=True)
    args = parser.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    stage = out / 'package-staging'
    if stage.exists():
        raise RuntimeError('Use an empty package staging directory')
    mac, board = stage / 'macos', stage / 'firmware'
    mac.mkdir(parents=True)
    board.mkdir(parents=True)
    app = mac / 'AgentCompanion.app'
    shutil.copytree(args.app, app, symlinks=True, copy_function=shutil.copy)
    forbidden = {'.runtime', '.private', 'secrets', 'lan', '__pycache__'}
    files = list(app.rglob('*'))
    for p in files:
        if p.is_symlink() or forbidden.intersection(p.relative_to(app).parts) or p.suffix in {'.sqlite', '.db', '.pem', '.key', '.log'} or p.name.endswith('.installing'):
            raise RuntimeError('Unexpected bundle artifact: ' + p.name)
    with (app / 'Contents/Info.plist').open('rb') as f:
        info = plistlib.load(f)
    if info.get('CFBundleShortVersionString') != args.mac_version or 'ACRuntimeDirectory' in info:
        raise RuntimeError('Unexpected bundle version/runtime override')
    stripped = 0
    for p in [app / 'Contents/MacOS/AgentCompanion', *sorted((app / 'Contents/Resources/bin').iterdir())]:
        if not p.is_file():
            continue
        # Bundled Bun has its own executable data; only strip the C preview/helper.
        if p.name in {'agent-companion-preview', 'agent-companion-usb'}:
            subprocess.run(['/usr/bin/strip', '-S', str(p)], check=True, capture_output=True)
            stripped += diagnostic_paths(p)
        subprocess.run(['codesign', '--force', '--sign', '-', str(p)], check=True, capture_output=True)
    subprocess.run(['codesign', '--force', '--deep', '--sign', '-', str(app)], check=True, capture_output=True)
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True, capture_output=True)
    runtime = Path.home() / 'Library/Application Support/AgentCompanion'
    values = private_values(runtime)
    for p in app.rglob('*'):
        if p.is_file():
            audit(p, values)
    shutil.copyfile(ROOT / 'docs/MAC_INSTALL.md', mac / 'README.zh-CN.md')
    licenses(mac / 'Licenses')
    fw = args.firmware.resolve()
    named = [('agent_companion_device.bin', 'agent_companion_device.bin'),
             ('bootloader/bootloader.bin', 'bootloader.bin'),
             ('partition_table/partition-table.bin', 'partition-table.bin')]
    firmware_files = {}
    for source, name in named:
        dest = board / name
        shutil.copyfile(fw / source, dest)
        audit(dest, values)
        firmware_files[name] = {'bytes': dest.stat().st_size, 'sha256': digest(dest)}
    # The published partition table must match the documented application offset.
    table = (board / 'partition-table.bin').read_bytes()
    entries = [struct.unpack_from('<HBBII16sI', table, i) for i in range(0, len(table) - 31, 32) if table[i:i + 2] == b'\xaaP']
    if not any(e[1] == 0 and e[3] == 0x20000 and e[4] == 0x1800000 for e in entries):
        raise RuntimeError('Unexpected application partition layout')
    shutil.copyfile(ROOT / 'docs/FIRMWARE_INSTALL.md', board / 'README.zh-CN.md')
    licenses(board / 'Licenses')
    mac_zip = out / ('AgentCompanion-' + args.mac_version + '-macos-arm64.zip')
    fw_zip = out / ('AgentCompanion-board-' + args.board_version + '-esp32p4-rev3x.zip')
    archive(mac, mac_zip)
    archive(board, fw_zip)
    manifest = {'schema_version': 1, 'source_commit': args.source_commit,
                'mac_version': args.mac_version, 'board_version': args.board_version,
                'board_target': 'Waveshare ESP32-P4-WIFI6-Touch-LCD-7B, rev3.x, 32MB flash',
                'mac_target': 'Apple Silicon, macOS 13+', 'mac_notarized': False,
                'credentials_included': False, 'nvs_included': False,
                'firmware_files': firmware_files, 'diagnostic_paths_removed': stripped,
                'artifacts': {p.name: {'bytes': p.stat().st_size, 'sha256': digest(p)} for p in [mac_zip, fw_zip]}}
    meta = out / 'release-manifest.json'
    meta.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n')
    (out / 'SHA256SUMS.txt').write_text(''.join(digest(p) + '  ' + p.name + '\n' for p in [mac_zip, fw_zip, meta]))
    print(json.dumps({'artifacts': manifest['artifacts'], 'credentials_included': False, 'diagnostic_paths_removed': stripped}))


if __name__ == '__main__':
    main()
