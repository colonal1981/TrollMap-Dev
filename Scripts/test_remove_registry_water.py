#!/usr/bin/env python3
r"""test_remove_registry_water.py -- lakes.json's RECORD is `lakes[]`, not `by_state`.

Personal use only, not for distribution or resale; not for navigation.

    py .\scripts\test_remove_registry_water.py

WHY THIS EXISTS

2026-08-24. Seven waters Ryan retired on 08-23 -- Broad River (3) (Elbert Co, GA), Buck Creek
(Baldwin Co, GA), Great Falls Reservoir (Chester Co, SC), J P Stevens O Company Industrial Pond
(Laurens Co, GA), Orton Pond (Brunswick Co, NC), River Bed (Berkeley Co, SC) and White Oak Slash
Lake (Sumter Co, SC) -- came straight back into lake_index.json on the next consolidate. The
remover had edited `by_state` and left the rows in `lakes[]`, and consolidate_lake_index.py:627
walks `lakes[]`. Their boundary files, tile_lake_map rows and charted verdicts were all gone, so
the index carried seven waters that could not be clipped or rebuilt. 365 rows where 358 were
expected.

migrate_merged_slugs.py had already recorded the identical failure on 2026-08-18, in a comment
on the line that causes it, and test_migrate_slugs.py already tripwires it: "Rewriting its
by_state lists on 2026-08-18 left seven records in lakes[] belonging to no state list at all."
Seven records, both times, eleven days apart. The second one is what this file is for.
"""
import io, json, os, shutil, subprocess, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
TOOL = HERE / 'remove_registry_water.py'


def eq(g, w, m):
    assert g == w, '%s: got %r want %r' % (m, g, w)


def build(root, by_state):
    """A registry holding three waters. `by_state` is passed in so drift can be seeded."""
    R = root / 'registry'
    (R / 'boundaries').mkdir(parents=True)
    rows = [{'slug': 'keeper_lake', 'state': 'SC', 'area_km2': 9.0},
            {'slug': 'ghost_pond', 'state': 'SC', 'area_km2': 4.0},
            {'slug': 'other_lake', 'state': 'NC', 'area_km2': 1.0}]
    json.dump({'count': sum(len(v) for v in by_state.values()), 'state_order': ['SC', 'NC'],
               'by_state': by_state, 'lakes': rows},
              io.open(R / 'lakes.json', 'w', encoding='utf-8'), indent=1)
    json.dump({'by_lake': {'keeper_lake': ['C4E000'], 'ghost_pond': ['C4E000']},
               'by_tile': {'C4E000': ['keeper_lake', 'ghost_pond']}, 'orphans': []},
              io.open(R / 'tile_lake_map.json', 'w', encoding='utf-8'), indent=1)
    json.dump({'keeper_lake': {'charted': 0.9}, 'ghost_pond': {'charted': 0.01}},
              io.open(R / 'charted.json', 'w', encoding='utf-8'), indent=1)
    for s in ('keeper_lake', 'ghost_pond', 'other_lake'):
        io.open(R / 'boundaries' / (s + '.geojson'), 'w', encoding='utf-8').write('{}')
    (root / 'chartpack' / 'ghost_pond').mkdir(parents=True)
    io.open(root / 'chartpack' / 'ghost_pond' / 'contours.geojson', 'w',
            encoding='utf-8').write('{}')


def run(root, *args):
    p = subprocess.run([sys.executable, str(TOOL), '--registry', 'registry',
                        '--slugs', 'ghost_pond', '--date', '2026-01-01'] + list(args),
                       cwd=str(root), capture_output=True, text=True)
    return p.returncode, p.stdout + p.stderr


def load(root, name):
    return json.load(io.open(root / 'registry' / name, encoding='utf-8'))


# --- 1. the ordinary removal, from a lakes.json that agrees with itself
root = Path(tempfile.mkdtemp())
build(root, {'SC': ['keeper_lake', 'ghost_pond'], 'NC': ['other_lake']})
before = io.open(root / 'registry' / 'lakes.json', encoding='utf-8').read()

rc, text = run(root)
eq(rc, 0, 'dry run exits clean')
assert 'DRY RUN' in text, 'must not write by default'
eq(io.open(root / 'registry' / 'lakes.json', encoding='utf-8').read(), before,
   'A DRY RUN MUST LEAVE lakes.json BYTE IDENTICAL')
assert 'lakes.json 1' in text, 'the dry run counts the RECORD it would drop, not the view: ' + text

rc, text = run(root, '--go')
eq(rc, 0, 'write run exits clean')
d = load(root, 'lakes.json')
slugs = [r['slug'] for r in d['lakes']]
eq(slugs, ['keeper_lake', 'other_lake'], 'THE RECORD IS `lakes[]` -- that is what consolidate walks')
eq(d['by_state'], {'SC': ['keeper_lake'], 'NC': ['other_lake']}, 'by_state rebuilt FROM the record')
eq(d['count'], 2, 'count is len(lakes[]), not a sum over the view')
eq(d['state_order'], ['SC', 'NC'], 'state_order preserved')
assert 'ghost_pond' not in load(root, 'tile_lake_map.json')['by_lake'], 'tile row gone'
assert 'ghost_pond' not in load(root, 'tile_lake_map.json')['by_tile']['C4E000'], 'by_tile gone'
assert 'ghost_pond' not in load(root, 'charted.json'), 'charted verdict gone'
assert not (root / 'registry' / 'boundaries' / 'ghost_pond.geojson').exists(), 'boundary moved'
assert (root / '_to_delete' / 'registry_removed_2026-01-01' / 'ghost_pond.geojson').exists(), \
    'boundaries are MOVED, never unlinked'
assert (root / 'chartpack' / 'ghost_pond' / 'contours.geojson').exists(), \
    'THE PACK IS THE BACKUP THE R2 PRUNE RULE LEANS ON -- it must survive'
eq([e['slugs'] for e in load(root, '_removed_waters.json')], [['ghost_pond']], 'logged')
shutil.rmtree(root, ignore_errors=True)

# --- 2. THE 2026-08-24 CASE: by_state already edited, the record left behind.
#        A run against that state must finish the job rather than report nothing to do.
root = Path(tempfile.mkdtemp())
build(root, {'SC': ['keeper_lake'], 'NC': ['other_lake']})     # ghost_pond already cut from view
os.remove(root / 'registry' / 'boundaries' / 'ghost_pond.geojson')
d = load(root, 'lakes.json')
assert 'ghost_pond' in [r['slug'] for r in d['lakes']], 'seeded: in the record, not in the view'

rc, text = run(root, '--go')
eq(rc, 0, 'exits clean')
d = load(root, 'lakes.json')
eq([r['slug'] for r in d['lakes']], ['keeper_lake', 'other_lake'],
   'A SECOND RUN REPAIRS THE DRIFT rather than reporting zero and leaving the ghost')
assert 'lakes.json 1' in text, 'and it says so: ' + text
eq(d['count'], 2, 'count follows the record')
bs = sorted(s for v in d['by_state'].values() for s in v)
eq(bs, sorted(r['slug'] for r in d['lakes']), 'the view can never disagree with the record again')
shutil.rmtree(root, ignore_errors=True)

print('ALL remove_registry_water assertions pass')
