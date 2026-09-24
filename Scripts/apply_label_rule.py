#!/usr/bin/env python3
r"""apply_label_rule.py -- carry consolidate_lake_index.py's label onto the live lake_index.json.

Personal use only, not for distribution or resale; not for navigation.

    py .\scripts\consolidate_lake_index.py --registry F:\TrollMapPipeline\registry `
       --charted F:\TrollMapPipeline\registry\charted.json --out F:\TrollMapPipeline\_scratch\li.json
    py .\scripts\apply_label_rule.py --index F:\TrollMapPipeline\registry\lake_index.json `
       --built F:\TrollMapPipeline\_scratch\li.json            # dry run: prints what would change
    py .\scripts\apply_label_rule.py ... --write

WHY NOT JUST RUN CONSOLIDATE INTO lake_index.json. The live index is consolidate's output PLUS
the steps after it. Measured 2026-09-24: a bare consolidate run differs from the live index in 14
rows' `usgs` (the pool-gauge choices of A_GAUGE_READS_ITS_OWN_WATER) and puts back
lake_edwin_johnson, which merge_duplicate_waters.py folded away. Writing it over the live file
would have undone both to change six labels.

So this copies from a fresh consolidate run exactly the two fields label_suffix() decides --
`display_name` and `legacy_display_names` -- and only on rows where the label is what changed:
the new label is the old one with a different state after the county, and the old label is kept
in `legacy_display_names`. Any other difference is printed and left alone. The previous file is
moved to _to_delete, never deleted.
"""
import argparse
import json
import os
import re
import shutil
import sys
from datetime import date

LABEL = re.compile(r'^(?P<name>.+) \((?P<county>[^()]+) Co, (?P<st>[A-Z/]+)\)$')


def relabels(index, built):
    """(slug, old label, new label, new legacy list) for each row whose county label changed state."""
    out, other = [], []
    for slug, row in index.items():
        b = built.get(slug)
        if not b or b.get('display_name') == row.get('display_name'):
            continue
        a, n = LABEL.match(row.get('display_name') or ''), LABEL.match(b.get('display_name') or '')
        if (a and n and a['name'] == n['name'] and a['county'] == n['county'] and a['st'] != n['st']
                and row['display_name'] in (b.get('legacy_display_names') or [])):
            out.append((slug, row['display_name'], b['display_name'], b['legacy_display_names']))
        else:
            other.append((slug, row.get('display_name'), b.get('display_name')))
    return out, other


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--index', required=True, help='the live registry/lake_index.json')
    ap.add_argument('--built', required=True, help='a fresh consolidate_lake_index.py --out')
    ap.add_argument('--write', action='store_true')
    a = ap.parse_args()
    index = json.load(open(a.index, encoding='utf-8'))
    built = json.load(open(a.built, encoding='utf-8'))
    changes, other = relabels(index, built)
    for slug, old, new, _ in changes:
        print(f'  {slug:26} {old}  ->  {new}')
    for slug, old, new in other:
        print(f'  LEFT ALONE {slug}: {old!r} vs {new!r} -- not a county-state relabel')
    print(f'{len(changes)} label(s) to change')
    if not a.write or not changes:
        if changes:
            print('dry run -- pass --write to apply')
        return 0
    for slug, _, new, legacy in changes:
        index[slug]['display_name'] = new
        index[slug]['legacy_display_names'] = legacy
    root = os.path.dirname(os.path.dirname(os.path.abspath(a.index)))
    keep = os.path.join(root, '_to_delete', f'lake_index_before_relabel_{date.today():%Y-%m-%d}.json')
    os.makedirs(os.path.dirname(keep), exist_ok=True)
    shutil.copy2(a.index, keep)
    with open(a.index, 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(index, fh, indent=1, ensure_ascii=False)
    print(f'wrote {a.index}; the previous copy is {keep}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
