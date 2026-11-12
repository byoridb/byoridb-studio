import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('mcp', Path(__file__).with_name('studio-mcp.py'))
mcp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mcp)

class ToolBoundaryTests(unittest.TestCase):
    def test_only_editing_capabilities_are_advertised(self):
        tools = mcp.list_tools()
        self.assertEqual(len(tools), 6)
        methods = {m for t in tools for m in t['inputSchema']['properties']['method']['enum']}
        self.assertIn('edit.batch', methods)
        self.assertIn('edit.trim', methods)
        self.assertIn('preview.frame', methods)
        self.assertIn('fonts.apply', methods)
        self.assertIn('presets.apply', methods)
        self.assertNotIn('runtime.install', methods)
        self.assertNotIn('agent.start', methods)

    def test_contract_commands_are_exposed_without_project_switching_or_deletion(self):
        methods = {m for t in mcp.TOOLS for m in t['methods']}
        for method in ['media.relink', 'edit.trackDelete', 'edit.trackMove', 'edit.markerUpdate',
                       'edit.markerDelete', 'edit.paste', 'project.notice']:
            self.assertIn(method, methods)
        for method in ['project.delete', 'project.open', 'project.new', 'project.duplicate',
                       'project.rename', 'agent.list', 'runtime.status']:
            self.assertNotIn(method, methods)
        self.assertEqual(len(methods), sum(len(t['methods']) for t in mcp.TOOLS))

    def test_second_round_commands_and_fields_are_described(self):
        edit = next(t for t in mcp.TOOLS if t['name'] == 'studio_edit')
        self.assertIn('edit.freeze', edit['methods'])
        for term in ['edit.freeze {id,time', 'transitionIn', 'wipeLeft', 'blendMode', 'easeInOut', 'hold',
                     'letterSpacing', 'lineHeight', 'outline', 'shadow']:
            self.assertIn(term, edit['description'])
        export = next(t for t in mcp.TOOLS if t['name'] == 'studio_export')
        for term in ['codec', 'hevc', 'hardware', 'bitrate']:
            self.assertIn(term, export['description'])

    def test_project_shape_an_agent_receives_is_described(self):
        project = next(t for t in mcp.TOOLS if t['name'] == 'studio_project')
        for term in ['waveformPeaks', 'waveformId', 'media.reprobe']:
            self.assertIn(term, project['description'])
        assets = next(t for t in mcp.TOOLS if t['name'] == 'studio_assets')
        for term in ['audioFadeIn', 'audioFadeOut']:
            self.assertIn(term, assets['description'])

    def test_release_version_is_declared_once(self):
        root = Path(__file__).resolve().parent.parent
        check = subprocess.run(['node', str(root / 'scripts/check-version.mjs')], capture_output=True, text=True)
        self.assertEqual(check.returncode, 0, check.stderr)
        version = json.loads((root / 'package.json').read_text())['version']
        self.assertEqual(check.stdout.strip(), 'version ' + version)
        self.assertEqual(json.loads((root / 'src-tauri/tauri.conf.json').read_text())['version'], '../package.json')
        self.assertEqual(mcp.handle({'method': 'initialize'})['serverInfo']['version'], version)

    def test_cli_honors_isolated_home(self):
        cli = Path(__file__).with_name('studio-cli.py')
        with tempfile.TemporaryDirectory() as home:
            env = dict(os.environ, BYORI_STUDIO_HOME=home)
            missing = subprocess.run([sys.executable, str(cli), 'project.get'], env=env, capture_output=True, text=True)
            self.assertNotEqual(missing.returncode, 0)
            self.assertIn(home, missing.stderr)
            # A non-loopback address proves the isolated connection file was the one read.
            Path(home, 'connection.json').write_text(json.dumps({'url': 'http://example.invalid', 'token': 'x'}))
            isolated = subprocess.run([sys.executable, str(cli), 'project.get'], env=env, capture_output=True, text=True)
            self.assertNotEqual(isolated.returncode, 0)
            self.assertIn('loopback', isolated.stderr)
            denied = subprocess.run([sys.executable, str(cli), 'project.delete'], env=env, capture_output=True, text=True)
            self.assertNotEqual(denied.returncode, 0)
            self.assertIn('Unsupported method', denied.stderr)

    def test_tool_rejects_cross_category_and_runtime_actions(self):
        for name, method in [('studio_project', 'edit.delete'), ('studio_edit', 'runtime.install'), ('studio_assets', 'runtime.mcpSave')]:
            result = mcp.handle({'method': 'tools/call', 'params': {'name': name, 'arguments': {'method': method}}})
            self.assertTrue(result['isError'])

    def test_errors_are_not_success(self):
        old = mcp.rpc
        def fail(*args, **kwargs): raise ValueError('conflict')
        mcp.rpc = fail
        try:
            result = mcp.handle({'method': 'tools/call', 'params': {'name': 'studio_edit', 'arguments': {'method': 'edit.split'}}})
            self.assertTrue(result['isError'])
            self.assertEqual(result['content'][0]['text'], 'conflict')
        finally:
            mcp.rpc = old

    def test_replaced_preview_frame_is_reported_as_no_frame(self):
        """The service answers a frame its caller replaced as a result (HTTP 200);
        to an agent and the CLI that is still not a frame."""
        class Reply:
            def __init__(self, value): self.value = value
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self, *args): return json.dumps(self.value).encode()
        connection = {'url': 'http://127.0.0.1:1', 'token': 'x'}
        old = mcp.urlopen
        try:
            reason = '더 새로운 미리보기 요청으로 대체되었습니다. (PREVIEW_CANCELLED)'
            mcp.urlopen = lambda request, timeout=None: Reply({'result': {'cancelled': True, 'reason': reason}})
            with self.assertRaises(ValueError) as raised:
                mcp.rpc('preview.frame', {'time': 1}, connection)
            self.assertIn('PREVIEW_CANCELLED', str(raised.exception))
            # Another command's result may say "cancelled" without being an error.
            self.assertEqual(mcp.rpc('export.cancel', {'id': 'a'}, connection), {'cancelled': True, 'reason': reason})
            mcp.urlopen = lambda request, timeout=None: Reply({'result': {'assetId': 'preview-frame-1', 'path': '/nonexistent.png'}})
            self.assertEqual(mcp.rpc('preview.frame', {'time': 1}, connection)['assetId'], 'preview-frame-1')
        finally:
            mcp.urlopen = old

    def test_trim_preserves_absolute_bounds_and_revision(self):
        old = mcp.rpc
        calls = []
        params = {'id': 'clip-a', 'start': 3.5, 'end': 8, 'expectedRevision': 7}
        def capture(method, arguments):
            calls.append((method, arguments))
            return {'revision': 8}
        mcp.rpc = capture
        try:
            result = mcp.handle({'method': 'tools/call', 'params': {'name': 'studio_edit', 'arguments': {'method': 'edit.trim', 'params': params}}})
            self.assertFalse(result['isError'])
            self.assertEqual(calls, [('edit.trim', params)])
        finally:
            mcp.rpc = old

if __name__ == '__main__': unittest.main()
