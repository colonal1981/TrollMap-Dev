#!/usr/bin/env python3
"""
fetch_ehydro_surveys.py -- index the USACE channel surveys that cover our water.

Personal use only, not for distribution or resale; not for navigation.

WHY THIS IS A SCRIPT AND NOT A DOWNLOAD PAGE
    Ryan, 2026-09-03: "USACE can't find what you are talking about at all". Neither would
    anyone. eHydro has no download page -- it is an ArcGIS feature service whose one layer,
    SurveyJob, holds the OUTLINE of every survey the Corps has processed, worldwide, and the
    path to its data hangs off each outline's attributes. You cannot browse to "Charleston
    District, the AIWW reaches"; you intersect polygons with a box.

WHAT IT WRITES, AND WHAT IT DOES NOT
    An INDEX, not the soundings. Each survey is a separate download of its own and there are
    thousands; pulling them all before knowing which cover water we fish would be a lot of disk
    for nothing. This records what exists per zone, when it was flown, and where its data
    lives -- then a second pass can fetch the ones worth having.

    THE CORPS SURVEYS CHANNELS, NOT LAKES. A survey covers a dredged reach; it says nothing
    about the flat beside it. A zone with no surveys is normal and is reported as such rather
    than left blank.

USAGE
    py fetch_ehydro_surveys.py                       # index every coastal + river zone
    py fetch_ehydro_surveys.py --dry-run             # print, write nothing
    py fetch_ehydro_surveys.py --zone coast_charleston_sc
    py fetch_ehydro_surveys.py --since 2020          # only surveys this recent
"""

import argparse
import glob
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone

LAYER = ('https://services7.arcgis.com/n1YM8pTrFmm7L4hs/arcgis/rest/services'
         '/eHydro_Survey_Data/FeatureServer/0')
UA = 'TrollMap/1.0 (personal use; contact via github.com/colonal1981/TrollMap-Dev)'
PAGE = 2000                     # the layer's own maxRecordCount

# The columns worth keeping. `sourcedatalocation` is the path to the survey data itself and is
# the only reason to keep the row at all; `plotsheetlocation` is the human-readable plot.
FIELDS = ('surveyjobidpk', 'sdsfeaturename', 'sdsfeaturedescription', 'surveytype',
          'usacedistrictcode', 'surveydatestart', 'surveydateend', 'sourcedatalocation',
          'plotsheetlocation', 'sourcedatacontent', 'sourceprojection', 'projectedarea')
DATE_FIELDS = ('surveydatestart', 'surveydateend')

HERE = os.path.dirname(os.path.abspath(__file__))
NOTE = 'Personal use only, not for distribution or resale; not for navigation.'


def _root():
    d = HERE
    for _ in range(4):
        if os.path.isdir(os.path.join(d, 'registry', 'boundaries')):
            return d
        d = os.path.dirname(d)
    return os.path.dirname(HERE)


# ── inputs ──────────────────────────────────────────────────────────────────────────────────
def rings(geom):
    t = (geom or {}).get('type')
    c = (geom or {}).get('coordinates')
    return [c] if t == 'Polygon' else (c if t == 'MultiPolygon' else [])


def bbox_of_file(path):
    try:
        with open(path, encoding='utf-8') as fh:
            gj = json.load(fh)
    except (OSError, ValueError):
        return None
    xs, ys = [], []
    for feat in (gj.get('features') or [gj]):
        for poly in rings(feat.get('geometry') or feat):
            for ring in poly:
                for pt in ring:
                    xs.append(pt[0])
                    ys.append(pt[1])
    return (min(xs), min(ys), max(xs), max(ys)) if xs else None


def load_zone_boxes(root, feature_types=('coastal', 'river'), only=None):
    """
    The waters to ask about, and their boxes. Derived from what is on disk, never typed.

    Coastal zones are named by their prefix; rivers come out of _feature_types.json. A water
    the registry does not classify is skipped rather than guessed at.
    """
    ft = {}
    p = os.path.join(root, 'registry', '_feature_types.json')
    if os.path.exists(p):
        try:
            with open(p, encoding='utf-8') as fh:
                raw = json.load(fh)
            for k, v in raw.items():
                ft[k] = (v.get('feature_type') if isinstance(v, dict) else v) or ''
        except (OSError, ValueError):
            pass
    out = {}
    for path in sorted(glob.glob(os.path.join(root, 'registry', 'boundaries', '*.geojson'))):
        slug = os.path.basename(path)[:-len('.geojson')]
        if only and slug not in only:
            continue
        kind = 'coastal' if slug.startswith('coast_') else str(ft.get(slug, '')).lower()
        if kind not in feature_types:
            continue
        box = bbox_of_file(path)
        if box:
            out[slug] = {'bbox': box, 'kind': kind}
    return out


# ── the service ─────────────────────────────────────────────────────────────────────────────
def query_url(bbox, offset=0, layer=LAYER, page=PAGE):
    """
    One page of surveys whose outline intersects this box.

    `returnGeometry=false` on purpose: the survey outline is not wanted, only the fact that it
    covers our water and where its data lives. Asking for geometry we would throw away turns a
    small response into a large one for every zone.
    """
    x0, y0, x1, y1 = bbox
    q = {
        'where': '1=1',
        'geometry': f'{x0},{y0},{x1},{y1}',
        'geometryType': 'esriGeometryEnvelope',
        'inSR': '4326',
        'spatialRel': 'esriSpatialRelIntersects',
        'outFields': ','.join(FIELDS),
        'returnGeometry': 'false',
        'resultOffset': str(offset),
        'resultRecordCount': str(page),
        'f': 'json',
    }
    return layer + '/query?' + urllib.parse.urlencode(q)


def parse_features(payload):
    """
    Rows out of an ArcGIS query response, with epoch-millisecond dates made readable.

    An ArcGIS error arrives with HTTP 200 and an `error` key, so a caller that only checked the
    status would read a failure as an empty result and report a zone as having no surveys.
    Raises instead.
    """
    if not isinstance(payload, dict):
        raise ValueError('not a JSON object')
    if 'error' in payload:
        e = payload['error']
        raise RuntimeError(f"service error {e.get('code')}: {e.get('message')}")
    rows = []
    for f in payload.get('features') or []:
        a = dict(f.get('attributes') or {})
        for d in DATE_FIELDS:
            v = a.get(d)
            if isinstance(v, (int, float)):
                a[d] = datetime.fromtimestamp(v / 1000.0, timezone.utc).date().isoformat()
        rows.append(a)
    return rows, bool(payload.get('exceededTransferLimit'))


def newest_per_channel(rows):
    """One row per named reach, the most recently surveyed. Unnamed reaches are kept as-is."""
    best = {}
    loose = []
    for r in rows:
        name = (r.get('sdsfeaturename') or '').strip()
        if not name:
            loose.append(r)
            continue
        cur = best.get(name)
        if cur is None or str(r.get('surveydateend') or '') > str(cur.get('surveydateend') or ''):
            best[name] = r
    return sorted(best.values(), key=lambda r: r.get('sdsfeaturename') or '') + loose


def fetch_json(url, timeout=90):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8', 'replace'))


def surveys_for(bbox, since=None, fetch=fetch_json):
    """Every survey intersecting the box, paged out. `fetch` is injectable so this is testable."""
    rows, offset = [], 0
    while True:
        page, more = parse_features(fetch(query_url(bbox, offset)))
        rows += page
        if not more or not page:
            break
        offset += len(page)
        if offset > 20000:                       # a box this productive is a bug, not a bay
            break
    if since:
        rows = [r for r in rows if str(r.get('surveydateend') or '')[:4] >= str(since)]
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--root', default=None)
    ap.add_argument('--zone', action='append', default=None, help='one slug; repeatable')
    ap.add_argument('--since', default=None, help='keep surveys ending in this year or later')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()

    root = a.root or _root()
    zones = load_zone_boxes(root, only=set(a.zone) if a.zone else None)
    if not zones:
        print(f'ERROR: no coastal or river boundaries under {root}/registry/boundaries',
              file=sys.stderr)
        return 2
    print(f'{len(zones)} water(s) to ask about')

    out, failed = {}, []
    for slug in sorted(zones):
        try:
            rows = surveys_for(zones[slug]['bbox'], a.since)
        except Exception as e:                                   # noqa: BLE001
            print(f'  {slug:32} !! {e}')
            failed.append(slug)
            continue
        out[slug] = {'kind': zones[slug]['kind'], 'surveys': rows,
                     'newestPerChannel': newest_per_channel(rows)}
        if rows:
            newest = max((str(r.get('surveydateend') or '') for r in rows), default='')
            reaches = len({(r.get('sdsfeaturename') or '') for r in rows})
            print(f'  {slug:32} {len(rows):>4} survey(s), {reaches:>3} reach(es), '
                  f'newest {newest or "?"}')
        else:
            print(f'  {slug:32}    none')

    have = {k: v for k, v in out.items() if v['surveys']}
    print(f'\n{sum(len(v["surveys"]) for v in have.values())} survey(s) across '
          f'{len(have)} of {len(zones)} waters')
    if failed:
        print(f'!! {len(failed)} water(s) could not be asked: {", ".join(failed)}')
    if a.dry_run:
        print('dry run -- nothing written')
        return 0
    if not have:
        print('!! nothing found anywhere -- not overwriting the registry')
        return 2

    dest = os.path.join(root, 'registry', 'ehydro_surveys_by_zone.json')
    with open(dest, 'w', encoding='utf-8') as f:
        json.dump({'note': NOTE,
                   'generatedBy': 'fetch_ehydro_surveys.py',
                   'generated': datetime.now(timezone.utc).isoformat(timespec='seconds'),
                   'source': LAYER,
                   'since': a.since,
                   'waters': out}, f, indent=1)
    print(f'wrote {dest}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
