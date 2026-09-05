import importlib.util
import json
from pathlib import Path
import tempfile
import os

root=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('host',root/'native'/'host.py')
host=importlib.util.module_from_spec(spec);spec.loader.exec_module(host)
with tempfile.TemporaryDirectory() as temp:
    root=Path(temp);files=[]
    states={'done':'complete','cancelled':'removed','failed':'error','live':'active',
            'paused':'paused','waiting':'waiting','unpublished':'complete','unacknowledged':'complete'}
    host.JOBS={}
    for gid,state in states.items():
        path=root/(gid+'.bin');path.write_bytes(b'downloaded data');files.append(path)
        host.JOBS[gid]={'path':str(path) if gid in ('done','unacknowledged') else None}
    host.JOBS_FILE=root/'jobs.json'
    removed=[]
    def rpc(method,gid,*args):
        if method=='tellStatus':return {'status':states[gid]}
        if method=='removeDownloadResult':removed.append(gid);return 'OK'
        raise AssertionError(method)
    host.rpc=rpc
    result=host.prune_history(['unacknowledged'])
    assert result=={'removed':3}
    assert set(removed)=={'done','cancelled','failed'}
    assert set(host.JOBS)=={'live','paused','waiting','unpublished','unacknowledged'}
    assert set(json.loads(host.JOBS_FILE.read_text()))==set(host.JOBS)
    assert all(path.read_bytes()==b'downloaded data' for path in files)
print('Terminal metadata cleared; live/paused/waiting/completion handshake and every file preserved: PASS')
