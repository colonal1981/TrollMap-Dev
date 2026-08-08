#!/usr/bin/env python3
"""build_trolling_runs.py - turn stored contour fragments into runs a boat can actually troll.

Personal use only, not for distribution or resale; not for navigation.

    py .\\build_trolling_runs.py --packs "F:\\TrollMapPipeline\\chartpack"
    py .\\build_trolling_runs.py --packs "..." --min-len-m 200 --simplify-m 5

Writes `<slug>/trolling_runs.geojson` beside the other pack layers.

WHY THIS EXISTS

Ryan, on why Smart Plan was built to drop waypoints and connect them rather than follow a
depth: *"with the i-boating contours it wouldn't actually follow a contour."* That was true and
it was not Smart Plan's fault. i-Boating's contours arrive shattered -- the longest continuous
run measured was 1.68 km -- so there was nothing to follow.

Garmin's are not shattered, they are just STORED in fragments. On Wateree the line nearest
twelve feet is held as 185 separate LineStrings; joined end to end they make 155 runs and the
longest is 45.34 km. The line was always there. Nothing had ever put it back together.

This script does that once, offline, per pack. After it, "follow the 12 ft line for two
kilometres" is a slice of a polyline instead of a routing problem.

WHAT A CONSUMER MUST KNOW ABOUT THE DEPTHS

**The contours are metric-derived, so round foot values mostly do not exist.** The stored field
is `depth_dm`, decimetres: `depth_dm 3` is 0.3 m is 1.0 ft. Near twelve feet the charted lines
are 11.2 ft (34 dm) and 12.1 ft (37 dm) and there is nothing between them.

So a caller asks for the nearest charted line to a target depth and is told what it actually
got. `depth_ft` here is rounded for display; `depth_dm` is the authoritative integer and the
right thing to match on. A UI that prints "12 ft" when the boat is following the 12.1 ft line
is lying by a tenth of a foot, which is fine -- but code that SEARCHES for 12 finds nothing.

CLOSED RINGS ARE THE INTERESTING ONES

143 of Wateree's 155 runs at 12.1 ft are closed. A depth on this lake is one large perimeter
loop plus roughly 150 small rings, and a small closed ring at depth is a hump. That is the same
feature `build_structure.py` finds coming the other way, from nesting, so the two layers
describe the same objects and can be cross-checked against each other.

This script deliberately does NOT re-derive hump-versus-basin. Deciding which side of a closed
contour is shallower needs the nesting analysis that `build_structure.py` already does, and two
implementations of that would drift. Here a ring is reported as closed, with its enclosed area,
and the classification is left to the layer that owns it.

REACHABILITY IS A PROPERTY OF THE RUN

Each run is bound to the lake's water graph: nearest node, distance to it, and -- the part that
matters -- whether that node is in the graph's largest connected component. A run in a severed
pocket is real water with a real contour that a boat cannot get to, and SmartPlan needs to know
that before it plans a leg there rather than after it fails to find a route.

**Rebuild the water graphs before this** (`build_water_graphs.py`, which carries the one-ring
halo), or `routable` will be pessimistic. On Wateree,
9.5% of the graph was severed by dropped sub-block portals until that repair ran; see
WATER_GRAPHS_WERE_SEVERED_2026-08-06.md.
"""
import argparse, json, math, os, struct, time
from collections import defaultdict

MAGIC = b'TMWG'


# ── geometry ────────────────────────────────────────────────────────────────────────────────

def metres(a, b):
    return math.hypot((b[0] - a[0]) * 111320.0 * math.cos(math.radians((a[1] + b[1]) / 2)),
                      (b[1] - a[1]) * 110570.0)


def length_m(c):
    return sum(metres(c[i - 1], c[i]) for i in range(1, len(c)))


def ring_area_m2(c):
    """Shoelace in a local equirectangular projection about the ring's own centroid."""
    if len(c) < 4:
        return 0.0
    lat0 = sum(p[1] for p in c) / len(c)
    k = math.cos(math.radians(lat0))
    s = 0.0
    for i in range(len(c) - 1):
        x0 = c[i][0] * 111320.0 * k
        y0 = c[i][1] * 110570.0
        x1 = c[i + 1][0] * 111320.0 * k
        y1 = c[i + 1][1] * 110570.0
        s += x0 * y1 - x1 * y0
    return abs(s) / 2.0


# ── Making a contour into a line a boat can steer ────────────────────────────────────────────
#
# 2026-08-08. Ryan, looking at the rendered runs over the satellite layer, with a red line drawn
# on top of what he would actually do: "i would never actually do what this is showing... i know
# we have this just blindly following a contour but that isn't what a fisherman would do."
#
# He is right, and it is not a tuning problem. A contour is a cartographer's line: it enters every
# pocket, wraps every dock cut and comes back out, because that is what the depth does. A boat
# holding two rods at 2 mph does not, and cannot -- each of those reversals swings the spread out
# of the zone and tangles it. What he drew instead was a chord straight across the mouth of the
# cove, and a straight run holding the band rather than tracing its wiggle.
#
# The obvious fix -- raise --simplify-m from 5 to 60 -- is wrong and would put him on the rocks.
# Douglas-Peucker is shape-blind. It has no idea which side of the line is water, so a chord that
# skips a headland cuts straight over the point. A shortcut across a cove mouth and a shortcut
# across a point look identical to RDP and are opposite in the only way that matters.
#
# So the shortcut is tested against the pack's own `depth_areas.geojson` instead of against
# geometry alone: a chord is allowed only where every point along it sits in charted water at
# least as deep as the contour being shortcutted. Cove mouths pass, because the water off the
# mouth is deeper than the line going into it. Points fail, because the water over a point is
# shallower. That distinction is the whole feature.


class DepthIndex:
    """
    Where is the water, and how deep, from `depth_areas.geojson`.

    A grid of polygon bounding boxes so a lookup touches a handful of candidates rather than all
    of them. Holes are honoured: a ring inside a polygon is an island, and an island is not water.
    """

    def __init__(self, features, cell_deg=0.004):
        self.cell = cell_deg
        self.grid = defaultdict(list)
        self.polys = []
        for f in features or []:
            g = f.get('geometry') or {}
            t = g.get('type')
            if t not in ('Polygon', 'MultiPolygon'):
                continue
            pr = f.get('properties') or {}
            hi = pr.get('depth_max_dm')
            if hi is None:
                continue
            parts = [g.get('coordinates')] if t == 'Polygon' else (g.get('coordinates') or [])
            for rings in parts:
                if not rings or not rings[0]:
                    continue
                xs = [p[0] for p in rings[0]]
                ys = [p[1] for p in rings[0]]
                box = (min(xs), min(ys), max(xs), max(ys))
                i = len(self.polys)
                self.polys.append((rings, int(hi), box))
                for gx in range(int(box[0] / cell_deg), int(box[2] / cell_deg) + 1):
                    for gy in range(int(box[1] / cell_deg), int(box[3] / cell_deg) + 1):
                        self.grid[(gx, gy)].append(i)

    def __len__(self):
        return len(self.polys)

    @staticmethod
    def _in_ring(ring, x, y):
        inside = False
        n = len(ring)
        j = n - 1
        for i in range(n):
            xi, yi = ring[i][0], ring[i][1]
            xj, yj = ring[j][0], ring[j][1]
            if (yi > y) != (yj > y):
                if x < (xj - xi) * (y - yi) / (yj - yi + 1e-18) + xi:
                    inside = not inside
            j = i
        return inside

    def shallowest_dm(self, x, y):
        """
        SHALLOWEST charted band containing this point, or None where nothing is charted.

        Shallowest, not deepest, and the difference is the whole safety argument. Garmin's depth
        areas usually tile the lake as adjacent bands, so a point falls in exactly one and it does
        not matter -- but where they overlap or nest, a shoal drawn inside a larger deep polygon
        would be invisible to a max(). The first version of this took the deepest and a test lake
        with a 3 ft point sitting in 20 ft water reported 20 ft over the point, which is precisely
        the chord that runs a boat aground. If anything charted says this water is thin, it is
        thin.
        """
        best = None
        for i in self.grid.get((int(x / self.cell), int(y / self.cell)), ()):
            rings, hi, box = self.polys[i]
            if not (box[0] <= x <= box[2] and box[1] <= y <= box[3]):
                continue
            if not self._in_ring(rings[0], x, y):
                continue
            if any(self._in_ring(h, x, y) for h in rings[1:]):
                continue          # an island
            if best is None or hi < best:
                best = hi
        return best


def chord_ok(a, b, dm, dindex, samples, tol_dm):
    """Would a straight run from a to b stay in water at least as deep as the dm contour?"""
    n = max(2, samples)
    for i in range(1, n):
        t = i / float(n)
        x = a[0] + (b[0] - a[0]) * t
        y = a[1] + (b[1] - a[1]) * t
        hi = dindex.shallowest_dm(x, y)
        if hi is None or hi < dm - tol_dm:
            return False
    return True


def steer(run, dm, dindex, max_chord_m, samples, tol_dm):
    """
    Replace the contour's wander with the longest legal straight lines.

    Exponential reach then a binary refine, rather than trying every j: a 400 m chord over 5 m
    vertices is 80 candidates, and testing all of them for every vertex of every run of every
    depth of 1,500 lakes is the difference between a coffee and an afternoon. Validity is not
    strictly monotonic in reach -- a longer chord can clear a shoal a shorter one clipped -- so
    this can leave a slightly shorter line than the true optimum. It is a trolling pass, not a
    packing problem.
    """
    n = len(run)
    if dindex is None or len(dindex) == 0 or n < 3:
        return None
    out = [run[0]]
    i = 0
    while i < n - 1:
        lo = i + 1                                   # always legal: it is the contour itself
        step = 1
        while True:                                  # reach out while it holds
            j = i + step * 2
            if j >= n or metres(run[i], run[j]) > max_chord_m:
                break
            if not chord_ok(run[i], run[j], dm, dindex, samples, tol_dm):
                break
            lo = j
            step *= 2
        hi = min(n - 1, i + step * 2)
        while lo + 1 < hi:                           # then close the gap
            mid = (lo + hi) // 2
            if metres(run[i], run[mid]) <= max_chord_m and \
               chord_ok(run[i], run[mid], dm, dindex, samples, tol_dm):
                lo = mid
            else:
                hi = mid
        out.append(run[lo])
        i = lo
    return out


def rdp(pts, eps_m):
    """Douglas-Peucker. A trolling line does not need centimetre fidelity; 5 m keeps the shape
    a plotter draws and drops roughly three quarters of the vertices."""
    if len(pts) < 3 or eps_m <= 0:
        return pts
    eps = eps_m / 111320.0
    keep = {0, len(pts) - 1}
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        if j - i < 2:
            continue
        ax, ay = pts[i][0], pts[i][1]
        bx, by = pts[j][0], pts[j][1]
        dx, dy = bx - ax, by - ay
        den = dx * dx + dy * dy
        mx, mi = 0.0, None
        for k in range(i + 1, j):
            px, py = pts[k][0], pts[k][1]
            if den == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / den))
                d = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
            if d > mx:
                mx, mi = d, k
        if mx > eps:
            keep.add(mi)
            stack += [(i, mi), (mi, j)]
    return [pts[k] for k in sorted(keep)]


def stitch(lines, quant=5):
    """Join fragments that share an endpoint into maximal runs.

    Endpoints are quantised to `quant` decimal places -- 1e-5 degrees is about 1.1 m -- because
    the fragments come from different tiles and a shared vertex is shared to the precision it
    was written at, not exactly.
    """
    q = lambda p: (round(p[0], quant), round(p[1], quant))
    segs = {i: list(c) for i, c in enumerate(lines) if len(c) >= 2}
    ends = defaultdict(list)
    for i, c in segs.items():
        ends[q(c[0])].append(i)
        ends[q(c[-1])].append(i)
    used, runs = set(), []
    for i in list(segs):
        if i in used:
            continue
        used.add(i)
        run = list(segs[i])
        for _ in range(2):                          # grow forward, reverse, grow again
            while True:
                tail = q(run[-1])
                nxt = None
                for j in ends.get(tail, ()):
                    if j not in used:
                        nxt = j
                        break
                if nxt is None:
                    break
                used.add(nxt)
                c = list(segs[nxt])
                if q(c[0]) != tail:
                    c.reverse()
                run += c[1:]
            run.reverse()
        runs.append(run)
    return runs


# ── the water graph, for reachability ───────────────────────────────────────────────────────

def read_graph(path):
    b = open(path, 'rb').read()
    if b[:4] != MAGIC:
        return None
    _ver, _layer, _base, nn, ne = struct.unpack_from('<BBHII', b, 4)
    off = 16
    nodes = [struct.unpack_from('<ii', b, off + i * 8) for i in range(nn)]
    nodes = [(x / 1e7, y / 1e7) for x, y in nodes]
    off += nn * 8
    edges = [struct.unpack_from('<II', b, off + i * 8) for i in range(ne)]
    return nodes, edges


def main_component(n, edges):
    adj = defaultdict(list)
    for a, b in edges:
        adj[a].append(b)
        adj[b].append(a)
    seen, best = set(), set()
    for s in range(n):
        if s in seen:
            continue
        stack, mem = [s], []
        seen.add(s)
        while stack:
            u = stack.pop()
            mem.append(u)
            for v in adj[u]:
                if v not in seen:
                    seen.add(v)
                    stack.append(v)
        if len(mem) > len(best):
            best = set(mem)
    return best


class NodeIndex:
    def __init__(self, nodes, cell_m=200.0):
        self.nodes = nodes
        self.cell = cell_m / 111320.0
        self.grid = defaultdict(list)
        for i, p in enumerate(nodes):
            self.grid[(int(p[0] / self.cell), int(p[1] / self.cell))].append(i)

    def nearest(self, p, max_rings=4):
        gx, gy = int(p[0] / self.cell), int(p[1] / self.cell)
        best, bi = float('inf'), None
        for r in range(max_rings):
            for dx in range(-r, r + 1):
                for dy in range(-r, r + 1):
                    if r and max(abs(dx), abs(dy)) != r:
                        continue
                    for j in self.grid.get((gx + dx, gy + dy), ()):
                        d = metres(p, self.nodes[j])
                        if d < best:
                            best, bi = d, j
            if bi is not None and best <= r * self.cell * 111320.0:
                break
        return bi, best


# ── per-pack ────────────────────────────────────────────────────────────────────────────────

# Garmin's own POI names for things a fish relates to. These are NOT the DNR attractor feed --
# that shows where the state dropped a brushpile, 8 points on Wateree. These are charted natural
# cover and hazards: 55 Flooded Timber, 61 Shallow Area, 45 hazard marks on the same lake. Ryan,
# 2026-08-06: "fish attractors aren't going to show you stump fields or submerged timber, they
# will just show where dnr has dropped a brushpile or a clump of old bridge."
POI_KINDS = {
    'Flooded Timber': 'timber',
    'Shallow Area': 'shallow',
    'Hazard, Spar/Spindle Buoy': 'hazard',
    'Hazard Area': 'hazard',
    'Pile': 'pile',
    'Piles': 'pile',
    'Fish Attractor Buoy, Spar/Spindle Buoy': 'attractor',
    'Fish Attractor Buoy': 'attractor',
    'Bridge': 'bridge',
}


def load_points(pack):
    """Every feature a run can be annotated with: charted cover from the POI layer, humps and
    ledges from the structure layer. Returns [(lon, lat, kind, depth_ft or None)]."""
    pts = []
    p = os.path.join(pack, 'pois.geojson')
    if os.path.isfile(p):
        try:
            with open(p, 'r', encoding='utf-8') as fh:
                for x in (json.load(fh).get('features') or []):
                    pr = x.get('properties') or {}
                    k = POI_KINDS.get(pr.get('name')) or POI_KINDS.get(pr.get('class'))
                    if not k:
                        t = (pr.get('poi_type') or '')
                        k = 'timber' if 'timber' in t else None
                    if not k:
                        continue
                    c = (x.get('geometry') or {}).get('coordinates')
                    if c and len(c) >= 2:
                        pts.append((c[0], c[1], k, None))
        except Exception:
            pass
    p = os.path.join(pack, 'structure.geojson')
    if os.path.isfile(p):
        try:
            with open(p, 'r', encoding='utf-8') as fh:
                for x in (json.load(fh).get('features') or []):
                    pr = x.get('properties') or {}
                    c = (x.get('geometry') or {}).get('coordinates')
                    if pr.get('kind') and c and len(c) >= 2:
                        pts.append((c[0], c[1], pr['kind'], pr.get('depth_ft')))
        except Exception:
            pass
    return pts


def build_one(pack, min_len, simplify, reach_m, annotate_m=100.0,
              chord_m=0.0, chord_samples=6, chord_tol_dm=3):
    cpath = os.path.join(pack, 'contours.geojson')
    if not os.path.isfile(cpath):
        return None
    with open(cpath, 'r', encoding='utf-8') as fh:
        feats = (json.load(fh) or {}).get('features') or []
    if not feats:
        return None

    idx = mainset = None
    gpath = os.path.join(pack, 'water_graph.bin')
    if os.path.isfile(gpath):
        g = read_graph(gpath)
        if g:
            nodes, edges = g
            idx = NodeIndex(nodes)
            mainset = main_component(len(nodes), edges)

    # The chord validator. Absent depth areas this stays None and every run falls back to plain
    # RDP -- which is the old behaviour, and is what 988 packs with no soundings will get.
    dindex = None
    if chord_m > 0:
        dpath = os.path.join(pack, 'depth_areas.geojson')
        if os.path.isfile(dpath):
            try:
                with open(dpath, 'r', encoding='utf-8') as fh:
                    dindex = DepthIndex((json.load(fh) or {}).get('features') or [])
                if len(dindex) == 0:
                    dindex = None
            except Exception as e:
                print('   !! %s depth_areas unreadable (%s) -- contours kept as drawn'
                      % (os.path.basename(pack), str(e)[:60]))
                dindex = None

    pts = load_points(pack)
    pcell = max(annotate_m, 50.0) / 111320.0 * 1.5
    pgrid = defaultdict(list)
    for q in pts:
        pgrid[(int(q[0] / pcell), int(q[1] / pcell))].append(q)

    by = defaultdict(list)
    for f in feats:
        pr = f.get('properties') or {}
        gm = f.get('geometry') or {}
        if gm.get('type') != 'LineString':
            continue
        dm = pr.get('depth_dm')
        if dm is None:
            continue
        by[dm].append(gm['coordinates'])

    out, stats = [], {'runs': 0, 'kept': 0, 'closed': 0, 'routable': 0, 'unroutable': 0,
                      'v_raw': 0, 'v_out': 0, 'depths': len(by),
                      'steered': 0, 'v_chord': 0}
    for dm in sorted(by):
        for run in stitch(by[dm]):
            stats['runs'] += 1
            L = length_m(run)
            if L < min_len:
                continue
            closed = metres(run[0], run[-1]) < 2.0
            stats['v_raw'] += len(run)
            geom = rdp(run, simplify)
            if dindex is not None:
                # Straighten what the water allows. Done AFTER rdp so the chord search walks
                # tens of vertices rather than thousands, and the result is checked for length:
                # a chord that shortens a run below --min-len-m has cut away the fishing.
                st = steer(geom, dm, dindex, chord_m, chord_samples, chord_tol_dm)
                if st and len(st) >= 2 and length_m(st) >= min_len:
                    stats['steered'] += 1
                    stats['v_chord'] += len(geom) - len(st)
                    geom = st
            if closed and geom[0] != geom[-1]:
                geom.append(geom[0])
            stats['v_out'] += len(geom)
            stats['kept'] += 1

            props = {'depth_dm': dm,
                     'depth_m': round(dm * 0.1, 2),
                     'depth_ft': round(dm * 0.1 / 0.3048, 1),
                     'length_m': round(L, 1),
                     'closed': closed,
                     'vertices': len(geom)}
            if closed:
                props['area_m2'] = round(ring_area_m2(geom))
                stats['closed'] += 1
            if idx is not None:
                # Probe several points along the run, not just an end -- one end of a long run
                # can sit in a pocket while the body of it is on open water.
                step = max(1, len(geom) // 8)
                best = (None, float('inf'))
                for p in geom[::step]:
                    j, d = idx.nearest(p)
                    if j is not None and d < best[1]:
                        best = (j, d)
                j, d = best
                if j is not None and d <= reach_m:
                    props['reach_node'] = j
                    props['reach_m'] = round(d, 1)
                    props['routable'] = bool(mainset and j in mainset)
                else:
                    props['routable'] = False
                stats['routable' if props['routable'] else 'unroutable'] += 1

            # INVENTORY, NOT SCORE. Each nearby feature is recorded with how far ALONG the run
            # it sits, so any window of the run can be inventoried at query time without
            # redoing spatial work. There is deliberately no single number: whether 6 stands of
            # flooded timber beats 9 humps depends on the species, the season and where the
            # forage is, and that judgement lives in the app's trollingIntelligence, not here.
            if pts:
                s = 0.0
                seen, near = set(), []
                for vi, v in enumerate(geom):
                    if vi:
                        s += metres(geom[vi - 1], v)
                    gx, gy = int(v[0] / pcell), int(v[1] / pcell)
                    for dx in (-1, 0, 1):
                        for dy in (-1, 0, 1):
                            for q in pgrid.get((gx + dx, gy + dy), ()):
                                d = metres(v, (q[0], q[1]))
                                if d > annotate_m:
                                    continue
                                key = (round(q[0], 6), round(q[1], 6), q[2])
                                if key in seen:
                                    continue
                                seen.add(key)
                                e = {'s': round(s), 't': q[2], 'd': round(d)}
                                if q[3] is not None:
                                    e['ft'] = q[3]
                                near.append(e)
                if near:
                    near.sort(key=lambda e: e['s'])
                    # Ledges are SUMMARISED, not listed. There are 6,915 of them on Wateree
                    # against 55 stands of flooded timber, so every run collects 40-350 and the
                    # count discriminates nothing -- one run picked up 344 and tripled the file
                    # on its own. What is actually wanted from them is "how hard does the bottom
                    # break alongside this line", which is a statistic, not a list. Everything
                    # scarce enough to matter individually is still listed with its position.
                    led = [e for e in near if e['t'] == 'ledge']
                    if led:
                        props['ledge_n'] = len(led)
                        props['ledge_min_ft'] = min(e.get('ft', 0) for e in led)
                        props['ledge_max_ft'] = max(e.get('ft', 0) for e in led)
                    # near_counts counts exactly what `near` LISTS, so the two can never
                    # disagree. Ledges are not in either -- they are in ledge_n. A field that
                    # sometimes includes them and sometimes does not is worse than no field.
                    keep = [e for e in near if e['t'] != 'ledge']
                    props['near'] = keep
                    counts = {}
                    for e in keep:
                        counts[e['t']] = counts.get(e['t'], 0) + 1
                    props['near_counts'] = counts
                    stats['near_ledge'] = stats.get('near_ledge', 0) + len(led)
                    for t, n in counts.items():
                        stats['near_' + t] = stats.get('near_' + t, 0) + n
            out.append({'type': 'Feature', 'properties': props,
                        'geometry': {'type': 'LineString', 'coordinates':
                                     [[round(x, 6), round(y, 6)] for x, y in
                                      ((p[0], p[1]) for p in geom)]}})

    out.sort(key=lambda f: (-f['properties']['length_m'],))
    return out, stats


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--packs', required=True)
    ap.add_argument('--min-len-m', type=float, default=200.0,
                    help='shortest run worth keeping (default 200)')
    ap.add_argument('--simplify-m', type=float, default=5.0,
                    help='Douglas-Peucker tolerance; 0 disables (default 5)')
    ap.add_argument('--reach-m', type=float, default=120.0,
                    help='how close a graph node must be for a run to count as reachable')
    ap.add_argument('--annotate-m', type=float, default=100.0,
                    help='how far off the line a feature is still "on" the run (default 100)')
    ap.add_argument('--chord-m', type=float, default=400.0,
                    help='longest straight shortcut allowed across a bend, in metres (default '
                         '400; 0 disables and restores the raw contour). A chord is only taken '
                         'where the pack says the water under it is at least as deep as the '
                         'contour being shortcutted, so cove mouths are cut and points are not.')
    ap.add_argument('--chord-tol-dm', type=int, default=3,
                    help='how much shallower than the contour a chord may pass, in decimetres '
                         '(default 3, about a foot). Absorbs the step between depth bands.')
    ap.add_argument('--chord-samples', type=int, default=6,
                    help='points tested along each candidate chord (default 6)')
    ap.add_argument('--only', default=None, help='one slug, for testing')
    ap.add_argument('--report', default=None)
    a = ap.parse_args()

    slugs = [d for d in sorted(os.listdir(a.packs))
             if os.path.isdir(os.path.join(a.packs, d)) and (not a.only or d == a.only)]
    print('%d packs' % len(slugs))

    report, t0 = {}, time.time()
    tot = defaultdict(int)
    written = skipped = 0
    for k, slug in enumerate(slugs, 1):
        pack = os.path.join(a.packs, slug)
        try:
            r = build_one(pack, a.min_len_m, a.simplify_m, a.reach_m, a.annotate_m,
                          a.chord_m, a.chord_samples, a.chord_tol_dm)
        except Exception as e:
            report[slug] = {'error': '%s: %s' % (type(e).__name__, e)}
            skipped += 1
            continue
        if not r or not r[0]:
            skipped += 1
            continue
        feats, st = r
        with open(os.path.join(pack, 'trolling_runs.geojson'), 'w', encoding='utf-8') as fh:
            json.dump({'type': 'FeatureCollection',
                       'note': 'depth_dm is authoritative; contours are metric-derived so '
                               'round foot values mostly do not exist',
                       'features': feats}, fh)
        report[slug] = st
        for key, v in st.items():
            tot[key] += v
        written += 1
        if k % 100 == 0 or k == len(slugs):
            print('  %d/%d  %d written, %d skipped, %.1f min'
                  % (k, len(slugs), written, skipped, (time.time() - t0) / 60))

    print('\n%d packs written, %d skipped, %.1f min' % (written, skipped, (time.time() - t0) / 60))
    print('   %d runs kept of %d stitched  (%d closed rings)'
          % (tot['kept'], tot['runs'], tot['closed']))
    if tot['v_raw']:
        print('   vertices %d -> %d  (%.0f%% after %g m simplify)'
              % (tot['v_raw'], tot['v_out'], 100.0 * tot['v_out'] / tot['v_raw'], a.simplify_m))
    if a.chord_m > 0:
        # Say what was straightened and what was left alone. A run the water would not let us
        # chord is not a failure -- it is a shoreline with nothing to cut across -- but a run
        # count of zero across a whole region means depth_areas never loaded, and that should
        # look different from "the lake is straight".
        print('   steered %d of %d runs, %d vertices removed by chording (<=%g m chords)'
              % (tot.get('steered', 0), tot.get('kept', 0), tot.get('v_chord', 0), a.chord_m))
        if tot.get('kept') and not tot.get('steered'):
            print('   !! nothing was steered at all -- check that depth_areas.geojson exists in '
                  'the packs, because without it every run is the raw contour')
    if tot['routable'] or tot['unroutable']:
        print('   routable %d   NOT reachable from the main graph %d'
              % (tot['routable'], tot['unroutable']))
        if tot['unroutable'] > tot['routable'] * 0.05:
            # This used to say "run restitch_water_graphs.py first". That script is RETRACTED --
            # it re-derived by distance the very edges Garmin states in ADJ and the boundary clip
            # deleted, and at --max-m 75 it welded water above a dam to water below it on 178
            # lakes. See WATER_GRAPHS_WERE_SEVERED_BY_THE_CLIP_2026-08-07.md.
            print('   !! more than 5%% unreachable. That is the water GRAPH, not these runs.')
            print('      Lakes sit near 5.6%% and are fine. Rivers run ~38%% because a river')
            print('      boundary is a ribbon and the routing mesh does not know it exists --')
            print('      the fix is cutting those boundaries wider, NOT widening the halo.')
    rp = a.report or os.path.join(os.path.dirname(a.packs.rstrip('\\/')), 'registry',
                                  '_trolling_runs.json')
    try:
        os.makedirs(os.path.dirname(rp), exist_ok=True)
        # A --only run MERGES into the report instead of replacing it. Running the 19 stale
        # packs through a PowerShell loop on 2026-08-07 rewrote the card-wide report nineteen
        # times, each with a single pond, and left a file describing `whittakers_lake` where a
        # reader would find 1,560 packs. Same shape as the graphs report going stale: a partial
        # run must update the rows it touched and leave the rest alone, or the report quietly
        # becomes a claim about the card that is true of one lake.
        merged = report
        if a.only and os.path.exists(rp):
            try:
                with open(rp, encoding='utf-8') as fh:
                    prev = json.load(fh)
                if isinstance(prev.get('lakes'), dict):
                    merged = dict(prev['lakes'])
                    merged.update(report)
            except (OSError, ValueError):
                pass                      # unreadable previous report is not worth failing over
        with open(rp, 'w', encoding='utf-8') as fh:
            json.dump({'minLenM': a.min_len_m, 'simplifyM': a.simplify_m,
                       'reachM': a.reach_m, 'partial': bool(a.only) or None,
                       'lakes': merged}, fh, indent=1)
        print('-> %s%s' % (rp, '  (merged, %d packs)' % len(merged) if a.only else ''))
    except Exception as e:
        print('could not write report: %s' % e)


if __name__ == '__main__':
    main()
