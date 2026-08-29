#!/usr/bin/env python3
"""rsd_probe1.py - what IS a Garmin .RSD? Measured, not assumed.

Personal use only, not for distribution or resale; not for navigation.

Nothing here decodes anything. It samples windows out of the file and asks three questions whose
answers decide every later step:

  1. Is there a repeating record structure, and what is its stride?
  2. Are there GPS positions in it, and in which of Garmin's two semicircle conventions?
  3. Does the file start with a header the way GMP and MAR do (`<len> <signature>`), or not?

Question 2 is the one that matters. The project already knows Garmin writes coordinates as
semicircles -- GMP tiles in 2^24, MAR in 2^32 -- so a pair of int32s that decodes to water in the
Carolinas is not a coincidence, and finding one tells us the record layout without a single guess
about the rest of the bytes.
"""
import argparse, collections, os, struct, sys

# Where the boat can plausibly have been. Deliberately wide -- four states plus slop -- so this
# cannot manufacture a hit by aiming at one lake.
LAT = (30.0, 37.5)
LON = (-85.5, -75.0)


def decoders():
    """Both conventions Garmin uses, and plain degrees*1e7, which plenty of GPS formats use."""
    return [
        ('semicircle 2^31/180', lambda v: v * 180.0 / 2**31),
        ('semicircle 2^32/360', lambda v: v * 360.0 / 2**32),
        ('degrees * 1e7',       lambda v: v / 1e7),
        ('degrees * 1e5',       lambda v: v / 1e5),
    ]


def scan(buf, base, want_pairs=400):
    """Every offset where two consecutive int32 decode to a plausible lat/lon."""
    out = []
    n = len(buf) - 8
    for name, f in decoders():
        hits = []
        for off in range(0, n, 1):
            a, b = struct.unpack_from('<ii', buf, off)
            la, lo = f(a), f(b)
            if LAT[0] <= la <= LAT[1] and LON[0] <= lo <= LON[1]:
                hits.append((base + off, la, lo))
                if len(hits) >= want_pairs:
                    break
        if hits:
            out.append((name, hits))
    return out


def strides(hits):
    d = collections.Counter()
    for i in range(1, len(hits)):
        d[hits[i][0] - hits[i - 1][0]] += 1
    return d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('path')
    ap.add_argument('--window', type=int, default=1 << 20, help='bytes per sample window')
    ap.add_argument('--at', type=float, nargs='*', default=[0.0, 0.25, 0.5, 0.9])
    a = ap.parse_args()

    size = os.path.getsize(a.path)
    print('%s\n%d bytes (%.3f GiB)' % (os.path.basename(a.path), size, size / 2**30))
    print('1 GiB is %d; this file is %+d from it' % (2**30, size - 2**30))

    with open(a.path, 'rb') as fh:
        head = fh.read(4096)
        print('\n-- first 96 bytes --')
        for r in range(0, 96, 16):
            row = head[r:r + 16]
            print('  %04x  %-47s  %s' % (r, ' '.join('%02x' % b for b in row),
                                         ''.join(chr(c) if 32 <= c < 127 else '.' for c in row)))
        u16 = struct.unpack_from('<H', head, 0)[0]
        print('\n  u16 at 0x00 = %d; bytes at that offset: %r' % (u16, head[u16:u16 + 16]))
        asc = [(i, head[i:i + 12]) for i in range(0, 200)
               if all(32 <= c < 127 for c in head[i:i + 6]) and head[i:i + 6].isalpha()]
        print('  ascii runs in the first 200 bytes: %s' % (asc[:4] or 'NONE -- no signature'))

        for frac in a.at:
            off = min(int(size * frac), max(0, size - a.window))
            off -= off % 4
            fh.seek(off)
            buf = fh.read(a.window)
            print('\n== window at %.0f%% (offset %d, %d bytes) ==' % (frac * 100, off, len(buf)))
            found = scan(buf, off)
            if not found:
                print('   no plausible lat/lon pair in any convention')
                continue
            for name, hits in found:
                st = strides(hits)
                top = st.most_common(4)
                print('   %-22s %4d hit(s); first %s' % (name, len(hits),
                      '%d -> %.5f, %.5f' % hits[0]))
                print('   %-22s strides: %s' % ('', top))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
