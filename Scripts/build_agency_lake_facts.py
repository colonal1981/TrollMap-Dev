#!/usr/bin/env python3
"""
registry/agency_lake_facts.json -- what the state agencies already publish about our waters.

WHY THIS EXISTS. Ryan, 2026-08-27: "whatever the refactor looks like when we are done those
pages need to be included in it for the data they provide to smart plan."

TWRA publishes a page per East Tennessee reservoir and GA DNR publishes a fishing forecast per
Georgia lake. build_regulations_table.py already opens all eleven TWRA pages and reads exactly
one <ul> out of each -- the Regulations section -- and opens none of Georgia's, because Georgia
publishes no per-lake freshwater regulations. THE REST OF THOSE PAGES IS WHAT THE RESEARCH
AGENTS ARE CURRENTLY BEING SENT TO INVENT: surface acres, shoreline miles, full pool elevation,
winter drawdown, the depth oxygen fails at, the forage base, and per-species seasonal tactics.

RESEARCH_REFACTOR_SCOPE_2026-08-27.md keeps `trollingIntelligence` in the STORE bucket on the
grounds that "no feed publishes it and no geometry implies it". These pages are that feed, on
the waters they cover. They do not cover the card, so the bucket does not move -- but where an
agency has already written the answer, an agent should not be asked for it.

NOTHING HERE IS AN LLM. It is stdlib html.parser over saved pages, the same reader
build_regulations_table.py uses, and it imports that script's name map rather than growing a
second one -- Tennessee has two Davy Crockett Lakes and their rules differ, so the county-aware,
exact-match-only resolver is not optional.

WHAT THIS DOES NOT DO. It does not overwrite anything. Every number it finds is recorded beside
the number we already hold, with the difference, and a disagreement is reported rather than
resolved. See the surface-acres note in main() -- the two sources measure different things and
using them interchangeably would be the bug this file exists to avoid.

Personal use only, not for distribution or resale; not for navigation.
"""
import argparse, glob, json, os, re, sys, unicodedata
from datetime import date, datetime
from html.parser import HTMLParser

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
import build_regulations_table as REG   # norm, slugify, load_index, build_name_map, resolve

norm, slugify = REG.norm, REG.slugify

# Structural tags only. Anything else is inline and is flattened into the block it sits in.
BLOCK = {'p', 'li', 'h1', 'h2', 'h3', 'h4', 'td', 'th'}
SKIP = {'script', 'style', 'noscript', 'svg', 'head', 'nav', 'select', 'option', 'button'}


class _Blocks(HTMLParser):
    """The page as an ordered list of (tag, text, bold) blocks.

    BOLD IS STRUCTURE ON THE TWRA PAGES. They mark each species inside `What you can catch`
    as `<p><strong>Black Bass</strong></p>` -- there is no heading tag to key on, and keying on
    "a short paragraph" instead picks up `Fishing Tips:` and every photo caption. A block is
    recorded as bold only when the WHOLE of its text is inside <strong>/<b>, so a sentence with
    one bold word in it is still a sentence.
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.blocks = []
        self._stack = []          # open block tags
        self._buf = []            # [(text, bold_depth>0)]
        self._skip = 0
        self._bold = 0

    def handle_starttag(self, tag, attrs):
        if tag in SKIP:
            self._skip += 1
            return
        if self._skip:
            return
        if tag in ('strong', 'b'):
            self._bold += 1
        elif tag == 'br':
            self._buf.append((' ', self._bold > 0))
        elif tag in BLOCK:
            self._flush()
            self._stack.append(tag)

    def handle_endtag(self, tag):
        if tag in SKIP:
            self._skip = max(0, self._skip - 1)
            return
        if self._skip:
            return
        if tag in ('strong', 'b'):
            self._bold = max(0, self._bold - 1)
        elif tag in BLOCK:
            self._flush()
            if self._stack and self._stack[-1] == tag:
                self._stack.pop()
            elif tag in self._stack:
                while self._stack and self._stack.pop() != tag:
                    pass

    def handle_data(self, data):
        if not self._skip and data:
            self._buf.append((data, self._bold > 0))

    def _flush(self):
        if not self._buf:
            return
        raw = ''.join(t for t, _ in self._buf)
        text = norm(raw)
        if text:
            bold_txt = norm(''.join(t for t, b in self._buf if b))
            self.blocks.append({'tag': self._stack[-1] if self._stack else 'p',
                                'text': text, 'bold': bool(bold_txt) and bold_txt == text})
        self._buf = []

    def close(self):
        self._flush()
        super().close()


def blocks_of(path):
    s = open(path, encoding='utf-8', errors='replace').read()
    p = _Blocks()
    p.feed(s)
    p.close()
    return p.blocks, s


# ─────────────────────────────────────────────────────────────────────────────────────────────
# THE MEASURES, and the sentence each one came out of
# ─────────────────────────────────────────────────────────────────────────────────────────────
#
# Every measure keeps the sentence. A number without its sentence cannot be checked by a person
# and cannot be re-read when the page changes; `30,300 surface acres` and `impounds 30,300 acres
# at winter pool` are different facts and only the sentence tells them apart.

# TWRA spells small numbers: "the annual drawdown is only six vertical feet". A digits-only
# reader silently drops the water rather than reporting it, which is the worse of the two.
WORD_NUM = {'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6, 'seven': 7,
            'eight': 8, 'nine': 9, 'ten': 10, 'eleven': 11, 'twelve': 12, 'fifteen': 15,
            'twenty': 20, 'thirty': 30, 'forty': 40, 'fifty': 50, 'sixty': 60}

MEASURES = [
    ('surface_acres', 'acres', re.compile(
        r'([\d,]{3,9})[\s-]*(?:surface[\s-]*)?acres?\b', re.I)),
    ('shoreline_miles', 'miles', re.compile(
        r'([\d,]{1,6})\s*miles\s+of\s+shoreline', re.I)),
    # Two shapes, both general. TWRA writes the boundary as the operator's holding -- "TVA owns
    # up to the 1,075-ft. elevation mark" -- and the pool as a plain elevation -- Douglas's
    # "the summer elevation of 1000 feet above sea level". A reader that took only the first
    # found this number on one page of nine while a second page printed it plainly.
    ('full_pool_ft', 'ft above sea level', re.compile(
        r'(?:owns?|up\s+to|full\s+pool\s+(?:elevation\s+)?(?:of|is|at))\s*(?:up\s+to\s*)?'
        r'(?:the\s*)?([\d,]{3,5}(?:\.\d+)?)[\s-]*(?:ft|feet)\.?\s*'
        r'(?:elevation|contour|mark|msl)'
        r'|(?:summer\s+|full[\s-]pool\s+)?elevation\s+of\s+([\d,]{3,5}(?:\.\d+)?)\s*'
        r'(?:ft|feet)\.?\s*(?:above\s+sea\s+level|msl)', re.I)),
    # THE SAME FACT, FOUR SENTENCES. Cherokee writes "Drawdowns of up to 40 feet", Fort Loudoun
    # "the annual drawdown is only six vertical feet", Douglas "can fluctuate 60 feet from the
    # summer elevation", Watauga "fluctuate as much as 44 feet between the summer full pool and
    # the winter draw-down period". One pattern over the four shapes, and the spelled numbers,
    # rather than four patterns over four lakes -- a regex per water is a hand-written table
    # wearing a regex.
    ('drawdown_ft', 'ft', re.compile(
        r'(?:draw[\s-]?downs?|fluctuates?|fluctuation)\b[^.]{0,60}?'
        r'\b(\d{1,3}|' + '|'.join(WORD_NUM) + r')\b\s*(?:vertical\s+)?(?:feet|ft)\b', re.I)),
    ('anoxic_below_ft', 'ft', re.compile(
        r'(?:below|deeper\s+than|around)\s+(?:about\s+)?([\d,]{1,4})\s*(?:to\s+[\d,]{1,4}\s*)?'
        r'(?:feet|ft)\.?\s*(?:can\s+become|may\s+become|become|are|is|drop)', re.I)),
]

SENTENCE = re.compile(r'(?<=[.!?])\s+(?=[A-Z(])')


# A CONCEPT MENTIONED AND NOT PARSED MUST BE VISIBLE. Four of nine TWRA pages talk about
# summer stratification and only Cherokee states the depth; two talk about elevation without
# giving one. If those pages simply came out empty they would be indistinguishable from pages
# that say nothing, and the next reader would conclude the agency does not publish it. So each
# measure carries the words that would have signalled it, and the build reports the gap.
MENTIONS = {
    'surface_acres': re.compile(r'\bacres?\b', re.I),
    'shoreline_miles': re.compile(r'\bshoreline\b', re.I),
    'full_pool_ft': re.compile(r'\bfull pool\b|\belevation\b|\bft\.?\s*(?:msl|contour)\b', re.I),
    'drawdown_ft': re.compile(r'\bdraw[\s-]?downs?\b|\bfluctuat', re.I),
    'anoxic_below_ft': re.compile(r'\boxygen\b|\banoxic\b|\bstratif', re.I),
}


def mentioned(paras):
    blob = ' '.join(paras)
    return {k for k, rx in MENTIONS.items() if rx.search(blob)}


def sentence_with(text, match):
    """The one sentence the number sits in, not the whole paragraph."""
    pos, cur = match.start(), 0
    for s in SENTENCE.split(text):
        if cur <= pos < cur + len(s) + 1:
            return s.strip()
        cur += len(s) + 1
    return text.strip()


def measures_in(paras):
    out = {}
    for para in paras:
        for key, units, rx in MEASURES:
            if key in out:
                continue
            m = rx.search(para)
            if not m:
                continue
            g = next((x for x in m.groups() if x), None)
            if g is None:
                continue
            try:
                v = float(g.replace(',', ''))
            except ValueError:
                v = WORD_NUM.get(g.lower())
                if v is None:
                    continue
                v = float(v)
            out[key] = {'value': int(v) if v == int(v) and key != 'full_pool_ft' else v,
                        'units': units, 'text': sentence_with(para, m)}
    return out


# ─────────────────────────────────────────────────────────────────────────────────────────────
# TENNESSEE -- TWRA per-reservoir pages
# ─────────────────────────────────────────────────────────────────────────────────────────────
#
# Shape: <h1> name, overview <p>s, <h2>Regulations, <h2>What you can catch, then a bold <p> per
# species followed by its prose, then a "Common Length at Age" table.
#
# THE REGULATIONS SECTION IS DELIBERATELY NOT READ HERE. build_regulations_table.py owns it and
# already publishes it into registry/regulations_table.json. Reading it twice into two files is
# how one fact becomes two facts that disagree.

TIPS = re.compile(r'^Fishing Tips\s*:?\s*$', re.I)
NOISE = re.compile(r'^(Print This Page|Go to |Skip to |Back to top|Powered by|Section$|'
                   r'Fish Identification Page|Ignore Open|Open the relevance|The Relevance)', re.I)
# The agency's own typos are load-bearing: Tellico and Watauga both print "Common Lenght at
# Age", Boone prints "Common Lengths at Varying Ages". Matching the exact string let that
# table's heading through as a species on three of eleven pages. The table itself is not
# read -- nothing in the app consumes growth-at-age, and an extracted object with no reader
# is the thing this refactor is deleting 214 of.
AGE_TABLE = re.compile(r'Common\s+Leng\w*\s+at\b', re.I)


def tn_page(blocks):
    h1 = next((b['text'] for b in blocks if b['tag'] == 'h1'), None)
    i_h1 = next((n for n, b in enumerate(blocks) if b['tag'] == 'h1'), 0)
    h2s = [n for n, b in enumerate(blocks) if b['tag'] == 'h2']
    i_regs = next((n for n in h2s if blocks[n]['text'].lower() == 'regulations'), None)
    i_catch = next((n for n in h2s if 'what you can catch' in blocks[n]['text'].lower()), None)

    end = i_regs if i_regs is not None else (i_catch if i_catch is not None else len(blocks))
    overview = [b['text'] for b in blocks[i_h1 + 1:end]
                if b['tag'] == 'p' and len(b['text']) > 60 and not NOISE.match(b['text'])]

    species, tail = [], []
    if i_catch is not None:
        cur = None
        for b in blocks[i_catch + 1:]:
            t = b['text']
            if b['tag'] in ('h2', 'h1') or AGE_TABLE.search(t):
                break
            if NOISE.match(t):
                continue
            if b['bold'] and b['tag'] == 'p' and len(t) < 60 and not TIPS.match(t):
                cur = {'name': t.rstrip(':'), 'notes': [], 'tips': []}
                species.append(cur)
                tail = cur['notes']
                continue
            if cur is None or len(t) < 40:
                if TIPS.match(t) and cur is not None:
                    tail = cur['tips']
                continue
            tail.append(t)
    return {'name': (h1 or '').replace(' in Tennessee', '').strip(),
            'overview': overview, 'species': species}


# ─────────────────────────────────────────────────────────────────────────────────────────────
# GEORGIA -- GA DNR fishing forecasts
# ─────────────────────────────────────────────────────────────────────────────────────────────
#
# Shape: <h1>Fishing Forecast - Lake X, a date, <h2>Overview, then one <h2>Lake X - Species per
# species, then <h2>Lake X - Additional Information. Inside a species section the agency writes
# three labelled paragraphs, and the labels ARE the schema:
#
#   Prospect:   this year's abundance and size structure, from spring sampling
#   Technique:  what to throw, by season
#   Target:     where the fish are, by season and depth
#
# `Target` is the closest thing to trollingIntelligence anyone publishes: named points, named
# depth ranges, named seasons, written by the biologist who sampled the lake.

GA_TITLE = re.compile(r'^\s*Fishing\s+Forecast\s*[-–—]\s*', re.I)
GA_LABEL = re.compile(r'^(Prospect|Technique|Target)\s*:\s*(.*)$', re.I | re.S)
# "Best Bets" on 30 pages, "Best Bests" on Lake Rabun. The agency's typo is not a reason to miss
# a lake's own summary of what it is worth fishing for.
BEST_BETS = re.compile(r'^Best\s+Be[sd]?ts?\s*:\s*(.+)$', re.I)
GA_DATE = re.compile(r'^([A-Z][a-z]+\s+\d{1,2},\s+\d{4})$')


def ga_page(blocks):
    h1 = next((b['text'] for b in blocks if b['tag'] == 'h1'), '')
    name = GA_TITLE.sub('', h1).strip()
    i_h1 = next((n for n, b in enumerate(blocks) if b['tag'] == 'h1'), 0)
    published = next((b['text'] for b in blocks[i_h1:i_h1 + 4] if GA_DATE.match(b['text'])), None)

    h2s = [n for n, b in enumerate(blocks) if b['tag'] == 'h2'] + [len(blocks)]
    overview, best_bets, species, extra = [], [], [], []
    for a, z in zip(h2s, h2s[1:]):
        head = blocks[a]['text'] if a < len(blocks) else ''
        body = [b['text'] for b in blocks[a + 1:z]
                if b['tag'] in ('p', 'li') and not NOISE.match(b['text'])]
        low = head.lower()
        if low == 'overview':
            for t in body:
                m = BEST_BETS.match(t)
                if m:
                    best_bets = [x.strip() for x in re.split(r',|\band\b', m.group(1)) if x.strip()]
                elif len(t) > 60:
                    overview.append(t)
        elif 'additional information' in low:
            extra += [t for t in body if len(t) > 60]
        else:
            # "Lake Hartwell - Hybrid & Striped Bass" -> "Hybrid & Striped Bass"
            sp = re.sub(r'^\s*' + re.escape(name) + r'\s*[-–—]\s*', '', head).strip()
            rec = {'name': sp or head, 'prospect': [], 'technique': [], 'target': [], 'notes': []}
            bucket = rec['notes']
            for t in body:
                m = GA_LABEL.match(t)
                if m:
                    bucket = rec[m.group(1).lower()]
                    t = m.group(2).strip()
                if len(t) > 60:
                    bucket.append(t)
            if any(rec[k] for k in ('prospect', 'technique', 'target', 'notes')):
                species.append(rec)
    return {'name': name, 'published': published, 'overview': overview,
            'best_bets': best_bets, 'species': species, 'additional_information': extra}


# ─────────────────────────────────────────────────────────────────────────────────────────────
# CROSS-CHECK -- record, never resolve
# ─────────────────────────────────────────────────────────────────────────────────────────────

def held_values(registry, slug, idx):
    """What we already hold for this water, from the two registries that carry these numbers."""
    out = {}
    row = idx.get(slug) or {}
    if isinstance(row.get('area_acres'), (int, float)):
        out['surface_acres'] = {'value': float(row['area_acres']),
                                'from': 'lake_index.json area_acres'}
    p = os.path.join(registry, 'full_pool.json')
    if os.path.exists(p):
        fp = json.load(open(p, encoding='utf-8'))
        r = (fp.get('rows') or {}).get(slug) or {}
        if isinstance(r.get('full_pool_ft'), (int, float)):
            out['full_pool_ft'] = {'value': float(r['full_pool_ft']),
                                   'from': 'full_pool.json %s' % (r.get('source') or 'unsourced')}
    return out


def granularity(v):
    """The step the published figure was rounded to, read off the figure itself.

    `38,000 acres` and `3,600 acres` are not precise to the acre and comparing them to a polygon
    measured to a tenth produces a difference that is entirely the agency's rounding. The number
    says how coarse it is -- count its trailing zeros -- so no threshold has to be invented.
    """
    n = int(abs(v))
    if n == 0:
        return 1
    g = 1
    while n % (g * 10) == 0 and g < 10000:
        g *= 10
    return g


def cross_check(measures, held):
    """Attach `held`, the signed difference, and nothing else.

    DELIBERATELY NOT A VERDICT. Two sources disagreeing is a fact about the sources; deciding
    which wins is a decision, and this script does not get to make it. `full_pool.json` already
    proved the value of the shape -- Cherokee's TWRA page says TVA owns to 1,075 ft and the
    registry, read independently off lakelvl, says 1075.0. Corroboration is worth as much as
    conflict and the same record carries both.
    """
    for key, m in measures.items():
        h = held.get(key)
        if not h:
            m['cross_check'] = None
            continue
        ours, theirs = h['value'], float(m['value'])
        g = granularity(theirs)
        m['cross_check'] = {
            'held': ours, 'held_from': h['from'],
            'agency_minus_held': round(theirs - ours, 3),
            'pct_of_held': round(100.0 * (theirs - ours) / ours, 1) if ours else None,
            'identical': abs(theirs - ours) < 0.05,
            # The agency rounds. A difference inside half its own step is not a disagreement.
            'agency_rounded_to': g,
            'within_agency_rounding': abs(theirs - ours) <= g / 2.0,
        }
    return measures


def source_url(raw_html):
    """The URL the page was saved from. A snapshot without its address cannot be refreshed, and
    a stale agency page is worse than no agency page because it looks current."""
    m = re.search(r'saved from url=\(\d+\)(\S+?)\s*-->', raw_html)
    if m:
        return m.group(1)
    m = re.search(r'<meta\s+name="url"\s+content="([^"]+)"', raw_html, re.I)
    return m.group(1) if m else None


def saved_at(path):
    try:
        return datetime.utcfromtimestamp(os.path.getmtime(path)).date().isoformat()
    except OSError:
        return None


SOURCES = [
    {'state': 'TN', 'agency': 'TWRA', 'dir': 'Tennessee_Lakes', 'reader': 'tn'},
    {'state': 'GA', 'agency': 'GA DNR', 'dir': 'Georgia_Lakes', 'reader': 'ga'},
]


def read_one(path, spec, name_map):
    blocks, raw = blocks_of(path)
    page = tn_page(blocks) if spec['reader'] == 'tn' else ga_page(blocks)
    # TWRA's <h1> and its filename disagree on Calderwood -- "Calderwood Reservoir" against
    # "Calderwood Lake" -- so both are offered to the resolver and the first exact match wins.
    fallback = os.path.basename(path).split(' in Tennessee')[0].strip()
    slug = None
    for cand in (page.get('name'), fallback):
        if cand:
            slug = REG.resolve(cand, name_map)
            if slug:
                break
    return slug, page, raw


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--root', default='.', help='the pipeline root holding the page folders')
    ap.add_argument('--registry', default=None, help='default <root>/registry')
    ap.add_argument('--out', default=None, help='default <registry>/agency_lake_facts.json')
    a = ap.parse_args()
    root = os.path.abspath(a.root)
    registry = a.registry or os.path.join(root, 'registry')
    out = a.out or os.path.join(registry, 'agency_lake_facts.json')

    idx = REG.load_index(registry)
    if not idx:
        print('!! no lake_index.json under %s -- nothing can be resolved' % registry)
        return 2
    name_map = REG.build_name_map(idx)

    rows, unmatched, pages = {}, [], 0
    for spec in SOURCES:
        d = os.path.join(root, spec['dir'])
        files = sorted(glob.glob(os.path.join(d, '*.html')))
        print('%s: %d page(s) under %s' % (spec['agency'], len(files), spec['dir']), flush=True)
        for p in files:
            pages += 1
            slug, page, raw = read_one(p, spec, name_map)
            measures = cross_check(measures_in(page['overview']),
                                   held_values(registry, slug, idx) if slug else {})
            rec = {
                'state': spec['state'], 'agency': spec['agency'],
                'page_name': page['name'],
                'display_name': (idx.get(slug) or {}).get('display_name') if slug else None,
                'source': {'file': os.path.basename(p), 'url': source_url(raw),
                           'saved_at': saved_at(p), 'published': page.get('published')},
                'measures': measures,
                'overview': page['overview'],
                'species': page['species'],
                # Named, not silent: the page raised the subject and the reader took no number
                # off it. The sentence is in `overview` above, for a person to read.
                'mentioned_but_not_parsed': sorted(mentioned(page['overview']) - set(measures)),
            }
            if spec['reader'] == 'ga':
                rec['best_bets'] = page['best_bets']
                rec['additional_information'] = page['additional_information']
            if slug:
                if slug in rows:
                    print('   !! %s already read from %s' % (slug, rows[slug]['source']['file']))
                rows[slug] = rec
            else:
                unmatched.append({'page_name': page['name'], 'file': os.path.basename(p),
                                  'state': spec['state'], 'measures': measures})

    # THE SURFACE-ACRES DISAGREEMENT IS SYSTEMATIC, AND THAT IS THE FINDING.
    #
    # Measured 2026-08-27 across every water where both numbers exist: the agency's published
    # acreage is LARGER than lake_index.json's area_acres on all of them. That is not error, it
    # is two different measurements -- the agency publishes the pool at full pool, and
    # area_acres is the area of the polygon the chartpack actually covers, which is bounded by
    # what Garmin meshed. So neither replaces the other, and any row that breaks the pattern is
    # the one worth looking at, because the pattern does not explain it.
    ac = [(s, r['measures']['surface_acres']['cross_check'])
          for s, r in rows.items()
          if r['measures'].get('surface_acres', {}).get('cross_check')]
    against = [(s, c) for s, c in ac
               if c['agency_minus_held'] < 0 and not c['within_agency_rounding']]
    acres_note = {
        'compared': len(ac),
        'agency_larger': len([1 for _, c in ac
                              if c['agency_minus_held'] > 0 and not c['within_agency_rounding']]),
        'agency_smaller': len(against),
        'within_agency_rounding': len([1 for _, c in ac if c['within_agency_rounding']]),
        'median_pct_of_held': (sorted(c['pct_of_held'] for _, c in ac)[len(ac) // 2]
                               if ac else None),
        'breaks_the_pattern': {s: c for s, c in against},
        'why': 'The agency publishes acreage at full pool; lake_index area_acres is the area of '
               'the polygon the chartpack covers, bounded by what Garmin meshed. Two '
               'measurements of two things. Neither is written over the other.',
    }
    fp = [(s, r['measures']['full_pool_ft']['cross_check'])
          for s, r in rows.items()
          if r['measures'].get('full_pool_ft', {}).get('cross_check')]

    doc = {
        '_note': 'Personal use only, not for distribution or resale; not for navigation. What '
                 'TWRA and GA DNR already publish about the waters the card offers, read off '
                 'the saved agency pages with no LLM in the path. Every measure keeps the '
                 'sentence it came from and the value we already held. NOTHING HERE IS '
                 'AUTHORITATIVE OVER THE REGISTRY -- it is a second reading, recorded beside '
                 'the first. The Regulations section of the TWRA pages is deliberately not '
                 'read here; build_regulations_table.py owns it.',
        'read': date.today().isoformat(),
        'pages_read': pages,
        'waters': len(rows),
        'rows': rows,
        'unmatched_pages': unmatched,
        'surface_acres_check': acres_note,
        'full_pool_check': {'compared': len(fp),
                            'identical': [s for s, c in fp if c['identical']],
                            'differ': {s: c for s, c in fp if not c['identical']}},
        'mentioned_but_not_parsed': {
            k: sorted(s2 for s2, r in rows.items() if k in r['mentioned_but_not_parsed'])
            for k in MENTIONS
            if any(k in r['mentioned_but_not_parsed'] for r in rows.values())
        },
        'not_read': {
            'growth_at_age': 'The TWRA pages carry a common-length-at-age table per species. '
                             'Nothing in the app consumes growth-at-age, so it is not extracted '
                             '-- an object with no reader is what this refactor is removing.',
            'tn_regulations': 'registry/regulations_table.json, built by '
                              'build_regulations_table.py from the same pages.',
        },
    }
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(doc, f, indent=1, ensure_ascii=False)

    print('\n%d page(s) read, %d landed on an offered water, %d did not'
          % (pages, len(rows), len(unmatched)))
    print('surface acres: %d compared, agency larger on %d, smaller on %d, %d inside the '
          'agency\'s own rounding, median %+.1f%%'
          % (acres_note['compared'], acres_note['agency_larger'], acres_note['agency_smaller'],
             acres_note['within_agency_rounding'], acres_note['median_pct_of_held'] or 0.0))
    print('full pool:     %d compared, %d identical, %d differ'
          % (len(fp), len(doc['full_pool_check']['identical']),
             len(doc['full_pool_check']['differ'])))
    if unmatched:
        print('\nnot an offered water (or the name did not resolve exactly):')
        for u in unmatched:
            print('   %-5s %-28s %s' % (u['state'], u['page_name'][:28], u['file']))
    gaps = doc['mentioned_but_not_parsed']
    if gaps:
        print('\nraised on the page and no number taken off it:')
        for k in sorted(gaps):
            print('   %-16s %d water(s): %s' % (k, len(gaps[k]), ', '.join(gaps[k][:6])))
    sp = sum(len(r['species']) for r in rows.values())
    print('\n%d species section(s) across %d waters -> %s' % (sp, len(rows), out))
    return 0


if __name__ == '__main__':
    sys.exit(main())
