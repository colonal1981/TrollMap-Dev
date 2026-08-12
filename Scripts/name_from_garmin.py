#!/usr/bin/env python3
r"""name_from_garmin.py -- ask GARMIN what a boundary is called, by position, never by name.

    py .\scripts\name_from_garmin.py --slug lake_robinson_greer
    py .\scripts\name_from_garmin.py --boundaries registry\boundaries --unregistered
    py .\scripts\name_from_garmin.py --unregistered --tsv names.tsv

WHAT THIS ANSWERS

Ryan, 2026-08-12: *"how do we name it? is there a way to match the location from the 3dhp id to
garmin?"*

Yes. Garmin puts a NAMED POINT on its own water -- POI mode `5/1` -- and a point either falls
inside a polygon or it does not. So a 3DHP polygon that nobody named can be named by asking which
Garmin label sits in it. **There is no name matching anywhere in this chain**, which is the whole
point: every naming failure on this project came from matching names, and the entire 2026-08-11
blind-spot finding is that the water we are missing has no name to match.

    3DHP id  ->  boundary_from_3dhp.py  ->  registry/boundaries/<slug>.geojson
                                              -> THIS: which Garmin 5/1 labels are inside it
                                              -> install_registry_boundary.py --name

VALIDATED ON A CASE RYAN SOLVED BY HAND

`lake_robinson_greer` was found by Ryan clicking id J7WR7 in the National Map viewer and typing
the name himself. Run blind against that boundary, Garmin returns **"Lake Robinson"** off four
5/1 points inside the polygon. Hartwell's tile returns "Hartwell Lake" the same way. That is an
independent confirmation, not a restatement of what we already believed.

AND THE LIMIT, WHICH MATTERS MORE THAN THE CAPABILITY

**Garmin only labels water it thinks is worth labelling.** Measured on the small water still
outstanding:

    lake_robinson_greer   803 ac   4 labels INSIDE   -> "Lake Robinson"          CONFIDENT
    lake_cherokee_sc       51 ac   0 inside, nothing named within 3 km           NO ANSWER
    lake_john_d_long_sc    68 ac   0 inside; nearest named things are "105" at   NO ANSWER
                                   1.2 km and "Lockhart" at 1.9 km
    lake_oliphant_sc       40 ac   0 inside; nearest is "190" at 0.92 km         NO ANSWER
    webb_center_lakes_sc   17 ac   0 inside, nothing within 3 km                 NO ANSWER

`105`, `190`, `909`, `72` are HIGHWAY SHIELDS and `Lockhart` is a town. Mode 5/1 is not a
water-only namespace, so a nearest-label rule would confidently name a farm pond after a
state road. **This script therefore only answers from labels INSIDE the polygon**, reports
near-misses as advisory text, and refuses digit-only strings outright. A blank answer is a
correct answer: it means Garmin has no name for that water either, and neither does 3DHP, and
the name has to come from Ryan or from the county.

"CREEK BED" IS NOT A LAKE -- AND COUNTING INSIDE-LABELS IS NOT ENOUGH

The first version of this script took the most frequent label inside the polygon and returned
**"Creek Bed" for norris_lake**, 286 hits against a handful of "Norris Lake". Mode 5/1 is not a
water-name namespace: it also carries submerged-feature annotations, and a big reservoir has
hundreds of those and only a few of its own name. Hartwell survived that rule by luck -- 394
"Hartwell Lake" happened to outnumber the noise.

The discriminator is DOCUMENT FREQUENCY, the same rule `assign_to_lakes.py` needed when a shared
token put a Georgia millpond on Jordan Lake: **how many of the 2,590 tiles carry this string?**
A name is local to its water; a feature annotation is everywhere. Measured across every label
sidecar on the drive:

    Bridge                    909 tiles  35%          Norris Lake      8 tiles  0.3%
    Dam                       626        24%          Hartwell Lake    4        0.2%
    Boat Ramp                 564        22%          Lake Murray      4        0.2%
    Creek Bed                 358        14%          Lake Robinson    3        0.1%
    Road Bed                  343        13%
    Submerged Minor Creek Bed 328        13%

Median document frequency over 400,339 distinct strings is **1 tile**; the 99th percentile is 8.
Only 442 strings appear in more than 2% of tiles. So the default cut at 2% (~52 tiles) separates
Norris Lake from Creek Bed with a 6x margin on one side and 44x on the other, and it is derived
from the data rather than from a hand-written stop list that would need a new entry every time
Garmin invents an annotation.

WHY POINT-IN-POLYGON AND NOT NEAREST

A nearest-label rule is a distance threshold standing in for a fact, which is the same shape as
`restitch_water_graphs.py` -- see 00_START_HERE. Containment is a fact. The cost of containment
is that small water gets no answer; the cost of nearest is that small water gets a WRONG answer
that looks like a right one. Under Ryan's own standard -- a name that opens a chartpack for the
wrong water scores worse than zero -- silence wins.

TILES ARE B TILES. POIs live under B, contours under C: `B4E0CE` <-> `C4E0CE`. Tile bounds come
from `extract/labels/<TILE>.json`, which is already on disk for all 2,589 of them.

READ-ONLY. It prints, and with --tsv writes one file of suggestions. It never touches the
registry; `install_registry_boundary.py` does that, and only with --go.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse
import glob
import gzip
import json
import math
import os
import re
import sys

# A 5/1 label that is only digits is a road shield. Seen within 3 km of the outstanding ponds:
# 105, 190, 909, 72, 16, 121. None of them is water.
ROAD_SHIELD = re.compile(r'^[\s\d/\-]+$')


def rings(g):
    t = (g or {}).get('type')
    c = (g or {}).get('coordinates')
    if t == 'Polygon':
        return c or []
    if t == 'MultiPolygon':
        return [r for p in (c or []) for r in p]
    return []


def inside(x, y, ring):
    hit = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-15) + xi:
            hit = not hit
        j = i
    return hit


def km(a, b, c, d):
    return math.hypot((c - a) * math.cos(math.radians((b + d) / 2)), (d - b)) * 111.32


def boundary_rings(fp):
    d = json.load(open(fp, encoding='utf-8'))
    feats = d.get('features') if d.get('type') == 'FeatureCollection' else [d]
    out = []
    for f in (feats or []):
        # EVERY feature, never features[0] -- a multi-part lake loses limbs otherwise.
        for r in rings((f or {}).get('geometry') or {}):
            if len(r) >= 4:
                out.append(r)
    return out


def scan_labels(labels_dir, cache_fp):
    """One pass over the label sidecars: tile bounds AND document frequency per string.

    Both come out of the same 2,590 files, so they are read together -- and cached, because
    the DF table is the expensive half and does not change unless the extract is re-run.
    """
    if cache_fp and os.path.exists(cache_fp):
        try:
            d = json.load(open(cache_fp, encoding='utf-8'))
            if d.get('tiles') and d.get('df'):
                return ({k: tuple(v) for k, v in d['tiles'].items()}, d['df'], d['n'])
        except Exception:
            pass
    bounds, df, n = {}, {}, 0
    for fp in glob.glob(os.path.join(labels_dir, '*.json')):
        try:
            d = json.load(open(fp, encoding='utf-8'))
        except Exception:
            continue
        n += 1
        tile = d.get('tile') or os.path.basename(fp)[:-5]
        b = d.get('bounds')
        if isinstance(b, dict) and 'west' in b:
            bounds[tile] = (b['west'], b['south'], b['east'], b['north'])
        # set(), not list: a string repeated within one tile is still one document.
        for s in {x.get('text') for x in d.get('strings', []) if x.get('text')}:
            df[s] = df.get(s, 0) + 1
    if cache_fp:
        try:
            os.makedirs(os.path.dirname(cache_fp) or '.', exist_ok=True)
            json.dump({'tiles': {k: list(v) for k, v in bounds.items()}, 'df': df, 'n': n},
                      open(cache_fp, 'w', encoding='utf-8'))
        except Exception:
            pass
    return bounds, df, n


def named_pois(poi_dir, tile, _cache={}):
    if tile in _cache:
        return _cache[tile]
    fp = os.path.join(poi_dir, '%s.geojson.gz' % tile)
    pts = []
    if os.path.exists(fp):
        try:
            for f in json.load(gzip.open(fp))['features']:
                p = f.get('properties') or {}
                nm = p.get('name')
                g = f.get('geometry') or {}
                if not nm or g.get('type') != 'Point':
                    continue
                pts.append((g['coordinates'][0], g['coordinates'][1],
                            str(nm).replace('\n', ' ').strip(),
                            str(p.get('type') or p.get('mode') or '')))
        except Exception:
            pass
    _cache[tile] = pts
    return pts


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--boundaries', default=os.path.join('registry', 'boundaries'))
    ap.add_argument('--labels', default=os.path.join('extract', 'labels'))
    ap.add_argument('--pois', default=os.path.join('extract', 'pois'))
    ap.add_argument('--registry', default='registry')
    ap.add_argument('--slug', action='append', default=[],
                    help='one boundary slug; repeatable. Default is --unregistered.')
    ap.add_argument('--unregistered', action='store_true',
                    help='every boundary with no row in registry/lakes.json -- i.e. exactly the '
                         'water that has been cut and cannot be built yet')
    ap.add_argument('--mode', default='5/1',
                    help='POI mode carrying water labels (default 5/1)')
    ap.add_argument('--near-km', type=float, default=3.0,
                    help='radius for the ADVISORY near-miss list. Never used to name anything.')
    ap.add_argument('--generic-pct', type=float, default=2.0,
                    help='a label present in more than this %% of tiles is a feature annotation '
                         '(Creek Bed, Dam, Bridge), not a name. See the docstring for the '
                         'measured distribution; median is 1 tile and the 99th pct is 8.')
    ap.add_argument('--label-cache', default=os.path.join('_scratch', 'label_df.json'),
                    help='cache for the one-pass tile-bounds + document-frequency scan')
    ap.add_argument('--tsv', help='write slug<TAB>name for the confident answers only')
    a = ap.parse_args()

    slugs = list(a.slug)
    if a.unregistered or not slugs:
        rp = os.path.join(a.registry, 'lakes.json')
        known = set()
        if os.path.exists(rp):
            L = json.load(open(rp, encoding='utf-8'))
            rows = L if isinstance(L, list) else (L.get('lakes') or [])
            known = {r.get('slug') for r in rows if isinstance(r, dict)}
        have = {os.path.basename(p)[:-8]
                for p in glob.glob(os.path.join(a.boundaries, '*.geojson'))}
        slugs = sorted(have - known)
        print('%d boundaries on disk, %d rows in lakes.json, %d boundaries with NO row'
              % (len(have), len(known), len(slugs)))
        if not slugs:
            print('Every boundary already has a registry row. Nothing to name.')
            return 0

    TB, DF, NT = scan_labels(a.labels, a.label_cache)
    cut = max(1, int(NT * a.generic_pct / 100.0))
    print('label scan: %d tiles, %d distinct strings; a string in >%d tiles (%.1f%%) is generic'
          % (NT, len(DF), cut, a.generic_pct))
    print('tile bounds: %d tiles from %s\n' % (len(TB), a.labels))

    confident, blank = [], []
    for slug in slugs:
        fp = os.path.join(a.boundaries, slug + '.geojson')
        if not os.path.exists(fp):
            print('%-34s NO BOUNDARY at %s' % (slug[:34], fp))
            continue
        rs = boundary_rings(fp)
        if not rs:
            print('%-34s boundary has no usable ring' % slug[:34])
            continue
        xs = [p[0] for r in rs for p in r]
        ys = [p[1] for r in rs for p in r]
        w, s, e, n = min(xs), min(ys), max(xs), max(ys)
        clon, clat = (w + e) / 2.0, (s + n) / 2.0

        tiles = [t for t, (tw, ts, te, tn) in TB.items()
                 if not (te < w or tw > e or tn < s or ts > n)]
        hits, near, generic = {}, [], {}
        for t in tiles:
            for x, y, nm, ty in named_pois(a.pois, t):
                if a.mode and ty != a.mode:
                    continue
                if ROAD_SHIELD.match(nm):
                    continue
                if w <= x <= e and s <= y <= n and any(inside(x, y, r) for r in rs):
                    # Inside, but is it a NAME? "Creek Bed" is inside 358 tiles' worth of water.
                    if DF.get(nm, 0) > cut:
                        generic[nm] = generic.get(nm, 0) + 1
                        continue
                    hits[nm] = hits.get(nm, 0) + 1
                else:
                    d = km(clon, clat, x, y)
                    if d <= a.near_km:
                        near.append((d, nm))

        if hits:
            best = sorted(hits.items(), key=lambda kv: -kv[1])
            name = best[0][0]
            confident.append((slug, name))
            extra = ('   (also: %s)' % ', '.join(n for n, _ in best[1:4])) if len(best) > 1 else ''
            drop = (''.join('  [dropped %d generic: %s]'
                            % (sum(generic.values()),
                               ', '.join(sorted(generic, key=lambda k: -generic[k])[:3])))
                    if generic else '')
            print('%-34s GARMIN: %-30s %3d inside%s%s'
                  % (slug[:34], name[:30], best[0][1], extra, drop))
        else:
            blank.append(slug)
            near.sort()
            seen, adv = set(), []
            for d, nm in near:
                if nm in seen:
                    continue
                seen.add(nm)
                adv.append('%s @ %.1f km' % (nm, d))
                if len(adv) >= 3:
                    break
            print('%-34s no Garmin label inside.%s'
                  % (slug[:34], ('  nearby (NOT a name): ' + '; '.join(adv)) if adv else
                     '  nothing named within %.0f km either.' % a.near_km))

    print('\n%d named by Garmin, %d with no name from anyone.' % (len(confident), len(blank)))
    if blank:
        print('\nThose %d need a name from Ryan or a synthesised one. `lakes.json` already carries'
              % len(blank))
        print('158 rows whose lake_id is `slug:<slug>` rather than `gnis:<id>`, so an unnamed')
        print('water is an established shape in this registry, not a special case.')
    if confident:
        print('\nFeed the confident ones straight in:')
        for slug, name in confident[:8]:
            print('   --lake %s --name "%s=%s"' % (slug, slug, name))
        if len(confident) > 8:
            print('   ... and %d more' % (len(confident) - 8))
    if a.tsv:
        with open(a.tsv, 'w', encoding='utf-8') as fh:
            for slug, name in confident:
                fh.write('%s\t%s\n' % (slug, name))
        print('\n-> %s (%d confident answers only; the blanks are deliberately absent)'
              % (a.tsv, len(confident)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
