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
    #
    # DUKE WRITES IT A THIRD WAY, on every one of its lake pages: "The full pond elevation is
    # 178.1 feet above mean sea level." POND not POOL, IS not OF, and MEAN sea level. Three
    # words, and any one of them missing loses fifteen waters -- thirteen of which Duke's levels
    # table can never supply, because they print on its 0-100 index whose Max column just reads
    # 100. Two digits minimum, because Lake Sutton's pond is 10.5 ft.
    ('full_pool_ft', 'ft above sea level', re.compile(
        r'(?:owns?|up\s+to|full\s+pool\s+(?:elevation\s+)?(?:of|is|at))\s*(?:up\s+to\s*)?'
        r'(?:the\s*)?([\d,]{3,5}(?:\.\d+)?)[\s-]*(?:ft|feet)\.?\s*'
        r'(?:elevation|contour|mark|msl)'
        r'|(?:summer\s+|full[\s-]po(?:ol|nd)\s+)?elevation\s+(?:of|is|at)\s+'
        r'([\d,]{2,5}(?:\.\d+)?)\s*(?:ft|feet)\.?\s*'
        r'(?:above\s+(?:mean\s+)?sea\s+level|above\s+msl|msl)', re.I)),
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


# ─────────────────────────────────────────────────────────────────────────────────────────────
# NORTH CAROLINA -- NCWRC per-lake survey reports, as PDFs
# ─────────────────────────────────────────────────────────────────────────────────────────────
#
# THE PAGE IS NOT ONE COLUMN AND EXTRACTING IT AS ONE PRODUCES SENTENCES THAT WERE NEVER WRITTEN.
# pdfplumber's own extract_text() on the High Rock fact sheet gives:
#
#     ...large numbers of smaller, slower growing (stunt-
#     Davidson counties in the Piedmont region
#
# "stunt-" ends a line in the body at x=30 and "Davidson counties" is a margin caption at x=418.
# De-hyphenate that and you get `stuntDavidson`; leave it and every sentence in the document is
# interleaved with whatever sits beside it. A reader built on that output would produce confident,
# sourced, wrong facts, which is worse than no reader.
#
# So the words are grouped into lines, each line is split wherever a horizontal gap is wider than
# a word space, and the runs are read body-first. The margin is kept separately rather than
# discarded -- Hyco's carries `PSD-P = 14`, which is a figure annotation and a real statistic.
#
# WHAT THESE DOCUMENTS RELIABLY CARRY, counted over the 115 short ones rather than assumed from
# the two that were read first:
#
#   a roster sentence          16 of 115. "several species of interest including Largemouth Bass,
#                              Striped Bass, White Bass, Black Crappie, White Crappie, Flathead
#                              Catfish, and Blue Catfish" -- High Rock. Worth taking, not worth
#                              building the reader around.
#   a species in the TITLE     46 of the 71 that bind to a research water, and this is the one
#                              that needs no prose parsing at all. "Hyco Lake Largemouth Bass
#                              Survey" is NC WRC saying largemouth bass are in Hyco Lake, on the
#                              same logic deterministic.js already applies to a lake-specific
#                              creel rule: the state writing a rule for a species in a water is
#                              the state saying it is there. A survey is the stronger version.
#   acreage, river, counties   the opening sentence of a fact sheet: "The 15,180-acre impoundment
#                              of the Yadkin River is located in Rowan and Davidson counties".
#                              That feeds resolve_with_county() and the acreage cross-check
#                              unchanged -- no NC-specific resolution rule is added.
#
# THE SPECIES NAME IS NOT FILTERED HERE. It is emitted as the title writes it and
# uniqueResearchSpecies()/isKnownResearchSpecies() in the Worker decide what is a fish, which is
# what already guards the GA and TN rosters. A second species vocabulary in Python is a second
# copy to drift.

NC_GAP = 28.0          # a horizontal gap wider than this is a column break, not a word space
NC_MARGIN_X = 400.0    # a run starting right of this and narrower than NC_MARGIN_W is a caption
NC_MARGIN_W = 260.0
NC_MAX_PAGES = 3       # a fact sheet is 1-2 pages; an F-108 report puts its abstract on page 1

NC_COUNTIES = re.compile(r'\b(?:located|situated)\s+in\s+((?:[A-Z][a-z]+(?:[,\s]+(?:and\s+)?)?){1,4})'
                         r'\s+count(?:y|ies)', re.I)
NC_ROSTER = re.compile(r'species of interest(?:\s+\w+){0,3}?\s+includ\w*\s+(.{10,300}?)\.', re.I)
NC_ROSTER2 = re.compile(r'(?:sport|game)\s*fish(?:es)?[^.]{0,60}?[;:]\s*(.{10,240}?)\s+are\s+the\s+most'
                        r'\s+sought[- ]after', re.I)
NC_TITLE_TAIL = re.compile(r'\s+(?:Survey|Surveys|Report|Assessment|Population|Fishery|Investigation|'
                           r'Evaluation|Overview|Monitoring|Summary|Update)\b.*$', re.I)


def nc_runs(pg):
    """One page's words as body runs and margin runs, in reading order."""
    lines = {}
    for w in pg.extract_words():
        lines.setdefault(round(w['top'] / 3), []).append(w)
    body, side, seen = [], [], set()
    for k in sorted(lines):
        ws = sorted(lines[k], key=lambda w: w['x0'])
        runs, run = [], [ws[0]]
        for a, b in zip(ws, ws[1:]):
            if b['x0'] - a['x1'] > NC_GAP:
                runs.append(run)
                run = []
            run.append(b)
        runs.append(run)
        for r in runs:
            if not r:
                continue
            txt = ' '.join(w['text'] for w in r)
            if r[0]['x0'] >= NC_MARGIN_X and (r[-1]['x1'] - r[0]['x0']) < NC_MARGIN_W:
                # A caption repeats across the y buckets it spans; keep it once.
                if txt not in seen:
                    seen.add(txt)
                    side.append(txt)
            else:
                body.append(txt)
    return body, side


def nc_text(path):
    import pdfplumber
    body, side = [], []
    with pdfplumber.open(path) as pdf:
        for i in range(min(len(pdf.pages), NC_MAX_PAGES)):
            b, s = nc_runs(pdf.pages[i])
            body += b
            side += s
    t = re.sub(r'(\w)-\n(\w)', r'\1\2', '\n'.join(body))
    return re.sub(r'[ \t]+', ' ', t).strip(), ' '.join(side)


def nc_title(path):
    """`3130_hyco-lake-largemouth-bass-survey.pdf` -> `Hyco Lake Largemouth Bass Survey`.

    THE FILENAME, NOT THE FIRST LINE OF THE PDF. fetch_agency_lake_pages.py builds it from NC
    WRC's own link text, and the document's own first line is the template's banner as often as
    it is the title -- "Fisheries Research Fact Sheet" on 40 of them.
    """
    base = os.path.basename(path)
    base = re.sub(r'^\d+_', '', base)
    base = re.sub(r'\.pdf$', '', base, flags=re.I)
    return base.replace('-', ' ').strip()


def nc_page(path):
    body, margin = nc_text(path)
    title = nc_title(path)
    paras = [p.strip() for p in body.split('\n') if len(p.strip()) > 40]
    joined = ' '.join(paras)

    species = []
    for rx in (NC_ROSTER, NC_ROSTER2):
        m = rx.search(joined)
        if m:
            for part in re.split(r',|\band\b', m.group(1)):
                nm = part.strip(' .;:').strip()
                if 3 < len(nm) < 40:
                    species.append({'name': nm, 'from': 'roster sentence'})
            break
    if not species:
        # The title names the subject species. What it is gets decided in read_one_nc, against
        # the app's own vocabulary, because only there is the water known and removable.
        species.append({'name': title, 'from': 'document title', 'title_form': True})

    counties = ''
    m = NC_COUNTIES.search(joined)
    if m:
        counties = re.sub(r'\s+and\s+', ', ', m.group(1)).strip(' ,')

    # The measures ride on the page like every other reader's, so the page is self-describing and
    # read_one_nc's own acreage fallback reads the same numbers main() will.
    return {'name': title, 'overview': paras, 'species': species,
            'measures': measures_in(paras),
            'general': ({'County': counties} if counties else {}),
            'margin': margin, 'kind': 'pdf'}


def titleCase(s):
    """`largemouth bass` -> `Largemouth Bass`, leaving an already-cased name alone."""
    return ' '.join(w if w[:1].isupper() else w.capitalize() for w in str(s).split())


def nc_species_vocab(root):
    """The species names the app already knows, READ OUT OF ITS OWN SOURCE rather than copied.

    `RESEARCH_SPECIES_CANON` in Worker/research/facts-util.js is the vocabulary that decides what
    is a fish everywhere else in this pipeline. Retyping its 43 keys here would be a second copy
    to drift, which is the thing test/hand-written-tables.test.js exists to catch; reading the
    file is what that test does too. Returns [] when the repo is not beside the pipeline, and the
    caller then keeps the title residue unfiltered for the Worker to judge.
    """
    src = os.path.join(root, 'TrollMap-Dev', 'Worker', 'research', 'facts-util.js')
    if not os.path.exists(src):
        return []
    try:
        txt = open(src, encoding='utf-8').read()
    except OSError:
        return []
    i = txt.find('RESEARCH_SPECIES_CANON')
    if i < 0:
        return []
    seg = txt[i:txt.find('};', i)]
    return sorted({m.group(1).lower() for m in re.finditer(r"^\s*'([^']+)'\s*:", seg, re.M)},
                  key=len, reverse=True)


def nc_water_in_title(title, name_keys):
    """The longest registry name the title contains, or None.

    A DOCUMENT TITLE IS PROSE, NOT A NAME. "Angler Use Patterns on Randleman Lake" is not a name
    resolve_with_county() can match and it should not be asked to -- the strict resolver stays
    strict. What happens here is extraction: find the water the sentence names, then hand THAT to
    the resolver, which still matches exactly and still checks the county.

    Longest first, so "Lake James" cannot claim a title that says "Lake James Walleye" ahead of a
    longer name, and so a two-word water beats its own one-word substring.
    """
    t = ' %s ' % re.sub(r'[^a-z0-9]+', ' ', title.lower()).strip()
    for k in name_keys:
        if len(k) >= 5 and (' %s ' % k) in t:
            return k
    return None


def read_one_nc(path, spec, idx, multimap):
    try:
        page = nc_page(path)
    except Exception as e:                                    # a scan with no text layer
        return None, 'could not read the pdf: %s' % str(e)[:80], None, ''
    if not page['overview']:
        return None, 'no text layer -- would need OCR', None, ''
    counties = (page.get('general') or {}).get('County') or ''
    named = nc_water_in_title(page['name'], spec.get('_name_keys') or [])
    slug, why = (None, None)
    for cand in (named, page['name']):
        if not cand:
            continue
        slug, why = resolve_with_county(cand, counties, spec['state'], idx, multimap)
        if slug:
            break
    if not slug:
        found = measures_in(page['overview'])
        acres = (found.get('surface_acres') or {}).get('value')
        slug, why = resolve_by_stated_fact(named or page['name'], spec['state'], counties, acres, idx)
    # THE TITLE'S SPECIES IS WHAT IS LEFT AFTER THE WATER AND THE REPORT WORD COME OUT.
    # "Hyco Lake Largemouth Bass Survey" minus "hyco lake" minus "Survey" is "Largemouth Bass".
    # Without removing the water, every title became its own species name -- "angler use patterns
    # on randleman lake" was being emitted as a fish.
    # THE TITLE'S SPECIES IS A VOCABULARY LOOKUP, NOT A SUBSTRING OF WHAT IS LEFT OVER.
    #
    # An earlier cut stripped the title at its first report word and kept the remainder. "An
    # Overview of the Falls Lake Largemouth Bass Fishery" strips at *Overview* and leaves "an",
    # which was then emitted as a fish. So did "long term", "evaluation of the black bass" and
    # "angler use patterns on".
    #
    # The water comes out first -- it can contain a fish, and Bass Lake would otherwise name one
    # -- and then the longest vocabulary term inside what remains is the answer. A title naming no
    # known fish yields NO species rather than a bad one, which is the same refusal
    # deterministic.js already makes of an agency roster that names nothing it recognises.
    vocab = spec.get('_species') or []
    kept = []
    for sp in page['species']:
        if not sp.get('title_form'):
            kept.append(sp)
            continue
        residue = sp['name']
        if named:
            residue = re.sub(re.escape(named).replace(r'\ ', r'[^a-z0-9]+'), ' ', residue, flags=re.I)
        residue = ' %s ' % re.sub(r'[^a-z0-9]+', ' ', residue.lower()).strip()
        pick = next((v for v in vocab if (' %s ' % v) in residue), None)
        if pick:
            sp['name'] = titleCase(pick)
            sp.pop('title_form', None)
            kept.append(sp)
    page['species'] = kept
    return slug, why, page, ''

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


def deepest_charted(chartpack, slug):
    """The deepest contour in this water's own pack, or None if there is no pack to ask."""
    if not chartpack:
        return None
    fp = os.path.join(chartpack, slug, 'contours.geojson')
    if not os.path.exists(fp):
        return None
    try:
        d = json.load(open(fp, encoding='utf-8'))
    except (ValueError, OSError):
        return None
    vals = [f.get('properties', {}).get('depth_ft') for f in (d.get('features') or [])]
    vals = [v for v in vals if isinstance(v, (int, float))]
    return max(vals) if vals else None


def depth_check(measure, slug, registry, chartpack):
    """Is this a depth, or is it the full pool elevation wearing a depth's label?

    SCDNR's Maximum Depth agrees with our own charted deepest contour on most of the fourteen
    -- Hartwell 185 against 180.1, Jocassee 351 against 348.1, Keowee 155 against 155.8. Lake
    Wateree's says 225 feet. Our chart's deepest contour there is 65.0 ft and full_pool.json
    holds wateree_lake at 225.5 ft above sea level. Wateree is not two hundred feet deep; the
    elevation is in the depth field.

    TWO CONDITIONS, BOTH OFF THE DATA, and neither is a threshold anybody chose. It matches
    the water's own full pool AND it is deeper than the deepest contour on the chart. Marion
    and Moultrie also sit near their 76.8 ft pool -- and their charts read 79.1 and 68.9 ft,
    so those numbers are real depths that happen to look like the elevation. One test would
    have libelled them.
    """
    fpp = os.path.join(registry, 'full_pool.json')
    pool = None
    if os.path.exists(fpp):
        row = (json.load(open(fpp, encoding='utf-8')).get('rows') or {}).get(slug) or {}
        pool = row.get('full_pool_ft')
    charted = deepest_charted(chartpack, slug)
    v = float(measure['value'])
    measure['charted_deepest_ft'] = charted
    measure['full_pool_ft'] = pool
    if (pool and charted and abs(v - float(pool)) < 2.0 and v > charted + 10):
        measure['looks_like'] = ('the full pool ELEVATION, not a depth -- it matches this '
                                 "water's own full pool and is %.1f ft deeper than the "
                                 'deepest contour on the chart' % (v - charted))
    elif charted:
        measure['agrees_with_chart_within_ft'] = round(abs(v - charted), 1)


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
    {'state': 'SC', 'agency': 'SCDNR', 'dir': 'SC_Lakes', 'reader': 'sc'},
    # NORTH CAROLINA PUBLISHES NO PER-LAKE PAGE. Georgia has 31 fishing forecasts, Tennessee 11
    # TWRA reservoir pages, South Carolina 32 lake descriptions -- and NC WRC has none, which is
    # why this file has never carried an NC row and why 30 of the 31 NC waters in the research
    # set reached the agents with nothing from their own state behind them.
    #
    # What it publishes instead is per-lake SURVEY REPORTS, as PDFs, saved by
    # fetch_agency_lake_pages.py --state NC. 282 of them, of which 71 bind to a research water.
    {'state': 'NC', 'agency': 'NCWRC', 'dir': 'NC_Lakes', 'reader': 'nc', 'glob': '*.pdf'},
]


# GEORGIA PUBLISHES ONE DOCUMENT THAT IS ALL LAKE AND NO SPECIES PAGE.
#
# `walleyeGuide_scrollable.pdf` -- GA DNR's Angler's Guide to Walleye Fishing in Georgia -- is not
# a lake page and not a species account. It is a THREE-SEASON TABLE OF NAMED PLACES: eleven
# reservoirs down the side, February-April / May-September / October-January across, and a tip in
# every cell that names a creek, a ramp, a dam or a depth.
#
#   "Target standing timber in 30-feet of water on main lake points in the Eastanollee Creek area."
#                                                                            Hartwell, Oct-Jan
#   "Target brush piles in 30-50 feet of water on the lower half of the lake."   Lanier, May-Sept
#
# That is the shape of this file, not of species_traits.json: per water, per season, and specific
# to the place. It is also exactly what Ryan said the plan was missing -- "15-40ft is almost the
# entire depth profile... this doesn't say upper or lower lake... coves or open lake".
#
# ONE FILE, MANY WATERS, so it cannot go through read_one() like the per-lake pages. It is its own
# pass in main().
GA_WALLEYE = 'walleyeGuide_scrollable.pdf'
GA_WALLEYE_SEASON = re.compile(r'^(FEBRUARY - APRIL|MAY - SEPTEMBER|OCTOBER - JANUARY)$')


def ga_walleye_table(path):
    """{reservoir: {season: tip}}, read off the RULES THE DOCUMENT DRAWS.

    The page is one 1080x7280 sheet and the reservoir name is set vertically CENTRED against a
    tip that runs to four lines, so a name sits above some of its own text and below the rest.
    Reading by proximity gets Rabun's first line onto Seed by 0.8 of a point. The table is ruled
    -- horizontal rules at every row boundary, verticals at x=150/330/494/930 -- so pdfplumber's
    `lines` strategy reads the rows the designer actually drew and none of that arises.
    """
    import pdfplumber
    out, season = {}, None
    with pdfplumber.open(path) as pdf:
        pg = pdf.pages[0].dedupe_chars()
        tables = pg.crop((0, 0, pg.width, pg.height - 1)).extract_tables(
            {'vertical_strategy': 'lines', 'horizontal_strategy': 'lines'})
    for t in tables:
        for row in t:
            c = [str(x or '').replace('\n', ' ').strip() for x in row]
            if not c or not c[0]:
                continue
            if GA_WALLEYE_SEASON.match(c[0]):
                season = c[0]
                continue
            if c[0].upper() == 'RESERVOIR' or not season or len(c) < 3 or not c[2]:
                continue
            tip = re.sub(r'(\w)- (\w)', r'\1\2', re.sub(r'\s+', ' ', c[2])).strip()
            if len(tip) > 20:
                out.setdefault(c[0], {})[season] = tip
    return out


def ga_walleye_water(name, idx, multimap):
    """The guide writes bare reservoir names -- `Seed`, `Rabun`, `Lanier`.

    Exact first, through the same resolver every other page uses. `Lanier` is the one that needs
    more: Georgia's is `lake_sidney_lanier` and the bare name belongs to an 88.5-acre SC lake in
    Greenville County, so the state filter is doing real work here. The fallback accepts a
    substring ONLY when exactly one water in the state answers to it, which is a measurement
    rather than a guess -- and it is why Blue Ridge, Carters and the three Rocky Mountain PFA
    ponds come back empty: Georgia stocks walleye in them and we do not ship a chart for them.
    """
    for cand in (name, 'Lake %s' % name, '%s Lake' % name):
        slug, why = resolve_with_county(cand, '', 'GA', idx, multimap)
        if slug:
            return slug, why
    n = re.sub(r'[^a-z0-9]+', ' ', name.lower()).strip()
    hits = {s for s, r in idx.items()
            if str(r.get('state') or '').upper() == 'GA'
            and n in re.sub(r'[^a-z0-9]+', ' ',
                            str(r.get('display_name') or r.get('name') or '').lower())}
    if len(hits) == 1:
        return sorted(hits)[0], 'the only GA water whose name contains "%s"' % name
    return None, ('%d GA waters contain "%s"' % (len(hits), name)) if hits else 'no GA water by that name'


def read_ga_walleye(root, idx, multimap):
    """-> ({slug: rec}, [unmatched]). One rec per reservoir, in this file's own shape."""
    path = os.path.join(root, GA_WALLEYE)
    if not os.path.exists(path):
        return {}, []
    table = ga_walleye_table(path)
    got, missed = {}, []
    for name, seasons in sorted(table.items()):
        slug, why = ga_walleye_water(name, idx, multimap)
        tips = ['%s — %s' % (season, seasons[season])
                for season in ('FEBRUARY - APRIL', 'MAY - SEPTEMBER', 'OCTOBER - JANUARY')
                if seasons.get(season)]
        if not slug:
            missed.append({'page_name': name, 'file': GA_WALLEYE, 'state': 'GA',
                           'why': why, 'measures': {}})
            continue
        got[slug] = {
            'state': 'GA', 'agency': 'GA DNR',
            'page_name': "Angler's Guide to Walleye Fishing in Georgia — %s" % name,
            'display_name': (idx.get(slug) or {}).get('display_name'),
            'match_note': why,
            'source': {'file': GA_WALLEYE, 'url': None, 'saved_at': saved_at(path),
                       'published': None},
            'measures': {}, 'overview': [],
            'species': [{'name': 'Walleye', 'tips': tips}],
            'mentioned_but_not_parsed': [],
        }
    return got, missed


def build_name_multimap(idx):
    """Every name a water answers to -> EVERY slug that answers to it.

    build_regulations_table.build_name_map() keeps the first slug per name, which is right for
    the regulations books because a book address is a legal one. A page title is not: SCDNR
    titles Richard B. Russell's page `Lake Russell`, and so does an 88.5-acre lake in Habersham
    County, Georgia. First-wins picked the pond, and the pond's chart is 33 ft deep against the
    page's published 167.3.
    """
    m = {}
    for slug, row in idx.items():
        cands = [slug, row.get('name'), row.get('display_name'), row.get('legacy_display_name')]
        cands += list(row.get('legacy_display_names') or [])
        for c in cands:
            if not c:
                continue
            k = slugify(re.sub(r'\s*\(.*?\)\s*', ' ', str(c)))
            # A BORDER LAKE CARRIES TWO STATES, SO STRIP UNTIL THERE ARE NONE LEFT.
            # `Lake Russell, SC/GA` slugifies to lake_russell_sc_ga, and taking one suffix off
            # leaves lake_russell_sc -- which never matches the page titled `Lake Russell`, so
            # SCDNR's Richard B. Russell page resolved to an 88.5-acre pond in Habersham
            # County instead. Same for `Lake Thurmond, GA/SC`.
            while True:
                k2 = re.sub(r'_(al|ga|nc|sc|tn|va)$', '', k)
                if k2 == k:
                    break
                k = k2
            if k:
                m.setdefault(k, []).append(slug)
    return {k: sorted(set(v)) for k, v in m.items()}


def _tries(name):
    base = slugify(re.sub(r'\s*\(.*?\)\s*', ' ', name))
    out = [base]
    for a, b in (('_reservoir', '_lake'), ('_lake', '_reservoir')):
        if base.endswith(a):
            out.append(base[: -len(a)] + b)
    stem = re.sub(r'_(reservoir|lake)$', '', base)
    return out + [stem, 'lake_' + stem, stem + '_lake', stem + '_reservoir']


COUNTY_SPLIT = re.compile(r'\s*(?:,|\band\b|/)\s*')
TWO_STATES = re.compile(r'\b(AL|GA|NC|SC|TN|VA)\s*/\s*(AL|GA|NC|SC|TN|VA)\b')


def _spans_a_line(row):
    """Does the registry itself say this water is in two states?"""
    blob = '%s %s' % (row.get('display_name') or '', row.get('state') or '')
    return bool(TWO_STATES.search(blob))


NAME_STOP = frozenset(('lake', 'lakes', 'reservoir', 'pond', 'the', 'of'))


def _name_words(s):
    s = re.sub(r'\s*\([^)]*\)\s*$', '', s or '').lower()
    return set(w for w in re.findall(r'[a-z0-9]+', s) if w not in NAME_STOP)


def resolve_by_stated_fact(name, state, counties, acres, idx):
    """The water a short title means, settled by the size the page itself prints.

    GA DNR titles Lake Sidney Lanier's page `Lake Lanier`. So does the registry, for an
    84.8-acre pond in Greenville County, South Carolina. An exact match on the title lands on
    the pond, the pond is in the wrong state, and the 38,292-acre reservoir -- the second
    largest water the card offers -- got no page, no species and no measures at all.

    This is the county rule again with a different fact doing the narrowing, because the GA
    pages print no county. One name word-for-word inside the other, in the page's own state,
    ALONE in being both, and a published acreage inside half the step the agency itself
    rounded to. The agency chose that step when it wrote 38,000 instead of 38,247, so nothing
    here is a threshold anybody invented: `Lake Paul Wallace` at 300 acres against a held
    273.3 passes on a number published to the nearest 100, and `Bonneau Ferry WMA Lake` at 100
    against the 25-acre `Ferry Lake` fails on the same test.

    Returns (slug, why) with `why` always set on a match -- a match made this way should never
    read like an exact one.
    """
    if not (name and state):
        return None, None
    pw = _name_words(name)
    if not pw:
        return None, None
    cands = []
    for slug, row in idx.items():
        if row.get('feature_type') != 'lake' or state not in (row.get('state') or ''):
            continue
        rw = _name_words(row.get('name'))
        if rw and (pw <= rw or rw <= pw):
            cands.append(slug)
    if not cands:
        return None, None
    want = {c.strip().lower() for c in COUNTY_SPLIT.split(counties or '') if c.strip()}
    if want:
        keep = [s for s in cands
                if str((idx[s].get('county') or '')).strip().lower() in want]
        if len(keep) == 1:
            return keep[0], ('matched on the county both sources name: titled %s, the registry '
                             'names it %s in %s County'
                             % (name, idx[keep[0]].get('name'), idx[keep[0]].get('county')))
    if acres:
        keep = [s for s in cands
                if s and idx[s].get('area_acres')
                and abs(float(acres) - float(idx[s]['area_acres']))
                <= granularity(float(acres)) / 2.0]
        if len(keep) == 1:
            return keep[0], ('matched on the size the page prints: titled %s, the registry '
                             'names it %s at %.1f acres against the page\'s %g -- inside the '
                             '%g the page rounded to'
                             % (name, idx[keep[0]].get('name'), idx[keep[0]]['area_acres'],
                                float(acres), granularity(float(acres))))
    return None, None


def resolve_with_county(name, counties, state, idx, multimap):
    """The registry slug, disambiguated by the counties the page itself names.

    THE PAGE ANSWERS ITS OWN AMBIGUITY. SCDNR prints `Counties Lake is Within: Anderson,
    Abbeville` two lines under the title; the registry files Richard B. Russell under Abbeville
    and the Georgia pond under Habersham. No fuzzy matching and no geometry -- one exact name
    match narrowed by a county both sources state.

    Returns (slug, why). `why` is None on a clean single match, and otherwise says what went
    wrong so it can be reported instead of guessed at.
    """
    want = {c.strip().lower() for c in COUNTY_SPLIT.split(counties or '') if c.strip()}
    seen = []
    for t in _tries(name):
        for slug in multimap.get(t, []):
            if slug not in seen:
                seen.append(slug)
        if seen:
            break
    # A PAGE MAY NOT NAME A WATER IN ANOTHER STATE unless the registry says the water is in
    # both. GA DNR titles Lake Sidney Lanier's page `Lake Lanier`; so does the registry, for
    # an 84.8-acre pond in Greenville County, South Carolina. With no county printed on the GA
    # pages there was nothing to catch it, and 38,000 acres of Georgia reservoir was written
    # onto a South Carolina pond -- silently, because one name match and no county reads as
    # clean. Every real cross-line match here (Thurmond, Hartwell, Russell, Tugaloo, Yonah,
    # Wylie) is a water the index itself marks as spanning a line, so they all survive this.
    seen = [s for s in seen
            if state in ((idx.get(s) or {}).get('state') or '') or _spans_a_line(idx.get(s) or {})]
    if not seen:
        return None, 'no exact name match'
    if len(seen) == 1:
        only = seen[0]
        if want:
            row = idx.get(only) or {}
            county = str(row.get('county') or '').strip().lower()
            if county and county not in want:
                # A BORDER LAKE IS FILED UNDER ONE COUNTY IN ONE STATE, AND THE OTHER STATE'S
                # AGENCY NAMES ITS OWN. The registry files J. Strom Thurmond under Lincoln
                # County, Georgia; SCDNR's page for the same water says Abbeville and
                # McCormick. Both are true and neither is the other's. So on a water the index
                # itself marks as spanning a line, a county disagreement is not evidence of a
                # wrong match -- and it is recorded rather than passed over in silence.
                if _spans_a_line(row):
                    return only, ('accepted across the state line: the registry files it in '
                                  '%s and the page names %s'
                                  % (county.title(),
                                     ', '.join(sorted(c.title() for c in want))))
                return None, ('the only name match is in %s and the page says %s'
                              % (county.title(), ', '.join(sorted(c.title() for c in want))))
        return only, None
    if not want:
        return None, 'ambiguous: %s, and the page names no county' % ', '.join(seen)
    keep = [s for s in seen
            if str((idx.get(s) or {}).get('county') or '').strip().lower() in want]
    if len(keep) == 1:
        return keep[0], None
    return None, ('ambiguous: %s; the page names %s'
                  % (', '.join(seen), ', '.join(sorted(c.title() for c in want)) or 'no county'))


def read_one(path, spec, idx, multimap):
    reader = spec['reader']
    if reader == 'nc':
        return read_one_nc(path, spec, idx, multimap)
    blocks, raw = blocks_of(path)
    page = (tn_page(blocks) if reader == 'tn'
            else sc_page(blocks, raw) if reader == 'sc'
            else ga_page(blocks))
    if page is None:
        return None, 'not an %s page -- no reader for this template' % spec['agency'], None, raw
    # TWRA's <h1> and its filename disagree on Calderwood -- "Calderwood Reservoir" against
    # "Calderwood Lake" -- so both are offered to the resolver and the first exact match wins.
    fallback = os.path.basename(path).split(' in Tennessee')[0].strip()
    slug, why = None, None
    counties = (page.get('general') or {}).get('Counties Lake is Within') \
        or (page.get('general') or {}).get('County') or ''
    for cand in (page.get('name'), fallback):
        if not cand:
            continue
        slug, why = resolve_with_county(cand, counties, spec['state'], idx, multimap)
        if slug:
            break
    if not slug:
        # THE PAGE PRINTS ITS OWN SIZE. Only reached when the title matched nothing, so this
        # can never re-route a page the name and county already settled.
        found = dict(page.get('measures') or {})
        for k, v in measures_in(page['overview']).items():
            found.setdefault(k, v)
        acres = (found.get('surface_acres') or {}).get('value')
        for cand in (page.get('name'), fallback):
            if not cand:
                continue
            slug, note = resolve_by_stated_fact(cand, spec['state'], counties, acres, idx)
            if slug:
                why = note
                break
    return slug, why, page, raw


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--root', default='.', help='the pipeline root holding the page folders')
    # A READER IS ITERATED ON, and reading 282 NC pdfs to see whether one regex landed is a
    # five-minute round trip. Both of these narrow the run; neither changes what it reads.
    ap.add_argument('--state', action='append',
                    help='only these states (repeatable), e.g. --state NC')
    ap.add_argument('--limit', type=int, default=0,
                    help='stop after N pages per source (0 = all). For iterating on a reader.')
    ap.add_argument('--registry', default=None, help='default <root>/registry')
    ap.add_argument('--out', default=None, help='default <registry>/agency_lake_facts.json')
    ap.add_argument('--chartpack', default=None,
                    help='default <root>/chartpack -- read only to sanity-check a published depth')
    a = ap.parse_args()
    root = os.path.abspath(a.root)
    registry = a.registry or os.path.join(root, 'registry')
    default_out = os.path.join(registry, 'agency_lake_facts.json')
    out = a.out or default_out
    chartpack = a.chartpack or os.path.join(root, 'chartpack')
    if not os.path.isdir(chartpack):
        chartpack = None
        print('   (no chartpack dir -- published depths will not be checked against the chart)')

    idx = REG.load_index(registry)
    if not idx:
        print('!! no lake_index.json under %s -- nothing can be resolved' % registry)
        return 2
    multimap = build_name_multimap(idx)

    rows, unmatched, unread, pages = {}, [], [], 0
    wanted = {x.upper() for x in (a.state or [])}
    for spec in SOURCES:
        if wanted and spec['state'] not in wanted:
            continue
        if spec['reader'] == 'nc':
            # THE KEYS ARE SLUGIFIED. build_name_multimap keys on REG.slugify output --
            # `hyco_lake`, not `Hyco Lake` -- so a title match has to be made against the spaced
            # form. Underscores back to spaces, longest first. The resolver still receives a name
            # and still matches it exactly; only the extraction from prose happens here.
            spec['_name_keys'] = sorted({k.replace('_', ' ') for k in multimap},
                                        key=len, reverse=True)
            spec['_species'] = nc_species_vocab(root)
            if not spec['_species']:
                print('!! could not read RESEARCH_SPECIES_CANON out of the repo -- NC title '
                      'species will be emitted unfiltered for the Worker to judge')
        d = os.path.join(root, spec['dir'])
        files = sorted(glob.glob(os.path.join(d, spec.get('glob', '*.html'))))
        if a.limit:
            files = files[:a.limit]
        print('%s: %d page(s) under %s' % (spec['agency'], len(files), spec['dir']), flush=True)
        for p in files:
            pages += 1
            slug, why, page, raw = read_one(p, spec, idx, multimap)
            if page is None:
                unread.append({'file': os.path.basename(p), 'state': spec['state'],
                               'url': source_url(raw), 'why': why})
                continue
            found = dict(page.get('measures') or {})
            for k, v in measures_in(page['overview']).items():
                found.setdefault(k, v)
            measures = cross_check(found, held_values(registry, slug, idx) if slug else {})
            if slug and 'max_depth_ft' in measures:
                depth_check(measures['max_depth_ft'], slug, registry, chartpack)
            rec = {
                'state': spec['state'], 'agency': spec['agency'],
                'page_name': page['name'],
                'display_name': (idx.get(slug) or {}).get('display_name') if slug else None,
                'match_note': why if slug else None,
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
            if spec['reader'] == 'sc':
                # The whole labelled list travels, not only the labels this script maps. A
                # field nobody has a use for yet is still a field the agency published, and
                # dropping it here is how it gets re-derived later.
                rec['general'] = page['general']
                rec['sections'] = page['sections']
            if slug:
                # TWO AGENCIES PUBLISH ABOUT A BORDER LAKE AND BOTH ARE RIGHT. Hartwell has a
                # GA DNR forecast and an SCDNR description; Thurmond has GA's `clarks-hill`
                # and SC's `thurmond`. Keeping one silently overwrote the other -- and the two
                # do not even agree on acreage. A water holds a LIST of agency readings.
                rows.setdefault(slug, []).append(rec)
            else:
                unmatched.append({'page_name': page['name'], 'file': os.path.basename(p),
                                  'state': spec['state'], 'why': why, 'measures': measures})

    # GA DNR'S WALLEYE GUIDE. One document, many waters, so it is its own pass rather than a
    # SOURCES entry -- read_one() is one file to one lake by construction.
    if not wanted or 'GA' in wanted:
        wal, wal_missed = read_ga_walleye(root, idx, multimap)
        if wal or wal_missed:
            pages += 1
            for slug, rec in wal.items():
                rows.setdefault(slug, []).append(rec)
            unmatched.extend(wal_missed)
            print('GA DNR: walleye guide -> %d water(s), %d named but not ours (%s)'
                  % (len(wal), len(wal_missed),
                     ', '.join(m['page_name'] for m in wal_missed) or '-'))

    # THE SURFACE-ACRES DISAGREEMENT IS SYSTEMATIC, AND THAT IS THE FINDING.
    #
    # Measured 2026-08-27 across every water where both numbers exist: the agency's published
    # acreage is LARGER than lake_index.json's area_acres on all of them. That is not error, it
    # is two different measurements -- the agency publishes the pool at full pool, and
    # area_acres is the area of the polygon the chartpack actually covers, which is bounded by
    # what Garmin meshed. So neither replaces the other, and any row that breaks the pattern is
    # the one worth looking at, because the pattern does not explain it.
    # One row per AGENCY READING, not per water: where two agencies publish an acreage for the
    # same lake, both are compared, because they disagree with each other as well as with us.
    reads = [(s, r) for s, recs in rows.items() for r in recs]
    ac = [('%s (%s)' % (s, r['agency']), r['measures']['surface_acres']['cross_check'])
          for s, r in reads
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
    fp = [('%s (%s)' % (s, r['agency']), r['measures']['full_pool_ft']['cross_check'])
          for s, r in reads
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
        # PRESENT AND NOT READ IS ITS OWN ANSWER, and it has to be tellable apart from absent.
        # A page saved into a state's folder from a site this script has no reader for is not
        # a page that says nothing.
        'pages_with_no_reader': unread,
        'surface_acres_check': acres_note,
        'full_pool_check': {'compared': len(fp),
                            'identical': [s for s, c in fp if c['identical']],
                            'differ': {s: c for s, c in fp if not c['identical']}},
        'mentioned_but_not_parsed': {
            k: sorted({s2 for s2, r in reads if k in r['mentioned_but_not_parsed']})
            for k in MENTIONS
            if any(k in r['mentioned_but_not_parsed'] for _, r in reads)
        },
        'not_read': {
            'growth_at_age': 'The TWRA pages carry a common-length-at-age table per species. '
                             'Nothing in the app consumes growth-at-age, so it is not extracted '
                             '-- an object with no reader is what this refactor is removing.',
            'tn_regulations': 'registry/regulations_table.json, built by '
                              'build_regulations_table.py from the same pages.',
        },
    }
    # ── A NARROWED RUN MAY NOT WRITE THE WHOLE FILE ────────────────────────────────────────
    #
    # This object is rebuilt from scratch on every run and the write replaces it, so a run that
    # read only some of the sources produces a file holding only those. It is not a hypothetical:
    # on 2026-09-02 `--state GA` was run to iterate on a reader and took
    # registry/agency_lake_facts.json from 83 waters to 16. Ryan rebuilt it by hand.
    #
    # BOTH FLAGS DO IT, and `--limit` is the more dangerous of the two because its own help text
    # invites it -- "stop after N pages per source (0 = all). For iterating on a reader." That is
    # exactly when you least want the real file replaced, and there is no --go on this script to
    # catch it: the write happens on every run.
    #
    # Refusing rather than merging, the same call build_dnr_ramps_by_lake.py makes: a file whose
    # rows came from different runs, with nothing on it saying which, is worse than one that made
    # you re-run. `--out` is the way to keep a narrowed run's output, and it says so.
    narrowed = []
    if wanted:
        narrowed.append('--state %s (skipped %s)'
                        % ('+'.join(sorted(wanted)),
                           ', '.join(sorted({sp['state'] for sp in SOURCES} - wanted)) or 'nothing'))
    if a.limit:
        narrowed.append('--limit %d (each source truncated)' % a.limit)
    if narrowed and os.path.abspath(out) == os.path.abspath(default_out):
        print('\nREFUSING TO WRITE A PARTIAL FILE. This run was narrowed by %s, and the write '
              'replaces\n%s entirely -- so it would DELETE every water this run did not read.'
              % (' and '.join(narrowed), out))
        print('   This is what took agency_lake_facts.json from 83 waters to 16 on 2026-09-02.')
        print('\nDrop the flags to write the real file, or send this run somewhere else:')
        print('   --out %s' % os.path.join(os.path.dirname(out) or '.', '_agency_lake_facts_partial.json'))
        return 2

    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(doc, f, indent=1, ensure_ascii=False)

    print('\n%d page(s) read, %d landed on an offered water, %d did not'
          % (pages, len(rows), len(unmatched)))
    both = {s: [r['agency'] for r in recs] for s, recs in rows.items() if len(recs) > 1}
    if both:
        print('   %d water(s) have a page from more than one agency: %s'
              % (len(both), '; '.join('%s %s' % (s, '+'.join(a)) for s, a in both.items())))
    print('surface acres: %d compared, agency larger on %d, smaller on %d, %d inside the '
          'agency\'s own rounding, median %+.1f%%'
          % (acres_note['compared'], acres_note['agency_larger'], acres_note['agency_smaller'],
             acres_note['within_agency_rounding'], acres_note['median_pct_of_held'] or 0.0))
    print('full pool:     %d compared, %d identical, %d differ'
          % (len(fp), len(doc['full_pool_check']['identical']),
             len(doc['full_pool_check']['differ'])))
    if unread:
        print('\nsaved but not read -- no reader for that site\'s template:')
        for u in unread:
            print('   %-5s %-46s %s' % (u['state'], u['file'][:46], u['url'] or ''))
    if unmatched:
        print('\nnot an offered water (or the name did not resolve exactly):')
        for u in unmatched:
            print('   %-5s %-26s %-24s %s'
                  % (u['state'], u['page_name'][:26], u['file'][:24], u.get('why') or ''))
    gaps = doc['mentioned_but_not_parsed']
    if gaps:
        print('\nraised on the page and no number taken off it:')
        for k in sorted(gaps):
            print('   %-16s %d water(s): %s' % (k, len(gaps[k]), ', '.join(gaps[k][:6])))
    sp = sum(len(r['species']) for _, r in reads)
    print('\n%d species section(s) across %d waters -> %s' % (sp, len(rows), out))
    return 0



# ─────────────────────────────────────────────────────────────────────────────────────────────
# SOUTH CAROLINA -- SCDNR lake pages
# ─────────────────────────────────────────────────────────────────────────────────────────────
#
# A THIRD SHAPE, AND THE EASIEST OF THE THREE. Tennessee and Georgia write prose and the numbers
# have to be found in sentences. SCDNR writes a labelled list:
#
#     <strong>Miles of Shoreline:</strong> 620 <br />
#     <strong>Acres of Surface Water:</strong> 13,025 <br />
#     <strong>Maximum Depth:</strong> Approximately 225 feet <br />
#
# so the label IS the field name and no regex has to guess what a number means. Two families
# under one template: 14 major reservoirs at <name>/description.html, and 18 state lakes at
# state/<name>/index.html which carry Property Location / Latitude / Longitude / Acreage /
# County / Property Type instead, plus Hours of Operation and Directions as their own headings.
#
# WHAT SC DOES NOT CARRY is per-species tactics. Georgia's `Target` paragraphs have no
# equivalent here, so these pages feed identity and limnology and not trollingIntelligence.

SC_LABELS = {
    'acres of surface water': ('surface_acres', 'acres'),
    'acreage': ('surface_acres', 'acres'),
    'miles of shoreline': ('shoreline_miles', 'miles'),
    'average depth': ('average_depth_ft', 'ft'),
    'maximum depth': ('max_depth_ft', 'ft'),
    'boat ramps': ('boat_ramps', 'count'),
    'fish attractors': ('fish_attractors', 'count'),
    'fishing access locations': ('fishing_access_locations', 'count'),
}
SC_PARA = re.compile(r'<p\b[^>]*>(.*?)</p>', re.I | re.S)
SC_PAIR = re.compile(r'<strong[^>]*>(.*?)</strong>\s*:?\s*(.*?)(?=<br\s*/?>|</p>|<strong|$)',
                     re.I | re.S)
SC_H2 = re.compile(r'<h2[^>]*>(.*?)</h2>', re.I | re.S)
SC_MAIN_END = re.compile(r'<!--\s*end #mainContent|<div id="footer"', re.I)
SC_NUM = re.compile(r'([\d,]+(?:\.\d+)?)')


def _flat(x):
    return re.sub(r'\s+', ' ', html_unescape(re.sub(r'<[^>]+>', ' ', x))).strip()


def html_unescape(s):
    import html as _h
    return _h.unescape(s)


SC_TEMPLATE = re.compile(r'<h2[^>]*>\s*General Information\s*</h2>', re.I)
SC_BANNER = re.compile(r'South Carolina Lakes and Waterways', re.I)


def sc_page(blocks, raw):
    """The SCDNR page, by its own labels.

    THE SECOND <h1> IS THE LAKE. The first is the site banner, 'South Carolina Lakes and
    Waterways', on every page in the folder -- taking the first h1 names all thirty-two pages
    the same thing and the name map then resolves all of them to nothing.

    AND THE FOLDER IS NOT ONLY SCDNR'S. An operator page saved beside them -- the City of
    Abbeville's Lake Secession page is the first -- is a different site with a different
    template: h1 used for every section heading, so 'last h1' names it `Lake Levels &
    Drawdowns - FAQ`, and no General Information block at all. Reading it with this reader
    produces a confident row about a lake that does not exist. So the reader checks for the
    template it was written against and returns None when it is not there; read_one reports
    the page by name instead of inventing a water.
    """
    if not SC_TEMPLATE.search(raw):
        return None
    body = raw
    m = SC_MAIN_END.search(body)
    if m:
        body = body[:m.start()]
    # The lake's own h1 is the one that is not the site banner.
    h1s = [m for m in re.finditer(r'<h1[^>]*>(.*?)</h1>', body, re.I | re.S)
           if not SC_BANNER.search(m.group(1))]
    name = _flat(h1s[-1].group(1)) if h1s else ''
    region = body[h1s[-1].end():] if h1s else body

    general, sections, overview = {}, {}, []
    heads = list(SC_H2.finditer(region))
    spans = [(None, region[:heads[0].start()] if heads else region)]
    for i, h in enumerate(heads):
        end = heads[i + 1].start() if i + 1 < len(heads) else len(region)
        spans.append((_flat(h.group(1)).rstrip(':').strip(), region[h.end():end]))

    for head, chunk in spans:
        prose = []
        for p in SC_PARA.finditer(chunk):
            inner = p.group(1)
            # A LABEL LIST STARTS WITH ITS LABEL. Merely containing a <strong> is not enough:
            # the state lakes' Hours of Operation paragraph bolds `every day except Tuesday`
            # mid-sentence, which read as a field called "every day except Tuesday" with the
            # value "." -- and cost the sentence itself, because the paragraph was then treated
            # as a list and never kept as prose.
            if re.match(r'\s*(?:<a[^>]*>\s*)?<strong', inner, re.I):
                for pr in SC_PAIR.finditer(inner):
                    k = _flat(pr.group(1)).strip()
                    v = _flat(pr.group(2)).lstrip(':').strip()
                    # `Owned and Managed by: Duke-Energy` puts the value INSIDE the <strong>.
                    if ':' in k and not v:
                        k, v = k.split(':', 1)
                    k = k.rstrip(':').strip()
                    if k and len(k) < 60:
                        general.setdefault(k, v.strip())
                continue
            t = _flat(inner)
            if len(t) > 60:
                prose.append(t)
        if head is None:
            overview += prose
        elif prose:
            sections[head] = prose

    measures = {}
    for label, value in general.items():
        key_units = SC_LABELS.get(label.lower())
        if not key_units or not value:
            continue
        key, units = key_units
        n = SC_NUM.search(value)
        if not n:
            continue
        v = float(n.group(1).replace(',', ''))
        measures.setdefault(key, {
            'value': int(v) if v == int(v) and units == 'count' else v,
            'units': units, 'text': '%s: %s' % (label, value)})
    return {'name': name, 'overview': overview, 'general': general,
            'sections': sections, 'measures': measures, 'species': []}

if __name__ == '__main__':
    sys.exit(main())
