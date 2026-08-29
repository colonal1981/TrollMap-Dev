#!/usr/bin/env python3
"""rsd_walk.py - walk the Garmin .RSD record chain and prove it holds.

Personal use only, not for distribution or resale; not for navigation.

THE FRAMING, and how it was found rather than guessed:

Probe 2 saw twelve different 4-byte values each recurring exactly 41 times at a gap of exactly
12,736 bytes -- one header repeating verbatim while the sounder's settings held still. Probe 3
searched for the first of those, `AC 8E F9`, as a 3-byte marker and got gaps that clustered on
4,276 / 4,274 / 4,190 / 4,188 and, twice, 49.

Then the bytes after the marker said it outright:

    ac 8e f9 | b1 10 00 00 | ...        0x000010b1 = 4273   <- the measured gap
    ac 8e f9 | 31 00 00 00 | ...        0x00000031 =   49   <- the measured gap
    ac 8e f9 | 5e 10 00 00 | ...        0x0000105e = 4190   <- the last record in the file

So a record is `AC 8E F9` followed by a little-endian u32 length, and the length is the distance
to the next marker. Three records, three independent confirmations, and the file ends on one.

4,274 + 4,274 + 4,188 = 12,736. The stride probe 2 found is not a record -- it is one full cycle
of a dual-channel sounder logging two pings on one channel for every one on the other, which is
also why the gap counts came out 164 and 82, exactly two to one.

This walks the chain from the first marker to the end of the file, following each length, and
reports where it breaks. A chain that walks a gigabyte without losing sync is the framing; one
that desynchronises after four records is a coincidence.
"""
import argparse, collections, os, struct

MARK = bytes.fromhex('ac8ef9')
HDR = 7                      # 3 magic + 4 length


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('path')
    ap.add_argument('--start', type=int, default=0)
    ap.add_argument('--limit-bytes', type=int, default=0, help='0 = to end of file')
    ap.add_argument('--chunk', type=int, default=1 << 22)
    a = ap.parse_args()

    size = os.path.getsize(a.path)
    stop = size if not a.limit_bytes else min(size, a.start + a.limit_bytes)
    lens = collections.Counter()
    types = collections.Counter()
    n = 0
    breaks = []
    first = None

    with open(a.path, 'rb') as fh:
        fh.seek(a.start)
        head = fh.read(1 << 16)
        i = head.find(MARK)
        if i < 0:
            print('no marker within 64 KB of --start'); return 1
        pos = a.start + i
        first = pos
        print('first marker at %d' % pos)

        buf, buf_at = b'', -1
        while pos + HDR <= stop:
            if not (buf_at <= pos and pos + HDR <= buf_at + len(buf)):
                buf_at = pos
                fh.seek(buf_at)
                buf = fh.read(a.chunk)
                if len(buf) < HDR:
                    break
            o = pos - buf_at
            if buf[o:o + 3] != MARK:
                breaks.append(pos)
                if len(breaks) > 20:
                    print('chain lost sync more than 20 times; stopping'); break
                # Re-sync on the next marker so one bad record does not end the walk.
                j = buf.find(MARK, o + 1)
                if j < 0:
                    nxt = fh.read(a.chunk)
                    if not nxt:
                        break
                    buf, buf_at = buf[o:] + nxt, pos
                    continue
                pos = buf_at + j
                continue
            ln = struct.unpack_from('<I', buf, o + 3)[0]
            if ln < HDR or ln > (1 << 20):
                breaks.append(pos)
                pos += 1
                continue
            lens[ln] += 1
            types[buf[o + HDR] if o + HDR < len(buf) else -1] += 1
            n += 1
            pos += ln

    walked = pos - first
    print('\n%d records over %d bytes (%.3f GiB), %d resync(s)'
          % (n, walked, walked / 2**30, len(breaks)))
    print('ended at %d of %d -- %d bytes unwalked' % (pos, size, size - pos))
    print('\nrecord lengths, most common:')
    for ln, c in lens.most_common(12):
        print('   %-8d x %-8d  %5.1f%%' % (ln, c, 100.0 * c / max(1, n)))
    print('\ndistinct lengths: %d' % len(lens))
    print('first byte after the header (channel/type?):')
    for t, c in types.most_common(8):
        print('   0x%02x x %-8d  %5.1f%%' % (t, c, 100.0 * c / max(1, n)))
    if breaks:
        print('\nresync offsets: %s' % breaks[:20])
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
