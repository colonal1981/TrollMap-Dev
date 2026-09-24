#!/usr/bin/env python3
r"""test_a_river_piece_searches_its_own_stretch.py -- research_lakes.py's side of reaches.

    py .\scripts\test_a_river_piece_searches_its_own_stretch.py

No network. Needs node on the path, like the off-lake gate it sits beside. The live half reads the
real registry and is skipped (not failed) when it is absent.

The rule lives in js/utils/reach-places.js and is tested in
test/a-river-piece-searches-its-own-stretch.test.js. What this checks is the plumbing that
Python owns: that reach_for() reaches the node script and gets the upper Saluda's group and places
back, that sort_by_reach() sends titles and brings WHOLE documents back by index, and that a
river with no other piece is never sent to node at all.

Personal use only, not for distribution or resale; not for navigation.
"""
import importlib.util, os, sys

_HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(_HERE)
ROOT = os.path.dirname(REPO)
REG = os.path.join(ROOT, 'registry')

FAILED = []
def check(name, got, want):
    if got == want:
        print('   ok   %s' % name)
    else:
        FAILED.append(name)
        print('   FAIL %s\n        got  %r\n        want %r' % (name, got, want))

s = importlib.util.spec_from_file_location('research_lakes', os.path.join(_HERE, 'research_lakes.py'))
RL = importlib.util.module_from_spec(s); s.loader.exec_module(RL)

print('\nnothing to sort against, nothing sent')
calls = []
real = RL._reach_node
RL._reach_node = lambda repo, payload: calls.append(payload) or None
docs = [{'title': 'Lower Saluda Scenic River', 'fullText': 'x' * 500}]
got = RL.sort_by_reach(REPO, {'own': ['Pelzer'], 'other': {}}, facts=[{'fact': 'a'}], documents=docs)
check('a reach with no other piece keeps everything', got, ([{'fact': 'a'}], [], docs, []))
check('and never calls node', calls, [])
got = RL.sort_by_reach(REPO, None, facts=[{'fact': 'a'}])
check('no reach at all is the run as it was', got, ([{'fact': 'a'}], [], [], []))
RL._reach_node = real

print('\nthe sort, through node')
reach = {'own': ['Ware Shoals'], 'other': {'saluda_river_lower_saluda': ['Lower Saluda', 'Hope Ferry']}}
docs = [{'title': 'Saluda River at Ware Shoals', 'url': 'u1', 'fullText': 'kept body ' * 50},
        {'title': 'Catch the drift for lower Saluda trout, stripers', 'url': 'u2', 'fullText': 'b' * 500},
        {'title': 'Top Saluda River Fishing Spots', 'url': 'u3', 'fullText': 'c' * 500}]
facts = [{'fact': 'Hope Ferry Landing has a ramp.'}, {'fact': 'Catfish hold below Ware Shoals.'}]
kf, of, kd, od = RL.sort_by_reach(REPO, reach, facts=facts, documents=docs)
check('the fact about Hope Ferry goes to the Lower Saluda',
      [(x.get('belongs_to'), x.get('because')) for x in of], [('saluda_river_lower_saluda', 'Hope Ferry')])
check('the Ware Shoals fact stays', [x['fact'] for x in kf], ['Catfish hold below Ware Shoals.'])
check('kept documents come back WHOLE, full text and all', [d['url'] for d in kd], ['u1', 'u3'])
check('with their bodies', kd[0]['fullText'], docs[0]['fullText'])
check('the other piece\'s document is named, with why',
      [(d.get('title'), d.get('belongs_to')) for d in od],
      [('Catch the drift for lower Saluda trout, stripers', 'saluda_river_lower_saluda')])

print('\nthe shipped registry')
if os.path.exists(os.path.join(REG, 'lake_index.json')):
    r = RL.reach_for(REPO, REG, 'Saluda River, SC', 'saluda_river_2')
    check('the upper Saluda is both upper rows', (r or {}).get('group'), ['saluda_river', 'saluda_river_2'])
    check('the Lower Saluda is its sibling', (r or {}).get('siblings'), ['saluda_river_lower_saluda'])
    check('Ware Shoals and Chappells are on its search list',
          all(p in ((r or {}).get('search') or []) for p in ('Ware Shoals', 'Chappells')), True)
    check('the forks are other waters, by the state feed\'s own names',
          all(n in ((r or {}).get('other') or {}) for n in
              ('North Saluda River', 'Middle Saluda River', 'South Saluda River')), True)
else:
    print('   .... no registry beside the repo -- live case skipped')

print('\n%s' % ('%d check(s) FAILED: %s' % (len(FAILED), ', '.join(FAILED)) if FAILED
                else 'all checks passed'))
sys.exit(1 if FAILED else 0)
