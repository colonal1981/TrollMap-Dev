#!/usr/bin/env python3
"""rsd_probe2.py - find the record boundary before guessing at any field.

Personal use only, not for distribution or resale; not for navigation.

Probe 1 looked for GPS positions as bare int32 semicircle pairs and found only noise -- about one
plausible pair per 5 KB, scattered, with no repeating stride, which is what random bytes give at
byte-granular alignment over a seven-degree box. So the file is not a flat array of position
records, and the next question is not "where is the latitude" but "where does one record end".

Two measurements, both cheap and neither a guess:

  * A PER-PING HEADER REPEATS ITSELF. Count every 4-byte value in a window; the ones that recur
    hundreds of times are candidate markers, and the GAPS between their occurrences are the
    record stride. A dominant gap is the answer; a flat gap histogram means that value is just a
    common byte pattern and not a marker.

  * SONAR AMPLITUDE IS NOT COMPRESSED. Entropy per window says whether we are looking at packed
    8-bit echo samples (6-7 bits/byte, and decodable) or a compressed container (7.9+, and a
    different project entirely).

The tail is dumped as well, because a fixed-size container usually keeps its index there, and
this file is 1 GiB plus 91,248 bytes -- a shape that wants explaining.
"""
import argparse, collections, math, os, struct


def entropy(b):
    c = collections.Counter(b)
    n = float(len(b))
    return -sum((v / n) * math.log2(v / n) for v in c.values())


def markers(buf, base, top=12, min_count=40):
    """4-byte values that recur, and the gaps between their occurrences."""
    seen = collections.Counter()
    step = 4
    # Aligned first: a record header is nearly always 4-byte aligned inside its own file.
    for off in range(0, len(buf) - 4, step):
        seen[buf[off:off + 4]] += 1
    out = []
    for val, n in seen.most_common(60):
        if n < min_count:
            break
        if len(set(val)) == 1:
            continue                     # runs of one byte are padding, not markers
        at = [o for o in range(0, len(buf) - 4, step) if buf[o:o + 4] == val]
        gaps = collections.Counter(at[i] - at[i - 1] for i in range(1, len(at)))
        g = gaps.most_common(3)
        # A marker's gaps concentrate. A common byte pattern's do not.
        share = (g[0][1] / max(1, len(at) - 1)) if g else 0.0
        out.append({'val': val.hex(), 'count': n, 'first': base + at[0],
                    'gaps': g, 'dominant_share': round(share, 3)})
    out.sort(key=lambda d: (-d['dominant_share'], -d['count']))
    return out[:top]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('path')
    ap.add_argument('--window', type=int, default=1 << 21)
    ap.add_argument('--at', type=float, nargs='*', default=[0.02, 0.5])
    a = ap.parse_args()

    size = os.path.getsize(a.path)
    with open(a.path, 'rb') as fh:
        for frac in a.at:
            off = min(int(size * frac), max(0, size - a.window))
            off -= off % 4
            fh.seek(off)
            buf = fh.read(a.window)
            print('== window at %.0f%% (offset %d, %d bytes) ==' % (frac * 100, off, len(buf)))
            print('   entropy %.2f bits/byte  (packed 8-bit sonar ~6-7; compressed 7.9+)'
                  % entropy(buf))
            for m in markers(buf, off):
                print('   %-8s x%-6d share %-6s first @%d  gaps %s'
                      % (m['val'], m['count'], m['dominant_share'], m['first'], m['gaps']))
            print()

        fh.seek(max(0, size - 512))
        tail = fh.read(512)
        print('-- last 128 bytes --')
        for r in range(len(tail) - 128, len(tail), 16):
            row = tail[r:r + 16]
            print('  %010d  %-47s  %s' % (size - len(tail) + r,
                  ' '.join('%02x' % b for b in row),
                  ''.join(chr(c) if 32 <= c < 127 else '.' for c in row)))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
