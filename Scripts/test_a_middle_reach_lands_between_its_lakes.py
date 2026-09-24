#!/usr/bin/env python3
r"""test_a_middle_reach_lands_between_its_lakes.py -- a bracketed reach goes to the row between
the two waters its own sentence names, or stays where it was.

    py .\scripts\test_a_middle_reach_lands_between_its_lakes.py

No network. The synthetic half needs nothing; the live half reads registry/lake_index.json and
registry/water_chain.json and is skipped (not failed) when either is absent.

THE BUG. SC's striped bass table addresses `Saluda River (Middle Reach) All waters of Saluda River
from backwaters of Lake Murray at SC Hwy 395 upstream to Lake Greenwood Dam`. No row we carry is
called `Middle`, so the qualifier rule found nothing and the bare name sent SCDNR's striper rule to
`saluda_river` -- the Saluda ABOVE Greenwood -- while `saluda_river_2`, the reach the sentence
describes, got none. Found 2026-09-24 reading the upper-Saluda research profiles, whose only fish
came off that misplaced row.

THE FIRST FIX DID NOTHING, AND THIS FILE CHECKS WHY IT CANNOT AGAIN. The sentence says `Saluda
River` as well, so every Saluda row is among the waters it names; and the two lakes answer to
`Saluda River (Lake ...)` in the name map. Three rows qualified, the rule stayed put. Rows are the
bare answer's kind of water; the ends are the named waters that are not rows.

Personal use only, not for distribution or resale; not for navigation.
"""
import importlib.util, io, json, os, sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_UP1 = os.path.dirname(_HERE)
ROOT = _UP1 if os.path.isdir(os.path.join(_UP1, 'registry')) else os.path.dirname(_UP1)
REG = os.path.join(ROOT, 'registry')

FAILED = []
def check(name, got, want):
    if got == want:
        print('   ok   %s' % name)
    else:
        FAILED.append(name)
        print('   FAIL %s\n        got  %r\n        want %r' % (name, got, want))

def _load(mod):
    s = importlib.util.spec_from_file_location(mod, os.path.join(_HERE, mod + '.py'))
    m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m

R = _load('build_regulations_table')

MIDDLE = ('Saluda River (Middle Reach) All waters of Saluda River from backwaters of Lake Murray '
          'at SC Hwy 395 upstream to Lake Greenwood Dam')

def row(slug, name, ft, legacy=()):
    return {'slug': slug, 'name': name, 'display_name': '%s (X Co, SC)' % name,
            'legacy_display_names': list(legacy), 'state': 'SC', 'feature_type': ft}

def bind(text, idx, chain):
    r = R.resolve_water_body(text, 'SC', R.build_name_map(idx), idx, {}, chain, {})
    return (r or {}).get('kind'), (r or {}).get('waters')

# The shape of the real Saluda: a river, a lake, a river, a lake, a river. The lakes carry the
# `Saluda River (Lake ...)` legacy names that made them look like rows of the river.
IDX = {
    'saluda_lake':    row('saluda_lake', 'Saluda Lake', 'lake'),
    'saluda_river':   row('saluda_river', 'Saluda River', 'river'),
    'lake_greenwood': row('lake_greenwood', 'Lake Greenwood', 'lake',
                          ['Saluda River (Lake Greenwood)']),
    'saluda_river_2': row('saluda_river_2', 'Saluda River (2)', 'river'),
    'lake_murray':    row('lake_murray', 'Lake Murray', 'lake', ['Saluda River (Lake Murray)']),
    'saluda_river_lower_saluda': row('saluda_river_lower_saluda', 'Saluda River (Lower Saluda)',
                                     'river'),
}
CHAIN = {
    'saluda_river':   {'upstream': ['saluda_lake'], 'downstream': 'lake_greenwood'},
    'lake_greenwood': {'upstream': ['saluda_river'], 'downstream': 'saluda_river_2'},
    'saluda_river_2': {'upstream': ['lake_greenwood'], 'downstream': 'lake_murray'},
    'lake_murray':    {'upstream': ['saluda_river_2'], 'downstream': 'saluda_river_lower_saluda'},
    'saluda_river_lower_saluda': {'upstream': ['lake_murray'], 'downstream': 'congaree_river'},
}

print('\nthe case, on rows built here')
check('the middle reach lands between the two lakes it names', bind(MIDDLE, IDX, CHAIN),
      ('name+reach bounds', ['saluda_river_2']))
check('a bracket a row DOES carry is still read the old way',
      bind('Saluda River (Lower Reach)', IDX, CHAIN), ('name', ['saluda_river_lower_saluda']))
check('no bracket, no reach: the bare name is unchanged', bind('Saluda River', IDX, CHAIN),
      ('name', ['saluda_river']))

print('\nnothing, never a guess')
one_end = ('Saluda River (Middle Reach) All waters of Saluda River upstream to Lake Greenwood Dam')
check('only one end named: the rule stays on the bare name, as it did before',
      bind(one_end, IDX, CHAIN), ('name', ['saluda_river']))
check('no chain at all: the same', bind(MIDDLE, IDX, {}), ('name', ['saluda_river']))
two = dict(IDX, saluda_river_3=row('saluda_river_3', 'Saluda River (3)', 'river'))
chain2 = dict(CHAIN, saluda_river_3={'upstream': ['lake_greenwood'], 'downstream': 'lake_murray'})
check('two rows between the same two lakes: an ambiguity, so the bare name',
      bind(MIDDLE, two, chain2), ('name', ['saluda_river']))
check('a lake between the two ends is not a reach of a RIVER',
      R._reach_between(R._bare_words('Saluda River'), 'saluda_river',
                       R.norm(MIDDLE), 'SC', R.build_name_map(IDX), IDX, CHAIN),
      'saluda_river_2')

print('\nthe shipped registry')
ip, cp = os.path.join(REG, 'lake_index.json'), os.path.join(REG, 'water_chain.json')
if os.path.exists(ip) and os.path.exists(cp):
    idx = json.load(io.open(ip, encoding='utf-8'))
    chain = json.load(io.open(cp, encoding='utf-8')).get('waters') or {}
    if 'saluda_river_2' in idx and 'saluda_river' in idx:
        check('SCDNR\'s middle-reach striper rule goes to saluda_river_2', bind(MIDDLE, idx, chain),
              ('name+reach bounds', ['saluda_river_2']))
    else:
        print('   .... saluda_river / saluda_river_2 not both in this index -- live case skipped')
else:
    print('   .... no lake_index.json / water_chain.json under %s -- live case skipped' % REG)

print('\n%s' % ('%d check(s) FAILED: %s' % (len(FAILED), ', '.join(FAILED)) if FAILED
                else 'all checks passed'))
sys.exit(1 if FAILED else 0)
