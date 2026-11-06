#!/usr/bin/env python3
"""report_ga.py -- Georgia DNR's weekly Georgia Fishing Report (georgiawildlife.blog) for the three lakes on the line:
Hartwell, Clarks Hill (J. Strom Thurmond) and Russell.

Personal use only, not for distribution or resale; not for navigation.

Ryan picked it on 11/6 with the other new sources. Written each week by the Wildlife Resources Division's fisheries
staff, with local guides and Ken Sturdivant's Southern Fishing Report credited by name. Every fish, the lures, the
spots and the depths, and each lake's line opens with the level and the water temperature: "LAKE HARTWELL IS DOWN 7.4
FEET, 40'S". Hartwell has no lake temperature gauge, so that line is its weekly temperature.

The blog's robots.txt allows reading (only /wp-admin/ is closed). Read 2.5 s apart, never signed in. Southern Fishing's
own site closes itself to everything but search engines; its words here are the ones Georgia's blog prints, credited.

A post is read only for the three lakes; the rest of Georgia stays out (every source is SC waters, his word of 11/5).
"""
import html, re, urllib.request

import report_column as C
import report_contract as K

SITEMAP = 'https://georgiawildlife.blog/sitemap.xml'
UA = {'User-Agent': 'Mozilla/5.0 (personal fishing app research; reading public reports)'}
POST = re.compile(r'georgiawildlife\.blog/(\d{4})/(\d{2})/(\d{2})/[^/]*fishing-report[^/]*/?$')
# A lake's section starts at its heading line and runs to the next heading line (another lake, a region, a part).
WATERS = [('hartwell_lake', re.compile(r'^\s*(?:#+\s*)?(?:LAKE HARTWELL|HARTWELL LAKE|HARTWELL)\b', re.I)),
          ('j_strom_thurmond_reservoir', re.compile(r'^\s*(?:#+\s*)?(?:CLARKS? HILL(?: LAKE)?|LAKE THURMOND|THURMOND LAKE|'
                                                    r'J\.? ?STROM THURMOND)\b', re.I)),
          ('richard_b_russell_lake', re.compile(r'^\s*(?:#+\s*)?(?:LAKE RUSSELL|RUSSELL LAKE|RICHARD B\.? RUSSELL)\b', re.I))]
HEADING = re.compile(r"^\s*(?:#+\s*)?[A-Z][A-Z0-9 .,'’&/()-]{3,60}$")
# "LAKE HARTWELL IS DOWN 7.4 FEET, 40'S", "CLARKS HILL IS DOWN 6.7 FEET, 50’S", "... FULL, MID 60'S"
TEMP = re.compile(r"(?:FEET|FT|FULL POOL|FULL|POOL)\b[^,\n]{0,20},\s*(?:CLEAR|STAINED|MUDDY|[A-Z]+,\s*)*"
                  r"(LOW|MID|MIDDLE|UPPER|HIGH)?\s*(\d{2})\s*['’]?\s*S\b", re.I)
COURTESY = re.compile(r'(?i:courtesy of|via)\s+([A-Z][\w.\']+(?:\s+[A-Z][\w.\']+){0,3})')


def _get(url, timeout=60):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read().decode('utf-8', 'replace')


def post_urls(get=_get, pause=1.0, sleep=None, log=print):
    """[(url, lastmod)] for every Georgia Fishing Report post the blog's own sitemaps list. The blog's sitemap.xml is
    an index of indexes (sitemap-index-1.xml, then sitemap-N.xml); the image and video maps are skipped."""
    import time
    sleep = sleep or time.sleep
    out, maps, todo = [], 0, [SITEMAP]
    while todo:
        m = todo.pop(0)
        xml = get(m); maps += 1
        if '<sitemapindex' in xml:
            todo += [u for u in re.findall(r'<loc>\s*([^<\s]+)\s*</loc>', xml) if not re.search(r'image|video', u)]
        else:
            for block in re.findall(r'(?s)<url>(.*?)</url>', xml):
                loc = re.search(r'<loc>\s*([^<\s]+)\s*</loc>', block)
                mod = re.search(r'<lastmod>\s*([^<\s]+)\s*</lastmod>', block)
                if loc and POST.search(loc.group(1)): out.append((loc.group(1), mod.group(1) if mod else ''))
        sleep(pause)
    log('   Georgia DNR blog: %d fishing report posts in %d sitemaps' % (len(out), maps))
    return out


def slug_of(url):
    return url.rstrip('/').rsplit('/', 1)[-1]


def text_of(fragment):
    s = re.sub(r'(?is)<(script|style|noscript|svg|nav|header|footer|form|aside|figure).*?</\1>', ' ', fragment)
    s = re.sub(r'(?i)<br\s*/?>', '\n', s)
    s = re.sub(r'(?i)<h([1-6])[^>]*>', lambda m: '\n' + '#' * int(m.group(1)) + ' ', s)
    s = re.sub(r'(?i)</(p|div|h[1-6]|li|tr|section|article)>', '\n', s)
    s = re.sub(r'<[^>]+>', ' ', s)
    s = html.unescape(s)
    s = re.sub(r'[ \t ]+', ' ', s)
    return re.sub(r'\n\s*\n+', '\n', s).strip()


def fetch_post(url, timeout=40):
    h = _get(url, timeout)
    m = re.search(r'(?is)<div[^>]+class="[^"]*entry-content[^"]*"[^>]*>.*?(?=<footer|<div[^>]+class="[^"]*(?:sharedaddy|jp-relatedposts|entry-footer))', h) \
        or re.search(r'(?is)<article\b.*?</article>', h)
    body = text_of(m.group(0) if m else '')
    t = re.search(r'<title>([^<]*)</title>', h, re.I)
    y, mo, d = POST.search(url).groups()
    return {'url': url, 'slug': slug_of(url), 'title': html.unescape(t.group(1)).strip() if t else None,
            'published': '%s-%s-%s' % (y, mo, d), 'chars': len(body), 'text': body}


def temp_f(line):
    m = TEMP.search(line)
    if not m: return None
    a = int(m.group(2))
    a += {'low': 2, 'mid': 5, 'middle': 5, 'upper': 8, 'high': 8}.get((m.group(1) or '').lower(), 5)
    return a if 35 <= a <= 95 else None


def sections(text):
    """{slug: [lines]} for the three lakes in one post."""
    out, cur = {}, None
    for line in text.split('\n'):
        hit = next((s for s, rx in WATERS if rx.match(line)), None)
        if hit:
            cur = hit
            rest = WATERS[[s for s, _ in WATERS].index(hit)][1].sub('', line, count=1).strip(' -—–:')
            out.setdefault(cur, [])
            if len(rest) > 40: out[cur].append(rest)                  # "LAKE HARTWELL IS DOWN ... — Bass fishing ..."
            continue
        if HEADING.match(line) and not re.search(r'[a-z]', line):
            cur = None; continue
        if cur and line.strip(): out[cur].append(line.strip())
    return out


def statements(rec, slugs):
    """One post's statements for the waters in `slugs` (registry slugs: this run's water)."""
    date = rec.get('published') or ''
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', date): return []
    out = []
    for slug, lines in sections(rec.get('text') or '').items():
        if slug not in slugs: continue
        body = '\n'.join(l for l in lines if not K.WRAPPING.search(l) and not re.search(r'https?://|www\.|@\w+\.\w', l))
        t_f = next((temp_f(l) for l in lines if temp_f(l)), None)
        who = sorted(set(COURTESY.findall('\n'.join(lines))))
        for sp, lab, rating, t, about in C.parts(body):
            if K.WRAPPING.search(t): continue
            out.append({'source': 'GA-WRD', 'url': rec['url'], 'archived': None, 'date': date, 'dated_by': 'published',
                        'waters': [slug], 'water_from': 'heading', 'heading': rec.get('title'), 'species': sp,
                        'label': lab, 'rating': rating, 'about': about, 'text': t,
                        'who': sorted(set(C.who(t)) | set(w for w in who if w.split()[0] not in ('Region', 'The'))),
                        'water_temp_f_said': C.temp_f(t) or t_f})
    return out
