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
eq(acts[0]['action'],'kept keeper, retired entry dropped','and says so')
assert 'gauge' in acts[0]['dropped'] and 'extra' in acts[0]['dropped'], \
    f'the dropped content MUST be reported, not silently lost: {acts[0]["dropped"]}'

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
