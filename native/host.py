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
import tempfile
import socket
from contextlib import contextmanager

ROOT = Path(__file__).resolve().parent
CONFIG_FILE = Path(os.environ.get('CHROME_PARALLEL_DOWNLOAD_CONFIG', ROOT / 'config.json'))
CONFIG = json.loads(CONFIG_FILE.read_text(encoding='utf-8')) if CONFIG_FILE.exists() else {}
DEST = Path(CONFIG.get('download_dir', ROOT)).resolve()
STAGE = DEST / '.ChromeParallelDownload'
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
JOBS_FILE = Path(CONFIG.get('jobs_file', ROOT / 'jobs.json'))
JOBS = json.loads(JOBS_FILE.read_text(encoding='utf-8')) if JOBS_FILE.exists() else {}
PICKER = None
PICKER_ERROR = None

def set_directory(value):
    global DEST, STAGE, CONFIG, PICKER_ERROR
    if not isinstance(value, str) or not value.strip():
        raise ValueError('请输入完整的文件夹路径')
    directory = Path(value.strip()).expanduser()
    if not directory.is_absolute():
        raise ValueError('请使用绝对路径，例如 D:\\Downloads')
    try:
        directory = directory.resolve()
        directory.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryFile(dir=directory):
            pass
    except OSError as exc:
        raise ValueError('该目录无法写入，请选择其他文件夹') from exc
    updated = {**CONFIG, 'download_dir': str(directory)}
    temporary = CONFIG_FILE.with_suffix('.tmp')
    temporary.write_text(json.dumps(updated, ensure_ascii=False), encoding='utf-8')
    temporary.replace(CONFIG_FILE)
    CONFIG = updated
    DEST = directory
    STAGE = DEST / '.ChromeParallelDownload'
    PICKER_ERROR = None
    return {'directory': str(DEST)}

def choose_directory():
    global PICKER, PICKER_ERROR
    if PICKER is None:
        PICKER_ERROR = None
        PICKER = subprocess.Popen([sys.executable, str(ROOT / 'folder_picker.py'), str(DEST)],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding='utf-8', creationflags=subprocess.CREATE_NO_WINDOW)
    return {'choosing': True}

def poll_picker():
    global PICKER, PICKER_ERROR
    if PICKER is not None and PICKER.poll() is not None:
        process, PICKER = PICKER, None
        try:
            result = json.loads(process.communicate()[0])
            if process.returncode != 0 or result.get('error'):
                raise ValueError('无法打开目录选择器，请手动输入路径')
            if result.get('directory'):
                set_directory(result['directory'])
        except (ValueError, OSError):
            PICKER_ERROR = '目录选择未成功，请手动输入一个可写的完整路径'

def save_jobs():
    tmp = JOBS_FILE.with_suffix('.tmp')
    tmp.write_text(json.dumps(JOBS, ensure_ascii=False), encoding='utf-8')
    tmp.replace(JOBS_FILE)

def rpc(method, *args, timeout=4):
    body = json.dumps({'jsonrpc': '2.0', 'id': 'bridge', 'method': 'aria2.' + method,
                       'params': ['token:' + CONFIG['secret'], *args]}).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{CONFIG['port']}/jsonrpc", body,
                                 {'Content-Type': 'application/json'})
    try:
        with OPENER.open(req, timeout=timeout) as response:
            result = json.load(response)
    except urllib.error.HTTPError as exc:
        # aria2 also sends valid JSON-RPC errors with HTTP 400. Normalize them
        # so terminal/missing tasks can complete the Chrome fallback handshake.
        try:
            result = json.load(exc)
        except (ValueError, OSError):
            raise exc
        if not isinstance(result, dict) or 'error' not in result:
            raise exc
    if 'error' in result:
        raise RuntimeError(result['error']['message'])
    return result['result']

@contextmanager
def engine_start_lock():
    # Native hosts can overlap while Chrome reconnects. Only one may start aria2.
    with (ROOT / 'engine-start.lock').open('a+b') as lock:
        if lock.seek(0, 2) == 0:
            lock.write(b'0')
            lock.flush()
        lock.seek(0)
        if os.name == 'nt':
            import msvcrt
            acquire = lambda: msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            release = lambda: msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            acquire = lambda: fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            release = lambda: fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
        try:
            acquire()
        except OSError as exc:
            raise RuntimeError('下载引擎正在启动，请稍后重试') from exc
        try:
            yield
        finally:
            release()


def engine_port_open():
    try:
        with socket.create_connection(('127.0.0.1', CONFIG['port']), timeout=0.3):
            return True
    except OSError:
        return False


def ensure_engine():
    # Keep recovery below Chrome's 15-second Native Messaging timeout.
    deadline = time.monotonic() + 7
    for _ in range(2):
        try:
            return rpc('getVersion', timeout=1)['version']
        except (OSError, RuntimeError):
            time.sleep(0.1)
    with engine_start_lock():
        # An occupied port may mean a busy engine or a different installation.
        # Starting another process would not repair either situation.
        if engine_port_open():
            raise RuntimeError('下载引擎暂时无法响应，请稍后重试')
        process = subprocess.Popen([str(ROOT / 'aria2c-local64.exe'), '--conf-path=' + str(ROOT / 'aria2.conf')],
            cwd=ROOT, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    break
                try:
                    return rpc('getVersion', timeout=min(1, max(0.1, deadline - time.monotonic())))['version']
                except (OSError, RuntimeError):
                    time.sleep(0.1)
            raise RuntimeError('下载引擎启动失败，请重新运行 install.ps1')
        except Exception:
            # Reap only the process this call started, never an existing engine.
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=0.5)
                except subprocess.TimeoutExpired:
                    process.kill()
            raise

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
               'auto-file-renaming': 'false', 'allow-overwrite': 'false'}
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
                 'path': None, 'destination': str(DEST)}
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
    # Older jobs also keep their original volume: .../<destination>/.ChromeParallelDownload/<gid>.
    destination = Path(job.get('destination', Path(job['dir']).parent.parent))
    destination.mkdir(parents=True, exist_ok=True)
    stem, suffix = Path(job['name']).stem, Path(job['name']).suffix
    for index in range(10000):
        target = destination / (job['name'] if index == 0 else f'{stem} ({index}){suffix}')
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

def retry_transfer(gid, state):
    """Retry transient transport failures using the existing aria2 control file."""
    job = JOBS[gid]
    message = state.get('errorMessage', '').lower()
    transient = state.get('errorCode') == '2' or (
        state.get('errorCode') == '1' and (
            'got eof from the server' in message or
            ('ssl/tls handshake failure' in message and '(0)' in message)))
    if not transient or job.get('retries', 0) >= 3:
        return False
    control = Path(job['dir']) / (job['name'] + '.aria2')
    if int(state.get('completedLength', 0)) > 0 and not control.is_file():
        return False
    options = rpc('getOption', gid)
    files = rpc('getFiles', gid)
    urls = list(dict.fromkeys(uri['uri'] for file in files for uri in file.get('uris', [])))
    if not urls:
        return False
    for url in urls:
        validate_url(url)
    connections = max(1, int(options.get('split', 8)))
    if job.get('retries', 0) > 0:
        connections = max(1, connections // 2)
    options.update({'gid': gid, 'pause': 'true', 'continue': 'true',
                    'split': str(connections), 'max-connection-per-server': str(connections),
                    'dir': job['dir'], 'out': job['name'], 'auto-file-renaming': 'false',
                    'allow-overwrite': 'false'})
    job['retries'] = job.get('retries', 0) + 1
    job['note'] = f'连接中断，正从已有分片重试（{job["retries"]}/3），当前 {connections} 路'
    save_jobs()
    # Removing an aria2 result does not delete the partial file or control file.
    rpc('removeDownloadResult', gid)
    rpc('addUri', urls, options)
    rpc('unpause', gid)
    return True


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
                        'downloadSpeed', 'connections', 'errorCode', 'errorMessage'])
            if state['status'] == 'error' and retry_transfer(gid, state):
                state = rpc('tellStatus', gid, ['gid', 'status', 'totalLength', 'completedLength',
                            'downloadSpeed', 'connections', 'errorCode'])
            # URLs and server diagnostics stay inside the native host.
            state.pop('errorMessage', None)
            state['name'] = job['name']
            if job.get('note'):
                state['note'] = job['note']
            state['directory'] = job.get('destination', str(Path(job['dir']).parent.parent))
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
        except RuntimeError as exc:
            if 'not found' not in str(exc).lower():
                continue
            state = 'missing'
        except OSError:
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
    poll_picker()
    if action == 'set_directory':
        return set_directory(msg.get('directory'))
    if action == 'choose_directory':
        return choose_directory()
    version = ensure_engine()
    if action == 'ping':
        return {'version': version, 'directory': str(DEST), 'choosing': PICKER is not None,
                'directoryError': PICKER_ERROR}
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
            try:
                state = rpc('tellStatus', gid, ['status'])['status']
            except RuntimeError as exc:
                if 'not found' not in str(exc).lower():
                    raise
            else:
                if state not in ('complete', 'removed', 'error'):
                    raise RuntimeError('下载任务仍在运行，无法确认取消')
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
            message = str(exc) if msg.get('action') in ('set_directory', 'choose_directory') and isinstance(exc, ValueError) else type(exc).__name__ + ': 操作失败'
            response = {'id': msg.get('id'), 'ok': False, 'error': message}
        data = json.dumps(response, ensure_ascii=False).encode('utf-8')
        sys.stdout.buffer.write(struct.pack('<I', len(data)) + data)
        sys.stdout.buffer.flush()

if __name__ == '__main__':
    try:
        main()
    finally:
        if PICKER is not None and PICKER.poll() is None:
            PICKER.terminate()
