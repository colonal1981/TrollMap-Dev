#!/usr/bin/env python3
"""rsd_render.py - draw the echo samples and find out whether this is a sonar picture.

Personal use only, not for distribution or resale; not for navigation.

Entropy across one 4,263-byte block, in 256-byte windows:

    +0000  4.63  78 distinct   mean  60      <- structured header, tag/value
    +0256  0.00   1 distinct   mean   0      <- 768 bytes of zero
    +0768  0.00   1 distinct
    +1024  2.94  66 distinct   mean  30      <- nearfield: the blanked water column
    +1280  6.52 121 distinct   mean  88      <- echo samples, full 0-255
    ...    ~6.4 all the way to the end

That is the shape of a ping and nothing else: a header, reserved space, a quiet nearfield, then
amplitude. So this takes the tail of N consecutive blocks of ONE kind, stands each up as a column,
and writes them side by side as a greyscale image. If the format is what the entropy says, a
bottom line appears without anyone having to decode a single field.

No dependencies -- it writes a binary PGM, which every image tool reads.
"""
import argparse, os, struct

MARK = bytes.fromhex('ac8ef9')
TRAILER = 11


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('path')
    ap.add_argument('--start', type=int, default=1 << 29)
    ap.add_argument('--columns', type=int, default=900)
    ap.add_argument('--kind', type=lambda s: int(s, 0), default=0xe8)
    ap.add_argument('--sample-start', type=int, default=1024,
                    help='byte offset in the body where the samples begin')
    ap.add_argument('--out', default='rsd_preview.pgm')
    a = ap.parse_args()

    size = os.path.getsize(a.path)
    cols, height = [], None
    with open(a.path, 'rb') as fh:
        fh.seek(a.start)
        # Enough bytes for `columns` blocks of ~4.3 KB, plus slack for the other channel.
        buf = fh.read(min(size - a.start, a.columns * 14000 + (1 << 20)))
    base = a.start
    marks = []
    i = buf.find(MARK)
    while i >= 0:
        marks.append(i)
        i = buf.find(MARK, i + 1)

    for k in range(1, len(marks)):
        p = marks[k]
        ln = struct.unpack_from('<I', buf, p + 3)[0]
        kind = buf[p + 7]
        if ln != p - marks[k - 1] or kind != a.kind:
            continue
        body = buf[marks[k - 1] + TRAILER:p]
        s = body[a.sample_start:]
        if not s:
            continue
        if height is None:
            height = len(s)
        if len(s) != height:
            continue
        cols.append(s)
        if len(cols) >= a.columns:
            break

    if not cols:
        print('no blocks of kind 0x%02x found at %d' % (a.kind, a.start))
        return 1
    w, h = len(cols), height
    print('%d columns x %d samples, from offset %d, kind 0x%02x' % (w, h, a.start, a.kind))
    with open(a.out, 'wb') as f:
        f.write(b'P5\n%d %d\n255\n' % (w, h))
        for row in range(h):
            f.write(bytes(cols[c][row] for c in range(w)))
    print('-> %s (%d bytes)' % (a.out, os.path.getsize(a.out)))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
