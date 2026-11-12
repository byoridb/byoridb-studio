#!/usr/bin/env python3
"""Byori Studio MCP bridge. Local, authenticated, shared editor commands only.
No third-party Python dependencies. Configuration stays inside Studio's workspace.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen

# One definition of the agent-facing tools, shared with the service's server-side allowlist.
DEFINITION = json.loads(Path(__file__).with_name('studio-tools.json').read_text(encoding='utf-8'))
TOOLS = DEFINITION['tools']
VERSION = DEFINITION.get('version', '0')


def connection_path():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--connection', default=str(Path(os.environ.get('BYORI_STUDIO_HOME', '~/.byori-studio')).expanduser() / 'connection.json'))
    args, _ = parser.parse_known_args()
    return Path(args.connection)


def rpc(method, params, connection=None):
    connection = connection or json.loads(connection_path().read_text())
    url = connection.get('url', '')
    if not url.startswith('http://127.0.0.1:'):
        raise ValueError('Studio must use a local loopback connection')
    request = Request(url + '/rpc', data=json.dumps({'method': method, 'params': params, 'projectId': connection.get('projectId')}).encode(),
                      headers={'Authorization': 'Bearer ' + connection['token'], 'Content-Type': 'application/json'}, method='POST')
    try:
        with urlopen(request, timeout=180) as response:
            value = json.load(response)
    except HTTPError as error:
        try:
            detail = json.load(error).get('error', str(error))
        except Exception:
            detail = str(error)
        raise ValueError(detail) from None
    if 'error' in value:
        raise ValueError(value['error'])
    result = value['result']
    # The service answers a frame that this caller's newer request replaced, or that
    # the project left behind (PREVIEW_STALE, REVISION_CONFLICT), as a result (HTTP
    # 200, so that a browser logs no failed request). Here it is no frame.
    if method == 'preview.frame' and isinstance(result, dict) and result.get('cancelled'):
        raise ValueError(result.get('reason') or 'PREVIEW_CANCELLED')
    return result


def list_tools():
    return [{k: v for k, v in tool.items() if k != 'methods'} | {
        'inputSchema': {'type': 'object', 'properties': {'method': {'type': 'string', 'enum': tool['methods']},
          'params': {'type': 'object', 'additionalProperties': True}}, 'required': ['method'], 'additionalProperties': False}}
        for tool in TOOLS]


def handle(message):
    method = message.get('method')
    params = message.get('params') or {}
    if method == 'initialize':
        return {'protocolVersion': params.get('protocolVersion', '2024-11-05'),
                'capabilities': {'tools': {}}, 'serverInfo': {'name': 'byori-studio', 'version': VERSION},
                'instructions': 'This is the live video editor. Use project.get before editing. Editing commands update the UI and are undoable. Use exact IDs and expectedRevision. Memory is backed by ByoriDB. A successful tool result is required before claiming an action occurred.'}
    if method == 'ping':
        return {}
    if method == 'tools/list':
        return {'tools': list_tools()}
    if method == 'tools/call':
        tool = next((t for t in TOOLS if t['name'] == params.get('name')), None)
        args = params.get('arguments') or {}
        if tool is None or args.get('method') not in tool['methods']:
            return {'isError': True, 'content': [{'type': 'text', 'text': 'Unknown tool or unsupported operation'}]}
        try:
            result = rpc(args['method'], args.get('params') or {})
            content = [{'type': 'text', 'text': json.dumps(result, ensure_ascii=False)}]
            if args['method'] == 'preview.frame' and isinstance(result, dict) and result.get('path'):
                path = Path(result['path'])
                if path.is_file() and path.stat().st_size < 10 * 1024 * 1024:
                    content.append({'type': 'image', 'mimeType': 'image/png', 'data': base64.b64encode(path.read_bytes()).decode()})
            return {'content': content, 'isError': False}
        except Exception as error:
            return {'content': [{'type': 'text', 'text': str(error)}], 'isError': True}
    if method in ('resources/list', 'prompts/list'):
        return {'resources': []} if method == 'resources/list' else {'prompts': []}
    raise ValueError('Unsupported MCP method: ' + str(method))


def main():
    for line in sys.stdin:
        if len(line) > 2 * 1024 * 1024:
            continue
        try:
            message = json.loads(line)
            if 'id' not in message:
                continue
            try:
                result = {'jsonrpc': '2.0', 'id': message['id'], 'result': handle(message)}
            except Exception as error:
                result = {'jsonrpc': '2.0', 'id': message['id'], 'error': {'code': -32601, 'message': str(error)}}
            print(json.dumps(result, ensure_ascii=False), flush=True)
        except Exception as error:
            print(json.dumps({'jsonrpc': '2.0', 'id': None, 'error': {'code': -32700, 'message': str(error)}}), flush=True)

if __name__ == '__main__':
    main()
