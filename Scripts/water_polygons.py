"""Per-slug boundary geometry, loaded once and cached, with a metres() that is not a bbox test.

ONE COPY, BECAUSE TWO READERS OF ONE RULE DRIFT. `measure_ramp_water_margin.py` measured the filing
margin with this and `make_osm_ramps_by_lake.py` files ramps with it; a second copy of the loader is
how the same question starts getting two answers, which this project has paid for repeatedly.

WHY THE TRANSFORM IS CACHED PER SLUG AND NOT PER QUERY. The first version of the measurement script
ran `shapely.ops.transform` inside the query and re-projected a whole MultiPolygon for every ramp
against every nearby water; it never finished. Longitude only has to be compressed by cos(lat) near
the point being measured, and a boundary is small enough that its own centroid latitude is right
everywhere on it, so the scale factor is a property of the SLUG.

A DISTANCE OF ZERO MEANS INSIDE THE POLYGON, WHICH IS NOT AN ERROR. Measured 2026-09-22 over 1,212
ramps whose water is confirmed by the agency's own name: 438 of them -- 36.1% -- are inside the
water as we have drawn it. A containment test does not merely fail on bank-side ramps, it splits one
population into two arbitrary halves.

Personal use only, not for distribution or resale; not for navigation.
"""
import json, math, os

from shapely.geometry import shape, Point
from shapely.strtree import STRtree
from shapely.ops import transform as sh_transform, unary_union


class WaterPolygons:
    """registry/boundaries/<slug>.geojson, lazily. `metres(slug, lat, lon)` or None if no geometry."""

    def __init__(self, registry, skip=()):
        self.dir = os.path.join(registry, 'boundaries')
        self.skip = set(skip or ())
        self.cache = {}
        self.missing = set()

    def get(self, slug):
        if slug in self.cache:
            return self.cache[slug]
        out = None
        if slug not in self.skip:
            fp = os.path.join(self.dir, slug + '.geojson')
            if os.path.exists(fp):
                try:
                    gj = json.load(open(fp, encoding='utf-8'))
                    feats = gj.get('features') if gj.get('type') == 'FeatureCollection' else [gj]
                    geoms = [shape(f['geometry']) for f in (feats or [])
                             if (f or {}).get('geometry')]
                    if geoms:
                        g = geoms[0] if len(geoms) == 1 else unary_union(geoms)
                        k = math.cos(math.radians(g.centroid.y)) or 1e-9
                        out = (sh_transform(lambda x, y, z=None: (x * k, y), g), k)
                except Exception:
                    out = None
            if out is None:
                self.missing.add(slug)
        self.cache[slug] = out
        return out

    def metres(self, slug, lat, lon):
        got = self.get(slug)
        if got is None:
            return None
        g, k = got
        return g.distance(Point(lon * k, lat)) * 111320.0


class NearIndex:
    """Which slugs could possibly be within `margin_m` of a point, off bounds_wsen only.

    A prefilter and nothing more -- it exists so the polygon distance is computed a handful of times
    per ramp instead of 3,361 times. It is deliberately generous: longitude is widened by the
    cos(lat) factor at the equator-most edge so it can never exclude a water the real distance would
    have accepted.
    """

    GRID = 0.1

    def __init__(self, bounds_by_slug):
        self.grid = {}
        for slug, b in bounds_by_slug.items():
            if not b or len(b) != 4:
                continue
            w, s, e, n = (float(x) for x in b)
            for gx in range(int(math.floor(w / self.GRID)), int(math.floor(e / self.GRID)) + 1):
                for gy in range(int(math.floor(s / self.GRID)), int(math.floor(n / self.GRID)) + 1):
                    self.grid.setdefault((gx, gy), []).append((slug, w, s, e, n))

    def candidates(self, lat, lon, margin_m):
        dlat = margin_m / 111320.0
        dlon = margin_m / (111320.0 * max(0.1, math.cos(math.radians(lat))))
        pad = max(dlat, dlon)
        out = []
        gx0 = int(math.floor((lon - pad) / self.GRID))
        gx1 = int(math.floor((lon + pad) / self.GRID))
        gy0 = int(math.floor((lat - pad) / self.GRID))
        gy1 = int(math.floor((lat + pad) / self.GRID))
        seen = set()
        for gx in range(gx0, gx1 + 1):
            for gy in range(gy0, gy1 + 1):
                for slug, w, s, e, n in self.grid.get((gx, gy), ()):
                    if slug in seen:
                        continue
                    if s - dlat <= lat <= n + dlat and w - dlon <= lon <= e + dlon:
                        seen.add(slug)
                        out.append(slug)
        return out


def components(polys):
    """Union-find over polygons that TOUCH. Index-lists, largest total area first.

    `intersects` and not a distance: two adjacent depth BANDS share an edge and are one body of
    water, while two pools either side of a dike share nothing. Nesting is fine -- a deeper ring
    inside a shallower one is contained by it, which is the same water.

    THIS IS THE RESOLUTION-FREE ANSWER TO A QUESTION A RASTER CANNOT ANSWER. A flood at 25 m said
    Lake Monticello was 100.0%% connected and at 6 m said 36.9%%, because a dike with a road on it
    is about one cell wide. Polygon adjacency has no cell to be narrower than.
    """
    n = len(polys)
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    tree = STRtree(polys)
    for i, g in enumerate(polys):
        for j in tree.query(g):
            if j > i and polys[j].intersects(g):
                ra, rb = find(i), find(int(j))
                if ra != rb:
                    parent[rb] = ra
    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    return sorted(groups.values(), key=lambda ix: -sum(polys[k].area for k in ix))
