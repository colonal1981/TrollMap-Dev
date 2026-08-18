#!/usr/bin/env python3
"""What ships in _registry/lakes.json, and what does not.

registry/lakes.json is the record of what EXISTS -- every water 3DHP knows about, including
the ones a merge folded into a keeper. consolidate_lake_index.py:drop_retired() spells out why
nothing edits it to say otherwise, and migrate_merged_slugs.py leaves it alone for the same
reason. What SHIPS is a different question, and slim_registry() published all 3,399 rows, so
the bucket carried a record for tail_race_canal beside the cooper_river that replaced it.

verify_registry_r2.py imports slim_registry() rather than restating it, so the filter has to be
computed from the same input on both sides or the checker reports the object stale forever
while the uploader keeps saying it just wrote it. That is what `retired` being required buys,
and it is the first thing asserted here.

Personal use only, not for distribution or resale; not for navigation.
"""
import importlib.util, inspect, json, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location('ug', HERE / 'upload_garmin_to_r2.py')
ug = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ug)


def eq(g, w, m):
    assert g == w, f'{m}: got {g!r} want {w!r}'


def row(slug, name=None):
    return {'slug': slug, 'lake_id': 'slug:' + slug, 'name': name or slug.replace('_', ' '),
            'area_km2': 1.0, 'bounds_wsen': [-80, 33, -79, 34], 'centroid': [-79.5, 33.5],
            'state': 'SC', 'parts': 1, 'feature_type': 'River'}


# --- the required argument is the whole no-drift guarantee ------------------------------------
_sig = inspect.signature(ug.slim_registry)
eq(list(_sig.parameters), ['full', 'retired'], 'slim_registry takes the retired set explicitly')
assert _sig.parameters['retired'].default is inspect.Parameter.empty, \
    'retired must be REQUIRED -- a caller that quietly passes nothing builds a different object'

# --- a retired slug does not ship, and everything else does -----------------------------------
FULL = {'count': 4, 'bbox_wsen': [-83, 32, -75, 36], 'generated_from': 'USGS 3DHP',
        'lakes': [row('cooper_river'), row('tail_race_canal'), row('wadboo_creek'),
                  row('coast_pamlico_sound_nc')]}
slim = ug.slim_registry(FULL, {'tail_race_canal', 'wadboo_creek'})
eq([r['slug'] for r in slim['lakes']], ['cooper_river', 'coast_pamlico_sound_nc'],
   'the two merged-away rows are held back')
eq(slim['count'], 2, 'count is the length of the list this object carries, not lakes.json\'s')
eq(slim['generated_from'], 'USGS 3DHP', 'provenance survives')
eq(slim['bbox_wsen'], [-83, 32, -75, 36], 'so does the bbox')
eq(set(slim['lakes'][0]), {'slug', 'lake_id', 'name', 'area_km2', 'bounds_wsen', 'centroid'},
   'and the projection is unchanged -- state, parts and feature_type still do not ship')

# OUT OF REGION IS NOT RETIRED. A water dropped as out of scope, or as unbuildable, still
# EXISTS -- this list is the inventory the DNR side queries by extent, and coast_pamlico_sound_nc
# is 1.8 million acres of real water that consolidate declined to OFFER. Only a merge cuts a row.
assert any(r['slug'] == 'coast_pamlico_sound_nc' for r in slim['lakes']), \
    'an out-of-region water still exists and must still ship in the inventory'

eq(len(ug.slim_registry(FULL, set())['lakes']), 4, 'an empty retired set changes nothing')
eq(len(ug.slim_registry(FULL, None)['lakes']), 4, 'and neither does None')

# --- retired_slugs reads the tab, and says so when it cannot ----------------------------------
with tempfile.TemporaryDirectory() as t:
    reg = Path(t)
    got, note = ug.retired_slugs(reg)
    eq(got, set(), 'no tab, no slugs')
    assert note and 'NOT being filtered' in note, \
        'a missing tab must be SAID -- silently skipping the filter is the failure it prevents'

    (reg / '_deletion_tab.json').write_text(json.dumps({'retired': [
        {'slug': 'tail_race_canal', 'merged_into': 'cooper_river'},
        {'slug': 'wadboo_creek', 'merged_into': 'cooper_river'},
        {'slug': 'wilson_dam', 'merged_into': 'santee_river'}]}), encoding='utf-8')
    got, note = ug.retired_slugs(reg)
    eq(got, {'tail_race_canal', 'wadboo_creek', 'wilson_dam'}, 'reads every retired slug')
    eq(note, None, 'and says nothing when there is nothing to say')

    (reg / '_deletion_tab.json').write_text('{not json', encoding='utf-8')
    got, note = ug.retired_slugs(reg)
    eq(got, set(), 'unreadable tab yields nothing')
    assert note and 'unreadable' in note, 'and says why'

    # A bare list of slugs, in case the tab is ever written that way.
    (reg / '_deletion_tab.json').write_text(json.dumps(['wilson_dam']), encoding='utf-8')
    eq(ug.retired_slugs(reg)[0], {'wilson_dam'}, 'a bare list works too')

# --- the checker computes the SAME object the uploader would ----------------------------------
# verify_registry_r2.py hashes its result against the served object. If the two sides disagree
# about the filter, lakes.json reads stale on every run and nothing is actually wrong.
with tempfile.TemporaryDirectory() as t:
    reg = Path(t)
    (reg / '_deletion_tab.json').write_text(json.dumps(
        {'retired': [{'slug': 'tail_race_canal'}]}), encoding='utf-8')
    up_side = ug.slim_registry(FULL, ug.retired_slugs(reg)[0])
    ck_side = ug.slim_registry(FULL, ug.retired_slugs(reg)[0])
    eq(json.dumps(up_side, sort_keys=True), json.dumps(ck_side, sort_keys=True),
       'uploader and checker must build the byte-identical projection')

print('ALL slim_registry assertions pass')
print('a retired slug does not ship; an out-of-region water still does')
