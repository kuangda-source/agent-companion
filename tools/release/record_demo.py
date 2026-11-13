#!/usr/bin/env python3
"""Record the real shared LVGL renderer with explicit synthetic data, never the desktop.

The SDL dummy video driver captures only the app framebuffer. No live Gateway,
Agent records, screen pixels, microphone or model API is used.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
SCENES = [('home', [], 360, '桌宠与会话监控 · MOCK 模拟数据'),
          ('detail', ['--smoke-detail'], 360, '只读会话详情 · MOCK 模拟数据'),
          ('usage', ['--smoke-usage', '7', '--smoke-usage-switch'], 360, '7 / 30 天 Token 统计 · MOCK 模拟数据'),
          ('theme', ['--smoke-theme'], 420, '主题选择：赛博霓虹 / 漫画 / 新拟物 · MOCK'),
          ('wifi', ['--smoke-wifi-connected'], 360, '屏幕独立配网界面 · MOCK 示例网络'),
          ('volume', ['--smoke-volume'], 360, '音量 0–100% 与静音 · MOCK 无音轨'),
          ('assistant', ['--smoke-assistant'], 420, 'AI 助手消息与展开阅读 · MOCK 示例消息')]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--port', type=int, default=8876)
    parser.add_argument('--ffmpeg')
    parser.add_argument('--scenes',nargs='+',choices=[s[0] for s in SCENES],help='Re-record selected scenes in an existing output folder')
    parser.add_argument('--font', default='/System/Library/Fonts/STHeiti Medium.ttc')
    args = parser.parse_args()
    ffmpeg = args.ffmpeg or shutil.which('ffmpeg')
    if not ffmpeg:
        try:
            import imageio_ffmpeg
            ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        except ImportError as exc:
            raise RuntimeError('Provide an installed FFmpeg with --ffmpeg') from exc
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    logs = (out / 'gateway.log').open('wb')
    env = {**os.environ, 'PORT': str(args.port), 'AGENT_COMPANION_RUNTIME': str(out / 'empty-runtime')}
    gateway = subprocess.Popen([str(ROOT / '.tools/bin/bun'), 'run', 'apps/gateway/src/main.ts', '--mock', '--animate'], cwd=ROOT, env=env, stdout=logs, stderr=logs)
    url = 'http://127.0.0.1:' + str(args.port)
    try:
        for _ in range(100):
            if gateway.poll() is not None:
                raise RuntimeError('The isolated MOCK Gateway exited')
            try:
                with urllib.request.urlopen(url + '/api/v1/health', timeout=.5) as r:
                    if json.load(r).get('data_source') == 'mock':
                        break
            except OSError:
                pass
            time.sleep(.1)
        else:
            raise RuntimeError('MOCK Gateway is not ready')
        for name, flags, frames, caption in SCENES:
            if args.scenes and name not in args.scenes:
                continue
            dest = out / ('frames-' + name)
            dest.mkdir(exist_ok=False)
            log_path = out / (name + '.log')
            with log_path.open('wb') as log:
                subprocess.run([str(ROOT / '.build/simulator/agent_companion_sim'), '--mock', '--gateway', url, *flags, '--frames', str(frames), '--capture-prefix', str(dest / 'frame'), '--capture-every', '2'], cwd=ROOT,
                               env={**os.environ, 'SDL_VIDEODRIVER': 'dummy', 'SDL_AUDIODRIVER': 'dummy'}, stdout=log, stderr=log, check=True)
            times = [(int(a), int(b)) for a, b in re.findall(r'CAPTURE frame=(\d+) tick_ms=(\d+)', log_path.read_text()) if int(a) >= 30]
            if len(times) < 80:
                raise RuntimeError('Too few actual application frames')
            listing = out / (name + '.ffconcat')
            lines = ['ffconcat version 1.0']
            for i, (frame, tick) in enumerate(times):
                path = dest / ('frame-%04d.bmp' % frame)
                duration = (times[i + 1][1] - tick) / 1000 if i + 1 < len(times) else 1 / 30
                lines.extend(["file '" + str(path).replace("'", "'\\''") + "'", 'duration %.6f' % max(.001, duration)])
            listing.write_text('\n'.join(lines) + '\n')
            text = out / (name + '.txt')
            text.write_text(caption)
            font = str(Path(args.font)).replace(':', r'\:')
            overlay = "pad=iw:ih+52:0:52:color=0x081018,drawtext=fontfile='%s':textfile='%s':fontcolor=0x5ce7ee:fontsize=22:x=22:y=14:expansion=none,fps=30,format=yuv420p" % (font, str(text))
            subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-safe', '0', '-f', 'concat', '-i', str(listing), '-vf', overlay, '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-movflags', '+faststart', str(out / (name + '.mp4'))], check=True)
            for p in dest.glob('*.bmp'):
                p.unlink()
            dest.rmdir()
            print('Recorded actual MOCK renderer:', name, flush=True)
        for title, scenes in [('overview', ['home', 'detail', 'usage', 'theme']), ('tools', ['wifi', 'volume', 'assistant'])]:
            if not all((out/(name+'.mp4')).exists() for name in scenes):
                continue
            listing = out / (title + '-clips.txt')
            listing.write_text(''.join("file '" + str(out / (name + '.mp4')) + "'\n" for name in scenes))
            target = out / ('demo-0.4.19-' + title + '.mp4')
            subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-safe', '0', '-f', 'concat', '-i', str(listing), '-c', 'copy', '-movflags', '+faststart', str(target)], check=True)
            print('Video:', target.name, target.stat().st_size, flush=True)
        overview = out / 'demo-0.4.19-overview.mp4'
        if not overview.exists():
            return
        subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-ss', '1', '-i', str(overview), '-t', '5', '-vf', 'fps=10,scale=864:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse', str(out / 'demo-0.4.19.gif')], check=True)
        subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-ss', '1', '-i', str(overview), '-frames:v', '1', str(out / 'screen-0.4.19.png')], check=True)
    finally:
        gateway.terminate()
        try:
            gateway.wait(timeout=10)
        except subprocess.TimeoutExpired:
            gateway.kill()
            gateway.wait()
        logs.close()


if __name__ == '__main__':
    main()
