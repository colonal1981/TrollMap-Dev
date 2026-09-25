#!/usr/bin/env python3
r"""test_this_water_in_this_state.py -- research_lakes.py's side of the water-scope rule.

    py .\scripts\test_this_water_in_this_state.py

No network. Needs node on the path, like the off-lake gate it runs.

The rule lives in js/utils/water-scope.js and is tested in test/this-water-in-this-state.test.js.
What this checks is the plumbing Python owns: that gate_documents() hands the scope to the real
gate under node, so Virginia's New River page is refused for New River, NC; that no scope leaves
the gate as it was; that reach_places.mjs returns the scope beside the places; and that
sort_by_reach() now sends each document's opening text with its title.

Personal use only, not for distribution or resale; not for navigation.
"""
import importlib.util, json, os, sys, tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(_HERE)
FX = json.load(open(os.path.join(REPO, 'test', 'fixtures', 'this-water-in-this-state.2026-09-25.json'),
                    encoding='utf-8'))

FAILED = []
def check(name, got, want):
    if got == want:
        print('   ok   %s' % name)
    else:
        FAILED.append(name)
        print('   FAIL %s\n        got  %r\n        want %r' % (name, got, want))

s = importlib.util.spec_from_file_location('research_lakes', os.path.join(_HERE, 'research_lakes.py'))
RL = importlib.util.module_from_spec(s); s.loader.exec_module(RL)

def doc(key):
    d = FX['documents'][key]
    return {'title': d['title'], 'url': d['url'], 'fullText': d['text']}

print('\nthe scope comes back from reach_places.mjs, off the registry it already reads')
with tempfile.TemporaryDirectory() as reg:
    with open(os.path.join(reg, 'lake_index.json'), 'w', encoding='utf-8') as f:
        json.dump(FX['index'], f)
    r = RL.reach_for(REPO, reg, 'New River, NC', 'new_river')
    check('New River is scoped as a river in Ashe County',
          ((r or {}).get('scope') or {}).get('counties'), ['Ashe'])
    r = RL.reach_for(REPO, reg, 'Lake Robinson, SC', 'lake_robinson')
    check('Lake Robinson names the Greer lake as its rival',
          ((r or {}).get('scope') or {}).get('rivalPlaces'), ['Greenville', 'Greer'])
    r = RL.reach_for(REPO, reg, 'Lake Murray, SC', 'lake_murray')
    check('Lake Murray has no scope', (r or {}).get('scope', 'missing'), None)

print('\nthe gate, run under node with the scope')
scope = {'why': 'river', 'states': ['NC'], 'counties': ['Ashe'], 'namesakes': [],
         'ownPlaces': ['Ashe'], 'rivalPlaces': []}
docs = [doc('new_river_virginia_dwr')]
got = RL.gate_documents(REPO, docs, 'New River, NC', ['New River'], scope)
check('Virginia DWR\'s New River is refused for New River, NC',
      [x.get('why') for x in got.get('refused') or []], ['another_state'])
got = RL.gate_documents(REPO, docs, 'New River, NC', ['New River'])
check('and with no scope it is kept, as it was', got.get('rejected'), 0)

print('\nsort_by_reach sends each document\'s opening text')
calls = []
real = RL._reach_node
RL._reach_node = lambda repo, payload: calls.append(payload) or None
long_doc = {'title': 'French Broad River Fly Fishing Guide', 'url': 'u', 'fullText': 'x' * 30000}
RL.sort_by_reach(REPO, {'own': ['Newport'], 'other': {'french_broad_river': ['Asheville']}},
                 documents=[long_doc])
RL._reach_node = real
sent = ((calls or [{}])[0].get('documents') or [{}])[0]
check('the text goes, cut to the local name window', len(sent.get('text') or ''), RL.BODY_WINDOW)
check('which is doc-relevance.js\'s LOCAL_NAME_WINDOW', RL.BODY_WINDOW, 20000)

print('\nand the body sort, through node')
y = FX['documents']['french_broad_mt_yonder']
reach = {'own': ['Newport'], 'other': {'french_broad_river': ['Asheville', 'Rosman']}}
kf, of, kd, od = RL.sort_by_reach(REPO, reach, documents=[{'title': y['title'], 'url': y['url'],
                                                             'fullText': y['text']}])
check('the Asheville guide goes to the NC piece', [d.get('belongs_to') for d in od], ['french_broad_river'])
check('and nothing is kept for the Tennessee piece', kd, [])

print('\n%s' % ('%d check(s) FAILED: %s' % (len(FAILED), ', '.join(FAILED)) if FAILED
                else 'all checks passed'))
sys.exit(1 if FAILED else 0)
