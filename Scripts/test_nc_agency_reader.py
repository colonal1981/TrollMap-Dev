#!/usr/bin/env python3
r"""test_nc_agency_reader.py -- the NC pdf reader in build_agency_lake_facts.py.

    py .\scripts\test_nc_agency_reader.py

Reads the real saved documents under NC_Lakes\ and SKIPS if they are not on the drive, because
they are 375 MB of state pdfs and do not belong in the repo. Run
`fetch_agency_lake_pages.py --state NC --go` first.

Each check below is a bug that was in the reader and is named by what it did wrong.

Personal use only, not for distribution or resale; not for navigation.
"""
import os, sys
_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(_HERE)
sys.path.insert(0, _HERE)
import build_agency_lake_facts as B

NC = os.path.join(ROOT, 'NC_Lakes')
if not os.path.isdir(NC) or not os.listdir(NC):
    print('SKIP -- no NC_Lakes on the drive. Run fetch_agency_lake_pages.py --state NC --go')
    sys.exit(0)

FAILED = []
def check(name, got, want):
    if got == want:
        print('   ok   %s' % name)
    else:
        FAILED.append(name)
        print('   FAIL %s\n        got  %r\n        want %r' % (name, got, want))

idx = B.REG.load_index(os.path.join(ROOT, 'registry'))
multimap = B.build_name_multimap(idx)
spec = {'state': 'NC', 'agency': 'NCWRC', 'dir': 'NC_Lakes', 'reader': 'nc', 'glob': '*.pdf',
        '_name_keys': sorted({k.replace('_', ' ') for k in multimap}, key=len, reverse=True),
        '_species': B.nc_species_vocab(ROOT)}

def read(fn):
    p = os.path.join(NC, fn)
    if not os.path.exists(p):
        return None, None
    slug, _why, page, _ = B.read_one(p, spec, idx, multimap)
    return slug, page

check('the species vocabulary is read out of facts-util.js, not retyped here',
      len(spec['_species']) > 30, True)

# 1. THE COLUMNS. Straight extract_text() splices the margin caption into the body mid-word:
#    "...slower growing (stunt-" / "Davidson counties in the Piedmont region".
slug, page = read('2884_high-rock-lake-black-crappie-population-assessment-2019.pdf')
if page:
    body = ' '.join(page['overview'])
    check('High Rock resolves off its own title', slug, 'high_rock_lake')
    check('the roster sentence survives de-columning',
          'Largemouth Bass, Striped Bass, White Bass, Black Crappie' in body, True)
    check('the opening sentence is not spliced with the margin caption',
          'the Yadkin River is located in Rowan and Davidson counties' in body, True)
    check('and no word is welded to the caption', 'stuntDavidson' in body, False)
    check('the agency acreage is taken',
          (page.get('measures') or {}).get('surface_acres', {}).get('value'), 15180)

# 2. THE TITLE TAIL. Stripping at the first report word left "an" as the species, because
#    *Overview* is a report word and it comes before the fish.
slug, page = read('2918_an-overview-of-the-falls-lake-largemouth-bass-fishery.pdf')
if page:
    check('"An Overview of the Falls Lake Largemouth Bass Fishery" is about a fish, not "an"',
          [s['name'] for s in page['species']], ['Largemouth Bass'])
    check('and it still resolves to the water', slug, 'falls_lake')

# 3. A TITLE NAMING NO KNOWN FISH YIELDS NO FISH. It used to yield "angler use patterns on".
slug, page = read('2883_angler-use-patterns-on-randleman-lake.pdf')
if page:
    check('a title with no species in it produces none', page['species'], [])
    check('the water is still resolved from it', slug, 'randleman_lake')

# 4. THE WATER COMES OUT OF A SENTENCE, and the strict resolver still does the resolving.
check('a water is found inside prose', B.nc_water_in_title(
      'angler use patterns on randleman lake', spec['_name_keys']), 'randleman lake')
check('the longest name wins over its own substring', B.nc_water_in_title(
      'high rock lake black crappie population assessment', spec['_name_keys']), 'high rock lake')

print('\n%s' % ('%d FAILED' % len(FAILED) if FAILED else 'all checks passed'))
sys.exit(1 if FAILED else 0)
