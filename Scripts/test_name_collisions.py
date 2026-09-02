#!/usr/bin/env python3
r"""test_name_collisions.py -- a renamed water may not keep another water's real name.

    py .\scripts\test_name_collisions.py

No network. The end-to-end half needs registry/lake_index.json and
registry/_nc_species_unmatched.json; it SKIPS with a non-zero exit if either is absent rather
than printing SKIP and passing forever.

WHAT THIS GUARDS. load_name_overrides keeps a replaced 3DHP name as a legacy name so a saved
plan holding the old string still resolves. That is right for `dallas_lake` -> Chickamauga Lake,
because nothing else is called Dallas Lake. It is wrong when the replaced name is another
water's REAL name, and on 2026-09-02 that turned out to be the live case: 3DHP hung "Lake Lucas"
on a nameless 500-acre impoundment on the Uwharrie River, while the actual Lake Lucas is filed
under its GNIS name "Back Creek Lake" five miles east. Renaming the first to Lake Reese while it
kept "Lake Lucas" would leave TWO rows answering to the name, and every binder that requires a
name to resolve to exactly one water refuses an ambiguous one -- so both waters would bind to
nothing, which is worse than the wrong label.

Personal use only, not for distribution or resale; not for navigation.
"""
import collections, copy, importlib.util, io, json, os, sys

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

def _load(fn):
    _s = importlib.util.spec_from_file_location(fn, os.path.join(_HERE, fn + '.py'))
    m = importlib.util.module_from_spec(_s); _s.loader.exec_module(m); return m

C = _load('consolidate_lake_index')

# ── the rule itself, on rows built here so it does not depend on the shipped index ──────────
print('\ndrop_stolen_legacy_names() -- the rule')

def row(slug, name, legacy=()):
    return {'slug': slug, 'name': name, 'display_name': '%s (X Co, NC)' % name,
            'legacy_display_name': (list(legacy) or [None])[0],
            'legacy_display_names': list(legacy), 'state': 'NC'}

# The Dallas Lake shape: renamed, and nothing else answers to the old name.
idx = {'dallas_lake': row('dallas_lake', 'Chickamauga Lake',
                          ['Dallas Lake, TN', 'Dallas Lake (Hamilton Co, TN)', 'Dallas Lake']),
       'other': row('other', 'Watts Bar Lake')}
stolen = C.drop_stolen_legacy_names(idx, {'dallas_lake': ['Dallas Lake, TN',
                                                          'Dallas Lake (Hamilton Co, TN)',
                                                          'Dallas Lake']})
check('a name nobody else claims is KEPT', stolen, [])
check('and stays on the row', len(idx['dallas_lake']['legacy_display_names']), 3)

# The Lake Lucas shape: renamed, and the old name is another row's real name.
idx = {'a': row('a', 'Lake Reese', ['Lake Lucas, NC', 'Lake Lucas (Randolph Co, NC)', 'Lake Lucas']),
       'b': row('b', 'Lake Lucas')}
stolen = C.drop_stolen_legacy_names(idx, {'a': ['Lake Lucas, NC', 'Lake Lucas (Randolph Co, NC)',
                                                'Lake Lucas']})
check('a name another water answers to is DROPPED', [x[0] for x in stolen], ['a', 'a', 'a'])
check('it names who already had it', sorted({o for _s, _o, ow in stolen for o in ow}), ['b'])
check('nothing spelling it survives on the row',
      [n for n in idx['a']['legacy_display_names'] if 'lucas' in n.lower()], [])
# row_names() in build_nc_species_by_lake.py reads the SCALAR before the list, so clearing the
# list alone would leave the ambiguity in place through that door.
check('and the scalar is cleared too',
      'lucas' in str(idx['a']['legacy_display_name'] or '').lower(), False)
check('the row that really is called that keeps it', idx['b']['name'], 'Lake Lucas')

# A rename must never strip a name from a row it did not rename.
idx = {'a': row('a', 'Lake Reese', ['Lake Lucas']), 'b': row('b', 'Lake Lucas', ['Lake Lucas'])}
before = copy.deepcopy(idx['b'])
C.drop_stolen_legacy_names(idx, {'a': ['Lake Lucas']})
check('an unrenamed row is untouched', idx['b'], before)

# ── end to end, against the shipped index ───────────────────────────────────────────────────
need = ['lake_index.json', '_nc_species_unmatched.json']
absent = [f for f in need if not os.path.exists(os.path.join(REG, f))]
if absent:
    print('\nSKIP the end-to-end half -- no %s under %s' % (', '.join(absent), REG))
    print('\n%s' % ('%d check(s) FAILED: %s' % (len(FAILED), ', '.join(FAILED)) if FAILED
                    else 'all checks passed'))
    sys.exit(1 if FAILED else 0)

B = _load('build_nc_species_by_lake')
live = json.load(io.open(os.path.join(REG, 'lake_index.json'), encoding='utf-8'))
un = json.load(io.open(os.path.join(REG, '_nc_species_unmatched.json'), encoding='utf-8'))

print('\nthe shipped index -- what the override will do to it')
sim = copy.deepcopy(live)
# Exactly what consolidate_lake_index.py builds from
# {"lake_lucas": {"name": "Lake Reese"}, "back_creek_lake": {"also": ["Lake Lucas", ...]}}.
olds = ['Lake Lucas, NC', 'Lake Lucas (Randolph Co, NC)', 'Lake Lucas']
sim['lake_lucas'].update({'name': 'Lake Reese', 'display_name': 'Lake Reese (Randolph Co, NC)',
                          'legacy_display_name': olds[0], 'legacy_display_names': olds})
sim['back_creek_lake']['legacy_display_names'] = (
    list(sim['back_creek_lake'].get('legacy_display_names') or [])
    + ['Lake Lucas (Randolph Co, NC)', 'Lake Lucas'])

claims_before = C.claimed_names(sim)
check('without the rule, "Lake Lucas" is ambiguous',
      len(claims_before.get(C.norm('Lake Lucas'), set())), 2)
stolen = C.drop_stolen_legacy_names(sim, {'lake_lucas': olds})
check('the rule fires on the real rows', [x[0] for x in stolen] != [], True)
check('and afterwards it resolves to exactly one water',
      sorted(C.claimed_names(sim).get(C.norm('Lake Lucas'), set())), ['back_creek_lake'])
check('which is the one with the ramp on it',
      sim['back_creek_lake']['gnis'], 'gnis:1008833')

print('\nNC WRC\'s LAKE LUCAS location, bound against the renamed index')
loc = [x for x in un if x['locationName'] == 'LAKE LUCAS']
check('the location is still in the refused file', len(loc), 1)
if loc:
    l = {'locationID': loc[0]['locationID'], 'locationName': loc[0]['locationName'],
         'waterbodyName': loc[0]['waterbodyName'],
         'latitude': loc[0]['lat'], 'longitude': loc[0]['lon']}
    nc = {s: r for s, r in sim.items() if 'NC' in str(r.get('state') or '').upper()}
    by_name, by_bare = collections.defaultdict(set), collections.defaultdict(set)
    for slug, rec in nc.items():
        for n in B.row_names(rec):
            by_name[B.norm(n)].add(slug); by_bare[B.norm_bare(n)].add(slug)
    slug, how = B.bind(l, nc, by_name, by_bare)
    check('it binds to back_creek_lake', slug, 'back_creek_lake')
    check('by name AND box, not by the bank pad alone', 'name' in str(how) and 'box' in str(how), True)
    print('        %s -> %s (%s)' % (l['locationName'], slug, how))

print('\n%s' % ('%d check(s) FAILED: %s' % (len(FAILED), ', '.join(FAILED)) if FAILED
                else 'all checks passed'))
sys.exit(1 if FAILED else 0)
