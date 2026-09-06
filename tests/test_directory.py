"""Directory changes must not move active jobs or damage persisted configuration."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from unittest.mock import Mock, patch

source = Path(__file__).resolve().parent.parent / 'native' / 'host.py'
with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    config = root / 'config.json'
    config.write_text(json.dumps({'secret': 'test-only', 'port': 12345,
        'download_dir': str(root / 'old'), 'jobs_file': str(root / 'jobs.json')}), encoding='utf-8')
    with patch.dict(os.environ, {'CHROME_PARALLEL_DOWNLOAD_CONFIG': str(config)}):
        spec = importlib.util.spec_from_file_location('host', source)
        host = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(host)
    host.rpc = Mock(return_value='OK')
    def prepare(gid):
        host.prepare({'gid': gid, 'url': 'http://127.0.0.1/file', 'filename': '文件.bin', 'expected': 4})
        job = host.JOBS[gid]
        (Path(job['dir']) / job['name']).write_bytes(b'data')
        return job
    first = prepare('a' * 16)
    legacy = prepare('b' * 16)
    del legacy['destination']
    selected = root / '中文 下载目录'
    host.set_directory(str(selected))
    second = prepare('c' * 16)
    # Windows runners may normalize the temporary path's case or junctions
    # when host.py calls Path.resolve(); compare canonical paths on both sides.
    assert Path(first['destination']).resolve() == (root / 'old').resolve()
    assert Path(second['destination']).resolve() == selected.resolve()
    for gid, destination in [('a' * 16, root / 'old'), ('b' * 16, root / 'old'), ('c' * 16, selected)]:
        published = Path(host.publish(gid, {}))
        assert published.parent.resolve() == destination.resolve()
        assert published.read_bytes() == b'data'
    saved = config.read_text(encoding='utf-8')
    assert Path(json.loads(saved)['download_dir']).resolve() == selected.resolve()
    assert json.loads(saved)['secret'] == 'test-only'
    for invalid in ['', None, 'relative/folder', str(config)]:
        try:
            host.set_directory(invalid)
            raise AssertionError('Invalid directory accepted')
        except ValueError:
            pass
        assert config.read_text(encoding='utf-8') == saved
    with patch.object(host.tempfile, 'TemporaryFile', side_effect=PermissionError):
        try:
            host.set_directory(str(root / 'denied'))
            raise AssertionError('Unwritable directory accepted')
        except ValueError:
            pass
    assert config.read_text(encoding='utf-8') == saved
    process = Mock(returncode=0)
    process.poll.return_value = None
    with patch.object(host.subprocess, 'Popen', return_value=process) as launch, \
         patch.object(host.subprocess, 'CREATE_NO_WINDOW', 0, create=True):
        assert host.choose_directory() == {'choosing': True}
        host.choose_directory()
        assert launch.call_count == 1
        host.poll_picker()
        assert not process.communicate.called
        process.poll.return_value = 0
        process.communicate.return_value = (json.dumps({'directory': str(root / 'chosen')}), '')
        host.poll_picker()
        assert host.PICKER is None
        assert host.DEST == root / 'chosen'
    process.communicate.return_value = ('{"directory":""}', '')
    host.PICKER = process
    host.poll_picker()
    assert host.DEST == root / 'chosen'
    process.returncode = 1
    host.PICKER = process
    host.poll_picker()
    assert host.PICKER_ERROR
    host.set_directory(str(selected))
    assert host.PICKER_ERROR is None
print('Directory persistence, original/legacy job destinations, invalid paths and nonblocking picker: PASS')
