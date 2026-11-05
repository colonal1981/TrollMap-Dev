"""report_cs.py -- Carolina Sportsman: its articles about one SC water, and its "S.C. freshwater fishing report" roundups.

Personal use only, not for distribution or resale; not for navigation.

Two shapes, both prose:
  - A FEATURE is about one water ("Fishing for striped bass and hybrids on South Carolina's Clarks Hill Lake", 2017):
    its address names the water, and a guide is quoted at length. The paragraphs are read by report_column.parts(),
    the rule for AHQ's and SCDNR's prose: a fish named in the first sentence, the next paragraphs carrying on about
    it. Its water is the article's (`water_from: source page`). A paragraph that names another SC water and not this
    one is that water's, and is left out.
  - A ROUNDUP ("S.C. freshwater fishing report - what's biting right now", 2019) gives a paragraph to each water,
    named in it ("On Clarks Hill Lake, William Sasser Guide Service is catching limits of stripers ..."). Each
    paragraph stands alone (`water_from: named`): a fish is not carried from one lake's paragraph into the next.

Left out of both: the photo captions (one sentence, as in "Stripers and hybrids are plentiful on Clarks Hill Lake, and
they're feeding heavily, especially right at daybreak."), the magazine's sidebars (HOW TO GET THERE, GUIDES, ...),
headings, the "Click here ..." lines and the tag list at the foot.

Dated by the article's publish time (`dated_by: published`). The site's robots.txt allows reading (11/5), and an
article's text is what a visitor who is not signed in is shown (checked 11/5 against the rendered page).

   article_urls(get)           -> every post address the site's own post sitemaps list, with its lastmod
   slug_index(names, idx)      -> how an address names an SC water
   waters_of_slug(slug, sidx)  -> the SC water an address names, or none
   fetch_article(url)          -> the article's record, as fetch_cs_santee.py saves it
   statements(rec, waters, names, name_rx) -> [statement rows] in report_ahq's shape
"""
import html, re, urllib.request
import report_column as C
import report_ahq as A
import report_contract as K

SITEMAP = 'https://www.carolinasportsman.com/sitemap_index.xml'
UA = {'User-Agent': 'Mozilla/5.0 (personal fishing app research; reading public articles)'}
ROUNDUP = re.compile(r'(?:^|-)(?:s-c|sc|south-carolina)-(?:[a-z]+-){0,3}freshwater-fishing-report(?:-|$)')
# A photo's caption in the middle of a feature, credited: "(Photo by Terry Madewell)", "(Picture by Pat Robertson)".
CAPTION = re.compile(r'\((?:photos?|pictures?)\b[^)]*\)\s*$|\bphotos? (?:by|courtesy)\b', re.I)
# The site's sections that hold fishing: not hunting, not the coast, not announcements or the magazine's sidebars.
KEEP_PATH = re.compile(r'^(?:fishing(?!/(?:inshore|offshore|saltwater))|featured|features|featured-story|content|columns|'
                       r'fishing-hotspots|field-reports/fishing-reports|general)(?:/|$)')
SIDEBAR = re.compile(r'(?:HOW TO GET THERE|GUIDES?/|GUIDES? AND|GUIDES?:|ACCOMMODATIONS|MAPS?\b|WHERE TO STAY|FISHING INFO|'
                     r'BEST TIME|TACKLE/|TACKLE AND|INFO/)')


def _get(url, timeout=60):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read().decode('utf-8', 'replace')


def article_urls(get=_get, pause=1.0, sleep=None, log=print):
    """[(url, lastmod)] for every post in the site's post sitemaps."""
    import time
    sleep = sleep or time.sleep
    strip = lambda s: re.sub(r'<!\[CDATA\[|\]\]>', '', s)
    maps = [u for u in re.findall(r'<loc>\s*([^<\s]+)\s*</loc>', strip(get(SITEMAP))) if 'post-sitemap' in u]
    out = []
    for m in maps:
        sm = strip(get(m))
        for block in re.findall(r'(?s)<url>(.*?)</url>', sm):
            loc = re.search(r'<loc>\s*([^<\s]+)\s*</loc>', block)
            mod = re.search(r'<lastmod>\s*([^<\s]+)\s*</lastmod>', block)
            if loc: out.append((loc.group(1), mod.group(1) if mod else ''))
        sleep(pause)
    log('   Carolina Sportsman: %d posts in %d sitemaps' % (len(out), len(maps)))
    return out


def slug_of(url):
    return url.rstrip('/').split('/')[-1]


def section_of(url):
    """"fishing/freshwater-fishing" for .../fishing/freshwater-fishing/<slug>/."""
    return '/'.join(url.split('carolinasportsman.com/', 1)[-1].strip('/').split('/')[:-1])


def wanted(url):
    return bool(KEEP_PATH.match(section_of(url)))


def plain_names(names):
    """The registry's names, with each name's own bracket dropped as well ("congaree river (to sc-601)" is also
    "congaree river"): the article says "the Congaree River". A plain name that is already a water's own name stays
    that water's ("saluda river"); two bracketed names left with one plain name share it, and a shared name counts
    for neither (`waters_named`)."""
    out = {k: list(v) for k, v in names.items()}
    for k, v in names.items():
        p = re.sub(r'\s*\([^)]*\)\s*', ' ', k).strip()
        if not p or p == k or p in names: continue
        out.setdefault(p, [])
        for x in v:
            if x not in out[p]: out[p].append(x)
    return out


BIG_ACRES = 5000   # a lake this big is called by its one word ("Wateree", "Murray", "Clarks Hill"); a pond is not


def slug_index(names, idx):
    """How an address names an SC water: by a water's whole name ("lake-secession", "wateree-river",
    "fishing-creek-reservoir"), or for a big lake by its own words alone ("murray", "clarks-hill"). Lakes and rivers
    by whole name; only a big lake by its one word, because "hunt", "mays", "five" and "forest" are Hunt Pond, Mays
    Lake, Pond Five and Forest Lake in the registry and plain words in an address."""
    phrases, words = {}, {}
    for n, slugs in names.items():
        ph = re.sub(r'[^a-z0-9]+', '-', n).strip('-')
        if ph: phrases.setdefault(ph, set()).update(slugs)
        for x in slugs:
            row = idx.get(x) or {}
            if row.get('feature_type') == 'lake' and (row.get('area_acres') or 0) >= BIG_ACRES:
                w = A.words(n)
                if w: words.setdefault(w, set()).add(x)
    return phrases, words


def waters_of_slug(slug, sidx):
    """The SC waters an article's address names (`slug_index`). One water, or one of the sources' pairs
    ("santee-cooper"); otherwise none, so an article about two waters is not given to either. "wateree-river-stripers"
    is the Wateree River's: a whole name is read first and its words are not read again."""
    phrases, wordsidx = sidx
    s = '-' + slug.lower() + '-'
    hits = set()
    for ph in sorted(phrases, key=len, reverse=True):
        if '-' + ph + '-' in s:
            hits |= phrases[ph]; s = s.replace('-' + ph + '-', '-~-')
    words = [w for w in s.split('-') if w and w != '~']
    for n in range(4, 0, -1):
        for i in range(len(words) - n + 1):
            key = A.words(' '.join(words[i:i + n]))
            if key and key in wordsidx:
                hits |= wordsidx[key]
    if len(hits) == 1 or any(hits == set(v) for v in C.SYSTEMS.values()):
        return sorted(hits)
    return []


def text_of(fragment):
    s = re.sub(r'(?is)<(script|style|noscript|svg|nav|header|footer|form|aside).*?</\1>', ' ', fragment)
    s = re.sub(r'(?i)<br\s*/?>', '\n', s)
    s = re.sub(r'(?i)</(p|div|h[1-6]|li|tr|section|article)>', '\n', s)
    s = re.sub(r'<[^>]+>', ' ', s)
    s = html.unescape(s)
    s = re.sub(r'[ \t ]+', ' ', s)
    return re.sub(r'\n\s*\n+', '\n\n', s).strip()


def fetch_article(url, timeout=40):
    """One article, read as fetch_cs_santee.py reads it: the <article> element's text."""
    h = _get(url, timeout)
    m = re.search(r'(?is)<article\b.*?</article>', h) or re.search(r'(?is)<main\b.*?</main>', h)
    body = text_of(m.group(0) if m else '')
    pub = re.search(r'article:published_time["\'][^>]+content=["\']([^"\']+)', h)
    t = re.search(r'<title>([^<]*)</title>', h, re.I)
    return {'url': url, 'slug': slug_of(url), 'title': html.unescape(t.group(1)).strip() if t else None,
            'published': pub.group(1) if pub else None, 'chars': len(body), 'text': body}


def name_rx(names):
    """Any SC water's registry name inside running text, longest first."""
    alts = sorted(names, key=len, reverse=True)
    return re.compile(r"(?<![A-Za-z])(" + '|'.join(re.escape(n).replace(r'\ ', r'\s+') for n in alts) + r")(?![A-Za-z])",
                      re.I)


def waters_named(text, names, rx):
    """The registry waters a paragraph names. A name two registry waters share counts for neither (the column's
    rule), except one of the sources' pairs."""
    out = set()
    for m in rx.finditer(text):
        key = re.sub(r'\s+', ' ', m.group(1).replace('’', "'")).lower()
        slugs = names.get(key) or []
        if len(slugs) == 1 or key in C.SYSTEMS:
            out |= set(slugs)
    return out


NAMED_AT_LEAST = 2   # times an article's own text names its water; an address can name a water the article is not about


def times_named(text, waters, names, rx):
    """How often the text names one of `waters` by a registry name."""
    n = 0
    for m in rx.finditer(text or ''):
        key = re.sub(r'\s+', ' ', m.group(1).replace('’', "'")).lower()
        if set(names.get(key) or []) & set(waters): n += 1
    return n


def _ends(l):
    return bool(re.search(r'[.!?"”’)]\s*$', l))


def paragraphs(text, roundup=False):
    """The article's own lines, in order: no headings, sidebars, links or tags, and no photo captions.
    A feature opens on its lead photo's caption and then its subtitle ("Shannon Suttle said Clarks Hill Lake is
    Slab City in January." / "Big crappie feed heavily all winter on Clarks Hill Lake"): what comes before the
    subtitle is dropped. A roundup also puts a caption after each lake's paragraph, one sentence of its own, and
    those are dropped too. A line with no full stop at its end is kept here as a heading (`statements` reads a
    roundup's "Lake Wateree" from it) and is not a statement."""
    lines = []
    for l in (text or '').split('\n'):
        l = re.sub(r'\s+', ' ', l).strip()
        # The site's sign-in gate, printed under every article and shown to no visitor of a public one; the topic
        # tags come after it ("April 2018", "Bass", "Lake Murray").
        if re.match(r'(?i)unlock this page\b', l): break
        if l: lines.append(l)
    head = next((i for i, l in enumerate(lines[:5]) if not _ends(l) and len(l) < 140), None)
    if head is not None: lines = lines[head + 1:]
    seen, out = set(), []
    for l in lines:
        if l.startswith('#') or l.startswith('* ') or re.match(r'(?i)click here\b', l): continue
        if SIDEBAR.match(l) or l in seen or K.WRAPPING.search(l): continue
        if CAPTION.search(l): continue                 # "... at Lake Wateree. (Photo by Terry Madewell)"
        seen.add(l)
        if roundup and _ends(l) and len(l) < 160 and not l.startswith(('“', '"')) \
                and len(re.findall(r'[.!?](?=\s)', l)) == 0:
            continue                                   # a roundup's caption: one sentence of its own
        out.append(l)
    return out


def statements(rec, waters, names, rx):
    """`waters`: the article's own water (a feature), or None for a roundup."""
    date = (rec.get('published') or '')[:10]
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', date): return []
    roundup = waters is None
    # [(waters, [paragraph, ...])]: a feature is one group; a roundup is a group per water, by the water a paragraph
    # names or the heading above it ("Lake Wateree"), and a fish is not carried from one lake's group to the next.
    groups, cur = [], None
    for p in paragraphs(rec.get('text'), roundup):
        named = waters_named(p, names, rx)
        if not _ends(p):                              # a heading
            if roundup: cur = sorted(named) if len(named) == 1 or named in [set(v) for v in C.SYSTEMS.values()] \
                else None
            continue
        if roundup:
            ws = sorted(named) if named else cur
            if not ws: continue
        else:
            if named and not named & set(waters): continue      # another water's paragraph
            ws = list(waters)
        if groups and groups[-1][0] == ws: groups[-1][1].append(p)
        else: groups.append((ws, [p]))
    out = []
    for ws, paras in groups:
        for sp, lab, rating, t, about in C.parts('\n'.join(paras)):
            out.append({'source': 'CS', 'url': rec['url'], 'archived': None, 'date': date, 'dated_by': 'published',
                        'waters': ws, 'water_from': 'named' if roundup else 'source page',
                        'heading': rec.get('title'), 'species': sp, 'label': lab, 'rating': rating, 'about': about,
                        'text': t, 'who': C.who(t), 'water_temp_f_said': C.temp_f(t)})
    return out
