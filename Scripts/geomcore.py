"""Overlap measurement for find_duplicate_waters.py, fastest available engine first.

WHY THIS FILE EXISTS
    The first cut ray-cast 1,200 sample points against every edge of the other polygon in pure
    Python, both directions, per pair. registry/boundaries holds 275 MB of geojson and the
    biggest single water is 8.3 MB, which is over 200,000 edges. That is ~240 million
    interpreted operations for ONE direction of ONE pair. Ryan called it painfully slow and he
    was being polite.

THREE ENGINES, SAME ANSWERS
    shapely  exact. Real polygon intersection in C, so the overlap is a true area ratio and
             there is no sampling and no boundary ambiguity at all.
    numpy    sampled, but vectorised: the whole point-by-edge crossing test is array maths, and
             points outside the other polygon's bounding box are rejected before any of it.
    python   the original loop. Correct, kept only so the tool still runs with nothing installed.

WHY EXACT MATTERS BEYOND SPEED
    Vertex sampling cannot recognise two copies of one outline: every vertex of A lies exactly on
    B's boundary, where a ray cast is a coin toss, so identical polygons score near 50/50 rather
    than 100/100. The real john_h_moss_lake / kings_mountain_reservoir pair scored 48.7 and 50.5.
    Shapely's area intersection returns 100/100 for that case with no special pleading.
"""


def pick_engine(prefer=None):
    """Returns (name, module_bundle). prefer='numpy' or 'python' to force a slower path."""
    order = ['shapely', 'numpy', 'python']
    if prefer:
        order = [prefer] + [o for o in order if o != prefer]
    for name in order:
        if name == 'shapely':
            try:
                from shapely.geometry import shape           # noqa: F401
                from shapely.ops import unary_union          # noqa: F401
                return 'shapely', None
            except ImportError:
                continue
        if name == 'numpy':
            try:
                import numpy                                  # noqa: F401
                return 'numpy', None
            except ImportError:
                continue
        return 'python', None
    return 'python', None


# ---------------------------------------------------------------------------------------
# shapely: exact
# ---------------------------------------------------------------------------------------
def _shapely_geom(polys):
    from shapely.geometry import Polygon, MultiPolygon
    made = []
    for p in polys:
        if not p or len(p[0]) < 4:
            continue
        try:
            g = Polygon(p[0], p[1:] if len(p) > 1 else None)
        except Exception:
            continue
        if not g.is_valid:
            g = g.buffer(0)          # traced shorelines self-intersect constantly
        if not g.is_empty:
            made.append(g)
    if not made:
        return None
    if len(made) == 1:
        return made[0]
    try:
        return MultiPolygon(made)
    except Exception:
        from shapely.ops import unary_union
        return unary_union(made)


def overlap_shapely(pa, pb):
    """Exact. Returns (a_in_b_pct, b_in_a_pct, area_ratio, centroid_sep_raw, a_area, b_area)."""
    ga, gb = _shapely_geom(pa), _shapely_geom(pb)
    if ga is None or gb is None or ga.area <= 0 or gb.area <= 0:
        return 0.0, 0.0, 0.0, None, 0.0, 0.0
    try:
        inter = ga.intersection(gb).area
    except Exception:
        ga, gb = ga.buffer(0), gb.buffer(0)
        inter = ga.intersection(gb).area
    a_in_b = 100.0 * inter / ga.area
    b_in_a = 100.0 * inter / gb.area
    ratio = min(ga.area, gb.area) / max(ga.area, gb.area)
    ca, cb = ga.centroid, gb.centroid
    sep = ((ca.x - cb.x) ** 2 + (ca.y - cb.y) ** 2) ** 0.5
    return a_in_b, b_in_a, ratio, sep, ga.area, gb.area


# ---------------------------------------------------------------------------------------
# numpy: sampled but vectorised
# ---------------------------------------------------------------------------------------
def _np_rings(polys):
    import numpy as np
    out = []
    for p in polys:
        rings = []
        for r in p:
            a = np.asarray([[pt[0], pt[1]] for pt in r], dtype='float64')
            if len(a) >= 4:
                rings.append(a)
        if rings:
            out.append(rings)
    return out


def _np_inside_ring(px, py, ring, block=64):
    """Crossing-number test for many points against one ring, in blocks so a 200k-edge ring
    never materialises a 200k x N boolean array."""
    import numpy as np
    x1 = ring[:, 0]
    y1 = ring[:, 1]
    x2 = np.roll(x1, -1)
    y2 = np.roll(y1, -1)
    dy = y2 - y1
    safe = np.where(dy == 0, 1e-15, dy)
    res = np.zeros(len(px), dtype=bool)
    for s in range(0, len(px), block):
        e = min(s + block, len(px))
        X = px[s:e, None]
        Y = py[s:e, None]
        straddles = (y1[None, :] > Y) != (y2[None, :] > Y)
        xint = (x2 - x1)[None, :] * (Y - y1[None, :]) / safe[None, :] + x1[None, :]
        res[s:e] = (straddles & (X < xint)).sum(axis=1) % 2 == 1
    return res


def _np_inside(px, py, rings_list):
    import numpy as np
    hit = np.zeros(len(px), dtype=bool)
    for rings in rings_list:
        inner = _np_inside_ring(px, py, rings[0])
        for hole in rings[1:]:
            inner &= ~_np_inside_ring(px, py, hole)
        hit |= inner
    return hit


def _bbox(polys):
    xs0 = ys0 = float('inf')
    xs1 = ys1 = float('-inf')
    for p in polys:
        for x, y, *_ in p[0]:
            if x < xs0: xs0 = x
            if x > xs1: xs1 = x
            if y < ys0: ys0 = y
            if y > ys1: ys1 = y
    if xs0 > xs1:
        return None
    return xs0, ys0, xs1, ys1


def area_centroid(polys):
    """Shoelace area and area-weighted centroid, holes subtracted. Exact and cheap."""
    total = 0.0
    cx = cy = 0.0
    for poly in polys:
        for k, ring in enumerate(poly):
            a2 = rx = ry = 0.0
            n = len(ring)
            for i in range(n):
                x1, y1 = ring[i][0], ring[i][1]
                x2, y2 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
                cross = x1 * y2 - x2 * y1
                a2 += cross
                rx += (x1 + x2) * cross
                ry += (y1 + y2) * cross
            a = a2 / 2.0
            if a == 0:
                continue
            sign = -1.0 if k else 1.0
            total += sign * abs(a)
            cx += sign * abs(a) * (rx / (3.0 * a2))
            cy += sign * abs(a) * (ry / (3.0 * a2))
    if total == 0:
        return 0.0, None, None
    return abs(total), cx / total, cy / total


def overlap_numpy(pa, pb, sample=400):
    """Estimate the SHARED AREA on a grid, then divide by each polygon's exact shoelace area.

    The first version sampled one polygon's boundary VERTICES and asked how many fell inside the
    other. That measures the boundary, not the area, and it fails two ways that matter here: two
    copies of one outline score ~50/50 because every vertex lands exactly on the other's edge,
    and a square overlapping another square by half scores near zero because its only vertices
    are four corners. Grid sampling asks the same question shapely answers exactly, so the two
    engines agree instead of merely correlating."""
    import numpy as np
    area_a, ax, ay = area_centroid(pa)
    area_b, bx, by = area_centroid(pb)
    ratio = (min(area_a, area_b) / max(area_a, area_b)) if max(area_a, area_b) > 0 else 0.0
    sep = None
    if None not in (ax, ay, bx, by):
        sep = ((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5
    ba, bb = _bbox(pa), _bbox(pb)
    if not ba or not bb or area_a <= 0 or area_b <= 0:
        return 0.0, 0.0, ratio, sep, area_a, area_b
    w, s_, e, n = max(ba[0], bb[0]), max(ba[1], bb[1]), min(ba[2], bb[2]), min(ba[3], bb[3])
    if e <= w or n <= s_:
        return 0.0, 0.0, ratio, sep, area_a, area_b

    side = max(16, min(96, int(sample ** 0.5) * 3))          # 48x48 at the default sample
    gx = (np.arange(side) + 0.5) / side * (e - w) + w
    gy = (np.arange(side) + 0.5) / side * (n - s_) + s_
    GX, GY = np.meshgrid(gx, gy)
    px, py = GX.ravel(), GY.ravel()
    ra, rb = _np_rings(pa), _np_rings(pb)
    if not ra or not rb:
        return 0.0, 0.0, ratio, sep, area_a, area_b
    both = _np_inside(px, py, ra) & _np_inside(px, py, rb)
    cell = (e - w) * (n - s_) / (side * side)
    inter = float(both.sum()) * cell
    inter = min(inter, area_a, area_b)
    return (100.0 * inter / area_a, 100.0 * inter / area_b, ratio, sep, area_a, area_b)


def measure(engine, pa, pb, sample=400):
    if engine == 'shapely':
        return overlap_shapely(pa, pb)
    return overlap_numpy(pa, pb, sample)


def verdict(a_in_b, b_in_a, area_ratio=None, centroid_sep_frac=None, same_type=True):
    """Name the RELATIONSHIP between two outlines, and say separately whether it looks like one
    water under two slugs. Returns (label, likely_duplicate).

    The first cut said "B IS A PARTIAL TRACE OF A -- keep A" for greenfield_lake inside
    coast_cape_fear_nc: a 75-acre lake wholly inside a 195,000-acre coastal region. Containment
    was true and the conclusion was garbage. Acting on that label deletes a real water.

    Containment only implies identity when the two are COMPARABLE IN SIZE and of the SAME KIND.
    A small lake inside a big coastal box is a lake in a region. A river 97% inside a lake is a
    river running through it. Both are real spatial facts and neither is a duplicate, so they are
    reported as relationships and excluded from the duplicate list rather than silently dropped.

    a_in_b and b_in_a are percentages of each polygon's OWN area that the two share."""
    both_high = a_in_b >= 90 and b_in_a >= 90
    tight = (area_ratio is not None and area_ratio >= 0.97
             and centroid_sep_frac is not None and centroid_sep_frac <= 0.02)
    if both_high or tight:
        return 'SAME OUTLINE TWICE -- one water, two slugs', True

    contained = max(a_in_b, b_in_a) >= 90
    if contained and (area_ratio is None or area_ratio < 0.25):
        return 'ONE SITS WHOLLY INSIDE THE OTHER at very different sizes -- containment, not identity', False
    if not same_type:
        return 'OVERLAP BETWEEN DIFFERENT FEATURE TYPES -- a river meeting a lake, not identity', False
    if contained:
        return 'ONE SITS WHOLLY INSIDE THE OTHER at comparable size -- probably one water', True
    if min(a_in_b, b_in_a) >= 40:
        return 'HEAVY PARTIAL OVERLAP -- look at it', True
    return 'touching only, probably distinct', False
