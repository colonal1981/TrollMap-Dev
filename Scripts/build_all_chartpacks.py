#!/usr/bin/env python3
"""build_all_chartpacks.py - cut every registry lake out of the per-tile extract, in one pass.

Personal use only, not for distribution or resale; not for navigation.

PowerShell:

    py .\\build_all_chartpacks.py `
       --extract  "F:\\TrollMapPipeline\\extract" `
       --registry "F:\\TrollMapPipeline\\registry" `
       --map      "F:\\TrollMapPipeline\\registry\\tile_lake_map.json" `
       --out      "F:\\TrollMapPipeline\\chartpack" `
       --report   "F:\\TrollMapPipeline\\registry\\charted.json"

WHY TILE-MAJOR AND NOT LAKE-MAJOR

The obvious loop is `for lake: for tile in lake.tiles: read`. With 1,551 lakes over 143 tiles
that re-reads and re-parses the same gzipped tile files roughly 2,000 times, at seconds each.
It is hours of work to produce the same answer.

So iterate TILES on the outside. Each tile's layers are read and parsed exactly ONCE, then
every lake sitting on that tile is cut from what is already in memory. 143 reads, not 2,000.

The cost is that a lake spanning more than one tile cannot be written until its last tile has
been seen. That is only 88 of 1,551 lakes, so those are held in memory and flushed at the end;
the other 1,463 are written the moment their single tile is done and freed immediately.

RYAN'S RULE, 2026-08-02: "i want a list of lakes with contours... if it has contours i can
fish it." So a lake with no soundings gets no chartpack. It is still REPORTED, with
`charted: 0`, because "we looked and there is nothing" and "we never looked" are different
facts and the lake index has to be able to tell them apart.

`charted` is a FRACTION of the lake's own surface, never a flag -- Garmin's coverage is
partial within a lake. Wee Tee is three connected basins with the middle one unsurveyed.
"""
import argparse, json, math, os, sys, time
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_chartpack import (LakeMask, BboxMask, build_mask, read_fc, verts, SHIP, NOTE,
                             DROP, redp, _rings, collapse_ramps,
                             clip_excluded, trim_geometry, split_multi)   # noqa: E402

# Which layers decide "is this lake charted". DEPTH AREAS, not contours -- see
# LakeMask.charted_fraction for why counting contour vertices reported 0.66 for a fully
# surveyed Wateree and never exceeded 0.95 on any lake.
CHARTED_LAYERS = ('depth_areas',)

# THE LAYERS A FEATURE CAN ONLY BELONG TO ONE OF.
#
# Bathymetry describes a specific body of water, so a contour that two lakes both claim is one
# lake's line lying in the other's 250 m collar. Points are the opposite: a ramp or a dock
# genuinely sits just off the bank and the collar is there to catch it, so `pois`, `docks` and
# `shoreline` stay shared and are not resolved.
OWNED_LAYERS = ('contours', 'depth_areas')

# Line layers that get the blown-out-segment test. Polygons are exempt: a subdivision-sized
# ring is legitimately kilometres around, and the extractor's A1/A2 filters already cover them.
LINE_LAYERS = ('contours', 'hydrography', 'shoreline')

# Judged against the lake ITSELF, not the lake plus --buffer-m. Bathymetry belongs in
# water. Point layers are deliberately absent: the buffer is doing real work there,
# because a dock or a ramp really does sit just off the bank.
CORE_ONLY_LAYERS = ('contours', 'depth_areas')


# ── Garmin ships every lake at six levels of detail ──────────────────────────
#
# `zoom` is a DETAIL LEVEL, not extra survey. Garmin stores the same water at
# 0 (finest) through 5 (crudest overview), and the packs were shipping all of them
# stacked on top of each other for the app to draw at once. Measured on Moultrie:
#
#     contours          zoom 0:13389  1:6853  2:348  3:306  4:24  5:36
#     depth_areas       zoom 0:11963  1:4883  2:702  3:421  4:41  5:42
#     garmin_shoreline  zoom 0:658    1:411   2:505  3:198  4:54
#
# A coarse level is a generalisation: it cuts corners, merges depth bands and bulges
# past the true shoreline, because that is what an overview is for. Drawn together
# with zoom 0 it reads as blocky polygons with no contours under them, depths that
# contradict their surroundings, and shapes sitting on land -- which is exactly what
# Ryan reported on Moultrie: a "24-36 ft" polygon over water the fine contours read
# at 39-49.
#
# The pipeline already knew Garmin does this. See the ramp-label collapse further
# down: "Garmin repeats a ramp label once per zoom level". That fix was written for
# ramps and never applied to bathymetry.
#
# Keeping zoom 0 alone is safe, and measured rather than assumed: it covers 99.6% of
# Moultrie's extent and 97.7-97.9% of Wateree's. What it misses is edge slivers --
# 147 cells out of 32,682 on Moultrie.
#
# Features with no `zoom` property are kept untouched.
# 'shoreline' is the SHIP KEY; 'garmin_shoreline' is its output FILENAME. The loop below
# tests the key, so the filename never matched and this filter has never once run on the
# shoreline layer -- four of five cleaned, one silently skipped. It shipped as blue lines
# scattered over dry land: zoom 0 is 0.0% on land, zooms 1-5 are 22-48%.
# See HYDROGRAPHY_IS_NOT_CREEKS_2026-08-06.md.
ZOOM_LAYERS = ('contours', 'depth_areas', 'shoreline', 'hydrography', 'waterbody')


def keep_zoom(feats, level):
    """Drop detail levels other than `level`. Returns (kept, dropped)."""
    out, dropped = [], 0
    for f in feats:
        z = (f.get('properties') or {}).get('zoom')
        if z is None or z == level:
            out.append(f)
        else:
            dropped += 1
    return out, dropped

def max_segment_m(coords):
    mx = 0.0
    for (x1, y1), (x2, y2) in zip(coords, coords[1:]):
        m = math.hypot((y2 - y1) * 111320.0,
                       (x2 - x1) * 111320.0 * math.cos(math.radians(y1)))
        if m > mx:
            mx = m
    return mx


def drop_long_segments(feats, limit_m):
    """Remove individual features carrying an impossible segment.

    WHAT THE EXTRACTOR'S `SUSPECT` FLAG ACTUALLY MEANT. It condemns a whole tile when any
    segment exceeds 5 km or the median step leaves 6-20 m, and 28 B tiles plus 7 C tiles
    tripped it -- which reads like a third of the card is broken. Measured, it is not:

        C4E09F   23,621 features,   6 with a >2 km segment   (0.025%)
        C4E0E0  136,472 features,   8 with a >2 km segment   (0.006%)
        C4E0FC  137,831 features,   0                        (clean tile, for comparison)

    Every suspect tile still closes at 100.00% with a 5.6-9.5 m median step and 99%+ tag
    alignment. The problem is a handful of individual FEATURES, not the tiles, so the fix
    belongs here rather than in another extraction pass.

    2 km, not the extractor's 5 km: the clean reference tile's longest segment anywhere is
    1.05 km and that is open coastal water, while the strays run 3.5-16 km. Contours follow
    terrain at a ~7.4 m median step, so nothing legitimate lives in between.
    """
    out, n = [], 0
    for f in feats:
        g = f.get('geometry') or {}
        if g.get('type') == 'LineString' and max_segment_m(g.get('coordinates') or []) > limit_m:
            n += 1
            continue
        out.append(f)
    return out, n


def feature_span_deg(coords):
    """Bounding-box diagonal of one feature, in degrees."""
    xs = ys = None
    st = [coords]
    while st:
        x = st.pop()
        if not x:
            continue
        if isinstance(x[0], (int, float)):
            if xs is None:
                xs = [x[0], x[0]]; ys = [x[1], x[1]]
            else:
                if x[0] < xs[0]: xs[0] = x[0]
                if x[0] > xs[1]: xs[1] = x[0]
                if x[1] < ys[0]: ys[0] = x[1]
                if x[1] > ys[1]: ys[1] = x[1]
        else:
            st.extend(x)
    if xs is None:
        return 0.0
    return math.hypot(xs[1] - xs[0], ys[1] - ys[0])


def drop_oversized_lines(feats, bounds_wsen, layer):
    """Drop line features longer than the lake they were clipped to.

    THE SEGMENT TEST CANNOT SEE THESE. drop_long_segments() measures the longest single
    hop between consecutive vertices, which catches a line that TELEPORTS. It cannot catch
    a line that WANDERS: Parr Shoals' worst contour has a maximum segment of about 210 m,
    comfortably inside the 2 km limit, and spans 0.51 deg end to end -- roughly 35 miles
    across a reservoir 0.13 deg wide.

    They survive because the mask keeps a feature when ANY vertex falls inside the lake.
    A contour that dips into the water and trails off across three counties satisfies that
    and is written whole. Measured 2026-08-04 on the shipped packs:

        parr_shoals_reservoir    6 contours longer than the lake, worst 3.8x
        monticello_reservoir    12 contours longer than the lake, worst 4.8x
        lake_marion, lake_murray, wateree_lake, lake_norman, hartwell_lake ... 0

    This is what "spaghetti all over the place" looks like from the app.

    The threshold is the lake's OWN diagonal -- no tuned constant, and it scales itself:
    Lake Murray's longest legitimate contour is 0.30 deg against a 0.50 deg lake and stays,
    while Parr's 0.51 deg against 0.13 deg goes. A contour cannot be longer than the water
    it describes.
    """
    if not bounds_wsen or len(bounds_wsen) != 4:
        return feats, 0
    w, s_, e, n = bounds_wsen
    diag = math.hypot(e - w, n - s_)
    if diag <= 0:
        return feats, 0
    out, dropped = [], 0
    for f in feats:
        g = f.get('geometry') or {}
        if g.get('type') in ('LineString', 'MultiLineString') \
           and feature_span_deg(g.get('coordinates') or []) > diag:
            dropped += 1
            continue
        out.append(f)
    return out, dropped

def _slug_list(src):
    """Parse a --only-* value: a comma list, an @file, or a bare path to a file.

    The bare-path form exists because `@file` is a PowerShell landmine -- `@"` opens a
    here-string, so `--only-lakes @"F:\\path\\x.txt"` dies with
    "No characters are allowed after a here-string header". Ryan hit it 2026-08-03. Single
    quotes work, but a flag that needs shell trivia to use is a flag that gets used wrong, so
    accept the path with or without the @.
    """
    src = (src or '').strip()
    if src.startswith('@'):
        src = src[1:]
    if os.path.exists(src):
        src = ','.join(l.strip() for l in open(src, encoding='utf-8') if l.strip())
    return {x.strip() for x in src.replace('\n', ',').split(',') if x.strip()}


def owned_inside(slug, meta, registry, _cache={}):
    """Ring sets of every water that owns a boundary and sits inside this COASTAL zone.

    Returns () for a lake, which is the whole point: a lake does not swallow anything, and a
    lake inside a lake is a merge question rather than a masking one.

    Bounding boxes decide who is even a candidate, off lakes.json, so a zone does not read 432
    boundary files to discover that 429 of them are three states away. Only the survivors are
    loaded, and they are cached because the same reservoir can fall inside two zones -- the
    Cooper is inside both coast_charleston_sc and coast_cape_romain_sc.
    """
    if not slug.startswith('coast_'):
        return ()
    zb = (meta.get(slug) or {}).get('bounds_wsen')
    if not (isinstance(zb, (list, tuple)) and len(zb) == 4):
        return ()
    out = []
    for s, rec in meta.items():
        if s == slug or s.startswith('coast_'):
            continue
        b = rec.get('bounds_wsen')
        if not (isinstance(b, (list, tuple)) and len(b) == 4):
            continue
        if b[2] < zb[0] or zb[2] < b[0] or b[3] < zb[1] or zb[3] < b[1]:
            continue
        if s not in _cache:
            _cache[s] = load_boundary(registry, s)
        if _cache[s]:
            out.append(_cache[s])
    return out


def load_boundary(registry, slug):
    fp = os.path.join(registry, 'boundaries', slug + '.geojson')
    if not os.path.exists(fp):
        return None
    try:
        gj = json.load(open(fp, encoding='utf-8'))
    except Exception:
        return None
    # EVERY part, not just the first.
    #
    # This read `gj['features'][0]['geometry']` until 2026-08-03. 3DHP splits a lake into one
    # Feature per part -- Lake Marion has 4, Lake Barkley has 20 -- and the parts are in no
    # particular order, so `features[0]` is whichever fragment 3DHP happened to emit first.
    #
    # For Lake Marion that fragment is 0.006 x 0.009 degrees. The lake is 0.492 x 0.364. The
    # clip therefore ran against roughly 1/3400th of the water and found NOTHING: 80,199 acres,
    # the largest lake in South Carolina, came back with counts={} and was recorded as
    # "no contours" while its neighbour Moultrie -- same tiles -- returned 20,956.
    #
    # 24 lakes in the four-state registry are affected. 18 vanished entirely; 6 shipped packs
    # built from one part, including J. Strom Thurmond (3 parts, the used one 43x too small)
    # and Hartwell. Their `charted` fractions look healthy because the fraction is measured
    # against the fragment's own area -- a fragment is fully surveyed by its own standard.
    geoms = ([f.get('geometry') for f in (gj.get('features') or [])]
             if gj.get('type') == 'FeatureCollection'
             else [gj.get('geometry') or gj])
    r = [ring for g in geoms if g for ring in _rings(g)]
    return r or None


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--extract', required=True)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--map', required=True, help='tile_lake_map.json')
    ap.add_argument('--out', required=True)
    ap.add_argument('--report', required=True, help='charted.json to write')
    ap.add_argument('--buffer-m', type=float, default=250.0)
    ap.add_argument('--states', default='SC,NC,GA,TN')
    ap.add_argument('--min-charted', type=float, default=0.0,
                    help='skip a lake whose charted fraction is <= this (default 0 = skip only '
                         'lakes with no soundings at all)')
    ap.add_argument('--only-layers',
                    help='comma-separated SHIP layer names to re-cut, e.g. "pois". Reads and '
                         'writes ONLY these; every other layer already on disk is left alone. '
                         'Use after re-extracting one layer -- a full run re-cuts contours and '
                         'depth_areas that did not change, which is most of the wall clock. '
                         'REQUIRES an existing --report: everything measured from the layers '
                         'this run does not read (charted, counts, mb, shipped) is carried '
                         'forward from it, never recomputed, so a scoped run cannot blank the '
                         'index. A lake with no prior record is skipped, not degraded.')
    ap.add_argument('--limit', type=int, help='stop after N lakes, for a smoke test')
    ap.add_argument('--only-tiles',
                    help='comma list, a file path, or @file of tile ids. Rebuilds ONLY the lakes sitting on '
                         'those tiles -- for recutting after a tile is re-extracted, instead '
                         'of redoing all 143.')
    ap.add_argument('--ship-list',
                    help='slugs that ship regardless of coverage -- the "or on a DNR list" '
                         'half of the ship rule. Comma list, @file, or a bare path.')
    ap.add_argument('--require-depth-area', action='store_true',
                    help='restore the pre-2026-08-03 behaviour: a lake needs filled depth '
                         'areas, not just contours. Drops Bay Tree Lake and two ponds.')
    ap.add_argument('--report-only', action='store_true',
                    help='measure and update the report, write NO pack files. Use this to '
                         'refresh charted/counts_core without touching chartpack/ -- rewriting '
                         'a pack changes its mtime, and the R2 uploader keys its skip-unchanged '
                         'manifest on size+mtime, so a full rebuild would silently queue every '
                         'object in the bucket for re-upload.')
    ap.add_argument('--only-lakes',
                    help='comma list, a file path, or @file of SLUGS. Rebuilds only those lakes and only the '
                         'tiles they sit on. Use after a boundary fix, when you know exactly '
                         'which lakes were wrong and a full 50-minute pass is wasted effort.')
    ap.add_argument('--keep-zoom', type=int, default=0,
                    help='Garmin detail level to ship: 0 is finest, 5 the crudest overview. '
                         'They are redraws of the same water, not extra coverage, and drawing '
                         'them together is what puts blocky polygons over the real contours. '
                         'Pass -1 to keep every level (the old behaviour).')
    ap.add_argument('--max-segment-m', type=float, default=2000.0,
                    help='drop a line feature carrying a segment longer than this (0 = off)')
    a = ap.parse_args()
    if a.keep_zoom is not None and a.keep_zoom < 0:
        a.keep_zoom = None

    want = {s.strip().upper() for s in a.states.split(',')}
    reg = json.load(open(os.path.join(a.registry, 'lakes.json'), encoding='utf-8'))

    def _in_region(x):
        """A border lake counts on ANY of its states, not just the one its centroid is in.

        2026-08-09, and this is the THIRD place the same line has been wrong: 7ca3f78 fixed it in
        consolidate_lake_index.py, dae726e in tile_lake_map.py, and it was still here. `state` in
        lakes.json is the CENTROID's state, so Lake Barkley reads KY, Kerr reads VA, Pickwick and
        Guntersville read AL -- and each stage that filtered on it dropped them at a different
        point. The symptom moves as you fix them: first they were missing from the index, then
        they had no tiles, then --only-lakes reported "0 of 16 requested slugs are in the
        registry" for slugs that were plainly sitting in lake_index.json.

        Three copies means there will be a fourth, so the real guard is not here -- it is the
        result-level check in check_registry_invariants.py, which asks whether every row the app
        offers actually has tiles and a pack. A filter can be wrong in a new file; the result
        cannot be wrong in a new way.
        """
        if (x.get('state') or '').upper() in want:
            return True
        return bool(want & {(s or '').upper() for s in (x.get('states') or [])})

    meta = {x['slug']: x for x in reg['lakes'] if _in_region(x)}
    tm = json.load(open(a.map, encoding='utf-8'))
    by_tile, by_lake = tm['by_tile'], tm['by_lake']

    todo = {s for s in by_lake if s in meta}
    if a.only_tiles:
        ids = {t.upper() for t in _slug_list(a.only_tiles)}
        ids = {t[1:] if t[0].isalpha() and len(t) > 1 else t for t in ids}
        todo = {s for s in todo if any(t[1:] in ids for t in by_lake[s])}
        print('--only-tiles: %d lakes touch %s' % (len(todo), ','.join(sorted(ids))))
    a.ship_slugs = _slug_list(a.ship_list) if a.ship_list else set()
    if a.ship_slugs:
        print('--ship-list: %d slugs ship regardless of depth-area coverage' % len(a.ship_slugs))

    if a.only_lakes:
        slugs = _slug_list(a.only_lakes)
        missing = slugs - todo
        todo = {s for s in todo if s in slugs}
        print('--only-lakes: %d of %d requested slugs are in the registry' % (len(todo), len(slugs)))
        if missing:
            # Silence here would look like a successful rebuild of a lake that was never
            # touched. Name them.
            print('   NOT FOUND, nothing rebuilt for these: %s' % ', '.join(sorted(missing)))
    if a.limit:
        todo = set(sorted(todo, key=lambda s: -(meta[s].get('area_km2') or 0))[:a.limit])
    tiles = sorted({t for s in todo for t in by_lake[s]})
    print('%d lakes over %d tiles' % (len(todo), len(tiles)))

    deg = a.buffer_m / 111320.0
    # Load the existing report and update it in place rather than writing a second file.
    # A partial run -- --only-tiles after re-extracting a bad tile -- must not silently
    # replace a full report with 30 lakes in it, and asking for a merge step afterwards is
    # a step someone forgets.
    report = {}
    if os.path.exists(a.report):
        try:
            report = json.load(open(a.report, encoding='utf-8'))
            print('merging into existing report: %d lakes already recorded' % len(report))
        except Exception as e:
            print('existing report unreadable (%s) -- starting fresh' % str(e)[:50])

    # --only-layers: resolve, validate, and REFUSE to run without a prior report.
    #
    # Everything this script records about a lake -- charted fraction, counts, counts_core, the
    # ship decision, pack mb -- is measured from depth_areas and contours. A run that does not
    # READ those layers cannot measure them, and writing the un-measured value would set
    # charted:0 and shipped:false across the whole index while looking like a successful build.
    # That is the same shape as the --only run that emptied _river_aliases.json on 2026-08-05.
    # So: carry forward, never recompute, and hard-exit if there is nothing to carry forward
    # from. Same principle already applied to `mb` under --report-only.
    a.layer_set = None
    if a.only_layers:
        want_layers = [s.strip() for s in a.only_layers.split(',') if s.strip()]
        bad = [l for l in want_layers if l not in SHIP]
        if bad:
            sys.exit('--only-layers: unknown layer(s) %s. Known: %s'
                     % (', '.join(bad), ', '.join(SHIP)))
        a.layer_set = set(want_layers)
        if not report:
            sys.exit('--only-layers needs an existing --report to carry forward charted/counts/'
                     'mb from. Run a full build first, or drop --only-layers.')
        print('--only-layers: re-cutting %s only; %d other layer(s) left untouched on disk'
              % (', '.join(want_layers), len(SHIP) - len(a.layer_set)))

    masks, acc, remaining = {}, defaultdict(dict), {}
    dropped = defaultdict(int)
    trimmed = defaultdict(int)
    stolen = defaultdict(int)   # features a neighbouring lake's water held more of
    for s in todo:
        remaining[s] = len([t for t in by_lake[s] if t in tiles])

    t0 = time.time()
    flushed = 0
    for ti, tid in enumerate(tiles, 1):
        base = tid[1:]
        lakes = [s for s in by_tile.get(tid, []) if s in todo]
        if not lakes:
            continue

        # Masks first, so a lake with no boundary is dropped before we read anything for it.
        live = []
        for s in lakes:
            if s not in masks:
                rings = load_boundary(a.registry, s)
                if rings is None:
                    # No 3DHP polygon. Bates Old River is the known case -- Garmin charts it
                    # and 3DHP has no waterbody of that name anywhere. Record it and move on
                    # rather than guessing an extent.
                    report.setdefault(s, {'name': meta[s]['name'], 'state': meta[s]['state'],
                                          'charted': None, 'skipped': 'no boundary polygon'})
                    remaining[s] = 0
                    continue
                # build_mask picks BboxMask for a coastal zone rectangle -- see
                # build_chartpack._is_rectangle. Pamlico Sound would otherwise rasterise
                # 19.5 M cells, about 1.2 GB, for a shape that is a comparison.
                #
                # A COASTAL ZONE GIVES UP EVERY WATER THAT OWNS ITS OWN BOUNDARY. Ryan,
                # 2026-08-18: "coastal water shouldn't have any freshwater in it at all
                # period". A zone boundary is an envelope over land and water together and it
                # swallows whole lakes -- Goose Creek Reservoir sits 100% inside
                # coast_charleston_sc and had 469 contours and 459 depth areas shipped in the
                # Charleston pack as well as its own. Passing the exclusion here rather than
                # clipping the zone's boundary file is deliberate: the boundary is a coarse
                # 973-vertex envelope whose acreage is mostly land, and the question that
                # matters is which FEATURES ship, which is a per-feature test the mask already
                # performs. Excluding an owned water does not delete it -- it is in its own
                # pack, at its own resolution, with its own soundings.
                masks[s] = build_mask(rings, deg, exclude=owned_inside(s, meta, a.registry))
            live.append(s)

        # ONE LAYER AT A TIME, and this is not a style choice.
        #
        # Loading all seven layers of a tile before cutting anything means holding the entire
        # decoded tile in memory. Measured on C4E0FC that is 5.25 GB -- the same peak that
        # crashed Ryan's machine at --jobs 12 during extraction. Reading one layer, cutting
        # every lake from it, then freeing it caps the peak at the largest SINGLE layer
        # (depth_areas), which is roughly a third of that.
        for layer, (letter, _obj) in SHIP.items():
            if a.layer_set is not None and layer not in a.layer_set:
                continue          # --only-layers: not read, so nothing derived from it moves
            fp = os.path.join(a.extract, layer, letter + base)
            src = None
            for suf in ('.geojson.gz', '.geojson'):
                if os.path.exists(fp + suf):
                    src = fp + suf
                    break
            if not src:
                continue
            try:
                feats = read_fc(src).get('features') or []
            except Exception as e:
                print('   %s %s -> %s' % (tid, layer, str(e)[:60]))
                continue
            # The detail-level filter USED to run here, per tile, and that was wrong.
            #
            # A tile serves many lakes. Filtering to zoom 0 here throws away a small pond's
            # only survey the moment it shares a tile with a big lake that happens to carry
            # zoom 0 -- the pond never gets a say, because by the time _flush() sees it the
            # coarse features are already gone. Measured 2026-08-06: 71 packs came out of the
            # rebuild with zero contours for exactly this reason, kept their pre-fix file on
            # disk because an empty layer was skipped rather than deleted, and shipped to R2
            # looking current. See the per-lake filter in _flush().
            if a.max_segment_m and layer in LINE_LAYERS:
                feats, nlong = drop_long_segments(feats, a.max_segment_m)
                if nlong:
                    dropped[layer] += nlong
            # CUT THE FEATURE TO THE MASK. DO NOT KEEP IT WHOLE BECAUSE IT TOUCHED.
            #
            # This loop used to be `for x, y in verts(...): if (x, y) in m: keep(f); break`,
            # which is the exact `any(inbox(v) for v in verts(f))` that `trim_geometry` was
            # written to replace on 2026-08-08. The replacement went into build_chartpack.py,
            # which builds ONE lake, and never reached this file, which builds every pack --
            # so nothing shipped has ever been trimmed. Same shape as the AREA_LAYERS drift
            # this repo's own header warns about: two implementations of one rule, and the
            # copy that runs is the one that did not get fixed.
            #
            # What it costs, measured 2026-08-22 on the shipped packs. Ferry Lake: 31.3% of
            # its 5,937 contour vertices sit outside its own dilated mask, because a Santee
            # River contour grazes the oxbow and comes in at full length -- Ryan: *"ferry lake
            # actually zooms to the santee river and shows bathymetry for both the santee
            # river and ferry lake... it for sure is carrying santee river in its pack i could
            # see the contours lol"*. Across a 120-pack sample, 35 hold a contour vertex more
            # than a kilometre outside their own bbox plus buffer, the worst 4.3 km out, and
            # the rivers are worst of all: chauga_river 34.9% of vertices, diversion_canal
            # 22.9%, dan_river 22.3%, black_mingo_creek 16.2%.
            #
            # `--max-segment-m` above cannot catch these and never could -- it looks for one
            # long jump between consecutive vertices, and a stray contour is densely sampled.
            #
            # The feature is COPIED before its geometry is replaced. `feats` is the tile's
            # list and every live lake reads it, so trimming in place would hand the second
            # lake the first lake's cut.
            # WHAT THE TRIM COSTS, AND THE OPTIMISATION THAT DOES NOT PAY.
            #
            # Measured 2026-08-22 on C4E0CC -- 5,164 depth areas, 503,740 vertices, one lake:
            # the trim is 0.11 s against 0.05 s for the any-vertex scan it replaces, so **2.4x**.
            # Not more, because the old scan had no early exit either on a feature it did NOT
            # match; the only features that got cheaper were the ones it kept, and it kept them
            # wrong. Budget the accumulation phase at 2.4x and the whole build at under 2x.
            #
            # The obvious fix is a per-feature bbox computed once per tile-layer and tested
            # against the mask box in O(1) per lake. **It was built and measured and it does not
            # pay**: 69% of the tile's features are skipped, but the 31% that survive are the
            # long ones that cost the most, so it is 0.7x for a single lake (the precompute is
            # pure loss), 1.2x at four lakes and 1.4x at twelve. Do not spend an evening on it.
            #
            # ONE FEATURE, ONE SINGLE-PART GEOMETRY -- AND THIS REPO HAS PAID FOR IT TWICE.
            #
            # A trimmed line comes back as a MultiLineString when the mask cut it into more
            # than one run, and `verts()` is shallow ON PURPOSE: for a MultiLineString it
            # returns the list of LINES, so `for _x, _y in verts(g)` unpacks a whole line into
            # a coordinate pair. That is `ValueError: too many values to unpack (expected 2,
            # got 14)` in _flush's core test. It crashed the 2026-08-18 rebuild the first time
            # and it crashed this one at the first flush -- norris_lake, tile 8 of 92.
            #
            # `build_chartpack._singles` already settled the answer and its docstring says why:
            # *"Turning one contour into two contours is also the truer statement: they are two
            # separate stretches of water now."* Widening verts() would be the wrong fix; its
            # other callers rely on it being shallow.
            # ONE FEATURE, ONE LAKE -- 2026-08-23.
            #
            # A source feature used to be handed to EVERY live lake whose dilated mask it
            # touched, and each one kept its own cut of it. That is how Ferry Lake, 25 acres,
            # shipped 30 Santee River contours running a full 1-16 ft ladder 200 m outside its
            # own boundary, and how Great Falls Reservoir shipped four contours that are the
            # southern tails of Fishing Creek lines 936 points long. Ryan found both by looking.
            #
            # THE TEST IS NOT "IS IT INSIDE MY BOUNDARY". That was the first fix proposed and it
            # would have deleted the only deep data Great Falls has: its polygon stops 700 m
            # short of the dam, so its own water reads as outside itself. A boundary is not
            # trustworthy enough to be the sole judge of what a lake owns.
            #
            # THE TEST IS WHOSE WATER HOLDS MORE OF IT. Whichever live lake's core -- the
            # boundary before the 250 m collar -- contains the most of a contested feature's
            # vertices takes it, and nobody else gets a copy. If no lake's core holds any of it,
            # every claimant keeps its trimmed cut exactly as before: that is the short-boundary
            # case and it has to fail towards keeping data.
            #
            # Only CONTESTED features pay for this. A feature one lake kept is left alone, which
            # is nearly all of them, so the cost is not per-vertex-per-lake across the tile.
            claims = {}
            for s in live:
                m = masks[s]
                keep = acc[s].setdefault(layer, [])
                hit = lambda x, y, _m=m: (x, y) in _m
                for fi, f in enumerate(feats):
                    ng, verdict = trim_geometry(f['geometry'], hit, m)
                    if verdict == 'drop':
                        continue
                    if verdict == 'trim':
                        trimmed[layer] += 1
                    else:
                        ng = f['geometry']
                    # split_multi ALWAYS, not only on the trim branch. A clipped polygon comes
                    # back as a MultiPolygon just as a cut line comes back as a MultiLineString,
                    # and the untouched branch has to be safe too -- an extract that ever emits
                    # a Multi would crash _flush exactly the same way.
                    at = len(keep)
                    parts = split_multi(ng)
                    if len(parts) == 1 and parts[0] is ng and verdict != 'trim':
                        keep.append(f)
                    else:
                        for _p in parts:
                            _f2 = dict(f)
                            _f2['geometry'] = _p
                            keep.append(_f2)
                    if layer in OWNED_LAYERS:
                        claims.setdefault(fi, []).append((s, at, len(keep)))
            if layer in OWNED_LAYERS:
                for fi, rows in claims.items():
                    if len(rows) < 2:
                        continue
                    best_s, best_n = None, 0
                    for s, _a, _b in rows:
                        mk = masks[s]
                        n = 0
                        for _x, _y in verts(feats[fi]['geometry']):
                            if mk.cell_of(_x, _y) in mk.core:
                                n += 1
                        if n > best_n:
                            best_s, best_n = s, n
                    if best_s is None:
                        continue          # nobody's water holds it -- everyone keeps their cut
                    for s, a0, b0 in rows:
                        if s == best_s:
                            continue
                        # A ZONE DOES NOT CONTEST A ZONE. Ryan drew the coastal zones to
                        # overlap -- ACE Basin, Beaufort, Hilton Head and St Helena share water
                        # on purpose -- which is exactly why owned_inside() refuses to cut one
                        # out of another. A feature in the overlap belongs to both by
                        # construction and there is nothing to win. Measured before this line
                        # existed: the zones traded 800 features each way and every one of them
                        # came out worse.
                        if s.startswith('coast_') and best_s.startswith('coast_'):
                            continue
                        lst = acc[s][layer]
                        for i in range(a0, b0):
                            lst[i] = None
                        stolen[layer] += 1
                for s in live:
                    lst = acc[s].get(layer)
                    if lst and None in lst:
                        acc[s][layer] = [x for x in lst if x is not None]
            feats = None

        for s in live:
            remaining[s] -= 1
            if remaining[s] <= 0:
                _flush(s, acc.pop(s, {}), masks.pop(s), meta[s], a, report)
                flushed += 1
        if ti % 10 == 0 or ti == len(tiles):
            # COUNT WHAT THIS RUN WROTE, NOT WHAT THE REPORT HOLDS.
            #
            # This printed `len(report)`, and `report` is deliberately loaded from disk and
            # merged into so a partial run cannot replace a full one -- so a 375-lake run
            # reported "1842 lakes written" on tile 10 and again on tile 92, a number about
            # 1,467 lakes it never opened. The CLOSING summary was fixed for exactly this on
            # 2026-08-19 and carries a long comment about it; the progress line two feet above
            # it was not. Same bug, same file, one fix short.
            print('   tile %d/%d  %.0fs elapsed  %d of %d lakes written'
                  % (ti, len(tiles), time.time() - t0, flushed, len(todo)))

    for s in list(acc):                       # anything whose tile set was incomplete
        _flush(s, acc.pop(s), masks.pop(s, None), meta[s], a, report)

    # Summed from the per-lake records, because the filter is now a per-lake decision.
    _zt = sum(r.get('zoom_dropped') or 0 for r in report.values())
    if _zt:
        _fb = [s for s, r in report.items()
               if any(v != a.keep_zoom for v in (r.get('zoom_kept') or {}).values())]
        print('\ncoarser Garmin detail levels dropped (target zoom %s): %d feature(s)'
              % (a.keep_zoom, _zt))
        if _fb:
            print('  %d lake(s) kept a level other than %s -- either it is not in their tiles '
                  'or it had nothing inside the lake: %s'
                  % (len(_fb), a.keep_zoom, ', '.join(sorted(_fb)[:8])
                     + (' ...' if len(_fb) > 8 else '')))
    _rt = [s for s, r in report.items() if r.get('retracted')]
    if _rt:
        print('\n%d lake(s) had a layer go empty; the stale file was REMOVED: %s'
              % (len(_rt), ', '.join(sorted(_rt)[:8]) + (' ...' if len(_rt) > 8 else '')))
    _sk = [s for s, r in report.items() if r.get('stale_kept')]
    if _sk:
        print('\n!! %d lake(s) have an EMPTY layer whose stale file could not be deleted.'
              % len(_sk))
        print('   These will upload as though they were current. Remove by hand: %s'
              % ', '.join(sorted(_sk)[:8]) + (' ...' if len(_sk) > 8 else ''))
    if dropped:
        print('\nblown-out line features dropped (>%.0f m segment): %s'
              % (a.max_segment_m, dict(dropped)))
    if trimmed:
        # Say it out loud. A cut that prints nothing reads as "nothing was cut".
        print('\nfeatures cut back to the mask instead of kept whole: %s'
              % dict(trimmed))
    if stolen:
        # Same reason. A feature given to the water that holds more of it has LEFT a pack, and
        # a silent removal is indistinguishable from never having built it.
        print('features handed to the lake whose water holds more of them: %s'
              % dict(stolen))
    json.dump(report, open(a.report, 'w', encoding='utf-8'), indent=1)

    # THE SUMMARY DESCRIBES THIS RUN, NOT THE FILE IT MERGED INTO.
    #
    # `report` is deliberately loaded from disk and updated in place, so a partial run does not
    # replace a full report -- see the comment where it is loaded. The consequence was that the
    # closing summary counted the MERGED dict: `--only-lakes waccamaw_river` rebuilt one water
    # and then printed "452 lakes examined / shipped 450", numbers about 451 lakes it never
    # opened. A closing number that describes something other than what the run did is the
    # failure this repo keeps finding -- charted measured against a boundary fragment, "1,314
    # unchanged" after a run that rewrote every pack.
    #
    # So: scope every line to the slugs this run actually wrote, and print the merged total on
    # its own line, labelled, because that number is still worth having.
    this_run = {s: r for s, r in report.items() if s in todo}
    rows = list(this_run.values())
    shipped = [r for r in rows if r.get('shipped')]
    print('\n%d lake(s) built this run' % len(rows))
    print('  shipped (has contours)      %4d' % len(shipped))
    skips = defaultdict(int)
    for r in rows:
        if r.get('skipped'):
            skips[r['skipped']] += 1
    for reason, n in sorted(skips.items(), key=lambda kv: -kv[1]):
        if reason == 'no boundary polygon':
            continue
        print('  skipped, %-34s %4d' % (reason, n))
    have = [r for r in rows
            if not r.get('shipped') and (r.get('counts_core') or {}).get('contours')]
    if have:
        print('  ^ of those, %d have contours INSIDE the lake and were dropped anyway '
              '-- these are the ones the ship rule is really about' % len(have))
    print('  skipped, no boundary        %4d' % sum(1 for r in rows
                                                    if r.get('skipped') == 'no boundary polygon'))
    if shipped:
        fr = sorted(r['charted'] for r in shipped if r.get('charted') is not None)
        if fr:
            print('  charted fraction  median %.2f  p10 %.2f  p90 %.2f'
                  % (fr[len(fr)//2], fr[int(.1*len(fr))], fr[int(.9*len(fr))]))
    if len(rows) != len(report):
        allship = sum(1 for r in report.values() if r.get('shipped'))
        print('\n%d lake(s) in the report overall, %d shipped -- the other %d were merged in from'
              % (len(report), allship, len(report) - len(rows)))
        print('   earlier runs and were NOT opened by this one.')
    print('-> %s' % a.report)


def _flush(slug, layers, mask, meta, a, report):
    """Write one lake's pack, or record why it was not written."""
    rec = {'name': meta['name'], 'state': meta['state'],
           'area_acres': round((meta.get('area_km2') or 0) * 247.105, 1)}
    if mask is None:
        rec.update(charted=None, skipped='no boundary polygon')
        report[slug] = rec
        return

    # --only-layers: this run read a subset of the layers, so it is not entitled to an opinion
    # about anything measured from the others. Take the previous answer verbatim.
    scoped = getattr(a, 'layer_set', None) is not None
    prev = dict(report.get(slug) or {})
    if scoped and not prev:
        # Never seen before. Writing it now would record charted:None and no counts for a lake
        # that may well be fully charted -- an absence indistinguishable from a real one.
        rec['skipped'] = 'not in the prior report; run a full build for this lake first'
        report[slug] = rec
        return

    # Drop line features longer than the lake, before anything is measured or written.
    # It runs HERE and not beside drop_long_segments(): that one is per-tile and has no
    # idea how big the lake is, and the lake's own size is the only threshold that needs
    # no tuning. Doing it before charted_fraction() also keeps a 35-mile stray out of the
    # coverage number.
    # ── Features that are not in the lake at all ─────────────────────────────
    #
    # The clip keeps anything with a vertex inside the mask, and the mask is the lake
    # PLUS --buffer-m (default 250 m). That buffer exists for point layers: a dock or a
    # ramp genuinely sits just off the bank and would be lost without it.
    #
    # For contours and depth areas it is a disaster on a convoluted lake, and the size of
    # it is arithmetic, not bad luck. Wateree is 49 km2 of water with a **257 km**
    # shoreline. A 250 m collar on 257 km adds ~64 km2 -- more land than there is lake --
    # so the mask runs about 2.3x the water, and on the narrow peninsulas between coves
    # the collars from opposite banks meet and swallow the headland whole. Garmin tiles
    # carry land contours; the mask kept them.
    #
    # Measured on the shipped Wateree pack against the true boundary:
    #     contours     11,326 features, 1,956 (17.3%) ENTIRELY outside the lake
    #     depth_areas   9,123 features, 1,234 (13.5%) ENTIRELY outside
    #
    # This is what Ryan saw as "contours and shapes on land" -- dense, correctly drawn,
    # and hundreds of metres from any water. It scales with shoreline complexity, so the
    # lakes it ruins are exactly the good ones: Wateree, Murray, Marion, Hartwell.
    #
    # The rule needs no threshold and so nothing to tune: a bathymetric feature with ZERO
    # vertices in the actual water is not a feature of that lake. `mask.core` is the lake
    # before the buffer, and it is already computed -- it is the denominator of `charted`.
    # Anything straddling the bank keeps at least one vertex inside and is untouched.
    # ── Garmin detail levels, decided PER LAKE ──────────────────────────────
    #
    # `zoom` is a DETAIL level, not extra survey: 0 is the fine one, 3-5 are coarse
    # generalised overviews of the same water. Shipping all six stacked them on top of each
    # other -- 37-41% of every pack, blocky polygons over real contours.
    #
    # But zoom 0 is not universal. Garmin surveyed plenty of small water at 1, 2 or 3 and
    # never at 0: buffalo_pond is (1,2), lake_mattamuskeet is (3,4), upper_summerhouse_pond
    # is (1,2,4,5). Asking those for zoom 0 returns NOTHING, which is not "drop the coarse
    # duplicates", it is "drop the lake". So take --keep-zoom when the lake actually has it
    # and the finest level it DOES have otherwise. Where zoom 0 exists this changes nothing,
    # because 0 is already the finest.
    #
    # Per lake, and after accumulation, for the reason in the tile loop. Retaining every
    # level until here costs memory -- and costs exactly what the 2026-08-05 build already
    # paid, since that one accumulated all six levels and completed.
    # Choosing the level needs one more test than "is it present", for contours and depth
    # areas. broglin_slough HAS zoom 0 -- 23 features, every one of them outside the lake,
    # dragged in by the 250 m buffer from a neighbour. Its actual survey is 133 features at
    # zoom 1. Preferring 0 because it exists keeps the neighbour's scraps, drops the pond's
    # own bathymetry, and then retracts the layer as empty. So for the layers judged against
    # `mask.core`, take the finest level with anything IN the lake. Other layers -- shoreline
    # is the bank, so core membership means little there -- take the finest present.
    def _has_core(_fs):
        for _f in _fs:
            for _x, _y in verts(_f['geometry']):
                if mask.cell_of(_x, _y) in mask.core:
                    return True
        return False

    if a.keep_zoom is not None:
        _zk = {}
        _zdrop = 0
        for _layer in ZOOM_LAYERS:
            _feats = layers.get(_layer)
            if not _feats:
                continue
            _by = {}
            for _f in _feats:
                _by.setdefault((_f.get('properties') or {}).get('zoom'), []).append(_f)
            _levels = sorted(z for z in _by if z is not None)
            if not _levels:
                continue          # unlevelled layer; keep_zoom passes zoom=None through anyway
            if _layer in CORE_ONLY_LAYERS:
                _want = next((z for z in _levels if _has_core(_by[z])), None)
                if _want is None:                       # nothing anywhere is in the lake
                    _want = a.keep_zoom if a.keep_zoom in _by else _levels[0]
                elif a.keep_zoom in _by and _has_core(_by[a.keep_zoom]):
                    _want = a.keep_zoom
            else:
                _want = a.keep_zoom if a.keep_zoom in _by else _levels[0]
            layers[_layer], _n = keep_zoom(_feats, _want)
            if _n:
                _zdrop += _n
                _zk[_layer] = _want
        if _zdrop:
            rec['zoom_dropped'] = _zdrop
            rec['zoom_kept'] = _zk
            _fell = {k: v for k, v in _zk.items() if v != a.keep_zoom}
            if _fell:
                # Say WHICH reason. "no zoom 0" and "zoom 0 had nothing in the lake" are
                # different findings and only one of them is about missing data.
                for _k, _v in _fell.items():
                    _why = ('no zoom %s present' % a.keep_zoom) if a.keep_zoom not in _by \
                           else ('zoom %s had nothing inside the lake' % a.keep_zoom)
                    print('   %s: %s -- %s, kept zoom %s' % (slug, _k, _why, _v))

    core_dropped = 0
    for _layer in CORE_ONLY_LAYERS:
        _feats = layers.get(_layer)
        if not _feats:
            continue
        _keep = []
        for _f in _feats:
            for _x, _y in verts(_f['geometry']):
                if mask.cell_of(_x, _y) in mask.core:
                    _keep.append(_f)
                    break
            else:
                core_dropped += 1
        layers[_layer] = _keep
    if core_dropped:
        print('   %s: dropped %d feature(s) with no vertex in the lake itself'
              % (slug, core_dropped))
        rec['off_lake_dropped'] = core_dropped

    # A CONTOUR AT N FEET NEEDS A DEPTH-AREA BAND THAT CONTAINS N FEET -- 2026-08-23.
    #
    # Garmin draws both layers over the same survey, so they have to agree. Orton Pond's
    # deepest band is 1 ft and it carries contours at 12, 24, 36 and 48; White Oak Slash's
    # deepest band is 1 ft and every contour it has reads 12.1. Ryan, looking at both: *"weird
    # contours going on land"*. A 24 ft isobath with no 24 ft water anywhere in the pack is not
    # an isobath.
    #
    # This is not a threshold. It is the two layers being asked whether they describe the same
    # water, and the ONE FOOT of slack is the ladder's own step, not a tolerance to tune.
    #
    # CONTROLLED BEFORE IT SHIPPED, because a control the rule does not fire on is not a
    # control -- the drop rule that cost 97 packs their coverage on 2026-08-22 had two. Run
    # against the waters Ryan had just confirmed by eye: ferry_lake 0 of 163, cypress_lake_3
    # 0 of 20, lake_sequoyah 0 of 5 and atkinson_lake 0 of 11 -- the last two sounded in one
    # arm only and still clean -- against orton_pond 20 of 20 and white_oak_slash_lake 12 of 12.
    #
    # It runs after the core filter and after ownership, so the bands it judges against are the
    # ones this lake actually owns.
    _bands = []
    for _f in (layers.get('depth_areas') or []):
        _p = _f.get('properties') or {}
        _lo, _hi = _p.get('depth_min_ft'), _p.get('depth_max_ft')
        if isinstance(_lo, (int, float)) and isinstance(_hi, (int, float)):
            _bands.append((_lo, _hi))
    unbanded = 0
    if _bands and layers.get('contours'):
        _keep = []
        for _f in layers['contours']:
            _d = (_f.get('properties') or {}).get('depth_ft')
            if _d is None or any(_lo - 1.0 <= _d <= _hi + 1.0 for _lo, _hi in _bands):
                _keep.append(_f)
            else:
                unbanded += 1
        layers['contours'] = _keep
    if unbanded:
        print('   %s: dropped %d contour(s) at a depth no band in this pack covers'
              % (slug, unbanded))
        rec['unbanded_contours_dropped'] = unbanded

    # AND THEN CUT THE EXCLUDED WATER OUT OF WHAT SURVIVED. The filter above keeps a feature
    # for ONE vertex in the lake, which is right for a lake and wrong for a zone that has given
    # a water up: a contour 238/239 of the way inside Goose Creek Reservoir was kept by its last
    # point. Selecting cannot express "none at all"; see build_chartpack.clip_excluded.
    #
    # Every layer, not just the core-only two. A dock or a structure inside the reservoir is
    # the reservoir's, and the buffer is what would otherwise reach in and take it.
    if getattr(mask, 'excluded', None):
        _cl = {}
        for _layer, _feats in list(layers.items()):
            if not _feats:
                continue
            layers[_layer], _st = clip_excluded(_feats, mask)
            for _k, _v in _st.items():
                if _v:
                    _cl[_k] = _cl.get(_k, 0) + _v
        if _cl.get('trimmed') or _cl.get('emptied') or _cl.get('dropped_no_shapely') \
                or _cl.get('failed'):
            _gone = _cl.get('emptied', 0) + _cl.get('dropped_no_shapely', 0)
            print('   %s: gave up water that owns its own boundary -- %d feature(s) trimmed, '
                  '%d removed entirely' % (slug, _cl.get('trimmed', 0), _gone))
            rec['excluded_trimmed'] = _cl.get('trimmed', 0)
            rec['excluded_removed'] = _gone
        if _cl.get('dropped_no_shapely'):
            print('   %s: !! shapely is absent, so %d polygon(s) that straddle an excluded '
                  'water were DROPPED rather than cut. Install shapely and rebuild to keep '
                  'their saltwater half.' % (slug, _cl['dropped_no_shapely']))
            rec['excluded_polygons_dropped_whole'] = _cl['dropped_no_shapely']
        if _cl.get('failed'):
            # Its own line, because "shapely could not compute this" is not "this was inside
            # the water" and the two must never be added together.
            print('   %s: !! %d feature(s) could not be cut and were dropped -- a geometry '
                  'shapely refused, not water that was excluded'
                  % (slug, _cl['failed']))
            rec['excluded_uncuttable'] = _cl['failed']

    span_dropped = 0
    bounds = meta.get('bounds_wsen')
    for _layer in LINE_LAYERS:
        if layers.get(_layer):
            layers[_layer], _n = drop_oversized_lines(layers[_layer], bounds, _layer)
            span_dropped += _n
    if span_dropped:
        print('   %s: dropped %d line feature(s) longer than the lake itself'
              % (slug, span_dropped))
        rec['oversized_lines_dropped'] = span_dropped

    if scoped:
        # CARRY FORWARD. charted comes from depth_areas; counts_core from contours+depth_areas.
        # A pois-only run reads neither, so recomputing here would write 0 over a real number.
        frac = prev.get('charted')
        rec['charted'] = frac
        rec['counts'] = dict(prev.get('counts') or {})
        rec['counts'].update({k: len(v) for k, v in layers.items() if v})
        rec['counts_core'] = dict(prev.get('counts_core') or {})
        if prev.get('mb') is not None:
            rec['mb'] = prev['mb']
        rec['shipped'] = bool(prev.get('shipped'))
        if prev.get('skipped'):
            rec['skipped'] = prev['skipped']
        if not rec['shipped']:
            # It did not ship before and this run cannot change that verdict -- it has not
            # looked at the layers the verdict is made from. Record and move on without
            # writing a partial pack into a directory that has none.
            report[slug] = rec
            return
    else:
        # Contours are passed as corroborating evidence, not as the measurement. A lake whose
        # only depth band is the 0-1 ft shoreline outline scores 0 unless something was actually
        # sounded -- see LakeMask._has_soundings.
        frac = mask.charted_fraction(
            [f for l in CHARTED_LAYERS for f in layers.get(l, [])],
            layers.get('contours') or [])
        rec['charted'] = frac
        rec['counts'] = {k: len(v) for k, v in layers.items() if v}

    # `counts` above is features touching the boundary PLUS the 250 m buffer, because that is
    # what the clip keeps. `counts_core` is features with at least one vertex inside the lake
    # ITSELF. The two answer different questions and were being conflated:
    #
    # Raccoon Mountain reported 167 contours and 106 depth areas and charted 0.0. That is not a
    # contradiction -- it is a mountaintop reservoir whose 250 m ring clips the Tennessee River
    # below it. Every one of those features is a neighbour's. `counts_core` says 0 and the
    # story reads correctly.
    if scoped:
        # counts_core was carried forward above. Recomputing it from layers this run did not
        # read would return {} and turn every shipped lake into "no garmin data inside the lake"
        # at the gate below -- which is why the gate is skipped too.
        core = rec['counts_core']
    else:
        core = {}
        for layer in ('contours', 'depth_areas'):
            n = 0
            for f in layers.get(layer) or []:
                for x, y in verts(f['geometry']):
                    if mask.cell_of(x, y) in mask.core:
                        n += 1
                        break
            if n:
                core[layer] = n
        rec['counts_core'] = core

    if scoped:
        pass          # ship decision carried forward; this run did not read the layers it needs
    elif not frac or frac <= a.min_charted:
        # THE SHIP RULE. Settled 2026-08-03: **any contours count as bathymetry.**
        #
        #   Ryan: "i want a list of lakes with contours... i am willing to bet if it has
        #   contours i can fish it"
        #
        # The gate above measures depth-area COVERAGE (CHARTED_LAYERS = ('depth_areas',)),
        # not contour presence. So a lake Garmin drew contours on but never filled depth
        # bands for used to be dropped -- and dropped under a reason that was simply false,
        # since this branch printed 'no contours' about lakes whose own `counts` showed
        # contours. Barnishee Bayou was recorded as "no contours" with 11 of them.
        #
        # Measured over all 1,551 lakes on 2026-08-03, this rescues three: Beaver Lake
        # (48 ac), Jonesville Town Pond (26 ac), and Bay Tree Lake -- 1,454 acres with 34
        # contours, 107 docks and 113 shoreline features. A lake with a hundred docks on it
        # is being fished by somebody.
        #
        # `--ship-list` is the "or on a DNR list" half of the rule. It is a FLAG rather than
        # a registry lookup because no DNR list exists in the registry today: all 138 lakes
        # with no Garmin data are 3dhp-only, none carry scdnr_state_lake / lake_db /
        # user_known. Wiring it to a source that is not there would be inventing data. When a
        # DNR list arrives, it feeds this flag and nothing here changes.
        ships_anyway = (not a.require_depth_area) and bool(core.get('contours'))
        if slug in getattr(a, 'ship_slugs', ()):
            ships_anyway = True

        if not core:
            # Nothing of Garmin's falls inside the polygon. There is no pack to build.
            rec['skipped'] = 'no garmin data inside the lake'
            report[slug] = rec
            return
        if not ships_anyway:
            rec['skipped'] = ('contours but no depth-area coverage'
                              if core.get('contours')
                              else 'depth-area coverage below --min-charted')
            report[slug] = rec
            return
        # falls through and ships, on contours alone

    if a.report_only:
        # Measured, not written. `shipped` still reflects what WOULD ship, so the report stays
        # the single source of truth for the index.
        rec['shipped'] = True
        # CARRY `mb` FORWARD. It is the on-disk pack size, computed while writing the files --
        # which this branch deliberately does not do. Dropping it would blank `pack_mb` for all
        # 449 shipped lakes in lake_index.json the next time consolidate ran, and nothing would
        # error: the field would just quietly become null everywhere. A measuring pass must not
        # be able to delete data.
        prev = report.get(slug) or {}
        if prev.get('mb') is not None:
            rec['mb'] = prev['mb']
        report[slug] = rec
        return

    outdir = os.path.join(a.out, slug)
    os.makedirs(outdir, exist_ok=True)
    total = 0.0
    for layer, (_letter, objname) in SHIP.items():
        if a.layer_set is not None and layer not in a.layer_set:
            continue          # leave the existing file on disk exactly as it is
        feats = layers.get(layer) or []
        if not feats:
            # A layer with no features is not truncated -- but it IS retracted.
            #
            # The --only-layers guard immediately above already skipped every layer this run
            # did not read, so reaching here means the layer WAS read and genuinely came back
            # empty. That is an answer, not an absence, and leaving yesterday's file on disk
            # publishes the old answer as the current one.
            #
            # This is how 71 packs shipped pre-fix contours on 2026-08-06. The rebuild
            # produced zero contours for them, wrote nothing, left the 2026-08-05 file in
            # place, and the uploader pushed it to R2 as though it were fresh. A rebuild that
            # can only overwrite and never retract cannot be trusted to have rebuilt anything.
            stale = os.path.join(outdir, objname)
            if os.path.exists(stale):
                # NEVER fatal. A locked file, a read-only mount or an antivirus hold would
                # otherwise kill the whole run -- and dying at pack 3 of 1,566 to protect one
                # stale file is a far worse outcome than carrying on and saying so. Caught
                # 2026-08-07 when the first test run aborted on exactly this.
                try:
                    os.remove(stale)
                    print('   %s: %s is empty now -- removed the stale file' % (slug, objname))
                    rec.setdefault('retracted', []).append(objname)
                except OSError as e:
                    print('   %s: %s is empty but the stale file COULD NOT BE REMOVED (%s)'
                          % (slug, objname, str(e)[:60]))
                    rec.setdefault('stale_kept', []).append(objname)
            continue
        if layer == 'pois':
            # Garmin repeats a ramp label once per zoom level; the same collapse the
            # single-lake path applies.
            feats, _nc = collapse_ramps(feats, slug)
        feats = [{'type': 'Feature',
                  'properties': {k: v for k, v in f['properties'].items() if k not in DROP},
                  'geometry': redp(f['geometry'])} for f in feats]
        doc = {'type': 'FeatureCollection',
               'properties': {'layer': layer, 'key': slug, 'charted': frac,
                              'generator': 'build_all_chartpacks.py', 'note': NOTE},
               'features': feats}
        fp = os.path.join(outdir, objname)
        with open(fp, 'w', encoding='utf-8') as f:
            json.dump(doc, f, ensure_ascii=False)
        total += os.path.getsize(fp) / 1e6
    rec['shipped'] = True
    if scoped:
        # `total` here is only the layers this run rewrote. Overwriting mb with it would report
        # a 3 MB pack as 0.2 MB, and consolidate would carry that into lake_index.json. Same
        # reasoning as the --report-only branch above: a partial pass must not shrink data.
        if prev.get('mb') is not None:
            rec['mb'] = prev['mb']
    else:
        rec['mb'] = round(total, 2)
    report[slug] = rec


if __name__ == '__main__':
    main()
