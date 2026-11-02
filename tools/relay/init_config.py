#!/usr/bin/env python3
"""Generate private relay role credentials locally; never print token values."""
import argparse,hashlib,json,os,secrets
from pathlib import Path
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output',type=Path,default=Path('.private/relay'))
a=parser.parse_args();a.output.mkdir(parents=True,exist_ok=True,mode=0o700)
if any((a.output/name).exists() for name in ['relay.json','client.json']):parser.error('Output already exists; refusing to rotate active credentials')
mac,device=secrets.token_hex(32),secrets.token_hex(32)
for name,value in [('relay.json',{'mac_sha256':hashlib.sha256(mac.encode()).hexdigest(),'device_sha256':hashlib.sha256(device.encode()).hexdigest()}),('client.json',{'url':'','mac_token':mac,'device_token':device})]:
 with os.fdopen(os.open(a.output/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as f:json.dump(value,f,indent=2)
print('Created private relay.json (server hashes) and client.json (Mac UI credentials) in',a.output)
