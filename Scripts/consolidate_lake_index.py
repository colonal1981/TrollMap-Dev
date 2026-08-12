#!/usr/bin/env python3
"""consolidate_lake_index.py - fold every lake list in the app into ONE record per lake.

Personal use only, not for distribution or resale; not for navigation.

    node .\\dump_js_lists.mjs > js_lists.json          (run from js\\data\\)
    py .\\consolidate_lake_index.py `
       --registry "F:\\TrollMapPipeline\\registry" `
       --js-lists "F:\\TrollMapPipeline\\registry\\js_lists.json" `
       --charted  "F:\\TrollMapPipeline\\registry\\charted.json" `
       --out      "F:\\TrollMapPipeline\\registry\\lake_index.json"

`--aliases`, `--names` and `--counties` are NOT in that command because all three now default
to their file in `--registry`. THAT IS THE FIX FOR A BUG THIS DOCSTRING CAUSED, 2026-08-12.

`--aliases` used to have no default, and this usage block did not pass it. So every run made
from the copy/paste above loaded an EMPTY alias table, bound nothing, and said nothing about
it -- while `lake_aliases.json` sat in the registry directory with the right answers in it.

    lake_aliases.json   written 2026-08-04, 41 entries
    lake_index.json     rebuilt 2026-08-09, from this command
    -> `Lake Thicketty` still a null duplicate row beside `thicketty_creek_wcd_lake_number_26`

Five of Ryan's naming complaints were one bug: Wee Tee/Wittee, Lake Thicketty, the duplicate
Congaree River, HB Robinson, Jonesville Reservoir. Every one had a correct alias on disk that
no run ever read. Ryan, 2026-08-11: *"wee tee = wittee for about the 100th time"* -- he had
said it that many times because the fix kept being written to a file the run did not open.

`--counties` and `--names` already defaulted and already printed a line about what they
loaded. `--aliases` was the one of the three that stayed silent. AN OPTIONAL INPUT THAT
CHANGES THE OUTPUT MUST SAY WHAT IT DID, OR ITS ABSENCE IS INVISIBLE.

THE PROBLEM

TrollMap carries SIX lake lists and each was added to patch a hole in the one before it:

    data/lakes.js              LAKE_DB, 50 lakes. **DELETED 2026-08-04.** The data moved to
                               registry/curated_lakes.json and is read from there below; the
                               name `lake_db` survives ONLY as an internal dict key and a
                               console label. Ryan, 2026-08-12: *"LAKE_DB this is dead...
                               something replaced it."* Do not quote the name at him.

                               THE OLD CLAIM WAS "the ONLY source of USGS gauge ids." That was
                               true when written and is now the smallest source on the drive:

                                   this script, from curated_lakes.json     usgs on   4 rows
                                   registry/water_bindings.json             244 waters bound,
                                                                            147 pool gauges
                                                                            (123 name+geom),
                                                                            418 gauges on 185
                                   registry/tva_gauges.json                  43 dams, 27 at
                                                                            name+geom
                                   registry/_cameras.json                    25 bound sites

                               EVERY ONE OF THOSE 244 BINDING KEYS IS ALREADY A SLUG IN THIS
                               INDEX, and none of them reach a record. Folding them in is the
                               same one-line-per-field fold `charted.json` already gets -- it
                               is not done here yet because the confidence tier to trust is
                               Ryan's call, not a default. See 00_START_HERE "Also open".
    data/lake-keys.js          118 display-name -> R2-key aliases, plus a _normalize() with
                               hand-written cases for "Ft." and "St." and a fuzzy substring
                               matcher. All of it exists because names were the join key.
    data/scdnr-state-lakes.js  18 SCDNR State Lakes Program waters
    data/user-known-lakes.js   5 lakes Ryan knows and no feed lists
    data/coastal-zones.js      21 tidal zones -- NOT merged, a sound is not a lake
    data/lake-registry.js      1,551 from 3DHP, the new one

This produces the single record. It does NOT delete anything -- it prints exactly what would
be lost so the JS files can be retired with evidence rather than hope.

MATCHING IS BY NAME AND POSITION, NEVER NAME ALONE. `make_key_map.py`'s first version skipped
the position check and mapped a 51-acre Georgia millpond onto Jordan Lake, NC (13,119 acres).
Here a curated entry only binds to a registry lake if the normalised names agree AND the
coordinates are within --max-km.

WHAT DOES NOT MATCH IS THE POINT. Bates Old River and HB Robinson are real lakes Ryan fishes
that 3DHP never named; they are ADDED to the index as first-class records with
`source: curated`, not discarded as unmatched noise.
"""
import argparse, json, math, os, re, sys
from collections import defaultdict

STOP = {'lake', 'lakes', 'reservoir', 'rsvr', 'pond', 'millpond', 'mill', 'the', 'of',
        'impoundment'}
STATES = {'al', 'ar', 'fl', 'ga', 'il', 'in', 'ky', 'la', 'mo', 'ms', 'nc', 'sc', 'tn',
          'va', 'wv'}


def norm(s):
    toks = [t for t in re.split(r'[^a-z0-9]+', (s or '').lower()) if t]
    toks = [t for t in toks if t not in STATES]
    # Drop single-letter tokens: `Lake Edwin B. Johnson` in LAKE_DB is `Lake Edwin Johnson`
    # in GNIS, and a middle initial should never be the reason two records stay apart.
    toks = [t for t in toks if len(t) > 1 or t.isdigit()]
    core = [t for t in toks if t not in STOP]
    return ' '.join(sorted(core)) or ' '.join(sorted(toks))


def variants(name):
    """Names to try, in order. `Clarks Hill / Thurmond` is ONE lake with two names, and
    `Congaree River (to SC-601)` carries a qualifier GNIS does not use."""
    n = re.sub(r'\(.*?\)', ' ', name or '')
    out = [n]
    if '/' in n:
        out.extend(p for p in n.split('/'))
    return [v.strip() for v in out if v.strip()]


def km(la1, lo1, la2, lo2):
    return math.hypot((la1 - la2) * 111.32,
                      (lo1 - lo2) * 111.32 * math.cos(math.radians(la1)))


def open_text(path):
    raw = open(path, 'rb').read()
    for bom, enc in ((b'\xff\xfe', 'utf-16-le'), (b'\xfe\xff', 'utf-16-be'),
                     (b'\xef\xbb\xbf', 'utf-8-sig')):
        if raw.startswith(bom):
            import io
            return io.StringIO(raw.decode(enc).lstrip('\ufeff'))
    import io
    return io.StringIO(raw.decode('utf-8'))


def slugify(name, state):
    s = re.sub(r'[^a-z0-9]+', '_', ('%s' % name).lower()).strip('_')
    return '%s_%s' % (s, (state or '').lower()) if state else s


class CountyIndex:
    """Which county a centroid falls in. Point-in-polygon over counties_500k.geojson.

    WHY THIS EXISTS. Ryan, 2026-08-02: "all lakes were supposed to have their state name with
    them so that this wouldn't happen... i had already foresaw this and mentioned it".

    He was right, and the state suffix did its job -- it cut name collisions from 66 groups to
    40. But every one of the 40 that survived is INTRA-state: two Forest Lakes both in SC, four
    Long Ponds all in GA, two Lake Wallaces both in Marlboro County. State cannot separate
    those, by construction. County can, and it separates 35 of the 40 -- including both of the
    shipped-vs-shipped pairs, which is what actually matters, because those are the two the
    picker offered twice with no way to tell them apart.

    The source is the us-atlas npm package (Census cartographic boundaries, 1:10m, WGS84),
    flattened by make_counties.mjs. npm rather than census.gov because the build container can
    reach the former and not the latter.
    """

    def __init__(self, path):
        gj = json.load(open(path, encoding='utf-8'))
        self.items = []
        for f in gj.get('features') or []:
            g, p = f.get('geometry') or {}, f.get('properties') or {}
            polys = ([g['coordinates']] if g.get('type') == 'Polygon'
                     else g.get('coordinates') or [])
            if not polys:
                continue
            xs = [c[0] for poly in polys for ring in poly for c in ring]
            ys = [c[1] for poly in polys for ring in poly for c in ring]
            self.items.append((min(xs), min(ys), max(xs), max(ys),
                               p.get('county'), p.get('state'), polys))

    @staticmethod
    def _in_ring(x, y, ring):
        hit = False
        j = len(ring) - 1
        for i in range(len(ring)):
            xi, yi = ring[i][0], ring[i][1]
            xj, yj = ring[j][0], ring[j][1]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                hit = not hit
            j = i
        return hit

    def lookup(self, lon, lat):
        """(county, state) or (None, None). Holes are honoured so a county that wraps an
        independent city does not swallow it."""
        for w, s, e, n, county, st, polys in self.items:
            if lon < w or lon > e or lat < s or lat > n:
                continue
            for poly in polys:
                if not self._in_ring(lon, lat, poly[0]):
                    continue
                if any(self._in_ring(lon, lat, poly[k]) for k in range(1, len(poly))):
                    continue
                return county, st
        return None, None


def state_suffix(x):
    """`SC`, or `NC/SC` for a lake that straddles a line.

    Ryan chose to keep both states on the four border lakes -- Lake Wylie, Tugaloo, Yonah,
    Webster. Their centroid sits in one state only, so naming purely by the county's state
    would quietly drop the other half of a lake he fishes from both banks.
    """
    sts = [s for s in (x.get('states') or []) if s]
    if len(sts) > 1:
        return '/'.join(sts)
    return x.get('state') or (sts[0] if sts else '')


def load_name_overrides(path):
    """slug -> the name this water is actually called.

    NOT a spelling fix -- `suggest_name_aliases.py` and `lake_aliases.json` handle those, and
    an alias is the right tool when two sources spell one name differently. This file is for
    when 3DHP has named the water WRONG, which happens because it takes a GNIS name and GNIS
    names arms and pools, not reservoirs:

        dallas_lake            36,000 acres of Chickamauga Lake, named for Dallas Bay.
                               All 32 TWRA landings on Chickamauga fall inside it.
        reading_house_slough   Reelfoot Lake. 11 of 11 landings.

    The contours under those are correct and complete. Only the label is unusable, and no
    alias fixes that -- an alias makes the lake FINDABLE while the picker still shows a name
    nobody uses. So the displayed name is replaced and the 3DHP name is kept as a legacy name,
    which means anything already holding the old string -- a saved plan, an R2 key, a bookmark
    -- still resolves.

    Deliberately small and hand-written. A rule that renamed lakes automatically would need to
    decide that a state agency outranks USGS, which is true here and not in general.
    """
    if not path or not os.path.exists(path):
        return {}
    try:
        d = json.load(open(path, encoding='utf-8'))
    except Exception as exc:
        print('  !! name overrides unreadable (%s) -- ignoring' % str(exc)[:60])
        return {}
    # Two shapes, because they are two different problems:
    #
    #   "dallas_lake": "Chickamauga Lake"
    #       3DHP named the water WRONG. Replace the displayed name.
    #
    #   "eureka_lake": {"also": ["Cheraw State Park Lake"]}
    #       3DHP is not wrong, it is just not what anyone calls it. The lake is Eureka Lake
    #       on the map and Cheraw State Park Lake to everyone who fishes it. Keep the name,
    #       add the other one so searching finds it.
    #
    # `lake_aliases.json` cannot do the second job: it is only consulted when BINDING a
    # curated entry, and no curated source lists "Cheraw State Park Lake" -- so the alias
    # would sit in the file and never fire.
    out = {}
    for k, v in d.items():
        if isinstance(v, str) and v.strip():
            out[k] = {'name': v.strip(), 'also': []}
        elif isinstance(v, dict):
            nm = (v.get('name') or '').strip()
            also = [x.strip() for x in (v.get('also') or []) if isinstance(x, str) and x.strip()]
            if nm or also:
                out[k] = {'name': nm, 'also': also}
    return out


def display_with_county(name, county, suffix):
    """`Wateree Lake (Kershaw Co, SC)`. Falls back to `Name, ST` if county is unknown.

    The fallback must not append a suffix the name already carries. Five coastal zones
    came out as `Pamlico Sound / Neuse River, NC, NC`, `St. Helena Sound, SC, SC` and so
    on, because their names already end in the state and their centroids fall in open
    water outside every county polygon, so the county branch never fired.

    It is exactly the offshore sounds that hit this — the ones whose centroid is water,
    not land — so it will recur every time a zone is added, not once.
    """
    if county:
        return '%s (%s Co, %s)' % (name, county, suffix)
    if not suffix:
        return name
    if re.search(r',\s*%s\s*$' % re.escape(suffix), name):
        return name                      # already ends in ", ST"
    return '%s, %s' % (name, suffix)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--js-lists', required=True, help='output of dump_js_lists.mjs')
    ap.add_argument('--charted', help='charted.json from build_all_chartpacks.py')
    ap.add_argument('--out', required=True)
    ap.add_argument('--states', default='SC,NC,GA,TN')
    ap.add_argument('--max-km', type=float, default=25.0)
    ap.add_argument('--keep-unbuildable', action='store_true',
                    help='keep rows the build refused. Default is to DROP them from the index '
                         '-- see the note at the write, below.')
    ap.add_argument('--dropped-report', default=None,
                    help='write the dropped slugs here (default <registry>/_index_dropped.json)')
    ap.add_argument('--names', help='JSON of slug -> display name, for water 3DHP named '
                                    'wrong. Defaults to <registry>/lake_display_names.json.')
    ap.add_argument('--aliases', help='JSON of curated-name -> registry-slug, for '
                                      'genuine naming disagreements like Wee Tee/Wittee. '
                                      'Defaults to <registry>/lake_aliases.json.')
    ap.add_argument('--counties', help='counties_500k.geojson from make_counties.mjs. '
                                       'Defaults to the registry dir, then its parent.')
    a = ap.parse_args()

    want = {s.strip().upper() for s in a.states.split(',')}
    R = a.registry

    # Counties name the lakes. Without the file the script still runs and still produces a
    # usable index -- it just falls back to `Name, ST`, which is the naming that let two
    # Forest Lakes sit in the picker as identical rows. So say so, loudly, once.
    cpath = a.counties
    if not cpath:
        for cand in (os.path.join(R, 'counties_500k.geojson'),
                     os.path.join(os.path.dirname(R.rstrip('\\/')), 'counties_500k.geojson')):
            if os.path.exists(cand):
                cpath = cand
                break
    counties = None
    if cpath and os.path.exists(cpath):
        counties = CountyIndex(cpath)
        print('counties: %d polygons from %s' % (len(counties.items), cpath))
    else:
        print('!! NO COUNTY FILE -- display names fall back to "Name, ST", and the 40 '
              'same-state name collisions in this index will NOT be separated.')
        print('!! build it with:  node make_counties.mjs > '
              '"%s"' % os.path.join(R, 'counties_500k.geojson'))
    npath = a.names or os.path.join(R, 'lake_display_names.json')
    overrides = load_name_overrides(npath)
    if overrides:
        _rn = sum(1 for v in overrides.values() if v.get('name'))
        _ex = sum(len(v.get('also') or []) for v in overrides.values())
        print('name overrides: %d renamed, %d extra name(s) added, from %s'
              % (_rn, _ex, os.path.basename(npath)))

    reg = json.load(open(os.path.join(R, 'lakes.json'), encoding='utf-8'))
    # A BORDER LAKE IS IN THE REGION IF ANY OF ITS STATES IS.
    #
    # This tested only the PRIMARY state, which 3DHP assigns from the centroid. So a reservoir
    # whose middle happens to sit over the line was dropped entire, even with a boundary already
    # installed and Garmin contours already extracted for it. Sixteen waters, ~204,000 acres:
    #
    #     Guntersville Lake      AL/TN       65,603 ac
    #     Lake Barkley           KY/TN       49,741 ac
    #     John H. Kerr Reservoir VA/NC       44,895 ac
    #     Pickwick Lake          AL/MS/TN    34,470 ac
    #     Bartletts Ferry, Oliver, Goat Rock  AL/GA
    #
    # Kerr is the one that shows the cost. DELETION_TAB lists `kerr_lake` as DO NOT DELETE and
    # records `Kerr Lake, NC` resolving to `w_kerr_scott_reservoir` -- 1,280 acres standing in
    # for ~50,000 -- because the real one was never in the index to be resolved to.
    #
    # `states` is already on every one of the 3,258 rows and `state_suffix()` already renders
    # `NC/SC` for Wylie, Tugaloo, Yonah and Webster. The list was there; only this line ignored
    # it. Ryan, 2026-08-08: "if the lakes are in the tiles we already extracted and they are a
    # border lake/river then put them into trollmap with state and everything it needs."
    def _in_region(x):
        if (x.get('state') or '').upper() in want:
            return True
        return bool(want & {(s or '').upper() for s in (x.get('states') or [])})

    lakes = [x for x in reg['lakes'] if _in_region(x)]

    # ...AND IT MUST GROUP UNDER A STATE THE PICKER SHOWS. lake-ramp-select.js builds its
    # optgroups from STATE_ORDER = SC, NC, GA, TN, so a row left as `state: 'AL'` would pass the
    # filter and then fall out of every group -- present in the index, invisible in the app.
    # Promote the in-region state to primary; `states` keeps the full list, so state_suffix()
    # still renders `AL/TN` and nothing about the display is lost.
    _promoted = 0
    for x in lakes:
        if (x.get('state') or '').upper() not in want:
            for s in (x.get('states') or []):
                if (s or '').upper() in want:
                    x['state'] = s.upper()
                    _promoted += 1
                    break
    if _promoted:
        print('border waters admitted on a secondary state: %d (primary state promoted so the '
              'picker can group them)' % _promoted)
    # utf-8-sig, not utf-8. If the dumper's output was ever produced by a PowerShell `>`
    # redirect it arrives as UTF-16LE with a BOM and plain utf-8 dies on byte 0xff at
    # position 0. Sniff the BOM and decode accordingly rather than making the caller
    # remember which shell wrote the file.
    js = json.load(open_text(a.js_lists))

    # LAKE_DB used to arrive here inside js_lists.json, dumped out of js/data/lakes.js by
    # dump_js_lists.mjs. It has moved to registry/curated_lakes.json, because a data file
    # living in js/data/ looked exactly like dead app code -- nothing in the running app has
    # read it since the registry landed -- and it was queued for deletion three times on that
    # basis. It is not dead. It is the ONLY source of USGS gauge sites (Marion, Moultrie,
    # Murray, Parr Shoals, Wateree), Duke and Dominion basin bindings, normal/min pool
    # elevations, and the curated ramp lists on 38 rows.
    #
    # Read the new location first, fall back to the old key, and REFUSE to run with neither.
    # Silently consolidating without it produces a complete-looking index that has quietly
    # dropped every gauge -- which is the failure mode this whole file keeps being bitten by.
    cur_fp = os.path.join(R, 'curated_lakes.json')
    if os.path.exists(cur_fp):
        doc = json.load(open_text(cur_fp))
        js['lake_db'] = doc.get('lakes') or doc
        print('curated lakes: %d from registry/curated_lakes.json' % len(js['lake_db']))
    elif js.get('lake_db'):
        print('curated lakes: %d from js_lists.json (LEGACY -- migrate to '
              'registry/curated_lakes.json)' % len(js['lake_db']))
    else:
        raise SystemExit(
            'FATAL: no curated lake facts found.\n'
            '  Looked for registry/curated_lakes.json and for a "lake_db" key in %s.\n'
            '  Without them the index builds fine and silently loses every USGS gauge,\n'
            '  Duke/Dominion binding, pool curve and curated ramp list. Refusing to run.'
            % a.js_lists)
    charted = json.load(open(a.charted, encoding='utf-8')) if a.charted and \
        os.path.exists(a.charted) else {}

    def load(fn):
        fp = os.path.join(R, fn)
        return json.load(open(fp, encoding='utf-8')) if os.path.exists(fp) else {}

    acc = load('lake_access.json')
    ramps = {t: load(fn) for fn, t in (('natl_ramps_by_lake.json', 'natl'),
                                       ('osm_ramps_by_lake.json', 'osm'),
                                       ('garmin_ramps_by_lake.json', 'garmin'))}

    idx, by_norm = {}, defaultdict(list)
    county_hits = county_miss = 0
    for x in lakes:
        s = x['slug']
        A = acc.get(s) or {}
        C = charted.get(s) or {}
        r = {t: (ramps[t].get(s) or []) for t in ramps}

        # County comes from the centroid, and the state suffix from the lake's own state list
        # rather than the county's -- see state_suffix(). The pre-county string is kept as
        # `legacy_display_name` so a lake name saved in an old plan or catch still resolves;
        # lake-registry.js also normalises `name` alone, so "Forest Lake, SC" would resolve
        # regardless, but only ambiguously, and this is the unambiguous route.
        old_display = x.get('display_name') or '%s, %s' % (x['name'], x['state'])
        cty = None
        cen = x.get('centroid') or []
        if counties and len(cen) == 2:
            cty, _cty_state = counties.lookup(cen[0], cen[1])
            if cty:
                county_hits += 1
            else:
                county_miss += 1

        # The override replaces the NAME before the county suffix is added, so an overridden
        # lake is still disambiguated the same way every other lake is.
        _ov = overrides.get(s) or {}
        _name = _ov.get('name') or x['name']
        idx[s] = {
            'slug': s, 'name': _name, 'state': x['state'],
            'display_name': display_with_county(_name, cty, state_suffix(x)),
            # A LIST, because a lake can accumulate more than one former name: the "Name, ST"
            # form used before counties, and separately the curated LAKE_DB key it binds to
            # below. Overwriting one with the other would strand whichever string happens to
            # be sitting in a saved plan. `legacy_display_name` stays as the first entry so
            # anything already reading the scalar keeps working.
            'legacy_display_name': old_display,
            'legacy_display_names': (
                [old_display]
                + ([display_with_county(x['name'], cty, state_suffix(x)), x['name']]
                   if _ov.get('name') else [])
                + list(_ov.get('also') or [])),
            'county': cty,
            'gnis': x.get('lake_id'), 'source': ['3dhp'],
            'area_acres': round((x.get('area_km2') or 0) * 247.105, 1),
            'centroid': x.get('centroid'), 'bounds_wsen': x.get('bounds_wsen'),
            'access': A.get('access'), 'access_for_me': A.get('access_for_me'),
            'access_via': A.get('promoted_by'),
            'access_units': [u.get('Unit_Nm') or u.get('Loc_Nm')
                             for u in (A.get('units') or [])[:3]],
            'proclamation': A.get('proclamation') or [],
            'ramps': {t: v for t, v in r.items() if v},
            'ramp_sources': sum(1 for v in r.values() if v),
            # From the extraction. None means never measured; 0 means measured and empty.
            'charted': C.get('charted'),
            'shipped': bool(C.get('shipped')),
            'pack_mb': C.get('mb'),
        }
        by_norm[norm(x['name'])].append(s)

    # THE ALIAS FILE DEFAULTS, AND SAYS WHAT IT DID. See the 2026-08-12 note in the module
    # docstring: this used to be the one optional input of the three that loaded silently, so
    # a run that forgot the flag was indistinguishable from a run with no naming disagreements
    # to fix. `--counties` and `--names` above already work this way; this is only catching up.
    apath = a.aliases or os.path.join(R, 'lake_aliases.json')
    aliases = {}
    if os.path.exists(apath):
        aliases = {k.lower(): v for k, v in
                   json.load(open(apath, encoding='utf-8')).items()}
        print('aliases: %d curated-name -> slug from %s'
              % (len(aliases), os.path.basename(apath)))
    else:
        print('!! NO ALIAS FILE at %s -- every genuine naming disagreement (Wee Tee/Wittee,'
              % apath)
        print('!! Lake Thicketty, the duplicate Congaree) will produce a DUPLICATE null row.')

    alias_hit = set()          # keys that actually matched a curated name this run
    alias_dead = {}            # key -> target, where the target is not a registry slug

    def bind(name, lat, lon):
        """registry slug for a curated entry, or None.

        Explicit alias first, then name+position. Position is NOT optional: make_key_map's
        first version matched on name alone and put a 51-acre Georgia millpond onto Jordan
        Lake, NC. An alias file is the honest way to fix a genuine naming disagreement --
        GNIS spells Wee Tee as `Wittee` -- rather than loosening the matcher until it starts
        binding the wrong lakes."""
        # Try the alias table on the raw name AND on the comma-stripped one, because
        # LAKE_DB keys carry a state suffix (`Clarks Hill / Thurmond, SC/GA`) and the two
        # supplements do not. Making the caller remember which is which is how alias files
        # rot.
        for cand in ((name or '').strip(), re.sub(r',.*$', '', name or '').strip()):
            al = aliases.get(cand.lower())
            if al:
                alias_hit.add(cand.lower())
                # An explicit alias whose target is not a registry slug returns None rather
                # than falling through to the positional matcher: the whole point of writing
                # one down is that the guess was wrong. But a dead target is a typo or a slug
                # that got renamed, and silence there is how this file rots -- so record it.
                if al not in idx:
                    alias_dead[cand] = al
                    return None
                return al
        for v in variants(name):
            for s in by_norm.get(norm(v), []):
                c = idx[s].get('centroid') or []
                if len(c) != 2:
                    continue
                if km(lat, lon, c[1], c[0]) <= a.max_km:
                    return s
        return None

    stats = defaultdict(int)
    added, unbound = [], []
    RIVERS = re.compile(r'\briver\b', re.I)

    # --- LAKE_DB: the only source of gauges, basins and pool curves -------------
    for disp, v in (js.get('lake_db') or {}).items():
        c = v.get('center') or []
        if len(c) < 2:
            continue
        if v.get('coastal'):
            # LAKE_DB flags 9 tidal zones with `coastal: true` -- ACE Basin, Charleston
            # Harbor, Winyah Bay and the rest. Those belong to coastal-zones.js and there is
            # no registry lake to bind them to. Reporting them as unmatched made the failure
            # list twice as long as the real problem.
            stats['coastal_skipped'] += 1
            continue
        st = (re.search(r',\s*([A-Z]{2})', disp) or [None, None])[1]
        if st and st.upper() not in want:
            continue
        s = bind(disp, c[0], c[1])
        if not s:
            # A river is not a lake and 3DHP's waterbody layer will never hold one -- but
            # Congaree and Wateree River are fishable and already in the app, so they are
            # carried as first-class records rather than dropped for failing a lake match.
            if RIVERS.search(disp):
                slug = slugify(re.sub(r',.*$', '', disp), st)
                idx[slug] = {'slug': slug, 'name': re.sub(r',.*$', '', disp), 'state': st,
                             'display_name': disp, 'gnis': None, 'source': ['lake_db'],
                             'feature_type': 'river',
                             'area_acres': None, 'centroid': [c[1], c[0]],
                             'bounds_wsen': None, 'access': None, 'access_for_me': None,
                             'access_via': None, 'access_units': [], 'proclamation': [],
                             'ramps': {}, 'ramp_sources': 0, 'charted': None,
                             'shipped': False, 'pack_mb': None, 'needs_boundary': True,
                             'legacy_display_name': disp}
                for f in ('usgs', 'duke', 'dominion', 'normalPool', 'minPool'):
                    if v.get(f) is not None:
                        idx[slug][f] = v[f]
                added.append(('lake_db_river', disp, st))
                continue
            unbound.append(('lake_db', disp))
            continue
        rec = idx[s]
        rec['source'].append('lake_db')
        for f in ('usgs', 'duke', 'dominion', 'normalPool', 'minPool', 'tideStation'):
            if v.get(f) is not None:
                rec[f] = v[f]
                stats['field_' + f] += 1
        if v.get('ramps'):
            rec.setdefault('ramps', {})['curated'] = [
                {'name': n, 'lat': p[0], 'lon': p[1]} for n, p in v['ramps'].items()]
            rec['ramp_sources'] = len(rec['ramps'])
        # ADD the curated key, do not replace what is already there -- the pre-county
        # "Name, ST" string is just as likely to be the one in a saved plan.
        lg = rec.setdefault('legacy_display_names', [])
        if disp not in lg:
            lg.append(disp)
        rec['legacy_display_name'] = lg[0]
        stats['lake_db_bound'] += 1

    # --- the two hardcoded supplements ----------------------------------------
    for key, tag in (('scdnr_state_lakes', 'scdnr_state_lake'),
                     ('user_known_lakes', 'user_known')):
        for v in (js.get(key) or []):
            if (v.get('state') or '').upper() not in want:
                continue
            s = bind(v['name'], v['lat'], v['lon'])
            if s:
                idx[s]['source'].append(tag)
                if v.get('note'):
                    idx[s]['note'] = v['note']
                if v.get('county'):
                    idx[s]['county'] = v['county']
                # REMEMBER THE CURATED NAME. Without this, binding a supplement DELETES the
                # only name the user knows the water by: 'HB Robinson Lake' folded into
                # lake_robinson and then appeared nowhere in the index, so searching for it
                # found nothing at all -- strictly worse than the duplicate row it replaced.
                # The lake_db branch above has always done this; these two never did, and it
                # only became visible once lake_aliases.json started binding them.
                lg = idx[s].setdefault('legacy_display_names', [])
                for cand in (v['name'],
                             '%s, %s' % (v['name'], v['state']) if v.get('state') else None):
                    if cand and cand not in lg:
                        lg.append(cand)
                idx[s]['legacy_display_name'] = lg[0]
                stats[tag + '_bound'] += 1
                continue
            # NOT a failure. 3DHP never named it, and it is still a lake Ryan fishes.
            slug = slugify(v['name'], v.get('state'))
            idx[slug] = {
                'slug': slug, 'name': v['name'], 'state': v['state'],
                'display_name': '%s (%s Co, %s)' % (v['name'], v.get('county', '?'), v['state']),
                'gnis': None, 'source': [tag],
                'area_acres': v.get('acres'),
                'centroid': [v['lon'], v['lat']], 'bounds_wsen': None,
                'access': None, 'access_for_me': None, 'access_via': None,
                'access_units': [], 'proclamation': [], 'ramps': {}, 'ramp_sources': 0,
                'charted': None, 'shipped': False, 'pack_mb': None,
                'county': v.get('county'), 'note': v.get('note'),
                'needs_boundary': True,     # cut one from Garmin mode 6/20 before it can ship
            }
            added.append((tag, v['name'], v.get('state')))

    # ── feature_type, in ONE place ───────────────────────────────────────────
    #
    # Measured 2026-08-04 on the shipped index: 1,661 of 1,663 rows carried
    # feature_type = None. Only two said 'river', against 82 river slugs and 22
    # coastal zones. Anything reading the field to tell moving water from a
    # reservoir was being told everything is a reservoir.
    #
    # The cause was that only ONE of the three record builders in this file set it —
    # the lake_db river branch. The 3DHP builder and the scdnr/user-known builder
    # both omitted it, so a field that exists on every row was populated on almost
    # none. Classifying once, here, after every record is built, is the only shape
    # that cannot drift again: a fourth builder added later inherits it for free.
    #
    # An explicit value already on the record always wins — the lake_db branch knows
    # things the slug does not.
    RIVERISH = re.compile(r'\b(river|creek|run|branch|fork|stream|canal|slough|bayou)\b', re.I)
    ft_counts = {}
    for slug, rec in idx.items():
        if not rec.get('feature_type'):
            if slug.startswith('coast_'):
                rec['feature_type'] = 'coastal'
            elif RIVERISH.search(rec.get('name') or '') or RIVERISH.search(slug.replace('_', ' ')):
                rec['feature_type'] = 'river'
            else:
                rec['feature_type'] = 'lake'
        ft_counts[rec['feature_type']] = ft_counts.get(rec['feature_type'], 0) + 1

    # ── DROP WHAT THE BUILD ALREADY REFUSED ───────────────────────────────────────────────
    #
    # Ryan, 2026-08-12, on the gate being in the wrong place: *"why have boundaries why have
    # empty chartpacks why have any of this for lakes that are never going to go anywhere?"*
    # Measured that day: 1,008 of 1,867 index rows carried a boundary and a picker entry while
    # being unbuildable -- 57% of what the app OFFERS could not draw a contour. His acceptance
    # test is "contours when I select a body of water in the right place", so more than half of
    # the list failed the first clause.
    #
    # FILTERED HERE RATHER THAN DELETED FROM lakes.json, deliberately. lakes.json is the 3DHP
    # SUPERSET -- 3,392 rows across fifteen states, the record of what EXISTS. The index is what
    # the app OFFERS. Those are different questions and deleting from the first to fix the
    # second throws away the answer to the first. This is also reversible: --keep-unbuildable
    # puts every row back, which a deletion could not.
    #
    # The key is the build's own verdict, not a guess and not an acreage proxy: charted == 0 AND
    # a recorded `skipped` reason. `build_chartpack.py` refused each of these and wrote down why.
    dropped = []
    if not a.keep_unbuildable and charted:
        for slug in list(idx):
            C = charted.get(slug)
            if not C or C.get('shipped'):
                continue
            why = C.get('skipped')
            if not why:
                continue                 # no verdict recorded -- not ours to judge
            if C.get('charted'):
                continue                 # measured non-zero: keep it, whatever else is true
            dropped.append({'slug': slug, 'name': idx[slug].get('name'),
                            'state': idx[slug].get('state'),
                            'area_acres': idx[slug].get('area_acres'), 'why': why})
            del idx[slug]

    json.dump(idx, open(a.out, 'w', encoding='utf-8'), indent=1)
    if dropped:
        from collections import Counter as _C
        rp = a.dropped_report or os.path.join(R, '_index_dropped.json')
        json.dump(dropped, open(rp, 'w', encoding='utf-8'), indent=1)
        print('\ndropped %d unbuildable rows from the index (--keep-unbuildable to keep them):'
              % len(dropped))
        for why, n in _C(d['why'] for d in dropped).most_common():
            print('   %5d  %s' % (n, why))
        print('   -> %s' % rp)
        print('   their boundaries and chartpack dirs are UNTOUCHED, and so is lakes.json.')
    elif a.keep_unbuildable:
        print('\n--keep-unbuildable: unbuildable rows RETAINED in the index.')

    print('%d registry lakes in %s' % (len(lakes), ','.join(sorted(want))))
    print('%d records written' % len(idx))
    print('feature_type: ' + ', '.join('%s %d' % kv for kv in sorted(ft_counts.items())) + '\n')

    # Display names must be unique or the picker shows rows nobody can tell apart. This is
    # the check that would have caught it the first time, so it runs on every build.
    print('county assigned to %d lakes, %d centroids fell outside every county polygon'
          % (county_hits, county_miss))
    dup = defaultdict(list)
    for s, rec in idx.items():
        dup[rec['display_name']].append(s)
    clash = {d: ss for d, ss in dup.items() if len(ss) > 1}
    ship_clash = {d: ss for d, ss in clash.items()
                  if sum(1 for s in ss if idx[s].get('shipped')) > 1}
    print('display names: %d records, %d distinct, %d names shared, %d shared by two or more '
          'SHIPPED lakes' % (len(idx), len(dup), len(clash), len(ship_clash)))
    if ship_clash:
        print('  !! these reach the picker as identical rows:')
        for d, ss in sorted(ship_clash.items()):
            print('     %-44s %s' % (d, ', '.join(ss)))
    elif clash:
        print('  remaining collisions are all between UNSHIPPED lakes, which the picker '
              'does not offer:')
        for d, ss in sorted(clash.items())[:10]:
            print('     %-44s %s' % (d, ', '.join(ss)))
    print()
    # Labelled by its FILE, not by the dead JS symbol. `LAKE_DB` here sent a reader looking
    # for js/data/lakes.js, which has not existed since 2026-08-04.
    print('curated_lakes %2d of %d bound to a registry lake'
          % (stats['lake_db_bound'], len(js.get('lake_db') or {})))
    print('SCDNR lakes  %2d bound' % stats['scdnr_state_lake_bound'])
    print('user-known   %2d bound' % stats['user_known_bound'])
    print('\ncurated fields carried over from curated_lakes.json:')
    for f in ('usgs', 'duke', 'dominion', 'normalPool', 'minPool', 'tideStation'):
        if stats['field_' + f]:
            print('   %-12s %d lakes' % (f, stats['field_' + f]))

    if added:
        print('\n%d lakes ADDED that 3DHP never named -- these need a boundary cut from '
              'Garmin mode 6/20 before they can ship:' % len(added))
        for tag, n, st in added:
            print('   %-28s %s  [%s]' % (n, st, tag))
    if unbound:
        print('\n%d curated entries did NOT bind. Check these before deleting the JS file:'
              % len(unbound))
        for src, n in unbound:
            print('   %-14s %s' % (src, n))

    # ── WHAT THE ALIAS FILE ACTUALLY DID ─────────────────────────────────────────────────
    #
    # An alias that matches no curated name is not harmless: it LOOKS like the naming
    # disagreement is handled, so the next person stops looking. 36 of the 41 entries written
    # by 2026-08-11 match nothing this script reads -- they were aimed at name lists that have
    # since moved -- and there was no way to see that from the output.
    if aliases:
        cold = sorted(k for k in aliases if k not in alias_hit)
        print('\nalias file: %d of %d keys matched a curated name'
              % (len(alias_hit), len(aliases)))
        if alias_dead:
            print('   %d point at a slug that is NOT in this index -- these bind to NOTHING '
                  'and suppress the positional matcher too:' % len(alias_dead))
            for k, v in sorted(alias_dead.items()):
                print('      %-34s -> %s' % (k[:34], v))
        if cold:
            print('   %d matched no curated name in this run (stale, or for a list this '
                  'script no longer reads):' % len(cold))
            for k in cold:
                print('      %-34s -> %s' % (k[:34], aliases[k]))

    if charted:
        sh = [v for v in idx.values() if v.get('shipped')]
        print('\ncharted: %d shipped, %d measured-and-empty, %d never measured'
              % (len(sh),
                 sum(1 for v in idx.values() if v.get('charted') == 0),
                 sum(1 for v in idx.values() if v.get('charted') is None)))
    print('\n-> %s' % a.out)


if __name__ == '__main__':
    main()
