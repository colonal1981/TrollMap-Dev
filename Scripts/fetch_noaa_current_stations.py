#!/usr/bin/env python3
"""
fetch_noaa_current_stations.py -- bind NOAA tidal-current stations to the coastal zones.

Personal use only, not for distribution or resale; not for navigation.

WHY THIS IS A SCRIPT AND NOT A DOWNLOAD PAGE
    Ryan, 2026-09-03: "for tidal currents i am failing at getting what are talking about".
    He was not failing. NOAA's current-prediction station list is an API that returns 4,430
    stations carrying latitude and longitude and NO STATE FIELD, so there is no page anywhere
    listing "South Carolina current stations" to click. Finding the ones on our water means
    testing 4,430 coordinates against thirteen zone boundaries. That is counting, and counting
    is this side of the job.

WHAT IT BINDS, AND WHY ONLY THAT
    The zones already carry `tide_station`, and noaa-tides.js fetches the PREDICTIONS live at
    plan time. Current works the same way: predictions go stale the day after they are written,
    so this script binds the STATION and nothing else. Same shape as the tide binding, one more
    field, no new subsystem.

    Slack water is not the tide turning. On a creek the current keeps running after high water
    and that lag is what positions a fish, so a current station is a different fact from a tide
    station and cannot be derived from one.

MATCHING, AND WHY A BOX IS NOT ENOUGH
    A current station sits in a channel, and a channel is often just outside the water body's
    drawn boundary. So: point-in-polygon first, and only where that refuses, nearest zone within
    --max-km. Every row records which of the two claimed it, so a loose match can be counted
    rather than believed.

USAGE
    py fetch_noaa_current_stations.py                    # fetch, match, write the registry
    py fetch_noaa_current_stations.py --dry-run          # match and print, write nothing
    py fetch_noaa_current_stations.py --stations s.json  # match a saved list, no network
    py fetch_noaa_current_stations.py --save-raw s.json  # keep the fetched list for next time
"""

import argparse
import glob
import json
import math
import os
import sys
import urllib.request
from datetime import datetime, timezone

MDAPI = ('https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json'
         '?type=currentpredictions&units=english')
UA = 'TrollMap/1.0 (personal use; contact via github.com/colonal1981/TrollMap-Dev)'

HERE = os.path.dirname(os.path.abspath(__file__))


def _root():
    """The pipeline root, from either of the two script homes."""
    d = HERE
    for _ in range(4):
        if os.path.isdir(os.path.join(d, 'registry', 'boundaries')):
            return d
        d = os.path.dirname(d)
    return os.path.dirname(HERE)


NOTE = ('Personal use only, not for distribution or resale; not for navigation.')


# ── geometry ────────────────────────────────────────────────────────────────────────────────
def rings(geom):
    t = (geom or {}).get('type')
    c = (geom or {}).get('coordinates')
    if t == 'Polygon':
        return [c]
    if t == 'MultiPolygon':
        return c
    return []


def in_polygon(x, y, poly):
    """Ray cast, honouring holes: outside ring must contain, inner rings must not."""
    inside = False
    for i, ring in enumerate(poly):
        hit = False
        n = len(ring)
        for j in range(n):
            x1, y1 = ring[j][:2]
            x2, y2 = ring[(j + 1) % n][:2]
            if (y1 > y) != (y2 > y):
                if x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                    hit = not hit
        if i == 0:
            if not hit:
                return False
            inside = True
        elif hit:
            return False
    return inside


def km_between(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def bbox_of(polys):
    xs, ys = [], []
    for poly in polys:
        for ring in poly:
            for pt in ring:
                xs.append(pt[0])
                ys.append(pt[1])
    return (min(xs), min(ys), max(xs), max(ys)) if xs else None


# ── inputs ──────────────────────────────────────────────────────────────────────────────────
def load_zones(root):
    """Every coastal boundary on disk. Walked, never typed -- a new zone joins by existing."""
    zones = {}
    pat = os.path.join(root, 'registry', 'boundaries', 'coast_*.geojson')
    for path in sorted(glob.glob(pat)):
        slug = os.path.basename(path)[:-len('.geojson')]
        try:
            with open(path, encoding='utf-8') as fh:
                gj = json.load(fh)
        except (OSError, ValueError):
            continue
        polys = []
        for feat in (gj.get('features') or [gj]):
            polys += rings(feat.get('geometry') or feat)
        if not polys:
            continue
        box = bbox_of(polys)
        cx = (box[0] + box[2]) / 2.0
        cy = (box[1] + box[3]) / 2.0
        zones[slug] = {'polys': polys, 'bbox': box, 'centre': (cy, cx)}
    return zones


def station_rows(payload):
    """
    ONE ROW PER STATION, not per depth bin.

    NOAA's list is 4,430 entries and 2,785 stations: a station with two current bins appears
    twice, same id, same position, different `currbin` and `depth`. The first version passed
    those straight through, so the first real run reported ACT6341 at Fort Macon twice and
    counted 415 bindings where there were fewer stations than that. A duplicated row reads as
    a second station, which is a wrong count of what the water has.

    The bins are not noise and are kept, nested: bin 1 at 10 ft and bin 2 at 20 ft are genuinely
    different currents, and a kayak fishes the shallow one. `depthType` says which way the depth
    is measured -- S from the surface, B from the bottom.

    mdapi says lat/lng; other CO-OPS endpoints say latitude/longitude. Reading both costs one
    line and stops a field rename from emptying the registry silently.
    """
    if isinstance(payload, dict):
        rows = payload.get('stations') or payload.get('features') or []
    else:
        rows = payload
    by_station = {}
    for s in rows:
        if not isinstance(s, dict):
            continue
        sid = str(s.get('id') or s.get('stationId') or '').strip()
        if not sid:
            continue
        lat = s.get('lat', s.get('latitude'))
        lon = s.get('lng', s.get('lon', s.get('longitude')))
        try:
            lat = float(lat)
            lon = float(lon)
        except (TypeError, ValueError):
            continue
        # Keyed on position too: two stations sharing an id at different places are two
        # stations, and collapsing them would move one of them.
        key = (sid, round(lat, 5), round(lon, 5))
        rec = by_station.get(key)
        if rec is None:
            rec = {'id': sid, 'name': (s.get('name') or '').strip(),
                   'lat': lat, 'lon': lon,
                   'type': s.get('type') or None, 'bins': []}
            by_station[key] = rec
        b = s.get('currbin')
        if b is not None:
            entry = {'bin': b, 'depth': s.get('depth'), 'depthType': s.get('depthType')}
            if entry not in rec['bins']:
                rec['bins'].append(entry)
    for rec in by_station.values():
        rec['bins'].sort(key=lambda e: (e['bin'] is None, e['bin']))
    return list(by_station.values())


# ── the match ───────────────────────────────────────────────────────────────────────────────
def match_stations(stations, zones, max_km=8.0):
    """
    Bind each station to a zone. Pure -- no network, no disk -- so it can be tested.

    Two passes, and the row says which one claimed it:
      inside   the station is within the zone's own boundary polygon
      near     no polygon contains it, but a zone centre is within max_km

    A station that lands inside more than one zone is recorded in each. The coastal boundaries
    genuinely overlap -- the SC artificial reef at Parris Island sits inside three of them -- so
    picking one by iteration order would be inventing an answer.
    """
    out = {slug: [] for slug in zones}
    unmatched = []
    for s in stations:
        hits = []
        for slug, z in zones.items():
            x0, y0, x1, y1 = z['bbox']
            if not (x0 <= s['lon'] <= x1 and y0 <= s['lat'] <= y1):
                continue
            if any(in_polygon(s['lon'], s['lat'], p) for p in z['polys']):
                hits.append((slug, 'inside', 0.0))
        if not hits:
            # THE NEAR PASS NEVER OVERRIDES A REFUSAL IT CAN SEE.
            #
            # A zone whose box already contains the station and whose polygon still said no has
            # given an informed answer -- the point is in a hole, which is land. Rescuing it by
            # distance-to-centre put a current station on an island, and on a ring-shaped zone
            # the centre IS the island, so the bogus match scored zero kilometres and sorted
            # first. Caught by test_a_station_in_the_hole_is_not_in_the_zone.
            #
            # So distance is consulted only where the polygon had no opinion: outside the box.
            for slug, z in zones.items():
                x0, y0, x1, y1 = z['bbox']
                if x0 <= s['lon'] <= x1 and y0 <= s['lat'] <= y1:
                    continue
                d = km_between(s['lat'], s['lon'], z['centre'][0], z['centre'][1])
                if d <= max_km:
                    hits.append((slug, 'near', round(d, 2)))
            hits.sort(key=lambda h: h[2])
            hits = hits[:1]
        if not hits:
            unmatched.append(s)
            continue
        for slug, how, km in hits:
            row = dict(s)
            row['matchedBy'] = how
            row['km'] = km
            out[slug].append(row)
    for slug in out:
        out[slug].sort(key=lambda r: (r['matchedBy'] != 'inside', r['km'], r['id']))
    return out, unmatched


# ── network ─────────────────────────────────────────────────────────────────────────────────
def fetch_stations(url=MDAPI, timeout=60):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8', 'replace'))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--root', default=None)
    ap.add_argument('--stations', help='read the station list from this file instead of NOAA')
    ap.add_argument('--save-raw', help='write the fetched station list here as well')
    ap.add_argument('--max-km', type=float, default=8.0,
                    help='how far outside a boundary a station may sit (default 8)')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()

    root = a.root or _root()
    zones = load_zones(root)
    if not zones:
        print(f'ERROR: no coastal boundaries under {root}/registry/boundaries', file=sys.stderr)
        return 2
    print(f'{len(zones)} coastal zone boundaries')

    if a.stations:
        with open(a.stations, encoding='utf-8') as fh:
            payload = json.load(fh)
        print(f'station list read from {a.stations}')
    else:
        print('asking NOAA for the current-prediction station list ...', flush=True)
        try:
            payload = fetch_stations()
        except Exception as e:                                   # noqa: BLE001
            print(f'!! could not reach NOAA: {e}', file=sys.stderr)
            return 2
        if a.save_raw:
            with open(a.save_raw, 'w', encoding='utf-8') as fh:
                json.dump(payload, fh)
            print(f'   raw list saved to {a.save_raw}')

    stations = station_rows(payload)
    print(f'{len(stations):,} current-prediction stations '
          f'({sum(len(x["bins"]) for x in stations):,} depth bins)')
    if not stations:
        print('!! the station list parsed to nothing -- field names may have changed. '
              'Not writing.', file=sys.stderr)
        return 2

    bound, unmatched = match_stations(stations, zones, a.max_km)
    hit = {k: v for k, v in bound.items() if v}
    total = sum(len(v) for v in hit.values())
    inside = sum(1 for v in hit.values() for r in v if r['matchedBy'] == 'inside')
    print(f'\n{total} binding(s) across {len(hit)} of {len(zones)} zones '
          f'({inside} inside a boundary, {total - inside} nearest-within-{a.max_km:g}km)')
    for slug in sorted(hit):
        print(f'  {slug:32} {len(hit[slug]):>3}')
        for r in hit[slug][:4]:
            where = 'inside' if r['matchedBy'] == 'inside' else f"{r['km']:g} km"
            bins = ', '.join(f"{e['depth']:g}{e['depthType'] or ''}"
                             for e in r['bins'] if e.get('depth') is not None)
            print(f'      {r["id"]:10} {r["name"][:44]:44} {where:8} {bins}')
        if len(hit[slug]) > 4:
            print(f'      ... {len(hit[slug]) - 4} more')
    empty = [s for s in zones if not bound[s]]
    if empty:
        print(f'\n  no current station: {", ".join(sorted(empty))}')

    if a.dry_run:
        print('\ndry run -- nothing written')
        return 0

    out = os.path.join(root, 'registry', 'coastal_current_stations.json')
    with open(out, 'w', encoding='utf-8') as f:
        json.dump({'note': NOTE,
                   'generatedBy': 'fetch_noaa_current_stations.py',
                   'generated': datetime.now(timezone.utc).isoformat(timespec='seconds'),
                   'source': MDAPI,
                   'maxKm': a.max_km,
                   'stationsConsidered': len(stations),
                   'zones': bound}, f, indent=1)
    print(f'\nwrote {out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
