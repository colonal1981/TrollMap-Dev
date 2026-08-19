#!/usr/bin/env python3
"""
merge_duplicate_waters.py -- fold one registry water into another, from an explicit decision
file, and record what that leaves to delete.

WHY A DECISION FILE AND NOT THE CONFLICT LIST
    match_waters_to_nhd.py finds waterbodies claimed by two slugs. It cannot decide which slug
    survives, and in three of the four real cases the obvious rule is WRONG:

      falls_lake      / brinkley_lake   NHD names the 11,984-acre Falls Lake body "Brinkley Lake"
      hiwassee_lake   / persimmon_lake  NHD puts Persimmon Lake's id on the whole Hiwassee body
      lookout_shoals_lake / lake_lookout  "Lake Lookout" is the local nickname

    In the first two the retiring slug holds a GNIS id that belongs to a DIFFERENT REAL FEATURE.
    Moving it forward would take NHD's mistake and make it deliberately ours. So `gnis` is set
    per pair, never inferred, and may be left null so the keeper binds by NHD
    Permanent_Identifier instead -- a discovered key, like the LID or Duke's lakepondLocationId.

WHAT IT DOES
    For each decision: union the two entries into the keeper, add the retiring water's display
    names to legacy_display_names so searching the old name still finds it, carry across any
    field the keeper lacks (the OSM ramp on kings_mountain_reservoir is the live example), and
    write the retiring slug to a deletion tab with its chartpack size.

    DELETES NOTHING. Ryan's rule: keep a running tab and do all the deleting at the end. The
    retiring slug is removed from the index only with --write, and its R2 chartpack is listed,
    never touched.

USAGE
    py scripts\\merge_duplicate_waters.py --decisions registry\\_merge_decisions.json
    py scripts\\merge_duplicate_waters.py --decisions ... --write
"""
import argparse
import json
import re
import shutil
import sys
from pathlib import Path

REGISTRY_REL = 'registry/lake_index.json'
BINDINGS_REL = 'registry/_nhd_bindings.json'
TAB_REL = 'registry/_deletion_tab.json'

# Fields where the keeper's own value must win because they describe ITS polygon.
GEOMETRY_FIELDS = {'area_acres', 'centroid', 'bounds_wsen', 'charted', 'pack_mb', 'source'}
# Fields merged rather than chosen.
DICT_FIELDS = {'ramps'}
LIST_FIELDS = {'legacy_display_names', 'proclamation', 'access_units'}
# A REGION IS NOT A WATER, AND ITS ACCESS IS NOT ANY ONE CREEK'S.
#
# The carry rule below is right for the case this script was written for -- one water under two
# slugs, where whichever row happens to hold the access classification should win. It is wrong
# when the keeper is a coastal ZONE. mosquito_creek is 'Restricted Access', and folding it into
# coast_santee_delta_sc would have labelled the whole Santee Delta restricted on the strength of
# one 293-acre creek inside it. Ramps still cross -- a ramp on the creek really is a ramp in the
# zone -- and so do the names, which is the point of the merge. Only the classification stops.
REGION_KEEPS_ITS_OWN = {'access', 'access_for_me', 'access_via'}



NAMES_REL = 'registry/lake_display_names.json'


def sync_display_names(names_path, retired, write):
    """Make sure every retired water's name still finds its keeper. Returns (added, note).

    THE PROMISE IN THIS FILE'S HEADER WAS NOT KEPT. merge_entry() appends the retiring water's
    names to the keeper's `legacy_display_names` in lake_index.json -- and
    consolidate_lake_index.py REBUILDS that index from lakes.json on the next run and throws
    them away. Measured 2026-08-19, after seven merges: six of the seven old names no longer
    resolved to anything. Only "Lookout" survived, and only by accident, because
    "Lookout Shoals Lake" happens to contain the word.

        falls_lake            has no Brinkley Lake
        hiwassee_lake         has no Persimmon Lake
        john_h_moss_lake      has no Kings Mountain Reservoir
        santee_river          has no Wilson Dam
        cooper_river          has no Tail Race Canal, no Wadboo Creek

    registry/lake_display_names.json is the file consolidate DOES read for extra names, so the
    name belongs there. This runs over the WHOLE deletion tab rather than only this run's
    merges, which means one --write repairs every merge made before it.
    """
    try:
        doc = json.loads(names_path.read_text(encoding='utf-8')) if names_path.exists() else {}
    except Exception as exc:
        return [], (f'{names_path.name} is unreadable ({type(exc).__name__}) -- retired names '
                    f'are NOT being preserved, and the old name will find nothing')
    # BOTH FORMS, BECAUSE NOBODY TYPES THE COUNTY.
    #
    # The tab stores the display name consolidate built -- "Kings Mountain Reservoir (Cleveland
    # Co, NC)" -- and `also` entries reach legacy_display_names verbatim. An alias for a string
    # no one will ever type is not an alias. consolidate_lake_index.py already solves this for
    # the rename case at its own line 568, storing display_with_county(name) AND the bare name,
    # so this stores the same pair: whatever the tab recorded, plus that with the trailing
    # parenthetical stripped.
    def forms(nm):
        bare = re.sub(r'\s*\([^()]*\)\s*$', '', nm).strip()
        return [nm] + ([bare] if bare and bare != nm else [])

    added = []
    for e in retired:
        keep, dn = e.get('merged_into'), e.get('display_name')
        if not keep or not dn:
            continue
        cur = doc.get(keep)
        # A bare string in this file is a RENAME. Keep it and grow an `also` beside it, rather
        # than replacing it with a dict that drops the rename on the floor.
        if isinstance(cur, str):
            cur = {'name': cur, 'also': []}
        elif not isinstance(cur, dict):
            cur = {'also': []}
        also = list(cur.get('also') or [])
        fresh = [n for n in forms(dn) if n not in also and n != cur.get('name')]
        if not fresh:
            continue
        also.extend(fresh)
        cur['also'] = also
        doc[keep] = cur
        for n in fresh:
            added.append((keep, n))
    if added and write:
        names_path.write_text(json.dumps(doc, indent=1, ensure_ascii=False), encoding='utf-8')
    return added, None


def find_repo_root(explicit=None):
    if explicit:
        p = Path(explicit)
        return p.parent.parent if p.name.endswith('.json') else p
    here = Path.cwd().resolve()
    mine = Path(__file__).resolve().parent
    seen = set()
    for cand in [here] + list(here.parents) + [mine] + list(mine.parents):
        if cand in seen:
            continue
        seen.add(cand)
        if (cand / REGISTRY_REL).exists():
            return cand
    return here


def present(v):
    """Is there a real value here? 0 and False ARE values; None, '', [] and {} are not.
    Written out because `if v:` would drop a legitimate 0 -- the Number('') family again."""
    if v is None:
        return False
    if isinstance(v, str):
        return v.strip() != ''
    if isinstance(v, (list, dict, tuple, set)):
        return len(v) > 0
    return True


def merge_entry(keeper, retiree, keep_slug, retire_slug, gnis=None):
    """Return (merged_entry, notes). Neither input is mutated."""
    out = dict(keeper)
    notes = []
    region = keep_slug.startswith('coast_')

    for k, v in retiree.items():
        if k in GEOMETRY_FIELDS:
            continue                                   # the keeper's polygon is the one we keep
        if region and k in REGION_KEEPS_ITS_OWN:
            if present(v) and not present(out.get(k)):
                notes.append(f'{k}: NOT taken from {retire_slug} ({v!r}) -- {keep_slug} is a '
                             f'region, and one water inside it does not classify the whole zone')
            continue
        if k in DICT_FIELDS:
            merged = dict(v or {})
            merged.update(out.get(k) or {})            # keeper wins on a key collision
            if merged != (out.get(k) or {}):
                notes.append(f'{k}: took {len(merged) - len(out.get(k) or {})} from {retire_slug}')
            out[k] = merged
            continue
        if k in LIST_FIELDS:
            seen, merged = set(), []
            for item in list(out.get(k) or []) + list(v or []):
                key = json.dumps(item, sort_keys=True) if not isinstance(item, str) else item
                if key not in seen:
                    seen.add(key)
                    merged.append(item)
            out[k] = merged
            continue
        if k == 'gnis':
            continue                                   # decided per pair, below
        if not present(out.get(k)) and present(v):
            out[k] = v
            notes.append(f'{k}: empty on {keep_slug}, took {v!r} from {retire_slug}')

    # the retiring water's names must stay searchable
    names = list(out.get('legacy_display_names') or [])
    for cand in (retiree.get('legacy_display_name'), retiree.get('display_name'),
                 retiree.get('name')):
        if present(cand) and cand not in names:
            names.append(cand)
    out['legacy_display_names'] = names

    if 'ramps' in out:
        out['ramp_sources'] = len(out['ramps'] or {})

    if gnis is not None:
        if out.get('gnis') != gnis:
            notes.append(f'gnis: {out.get("gnis")!r} -> {gnis!r} (decided)')
        out['gnis'] = gnis
    else:
        notes.append(f'gnis: left as {out.get("gnis")!r}; the retiring id belongs to another '
                     f'feature and is deliberately NOT inherited')

    out['merged_from'] = sorted(set(list(out.get('merged_from') or []) + [retire_slug]))
    return out, notes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--registry', default=None)
    ap.add_argument('--decisions', required=True)
    ap.add_argument('--bindings', default=None)
    ap.add_argument('--tab', default=None)
    ap.add_argument('--write', action='store_true',
                    help='rewrite lake_index.json (a .bak copy is made first)')
    args = ap.parse_args()

    root = find_repo_root(args.registry)
    reg_path = Path(args.registry) if args.registry else root / REGISTRY_REL
    if not reg_path.exists():
        print(f'registry not found: {reg_path}')
        return 2
    reg = json.loads(reg_path.read_text(encoding='utf-8'))
    dec_path = Path(args.decisions)
    if not dec_path.exists():
        print(f'decisions not found: {dec_path}')
        return 2
    decisions = json.loads(dec_path.read_text(encoding='utf-8'))
    if isinstance(decisions, dict):
        decisions = decisions.get('merges', [])

    bind_path = Path(args.bindings) if args.bindings else root / BINDINGS_REL
    bindings = {}
    if bind_path.exists():
        bindings = json.loads(bind_path.read_text(encoding='utf-8')).get('bindings', {})

    print(f'registry: {reg_path}\nwaters: {len(reg)}\ndecisions: {len(decisions)}\n')

    tab, applied, refused = [], 0, 0
    for d in decisions:
        keep, retire = d.get('keep'), d.get('retire')
        if keep not in reg or retire not in reg:
            print(f'REFUSED {keep} <- {retire}: '
                  f'{"keeper" if keep not in reg else "retiree"} not in the registry')
            refused += 1
            continue
        if keep == retire:
            print(f'REFUSED {keep}: cannot merge a water into itself')
            refused += 1
            continue
        merged, notes = merge_entry(reg[keep], reg[retire], keep, retire, d.get('gnis'))
        # THE SAME RULE AS gnis, WHICH THIS DID NOT FOLLOW.
        #
        # `bindings.get(keep) or bindings.get(retire)` falls through to the RETIREE's binding
        # whenever the keeper has none, and a coastal zone never has one -- so folding
        # mosquito_creek into coast_santee_delta_sc stamped a 293-acre creek's NHD identity,
        # 0304/87652103, onto a 328,000-acre region. The header of this file explains why gnis
        # is decided per pair rather than inherited: "the retiring slug holds a GNIS id that
        # belongs to a DIFFERENT REAL FEATURE. Moving it forward would take NHD's mistake and
        # make it deliberately ours." That argument is about identity, not about which column
        # it is written in, so it governs the NHD id too.
        #
        # A keeper that has its OWN binding still keeps it -- that is the lake-to-lake case and
        # is unchanged.
        b = bindings.get(keep)
        if b is None and not keep.startswith('coast_'):
            b = bindings.get(retire)
        elif b is None and bindings.get(retire):
            notes.append(f'NHD binding: NOT taken from {retire} '
                         f'({bindings[retire].get("vpu")}/'
                         f'{bindings[retire].get("permanent_identifier")}) -- {keep} is a '
                         f'region and does not inherit a water\'s identity')
        if b and b.get('permanent_identifier'):
            merged['nhd_permanent_identifier'] = b['permanent_identifier']
            merged['nhd_vpu'] = b.get('vpu')
            notes.append(f'bound to NHD {b["vpu"]}/{b["permanent_identifier"]}'
                         f' (NHD calls it {b.get("nhd_gnis_name")!r})')
        reg[keep] = merged
        tab.append({'slug': retire, 'merged_into': keep,
                    'pack_mb': reg[retire].get('pack_mb'),
                    'shipped': reg[retire].get('shipped'),
                    'display_name': reg[retire].get('display_name'),
                    'reason': d.get('reason', '')})
        del reg[retire]
        applied += 1
        print(f'{keep}  <-  {retire}')
        if d.get('reason'):
            print(f'    {d["reason"]}')
        for n in notes:
            print(f'    {n}')
        print()

    print(f'== {applied} merged, {refused} refused; registry now {len(reg)} waters')
    freed = sum((t.get('pack_mb') or 0) for t in tab)
    print(f'\n== deletion tab: {len(tab)} slug(s), {freed:.1f} MB of duplicate chartpacks in R2')
    for t in tab:
        print(f'   {t["slug"]:<30} -> {t["merged_into"]:<24} '
              f'{str(t["pack_mb"]):>7} MB  shipped={t["shipped"]}')
    print('   NOTHING IN R2 WAS TOUCHED. These are listed for the deletion pass, not deleted.')

    tab_path = Path(args.tab) if args.tab else root / TAB_REL
    if args.write:
        bak = reg_path.with_suffix('.json.bak')
        shutil.copy2(reg_path, bak)
        reg_path.write_text(json.dumps(reg, indent=1), encoding='utf-8')
        existing = []
        if tab_path.exists():
            existing = json.loads(tab_path.read_text(encoding='utf-8')).get('retired', [])
        seen = {e['slug'] for e in existing}
        tab_path.write_text(json.dumps(
            {'retired': existing + [t for t in tab if t['slug'] not in seen]}, indent=1),
            encoding='utf-8')
        print(f'\nwrote {reg_path}  (backup at {bak})')
        print(f'wrote {tab_path}')
    else:
        pass
    # THE OLD NAME HAS TO KEEP FINDING THE WATER, and the index is not where that survives.
    # Run over the whole tab, not just this run, so one --write repairs the earlier merges too.
    all_retired = []
    if tab_path.exists():
        try:
            all_retired = json.loads(tab_path.read_text(encoding='utf-8')).get('retired', [])
        except Exception:
            all_retired = []
    seen_slugs = {e.get('slug') for e in all_retired}
    all_retired = all_retired + [t for t in tab if t['slug'] not in seen_slugs]
    names_path = root / NAMES_REL
    added, names_note = sync_display_names(names_path, all_retired, args.write)
    if names_note:
        print(f'\n!! {names_note}')
    elif added:
        print(f'\n== retired names that would not otherwise resolve: {len(added)}')
        for keep, nm in added:
            print(f'   {nm!r} -> {keep}')
        print(f'   {"wrote" if args.write else "would write"} {names_path}')
    if not args.write:
        print(f'\nDRY RUN -- nothing written. Add --write to update {reg_path}'
              f' and {tab_path}.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
