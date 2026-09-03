#!/usr/bin/env python3
r"""build_water_names.py - the names a water answers to, harvested from the live feeds.

Personal use only, not for distribution or resale; not for navigation.

    py .\build_water_names.py --registry F:\TrollMapPipeline\registry
    # ... prints what it would write and changes nothing. Then --go.

WHY THIS EXISTS

Three hardcoded lists used to supply the extra names a water answers to:

    js/data/scdnr-state-lakes.js    16 entries
    js/data/user-known-lakes.js      4 entries
    registry/curated_lakes.json     the old LAKE_DB

Between them they contributed 40 extra names, 5 notes and NOT ONE WATER -- every index row
they tagged already carried `3dhp`. Ryan, 2026-08-22, on being offered a fourth hand-written
file to replace them: "i don't want them to die by extracting the info and moving it somewhere
else... it needs to be an automated process that can grow or shrink on its own."

THE SOURCE WAS ALREADY THERE. Every ramp record in the four `*_ramps_by_lake.json` files
carries `wb`, the name the AGENCY uses for the water it attached that ramp to, and those files
are already keyed by registry slug and already rebuilt from the live feeds:

    thicketty_creek_wcd_lake_number_26   wb "Lake Thicketty"
    edgar_a_brown_lake                   wb "Lake Edgar Brown"
    wittee_lake                          wb "Wee Tee Lake"

3DHP calls the first of those "Thicketty Creek WCD Lake Number 26". SCDNR calls it Lake
Thicketty, and SCDNR is who put the ramp there. So: a water answers to every distinct `wb` any
feed attached to it. Add a ramp to the feed and the name appears; drop it and the name goes.

WHAT IT REFUSES TO WRITE, and why each rule is here

  * a name that normalises to the row's OWN name -- "Lowthers Lake" on `lowthers_lake` is not
    an extra name, it is the name, and consolidate already emits it.
  * a name that normalises to ANOTHER registry row's name. This is the guard that matters:
    `'High Falls Lake, GA'` once resolved to `falls_lake` in NORTH CAROLINA because a mapping
    was removed and the name RE-POINTED rather than dying. A feed name that could land on a
    second water is worse than no name at all.
  * the tributary half of a composite `wb`. The national feed writes "Tributary - Waterbody"
    -- "Turkey Creek - Lake Edgar A. Brown", "Byrd Spring Branch - Cherokee Lake" -- and only
    the LAST segment names the water. Keeping both halves made `badin_lake` answer to "Gar
    Creek" and `boyle_lake_number_five` answer to "Fox Lake", which is the wrong-water bug
    arriving by a new road. The whole string is kept as well, since that is what the feed
    prints and someone may have it saved.
  * a STREAM name offered to a LAKE. Some feeds put the tributary in `wb` outright, with no
    composite to split -- `badin_lake` was offered "Gar Creek", `belews_lake` "Belews Creek",
    `cherokee_lake` "South Fork Holston River". A lake does not answer to a creek's name. The
    test uses 3DHP's own `feature_type` on the row, so a water that IS a river or a canal still
    accepts a river name, and no list of exceptions is needed.
  * a name shorter than four characters.
  * A NAME CARRIED BY A RAMP THAT IS NOT ON THAT WATER. The record has always held `lat` and
    `lon` beside the `wb` this file reads -- all 2,979 of them do -- and until 2026-09-03
    nothing looked at them, so a ramp 475 m away donated its name exactly as readily as one on
    the bank. That is how `murder_creek_lake` came to answer to Dairy Lake, Lake Bennett AND
    Lake Margery: three separate ponds at the Charlie Elliott Wildlife Center whose ramps all
    bound to one 83-acre polygon. Ryan checked the whole cluster by eye and settled it -- Murder
    Creek Lake IS also Bennett Lake, and Lake Margery is BOYLE MURDER LAKE, the pond next door.

    THE DISTANCE IS MEASURED, NOT PICKED. Across the 180 (water, name) pairs this file keeps,
    ranked by the closest ramp that donates each name, there is an empty band: every correct
    alias is within 108 m (Randy Poynter Lake on Black Shoals Reservoir, the furthest), and
    every wrong one starts at 133 m (Horseshoe 3 Lake on Horseshoe Four). Ten pairs sit above
    it and all ten are wrong -- six of them confirmed by Ryan on the map, the other four being
    Douglas Reservoir on the Holston 19 km away, Lake Louise on Hartwell, a tailrace on Lake
    James, and Lake Woody on Sands Pond. So the gate sits at 120 m, inside the empty band.

    Distance is to the whole boundary, every part of it, NOT to the largest ring. Measuring
    against the biggest part alone put ramps on the far arms of Thurmond 25 km from "their own"
    lake and would have thrown away Clarks Hill Lake, which is that reservoir's real name.

Output `registry/_feed_names.json` is GENERATED -- leading underscore, same as every other
derived registry file. Do not hand-edit it. A genuine naming disagreement that no feed carries
belongs in `lake_aliases.json`, which is hand-held on purpose and stays small.
"""
from __future__ import annotations
import argparse, json, os, re, sys
from collections import defaultdict

# A FIFTH FEED, 2026-09-02. `ncpaws_access_by_lake.json` is written by
# build_nc_species_by_lake.py from NC WRC's fishing-areas app, and its records carry `wb` --
# the agency's own name for the water -- exactly like the other four. It is the feed that knows
# North Carolina calls back_creek_lake "LAKE LUCAS", which is the name on the ramp sign, on the
# Asheboro Parks & Recreation page and in every fishing report. Leaving it out would have made
# this list the one place a new source has to be remembered, which is what the file's own
# docstring says it exists to stop.
FEEDS = ('dnr_ramps_by_lake.json', 'natl_ramps_by_lake.json',
         'osm_ramps_by_lake.json', 'dnr_paddle_by_lake.json',
         'ncpaws_access_by_lake.json')
MIN_LEN = 4
# Metres from the water's boundary. See the docstring: the empty band is 108 m to 133 m.
ON_WATER_M = 120.0
# Whole trailing word, never a substring -- "Creekside Lake" is a lake.
STREAMISH = re.compile(r'\b(creek|branch|river|run|fork|brook|slough|canal|ditch|prong|swamp)$',
                       re.I)
LAKEISH = ('lake', 'reservoir', 'pond', 'impoundment')


def norm(s):
    """Match on the whole normalised string, never a substring -- plain substring matching
    cannot be made safe and this repo has paid for it five times."""
    s = re.sub(r'\([^)]*\)', ' ', s or '')
    s = re.sub(r',\s*[A-Za-z]{2}(\s*/\s*[A-Za-z]{2})*\s*$', ' ', s)
    return re.sub(r'[^a-z0-9]+', ' ', s.lower()).strip()


def load_boundaries(bdir, slugs):
    """{slug: geometry} for the slugs offered a name, with EVERY part unioned.

    Returns {} and says so when shapely is missing, which turns the distance gate off rather
    than failing the build -- the other three guards still run.
    """
    try:
        from shapely.geometry import shape
        from shapely.ops import unary_union
    except ImportError:
        print('  !! shapely is not installed -- the on-water gate is OFF for this run')
        return {}
    out = {}
    for s in sorted(slugs):
        p = os.path.join(bdir, '%s.geojson' % s)
        if not os.path.exists(p):
            continue
        try:
            g = json.load(open(p, encoding='utf-8'))
            feats = g.get('features') or [g]
            gs = [shape(f['geometry']) for f in feats if f.get('geometry')]
            if gs:
                out[s] = unary_union(gs)
        except Exception as exc:
            print('  !! %s unreadable (%s) -- not gated' % (os.path.basename(p),
                                                            type(exc).__name__))
    return out


def metres_off(geom, lat, lon):
    """Distance from a ramp to the water's boundary, or None when it cannot be measured."""
    if geom is None or lat is None or lon is None:
        return None
    from shapely.geometry import Point
    return geom.distance(Point(lon, lat)) * 111000.0


def load_index(reg):
    d = json.load(open(os.path.join(reg, 'lake_index.json'), encoding='utf-8'))
    rows = d if isinstance(d, list) else (d.get('lakes') or list(d.values()))
    if isinstance(rows, dict):
        rows = list(rows.values())
    return {r['slug']: r for r in rows if isinstance(r, dict) and r.get('slug')}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--out', help='defaults to <registry>/_feed_names.json')
    ap.add_argument('--go', action='store_true', help='actually write. Default is a dry run.')
    ap.add_argument('--boundaries', default=None,
                    help='folder of <slug>.geojson; defaults to <registry>/boundaries')
    a = ap.parse_args()
    reg = a.registry
    out_fp = a.out or os.path.join(reg, '_feed_names.json')

    idx = load_index(reg)
    # THE ROW'S OWN NAME ONLY -- deliberately NOT `legacy_display_names`.
    #
    # That field is the OUTPUT: it is where the hardcoded lists inject the very names this
    # script exists to recover. Filtering against it made the first run refuse "Lake Thicketty"
    # as "already known" because scdnr-state-lakes.js had already put it there, so deleting the
    # list would have deleted the name and only a SECOND run would have brought it back. A
    # filter built from its own output cannot be trusted the first time it matters.
    owner = {}
    for s, r in idx.items():
        for cand in (r.get('name'), r.get('display_name')):
            n = norm(cand)
            if n:
                owner.setdefault(n, set()).add(s)

    # Read once to learn which slugs are offered anything, so only those boundaries load.
    offers = []
    seen_feeds = 0
    for f in FEEDS:
        p = os.path.join(reg, f)
        if not os.path.exists(p):
            print('  !! %s missing -- skipped' % f)
            continue
        seen_feeds += 1
        d = json.load(open(p, encoding='utf-8'))
        for slug, recs in d.items():
            for rec in recs or []:
                wb = (rec.get('wb') or '').strip()
                if wb:
                    offers.append((slug, wb, rec.get('lat'), rec.get('lon')))
    if not seen_feeds:
        sys.exit('no ramp files found in %s -- run the ramp builders first' % reg)

    bdir = a.boundaries or os.path.join(reg, 'boundaries')
    geoms = load_boundaries(bdir, {s for s, _, _, _ in offers if s in idx})

    found = defaultdict(set)
    closest = {}                      # (slug, name) -> metres from the nearest ramp saying it
    off_water = 0
    no_shape = set()
    for slug, wb, lat, lon in offers:
        d = metres_off(geoms.get(slug), lat, lon)
        if d is None:
            if slug in idx and geoms:
                no_shape.add(slug)
        elif d > ON_WATER_M:
            # The ramp that carries this name is not on this water. Its name is about the
            # water it IS on, and that water is somebody else's row or nobody's.
            off_water += 1
            continue
        parts = [x.strip() for x in re.split(r'\s+-\s+', wb)]
        # LAST segment only. The earlier ones are the tributary the ramp is on.
        cands = [parts[-1], wb] if len(parts) > 1 else [wb]
        for cand in cands:
            if len(cand) >= MIN_LEN:
                found[slug].add(cand)
                k = (slug, cand)
                if d is not None and d < closest.get(k, 9e9):
                    closest[k] = d
    if off_water:
        print('  gate: %d ramp record(s) named a water they are more than %.0f m from'
              % (off_water, ON_WATER_M))
    if no_shape:
        print('  gate: %d shipped slug(s) have no boundary here -- NOT gated: %s'
              % (len(no_shape), ', '.join(sorted(no_shape)[:6])))

    keep, why = {}, defaultdict(int)
    for slug, cands in found.items():
        if slug not in idx:
            why['slug not in the index'] += len(cands)
            continue
        for cand in sorted(cands):
            n = norm(cand)
            who = owner.get(n) or set()
            ft = (idx[slug].get('feature_type') or '').lower()
            if slug in who:
                why['already the water\'s own name'] += 1
            elif who:
                why['would collide with another water'] += 1
            elif ft in LAKEISH and STREAMISH.search(n):
                why['stream name offered to a lake'] += 1
            else:
                keep.setdefault(slug, []).append(cand)
                owner.setdefault(n, set()).add(slug)

    keep = {s: sorted(set(v)) for s, v in keep.items()}
    n_names = sum(len(v) for v in keep.values())
    print('%d feed file(s); %d slugs offered %d candidate name(s)'
          % (seen_feeds, len(found), sum(len(v) for v in found.values())))
    for k in sorted(why):
        print('   refused, %-32s %d' % (k + ':', why[k]))
    print('   KEPT %d name(s) across %d water(s)' % (n_names, len(keep)))

    if not a.go:
        # THE DIFF, NOT THE OUTPUT. This used to list twelve of the 108 waters it keeps and say
        # "96 more", which is 297 names to read to find the handful that moved. Ryan, looking at
        # exactly that: "and i am supposed to look at 297 names across 108 waters... right..."
        # A dry run exists to be read before the write, so it prints what would CHANGE.
        before = {}
        if os.path.exists(out_fp):
            try:
                before = json.load(open(out_fp, encoding='utf-8'))
            except Exception as exc:
                print('  !! %s unreadable (%s) -- showing everything instead of the change'
                      % (os.path.basename(out_fp), type(exc).__name__))
                before = None
        if before is None or not before:
            for s in sorted(keep)[:12]:
                print('      %-38s %s' % (s, keep[s]))
            if len(keep) > 12:
                print('      ... %d more' % (len(keep) - 12))
            print('\nDRY RUN -- nothing written. Add --go.')
            return 0
        after = {s: sorted(set(v)) for s, v in keep.items()}
        gone, came = 0, 0
        for slug in sorted(set(before) | set(after)):
            was, now = set(before.get(slug) or []), set(after.get(slug) or [])
            if was == now:
                continue
            print('   %s' % slug)
            for nm in sorted(was - now):
                print('       - %s' % nm)
                gone += 1
            for nm in sorted(now - was):
                print('       + %s' % nm)
                came += 1
        if not gone and not came:
            print('\n   no change against %s' % os.path.basename(out_fp))
        else:
            print('\n   %d name(s) would come off, %d would go on, across %d water(s)'
                  % (gone, came, sum(1 for s in set(before) | set(after)
                                     if set(before.get(s) or []) != set(after.get(s) or []))))
        print('\nDRY RUN -- nothing written. Add --go.')
        return 0

    body = {s: sorted(v) for s, v in sorted(keep.items())}
    with open(out_fp, 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(body, fh, indent=1, ensure_ascii=False)
        fh.write('\n')
    print('-> %s' % out_fp)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
