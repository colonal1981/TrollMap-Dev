#!/usr/bin/env python3
"""report_scc.py -- Santee Cooper Country's monthly fishing report pages (santeecoopercountry.org), every fish, for
Lake Marion and Lake Moultrie.

Personal use only, not for distribution or resale; not for navigation.

Ryan picked it on 11/6. One page a month (2023 on), written by Capt. Joe Dennis and Kyle Austin, under a heading per
fish: "Striper", "Bass", "Crappie & Bream", "Catfish". The pages are listed in the site's own page sitemap, several
named for a month with no year ("fishing-reports-april"), so the year comes from the sitemap's date.

The report is about both lakes ("Santee Cooper"); a paragraph that names one lake ("on lake Marion", "the lower lake")
goes to that one. SCC's Facebook posts are not read here: Facebook's robots.txt prohibits automated collection, so a
post comes in through the paste box (APP_CHANGE_REQUESTS item 44), his own reading.
"""
import html, re, urllib.request

import report_column as C
import report_contract as K

SITEMAP = 'https://www.santeecoopercountry.org/page-sitemap.xml'
UA = {'User-Agent': 'Mozilla/5.0 (personal fishing app research; reading public reports)'}
PAGE = re.compile(r'santeecoopercountry\.org/(?:fishing/)?(fishing-reports[^/]*)/?$')
MON3 = {m[:3]: i for i, m in enumerate(['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
                                       'september', 'october', 'november', 'december'], 1)}
LAKES = ('lake_marion', 'lake_moultrie')
MARION = re.compile(r'\b(?:lake marion|upper lake|upper end of (?:the )?lake)\b', re.I)
MOULTRIE = re.compile(r'\b(?:lake moultrie|lower lake)\b', re.I)


def _get(url, timeout=60):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read().decode('utf-8', 'replace')


def page_urls(get=_get, log=print):
    """[(url, lastmod)] for the monthly report pages in the site's page sitemap (it wraps values in CDATA)."""
    sm = re.sub(r'<!\[CDATA\[|\]\]>', '', get(SITEMAP))
    out = []
    for block in re.findall(r'(?s)<url>(.*?)</url>', sm):
        loc = re.search(r'<loc>\s*([^<\s]+)\s*</loc>', block)
        mod = re.search(r'<lastmod>\s*([^<\s]+)\s*</lastmod>', block)
        if loc and PAGE.search(loc.group(1)): out.append((loc.group(1), mod.group(1) if mod else ''))
    log('   Santee Cooper Country: %d report pages in the sitemap' % len(out))
    return out


def slug_of(url):
    return url.rstrip('/').rsplit('/', 1)[-1]


def fetch_page(url, lastmod='', timeout=40):
    h = _get(url, timeout)
    m = re.search(r'(?is)<main\b.*?</main>', h) or re.search(r'(?is)<article\b.*?</article>', h)
    s = re.sub(r'(?is)<(script|style|noscript|svg|nav|header|footer|form|aside).*?</\1>', ' ', m.group(0) if m else h)
    s = re.sub(r'(?i)<br\s*/?>', '\n', s)
    s = re.sub(r'(?i)</(p|div|h[1-6]|li|tr|section|article)>', '\n', s)
    s = html.unescape(re.sub(r'<[^>]+>', ' ', s))
    s = re.sub(r'\n\s*\n+', '\n', re.sub(r'[ \t ]+', ' ', s)).strip()
    t = re.search(r'<title>([^<]*)</title>', h, re.I)
    pub = re.search(r'article:published_time["\'][^>]+content=["\']([^"\']+)', h)
    return {'url': url, 'slug': slug_of(url), 'title': html.unescape(t.group(1)).strip() if t else None,
            'sitemap_lastmod': lastmod or None, 'page_time': pub.group(1) if pub else None, 'chars': len(s), 'text': s}


def month_of(rec):
    """'YYYY-MM' from the page's address, with the year from the address or else the sitemap's or page's date."""
    slug = rec.get('slug') or ''
    mo = next((v for k, v in MON3.items() if re.search(r'-' + k, slug)), None)
    if mo is None:
        # the "Latest" page (fishing-reports/) names no month: it is the month it was last written
        d = (rec.get('sitemap_lastmod') or rec.get('page_time') or '')[:7]
        return d if slug == 'fishing-reports' and re.fullmatch(r'\d{4}-\d{2}', d) else None
    yy = re.search(r'(\d{2,4})(?:-facebook)?$', slug.replace('march2026', 'march-2026'))
    if yy:
        y = int(yy.group(1)); year = 2000 + y if y < 100 else y
    else:
        d = (rec.get('sitemap_lastmod') or rec.get('page_time') or '')[:7]
        if not re.fullmatch(r'\d{4}-\d{2}', d): return None
        year = int(d[:4]) - (1 if int(d[5:7]) < mo else 0)        # a December page last edited in January
    return '%04d-%02d' % (year, mo)


def statements(rec, slug):
    """This page's statements about `slug` (lake_marion or lake_moultrie)."""
    if slug not in LAKES or 'facebook' in (rec.get('slug') or ''): return []
    date = month_of(rec)
    if not date: return []
    out, species, label = [], None, None
    lines = [l.strip() for l in (rec.get('text') or '').split('\n') if l.strip()]
    by = next((C.who(l) for l in lines if re.match(r'provided by', l, re.I)), [])
    for line in lines:
        sp = C.species_of_label(line) if len(line) < 40 else None
        if sp:
            species, label = sp, line; continue
        if len(line) < 40: continue                                  # "Season is open!", the month links
        if len(line) < 70 and not re.search(r'[.!?]$', line): continue   # "B.A.S.S. report from Captain Kyle Austin"
        if not species or K.WRAPPING.search(line) or re.search(r'season (?:is )?closed', line, re.I) and len(line) < 60:
            continue
        m, o = bool(MARION.search(line)), bool(MOULTRIE.search(line))
        waters = ['lake_marion'] if m and not o else ['lake_moultrie'] if o and not m else list(LAKES)
        if slug not in waters: continue
        t = re.sub(r'\s+', ' ', line)
        out.append({'source': 'SCC', 'url': rec['url'], 'archived': None, 'date': date, 'dated_by': 'month of the report',
                    'waters': waters, 'water_from': 'named' if len(waters) == 1 else 'system', 'heading': rec.get('title'),
                    'species': species, 'label': label, 'rating': None, 'about': 'labelled', 'text': t,
                    'who': C.who(t) or by, 'water_temp_f_said': C.temp_f(t)})
    return out
