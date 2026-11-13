#!/usr/bin/env python3
"""Stage audited artifacts on a temporary delivery branch for GitHub Releases.

The current checkout is untouched. Only four validated public artifacts are
added to an isolated index. Push is explicit; no PAT or local file permission
is needed. Delete the delivery branch after the Release has been verified.
"""
import argparse
import os
from pathlib import Path
import re
import subprocess
import tempfile
from validate_release import validate

ROOT = Path(__file__).resolve().parents[2]


def git(*args, env=None, input=None):
    return subprocess.run(['git', *args], cwd=ROOT, env=env, input=input, text=True, check=True, capture_output=True).stdout.strip()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('directory', type=Path)
    p.add_argument('--tag', required=True)
    p.add_argument('--push', action='store_true')
    args = p.parse_args()
    if not re.fullmatch(r'v\d+\.\d+\.\d+', args.tag):
        raise ValueError('Invalid release tag')
    source = git('rev-parse', 'HEAD')
    if git('status', '--porcelain'):
        raise ValueError('Commit all source changes before staging a release')
    if git('rev-parse', args.tag + '^{commit}') != source:
        raise ValueError('Tag must point to the current audited source commit')
    manifest = validate(args.directory, args.tag, source)
    branch = 'refs/heads/release-assets/' + args.tag
    cache = ROOT / '.cache'
    cache.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='release-index-', dir=cache) as d:
        env = {**os.environ, 'GIT_INDEX_FILE': str(Path(d) / 'index')}
        git('read-tree', source, env=env)
        for name in sorted(set(manifest['artifacts']) | {'release-manifest.json', 'SHA256SUMS.txt'}):
            path = args.directory / name
            blob = git('hash-object', '-w', '--', str(path.resolve()))
            git('update-index', '--add', '--cacheinfo', '100644', blob, 'release-assets/' + path.name, env=env)
        tree = git('write-tree', env=env)
        commit = git('commit-tree', tree, '-p', source, input='release: publish audited artifacts for ' + args.tag + '\n')
        git('update-ref', branch, commit, '')
    if args.push:
        git('push', 'origin', branch + ':' + branch)
    print('Delivery branch: ' + branch + '\nSource commit: ' + source)


if __name__ == '__main__':
    main()
