#!/usr/bin/env python3
r"""chart_currency.py -- what date is each Garmin tile, and is a re-extract actually needed?

Personal use only, not for distribution or resale; not for navigation.

    py .\scripts\chart_currency.py `
       --manifest F:\TrollMapPipeline\POSSIBLY_NEW_GARMIN_CHARTS\charts\manifest.db `
       --against  F:\TrollMapPipeline\Bluestacks_ActiveCaptain_TIles_21Aug26\manifest.db

    py .\scripts\chart_currency.py --manifest <new> --against <current> --only-mine

GARMIN DATES EVERY TILE AND NOBODY WAS READING IT

`charts\manifest.db` holds one `map_tiles` row per file -- C tile, B tile and the G*.MAR beside
them, each with its own `CreationDay`. The epoch is **1989-12-31**: the May card's newest tile
reads 13277 -> 2026-05-08 and the manifest file itself was written 2026-05-10.

That replaces two things this project was doing the hard way. Whether a newer pull LOST content
was being argued from feature counts -- twice, wrongly, in both directions -- when Garmin states
per tile which copy is newer. And whether a fresh download is worth re-extracting was a guess.

**A FRESH DOWNLOAD IS NOT A REASON TO RE-EXTRACT.** Measured 2026-08-22: a new Garmin Express
card image had 2,388 of its 2,589 C tiles newer than the May image -- and for the 92 tiles the
374 shipping lakes actually use, ZERO were newer than what was already extracted. The whole-card
refresh was real and changed nothing that mattered. Run this before spending an hour.

AND ACTIVECAPTAIN CAN BE AHEAD OF THE CARD. On the same day, C4B564, C4B566, C4B56B and C4B56C
read 2026-08-21 in the ActiveCaptain pull against 2026-08-08 on the brand-new card. Panning
ActiveCaptain is not redundant with a card download; they are two feeds and either can lead.

HOW TO GET A FRESH FULL CARD -- Ryan, 2026-08-22

Garmin Express will not re-download charts it thinks you already have. Move the `charts` folder
OFF the SD card, then run the download again in Garmin Express and it fetches the whole thing
fresh. About every three months is the cadence he settled on.
"""
import argparse, datetime, os, sqlite3, sys, collections

EPOCH = datetime.date(1989, 12, 31)


def load(db, pattern):
    con = sqlite3.connect('file:%s?mode=ro' % db, uri=True)
    cur = con.cursor()
    cur.execute("select FileName, CreationDay from map_tiles where FileName like ?", (pattern,))
    out = {r[0]: r[1] for r in cur.fetchall() if r[1] is not None}
    con.close()
    return out


def day(v):
    return (EPOCH + datetime.timedelta(days=int(v))).isoformat()


def mine(registry, packs_list):
    """The tile ids the lakes we actually ship sit on, as C-form filenames."""
    import json
    with open(os.path.join(registry, 'tile_lake_map.json'), encoding='utf-8') as fh:
        by_lake = (json.load(fh) or {}).get('by_lake') or {}
    if packs_list and os.path.exists(packs_list):
        with open(packs_list, encoding='utf-8') as fh:
            want = {l.strip() for l in fh if l.strip()}
    else:
        want = set(by_lake)
    return {'C%s.GMP' % t[1:] for s in want for t in (by_lake.get(s) or [])}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--manifest', required=True, help='the manifest.db to judge')
    ap.add_argument('--against', help='a second manifest.db to compare it to')
    ap.add_argument('--pattern', default='C%.GMP',
                    help="filename pattern; 'C%%.GMP' bathymetry, 'B%%.GMP' basemap, "
                         "'G%%.MAR' the guidance mesh, '%%' everything")
    ap.add_argument('--registry', default='registry')
    ap.add_argument('--only-mine', action='store_true',
                    help='restrict to the tiles our shipping lakes sit on')
    ap.add_argument('--ship-list', default=os.path.join('outputs', 'ship_lakes.txt'))
    a = ap.parse_args()

    new = load(a.manifest, a.pattern)
    if not new:
        print('no rows matching %s in %s' % (a.pattern, a.manifest)); return 2
    keep = mine(a.registry, a.ship_list) if a.only_mine else None
    if keep is not None:
        new = {k: v for k, v in new.items() if k in keep}
        print('restricted to the %d tiles our shipping lakes sit on' % len(keep))

    print('%-16s %5d tiles   %s .. %s'
          % (os.path.basename(os.path.dirname(a.manifest)) or 'manifest',
             len(new), day(min(new.values())), day(max(new.values()))))
    hist = collections.Counter(day(v)[:7] for v in new.values())
    print('   by month: %s' % dict(sorted(hist.items())))

    if not a.against:
        return 0
    old = load(a.against, a.pattern)
    if keep is not None:
        old = {k: v for k, v in old.items() if k in keep}
    both = set(new) & set(old)
    newer = sorted(t for t in both if new[t] > old[t])
    older = sorted(t for t in both if new[t] < old[t])
    same = len(both) - len(newer) - len(older)
    print()
    print('%-16s %5d tiles   %s .. %s'
          % (os.path.basename(os.path.dirname(a.against)) or 'against',
             len(old), day(min(old.values())) if old else '-',
             day(max(old.values())) if old else '-'))
    print()
    print('shared %d:  NEWER %d   same %d   OLDER %d' % (len(both), len(newer), same, len(older)))
    print('only in --manifest: %d      only in --against: %d'
          % (len(set(new) - set(old)), len(set(old) - set(new))))
    for label, rows in (('newer', newer), ('older', older)):
        for t in rows[:15]:
            print('   %-5s %-14s %s -> %s' % (label, t, day(old[t]), day(new[t])))
        if len(rows) > 15:
            print('   ... %d more %s' % (len(rows) - 15, label))
    print()
    if not newer:
        print('NOTHING TO RE-EXTRACT. Every shared tile is the same day or older than what you '
              'already have.')
    else:
        print('%d tile(s) are newer. Bare ids for --tiles:' % len(newer))
        print(','.join(t[1:-4] for t in newer))
    return 0


if __name__ == '__main__':
    sys.exit(main())
