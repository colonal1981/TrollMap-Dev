#!/usr/bin/env python3
"""The parts of show_missing_water.py that do not need a geodatabase.

The GDB read is match_waters_to_nhd.read_polys, imported rather than restated, so what is left
to get wrong here is the measuring and the sliver-versus-lobe call -- which is the whole point
of the tool. falls_lake is the reason it exists: 15.65 acres outside the polygon that replaced
it sounded like water and was 518 slivers, largest 0.38 acres.

Personal use only, not for distribution or resale; not for navigation.
"""
import importlib.util, math, sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location('smw', HERE / 'show_missing_water.py')
smw = importlib.util.module_from_spec(spec); spec.loader.exec_module(smw)
from shapely.geometry import Polygon, box


def close(g, w, tol, m):
    assert abs(g - w) <= tol, '%s: got %r want %r' % (m, g, w)


# --- spherical acres agrees with a known figure ---------------------------------------------
# A 0.01 x 0.01 degree box at 33N: 1.11 km tall, 1.11*cos(33) km wide.
b = box(-80.0, 33.0, -79.99, 33.01)
want = (0.01 * 111.32) * (0.01 * 111.32 * math.cos(math.radians(33.005))) * 247.105
close(smw.sphere_acres(b), want, want * 0.01, 'a small box, against the flat-earth figure')

# a hole is subtracted, not counted
solid = Polygon([(-80, 33), (-79.9, 33), (-79.9, 33.1), (-80, 33.1)])
holed = Polygon([(-80, 33), (-79.9, 33), (-79.9, 33.1), (-80, 33.1)],
                [[(-79.98, 33.02), (-79.94, 33.02), (-79.94, 33.06), (-79.98, 33.06)]])
assert smw.sphere_acres(holed) < smw.sphere_acres(solid), 'a hole is not water'
close(smw.sphere_acres(solid) - smw.sphere_acres(holed),
      smw.sphere_acres(Polygon([(-79.98, 33.02), (-79.94, 33.02),
                                (-79.94, 33.06), (-79.98, 33.06)])), 1.0,
      'and exactly the hole is what came off')

# --- sliver versus lobe, which is the call the whole tool turns on --------------------------
# THE falls_lake CASE: a ribbon along a shoreline. 2 km long, ~2 m wide.
ribbon = box(-80.0, 33.0, -79.98, 33.00002)
r, kind = smw.shape_of(ribbon)
assert kind == 'sliver', 'a 2 km x 2 m ribbon is trace disagreement, not water: %r' % (r,)

# a creek arm: 1 km x 200 m. Narrow, but not a ribbon.
arm = box(-80.0, 33.0, -79.99, 33.0018)
r, kind = smw.shape_of(arm)
assert kind == 'lobe', 'a 1 km x 200 m arm is water: %r' % (r,)

# a round basin is unambiguously a lobe
r, kind = smw.shape_of(box(-80.0, 33.0, -79.99, 33.01))
assert kind == 'lobe' and r > 0.5, (r, kind)

# and the ratio is scale-free: the same shape ten times bigger is still a sliver
big_ribbon = box(-80.0, 33.0, -79.8, 33.0002)
assert smw.shape_of(big_ribbon)[1] == 'sliver', 'the test must not depend on size'

# a degenerate piece does not throw
assert smw.shape_of(Polygon())[1] in ('point', 'sliver')

print('sphere_acres subtracts holes and agrees with the flat figure to 1%')
print('a shoreline ribbon reads as a sliver and a creek arm reads as a lobe, at any size')

# --- the page it writes has to be a page ----------------------------------------------------
import json as _json
_html = smw.HTML % {'title': 'x', 'reg': '1', 'union': '2', 'miss': '3', 'pieces': 4,
                    'verdict': 'v', 'rows': '<tr><td>1 ac</td><td>lobe</td></tr>',
                    'data': _json.dumps({'registry': {}, 'union': {}, 'missing': {},
                                         'marks': [[-80.0, 33.0, 12.3, 'lobe']]})}
assert '%(' not in _html, 'an unfilled placeholder would ship a literal %(name)s to the browser'
assert '<script src=' in _html and '<script>' in _html, 'leaflet and the inline script'
assert 'height:100%;' in _html, "the doubled %% in the CSS must come out as one"
assert '-80.0' in _html and '12.3' in _html, 'the marks reach the page'
print('the page renders with no unfilled placeholder and the CSS percent survives')
