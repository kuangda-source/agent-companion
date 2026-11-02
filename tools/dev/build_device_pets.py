#!/usr/bin/env python3
"""Lossless LVGL RGB565A8 RLE packing, with byte-exact decode verification."""
from pathlib import Path
import hashlib,json,re,struct,shutil
ROOT=Path(__file__).resolve().parents[2]
out=ROOT/'.build/device-pets';out.mkdir(parents=True,exist_ok=True)
def compress(raw):
    blocks=[raw[i:i+2] for i in range(0,len(raw),2)];result=bytearray();i=0
    def count(at):
        j=at+1
        while j<len(blocks) and j-at<127 and blocks[j]==blocks[at]:j+=1
        return j-at
    while i<len(blocks):
        n=count(i)
        if n>=3:result.append(n);result.extend(blocks[i]);i+=n
        else:
            start=i;i+=n
            while i<len(blocks) and i-start<127:
                n=count(i)
                if n>=3:break
                i+=min(n,127-(i-start))
            result.append(0x80|(i-start));result.extend(b''.join(blocks[start:i]))
    return bytes(result)
def decode(data):
    result=bytearray();i=0
    while i<len(data):
        control=data[i];i+=1;n=control&127
        if control&128:result.extend(data[i:i+n*2]);i+=n*2
        else:result.extend(data[i:i+2]*n);i+=2
    return bytes(result)
results=[]
for p in sorted((ROOT/'generated/pets').glob('*.c')):
    if p.name=='ac_pet_registry.c':shutil.copy2(p,out/p.name);continue
    text=p.read_text();match=re.search(r'(uint8_t \w+_map\[\] = \{)(.*?)(\n\};)',text,re.S)
    if not match or '.cf = LV_COLOR_FORMAT_RGB565A8' not in text:raise ValueError('Unexpected pet image format')
    raw=bytes(int(v,16) for v in re.findall(r'0x([0-9a-fA-F]+)',match.group(2)));packed=compress(raw)
    if decode(packed)!=raw:raise ValueError('Lossless image check failed')
    blob=struct.pack('<III',1,len(packed),len(raw))+packed
    data='\n'+''.join('  '+','.join('0x%02x'%b for b in blob[i:i+32])+',\n' for i in range(0,len(blob),32))
    content=text[:match.start(2)]+data+text[match.end(2):];content=content.replace('.flags = 0,','.flags = LV_IMAGE_FLAGS_COMPRESSED,');target=out/p.name
    if not target.is_file() or target.read_text()!=content:target.write_text(content)
    # Keep raw and compressed bytes for independent native LVGL decoder testing.
    (out/(p.stem+'.raw')).write_bytes(raw);(out/(p.stem+'.rle')).write_bytes(packed)
    results.append({'image':p.stem,'raw_bytes':len(raw),'packed_bytes':len(blob),'decoded_sha256':hashlib.sha256(raw).hexdigest(),'lossless':True})
(out/'report.json').write_text(json.dumps(results,indent=2)+'\n');print(json.dumps({'images':len(results),'raw_bytes':sum(r['raw_bytes'] for r in results),'packed_bytes':sum(r['packed_bytes'] for r in results),'lossless':True}))
