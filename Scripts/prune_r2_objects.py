#!/usr/bin/env python3
"""prune_r2_objects.py — delete an EXPLICIT list of R2 keys, one per line.

Personal use only, not for distribution or resale; not for navigation.

    py .\\prune_r2_objects.py --list "F:\\TrollMapPipeline\\registry\\_r2_delete.txt"
    py .\\prune_r2_objects.py --list "..." --go

WHY THIS EXISTS ALONGSIDE prune_r2_keys.py

`prune_r2_keys.py` deletes whole superseded KEYS, driven by key_map.json, and refuses to touch
anything in `curated_keys_with_no_registry_match`. That is the right tool for combined packs.

It cannot express "delete three LAYERS from sixteen coastal zones and leave the rest of each
zone alone", which is what the 2026-08-05 audit needs: the non-primary coastal zones ship
structure only, and are carrying contours / depth_areas / depth_soundings they should never
have had. So this takes an explicit, reviewable list of exact object keys.

THE LIST IS THE SAFETY MECHANISM. It is generated from R2's own listing, written to disk, and
meant to be read before `--go`. There is no globbing and no cleverness here on purpose: every
key that will be deleted is a line you can look at first.

A key that is already gone is reported and skipped, not treated as an error — re-running after
a partial failure is safe and is the intended recovery.

AND THE FAILURES ARE WRITTEN DOWN. Ryan, 2026-08-20, after a 6,827-key run: "deleted 6817,
already gone 0, failed 10". Those ten keys existed only in his terminal scrollback, because
this script printed them and kept no file — so "re-running is the intended recovery" meant
re-running all 6,827 to retry ten. Every run now writes `<list>.failed.txt` beside the list,
which is itself a valid --list, so recovery is:

    py .\\prune_r2_objects.py --list "...\\_r2_delete.txt.failed.txt" --go

The file is written even when nothing failed (holding a "# 0 failed" header), because an absent
file cannot be told apart from a run that never got to the end.
"""
import argparse
import os
import subprocess
import sys

BUCKET = os.environ.get("TROLLMAP_BUCKET", "trollmap-chartpacks")


def wrangler(*args, capture=True):
    """Run a wrangler r2 object subcommand.

    Bytes, not text — `text=True` decodes with the locale codepage, which on Windows is cp1252,
    and wrangler writes a UTF-8 banner. That raises UnicodeDecodeError inside subprocess's
    stdout reader thread on every call while the operation itself succeeds, so it looks like
    noise and is not. Same trap documented in prune_r2_keys.py and 00_START_HERE.md.
    """
    cmd = ["npx", "wrangler", "r2", "object", *args, "--remote"]
    p = subprocess.run(cmd, capture_output=capture, shell=(os.name == "nt"))
    out = b""
    if capture:
        out = (p.stdout or b"") + (p.stderr or b"")
    return p.returncode, out.decode("utf-8", errors="replace")


def write_report(list_path, failures, done, skipped):
    """Write the failed keys beside the list, as a file --list can read straight back.

    Comments carry the counts so the file explains itself a week later; prune_r2_objects.py
    skips '#' lines on read, so the same file is both a report and an input.
    """
    out = list_path + '.failed.txt'
    lines = ['# %d failed, %d deleted, %d already gone -- from %s'
             % (len(failures), done, skipped, os.path.basename(list_path)),
             '# re-run with:  py .\\prune_r2_objects.py --list "%s" --go' % out]
    for key, err in failures:
        lines.append('# %s' % err.strip().replace('\n', ' ')[:200])
        lines.append(key)
    with open(out, 'w', encoding='utf-8', newline='') as fh:
        fh.write('\n'.join(lines) + '\n')
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--list', required=True, help='file of object keys, one per line')
    ap.add_argument('--go', action='store_true', help='actually delete (default is a dry run)')
    ap.add_argument('--stop-on-error', action='store_true',
                    help='abort on the first failure instead of continuing')
    a = ap.parse_args()

    with open(a.list, encoding='utf-8-sig') as fh:
        keys = [l.strip() for l in fh if l.strip() and not l.startswith('#')]

    # A key with no slash is a whole prefix, not an object. wrangler would take it literally
    # and delete nothing, silently. Refuse rather than no-op.
    bad = [k for k in keys if '/' not in k]
    if bad:
        raise SystemExit('these are not object keys (no "/"): %s' % ', '.join(bad[:5]))

    print('MODE: %s' % ('DELETING' if a.go else 'DRY RUN -- nothing will be removed'))
    print('bucket: %s' % BUCKET)
    print('%d keys in %s\n' % (len(keys), a.list))

    if not a.go:
        for k in keys:
            print('  would delete  %s' % k)
        print('\n%d objects would be deleted. Add --go.' % len(keys))
        return 0

    done = skipped = 0
    failures = []
    try:
        for i, k in enumerate(keys, 1):
            rc, out = wrangler('delete', '%s/%s' % (BUCKET, k))
            if rc == 0:
                done += 1
                print('  [%4d/%d] deleted  %s' % (i, len(keys), k))
            elif 'not found' in out.lower() or '404' in out:
                skipped += 1
                print('  [%4d/%d] gone already  %s' % (i, len(keys), k))
            else:
                failures.append((k, out))
                print('  [%4d/%d] FAILED   %s\n      %s' % (i, len(keys), k, out.strip()[:180]))
                if a.stop_on_error:
                    break
    finally:
        # A run this long gets interrupted. The report is written on the way out either way,
        # so a Ctrl-C at key 4,000 still leaves a record of what failed before it.
        report = write_report(a.list, failures, done, skipped)
    print('\ndeleted %d, already gone %d, failed %d' % (done, skipped, len(failures)))
    print('report -> %s' % report)
    if failures:
        print('re-run just those:  py .\\prune_r2_objects.py --list "%s" --go' % report)
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
