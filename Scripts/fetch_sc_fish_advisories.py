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
REVIEW_NAME = '_sc_fish_advisories_review.json'
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


NOT_A_SPECIES = re.compile(r'^\s*(all\s+|any\s+|other\b|every\b)', re.I)
SIZE_NOTE = re.compile(
    r'\s+((?:less\s+than|under|over|greater\s+than|above|below)\s+[\d.]+\s*(?:in|inch|inches)\b'
    r'|[\d.]+\s*[-\u2013]\s*[\d.]+\s*(?:in|inch|inches)\b)', re.I)


def load_roster(registry):
    """The species names we already publish, as a normalised set. READ, NOT TYPED.

    registry/species_traits.json is 56 species, is already in R2, and is already the vocabulary
    build_species_habitat_weights.py resolves against. Using it here means the check below is
    calibrated against the same roster as everything else rather than a fourth private list.
    """
    p = os.path.join(registry, 'species_traits.json')
    if not os.path.exists(p):
        return set()
    d = json.load(open(p, encoding='utf-8')).get('species') or {}
    names = list(d) if isinstance(d, dict) else [x.get('species') for x in d]
    out = set()
    for n in names:
        for alt in _alternates(n):
            k = _norm(alt)
            if len(k) > 3:
                out.add(k)
    return out


def _norm(s):
    return re.sub(r'[^a-z]', '', str(s or '').lower())


def _alternates(name):
    """'Redear Sunfish (Shellcracker)' -> both halves.

    THE SLASH IS DELIBERATELY NOT SPLIT HERE, unlike species_alternates() elsewhere. The roster
    contains 'White Bass / Hybrid'; splitting it puts a bare 'Hybrid' into the known-species set,
    and the qualifier rule below then "recognised" it -- so `Bass- Striped/Hybrid` on Hartwell
    came out as the species "Striped Bass, Hybrid". A fragment of a name is not a name.
    """
    n = str(name or '')
    out = [n] + re.findall(r'\(([^)]*)\)', n) + [re.sub(r'\s*\([^)]*\)', '', n)]
    return [p.strip() for p in out if p.strip()]


def species_names(published, roster=None):
    """One published heading -> the fish it names. 'Bass- Striped/Hybrid' is TWO.

    SC writes a slash where a row covers two fish that share a limit. Left joined it produced
    "Striped/Hybrid Bass" on Hartwell -- readable to a person, and not a name anything can match.
    """
    s = str(published or '').strip()
    m = re.match(r"^\s*([A-Za-z][A-Za-z' ]*?)\s*-\s*(.+?)\s*$", s)
    if m and '/' in m.group(2):
        group = m.group(1).strip()
        return [uninvert('%s- %s' % (group, q.strip()), roster)
                for q in m.group(2).split('/') if q.strip()]
    return [uninvert(s, roster)]


def uninvert(name, roster=None):
    """'Bass- Largemouth' -> 'Largemouth Bass'. 'Sunfish- Redear' -> 'Redear Sunfish'.

    The advisory writes a group first and the qualifier after a hyphen, which is how a table is
    sorted and not how a fish is called. Everything else is left exactly as published -- a
    parenthetical like 'Bowfin (Mudfish)' is the shape species_alternates() already expands.
    """
    s = str(name or '').strip().strip(',;')
    m = re.match(r"^\s*([A-Za-z][A-Za-z' ]*?)\s*-\s*([A-Za-z][A-Za-z'/ ]*)\s*$", s)
    if not m:
        return s
    group, qualifier = m.group(1).strip(), m.group(2).strip()
    joined = '%s %s' % (qualifier, group)
    # A BOWFIN IS NOT A BASS, AND THE STATE FILED IT UNDER ONE. 'Lake Wateree' publishes
    # `Bass- Bowfin`, which inverts to "Bowfin Bass" -- a fish that does not exist, and it went
    # into the first run's output as one. When the inverted form is not on our roster and the
    # QUALIFIER ALONE is, the qualifier is the fish and the group heading was filing.
    if roster and _norm(joined) not in roster and _norm(qualifier) in roster:
        return qualifier
    return joined


# ── the two rows where the heading and the fish disagree, both settled ──────────────────────
#
# group_mismatch() finds them; this says what was found out about each. Keyed on (NAME,
# published string) so a correction can only ever fire on the exact row it was checked against
# -- if SC edits either, the correction stops matching and the run says so instead of quietly
# rewriting something nobody looked at.
PUBLISHED_CORRECTIONS = {
    ('Lake Wateree', 'Bass- Bowfin'): {
        'species': 'White Bass',
        'checked': '2026-09-03',
        'why': 'The map layer is wrong on this row and TWO other DES products agree against it. '
               'The live per-water page (des.sc.gov .../lake-wateree-fish-consumption-advisory) '
               'lists Black Crappie one meal per week and Blue Catfish, Channel Catfish, '
               'Largemouth Bass, Striped Bass and WHITE BASS one meal per month -- no bowfin at '
               'all. SC\'s 2020 statewide table says the same six. The service says '
               '`Bass- Bowfin` where both say White Bass, and no reading of that string reaches '
               'the right answer: the heading says Bass, the qualifier says Bowfin, the fish is '
               'White Bass. So it is corrected here, with its evidence, rather than guessed at '
               'in code.',
    },
    ('Sampit River', 'Sunfish- Pumpkinseed'): {
        'species': 'Pumpkinseed',
        'checked': '2026-09-03',
        'why': 'Not an error -- a pumpkinseed IS a sunfish, so the heading and the qualifier '
               'agree after all and the plain reading is right. Recorded so that the ONLY rows '
               'left unexplained are new ones.',
    },
}


def correction_for(water_name, published):
    return PUBLISHED_CORRECTIONS.get((str(water_name or '').strip(), str(published or '').strip()))


def group_mismatch(published, roster):
    """True when the qualifier is a known fish that the group heading does not describe.

    IT FIRES TWICE IN THE WHOLE DATASET, and only one of the two is an anomaly:

        Lake Wateree   'Bass- Bowfin'          a bowfin is not a bass
        Sampit River   'Sunfish- Pumpkinseed'  a pumpkinseed IS a sunfish

    Which is why this MARKS the row instead of correcting it. SC's own 2020 statewide table
    (Web_Fish_Consumption_Advisory_Table.xlsx, 2020-04-25) lists Lake Wateree as Blue Catfish,
    Channel Catfish, Largemouth Bass, Striped Bass, WHITE Bass and Black Crappie -- White Bass
    sits exactly where the live service says Bowfin, and five of the six agree. Either the list
    changed in six years or somebody picked the wrong entry. Nothing here can tell which, and a
    script that silently asserts one is the failure this whole file exists to avoid.
    """
    m = re.match(r"^\s*([A-Za-z][A-Za-z' ]*?)\s*-\s*([A-Za-z][A-Za-z'/ ]*)\s*$",
                 str(published or '').strip())
    if not m or not roster:
        return False
    group, qualifier = m.group(1).strip(), m.group(2).strip()
    joined = '%s %s' % (qualifier, group)
    return _norm(joined) not in roster and _norm(qualifier) in roster


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


def parse_restrictions(text, roster=None, water_name=None):
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
            # SET BEFORE ANY BRANCH BELOW. It used to be set at the bottom, and the correction
            # branch `continue`s -- so a corrected row never advanced the marker and everything
            # after it in the string was reported as leftover the parser could not read.
            seen_end = m.end()
            if not sp:
                continue
            if not ad and ADVICE.fullmatch(sp):
                notes.append(sp)          # a whole-water statement, not a fish
            elif ad and NOT_A_SPECIES.match(sp):
                # 'All Other Fish', 'All Species of Fish'. A scope, not a fish. The first run
                # put both into species lists, on Hartwell and Langley Pond.
                notes.append('%s: %s' % (sp, ad))
            elif ad:
                size = None
                m2 = SIZE_NOTE.search(sp)
                base = sp
                if m2:
                    size = m2.group(1).strip()
                    base = (sp[:m2.start()] + sp[m2.end():]).strip()
                fix = correction_for(water_name, base)
                if fix:
                    pairs.append({'species': fix['species'], 'advice': ad, 'published_as': sp,
                                  'corrected': fix['why'], 'checked': fix['checked']})
                    continue
                suspect = group_mismatch(base, roster)
                for nm in species_names(base, roster):
                    rec = {'species': nm, 'advice': ad, 'published_as': sp}
                    if size:
                        rec['size'] = size
                    if suspect:
                        rec['suspect'] = ('the group heading and the fish disagree and nobody '
                                          'has checked this row -- read as %r, published as %r'
                                          % (nm, sp))
                    pairs.append(rec)
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
                    pairs.append({'species': uninvert(sp, roster), 'advice': ad, 'published_as': sp})
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
            pairs.append({'species': uninvert(sp, roster), 'advice': ad, 'published_as': sp})
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

    # NO STATE PRE-FILTER, AND THE FIRST RUN SHOWED WHY. It read `state == 'SC'` and threw away
    # Lake Wylie (state NC, half of it in SC) and J. Strom Thurmond (state GA, half of it in SC),
    # both of which SC publishes an advisory for. `states` is null on those rows, so the index
    # cannot answer "is any of this water in SC" -- but the geometry can, and does: every polygon
    # in this service is South Carolina's, so overlapping one IS the state test. The pre-filter
    # was a second, worse copy of a rule the geometry already enforces.
    slugs, geoms = [], []
    for slug, rec in index.items():
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
                         'overlap_frac_of_ours': (inter / g.area) if g.area else 0.0,
                         'advisory_inside_ours': (inter / apoly.area) if apoly.area else 0.0})
        if not hits:
            unbound.append({'name': aname, 'why': 'no water both overlaps it and shares a '
                                                  'distinctive name token'})
            continue
        picks, why = choose(aname, hits, index)
        if not picks:
            ambiguous.append({'name': aname, 'candidates': [h['slug'] for h in hits],
                              'why': why})
            continue
        for pk in picks:
            bound.setdefault(pk['slug'], []).append(
                {'match': dict(pk, resolved_by=why), 'attributes': attrs})
    return bound, ambiguous, unbound


def choose(advisory_name, hits, index):
    """The waters this advisory is about. A LIST -- one advisory can cover several.

    RYAN, LOOKING AT THE MAP: "the map shows where the polygons are... i can clearly see that
    the saluda river is both stretches... from greenwood to murray and then murray to the
    confluence with the broad and down into lake marion as the congaree."

    He is right and the first version was not. It picked ONE water and called everything else
    ambiguous, so a reach that genuinely spans two of our slugs was reported as a thing nobody
    could place. The polygon already says which waters it covers; that is what the map draws.

    IT ALSO SORTED ON THE WRONG NUMBER. `overlap_frac_of_ours` is how much of OUR water the
    advisory covers, and it is near useless here: 23 of 60 unambiguous matches sit under 1%,
    because our river boundaries are long and an advisory polygon is a buffer along part of one.
    What discriminates is `advisory_inside_ours` -- how much of the ADVISORY lands in our water.
    Measured over every candidate pair: the real ones run 5.5% to 96.2% and the incidental ones
    are 0.0%. The floor below is inside that gap rather than picked out of the air.

      1. GEOMETRY GATES.   A candidate the advisory barely touches is not a candidate.
                           great_pee_dee_river shares `pee` and `dee` with "Little Pee Dee
                           River" and 0.0% of the polygon; wateree_lake likewise for
                           "Wateree River".
      2. THE BETTER NAME WINS OUTRIGHT. "Black Mingo Creek" shares two tokens with
                           black_mingo_creek and one with black_river, whose boundary happens to
                           contain 85% of the creek's advisory. Containment is not identity.
      3. A MORE SPECIFIC NAME IS A DIFFERENT WATER. Tied on tokens, a water carrying a
                           distinctive word the advisory does not say is not the water named:
                           "Broad River" is not the First Broad. County parentheticals are
                           stripped first -- they are our stamp, not the water's.
      4. WHAT SURVIVES, ALL OF IT.  Three Saluda reaches, and the advisory is about all three.
    """
    FLOOR = 0.01
    real = [h for h in hits if h['advisory_inside_ours'] >= FLOOR]
    if not real:
        return [], 'the advisory barely touches any of them'

    best = max(len(h['tokens']) for h in real)
    top = [h for h in real if len(h['tokens']) == best]
    if len(top) == 1:
        return top, 'most shared tokens'

    bare = _norm(re.sub(r'\s*\([^)]*\)', '', advisory_name))
    want = set(re.findall(r"[a-z']+", re.sub(r'\s*\([^)]*\)', '', advisory_name).lower()))
    exact = [h for h in top
             if _norm(re.sub(r'\s*\([^)]*\)', '', index[h['slug']].get('display_name') or '')) == bare]
    if len(exact) == 1:
        return exact, 'the name matches exactly'

    def extra(h):
        ours = re.sub(r'\s*\([^)]*\)', '', index[h['slug']].get('display_name') or '').lower()
        return {w for w in re.findall(r"[a-z']+", ours)
                if len(w) > 2 and w not in GENERIC and w not in want}
    plain = [h for h in top if not extra(h)]
    if plain and len(plain) < len(top):
        return plain, 'the others name a more specific water'
    return top, ('every one of these is covered by the advisory'
                 if len(top) > 1 else 'the only candidate the advisory covers')


# ── main ────────────────────────────────────────────────────────────────────────────────────

def build(raw, index, bounds_dir, registry='registry'):
    report = {}
    roster = load_roster(registry)
    report['roster_species_known'] = len(roster)
    waters, all_ambiguous, all_unbound, all_unparsed = {}, [], [], []
    fired = set()
    review = {'restrictions': []}
    for layer_id, kind in (('2', 'freshwater'), ('3', 'estuarine')):
        feats = raw.get(layer_id) or []
        report['layer_%s_features' % layer_id] = len(feats)
        bound, ambiguous, unbound = bind(feats, index, bounds_dir, report)
        all_ambiguous += [dict(a, layer=kind) for a in ambiguous]
        all_unbound += [dict(u, layer=kind) for u in unbound]
        # A WATER CAN HAVE MORE THAN ONE ADVISORY AND THE FIRST RUN KEPT ONLY THE LAST.
        # `bound[slug] = ...` overwrote, so Hartwell -- which SC publishes in five pieces, GA
        # arm, Seneca River arm twice, 12 Mile Creek and All Remaining -- came out carrying
        # whichever row happened to be last, and about twenty waters printed "(no species
        # parsed)" for the same reason. They are a list now.
        for slug, hits in bound.items():
            for hit in hits:
                a = hit['attributes']
                pairs, unparsed, notes = parse_restrictions(a.get('Waterbody_URL'), roster,
                                                            a.get('NAME'))
                for sp in pairs:
                    if sp.get('corrected'):
                        fired.add((str(a.get('NAME') or '').strip(), sp['published_as']))
                if unparsed:
                    all_unparsed.append({'slug': slug, 'name': a.get('NAME'), 'text': unparsed})
                rec = waters.setdefault(slug, {
                    'display_name': index[slug].get('display_name') or slug,
                    'state': index[slug].get('state'), 'water_type': kind,
                    'advisories': [], 'species': [], 'do_not_eat': [], 'water_level_notes': [],
                    'basis': 'PRESENCE FLOOR, not a roster. An advisory names a species because '
                             'the state sampled it here; it says nothing about what else is '
                             'present, and it must union in underneath a roster rather than '
                             'replace one.',
                })
                for n in notes:
                    if n not in rec['water_level_notes']:
                        rec['water_level_notes'].append(n)
                rec['advisories'].append({
                    'name': a.get('NAME'), 'advisory': a.get('ADVISORY'), 'basin': a.get('Basin'),
                    'type': a.get('TYPE'),
                    'confidence': 'name+geom',
                    'source': '%s/%s' % (SERVICE, layer_id),
                })
                review.setdefault('matches', []).append(
                    {'slug': slug, 'name': a.get('NAME'), 'matched_on': hit['match']})
                # The published file is the one the APP reads, so the state's raw HTML does not
                # travel in it -- it is 100 KB of markup the browser has no use for, and the
                # uploader copies this file through untouched. It goes to the review file with
                # the rest of the material a person needs and the app does not.
                review['restrictions'].append({'slug': slug, 'name': a.get('NAME'),
                                               'text': a.get('Waterbody_URL')})
                for sp in pairs:
                    if sp['species'] not in [s['species'] for s in rec['species']]:
                        rec['species'].append(sp)
                    if do_not_eat(sp['advice']) and sp['species'] not in rec['do_not_eat']:
                        rec['do_not_eat'].append(sp['species'])

    published = {
        '_note': 'Personal use only, not for distribution or resale; not for navigation. '
                 'SC fish consumption advisories as a SPECIES PRESENCE FLOOR and as safety text. '
                 'Built by fetch_sc_fish_advisories.py from the SCDHEC Watershed Atlas. '
                 'A species here is present because the state sampled it; the list is a FLOOR '
                 'and says nothing about what else is in the water.',
        # THE LABEL, NOT THE ENDPOINT. The plan prints this sentence under the advisory table
        # and a bare service URL is not a sentence. It matters now that Georgia publishes one
        # too: six waters we ship are in both books, so the plan names its sources from the
        # files rather than from a line of typed text that said South Carolina on all of them.
        'source': 'SC DES fish consumption advisories (SCDHEC Watershed Atlas)',
        'source_service': SERVICE,
        'confidence': 'name+geom -- the advisory polygon overlaps our boundary AND shares a '
                      'distinctive name token, and an advisory covering several of our waters '
                      'binds to all of them.',
        'waters': waters,
        'report': report,
    }
    review.update({
        'ambiguous': all_ambiguous,
        'unbound': all_unbound,
        'unparsed_restrictions': all_unparsed,
        'corrections_unused': sorted('%s / %s' % k
                                     for k in set(PUBLISHED_CORRECTIONS) - fired),
    })
    return published, review


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
    out, review = build(raw, index, os.path.join(R, 'boundaries'), R)

    w = out['waters']
    print('\nbound to %d of our waters (%d have a boundary, roster knows %d species)'
          % (len(w), out['report'].get('waters_with_a_boundary', 0),
             out['report'].get('roster_species_known', 0)))
    clean = 0
    for slug in sorted(w):
        rec = w[slug]
        names = [s['species'] for s in rec['species']]
        if names:
            said = ', '.join(names)
        elif rec.get('water_level_notes'):
            # NOT A FAILURE, AND THE FIRST RUN READ LIKE ONE. These waters carry
            # `ADVISORY: No Advisory` and `<strong>No Restrictions</strong>`: the state sampled
            # them and found nothing to warn about, so there is no species list to take. Sixteen
            # of them printed "(no species parsed)" and Ryan read that as the parser breaking.
            said = 'NO ADVISORY - the state names no species here (%s)' % '; '.join(
                rec['water_level_notes'][:2])
            clean += 1
        else:
            said = '(nothing parsed - LOOK AT THIS ONE)'
        print('   %-30s %-42s %s' % (slug, rec['display_name'][:40], said))
    print('\n   %d of the %d carry species; %d are waters the state cleared'
          % (len(w) - clean, len(w), clean))
    fixed = [(s, x) for s in sorted(w) for x in w[s]['species'] if x.get('corrected')]
    if fixed:
        print('\n   corrections applied (see PUBLISHED_CORRECTIONS):')
        for s, x in fixed:
            print('      %-24s %-24r -> %r' % (s, x['published_as'], x['species']))
    if review['corrections_unused']:
        # A CORRECTION THAT STOPS FIRING IS THE SOURCE CHANGING UNDER IT. Better to be told
        # than to keep a rewrite nobody has looked at since it was written.
        print('\n!! %d correction(s) matched NOTHING this run -- re-check or remove:'
              % len(review['corrections_unused']))
        for k in review['corrections_unused']:
            print('      %s' % k)

    sus = [(s, x) for s in sorted(w) for x in w[s]['species'] if x.get('suspect')]
    if sus:
        print('\n!! %d row(s) where the group heading and the fish disagree. Read, not '
              'corrected:' % len(sus))
        for s, x in sus:
            print('   %-26s published %-24r read as %r'
                  % (s, x['published_as'], x['species']))
    if review['ambiguous']:
        print('\nDROPPED as ambiguous (%d) -- more than one of our waters fits:' % len(review['ambiguous']))
        for x in review['ambiguous']:
            print('   %-34s -> %s' % (x['name'], ', '.join(x['candidates'])))
    if review['unbound']:
        print('\nnot bound (%d):' % len(review['unbound']))
        for x in review['unbound'][:20]:
            print('   %-34s %s' % (x['name'], x['why']))
        if len(review['unbound']) > 20:
            print('   ... and %d more' % (len(review['unbound']) - 20))
    if review['unparsed_restrictions']:
        print('\n!! RESTRICTION TEXT THE PARSER COULD NOT READ (%d water(s)). This is the thing '
              'to look at first:' % len(review['unparsed_restrictions']))
        for x in review['unparsed_restrictions'][:10]:
            print('   %-28s %s' % (x['slug'], ' | '.join(x['text'])[:160]))

    if a.dry_run:
        print('\n--dry-run: nothing written')
        return 0
    p = os.path.join(R, OUT_NAME)
    with open(p, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, indent=1)
    rp = os.path.join(R, REVIEW_NAME)
    with open(rp, 'w', encoding='utf-8') as fh:
        json.dump(review, fh, indent=1)
    print('\n-> %s   (%.0f KB, published)' % (p, os.path.getsize(p) / 1024))
    print('-> %s   (%.0f KB, review only -- the underscore keeps it out of R2)'
          % (rp, os.path.getsize(rp) / 1024))
    return 0


if __name__ == '__main__':
    sys.exit(main())
