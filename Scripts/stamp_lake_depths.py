#!/usr/bin/env python3
r"""stamp_lake_depths.py -- put max and average depth on the registry row, once.

    py .\scripts\stamp_lake_depths.py
    py .\scripts\stamp_lake_depths.py --jobs 4
    py .\scripts\stamp_lake_depths.py --lake wateree_lake --dry-run

WHY THIS EXISTS

Ryan, 2026-09-04: "but that doesn't fix that depth still needs to be stamped somewhere for
smartplan right... because smartplan needs the info?"

It does. `Max depth` and `Average depth` are two of the lines researchIntel() prints into the
plan prompt, and they are computed from `depth_areas.geojson`. Pick Water downloads that file
because it draws a bathymetry map from it; Smart Plan draws no such map and does not download it.
So a Smart Plan could only ever get those two numbers out of a stored research profile -- and 3 of
80 mirrored profiles carry them. Item 2 of the research refactor: the pipeline works them out once
and both tabs read a property.

THE FILE IS THE REASON THIS IS A BATCH AND NOT A FETCH. Measured on the pipeline copies:

    lake_russel                   0.1 MB      35 polys
    wateree_lake                 18.6 MB   6,697 polys
    lake_murray                 174.7 MB  49,489 polys
    j_strom_thurmond_reservoir  255.0 MB  71,651 polys

Two numbers are not worth a quarter-gigabyte parse in a browser tab, and they do not change
between Garmin card updates -- which is the cadence this runs at, beside fit_trolling_runs.py.

ONE DEFINITION OF THE NUMBERS. This shells out to Scripts/lake_depth_stats.mjs, which imports
deriveDepthStatistics() from js/utils/pack-facts.js -- the same function the browser runs. The
same shape as build_dnr_ramps_by_lake.py running js/data/ga-access-species.js under node rather
than keeping a second copy of the Georgia species columns. A number the browser and the pipeline
both compute is a number they can disagree about, and this codebase has paid for that three times.

AND A LIVE MEASUREMENT STILL BEATS THE STAMP. Pick Water has the depth areas in hand, so where it
measures a depth that number is newer than anything written here. registryIdentity() in
js/modules/plan-inputs.js puts the pack first, this second, the profile third.

WHAT IT WRITES, and nothing else:

    max_depth_ft        always, when the pack yields one
    avg_depth_ft        only when deriveDepthStatistics says `ok` -- it wants 65% polygon
                        coverage of the boundary, or three distinct bands when there is no
                        boundary. A partial average is REPORTED and not written: an untrustworthy
                        number that looks like a trustworthy one is worse than a blank.
    depth_stamp         {bytes, mtime} of the depth file it read, so a re-run skips a pack whose
                        chart has not moved. Same idea as chartpack/<slug>/_stamps.json.

Personal use only, not for distribution or resale; not for navigation.
"""
import argparse
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
NODE_SCRIPT = os.path.join(HERE, 'lake_depth_stats.mjs')
# 255 MB of GeoJSON parses to several GB of objects. Node's default heap is not enough for
# Thurmond and the failure is an OOM kill, not an exception, so it is raised here rather than
# discovered on the one pack that matters most.
NODE_HEAP_MB = 8192


def pack_dir(root, row):
    return os.path.join(root, row.get('r2_key') or row.get('pack') or row.get('slug') or '')


def depth_file(pd):
    p = os.path.join(pd, 'depth_areas.geojson')
    if os.path.isfile(p):
        return p
    p = os.path.join(pd, 'contours.geojson')
    return p if os.path.isfile(p) else None


def stamp_of(path):
    st = os.stat(path)
    return {'bytes': st.st_size, 'mtime': int(st.st_mtime)}


def run_one(pd, boundary):
    cmd = ['node', f'--max-old-space-size={NODE_HEAP_MB}', NODE_SCRIPT, pd]
    if boundary and os.path.isfile(boundary):
        cmd.append(boundary)
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=900, cwd=HERE)
    except subprocess.TimeoutExpired:
        return {'error': 'timed out after 900 s'}
    out = (r.stdout or '').strip()
    if not out:
        return {'error': (r.stderr or 'no output').strip().splitlines()[-1][:200]}
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return {'error': f'unparsable output: {out[:160]}'}


def apply_result(row, stamp, res):
    """Write what the pack answered onto the row. Returns 'trusted', 'max only' or 'failed'.

    THE AVERAGE IS ONLY WRITTEN WHEN deriveDepthStatistics SAYS SO. It wants 65% polygon coverage
    of the boundary, or three distinct bands when there is no boundary, and on a river corridor or
    a coastal bbox the bands cover a fraction of the polygon -- measured card-wide, 43 of 355 rows
    refuse, and they are the 13 coastal zones and ~27 rivers. An "average depth" across a coastal
    zone is not a number about fishing, and one that looks like the other 312 is worse than a blank.

    AND A STALE AVERAGE IS REMOVED RATHER THAN LEFT. If a re-cut chart drops a water below the bar,
    the old average must not stand beside the new max as though both came off the same pack.
    """
    if res.get('error') or not res.get('maxDepthFt'):
        return 'failed'
    row['max_depth_ft'] = res['maxDepthFt']
    row['depth_stamp'] = stamp
    if res.get('ok') and res.get('averageDepthFt'):
        row['avg_depth_ft'] = res['averageDepthFt']
        return 'trusted'
    row.pop('avg_depth_ft', None)
    return 'max only'


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--index', default=r'F:\TrollMapPipeline\registry\lake_index.json')
    ap.add_argument('--chartpack', default=r'F:\TrollMapPipeline\chartpack')
    ap.add_argument('--boundaries', default=r'F:\TrollMapPipeline\registry\boundaries')
    ap.add_argument('--jobs', type=int, default=1,
                    help='parallel node processes. Each big pack wants several GB, so 4 is the '
                         'sensible ceiling on a 32 GB machine and 1 is safe anywhere.')
    ap.add_argument('--lake', help='one slug, for checking a single water')
    ap.add_argument('--force', action='store_true', help='ignore depth_stamp and redo everything')
    ap.add_argument('--dry-run', action='store_true', help='report, write nothing')
    a = ap.parse_args()

    with open(a.index, encoding='utf-8') as fh:
        idx = json.load(fh)

    todo, skipped, nopack = [], 0, []
    for slug, row in sorted(idx.items()):
        if a.lake and slug != a.lake:
            continue
        pd = pack_dir(a.chartpack, row)
        df = depth_file(pd) if os.path.isdir(pd) else None
        if not df:
            nopack.append(slug)
            continue
        st = stamp_of(df)
        if not a.force and row.get('depth_stamp') == st and row.get('max_depth_ft'):
            skipped += 1
            continue
        todo.append((slug, row, pd, st, os.path.getsize(df)))

    print(f'{len(idx)} rows: {len(todo)} to measure, {skipped} unchanged, '
          f'{len(nopack)} with no depth file', flush=True)
    if not todo:
        return

    # Biggest first: on --jobs > 1 that keeps the long tail from being one 255 MB pack running
    # alone at the end, and on --jobs 1 it surfaces an out-of-memory failure in the first minute
    # rather than the fortieth.
    todo.sort(key=lambda t: -t[4])

    done = {'n': 0}
    total = len(todo)
    t0 = time.time()
    results = {}

    def work(item):
        slug, row, pd, st, size = item
        b = os.path.join(a.boundaries, f'{slug}.geojson')
        t = time.time()
        res = run_one(pd, b)
        done['n'] += 1
        note = res.get('error') or (
            f"max {res.get('maxDepthFt')} ft, avg {res.get('averageDepthFt')} ft"
            if res.get('ok') else
            f"max {res.get('maxDepthFt')} ft, average NOT trusted "
            f"(coverage {res.get('coverage')}, {res.get('bandCount')} bands"
            + (f", partial {res['averageDepthFtPartial']}" if res.get('averageDepthFtPartial') else '')
            + ')')
        print(f"  [{done['n']:>4}/{total}] {slug:<34} {size/1e6:7.1f} MB  "
              f"{time.time() - t:5.1f} s  {note}", flush=True)
        results[slug] = (row, st, res)

    if a.jobs > 1:
        with ThreadPoolExecutor(max_workers=a.jobs) as pool:
            list(pool.map(work, todo))
    else:
        for item in todo:
            work(item)

    wrote = trusted = failed = 0
    for slug, (row, st, res) in results.items():
        verdict = apply_result(row, st, res)
        if verdict == 'failed':
            failed += 1
            continue
        wrote += 1
        if verdict == 'trusted':
            trusted += 1
    maxonly = wrote - trusted

    print(f'\n{wrote} row(s) stamped: {trusted} with a trusted average, '
          f'{maxonly} max only, {failed} failed. '
          f'{time.time() - t0:.0f} s', flush=True)

    if a.dry_run:
        print('--dry-run: index NOT written', flush=True)
        return
    if not wrote:
        print('nothing to write', flush=True)
        return
    tmp = a.index + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(idx, fh, indent=1)
    os.replace(tmp, a.index)
    print(f'-> {a.index}', flush=True)
    print('   now re-run upload_garmin_to_r2.py so the Worker serves the new rows.', flush=True)


if __name__ == '__main__':
    main()
