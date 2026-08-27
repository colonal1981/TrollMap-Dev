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


def stamp(url, body):
    """Prepend the browser's own provenance comment, if the page has none.

    The number in `saved from url=(0098)` is the URL's length, zero padded to four -- that is
    what Chrome writes, and build_agency_lake_facts.py reads exactly that.
    """
    head = ('<!-- saved from url=(%04d)%s -->\n' % (len(url), url)).encode('utf-8')
    return body if SAVED_FROM.search(body[:2000].decode('utf-8', 'replace')) else head + body


def name_for(url, index_url):
    """`.../lakes/wateree/description.html` -> `wateree.html`;
       `.../lakes/state/ashwood/index.html` -> `state_ashwood.html`."""
    rel = urllib.parse.urlparse(url).path
    base = urllib.parse.urlparse(index_url).path.rsplit('/', 1)[0] + '/'
    if rel.startswith(base):
        rel = rel[len(base):]
    parts = [p for p in rel.split('/') if p and not p.endswith('.html')]
    return ('_'.join(parts) or 'index') + '.html'


def links_on(html_text, index_url, spec):
    """Every lake page linked from the index, absolute and de-duplicated in page order."""
    out, seen = [], set()
    for m in re.finditer(r'<a[^>]+href="([^"]+)"', html_text, re.I):
        href = m.group(1).strip()
        if href.startswith(('http', '#', 'mailto:', 'javascript:')) or href.startswith('../'):
            continue
        if spec['skip'].match(href) or not spec['link'].match(href):
            continue
        url = urllib.parse.urljoin(index_url, href)
        if url not in seen:
            seen.add(url)
            out.append(url)
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
    for i, (fname, url) in enumerate(jobs):
        if not go:
            print('   would save %-26s <- %s' % (fname, url))
            continue
        took = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        try:
            body, status = fetch(url)
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
            print('   !! %-26s %s' % (fname, e))
            fail += 1
            continue
        dest = os.path.join(folder, fname)
        if os.path.exists(dest) and not allow_shrink:
            was = readable_blocks(open(dest, 'rb').read())
            now = readable_blocks(body)
            if was is not None and now is not None and now < was:
                print('   !! REFUSED %-22s %d block(s) against the %d already saved -- the '
                      'fetch came back thinner. Not overwriting.' % (fname, now, was))
                refused += 1
                if i + 1 < len(jobs):
                    time.sleep(delay)
                continue
        write_page(folder, fname, url, body, took, manifest)
        ok += 1
        print('   saved %-26s %7d bytes  %s' % (fname, len(body), url))
        if i + 1 < len(jobs):
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
        print('%s: reading the index at %s' % (a.state, spec['index']), flush=True)
        try:
            body, _ = fetch(spec['index'])
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
            print('!! could not read the index: %s' % e)
            return 2
        urls = links_on(body.decode('utf-8', 'replace'), spec['index'], spec)
        print('   %d lake page(s) linked from it' % len(urls))
        if not urls:
            print('!! the index parsed and linked nothing -- the page shape changed. Not writing.')
            return 2
        manifest = load_manifest(folder)
        jobs, already = [], []
        for u in urls:
            fn = name_for(u, spec['index'])
            if os.path.exists(os.path.join(folder, fn)) and not a.force:
                already.append(fn)
            else:
                jobs.append((fn, u))
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
        for p in sorted(glob.glob(os.path.join(folder, '*.html'))):
            fn = os.path.basename(p)
            head = open(p, 'rb').read(200000).decode('utf-8', 'replace')
            url = address_of(head)
            if url:
                jobs.append((fn, url))
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
