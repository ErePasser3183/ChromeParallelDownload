"""Exercise aria2's HTTP-400 RPC errors and resumable transport recovery."""
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import urllib.error
from unittest.mock import Mock, patch

source = Path(os.environ.get('HOST_SOURCE', Path(__file__).resolve().parent.parent / 'native/host.py'))
spec = importlib.util.spec_from_file_location('host', source)
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
host.CONFIG = {'port': 1, 'secret': 'test-only'}

def check_rpc_error():
    response = urllib.error.HTTPError('http://127.0.0.1:1/jsonrpc', 400, 'Bad Request', {},
        io.BytesIO(json.dumps({'error': {'code': 1, 'message': 'GID test is not found'}}).encode()))
    with patch.object(host.OPENER, 'open', side_effect=response):
        try:
            host.rpc('tellStatus', 'test')
            raise AssertionError('Error response accepted')
        except RuntimeError as error:
            assert 'not found' in str(error)

def check_terminal_cancel():
    def rpc(method, *args):
        if method == 'forceRemove': raise RuntimeError('GID cannot be removed now')
        if method == 'tellStatus': return {'status': 'error'}
        raise AssertionError(method)
    with patch.object(host, 'ensure_engine', return_value='1.37.0'), patch.object(host, 'rpc', side_effect=rpc):
        assert host.handle({'action': 'cancel', 'gid': 'a' * 16}) == {'gid': 'a' * 16}

def check_resume():
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        gid = 'a' * 16
        partial = root / 'file.7z'; partial.write_bytes(b'partial data')
        control = root / 'file.7z.aria2'; control.write_bytes(b'resume bitmap')
        host.JOBS = {gid: {'name': 'file.7z', 'dir': str(root), 'path': None, 'expected': 100}}
        host.JOBS_FILE = root / 'jobs.json'
        calls = []
        def rpc(method, *args):
            calls.append((method, args))
            if method == 'getOption': return {'split': '32', 'check-certificate': 'true'}
            if method == 'getFiles': return [{'uris': [{'uri': 'https://example.org/file.7z'}]}]
            return 'OK'
        with patch.object(host, 'rpc', side_effect=rpc):
            state = {'status': 'error', 'errorCode': '1', 'errorMessage': 'Got EOF from the server.', 'completedLength': '12'}
            assert host.retry_transfer(gid, state)
            added = next(args for method, args in calls if method == 'addUri')[1]
            assert added['gid'] == gid and added['continue'] == 'true'
            assert added['split'] == added['max-connection-per-server'] == '32'
            assert added['check-certificate'] == 'true'
            assert added['allow-overwrite'] == 'false'
            assert [method for method, _ in calls][-3:] == ['removeDownloadResult', 'addUri', 'unpause']
            assert partial.read_bytes() == b'partial data' and control.read_bytes() == b'resume bitmap'
            assert json.loads(host.JOBS_FILE.read_text(encoding='utf-8'))[gid]['retries'] == 1
            calls.clear()
            assert host.retry_transfer(gid, state)
            added = next(args for method, args in calls if method == 'addUri')[1]
            assert added['split'] == added['max-connection-per-server'] == '16'
            host.JOBS[gid]['retries'] = 3
            assert not host.retry_transfer(gid, state)
            host.JOBS[gid]['retries'] = 0
            assert not host.retry_transfer(gid, {**state, 'errorCode': '24', 'errorMessage': 'certificate verification failed'})
            assert not host.retry_transfer(gid, {**state, 'errorMessage': 'SSL/TLS handshake failure: certificate expired'})
            control.unlink()
            assert not host.retry_transfer(gid, state)

if __name__ == '__main__':
    failed = []
    for check in [check_rpc_error, check_terminal_cancel, check_resume]:
        try:
            check(); print(check.__name__ + ': PASS')
        except Exception as error:
            print(check.__name__ + ': FAIL: ' + type(error).__name__); failed.append(check.__name__)
    if failed: raise SystemExit(1)
