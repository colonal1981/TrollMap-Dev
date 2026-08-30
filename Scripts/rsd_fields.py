#!/usr/bin/env python3
"""rsd_fields.py - find depth and position by asking what tracks what.

Personal use only, not for distribution or resale; not for navigation.

Ryan: "are we able to get depth or location vs the bottom?"

Neither field is decoded, and neither needs to be GUESSED at, because the samples already answer
one of the two questions and can be used to interrogate the other.

  DEPTH. The down channel's bottom return is measurable directly -- it is the first sustained
  strong echo in the ping -- so every ping has a bottom index in samples, computed from the data
  rather than read from a field. Any header field that IS the depth must track that series
  almost perfectly. So: compute the bottom index per ping, then correlate every candidate field
  at every header offset against it. A correlation near +/-1 over hundreds of pings is not a
  coincidence, and its slope converts samples to feet.

  POSITION. A latitude does not jump. Over a few hundred pings at 12 Hz a boat moves a little,
  smoothly, in one direction. So a position field is one whose successive differences are small
  and consistent while the total drift is large -- a high ratio of net movement to total
  wandering. That test does not care what the units are, and it finds the field before anything
  is decoded. Semicircle and degree readings are then checked against the region.

Reports candidates ranked, and never claims one is depth or position -- it says what correlates
and how well, and leaves the reading to a person looking at a number they recognise.
"""
import argparse, collections, math, statistics as st, struct

MARK = bytes.fromhex('ac8ef9')
TRAILER, CH, SAMPLES = 11, 14, 1024
LAT, LON = (30.0, 37.5), (-85.5, -75.0)


def records(path, start, nbytes, want_ch):
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
        if len(b) < SAMPLES + 64 or b[CH] != want_ch:
            continue
        s = b[SAMPLES:]
        n = len(s) // 2
        out.append((b[:SAMPLES], struct.unpack_from('<%dH' % n, s, 0)))
    return out


def bottom_index(s, frac=0.45):
    """First sustained return above a fraction of this ping's own peak."""
    pk = max(s)
    if pk < 500:
        return None
    thr = pk * frac
    run = 0
    for i, v in enumerate(s):
        run = run + 1 if v >= thr else 0
        if run >= 8:
            return i - 7
    return None


def corr(x, y):
    if len(x) < 8:
        return 0.0
    mx, my = st.mean(x), st.mean(y)
    num = sum((a - mx) * (b - my) for a, b in zip(x, y))
    den = math.sqrt(sum((a - mx) ** 2 for a in x) * sum((b - my) ** 2 for b in y))
    return num / den if den else 0.0


def series(headers, off, kind):
    out = []
    for h in headers:
        try:
            if kind == 'u16':
                out.append(struct.unpack_from('<H', h, off)[0])
            elif kind == 'u32':
                out.append(struct.unpack_from('<I', h, off)[0])
            elif kind == 'i32':
                out.append(struct.unpack_from('<i', h, off)[0])
            else:
                v = struct.unpack_from('<f', h, off)[0]
                if v != v or abs(v) > 1e12:
                    return None
                out.append(v)
        except struct.error:
            return None
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('path')
    ap.add_argument('--start', type=int, default=1 << 29)
    ap.add_argument('--read', type=int, default=30_000_000)
    ap.add_argument('--pings', type=int, default=700)
    ap.add_argument('--scan', type=int, default=1024)
    a = ap.parse_args()

    recs = records(a.path, a.start, a.read, 5)[:a.pings]
    print('%d down-channel pings' % len(recs))
    idx, headers = [], []
    for h, s in recs:
        b = bottom_index(s)
        if b is not None:
            idx.append(b)
            headers.append(h)
    print('bottom found in %d of them: min %d, max %d, mean %.0f samples'
          % (len(idx), min(idx), max(idx), st.mean(idx)))

    print('\n== fields that TRACK the measured bottom (depth or range) ==')
    hits = []
    for kind in ('u16', 'u32', 'i32', 'f32'):
        step = 2 if kind == 'u16' else 4
        for off in range(0, min(a.scan, len(headers[0])) - step, 1):
            v = series(headers, off, kind)
            if not v or len(set(v)) < 8:
                continue
            r = corr(v, idx)
            if abs(r) > 0.90:
                hits.append((abs(r), r, off, kind, v))
    hits.sort(reverse=True)
    seen = set()
    for _, r, off, kind, v in hits[:14]:
        if (off // 4, kind) in seen:
            continue
        seen.add((off // 4, kind))
        # slope of value against bottom index -> the scale that converts samples to units
        mi, mv = st.mean(idx), st.mean(v)
        num = sum((i - mi) * (x - mv) for i, x in zip(idx, v))
        den = sum((i - mi) ** 2 for i in idx) or 1
        print('  +%-4d %-4s r=%+.4f   value %.4g..%.4g   %.6g per sample'
              % (off, kind, r, min(v), max(v), num / den))

    print('\n== fields that MOVE LIKE A POSITION (smooth, one direction) ==')
    cands = []
    for kind in ('i32', 'u32', 'f32'):
        for off in range(0, min(a.scan, len(headers[0])) - 4, 1):
            v = series(headers, off, kind)
            if not v or len(set(v)) < len(v) // 4:
                continue
            d = [abs(v[i] - v[i - 1]) for i in range(1, len(v))]
            total = sum(d)
            net = abs(v[-1] - v[0])
            if total <= 0 or net < total * 0.35:
                continue           # wanders more than it travels
            big = max(d)
            if big > total / len(d) * 60:
                continue           # one jump, not a track
            cands.append((net / total, off, kind, v))
    cands.sort(reverse=True)
    shown = 0
    for straight, off, kind, v in cands:
        if shown >= 12:
            break
        shown += 1
        note = ''
        if kind in ('i32', 'u32'):
            for nm, f in (('semicircle', lambda x: x * 180.0 / 2**31),
                          ('deg*1e7', lambda x: x / 1e7)):
                d0 = f(v[0])
                if LAT[0] <= d0 <= LAT[1]:
                    note = '   <-- %s reads %.5f, a LATITUDE here' % (nm, d0)
                elif LON[0] <= d0 <= LON[1]:
                    note = '   <-- %s reads %.5f, a LONGITUDE here' % (nm, d0)
        print('  +%-4d %-4s straightness %.3f   %.10g -> %.10g%s'
              % (off, kind, straight, v[0], v[-1], note))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
