#!/usr/bin/env python3
r"""repair_catch_fixes.py -- put a real position and a real depth on a catch, or say there is none.

Personal use only, not for distribution or resale; not for navigation.

    py .\repair_catch_fixes.py --catches   "F:\TrollMapPipeline\scripts_old\_data_2026-08-04\catches_approved.csv" `
                               --registry  "F:\TrollMapPipeline\registry" `
                               --chartpack "F:\TrollMapPipeline\chartpack" `
                               --tracks    "F:\TrollMapPipeline\garmin\UserData\EXPORT.GPX" `
                               --out       "F:\TrollMapPipeline\_scratch\catches_repaired.csv"

WHY THIS EXISTS

Two separate things were wrong with the journal and they wore the same clothes.

THE DEPTH WAS READ OFF WHICHEVER CHART WAS ON SCREEN. nearestLakeAndContour() in catch-journal.js
takes `state.ACTIVE_CONTOUR` -- the pack loaded in the app at that moment -- and has nothing to do
with where the catch is. Import a journal in one sitting with one water up and every fish in it
gets that water's depths. All five of the lookups in Ryan's 157 catches that reached past a tenth
of a mile match LAKE MARION's chart, whatever water the fish was in:

                        journal said   lake_marion   the fish's own water
  shad, Santee River      0.24 mi        0.234 mi      0.001 mi (santee_river)
  catfish, borrow pit     0.17 mi        0.001 mi      0.738 mi

The shad settles it: its own pack has a contour 1.6 m from that fish. The app read one a quarter
mile away because Marion was on the screen.

THE POSITION IS THE PHONE'S AND THE PHONE IS INTERMITTENT. Ryan: *"i am looking at the map and
those coords for those fish are on land nowhere near the river"*. Checked against his own plotter,
nine catches from 2026-06-20 on Lake Wateree, each matched to a track point within 16 seconds:

    2 m, 4 m, 7 m, 21 m, 21 m, then 255 m, 472 m, 598 m, 719 m

Same phone, same morning. Five good, four hundreds of metres out. The EXIF says lat, lon, time and
compass heading and carries NO altitude and NO accuracy -- a satellite fix computes altitude, a
fused network fix usually does not -- so nothing in the file separates the 2 m fixes from the 719 m
ones. Only an independent record can, and the plotter is the independent record.

WHAT THIS DOES, IN ORDER

  1. POSITION. If a timestamped track point exists within --max-gap-s of the catch, the track wins
     and the photo's fix is kept in `orig_lat`/`orig_lon` beside it. The plotter was on the boat.
  2. WATER. Whichever registry boundary contains the position -- not the nearest NAME within
     twenty miles, which is how a fish in a borrow pit came to be filed on Lake Marion.
  3. DEPTH. Looked up in THAT water's own contours and nowhere else, and only claimed when the
     nearest contour is within ON_CONTOUR_M. Past that the depth is blanked and the note says how
     far the nearest one was and which chart it was on, because a number whose source cannot be
     named is not checkable.

NOTHING IS DELETED AND NOTHING IS GUESSED. Every row comes out, the original position and depth are
carried alongside, and a row this cannot improve comes out unchanged with a flag saying why.

ON_CONTOUR_M is 0.10 mi, which is not a number invented here: catch-journal.js has always called
anything under it "on" the contour and anything past it "near". See js/utils/catch-depth.js.
"""
from __future__ import annotations
import argparse, csv, datetime as dt, glob, json, math, os, re, sys

try:
    import numpy as np
except ImportError:
    sys.exit('needs numpy:  py -m pip install numpy')

try:
    from shapely.geometry import shape, Point
    from shapely.ops import unary_union
    from shapely.strtree import STRtree
except ImportError:
    sys.exit('needs shapely:  py -m pip install shapely')

ON_CONTOUR_MI = 0.10          # see js/utils/catch-depth.js
MI_PER_DEG = 69.0             # the app's own conversion, so the numbers compare
BANK_M = 120.0                # a kayak against the shore -- screen_catches.py's band


# ── TIME ────────────────────────────────────────────────────────────────────────────────────────
# The journal stores LOCAL time with no zone and the plotter stores UTC. US Eastern, second Sunday
# in March to first Sunday in November. Written out rather than imported because a wrong hour here
# would silently match a catch to a track point an hour up the lake, which is exactly the class of
# error this script exists to remove.
def _nth_sunday(year, month, n):
    d = dt.date(year, month, 1)
    d += dt.timedelta(days=(6 - d.weekday()) % 7)
    return d + dt.timedelta(weeks=n - 1)


def eastern_to_utc(naive):
    y = naive.year
    start = dt.datetime.combine(_nth_sunday(y, 3, 2), dt.time(2, 0))
    end = dt.datetime.combine(_nth_sunday(y, 11, 1), dt.time(2, 0))
    offset = 4 if start <= naive < end else 5
    return naive.replace(tzinfo=dt.timezone.utc) + dt.timedelta(hours=offset)


def metres(a_lon, a_lat, b_lon, b_lat):
    cos = math.cos(math.radians(a_lat))
    return math.hypot((b_lon - a_lon) * 111320.0 * cos, (b_lat - a_lat) * 110540.0)


# ── THE PLOTTER'S TRACK ─────────────────────────────────────────────────────────────────────────
def load_tracks(paths):
    pts = []
    for pat in paths:
        for p in glob.glob(pat):
            try:
                s = open(p, encoding='utf-8', errors='ignore').read()
            except OSError:
                continue
            for m in re.finditer(r'<trkpt[^>]*lat="([-\d.]+)"[^>]*lon="([-\d.]+)"[^>]*>(.*?)</trkpt>',
                                 s, re.S):
                t = re.search(r'<time>(.*?)</time>', m.group(3))
                if not t:
                    continue                      # a saved track with no clock cannot place a catch
                try:
                    when = dt.datetime.strptime(t.group(1), '%Y-%m-%dT%H:%M:%SZ')
                except ValueError:
                    continue
                pts.append((when.replace(tzinfo=dt.timezone.utc),
                            float(m.group(2)), float(m.group(1)), os.path.basename(p)))
    pts.sort(key=lambda x: x[0])
    return pts


def nearest_in_time(pts, when):
    if not pts:
        return None
    lo, hi = 0, len(pts) - 1
    while lo < hi:                                 # bisect on an ascending clock
        mid = (lo + hi) // 2
        if pts[mid][0] < when:
            lo = mid + 1
        else:
            hi = mid
    best = None
    for i in (lo - 1, lo, lo + 1):
        if 0 <= i < len(pts):
            gap = abs((pts[i][0] - when).total_seconds())
            if best is None or gap < best[0]:
                best = (gap, pts[i])
    return best


# ── THE WATER, AND THEN ITS OWN CHART ───────────────────────────────────────────────────────────
def load_boundaries(registry):
    """Every registry boundary as one geometry, and a COUNT of the ones that would not load.

    A self-intersecting ring makes unary_union raise, and the obvious `except: continue` hides a
    whole water: every catch on it then reports as having no water under it, which reads as a bad
    position. So a failure is repaired with buffer(0) first -- the standard fix for a ring that
    crosses itself -- and only a boundary that survives neither is dropped, by name, out loud.
    """
    geoms, slugs, refused = [], [], []
    for p in glob.glob(os.path.join(registry, 'boundaries', '*.geojson')):
        slug = os.path.basename(p)[:-8]
        if slug.startswith('_'):
            continue
        try:
            d = json.load(open(p, encoding='utf-8'))
            gg = [shape(f['geometry'])
                  for f in (d.get('features') or [{'geometry': d.get('geometry')}])
                  if f and f.get('geometry')]
        except Exception:
            refused.append(slug)
            continue
        if not gg:
            continue
        merged = None
        for attempt in (gg, None):
            try:
                merged = unary_union(gg if attempt is not None else [g.buffer(0) for g in gg])
                break
            except Exception:
                merged = None
        if merged is None or merged.is_empty:
            refused.append(slug)
            continue
        geoms.append(merged)
        slugs.append(slug)
    return geoms, slugs, refused


_contours = {}


def contour_vertices(chartpack, slug):
    """Every charted vertex of one pack, as three parallel arrays. Cached -- Marion is 25 MB.

    ARRAYS AND NOT A LIST OF TUPLES. Lake Marion's contours are about a million vertices and sixty
    of his catches are on it; the plain Python scan was sixty million iterations and minutes of
    wall clock for a question numpy answers per catch in milliseconds. The arithmetic is the app's
    own -- degrees times 69, cosine-corrected -- so the distances compare to what the journal says.
    """
    if slug in _contours:
        return _contours[slug]
    path = os.path.join(chartpack, slug, 'contours.geojson')
    out = []
    if os.path.exists(path):
        try:
            d = json.load(open(path, encoding='utf-8'))
        except Exception:
            d = None
        for f in ((d or {}).get('features') or []):
            p = f.get('properties') or {}
            ft = p.get('depth', p.get('DEPTH', p.get('depth_ft', p.get('Depth'))))
            if ft in (None, ''):
                continue
            g = f.get('geometry') or {}
            c, t = g.get('coordinates'), g.get('type')
            if c is None:
                continue
            if t == 'LineString':
                lines = [c]
            elif t in ('MultiLineString', 'Polygon'):
                lines = c
            elif t == 'MultiPolygon':
                lines = [r for poly in c for r in poly]
            else:
                continue
            for line in lines:
                for pt in line:
                    if isinstance(pt, (list, tuple)) and len(pt) >= 2:
                        try:
                            out.append((float(pt[0]), float(pt[1]), float(ft)))
                        except (TypeError, ValueError):
                            continue
    if out:
        arr = (np.fromiter((v[0] for v in out), float, len(out)),
               np.fromiter((v[1] for v in out), float, len(out)),
               np.fromiter((float(v[2]) for v in out), float, len(out)))
    else:
        arr = None
    _contours[slug] = arr
    return arr


def nearest_contour_mi(chartpack, slug, lon, lat):
    v = contour_vertices(chartpack, slug)
    if v is None:
        return None
    vlon, vlat, vft = v
    cos = math.cos(math.radians(lat))
    dx = (vlon - lon) * MI_PER_DEG * cos
    dy = (vlat - lat) * MI_PER_DEG
    i = int(np.argmin(dx * dx + dy * dy))
    ft = vft[i]
    return float(math.hypot(dx[i], dy[i])), (int(ft) if float(ft).is_integer() else round(float(ft), 1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--catches', required=True)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--chartpack', required=True)
    ap.add_argument('--tracks', nargs='*', default=[], help='GPX files with timestamped track points')
    ap.add_argument('--max-gap-s', type=float, default=120.0,
                    help='how close in time a track point has to be to replace a photo fix')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()

    rows = list(csv.DictReader(open(a.catches, encoding='utf-8-sig')))
    if not rows:
        sys.exit('no rows in %s' % a.catches)
    pts = load_tracks(a.tracks)
    geoms, slugs, refused = load_boundaries(a.registry)
    if not geoms:
        sys.exit('no boundaries under %s' % a.registry)
    tree = STRtree(geoms)
    print(f'{len(rows)} catches, {len(pts)} timestamped track points, {len(geoms)} boundaries')
    if refused:
        print(f'  {len(refused)} boundaries would not load, so nothing can be placed on them: '
              + ', '.join(sorted(refused)[:8]) + ('...' if len(refused) > 8 else ''))

    fields = list(rows[0].keys())
    for extra in ('orig_lat', 'orig_lon', 'orig_depth', 'fix_source', 'fix_moved_m', 'water_slug'):
        if extra not in fields:
            fields.append(extra)

    moved, redepthed, blanked, no_water, untouched = 0, 0, 0, 0, 0
    report = []

    for r in rows:
        r.setdefault('fix_source', 'photo')
        try:
            lat, lon = float(r['lat']), float(r['lon'])
        except (TypeError, ValueError, KeyError):
            untouched += 1
            continue
        r['orig_lat'], r['orig_lon'], r['orig_depth'] = r['lat'], r['lon'], r.get('depth', '')

        # 1. POSITION -- the plotter was on the boat and the phone was in a pocket.
        when = None
        if r.get('datetime'):
            try:
                when = eastern_to_utc(dt.datetime.strptime(r['datetime'], '%Y-%m-%dT%H:%M:%S'))
            except ValueError:
                when = None
        if when is not None:
            hit = nearest_in_time(pts, when)
            if hit and hit[0] <= a.max_gap_s:
                gap, (_, tlon, tlat, src) = hit
                d = metres(lon, lat, tlon, tlat)
                lat, lon = tlat, tlon
                r['lat'], r['lon'] = f'{tlat:.7f}', f'{tlon:.7f}'
                r['fix_source'] = f'track:{src}'
                r['fix_moved_m'] = f'{d:.0f}'
                moved += 1
                report.append(f'  {r["date"]} {r["time"]}  {r["species"][:18]:<18} '
                              f'moved {d:8.0f} m onto the track (gap {gap:.0f} s)')

        # 2. WATER -- containment, not the nearest name within twenty miles.
        p = Point(lon, lat)
        slug = None
        for i in tree.query(p):
            if geoms[i].contains(p):
                slug = slugs[i]
                break
        if slug is None:                            # a kayak against the bank still fishes the water
            best = None
            for i in tree.query(p.buffer(BANK_M / 111000.0)):
                d = geoms[i].distance(p) * 111000.0
                if d <= BANK_M and (best is None or d < best[0]):
                    best = (d, slugs[i])
            slug = best[1] if best else None
        r['water_slug'] = slug or ''

        # 3. DEPTH -- in that water's chart and nowhere else.
        flags = [f for f in (r.get('review_flags') or '').split('|') if f]
        note = re.sub(r'\s*\|?\s*Depth lookup:[^|]*', '', r.get('notes') or '').strip(' |')
        if not slug:
            r['depth'] = ''
            no_water += 1
            for f in ('depth_from_contours',):
                if f in flags:
                    flags.remove(f)
            if 'position_off_water' not in flags:
                flags.append('position_off_water')
        else:
            got = nearest_contour_mi(a.chartpack, slug, lon, lat)
            if got is None:
                r['depth'] = ''
                if 'depth_not_found' not in flags:
                    flags.append('depth_not_found')
                if 'depth_from_contours' in flags:
                    flags.remove('depth_from_contours')
            else:
                dist, ft = got
                rel = 'on' if dist < ON_CONTOUR_MI else 'near' if dist < 0.25 else 'off'
                note = (note + ' | ' if note else '') + \
                       f'Depth lookup: ~{ft}ft contour ({rel}, {dist:.2f} mi, {slug} chart)'
                if dist <= ON_CONTOUR_MI:
                    if str(r.get('depth') or '') != str(ft):
                        redepthed += 1
                    r['depth'] = str(ft)
                    if 'depth_from_contours' not in flags:
                        flags.append('depth_from_contours')
                else:
                    # COUNTED WHETHER OR NOT A DEPTH WAS THERE TO REMOVE. Counting only removals
                    # made a refusal invisible on the rows that never had a depth in the first
                    # place, and "nothing was dropped" then read as "every lookup was close".
                    blanked += 1
                    had = f'depth {r["depth"]} ft dropped' if r.get('depth') else 'no depth claimed'
                    report.append(f'  {r["date"]} {r["time"]}  {r["species"][:18]:<18} '
                                  f'{had}: nearest {slug} contour is {dist:.2f} mi away')
                    r['depth'] = ''
                    if 'depth_from_contours' in flags:
                        flags.remove('depth_from_contours')
                    if 'depth_chart_too_far' not in flags:
                        flags.append('depth_chart_too_far')
        r['notes'] = note
        r['review_flags'] = '|'.join(flags)

    os.makedirs(os.path.dirname(os.path.abspath(a.out)) or '.', exist_ok=True)
    with open(a.out, 'w', encoding='utf-8', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, '') for k in fields})

    print()
    for line in report:
        print(line)
    print(f'\n  positions replaced from the plotter : {moved}')
    print(f'  depths rewritten from the right chart: {redepthed}')
    print(f'  depths refused as too far to claim   : {blanked}')
    print(f'  rows with no water under them        : {no_water}')
    print(f'  rows with no position at all         : {untouched}')
    print(f'\nwrote {a.out}')


if __name__ == '__main__':
    main()
