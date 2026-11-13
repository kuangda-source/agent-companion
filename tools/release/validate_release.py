#!/usr/bin/env python3
"""Validate public release hashes and the source tag before uploading any asset."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import zipfile


def validate(directory, tag, source_commit):
    directory = Path(directory)
    manifest_path = directory / 'release-manifest.json'
    manifest = json.loads(manifest_path.read_text())
    if not re.fullmatch(r'[a-f0-9]{40}', source_commit) or source_commit == '0' * 40:
        raise ValueError('A real source commit is required')
    if manifest['source_commit'] != source_commit or tag != 'v' + manifest['mac_version']:
        raise ValueError('Source/version mismatch')
    if manifest['credentials_included'] is not False or manifest['nvs_included'] is not False:
        raise ValueError('Private data must not be published')
    expected = {'AgentCompanion-' + manifest['mac_version'] + '-macos-arm64.zip',
                'AgentCompanion-board-' + manifest['board_version'] + '-esp32p4-rev3x.zip'}
    if set(manifest['artifacts']) != expected:
        raise ValueError('Unexpected release assets')
    entries = {p.name for p in directory.iterdir() if not (p.name == 'package-staging' and p.is_dir() and not p.is_symlink())}
    if entries != expected | {'release-manifest.json', 'SHA256SUMS.txt'}:
        raise ValueError('Unexpected file in release directory')
    checksums = {}
    for line in (directory / 'SHA256SUMS.txt').read_text().splitlines():
        digest, name = line.split('  ', 1)
        if not re.fullmatch(r'[a-f0-9]{64}', digest) or name in checksums:
            raise ValueError('Invalid checksum manifest')
        checksums[name] = digest
    if set(checksums) != expected | {'release-manifest.json'}:
        raise ValueError('Checksum coverage mismatch')
    for name, checksum in checksums.items():
        path = directory / name
        if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != checksum:
            raise ValueError('Checksum mismatch: ' + name)
        if name not in expected:
            continue
        meta = manifest['artifacts'][name]
        if path.stat().st_size != meta['bytes'] or checksum != meta['sha256']:
            raise ValueError('Artifact metadata mismatch: ' + name)
        with zipfile.ZipFile(path) as z:
            for item in z.infolist():
                parts = Path(item.filename).parts
                if item.filename.startswith('/') or '..' in parts or any(p in {'.runtime', '.private', 'secrets', 'lan'} for p in parts):
                    raise ValueError('Private/unsafe archive member')
                if re.search(r'(?:^|/)(?:nvs|phy|factory-backup)[^/]*\.bin$', item.filename, re.I):
                    raise ValueError('Device configuration backup in archive')
            if z.testzip():
                raise ValueError('Corrupt archive')
    print('Verified source identity and SHA256 for all public release assets')
    return manifest


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('directory', type=Path)
    p.add_argument('--tag', required=True)
    p.add_argument('--source-commit', required=True)
    args = p.parse_args()
    validate(args.directory, args.tag, args.source_commit)
