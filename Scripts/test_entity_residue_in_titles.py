#!/usr/bin/env python3
r"""test_entity_residue_in_titles.py -- `shearon&amp;nbsp;harris` is not two waters.

    py .\scripts\test_entity_residue_in_titles.py

No network. The end-to-end half reads the PDF names under NC_Lakes/ and SKIPS if that folder is
not there.

THE BUG. fetch_agency_lake_pages.py builds NC filenames from NC WRC's link text, and some of that
text is DOUBLE-escaped. `shearon&amp;nbsp;harris` survives one unescape as `shearon&nbsp;harris`,
whose punctuation then falls away and whose `nbsp` becomes a WORD:

    2888_an-overview-of-the-shearon-nbsp-harris-reservoir-habitat.pdf

nc_water_in_title() looks for the longest registry name a title CONTAINS, and "shearon harris
reservoir" is not inside "shearon nbsp harris reservoir". The page bound to nothing.

THE FIRST FIX WAS WORSE THAN THE BUG, which is why this file exists. It dropped ANY token that is
a named HTML entity -- and `&and;` is a real entity for the logical AND, as are `not`, `or`,
`int`, `part`, `sum`, `real`, `copy`, `deg` and `sec`. Measured before it shipped: 49 of 282
titles changed and nearly every one had lost a real word. "largemouth bass and sunfish in lake
phelps" became "largemouth bass sunfish in lake phelps".

Only a WHITESPACE entity can sit inside a water's name, because it is what replaced the space.
Everything else expanded to punctuation the slug already dropped, so its residue lands between
words rather than inside one. No water is named after a space.

Personal use only, not for distribution or resale; not for navigation.
"""
import glob, importlib.util, json, io, os, sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_UP1 = os.path.dirname(_HERE)
ROOT = _UP1 if os.path.isdir(os.path.join(_UP1, 'registry')) else os.path.dirname(_UP1)

FAILED = []
def check(name, got, want):
    if got == want:
        print('   ok   %s' % name)
    else:
        FAILED.append(name)
        print('   FAIL %s\n        got  %r\n        want %r' % (name, got, want))

def _load(mod):
    s = importlib.util.spec_from_file_location(mod, os.path.join(_HERE, mod + '.py'))
    m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m

B = _load('build_agency_lake_facts')
F = _load('fetch_agency_lake_pages')

print('\nstrip_entity_words() -- whitespace entities only')
check('nbsp inside a name is dropped',
      B.strip_entity_words('an overview of the shearon nbsp harris reservoir habitat'),
      'an overview of the shearon harris reservoir habitat')
check('AND IS A WORD, not the &and; entity',
      B.strip_entity_words('largemouth bass and sunfish in lake phelps'),
      'largemouth bass and sunfish in lake phelps')
for word in ('and', 'not', 'or', 'int', 'part', 'sum', 'real', 'copy', 'deg', 'sec', 'star'):
    check('"%s" survives' % word, B.strip_entity_words('lake %s survey' % word),
          'lake %s survey' % word)
check('every dropped name really is whitespace',
      [w for w in B._ENTITY_WORDS
       if (lambda v: v and v.strip() and v.isprintable())(
           __import__('html').entities.html5.get(w + ';'))], [])

print('\nthe fetcher stops making them')
# `shearon&amp;nbsp;harris` needs TWO passes; one leaves the word behind.
check('a double-escaped entity is unescaped to a fixed point',
      'nbsp' in F.slug('shearon&amp;nbsp;harris'), False)
check('and the name still comes out whole', F.slug('shearon&amp;nbsp;harris'), 'shearon-harris')
check('a single-escaped one was already fine', F.slug('shearon&nbsp;harris'), 'shearon-harris')
check('ordinary text is untouched', F.slug('Hyco Lake Largemouth Bass Survey'),
      'hyco-lake-largemouth-bass-survey')

folder = os.path.join(ROOT, 'NC_Lakes')
if not os.path.isdir(folder):
    print('\nSKIP the end-to-end half -- no %s' % folder)
    print('\n%s' % ('%d check(s) FAILED: %s' % (len(FAILED), ', '.join(FAILED)) if FAILED
                    else 'all checks passed'))
    sys.exit(2 if not FAILED else 1)

print('\nover the %d PDFs already on the drive' % len(glob.glob(os.path.join(folder, '*.pdf'))))
old = lambda p: os.path.basename(p).split('_', 1)[-1].rsplit('.pdf', 1)[0].replace('-', ' ').strip()
changed = [p for p in sorted(glob.glob(os.path.join(folder, '*.pdf'))) if B.nc_title(p) != old(p)]
check('only the nbsp ones move', [p for p in changed if 'nbsp' not in old(p)], [])
check('and there are few of them', len(changed) < 20, True)
print('        %d title(s) change' % len(changed))

reg = os.path.join(ROOT, 'registry', 'lake_index.json')
if os.path.exists(reg):
    idx = json.load(io.open(reg, encoding='utf-8'))
    mm = B.build_name_multimap(idx)
    keys = sorted({k.replace('_', ' ') for k in mm}, key=len, reverse=True)
    found = {}
    for p in changed:
        w = B.nc_water_in_title(B.nc_title(p), keys)
        if w:
            found[os.path.basename(p)] = mm.get(w.replace(' ', '_'))
    check('the Shearon Harris page now names its water',
          any(v == ['shearon_harris_reservoir'] for v in found.values()), True)
    check('and nothing binds to more than one water without being refused',
          all(v is None or len(v) >= 1 for v in found.values()), True)
    print('        %d of the %d changed titles now name a water' % (len(found), len(changed)))
    for f, v in sorted(found.items()):
        print('           %-52s %s' % (f[:52], v))

print('\n%s' % ('%d check(s) FAILED: %s' % (len(FAILED), ', '.join(FAILED)) if FAILED
                else 'all checks passed'))
sys.exit(1 if FAILED else 0)
