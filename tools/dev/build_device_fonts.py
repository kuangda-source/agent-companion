#!/usr/bin/env python3
"""Lossless LVGL font compression for the device; desktop sources stay intact."""
import hashlib,json,re,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
destination=ROOT/'.build/device-fonts';destination.mkdir(parents=True,exist_ok=True)
lock=json.loads((ROOT/'dev-toolchain.lock.json').read_text());results=[]
for original in sorted((ROOT/'generated/fonts').glob('*.c')):
    key=json.loads(original.with_suffix('.json').read_text());name=original.stem
    source=ROOT/'.cache/downloads'/lock['ui_font']['archive'] if name.startswith('ac_font_sans') else ROOT/'.cache/fonts'/('SarasaTermSC-'+('Bold' if name in ['ac_font_mono_20','ac_font_display_22','ac_font_comic_13','ac_font_comic_16'] else 'Regular')+'.ttf')
    if hashlib.sha256(source.read_bytes()).hexdigest()!=key['sha256']:raise ValueError('Font source hash mismatch')
    output=destination/original.name;marker=output.with_suffix('.json');identity={'original_sha256':hashlib.sha256(original.read_bytes()).hexdigest(),'converter':'1.5.3','compressed':True}
    if not output.is_file() or not marker.is_file() or json.loads(marker.read_text())!=identity:
        args=[str(ROOT/'.tools/bin/bun'),str(ROOT/'node_modules/lv_font_conv/lv_font_conv.js'),'--font',str(source),'--size',str(key['size']),'--bpp','4','--format','lvgl','--range',key['ranges'],'--symbols',key['symbols'],'--output',str(output)]
        if not name.startswith('ac_font_sans'):args.append('--no-kerning')
        subprocess.run(args,check=True,cwd=ROOT)
        text=output.read_text();old=original.read_text()
        for field in ['line_height','base_line']:
            value=re.search(r'\.'+field+r' = (\d+),',old).group(1);text=re.sub(r'\.'+field+r' = \d+,','.'+field+' = '+value+',',text)
        # Compression must retain exactly the original glyph set.
        if re.findall(r'/\* U\+([0-9A-F]+)',text)!=re.findall(r'/\* U\+([0-9A-F]+)',old):raise ValueError('Glyph coverage changed')
        output.write_text(text);marker.write_text(json.dumps(identity,indent=2)+'\n')
    text=output.read_text();bitmap=re.search(r'const uint8_t glyph_bitmap\[\].*?=\s*\{(.*?)\};',text,re.S).group(1)
    results.append({'font':name,'bitmap_bytes':len(re.findall(r'0x[0-9a-fA-F]+',bitmap)),'glyph_coverage_preserved':True,'sha256':hashlib.sha256(output.read_bytes()).hexdigest()})
(destination/'report.json').write_text(json.dumps(results,indent=2)+'\n');print(json.dumps({'fonts':len(results),'bitmap_bytes':sum(x['bitmap_bytes'] for x in results),'coverage_preserved':True}))
