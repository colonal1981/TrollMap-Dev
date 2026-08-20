#!/usr/bin/env python3
"""audit_scripts.py — which of the 239 scripts in scripts/ are still load-bearing.

    py scripts\\audit_scripts.py                        report only
    py scripts\\audit_scripts.py --manifest OUT.md      write the reviewable manifest
    py scripts\\audit_scripts.py --sort                 dry run of the move
    py scripts\\audit_scripts.py --sort --go            actually move

Nothing is ever deleted and KEEP never moves. `--sort --go` moves the other two tiers
into `scripts/_archive_<date>/` and `scripts/_review_<date>/`, each with a MANIFEST.md
naming why every file landed there. Reversible with a drag.

KEEP stays in the scripts root deliberately (Ryan, 2026-08-04: "keep can stay in scripts
root"). Every documented command in this project is `py scripts\\<name>.py`, and moving
the live set into a subfolder would invalidate all of them at once.

HOW LIVENESS IS DECIDED, in order of strength:

  1. Named in claude/00_START_HERE.md's "pipeline, end to end", or in the support
     steps the recent session docs name. These are asserted, not inferred -- the doc
     is the contract.
  2. Reachable from (1) by a real Python import, transitively. This is what stops the
     audit from archiving the working GMP decoder: gmapmf_decode_v40.py,
     gmapmf_areas_v51.py, gmapmf_labels_v50.py, gmapmf_lines_v50.py,
     gmapmf_regions_v51.py, rgn4_grammar.py, rgn4_pois.py, area_audit.py and
     poi_audit.py all look exactly like the 100-odd research probes around them and
     are imported by trollmap_extract_all.py. Name-based sorting would have binned
     the extractor.
  3. Produces an artefact something in (1) or (2) reads.

A script that fails all three is a CANDIDATE, not a corpse. Groups whose provenance is
unambiguous (a numbered family with a later sibling, an era that was replaced wholesale)
are proposed for archive. Anything else lands in REVIEW and stays put.

WHY THIS EXISTS. Ryan, 2026-08-04: "i don't want to move a bunch of stale garbage to the
repo... anyway to know what is still needed or not needed and archive or delete the rest?"
Half the pipeline is versioned and half is not, and which half is arbitrary.

DO NOT sort by mtime or by name prefix alone. On 2026-08-04 js/data/lakes.js was queued
for deletion three times on a "nothing imports it" check that was true and irrelevant --
its consumer was Python reading data the JS produced. Imports are one signal.

Personal use only, not for distribution or resale; not for navigation.
"""

import argparse
import ast
import collections
import datetime
import os
import re
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

# ── (1) asserted live, from claude/00_START_HERE.md ─────────────────────────────
# upload_boundaries_to_r2.py left this list on 2026-08-19 with the script itself. Boundaries
# ride along with upload_garmin_to_r2.py since 0bee3dc -- one writer per key -- and a name here
# is a ROOT of the reachability walk, so leaving it would have kept a deleted file's dependencies
# alive under "named in 00_START_HERE.md" while the page had already stopped naming it.
# Checked before removing: the only local module it imported was r2_gzip.py, which
# upload_garmin_to_r2.py imports too, so nothing was stranded.
PIPELINE = """
trollmap_extract_all.py tile_lake_map.py build_all_chartpacks.py build_chartpack.py
consolidate_lake_index.py upload_garmin_to_r2.py
fetch_osm_structures.py install_registry_boundary.py make_river_boundaries.py
""".split()

SUPPORT = """
trim_pack_strays.py make_osm_ramps_by_lake.py fetch_dnr_paddle.py suggest_name_aliases.py
check_pipeline_parity.py verify_river_boundaries.py recompute_charted.py make_key_map.py
prune_r2_keys.py classify_salt_fresh.py lake_catalog.py coastal_catalog.py zone_coverage.py
make_coastal_boundaries.py extract_coastal_habitat.py trollmap_pipeline_coastal.py
trollmap_nhd_boundaries.py osm_ramps.py
gen_coastal_zones_js.py gen_water_aliases_js.py audit_scripts.py
""".split()

# ── groups proposed for archive, most specific rule first ───────────────────────
# (group name, reason shown in the manifest, matcher)
GROUPS = [
    ('superseded_backup',
     'a dated backup taken during a rewrite; the live file is beside it',
     lambda f: f.startswith('_') or f.endswith(('_PREV.py', '_PREV_B.py', '_OLD.py'))),

    ('declared_dead',
     'named as dead in 00_START_HERE.md — fetch_osm_structures.py replaced it and covers '
     'lakes, rivers and coastal in one pass',
     lambda f: f in ('fetch_osm_coastal.py',)),

    ('raster_vectorize_era',
     'the pre-GMP era: screen-capture the plotter, vectorise the pixels. Ended when the '
     'GMP tiles were decoded directly. Eleven numbered versions of one file',
     lambda f: f.startswith('trollmap_vectorize_contours')
     or f in ('trollmap_build_contours.py', 'trollmap_postprocess_contours.py',
              'trollmap_capture_server.py', 'trollmap_contour_pipeline.py',
              'sample_tile_colors.py', 'color_check.py', 'hires_test.py')),

    ('pbf_iboating_era',
     'the i-Boating PBF source, replaced by Garmin GMP tiles',
     lambda f: 'pbf' in f.lower()),

    ('qdc_era',
     'QuickDraw Community CSV import, replaced by the GMP decode',
     lambda f: f.startswith('qdc_') or f == 'check_quickdraw.py'),

    ('superseded_uploader',
     'superseded by upload_garmin_to_r2.py, the one uploader left. It was three: '
     'upload_boundaries_to_r2.py and upload_to_r2_coastal.py were both retired 2026-08-19 -- '
     'one a second writer for <slug>/boundary.geojson, the other reading split_output3, a '
     'directory gone for weeks',
     lambda f: f in ('upload_to_r2.py', 'upload_contours_to_r2.py',
                     'upload_supplemental_to_r2.py')),

    ('superseded_registry_builder',
     'superseded by consolidate_lake_index.py, which is the one the pipeline names',
     lambda f: f in ('build_lake_index.py', 'build_lake_registry.py', 'merge_lakes.py')),

    ('superseded_boundary_builder',
     'hand-typed bounding boxes. 00_START_HERE: "when a boundary is wrong, reach for the '
     'cutter, not for NHD" — ten lakes, zero usable results',
     lambda f: f in ('trollmap_bbox_splitter.py', 'trollmap_bbox_derivation.py',
                     'trollmap_apply_bboxes.py', 'derived_bboxes.py',
                     'trollmap_lake_boundaries.py')),

    ('superseded_pipeline_driver',
     'an older "one button" driver, superseded by trollmap_extract_all.py + '
     'build_all_chartpacks.py',
     lambda f: f in ('trollmap_pipeline.py', 'trollmap_unified_pipeline.py',
                     'trollmap_supplemental_pipeline.py', 'trollmap_dataset_layout.py',
                     'trollmap_debug.py')),

    ('superseded_pack_cleaner',
     'superseded by trim_pack_strays.py, which trims to the boundary instead of dropping '
     'whole features',
     lambda f: f in ('clean_packs.py',)),

    ('wateree_zone_experiment',
     'the Wateree zone-overlay experiment; the overlay was dropped and the geojson is '
     'excluded from the repo sync',
     lambda f: f in ('build_wateree_zones.py', 'make_zones_geojson.py', 'extract_ledges.py')
     or f.startswith('check_zone')),

    ('gmp_decode_research',
     'GMP reverse-engineering probes from the decode effort. The parts that WORK were '
     'kept — they are imported by trollmap_extract_all.py. These are the trials that '
     'did not survive, and AGENT_GUIDE.md records what each proved',
     lambda f: re.match(
         r'(gmapmf_|gmp_inspector|inspect_gmp|dump_|crack_|peek_gmp|stride\d|rgn\d|mar_|'
         r'decode_mar|parse_mar|garmin_mar|opcode_|calc_arc|check_arc|compare_keys|'
         r'compare_gmp|verify_ep0|test_ep1|find_ep0|test_bitstream|test_packing|'
         r'debug_bitstream|check_blocks|check_shift|check_scale|check_compression|'
         r'check_node_ids|check_b_tre7|scan_modes|scan_depth|census4|seqwalk|trace\d?\.|'
         r'chain\d|chainfix|lbl_hunt|tail_probe|mode_anchor|mode620|rsd_structure|'
         r'inspect_rsd|coverage_audit|export_lines|nodepth_export|poi_rec|named_pois|'
         r'find_gmapmf|find_lake_tiles|find_wateree_tiles|find_hartwell_tiles|'
         r'garmin_poi_to_trollmap|trollmap_poi_batch|extract_depth_areas|'
         r'build_depth_regions|merge_labels|assign_to_lakes|ramps_export|area_audit)', f)),

    ('one_off_check',
     'a throwaway probe answering one question on one day',
     lambda f: re.match(r'(check_|inspect_|compare_|scan_|Extract_pbf)', f)),
]

# Left alone deliberately — a separate strand of the project, not pipeline debris.
REVIEW_NOTE = {
    'fish_sorter': 'catch-photo sorting workflow — a different strand of the project. '
                   'Not pipeline debris; left in place for Ryan to call.',
    'rebuild_2026_csv.py': 'catch-photo workflow',
    'copy_sidecars.py': 'catch-photo workflow',
    'inspect_csv.py': 'catch-photo workflow',
    'trollmap_catch_local_server.py': 'catch-photo workflow',
    'build_rescan_staging_targeted.py': 'catch-photo workflow',
    'build_rescan_staging_visual.py': 'catch-photo workflow',
    'noaa_enc_coastal.py': 'the NOAA ENC sounding source. Garmin overwrote contours and '
                           'depth areas in the six primary zones, but soundings are still '
                           'NOAA everywhere and the other 15 zones are NOAA throughout.',
    'activecaptain_to_trollmap.py': 'ActiveCaptain POI import — never wired into the '
                                    'pipeline, but the data source is still live.',
    'gen_lake_keys.py': 'regenerates js/data/lake-keys.js, which is now hand-maintained. '
                        'Running it could revert curated mappings — check before keeping.',
    'lake_access_join.py': 'access analysis from 2026-08-02; feeds no pipeline step but '
                           'answers a question that keeps coming back.',
    'garmin_lake_inventory.py': 'reads the card\'s own waterbody list — useful for the '
                                'undecoded-tile work still open.',
    'garmin_access_scan.py': 'same vintage as garmin_lake_inventory.py.',
    'derive_waterbodies.py': 'finds water from where GARMIN put contours, not from what '
                             '3DHP names. Nothing else on the drive does that. It is the '
                             'source of max_depth_ft.',
    'name_waterbodies.py': 'names derived bodies against the GPKG by bbox; falls back to '
                           'garmin_NNNNNN when 3DHP has no name for the water.',
    'index_waterbodies.py': 'reduces waterbodies_named/ to the 10 MB index. Classed a '
                            'registry builder on 2026-08-04 and swept; it is not one, and '
                            'the sweep took the only copy. Restored 2026-08-19.',
    'trollmap_qa2.py': 'contour QA with a crossing metric — worth keeping if you ever '
                       're-check decode quality.',
    'trollmap_r2_clean.py': 'wipes R2. Dangerous and rarely wanted, but not stale.',
    'verify_grokipedia_windows.py': 'lives in the repo under test/ as well.',
}


def scripts_dir(a):
    return a.dir or HERE


def build_graph(d):
    files = sorted(f for f in os.listdir(d) if f.endswith('.py'))
    stems = {f[:-3]: f for f in files}
    g = {}
    for f in files:
        src = open(os.path.join(d, f), encoding='utf-8', errors='replace').read()
        imports = set()
        try:
            tree = ast.parse(src)
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for al in node.names:
                        top = al.name.split('.')[0]
                        if top in stems:
                            imports.add(stems[top])
                elif isinstance(node, ast.ImportFrom) and node.module:
                    top = node.module.split('.')[0]
                    if top in stems:
                        imports.add(stems[top])
            doc = (ast.get_docstring(tree) or '').strip().splitlines()
            doc = doc[0][:100] if doc else ''
        except SyntaxError:
            for m in re.finditer(r'^\s*(?:from|import)\s+([A-Za-z_]\w*)', src, re.M):
                if m.group(1) in stems:
                    imports.add(stems[m.group(1)])
            doc = '(does not parse)'
        g[f] = {'imports': sorted(imports), 'doc': doc,
                'size': os.path.getsize(os.path.join(d, f)),
                'mtime': datetime.date.fromtimestamp(
                    os.path.getmtime(os.path.join(d, f))).isoformat()}
    return g


def classify(g):
    roots = [f for f in set(PIPELINE) | set(SUPPORT) if f in g]
    keep, stack, why = set(), list(roots), {}
    for r in roots:
        why[r] = 'named in 00_START_HERE.md'
    while stack:
        f = stack.pop()
        if f in keep:
            continue
        keep.add(f)
        for i in g[f]['imports']:
            if i not in keep:
                why.setdefault(i, 'imported by %s' % f)
                stack.append(i)
    groups = collections.OrderedDict()
    review = {}
    for f in sorted(g):
        if f in keep:
            continue
        if f.startswith('fish_sorter') or f in REVIEW_NOTE:
            review[f] = REVIEW_NOTE.get(f, REVIEW_NOTE['fish_sorter'])
            continue
        for name, reason, match in GROUPS:
            if match(f):
                groups.setdefault(name, {'reason': reason, 'files': []})['files'].append(f)
                break
        else:
            review[f] = 'no rule matched — cannot prove it is dead, so it stays'
    return keep, why, groups, review


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--dir', help='scripts folder (default: beside this file)')
    ap.add_argument('--manifest', help='write the full manifest to this markdown file')
    ap.add_argument('--sort', action='store_true',
                    help='move ARCHIVE and REVIEW out; KEEP stays in the scripts root so '
                         'every documented `py scripts\\foo.py` command still works')
    ap.add_argument('--go', action='store_true', help='with --sort/--files, actually move')
    ap.add_argument('--files', action='store_true',
                    help='sort the NON-script clutter: docs to _docs_<date>, outputs and '
                         'scratch data to _data_<date>, non-Python tooling to _review_<date>')
    a = ap.parse_args()

    d = scripts_dir(a)
    g = build_graph(d)
    keep, why, groups, review = classify(g)
    n_arch = sum(len(v['files']) for v in groups.values())
    mb = lambda L: sum(g[f]['size'] for f in L) / 1e6

    print('%d scripts in %s' % (len(g), d))
    print('  KEEP    %3d   pipeline + everything it imports' % len(keep))
    print('  ARCHIVE %3d   %.1f MB across %d groups'
          % (n_arch, mb([f for v in groups.values() for f in v['files']]), len(groups)))
    print('  REVIEW  %3d   left in place, your call' % len(review))
    missing = [f for f in set(PIPELINE) | set(SUPPORT) if f not in g]
    if missing:
        print('\n  !! named as live but NOT in this folder: %s' % ', '.join(sorted(missing)))

    # REVIEW_NOTE is this tool's own list of "not debris -- Ryan's call". A sweep that
    # carries one of them off the tree has overruled that judgement silently, which is
    # exactly how index_waterbodies.py was lost. Same shape of question as `missing`,
    # so it is answered in the same place, and both are fatal: a warning that returns 0
    # is not a check.
    here = set()
    for r, dirs, fs in os.walk(d):
        dirs[:] = [x for x in dirs if x not in ('__pycache__', '.wrangler', '_to_delete')]
        here.update(fs)
    stranded = [k for k in REVIEW_NOTE
                if not (k in here or (not k.endswith('.py')
                                      and any(f.startswith(k) for f in here)))]
    if stranded:
        print('\n  !! flagged "your call" in REVIEW_NOTE but no longer anywhere under %s:'
              % os.path.basename(d.rstrip(os.sep)))
        for k in sorted(stranded):
            print('       %-32s %s' % (k, REVIEW_NOTE[k].split('.')[0]))
    print()
    for name, v in groups.items():
        print('  %-28s %3d files  %5.1f MB' % (name, len(v['files']), mb(v['files'])))

    if a.manifest:
        with open(a.manifest, 'w', encoding='utf-8', newline='') as fh:
            w = fh.write
            w('# Script audit — %s\n\n' % datetime.date.today().isoformat())
            w('%d scripts. KEEP %d, ARCHIVE %d, REVIEW %d.\n\n'
              % (len(g), len(keep), n_arch, len(review)))
            w('Nothing is deleted. `--archive --go` moves files into '
              '`_archive_<date>/<group>/`.\n\n')
            w('## KEEP — the pipeline and everything it imports\n\n')
            w('| script | why | modified |\n|---|---|---|\n')
            for f in sorted(keep):
                w('| `%s` | %s | %s |\n' % (f, why.get(f, ''), g[f]['mtime']))
            w('\n## ARCHIVE — proposed\n')
            for name, v in groups.items():
                w('\n### %s — %d files, %.1f MB\n\n%s.\n\n'
                  % (name, len(v['files']), mb(v['files']), v['reason']))
                for f in sorted(v['files']):
                    w('- `%s` (%s) %s\n' % (f, g[f]['mtime'], g[f]['doc']))
            w('\n## REVIEW — left in place\n\n')
            for f in sorted(review):
                w('- `%s` (%s) — %s\n' % (f, g[f]['mtime'], review[f]))
        print('\nwrote %s' % a.manifest)

    if a.sort:
        stamp = datetime.date.today().isoformat()
        # Flat folders, not one per group. Several archived scripts import each other, and
        # scattering them across group subdirectories would break those imports for anyone
        # who ever opens one to read what it proved. The group lives in MANIFEST.md instead.
        plan = []
        for name, v in groups.items():
            for f in sorted(v['files']):
                plan.append((f, '_archive_%s' % stamp, name, v['reason']))
        for f in sorted(review):
            plan.append((f, '_review_%s' % stamp, 'review', review[f]))

        # KEEP never moves. Assert that here rather than trusting the loop above: a rule
        # edit that accidentally widened a matcher would otherwise quietly relocate the
        # extractor, and the failure would show up as a pipeline run that cannot import.
        bad = [f for f, _, _, _ in plan if f in keep]
        if bad:
            print('\nREFUSING: these are KEEP and must not move: %s' % ', '.join(bad))
            return 1

        print('\n%s' % ('MOVING' if a.go else 'DRY RUN -- nothing will move'))
        by_dest = collections.defaultdict(list)
        for f, dest, group, reason in plan:
            by_dest[dest].append((f, group, reason))
        for dest, rows in sorted(by_dest.items()):
            print('  %-28s %3d files' % (dest + os.sep, len(rows)))
        if a.go:
            for dest, rows in by_dest.items():
                dp = os.path.join(d, dest)
                os.makedirs(dp, exist_ok=True)
                with open(os.path.join(dp, 'MANIFEST.md'), 'w', encoding='utf-8',
                          newline='') as fh:
                    fh.write('# %s\n\nMoved %s by scripts/audit_scripts.py. '
                             'Nothing was deleted -- drag anything back to scripts/ to '
                             'restore it.\n\n' % (dest, stamp))
                    cur = None
                    for f, group, reason in sorted(rows, key=lambda r: (r[1], r[0])):
                        if group != cur:
                            cur = group
                            fh.write('\n## %s\n\n%s.\n\n' % (group, reason))
                        fh.write('- `%s`%s\n' % (f, '' if group != 'review'
                                                  else ' — ' + reason))
                for f, group, reason in rows:
                    src = os.path.join(d, f)
                    if os.path.exists(src):
                        shutil.move(src, os.path.join(dp, f))
            left = sorted(x for x in os.listdir(d) if x.endswith('.py'))
            print('\n%d files moved. scripts/ now holds %d .py files:'
                  % (len(plan), len(left)))
            for f in left:
                print('    %s' % f)
        else:
            print('\n%d files would move, %d would stay in scripts/. Add --go.'
                  % (len(plan), len(keep)))


    if a.files:
        stamp = datetime.date.today().isoformat()
        # Non-.py entries that live code actually reaches. Everything here was checked by
        # stripping comments and docstrings first: AGENT_GUIDE.md, osmconvert64.exe and the
        # B2_* notes all appear in scripts, but only ever in prose describing how something
        # used to work. osmconvert in particular is named in fetch_osm_structures.py's
        # docstring explaining the 2,803-clip approach it REPLACED -- the unified extractor
        # reads the .pbf directly and never shells out to it.
        KEEP_FILES = {
            'make_counties.mjs',          # produces counties_500k.geojson, named by
                                          # consolidate_lake_index.py --counties
            'install_coastal_and_rivers.ps1',   # current runner, 2026-08-04
        }
        KEEP_DIRS = {'__pycache__', '.wrangler', '_to_delete'}

        DOC_EXT  = {'.md'}
        DATA_EXT = {'.geojson', '.json', '.csv', '.tsv', '.txt', '.png', '.jpg', '.zip',
                    '.pbf', '.srpd', '.bin', '.gz', '.html'}
        TOOL_EXT = {'.mjs', '.ps1', '.bat', '.exe', '.bak'}

        moves = []
        for e in sorted(os.listdir(d)):
            if e.endswith('.py') or e in KEEP_FILES or e in KEEP_DIRS:
                continue
            if e.startswith(('_archive_', '_review_', '_docs_', '_data_')):
                continue
            full = os.path.join(d, e)
            ext = os.path.splitext(e)[1].lower()
            if os.path.isdir(full):
                moves.append((e, '_data_%s' % stamp, 'scratch/output folder'))
            elif ext in DOC_EXT:
                moves.append((e, '_docs_%s' % stamp, 'session note or reference doc'))
            elif ext in TOOL_EXT or e.endswith('.py.txt'):
                moves.append((e, '_review_%s' % stamp,
                              'non-Python tooling or a saved copy of a script'))
            elif ext in DATA_EXT:
                moves.append((e, '_data_%s' % stamp, 'output or scratch data'))
            else:
                moves.append((e, '_review_%s' % stamp, 'unrecognised — your call'))

        by = collections.defaultdict(list)
        for e, dest, reason in moves:
            by[dest].append((e, reason))
        print('\n%s' % ('MOVING' if a.go else 'DRY RUN -- nothing will move'))
        for dest, rows in sorted(by.items()):
            size = 0
            for e, _ in rows:
                fp = os.path.join(d, e)
                if os.path.isfile(fp):
                    size += os.path.getsize(fp)
                else:
                    for r, _dirs, fs in os.walk(fp):
                        for x in fs:
                            try: size += os.path.getsize(os.path.join(r, x))
                            except OSError: pass
            print('  %-24s %3d entries  %7.1f MB' % (dest + os.sep, len(rows), size / 1e6))
        if a.go:
            for dest, rows in by.items():
                dp = os.path.join(d, dest)
                os.makedirs(dp, exist_ok=True)
                with open(os.path.join(dp, 'MANIFEST.md'), 'a', encoding='utf-8',
                          newline='') as fh:
                    fh.write('\n## non-script entries moved %s\n\n' % stamp)
                    for e, reason in sorted(rows):
                        fh.write('- `%s` — %s\n' % (e, reason))
                for e, _ in rows:
                    src = os.path.join(d, e)
                    if os.path.exists(src):
                        shutil.move(src, os.path.join(dp, e))
            left = sorted(os.listdir(d))
            nonpy = [x for x in left if not x.endswith('.py')]
            print('\n%d entries moved. scripts/ now holds %d .py and %d other entries:'
                  % (len(moves), len([x for x in left if x.endswith('.py')]), len(nonpy)))
            for x in nonpy:
                print('    %s' % x)
        else:
            print('\n%d entries would move. Add --go.' % len(moves))

    return 2 if (missing or stranded) else 0


if __name__ == '__main__':
    sys.exit(main())
