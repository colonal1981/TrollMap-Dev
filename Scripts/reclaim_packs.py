#!/usr/bin/env python3
r"""reclaim_packs.py -- apply the two ownership rules to packs that are already built.

Personal use only, not for distribution or resale; not for navigation.

    py .\scripts\reclaim_packs.py --packs F:\TrollMapPipeline\chartpack `
       --registry F:\TrollMapPipeline\registry --dry-run
    py .\scripts\reclaim_packs.py --packs F:\TrollMapPipeline\chartpack `
       --registry F:\TrollMapPipeline\registry

WHY THIS IS NOT A REBUILD

Both rules read a pack's own layers and its neighbours' boundaries. Neither needs the tile
extract, neither needs a re-clip, neither needs shapely. Rebuilding 373 packs to apply them
would re-read 92 tiles for five hours to change a handful of files.

Ryan, on being asked to rebuild a fourth time in two days: *"so why would a full rebuild be
necessary? if there is just a few lakes that are affected?"* It is not. 302 of the 373 lakes
CAN be contested -- they share a tile and overlap inside the 250 m collar -- so a subset run
saves about 19% and has to be closed over both sides of every pair. This reads what is on disk
instead.

RULE 1 -- ONE FEATURE, ONE LAKE.

Whichever lake's core -- the boundary before the 250 m collar -- holds more of a feature owns
it. A feature another lake's core holds MORE of leaves this pack.

Ferry Lake, 25 acres, shipped 30 Santee River contours running a full 1-16 ft ladder. Great
Falls Reservoir shipped four contours that are the southern tails of Fishing Creek lines 936
points long -- Ryan: *"how do you have a 4 contour line on cement?"*

The existing core filter cannot catch either, and the reason matters: those strays pass within
5 to 13 metres of the boundary, inside one 22 m raster cell, so they DO touch the lake.
Touching is not owning.

And the test is deliberately NOT "is it inside my own boundary". That was the first fix
proposed and it would have deleted the only deep data Great Falls has, because its polygon
stops 700 m short of the dam and its own water reads as outside itself. If no neighbour holds
more of a feature, the pack keeps it -- a short boundary must not cost a lake its bathymetry.

JUDGED ON THE CUT, NOT THE SOURCE, AND THAT IS MORE CONSERVATIVE. The build decides ownership
on the untrimmed tile feature; this decides it on the copy already in the pack, which is
trimmed to that lake's own mask. If a neighbour's core still holds more of a piece already cut
down to fit this lake, the neighbour plainly owns it.

RULE 2 -- A CONTOUR AT N FEET NEEDS A BAND THAT CONTAINS N FEET.

Garmin draws both layers over one survey, so they have to agree. Orton Pond's deepest
depth-area band is 1 ft and it carries contours at 12, 24, 36 and 48. White Oak Slash's deepest
band is 1 ft and every contour it has reads 12.1. Ryan, looking at both: *"weird contours going
on land"*. A 24 ft isobath with no 24 ft water anywhere in the pack is not an isobath.

Not a threshold: the one foot of slack is the ladder's own step. Runs AFTER rule 1, so the
bands it judges against are the ones the lake actually owns.

WHAT IT WRITES

Only packs that changed. Each rewritten layer keeps its FeatureCollection header, with
`charted` refreshed from the surviving depth areas. `charted.json` gets the new fraction,
counts and counts_core for those lakes. The changed slugs go to outputs/reclaimed_lakes.txt,
which is the --only-lakes list for the steps that have to follow:

    build_structure        contours changed
    build_trolling_runs    stitches contours
    build_water_features   depth_areas and trolling_runs changed
    fit_trolling_runs      always last

build_water_graphs reads boundaries and MAR and never bathymetry -- do not re-run it.
"""
from __future__ import annotations
import argparse, json, os, sys, time
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_chartpack import build_mask, _rings, verts  # noqa: E402

BUFFER_M = 250.0
DEG = BUFFER_M / 111320.0


def load_json(p):
    with open(p, encoding='utf-8') as fh:
        return json.load(fh)


def neighbour_graph(idx, tile_map):
    """Lakes that share a tile AND overlap inside the collar. A contest is only possible here."""
    by_tile = defaultdict(set)
    for slug in idx:
        for t in (tile_map.get(slug) or []):
            by_tile[t].add(slug)

    def box(s):
        w, so, e, n = idx[s]['bounds_wsen']
        return (w - DEG, so - DEG, e + DEG, n + DEG)

    nb = defaultdict(set)
    for tiles in by_tile.values():
        ls = sorted(tiles)
        for i in range(len(ls)):
            bi = box(ls[i])
            for j in range(i + 1, len(ls)):
                bj = box(ls[j])
                if not (bi[2] < bj[0] or bj[2] < bi[0] or bi[3] < bj[1] or bj[3] < bi[1]):
                    nb[ls[i]].add(ls[j])
                    nb[ls[j]].add(ls[i])
    return nb


class Masks:
    """Built once per lake and kept. A river with 31 neighbours would otherwise rebuild them all."""

    def __init__(self, registry):
        self.registry = registry
        self._c = {}

    def get(self, slug):
        if slug in self._c:
            return self._c[slug]
        p = os.path.join(self.registry, 'boundaries', slug + '.geojson')
        m = None
        if os.path.exists(p):
            gj = load_json(p)
            geoms = [f.get('geometry') for f in (gj.get('features') or [])] or \
                    [gj.get('geometry') or gj]
            rings = [r for g in geoms if g for r in _rings(g)]
            if rings:
                m = build_mask(rings, DEG)
        self._c[slug] = m
        return m


def core_hits(mask, geom):
    n = 0
    for x, y in verts(geom):
        if mask.cell_of(x, y) in mask.core:
            n += 1
    return n


def bands_of(feats):
    out = []
    for f in feats:
        p = f.get('properties') or {}
        lo, hi = p.get('depth_min_ft'), p.get('depth_max_ft')
        if isinstance(lo, (int, float)) and isinstance(hi, (int, float)):
            out.append((lo, hi))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--packs', required=True)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--report', default=None, help='charted.json (default <registry>/charted.json)')
    ap.add_argument('--only-lakes', default=None, help='comma list or a file of slugs')
    ap.add_argument('--list', default=None,
                    help='where to write the changed slugs (default <packs>/../outputs/'
                         'reclaimed_lakes.txt)')
    ap.add_argument('--dry-run', action='store_true', help='measure and print, write nothing')
    a = ap.parse_args()

    reg = a.registry
    idx = load_json(os.path.join(reg, 'lake_index.json'))
    tile_map = (load_json(os.path.join(reg, 'tile_lake_map.json')) or {}).get('by_lake') or {}
    report_path = a.report or os.path.join(reg, 'charted.json')
    report = load_json(report_path) if os.path.exists(report_path) else {}

    todo = sorted(idx)
    if a.only_lakes:
        raw = a.only_lakes
        if os.path.exists(raw):
            with open(raw, encoding='utf-8') as fh:
                want = {l.strip() for l in fh if l.strip()}
        else:
            want = {s.strip() for s in raw.split(',') if s.strip()}
        todo = [s for s in todo if s in want]
        print('--only-lakes: %d of %d requested slugs are in the index' % (len(todo), len(want)))

    nb = neighbour_graph(idx, tile_map)
    masks = Masks(reg)
    print('%d lakes; %d of them can be contested by a neighbour' % (len(todo), len(nb)))

    changed = {}
    t0 = time.time()
    for i, slug in enumerate(todo, 1):
        pack = os.path.join(a.packs, slug)
        if not os.path.isdir(pack):
            continue
        mine = masks.get(slug)
        if mine is None:
            continue
        layers = {}
        for layer in ('contours', 'depth_areas'):
            p = os.path.join(pack, layer + '.geojson')
            if os.path.exists(p):
                try:
                    layers[layer] = load_json(p)
                except Exception as exc:
                    print('   %s: %s unreadable (%s) -- left alone' % (slug, layer, exc))
        if not layers:
            continue

        # ── RULE 1 ────────────────────────────────────────────────────────────────
        # RIVAL MASKS ARE BUILT LAZILY. Rasterising Great Pee Dee at 22 m cells is seconds, and
        # a lake whose every feature sits inside its own water never needs a single rival. The
        # first calibration run spent its whole budget building 32 river masks and judged
        # nothing.
        rivals = sorted(nb.get(slug, ()))
        lost = defaultdict(int)
        lost_to = defaultdict(int)
        for layer, gj in layers.items():
            keep = []
            for f in (gj.get('features') or []):
                g = f['geometry']
                pts = list(verts(g))
                n_me = sum(1 for x, y in pts if mine.cell_of(x, y) in mine.core)
                winner = None
                best = n_me
                # A FEATURE ENTIRELY INSIDE MY OWN WATER CANNOT BE TAKEN: a rival can at best
                # tie, and a tie stays where it is. This is the only safe short-circuit here.
                #
                # A "majority" version was tried and REVERTED the same minute -- if I hold more
                # than half the vertices then no rival can hold more, UNLESS two cores contain
                # the same cell. They do: Ferry Lake is an oxbow of the Santee and their
                # boundaries overlap, so the shortcut changed Ferry's verdict from 27 contours
                # lost to 24. Cheaper and wrong. The test case caught it because it was still
                # being run.
                if n_me < len(pts):
                    for k in rivals:
                        m = masks.get(k)
                        if m is None:
                            continue
                        # And a rival whose box does not reach the feature cannot hold any of it.
                        if not any(m.w <= x <= m.e and m.s <= y <= m.n for x, y in pts):
                            continue
                        n = sum(1 for x, y in pts if m.cell_of(x, y) in m.core)
                        if n > best:
                            best, winner = n, k
                if winner is None:
                    keep.append(f)
                else:
                    lost[layer] += 1
                    lost_to[winner] += 1
            if len(keep) != len(gj.get('features') or []):
                gj['features'] = keep

        # ── RULE 2 ────────────────────────────────────────────────────────────────
        unbanded = 0
        bands = bands_of((layers.get('depth_areas') or {}).get('features') or [])
        cgj = layers.get('contours')
        if bands and cgj and cgj.get('features'):
            keep = []
            for f in cgj['features']:
                d = (f.get('properties') or {}).get('depth_ft')
                if d is None or any(lo - 1.0 <= d <= hi + 1.0 for lo, hi in bands):
                    keep.append(f)
                else:
                    unbanded += 1
            if unbanded:
                cgj['features'] = keep

        if not (sum(lost.values()) or unbanded):
            continue

        frac = mine.charted_fraction(
            (layers.get('depth_areas') or {}).get('features') or [],
            (layers.get('contours') or {}).get('features') or [])
        counts = {k: len(v.get('features') or []) for k, v in layers.items()}
        core = {}
        for layer, gj in layers.items():
            n = 0
            for f in (gj.get('features') or []):
                for x, y in verts(f['geometry']):
                    if mine.cell_of(x, y) in mine.core:
                        n += 1
                        break
            if n:
                core[layer] = n

        rec = report.get(slug) or {}
        changed[slug] = {
            'lost': dict(lost), 'lost_to': dict(lost_to), 'unbanded': unbanded,
            'charted_before': rec.get('charted'), 'charted_after': frac,
            'counts_before': dict(rec.get('counts') or {}), 'counts_after': dict(counts),
        }
        print('   %-34s %s%s  charted %s -> %s'
              % (slug,
                 ('lost %s to %s' % (dict(lost), dict(lost_to))) if lost else '',
                 ('  unbanded contours dropped %d' % unbanded) if unbanded else '',
                 rec.get('charted'), frac))

        if not a.dry_run:
            for layer, gj in layers.items():
                props = gj.setdefault('properties', {})
                props['charted'] = frac
                props['reclaimed'] = '2026-08-23 reclaim_packs.py'
                tmp = os.path.join(pack, layer + '.geojson.tmp')
                with open(tmp, 'w', encoding='utf-8') as fh:
                    json.dump(gj, fh, ensure_ascii=False)
                os.replace(tmp, os.path.join(pack, layer + '.geojson'))
            rec = dict(rec)
            rec['charted'] = frac
            rec['counts'] = {**(rec.get('counts') or {}), **counts}
            rec['counts_core'] = {**(rec.get('counts_core') or {}), **core}
            rec['reclaimed'] = True
            report[slug] = rec
        if i % 25 == 0:
            print('   %d/%d  %.1f min' % (i, len(todo), (time.time() - t0) / 60.0))
            # THE PACKS ARE WRITTEN AS WE GO AND THE REPORT IS NOT, so an interrupted run would
            # leave charted.json describing packs that no longer exist in that form. Flush it
            # on the same cadence as the progress line.
            if not a.dry_run and changed:
                with open(report_path, 'w', encoding='utf-8') as fh:
                    json.dump(report, fh, indent=1)

    print()
    print('%d pack(s) changed of %d examined, %.1f min'
          % (len(changed), len(todo), (time.time() - t0) / 60.0))
    if not changed:
        return 0

    lost_all = sum(sum(c['lost'].values()) for c in changed.values())
    unb_all = sum(c['unbanded'] for c in changed.values())
    print('features handed to the lake whose water holds more of them: %d' % lost_all)
    print('contours dropped at a depth no band in the pack covers:      %d' % unb_all)

    if a.dry_run:
        print('\n--dry-run: nothing written.')
        return 0

    with open(report_path, 'w', encoding='utf-8') as fh:
        json.dump(report, fh, indent=1)
    print('-> %s' % report_path)
    lst = a.list or os.path.join(os.path.dirname(os.path.abspath(a.packs)), 'outputs',
                                 'reclaimed_lakes.txt')
    os.makedirs(os.path.dirname(lst), exist_ok=True)
    with open(lst, 'w', encoding='utf-8') as fh:
        for s in sorted(changed):
            fh.write(s + '\n')
    print('-> %s  (%d slugs, this is the --only-lakes list)' % (lst, len(changed)))
    print()
    print('NOW RE-RUN, --only-lakes %s:' % lst)
    print('   build_structure       (contours changed)')
    print('   build_trolling_runs   (stitches contours)')
    print('   build_water_features  (depth_areas and trolling_runs changed)')
    print('   fit_trolling_runs     (always last)')
    print('build_water_graphs reads boundaries and MAR, never bathymetry. Do NOT re-run it.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
