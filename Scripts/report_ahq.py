"""report_ahq.py -- Angler's Headquarters' weekly posts: every SC water and every species, dated by the entry.

Personal use only, not for distribution or resale; not for navigation.

A post is one water's report ("AHQ INSIDER Lake Keowee (SC) 2023 Week 11 Fishing Report - Updated March 16") holding
dated entries, newest first ("March 16", "March 9", ...). A seasonal post carries every week of the season, so the
same entry is in many posts; each is kept once. Under each date the paragraphs are prose, a fish named in the first
sentence ("It's still a good catfish bite on Santee Cooper, and Captain Stevie English ..."), the next paragraphs
carrying on about it. The paragraphs are read by `report_column.parts()`, the same rule as the prose years of
SCDNR's column, which is AHQ's own text.

The post's water comes from its address, by the words of the water's registry names: the Worker's COMMON_WORDS
dropped, a trailing s ignored ("clarks-hill-ga-sc" is Clark Hill, J. Strom Thurmond Reservoir), and lakes only, as an
AHQ lake page is matched only to a lake. That is `nameTokens()` in Worker/guide-reports.js, which reads the same pages
at plan time, so the two agree.
Members-only teasers are kept as teasers and read as nothing (never signed in).

   fetch_post(url) -> the post's record, as fetch_ahq.py saves it
"""
import re, json, os, html, urllib.request
import report_column as sections

# Worker/guide-reports.js COMMON_WORDS, word for word: grammar and the kinds of water, not lakes.
COMMON = {'lake', 'lakes', 'reservoir', 'res', 'pond', 'river', 'creek', 'the', 'of', 'and', 'at', 'on', 'in',
          'fishing', 'report', 'reports', 'updates', 'update', 'most', 'detailed', 'system', 'area', 'north', 'south',
          'east', 'west', 'upper', 'lower', 'sc', 'ga', 'nc', 'tn', 'va', 'co', 'county', 'island', 'inlet', 'harbor',
          'bay', 'sound'}

def words(name):
    n = re.sub(r'\([^)]*\)', ' ', name)
    if ' - ' in n: n = n.split(' - ')[-1]                       # "Camp Creek - Lake Hartwell"
    n = re.sub(r',\s*[A-Z]{2}(/[A-Z]{2})*\s*$', '', n)
    return frozenset(w[:-1] if w.endswith('s') and len(w) > 3 else w
                     for w in re.findall(r'[a-z]+', n.lower()) if len(w) > 1 and w not in COMMON)

def water_index(names, kinds=None):
    """words -> registry slugs. With `kinds` ({slug: feature_type}), lakes only."""
    idx = {}
    for n, slugs in names.items():
        keep = [s for s in slugs if kinds is None or kinds.get(s) == 'lake']
        if keep: idx.setdefault(words(n), set()).update(keep)
    return idx

UA = {'User-Agent': 'Mozilla/5.0 (personal fishing app research; reading public reports)'}

def text_of(fragment):
    s = re.sub(r'(?is)<(script|style|noscript|svg).*?</\1>', ' ', fragment)
    s = re.sub(r'(?i)<br\s*/?>', '\n', s)
    s = re.sub(r'(?i)</(p|div|h[1-6]|li|tr|section|article)>', '\n', s)
    s = re.sub(r'<[^>]+>', ' ', s)
    s = html.unescape(s)
    s = re.sub(r'[ \t\u00a0]+', ' ', s)
    s = re.sub(r'\n\s*\n+', '\n\n', s)
    return s.strip()

def _meta(h, prop):
    m = re.search(r'<meta[^>]+(?:property|name)=["\']%s["\'][^>]+content=["\']([^"\']*)' % re.escape(prop), h, re.I)
    return html.unescape(m.group(1)) if m else None

def fetch_post(url, timeout=40):
    """One post, read as fetch_ahq.py reads it: the post's own text from Shopify's article__main section."""
    h = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read().decode('utf-8', 'replace')
    a = h.find('id="shopify-section-article__main"')
    b = h.find('id="shopify-section-', a + 10) if a >= 0 else -1
    body = text_of(h[a:b] if a >= 0 and b > a else (h[a:] if a >= 0 else ''))
    t = re.search(r'(?is)<time[^>]+datetime=["\']([^"\']+)', h)
    return {'url': url, 'slug': url.rstrip('/').split('/')[-1], 'title': _meta(h, 'og:title'),
            'published': _meta(h, 'article:published_time') or (t.group(1) if t else None),
            'chars': len(body), 'members_only_teaser': ('Exclusive Content' in body or len(body) < 1500), 'text': body}

POST = re.compile(r'^(?:ahq-insider-)?(.+?)-(?:sc|ga-sc|nc-sc|sc-ga|sc-nc)-')
# older addresses carry no state: "santee-cooper-fishing-report-updated-november-11"
POST_OLD = re.compile(r'^(?:ahq-insider-)?(.+?)-(?:fishing|bass|crappie|striper|catfish|supplemental|fall|spring|summer|winter|\d{4})-')
POST_INSIDE = re.compile(r'ahq-insider-(.+?)-(?:sc|ga-sc|nc-sc|sc-ga|sc-nc)-')   # "surprising-bass-news-...-ahq-insider-santee-cooper-sc-..." 

def post_water(rec, idx):
    m = POST_INSIDE.search(rec['slug']) or POST.match(rec['slug']) or POST_OLD.match(rec['slug'])
    if not m: return None, None
    s = idx.get(words(m.group(1).replace('-', ' ')))
    title = re.search(r'AHQ INSIDER\s+(.+?)\s*\((?:SC|GA|NC)', rec.get('title') or '')
    as_written = title.group(1) if title else m.group(1).replace('-', ' ')
    if not s: return None, as_written
    systems = [set(v) for v in sections.SYSTEMS.values()]
    return (sorted(s) if len(s) == 1 or s in systems else None), as_written

MON3 = {m[:3]: i for i, m in enumerate(['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
                                         'september', 'october', 'november', 'december'], 1)}

def entries(rec):
    """[(date, body)] newest first. The year is the post's own; walking down the post, a month later than the one
    before it means the entries have crossed back into the year before."""
    ym = re.search(r'(20\d\d)', rec.get('title') or '') or re.search(r'(20\d\d)', rec['slug'])
    year = int(ym.group(1)) if ym else None
    out, cur, body, prev_mo = [], None, [], None
    for line in [l.strip() for l in (rec.get('text') or '').split('\n')]:
        dm = re.fullmatch(r'(?:Updated\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,\s*(20\d\d))?', line)
        if dm and dm.group(1).lower()[:3] in MON3 and year:
            if cur and body: out.append((cur, '\n'.join(body)))
            mo = MON3[dm.group(1).lower()[:3]]
            if dm.group(3): year = int(dm.group(3))
            elif prev_mo is not None and mo > prev_mo: year -= 1
            prev_mo = mo
            cur, body = '%04d-%02d-%02d' % (year, mo, int(dm.group(2))), []
            continue
        if cur and line:
            body.append(line)
    if cur and body: out.append((cur, '\n'.join(body)))
    return out

def statements(rec, idx):
    if rec.get('members_only_teaser') or not rec.get('text'): return []
    water, as_written = post_water(rec, idx)
    out = []
    for date, body in entries(rec):
        t_f = sections.temp_f(body)
        for sp, lab, rating, t, about in sections.parts(body):
            out.append({'source': 'AHQ', 'url': rec['url'], 'archived': None, 'date': date, 'dated_by': 'entry date',
                        'waters': water or [], 'water_from': 'source page' if water else 'none', 'heading': as_written,
                        'species': sp, 'label': lab, 'rating': rating, 'about': about, 'text': t, 'who': sections.who(t),
                        'water_temp_f_said': t_f})
    return out
