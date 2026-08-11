#!/usr/bin/env python3
"""
restore_originals.py -- put every pack back to its ORIGINAL contour geometry.

    py .\\scripts\\restore_originals.py --packs chartpack            # check only, changes nothing
    py .\\scripts\\restore_originals.py --packs chartpack --write    # actually restore

WHY THIS EXISTS AND WHY IT IS NOT `copy /y`

`fit_trolling_runs.py --refit` does NOT restore anything. All it does is bypass the
"already fitted, skipping" guard. Point it at a pack that has been fitted and it fits the
FITTED FILE: a second pass smooths an already-smoothed line and re-applies the leg rules to
pieces already trimmed once. Measured on Wateree, 2026-08-09: 3,114 km -> 1,168 -> 902, and
nothing errored, because every number it printed was measured against the wrong baseline.

So before a card-wide refit, the packs have to be put back first. That is this.

THE BACKUP DIRECTORY HAS MORE THAN ONE FILE IN IT

`fit_trolling_runs.py` never overwrites an existing backup -- a second run writes
`trolling_runs.geojson.refit2`, a third `.refit3`, and so on. So the plain
`trolling_runs.geojson` in each backup folder is the OLDEST copy, which is the original
contour geometry. The numbered ones are previous fitted outputs and must never be restored.

IT CHECKS RATHER THAN TRUSTS

Every feature `fit_trolling_runs.py` writes carries a `fitted` flag, true or false, and no
other producer writes that key -- so its presence is an unambiguous record that a file is
output rather than input. This reads the head of each backup and REFUSES to restore one
that looks fitted, instead of assuming the naming convention held. That check is the whole
point of the script; the copying is incidental.

Dry by default. Nothing moves unless you pass --write.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys

PROBE = 200_000


def looks_fitted(path: str) -> bool | None:
    """True / False, or None if it cannot be read. Same test the fitter uses on itself."""
    try:
        with open(path, 'r', encoding='utf-8') as fh:
            return '"fitted"' in fh.read(PROBE)
    except Exception:
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--packs', required=True, help='the chartpack folder')
    ap.add_argument('--backup-dir', default=None,
                    help='default <packs>/../_to_delete/pre_fit_runs')
    ap.add_argument('--write', action='store_true', help='actually restore; otherwise dry run')
    ap.add_argument('--only', default=None, help='one slug')
    a = ap.parse_args()

    bak = a.backup_dir or os.path.join(os.path.dirname(os.path.abspath(a.packs)),
                                       '_to_delete', 'pre_fit_runs')
    if not os.path.isdir(bak):
        print('no backup folder at %s -- nothing has been fitted, nothing to restore' % bak)
        return 0

    slugs = sorted(os.listdir(bak))
    if a.only:
        slugs = [s for s in slugs if s == a.only]

    restore, skip_fitted, skip_missing, already = [], [], [], []
    for slug in slugs:
        src = os.path.join(bak, slug, 'trolling_runs.geojson')
        dst = os.path.join(a.packs, slug, 'trolling_runs.geojson')
        if not os.path.isfile(src):
            continue
        if not os.path.isfile(dst):
            skip_missing.append(slug)
            continue
        state = looks_fitted(src)
        if state is None:
            skip_missing.append(slug)
            continue
        if state:
            # The backup is itself an output. Restoring it would bake a fitted line in as if
            # it were chart geometry, which is worse than doing nothing.
            skip_fitted.append(slug)
            continue
        if looks_fitted(dst) is False:
            already.append(slug)          # pack is already original; leave it alone
            continue
        restore.append((slug, src, dst))

    print('backups found      : %d' % len(slugs))
    print('to restore         : %d' % len(restore))
    print('already original   : %d' % len(already))
    if skip_fitted:
        print('REFUSED (backup looks fitted, restoring it would bake in an output): %d'
              % len(skip_fitted))
        for s in skip_fitted[:12]:
            print('     %s' % s)
        if len(skip_fitted) > 12:
            print('     ... and %d more' % (len(skip_fitted) - 12))
    if skip_missing:
        print('unreadable or no pack: %d' % len(skip_missing))

    if not a.write:
        print('\nDRY RUN -- nothing changed. Add --write to do it.')
        return 0

    done = 0
    for slug, src, dst in restore:
        shutil.copy2(src, dst)          # copy, never move: the backup stays a backup
        done += 1
        if done % 50 == 0:
            print('  %d/%d' % (done, len(restore)), flush=True)
    print('\nrestored %d packs to original contour geometry' % done)
    print('the backups are untouched -- they are still in %s' % bak)
    return 0


if __name__ == '__main__':
    sys.exit(main())
