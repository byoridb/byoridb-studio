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

PROJECT_METHODS = ['project.get', 'project.list', 'project.save', 'history.status']
EDIT_METHODS = ['edit.add', 'edit.update', 'edit.delete', 'edit.split', 'edit.trim', 'edit.duplicate',
                'edit.track', 'edit.marker', 'edit.batch', 'history.undo', 'history.redo',
                'project.update', 'media.import', 'media.importAndAdd', 'media.reprobe', 'captions.import', 'captions.export',
                'color.importLut', 'edit.group', 'edit.ungroup']
EXPORT_METHODS = ['export.start', 'export.status', 'export.cancel', 'preview.frame', 'preview.start']
MEMORY_METHODS = ['memory.search', 'memory.record']
SPEECH_METHODS = ['speech.status', 'speech.transcribe', 'speech.synthesize', 'speech.job', 'speech.cancel']
ASSET_METHODS = ['assets.list', 'fonts.import', 'fonts.remove', 'fonts.apply', 'presets.save', 'presets.import', 'presets.export', 'presets.remove', 'presets.apply']
TOOLS = [
    {'name': 'studio_project', 'description': 'Read the open video project, its media/tracks/clips/concept, list saved projects, save the current project, or inspect undo history. All times are seconds. Read project.get before editing.', 'methods': PROJECT_METHODS},
    {'name': 'studio_edit', 'description': 'Apply real edits to Studio and its visible timeline. Methods: edit.add {mediaId,trackId,start,duration,text}; edit.update {id,patch,expectedRevision}; edit.split {id,time:absolute,expectedRevision?}; edit.trim {id,start?:absolute,end?:absolute,expectedRevision?} (retain absolute timeline range, omit unchanged boundary, minimum one frame, source-bounded extension allowed); edit.delete {ids,ripple}; edit.duplicate {ids}; edit.group/ungroup {ids}; color.importLut {id,path,expectedRevision}; edit.track {id,patch} or {kind,name?,clipIds?} (create a compatible layer and optionally move clips, one undo); edit.marker {time,label}; edit.batch {commands:[{method,params}],expectedRevision} (atomic, one undo); history.undo/redo; project.update {patch}; media.import {paths}; media.reprobe {ids,expectedRevision} (refresh metadata and repair album-art MP3 clips without changing timing, one undo); media.importAndAdd {paths,start?,trackId?,expectedRevision?}; captions.import/export {path}. Use exact IDs from project.get. Never report unsupported edits as completed.', 'methods': EDIT_METHODS},
    {'name': 'studio_export', 'description': 'Render actual output or inspect a composited preview frame. export.start {path,width?,height?,fps?,format?,start?,end?} returns job id. export.status {id} reports progress and success/failure. export.cancel {id}. preview.frame {time,width?} returns the rendered frame as an image.', 'methods': EXPORT_METHODS},
    {'name': 'studio_memory', 'description': 'Use ByoriDB creative memory. memory.search {text?,limit?} recalls concepts, edits and feedback across projects. memory.record {body,kind?,clipId?} records intent or feedback for the current project. Distinguish user-confirmed feedback from your own hypothesis; do not invent observations.', 'methods': MEMORY_METHODS},
    {'name': 'studio_speech', 'description': 'Local speech processing. speech.status lists available voices and Whisper. speech.transcribe {language:ko|en|auto,model:tiny|base|small,translate?:bool} transcribes the current timeline and inserts captions. speech.synthesize {text,voice?,rate?,start?} creates narration and inserts audio. Both return job id; poll speech.job {id}, cancel with speech.cancel {id}. First transcription downloads the model. Changed projects are not overwritten.', 'methods': SPEECH_METHODS},
    {'name': 'studio_assets', 'description': 'Manage reusable local fonts and filter/effect presets. assets.list {}; fonts.import {path,name?} accepts TTF/OTF; fonts.apply {id,clipId,expectedRevision}; presets.save {clipId,name,kind:filter|effect}; presets.import/export {path,id?} uses Studio JSON; presets.apply {id,clipId,expectedRevision}. fonts.remove/presets.remove {id} remove catalog entries. Applying uses the same validated undoable editor commands. Never describe arbitrary executable plugins as supported.', 'methods': ASSET_METHODS},
]


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
    return value['result']


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
                'capabilities': {'tools': {}}, 'serverInfo': {'name': 'byori-studio', 'version': '0.1.0'},
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
