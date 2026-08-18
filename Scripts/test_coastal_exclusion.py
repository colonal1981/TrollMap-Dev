#!/usr/bin/env python3
"""A coastal zone must not carry a water that owns its own boundary.

Ryan, 2026-08-18: "coastal water shouldn't have any freshwater in it at all period".

THE MEASUREMENT THIS EXISTS TO PREVENT REPEATING. coast_charleston_sc is an envelope -- 973
vertices, no holes, 526,313 acres of land and water together -- and Goose Creek Reservoir is
573 acres of freshwater sitting entirely inside it with a chartpack of its own. On 2026-08-18
the Charleston pack shipped 469 contours and 459 depth areas over that reservoir. Two packs,
one water, two sets of soundings.

Personal use only, not for distribution or resale; not for navigation.
"""
import importlib.util, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location('bc', HERE / 'build_chartpack.py')
bc = importlib.util.module_from_spec(spec); spec.loader.exec_module(bc)
spec2 = importlib.util.spec_from_file_location('bac', HERE / 'build_all_chartpacks.py')
bac = importlib.util.module_from_spec(spec2); spec2.loader.exec_module(bac)


def eq(g, w, m):
    assert g == w, f'{m}: got {g!r} want {w!r}'


def box(w, s, e, n):
    return [[(w, s), (e, s), (e, n), (w, n), (w, s)]]


# A coarse zone envelope. Deliberately NOT a rectangle, because a rectangle takes the
# BboxMask shortcut and there would be no raster to compare against; the rectangle case has
# its own assertion below.
ZONE = [[(-80.10, 32.90), (-79.90, 32.90), (-79.90, 33.10), (-79.98, 33.06),
         (-80.10, 33.10), (-80.10, 32.90)]]
RECT = box(-80.10, 32.90, -79.90, 33.10)        # for the shortcut assertion only
POND = box(-80.02, 32.95, -80.00, 32.97)        # a water inside it, with its own pack

# --- the hole is really a hole -------------------------------------------------------------
plain = bc.build_mask(ZONE, 0.0)
cut = bc.build_mask(ZONE, 0.0, exclude=[POND])
inside_pond = cut.cell_of(-80.010, 32.960)
outside_pond = cut.cell_of(-79.950, 33.050)
assert inside_pond in plain.cells, 'the unexcluded mask covers the pond -- that is the bug'
assert inside_pond not in cut.cells, 'a point in the excluded water must NOT be in the zone'
assert outside_pond in cut.cells, 'and the rest of the zone must be untouched'
assert cut.excluded_cells > 0, 'the run must be able to say how much it gave up'
eq(plain.excluded_cells, 0, 'no exclusion, nothing excluded')

# --- core is cleared too, or charted goes on measuring against water the zone lost ----------
assert inside_pond in plain.core
assert inside_pond not in cut.core, \
    'core is the denominator of the charted fraction; leaving the pond in it measures coverage '\
    'against water the zone no longer has'

# --- an exclusion beats the rectangle shortcut ----------------------------------------------
# ZONE is a rectangle, so build_mask would hand back a BboxMask -- four numbers and a compare,
# which cannot express a hole. Pamlico Sound is why that shortcut exists; it must not win here.
assert isinstance(bc.build_mask(RECT, 0.0), bc.BboxMask), \
    'a plain rectangle still takes the shortcut'
assert isinstance(bc.build_mask(RECT, 0.0, exclude=[POND]), bc.LakeMask), \
    'but a rectangle WITH an exclusion cannot use it -- four numbers hold no hole'
assert isinstance(cut, bc.LakeMask), 'an exclusion must force the rasterised mask'

# --- the exclusion happens AFTER the buffer -------------------------------------------------
# Excluding first and then dilating would push 250 m of zone straight back into the water it
# just gave up.
buffered = bc.build_mask(ZONE, 0.0025, exclude=[POND])
assert buffered.cell_of(-80.010, 32.960) not in buffered.cells, \
    'the buffer must not grow back into the excluded water'
assert buffered.cell_of(-79.950, 33.050) in buffered.cells, 'the buffer still works elsewhere'

# --- owned_inside: who is even a candidate --------------------------------------------------
META = {
    'coast_charleston_sc':   {'bounds_wsen': [-80.10, 32.90, -79.90, 33.10]},
    'coast_cape_romain_sc':  {'bounds_wsen': [-79.95, 32.95, -79.60, 33.20]},
    'goose_creek_reservoir': {'bounds_wsen': [-80.02, 32.95, -80.00, 32.97]},
    'lake_far_away':         {'bounds_wsen': [-84.00, 35.00, -83.90, 35.10]},
    'no_bounds_at_all':      {},
}

def fake_load(registry, slug):
    return {'goose_creek_reservoir': POND,
            'lake_far_away': box(-84, 35, -83.9, 35.1)}.get(slug)

_real = bac.load_boundary
bac.load_boundary = fake_load
try:
    bac.owned_inside.__defaults__[0].clear()          # the ring cache
    got = bac.owned_inside('coast_charleston_sc', META, 'ignored')
    eq(len(got), 1, 'only the water whose bbox actually overlaps the zone')
    eq(got[0], POND, 'and it is the right one')

    bac.owned_inside.__defaults__[0].clear()
    eq(bac.owned_inside('goose_creek_reservoir', META, 'ignored'), (),
       'A LAKE SWALLOWS NOTHING -- this is a coastal rule, and a lake inside a lake is a merge '
       'question rather than a masking one')

    bac.owned_inside.__defaults__[0].clear()
    eq(bac.owned_inside('coast_no_such_zone', META, 'ignored'), (),
       'a zone with no bounds excludes nothing rather than guessing')

    # a zone never excludes another zone: they are neighbours along a coast, not containers
    META['coast_charleston_sc']['bounds_wsen'] = [-80.10, 32.90, -79.50, 33.30]
    bac.owned_inside.__defaults__[0].clear()
    got = bac.owned_inside('coast_charleston_sc', META, 'ignored')
    eq(len(got), 1, 'the neighbouring coastal zone is not an owned water to be subtracted')
finally:
    bac.load_boundary = _real

print('ALL coastal-exclusion assertions pass')
print('a zone gives up every water that owns its own boundary, buffer and core included')


# ============================================================================================
# SELECTION CANNOT SATISFY "NONE AT ALL".
#
# After the first exclusion run, coast_charleston_sc still carried 83 contours over Goose Creek
# Reservoir -- and every single one was kept by a handful of vertices at the far end:
#
#     238 of 239 vertices inside the excluded water, 1 outside
#     565 of 574 inside, 9 outside
#     178 of 179 inside, 1 outside
#
# ZERO survivors had no vertex outside. The mask was doing exactly what it was told; keeping a
# feature for one vertex is the right rule for a lake and the wrong one for a zone that has
# given a water up. So the excluded part comes out of the geometry.
# ============================================================================================
class _FakeMask:
    """Just enough mask to drive clip_excluded: a grid and a set of excluded cells."""
    def __init__(self, cells, w=0.0, s=0.0, cell=0.001):
        self.w, self.s, self.cell = w, s, cell
        self.excluded = set(cells)
        self.exclude_rings = []

    def cell_of(self, x, y):
        return (int((x - self.w) / self.cell), int((y - self.s) / self.cell))


def _line(pts):
    return {'type': 'Feature', 'properties': {'d': 1},
            'geometry': {'type': 'LineString', 'coordinates': [list(p) for p in pts]}}


# cells 5..9 on the x axis of row 0 are the excluded water
EX = _FakeMask([(i, 0) for i in range(5, 10)])

# a contour 8 points long with only its LAST point outside -- the 238-of-239 case
f = _line([(0.0055, 0.0005), (0.0056, 0.0005), (0.0057, 0.0005), (0.0058, 0.0005),
           (0.0059, 0.0005), (0.0091, 0.0005), (0.0092, 0.0005), (0.0105, 0.0005)])
out, st = bc.clip_excluded([f], EX)
eq(out, [], 'a line that is one point short of wholly inside must not survive on that point')
eq(st['emptied'], 1, 'and it is counted as removed, not as untouched')

# a line that genuinely crosses: outside, through the water, outside again -> two runs
f = _line([(0.0005, 0.0005), (0.0015, 0.0005), (0.0055, 0.0005), (0.0075, 0.0005),
           (0.0105, 0.0005), (0.0115, 0.0005)])
out, st = bc.clip_excluded([f], EX)
eq(len(out), 2, 'cut into the pieces that survive, one FEATURE each -- see the multi-part note')
eq([o['geometry']['type'] for o in out], ['LineString', 'LineString'], 'never a Multi geometry')
eq([len(o['geometry']['coordinates']) for o in out], [2, 2], 'two vertices each side')
eq(st['trimmed'], 1, 'one feature was trimmed, however many pieces came out of it')
eq(out[0]['properties'], {'d': 1}, 'and the properties travel with it')

# a line nowhere near the water is not touched, and is not copied
f = _line([(0.0005, 0.0005), (0.0015, 0.0005)])
out, st = bc.clip_excluded([f], EX)
assert out[0] is f, 'the fast path must return the SAME object, not a rebuilt one'
eq(st['untouched'], 1, 'and say it did nothing')

# a mask with no exclusion at all short-circuits
plainmask = _FakeMask([])
out, st = bc.clip_excluded([f], plainmask)
assert out[0] is f and st == {}, 'no exclusion, no work'

# --- a ring is not a line, and must never be cut by deleting vertices ------------------------
# Walking a polygon's boundary past the deleted vertices draws a straight line across the lobe
# that was supposed to go, and silently claims the water back.
ring = [[0.0005, 0.0005], [0.0105, 0.0005], [0.0105, 0.0015], [0.0005, 0.0015], [0.0005, 0.0005]]
poly = {'type': 'Feature', 'properties': {'depth_max_dm': 30},
        'geometry': {'type': 'Polygon', 'coordinates': [ring]}}
EXP = _FakeMask([(i, j) for i in range(5, 10) for j in (0, 1)])
EXP.exclude_rings = [[[[0.0049, 0.0000], [0.0099, 0.0000], [0.0099, 0.0020],
                       [0.0049, 0.0020], [0.0049, 0.0000]]]]
try:
    import shapely  # noqa: F401
    HAVE_SHAPELY = True
except ImportError:
    HAVE_SHAPELY = False

out, st = bc.clip_excluded([poly], EXP)
if HAVE_SHAPELY:
    eq(st['trimmed'], 1, 'one feature trimmed')
    assert len(out) >= 1, out
    for _o in out:
        eq(_o['geometry']['type'], 'Polygon', 'single-part only, never a MultiPolygon')
    xs = [p[0] for o in out for p in bc._allpts(o['geometry']['coordinates'])]
    assert not any(0.0050 < x < 0.0098 for x in xs), \
        'the excluded span must be gone from the ring, not bridged across: %r' % (sorted(set(xs)),)
    eq(out[0]['properties'], {'depth_max_dm': 30}, 'properties survive the cut')
else:
    # THE FALLBACK IS ALSO A PROMISE. Without shapely a ring cannot be cut, so it is dropped
    # whole and counted under its own name -- never trimmed by deleting vertices, which would
    # bridge the boundary across the lobe and claim the water back. Erring toward removing
    # water is the right direction under a rule that says none at all.
    eq(out, [], 'no shapely: the straddling polygon is dropped whole, not bridged')
    eq(st['dropped_no_shapely'], 1, 'and counted where the run can report it')
    eq(st['trimmed'], 0, 'never silently trimmed')

print('a feature keeps only its part outside the water the zone gave up')

# A polygon large enough to ENCLOSE the excluded water has no vertex anywhere near it. The
# first version of the candidate test asked about vertices and this sailed straight through.
big = {'type': 'Feature', 'properties': {},
       'geometry': {'type': 'Polygon', 'coordinates': [
           [[0.0000, 0.0000], [0.0200, 0.0000], [0.0200, 0.0030],
            [0.0000, 0.0030], [0.0000, 0.0000]]]}}
out, st = bc.clip_excluded([big], EXP)
if HAVE_SHAPELY:
    eq(st['trimmed'], 1, 'a polygon that merely CONTAINS the excluded water must still be cut')
    xs = sorted({round(p[0], 4) for o in out for p in bc._allpts(o['geometry']['coordinates'])})
    assert 0.0049 in xs and 0.0099 in xs, 'and the cut lands on the excluded water: %r' % (xs,)
else:
    eq(st['dropped_no_shapely'], 1,
       'even with no shapely it must be RECOGNISED as a candidate -- the bug this guards is '
       'the box test being skipped, not the cut')
    eq(st['untouched'], 0, 'it must never pass through as untouched')

# verts() is shallow by design, so a MultiPolygon reaches this code as a list of RINGS. Reading
# that as coordinate pairs is how a bbox comes back as a comparison between a float and a list.
mp = {'type': 'MultiPolygon', 'coordinates': [
    [[[0.0, 0.0], [0.001, 0.0], [0.001, 0.001], [0.0, 0.0]]],
    [[[0.02, 0.02], [0.021, 0.02], [0.021, 0.021], [0.02, 0.02]]]]}
eq(bc._bbox(list(bc._allpts(mp['coordinates']))), (0.0, 0.0, 0.021, 0.021),
   'every ring of every part counts toward the box')
eq(len(list(bc._allpts([[1.0, 2.0]]))), 1, 'a single pair is one point, not two')
eq(list(bc._allpts([3.0, 4.0])), [[3.0, 4.0]], 'a bare pair is itself')

print('a polygon that encloses the excluded water is cut, and MultiPolygon nesting is read right')

# ============================================================================================
# ONE FEATURE, ONE GEOMETRY -- AND NEVER A MULTI ONE.
#
# verts() is shallow on purpose: for a MultiLineString it returns the list of LINES, so
# `for x, y in verts(g)` unpacks a whole line into a coordinate pair and hands cell_of() a
# list. Returning a clipped contour as a MultiLineString crashed the 2026-08-18 rebuild inside
# _flush() the moment coast_winyah_bay_sc produced one:
#
#     TypeError: unsupported operand type(s) for -: 'list' and 'float'
#
# A contour cut in two IS two contours. Emit them as two features.
# ============================================================================================
f = _line([(0.0005, 0.0005), (0.0015, 0.0005), (0.0055, 0.0005), (0.0075, 0.0005),
           (0.0105, 0.0005), (0.0115, 0.0005)])
out, st = bc.clip_excluded([f], EX)
eq(len(out), 2, 'a line cut in two comes back as TWO features')
for o in out:
    eq(o['geometry']['type'], 'LineString', 'and never as a MultiLineString')
    eq(o['properties'], {'d': 1}, 'each carrying the original properties')
    # the thing that actually crashed: verts() must yield coordinate PAIRS for this geometry
    for x, y in bc.verts(o['geometry']):
        assert isinstance(x, float) and isinstance(y, float), (x, y)

if HAVE_SHAPELY:
    # a polygon cut into two lobes must do the same
    # the cutter has to span the polygon completely, or the difference is one C shape
    SPLIT = _FakeMask([(i, j) for i in range(5, 10) for j in range(0, 5)])
    SPLIT.exclude_rings = [[[[0.0049, -0.0010], [0.0099, -0.0010], [0.0099, 0.0040],
                             [0.0049, 0.0040], [0.0049, -0.0010]]]]
    dumb = {'type': 'Feature', 'properties': {'z': 1}, 'geometry': {'type': 'Polygon',
            'coordinates': [[[0.0000, 0.0000], [0.0200, 0.0000], [0.0200, 0.0030],
                             [0.0000, 0.0030], [0.0000, 0.0000]]]}}
    out, st = bc.clip_excluded([dumb], SPLIT)
    eq(len(out), 2, 'a polygon cut in two comes back as two features')
    for o in out:
        eq(o['geometry']['type'], 'Polygon', 'and never as a MultiPolygon')
        for x, y in bc.verts(o['geometry']):
            assert isinstance(x, float) and isinstance(y, float), (x, y)

    # A GEOMETRY SHAPELY REFUSES IS NOT WATER THAT WAS EXCLUDED. Counting them together would
    # let a geometry bug read as a clean exclusion.
    bad = {'type': 'Feature', 'properties': {}, 'geometry': {'type': 'Polygon',
           'coordinates': [[[0.0050, 0.0005], [0.0060, 0.0005]]]}}   # two points, not a ring
    out, st = bc.clip_excluded([bad], EXP)
    eq(st['emptied'], 0, 'a geometry that could not be read is not "it was inside"')
    eq(st['failed'], 1, 'it has its own name')

print('a cut feature stays single-part, and an uncuttable one is counted apart')

if HAVE_SHAPELY:
    # buffer(0) IS THE STANDARD REPAIR FOR A RING AND A DESTROYER OF A LINE.
    # shape(LineString).buffer(0) returns an EMPTY POLYGON -- a line has no area to buffer to.
    # Applied to every geometry it emptied every contour that touched an exclusion, which is
    # the exact layer this change exists to fix, and counted them as water correctly removed.
    LINEMASK = _FakeMask([(i, j) for i in range(5, 10) for j in range(0, 5)])
    LINEMASK.exclude_rings = [[[[0.0049, -0.0010], [0.0099, -0.0010], [0.0099, 0.0040],
                                [0.0049, 0.0040], [0.0049, -0.0010]]]]
    crossing = _line([(0.0005, 0.0005), (0.0055, 0.0005), (0.0105, 0.0005), (0.0115, 0.0005)])
    out, st = bc.clip_excluded([crossing], LINEMASK)
    eq(st['emptied'], 0, 'a line that crosses the water still has two ends -- it is not empty')
    eq(st['trimmed'], 1, 'it is trimmed')
    eq(len(out), 2, 'into the two stretches that survive')
    for o in out:
        eq(o['geometry']['type'], 'LineString', 'each a plain LineString')
    xs = [p[0] for o in out for p in bc._allpts(o['geometry']['coordinates'])]
    assert not any(0.0050 < x < 0.0098 for x in xs), 'and neither reaches into the water'

    mls = {'type': 'Feature', 'properties': {}, 'geometry': {'type': 'MultiLineString',
           'coordinates': [[[0.0005, 0.0005], [0.0115, 0.0005]],
                           [[0.0005, 0.0025], [0.0115, 0.0025]]]}}
    out, st = bc.clip_excluded([mls], LINEMASK)
    eq(st['emptied'], 0, 'the same for a MultiLineString')
    eq(len(out), 4, 'two lines, each cut in two, four features')

print('a line is cut, not annihilated -- buffer(0) is only for rings')
