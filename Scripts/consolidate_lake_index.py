#!/usr/bin/env python3
"""consolidate_lake_index.py - fold every lake list in the app into ONE record per lake.

Personal use only, not for distribution or resale; not for navigation.

    py .\\build_water_names.py --registry "F:\\TrollMapPipeline\\registry" --go
    py .\\consolidate_lake_index.py `
       --registry "F:\\TrollMapPipeline\\registry" `
       --charted  "F:\\TrollMapPipeline\\registry\\charted.json" `
       --out      "F:\\TrollMapPipeline\\registry\\lake_index.json"

THERE IS NO `--js-lists` ANY MORE, 2026-08-22. `dump_js_lists.mjs`, `js_lists.json` and the
two lists behind them are in `_to_delete/`. Their names come from `registry/_feed_names.json`,
which `build_water_names.py` harvests from the live ramp feeds. A command in a docstring is a
dependency -- this block once put `lake_boundaries/` back after it was retired -- so the line
that ran the dumper is gone rather than commented out.

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
import argparse, io, json, math, os, re, sys
from collections import defaultdict

# Parameter codes worth asking the USGS OGC API for, in the order they go into `usgs.params`.
# 00010 water temperature is the only one the plan panel renders today and it leads for that
# reason; the elevation and flow codes ride along because the site reports them and a renderer
# that wants them should not need lake_index.json rebuilt first. Anything not in this list is
# dropped -- a site can report forty codes and the query string is not the place to carry them.
USGS_USEFUL_PARMS = ('00010', '00062', '62614', '62615', '00065', '00060')

# A tailrace is below the dam. It is never the water the row names, whichever end of the chain
# is choosing.
# The separator is optional because the registry writes the canal as "Tail Race Canal", two
# words, while every gauge name writes "TAILRACE", one. Matching only the closed form meant the
# self-tailrace guard below never fired on the one row it was written for.
_TAILRACE_RE = re.compile(r'\btail[\s\-]?(?:race|water)\b', re.I)

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


_BOUNDARY_FT = re.compile(r'"feature_type"\s*:\s*"([^"]+)"')
_BOUNDARY_FT_CACHE = {}


def boundary_feature_type(regdir, slug):
    """3DHP's own classification for this water, read from the boundary file we already wrote.

    THE ANSWER WAS ALWAYS ON DISK. `build_lake_registry.py` copies `featuretypelabel` out of the
    geopackage into the boundary file's collection-level `properties`, and across 3,402 boundary
    files the whole vocabulary is three words: Lake 3,083, Coastal 17, River 1.

    Nothing read it. The classifier below re-derived the field from a regex on the NAME instead,
    so `Fishing Creek Reservoir` -- gnis:1247757, feature_type Lake, an 8.76 km2 impoundment on
    the Catawba -- came out `river` because the word "Creek" is in its name, while `Wateree Lake`,
    the next impoundment down the same river, came out `lake` because it is not. Ryan found it by
    looking for a lake and finding it filed under rivers, then killed the excuse in one line:
    "lake wateree is a catawba river lake and it shows up under lakes like it is supposed."

    Measured 2026-08-22 over the 452 offered rows: 271 lake/lake and 14 coastal/coastal agreed,
    exactly ONE row is genuinely a river to 3DHP, and 17 rows 3DHP calls Lake were being served
    as rivers -- Bear Creek Lake, Wolf Creek Lake, Tanasee Creek Lake, Cedar Creek Reservoir,
    Goose Creek Reservoir, Stony Creek Reservoir, Beaver Creek Pond, Quaker Creek Reservoir,
    Thicketty Creek WCD Lake Number 26, and `hughes_old_river`, which is an OXBOW -- water cut
    off from the river, the same argument Ryan already had to make about Bates Old River.

    That matters beyond a label: `water-filter.js` reads feature_type into `isRiver`, and rivers
    are off by default in the research picker. All 17 were hidden rather than misfiled.

    Only the first 8 KB is read because `build_lake_registry.py` writes `properties` before
    `features`, and the geometry after it can run to megabytes.

    Returns None when the file has no classification -- see the counter at the call site, which
    prints how many rows fell through to the name. That number is the size of the remaining gap,
    and it must never be silent.
    """
    if slug in _BOUNDARY_FT_CACHE:
        return _BOUNDARY_FT_CACHE[slug]
    val = None
    try:
        with io.open(os.path.join(regdir, 'boundaries', slug + '.geojson'),
                     encoding='utf-8', errors='replace') as fh:
            m = _BOUNDARY_FT.search(fh.read(8192))
        if m:
            val = m.group(1).strip().lower()
    except OSError:
        pass
    if val not in ('lake', 'river', 'coastal'):
        val = None
    _BOUNDARY_FT_CACHE[slug] = val
    return val


# NHD FType, the one source in this registry that actually separates moving water from still.
#
# 3DHP DOES NOT. Its waterbody table is 13,718 "Lake" against a single "River" across the whole
# checkpoint, so it can say "this is a waterbody polygon" and nothing more -- Cooper River, Black
# River and the Waccamaw are all "Lake" to it. NHD carries FType on the binding
# match_waters_to_nhd.py already computed: 460 StreamRiver in NHDArea, 390 LakePond and 436
# Reservoir in NHDWaterbody.
#
# Measured 2026-08-22 over the 452 offered rows: 303 carry a 3DHP classification, 422 carry an
# NHD FType, and where both exist they disagree on ZERO rows. Two independent sources, no
# conflict. Together they answer 436 of 452 and leave 16 with no source at all.
#
# 466 SwampMarsh is deliberately NOT mapped. It is neither, and inventing a side for it is the
# kind of arbitrary call this file exists to stop making; those rows fall through and are
# counted as guesses like any other.
NHD_FTYPE_TO_FEATURE = {390: 'lake', 436: 'lake', 460: 'river', 493: 'coastal', 445: 'coastal'}


def load_3dhp_feature_types(regdir):
    """slug -> feature_type off 3DHP's NUMERIC featuretype. (mapping, one line about it).

    THE NUMERIC COLUMN IS THE CLASSIFICATION AND THE TEXT LABEL IS NOT A SUBSTITUTE FOR IT.

    `hydro_3dhp_all_waterbody` carries 1 River 61,797 / 2 Canal 9,019 / 3 Lake 5,676,466 /
    4 Ocean 684. This project read `featuretypelabel` out of the registry CHECKPOINT instead,
    saw 13,718 Lake against one River, and concluded 3DHP could not separate moving water from
    still -- but the checkpoint is written with `--types`, so it only ever held lakes. A filtered
    cache was measured and the claim was made about the source. Ryan had already written the
    real vocabulary into 00_START_HERE: "3 lakes, 1 and 2 rivers and canals, 4 ocean."

    `resolve_feature_types.py` does the joins and writes <registry>/_feature_types.json. It is a
    separate file because the geopackage is 60 GB and the id3dhp column is unindexed -- a 20 s
    scan belongs in a tool that runs when boundaries change, not in every consolidate.
    """
    p = os.path.join(regdir, '_feature_types.json')
    try:
        with io.open(p, encoding='utf-8') as fh:
            raw = json.load(fh) or {}
    except (OSError, ValueError) as exc:
        return {}, ('3DHP featuretype: NOT LOADED (%s: %s) -- run resolve_feature_types.py; '
                    'every row falls back a tier' % (os.path.basename(p), exc))
    out = {}
    for slug, row in raw.items():
        ft = (row or {}).get('feature_type')
        if ft in ('lake', 'river', 'coastal'):
            out[slug] = ft
    return out, '3DHP featuretype: %d of %d rows classified' % (len(out), len(raw))


def load_nhd_ftypes(regdir):
    """slug -> feature_type off NHD FType. Returns (mapping, one line saying what it loaded).

    It says what it loaded because an optional input that changes the output and stays silent is
    the --aliases bug this file already paid for once.
    """
    p = os.path.join(regdir, '_nhd_bindings.json')
    try:
        with io.open(p, encoding='utf-8') as fh:
            binds = (json.load(fh) or {}).get('bindings') or {}
    except (OSError, ValueError) as exc:
        return {}, 'NHD FTypes: could NOT read %s (%s) -- every row falls back a tier' % (p, exc)
    out = {}
    unmapped = {}
    for slug, row in binds.items():
        ft = (row or {}).get('nhd_ftype')
        got = NHD_FTYPE_TO_FEATURE.get(ft)
        if got:
            out[slug] = got
        elif ft is not None:
            unmapped[ft] = unmapped.get(ft, 0) + 1
    note = 'NHD FTypes: %d of %d bindings classified' % (len(out), len(binds))
    if unmapped:
        note += ' (unmapped FType %s)' % ', '.join('%s x%d' % kv for kv in sorted(unmapped.items()))
    return out, note


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
    #   "wittee_lake": {"also": [...], "note": "Oxbow of the Santee River ..."}
    #       A third job, moved here 2026-08-22. `note` used to arrive from
    #       user-known-lakes.js / scdnr-state-lakes.js / curated_lakes.json, three hardcoded
    #       lists that between them contributed 40 extra names and 5 notes and NOT ONE water:
    #       every index row they tagged already carried `3dhp`. Their names and notes live
    #       here now so the lists can be deleted. See
    #       REMOVING_THE_TWO_HARDCODED_LISTS_2026-08-22.md.
    out = {}
    for k, v in d.items():
        if isinstance(v, str) and v.strip():
            out[k] = {'name': v.strip(), 'also': [], 'note': ''}
        elif isinstance(v, dict):
            nm = (v.get('name') or '').strip()
            also = [x.strip() for x in (v.get('also') or []) if isinstance(x, str) and x.strip()]
            note = (v.get('note') or '').strip()
            if nm or also or note:
                out[k] = {'name': nm, 'also': also, 'note': note}
    return out


def _with_state_suffix(names, suffix):
    """Every extra name, plus its "Name, ST" form.

    The PRIMARY name has always had both forms -- `old_display` is exactly that, and it is why
    a lake saved in an old plan still resolves. The extra names did not, so seven entries in
    `lake_display_names.json` existed for nothing but the suffix: "Lake Lanier, GA" beside a
    feed that already says "Lake Lanier". A suffix is a rule, not a fact about a lake, and a
    rule does not belong in a hand-written file. Added 2026-08-22 when those files were being
    retired -- see REMOVING_THE_TWO_HARDCODED_LISTS_2026-08-22.md.
    """
    out = []
    for n in names:
        if n and n not in out:
            out.append(n)
        if not suffix:
            continue
        withsuf = '%s, %s' % (n, suffix)
        if withsuf not in out and not n.rstrip().endswith(suffix):
            out.append(withsuf)
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


def _sibling_region(path):
    """in_region.Region, loaded from the scripts/ dir beside this file."""
    import importlib.util
    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location('in_region', os.path.join(here, 'in_region.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.Region.load(path, required=False)


def drop_retired(idx, registry_dir):
    """Remove every slug a merge has already retired. Returns (removed, note).

    A MERGED-AWAY SLUG MUST NOT COME BACK, and until 2026-08-17 it always did.
    merge_duplicate_waters.py removes the slug from lake_index.json and
    migrate_merged_slugs.py repairs the slug-keyed sidecars, but NEITHER touches lakes.json --
    deliberately, for the reason given at the unbuildable gate below: lakes.json is the record
    of what EXISTS and a merge is a statement about what the app OFFERS. So this script, which
    rebuilds the index FROM lakes.json, resurrected all five on the next run:
    brinkley_lake, persimmon_lake, kings_mountain_reservoir, lake_lookout and wilson_dam were
    back in the index at 455 rows, each one a water Ryan had already decided was the same water
    as its keeper under a different name. The merges looked like they worked. They lasted until
    the next consolidate.

    registry/_deletion_tab.json is where merge_duplicate_waters.py writes them, so it is the
    authoritative list and this needs no second copy of the decision.

    A missing or unreadable tab is NOT fatal -- but it is said out loud, because silently
    skipping this gate is the failure it exists to prevent.
    """
    fp = os.path.join(registry_dir, '_deletion_tab.json')
    if not os.path.exists(fp):
        return [], 'no _deletion_tab.json -- merged slugs are NOT being filtered'
    try:
        tab = (json.load(open(fp, encoding='utf-8')) or {}).get('retired') or []
    except Exception as exc:
        return [], '_deletion_tab.json unreadable (%s: %s) -- merged slugs are NOT being filtered' % (
            type(exc).__name__, exc)
    removed = []
    for e in tab:
        slug = (e or {}).get('slug')
        if slug and slug in idx:
            removed.append({'slug': slug, 'merged_into': e.get('merged_into'),
                            'name': idx[slug].get('name')})
            del idx[slug]
    return removed, None


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--charted', help='charted.json from build_all_chartpacks.py')
    ap.add_argument('--out', required=True)
    ap.add_argument('--states', default='SC,NC,GA,TN')
    ap.add_argument('--max-km', type=float, default=25.0)
    ap.add_argument('--keep-unbuildable', action='store_true',
                    help='keep rows the build refused. Default is to DROP them from the index '
                         '-- see the note at the write, below.')
    ap.add_argument('--packs', default=None,
                    help='chartpack root. A row with no pack directory cannot draw anything, so '
                         'it is dropped. Defaults to <registry>/../chartpack.')
    ap.add_argument('--keep-closed', action='store_true',
                    help='keep waters registry/_water_notes.json records as closed to fishing')
    ap.add_argument('--min-charted', type=float, default=0.02,
                    help='drop a row with a NON-ZERO charted fraction below this. 0.02 is not '
                         'a number invented here: it is the threshold this script has been '
                         'printing "say the word and they go" against for weeks, and Ryan said '
                         'the word on 2026-08-23. Pass 0 to keep everything. A literal zero is '
                         'already handled by the unbuildable gate.')
    ap.add_argument('--keep-unnamed', action='store_true',
                    help='keep the 3DHP polygons no feed has ever named -- rows whose name IS '
                         'their own slug, like water_imlm3. Dropped by default: building one '
                         'puts a machine name in the picker. A FILTER, never a delete.')
    ap.add_argument('--keep-packless', action='store_true',
                    help='keep index rows that have no chartpack directory')
    ap.add_argument('--region-mask', default=None,
                    help='region_mask.json from make_region_mask.py. DEFAULTS to '
                         '<registry>/region_mask.json and warns loudly if it is missing -- an '
                         'optional filter that silently passes everything is the --aliases bug.')
    ap.add_argument('--ship-keep', default=None,
                    help='slugs that ship whatever the region says, one per line. Defaults to '
                         '<registry>/_ship_keep.txt.')
    ap.add_argument('--no-region', action='store_true',
                    help='skip the scope gate entirely and index every buildable lake')
    ap.add_argument('--ship-list', default=os.path.join('outputs', 'ship_lakes.txt'),
                    help='where to write the build list -- the index rows that have a NAME. '
                         'The five builders take it as --only-lakes, and chart_currency.py '
                         'reads the same file under the same flag name. NOT the same thing as '
                         'build_all_chartpacks.py --ship-list, which is the "or on a DNR list" '
                         'half of the ship rule -- one flag name, two meanings, so check which '
                         'script you are looking at. Written here rather than kept by hand '
                         'because it is not a separate fact: it IS the index, less the waters '
                         'nobody has named. Pass an empty string to skip.')
    ap.add_argument('--tile-list', default=os.path.join('outputs', 'ship_tiles.txt'),
                    help='where to write the tiles the build list actually touches, for '
                         'trollmap_extract_all.py --tiles. Derived from tile_lake_map.json, '
                         'so it shrinks when the index does. Pass an empty string to skip.')
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
    fnpath = os.path.join(R, '_feed_names.json')
    feed_names = {}
    if os.path.exists(fnpath):
        try:
            feed_names = json.load(open(fnpath, encoding='utf-8')) or {}
        except Exception as exc:
            print('  !! _feed_names.json unreadable (%s) -- ignoring' % str(exc)[:60])
    print('feed names: %d name(s) across %d water(s)%s'
          % (sum(len(v) for v in feed_names.values()), len(feed_names),
             '' if feed_names else '  -- run build_water_names.py'))

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
    # No hardcoded list is read any more. `js` survives as the dict `lake_db` is loaded into
    # just below, because curated_lakes.json is the last of the three and has not been retired
    # yet.
    js = {}

    # LAKE_DB used to arrive here inside js_lists.json, dumped out of js/data/lakes.js by
    # dump_js_lists.mjs. It has moved to registry/curated_lakes.json, because a data file
    # living in js/data/ looked exactly like dead app code -- nothing in the running app has
    # read it since the registry landed -- and it was queued for deletion three times on that
    # basis. It WAS the only source of USGS gauge sites, Duke and Dominion basin
    # bindings, normal/min pool elevations and the curated ramp lists. As of 2026-08-15 it is
    # the source of none of them -- see the carry-over block below, which now carries nothing
    # but the legacy display name.
    #
    # Read the new location first, fall back to the old key, and REFUSE to run with neither.
    #
    # WHAT THE REFUSAL IS FOR NOW, 2026-08-15. It used to be the gauges: this was the only
    # source of usgs, Duke/Dominion bindings and pool elevations, and consolidating without it
    # silently dropped all of them. None of that is true any more -- gauges come from
    # water_bindings.json, pool elevations from Worker/worker-data.js, ramps from the five
    # by-lake buckets. The file supplies exactly one thing: the LEGACY DISPLAY NAME, so a lake
    # saved in an old plan or catch still resolves. Worth refusing to run without, and a much
    # smaller claim than this comment used to make.
    # --charted HAS A DEFAULT, AND THE WARNING LIVES OUT HERE.
    #
    # It did not, and that cost the registry shrink a whole run on 2026-08-12. `--charted` was
    # optional with no default, the unbuildable filter below reads `if not a.keep_unbuildable
    # and charted:`, and a run without the flag produced an index of 1,867 rows with 1,008
    # unbuildable ones still in it -- a completely normal-looking run that did none of the work
    # it was asked to do. This is the FOURTH instance of that shape found in one day: the alias
    # file, the R2 registry publish, the USGS catalogue, and now this one, which was written
    # that same morning by the session that had just documented the other three.
    #
    # The rule the other three earned: an optional flag that changes the OUTPUT gets a default,
    # and the warning for a missing input is printed OUTSIDE the block it gates -- because a
    # warning inside the block never fires in the case that needs it.
    cpath = a.charted or os.path.join(R, 'charted.json')
    charted = {}
    if os.path.exists(cpath):
        charted = json.load(open(cpath, encoding='utf-8'))
        print('charted: %d slug(s) from %s' % (len(charted), os.path.basename(cpath)))
    else:
        print('!! NO charted.json AT %s' % cpath)
        print('   The index will build and every unbuildable row will stay in it -- the shrink')
        print('   is measured from this file and cannot run without it. Pass --charted, or put')
        print('   charted.json in the registry, or accept an index the app cannot draw.')

    def load(fn):
        fp = os.path.join(R, fn)
        return json.load(open(fp, encoding='utf-8')) if os.path.exists(fp) else {}

    acc = load('lake_access.json')
    # THE DNR BUCKETS ARE THE ONES THE FEEDS ACTUALLY KNOW ABOUT, and until 2026-08-14 there
    # was no DNR bucket here at all -- which is why `ramp_sources` read 0 on Broad River,
    # Congaree, Santee and Wateree while SCDNR listed ramps on every one of them. Ryan:
    # "we need to wire the live ramps to the registry... this is getting ridiculous."
    # Built by build_dnr_ramps_by_lake.py, which fetches the four state ArcGIS feeds live and
    # binds each point by NAME first, geometry second. Missing files load as {} and cost
    # nothing, so this is safe before the first run.
    ramps = {t: load(fn) for fn, t in (('natl_ramps_by_lake.json', 'natl'),
                                       ('osm_ramps_by_lake.json', 'osm'),
                                       ('garmin_ramps_by_lake.json', 'garmin'),
                                       ('dnr_ramps_by_lake.json', 'dnr'),
                                       ('dnr_paddle_by_lake.json', 'dnr_paddle'))}

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
        # NAMES FROM THE FEEDS, NOT FROM A LIST. `_feed_names.json` is regenerated by
        # build_water_names.py from the `wb` field every ramp record already carries -- the name
        # the AGENCY uses for the water it put that ramp on. It replaces the extra names that
        # came from scdnr-state-lakes.js, user-known-lakes.js and curated_lakes.json, and unlike
        # those it grows and shrinks with the feed instead of with somebody editing a file.
        _feed = feed_names.get(s) or []
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
                + _with_state_suffix(list(_ov.get('also') or [])
                                    + [n for n in _feed if n not in (_ov.get('also') or [])],
                                    state_suffix(x))),
            'county': cty,
            # The note is a fact about the water -- what it is legally called, what it is an
            # oxbow of, why it fishes the way it does. It arrived from a hardcoded list until
            # 2026-08-22 and now comes from the same hand-held override file as the names.
            **({'note': _ov['note']} if _ov.get('note') else {}),
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

    # --- THE THREE HARDCODED WATER LISTS ARE GONE -----------------------------
    #
    # `scdnr-state-lakes.js` and `user-known-lakes.js` went on 2026-08-22; their loop stayed
    # behind and iterated an empty dict on every run since. `curated_lakes.json` went on
    # 2026-08-24, and it was the last of the three. Ryan: *"i don't want them to die by
    # extracting the info and moving it somewhere else... it needs to be an automated process
    # that can grow or shrink on its own... not hand written."*
    #
    # WHAT REPLACED IT: the names come from `registry/_feed_names.json`, harvested by
    # build_water_names.py out of the `wb` field every ramp record already carries -- the name
    # the AGENCY uses for the water it hung that ramp on. Add a ramp to the feed and the name
    # appears; drop it and the name goes.
    #
    # HOW IT WAS PROVED SAFE, 2026-08-24: the index was built twice with only this file
    # different and both handed to compare_index_names.py. 358 rows either way, ONE name lost
    # -- "Lake Rhodhiss, NC", which Duke and the ramp signage use and no feed carries. It is
    # an `also` on `rhodhiss_lake` in lake_display_names.json now, which is hand-held on
    # purpose and documented for exactly that, and the rebuilt comparison reports NOTHING
    # LOST. Prove the replacement is complete while the old thing is still in place.
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
    # THE SOURCE OUTRANKS THE NAME. See boundary_feature_type() for what this cost.
    #
    # The regex below stays because 301 of 3,402 boundary files carry no classification at all,
    # and 149 of those are offered rows -- Lake Marion, Hartwell, Norris, Norman, Cherokee,
    # Wylie, Savannah River. They are blank because two writers drop the block:
    # `attach_arms.py` rebuilds the file from `feats[0]['properties']` and
    # `install_registry_boundary.py` writes its own `{slug, source}` in its place. Both now
    # carry the classification through, so this fallback's territory shrinks as boundaries are
    # recut rather than growing.
    #
    # A NAME IS THE LAST RESORT, NOT THE FIRST. 00_START_HERE has said "plain substring matching
    # cannot be made safe" through five instances; this was the sixth.
    RIVERISH = re.compile(r'\b(river|creek|run|branch|fork|stream|canal|slough|bayou)\b', re.I)
    tdhp_ft, tdhp_note = load_3dhp_feature_types(R)
    print(tdhp_note)
    nhd_ft, nhd_note = load_nhd_ftypes(R)
    print(nhd_note)
    ft_counts = {}
    ft_src = {'record': 0, '3dhp_type': 0, 'boundary': 0, 'slug_prefix': 0, 'nhd': 0, 'name': 0}
    ft_named = []
    for slug, rec in idx.items():
        if rec.get('feature_type'):
            ft_src['record'] += 1
        else:
            if tdhp_ft.get(slug):
                rec['feature_type'] = tdhp_ft[slug]
                ft_src['3dhp_type'] += 1
                ft_counts[rec['feature_type']] = ft_counts.get(rec['feature_type'], 0) + 1
                continue
            src = boundary_feature_type(R, slug)
            if src:
                rec['feature_type'] = src
                ft_src['boundary'] += 1
            elif slug.startswith('coast_'):
                rec['feature_type'] = 'coastal'
                ft_src['slug_prefix'] += 1
            elif nhd_ft.get(slug):
                rec['feature_type'] = nhd_ft[slug]
                ft_src['nhd'] += 1
            else:
                riverish = (RIVERISH.search(rec.get('name') or '')
                            or RIVERISH.search(slug.replace('_', ' ')))
                rec['feature_type'] = 'river' if riverish else 'lake'
                rec['feature_type_guessed'] = True
                ft_src['name'] += 1
                ft_named.append(slug)
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
    # ── the merge gate: nothing that was merged away comes back ─────────────────────────
    retired, why = drop_retired(idx, R)
    if why:
        print('!! %s' % why)
    if retired:
        print('merged away, kept out of the index: %d' % len(retired))
        for e in retired:
            print('   %-28s -> %s' % (e['slug'], e['merged_into']))

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

    # ── the scope gate ──────────────────────────────────────────────────────────────────
    #
    # Ryan drew registry/ryans_water.geojson on 2026-08-13 because the card had quietly grown
    # to water a day's drive away: "worrying about lakes / rivers / coastal areas that are a
    # days drive away doesn't make sense to me". This is the ONE place that decision is made.
    # Both uploaders read lake_index.json, so gating here gates the app AND R2 together, and
    # there is no second copy of the rule to fall out of step.
    #
    # It is a FILTER, never a delete: lakes.json stays the whole 3DHP superset, the boundaries
    # and chartpack dirs stay on the drive. Putting a lake back is one line in
    # _ship_keep.txt (or a redrawn polygon), re-run this, re-run the uploaders.
    out_of_region = []
    if not a.no_region:
        a.region_mask = a.region_mask or os.path.join(R, 'region_mask.json')
        region = _sibling_region(a.region_mask)
        if region is None:
            print('\n!! NO region mask at %s -- NOTHING is filtered by scope. Build it:\n'
                  '   py .\\scripts\\make_region_mask.py --poly registry\\ryans_water.geojson'
                  % a.region_mask)
        else:
            keep = set()
            kp = a.ship_keep or os.path.join(R, '_ship_keep.txt')
            if os.path.exists(kp):
                for line in open(kp, encoding='utf-8'):
                    line = line.split('#', 1)[0].strip()
                    if line:
                        keep.add(line)
                print('\n%s: %d slug(s) ship regardless of scope' % (os.path.basename(kp), len(keep)))
            print(region.describe())
            for slug in list(idx):
                if slug in keep:
                    continue
                rec = idx[slug]
                c = rec.get('centroid') or rec.get('center')
                b = rec.get('bounds_wsen') or rec.get('boundsWsen')
                # A centroid can sit on land or in the next county -- Lake Marion's own is
                # 4,160 m outside Lake Marion. Test the BOUNDS corners and midpoints too, and
                # keep the lake if ANY of them lands in scope, which is what makes a border
                # lake a border lake.
                pts = []
                if isinstance(c, (list, tuple)) and len(c) == 2:
                    pts.append((c[0], c[1]))
                if isinstance(b, (list, tuple)) and len(b) == 4:
                    w, so, e, no = b
                    mx, my = (w + e) / 2.0, (so + no) / 2.0
                    pts += [(w, so), (w, no), (e, so), (e, no),
                            (mx, so), (mx, no), (w, my), (e, my), (mx, my)]
                if not pts:
                    continue             # nothing to test -- not ours to drop
                if region.any_inside(pts):
                    continue
                out_of_region.append({'slug': slug, 'name': rec.get('name'),
                                      'state': rec.get('state'),
                                      'area_acres': rec.get('area_acres'),
                                      'why': 'outside %s' % '+'.join(region.states)})
                del idx[slug]

    # ── closed to fishing ───────────────────────────────────────────────────────────────────
    #
    # Ryan, 2026-08-23: *"need to get the lakes that are closed to fishing removed from the
    # pickers"*, and earlier the same day, on finding North Saluda in the research list: *"why is
    # it in the app... how many other lakes am i wasting time extracting, building chartpacks for
    # uploading to r2 then running a research profile on that i can never fish"*.
    #
    # THE VERDICT COMES FROM `_water_notes.json`, WHICH UNTIL NOW NOTHING READ. That file is the
    # settled-facts store -- each water with how it was settled -- and it has carried
    # `fishable: false` on seven waters since 08-23 while the research button went on spending
    # Gemini credits on all of them. A fact nobody reads is a fact nobody has.
    #
    # ACCESS IS NOT INFERRED HERE. Three proxies were tried on 08-23 and all three were wrong on
    # the first case Ryan checked by hand -- PAD-US access (203 of 373 rows carry none), "no ramp
    # in any feed" (90 lakes, and the largest has two public ramps), and Garmin's dock layer
    # (Lake Reidsville charts zero docks and has paved ramps). Only a recorded verdict counts, and
    # every one of these seven has a source written beside it: the Savannah River Site ponds, a
    # Greenville watershed reservoir, a Spartanburg water-supply reservoir, two private waters.
    closed = []
    npath_notes = os.path.join(R, '_water_notes.json')
    notes = {}
    if os.path.exists(npath_notes):
        try:
            notes = json.load(open(npath_notes, encoding='utf-8')) or {}
        except (OSError, ValueError) as exc:
            print('!! could not read _water_notes.json (%s) -- NOTHING was gated on it'
                  % exc.__class__.__name__)

    # SPECIES A WATER DOES NOT HAVE, WHICH IS BIOLOGY AND NOT LAW.
    #
    # `species_absent` moved here on 2026-08-27 out of a hand-typed REGULATIONS table in
    # js/data/species-intel.js that gated legality on SIX of 358 waters. Eleven of its thirteen
    # rows duplicated the parsed books or the live digest and were deleted; these two did not,
    # because no regulations book will ever say "there are no stripers in this lake".
    #
    # IT HAS TO REACH THE ROW OR IT IS THE SAME MISTAKE. That table was read by
    # checkRegulations(); a fact parked in _water_notes.json and never carried onto the index row
    # is a fact nobody has, which is what this file's own comment above says about
    # `fishable: false` sitting unread for weeks.
    absent = 0
    for slug, note in notes.items():
        if slug == '_README' or not isinstance(note, dict):
            continue
        sp = note.get('species_absent')
        if not sp or slug not in idx:
            continue
        idx[slug]['species_absent'] = sorted(sp)
        absent += 1
    if absent:
        print('   %d water(s) carry species_absent from _water_notes.json' % absent)

    if not a.keep_closed:
        for slug, note in notes.items():
            if slug == '_README' or not isinstance(note, dict):
                continue
            if note.get('fishable') is not False:
                continue                 # True, or never settled -- unmeasured is not closed
            rec = idx.pop(slug, None)
            if rec is None:
                continue
            why = ''
            for f in (note.get('facts') or []):
                if 'clos' in f.lower() or 'no fishing' in f.lower() or 'not open' in f.lower():
                    why = f
                    break
            closed.append({'slug': slug, 'name': rec.get('name'), 'state': rec.get('state'),
                           'area_acres': rec.get('area_acres'),
                           'why': why or 'recorded fishable: false in _water_notes.json'})

    # ── no pack, no row ─────────────────────────────────────────────────────────────────────
    #
    # Ryan, 2026-08-13: "the SC_dnr lakes if they do not have a chartpack they need to be
    # removed... we keep repeating the same crap". Recorded here because it kept being
    # rediscovered as an open question.
    #
    # The unbuildable filter above drops a row when the build MEASURED it and refused. It cannot
    # see a row nothing ever tried to build: no pack, no charted entry, no verdict, so
    # `if not C: continue` lets it through. That is how the SCDNR state lakes and the
    # user_known_lakes from js_lists.json -- Lake Cherokee 50 ac, Lake John D. Long 80 ac,
    # Mountain Lake 2 at 7 ac, Webb Center Lakes at 17 ac, Bates Old River -- stayed in the
    # picker with nothing behind them. Garmin never surveyed water that small.
    #
    # "Measured and refused" and "never built" are different sentences with the same verdict.
    by_lake_map = {}
    _tm = os.path.join(R, 'tile_lake_map.json')
    if os.path.exists(_tm):
        try:
            by_lake_map = json.load(open(_tm, encoding='utf-8')).get('by_lake') or {}
        except (OSError, ValueError):
            pass

    # A WATER NOBODY HAS NAMED IS NOT A PICKER ROW.
    #
    # `water_imlm3 (Berkeley Co, SC)` is a real 3DHP polygon, 52 acres, with a real pack on
    # disk -- and a name that is its own slug, because no feed has ever spelled it. Ryan,
    # 2026-08-22: *"just remove the unnamed lakes from registry"*, and again on 08-23 when the
    # count came back as 26: *"all of this can go"*.
    #
    # They survived every existing filter. They have tiles and no `charted` row, so the packless
    # gate below files them under "mapped to tiles and NEVER BUILT -- kept, not dropped; it is
    # owed a build". That is the right rule for a named water and exactly the wrong one here:
    # building them is what would put a machine name in front of him.
    #
    # A FILTER, NEVER A DELETE, like the two gates below it. `lakes.json` keeps all 3,405, the
    # boundaries stay, the packs on disk are untouched -- so the day a feed learns a name for
    # one of these, it comes back on its own with no work.
    unnamed = []
    if not a.keep_unnamed:
        for slug in [s_ for s_ in idx if (idx[s_].get('name') or s_) == s_]:
            rec = idx[slug]
            unnamed.append({'slug': slug, 'name': rec.get('name'), 'state': rec.get('state'),
                            'area_acres': rec.get('area_acres'), 'county': rec.get('county'),
                            'why': 'no feed has ever named this water'})
            del idx[slug]

    # BARELY-SURVEYED WATER IS A PICKER ROW NOBODY WANTS.
    #
    # This block used to only REPORT, under "say the word and they go", because whether 0.04%
    # of a river is worth a row was Ryan's call and not this script's. He said the word on
    # 2026-08-23 -- *"all of this can go"* -- naming the two it had been printing:
    #
    #     south_river          charted 0.0004    400 ac
    #     ogeechee_river_2     charted 0.0038    254 ac
    #
    # The 2% comes from the line that was already printing it, so it is a threshold with
    # provenance rather than one picked tonight. `--min-charted 0` keeps everything.
    #
    # A LITERAL ZERO IS NOT THIS GATE'S JOB -- the unbuildable filter above already drops those,
    # because `if C.get('charted'): continue` treats 0.0 as falsy. This one exists for the
    # non-zero sliver that slips past it, which is why the test is `0 < v < min`.
    thin = []
    if charted and a.min_charted > 0:
        for slug in [s_ for s_ in idx]:
            v = (charted.get(slug) or {}).get('charted')
            if isinstance(v, (int, float)) and 0 < v < a.min_charted:
                rec = idx[slug]
                thin.append({'slug': slug, 'name': rec.get('name'), 'state': rec.get('state'),
                             'area_acres': rec.get('area_acres'), 'charted': v,
                             'why': 'under %.1f%% of the water is charted' % (100 * a.min_charted)})
                del idx[slug]

    packless = []
    if not a.keep_packless:
        pdir = a.packs or os.path.join(os.path.dirname(R.rstrip('\\/')), 'chartpack')
        if not os.path.isdir(pdir):
            print('\n!! no chartpack root at %s -- rows with no pack are NOT being dropped.'
                  % pdir)
        else:
            # A DIRECTORY IS NOT A PACK. `lake_robinson_greer` has a chartpack folder holding
            # exactly one file, water_graph.bin, and an empty {} in charted.json -- so it passed
            # the directory test, passed the unbuildable filter (`if not C: continue` on an
            # empty dict), and reached the picker with nothing to draw. Ryan, 2026-08-13:
            # "no contours should never have made it to this point... they shouldn't even be on
            # the registry".
            #
            # Contours OR depth areas, because the ship rule is bathymetry from either.
            #
            # THIS TEST IS PRESENCE, NOT SOUNDINGS, AND THE TWO WERE CONFLATED HERE.
            #
            # It used to say "51 of the 52 in-scope packs with no contours carry depth areas and
            # are legitimate -- Kannapolis Lake is 90% charted on depth areas alone." That was
            # wrong about Kannapolis and wrong in kind. Measured 2026-08-22 from the card tile,
            # the 21Aug26 tile and the pack written on 08-06 -- all three agree: its only depth
            # areas are five polygons banded 0-1 ft, the shoreline outline Garmin draws around
            # every piece of water whether it sounded it or not, and no contour has a vertex
            # inside the polygon. charted is 0.0 and always was.
            #
            # It read as shipped because build_all_chartpacks carries the previous verdict
            # forward on runs that do not read the layers the verdict is made from, so a stale
            # `shipped: true` rode along until a full pass re-made it. 53 offered rows came out
            # the same way; Ryan checked five by hand and confirmed 0-3 ft bands and no
            # contours: "let them be removed."
            #
            # A pack DIRECTORY holding depth_areas.geojson says only that a file exists. Whether
            # anything was sounded is charted_fraction's question, and it is asked upstream.
            DRAWABLE = ('contours.geojson', 'depth_areas.geojson')
            have = {d for d in os.listdir(pdir)
                    if os.path.isdir(os.path.join(pdir, d))
                    and any(os.path.exists(os.path.join(pdir, d, f)) for f in DRAWABLE)}
            # NEVER OFFERED and NEVER BUILT look identical from here and are not the same
            # thing. A slug in tile_lake_map.by_lake was handed to build_all_chartpacks.py as
            # work; if it has no verdict in charted.json, the build never reached it, and the
            # answer is to build it -- not to drop it.
            #
            # 2026-08-13: lake_robinson_greer (804 ac), lake_john_d_long_sc and
            # lake_cherokee_sc all got boundaries at 08-12 00:50, all sit in by_lake, all have
            # their C tile extracted, and none has a charted entry. Dropping them would have
            # thrown away three lakes that need a 30-second build.
            unbuilt = []
            for slug in list(idx):
                if slug in have:
                    continue
                rec = idx[slug]
                mapped = bool(by_lake_map.get(slug)) if by_lake_map else False
                if mapped and not (charted or {}).get(slug):
                    unbuilt.append(slug)
                    continue                     # keep it; it is owed a build, not a deletion
                packless.append({'slug': slug, 'name': rec.get('name'),
                                 'state': rec.get('state'),
                                 'area_acres': rec.get('area_acres'),
                                 'why': ('pack has neither contours nor depth areas'
                                         if os.path.isdir(os.path.join(pdir, slug))
                                         else 'no chartpack directory')})
                del idx[slug]
            if unbuilt:
                print('\n!! %d row(s) are mapped to tiles and were NEVER BUILT -- kept, not '
                      'dropped:' % len(unbuilt))
                for slug in unbuilt:
                    print('   %-32s tiles %s' % (slug[:32], ','.join(by_lake_map.get(slug) or [])))
                print('   py .\\scripts\\build_all_chartpacks.py ... --only-lakes "%s"'
                      % ','.join(unbuilt))
                print('   then re-run this. If the build refuses them, the unbuildable filter')
                print('   drops them with a reason, which is the honest way for them to go.')

    # ── the gauge bindings, carried the last step ───────────────────────────────────────────
    #
    # `water_bindings.json` has existed since 2026-08-06 and this file has never READ it -- the
    # only mention of it in here is a line of prose in the docstring. So the whole gauge chain
    # (build_lake_rivers -> build_water_bindings -> triage) wrote a file nothing consumed, and
    # `rec['usgs']` came only from curated_lakes.json's five hand-written entries.
    #
    # Measured 2026-08-15, straight after a full chain run that bound 229 waters: the index
    # still read **10 of 456 rows with a gauge, and 0 of 90 rivers**. Exactly the shape of the
    # DNR ramps that morning -- the data existed, the last step did not carry it.
    #
    # THE NWPS BINDINGS CARRY A USGS SITE TOO. 110 of the pool bindings are NWPS-sourced, and
    # the roster cross-references a gauge to its USGS site: Wateree River's pool is CFMS1 and
    # also `usgs_site: 02169750`. So 212 of the 229 can supply the field the app actually
    # reads, 62 of them rivers. Preferring the pool binding over a gauges[] entry matters --
    # pool is the lake's own level, and a gauges[] entry may be a tributary reading.
    #
    # BINDINGS WIN OVER CURATED. The binder already reports `curated_usgs_no_longer_read` for
    # the five lakes whose usgs came from that file, and curated is on the deletion tab as
    # invented data. A derived binding with geometry behind it outranks a hand-typed one.
    wbp = os.path.join(R, 'water_bindings.json')
    if os.path.exists(wbp):
        try:
            _wb = (json.load(open(wbp, encoding='utf-8')) or {}).get('bindings') or {}
        except Exception as _e:
            _wb = {}
            print('\n!! water_bindings.json unreadable (%s) -- no gauges promoted' % _e)
        n_site = n_riv = n_over = 0
        for _slug, _b in _wb.items():
            _rec = idx.get(_slug)
            if not _rec:
                continue
            # THE SHAPE IS {site, params}, NOT A BARE SITE STRING.
            #
            # 2026-08-15, first cut of this block: `_rec['usgs'] = _site`. 212 rows took a
            # string, and every consumer in the app destructures an object --
            # plan-builder.js:1143 `const {site, params} = lakeEntry.usgs`, then
            # `params.includes('00065')`, which on a string is TypeError inside a try/catch
            # that sets usgsHtml = '' and warns to the console. utility-sync.js:181 reads
            # `lkEntry?.usgs?.site`, which is undefined. So the field was populated, the run
            # printed 212, and NOT ONE gauge could render. It also flattened the five curated
            # objects that did work. A file is not the world, and neither is a field.
            #
            # `params` is a server-side filter on the OGC latest-continuous query. The plan
            # panel only renders 00010, so 00010 must be in it or the callout stays empty --
            # curated's `00062` for Marion, Moultrie and Murray is why those three have always
            # shown nothing. The rest are carried because the site reports them and a later
            # renderer should not need this file rebuilt to see them.
            _pool = _b.get('pool') or {}
            _src = None
            if _pool.get('usgs_site'):
                _src = _pool
            else:
                # NOT `next(...)`. The fallback took the FIRST gauges[] entry carrying a usgs
                # site, in list order, and on 2026-08-15 that handed J Strom Thurmond
                # `02194501 LAKE THURMOND TAILRACE NEAR CLARKS HILL` -- a stream gauge below
                # the dam -- while `02193900 THURMOND LAKE NEAR PLUM BRANCH`, site type LK
                # reporting 00062 reservoir elevation, sat second in the same list. The
                # binder had already been taught that first-past-the-post is not a choice;
                # this end of the chain had not.
                _rank_ft = (_rec.get('feature_type') or 'lake')
                _want_type = 'LK' if _rank_ft == 'lake' else 'ST'
                _want_parms = (('00062', '62614', '62615') if _rank_ft == 'lake'
                               else ('00065', '00060'))
                # UNLESS THE WATER IS ITSELF A TAILRACE. `tail_race_canal` is the Cooper's
                # tailrace canal, and penalising the word took it off
                # `LAKE MOULTRIE TAILRACE CANAL AT MONCKS CORNER` -- the gauge named for the
                # exact water the row is -- and onto a branch of the Cooper. A rule about
                # what a name means has to check the name on both sides.
                _self_tail = bool(_TAILRACE_RE.search(
                    '%s %s' % (_rec.get('name') or '', _rec.get('display_name') or '')))

                def _gscore(_g, _i):
                    _nm = str(_g.get('usgs_name') or _g.get('name') or '')
                    _ty = str(_g.get('site_type') or _g.get('usgs_site_type') or '')
                    _pm = _g.get('parms') or _g.get('usgs_parms') or []
                    if isinstance(_pm, str):
                        _pm = [x.strip() for x in _pm.split(',') if x.strip()]
                    return (1 if (_TAILRACE_RE.search(_nm) and not _self_tail) else 0,
                            0 if _ty == _want_type else 1,
                            0 if any(x in _want_parms for x in _pm) else 1,
                            _i)

                _cands = [(g, i) for i, g in enumerate(_b.get('gauges') or [])
                          if g.get('usgs_site')]
                _cands.sort(key=lambda gi: _gscore(gi[0], gi[1]))
                _src = _cands[0][0] if _cands else None
            _site = _src.get('usgs_site') if _src else None
            if not _site:
                continue
            _parms = _src.get('usgs_parms') or _src.get('parms') or []
            if isinstance(_parms, str):
                _parms = [p.strip() for p in _parms.split(',') if p.strip()]
            _keep = [p for p in USGS_USEFUL_PARMS if p in set(_parms)]
            if '00010' not in _keep:
                _keep.insert(0, '00010')
            _val = {'site': _site, 'params': ','.join(_keep)}
            _prev = _rec.get('usgs')
            _prev_site = _prev.get('site') if isinstance(_prev, dict) else _prev
            if _prev_site and _prev_site != _site:
                n_over += 1
            _rec['usgs'] = _val
            n_site += 1
            if _rec.get('feature_type') == 'river':
                n_riv += 1
        _tot = sum(1 for r in idx.values() if r.get('usgs') or r.get('duke') or r.get('dominion'))
        _rivtot = sum(1 for r in idx.values() if r.get('feature_type') == 'river')
        print('\nwater_bindings: %d row(s) took a usgs site from a binding (%d river(s))'
              % (n_site, n_riv))
        if n_over:
            print('   %d of them replaced a curated usgs value -- the binding has geometry '
                  'behind it' % n_over)
        print('   index now: %d of %d rows carry a gauge, %d of %d rivers'
              % (_tot, len(idx), n_riv, _rivtot))
    else:
        print('\n!! %s not beside the registry -- no gauges promoted. Run the gauge chain.' % wbp)

    json.dump(idx, open(a.out, 'w', encoding='utf-8'), indent=1)

    # THE BUILD LIST IS THE INDEX, LESS THE WATERS NOBODY HAS NAMED.
    #
    # `outputs/ship_lakes.txt` was a hand-kept file of 374 slugs, written against a 452-row
    # index. The index went to 401 on 2026-08-22 and the file did not, so the next rebuild
    # would have silently skipped `bates_old_river` -- the row that pass existed to create.
    # A list of what to build is not a fact of its own; it is this index with one rule applied.
    #
    # THE RULE: a row whose `name` is its own slug is a 3DHP polygon that no feed has ever
    # named -- `water_imlm3 (Berkeley Co, SC)`, 52 acres, real water and a real pack on disk.
    # Ryan, 2026-08-22: *"just remove the unnamed lakes from registry"*. They stay in the index
    # because `shipped` is what the picker filters on and they have never been built, but
    # building them is what would put a machine name in front of him.
    if a.ship_list:
        ship = sorted(k for k, v in idx.items() if (v.get('name') or k) != k)
        d = os.path.dirname(a.ship_list)
        if d:
            os.makedirs(d, exist_ok=True)
        with open(a.ship_list, 'w', encoding='utf-8') as fh:
            fh.write('\n'.join(ship) + '\n')
        print('\nbuild list: %d of %d rows are named -> %s'
              % (len(ship), len(idx), a.ship_list))
        unnamed = len(idx) - len(ship)
        if unnamed:
            print('            %d unnamed water(s) held back; they have packs on disk and '
                  'would reach the picker if built' % unnamed)

        # AND THE TILES THAT BUILD LIST ACTUALLY TOUCHES.
        #
        # Ryan, twice: *"why are you having me extract from tiles that we no longer need...
        # this should be capable of being limited to just the tiles that we need for the lakes
        # that we ship now"*. Measured 2026-08-22: the 375 named rows touch 92 tiles, and the
        # extract on disk holds 241. **149 of them, 62%, are decode work nothing ships.**
        #
        # `tile_lake_map.json` already knows which tiles each water sits on -- it is the HARD
        # GATE the pack build clips against -- so this is not a new fact either, it is that
        # file restricted to the build list. Written beside the build list because the two
        # answer the same question at two stages, and a tile list kept anywhere else would go
        # stale the moment the index moved, which is exactly what happened to ship_lakes.txt.
        if a.tile_list:
            tlp = os.path.join(R, 'tile_lake_map.json')
            try:
                _tm = json.load(open(tlp, encoding='utf-8')).get('by_lake') or {}
            except (OSError, ValueError) as e:
                _tm = None
                print('            tile list SKIPPED: cannot read %s (%s)'
                      % (tlp, type(e).__name__))
            if _tm is not None:
                _ids = set()
                _notile = 0
                for _s in ship:
                    _ts = _tm.get(_s)
                    if not _ts:
                        _notile += 1
                        continue
                    for _t in _ts:
                        _t = _t.strip().upper()
                        _ids.add(_t[1:] if _t[:1].isalpha() and len(_t) > 1 else _t)
                d2 = os.path.dirname(a.tile_list)
                if d2:
                    os.makedirs(d2, exist_ok=True)
                with open(a.tile_list, 'w', encoding='utf-8') as fh:
                    fh.write('\n'.join(sorted(_ids)) + '\n')
                print('tile list:  %d tile(s) carry those %d water(s) -> %s'
                      % (len(_ids), len(ship), a.tile_list))
                if _notile:
                    # Never silent. A water with no tile row is one the pack build cannot
                    # clip either -- tile_lake_map is the hard gate.
                    print('            %d of them have NO row in tile_lake_map.json and were '
                          'not counted; the pack build cannot clip those either' % _notile)

    if unnamed:
        rpu = os.path.join(R, '_index_unnamed.json')
        json.dump(unnamed, open(rpu, 'w', encoding='utf-8'), indent=1)
        print('\ndropped %d row(s) no feed has ever named:' % len(unnamed))
        for d in sorted(unnamed, key=lambda d: -(d.get('area_acres') or 0))[:6]:
            print('   %-34s %-3s %8s ac' % ((d.get('slug') or '')[:34],
                                            d.get('state') or '',
                                            ('%.0f' % d['area_acres']) if d.get('area_acres')
                                            else '?'))
        print('   -> %s   (--keep-unnamed to retain them)' % rpu)
        print('   lakes.json, the boundaries and the chartpack dirs are UNTOUCHED. A feed that')
        print('   learns a name for one of these puts it back with no work.')

    if packless:
        rp3 = os.path.join(R, '_index_packless.json')
        json.dump(packless, open(rp3, 'w', encoding='utf-8'), indent=1)
        print('\ndropped %d row(s) with nothing to draw:' % len(packless))
        for d in sorted(packless, key=lambda d: -(d.get('area_acres') or 0))[:8]:
            print('   %-34s %-3s %8s ac' % ((d.get('name') or d['slug'])[:34],
                                            d.get('state') or '',
                                            format(int(d.get('area_acres') or 0), ',')))
        print('   -> %s   (--keep-packless to retain them)' % rp3)
    if thin:
        rpt = os.path.join(R, '_index_thin.json')
        json.dump(thin, open(rpt, 'w', encoding='utf-8'), indent=1)
        print('\ndropped %d row(s) with under %.1f%% of the water charted:'
              % (len(thin), 100 * a.min_charted))
        for d in sorted(thin, key=lambda d: d['charted'])[:10]:
            print('   %-32s charted %.4f  %s ac'
                  % (d['slug'][:32], d['charted'], format(int(d.get('area_acres') or 0), ',')))
        print('   -> %s   (--min-charted 0 to keep them)' % rpt)

    if closed:
        rpc = os.path.join(R, '_index_closed.json')
        json.dump(closed, open(rpc, 'w', encoding='utf-8'), indent=1)
        print('\ndropped %d row(s) recorded as closed to fishing:' % len(closed))
        for d in sorted(closed, key=lambda d: -(d.get('area_acres') or 0)):
            print('   %-38s %-3s %8s ac' % ((d.get('name') or d['slug'])[:38],
                                            d.get('state') or '',
                                            format(int(d.get('area_acres') or 0), ',')))
        print('   -> %s   (--keep-closed to retain them)' % rpc)
        print('   the verdicts are in registry/_water_notes.json, each with how it was settled.')
        print('   lakes.json, the boundaries and the chartpack dirs are UNTOUCHED.')

    if out_of_region:
        rp2 = os.path.join(R, '_index_out_of_region.json')
        json.dump(out_of_region, open(rp2, 'w', encoding='utf-8'), indent=1)
        big = sorted(out_of_region, key=lambda d: -(d.get('area_acres') or 0))[:6]
        print('\ndropped %d row(s) as out of scope. Biggest:' % len(out_of_region))
        for d in big:
            print('   %-38s %-3s %10s ac' % ((d.get('name') or d['slug'])[:38], d.get('state') or '',
                                             format(int(d.get('area_acres') or 0), ',')))
        print('   -> %s' % rp2)
        print('   lakes.json, the boundaries and the chartpack dirs are UNTOUCHED. This is a')
        print('   shipping filter. Add a slug to _ship_keep.txt and re-run to put one back.')
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
    print('feature_type: ' + ', '.join('%s %d' % kv for kv in sorted(ft_counts.items())))
    print('   decided by: record %d, 3DHP featuretype %d, 3DHP boundary %d, coast_ prefix %d, '
          'NHD FType %d, GUESSED FROM NAME %d'
          % (ft_src['record'], ft_src['3dhp_type'], ft_src['boundary'], ft_src['slug_prefix'],
             ft_src['nhd'], ft_src['name']))
    if ft_named:
        print('   guessed rows carry "feature_type_guessed": true -- %s%s'
              % (', '.join(sorted(ft_named)[:6]), ' ...' if len(ft_named) > 6 else ''))
    print('')

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
    # The "curated fields carried over" report is gone with the fields. It printed
    # `usgs 5 lakes / duke 4 / dominion 2 / normalPool 3 / minPool 3` on every run, which read
    # as five live dependencies and was, by 2026-08-15, five dead ones and no live one.

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
        # A KEY THAT DID NOT MATCH HERE IS NOT EVIDENCE OF ANYTHING -- 2026-08-23.
        #
        # This used to print every unmatched key, thirty-two of them, under "stale, or for a
        # list this script no longer reads". That reads like thirty-two dead rows and it is
        # not: `lake_aliases.json` is read by SIX scripts and only the curated-entry pass in
        # this one went quiet, when the two hardcoded JS lists were deleted on 2026-08-22.
        # Measured that night against the live files:
        #
        #     42 keys, 0 broken -- every one points at a real registry slug
        #     32 point at a water the app offers, 10 at a real water it does not
        #     35 of the 42 are spelled by an actual ramp feed, so they are firing
        #
        # The ten that point at a non-offered water are FINE. The ramp and name binders work
        # over `lakes.json`, the 3,405-water superset across fifteen states, not this 401-row
        # index -- so "not in the index" is the wrong question to ask of them.
        #
        # THE REAL DEFECT CLASS IS A TARGET THAT IS NOT A SLUG AT ALL, and it is checked here
        # for every key rather than only for the ones a curated name happened to hit. That
        # gating was the bug: an alias nobody matched could point at nothing and never be seen.
        all_slugs = {x['slug'] for x in reg['lakes'] if isinstance(x, dict) and x.get('slug')}
        broken = sorted((k, v) for k, v in aliases.items() if v not in all_slugs)
        offered = sum(1 for v in aliases.values() if v in idx)
        print('\nalias file: %d key(s), %d matched a curated name in THIS run'
              % (len(aliases), len(alias_hit)))
        if broken:
            print('   %d point at a slug that DOES NOT EXIST -- these bind to nothing and '
                  'suppress the positional matcher too:' % len(broken))
            for k, v in broken:
                print('      %-34s -> %s' % (k[:34], v))
        else:
            print('   0 broken: every target is a real registry slug (%d offered by the app, '
                  '%d real waters it does not offer)' % (offered, len(aliases) - offered))
        if alias_dead:
            print('   %d matched a curated name but resolved outside the index, so the '
                  'positional matcher was suppressed for nothing:' % len(alias_dead))
            for k, v in sorted(alias_dead.items()):
                print('      %-34s -> %s' % (k[:34], v))
        if len(alias_hit) < len(aliases):
            print('   %d matched nothing HERE, which is expected -- build_dnr_ramps_by_lake, '
                  'build_water_names, remove_registry_water, suggest_name_aliases and '
                  'uncharted_report read this same file. Do not cut a row on this line.'
                  % (len(aliases) - len(alias_hit)))

    if charted:
        sh = [v for v in idx.values() if v.get('shipped')]
        print('\ncharted: %d shipped, %d measured-and-empty, %d never measured'
              % (len(sh),
                 sum(1 for v in idx.values() if v.get('charted') == 0),
                 sum(1 for v in idx.values() if v.get('charted') is None)))
    print('\n-> %s' % a.out)


if __name__ == '__main__':
    main()
