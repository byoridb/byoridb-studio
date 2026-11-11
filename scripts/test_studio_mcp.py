import importlib.util
from pathlib import Path
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
