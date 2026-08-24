#!/usr/bin/env python3
r"""build_nc_species_by_lake.py -- fish species per NC water, from NC WRC's own map service.

Personal use only, not for distribution or resale; not for navigation.

    py .\scripts\build_nc_species_by_lake.py --registry F:\TrollMapPipeline\registry
    py .\scripts\build_nc_species_by_lake.py --registry F:\TrollMapPipeline\registry --go

Dry run by default. `--go` writes `registry/nc_species_by_lake.json`.

WHY THIS EXISTS

`RESEARCH_RAMP_SOURCES` in Worker/research/facts-util.js reads a species list off the state ramp
feed, and it can only do that for two of the four states:

    SC:  species: p.SpeciesList
    GA:  species: p.SpeciesList || ''
    NC:  species: ''          <- hardcoded empty
    TN:  species: ''          <- hardcoded empty

That is not an oversight in our code: the NC WRC Boating Access Areas layer publishes 42 fields
and none of them is a species list. So `getRampSpeciesFacts` returns nothing for every NC water,
biology falls entirely to the web agents, and a lake with thin web coverage lands at zero. Lake
Glenville (Jackson Co, NC) came back on 2026-08-24 with `predatorSpecies: []` and `confidence
.biology: 35% -- unusable for Smart Plan`, while carrying the word "walleye" in its own summary
keywords. It is a known walleye and smallmouth fishery.

NC WRC does publish the species. Not in ArcGIS -- in the map application at
ncpaws.org/NCWRCMaps/FishingAreas, which has two endpoints of its own:

    Home/GetFilteredFishingAreas   every public fishing location, with waterbodyName and a point
    Home/GetFishingAreaInfo?locationID=N   that location's speciesInfo, with `wild` and `stocked`
                                           as separate booleans

912 locations across 392 waterbody names, measured 2026-08-24.

WHY A BUCKET AND NOT A LIVE WORKER CALL

The four `*_ramps_by_lake.json` files are built here and read from R2, and this is the same shape:
a research rerun must not depend on a third-party map app answering, and must not hit it once per
lake per run. Build it, ship it, read it.

THE MATCH NEEDS TWO SIGNALS, AND ONE OF THEM MUST BE GEOMETRY

Name alone re-points. `registryRecordFor` in js/data/access-index.js had to learn this on
2026-08-23: two Goose Creeks and two Silver Lakes in one state, and a single-namesake shortcut
still attached the wrong one. So a location binds to a water only when the point falls inside that
water's own bounding box, and the name is used to choose between boxes rather than instead of one.

Substring matching is allowed in exactly one place -- deciding whether "MOSS LAKE" is
"John H. Moss Lake" -- and ONLY when the point is already inside that water's box. Plain substring
matching cannot be made safe; substring-plus-geometry can.

Everything refused is written to `_nc_species_unmatched.json` rather than dropped, because a
location that binds to nothing is either a water we do not ship or a name we do not know, and the
second kind is worth reading.
"""
import argparse, io, json, math, os, re, sys, time
import urllib.request

AREAS_URL = 'https://www.ncpaws.org/NCWRCMaps/FishingAreas/Home/GetFilteredFishingAreas'
INFO_URL = 'https://www.ncpaws.org/NCWRCMaps/FishingAreas/Home/GetFishingAreaInfo?locationID=%d'
UA = 'TrollMap/1.0 (personal use; contact via github.com/colonal1981)'

GENERIC = re.compile(r'\b(lake|reservoir|pond|impoundment|res)\b', re.I)
COUNTY_PAREN = re.compile(r'\s*\([^)]*\bCo\b[^)]*\)\s*', re.I)
STATE_SUFFIX = re.compile(r',\s*(SC|NC|GA|TN)(/(?:SC|NC|GA|TN))*\s*$', re.I)


def norm(s):
    """Lowercase alphanumerics, county parenthetical and state suffix removed."""
    s = COUNTY_PAREN.sub(' ', str(s or ''))
    s = STATE_SUFFIX.sub('', s)
    s = re.sub(r'\s*\([^)]*\)\s*', ' ', s)
    return re.sub(r'[^a-z0-9]+', '', s.lower())


def norm_bare(s):
    """As `norm`, with the generic water word removed -- "MOSS LAKE" -> "moss"."""
    s = COUNTY_PAREN.sub(' ', str(s or ''))
    s = STATE_SUFFIX.sub('', s)
    s = re.sub(r'\s*\([^)]*\)\s*', ' ', s)
    return re.sub(r'[^a-z0-9]+', '', GENERIC.sub(' ', s).lower())


def row_names(rec):
    out = []
    for n in ([rec.get('display_name'), rec.get('legacy_display_name'), rec.get('name')]
              + list(rec.get('legacy_display_names') or [])):
        if n and n not in out:
            out.append(n)
    return out


def in_box(rec, lat, lon, pad=0.0):
    b = rec.get('bounds_wsen')
    if not b or len(b) != 4:
        return False
    return (b[0] - pad) <= lon <= (b[2] + pad) and (b[1] - pad) <= lat <= (b[3] + pad)


def centroid(rec):
    c = rec.get('centroid')
    if isinstance(c, (list, tuple)) and len(c) >= 2:
        return float(c[1]), float(c[0])          # stored lon,lat
    b = rec.get('bounds_wsen')
    if b and len(b) == 4:
        return (b[1] + b[3]) / 2.0, (b[0] + b[2]) / 2.0
    return None


def approx_miles(a_lat, a_lon, b_lat, b_lon):
    dy = (a_lat - b_lat) * 69.0
    dx = (a_lon - b_lon) * 69.0 * math.cos(math.radians((a_lat + b_lat) / 2.0))
    return math.hypot(dx, dy)


def get_json(url, timeout=30):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as fh:
        return json.loads(fh.read().decode('utf-8-sig'))


def load_areas(a):
    if a.areas:
        return json.load(io.open(a.areas, encoding='utf-8-sig'))
    return get_json(AREAS_URL)


def bind(loc, idx, by_name, by_bare):
    """(slug, how) for one location, or (None, why).

    INSIDE THE BOX IS THE REQUIREMENT. The name only chooses between boxes.
    """
    lat, lon = loc.get('latitude'), loc.get('longitude')
    if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
        return None, 'no coordinate'
    boxes = [s for s in idx if in_box(idx[s], lat, lon)]
    if not boxes:
        return None, 'outside every registry water'

    wb = loc.get('waterbodyName')
    named = by_name.get(norm(wb)) or set()
    hit = [s for s in boxes if s in named]
    if len(hit) == 1:
        return hit[0], 'name+box'

    bare = by_bare.get(norm_bare(wb)) or set()
    hit = [s for s in boxes if s in bare]
    if len(hit) == 1:
        return hit[0], 'bare name+box'

    # "MOSS LAKE" against "John H. Moss Lake": one normalised name contains the other. ONLY
    # decided here, with the point already inside that water's box, and only if it is unique.
    nb = norm_bare(wb)
    if nb:
        hit = [s for s in boxes
               if any(nb and (nb in norm_bare(n) or norm_bare(n) in nb) for n in row_names(idx[s]))]
        if len(hit) == 1:
            return hit[0], 'contained name+box'

    # NO NAME AGREEMENT, NO BINDING -- and both weaker rules were BUILT, MEASURED AND CUT.
    #
    # `box only` (one box, name disagrees) and `nearest centroid` (several boxes, closest wins)
    # produced 172 bindings between them on the first run, and the thirteen the centroid rule
    # decided were mostly wrong when read: RIVERBEND PARK POND onto Lookout Shoals Lake, HARRIS
    # LAKE PARK POND onto Shearon Harris Reservoir, FALLS LAKE onto the Uwharrie River, LITTLE
    # RIVER (DH) onto the South Fork New River. NC WRC lists park ponds and tributaries as their
    # own waters, and a park pond sits inside the reservoir's bounding box by definition.
    #
    # A bounding box is a RECTANGLE around a lake, not the lake. Being inside one is not
    # evidence of being the same water, which is the whole reason registryRecordFor needs a
    # second signal. So the name has to agree in one of the three forms above, and a location
    # whose water we cannot name is refused and written to _nc_species_unmatched.json where it
    # can be read.
    return None, ('inside %d box(es), name agrees with none' % len(boxes))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--registry', default='registry')
    ap.add_argument('--areas', help='a saved GetFilteredFishingAreas response. Fetched live if omitted.')
    ap.add_argument('--out', help='default <registry>/nc_species_by_lake.json')
    ap.add_argument('--cache', help='default <registry>/_nc_species_cache.json')
    ap.add_argument('--sleep', type=float, default=0.4, help='seconds between location requests')
    ap.add_argument('--refresh', action='store_true', help='ignore the cache and refetch every location')
    ap.add_argument('--date', default=None, help='stamp written into the output; default today')
    ap.add_argument('--go', action='store_true', help='write. Without it nothing is touched.')
    a = ap.parse_args()

    R = a.registry
    out_fp = a.out or os.path.join(R, 'nc_species_by_lake.json')
    cache_fp = a.cache or os.path.join(R, '_nc_species_cache.json')

    idx = json.load(io.open(os.path.join(R, 'lake_index.json'), encoding='utf-8'))
    nc = {s: r for s, r in idx.items() if str(r.get('state') or '').upper().startswith('NC')
          or 'NC' in str(r.get('state') or '').upper()}
    print('registry: %d rows, %d of them NC' % (len(idx), len(nc)))

    by_name, by_bare = {}, {}
    for slug, rec in nc.items():
        for n in row_names(rec):
            by_name.setdefault(norm(n), set()).add(slug)
            by_bare.setdefault(norm_bare(n), set()).add(slug)

    areas = load_areas(a)
    print('locations: %d from %s' % (len(areas), a.areas or AREAS_URL))

    hits, refused = {}, []
    how = {}
    for loc in areas:
        slug, why = bind(loc, nc, by_name, by_bare)
        if slug:
            loc = dict(loc, _how=why)
            hits.setdefault(slug, []).append(loc)
            how[why] = how.get(why, 0) + 1
        else:
            refused.append({'locationID': loc.get('locationID'), 'locationName': loc.get('locationName'),
                            'waterbodyName': loc.get('waterbodyName'), 'lat': loc.get('latitude'),
                            'lon': loc.get('longitude'), 'why': why})
    print('bound %d location(s) onto %d water(s); %d refused' % (sum(len(v) for v in hits.values()), len(hits), len(refused)))
    for k in sorted(how, key=lambda k: -how[k]):
        print('   %-24s %d' % (k, how[k]))
    whys = {}
    for r in refused:
        whys[r['why']] = whys.get(r['why'], 0) + 1
    for k in sorted(whys, key=lambda k: -whys[k]):
        print('   refused: %-30s %d' % (k, whys[k]))

    # THE WEAKEST RULE GETS NAMED, EVERY RUN. `nearest centroid` fires when a point sits inside
    # more than one water's box and no name agreed -- it is the only binding here decided by
    # distance alone, and it is the one to read rather than the 500 that are not.
    weak = [(s_, l) for s_, v in hits.items() for l in v if l.get('_how') == 'nearest centroid']
    if weak:
        print('\n%d binding(s) decided by distance alone -- check these:' % len(weak))
        for s_, l in sorted(weak, key=lambda x: x[0]):
            print('   %-28s %-26s %s' % (s_, str(l.get('locationName'))[:26], l.get('waterbodyName')))

    cache = {}
    if os.path.exists(cache_fp) and not a.refresh:
        try:
            cache = json.load(io.open(cache_fp, encoding='utf-8'))
        except Exception as exc:
            print('  !! cache unreadable (%s) -- starting empty' % str(exc)[:60])

    need = [str(l['locationID']) for v in hits.values() for l in v if str(l['locationID']) not in cache]
    print('species lookups: %d cached, %d to fetch' % (len(cache), len(need)))
    if not a.go:
        print('\nDRY RUN -- no requests made, nothing written. Add --go.')
        _report(hits, cache, idx)
        return 0

    for i, lid in enumerate(need, 1):
        try:
            cache[lid] = get_json(INFO_URL % int(lid))
        except Exception as exc:
            print('   !! locationID %s failed: %s' % (lid, str(exc)[:80]))
            cache[lid] = {'_error': str(exc)[:200]}
        if i % 25 == 0 or i == len(need):
            print('   [%d/%d]' % (i, len(need)))
            json.dump(cache, io.open(cache_fp, 'w', encoding='utf-8'), indent=1)
        time.sleep(a.sleep)
    json.dump(cache, io.open(cache_fp, 'w', encoding='utf-8'), indent=1)

    stamp = a.date or time.strftime('%Y-%m-%d')
    lakes = {}
    for slug, locs in sorted(hits.items()):
        wild, stocked, used = [], [], []
        for l in locs:
            info = cache.get(str(l['locationID'])) or {}
            for sp in (info.get('speciesInfo') or []):
                name = str(sp.get('commonName') or '').strip()
                if not name:
                    continue
                if name not in wild:
                    wild.append(name)
                if sp.get('stocked') and name not in stocked:
                    stocked.append(name)
            if info.get('speciesInfo'):
                used.append({'locationID': l['locationID'], 'locationName': l.get('locationName'),
                             'waterbodyName': l.get('waterbodyName'), 'matchedBy': l.get('_how')})
        if wild:
            lakes[slug] = {'predatorSpecies': sorted(wild), 'knownStockings': sorted(stocked),
                           'locations': used}
    body = {'generated': stamp,
            'source': 'NC WRC public fishing areas (ncpaws.org/NCWRCMaps/FishingAreas)',
            'note': 'commonName per location; `stocked` is NC WRC\'s own flag. Built by '
                    'build_nc_species_by_lake.py -- do not hand-edit.',
            'lakes': lakes}
    json.dump(body, io.open(out_fp, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
    json.dump(refused, io.open(os.path.join(R, '_nc_species_unmatched.json'), 'w', encoding='utf-8'), indent=1)
    print('-> %s   (%d waters carry species)' % (out_fp, len(lakes)))
    print('-> %s   (%d locations bound to nothing)' % (os.path.join(R, '_nc_species_unmatched.json'), len(refused)))
    _report(hits, cache, idx)
    return 0


def _report(hits, cache, idx):
    have = [s for s in hits if any((cache.get(str(l['locationID'])) or {}).get('speciesInfo') for l in hits[s])]
    print('\n%d water(s) matched, %d with species already cached' % (len(hits), len(have)))
    for slug in sorted(hits)[:12]:
        locs = hits[slug]
        sp = []
        for l in locs:
            for x in ((cache.get(str(l['locationID'])) or {}).get('speciesInfo') or []):
                if x.get('commonName') not in sp:
                    sp.append(x.get('commonName'))
        print('   %-30s %-34s %s' % (slug, str(idx[slug].get('display_name'))[:34],
                                     ', '.join(sp) if sp else '(not fetched yet)'))
    if len(hits) > 12:
        print('   ... %d more' % (len(hits) - 12))


if __name__ == '__main__':
    sys.exit(main())
