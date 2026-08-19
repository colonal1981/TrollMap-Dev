#!/usr/bin/env python3
r"""r2_vs_local.py - is everything in R2 also on the drive? Answer that BEFORE deleting.

Personal use only, not for distribution or resale; not for navigation.

    py .\scripts\r2_audit.py --save "F:\TrollMapPipeline\registry\_r2_listing.json"
    py .\scripts\r2_vs_local.py --packs "F:\TrollMapPipeline\chartpack"

WHY THIS EXISTS

Ryan, 2026-08-13, before pruning 1,244 packs out of the bucket: *"i want something that will
check all chartpacks on r2 and make sure we have the local copy... then it is just a matter of an
upload to fix it"*.

That is the right question in the right order. A delete is only safe if the thing deleted can be
put back, and it can only be put back if it is on the drive. An object that exists ONLY in R2 is
unrecoverable the moment it is pruned -- no upload can restore a file that is not local, because
uploads go one way.

WHY NOT find_r2_orphans.py

That one reads `chartpack/_r2_manifest.json`, which is a LOCAL record of what the uploader
believes it sent. It is not a reading of the bucket. Three sessions in a row have confused those
two -- the water_bindings.json affair is the write-up -- and a manifest cannot possibly report an
object it never wrote. Only the bucket knows what is in the bucket.

WHAT IT COMPARES

`r2_audit.py --save` writes `registry/_r2_listing.json` by asking the Worker for
`/chartpacks/list?detail=1`, which is every pack and every file in it. This walks
`chartpack/<slug>/<file>` on disk and sets the two against each other, key by key:

    BOTH        on the drive and in the bucket -- safe to prune, an upload puts it back
    LOCAL ONLY  never uploaded, or uploaded and since deleted -- an upload fixes it
    R2 ONLY     THE ONE THAT MATTERS. Not on the drive. Pruning it loses it for good.

STALENESS IS THE WHOLE RISK

A listing saved days ago will happily report that an object added since is R2-only, or miss one
entirely. `--max-age-h` refuses to run against a listing older than 6 hours by default, because
the failure here is silent and expensive. `00_START_HERE`: a stale R2 listing is not R2 either --
check the date on every artefact, including the one that agrees with you.

The three `_registry/` objects the app reads are NOT in this listing's shape.
`verify_registry_r2.py` is the check for those, and it fetches them rather than listing them.
"""
import argparse, importlib.util, json, os, sys, time


# ── where an R2 key actually lives on the drive ─────────────────────────────────────────────
#
# NOT every key is chartpack/<slug>/<file>. Ryan, 2026-08-13: "where on my drive is it checking
# for these things at?" -- and the answer was two places, which made 1,602 osm-structures objects
# read as unrecoverable when they are sitting in osm_out/ under a different name.
#
#   fetch_osm_structures.py:736   writes  osm_out/<slug>.geojson
#   fetch_osm_structures.py:681   uploads <slug>/osm-structures.geojson
#
# Same story for boundaries. Anything added to this table stops being a false alarm.
SOURCE_MAP = {
    'boundary.geojson': [('registry/boundaries',        '%s.geojson'),
                         ('lake_boundaries_3dhp',       '%s_3dhp.geojson'),
                         ('_to_delete/lake_boundaries', '%s_3dhp.geojson'),
                         ('_to_delete/lake_boundaries', '%s.geojson')],
    'osm-structures.geojson': [('osm_out',              '%s.geojson')],
    # THE I-BOATING TREE IS A SOURCE, and leaving it out of this table is what made 101 of the
    # 333 "R2 ONLY" alarms -- 81 shoreline + 20 depth_soundings -- read as unrecoverable data.
    #
    # Both layers come from the retired i-Boating coastal pipeline, which is why they are not
    # under chartpack/: upload_to_r2_coastal.py pushed them from its own output tree and that
    # tree is still on the drive. Checked on the six NC/GA zones 2026-08-19 and every one is a
    # BYTE-FOR-BYTE match against the R2 listing -- coast_pamlico_sound_nc/shoreline.geojson is
    # 9,032,342 in both places, depth_soundings 5,146,511 in both.
    #
    # Ryan, on being handed a hand-rolled version of this check: "we already have a script that
    # does this check". It is this one, and the reason it under-reported is a missing row here
    # rather than anything about the objects. This file's own advice, printed under the R2-ONLY
    # list: "it has a local home this script does not know about -- add it to SOURCE_MAP and it
    # stops being an alarm, the way osm_out/ did."
    'shoreline.geojson': [
        ('I-Boating Contours and supplemental data/supplemental/%s', 'shoreline.geojson')],
    'depth_soundings.geojson': [
        ('I-Boating Contours and supplemental data/supplemental/%s', 'depth_soundings.geojson')],
    # AND THE OTHER TWO i-BOATING LAYERS ARE IN THE SAME TREE, 70 files each. They had been on
    # the PROTECTED list since 2026-08-13 as "R2-only BY DESIGN" -- 175 objects nothing was
    # allowed to touch because no source was known for them. The source is this directory, and
    # it was found only because shoreline and depth_soundings led here.
    #
    # PROTECTED is a stronger claim than SOURCE_MAP and it was carrying names that only needed a
    # row here. A name on both lists is not a contradiction: SOURCE_MAP says where it can be got
    # back from, PROTECTED says do not propose it. Ryan's reason for the second still stands --
    # "there is no pipeline replacement for them" -- so nothing here proposes them. What changes
    # is that they stop being counted as data that exists nowhere else, which they never were.
    'fishing_lines.geojson': [
        ('I-Boating Contours and supplemental data/supplemental/%s', 'fishing_lines.geojson')],
    'fishing_points.geojson': [
        ('I-Boating Contours and supplemental data/supplemental/%s', 'fishing_points.geojson')],
}

# ── objects that live in R2 and NOWHERE else, on purpose ────────────────────────────────────
#
# Ryan, 2026-08-13: "fishing lines, fishing points marsh edges and oyster beds need to stay...
# they are not part of the pipeline but there is no pipeline replacement for them".
#
# These are reported separately and never counted as a loss, because an earlier draft of this
# file told him deleting them "is the point". That advice was wrong and would have destroyed
# data no script here can rebuild. r2_audit.deletable() already returns None for all four, so
# nothing proposes them for deletion -- this is the second lock, not the first.
PROTECTED = {
    'fishing_lines.geojson',
    'fishing_points.geojson',
    'marsh_edges.geojson',
    'oyster_beds.geojson',
}

# ── R2-only but REGENERABLE, which is not the same as lost ──────────────────────────────────
#
# Ryan, 2026-08-13: "as long as the OSM script and the OSM pbfs are on my drive that is all that
# actually matters... we couldn't get the OSM script to fetch from the internet without timeouts
# so i downloaded the pbf files".
#
# That is the whole answer for osm-structures. fetch_osm_structures.py makes its local write
# OPTIONAL (--out-dir, line 733), so a run without it went OSM -> memory -> R2 and the drive
# never saw the output -- but the INPUT is on the drive, and the input is what matters. Deleting
# these costs a re-run, not data.
#
# The DNR feeds are the same shape with a different input: the Worker pulls them live, so they
# regenerate from the agency rather than from disk.
REGENERABLE = {
    'osm-structures.geojson': ('fetch_osm_structures.py --out-dir osm_out',
                               'osm_pbf/ on this drive'),
    # clarity-cache/<slug>.json is 225 bytes of Worker-side cache, rebuilt on demand.
    'clarity-cache': ('the Worker, on the next request', 'nothing -- it is a cache'),
    'attractors.json':        ('the Worker DNR routes', 'the state agency, live'),
    'bankpier.json':          ('the Worker DNR routes', 'the state agency, live'),
    'ramps.json':             ('the Worker DNR routes', 'the state agency, live'),
    'paddle.json':            ('the Worker DNR routes', 'the state agency, live'),
}


def drive_index(root, cache_fp, max_age_h, reindex, quiet=False):
    """Every file on the drive, indexed by basename. Cached, because the walk is the slow part.

    Ryan, 2026-08-13: "i mean the entire drive not just random folders". SOURCE_MAP below is a
    hand-written table of where each key lives, and a hand-written table is only ever as good as
    the last time someone remembered to add to it -- osm_out/ was missing from it and turned
    1,602 recoverable objects into an alarm. This is the backstop: if a copy exists ANYWHERE
    under the drive root, say so and say where.

    _to_delete/ is deliberately included. A file parked there is still on the drive, which is
    the only question this script asks.
    """
    if not reindex and os.path.exists(cache_fp):
        age_h = (time.time() - os.path.getmtime(cache_fp)) / 3600.0
        if age_h <= max_age_h:
            try:
                idx = json.load(open(cache_fp, encoding='utf-8'))
                if not quiet:
                    print('drive index   %s  (%s name(s), %.1f h old)'
                          % (cache_fp, format(len(idx), ','), age_h))
                return idx
            except (OSError, ValueError):
                pass
    print('drive index   walking %s ...' % root, flush=True)
    idx, n, t0 = {}, 0, time.time()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d != '.git']
        rel = os.path.relpath(dirpath, root)
        for fn in filenames:
            idx.setdefault(fn, []).append(rel)
            n += 1
            if n % 20000 == 0:
                print('              %s file(s), %.0fs' % (format(n, ','), time.time() - t0),
                      flush=True)
    print('              %s file(s) under %s distinct name(s), %.0fs'
          % (format(n, ','), format(len(idx), ','), time.time() - t0))
    try:
        tmp = cache_fp + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as fh:
            json.dump(idx, fh)
        os.replace(tmp, cache_fp)
        print('              -> %s' % cache_fp)
    except OSError as e:
        print('              !! could not cache the index (%s) -- next run re-walks' % e)
    return idx


def _slash(p):
    """Both separators, always. The cached index is written by whichever machine walked the
    drive -- Windows stores 'a\\b', and os.sep on anything else is '/', so normalising by os.sep
    alone leaves the other one intact and every path component test silently fails. That turned
    150 correct FOUND results into 216 weak ones with no error anywhere."""
    return p.replace('\\', '/').replace(os.sep, '/')


def find_on_drive(key, idx, lower):
    """Where a missing R2 object might already be. Returns (verdict, path or '').

    `key` is the whole R2 key, because not every one is <slug>/<file>. The DNR feeds are
    <kind>/<state>/<kind>.json -- attractors/sc/attractors.json -- and splitting on the first
    slash called the kind a slug and 'sc/attractors.json' a filename, so nothing ever matched.
    Their local home is registry/_dnr_<kind>_<state>.json, which is a naming scheme no amount of
    per-slug guessing would reach.

    Matching is case-insensitive: the drive is NTFS, so Shoreline.geojson and shoreline.geojson
    are the same file and a case-sensitive miss is a fabricated loss.
    """
    parts = _slash(key).split('/')
    slug, fname = parts[0], parts[-1]
    stem = fname.rsplit('.', 1)[0]
    ext = fname[len(stem):]

    # the DNR state feeds, whose key shape is <kind>/<state>/<kind>.json
    if len(parts) == 3 and len(parts[1]) == 2:
        for cand in ('_dnr_%s_%s%s' % (parts[0], parts[1], ext),
                     '_dnr_%s_%s%s' % (parts[2].rsplit('.', 1)[0], parts[1], ext)):
            for p in lower.get(cand.lower(), []):
                return 'found', '%s/%s' % (p[0], p[1])

    # the same filename under a path that names the lake -- the strongest signal there is
    for p, real in lower.get(fname.lower(), []):
        if slug.lower() in [x.lower() for x in _slash(p).split('/')]:
            return 'found', '%s/%s' % (p, real)

    # NO generic <slug>.geojson fallback. It was here, and it matched ANY per-slug .geojson to
    # ANY .geojson key -- so blair_pond/boundary.geojson "found" osm_out/blair_pond.geojson, and
    # barren_fork_river/osm-structures.geojson "found" registry/boundaries/barren_fork_river.geojson.
    # Both are the wrong file. A false FOUND is the dangerous direction here: it says safe-to-prune
    # about something that is not on the drive. Per-slug renaming is a real convention, but it is
    # per key file, so it belongs in SOURCE_MAP where it can be stated exactly.

    hits = lower.get(fname.lower(), [])
    if hits:
        return 'same-name-elsewhere', '%s/%s' % (hits[0][0], hits[0][1])
    return 'missing', ''


def lower_index(idx):
    """basename.lower() -> [(dir, real basename)]. Built once, not per lookup."""
    out = {}
    for name, dirs in idx.items():
        out.setdefault(name.lower(), []).extend((d, name) for d in dirs)
    return out


# ── one-off keys whose local twin is renamed beyond guessing ────────────────────────────────
#
# Verified by byte count on 2026-08-13, not by name: R2 zones.json is 4,617,557 bytes and so is
# scripts/_data_2026-08-04/wateree_zones.json. Same for the spines at 3,445,929. A rename this
# far from the key ("lake_wateree_fishing_creek/zones.json" against "wateree_zones.json") is not
# something a pattern should be asked to find -- state it and move on.
KEY_ALIASES = {
    'lake_wateree_fishing_creek/zones.json':
        'scripts/_data_2026-08-04/wateree_zones.json',
    'lake_wateree_fishing_creek/zones_spines.json':
        'scripts/_data_2026-08-04/wateree_zones_spines.json',
}


def split_parents(root):
    """Slugs that were split into children, so their old objects are superseded, not lost.

    2026-08-09 split blair_pond into blair_pond_madison and blair_pond_tift, and three others
    the same way. R2 still holds a boundary under the parent name. That is not a missing local
    file -- the parent does not exist any more. prune_r2_keys.py --key-map is what removes them.
    """
    fp = os.path.join(root, 'registry', '_split_map_2026-08-09.json')
    try:
        return json.load(open(fp, encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def _audit():
    """r2_audit.py's own vocabulary, imported rather than restated.

    NON_PACK_PREFIXES and the boundary key shape live there. A second copy here would be
    right today and wrong the first time one of them changes -- which is the same reason
    is_pack() was an exact match after `lakeside_reservoir` got swallowed by `lakes`.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location('r2_audit', os.path.join(here, 'r2_audit.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def walk_local(packs):
    """<slug>/<file> for every regular file under the pack root, one level down."""
    out = {}
    if not os.path.isdir(packs):
        sys.exit('no pack root at %s' % packs)
    for slug in sorted(os.listdir(packs)):
        d = os.path.join(packs, slug)
        if not os.path.isdir(d):
            continue
        for fn in os.listdir(d):
            fp = os.path.join(d, fn)
            if os.path.isfile(fp):
                out['%s/%s' % (slug, fn)] = os.path.getsize(fp)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--packs', required=True, help='chartpack root')
    ap.add_argument('--listing', default=None,
                    help='r2_audit.py --save output. Default <packs>/../registry/_r2_listing.json')
    ap.add_argument('--max-age-h', type=float, default=6.0,
                    help='refuse a listing older than this many hours (default 6). 0 disables '
                         'the check, which is how a stale answer gets believed.')
    ap.add_argument('--out', default=None,
                    help='write the R2-only keys here, one per line. Default '
                         '<packs>/../registry/_r2_only.txt')
    ap.add_argument('--show', type=int, default=12, help='rows to print per section')
    ap.add_argument('--no-drive-scan', action='store_true',
                    help='skip the whole-drive search. Faster, and answers a smaller question.')
    ap.add_argument('--reindex', action='store_true', help='rebuild the drive index now')
    ap.add_argument('--index-age-h', type=float, default=24.0,
                    help='reuse a cached drive index younger than this (default 24)')
    a = ap.parse_args()

    # ABSOLUTE, and printed. Ryan, 2026-08-13: "unless this audit is checking
    # f:\trollmappipelline then this audit is useless". He is right, and a tool that compares
    # two things must say which two things it compared.
    packs = os.path.abspath(a.packs)
    root = os.path.dirname(packs.rstrip('\\/'))
    listing = os.path.abspath(a.listing or os.path.join(root, 'registry', '_r2_listing.json'))
    print('drive root   %s' % root)
    print('packs        %s   (%s dir(s))'
          % (packs, format(sum(1 for d in os.listdir(packs)
                               if os.path.isdir(os.path.join(packs, d))), ',')
             if os.path.isdir(packs) else 'MISSING'))
    if not os.path.exists(listing):
        sys.exit('no listing at %s\n'
                 '   py .\\scripts\\r2_audit.py --save "%s"' % (listing, listing))

    age_h = (time.time() - os.path.getmtime(listing)) / 3600.0
    print('listing      %s' % listing)
    print('             saved %s (%.1f h ago)'
          % (time.strftime('%Y-%m-%d %H:%M', time.localtime(os.path.getmtime(listing))), age_h))
    if a.max_age_h and age_h > a.max_age_h:
        sys.exit('\nSTOP: that listing is %.1f h old and the limit is %.1f.\n'
                 '      A stale listing will call an object R2-only that is not, and miss one\n'
                 '      that is. Refresh it, then re-run:\n'
                 '      py .\\scripts\\r2_audit.py --save "%s"' % (age_h, a.max_age_h, listing))

    doc = json.load(open(listing, encoding='utf-8'))
    AU = _audit()
    r2, nonpack = {}, {}
    for pack in (doc.get('chartpacks') or []):
        name = pack.get('name')
        # research/, lake_packages/, lakes/, _registry/ and friends are not pipeline packs --
        # the Worker writes them and the drive was never meant to hold them. Counting them as
        # "R2 only" would bury the objects that genuinely are.
        tgt = r2 if AU.is_pack(name) else nonpack
        for f in (pack.get('files') or []):
            tgt['%s/%s' % (name, f.get('name'))] = f.get('bytes')
    local = walk_local(packs)

    # Fold in every key whose local home is somewhere other than the pack directory.
    for key_file, places in sorted(SOURCE_MAP.items()):
        for subdir, pattern in places:
            # TWO LAYOUTS, ONE TABLE. A flat directory carries the slug in the FILE name
            # (osm_out/<slug>.geojson). A per-pack tree carries it in the DIRECTORY name
            # (.../supplemental/<slug>/shoreline.geojson), which is the layout chartpack/ uses
            # and the layout the i-Boating output tree uses. A trailing '/%s' in the subdir is
            # what says which. One table rather than two, because a second table is a second
            # place to forget to add a row -- and a forgotten row here does not read as a gap,
            # it reads as data that only exists in R2.
            if subdir.endswith('/%s'):
                parent = os.path.join(root, *subdir[:-len('/%s')].split('/'))
                if not os.path.isdir(parent):
                    continue
                n = 0
                for slug in os.listdir(parent):
                    fp = os.path.join(parent, slug, pattern)
                    if not os.path.isfile(fp):
                        continue
                    k = '%s/%s' % (slug, key_file)
                    if k not in local:                 # first place named wins
                        local[k] = os.path.getsize(fp)
                        n += 1
                print('   %-24s <- %s  (%s file(s))'
                      % (key_file, os.path.join(parent, '<slug>', pattern), format(n, ',')))
                continue
            d = os.path.join(root, *subdir.split('/'))
            if not os.path.isdir(d):
                continue
            suffix = pattern % ''
            n = 0
            for fn in os.listdir(d):
                if fn.endswith(suffix) and len(fn) > len(suffix):
                    k = '%s/%s' % (fn[:-len(suffix)], key_file)
                    if k not in local:                 # first place named wins
                        local[k] = os.path.getsize(os.path.join(d, fn))
                        n += 1
            print('   %-24s <- %s  (%s file(s))' % (key_file, d, format(n, ',')))

    both = set(r2) & set(local)
    r2only_all = set(r2) - set(local)
    protected = sorted(k for k in r2only_all if k.split('/', 1)[1] in PROTECTED)
    r2only = sorted(r2only_all - set(protected))
    loconly = sorted(set(local) - set(r2))

    print()
    print('R2      %s pack object(s), plus %s under non-pack prefixes (%s) -- not compared'
          % (format(len(r2), ','), format(len(nonpack), ','),
             ', '.join(sorted({k.split('/')[0] for k in nonpack})[:5]) or 'none'))
    print('local   %s file(s) over %s pack(s)'
          % (format(len(local), ','),
             format(len({k.split('/')[0] for k in local}), ',')))
    print()
    print('  BOTH        %7s   safe to prune -- an upload puts any of these back'
          % format(len(both), ','))
    print('  LOCAL ONLY  %7s   never uploaded (or already pruned) -- an upload fixes it'
          % format(len(loconly), ','))
    print('  PROTECTED   %7s   R2-only BY DESIGN and must stay -- %s'
          % (format(len(protected), ','), ', '.join(sorted(PROTECTED))))
    print('  R2 ONLY     %7s   NOT on the drive and not protected. Pruning loses them.'
          % format(len(r2only), ','))

    if loconly:
        by = {}
        for k in loconly:
            by.setdefault(k.split('/')[0], []).append(k)
        print('\nlocal only, %d pack(s). Biggest handful:' % len(by))
        for slug in sorted(by, key=lambda s: -len(by[s]))[:a.show]:
            print('   %-34s %d file(s)' % (slug, len(by[slug])))

    # ── the whole-drive backstop ────────────────────────────────────────────────────────────
    #
    # Everything still R2-only after SOURCE_MAP gets one more chance: is a copy anywhere under
    # the drive root, under any name, in any folder? Only what survives THAT is a real loss.
    elsewhere, missing = [], r2only
    if r2only and not a.no_drive_scan:
        print()
        idx = drive_index(root, os.path.join(root, 'registry', '_drive_files.json'),
                          a.index_age_h, a.reindex)
        lower = lower_index(idx)
        splits = split_parents(root)
        elsewhere, weak, missing, superseded = [], [], [], []
        for k in r2only:
            if k in KEY_ALIASES:
                p = os.path.join(root, *KEY_ALIASES[k].split('/'))
                note = ''
                if os.path.exists(p) and r2.get(k) == os.path.getsize(p):
                    note = ' (byte for byte)'
                elif os.path.exists(p):
                    note = ' (SIZES DIFFER -- %s vs %s, look before pruning)' % (
                        format(r2.get(k) or 0, ','), format(os.path.getsize(p), ','))
                if os.path.exists(p):
                    elsewhere.append((k, KEY_ALIASES[k] + note))
                    continue
            if k.split('/', 1)[0] in splits:
                superseded.append((k, ', '.join(splits[k.split('/', 1)[0]])))
                continue
            verdict, where = find_on_drive(k, idx, lower)
            if verdict == 'found':
                elsewhere.append((k, where))
            elif verdict == 'same-name-elsewhere':
                weak.append((k, where))
            else:
                missing.append(k)
        def _regen_key(k):
            tail = k.rsplit('/', 1)[-1]
            head = k.split('/', 1)[0]
            return tail if tail in REGENERABLE else (head if head in REGENERABLE else None)
        regen = [k for k in missing if _regen_key(k)]
        missing = [k for k in missing if not _regen_key(k)]
        print('\n  of the %s R2-only object(s):' % format(len(r2only), ','))
        print('    %6s  found elsewhere on the drive -- recoverable, just not where I looked'
              % format(len(elsewhere), ','))
        print('    %6s  a file of the same name exists but not for this lake -- check by hand'
              % format(len(weak), ','))
        print('    %6s  superseded: the slug was split, so the parent no longer exists'
              % format(len(superseded), ','))
        print('    %6s  regenerable from an input that IS on the drive -- not a loss'
              % format(len(regen), ','))
        print('    %6s  NOT ANYWHERE ON THE DRIVE' % format(len(missing), ','))
        seen_r = {}
        for k in regen:
            seen_r[_regen_key(k)] = seen_r.get(_regen_key(k), 0) + 1
        for fn, n in sorted(seen_r.items(), key=lambda kv: -kv[1]):
            how, src = REGENERABLE[fn]
            print('      regen  %5d  %-24s  re-run %s  from %s' % (n, fn, how, src))
        for k, kids in superseded[:a.show]:
            print('      split  %-44s -> now %s' % (k, kids))
        for k, where in elsewhere[:a.show]:
            print('      found  %-44s -> %s' % (k, where))
        if len(elsewhere) > a.show:
            print('      ... %d more' % (len(elsewhere) - a.show))
        for k, where in weak[:4]:
            print('      weak   %-44s -> %s' % (k, where))
        if elsewhere:
            print('\n    Anything on that list means SOURCE_MAP is missing an entry. Add it and the')
            print('    alarm goes away permanently, which is what happened with osm_out/.')
        r2only = missing

    out = os.path.abspath(a.out or os.path.join(root, 'registry', '_r2_only.txt'))
    if r2only:
        by = {}
        for k in r2only:
            by.setdefault(k.split('/')[0], []).append(k)
        print('\n!! R2 ONLY -- %d object(s) over %d pack(s). Read this before any prune.'
              % (len(r2only), len(by)))
        # By FILENAME, not by pack. The pack view says "1,607 packs" and tells you nothing; the
        # filename view says "1,602 of these are osm-structures.geojson" and tells you the whole
        # story in one line.
        byname = {}
        for k in r2only:
            byname.setdefault(k.split('/', 1)[1], 0)
            byname[k.split('/', 1)[1]] += 1
        print('   by filename, which is what says whether it can be regenerated:')
        for fn, n in sorted(byname.items(), key=lambda kv: -kv[1])[:a.show]:
            print('   %6d  %s' % (n, fn))
        if len(byname) > a.show:
            print('   %6d  across %d more filename(s)'
                  % (sum(n for _, n in sorted(byname.items(), key=lambda kv: -kv[1])[a.show:]),
                     len(byname) - a.show))
        with open(out, 'w', encoding='utf-8') as fh:
            fh.write('\n'.join(r2only) + '\n')
        print('   -> %s' % out)
        print('\n   Each of these is in the bucket and nowhere else, and none of them is on the')
        print('   protected list. For each FILENAME, one of two things is true:')
        print('     it has a local home this script does not know about -- add it to SOURCE_MAP')
        print('        and it stops being an alarm, the way osm_out/ did')
        print('     it really is only in R2 -- pull it down before pruning, or accept the loss')
        print('   Do NOT read this list as a delete list. It is the opposite: it is what a')
        print('   delete list must not touch until each line above is answered.')
        return 1

    print('\nNothing is unaccounted for. Every object in the bucket exists somewhere on the')
    print('drive, so any prune is reversible -- upload_garmin_to_r2.py --force on the affected')
    print('slugs, or a re-run of whatever script writes that layer.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
