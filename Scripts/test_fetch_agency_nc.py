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

print('\n%s' % ('%d FAILED' % len(FAILED) if FAILED else 'all checks passed'))
sys.exit(1 if FAILED else 0)
