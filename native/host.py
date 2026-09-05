"""Chrome Native Messaging bridge. No remote service; no cookie storage."""
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import time
import urllib.request
import urllib.parse
import uuid

ROOT = Path(__file__).resolve().parent
CONFIG_FILE = Path(os.environ.get('CHROME_PARALLEL_DOWNLOAD_CONFIG', ROOT / 'config.json'))
CONFIG = json.loads(CONFIG_FILE.read_text(encoding='utf-8')) if CONFIG_FILE.exists() else {}
DEST = Path(CONFIG.get('download_dir', ROOT)).resolve()
STAGE = DEST / '.ChromeParallelDownload'
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
JOBS_FILE = Path(CONFIG.get('jobs_file', ROOT / 'jobs.json'))
JOBS = json.loads(JOBS_FILE.read_text(encoding='utf-8')) if JOBS_FILE.exists() else {}

def save_jobs():
    tmp = JOBS_FILE.with_suffix('.tmp')
    tmp.write_text(json.dumps(JOBS, ensure_ascii=False), encoding='utf-8')
    tmp.replace(JOBS_FILE)

def rpc(method, *args):
    body = json.dumps({'jsonrpc': '2.0', 'id': 'bridge', 'method': 'aria2.' + method,
                       'params': ['token:' + CONFIG['secret'], *args]}).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{CONFIG['port']}/jsonrpc", body,
                                 {'Content-Type': 'application/json'})
    with OPENER.open(req, timeout=4) as response:
        result = json.load(response)
    if 'error' in result:
        raise RuntimeError(result['error']['message'])
    return result['result']

def ensure_engine():
    try:
        return rpc('getVersion')['version']
    except (OSError, RuntimeError):
        subprocess.Popen([str(ROOT / 'aria2c-local64.exe'), '--conf-path=' + str(ROOT / 'aria2.conf')],
                         cwd=ROOT, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
        for _ in range(40):
            time.sleep(0.1)
            try:
                return rpc('getVersion')['version']
            except (OSError, RuntimeError):
                pass
        raise RuntimeError('下载引擎启动失败，请重新运行 install.ps1')

def safe_name(raw):
    name = re.split(r'[/\\]', str(raw))[-1]
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', name).strip(' .')[:180] or 'download.bin'
    if re.match(r'^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)', name, re.I):
        name = '_' + name
    return name

def validate_url(url):
    u = urllib.parse.urlsplit(url)
    if u.scheme not in ('http', 'https') or not u.hostname or u.username or u.password:
        raise ValueError('只接管普通 HTTP / HTTPS 下载')
    if any(ord(c) < 32 for c in url):
        raise ValueError('无效下载地址')
    return url

def prepare(msg):
    url = validate_url(msg['url'])
    gid = msg.get('gid', '')
    if not re.fullmatch('[0-9a-f]{16}', gid):
        raise ValueError('无效任务编号')
    if gid in JOBS:
        return {'gid': gid}
    directory = STAGE / gid
    directory.mkdir(parents=True, exist_ok=True)
    name = safe_name(msg.get('filename', 'download.bin'))
    options = {'gid': gid, 'dir': str(directory), 'out': name, 'pause': 'true',
               'split': str(max(1, min(64, int(msg.get('connections', 8))))),
               'max-connection-per-server': str(max(1, min(64, int(msg.get('connections', 8))))),
               'max-redirect': '0', 'auto-file-renaming': 'false', 'allow-overwrite': 'false'}
    if urllib.parse.urlsplit(url).hostname not in ('localhost', '127.0.0.1', '::1'):
        # Match the Windows explicit proxy when one is configured; PAC remains Chrome-only.
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                               r'Software\Microsoft\Windows\CurrentVersion\Internet Settings') as key:
                if winreg.QueryValueEx(key, 'ProxyEnable')[0]:
                    value = winreg.QueryValueEx(key, 'ProxyServer')[0]
                    if '=' in value:
                        proxies = dict(p.split('=', 1) for p in value.split(';') if '=' in p)
                        value = proxies.get(urllib.parse.urlsplit(url).scheme, '')
                    if value:
                        options['all-proxy'] = value if '://' in value else 'http://' + value
        except (OSError, ImportError):
            pass
    headers = msg.get('headers', {})
    # Cookies/authentication stay in Chrome. Only non-secret request context is forwarded.
    for key, option in [('user-agent', 'user-agent'), ('referer', 'referer')]:
        value = str(headers.get(key, ''))
        if '\n' in value or '\r' in value:
            raise ValueError('无效请求头')
        if value:
            options[option] = value
    rpc('addUri', [url], options)
    JOBS[gid] = {'name': name, 'dir': str(directory), 'expected': int(msg.get('expected', -1)),
                 'path': None}
    save_jobs()
    return {'gid': gid}

def publish(gid, status):
    job = JOBS[gid]
    if job['path']:
        return job['path']
    source = Path(job['dir']) / job['name']
    expected = job['expected']
    if expected > 0 and source.stat().st_size != expected:
        raise RuntimeError('文件大小与 Chrome 收到的大小不一致，已保留临时文件')
    DEST.mkdir(parents=True, exist_ok=True)
    stem, suffix = Path(job['name']).stem, Path(job['name']).suffix
    for index in range(10000):
        target = DEST / (job['name'] if index == 0 else f'{stem} ({index}){suffix}')
        try:
            # On Windows rename never overwrites an existing file.
            source.rename(target)
        except FileExistsError:
            continue
        job['path'] = str(target)
        save_jobs()
        try:
            Path(job['dir']).rmdir()
        except OSError:
            pass
        return str(target)
    raise RuntimeError('同名文件过多')

def statuses(gids):
    result = []
    for gid in gids[:100]:
        job = JOBS.get(gid)
        if not job:
            result.append({'gid': gid, 'status': 'missing'})
            continue
        if job['path']:
            result.append({'gid': gid, 'status': 'complete', 'path': job['path'],
                           'name': job['name'], 'totalLength': str(job['expected']),
                           'completedLength': str(job['expected']), 'downloadSpeed': '0'})
            continue
        try:
            state = rpc('tellStatus', gid, ['gid', 'status', 'totalLength', 'completedLength',
                        'downloadSpeed', 'connections', 'errorCode'])
            state['name'] = job['name']
            if state['status'] == 'complete':
                state['path'] = publish(gid, state)
            result.append(state)
        except Exception:
            result.append({'gid': gid, 'status': 'error', 'errorCode': 'bridge'})
    return result

def prune_history(keep):
    """Remove terminal metadata only. Downloaded and partial files are untouched."""
    keep = set(keep)
    removed = []
    for gid, job in list(JOBS.items()):
        if gid in keep:
            continue
        try:
            state = rpc('tellStatus', gid, ['status'])['status']
        except urllib.error.HTTPError as exc:
            try:
                message = json.load(exc).get('error', {}).get('message', '')
            except (ValueError, OSError):
                continue
            if 'not found' not in message.lower():
                continue
            state = 'missing'
        except (OSError, RuntimeError):
            continue
        if state not in ('complete', 'removed', 'error', 'missing'):
            continue
        # An unpublished successful download still needs its completion handshake.
        if state == 'complete' and not job.get('path'):
            continue
        if state != 'missing':
            try:
                rpc('removeDownloadResult', gid)
            except (OSError, RuntimeError):
                continue
        del JOBS[gid]
        removed.append(gid)
    if removed:
        save_jobs()
    return {'removed': len(removed)}

def handle(msg):
    action = msg.get('action')
    version = ensure_engine()
    if action == 'ping':
        return {'version': version, 'directory': str(DEST)}
    if action == 'prepare':
        return prepare(msg)
    if action == 'status':
        return statuses(msg.get('gids', []))
    if action == 'prune':
        return prune_history(msg.get('keep', []))
    gid = msg.get('gid')
    if action == 'cancel' and re.fullmatch('[0-9a-f]{16}', str(gid)):
        try:
            rpc('forceRemove', gid)
        except RuntimeError:
            pass  # A finished/missing task cannot continue transferring.
        return {'gid': gid}
    if gid not in JOBS:
        raise ValueError('任务不存在')
    if action in ('start', 'pause', 'cancel'):
        method = {'start': 'unpause', 'pause': 'forcePause', 'cancel': 'forceRemove'}[action]
        try:
            rpc(method, gid)
        except RuntimeError:
            if action != 'cancel':
                raise
        return {'gid': gid}
    if action == 'show':
        path = JOBS[gid]['path']
        if not path or not Path(path).is_file():
            raise ValueError('文件尚未完成或已移动')
        subprocess.Popen(['explorer.exe', '/select,', path])
        return {'shown': True}
    raise ValueError('未知操作')

def read_exact(stream, size):
    result = bytearray()
    while len(result) < size:
        chunk = stream.read(size - len(result))
        if not chunk:
            if result:
                raise EOFError('消息不完整')
            return None
        result.extend(chunk)
    return bytes(result)

def main():
    if os.name == 'nt':
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    while True:
        prefix = read_exact(sys.stdin.buffer, 4)
        if prefix is None:
            break
        size = struct.unpack('<I', prefix)[0]
        if size > 1024 * 1024:
            break
        msg = json.loads(read_exact(sys.stdin.buffer, size))
        try:
            response = {'id': msg.get('id'), 'ok': True, 'result': handle(msg)}
        except Exception as exc:
            # Never include request URLs, cookies or RPC secrets in errors.
            response = {'id': msg.get('id'), 'ok': False, 'error': type(exc).__name__ + ': 操作失败'}
        data = json.dumps(response, ensure_ascii=False).encode('utf-8')
        sys.stdout.buffer.write(struct.pack('<I', len(data)) + data)
        sys.stdout.buffer.flush()

if __name__ == '__main__':
    main()
