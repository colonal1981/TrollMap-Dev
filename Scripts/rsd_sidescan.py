#!/usr/bin/env python3
"""rsd_sidescan.py - the three channels, each drawn as itself.

Personal use only, not for distribution or resale; not for navigation.

Ryan, 2026-08-29: "there should be 2 records simultaneously... regular chirp down sonar and side
scan or side imaging". That is exactly what the headers say, and it is why the larger block family
would not draw.

Body byte +14 is the channel:

    channel 1   ~4,274 byte blocks    side imaging, one side
    channel 2   ~4,274 byte blocks    side imaging, the other side
    channel 5   ~4,189 byte blocks    down CHIRP

and the file repeats a three-record cycle -- 1, 5, 2, 1, 5, 2 -- so one down ping and two side
beams go down together. Channels 1 and 2 appear 236 and 235 times in a 706-record sample: one to
one, which is what port and starboard have to be. That 2.1:1 ratio between the two block sizes was
never two channels. It was three.

The first attempt stacked every ~4,274 block into one image, so adjacent columns came from
OPPOSITE BEAMS and the picture was noise. Split on +14 and each beam is its own waterfall; put
them back to back, port reversed, and it is the side-scan view the unit draws.

The u32 at +16 increments once per cycle and is shared across the three records of that cycle, so
it pairs a port beam with its starboard.
"""
import argparse, collections, os, struct

MARK = bytes.fromhex('ac8ef9')
TRAILER = 11
CH = 14                 # body offset of the channel id
SEQ = 16                # body offset of the per-cycle counter (u32 LE)


def read_records(path, start, nbytes):
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
        body = buf[marks[k - 1] + TRAILER:p]
        if len(body) < 32:
            continue
        out.append({'len': ln, 'ch': body[CH],
                    'seq': struct.unpack_from('<I', body, SEQ)[0], 'body': body})
    return out


def pgm(cols, path):
    """cols is a list of equal-length byte strings, one per column."""
    h = min(len(c) for c in cols)
    w = len(cols)
    with open(path, 'wb') as f:
        f.write(b'P5\n%d %d\n255\n' % (w, h))
        for r in range(h):
            f.write(bytes(cols[c][r] for c in range(w)))
    print('   %-34s %d x %d' % (path, w, h))


def pgm_rows(rows, path):
    """rows is a list of equal-length byte strings, one per PING (across-track)."""
    w = min(len(r) for r in rows)
    h = len(rows)
    with open(path, 'wb') as f:
        f.write(b'P5\n%d %d\n255\n' % (w, h))
        for r in rows:
            f.write(bytes(r[:w]))
    print('   %-34s %d x %d' % (path, w, h))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('path')
    ap.add_argument('--start', type=int, default=1 << 29)
    ap.add_argument('--read', type=int, default=20_000_000)
    ap.add_argument('--sample-start', type=int, default=1024)
    ap.add_argument('--pings', type=int, default=900)
    ap.add_argument('--out-dir', default='_scratch')
    a = ap.parse_args()

    recs = read_records(a.path, a.start, a.read)
    kinds = collections.Counter((r['ch'], r['len']) for r in recs)
    print('%d records from offset %d' % (len(recs), a.start))
    for (ch, ln), n in sorted(kinds.items()):
        print('   channel %-3d len %-6d x %d' % (ch, ln, n))
    print('   cycle: %s' % ' '.join(str(r['ch']) for r in recs[:12]))

    os.makedirs(a.out_dir, exist_ok=True)
    by = collections.defaultdict(list)
    for r in recs:
        by[r['ch']].append(r)

    print('\nper-channel waterfalls (one column per ping):')
    for ch, rs in sorted(by.items()):
        cols = [r['body'][a.sample_start:] for r in rs[:a.pings]]
        L = min(len(c) for c in cols)
        pgm([c[:L] for c in cols], os.path.join(a.out_dir, 'rsd_ch%d.pgm' % ch))

    # Port and starboard, joined on the shared cycle counter, port reversed so the nadir
    # is in the middle -- which is how the unit draws it.
    p = {r['seq']: r for r in by.get(1, [])}
    s = {r['seq']: r for r in by.get(2, [])}
    shared = sorted(set(p) & set(s))[:a.pings]
    if shared:
        rows = []
        for q in shared:
            L = min(len(p[q]['body']), len(s[q]['body'])) - a.sample_start
            left = p[q]['body'][a.sample_start:a.sample_start + L][::-1]
            right = s[q]['body'][a.sample_start:a.sample_start + L]
            rows.append(left + right)
        print('\nside-scan, port reversed + starboard, %d paired pings:' % len(rows))
        pgm_rows(rows, os.path.join(a.out_dir, 'rsd_sidescan.pgm'))
    else:
        print('\nno ping counter shared between channels 1 and 2 -- pair them another way')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
