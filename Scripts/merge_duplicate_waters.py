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

    for k, v in retiree.items():
        if k in GEOMETRY_FIELDS:
            continue                                   # the keeper's polygon is the one we keep
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
        b = bindings.get(keep) or bindings.get(retire)
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
        print(f'\nDRY RUN -- nothing written. Add --write to update {reg_path}'
              f' and {tab_path}.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
