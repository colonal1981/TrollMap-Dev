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
w, kind = smw.shape_of(ribbon)
assert kind == 'sliver', 'a 2 km x 2 m ribbon is trace disagreement, not water: %r' % (w,)
close(w, 2.2, 1.0, 'and the width it reports is the width it has')

# a creek arm: 1 km x 200 m. Narrow, but not a ribbon.
arm = box(-80.0, 33.0, -79.99, 33.0018)
w, kind = smw.shape_of(arm)
assert kind == 'lobe', 'a 1 km x 200 m arm is water: %r' % (w,)
close(w, 168.0, 40.0, 'and its width is hundreds of metres, not tens')

# a round basin is unambiguously a lobe
w, kind = smw.shape_of(box(-80.0, 33.0, -79.99, 33.01))
assert kind == 'lobe' and w > 400, (w, kind)

# THE WIDTH IS THE POINT, BECAUSE THE RATIO ALONE WAS USELESS ON THE ONE THAT MATTERED.
# Marion's difference was ONE connected piece of 11,125 acres and got labelled "sliver" -- true
# of its 4*pi*A/P^2 and useless, because a rim traced all the way round a lake is one enormous
# ring and a ring has the arithmetic of a ribbon at any size. A 90 m band around a 45 km2 lake
# is thousands of acres and is not water anyone can fish.
_R = 0.30                      # degrees, a lake-sized ring
_ring = box(-80 - _R, 33 - _R, -80 + _R, 33 + _R).difference(
    box(-80 - _R + 0.001, 33 - _R + 0.001, -80 + _R - 0.001, 33 + _R - 0.001))
_w, _kind = smw.shape_of(_ring)
assert _kind == 'sliver', 'a rim is a sliver however many acres it is'
assert _w < 200, 'and its width says so plainly: %.0f m' % _w
assert smw.sphere_acres(_ring) > 1000, 'while its ACREAGE looks like a lot of water: %.0f' \
    % smw.sphere_acres(_ring)

# scale-free: the same shape ten times bigger is still a sliver
big_ribbon = box(-80.0, 33.0, -79.8, 33.0002)
assert smw.shape_of(big_ribbon)[1] == 'sliver', 'the test must not depend on size'

# a degenerate piece does not throw
assert smw.shape_of(Polygon())[1] in ('point', 'sliver')

print('sphere_acres subtracts holes and agrees with the flat figure to 1%')
print('a ribbon and a lake-sized rim both read as slivers, and the width says why')

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

# --- read_polys hands back WKB, not geometry ------------------------------------------------
# Its docstring says "Return (wkb_array, ...)" and match_waters_to_nhd.main() calls from_wkb on
# it before touching it. Reading the NAME of a function instead of its docstring is how
# "'bytes' object has no attribute 'area'" reached Ryan's terminal.
import re as _re
_src = (HERE / 'show_missing_water.py').read_text(encoding='utf-8')
_call = _src[_src.index('mw.read_polys'):]
assert 'from_wkb' in _src, 'the WKB must be converted before it is used as geometry'
assert _re.search(r'wkb, cols, missing', _src), \
    'name it wkb so the next reader cannot mistake it for geometry'
assert _src.index('from shapely import from_wkb') < _src.index('mw.read_polys'), \
    'the import has to be in scope before the read'
_after = _src[_src.index('geom = from_wkb(wkb)'):]
assert 'geom[i] is None or geom[i].is_empty' in _after, \
    'from_wkb yields None for an unreadable row -- skip it rather than crash on it later'
print('the WKB coming out of read_polys is converted, and empty rows are skipped')

# --- the page must set a view before it draws anything heavy --------------------------------
# Leaflet with no view set draws NOTHING -- not a slow map, a blank one. 16,750 polygons stalled
# the script before fitBounds ever ran and Ryan got an empty page with no blue, orange or red.
_js = _src[_src.index('const D = %(data)s'):_src.index("'''\n\n\ndef main")]
assert _js.count('map.fitBounds') == 1, 'exactly one fitBounds, not two'
assert _js.index('map.fitBounds') < _js.index('D.missing'), \
    'the view is set before the heaviest layer is added'
assert _js.index('D.registry') < _js.index('map.fitBounds'), \
    'and after the layer it takes its bounds from'
print('the page sets its view before the heavy layer, so a slow draw cannot blank it')

# --- the union rule has to match the matcher's, dissolve and all ----------------------------
# Skipping the GNIS dissolve made this report 10 pieces where the binding said 6, and comparing
# a MEASURED union against nhd_union_acres -- which is the sum of the source rows' declared
# AreaSqKm -- called the difference drift. Two mistakes, one warning.
assert 'normalize_gnis' in _src, 'the GNIS dissolve is what makes the piece count comparable'
assert 'declared' in _src and "sum(m['km2'] for m in keep) * 247.105" in _src, \
    'nhd_union_acres is DECLARED area; compare declared against declared'
_chk = _src[_src.index('drift = stored'):]
assert 'declared - stored' in _chk, 'the self-check compares like with like'
assert "len(keep) != b.get('nhd_union_pieces')" in _chk, 'and the piece count too'
print('the union dissolves by GNIS id and checks declared against declared')
