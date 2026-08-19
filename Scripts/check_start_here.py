#!/usr/bin/env python3
r"""check_start_here.py -- re-measure the facts 00_START_HERE.md asserts, and fail on drift.

    py .\scripts\check_start_here.py            # measure and diff. Exit 1 if anything moved.
    py .\scripts\check_start_here.py --bless    # accept the current values as the new truth
    py .\scripts\check_start_here.py --list     # what it checks and why each one matters

WHY THIS EXISTS

Ryan, 2026-08-12: *"if making a test for start here keeps it honest and requires you to keep it
up to date that would be great."*

That day the project re-derived, re-proposed or re-built **nine things that already existed** --
the aliases, the water bindings, `recompute_charted`, `install_registry_boundary.py`, the coastal
heavy layers, the 427-candidate sweep, the coastal cut line Ryan drew himself, the 0-3 dm
soundings gate, and the trolling-runs blocker. Every one had the same cause: a document described
a defect, the defect got fixed, and the document was never updated. `00_START_HERE.md` was
rewritten FIVE times that day and was still wrong at the end of it.

That is not carelessness, it is structural. The page restates facts that live on disk -- row
counts, file presence, a constant's value, an mtime ordering -- and **a restated fact is stale the
moment the thing it describes changes, with nothing anywhere to notice.**

HOW IT WORKS, AND WHY IT IS A SNAPSHOT RATHER THAN A PARSER

The obvious design is to parse the claims out of `00_START_HERE.md`. That is not possible: the
page lives in the claude.ai project, not on this disk, so nothing here can read it.

So the checks live here and their expected values live in `registry/_start_here_facts.json`. The
script re-measures, diffs, and exits 1 on any drift. `--bless` writes the new values -- and that
is the point: **blessing a change is the moment you are supposed to go update the page.** The
script cannot make anyone do it, but it can make the drift impossible to miss.

WHAT MAKES A GOOD CHECK HERE

Only facts the page ASSERTS and a reader would act on. A number that drifts every build is noise;
a fact whose change means the page is now lying is signal. So:

    counts that gate a decision      1,008 unbuildable rows is the registry-shrink argument
    a constant with a rule attached  SHOAL_DM = 3 is the whole soundings gate
    a file that must be ABSENT       a deleted module coming back means a revert went unnoticed
    a file that must be PRESENT      the halo, the alias default, the R2 verifier
    a claim already proven wrong     "coastal boundaries are rectangles" cost five repetitions

Deliberately NOT checked: anything that changes on every run for legitimate reasons (pack byte
sizes, individual lake acreage), and anything requiring the network -- R2 presence is
`verify_registry_r2.py`'s job and cannot be answered from here at all.

Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

FACTS = os.path.join('registry', '_start_here_facts.json')


def _j(p):
    with open(p, encoding='utf-8') as fh:
        return json.load(fh)


def _rows(doc):
    return doc if isinstance(doc, list) else (doc.get('lakes') or list(doc.values()))


def collect(root, repo):
    """Every fact, measured. Returns {key: value}. A key that cannot be measured returns None,
    which diffs loudly rather than silently passing."""
    R = lambda *p: os.path.join(root, *p)
    Q = lambda *p: os.path.join(repo, *p)
    out = {}

    def safe(key, fn):
        try:
            out[key] = fn()
        except Exception as exc:
            out[key] = 'ERROR: %s: %s' % (type(exc).__name__, exc)

    # ── counts that gate a decision ───────────────────────────────────────────────────────
    safe('lakes_json_rows', lambda: len(_rows(_j(R('registry', 'lakes.json')))))
    safe('lake_index_rows', lambda: len(_rows(_j(R('registry', 'lake_index.json')))))
    safe('boundaries', lambda: sum(1 for f in os.listdir(R('registry', 'boundaries'))
                                   if f.endswith('.geojson')))
    safe('chartpack_dirs', lambda: sum(1 for d in os.listdir(R('chartpack'))
                                       if os.path.isdir(R('chartpack', d)) and not d.startswith('_')))
    safe('tile_map_by_lake', lambda: len((_j(R('registry', 'tile_lake_map.json')).get('by_lake')
                                          or _j(R('registry', 'tile_lake_map.json')))))

    def charted_split():
        c = _j(R('registry', 'charted.json'))
        ship = sum(1 for v in c.values() if v.get('shipped'))
        return {'slugs': len(c), 'shipped': ship, 'refused': len(c) - ship}
    safe('charted', charted_split)

    # The registry-shrink argument, in one number. If this stops matching the page, the page's
    # headline quality item is misstated.
    def unbuildable_in_index():
        c = _j(R('registry', 'charted.json'))
        idx = {r.get('slug') for r in _rows(_j(R('registry', 'lake_index.json')))
               if isinstance(r, dict)}
        return sum(1 for s, v in c.items()
                   if s in idx and not v.get('shipped') and v.get('skipped') and not v.get('charted'))
    safe('unbuildable_rows_in_index', unbuildable_in_index)

    # ── constants with a rule attached ────────────────────────────────────────────────────
    def const(path, pattern, cast=int):
        m = re.search(pattern, open(path, encoding='utf-8', errors='replace').read())
        return cast(m.group(1)) if m else None
    safe('SHOAL_DM', lambda: const(R('scripts', 'build_chartpack.py'), r'SHOAL_DM\s*=\s*(\d+)'))

    # ── files that must be PRESENT, with the behaviour they carry ─────────────────────────
    def has(path, needle):
        return needle in open(path, encoding='utf-8', errors='replace').read()
    safe('halo_in_water_graphs',
         lambda: has(R('scripts', 'build_water_graphs.py'), 'ONE-RING HALO'))
    safe('aliases_default_in_consolidate',
         lambda: has(R('scripts', 'consolidate_lake_index.py'), "lake_aliases.json'"))
    safe('registry_default_in_uploader',
         lambda: has(R('scripts', 'upload_garmin_to_r2.py'), 'registry: defaulting to'))
    safe('bindings_read_by_worker',
         lambda: has(Q('Worker', 'conditions.js'), '_registry/water_bindings.json'))
    for name in ('verify_registry_r2.py', 'fit_trolling_runs.py', 'cut_boundaries_batch.py',
                 'name_from_garmin.py', 'attach_arms.py', 'install_registry_boundary.py'):
        safe('script_' + name, (lambda n: (lambda: os.path.exists(R('scripts', n))))(name))
    safe('coastline_json_points',
         lambda: len(_j(R('registry', 'coastline.json'))['line']))

    # ── files that must be ABSENT ─────────────────────────────────────────────────────────
    # A deleted module reappearing means a revert or a bad merge went unnoticed. Cheap to check,
    # and it is the class of thing nobody looks for.
    # Scripts/upload_boundaries_to_r2.py joined this list 2026-08-19. It is not merely unused:
    # it is a SECOND WRITER for <slug>/boundary.geojson with its own manifest, and the deletion
    # tab's own caution is that two writers for one key is what put upload_to_r2_coastal.py there.
    # A revert bringing it back would not fail anything -- it would just quietly re-create the
    # split that cost the index gate a day and shipped 1,250 out-of-scope packs.
    for rel in ('js/modules/casting-rings.js', 'js/modules/route-debug.js',
                'js/modules/route-builder.js', 'js/modules/pinch-point-finder.js',
                'Worker/research/vision.js', 'js/data/lakes.js',
                'Scripts/upload_boundaries_to_r2.py',
                'Scripts/test_upload_boundaries_manifest.py'):
        safe('absent_' + rel.split('/')[-1],
             (lambda r: (lambda: not os.path.exists(Q(*r.split('/')))))(rel))
    safe('absent_lake_boundaries_dir', lambda: not os.path.isdir(R('lake_boundaries')))

    # ── claims already proven wrong once ──────────────────────────────────────────────────
    # "Coastal boundaries are rectangles" cost five repetitions and one wasted code branch.
    def coastal():
        # ZONES COME FROM THE CATALOG, NOT FROM FILES ON DISK.
        #
        # This counted glob('registry/boundaries/coast_*.geojson') and so reported 22 on
        # 2026-08-19, hours after the catalog went to 16 -- because the six cut zones still
        # have boundary files sitting there. It was measuring leftovers.
        #
        # 00_START_HERE's own list of checks that each cost a session opens with "Count the
        # RIGHT thing. Presence is not size", and the worked example it gives is coastal zones
        # judged by file presence. This checker exists to keep that page honest and was
        # committing the page's headline mistake, on the page's own example.
        #
        # `zones` is now what the app can offer. `orphan_boundary_files` is the leftovers,
        # reported rather than folded in, so deleting them moves a number that says what it is.
        import glob
        cat = set()
        try:
            import importlib.util
            _sp = importlib.util.spec_from_file_location(
                '_cc', os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                    'coastal_catalog.py'))
            _m = importlib.util.module_from_spec(_sp); _sp.loader.exec_module(_m)
            cat = set(_m.COASTAL_CATALOG)
        except Exception:
            cat = set()
        files = glob.glob(R('registry', 'boundaries', 'coast_*.geojson'))
        orphans = sum(1 for fp in files
                      if os.path.basename(fp)[:-len('.geojson')] not in cat) if cat else 0
        n = mn = mx = 0
        heavy = 0
        for fp in files:
            if cat and os.path.basename(fp)[:-len('.geojson')] not in cat:
                continue
            d = _j(fp)
            fs = d.get('features') if d.get('type') == 'FeatureCollection' else [d]
            v = 0
            for f in (fs or []):
                g = (f or {}).get('geometry') or {}
                c = g.get('coordinates') or []
                rings = ([c] if g.get('type') == 'Polygon' else c)
                for poly in rings:
                    for r in (poly or []):
                        v += len(r) if isinstance(r, list) else 0
            n += 1
            mn = v if not mn else min(mn, v)
            mx = max(mx, v)
            slug = os.path.basename(fp)[:-8]
            if (os.path.getsize(R('chartpack', slug, 'contours.geojson'))
                    if os.path.exists(R('chartpack', slug, 'contours.geojson')) else 0) > 200:
                heavy += 1
        return {'zones': len(cat) if cat else n, 'boundaries_for_live_zones': n,
                'orphan_boundary_files': orphans,
                'min_vertices': mn, 'max_vertices': mx, 'with_contours': heavy}
    safe('coastal', coastal)

    safe('test_files', lambda: sum(1 for f in os.listdir(Q('test')) if f.endswith('.test.js')))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--root', default='.', help='F:\\TrollMapPipeline')
    ap.add_argument('--repo', default=os.path.join('TrollMap-Dev'))
    ap.add_argument('--facts', default=None)
    ap.add_argument('--bless', action='store_true',
                    help='accept the measured values. DO THIS AND THEN GO UPDATE THE PAGE.')
    ap.add_argument('--list', action='store_true')
    a = ap.parse_args()
    facts_fp = a.facts or os.path.join(a.root, FACTS)

    now = collect(a.root, os.path.join(a.root, a.repo))
    if a.list:
        for k in sorted(now):
            print('%-34s %s' % (k, json.dumps(now[k])))
        return 0

    if not os.path.exists(facts_fp):
        json.dump(now, open(facts_fp, 'w', encoding='utf-8'), indent=1, sort_keys=True)
        print('no baseline -- wrote %d facts to %s' % (len(now), facts_fp))
        print('Everything measured is now the expected value. Re-run after any pipeline change.')
        return 0

    was = _j(facts_fp)
    drift, gone, new = [], [], []
    for k in sorted(set(was) | set(now)):
        if k not in now:
            gone.append(k)
        elif k not in was:
            new.append(k)
        elif json.dumps(was[k], sort_keys=True) != json.dumps(now[k], sort_keys=True):
            drift.append((k, was[k], now[k]))

    errs = [k for k, v in now.items() if isinstance(v, str) and v.startswith('ERROR')]
    if errs:
        print('!! %d fact(s) could not be measured -- treat as drift, not as passing:' % len(errs))
        for k in errs:
            print('   %-32s %s' % (k, now[k]))
    if new:
        print('%d new check(s) with no baseline: %s' % (len(new), ', '.join(new)))
    if gone:
        print('%d baseline key(s) no longer measured: %s' % (len(gone), ', '.join(gone)))

    if not drift and not errs:
        print('%d facts checked, all match %s' % (len(now), os.path.basename(facts_fp)))
        return 0

    if drift:
        print('\n%d FACT(S) MOVED. 00_START_HERE.md may now be wrong about each:\n' % len(drift))
        for k, old, cur in drift:
            print('   %-32s was %s' % (k, json.dumps(old)))
            print('   %-32s now %s' % ('', json.dumps(cur)))
        print('\nIf these changes are correct, run --bless AND THEN UPDATE THE PAGE.')
        print('Blessing without updating the page is how nine things got rebuilt on 2026-08-12.')
    if a.bless:
        json.dump(now, open(facts_fp, 'w', encoding='utf-8'), indent=1, sort_keys=True)
        print('\nblessed -> %s' % facts_fp)
        return 0
    return 1


if __name__ == '__main__':
    sys.exit(main())
