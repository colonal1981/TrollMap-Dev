#!/usr/bin/env python3
"""
fetch_sc_fish_advisories.py -- SC fish consumption advisories as a species presence floor.

Personal use only, not for distribution or resale; not for navigation.

    py .\\scripts\\fetch_sc_fish_advisories.py --registry "F:\\TrollMapPipeline\\registry"
    py .\\scripts\\fetch_sc_fish_advisories.py --registry ... --from-raw     (no network)

Writes  registry\\sc_fish_advisories.json   and, always, the untouched server response to
        registry\\_sc_fish_advisories_raw.json

NO CREDENTIAL OF ANY KIND. The service is public and keyless.

WHY THIS SOURCE EXISTS IN THE PIPELINE AT ALL

Ryan found it, 2026-09-03, looking at Lake H.B. Robinson -- 2,099 acres, 61 km from Sumter, an
SCDNR ramp on it, and no species list anywhere we harvest. SCDNR publishes no per-lake page for
it (the /lakes/<name>/description.html pattern that serves Fishing Creek 404s), the SC book's only
"Lake Robinson" rule names Greenville County and belongs to the OTHER Lake Robinson 190 km away,
and it is not among the 183 agency pages we have read that bound to no slug.

An advisory is written PER SPECIES, so it names the fish in the water:

    Bass- Largemouth      One meal per month
    Bluegill              One meal per week
    Bowfin (Mudfish)      DO NOT EAT ANY
    Chain Pickerel        One meal per week
    Sunfish- Redear       No Restrictions
    Warmouth              One meal per week

THIS IS A PRESENCE FLOOR, NOT A ROSTER, and the output says so on every record. The same rule the
by-water regulations floor already carries: it unions in UNDERNEATH a roster and must never
overwrite one. "Largemouth: one meal per month" proves largemouth are there and says nothing about
what else is.

AND IT IS SAFETY DATA IN ITS OWN RIGHT. "DO NOT EAT ANY" on a water somebody keeps fish from is
worth surfacing whether or not the species list is ever used, so the advice text travels with the
species rather than being thrown away once a name has been taken.

THE SERVICE, VERIFIED 2026-09-03

    https://gis.des.sc.gov/gisserver/rest/services/water/FishAdvisories/MapServer
      serviceDescription "SCDHEC Watershed Atlas"   capabilities Map,Query,Data   wkid 26917
      0  Fish Tissue Sampling Stations                     station, basin, county, description
      1  Coastal Critical Area                             not ours
      2  Freshwater Fish Consumption Advisories    114      polygons
      3  Estuarine/Marine Fish Consumption Adv.      1      polygon

Layer 2 is the whole of the value; layer 3 is a single feature and is fetched anyway because one
is not zero and the cost is one request.

THE FIELD NAMED Waterbody_URL IS NOT A URL. Its alias is RESTRICTIONS and its content is the
species text above. A value is never the type its column implies -- this file has met that three
times now (numpy arrays stringified into JSON, NaN being a float, and now a URL that is prose).

WHY THE RAW RESPONSE IS ALWAYS SAVED

Nothing in this project's sandbox has outbound network; only a summarising reader reaches external
hosts, and it returns its RENDERING rather than the bytes. Writing this parser I was shown that
restriction field twice, in two different shapes -- once as `"Bass- Largemouth: One meal per
month; Bowfin (Mudfish): DO NOT EAT ANY"` and once as species and advice on alternating lines --
and there is no way from here to know which one the server actually sends. So:

  * the parser accepts BOTH shapes and anything close to them,
  * whatever it cannot read is kept in `unparsed` and printed loudly rather than dropped,
  * and the untouched response is written to disk on every run, so the parser can be tightened
    against real bytes instead of against a paraphrase.

Run it once and the guessing stops.

BINDING IS NAME **AND** GEOMETRY, WHICH THIS SOURCE FINALLY ALLOWS

build_water_advisories.py -- EPA ATTAINS, the other advisory source -- has a docstring that is
mostly an apology for binding by name alone, because ATTAINS assessment units carry no geometry
at all. These are polygons. So the standing rule applies here in full:

  1. STATE-SCOPED.        SC only. Every cross-state failure mode disappears.
  2. GEOMETRY FIRST.      The advisory polygon must actually overlap our boundary.
  3. A DISTINCTIVE TOKEN. "Lake", "River", "Creek", "Pond" identify nothing.
  4. AMBIGUITY IS DROPPED, NOT GUESSED, and reported. Three pairs of SC waters share a display
     name inside one county, and there are two Lake Robinsons 190 km apart.
"""

import argparse
import json
import os
import re
import sys
import urllib.parse
import urllib.request

SERVICE = ('https://gis.des.sc.gov/gisserver/rest/services/water/FishAdvisories/MapServer')
LAYERS = {2: 'freshwater', 3: 'estuarine', 0: 'tissue_station'}
OUT_NAME = 'sc_fish_advisories.json'
RAW_NAME = '_sc_fish_advisories_raw.json'
PAGE = 500

# Words that name no water. Same list the ATTAINS binder uses, for the same reason.
GENERIC = {
    'lake', 'lakes', 'river', 'rivers', 'creek', 'creeks', 'pond', 'ponds', 'reservoir',
    'reservoirs', 'branch', 'run', 'fork', 'bay', 'sound', 'swamp', 'canal', 'basin',
    'north', 'south', 'east', 'west', 'upper', 'lower', 'little', 'big', 'old', 'new',
    'the', 'and', 'sc', 'south carolina', 'county', 'state', 'fork',
}


# ── the service ─────────────────────────────────────────────────────────────────────────────

def _get(url):
    """One request. ARCGIS ANSWERS ERRORS WITH HTTP 200 AND AN `error` KEY, so 200 is not enough."""
    req = urllib.request.Request(url, headers={'User-Agent': 'TrollMap/1.0 (personal use)'})
    with urllib.request.urlopen(req, timeout=90) as r:
        body = json.loads(r.read().decode('utf-8', 'replace'))
    if isinstance(body, dict) and body.get('error'):
        raise SystemExit('ArcGIS returned an error for %s\n  %s'
                         % (url, json.dumps(body['error'])[:400]))
    return body


def fetch_layer(layer_id, want_geometry=True):
    """Every feature of one layer, in WGS84, paged. Returns the raw feature list."""
    out, offset = [], 0
    while True:
        q = {
            'where': '1=1', 'outFields': '*', 'f': 'json',
            'returnGeometry': 'true' if want_geometry else 'false',
            'outSR': '4326',          # the service is UTM 17N (wkid 26917); we work in lon/lat
            'resultOffset': str(offset), 'resultRecordCount': str(PAGE),
        }
        url = '%s/%d/query?%s' % (SERVICE, layer_id, urllib.parse.urlencode(q))
        body = _get(url)
        feats = body.get('features') or []
        out += feats
        if len(feats) < PAGE or not body.get('exceededTransferLimit'):
            break
        offset += len(feats)
    return out


# ── the restriction text ────────────────────────────────────────────────────────────────────

# "One meal per week", "DO NOT EAT ANY", "No Restrictions", "One meal per month".
ADVICE = re.compile(
    r'\s*(?:do\s*not\s*eat[a-z ]*|no\s+restrictions?|one\s+meal\s+per\s+\w+|'
    r'\d+\s+meals?\s+per\s+\w+)\s*', re.I)


def uninvert(name):
    """'Bass- Largemouth' -> 'Largemouth Bass'. 'Sunfish- Redear' -> 'Redear Sunfish'.

    The advisory writes a group first and the qualifier after a hyphen, which is how a table is
    sorted and not how a fish is called. Everything else is left exactly as published -- a
    parenthetical like 'Bowfin (Mudfish)' is the shape species_alternates() already expands.
    """
    s = str(name or '').strip().strip(',;')
    m = re.match(r'^\s*([A-Za-z][A-Za-z\' ]*?)\s*-\s*([A-Za-z][A-Za-z\' ]*)\s*$', s)
    if m:
        return '%s %s' % (m.group(2).strip(), m.group(1).strip())
    return s


# The field is HTML. Measured, not guessed -- the raw bytes for Lake H.B. Robinson, 2026-09-03:
#
#   <strong>Bass- Largemouth</strong><ul style="list-style: none; margin: 0;">
#   <li>One meal per month</ul><strong>Bluegill</strong><ul ...><li>One meal per week</ul>...
#
# The <li> is never closed; the </ul> ends it.
HTML_PAIR = re.compile(
    r'<strong[^>]*>\s*(?P<species>.*?)\s*</strong>\s*'
    r'(?:<ul[^>]*>\s*(?:<li[^>]*>)?\s*(?P<advice>.*?)\s*</(?:li|ul)>)?',
    re.I | re.S)
TAG = re.compile(r'<[^>]+>')


def strip_tags(s):
    return re.sub(r'\s+', ' ', TAG.sub(' ', str(s or ''))).strip()


def parse_restrictions(text):
    """[{species, advice, published_as}], plus what could not be read, plus water-level notes.

    THE SHAPE WAS GUESSED ONCE AND THE GUESS WAS WRONG, WHICH IS WHY THIS READS THREE.

    Nothing in this project's sandbox has outbound network; only a summarising reader reaches
    external hosts, and it returns its RENDERING rather than the bytes. Written from that
    rendering, this function first accepted a colon/semicolon string and alternating plain-text
    lines. The field is neither -- it is HTML, with no colon and no newline anywhere in it, so
    the first version would have failed on all 114 features and Ryan would have run it for
    nothing. Ryan asked the question that got the bytes: "the map is pulled from the api?"

    HTML is the real shape and is tried first. The two plain-text shapes are kept underneath
    because the column is 4,000 characters of free text and a state can change how it fills it;
    they cost two regexes and they cannot fire against HTML.

    AN ADVICE PHRASE WITH NO SPECIES IS NOT A SPECIES. 'J. Robinson Lake' publishes exactly
    `<strong>No Restrictions</strong>` and nothing else. Reading that as a fish called "No
    Restrictions" would put a species that does not exist into a plan.
    """
    raw = str(text or '').strip()
    if not raw:
        return [], [], []
    pairs, unparsed, notes = [], [], []

    if '<' in raw and '>' in raw:
        seen_end = 0
        for m in HTML_PAIR.finditer(raw):
            sp = strip_tags(m.group('species'))
            ad = strip_tags(m.group('advice')) if m.group('advice') else ''
            if not sp:
                continue
            if not ad and ADVICE.fullmatch(sp):
                notes.append(sp)          # a whole-water statement, not a fish
            elif ad:
                pairs.append({'species': uninvert(sp), 'advice': ad, 'published_as': sp})
            else:
                unparsed.append(sp)
            seen_end = m.end()
        leftover = strip_tags(raw[seen_end:])
        if leftover:
            unparsed.append(leftover)
        if pairs or notes or unparsed:
            return pairs, unparsed, notes

    # Plain-text fallbacks. Neither can fire against the HTML above.
    if ':' in raw:
        for chunk in re.split(r'[;|\n\r]+', raw):
            c = chunk.strip()
            if not c:
                continue
            if ':' in c:
                sp, ad = c.split(':', 1)
                sp, ad = sp.strip(), ad.strip()
                if sp and ad:
                    pairs.append({'species': uninvert(sp), 'advice': ad, 'published_as': sp})
                    continue
            unparsed.append(c)
        if pairs:
            return pairs, unparsed, notes

    lines = [l.strip() for l in re.split(r'[\n\r]+', raw) if l.strip()]
    i = 0
    while i < len(lines):
        sp = lines[i]
        ad = lines[i + 1] if i + 1 < len(lines) else ''
        if ad and ADVICE.search(ad) and not ADVICE.search(sp):
            pairs.append({'species': uninvert(sp), 'advice': ad, 'published_as': sp})
            i += 2
            continue
        unparsed.append(sp)
        i += 1
    return pairs, unparsed, notes


def do_not_eat(advice):
    """True when the state says do not eat this fish at all. Kept as its own question."""
    return bool(re.search(r'do\s*not\s*eat', str(advice or ''), re.I))


# ── binding ─────────────────────────────────────────────────────────────────────────────────

def tokens(s):
    """Lowercase word tokens with the generic geography removed."""
    return {t for t in re.findall(r"[a-z']+", str(s or '').lower())
            if len(t) > 2 and t not in GENERIC}


def name_agrees(advisory_name, our_name):
    """A shared token that is not generic geography. Returns the tokens that agreed."""
    return tokens(advisory_name) & tokens(our_name)


def _ring_area(ring):
    """Signed shoelace area. POSITIVE is counter-clockwise in the usual convention."""
    a = 0.0
    for i in range(len(ring)):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % len(ring)]
        a += x1 * y2 - x2 * y1
    return a / 2.0


def arcgis_polygons(geom):
    """ArcGIS `rings` -> the shape geomcore._shapely_geom() wants: [[exterior, hole, ...], ...].

    THIS IS NOT A FLAT LIST OF RINGS, and handing it one is how the first version of this
    function bound nothing at all: _shapely_geom reads `p[0]` as the EXTERIOR and `p[1:]` as the
    holes, so a flat list made `p[0]` a single coordinate pair, `len(p[0]) < 4` was true for every
    feature, and all 114 advisories came back "polygon did not build".

    ArcGIS writes exterior rings CLOCKWISE and holes counter-clockwise, so the sign of the
    shoelace area separates them: negative (clockwise) starts a new polygon, positive attaches as
    a hole to the one before it.

    A FEATURE WHOSE RINGS ARE ALL THE SAME WINDING still returns something. Some producers ignore
    the convention, and dropping the feature silently would be a gap nobody can see; the largest
    ring becomes the exterior and the rest become its holes.
    """
    rings = []
    for ring in (geom or {}).get('rings') or []:
        pts = [(float(p[0]), float(p[1]))
               for p in ring if isinstance(p, (list, tuple)) and len(p) >= 2]
        if len(pts) >= 4:
            rings.append(pts)
    if not rings:
        return []
    polys = []
    for r in rings:
        if _ring_area(r) < 0 or not polys:      # clockwise -> a new exterior
            polys.append([r])
        else:                                   # counter-clockwise -> a hole in the last one
            polys[-1].append(r)
    # Nothing was clockwise: the winding cannot be trusted, so use size instead of convention.
    if len(polys) == 1 and len(polys[0]) > 1 and all(_ring_area(r) > 0 for r in rings):
        biggest = max(rings, key=lambda r: abs(_ring_area(r)))
        polys = [[biggest] + [r for r in rings if r is not biggest]]
    return polys


def bind(features, index, bounds_dir, report):
    """Bind advisory polygons to our slugs by GEOMETRY and NAME. Ambiguity is dropped."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    try:
        from find_duplicate_waters import rings_of
        from geomcore import _shapely_geom
        from shapely.geometry import Polygon
        from shapely.strtree import STRtree
    except ImportError as exc:
        raise SystemExit('geometry binding needs shapely and the pipeline helpers: %s' % exc)

    slugs, geoms = [], []
    for slug, rec in index.items():
        if (rec.get('state') or '').upper() != 'SC':
            continue                      # 1. STATE-SCOPED
        p = os.path.join(bounds_dir, '%s.geojson' % slug)
        if not os.path.exists(p):
            continue
        g = _shapely_geom(rings_of(p))
        if g is not None and not g.is_empty and g.area > 0:
            slugs.append(slug)
            geoms.append(g)
    report['sc_waters_with_a_boundary'] = len(geoms)
    if not geoms:
        raise SystemExit('no SC boundary polygons under %s -- nothing to bind to' % bounds_dir)
    tree = STRtree(geoms)

    bound, ambiguous, unbound = {}, [], []
    for f in features:
        attrs = f.get('attributes') or {}
        aname = attrs.get('NAME') or ''
        rings = arcgis_polygons(f.get('geometry'))
        if not rings:
            unbound.append({'name': aname, 'why': 'advisory feature carries no polygon'})
            continue
        apoly = _shapely_geom(rings)
        if apoly is None or apoly.is_empty:
            unbound.append({'name': aname, 'why': 'advisory polygon did not build'})
            continue

        hits = []
        for i in tree.query(apoly):
            g, slug = geoms[i], slugs[i]
            if not g.intersects(apoly):
                continue                                   # 2. GEOMETRY FIRST
            agreed = name_agrees(aname, index[slug].get('display_name') or slug)
            if not agreed:
                continue                                   # 3. A DISTINCTIVE TOKEN
            inter = g.intersection(apoly).area
            hits.append({'slug': slug, 'tokens': sorted(agreed),
                         'overlap_frac_of_ours': (inter / g.area) if g.area else 0.0})
        if not hits:
            unbound.append({'name': aname, 'why': 'no SC water both overlaps it and shares a '
                                                  'distinctive name token'})
        elif len(hits) > 1:
            # 4. AMBIGUITY IS DROPPED, NOT GUESSED.
            ambiguous.append({'name': aname, 'candidates': [h['slug'] for h in hits]})
        else:
            bound[hits[0]['slug']] = {'match': hits[0], 'attributes': attrs}
    return bound, ambiguous, unbound


# ── main ────────────────────────────────────────────────────────────────────────────────────

def build(raw, index, bounds_dir):
    report = {}
    waters, all_ambiguous, all_unbound, all_unparsed = {}, [], [], []
    for layer_id, kind in (('2', 'freshwater'), ('3', 'estuarine')):
        feats = raw.get(layer_id) or []
        report['layer_%s_features' % layer_id] = len(feats)
        bound, ambiguous, unbound = bind(feats, index, bounds_dir, report)
        all_ambiguous += [dict(a, layer=kind) for a in ambiguous]
        all_unbound += [dict(u, layer=kind) for u in unbound]
        for slug, hit in bound.items():
            a = hit['attributes']
            pairs, unparsed, notes = parse_restrictions(a.get('Waterbody_URL'))
            if unparsed:
                all_unparsed.append({'slug': slug, 'name': a.get('NAME'), 'text': unparsed})
            rec = waters.setdefault(slug, {
                'display_name': index[slug].get('display_name') or slug,
                'state': 'SC', 'water_type': kind, 'advisories': [], 'species': [],
                'do_not_eat': [],
                'basis': 'PRESENCE FLOOR, not a roster. An advisory names a species because the '
                         'state sampled it here; it says nothing about what else is present, and '
                         'it must union in underneath a roster rather than replace one.',
            })
            if notes:
                rec.setdefault('water_level_notes', [])
                for n in notes:
                    if n not in rec['water_level_notes']:
                        rec['water_level_notes'].append(n)
            rec['advisories'].append({
                'name': a.get('NAME'), 'advisory': a.get('ADVISORY'), 'basin': a.get('Basin'),
                'type': a.get('TYPE'), 'restrictions_text': a.get('Waterbody_URL'),
                'matched_on': hit['match'], 'confidence': 'name+geom',
                'source': '%s/%s' % (SERVICE, layer_id),
            })
            for p in pairs:
                if p['species'] not in [s['species'] for s in rec['species']]:
                    rec['species'].append(p)
                if do_not_eat(p['advice']) and p['species'] not in rec['do_not_eat']:
                    rec['do_not_eat'].append(p['species'])

    return {
        '_note': 'Personal use only, not for distribution or resale; not for navigation. '
                 'SC fish consumption advisories as a SPECIES PRESENCE FLOOR and as safety text. '
                 'Built by fetch_sc_fish_advisories.py from the SCDHEC Watershed Atlas.',
        'source': SERVICE,
        'confidence': 'name+geom -- the advisory polygon overlaps our boundary AND shares a '
                      'distinctive name token. Ambiguous matches are dropped, not guessed.',
        'waters': waters,
        'ambiguous': all_ambiguous,
        'unbound': all_unbound,
        'unparsed_restrictions': all_unparsed,
        'report': report,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', default='registry', help='folder holding lake_index.json')
    ap.add_argument('--from-raw', action='store_true',
                    help='parse %s instead of fetching. No network.' % RAW_NAME)
    ap.add_argument('--dry-run', action='store_true', help='print the summary, write nothing')
    a = ap.parse_args()

    R = a.registry
    raw_path = os.path.join(R, RAW_NAME)
    if a.from_raw:
        if not os.path.exists(raw_path):
            raise SystemExit('%s not found -- run once without --from-raw first' % raw_path)
        raw = json.load(open(raw_path, encoding='utf-8'))
        print('read %s' % raw_path)
    else:
        raw = {}
        for lid, kind in LAYERS.items():
            feats = fetch_layer(lid, want_geometry=(lid != 0))
            raw[str(lid)] = feats
            print('layer %d (%s): %d features' % (lid, kind, len(feats)))
        # ALWAYS, and before anything is parsed. The parser can be tightened against these
        # bytes; a paraphrase of them is what it had to be written from.
        with open(raw_path, 'w', encoding='utf-8') as fh:
            json.dump(raw, fh, indent=1)
        print('raw -> %s' % raw_path)

    index = json.load(open(os.path.join(R, 'lake_index.json'), encoding='utf-8'))
    index = {k: v for k, v in index.items() if isinstance(v, dict)}
    out = build(raw, index, os.path.join(R, 'boundaries'))

    w = out['waters']
    print('\nbound to %d of our SC waters (%d SC waters have a boundary)'
          % (len(w), out['report'].get('sc_waters_with_a_boundary', 0)))
    for slug in sorted(w):
        names = [s['species'] for s in w[slug]['species']]
        print('   %-30s %-42s %s' % (slug, w[slug]['display_name'][:40], ', '.join(names) or '(no species parsed)'))
    if out['ambiguous']:
        print('\nDROPPED as ambiguous (%d) -- more than one of our waters fits:' % len(out['ambiguous']))
        for x in out['ambiguous']:
            print('   %-34s -> %s' % (x['name'], ', '.join(x['candidates'])))
    if out['unbound']:
        print('\nnot bound (%d):' % len(out['unbound']))
        for x in out['unbound'][:20]:
            print('   %-34s %s' % (x['name'], x['why']))
        if len(out['unbound']) > 20:
            print('   ... and %d more' % (len(out['unbound']) - 20))
    if out['unparsed_restrictions']:
        print('\n!! RESTRICTION TEXT THE PARSER COULD NOT READ (%d water(s)). This is the thing '
              'to look at first:' % len(out['unparsed_restrictions']))
        for x in out['unparsed_restrictions'][:10]:
            print('   %-28s %s' % (x['slug'], ' | '.join(x['text'])[:160]))

    if a.dry_run:
        print('\n--dry-run: nothing written')
        return 0
    p = os.path.join(R, OUT_NAME)
    with open(p, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, indent=1)
    print('\n-> %s' % p)
    return 0


if __name__ == '__main__':
    sys.exit(main())
