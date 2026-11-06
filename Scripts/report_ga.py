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
WATERS = [('hartwell_lake', re.compile(r'^\s*(?:#+\s*)?(?:LAKE HARTWELL|HARTWELL LAKE|HARTWELL)\b', re.I),
           re.compile(r'\bHartwell\b', re.I)),
          ('j_strom_thurmond_reservoir', re.compile(r'^\s*(?:#+\s*)?(?:CLARKS? HILL(?: LAKE)?|LAKE THURMOND|THURMOND LAKE|'
                                                    r'J\.? ?STROM THURMOND)\b', re.I),
           re.compile(r'\b(?:Clarks? Hill|Thurmond)\b', re.I)),
          ('richard_b_russell_lake', re.compile(r'^\s*(?:#+\s*)?(?:LAKE RUSSELL|RUSSELL LAKE|RICHARD B\.? RUSSELL)\b', re.I),
           re.compile(r'\bRussell\b', re.I))]
HEADING = re.compile(r"^\s*(?:#+\s*)?[A-Z][A-Z0-9 .,'’&/()-]{3,60}$")
# ANOTHER WATER'S LINE, in every form the posts have used (measured 11/6 on the re-save, all 646 posts): without these,
# Clarks Hill's section ran on through McDuffie PFA's ponds and Lake Oconee, Russell's through Sinclair and West Point,
# and Hartwell's through Lanier's guides. A line opening on one of the three lakes is matched by WATERS first.
_FISH = (r"(?:Bass|Striped|Stripers?|Crappie|Catfish|Cats|Linesides|Hybrids?|Bream|Spotted|Spots|Largemouth|Walleye|"
         r"Trout|White|Shoal|Black|Channel|Blue|Flathead|Redear|Shellcracker|Yellow|Perch|Sunfish)\b")
_NAME = r"[A-Z][\w.'’&-]+(?:\s+[A-Z][\w.'’&-]+)"
OTHER_WATER = re.compile("|".join([
    # "Lake Oconee (full, ...)", "Lake Weiss: ...", "Lake Lanier Fish Attractors : ..."
    r"^\s*(?:#+\s*)?Lake\s+" + _NAME + r"{0,3}\s*(?:\(|:|[–—-]\s)",
    # "Jackson Lake (down 2.3 feet ...)", "McDuffie PFA – Largemouth Bass: ...", "West Point Lake (..."
    r"^\s*(?:#+\s*)?(?!" + _FISH + r")" + _NAME + r"{0,4}\s+(?:Lake|Reservoir|PFA|WMA|Ponds?|River|Creek)\s*(?:\(|:|[–—-]\s)",
    # "LAKE OCONEE IS FULL, THE LAKE IS CLEAR ON THE SOUTH END ...", "LAKE ALLATOONA IS 2.1 FEET OVER FULL & 60S Bass :"
    r"^\s*(?:#+\s*)?[A-Z][A-Z.'’&-]+(?:\s+[A-Z][A-Z.'’&-]+){0,3}\s+IS\s+(?:DOWN|UP|FULL|OVER|AT|NEAR|\d|\.\d)",
    # "Lanier Stripers ( This report courtesy ...", "Lake Lanier Bass Report 1 ( ...", "Lake Lanier Bass Report : ..."
    r"^\s*(?:#+\s*)?(?:Lake\s+)?(?!" + _FISH + r")[A-Z][\w.'’-]+(?:\s+[A-Z][\w.'’-]+)?\s+" + _FISH
    + r"s?\s*(?:Report\s*\d*\s*)?(?:\(|:)",
    # "Chatuge Sampling Report ( ...", "Lanier Extras: ..."
    r"^\s*(?:#+\s*)?(?!" + _FISH + r")[A-Z][\w.'’-]+(?:\s+[A-Z][\w.'’-]+){0,3}\s+(?:Report|Extras)\s*\d*\s*(?:\(|:)",
    # "Burton is full pool, high 70s, and clear:", "Lake Allatoona is 0.7 over full, 72 F ...", "Carters Lake is full, ..."
    r"^\s*(?:#+\s*)?(?!(?:The|It|This|That|Water|Fishing|Everything|Level)\b)(?!" + _FISH + r")(?:Lake\s+)?[A-Z][\w.'’-]+"
    r"(?:\s+[A-Z][\w.'’-]+){0,2}\s+is\s+(?:full|down|up|over|near|at|about|\d|\.\d)\b[^.\n]{0,80}:\s*$",
    # "DODGE COUNTY PUBLIC FISHING AREA (near Eastman)", "ROCKY MOUNTAIN PUBLIC FISHING AREA ( report provided ..."
    r"^\s*(?:#+\s*)?[A-Z][A-Z.'’&-]+(?:\s+[A-Z][A-Z.'’&-]+){1,5}\s*\(",
    # a part of the post that is not a water: "Go Fish Pics : The Go Fish Education center ..."
    r"^\s*(?:#+\s*)?(?!" + _FISH + r")[A-Z][\w'’]+(?:\s+[A-Z][\w'’]+){1,4}\s+:\s",
]))
# A Georgia water named in a line of a lake's block, where that lake is not named: the block has run into the next
# water's part without a heading ("Largemouth numbers were good throughout Lake Chatuge.", a photo caption before
# Chatuge's report; "Nice striper caught on Lake Allatoona"). The waters of the blog's regions, measured 11/6.
OTHER_GA = re.compile(r"\b(?:Lanier|Allatoona|Carters|Chatuge|Nottely|Blue Ridge|Burton|Rabun|Seed Lake|Tugalo|Yonah|"
                      r"Oconee|Sinclair|Jackson Lake|Lake Jackson|West Point|Walter F\.? George|Eufaula|Seminole|Blackshear|"
                      r"Tobesofkee|High Falls|Weiss|Juliette|Varner|Big Lazer|McDuffie|Marben|Clybel|Rocky Mountain|"
                      r"Hugh M\.? Gillis|Dodge County|Evans County|Paradise|Amicalola|Okefenokee|Public Fishing Area|PFA)\b")
REGION = re.compile(r'^\s*(?:#+\s*)?(?:North|South|Central|East|West)(?:east|west)?\s+Georgia\s*$', re.I)
# "LAKE HARTWELL IS DOWN 7.4 FEET, 40'S", "CLARKS HILL IS DOWN 6.7 FEET, 50’S", "... FULL, MID 60'S"
TEMP = re.compile(r"(?:FEET|FT|FULL POOL|FULL|POOL)\b[^,\n]{0,20},\s*(?:CLEAR|STAINED|MUDDY|[A-Z]+,\s*)*"
                  r"(LOW|MID|MIDDLE|UPPER|HIGH)?\s*(\d{2})\s*['’]?\s*S\b", re.I)
LINK = re.compile(r'\S*(?:https?://|www\.)\S*|\S+@\w+\.\w\S*')
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


def blocks(text):
    """[(slug, lines)] for the three lakes in one post, one block a heading: a post can carry a lake twice (Russell
    under two regions, 2021-04-16), and a statement must not run from one block into the other. The heading's own words
    are the block's first line however short, so its temperature is read ("LAKE RUSSELL IS FULL, 70'S")."""
    out, cur = [], None
    for line in text.split('\n'):
        hit = next((s for s, rx, _ in WATERS if rx.match(line)), None)
        if hit:
            rest = WATERS[[w[0] for w in WATERS].index(hit)][1].sub('', line, count=1).strip(' -—–:')
            cur = (hit, [rest] if rest else [])
            out.append(cur)
            continue
        if (HEADING.match(line) and not re.search(r'[a-z]', line)) or OTHER_WATER.match(line) or REGION.match(line):
            cur = None; continue
        if cur and OTHER_GA.search(line) and not WATERS[[w[0] for w in WATERS].index(cur[0])][2].search(line):
            cur = None; continue
        if cur and line.strip(): cur[1].append(line.strip())
    return out


def sections(text):
    """{slug: [lines]} for the three lakes in one post, every block of a lake together."""
    out = {}
    for slug, lines in blocks(text): out.setdefault(slug, []).extend(lines)
    return out


def statements(rec, slugs):
    """One post's statements for the waters in `slugs` (registry slugs: this run's water)."""
    date = rec.get('published') or ''
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', date): return []
    out, seen = [], set()
    for slug, lines in blocks(rec.get('text') or ''):
        if slug not in slugs: continue
        # A link line, an address or the page's own wrapping is dropped, and the text is cut THERE, so a statement never
        # runs across the gap: "...exciting fishing." and the next lake's line had been one statement (11/6).
        # A line that carries a link inside it ("courtesy of Ken Sturdivant, www.southernfishing.com ) : Bass fishing is
        # good...", Hartwell from 2022) is cut at the link, and the words on either side are kept, each its own piece.
        chunks, cur_lines = [], []
        for l in lines:
            if K.WRAPPING.search(l):
                if cur_lines: chunks.append(cur_lines); cur_lines = []
                continue
            pieces = LINK.split(l)
            if len(pieces) == 1:
                cur_lines.append(l); continue
            if cur_lines: chunks.append(cur_lines); cur_lines = []
            pieces = [p.strip(' )(:;,–—-') for p in pieces]       # ") : Bass fishing is good" is "Bass fishing is good"
            chunks += [[p] for p in pieces[:-1] if p]
            if pieces[-1]: cur_lines = [pieces[-1]]
        if cur_lines: chunks.append(cur_lines)
        t_f = next((temp_f(l) for l in lines if temp_f(l)), None)
        who = sorted(set(COURTESY.findall('\n'.join(lines))))
        for sp, lab, rating, t, about in [x for ch in chunks for x in C.parts('\n'.join(ch))]:
            if K.WRAPPING.search(t): continue
            if (slug, K.NORM(t)) in seen: continue                 # the same words under the lake's second heading
            seen.add((slug, K.NORM(t)))
            out.append({'source': 'GA-WRD', 'url': rec['url'], 'archived': None, 'date': date, 'dated_by': 'published',
                        'waters': [slug], 'water_from': 'heading', 'heading': rec.get('title'), 'species': sp,
                        'label': lab, 'rating': rating, 'about': about, 'text': t,
                        'who': sorted(set(C.who(t)) | set(w for w in who if w.split()[0] not in ('Region', 'The'))),
                        'water_temp_f_said': C.temp_f(t) or t_f})
    return out
