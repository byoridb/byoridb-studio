#!/usr/bin/env python3
"""Performance benchmark against the release studio-service binary.

Starts its own service on a free loopback port with a temporary BYORI_STUDIO_HOME
(never ~/.byori-studio, never port 43123), makes synthetic media with FFmpeg and
measures over RPC:

  a  import of 4K media up to the project response, then waveforms and proxies
  b  exact preview frames of a 4K project (width 640/1280, with and without proxies)
  c  a 500-clip 1080p timeline: split/update/shift/undo round trips, project.get
     (conditional and full) time and size, exact preview frames
  d  exports: 60 s of the 500-clip timeline and 60 s of 4K, hardware and software,
     and all 500 clips (500 s) in one export
  e  the service's peak memory (RSS), and that of its FFmpeg children

Build the binary first:
    cargo build --release --manifest-path src-tauri/Cargo.toml --bin studio-service
Run:
    python3 scripts/bench.py --out bench.json [--media-dir DIR] [--baseline before.json]
        [--only a,b,c,d] [--quick]

--media-dir keeps the synthetic media between runs (they take a few minutes to make);
without it they are made in a temporary folder and removed. --quick shortens the
media and the timeline for a smoke run; its numbers are not comparable.
"""
import argparse
import json
import os
from pathlib import Path
import platform
import random
import shutil
import signal
import socket
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

REPO = Path(__file__).resolve().parent.parent
DEFAULT_BINARY = REPO / 'src-tauri/target/release/studio-service'
USER_PORT = 43123


def free_port():
    while True:
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0))
            port = s.getsockname()[1]
        if port != USER_PORT:
            return port


class Service:
    """One isolated studio-service process."""

    def __init__(self, binary):
        self.binary = binary
        self.home = Path(tempfile.mkdtemp(prefix='byori-bench-home-'))
        self.port, self.dev_port = free_port(), free_port()
        self.env = dict(os.environ, BYORI_STUDIO_HOME=str(self.home), BYORI_STUDIO_PORT=str(self.port),
                        BYORI_STUDIO_DEV_PORT=str(self.dev_port), VITE_STUDIO_PORT=str(self.dev_port))
        self.process = None
        self.memory = None

    def start(self):
        self.log = open(self.home / 'service.log', 'ab')
        self.process = subprocess.Popen([str(self.binary)], env=self.env, stdout=self.log, stderr=subprocess.STDOUT)
        file = self.home / 'connection.json'
        for _ in range(400):
            if file.exists():
                try:
                    self.connection = json.loads(file.read_text())
                    break
                except ValueError:
                    pass
            if self.process.poll() is not None:
                raise SystemExit('service exited: ' + self.output())
            time.sleep(0.05)
        else:
            raise SystemExit('service did not start: ' + self.output())
        assert self.connection['url'] == f'http://127.0.0.1:{self.port}', self.connection['url']
        return self

    def output(self):
        self.log.flush()
        return (self.home / 'service.log').read_text(errors='replace')[-4000:]

    def close(self):
        if self.process and self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            try:
                self.process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        if self.process:
            self.log.close()
        shutil.rmtree(self.home, ignore_errors=True)

    def raw(self, method, params=None):
        """Returns (seconds until the whole response arrived, status, body bytes)."""
        body = json.dumps({'method': method, 'params': params or {}}).encode()
        request = Request(self.connection['url'] + '/rpc', data=body, method='POST', headers={
            'Content-Type': 'application/json', 'Authorization': 'Bearer ' + self.connection['token']})
        began = time.perf_counter()
        try:
            with urlopen(request, timeout=1800) as response:
                status, data = response.status, response.read()
        except HTTPError as error:
            status, data = error.code, error.read()
        return time.perf_counter() - began, status, data

    def timed(self, method, params=None):
        """Returns (seconds, result, response bytes); raises on an error reply."""
        seconds, status, data = self.raw(method, params)
        value = json.loads(data) if data else {}
        if status != 200:
            raise RuntimeError(f'{method}: {status} {value.get("error", value)}')
        return seconds, value['result'], len(data)

    def rpc(self, method, params=None):
        return self.timed(method, params)[1]


class Memory(threading.Thread):
    """Samples the resident memory of the service and of its child processes."""

    def __init__(self, pid):
        super().__init__(daemon=True)
        self.pid, self.service_kb, self.children_kb, self.done = pid, 0, 0, threading.Event()
        self.recent_kb = 0  # the children's peak since it was last set to 0

    def run(self):
        while not self.done.wait(0.5):
            try:
                rows = subprocess.run(['ps', '-axo', 'pid=,ppid=,rss='], capture_output=True, text=True).stdout.split('\n')
            except OSError:
                continue
            children = 0
            for row in rows:
                parts = row.split()
                if len(parts) != 3:
                    continue
                pid, parent, rss = (int(x) for x in parts)
                if pid == self.pid:
                    self.service_kb = max(self.service_kb, rss)
                elif parent == self.pid:
                    children += rss
            self.children_kb = max(self.children_kb, children)
            self.recent_kb = max(self.recent_kb, children)


def ffmpeg(*args):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', *args], check=True)


def encoder_works(name):
    return subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=0.2',
                           '-c:v', name, '-f', 'null', '-'], capture_output=True).returncode == 0


def make_media(folder, quick):
    """The three synthetic sources; existing ones of the same recipe are reused."""
    folder.mkdir(parents=True, exist_ok=True)
    scale = 0.1 if quick else 1
    hevc = 'hevc_videotoolbox' if encoder_works('hevc_videotoolbox') else 'libx265'
    recipes = {
        # name: (size, fps, seconds, video encoder arguments)
        'uhd-h264-30.mp4': ('3840x2160', 30, 60 * scale,
                            ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-g', '60', '-keyint_min', '60',
                             '-sc_threshold', '0']),
        'uhd-hevc-60.mp4': ('3840x2160', 60, 20 * scale,
                            ['-c:v', hevc, '-g', '120', '-tag:v', 'hvc1']
                            + (['-b:v', '40M'] if hevc == 'hevc_videotoolbox' else ['-preset', 'ultrafast', '-crf', '24'])),
        'hd-h264-30.mp4': ('1920x1080', 30, 600 * scale,
                           ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-g', '60']),
    }
    made = {}
    note = folder / 'recipes.json'
    known = json.loads(note.read_text()) if note.is_file() else {}
    for name, (size, fps, seconds, video) in recipes.items():
        path = folder / name
        recipe = [size, fps, seconds, video]
        if not (path.is_file() and known.get(name) == recipe):
            began = time.perf_counter()
            ffmpeg('-f', 'lavfi', '-i', f'testsrc2=size={size}:rate={fps}:duration={seconds}',
                   '-f', 'lavfi', '-i', f'sine=frequency=440:duration={seconds}',
                   *video, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-shortest', str(path))
            known[name] = recipe
            note.write_text(json.dumps(known))
            print(f'  made {name} in {time.perf_counter() - began:.1f}s', flush=True)
        made[name] = {'path': str(path), 'bytes': path.stat().st_size, 'size': size, 'fps': fps, 'seconds': seconds}
    return made


def summary(seconds):
    """Median, 95th percentile, fastest and slowest in milliseconds."""
    ordered = sorted(seconds)
    rank = max(0, -(-len(ordered) * 95 // 100) - 1)
    return {'n': len(ordered), 'median_ms': round(statistics.median(ordered) * 1000, 1),
            'p95_ms': round(ordered[rank] * 1000, 1), 'min_ms': round(ordered[0] * 1000, 1),
            'max_ms': round(ordered[-1] * 1000, 1)}


def wait_until(check, seconds, interval=0.25):
    began = time.perf_counter()
    while True:
        value = check()
        if value:
            return time.perf_counter() - began, value
        if time.perf_counter() - began > seconds:
            return None, None
        time.sleep(interval)


def distinct_times(duration, count, seed, fps=30):
    """Random times on different frames, at least three frames apart."""
    last = int((duration - 0.2) * fps)
    return [frame / fps for frame in random.Random(seed).sample(range(0, last, 3), count)]


def frames(service, times, width, extra=None):
    """Exact frames at the given times, each a new request the cache cannot answer."""
    took, used = [], 0
    for at in times:
        seconds, result, _ = service.timed('preview.frame', dict({'time': at, 'width': width, 'client': 'bench'}, **(extra or {})))
        assert result.get('cacheHit') is False, result
        took.append(seconds)
        used += 1 if result.get('proxies') else 0
    return dict(summary(took), frames_from_proxies=used)


def export(service, params, limit=3600):
    """Runs one export to its end; returns wall seconds, the encoder and the file size."""
    path = Path(params['path'])
    if service.memory:
        service.memory.recent_kb = 0
    began = time.perf_counter()
    job = service.rpc('export.start', params)
    while True:
        state = service.rpc('export.status', {'id': job['id']})
        if state['state'] in ('completed', 'failed', 'cancelled'):
            break
        if time.perf_counter() - began > limit:
            service.rpc('export.cancel', {'id': job['id']})
            return {'state': 'timeout', 'seconds': round(time.perf_counter() - began, 2)}
        time.sleep(0.1)
    seconds = time.perf_counter() - began
    result = {'state': state['state'], 'seconds': round(seconds, 2), 'encoder': state.get('encoder')}
    if state['state'] == 'completed':
        span = params['end'] - params['start']
        probed = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                                            'stream=nb_frames,duration', '-of', 'json', str(path)],
                                           capture_output=True, text=True).stdout or '{}')
        stream = (probed.get('streams') or [{}])[0]
        result.update(realtime_factor=round(span / seconds, 2), bytes=path.stat().st_size,
                      video_frames=int(stream.get('nb_frames') or 0), video_seconds=round(float(stream.get('duration') or 0), 3))
        if service.memory:
            result['ffmpeg_peak_rss_mb'] = round(service.memory.recent_kb / 1024)
        path.unlink()
    else:
        result['error'] = str(state.get('error'))[-600:]
    return result


def scenario_uhd(service, media, results, only, quick):
    """a, b and the 4K part of d."""
    project = service.rpc('project.new', {'name': '벤치 4K', 'width': 3840, 'height': 2160, 'fps': 30})
    imports = {}
    for name in ('uhd-h264-30.mp4', 'uhd-hevc-60.mp4'):
        seconds, project, size = service.timed('media.importAndAdd', {
            'paths': [media[name]['path']], 'expectedRevision': project['revision']})
        imports[name] = {'import_to_project_ms': round(seconds * 1000, 1), 'response_bytes': size}
    began = time.perf_counter()

    def ready(flag):
        now = service.rpc('project.get')
        return all(m.get(flag) for m in now['media']) and now
    waveform_s, _ = wait_until(lambda: ready('waveform'), 600)
    waveforms_at = time.perf_counter() - began if waveform_s is not None else None
    frames_during = None
    if 'b' in only:
        # While the proxies are still being made there is nothing but the originals.
        duration = max(c['start'] + c['duration'] for c in project['clips'])
        frames_during = frames(service, distinct_times(duration, 26, 7)[20:], 640)
    proxy_s, project_now = wait_until(lambda: ready('proxy'), 1800, 0.5)
    proxies_at = time.perf_counter() - began if proxy_s is not None else None
    results['a_import_uhd'] = {
        'imports': imports,
        'waveforms_done_s': None if waveforms_at is None else round(waveforms_at, 2),
        'proxies_done_s': None if proxies_at is None else round(proxies_at, 2),
        'proxy_bytes': sum(f.stat().st_size for f in (service.home / 'proxies').glob('*.mp4')) if (service.home / 'proxies').is_dir() else 0,
        'note': 'proxies_done_s includes the frames rendered meanwhile for b' if frames_during else None,
    }
    project = project_now or service.rpc('project.get')
    duration = max(c['start'] + c['duration'] for c in project['clips'])
    if 'b' in only:
        times = distinct_times(duration, 26, 7)[:20]
        block = {'times': times, 'while_proxies_build_width_640': frames_during}
        for width in (640, 1280):
            # `proxy: false` asks for the originals; a service that knows no proxies
            # for frames ignores it and both rows measure the same thing. The frame
            # after each time is taken so that such a service's cache cannot answer.
            block[f'width_{width}_proxy'] = frames(service, times, width)
            block[f'width_{width}_original'] = frames(service, [t + 1 / 30 for t in times], width, {'proxy': False})
        results['b_frames_uhd'] = block
    if 'd' in only:
        end = min(60.0, duration) if not quick else min(3.0, duration)
        block = {}
        for label, hardware in (('hardware', True), ('software', False)):
            block[label] = export(service, {'path': str(service.home / 'exports' / f'uhd-{label}.mp4'), 'format': 'mp4',
                                            'start': 0, 'end': end, 'hardware': hardware})
        results['d_export_uhd_60s'] = block


def scenario_timeline(service, media, results, only, quick):
    """c and the timeline part of d."""
    count = 50 if quick else 500
    project = service.rpc('project.new', {'name': '벤치 500클립', 'width': 1920, 'height': 1080, 'fps': 30})
    seconds, project, size = service.timed('media.importAndAdd', {
        'paths': [media['hd-h264-30.mp4']['path']], 'expectedRevision': project['revision']})
    block = {'import_to_project_ms': round(seconds * 1000, 1)}
    # The waveform arrives in the background; the edits are measured after it.
    waited, _ = wait_until(lambda: all(m.get('waveform') for m in service.rpc('project.get')['media']), 600)
    block['waveform_done_s'] = None if waited is None else round(waited, 2)
    clip = next(c for c in project['clips'] if c['kind'] == 'video')
    track = clip['trackId']
    splits = []
    for second in range(1, count):
        known = {c['id'] for c in project['clips']}
        seconds, project, size = service.timed('edit.split', {'id': clip['id'], 'time': float(second), 'expectedRevision': project['revision']})
        splits.append(seconds)
        clip = next(c for c in project['clips'] if c['id'] not in known)
    project = service.rpc('edit.trim', {'id': clip['id'], 'end': float(count), 'expectedRevision': project['revision']})
    block['split_first_50'] = summary(splits[:50])
    block['split_last_50'] = summary(splits[-50:])
    block['split_total_s'] = round(sum(splits), 2)
    video = sorted((c for c in project['clips'] if c['trackId'] == track), key=lambda c: c['start'])
    assert len(video) == count, len(video)
    kinds = ['fade', 'dissolve', 'wipeLeft', 'slideLeft', 'zoom']
    commands = [{'method': 'edit.update', 'params': {'id': c['id'], 'patch': {
        'transitionIn': {'type': kinds[(i // 10) % len(kinds)], 'duration': 0.3}}}} for i, c in enumerate(video) if i % 10 == 5]
    seconds, project, _ = service.timed('edit.batch', {'commands': commands, 'expectedRevision': project['revision']})
    block['batch_transitions'] = {'commands': len(commands), 'ms': round(seconds * 1000, 1)}
    texts = count // 10
    commands = [{'method': 'edit.add', 'params': {'text': f'자막 {i + 1}', 'start': i * 10 + 2.0, 'duration': 3.0}} for i in range(texts)]
    seconds, project, _ = service.timed('edit.batch', {'commands': commands, 'expectedRevision': project['revision']})
    block['batch_texts'] = {'commands': len(commands), 'ms': round(seconds * 1000, 1)}
    block['clips'] = len(project['clips'])
    block['project_file_bytes'] = (service.home / 'current.json').stat().st_size

    rng = random.Random(3)
    took, size = [], 0
    for c in rng.sample(video, 20):
        seconds, project, size = service.timed('edit.update', {'id': c['id'], 'patch': {'filter': 'warm'}, 'expectedRevision': project['revision']})
        took.append(seconds)
    block['edit_update'] = dict(summary(took), response_bytes=size)
    shift, undo, redo = [], [], []
    for i in range(10):
        seconds, project, _ = service.timed('edit.shift', {'trackId': track, 'from': count / 2, 'delta': 0.1, 'expectedRevision': project['revision']})
        shift.append(seconds)
        seconds, project, _ = service.timed('history.undo')
        undo.append(seconds)
        seconds, project, _ = service.timed('history.redo')
        redo.append(seconds)
        seconds, project, _ = service.timed('history.undo')
        undo.append(seconds)
    block['edit_shift'], block['history_undo'], block['history_redo'] = summary(shift), summary(undo), summary(redo)
    took = []
    # The first conditional read after derived media state changed is a full one.
    service.rpc('project.get', {'ifProjectId': project['id'], 'ifRevision': project['revision']})
    for _ in range(50):
        seconds, reply, size = service.timed('project.get', {'ifProjectId': project['id'], 'ifRevision': project['revision']})
        assert reply.get('unchanged') is True, reply
        took.append(seconds)
    block['project_get_unchanged'] = dict(summary(took), response_bytes=size)
    took = []
    for _ in range(20):
        seconds, _, size = service.timed('project.get')
        took.append(seconds)
    block['project_get_full'] = dict(summary(took), response_bytes=size)
    if 'c' in only:
        times = distinct_times(count, 20, 5)
        block['frames_width_640'] = frames(service, times, 640)
        block['frames_width_1280'] = frames(service, times, 1280)
        # The same frames again: what a request costs before any rendering.
        took = []
        for at in times:
            seconds, result, _ = service.timed('preview.frame', {'time': at, 'width': 1280, 'client': 'bench'})
            assert result.get('cacheHit') is True, result
            took.append(seconds)
        block['frames_cached'] = summary(took)
        results['c_timeline'] = block
    if 'd' in only:
        start, end = (10.0, 13.0) if quick else (120.0, 180.0)
        exports = {}
        for label, hardware in (('hardware', True), ('software', False)):
            exports[label] = export(service, {'path': str(service.home / 'exports' / f'timeline-{label}.mp4'), 'format': 'mp4',
                                              'start': start, 'end': end, 'hardware': hardware})
        results['d_export_timeline_60s'] = exports
        # Every clip in one export: hundreds of inputs must not exhaust the machine.
        results['d_export_timeline_all_clips'] = export(service, {
            'path': str(service.home / 'exports' / 'timeline-all.mp4'), 'format': 'mp4', 'start': 0, 'end': float(count)})


def rows(results):
    """Flattens the results into (name, value) lines for the table."""
    out = []

    def walk(prefix, value):
        if isinstance(value, dict):
            if 'median_ms' in value:
                text = f"median {value['median_ms']} ms, p95 {value['p95_ms']} ms (n={value['n']})"
                for key in ('response_bytes', 'frames_from_proxies'):
                    if key in value:
                        text += f', {key}={value[key]}'
                out.append((prefix, text))
            elif 'state' in value and 'seconds' in value:
                text = f"{value['state']} in {value['seconds']} s"
                for key in ('encoder', 'realtime_factor', 'video_frames', 'ffmpeg_peak_rss_mb'):
                    if value.get(key) is not None:
                        text += f', {key}={value[key]}'
                out.append((prefix, text))
            else:
                for key, inner in value.items():
                    walk(f'{prefix}.{key}' if prefix else key, inner)
        elif isinstance(value, list):
            return
        elif value is not None:
            out.append((prefix, str(value)))
    walk('', results)
    return out


def table(results, baseline=None):
    now = rows(results)
    before = dict(rows(baseline)) if baseline else {}
    width = max(len(name) for name, _ in now)
    for name, value in now:
        line = f'{name.ljust(width)}  {value}'
        if name in before and before[name] != value:
            line += f'   [before: {before[name]}]'
        print(line)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--out', help='write the results as JSON to this file')
    parser.add_argument('--binary', default=str(DEFAULT_BINARY))
    parser.add_argument('--media-dir', help='keep the synthetic media here between runs')
    parser.add_argument('--baseline', help='results of an earlier run, shown beside the new ones')
    parser.add_argument('--only', default='a,b,c,d', help='scenarios to run, of a,b,c,d')
    parser.add_argument('--label', default='')
    parser.add_argument('--quick', action='store_true')
    args = parser.parse_args()
    binary = Path(args.binary)
    if not binary.is_file():
        raise SystemExit(f'studio-service 바이너리가 없습니다: {binary}\n'
                         'cargo build --release --manifest-path src-tauri/Cargo.toml --bin studio-service')
    for tool in ('ffmpeg', 'ffprobe'):
        if not shutil.which(tool):
            raise SystemExit(f'{tool}를 찾을 수 없습니다')
    only = set(args.only.split(','))
    temporary = None if args.media_dir else Path(tempfile.mkdtemp(prefix='byori-bench-media-'))
    folder = Path(args.media_dir) if args.media_dir else temporary
    if args.quick:
        folder = folder / 'quick'
    service = None
    results = {'label': args.label, 'quick': args.quick, 'machine': {
        'platform': platform.platform(), 'cpu': platform.processor(), 'cores': os.cpu_count(),
        'ffmpeg': subprocess.run(['ffmpeg', '-version'], capture_output=True, text=True).stdout.split('\n')[0]},
        'binary_built': time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(binary.stat().st_mtime))}
    try:
        print('making media…', flush=True)
        media = make_media(folder, args.quick)
        results['media'] = {name: {k: v for k, v in item.items() if k != 'path'} for name, item in media.items()}
        service = Service(binary).start()
        memory = service.memory = Memory(service.process.pid)
        memory.start()
        if only & {'a', 'b'} or 'd' in only:
            print('4K project…', flush=True)
            scenario_uhd(service, media, results, only, args.quick)
        if only & {'c', 'd'}:
            print('500-clip timeline…', flush=True)
            scenario_timeline(service, media, results, only, args.quick)
        memory.done.set()
        memory.join()
        results['e_memory'] = {'service_peak_rss_mb': round(memory.service_kb / 1024, 1),
                               'children_peak_rss_mb': round(memory.children_kb / 1024, 1)}
    finally:
        if service:
            service.close()
        if temporary:
            shutil.rmtree(temporary, ignore_errors=True)
    baseline = json.loads(Path(args.baseline).read_text()) if args.baseline else None
    if baseline:
        results['baseline'] = {k: v for k, v in baseline.items() if k != 'baseline'}
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps(results, ensure_ascii=False, indent=2))
    print()
    table({k: v for k, v in results.items() if k != 'baseline'}, baseline)
    return 0


if __name__ == '__main__':
    sys.exit(main())
