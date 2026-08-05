#!/usr/bin/env python3
"""dump_lbl_pool.py - print a GMP tile's label pool as plain text.

Personal use only, not for distribution or resale; not for navigation.

    py .\\dump_lbl_pool.py "F:\\TrollMapPipeline\\garmin\\charts\\Tiles\\00\\54\\4B13F\\B4B13F.GMP"
    py .\\dump_lbl_pool.py <tile.GMP> --navaids-only
    py .\\dump_lbl_pool.py <dir> --walk --navaids-only     # every B tile under a directory

WHAT THIS SETTLES

`AGENT_GUIDE.md` records the LBL section as unparsed, with the note that *"the LBL section
header at 0x409 reports a length of 335,742,954 on a 2.4 MB file, so the length field is not at
the offset assumed here."* It flags label decoding as "the highest-value unstarted work in the
project", and it is the single root cause under four separate symptoms:

  * mode 3/1 -- 15,430 `place_name` records, categorically 0% named
  * 58% of all decoded POIs carry no name at all
  * `navaid_ref_unresolved` firing
  * navaids unclassifiable, because NAVAID_CLASS matches on a name string it never receives

THE HEADER, MAPPED (B4E0F1, 2026-08-06)

    0x409 +0    u16   0x02bf = 703      <- SUBHEADER LENGTH. The old parse assumed ~30 bytes and
                                           read a pool descriptor as the section length. That is
                                           where 335,742,954 came from.
          +2    char[10] "GMAPMF LBL"
          +12   u16   version
          +14   7 bytes date
          +21   u32   pool offset       <- 2,454,152 on B4E0F1
          +25   u32   pool length       <- 5,736
          +29   u8    offset multiplier <- 1, i.e. ref << 1 = "ref*2", which is what
                                           rgn4_pois.py already does for pool-1
          +30   u8    label coding      <- 9
          +31.. a table of ~11-byte pool descriptors to the end of the 703-byte header. Most
                point at a sentinel (0x25add7 on B4E0F1) meaning "empty". Four are real.

THE POOL IS PLAIN TEXT. Null-separated, uncompressed. B4E0F1 yields 183 strings -- every place
name, county, marina, and navaid label in the tile. No huffman, no 6-bit packing, nothing to
crack. Resolving a label is an index lookup.

WHY WATEREE HAS NO LIGHTS OR BEACONS

It is an inland lake. Its navaid labels are `Hazard, Spar/Spindle Buoy`, `No Wake, ...`,
`No Boats, ...`, `Water Intake Keep Clear, ...`, `Fish Attractor Buoy, ...`. That is the correct
and complete set for that water. The absence of `Light` and `Beacon` card-wide was read as a
decode failure; on this tile it is simply the truth.

**Run this on a COASTAL tile before concluding anything about lights and beacons.** If a
Charleston or Beaufort tile's pool contains them, the strings exist and the gap is in reference
resolution. If it does not, they are not in the LBL pool at all and the type-code theory --
navaids as a typed class with NOAA/IALA symbol tables, per Garmin's own ActiveCaptain UI --
is the live one after all.
"""
import argparse, os, re, struct, sys

SENTINEL_SLACK = 64          # a pool whose length is under this is a sentinel, not data
NAVAID_HINT = re.compile(
    r'buoy|beacon|light|marker|daybeacon|wake|hazard|caution|warning|prohibit|'
    r'restricted|danger|keep clear|no boats|swim|intake|obstruct|spar|spindle|'
    r'can\b|nun\b|bell|gong|whistle|racon|lateral|cardinal|fairway|isolated',
    re.I)


def lbl_pools(path):
    """Every (offset, length, multiplier, coding) pool descriptor in a tile's LBL subheader."""
    d = open(path, 'rb').read()
    # Find the LBL section by scanning the GMP header for a u32 that POINTS AT one, rather than
    # trusting a fixed field position. The offsets are not on a regular stride -- on B4E0F1 they
    # sit at 0x14, 0x19, 0x1d, 0x21 -- and assuming 4-byte alignment reads 0xf0 as 0xf000, which
    # is the same class of off-by-one that produced the "335,742,954 byte LBL section" note.
    lbl = None
    for i in range(0x10, 0x3d):
        if i + 4 > len(d):
            break
        v = struct.unpack_from('<I', d, i)[0]
        if 0 < v < len(d) - 12 and d[v + 2:v + 12] == b'GMAPMF LBL':
            lbl = v
            break
    if lbl is None:
        return d, None, []

    hlen = struct.unpack_from('<H', d, lbl)[0]
    mult = d[lbl + 29] if lbl + 29 < len(d) else None
    coding = d[lbl + 30] if lbl + 30 < len(d) else None

    pools, seen = [], set()
    for i in range(21, min(hlen, len(d) - lbl) - 8):
        off, ln = struct.unpack_from('<II', d, lbl + i)
        if 0x1000 < off < len(d) and SENTINEL_SLACK <= ln <= len(d) - off and (off, ln) not in seen:
            seen.add((off, ln))
            pools.append((off, ln))
    return d, (lbl, hlen, mult, coding), pools


def strings_in(blk):
    out = []
    for part in blk.split(b'\x00'):
        if len(part) < 3:
            continue
        try:
            s = part.decode('ascii')
        except UnicodeDecodeError:
            continue
        if re.fullmatch(r"[A-Za-z0-9 ,./'()\-&#]+", s):
            out.append(s)
    return out


def one(path, navaids_only, quiet=False):
    d, hdr, pools = lbl_pools(path)
    name = os.path.basename(path)
    if not hdr:
        if not quiet:
            print('%s: no GMAPMF LBL section found' % name)
        return []
    lbl, hlen, mult, coding = hdr
    if not quiet:
        print('%s  LBL at 0x%x  subheader %d bytes  multiplier=%s (ref<<%s)  coding=%s  %d real pool(s)'
              % (name, lbl, hlen, mult, mult, coding, len(pools)))
    found = []
    for off, ln in pools:
        ss = strings_in(d[off:off + ln])
        if not ss:
            continue
        hits = [s for s in ss if NAVAID_HINT.search(s)] if navaids_only else ss
        if not hits:
            continue
        if not quiet:
            print('   pool @%d (%d bytes): %d strings, %d shown' % (off, ln, len(ss), len(hits)))
            for s in hits:
                print('      %s' % s)
        found += hits
    return found


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('path', help='a .GMP tile, or a directory with --walk')
    ap.add_argument('--navaids-only', action='store_true',
                    help='only strings that look like a charted aid or a regulatory marker')
    ap.add_argument('--walk', action='store_true', help='recurse, B tiles only')
    ap.add_argument('--limit', type=int, default=0)
    a = ap.parse_args()

    if not a.walk:
        one(a.path, a.navaids_only)
        return

    import collections
    vocab = collections.Counter()
    n = 0
    for dp, _dn, fn in os.walk(a.path):
        for f in sorted(fn):
            if not (f.upper().endswith('.GMP') and f[0].upper() == 'B'):
                continue
            for s in one(os.path.join(dp, f), a.navaids_only, quiet=True):
                vocab[s] += 1
            n += 1
            if a.limit and n >= a.limit:
                break
        if a.limit and n >= a.limit:
            break
    print('%d tiles read, %d distinct strings\n' % (n, len(vocab)))
    for s, c in vocab.most_common():
        print('  %6d  %s' % (c, s))


if __name__ == '__main__':
    main()
