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
                    'wet': '9', 'unm': '1,234', 'verdict': 'v',
                    'rows': '<tr><td>1 ac</td><td>lobe</td><td>9 ac water</td></tr>',
                    'data': _json.dumps({'registry': {}, 'union': {}, 'missing': {},
                                         'garmin': {}, 'unshipped': {},
                                         'marks': [[-80.0, 33.0, 12.3, 'lobe']]})}
assert '%(' not in _html, 'an unfilled placeholder would ship a literal %(name)s to the browser'
assert '<script src=' in _html and '<script>' in _html, 'leaflet and the inline script'
assert 'height:100%;' in _html, "the doubled %% in the CSS must come out as one"
assert '-80.0' in _html and '12.3' in _html, 'the marks reach the page'
assert 'D.garmin' in _html, 'the water layer has to be on the map'
assert 'D.unshipped' in _html, \
    'and the line no pack draws, which is the only thing on the page that is actually absent'
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

# --- "is it missing" and "does the app draw it" are different questions ----------------------
# lake_marion, 2026-08-18: the audit called it 11,580 acres short, the difference came back as
# one 11,125-acre piece over Sparkleberry Swamp, and Ryan said the app already draws contours
# and depth areas there. Counted afterwards: 2,155 contours and 2,111 depth areas in that
# swamp, already in the pack. The boundary was short and nothing was missing from the app.
#
# THE QUESTION SURVIVED, THE MEASUREMENT DID NOT. The first version drew a box around the gap
# and counted every pack feature whose first coordinate fell in it. The box around a gap
# includes the lake beside it, so on prestwood_lake it found 42 contours and 45 depth areas
# "already drawn" in a gap the pack cannot reach at all -- the pack is clipped to the boundary
# the gap is outside of. Marion only came out right because its gap happened to sit clear of
# the lake. Identity, not a box.
assert 'chartpack' in _src and 'already' in _src, \
    'the tool must count what the pack ALREADY holds inside the area said to be missing'
_blk = _src[_src.index('def garmin_evidence'):]
assert 'add outline, not soundings' in _src, \
    'and it must say what re-tracing would actually buy'
assert "os.path.join(root, 'chartpack', slug)" in _blk, 'a water with no pack yet is not an error'
assert 'os.path.exists(fp)' in _blk, 'and neither is a pack with no such layer'
print('it counts what the pack already draws inside the gap, not just the size of the gap')

# --- the verdict is Garmin's, not a shape's -------------------------------------------------
# prestwood_lake, 2026-08-18. Ryan, in the app: "its definitely cut short on most banks... the
# boundary doesn't line up with the shoreline pretty much at all". The gap came back as ONE
# piece of 261.7 acres -- the whole upper half of the lake -- 129 m of mean width and 16 km of
# sinuous bank, so 4*pi*A/P^2 read it as a sliver and the page said "shoreline disagreement
# between two traces of the same water, not missing lake". A flooded creek arm has the
# perimeter of a ribbon, and there is no threshold that separates them: the lake-sized rim
# built above to PROVE a rim is a sliver is itself about 100 m wide.
#
# So no shape may decide it any more.
_v = _src[_src.index('    # DOES THE APP ALREADY DRAW IT?'):]
assert "shape_of(p)[1] == 'lobe'" not in _v, \
    'the verdict must not come from the shape test -- that is what got Prestwood backwards'
assert 'garmin_evidence(' in _src, 'it comes from what Garmin charts inside the gap'
assert 'zoom' in _src[_src.index('def garmin_evidence'):], \
    'and at zoom 0 on both sides, or six renderings of one contour read as six missing ones'

# --- what the pack holds is matched by identity, never by a box -----------------------------
# The box around the pieces of a gap includes the lake the gap is beside. On prestwood_lake
# that counted 42 contours and 45 depth areas as "already drawn" for a pack that carries
# nothing outside its own boundary at all -- the exact opposite of the truth.
_g = _src[_src.index('def garmin_evidence'):_src.index('\n\nHTML = ')]
assert 'hb[0] <=' not in _src, 'the bounding-box containment test is gone'
_code = '\n'.join(l for l in _g.split('pack = os.path.join')[1].split('\n')
                  if not l.lstrip().startswith('#'))
assert 'raw' not in _code, \
    'the pack has no `raw` -- matching on one compares against an empty set, always'
assert 'g.difference(cover)' in _g, "the pack's features are matched by their geometry"

# --- C tiles carry the soundings; the map stores B ------------------------------------------
_b, _c = smw.tiles_for('/nonexistent', 'nothing')
assert (_b, _c) == ([], []), 'a missing map is empty, not an exception'
import json as _j, gzip as _gz, tempfile as _tf, os as _os
_root = _tf.mkdtemp()
_os.makedirs(_os.path.join(_root, 'registry'))
_j.dump({'by_lake': {'x_lake': ['B4E0F4']}, 'by_tile': {}},
        open(_os.path.join(_root, 'registry', 'tile_lake_map.json'), 'w'))
_b, _c = smw.tiles_for(_root, 'x_lake')
assert _b == ['B4E0F4'] and _c == ['C4E0F4'], \
    'contours live under the C name; asking for B returns nothing and looks like empty water'
print('the verdict comes from Garmin, matched by identity, with the C tile asked for by name')

# --- garmin_evidence counts water, and how much line no pack draws ---------------------------
# THE MATCH KEY MUST EXIST IN BOTH FILES. The version before this one matched the tile's `raw`
# against the pack's `raw`. A chartpack feature carries layer, mode, zoom, depth_* and tile --
# there is no `raw` -- so the comparison ran against an empty set and reported "0 already
# shipped" for every water on every layer. It passed its own test because the test invented a
# pack feature with a `raw` on it. A fixture that carries a field the real file does not have
# tests nothing.
#
# AND A PACK IS NOT CLIPPED TO ITS BOUNDARY. build_chartpack dilates the mask, so Prestwood's
# 193-acre ring ships contours out to -80.1024 while the gap begins at -80.0917. Assuming the
# clip is exact is what turned "the app already draws most of this arm" into "the pack has
# never shipped any of it". Ryan, looking at the app: "the green area is present".
def _tile(root, layer, name, feats):
    d = _os.path.join(root, 'extract', layer)
    _os.makedirs(d, exist_ok=True)
    with _gz.open(_os.path.join(d, name + '.geojson.gz'), 'wt', encoding='utf-8') as fh:
        _j.dump({'type': 'FeatureCollection', 'features': feats}, fh)

def _poly(x0, y0, x1, y1, props):
    return {'type': 'Feature', 'properties': props,
            'geometry': {'type': 'Polygon',
                         'coordinates': [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]}}

def _line(x0, y0, x1, y1, props):
    return {'type': 'Feature', 'properties': props,
            'geometry': {'type': 'LineString', 'coordinates': [[x0, y0], [x1, y1]]}}

_gap = box(-80.0, 33.0, -79.99, 33.01)
# the same water twice, as Garmin emits it at two display modes -- one `raw`, one polygon
_tile(_root, 'waterbody', 'B4E0F4',
      [_poly(-80.0, 33.0, -79.995, 33.01, {'raw': 'aa', 'mode': '6/20', 'zoom': 0}),
       _poly(-80.0, 33.0, -79.995, 33.01, {'raw': 'aa', 'mode': '11/19', 'zoom': 1}),
       _poly(-70.0, 20.0, -69.9, 20.1, {'raw': 'zz', 'mode': '6/20', 'zoom': 0})])
# three contours in the gap: one the pack ships whole, one it ships half of, one it never saw.
# plus a generalised copy at zoom 3 and one far away, neither of which may be counted.
_tile(_root, 'contours', 'C4E0F4',
      [_line(-79.999, 33.001, -79.997, 33.001, {'zoom': 0}),
       _line(-79.999, 33.001, -79.997, 33.001, {'zoom': 3}),
       _line(-79.999, 33.003, -79.997, 33.003, {'zoom': 0}),
       _line(-79.999, 33.005, -79.997, 33.005, {'zoom': 0}),
       _line(-70.0, 20.0, -69.99, 20.0, {'zoom': 0})])
_os.makedirs(_os.path.join(_root, 'chartpack', 'x_lake'))
# NOTE: no `raw` on any of these, because a real pack does not have one.
_j.dump({'type': 'FeatureCollection', 'features': [
    _line(-79.999, 33.001, -79.997, 33.001, {'zoom': 0, 'layer': 'contours'}),
    _line(-79.999, 33.003, -79.998, 33.003, {'zoom': 0, 'layer': 'contours'})]},
    open(_os.path.join(_root, 'chartpack', 'x_lake', 'contours.geojson'), 'w'))

_ev = smw.garmin_evidence(_root, 'x_lake', _gap)
assert _ev['tiles'] == 1 and _ev['read'], _ev
close(_ev['water_ac'], smw.sphere_acres(box(-80.0, 33.0, -79.995, 33.01)), 1.0,
      'the same water at two display modes is counted once, not twice')
assert _ev['contours'] == 3, 'zoom 0 only, and only inside the gap: %r' % _ev
assert _ev['pack_contours'] == 1, \
    'only the one the pack ships WHOLE counts as shipped: %r' % _ev
# half of the second (about 93 m at this latitude) and all of the third (about 186 m)
close(_ev['unshipped_m']['contours'], 279.0, 40.0,
      'the answer is metres of line, because a feature cut in half is half shipped')
assert _ev['depth_areas'] == 0 and _ev['pack_depth_areas'] == 0, _ev

# a pack that reaches PAST its boundary is the normal case, not an anomaly
_far_pack_gap = box(-80.0, 33.0005, -79.9975, 33.0015)
_ev3 = smw.garmin_evidence(_root, 'x_lake', _far_pack_gap)
assert _ev3['pack_contours'] == 1 and _ev3['unshipped_m'].get('contours', 0) < 1.0, \
    'a gap whose only contour the pack already draws has nothing missing in it: %r' % _ev3

# a gap Garmin never charted reads as nothing, and that is a different answer from an error
_far = box(-70.5, 20.5, -70.4, 20.6)
_ev2 = smw.garmin_evidence(_root, 'x_lake', _far)
assert _ev2['tiles'] == 1 and not _ev2['read'] and _ev2['water_ac'] == 0.0, _ev2
print('garmin_evidence dedupes water, keeps zoom 0, and answers in metres the pack does not draw')

# --- a length is metres, not degrees times 111,000 ------------------------------------------
# A degree of longitude at 33 N is 93 km. The flat factor overstated every east-west run by
# 19%, and the number it fed is the one line of the report a person would act on.
_ew = smw.metres(__import__('shapely').geometry.LineString([(-80.0, 33.0), (-79.998, 33.0)]))
close(_ew, 186.4, 4.0, 'two thousandths of a degree east-west at 33 N is 186 m, not 222')
_ns = smw.metres(__import__('shapely').geometry.LineString([(-80.0, 33.0), (-80.0, 33.002)]))
close(_ns, 222.0, 4.0, 'and north-south it really is 222 m')
print('lengths are measured on the projection, not multiplied by a flat 111,000')
