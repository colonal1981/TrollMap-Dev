#!/usr/bin/env python3
r"""triage_water_bindings.py - turn the 647-row gauge review into the handful a person must judge.

Personal use only, not for distribution or resale; not for navigation.

    py .\scripts\triage_water_bindings.py --registry "F:\TrollMapPipeline\registry"

WHY THIS EXISTS

`registry/_water_bindings_review.json` has carried `review_geom_only: 647` since 2026-08-06, and
three separate work lists called it "the highest-value manual work on the board" without ever
saying what the work IS. Ryan, 2026-08-13: "i am not hand reviewing 647 gauges... plus i have
never been told what to look at... where the information is to look at or even why i am looking
at it." Fair on all three counts.

WHAT A BINDING IS FOR

`registry/water_bindings.json` is what `Worker/conditions.js:360` reads to answer "what is the
water doing right now" for a slug. No binding, no stage, no flow, no rising-or-falling. Today 221
of the 864 lakes the app offers have one and 643 do not.

Each binding has a `pool` -- the one gauge trusted to speak for the water, which needs its NAME to
match as well as its position -- and a `gauges[]` list of everything else nearby. The 647 rows are
candidates that matched on POSITION ONLY: the gauge sits inside the boundary, or within a few km
of it, but nothing in its name says it is this water.

WHY POSITION ALONE IS NOT ENOUGH, AND WHY THAT IS MOSTLY MECHANICAL

The failure mode is the neighbouring impoundment. A gauge reading "Tennessee River above Ft.
Loudoun Dam" sits geometrically inside Tellico Lake's boundary and belongs to Fort Loudoun. Seed
Lake's nearest gauge is at Burton Dam, which is Lake Burton. Binding those would put another
lake's water level on this lake's page -- the across-the-dam error that got
`restitch_water_graphs.py` retracted.

That question does not need a person. If the gauge sits inside a DIFFERENT registry water, it is
that water's gauge. This script asks exactly that, by point-in-polygon against every boundary.

THE FUNNEL, measured 2026-08-13

    647  rows in the review file
    124  rows whose slug is IN lake_index.json and has no binding today
     97  rows whose gauge is not inside some other registry water
     67  lakes still holding at least one candidate
     17  of those with more than one, so a choice actually exists

WHAT TO LOOK AT, AND WHERE

One question per row: is this gauge ON this water? Not near it, not upstream past a dam -- on it.
Two links per row answer it: a map link at the gauge's own coordinates, and its NWPS page, which
names the river and shows the reach.

ANSWER IN THE `keep` COLUMN, then re-run with `--accept`. y/yes/1/x keeps a row, anything else
rejects it, and blank means unanswered. Answers survive a re-run -- the worklist is read before
it is rewritten -- so you can do a few at a time.

`--accept` writes the kept rows into `water_bindings.json` as `gauges[]` entries at `geom_only`
confidence. With no answers at all it falls back to every single-candidate row, which is the old
behaviour. It never writes `pool` -- promoting a gauge to pool is a name-and-geometry decision
and stays a human one.

Two candidates on one lake is the case the column exists for: mark the right one `y` and the
other `n`, which is a thing --accept could not previously express at all.
"""
import argparse, csv, json, os, sys


def _rings(geom):
    if not geom:
        return
    t = geom.get('type')
    if t == 'Polygon':
        polys = [geom.get('coordinates') or []]
    elif t == 'MultiPolygon':
        polys = geom.get('coordinates') or []
    else:
        return
    for poly in polys:
        for i, ring in enumerate(poly or []):
            if ring and len(ring) >= 4:
                yield ring, (i > 0)


def _in_ring(pt, ring):
    x, y = pt
    n = len(ring)
    c = False
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-15) + xi):
            c = not c
        j = i
    return c


def _in_geom(pt, geom):
    """Inside an outer ring and not inside one of its holes."""
    hit = False
    for ring, hole in _rings(geom):
        if _in_ring(pt, ring):
            if hole:
                return False
            hit = True
    return hit


def owner_of(pt, exclude, bounds, bdir, cache):
    """Which OTHER registry water contains this point. Bounds first, geometry second."""
    for slug, bx in bounds:
        if slug == exclude:
            continue
        if not (bx[0] <= pt[0] <= bx[2] and bx[1] <= pt[1] <= bx[3]):
            continue
        if slug not in cache:
            fp = os.path.join(bdir, slug + '.geojson')
            try:
                gj = json.load(open(fp, encoding='utf-8'))
                # EVERY feature. A boundary is routinely a MultiPolygon or a collection of
                # basins, and reading features[0] is how half a lake goes missing.
                cache[slug] = [f.get('geometry') for f in (gj.get('features') or [gj])
                               if f.get('geometry')]
            except (OSError, ValueError):
                cache[slug] = []
        for g in cache[slug]:
            if _in_geom(pt, g):
                return slug
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', required=True)
    ap.add_argument('--out', help='TSV worklist. Default <registry>/../outputs/gauge_worklist.tsv')
    ap.add_argument('--accept-all-singles', action='store_true',
                    help='take every single-candidate row even though the worklist is '
                         'unanswered. The old --accept behaviour, now explicit.')
    ap.add_argument('--accept', action='store_true',
                    help='write the single-candidate rows into water_bindings.json as gauges[] '
                         'entries. Never sets pool. Default is to write nothing.')
    a = ap.parse_args()

    reg = a.registry
    for f in ('water_bindings.json', 'lake_index.json', '_water_bindings_review.json',
              'lakes.json', '_nwps_gauges.json'):
        if not os.path.exists(os.path.join(reg, f)):
            sys.exit('missing %s' % os.path.join(reg, f))

    def load(f):
        return json.load(open(os.path.join(reg, f), encoding='utf-8'))

    bindings = load('water_bindings.json').get('bindings') or {}
    index = load('lake_index.json')
    review = load('_water_bindings_review.json').get('review_geom_only') or []
    lakes = load('lakes.json').get('lakes')
    meta = {r['slug']: r for r in lakes} if isinstance(lakes, list) else (lakes or {})

    loc = {}
    for g in (load('_nwps_gauges.json').get('gauges') or []):
        lid = (g.get('lid') or '').upper()
        if lid and g.get('latitude') is not None and g.get('longitude') is not None:
            loc[lid] = (float(g['longitude']), float(g['latitude']))

    bdir = os.path.join(reg, 'boundaries')
    bounds = [(s, v['bounds_wsen']) for s, v in meta.items() if v.get('bounds_wsen')]
    cache = {}

    # Every drop is counted and printed. A funnel that reports only its output reads as
    # "that is all there was".
    n_notindex = n_bound = n_owned = n_nocoord = 0
    keep = {}
    for r in review:
        slug = r['slug']
        if slug not in index:
            n_notindex += 1
            continue
        if slug in bindings:
            n_bound += 1
            continue
        pt = loc.get((r.get('lid') or '').upper())
        if not pt:
            n_nocoord += 1
            continue
        e = keep.setdefault(slug, {'rows': [], 'owned': []})
        own = owner_of(pt, slug, bounds, bdir, cache)
        if own:
            n_owned += 1
            e['owned'].append(dict(r, owned_by=own))
        else:
            e['rows'].append(dict(r, xy=pt))

    live = {s: v for s, v in keep.items() if v['rows']}
    rows = sum(len(v['rows']) for v in live.values())
    multi = [s for s, v in live.items() if len(v['rows']) > 1]

    print('%d rows in %s' % (len(review), os.path.join(reg, '_water_bindings_review.json')))
    print('   -%-5d lake is not in lake_index.json, so the app cannot offer it' % n_notindex)
    print('   -%-5d lake is already bound; the gauge is already carried in gauges[]' % n_bound)
    print('   -%-5d gauge lid is not in the NWPS roster, so it has no position' % n_nocoord)
    print('   -%-5d gauge sits INSIDE a different registry water -- it is that water gauge'
          % n_owned)
    print('   =%-5d row(s) worth a human look, over %d lake(s)' % (rows, len(live)))
    print('        %d of those lakes have more than one candidate, so a choice exists'
          % len(multi))
    lost = [s for s, v in keep.items() if not v['rows'] and v['owned']]
    if lost:
        print('   (%d lake(s) lost every candidate to the ownership test and have no gauge)'
              % len(lost))

    out = a.out or os.path.join(os.path.dirname(reg.rstrip('\\/')), 'outputs',
                                'gauge_worklist.tsv')
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)

    # ANSWERS SURVIVE A RE-RUN. Rewriting the worklist would otherwise erase the column you
    # just filled in, which is the one thing that must never happen to a file a human typed in.
    # utf-8-SIG, AND A BACKUP BEFORE THE REWRITE. Both because of a real loss, 2026-08-15.
    #
    # Ryan answered all twelve rows n, saved from Excel, and re-ran. Excel writes a UTF-8 BOM,
    # so with encoding='utf-8' the first fieldname parsed as '\ufeffkeep' -- row.get('keep')
    # returned None on every row, prior came back empty, and THIS FUNCTION THEN OVERWROTE HIS
    # FILE WITH BLANKS. --accept saw no answers, fell back to "every single-candidate row", and
    # wrote ten bindings he had just rejected.
    #
    # I had written "answers survive a re-run" in the docstring one message earlier. They
    # survive a re-run only if the read succeeds, and a silent except made a failed read look
    # like an unanswered file. So: read the BOM, and copy the file aside before touching it, so
    # a parse I did not anticipate costs a rename instead of somebody's work.
    prior, parse_err, existing_rows = {}, None, 0
    if os.path.exists(out):
        try:
            with open(out, encoding='utf-8-sig', newline='') as fh:
                for row in csv.DictReader(fh, delimiter='\t'):
                    existing_rows += 1
                    v = (row.get('keep') or '').strip()
                    if v and row.get('slug') and row.get('lid'):
                        prior[(row['slug'], row['lid'])] = v
        except Exception as e:
            parse_err = '%s: %s' % (type(e).__name__, e)
        try:
            import shutil
            shutil.copyfile(out, out + '.prev')
        except Exception:
            pass
    if prior:
        print('   carried %d answer(s) forward from the existing worklist' % len(prior))
    elif existing_rows:
        print('   !! the existing worklist has %d row(s) and NO answers in `keep`.' % existing_rows)
        print('      If you filled it in, the previous copy is at %s.prev -- check the' % out)
        print('      delimiter is still TAB and the first column header is still `keep`.')
    if parse_err:
        print('   !! could not parse the existing worklist (%s) -- previous copy kept at %s.prev'
              % (parse_err, out))

    order = sorted(live, key=lambda s: (-(meta.get(s, {}).get('area_km2') or 0), s))
    with open(out, 'w', encoding='utf-8', newline='') as fh:
        w = csv.writer(fh, delimiter='\t')
        # `keep` FIRST and EMPTY, because the answer is the point of the file. The worklist
        # used to be write-only: it asked one question per row and --accept ignored it
        # entirely, taking every single-candidate row instead. So there was no way to accept
        # one, or two, or the second of two -- only all-or-nothing over rows nobody had read.
        # Ryan, 2026-08-15: "telling me how to handle these... and how to accept 1 or 2 or none
        # or whatever". Type y or n in this column, save, re-run with --accept.
        w.writerow(['keep', 'slug', 'lake', 'acres', 'n', 'lid', 'gauge', 'geom', 'km_outside',
                    'xy', 'map', 'nwps'])
        for s in order:
            m = meta.get(s, {})
            ac = (m.get('area_km2') or 0) * 247.105
            for r in sorted(live[s]['rows'], key=lambda r: r.get('km_outside') or 0):
                lon, lat = r['xy']
                w.writerow([prior.get((s, r['lid']), ''),
                            s, m.get('name', ''), '%.0f' % ac, len(live[s]['rows']),
                            r['lid'], r['gauge'], r['geom'],
                            '%.2f' % (r.get('km_outside') or 0),
                            '%.6f, %.6f' % (lon, lat),
                            'https://www.google.com/maps?q=%.5f,%.5f' % (lat, lon),
                            'https://water.noaa.gov/gauges/%s' % r['lid']])
    print('-> %s' % out)
    print('   one question per row: is this gauge ON this water, or past a dam from it?')

    if not a.accept:
        print('\nDRY RUN -- nothing written to water_bindings.json. '
              'Add --accept for the single-candidate rows.')
        return 0

    # ANSWERED ROWS WIN. With a `keep` column filled in, that is the instruction -- including
    # for a lake with two candidates, where the whole question is WHICH one. Fall back to
    # "every single-candidate row" only when nobody has answered anything, which is the old
    # behaviour and is right for a first pass over a short list.
    yes = {(sl, li) for (sl, li), v in prior.items() if v.strip().lower() in ('y', 'yes', '1', 'true', 'x')}
    answered = {sl for sl, _li in prior}
    picked = []
    if yes or answered:
        for s in live:
            hits = [r for r in live[s]['rows'] if (s, r['lid']) in yes]
            if len(hits) > 1:
                print('   SKIP %s -- %d rows marked keep; a water gets one gauge per row here'
                      % (s, len(hits)))
                continue
            if hits:
                picked.append((s, hits[0]))
        # ROWS, not slugs. This counted `answered` (a set of SLUGS) against `yes` (a set of
        # ROWS), so twelve answers over eleven lakes printed "12 answered, 11 rejected" and
        # left you wondering what happened to the twelfth. Tugaloo has two rows.
        print('\n%d row(s) answered: %d kept, %d rejected'
              % (len(prior), len(yes), len(prior) - len(yes)))
    elif existing_rows:
        # A worklist that EXISTS and has no answers is an unanswered worklist, not consent to
        # bind everything in it. Writing ten rows Ryan had marked `n` is what this branch used
        # to do. --accept-all-singles is still available, but it has to be asked for.
        print('\nno `keep` answers found in a worklist that has %d row(s) -- writing NOTHING.'
              % existing_rows)
        print('   Answer the `keep` column, or pass --accept-all-singles to take every '
              'single-candidate row.')
        if not a.accept_all_singles:
            return 0
        picked = [(s, live[s]['rows'][0]) for s in live if len(live[s]['rows']) == 1]
        print('   --accept-all-singles given: taking all %d' % len(picked))
    else:
        picked = [(s, live[s]['rows'][0]) for s in live if len(live[s]['rows']) == 1]
        print('\nno worklist existed -- falling back to every single-candidate row')
    singles = [s for s, _r in picked]
    fp = os.path.join(reg, 'water_bindings.json')
    doc = json.load(open(fp, encoding='utf-8'))
    for s, r in picked:
        m = meta.get(s, {})
        lon, lat = r['xy']
        doc['bindings'][s] = {
            'slug': s, 'display_name': m.get('name', s), 'state': m.get('state'),
            'feature_type': m.get('feature_type'), 'centroid': m.get('centroid'),
            'pool': None,      # never set here -- pool needs a name match, which is Ryan's call
            'gauges': [{'lid': r['lid'], 'name': r['gauge'], 'lat': lat, 'lon': lon,
                        'confidence': 'geom_only',
                        'km_outside': r.get('km_outside') or 0}],
        }
    tmp = fp + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(doc, fh, indent=1)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, fp)
    print('%d lake(s) written to %s with pool=None' % (len(picked), fp))
    print('   re-upload with upload_garmin_to_r2.py, then verify_registry_r2.py')
    return 0


if __name__ == '__main__':
    sys.exit(main())
