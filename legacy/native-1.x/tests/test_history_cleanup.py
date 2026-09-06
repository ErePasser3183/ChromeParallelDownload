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
    staging={}
    for index,(gid,state) in enumerate(states.items()):
        path=root/(gid+'.bin');path.write_bytes(b'downloaded data');files.append(path)
        directory=root/'.ChromeParallelDownload'/f'{index:016x}';directory.mkdir(parents=True)
        (directory/path.name).write_bytes(b'partial data');staging[gid]=directory
        host.JOBS[gid]={'path':str(path) if gid in ('done','unacknowledged') else None,
            'dir':str(directory),'destination':str(root),'name':path.name}
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
    assert all(not staging[gid].exists() for gid in ('done','cancelled','failed'))
    assert all(staging[gid].exists() for gid in ('live','paused','waiting','unpublished','unacknowledged'))
print('Abandoned staging cleaned; final files, live tasks and completion handshake preserved: PASS')
