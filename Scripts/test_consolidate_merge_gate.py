"""consolidate_lake_index.py -- a merged-away slug must not come back.

WHY
    merge_duplicate_waters.py deletes the retired slug from lake_index.json.
    migrate_merged_slugs.py repairs the slug-keyed sidecars.
    NEITHER touches lakes.json, and consolidate rebuilds the index FROM lakes.json.

    So on 2026-08-17 the index came back at 455 rows carrying brinkley_lake, persimmon_lake,
    kings_mountain_reservoir, lake_lookout and wilson_dam -- all five slugs retired by merges
    Ryan had already reviewed and approved. Every merge on this project has been undone by the
    next consolidate since the merge tool was written.

    The gate reads registry/_deletion_tab.json, which merge_duplicate_waters.py writes, so
    there is exactly one record of the decision.
"""
import importlib.util, json, os, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('cli', HERE / 'consolidate_lake_index.py')
cli = importlib.util.module_from_spec(spec)
sys.modules['cli'] = cli
spec.loader.exec_module(cli)

REAL = {'slug': 'wilson_dam', 'merged_into': 'santee_river', 'pack_mb': 0.07, 'shipped': True}


def idx_of(*slugs):
    return {s: {'name': s.replace('_', ' ').title(), 'state': 'SC'} for s in slugs}


with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as td:
    # --- the real case, verbatim from the 2026-08-17 tab -------------------------------------
    json.dump({'retired': [
        {'slug': 'kings_mountain_reservoir', 'merged_into': 'john_h_moss_lake'},
        {'slug': 'lake_lookout', 'merged_into': 'lookout_shoals_lake'},
        {'slug': 'brinkley_lake', 'merged_into': 'falls_lake'},
        {'slug': 'persimmon_lake', 'merged_into': 'hiwassee_lake'},
        REAL,
    ]}, open(os.path.join(td, '_deletion_tab.json'), 'w'))

    idx = idx_of('lake_marion', 'cooper_river', 'kings_mountain_reservoir', 'lake_lookout',
                 'brinkley_lake', 'persimmon_lake', 'wilson_dam')
    removed, why = cli.drop_retired(idx, td)
    assert why is None, why
    assert len(removed) == 5, removed
    assert set(idx) == {'lake_marion', 'cooper_river'}, idx
    assert {r['slug'] for r in removed} == {'kings_mountain_reservoir', 'lake_lookout',
                                            'brinkley_lake', 'persimmon_lake', 'wilson_dam'}
    assert all(r['merged_into'] for r in removed), 'the keeper must be reported, not just the slug'
    print('the five that came back are removed; the keepers stay:', sorted(idx))

    # --- a keeper that shares a name with nothing must survive, and running twice is safe -----
    removed2, why2 = cli.drop_retired(idx, td)
    assert removed2 == [] and why2 is None, (removed2, why2)
    assert set(idx) == {'lake_marion', 'cooper_river'}
    print('idempotent: a second pass removes nothing')

    # --- a retired slug that is NOT in the index is not an error ------------------------------
    small = idx_of('lake_marion')
    removed3, _ = cli.drop_retired(small, td)
    assert removed3 == [] and set(small) == {'lake_marion'}
    print('a retired slug absent from the index is a no-op, not a failure')

with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as td:
    # --- NO tab: must say so out loud rather than silently skipping the gate ------------------
    idx = idx_of('lake_marion', 'wilson_dam')
    removed, why = cli.drop_retired(idx, td)
    assert removed == [] and why and 'NOT being filtered' in why, (removed, why)
    assert 'wilson_dam' in idx, 'without a tab it cannot know, so it must not guess'
    print('missing tab: warns, filters nothing, guesses nothing')

    # --- an unreadable tab must warn, not raise ----------------------------------------------
    open(os.path.join(td, '_deletion_tab.json'), 'w').write('{not json')
    removed, why = cli.drop_retired(idx, td)
    assert removed == [] and why and 'unreadable' in why, (removed, why)
    print('unreadable tab: warns, does not raise')

    # --- a tab with no 'retired' key, and junk entries ---------------------------------------
    json.dump({'note': 'nothing retired yet'}, open(os.path.join(td, '_deletion_tab.json'), 'w'))
    removed, why = cli.drop_retired(idx, td)
    assert removed == [] and why is None
    json.dump({'retired': [None, {}, {'slug': None}, {'slug': 'wilson_dam'}]},
              open(os.path.join(td, '_deletion_tab.json'), 'w'))
    removed, why = cli.drop_retired(idx, td)
    assert [r['slug'] for r in removed] == ['wilson_dam'], removed
    print('malformed tab entries are skipped, the good one still applies')

print('\nall consolidate merge-gate assertions pass')
