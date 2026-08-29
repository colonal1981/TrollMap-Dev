#!/usr/bin/env python3
"""orphan_ids.py - every element the JS reaches for that the page does not have.

Personal use only, not for distribution or resale; not for navigation.

    py .\\orphan_ids.py --repo "F:\\TrollMapPipeline\\TrollMap-Dev"

WHY THIS EXISTS

On 2026-07-09 one commit re-uploaded index.html wholesale -- 346 lines out, 112 in -- and took
the Plan tab's Save button, its Saved Plans library and its JSON import with it. The handlers
behind all three are still bound in plan-builder.js, with `?.`, to elements that stopped
existing, so they attach to nothing and never complain. Ryan found it seven weeks later by
looking for a way to save a plan. He then found the battery pairing the same way, in the same
commit: ble-motor.js runs on every page load, asks for `btnEmbedPairBle`, and returns.

`?.` is the reason this is silent. It was added to stop a missing element throwing, which is
correct, and its cost is that a feature can be deleted from the page and leave a module that
still loads, still runs, and does nothing at all. Finding these one at a time, months apart,
by noticing something missing, is not a plan.

WHAT IT DOES

Reads every `getElementById('x')` and `querySelector('#x')` in the JS, and every id= in the HTML,
and prints the ids the JS wants that no page provides. A PANEL THE JS BUILDS ITSELF IS NOT AN ORPHAN, and several modules do exactly that -- they write
their own markup into a host element and then reach for the ids they just created. So the ids are
gathered from the JS too, out of `id="x"` anywhere in the file, template literals included. An id
assembled from a variable at runtime is invisible to this and is not claimed otherwise; what it
catches is the literal kind, which is the kind that goes missing when a panel is deleted from the
page.
"""
import argparse, os, re, sys, json

ID_IN_JS = re.compile(r"""getElementById\(\s*['"]([A-Za-z][\w:-]*)['"]\s*\)"""
                      r"""|querySelector(?:All)?\(\s*['"]#([A-Za-z][\w:-]*)['"]\s*\)""")
ID_IN_HTML = re.compile(r"""\bid\s*=\s*['"]([A-Za-z][\w:-]*)['"]""")


def walk(root, exts, skip=('node_modules', '.git', '_to_delete')):
    for base, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in skip]
        for f in files:
            if f.endswith(exts):
                yield os.path.join(base, f)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--repo', required=True)
    ap.add_argument('--json', default=None, help='also write the findings here')
    a = ap.parse_args()

    provided, built = set(), {}
    pages = 0
    for p in walk(a.repo, ('.html',)):
        pages += 1
        provided |= set(ID_IN_HTML.findall(open(p, encoding='utf-8', errors='replace').read()))
    # ids the JS writes into the page itself, so a module that renders its own panel and then
    # reads it back is not reported as reaching for something that does not exist.
    for p in walk(os.path.join(a.repo, 'js'), ('.js',)):
        rel = os.path.relpath(p, a.repo).replace('\\', '/')
        for k in ID_IN_HTML.findall(open(p, encoding='utf-8', errors='replace').read()):
            built.setdefault(k, rel)

    wanted = {}
    for p in walk(os.path.join(a.repo, 'js'), ('.js',)):
        rel = os.path.relpath(p, a.repo).replace('\\', '/')
        for n, line in enumerate(open(p, encoding='utf-8', errors='replace'), 1):
            for m in ID_IN_JS.finditer(line):
                wanted.setdefault(m.group(1) or m.group(2), []).append('%s:%d' % (rel, n))

    orphans = {k: v for k, v in wanted.items() if k not in provided and k not in built}
    self_built = {k: v for k, v in wanted.items() if k not in provided and k in built}
    print('%d html file(s) provide %d ids and the JS builds %d more.\n'
          'The JS asks for %d ids: %d come from a page, %d it writes itself, '
          'and %d EXIST NOWHERE.\n'
          % (pages, len(provided), len(built), len(wanted),
             len([k for k in wanted if k in provided]), len(self_built), len(orphans)))
    by_file = {}
    for k, where in orphans.items():
        by_file.setdefault(where[0].rsplit(':', 1)[0], []).append((k, where))
    for f in sorted(by_file):
        print('  %s' % f)
        for k, where in sorted(by_file[f]):
            print('      %-28s %s' % (k, ', '.join(where[:3])))
    print('\n%d id(s) are written by the JS itself and are not orphans.' % len(self_built))
    if a.json:
        json.dump({'_note': 'ids the JS reaches for that neither a page nor the JS itself '
                            'provides. Written by orphan_ids.py; nothing hand edited.',
                   'orphans': {k: v for k, v in sorted(orphans.items())},
                   'built_by_the_js_not_orphans': {k: built[k] for k in sorted(self_built)}},
                  open(a.json, 'w', encoding='utf-8'), indent=1)
        print('\n-> %s' % a.json)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
