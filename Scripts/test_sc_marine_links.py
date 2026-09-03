#!/usr/bin/env python3
r"""test_sc_marine_links.py -- the index's hrefs are relative, and a summariser said otherwise.

    py .\scripts\test_sc_marine_links.py

No network. Runs against the SAVED index under SC_Marine_Species/ and SKIPS with a non-zero exit
if it is not there.

WHAT THIS GUARDS, WHICH ALREADY COST A LIVE RUN. The SC_MARINE link pattern was written absolute
-- `^https?://(?:www\.)?dnr\.sc\.gov/marine/species/...` -- because I fetched the index through a
summarising tool and asked whether its hrefs were relative or absolute. It answered "absolute",
correctly, about ITS OWN output: that tool resolves every href against the page URL before
printing it. A fact about the reader, written into a regex as a fact about the document. Ryan ran
the crawl, it matched none of the twenty species links and saved only the index.

So the assertion is made against the RAW SAVED BYTES, which is the only thing that could have
settled it, and it is made on the real file rather than on markup typed into this test.

Personal use only, not for distribution or resale; not for navigation.
"""
import importlib.util, io, os, re, sys

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

_s = importlib.util.spec_from_file_location('f', os.path.join(_HERE, 'fetch_agency_lake_pages.py'))
F = importlib.util.module_from_spec(_s); _s.loader.exec_module(F)
spec = F.STATES['SC_MARINE']

print('\nthe pattern itself')
check('SC_MARINE is a source', bool(spec), True)
# links_on() reads the pattern to decide whether absolute hrefs may be followed. A relative
# pattern keeps the crawl on one host for free, which is what the freshwater SC source relies on.
check('the link pattern is relative, not absolute',
      spec['link'].pattern.startswith(('^http', 'https?://')), False)
check('it matches a real species file name', bool(spec['link'].match('reddrum.html')), True)
check('and refuses the index itself', bool(spec['link'].match('index.html')), False)
check('and refuses another folder\'s page', bool(spec['link'].match('../lakes/murray.html')), False)

folder = os.path.join(ROOT, spec['folder'])
saved = os.path.join(folder, '_page_marine-species-index-html.html')
if not os.path.exists(saved):
    print('\nSKIP the end-to-end half -- no saved index at %s' % saved)
    print('   run: py .\\scripts\\fetch_agency_lake_pages.py --state SC_MARINE --root <root> --go')
    print('\n%s' % ('%d check(s) FAILED: %s' % (len(FAILED), ', '.join(FAILED)) if FAILED
                    else 'all checks passed'))
    sys.exit(2 if not FAILED else 1)

print('\nagainst the raw saved index')
raw = io.open(saved, encoding='utf-8', errors='replace').read()
# The claim that started it, asserted on the bytes: SCDNR writes these hrefs relative.
rel = re.findall(r'href\s*=\s*"(reddrum\.html|spottedseatrout\.html|sheepshead\.html)"', raw, re.I)
check('SCDNR writes the hrefs relative', bool(rel), True)
check('and writes no absolute form of them',
      bool(re.search(r'href\s*=\s*"https?://[^"]*marine/species/reddrum\.html"', raw, re.I)), False)

links = F.links_on(raw, spec['index'], spec)
urls = [u for u, _t in links]
check('every species page is found', len(links), 20)
check('the index is not one of them', [u for u in urls if u.endswith('/index.html')], [])
check('links_on resolved them against the index url',
      all(u.startswith('https://www.dnr.sc.gov/marine/species/') for u in urls), True)
check('the five in the app roster are all present',
      sorted(u.rsplit('/', 1)[1] for u in urls
             if u.rsplit('/', 1)[1] in ('reddrum.html', 'spottedseatrout.html',
                                        'southernflounder.html', 'blackdrum.html',
                                        'sheepshead.html')),
      ['blackdrum.html', 'reddrum.html', 'sheepshead.html', 'southernflounder.html',
       'spottedseatrout.html'])
check('no duplicates, though the index links each fish twice', len(set(urls)), len(urls))

print('\n%s' % ('%d check(s) FAILED: %s' % (len(FAILED), ', '.join(FAILED)) if FAILED
                else 'all checks passed'))
sys.exit(1 if FAILED else 0)
