#!/usr/bin/env python3
"""build_camera_index.py - bake a footprint-only USGS NIMS camera index.

Personal use only, not for distribution or resale; not for navigation.

    py .\\build_camera_index.py --registry "F:\\TrollMapPipeline\\registry" `
                               --app      "F:\\TrollMapPipeline\\TrollMap-Dev"

Writes:
    <registry>\\_nims_cameras_raw.json    the WHOLE national response, saved before anything is
                                          filtered, so this never has to be re-fetched and so a
                                          later disagreement about counts can be settled from
                                          bytes instead of memory
    <registry>\\_cameras.json             the report: field census, counts, bindings, refusals
    <app>\\js\\data\\cameras.js            the module the app imports

WHY A BAKED INDEX AND NOT A LIVE CALL
    The roster is near-static -- NIMS `createdDate`/`modifiedDate` are 2023 -- and the national
    response is 1,281 records for the ~52 in SC/NC/GA/TN. Shipping 1,281 to a phone on a boat
    ramp to use 52 of them is not a trade worth making. The CURRENT FRAME is live; the roster
    is not.

WHY THE FIELD CENSUS PRINTS EVERY TIME
    The first pass at this data reported "85 cameras nationally, zero in SC/NC/GA/TN". Both
    numbers were wrong -- 1,281 and 52 -- because the response had been read through a tool
    that summarised and clipped it, and a clipped JSON array looks exactly like a short one.
    Nothing about a truncated response announces itself. So this script fetches raw bytes, says
    how many records it got, says which fields those records actually carry, and refuses to
    report a count it cannot stand behind. If a field name below has drifted, the census makes
    that obvious on the line above the failure instead of silently yielding zero rows.

BINDING: SPATIAL FIRST, NAME ONLY AS A TIEBREAK
    A camera carries `nwisId`, which is an exact key -- but only against gauges we already hold,
    and the useful question is "which water is this camera on", not "which gauge". So the
    binding is the same two-signal rule the gauge bindings use, in the same order of trust:

        inside a boundary polygon        -> bound, that is a fact about where the camera is
        within --margin-km AND the name  -> bound, two independent signals agree
        anything else                    -> refused, and listed in the report

    Distance alone picks the wrong water and is the whole reason for the rule. Measured:
    Pick Hill Access on the Broad River takes *Little Hope Creek at Charlotte*, 60 km away in a
    different watershed; WT Billy Tolar on WATEREE takes a CONGAREE camera at 21.6 km. Both are
    the nearest camera by distance and both are wrong.
"""

import argparse
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.request

NOTE = 'Personal use only, not for distribution or resale; not for navigation.'

NIMS = 'https://api.waterdata.usgs.gov/nims/v0'
BBOX = (-90.6, 30.2, -75.2, 36.9)          # same box as build_water_bindings.py
S3 = 'https://usgs-nims-images.s3.amazonaws.com'

# The four prefixes NIMS publishes. Kept here rather than read from the record because they are
# a property of the bucket layout, not of a camera, and a record that omits one still resolves.
S3_DIRS = {'overlay': S3 + '/overlay/%s/',
           'thumb':   S3 + '/thumbnail/%s/',
           'small':   S3 + '/720/%s/',
           'tl':      S3 + '/timelapse/%s/'}

# Candidate spellings, most likely first. A NIMS response is not versioned in a way we control,
# and guessing ONE name and getting zero rows is the failure this project has already paid for
# three times. Every accessor reports which spelling answered, in the census.
F_ID = ('camId', 'cameraId', 'camID', 'id')
F_SITE = ('nwisId', 'nwisID', 'siteId', 'site_no')
# Measured from the live response 2026-08-07, not guessed: the roster carries `camName`
# ("Congaree River below Cayce DOWNSTREAM CAMERA") and `camDesc` (the same plus ", SC").
# The first run of this script printed `"name": null` for exactly this reason and every camera
# fell back to its camId -- which is WHY the census prints before anything is filtered.
F_NAME = ('camName', 'camDesc', 'cameraDescription', 'siteName', 'name', 'description', 'title')
F_LAT = ('lat', 'latitude', 'y')
F_LON = ('lon', 'lng', 'longitude', 'x')
F_HIDE = ('hideCam', 'hidden', 'hide')
F_NEWEST = ('newestImageDT', 'newestImage', 'lastImageDT')

_NOISE = {
    'lake', 'lakes', 'reservoir', 'river', 'creek', 'pond', 'branch', 'fork', 'run', 'bay',
    'sound', 'inlet', 'harbor', 'canal', 'dam', 'the', 'of', 'at', 'near', 'above', 'below',
    'and', 'north', 'south', 'east', 'west', 'upper', 'lower', 'middle', 'old', 'new', 'big',
    'little', 'camera', 'upstream', 'downstream', 'cam',
}


def first(rec, keys, default=None):
    """First present, non-empty key from `keys`. Returns (value, which_key)."""
    for k in keys:
        if k in rec and rec[k] not in (None, ''):
            return rec[k], k
    return default, None


def tokens(s):
    s = re.sub(r'\(.*?\)', ' ', s or '')
    s = re.sub(r'[^a-z0-9 ]+', ' ', str(s).lower())
    return [t for t in s.split() if len(t) >= 3 and t not in _NOISE and not t.isdigit()]


def get_json(url, tries=5):
    """Raw bytes -> json. No summarising layer anywhere in the path, deliberately."""
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'TrollMap/1.0 (personal)'})
            with urllib.request.urlopen(req, timeout=90) as r:
                raw = r.read()
            return json.loads(raw.decode('utf-8')), len(raw)
        except (urllib.error.URLError, urllib.error.HTTPError, ValueError) as exc:
            last = exc
            wait = 2 ** i
            print('   %s -- retry in %ds' % (type(exc).__name__, wait), flush=True)
            time.sleep(wait)
    raise SystemExit('could not fetch %s: %s' % (url, last))


def rows_of(payload):
    """NIMS may answer a bare array or wrap it. Find the list of dicts, wherever it is."""
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for k in ('cameras', 'data', 'items', 'records', 'results', 'features'):
            v = payload.get(k)
            if isinstance(v, list):
                return v
        for v in payload.values():                      # last resort: the only list in there
            if isinstance(v, list) and v and isinstance(v[0], dict):
                return v
    return []


# ── geometry ────────────────────────────────────────────────────────────────────────────────

def rings_of(geom):
    if not isinstance(geom, dict):
        return []
    t, c = geom.get('type'), geom.get('coordinates')
    if t == 'Polygon':
        return [c[0]] if c else []
    if t == 'MultiPolygon':
        return [p[0] for p in (c or []) if p]
    return []


def load_boundary(path):
    """EVERY feature, never features[0] -- a boundary file with two polygons is normal here."""
    try:
        with open(path, encoding='utf-8') as fh:
            gj = json.load(fh)
    except (OSError, ValueError):
        return None
    polys = []
    if gj.get('type') == 'FeatureCollection':
        for ft in gj.get('features') or []:
            polys += rings_of((ft or {}).get('geometry'))
    else:
        polys += rings_of(gj.get('geometry') or gj)
    return polys or None


def in_ring(x, y, ring):
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y):
            xint = (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi
            if x < xint:
                inside = not inside
        j = i
    return inside


def km_to_ring(lon, lat, ring, step=1):
    """Distance to the nearest VERTEX of the boundary, in km. Vertex distance rather than
    segment distance because the rings here are dense and the difference is metres, while the
    segment version costs a factor of several over 1,700 waters."""
    best = 1e9
    coslat = math.cos(math.radians(lat))
    for i in range(0, len(ring), step):
        dx = (ring[i][0] - lon) * 111.32 * coslat
        dy = (ring[i][1] - lat) * 110.57
        d = dx * dx + dy * dy
        if d < best:
            best = d
    return math.sqrt(best)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--app', required=True, help='TrollMap-Dev root; writes js\\data\\cameras.js')
    ap.add_argument('--margin-km', type=float, default=2.0,
                    help='how far outside a boundary a camera may sit and still bind, WHEN the '
                         'name also agrees. Inside the polygon needs no margin.')
    ap.add_argument('--raw', default=None, help='read a saved raw response instead of fetching')
    a = ap.parse_args()

    report = {'note': NOTE, 'bbox': list(BBOX), 'margin_km': a.margin_km}
    raw_path = os.path.join(a.registry, '_nims_cameras_raw.json')

    # ── 1. get the roster, whole ─────────────────────────────────────────────────────────────
    if a.raw:
        payload = json.load(open(a.raw, encoding='utf-8'))
        nbytes = os.path.getsize(a.raw)
        print('read %s (%.1f KB)' % (a.raw, nbytes / 1024.0))
    else:
        print('fetching %s/cameras' % NIMS)
        payload, nbytes = get_json('%s/cameras' % NIMS)
        with open(raw_path, 'w', encoding='utf-8') as fh:
            json.dump(payload, fh)
        print('   %.1f KB of raw JSON -> %s' % (nbytes / 1024.0, raw_path))

    rows = rows_of(payload)
    print('   %d records' % len(rows))
    report['national_total'] = len(rows)
    if not rows:
        raise SystemExit('no records found in the response -- look at %s before trusting a '
                         'zero here; a clipped array looks exactly like a short one' % raw_path)

    # ── 2. field census, printed before anything is filtered ─────────────────────────────────
    from collections import Counter
    census = Counter()
    for r in rows:
        if isinstance(r, dict):
            census.update(r.keys())
    picked = {}
    for label, cands in (('id', F_ID), ('nwis', F_SITE), ('name', F_NAME), ('lat', F_LAT),
                         ('lon', F_LON), ('hide', F_HIDE), ('newest', F_NEWEST)):
        picked[label] = next((k for k in cands if census.get(k)), None)
    print('   fields present on >=1 record: %s' % ', '.join(sorted(census)[:24]))
    print('   using: %s' % json.dumps(picked))
    report['field_census'] = dict(census)
    report['fields_used'] = picked
    missing = [k for k in ('id', 'lat', 'lon') if not picked[k]]
    if missing:
        raise SystemExit('cannot proceed: no field found for %s. The census above lists what '
                         'the response actually carries -- add the real spelling to F_%s at '
                         'the top of this file.' % (', '.join(missing), missing[0].upper()))

    # ── 3. footprint + visibility filter ─────────────────────────────────────────────────────
    w, s, e, n = BBOX
    cams, hidden, outside = [], 0, 0
    for r in rows:
        if not isinstance(r, dict):
            continue
        lat, _ = first(r, F_LAT)
        lon, _ = first(r, F_LON)
        try:
            lat, lon = float(lat), float(lon)
        except (TypeError, ValueError):
            continue
        if not (w <= lon <= e and s <= lat <= n):
            outside += 1
            continue
        hide, _ = first(r, F_HIDE, False)
        if hide is True or str(hide).lower() == 'true':
            hidden += 1
            continue
        cid, _ = first(r, F_ID)
        nm, _ = first(r, F_NAME, '')
        nm = str(nm or cid)
        # UPSTREAM/DOWNSTREAM pairs at one nwisId are two views of one reach and both are
        # wanted, but the suffix does not belong in a popup title. Split it off rather than
        # rendering "Congaree River below Cayce DOWNSTREAM CAMERA" at the user.
        mview = re.search(r'\b(UPSTREAM|DOWNSTREAM)\b', nm, re.I)
        view = mview.group(1).upper() if mview else None
        nm = re.sub(r'[\s,-]*\b(UPSTREAM|DOWNSTREAM)?\s*CAMERA\s*$', '', nm, flags=re.I).strip(' ,-')
        ing = r.get('ingest') if isinstance(r.get('ingest'), dict) else {}
        cams.append({
            'camId': str(cid),
            'nwisId': str(first(r, F_SITE, '')[0] or ''),
            'name': nm or str(cid),
            'view': view,
            'lat': round(lat, 6), 'lon': round(lon, 6),
            'state': r.get('stateAbrv') or r.get('state') or r.get('stateAbbrev') or '',
            # daylight-only is not a detail. 22 of 47 run daylight only, and a popup opened at
            # night shows a 14-hour-old frame with nothing to say it is old unless this rides
            # along and the UI renders the age.
            'period': (ing.get('period') or r.get('period') or '247'),
            'intervalMin': ing.get('intr') or r.get('intr'),
            'timelapse': bool(r.get('TL_enabled') or r.get('tlEnabled')),
        })
    print('   in footprint and visible: %d   (hidden %d, outside the box %d)'
          % (len(cams), hidden, outside))
    report['footprint_visible'] = len(cams)
    report['footprint_hidden'] = hidden

    # ── 4. bind each camera to a water ───────────────────────────────────────────────────────
    index = json.load(open(os.path.join(a.registry, 'lake_index.json'), encoding='utf-8'))
    bdir = os.path.join(a.registry, 'boundaries')
    # Pre-index by bbox so each camera tests a handful of waters, not 1,722.
    boxes = []
    for slug, rec in index.items():
        b = rec.get('bounds_wsen')
        if isinstance(b, list) and len(b) == 4:
            names = [rec.get('name'), rec.get('display_name')]
            names += list(rec.get('legacy_display_names') or [])
            boxes.append((slug, b, {t for nm in names if nm for t in tokens(nm)},
                          rec.get('display_name'), rec.get('feature_type')))

    # THE RAMP DOES NOT KNOW THE REGISTRY'S NAME FOR ITS WATER, so the slug alone is not a
    # usable runtime key. Registry display names carry a county disambiguator --
    # "Lynches River (Darlington Co, SC)", "Congaree River (to SC-601) (Richland Co, SC)" --
    # while the DNR ramp feed says "Lynches River" and "TUCKASEGEE RIVER". Measured against the
    # four state feeds: ZERO of the 17 camera waters matched a DNR waterbody name exactly.
    #
    # Stripping the suffix inside resolveR2Key() would be wrong -- that is the same collapse
    # that makes lint:keys fail on the two Lake Wallaces, and a bare name that maps to two
    # different lakes must not silently resolve to one. Here it is safe, because the alias only
    # nominates CANDIDATES and the 20 km distance test picks among them. Chattahoochee River
    # (2) and (5) are two reaches of one river, so nearest-of-those-two is the right answer;
    # two unrelated Lake Wallaces would both fail the distance test anyway.
    def aliases_for(rec, slug):
        out = set()
        for nm in (rec.get('display_name'), rec.get('name'), *(rec.get('legacy_display_names') or [])):
            if not nm:
                continue
            # Peel trailing parentheticals one at a time and keep every intermediate form:
            # "Congaree River (to SC-601) (Richland Co, SC)" yields the full name, the
            # "(to SC-601)" form, and the bare "Congaree River" a ramp feed actually uses.
            forms, cur = set(), str(nm).strip()
            while cur:
                forms.add(cur)
                nxt = re.sub(r'\s*\([^)]*\)\s*$', '', cur).strip()
                if nxt == cur:
                    break
                cur = nxt
            for cand in forms:
                if not cand:
                    continue
                out.add(cand.lower())
                # Coastal zones are named "Winyah Bay / Georgetown, SC" -- a ramp feed will use
                # one side or the other, never the pair.
                for part in cand.split('/'):
                    part = re.sub(r',\s*[A-Z]{2}$', '', part.strip(), flags=re.I).strip()
                    if len(part) >= 4:
                        out.add(part.lower())
        out.discard('')
        return sorted(out)

    cache = {}
    bound, refused = 0, []
    for c in cams:
        best = None
        for slug, b, ntok, disp, ftype in boxes:
            if not (b[0] - 0.05 <= c['lon'] <= b[2] + 0.05 and b[1] - 0.05 <= c['lat'] <= b[3] + 0.05):
                continue
            if slug not in cache:
                cache[slug] = load_boundary(os.path.join(bdir, slug + '.geojson'))
            polys = cache[slug]
            if not polys:
                continue
            inside = any(in_ring(c['lon'], c['lat'], ring) for ring in polys)
            shared = ntok & set(tokens(c['name']))
            if inside:
                cand = (0, 0.0, slug, disp, ftype, 'inside')
            elif shared:
                d = min(km_to_ring(c['lon'], c['lat'], ring, 3) for ring in polys)
                if d > a.margin_km:
                    continue
                cand = (1, d, slug, disp, ftype, 'name+near')
            else:
                continue
            if best is None or cand[:2] < best[:2]:
                best = cand
        if best:
            c['slug'] = best[2]
            c['water'] = best[3]
            c['waterAliases'] = aliases_for(index.get(best[2]) or {}, best[2])
            c['featureType'] = best[4]
            c['bind'] = best[5]
            c['kmOutside'] = round(best[1], 2)
            bound += 1
        else:
            # Kept in the output with no slug rather than dropped. A camera on water we have
            # not digitised is not an error, and dropping it here would make it look like NIMS
            # does not cover that reach -- which is the shape of the original wrong answer.
            c['slug'] = None
            refused.append({'camId': c['camId'], 'name': c['name'],
                            'lat': c['lat'], 'lon': c['lon']})

    print('   bound to a water: %d of %d   (unbound %d)' % (bound, len(cams), len(refused)))
    by_type = Counter(c.get('featureType') for c in cams if c.get('slug'))
    print('   by water type: %s' % dict(by_type))
    report['bound'] = bound
    report['unbound'] = refused
    report['by_feature_type'] = dict(by_type)
    report['by_state'] = dict(Counter(c['state'] for c in cams))
    report['sites'] = len({c['nwisId'] for c in cams if c['nwisId']})
    report['daylight_only'] = sum(1 for c in cams if str(c['period']).lower() == 'daylight')
    print('   distinct NWIS sites %d, daylight-only %d'
          % (report['sites'], report['daylight_only']))

    # ── 5. write ─────────────────────────────────────────────────────────────────────────────
    cams.sort(key=lambda c: (c['slug'] or '~', c['camId']))
    js_path = os.path.join(a.app, 'js', 'data', 'cameras.js')
    os.makedirs(os.path.dirname(js_path), exist_ok=True)
    with open(js_path, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write('// GENERATED by Scripts/build_camera_index.py -- do not hand-edit.\n')
        fh.write('// %s\n' % NOTE)
        fh.write('// USGS NIMS imagery is Public Domain. %d cameras in SC/NC/GA/TN, %d bound\n'
                 '// to a water in the registry. The roster is near-static (NIMS createdDate\n'
                 '// and modifiedDate are 2023); only the CURRENT FRAME is fetched live, one\n'
                 '// call per popup, through the Worker.\n' % (len(cams), bound))
        # The stub this replaces exports an empty array, and this repo has already
        # been bitten once by an exported [] reading as a valid data source. So the
        # flag says whether the index was BUILT, and the consumer can tell "no
        # cameras on this water" apart from "nobody has run the generator".
        fh.write('export const CAMERA_INDEX_BUILT = true;\n\n')
        fh.write('export const NIMS_CAMERAS = %s;\n\n'
                 % json.dumps(cams, indent=1, sort_keys=True))
        fh.write('// S3 prefixes, from the NIMS API\'s own fields. The filename is derivable\n'
                 '// from newestImageDT -- strip the .000 and swap the time colons for hyphens\n'
                 '// -- so listFiles is optional and the Worker does not call it.\n')
        fh.write('export const NIMS_S3 = %s;\n' % json.dumps(S3_DIRS, indent=1, sort_keys=True))
    print('-> %s' % js_path)

    rep_path = os.path.join(a.registry, '_cameras.json')
    with open(rep_path, 'w', encoding='utf-8') as fh:
        json.dump(report, fh, indent=1)
    print('-> %s' % rep_path)


if __name__ == '__main__':
    main()
