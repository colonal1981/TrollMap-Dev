#!/usr/bin/env python3
"""A coastal zone must not inherit a creek's access classification.

Personal use only, not for distribution or resale; not for navigation.

merge_duplicate_waters.py carries any field the keeper lacks across from the retiring water,
which is right for the case it was written for: one water under two slugs, where whichever row
happens to hold the access classification should win. It is wrong when the keeper is a REGION.
mosquito_creek is 'Restricted Access' and coast_santee_delta_sc had none, so the first dry run
proposed labelling the whole Santee Delta restricted on the strength of one 293-acre creek
inside it.
"""
import importlib.util, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('mdw', HERE / 'merge_duplicate_waters.py')
mdw = importlib.util.module_from_spec(spec); spec.loader.exec_module(mdw)

CREEK = {'slug': 'mosquito_creek', 'name': 'Mosquito Creek', 'display_name': 'Mosquito Creek, SC',
         'access': 'Restricted Access', 'access_for_me': 'Restricted Access',
         'access_via': 'Santee Coastal Reserve', 'area_acres': 292.8, 'charted': 0.9947,
         'ramps': {'osm': [{'name': 'a ramp'}]}, 'state': 'SC'}
ZONE  = {'slug': 'coast_santee_delta_sc', 'name': 'Santee Delta', 'area_acres': 328062.6,
         'charted': 0.11, 'state': 'SC'}

out, notes = mdw.merge_entry(ZONE, CREEK, 'coast_santee_delta_sc', 'mosquito_creek', None)
for f in ('access', 'access_for_me', 'access_via'):
    assert f not in out or not out[f], \
        '%s crossed onto the region: %r' % (f, out.get(f))
assert any('NOT taken' in n and 'region' in n for n in notes), \
    'and it has to SAY it declined, or the omission looks like the field was simply absent: %r' % notes
print('a coastal zone keeps its own access classification, and the run says it declined')

# the things that SHOULD cross still do
assert 'Mosquito Creek, SC' in out['legacy_display_names'], \
    'the retiring name has to stay searchable -- that is the point of the merge'
assert out['ramps'].get('osm'), 'a ramp on the creek really is a ramp in the zone'
assert out['area_acres'] == 328062.6 and out['charted'] == 0.11, \
    "the keeper's own polygon and measurement win"
print('names and ramps still cross, and the zone keeps its own acreage and charted fraction')

# and a lake keeper is untouched by this -- the original behaviour has to survive
LAKE_A = {'slug': 'john_h_moss_lake', 'name': 'John H Moss Lake', 'area_acres': 1500.0}
LAKE_B = {'slug': 'kings_mountain_reservoir', 'name': 'Kings Mountain Reservoir',
          'display_name': 'Kings Mountain Reservoir, NC', 'access': 'Open Access',
          'area_acres': 1500.1}
out2, notes2 = mdw.merge_entry(LAKE_A, LAKE_B, 'john_h_moss_lake',
                               'kings_mountain_reservoir', None)
assert out2.get('access') == 'Open Access', \
    'lake-to-lake carry is the behaviour this script exists for and must not change: %r' % out2
print('a lake keeper still inherits access from its duplicate, unchanged')

# --- and a region does not inherit the retiree's NHD identity either -------------------------
# Same argument as gnis, which this file has always decided per pair: the retiring slug's id
# names a different real feature. `bindings.get(keep) or bindings.get(retire)` fell through to
# the creek's binding because a coastal zone never has one of its own, so the first fixed dry
# run still proposed stamping 0304/87652103 -- Mosquito Creek -- onto the Santee Delta.
src = (HERE / 'merge_duplicate_waters.py').read_text(encoding='utf-8')
assert "b = bindings.get(keep) or bindings.get(retire)" not in src, \
    'the unconditional fall-through to the retiree binding is what stamped a creek on a region'
assert "if b is None and not keep.startswith('coast_'):" in src, \
    'a region must not fall through to the retiring water for its NHD identity'
assert "does not inherit a water" in src, \
    'and it has to say it declined, the same as the access fields do'
print('a region does not inherit the retiring water NHD identity, and says so')

# --- the retired name has to survive consolidate ---------------------------------------------
# merge_entry() puts it in the keeper's legacy_display_names in lake_index.json, and
# consolidate_lake_index.py rebuilds that index from lakes.json and throws it away. Measured
# after seven merges: six of the seven old names resolved to nothing. registry/
# lake_display_names.json is the file consolidate DOES read for extra names.
import json as _j, tempfile as _tf
from pathlib import Path as _P
_np = _P(_tf.mkdtemp()) / 'lake_display_names.json'
_np.write_text(_j.dumps({
    'reading_house_slough': 'Reelfoot Lake',                  # a bare string is a RENAME
    'cooper_river': {'also': ['Tail Race Canal']},            # already has one
}))
_tab = [
    {'slug': 'brinkley_lake',    'merged_into': 'falls_lake',   'display_name': 'Brinkley Lake, NC'},
    {'slug': 'tail_race_canal',  'merged_into': 'cooper_river', 'display_name': 'Tail Race Canal'},
    {'slug': 'wilson_dam',       'merged_into': 'reading_house_slough', 'display_name': 'Wilson Dam'},
    {'slug': 'no_name',          'merged_into': 'x',            'display_name': None},
]
added, note = mdw.sync_display_names(_np, _tab, write=True)
assert note is None, note
got = dict(added)
assert got.get('falls_lake') == 'Brinkley Lake, NC', added
assert 'cooper_river' not in got, 'a name already present must not be added twice: %r' % added
doc = _j.loads(_np.read_text())
assert doc['falls_lake']['also'] == ['Brinkley Lake, NC'], doc['falls_lake']
assert doc['cooper_river']['also'] == ['Tail Race Canal'], doc['cooper_river']
assert doc['reading_house_slough']['name'] == 'Reelfoot Lake', \
    'a bare string is a rename and must survive being grown an also list: %r' % doc['reading_house_slough']
assert doc['reading_house_slough']['also'] == ['Wilson Dam'], doc['reading_house_slough']
print('the retired name is written where consolidate reads it, and a rename survives beside it')

# a dry run must change nothing on disk
_np2 = _P(_tf.mkdtemp()) / 'lake_display_names.json'
_np2.write_text('{}')
added2, _ = mdw.sync_display_names(_np2, _tab, write=False)
assert added2 and _np2.read_text() == '{}', 'a dry run reports and writes nothing'
print('and a dry run reports the additions without writing them')

# an unreadable file says so rather than silently preserving nothing
_np3 = _P(_tf.mkdtemp()) / 'lake_display_names.json'
_np3.write_text('{ not json')
added3, note3 = mdw.sync_display_names(_np3, _tab, write=True)
assert added3 == [] and note3 and 'NOT being preserved' in note3, (added3, note3)
print('an unreadable names file is reported, not treated as empty')

# --- both forms, because nobody types the county ---------------------------------------------
# The tab records the display name consolidate built, and `also` reaches legacy_display_names
# verbatim. An alias for "Kings Mountain Reservoir (Cleveland Co, NC)" is an alias for a string
# no one will ever type.
_np4 = _P(_tf.mkdtemp()) / 'lake_display_names.json'
_np4.write_text('{}')
mdw.sync_display_names(_np4, [{'slug': 'kings_mountain_reservoir',
                               'merged_into': 'john_h_moss_lake',
                               'display_name': 'Kings Mountain Reservoir (Cleveland Co, NC)'}],
                       write=True)
_also = _j.loads(_np4.read_text())['john_h_moss_lake']['also']
assert 'Kings Mountain Reservoir (Cleveland Co, NC)' in _also, _also
assert 'Kings Mountain Reservoir' in _also, 'the bare name is the one a person types: %r' % _also

# a name with no parenthetical is stored once, not twice
_np5 = _P(_tf.mkdtemp()) / 'lake_display_names.json'
_np5.write_text('{}')
mdw.sync_display_names(_np5, [{'slug': 'x', 'merged_into': 'y', 'display_name': 'Wilson Dam'}],
                       write=True)
assert _j.loads(_np5.read_text())['y']['also'] == ['Wilson Dam'], 'no duplicate for a plain name'
print('both the county form and the bare name are stored, and a plain name only once')
