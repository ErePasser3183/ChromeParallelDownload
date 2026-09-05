"""Completed/abandoned staging is removed without touching final or live files."""
import importlib.util
import os
from pathlib import Path
import tempfile
from unittest.mock import patch

source=Path(os.environ.get('HOST_SOURCE',Path(__file__).resolve().parent.parent/'native/host.py'))
spec=importlib.util.spec_from_file_location('host',source)
host=importlib.util.module_from_spec(spec);spec.loader.exec_module(host)

def job(root, gid='a'*16):
    directory=root/'.ChromeParallelDownload'/gid;directory.mkdir(parents=True)
    (directory/'file.bin').write_bytes(b'data')
    (directory/'file.bin.aria2').write_bytes(b'resume data')
    host.JOBS_FILE=root/'jobs.json'
    return {'name':'file.bin','dir':str(directory),'destination':str(root),'expected':4,'path':None}

def completed():
    with tempfile.TemporaryDirectory() as temp:
        root=Path(temp);entry=job(root);host.JOBS={'a'*16:entry}
        output=Path(host.publish('a'*16,{}))
        assert output.read_bytes()==b'data'
        assert not (root/'.ChromeParallelDownload').exists(), 'Completed download left its control file or staging folder'

def terminal():
    with tempfile.TemporaryDirectory() as temp:
        root=Path(temp);host.JOBS={'a'*16:job(root)}
        with patch.object(host,'rpc',side_effect=lambda method,*args: {'status':'removed'} if method=='tellStatus' else 'OK'):
            host.prune_history([])
        assert not (root/'.ChromeParallelDownload').exists(), 'Abandoned download left partial files'

def live_and_locked():
    with tempfile.TemporaryDirectory() as temp:
        root=Path(temp);entry=job(root);host.JOBS={'a'*16:entry}
        for state in ['active','waiting','paused','complete']:
            with patch.object(host,'rpc',return_value={'status':state}):host.prune_history([])
            assert (Path(entry['dir'])/'file.bin').read_bytes()==b'data'
        with patch.object(host,'rpc',return_value={'status':'removed'}):
            host.prune_history(['a'*16])
            assert 'a'*16 in host.JOBS
            with patch.object(Path,'unlink',side_effect=PermissionError):host.prune_history([])
            assert 'a'*16 in host.JOBS, 'Cleanup failure dropped metadata needed for retry'
        with patch.object(host,'rpc',side_effect=lambda method,*args: {'status':'removed'} if method=='tellStatus' else 'OK'):
            host.prune_history([])
        assert not host.JOBS and not (root/'.ChromeParallelDownload').exists()

def boundary():
    with tempfile.TemporaryDirectory() as temp:
        root=Path(temp);entry=job(root)
        other=root/'unrelated';other.mkdir();(other/'file.bin').write_bytes(b'keep')
        assert not host.cleanup_staging({**entry,'dir':str(other)})
        assert (other/'file.bin').read_bytes()==b'keep'
        # An unrelated nested folder must never be recursively removed.
        nested=Path(entry['dir'])/'unrelated';nested.mkdir();(nested/'keep.txt').write_text('keep')
        assert not host.cleanup_staging(entry)
        assert (nested/'keep.txt').read_text()=='keep'
        # Final files outside staging always survive.
        final=root/'file.bin';final.write_bytes(b'final')
        assert final.read_bytes()==b'final'

if __name__=='__main__':
    failed=[]
    for check in [completed,terminal,live_and_locked,boundary]:
        try:check();print(check.__name__+': PASS')
        except Exception as error:print(check.__name__+': FAIL: '+str(error));failed.append(check.__name__)
    if failed:raise SystemExit(1)
