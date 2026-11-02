import importlib.util
from datetime import datetime,timezone
from pathlib import Path
import unittest
import os,json,tempfile,threading,time,select,signal,types
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('device_bridge',Path(__file__).resolve().parents[1]/'tools/dev/device_bridge.py')
bridge=importlib.util.module_from_spec(spec);spec.loader.exec_module(bridge)
class BridgeFreshness(unittest.TestCase):
    def test_usb_pairing_receipt_without_usb_view_fallback(self):
        testcase=self
        class DeviceSerial:
            def __init__(self,**kwargs):self.is_open=False;self.incoming=bytearray();self.written=bytearray();self.lock=threading.Lock()
            def open(self):self.is_open=True
            def close(self):self.is_open=False
            @property
            def in_waiting(self):
                with self.lock:return min(len(self.incoming),7)
            def read(self,size):
                with self.lock:data=bytes(self.incoming[:size]);del self.incoming[:size]
                if not data:time.sleep(.01)
                return data
            def write(self,data):
                self.written.extend(data)
                if b'\n' in self.written:
                    header,body=self.written.split(b'\n',1);fields=header.split();size=int(fields[1])
                    if len(body)>=size:
                        testcase.assertEqual(bridge.zlib.crc32(body[:size]),int(fields[2],16));value=json.loads(body[:size]);testcase.assertEqual(value['kind'],'link_config');self.written.clear()
                        reply=('\nAC_LINK_CONFIG '+json.dumps({'request_id':value['request_id'],'state':'saved'})+'\n').encode()
                        with self.lock:self.incoming.extend(reply)
                        time.sleep(.05) # Deliver ACK before write returns; never overwrite saved with sent.
                return len(data)
        with tempfile.TemporaryDirectory() as d:
            runtime=Path(d);request_id='11111111-1111-1111-1111-111111111111'
            (runtime/'link-pending.json').write_text(json.dumps({'kind':'link_config','request_id':request_id,'expires_at':time.time()*1000+60000,'lan_url':'wss://192.168.1.2:8737/v1/device','lan_token':'a'*64,'lan_ca':'test-only'*150}))
            handlers={sig:signal.getsignal(sig) for sig in [signal.SIGINT,signal.SIGTERM]}
            try:
                with patch.object(bridge.serial,'Serial',DeviceSerial):bridge.run(types.SimpleNamespace(runtime=d,port='test-only',gateway='http://127.0.0.1:1',seconds=1,network_only=True,capture=None))
            finally:
                for sig,h in handlers.items():signal.signal(sig,h)
            self.assertFalse((runtime/'link-pending.json').exists());status=json.loads((runtime/'board-bridge.status.json').read_text());self.assertEqual(status['link_config']['state'],'saved');self.assertEqual(status['sent'],0)
    def test_receipt_is_required_and_expires(self):
        now=1800000000
        def at(delta):return datetime.fromtimestamp(now+delta,timezone.utc).isoformat()
        original={'connected':True,'network':{'state':'relay_connected'},'last_ack_utc':at(-3)}
        self.assertTrue(bridge.status_snapshot(original,now)['data_fresh'])
        self.assertFalse(bridge.status_snapshot(original,now+10)['connected'])
        self.assertTrue(original['connected'])
        for stamp in [at(-8),at(10),'invalid',None]:
            self.assertFalse(bridge.status_snapshot({'connected':True,'last_ack_utc':stamp},now)['connected'])
        self.assertFalse(bridge.status_snapshot({'connected':False,'last_ack_utc':at(0)},now)['data_fresh'])
        self.assertFalse(bridge.status_snapshot({'network':{'state':'relay_connected'}},now)['connected'])
if __name__=='__main__':unittest.main()
