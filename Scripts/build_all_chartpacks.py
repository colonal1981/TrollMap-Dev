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
                             DROP, redp, _rings, collapse_ramps)   # noqa: E402

# Which layers decide "is this lake charted". DEPTH AREAS, not contours -- see
# LakeMask.charted_fraction for why counting contour vertices reported 0.66 for a fully
# surveyed Wateree and never exceeded 0.95 on any lake.
CHARTED_LAYERS = ('depth_areas',)

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
    meta = {x['slug']: x for x in reg['lakes'] if (x.get('state') or '').upper() in want}
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
    for s in todo:
        remaining[s] = len([t for t in by_lake[s] if t in tiles])

    t0 = time.time()
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
                masks[s] = build_mask(rings, deg)
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
            for s in live:
                m = masks[s]
                keep = acc[s].setdefault(layer, [])
                for f in feats:
                    for x, y in verts(f['geometry']):
                        if (x, y) in m:
                            keep.append(f)
                            break
            feats = None

        for s in live:
            remaining[s] -= 1
            if remaining[s] <= 0:
                _flush(s, acc.pop(s, {}), masks.pop(s), meta[s], a, report)
        if ti % 10 == 0 or ti == len(tiles):
            print('   tile %d/%d  %.0fs elapsed  %d lakes written' % (ti, len(tiles),
                                                                      time.time() - t0, len(report)))

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
    json.dump(report, open(a.report, 'w', encoding='utf-8'), indent=1)
    shipped = [r for r in report.values() if r.get('shipped')]
    print('\n%d lakes examined' % len(report))
    print('  shipped (has contours)      %4d' % len(shipped))
    skips = defaultdict(int)
    for r in report.values():
        if r.get('skipped'):
            skips[r['skipped']] += 1
    for reason, n in sorted(skips.items(), key=lambda kv: -kv[1]):
        if reason == 'no boundary polygon':
            continue
        print('  skipped, %-34s %4d' % (reason, n))
    have = [r for r in report.values()
            if not r.get('shipped') and (r.get('counts_core') or {}).get('contours')]
    if have:
        print('  ^ of those, %d have contours INSIDE the lake and were dropped anyway '
              '-- these are the ones the ship rule is really about' % len(have))
    print('  skipped, no boundary        %4d' % sum(1 for r in report.values()
                                                    if r.get('skipped') == 'no boundary polygon'))
    if shipped:
        fr = sorted(r['charted'] for r in shipped if r.get('charted') is not None)
        if fr:
            print('  charted fraction  median %.2f  p10 %.2f  p90 %.2f'
                  % (fr[len(fr)//2], fr[int(.1*len(fr))], fr[int(.9*len(fr))]))
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
