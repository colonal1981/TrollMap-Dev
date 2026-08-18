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
