#!/usr/bin/env python3
"""
audit_drive_sources.py -- what is on the drive, and what the pipeline actually reads.

Personal use only, not for distribution or resale; not for navigation.

Ryan, 2026-09-03: "obviously the discovery pipeline didn't work all that well because me at my
browser has found way more information than anything else... i want to get everything onto my
drive then have you build that doc finder for my drive to make sure we are actually using
everything we can".

Three sources were found by hand in one sitting that had been sitting on the drive unread:
G-WRAPVectorData2021 (566 MB, since 2026-08-03), NOAA_ENC (52 MB, since 2026-07-25), and
ArtReef2021.csv. Nothing counted them, so nothing missed them. This counts them.

WHAT IT DOES
  1. Walks the drive and collects every candidate SOURCE file -- the raw data we downloaded.
     Generated trees (chartpack, registry, outputs, habitat_output) are skipped: those are the
     pipeline's own output, not an input, and listing them would bury the answer.
  2. Reads every .py under the script dirs and every .js under the app dirs as one corpus.
     The corpus is WALKED, never typed, so a new script joins it by existing.
  3. A source is REFERENCED if its file name, its stem, or the name of a directory on its path
     appears anywhere in that corpus. Referenced does not prove it is used well -- only that
     some line of ours names it. Unreferenced proves nothing reads it.

WHY A TYPED EXTENSION LIST IS NOT THE WHOLE GATE
  DATA_EXT below is the one hand-written list in this file, and a hand-written list is exactly
  how something gets missed. So anything with an extension NOT on the list is still reported,
  under `unknown_ext`, when it is bigger than --unknown-min-mb. A new format we have never seen
  shows up as a question rather than as silence.

USAGE
    py audit_drive_sources.py                       # report to stdout
    py audit_drive_sources.py --json audit.json     # and write the machine-readable form
    py audit_drive_sources.py --all                 # include the generated trees too
    py audit_drive_sources.py --root D:\Somewhere   # audit a different drive
"""

import argparse
import io
import json
import os
import re
import sys
import tokenize
from fnmatch import fnmatch
from pathlib import Path

# A filename-shaped run of characters. Keeps dots so `oyster_beds.geojson` survives whole, which
# is what makes the match exact rather than a substring guess.
TOKEN_RE = re.compile(r'[a-z0-9_\-.]{4,}')

# A GLOB, because half our inputs are never named. build_water_chain.py reaches the NHD
# geodatabases as `nhd_dir.glob('**/NHDPLUS_H_*_HU4*_GDB.gdb')` and the Georgia access points as
# `WRD_Water_Access_Points*.geojson` -- 8.6 GB that the first version of this file called unread
# because no literal filename ever appears. A wrong "unread" is not as bad as a wrong "read", but
# it buries the real answer under noise, which ends the same way: nobody looks.
# Must START with a name character. Without that anchor the scan matched every bare `*` and `*/`
# in every JS block comment -- millions of one-character hits over a 68 MB corpus, which turned
# the run into a timeout. Every pattern we actually use (`NHDPLUS_H_*...`, `_page_species-*`,
# `coast_*`) begins with a name character; one that begins with a wildcard would have too little
# literal left to pass specific_enough() anyway.
GLOB_RE = re.compile(r'[a-z0-9_][a-z0-9_\-.*?/\\]*[*?][a-z0-9_\-.*?/\\]*')

# ...but only a SPECIFIC glob. `*.geojson` appears in our code too, and honouring it would mark
# every geojson on the drive as read -- the false "read" this whole file exists to prevent. A
# pattern counts only when what is left after removing the wildcards and the extension is a real
# name, not a scrap.
GLOB_MIN_LITERAL = 6

DEFAULT_ROOT = r'F:\TrollMapPipeline'

# Directories that hold what the pipeline PRODUCES, not what it consumes. Skipped from the
# candidate list (still reported as skipped) because a chartpack tree is ~26,000 files and would
# drown the answer. --all overrides.
GENERATED_DIRS = {'chartpack', 'registry', 'outputs', 'habitat_output'}

# Never worth walking.
NOISE_DIRS = {'.git', 'node_modules', '__pycache__', '_to_delete', '.wrangler', '.venv', 'venv'}

# Raw-data extensions. THE ONE TYPED LIST IN THIS FILE -- see the module docstring for why it is
# not the whole gate.
DATA_EXT = {
    '.geojson', '.json', '.csv', '.tsv', '.gpkg', '.shp', '.dbf', '.gdb', '.gml', '.kml', '.kmz',
    '.zip', '.7z', '.gz', '.tar', '.pdf', '.xml', '.gpx', '.rsd', '.usr', '.tif', '.tiff', '.img',
    '.bag', '.nc', '.hdf', '.las', '.laz', '.xlsx', '.xls', '.txt', '.dat', '.000', '.webp',
}

# An ESRI file geodatabase is a DIRECTORY that is really one dataset. Treat it as a single item
# and do not descend into its hundreds of a0000000x.gdbtable files.
DIR_DATASETS = ('.gdb',)

# Where our own code lives. Walked, not enumerated -- adding a script adds it to the corpus.
CODE_DIRS = ('Scripts', 'scripts', 'js', 'Worker', 'test', 'tests')
CODE_EXT = {'.py', '.js', '.mjs', '.json', '.html', '.ps1'}

# A basename this short or this common would match half the corpus by accident, so it is matched
# on the fuller path instead. Derived-by-rule rather than a blocklist of specific names.
WEAK_STEM_LEN = 5

# WHAT WE DOWNLOADED, NOT WHAT WE MADE.
#
# Ryan, 2026-09-03: "i am not looking for data of mine... i am looking for things that are
# downloaded... just because it has my name on it doesn't mean i made it... it was made by you".
#
# The first version treated every unread file the same, so a leftover export of ours sat at the
# top of the list next to a state agency download and read as equally interesting. It is not:
# one is debris, the other is a source nothing is using.
#
# Content markers were the obvious idea and they FAIL -- checked against the drive, our own
# `garmin_lakes.json`, `osm_ramps_sc.geojson` and the catch-photo CSVs carry no `generatedBy`
# and no project note, so a marker test would have called our own output "downloaded".
#
# Windows already knows. A file saved by a browser gets a Zone.Identifier alternate data stream
# (Mark of the Web), and it usually carries the URL it came from. That is a fact recorded at
# download time by the operating system, not a guess of ours -- and the HostUrl means an unread
# file can be reported together with where it was got.
ZONE_INTERNET = {'3', '4'}          # 3 = Internet, 4 = Untrusted. 1 = local, 2 = intranet.

# This tool's own report is not a source. Listing it made the finder's first act be to report
# itself, 33 MB of it, at the top of the list.
SELF_OUTPUT = {'drive_audit.json'}


def human(n):
    for unit in ('B', 'KB', 'MB', 'GB', 'TB'):
        if n < 1024 or unit == 'TB':
            return f'{n:,.0f} {unit}' if unit == 'B' else f'{n:,.1f} {unit}'
        n /= 1024.0


# ── THIS FILE IS NOT EVIDENCE ABOUT THE DRIVE ────────────────────────────────────────────────
#
# Ryan, 2026-09-04: "i was under the impression that we never wired in the georgia
# G-WRAPVectorData2021 either... i dont see that mentioned."
#
# He was right, and the reason is this script. The header above names G-WRAPVectorData2021 and
# ArtReef2021.csv as the three sources found by hand that nothing was reading -- and the corpus
# walks every .py under scripts/, INCLUDING THIS ONE, so those names appeared in our code and
# the audit reported both as READ.
#
#     G-WRAPData2021.gdb            592.1 MB   referenced_by: g-wrapdata2021.gdb
#     georgia_oyster_reef_2015.gpkg  38.5 MB   referenced_by: georgia_oyster_reef_2015.gpkg
#     ArtReef2021.csv                          referenced_by: artreef2021.csv
#
# Checked 2026-09-04: the ONLY files in the whole corpus naming any of those three are this
# script and its test. **The tool was hiding the exact files it was written to find**, and it
# hid them by describing them. A finder that cites its own findings stops finding them.
#
# Two rules, because the three leaks arrive by two different doors:
#
#   1. A COMMENT OR A DOCSTRING IS NOT A READ. `build_species_habitat_weights.py` names
#      usSEABED in its docstring and `seagrass` in a habitat regex and opens neither file --
#      728 MB and 1.28 GB reported as read on the strength of prose. Python comments and
#      docstrings come out of the corpus; ORDINARY STRING LITERALS STAY, because
#      `SC_OYSTER_FILE = DATA_DIR / 'SCDNROyster2015Live.geojson'` is a real read and looks
#      exactly like the thing being stripped.
#   2. THIS SCRIPT AND ITS TEST ARE NOT PART OF THE CORPUS. The test builds fixture files named
#      `georgia_oyster_reef_2015.gpkg` and `ArtReef2021.csv` -- string literals, not comments,
#      so rule 1 cannot reach them.
#
# Neither rule is a list of names. Add a source to the header tomorrow and it stays findable.

def strip_py_commentary(text):
    """Python source minus comments and docstrings, with every other literal left alone.

    A docstring is a STRING that OPENS a statement, which is exactly what tokenize's preceding
    NEWLINE/INDENT/DEDENT/ENCODING tells us. Stripping strings generally would delete the
    filename literals that are the whole point of the corpus.
    """
    try:
        toks = list(tokenize.generate_tokens(io.StringIO(text).readline))
    except (tokenize.TokenError, IndentationError, SyntaxError, ValueError):
        return text                       # unparseable: keep it whole rather than lose a reader
    out = []
    opens_statement = True
    for tok in toks:
        if tok.type == tokenize.COMMENT:
            continue
        if tok.type == tokenize.STRING and opens_statement:
            continue                      # a docstring
        if tok.type in (tokenize.NEWLINE, tokenize.NL, tokenize.INDENT,
                        tokenize.DEDENT, tokenize.ENCODING):
            opens_statement = True
        elif tok.type != tokenize.COMMENT:
            opens_statement = False
        out.append(tok.string)
    return '\n'.join(out)


def build_corpus(root):
    """
    Every filename-shaped token in our own code, as a set. Walked, never typed.

    A SET, not one big string. The corpus is ~68 MB across 1,400 files, and substring-searching
    that once per candidate turned a report into a timeout. Tokenising once is faster and also
    STRICTER: `oyster` no longer matches `oyster_beds.geojson` by accident, which is the kind of
    false hit that would have reported an unread file as read.

    See the note above build_corpus for what is deliberately NOT in here and why.
    """
    parts = []
    files = 0
    seen = set()
    # BY BASENAME, not by absolute path. A copy of this script somewhere else is still this
    # script saying its own header out loud, and the path it sits at does not change that.
    mine = {Path(__file__).name.lower(), ('test_' + Path(__file__).name).lower()}
    for base in CODE_DIRS:
        for start in (root / base, root / 'TrollMap-Dev' / base):
            if not start.is_dir():
                continue
            for dirpath, dirnames, filenames in os.walk(start):
                dirnames[:] = [d for d in dirnames if d not in NOISE_DIRS]
                for fn in filenames:
                    if Path(fn).suffix.lower() not in CODE_EXT:
                        continue
                    if fn.lower() in mine:
                        continue
                    p = Path(dirpath) / fn
                    rp = str(p.resolve())
                    if rp in seen:
                        continue
                    seen.add(rp)
                    try:
                        body = p.read_text(encoding='utf-8', errors='ignore')
                        parts.append(strip_py_commentary(body)
                                     if p.suffix.lower() == '.py' else body)
                        files += 1
                    except OSError:
                        pass
    text = '\n'.join(parts).lower()
    tokens = set(TOKEN_RE.findall(text))
    globs = {g for g in GLOB_RE.findall(text) if specific_enough(g)}
    return (tokens, globs), files


def specific_enough(pattern):
    """
    Is this glob a name, or is it `*.geojson`?

    Judged on the basename only, with the wildcards and the extension removed. What survives has
    to be at least GLOB_MIN_LITERAL characters of actual name.
    """
    base = re.split(r'[\\/]', pattern)[-1]
    stem = base.rsplit('.', 1)[0] if '.' in base else base
    literal = re.sub(r'[*?]', '', stem)
    return len(literal) >= GLOB_MIN_LITERAL


def download_mark(path):
    """
    Where a file was downloaded from, per the OS. None when there is no mark.

    Returns (zone_id, host_url_or_None). Silent on every platform but Windows, and silent on
    Windows too for anything that never had a stream -- absence is not evidence either way, so
    the report says "no download mark", never "we made this".
    """
    try:
        with open(str(path) + ':Zone.Identifier', 'r', encoding='utf-8', errors='ignore') as f:
            txt = f.read(2048)
    except OSError:
        return None
    zone = re.search(r'ZoneId\s*=\s*(\d)', txt)
    if not zone or zone.group(1) not in ZONE_INTERNET:
        return None
    host = re.search(r'(?:HostUrl|ReferrerUrl)\s*=\s*(\S+)', txt)
    return (zone.group(1), host.group(1) if host else None)


def is_dir_dataset(name):
    return name.lower().endswith(DIR_DATASETS)


def collect(root, include_generated, exclude=(), progress=False):
    """Candidate source files, plus the trees we deliberately did not walk."""
    items, skipped = [], []
    excluded = {e.strip('/\\').lower() for e in exclude}
    seen_dirs = 0
    for dirpath, dirnames, filenames in os.walk(root):
        rel = Path(dirpath).relative_to(root)
        top = rel.parts[0] if rel.parts else ''

        # PRUNE AND RECORD IN ONE PLACE. This was two guards -- a `continue` when the walk entered
        # a generated tree, and a prune of those same names at the root. The prune ran first, so
        # the walk never entered, so the `continue` never fired, so the report never said a word
        # about what it had dropped. A guard that can never fire is worse than no guard, and this
        # one cost the single line telling you what was left out.
        dirnames[:] = [d for d in dirnames if d not in NOISE_DIRS]
        if not rel.parts:
            drop = set()
            for d in dirnames:
                if d.lower() in excluded:
                    skipped.append(d + '  (--exclude)')
                    drop.add(d)
                elif not include_generated and d in GENERATED_DIRS:
                    skipped.append(d + '  (pipeline output)')
                    drop.add(d)
            dirnames[:] = [d for d in dirnames if d not in drop]

        seen_dirs += 1
        if progress and seen_dirs % 2000 == 0:
            print(f'  ... {seen_dirs:,} folders, {len(items):,} files', file=sys.stderr)

        # A .gdb IS the dataset. Record it whole and do not descend.
        if is_dir_dataset(Path(dirpath).name):
            size = 0
            for dp, _, fns in os.walk(dirpath):
                for fn in fns:
                    try:
                        size += (Path(dp) / fn).stat().st_size
                    except OSError:
                        pass
            items.append({'path': str(rel), 'name': Path(dirpath).name, 'bytes': size,
                          'mtime': Path(dirpath).stat().st_mtime, 'kind': 'geodatabase'})
            dirnames[:] = []
            continue

        for fn in filenames:
            p = Path(dirpath) / fn
            ext = p.suffix.lower()
            try:
                st = p.stat()
            except OSError:
                continue
            if fn.startswith('_commit_msg') or fn in SELF_OUTPUT:
                continue                      # our own scratch, and this tool's own report
            known = ext in DATA_EXT
            items.append({'path': str(rel / fn) if rel.parts else fn, 'name': fn,
                          'bytes': st.st_size, 'mtime': st.st_mtime,
                          'kind': 'data' if known else 'unknown_ext', 'ext': ext,
                          'downloaded': False, 'from': None})
    return items, sorted(set(skipped))


def referenced(item, corpus):
    """Does any line of our code name this thing? Returns what matched, or None."""
    tokens, globs = corpus
    name = item['name'].lower()
    if name in tokens:
        return name
    stem = Path(item['name']).stem.lower()
    if len(stem) > WEAK_STEM_LEN and stem in tokens:
        return stem
    # Named by pattern rather than by name -- the NHD geodatabases and the WRD access points.
    for g in globs:
        if fnmatch(name, re.split(r'[\\/]', g)[-1]):
            return g
    # A file can be reached by its folder: SC_ESI_ZIP is built as DATA_DIR / 'oyster_marsh' / ...,
    # so the zip's own name may never appear while the folder's does.
    for seg in Path(item['path']).parts[:-1]:
        s = seg.lower()
        if len(s) > WEAK_STEM_LEN and s in tokens:
            return s + '/'
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--root', default=DEFAULT_ROOT)
    ap.add_argument('--json', help='also write the machine-readable report here')
    ap.add_argument('--all', action='store_true',
                    help='include the generated trees (chartpack, registry, outputs, ...)')
    ap.add_argument('--unknown-min-mb', type=float, default=1.0,
                    help='report unrecognised extensions above this size (default 1 MB)')
    ap.add_argument('--min-mb', type=float, default=0.0,
                    help='only report sources at least this big')
    ap.add_argument('--exclude', action='append', default=[], metavar='DIR',
                    help='skip this top-level folder; repeatable. For tile dumps and firmware '
                         'trees that are tens of thousands of files and no dataset.')
    ap.add_argument('--quiet', action='store_true', help='no progress lines on stderr')
    args = ap.parse_args()

    root = Path(args.root)
    if not root.is_dir():
        print(f'ERROR: {root} is not a directory', file=sys.stderr)
        return 2

    tokens, code_files = build_corpus(root)
    if not code_files:
        print(f'ERROR: found no code under {root} to compare against -- wrong --root?',
              file=sys.stderr)
        return 2
    items, skipped = collect(root, args.all, args.exclude, progress=not args.quiet)

    for it in items:
        it['referenced_by'] = referenced(it, tokens)

    # THE MARK IS CHECKED LAST, AND ONLY ON WHAT WILL BE REPORTED.
    # Opening a Zone.Identifier stream is a syscall per file, and doing it during the walk cost
    # one on every one of ~8,600 candidates -- most of them files already known to be read, whose
    # provenance nobody was ever going to be shown. Ryan noticed the run got slower the same day
    # it was added. Deferring it to the unreferenced set is the same answer for a seventh of the
    # work, and it stays correct because a referenced file's origin is never printed.
    for it in items:
        if it['referenced_by']:
            continue
        mark = download_mark(root / it['path'])
        if mark:
            it['downloaded'], it['from'] = True, mark[1]

    floor = args.min_mb * 1024 * 1024
    unk_floor = args.unknown_min_mb * 1024 * 1024
    data = [i for i in items if i['kind'] in ('data', 'geodatabase') and i['bytes'] >= floor]
    unknown = [i for i in items
               if i['kind'] == 'unknown_ext' and i['bytes'] >= unk_floor
               and not i['referenced_by']]
    unused = sorted((i for i in data if not i['referenced_by']),
                    key=lambda i: -i['bytes'])
    used = [i for i in data if i['referenced_by']]

    print(f'DRIVE SOURCE AUDIT  {root}')
    print(f'  code corpus      {code_files:,} files under {", ".join(CODE_DIRS)}'
          f'  ({len(tokens[0]):,} names, {len(tokens[1]):,} usable globs)')
    print(f'  source files     {len(data):,}  ({human(sum(i["bytes"] for i in data))})')
    print(f'  referenced       {len(used):,}  ({human(sum(i["bytes"] for i in used))})')
    print(f'  NOT referenced   {len(unused):,}  ({human(sum(i["bytes"] for i in unused))})')
    if skipped:
        print(f'  skipped (output) {", ".join(skipped)}   -- pass --all to include')
    print()

    import datetime
    got = [i for i in unused if i.get('downloaded')]
    rest = [i for i in unused if not i.get('downloaded')]
    marked = sum(1 for i in data if i.get('downloaded'))

    if got:
        print('DOWNLOADED AND UNREAD  -- the OS says these came from the internet and nothing '
              'in Scripts/ or js/ names them:')
        for i in got:
            d = datetime.date.fromtimestamp(i['mtime']).isoformat()
            print(f"  {human(i['bytes']):>10}  {d:10}  {i['path']}")
            if i.get('from'):
                print(f"  {'':>10}  {'':10}    from {i['from'][:110]}")
        print()

    if rest:
        # NOT "ours". No mark means the OS never recorded one -- true of anything we generated,
        # anything copied from another drive, and anything downloaded before Windows started
        # stamping it. Reported second and labelled honestly rather than filtered away.
        head = 'NO DOWNLOAD MARK, AND UNREAD' if marked else \
               'UNREAD  (no Zone.Identifier data on this drive -- see the note below)'
        print(f'{head}:')
        for i in rest:
            d = datetime.date.fromtimestamp(i['mtime']).isoformat()
            print(f"  {human(i['bytes']):>10}  {d:10}  {i['path']}")
        print()

    if not marked:
        print('NOTE: not one file carried a download mark. Either this drive was written by '
              'something that does not set Mark of the Web, or this is not Windows. The split '
              'above is therefore not meaningful on this run.')
        print()

    if unknown:
        print(f'EXTENSIONS NOT ON THE DATA LIST, over {args.unknown_min_mb} MB '
              f'(a format we have not seen before shows up here, not nowhere):')
        for i in sorted(unknown, key=lambda i: -i['bytes']):
            print(f"  {human(i['bytes']):>10}  {i['ext'] or '(none)':10}  {i['path']}")
        print()

    if args.json:
        Path(args.json).write_text(json.dumps({
            'note': 'Personal use only, not for distribution or resale; not for navigation.',
            'generatedBy': 'audit_drive_sources.py',
            'root': str(root),
            'codeFiles': code_files,
            'skippedGeneratedTrees': skipped,
            'items': items,
        }, indent=2), encoding='utf-8')
        print(f'wrote {args.json}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
