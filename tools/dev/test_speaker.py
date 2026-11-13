#!/usr/bin/env python3
"""Play a bounded diagnostic clip on the board, without Mac speaker playback.

Quit the Mac controller before opening its USB port. This does not change TTS,
notification, Wi-Fi or relay configuration. Requires pyserial from the dev SDK.
"""
import argparse
import base64
import json
import math
import struct
import time
import uuid
import wave
import zlib

import serial


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', required=True)
    parser.add_argument('--wav', help='16 kHz mono signed PCM16 WAV, at most four seconds')
    parser.add_argument('--volume', type=int, default=35, choices=range(0, 81), metavar='0..80')
    args = parser.parse_args()
    if args.wav:
        with wave.open(args.wav, 'rb') as source:
            if (source.getframerate(), source.getnchannels(), source.getsampwidth(), source.getcomptype()) != (16000, 1, 2, 'NONE'):
                parser.error('WAV must be 16 kHz, mono, uncompressed PCM16')
            if not 0 < source.getnframes() <= 64000:
                parser.error('WAV must be no longer than four seconds')
            pcm = source.readframes(source.getnframes())
    else:
        samples = []
        for i in range(16000):
            t = i / 16000
            phase = t if t < .4 else t - .55
            frequency = 660 if t < .4 else 880
            envelope = max(0, min(1, phase / .02, (.4 - phase) / .02))
            samples.append(int(15000 * envelope * math.sin(2 * math.pi * frequency * phase)))
        pcm = struct.pack('<%dh' % len(samples), *samples)
    identity = 'speaker-' + uuid.uuid4().hex
    body = json.dumps({'kind': 'audio_pcm', 'id': identity, 'sample_rate': 16000,
                       'channels': 1, 'bits_per_sample': 16, 'volume': args.volume,
                       'pcm_base64': base64.b64encode(pcm).decode()}, separators=(',', ':')).encode()
    frame = ('AC1 %d %08x\n' % (len(body), zlib.crc32(body))).encode() + body + b'\n'
    link = serial.Serial(port=None, baudrate=921600, timeout=.1, write_timeout=5, exclusive=True)
    link.dtr = False
    link.rts = False
    link.port = args.port
    with link:
        # Some USB stacks reset the board on open. Wait for its app, not the ROM.
        deadline = time.monotonic() + 18
        while time.monotonic() < deadline:
            line = link.readline()
            if line.startswith(b'AC_EVT ') and b'"ready"' in line:
                break
            if b'ac_device: health' in line:
                break
        link.write(frame)
        link.flush()
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            line = link.readline()
            if not line.startswith(b'AC_AUDIO '):
                continue
            event = json.loads(line[9:])
            if event.get('id') not in (identity, 'invalid'):
                continue
            print(json.dumps(event), flush=True)
            if event.get('state') == 'error':
                raise RuntimeError('Board audio rejected: ' + event.get('reason', 'unknown'))
            if event.get('state') == 'played':
                assert event['bytes'] == len(pcm)
                return
        raise RuntimeError('No board playback acknowledgement; verify firmware and port ownership')


if __name__ == '__main__':
    main()
