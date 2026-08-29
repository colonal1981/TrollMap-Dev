#!/usr/bin/env python3
"""rsd_frames.py - prove the Garmin .RSD framing across the whole file.

Personal use only, not for distribution or resale; not for navigation.

WHAT THE MARKER ACTUALLY IS

`AC 8E F9` is followed by a little-endian u32, and the obvious reading -- that it is the length of
the record starting here -- is wrong, which is why a forward walk desynchronised every few
records. Measured over eighteen consecutive markers, every single one satisfies

    u32_at(p + 3)  ==  p - p_previous

The number is the size of the block that ENDS here, not the one that starts. So this is a
TRAILER: the sounder appends a ping's data and then writes a small record saying how big it was.
That is what a device logging in real time to a card does, because a file truncated by a flat
battery is still walkable backwards to the last complete ping, and it is why the very last twelve
bytes of the file are a trailer (`ac 8e f9 5e 10 00 00 ...`, 0x105e = 4190) rather than data.

Four trailer kinds appear, each with a fixed size and its own 4-byte constant at +7:

    0x4d ...    49 bytes    d7a45d4d
    0x06 ...  4273 bytes    26db4806
    0x9a ...  3993 bytes    54272b9a
    0x34 ...  4276 bytes    1105b834

This scans the entire file, checks that equation at every marker, and reports every place it
fails. A rule that holds for eighteen records is a hypothesis; one that holds for a quarter of a
million is the format.
"""
import argparse, collections, os, struct, sys, time

MARK = bytes.fromhex('ac8ef9')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('path')
    ap.add_argument('--chunk', type=int, default=1 << 24)
    ap.add_argument('--max-bad', type=int, default=25)
    ap.add_argument('--out', default=None, help='write the marker table here (npy-free, tsv)')
    a = ap.parse_args()

    size = os.path.getsize(a.path)
    t0 = time.time()
    prev = None
    n = bad = 0
    kinds = collections.Counter()
    lens = collections.Counter()
    bad_at = []
    first = None
    out = open(a.out, 'w') if a.out else None
    if out:
        out.write('# offset\tlen\tkind\tconst\n')

    with open(a.path, 'rb') as fh:
        carry = b''
        base = 0
        while True:
            chunk = fh.read(a.chunk)
            if not chunk:
                break
            buf = carry + chunk
            # A trailer is 11 bytes; keep that much back so one never straddles a chunk edge.
            limit = len(buf) - 11
            i = buf.find(MARK)
            while 0 <= i <= limit:
                p = base + i
                ln = struct.unpack_from('<I', buf, i + 3)[0]
                kind = buf[i + 7]
                const = buf[i + 7:i + 11].hex()
                if prev is not None:
                    if ln != p - prev:
                        bad += 1
                        if len(bad_at) < a.max_bad:
                            bad_at.append((p, ln, p - prev))
                else:
                    first = p
                kinds[(kind, ln, const)] += 1
                lens[ln] += 1
                prev = p
                n += 1
                if out:
                    out.write('%d\t%d\t%d\t%s\n' % (p, ln, kind, const))
                i = buf.find(MARK, i + 1)
            keep = max(0, len(buf) - 11)
            carry = buf[keep:]
            base += keep
    if out:
        out.close()

    print('%s\n%d bytes, scanned in %.1fs' % (os.path.basename(a.path), size, time.time() - t0))
    print('\n%d trailers found; first at %d, last at %d' % (n, first, prev))
    print('%d of %d fail  u32(p+3) == p - p_prev   (%.4f%%)'
          % (bad, n - 1, 100.0 * bad / max(1, n - 1)))
    if bad_at:
        print('  first failures (offset, said, actual):')
        for x in bad_at:
            print('    %d  said %d  actual %d' % x)
    print('\ntrailer kinds:')
    for (k, ln, const), c in kinds.most_common(12):
        print('   0x%02x  len %-6d const %-10s x %-8d  %5.2f%%'
              % (k, ln, const, c, 100.0 * c / n))
    covered = prev - first if first is not None else 0
    print('\nrecords span %d bytes of %d -- %d before the first trailer, %d after the last'
          % (covered, size, first or 0, size - (prev or 0)))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
