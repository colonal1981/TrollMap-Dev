#!/usr/bin/env python3
"""recompute_charted.py - fix the charted fraction from the BUILT packs. No rebuild.

Personal use only, not for distribution or resale; not for navigation.

    py .\\recompute_charted.py `
       --packs    "F:\\TrollMapPipeline\\chartpack" `
       --registry "F:\\TrollMapPipeline\\registry" `
       --report   "F:\\TrollMapPipeline\\registry\\charted.json"

WHY THIS EXISTS

`charted` was measured by counting mask cells that contained a CONTOUR VERTEX. Ryan spotted
it immediately: Wateree came back 0.66 when the whole lake is surveyed. The distribution
across all 434 shipped lakes gives the same tell -- **maximum 0.95, and only two lakes reach
it.** A coverage metric on which nothing scores full marks is not measuring coverage.

Contours are LINES. Between two depth intervals a flat basin holds no contour at all, so
those cells read as unsurveyed however complete the survey is. The number was really
reporting bottom slope.

Depth-area polygons TILE the surveyed surface, so filling them measures coverage. Same
LakeMask, different input.

NOTHING ELSE CHANGES. The packs already contain the right geometry; only the fraction was
wrong, and the fraction lives in `charted.json` and `lake_index.json`, which the app reads.
The stale `charted` property inside each pack file is not read by anything. So this reads
the depth_areas that were already written, recomputes, and rewrites the report -- minutes,
not a 50-minute rebuild and a 6.6 GB re-upload.

`shipped` is left exactly as it was. A lake that shipped had contours; whether its NEW
fraction is higher or lower does not retroactively make that decision wrong, and silently
un-shipping a lake whose pack is already in R2 would leave an orphan.
"""
import argparse, json, os, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_chartpack import LakeMask, _rings, verts   # noqa: E402

# Layers clipped to the lake ITSELF, with no 250 m buffer.
#
# The buffer is there so a dock, a ramp or a POI on the bank lands in the pack. Applied to
# `waterbody` it also drags in every farm pond and borrow pit within 250 m of the shoreline,
# which is what Ryan saw: "the wateree data includes a bunch of water puddles on the maps".
# A layer whose job is to DEPICT the lake should not contain other lakes.
#
# Structure layers keep the buffer. Contours and depth areas keep it too -- Garmin's survey
# does not stop exactly on 3DHP's shoreline, and clipping them to the core would shave the
# margins off every lake.
CORE_ONLY = ('waterbody.geojson',)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--packs', required=True)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--report', required=True)
    ap.add_argument('--buffer-m', type=float, default=250.0)
    ap.add_argument('--no-prune', action='store_true',
                    help='skip the waterbody prune, only recompute the fraction')
    a = ap.parse_args()

    report = json.load(open(a.report, encoding='utf-8'))
    deg = a.buffer_m / 111320.0
    slugs = sorted(d for d in os.listdir(a.packs)
                   if os.path.isdir(os.path.join(a.packs, d)))
    print('%d packs, %d records in the report' % (len(slugs), len(report)))

    t0 = time.time()
    changed, skipped, moved, pruned = 0, 0, [], []
    coastal = 0
    no_boundary = []
    for i, slug in enumerate(slugs, 1):
        da = os.path.join(a.packs, slug, 'depth_areas.geojson')
        bp = os.path.join(a.registry, 'boundaries', slug + '.geojson')

        # ── COASTAL GETS A BOOLEAN, NOT A FRACTION ────────────────────────────────────────
        #
        # `charted` is filled depth-area cells / lake core cells, measured against the boundary
        # polygon. ALL 22 COASTAL BOUNDARIES ARE FIVE-VERTEX RECTANGLES -- re-verified
        # 2026-08-07, COASTAL_ZONES_CLIP_TO_A_RECTANGLE. A box over Charleston contains the
        # harbour, several tidal creeks, and a great deal of open Atlantic that Garmin has never
        # sounded.
        #
        # So a fraction here would come back LOW, PLAUSIBLE AND MEANINGLESS -- the exact shape of
        # the multi-part bug this script was written to fix, where j_strom_thurmond read 0.7817
        # measured on one forty-third of the lake. "A number that cannot reveal the thing it is
        # measuring."
        #
        # The registry cut only ever asks "is there bathymetry here at all". That is answerable
        # from disk without a polygon, so coastal answers THAT and says which question it
        # answered. A real fraction waits for real polygons.
        if slug.startswith('coast_'):
            has = False
            for fn in ('depth_areas.geojson', 'contours.geojson'):
                fp = os.path.join(a.packs, slug, fn)
                if not os.path.exists(fp):
                    continue
                try:
                    if (json.load(open(fp, encoding='utf-8')).get('features') or []):
                        has = True
                        break
                except Exception:
                    continue
            rec = report.setdefault(slug, {})
            rec['charted'] = 1.0 if has else 0.0
            # Named differently ON PURPOSE, so nothing downstream can average a boolean in with
            # 699 real fractions and believe the result.
            rec['charted_metric'] = 'has_bathymetry_bool'
            rec['charted_note'] = ('boundary is a rectangle, so a coverage fraction would be '
                                   'measured against open ocean; this is presence only')
            coastal += 1
            continue

        if not (os.path.exists(da) and os.path.exists(bp)):
            # A PACK WITH CONTOURS AND NO ANSWER IS WORTH SAYING OUT LOUD. 699 entries are flagged
            # charted while 590 packs actually hold contours.geojson, and the disagreement runs
            # both ways. Silence here is how 35 packs ended up with data and no flag.
            cp = os.path.join(a.packs, slug, 'contours.geojson')
            if os.path.exists(cp) and not os.path.exists(bp):
                no_boundary.append(slug)
            skipped += 1
            continue
        try:
            gj = json.load(open(bp, encoding='utf-8'))
            # EVERY part -- see load_boundary() in build_all_chartpacks.py.
            geoms = ([f.get('geometry') for f in (gj.get('features') or [])]
                     if gj.get('type') == 'FeatureCollection'
                     else [gj.get('geometry') or gj])
            rings = [ring for g in geoms if g for ring in _rings(g)]
            if not rings:
                skipped += 1
                continue
            feats = json.load(open(da, encoding='utf-8')).get('features') or []
            frac = LakeMask(rings, deg).charted_fraction(feats)
        except Exception as e:
            print('   %s -> %s' % (slug, str(e)[:70]))
            skipped += 1
            continue
        rec = report.setdefault(slug, {})
        old = rec.get('charted')
        rec['charted'] = frac
        rec['charted_metric'] = 'depth_areas_filled'
        changed += 1

        # Prune the puddles. A waterbody polygon stays only if some part of it is inside the
        # lake proper -- the mask's `core`, before the buffer.
        if not a.no_prune:
            m = LakeMask(rings, deg)
            for fn in CORE_ONLY:
                fp = os.path.join(a.packs, slug, fn)
                if not os.path.exists(fp):
                    continue
                try:
                    doc = json.load(open(fp, encoding='utf-8'))
                except Exception:
                    continue
                fs = doc.get('features') or []
                keep = [f for f in fs
                        if any(m.cell_of(x, y) in m.core for x, y in verts(f['geometry']))]
                if len(keep) != len(fs):
                    pruned.append((slug, fn, len(fs) - len(keep), len(fs)))
                    doc['features'] = keep
                    with open(fp, 'w', encoding='utf-8') as fh:
                        json.dump(doc, fh, ensure_ascii=False)
        if old is not None and frac is not None:
            moved.append((frac - old, slug, old, frac))
        if i % 50 == 0:
            print('   %d/%d  %.0fs' % (i, len(slugs), time.time() - t0))

    json.dump(report, open(a.report, 'w', encoding='utf-8'), indent=1)

    fr = sorted(v['charted'] for v in report.values()
                if v.get('shipped') and v.get('charted') is not None)
    print('\n%d recomputed, %d coastal (presence only), %d skipped'
          % (changed, coastal, skipped))

    # ── THE FLAG AGAINST THE DISK, BOTH DIRECTIONS ────────────────────────────────────────────
    #
    # This script used to report only what it changed, which cannot show what it never reached.
    # 699 registry entries are flagged charted against 590 packs holding contours.geojson, and
    # the gap runs both ways: packs with data and no flag, and flags with no data behind them --
    # the second kind appears when a rebuild RETRACTS a layer (build_all_chartpacks removes a
    # file whose layer came back empty) and nothing lowers the flag afterwards.
    #
    # Reported rather than fixed. A flag is a claim about a measurement and this pass did not
    # take one for these; overwriting on the strength of a directory listing would be the same
    # move as the deletion list built from a folder that was still being written.
    on_disk = set()
    for slug in slugs:
        cp = os.path.join(a.packs, slug, 'contours.geojson')
        if os.path.exists(cp):
            on_disk.add(slug)
    flagged = {k for k, v in report.items() if (v or {}).get('charted')}
    data_no_flag = sorted(on_disk - flagged)
    flag_no_data = sorted(s for s in (flagged - on_disk)
                          if os.path.isdir(os.path.join(a.packs, s)))
    print('contours on disk: %d   flagged charted: %d' % (len(on_disk), len(flagged)))
    if data_no_flag:
        print('  %d pack(s) HAVE contours and are not flagged:' % len(data_no_flag))
        for x in data_no_flag[:10]:
            print('     %s' % x)
        if len(data_no_flag) > 10:
            print('     ... and %d more' % (len(data_no_flag) - 10))
    if flag_no_data:
        print('  %d pack(s) are flagged but hold no contours (retracted?):' % len(flag_no_data))
        for x in flag_no_data[:10]:
            print('     %s' % x)
        if len(flag_no_data) > 10:
            print('     ... and %d more' % (len(flag_no_data) - 10))
    if no_boundary:
        print('  %d pack(s) have contours but NO boundary, so no fraction can be taken:'
              % len(no_boundary))
        for x in no_boundary[:10]:
            print('     %s' % x)
    if fr:
        print('charted fraction now:  min %.2f  p25 %.2f  median %.2f  p90 %.2f  max %.2f'
              % (fr[0], fr[len(fr) // 4], fr[len(fr) // 2], fr[int(.9 * len(fr))], fr[-1]))
        print('   at >=0.95: %d      at >=0.80: %d' % (sum(1 for x in fr if x >= .95),
                                                       sum(1 for x in fr if x >= .80)))
    if pruned:
        tot_d = sum(p[2] for p in pruned); tot_f = sum(p[3] for p in pruned)
        print('\nwaterbody puddles pruned: %d of %d features across %d packs (%.0f%%)'
              % (tot_d, tot_f, len(pruned), 100 * tot_d / max(1, tot_f)))
        for slug, fn, d, t in sorted(pruned, key=lambda p: -p[2])[:8]:
            print('   %-30s %5d of %6d dropped' % (slug, d, t))
        print('   re-upload just this layer:  '
              'upload_garmin_to_r2.py --root <packs> --layers waterbody')

    moved.sort(reverse=True)
    if moved:
        print('\nbiggest increases:')
        for d, s, o, n in moved[:8]:
            print('   %-30s %.2f -> %.2f  (+%.2f)' % (s, o, n, d))
        print('biggest decreases:')
        for d, s, o, n in moved[-5:]:
            print('   %-30s %.2f -> %.2f  (%.2f)' % (s, o, n, d))
    print('\n-> %s' % a.report)
    print('re-run consolidate_lake_index.py afterwards so lake_index.json picks this up.')


if __name__ == '__main__':
    main()
