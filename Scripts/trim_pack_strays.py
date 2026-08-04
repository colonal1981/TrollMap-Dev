#!/usr/bin/env python3
r"""trim_pack_strays.py - cut the spaghetti out of chartpacks already on disk.

Personal use only, not for distribution or resale; not for navigation.

    py .\trim_pack_strays.py --chartpack "F:\TrollMapPipeline\chartpack" `
       --boundaries "F:\TrollMapPipeline\registry\boundaries"
    # ... reports what it would change, writes nothing. Then --go.

WHAT IS WRONG

`build_chartpack.py` decides membership per FEATURE, not per vertex:

    # A feature is kept if ANY vertex is in the box, so a contour crossing the edge
    # stays whole rather than being cut into two open ends.
    if not any(inbox(x, y) for x, y in verts(f['geometry'])): continue

The intent is right -- a contour that crosses the shoreline should not be chopped into two
open ends. The consequence is not: a contour that merely GRAZES the mask is kept at full
length, so a line that touches Lake Murray's edge and then runs 18 km east ships inside
Murray's pack and draws across the map.

`--max-segment-m` does not catch these. It looks for one long jump between consecutive
vertices; a stray of this kind is densely sampled and its longest segment is under a
kilometre. Measured on the shipped packs: Murray's worst segment is 1.02 km against a 2 km
guard, while its contours reach 18 km past the boundary's east edge.

Counts are small and the visual damage is not. Of the first 223 packs scanned, 60 hold at
least one mostly-outside feature, but the offenders are single digits to low tens against
tens of thousands of good ones -- Center Hill is 26 bad out of 133,397. One 29 km line
across a chart looks like the whole layer is broken.

WHAT THIS DOES

Rebuilds the same mask `build_chartpack.py` used and applies that file's own
`trim_geometry()` -- both imported, never reimplemented, so the two cannot drift:

  * LINES (contours, garmin_shoreline): split into the maximal runs of vertices that are
    inside, each run extended by ONE vertex at each end so the line still reaches the shore
    rather than stopping short of it. A feature entirely inside is untouched, byte for byte.
  * POLYGONS (depth_areas): dropped when under half their vertices are inside. A polygon
    cannot be trimmed by dropping vertices without inventing an edge that was never surveyed.
  * POINTS (pois, docks): left alone. The any-vertex rule is already exact for a point.

Untouched packs are not rewritten at all, so their mtime does not move and the R2 uploader's
skip-unchanged manifest will not queue them.

WHY TRIM RATHER THAN DROP

Ryan's bar: "contours when I select a body of water in the right place". A contour that
genuinely crosses the shoreline is real data about his lake and should survive; only the part
that wandered off should go. Dropping whole features would take the shoreline contour with
the stray, and the shoreline is where the fishing is.
"""
import argparse, json, math, os, sys, time


def load_rings(path):
    """Every ring of every part. build_chartpack's load_boundary() note applies: 3DHP emits
    one Feature per part and features[0] is an arbitrary fragment."""
    gj = json.load(open(path, encoding='utf-8'))
    geoms = ([f.get('geometry') for f in (gj.get('features') or [])]
             if gj.get('type') == 'FeatureCollection' else [gj.get('geometry') or gj])
    out = []
    for g in geoms:
        if not g:
            continue
        t, c = g.get('type'), g.get('coordinates') or []
        if t == 'Polygon':
            out.extend(r for r in c if r)
        elif t == 'MultiPolygon':
            for poly in c:
                out.extend(r for r in poly if r)
    return out


LINE_LAYERS = ('contours.geojson', 'garmin_shoreline.geojson')
POLY_LAYERS = ('depth_areas.geojson',)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--chartpack', required=True)
    ap.add_argument('--boundaries', required=True)
    ap.add_argument('--buffer-m', type=float, default=250.0,
                    help='must match the build. Default 250, same as build_all_chartpacks.py.')
    ap.add_argument('--lake', action='append', help='only these slugs. Repeatable.')
    ap.add_argument('--state-file', default=None,
                    help='resume file. Default <chartpack>/_trim_state.json')
    ap.add_argument('--seconds', type=float, default=0,
                    help='stop after this many seconds and save progress (0 = run to the end)')
    ap.add_argument('--go', action='store_true', help='write. Default is a dry run.')
    a = ap.parse_args()

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    try:
        # ONE implementation, imported -- not a second copy. build_chartpack.py owns both the
        # mask and the trim rule, so a future change to either cannot leave this script
        # disagreeing with the builder about where the water is.
        from build_chartpack import LakeMask, trim_geometry
    except ImportError as exc:
        sys.exit('needs build_chartpack.py beside this file: %s' % exc)

    print('MODE: %s' % ('WRITING' if a.go else 'DRY RUN -- nothing will be changed'))
    deg = a.buffer_m / 111320.0
    statep = a.state_file or os.path.join(a.chartpack, '_trim_state.json')
    state = {}
    if os.path.exists(statep):
        try:
            state = json.load(open(statep))
        except Exception:
            state = {}

    # A DRY RUN CHANGES NOTHING, SO IT HAS NOTHING TO RESUME.
    #
    # This file used to be written unconditionally. A dry run therefore recorded all 1,516
    # packs, and the --go that followed skipped every one and reported "scanned 1516 packs,
    # 0 needed work" -- which reads exactly like "your chartpacks are clean". Ryan ran the
    # dry run, saw 563 packs needing work, ran --go, and was told there was nothing to do.
    #
    # Entries now carry the mode that produced them:
    #   'skip'          a missing boundary or ring. A fact about the data, true in any mode.
    #   'dry': True     what WOULD change. A decision, not a repair. Discard before writing.
    #   neither         written by a real --go pass, or by a build predating this fix.
    #
    # On --go, keep only the skips and the repairs. Untagged entries are discarded too: their
    # provenance is unknowable, and re-scanning costs minutes while trusting them costs a
    # silent no-op that looks like success.
    if a.go and state:
        drop = [k for k, v in state.items() if 'skip' not in v and not v.get('repaired')]
        for k in drop:
            del state[k]
        if drop:
            print('  ignoring %d resume entries not written by a completed --go pass' % len(drop))

    slugs = a.lake or sorted(d for d in os.listdir(a.chartpack)
                             if os.path.isdir(os.path.join(a.chartpack, d)))
    t0 = time.time()
    touched = tot_trim = tot_drop = 0
    worst = []
    skipped = 0
    for slug in slugs:
        if not a.lake and slug in state:
            skipped += 1
            continue
        if a.seconds and time.time() - t0 > a.seconds:
            print('  ... stopping at the time limit, progress saved')
            break
        bp = os.path.join(a.boundaries, slug + '.geojson')
        if not os.path.exists(bp):
            state[slug] = {'skip': 'no boundary'}
            continue
        rings = load_rings(bp)
        if not rings:
            state[slug] = {'skip': 'no ring'}
            continue
        xs = [p[0] for r in rings for p in r]
        ys = [p[1] for r in rings for p in r]
        W, E = min(xs) - deg, max(xs) + deg
        S, N = min(ys) - deg, max(ys) + deg
        mask = LakeMask(rings, deg)

        def hit(x, y, _m=mask, _W=W, _E=E, _S=S, _N=N):
            if not (_W <= x <= _E and _S <= y <= _N):
                return False
            return (x, y) in _m

        rec = {'trim': 0, 'drop': 0, 'feats': 0, 'worst_km': 0.0}
        for fname in LINE_LAYERS + POLY_LAYERS:
            fp = os.path.join(a.chartpack, slug, fname)
            if not os.path.exists(fp):
                continue
            try:
                doc = json.load(open(fp, encoding='utf-8'))
            except Exception as exc:
                print('   %-32s %s unreadable (%s)' % (slug, fname, str(exc)[:40]))
                continue
            out, changed = [], False
            for f in doc.get('features') or []:
                rec['feats'] += 1
                g = f.get('geometry') or {}
                ng, verdict = trim_geometry(g, hit)
                if verdict == 'keep':
                    out.append(f)
                    continue
                changed = True
                pts = []
                _flatten(g.get('coordinates'), pts)
                if pts:
                    gxs = [p[0] for p in pts]; gys = [p[1] for p in pts]
                    km = math.hypot((max(gxs) - min(gxs)) * 111 * math.cos(math.radians(gys[0])),
                                    (max(gys) - min(gys)) * 111)
                    rec['worst_km'] = max(rec['worst_km'], km)
                if verdict == 'drop':
                    rec['drop'] += 1
                else:
                    rec['trim'] += 1
                    f = dict(f); f['geometry'] = ng
                    out.append(f)
            if changed and a.go:
                doc['features'] = out
                tmp = fp + '.tmp'
                json.dump(doc, open(tmp, 'w', encoding='utf-8'), ensure_ascii=False)
                os.replace(tmp, fp)
        # Marked only on a pass that actually wrote. See the resume-file note above.
        if a.go:
            rec['repaired'] = True
        state[slug] = rec
        if rec['trim'] or rec['drop']:
            touched += 1
            tot_trim += rec['trim']; tot_drop += rec['drop']
            worst.append((rec['worst_km'], slug, rec['trim'], rec['drop'], rec['feats']))

    json.dump(state, open(statep, 'w'))
    # `scanned` used to be counted off the STATE dict, so a pass that opened nothing still
    # reported the full 1,516. Count what THIS pass actually looked at.
    scanned = len(slugs) - skipped
    print('\nscanned %d packs, %d needed work' % (scanned, touched))
    if skipped:
        print('skipped %d packs already recorded in %s' % (skipped, os.path.basename(statep)))
    if scanned == 0 and skipped:
        print('\n  !! THIS RUN EXAMINED NOTHING -- every pack was already in the resume file.')
        print('     That is not the same as "nothing needed doing". Delete')
        print('     %s to force a full pass.' % statep)
    print('%d features trimmed, %d dropped' % (tot_trim, tot_drop))
    worst.sort(reverse=True)
    if worst:
        print('\n%-34s %6s %6s %10s %9s' % ('slug', 'trim', 'drop', 'of', 'worst km'))
        for km, slug, tr, dr, fe in worst[:25]:
            print('%-34s %6d %6d %10s %9.1f' % (slug, tr, dr, '{:,}'.format(fe), km))
        if len(worst) > 25:
            print('... %d more' % (len(worst) - 25))
    if not a.go:
        print('\nDRY RUN -- nothing written. Add --go.')


def _flatten(c, acc):
    if not c:
        return
    if isinstance(c[0], (int, float)):
        acc.append(c); return
    for x in c:
        _flatten(x, acc)


if __name__ == '__main__':
    main()
