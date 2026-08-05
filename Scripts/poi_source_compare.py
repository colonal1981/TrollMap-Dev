#!/usr/bin/env python3
"""poi_source_compare.py - does Garmin already have i-Boating's POIs?

Personal use only, not for distribution or resale; not for navigation.

PowerShell:

    py .\\poi_source_compare.py `
       --garmin   "F:\\TrollMapPipeline\\chartpack" `
       --iboating "F:\\TrollMapPipeline\\I-Boating Contours and supplemental data\\supplemental" `
       --out      "F:\\TrollMapPipeline\\registry\\_poi_source_compare.json"

THE QUESTION THIS ANSWERS

Ryan, 2026-08-06: *"POIs need to be reviewed they may have some garmin doesn't... does garmin
have all of the i-Boating POI... so we know what to keep from I-boating"*

`IBOATING_SUPPLEMENTALS_2026-08-06.md` lists this as decision #1, before the coastal uploader is
touched at all: contours and depth_areas are settled (Garmin, i-Boating dead), fishing lines and
points are settled (i-Boating, no Garmin equivalent), and POIs are the one open question.

**It must run AFTER the navaid re-extract.** The first comparison was made against a broken
extract that reported zero Garmin navaids -- Ryan called it: "there is 0 chance this right... i
know the answer... claude screwed up the extraction... again." The fixed decode puts 68 navaids
on B4E0F1 alone, so the answer may invert completely.

METHOD

For every slug present in both sources, each i-Boating POI is matched against Garmin POIs by
DISTANCE and TYPE. Unmatched means i-Boating holds something Garmin does not.

Distance alone is not enough and the reason is on record: a Garmin "Fish Attractor Buoy" is a
NAVAID marking an attractor, not the attractor -- calling them the same thing once made the app
treat a charted buoy as a registered SCDNR attractor. So a type that maps to nothing comparable
is reported separately rather than silently counted as a match.

This script only READS. It writes one JSON report and changes nothing.
"""
import argparse, json, gzip, os, math, sys, collections

def load_fc(path):
    op = gzip.open if path.endswith('.gz') else open
    with op(path, 'rt', encoding='utf-8', errors='replace') as f:
        d = json.load(f)
    return d.get('features') or []

def first_existing(*paths):
    for p in paths:
        if p and os.path.exists(p):
            return p
    return None

def pt(f):
    g = f.get('geometry') or {}
    if g.get('type') != 'Point':
        return None
    c = g.get('coordinates') or []
    return (c[0], c[1]) if len(c) >= 2 else None

def metres(a, b):
    (x1, y1), (x2, y2) = a, b
    mx = 111320.0 * math.cos(math.radians((y1 + y2) / 2))
    return math.hypot((x2 - x1) * mx, (y2 - y1) * 110540.0)

# BOTH SOURCES USE THE SAME VOCABULARY. Measured across 979 packs on 2026-08-06, Garmin's own
# poi_type values include `mile_marker` (2,920), `slow_no_wake` (606), `nav_buoy` (477),
# `danger_buoy` (288), `obstruction` (4,661), `fish_attractor_buoy` (34), `caution_buoy` (7) --
# the exact strings i-Boating uses, because both went through this project's own decoder.
#
# The first version of this script hand-wrote a translation table with keys like `buoy` and
# `light` that exist in NEITHER dataset, so every navaid fell through to "no Garmin equivalent"
# and the report claimed Garmin had no mile markers when it has nearly three thousand. Ryan
# caught it: "garmin absolutely has these... we are still missing something."
#
# So: SAME NAME IS A MATCH, by default. This table is only for the handful that genuinely differ
# in spelling, and it is additive to identity -- never a replacement for it.
TYPE_EQUIV = {
    'ramp':           {'boat_ramp'},
    'launch':         {'boat_ramp'},
    'nav_light':      {'nav_buoy', 'caution_buoy', 'danger_buoy'},
    'nav_beacon':     {'nav_buoy', 'caution_buoy', 'danger_buoy'},
    'light':          {'nav_buoy', 'caution_buoy'},
    'beacon':         {'nav_buoy', 'caution_buoy'},
    'buoy':           {'nav_buoy', 'danger_buoy', 'caution_buoy'},
    'danger':         {'danger_buoy', 'obstruction', 'hazard_area'},
    'hazard':         {'danger_buoy', 'obstruction', 'hazard_area'},
    'fish_attractor': {'fish_attractor', 'fish_attractor_buoy'},
    'dock':           {'marina', 'pile'},
    'campground':     {'campground', 'recreation'},
}

def typ(f, keys):
    p = f.get('properties') or {}
    for k in keys:
        v = p.get(k)
        if v:
            return str(v).strip().lower()
    return ''

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--garmin', required=True, help='chartpack/ root, <slug>/pois.geojson')
    ap.add_argument('--iboating', required=True, help='supplemental/ root, <slug>/pois.geojson')
    ap.add_argument('--out', required=True)
    ap.add_argument('--radius-m', type=float, default=60.0,
                    help='two points this close, of comparable type, are the same feature '
                         '(default 60 -- Garmin POIs are good to a few metres, i-Boating is '
                         'digitised from raster charts and is looser)')
    ap.add_argument('--verbose', action='store_true')
    a = ap.parse_args()

    slugs = sorted(d for d in os.listdir(a.iboating)
                   if not d.startswith('_')
                   and os.path.isdir(os.path.join(a.iboating, d)))
    print('%d i-Boating slug dirs' % len(slugs))

    # Garmin's whole type vocabulary, gathered first, so "Garmin has no such thing" can be
    # distinguished from "Garmin has none HERE".
    garmin_vocab = set()
    for slug in slugs:
        gp = first_existing(os.path.join(a.garmin, slug, 'pois.geojson'),
                            os.path.join(a.garmin, slug, 'pois.geojson.gz'))
        if not gp:
            continue
        for f in load_fc(gp):
            v = typ(f, ('poi_type', 'type', 'feature_type'))
            if v:
                garmin_vocab.add(v)
    print('garmin poi_type vocabulary: %d distinct types' % len(garmin_vocab))

    report, no_garmin = {}, []
    tot_ib = tot_unique = tot_matched = tot_unmapped = 0
    unique_types = collections.Counter()
    unmapped_types = collections.Counter()

    for slug in slugs:
        ib_path = first_existing(os.path.join(a.iboating, slug, 'pois.geojson'),
                                 os.path.join(a.iboating, slug, 'pois.geojson.gz'))
        if not ib_path:
            continue
        g_path = first_existing(os.path.join(a.garmin, slug, 'pois.geojson'),
                                os.path.join(a.garmin, slug, 'pois.geojson.gz'))
        ib = [f for f in load_fc(ib_path) if pt(f)]
        if not g_path:
            # No Garmin pack for this water at all. Not a POI question -- a coverage question,
            # and IBOATING_SUPPLEMENTALS already has a bucket for it. Kept apart deliberately.
            no_garmin.append({'slug': slug, 'iboatingPois': len(ib)})
            continue

        gm = [f for f in load_fc(g_path) if pt(f)]
        gm_pts = [(pt(f), typ(f, ('poi_type', 'type', 'feature_type'))) for f in gm]

        uniq, matched, unmapped = [], 0, 0
        for f in ib:
            p = pt(f)
            t = typ(f, ('type', 'feature_type', 'poi_type', 'category'))
            equiv = TYPE_EQUIV.get(t, set())
            hit = False
            for gp, gt in gm_pts:
                if metres(p, gp) > a.radius_m:
                    continue
                if gt == t or gt in equiv:      # identity first, spelling table second
                    hit = True
                    break
            if hit:
                matched += 1
            else:
                uniq.append({'type': t, 'name': (f.get('properties') or {}).get('name'),
                             'lat': round(p[1], 5), 'lon': round(p[0], 5)})
                unique_types[t or '(none)'] += 1
                # Separately: is this a CONCEPT Garmin never records anywhere, or just a feature
                # it does not have at this spot? Very different answers, and only the first is a
                # reason to keep i-Boating alive.
                if t and t not in garmin_vocab:
                    unmapped += 1
                    unmapped_types[t] += 1

        report[slug] = {'iboatingPois': len(ib), 'garminPois': len(gm),
                        'matched': matched, 'uniqueToIboating': len(uniq),
                        'unmappedType': unmapped, 'examples': uniq[:8]}
        tot_ib += len(ib); tot_matched += matched
        tot_unique += len(uniq); tot_unmapped += unmapped
        if a.verbose:
            print('  %-34s ib %4d  garmin %5d  matched %4d  unique %4d  unmapped %3d'
                  % (slug[:34], len(ib), len(gm), matched, len(uniq), unmapped))

    json.dump({'radiusM': a.radius_m, 'generatedBy': 'Scripts/poi_source_compare.py',
               'slugs': report, 'noGarminPack': no_garmin},
              open(a.out, 'w', encoding='utf-8'), indent=1)

    print('\n%d slugs compared, %d have i-Boating POIs but no Garmin pack' % (len(report), len(no_garmin)))
    print('i-Boating POIs total      %6d' % tot_ib)
    print('  matched by Garmin       %6d  (%.1f%%)' % (tot_matched, 100.0*tot_matched/max(1,tot_ib)))
    print('  UNIQUE to i-Boating     %6d  (%.1f%%)' % (tot_unique, 100.0*tot_unique/max(1,tot_ib)))
    print('  of which a type Garmin\n     never records at all  %6d  (%.1f%%)' % (tot_unmapped, 100.0*tot_unmapped/max(1,tot_ib)))
    if unique_types:
        print('\nwhat only i-Boating has, by type:')
        for t, n in unique_types.most_common(15):
            print('   %6d  %s' % (n, t))
    if unmapped_types:
        print('\ni-Boating types Garmin NEVER records anywhere -- the only real gap:')
        for t, n in unmapped_types.most_common(15):
            print('   %6d  %s' % (n, t))
    print('\n-> %s' % a.out)
    print('\nTHE DECISION: if "unique" is small and boring, i-Boating POIs join contours and')
    print('depth_areas as dead and the coastal uploader allow-list gets much simpler.')

if __name__ == '__main__':
    main()
