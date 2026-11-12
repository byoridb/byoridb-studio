"""Throws edit commands with values of the wrong type at the real studio-service.

A command whose value has the wrong shape (a string or a list where a number
belongs, a number where an object belongs) must be refused as a validation error
(HTTP 400), alone and as either half of a two-command `edit.batch`. It must never
panic: the service log may not gain a "panicked" line and the service must still
answer afterwards.

The run is seeded, so a failure names the seed and the request that caused it.

    BYORI_STUDIO_FUZZ=4000         requests per kind (default 150: a few seconds)
    BYORI_STUDIO_FUZZ_SEED=7       another sequence (default 1)
    BYORI_STUDIO_SERVICE_BIN=...   the binary, for example the release build

Like the integration tests it uses a temporary BYORI_STUDIO_HOME and a free port,
never the user's ~/.byori-studio or port 43123.
"""
import copy
import json
import os
from pathlib import Path
import random
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_integration as integration  # noqa: E402

COUNT = int(os.environ.get('BYORI_STUDIO_FUZZ') or 150)
SEED = int(os.environ.get('BYORI_STUDIO_FUZZ_SEED') or 1)

# Values of every JSON type, and numbers a careless conversion trips over.
WRONG = [None, True, False, 0, -1, 1, 0.5, -0.0, 1e308, -1e308, 1e-320, 2 ** 53, -2 ** 63, 2 ** 64, 86400 * 400,
         '', 'x', '0', '1.5', 'NaN', 'null', '한글', 'video', 'fade', 'transform.x', '#ffffff', 'a' * 300,
         [], [0], [[0, 0], [1, 1]], ['a', 1, None], [{}], [[]], [None],
         {}, {'x': 1}, {'type': 'fade', 'duration': 1}, {'enabled': 'yes'}, {'a': {'b': {'c': []}}},
         {'property': 'scale', 'time': '1', 'value': []}]


# What `edit.update` lets a patch set on a clip.
CLIP_FIELDS = ['trackId', 'name', 'start', 'duration', 'sourceIn', 'speed', 'reverse', 'volume', 'fadeIn', 'fadeOut',
               'audioFadeIn', 'audioFadeOut', 'transform', 'color', 'keyframes', 'text', 'crop', 'mask', 'chromaKey',
               'audio', 'stabilize', 'groupId', 'filter', 'transitionIn', 'transitionOut', 'blendMode']


def wrong(random_):
    """One of WRONG, as a value of its own (a scrambled command may be changed again)."""
    return copy.deepcopy(random_.choice(WRONG))


def paths(value, prefix=()):
    """Every position inside a JSON value, the value itself excluded."""
    found = []
    if isinstance(value, dict):
        for key, item in value.items():
            found.append(prefix + (key,))
            found.extend(paths(item, prefix + (key,)))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            found.append(prefix + (index,))
            found.extend(paths(item, prefix + (index,)))
    return found


def scrambled(random_, params):
    """A copy of `params` with one to three values replaced, removed or added."""
    params = copy.deepcopy(params)
    for _ in range(random_.choice([1, 1, 1, 2, 3])):
        places = paths(params)
        if not places:
            params[random_.choice(['id', 'patch', 'ids', 'time'])] = wrong(random_)
            continue
        place = random_.choice(places)
        holder = params
        for key in place[:-1]:
            holder = holder[key]
        if not isinstance(holder, (dict, list)):
            continue
        action = random_.random()
        if action < 0.8:
            holder[place[-1]] = wrong(random_)
        elif action < 0.9 and isinstance(holder, dict):
            del holder[place[-1]]
        elif isinstance(holder, dict):
            holder[random_.choice(['duration', 'keyframes', 'transform', 'text', 'start', 'speed', 'crop', 'x'])] = \
                wrong(random_)
        else:
            holder.append(wrong(random_))
    return params


class Fuzz:
    """Valid commands for the project as it is now, to be scrambled."""

    def __init__(self, random_, project, files):
        self.random = random_
        self.project = project
        self.files = files

    def pick(self, key, kind=None):
        items = [item for item in self.project[key] if kind is None or item.get('kind') == kind]
        return self.random.choice(items)['id'] if items else 'missing'

    def clip(self, kind=None):
        return self.pick('clips', kind)

    def patch(self):
        r = self.random
        fields = {
            'start': r.choice([0, 1.5, 3]), 'duration': r.choice([0.5, 1, 2]), 'sourceIn': 0.2,
            'speed': r.choice([0.5, 1, 2]), 'reverse': r.choice([True, False]), 'volume': 0.5,
            'fadeIn': 0.2, 'fadeOut': 0.3, 'audioFadeIn': 0.2, 'audioFadeOut': None, 'name': '이름',
            'trackId': self.pick('tracks'),
            'transform': {'x': 10, 'y': -10, 'scale': 1.2, 'rotation': 15, 'opacity': 0.8, 'flipX': True},
            'color': {'brightness': 0.1, 'contrast': 1.1, 'saturation': 0.9, 'temperature': 0.2, 'hue': 10,
                      'hsl': {'red': {'hue': 10, 'saturation': 0.1, 'lightness': 0.1}},
                      'curves': {'preset': 'none', 'master': [[0, 0], [0.5, 0.6], [1, 1]], 'red': []},
                      'lut': {'enabled': False}},
            'keyframes': [{'property': 'scale', 'time': 0, 'value': 1, 'easing': 'easeInOut'},
                          {'property': 'transform.x', 'time': 0.5, 'value': 40},
                          {'property': 'volume', 'time': 0.2, 'value': 0.5}],
            'text': {'content': '글', 'fontSize': 48, 'color': '#ffffff', 'fontFamily': 'sans-serif', 'bold': True,
                     'align': 'left', 'background': 'transparent', 'letterSpacing': 2, 'lineHeight': 1.2,
                     'outline': {'color': '#000000', 'width': 2},
                     'shadow': {'color': '#000000', 'x': 2, 'y': 2, 'blur': 4}},
            'crop': {'x': 0.1, 'y': 0.1, 'width': 0.5, 'height': 0.5},
            'mask': {'type': 'circle', 'x': 0.5, 'y': 0.5, 'width': 0.5, 'height': 0.5, 'feather': 0.1},
            'chromaKey': {'enabled': True, 'color': '#00ff00', 'similarity': 0.2, 'blend': 0.1},
            'audio': {'normalize': True, 'denoise': False, 'voiceEnhance': True, 'eq': {'bass': 1, 'mid': 0, 'treble': -1}},
            'stabilize': {'enabled': True, 'strength': 2}, 'groupId': 'group-x', 'filter': 'warm',
            'transitionIn': {'type': 'wipeLeft', 'duration': 0.3}, 'transitionOut': {'type': 'fade', 'duration': 0.2},
            'blendMode': 'screen',
        }
        return {key: fields[key] for key in r.sample(sorted(fields), r.choice([1, 1, 2, 3]))}

    def command(self):
        """One (method, params) that the editor would normally accept or refuse politely."""
        r = self.random
        clip = self.clip()
        clips = self.project['clips']
        whole = next((c for c in clips if c['id'] == clip), {'start': 0, 'duration': 1})
        middle = whole['start'] + whole['duration'] / 2
        choices = [
            ('edit.update', {'id': clip, 'patch': self.patch()}),
            ('edit.update', {'id': clip, 'patch': self.patch()}),
            ('edit.update', {'id': clip, 'patch': self.patch()}),
            ('edit.add', {'mediaId': self.pick('media'), 'start': 4, 'duration': 1}),
            ('edit.add', {'text': {'content': '추가', 'fontSize': 40}, 'start': 1, 'duration': 1,
                          'name': '이름', 'transform': {'x': 1, 'scale': 0.5}}),
            ('edit.add', {'text': '새 글', 'newTrack': '새 트랙'}),
            ('edit.add', {'mediaId': self.pick('media'), 'trackId': self.pick('tracks'), 'sourceIn': 0.1}),
            ('edit.split', {'id': clip, 'time': middle}),
            ('edit.trim', {'id': clip, 'start': whole['start'] + 0.1, 'end': whole['start'] + whole['duration'] - 0.1}),
            ('edit.delete', {'ids': [clip], 'ripple': r.choice([True, False])}),
            ('edit.duplicate', {'ids': [clip, self.clip()]}),
            ('edit.duplicate', {'id': clip}),
            ('edit.group', {'ids': [clip, self.clip()]}),
            ('edit.ungroup', {'ids': [clip]}),
            ('edit.track', {'id': self.pick('tracks'), 'patch': {'name': '트랙', 'muted': True, 'hidden': False,
                                                                  'locked': r.random() < 0.1}}),
            ('edit.track', {'kind': r.choice(['video', 'audio', 'text']), 'name': '층', 'clipIds': [clip]}),
            ('edit.trackDelete', {'id': self.pick('tracks')}),
            ('edit.trackMove', {'id': self.pick('tracks'), 'index': 1}),
            ('edit.marker', {'time': 1, 'label': '표시'}),
            ('edit.markerUpdate', {'id': self.pick('markers'), 'time': 2, 'label': '바뀜'}),
            ('edit.markerDelete', {'id': self.pick('markers')}),
            ('edit.paste', {'clips': [copy.deepcopy(whole)] if 'id' in whole else [], 'at': 5}),
            ('edit.shift', {'trackId': self.pick('tracks'), 'from': 0, 'delta': 0.5}),
        ]
        return r.choice(choices)

    def outside_batch(self):
        """Commands of the same editor that do not run inside `edit.batch`."""
        r = self.random
        clip = self.clip()
        choices = [
            ('project.update', {'patch': {'name': '이름', 'width': 1280, 'height': 720, 'fps': 30, 'background': '#000000',
                                           'concept': {'audience': 'a', 'message': 'b', 'appeal': 'c', 'direction': 'd'},
                                           'notes': [{'id': 'n', 'body': '메모', 'createdAt': 1, 'kind': 'note'}],
                                           'markers': [{'id': 'm', 'time': 1, 'label': '표시'}]}}),
            ('edit.freeze', {'id': self.clip('video'), 'time': 0.5, 'duration': 1}),
            ('media.import', {'paths': [self.files['image']]}),
            ('media.importAndAdd', {'paths': [self.files['image']], 'start': 6, 'trackId': self.pick('tracks'), 'duration': 1}),
            ('media.reprobe', {'ids': [self.pick('media')]}),
            ('media.relink', {'id': self.pick('media'), 'path': self.files['image']}),
            ('media.remove', {'id': self.pick('media')}),
            ('media.waveform', {'id': self.pick('media')}),
            ('captions.import', {'path': self.files['srt']}),
            ('captions.export', {'path': self.files['out'], 'overwrite': True}),
            ('color.importLut', {'id': clip, 'path': self.files['image']}),
            ('presets.save', {'clipId': clip, 'name': '프리셋', 'kind': r.choice(['filter', 'effect'])}),
            ('presets.apply', {'id': 'missing', 'clipId': clip}),
            ('fonts.apply', {'id': 'missing', 'clipId': clip}),
            ('project.get', {'ifProjectId': self.project['id'], 'ifRevision': self.project['revision']}),
            ('history.undo', {}), ('history.redo', {}), ('history.status', {}),
        ]
        return r.choice(choices)


@unittest.skipIf(integration.REASON and not integration.REQUIRED, integration.REASON)
class CommandFuzzTests(unittest.TestCase):
    def setUp(self):
        if integration.REASON:
            self.fail(integration.REASON)
        self.assertNotEqual(os.environ.get('BYORI_STUDIO_PORT'), str(integration.USER_PORT))
        self.media = Path(tempfile.mkdtemp(prefix='byori-fuzz-media-'))
        self.addCleanup(shutil.rmtree, self.media, True)
        self.service = integration.Service()
        self.addCleanup(self.service.close)
        # A scrambled path may be a relative one: it must not land in the repository.
        self.service.cwd = str(self.media)
        self.service.start()
        video, image, srt = self.media / 'clip.mp4', self.media / 'still.png', self.media / 'lines.srt'
        integration.make_video(video, seconds=3)
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:size=64x64', '-frames:v', '1',
                        str(image)], check=True)
        srt.write_text('1\n00:00:00,000 --> 00:00:01,000\n자막\n')
        self.files = {'video': str(video), 'image': str(image), 'srt': str(srt), 'out': str(self.media / 'out.srt')}

    def baseline(self):
        """A small project with every kind of clip, a group, keyframes and markers."""
        s = self.service
        project = s.rpc('project.new', {'name': '퍼징'})
        project = s.rpc('media.importAndAdd', {'paths': [self.files['video'], self.files['image']]})
        video = next(m for m in project['media'] if m['kind'] == 'video')
        project = s.rpc('edit.add', {'mediaId': video['id'], 'trackId': 'audio-1', 'start': 0, 'duration': 2})
        project = s.rpc('edit.add', {'text': '글자', 'start': 0, 'duration': 2})
        first = project['clips'][0]['id']
        project = s.rpc('edit.batch', {'commands': [
            {'method': 'edit.update', 'params': {'id': first, 'patch': {
                'keyframes': [{'property': 'scale', 'time': 0, 'value': 1}, {'property': 'scale', 'time': 1, 'value': 1.5}],
                'transitionIn': {'type': 'fade', 'duration': 0.5}, 'audioFadeOut': 0.2}}},
            {'method': 'edit.marker', 'params': {'time': 1, 'label': '하나'}},
            {'method': 'edit.group', 'params': {'ids': [c['id'] for c in project['clips'][:2]]}}]})
        self.assertEqual({c['kind'] for c in project['clips']}, {'video', 'image', 'audio', 'text'})
        return project

    def send(self, label, method, params):
        """Sends one request. Returns the project when it was accepted, else None."""
        s = self.service
        try:
            status, value = s.call(method, params)
        except Exception as error:  # a dropped connection is what a panic looks like from here
            self.fail(f'seed {SEED} {label}: {method} {json.dumps(params, ensure_ascii=False)} -> {error!r}\n{s.output()}')
        if status not in (200, 400):
            self.fail(f'seed {SEED} {label}: {method} {json.dumps(params, ensure_ascii=False)} -> HTTP {status} {value}')
        if status == 400:
            self.assertTrue(isinstance(value, str) and value, (method, params, value))
        self.sent += 1
        self.accepted += status == 200
        return value if status == 200 and isinstance(value, dict) and 'clips' in value else None

    def check_alive(self, label):
        log = self.service.output_all()
        self.assertNotIn('panicked', log, f'seed {SEED} {label}: the service log has a panic line')
        self.assertIsNone(self.service.process.poll(), 'the service is still running')
        project = self.service.rpc('project.get')
        self.assertIn('clips', project)
        return project

    def test_scrambled_commands_are_refused_without_a_panic(self):
        random_ = random.Random(SEED)
        self.sent = self.accepted = 0
        project = self.baseline()
        clean = project

        def refresh(result):
            nonlocal project
            if result is not None:
                project = result
            # A long run would otherwise grow the project without bound, or empty it.
            if len(project['clips']) > 40 or len(project['clips']) < 2 or len(project['tracks']) > 12:
                project = self.baseline()

        for index in range(COUNT):
            fuzz = Fuzz(random_, project, self.files)
            method, params = fuzz.command()
            refresh(self.send(f'single #{index}', method, scrambled(random_, params)))
        project = self.check_alive('after single commands')
        refresh(None)

        for index in range(COUNT):
            fuzz = Fuzz(random_, project, self.files)
            method, params = fuzz.outside_batch()
            refresh(self.send(f'outside #{index}', method, scrambled(random_, params)))
            if index % 25 == 24:
                project = self.service.rpc('project.get')
                refresh(None)
        project = self.check_alive('after commands outside a batch')
        refresh(None)

        # Two commands: inside a batch nothing is checked between them, so the
        # second meets whatever shape the first left behind.
        for index in range(COUNT):
            fuzz = Fuzz(random_, project, self.files)
            first, second = fuzz.command(), fuzz.command()
            if random_.random() < 0.7:
                # Aim both at one clip, which is where an odd shape is met again.
                target = fuzz.clip()
                for _, params in (first, second):
                    if 'id' in params and params['id'] in [c['id'] for c in project['clips']]:
                        params['id'] = target
            kind = random_.random()
            if kind < 0.4:
                # One clip field of the wrong type, then any command on that clip.
                target = second[1].get('id', fuzz.clip())
                first = ('edit.update', {'id': target, 'patch': {random_.choice(CLIP_FIELDS): wrong(random_)}})
                first_params = first[1]
            elif kind < 0.5:
                # Pasted clips of any shape, then a command that walks the clips.
                pasted = [wrong(random_), scrambled(random_, copy.deepcopy(project['clips'][0]))]
                first = ('edit.paste', {'clips': pasted[:random_.choice([1, 2])], 'at': 5})
                first_params = first[1]
            else:
                first_params = scrambled(random_, first[1])
            commands = [{'method': first[0], 'params': first_params},
                        {'method': second[0], 'params': second[1] if random_.random() < 0.5
                         else scrambled(random_, second[1])}]
            params = {'commands': commands}
            if random_.random() < 0.05:
                params = scrambled(random_, params)
            refresh(self.send(f'batch #{index}', 'edit.batch', params))
        project = self.check_alive('after batches')

        # The project that survived all of it is still one the editor accepts, and
        # the baseline it started from can be reached again.
        self.assertGreater(self.accepted, 0, 'some commands were valid')
        self.assertLess(self.accepted, self.sent, 'some commands were refused')
        self.service.stop()
        self.service.start()
        reopened = self.service.rpc('project.get')
        self.assertEqual((reopened['id'], reopened['revision']), (project['id'], project['revision']))
        self.assertNotIn('panicked', self.service.output_all())
        self.assertEqual(clean['name'], '퍼징')
        print(f'\nfuzz seed {SEED}: {self.sent} requests, {self.accepted} accepted, '
              f'{self.sent - self.accepted} refused, 0 panics', file=sys.stderr)


if __name__ == '__main__':
    unittest.main()
