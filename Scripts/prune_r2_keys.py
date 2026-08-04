#!/usr/bin/env python3
"""prune_r2_keys.py - delete the superseded chartpack keys from R2.

Personal use only, not for distribution or resale; not for navigation.

    py .\\prune_r2_keys.py --key-map "F:\\TrollMapPipeline\\registry\\key_map.json" --dry-run
    py .\\prune_r2_keys.py --key-map "F:\\TrollMapPipeline\\registry\\key_map.json" --go

WHY THESE KEYS EXIST AND WHY THEY GO

The curated R2 keys date from before lakes could be separated cleanly out of 3DHP, so several
are COMBINED packs holding two lakes in one object set -- `lake_wateree_fishing_creek`,
`lake_norman_mountain_island`, `lake_hickory_rhodhiss`, `lake_thurmond_russell`,
`watauga_boone_chain`, `lake_greenwood_secession`. The registry now cuts one pack per lake
against its own boundary polygon, so the merged versions are not just redundant, they are
wrong: selecting Norman would load Mountain Island's contours too.

WHAT IT WILL NOT DELETE

The keys in `curated_keys_with_no_registry_match`. Those are lakes 3DHP never named -- the
Bates Old River class, plus `falls_lake`, `kerr_lake`, `lake_blalock`, `lake_lanier`,
`catawba_narrows`. Nothing replaces them yet, so deleting them removes the lake from the app
entirely. They go once synthetic boundaries are cut from Garmin's own mode 6/20 waterbody
polygons.

It also refuses to delete a key unless the replacement packs are actually present in R2 --
pass --require-replacement (the default). `--force` skips that check, and should not be
needed.
"""
import argparse, json, os, subprocess, sys

WRANGLER_JS = os.environ.get(
    "WRANGLER_JS",
    os.path.expandvars(r"%APPDATA%\npm\node_modules\wrangler\bin\wrangler.js"))
BUCKET = os.environ.get("TROLLMAP_BUCKET", "trollmap-chartpacks")
LAYERS = ('contours.geojson', 'depth_areas.geojson', 'hydrography.geojson', 'pois.geojson',
          'waterbody.geojson', 'docks.geojson', 'garmin_shoreline.geojson',
          'shoreline.geojson', 'depth_regions.geojson', 'waterbodies.geojson',
          'index.json', 'meta.json')


def wrangler(*args, capture=True):
    """Run a wrangler r2 object subcommand.

    Bytes, not text. `text=True` decodes with the LOCALE default, which on Windows is
    cp1252 -- and wrangler writes a UTF-8 banner (and, with --pipe, the raw object body).
    That raised `UnicodeDecodeError: 'charmap' codec can't decode byte 0x8f` inside
    subprocess's stdout-reader thread on every call. The deletes still went through, so it
    looked like harmless noise, but a decode error in the reader means the returned text is
    whatever survived -- i.e. the string this function hands back for error reporting was
    already unreliable.

    capture=False sends stdout to the void. `exists()` only wants the exit code, and with
    --pipe the stdout it was buffering is the entire object -- up to half a gigabyte for a
    contours layer, held in memory to be thrown away.
    """
    cmd = ["node", WRANGLER_JS, "r2", "object", *args, "--remote"]
    p = subprocess.run(
        cmd,
        stdout=(subprocess.PIPE if capture else subprocess.DEVNULL),
        stderr=subprocess.PIPE,
    )
    dec = lambda b: (b or b'').decode('utf-8', errors='replace')
    return p.returncode, dec(p.stdout if capture else b'') + dec(p.stderr)


def exists(key):
    rc, _ = wrangler("get", f"{BUCKET}/{key}", "--pipe", capture=False)
    return rc == 0


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--key-map', required=True)
    ap.add_argument('--packs', help='local chartpack folder, to verify replacements exist '
                                    'on disk instead of querying R2 (much faster)')
    ap.add_argument('--dry-run', action='store_true', default=True)
    ap.add_argument('--go', action='store_true', help='actually delete')
    ap.add_argument('--force', action='store_true',
                    help='delete even if the replacement pack is missing. Does NOT override '
                         'the self-supersession check -- a key that is its own replacement is '
                         'never deletable, because deleting it deletes the replacement.')
    a = ap.parse_args()
    if a.go:
        a.dry_run = False

    km = json.load(open(a.key_map, encoding='utf-8'))
    sup = km.get('curated_key_superseded_by') or {}
    keep = km.get('curated_keys_with_no_registry_match') or []

    # ── SELF-SUPERSESSION: the key IS its own replacement ────────────────────────────
    #
    # 29 of 48 entries in the 2026-08-03 key_map looked like this:
    #
    #     lake_marion   ->  ['lake_marion']
    #     norris_lake   ->  ['norris_lake']
    #
    # The curated R2 key and the registry slug are the SAME STRING. R2 has no concept of an
    # old object and a new object living at one key -- when the registry pack uploaded, it
    # OVERWROTE the curated one. They are the same bytes. So "delete the superseded key" here
    # means "delete the pack that replaced it", and this script would have removed Lake Marion,
    # Moultrie, Keowee, Jocassee, Norris, Watts Bar and 23 more, hours after they were built
    # and pushed.
    #
    # It survived the first dry run by accident: 7 of them were held back because an unrelated
    # tiny lake had no pack yet, and the message invited the user to override that with
    # --force. Following that advice would have destroyed Lake Murray's 197 MB pack.
    #
    # This check runs BEFORE anything else and --force does NOT override it. A flag that means
    # "I accept the risk" is for risks the user can evaluate; deleting the object you just
    # created is not one of them.
    # The rule is NOT "the key appears in its own replacement list". It is "the key is a
    # registry slug at all". north_saluda_reservoir is a registry lake (1,037 ac, shipped) that
    # make_key_map fuzzy-bound to lake_robinson -- a DIFFERENT 2,099-acre lake three miles
    # away. The replacement list says ['lake_robinson'], so a k-in-v test waves it through, and
    # deleting the key deletes North Saluda's own freshly-built pack.
    #
    # Membership of `slug_to_r2_key` is the honest test: if the registry writes a pack to that
    # key, the key is live, whatever the supersession table believes.
    live_slugs = set((km.get('slug_to_r2_key') or {}).keys()) \
               | set((km.get('slug_to_r2_key') or {}).values())
    self_ref = {k: v for k, v in sup.items() if k in v or k in live_slugs}
    if self_ref:
        print('\n%d curated keys are LIVE REGISTRY SLUGS -- refusing to touch them.' % len(self_ref))
        print('   The registry writes a pack to that exact key, so the new pack overwrote the')
        print('   old one in place. Deleting the key deletes the replacement.')
        for k in sorted(self_ref)[:12]:
            print('     %-34s -> %s' % (k, ', '.join(self_ref[k])))
        if len(self_ref) > 12:
            print('     ... %d more' % (len(self_ref) - 12))
        for k in self_ref:
            sup.pop(k)

    print('\n%d curated keys genuinely superseded, %d kept (no registry lake covers them)'
          % (len(sup), len(keep)))

    plan, blocked = [], []
    for old, slugs in sorted(sup.items()):
        if a.force:
            plan.append((old, slugs)); continue
        missing = []
        for s in slugs:
            if a.packs:
                ok = os.path.isdir(os.path.join(a.packs, s)) and \
                     os.path.exists(os.path.join(a.packs, s, 'contours.geojson'))
            else:
                ok = exists(f'{s}/contours.geojson')
            if not ok:
                missing.append(s)
        (plan if not missing else blocked).append((old, slugs) if not missing
                                                  else (old, missing))

    print('\n%d keys ready to delete:' % len(plan))
    for old, slugs in plan[:30]:
        print('   %-32s replaced by %s' % (old, ', '.join(slugs)))
    if len(plan) > 30:
        print('   ... %d more' % (len(plan) - 30))

    if blocked:
        print('\n%d keys NOT deleted -- their replacement pack has no contours.geojson yet:'
              % len(blocked))
        for old, missing in blocked[:20]:
            print('   %-32s waiting on %s' % (old, ', '.join(missing)))
        print('   (a lake with no soundings never gets a pack, by design -- if that is why, '
              'delete it with --force once you have checked)')

    print('\n%d keys kept untouched:' % len(keep))
    print('   ' + ', '.join(keep))

    if a.dry_run:
        print('\nDRY RUN. Nothing deleted. Re-run with --go.')
        return

    n = 0
    for old, _slugs in plan:
        if old in _slugs or old in live_slugs:   # cannot happen; belt and braces at the syscall
            print('   REFUSING %s -- it is a live registry slug' % old)
            continue
        for f in LAYERS:
            rc, out = wrangler("delete", f"{BUCKET}/{old}/{f}")
            if rc == 0:
                n += 1
                print('   deleted %s/%s' % (old, f))
    print('\n%d objects deleted across %d keys.' % (n, len(plan)))


if __name__ == '__main__':
    main()
