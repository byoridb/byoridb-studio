#!/usr/bin/env python3
"""Command-line access to the same live editing service used by Studio and MCP."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('method', help='RPC operation, e.g. project.get, edit.split, export.start')
parser.add_argument('params', nargs='?', default='{}', help='JSON parameters or - to read stdin')
parser.add_argument('--connection', type=Path, default=Path(os.environ.get('BYORI_STUDIO_HOME', '~/.byori-studio')).expanduser() / 'connection.json')
args = parser.parse_args()
spec = importlib.util.spec_from_file_location('studio_mcp', Path(__file__).with_name('studio-mcp.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
allowed = {method for tool in module.TOOLS for method in tool['methods']}
if args.method not in allowed:
    parser.error('Unsupported method. Supported: ' + ', '.join(sorted(allowed)))
try:
    params = json.loads(sys.stdin.read() if args.params == '-' else args.params)
    result = module.rpc(args.method, params, json.loads(args.connection.read_text()))
    print(json.dumps(result, ensure_ascii=False, indent=2))
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
