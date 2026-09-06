"""A slow local RPC must not spawn duplicate engines or block Chrome for 15 seconds."""
import importlib.util
from pathlib import Path
import tempfile
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('host', Path(__file__).resolve().parent.parent / 'native/host.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)

def check_transient_timeout():
    with patch.object(host, 'rpc', side_effect=[TimeoutError(), {'version': '1.37.0'}]), \
         patch.object(host.subprocess, 'Popen') as launch, \
         patch.object(host.subprocess, 'CREATE_NO_WINDOW', 0, create=True), \
         patch.object(host.time, 'sleep'):
        assert host.ensure_engine() == '1.37.0'
        assert not launch.called, 'A single temporary RPC timeout spawned another engine'

def check_deadline():
    clock = [0.0]
    def slow_rpc(*args, **kwargs):
        clock[0] += kwargs.get('timeout', 4)
        raise TimeoutError()
    process = Mock()
    process.poll.return_value = None
    with tempfile.TemporaryDirectory() as temp, \
         patch.object(host, 'ROOT', Path(temp)), \
         patch.object(host, 'engine_port_open', return_value=False), \
         patch.object(host, 'rpc', side_effect=slow_rpc), \
         patch.object(host.subprocess, 'Popen', return_value=process), \
         patch.object(host.subprocess, 'CREATE_NO_WINDOW', 0, create=True), \
         patch.object(host.time, 'monotonic', side_effect=lambda: clock[0]), \
         patch.object(host.time, 'sleep', side_effect=lambda duration: clock.__setitem__(0, clock[0] + duration)):
        try:
            host.ensure_engine()
        except (RuntimeError, OSError):
            pass
        assert clock[0] < 10, f'Local engine check blocked for {clock[0]:.1f}s; Chrome times out at 15s'
        assert process.terminate.called, 'Failed startup left an orphan engine'

def check_occupied_port():
    with tempfile.TemporaryDirectory() as temp, \
         patch.object(host, 'ROOT', Path(temp)), \
         patch.object(host, 'rpc', side_effect=TimeoutError), \
         patch.object(host, 'engine_port_open', return_value=True), \
         patch.object(host.subprocess, 'Popen') as launch, \
         patch.object(host.time, 'sleep'):
        try:
            host.ensure_engine()
            raise AssertionError('Unresponsive engine was reported healthy')
        except RuntimeError:
            pass
        assert not launch.called, 'An occupied RPC port caused another engine launch'

def check_startup_lock():
    with tempfile.TemporaryDirectory() as temp, patch.object(host, 'ROOT', Path(temp)):
        with host.engine_start_lock():
            try:
                with host.engine_start_lock():
                    raise AssertionError('Two hosts acquired the startup lock')
            except RuntimeError:
                pass
        with host.engine_start_lock():
            pass

def check_startup_success():
    process = Mock()
    process.poll.return_value = None
    with tempfile.TemporaryDirectory() as temp, \
         patch.object(host, 'ROOT', Path(temp)), \
         patch.object(host, 'engine_port_open', return_value=False), \
         patch.object(host, 'rpc', side_effect=[ConnectionRefusedError(), ConnectionRefusedError(), {'version': '1.37.0'}]), \
         patch.object(host.subprocess, 'Popen', return_value=process) as launch, \
         patch.object(host.subprocess, 'CREATE_NO_WINDOW', 0, create=True), \
         patch.object(host.time, 'sleep'):
        assert host.ensure_engine() == '1.37.0'
        assert launch.call_count == 1
        assert not process.terminate.called

if __name__ == '__main__':
    failures = []
    for check in [check_transient_timeout, check_deadline, check_occupied_port, check_startup_lock, check_startup_success]:
        try:
            check()
            print(check.__name__ + ': PASS')
        except AssertionError as error:
            print(check.__name__ + ': FAIL: ' + str(error))
            failures.append(check.__name__)
    if failures:
        raise SystemExit(1)
