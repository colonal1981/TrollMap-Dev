#!/usr/bin/env python3
r"""test_ncpaws_access.py -- the bank pad, and the launches NC WRC publishes and we dropped.

    py .\scripts\test_ncpaws_access.py

No network. Reads registry/lake_index.json, registry/_nc_species_cache.json and
registry/_nc_species_unmatched.json; SKIPS with a non-zero exit if any is missing, because a
test that cannot find its data and prints SKIP forever is the failure this project already had.

WHAT IT GUARDS

1. `in_box` grew a `pad` argument on the day it was written and NOTHING EVER PASSED ONE. A
   parameter that no caller sets is a guard that can never fire -- the same shape as
   isCoastalZone(displayName) matching slugs only. So the first check is that bind() actually
   spends it.

2. The pad is claimed to be FLAT, not tuned: 220 m and 3.5 miles bind the same waters. If that
   ever stops being true the number has become a threshold somebody can loosen for more
   results, and the comment above BANK_PAD_DEG is no longer honest.

3. `access_rows` may only emit a place you can put a boat in. `ramp_sources` in the index counts
   non-empty buckets, so a bank-fishing spot in this file would make a water with nowhere to
   launch read as having one more place to launch.

4. consolidate_lake_index.py has to actually merge the file. Writing a bucket nothing reads is
   how this project keeps computing a fact and never bringing it to the decision.

Personal use only, not for distribution or resale; not for navigation.
"""
import collections, importlib.util, io, json, os, sys

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

def load(fn):
    return json.load(io.open(os.path.join(REG, fn), encoding='utf-8'))

need = ['lake_index.json', '_nc_species_cache.json', '_nc_species_unmatched.json',
        'nc_species_by_lake.json']
absent = [f for f in need if not os.path.exists(os.path.join(REG, f))]
if absent:
    print('SKIP -- %s is not under %s. Run build_nc_species_by_lake.py --go first.'
          % (', '.join(absent), REG))
    sys.exit(2)

_s = importlib.util.spec_from_file_location('b', os.path.join(_HERE, 'build_nc_species_by_lake.py'))
B = importlib.util.module_from_spec(_s); _s.loader.exec_module(B)

idx = load('lake_index.json')
nc = {s: r for s, r in idx.items() if 'NC' in str(r.get('state') or '').upper()}
cache = load('_nc_species_cache.json')
built = load('nc_species_by_lake.json')['lakes']
un = load('_nc_species_unmatched.json')

# Every location NC WRC answered for, rebuilt from the two files the last run wrote, so this
# needs no network and still tests bind() against the real 891.
locs = [{'locationID': x['locationID'], 'locationName': x['locationName'],
         'waterbodyName': x['waterbodyName'], 'latitude': x['lat'], 'longitude': x['lon']}
        for x in un]
for slug, row in built.items():
    for l in (row.get('locations') or []):
        c = cache.get(str(l['locationID'])) or {}
        locs.append({'locationID': l['locationID'], 'locationName': l.get('locationName'),
                     'waterbodyName': l.get('waterbodyName'),
                     'latitude': c.get('latitude'), 'longitude': c.get('longitude')})

by_name, by_bare = collections.defaultdict(set), collections.defaultdict(set)
for slug, rec in nc.items():
    for n in B.row_names(rec):
        by_name[B.norm(n)].add(slug); by_bare[B.norm_bare(n)].add(slug)

_real_in_box = B.in_box
def bind_all(pad):
    B.in_box = lambda rec, lat, lon, _p=0.0: _real_in_box(rec, lat, lon, pad)
    try:
        return {l['locationID']: B.bind(l, nc, by_name, by_bare)[0] for l in locs}
    finally:
        B.in_box = _real_in_box

print('\nthe bank pad -- %d location(s) rebuilt from the last run' % len(locs))
check('BANK_PAD_DEG is a real width', B.BANK_PAD_DEG > 0, True)

live = {l['locationID']: B.bind(l, nc, by_name, by_bare)[0] for l in locs}
check('bind() spends it (unpadded binds fewer waters)',
      len({v for v in bind_all(0.0).values() if v}) < len({v for v in live.values() if v}), True)
check('and matches an explicit pad of BANK_PAD_DEG', bind_all(B.BANK_PAD_DEG), live)

# A wider box can only ever ADD candidates, so no binding may be lost -- and a binding that
# CHANGES water is the wrong-lake failure the two-signal rule exists to prevent.
zero = bind_all(0.0)
moved = [k for k, v in zero.items() if v and live.get(k) != v]
check('no location moves to a different water', moved, [])

waters = lambda m: len({v for v in m.values() if v})
# NOT "the same at every width" -- at 0.05 deg a location starts landing in TWO padded boxes
# whose names it both answers to, and the name rule refuses it, so the count FALLS. That is the
# property worth asserting: widening cannot buy waters, only lose them, which is what makes this
# a fixed offset rather than a threshold somebody can loosen for more results.
here = waters(bind_all(B.BANK_PAD_DEG))
wide = {p: waters(bind_all(p)) for p in (0.005, 0.01, 0.02, 0.05, 0.1)}
check('no wider pad binds more waters', [p for p, n in wide.items() if n > here], [])
check('and a narrower one binds fewer', waters(bind_all(0.0)) < here, True)
print('        waters bound at 0 deg -> %d, %g deg -> %d, %s'
      % (waters(bind_all(0.0)), B.BANK_PAD_DEG, here,
         ', '.join('%g deg -> %d' % kv for kv in sorted(wide.items()))))

print('\naccess_rows() -- what goes in the launch bucket')
hits = {s: [dict(l, _how=l.get('matchedBy')) for l in (r.get('locations') or [])]
        for s, r in built.items()}
acc = B.access_rows(hits, cache)
rows = [r for v in acc.values() for r in v]
check('it emitted something', bool(rows), True)
check('every row is a launch',
      [r['name'] for r in rows if not (r['meta']['canoe'] or r['meta']['ramp'])], [])
check('every row has a coordinate',
      [r['name'] for r in rows if not isinstance(r['lat'], (int, float))
       or not isinstance(r['lon'], (int, float))], [])
check('every row lands on a water we ship', [s for s in acc if s not in idx], [])
check('type names the flags',
      sorted({r['type'] for r in rows}),
      ['Boat Ramp', 'Boat Ramp / Paddle Launch', 'Paddle Launch'])
check('the bucket carries the same keys as the others',
      sorted(rows[0]), ['lat', 'lon', 'meta', 'name', 'src', 'type', 'wb'])
print('        %d launch(es) on %d water(s)' % (len(rows), len(acc)))

print('\nconsolidate_lake_index.py -- the bucket is merged')
src = io.open(os.path.join(_HERE, 'consolidate_lake_index.py'), encoding='utf-8').read()
check('the filename is in the merge table', B.ACCESS_OUT in src, True)
check('under a bucket name of its own', "'ncpaws'" in src, True)

print('\n%s' % ('%d check(s) FAILED: %s' % (len(FAILED), ', '.join(FAILED)) if FAILED
                else 'all checks passed'))
sys.exit(1 if FAILED else 0)
