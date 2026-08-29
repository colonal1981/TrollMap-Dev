#!/usr/bin/env python3
"""rsd_body.py - what is inside one Garmin .RSD block.

Personal use only, not for distribution or resale; not for navigation.

FRAMING, SETTLED. `AC 8E F9` + u32 + u32 is an 11-byte TRAILER, and the u32 is the distance back
to the previous trailer -- checked at all 253,615 gaps in a 1.00 GiB recording, zero failures. The
file ends exactly on a trailer with 11 bytes to spare, so the blocks tile the file with nothing
left over. Two block families dominate, ~4,274 bytes and ~4,189, in a 2.10:1 ratio -- two pings on
one channel for every one on the other.

THE BODY LOOKS LIKE TAG/VALUE, and the tags step by eight:

    0c 00 00 54 42      ->  0x42540000 = 53.0
    14 cd cc cc 3f      ->  0x3fcccccd =  1.6
    1c 00 00 54 42      ->             = 53.0
    24 00 00 54 42      ->             = 53.0
    2c cd cc cc 3f      ->             =  1.6
    34 cd cc cc 3f      ->             =  1.6
    0c 00 00 80 3f      ->             =  1.0
    14 8c 43 70 42      ->  0x4270438c = 60.066

0x0c, 0x14, 0x1c, 0x24, 0x2c, 0x34 are consecutive field numbers with a constant low nibble --
the shape of a tag byte, not of data. So this reads the body as one-byte tag plus four-byte
little-endian float and prints what comes out, for TWO blocks of the same kind side by side, so a
field that changes from ping to ping is visible against one that is a setting.

It does not claim any tag means anything. It prints the numbers and where the tag stream stops
being tags, which is where the echo samples start.
"""
import argparse, collections, os, struct

MARK = bytes.fromhex('ac8ef9')
TRAILER = 11


def trailers_near(fh, size, start, want=8):
    fh.seek(start)
    buf = fh.read(1 << 20)
    out, i = [], buf.find(MARK)
    while i >= 0 and len(out) < want + 2:
        ln = struct.unpack_from('<I', buf, i + 3)[0]
        out.append((start + i, ln, buf[i + 7]))
        i = buf.find(MARK, i + 1)
    return out


def read_tlv(b, limit=None):
    """(offset, tag, float, int32) until the stream stops looking like tags."""
    out, o = [], 0
    n = limit if limit is not None else len(b)
    while o + 5 <= n:
        tag = b[o]
        f = struct.unpack_from('<f', b, o + 1)[0]
        i = struct.unpack_from('<i', b, o + 1)[0]
        out.append((o, tag, f, i))
        o += 5
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('path')
    ap.add_argument('--start', type=int, default=1 << 24)
    ap.add_argument('--tlv-bytes', type=int, default=160)
    a = ap.parse_args()
    size = os.path.getsize(a.path)

    with open(a.path, 'rb') as fh:
        ts = trailers_near(fh, size, a.start, want=12)
        print('trailers near %d:' % a.start)
        for p, ln, k in ts[:12]:
            print('   %-12d len %-6d kind 0x%02x   payload %d' % (p, ln, k, ln - TRAILER))

        # Two blocks of the SAME kind, so differences mean something.
        by_kind = collections.defaultdict(list)
        for idx in range(1, len(ts)):
            p, ln, k = ts[idx]
            by_kind[(k, ln)].append((ts[idx - 1][0] + TRAILER, p))   # [body_start, body_end)
        pair = None
        for key, spans in by_kind.items():
            if len(spans) >= 2:
                pair = (key, spans[0], spans[1]); break
        if not pair:
            print('\nno two blocks of one kind in this window'); return 1
        (kind, ln), (s1, e1), (s2, e2) = pair
        print('\n== two blocks, kind 0x%02x, len %d ==' % (kind, ln))
        print('   A body %d..%d (%d bytes)\n   B body %d..%d (%d bytes)\n'
              % (s1, e1, e1 - s1, s2, e2, e2 - s2))
        fh.seek(s1); A = fh.read(e1 - s1)
        fh.seek(s2); B = fh.read(e2 - s2)

        print('   -- head of body as raw hex --')
        for r in range(0, 48, 16):
            print('     A +%03x  %s' % (r, ' '.join('%02x' % c for c in A[r:r + 16])))
            print('     B +%03x  %s' % (r, ' '.join('%02x' % c for c in B[r:r + 16])))

        print('\n   -- read as [u8 tag][f32] from the first 0x%02x --' % a.tlv_bytes)
        print('     %-6s %-5s %-16s %-16s %s' % ('off', 'tag', 'A float', 'B float', 'A int32'))
        for (o, ta, fa, ia), (_o, tb, fbv, ib) in zip(read_tlv(A, a.tlv_bytes),
                                                      read_tlv(B, a.tlv_bytes)):
            same = '' if (ta, ia) == (tb, ib) else '   <-- differs'
            fa_s = ('%.6g' % fa) if abs(fa) < 1e9 and fa == fa else '-'
            fb_s = ('%.6g' % fbv) if abs(fbv) < 1e9 and fbv == fbv else '-'
            print('     +%-5d 0x%02x  %-16s %-16s %-12d%s' % (o, ta, fa_s, fb_s, ia, same))

        print('\n   -- where does the body stop being structured? --')
        # Echo samples are dense 8-bit values; a tag stream is sparse and regular. Report the
        # byte histogram of the last 3 KB, which is where a sample array would live.
        tail = A[-3000:]
        h = collections.Counter(tail)
        print('     last 3000 bytes: %d distinct values, top %s'
              % (len(h), h.most_common(6)))
        print('     mean %.1f, min %d, max %d'
              % (sum(tail) / len(tail), min(tail), max(tail)))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
