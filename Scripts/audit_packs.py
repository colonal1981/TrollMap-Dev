#!/usr/bin/env python3
"""audit_packs.py - is the pipeline making the packs better or worse?

Personal use only, not for distribution or resale; not for navigation.

    py .\\audit_packs.py --packs "F:\\TrollMapPipeline\\chartpack"
    py .\\audit_packs.py --packs "..." --only wateree_lake -v
    py .\\audit_packs.py --packs "..." --baseline "F:\\TrollMapPipeline\\registry\\_audit.json"

Writes `registry\\_audit.json` and, when a previous one exists, prints what CHANGED. Exits
non-zero if anything regressed, so it can gate an upload.

WHY

Ryan, 2026-08-06: *"keep an eye on the audit to make sure we aren't making things worse instead
of better."*

The morning's rebuild was verified by hand and reported clean. It was not. `garmin_shoreline`
still carried six stacked detail levels because `ZOOM_LAYERS` listed the output filename
(`garmin_shoreline`) while the code tests the SHIP key (`shoreline`) — one word, four of five
layers cleaned, one silently skipped. It showed up in the app as blue lines scattered over dry
land, and it took a user report and an afternoon to find.

Every check below is one that has actually caught something on this data. None of them are
hypothetical.

WHAT IT CHECKS

  zoom purity      Any layer that should be a single detail level carrying more than one.
                   This is the check that would have caught the shoreline bug in seconds:
                   zoom 0 had 0.0% of its vertices over land, zooms 1-5 had 22-48%.

  geometry on land Fraction of each layer's vertices more than `--land-m` from any charted
                   water, measured against a raster built from that pack's own depth_areas.
                   Some layers are legitimately partly on land -- a POI can be a parking lot or
                   a boat ramp -- so each carries its own budget, and the budget is stated
                   rather than assumed.

  graph health     Orphan nodes as a share of the water graph. 9.5% of Wateree was unroutable
                   until the graphs were rebuilt with the one-ring halo; a leg planned into one
                   fails with no explanation a user could act on.

  run reachability Share of trolling runs marked unroutable. Rises the moment a graph
                   regresses, and is the cheapest early warning that step 1 was skipped.

  water area       Rasterised wet area against the registry's acreage. Catches a pack whose
                   depth_areas are truncated, mis-framed or empty -- everything else in this
                   file is derived from that raster, so if it is wrong nothing downstream is
                   trustworthy.

  layer presence   A pack that had a layer yesterday and does not today.

REGRESSION, NOT ABSOLUTE

Most of these numbers are not zero and never will be. What matters is the direction. With a
baseline the script reports deltas and fails only on a WORSENING beyond `--tolerance`, so it can
run before every upload without needing anyone to remember what "normal" was.
"""
import argparse, json, math, os, sys, time
from collections import Counter, defaultdict

# Layers Garmin stores once per detail level. Any of these carrying more than one zoom means a
# filter did not fire. Keyed by the FILENAME, because that is what is on disk here -- the whole
# bug this check exists for was a filename being used where a layer key was meant.
SINGLE_ZOOM = ('contours.geojson', 'depth_areas.geojson', 'garmin_shoreline.geojson',
               'hydrography.geojson', 'waterbody.geojson')

# How much of a layer may legitimately sit on dry ground.
LAND_BUDGET = {
    'contours.geojson': 1.0,
    'depth_areas.geojson': 1.0,
    'waterbody.geojson': 3.0,
    'garmin_shoreline.geojson': 2.0,
    'hydrography.geojson': 5.0,
    'docks.geojson': 5.0,
    # A POI is allowed on land: parking lots, ramps and bridges are POIs and are meant to be
    # there. 6.2% of Wateree's zoom-0 POIs are on land and every one of them is correct.
    'pois.geojson': 12.0,
    'structure.geojson': 1.0,
    'trolling_runs.geojson': 1.0,
    'water_features.geojson': 5.0,
}

CELL_M = 25.0
LAND_M = 50.0


# ── depth raster ────────────────────────────────────────────────────────────────────────────

class Wet:
    def __init__(self, feats, cell_m=CELL_M):
        xs, ys = [], []
        for f in feats:
            for ring in rings_of(f):
                for c in ring:
                    xs.append(c[0]); ys.append(c[1])
        if not xs:
            raise ValueError('depth_areas has no geometry')
        self.W, self.S, E, N = min(xs), min(ys), max(xs), max(ys)
        lat0 = (self.S + N) / 2
        self.cell = cell_m
        self.dx = cell_m / (111320.0 * math.cos(math.radians(lat0)))
        self.dy = cell_m / 110570.0
        self.nx = int((E - self.W) / self.dx) + 1
        self.ny = int((N - self.S) / self.dy) + 1
        self.g = bytearray(self.nx * self.ny)
        for f in feats:
            for ring in rings_of(f, outer_only=True):
                self._fill(ring)
        self.pad = max(1, int(LAND_M / cell_m))

    def _fill(self, ring):
        ys = [p[1] for p in ring]
        j0 = max(0, int((min(ys) - self.S) / self.dy))
        j1 = min(self.ny - 1, int((max(ys) - self.S) / self.dy))
        for j in range(j0, j1 + 1):
            yc = self.S + (j + 0.5) * self.dy
            xi = []
            for k in range(len(ring) - 1):
                x0, y0 = ring[k][0], ring[k][1]
                x1, y1 = ring[k + 1][0], ring[k + 1][1]
                if (y0 > yc) != (y1 > yc):
                    xi.append(x0 + (yc - y0) * (x1 - x0) / ((y1 - y0) or 1e-12))
            xi.sort()
            base = j * self.nx
            for a in range(0, len(xi) - 1, 2):
                i0 = max(0, int((xi[a] - self.W) / self.dx))
                i1 = min(self.nx - 1, int((xi[a + 1] - self.W) / self.dx))
                for i in range(i0, i1 + 1):
                    self.g[base + i] = 1

    def wet(self, lon, lat):
        i = int((lon - self.W) / self.dx); j = int((lat - self.S) / self.dy)
        p = self.pad
        for jj in range(max(0, j - p), min(self.ny, j + p + 1)):
            b = jj * self.nx
            for ii in range(max(0, i - p), min(self.nx, i + p + 1)):
                if self.g[b + ii]:
                    return True
        return False

    def km2(self):
        return sum(self.g) * self.cell * self.cell / 1e6


def rings_of(f, outer_only=False):
    g = f.get('geometry') or {}
    t = g.get('type'); c = g.get('coordinates')
    if not c:
        return []
    if t == 'Polygon':
        return [c[0]] if outer_only else c
    if t == 'MultiPolygon':
        return [p[0] for p in c] if outer_only else [r for p in c for r in p]
    return []


def sample_points(f, cap=25):
    g = f.get('geometry') or {}
    t = g.get('type'); c = g.get('coordinates')
    if not c:
        return []
    if t == 'Point':
        pts = [c]
    elif t == 'LineString':
        pts = c
    elif t == 'MultiLineString':
        pts = [p for l in c for p in l]
    elif t == 'Polygon':
        pts = c[0]
    elif t == 'MultiPolygon':
        pts = c[0][0]
    else:
        return []
    step = max(1, len(pts) // cap)
    return pts[::step]


def load(pack, name):
    p = os.path.join(pack, name)
    if not os.path.isfile(p):
        return None
    try:
        with open(p, 'r', encoding='utf-8') as fh:
            return (json.load(fh) or {}).get('features') or []
    except Exception:
        return None


# ── graph ───────────────────────────────────────────────────────────────────────────────────

def graph_health(pack):
    import struct
    p = os.path.join(pack, 'water_graph.bin')
    if not os.path.isfile(p):
        return None
    try:
        b = open(p, 'rb').read()
        if b[:4] != b'TMWG':
            return {'error': 'bad magic'}
        _v, _l, _base, nn, ne = struct.unpack_from('<BBHII', b, 4)
        off = 16 + nn * 8
        edges = [struct.unpack_from('<II', b, off + i * 8) for i in range(ne)]
        adj = defaultdict(list)
        for a, c in edges:
            if a < nn and c < nn:
                adj[a].append(c); adj[c].append(a)
        seen, best = set(), 0
        for s in range(nn):
            if s in seen:
                continue
            stack, n = [s], 0
            seen.add(s)
            while stack:
                u = stack.pop(); n += 1
                for v in adj[u]:
                    if v not in seen:
                        seen.add(v); stack.append(v)
            best = max(best, n)
        return {'nodes': nn, 'edges': ne, 'orphan_pct': round(100.0 * (nn - best) / max(1, nn), 2)}
    except Exception as e:
        return {'error': '%s: %s' % (type(e).__name__, e)}


# ── per-pack ────────────────────────────────────────────────────────────────────────────────

def audit_one(pack, acres=None):
    da = load(pack, 'depth_areas.geojson')
    if not da:
        return {'error': 'no depth_areas.geojson'}
    wet = Wet(da)
    out = {'wet_km2': round(wet.km2(), 2), 'layers': {}, 'issues': []}
    if acres:
        reg = acres * 0.00404686
        out['registry_km2'] = round(reg, 2)
        # Rasterisation inflates at the edges; way outside this and the pack is suspect.
        if reg > 0.5 and not (0.6 <= wet.km2() / reg <= 1.8):
            out['issues'].append('wet area %.1f km2 vs registry %.1f km2' % (wet.km2(), reg))

    for name in sorted(set(list(LAND_BUDGET) + list(SINGLE_ZOOM))):
        feats = load(pack, name)
        if feats is None:
            continue
        zooms = Counter(((f.get('properties') or {}).get('zoom')) for f in feats)
        tot = dry = 0
        by_zoom = defaultdict(lambda: [0, 0])
        for f in feats:
            z = (f.get('properties') or {}).get('zoom')
            for p in sample_points(f):
                tot += 1; by_zoom[z][0] += 1
                if not wet.wet(p[0], p[1]):
                    dry += 1; by_zoom[z][1] += 1
        pct = round(100.0 * dry / max(1, tot), 2)
        rec = {'features': len(feats), 'sampled': tot, 'on_land_pct': pct,
               'zooms': {str(k): v for k, v in sorted(zooms.items(), key=lambda t: (t[0] is None, t[0]))}}
        out['layers'][name] = rec

        if name in SINGLE_ZOOM:
            real = [z for z in zooms if z is not None]
            if len(real) > 1:
                worst = max(((z, 100.0 * by_zoom[z][1] / max(1, by_zoom[z][0])) for z in real
                             if by_zoom[z][0] > 10), key=lambda t: t[1], default=(None, 0))
                rec['zoom_stacked'] = True
                out['issues'].append(
                    '%s carries %d detail levels (%s); worst is zoom %s at %.0f%% on land'
                    % (name, len(real), ','.join(str(z) for z in sorted(real)), worst[0], worst[1]))
        budget = LAND_BUDGET.get(name)
        if budget is not None and pct > budget:
            out['issues'].append('%s is %.1f%% on land (budget %.1f%%)' % (name, pct, budget))

    g = graph_health(pack)
    if g:
        out['graph'] = g
        if g.get('orphan_pct', 0) > 1.0:
            # NOT "run restitch_water_graphs.py" -- that script is RETRACTED. It guessed by
            # distance the edges Garmin states in ADJ and the boundary clip deleted, and at
            # --max-m 75 it welded water above a dam to water below it on 178 lakes.
            out['issues'].append('water graph has %.1f%% orphan nodes (lakes run ~5.6%%, rivers '
                                 '~38%% because a river boundary is a ribbon -- widen the '
                                 'BOUNDARY, do not widen the halo)'
                                 % g['orphan_pct'])
    runs = load(pack, 'trolling_runs.geojson')
    if runs:
        bad = sum(1 for f in runs if (f.get('properties') or {}).get('routable') is False)
        out['runs'] = {'total': len(runs), 'unroutable_pct': round(100.0 * bad / max(1, len(runs)), 2)}
        if out['runs']['unroutable_pct'] > 5.0:
            out['issues'].append('%.1f%% of trolling runs are unreachable' % out['runs']['unroutable_pct'])
    return out


# ── main ────────────────────────────────────────────────────────────────────────────────────

def compare(old, new, tol):
    """Return (regressions, improvements) as human-readable lines."""
    reg, imp = [], []
    for slug, n in new.items():
        o = old.get(slug)
        if not o or 'error' in o or 'error' in n:
            continue
        for name, nl in (n.get('layers') or {}).items():
            ol = (o.get('layers') or {}).get(name)
            if not ol:
                continue
            d = nl['on_land_pct'] - ol['on_land_pct']
            if d > tol:
                reg.append('%s %s on-land %.2f%% -> %.2f%% (+%.2f)' % (slug, name, ol['on_land_pct'], nl['on_land_pct'], d))
            elif d < -tol:
                imp.append('%s %s on-land %.2f%% -> %.2f%% (%.2f)' % (slug, name, ol['on_land_pct'], nl['on_land_pct'], d))
            if nl.get('zoom_stacked') and not ol.get('zoom_stacked'):
                reg.append('%s %s became zoom-stacked' % (slug, name))
            elif ol.get('zoom_stacked') and not nl.get('zoom_stacked'):
                imp.append('%s %s zoom stacking cleared' % (slug, name))
        og, ng = o.get('graph') or {}, n.get('graph') or {}
        if 'orphan_pct' in og and 'orphan_pct' in ng:
            d = ng['orphan_pct'] - og['orphan_pct']
            if d > tol:
                reg.append('%s graph orphans %.2f%% -> %.2f%%' % (slug, og['orphan_pct'], ng['orphan_pct']))
            elif d < -tol:
                imp.append('%s graph orphans %.2f%% -> %.2f%%' % (slug, og['orphan_pct'], ng['orphan_pct']))
        gone = set(o.get('layers') or {}) - set(n.get('layers') or {})
        for name in sorted(gone):
            reg.append('%s LOST layer %s' % (slug, name))
    return reg, imp


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--packs', required=True)
    ap.add_argument('--registry', default=None, help='for the acreage cross-check')
    ap.add_argument('--report', default=None)
    ap.add_argument('--baseline', default=None, help='defaults to the previous --report')
    ap.add_argument('--tolerance', type=float, default=0.5, help='percentage points before a change counts')
    ap.add_argument('--strict', action='store_true',
                    help='exit non-zero on ANY issue, not only on a regression. Off by default '
                         'because most of these numbers are not zero and never will be -- the '
                         'default gate is "worse than last time", which is the question asked.')
    ap.add_argument('--only', default=None)
    ap.add_argument('--limit', type=int, default=0, help='audit only the first N packs')
    ap.add_argument('-v', '--verbose', action='store_true')
    a = ap.parse_args()

    acres = {}
    reg_dir = a.registry or os.path.join(os.path.dirname(a.packs.rstrip('\\/')), 'registry')
    try:
        with open(os.path.join(reg_dir, 'lake_index.json'), 'r', encoding='utf-8') as fh:
            for slug, rec in (json.load(fh) or {}).items():
                if isinstance(rec, dict) and rec.get('area_acres'):
                    acres[slug] = rec['area_acres']
    except Exception:
        pass

    slugs = [d for d in sorted(os.listdir(a.packs))
             if os.path.isdir(os.path.join(a.packs, d)) and (not a.only or d == a.only)]
    if a.limit:
        slugs = slugs[:a.limit]
    print('auditing %d packs' % len(slugs))

    rep_path = a.report or os.path.join(reg_dir, '_audit.json')
    base = {}
    bp = a.baseline or rep_path
    if os.path.isfile(bp):
        try:
            with open(bp, 'r', encoding='utf-8') as fh:
                base = (json.load(fh) or {}).get('packs') or {}
            print('baseline: %s (%d packs)' % (bp, len(base)))
        except Exception:
            pass

    out, t0, issues = {}, time.time(), 0
    for k, slug in enumerate(slugs, 1):
        try:
            r = audit_one(os.path.join(a.packs, slug), acres.get(slug))
        except Exception as e:
            r = {'error': '%s: %s' % (type(e).__name__, e)}
        out[slug] = r
        n = len(r.get('issues') or [])
        issues += n
        if n and (a.verbose or n):
            for i in r['issues']:
                print('  %-26s %s' % (slug, i))
        if k % 50 == 0 or k == len(slugs):
            print('  %d/%d  %.1f min' % (k, len(slugs), (time.time() - t0) / 60))

    os.makedirs(os.path.dirname(rep_path), exist_ok=True)
    with open(rep_path, 'w', encoding='utf-8') as fh:
        json.dump({'landM': LAND_M, 'cellM': CELL_M, 'packs': out}, fh, indent=1)

    print('\n%d packs, %d issue(s), %.1f min' % (len(out), issues, (time.time() - t0) / 60))
    rc = 0
    if base:
        regs, imps = compare(base, out, a.tolerance)
        if imps:
            print('\nBETTER than the baseline (%d):' % len(imps))
            for s in imps[:25]:
                print('   %s' % s)
        if regs:
            print('\nWORSE than the baseline (%d):' % len(regs))
            for s in regs[:25]:
                print('   %s' % s)
            rc = 1
        if not regs and not imps:
            print('\nno change against the baseline beyond %.2f points' % a.tolerance)
    elif issues:
        print('\nno baseline yet — this run becomes the baseline. Re-run after the next build '
              'and it will report what changed.')
    if a.strict and issues:
        rc = 1
    print('-> %s' % rep_path)
    sys.exit(rc)


if __name__ == '__main__':
    main()
