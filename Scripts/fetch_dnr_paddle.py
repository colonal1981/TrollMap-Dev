#!/usr/bin/env python3
"""Pull paddle-launch access sites straight from the four state DNR ArcGIS feeds.

This is a local mirror of the Worker's /paddle route (Worker/trollmap-worker.js,
PADDLE_SOURCES + Worker/core/arcgis.js).  It exists for two reasons:

  1. The pipeline needs the paddle landings on disk in registry/ before
     make_river_boundaries.py runs, and waiting on a Worker deploy to refresh a
     cache is a bad dependency for an offline build step.
  2. It is a second, independent implementation.  Running this and diffing the
     output against `curl <worker>/paddle?state=XX` is the only check that
     catches a filter which silently rejects every row -- the failure that left
     TN at count:0 for however long, and that left GA ramps empty before it.

The output shape is byte-compatible with the Worker's response body so the two
can be diffed directly:

    {"state": "SC", "source": "<url>", "count": N,
     "waterbodies": {"<waterway>": [{"name","lat","lon","meta":{...}}, ...]}}

Usage:
    python scripts/fetch_dnr_paddle.py --out registry
    python scripts/fetch_dnr_paddle.py --state tn --stdout
    python scripts/fetch_dnr_paddle.py --state sc --compare registry/_dnr_paddle_sc.json

Personal use only, not for distribution or resale; not for navigation.
"""

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request

PAGE_SIZE = 1000
UA = 'TrollMap/1.0 (personal use)'


def _s(v):
    return '' if v is None else str(v)


def flag_yes(v):
    """Is this ArcGIS yes/no flag set?

    ArcGIS coded-value domains store a CODE and display a DESCRIPTION.  The web
    viewer shows "YES"; the REST response returns 1.  Filters written by reading
    the viewer match nothing at all.  NC's Non_Motorized_Access is exactly this:
    136 qualifying sites, 11 delivered.  Mirrors flagIsYes() in
    Worker/core/arcgis.js -- keep the two in step.
    """
    if v is True or v == 1:
        return True
    return _s(v).strip().lower() in ('y', 'yes', '1', 'true', 't')


# Mirrors PADDLE_SOURCES in Worker/trollmap-worker.js.  Keep the predicates in
# lockstep with that file -- if they drift, the --compare check below fails,
# which is the point.
_HERE = os.path.dirname(os.path.abspath(__file__))


# ── Georgia's species columns, READ FROM THE ONE DEFINITION ─────────────────────────────────
#
# This module and build_dnr_ramps_by_lake.py keep INDEPENDENT source predicates on purpose --
# a second implementation is what catches a filter that silently rejects every row, which is
# what this file's own header says it exists for. That argument does not reach a table of
# forty-eight abbreviations: a wrong predicate shows up as a count of zero and gets caught,
# while `HybStrpBas` mapped to the wrong fish is a wrong fish that looks like a right one.
#
# So the table lives once, in js/data/ga-access-species.js, which the Worker imports directly.
# Node once at import, not per feature. It lives HERE rather than in the build script because
# both need it and this is the module the build script already imports from.
def _ga_species_columns():
    import subprocess
    tries = [os.path.abspath(os.path.join(_HERE, '..', 'js', 'data', 'ga-access-species.js')),
             os.path.abspath(os.path.join(_HERE, '..', 'TrollMap-Dev', 'js', 'data',
                                          'ga-access-species.js'))]
    src = next((t for t in tries if os.path.exists(t)), None)
    if not src:
        raise SystemExit('!! cannot find ga-access-species.js -- it is the one definition of '
                         "Georgia's species columns and this script will not guess at it. "
                         'Looked in:\n    %s' % '\n    '.join(tries))
    script = ("const m = await import(%s);"
              "process.stdout.write(JSON.stringify(m.GA_ACCESS_SPECIES_COLUMNS));"
              % json.dumps('file://' + src.replace(os.sep, '/')))
    proc = subprocess.run(['node', '--input-type=module', '-e', script],
                          capture_output=True, text=True, encoding='utf-8')
    if proc.returncode != 0:
        raise SystemExit('!! could not read the Georgia species columns under node: %s'
                         % (proc.stderr or '').strip()[:300])
    return json.loads(proc.stdout)


_GA_COLUMNS = None


def ga_species(props):
    """One GA access point -> its fish, comma-joined the way SCDNR's SpeciesList arrives.

    `Y` IS THE ONLY YES. The layer's values are Y, N, U, None and blank -- counted across all
    895 points on 2026-09-02 -- and `U` is unknown, which is not a fish.
    """
    global _GA_COLUMNS
    if _GA_COLUMNS is None:
        _GA_COLUMNS = _ga_species_columns()
    return ', '.join(name for col, name in _GA_COLUMNS.items()
                     if str(props.get(col) or '').strip().upper() == 'Y')


SOURCES = {
    'sc': {
        'url': 'https://services.arcgis.com/acgZYxoN5Oj8pDLa/arcgis/rest/services/'
               'South_Carolina_Public_Water_Access_PUBLIC_VIEW/FeatureServer/0/query',
        'filter': lambda p: (p.get('WaterAccessType') == 'Paddle Launch'
                             and _s(p.get('Status')).lower() == 'active'
                             and _s(p.get('PublicAccess')).lower() != 'closed'),
        'name': lambda p: p.get('WaterAccessName'),
        'wb': lambda p: p.get('Waterbody'),
        # THE SAME LAYER AS THE RAMPS, FILTERED TO A DIFFERENT ACCESS TYPE -- so it carries
        # the same `SpeciesList`, and dropping it here meant every SC paddle launch arrived
        # with no fish while the ramp two hundred yards away arrived with ten. For a kayak the
        # paddle launch is the more relevant of the two.
        'meta': lambda p: {'subtype': p.get('WaterAccessSubType'),
                           'county': p.get('County'),
                           'owner': p.get('Owner'),
                           'species': p.get('SpeciesList')},
    },
    'nc': {
        'url': 'https://services1.arcgis.com/YfqBAUM5nWR3yhGP/arcgis/rest/services/'
               'NCWRC_Boating_Access_Areas_view/FeatureServer/0/query',
        # Non_Motorized_Access is a coded domain: viewer shows YES/NO, REST returns
        # 1/0.  Site_Status IS stored as text ('OPEN'), so that half stays a string
        # compare.  Verified 2026-08-04: where=Non_Motorized_Access=1 AND
        # Site_Status='OPEN' returns 136; the old predicate delivered 11.
        'filter': lambda p: ((flag_yes(p.get('Non_Motorized_Access'))
                              or len(_s(p.get('Portable_Boat_Access_Type')).strip()) > 0)
                             and _s(p.get('Site_Status')).lower() == 'open'),
        'name': lambda p: p.get('BAA_Name'),
        'wb': lambda p: p.get('Water_Access'),
        'meta': lambda p: {'type': p.get('Portable_Boat_Access_Type'),
                           'county': p.get('County'),
                           'owner': p.get('Owner')},
    },
    'ga': {
        'url': 'https://services6.arcgis.com/9QlSLDqa0P1cHLhu/arcgis/rest/services/'
               'WRD_Water_Access_Points/FeatureServer/0/query',
        'id_field': 'FID',
        'filter': lambda p: (flag_yes(p.get('CanoeAcc'))
                             and _s(p.get('Status')).lower() not in ('closed', 'inactive')),
        'name': lambda p: p.get('Name'),
        'wb': lambda p: p.get('Waterbody'),
        # Same WRD layer as the ramps, filtered on CanoeAcc instead of Ramp, so the same
        # forty-eight species columns are on every feature. See ga_species() above.
        'meta': lambda p: {'county': p.get('County'), 'owner': p.get('Owner'),
                           'species': ga_species(p)},
    },
    'tn': {
        'url': 'https://services3.arcgis.com/PWXNAH2YKmZY7lBq/arcgis/rest/services/'
               'Paddling_Access_Sites/FeatureServer/0/query',
        # NOT IncludeWeb.  That field exists only inside this view's
        # viewDefinitionQuery -- "(Type = 'Paddling') AND (IncludeWeb = 'Yes')" --
        # and is never returned, so testing it rejected all 34 sites.  Type is
        # returned, and re-asserting it here still means something if TWRA ever
        # repoints the view at the unfiltered AllAccessSites layer.
        # NOT CanoeLanding either: it is "No" or null on real paddle sites.
        'filter': lambda p: p.get('Type') == 'Paddling',
        'name': lambda p: p.get('Name'),
        'wb': lambda p: p.get('Waterway'),
        'meta': lambda p: {'county': p.get('County'),
                           'owner': p.get('Owner'),
                           'type': 'Paddling Access'},
    },
}


def fetch_all(url, id_field='OBJECTID', retries=3):
    feats, offset = [], 0
    while True:
        q = urllib.parse.urlencode({
            'outFields': '*', 'where': '1=1', 'f': 'geojson',
            'resultOffset': str(offset), 'resultRecordCount': str(PAGE_SIZE),
            'orderByFields': id_field,
        })
        for attempt in range(retries):
            try:
                req = urllib.request.Request(url + '?' + q,
                                             headers={'User-Agent': UA, 'Accept': 'application/json'})
                with urllib.request.urlopen(req, timeout=90) as r:
                    data = json.loads(r.read().decode('utf-8'))
                break
            except Exception as e:
                if attempt == retries - 1:
                    raise
                sys.stderr.write('  retry %d after %s\n' % (attempt + 1, e))
                time.sleep(2 * (attempt + 1))
        if 'error' in data:
            raise RuntimeError('ArcGIS error: %s' % data['error'])
        page = data.get('features') or []
        feats.extend(page)
        if len(page) < PAGE_SIZE:
            return feats
        offset += PAGE_SIZE


def group(features, src):
    wbs = {}
    kept = filtered = dropped = 0
    for f in features:
        p = f.get('properties') or {}
        if not src['filter'](p):
            filtered += 1
            continue
        geom = (f.get('geometry') or {}).get('coordinates') or [None, None]
        lat = p.get('Latitude')
        lon = p.get('Longitude')
        if lat is None:
            lat = geom[1]
        if lon is None:
            lon = geom[0]
        try:
            lat = float(lat)
            lon = float(lon)
        except (TypeError, ValueError):
            dropped += 1
            continue
        if not lat or not lon:
            dropped += 1
            continue
        wb = (_s(src['wb'](p)).strip() or 'Unknown Waterbody')
        nm = (_s(src['name'](p)).strip() or 'Unnamed')
        wbs.setdefault(wb, []).append({
            'name': nm,
            'lat': round(lat * 1e6) / 1e6,
            'lon': round(lon * 1e6) / 1e6,
            'meta': src['meta'](p),
        })
        kept += 1
    for v in wbs.values():
        v.sort(key=lambda e: e['name'])
    # Total rejection of a non-empty feed is a broken predicate, never real data.
    if features and filtered == len(features):
        raise SystemExit(
            'FILTER REJECTED ALL %d features -- the filter names a field this layer '
            'does not return. Fields present: %s'
            % (len(features), ', '.join(sorted((features[0].get('properties') or {}).keys()))))
    return wbs, {'fetched': len(features), 'kept': kept,
                 'filtered': filtered, 'dropped': dropped}


def build(state):
    src = SOURCES[state]
    feats = fetch_all(src['url'], src.get('id_field', 'OBJECTID'))
    wbs, stats = group(feats, src)
    return ({'state': state.upper(), 'source': src['url'],
             'count': stats['kept'], 'waterbodies': wbs}, stats)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--state', action='append',
                    help='sc|nc|ga|tn (repeatable; default all four)')
    ap.add_argument('--out', default=None, help='directory to write _dnr_paddle_<st>.json into')
    ap.add_argument('--stdout', action='store_true')
    ap.add_argument('--compare', default=None,
                    help='path to a Worker-produced JSON to diff against (single --state only)')
    a = ap.parse_args()
    states = [s.lower() for s in (a.state or ['sc', 'nc', 'ga', 'tn'])]
    bad = [s for s in states if s not in SOURCES]
    if bad:
        raise SystemExit('unknown state(s): %s' % ', '.join(bad))
    if a.compare and len(states) != 1:
        raise SystemExit('--compare takes exactly one --state')

    rc = 0
    for st in states:
        sys.stderr.write('%s ... ' % st.upper())
        sys.stderr.flush()
        doc, stats = build(st)
        sys.stderr.write('fetched %d, kept %d, filtered out %d, dropped %d (no coords), '
                         '%d waterbodies\n'
                         % (stats['fetched'], stats['kept'], stats['filtered'],
                            stats['dropped'], len(doc['waterbodies'])))
        body = json.dumps(doc, ensure_ascii=False)
        if a.compare:
            with open(a.compare, 'rb') as fh:
                other = json.loads(fh.read().decode('utf-8-sig'))
            same = (other.get('count') == doc['count']
                    and other.get('waterbodies') == doc['waterbodies'])
            print('%s vs %s: %s (worker count=%s, local count=%s)'
                  % (st.upper(), a.compare, 'MATCH' if same else 'DIFFER',
                     other.get('count'), doc['count']))
            if not same:
                rc = 1
                ow, lw = set(other.get('waterbodies') or {}), set(doc['waterbodies'])
                for label, s in (('worker only', ow - lw), ('local only', lw - ow)):
                    if s:
                        print('  %s: %s' % (label, ', '.join(sorted(s)[:12])))
        if a.stdout:
            print(body)
        if a.out:
            os.makedirs(a.out, exist_ok=True)
            path = os.path.join(a.out, '_dnr_paddle_%s.json' % st)
            with open(path, 'w', encoding='utf-8', newline='') as fh:
                fh.write(body)
            sys.stderr.write('  wrote %s (%d bytes)\n' % (path, len(body.encode('utf-8'))))
    return rc


if __name__ == '__main__':
    sys.exit(main())
