#!/usr/bin/env python3
"""Generate solid-color (#2a6df4) RGBA PNG icons for the extension (pure stdlib)."""
import struct, zlib, os

def make_png(path, size, rgba=(0x2a, 0x6d, 0xf4, 0xff)):
    def chunk(typ, data):
        c = struct.pack('>I', len(data)) + typ + data
        return c + struct.pack('>I', zlib.crc32(typ + data) % (1 << 32))
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    raw = b''.join(b'\x00' + bytes(rgba) * size for _ in range(size))
    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', ihdr)
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)

os.makedirs('icons', exist_ok=True)
for size in (16, 48, 128):
    make_png(f'icons/icon{size}.png', size)
print('icons written')
