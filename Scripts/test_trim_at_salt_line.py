#!/usr/bin/env python3
"""trim_at_salt_line.py, on geometry small enough to check by eye.

The one that matters is the SINGLE-PIECE case. A polygon the line never crosses lies wholly on
one side, and which side is the whole answer -- reading it as "does not apply" is how a 294-acre
saltwater creek stayed in the freshwater river list.

Personal use only, not for distribution or resale; not for navigation.
"""
import importlib.util, json, math, os, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location('tsl', HERE / 'trim_at_salt_line.py')
tsl = importlib.util.module_from_spec(spec); spec.loader.exec_module(tsl)

import classify_salt_fresh as CSF
from classify_salt_fresh import load_dividers, build_index
CSF.SEAWARD = (math.cos(math.radians(-45.0)), math.sin(math.radians(-45.0)))
from shapely.geometry import box, mapping

# A stand-in coast: one "highway" running WSW to ENE, so seaward is to its south-east, and one
# named exception laid across a river well inland of it -- the Cooper's shape, in miniature.
LINE = {'type': 'FeatureCollection', 'features': [
    {'type': 'Feature', 'properties': {'NAME': 'US Highway 17'},
     'geometry': {'type': 'LineString', 'coordinates': [[-80.0, 33.0], [-79.0, 33.5]]}},
    {'type': 'Feature', 'properties': {'NAME': 'Cooper River'},
     'geometry': {'type': 'LineString', 'coordinates': [[-79.55, 33.60], [-79.45, 33.60]]}},
]}
tmp = Path(tempfile.mkdtemp())
(tmp / 'line.geojson').write_text(json.dumps(LINE))
index = build_index(load_dividers(str(tmp / 'line.geojson')))
knives = tsl.cutters(str(tmp / 'line.geojson'))

assert '' in knives, 'US Highway 17 is the default knife and is keyed empty, like the index'
assert CSF._norm('Cooper River') in knives, 'an exception is keyed by its normalised name'
assert set(knives) == set(k for k in index if k in knives), \
    'the knife and the classifier must be selected by the SAME key or they can disagree'

# --- straddling: the seaward half goes, the landward half stays ------------------------------
straddle = box(-79.6, 33.10, -79.4, 33.40)
kept, dropped, note = tsl.trim(straddle, 'Nameless River', knives, index)
assert kept is not None and dropped is not None, note
assert tsl.sphere_acres(kept) > 0 and tsl.sphere_acres(dropped) > 0, note
assert abs(tsl.sphere_acres(kept) + tsl.sphere_acres(dropped)
           - tsl.sphere_acres(straddle)) < 1.0, 'the two halves are the whole'
assert kept.representative_point().y > dropped.representative_point().y, \
    'the freshwater half is the landward one'
print('a water straddling the line is cut into a kept half and a dropped half')

# --- THE mosquito_creek CASE: wholly seaward, and the line never touches it -------------------
far_out = box(-79.30, 32.60, -79.28, 32.62)
kept, dropped, note = tsl.trim(far_out, 'Mosquito Creek', knives, index)
assert kept is None, 'a water wholly seaward of the line has no freshwater part: %r' % note
assert dropped is not None and 'seaward' in note, note
print('a water the line never crosses, lying seaward, is refused rather than "left alone"')

# --- and wholly landward is left exactly as it was --------------------------------------------
inland = box(-79.60, 34.00, -79.58, 34.02)
kept, dropped, note = tsl.trim(inland, 'Nameless River', knives, index)
assert dropped is None and kept is inland, note
assert 'nothing to trim' in note, note
print('a water wholly landward is returned untouched, and says so')

# --- a name that is salt for its whole length is refused before any geometry runs -------------
kept, dropped, note = tsl.trim(box(-79.60, 34.00, -79.58, 34.02), 'Wando River', knives, index)
assert kept is None and 'entire length' in note, note
assert 'coastal pointer' in note, 'and it must say what it should be instead'
print('a statute-wide saltwater name is refused wherever its polygon happens to sit')

# --- the exception governs its river; US-17 does not ------------------------------------------
# This box is landward of US-17 and straddles the Cooper's own line, so cutting it at the
# highway would find nothing and cutting it at the exception splits it. Which knife was used is
# the whole difference between the lower Cooper being salt and being fresh.
cooper = box(-79.54, 33.55, -79.46, 33.65)
kept, dropped, note = tsl.trim(cooper, 'Cooper River', knives, index)
assert 'cut at Cooper River' in note, 'the exception is the boundary for its own river: %r' % note
kept2, dropped2, note2 = tsl.trim(cooper, 'Nameless River', knives, index)
assert 'Cooper River' not in note2, 'and it governs only its own river: %r' % note2
print('an exception line cuts its own river, and only its own river')

# --- area_acres is rewritten from the trimmed ring, never carried ------------------------------
src = (HERE / 'trim_at_salt_line.py').read_text(encoding='utf-8')
assert "props['area_acres'] = round(after, 1)" in src, \
    "the area that travels with the polygon has to be the trimmed polygon's"
assert src.index("props['area_acres']") < src.index("json.dump(doc"), 'and before it is written'
print('area_acres is recomputed from what was kept, not carried off the untrimmed polygon')

# --- a sub-acre sliver at the cut is not a reason to rewrite a boundary ------------------------
assert 'if d_ac < 1.0:' in src, 'splitting a big river with a big line leaves crumbs'
assert src.index('if d_ac < 1.0:') < src.index("dest = os.path.join"), \
    'and the floor has to come before the write, or it writes anyway'
print('a sub-acre sliver at the cut leaves the boundary alone')
