#!/usr/bin/env python3
"""profile_holes.py -- what is actually empty in the research profiles.

Personal use only, not for distribution or resale; not for navigation.

For every profile in registry/_research_profiles it reports, per profile:
  facts     _extractedFactsCount, and the true length of _extractedFacts
  web       evidence entries whose sourceUrl is a real URL, vs registry: floors
  aliases   how many other names the off-lake gate has to judge documents by
  fill      non-empty leaves / total leaves, per top-level section

A leaf is empty when it is None, '', [], {} or 0-length. Sections are counted
separately because a river legitimately has no dam and no normal pool, and
lumping those in would call every river thin.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

SECTIONS = ('identity', 'limnology', 'biology', 'habitat', 'navigation',
            'regulations', 'trollingIntelligence', 'summary', 'confidence')


def leaves(node):
    """Yield every scalar leaf under node."""
    if isinstance(node, dict):
        for v in node.values():
            yield from leaves(v)
    elif isinstance(node, list):
        if not node:
            yield None
        else:
            for v in node:
                yield from leaves(v)
    else:
        yield node


def filled(node) -> tuple[int, int]:
    n = t = 0
    for leaf in leaves(node):
        t += 1
        if leaf is not None and leaf != '' and leaf != [] and leaf != {}:
            n += 1
    return n, t


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--profiles',
                    default=r'F:\TrollMapPipeline\registry\_research_profiles')
    ap.add_argument('--since', help='YYYY-MM-DD: split the table at this date')
    ap.add_argument('--report')
    ap.add_argument('--top', type=int, default=0, help='print only the N thinnest')
    args = ap.parse_args(argv)

    root = Path(args.profiles)
    rows = []
    for p in sorted(root.glob('*.json')):
        try:
            d = json.loads(p.read_text(encoding='utf-8'))
        except (OSError, ValueError) as exc:
            rows.append({'id': p.stem, 'error': str(exc)})
            continue

        ev = d.get('evidence') or {}
        web = reg = 0
        for entries in ev.values():
            for e in (entries if isinstance(entries, list) else [entries]):
                url = (e or {}).get('sourceUrl') if isinstance(e, dict) else None
                if not url:
                    continue
                if str(url).startswith(('http://', 'https://')):
                    web += 1
                else:
                    reg += 1

        row = {
            'id': p.stem,
            'bytes': p.stat().st_size,
            'mtime': datetime.fromtimestamp(p.stat().st_mtime,
                                            timezone.utc).astimezone().strftime('%Y-%m-%d'),
            'factsCount': d.get('_extractedFactsCount'),
            'factsLen': len(d.get('_extractedFacts') or []),
            'evidenceWeb': web,
            'evidenceRegistry': reg,
            'sources': len(d.get('sources') or []),
            'aliases': len(d.get('aliases') or []),
            'agents': len(((d.get('researchLog') or {}).get('completedAgents')) or []),
        }
        for s in SECTIONS:
            n, t = filled(d.get(s))
            row[s] = f'{n}/{t}'
            row[f'_{s}_n'] = n
        rows.append(row)

    ok = [r for r in rows if 'error' not in r]
    ok.sort(key=lambda r: (r['factsLen'], r['evidenceWeb'], r['bytes']))

    hdr = (f"{'profile':44s} {'date':10s} {'KB':>5s} {'facts':>6s} {'web':>4s} "
           f"{'reg':>4s} {'src':>4s} {'ali':>4s} {'limnology':>10s} {'biology':>9s} "
           f"{'habitat':>9s} {'trolling':>9s}")
    print(hdr)
    print('-' * len(hdr))
    shown = ok[:args.top] if args.top else ok
    for r in shown:
        print(f"{r['id'][:44]:44s} {r['mtime']:10s} {r['bytes']/1024:5.0f} "
              f"{r['factsLen']:6d} {r['evidenceWeb']:4d} {r['evidenceRegistry']:4d} "
              f"{r['sources']:4d} {r['aliases']:4d} {r['limnology']:>10s} "
              f"{r['biology']:>9s} {r['habitat']:>9s} {r['trollingIntelligence']:>9s}")

    n = len(ok)
    zero_facts = sum(1 for r in ok if r['factsLen'] == 0)
    zero_web = sum(1 for r in ok if r['evidenceWeb'] == 0)
    zero_alias = sum(1 for r in ok if r['aliases'] == 0)
    mismatch = sum(1 for r in ok if (r['factsCount'] or 0) != r['factsLen'])
    print()
    print(f'{n} profiles')
    print(f'  {zero_facts:3d} carry no _extractedFacts at all')
    print(f'  {zero_web:3d} cite no web URL in evidence (registry floors only)')
    print(f'  {zero_alias:3d} have no alias, so the off-lake gate has one name to judge by')
    print(f'  {mismatch:3d} disagree with their own _extractedFactsCount')
    if rows and len(rows) != n:
        print(f'  {len(rows)-n:3d} failed to parse')

    if args.report:
        Path(args.report).parent.mkdir(parents=True, exist_ok=True)
        Path(args.report).write_text(json.dumps(rows, indent=2), encoding='utf-8')
        print(f'report -> {args.report}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
