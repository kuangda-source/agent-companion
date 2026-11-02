#!/usr/bin/env python3
"""Local Gateway -> native USB Serial/JTAG V1 viewer. No model keys on device."""
import argparse
import copy
from datetime import datetime,timezone
import json
import os
from pathlib import Path
import queue
import re
import signal
import threading
import time
import urllib.request
import urllib.parse
import zlib
import serial

ROOT=Path(__file__).resolve().parents[2]
MAX_FRAME=192*1024
def encode_frame(value):
    body=json.dumps(value,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode()
    if not 0<len(body)<=MAX_FRAME:raise ValueError('frame_size')
    return ('AC1 %d %08x\n'%(len(body),zlib.crc32(body))).encode()+body+b'\n'

def clipped(text,capacity):
    raw=str(text).encode('utf-8')
    return str(text) if len(raw)<capacity else raw[:capacity-64].decode('utf-8','ignore')+'\n…（长消息已截短）'

def status_snapshot(stats,now=None):
    report=copy.deepcopy(stats)
    try:age=(time.time() if now is None else now)-datetime.fromisoformat(str(report.get('last_ack_utc',''))).timestamp()
    except (ValueError,TypeError):age=999999
    report['data_fresh']=bool(report.get('connected') and -2<=age<8)
    report['connected']=report['data_fresh']
    return report

def run(args):
    runtime=Path(args.runtime);runtime.mkdir(parents=True,exist_ok=True);os.umask(0o077)
    stopping=threading.Event();commands=queue.Queue(16);stats={'mode':'network_only' if args.network_only else 'usb_viewer','sent':0,'acknowledged':0,'last_ack':None,'connected':False};lock=threading.Lock()
    status=runtime/'board-bridge.status.json';log=(runtime/'board-bridge.log').open('a',buffering=1)
    def record(kind,**fields):
        line=json.dumps({'at':datetime.now(timezone.utc).isoformat(),'event':kind,**fields},ensure_ascii=False)
        log.write(line+'\n');print(line,flush=True)
    def save():
        with lock:report=status_snapshot(stats)
        report.update({'port':args.port,'pid':os.getpid(),'gateway':args.gateway,'model_keys_on_device':False,'updated_at':datetime.now(timezone.utc).isoformat()})
        temp=status.with_suffix('.tmp');temp.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');temp.replace(status)
    def api(path,value=None,method=None):
        token=(runtime/'gateway.token').read_text().strip()
        headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'}
        req=urllib.request.Request(args.gateway+path,headers=headers,data=None if value is None else json.dumps(value).encode(),method=method)
        with urllib.request.urlopen(req,timeout=4) as response:return json.load(response)
    for sig in [signal.SIGINT,signal.SIGTERM]:signal.signal(sig,lambda *_:stopping.set())
    deadline=time.monotonic()+args.seconds if args.seconds else None
    while not stopping.is_set():
        if deadline and time.monotonic()>=deadline:break
        port=None;reader=None
        try:
            port=serial.Serial(port=None,baudrate=921600,timeout=.2,write_timeout=5,exclusive=True);port.dtr=False;port.rts=False;port.port=args.port;port.open()
            with lock:stats['usb_connected']=True
            record('usb_open',port=args.port)
            def read():
                buf=bytearray();capture_header=None;capture_started=0
                while not stopping.is_set() and port.is_open:
                    try:data=port.read(min(port.in_waiting or 1,4096))
                    except (serial.SerialException,OSError):break
                    buf.extend(data)
                    if capture_header and time.monotonic()-capture_started>8:
                        capture_header=None;buf.clear()
                        with lock:stats['capture_failed']=True
                        record('capture_timeout')
                    if len(buf)>2*1024*1024:buf.clear();capture_header=None
                    while True:
                        if capture_header:
                            size,width,height,stride,crc=capture_header
                            if len(buf)<size:break
                            pixels=bytes(buf[:size]);del buf[:size];capture_header=None
                            if args.capture and zlib.crc32(pixels)==crc:
                                target=Path(args.capture);target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(pixels)
                                info={'width':width,'height':height,'stride':stride,'bytes':size,'crc32':crc,'source':'LVGL snapshot rendered by ESP32-P4'}
                                target.with_suffix('.json').write_text(json.dumps(info,indent=2)+'\n')
                                with lock:stats['capture']=str(target)
                                record('captured',**info)
                            else:
                                with lock:stats['capture_failed']=True
                                record('capture_crc_failed')
                            continue
                        if b'\n' not in buf:break
                        line,_,rest=buf.partition(b'\n');buf=bytearray(rest);text=line.decode('utf-8','replace').strip()
                        if text.startswith('AC_SCREEN '):
                            try:
                                fields=text.split();size,width,height,stride=map(int,fields[1:5]);crc=int(fields[5],16)
                                if width==1024 and height==600 and stride==2048 and size==stride*height:capture_header=(size,width,height,stride,crc);capture_started=time.monotonic()
                            except (ValueError,IndexError):pass
                        elif text.startswith('AC_ACK '):
                            try:identifier=int(text.split()[1])
                            except (ValueError,IndexError):continue
                            with lock:stats.update(acknowledged=stats['acknowledged']+1,last_ack=identifier,last_ack_utc=datetime.now(timezone.utc).isoformat(),connected=True)
                            record('applied',receipt=text)
                        elif text.startswith('AC_DISPLAY '):
                            try:
                                display=json.loads(text[11:])
                                with lock:stats['display']=display
                                record('display_applied',**display)
                            except ValueError:pass
                        elif text.startswith('AC_EVT '):
                            if '"kind":"disconnected"' in text:
                                with lock:stats['connected']=False
                            try:commands.put_nowait(json.loads(text[7:]))
                            except (ValueError,queue.Full):pass
                            record('device_event',value=text[7:500])
                        elif text.startswith('PET agent='):
                            match=re.search(r'agent=(\d+) expression=(\w+) frame=(\d+)',text)
                            if match:
                                with lock:
                                    activity=stats.setdefault('pet_activity',{}).setdefault(match[1],{'expression_changes':0})
                                    activity.update(expression=match[2],last_expression_start_frame=int(match[3]),expression_changes=activity['expression_changes']+1)
                        elif text.startswith('AC_LINK_CONFIG '):
                            try:
                                value=json.loads(text[15:])
                                with lock:stats['link_config']={'request_id':value.get('request_id'),'state':value.get('state')}
                                pending=runtime/'link-pending.json'
                                if pending.is_file() and json.loads(pending.read_text()).get('request_id')==value.get('request_id') and value.get('state')=='saved':pending.unlink()
                                record('link_config_status',state=value.get('state'))
                            except (OSError,ValueError):pass
                        elif text.startswith('AC_LINK '):
                            try:
                                value=json.loads(text[8:])
                                with lock:stats['link']=value
                                record('link_health',**value)
                            except ValueError:pass
                        elif text.startswith('AC_NET ') or text.startswith('AC_PROVISION '):
                            try:
                                value=json.loads(text.split(' ',1)[1])
                                if text.startswith('AC_NET '):
                                    with lock:stats['network']={'state':str(value.get('state','unknown'))[:64],'code':value.get('code',0)}
                                else:
                                    with lock:stats['provision']={'request_id':value.get('request_id'),'state':value.get('state')}
                                    pending=runtime/'wifi-pending.json'
                                    try:
                                        if json.loads(pending.read_text()).get('request_id')==value.get('request_id') and value.get('state')=='saved':pending.unlink()
                                    except (OSError,ValueError):pass
                                record('network_status' if text.startswith('AC_NET ') else 'provision_status',state=value.get('state'))
                            except ValueError:pass
                        elif re.search(r'[EW] \([0-9]+\) (websocket_client|transport_[a-z_]+|esp-tls):',text):
                            record('network_driver_error',value=text[:1000])
                        elif text.startswith('AC_TOUCH ') or text.startswith('AC_RELEASE ') or 'ac_device:' in text or any(w in text for w in ['Guru Meditation','abort()','Backtrace:','assert failed']):
                            if 'ac_device: health' in text:
                                with lock:stats['device_health']={k:int(v) for k,v in re.findall(r'([a-z_0-9]+)=([0-9]+)',text)}
                            record('device_log',value=text[:1000])
            reader=threading.Thread(target=read,daemon=True);reader.start();selected=None;last_detail=None;last_detail_at=0;next_poll=0;allowed_ids=set();last_provision_at=float("-inf")
            while not stopping.is_set() and reader.is_alive():
                if deadline and time.monotonic()>=deadline:stopping.set();break
                request=None
                try:request=commands.get(timeout=.1)
                except queue.Empty:pass
                if isinstance(request,dict):
                    try:
                        kind=request.get('kind')
                        if kind=='detail':
                            wanted=request.get('id')
                            if isinstance(wanted,str) and wanted in allowed_ids:selected=wanted;last_detail=None;next_poll=0
                        elif kind=='theme' and request.get('value') in ['neon','comic','neumorphism']:
                            api('/api/v1/settings',{'appearance':{'theme':request['value']}},'PATCH');next_poll=0
                        elif kind=='assistant_refresh':api('/api/v1/assistant/refresh',{},'POST');next_poll=0
                    except (OSError,ValueError,urllib.error.URLError) as error:record('request_failed',type=type(error).__name__)
                for filename,key in [('wifi-pending.json','provision'),('link-pending.json','link_config')]:
                    pending=runtime/filename
                    if pending.is_file():
                        try:
                            value=json.loads(pending.read_text())
                            if value.get('expires_at',0)<time.time()*1000:
                                pending.unlink()
                                with lock:stats[key]={'state':'expired'}
                            elif time.monotonic()-last_provision_at>5:
                                value['sent_at']=time.time();frame=encode_frame(value)
                                with lock:stats[key]={'request_id':value.get('request_id'),'state':'sent'}
                                last_provision_at=time.monotonic()
                                for offset in range(0,len(frame),1024):port.write(frame[offset:offset+1024]);time.sleep(.002)
                        except (OSError,ValueError):record('provision_read_failed')
                if time.monotonic()<next_poll:continue
                if args.network_only:
                    with lock:capture_ready=bool(args.capture and not stats.get('capture_requested') and stats.get('acknowledged',0)>1 and stats.get('network',{}).get('state') in ['relay_connected','lan_connected'])
                    if capture_ready:
                        port.write(encode_frame({'kind':'capture','schedules':getattr(args,'capture_schedules',False)}))
                        with lock:stats['capture_requested']=True
                    save();next_poll=time.monotonic()+1;continue
                try:
                    state=api('/api/v1/state')
                    if state.get('schema_version')!=1 or state.get('data_source')!='live':raise ValueError('live_state_required')
                    generated=datetime.fromisoformat(state['generated_at'].replace('Z','+00:00')).timestamp()
                    if abs(time.time()-generated)>10:raise ValueError('stale_gateway_state')
                    allowed_ids={s['id'] for s in state['sessions']};assistant=api('/api/v1/assistant');settings=api('/api/v1/settings')
                    if selected not in allowed_ids:selected=None;last_detail=None
                    feed={k:assistant[k] for k in ['schema_version','data_source','revision','status','model','messages']}
                    feed['messages']=[{**m,'text':clipped(m['text'],4096)} for m in feed['messages'][-8:]]
                    if selected in allowed_ids and time.monotonic()-last_detail_at>5:
                        last_detail=api('/api/v1/sessions/'+urllib.parse.quote(selected,safe=''));last_detail_at=time.monotonic()
                        messages=last_detail.get('messages',[]);last_detail['messages']=[{k:clipped(m[k],4096) if k=='text' else m[k] for k in ['id','role','text']} for m in messages[:12]]
                        last_detail['transcript_truncated']=bool(last_detail.get('transcript_truncated') or len(messages)>12 or any(len(m.get('text','').encode())>=4096 for m in messages[:12]))
                    with lock:identifier=stats['sent']+1
                    value={'id':identifier,'sent_at':time.time(),'state':state,'assistant':feed,'settings':{'revision':settings.get('revision'),'appearance':settings.get('appearance'),'display':api('/api/v1/host-display')['target']}}
                    with lock:wants_capture=bool(args.capture and not stats.get('capture') and not stats.get('capture_failed') and identifier>=3)
                    if wants_capture:value['capture']=True
                    if last_detail:value['detail']=last_detail
                    frame=encode_frame(value)
                    for offset in range(0,len(frame),1024):port.write(frame[offset:offset+1024]);time.sleep(.002)
                    with lock:stats.update(sent=identifier,last_source_seq=state['seq'],last_bytes=len(frame),assistant_messages=len(feed['messages']))
                    save();next_poll=time.monotonic()+2
                except (OSError,ValueError,KeyError,urllib.error.URLError) as error:
                    with lock:stats['connected']=False
                    record('source_unavailable',type=type(error).__name__);save();next_poll=time.monotonic()+2
        except (serial.SerialException,OSError) as error:record('usb_unavailable',type=type(error).__name__)
        finally:
            if port:port.close()
            if reader:reader.join(timeout=1)
        with lock:stats['connected']=False;stats['usb_connected']=False
        save()
        if not stopping.is_set():stopping.wait(2)
    record('stopped');log.close()

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--port',required=True,help='Actual P4 USB serial port');parser.add_argument('--gateway',default='http://127.0.0.1:8736');parser.add_argument('--runtime',default=str(Path.home()/'Library/Application Support/AgentCompanion'));parser.add_argument('--seconds',type=int,default=0);parser.add_argument('--network-only',action='store_true',help='USB provisioning and diagnostics only; live view comes from WSS');parser.add_argument('--capture-schedules',action='store_true',help='Open the schedule tab for the USB-only diagnostic capture');parser.add_argument('--capture',help='Save a one-shot RGB565 render returned by the board');args=parser.parse_args()
    url=urllib.parse.urlparse(args.gateway)
    if url.scheme!='http' or url.hostname not in ['127.0.0.1','localhost']:parser.error('This USB bridge only accesses the local Gateway')
    run(args)
