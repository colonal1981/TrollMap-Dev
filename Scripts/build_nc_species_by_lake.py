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
import argparse, glob, io, json, math, os, re, sys, time
import urllib.request

AREAS_URL = 'https://www.ncpaws.org/NCWRCMaps/FishingAreas/Home/GetFilteredFishingAreas'
INFO_URL = 'https://www.ncpaws.org/NCWRCMaps/FishingAreas/Home/GetFishingAreaInfo?locationID=%d'
UA = 'TrollMap/1.0 (personal use; contact via github.com/colonal1981)'

GENERIC = re.compile(r'\b(lake|reservoir|pond|impoundment|res)\b', re.I)
COUNTY_PAREN = re.compile(r'\s*\([^)]*\bCo\b[^)]*\)\s*', re.I)
STATE_SUFFIX = re.compile(r',\s*(SC|NC|GA|TN)(/(?:SC|NC|GA|TN))*\s*$', re.I)


# NC WRC'S WARMWATER STOCKING PLAN -- the numbers, which the fishing-areas API does not carry.
#
# ncpaws.org answers `stocked: true|false` per species per location. That is a BOOLEAN, and it is
# already read below. The agency also publishes the plan itself as two spreadsheets, and those
# carry what the boolean cannot: 37,500 bodie bass into Hyco Lake at 1-2 inches; 120,000 into
# Jordan; 64,000 striped bass into Badin.
#
#   WarmwaterStocking*.csv   per water: District, County, Lake or Stream, SP, Size, Number
#   WarmwaterSummary*.csv    per species and size: the district totals
#
# THE SPECIES CODES ARE DERIVED, NOT TYPED. The detail file writes `BB`, `WY`, `MK` and prints no
# legend. Summing the detail by (code, size) and matching each total against the summary's
# (species, size) resolves all twelve buckets to exactly one species each, with nothing left over
# on either side -- which also proves the extraction, because every per-water number adds up to
# the agency's own district totals. A bucket that does not match one species is REPORTED and its
# rows are dropped; a hand-typed legend would have silently mislabelled the year they add a fish.
STOCKING_GLOB = 'WarmwaterStocking*.csv'
SUMMARY_GLOB = 'WarmwaterSummary*.csv'
STOCK_YEAR = re.compile(r'(20\d\d)')


def _count(v):
    """`"37,500"` -> 37500. The files quote their thousands separators."""
    d = re.sub(r'[^\d]', '', str(v or ''))
    return int(d) if d else 0


def _csv_rows(path):
    """cp1252, because the detail file carries a Windows right single quote in a directions cell."""
    import csv
    with io.open(path, encoding='cp1252', newline='') as f:
        return [r for r in csv.DictReader(f)]


def stocking_legend(detail, summary):
    """{code: species}, and the codes it could not settle."""
    per_code = {}
    for r in detail:
        k = ((r.get('SP') or '').strip(), (r.get('SIZE') or '').strip())
        per_code[k] = per_code.get(k, 0) + _count(r.get('NUMBER'))
    per_species = {}
    for r in summary:
        sp = (r.get('Species') or '').strip()
        if not sp or 'TOTAL' in sp.upper():
            continue
        per_species[(sp, (r.get('Size') or '').strip())] = _count(r.get('Total Number'))
    legend, unsettled = {}, []
    for (code, size), total in sorted(per_code.items()):
        hits = sorted({sp for (sp, sz), t in per_species.items() if sz == size and t == total})
        if len(hits) == 1 and code not in legend:
            legend[code] = hits[0]
        elif len(hits) != 1:
            unsettled.append('%s at %s totals %d -- %d species in the summary match that'
                             % (code or '(blank)', size or '(no size)', total, len(hits)))
    return legend, unsettled


def read_stocking_plan(root):
    """[{name, county, species, size, number, year}], the legend, and what it could not settle."""
    det = sorted(glob.glob(os.path.join(root, STOCKING_GLOB)))
    summ = sorted(glob.glob(os.path.join(root, SUMMARY_GLOB)))
    if not det or not summ:
        return [], {}, ['no %s / %s beside %s' % (STOCKING_GLOB, SUMMARY_GLOB, root)], None
    detail = [r for r in _csv_rows(det[-1])
              if (r.get('LAKE OR STREAM') or '').strip() not in ('', '(none)')]
    legend, unsettled = stocking_legend(detail, _csv_rows(summ[-1]))
    year = (STOCK_YEAR.search(os.path.basename(det[-1])) or [None, None])[1]
    out = []
    for r in detail:
        code = (r.get('SP') or '').strip()
        if code not in legend:
            continue
        n = _count(r.get('NUMBER'))
        if not n:
            continue
        name = re.sub(r'\s*\([^)]*\)', '',
                      re.sub(r'\s+', ' ', (r.get('LAKE OR STREAM') or '').strip()).title()).strip()
        out.append({'name': name, 'county': (r.get('COUNTY') or '').strip(),
                    'species': legend[code], 'size': (r.get('SIZE') or '').strip(),
                    'number': n, 'year': year})
    return out, legend, unsettled, os.path.basename(det[-1])


def bind_stocking(name, by_name, by_bare):
    """The slug, only when exactly one NC water answers to the name.

    `by_name` and `by_bare` are built from the NC rows ONLY, and that is doing real work here:
    the registry files `Lake Louise` as a name Hartwell Lake answers to, and the CSV's Lake Louise
    is in Buncombe County. A resolver that reaches every state accepts it "across the state line"
    and writes an NC stocking onto a South Carolina reservoir. NCWRC cannot stock a water North
    Carolina does not hold, so the NC-only map is the correct map to ask.
    """
    for m, key in ((by_name, norm), (by_bare, norm_bare)):
        for cand in (name, 'Lake %s' % name, '%s Lake' % name):
            got = m.get(key(cand)) or set()
            if len(got) == 1:
                return sorted(got)[0]
    return None


# THE FISHING-AREAS API SAYS "SPOTTED BASS" AND NC WRC SAYS THAT IS THE WRONG FISH.
#
# The API answers `commonName` per location and never once says Alabama Bass -- 52 locations say
# Spotted Bass. NC WRC's own Alabama Bass page says why, and the sentence is the rule:
#
#   "Alabama Bass are referred to by most anglers as Spotted Bass... True Spotted Bass are native
#    to the mountain drainages of southwestern North Carolina and have been introduced into the
#    Cape Fear River basin, W. Kerr Scott Reservoir, and the Yadkin River above High Rock Lake.
#    EVERYPLACE ELSE IN THE STATE, ANY FISH ANGLERS HAVE BEEN CATCHING THAT LOOKS LIKE A SPOTTED
#    BASS IS ACTUALLY AN ALABAMA BASS."
#
# So this is not a gap in the roster, it is a WRONG NAME in it -- and it started to matter on
# 2026-09-02, when the plan form began filtering to the roster: Lake Norman offers a Spotted box,
# no Alabama box, and the fisheries prompt gets the wrong fish's account. They are not the same
# fish. TWRA: the Alabama bass "has a growth advantage over our native spotted bass and commonly
# obtains weights over 4.5 pounds."
#
# THE RULE IS READ, NOT RETYPED. alabama_rule() lifts the sentence off the saved page and parses
# the three introduced exceptions out of it; if the page stops saying it, nothing is corrected and
# the run says so. The southwestern mountain drainages are the impacts document's OWN basin
# sections -- it files its waters under "Little Tennessee River basin" and "Hiwassee River basin",
# the two Tennessee drainages in the far southwest, and under Catawba, Yadkin, Broad and Roanoke
# for everywhere else.
#
# A CORRECTION NEEDS BOTH DOCUMENTS. The page says a water is not true-spotted country; the
# impacts document has to independently name the water as holding Alabama Bass. Anything with only
# one of the two keeps what the API said and is printed.
ALB_PAGE = '_page_fishing-black-bass-north-carolina-alabama-bass.html'
ALB_DOC = '2974_alabama-bass-impacts-*.pdf'
ALB_SW_BASINS = ('Little Tennessee', 'Hiwassee')
ALB_RULE = re.compile(r'True Spotted Bass are native to (.{10,120}?) and have been introduced into '
                      r'(.{10,200}?)\.\s*Everyplace else in the state', re.I | re.S)
ALB_BASIN = re.compile(r'([A-Z][A-Za-z]+(?: [A-Z][a-z]+)?) River basin')
ALB_WATER = re.compile(r'((?:Lakes?|Reservoirs?)?\s*[A-Z][A-Za-z.]+(?:[ ]+(?:and[ ]+)?[A-Z][A-Za-z.]+){0,3}'
                       r'(?:[ ]+lakes)?)\s+[–—-]\s')
ALB_TAGS = re.compile(r'<[^>]+>')


def alabama_rule(nc_dir):
    """NC WRC's sentence off the saved page. -> (native_clause, [introduced phrases]) or None."""
    fp = os.path.join(nc_dir, ALB_PAGE)
    if not os.path.exists(fp):
        return None
    import html as _h
    t = re.sub(r'\s+', ' ', _h.unescape(ALB_TAGS.sub(' ', io.open(fp, encoding='utf-8',
                                                                  errors='replace').read())))
    m = ALB_RULE.search(t)
    if not m:
        return None
    parts = [x.strip(' .') for x in re.split(r',\s*and\s+|,\s*|\s+and\s+', m.group(2)) if x.strip()]
    return m.group(1).strip(), [re.sub(r'^the\s+', '', x, flags=re.I) for x in parts]


def alabama_waters(nc_dir):
    """{water phrase: (basin, sentence)} out of the impacts document's own basin sections."""
    import glob as _g
    hits = sorted(_g.glob(os.path.join(nc_dir, ALB_DOC)))
    if not hits:
        return {}
    try:
        import pdfplumber
    except ImportError:
        return {}
    with pdfplumber.open(hits[0]) as pdf:
        t = ' '.join((pg.extract_text() or '') for pg in pdf.pages)
    t = re.sub(r'\s+', ' ', t).replace('- ', '')
    marks = [(m.start(), m.group(1)) for m in ALB_BASIN.finditer(t)]
    out = {}
    for m in ALB_WATER.finditer(t):
        # The pattern can start mid-sentence -- "...Alabama Bass. Dan River -" -- so anything up
        # to the last full stop belongs to the sentence before, not to the water's name.
        head = re.sub(r'\s+', ' ', m.group(1)).strip()
        # A LOWERCASE LETTER BEFORE THE STOP, or the split eats an initial: "W. Kerr Scott
        # Reservoir" became " Kerr Scott Reservoir" and stopped matching the registry's
        # "W Kerr Scott Reservoir" -- the one water in the document that is also one of the three
        # true-Spotted-Bass exceptions, so losing it lost the most interesting row in the file.
        head = re.split(r'(?<=[a-z])\.\s+', head)[-1].strip()
        basin = ([b for pos, b in marks if pos < m.start()] or ['?'])[-1]
        say = t[m.end():m.end() + 900]
        if 'Alabama Bass' not in say and 'ALB' not in say:
            continue
        plural = head.lower().endswith(' lakes')
        head = re.sub(r'\s+lakes$', '', head, flags=re.I)
        lead = 'Lake ' if head.lower().startswith('lakes ') else ''
        head = re.sub(r'^lakes\s+', '', head, flags=re.I)
        for part in [x.strip() for x in head.split(' and ') if x.strip()]:
            name = (lead + part) if lead else part
            if plural and not re.search(r'lake|reservoir|river', name, re.I):
                name += ' Lake'
            out.setdefault(name, (basin, say.strip()))
    return out


def alabama_exception(display, introduced):
    """Is this water one NC WRC names as holding TRUE Spotted Bass?"""
    d = norm(display)
    for phrase in introduced:
        core = re.split(r'\s+above\s+', phrase, flags=re.I)[0]
        core = norm(re.sub(r'\s+basin$', '', core, flags=re.I))
        if core and (core in d or d in core):
            return phrase
    return None


def apply_alabama(lakes, by_name, by_bare, nc_dir, idx):
    """Correct the roster against NC WRC's own two documents. -> a printable report."""
    rule = alabama_rule(nc_dir)
    waters = alabama_waters(nc_dir)
    rep = {'rule': bool(rule), 'named': len(waters), 'added': [], 'corrected': [],
           'kept': [], 'unbound': []}
    if not rule or not waters:
        return rep
    _native, introduced = rule
    for name, (basin, say) in sorted(waters.items()):
        slug = bind_stocking(name, by_name, by_bare)
        if not slug:
            rep['unbound'].append(name)
            continue
        row = lakes.setdefault(slug, {'predatorSpecies': [], 'knownStockings': [], 'locations': []})
        sp = row['predatorSpecies']
        display = str((idx.get(slug) or {}).get('display_name') or name)
        why = alabama_exception(display, introduced) or (
            'the %s River basin, a southwestern mountain drainage' % basin
            if basin in ALB_SW_BASINS else None)
        if 'Alabama Bass' not in sp:
            sp.append('Alabama Bass')
            rep['added'].append((slug, name, basin))
        if 'Spotted Bass' in sp:
            if why:
                rep['kept'].append((slug, why))
            else:
                sp.remove('Spotted Bass')
                rep['corrected'].append((slug, basin, say[:150]))
        row['predatorSpecies'] = sorted(set(sp))
    # A water the API called Spotted Bass that the impacts document does NOT name keeps it, and is
    # printed: one document is not two, and this is the list to read next time the page updates.
    named = {bind_stocking(n, by_name, by_bare) for n in waters}
    for slug, row in lakes.items():
        if 'Spotted Bass' in (row.get('predatorSpecies') or []) and slug not in named:
            rep['kept'].append((slug, 'not named in the impacts document'))
    return rep


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


# A RAMP IS ON THE BANK, AND THE BOX IS DRAWN AROUND THE WATER.
#
# `bounds_wsen` comes from the 3DHP water polygon, so a boat ramp, its parking lot and the
# fishing pier beside it are OUTSIDE it by construction -- not by a little, but by exactly the
# width of the thing that lets you launch. Requiring the point to fall inside the unpadded box
# therefore refused locations whose waterbodyName is an exact match for the water they sit on:
# RANKIN LAKE PARK on Rankin Lake, CANE CREEK PARK on Cane Creek Lake, LAKE JUNALUSKA ASSEMBLY
# OFFICE on Lake Junaluska.
#
# THE NUMBER IS NOT A KNOB, BECAUSE WIDENING IT CANNOT BUY ANYTHING. Re-binding all 891
# locations at 0.005, 0.01, 0.02, 0.05 and 0.1 degrees never reaches a water 0.002 did not --
# and at 0.05 the count FALLS, because a location then lands inside two padded boxes whose names
# it both answers to and the name rule refuses it. So this is a fixed offset (the width of a
# ramp) and not a threshold somebody can loosen for more results: loosening it costs results.
# test_ncpaws_access.py asserts exactly that, since the claim is the whole justification.
#
# Measured 2026-09-02: 886 of 891 bindings identical, 5 changed, every one of them REFUSED -> a
# water whose name the location already stated, and no location moved between waters. 77 -> 81.
#
# THE NAME REQUIREMENT BELOW IS UNCHANGED. Padding widens the candidate set; it does not weaken
# the second signal. A location that lands in two padded boxes and matches neither name is still
# refused, which is why the flat curve is a safe curve.
BANK_PAD_DEG = 0.002


def bind(loc, idx, by_name, by_bare):
    """(slug, how) for one location, or (None, why).

    INSIDE THE BOX IS THE REQUIREMENT. The name only chooses between boxes.
    """
    lat, lon = loc.get('latitude'), loc.get('longitude')
    if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
        return None, 'no coordinate'
    boxes = [s for s in idx if in_box(idx[s], lat, lon, BANK_PAD_DEG)]
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


# ── THE OTHER TWENTY-THREE FIELDS ON THE SAME RESPONSE ─────────────────────────────────────
#
# GetFishingAreaInfo answers twenty-four fields per location and this script read exactly one of
# them -- `speciesInfo` -- for every run before 2026-09-02. Counted across the 345 cached
# responses, the ones it threw away include:
#
#     canoeAccess        233 true      boatRamp             176 true
#     wheelchairAccess   178 true      shorelineAccess      161 true
#     fishingPierAccess   71 true      waterbodyInfo.acres   48 populated
#
# `canoeAccess` is the one that matters here, because this is a kayak app and because NC is the
# state where paddle access is thinnest: `dnr_paddle_by_lake.json` carries 38 NC waters, built
# from NCWRC_Boating_Access_Areas_view's Non_Motorized_Access flag -- a DIFFERENT NCWRC layer,
# 137 points. Measured 2026-09-02 against that file: 162 canoeAccess points on waters we ship
# have no paddle site of ours within ~200 m, across 57 waters; 69 boatRamp points likewise have
# no ramp of ours. French Broad River alone is missing 18, the Yadkin 13, Jordan 10.
#
# This is the same fact, from the same agency, about the same launch, already fetched and already
# bound to a slug by the geometry above. Georgia's paddle filter is literally `CanoeAcc` on the
# WRD access points; North Carolina publishes `canoeAccess` and we were dropping it on the floor.
#
# WHY ITS OWN FILE AND NOT dnr_paddle_by_lake.json. Two writers on one file is how a narrowed run
# deletes what it did not read -- it has already cost this project registry/agency_lake_facts.json
# (83 waters -> 16) and nearly cost dnr_ramps_by_lake.json the same week. consolidate_lake_index.py
# already merges FIVE per-source buckets by filename, so a sixth is the established shape and a
# one-row change there, not a new concept.
#
# ONLY LAUNCHES GO IN. `ramp_sources` in the index counts non-empty buckets, so a bucket holding
# bank-and-pier-only sites would make a water with nowhere to put a kayak in read as having one
# more place to launch. A location earns a row here only if canoeAccess or boatRamp is true; the
# shore, pier and wheelchair flags ride along in `meta` on the rows that qualify.
ACCESS_OUT = 'ncpaws_access_by_lake.json'


def access_rows(hits, cache):
    """{slug: [ramp-bucket record]} for every bound location NC WRC says you can launch at."""
    out = {}
    for slug, locs in sorted(hits.items()):
        rows = []
        for l in sorted(locs, key=lambda x: str(x.get('locationName') or '')):
            info = cache.get(str(l['locationID'])) or {}
            canoe, ramp = bool(info.get('canoeAccess')), bool(info.get('boatRamp'))
            if not (canoe or ramp):
                continue
            lat, lon = info.get('latitude'), info.get('longitude')
            if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
                continue
            rows.append({
                'name': l.get('locationName'),
                'wb': l.get('waterbodyName'),
                # Both, when it is both -- a ramp you can also slide a kayak off is not two sites.
                'type': 'Boat Ramp / Paddle Launch' if (canoe and ramp)
                        else ('Boat Ramp' if ramp else 'Paddle Launch'),
                'src': 'NC WRC public fishing areas (ncpaws.org/NCWRCMaps/FishingAreas)',
                'lat': lat, 'lon': lon,
                'meta': {'canoe': canoe, 'ramp': ramp,
                         'shore': bool(info.get('shorelineAccess')),
                         'pier': bool(info.get('fishingPierAccess')),
                         'wheelchair': bool(info.get('wheelchairAccessible')),
                         'county': info.get('county'),
                         'owner': info.get('ownerName') or info.get('management'),
                         'locationID': l.get('locationID'),
                         'matchedBy': l.get('_how')},
            })
        if rows:
            out[slug] = rows
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--registry', default='registry')
    ap.add_argument('--areas', help='a saved GetFilteredFishingAreas response. Fetched live if omitted.')
    ap.add_argument('--out', help='default <registry>/nc_species_by_lake.json')
    ap.add_argument('--cache', help='default <registry>/_nc_species_cache.json')
    ap.add_argument('--sleep', type=float, default=0.4, help='seconds between location requests')
    ap.add_argument('--refresh', action='store_true', help='ignore the cache and refetch every location')
    ap.add_argument('--date', default=None, help='stamp written into the output; default today')
    ap.add_argument('--nc-pages', default=None,
                    help='the saved NC WRC pages and reports; default <stocking root>/NC_Lakes')
    ap.add_argument('--stocking-root', default=None,
                    help='where the WarmwaterStocking / WarmwaterSummary CSVs live; '
                         'default the parent of --registry')
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

    # THE STOCKING PLAN, bound to the same NC-only name maps the locations were bound with.
    plan, legend, unsettled, plan_file = read_stocking_plan(
        a.stocking_root or os.path.dirname(os.path.abspath(R)) or '.')
    by_slug, plan_missed = {}, []
    for row in plan:
        slug = bind_stocking(row['name'], by_name, by_bare)
        if slug:
            by_slug.setdefault(slug, []).append(row)
        else:
            plan_missed.append(row)
    if plan_file:
        print('stocking: %s -- %d row(s), %d code(s) derived (%s)'
              % (plan_file, len(plan), len(legend),
                 ', '.join('%s=%s' % kv for kv in sorted(legend.items()))))
        print('          %d row(s) onto %d water(s); %d name(s) are not waters we ship'
              % (sum(len(v) for v in by_slug.values()), len(by_slug), len(plan_missed)))
    for u in unsettled:
        print('       !! %s' % u)

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
        if wild or by_slug.get(slug):
            lakes[slug] = {'predatorSpecies': sorted(wild), 'knownStockings': sorted(stocked),
                           'locations': used}
    # STOCKING PLAN IS ITS OWN FIELD, NOT KNOWNSTOCKINGS.
    #
    # `knownStockings` here is NC WRC's own `stocked` boolean, per species, and
    # Worker/research/deterministic.js hands the whole list to uniqueResearchSpecies(), which
    # takes STRINGS. Writing `{species, number}` objects into it would reach
    # canonicalizeResearchSpecies() as an object and canonicalise to "Object Object". They are
    # also two different facts from two different documents: one says this water is stocked with
    # channel catfish, the other says 4,500 of them at 8-12 inches in 2026.
    for slug, rows_ in by_slug.items():
        lakes.setdefault(slug, {'predatorSpecies': [], 'knownStockings': [], 'locations': []})
        lakes[slug]['stockingPlan'] = [
            {'species': r['species'], 'size': r['size'], 'number': r['number'],
             'year': r['year'], 'agency': 'NCWRC'}
            for r in sorted(rows_, key=lambda x: (-x['number'], x['species']))]
    # THE API CALLS IT SPOTTED BASS AND NC WRC SAYS THAT IS THE WRONG FISH. See alabama_rule().
    nc_pages = a.nc_pages or os.path.join(
        a.stocking_root or os.path.dirname(os.path.abspath(R)) or '.', 'NC_Lakes')
    alb = apply_alabama(lakes, by_name, by_bare, nc_pages, idx)
    if not alb['rule']:
        print('alabama:  !! NC WRC\'s rule sentence is not on the saved page under %s -- nothing '
              'corrected. Run fetch_agency_lake_pages.py --state NC --go' % nc_pages)
    else:
        print('alabama:  %d water(s) named by the impacts document; %d gained Alabama Bass, '
              '%d had Spotted Bass corrected to it' % (alb['named'], len(alb['added']),
                                                       len(alb['corrected'])))
        for slug, basin, say in alb['corrected']:
            print('          %-24s [%s basin] %s' % (slug, basin, say[:96]))
        for slug, why in alb['kept']:
            print('          kept Spotted Bass on %-22s %s' % (slug, why))
        if alb['unbound']:
            print('          named but not a water we ship: %s' % ', '.join(alb['unbound']))

    body = {'generated': stamp,
            'source': 'NC WRC public fishing areas (ncpaws.org/NCWRCMaps/FishingAreas)',
            'note': 'commonName per location; `stocked` is NC WRC\'s own flag. `stockingPlan` is '
                    'the agency\'s published warmwater stocking spreadsheet -- species, size and '
                    'COUNT -- and its species codes are derived by joining the per-water file to '
                    'the district summary, not typed. Alabama Bass is added, and a Spotted Bass '
                    'record corrected to it, per NC WRC\'s own rule: "Everyplace else in the '
                    'state, any fish anglers have been catching that looks like a Spotted Bass is '
                    'actually an Alabama Bass." Built by build_nc_species_by_lake.py -- do not '
                    'hand-edit.',
            'lakes': lakes}
    json.dump(body, io.open(out_fp, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
    json.dump(refused, io.open(os.path.join(R, '_nc_species_unmatched.json'), 'w', encoding='utf-8'), indent=1)
    access = access_rows(hits, cache)
    access_fp = os.path.join(R, ACCESS_OUT)
    json.dump(access, io.open(access_fp, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
    _n_canoe = sum(1 for v in access.values() for r in v if r['meta']['canoe'])
    _n_ramp = sum(1 for v in access.values() for r in v if r['meta']['ramp'])
    print('-> %s   (%d launch(es) on %d water(s): %d canoe, %d ramp)'
          % (access_fp, sum(len(v) for v in access.values()), len(access), _n_canoe, _n_ramp))
    print('-> %s   (%d waters carry species, %d carry a stocking plan)'
          % (out_fp, sum(1 for v in lakes.values() if v['predatorSpecies']), len(by_slug)))
    if plan_missed:
        seen_ = sorted({r['name'] for r in plan_missed})
        print('   stocked by NC WRC, not a water we ship: %s%s'
              % (', '.join(seen_[:8]), ' ...' if len(seen_) > 8 else ''))
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
