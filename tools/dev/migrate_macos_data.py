#!/usr/bin/env python3
"""Copy only this project's known runtime data to the Mac app; never overwrite app data."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import sqlite3

ROOT=Path(__file__).resolve().parents[2]
source=ROOT/".runtime"
target=Path.home()/"Library/Application Support/AgentCompanion"
target.mkdir(parents=True,exist_ok=True);target.chmod(0o700)
copied=[];retained=[]
for relative in ["settings.json","secrets/deepseek-api-key"]:
    src=source/relative;dst=target/relative
    if not src.is_file():continue
    if dst.exists():retained.append(relative);continue
    dst.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    temporary=dst.with_name(dst.name+".migration")
    shutil.copyfile(src,temporary);temporary.chmod(0o600)
    assert hashlib.sha256(src.read_bytes()).digest()==hashlib.sha256(temporary.read_bytes()).digest()
    os.replace(temporary,dst);copied.append(relative)
src=source/"token_usage.sqlite";dst=target/"token_usage.sqlite"
if src.is_file() and not dst.exists():
    with sqlite3.connect(src.as_uri()+"?mode=ro",uri=True) as a,sqlite3.connect(dst) as b:
        a.backup(b);assert b.execute("PRAGMA integrity_check").fetchone()[0]=="ok"
    dst.chmod(0o600);copied.append("token_usage.sqlite")
elif dst.exists():retained.append("token_usage.sqlite")
print(json.dumps({"data_directory":str(target),"copied_known_files":copied,"kept_existing_app_files":retained,"originals_preserved":True,"secrets_in_app_bundle":False},ensure_ascii=False,indent=2))
