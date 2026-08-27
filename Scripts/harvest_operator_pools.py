#!/usr/bin/env python3
"""harvest_operator_pools.py - read the OPERATOR pages already on disk and emit full pool.

Personal use only, not for distribution or resale; not for navigation.

    py .\scripts\harvest_operator_pools.py --pagesrc F:\TrollMapPipeline\_pagesrc `
       --registry F:\TrollMapPipeline\registry

WHY THIS EXISTS. Three operator pages sat in `_pagesrc/` from 2026-08-16 to 2026-08-27 unread,
while this project harvested aggregators and Ryan pasted the same tables into a session ten
times. When the operator numbers were finally read they corrected SIX aggregator values and
settled four of five "needs a second source" candidates -- Jackson by 2.0 ft, Carters by 2.0,
Seed by 1.5, Tugalo by 0.5.

THE DATUM RULE, which is why the FULL column is the one to take:
FULL POOL IS THE MAXIMUM OF THE OPERATING TARGET, NOT ITS CURRENT VALUE. Every operator also
publishes a target that reads like a datum and sits below it. Confusing the two is how Murray
was stored as 358 (summer target) instead of 360, and Santee Cooper as 75.0 instead of 76.8.

Each parser returns (name, full_pool_ft, reading_ft). A parser that finds nothing says so and
does not fail the run -- a page layout changes without warning and a silent zero-row harvest
reads exactly like "the operator stopped publishing".
"""
import argparse, html, json, os, re, sys

def _cells(row):
    return [html.unescape(re.sub(r'<[^>]+>', '', c)).strip()
            for c in re.findall(r'<t[dh][^>]*>(.*?)</t[dh]>', row, re.S | re.I)]

def _num(s):
    m = re.search(r'-?\d+(?:\.\d+)?', (s or '').replace(',', ''))
    return float(m.group()) if m else None

def parse_southernco(text):
    """Georgia Power: Lake | Gen | Rain | Current Elevation | FULL ELEVATION."""
    out = []
    for row in re.findall(r'<tr[^>]*>(.*?)</tr>', text, re.S | re.I):
        c = _cells(row)
        if len(c) < 5 or not c[0]:
            continue
        cur, full = _num(c[-2]), _num(c[-1])
        if full is None or cur is None:
            continue
        out.append((c[0], full, cur))
    return out

def parse_cube(text):
    """Cube Hydro: Lake | Elevation | FT BELOW FULL POND | Forecast. Full pool is the sum."""
    out = []
    for row in re.findall(r'<tr[^>]*>(.*?)</tr>', text, re.S | re.I):
        c = _cells(row)
        if len(c) < 3 or not c[0]:
            continue
        elev, below = _num(c[1]), _num(c[2])
        if elev is None or below is None:
            continue
        out.append((c[0], round(elev + below, 2), elev))
    return out

def parse_brookfield(text):
    """Brookfield: embedded JSON metrics, and the LABELS ARE NOT CONSISTENT.

    Santeetlah describes its deficit with the station name; Chilhowee's elevation carries a null
    unit; Cheoah spells it "Feet Below Full Pool". Matching on the description found 2 of 4.
    So match on SHAPE instead: for one station, the value above 100 is an elevation in feet and
    the value under 50 in magnitude is the deficit. Every water Brookfield publishes here sits
    above 800 ft, so the two cannot be confused -- and a station that does not show exactly one
    of each is skipped rather than guessed at.
    """
    vals = {}
    for blob in re.findall(r'\{"id":"[0-9a-f-]+",.*?\}', text):
        try:
            o = json.loads(blob)
        except ValueError:
            continue
        st, val = o.get('station') or o.get('metric_name'), _num(o.get('value'))
        if not st or val is None:
            continue
        if 'flow' in (o.get('description') or '').lower() or 'discharge' in (o.get('description') or '').lower():
            continue
        if (o.get('unit') or '').lower().startswith('cf'):
            continue
        vals.setdefault(st.strip(), set()).add(val)
    out = []
    for st, vs in sorted(vals.items()):
        big = [v for v in vs if v > 100]
        small = [v for v in vs if abs(v) < 50]
        if len(big) != 1 or len(small) != 1:
            continue
        out.append((st, round(big[0] + abs(small[0]), 2), big[0]))
    return out

SOURCES = [
    ('Southern Company / Georgia Power', ['_raw_southernco.html', 'southernco.html'], parse_southernco),
    ('Cube Hydro Carolinas',             ['_raw_cube.html', 'cube.html'],             parse_cube),
    ('Brookfield Renewable',             ['brookfield_santeetlah.html'],               parse_brookfield),
]

def norm(s):
    return re.sub(r'[^a-z]', '', (s or '').lower()
                  .replace('lake', '').replace('reservoir', '').split('(')[0])

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pagesrc', required=True)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--out', default=None)
    ap.add_argument('--tolerance-ft', type=float, default=2.0,
                    help='a harvested value further than this from a held operator number is a '
                         'WRONG WATER, not a correction. Refused and recorded, never written.')
    a = ap.parse_args()

    index = os.path.join(a.registry, 'lake_index.json')
    byname = {}
    if os.path.exists(index):
        doc = json.load(open(index, encoding='utf-8'))
        rows = doc if isinstance(doc, list) else (doc.get('lakes') or doc.get('rows') or list(doc.values()))
        for r in rows:
            if isinstance(r, dict) and r.get('slug'):
                for n in (r.get('name'), r.get('display_name')):
                    if n:
                        byname.setdefault(norm(n), r['slug'])

    held = {}
    fp = os.path.join(a.registry, 'full_pool.json')
    if os.path.exists(fp):
        for k, v in (json.load(open(fp, encoding='utf-8')).get('rows') or {}).items():
            if isinstance(v, dict) and v.get('full_pool_ft') is not None:
                held[k] = float(v['full_pool_ft'])
    out, unbound, empty, refused = {}, [], [], []
    for label, names, fn in SOURCES:
        path = next((os.path.join(a.pagesrc, n) for n in names
                     if os.path.exists(os.path.join(a.pagesrc, n))), None)
        if not path:
            empty.append('%s: no page on disk (%s)' % (label, ', '.join(names)))
            continue
        found = fn(open(path, encoding='utf-8', errors='replace').read())
        if not found:
            empty.append('%s: page present, ZERO rows parsed -- layout may have changed' % label)
            continue
        print('%-34s %3d rows   %s' % (label, len(found), os.path.basename(path)))
        for name, full, cur in found:
            slug = byname.get(norm(name))
            # A NAME MATCH THAT CONTRADICTS A HELD OPERATOR NUMBER IS A WRONG WATER, NOT A
            # CORRECTION. Cube publishes a lake called "Falls" at 364 ft -- Falls RESERVOIR on the
            # Yadkin. The registry's `falls_lake` is Falls LAKE on the Neuse, USACE, 251.5 ft, a
            # hundred miles away. Bare-name matching bound them and produced a 112 ft datum error
            # on a bound lake; this project has now had FIVE name matchers do this. If the value
            # disagrees with what full_pool.json already holds by more than the tolerance, the
            # match is refused and recorded -- a real correction is never a hundred feet.
            if slug and slug in held:
                gap = abs(full - held[slug])
                if gap > a.tolerance_ft:
                    refused.append({'name': name, 'source': label, 'harvested_ft': full,
                                    'held_ft': held[slug], 'slug_refused': slug, 'gap_ft': round(gap, 2)})
                    slug = None
            rec = {'full_pool_ft': full, 'reading_ft': cur, 'source': label,
                   'units': 'ft above sea level', 'slug': slug}
            out[('%s|%s' % (label, name))] = rec
            if not slug:
                unbound.append('%s (%s)' % (name, label))

    dest = a.out or os.path.join(a.registry, '_operator_pools.json')
    json.dump({'_note': ('Personal use only, not for distribution or resale; not for navigation. '
                         'FULL POOL read from OPERATOR pages in _pagesrc/. Full pool is the MAXIMUM '
                         'of the operating target, never the target itself.'),
               'rows': len(out), 'bound': sum(1 for v in out.values() if v['slug']),
               'unbound': sorted(set(unbound)), 'problems': empty,
               'refused_wrong_water': refused,
               'waters': out}, open(dest, 'w', encoding='utf-8'), indent=1)
    print('\n-> %s   %d rows, %d bound to a slug' % (dest, len(out), sum(1 for v in out.values() if v['slug'])))
    for e in empty:
        print('   !! %s' % e)
    for x in refused:
        print('   !! REFUSED %s -> %s : harvested %s vs held %s (%s ft apart)'
              % (x['name'], x['slug_refused'], x['harvested_ft'], x['held_ft'], x['gap_ft']))
    if unbound:
        print('   %d names matched no registry slug (listed in the report)' % len(set(unbound)))
    return 0

if __name__ == '__main__':
    sys.exit(main())
