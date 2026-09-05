"""Reproduce the local 64-connection variant from the exact official 1.37.0 binary.

Equivalent source change: src/OptionHandlerFactory.cc, NumberOptionHandler for
PREF_MAX_CONNECTION_PER_SERVER: upper bound 16 -> 64. Original binary is retained.
Only this numeric limit changes; TLS verification and network policy are intact.
Upstream source: https://github.com/aria2/aria2/tree/release-1.37.0
"""
from pathlib import Path
import hashlib

root = Path(__file__).resolve().parent
original = (root / 'aria2c.exe').read_bytes()
assert hashlib.sha256(original).hexdigest() == 'be2099c214f63a3cb4954b09a0becd6e2e34660b886d4c898d260febfe9d70c2', 'Unexpected upstream build'
# PE .text: VA 0x140001000 maps to raw 0x400.
# 0x1400e061a: mov qword ptr [rsp+0x28], 0x10 (constructor maximum).
# The following lea references the max-connection-per-server help string.
offset = 0x1400e061a - 0x140001000 + 0x400
assert original[offset:offset+16] == bytes.fromhex('48 c7 44 24 28 10 00 00 00 4c 8d 05 ee e6 39 00')
modified = bytearray(original)
modified[offset+5] = 64
assert sum(a != b for a, b in zip(original, modified)) == 1
target = root / 'aria2c-local64.exe'
if not target.exists() or target.read_bytes() != modified:
    target.write_bytes(modified)
print('Local upper limit: 64; exactly one numeric constant changed.')
print('SHA-256:', hashlib.sha256(modified).hexdigest())
