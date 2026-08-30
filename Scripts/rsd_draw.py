#!/usr/bin/env python3
"""rsd_draw.py - draw a Garmin .RSD the way a sounder draws it.

Personal use only, not for distribution or resale; not for navigation.

Ryan, seeing the first attempt: "those pics are horrible compared to what i see on the screen".
They were, and the reason is that the first renderer was a debug dump wearing a palette. Measured:

    channel      median     p90      p99     p99.9      max
    1 (side)      9,982   15,369   57,637   64,799   65,349
    2 (side)      9,386   12,891   15,510   44,579   65,333
    5 (down)      5,135   14,269   28,818   32,283   35,121

A linear stretch with p99 as the white point put the MEDIAN sample at 0.17 of full scale, so
almost every pixel came out the same mid-grey and the picture read as static. Amplitude is
heavy-tailed; a sounder has never displayed it linearly.

Three things a real display does, and this now does:

  LOG COMPRESSION. The screen shows something close to dB, so a return four times stronger is a
  step brighter rather than four steps. That alone separates bottom from water.

  TIME-VARIED GAIN. Return strength falls off with range, and the unit corrects for it before it
  draws. Measured on the down channel, the mean by range runs 916, 623, 643, 823, 4376, 19153 --
  the bottom -- then 12064, 6453, 6323, 6194, 5456, 3725, 2376, 1523, 15468 -- the second echo.
  Side imaging is flatter but still decays from 15,072 to 7,694 across the swath. TVG is computed
  from the file's own range profile rather than a curve somebody typed, and it is applied to the
  side beams, where the whole point is to compare across the swath, and NOT to the down channel,
  where the bottom is supposed to be the brightest thing on the page.

  BLACK AND WHITE POINTS FROM THE DATA. Percentiles of the LOG values, not the raw ones.

Resampling matters too: sonar is speckle, and Lanczos sharpens speckle into noise. Area averaging
is the honest reducer.
"""
import argparse, collections, math, os, struct

MARK = bytes.fromhex('ac8ef9')
TRAILER, CH, SEQ, SAMPLES = 11, 14, 16, 1024

PALETTES = {
    # Garmin's amber, and its blue, approximated as ramps through the same lightness steps.
    'amber': [(0, (6, 4, 2)), (0.18, (48, 20, 4)), (0.42, (140, 62, 8)),
              (0.68, (226, 128, 22)), (0.86, (250, 196, 92)), (1.0, (255, 246, 214))],
    'blue':  [(0, (2, 6, 18)), (0.20, (10, 34, 78)), (0.45, (18, 86, 150)),
              (0.70, (60, 158, 202)), (0.88, (158, 214, 232)), (1.0, (245, 252, 255))],
    'grey':  [(0, (0, 0, 0)), (1.0, (255, 255, 255))],
}


def ramp(name):
    stops = PALETTES[name]
    out = []
    for i in range(256):
        t = i / 255.0
        for k in range(len(stops) - 1):
            a, ca = stops[k]
            b, cb = stops[k + 1]
            if a <= t <= b:
                u = 0 if b == a else (t - a) / (b - a)
                out.append(tuple(int(ca[j] + (cb[j] - ca[j]) * u) for j in range(3)))
                break
        else:
            out.append(stops[-1][1])
    return out


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
                    's': struct.unpack_from('<%dH' % n, s, 0)})
    return out


def tvg_curve(pings, floor=1.0):
    """Mean amplitude at each range index, smoothed -- the file's own gain curve."""
    L = min(len(p) for p in pings)
    m = [0.0] * L
    for p in pings:
        for i in range(L):
            m[i] += p[i]
    n = float(len(pings))
    m = [v / n for v in m]
    w = max(3, L // 64)
    out = []
    for i in range(L):
        lo, hi = max(0, i - w), min(L, i + w + 1)
        out.append(max(floor, sum(m[lo:hi]) / (hi - lo)))
    return out


def to_bytes(pings, apply_tvg, lo_pct=1.0, hi_pct=99.5):
    # A sounder shows black water. Clipping only the bottom 1% leaves the water column a
    # mid-tone full of speckle, which is not what the screen looks like -- the black point
    # belongs above the noise floor, and on this recording the noise floor is most of the file.
    L = min(len(p) for p in pings)
    g = tvg_curve(pings) if apply_tvg else None
    logs = []
    for p in pings:
        row = []
        for i in range(L):
            v = p[i] / g[i] if g else p[i]
            row.append(math.log1p(v))
        logs.append(row)
    flat = sorted(v for r in logs for v in r)
    n = len(flat)
    lo = flat[min(n - 1, int(n * lo_pct / 100))]
    hi = flat[min(n - 1, int(n * hi_pct / 100))]
    if hi <= lo:
        hi = lo + 1e-6
    return [bytes(max(0, min(255, int(255 * (v - lo) / (hi - lo)))) for v in r) for r in logs]


def ppm(rows, pal, path):
    w, h = len(rows[0]), len(rows)
    with open(path, 'wb') as f:
        f.write(b'P6\n%d %d\n255\n' % (w, h))
        for r in rows:
            f.write(bytes(c for v in r for c in pal[v]))
    print('   %-30s %d x %d' % (path, w, h))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('path')
    ap.add_argument('--start', type=int, default=1 << 29)
    ap.add_argument('--read', type=int, default=20_000_000)
    ap.add_argument('--pings', type=int, default=900)
    ap.add_argument('--palette', default='amber', choices=sorted(PALETTES))
    # THE TWO VIEWS DO NOT SHARE LEVELS, and using one set for both is what crushed the side
    # scan to black. The down channel is mostly water -- a high black point is what makes the
    # water column dark and leaves the bottom bright. The side beams have already been flattened
    # by TVG, so the same black point throws away the whole swath and leaves only the nadir and
    # a few noise-burst pings. Separate defaults, each measured against its own histogram.
    ap.add_argument('--down-black', type=float, default=70.0)
    ap.add_argument('--down-white', type=float, default=99.7)
    ap.add_argument('--side-black', type=float, default=8.0)
    ap.add_argument('--side-white', type=float, default=99.4)
    ap.add_argument('--out-dir', default='_scratch')
    a = ap.parse_args()

    recs = records(a.path, a.start, a.read)
    by = collections.defaultdict(list)
    for r in recs:
        by[r['ch']].append(r)
    print('%d records: %s' % (len(recs), ', '.join('ch%d x%d' % (c, len(v))
                                                   for c, v in sorted(by.items()))))
    os.makedirs(a.out_dir, exist_ok=True)
    pal = ramp(a.palette)

    down = [r['s'] for r in by.get(5, [])[:a.pings]]
    if down:
        # No TVG: on the down view the bottom is meant to be the brightest thing on the page.
        cols = to_bytes(down, apply_tvg=False, lo_pct=a.down_black, hi_pct=a.down_white)
        rows = [bytes(cols[c][r] for c in range(len(cols))) for r in range(len(cols[0]))]
        ppm(rows, pal, os.path.join(a.out_dir, 'down.ppm'))

    p = {r['seq']: r['s'] for r in by.get(1, [])}
    s = {r['seq']: r['s'] for r in by.get(2, [])}
    shared = sorted(set(p) & set(s))[:a.pings]
    if shared:
        L = min(min(len(p[q]) for q in shared), min(len(s[q]) for q in shared))
        # One TVG for both beams, so port and starboard stay comparable.
        both = [list(p[q][:L]) for q in shared] + [list(s[q][:L]) for q in shared]
        conv = to_bytes(both, apply_tvg=True, lo_pct=a.side_black, hi_pct=a.side_white)
        half = len(shared)
        rows = [bytes(reversed(conv[i])) + conv[half + i] for i in range(half)]
        ppm(rows, pal, os.path.join(a.out_dir, 'side.ppm'))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
