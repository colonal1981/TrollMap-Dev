#!/usr/bin/env python3
r"""zone_coverage.py - does every SALTWATER ramp land in a coastal zone?

Personal use only, not for distribution or resale; not for navigation.

    py .\zone_coverage.py `
       --catalog "F:\TrollMapPipeline\TrollMap-Dev-main\Scripts\coastal_catalog.py" `
       --feeds   "F:\TrollMapPipeline\registry" `
       --line    "F:\TrollMapPipeline\Saltwater_Freshwater_Dividing_Line.geojson"

WHY THIS RUNS BEFORE ANYTHING IS CUT

Under the design Ryan chose, a saltwater waterbody gets NO boundary of its own -- it becomes a
pointer to the coastal zone that contains it, carrying its own viewport so selecting "Shem
Creek" pans to Shem Creek and draws the zone's contours. That only works if every saltwater
ramp actually falls inside a zone. One that does not becomes a pointer to nothing: the name
appears in the list, you select it, and nothing happens. Silently. That is the exact failure
shape this project keeps producing, so it gets measured before it can be built on.

An older figure -- "62 of 198 SC coastal ramps fall outside every zone" -- predates the zone
redraw in commit bd0c8be and must NOT be quoted. This re-measures.

Classification:
  SC        the statutory line (SC Code 50-5-80) via classify_salt_fresh
  NC, GA    zone membership itself -- Ryan's call, since NC publishes only descriptive
            boundaries and GA has no statutory line. A ramp inside a coast_*_nc / coast_*_ga
            zone is coastal by construction.
"""
import argparse, codecs, json, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from classify_salt_fresh import load_dividers, build_index, classify
    import classify_salt_fresh as CSF
except ImportError as exc:
    sys.exit('needs classify_salt_fresh.py beside this file: %s' % exc)
import math


def parse_catalog(path):
    """coastal_catalog.py is Python, but importing it drags its whole dependency chain in.
    The three fields needed here are literals, so read them out directly."""
    s = open(path, encoding='utf-8').read()
    zones = {}
    for m in re.finditer(r"'(coast_\w+)'\s*:\s*\{(.*?)\n    \}", s, re.S):
        slug, body = m.group(1), m.group(2)
        bb = re.search(r"'bbox'\s*:\s*\(([^)]*)\)", body)
        if not bb:
            continue
        nm = re.search(r"'name'\s*:\s*'([^']*)'", body)
        st = re.search(r"'state'\s*:\s*'([^']*)'", body)
        s_lat, n_lat, w_lon, e_lon = [float(x.strip()) for x in bb.group(1).split(',')]
        zones[slug] = {'name': nm.group(1) if nm else slug,
                       'state': st.group(1) if st else '?',
                       's': s_lat, 'n': n_lat, 'w': w_lon, 'e': e_lon}
    return zones


def zone_of(lat, lon, zones, state=None):
    """Slug of the zone containing this point, or None. Smallest wins where boxes overlap --
    19 pairs of these overlap, and the tighter box is the more specific answer."""
    hits = []
    for slug, z in zones.items():
        if state and z['state'] != state:
            continue
        if z['s'] <= lat <= z['n'] and z['w'] <= lon <= z['e']:
            hits.append((abs(z['n'] - z['s']) * abs(z['e'] - z['w']), slug))
    if not hits:
        return None
    return min(hits)[1]


def nearest_zone(lat, lon, zones, state=None, within_km=None):
    """Slug of the containing zone, else the nearest one within `within_km`, else None.

    WHY THE SLACK EXISTS. For NC and GA there is no usable statutory line, so zone membership
    IS the classifier -- and that makes "outside every zone" mean freshwater. For an inland
    lake that is right. For a tidal creek whose landing sits just past a zone edge it is
    exactly backwards: it gets called fresh, seeds the marsh, and the cutter walks it 200
    polygons into the estuary. Turtle River came back 1,053 km2 from a single ramp that way.

    Ryan fishes no saltwater in NC and only Savannah in GA, so in those states a ramp wrongly
    called SALT costs a pointer he will not use, while one wrongly called FRESH costs a
    thousand square kilometres of nonsense boundary. The slack leans the error the cheap way.
    """
    hit = zone_of(lat, lon, zones, state)
    if hit or not within_km:
        return hit
    best = None
    for slug, z in zones.items():
        if state and z['state'] != state:
            continue
        dlat = 0.0 if z['s'] <= lat <= z['n'] else min(abs(lat - z['s']), abs(lat - z['n']))
        dlon = 0.0 if z['w'] <= lon <= z['e'] else min(abs(lon - z['w']), abs(lon - z['e']))
        km = math.hypot(dlat * 111.32, dlon * 111.32 * math.cos(math.radians(lat)))
        if km <= within_km and (best is None or km < best[0]):
            best = (km, slug)
    return best[1] if best else None


def read_feed(folder, st):
    fp = os.path.join(folder, '_dnr_ramps_%s.json' % st)
    if not os.path.exists(fp):
        print('  !! missing %s' % fp)
        return {}
    raw = open(fp, 'rb').read()
    if raw[:3] == codecs.BOM_UTF8:
        raw = raw[3:]
    out = {}
    for wb, ramps in (json.loads(raw.decode('utf-8')).get('waterbodies') or {}).items():
        pts = [(r.get('name') or '?', r['lat'], r['lon']) for r in ramps
               if isinstance(r.get('lat'), (int, float)) and isinstance(r.get('lon'), (int, float))]
        if pts:
            out.setdefault(wb, []).extend(pts)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--catalog', required=True)
    ap.add_argument('--feeds', required=True)
    ap.add_argument('--line', required=True, help='Saltwater_Freshwater_Dividing_Line.geojson')
    ap.add_argument('--out', help='write the classification as JSON')
    a = ap.parse_args()

    CSF.SEAWARD = (math.cos(math.radians(-45.0)), math.sin(math.radians(-45.0)))
    index = build_index(load_dividers(a.line))

    zones = parse_catalog(a.catalog)
    print('%d coastal zones  (SC %d, NC %d, GA %d)'
          % (len(zones), *[sum(1 for z in zones.values() if z['state'] == s) for s in ('SC', 'NC', 'GA')]))

    result, orphans = {}, []
    tally = {'salt': 0, 'fresh': 0}
    for st in ('sc', 'nc', 'ga'):
        for wb, ramps in read_feed(a.feeds, st).items():
            for rname, lat, lon in ramps:
                z = zone_of(lat, lon, zones)
                if st == 'sc':
                    verdict = classify(lon, lat, index, wb)[0]
                else:
                    # NC/GA: the zone IS the classifier.
                    verdict = 'salt' if z else 'fresh'
                tally[verdict] = tally.get(verdict, 0) + 1
                rec = result.setdefault(wb, {'state': st.upper(), 'salt': [], 'fresh': []})
                rec[verdict].append({'ramp': rname, 'lat': lat, 'lon': lon, 'zone': z})
                if verdict == 'salt' and not z:
                    orphans.append((st.upper(), wb, rname, lat, lon))

    salt_wb = [w for w, r in result.items() if r['salt']]
    mixed = [w for w, r in result.items() if r['salt'] and r['fresh']]
    print('%d waterbodies, %d saltwater ramps, %d freshwater'
          % (len(result), tally.get('salt', 0), tally.get('fresh', 0)))
    print('%d waterbodies have at least one saltwater ramp, %d are MIXED' % (len(salt_wb), len(mixed)))
    print()

    if orphans:
        print('ORPHANS -- saltwater ramps in NO coastal zone (%d).' % len(orphans))
        print('Each is a name that would point at nothing. Widen a zone or add one.')
        for stt, wb, rn, lat, lon in orphans[:40]:
            print('   %-3s %-30s %-28s %8.4f %9.4f' % (stt, wb[:30], rn[:28], lat, lon))
        if len(orphans) > 40:
            print('   ... and %d more' % (len(orphans) - 40))
    else:
        print('No orphans: every saltwater ramp falls inside a coastal zone.')
    print()

    byzone = {}
    for r in result.values():
        for s in r['salt']:
            byzone[s['zone']] = byzone.get(s['zone'], 0) + 1
    print('saltwater ramps per zone:')
    for slug, n in sorted(byzone.items(), key=lambda kv: -kv[1]):
        print('   %-34s %3d' % (str(slug), n))
    empty = [s for s in zones if s not in byzone]
    if empty:
        print()
        print('zones with no saltwater ramp at all (%d): %s' % (len(empty), ', '.join(empty)))

    if a.out:
        json.dump(result, open(a.out, 'w', encoding='utf-8'), indent=1)
        print('\n-> %s' % a.out)
    return 1 if orphans else 0


if __name__ == '__main__':
    sys.exit(main())
