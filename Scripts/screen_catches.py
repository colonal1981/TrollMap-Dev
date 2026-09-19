#!/usr/bin/env python3
r"""screen_catches.py -- which catch positions can place a fish, and which cannot.

Personal use only, not for distribution or resale; not for navigation.

    py .\screen_catches.py --catches "F:\TrollMapPipeline\_scratch\catches_approved.csv" `
                           --registry "F:\TrollMapPipeline\registry"

WHY THIS EXISTS

Ryan, 2026-09-19, looking at the map after three of my guesses had defended his phone's EXIF:
*"i am looking at the map and those coords for those fish are on land nowhere near the river"*.

He was right. The journal's positions come from photo EXIF, and some of them are kilometres from
any water -- his own Garmin, the same afternoon as the flathead, put him 4 km from where the phone
did. The journal is MIXED rather than bad: measured over his 157 approved catches, 104 land inside
a water boundary and 32 more sit within 120 m of one, which is a kayak against the bank.

What it has never carried is a mark saying which fixes are trustworthy. A bad fix that happens to
land near a trolling line counts as evidence about that water and is indistinguishable from a real
one, which is worse than having no position at all. catchSupport() in js/modules/plan-candidates.js
now screens against the pack's own outline at plan time; this is the same question asked of the
whole journal at once, so a trip can be re-placed or set aside.

THE FINGERPRINT OF A BAD FIX, and it is not subtle once you look: the same position repeated
exactly across catches taken hours or WEEKS apart. Six of his Bates Old River bowfin share one
fix 1.9 km off the water, taken across three different days. A live GNSS reading does not repeat
to seven decimal places. A cached or tower-derived one does.

Going forward the answer is the plotter, not the phone: a Garmin mark dropped at the hookup is a
real fix at the real moment, and garmin-parser.js already reads them.

BANDS, and they are distances rather than judgements:
    ON WATER   inside a boundary
    BANK       within 120 m of one -- a kayak against the shore, or a boundary drawn tight
    NEAR       within 400 m -- worth a look, not worth trusting
    ON LAND    further than that, and it cannot place a fish
"""
from __future__ import annotations
import argparse, collections, csv, glob, json, os, sys

try:
    from shapely.geometry import shape, Point
    from shapely.ops import unary_union
    from shapely.strtree import STRtree
except ImportError:
    sys.exit('needs shapely:  py -m pip install shapely')

BANK_M, NEAR_M = 120.0, 400.0
DEG = 111000.0


def load_boundaries(registry):
    geoms, slugs = [], []
    for p in glob.glob(os.path.join(registry, 'boundaries', '*.geojson')):
        slug = os.path.basename(p)[:-8]
        if slug.startswith('_'):
            continue
        try:
            d = json.load(open(p, encoding='utf-8'))
            gg = [shape(f['geometry'])
                  for f in (d.get('features') or [{'geometry': d.get('geometry')}])
                  if f and f.get('geometry')]
            if gg:
                geoms.append(unary_union(gg))
                slugs.append(slug)
        except Exception:
            continue
    return geoms, slugs


def read_catches(path):
    rows = list(csv.DictReader(open(path, encoding='utf-8-sig')))
    out = []
    for r in rows:
        la, lo = r.get('lat'), r.get('lon')
        if not la or not lo:
            continue
        try:
            out.append({'date': r.get('date', ''), 'sp': (r.get('species') or '').strip(),
                        'lake': (r.get('lake') or '').strip(),
                        'lat': float(la), 'lon': float(lo),
                        'file': (r.get('filename') or '').strip()})
        except ValueError:
            continue
    return out, len(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--catches', required=True, help='the approved catch CSV')
    ap.add_argument('--registry', required=True)
    ap.add_argument('--out', help='write the ON LAND rows here as CSV')
    a = ap.parse_args()

    pts, total = read_catches(a.catches)
    geoms, slugs = load_boundaries(a.registry)
    if not geoms:
        sys.exit('no boundaries under %s' % a.registry)
    tree = STRtree(geoms)
    repeat = collections.Counter((p['lat'], p['lon']) for p in pts)

    res = []
    for p in pts:
        pt = Point(p['lon'], p['lat'])
        inside = [slugs[i] for i in tree.query(pt) if geoms[i].contains(pt)]
        if inside:
            res.append((p, 'ON WATER', 0.0, inside[0]))
            continue
        best = (1e9, None)
        for i in tree.query(pt.buffer(0.02)):
            d = geoms[i].distance(pt)
            if d < best[0]:
                best = (d, slugs[i])
        if best[1] is None:                      # nothing within the buffer: scan them all
            for i, g in enumerate(geoms):
                d = g.distance(pt)
                if d < best[0]:
                    best = (d, slugs[i])
        m = best[0] * DEG
        band = 'ON WATER' if m == 0 else ('BANK' if m <= BANK_M
                                          else ('NEAR' if m <= NEAR_M else 'ON LAND'))
        res.append((p, band, m, best[1]))

    tally = collections.Counter(b for _, b, _, _ in res)
    print()
    print('CATCH POSITION SCREEN -- %d positioned catches of %d rows, against %d water boundaries'
          % (len(pts), total, len(geoms)))
    print('=' * 96)
    for band in ('ON WATER', 'BANK', 'NEAR', 'ON LAND'):
        n = tally.get(band, 0)
        print('   %-9s %4d   %5.1f%%' % (band, n, 100.0 * n / max(1, len(pts))))

    bad = [r for r in res if r[1] == 'ON LAND']
    if bad:
        print()
        print('ON LAND -- these cannot place a fish:')
        print('%-11s %-24s %-32s %9s  %s' % ('date', 'species', 'filed as', 'metres', 'nearest'))
        for p, _, m, slug in sorted(bad, key=lambda r: -r[2]):
            n = repeat[(p['lat'], p['lon'])]
            print('%-11s %-24s %-32s %9.0f  %-22s %s'
                  % (p['date'], p['sp'][:24], p['lake'][:32], m, slug or '?',
                     ('<- one fix, %d catches' % n) if n > 1 else ''))

    print()
    print('WATERS WHERE SOME OF THE HISTORY IS UNUSABLE:')
    byw = collections.defaultdict(lambda: [0, 0])
    for p, band, _, _ in res:
        byw[p['lake']][0] += 1
        if band == 'ON LAND':
            byw[p['lake']][1] += 1
    for w, (tot, b) in sorted(byw.items(), key=lambda x: -x[1][1]):
        if b:
            print('   %-44s %3d of %3d' % (w or '(blank)', b, tot))

    # THE REPEATED FIX IS THE TELL, so it gets counted on its own rather than left to the eye.
    reps = [(k, v) for k, v in repeat.items() if v > 1]
    onland = {(p['lat'], p['lon']) for p, band, _, _ in res if band == 'ON LAND'}
    print()
    print('repeated positions: %d, of which %d are on land'
          % (len(reps), sum(1 for k, _ in reps if k in onland)))
    print('a live GNSS fix does not repeat to seven decimals; a cached or tower fix does.')

    if a.out and bad:
        with open(a.out, 'w', newline='', encoding='utf-8') as fh:
            w = csv.writer(fh)
            w.writerow(['date', 'species', 'filed_as', 'lat', 'lon', 'metres_from_water',
                        'nearest_water', 'filename'])
            for p, _, m, slug in sorted(bad, key=lambda r: -r[2]):
                w.writerow([p['date'], p['sp'], p['lake'], p['lat'], p['lon'],
                            round(m), slug or '', p['file']])
        print('\n-> %s' % a.out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
