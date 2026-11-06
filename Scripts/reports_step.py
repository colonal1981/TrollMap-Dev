#!/usr/bin/env python3
"""reports_step.py -- one water's fishing reports for the research run: fetch what is new, read it, check it, keep it.

Personal use only, not for distribution or resale; not for navigation.

The research run's reports step (`research_lakes.py --reports-only`, or this file on its own). No model is called and no
Gemini or Claude allowance is spent. Ryan, 2026-11-05: "small sample size build the parsers then wire what is needed
into research and see how that goes", and "when we run research we are going to have to stick to SC waters".
See THE_WHERE_AND_WHEN_MAP_2026-11-03.md and THE_REPORT_STATEMENT_CONTRACT_2026-11-05.md.

  1. FETCH WHAT IS NEW into the source cache, one folder per source, beside registry/ and outside the repo:
       ahq/       the posts AHQ's own sitemap lists for this water, 2.5 s apart, never signed in. A members-only teaser
                  is kept as one, so it is known and not asked for again.
       scdnr/     SCDNR's Freshwater Fishing Trends page, once a day, with the day it was read (the page states none)
       item/, scdnr_wb/   The Sumter Item (2004-2017) and SCDNR's page in the Internet Archive: a finished backfill
       cs/        Carolina Sportsman: the articles whose address names this water, and its "S.C. freshwater fishing report"
                  roundups, from the site's own post sitemaps (cs_articles.txt), 2.5 s apart (report_cs.py)
       scc/       Santee Cooper Country: Santee Cooper's, read by the Santee pipeline for now
  2. READ every statement about this water: report_column.py (SCDNR's column and The Item's copy of it, all waters),
     report_ahq.py (this water's AHQ posts), report_cs.py (its Carolina Sportsman articles and the roundups),
     report_text.py (depths, methods, lures and bait, time of day, the sentences), report_places.py (the places named,
     on his chart: chartpack/<slug>/, beside registry/). A paragraph in several
     places is kept once, at its earliest date, with the later dates in `repeated`; the same words said of two
     waters are two statements, except a report a page printed under two lakes by mistake (one_page_two_waters).
  3. CHECK every statement against report_contract.py. A water whose statements break the contract is not kept.
  4. KEEP: beside the water's research profile, lake_packages/<id>/reports.json, through the Worker's
     /research/save-reports, gzipped. That needs TROLLMAP_SYNC_TOKEN, so start it through Scripts\\run_research.ps1
     (`-Run '--lake wateree_lake --reports-only'`: a name with spaces needs \\" around it there, see the script's
     header); the key is never seen or printed. A save that fails on the network, or that the Worker cannot answer
     (5xx), is tried again after 5 s and 30 s; a refusal or a byte mismatch is not (SAVE_WAITS_S). --dry-run writes
     <out>/<slug>/reports.json on this machine instead and needs no key. Timed on Wateree, 11/5: 13 min the first
     time (the fetch, 2.9 s a post), 22 s after.

SC only: a water with no part in South Carolina is skipped, and the reason is said.

   py Scripts\\reports_step.py --lake "Wateree Lake" --registry F:\\TrollMapPipeline\\registry --dry-run
"""
import argparse, collections, datetime as dt, gzip, http.client, json, os, re, sys, time, urllib.error, urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import report_column as C          # noqa: E402
import report_ahq as A             # noqa: E402
import report_text as T            # noqa: E402
import report_contract as K        # noqa: E402
import report_cs as S                # noqa: E402
import report_places as P            # noqa: E402
import report_ga as G                # noqa: E402
import report_scc as SC              # noqa: E402
import report_tourney as TN          # noqa: E402
import report_yt as Y                # noqa: E402

PAUSE_S = 2.5                       # between two requests to the same site
# A save that fails on the network, or that the Worker cannot answer (5xx, 429), tries again after these waits.
# Lake Murray's save of 11/5 stopped on "getaddrinfo failed": his PC could not look up the Worker's address for a
# moment, and nothing was sent. Ryan: "the worker hiccups quite often when I use the uploader. A retry would help
# with that".
# Sending the same bytes to the same key again is harmless. A refusal (4xx) or a byte mismatch is not retried.
SAVE_WAITS_S = (5, 30)
_sleep = time.sleep                 # the test stands in for it
WORKER = os.environ.get('TROLLMAP_WORKER_URL', 'https://trollmap-worker.colonal1981.workers.dev')   # research_lakes.py's
AHQ_SITEMAP = 'https://www.anglersheadquarters.com/sitemap.xml'


class Clock:
    def __init__(self): self.t = time.perf_counter(); self.seconds = collections.OrderedDict()
    def mark(self, name):
        now = time.perf_counter(); self.seconds[name] = round(now - self.t, 1); self.t = now


def load_registry(regdir):
    with open(os.path.join(regdir, 'lake_index.json'), encoding='utf-8') as fh: idx = json.load(fh)
    names, disp = C.registry_names(regdir)
    return idx, names, disp


def in_sc(row):
    return 'SC' in (row.get('states') or [row.get('state')])


def find_slug(idx, name):
    """A registry slug from a slug or any of the water's own names ("Wateree Lake", "Lake Wateree, SC")."""
    if name in idx: return name
    want = re.sub(r'\s*\([^)]*\)', '', name).strip()
    want = re.sub(r',\s*[A-Z]{2}(/[A-Z]{2})*$', '', want).strip().lower()
    hits = [k for k, v in idx.items()
            if want in {re.sub(r',\s*[A-Z]{2}(/[A-Z]{2})*$', '', re.sub(r'\s*\([^)]*\)', '', n or '')).strip().lower()
                        for n in [v.get('name'), v.get('display_name')] + list(v.get('legacy_display_names') or [])}]
    cands = [k for k in hits if in_sc(idx[k])] or hits
    return cands[0] if len(cands) == 1 else None


def _get(url, timeout=60):
    return urllib.request.urlopen(urllib.request.Request(url, headers=A.UA), timeout=timeout).read().decode('utf-8', 'replace')


# A site's list is read once a run, not once a water: the 11/5 batch of eleven waters read AHQ's sitemap eleven
# times, 14 s each.
_READ_THIS_RUN = set()


def ahq_post_urls(cache, refresh=True, log=print):
    """Every AHQ report post AHQ's own sitemap lists, read fresh once a run and merged into the kept list; the kept
    list alone when the read fails."""
    path = os.path.join(cache, 'ahq_articles.txt')
    kept = []
    if os.path.exists(path):
        with open(path, encoding='utf-8-sig') as fh: kept = [u.strip() for u in fh]
    fresh = []
    if refresh and ('AHQ', path) not in _READ_THIS_RUN:
        _READ_THIS_RUN.add(('AHQ', path))
        try:
            index = _get(AHQ_SITEMAP)
            # The posts are in sitemap_articles_N.xml; sitemap_blogs_1.xml lists only the blogs themselves.
            maps = [m for m in re.findall(r'<loc>\s*([^<\s]+)\s*</loc>', index) if 'sitemap_articles' in m]
            for m in maps:
                time.sleep(PAUSE_S)
                fresh += [u for u in re.findall(r'<loc>\s*([^<\s]+)\s*</loc>', _get(m.replace('&amp;', '&')))
                          if '/blogs/ahq-report/' in u]
            if not fresh:
                log('   AHQ sitemap read, but it listed no report posts (%d maps): using the kept list of %d'
                    % (len(maps), len(kept)))
        except Exception as e:                                   # noqa: BLE001 -- say it and use the kept list
            log('   AHQ sitemap not read (%s): using the kept list of %d' % (e, len(kept)))
    urls = list(dict.fromkeys([u for u in kept + fresh if u]))
    if fresh:
        with open(path, 'w', encoding='utf-8') as f: f.write('\n'.join(urls) + '\n')
    return urls, len(set(fresh) - set(kept))


def cs_post_urls(cache, refresh=True, log=print):
    """Every post Carolina Sportsman's own sitemaps list ([(url, lastmod)]), read fresh once a run and kept in
    cs_articles.txt; the kept list alone when the read fails."""
    path = os.path.join(cache, 'cs_articles.txt')
    kept = []
    if os.path.exists(path):
        with open(path, encoding='utf-8-sig') as fh:
            kept = [tuple((l.rstrip('\n').split('\t') + [''])[:2]) for l in fh if l.strip()]
    if refresh and ('CS', path) not in _READ_THIS_RUN:
        _READ_THIS_RUN.add(('CS', path))
        try:
            fresh = S.article_urls(get=_get, pause=1.0, log=log)
            if fresh:
                new = len({u for u, _ in fresh} - {u for u, _ in kept})
                with open(path, 'w', encoding='utf-8') as f: f.write(''.join('%s\t%s\n' % x for x in fresh))
                return fresh, new
            log('   Carolina Sportsman sitemaps listed no posts: using the kept list of %d' % len(kept))
        except Exception as e:                                   # noqa: BLE001 -- say it and use the kept list
            log('   Carolina Sportsman sitemaps not read (%s): using the kept list of %d' % (e, len(kept)))
    return kept, 0


def cs_posts_for(posts, slug, sidx):
    """This water's articles (its name in the address) and every S.C. freshwater roundup, in the fishing sections."""
    return [u for u, _ in posts if S.wanted(u)
            and (S.ROUNDUP.search(S.slug_of(u)) or slug in S.waters_of_slug(S.slug_of(u), sidx))]


def ahq_posts_for(urls, slug, widx):
    out = []
    for u in urls:
        if 'fishing-report' not in u: continue
        w, _ = A.post_water({'slug': u.rstrip('/').split('/')[-1], 'title': None}, widx)
        if w and slug in w: out.append(u)
    return out


def fetch_missing(urls, folder, fetcher, log=print, limit=0, pause=None, slug_of=None):
    """Fetch each url not already kept in `folder`, `pause` (PAUSE_S) apart. Returns (fetched, teasers, failed)."""
    os.makedirs(folder, exist_ok=True)
    slug_of = slug_of or (lambda u: u.rstrip('/').split('/')[-1])
    todo = [u for u in urls if not os.path.exists(os.path.join(folder, slug_of(u) + '.json'))]
    if limit: todo = todo[:limit]
    got = teas = 0; failed = []
    for i, u in enumerate(todo, 1):
        try:
            rec = fetcher(u)
        except Exception as e:                                   # noqa: BLE001
            failed.append((u, str(e))); time.sleep(PAUSE_S * 2); continue
        with open(os.path.join(folder, rec['slug'] + '.json'), 'w', encoding='utf-8') as f:
            json.dump(rec, f, ensure_ascii=False, indent=1)
        got += 1; teas += bool(rec.get('members_only_teaser'))
        if i % 25 == 0: log('   %d/%d fetched' % (i, len(todo)))
        time.sleep(PAUSE_S if pause is None else (pause(u) if callable(pause) else pause))
    return got, teas, failed


def _listed(cache, name, key, lister, refresh, log, merge=False):
    """A site's list of posts ([(url, lastmod)]), read fresh once a run and kept in <cache>/<name>; the kept list
    alone when the read fails or lists nothing."""
    path = os.path.join(cache, name)
    kept = []
    if os.path.exists(path):
        with open(path, encoding='utf-8-sig') as fh:
            kept = [tuple((l.rstrip('\n').split('\t') + [''])[:2]) for l in fh if l.strip()]
    if refresh and (key, path) not in _READ_THIS_RUN:
        _READ_THIS_RUN.add((key, path))
        try:
            fresh = lister(log=log)
            if fresh and merge:                                   # a partial read adds to the kept list
                have = {u for u, _ in fresh}
                fresh = fresh + [x for x in kept if x[0] not in have]
            if fresh:
                new = len({u for u, _ in fresh} - {u for u, _ in kept})
                os.makedirs(cache, exist_ok=True)
                with open(path, 'w', encoding='utf-8') as f: f.write(''.join('%s\t%s\n' % x for x in fresh))
                return fresh, new
            log('   %s listed nothing: using the kept list of %d' % (key, len(kept)))
        except Exception as e:                                   # noqa: BLE001 -- say it and use the kept list
            log('   %s not listed (%s): using the kept list of %d' % (key, e, len(kept)))
    return kept, 0


GA_WATERS = {s for s, _ in G.WATERS}


def live_page(cache, log=print):
    folder = os.path.join(cache, 'scdnr'); os.makedirs(folder, exist_ok=True)
    p = os.path.join(folder, 'scdnr_trends_%s.json' % dt.date.today().isoformat())
    if os.path.exists(p): return False
    try:
        rec = C.fetch_live_page()
    except Exception as e:                                       # noqa: BLE001
        log('   SCDNR page not read (%s)' % e); return False
    with open(p, 'w', encoding='utf-8') as f: json.dump(rec, f, ensure_ascii=False, indent=1)
    return True


def _records(folder):
    for f in sorted(os.listdir(folder)) if os.path.isdir(folder) else []:
        if f.endswith('.json'):
            with open(os.path.join(folder, f), encoding='utf-8') as fh:
                yield json.load(fh)


def read_statements(slug, cache, idx, names, ahq_urls, cs_urls=(), extra=None):
    """Every statement about this water, in the column (all waters, so a reprint folds into its first copy and a
    guide's usual fish is learned from everything he said), in this water's AHQ posts and in its Carolina Sportsman
    articles and the S.C. roundups."""
    hrx = C.heading_rx(names)
    kinds = {k: v.get('feature_type') for k, v in idx.items()}
    widx = A.water_index(names, kinds)
    rows, seen, docs = [], {}, collections.Counter()
    # earlier month first; in the same month a day beats a month alone ("2023-03" from a monthly page), then the day
    first = lambda x: (x['date'][:7], len(x['date']) != 10, x['date'])
    def narrower(y, x):
        # a copy that names its water more narrowly gives the kept one its water, and says how it was named
        if x['waters'] and (not y['waters'] or set(x['waters']) < set(y['waters'])):
            y['waters'], y['heading'] = x['waters'], x['heading']
            if x.get('water_from'): y['water_from'] = x['water_from']
            else: y.pop('water_from', None)
    def same_water(x, y):
        # one paragraph said of two waters is two statements ("Catfish: Good, using nightcrawlers on the bottom."
        # under Lake Murray and under Lake Wateree); a copy with no water, or the pair's one lake, is the same one
        a, b = set(x['waters']), set(y['waters'])
        return not a or not b or a <= b or b <= a
    def add(st):
        for x in st:
            k = (tuple(x['species']), re.sub(r'[^a-z0-9]+', ' ', x['text'].lower()).strip())
            y = next((y for y in seen.get(k, []) if same_water(x, y)), None)
            if y is None:
                x['also'] = 0; seen.setdefault(k, []).append(x); rows.append(x); continue
            if first(x) < first(y):
                # the earliest copy is the one kept, the later ones are its reprints: AHQ re-uses a paragraph
                # in a later week, The Item reprints SCDNR's line days after it. Its water, if narrower, stays.
                old = dict(y); y.clear(); y.update(x); y['also'] = old['also']
                narrower(y, old)
                later = set(old.get('repeated', [])) | {old['date']}
            else:
                narrower(y, x)
                later = {x['date']}
            later = (set(y.get('repeated', [])) | later) - {y['date']}
            if later: y['repeated'] = sorted(later)
            y['also'] += 1
    two = 0
    for src, sub in (('Item', 'item'), ('SCDNR', 'scdnr'), ('SCDNR', 'scdnr_wb')):
        for rec in _records(os.path.join(cache, sub)):
            st, n = C.one_page_two_waters(C.statements(rec, src, names, hrx), names)
            docs[src] += 1; two += n; add(st)
    mine = {u.rstrip('/').split('/')[-1] for u in ahq_urls}
    for rec in _records(os.path.join(cache, 'ahq')):
        if rec.get('slug') in mine:
            docs['AHQ'] += 1; add(A.statements(rec, widx))
    if cs_urls:
        pn = S.plain_names(names); sidx = S.slug_index(pn, idx); rx = S.name_rx(pn)
        want = {S.slug_of(u) for u in cs_urls}
        for rec in _records(os.path.join(cache, 'cs')):
            if rec.get('slug') not in want: continue
            ws = None if S.ROUNDUP.search(rec['slug']) else S.waters_of_slug(rec['slug'], sidx)
            if ws is not None and (not ws or S.times_named(rec.get('text'), ws, pn, rx) < S.NAMED_AT_LEAST):
                docs['CS not about it'] += 1; continue          # its address names the water, its text does not
            docs['CS'] += 1; add(S.statements(rec, ws, pn, rx))
    extra = extra or {}
    for key, sub, reader in (('ga', 'ga', lambda r: G.statements(r, {slug})), ('scc', 'scc', lambda r: SC.statements(r, slug)),
                             ('tourney', 'tourney', lambda r: TN.statements(r, slug)), ('yt', 'yt', lambda r: Y.statements(r, slug))):
        if key != 'yt' and key not in extra: continue
        want = None if key == 'yt' else {(SC.slug_of(u[0]) if key == 'scc' else TN.slug_of(u) if key == 'tourney'
                                          else G.slug_of(u)) for u in extra[key]}
        for rec in _records(os.path.join(cache, sub)):
            if want is not None and rec.get('slug') not in want: continue
            st = reader(rec)
            if st: docs[st[0]['source']] += 1; add(st)
    C.assign_unheaded(rows)
    C.species_by_captains(rows)
    rows, folded = C.collapse_repeats(rows)
    return [x for x in rows if slug in x['waters']], docs, folded, two


def to_contract(x, where=None):
    """`where` is the water's report_places.Matcher: the places the words name, on his chart."""
    return K.blank(
        places=where.places(x['text']) if where else [], area=P.areas(x['text']),
        source=x['source'], url=x['url'], archived=x.get('archived'), date=x['date'], dated_by=x['dated_by'],
        water=x['waters'], water_from=(x.get('water_from') or 'heading') if x['waters'] else 'none',
        water_as_written=x.get('heading'), species=x['species'], species_as_written=x.get('label'), about=x['about'],
        who=x['who'], text=x['text'], rating=x.get('rating'), water_temp_f_said=x.get('water_temp_f_said'),
        depths=T.depths(x['text']), methods=T.methods(x['text']), kinds_of_water=T.kinds_of_water(x['text']),
        lures=T.lures(x['text'], x['species']), bait=T.bait(x['text'], x['species']), time_of_day=T.times(x['text']),
        sentences=T.sentences(x['text'], x['species']), repeated=x.get('repeated', []), copies=x.get('also', 0))


def run(slug, regdir, cache, out, dry_run=True, fetch=True, limit=0, log=print):
    """One water, start to kept file. Returns a result dict; never raises."""
    clock = Clock()
    res = {'water': slug, 'ok': False, 'kept': None, 'seconds': clock.seconds, 'skipped': None}
    try:
        idx, names, disp = load_registry(regdir)
        row = idx.get(slug)
        if not row: res['error'] = 'not in the registry'; return res
        res['name'] = row.get('display_name') or row.get('name')
        if not in_sc(row):
            res['skipped'] = 'no part of it is in SC, and every reports source is SC (report_contract.SOURCES)'
            res['ok'] = True; return res
        kinds = {k: v.get('feature_type') for k, v in idx.items()}
        widx = A.water_index(names, kinds)
        clock.mark('registry')
        urls, new_listed = ahq_post_urls(cache, refresh=fetch, log=log)
        mine = ahq_posts_for(urls, slug, widx)
        res['ahq_posts_listed'] = len(mine); res['ahq_new_in_sitemap'] = new_listed
        clock.mark('AHQ sitemap')
        cs_all, cs_new = cs_post_urls(cache, refresh=fetch, log=log)
        cs_mine = cs_posts_for(cs_all, slug, S.slug_index(S.plain_names(names), idx))
        res['cs_posts_listed'] = len(cs_mine); res['cs_new_in_sitemap'] = cs_new
        clock.mark('CS sitemap')
        if fetch:
            got, teas, failed = fetch_missing(mine, os.path.join(cache, 'ahq'), A.fetch_post, log=log, limit=limit)
            res['ahq_fetched'] = got; res['ahq_teasers'] = teas; res['ahq_failed'] = failed
            clock.mark('AHQ fetch')
            got, _, failed = fetch_missing(cs_mine, os.path.join(cache, 'cs'), S.fetch_article, log=log, limit=limit)
            res['cs_fetched'] = got; res['cs_failed'] = failed
            clock.mark('CS fetch')
            res['scdnr_page_read'] = live_page(cache, log=log)
            clock.mark('SCDNR page')
        # 11/6, his picks: Georgia DNR's weekly blog (Hartwell, Thurmond, Russell), Santee Cooper Country's monthly
        # pages (Marion, Moultrie), the tournament reports on his lakes (Bassmaster, MLF). The Murray videos are kept
        # in yt/ and read as they are.
        extra = {}
        if slug in GA_WATERS:
            ga, _ = _listed(cache, 'ga_posts.txt', 'GA-WRD', G.post_urls, fetch, log)
            extra['ga'] = [u for u, _ in ga]
        if slug in SC.LAKES:
            sc, _ = _listed(cache, 'scc_pages.txt', 'SCC', SC.page_urls, fetch, log)
            extra['scc'] = sc
        first = not os.path.exists(os.path.join(cache, 'tourney_articles.txt'))
        tn, _ = _listed(cache, 'tourney_articles.txt', 'tournaments',
                        lambda log: TN.article_urls(log=log, mlf_all=first), fetch, log, merge=True)
        extra['tourney'] = [u for u, _ in tn if slug in TN.waters_of(u)]
        res['new_sources_listed'] = {k: len(v) for k, v in extra.items()}
        if fetch:
            got = {}
            if 'ga' in extra:
                got['GA-WRD'] = fetch_missing(extra['ga'], os.path.join(cache, 'ga'), G.fetch_post, log=log, limit=limit)[0]
            if 'scc' in extra:
                mods = dict(extra['scc'])
                got['SCC'] = fetch_missing(list(mods), os.path.join(cache, 'scc'), lambda u: SC.fetch_page(u, mods.get(u, '')),
                                           log=log, limit=limit)[0]
            got['tournaments'] = fetch_missing(extra['tourney'], os.path.join(cache, 'tourney'), TN.fetch_article, log=log,
                                               limit=limit, pause=lambda u: TN.PAUSE[TN.site_of(u)], slug_of=TN.slug_of)[0]
            res['new_sources_fetched'] = got
            clock.mark('new sources')
        rows, docs, folded, two = read_statements(slug, cache, idx, names, mine, cs_mine, extra)
        res['documents_read'] = dict(docs); res['paragraphs_folded'] = folded
        res['one_page_two_waters'] = two
        clock.mark('read')
        packs = os.path.join(os.path.dirname(os.path.abspath(regdir)), 'chartpack')
        where = P.Matcher(P.gazetteer(packs, regdir, slug))
        statements = [to_contract(x, where) for x in rows]
        res['places_named'] = sum(1 for s in statements if s['places'])
        texts = K.source_texts(cache)
        slugs = set(idx)
        bad = [(s['date'], s['source'], e) for s in statements for e in [K.check(s, slugs, texts)] if e]
        res['statements'] = len(statements); res['broken'] = bad[:5]; res['broken_n'] = len(bad)
        clock.mark('check')
        if bad:
            res['error'] = '%d statements break the contract; nothing kept' % len(bad); return res
        res['by_source'] = dict(collections.Counter(s['source'] for s in statements))
        res['by_year'] = dict(sorted(collections.Counter(s['date'][:4] for s in statements).items()))
        res['by_species'] = dict(collections.Counter(sp for s in statements for sp in s['species']).most_common())
        body = {'water': slug, 'name': res['name'], 'built_by': 'reports_step.py', 'contract': 'report_contract.py',
                'built_at': dt.datetime.now().isoformat(timespec='seconds'),
                'note': 'Personal use only, not for distribution or resale; not for navigation.',
                'statements': statements}
        if dry_run:
            os.makedirs(os.path.join(out, slug), exist_ok=True)
            p = os.path.join(out, slug, 'reports.json')
            with open(p, 'w', encoding='utf-8') as f: json.dump(body, f, ensure_ascii=False, indent=1)
            res['kept'] = p; res['bytes'] = os.path.getsize(p)
        else:
            res['saved'], res['bytes'], res['bytes_before_gzip'], tries = save_beside_profile(
                body, res['name'], slug, len(statements), log=log)
            if tries > 1: res['save_tries'] = tries
        clock.mark('save' if not dry_run else 'write')
        res['ok'] = True
    except Exception as e:                                       # noqa: BLE001 -- a water's failure is its own
        res['error'] = '%s: %s' % (type(e).__name__, e)
    return res


def _post(url, data, headers, timeout=180):
    """(HTTP status, body bytes). Its own function so the test can stand in for the Worker."""
    req = urllib.request.Request(url, data=data, headers=headers, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def _passing(code):
    """A Worker answer worth asking again: it could not answer (5xx), or asked us to wait (429). A 4xx is a refusal."""
    return code == 429 or code >= 500


def save_beside_profile(body, lake, slug, n, log=print):
    """The file to lake_packages/<id>/reports.json through the Worker. Gzipped, because the Worker stores the bytes
    without reading them: it has 10 ms of CPU a request, and parsing 3 MB of JSON would spend it. Returns (key,
    bytes sent, bytes before gzip, tries); raises when the Worker did not keep exactly what was sent.

    A network failure or a passing Worker error is tried again after each of SAVE_WAITS_S; a refusal is not."""
    token = os.environ.get('TROLLMAP_SYNC_TOKEN', '')
    if not token:
        raise RuntimeError('TROLLMAP_SYNC_TOKEN is not set: start the save through Scripts\\run_research.ps1 '
                           '(or use --dry-run to keep the file on this machine)')
    raw = json.dumps(body, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    gz = gzip.compress(raw, 9)
    q = urllib.parse.urlencode({'lake': lake, 'water': slug, 'statements': n})
    url = '%s/research/save-reports?%s' % (WORKER, q)
    headers = {'Content-Type': 'application/gzip', 'Accept': 'application/json',
               'User-Agent': A.UA['User-Agent'], 'X-Sync-Token': token}
    failed = []                                 # what went wrong on each try, said without the key
    for tries, wait in enumerate((0,) + tuple(SAVE_WAITS_S), 1):
        if wait:
            log('   save: %s; trying again in %d s' % (failed[-1], wait))
            _sleep(wait)
        try:
            code, resp = _post(url, gz, headers)
        except (OSError, http.client.HTTPException) as e:   # URLError (a lookup or a refused connection), a timeout,
            code, resp = None, None                          # a dropped connection, a body cut short
            failed.append('%s: %s' % (type(e).__name__, e))
            continue
        if not _passing(code): break
        failed.append('HTTP %s' % code)
    if code is None:
        raise RuntimeError('the save failed on all %d tries (%s)' % (tries, '; '.join(failed)))
    try: got = json.loads(resp)
    except (ValueError, TypeError): got = None
    if code != 200 or not isinstance(got, dict) or not got.get('ok'):
        why = (got or {}).get('error') if isinstance(got, dict) else (resp or b'')[:300].decode('utf-8', 'replace')
        raise RuntimeError('the Worker did not keep it (HTTP %s%s): %s'
                           % (code, ', after %d tries' % tries if tries > 1 else '', why))
    if got.get('bytes') != len(gz):
        raise RuntimeError('the Worker kept %s bytes of the %d sent (%s)' % (got.get('bytes'), len(gz), got.get('key')))
    return got['key'], len(gz), len(raw), tries


def report(res, log=print):
    t = res['seconds']; total = sum(t.values())
    log('%s %s (%s)' % ('ok  ' if res['ok'] else 'FAIL', res.get('name') or res['water'], res['water']))
    if res.get('skipped'): log('   skipped: ' + res['skipped']); return
    if res.get('error'): log('   ' + res['error'])
    for k in ('ahq_posts_listed', 'ahq_new_in_sitemap', 'ahq_fetched', 'ahq_teasers', 'cs_posts_listed', 'cs_new_in_sitemap',
              'cs_fetched', 'scdnr_page_read', 'new_sources_listed', 'new_sources_fetched', 'documents_read',
              'paragraphs_folded', 'one_page_two_waters', 'statements', 'places_named', 'broken_n', 'by_source', 'by_year', 'by_species', 'kept', 'saved',
              'save_tries', 'bytes', 'bytes_before_gzip'):
        if k in res: log('   %-20s %s' % (k, res[k]))
    for u, e in ((res.get('ahq_failed') or []) + (res.get('cs_failed') or []))[:5]: log('   failed %s: %s' % (u, e))
    for b in res.get('broken') or []: log('   broken %s' % (b,))
    log('   where the time went: ' + ', '.join('%s %.1f s' % kv for kv in t.items()) + '; total %.1f s' % total)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--lake', action='append', required=True, help='a registry slug or any of its names (repeatable)')
    ap.add_argument('--registry', default='registry')
    ap.add_argument('--cache', default=None, help='source cache (default: reports_sources beside the registry)')
    ap.add_argument('--out', default=None, help='where --dry-run keeps the file (default: reports_dry_run beside it)')
    ap.add_argument('--dry-run', action='store_true',
                    help='keep the file on this machine and save nothing beside the profile (needs no key)')
    ap.add_argument('--no-fetch', action='store_true', help='read only what is already in the cache')
    ap.add_argument('--limit', type=int, default=0, help='fetch at most N new posts per water (0 = all)')
    a = ap.parse_args(argv)
    base = os.path.dirname(os.path.abspath(a.registry))
    cache = a.cache or os.path.join(base, 'reports_sources'); out = a.out or os.path.join(base, 'reports_dry_run')
    with open(os.path.join(a.registry, 'lake_index.json'), encoding='utf-8') as fh: idx = json.load(fh)
    bad = 0
    for name in a.lake:
        slug = find_slug(idx, name)
        if not slug:
            print('FAIL %s: no single registry water by that name' % name); bad += 1; continue
        r = run(slug, a.registry, cache, out, dry_run=a.dry_run, fetch=not a.no_fetch, limit=a.limit)
        report(r); bad += not r['ok']
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
