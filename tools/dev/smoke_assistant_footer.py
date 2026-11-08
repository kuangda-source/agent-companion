#!/usr/bin/env python3
"""Exercise real SDL input, message arrival and footer modal lifecycle without an LLM."""
import json
import os
from pathlib import Path
import subprocess
import time
from urllib.request import urlopen
from PIL import Image

ROOT=Path(__file__).resolve().parents[2]
CACHE=ROOT/'.cache/assistant-bottom-ui'
CACHE.mkdir(parents=True,exist_ok=True)
OUT=ROOT/'reports/screenshots/assistant-footer'
OUT.mkdir(parents=True,exist_ok=True)
SIM=ROOT/'.build/simulator/agent_companion_sim'
PORT=18791
URL=f'http://127.0.0.1:{PORT}'
results=[]
cases=[
    ('neon-home',[],[],True),
    ('neon-carousel',['--frames','680'],['UI assistant_carousel page=2 count=4'],True),
    ('neon-messages',['--smoke-assistant'],['UI assistant_messages=opened'],True),
    ('neon-tools',['--smoke-tools'],['UI tools_drawer=opened'],True),
    ('arrival-closed',['--smoke-assistant-update'],['count=5 unread=5 source=mock','assistant_feed_accept=1 repeat=1 wrong_source=0'],True),
    ('arrival-follow',['--smoke-assistant','--smoke-assistant-update'],['count=5 unread=0 source=mock'],True),
    ('arrival-reading',['--smoke-assistant-scroll','--smoke-assistant-update'],['count=5 unread=1 source=mock'],True),
    ('escape-restores',['--smoke-assistant-escape'],['UI assistant_messages=opened','UI assistant_messages=closed'],True),
    ('long-message',['--smoke-assistant-long'],['count=1 unread=0 source=mock'],True),
    ('comic-home',['--theme','comic'],[],True),
    ('comic-tools',['--theme','comic','--smoke-tools'],['UI tools_drawer=opened'],True),
    ('neumorphism-messages',['--theme','neumorphism','--smoke-assistant'],['UI assistant_messages=opened'],True),
    ('unconfigured',['--smoke-assistant'],['UI assistant_messages=opened'],False),
    ('tools-routes',['--smoke-actions'],['UI assistant_messages=opened','tool_unavailable=pelican','tool_unavailable=connectivity'],True),
]
gateway=None
with (CACHE/'mock-gateway.log').open('w') as log:
    try:
        gateway=subprocess.Popen([str(ROOT/'.tools/bin/bun'),'apps/gateway/src/main.ts','--mock'],cwd=ROOT,
                                 env=dict(os.environ,PORT=str(PORT),AGENT_COMPANION_RUNTIME=str(CACHE/'runtime')),stdout=log,stderr=log)
        for _ in range(50):
            if gateway.poll() is not None:raise RuntimeError('Isolated mock Gateway failed to start')
            try:
                with urlopen(URL+'/api/v1/health',timeout=.3) as response:
                    if json.load(response)['data_source']=='mock':break
            except (OSError,ValueError):pass
            time.sleep(.1)
        else:raise RuntimeError('Isolated mock Gateway did not become ready')
        for name,flags,expected,mock in cases:
            target=OUT/(name+'.bmp')
            command=[str(SIM),'--gateway',URL if mock else 'http://127.0.0.1:1','--frames','380' if name=='tools-routes' else '150','--capture',str(target),*flags]
            if mock:command.append('--mock')
            run=subprocess.run(command,cwd=ROOT,capture_output=True,text=True,timeout=25,check=True)
            (CACHE/(name+'.log')).write_text(run.stdout+run.stderr)
            for item in expected:
                if item not in run.stdout:raise AssertionError(f'{name}: missing {item}: {run.stdout}{run.stderr}')
            if name=='arrival-closed':
                assert run.stdout.count('count=5 unread=5 source=mock')==1,'Identical feed must not create another unread notification'
            if not mock:assert 'source=mock' not in run.stdout
            with Image.open(target) as image:
                assert image.size==(1024,600)
                image.save(target.with_suffix('.png'))
            results.append({'case':name,'status':'PASS','capture':str(target.with_suffix('.png').relative_to(ROOT))})
            print('PASS',name,flush=True)
    finally:
        if gateway and gateway.poll() is None:gateway.terminate();gateway.wait(timeout=5)
(ROOT/'reports/ASSISTANT_FOOTER_SMOKE.json').write_text(json.dumps({'scope':'NATIVE_UI_ONLY','model_calls':0,'hardware':'NOT_VERIFIED','cases':results},ensure_ascii=False,indent=2)+'\n')
