#!/usr/bin/env python3
r"""bind_water_levels.py -- one place that answers "how does this water report its level today".

    py .\scripts\bind_water_levels.py --root F:\TrollMapPipeline
    py .\scripts\bind_water_levels.py --root F:\TrollMapPipeline --go

Dry run by default. `--go` writes the `levels` block into registry/water_bindings.json.

WHY THIS EXISTS. That question was answered five different ways in one session on 2026-08-27 --
221, 204, 63, 68, 75 -- and every wrong answer had the same cause: a source keyed differently
from the one being read. There are FOUR networks and they agree on nothing.

    nws:HP        SHEF physical element on the bound `pool` gauge. HP is pool height, HG is
                  river stage. build_water_bindings.py already ranks HP first for a lake, but
                  `pedts` does not survive into water_bindings.json, so it has to be read back
                  off registry/_nwps_all_gauges.csv -- the roster that binder itself cached.
    usgs:00062    A reservoir-elevation gauge, KEYED TWO WAYS IN ONE FILE: a USGS-sourced pool
                  writes `parms` and carries `pool_from`; an NWS-sourced one writes `usgs_parms`.
    duke          NOT IN water_bindings.json AT ALL until now. The Worker fetches Duke at
                  request time and matches its rows to waters BY NAME -- and there are two Lake
                  Robinsons in the index, 200 km apart. Binding the LocationId turns a name
                  comparison into an integer and the whole class of question goes away.
    sensor        An operator-run logger on a water no public network covers. Randleman's PTRWA
                  level is the first: registry/_sensor_feeds.json, found by Ryan, confirmed
                  working, and consumed by nothing until this.

RECORDS ALL OF THEM, NOT JUST THE WINNER. A water can have three, and which one is best is a
judgement that will change; losing the other two to record that judgement is not. `primary` is
the pick, `sources` is everything found, and the rule that chose is stated in the output.

BINDS THE POINTER, NEVER THE VALUE. `levels` says which feed and which key. The reading is still
fetched live -- a level written into a registry file is stale the moment it is written.

THE RECORD FILES STAY THE RECORD. duke_lake_levels.json and _sensor_feeds.json are where those
facts are authored; this writes a view of them, and re-running rebuilds the view. Editing the
view instead of the record is the failure at the top of 00_START_HERE.md.

AND `levels` MUST BE IN build_water_bindings.py's FOREIGN_KEYS. That tuple exists because a full
rebind once destroyed 18 operator and 12 NDBC blocks and it went unnoticed for nine days. A key
this script owns and that one does not compute is exactly what it protects.

Personal use only, not for distribution or resale; not for navigation.
"""
import argparse, csv, json, os, sys
from collections import Counter
from datetime import date

DUKE_ENDPOINT = 'https://api.hydro-derived.duke-energy.app/lakes/operating-range/%s'


def _j(p):
    with open(p, encoding='utf-8') as fh:
        return json.load(fh)


def roster_pedts(registry):
    p = os.path.join(registry, '_nwps_all_gauges.csv')
    if not os.path.exists(p):
        raise SystemExit('!! registry/_nwps_all_gauges.csv is missing -- pedts cannot be read, '
                         'and guessing which gauges are pool gauges is how this went wrong five '
                         'times.')
    with open(p, encoding='utf-8-sig') as fh:
        return {(r.get('nws shef id') or '').strip().upper(): (r.get('pedts') or '')
                for r in csv.DictReader(fh)}


def sources_for(slug, binding, ped, duke, sensors):
    """Every way this water can report a level, best-evidenced first."""
    out = []
    p = binding.get('pool') or {}
    lid = (p.get('lid') or '').upper()
    if lid and (ped.get(lid) or '')[:2].upper() == 'HP':
        out.append({'source': 'nws:HP', 'key': {'lid': lid},
                    'name': p.get('name'), 'from': 'water_bindings.pool + _nwps_all_gauges.csv'})
    # BOTH SPELLINGS. Reading one returned zero for every water; reading the other dropped five.
    if str(p.get('pool_from') or '').startswith('usgs:00062') or any(
            str(x) == '00062' for k in ('parms', 'usgs_parms') for x in (p.get(k) or [])):
        out.append({'source': 'usgs:00062', 'key': {'site': p.get('usgs_site')},
                    'name': p.get('usgs_name') or p.get('name'), 'from': 'water_bindings.pool'})
    d = duke.get(slug)
    if d:
        out.append({'source': 'duke', 'key': {'location_id': d['location_id']},
                    'endpoint': DUKE_ENDPOINT % d['location_id'],
                    'units': d.get('units'), 'name': d['duke_name'],
                    'from': 'registry/duke_lake_levels.json'})
    s = sensors.get(slug)
    if s:
        out.append({'source': 'sensor', 'key': s['key'], 'name': s.get('operator'),
                    'from': 'registry/_sensor_feeds.json'})
    op = binding.get('operator')
    if op:
        out.append({'source': 'operator', 'key': {'operator': op.get('operator'),
                                                  'feed_name': op.get('feed_name')},
                    'from': 'bind_operator_lakes.py'})
    return out


def load_duke(registry):
    """slug -> {duke_name, location_id, units}. LocationId comes off the current-level payload;
    duke_lake_levels.json is the transcription of the same table and carries the slug join."""
    rows = (_j(os.path.join(registry, 'duke_lake_levels.json')).get('rows') or {})
    cap = os.path.join(os.path.dirname(registry), '_captures',
                       'api.hydro-derived.duke-energy.app_lakes_current-level.json')
    loc = {}
    if os.path.exists(cap):
        loc = {r.get('LakeDisplayName'): r.get('LocationId') for r in _j(cap)}
    pool = os.path.join(registry, '_duke_pool.json')
    if os.path.exists(pool):
        for slug, r in (_j(pool).get('rows') or {}).items():
            loc.setdefault(r.get('duke_name'), r.get('location_id'))
    out, nolid = {}, []
    for name, r in rows.items():
        slug = r.get('slug')
        if not slug:
            continue
        lid = loc.get(name)
        if lid is None:
            nolid.append(name)
            continue
        out[slug] = {'duke_name': name, 'location_id': lid, 'units': r.get('units')}
    return out, nolid


def load_sensors(registry):
    p = os.path.join(registry, '_sensor_feeds.json')
    if not os.path.exists(p):
        return {}
    out = {}
    for slug, f in (_j(p).get('feeds') or {}).items():
        lvl = ((f.get('sensors_on_the_lake') or {}).get('water_level') or {})
        cw = (f.get('CONFIRMED_WORKING') or {})
        if not lvl.get('channel') and not cw:
            continue
        out[slug] = {'operator': f.get('operator'),
                     'key': {'dashboard': (cw.get('fetcher') or '').split('--dashboard ')[-1].strip()
                             or None,
                             'channel': lvl.get('channel'),
                             'metric': lvl.get('metric')}}
    return out


# THE PICK, AND THE RULE THAT MAKES IT. Stated in the output so it can be argued with rather
# than reverse-engineered. A geometry-checked gauge on the water beats a feed matched by name;
# a purpose-built lake gauge beats an operator page; anything beats nothing.
ORDER = ('nws:HP', 'usgs:00062', 'duke', 'sensor', 'operator')
RULE = ('nws:HP then usgs:00062 then duke then sensor then operator. The first two are gauges '
        'bound by NAME AND GEOMETRY on the water itself; Duke and the sensor feeds are joined by '
        'name alone and are therefore ranked below them, not because they are worse readings but '
        'because the JOIN is weaker. Every source found is kept in `sources` regardless.')


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--root', default='.')
    ap.add_argument('--registry', default=None)
    ap.add_argument('--go', action='store_true')
    a = ap.parse_args()
    root = os.path.abspath(a.root)
    registry = a.registry or os.path.join(root, 'registry')

    wbp = os.path.join(registry, 'water_bindings.json')
    doc = _j(wbp)
    bindings = doc.get('bindings') or {}
    idx = _j(os.path.join(registry, 'lake_index.json'))
    ped = roster_pedts(registry)
    duke, duke_nolid = load_duke(registry)
    sensors = load_sensors(registry)
    print('%d bound water(s); duke %d slug(s), sensor %d' % (len(bindings), len(duke), len(sensors)))
    if duke_nolid:
        print('   duke rows with no LocationId: %s' % ', '.join(duke_nolid))

    # A WATER CAN HAVE A LEVEL AND NO BINDING ROW. Duke and the sensor feeds are joined by slug,
    # not by geometry, so they can reach a water build_water_bindings.py never bound. Those get a
    # row created for them rather than being dropped, which is what hid Tuckertown.
    for slug in list(duke) + list(sensors):
        if slug not in bindings and slug in idx:
            bindings[slug] = {'slug': slug, 'display_name': idx[slug].get('display_name'),
                              'state': idx[slug].get('state'),
                              'feature_type': idx[slug].get('feature_type')}

    hit, by, added, changed = 0, Counter(), 0, 0
    for slug, b in bindings.items():
        srcs = sources_for(slug, b, ped, duke, sensors)
        if not srcs:
            if 'levels' in b:
                b.pop('levels')
                changed += 1
            continue
        srcs.sort(key=lambda s: ORDER.index(s['source']) if s['source'] in ORDER else 99)
        block = {'primary': srcs[0]['source'], 'sources': srcs, 'rule': RULE,
                 'read': date.today().isoformat()}
        if b.get('levels') != block:
            changed += 1
        b['levels'] = block
        hit += 1
        by[srcs[0]['source']] += 1
        if len(srcs) > 1:
            added += 1

    lakes = {s for s, r in idx.items() if str(r.get('feature_type')) == 'lake'}
    lake_hits = [s for s in bindings if s in lakes and bindings[s].get('levels')]
    print('\n%d water(s) can report a level; %d of them are LAKES, of %d offered'
          % (hit, len(lake_hits), len(lakes)))
    for k in ORDER:
        if by[k]:
            print('   primary %-12s %d' % (k, by[k]))
    print('   %d water(s) have more than one source' % added)
    multi = [s for s in bindings if len(((bindings[s].get('levels') or {}).get('sources')) or []) > 2]
    if multi:
        print('   three or more: %s' % ', '.join(sorted(multi)[:6]))

    if not a.go:
        print('\nDRY RUN -- %d block(s) would change. Add --go.' % changed)
        return 0
    doc['bindings'] = bindings
    with open(wbp, 'w', encoding='utf-8') as f:
        json.dump(doc, f, indent=1, ensure_ascii=False)
    print('\n%d block(s) changed -> %s' % (changed, wbp))
    print("REMEMBER: 'levels' must be in build_water_bindings.py FOREIGN_KEYS or the next full "
          "rebind erases every one of them.")
    return 0


if __name__ == '__main__':
    sys.exit(main())
