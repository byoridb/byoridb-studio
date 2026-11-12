"""End-to-end checks against the real studio-service binary.

Every test starts its own service on a free loopback port with a temporary
BYORI_STUDIO_HOME, so the user's ~/.byori-studio and port 43123 are never touched.

Build the binary first:
    cargo build --manifest-path src-tauri/Cargo.toml --bin studio-service
Without a current binary the tests are skipped (and say so); `npm run test:integration`
and `npm run verify` build it and set BYORI_STUDIO_REQUIRE_INTEGRATION=1, which turns
a missing or outdated binary into a failure instead.
"""
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

REPO = Path(__file__).resolve().parent.parent
BINARY = Path(os.environ.get('BYORI_STUDIO_SERVICE_BIN') or REPO / 'src-tauri/target/debug/studio-service')
REQUIRED = os.environ.get('BYORI_STUDIO_REQUIRE_INTEGRATION') == '1'
USER_PORT = 43123


def binary_sources(repo=REPO):
    """Files studio-service is built from. main.rs is the native shell's own binary:
    editing it does not relink studio-service, so it must not make it look outdated."""
    source = repo / 'src-tauri/src'
    return ([p for p in source.rglob('*.rs') if p != source / 'main.rs']
            + [repo / 'scripts/studio-tools.json', repo / 'scripts/studio-mcp.py'])


def unavailable():
    """Why the integration tests cannot run here, or None."""
    if not BINARY.is_file():
        return f'studio-service 바이너리가 없습니다: {BINARY}'
    if 'BYORI_STUDIO_SERVICE_BIN' not in os.environ:
        built = BINARY.stat().st_mtime
        newer = [p.name for p in binary_sources() if p.stat().st_mtime > built]
        if newer:
            return f'studio-service 바이너리가 소스보다 오래되었습니다 ({", ".join(sorted(newer)[:4])})'
    for tool in ('ffmpeg', 'ffprobe'):
        if not shutil.which(tool):
            return f'{tool}를 찾을 수 없습니다'
    return None


REASON = unavailable()
if REASON:
    REASON = ('통합 테스트를 건너뜁니다: ' + REASON
              + '. `cargo build --manifest-path src-tauri/Cargo.toml --bin studio-service` 후 다시 실행하세요.')
    print(REASON, file=sys.stderr, flush=True)


def free_port():
    while True:
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0))
            port = s.getsockname()[1]
        if port != USER_PORT:
            return port


class Service:
    """One isolated studio-service process."""

    def __init__(self, home=None, path_prefix=None):
        self.home = Path(home or tempfile.mkdtemp(prefix='byori-integration-'))
        self.port = free_port()
        self.dev_port = free_port()
        self.env = dict(os.environ, BYORI_STUDIO_HOME=str(self.home), BYORI_STUDIO_PORT=str(self.port),
                        BYORI_STUDIO_DEV_PORT=str(self.dev_port),
                        BYORI_STUDIO_DEMO_DIR=str(REPO / 'public/demo'))
        if path_prefix:
            self.env['PATH'] = f'{path_prefix}{os.pathsep}{self.env.get("PATH", "")}'
        self.process = None
        self.connection = None
        # Where the service runs. A test that sends it relative paths sets this to
        # a temporary folder so that nothing lands in the repository.
        self.cwd = None

    @property
    def origin(self):
        return f'http://localhost:{self.dev_port}'

    def start(self):
        self.log = open(self.home / 'service.log', 'ab')
        self.process = subprocess.Popen([str(BINARY)], env=self.env, stdout=self.log, stderr=subprocess.STDOUT,
                                        cwd=self.cwd)
        file = self.home / 'connection.json'
        for _ in range(200):
            if file.exists():
                try:
                    self.connection = json.loads(file.read_text())
                    break
                except ValueError:
                    pass
            if self.process.poll() is not None:
                raise AssertionError('service exited: ' + self.output())
            time.sleep(0.05)
        else:
            raise AssertionError('service did not start: ' + self.output())
        assert self.connection['url'] == f'http://127.0.0.1:{self.port}', self.connection['url']
        return self

    def output(self):
        return self.output_all()[-4000:]

    def output_all(self):
        """Everything the service has written to stdout and stderr since the first start."""
        self.log.flush()
        return (self.home / 'service.log').read_text(errors='replace')

    def stop(self):
        if self.process and self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            try:
                self.process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        if self.process:
            self.log.close()

    def kill(self):
        """Ends the process as a crash or a forced quit would: no shutdown code runs."""
        self.process.kill()
        self.process.wait()
        self.log.close()
        # A killed service leaves its connection file; the next start must write its own.
        (self.home / 'connection.json').unlink()

    def close(self):
        self.stop()
        shutil.rmtree(self.home, ignore_errors=True)

    def request(self, path, data=None, token=True, headers=None, method=None):
        """Returns (status, headers, body bytes)."""
        headers = dict(headers or {})
        if token is True:
            token = self.connection['token']
        if token:
            headers.setdefault('Authorization', 'Bearer ' + token)
        request = Request(self.connection['url'] + path, data=data, headers=headers,
                          method=method or ('POST' if data is not None else 'GET'))
        try:
            with urlopen(request, timeout=180) as response:
                return response.status, response.headers, response.read()
        except HTTPError as error:
            return error.code, error.headers, error.read()

    def call(self, method, params=None, **options):
        """Returns (status, result-or-error)."""
        body = {'method': method, 'params': params or {}}
        if 'project' in options:
            body['projectId'] = options.pop('project')
        headers = dict(options.pop('headers', {}), **{'Content-Type': 'application/json'})
        status, _, raw = self.request('/rpc', json.dumps(body).encode(), headers=headers, **options)
        value = json.loads(raw) if raw else {}
        return status, value.get('result', value.get('error'))

    def rpc(self, method, params=None):
        status, value = self.call(method, params)
        assert status == 200, (method, status, value)
        return value

    def error(self, method, params=None):
        status, value = self.call(method, params)
        assert status != 200 and isinstance(value, str), (method, status, value)
        return value


def make_video(path, seconds=2, size='320x180'):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', f'testsrc=size={size}:rate=30:duration={seconds}',
                    '-f', 'lavfi', '-i', f'sine=frequency=440:duration={seconds}', '-c:v', 'libx264', '-preset', 'ultrafast',
                    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', str(path)], check=True)


def duration_of(path):
    return float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(path)]).strip())


def wait_for(check, seconds=60, interval=0.2):
    deadline = time.time() + seconds
    while True:
        value = check()
        if value:
            return value
        if time.time() > deadline:
            raise AssertionError('timed out waiting')
        time.sleep(interval)


@unittest.skipIf(REASON and not REQUIRED, REASON)
class IntegrationTests(unittest.TestCase):
    def setUp(self):
        if REASON:
            self.fail(REASON)
        self.assertNotEqual(os.environ.get('BYORI_STUDIO_PORT'), str(USER_PORT))
        self.service = Service().start()
        self.addCleanup(self.service.close)
        self.media = Path(tempfile.mkdtemp(prefix='byori-integration-media-'))
        self.addCleanup(shutil.rmtree, self.media, True)

    def export(self, service, params):
        job = service.rpc('export.start', params)
        state = wait_for(lambda: (lambda s: s if s['state'] in ('completed', 'failed', 'cancelled') else None)(
            service.rpc('export.status', {'id': job['id']})), 180)
        self.assertEqual(state['state'], 'completed', state)
        return state

    def test_project_lifecycle_and_conditional_get(self):
        s = self.service
        health = json.loads(s.request('/health', token=False)[2])
        self.assertEqual((health['service'], health['host']), ('byori-studio', 'service'))
        package = json.loads((REPO / 'package.json').read_text())
        self.assertEqual(health['version'], package['version'])

        first = s.rpc('project.new', {'name': '세로 영상', 'width': 1080, 'height': 1920})
        self.assertEqual((first['name'], first['width'], first['height']), ('세로 영상', 1080, 1920))
        self.assertGreaterEqual(first['schemaVersion'], 2)
        unchanged = s.rpc('project.get', {'ifProjectId': first['id'], 'ifRevision': first['revision']})
        self.assertEqual(unchanged, {'unchanged': True, 'id': first['id'], 'revision': first['revision'], 'missing': []})
        stale = s.rpc('project.get', {'ifProjectId': first['id'], 'ifRevision': first['revision'] + 1})
        self.assertEqual(stale['id'], first['id'])
        self.assertIn('tracks', stale)

        copy = s.rpc('project.duplicate', {'id': first['id']})
        self.assertNotEqual(copy['id'], first['id'])
        listed = s.rpc('project.rename', {'id': copy['id'], 'name': '사본 이름'})
        self.assertEqual({p['id']: p['name'] for p in listed}[copy['id']], '사본 이름')
        self.assertIn('열려 있는', s.error('project.delete', {'id': first['id']}))
        opened = s.rpc('project.open', {'id': copy['id']})
        self.assertEqual((opened['id'], opened['name']), (copy['id'], '사본 이름'))
        remaining = s.rpc('project.delete', {'id': first['id']})
        self.assertNotIn(first['id'], [p['id'] for p in remaining])
        self.assertFalse((s.home / 'projects' / f"{first['id']}.json").exists())

        # The open project survives a restart; the connection file does not outlive the service.
        s.stop()
        self.assertFalse((s.home / 'connection.json').exists())
        s.start()
        self.assertEqual(s.rpc('project.get')['id'], copy['id'])

    def test_edit_undo_and_short_export(self):
        s = self.service
        source = self.media / 'clip.mp4'
        make_video(source)
        project = s.rpc('project.new', {'name': '편집'})
        project = s.rpc('media.importAndAdd', {'paths': [str(source)], 'expectedRevision': project['revision']})
        self.assertEqual(len(project['media']), 1)
        clip = next(c for c in project['clips'] if c['kind'] == 'video')
        before = project['revision']
        project = s.rpc('edit.split', {'id': clip['id'], 'time': 1.0, 'expectedRevision': before})
        count = len(project['clips'])
        self.assertGreater(count, 1)
        self.assertIn('REVISION_CONFLICT', s.error('edit.update', {'id': clip['id'], 'patch': {'filter': 'warm'}, 'expectedRevision': before}))
        project = s.rpc('edit.update', {'id': clip['id'], 'patch': {'filter': 'warm'}, 'expectedRevision': project['revision']})
        self.assertEqual(next(c for c in project['clips'] if c['id'] == clip['id'])['filter'], 'warm')
        project = s.rpc('edit.batch', {'expectedRevision': project['revision'], 'commands': [
            {'method': 'edit.marker', 'params': {'time': 0.5, 'label': '하나'}},
            {'method': 'edit.marker', 'params': {'time': 1.5, 'label': '둘'}}]})
        self.assertEqual(len(project['markers']), 2)
        project = s.rpc('history.undo')
        self.assertEqual(project['markers'], [], 'a batch is one undo step')
        project = s.rpc('history.undo')
        self.assertNotEqual(next(c for c in project['clips'] if c['id'] == clip['id']).get('filter'), 'warm')
        project = s.rpc('history.redo')
        self.assertEqual(next(c for c in project['clips'] if c['id'] == clip['id'])['filter'], 'warm')
        self.assertEqual(len(project['clips']), count)
        self.assertEqual(s.rpc('history.status'), {'canUndo': True, 'canRedo': True})

        output = s.home / 'exports' / 'short.mp4'
        params = {'path': str(output), 'format': 'mp4', 'start': 0, 'end': 1.0, 'width': 320, 'height': 180}
        self.export(s, params)
        self.assertTrue(0.9 <= duration_of(output) <= 1.2)
        self.assertEqual([f.name for f in output.parent.iterdir()], ['short.mp4'], 'no partial files are left')
        self.assertIn('FILE_EXISTS', s.error('export.start', params))
        self.export(s, dict(params, overwrite=True, end=0.5))
        self.assertLess(duration_of(output), 0.8)
        # The user's source file is never an output.
        self.assertTrue(s.error('export.start', {'path': str(source), 'format': 'mp4', 'overwrite': True}))
        self.assertTrue(0 < duration_of(source))

    def test_corrupt_autosave_is_kept_and_a_stored_project_recovered(self):
        s = self.service
        project = s.rpc('project.new', {'name': '복구 대상'})
        s.rpc('edit.marker', {'time': 1, 'label': '표시'})
        s.stop()
        (s.home / 'current.json').write_text('{ not json')
        s.start()
        notice = s.rpc('project.notice')['notice']
        self.assertIn('복구', notice)
        kept = [f.name for f in s.home.iterdir() if f.name.startswith('current.json.corrupt-')]
        self.assertEqual(len(kept), 1)
        self.assertEqual((s.home / kept[0]).read_text(), '{ not json')
        recovered = s.rpc('project.get')
        self.assertEqual((recovered['id'], recovered['markers'][0]['label']), (project['id'], '표시'))
        self.assertEqual(s.rpc('project.noticeDismiss'), {'notice': None})
        self.assertEqual(s.rpc('project.notice'), {'notice': None})

    def test_requests_need_the_token_and_an_allowed_origin(self):
        s = self.service
        self.assertEqual(s.call('project.get', token=False)[0], 401)
        self.assertEqual(s.call('project.get', token='wrong')[0], 401)
        self.assertEqual(s.call('project.get', headers={'Origin': 'https://example.com'})[0], 401)
        self.assertEqual(s.call('project.get', headers={'Origin': s.origin})[0], 200)
        # The browser UI fetches its token only from the dev origin.
        self.assertEqual(s.request('/session', token=False)[0], 401)
        self.assertEqual(s.request('/session', token=False, headers={'Origin': 'http://localhost:1'})[0], 401)
        status, _, body = s.request('/session', token=False, headers={'Origin': s.origin})
        self.assertEqual((status, json.loads(body)), (200, s.connection))
        if os.name == 'posix':
            self.assertEqual(stat.S_IMODE((s.home / 'connection.json').stat().st_mode), 0o600)
        self.assertEqual(s.request('/upload?name=a.srt', b'x')[0], 400)
        self.assertEqual(s.request('/upload?name=a.srt&projectId=other', b'x')[0], 409)
        self.assertEqual(s.request('/assets/unknown')[0], 404)
        self.assertEqual(s.request('/assets/unknown', token=False)[0], 401)

    def test_upload_and_ranged_asset_delivery(self):
        s = self.service
        source = self.media / 'upload.mp4'
        make_video(source, seconds=1)
        project = s.rpc('project.new', {'name': '업로드'})
        status, _, body = s.request(f"/upload?name=upload.mp4&projectId={project['id']}", source.read_bytes())
        self.assertEqual(status, 200, body)
        asset = json.loads(body)['result']['media'][0]
        stored = Path(asset['path'])
        self.assertEqual(stored.parent, (s.home / 'imports').resolve())
        self.assertEqual(source.read_bytes(), stored.read_bytes())
        # The library shows the name the file came with, not the stored `<uuid>-name`.
        self.assertEqual(asset['name'], 'upload.mp4')
        self.assertNotEqual(stored.name, 'upload.mp4')
        token = s.connection['token']
        status, headers, part = s.request(f"/assets/{asset['id']}?token={token}", token=False, headers={'Range': 'bytes=0-99'})
        self.assertEqual((status, len(part)), (206, 100))
        self.assertEqual(part, source.read_bytes()[:100])
        self.assertTrue(headers['Content-Range'].startswith('bytes 0-99/'))
        status, headers, image = s.request(f"/assets/{asset['id']}/thumbnail")
        self.assertEqual(status, 200)
        self.assertEqual(image[:2], b'\xff\xd8')
        self.assertEqual(s.request(f"/assets/{asset['id']}?token=wrong", token=False)[0], 401)

    def test_import_returns_first_and_waveform_and_proxy_follow_without_a_revision(self):
        s = self.service
        large = self.media / 'large.mp4'
        make_video(large, seconds=1, size='1924x64')
        untouched = large.read_bytes()
        project = s.rpc('project.new', {'name': '프록시'})
        project = s.rpc('media.importAndAdd', {'paths': [str(large)], 'expectedRevision': project['revision']})
        asset = project['media'][0]
        self.assertEqual(s.request(f"/assets/{asset['id']}/proxy" if asset.get('proxy') else '/assets/none/proxy')[0],
                         200 if asset.get('proxy') else 404)

        def ready():
            current = s.rpc('project.get')['media'][0]
            return current if current.get('proxy') and isinstance(current.get('waveform'), list) else None
        asset = wait_for(ready, 60)
        self.assertGreater(max(asset['waveform']), 0)
        after = s.rpc('project.get')
        self.assertEqual(after['revision'], project['revision'], 'background results are not edits')
        # A polling client is told once, then sees the project as unchanged again.
        condition = {'ifProjectId': after['id'], 'ifRevision': after['revision']}
        wait_for(lambda: s.rpc('project.get', condition).get('unchanged'), 10)
        self.assertEqual(s.rpc('project.get', condition)['proxy'], [asset['id']])
        status, headers, part = s.request(f"/assets/{asset['id']}/proxy", headers={'Range': 'bytes=0-63'})
        self.assertEqual((status, len(part)), (206, 64))
        proxy = s.home / 'proxies' / f"{asset['id']}.mp4"
        size = subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,codec_name',
                                        '-of', 'csv=p=0', str(proxy)], text=True).strip()
        self.assertEqual(size, 'h264,1280')
        self.assertEqual(large.read_bytes(), untouched)
        # One undo removes the import; the proxy of media no project mentions goes at the next start.
        project = s.rpc('history.undo')
        self.assertEqual(project['media'], [])
        s.stop()
        self.assertEqual([f.name for f in (s.home / 'proxies').iterdir() if 'partial' in f.name], [])
        s.start()
        self.assertFalse(proxy.exists())

    def frame_pixel(self, path, x, y):
        """The RGB of one pixel of a picture or of a video's first frame."""
        raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(path), '-frames:v', '1', '-vf', f'format=rgb24,crop=1:1:{x}:{y}',
                                       '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])
        return tuple(raw[:3])

    def test_transition_reaches_the_preview_frame_and_the_export(self):
        s = self.service
        source = self.media / 'wipe.mp4'
        make_video(source, seconds=2)
        project = s.rpc('project.new', {'name': '전환', 'width': 640, 'height': 360})
        project = s.rpc('project.update', {'patch': {'background': '#0000ff'}, 'expectedRevision': project['revision']})
        project = s.rpc('media.importAndAdd', {'paths': [str(source)], 'expectedRevision': project['revision']})
        clip = next(c for c in project['clips'] if c['kind'] == 'video')
        project = s.rpc('edit.update', {'id': clip['id'], 'expectedRevision': project['revision'],
                                        'patch': {'transitionIn': {'type': 'wipeRight', 'duration': 1.0}}})
        self.assertEqual(next(c for c in project['clips'] if c['id'] == clip['id'])['transitionIn'],
                         {'type': 'wipeRight', 'duration': 1.0})
        self.assertIn('REVISION_CONFLICT', s.error('edit.update', {
            'id': clip['id'], 'patch': {'transitionIn': None}, 'expectedRevision': project['revision'] - 1}))

        # Half way through the wipe the left half shows the clip, the right half the
        # blue background. The frame is narrower than the project: like the export it
        # is composed at the project size, then resized.
        def blue(pixel):
            return pixel[2] > 180 and pixel[0] < 70 and pixel[1] < 70
        frame = s.rpc('preview.frame', {'time': 0.5, 'width': 320, 'expectedRevision': project['revision']})
        self.assertEqual((frame['width'], frame['height'], frame['revision']), (320, 180, project['revision']))
        self.assertFalse(blue(self.frame_pixel(frame['path'], 60, 90)), 'the revealed part shows the clip')
        self.assertTrue(blue(self.frame_pixel(frame['path'], 260, 90)), 'the part not yet revealed shows the background')
        status, headers, image = s.request(f"/assets/{frame['assetId']}")
        self.assertEqual((status, image[:4]), (200, b'\x89PNG'))
        later = s.rpc('preview.frame', {'time': 1.5, 'width': 320})
        self.assertFalse(blue(self.frame_pixel(later['path'], 260, 90)), 'after the wipe the clip fills the frame')

        output = s.home / 'exports' / 'wipe.mp4'
        self.export(s, {'path': str(output), 'format': 'mp4', 'start': 0.5, 'end': 1.0, 'hardware': False})
        self.assertFalse(blue(self.frame_pixel(output, 120, 180)))
        self.assertTrue(blue(self.frame_pixel(output, 520, 180)))

    def test_freeze_inserts_a_still_that_is_one_undo_and_exports(self):
        s = self.service
        source = self.media / 'freeze.mp4'
        make_video(source, seconds=2)
        untouched = source.read_bytes()
        project = s.rpc('project.new', {'name': '정지 프레임'})
        project = s.rpc('media.importAndAdd', {'paths': [str(source)], 'expectedRevision': project['revision']})
        clip = next(c for c in project['clips'] if c['kind'] == 'video')
        before = project['revision']
        self.assertIn('REVISION_CONFLICT', s.error('edit.freeze', {'id': clip['id'], 'time': 1.0, 'expectedRevision': before - 1}))
        frozen = s.rpc('edit.freeze', {'id': clip['id'], 'time': 1.0, 'duration': 0.5, 'expectedRevision': before})
        self.assertEqual(frozen['revision'], before + 1)
        track = sorted((c for c in frozen['clips'] if c['trackId'] == clip['trackId']), key=lambda c: c['start'])
        self.assertEqual([c['kind'] for c in track], ['video', 'image', 'video'])
        self.assertEqual([round(c['start'], 3) for c in track], [0, 1.0, 1.5])
        self.assertEqual([round(c['duration'], 3) for c in track], [1.0, 0.5, 1.0])
        still = next(m for m in frozen['media'] if m['id'] == track[1]['mediaId'])
        picture = Path(still['path'])
        self.assertEqual(picture.parent, (s.home / 'projects' / f"{frozen['id']}-assets" / 'frames').resolve())
        self.assertEqual(picture.read_bytes()[:4], b'\x89PNG')
        self.assertEqual(source.read_bytes(), untouched, 'the source is only read')

        # The still holds the frame at the cut for its whole length.
        first = s.rpc('preview.frame', {'time': 1.05, 'width': 320})
        last = s.rpc('preview.frame', {'time': 1.45, 'width': 320})
        self.assertEqual(self.frame_pixel(first['path'], 160, 90), self.frame_pixel(last['path'], 160, 90))
        output = s.home / 'exports' / 'freeze.mp4'
        self.export(s, {'path': str(output), 'format': 'mp4', 'width': 320, 'height': 180, 'hardware': False})
        self.assertTrue(2.4 <= duration_of(output) <= 2.7, duration_of(output))

        undone = s.rpc('history.undo')
        self.assertEqual([c['id'] for c in undone['clips'] if c['kind'] == 'video'], [clip['id']])
        self.assertEqual([m['kind'] for m in undone['media']], ['video'], 'the split and the still are one undo step')
        self.assertEqual(s.rpc('history.redo')['clips'], frozen['clips'])

    def test_storage_report_and_cleanup_leave_user_media_and_agents_out(self):
        s = self.service
        source = self.media / 'stored.mp4'
        make_video(source, seconds=1)
        project = s.rpc('project.new', {'name': '저장 공간'})
        status, _, body = s.request(f"/upload?name=stored.mp4&projectId={project['id']}", source.read_bytes())
        self.assertEqual(status, 200, body)
        uploaded = Path(json.loads(body)['result']['media'][0]['path'])
        frame_project = s.rpc('edit.add', {'text': {'content': '저장 공간'}, 'start': 0, 'duration': 1})
        frame = s.rpc('preview.frame', {'time': 0.5, 'width': 320, 'expectedRevision': frame_project['revision']})
        for folder in ('proxies', 'renders', 'previews', 'speech/job'):
            (s.home / folder).mkdir(parents=True, exist_ok=True)
        orphans = [s.home / 'proxies/media-gone.mp4', s.home / 'proxies/media-gone.source',
                   s.home / 'previews/preview-left.png', s.home / 'renders/export-left']
        for path in orphans[:3]:
            path.write_bytes(b'x' * 1000)
        orphans[3].mkdir()
        (orphans[3] / 'filters.ffgraph').write_bytes(b'x' * 1000)
        voice = s.home / 'speech/job/voice.aiff'
        voice.write_bytes(b'x' * 500)

        usage = s.rpc('storage.usage')
        self.assertEqual(set(usage['folders']), {'proxies', 'imports', 'speech', 'renders', 'previews'})
        self.assertEqual(usage['folders']['imports']['bytes'], uploaded.stat().st_size)
        self.assertEqual(usage['folders']['speech'], {'files': 1, 'bytes': 500, 'cleanable': False})
        self.assertEqual(usage['reclaimableBytes'], 4000)
        self.assertEqual(usage['bytes'], sum(folder['bytes'] for folder in usage['folders'].values()))
        self.assertTrue(all(path.exists() for path in orphans))

        cleaned = s.rpc('storage.clean')
        self.assertEqual(cleaned['removedBytes'], 4000)
        self.assertFalse(any(path.exists() for path in orphans))
        self.assertTrue(uploaded.is_file() and voice.is_file() and Path(frame['path']).is_file())
        self.assertEqual(s.rpc('storage.usage')['reclaimableBytes'], 0)
        # Not part of the agent tools, so no agent token can reach them.
        tools = json.loads((REPO / 'scripts/studio-tools.json').read_text())
        allowed = {method for tool in tools['tools'] for method in tool.get('methods', [])}
        self.assertFalse({'storage.usage', 'storage.clean', 'storage.configure'} & allowed)
        self.assertEqual(s.call('storage.clean', token='wrong')[0], 401)

    def test_open_project_gets_its_proxies_over_the_limit_and_the_usage_says_so(self):
        s = self.service
        sources = [self.media / 'large-a.mp4', self.media / 'large-b.mp4']
        for source in sources:
            make_video(source, seconds=1, size='2560x1440')
        project = s.rpc('project.new', {'name': '프록시 한도'})
        project = s.rpc('media.import', {'paths': [str(sources[0])], 'expectedRevision': project['revision']})
        first = project['media'][0]['id']

        def ready(count):
            media = s.rpc('project.get', {'omitWaveforms': True})['media']
            return len([item for item in media if item.get('proxy') is True]) == count

        wait_for(lambda: ready(1), 120)
        proxy = s.home / 'proxies' / f'{first}.mp4'
        self.assertTrue(proxy.is_file())
        usage = s.rpc('storage.usage')
        self.assertFalse(usage['proxyOverLimit'])
        self.assertGreaterEqual(usage['proxyBytes'], proxy.stat().st_size)
        self.assertEqual(usage['proxyOpenProjectBytes'], usage['proxyBytes'])
        self.assertEqual(usage['proxyBytes'], usage['folders']['proxies']['bytes'])

        # A limit the open project alone exceeds: nothing of it is removed, and it is reported.
        self.assertEqual(s.rpc('storage.configure', {'proxyLimitBytes': 1})['proxyLimitBytes'], 1)
        usage = s.rpc('storage.usage')
        self.assertTrue(usage['proxyOverLimit'])
        self.assertEqual(usage['proxyLimitBytes'], 1)
        self.assertTrue(proxy.is_file())
        # A new source of the open project still gets its proxy.
        project = s.rpc('media.import', {'paths': [str(sources[1])],
                                         'expectedRevision': s.rpc('project.get')['revision']})
        wait_for(lambda: ready(2), 120)
        second = next(item['id'] for item in project['media'] if item['id'] != first)
        self.assertTrue(proxy.is_file() and (s.home / 'proxies' / f'{second}.mp4').is_file())
        more = s.rpc('storage.usage')
        self.assertTrue(more['proxyOverLimit'])
        self.assertGreater(more['proxyBytes'], usage['proxyBytes'])
        self.assertEqual(more['proxyOpenProjectBytes'], more['proxyBytes'])
        self.assertEqual(s.rpc('storage.clean')['removedBytes'], 0, 'cleaning leaves the open project its proxies')
        # No limit: never over it.
        s.rpc('storage.configure', {'proxyLimitBytes': 0})
        self.assertFalse(s.rpc('storage.usage')['proxyOverLimit'])

    def test_upload_reply_names_the_waveforms_when_asked(self):
        s = self.service
        tone = self.media / 'tone.wav'
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', str(tone)],
                       check=True)
        project = s.rpc('project.new', {'name': '업로드'})
        s.rpc('media.import', {'paths': [str(tone)], 'expectedRevision': project['revision']})
        wait_for(lambda: s.rpc('project.get', {'omitWaveforms': True})['media'][0].get('waveformId'), 60)
        srt = '1\n00:00:00,000 --> 00:00:01,000\n자막\n'.encode()
        base = f"/upload?name=lines.srt&projectId={project['id']}"
        status, _, body = s.request(base + '&omitWaveforms=true', srt)
        self.assertEqual(status, 200, body)
        slim = json.loads(body)['result']['media'][0]
        self.assertNotIn('waveform', slim)
        self.assertGreater(slim['waveformPeaks'], 0)
        self.assertTrue(slim['waveformId'])
        status, _, full_body = s.request(base, srt)
        self.assertEqual(status, 200, full_body)
        full = json.loads(full_body)['result']['media'][0]
        self.assertEqual(len(full['waveform']), slim['waveformPeaks'])
        self.assertNotIn('waveformId', full)
        self.assertLess(len(body), len(full_body))
        self.assertEqual(s.rpc('media.waveform', {'id': full['id']})['waveformId'], slim['waveformId'])
        # A media upload answers the same way.
        clip = self.media / 'small.mp4'
        make_video(clip, seconds=1)
        status, _, body = s.request(f"/upload?name=small.mp4&projectId={project['id']}&omitWaveforms=true",
                                    clip.read_bytes())
        self.assertEqual(status, 200, body)
        media = json.loads(body)['result']['media']
        self.assertEqual(len(media), 2)
        self.assertTrue(all('waveform' not in item for item in media))

    def test_effect_preset_carries_the_sound_fade_of_a_video_clip(self):
        s = self.service
        source = self.media / 'preset.mp4'
        make_video(source, seconds=4)
        project = s.rpc('project.new', {'name': '프리셋'})
        project = s.rpc('media.importAndAdd', {'paths': [str(source)], 'expectedRevision': project['revision']})
        clip = next(c for c in project['clips'] if c['kind'] == 'video')
        project = s.rpc('edit.update', {'id': clip['id'], 'expectedRevision': project['revision'],
                                        'patch': {'audioFadeIn': 1.0, 'audioFadeOut': 0.5}})
        preset = s.rpc('presets.save', {'clipId': clip['id'], 'name': '소리 페이드', 'kind': 'effect'})
        self.assertEqual((preset['patch']['audioFadeIn'], preset['patch']['audioFadeOut']), (1.0, 0.5))
        project = s.rpc('edit.update', {'id': clip['id'], 'expectedRevision': project['revision'],
                                        'patch': {'audioFadeIn': None, 'audioFadeOut': None}})
        self.assertNotIn('audioFadeIn', project['clips'][0])
        project = s.rpc('presets.apply', {'id': preset['id'], 'clipId': clip['id'], 'expectedRevision': project['revision']})
        applied = next(c for c in project['clips'] if c['id'] == clip['id'])
        self.assertEqual((applied['audioFadeIn'], applied['audioFadeOut']), (1.0, 0.5))
        # A text takes the rest of the effect and no sound fade; one undo takes it back.
        project = s.rpc('edit.add', {'text': '글', 'start': 0, 'duration': 2, 'expectedRevision': project['revision']})
        text = next(c for c in project['clips'] if c['kind'] == 'text')
        project = s.rpc('presets.apply', {'id': preset['id'], 'clipId': text['id'], 'expectedRevision': project['revision']})
        self.assertNotIn('audioFadeIn', next(c for c in project['clips'] if c['id'] == text['id']))
        # An audio clip has one fade under either name; nothing is stored as audioFade*.
        project = s.rpc('edit.add', {'mediaId': project['media'][0]['id'], 'trackId': 'audio-1', 'start': 0, 'duration': 2,
                                     'expectedRevision': project['revision']})
        sound = next(c for c in project['clips'] if c['kind'] == 'audio')
        project = s.rpc('edit.update', {'id': sound['id'], 'expectedRevision': project['revision'],
                                        'patch': {'audioFadeIn': 0.5}})
        sound = next(c for c in project['clips'] if c['id'] == sound['id'])
        self.assertEqual(sound['fadeIn'], 0.5)
        self.assertNotIn('audioFadeIn', sound)

    def test_empty_unnamed_projects_are_reported_and_removed_only_on_request(self):
        s = self.service
        # What the home screen used to leave behind: projects nobody named or touched.
        first = s.rpc('project.get')
        template = json.loads((s.home / 'projects' / f"{first['id']}.json").read_text())
        piled = []
        for index in range(3):
            copy = dict(template, id=f'project-piled-{index}', name='새 프로젝트', revision=0)
            piled.append(s.home / 'projects' / f"{copy['id']}.json")
            piled[-1].write_text(json.dumps(copy))
        named = s.rpc('project.new', {'name': '여행'})
        worked = s.rpc('edit.add', {'text': '자막', 'duration': 1, 'expectedRevision': named['revision']})
        # The first project is as untouched as the piled ones, and no longer open.
        expected = piled + [s.home / 'projects' / f"{first['id']}.json"]
        usage = s.rpc('storage.usage')
        self.assertEqual(usage['emptyProjects'], {'count': 4, 'bytes': sum(p.stat().st_size for p in expected)})
        self.assertEqual(s.rpc('storage.clean')['emptyProjects']['count'], 4, 'not removed unless asked for')
        self.assertTrue(all(p.is_file() for p in expected))
        self.assertIn('정리할 수 없는 대상', s.error('storage.clean', {'targets': ['everything']}))
        cleaned = s.rpc('storage.clean', {'targets': ['emptyProjects']})
        self.assertEqual((cleaned['emptyProjects']['removed'], cleaned['emptyProjects']['count']), (4, 0))
        self.assertFalse(any(p.exists() for p in expected))
        self.assertEqual([p['id'] for p in s.rpc('project.list')], [named['id']])
        self.assertEqual(s.rpc('project.get'), worked, 'the open project is untouched')
        # An open project that is empty and unnamed is never offered.
        s.rpc('project.new')
        self.assertEqual(s.rpc('storage.usage')['emptyProjects']['count'], 0)
        self.assertEqual(s.rpc('storage.clean', {'targets': ['emptyProjects']})['emptyProjects']['removed'], 0)

    def test_proxies_are_kept_within_the_configured_limit(self):
        s = self.service
        self.assertEqual(s.rpc('storage.usage')['proxyLimitBytes'], 20 * 1024 ** 3)
        # 2560 wide: large enough to get a proxy.
        source = self.media / 'large.mp4'
        make_video(source, seconds=1, size='2560x1440')
        project = s.rpc('project.new', {'name': '프록시 한도'})
        project = s.rpc('media.importAndAdd', {'paths': [str(source)], 'expectedRevision': project['revision']})
        media_id = project['media'][0]['id']
        own = s.home / 'proxies' / f'{media_id}.mp4'
        wait_for(own.is_file, 120)
        # Proxies of projects that are not open: one used long ago, one recently.
        stored = dict(project, id='project-elsewhere', media=[
            dict(project['media'][0], id='media-old'), dict(project['media'][0], id='media-recent')], clips=[])
        (s.home / 'projects/project-elsewhere.json').write_text(json.dumps(stored))
        others = {}
        for name, days in (('media-old', 40), ('media-recent', 1)):
            others[name] = s.home / 'proxies' / f'{name}.mp4'
            others[name].write_bytes(b'x' * 300_000)
            note = others[name].with_suffix('.source')
            note.write_text(str(source))
            at = time.time() - days * 86400
            os.utime(note, (at, at))
        # Room for the open project's proxy and one of the others.
        limit = own.stat().st_size + own.with_suffix('.source').stat().st_size + 400_000
        configured = s.rpc('storage.configure', {'proxyLimitBytes': limit})
        self.assertEqual(configured['proxyLimitBytes'], limit)
        wait_for(lambda: not others['media-old'].exists(), 30)
        self.assertFalse(others['media-old'].with_suffix('.source').exists())
        self.assertTrue(others['media-recent'].is_file() and own.is_file())
        # Below what the open project needs: its own proxy still stays.
        s.rpc('storage.configure', {'proxyLimitBytes': 1})
        wait_for(lambda: not others['media-recent'].exists(), 30)
        self.assertTrue(own.is_file())
        self.assertEqual(s.request(f'/assets/{media_id}/proxy')[0], 200)
        self.assertIn('proxyLimitBytes', s.error('storage.configure', {'proxyLimitBytes': -5}))
        # The limit outlives the service.
        s.stop()
        s.start()
        self.assertEqual(s.rpc('storage.usage')['proxyLimitBytes'], 1)
        self.assertTrue(own.is_file())

    def test_cover_of_a_project_that_is_not_open_is_served(self):
        s = self.service
        source = self.media / 'cover.mp4'
        make_video(source, seconds=1)
        project = s.rpc('project.new', {'name': '표지'})
        project = s.rpc('media.importAndAdd', {'paths': [str(source)], 'expectedRevision': project['revision']})
        other = s.rpc('project.new', {'name': '다른 프로젝트'})
        listed = {p['id']: p for p in s.rpc('project.list')}
        cover = listed[project['id']]['thumbnail']
        self.assertEqual(cover['mediaId'], project['media'][0]['id'])
        self.assertNotIn('thumbnail', listed[other['id']])
        token = s.connection['token']
        path = f"/projects/{project['id']}/thumbnail"
        for url in (f"{path}?media={cover['mediaId']}", path):
            status, headers, image = s.request(url)
            self.assertEqual((status, headers['Content-Type'], image[:2]), (200, 'image/jpeg', b'\xff\xd8'), url)
        self.assertEqual(s.request(f"{path}?media={cover['mediaId']}&token={token}", token=False)[0], 200)
        self.assertEqual(s.request(path, token=False)[0], 401)
        self.assertEqual(s.request(path, headers={'Origin': 'https://example.com'})[0], 401)
        self.assertEqual(s.request(f"{path}?media=media-unknown")[0], 404)
        self.assertEqual(s.request(f"/projects/{other['id']}/thumbnail")[0], 404)
        self.assertEqual(s.request('/projects/project-unknown/thumbnail')[0], 404)

    def test_agent_token_is_scoped_to_the_allowlist_and_revoked_after_the_job(self):
        # A stand-in CLI: it gets exactly what a real agent gets (its working folder
        # with a connection file) and tries to step outside its permissions.
        tools = Path(tempfile.mkdtemp(prefix='byori-integration-cli-'))
        self.addCleanup(shutil.rmtree, tools, True)
        fake = tools / 'claude'
        fake.write_text(f'''#!{sys.executable}
import json, sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen
sys.stdin.read()
c = json.load(open('connection.json'))
def call(method, params=None, project=None):
    body = {{'method': method, 'params': params or {{}}, 'projectId': project or c['projectId']}}
    request = Request(c['url'] + '/rpc', data=json.dumps(body).encode(),
                      headers={{'Authorization': 'Bearer ' + c['token'], 'Content-Type': 'application/json'}})
    try:
        with urlopen(request, timeout=30) as response:
            return response.status
    except HTTPError as error:
        return error.code
def upload():
    request = Request(c['url'] + '/upload?name=a.srt&projectId=' + c['projectId'], data=b'x',
                      headers={{'Authorization': 'Bearer ' + c['token']}})
    try:
        with urlopen(request, timeout=30) as response:
            return response.status
    except HTTPError as error:
        return error.code
print('SCOPE ' + json.dumps({{
    'project.get': call('project.get'),
    'edit.marker': call('edit.marker', {{'time': 2, 'label': 'agent'}}),
    'project.new': call('project.new', {{'name': 'x'}}),
    'project.delete': call('project.delete', {{'id': 'x'}}),
    'runtime.status': call('runtime.status'),
    'agent.start': call('agent.start', {{'provider': 'claude', 'prompt': 'x'}}),
    'batch': call('edit.batch', {{'commands': [{{'method': 'project.new', 'params': {{}}}}]}}),
    'export.outside': call('export.start', {{'path': '/etc/byori.mp4', 'overwrite': True}}),
    'save.elsewhere': call('project.save', {{'path': c['url']}}),
    'other.project': call('project.get', project='project-other'),
    'upload': upload(),
}}), flush=True)
print('TOKEN ' + c['token'], flush=True)
''')
        fake.chmod(0o755)
        s = Service(path_prefix=tools).start()
        self.addCleanup(s.close)
        project = s.rpc('project.new', {'name': '에이전트'})
        self.assertIn('프로젝트가 변경', s.error('agent.start', {'provider': 'claude', 'prompt': '표시', 'projectId': 'other'}))
        job = s.rpc('agent.start', {'provider': 'claude', 'prompt': '표시 추가', 'projectId': project['id']})
        done = wait_for(lambda: (lambda j: j if j['state'] not in ('running', 'cancelling') else None)(
            s.rpc('agent.status', {'id': job['id']})), 60)
        self.assertEqual(done['state'], 'completed', done)
        lines = [entry['text'] for entry in done['logs']]
        scope = json.loads(next(line for line in lines if line.startswith('SCOPE '))[6:])
        self.assertEqual(scope, {
            'project.get': 200, 'edit.marker': 200,
            'project.new': 403, 'project.delete': 403, 'runtime.status': 403, 'agent.start': 403,
            'batch': 403, 'export.outside': 403, 'save.elsewhere': 403,
            'other.project': 200,  # the token's own project always wins over what the agent claims
            'upload': 401,
        })
        after = s.rpc('project.get')
        self.assertEqual((after['id'], after['markers'][0]['label']), (project['id'], 'agent'))
        token = next(line for line in lines if line.startswith('TOKEN '))[6:]
        self.assertNotEqual(token, s.connection['token'])
        self.assertEqual(s.call('project.get', token=token)[0], 401, 'the token dies with the job')
        self.assertEqual(list((s.home / 'agent-workspaces').glob('*')) if (s.home / 'agent-workspaces').exists() else [], [])

    def test_mcp_bridge_and_cli_share_the_live_editor(self):
        s = self.service
        project = s.rpc('project.new', {'name': 'MCP'})
        connection = s.home / 'connection.json'
        messages = [
            {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {}},
            {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': 'studio_edit', 'arguments': {
                'method': 'edit.marker', 'params': {'time': 3, 'label': 'mcp', 'expectedRevision': project['revision']}}}},
            {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'studio_edit', 'arguments': {
                'method': 'edit.marker', 'params': {'time': 4, 'expectedRevision': project['revision']}}}},
            {'jsonrpc': '2.0', 'id': 4, 'method': 'tools/call', 'params': {'name': 'studio_project', 'arguments': {'method': 'project.delete'}}},
        ]
        bridge = subprocess.run([sys.executable, str(s.home / 'tools/studio-mcp.py'), '--connection', str(connection)],
                                input='\n'.join(json.dumps(m) for m in messages) + '\n', capture_output=True, text=True, timeout=60)
        replies = {r['id']: r['result'] for r in map(json.loads, bridge.stdout.splitlines())}
        self.assertEqual(replies[1]['serverInfo']['name'], 'byori-studio')
        self.assertFalse(replies[2]['isError'], replies[2])
        self.assertTrue(replies[3]['isError'])
        self.assertIn('REVISION_CONFLICT', replies[3]['content'][0]['text'])
        self.assertTrue(replies[4]['isError'])
        cli = subprocess.run([sys.executable, str(REPO / 'scripts/studio-cli.py'), 'project.get'],
                             env=s.env, capture_output=True, text=True, timeout=60)
        self.assertEqual(cli.returncode, 0, cli.stderr)
        seen = json.loads(cli.stdout)
        self.assertEqual((seen['id'], [m['label'] for m in seen['markers']]), (project['id'], ['mcp']))


    def test_replaced_file_of_the_same_length_gets_a_new_waveform_name_and_peaks(self):
        s = self.service
        source = self.media / 'voice.wav'

        def write(volume):
            """Two seconds at the same path: the tone is audible only where `volume` says."""
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
                            '-af', f"volume='{volume}':eval=frame", '-ar', '44100', '-ac', '1', str(source)], check=True)

        def named():
            item = s.rpc('project.get', {'omitWaveforms': True})['media'][0]
            return item if item.get('waveformId') else None

        write('if(lt(t,1),1,0)')
        project = s.rpc('project.new', {'name': '파형'})
        project = s.rpc('media.import', {'paths': [str(source)], 'expectedRevision': project['revision']})
        media = project['media'][0]['id']
        first = wait_for(named, 60)
        self.assertNotIn('waveform', first)
        before = s.rpc('media.waveform', {'id': media})
        self.assertEqual(before['waveformId'], first['waveformId'])
        self.assertEqual(len(before['waveform']), first['waveformPeaks'])
        half = len(before['waveform']) // 2
        self.assertGreater(min(before['waveform'][2:half - 2]), 0.1, 'the first half is loud')
        self.assertLess(max(before['waveform'][half + 2:-2]), 0.01, 'the second half is silent')

        # Another recording of the same length takes the file's place.
        length = duration_of(source)
        write('if(lt(t,1),0,1)')
        self.assertEqual(duration_of(source), length)
        # Nothing looked at the file again: the stored waveform is still the old one.
        self.assertEqual(s.rpc('media.waveform', {'id': media}), before)
        project = s.rpc('media.reprobe', {'ids': [media], 'expectedRevision': s.rpc('project.get')['revision']})
        self.assertEqual(project['media'][0]['duration'], first['duration'])
        second = wait_for(lambda: (lambda item: item if item and item['waveformId'] != first['waveformId'] else None)(named()), 60)
        self.assertEqual(second['waveformPeaks'], first['waveformPeaks'], 'the same length gives as many peaks')
        after = s.rpc('media.waveform', {'id': media})
        self.assertEqual(after['waveformId'], second['waveformId'])
        self.assertNotEqual(after['waveform'], before['waveform'])
        self.assertLess(max(after['waveform'][2:half - 2]), 0.01, 'now the first half is silent')
        self.assertGreater(min(after['waveform'][half + 2:-2]), 0.1, 'and the second half is loud')
        # The name is the content's: the first recording back at the path gets its first name back.
        write('if(lt(t,1),1,0)')
        s.rpc('media.reprobe', {'ids': [media]})
        third = wait_for(lambda: (lambda item: item if item and item['waveformId'] != second['waveformId'] else None)(named()), 60)
        self.assertEqual(third['waveformId'], first['waveformId'])
        self.assertEqual(s.rpc('media.waveform', {'id': media}), before)

    def mean_volume(self, path, start, length):
        """The mean level in dB of one stretch of a sound file (FFmpeg volumedetect)."""
        report = subprocess.run(['ffmpeg', '-v', 'info', '-nostats', '-ss', str(start), '-t', str(length), '-i', str(path),
                                 '-af', 'volumedetect', '-f', 'null', '-'], capture_output=True, text=True, check=True).stderr
        line = next(line for line in report.splitlines() if 'mean_volume:' in line)
        return float(line.split('mean_volume:')[1].split('dB')[0])

    def test_sound_fade_of_a_video_clip_is_heard_in_the_output_and_leaves_the_picture(self):
        s = self.service
        source = self.media / 'tone.mp4'
        make_video(source, seconds=4)
        project = s.rpc('project.new', {'name': '소리 페이드', 'width': 320, 'height': 180})
        project = s.rpc('media.importAndAdd', {'paths': [str(source)], 'expectedRevision': project['revision']})
        clip = next(c for c in project['clips'] if c['kind'] == 'video')
        length = clip['duration']

        def levels(name):
            output = s.home / 'exports' / name
            self.export(s, {'path': str(output), 'format': 'wav'})
            self.assertAlmostEqual(duration_of(output), length, delta=0.1)
            quarters = [self.mean_volume(output, index * 0.25, 0.25) for index in range(4)]
            middle = self.mean_volume(output, 1.5, length - 3)
            end = [self.mean_volume(output, length - 1 + index * 0.25, 0.25) for index in range(4)]
            return quarters, middle, end

        plain_in, plain_middle, plain_out = levels('plain.wav')
        for level in plain_in + plain_out:
            self.assertAlmostEqual(level, plain_middle, delta=1.0, msg='without a fade the tone is level')

        project = s.rpc('edit.update', {'id': clip['id'], 'patch': {'audioFadeIn': 1.0, 'audioFadeOut': 1.0},
                                        'expectedRevision': project['revision']})
        faded = next(c for c in project['clips'] if c['id'] == clip['id'])
        self.assertEqual((faded['audioFadeIn'], faded['audioFadeOut'], faded['fadeIn'], faded['fadeOut']), (1.0, 1.0, 0, 0))
        fade_in, middle, fade_out = levels('faded.wav')
        self.assertAlmostEqual(middle, plain_middle, delta=0.5, msg='between the fades the level is unchanged')
        self.assertEqual(fade_in, sorted(fade_in), 'the sound rises through the fade in')
        self.assertEqual(fade_out, sorted(fade_out, reverse=True), 'and falls through the fade out')
        self.assertLess(fade_in[0], middle - 12, 'the first quarter second is far quieter')
        self.assertLess(fade_out[-1], middle - 12, 'and so is the last')
        self.assertLess(fade_in[3], middle - 0.5)
        self.assertGreater(fade_in[3], middle - 6, 'near its end the fade is almost at full level')
        # The picture does not fade with the sound: its first frame is the source's.
        frame = s.rpc('preview.frame', {'time': 0.0, 'width': 320})
        shown = self.frame_pixel(frame['path'], 300, 20)
        self.assertGreater(sum(shown), 150, shown)

        # The picture's own fade still fades the sound of a clip that has none of its own.
        project = s.rpc('edit.update', {'id': clip['id'], 'patch': {'audioFadeIn': None, 'audioFadeOut': None, 'fadeIn': 1.0},
                                        'expectedRevision': project['revision']})
        following, _, tail = levels('following.wav')
        self.assertLess(following[0], middle - 12)
        self.assertAlmostEqual(tail[-1], middle, delta=1.0)
        frame = s.rpc('preview.frame', {'time': 0.0, 'width': 320})
        self.assertLess(sum(self.frame_pixel(frame['path'], 300, 20)), 60, 'the picture fades in from black')

    def stream_hashes(self, path):
        """The decoded content of a file's video and audio, frame by frame."""
        return subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(path), '-f', 'framemd5', '-'], text=True)

    def test_schema_2_project_file_opens_as_schema_3_and_renders_the_same(self):
        s = self.service
        source = self.media / 'older.mp4'
        make_video(source, seconds=3)
        project = s.rpc('project.new', {'name': '이전 버전', 'width': 320, 'height': 180})
        project = s.rpc('media.importAndAdd', {'paths': [str(source)], 'expectedRevision': project['revision']})
        clip = next(c for c in project['clips'] if c['kind'] == 'video')
        # What a version 2 build could store: a transition whose length also fades the sound.
        project = s.rpc('edit.update', {'id': clip['id'], 'expectedRevision': project['revision'], 'patch': {
            'transitionIn': {'type': 'slideLeft', 'duration': 1.0}, 'fadeOut': 0.5, 'volume': 0.8}})
        project = s.rpc('edit.add', {'text': '자막', 'start': 0.5, 'duration': 2, 'expectedRevision': project['revision']})
        self.assertEqual(project['schemaVersion'], 3)
        wait_for(lambda: isinstance(s.rpc('project.get')['media'][0].get('waveform'), list), 60)
        project = s.rpc('project.get')

        def render(name):
            output = s.home / 'exports' / name
            self.export(s, {'path': str(output), 'format': 'mp4', 'width': 320, 'height': 180, 'hardware': False})
            return self.stream_hashes(output)

        expected = render('v3.mp4')
        self.assertEqual(render('v3-again.mp4'), expected, 'the software export is repeatable')

        older = json.loads(json.dumps(project))
        older['schemaVersion'] = 2
        for item in older['clips']:
            self.assertNotIn('audioFadeIn', item)
        file = self.media / 'version-2.json'
        file.write_text(json.dumps(older))
        opened = s.rpc('project.open', {'path': str(file)})
        self.assertEqual(opened['schemaVersion'], 3)
        self.assertEqual(opened['name'], '이전 버전')
        for key in ('clips', 'tracks', 'media', 'width', 'height', 'fps'):
            self.assertEqual(opened[key], project[key], key)
        self.assertEqual(json.loads(file.read_text())['schemaVersion'], 2, 'the opened file itself is left as it was')
        self.assertEqual(render('v2.mp4'), expected, 'a version 2 project renders as it did')
        # The sound still follows the transition, as version 2 had it.
        audio = s.home / 'exports' / 'v2.wav'
        self.export(s, {'path': str(audio), 'format': 'wav'})
        self.assertLess(self.mean_volume(audio, 0, 0.25), self.mean_volume(audio, 1.25, 0.5) - 12)

        # The autosave of a version 2 build is migrated the same way when the service starts.
        s.stop()
        current = s.home / 'current.json'
        saved = json.loads(current.read_text())
        self.assertEqual(saved['schemaVersion'], 3)
        saved['schemaVersion'] = 2
        current.write_text(json.dumps(saved))
        stored = s.home / 'projects' / f"{saved['id']}.json"
        stored.write_text(json.dumps(saved))
        s.start()
        started = s.rpc('project.get')
        self.assertEqual((started['schemaVersion'], started['id'], started['clips']), (3, opened['id'], opened['clips']))
        self.assertIsNone(s.rpc('project.notice')['notice'])
        self.assertEqual(render('v2-restarted.mp4'), expected)
        # A project from a newer build is refused in words, and nothing is opened.
        newer = dict(older, schemaVersion=4)
        file.write_text(json.dumps(newer))
        self.assertIn('업데이트', s.error('project.open', {'path': str(file)}))
        self.assertEqual(s.rpc('project.get')['id'], started['id'])

    def test_shutdown_during_a_slow_import_keeps_the_edits_answered_before_it(self):
        s = self.service
        source = self.media / 'slow.mp4'
        make_video(source, seconds=2, size='1280x720')
        copies = []
        for index in range(40):
            copy = self.media / f'slow-{index:02}.mp4'
            shutil.copyfile(source, copy)
            copies.append(str(copy))
        project = s.rpc('project.new', {'name': '느린 명령 중 종료'})
        for index in range(3):
            project = s.rpc('edit.add', {'text': f'자막 {index + 1}', 'start': index, 'duration': 1,
                                         'expectedRevision': project['revision']})
        reply = {}

        def slow_import():
            try:
                reply['status'], reply['value'] = s.call('media.import', {'paths': copies, 'expectedRevision': project['revision']})
            except Exception as error:  # the connection may end with the service
                reply['error'] = error

        importing = threading.Thread(target=slow_import)
        importing.start()
        time.sleep(0.4)
        self.assertTrue(importing.is_alive() and not reply, 'the import is still running when the service is told to stop')
        began = time.time()
        s.process.send_signal(signal.SIGTERM)
        s.process.wait(timeout=60)
        took = time.time() - began
        s.log.close()
        importing.join(timeout=30)
        self.assertFalse(importing.is_alive())
        self.assertEqual(s.process.returncode, 0, 'the service stopped by itself')
        self.assertLess(took, 30)
        self.assertFalse((s.home / 'connection.json').exists())

        # Both files hold a whole project with every answered edit.
        saved = json.loads((s.home / 'current.json').read_text())
        stored = json.loads((s.home / 'projects' / f"{project['id']}.json").read_text())
        self.assertEqual(saved, stored)
        self.assertEqual(self.texts(saved), ['자막 1', '자막 2', '자막 3'])
        answered = reply.get('status') == 200
        if answered:
            # The import was answered before the service went: it is an answered edit too.
            self.assertEqual(saved['revision'], reply['value']['revision'])
            self.assertEqual(len(saved['media']), len(copies))
        else:
            # Never half an import: all of it or none.
            self.assertIn(len(saved['media']), (0, len(copies)))
            if not saved['media']:
                self.assertEqual((saved['revision'], saved['clips']), (project['revision'], project['clips']))
        s.start()
        reopened = s.rpc('project.get')
        self.assertEqual((reopened['id'], reopened['revision']), (saved['id'], saved['revision']))
        self.assertEqual(self.texts(reopened), ['자막 1', '자막 2', '자막 3'])
        self.assertIsNone(s.rpc('project.notice')['notice'])
        self.assertEqual([f.name for f in s.home.iterdir() if '.tmp' in f.name or 'corrupt' in f.name], [])
        # The user's files are as they were, and the editor works on.
        self.assertEqual(Path(copies[0]).read_bytes(), source.read_bytes())
        project = s.rpc('edit.add', {'text': '다시 시작한 뒤', 'start': 5, 'duration': 1, 'expectedRevision': reopened['revision']})
        self.assertEqual(self.texts(project)[-1], '다시 시작한 뒤')

    def texts(self, project):
        return [clip['text']['content'] for clip in sorted(project['clips'], key=lambda c: c['start'])]

    def test_killed_service_keeps_an_edit_answered_a_moment_before(self):
        s = self.service
        project = s.rpc('project.new', {'name': '강제 종료'})
        project = s.rpc('edit.add', {'text': '첫 자막', 'start': 0, 'duration': 1, 'expectedRevision': project['revision']})
        time.sleep(1.5)  # on the device by now
        edited = s.rpc('edit.add', {'text': '죽기 직전', 'start': 1, 'duration': 1, 'expectedRevision': project['revision']})
        s.kill()
        saved = json.loads((s.home / 'current.json').read_text())
        self.assertEqual(saved, edited, 'the answered edit is in the autosave')
        s.start()
        reopened = s.rpc('project.get')
        self.assertEqual((reopened['id'], reopened['revision']), (edited['id'], edited['revision']))
        self.assertEqual(self.texts(reopened), ['첫 자막', '죽기 직전'])
        self.assertIsNone(s.rpc('project.notice')['notice'])
        # The stored copy caught up when the service started.
        stored = json.loads((s.home / 'projects' / f"{edited['id']}.json").read_text())
        self.assertEqual(stored['clips'], reopened['clips'])

    def test_killed_service_keeps_every_edit_of_a_burst(self):
        s = self.service
        project = s.rpc('project.new', {'name': '연속 편집'})
        for index in range(17):
            project = s.rpc('edit.add', {'text': f'자막 {index + 1}', 'start': index, 'duration': 1,
                                         'expectedRevision': project['revision']})
            time.sleep(0.1)
        s.kill()
        s.start()
        reopened = s.rpc('project.get')
        self.assertEqual(reopened['revision'], project['revision'])
        self.assertEqual(self.texts(reopened), [f'자막 {index + 1}' for index in range(17)])
        self.assertEqual(reopened['clips'], project['clips'])
        # The same without a pause between the edits and the kill.
        for index in range(17, 40):
            project = s.rpc('edit.add', {'text': f'자막 {index + 1}', 'start': index, 'duration': 1,
                                         'expectedRevision': project['revision']})
        s.kill()
        s.start()
        self.assertEqual(self.texts(s.rpc('project.get')), [f'자막 {index + 1}' for index in range(40)])

    def test_shutdown_keeps_edits_answered_just_before_it(self):
        s = self.service
        project = s.rpc('project.new', {'name': '종료'})
        for index in range(5):
            project = s.rpc('edit.add', {'text': f'자막 {index + 1}', 'start': index, 'duration': 1,
                                         'expectedRevision': project['revision']})
        began = time.time()
        s.stop()
        self.assertLess(time.time() - began, 5)
        self.assertEqual(s.process.returncode, 0)
        for file in (s.home / 'current.json', s.home / 'projects' / f"{project['id']}.json"):
            self.assertEqual(json.loads(file.read_text()), project, file.name)
        s.start()
        self.assertEqual(s.rpc('project.get')['clips'], project['clips'])

    def test_request_for_a_project_that_is_no_longer_open_is_refused_in_plain_words(self):
        s = self.service
        left = s.rpc('project.new', {'name': '먼저 열린 프로젝트'})
        now = s.rpc('project.new', {'name': '지금 열린 프로젝트'})
        status, _, raw = s.request('/rpc', json.dumps({'method': 'edit.add', 'projectId': left['id'], 'params': {
            'text': '늦게 도착한 편집', 'duration': 1}}).encode(), headers={'Content-Type': 'application/json'})
        refused = json.loads(raw)
        self.assertEqual((status, refused['code']), (409, 'PROJECT_CHANGED'))
        self.assertIn('다른 프로젝트가 열려 있어', refused['error'])
        self.assertTrue(refused['error'].endswith('(PROJECT_CHANGED)'))
        self.assertNotIn('에이전트', refused['error'])
        self.assertEqual(s.rpc('project.get'), now)
        self.assertEqual(s.call('project.get', project=now['id'])[0], 200)

    def test_replaced_preview_frame_is_a_result_not_a_failed_request(self):
        s = self.service
        source = self.media / 'frames.mp4'
        make_video(source, seconds=4, size='1920x1080')
        project = s.rpc('project.new', {'name': '미리보기'})
        project = s.rpc('media.importAndAdd', {'paths': [str(source)], 'expectedRevision': project['revision']})
        replies = {}

        def frame(index, client='player', time=None):
            at = 0.2 + index * 0.5 if time is None else time
            replies[index] = s.call('preview.frame', {'time': at, 'width': 1280, 'client': client})

        # A scrub: each request replaces the one before it.
        requests = [threading.Thread(target=frame, args=(index,)) for index in range(6)]
        for request in requests:
            request.start()
            time.sleep(0.02)
        for request in requests:
            request.join()
        self.assertEqual({status for status, _ in replies.values()}, {200}, replies)
        self.assertIn('assetId', replies[5][1])
        replaced = [value for _, value in replies.values() if value.get('cancelled')]
        self.assertTrue(replaced, replies)
        for value in replaced:
            self.assertEqual(set(value), {'cancelled', 'reason'})
            self.assertIn('PREVIEW_CANCELLED', value['reason'])
        # A frame for a revision the project has left is answered the same way: the
        # window that asked will ask again for the project as it is now.
        current = s.rpc('project.get')['revision']
        status, behind = s.call('preview.frame', {'time': 0.2, 'width': 320, 'expectedRevision': current - 1})
        self.assertEqual(status, 200, behind)
        self.assertEqual(set(behind), {'cancelled', 'reason'})
        self.assertIn('REVISION_CONFLICT', behind['reason'])
        # A request that could never be drawn is still a failed request.
        self.assertEqual(s.call('preview.frame', {'time': 0.2, 'expectedRevision': 'soon'})[0], 400)
        # Playback starts: the player stops its frame; other clients are not its business.
        self.assertEqual(s.rpc('preview.cancel', {'client': 'player'}), {'cancelled': 0})
        for attempt in range(10):
            replies.clear()
            request = threading.Thread(target=frame, args=(attempt + 10, 'export', 0.33 + attempt * 0.3))
            request.start()
            time.sleep(0.03)
            self.assertEqual(s.rpc('preview.cancel', {'client': 'player'}), {'cancelled': 0})
            stopped = s.rpc('preview.cancel', {'client': 'export'})['cancelled']
            request.join()
            self.assertEqual(replies[attempt + 10][0], 200)
            if stopped:
                self.assertTrue(replies[attempt + 10][1].get('cancelled'), replies)
                break
        else:
            self.fail('no frame was still being rendered when preview.cancel arrived')
        # Stopping frames is the player's own business: agents get frames only.
        tools = json.loads((REPO / 'scripts/studio-tools.json').read_text())
        allowed = {method for tool in tools['tools'] for method in tool.get('methods', [])}
        self.assertIn('preview.frame', allowed)
        self.assertNotIn('preview.cancel', allowed)


class StalenessCheckTests(unittest.TestCase):
    def test_native_shell_source_does_not_make_the_service_binary_look_outdated(self):
        names = {p.relative_to(REPO).as_posix() for p in binary_sources()}
        self.assertNotIn('src-tauri/src/main.rs', names)
        for built_in in ('src-tauri/src/lib.rs', 'src-tauri/src/service.rs',
                         'src-tauri/src/bin/studio-service.rs', 'scripts/studio-mcp.py'):
            self.assertIn(built_in, names)


if __name__ == '__main__':
    unittest.main(verbosity=2)
