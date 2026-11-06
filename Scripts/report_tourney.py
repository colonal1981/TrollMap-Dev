#!/usr/bin/env python3
"""report_tourney.py -- tournament write-ups on his lakes: Bassmaster (B.A.S.S.) and Major League Fishing, their
"Top 5 patterns", "Top 10 patterns" and day reports.

Personal use only, not for distribution or resale; not for navigation.

Ryan picked them on 11/6. A tournament allows artificial lures only, so every pattern in one is a lure he can throw or
troll, with the depth, the cover and often the spot, dated. Both sites' robots.txt allow reading; Major League Fishing
asks for 15 s between requests (Crawl-Delay: 15); its pages come back empty to a plain request, so it is off
(MLF_READ) until it can be read the way a browser reads it.

WHICH ARTICLES: the ones each site's own sitemaps list whose address names one of his lakes and reads as a tournament
report (patterns, baits, top 5 or 10, won, leads, a day, a recap). The article's own text must name the water at least
twice, as with Carolina Sportsman.

WHAT IS KEPT: a paragraph that says something a plan can use (a lure, a depth, where the fish sat, a kind of water).
Standings and weights alone are not kept. A paragraph naming no fish is about bass: these are bass tournaments.
"""
import html, re, urllib.request

import report_column as C
import report_contract as K
import report_text as T

UA = {'User-Agent': 'Mozilla/5.0 (personal fishing app research; reading public articles)'}
# Bassmaster's sitemap is one map a day (sitemap-2018.xml?mm=12&dd=31), about 365 a year. Read are: the last 45 days
# each run, and the days around the B.A.S.S. events on his lakes found on 11/6 (its own articles, by search), plus
# those articles themselves. The whole archive day by day would be about 7,000 reads; not done.
BASS_DAY = 'https://www.bassmaster.com/sitemap-%d.xml?mm=%d&dd=%d'
BASS_EVENTS = ['2026-05-14', '2023-04-27', '2022-03-24', '2020-10-15',      # Elite, Santee Cooper
               '2026-05-07', '2024-05-09', '2023-04-13',                    # Elite, Lake Murray
               '2025-04-24', '2022-10-06', '2020-09-24',                    # Elite and Opens, Hartwell
               '2008-02-22', '2015-02-20', '2018-03-16', '2022-03-04',      # the Classics on Hartwell
               '2007-04-12']                                                # Elite, Clarks Hill
BASS_SEEDS = ['https://www.bassmaster.com/elite/news/elite-analysis-santee-cooper-lakes-day-1/',
              'https://www.bassmaster.com/elite/news/elite-analysis-day-3santee-cooper/',
              'https://www.bassmaster.com/elite/news/chris-johnston-dominates-at-santee-cooper-to-capture-second-elite-series-win/',
              'https://www.bassmaster.com/news/top-5-patterns-of-the-hartwell-classic/',
              'https://www.bassmaster.com/news/walters-wins-it-all-on-hartwell/',
              'https://www.bassmaster.com/opens/news/mccormick-moves-to-the-top-with-hartwell-win/',
              'https://www.bassmaster.com/elite/news/marks-masters-lake-hartwell/',
              'https://www.bassmaster.com/elite/news/marks-captures-second-elite-series-title-at-lake-murray/',
              'https://www.bassmaster.com/elite/news/smith-powers-into-lead-at-lake-murray-elite/',
              'https://www.bassmaster.com/elite/news/wagner-waltzes-to-day-1-lead-at-lake-murray/',
              'https://www.bassmaster.com/news/elite-returns-to-georgias-clarks-hill/']
MLF_INDEX = ['https://majorleaguefishing.com/sitemap_index.xml', 'https://majorleaguefishing.com/wp-sitemap.xml',
             'https://majorleaguefishing.com/sitemap.xml']
PAUSE = {'bassmaster.com': 2.5, 'majorleaguefishing.com': 15.0}
MLF_READ = False
LAKE_WORDS = [  # address words -> registry slugs
    (r'santee[- ]cooper|lake-marion|lake-moultrie|santee', ['lake_marion', 'lake_moultrie']),
    (r'lake-murray', ['lake_murray']), (r'wateree', ['wateree_lake']), (r'hartwell', ['hartwell_lake']),
    (r'clarks?-hill|thurmond', ['j_strom_thurmond_reservoir']), (r'lake-russell|russell-lake|richard-b-russell', ['richard_b_russell_lake']),
    (r'lake-greenwood', ['lake_greenwood']), (r'lake-wylie', ['lake_wylie']), (r'keowee', ['lake_keowee']),
    (r'jocassee', ['lake_jocassee'])]   # not Monticello: Virginia has a Lake Monticello too
LAKE_RX = [(re.compile(r'(?:^|[/\d-])(?:' + w + r')(?:[-/]|$)'), s) for w, s in LAKE_WORDS]
REPORT = re.compile(r'pattern|baits?|lures?|top-?(?:5|10|five|ten|20)|\bwon\b|-won-|wins|winning|leads?|leader|day-?[1-4]|recap|'
                    r'how-|champion|classic|elite|open|bfl|toyota|tournament|derby|weigh', re.I)
NAMES = {'lake_marion': r'Santee Cooper|Lake Marion|Marion', 'lake_moultrie': r'Santee Cooper|Lake Moultrie|Moultrie',
         'lake_murray': r'Lake Murray', 'wateree_lake': r'Wateree', 'hartwell_lake': r'Hartwell',
         'j_strom_thurmond_reservoir': r'Clarks Hill|Thurmond', 'richard_b_russell_lake': r'Russell',
         'lake_greenwood': r'Greenwood', 'lake_wylie': r'Wylie', 'lake_keowee': r'Keowee', 'lake_jocassee': r'Jocassee',
         'monticello_reservoir': r'Monticello'}
NAMED_AT_LEAST = 2


def _get(url, timeout=60):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read().decode('utf-8', 'replace')


def site_of(url):
    return 'majorleaguefishing.com' if 'majorleaguefishing.com' in url else 'bassmaster.com'


def waters_of(url):
    path = url.split('://', 1)[-1].split('/', 1)[-1].lower()
    out = []
    for rx, slugs in LAKE_RX:
        if rx.search(path): out += [s for s in slugs if s not in out]
    return out


def wanted(url):
    path = url.split('://', 1)[-1].split('/', 1)[-1].lower()
    return (bool(waters_of(url)) and bool(REPORT.search(path))
            and not re.search(r'/(?:tag|category|author|video|top-video|photos?|gallery|tournament|slideshow)/|fantasy|'
                              r'leaderboard', path))   # a slideshow's slides are drawn by script: no text to read


def _urls(xml):
    out = []
    for block in re.findall(r'(?s)<url>(.*?)</url>', xml):
        loc = re.search(r'<loc>\s*([^<\s]+)\s*</loc>', block)
        mod = re.search(r'<lastmod>\s*([^<\s]+)\s*</lastmod>', block)
        if loc: out.append((html.unescape(loc.group(1)), mod.group(1) if mod else ''))
    return out


def _days(kept_dates=()):
    """The Bassmaster day maps to read: the last 45 days and 12 days either side of each known event."""
    import datetime as dt
    today = dt.date.today()
    days = {today - dt.timedelta(d) for d in range(45)}
    for e in BASS_EVENTS:
        d0 = dt.date.fromisoformat(e)
        days |= {d0 + dt.timedelta(k) for k in range(-12, 13)}
    return sorted(d for d in days if d <= today and d not in kept_dates)


def article_urls(get=_get, sleep=None, log=print, mlf_all=True):
    """[(url, lastmod)] for the tournament reports on his lakes: Bassmaster's day maps (above) and its seed articles,
    and Major League Fishing's post sitemaps (all of them the first time, `mlf_all`; the newest two after)."""
    import time
    sleep = sleep or time.sleep
    out = [(u, '') for u in BASS_SEEDS]
    for d in _days():
        try: out += [x for x in _urls(get(BASS_DAY % (d.year, d.month, d.day))) if wanted(x[0])]
        except Exception:                                        # noqa: BLE001 -- a day with no map
            pass
        sleep(1.0)
    # Major League Fishing's article pages come back empty to a plain request (11/6: 0 characters from its "Top 10
    # Patterns from Santee Cooper", where a browser shows the article), so they are not read. MLF_READ turns it on.
    for idx in (MLF_INDEX if MLF_READ else []):
        try: xml = get(idx)
        except Exception:                                        # noqa: BLE001
            sleep(PAUSE['majorleaguefishing.com']); continue
        maps = [u for u in re.findall(r'<loc>\s*([^<\s]+)\s*</loc>', xml) if 'post-sitemap' in u]
        maps.sort(key=lambda u: int(re.search(r'post-sitemap(\d*)', u).group(1) or 1))
        if not mlf_all: maps = maps[-2:]
        sleep(PAUSE['majorleaguefishing.com'])
        for m in maps:
            try: out += [x for x in _urls(get(m)) if wanted(x[0])]
            except Exception:                                    # noqa: BLE001
                pass
            sleep(PAUSE['majorleaguefishing.com'])
        break
    seen = set()
    out = [x for x in out if not (x[0] in seen or seen.add(x[0]))]
    log('   tournament reports on his lakes: %d (Bassmaster %d, MLF %d)'
        % (len(out), sum(site_of(u) == 'bassmaster.com' for u, _ in out), sum(site_of(u) != 'bassmaster.com' for u, _ in out)))
    return out


def slug_of(url):
    return re.sub(r'[^a-z0-9-]+', '-', url.rstrip('/').rsplit('/', 1)[-1].lower())[:120]


def text_of(fragment):
    s = re.sub(r'(?is)<(script|style|noscript|svg|nav|header|footer|form|aside|figure|figcaption).*?</\1>', ' ', fragment)
    s = re.sub(r'(?i)<br\s*/?>', '\n', s)
    s = re.sub(r'(?i)</(p|div|h[1-6]|li|tr|section|article)>', '\n', s)
    s = html.unescape(re.sub(r'<[^>]+>', ' ', s))
    s = re.sub(r'[ \t ]+', ' ', s)
    return re.sub(r'\n\s*\n+', '\n', s).strip()


def fetch_article(url, timeout=40):
    h = _get(url, timeout)
    m = re.search(r'(?is)<article\b.*?</article>', h) or re.search(r'(?is)<main\b.*?</main>', h)
    body = text_of(m.group(0) if m else '')
    pub = (re.search(r'article:published_time["\'][^>]+content=["\']([^"\']+)', h)
           or re.search(r'"datePublished"\s*:\s*"([^"]+)"', h))
    if not pub:
        d = re.search(r'/(20\d\d)[/-](\d\d)[/-](\d\d)', url)
        pub_s = '%s-%s-%s' % d.groups() if d else None
    else:
        pub_s = pub.group(1)
    t = re.search(r'<title>([^<]*)</title>', h, re.I)
    return {'url': url, 'slug': slug_of(url), 'site': site_of(url), 'title': html.unescape(t.group(1)).strip() if t else None,
            'published': pub_s, 'chars': len(body), 'text': body}


def statements(rec, slug):
    """The article's usable paragraphs, for `slug` if the article is about it."""
    if slug not in waters_of(rec.get('url') or ''): return []
    date = (rec.get('published') or '')[:10]
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', date): return []
    if len(re.findall(NAMES[slug], rec.get('text') or '')) < NAMED_AT_LEAST: return []
    src = 'MLF' if rec.get('site') == 'majorleaguefishing.com' or 'majorleaguefishing' in rec['url'] else 'BASS'
    out = []
    for p in [re.sub(r'\s+', ' ', l).strip() for l in (rec.get('text') or '').split('\n')]:
        if len(p) < 60 or not re.search(r'[.!?"”’)]\s*$', p) or K.WRAPPING.search(p): continue
        sp = C.species_in(p) or ['black bass']
        if not (T.lures(p, sp) or T.depths(p) or any(re.search(rx, p, re.I) for _, rx in T.POS) or T.kinds_of_water(p)):
            continue
        out.append({'source': src, 'url': rec['url'], 'archived': None, 'date': date, 'dated_by': 'published',
                    'waters': waters_of(rec['url']), 'water_from': 'source page', 'heading': rec.get('title'),
                    'species': sp, 'label': None, 'rating': None, 'about': 'named' if C.species_in(p) else 'continued',
                    'text': p, 'who': C.who(p), 'water_temp_f_said': C.temp_f(p)})
    return out
