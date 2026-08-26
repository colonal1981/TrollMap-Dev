#!/usr/bin/env python3
"""capability_census.py - what this app can actually answer, per water, as a number.

Personal use only, not for distribution or resale; not for navigation.

    py .\\capability_census.py --registry "F:\\TrollMapPipeline\\registry" --dev "F:\\TrollMapPipeline\\TrollMap-Dev"

WHY THIS EXISTS

Ryan, 2026-08-26, after being asked how many waters can produce a full-pool number:

    "it should already be a known number... and if it isn't known we need to make it known
     somewhere... how many lakes offer full pool vs current, how many rivers have gauges... so
     on and so forth... these should all be facts that are readily accessable somewhere"

He is right, and the reason he had to ask is the pattern this project keeps finding: the counts
EXIST, get computed by whoever needs them, get used once, and are never written down. The water
graph fragmentation was in `_water_graphs.json`. The unroutable percentage was in `_audit.json`,
already flagged against its own 5% threshold. Nothing read either file. This one writes a single
row per bound water saying what can be answered about it, so the next question of this shape is
a lookup rather than an investigation.

WHAT A "CAPABILITY" IS HERE

Strictly: can the app produce this number for this water, today, from a source already bound.
Not "does the source exist somewhere on the internet." A field is true only if a binding or a
captured feed names it.

FULL POOL IS THE ONE WORTH READING FIRST

`Worker/worker-data.js` holds a hand-written LAKES table with `normalPool` on 14 entries. That
was the whole of it -- 12 of 204 bound waters, 5.9%. Meanwhile Duke's own current-level feed,
already captured in `_captures/`, carries 34 lakes with an operating range, and 23 of them match
a bound water by name.

AND THE UNITS IN THAT FEED ARE NOT UNIFORM, which is the trap. Most Catawba lakes are published
on a 0-100 INDEX where 100 is full pond and one point is one foot -- Wateree reads 97.30 in a
92.50-100.00 range. But Belews reads 722.50 in 720.00-725.00, and Hyco 408.60 in 406.00-410.50:
those are feet above sea level. `Worker/conditions.js` already half-notices the problem, in a
comment about a prompt that allowed "2-digit numbers representing local datum".

One rule covers both without having to tell them apart:

    below_full_pond_ft = Max - Actual

On an index lake Max is 100 and the subtraction gives feet below full pond directly. On an AMSL
lake Max is the top of the operating range, which is the same thing in feet. No datum sniffing,
no separate full-pool table, and the reading that falls outside its own Min-Max range is flagged
rather than believed.
"""
import argparse, collections, io, json, os, re


def J(p, default=None):
    try:
        with io.open(p, encoding='utf-8') as fh:
            return json.load(fh)
    except Exception:
        return {} if default is None else default


def worker_lakes_normal_pool(dev):
    """The hand-written table, read rather than trusted -- it is the thing being replaced."""
    try:
        s = io.open(os.path.join(dev, 'Worker', 'worker-data.js'), encoding='utf-8').read()
    except Exception:
        return {}
    m = re.search(r'var\s+LAKES\s*=\s*\{', s)
    if not m:
        return {}
    i = m.end(); d = 1; j = i
    while d and j < len(s):
        d += (s[j] == '{') - (s[j] == '}'); j += 1
    return {k: float(v) for k, v in
            re.findall(r'^\s{2}([a-z_0-9]+)\s*:\s*\{[^}]*normalPool:\s*([\d.]+)', s[i:j], re.M)}


def duke_levels(root):
    """Duke's current-level feed: 34 lakes, an operating range each. See the header on units."""
    p = os.path.join(root, '_captures',
                     'api.hydro-derived.duke-energy.app_lakes_current-level.json')
    rows = J(p, [])
    out = {}
    for r in rows if isinstance(rows, list) else []:
        name = r.get('LakeDisplayName') or r.get('LakeName')
        try:
            act = float(r.get('Actual')); mx = float(r.get('Max')); mn = float(r.get('Min'))
        except (TypeError, ValueError):
            continue
        # A reading outside its own published range is not a drawdown, it is a datum mismatch or
        # a stale row. Recorded and marked, never silently subtracted.
        out[name] = {'actual': act, 'max': mx, 'min': mn,
                     'below_full_pond_ft': round(mx - act, 2),
                     'index_scale': mx == 100.0,
                     'suspect': not (mn <= act <= mx)}
    return out


def norm(s):
    return re.sub(r'[^a-z]', '', (s or '').lower().replace('lake', ''))


def parms_of(v):
    out = set()
    for role in ('pool', 'tailwater'):
        g = v.get(role)
        if g:
            out |= set(g.get('usgs_parms') or g.get('parms') or [])
    for g in (v.get('gauges') or []):
        out |= set(g.get('usgs_parms') or g.get('parms') or [])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--registry', required=True)
    ap.add_argument('--dev', required=True, help='TrollMap-Dev checkout, for the Worker tables')
    ap.add_argument('--root', default=None, help='pipeline root holding _captures (default: '
                                                 'the parent of --registry)')
    ap.add_argument('--out', default=None, help='default <registry>/_capability_census.json')
    a = ap.parse_args()
    root = a.root or os.path.dirname(os.path.abspath(a.registry))
    out_path = a.out or os.path.join(a.registry, '_capability_census.json')

    b = (J(os.path.join(a.registry, 'water_bindings.json')) or {}).get('bindings') or {}
    idx = J(os.path.join(a.registry, 'lake_index.json'))
    graphs = (J(os.path.join(a.registry, '_water_graphs.json')) or {}).get('lakes') or {}
    audit = J(os.path.join(a.registry, '_audit.json'))
    audit = audit.get('packs') or audit.get('lakes') or audit
    NP = worker_lakes_normal_pool(a.dev)
    duke = duke_levels(root)
    duke_by_norm = {norm(k): v for k, v in duke.items()}

    rows = {}
    for slug, v in b.items():
        P = parms_of(v)
        disp = (v.get('display_name') or '').split('(')[0]
        dk = duke_by_norm.get(norm(disp)) or duke_by_norm.get(norm(slug))
        short = re.sub(r'^lake_|_lake$|_reservoir$', '', slug)
        table = NP.get(short) or NP.get(slug)
        if dk and not dk['suspect']:
            fp_src, fp = 'duke operating range', dk['below_full_pond_ft']
        elif table:
            fp_src, fp = 'worker LAKES table (hardcoded)', None
        else:
            fp_src, fp = None, None
        g = graphs.get(slug) or {}
        r = (audit.get(slug) or {}).get('runs') or {}
        rows[slug] = {
            'display_name': v.get('display_name'), 'state': v.get('state'),
            'feature_type': v.get('feature_type'),
            'level_any': bool(v.get('pool') or '00062' in P or '00065' in P),
            'pool_binding': bool(v.get('pool')), 'elev_00062': '00062' in P,
            'usace': bool(v.get('usace')), 'operator': bool(v.get('operator')),
            'full_pool_source': fp_src, 'below_full_pond_ft': fp,
            'duke_suspect_reading': bool(dk and dk['suspect']),
            'flow': '00060' in P, 'temp': '00010' in P, 'oxygen': '00300' in P,
            'turbidity': '63680' in P, 'salinity': bool({'00095', '00480'} & P),
            'tides': bool(v.get('tides')), 'ndbc': bool(v.get('ndbc')),
            'graph_nodes': g.get('nodes'), 'graph_largest_pct': g.get('largest_component_pct'),
            'runs': r.get('total'), 'unroutable_pct': r.get('unroutable_pct'),
            'ramps': len((idx.get(slug) or {}).get('ramps') or []),
        }

    n = len(rows) or 1
    def line(label, f):
        c = sum(1 for r in rows.values() if f(r))
        print('    %-34s %4d  %5.1f%%' % (label, c, 100.0 * c / n))

    print('%d bound waters\n' % len(rows))
    print('  LEVEL')
    line('a level gauge of any kind', lambda r: r['level_any'])
    line('NWPS pool binding', lambda r: r['pool_binding'])
    line('USGS 00062 reservoir elevation', lambda r: r['elev_00062'])
    line('USACE / CWMS project', lambda r: r['usace'])
    line('utility operator feed', lambda r: r['operator'])
    line('BELOW FULL POND, computable today', lambda r: r['below_full_pond_ft'] is not None)
    line('  .. and only in the hardcoded table', lambda r: r['full_pool_source'] and 'hardcoded' in r['full_pool_source'])
    line('  .. Duke reading outside its range', lambda r: r['duke_suspect_reading'])
    print('\n  WATER')
    for lbl, k in (('flow 00060', 'flow'), ('temperature 00010', 'temp'),
                   ('oxygen 00300', 'oxygen'), ('turbidity 63680', 'turbidity'),
                   ('salinity 00095/00480', 'salinity'), ('tide station', 'tides'),
                   ('NDBC buoy', 'ndbc')):
        line(lbl, lambda r, k=k: r[k])
    print('\n  THE PACK')
    line('has a water graph', lambda r: r['graph_nodes'])
    line('has trolling runs', lambda r: r['runs'])
    line('>5% of runs unroutable', lambda r: (r['unroutable_pct'] or 0) > 5)
    line('100% of runs unroutable', lambda r: (r['unroutable_pct'] or 0) >= 100)
    line('at least one ramp', lambda r: r['ramps'])
    print('\n  by feature type:', dict(collections.Counter(r['feature_type'] for r in rows.values())))

    with io.open(out_path, 'w', encoding='utf-8') as fh:
        json.dump({'_note': 'Personal use only, not for distribution or resale; not for '
                            'navigation. What the app can answer per water, from bound sources '
                            'only. Built by capability_census.py.',
                   'waters': len(rows), 'rows': rows}, fh, indent=1)
    print('\n-> %s' % out_path)


if __name__ == '__main__':
    main()
