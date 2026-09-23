#!/usr/bin/env python3
r"""check_open_items.py -- the list of what is still wrong, and it clears itself.

Personal use only, not for distribution or resale; not for navigation.

    py .\scripts\check_open_items.py                 # the list, with a live verdict on each
    py .\scripts\check_open_items.py --md            # same, as markdown for a doc
    py .\scripts\check_open_items.py --prune         # drop the items that now pass

WHY THIS EXISTS

Ryan, 2026-09-23: *"what does that have to do with a to do list that isn't completed or is... so
that we know what is still not correct in the app that needs to be fixed... how do we keep up with
that?"*

`check_start_here.py` answers a different question. It is a RATCHET: it re-measures facts the
start page asserts and fails when any of them moves, so it catches a regression. It cannot hold
"this is known wrong and not fixed yet", because every item in it must be blessed to a value and a
known defect has no value to bless.

00_START_HERE.md already wrote the rule this file implements, on 2026-09-12, after two items were
put back to Ryan as open when he had already fixed them -- *"i am pretty sure i fixed this at least
twice already too"*:

    An item that CAN be measured must be measured, not asserted. Nothing re-measures a
    sentence, nothing fails when it stops being true, and the only thing that removes it is
    somebody remembering. So it survives its own fix.

SO AN OPEN ITEM HERE IS NOT A SENTENCE. IT IS A CHECK.

Each entry in `registry/_open_items.json` carries an executable test of its own defect. Run this
and every item reports OPEN or FIXED against the code as it stands right now. An item whose check
passes is FIXED whether or not anybody remembered -- `--prune` takes it off the list, and until
then it is on the list marked FIXED, which is a far safer failure than a stale OPEN.

EXIT CODE IS NOT ABOUT OPEN ITEMS. Open work is the normal state of an app and must not fail a
lint chain. It exits non-zero only when an item recorded as `fixed_on` has come BACK -- a
regression on something we already closed, which is the one thing here worth stopping a build for.

THE CHECK KINDS, deliberately few. Every defect this project has found reduces to one of these,
and a new kind is a sign the item is really several:

    unread_symbol   a field is parsed and no other file reads it. The shape 00_START_HERE names
                    as "does this file have a reader", at field level.
    unread_file     a file is on the drive and no code mentions it.
    present_text    a string that must GO: a typed constant, a gate, a dead import.
    absent_text     a string that must ARRIVE: an endpoint nothing calls yet.
    key_coverage    a per-water table that covers fewer waters than the app ships.
    artifact_missing a generated artifact that was never produced. One `path`, or -- with `dir`
                    plus `for_each` -- one per water, open while any water lacks one. A coverage
                    item is the same defect counted 56 times, not a seventh kind.
"""
import argparse, json, os, re, subprocess, sys

SKIP_DIRS = {'node_modules', '.git', '_to_delete', 'dist', 'coverage'}

# ── A TEST IS NOT A CONSUMER ───────────────────────────────────────────────────────────────────
#
# The first run of this file, 2026-09-23, reported five items FIXED that were not. `calendar-v2`
# came back "found" because the only mention on the drive was the fixture filename in the test
# written twenty minutes earlier, and three TVA/USACE fields came back with a reader that was
# their own characterisation test. A field asserted by a test and read by no code is exactly the
# defect the item describes -- the test proves it is PARSED, which was never in doubt.
#
# So `test/` is excluded from reader counting, and an item whose only readers were tests is still
# OPEN and says so. 00_START_HERE's own rule: a grep is only as wide as the tree it runs against.
# The tree for "is this used" is the code that ships.
TEST_DIRS = {'test', 'tests'}


def walk(root, exts=('.js', '.mjs', '.py'), with_tests=False):
    for base, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS
                   and (with_tests or d not in TEST_DIRS)]
        for f in files:
            if f.endswith(exts):
                yield os.path.join(base, f)


def read(p):
    try:
        with open(p, encoding='utf-8', errors='replace') as fh:
            return fh.read()
    except OSError:
        return ''


def code_lines(text):
    """Lines with the comment-only ones removed, so a mention inside a note is not a reader."""
    out = []
    for ln in text.split('\n'):
        t = ln.strip()
        if t.startswith('//') or t.startswith('*') or t.startswith('/*') or t.startswith('#'):
            continue
        out.append(ln)
    return '\n'.join(out)


def readers_of(repo, symbol, defined_in, with_tests=False):
    """Files other than `defined_in` whose CODE (not comments) mentions `symbol`. Tests excluded
    unless asked for -- see TEST_DIRS."""
    hits = []
    pat = re.compile(r'\b%s\b' % re.escape(symbol))
    for p in walk(repo, with_tests=with_tests):
        rel = os.path.relpath(p, repo).replace('\\', '/')
        if rel == defined_in:
            continue
        if pat.search(code_lines(read(p))):
            hits.append(rel)
    return hits


def select_waters(root, spec):
    """The waters a coverage item is measured over, read from a GENERATED registry file.

    NEVER A LIST WRITTEN INTO THE ITEM. `file` + `at` walk to the rows, `where` filters on their
    own fields, and `name` is the field the app would ASK with. That last one matters: a stored
    artifact's id is derived from the name the caller passes, not from the slug it is filed under,
    so a check that asks with the slug measures a question the app never poses.
    """
    with open(os.path.join(root, spec['file']), encoding='utf-8') as fh:
        node = json.load(fh)
    for step in (spec.get('at') or '').split('.'):
        if step:
            node = node[step]
    keys = list(node) if isinstance(node, dict) else [None] * len(node)
    rows = list(node.values()) if isinstance(node, dict) else list(node)
    out = []
    for key, row in zip(keys, rows):
        row = row if isinstance(row, dict) else {}
        if any(row.get(f) != v for f, v in (spec.get('where') or {}).items()):
            continue
        out.append(str(row.get(spec['name']) if spec.get('name') else key or ''))
    return out


def coverage_keys(repo, resolver, names):
    """Every id an artifact for each name could be stored under, ASKED OF THE APP.

    `resolver` is "path/to/module.js#exportName". The rule for turning a water's name into a
    storage key is 200 lines of accumulated corrections in Worker/research/keys.js -- county
    parentheticals, canonical ids, legacy spellings -- every one of them added because a lookup
    missed a profile that existed. Restating any of that here would mean this check and the app
    disagree about what "has one" means, and the check would be the one nobody trusts. So it
    imports the function. One node call for the whole item.
    """
    mod, fn = resolver.split('#')
    src = (
        "const {pathToFileURL} = await import('node:url');\n"
        "const m = await import(pathToFileURL(process.argv[1]).href);\n"
        "const out = {};\n"
        "for (const n of JSON.parse(process.argv[2])) out[n] = [].concat(m[%s](n));\n"
        "process.stdout.write(JSON.stringify(out));\n" % json.dumps(fn)
    )
    r = subprocess.run(['node', '--input-type=module', '-e', src,
                        os.path.abspath(os.path.join(repo, mod)), json.dumps(names)],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or 'node failed').strip().split('\n')[-1])
    return json.loads(r.stdout)


def run_item(it, root, repo):
    k = it['kind']
    if k == 'unread_symbol':
        r = readers_of(repo, it['symbol'], it['defined_in'])
        if r:
            return False, f"{len(r)} reader(s): {', '.join(r[:3])}"
        t = readers_of(repo, it['symbol'], it['defined_in'], with_tests=True)
        return True, ('asserted by a test and read by no code: ' + ', '.join(t[:2])
                      if t else 'no reader outside its own definition')
    if k == 'unread_file':
        needle = it.get('needle') or os.path.basename(it['path'])
        r = [os.path.relpath(p, repo).replace('\\', '/') for p in walk(repo)
             if needle in code_lines(read(p))]
        exists = os.path.exists(os.path.join(root, it['path']))
        if not exists:
            return False, 'the file is not on the drive'
        return (not r), (f"{len(r)} mention(s): {', '.join(r[:3])}" if r else 'on the drive, mentioned by nothing')
    if k == 'present_text':
        p = os.path.join(repo, it['file'])
        found = it['text'] in code_lines(read(p))
        return found, ('still present' if found else 'gone')
    if k == 'absent_text':
        # code_lines, or the check finds the note explaining itself -- which is exactly what the
        # first run of this file did with `calendar-v2` and its own comment.
        files = [os.path.join(repo, f) for f in it['files']] if it.get('files') else list(walk(repo))
        found = any(it['text'] in code_lines(read(p)) for p in files)
        return (not found), ('found' if found else 'nothing references it')
    if k == 'key_coverage':
        src = read(os.path.join(repo, it['file']))
        m = re.search(r'%s\s*=\s*\{' % re.escape(it['table']), src)
        if not m:
            return False, 'table not found — renamed or gone'
        d, start = 0, src.index('{', m.start())
        for i in range(start, len(src)):
            if src[i] == '{': d += 1
            elif src[i] == '}':
                d -= 1
                if d == 0: break
        keys = re.findall(r'^\s{2}"?([A-Za-z_][\w .\'/-]*)"?\s*:', src[start:i], re.M)
        total = len([x for x in read(os.path.join(root, it['against'])).split('\n') if x.strip()])
        return (len(keys) < total), f'{len(keys)} of {total}'
    if k == 'artifact_missing':
        if not it.get('for_each'):
            p = os.path.join(root, it['path'])
            return (not os.path.exists(p)), ('absent' if not os.path.exists(p) else 'present')
        suffix = it.get('suffix', '.json')
        names = select_waters(root, it['for_each'])
        have = {f[:-len(suffix)] for f in os.listdir(os.path.join(root, it['dir']))
                if f.endswith(suffix)}
        cand = (coverage_keys(repo, it['resolver'], names) if it.get('resolver')
                else {n: [n] for n in names})
        covered = [n for n in names if any(c in have for c in (cand.get(n) or []))]
        return (len(covered) < len(names)), f'{len(covered)} of {len(names)}'
    raise SystemExit(f"unknown kind {k!r} on {it['id']}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default='.')
    ap.add_argument('--repo', default='TrollMap-Dev')
    ap.add_argument('--items', default=None)
    ap.add_argument('--md', action='store_true')
    ap.add_argument('--prune', action='store_true')
    a = ap.parse_args()
    root, repo = a.root, os.path.join(a.root, a.repo)
    items_fp = a.items or os.path.join(root, 'registry', '_open_items.json')
    doc = json.load(open(items_fp, encoding='utf-8'))
    items = doc['items']

    open_, fixed, regressed = [], [], []
    for it in items:
        try:
            is_open, why = run_item(it, root, repo)
        except Exception as e:
            is_open, why = True, f'CHECK FAILED: {type(e).__name__}: {e}'
        it['_open'], it['_why'] = is_open, why
        if is_open and it.get('fixed_on'):
            regressed.append(it)
        elif is_open:
            open_.append(it)
        else:
            fixed.append(it)

    if a.md:
        print(f"# What is still wrong — {len(open_)} open, {len(fixed)} fixed\n")
        print("Generated by `check_open_items.py`. Every row is a check, not a sentence.\n")
        for grp, rows in (('OPEN', open_), ('FIXED — prune these', fixed), ('REGRESSED', regressed)):
            if not rows:
                continue
            print(f"## {grp}\n")
            for it in rows:
                print(f"**{it['id']}** — {it['title']}  \n`{it['kind']}` · {it['_why']}  \n{it['why_it_matters']}\n")
    else:
        w = max((len(i['id']) for i in items), default= 10)
        for grp, rows in (('REGRESSED', regressed), ('OPEN', open_), ('FIXED', fixed)):
            for it in rows:
                print(f"{grp:9s} {it['id']:{w}s}  {it['_why']}")
        print(f"\n{len(open_)} open · {len(fixed)} fixed and prunable · {len(regressed)} REGRESSED")
        if fixed and not a.prune:
            print('Run --prune to take the fixed ones off the list.')

    if a.prune:
        keep = [{k: v for k, v in it.items() if not k.startswith('_')}
                for it in items if it['_open'] or it.get('fixed_on')]
        for it in keep:
            pass
        doc['items'] = keep
        json.dump(doc, open(items_fp, 'w', encoding='utf-8'), indent=2)
        print(f'pruned {len(items) - len(keep)} item(s) -> {items_fp}')

    return 1 if regressed else 0


if __name__ == '__main__':
    sys.exit(main())
