#!/usr/bin/env python3
r"""test_a_renamed_water_keeps_no_door_open.py -- the old name must not reach the old row.

    py .\scripts\test_a_renamed_water_keeps_no_door_open.py

No network. Reads registry/lake_index.json and is reported as SKIPPED, with that reason, if it is
absent (registry_here.py).

THE SHAPE OF THE BUG, WHICH TOOK THREE PASSES TO CLOSE. 3DHP hung "Lake Lucas" on a nameless
polygon on the Uwharrie River while the real Lake Lucas sat five miles east under its GNIS name,
Back Creek Lake. lake_display_names.json renamed the first to Lake Reese and gave the second the
name back.

    pass 1  drop_stolen_legacy_names() took the old spelling off the renamed row's DISPLAY and
            LEGACY names, in consolidate_lake_index.py.
    pass 2  build_agency_lake_facts.build_name_multimap() still keyed on the SLUG, which is
            `lake_lucas` and cannot change -- it is an R2 key, a chartpack directory and whatever
            sits in saved plans. "lake lucas" resolved to two slugs and every resolver refused it.
    pass 3  build_regulations_table.build_name_map() did the same AND IS FIRST-WINS, so it did
            not refuse -- it answered `lake_lucas`. A regulation addressed to Lake Lucas landed
            on Lake Reese, in the one table that decides what may be kept.

Ryan, after pass 2: *"1 door out of 2... half..."*

THE INVARIANT, ASSERTED ON THE REAL INDEX: a name belongs to the water that is CALLED that. A slug
is an identifier and may only answer for a name nothing else is called. Both maps are checked,
because the bug was that they were fixed one at a time.

Personal use only, not for distribution or resale; not for navigation.
"""
import importlib.util, io, json, os, re, sys, unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
from registry_here import REGISTRY as REG, registry_has, why_missing

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

NEED = ('lake_index.json',)


def _run():
    idx = json.load(io.open(os.path.join(REG, 'lake_index.json'), encoding='utf-8'))

    A = _load('build_agency_lake_facts')
    R = _load('build_regulations_table')

    print('\nthe live case')
    mm = A.build_name_multimap(idx)
    nm = R.build_name_map(idx)
    if 'lake_lucas' in idx and 'back_creek_lake' in idx:
        check('agency map: "Lake Lucas" is the water called that', mm.get('lake_lucas'),
              ['back_creek_lake'])
        check('regulations map: same, and it is first-wins so it CANNOT refuse',
              nm.get('lake_lucas'), 'back_creek_lake')
        check('and the renamed row still answers to its NEW name',
              nm.get('lake_reese'), 'lake_lucas')
        check('agency map likewise', mm.get('lake_reese'), ['lake_lucas'])
    else:
        print('   .... lake_lucas / back_creek_lake are not both in this index -- live case skipped')

    print('\nthe rule, on rows built here so it does not depend on the shipped index')
    synth = {
        'old_slug': {'slug': 'old_slug', 'name': 'New Name', 'display_name': 'New Name (X Co, SC)',
                     'legacy_display_names': [], 'state': 'SC'},
        'other': {'slug': 'other', 'name': 'Old Slug', 'display_name': 'Old Slug (Y Co, SC)',
                  'legacy_display_names': ['Old Slug'], 'state': 'SC'},
        'lonely': {'slug': 'lonely_water', 'name': 'Lonely Water',
                   'display_name': 'Lonely Water (Z Co, SC)', 'legacy_display_names': [], 'state': 'SC'},
    }
    mm2, nm2 = A.build_name_multimap(synth), R.build_name_map(synth)
    check('the name goes to the row that is called it', nm2.get('old_slug'), 'other')
    check('and the multimap agrees', mm2.get('old_slug'), ['other'])
    # A SLUG STILL ANSWERS FOR ITSELF where nothing else claims the name -- removing that would break
    # every caller that looks a water up by its id, which is most of them.
    check('a slug nothing else is called still resolves', nm2.get('lonely_water'), 'lonely')
    check('and in the multimap too', mm2.get('lonely_water'), ['lonely'])

    # THE FOURTH DOOR, 2026-10-05. Lake Craig keeps the slug `lake_edwin_johnson`; the 40-acre lake
    # really called Lake Edwin Johnson claims the name in consolidate and is then dropped from the
    # index at 0% charted. With no row in the index called it, the slug answered, and SCDNR's Edwin
    # Johnson page was written onto Lake Craig. Ryan: *"it is a page for a wrong lake..."* The row
    # now carries `names_given_up`, and a slug never answers for one of those.
    print('\na name the row gave up, whose owner is not in the index')
    gave = {
        'old_water': {'slug': 'old_water', 'name': 'True Name', 'display_name': 'True Name (X Co, SC)',
                      'legacy_display_names': [], 'state': 'SC',
                      'names_given_up': ['Old Water', 'Old Water (X Co, SC)', 'Old Water, SC']},
        'lonely': {'slug': 'lonely', 'name': 'Lonely Water', 'display_name': 'Lonely Water (Z Co, SC)',
                   'legacy_display_names': [], 'state': 'SC'},
    }
    mm3, nm3 = A.build_name_multimap(gave), R.build_name_map(gave)
    check('the slug does not answer for a name its row gave up', nm3.get('old_water'), None)
    check('nor in the multimap', mm3.get('old_water'), None)
    check('a page titled with the given-up name resolves to nothing',
          R.resolve('Old Water', nm3), None)
    check('the renamed row still answers to its true name', nm3.get('true_name'), 'old_water')
    check('and in the multimap', mm3.get('true_name'), ['old_water'])
    check('a row that gave nothing up still answers by its slug', nm3.get('lonely'), 'lonely')
    check('and in the multimap', mm3.get('lonely'), ['lonely'])

    print('\nacross the whole shipped index')
    # Where a slug and a real name collide, the name must win in BOTH maps. Checked together, because
    # the bug was that they were fixed one at a time.
    named = {}
    for slug, row in idx.items():
        for n in [row.get('name'), row.get('display_name'), row.get('legacy_display_name'),
                  *(row.get('legacy_display_names') or [])]:
            if n:
                named.setdefault(R.slugify(str(n).split(' (')[0]), set()).add(slug)
    clashes = [s for s in idx if s in named and s not in named[s]]
    check('no slug outranks the water actually called that (regulations map)',
          [s for s in clashes if nm.get(s) not in named[s]], [])
    check('nor in the agency map',
          [s for s in clashes if not set(mm.get(s) or []) & named[s]], [])
    def _k(c):
        return re.sub(r'_(al|ga|nc|sc|tn|va)$', '', R.slugify(re.sub(r'\s*\(.*?\)\s*', ' ', str(c))))
    given = {s: {_k(n) for n in row['names_given_up']} for s, row in idx.items()
             if row.get('names_given_up')}
    check('no slug answers for a name its own row gave up (regulations map)',
          [s for s, g in given.items() if _k(s) in g and nm.get(_k(s)) == s], [])
    check('nor in the agency map',
          [s for s, g in given.items() if _k(s) in g and s in (mm.get(_k(s)) or [])], [])
    print('        %d row(s) gave a name up%s' % (len(given), (': ' + ', '.join(sorted(given))) if given else ''))
    print('        %d slug(s) collide with another water\'s real name' % len(clashes))
    for s in clashes:
        print('           %-24s -> %-22s (called that: %s)'
              % (s, nm.get(s), ', '.join(sorted(named[s]))))

    print('\n%s' % ('%d check(s) FAILED: %s' % (len(FAILED), ', '.join(FAILED)) if FAILED
                    else 'all checks passed'))


# Without the registry this is REPORTED AS SKIPPED, with the file it reads, never passed.
@unittest.skipUnless(registry_has(*NEED), why_missing(*NEED))
class TheRealIndex(unittest.TestCase):

    def test_no_old_name_reaches_the_old_row(self):
        _run()
        self.assertEqual(FAILED, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
