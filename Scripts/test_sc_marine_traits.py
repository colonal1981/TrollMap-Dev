#!/usr/bin/env python3
r"""test_sc_marine_traits.py -- SCDNR's saltwater species accounts, read off the saved pages.

    py .\scripts\test_sc_marine_traits.py

No network. Runs against the real pages under SC_Marine_Species/ and SKIPS with a non-zero exit
if they are not there.

WHY THIS EXISTS. species_traits.json held 43 species and NOT ONE saltwater fish, so the five in
SC_INSHORE_ROSTER -- the whole inshore roster the app offers on nine SC coastal zones -- reached
a plan as a name with nothing behind it. Ryan: *"get all of the possible docs we can get parsed,
read and used... if they are not needed then why did we fetch them in the first place."*

EVERY ASSERTION IS MADE AGAINST THE SAVED BYTES. The last two claims in this area made from a
summarising tool's rendering were both wrong -- it reported relative hrefs as absolute, which
cost a live crawl -- so nothing here is checked against markup typed into a test.

Personal use only, not for distribution or resale; not for navigation.
"""
import glob, importlib.util, os, sys

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

_s = importlib.util.spec_from_file_location('t', os.path.join(_HERE, 'build_species_traits.py'))
T = importlib.util.module_from_spec(_s); _s.loader.exec_module(T)

folder = os.path.join(ROOT, T.SC_MARINE_DIR)
pages = [p for p in sorted(glob.glob(os.path.join(folder, '*.html')))
         if not os.path.basename(p).startswith('_page_')]
if not pages:
    print('SKIP -- no species pages under %s' % folder)
    print('   run: py .\\scripts\\fetch_agency_lake_pages.py --state SC_MARINE --root <root> --go')
    sys.exit(2)

canon = T.species_vocab(ROOT)
read = {os.path.basename(p): T.read_sc_marine_page(p) for p in pages}

print('\nread_sc_marine_page() over %d saved page(s)' % len(pages))
check('every page parsed', [f for f, e in read.items() if not e], [])
check('every page yielded sections', [f for f, e in read.items() if not e['sections']], [])
check('every page yielded a binomial', [f for f, e in read.items() if not e['scientific']], [])
# The blue crab page puts the describing authority inside the parentheses --
# "(Callinectes sapidus Rathburn)" -- and a two-word pattern left the whole string in the NAME.
check('an authority in the binomial does not leak into the name',
      read['bluecrab.html']['name'], 'Blue Crab')

print('\nthe sections kept, and the ones deliberately dropped')
red = read['reddrum.html']
check('Red Drum carries all five useful sections',
      sorted(k for k in red['sections'] if k in T.SC_MARINE_USEFUL), sorted(T.SC_MARINE_USEFUL))
# General Description is colour and fin counts -- it identifies a fish already in the boat and
# cannot help decide where to go. Literature Cited is a bibliography.
check('General Description is read but not useful',
      'General Description' in red['sections'] and 'General Description' not in T.SC_MARINE_USEFUL,
      True)
check('Literature Cited likewise',
      'Literature Cited' not in T.SC_MARINE_USEFUL, True)
# The first <strong> on the page is a link out to the limits, not a section.
check('the regulations link is not taken as a section',
      [k for k in red['sections'] if k.lower().startswith('sc species regulations')], [])
check('Habitat says where the fish holds',
      all(w in red['sections']['Habitat'].lower() for w in ('tidal creeks', 'oyster reefs')), True)
check('Foraging Habits says what it eats',
      'menhaden' in red['sections']['Foraging Habits'].lower(), True)
check('Availability says when it moves',
      'spring' in red['sections']['Availability/Vulnerability to Harvest'].lower(), True)

print('\nagainst the app\'s own vocabulary')
keyed = {}
for f, e in read.items():
    k = canon.get(T.norm_species(e['name']))
    if k:
        keyed.setdefault(k, []).append(f)
check('all five of SC_INSHORE_ROSTER resolve',
      sorted(k for k in keyed if k in ('Red Drum (Redfish)', 'Speckled Trout (Spotted Seatrout)',
                                       'Southern Flounder', 'Black Drum', 'Sheepshead')),
      ['Black Drum', 'Red Drum (Redfish)', 'Sheepshead', 'Southern Flounder',
       'Speckled Trout (Spotted Seatrout)'])
# RESEARCH_SPECIES_CANON folds southern, summer and gulf flounder into one key, because SC's
# regulations manage them as one group. SCDNR publishes them separately and they are not the same
# fish -- Paralichthys lethostigma against P. dentatus.
check('both flounder pages resolve to the one key',
      sorted(keyed.get('Southern Flounder') or []),
      ['southernflounder.html', 'summerflounder.html'])
check('and their binomials differ, so the two rows are not interchangeable',
      read['southernflounder.html']['scientific'] != read['summerflounder.html']['scientific'],
      True)

print('\nsc_marine_fold() -- Ryan: "lets just go with southern"')
pairs = sorted(read.items())
kept, said = T.sc_marine_fold(pairs, canon)
names = [f for f, _e in kept]
check('summer flounder is dropped', 'summerflounder.html' in names, False)
check('southern flounder is kept', 'southernflounder.html' in names, True)
check('it says what it did', any('summerflounder.html' in s for s in said), True)
check('and nothing else was folded', len(said), 1)
check('every other page survives', len(names), len(pairs) - 1)
# The rule is "keep the page that IS the canonical name", not a list of filenames. With no page
# carrying the canonical spelling it must keep BOTH rather than pick one, because a rule that did
# not actually decide anything must not be allowed to delete.
fake = [('a.html', {'name': 'Summer flounder', 'sections': {'x': 'y'}}),
        ('b.html', {'name': 'Gulf Flounder', 'sections': {'x': 'y'}})]
k2, s2 = T.sc_marine_fold(fake, canon)
check('with no page carrying the canonical name, both are kept', len(k2), 2)
check('and the fold is reported rather than silent', bool(s2), True)
check('shellfish carry no canonical name and are simply not written',
      [f for f in ('bluecrab.html', 'easternoyster.html', 'whiteshrimp.html')
       if canon.get(T.norm_species(read[f]['name']))], [])
print('        %d of %d pages resolve to a species the app knows' % (len(keyed), len(read)))

print('\n%s' % ('%d check(s) FAILED: %s' % (len(FAILED), ', '.join(FAILED)) if FAILED
                else 'all checks passed'))
sys.exit(1 if FAILED else 0)
