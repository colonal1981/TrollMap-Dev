#!/usr/bin/env python3
"""
build_moving_water.py -- which gauges show each lake's water moving, derived for every lake.

Personal use only, not for distribution or resale; not for navigation.

Item 46 of APP_CHANGE_REQUESTS. The first version named gauges for three lakes by hand. Ryan,
2026-10-02: "remember my rule no lake gets something that isn't available to all", then "build
the general version". His rule, 2026-08-25: "any data that is available for any and all lakes
should be available for any and all lakes", and "nothing hand written... everything expandable".

So nothing here names a lake. For every lake in registry/lake_index.json that water_chain.json
places, the gauges come from the registry's own records:

  level    the lake's own pool gauge in water_bindings.json, when USGS reports a lake level for it.
  outflow  for each RIVER in the chain's `outlets`: of the USGS gauges bound to that river, the one
           nearest the lake that reports discharge -- the first gauge below the dam on that outlet.
  inflow   for each RIVER in the chain's `upstream`: the bound gauge nearest the lake that reports
           discharge, else stage -- the last gauge above it.

A GAUGE HAS TO BE ABOUT THIS LAKE'S WATER. The chain's outlet is the next water IN THE APP, and for
a millpond that can be a big river 80 km away: the first run put Cain Millpond on the Pee Dee below
Pee Dee, 84 km off. So, by USGS's own drainage area for the site (monitoring-locations) against the
chain's routed drainage for the lake:
  outflow  kept when most of the water at the gauge came through the lake -- the lake's drainage is
           at least half the gauge's. Jefferies: 14,718 of 14,800 sq mi. A site USGS gives no
           drainage for is kept, and the report says so.
  inflow   kept when the gauged rivers into the lake together carry most of what flows into it --
           their drainage is at least half the lake's. Marion's Congaree and Wateree, yes; a creek
           into Hartwell carrying a fourteenth of it, no.
Half is "most", not a tuning value. And a gauge the binder filed under two of a lake's rivers is
taken for the one its own name says: the Congaree at Fort Motte is bound to the Wateree River too.

A lake that empties straight into another lake has no river between them in the chain, so it gets
no outflow gauge here; the operator's own release feed (Worker/conditions.js releaseShape) is what
covers those. Nearest is measured to the lake's own outline (chartpack/<slug>/waterbody.geojson),
or its registry centroid when the pack has none, and the distance is written so the line can say
how far below or above the lake the gauge is.

What a site reports is asked of USGS in BULK: one latest-continuous request per parameter over the
box the candidate gauges sit in, not one per site. The first version asked per site and spent the
API's 1,000-an-hour allowance in two minutes (HTTP 429, 2026-10-02) -- the same allowance Ryan's
browser draws on for the plan's own gauge reads. A parameter counts only if it has reported within
the 15 days the app reads (TIDE_CYCLE_DAYS in js/utils/moving-water.js). The answers are kept in
registry/_bindings_cache/moving_water_params.json.

Writes registry/moving_water_gauges.json, which upload_garmin_to_r2.py publishes at
_registry/moving_water_gauges.json for the browser (js/data/moving-water-gauges.js reads it), and a
report.

    py Scripts/build_moving_water.py --report F:\\TrollMapPipeline\\_scratch\\mw\\report.json
    py Scripts/build_moving_water.py --check     # exit 1 if the registry file is stale
"""

import argparse
import datetime as dt
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


def _find(rel, siblings=('', 'TrollMap-Dev', 'TrollMapPipeline'), levels=5):
    """Walk up looking for `rel` (see gen_coastal_zones_js.py for why: two copies of Scripts)."""
    parts = rel.split('/')
    here = HERE
    for _ in range(levels):
        for sib in siblings:
            base = os.path.join(here, sib) if sib else here
            cand = os.path.join(base, *parts)
            if os.path.exists(cand):
                return cand
        parent = os.path.dirname(here)
        if parent == here:
            break
        here = parent
    return None


OGC = 'https://api.waterdata.usgs.gov/ogcapi/v0/collections'
DISCHARGE = '00060'
LAKE_LEVEL = ['00062', '62614', '62615', '00065']   # reservoir elevation first, gage height last
STAGE = '00065'
FRESH_DAYS = 15                                       # TIDE_CYCLE_DAYS, the window the app reads


def load(p):
    with open(p, encoding='utf-8') as fh:
        return json.load(fh)


def km(a, b):
    """Equirectangular km between two (lon, lat) points -- tens of km, so plenty."""
    lat = math.radians((a[1] + b[1]) / 2)
    return math.hypot((a[0] - b[0]) * math.cos(lat), a[1] - b[1]) * 111.2


def outline_points(chartpack, slug, centroid):
    """The lake's outline vertices, thinned; its centroid when the pack has no outline."""
    p = os.path.join(chartpack, slug, 'waterbody.geojson')
    pts = []
    if os.path.exists(p):
        try:
            g = load(p)
            for f in g.get('features', []):
                geom = f.get('geometry') or {}
                polys = geom.get('coordinates') or []
                if geom.get('type') == 'Polygon':
                    polys = [polys]
                for poly in polys:
                    for ring in poly[:1]:
                        pts.extend(ring)
        except Exception:
            pts = []
    if pts:
        step = max(1, len(pts) // 4000)
        return [tuple(q[:2]) for q in pts[::step]]
    return [tuple(centroid)] if centroid else []


def dist_to(pts, lon, lat):
    return min(km(q, (lon, lat)) for q in pts) if pts else float('inf')


class Params:
    """What each USGS site reports now, read in bulk per parameter and cached."""

    WANT = [DISCHARGE, *LAKE_LEVEL]

    def __init__(self, path, offline=False, reuse=False):
        self.path = path
        self.offline = offline
        self.reuse = reuse
        saved = load(path) if path and os.path.exists(path) else {}
        self.cache = saved.get('sites', {}) if isinstance(saved, dict) and 'sites' in saved else {}
        self.read_at = saved.get('read_at') if isinstance(saved, dict) else None
        self.asked = 0

    def _get(self, url):
        for attempt in range(3):
            try:
                with urllib.request.urlopen(url, timeout=60) as r:
                    self.asked += 1
                    return json.loads(r.read().decode('utf-8'))
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    raise SystemExit(f'USGS answered 429 (its hourly allowance is spent); try again in '
                                     f'{e.headers.get("Retry-After", "?")} s. Nothing was written.')
                time.sleep(3 * (attempt + 1))
            except Exception:  # noqa: BLE001 -- asked again, then the run stops
                time.sleep(3 * (attempt + 1))
        raise SystemExit(f'USGS did not answer: {url}')

    def prefetch(self, gauges):
        """Every candidate site's parameters, one bulk read per parameter over their box."""
        if self.offline or not gauges or (self.reuse and self.cache):
            return
        lons = [g['lon'] for g in gauges]
        lats = [g['lat'] for g in gauges]
        bbox = f'{min(lons):.4f},{min(lats):.4f},{max(lons):.4f},{max(lats):.4f}'
        since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=FRESH_DAYS)
        found = {}
        for code in self.WANT:
            url = (f'{OGC}/latest-continuous/items?parameter_code={code}&bbox={bbox}&limit=10000'
                   '&skipGeometry=true&properties=monitoring_location_id,parameter_code,time&f=json')
            while url:
                j = self._get(url)
                for f in j.get('features', []):
                    pr = f.get('properties') or {}
                    loc = str(pr.get('monitoring_location_id') or '')
                    try:
                        when = dt.datetime.fromisoformat(pr.get('time'))
                    except Exception:
                        continue
                    if loc.startswith('USGS-') and when >= since:
                        found.setdefault(loc[5:], set()).add(code)
                url = next((l.get('href') for l in j.get('links', []) if l.get('rel') == 'next'), None)
        wanted = {g['usgs_site'] for g in gauges}
        self.cache = {s: sorted(found.get(s, ())) for s in wanted}
        self.read_at = dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')

    def of(self, site):
        return self.cache.get(site, [])

    def save(self):
        if self.path and not self.offline:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            with open(self.path, 'w', encoding='utf-8') as fh:
                json.dump({'read_at': self.read_at, 'sites': self.cache}, fh, indent=0, sort_keys=True)


def bound_gauges(b):
    """Every USGS-numbered gauge in one water's binding, once each."""
    seen, out = set(), []
    for g in [b.get('pool'), b.get('tailwater'), *(b.get('gauges') or [])]:
        if not g or not g.get('usgs_site') or g.get('lat') is None or g.get('lon') is None:
            continue
        if g['usgs_site'] in seen:
            continue
        seen.add(g['usgs_site'])
        out.append(g)
    return out


def gauge_name(g):
    return g.get('name') or g.get('usgs_name') or g['usgs_site']


def words(s):
    return {w for w in str(s or '').lower().replace('.', ' ').split() if len(w) > 3}


def nearest_reporting(pts, gauges, want, params, mine=None, others=()):
    """Of `gauges`, nearest the lake first, the first that reports one of `want` (in order).

    A gauge whose own name names another of the lake's rivers (`others`) and not this one (`mine`)
    belongs to that river, wherever the binder filed it.
    """
    ranked = sorted(gauges, key=lambda g: dist_to(pts, g['lon'], g['lat']))
    for g in ranked:
        nm = words(gauge_name(g)) | words(g.get('usgs_name'))
        if mine is not None and not (nm & mine) and any(nm & o for o in others):
            continue
        have = params.of(g['usgs_site'])
        for code in want:
            if code in have:
                return g, code, dist_to(pts, g['lon'], g['lat'])
    return None, None, None


SQKM_PER_SQMI = 2.589988


def keep_this_lakes_water(rows, lake_km2, drainage):
    """The rows whose gauge is about this lake's water (see the module docstring), and why not."""
    if not lake_km2:
        return rows, []
    lake = lake_km2 / SQKM_PER_SQMI
    out, why = [], []
    for r in rows:
        if r['role'] != 'outflow':
            out.append(r)
            continue
        da = drainage.get(r['site'])
        if da is None or lake >= da / 2:
            out.append({**r, **({'drainageSqMi': da} if da is not None else {})})
        else:
            why.append(f"outflow {r['site']} on {r['via']}: {lake:,.0f} of its {da:,.0f} sq mi come through the lake, not most")
    # One gauge is not above the lake and below it too. Where the chain has the same river in and
    # out (Davy Crockett on the Nolichucky), the site the outflow took is not also an inflow.
    outs = {r['site'] for r in out if r['role'] == 'outflow'}
    for r in [r for r in out if r['role'] == 'inflow' and r['site'] in outs]:
        why.append(f"inflow {r['site']} on {r['via']} is the gauge below the lake, not above it")
    out = [r for r in out if not (r['role'] == 'inflow' and r['site'] in outs)]
    ins = [r for r in out if r['role'] == 'inflow']
    if ins:
        das = [drainage.get(r['site']) for r in ins]
        if all(x is not None for x in das) and sum(das) < lake / 2:
            why.append(f"inflow gauges carry {sum(das):,.0f} of the lake's {lake:,.0f} sq mi, not most")
            out = [r for r in out if r['role'] != 'inflow']
    return out, why


def drainage_areas(sites, offline=False, cache_path=None):
    """USGS's drainage area (sq mi) per site, in bulk, cached beside the parameter answers."""
    cache = load(cache_path) if cache_path and os.path.exists(cache_path) else {}
    need = sorted(s for s in sites if s not in cache)
    if need and not offline:
        for i in range(0, len(need), 50):           # ids per request, for the length of the URL
            ids = ','.join(f'USGS-{s}' for s in need[i:i + 50])
            url = (f'{OGC}/monitoring-locations/items?id={ids}&skipGeometry=true'
                   '&properties=id,drainage_area&limit=100&f=json')
            try:
                with urllib.request.urlopen(url, timeout=60) as r:
                    j = json.loads(r.read().decode('utf-8'))
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    raise SystemExit(f'USGS answered 429 (its hourly allowance is spent); try again in '
                                     f'{e.headers.get("Retry-After", "?")} s. Nothing was written.')
                raise
            got = {str(f.get('id', '')).replace('USGS-', ''): (f.get('properties') or {}).get('drainage_area')
                   for f in j.get('features', [])}
            for s in need[i:i + 50]:
                v = got.get(s)
                cache[s] = float(v) if v not in (None, '') else None
        if cache_path:
            with open(cache_path, 'w', encoding='utf-8') as fh:
                json.dump(cache, fh, indent=0, sort_keys=True)
    return {s: cache.get(s) for s in sites}


def build(registry, chartpack, params, drainage=None):
    idx = load(os.path.join(registry, 'lake_index.json'))
    chain = load(os.path.join(registry, 'water_chain.json'))['waters']
    binds = load(os.path.join(registry, 'water_bindings.json'))['bindings']
    kind = {s: (r.get('feature_type') or '') for s, r in idx.items()}
    # Every gauge any lake could use, read from USGS in one pass before any lake is looked at.
    cands = []
    for slug, r in idx.items():
        if r.get('feature_type') == 'lake':
            pool = (binds.get(slug) or {}).get('pool')
            if pool and pool.get('usgs_site') and pool.get('lat') is not None:
                cands.append(pool)
        if r.get('feature_type') == 'river':
            cands.extend(bound_gauges(binds.get(slug) or {}))
    params.prefetch(cands)
    label = {s: (r.get('name') or r.get('display_name') or s) for s, r in idx.items()}
    out, report, picked = {}, {}, {}
    lakes = sorted(s for s, k in kind.items() if k == 'lake')
    for slug in lakes:
        c = chain.get(slug)
        rec = idx[slug]
        cen = rec.get('centroid') or (binds.get(slug) or {}).get('centroid')
        pts = outline_points(chartpack, slug, cen)
        rows, why = [], []
        own = binds.get(slug) or {}
        pool = own.get('pool')
        if pool and pool.get('usgs_site'):
            have = params.of(pool['usgs_site'])
            code = next((x for x in LAKE_LEVEL if x in have), None)
            if code:
                rows.append({'site': pool['usgs_site'], 'param': code, 'role': 'level',
                             'name': gauge_name(pool), 'via': slug, 'km': 0})
            else:
                why.append(f"pool gauge {pool['usgs_site']} reports no lake level now")
        if not c:
            why.append('not in water_chain.json')
        else:
            for role, waters, want in (('outflow', c.get('outlets') or [], [DISCHARGE]),
                                       ('inflow', c.get('upstream') or [], [DISCHARGE, STAGE])):
                rivers = [w for w in waters if kind.get(w) == 'river']
                for w in waters:
                    if kind.get(w) != 'river':
                        why.append(f'{role} {w} is a {kind.get(w) or "water not in the app"}, not a river')
                        continue
                    gs = bound_gauges(binds.get(w) or {})
                    mine = words(label.get(w, w)) - {'river', 'creek', 'lake'}
                    others = [words(label.get(o, o)) - {'river', 'creek', 'lake'} for o in rivers if o != w]
                    g, code, d = nearest_reporting(pts, gs, want, params, mine, others)
                    if not g:
                        why.append(f'{role} {w}: none of {len(gs)} bound gauges reports {"/".join(want)}')
                        continue
                    rows.append({'site': g['usgs_site'], 'param': code, 'role': role,
                                 'name': gauge_name(g), 'via': w, 'viaName': label.get(w, w),
                                 'km': round(d, 1)})
        picked[slug] = (rows, why, (c or {}).get('routed_drainage_km2'))
    # Drainage areas for the gauges picked, only: a few bulk requests, not one per candidate.
    if drainage is None:
        sites = sorted({r['site'] for rows, _, _ in picked.values() for r in rows if r['role'] != 'level'})
        drainage = drainage_areas(sites, offline=params.offline,
                                  cache_path=params.path and params.path.replace('_params.json', '_drainage.json'))
    for slug, (rows, why, km2) in picked.items():
        rows, dropped = keep_this_lakes_water(rows, km2, drainage)
        why.extend(dropped)
        if rows:
            out[slug] = rows
        report[slug] = {'gauges': rows, 'why_not': why}
    return out, report


def render(table, read_at):
    return json.dumps({
        '_note': ('Personal use only, not for distribution or resale; not for navigation. Built by '
                  'Scripts/build_moving_water.py from water_bindings.json and water_chain.json: each '
                  "lake's own level gauge, the first gauge below it on each river it empties into, the "
                  'last gauge above it on each river that feeds it. No lake is named by hand (item 46).'),
        'usgs_read_at': read_at,
        'waters': table,
    }, indent=1, sort_keys=True, ensure_ascii=False) + '\n'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--report', default=None, help='where to write the per-lake report (not the registry)')
    ap.add_argument('--check', action='store_true', help='exit 1 when the generated file is stale')
    ap.add_argument('--offline', action='store_true', help='use only the cached parameter answers')
    ap.add_argument('--reuse-params', action='store_true',
                    help='keep the parameter answers already cached rather than asking USGS again')
    a = ap.parse_args()
    registry = _find('registry/lake_index.json')
    chartpack = _find('chartpack')
    if not registry or not chartpack:
        sys.exit('cannot find registry/ or chartpack/')
    registry = os.path.dirname(registry)
    target = os.path.join(registry, 'moving_water_gauges.json')
    params = Params(os.path.join(registry, '_bindings_cache', 'moving_water_params.json'),
                    offline=a.offline or a.check, reuse=a.reuse_params)
    table, report = build(registry, chartpack, params)
    params.save()
    text = render(table, params.read_at)
    if a.check:
        cur = open(target, encoding='utf-8').read() if os.path.exists(target) else ''
        print('moving_water_gauges.json', 'current' if cur == text else 'STALE')
        sys.exit(0 if cur == text else 1)
    with open(target, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(text)
    n = {r: sum(1 for rows in table.values() for g in rows if g['role'] == r) for r in ('level', 'outflow', 'inflow')}
    lakes = sum(1 for s in report)
    print(f'{len(table)} of {lakes} lakes have a gauge: {n}; asked USGS {params.asked} times; wrote {target}')
    if a.report:
        os.makedirs(os.path.dirname(a.report), exist_ok=True)
        with open(a.report, 'w', encoding='utf-8') as fh:
            json.dump({'_note': 'Personal use only, not for distribution or resale; not for navigation.',
                       'lakes': report}, fh, indent=1)


if __name__ == '__main__':
    main()
