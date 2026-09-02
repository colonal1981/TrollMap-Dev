#!/usr/bin/env python3
r"""test_fetch_agency_nc.py -- the NC branch of fetch_agency_lake_pages.py.

    py .\scripts\test_fetch_agency_nc.py

WHAT THIS CAN AND CANNOT TEST. The network hop is not testable from here -- ncwildlife.gov is
unreachable from the sandbox this was written in -- so the anchors below are built from the REAL
urls and the REAL link text off the largemouth bass page, not invented ones. What is proven is
that the pattern picks NC WRC's own reports out of a list that also holds journal links, that a
report is named after itself rather than after a bare media id, and that South Carolina's crawl
is unchanged. What is NOT proven is that the live page's markup matches this shape -- which is
what the dry run is for: `--state NC` without `--go` prints what it would save and costs nothing
if the pattern is wrong.

Personal use only, not for distribution or resale; not for navigation.
"""
import os, sys
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import urllib.parse
import fetch_agency_lake_pages as F

FAILED = []
def check(name, got, want):
    if got == want:
        print('   ok   %s' % name)
    else:
        FAILED.append(name)
        print('   FAIL %s\n        got  %r\n        want %r' % (name, got, want))

# Real rows off the largemouth bass page, plus the external journal links that sit in the same
# lists. Those four are the reason the pattern is anchored to ncwildlife.gov/media.
NC_PAGE = '''
<h3>Reports</h3>
<p>2022 - <a href="https://www.ncwildlife.gov/media/2981/download?attachment">Lake Hickory Black Bass Surveys</a> (2008-2018)</p>
<p>2022 - <a href="https://www.ncwildlife.gov/media/3130/download?attachment">Hyco Lake Largemouth Bass Survey</a> (2022)</p>
<p>2022 - <a href="https://www.ncwildlife.gov/media/2978/download?attachment">Mountain Island Lake Black Bass Survey</a> (2022)</p>
<p>2011 - <a href="https://www.ncwildlife.gov/media/3123/download?attachment">Moss Lake Black Bass Survey</a> (2008-2010)</p>
<p>2020 - <a href="https://www.ncwildlife.gov/media/2888/download?attachment">An Overview of the Shearon Harris Reservoir Habitat Enhancement Project-UPDATE</a></p>
<h3>Publications</h3>
<p>2016 - <a href="https://seafwa.org/journal/2016/changes-black-bass-population-characteristics-after-introduction-alabama-bass-lake">Changes in Black Bass Population Characteristics after the Introduction of Alabama Bass in Lake Norman</a> (external website)</p>
<p>2022 - <a href="https://afspubs.onlinelibrary.wiley.com/doi/abs/10.1002/nafm.10763">Largemouth Bass Hatchery Contributions</a> (external website)</p>
<p>2015 - <a href="https://www.tandfonline.com/doi/abs/10.1080/00028487.2015.1024801">Responses of Coastal Largemouth Bass to Episodic Hypoxia</a></p>
<h3>Related Links</h3>
<p><a href="http://www.ncpaws.org/ncwrcmaps/fishingareas">Where to Fish</a></p>
<p><a href="https://www.eregulations.com/northcarolina/fishing">Warmwater Game Fish Regulations</a></p>
'''
IDX = 'https://www.ncwildlife.gov/fishing/black-bass-north-carolina/largemouth-bass'
spec = F.STATES['NC']
hits = F.links_on(NC_PAGE, IDX, spec)

check('only NC WRC media links are followed', len(hits), 5)
check('no journal or map link survives',
      [u for u, _ in hits if 'ncwildlife.gov/media' not in u], [])
check('a report is named after itself, led by the media id',
      F.name_for(hits[1][0], IDX, hits[1][1], spec),
      '3130_hyco-lake-largemouth-bass-survey.pdf')
check('a long title is trimmed, not truncated mid-word into a dangling dash',
      F.name_for(hits[4][0], IDX, hits[4][1], spec),
      '2888_an-overview-of-the-shearon-harris-reservoir-habitat.pdf')
check('the index page is named off its own path',
      '_index_%s.html' % F.slug('/fishing/black-bass-north-carolina/largemouth-bass'),
      '_index_fishing-black-bass-north-carolina-largemouth-bass.html')

# A PDF must not be stamped, and must not be measured as HTML.
pdf = b'%PDF-1.7\n... report bytes ...'
check('a PDF is written unchanged', F.stamp('https://x/1', pdf), pdf)
check('a PDF is recognised', F.is_pdf(pdf), True)
check('an HTML page still gets its provenance comment',
      F.stamp('https://x/1', b'<html>hi</html>').startswith(b'<!-- saved from url='), True)

# South Carolina is unchanged: relative links only, absolute ones refused.
SC_PAGE = '''<a href="wateree/description.html">Wateree</a>
<a href="state/ashwood/index.html">Ashwood</a>
<a href="index.html">map</a>
<a href="https://www.ncwildlife.gov/media/3130/download">not ours</a>'''
sc = F.STATES['SC']
sc_hits = F.links_on(SC_PAGE, sc['index'], sc)
check('SC still takes only its own relative lake pages', [u for u, _ in sc_hits],
      ['https://www.dnr.sc.gov/lakes/wateree/description.html',
       'https://www.dnr.sc.gov/lakes/state/ashwood/index.html'])
check('SC names are unchanged',
      [F.name_for(u, sc['index'], t, sc) for u, t in sc_hits],
      ['wateree.html', 'state_ashwood.html'])

# ── The two document shapes, and the species directory ────────────────────────────────────────
# Real rows off the black crappie page. /open is a species profile, /download?attachment is a
# per-lake survey report, and an earlier cut of the pattern matched only the second -- which made
# every species profile in the state invisible.
CRAPPIE_PAGE = '''
<a href="https://www.ncwildlife.gov/media/2878/open">Black Crappie Species Profile</a>
<a href="https://www.ncwildlife.gov/media/2884/download?attachment">High Rock Lake Black Crappie Population Assessment - 2019</a>
<a href="https://www.ncwildlife.gov/media/2890/download?attachment">Assessment of the Crappie Population in Lake Rhodhiss</a>
<a href="https://www.ncwildlife.gov/media/2883/download?attachment">Angler Use Patterns on Randleman Lake</a>
'''
c = F.links_on(CRAPPIE_PAGE, 'https://www.ncwildlife.gov/species/black-crappie', spec)
check('both /open and /download are taken', len(c), 4)
check('a species profile is named off its own title',
      F.name_for(c[0][0], '', c[0][1], spec), '2878_black-crappie-species-profile.pdf')
check('a per-lake report beside it keeps its own id',
      F.name_for(c[1][0], '', c[1][1], spec),
      '2884_high-rock-lake-black-crappie-population-assessment-2019.pdf')

# The species directory, filtered to fish. Both link spellings appear on it and are the same page.
DIRECTORY = '''
<a href="https://www.ncwildlife.gov/species/black-crappie">Black Crappie</a>
<a href="https://www.ncwildlife.gov/species/bodie-bass-hybrid-striped-bass">Bodie Bass (Hybrid Striped Bass)</a>
<a href="https://www.ncwildlife.gov/index%2ephp/species/carolina-redhorse">Carolina Redhorse</a>
<a href="https://www.ncwildlife.gov/wildlife-habitat/species?page=1">next</a>
<a href="https://www.ncwildlife.gov/fishing/where-fish">Where to Fish</a>
<a href="https://www.ncwildlife.gov/media/3595/open">a document, not a species page</a>
'''
d = F.links_on(DIRECTORY, spec['directory'].format(page=0), spec, spec['index_link'])
check('the directory yields species pages only', [u for u, _ in d],
      ['https://www.ncwildlife.gov/species/black-crappie',
       'https://www.ncwildlife.gov/species/bodie-bass-hybrid-striped-bass',
       'https://www.ncwildlife.gov/index%2ephp/species/carolina-redhorse'])
check('the pagination link is not mistaken for a species',
      any('?page=' in u for u, _ in d), False)
check('a document link is not mistaken for a species page',
      any('/media/' in u for u, _ in d), False)

# ── The /fishing subtree, which is where the black bass reports actually live ─────────────────
# /species/largemouth-bass exists and carries ZERO document links; every largemouth report hangs
# off /fishing/black-bass-north-carolina/largemouth-bass. Real hrefs off the /fishing page.
FISHING = '''
<a href="/fishing/regulations">Regulations</a>
<a href="/fishing/where-fish">Where to Fish</a>
<a href="/fishing/black-bass-north-carolina">Black Bass in North Carolina</a>
<a href="/fishing/striped-bass-fishing-information">Striped Bass Fishing Information</a>
<a href="/fishing/trout-fishing-north-carolina">Trout Fishing in North Carolina</a>
<a href="/fishing/fishing-research-reports">Fishing Research Reports</a>
<a href="/species/bluegill">Bluegill</a>
<a href="https://www.ncwildlife.gov/media/3595/open">a document</a>
<a href="https://www.eregulations.com/northcarolina/fishing">off site</a>
'''
f = F.links_on(FISHING, 'https://www.ncwildlife.gov/fishing', spec, spec['seed_link'])
paths = [urllib.parse.urlparse(u).path for u, _ in f]
check('the /fishing walk finds the species hubs',
      set(['/fishing/black-bass-north-carolina', '/fishing/striped-bass-fishing-information',
           '/fishing/trout-fishing-north-carolina', '/fishing/fishing-research-reports'])
      <= set(paths), True)
check('it stays inside /fishing', [p for p in paths if not p.startswith('/fishing/')], [])
check('an offsite link is not followed', any('eregulations' in u for u, _ in f), False)

# Hop two: the hub names its own species pages, which is where the documents are.
HUB = '''
<a href="/fishing/black-bass-north-carolina/largemouth-bass">Largemouth Bass</a>
<a href="/fishing/black-bass-north-carolina/alabama-bass">Alabama Bass</a>
<a href="/fishing">back to Fishing</a>
'''
h = F.links_on(HUB, 'https://www.ncwildlife.gov/fishing/black-bass-north-carolina', spec,
               spec['seed_link'])
check('hop two reaches the page the largemouth reports are on',
      'https://www.ncwildlife.gov/fishing/black-bass-north-carolina/largemouth-bass'
      in [u for u, _ in h], True)
check('three segments deep is not followed',
      F.links_on('<a href="/fishing/a/b/c">too deep</a>', 'https://www.ncwildlife.gov/fishing',
                 spec, spec['seed_link']), [])

# ── The slugs the directory actually uses ─────────────────────────────────────────────────────
# Every href below is verbatim off the fish-filtered directory. Two of them are the reason this
# check exists: the linked largemouth page is `largemouth-bass-0`, not `largemouth-bass`, and the
# `/index%2Ephp/` prefix appears in BOTH cases on the same listing.
REAL_SLUGS = '''
<a href="/species/largemouth-bass-0">Largemouth Bass</a>
<a href="/index%2ephp/species/common-carp">Common Carp</a>
<a href="/index%2Ephp/species/green-sunfish">Green Sunfish</a>
<a href="/species/flathead-catfish">Flathead Catfish</a>
<a href="/species/muskellunge">Muskellunge</a>
'''
r = F.links_on(REAL_SLUGS, spec['directory'].format(page=1), spec, spec['index_link'])
check('a slug ending in a digit is taken -- the linked largemouth page is largemouth-bass-0',
      any(u.endswith('/species/largemouth-bass-0') for u, _ in r), True)
check('both spellings of the index.php prefix are taken', len(r), 5)

# ── THE SHAPE THE SITE ACTUALLY WRITES ────────────────────────────────────────────────────────
# The first live run read 76 pages without one error and found zero documents. Every fixture
# above used absolute hrefs, because that is how WebFetch reports a link after resolving it --
# ncwildlife.gov writes them RELATIVE. That is the case this file did not have and the run did.
RELATIVE = '''
<a href="/media/2878/open">Black Crappie Species Profile</a>
<a href="/media/2884/download?attachment">High Rock Lake Black Crappie Population Assessment - 2019</a>
<a href="/media/3130/download?attachment">Hyco Lake Largemouth Bass Survey</a>
<a href="/fishing/regulations">Regulations</a>
<a href="http://www.ncpaws.org/ncwrcmaps/fishingareas">Where to Fish</a>
<a href="https://seafwa.org/journal/2016/changes-black-bass">a journal article</a>
'''
rel = F.links_on(RELATIVE, 'https://www.ncwildlife.gov/species/black-crappie', spec)
check('a relative /media href is taken -- the bug the first live run found', len(rel), 3)
check('it is resolved against the page it was found on',
      rel[0][0], 'https://www.ncwildlife.gov/media/2878/open')
check('the id still comes off a resolved absolute url',
      F.name_for(rel[2][0], '', rel[2][1], spec), '3130_hyco-lake-largemouth-bass-survey.pdf')
check('a relative non-media link is still refused',
      any('/fishing/' in u for u, _ in rel), False)
check('an offsite document link is still refused',
      any('seafwa' in u or 'ncpaws' in u for u, _ in rel), False)

# ── One document, two addresses ───────────────────────────────────────────────────────────────
# Real pairs off the first live run. /open and /download?attachment serve the same object, and
# de-duplicating by url took both -- ten documents fetched twice, eight of them writing the same
# filename so the second overwrote the first.
check('the media id is what identifies a document',
      F.doc_key('https://www.ncwildlife.gov/media/3590/open', spec),
      F.doc_key('https://www.ncwildlife.gov/media/3590/download?attachment', spec))
check('two different documents are still two',
      F.doc_key('https://www.ncwildlife.gov/media/3590/open', spec)
      != F.doc_key('https://www.ncwildlife.gov/media/3595/open', spec), True)

# The page-name collision: two real pages, two document lists, one filename.
check('a species page and a fishing hub page do not collide',
      F.slug('species/smallmouth-bass'.strip('/'), cap=90)
      != F.slug('fishing/black-bass-north-carolina/smallmouth-bass'.strip('/'), cap=90), True)
check('a page is named by its whole path',
      '_page_%s.html' % F.slug('fishing/black-bass-north-carolina/smallmouth-bass', cap=90),
      '_page_fishing-black-bass-north-carolina-smallmouth-bass.html')

# ── HTML entities in the link text ────────────────────────────────────────────────────────────
# Nine files off the first live run carried `&nbsp;` through as the word "nbsp", which breaks the
# only job the filename has: naming the water so it can be read back out.
check('a non-breaking space does not become the word nbsp',
      F.slug('Hyco Lake&nbsp;Largemouth Bass Assessment'),
      'hyco-lake-largemouth-bass-assessment')
check('and the water survives in the name',
      'hyco lake' in F.slug('Hyco Lake&nbsp;Largemouth Bass Assessment').replace('-', ' '), True)
check('an ampersand entity does not become the word amp',
      F.slug('Economic Impacts &amp; Contributions'), 'economic-impacts-contributions')

print('\n%s' % ('%d FAILED' % len(FAILED) if FAILED else 'all checks passed'))
sys.exit(1 if FAILED else 0)
