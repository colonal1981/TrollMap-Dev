#!/usr/bin/env python3
"""
find_r2_orphans.py -- list R2 objects whose local file is gone, and REFUSE to do it if the
packs are being written.

    py .\\scripts\\find_r2_orphans.py --packs chartpack
    py .\\scripts\\find_r2_orphans.py --packs chartpack --out chartpack\\_r2_orphans.txt

Feed the output to prune_r2_objects.py, which is a dry run until you pass --go.

WHY THIS IS A SCRIPT AND NOT A ONE-LINER, WHICH IS THE WHOLE POINT

On 2026-08-11 a hand-rolled version of this produced an 86-key deletion list while
`fit_trolling_runs.py` was running over the same folder. One of the keys was
`chatuge_lake/trolling_runs.geojson`. That file was not missing. The fitter had it open, and a
rescan twenty minutes later found it present.

Nothing about the list said so. It looked exactly like the other 85. Had it been fed to
prune_r2_objects.py --go it would have deleted a live object off the strength of a race, and the
manifest would then have agreed the object was gone -- so the next upload would have skipped it as
unchanged and the layer would have quietly stayed missing from R2.

    A DELETION LIST BUILT FROM A DIRECTORY BEING WRITTEN IS NOT A DELETION LIST.

So this refuses to write one. The runbook already says not to upload mid-fit; deleting mid-fit is
strictly worse, because an upload that races a write gets corrected by the next run and a delete
does not.

TWO PASSES, NOT ONE

The freshness check is not enough on its own -- a pack can be quiet for ten minutes because the
fitter is working through a big lake elsewhere and has not reached it yet. So this also scans
twice, a few seconds apart, and drops anything that changed between them. That catches the
chatuge case directly: it was absent in one scan and present in the next.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

# Every layer upload_garmin_to_r2.py can push. A key whose suffix is not in here is not something
# this script has any opinion about -- lakes.json, lake_index.json and water_bindings.json live in
# the same manifest and are not per-pack files.
LAYERS = {
    'contours.geojson', 'depth_areas.geojson', 'depth_regions.geojson', 'waterbodies.geojson',
    'docks.geojson', 'garmin_shoreline.geojson', 'pois.geojson', 'water_graph.bin',
    'structure.geojson', 'trolling_runs.geojson', 'water_features.geojson',
    'areas.geojson', 'boundary.geojson',
}

QUIET_S = 180.0          # nothing in the tree may have been written this recently
SETTLE_S = 8.0           # gap between the two scans


def scan(packs: str) -> tuple[set[str], float]:
    """Every per-pack object present right now, and the newest mtime seen."""
    have, newest = set(), 0.0
    for slug in os.listdir(packs):
        d = os.path.join(packs, slug)
        if not os.path.isdir(d):
            continue
        try:
            names = os.listdir(d)
        except OSError:
            continue
        for f in names:
            if f not in LAYERS:
                continue
            have.add(f'{slug}/{f}')
            try:
                newest = max(newest, os.path.getmtime(os.path.join(d, f)))
            except OSError:
                pass
    return have, newest


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--packs', required=True)
    ap.add_argument('--manifest', default=None, help='default <packs>/_r2_manifest.json')
    ap.add_argument('--out', default=None, help='write the key list here')
    ap.add_argument('--quiet-seconds', type=float, default=QUIET_S)
    ap.add_argument('--force', action='store_true',
                    help='write the list even if the tree looks busy. You want a reason.')
    a = ap.parse_args()

    man = a.manifest or os.path.join(a.packs, '_r2_manifest.json')
    if not os.path.isfile(man):
        print(f'no manifest at {man} -- nothing has been uploaded, so nothing is orphaned')
        return 0
    keys = {k for k in json.load(open(man, encoding='utf-8')) if k.rsplit('/', 1)[-1] in LAYERS}

    first, newest = scan(a.packs)
    age = time.time() - newest if newest else 1e9
    print(f'manifest objects   : {len(keys)}')
    print(f'on disk now        : {len(first)}')
    print(f'newest write       : {age / 60:.1f} min ago')

    busy = age < a.quiet_seconds
    if busy:
        print(f'\nSOMETHING IS WRITING TO {a.packs}. A file was touched {age:.0f} s ago and the '
              f'quiet threshold is {a.quiet_seconds:.0f} s.')

    print(f'settling for {SETTLE_S:.0f} s and scanning again...')
    time.sleep(SETTLE_S)
    second, _ = scan(a.packs)

    moved = first ^ second
    if moved:
        print(f'\n{len(moved)} object(s) CHANGED BETWEEN THE TWO SCANS:')
        for k in sorted(moved)[:20]:
            print(f'     {k}   ({"appeared" if k in second else "vanished"})')
        busy = True

    # Present in EITHER scan counts as present. A file that flickers is a file being written, and
    # the safe reading of "I saw it once" is that it exists.
    have = first | second
    orphans = sorted(keys - have)

    print(f'\nR2 objects with no local file: {len(orphans)}')
    by = {}
    for k in orphans:
        by[k.rsplit('/', 1)[-1]] = by.get(k.rsplit('/', 1)[-1], 0) + 1
    for name, n in sorted(by.items(), key=lambda x: -x[1]):
        print(f'     {name:26s} {n}')

    # WHY A PACK'S CONTOURS GO MISSING, WHICH IS NOT A DELETION AND NOT A BUG.
    #
    # build_all_chartpacks.py RETRACTS a layer: when a rebuild reads that layer and it comes back
    # with zero features, it removes the stale file, because leaving yesterday's file on disk
    # publishes the old answer as the current one. Its own comment says why it exists -- "this is
    # how 71 packs shipped pre-fix contours on 2026-08-06 ... a rebuild that can only overwrite and
    # never retract cannot be trusted to have rebuilt anything."
    #
    # So these R2 objects are exactly what the retraction was for: the pipeline has withdrawn the
    # answer locally and R2 is still serving it. PRUNING THEM IS THE POINT, not a risky call.
    #
    # What IS worth a look is the leftover below. structure.geojson is derived from the contours in
    # its own pack and is not retracted with them -- on pacolet_river the contours came from a file
    # dated 2026-08-05, structure was built from them at 10:46 on 08-06, and the rebuild that
    # retracted the contours ran at 19:57 the same day. build_structure.py skips a pack with no
    # contours, so nothing will ever refresh or remove those files on its own.
    odd = []
    for k in orphans:
        if not k.endswith('contours.geojson'):
            continue
        slug = k.split('/')[0]
        d = os.path.join(a.packs, slug)
        if os.path.isdir(d) and 'structure.geojson' in os.listdir(d):
            odd.append(slug)
    if odd:
        print(f'\n{len(odd)} pack(s) hold a structure.geojson built from contours the pipeline has '
              f'since retracted.\nThe contour prune above is correct; these are the leftovers, and '
              f'nothing refreshes them\nbecause build_structure.py skips a pack with no contours:')
        for s in sorted(odd)[:15]:
            print(f'     {s}')
        if len(odd) > 15:
            print(f'     ... and {len(odd) - 15} more')

    if busy and not a.force:
        print('\nREFUSING TO WRITE A DELETION LIST WHILE THE PACKS ARE BEING WRITTEN.')
        print('Let the fit finish, then run this again. --force overrides and you want a reason.')
        return 1

    if a.out:
        with open(a.out, 'w', encoding='utf-8') as fh:
            fh.write('\n'.join(orphans) + ('\n' if orphans else ''))
        print(f'\nwrote {a.out}')
        print('Read it before you pass it to prune_r2_objects.py --go. Nothing is deleted by this '
              'script or by that one without --go.')
    else:
        print('\n(no --out, so nothing was written)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
