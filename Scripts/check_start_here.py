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

    # ── THE GAUGES. THE QUESTION IS "CAN THIS LAKE TELL ME ITS LEVEL TODAY" ──────────────
    #
    # Ryan, 2026-08-27, after being handed nine different counts: "how many lakes have a gauge
    # that tells you its current operating level?" That is the only version of the question the
    # app cares about, and every earlier answer measured something adjacent to it.
    #
    # WHAT MAKES A GAUGE A LAKE-LEVEL GAUGE IS THE SHEF PHYSICAL ELEMENT, not a USGS parameter
    # code. `HP` is POOL HEIGHT and `HG` is river stage, and build_water_bindings.py already
    # ranks HP first for a lake -- but `pedts` does not survive into water_bindings.json, so
    # this reads it back off the NWPS roster the binder itself cached. An earlier attempt tested
    # for USGS `00062` instead and returned 11, which is wrong twice over: it is a different
    # question, and 36 of the lake pool bindings are NWS-only with no USGS site at all.
    #
    # A `pool` binding is NOT enough on its own. Eight lakes carry one graded `HG` -- a river
    # stage that happens to be the nearest gauge, which does not tell you where the lake is.
    #
    # Measured 2026-08-27: 62 lakes on an HP pool gauge, all in service; one more (Tuckertown)
    # on an operator feed alone; 63 in total out of 284 offered lakes. TWO HUNDRED AND
    # TWENTY-ONE LAKES CANNOT TELL YOU THEIR LEVEL TODAY.
    #
    # 00_START_HERE.md says "221 waters bound" under `gauges`. 221 is this file's complement --
    # the lakes with NO level -- and 204 is the number of bound waters. The page has the right
    # number against the wrong sentence, which is where a year of confusion came from.
    def gauge_counts():
        import csv as _csv
        roster = R('registry', '_nwps_all_gauges.csv')
        if not os.path.exists(roster):
            return 'ERROR: registry/_nwps_all_gauges.csv is missing -- pedts cannot be read ' \
                   'and no lake-level count can be made without guessing'
        with open(roster, encoding='utf-8-sig') as fh:
            ped = {(r.get('nws shef id') or '').strip().upper(): (r.get('pedts') or '')
                   for r in _csv.DictReader(fh)}
        wb = (_j(R('registry', 'water_bindings.json')).get('bindings') or {})
        idx = _j(R('registry', 'lake_index.json'))
        lakes = [s for s, r in idx.items() if str((r or {}).get('feature_type')) == 'lake']
        hp, hg, op = set(), set(), set()
        for s in lakes:
            r = wb.get(s) or {}
            lid = ((r.get('pool') or {}).get('lid') or '').upper()
            if lid:
                pe = (ped.get(lid) or '')[:2].upper()
                (hp if pe == 'HP' else hg).add(s)
            if r.get('operator'):
                op.add(s)
        live = hp | op
        return {'offered_lakes': len(lakes),
                'lakes_with_a_current_level': len(live),
                'hp_pool_gauge': len(hp),
                'operator_feed': len(op),
                'pool_binding_but_river_stage': len(hg),
                'lakes_with_no_level_at_all': len(lakes) - len(live),
                'bound_waters': len(wb)}
    safe('gauges', gauge_counts)

    # The lakes that CAN answer, by name. A count that drifts says something changed; the names
    # say what, and sixty-three of them is a list worth keeping.
    def lakes_with_level_slugs():
        import csv as _csv
        roster = R('registry', '_nwps_all_gauges.csv')
        if not os.path.exists(roster):
            return 'ERROR: registry/_nwps_all_gauges.csv is missing'
        with open(roster, encoding='utf-8-sig') as fh:
            ped = {(r.get('nws shef id') or '').strip().upper(): (r.get('pedts') or '')
                   for r in _csv.DictReader(fh)}
        wb = (_j(R('registry', 'water_bindings.json')).get('bindings') or {})
        idx = _j(R('registry', 'lake_index.json'))
        out = []
        for s, row in idx.items():
            if str((row or {}).get('feature_type')) != 'lake':
                continue
            r = wb.get(s) or {}
            lid = ((r.get('pool') or {}).get('lid') or '').upper()
            if (lid and (ped.get(lid) or '')[:2].upper() == 'HP') or r.get('operator'):
                out.append(s)
        return sorted(out)
    safe('lakes_with_level_slugs', lakes_with_level_slugs)

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
                # SmartPlan v1 and the Groq coach, cut 2026-08-20. v1 had been unreachable
                # since v2 shipped and seven tests were green against its source text, so
                # a revert would restore code nothing calls AND re-hide two coastal gaps.
                'js/modules/smart-plan.js', 'js/modules/smart-plan-context.js',
                'js/modules/groq-coach.js',
                'Scripts/upload_boundaries_to_r2.py',
                'Scripts/test_upload_boundaries_manifest.py',
                # Retired the same day, and the reason is SHARPER than the one first written
                # here. Its own comment called it an ungated second road to R2 pushing ~124 MB
                # per zone across the sixteen zones the tier filter existed to exclude, and
                # 00_START_HERE carried a DO NOT RUN warning for it.
                #
                # What was wrong: I called its OUTPUT_DIR, split_output3, "a directory gone for
                # weeks" and concluded it could not run. Ryan, 2026-08-20: "i renamed
                # split_output3 to its current name which is I-Boating Contours and
                # supplemental data". The tree is on the drive with the exact shape the
                # docstring describes -- coast_ace_basin_sc.geojson at the top,
                # supplemental/<zone>/ underneath -- and r2_vs_local.py's SOURCE_MAP has
                # pointed at it since 2026-08-19 as the local home of 131 R2 objects.
                # "Absent" was a stale string, not a missing directory. Repoint one line and
                # it runs -- which makes DO NOT RUN a stronger warning, not a weaker one.
                'Scripts/upload_to_r2_coastal.py',
                # THE THREE HARDCODED WATER LISTS -- retired 2026-08-22.
                #
                # Between them they contributed 40 extra names, 5 notes and NOT ONE WATER:
                # every index row they tagged already carried `3dhp`. The names come from
                # registry/_feed_names.json now, harvested by build_water_names.py out of the
                # `wb` field every ramp record already carries. Proven before deleting, by
                # running consolidate with and without --js-lists: 401 rows both ways, zero
                # names lost.
                #
                # These are asserted absent because a list like this comes BACK. lake_boundaries/
                # came back through a docstring on 2026-08-17 and that is the reason this whole
                # block exists. dump_js_lists.mjs is here too: it is the only thing that wrote
                # js_lists.json, and that file was a CACHE that went stale -- on 2026-08-22 it
                # still held HB Robinson Lake, removed from user-known-lakes.js eleven days
                # earlier, and was still feeding that row's name and note into the index.
                'js/data/scdnr-state-lakes.js',
                'js/data/user-known-lakes.js',
                'js/data/dump_js_lists.mjs',
                # THE FIFTH COPY OF THE DUKE NINE-LAKE LIST -- deleted 2026-08-23.
                #
                # `hand-written-tables.test.js` found it on the day it was written, and it sat
                # for a week because "probably dead" is not a measurement. It is dead, and the
                # proof is three separate reads: nothing in js/, Worker/, test/ or index.html
                # imports the file; its two exports, `parseDukeText` and `fetchDamLevels`, are
                # named ONLY inside comments describing what they used to do -- Worker's own
                # says "Vestigial"; and `STATE_NAME_MAP` was reached by nothing but the ledger
                # test that declared it.
                #
                # `audit.json` DISAGREED and was wrong: it records main.js, plan-builder.js and
                # utility-sync.js importing it, and it was written 2026-08-14, before main.js
                # moved to conditions-strip.js. A dependency graph is a measurement with a date
                # on it.
                'js/modules/duke-energy.js'):
        safe('absent_' + rel.split('/')[-1],
             (lambda r: (lambda: not os.path.exists(Q(*r.split('/')))))(rel))
    # THE THIRD AND LAST HARDCODED WATER LIST -- retired 2026-08-24.
    #
    # 50 entries, and by the end it supplied exactly one thing no rule could generate:
    # the name "Lake Rhodhiss, NC" against an index that says "Rhodhiss Lake". Measured
    # by building the index with and without it and handing both to
    # compare_index_names.py -- 358 rows either way, that one name, now an `also` on
    # rhodhiss_lake in lake_display_names.json. A list like this COMES BACK: lake_boundaries/
    # returned through a docstring on 08-17, which is why the line below exists.
    safe('absent_curated_lakes.json', lambda: not os.path.exists(R('curated_lakes.json')))
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


# ── some facts have only one acceptable value ───────────────────────────────────────────────
#
# --bless records what it MEASURES, which is right for a count and wrong for an assertion.
# `absent_lake_boundaries_dir` was blessed False on 2026-08-19 -- the folder existed at the
# moment of blessing -- so the check that a retired directory must stay gone was frozen into
# expecting it to be THERE, and reported "all facts match" for a day while the thing it was
# written to catch sat on the drive. It would have fired the day the folder was finally deleted.
#
# An absence assertion has a correct answer that does not depend on today. Blessing it False
# does not record a fact, it records a defect. So these are refused rather than baselined --
# the run fails, says which, and says what to do about it.
def one_way(now):
    """[(key, value)] for facts whose only acceptable value is True."""
    return [(k, v) for k, v in sorted(now.items())
            if k.startswith('absent_') and v is not True]

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

    wrong = one_way(now)
    if wrong:
        print('!! %d absence assertion(s) are FALSE right now. These are never blessed --' % len(wrong))
        print('   an absent_* fact has one correct answer and it does not depend on today:')
        for k, v in wrong:
            print('   %-34s is %s, must be true' % (k, json.dumps(v)))
        print('   Delete the thing (or drop the assertion), then re-run.')

    if not os.path.exists(facts_fp):
        if wrong:
            return 1
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

    # A NEW CHECK COULD NEVER ACQUIRE A BASELINE ON ITS OWN.
    #
    # This returned here whenever nothing had DRIFTED, which is before the --bless block below.
    # So adding a check to a file that was otherwise in sync printed "N new check(s) with no
    # baseline" and --bless silently did nothing about it -- the only way to record a new fact
    # was for some unrelated fact to move in the same run.
    #
    # That is worse than noise. A key with no baseline is not compared against anything, so the
    # check does not fail when its subject changes. Found 2026-08-19 by adding
    # absent_upload_boundaries_to_r2.py: it reported "new", --bless reported "all match", and the
    # assertion that a retired second-writer must stay retired was inert from the moment it was
    # written. A permanent "N new check(s)" line is also how a report stops being read.
    if a.bless and wrong:
        print('\nREFUSING TO BLESS while an absence assertion is false. Nothing was written.')
        return 1

    if a.bless and (drift or errs or new or gone):
        json.dump(now, open(facts_fp, 'w', encoding='utf-8'), indent=1, sort_keys=True)
        print('\nblessed -> %s' % facts_fp)
        if new:
            print('%d new check(s) now have a baseline and will fail on change: %s'
                  % (len(new), ', '.join(new)))
        return 0

    if not drift and not errs:
        if new or gone:
            # Not "all match": some of what was measured is not being compared to anything.
            print('%d fact(s) match, but %d have NO BASELINE and are therefore NOT ENFORCED.'
                  % (len(now) - len(new), len(new)))
            print('Run --bless to record them. Until then they cannot fail.')
            return 1
        if wrong:
            print('%d facts match the baseline -- but the baseline itself is wrong above.'
                  % len(now))
            return 1
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
        if wrong:
            print('\nREFUSING TO BLESS while an absence assertion is false. Nothing was written.')
            return 1
        json.dump(now, open(facts_fp, 'w', encoding='utf-8'), indent=1, sort_keys=True)
        print('\nblessed -> %s' % facts_fp)
        return 0
    return 1


if __name__ == '__main__':
    sys.exit(main())
