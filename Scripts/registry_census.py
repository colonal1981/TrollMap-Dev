#!/usr/bin/env python3
"""registry_census.py -- what in the registry is provably redundant, and what only looks it.

Personal use only, not for distribution or resale; not for navigation.

Three questions, kept apart because they carry different amounts of proof:

  DUPLICATE   two files with the same SHA-256. One of them is redundant, provably.
  GENERATION  <base>.bak, <base>.bak7, <base>.bak_2026-08-22 -- older snapshots of a
              file that still exists. Everything but the newest snapshot is redundant.
  UNREFERENCED  no source file anywhere in --code mentions the filename. This is NOT
              proof: a script that builds its path with an f-string never names the
              file. Reported, never moved.

--apply moves the first two classes into <registry>/_to_delete/<stamp>/. It never
moves an UNREFERENCED file and it never deletes anything.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

CODE_SUFFIXES = {'.py', '.js', '.mjs', '.cjs', '.ts', '.json', '.md', '.txt',
                 '.html', '.toml', '.yml', '.yaml', '.ps1', '.bat', '.sh'}

# <base>.bak | .bak2 | .bak_2026-08-22 | .bak10 ...
BAK_RE = re.compile(r'^(?P<base>.+?)\.bak(?P<gen>[0-9]*|_[0-9]{4}-[0-9]{2}-[0-9]{2}.*)$', re.I)

# a code site that builds a registry path instead of naming one
DYNAMIC_RE = re.compile(
    r'(registry|REG(?:ISTRY)?_DIR|reg_dir)\s*/\s*(f["\']|["\']?\s*\+|%|\.format|\$\{)'
    r'|os\.path\.join\(\s*[^)]*registry[^)]*,\s*(f["\']|[A-Za-z_])',
    re.I)


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open('rb') as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def canonical_rank(name: str, blob: str = '') -> tuple:
    """Lower sorts first = more likely to be the live file.

    A name the code actually reads beats every other signal, because keeping the
    unnamed twin of an identical pair breaks the caller. Below that, a name that
    says it is a copy loses to one that does not."""
    low = name.lower()
    return (
        0 if name in blob else 1,
        1 if BAK_RE.match(name) else 0,
        1 if '_new' in low or '.new' in low else 0,
        1 if '.before' in low or '_before' in low else 0,
        1 if '_old' in low or '.old' in low or '_orig' in low else 0,
        1 if any(t in low for t in ('_copy', '_review', '_tmp', '_temp')) else 0,
        len(name),
        name,
    )


def scan_files(root: Path, recurse: bool) -> list[Path]:
    skip = {'_to_delete'}
    out = []
    if recurse:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in skip]
            for fn in filenames:
                out.append(Path(dirpath) / fn)
    else:
        out = [p for p in root.iterdir() if p.is_file()]
    return sorted(out)


def build_reference_index(code_dirs: list[Path]) -> tuple[set, int, list]:
    """Return (every token that looks like a filename in the code, files read, dynamic sites)."""
    seen_text = []
    dynamic = []
    n = 0
    for cd in code_dirs:
        if not cd.exists():
            continue
        for dirpath, dirnames, filenames in os.walk(cd):
            dirnames[:] = [d for d in dirnames
                           if d not in {'.git', 'node_modules', '__pycache__', '_to_delete'}]
            for fn in filenames:
                p = Path(dirpath) / fn
                if p.suffix.lower() not in CODE_SUFFIXES:
                    continue
                try:
                    if p.stat().st_size > 8 << 20:
                        continue
                    text = p.read_text(encoding='utf-8', errors='ignore')
                except OSError:
                    continue
                n += 1
                seen_text.append(text)
                if DYNAMIC_RE.search(text):
                    dynamic.append(str(p))
    return seen_text, n, dynamic


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', default=r'F:\TrollMapPipeline\registry')
    ap.add_argument('--code', action='append', default=[])
    ap.add_argument('--recurse', action='store_true')
    ap.add_argument('--report')
    ap.add_argument('--apply', action='store_true',
                    help='move DUPLICATE and GENERATION files to <registry>/_to_delete/<stamp>/')
    args = ap.parse_args(argv)

    root = Path(args.registry)
    if not root.is_dir():
        print(f'!! not a directory: {root}', file=sys.stderr)
        return 2

    code_dirs = [Path(c) for c in args.code] or [root.parent / 'TrollMap-Dev']

    files = scan_files(root, args.recurse)
    by_name = {p.name: p for p in files}
    total = sum(p.stat().st_size for p in files)
    print(f'{len(files)} files, {total/1048576:.1f} MB in {root}')

    # Read the code first: which name is live decides which twin of an identical
    # pair is kept, so this cannot wait until after the duplicate pass.
    texts, n_code, dynamic = build_reference_index(code_dirs)
    blob = '\n'.join(texts)

    # ---- GENERATION -------------------------------------------------------
    gens: dict[str, list[Path]] = {}
    for p in files:
        m = BAK_RE.match(p.name)
        if m:
            gens.setdefault(m.group('base'), []).append(p)

    generation_moves = []
    generation_kept = []
    for base, snaps in sorted(gens.items()):
        snaps.sort(key=lambda p: p.stat().st_mtime)
        keep = snaps[-1]
        generation_kept.append(str(keep))
        for p in snaps[:-1]:
            generation_moves.append({'path': str(p), 'bytes': p.stat().st_size,
                                     'base': base, 'newest_kept': keep.name,
                                     'base_present': base in by_name})

    # ---- DUPLICATE --------------------------------------------------------
    by_size: dict[int, list[Path]] = {}
    for p in files:
        by_size.setdefault(p.stat().st_size, []).append(p)

    duplicate_moves = []
    duplicate_groups = []
    for size, group in by_size.items():
        if len(group) < 2 or size == 0:
            continue
        by_hash: dict[str, list[Path]] = {}
        for p in group:
            by_hash.setdefault(sha256(p), []).append(p)
        for digest, same in by_hash.items():
            if len(same) < 2:
                continue
            same.sort(key=lambda p: canonical_rank(p.name, blob))
            keep, rest = same[0], same[1:]
            duplicate_groups.append({'sha256': digest[:16], 'bytes': size,
                                     'keep': keep.name,
                                     'redundant': [p.name for p in rest]})
            already = {m['path'] for m in generation_moves}
            for p in rest:
                if str(p) not in already:
                    duplicate_moves.append({'path': str(p), 'bytes': size,
                                            'identical_to': keep.name})

    # ---- UNREFERENCED -----------------------------------------------------
    moving = {m['path'] for m in generation_moves} | {m['path'] for m in duplicate_moves}
    unreferenced = []
    for p in files:
        if str(p) in moving or BAK_RE.match(p.name):
            continue
        if p.name not in blob and p.stem not in blob:
            unreferenced.append({'path': str(p), 'bytes': p.stat().st_size})
    unreferenced.sort(key=lambda d: -d['bytes'])

    g_b = sum(m['bytes'] for m in generation_moves)
    d_b = sum(m['bytes'] for m in duplicate_moves)
    u_b = sum(m['bytes'] for m in unreferenced)
    print(f'  GENERATION    {len(generation_moves):4d} files  {g_b/1048576:8.1f} MB'
          f'   ({len(gens)} bases, newest of each kept)')
    print(f'  DUPLICATE     {len(duplicate_moves):4d} files  {d_b/1048576:8.1f} MB'
          f'   ({len(duplicate_groups)} identical groups)')
    print(f'  UNREFERENCED  {len(unreferenced):4d} files  {u_b/1048576:8.1f} MB'
          f'   (not proof -- never moved)')
    print(f'  read {n_code} source files; {len(dynamic)} of them build a registry path'
          f' dynamically, so UNREFERENCED under-counts what is live')

    report = {
        'generated': datetime.now().isoformat(timespec='seconds'),
        'registry': str(root), 'code_dirs': [str(c) for c in code_dirs],
        'files': len(files), 'bytes': total,
        'generation': generation_moves, 'generation_kept': generation_kept,
        'duplicate': duplicate_moves, 'duplicate_groups': duplicate_groups,
        'unreferenced': unreferenced,
        'dynamic_path_sites': dynamic,
        'applied': False,
    }

    if args.apply and (generation_moves or duplicate_moves):
        stamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        dest = root / '_to_delete' / stamp
        dest.mkdir(parents=True, exist_ok=True)
        moved = 0
        for m in generation_moves + duplicate_moves:
            src = Path(m['path'])
            tgt = dest / src.name
            i = 1
            while tgt.exists():
                tgt = dest / f'{src.stem}__{i}{src.suffix}'
                i += 1
            shutil.move(str(src), str(tgt))
            m['moved_to'] = str(tgt)
            moved += 1
        report['applied'] = True
        report['moved_to'] = str(dest)
        print(f'moved {moved} file(s) -> {dest}')

    if args.report:
        Path(args.report).parent.mkdir(parents=True, exist_ok=True)
        Path(args.report).write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(f'report -> {args.report}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
