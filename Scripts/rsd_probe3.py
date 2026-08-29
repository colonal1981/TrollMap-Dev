#!/usr/bin/env python3
"""rsd_probe3.py - the record marker, its stride, and one whole header.

Personal use only, not for distribution or resale; not for navigation.

Probe 2 found it. In a 512 KB window at mid-file, TWELVE different 4-byte values each recurred
exactly 41 times at a gap of exactly 12,736 bytes -- which is not twelve markers, it is one
~110-byte header that repeats verbatim while the sounder's settings hold still. The first of them
is `AC 8E F9 5C`, and the last twelve bytes of the whole file are `... bc AC 8E F9 5E 10 00 00 68
19 c7 a8` -- the same three bytes with the fourth changed. So `AC 8E F9` is the frame marker and
the byte after it varies.

Entropy is 6.6-7.2 bits/byte across the file. That is packed 8-bit amplitude, not a compressed
container, which is the difference between "this can be drawn" and "this is a different project".

This probe stops guessing and measures the framing: every occurrence of the marker across several
windows, the distribution of gaps between them, and a full hex dump of one record's first 256
bytes with the constant and varying columns marked -- because a field that changes every ping is
a timestamp, a depth or a position, and a field that never changes is a setting.
"""
import argparse, collections, os, struct

MARK = bytes.fromhex('ac8ef9')


def find_all(buf, base):
    out, i = [], buf.find(MARK)
    while i >= 0:
        out.append(base + i)
        i = buf.find(MARK, i + 1)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('path')
    ap.add_argument('--window', type=int, default=1 << 20)
    ap.add_argument('--at', type=float, nargs='*', default=[0.0, 0.1, 0.3, 0.5, 0.75, 0.95])
    a = ap.parse_args()
    size = os.path.getsize(a.path)
    all_gaps = collections.Counter()
    sample_rec = None

    with open(a.path, 'rb') as fh:
        for frac in a.at:
            off = min(int(size * frac), max(0, size - a.window))
            fh.seek(off)
            buf = fh.read(a.window)
            hits = find_all(buf, off)
            gaps = collections.Counter(hits[i] - hits[i - 1] for i in range(1, len(hits)))
            all_gaps.update(gaps)
            print('%5.0f%%  offset %-11d  %4d marker(s)  gaps %s'
                  % (frac * 100, off, len(hits), gaps.most_common(5)))
            if sample_rec is None and len(hits) >= 3:
                sample_rec = hits[1]

        print('\nall windows, gap histogram: %s' % all_gaps.most_common(10))
        if not sample_rec:
            print('no record found to dump'); return 1

        # Two consecutive records, so a column that changes stands out from one that does not.
        fh.seek(sample_rec)
        n = max(all_gaps, key=all_gaps.get)
        a_rec = fh.read(min(n, 256))
        fh.seek(sample_rec + n)
        b_rec = fh.read(min(n, 256))
        print('\n-- two consecutive records at %d and %d, first %d bytes --'
              % (sample_rec, sample_rec + n, len(a_rec)))
        print('   ^ marks a byte that DIFFERS between the two pings\n')
        for r in range(0, len(a_rec), 16):
            ra, rb = a_rec[r:r + 16], b_rec[r:r + 16]
            diff = ''.join('^' if i < len(rb) and ra[i] != rb[i] else ' ' for i in range(len(ra)))
            print('  +%04x  %s' % (r, ' '.join('%02x' % c for c in ra)))
            print('         %s' % ' '.join('%s ' % d for d in diff))
        print('\n-- the same bytes read as little-endian u32, record A then B --')
        for o in range(0, min(64, len(a_rec) - 4), 4):
            va = struct.unpack_from('<I', a_rec, o)[0]
            vb = struct.unpack_from('<I', b_rec, o)[0] if o + 4 <= len(b_rec) else None
            flag = '' if vb is None else ('   same' if va == vb else '   DELTA %+d' % (vb - va))
            print('  +%02x  %-12d 0x%08x%s' % (o, va, va, flag))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
