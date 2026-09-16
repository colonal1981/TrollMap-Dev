#!/usr/bin/env python3
"""rsd_samplestart.py - find where the echo samples really begin, per ping.

Personal use only, not for distribution or resale; not for navigation.

Every picture drawn so far sliced the samples at a FIXED 1024 bytes into the block, and Ryan spotted
the consequence before I did: "should not have lines like that... it should be crystal clear".

The header is a variable-length tag/value stream, so 1024 is wrong by a different amount every
ping. That is the same mistake that produced a globe-spanning bounding box when the position was
read at a fixed offset, and it was fixed there by anchoring on something the data itself proves.
Same fix here.

THE ANCHOR. The samples are u16 little-endian and modest in size, so their HIGH bytes -- every
second byte from the true start -- are small, while header and padding bytes are not:

    inside the sample array   odd-index bytes  mean ~24, max ~121
    anywhere else             no such structure

So the start is the earliest even offset from which that holds all the way to the end of the
block. Reading it at the wrong offset swaps high and low bytes and the test fails, which is what
makes it a test rather than a guess.

Prints the per-ping start and the resulting sample count, so a constant can be used if the count
turns out constant, and it can be measured per ping if not.
"""
import argparse, collections, statistics as st, struct

MARK = bytes.fromhex('ac8ef9')
TRAILER, CH = 11, 14


def blocks(path, start, nbytes):
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
        if len(b) > 512:
            out.append(b)
    return out


def sample_start(b, lo=200, hi=1400, win=600, hi_mean=45, hi_max=160):
    """Earliest even offset whose odd bytes stay small from there to the end."""
    n = len(b)
    best = None
    for o in range(lo, min(hi, n - win), 2):
        seg = b[o:o + win]
        highs = seg[1::2]
        if not highs:
            continue
        if st.mean(highs) <= hi_mean and max(highs) <= hi_max:
            # confirm it holds to the end, not just in this window
            tail = b[o:][1::2]
            if st.mean(tail) <= hi_mean + 8 and max(tail) <= hi_max + 40:
                best = o
                break
    return best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('path')
    ap.add_argument('--start', type=int, default=1 << 29)
    ap.add_argument('--read', type=int, default=12_000_000)
    ap.add_argument('--n', type=int, default=400)
    a = ap.parse_args()

    by = collections.defaultdict(list)
    for b in blocks(a.path, a.start, a.read):
        by[b[CH]].append(b)
    for ch in sorted(by):
        bs = by[ch][:a.n]
        starts, counts = [], []
        for b in bs:
            o = sample_start(b)
            if o is None:
                continue
            starts.append(o)
            counts.append((len(b) - o) // 2)
        if not starts:
            print('ch%-2d  no start found' % ch)
            continue
        cs = collections.Counter(starts)
        cc = collections.Counter(counts)
        print('ch%-2d  n=%d  body len %s' % (ch, len(bs),
              dict(collections.Counter(len(b) for b in bs).most_common(2))))
        print('      sample start : %s' % dict(cs.most_common(5)))
        print('      SAMPLE COUNT : %s' % dict(cc.most_common(5)))
        # sanity: read one at the winning start and show the first values
        o = cs.most_common(1)[0][0]
        b = next(x for x in bs if sample_start(x) == o)
        vals = struct.unpack_from('<%dH' % ((len(b) - o) // 2), b, o)
        print('      first 14 samples at +%d: %s' % (o, list(vals[:14])))
        print('      last 6: %s   max %d' % (list(vals[-6:]), max(vals)))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
