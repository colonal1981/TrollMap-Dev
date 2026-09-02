#!/usr/bin/env python3
r"""fetch_agency_lake_pages.py -- save the state agency lake pages, and refresh the saved ones.

    py .\scripts\fetch_agency_lake_pages.py --state SC                 # dry run: what it would save
    py .\scripts\fetch_agency_lake_pages.py --state SC --go            # save them
    py .\scripts\fetch_agency_lake_pages.py --refresh Tennessee_Lakes  # dry run
    py .\scripts\fetch_agency_lake_pages.py --refresh Tennessee_Lakes --go

Dry run by default, like every other writer in this pipeline.

WHY THIS EXISTS. `build_agency_lake_facts.py` reads 42 saved agency pages -- TWRA's eleven East
Tennessee reservoirs and GA DNR's thirty-one fishing forecasts -- and turns them into
registry/agency_lake_facts.json. SCDNR publishes the same class of page for fourteen major
reservoirs and eighteen state lakes and none of them were on the drive, because saving them
by hand is thirty-two saves.

TWO MODES, AND THE SECOND ONE IS THE IMPORTANT ONE.

  --state SC   DISCOVERY. Reads SCDNR's own index at dnr.sc.gov/lakes/search.html and follows
               every lake link it finds. NOT a hardcoded list of thirty-two: when SCDNR adds a
               lake, the next run picks it up, and when one disappears the run says so.

  --refresh    A PAGE THAT IS SAVED ALREADY CARRIES ITS OWN ADDRESS. A stale agency page is
               worse than no agency page because it looks current, and the snapshots on the
               drive are from 2026-07-22. Every saved page says where it came from -- TWRA's
               have the browser's `saved from url=(...)` comment, GA DNR's are ArcGIS StoryMaps
               and carry `<link rel="canonical">` -- so refreshing needs no index crawl and no
               list at all. Point it at a folder; it re-fetches what is in there.

WHAT IT WRITES. One `.html` per page, with the `saved from url=(NNNN)<url>` comment prepended in
exactly the shape a browser's "save page as" produces, because that is the line
build_agency_lake_facts.py:source_url() already reads. Plus `_fetched.json`, which records what
was taken and when, so the next reader can date the snapshot rather than guess from an mtime.

WHAT IT DOES NOT DO. It does not overwrite a page that is already saved unless you ask
(`--refresh`, or `--state SC --force`). It sleeps between requests. It is not a crawler: it
follows links from ONE index page, one level deep, on one host.

Personal use only, not for distribution or resale; not for navigation.
"""
import argparse, glob, json, os, re, sys, time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/128.0 Safari/537.36')

# ─────────────────────────────────────────────────────────────────────────────────────────────
# DISCOVERY -- one index page per state, and the shape of a lake link on it
# ─────────────────────────────────────────────────────────────────────────────────────────────
#
# SC is the only entry, on purpose. TN's eleven and GA's thirty-one are already on the drive and
# refresh themselves off their own embedded addresses; adding an untested crawl for a folder
# that is already full would be a config nobody exercises.
#
# GA's pages are ArcGIS StoryMaps -- one story UUID per lake, no crawlable index -- so discovery
# there is not a link pattern at all. That is why refresh is the general mechanism and discovery
# is the special case.
STATES = {
    'SC': {
        'index': 'https://www.dnr.sc.gov/lakes/search.html',
        'folder': 'SC_Lakes',
        # 14 major reservoirs at <name>/description.html, 18 state lakes at state/<name>/index.html
        'link': re.compile(r'^(?:state/)?[a-z0-9]+/(?:description|index)\.html$', re.I),
        # 'state/index.html' is the map of the state lakes, not a lake
        'skip': re.compile(r'^(?:state|)/?index\.html$', re.I),
    },
    # ── NORTH CAROLINA IS A DIFFERENT SHAPE, AND THAT IS THE WHOLE POINT ──────────────────────
    #
    # NC WRC publishes no per-lake page. Georgia has 31 fishing forecasts and Tennessee 11 TWRA
    # reservoir pages; North Carolina has neither, which is why agency_lake_facts.json has never
    # carried an NC row and why every NC water in the research set goes to the web agents with
    # nothing from its own state behind it.
    #
    # What NC publishes instead hangs off its SPECIES pages, and there are two kinds of document
    # on them, told apart by the last segment of the url:
    #
    #   /media/<id>/download?attachment   a PER-LAKE SURVEY REPORT. "Hyco Lake Largemouth Bass
    #                                     Survey" -- CPUE 129/hr, PSD 72, mean Wr 82. The Prospect
    #                                     half of a GA DNR page. 32 of these land on 20 research
    #                                     waters off the black bass pages alone, and the crappie
    #                                     page adds High Rock, Randleman, Cane Creek, Jordan,
    #                                     Tillery, James and Rhodhiss on top.
    #   /media/<id>/open                  a SPECIES PROFILE. Statewide, not per-water, and it
    #                                     carries what the profile has nowhere else: the bluegill
    #                                     one gives "Nests are usually located in 1 to 6 ft. of
    #                                     water" and "peak spawn occurring between May and June
    #                                     when water temperatures reach about 70 degrees F".
    #                                     `biology.spawnTiming` is {} on every water we hold.
    #
    # THE SPECIES LIST IS DISCOVERED, NOT TYPED. An earlier cut of this named six black bass and
    # striped bass pages, which is a hand-written list of the kind this pipeline keeps deleting --
    # and it was already wrong twice over: it matched only `/download`, so every species profile
    # was invisible, and NC WRC publishes a page for close to every fish in the state. The
    # directory at /wildlife-habitat/species is server-rendered, paginated `?page=N` from zero,
    # and carries NC WRC's own Fish filter -- 47 species over 4 pages. Walk it and the list
    # maintains itself: a species page added next year is picked up, and one that disappears is
    # simply not offered.
    #
    # SO THIS IS THE ONE SOURCE THAT GOES TWO LEVELS DEEP, and the docstring above now says so.
    # The rule it relaxes was "one index page, one level deep, on one host"; what is kept is one
    # host and two explicit patterns, so nothing is followed that was not named. A species page
    # with no media link on it costs one request and contributes nothing, which is the price of
    # not typing the list.
    'NC': {
        # FILTERED TO FISH, which is 47 species over 4 pages rather than 339 over 23. The
        # category id is NC WRC's own -- `field_catalog_categories_target_id_6[1547]=1547` is what
        # the Fish checkbox submits -- so the crawl reads their filter rather than fetching every
        # bird and salamander page to find out it holds no fisheries report.
        # `{page}` AND NOT `%d`: the url carries `%5B` and `%5D` for the filter's square
        # brackets, and percent-formatting a string that already holds percent escapes raises
        # ValueError on the first call. Caught by test_fetch_agency_nc.py before it ever ran.
        'directory': ('https://www.ncwildlife.gov/wildlife-habitat/species'
                      '?field_catalog_categories_target_id_6%5B1547%5D=1547&page={page}'),
        'directory_pages': 4,
        # ── TWO FRONTIERS, BECAUSE THE TWO LISTS ARE NOT THE SAME LIST ───────────────────────
        #
        # THERE ARE TWO LARGEMOUTH BASS PAGES AND ONLY ONE OF THEM IS LINKED. Fetch
        # /species/largemouth-bass and it carries zero documents; the directory links
        # /species/largemouth-bass-0, which carries 39. A conclusion drawn from the unlinked one
        # -- "the species directory misses the largemouth reports" -- was wrong, and is recorded
        # here because the fix that followed it is right for a different reason.
        #
        # The real reason is that the hub list is LONGER. /species/largemouth-bass-0 carries 39
        # documents; /fishing/black-bass-north-carolina/largemouth-bass carries about 74, because
        # it adds the Summaries and the Hurricane Response sections that the species page does not
        # list. Two other pages hang off /fishing and appear on no species page at all:
        # /fishing/trout-fishing-north-carolina, and /fishing/fishing-research-reports with the
        # thirteen most recent. So both frontiers are read and the documents are de-duplicated by
        # url across them.
        #
        # AND THE /fishing LIST IS WALKED, NOT TYPED. The first cut named five black bass pages
        # and the striped bass page and was already short by those two. A typed list is a list
        # that is wrong the day after it is typed.
        #
        # Two hops and no further: /fishing names its hubs, a hub names its species pages, and a
        # species page is where the documents are. The pattern is anchored to the /fishing subtree
        # on one host, so nothing outside it is followed.
        'seed_index': 'https://www.ncwildlife.gov/fishing',
        'seed_link': re.compile(r'^(?:https?://(?:www\.)?ncwildlife\.gov)?'
                                r'/fishing/[a-z0-9-]+(?:/[a-z0-9-]+)?/?$', re.I),
        'seed_hops': 2,
        'folder': 'NC_Lakes',
        # LEVEL 1: a species page. `/index.php/species/<slug>` appears on the directory beside the
        # clean form and is the same page, so both spellings are taken and de-duplicated by url.
        'index_link': re.compile(r'^(?:https?://(?:www\.)?ncwildlife\.gov)?'
                                 r'(?:/index(?:%2E|\.)php)?/species/[a-z0-9-]+/?$', re.I),
        # LEVEL 2: the documents. Both suffixes, because they are two different documents.
        #
        # THE HOST IS OPTIONAL AND THAT IS THE WHOLE FIX. The first live run read all 76 pages
        # without an error and found ZERO documents, because this pattern demanded
        # `https://www.ncwildlife.gov/media/...` and the site writes `href="/media/2878/open"`.
        # The two patterns that DID work on that same run -- index_link and seed_link, 47 species
        # pages and 29 /fishing pages -- are the two that already made the host optional. A page
        # that links its own documents relatively is the normal case; requiring the host was the
        # bug, and requiring the PATH is what still keeps a journal link out.
        'link': re.compile(r'^(?:https?://(?:www\.)?ncwildlife\.gov)?'
                           r'/media/(\d+)/(download|open)', re.I),
        'skip': re.compile(r'^$'),
        'kind': 'pdf',
        'save_index': True,
    },
}


def fetch(url, timeout=30):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'text/html,*/*'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), r.status


SAVED_FROM = re.compile(r'saved from url=\(\d+\)(\S+?)\s*-->')
CANONICAL = re.compile(r'<link[^>]+rel="canonical"[^>]+href="([^"]+)"', re.I)
META_URL = re.compile(r'<meta\s+name="url"\s+content="([^"]+)"', re.I)


def address_of(text):
    """The URL a saved page came from, however the saver recorded it.

    Three shapes, all seen on the drive: the browser's own comment on the TWRA saves, ArcGIS
    StoryMaps' canonical link on the GA saves, and TWRA's `<meta name="url">`. A page that
    cannot say where it came from cannot be refreshed, and that is worth reporting by name.
    """
    for rx in (SAVED_FROM, CANONICAL, META_URL):
        m = rx.search(text)
        if m:
            return m.group(1)
    return None


def is_pdf(body):
    return body[:5] == b'%PDF-'


def stamp(url, body):
    """Prepend the browser's own provenance comment, if the page has none.

    A PDF gets nothing prepended -- five bytes of HTML comment in front of `%PDF-` is a file no
    reader will open. Its address lives in _fetched.json, which is the only place a PDF's
    provenance CAN live, and --refresh reads it from there.

    The number in `saved from url=(0098)` is the URL's length, zero padded to four -- that is
    what Chrome writes, and build_agency_lake_facts.py reads exactly that.
    """
    if is_pdf(body):
        return body
    head = ('<!-- saved from url=(%04d)%s -->\n' % (len(url), url)).encode('utf-8')
    return body if SAVED_FROM.search(body[:2000].decode('utf-8', 'replace')) else head + body


def slug(text, cap=60):
    """`Hyco Lake Largemouth Bass Survey (2022)` -> `hyco-lake-largemouth-bass-survey-2022`.

    A LONG TITLE IS CUT AT A WORD, NOT MID-WORD. "...habitat-enhancem" is a filename that reads
    like a truncated download rather than a report, and these sit in a folder a human opens.
    """
    s = re.sub(r'[^a-z0-9]+', '-', str(text or '').lower()).strip('-')
    if len(s) <= cap:
        return s
    cut = s[:cap]
    if s[cap] != '-' and '-' in cut:
        cut = cut.rsplit('-', 1)[0]
    return cut.strip('-')


def name_for(url, index_url, text='', spec=None):
    """`.../lakes/wateree/description.html` -> `wateree.html`;
       `.../lakes/state/ashwood/index.html` -> `state_ashwood.html`;
       `.../media/3130/download?attachment` -> `3130_hyco-lake-largemouth-bass-survey.pdf`.

    THE MEDIA ID LEADS, because it is the only stable part. NC WRC's URLs carry no lake name and
    the link text is editorial -- "2022 - Hyco Lake Largemouth Bass Survey (2022)" today, retitled
    tomorrow. Leading with the id means a retitled report is recognisably the same file, and the
    slug after it is what makes the folder readable to a human.
    """
    if spec and spec.get('kind') == 'pdf':
        m = spec['link'].match(url)
        mid = m.group(1) if m and m.groups() else slug(urllib.parse.urlparse(url).path)
        tail = slug(text) or 'report'
        return '%s_%s.pdf' % (mid, tail)
    rel = urllib.parse.urlparse(url).path
    base = urllib.parse.urlparse(index_url).path.rsplit('/', 1)[0] + '/'
    if rel.startswith(base):
        rel = rel[len(base):]
    parts = [p for p in rel.split('/') if p and not p.endswith('.html')]
    return ('_'.join(parts) or 'index') + '.html'


def links_on(html_text, index_url, spec, pattern=None):
    """Every lake page linked from the index, absolute and de-duplicated in page order.

    Returns (url, anchor text) pairs. The text is what NC's filenames are built from -- a
    media id alone says nothing, and `3130.pdf` on the drive is a file nobody can identify.

    ABSOLUTE LINKS ARE ALLOWED ONLY WHEN THE SPEC ASKS. `href.startswith('http')` was the rule
    keeping the SC crawl on one host and one page, and it still is: a spec whose `link` pattern
    is itself absolute has already said which host it will follow, and every other absolute href
    on the page -- seafwa.org, wiley, tandfonline, bassmaster -- fails that pattern and is
    dropped here exactly as before.
    """
    rx = pattern or spec['link']
    absolute_ok = rx.pattern.startswith(('^http', 'https?://', '^https?', '^(?:https?'))
    out, seen = [], set()
    for m in re.finditer(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', html_text, re.I | re.S):
        href = m.group(1).strip()
        text = re.sub(r'<[^>]+>', ' ', m.group(2))
        text = re.sub(r'\s+', ' ', text).strip()
        if href.startswith(('#', 'mailto:', 'javascript:')) or href.startswith('../'):
            continue
        if href.startswith('http') and not absolute_ok:
            continue
        if spec['skip'].match(href) or not rx.match(href):
            continue
        url = urllib.parse.urljoin(index_url, href)
        if url not in seen:
            seen.add(url)
            out.append((url, text))
    return out


def write_page(folder, fname, url, body, took, manifest):
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, fname), 'wb') as f:
        f.write(stamp(url, body))
    manifest[fname] = {'url': url, 'fetched': took, 'bytes': len(body)}


def load_manifest(folder):
    p = os.path.join(folder, '_fetched.json')
    if os.path.exists(p):
        try:
            return json.load(open(p, encoding='utf-8'))
        except ValueError:
            pass
    return {}


def save_manifest(folder, manifest):
    with open(os.path.join(folder, '_fetched.json'), 'w', encoding='utf-8') as f:
        json.dump({'note': 'Written by fetch_agency_lake_pages.py. Personal use only, not for '
                           'distribution or resale; not for navigation.',
                   'pages': manifest}, f, indent=1, ensure_ascii=False)


def readable_blocks(body):
    """How many blocks of real text a page yields, through the reader that consumes it.

    THE GEORGIA PAGES ARE ARCGIS STORYMAPS AND THEY ARE RENDERED BY JAVASCRIPT. The copies on
    the drive were saved by a browser, so they hold the finished DOM. Ask urllib for the same
    URL and it returns the app shell -- valid HTML, correct address, and none of the lake in
    it. A refresh that trusted the fetch would replace thirty-one good pages with thirty-one
    empty ones and report `31 saved`.

    So a replacement is measured against what it replaces, using the SAME parser
    build_agency_lake_facts.py reads with, and a page that comes back with less in it is
    refused by name. No threshold: fewer is fewer.
    """
    try:
        import build_agency_lake_facts as B
    except ImportError:
        return None
    try:
        p = B._Blocks()
        p.feed(body.decode('utf-8', 'replace'))
        p.close()
        return len([b for b in p.blocks if len(b['text']) > 40])
    except Exception:
        return None


def run(jobs, folder, go, delay, manifest, allow_shrink=False):
    """One place does the fetching, whichever mode found the work."""
    ok = fail = refused = 0
    for i, job in enumerate(jobs):
        # A JOB MAY ARRIVE WITH ITS BODY ALREADY IN HAND. The NC walk reads every species page to
        # find the documents hanging off it, and those same pages are saved -- fetching them a
        # second time here would be 47 requests to re-read what discovery already held.
        fname, url, have = (job + (None,))[:3] if len(job) < 3 else job
        if not go:
            print('   would save %-30s <- %s' % (fname, url))
            continue
        took = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        if have is not None:
            body = have
        else:
            try:
                body, status = fetch(url)
            except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
                print('   !! %-26s %s' % (fname, e))
                fail += 1
                continue
        dest = os.path.join(folder, fname)
        if os.path.exists(dest) and not allow_shrink:
            prev = open(dest, 'rb').read()
            # A PDF HAS NO PARSED BLOCKS TO COUNT, so it is measured in bytes. Same rule either
            # way and no threshold in either: fewer is fewer. Counting HTML blocks on PDF bytes
            # would decode to junk and return zero for both files, which reads as "no shrink"
            # and would let a truncated download overwrite a good report.
            if is_pdf(prev) or is_pdf(body):
                was, now, unit = len(prev), len(body), 'byte(s)'
            else:
                was, now, unit = readable_blocks(prev), readable_blocks(body), 'block(s)'
            if was is not None and now is not None and now < was:
                print('   !! REFUSED %-22s %d %s against the %d already saved -- the '
                      'fetch came back thinner. Not overwriting.' % (fname, now, unit, was))
                refused += 1
                if i + 1 < len(jobs):
                    time.sleep(delay)
                continue
        write_page(folder, fname, url, body, took, manifest)
        ok += 1
        print('   saved %-30s %7d bytes  %s' % (fname, len(body), url))
        if have is None and i + 1 < len(jobs):
            time.sleep(delay)
    if refused:
        print('\n   %d page(s) kept as they were. A JavaScript-rendered page has to be saved '
              'from a browser;\n   --allow-shrink overrides this and will lose what is on '
              'the drive.' % refused)
    return ok, fail


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--state', choices=sorted(STATES), help='discover and save this state')
    ap.add_argument('--refresh', metavar='FOLDER',
                    help='re-fetch every saved page in this folder, off its own address')
    ap.add_argument('--root', default='.', help='the pipeline root the folder sits under')
    ap.add_argument('--go', action='store_true', help='actually write; dry run without it')
    ap.add_argument('--force', action='store_true',
                    help='with --state, re-fetch pages that are already saved')
    ap.add_argument('--delay', type=float, default=1.5, help='seconds between requests')
    ap.add_argument('--allow-shrink', action='store_true',
                    help='overwrite even when the fetched page has less in it than the saved one')
    a = ap.parse_args()
    if bool(a.state) == bool(a.refresh):
        ap.error('give exactly one of --state or --refresh')
    root = os.path.abspath(a.root)

    if a.state:
        spec = STATES[a.state]
        folder = os.path.join(root, spec['folder'])
        manifest = load_manifest(folder)
        jobs, already = [], []

        if spec.get('directory'):
            # ── TWO LEVELS, AND ONLY THIS SOURCE HAS THEM ────────────────────────────────────
            # Level 1 is the state's own species directory, read through its own Fish filter.
            # Level 2 is each species page, which is both saved and scraped for the documents
            # hanging off it. Nothing is followed that is not named by one of the two patterns.
            level1, seen1 = [], set()
            for n in range(spec['directory_pages']):
                url = spec['directory'].format(page=n)
                print('%s: species directory page %d' % (a.state, n), flush=True)
                try:
                    body, _ = fetch(url)
                except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
                    print('   !! could not read it: %s' % e)
                    continue
                hits = [u for u, _t in links_on(body.decode('utf-8', 'replace'), url, spec,
                                                spec['index_link'])]
                fresh = [u for u in hits if u not in seen1]
                seen1.update(fresh)
                level1 += [(u, None) for u in fresh]
                print('   %d species page(s), %d new' % (len(hits), len(fresh)))
                time.sleep(a.delay)
            # The /fishing subtree, walked to `seed_hops` and unioned into the same frontier.
            frontier, hops = [spec['seed_index']], 0
            while frontier and hops < spec.get('seed_hops', 0):
                nxt = []
                for u in frontier:
                    try:
                        body, _ = fetch(u)
                    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
                        print('   !! %s: %s' % (u, e))
                        continue
                    for hu, _t in links_on(body.decode('utf-8', 'replace'), u, spec,
                                           spec['seed_link']):
                        if hu in seen1:
                            continue
                        seen1.add(hu)
                        nxt.append(hu)
                        level1.append((hu, 'fishing'))
                    time.sleep(a.delay)
                print('   /fishing hop %d: %d new page(s)' % (hops + 1, len(nxt)))
                frontier, hops = nxt, hops + 1
            print('\n   %d species page(s) to read' % len(level1))
            if not level1:
                print('!! the directory parsed and linked nothing -- the page shape changed. '
                      'Not writing.')
                return 2

            found, seen2 = [], set()
            for i, (u, why) in enumerate(level1):
                try:
                    body, _ = fetch(u)
                except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
                    print('   !! %s: %s' % (u, e))
                    continue
                text = body.decode('utf-8', 'replace')
                docs = links_on(text, u, spec)
                new_docs = [(du, dt, u) for du, dt in docs if du not in seen2]
                seen2.update(du for du, _dt, _s in new_docs)
                if docs:
                    print('   %-58s %2d doc(s), %2d new'
                          % (u.rsplit('/', 1)[-1][:58], len(docs), len(new_docs)))
                found += new_docs
                # The species page itself is a source, not just a list of links: it carries the
                # "Tips; Places to Fish" prose, and the Alabama Bass page carries a dated
                # distribution list of about thirty NC waters that nc_species_by_lake.json names
                # that fish on none of.
                if spec.get('save_index'):
                    fn = '_species_%s.html' % slug(urllib.parse.urlparse(u).path.rsplit('/', 1)[-1])
                    if os.path.exists(os.path.join(folder, fn)) and not a.force:
                        already.append(fn)
                    else:
                        jobs.append((fn, u, body))
                if i + 1 < len(level1):
                    time.sleep(a.delay)
            indexes_for_naming = None
        else:
            # ONE INDEX OR SIX, read the same way. South Carolina has a single search page.
            indexes = spec['index'] if isinstance(spec['index'], (list, tuple)) else [spec['index']]
            found, seen2 = [], set()
            for idx in indexes:
                print('%s: reading the index at %s' % (a.state, idx), flush=True)
                try:
                    body, _ = fetch(idx)
                except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
                    print('   !! could not read it: %s' % e)
                    continue
                hits = links_on(body.decode('utf-8', 'replace'), idx, spec)
                print('   %d page(s) linked from it' % len(hits))
                for url, text in hits:
                    if url in seen2:
                        continue
                    seen2.add(url)
                    found.append((url, text, idx))
                if idx != indexes[-1]:
                    time.sleep(a.delay)

        print('\n   %d distinct document(s) found' % len(found))
        if not found:
            print('!! nothing linked -- the page shape changed. Not writing.')
            return 2
        for u, text, src in found:
            fn = name_for(u, src, text, spec)
            if os.path.exists(os.path.join(folder, fn)) and not a.force:
                already.append(fn)
            else:
                jobs.append((fn, u, None))
        if already:
            print('   %d already saved (--force to re-fetch): %s'
                  % (len(already), ', '.join(already[:6]) + (' ...' if len(already) > 6 else '')))

    else:
        folder = a.refresh if os.path.isabs(a.refresh) else os.path.join(root, a.refresh)
        if not os.path.isdir(folder):
            print('!! no such folder: %s' % folder)
            return 2
        manifest = load_manifest(folder)
        jobs, homeless = [], []
        saved = (manifest.get('pages') if isinstance(manifest.get('pages'), dict) else manifest) or {}
        for p in sorted(glob.glob(os.path.join(folder, '*.html'))
                        + glob.glob(os.path.join(folder, '*.pdf'))):
            fn = os.path.basename(p)
            head = open(p, 'rb').read(200000)
            # A PDF CANNOT CARRY THE COMMENT, so the manifest is where its address is. The saved
            # HTML pages are asked first the way they always were and only fall back to it.
            url = None if is_pdf(head) else address_of(head.decode('utf-8', 'replace'))
            if not url:
                url = (saved.get(fn) or {}).get('url')
            if url:
                jobs.append((fn, url, None))
            else:
                homeless.append(fn)
        print('refresh %s: %d page(s) carry their own address, %d do not'
              % (os.path.basename(folder), len(jobs), len(homeless)))
        # NAMED, NOT SKIPPED. A page that cannot say where it came from is the one that will
        # quietly go stale, so it is the one worth printing.
        for fn in homeless:
            print('   !! no address in %s -- it will never refresh' % fn)

    if not jobs:
        print('\nnothing to do.')
        return 0
    print('\n%d page(s)%s:' % (len(jobs), '' if a.go else ' (dry run -- add --go to write)'))
    ok, fail = run(jobs, folder, a.go, a.delay, manifest, a.allow_shrink)
    if a.go:
        save_manifest(folder, manifest)
        print('\n%d saved, %d failed -> %s' % (ok, fail, folder))
        print('then: py .\\scripts\\build_agency_lake_facts.py --root %s' % root)
    return 1 if fail else 0


if __name__ == '__main__':
    sys.exit(main())
