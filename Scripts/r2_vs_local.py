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
    a = ap.parse_args()

    root = os.path.dirname(a.packs.rstrip('\\/'))
    listing = a.listing or os.path.join(root, 'registry', '_r2_listing.json')
    if not os.path.exists(listing):
        sys.exit('no listing at %s\n'
                 '   py .\\scripts\\r2_audit.py --save "%s"' % (listing, listing))

    age_h = (time.time() - os.path.getmtime(listing)) / 3600.0
    print('listing  %s' % listing)
    print('         saved %s (%.1f h ago)'
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
    local = walk_local(a.packs)

    # A boundary's local home is registry/boundaries/<slug>.geojson, NOT
    # chartpack/<slug>/boundary.geojson. Without this every served boundary reads as R2-only,
    # which is exactly the false alarm that would stop a prune for no reason.
    bdir = os.path.join(root, 'registry', 'boundaries')
    if os.path.isdir(bdir):
        for fn in os.listdir(bdir):
            if fn.endswith('.geojson'):
                fp_b = os.path.join(bdir, fn)
                local['%s/boundary.geojson' % fn[:-len('.geojson')]] = os.path.getsize(fp_b)

    both = set(r2) & set(local)
    r2only = sorted(set(r2) - set(local))
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
    print('  R2 ONLY     %7s   NOT on the drive. Pruning these loses them for good.'
          % format(len(r2only), ','))

    if loconly:
        by = {}
        for k in loconly:
            by.setdefault(k.split('/')[0], []).append(k)
        print('\nlocal only, %d pack(s). Biggest handful:' % len(by))
        for slug in sorted(by, key=lambda s: -len(by[s]))[:a.show]:
            print('   %-34s %d file(s)' % (slug, len(by[slug])))

    out = a.out or os.path.join(root, 'registry', '_r2_only.txt')
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
        print('\n   Each of these is in the bucket and nowhere else. Before any prune, decide')
        print('   per FILENAME which of the three it is:')
        print('     regenerated by another script  osm-structures.geojson comes from')
        print('                                    fetch_osm_structures.py, which reads OSM, not')
        print('                                    the drive. Deleting it costs a re-run.')
        print('     a dead layer                   shoreline / fishing_lines / oyster_beds and')
        print('                                    the rest are names this pipeline no longer')
        print('                                    writes. Deleting them is the point.')
        print('     genuinely lost                 anything the current build DOES produce.')
        print('                                    Those want a local copy first.')
        return 1

    print('\nNothing is R2-only. Every object in the bucket exists on the drive, so any prune')
    print('is reversible with upload_garmin_to_r2.py --force on the affected slugs.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
