#!/usr/bin/env python3
"""wqp_clarity_coverage.py - which of our lakes actually have a clarity measurement.

Personal use only, not for distribution or resale; not for navigation.

PowerShell:

    py .\\wqp_clarity_coverage.py `
       --registry "F:\\TrollMapPipeline\\registry" `
       --out      "F:\\TrollMapPipeline\\registry\\_wqp_clarity_coverage.json"

WHY THIS EXISTS

`getLakeClarity()` now uses a measured secchi baseline where one exists and falls back to the
rainfall model where one does not. Those are very different answers and the app labels them
differently, so the first question is: for how many of our waters is it the good answer?

Spot checks on 2026-08-06 said SC and GA are well covered, NC is thin, and TN reservoirs have
effectively nothing -- TVA measures secchi but does not submit it to WQP under these
characteristic names. This script replaces those four spot checks with a full count.

METHOD, AND WHY IT IS NOT ONE QUERY PER LAKE

3,258 registry lakes at up to 25 seconds each is a day of waiting. Instead: ONE query per state
for every secchi station in it, then a spatial join into each lake's own `bounds_wsen`. Four
requests total.

**Deliberately no `siteType` filter.** WQP types five of Lake Norman's secchi stations as
`Stream` because they sit on the Catawba corridor. Filtering to `Lake, Reservoir, Impoundment`
would report Norman as having zero clarity data when it has five stations inside its own
boundary. Geometry decides, not the supplier's label.

TWO TRAPS THIS ALREADY HANDLES

1. **WQP rejects `+` for a space.** `urlencode` produces `+` by default and the request comes
   back empty rather than erroring. Every parameter here is encoded with `quote()` and
   `safe=''`, which produces `%20`. The same note is in `Worker/research/limnology.js`.
2. **A default Python User-Agent gets blocked.** Same defect that 403'd `r2_audit.py` against
   Cloudflare on 2026-08-05. A real UA string is sent.

The output is a decision input, not a verdict: a lake with zero stations is one nobody has
measured, which is NOT the same as clear water and must never render as such.
"""
import argparse, json, os, sys, time, collections
from urllib.parse import quote
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

WQP = 'https://www.waterqualitydata.us/data/Station/search'
UA = 'TrollMap/1.0 (personal fishing app; https://github.com/colonal1981/TrollMap-Dev)'

FIPS = {'SC': '45', 'NC': '37', 'GA': '13', 'TN': '47',
        'AL': '01', 'FL': '12', 'KY': '21', 'VA': '51', 'MS': '28'}

DEFAULT_CHARACTERISTIC = 'Depth, Secchi disk depth'


def fetch_stations(state, characteristic, since, timeout):
    """Every station in one state reporting `characteristic`. CSV, streamed to a list of dicts."""
    params = [
        ('statecode', 'US:' + FIPS[state]),
        ('characteristicName', characteristic),
        ('startDateLo', since),
        ('mimeType', 'csv'),
        ('zip', 'no'),
    ]
    url = WQP + '?' + '&'.join('%s=%s' % (k, quote(str(v), safe='')) for k, v in params)
    req = Request(url, headers={'User-Agent': UA})
    try:
        with urlopen(req, timeout=timeout) as r:
            raw = r.read().decode('utf-8', 'replace')
    except HTTPError as e:
        print('  %s: HTTP %s -- %s' % (state, e.code, url[:110]))
        return None
    except (URLError, TimeoutError) as e:
        print('  %s: %s' % (state, e))
        return None

    lines = raw.splitlines()
    if len(lines) < 2:
        print('  %s: no rows returned' % state)
        return []
    import csv, io
    rows = list(csv.DictReader(io.StringIO(raw)))
    print('  %s: %d stations' % (state, len(rows)))
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', required=True, help='folder holding lakes.json')
    ap.add_argument('--out', required=True, help='JSON coverage report to write')
    ap.add_argument('--states', default='SC,NC,GA,TN')
    ap.add_argument('--characteristic', default=DEFAULT_CHARACTERISTIC,
                    help='WQP characteristicName. Use "Turbidity" to map the other clarity signal.')
    ap.add_argument('--since', default='01-01-2015', help='MM-DD-YYYY (WQP wants this order)')
    ap.add_argument('--min-acres', type=float, default=0.0,
                    help='ignore lakes smaller than this; the registry has thousands of farm ponds '
                         'nobody has ever sampled and they drown the signal')
    ap.add_argument('--timeout', type=int, default=180)
    a = ap.parse_args()

    want = [s.strip().upper() for s in a.states.split(',') if s.strip()]
    unknown = [s for s in want if s not in FIPS]
    if unknown:
        sys.exit('unknown state code(s): %s' % ', '.join(unknown))

    reg_path = os.path.join(a.registry, 'lakes.json')
    reg = json.load(open(reg_path, encoding='utf-8-sig'))
    lakes = reg['lakes'] if isinstance(reg, dict) else reg
    lakes = [x for x in lakes
             if (x.get('state') or '').upper() in want
             and (x.get('area_km2') or 0) * 247.105 >= a.min_acres
             and x.get('bounds_wsen')]
    print('%d lakes in %s at >= %.0f acres' % (len(lakes), ','.join(want), a.min_acres))

    print('querying WQP for "%s" since %s ...' % (a.characteristic, a.since))
    stations = {}
    for st in want:
        rows = fetch_stations(st, a.characteristic, a.since, a.timeout)
        if rows is None:
            sys.exit('aborting: %s failed. Partial output would look like a coverage answer.' % st)
        stations[st] = rows
        time.sleep(1)          # be polite; WQP is a shared public service

    # Spatial join. bounds_wsen is [west, south, east, north].
    report, hit_total = {}, 0
    for lk in lakes:
        w, s, e, n = lk['bounds_wsen']
        st = (lk.get('state') or '').upper()
        found = []
        for row in stations.get(st, []):
            try:
                lat = float(row.get('LatitudeMeasure') or '')
                lon = float(row.get('LongitudeMeasure') or '')
            except ValueError:
                continue
            if s <= lat <= n and w <= lon <= e:
                found.append({
                    'id': row.get('MonitoringLocationIdentifier'),
                    'name': row.get('MonitoringLocationName'),
                    'type': row.get('MonitoringLocationTypeName'),
                    'provider': row.get('ProviderName'),
                    'lat': lat, 'lon': lon,
                })
        report[lk['slug']] = {
            'name': lk.get('display_name') or lk.get('name'),
            'state': st,
            'acres': round((lk.get('area_km2') or 0) * 247.105, 1),
            'stationCount': len(found),
            'stations': found[:12],
        }
        if found:
            hit_total += 1

    json.dump({'characteristic': a.characteristic, 'since': a.since,
               'generatedBy': 'Scripts/wqp_clarity_coverage.py',
               'lakes': report}, open(a.out, 'w', encoding='utf-8'), indent=1)

    print('\n%d of %d lakes have at least one station (%.1f%%)'
          % (hit_total, len(lakes), 100.0 * hit_total / max(1, len(lakes))))
    by_state = collections.Counter()
    tot_state = collections.Counter()
    for r in report.values():
        tot_state[r['state']] += 1
        if r['stationCount']:
            by_state[r['state']] += 1
    for st in want:
        print('  %s  %4d of %4d  (%.0f%%)'
              % (st, by_state[st], tot_state[st],
                 100.0 * by_state[st] / max(1, tot_state[st])))

    covered = sorted((r for r in report.values() if r['stationCount']),
                     key=lambda r: -r['acres'])
    print('\nbiggest waters WITH measurements:')
    for r in covered[:15]:
        print('   %-42s %-3s %9.0f ac  %2d station(s)'
              % (r['name'][:42], r['state'], r['acres'], r['stationCount']))

    bare = sorted((r for r in report.values() if not r['stationCount']),
                  key=lambda r: -r['acres'])
    print('\nbiggest waters WITHOUT any -- these fall back to the rainfall model:')
    for r in bare[:15]:
        print('   %-42s %-3s %9.0f ac' % (r['name'][:42], r['state'], r['acres']))
    print('\n-> %s' % a.out)


if __name__ == '__main__':
    main()
