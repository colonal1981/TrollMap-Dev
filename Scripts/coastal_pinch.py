#!/usr/bin/env python3
r"""
coastal_pinch.py — find the open Atlantic in a coastal pack and cut it out.

Personal use only, not for distribution or resale; not for navigation.

THE PROBLEM
-----------
2026-08-08. Ryan: "the blue shit goes the green shit stays... how we get there i have no idea."

20 coastal packs are **2,021 MB of 9,235 MB — 21.4% of everything** — from 1.6% of the registry.
Mean coastal pack is 101 MB against 5.9 MB for every other water. Pamlico is 224 MB; all of Lake
Murray, which is fished end to end, is 285 MB. Most of that is open Atlantic nobody will ever
paddle, and it is there because all 22 coastal boundaries are 5-vertex rectangles reaching tens of
kilometres offshore.

SIX WAYS THIS WAS TRIED AND FAILED FIRST, so nobody repeats them
---------------------------------------------------------------
1. Shrink the rectangles. A rectangle cannot describe a diagonal coast. Ryan: "still dumb".
2. Ramp-anchored radius. Uses the validation set as the source and destroys it.
3. 3DHP featuretype 4. USGS gives bays, sounds AND the open ocean one FCode, 44500. Same feature.
4. Natural Earth / OSM ocean polygons. Same lumping — and NE 10m put 20 of 58 catalog ramps inside
   the ocean while calling Pamlico not-ocean and Albemarle ocean. Generalisation, not a rule.
5. Distance to land. Dead on arrival: "the marshes extend way out from land."
6. Depth cap. Dead too: "there are inland and river area that are deeper than the first 2 miles."

THE ONE THAT SURVIVES
---------------------
None of those describe what actually separates the two. This does:

    inshore water is water you can only reach through a NARROW OPENING.

The Atlantic is open to the horizon. A sound, a marsh, a creek, a tidal river — every one connects
to the sea through an inlet. So shrink the whole water shape inward by R. Any passage narrower
than 2R closes. The ocean, being enormous, survives as one piece; everything behind an inlet falls
off as its own piece. Whichever piece still reaches the seaward edge of the box is the Atlantic.
Grow it back by R so nothing is lost, and subtract it.

Depth never enters it. Distance from land never enters it. Marsh can run twenty miles from solid
ground and still be inshore, because it is still behind an inlet.

Nor is R invented: USGS splits its own Sea/ocean polygons where "the distance between headlands is
at least a width of 1 nautical mile, approximately 2 kilometers." R = 1 km is that rule exactly.

WHICH WAY THE KNOB TURNS — this is the part worth understanding
---------------------------------------------------------------
Pinching HARDER is SAFER. R closes openings up to 2R wide, so a bigger R separates MORE water from
the ocean and therefore KEEPS more. Erode hard enough to erase a narrow creek entirely and that
creek simply is not part of the ocean piece, so it survives the cut untouched.

There is no setting where being too aggressive deletes your creeks. The only failure mode is being
too GENTLE: an inlet wider than 2R never closes, so its sound stays welded to the Atlantic and
goes with it. Charleston Harbor's entrance is 3-4 km and Port Royal Sound's is around 5, so R = 1
will not hold them — expect to need 2 or 3.

That failure is loud, not silent: the ramp check below catches it immediately.

THE CHECK
---------
Every real DNR access point must survive. Not the coastal catalog's 58 ramps — those are hand-
typed and were measured on 2026-08-08 at a MEDIAN 2.05 km from the nearest real ramp, 45 of 58
over a kilometre, Oregon Inlet 15.9 km out. They are guesses on a map and they are why "20 ramps
fall in the ocean" measured nothing. Use registry/_dnr_ramps_*.json: 3,064 points from the state
agencies, good to 25-30 m.

    py scripts\coastal_pinch.py --packs F:\TrollMapPipeline\chartpack `
                                --feeds F:\TrollMapPipeline\registry --radius-km 1,2,3

Reads only, and reports. --write is a separate, later decision.
"""
from __future__ import annotations
import argparse, glob, json, math, os, sys

try:
    import numpy as np
except ImportError:
    sys.exit('needs numpy:  pip install numpy --break-system-packages')
try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit('needs Pillow:  pip install pillow --break-system-packages')

# Zones with NO open Atlantic inside their box. The pinch takes the largest connected piece of
# water as the sea, which is right wherever the sea is actually present -- and catastrophic where
# it is not, because then the largest piece is the biggest INSHORE water and the cut deletes it.
#
# Ryan, 2026-08-09: "ignore albermarle sound completely there is already no atlantic there."
#
# He is right and no measurement here would have caught it. The ramp check did not: at R=4
# Albemarle lost zero access points and would still have cut 38% of a sound the Atlantic does not
# reach. This is geography, not geometry, so it is stated rather than derived.
NO_ATLANTIC = {
    'coast_albemarle_sound_nc',   # Ryan: "there is already no atlantic there"
    'coast_pamlico_sound_nc',     # Ryan: "don't worry about that one... almost no ocean"
}

# Zones where the sea is a STRIP against one edge of the box rather than the biggest thing in it.
# "Largest connected piece" is the right rule when the Atlantic dominates the box, and exactly
# wrong when it does not: on the Outer Banks the box runs from Roanoke Sound out only ~15 km past
# the beach, so the sound is bigger than the sea inside it and the rule picked the sound. Measured
# at R=2 km before this existed, the cut took 9.9% of the line-work SEAWARD of the islands and
# 53.0% of the line-work BEHIND them -- precisely inverted.
#
# Ryan, 2026-08-09: "outerbanks absolutely needs to be cut... it mostly atlantic and deep water
# atlantic at that."
#
# Declaring the seaward side is geography, like NO_ATLANTIC above. N/S/E/W of the grid.
OCEAN_EDGE = {
    'coast_outer_banks_nc': 'E',
}

# Zones Ryan decided are not worth cutting: the ocean inside their box is a sliver and the risk of
# getting it wrong outweighs the megabytes.
#
#   Ryan, 2026-08-09: "savannah, beaufort, charleston and ace basin just dont cut them... the
#   little bit of red here is not worth it"
NOT_WORTH_CUTTING = {
    'coast_savannah_ga',
    'coast_beaufort_sc',
    'coast_charleston_sc',
    'coast_ace_basin_sc',
}

# 100 m, not 200. A tidal creek is 50-300 m across, and the whole question is whether a creek is a
# separate piece of water from the ocean. A cell wider than the creek cannot answer it.
CELL_M = 100.0


def water_grid(pack: str, cell_m: float = CELL_M, include_bbox=None):
    """
    Where is there water, on a grid.

    THE SURFACE IS RASTERISED FROM THE DEPTH-AREA POLYGONS' INTERIORS, and that is the correction
    made on 2026-08-09 after the first honest run.

    What it did before: mark a cell as water if a contour VERTEX landed in it, then close the
    result with a 1 km kernel to bridge the gaps between contour lines. The closing was added
    because contours are lines hundreds of metres apart offshore, so the raw mask was stripes and
    eroding stripes by a kilometre erases everything.

    The closing is what broke it. A 1 km closing fills every channel narrower than 2 km, and
    every channel in ACE Basin is narrower than 2 km. Measured: the real depth-area polygons cover
    1,085 km2 and the closed grid called it 2,063 km2 -- nearly double, and the extra is the marsh
    welded into one solid blob with no creeks in it. With no narrow openings left there was nothing
    for the pinch to find, so the ocean piece grew up every creek and the run reported seven DNR
    landings lost at R=3 km and five at R=8: Bennetts Point on Mosquito Creek, Fields Point on the
    Combahee, Eddings on Jenkins Creek. Not one of them is an oceanfront ramp.

    So the claim in the header -- that pinching harder cannot delete a creek -- was true of the
    method and false of that implementation.

    Depth areas are POLYGONS. They are already a surface and need no closing at all. Filling their
    interiors gives the water shape as surveyed, with the channels still channels. Contour lines
    are drawn in on top for the offshore bulk where depth areas thin out; drawn as LINES rather
    than loose vertices, they connect without any bridging.

    Holes are deliberately NOT subtracted. A hole in a depth band is the next band down -- deeper
    water, not an island -- and punching them out would perforate the surface.

    `include_bbox` widens the grid to cover the zone's own boundary as well as the survey. Without
    it the grid stops where Garmin's soundings stop, the traced shape is clipped to that, and any
    part of the zone with a ramp but no bathymetry falls outside the new boundary -- Cape Romain
    lost the Highway 45 Bridge landing on Wambaw Creek by 1,833 m that way. Nothing was lost from
    the PACK, since there was no data there to cut, but the ramp lost the zone it belongs to, and
    "the ramps that go with that body of water" is half the acceptance test.
    """
    def read(path, kinds):
        try:
            with open(path, 'r', encoding='utf-8') as fh:
                feats = (json.load(fh) or {}).get('features') or []
        except Exception:
            return []
        out = []
        for f in feats:
            g = f.get('geometry') or {}
            t, cs = g.get('type'), g.get('coordinates') or []
            if t not in kinds or not cs:
                continue
            if t == 'Polygon':
                out.append(cs[0])
            elif t == 'MultiPolygon':
                out.extend(p[0] for p in cs if p)
            elif t == 'LineString':
                out.append(cs)
            elif t == 'MultiLineString':
                out.extend(cs)
        return out

    areas = read(os.path.join(pack, 'depth_areas.geojson'), ('Polygon', 'MultiPolygon'))
    lines = read(os.path.join(pack, 'contours.geojson'), ('LineString', 'MultiLineString'))
    pts = [q for r in areas for q in r] + [q for r in lines for q in r]
    if not pts:
        return None
    xs = [q[0] for q in pts]
    ys = [q[1] for q in pts]
    x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
    if include_bbox:
        bw, bs, be, bn = include_bbox
        x0, y0, x1, y1 = min(x0, bw), min(y0, bs), max(x1, be), max(y1, bn)
    lat0 = (y0 + y1) / 2.0
    sx = 111320.0 * math.cos(math.radians(lat0)) / cell_m
    sy = 110574.0 / cell_m
    w = int((x1 - x0) * sx) + 3
    h = int((y1 - y0) * sy) + 3
    if w * h > 120_000_000:                 # a zone big enough to need it gets a coarser cell
        return water_grid(pack, cell_m * 2.0, include_bbox)

    to_px = lambda r: [((q[0] - x0) * sx, (q[1] - y0) * sy) for q in r]

    img = Image.new('1', (w, h), 0)
    dr = ImageDraw.Draw(img)
    for r in areas:
        if len(r) >= 3:
            dr.polygon(to_px(r), fill=1)
    for r in lines:
        if len(r) > 1:
            dr.line(to_px(r), fill=1)
    g = np.array(img, dtype=bool)

    # The contour line-work on its own. The water surface says how much SEA is cut; this says how
    # much of the PACK goes with it, which is the number that decides whether this is worth doing.
    im2 = Image.new('1', (w, h), 0)
    d2 = ImageDraw.Draw(im2)
    for r in lines:
        if len(r) > 1:
            d2.line(to_px(r), fill=1)
    return {'water': g, 'lines': np.array(im2, dtype=bool),
            'cell': cell_m, 'lat0': lat0, 'x0': x0, 'y0': y0,
            'sx': sx, 'sy': sy, 'contours': len(lines), 'depth_areas': len(areas)}


def _shift(a, dy, dx, fill=False):
    h, w = a.shape
    o = np.full_like(a, fill)
    o[max(dy, 0):h + min(dy, 0), max(dx, 0):w + min(dx, 0)] = \
        a[max(-dy, 0):h + min(-dy, 0), max(-dx, 0):w + min(-dx, 0)]
    return o


def erode(g, n: int):
    """Out-of-bounds counts as WATER. The array border is the edge of the survey, not a
    shoreline; eroding against zeros eats the water back from all four sides and the ocean
    stops touching the box it is supposed to reach."""
    for _ in range(n):
        g = (g & _shift(g, 1, 0, True) & _shift(g, -1, 0, True)
             & _shift(g, 0, 1, True) & _shift(g, 0, -1, True))
        if not g.any():
            break
    return g


def dilate(g, n: int):
    for _ in range(n):
        g = g | _shift(g, 1, 0) | _shift(g, -1, 0) | _shift(g, 0, 1) | _shift(g, 0, -1)
    return g


def largest_piece(a):
    """The biggest connected piece of water, and how many cells it holds.

    Replaces "flood in from the seaward columns", which assumed the ocean lies EAST. It does not.
    ACE Basin's box has water on 121 cells of its SOUTH border and none at all on its east, so
    that version was flooding from a dry edge and reporting "no water reaches the seaward edge"
    for a zone whose ocean was right there. The Atlantic is the largest thing in any of these
    boxes by an order of magnitude, which is a property of the water and not of the box.

    Label propagation in numpy: scipy.ndimage is not installable here, and PIL's floodfill does
    not write through an Image.fromarray view.
    """
    h, w = a.shape
    lab = np.where(a, np.arange(a.size).reshape(h, w), -1)
    for _ in range(4 * (h + w)):
        m = lab.copy()
        m[:-1, :] = np.maximum(m[:-1, :], lab[1:, :])
        m[1:, :] = np.maximum(m[1:, :], lab[:-1, :])
        m[:, :-1] = np.maximum(m[:, :-1], lab[:, 1:])
        m[:, 1:] = np.maximum(m[:, 1:], lab[:, :-1])
        m = np.where(a, m, -1)
        if np.array_equal(m, lab):
            break
        lab = m
    ids, counts = np.unique(lab[a], return_counts=True)
    if not len(ids):
        return np.zeros_like(a), 0
    return lab == ids[int(np.argmax(counts))], int(counts.max())


def piece_touching_edge(a, edge: str, depth: int = 3):
    """Everything connected to the far side of the water in one direction.

    Seeded from the outermost columns/rows that actually HOLD water, not from the array border.
    The grid is sized to the survey and the zone rectangle together, so the rectangle usually
    reaches further out than any soundings -- Outer Banks' box runs to -75.400 and its data stops
    near -75.468, five kilometres short. Seeding the literal edge found nothing and the pinch
    reported "no water reaches the E edge" for a zone that is half ocean.
    """
    if not a.any():
        return None
    cols = np.nonzero(a.any(axis=0))[0]
    rows = np.nonzero(a.any(axis=1))[0]
    seed = np.zeros_like(a)
    if edge == 'E':
        seed[:, max(cols.max() - depth + 1, 0):cols.max() + 1] = a[:, max(cols.max() - depth + 1, 0):cols.max() + 1]
    elif edge == 'W':
        seed[:, cols.min():cols.min() + depth] = a[:, cols.min():cols.min() + depth]
    elif edge == 'N':
        seed[max(rows.max() - depth + 1, 0):rows.max() + 1, :] = a[max(rows.max() - depth + 1, 0):rows.max() + 1, :]
    elif edge == 'S':
        seed[rows.min():rows.min() + depth, :] = a[rows.min():rows.min() + depth, :]
    else:
        return None
    if not seed.any():
        return None
    cur = seed
    while True:
        nxt = dilate(cur, 1) & a
        if nxt.sum() == cur.sum():
            return nxt
        cur = nxt


def absorb_marooned_keep(m, g, ramps_px):
    """RETRACTED 2026-08-09, same day it was written. Do not re-enable without reading this.

    Written to clear the green patches left far offshore. It made things worse, and the reason is
    that it repeats the mistake it was meant to patch: it keeps the LARGEST kept component and
    absorbs the rest, so wherever the biggest kept blob happens to be offshore -- Brunswick and
    Winyah Bay -- everything else including inland water got absorbed as sea, and both zones came
    out inverted.

    Ryan: "brunswick you inverted now you are cutting stuff wayyyyy inland.... same with winyah...
    yeah you have broke this worse... this isn't working your cutter has no idea what ocean is vs
    inland".

    He is right, and the deeper point is the one worth keeping: connectivity of the BATHYMETRY
    cannot tell sea from inshore. Every variant tried -- largest piece, flood from a named edge,
    largest kept piece -- is the same guess wearing a different hat, and each one fixes two zones
    and inverts two others. The next attempt needs an actual land reference (the Garmin shoreline
    is already in every pack) rather than another connectivity heuristic.

    Kept, unused, as the record of a dead end.

    Any kept piece that is neither the inshore body nor holds a landing IS ocean.

    2026-08-09, from the preview Ryan walked through: "outer banks is good except it looks like
    there is green wayyyyy out in the ocean next to the red", and the same on St Helena, Hilton
    Head, Bogue Sound -- "most of the ones that i checked had that issue".

    They are patches of deep water that came adrift from the main ocean piece: offshore the
    depth-area coverage is patchy, so eroding by 2 km snaps a lobe off, and it then survives the
    cut as "kept" water forty kilometres out. Nothing about it is inshore except that the
    connectivity test lost hold of it.

    The rule that fixes it without inventing geography: kept water is either the main inshore body
    or it has a real DNR landing on it. Anything else is sea.

    There is deliberately NO size exemption. The first version spared any detached piece over
    4 km2, which is precisely backwards -- Ryan on Core Sound: "green covers sound, then red is
    ocean near shore then green again after red". That second green is the deep Atlantic beyond
    the near-shore band, and it is BIG. Size is evidence of being ocean here, not evidence of
    being worth keeping.
    """
    keep = g & ~m
    if not keep.any():
        return m
    lab, _ = None, None
    pieces = []
    remaining = keep.copy()
    while remaining.any():
        sub, n = largest_piece(remaining)
        if not n:
            break
        pieces.append((n, sub))
        remaining = remaining & ~sub
    if not pieces:
        return m
    pieces.sort(key=lambda t: -t[0])
    out = m.copy()
    for i, (n, sub) in enumerate(pieces):
        if i == 0:
            continue                      # the inshore body always stays
        has_ramp = any(sub[cy, cx] for cy, cx in ramps_px
                       if 0 <= cy < sub.shape[0] and 0 <= cx < sub.shape[1])
        if has_ramp:
            continue
        out |= sub
    return out


def ocean_mask(wg, radius_m: float, edge: str = None, ramps_px=()):
    """(mask or None, reason). The pinch, on the grid.

    Two ways to identify the sea, and which is right depends on the box:

    LARGEST PIECE, the default. Correct wherever the Atlantic dominates -- ACE Basin, Charleston,
    the Georgia sounds. It needs no compass, which matters because these boxes do not agree on
    one: ACE Basin's ocean touches the SOUTH edge and none of its east.

    TOUCHING A NAMED EDGE, for the zones in OCEAN_EDGE. Correct where the sea is a strip and the
    sound behind the barrier islands is the bigger piece, which is the Outer Banks exactly.
    """
    n = max(1, int(round(radius_m / wg['cell'])))
    g = wg['water']
    shrunk = erode(g, n)
    if not shrunk.any():
        return None, 'all water narrower than %.0f km' % (2 * radius_m / 1000)
    if edge:
        sea = piece_touching_edge(shrunk, edge)
        if sea is None or not sea.any():
            return None, 'no water reaches the %s edge after the pinch' % edge
    else:
        sea, cells = largest_piece(shrunk)
        if not cells:
            return None, 'nothing survives the pinch'
    return dilate(sea, n) & g, ''


def boundary_bbox(path):
    """The zone boundary's own extent, so the grid can be made big enough to hold it."""
    try:
        with open(path, encoding='utf-8') as fh:
            doc = json.load(fh)
    except Exception:
        return None
    xs, ys = [], []
    for f in (doc.get('features') or [doc]):
        g = f.get('geometry') or {}
        t, cs = g.get('type'), g.get('coordinates') or []
        ps = [cs] if t == 'Polygon' else (cs if t == 'MultiPolygon' else [])
        for p in ps:
            for r in p:
                xs += [q[0] for q in r]
                ys += [q[1] for q in r]
    return (min(xs), min(ys), max(xs), max(ys)) if xs else None


def rasterise_boundary(path, wg):
    """The zone's EXISTING boundary, on the same grid. None if it cannot be read.

    The cut has to be `the zone AND NOT the ocean`. Tracing `not the ocean` alone traces the whole
    raster minus a bite, and the raster covers the surveyed extent, which is not the zone: Beaufort
    came back 19% LARGER than the rectangle it was replacing. A boundary that grows is the opposite
    of the job.
    """
    try:
        with open(path, encoding='utf-8') as fh:
            doc = json.load(fh)
    except Exception:
        return None
    parts = []
    for f in (doc.get('features') or [doc]):
        g = f.get('geometry') or {}
        t, cs = g.get('type'), g.get('coordinates') or []
        if t == 'Polygon':
            parts.append(cs)
        elif t == 'MultiPolygon':
            parts.extend(cs)
    if not parts:
        return None
    h, w = wg['water'].shape
    img = Image.new('1', (w, h), 0)
    dr = ImageDraw.Draw(img)
    for p in parts:
        r = [((q[0] - wg['x0']) * wg['sx'], (q[1] - wg['y0']) * wg['sy']) for q in p[0]]
        if len(r) >= 3:
            dr.polygon(r, fill=1)
    return np.array(img, dtype=bool)


def ring_area(r):
    """Signed shoelace, in squared degrees. The magnitude orders parts biggest-first, which is
    all it is used for -- the sign is not trusted, because holes are found by containment."""
    a = 0.0
    for i in range(len(r) - 1):
        a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]
    return a / 2.0


def trace_keep(mask, wg, simplify_px: int = 1):
    """Turn the KEEP raster into GeoJSON polygon parts, in lon/lat.

    Two things this has to get right, and the first version got both wrong:

    PAD FIRST. Marching squares only closes a ring that is fully inside the array; a region
    touching the border comes back as an open fragment. Traced unpadded, Beaufort -- which loses
    8.6% of its water -- produced a boundary box a tenth of the zone, because the "biggest ring"
    was a stray closed loop and the real coastline was in pieces. One cell of false all round
    fixes it: every region is then interior and every ring closes.

    HOLES BY CONTAINMENT, not by winding. The keep region is one blob with the ocean bitten out
    of it, and matplotlib does not promise an orientation convention. A ring nested inside an odd
    number of other rings is a hole; everything else starts a new part. Getting this backwards
    would either fill the ocean back in or turn the marsh into a hole in the sea.

    matplotlib rather than shapely because shapely will not install on this machine and the job
    is a marching-squares trace, which contour() already does properly.
    """
    import matplotlib
    matplotlib.use('Agg')
    from matplotlib import pyplot as plt

    padded = np.zeros((mask.shape[0] + 2, mask.shape[1] + 2), dtype=float)
    padded[1:-1, 1:-1] = mask.astype(float)
    fig = plt.figure()
    try:
        cs = plt.contour(padded, levels=[0.5])
        segs = [sg for coll in (cs.allsegs or []) for sg in coll]
    finally:
        plt.close(fig)

    rings = []
    step = max(1, int(simplify_px))
    for sg in segs:
        if len(sg) < 4:
            continue
        pts = list(sg[::step])
        if list(pts[-1]) != list(sg[-1]):
            pts.append(sg[-1])
        r = [[wg['x0'] + (float(x) - 1.0) / wg['sx'],
              wg['y0'] + (float(y) - 1.0) / wg['sy']] for x, y in pts]
        if r[0] != r[-1]:
            r.append(r[0])
        if len(r) >= 4:
            rings.append(r)
    if not rings:
        return []

    boxes = [(min(q[0] for q in r), min(q[1] for q in r),
              max(q[0] for q in r), max(q[1] for q in r)) for r in rings]

    def inside(pt, r, bb):
        x, y = pt
        if x < bb[0] or x > bb[2] or y < bb[1] or y > bb[3]:
            return False
        hit = False
        j = len(r) - 1
        for i in range(len(r)):
            xi, yi = r[i][0], r[i][1]
            xj, yj = r[j][0], r[j][1]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-18) + xi:
                hit = not hit
            j = i
        return hit

    depth = []
    for i, r in enumerate(rings):
        d = sum(1 for k, rr in enumerate(rings)
                if k != i and inside(r[0], rr, boxes[k]))
        depth.append(d)

    parts, holes = [], []
    for i, r in enumerate(rings):
        (holes if depth[i] % 2 else parts).append((i, r))
    out = []
    for i, r in parts:
        mine = [hr for k, hr in holes
                if inside(hr[0], r, boxes[i]) and depth[k] == depth[i] + 1]
        out.append([r] + mine)
    out.sort(key=lambda p: -abs(ring_area(p[0])))
    return out


def write_boundary(reg_dir, slug, parts, radius_km, dry=True):
    """Replace the offshore rectangle with the inshore shape.

    The zone boundaries are five-vertex rectangles reaching tens of kilometres out. Cutting the
    ocean means cutting the POLYGON, not filtering the pack files -- a contour is only ever
    assigned by clipping against a boundary, so fixing the polygon and re-cutting keeps
    `charted`, the audit and the invariants all telling the same story. Filtering the outputs
    would leave the boundary claiming water the pack no longer holds.

    Parts arrive from trace_keep() already nested -- outer ring first, its holes after -- so a
    zone whose inshore water is in several disconnected pieces becomes a MultiPolygon rather than
    one part swallowing the others.
    """
    if not parts:
        return None
    geom = ({'type': 'Polygon', 'coordinates': parts[0]} if len(parts) == 1
            else {'type': 'MultiPolygon', 'coordinates': parts})
    xs = [q[0] for p in parts for r in p for q in r]
    ys = [q[1] for p in parts for r in p for q in r]
    doc = {'type': 'FeatureCollection',
           'properties': {'slug': slug, 'feature_type': 'Coastal',
                          'bounds_wsen': [round(min(xs), 6), round(min(ys), 6),
                                          round(max(xs), 6), round(max(ys), 6)],
                          'pinched_radius_km': radius_km,
                          'note': 'inshore only; the open Atlantic has been cut out'},
           'features': [{'type': 'Feature', 'properties': {}, 'geometry': geom}]}
    fp = os.path.join(reg_dir, 'boundaries', '%s.geojson' % slug)
    if dry:
        return doc
    aside = os.path.join(reg_dir, '_coastal_rect_originals')
    os.makedirs(aside, exist_ok=True)
    if os.path.exists(fp) and not os.path.exists(os.path.join(aside, '%s.geojson' % slug)):
        import shutil
        shutil.move(fp, os.path.join(aside, '%s.geojson' % slug))
    with open(fp, 'w', encoding='utf-8') as fh:
        json.dump(doc, fh)
    return doc


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--packs', required=True)
    ap.add_argument('--feeds', required=True)
    ap.add_argument('--radius-km', default='1,2,3')
    ap.add_argument('--only', help='comma list of zone slugs')
    ap.add_argument('--ramp-tolerance-m', type=float, default=400.0,
                    help='how close kept water must be for a landing to count as surviving '
                         '(default 400). A ramp is a point on the BANK: asking whether its own '
                         'cell is in the ocean piece is the wrong question, because the line '
                         'between kept and cut runs right past it. Rodanthe measured 141 m from '
                         'kept water and was being called a loss.')
    ap.add_argument('--write', type=float, metavar='KM',
                    help='replace each zone boundary with the inshore shape at this radius. '
                         'Must be one of --radius-km. Without --go this only reports.')
    ap.add_argument('--go', action='store_true', help='actually write. Default is a dry run.')
    ap.add_argument('--list-lost', type=float, metavar='KM',
                    help='name every access point the cut at this radius would put in the '
                         'ocean. Must be one of --radius-km.')
    a = ap.parse_args()

    ramps = []
    for f in (glob.glob(os.path.join(a.feeds, '_dnr_ramps_*.json'))
              + glob.glob(os.path.join(a.feeds, '_dnr_paddle_*.json'))):
        try:
            d = json.load(open(f, encoding='utf-8'))
        except Exception:
            continue
        src = os.path.basename(f).replace('_dnr_', '').replace('.json', '')
        for wb, pts in (d.get('waterbodies') or {}).items():
            for p in (pts if isinstance(pts, list) else []):
                if p.get('lat') and p.get('lon'):
                    # Carry the NAME. "8 ramps lost" is a number Ryan cannot check; "Bennetts
                    # Point, on the Ashepoo" is one he can look at. He has been clear about the
                    # division of labour: "you do the counting i do the looking."
                    ramps.append((float(p['lat']), float(p['lon']),
                                  p.get('name') or p.get('site') or '?', wb, src))
    print('%d real DNR access points loaded' % len(ramps))

    # A comma list, because the sweep has to be driven a couple of zones at a time: the machine
    # this runs on kills background jobs between calls, so a 20-minute run has to be 20 short ones.
    _only = {x.strip() for x in (a.only or '').split(',') if x.strip()}
    radii = [float(x) * 1000.0 for x in a.radius_km.split(',') if x.strip()]
    zones = sorted(d for d in glob.glob(os.path.join(a.packs, 'coast_*'))
                   if os.path.isdir(d) and (not _only or os.path.basename(d) in _only))
    print('%-32s %8s %7s %s' % ('zone', 'contours', 'km2',
                                '  '.join('R=%.0f cut%%/ramps' % (r / 1000) for r in radii)))
    tot = {r: [0, 0, 0] for r in radii}
    lost_by = {r: [] for r in radii}
    written = []
    ocean_box = {r: {} for r in radii}
    for z in zones:
        slug = os.path.basename(z)
        if slug in NOT_WORTH_CUTTING:
            print('%-32s %8s %7s   skipped -- not worth cutting (Ryan, 2026-08-09)'
                  % (slug[:32], '-', '-'))
            continue
        if slug in NO_ATLANTIC:
            print('%-32s %8s %7s   skipped -- no open Atlantic in this box' % (slug[:32], '-', '-'))
            continue
        _bfp = os.path.join(a.feeds, 'boundaries', '%s.geojson' % slug)
        wg = water_grid(z, include_bbox=boundary_bbox(_bfp))
        if wg is None:
            print('%-32s (no contours or depth areas)' % slug[:32]); continue
        cells = int(wg['water'].sum())
        vtx = wg['lines']
        nvtx = int(vtx.sum())
        km2 = cells * (wg['cell'] ** 2) / 1e6
        ramps_px = [(int((la - wg['y0']) * wg['sy']), int((lo - wg['x0']) * wg['sx']))
                    for la, lo, _n, _w, _s in ramps]
        out, notes = [], []
        for R in radii:
            m, why = ocean_mask(wg, R, OCEAN_EDGE.get(slug), ramps_px)
            if m is None:
                out.append('    --      ')
                if why not in notes: notes.append(why)
                continue
            # Fraction of the CHARTED LINE-WORK removed, not of the filled area. That is what
            # shrinks the pack, and it is the number to judge this on.
            pct = 100.0 * int((m & vtx).sum()) / max(nvtx, 1)
            _oy, _ox = np.nonzero(m)
            if len(_ox):
                ocean_box[R][slug] = (wg['x0'] + _ox.min() / wg['sx'], wg['y0'] + _oy.min() / wg['sy'],
                                      wg['x0'] + _ox.max() / wg['sx'], wg['y0'] + _oy.max() / wg['sy'],
                                      int(m.sum()) * wg['cell'] ** 2 / 1e6)
            lost = 0
            keep = wg['water'] & ~m
            ky, kx = np.nonzero(keep)
            tol_cells = a.ramp_tolerance_m / wg['cell']
            for la, lo, nm, wb, src in ramps:
                cx = int((lo - wg['x0']) * wg['sx'])
                cy = int((la - wg['y0']) * wg['sy'])
                if not (0 <= cy < m.shape[0] and 0 <= cx < m.shape[1] and m[cy, cx]):
                    continue
                # In the ocean piece -- but is there still kept water alongside it? A landing
                # keeps its water if any survives within the tolerance.
                near = len(kx) and bool(
                    (np.hypot(kx - cx, ky - cy) <= tol_cells).any())
                if not near:
                    lost += 1
                    lost_by[R].append((slug, nm, wb, src, la, lo))
            out.append(' %5.1f%%/%-4d' % (pct, lost))
            tot[R][0] += int((m & vtx).sum()); tot[R][1] += nvtx; tot[R][2] += lost

            if a.write is not None and abs(R - a.write * 1000.0) < 1.0:
                # A zone that loses an access point does NOT get written, at any radius. The whole
                # point of the ramp check is that it is a veto and not a footnote.
                if lost:
                    written.append((slug, None, 'refused: %d access point(s) would be cut off'
                                    % lost))
                    continue
                _bfp = os.path.join(a.feeds, 'boundaries', '%s.geojson' % slug)
                zone = rasterise_boundary(_bfp, wg)
                if zone is None:
                    written.append((slug, None, 'refused: no boundary to intersect with'))
                    continue
                doc = write_boundary(a.feeds, slug, trace_keep(zone & ~m, wg),
                                     a.write, dry=not a.go)
                written.append((slug, doc, 'ok' if doc else 'refused: nothing to trace'))
        print('%-32s %8d %7.0f %s' % (slug[:32], wg['contours'], km2, ''.join(out)))
        if notes:
            print('%-32s   %s' % ('', '; '.join(notes)))

    print()
    for R in radii:
        cut, all_, lost = tot[R]
        if all_:
            print('R=%.0fkm  removes %.1f%% of charted coastal line-work   ramps lost: %d'
                  % (R / 1000, 100.0 * cut / all_, lost))
    print()
    print('A ramp lost is a FAILURE. Pinch harder -- a bigger radius closes wider inlets,')
    print('keeps more water, and cannot delete a creek.')

    if a.list_lost is None and ocean_box.get(radii[0]):
        print()
        print('WHERE THE CUT THINKS THE ATLANTIC IS -- check these against a map. A box that sits')
        print('BEHIND the barrier islands is a sound being mistaken for the sea:')
        _R = (a.write * 1000.0) if a.write is not None else radii[0]
        for slug, (w_, s_, e_, n_, km2) in sorted(ocean_box.get(_R, {}).items()):
            print('  %-32s %8.0f km2   %.3f %.3f %.3f %.3f' % (slug, km2, w_, s_, e_, n_))

    if a.write is not None:
        ok = [w for w in written if w[1] is not None]
        print()
        print('%s BOUNDARIES AT R=%g km' % ('WROTE' if a.go else 'WOULD WRITE', a.write))
        for slug, doc, why in sorted(written):
            if doc is None:
                print('  %-32s %s' % (slug, why))
            else:
                _g = doc['features'][0]['geometry']
                _ps = ([_g['coordinates']] if _g['type'] == 'Polygon' else _g['coordinates'])
                n = len(_ps)
                v = sum(len(r) for p in _ps for r in p)
                b = doc['properties']['bounds_wsen']
                print('  %-32s %d part(s), %6d vertices   box %.3f %.3f %.3f %.3f'
                      % (slug, n, v, *b))
        print()
        if a.go:
            print('%d boundary file(s) replaced; the rectangles are in '
                  'registry/_coastal_rect_originals/' % len(ok))
            print('NOW re-cut those zones, then upload. Until the re-cut the packs still hold')
            print('the ocean -- this only changed what the next clip will keep.')
        else:
            print('DRY RUN. %d zone(s) would be rewritten. Add --go.' % len(ok))

    # ...with one exception worth naming, because it decides whether the sweep can ever reach
    # zero. A ramp that launches STRAIGHT ONTO THE OCEAN -- an oceanfront pier, a barrier-island
    # ramp facing east -- is inside the ocean piece at every radius, because it really is on the
    # ocean. No R removes it, so a plateau above zero is the expected shape, not a failure of the
    # method. Which is why the names matter: the question is not "how many" but "would Ryan ever
    # put a kayak in there".
    if a.list_lost is not None:
        R = a.list_lost * 1000.0
        rows = lost_by.get(R)
        if rows is None:
            print('\n--list-lost %g is not one of the radii swept' % a.list_lost)
        else:
            print('\nACCESS POINTS THE R=%g km CUT WOULD PUT IN THE OCEAN (%d):' % (a.list_lost, len(rows)))
            print('  %-24s %-34s %-26s %s' % ('zone', 'access point', 'waterbody', 'position'))
            for slug, nm, wb, src, la, lo in sorted(rows):
                print('  %-24s %-34s %-26s %.5f, %.5f  [%s]'
                      % (slug[:24], str(nm)[:34], str(wb)[:26], la, lo, src))
            print('\nLook at these. Any that is an oceanfront or barrier-island launch is a')
            print('correct removal; any that sits up a creek or behind an inlet is a real miss.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
