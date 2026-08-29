#!/usr/bin/env python3
"""rsd_image.py - draw a Garmin .RSD recording, all three channels, from 16-bit samples.

Personal use only, not for distribution or resale; not for navigation.

THE SAMPLES ARE 16-BIT LITTLE-ENDIAN, and mistaking them for 8-bit is what made the side beams
look like static. The tell is in the bytes:

    channel 5, first 48 sample bytes
      07 02 | c7 01 | f6 01 | 7c 01 | 1c 02 | 0d 01 | 68 02 | 2a 02 | 00 00 ...
      as u16 LE: 519, 455, 502, 380, 540, 269, 616, 554, 0 ...

    even-index bytes  mean 120.8, max 255      <- the low byte, using its full range
    odd-index bytes   mean  24.0, max 121      <- the high byte, small, as a high byte is

That is also the "negative lag-1, positive lag-2 correlation" from the first pass, which looked
like two interleaved streams and was nothing of the kind: it is one series of 16-bit numbers.
De-interleaving it destroyed the picture because half a number is not a signal. The down channel
drew a legible image ANYWAY, by luck -- alternating low and high bytes average out at display
scale -- which is exactly the sort of accident that stops an investigation one step early.

    channel 1   1,619 samples   side imaging, one side
    channel 2   1,619 samples   side imaging, the other
    channel 5   1,576 samples   down CHIRP

The three go down in one cycle -- 1, 5, 2 -- and share the u32 counter at body +16, which is what
pairs a port beam with its starboard.

Scaling is a percentile stretch with a gamma, because sonar amplitude is heavy-tailed and a
single hot return would otherwise flatten everything else to black.
"""
import argparse, collections, os, struct

MARK = bytes.fromhex('ac8ef9')
TRAILER, CH, SEQ, SAMPLES = 11, 14, 16, 1024


def records(path, start, nbytes):
    with open(path, 'rb') as fh:
        fh.seek(start)
        buf = fh.read(nbytes)
    marks, i = [], buf.find(MARK)
    while i >= 0:
        marks.append(i)
        i = buf.find(MARK, i + 1)
    out = []
    for k in range(1, len(marks)):
        p = marks[k]
        ln = struct.unpack_from('<I', buf, p + 3)[0]
        if ln != p - marks[k - 1]:
            continue
        b = buf[marks[k - 1] + TRAILER:p]
        if len(b) < SAMPLES + 64:
            continue
        s = b[SAMPLES:]
        n = len(s) // 2
        out.append({'ch': b[CH], 'seq': struct.unpack_from('<I', b, SEQ)[0],
                    'samples': list(struct.unpack_from('<%dH' % n, s, 0))})
    return out


def stretch(series, pct=99.0, gamma=0.62):
    flat = sorted(v for s in series for v in s)
    if not flat:
        return lambda v: 0
    hi = flat[min(len(flat) - 1, int(len(flat) * pct / 100.0))] or 1
    def f(v):
        t = min(1.0, v / hi)
        return int(255 * (t ** gamma))
    return f


def pgm(rows, path):
    w = min(len(r) for r in rows)
    with open(path, 'wb') as fh:
        fh.write(b'P5\n%d %d\n255\n' % (w, len(rows)))
        for r in rows:
            fh.write(bytes(r[:w]))
    print('   %-32s %d x %d' % (path, w, len(rows)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('path')
    ap.add_argument('--start', type=int, default=1 << 29)
    ap.add_argument('--read', type=int, default=20_000_000)
    ap.add_argument('--pings', type=int, default=900)
    ap.add_argument('--out-dir', default='_scratch')
    a = ap.parse_args()

    recs = records(a.path, a.start, a.read)
    by = collections.defaultdict(list)
    for r in recs:
        by[r['ch']].append(r)
    print('%d records: %s' % (len(recs),
          ', '.join('ch%d x%d (%d samples)' % (c, len(v), len(v[0]['samples']))
                    for c, v in sorted(by.items()))))
    os.makedirs(a.out_dir, exist_ok=True)

    # Down sonar: one COLUMN per ping, samples running down the page.
    down = [r['samples'] for r in by.get(5, [])[:a.pings]]
    if down:
        f = stretch(down)
        L = min(len(s) for s in down)
        rows = [bytes(f(down[c][r]) for c in range(len(down))) for r in range(L)]
        pgm(rows, os.path.join(a.out_dir, 'down.pgm'))

    # Side imaging: one ROW per ping, port reversed on the left so the nadir sits in the middle.
    p = {r['seq']: r for r in by.get(1, [])}
    s = {r['seq']: r for r in by.get(2, [])}
    shared = sorted(set(p) & set(s))[:a.pings]
    if shared:
        allsamp = [p[q]['samples'] for q in shared] + [s[q]['samples'] for q in shared]
        f = stretch(allsamp)
        rows = []
        for q in shared:
            L = min(len(p[q]['samples']), len(s[q]['samples']))
            rows.append(bytes([f(v) for v in reversed(p[q]['samples'][:L])]
                              + [f(v) for v in s[q]['samples'][:L]]))
        pgm(rows, os.path.join(a.out_dir, 'sidescan.pgm'))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
