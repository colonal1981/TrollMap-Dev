#!/usr/bin/env python3
"""build_chartpack.py - turn per-tile extractor output into one lake's R2 chartpack.

Personal use only, not for distribution or resale; not for navigation.

PowerShell (Ryan is on Windows; backtick continues a line, not `^`, and quote anything with
a comma in it):

    py .\\build_chartpack.py --extract "F:\\TrollMapPipeline\\extract" `
       --key lake_wateree_fishing_creek `
       --boundary "F:\\TrollMapPipeline\\registry\\boundaries\\wateree_lake.geojson" `
       --ac "F:\\TrollMapPipeline\\pois\\ac_wateree.geojson" `
       --out "F:\\TrollMapPipeline\\chartpack"

`--boundary` clips to the registry's real 3DHP polygon (plus --buffer-m, default 250 m).
`--bbox W S E N` still works for a one-off, but it is WRONG at scale: lake bounding boxes
overlap even when the lakes do not touch, so a card-wide run would cross-contaminate packs.

`trollmap_extract_all.py` writes PER TILE (`<layer>/<TILE>.geojson`). R2 wants PER LAKE
(`<key>/<layer>.geojson`). This is the join, and it is the only place the two letters meet.

WHICH LETTER FEEDS WHICH LAYER -- settled in EXTRACT_PREFLIGHT.md, not re-derived here:

    contours       C     more line, lower crossing rate
    depth_areas    C     union 34.86 vs 33.91 km2 on the common footprint; B adds 0.01 km2,
                         so B's higher ring count is fragmentation, not coverage
    pois           B     C declares RGN4 with length 0 -- it physically cannot hold them
    waterbody      B     10,679 vs 1,692 on Wateree
    docks          B     same region as waterbody
    hydrography    C
    shoreline      B     C emits none at all

Taking a layer from both letters is not "more data", it is the same survey twice: on 4E0F1 the
two carry 3,706 km and 3,626 km of contour, matching depth for depth, with a median vertex-to-
line distance of 1.1 m in each direction. Doubling the file changes nothing on screen.
"""
import argparse, gzip, json, math, os, glob, re, sys, time
from collections import Counter, defaultdict


try:
    import orjson as _oj
except ImportError:                       # optional; the pipeline runs without it, just slower
    _oj = None


def _loads(data: bytes):
    """
    Parse a tile. THIS IS THE WHOLE RUNTIME OF A REBUILD.

    Measured 2026-08-08 on C4E0FB's contours, 44.4 MB gzipped, 189,185 features, 6.8 M vertices:

        gunzip                 0.88 s
        json.loads             5.36 s     <- 82% of it
        walk every vertex      0.24 s     <- 4%

    A full recut reads roughly ten layers across 169 tiles, so the standard-library JSON parser
    was most of a two-hour run. I had been about to vectorise the per-vertex clip loop, which is
    the 4%.

    orjson parses the same bytes 3-5x faster and returns identical Python objects, so nothing
    downstream changes. It is optional on purpose -- absent, this falls back and the only cost is
    the wall clock:

        pip install orjson

    Bytes, not text: orjson takes bytes directly, and handing the stdlib parser bytes skips a
    decode pass too, so the fallback path also gets slightly quicker.
    """
    return _oj.loads(data) if _oj is not None else json.loads(data)


def read_fc(path):
    """Read a per-tile collection, gzipped or not.

    `trollmap_extract_all.py --gzip` writes `<TILE>.geojson.gz`, and EXTRACT_PREFLIGHT.md's
    recommended commands all pass --gzip. Globbing only `*.geojson` would therefore find NOTHING
    on a by-the-book run and produce an empty chartpack without raising -- the same silent-zero
    failure as the area layer-name drift. Accept both suffixes.
    """
    if path.endswith('.gz'):
        with gzip.open(path, 'rb') as f:
            return _loads(f.read())
    with open(path, 'rb') as f:
        return _loads(f.read())


def _rings(geom):
    t = geom.get('type'); c = geom.get('coordinates')
    if t == 'Polygon':      return [c[0]]
    if t == 'MultiPolygon': return [q[0] for q in c]
    return []


def _is_rectangle(rings, tol=1e-9):
    """True when the boundary is a single axis-aligned box.

    make_coastal_boundaries.py emits exactly that for the 21 coastal zones, because a zone is
    a REGION rather than a waterbody outline. Recognising it matters for one reason: a
    rectangle fills its own bounding box, so LakeMask would rasterise every cell in it.
    Pamlico Sound is 7,908 km2 -- 19.5 million cells at 0.0002 deg, about 1.2 GB of Python
    set before the buffer dilation, on a machine that handles Wateree's 1.9 M comfortably.
    """
    if len(rings) != 1:
        return False
    r = rings[0]
    pts = r[:-1] if len(r) > 1 and r[0] == r[-1] else r
    if len(pts) != 4:
        return False
    xs = sorted({round(p[0], 9) for p in pts})
    ys = sorted({round(p[1], 9) for p in pts})
    if len(xs) != 2 or len(ys) != 2:
        return False
    corners = {(round(p[0], 9), round(p[1], 9)) for p in pts}
    return corners == {(x, y) for x in xs for y in ys}


class _BoxCells:
    """Cell-index membership for a rectangle, without materialising the cells."""

    __slots__ = ('i0', 'i1', 'j0', 'j1')

    def __init__(self, i0, i1, j0, j1):
        self.i0, self.i1, self.j0, self.j1 = i0, i1, j0, j1

    def __contains__(self, c):
        i, j = c
        return self.i0 <= i <= self.i1 and self.j0 <= j <= self.j1

    def __len__(self):
        return (self.i1 - self.i0 + 1) * (self.j1 - self.j0 + 1)

    def __bool__(self):
        return True


class BboxMask:
    """LakeMask's interface for a rectangular region, with no raster behind it.

    Containment for a box is a comparison, so this is O(1) per point and costs no memory,
    where the rasterised version costs a gigabyte. The buffer is applied by growing the box.

    `charted_fraction` returns None ON PURPOSE. For a lake it means "share of the surface
    that is surveyed"; for a zone rectangle the denominator would count dry land, marsh and
    barrier island, so any number it produced would be a ratio of water to land dressed up as
    a coverage figure. Returning None says "not measured here" instead of lying, and under
    the 2026-08-03 ship rule any contours ship regardless.
    """

    def __init__(self, rings, buffer_deg):
        r = rings[0]
        w0, e0 = min(p[0] for p in r), max(p[0] for p in r)
        s0, n0 = min(p[1] for p in r), max(p[1] for p in r)
        self.w, self.e = w0 - buffer_deg, e0 + buffer_deg
        self.s, self.n = s0 - buffer_deg, n0 + buffer_deg
        self.cell = LakeMask.CELL
        self.cells = None
        self.is_zone = True
        # `core` must answer `cell in core`, because _flush counts features INSIDE the
        # boundary (excluding the buffer) that way. A plain None raises TypeError there --
        # a crash that only fires on a zone, i.e. only in the case this class exists for.
        self.core = _BoxCells(int((w0 - self.w) / self.cell), int((e0 - self.w) / self.cell),
                              int((s0 - self.s) / self.cell), int((n0 - self.s) / self.cell))

    def cell_of(self, x, y):
        return (int((x - self.w) / self.cell), int((y - self.s) / self.cell))

    def charted_fraction(self, features, contours=None):
        """
        None on purpose, per the class docstring — but the SIGNATURE must match LakeMask's or the
        zone never ships.

        2026-08-08. The charted fix gave LakeMask.charted_fraction a second argument so a 0-1 ft
        shoreline outline could not pass as coverage, and _flush was updated to pass it. This
        override was not, and it is the mask used for exactly one thing: coastal zone rectangles.
        Every coastal zone then died in _flush with `TypeError: takes 2 positional arguments but 3
        were given`, unhandled, before a file was written -- and unhandled means a full recut never
        reaches the line that writes charted.json.

        coast_st_helena_sc held nothing but a 2 KB water_graph.bin while tile B4E0FB had 83,106
        contours inside its own box. After the fix it builds to 186 MB and 50,614 contours; ACE
        Basin went from 1,126 contours to 71,139.

        Ryan found it by asking why ACE Basin drew nothing in the app. 981 tests did not, because
        none of them builds a pack and looks at it. Scripts/tests/test_charted.py now compares the
        two masks' signatures directly.
        """
        return None

    def __contains__(self, pt):
        x, y = pt
        return self.w <= x <= self.e and self.s <= y <= self.n


def build_mask(rings, buffer_deg, exclude=()):
    """Pick the cheap mask when the boundary is a box, the real one otherwise.

    A BboxMask is four numbers and a comparison. It cannot hold a hole, so an exclusion forces
    the rasterised mask however rectangular the boundary is -- see LakeMask's `exclude`.
    """
    if exclude:
        return LakeMask(rings, buffer_deg, exclude=exclude)
    return (BboxMask if _is_rectangle(rings) else LakeMask)(rings, buffer_deg)


class LakeMask:
    """A rasterised inside-or-within-buffer test. One dict lookup per point.

    WHY NOT POINT-IN-POLYGON PER VERTEX
    The obvious version -- crossing-number per point, plus a distance-to-nearest-segment
    fallback for the buffer -- is O(points x ring vertices) and it does not survive contact
    with a real lake. Measured on Wateree: the 3DHP ring is 17,282 vertices and one tile's
    contours are 436,584 vertices, so the naive clip is **7.5 billion segment tests for one
    lake**. It ran for ten minutes without finishing a single layer. At 143 tiles that is not
    slow, it is never.

    So rasterise the polygon ONCE per lake and then ask the grid.

      1. scanline fill: for each grid row, find where the ring crosses that row's centre,
         sort the crossings, fill the spans between pairs. Standard polygon rasterisation,
         O(rows x ring) -- about 12M operations on Wateree, under a second.
      2. dilate by the buffer radius in cells, so shoreline structure just outside the
         waterline still lands in the pack. This replaces the distance-to-segment test and
         inherits its intent: it is a distance from the EDGE, not from the nearest vertex.
         (The guide's rule 4 exists because nearest-vertex reported 704 m for geometry within
         9 m -- rasterising sidesteps that entirely, since the fill follows the segments.)

    CELL SIZE is a real trade. 0.0002 deg is ~22 m, so the mask is accurate to about half a
    cell -- 11 m -- against a 250 m buffer. That is noise. Going finer costs memory
    quadratically for accuracy nobody can see on a chart.
    """
    CELL = 0.0002

    def __init__(self, rings, buffer_deg, exclude=()):
        self.cell = self.CELL
        xs = [p[0] for r in rings for p in r]
        ys = [p[1] for r in rings for p in r]
        pad = buffer_deg + self.cell * 2
        self.w, self.e = min(xs) - pad, max(xs) + pad
        self.s, self.n = min(ys) - pad, max(ys) + pad
        self.nx = int((self.e - self.w) / self.cell) + 2
        self.ny = int((self.n - self.s) / self.cell) + 2

        inside = set()
        # 1. scanline fill, at each row's centre so a vertex exactly on a row cannot produce
        #    a double crossing.
        for j in range(self.ny):
            y = self.s + (j + 0.5) * self.cell
            xsat = []
            for r in rings:
                for i in range(len(r) - 1):
                    y1, y2 = r[i][1], r[i + 1][1]
                    if (y1 > y) == (y2 > y):
                        continue
                    x1, x2 = r[i][0], r[i + 1][0]
                    xsat.append(x1 + (y - y1) * (x2 - x1) / (y2 - y1))
            if not xsat:
                continue
            xsat.sort()
            for k in range(0, len(xsat) - 1, 2):
                a = int((xsat[k] - self.w) / self.cell)
                b = int((xsat[k + 1] - self.w) / self.cell)
                for i in range(max(0, a), min(self.nx - 1, b) + 1):
                    inside.add((i, j))

        # 2. also mark the cells the ring itself passes through, so a lake narrower than one
        #    cell (a creek arm, the tail of an oxbow) is not lost by the fill alone.
        for r in rings:
            for px, py in r:
                inside.add((int((px - self.w) / self.cell), int((py - self.s) / self.cell)))

        # 3. dilate by the buffer -- but only from the EDGE cells.
        #    Dilating every inside cell is what made this slow: Wateree has 233,406 inside
        #    cells and a 250 m buffer is a 449-cell stencil, so the naive version is 105M
        #    set operations and took 10.4 s for one lake. An interior cell is already inside;
        #    growing from it can only re-add cells its neighbours already cover. Only cells
        #    with a non-inside neighbour can reach new ground, and on a lake that is a few
        #    percent of the total.
        rad = int(math.ceil(buffer_deg / self.cell))
        if rad > 0:
            edge = [(i, j) for (i, j) in inside
                    if (i + 1, j) not in inside or (i - 1, j) not in inside
                    or (i, j + 1) not in inside or (i, j - 1) not in inside]
            offs = [(dx, dy) for dx in range(-rad, rad + 1) for dy in range(-rad, rad + 1)
                    if dx * dx + dy * dy <= rad * rad]
            grown = set(inside)
            for (i, j) in edge:
                for dx, dy in offs:
                    grown.add((i + dx, j + dy))
            # `core` is the lake itself, before the buffer. It is the denominator for the
            # charted fraction -- surveyed coverage has to be measured against the WATER, not
            # against the water plus 250 m of bank, or every lake would look under-charted by
            # a margin that scales with how crinkly its shoreline is.
            self.core = inside
            inside = grown
        else:
            self.core = set(inside)
        self.cells = inside

        # A COASTAL ZONE MUST NOT CONTAIN FRESHWATER. Ryan, 2026-08-18: "coastal water
        # shouldn't have any freshwater in it at all period".
        #
        # A zone boundary is a coarse envelope over land, marsh and water together --
        # coast_charleston_sc is 973 vertices and no holes over 526,313 acres, against 26,405
        # vertices and 80 holes for the 4,655-acre Cooper. So it swallows whole waters that
        # have a pack of their own: measured that day, the Charleston pack shipped 469 contours
        # and 459 depth areas inside Goose Creek Reservoir, 573 acres with its own chartpack.
        # The same water, twice, in two packs, with two sets of soundings.
        #
        # AFTER the dilate, deliberately. Excluding first and then growing the buffer would put
        # 250 m of the zone straight back into the water it just gave up. And `core` is cleared
        # too, because `core` is the denominator of the charted fraction: leaving the reservoir
        # in it would go on measuring the zone's coverage against water the zone no longer has.
        if exclude:
            gone = set()
            for ex in exclude:
                gone |= self._raster(ex)
            self.cells = self.cells - gone
            self.core = self.core - gone
            self.excluded_cells = len(gone)
            self.excluded = gone
            self.exclude_rings = [list(r) for r in exclude]
        else:
            self.excluded_cells = 0
            self.excluded = frozenset()
            self.exclude_rings = []

    def _raster(self, rings):
        """The cells this ring set covers, in THIS mask's grid.

        The same scanline the constructor runs, called rather than copied. A second
        rasteriser that drifts from the first would subtract a slightly different shape than
        the one it filled, and the seam would be invisible until it showed up on a chart.
        """
        got = set()
        for j in range(self.ny):
            y = self.s + (j + 0.5) * self.cell
            xsat = []
            for r in rings:
                for i in range(len(r) - 1):
                    y1, y2 = r[i][1], r[i + 1][1]
                    if (y1 > y) == (y2 > y):
                        continue
                    x1, x2 = r[i][0], r[i + 1][0]
                    xsat.append(x1 + (y - y1) * (x2 - x1) / (y2 - y1))
            if not xsat:
                continue
            xsat.sort()
            for k in range(0, len(xsat) - 1, 2):
                a = int((xsat[k] - self.w) / self.cell)
                b = int((xsat[k + 1] - self.w) / self.cell)
                for i in range(max(0, a), min(self.nx - 1, b) + 1):
                    got.add((i, j))
        # The boundary cells too, in the same spirit as the fill's step 2 -- and here it errs
        # toward removing a cell rather than keeping one, which is the safe direction when the
        # rule is "none at all".
        for r in rings:
            for px, py in r:
                got.add((int((px - self.w) / self.cell), int((py - self.s) / self.cell)))
        return got

    def cell_of(self, x, y):
        return (int((x - self.w) / self.cell), int((y - self.s) / self.cell))

    # A depth area whose band is 0-1 ft is not evidence of a survey. It is the waterbody edge
    # Garmin draws around every piece of water, sounded or not. `SHOAL_DM` is the top of that
    # band: depth_max_dm 3 is 0.3 m.
    SHOAL_DM = 3

    @staticmethod
    def _has_soundings(features, contours=None):
        """
        Did anyone actually sound this water?

        2026-08-08, measured on the shipped packs. Willow Lake reads 0.9327 charted, Everetts
        0.9083, Bear Garden Swamp 0.8549, Lommond 0.9406, Yohola 0.8263, Kolomoki 0.8933 -- and
        every one of them has ZERO contours and exactly one depth band, `(0, 3)`, one to three
        polygons of it. That band is the shoreline outline, not a survey, and filling it reported
        most of the lake as charted.

        Wateree, genuinely surveyed, carries bands from `(0, 3)` to `(70, 73)` across 7,512
        contours. So the discriminator is not "how much (0,3) is there" but "is there anything
        BELOW it", and that is a gate rather than a filter: once a lake passes, every one of its
        bands counts toward coverage exactly as before, including the shallow margin, which on a
        surveyed lake really was sounded. Wateree's number does not move.

        This is Ryan's ship rule, measured properly: "if it has bathymetry ship it."
        """
        for f in (contours or []):
            g = f.get('geometry') or {}
            if (g.get('coordinates') or []) and g.get('type') in ('LineString', 'MultiLineString'):
                return True
        for f in features or []:
            hi = (f.get('properties') or {}).get('depth_max_dm')
            if hi is not None and hi > LakeMask.SHOAL_DM:
                return True
        return False

    def charted_fraction(self, features, contours=None):
        """What share of the lake's own surface is actually surveyed.

        MEASURE THE DEPTH BANDS, NOT THE CONTOURS. The first version counted cells containing
        a contour VERTEX and it was wrong in a way that looked plausible: Wateree came back
        0.66 when the whole lake is surveyed, and across all 434 shipped lakes the maximum was
        0.95 with only two reaching it. A metric where nothing scores full marks is not
        measuring what it claims.

        Contours are LINES. A flat basin between two depth intervals contains no contour at
        all, so those cells read as unsurveyed however good the survey is -- the number was
        really reporting contour density, which is a function of bottom slope.

        Depth-area polygons TILE the surveyed surface, so filling them measures coverage.
        Most are tiny -- the median band is 59 m2, well under one 484 m2 cell -- so marking
        the cells their vertices fall in is exact for the majority, and only bands spanning
        more than a couple of cells need the scanline fill.

        A FRACTION, not a flag, and that part still stands: Garmin's coverage is genuinely
        partial within a lake. Wee Tee has three connected basins with the middle one
        unsurveyed, and both it and Bates Old River stop short of the shallow ends.
        """
        if not self.core:
            return None
        # Nothing below the 0-1 ft edge band means nothing was ever sounded here. Zero, not a
        # fraction of the outline -- see _has_soundings.
        if not self._has_soundings(features, contours):
            return 0.0
        hit = set()
        for f in features:
            g = f.get('geometry') or {}
            t = g.get('type')
            rings = ([g['coordinates'][0]] if t == 'Polygon'
                     else [p[0] for p in g['coordinates']] if t == 'MultiPolygon'
                     else [g.get('coordinates') or []])
            for r in rings:
                if len(r) < 2:
                    continue
                xs = [p[0] for p in r]; ys = [p[1] for p in r]
                for p in r:
                    c = self.cell_of(p[0], p[1])
                    if c in self.core:
                        hit.add(c)
                # Only fill when the ring is bigger than a couple of cells; below that the
                # vertex marks already cover it and the fill is pure cost.
                if t not in ('Polygon', 'MultiPolygon'):
                    continue
                if (max(xs) - min(xs)) < 2 * self.cell and (max(ys) - min(ys)) < 2 * self.cell:
                    continue
                j0 = int((min(ys) - self.s) / self.cell)
                j1 = int((max(ys) - self.s) / self.cell)
                for j in range(max(0, j0), min(self.ny - 1, j1) + 1):
                    yy = self.s + (j + 0.5) * self.cell
                    xat = []
                    for i in range(len(r) - 1):
                        y1, y2 = r[i][1], r[i + 1][1]
                        if (y1 > yy) == (y2 > yy):
                            continue
                        x1, x2 = r[i][0], r[i + 1][0]
                        xat.append(x1 + (yy - y1) * (x2 - x1) / (y2 - y1))
                    xat.sort()
                    for k in range(0, len(xat) - 1, 2):
                        a = int((xat[k] - self.w) / self.cell)
                        b = int((xat[k + 1] - self.w) / self.cell)
                        for i in range(max(0, a), min(self.nx - 1, b) + 1):
                            if (i, j) in self.core:
                                hit.add((i, j))
        return round(len(hit) / len(self.core), 4)

    def __contains__(self, pt):
        x, y = pt
        if not (self.w <= x <= self.e and self.s <= y <= self.n):
            return False
        return (int((x - self.w) / self.cell), int((y - self.s) / self.cell)) in self.cells


def tile_files(extract, layer, letter):
    """Every per-tile file for one layer and tile letter, either suffix, deduped by tile id."""
    seen = {}
    for suf in ('.geojson', '.geojson.gz'):
        for fp in glob.glob(os.path.join(extract, layer, '%s*%s' % (letter, suf))):
            tid = os.path.basename(fp).split('.')[0]
            # Prefer the plain file when a stale uncompressed copy sits beside a gzipped one.
            seen.setdefault(tid, fp)
    return [seen[t] for t in sorted(seen)]

NOTE = "Personal use only, not for distribution or resale; not for navigation."

# layer -> (tile letter, R2 object name). A layer absent here is not shipped.
SHIP = {
    'contours':    ('C', 'contours.geojson'),
    'depth_areas': ('C', 'depth_areas.geojson'),
    'hydrography': ('C', 'hydrography.geojson'),
    'pois':        ('B', 'pois.geojson'),
    'waterbody':   ('B', 'waterbody.geojson'),
    'docks':       ('B', 'docks.geojson'),
    'shoreline':   ('B', 'garmin_shoreline.geojson'),
}
# 5 dp is 1.1 m. The decode is good to a few metres at best, so the 6th and 7th digits the
# extractor writes are pure file size -- about 15% of it -- and cannot be measured.
DP = 5
# Fields that exist so an unsolved class can be decoded LATER without re-reading the card.
# They belong in the archive, never in the file a phone downloads: `raw` alone was 129K
# characters per 2,000 features.
# `source` is NOT dropped: after the ActiveCaptain merge it is the only field that says where a
# point came from, and stripping it made all 725 read as sourceless.
DROP = ('raw', 'sb_header', 'attr', 'bytes_unparsed', 'subdivision', 'n_selectors', 'sb_tail',
        'area_m2', 'class_byte', 'type_byte')


def redp(g, dp=DP):
    def r(c):
        if not c: return c
        if isinstance(c[0], (int, float)): return [round(c[0], dp), round(c[1], dp)]
        return [r(x) for x in c]
    return {'type': g['type'], 'coordinates': r(g['coordinates'])}


def _allpts(coords):
    """Every (x, y) at any nesting depth.

    verts() is deliberately shallow -- it returns a Polygon's OUTER ring and a MultiPolygon's
    list of polygons -- which is right for its callers and wrong here, where a MultiPolygon
    would arrive as a list of rings and be read as a coordinate pair.
    """
    if isinstance(coords, (list, tuple)) and coords and isinstance(coords[0], (int, float)):
        yield coords
        return
    if isinstance(coords, (list, tuple)):
        for c in coords:
            for p in _allpts(c):
                yield p


def _bbox(pts):
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    return (min(xs), min(ys), max(xs), max(ys)) if xs else None


def clip_excluded(feats, mask):
    """Cut the excluded water OUT of each feature, instead of keeping or dropping it whole.

    SELECTION CANNOT SATISFY "NONE AT ALL". The core filter keeps a feature if ANY vertex lands
    in the lake, which is right for a lake and wrong for a zone that has given a water up.
    Measured on coast_charleston_sc after the first exclusion run: 83 contours still carried
    Goose Creek Reservoir, and EVERY ONE of them was kept by a handful of vertices at the far
    end -- 238 of 239 inside, one outside; 565 of 574 inside, nine outside. Not one survivor had
    zero vertices outside. The mask was doing what it was told; the rule was the problem.

    A CANDIDATE IS DECIDED BY BOUNDING BOX, NOT BY VERTICES. The first version of this asked
    whether any vertex fell in an excluded cell, and a depth-area polygon large enough to
    ENCLOSE the reservoir has no vertex anywhere near it -- it spans the water between two
    corners and would have sailed through untouched. A box overlap costs four comparisons and
    cannot miss that.

    Geometry is cut with a real difference. The raster is a 22 m approximation and good enough
    to decide WHO gets cut; it is not good enough to decide WHERE, because a polygon cannot be
    cut by deleting vertices at all -- walking the boundary past them draws a straight line
    across the lobe that was supposed to go and quietly claims the water back.

    WITHOUT SHAPELY there is still an honest answer, and it is not the same answer for both:
    a line is split at its excluded vertices, which is exact wherever the vertices are dense
    and silently keeps a long segment that spans the water; a polygon is DROPPED whole. Under a
    rule that says none at all, erring toward removing water is the right direction, and the
    run says how many went that way so it is never mistaken for a clean cut.
    """
    if not feats or not getattr(mask, 'excluded', None):
        return feats, {}
    ex_rings = [r for rl in getattr(mask, 'exclude_rings', []) for r in rl]
    ex_box = _bbox([p for r in ex_rings for p in r]) if ex_rings else None
    try:
        from shapely.geometry import shape as _shape, mapping as _mapping
        from shapely.ops import unary_union as _uu
        cutter = _uu([_shape({'type': 'Polygon', 'coordinates': [list(r)]}).buffer(0)
                      for r in ex_rings]) if ex_rings else None
    except Exception:
        _shape = _mapping = cutter = None

    out, stat = [], {'untouched': 0, 'trimmed': 0, 'emptied': 0, 'dropped_no_shapely': 0}
    for f in feats:
        g = f.get('geometry') or {}
        pts = list(_allpts(g.get('coordinates')))
        fb = _bbox(pts)
        near = bool(ex_box and fb and not (fb[2] < ex_box[0] or ex_box[2] < fb[0]
                                           or fb[3] < ex_box[1] or ex_box[3] < fb[1]))
        if not near and not any(mask.cell_of(x, y) in mask.excluded for x, y in pts):
            stat['untouched'] += 1
            out.append(f)
            continue
        if cutter is not None:
            try:
                left = _shape(g).buffer(0).difference(cutter)
            except Exception:
                left = None
            if left is None:
                stat['emptied'] += 1
                continue
            if left.is_empty:
                stat['emptied'] += 1
                continue
            if left.equals(_shape(g).buffer(0)):
                stat['untouched'] += 1
                out.append(f)
                continue
            stat['trimmed'] += 1
            out.append(dict(f, geometry=_mapping(left)))
            continue
        # ---- no shapely ----
        t = g.get('type') or ''
        if t not in ('LineString', 'MultiLineString'):
            stat['dropped_no_shapely'] += 1
            continue
        parts = [g.get('coordinates')] if t == 'LineString' else list(g.get('coordinates') or [])
        runs = []
        for part in parts:
            run = []
            for x, y in part:
                if mask.cell_of(x, y) in mask.excluded:
                    if len(run) >= 2:
                        runs.append(run)
                    run = []
                else:
                    run.append([x, y])
            if len(run) >= 2:
                runs.append(run)
        if not runs:
            stat['emptied'] += 1
            continue
        if len(runs) == 1 and len(runs[0]) == sum(len(p) for p in parts):
            stat['untouched'] += 1
            out.append(f)
            continue
        stat['trimmed'] += 1
        out.append(dict(f, geometry=({'type': 'LineString', 'coordinates': runs[0]}
                                     if len(runs) == 1
                                     else {'type': 'MultiLineString', 'coordinates': runs})))
    return out, stat


def verts(g):
    c = g['coordinates']
    if g['type'] == 'Point': return [c]
    if g['type'] == 'Polygon': return c[0]
    return c


def runs_inside(pts, hit):
    """Maximal runs of inside vertices, each padded by one vertex either side.

    Returns None when every vertex is inside, so the caller can keep the feature untouched.

    The one-vertex padding is the whole point of trimming rather than filtering: without it a
    contour that crosses the shoreline would stop one vertex short of the waterline, and the
    250 m buffer would have been spent for nothing.
    """
    flags = [hit(x, y) for x, y in pts]
    if all(flags):
        return None
    out, i, n = [], 0, len(pts)
    while i < n:
        if not flags[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and flags[j + 1]:
            j += 1
        a = max(0, i - 1)
        b = min(n - 1, j + 1)
        if b - a + 1 >= 2:
            out.append(pts[a:b + 1])
        i = j + 1
    return out


def trim_geometry(geom, hit):
    """(geometry_or_None, 'keep' | 'trim' | 'drop').

    REPLACES `any(inbox(v) for v in verts(f))`, which kept a feature WHOLE if a single vertex
    landed inside. The comment on that line was right about the goal -- a contour crossing the
    shoreline should not become two open ends -- and wrong about the cost: a contour that
    merely GRAZED the mask came in at full length, so a line touching Lake Murray's edge and
    running 18 km east shipped inside Murray's pack and drew across the chart.

    `--max-segment-m` cannot catch those. It looks for one long jump between consecutive
    vertices; these strays are densely sampled and their longest segment is under a kilometre.
    Murray's worst was 1.02 km against a 2 km guard while its contours reached 18 km past the
    boundary. Measured over the shipped packs, 60 of the first 223 held at least one, in
    single digits against tens of thousands of good features -- rare, and violently visible.

    Polygons are dropped rather than trimmed when under half their vertices are inside: you
    cannot trim a polygon by discarding vertices without inventing an edge nobody surveyed.
    """
    t = geom.get('type')
    c = geom.get('coordinates')

    if t == 'Point':
        return (geom, 'keep') if hit(c[0], c[1]) else (None, 'drop')

    if t == 'MultiPoint':
        keep = [q for q in (c or []) if hit(q[0], q[1])]
        if not keep:
            return None, 'drop'
        return ({'type': 'MultiPoint', 'coordinates': keep},
                'keep' if len(keep) == len(c) else 'trim')

    if t in ('Polygon', 'MultiPolygon'):
        rings = ([c[0]] if t == 'Polygon' and c else [poly[0] for poly in (c or []) if poly])
        pts = [q for r in rings for q in r]
        if not pts:
            return None, 'drop'
        ins = sum(1 for x, y in pts if hit(x, y))
        return (geom, 'keep') if ins >= len(pts) * 0.5 else (None, 'drop')

    if t == 'LineString':
        kept = runs_inside(c, hit)
        if kept is None:
            return geom, 'keep'
        if not kept:
            return None, 'drop'
        if len(kept) == 1:
            return {'type': 'LineString', 'coordinates': kept[0]}, 'trim'
        return {'type': 'MultiLineString', 'coordinates': kept}, 'trim'

    if t == 'MultiLineString':
        out, changed = [], False
        for line in (c or []):
            kept = runs_inside(line, hit)
            if kept is None:
                out.append(line)
            else:
                changed = True
                out.extend(kept)
        if not out:
            return None, 'drop'
        return ({'type': 'MultiLineString', 'coordinates': out}, 'trim' if changed else 'keep')

    # Unknown type: keep it if anything is inside, never silently discard something new.
    pts = []
    _flatten_coords(c, pts)
    return (geom, 'keep') if any(hit(x, y) for x, y in pts) else (None, 'drop')


def _flatten_coords(c, acc):
    if not c:
        return
    if isinstance(c[0], (int, float)):
        acc.append(c)
        return
    for x in c:
        _flatten_coords(x, acc)


def haversine(a, b):
    (x1, y1), (x2, y2) = a, b
    return math.hypot((x2 - x1) * math.cos(math.radians(y1)) * 111320.0, (y2 - y1) * 110540.0)


def norm(s):
    return ''.join(ch for ch in (s or '').lower() if ch.isalnum())


# Words that carry no identity. A name made ONLY of these is a placeholder, not a name.
_GENERIC_TOKENS = {'boat', 'ramp', 'ramps', 'launch', 'site', 'access', 'public', 'landing',
                   'lake', 'the', 'at', 'of', 'point', 'area', 'dock', 'pier'}


def name_quality(name, lake_words=()):
    """How much identity does this name carry? Higher is better.

    ActiveCaptain and Garmin both put a record on the same concrete, and they do not agree on
    what to call it: Clearwater Cove has `Clearwater Cove Marina` from Garmin's business card
    and `Wateree Boat Ramp ( Launch Site)` from ActiveCaptain, 108 m apart. Both are correct;
    only one is useful written on a shoreline.
    """
    if not name: return (0, 0, 0)
    words = [w for w in re.split(r'[^A-Za-z0-9]+', name.lower()) if w]
    specific = [w for w in words if w not in _GENERIC_TOKENS and w not in lake_words]
    # penalise the parenthetical qualifier AC appends -- "( Launch Site)" is never the name
    tidy = 0 if '(' in name else 1
    return (1 if specific else 0, len(specific), tidy)


RAMP_FAMILY = {'boat_ramp', 'water_access', 'marina', 'trailer_ramp', 'generic_ramp', 'fuel_dock'}
COLLAPSE_M = 150.0


def collapse_ramps(feats, lake_key=''):
    """One ramp, one record — and the record keeps the most specific name available.

    The name-equality merge cannot do this: it only fires when two sources agree on the string,
    and at a ramp they systematically do not. So collapse the ramp family by POSITION, then pick
    the name by how much identity it carries rather than by which source it came from.

    Fuel docks are deliberately in the family but are never absorbed INTO a ramp — Dutchman Creek
    Marina and its fuel dock are 70 m apart and are two different things to a boat.
    """
    lake_words = set(w for w in re.split(r'[^a-z]+', lake_key.lower()) if w)
    ramps = [f for f in feats if (f['properties'].get('poi_type') in RAMP_FAMILY)]
    other = [f for f in feats if f not in ramps]
    used = [False] * len(ramps)
    out = []
    merged = 0
    for i, a in enumerate(ramps):
        if used[i]: continue
        group = [a]; used[i] = True
        for j in range(i + 1, len(ramps)):
            if used[j]: continue
            b = ramps[j]
            # never fold a fuel dock into a ramp, or vice versa
            if (a['properties'].get('poi_type') == 'fuel_dock') != \
               (b['properties'].get('poi_type') == 'fuel_dock'): continue
            if haversine(a['geometry']['coordinates'], b['geometry']['coordinates']) <= COLLAPSE_M:
                group.append(b); used[j] = True
        if len(group) > 1: merged += len(group) - 1
        # Best name wins; everything else is folded in as an alias so nothing is lost.
        group.sort(key=lambda f: name_quality(f['properties'].get('name')
                                              or f['properties'].get('card'), lake_words),
                   reverse=True)
        keep = group[0]
        props = dict(keep['properties'])
        aliases, srcs = [], set()
        for g in group:
            n = g['properties'].get('name') or g['properties'].get('card')
            if n and n != props.get('name'): aliases.append(n)
            if g['properties'].get('source'): srcs.add(g['properties']['source'])
            for k, v in g['properties'].items():
                if k not in props or props[k] in (None, ''): props[k] = v
        if aliases: props['also_known_as'] = sorted(set(aliases))
        if srcs: props['source'] = '+'.join(sorted(srcs))
        # a ramp beats a bare water_access when they collapse together
        if any(g['properties'].get('poi_type') == 'boat_ramp' for g in group):
            props['poi_type'] = 'boat_ramp'
        out.append({'type': 'Feature', 'properties': props, 'geometry': keep['geometry']})
    return other + out, merged


def merge_pois(garmin, ac, radius_m=50.0):
    """Ryan's rule: same name AND within ~50 m is the same feature; keep the existing record and
    add Garmin's extra fields. Everything unmatched is added.

    The existing record wins on position because ActiveCaptain is a SURVEYED database with its
    own coordinates, while ours is a decode -- and the two agree to 14-40 m on named marinas,
    which is the same order as this radius. Where they disagree by more than that they are not
    the same feature and should both stand.

    Name equality is required, not proximity alone. Garmin puts a dock, a ramp and a fuel dock
    inside 50 m of each other at every marina on the lake; merging on distance would eat them.
    """
    idx = defaultdict(list)
    for i, f in enumerate(ac):
        n = norm(f['properties'].get('name'))
        if n: idx[n].append(i)
    used = set(); added = 0; merged = 0
    for g in garmin:
        n = norm(g['properties'].get('name') or g['properties'].get('card'))
        gc = g['geometry']['coordinates']
        hit = None
        for i in idx.get(n, ()):
            if haversine(gc, ac[i]['geometry']['coordinates']) <= radius_m:
                hit = i; break
        if hit is None:
            g['properties']['source'] = 'garmin'
            ac.append(g); added += 1
            continue
        used.add(hit); merged += 1
        p = ac[hit]['properties']
        for k, v in g['properties'].items():
            if k in ('name', 'poi_type') or k in p: continue
            p[k] = v
        p['source'] = 'activecaptain+garmin'
        # A Garmin business card that lists a Ramp is Garmin's own word for it and beats an
        # ActiveCaptain category guess.
        if g['properties'].get('poi_type') == 'boat_ramp':
            p['poi_type'] = 'boat_ramp'
    return ac, merged, added


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--extract', required=True)
    ap.add_argument('--key', required=True)
    ap.add_argument('--bbox', nargs=4, type=float, metavar=('W', 'S', 'E', 'N'),
                    help='fallback when no --boundary is given. Fine for ONE lake, wrong at scale.')
    ap.add_argument('--boundary',
                    help='registry/boundaries/<slug>.geojson -- clip to the real polygon. '
                         'REQUIRED for a card-wide run; see the note below.')
    ap.add_argument('--buffer-m', type=float, default=250.0,
                    help='how far outside the shoreline to keep features (default 250 m)')
    ap.add_argument('--ac', help='ActiveCaptain GeoJSON to merge POIs into')
    ap.add_argument('--out', default='chartpack')
    ap.add_argument('--archive', help='also write the un-slimmed, full-precision copy here')
    a = ap.parse_args()
    if not a.bbox and not a.boundary:
        sys.exit('need --boundary (preferred) or --bbox')

    # WHY A POLYGON AND NOT A BOX.
    #
    # A bounding box is fine for one lake in isolation. Across the 1,551-lake registry it is
    # wrong, because lake bounding boxes OVERLAP even when the lakes do not touch: Dawhoo and
    # Ferry are 9 km apart on the same Santee floodplain and their boxes both swallow a stretch
    # of river and each other's approaches. Box-clipping would put Ferry's contours in Dawhoo's
    # chartpack and bill both to R2.
    #
    # The registry already ships the answer -- registry/boundaries/<slug>.geojson is a real
    # 3DHP polygon per lake. Clip to that, buffered by --buffer-m so shoreline structure, docks
    # and ramps just off the water still land in the pack.
    mask = None
    if a.boundary:
        gj = json.load(open(a.boundary, encoding='utf-8'))
        # EVERY part -- see load_boundary() in build_all_chartpacks.py. 3DHP emits one Feature
        # per part and features[0] is an arbitrary fragment; Lake Marion's is 1/3400th of the
        # lake, which is why 80,199 acres measured as unsurveyed.
        geoms = ([f.get('geometry') for f in (gj.get('features') or [])]
                 if gj.get('type') == 'FeatureCollection'
                 else [gj.get('geometry') or gj])
        poly = [ring for g in geoms if g for ring in _rings(g)]
        if not poly:
            sys.exit('no usable ring in %s' % a.boundary)
        deg = a.buffer_m / 111320.0
        t0 = time.time()
        mask = LakeMask(poly, deg)
        xs = [p[0] for r in poly for p in r]; ys = [p[1] for r in poly for p in r]
        W, S, E, N = min(xs) - deg, min(ys) - deg, max(xs) + deg, max(ys) + deg
        print('boundary %s: %d ring(s), %d vertices, +%.0f m buffer -> mask %dx%d, '
              '%d cells in %.1fs'
              % (os.path.basename(a.boundary), len(poly), sum(len(r) for r in poly),
                 a.buffer_m, mask.nx, mask.ny, len(mask.cells), time.time() - t0))
    else:
        W, S, E, N = a.bbox
        deg = a.buffer_m / 111320.0

    def inbox(x, y):
        """Box first (cheap), then one hash lookup against the rasterised lake.

        The buffer is what keeps a ramp on the bank, a dock on a pier and a contour that runs
        just outside the shoreline. Clipping to the polygon alone would shave the edge off
        every layer -- and the shoreline is where all the fishing structure is.
        """
        if not (W <= x <= E and S <= y <= N):
            return False
        if mask is None:
            return True
        return (x, y) in mask

    outdir = os.path.join(a.out, a.key); os.makedirs(outdir, exist_ok=True)
    if a.archive: os.makedirs(os.path.join(a.archive, a.key), exist_ok=True)

    print('%-14s %6s %8s %8s %9s' % ('layer', 'letter', 'tiles', 'features', 'MB'))
    total = 0.0
    for layer, (letter, objname) in SHIP.items():
        files = tile_files(a.extract, layer, letter)
        if not files and os.path.isdir(os.path.join(a.extract, layer)):
            print('   %-14s %4s   no %s* files in %s/ -- wrong tile letter?'
                  % (layer, letter, letter, layer))
        feats = []; ntile = 0; n_trim = 0; n_drop = 0
        for fp in files:
            doc = read_fc(fp)
            fs = doc.get('features') or []
            if not fs: continue
            ntile += 1
            for f in fs:
                ng, verdict = trim_geometry(f['geometry'], inbox)
                if verdict == 'drop':
                    n_drop += 1
                    continue
                if verdict == 'trim':
                    n_trim += 1
                    f = dict(f); f['geometry'] = ng
                feats.append(f)
        if n_trim or n_drop:
            print('   %-14s trimmed %d feature(s) to the boundary, dropped %d that only grazed it'
                  % (layer, n_trim, n_drop))
        if not feats:
            print('   %-14s %4s   %6d %8d   (nothing in box)' % (layer, letter, ntile, 0))
            continue

        if a.archive:
            ap_ = os.path.join(a.archive, a.key, layer + '.geojson')
            json.dump({'type': 'FeatureCollection',
                       'properties': {'layer': layer, 'key': a.key, 'note': NOTE},
                       'features': feats}, open(ap_, 'w'), ensure_ascii=False)

        if layer == 'pois' and a.ac:
            ac = json.load(open(a.ac))['features']
            for f in ac:
                f['properties'].setdefault('source', 'ActiveCaptain')
                # ActiveCaptain POIs are marinas, ramps and anchorages -- all on the water. The
                # field must be set on every record or a downstream `on_water == True` filter
                # silently drops the surveyed half of the layer.
                f['properties'].setdefault('on_water', True)
            feats, nm, na = merge_pois(feats, ac)
            feats, nc = collapse_ramps(feats, a.key)
            print('   pois: merged %d into ActiveCaptain, added %d new, '
                  'collapsed %d duplicate ramp records' % (nm, na, nc))

        slim = [{'type': 'Feature',
                 'properties': {k: v for k, v in f['properties'].items() if k not in DROP},
                 'geometry': redp(f['geometry'])} for f in feats]
        path = os.path.join(outdir, objname)
        json.dump({'type': 'FeatureCollection',
                   'properties': {'layer': layer, 'key': a.key,
                                  'generator': 'build_chartpack.py', 'note': NOTE},
                   'features': slim}, open(path, 'w'), ensure_ascii=False)
        mb = os.path.getsize(path) / 1e6; total += mb
        print('   %-14s %4s   %6d %8d %8.2f' % (layer, letter, ntile, len(slim), mb))
    print('\n   %-14s %25s %8.2f MB raw' % ('TOTAL', '', total))


if __name__ == '__main__':
    main()
