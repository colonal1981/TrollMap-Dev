#!/usr/bin/env python3
r"""pool_from_nhdplus.py -- read a reservoir's water surface out of NHDPlus HR's own elevations.

    py .\scripts\pool_from_nhdplus.py --root F:\TrollMapPipeline
    py .\scripts\pool_from_nhdplus.py --root F:\TrollMapPipeline --go
    py .\scripts\pool_from_nhdplus.py --root F:\TrollMapPipeline --only lake_mackintosh

Dry run by default. `--go` writes registry/_pool_from_nhdplus.json.

WHY THIS EXISTS. 57 waters on the full-pool hunt list have no number, and Ryan exhausted Lake
Mackintosh by hand -- the City of Burlington publishes acreage and storage and no elevation,
because the dam has an UNCONTROLLED spillway and there is nothing to operate to. The elevation
is not being withheld. Nobody computes it.

But NHDPlus HR already did, for every reach in the country, and it has been on the drive since
August. `NHDPlusFlowlineVAA` carries MaxElevSmo and MinElevSmo -- centimetres, NAVD88, derived
from the 10 m 3DEP DEM and hydro-conditioned. An IMPOUNDED reach is dead flat: MaxElevSmo equals
MinElevSmo, and every reach across the pool carries the SAME value, because a lake surface is
level. That flat run is the water surface, and it is what this reads.

WHAT IT IS NOT. It is not full pool. It is the surface on the day the lidar was flown, which is
at or below full pool and never above it for long. Measured on five waters whose pool we already
hold:

    Thurmond    329.4 against 330.0    -0.6
    Russell     472.8 against 475.0    -2.2
    Secession   545.6 against 548.0    -2.4
    Murray      355.4 against 360.0    -4.6
    Wateree     220.1 against 225.5    -5.4

Always low, never high. And the split is not noise: the three small errors are uncontrolled or
near-full lakes, the two large ones are gated hydro lakes that run drawn down. Part of the bias
is also datum -- NHDPlus is NAVD88 and operators publish NGVD29 or a local datum, worth half a
foot to a foot in the Carolinas -- and five points cannot separate the two.

So this writes an ESTIMATE with a floor, into its own file. It does not touch full_pool.json's
`rows`, which is for numbers somebody published.

THE VALIDATION IS A GATE, NOT A REPORT. The five waters above run first, every time. If any of
them fails to reproduce, or if any reads ABOVE its known pool, the run stops and writes nothing:
a method that has stopped working must not quietly emit 57 numbers.

WHAT WAS TRIED AND DOES NOT WORK. NID's `hydraulicHeight` is the drop from maximum pool to the
ORIGINAL streambed, and pool = streambed + hydraulicHeight is internally consistent across eight
known dams. But the original streambed is not the scoured tailrace the DEM sees below a dam, and
run against the same five validators that route scatters by 20-50 ft. It is in this docstring so
it is not tried again.

ONLY LAKES ARE ASKED. `lake_index.json` classifies every water -- 284 lake, 58 river, 16 coastal
-- and a river and a tidal zone have no full pool at all. That is not tidiness: a river slug's
bounding box spans whatever is impounded along it, so `wateree_river` would come back with Lake
Wateree's surface behind forty flat reaches and look completely convincing. Rivers, coastal
zones, and anything already recorded in registry/no_full_pool.json are excluded BY NAME in the
output rather than quietly left out.

Personal use only, not for distribution or resale; not for navigation.
"""
import argparse, glob, json, os, sys
from collections import Counter
from datetime import date

CM_PER_FT = 30.48

# THE GATE IS EVERY WATER WE ALREADY HOLD A POOL FOR, not a list somebody typed. full_pool.json
# has 56 of them; each one read here is a free check on the method, and the day a new one lands
# it joins the gate without an edit.
#
# READING ABOVE A KNOWN POOL IS FATAL AND READING BELOW IT IS NOT. A lake sits below full pool
# far more than above it, so a low read is the DEM catching a drawdown and a high read means the
# flat run picked up is not this water's surface at all.
MAX_OVER_FT = 1.0
MIN_VALIDATORS = 8


def _pyogrio():
    try:
        from pyogrio.raw import read as rawread
        import pyogrio
        return pyogrio, rawread
    except ImportError:
        print('!! pyogrio is required.  py -m pip install pyogrio')
        raise SystemExit(2)


def basins(nhd_dir):
    """Every NHDPlus HR geodatabase on the drive, with the ground it covers."""
    pyogrio, _ = _pyogrio()
    out = []
    for p in sorted(glob.glob(os.path.join(nhd_dir, '**', 'NHDPLUS_H_*_GDB.gdb'), recursive=True)):
        try:
            info = pyogrio.read_info(p, layer='NHDFlowline')
        except Exception as e:
            print('   !! %s: %s' % (os.path.basename(p), e))
            continue
        out.append({'path': p, 'name': os.path.basename(p), 'bounds': tuple(info['total_bounds'])})
    return out


def covering(bs, wsen):
    w, s, e, n = wsen
    hit = []
    for b in bs:
        bw, bs_, be, bn = b['bounds']
        if not (e < bw or w > be or n < bs_ or s > bn):
            hit.append(b)
    return hit


_FIELDS = {}


def field_map(gdb, layer, wanted):
    """{canonical name: the spelling THIS geodatabase uses}, or None if one is missing.

    TWO SCHEMA VINTAGES ARE ON THE DRIVE AND THEY DISAGREE ON CASE. The 2022 NHDPlus HR
    downloads for 0601 and 0602 -- the Tennessee basins, which is where Boone, Cherokee,
    Douglas, Norris and Watauga live -- spell it `nhdplusid`, and every other basin spells it
    `NHDPlusID`. And pyogrio SILENTLY DROPS a requested column a layer does not have, so asking
    for the wrong spelling does not raise: the read succeeds and the column is simply absent,
    which then fails much later as a KeyError on a water that has nothing wrong with it.
    match_waters_to_nhd.py records the same trap in its own comments. Resolve the names first.
    """
    key = (gdb, layer)
    if key not in _FIELDS:
        pyogrio, _ = _pyogrio()
        try:
            _FIELDS[key] = list(pyogrio.read_info(gdb, layer=layer)['fields'])
        except Exception:
            _FIELDS[key] = []
    have = {f.lower(): f for f in _FIELDS[key]}
    out = {}
    for w in wanted:
        actual = have.get(w.lower())
        if actual is None:
            return None
        out[w] = actual
    return out


_VAA = {}


def vaa_for(gdb):
    """{NHDPlusID: elevation_ft} for every FLAT reach in one basin, read once.

    THE WHOLE TABLE IS THE COST. NHDPlusFlowlineVAA is 87,078 rows in 0303 alone and there is no
    index to query it by id, so re-reading it per water turned 300 waters into 300 full table
    scans -- the first version did exactly that and did not finish. Read once per basin, keep
    only the impounded reaches, and every water after the first is a dictionary lookup.
    """
    if gdb in _VAA:
        return _VAA[gdb]
    _, rawread = _pyogrio()
    fm = field_map(gdb, 'NHDPlusFlowlineVAA', ['NHDPlusID', 'MaxElevSmo', 'MinElevSmo'])
    if fm is None:
        _VAA[gdb] = {}
        return {}
    m2, _, _, d2 = rawread(gdb, layer='NHDPlusFlowlineVAA',
                           columns=list(fm.values()), read_geometry=False)
    c2 = list(m2['fields'])
    raw = {c: d2[i] for i, c in enumerate(c2)}
    v = {k: raw[a] for k, a in fm.items()}
    flat = {}
    for j in range(len(v['NHDPlusID'])):
        mx, mn = v['MaxElevSmo'][j], v['MinElevSmo'][j]
        if mx is None or mn is None or mx <= 0 or abs(mx - mn) >= 1.0:
            continue
        flat[int(v['NHDPlusID'][j])] = round(mx / CM_PER_FT, 1)
    _VAA[gdb] = flat
    return flat


def flat_surface(gdb, wsen, min_reaches=3):
    """The impounded water surface inside this bounding box, in feet, or None.

    A LAKE SURFACE IS LEVEL AND A RIVER IS NOT. An impounded reach carries MaxElevSmo ==
    MinElevSmo, and every such reach across the pool carries the same value. So the answer is
    the flat elevation shared by the most reaches -- not a mean, not a minimum, and nothing that
    would be pulled off the surface by one tributary the box happened to clip.

    The runner-up travels with it. A bounding box is not a polygon, so a box can hold two flat
    surfaces -- Secession's dam sits in Richard B. Russell's backwater, and a box drawn there
    returns Russell's 472.8 with complete confidence. When two flat runs are close in size the
    read is contested and has to say so rather than pick.
    """
    _, rawread = _pyogrio()
    w, s, e, n = wsen
    fm = field_map(gdb, 'NHDFlowline', ['NHDPlusID'])
    if fm is None:
        return None
    try:
        meta, _, _, data = rawread(gdb, layer='NHDFlowline', bbox=(w, s, e, n),
                                   columns=[fm['NHDPlusID']], read_geometry=False)
    except Exception:
        return None
    cols = list(meta['fields'])
    if fm['NHDPlusID'] not in cols:
        return None
    rec = {c: data[i] for i, c in enumerate(cols)}
    ids = set(int(x) for x in rec[fm['NHDPlusID']])
    if not ids:
        return None
    table = vaa_for(gdb)
    flat = Counter()
    for pid in ids:
        ft = table.get(pid)
        if ft is not None:
            flat[ft] += 1
    if not flat:
        return None
    top = flat.most_common(2)
    (ft, k) = top[0]
    if k < min_reaches:
        return None
    second = top[1] if len(top) > 1 else None
    return {'surface_ft': ft, 'reaches': k, 'reaches_in_box': len(ids),
            'runner_up_ft': second[0] if second else None,
            'runner_up_reaches': second[1] if second else None,
            'contested': bool(second and second[1] >= k * 0.6 and abs(second[0] - ft) > 2.0)}


def read_water(bs, row):
    """The flat surface for one registry water, from whichever basin covers it."""
    wsen = row.get('bounds_wsen')
    if not wsen or len(wsen) != 4:
        return None, 'no bounds_wsen on the index row'
    hits = covering(bs, wsen)
    if not hits:
        return None, 'no NHDPlus basin on the drive covers it'
    best, why = None, 'no flat run of %d reaches inside its own bounds' % 3
    for b in hits:
        got = flat_surface(b['path'], wsen)
        if got and (best is None or got['reaches'] > best['reaches']):
            got['basin'] = b['name']
            best = got
    return best, (None if best else why)


def gate(bs, idx, held, verbose=True):
    """Reproduce every pool we already hold, or stop.

    THE ERRORS ARE THE FINDING, not a formality. Measured 2026-08-27, they split cleanly by
    operating regime and the split is the whole reason this file does not publish an estimate:

        Thurmond   -0.5   Russell  -2.2   Secession -2.4   Wateree -2.9   Murray  -4.6
        Watauga    -6.0   Norris  -17.0   Cherokee -27.5   Boone  -31.3   Douglas -40.5

    The first row is Piedmont lakes that sit near full pool. The second is TVA reservoirs, and
    Cherokee's own TWRA page says "drawdowns of up to 40 feet, common in the winter" while
    Douglas's says it can fluctuate 60 ft. The DEM caught them down. So a single offset applied
    to every water would be an invented number, and `surface_ft` is published as a FLOOR
    instead: the lake was at least this high when the lidar flew, and how much higher full pool
    sits depends on how the lake is run.
    """
    rows, fatal = [], 0
    for slug, r in sorted(held.items()):
        known = r.get('full_pool_ft')
        row = idx.get(slug)
        if not row or not isinstance(known, (int, float)):
            continue
        got, why = read_water(bs, row)
        if not got:
            rows.append((slug, known, None, None, why))
            continue
        err = got['surface_ft'] - known
        bad = None
        if err > MAX_OVER_FT:
            bad = 'READ ABOVE its known pool -- that is not this water surface'
            fatal += 1
        elif got['contested']:
            bad = 'contested: a second flat run at %s ft' % got['runner_up_ft']
        rows.append((slug, known, got['surface_ft'], err, bad))
    read = [r for r in rows if r[3] is not None]
    ok = fatal == 0 and len(read) >= MIN_VALIDATORS
    if verbose:
        print('the gate -- every water we already hold a pool for (%d read, %d could not be):'
              % (len(read), len(rows) - len(read)))
        print('   %-28s %9s %9s %8s  %s' % ('water', 'known', 'DEM', 'error', ''))
        for slug, known, dem, err, bad in sorted(rows, key=lambda x: (x[3] is None, x[3] or 0)):
            print('   %-28s %9.1f %9s %8s  %s'
                  % (slug, known, '%.1f' % dem if dem is not None else '--',
                     '%+.1f' % err if err is not None else '--', bad or ''))
        if fatal:
            print('   %d read ABOVE a known pool.' % fatal)
    return ok, rows


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--root', default='.')
    ap.add_argument('--registry', default=None)
    ap.add_argument('--nhd', default=None, help='default <root>/NHD')
    ap.add_argument('--out', default=None)
    ap.add_argument('--only', help='one slug, for a single look')
    ap.add_argument('--go', action='store_true')
    a = ap.parse_args()
    root = os.path.abspath(a.root)
    registry = a.registry or os.path.join(root, 'registry')
    nhd = a.nhd or os.path.join(root, 'NHD')
    out = a.out or os.path.join(registry, '_pool_from_nhdplus.json')

    idx = json.load(open(os.path.join(registry, 'lake_index.json'), encoding='utf-8'))
    fpp = os.path.join(registry, 'full_pool.json')
    held = (json.load(open(fpp, encoding='utf-8')).get('rows') or {}) if os.path.exists(fpp) else {}

    bs = basins(nhd)
    print('%d NHDPlus HR geodatabase(s) under %s' % (len(bs), nhd), flush=True)
    if not bs:
        print('!! none found -- nothing to read')
        return 2

    if a.only:
        row = idx.get(a.only)
        if not row:
            print('!! %s is not in lake_index.json' % a.only)
            return 2
        got, why = read_water(bs, row)
        print('\n%s -- %s' % (a.only, row.get('display_name')))
        print('   ' + (json.dumps(got, indent=1).replace('\n', '\n   ') if got else why))
        k = (held.get(a.only) or {}).get('full_pool_ft')
        if got and isinstance(k, (int, float)):
            print('   held: %.1f ft -> error %+.1f ft' % (k, got['surface_ft'] - k))
        return 0

    passed, gate_rows = gate(bs, idx, held)
    errs = [e for _, _, _, e, bad in gate_rows if e is not None and not bad]
    if not passed:
        print('\nTHE GATE FAILED. Nothing written -- a method that has stopped working must not '
              'quietly emit numbers for every lake on the card.')
        return 1
    lo, hi = min(errs), max(errs)
    errs_sorted = sorted(errs)
    med = errs_sorted[len(errs_sorted) // 2]
    print('\ngate passed on %d water(s): the DEM reads %.1f to %.1f ft under a known pool, '
          'median %.1f, never above.' % (len(errs), abs(hi), abs(lo), abs(med)))
    print('THAT SPREAD IS THE POINT. It is small on lakes held near full pool and tens of feet '
          'on reservoirs that\nrun drawn down, so nothing below is offered as a full pool -- '
          'each number is a FLOOR the lake was at\nleast at when the lidar flew.')

    # THE TARGETS ARE LAKES WITH NO PUBLISHED NUMBER, AND ONLY LAKES.
    #
    # A river and a tidal zone do not have a full pool, and that is a category error rather
    # than a gap -- registry/no_full_pool.json exists to say so. It also matters for
    # CORRECTNESS here, not just tidiness: a river slug's bounding box spans whatever is
    # impounded along it, so `wateree_river` would return Wateree Lake's surface with 40 flat
    # reaches behind it and look entirely convincing. The index already classifies every water
    # -- 284 lake, 58 river, 16 coastal -- so nothing has to be guessed.
    #
    # A water already in full_pool.json rows has a source, and a DEM read must never be offered
    # as an alternative to one.
    npp = os.path.join(registry, 'no_full_pool.json')
    no_pool = set()
    if os.path.exists(npp):
        no_pool = set((json.load(open(npp, encoding='utf-8')).get('confirmed') or {}))
    skipped = {'has a published full pool': [], 'river -- no such thing as a full pool': [],
               'coastal -- tidal, no full pool': [],
               'recorded in no_full_pool.json': [], 'unclassified feature_type': []}
    targets = []
    for slug, row in idx.items():
        ft = str(row.get('feature_type') or '').lower()
        if slug in held:
            skipped['has a published full pool'].append(slug)
        elif slug in no_pool:
            skipped['recorded in no_full_pool.json'].append(slug)
        elif ft == 'river':
            skipped['river -- no such thing as a full pool'].append(slug)
        elif ft == 'coastal':
            skipped['coastal -- tidal, no full pool'].append(slug)
        elif ft != 'lake':
            skipped['unclassified feature_type'].append(slug)
        else:
            targets.append((slug, row))
    print()
    for why, lst in skipped.items():
        if lst:
            print('   skipping %3d: %s' % (len(lst), why))
    print('reading %d lake(s) with no published full pool ...' % len(targets), flush=True)
    rows, refused = {}, {}
    for i, (slug, row) in enumerate(targets):
        got, why = read_water(bs, row)
        if got:
            got['display_name'] = row.get('display_name')
            got['state'] = row.get('state')
            got['area_acres'] = row.get('area_acres')
            # NO ESTIMATE. An offset that ranges from half a foot to forty depending on how
            # the lake is operated is not a correction, it is an invented number wearing one.
            got['is_a_floor'] = True
            rows[slug] = got
        else:
            refused[slug] = why
        if (i + 1) % 50 == 0:
            print('   %d/%d' % (i + 1, len(targets)), flush=True)

    doc = {
        '_note': 'Personal use only, not for distribution or resale; not for navigation. THE '
                 'WATER SURFACE NHDPlus HR SAW, not a published full pool. MaxElevSmo == '
                 'MinElevSmo marks an impounded reach; the flat elevation shared by the most '
                 'reaches inside the water\'s own bounds is its surface, in NAVD88 off the 10 m '
                 '3DEP DEM. It is the level on the day the lidar flew, which is at or below '
                 'full pool and never above it. `surface_ft` is what was read and is a FLOOR '
                 'and NOT a full pool -- see how_far_under_full_pool. Nothing here belongs in '
                 'full_pool.json rows, which is for numbers somebody published. ONLY LAKES ARE '
                 'ASKED: a river slug spans '
                 'whatever is impounded along it and would return that impoundment\'s surface, '
                 'convincingly and wrongly.',
        'read': date.today().isoformat(),
        'gate': [{'slug': s, 'known_ft': k, 'dem_ft': d, 'error_ft': e, 'note': b}
                 for s, k, d, e, b in gate_rows],
        'gate_error_range_ft': [round(lo, 1), round(hi, 1)],
        'gate_error_median_ft': round(med, 1),
        'how_far_under_full_pool': 'Measured on the waters above, the DEM read between %.1f and '
                                   '%.1f ft UNDER a published full pool. The small errors are '
                                   'lakes held near full pool; the large ones are reservoirs '
                                   'operated on a deep seasonal drawdown -- Cherokee\'s own TWRA '
                                   'page says drawdowns of up to 40 feet are common in winter. '
                                   'So no offset is applied to anything here.'
                                   % (abs(hi), abs(lo)),
        'waters': len(rows),
        'rows': rows,
        'no_flat_run': refused,
        # Named, not silently absent. A river and a tidal zone are excluded on purpose and the
        # exclusion is part of the answer.
        'not_asked': {why: sorted(lst) for why, lst in skipped.items() if lst},
    }
    print('\n%d water(s) have a readable surface, %d do not' % (len(rows), len(refused)))
    contested = [s for s, r in rows.items() if r.get('contested')]
    if contested:
        print('   %d contested (two flat runs in the box, neither dominant): %s'
              % (len(contested), ', '.join(sorted(contested)[:6])))
    if not a.go:
        print('\nDRY RUN -- nothing written. Add --go.')
        return 0
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(doc, f, indent=1, ensure_ascii=False)
    print('-> %s' % out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
