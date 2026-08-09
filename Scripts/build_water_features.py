#!/usr/bin/env python3
"""build_water_features.py - derive the structure types the fishing intel actually asks for.

Personal use only, not for distribution or resale; not for navigation.

    py .\\build_water_features.py --packs "F:\\TrollMapPipeline\\chartpack"

Run AFTER build_water_graphs.py and build_trolling_runs.py. Writes
`<slug>/water_features.geojson`, and annotates `<slug>/trolling_runs.geojson` in place with the
relief character of each run.

WHY THESE FEATURES AND NOT OTHERS

Counting what Wateree's own `trollingIntelligence` asks for -- 11 species x 4 seasons, 104
structure citations -- the ranking is not what the pipeline had been building for:

    brush / wood / stumps          27    POI layer: 55 Flooded Timber, 3 Piles
    river channel / channel edge   12    <- derived here
    points                         11    <- derived here
    docks                          10    docks.geojson
    creek mouths                   10    <- named POIs + cove association, here
    flats                           8    <- derived here
    coves / pockets                 6    <- derived here
    steep banks                     6    <- derived here
    ledges                          4    structure.geojson
    humps                           3    structure.geojson

Humps and ledges -- the whole of `structure.geojson` -- are 7 of 104. This script covers the
53 citations in the middle that had no source at all.

THE DEPTH GRID

Everything here comes off one raster built from `depth_areas.geojson` at 25 m: max charted depth
per cell, 0 where dry. On Wateree that is 82,665 wet cells, 51.7 km2, against 47.6 km2 of
registered surface area -- the excess is rasterisation at the edges, and it is the check that
the grid is right before anything is derived from it.

CHANNEL EDGE, FLAT AND STEEP BANK ARE ONE MEASUREMENT

For any position: the deepest and shallowest charted water within `--relief-m` (250 m default).

    deepest nearby minus own depth  >= 15 ft            channel edge
                                    <=  4 ft            flat
    shallowest nearby <= 2 ft and the drop >= 8 ft      steep bank
    otherwise                                            break

Verified to discriminate: the 12.1 ft runs on Wateree split into channel-edge runs with 34-56 ft
of water within 250 m, against flats with 14-16 ft.

**A channel CENTRELINE was attempted first and abandoned.** Thresholding absolute depth cannot
follow it -- Wateree deepens toward the dam, so one threshold captures the lower lake and loses
the upper. Taking cells at the local maximum depth instead gives a thin broken skeleton: 117
components, the largest spanning 3.8 km of a 25 km lake. The intel never asks for a channel
line anyway. It asks for the channel EDGE, which is a property of a stretch of water, and that
is what this computes.

POINTS AND COVES, AND HOW THEY ARE TOLD APART

Walking the water edge, take the chord across a `--curve-m` window and measure how far the
vertex bulges off it. A **point** is land pushing into the lake, so the line wraps around land
and bulges toward deeper water. A **cove** is water pushing into land, so it bulges toward
shallower. Probe the depth `--probe-m` either side of the vertex along the bulge and the sign
of the difference names it.

That is a definition, not a tuned threshold, and it holds on the data:

    point   n=339   median depth advantage on the bulge side   +13.9 ft   (p10 +3.2, p90 +28.5)
    cove    n=278   median depth advantage on the bulge side    -7.0 ft   (p10 -15.6, p90 -1.8)

Two populations, no overlap through the middle. Independently, every creek-named POI within
210 m of a detected feature landed in a cove, and 83% have a cove within 500 m -- a creek arm
IS a cove, and nothing in the detection knows about the names.

CREEK MOUTHS ARE NOT DERIVED, THEY ARE READ

Two geometric methods were tried and both failed, which is worth recording so they are not
tried again.

*Coves flanked by opposing points* produced 96-196 "mouths" on a lake with perhaps twenty real
creek arms, and matched only 11-28% of the creek names. At 300 m feature spacing every cove has
points near it, so the test selects bends.

*Necks in the water body* -- eroding the water and looking for arms that pinch off -- does not
work on Wateree at all: at every erosion radius from 60 m to 200 m the main body stays 95-98% of
the water. **Its creek arms do not neck down.** They are broad bays, median half-width 140 m.

But Garmin names them. Wateree carries 18 creek- and branch-named POIs with coordinates, and the
cove detection already puts a cove beside most of them. So a creek mouth here is a named creek
POI paired with its nearest cove -- read, not invented.

--SHIP-ONLY, AND WHY THIS IS THE SCRIPT THAT NEEDED IT

Of the three derived-layer builders this is the one that was genuinely burning time on lakes
nobody will ever download. Measured card-wide 2026-08-09: **1579 packs opened, 1577 written,
36.2 min**. It runs off `depth_areas.geojson`, which exists in **733 shipping packs and 844
NON-shipping ones** -- so **844 of those 1577 outputs, more than half the run, are for lakes
that will never be uploaded**. (`build_structure.py` and `build_trolling_runs.py` need
`contours.geojson`, which no non-shipping pack has, so they were already bailing out instantly.)

`registry/charted.json` has known which is which the whole time -- **734 of 1732 lakes ship**,
the other 998 carry a `skipped` reason from `build_all_chartpacks.py` -- and nothing here read
it. Ryan, 2026-08-09: *"why are we running all of that on stuff that we aren't going to ship."*

`--ship-only` reads it and processes the 733 that ship, which is roughly half the wall clock.
OFF by default, so an existing command line is unchanged. With the flag set and `charted.json`
missing or unreadable the script EXITS rather than quietly doing all 1577, which is the failure
the flag exists to prevent.

NOTE ON `hydrography.geojson`

Despite the name, mode 1/13 is the **water edge**, not creeks: 119 of 125 lines lie entirely
over water at 4 ft median depth while 21 ft sits within 250 m, and 56 of them are closed loops
enclosing 60-87% dry ground, which are islands. That is why enabling "creeks" in the app draws a
line around every island. It is the right layer to walk for points and coves; it is the wrong
name. See HYDROGRAPHY_IS_NOT_CREEKS_2026-08-06.md.
"""
import argparse, json, math, os, sys, time
from collections import Counter, defaultdict

CELL_M = 25.0


# ── depth grid ──────────────────────────────────────────────────────────────────────────────

class Grid:
    __slots__ = ('W', 'S', 'dx', 'dy', 'nx', 'ny', 'g', 'cell')

    def __init__(self, feats, cell_m=CELL_M):
        xs, ys = [], []
        for f in feats:
            g = f.get('geometry') or {}
            polys = [g.get('coordinates')] if g.get('type') == 'Polygon' else (g.get('coordinates') or [])
            for poly in polys:
                for ring in (poly or []):
                    for c in ring:
                        xs.append(c[0])
                        ys.append(c[1])
        if not xs:
            raise ValueError('no depth_areas geometry')
        self.W, self.S, E, N = min(xs), min(ys), max(xs), max(ys)
        lat0 = (self.S + N) / 2
        self.cell = cell_m
        self.dx = cell_m / (111320.0 * math.cos(math.radians(lat0)))
        self.dy = cell_m / 110570.0
        self.nx = int((E - self.W) / self.dx) + 1
        self.ny = int((N - self.S) / self.dy) + 1
        self.g = bytearray(self.nx * self.ny)
        for f in feats:
            v = (f.get('properties') or {}).get('depth_max_ft')
            if v is None:
                continue
            v = min(255, max(1, int(round(v))))
            gm = f.get('geometry') or {}
            polys = [gm.get('coordinates')] if gm.get('type') == 'Polygon' else (gm.get('coordinates') or [])
            for poly in polys:
                if poly:
                    self._fill(poly[0], v)

    def _fill(self, ring, val):
        nx, ny, g = self.nx, self.ny, self.g
        ys = [p[1] for p in ring]
        j0 = max(0, int((min(ys) - self.S) / self.dy))
        j1 = min(ny - 1, int((max(ys) - self.S) / self.dy))
        n = len(ring)
        for j in range(j0, j1 + 1):
            yc = self.S + (j + 0.5) * self.dy
            xints = []
            for k in range(n - 1):
                x0, y0 = ring[k][0], ring[k][1]
                x1, y1 = ring[k + 1][0], ring[k + 1][1]
                if (y0 > yc) != (y1 > yc):
                    xints.append(x0 + (yc - y0) * (x1 - x0) / ((y1 - y0) or 1e-12))
            xints.sort()
            base = j * nx
            for a in range(0, len(xints) - 1, 2):
                i0 = max(0, int((xints[a] - self.W) / self.dx))
                i1 = min(nx - 1, int((xints[a + 1] - self.W) / self.dx))
                for i in range(i0, i1 + 1):
                    if g[base + i] < val:
                        g[base + i] = val

    def ij(self, lon, lat):
        return int((lon - self.W) / self.dx), int((lat - self.S) / self.dy)

    def at(self, lon, lat):
        i, j = self.ij(lon, lat)
        return self.g[j * self.nx + i] if 0 <= i < self.nx and 0 <= j < self.ny else 0

    def mean(self, lon, lat, r=2):
        i, j = self.ij(lon, lat)
        s = n = 0
        for jj in range(max(0, j - r), min(self.ny, j + r + 1)):
            b = jj * self.nx
            for ii in range(max(0, i - r), min(self.nx, i + r + 1)):
                s += self.g[b + ii]
                n += 1
        return s / max(1, n)

    def span(self, lon, lat, radius_m):
        """(deepest, shallowest) charted depth within radius. Shallowest ignores dry cells."""
        i, j = self.ij(lon, lat)
        ri = max(1, int(radius_m / self.cell))
        mx, mn, any_ = 0, 255, False
        for jj in range(max(0, j - ri), min(self.ny, j + ri + 1)):
            b = jj * self.nx
            for ii in range(max(0, i - ri), min(self.nx, i + ri + 1)):
                v = self.g[b + ii]
                if v:
                    any_ = True
                    if v > mx:
                        mx = v
                    if v < mn:
                        mn = v
        return (mx, mn) if any_ else (0, 0)

    def wet_km2(self):
        return sum(1 for v in self.g if v) * self.cell * self.cell / 1e6


def classify(own_ft, deepest, shallowest):
    drop = deepest - own_ft
    if drop >= 15:
        return 'channel_edge'
    if drop <= 4:
        return 'flat'
    if shallowest <= 2 and drop >= 8:
        return 'steep_bank'
    return 'break'


# ── points and coves ────────────────────────────────────────────────────────────────────────

def metres(a, b):
    return math.hypot((b[0] - a[0]) * 111320.0 * math.cos(math.radians((a[1] + b[1]) / 2)),
                      (b[1] - a[1]) * 110570.0)


def points_and_coves(edge_feats, grid, win_m, probe_m, min_bulge_m, sep_m):
    out = []
    for f in edge_feats:
        c = (f.get('geometry') or {}).get('coordinates') or []
        if len(c) < 20:
            continue
        cum = [0.0]
        for i in range(1, len(c)):
            cum.append(cum[-1] + metres(c[i - 1], c[i]))
        if cum[-1] < 400:
            continue
        n = len(c)
        cand = []
        for i in range(n):
            a = i
            while a > 0 and cum[i] - cum[a] < win_m:
                a -= 1
            b = i
            while b < n - 1 and cum[b] - cum[i] < win_m:
                b += 1
            if cum[i] - cum[a] < win_m * 0.6 or cum[b] - cum[i] < win_m * 0.6:
                continue
            mx = (c[a][0] + c[b][0]) / 2
            my = (c[a][1] + c[b][1]) / 2
            bul = metres((mx, my), (c[i][0], c[i][1]))
            if bul < min_bulge_m:
                continue
            # Scale the degree-space vector by the ratio of the wanted distance to its own
            # length in metres. Converting to metres and back is where this first went wrong --
            # it moved the probe by 1/92000 of the intended distance and every depth difference
            # came back as exactly 0.00 ft.
            ux = (c[i][0] - mx) * probe_m / bul
            uy = (c[i][1] - my) * probe_m / bul
            d_out = grid.mean(c[i][0] + ux, c[i][1] + uy)
            d_in = grid.mean(c[i][0] - ux, c[i][1] - uy)
            if abs(d_out - d_in) < 1.0:
                continue
            cand.append((bul, i, 'point' if d_out > d_in else 'cove', d_out, d_in))
        cand.sort(key=lambda t: -t[0])
        taken = []
        for bul, i, kind, do, di in cand:
            if any(abs(cum[i] - cum[j]) < sep_m for j in taken):
                continue
            taken.append(i)
            out.append({'kind': kind, 'lon': c[i][0], 'lat': c[i][1], 'bulge_m': round(bul),
                        'deep_side_ft': round(do, 1), 'shallow_side_ft': round(di, 1)})
    return out


# ── per-pack ────────────────────────────────────────────────────────────────────────────────

def ship_only_slugs(registry):
    """The lakes that actually get uploaded, read from `<registry>/charted.json`.

    `build_all_chartpacks.py` already decided this and wrote it down: a lake ships when its
    record carries NO `skipped` reason and a non-null `charted`. A skip reason, a null `charted`,
    or no record at all means it is passed over. Nothing is re-derived here -- a second
    implementation of the ship test is how the two copies drift apart.

    Unreadable file is fatal on purpose. The whole point of the flag is not doing the work; a
    quiet fallback to "process everything" would be the failure it exists to prevent.
    """
    path = os.path.join(registry, 'charted.json')
    try:
        with open(path, encoding='utf-8') as fh:
            rows = json.load(fh)
    except (OSError, ValueError) as e:
        sys.exit('--ship-only: cannot read %s (%s: %s)\n'
                 '             refusing to run, because without it this processes every pack'
                 % (path, type(e).__name__, e))
    if not isinstance(rows, dict) or not rows:
        sys.exit('--ship-only: %s is not a slug->record map' % path)
    ship = {k for k, v in rows.items()
            if isinstance(v, dict) and not v.get('skipped') and v.get('charted') is not None}
    return ship, len(rows)


def load(pack, name):
    p = os.path.join(pack, name)
    if not os.path.isfile(p):
        return []
    try:
        with open(p, 'r', encoding='utf-8') as fh:
            return (json.load(fh) or {}).get('features') or []
    except Exception:
        return []


def build_one(pack, a):
    da = load(pack, 'depth_areas.geojson')
    if not da:
        return None
    grid = Grid(da)
    edge = load(pack, 'hydrography.geojson')          # mislabelled: this is the water edge
    feats = points_and_coves(edge, grid, a.curve_m, a.probe_m, a.min_bulge_m, a.sep_m)

    # Creek mouths: read the names, do not invent the geometry. See the module docstring for
    # the two geometric methods that were tried and failed.
    creeks = []
    for x in load(pack, 'pois.geojson'):
        nm = ((x.get('properties') or {}).get('name') or '').strip()
        if nm.lower().endswith(('creek', 'branch', 'river')) and len(nm) > 5:
            c = (x.get('geometry') or {}).get('coordinates')
            if c and len(c) >= 2:
                creeks.append((nm, c[0], c[1]))
    coves = [f for f in feats if f['kind'] == 'cove']
    seen = set()
    for nm, lo, la in creeks:
        best, bd = None, 1e9
        for cv in coves:
            d = metres((lo, la), (cv['lon'], cv['lat']))
            if d < bd:
                best, bd = cv, d
        if best and bd <= a.mouth_m:
            key = (round(best['lon'], 5), round(best['lat'], 5))
            if key in seen:
                continue
            seen.add(key)
            feats.append({'kind': 'creek_mouth', 'lon': best['lon'], 'lat': best['lat'],
                          'name': nm, 'cove_m': round(bd)})

    for f in feats:
        d, s = grid.span(f['lon'], f['lat'], a.relief_m)
        own = grid.at(f['lon'], f['lat'])
        f['deepest_within_m'] = d
        f['relief'] = classify(own, d, s)

    out = {'type': 'FeatureCollection',
           'note': 'points/coves from water-edge curvature + a depth probe; creek mouths are '
                   'named POIs paired with their cove, not derived geometry',
           'features': [{'type': 'Feature',
                         'geometry': {'type': 'Point',
                                      'coordinates': [round(f['lon'], 6), round(f['lat'], 6)]},
                         'properties': {k: v for k, v in f.items() if k not in ('lon', 'lat')}}
                        for f in feats]}
    with open(os.path.join(pack, 'water_features.geojson'), 'w', encoding='utf-8') as fh:
        json.dump(out, fh)

    # Annotate the trolling runs in place with relief, and with the points/coves they pass.
    runs_p = os.path.join(pack, 'trolling_runs.geojson')
    n_runs = 0
    if os.path.isfile(runs_p):
        try:
            with open(runs_p, 'r', encoding='utf-8') as fh:
                doc = json.load(fh)
            pcell = max(a.annotate_m, 50.0) / 111320.0 * 1.5
            pg = defaultdict(list)
            for f in feats:
                pg[(int(f['lon'] / pcell), int(f['lat'] / pcell))].append(f)
            for r in (doc.get('features') or []):
                pr = r['properties']
                co = r['geometry']['coordinates']
                step = max(1, len(co) // 14)
                cls = Counter()
                deep = 0
                for c in co[::step]:
                    d, s = grid.span(c[0], c[1], a.relief_m)
                    if not d:
                        continue
                    deep = max(deep, d)
                    cls[classify(pr['depth_ft'], d, s)] += 1
                if cls:
                    pr['relief'] = cls.most_common(1)[0][0]
                    pr['relief_mix'] = dict(cls)
                    pr['deepest_within_m'] = deep
                near = pr.get("near") or []
                seen2 = set()
                slen = 0.0
                for vi, c in enumerate(co):
                    if vi:
                        slen += metres(co[vi - 1], c)
                    gx, gy = int(c[0] / pcell), int(c[1] / pcell)
                    for dx in (-1, 0, 1):
                        for dy in (-1, 0, 1):
                            for f in pg.get((gx + dx, gy + dy), ()):
                                d = metres(c, (f['lon'], f['lat']))
                                if d > a.annotate_m:
                                    continue
                                key = (round(f['lon'], 6), round(f['lat'], 6), f['kind'])
                                if key in seen2:
                                    continue
                                seen2.add(key)
                                near.append({'s': round(slen), 't': f['kind'], 'd': round(d)})
                if near:
                    near.sort(key=lambda e: e['s'])
                    pr['near'] = near
                    cc = {}
                    for e in near:
                        cc[e['t']] = cc.get(e['t'], 0) + 1
                    pr['near_counts'] = cc
                n_runs += 1
            with open(runs_p, 'w', encoding='utf-8') as fh:
                json.dump(doc, fh)
        except Exception as e:
            print('   ! could not annotate trolling_runs: %s: %s' % (type(e).__name__, e))

    return {'wet_km2': round(grid.wet_km2(), 1),
            'features': len(feats),
            'kinds': dict(Counter(f['kind'] for f in feats)),
            'relief': dict(Counter(f['relief'] for f in feats)),
            'runs_annotated': n_runs}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--packs', required=True)
    ap.add_argument('--relief-m', type=float, default=250.0)
    ap.add_argument('--curve-m', type=float, default=200.0, help='chord window for the bulge')
    ap.add_argument('--probe-m', type=float, default=150.0, help='how far either side to sample depth')
    ap.add_argument('--min-bulge-m', type=float, default=40.0)
    ap.add_argument('--sep-m', type=float, default=300.0, help='min spacing between features')
    ap.add_argument('--mouth-m', type=float, default=500.0,
                    help='how close a cove must be to a creek name to be called its mouth')
    ap.add_argument('--annotate-m', type=float, default=100.0)
    ap.add_argument('--only', default=None)
    ap.add_argument('--report', default=None)
    ap.add_argument('--registry', default=None,
                    help='folder holding charted.json. Required by --ship-only; not guessed '
                         'from --packs, because guessing it wrong is a silent full run.')
    ap.add_argument('--ship-only', action='store_true',
                    help='process only the lakes that actually ship, per '
                         '<registry>/charted.json (734 of 1732 today). Off by default. Exits if '
                         'charted.json cannot be read rather than quietly processing every '
                         'pack. An explicit --only <slug> wins over this.')
    a = ap.parse_args()
    if a.ship_only and not a.registry:
        ap.error('--ship-only needs --registry (the folder holding charted.json)')

    slugs = [d for d in sorted(os.listdir(a.packs))
             if os.path.isdir(os.path.join(a.packs, d)) and (not a.only or d == a.only)]
    if a.ship_only:
        if a.only:
            print('--ship-only: not applied, --only %s names a lake explicitly' % a.only)
        else:
            ship, total = ship_only_slugs(a.registry)
            kept = [s for s in slugs if s in ship]
            # Say the number out loud. A cap that prints nothing reads as "covered everything".
            print('--ship-only: %d of %d packs ship; %d passed over'
                  % (len(ship), total, total - len(ship)))
            print('             %d of %d packs on disk selected; %d never uploaded, not built'
                  % (len(kept), len(slugs), len(slugs) - len(kept)))
            slugs = kept
    print('%d packs' % len(slugs))
    rep, t0 = {}, time.time()
    tot = Counter()
    done = skipped = 0
    for k, slug in enumerate(slugs, 1):
        try:
            r = build_one(os.path.join(a.packs, slug), a)
        except Exception as e:
            rep[slug] = {'error': '%s: %s' % (type(e).__name__, e)}
            skipped += 1
            continue
        if not r:
            skipped += 1
            continue
        rep[slug] = r
        done += 1
        for kk, vv in r['kinds'].items():
            tot[kk] += vv
        if k % 25 == 0 or k == len(slugs):
            print('  %d/%d  %d written, %d skipped, %.1f min'
                  % (k, len(slugs), done, skipped, (time.time() - t0) / 60))
    print('\n%d packs, %.1f min' % (done, (time.time() - t0) / 60))
    print('   features: %s' % dict(tot))
    rp = a.report or os.path.join(os.path.dirname(a.packs.rstrip('\\/')), 'registry',
                                  '_water_features.json')
    try:
        os.makedirs(os.path.dirname(rp), exist_ok=True)
        # A ship-only run touches 734 of 1732 lakes. Writing that straight over the card-wide
        # report leaves a file that reads as a statement about the card but describes half of
        # it -- the same trap build_trolling_runs.py records for --only. So a ship-only run
        # updates the rows it touched, leaves the rest alone, and says it was partial. A full
        # run writes exactly what it always did, key and all.
        merged = rep
        if a.ship_only and not a.only and os.path.exists(rp):
            try:
                with open(rp, encoding='utf-8') as fh:
                    prev = json.load(fh)
                if isinstance(prev.get('lakes'), dict):
                    merged = dict(prev['lakes'])
                    merged.update(rep)
            except (OSError, ValueError):
                pass              # unreadable previous report is not worth failing over
        doc = {'lakes': merged}
        if a.ship_only and not a.only:
            doc['partial'] = 'ship-only'
        with open(rp, 'w', encoding='utf-8') as fh:
            json.dump(doc, fh, indent=1)
        print('-> %s%s' % (rp, '  (merged, %d packs)' % len(merged)
                           if a.ship_only and not a.only else ''))
    except Exception as e:
        print('could not write report: %s' % e)


if __name__ == '__main__':
    main()
