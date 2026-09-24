#!/usr/bin/env python3
"""
test_a_gauge_reads_its_own_water.py -- pins the three rules that decide whose gauge `pool` is.

    py .\\scripts\\test_a_gauge_reads_its_own_water.py

`pool` is the gauge every level, flow and go/no-go answer comes off. Scripts/audit_pool_binds.mjs
listed sixteen waters reading a gauge named for some other water, and the 2026-09-24 rebind
measured what each rule below moves. Every case here is a gauge name from the NWPS/USGS rosters.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_water_bindings import (ABOVE_RE, DAM_RE, POOL_RE, demote_shared_pools,  # noqa: E402
                                  gauge_river_part, names_the_water)

FAILED = []


def check(label, got, want):
    if got != want:
        FAILED.append(label)
        print('FAIL %-62s got %r want %r' % (label, got, want))
    else:
        print('ok   %-62s %r' % (label, got))


def dam_or_pool_word(name):
    return bool(POOL_RE.search(name) or (ABOVE_RE.search(name) and DAM_RE.search(name)))


# ── 1. a gauge that says which river it is on ─────────────────────────────────────────────
SFNR = ['South Fork New River', 'South Fork New River (Grayson Co, NC)', 'South Fork New River, NC']
BROAD2 = ['Broad River (2)', 'Broad River (2) (Union Co, SC)', 'Broad River (2), SC']
check('river part stops at the first locative',
      gauge_river_part('Broad River in NC/SC near CARLISLE'), 'broad river')
check('a (state) parenthetical is not part of the river',
      gauge_river_part('Pigeon River (NC) above (W Fork) Abv Lake Logan'), 'pigeon river')
check('the South Fork gauge names the South Fork',
      bool(names_the_water(SFNR, 'South Fork New River at US Hwy 221')), True)
check('a tributary does not name it',
      bool(names_the_water(SFNR, 'Big Reed Island Creek at Silverleaf Road')), False)
check('the mainstem does not name the fork',
      bool(names_the_water(SFNR, 'New River at Mouth of Wilson')), False)
check('"(2)" is not part of the name a gauge is compared to',
      bool(names_the_water(BROAD2, 'Broad River in NC/SC near CARLISLE')), True)
check('a longer river that ENDS in the name is not the name',
      bool(names_the_water(['Broad River'], 'French Broad River at Asheville')), False)
check('Enoree is not the Broad',
      bool(names_the_water(BROAD2, 'Enoree River near Woodruff')), False)

# ── 2. `above` names a pool only beside `dam` ─────────────────────────────────────────────
for nm, want in (("Black Creek (SC) above Hartsville", False),
                 ("Swift Creek above McCuller's Crossroads", False),
                 ('Pacolet River above Cowpens', False),
                 ('Pee Dee River above Poston at US 378', False),
                 ('Hiwassee River above Hiwassee Dam', True),
                 ('Lake Crabtree above Dam near Interstate 40', True),
                 ('Watauga River above Watauga Dam', True),
                 # Not a pool word: "at <name> Dam" is not `at dam`. This one reaches the pool
                 # race on its own name and its position, which is the right way in.
                 ('Wateree River at Lake Wateree Dam', False)):
    check('pool word: %s' % nm, dam_or_pool_word(nm), want)

# ── 3. one instrument, one pool ───────────────────────────────────────────────────────────
def water(conf, lid='CLTT1', site=None, gauges=None, kind='lake'):
    p = {'lid': lid, 'name': 'Little Tennessee River above Chilhowee Dam', 'confidence': conf}
    if site:
        p['usgs_site'] = site
    return {'pool': p, 'gauges': list(gauges or []), 'feature_type': kind}


b = {'chilhowee_lake': water('name+geom'),
     'tellico_lake': water('name+near', gauges=[{'lid': 'FLDT1'}])}
t = Counter()
demote_shared_pools(b, t)
check('the water that contains the gauge keeps it',
      b['chilhowee_lake']['pool']['lid'], 'CLTT1')
check('the neighbour loses it as pool', 'pool' in b['tellico_lake'], False)
check('and keeps it as a gauge, LAST, so it is never the primary',
      [g.get('lid') for g in b['tellico_lake']['gauges']], ['FLDT1', 'CLTT1'])
check('which says whose pool it is', b['tellico_lake']['gauges'][-1].get('pool_of'),
      'chilhowee_lake')
check('the tally counts it', t['shared_pool_demoted'], 1)

b = {'davy_crockett_lake': water('name+geom', lid='NOLT1'),
     'nolichucky_river': water('name+near', lid='NOLT1', kind='river'),
     'nolichucky_river_2': water('name+near', lid='NOLT1', kind='river')}
demote_shared_pools(b, Counter())
check('two rivers and the lake at the dam: the lake keeps it',
      sorted(s for s, v in b.items() if v.get('pool')), ['davy_crockett_lake'])

# Lake James's dam gauge stands inside the CATAWBA's outline and 0.3 km outside the lake's.
# Containment alone handed it to the river; a lake has one level, a river has many gauges.
b = {'lake_james': water('name+near', lid='BRWN7'),
     'catawba_river_2': water('name+geom', lid='BRWN7', kind='river')}
demote_shared_pools(b, Counter())
check('a lake beats a river even when the river contains the gauge',
      sorted(s for s, v in b.items() if v.get('pool')), ['lake_james'])

b = {'a': water('name+near', lid='X1'), 'b': water('name+near', lid='X1')}
t = Counter()
demote_shared_pools(b, t)
check('two lakes, neither contains it: nothing moves',
      sorted(s for s, v in b.items() if v.get('pool')), ['a', 'b'])
check('and the run says so', t['shared_pool_undecided'], 1)

b = {'a': water('name+geom', lid='X1'), 'b': water('name+geom', lid='X1')}
demote_shared_pools(b, Counter())
check('two lakes both contain it: nothing moves',
      sorted(s for s, v in b.items() if v.get('pool')), ['a', 'b'])

b = {'a': water('name+near', lid='X1', kind='river'), 'b': water('name+geom', lid='X1', kind='river')}
demote_shared_pools(b, Counter())
check('two rivers: the one containing it keeps it',
      sorted(s for s, v in b.items() if v.get('pool')), ['b'])

b = {'lake_x': water('name+geom', lid='X1'), 'river_y': water('override', lid='X1', kind='river')}
demote_shared_pools(b, Counter())
check("a person's override keeps it, even on a river against a lake",
      sorted(s for s, v in b.items() if v.get('pool')), ['river_y'])

# One instrument under its lid on one water and its lid + site on another: decided once.
b = {'lake_johnson': water('name+geom', lid='JHSN7', site='02087339'),
     'lake_raleigh': water('name+near', lid='JHSN7', site='02087339')}
t = Counter()
demote_shared_pools(b, t)
check('a lid and a site for one gauge is one claim, demoted once', t['shared_pool_demoted'], 1)
check('Lake Raleigh does not read Lake Johnson', 'pool' in b['lake_raleigh'], False)

b = {'only': water('name+near', lid='X1')}
demote_shared_pools(b, Counter())
check('a pool nobody else claims is untouched', b['only']['pool']['lid'], 'X1')

print()
if FAILED:
    print('%d FAILED' % len(FAILED))
    sys.exit(1)
print('all passed')
