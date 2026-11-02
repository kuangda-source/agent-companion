#!/usr/bin/env python3
"""Fail on credential-shaped text or private runtime artifacts; never echo values."""
import re,subprocess,sys
from pathlib import Path
root=Path(sys.argv[1] if len(sys.argv)>1 else '.').resolve()
tracked=subprocess.run(['git','ls-files','-z'],cwd=root,capture_output=True)
paths=[root/p.decode() for p in tracked.stdout.split(b'\0') if p] if tracked.returncode==0 else [p for p in root.rglob('*') if p.is_file()]
failures=[]
for p in paths:
 rel=p.relative_to(root)
 if p.is_symlink():failures.append((str(rel),'symlink is not public source'));continue
 if any(x in rel.parts for x in ['.git','node_modules','.tools','.cache','.build','generated']):
  if tracked.returncode==0:failures.append((str(rel),'tracked build/runtime directory'))
  continue
 if any(x in rel.parts for x in ['.runtime','.private','secrets','lan']) or p.suffix in ['.pem','.key','.sqlite','.db','.bin']:
  failures.append((str(rel),'private artifact'));continue
 try:text=p.read_text()
 except (UnicodeDecodeError,OSError):continue
 patterns=[r'sk-[A-Za-z0-9_-]{24,}',r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',r'(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}',r'/[U]sers/[^/\s]+/',r'\b(?:mac_token|device_token)\s*["\']?\s*:\s*["\'][a-f0-9]{64}["\']']
 if any(re.search(pattern,text) for pattern in patterns):failures.append((str(rel),'credential or local path pattern'))
if failures:
 for file,kind in failures:print(file+': '+kind)
 sys.exit(1)
print('Public source scan passed:',len(paths),'files; no matched credentials/private runtime artifacts')
