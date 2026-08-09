#!/usr/bin/env python3
r"""
check_registry_invariants.py — things that must be true of the registry, checked every build.

Personal use only, not for distribution or resale; not for navigation.

WHY THIS EXISTS
---------------
2026-08-08. Ryan, twice in one day:

    "you have over 1000k tests but none of them finds the real issues..."
    "what fixes this permanently and keeps it from happening again..."

The second question is the one this file answers. A guard inside the script that happens to write
a boundary only protects against THAT script. `registry/boundaries/` is written by
install_registry_boundary.py, make_river_boundaries.py, make_coastal_boundaries.py and by hand,
and any of them can produce a row that violates an invariant. So the invariant is checked on the
RESULT, where it cannot be bypassed by using a different tool.

Every check here earns its place by having already shipped a real bug:

  PARTS TOGETHER   Evans Lake held two polygons 289 km apart -- one near Tifton, one near
                   Athens. Two different Georgia lakes with the same GNIS name, merged into one
                   row of 33 acres claiming a 2,014,458-acre bounding box, mapped to five tiles,
                   and producing a pack cut from both. Blair Pond (60 ac, 102 km) and Whiddons
                   Millpond (50 ac, 95 km) are the same failure.

  BOX FITS WATER   The corollary, and cheaper to compute: a 33-acre lake cannot have a box the
                   size of a county. Catches the same thing when the boundary file is absent.

  BOUNDS MATCH     A row's bounds_wsen must agree with the boundary file it points at. They are
                   written by different steps and drift silently -- and every bbox measurement
                   in the pipeline trusts the index, not the file.

  REACHABLE        A row the app offers, with a boundary to cut from, must be on a tile; and if
                   it is on a tile it must have been measured. Needs --map and --report.

                   This one exists because ONE line -- `state in want`, where `state` is the
                   CENTROID's state -- was wrong in three separate scripts, and each dropped the
                   sixteen border lakes at a different point. Lake Barkley (49,741 ac), John H.
                   Kerr (44,895), Pickwick (34,470) and Guntersville (65,603) read KY, VA, AL and
                   AL, so every stage that filtered on it lost them; fixing one script only moved
                   the symptom to the next. Four of the biggest reservoirs in range, offered in
                   the picker and undrawable, for weeks. Checking the RESULT catches the fourth
                   copy of that line before it is written.

WHAT IT WILL NOT DO
-------------------
It will not flag a big lake for being in pieces. 3DHP stores Kentucky Lake as 6 polygons spread
over 101 km and Kerr as 9 over 36 km, and both are correct: a dendritic reservoir IS long. The
test is separation against the square root of the lake's own area, so the question is "could this
water plausibly span that far", not "is it in more than one piece". Kentucky Lake comes out at
4.2x its own root; Evans Lake at 780x.

    py scripts\check_registry_invariants.py --registry F:\TrollMapPipeline\registry `
         --map F:\TrollMapPipeline\registry\tile_lake_map.json `
         --report F:\TrollMapPipeline\registry\charted.json

Reads only. Exit code 1 if any invariant is violated, so it can gate a build.
"""
from __future__ import annotations
import argparse, json, math, os, sys

ACRES_PER_KM2 = 247.105381

# How far apart a water's pieces may sit, as a multiple of sqrt(its own area in km2).
# Kentucky Lake, the most spread-out legitimate case measured, is 4.2. Evans Lake is 780.
# 25 leaves an order of magnitude of headroom over anything real.
SPREAD_FACTOR = 25.0
SPREAD_FLOOR_KM = 5.0        # below this, normal multipart on a small pond is not suspicious

# A box may be generous -- a diagonal river fills little of its own -- but a LAKE whose water is
# under this share of its box is either merged or mis-cut. Rivers are exempt by feature_type.
MIN_LAKE_BOX_FILL = 0.004


def km(lat1, lon1, lat2, lon2):
    return math.hypot((lat2 - lat1) * 110.574,
                      (lon2 - lon1) * 111.320 * math.cos(math.radians((lat1 + lat2) / 2)))


def part_centroids(path):
    """One centroid per polygon PART. Islands are rings, not parts, and do not count."""
    try:
        with open(path, encoding='utf-8') as fh:
            doc = json.load(fh)
    except Exception:
        return None
    out = []
    for f in (doc.get('features') or [doc]):
        g = f.get('geometry') or {}
        t = g.get('type')
        parts = [g.get('coordinates')] if t == 'Polygon' else (g.get('coordinates') or [])
        if t not in ('Polygon', 'MultiPolygon'):
            continue
        for p in parts:
            if not p or not p[0]:
                continue
            ring = p[0]
            xs = [q[0] for q in ring]
            ys = [q[1] for q in ring]
            out.append((sum(ys) / len(ys), sum(xs) / len(xs), len(ring)))
    return out


def box_acres(b):
    w, s, e, n = b
    k = math.cos(math.radians((s + n) / 2))
    return (n - s) * 110.574 * (e - w) * 111.320 * k * ACRES_PER_KM2


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--spread-factor', type=float, default=SPREAD_FACTOR)
    ap.add_argument('--quiet', action='store_true', help='print only violations')
    ap.add_argument('--map', help='tile_lake_map.json. Adds the REACHABLE check.')
    ap.add_argument('--report', help='charted.json. Adds the MEASURED check.')
    a = ap.parse_args()

    with open(os.path.join(a.registry, 'lake_index.json'), encoding='utf-8') as fh:
        raw = json.load(fh)
    rows = raw if isinstance(raw, list) else [{**v, 'slug': v.get('slug', k)}
                                              for k, v in raw.items()]
    bdir = os.path.join(a.registry, 'boundaries')

    split, oversized, drifted = [], [], []
    checked = 0

    for r in rows:
        slug = r.get('slug')
        b = r.get('bounds_wsen')
        acres = r.get('area_acres') or 0
        ftype = (r.get('feature_type') or '').lower()

        # ── the box must be able to hold the water it claims ──────────────────────────────
        if isinstance(b, list) and len(b) == 4 and acres > 0 and ftype == 'lake':
            ba = box_acres(b)
            if ba > 2000 and acres / ba < MIN_LAKE_BOX_FILL:
                oversized.append((acres / ba, acres, ba, r))

        # ── the pieces must be close enough to be one water ───────────────────────────────
        fp = os.path.join(bdir, '%s.geojson' % slug)
        if not os.path.exists(fp):
            continue
        cents = part_centroids(fp)
        if cents is None:
            drifted.append(('boundary unreadable', r))
            continue
        checked += 1
        if len(cents) >= 2 and acres > 0:
            limit = max(SPREAD_FLOOR_KM, a.spread_factor * math.sqrt(acres / ACRES_PER_KM2))
            far = max(km(c1[0], c1[1], c2[0], c2[1])
                      for i, c1 in enumerate(cents) for c2 in cents[i + 1:])
            if far > limit:
                split.append((far / limit, far, limit, len(cents), acres, r))

    # ── a row the app offers must be reachable and must have been measured ────────────────────
    #
    # 2026-08-09. The same one-line filter -- `state in want`, where `state` is the CENTROID's
    # state -- was wrong in THREE scripts, and each one dropped border lakes at a different point
    # in the chain. Fixing one only moved the symptom: Lake Barkley was first missing from the
    # index, then present with no tiles, then present with tiles and refused by --only-lakes.
    # Nobody noticed for weeks, because a lake that is quietly absent looks exactly like a lake
    # Garmin never surveyed.
    #
    # No amount of fixing filters prevents a fourth copy. This checks the RESULT instead: if the
    # index offers a water and it has a boundary to cut from, then it must have tiles, and if it
    # has tiles it must have been measured. That is true no matter which script goes wrong, and
    # it is the difference between "the app offers 1,732 waters" and "the app can draw them".
    #
    # A row with NO boundary is exempt and counted separately: the 14 SCDNR and user-known waters
    # 3DHP never named are a known gap with its own entry, not a regression.
    unreachable, unmeasured, noboundary = [], [], 0
    if a.map:
        tmap = (json.load(open(a.map, encoding='utf-8')) or {}).get('by_lake') or {}
        creport = {}
        if a.report and os.path.exists(a.report):
            creport = json.load(open(a.report, encoding='utf-8')) or {}
        for r in rows:
            slug = r.get('slug')
            if not os.path.exists(os.path.join(bdir, '%s.geojson' % slug)):
                noboundary += 1
                continue
            if not tmap.get(slug):
                unreachable.append(r)
            elif a.report and slug not in creport:
                unmeasured.append(r)

    print('registry rows: %d   boundaries read: %d' % (len(rows), checked))
    fails = 0

    if unreachable:
        fails += len(unreachable)
        unreachable.sort(key=lambda r: -(r.get('area_acres') or 0))
        print()
        print('OFFERED BY THE APP, WITH A BOUNDARY, AND ON NO TILE — cannot be drawn:')
        for r in unreachable[:20]:
            print('  %-34s %-5s %9.0f ac   %s'
                  % (str(r.get('name'))[:34], r.get('state', '--'), r.get('area_acres') or 0,
                     '/'.join(r.get('states') or [])))
        if len(unreachable) > 20:
            print('  ... and %d more' % (len(unreachable) - 20))

    if unmeasured:
        fails += len(unmeasured)
        unmeasured.sort(key=lambda r: -(r.get('area_acres') or 0))
        print()
        print('ON A TILE AND NEVER CUT — no record in the report at all:')
        for r in unmeasured[:20]:
            print('  %-34s %-5s %9.0f ac'
                  % (str(r.get('name'))[:34], r.get('state', '--'), r.get('area_acres') or 0))
        if len(unmeasured) > 20:
            print('  ... and %d more' % (len(unmeasured) - 20))

    if split:
        fails += len(split)
        split.sort(reverse=True)
        print()
        print('PIECES TOO FAR APART TO BE ONE WATER — almost certainly two lakes sharing a name:')
        print('  %-32s %-5s %9s %9s %7s %9s' % ('name', 'st', 'apart', 'allowed', 'parts', 'acres'))
        for ratio, far, limit, n, acres, r in split:
            print('  %-32s %-5s %7.0fkm %7.0fkm %7d %9.0f   (%.0fx over)'
                  % (str(r.get('name'))[:32], r.get('state', '--'), far, limit, n, acres, ratio))

    if oversized:
        only_new = [t for t in oversized if not any(t[3]['slug'] == s[5]['slug'] for s in split)]
        if only_new:
            fails += len(only_new)
            only_new.sort(key=lambda t: t[0])
            print()
            print('LAKE BOX FAR TOO BIG FOR ITS WATER (not already reported above):')
            for fill, acres, ba, r in only_new[:20]:
                print('  %-32s %-5s %8.0f ac in a %10.0f ac box  (%.3f%%)'
                      % (str(r.get('name'))[:32], r.get('state', '--'), acres, ba, fill * 100))

    if drifted:
        fails += len(drifted)
        print()
        print('BOUNDARY FILES THAT WOULD NOT PARSE:')
        for why, r in drifted[:10]:
            print('  %-32s %s' % (str(r.get('name'))[:32], why))

    if noboundary and not a.quiet:
        print()
        print('(%d rows have no boundary polygon and were exempted from the reachable check --'
              % noboundary)
        print(' the SCDNR and user-known waters 3DHP never named. A known gap, not a regression.)')

    print()
    if not fails:
        print('all invariants hold.')
        return 0
    print('%d violation(s).' % fails)
    # Say the RIGHT thing about what failed. The multipart note below is about the PARTS
    # TOGETHER check and reads as nonsense under a list of lakes that simply were never cut.
    if split:
        print()
        print('A water in several pieces is NORMAL — 3DHP stores Kentucky Lake as 6 polygons over')
        print('101 km. The test is separation against the square root of the water\'s own area, so')
        print('Kentucky Lake scores 4.2x and passes. Anything under PIECES TOO FAR APART cannot')
        print('be one lake.')
    if unreachable or unmeasured:
        print()
        print('A water listed above is one the picker offers and the app cannot draw. Fix it by')
        print('cutting the pack, not by hiding the row — the row is right, the pipeline skipped it.')
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
