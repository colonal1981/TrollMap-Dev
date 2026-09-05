#!/usr/bin/env python3
r"""fetch_nc_fish_advisories.py -- North Carolina's advisories, the third state, bound by point.

Personal use only, not for distribution or resale; not for navigation.

    py .\scripts\fetch_nc_fish_advisories.py --registry "F:\TrollMapPipeline\registry"
    py .\scripts\fetch_nc_fish_advisories.py --registry "F:\TrollMapPipeline\registry" --go
    py .\scripts\fetch_nc_fish_advisories.py --registry "F:\TrollMapPipeline\registry" --from-raw

Writes  registry\nc_fish_advisories.json  and, always, the untouched server response to
        registry\_nc_fish_advisories_raw.json

NO CREDENTIAL OF ANY KIND. The service is public and keyless.

WHY THIS SOURCE, AND NOT THE FEDERAL ONE

Every NC water in the app shows nothing under "Eating What You Keep". The obvious federal fix was
EPA's ATTAINS, reached through How's My Waterway -- and ATTAINS gives a use-support status and an
impairment cause, "not supporting fish consumption, cause: mercury", with no species and no meal
limit. It also now sits behind an api.data.gov key. Ryan, 2026-09-05: *"but why do we need epa for
this when NC has a story board for these?"* He was right. The state publishes the actual advisory,
and it is a keyless ArcGIS layer behind the story map:

    services.arcgis.com/iFBq2AW9XO0jYYF7/arcgis/rest/services
        /FA_Lakes_Rivers_Points_Complete/FeatureServer/38      94 point features

    Wtr_Bdy   Badin Lake              Conty_x / CntyAff  Stanly,Montgomery
    Fsh_Spc   catfish and largemouth bass
    Pollutnt  Mercury, Polychlorinated biphenyls (PCBs)
    Popultn   Pregnant Persons & Children < 15    MlsAllw  0
    Popultn   Everyone                            MlsAllw  1/week

THE FIELDS CALLED `Lat` AND `Long` ARE NOT A LATITUDE AND A LONGITUDE. Badin Lake reads
`Lat: 4226366.4566, Long: -8918057.5933` -- Web Mercator metres, in fields named for degrees. A
parser that trusted the names would put every North Carolina advisory in the Gulf of Guinea. The
GEOMETRY is asked for in EPSG:4326 and is correct: x -80.11227, y 35.45851, which is Badin. Those
two attribute fields are never read. A value is never the type its column implies -- the SC parser
met the same thing in a field called `Waterbody_URL` whose content is prose.

ONE WATER IS SEVERAL ROWS, one per population. Badin has two: the same species and contaminant
with a meal limit of 0 for pregnant people and children under 15, and 1/week for everyone. So a
slug holds a LIST, exactly as SC and GA already do, and the population travels with every limit --
"one meal a week" and "none" are the same advisory read by two different people.

BOUND BY POINT-IN-POLYGON, THEN BY DISTANCE, AND THE NAME MUST AGREE EITHER WAY. A point is not a
polygon and our boundaries are drawn tight: measured 2026-09-05, the USGS gauge that Garmin and
the state both agree is on Lake Marion sits 543 m OUTSIDE our waterbody polygon, on the dam. So a
containment-only rule would silently drop advisories for waters we have. A point outside every
boundary is matched to the nearest one within --max-km, and the record says which rule caught it
so a bad bind is visible rather than blended in.

The name test is IMPORTED from fetch_sc_fish_advisories rather than written again. Three copies of
"do these two names mean the same water" is how the approve and delete paths drifted apart.
"""
from __future__ import annotations
import argparse
import json
import math
import os
import sys
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_sc_fish_advisories import name_agrees          # noqa: E402  one name test, not three

SERVICE = ('https://services.arcgis.com/iFBq2AW9XO0jYYF7/arcgis/rest/services'
           '/FA_Lakes_Rivers_Points_Complete/FeatureServer/38')
OUT_NAME = 'nc_fish_advisories.json'
RAW_NAME = '_nc_fish_advisories_raw.json'
UA = 'TrollMap/1.0 (personal fishing project; NC advisory reader)'

# The attribute fields that carry the advisory. `Lat` and `Long` are deliberately absent -- see
# the header. `Advisry`/`Polltnt` are the truncated twins of `Advisory`/`Pollutnt` and are read
# only as a fallback, because a duplicated column is a column that can disagree with itself.
FIELDS = ['Wtr_Bdy', 'Site', 'Conty_x', 'CntyAff', 'Fsh_Spc', 'Pollutnt', 'Polltnt',
          'Popultn', 'MlsAllw', 'Advisory', 'Advisry', 'WatrURL']


def query_url():
    p = {'where': '1=1', 'outFields': ','.join(FIELDS), 'returnGeometry': 'true',
         'outSR': '4326', 'f': 'json'}
    return SERVICE + '/query?' + urllib.parse.urlencode(p)


def fetch(url, timeout=120):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8', 'replace'))


def km(lon1, lat1, lon2, lat2):
    """Great-circle enough for a few kilometres. Degrees of longitude shrink with latitude and
    pretending they do not is a 19% error at 35 N."""
    dx = (lon2 - lon1) * 111.320 * math.cos(math.radians((lat1 + lat2) / 2))
    dy = (lat2 - lat1) * 110.574
    return math.hypot(dx, dy)


def clean(v):
    """ZERO IS A VALUE, AND ON THIS FIELD IT IS THE MOST IMPORTANT ONE.

    The layer uses the string "0" as a null marker on its image-URL columns, and the first
    version of this treated "0" as empty everywhere. `MlsAllw` is the meals-allowed field, and
    Badin Lake's row for pregnant people and children under 15 reads exactly "0" -- DO NOT EAT.
    That parser rendered the strongest advisory in the dataset as "unstated". Caught by this
    file's own test before it ever ran.

    Nothing here reads the image-URL columns, so the marker they use is not our problem. Only
    genuine emptiness is emptiness."""
    s = ('' if v is None else str(v)).strip()
    return '' if s in ('None', 'null', '<Null>', 'nan') else s


def species_list(raw):
    """"catfish and largemouth bass" -> ["catfish", "largemouth bass"]. A PRESENCE FLOOR, not a
    roster: it proves those fish are in that water and says nothing about what else is."""
    s = clean(raw).replace(' and ', ',').replace(' & ', ',').replace(';', ',')
    return [x.strip() for x in s.split(',') if x.strip()]


def build_tree(index, bounds_dir, report):
    from find_duplicate_waters import rings_of
    from geomcore import _shapely_geom
    from shapely.strtree import STRtree
    slugs, geoms = [], []
    for slug in index:
        p = os.path.join(bounds_dir, '%s.geojson' % slug)
        if not os.path.exists(p):
            continue
        g = _shapely_geom(rings_of(p))
        if g is not None and not g.is_empty and g.area > 0:
            slugs.append(slug)
            geoms.append(g)
    report['waters_with_a_boundary'] = len(geoms)
    if not geoms:
        raise SystemExit('no boundary polygons under %s -- nothing to bind to' % bounds_dir)
    return slugs, geoms, STRtree(geoms)


def bind(features, index, bounds_dir, report, max_km):
    from shapely.geometry import Point
    slugs, geoms, tree = build_tree(index, bounds_dir, report)

    bound, unbound, ambiguous = {}, [], []
    for f in features:
        a = f.get('attributes') or {}
        g = f.get('geometry') or {}
        name = clean(a.get('Wtr_Bdy')) or clean(a.get('Site'))
        x, y = g.get('x'), g.get('y')
        if x is None or y is None:
            unbound.append({'name': name, 'why': 'feature carries no geometry'})
            continue
        # A SANITY GATE ON THE COORDINATE ITSELF, because the attribute fields in this service are
        # Web Mercator and a future schema change could put those values in the geometry too.
        if not (-90 <= x <= -70 and 30 <= y <= 40):
            unbound.append({'name': name, 'x': x, 'y': y,
                            'why': 'geometry is not a Carolina degree pair -- refusing to guess'})
            continue
        pt = Point(x, y)

        inside = [(slugs[i], 0.0) for i in tree.query(pt) if geoms[i].contains(pt)]
        rule = 'point inside our boundary'
        if not inside:
            near = []
            for i, gm in enumerate(geoms):
                c = gm.centroid
                d = km(x, y, c.x, c.y)
                if d <= max_km * 3:                    # cheap pre-filter, then the true distance
                    p2 = gm.exterior.interpolate(gm.exterior.project(pt)) \
                        if gm.geom_type == 'Polygon' else c
                    near.append((slugs[i], km(x, y, p2.x, p2.y)))
            near = [n for n in near if n[1] <= max_km]
            inside = sorted(near, key=lambda t: t[1])[:4]
            rule = 'nearest boundary within %g km' % max_km

        hits = [(s, d) for s, d in inside
                if name_agrees(name, index[s].get('display_name') or s)]
        if not hits:
            unbound.append({'name': name, 'why': 'no water both matches the point and shares a '
                                                 'distinctive name token',
                            'considered': [s for s, _ in inside]})
            continue
        if len(hits) > 1 and len({s for s, _ in hits}) > 1 and hits[0][1] == hits[1][1]:
            ambiguous.append({'name': name, 'candidates': [s for s, _ in hits]})
            continue
        slug, dist = hits[0]
        bound.setdefault(slug, []).append({'attributes': a, 'rule': rule,
                                           'km_from_our_boundary': round(dist, 3)})
    return bound, ambiguous, unbound


def shape(bound, index):
    waters = {}
    for slug, rows in sorted(bound.items()):
        rec = index[slug]
        adv, seen = [], {}
        for r in rows:
            a = r['attributes']
            entry = {
                'waterbody_as_published': clean(a.get('Wtr_Bdy')),
                'site_as_published': clean(a.get('Site')),
                'population': clean(a.get('Popultn')) or 'unstated',
                'meals_allowed': clean(a.get('MlsAllw')) or 'unstated',
                'contaminant': clean(a.get('Pollutnt')) or clean(a.get('Polltnt')),
                'species': species_list(a.get('Fsh_Spc')),
                'advice': clean(a.get('Advisory')) or clean(a.get('Advisry')),
                'counties': [c for c in clean(a.get('CntyAff') or a.get('Conty_x')).split(',')
                             if c],
                'confidence': 'name+geom',
                'matched_by': r['rule'],
                'km_from_our_boundary': r['km_from_our_boundary'],
                'source': SERVICE,
            }
            key = (entry['population'], entry['meals_allowed'], tuple(entry['species']))
            if key in seen:                            # the layer repeats a row per map symbol
                continue
            seen[key] = True
            adv.append(entry)
        # THE FLOOR IS THE UNION OF THE SPECIES NAMED, and every one of them carries the meal
        # limit that named it -- "one meal a week" and "do not eat" are both statements that the
        # fish is in the water, and only one of them is safe to keep.
        floor = {}
        for e in adv:
            for sp in e['species']:
                floor.setdefault(sp.lower(), {'species': sp, 'advice': []})
                floor[sp.lower()]['advice'].append(
                    {'population': e['population'], 'meals_allowed': e['meals_allowed'],
                     'contaminant': e['contaminant']})
        waters[slug] = {'display_name': rec.get('display_name') or slug,
                        'state': rec.get('state'), 'advisories': adv,
                        'species': sorted(floor.values(), key=lambda s: s['species'].lower())}
    return waters


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', default=os.environ.get('TROLLMAP_REGISTRY',
                                                         r'F:\TrollMapPipeline\registry'))
    ap.add_argument('--go', action='store_true', help='write the registry file')
    ap.add_argument('--from-raw', action='store_true', help='replay the saved response, no network')
    ap.add_argument('--max-km', type=float, default=1.5,
                    help='how far outside a boundary a point may sit and still bind')
    a = ap.parse_args(argv)
    reg = a.registry
    if not os.path.isdir(reg):
        raise SystemExit('registry not found: %s' % reg)
    raw_fp = os.path.join(reg, RAW_NAME)

    if a.from_raw:
        if not os.path.exists(raw_fp):
            raise SystemExit('no saved response at %s -- run once without --from-raw' % raw_fp)
        doc = json.load(open(raw_fp, encoding='utf-8'))
    else:
        doc = fetch(query_url())
        # ALWAYS SAVED, BEFORE ANYTHING IS PARSED. The session that writes this parser cannot
        # reach the host; the only way to test a change against the real bytes is to have them.
        with open(raw_fp, 'w', encoding='utf-8', newline='\n') as fh:
            json.dump(doc, fh, indent=1, ensure_ascii=False)
            fh.write('\n')
        print('raw response saved -> %s' % raw_fp)

    if 'error' in doc:
        raise SystemExit('service returned an error: %s' % json.dumps(doc['error'])[:300])
    features = doc.get('features') or []
    print('%d advisory feature(s) from the service' % len(features))
    if not features:
        raise SystemExit('no features -- refusing to write an empty advisory file over a good one')

    IDX = {k: v for k, v in json.load(
        open(os.path.join(reg, 'lake_index.json'), encoding='utf-8')).items()
        if isinstance(v, dict)}
    report = {}
    bound, ambiguous, unbound = bind(features, IDX, os.path.join(reg, 'boundaries'),
                                     report, a.max_km)
    waters = shape(bound, IDX)

    print('   %d water(s) bound, %d ambiguous, %d unbound'
          % (len(waters), len(ambiguous), len(unbound)))
    for slug, w in sorted(waters.items()):
        sp = ', '.join(s['species'] for s in w['species'][:4])
        print('   %-44s %d advisory row(s)  %s' % (w['display_name'][:44], len(w['advisories']), sp))
    for u in unbound[:20]:
        print('   !! unbound: %-34s %s' % ((u.get('name') or '?')[:34], u.get('why')))
    if len(unbound) > 20:
        print('   !! ... and %d more unbound' % (len(unbound) - 20))
    for am in ambiguous:
        print('   ?? ambiguous: %s -> %s' % (am['name'], am['candidates']))

    if not a.go:
        print()
        print('dry run. Re-run with --go to write %s' % os.path.join(reg, OUT_NAME))
        return 0

    out = {'_note': 'NC fish consumption advisories. A PRESENCE FLOOR for species and safety '
                    'advice in its own right. It unions in UNDERNEATH a roster and must never '
                    'overwrite one. One water holds several rows, one per population.',
           'source': 'NCDHHS Occupational and Environmental Epidemiology, fish consumption '
                     'advisories -- the layer behind the state story map',
           'source_service': SERVICE,
           'confidence': 'name+geom',
           'generated': __import__('datetime').date.today().isoformat(),
           'features_read': len(features),
           'report': dict(report, bound=len(waters), ambiguous=ambiguous, unbound=unbound),
           'waters': waters}
    out_fp = os.path.join(reg, OUT_NAME)
    with open(out_fp, 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(out, fh, indent=1, ensure_ascii=False)
        fh.write('\n')
    print('-> %s   (%d KB)' % (out_fp, round(os.path.getsize(out_fp) / 1024)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
