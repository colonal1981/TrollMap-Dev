#!/usr/bin/env python3
"""A retired slug must not outbid the keeper it was merged into.

Personal use only, not for distribution or resale; not for navigation.

THE CASE. This script awards each ramp to the SMALLEST claimant, which is right -- a
reservoir's bounding box swallows every farm pond near it and the pond is the more specific
answer. But a MERGE retires the near-duplicate of a lake, so the retired boundary is nearly
the keeper's shape and is often a hair smaller. It wins, and the ramps land on a slug the
index does not offer. Measured on 2026-08-19: brinkley_lake took 17 and falls_lake, which
ships, came out with none.
"""
import importlib.util, json, os, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location('mor', HERE / 'make_osm_ramps_by_lake.py')
mor = importlib.util.module_from_spec(spec); spec.loader.exec_module(mor)

root = Path(tempfile.mkdtemp())
bdir = root / 'boundaries'; bdir.mkdir()

def poly(slug, w, s, e, n):
    (bdir / (slug + '.geojson')).write_text(json.dumps({
        'type': 'FeatureCollection', 'features': [{'type': 'Feature', 'properties': {},
        'geometry': {'type': 'Polygon',
                     'coordinates': [[[w, s], [e, s], [e, n], [w, n], [w, s]]]}}]}))

# the keeper, and the retired near-duplicate that is a hair smaller
poly('falls_lake',    -78.80, 35.90, -78.60, 36.05)
poly('brinkley_lake', -78.79, 35.91, -78.61, 36.04)

boxes = mor.load_boxes(str(bdir))
assert set(boxes) == {'falls_lake', 'brinkley_lake'}, boxes
assert boxes['brinkley_lake'][4] < boxes['falls_lake'][4], \
    'the retired one has to be the smaller for this test to be testing anything'

boxes = mor.load_boxes(str(bdir), skip={'brinkley_lake'})
assert set(boxes) == {'falls_lake'}, 'a retired slug is not a claimant: %r' % list(boxes)
print('load_boxes skips the slugs it is told to skip, and the retired one really was smaller')

# --- the retired list comes from the deletion tab, through the uploader ---------------------
(root / '_deletion_tab.json').write_text(json.dumps({'retired': [
    {'slug': 'brinkley_lake', 'merged_into': 'falls_lake'},
    {'slug': 'wilson_dam', 'merged_into': 'santee_river'},
]}))
gone, note = mor.retired_of(str(root))
if note:
    # upload_garmin_to_r2 imports r2_gzip; if that sibling is absent this cannot resolve, and
    # the point of the test is then that it SAYS SO rather than silently filtering nothing.
    assert 'NOT being filtered' in note, note
    assert gone == set(), 'an unreadable list must not pretend to be an empty one silently'
    print('the retired list could not be read here, and the run says so out loud:')
    print('   %s' % note)
else:
    assert gone == {'brinkley_lake', 'wilson_dam'}, gone
    print('the retired list is read through upload_garmin_to_r2.retired_slugs, not restated')

# --- and main() actually passes it in --------------------------------------------------------
src = (HERE / 'make_osm_ramps_by_lake.py').read_text(encoding='utf-8')
assert 'load_boxes(bdir, skip=gone)' in src, \
    'reading the retired list and not passing it to load_boxes is the same as not reading it'
assert src.index('retired_of(a.registry)') < src.index('load_boxes(bdir, skip=gone)'), \
    'and it has to be read before the boxes are built'
assert 'gone_note' in src and "print('!! %s' % gone_note)" in src, \
    'a list that could not be read is worth saying out loud -- silence looks like zero retired'
print('main() reads the list, passes it to load_boxes, and prints the note when it cannot')
