import importlib.util, sys, json, tempfile, io, contextlib
from pathlib import Path
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('mms', HERE/'migrate_merged_slugs.py')
mms = importlib.util.module_from_spec(spec); spec.loader.exec_module(mms)
def eq(g,w,m): assert g==w, f'{m}: got {g!r} want {w!r}'

# --- skip(): history and already-merged files must be left alone
for n in ('lake_index.json','_merge_decisions.json','_deletion_tab.json','lake_index.json.bak',
          '_lake_index_before_2026-08-08.json','_lakes_before_split_2026-08-09.json'):
    assert mms.skip(n), f'{n} must be skipped'
for n in ('lake_access.json','water_bindings.json','charted.json','key_map.json'):
    assert not mms.skip(n), f'{n} must NOT be skipped'

# --- rename vs collide, the two real shapes
pairs={'brinkley_lake':'falls_lake'}
acts=[]
only_retired={'brinkley_lake':{'ramps':3}}                       # lake_access.json shape
mms.migrate_obj(only_retired,pairs,'<top>',acts)
eq(only_retired,{'falls_lake':{'ramps':3}},'RENAME when the keeper is absent')
eq(acts[0]['action'],'renamed onto the keeper','and it is reported as a rename')
assert acts[0]['dropped'] is None

acts=[]
both={'falls_lake':{'gauge':'A'},'brinkley_lake':{'gauge':'B','extra':1}}   # water_bindings shape
mms.migrate_obj(both,pairs,'bindings',acts)
eq(both,{'falls_lake':{'gauge':'A'}},'COLLISION keeps the keeper')
assert not acts[0]['covered'], 'a retired entry with an extra key LOSES something'
eq(acts[0]['extra'],['extra'],'and names exactly which key')

# 55 of 56 real collisions carried nothing new. Those must be QUIET, or the one that
# mattered -- charted.json oversized_lines_dropped -- stays buried in the noise.
acts=[]
same={'falls_lake':{'g':1},'brinkley_lake':{'g':2}}
mms.migrate_obj(same,pairs,'bindings',acts)
assert acts[0]['covered'], 'same keys, differing values: the keeper covers it'
eq(same,{'falls_lake':{'g':1}},'keeper kept')
acts=[]
ident={'falls_lake':{'g':1},'brinkley_lake':{'g':1}}
mms.migrate_obj(ident,pairs,'bindings',acts)
assert acts[0]['covered'], 'identical entries are a non-event'

# --fold copies across only what the keeper lacks or holds empty
acts=[]
f1={'falls_lake':{'g':1,'blank':None},'brinkley_lake':{'g':9,'extra':7,'blank':'x'}}
mms.migrate_obj(f1,pairs,'bindings',acts,fold=True)
eq(f1['falls_lake'],{'g':1,'blank':'x','extra':7},
   'fold adds the missing key and fills the empty one, but does NOT overwrite g')
assert acts[0]['folded'] is True

# --- one level of nesting, which is where lakes.* / by_lake.* / slug_to_r2_key.* live
acts=[]
nested={'lakes':{'brinkley_lake':1},'by_lake':{'brinkley_lake':2},'note':'x','n':5}
mms.walk(nested,pairs,acts)
eq(nested['lakes'],{'falls_lake':1},'nested rename')
eq(nested['by_lake'],{'falls_lake':2},'second nested key too')
eq(len(acts),2,'both reported')
eq(nested['note'],'x','untouched scalars survive')

# --- end to end
with tempfile.TemporaryDirectory() as t:
    root=Path(t); (root/'registry').mkdir()
    (root/'registry'/'lake_index.json').write_text(json.dumps({'falls_lake':{}}))
    (root/'registry'/'lake_access.json').write_text(json.dumps({'brinkley_lake':{'a':1}}))
    (root/'registry'/'water_bindings.json').write_text(json.dumps(
        {'_note':'x','bindings':{'falls_lake':{'g':1},'brinkley_lake':{'g':2}}}))
    (root/'registry'/'water_chain.json').write_text(json.dumps({'waters':{'brinkley_lake':{}}}))
    (root/'registry'/'_lake_index_before_2026-08-08.json').write_text(
        json.dumps({'brinkley_lake':{'history':True}}))
    dp=root/'dec.json'
    dp.write_text(json.dumps({'merges':[{'keep':'falls_lake','retire':'brinkley_lake'}]}))

    def run(extra=()):
        sys.argv=['x','--registry',str(root/'registry'/'lake_index.json'),'--decisions',str(dp),*extra]
        buf=io.StringIO()
        with contextlib.redirect_stdout(buf): rc=mms.main()
        return rc, buf.getvalue()

    rc,text = run()
    eq(rc,0,'runs clean')
    assert 'DRY RUN' in text
    eq(json.loads((root/'registry'/'lake_access.json').read_text()),{'brinkley_lake':{'a':1}},
       'A DRY RUN MUST CHANGE NOTHING')
    assert 'water_chain.json' in text and 'skipping' in text, 'derived files skipped by default'

    rc,text = run(('--write',))
    acc=json.loads((root/'registry'/'lake_access.json').read_text())
    eq(acc,{'falls_lake':{'a':1}},'THE ORPHANED ACCESS DATA IS CARRIED TO THE KEEPER')
    wb=json.loads((root/'registry'/'water_bindings.json').read_text())
    eq(wb['bindings'],{'falls_lake':{'g':1}},'collision kept the keeper')
    eq(wb['_note'],'x','sibling keys untouched')
    assert "'g'" in text or 'g' in text, 'the dropped binding was reported'
    hist=json.loads((root/'registry'/'_lake_index_before_2026-08-08.json').read_text())
    eq(hist,{'brinkley_lake':{'history':True}},'HISTORY MUST KEEP SAYING WHAT IT SAID')
    chain=json.loads((root/'registry'/'water_chain.json').read_text())
    eq(chain,{'waters':{'brinkley_lake':{}}},'derived file untouched without --include-derived')
    assert (root/'registry'/'lake_access.json.bak').exists(), 'a backup MUST be written'
    eq(json.loads((root/'registry'/'lake_access.json.bak').read_text()),{'brinkley_lake':{'a':1}},
       'the backup is the original')
    eq(json.loads((root/'registry'/'lake_index.json').read_text()),{'falls_lake':{}},
       'lake_index.json is never touched by this tool')

    rc,text = run(('--write','--include-derived'))
    chain=json.loads((root/'registry'/'water_chain.json').read_text())
    eq(chain,{'waters':{'falls_lake':{}}},'--include-derived does patch it')
print('ALL migrate_merged_slugs assertions pass')


# ============================================================================================
# A LIST IS A COLLECTION, NOT A CHOICE.
#
# The fold only ever compared dicts. When keeper and retiree both held LISTS, nothing was
# carried across, `covered` came out False, and the retiree was deleted with its contents
# printed as DROPPED -- while the action line said "folded into the keeper".
#
# On 2026-08-17 that lost Rembert C. Dennis Landing: wadboo_creek folded into cooper_river,
# the keeper already had a ramp list, so the retiree's list of one went in the bin. The same
# message had appeared earlier the same evening over a duplicate GMP tile, where it was
# harmless, which is why nobody questioned it the second time.
# ============================================================================================
_RAMP_A = {'name': 'William Dennis', 'lat': 33.213112, 'lon': -79.973469, 'type': 'Boat Ramp'}
_RAMP_B = {'name': 'Rembert C Dennis', 'lat': 33.196018, 'lon': -79.953051, 'type': 'Boat Ramp'}

_pairs = {'wadboo_creek': 'cooper_river'}   # retired -> keeper, as migrate_obj expects

# --- both sides hold lists: the retiree's entries are APPENDED --------------------------------
_obj = {'cooper_river': [_RAMP_A], 'wadboo_creek': [_RAMP_B]}
_acts = []
mms.migrate_obj(_obj, _pairs, '<top>', _acts, fold=True)
assert 'wadboo_creek' not in _obj, 'the retired slug must still be removed'
_names = [r['name'] for r in _obj['cooper_river']]
assert _names == ['William Dennis', 'Rembert C Dennis'], _names
assert _acts[0]['appended'] == 1, _acts[0]
assert _acts[0]['folded'] is True, _acts[0]
print('two ramp lists merge into one:', _names)

# --- a duplicate is not appended twice ---------------------------------------------------------
_obj = {'cooper_river': [_RAMP_A, _RAMP_B], 'wadboo_creek': [_RAMP_B]}
_acts = []
mms.migrate_obj(_obj, _pairs, '<top>', _acts, fold=True)
assert len(_obj['cooper_river']) == 2, _obj['cooper_river']
assert _acts[0]['covered'] is True, 'nothing new -- must report as covered, not as a drop'
assert _acts[0]['appended'] == 0
print('an entry the keeper already has is not duplicated')

# --- the harmless case that hid this: a list of plain strings, fully duplicated ---------------
_obj = {'cooper_river': ['B4E0FC', 'B4E0F9'], 'wadboo_creek': ['B4E0FC']}
_acts = []
mms.migrate_obj(_obj, _pairs, '<top>', _acts, fold=True)
assert _obj['cooper_river'] == ['B4E0FC', 'B4E0F9'], _obj['cooper_river']
assert _acts[0]['covered'] is True, 'a duplicate tile really is nothing new'
print('the duplicate-tile case still reports as covered')

# --- a string list with something new DOES carry ----------------------------------------------
_obj = {'cooper_river': ['B4E0FC'], 'wadboo_creek': ['B4E0FC', 'B4E0F6']}
_acts = []
mms.migrate_obj(_obj, _pairs, '<top>', _acts, fold=True)
assert _obj['cooper_river'] == ['B4E0FC', 'B4E0F6'], _obj['cooper_river']
assert _acts[0]['appended'] == 1
print('a tile the keeper lacks is carried across')

# --- WITHOUT --fold nothing is appended, and it must say so rather than claiming success -------
_obj = {'cooper_river': [_RAMP_A], 'wadboo_creek': [_RAMP_B]}
_acts = []
mms.migrate_obj(_obj, _pairs, '<top>', _acts, fold=False)
assert _obj['cooper_river'] == [_RAMP_A], 'no fold means no append'
assert _acts[0]['folded'] is False and _acts[0]['covered'] is False
assert 'DROPPED' in _acts[0]['action'], _acts[0]['action']
print('without --fold it is still a drop, and still says so')

# --- dict folding, which already worked, must be unchanged -------------------------------------
_obj = {'cooper_river': {'usgs': None}, 'wadboo_creek': {'usgs': {'site': '02172002'}, 'x': 1}}
_acts = []
mms.migrate_obj(_obj, _pairs, '<top>', _acts, fold=True)
assert _obj['cooper_river'] == {'usgs': {'site': '02172002'}, 'x': 1}, _obj['cooper_river']
print('dict folding is unchanged')

print('\nlist-fold assertions pass')


# ============================================================================================
# A SLUG IS ALSO A VALUE.
#
# migrate_obj moves a record when the retired slug is a KEY. It cannot see a slug sitting in a
# list, in an `alias_of`, in slug_to_r2_key's value, or in the `slug` field of a record whose
# key it had already renamed. Measured across registry/ after the seven merges of 2026-08-17:
#
#     retired slugs left as KEYS      0
#     retired slugs left as VALUES   36   in 10 files, 4 of them published
#
# So the tool reported a complete migration and had done half of it. Every case below is a
# real one taken from that measurement.
# ============================================================================================
_P = {'tail_race_canal': 'cooper_river', 'wadboo_creek': 'cooper_river',
      'wilson_dam': 'santee_river', 'kings_mountain_reservoir': 'john_h_moss_lake'}

# --- names_retired sees both spellings; lakes.json writes lake_id as "slug:<slug>" ------------
eq(mms.names_retired('wadboo_creek', _P), ('wadboo_creek', 'cooper_river', False), 'bare slug')
eq(mms.names_retired('slug:wadboo_creek', _P), ('wadboo_creek', 'cooper_river', True),
   'the lake_id spelling')
eq(mms.names_retired('cooper_river', _P), None, 'a keeper is not a retired slug')
eq(mms.names_retired('wadboo_creek_2', _P), None, 'a prefix match is not a match')
eq(mms.names_retired(None, _P), None, 'none')
eq(mms.names_retired(7, _P), None, 'not a string')

# --- LIST ITEM: tile_lake_map by_tile. The keeper was already in ALL NINE real lists, so a
#     rename in place would have made a duplicate every single time.
_o = {'by_tile': {'B4E0FC': ['cooper_river', 'santee_river', 'tail_race_canal', 'wadboo_creek']}}
_h = []
mms.retarget(_o, _P, _h, rewrite=True)
eq(_o['by_tile']['B4E0FC'], ['cooper_river', 'santee_river'],
   'BOTH retired tiles drop -- the keeper was already there')
eq(len(_h), 2, 'and both are reported')
assert all(h['kind'] == 'list-item' for h in _h), _h
assert all('dropped' in h['why'] for h in _h), _h

# the same list WITHOUT the keeper: rename the first, drop the second, never two keepers
_o = {'t': ['tail_race_canal', 'wadboo_creek', 'lake_moultrie']}
_h = []
mms.retarget(_o, _P, _h, rewrite=True)
eq(_o['t'], ['cooper_river', 'lake_moultrie'],
   'two retired slugs folding to one keeper must not produce it twice')

# a dry run must leave the list exactly as it found it
_o = {'t': ['cooper_river', 'wadboo_creek']}
_h = []
mms.retarget(_o, _P, _h, rewrite=False)
eq(_o['t'], ['cooper_river', 'wadboo_creek'], 'A DRY RUN MUST CHANGE NOTHING')
eq(len(_h), 1, 'but it still reports what it would do')
assert _h[0]['wrote'] is False

# --- FIELD: key_map slug_to_r2_key. 1,547 of 1,551 entries are the identity map; the four
#     exceptions are the four merges, each keeper pointing at the R2 key it retired.
_o = {'slug_to_r2_key': {'john_h_moss_lake': 'kings_mountain_reservoir',
                         'norris_lake': 'norris_lake'}}
_h = []
mms.retarget(_o, _P, _h, rewrite=True)
eq(_o['slug_to_r2_key']['john_h_moss_lake'], 'john_h_moss_lake',
   'the keeper must serve its OWN pack, or it goes dark the day the retired key is deleted')
eq(_o['slug_to_r2_key']['norris_lake'], 'norris_lake', 'untouched neighbours stay untouched')
eq(len(_h), 1, 'one hit')

# _river_aliases: biggin_creek pointed at wadboo_creek, which stopped existing that evening
_o = {'biggin_creek': {'alias_of': 'wadboo_creek', 'name': 'Biggin Creek'}}
_h = []
mms.retarget(_o, _P, _h, rewrite=True)
eq(_o['biggin_creek']['alias_of'], 'cooper_river', 'an alias must point at a water that exists')

# --- IDENTITY under a keeper KEY: water_bindings.json. migrate_obj renamed the key and left
#     the field. Read the field that travels with the value.
_o = {'bindings': {'cooper_river': {'slug': 'tail_race_canal', 'usgs': '02172002'}}}
_h = []
mms.retarget(_o, _P, _h, rewrite=True)
eq(_o['bindings']['cooper_river']['slug'], 'cooper_river',
   "a record's own slug field must agree with the key it is filed under")
eq(_h[0]['kind'], 'identity', 'reported as an identity, not as a reference')

# --- IDENTITY under some OTHER key is not the tool's to change ---------------------------------
_o = {'notes': {'why_it_went': {'slug': 'wadboo_creek'}}}
_h = []
mms.retarget(_o, _P, _h, rewrite=True)
eq(_o['notes']['why_it_went']['slug'], 'wadboo_creek', 'not rewritten -- the key is not the keeper')
assert _h[0]['wrote'] is False and 'not the keeper' in _h[0]['why'], _h[0]

# --- ZOMBIE ROW: lakes.json holds a full record for cooper_river AND for both slugs it
#     absorbed. Rewriting the slug field would leave three records claiming one slug.
_o = {'lakes': [
    {'slug': 'cooper_river', 'lake_id': 'slug:cooper_river', 'name': 'Cooper River'},
    {'slug': 'tail_race_canal', 'lake_id': 'slug:tail_race_canal', 'name': 'Tail Race Canal'},
    {'slug': 'wadboo_creek', 'lake_id': 'slug:wadboo_creek', 'name': 'Wadboo Creek'}]}
_h = []
mms.retarget(_o, _P, _h, rewrite=True)
eq(len(_o['lakes']), 3, 'NOTHING IS DELETED HERE -- deleting is a separate, later decision')
eq(_o['lakes'][1]['slug'], 'tail_race_canal', 'and nothing is rewritten into a duplicate')
eq([h['kind'] for h in _h], ['zombie-row', 'zombie-row'], 'both reported for the deletion tab')
assert all(h['wrote'] is False for h in _h)

# a lone retired record with NO keeper beside it is a plain rename, not a zombie
_o = {'lakes': [{'slug': 'wilson_dam', 'lake_id': 'slug:wilson_dam', 'name': 'Wilson Dam'}]}
_h = []
mms.retarget(_o, _P, _h, rewrite=True)
eq(_o['lakes'][0]['slug'], 'santee_river', 'no keeper in the list -- carry the record over')
eq(_o['lakes'][0]['lake_id'], 'slug:santee_river', 'the prefixed id travels with it')

# --- LEAVE_ALONE: _r2_listing.json is what the BUCKET holds. Rewriting it would hide the retired
#     objects from prune_r2_keys.py, the one tool that would have deleted them.
import io as _io, contextlib as _ctx, tempfile as _tf
with _tf.TemporaryDirectory() as _t:
    _r = Path(_t); (_r/'registry').mkdir()
    (_r/'registry'/'lake_index.json').write_text(json.dumps({'cooper_river': {}}))
    (_r/'registry'/'_r2_listing.json').write_text(json.dumps(
        {'chartpacks': ['cooper_river', 'wadboo_creek'], 'count': 2}))
    (_r/'registry'/'tile_lake_map.json').write_text(json.dumps(
        {'by_tile': {'B4E0FC': ['cooper_river', 'wadboo_creek']}}))
    (_r/'registry'/'key_map.json').write_text(json.dumps(
        {'slug_to_r2_key': {'cooper_river': 'wadboo_creek'}}))
    _d = _r/'dec.json'
    _d.write_text(json.dumps({'merges': [{'keep': 'cooper_river', 'retire': 'wadboo_creek'}]}))

    def _run(extra=()):
        sys.argv = ['x', '--registry', str(_r/'registry'/'lake_index.json'),
                    '--decisions', str(_d), *extra]
        b = _io.StringIO()
        with _ctx.redirect_stdout(b):
            rc = mms.main()
        return rc, b.getvalue()

    rc, txt = _run()
    assert 'KEYS only' in txt, 'without --values it must SAY it only looked at keys'
    eq(json.loads((_r/'registry'/'tile_lake_map.json').read_text())['by_tile']['B4E0FC'],
       ['cooper_river', 'wadboo_creek'], 'and it must not have touched a value')

    rc, txt = _run(('--values',))
    eq(rc, 0, 'dry run with --values is clean')
    assert 'DRY RUN' in txt
    eq(json.loads((_r/'registry'/'key_map.json').read_text())['slug_to_r2_key']['cooper_river'],
       'wadboo_creek', 'A DRY RUN MUST CHANGE NOTHING, values included')

    rc, txt = _run(('--values', '--write'))
    eq(json.loads((_r/'registry'/'tile_lake_map.json').read_text())['by_tile']['B4E0FC'],
       ['cooper_river'], 'the duplicate tile reference is gone')
    eq(json.loads((_r/'registry'/'key_map.json').read_text())['slug_to_r2_key']['cooper_river'],
       'cooper_river', 'the keeper now serves its own pack')
    eq(json.loads((_r/'registry'/'_r2_listing.json').read_text())['chartpacks'],
       ['cooper_river', 'wadboo_creek'],
       'THE BUCKET LISTING IS AN OBSERVATION -- it still holds what it holds')
    assert 'records what the R2 bucket actually holds' in txt, 'and it says why it left it'
    assert not (_r/'registry'/'_r2_listing.json.bak').exists(), \
        'a file nothing was written to gets no .bak'

print('\nslug-value assertions pass')

# a dry run must report each path ONCE. The rename branch settles the identity fields and then
# recurses for the rest of the record; without skipping them the same path came back twice,
# because on a dry run nothing was written to stop the second look.
_o = {'lakes': [{'slug': 'wilson_dam', 'lake_id': 'slug:wilson_dam', 'ref': 'wilson_dam'}]}
_h = []
mms.retarget(_o, _P, _h, rewrite=False)
_paths = [h['path'] for h in _h]
eq(len(_paths), len(set(_paths)), 'no path may be reported twice: %r' % (_paths,))
eq(sorted(_paths), ['/lakes[0]/lake_id', '/lakes[0]/ref', '/lakes[0]/slug'],
   'and a plain reference elsewhere in the record is still seen')
eq(_o['lakes'][0]['slug'], 'wilson_dam', 'dry run wrote nothing')

_o = {'lakes': [{'slug': 'wilson_dam', 'lake_id': 'slug:wilson_dam', 'ref': 'wilson_dam'}]}
_h = []
mms.retarget(_o, _P, _h, rewrite=True)
eq(_o['lakes'][0], {'slug': 'santee_river', 'lake_id': 'slug:santee_river', 'ref': 'santee_river'},
   'and on a write all three land')
print('no double-reporting on a dry run')

# A DRY RUN MUST PREDICT THE WRITE. _water_bindings.json holds tail_race_canal AND wadboo_creek
# in curated_usgs_no_longer_read and both fold to cooper_river: the write does one rename and
# one drop. Tracking "what the list will hold" in `keep` -- which on a dry run still carries the
# old spelling -- reported two renames, so the preview disagreed with the result.
for _rw in (False, True):
    _o = {'l': ['tail_race_canal', 'wadboo_creek', 'lake_moultrie']}
    _h = []
    mms.retarget(_o, _P, _h, rewrite=_rw)
    _why = [h['why'] for h in _h if h['kind'] == 'list-item']
    eq(len(_why), 2, 'both are reported either way')
    assert 'renamed' in _why[0] and 'dropped' in _why[1], (_rw, _why)
eq(_o['l'], ['cooper_river', 'lake_moultrie'], 'and the write does exactly what it said')
print('the dry run predicts the write when two retired slugs share a keeper')

# An empty search is not an answer. `--registry registry` from the repo root resolved to
# registry/registry, glob returned nothing, and it printed "0 file(s) affected" -- which reads
# as a clean bill of health for a directory it never opened.
with _tf.TemporaryDirectory() as _t:
    _r = Path(_t); (_r/'registry').mkdir()
    (_r/'registry'/'lake_index.json').write_text(json.dumps({'falls_lake': {}}))
    _d = _r/'dec.json'
    _d.write_text(json.dumps({'merges': [{'keep': 'falls_lake', 'retire': 'brinkley_lake'}]}))
    sys.argv = ['x', '--registry', str(_r/'registry'), '--decisions', str(_d)]
    _b = _io.StringIO()
    try:
        with _ctx.redirect_stdout(_b):
            mms.main()
        raise AssertionError('a registry directory that does not exist must not return 0')
    except SystemExit as e:
        assert 'no registry directory at' in str(e), e
print('a registry path that resolves to nothing fails loudly')

# `wrote` is False for EVERY hit on a dry run, so a summary counting it answered "nothing was
# written" -- true, and not the question anyone is asking of a preview. `writable` is what a
# --write would actually do, and it must not depend on whether this run is one.
for _rw in (False, True):
    _o = {'by_tile': {'t': ['cooper_river', 'wadboo_creek']},
          'lakes': [{'slug': 'cooper_river'}, {'slug': 'wadboo_creek'}],
          'notes': {'somewhere_else': {'slug': 'wadboo_creek'}}}
    _h = []
    mms.retarget(_o, _P, _h, rewrite=_rw)
    _w = sorted((h['kind'], h['writable']) for h in _h)
    eq(_w, [('identity', False), ('list-item', True), ('zombie-row', False)],
       'writable must be the same on a dry run as on a write: %r' % (_w,))
    assert all(h['wrote'] == (_rw and h['writable']) for h in _h), [h for h in _h]
print('writable says what --write would do; wrote says what this run did')

# The closing count must be files WRITTEN, not files that had a hit. On the real registry those
# differ by three -- the OBSERVED files are reported and left alone -- and the old line claimed
# nine written on the same run whose report said three were left alone.
with _tf.TemporaryDirectory() as _t:
    _r = Path(_t); (_r/'registry').mkdir()
    (_r/'registry'/'lake_index.json').write_text(json.dumps({'cooper_river': {}}))
    (_r/'registry'/'_r2_listing.json').write_text(json.dumps({'chartpacks': ['wadboo_creek']}))
    (_r/'registry'/'tile_lake_map.json').write_text(
        json.dumps({'by_tile': {'T': ['wadboo_creek']}}))
    _d = _r/'dec.json'
    _d.write_text(json.dumps({'merges': [{'keep': 'cooper_river', 'retire': 'wadboo_creek'}]}))
    sys.argv = ['x', '--registry', str(_r/'registry'/'lake_index.json'), '--decisions', str(_d),
                '--values', '--write']
    _b = _io.StringIO()
    with _ctx.redirect_stdout(_b):
        mms.main()
    _txt = _b.getvalue()
    assert 'wrote 1 file(s)' in _txt, _txt[-400:]
    assert '1 more had a slug value that was reported and not rewritten' in _txt, _txt[-400:]
    assert not (_r/'registry'/'_r2_listing.json.bak').exists(), 'and it really has no .bak'
print('the closing count is files written, not files looked at')

# ============================================================================================
# lakes.json IS NOT AN ORDINARY SIDECAR.
#
# consolidate_lake_index.py:drop_retired() says it out loud: lakes.json is the record of what
# EXISTS and a merge is a statement about what the app OFFERS. That is why consolidate carries
# a gate to keep merged slugs OUT of the index it builds FROM lakes.json, rather than editing
# lakes.json -- and why merge_duplicate_waters.py and this tool both leave it alone.
#
# On 2026-08-18 --values rewrote its by_state lists anyway. Seven records were left in lakes[]
# belonging to no state list at all: the inventory disagreeing with its own index. Restored
# from the .bak the same run wrote.
# ============================================================================================
assert 'lakes.json' in mms.LEAVE_ALONE, 'lakes.json must never be rewritten by this tool'
for _f in ('_r2_listing.json', '_registry_state.json', '_water_bindings_review.json'):
    assert _f in mms.LEAVE_ALONE, _f
assert 'tile_lake_map.json' not in mms.LEAVE_ALONE, \
    'tile_lake_map IS migrated -- check_registry_invariants REACHABLE reads it'

with _tf.TemporaryDirectory() as _t:
    _r = Path(_t); (_r/'registry').mkdir()
    (_r/'registry'/'lake_index.json').write_text(json.dumps({'cooper_river': {}}))
    _inv = {'by_state': {'SC': ['cooper_river', 'wadboo_creek']},
            'lakes': [{'slug': 'cooper_river'}, {'slug': 'wadboo_creek'}]}
    (_r/'registry'/'lakes.json').write_text(json.dumps(_inv))
    _d = _r/'dec.json'
    _d.write_text(json.dumps({'merges': [{'keep': 'cooper_river', 'retire': 'wadboo_creek'}]}))
    sys.argv = ['x', '--registry', str(_r/'registry'/'lake_index.json'), '--decisions', str(_d),
                '--values', '--write']
    _b = _io.StringIO()
    with _ctx.redirect_stdout(_b):
        mms.main()
    _txt = _b.getvalue()
    eq(json.loads((_r/'registry'/'lakes.json').read_text()), _inv,
       'lakes.json must come out of a --write byte-for-byte unchanged')
    assert not (_r/'registry'/'lakes.json.bak').exists(), 'and get no .bak, because nothing wrote'
    assert 'inventory of what EXISTS' in _txt, 'and the report must say why'
    assert 'ZOMBIE ROWS' not in _txt, \
        'its rows are not deletion-tab material -- consolidate gates them already'
print('lakes.json is reported and never rewritten')


# ============================================================================================
# THE THIRD NAMESPACE: A BOUNDARY IS A FILE.
#
# migrate_obj moves a KEY. retarget() repoints a VALUE. registry/boundaries/<slug>.geojson is
# neither, and this tool never opened that directory -- so the merge moved falls_lake's name
# and left it tracing 9,529.6 acres while brinkley_lake, the slug it retired, held 12,958:
# the 3DHP body INLB3 at 11,983.6 plus arm LJFWM at 975, whose bounding box sits ENTIRELY
# inside the main body's.
#
# ADOPTED ONLY ON CONTAINMENT, NEVER ON SIZE. A bigger polygon can be bigger because it is
# wrong. brinkley holds 99.84% of falls_lake: adopting discards 0.16% and gains 36%.
# ============================================================================================
try:
    import shapely  # noqa: F401
    _HAVE_SHAPELY = True
except ImportError:
    _HAVE_SHAPELY = False


def _box(w, s_, e, n):
    return {'type': 'FeatureCollection', 'features': [{'type': 'Feature', 'properties': {},
            'geometry': {'type': 'Polygon', 'coordinates': [[[w, s_], [e, s_], [e, n],
                                                             [w, n], [w, s_]]]}}]}


if _HAVE_SHAPELY:
    with _tf.TemporaryDirectory() as _t:
        _r = Path(_t); (_r / 'boundaries').mkdir(parents=True)
        B = _r / 'boundaries'
        # the falls_lake shape: the retiree contains the keeper and adds a third again
        (B / 'keeper.geojson').write_text(json.dumps(_box(0.0, 0.0, 1.0, 1.0)))
        (B / 'retiree.geojson').write_text(json.dumps(_box(0.0, 0.0, 1.0, 1.4)))
        # two traces that DISAGREE about where the water is -- barely overlapping
        (B / 'k2.geojson').write_text(json.dumps(_box(0.0, 0.0, 1.0, 1.0)))
        (B / 'r2.geojson').write_text(json.dumps(_box(0.9, 0.0, 3.0, 1.0)))
        # a keeper already bigger than what it retired
        (B / 'k3.geojson').write_text(json.dumps(_box(0.0, 0.0, 2.0, 2.0)))
        (B / 'r3.geojson').write_text(json.dumps(_box(0.0, 0.0, 1.0, 1.0)))
        PAIRS = {'retiree': 'keeper', 'r2': 'k2', 'r3': 'k3'}

        res, note = mms.carry_boundaries(_r, PAIRS, 99.0, False)
        eq(note, None, 'shapely is here, so containment can be tested')
        by = {r['keeper']: r for r in res}
        assert 'k3' not in by, 'a keeper already bigger than its retiree is not a finding'
        eq(round(by['keeper']['cover'], 1), 100.0, 'the retiree contains the keeper entirely')
        eq(by['keeper']['adopted'], False, 'A DRY RUN MUST CHANGE NOTHING')
        eq(json.loads((B / 'keeper.geojson').read_text())['features'][0]['geometry'
           ]['coordinates'][0][2], [1.0, 1.0], 'and the file still has its old corner')
        assert by['k2']['cover'] < 99.0 and 're-tracing decision' in by['k2']['why'], by['k2']
        eq(by['k2']['adopted'], False, 'two traces that disagree are never adopted')

        res, note = mms.carry_boundaries(_r, PAIRS, 99.0, True)
        by = {r['keeper']: r for r in res}
        eq(by['keeper']['adopted'], True, 'the falls_lake case is adopted on a write')
        eq(by['k2']['adopted'], False, 'the disagreeing pair still is not')
        got = json.loads((B / 'keeper.geojson').read_text())['features'][0]
        eq(got['geometry']['coordinates'][0][2], [1.0, 1.4],
           'the keeper now holds the retiree geometry')
        eq(got['properties']['slug'], 'keeper', 'filed under the KEEPER slug, not the retiree')
        assert 'adopted from retiree.geojson' in got['properties']['source'], got['properties']
        assert (B / 'keeper.geojson.bak').exists(), 'a backup MUST be written'
        eq(json.loads((B / 'keeper.geojson.bak').read_text())['features'][0]['geometry'
           ]['coordinates'][0][2], [1.0, 1.0], 'and the backup is the original')
        eq(json.loads((B / 'k2.geojson').read_text())['features'][0]['geometry'
           ]['coordinates'][0][2], [1.0, 1.0], 'the refused one is untouched on disk')
    print('a boundary is carried only when the retiree all but contains the keeper')

with _tf.TemporaryDirectory() as _t:
    _r = Path(_t)
    res, note = mms.carry_boundaries(_r, {'a': 'b'}, 99.0, False)
    eq(res, [], 'no boundaries directory yields nothing')
    assert note and 'no boundaries directory' in note, 'and says why rather than passing quietly'
print('a missing boundaries directory is reported, not silently skipped')

# A SUMMARY MUST NOT CONTRADICT THE LINE ABOVE IT. With shapely absent the boundary pass cannot
# test containment and returns nothing -- and the report printed "nothing to carry: every keeper
# already traces at least as much water" directly under the warning saying it had not looked.
# Same shape as the closing count that claimed nine files written when six were.
with _tf.TemporaryDirectory() as _t:
    _r = Path(_t); (_r / 'registry' / 'boundaries').mkdir(parents=True)
    (_r / 'registry' / 'lake_index.json').write_text(json.dumps({'keeper': {}}))
    (_r / 'registry' / 'lake_access.json').write_text(json.dumps({'keeper': {}}))
    _d = _r / 'dec.json'
    _d.write_text(json.dumps({'merges': [{'keep': 'keeper', 'retire': 'retiree'}]}))
    _real = mms.carry_boundaries
    mms.carry_boundaries = lambda *a, **k: (
        [], 'shapely is absent, so containment cannot be tested')
    try:
        sys.argv = ['x', '--registry', str(_r / 'registry' / 'lake_index.json'),
                    '--decisions', str(_d), '--boundaries']
        _b = _io.StringIO()
        with _ctx.redirect_stdout(_b):
            mms.main()
        _t2 = _b.getvalue()
    finally:
        mms.carry_boundaries = _real
    assert 'shapely is absent' in _t2, _t2
    assert 'nothing to carry' not in _t2, \
        'a "we found nothing" line must not print under a "we could not look" warning'
print('a boundary pass that could not run does not also claim it found nothing')
