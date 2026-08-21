#!/usr/bin/env python3
"""Which tiles must be re-extracted after the 2026-08-21 depth fixes, and which lakes rebuilt.

Personal use only, not for distribution or resale; not for navigation.

WHY THIS EXISTS. The fixes changed three things -- the two-byte contour depth (`91 07 0e`), the
`bf`/`be` area band tags, and the 3/17 trailer-scan collision. All three only fire where a tile
has water past 83 ft. Measured on six tiles, the three deep ones carry every one of those record
forms and the three shallow ones carry NONE of them:

    tile      bf     be     dc   >255dm
    C4E0CE  8047    886   3704   15188    RE-EXTRACT
    C4E0CB  1046    165    399    1899    RE-EXTRACT
    C4E0F0  3752    545    210    5410    RE-EXTRACT
    C4E0E5     0      0      0       0    unchanged
    C4E0F1     0      0      0       0    unchanged
    C4E0DA     0      0      0       0    unchanged

So a full re-extract is not needed, and 226 tiles at 2.0 GB is worth not doing twice.

HOW A TILE IS IDENTIFIED. An affected tile's existing extract is capped: its deepest contour is
exactly 83.0 ft, the last 3 dm rung that fits in one byte. That is the ceiling, and no honest
lake tops out there by coincidence -- the value is a fingerprint, not a depth. The scan stops the
moment it sees one, so deep tiles cost a fraction of a file each.

The QA footer's `arc_missing` is carried as a cross-check: on every tile measured it is non-zero
if and only if the tile was capped, because a record framed at the wrong offset points its arc
selectors at nothing.

Writes outputs/affected_tiles.txt and outputs/affected_lakes.txt. The lake list is what feeds
--only-lakes on every build step downstream.
"""
import argparse, glob, gzip, json, os, re, sys

CEILING = re.compile(rb'"depth_ft":\s*83(?:\.0)?\s*[,}]')
ARCMISS = re.compile(rb'"arc_missing":\s*(\d+)')


def scan(path, chunk=1 << 22):
    """(capped, arc_missing). Stops early the moment the ceiling value appears."""
    arc = None
    tail = b''
    with gzip.open(path, 'rb') as fh:
        while True:
            ch = fh.read(chunk)
            if not ch:
                break
            buf = tail + ch
            if CEILING.search(buf):
                return True, arc
            m = ARCMISS.search(buf)
            if m:
                arc = int(m.group(1))
            tail = buf[-64:]
    return False, arc


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--extract', default='./extract', help='the extract/ tree')
    ap.add_argument('--map', default='./registry/tile_lake_map.json')
    ap.add_argument('--out', default='./outputs')
    ap.add_argument('--limit', type=int, default=0, help='scan only the first N tiles (a smoke test)')
    a = ap.parse_args()

    files = sorted(glob.glob(os.path.join(a.extract, 'contours', '*.geojson.gz')))
    if a.limit:
        files = files[:a.limit]
    if not files:
        print('no contour extracts under %s' % a.extract)
        return 2

    affected, clean, unreadable = [], [], []
    for i, p in enumerate(files, 1):
        tid = os.path.basename(p).split('.')[0]
        try:
            capped, arc = scan(p)
        except Exception as ex:
            unreadable.append((tid, str(ex)))
            print('  [%3d/%d] %-8s UNREADABLE: %s' % (i, len(files), tid, ex))
            continue
        if capped:
            affected.append(tid)
        else:
            clean.append(tid)
        print('  [%3d/%d] %-8s %s%s' % (i, len(files), tid,
              'CAPPED - re-extract' if capped else 'clean',
              '' if arc is None else '   arc_missing=%d' % arc))

    # Tiles are stored as C<id> for contours/depth_areas and B<id> for the rest; the
    # tile->lake map is keyed on the B form. Ask for both, because a lake reached through
    # either letter needs its pack rebuilt.
    lakes = set()
    try:
        by_tile = json.load(open(a.map))['by_tile']
        for tid in affected:
            for form in (tid, 'B' + tid[1:], 'C' + tid[1:]):
                for lk in by_tile.get(form, []) or []:
                    lakes.add(lk)
    except Exception as ex:
        print('\ncould not read %s: %s -- lake list not written' % (a.map, ex))

    os.makedirs(a.out, exist_ok=True)
    tf = os.path.join(a.out, 'affected_tiles.txt')
    lf = os.path.join(a.out, 'affected_lakes.txt')
    # trollmap_extract_all --tiles wants the BARE id (4E0CE), not the layer letter, and accepts
    # @path with one per line. Write exactly that so the list feeds straight back in.
    bare = [t[1:] if t and t[0].isalpha() else t for t in affected]
    bare = sorted(set(bare))
    open(tf, 'w').write('\n'.join(bare) + ('\n' if bare else ''))
    open(lf, 'w').write('\n'.join(sorted(lakes)) + ('\n' if lakes else ''))

    print('\n%d tiles scanned: %d capped, %d clean, %d unreadable'
          % (len(files), len(affected), len(clean), len(unreadable)))
    for tid, ex in unreadable:
        print('   UNREADABLE %s: %s' % (tid, ex))
    print('%d lakes need their pack rebuilt' % len(lakes))
    print('wrote %s' % tf)
    print('wrote %s' % lf)
    if affected:
        print('\n%d distinct tile ids. comma list for --tiles:\n%s' % (len(bare), ','.join(bare)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
