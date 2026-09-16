#!/usr/bin/env python3
"""rsd_sidevu.py - side imaging drawn as a plan view, with slant-range correction.

Personal use only, not for distribution or resale; not for navigation.

Ryan, on the first paired render: "nope that looks like down imaging in the wrong color", and
then "side imaging doesn't have the fish swirls like that". He is right about the picture and the
labelling holds; what was missing is the geometry.

THE CHANNELS ARE PORT AND STARBOARD, measured rather than assumed:

    r(ch1 ping, ch2 ping) on the SAME cycle      +0.428
    r(ch1 now, ch1 fifty cycles later)           +0.469     <- two unrelated patches of bottom
    r(ch1 now, ch1 next cycle)                   +0.603     <- the same patch, one ping apart

If the two channels were one view they would sit near +0.60. They sit BELOW the fifty-cycle
baseline, which is what two beams pointed at opposite sides of the boat look like. Their nadirs
agree at +0.897, as two beams of one ping must, and both sit at ~60 samples where the down
channel's bottom sits at ~406 -- so side imaging runs a range scale about 6.8x coarser, which is
how it covers a swath instead of a depth.

WHAT WAS MISSING: SLANT RANGE. A side beam measures distance along the sound path, not across the
ground. A return at sample r comes from a point that is

    x = sqrt(r^2 - n^2)          n = the nadir index, which IS the depth in samples

away from the track. Drawn without that correction every sample sits at its slant distance, the
bottom near the nadir is stretched outward, and features there curve into arcs -- the "fish
swirls" that do not belong in side imaging. Correcting it, and blanking the water column inside
the nadir, is what makes the image a picture of the lake bed.

The nadir is measured per ping rather than taken from a setting, so the correction follows the
bottom as the depth changes.
"""
import argparse, collections, math, os, struct

MARK = bytes.fromhex('ac8ef9')
TRAILER, CH, SAMPLES = 11, 14, 1024

GARMIN = [(0, (0, 0, 0)), (0.10, (4, 26, 8)), (0.30, (18, 84, 22)), (0.52, (60, 150, 30)),
          (0.72, (140, 200, 30)), (0.88, (208, 232, 40)), (1.0, (246, 252, 170))]


def ramp(stops):
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


def cycles(path, start, nbytes):
    with open(path, 'rb') as fh:
        fh.seek(start)
        buf = fh.read(nbytes)
    marks, i = [], buf.find(MARK)
    while i >= 0:
        marks.append(i)
        i = buf.find(MARK, i + 1)
    seq = []
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
        seq.append((b[CH], struct.unpack_from('<%dH' % n, s, 0)))
    out, i = [], 0
    while i + 2 < len(seq):
        if (seq[i][0], seq[i + 1][0], seq[i + 2][0]) == (1, 5, 2):
            out.append((seq[i][1], seq[i + 2][1]))
            i += 3
        else:
            i += 1
    return out


def nadir(s, frac=0.25, skip=5, run=8):
    pk = max(s)
    if pk < 600:
        return None
    thr = pk * frac
    c = 0
    for i in range(skip, len(s)):
        c = c + 1 if s[i] >= thr else 0
        if c >= run:
            return i - run + 1
    return None


def slant_correct(s, n, width):
    """Resample a beam from slant range onto uniform across-track distance."""
    L = len(s)
    far = math.sqrt(max(1.0, L * L - n * n))
    out = [0] * width
    for j in range(width):
        x = far * (j + 0.5) / width
        r = math.sqrt(x * x + n * n)
        i = int(r)
        if i >= L - 1:
            out[j] = 0
            continue
        f = r - i
        out[j] = int(s[i] * (1 - f) + s[i + 1] * f)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('path')
    ap.add_argument('--start', type=int, default=1 << 29)
    ap.add_argument('--read', type=int, default=20_000_000)
    ap.add_argument('--pings', type=int, default=1200)
    ap.add_argument('--width', type=int, default=700, help='pixels per side')
    ap.add_argument('--black', type=float, default=15.0)
    ap.add_argument('--white', type=float, default=98.5)
    ap.add_argument('--gap', type=int, default=6, help='black strip between the two beams')
    ap.add_argument('--out', default='_scratch/sidevu.ppm')
    a = ap.parse_args()

    cy = cycles(a.path, a.start, a.read)[:a.pings]
    print('%d port/starboard pairs' % len(cy))
    rows = []
    used = 0
    for port, star in cy:
        np_, ns = nadir(port), nadir(star)
        if np_ is None or ns is None:
            continue
        used += 1
        rows.append((slant_correct(port, np_, a.width),
                     slant_correct(star, ns, a.width)))
    print('%d with a nadir on both beams' % used)
    flat = sorted(v for p, s in rows for v in list(p) + list(s) if v > 0)
    logs_lo = math.log1p(flat[int(len(flat) * a.black / 100)])
    logs_hi = math.log1p(flat[min(len(flat) - 1, int(len(flat) * a.white / 100))])
    if logs_hi <= logs_lo:
        logs_hi = logs_lo + 1e-6

    def q(v):
        t = (math.log1p(v) - logs_lo) / (logs_hi - logs_lo)
        return max(0, min(255, int(255 * t)))

    pal = ramp(GARMIN)
    w = a.width * 2 + a.gap
    os.makedirs(os.path.dirname(a.out) or '.', exist_ok=True)
    with open(a.out, 'wb') as f:
        f.write(b'P6\n%d %d\n255\n' % (w, len(rows)))
        for p, s in rows:
            line = [q(v) for v in reversed(p)] + [0] * a.gap + [q(v) for v in s]
            f.write(bytes(c for v in line for c in pal[v]))
    print('-> %s  %d x %d' % (a.out, w, len(rows)))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
