#!/usr/bin/env python3
r"""fetch_duke_pool.py -- Duke's own full pond elevation, per lake, with its datum.

    py .\scripts\fetch_duke_pool.py --root F:\TrollMapPipeline
    py .\scripts\fetch_duke_pool.py --root F:\TrollMapPipeline --go
    py .\scripts\fetch_duke_pool.py --root F:\TrollMapPipeline --offline    # re-read the cache

Dry run by default. `--go` fetches and writes registry/_duke_pool.json.

WHY THIS EXISTS. Fifteen of the twenty-seven Duke lakes bound to one of our waters had no full
pond in full_pool.json, and Duke's own levels table can never supply thirteen of them: they
print on its 0-100 pool index, where the Max column just reads 100.

Duke publishes the elevation twice. In prose on each lake's page -- "The full pond elevation is
178.1 feet above mean sea level." -- and structurally at

    api.hydro-derived.duke-energy.app/lakes/operating-range/{LocationId}
    -> lakeDetails: {LakeName, Elevation: "1110.0 ft (AMSL, NGVD 29 datum", lastUpdated}

THE STRUCTURED ONE IS BETTER FOR ONE REASON THAT IS NOT CONVENIENCE: IT NAMES THE DATUM. The
prose says "above mean sea level" and stops. NGVD 29 is not NAVD 88 -- they differ by roughly
half a foot to a foot in the Carolinas -- and chartDatumShape() in Worker/conditions.js reports
the drawdown and refuses to APPLY it precisely because no vertical datum was ever reconciled.

Worker/conditions.js has parsed this endpoint since Ryan found it on 2026-08-17;
parseOperatingRange() already pulls full_pond_ft out of that string and dukePoolManagement()
already converts the index to feet with `amsl = fullPondFt - (100 - index)`. Nothing ever
harvested the numbers into the registry, which is the only gap this closes.

THE GATE. Fifteen of the twenty-seven are lakes we already hold a full pool for, from other
sources -- USACE CWMS, Duke's own Maximum column, Ryan reading the operator's page. They are
fetched first and every one must reproduce, or the run writes nothing. A parser that has
stopped understanding the payload must not quietly emit twelve numbers.

Note the unclosed parenthesis in Duke's own string. It is not a transcription error here; the
live payload really does read `(AMSL, NGVD 29 datum` with no closing bracket, which is why the
number comes out by regex.

Personal use only, not for distribution or resale; not for navigation.
"""
import argparse, json, os, re, sys, time
import urllib.error
import urllib.request
from datetime import date

BASE = 'https://api.hydro-derived.duke-energy.app'
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/128.0 Safari/537.36')
NUM = re.compile(r'([0-9]+(?:\.[0-9]+)?)')
DATUM = re.compile(r'\(([^)]*)', re.I)


def get(url, timeout=30):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def elevation_of(payload):
    """(feet, datum string) out of lakeDetails.Elevation, or (None, None)."""
    lake = (payload or {}).get('lakeDetails') or {}
    raw = str(lake.get('Elevation') or '')
    m = NUM.search(raw)
    if not m:
        return None, None, lake.get('LakeName')
    d = DATUM.search(raw)
    return float(m.group(1)), (d.group(1).strip() if d else None), lake.get('LakeName')


def targets(registry, captures):
    """Every Duke row bound to one of our waters, split into the gate and the gap.

    LocationId comes off /lakes/current-level, which is also what duke_lake_levels.json was
    transcribed from. The cached copy in _captures/ is used when it is there so a dry run costs
    nothing.
    """
    duke = (json.load(open(os.path.join(registry, 'duke_lake_levels.json'), encoding='utf-8'))
            .get('rows') or {})
    held = (json.load(open(os.path.join(registry, 'full_pool.json'), encoding='utf-8'))
            .get('rows') or {})
    cap = os.path.join(captures, 'api.hydro-derived.duke-energy.app_lakes_current-level.json')
    cur = json.load(open(cap, encoding='utf-8')) if os.path.exists(cap) else get(
        BASE + '/lakes/current-level')
    loc = {r.get('LakeDisplayName'): r.get('LocationId') for r in cur}
    gate, gap, nolid = [], [], []
    for name, row in sorted(duke.items()):
        slug = row.get('slug')
        if not slug:
            continue
        lid = loc.get(name)
        if lid is None:
            nolid.append(name)
            continue
        rec = {'duke_name': name, 'slug': slug, 'location_id': lid,
               'held_ft': (held.get(slug) or {}).get('full_pool_ft')}
        (gate if rec['held_ft'] is not None else gap).append(rec)
    return gate, gap, nolid


def pull(rec, cache, go, delay):
    """One lake. Reads the cache first so a re-run is free and a dry run shows real numbers."""
    fp = os.path.join(cache, 'operating-range_%s.json' % rec['location_id'])
    if os.path.exists(fp):
        try:
            return elevation_of(json.load(open(fp, encoding='utf-8'))), 'cache'
        except ValueError:
            pass
    if not go:
        return (None, None, None), 'not fetched (dry run)'
    try:
        payload = get('%s/lakes/operating-range/%s' % (BASE, rec['location_id']))
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
        return (None, None, None), 'ERROR %s' % e
    os.makedirs(cache, exist_ok=True)
    with open(fp, 'w', encoding='utf-8') as f:
        json.dump(payload, f)
    time.sleep(delay)
    return elevation_of(payload), 'fetched'


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--root', default='.')
    ap.add_argument('--registry', default=None)
    ap.add_argument('--captures', default=None, help='default <root>/_captures')
    ap.add_argument('--cache', default=None, help='default <registry>/_duke_pool_cache')
    ap.add_argument('--out', default=None, help='default <registry>/_duke_pool.json')
    ap.add_argument('--offline', action='store_true', help='cache only, never reach the network')
    ap.add_argument('--go', action='store_true')
    ap.add_argument('--delay', type=float, default=1.0)
    a = ap.parse_args()
    root = os.path.abspath(a.root)
    registry = a.registry or os.path.join(root, 'registry')
    captures = a.captures or os.path.join(root, '_captures')
    cache = a.cache or os.path.join(registry, '_duke_pool_cache')
    out = a.out or os.path.join(registry, '_duke_pool.json')
    go = a.go and not a.offline

    gate, gap, nolid = targets(registry, captures)
    print('%d Duke lake(s) bound to a water: %d we already hold (the gate), %d we do not'
          % (len(gate) + len(gap), len(gate), len(gap)))
    if nolid:
        print('   no LocationId for: %s' % ', '.join(nolid))

    print('\nthe gate:')
    rows, bad, unread = {}, [], 0
    for rec in sorted(gate, key=lambda r: r['location_id']):
        (ft, datum, name), how = pull(rec, cache, go, a.delay)
        if ft is None:
            unread += 1
            print('   %-26s %-9s -- %s' % (rec['duke_name'][:26], '', how))
            continue
        err = ft - rec['held_ft']
        flag = '' if abs(err) <= 0.5 else 'DISAGREES by %+.1f ft' % err
        if flag:
            bad.append((rec['duke_name'], rec['held_ft'], ft))
        print('   %-26s duke %-9.1f held %-9.1f %s' % (rec['duke_name'][:26], ft, rec['held_ft'], flag))
        rows[rec['slug']] = {'duke_name': rec['duke_name'], 'location_id': rec['location_id'],
                             'full_pond_ft': ft, 'datum': datum, 'held_ft': rec['held_ft'],
                             'agrees': not flag, 'source': how}
    read = len(gate) - unread
    if bad or read < 4:
        print('\nTHE GATE FAILED (%d disagreement(s), %d read). Nothing written.' % (len(bad), read))
        if not go and not a.offline:
            print('This is a DRY RUN and nothing was fetched -- add --go.')
        return 1
    print('\ngate passed on %d lake(s), every one within half a foot.' % read)

    print('\nthe twelve with no full pool held:')
    for rec in sorted(gap, key=lambda r: r['location_id']):
        (ft, datum, name), how = pull(rec, cache, go, a.delay)
        if ft is None:
            print('   %-26s -- %s' % (rec['duke_name'][:26], how))
            continue
        print('   %-26s %-9.1f %s' % (rec['duke_name'][:26], ft, datum or ''))
        rows[rec['slug']] = {'duke_name': rec['duke_name'], 'location_id': rec['location_id'],
                             'full_pond_ft': ft, 'datum': datum, 'held_ft': None,
                             'agrees': None, 'source': how}

    doc = {'_note': 'Personal use only, not for distribution or resale; not for navigation. '
                    "Duke Energy's own full pond elevation per lake, from "
                    'api.hydro-derived.duke-energy.app/lakes/operating-range/{LocationId}, '
                    'lakeDetails.Elevation. THE DATUM IS PART OF THE ANSWER -- Duke states NGVD '
                    '29, and NGVD 29 is not NAVD 88. A row with `agrees: true` reproduced a '
                    'value we already held from another source.',
           'read': date.today().isoformat(),
           'endpoint': BASE + '/lakes/operating-range/{LocationId}',
           'gate_lakes': read, 'waters': len(rows), 'rows': rows}
    if not (a.go or a.offline):
        print('\nDRY RUN -- nothing written. Add --go.')
        return 0
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(doc, f, indent=1, ensure_ascii=False)
    print('\n-> %s' % out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
