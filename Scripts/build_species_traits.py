#!/usr/bin/env python3
r"""build_species_traits.py -- what each state publishes about a FISH, as opposed to a water.

    py .\scripts\build_species_traits.py
    py .\scripts\build_species_traits.py --go

Dry run by default, like every other writer in this pipeline. `--go` writes
registry/species_traits.json.

WHY THIS EXISTS. `biology.spawnTiming`, `baitfishMovement` and `forageSpatial` were cut on
2026-09-01 when the biology agent was retired: we had both concluded the corpus did not answer
them, because a lake's documents do not say when a fish spawns. That premise has changed. Both
states publish the answer per SPECIES, and both were already on the drive:

    SC  FreshwaterFishPocketGuide.pdf     43 species spreads, ten labelled sections each --
                                          Description, Range, Average Length, Average Size,
                                          Maximum Age, Preferred Habitat, Food Habits, Spawning,
                                          Miscellaneous, Commonly Mistaken Species
    NC  NC_Lakes\*species-profile*.pdf    10 profiles on NC WRC's Wildlife Profiles template

    "Spawning usually begins when water temperatures range between 65-75F, around April to June.
     The male largemouth bass constructs a saucer-shaped nest at a depth of 2 to 10 feet."   SCDNR
    "Walleye spawning in North Carolina begins in late February as water temperatures reach 42
     degrees... Most walleye spawning takes place at depths of 2 to 4 ft."                   NCWRC

THIS IS NOT THE FIELD THAT WAS CUT. That one was per-lake, and storing a statewide paragraph on
sixty-four lake profiles is the copy-on-every-water shape this refactor keeps deleting. This is
keyed by species, and the consumer is the fisheries prompt -- the same place the GA DNR `Target`
paragraphs go -- so the model anchors on the state's numbers instead of its own recollection. The
app already knows today's water temperature; "black crappie spawn as temperatures approach 60F"
beside a live 58 reading is a plan input in a way that "spawn timing: spring" never was.

BOTH DOCUMENTS ARE MULTI-COLUMN AND READING THEM AS ONE INVENTS SENTENCES. The guide's left
column is Description and its right column is Spawning, so a line-by-line read gives "The upper
jaw extends back past the rear Spawning: Spawning usually begins when water". Any number quoted
out of that text is attached to the wrong sentence. bands() below finds the real gutter.

Personal use only, not for distribution or resale; not for navigation.
"""
import argparse, collections, glob, json, os, re, sys
from datetime import datetime, timezone

SC_GUIDE = 'FreshwaterFishPocketGuide.pdf'
TN_GUIDE = 'anglersguide.pdf'
NC_DIR = 'NC_Lakes'
NC_PROFILE = '*species-profile*.pdf'
MARK = '\x01'                                  # wraps a heading inside the assembled page text

# SCDNR's own ten labels. Every species spread prints all ten, so ">= 6 of these" identifies a
# text page without any assumption about where in the book it sits.
SC_LABELS = ['Description', 'Range', 'Average Length', 'Average Size', 'Maximum Age',
             'Preferred Habitat', 'Food Habits', 'Spawning', 'Miscellaneous',
             'Commonly Mistaken Species']
SC_RX = re.compile(r'\b(%s)\s*:\s*' % '|'.join(SC_LABELS))

# NC WRC's Wildlife Profiles template. These four are the prose; the rest of the sheet is Range
# Map, Wild Facts, Classification, People Interactions, Q&A, Links, References and Credits, none
# of which describe the fish. NCWRC spells the habitat heading three ways across the ten sheets
# ("Habitat and Habits", "Habitats & Habits", and on the walleye sheet not at all) -- nc_head()
# folds the spellings and NC_FALLBACK covers the sheet that omits it.
NC_CONTENT = ['Description', 'Range and Distribution', 'History and Status', 'Habitat and Habits']
NC_FALLBACK = 'History and Status'

# What a plan can act on. The rest is read, reported and simply not carried into the file.
SC_USEFUL = ['Spawning', 'Preferred Habitat', 'Food Habits', 'Range']
NC_USEFUL = ['Habitat and Habits']
# TWRA prints no labelled sections at all. The account IS the section, so there is nothing to
# choose between -- and it is where the spawning temperature lives: "Spawning activity begins when
# water temperatures approach 62-65 F."
TN_USEFUL = ['Account']


# ---------------------------------------------------------------- reading a page as a human does

def page_lines(pg):
    """The page's words grouped into visual lines, each line left to right."""
    d = collections.defaultdict(list)
    for w in pg.extract_words(extra_attrs=['size']):
        d[round(w['top'] / 2.5)].append(w)
    return [sorted(v, key=lambda w: w['x0']) for _, v in sorted(d.items())]


def join_words(ws):
    """Join a line's words, WITHOUT a space where the two boxes touch exactly.

    Both documents split their fi/fl/ff ligatures into their own text run, and the run's advance
    puts the next box at exactly the same x -- "sunfi sh", "diff erent", "off spring". Measured
    across all eleven PDFs the split is unmistakable: 632 of these gaps fall between -0.017 and
    +0.001, then NOTHING until +0.028, and real word spaces run from +0.7 up. So the test is "the
    boxes touch", not a list of ligatures, and it needs no list to keep up to date. The window has
    to be this tight -- at 0.6 the tightest justified lines join too, and NCWRC's black crappie
    sheet reads "slow-movingrivers".
    """
    out = ws[0]['text']
    for a, b in zip(ws, ws[1:]):
        gap = b['x0'] - a['x1']
        out += ('' if -0.02 < gap < 0.01 else ' ') + b['text']
    return out


def zones(pg, min_gap=24):
    """The page's horizontal bands, split where whitespace runs the full width of the page.

    A page is not columnar all the way down. NC WRC's American shad sheet is a body column and a
    margin column above y=560 and a two-column Wild Facts box below y=614, and one vertical cut
    for the whole page cannot be right for both -- read that way, "Classification / Class:
    Osteichthyes" lands in the middle of the sentence about anadromy. Finding the columns inside
    each zone is the same search as bands(), turned ninety degrees.

    The cut is at 24pt because that is well clear of the 11pt a heading leaves above itself and
    well under the 47pt below every masthead.
    """
    occ = [0] * (int(pg.height) + 2)
    for w in pg.extract_words():
        for y in range(max(0, int(w['top'])), min(len(occ) - 1, int(w['bottom'])) + 1):
            occ[y] = 1
    out, top, run = [], 0, None
    for y in range(len(occ)):
        if not occ[y]:
            if run is None:
                run = y
        else:
            if run is not None and y - run >= min_gap:
                if y - top > min_gap:
                    out.append((top, run))
                top = y
            run = None
    out.append((top, len(occ)))
    return [z for z in out if z[1] > z[0]]


def bands(lines, x_lo, x_hi, min_gutter=11, tol=0.06, min_lines=8):
    """The x-range of each text column, found by looking for a gutter the words never cross.

    This is not nc_runs() in build_agency_lake_facts.py and must not be folded into it. That one
    separates a body column from a margin caption on an NC fact sheet and reads body-first. This
    one finds however many columns a zone actually has, and reads each to its end before starting
    the next -- which is what makes "Average Size: 3-8 ounces." come out as one sentence.

    A zone with fewer than min_lines lines is not columnar, it is a title block; two words either
    side of a picture are not a gutter, and treating them as one splits "SMALLMOUTH BASS" in half.
    """
    if len(lines) < min_lines:
        return []
    hits = [0] * (x_hi - x_lo + 2)
    for ln in lines:
        seen = set()
        for w in ln:
            for b in range(max(x_lo, int(w['x0'])), min(x_hi, int(w['x1'])) + 1):
                seen.add(b)
        for b in seen:
            hits[b - x_lo] += 1
    thr = int(len(lines) * tol)              # a banner across the top is not an occupied column
    occ = [i for i, h in enumerate(hits) if h > thr]
    if not occ:
        return []
    lo, hi = occ[0], occ[-1]
    cuts, run = [lo], None
    for i in range(lo, hi + 1):
        if hits[i] <= thr:
            if run is None:
                run = i
        else:
            if run is not None and i - run >= min_gutter:
                cuts.append((run + i) // 2)
            run = None
    cuts.append(hi + 1)
    return [(x_lo + cuts[i], x_lo + cuts[i + 1]) for i in range(len(cuts) - 1)]


def page_rows(pg, body=None):
    """[(text, top, is_heading, in_flow)] in reading order: zone by zone, then column by column.

    dedupe_chars() first. The guide draws some of its titles twice at identical coordinates --
    page 27 is GREEN SUNFISH over itself -- and the two copies interleave character by character
    into "GGRREEEENN SSUUNNFFIISSHH".

    A row is a heading when every word on it is set at least 2pt larger than the document's body
    size. That is what the PDF itself encodes, so it needs no list of headings to keep up to date,
    and it reads the sheet whose heading the designer forgot as well as the nine that have one.

    in_flow separates a zone's running prose from a MARGIN COLUMN. An NC sheet is one wide body
    column plus a narrow sidebar carrying Range and Distribution, Range Map and Wild Facts; the
    guide's pages are two columns of equal width and both are prose. A band narrower than 60% of
    the widest one in its zone is the sidebar, and the difference matters at a page break: the
    habitat section that runs off the bottom of page 1 continues at the top of page 2 in the BODY,
    not under whatever heading the sidebar happened to end on.
    """
    pg = pg.dedupe_chars()
    x_lo, x_hi = int(pg.bbox[0]), int(pg.bbox[2])
    lines = page_lines(pg)
    rows = []
    for z0, z1 in zones(pg):
        ls = [ln for ln in lines if z0 <= ln[0]['top'] < z1]
        if not ls:
            continue
        bs = bands(ls, x_lo, x_hi) or [(x_lo, x_hi + 1)]
        widest = max(b - a for a, b in bs)
        for a, b in bs:
            for ln in ls:
                part = [w for w in ln if a <= (w['x0'] + w['x1']) / 2 < b]
                if not part:
                    continue
                t = join_words(part).strip()
                if not t or re.fullmatch(r'\d{1,3}', t):        # a page number
                    continue
                head = bool(body) and len(t) < 44 and all(w['size'] >= body + 2 for w in part)
                rows.append((t, part[0]['top'], head, (b - a) >= widest * 0.6))
    return rows


def body_size(pdf):
    """The size most of the document's words are set at."""
    c = collections.Counter()
    for pg in pdf.pages:
        for w in pg.extract_words(extra_attrs=['size']):
            c[round(w['size'], 1)] += 1
    return c.most_common(1)[0][0] if c else None


MASTHEAD = 0.08     # of the page height


def is_masthead(top, height):
    """A row in the top 8% of the page is the sheet's running header, not its content.

    Every NC sheet reprints the fish's name and "Wildlife Profiles - North Carolina Wildlife
    Resources Commission" above the text on each page. Left in, the reprint reads as a new heading
    and cuts the habitat section in half -- bluegill's habitat text was coming out under a heading
    called "Bluegill" -- and the masthead itself lands mid-sentence in the merged section. Across
    the ten sheets the running header sits at 1.8% to 4.9% of page height and the first line of
    body text never starts above 9.2%, so the cut is at 8%.
    """
    return top < height * MASTHEAD


# ---------------------------------------------------------------------------- the two documents

def norm_species(s):
    """normalizeResearchName() from Worker/research/facts-util.js, character for character.

    A lookup that lowercases and nothing else is a DIFFERENT vocabulary from the app's. The guide
    prints "STRIPED BASS x WHITE BASS, Hybrid"; the app's table already holds
    'striped bass x white bass hybrid'. Only the app's own normalisation joins them.
    """
    return re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9]+', ' ', str(s or '').lower())).strip()


def species_vocab(root):
    """RESEARCH_SPECIES_CANON, READ OUT OF THE WORKER rather than retyped.

    Same reason build_agency_lake_facts.nc_species_vocab does it: a second copy of the app's
    species vocabulary in Python is a second copy to drift. Returns {alias: canonical}.
    """
    src = os.path.join(root, 'TrollMap-Dev', 'Worker', 'research', 'facts-util.js')
    if not os.path.exists(src):
        return {}
    txt = open(src, encoding='utf-8').read()
    i = txt.find('RESEARCH_SPECIES_CANON')
    if i < 0:
        return {}
    seg = txt[i:txt.find('};', i)]
    return {norm_species(m.group(1)): m.group(2)
            for m in re.finditer(r"^\s*'([^']+)'\s*:\s*'([^']+)'", seg, re.M)}


def dehyphen(t):
    """A word the typesetter broke across a line comes back whole: "reser- voirs" -> reservoirs."""
    return re.sub(r'(\w)- (\w)', r'\1\2', t)


# TENNESSEE'S GUIDE IS PROSE UNDER A NAME, WITH NO LABELS ANYWHERE.
#
# `anglersguide.pdf` -- TWRA's Angler's Guide to Tennessee Fish, 80 pages -- gives each species a
# bold name, an italic binomial, an "Other names:" line and then two or three paragraphs. It is the
# THIRD state, and until now a Tennessee water was handed South Carolina's account of its fish and
# told in the prompt that it was the neighbouring state's.
#
# It is also the document that settled the black bass question, in the regulation's own words:
# "The term, black bass, refers to several species of bass in Tennessee including smallmouth,
# largemouth, spotted, redeye (Coosa) and the recently recognized Alabama bass."
#
# THE FONT SEPARATES THE PROSE FROM THE FURNITURE, so nothing has to be guessed by length or
# position: the body is WarnockPro-Regular at 10pt, the photo credit is the same face italic at
# 6pt ("Brian James"), and the anatomy caption is bold italic at 8pt ("jaw extends behind eye")
# sitting at x=249 in the middle of a sentence about vegetation. Read by line, that caption lands
# between "prefer calm, warmer waters in" and "rivers, lakes, reservoirs".
# `(Morone saxatilis x M. chrysops)` is the Cherokee bass, and a genus-species-only pattern does
# not match it -- so its heading was neither a binomial nor, being half bold and half italic, a
# single-face heading row. It closed nothing, and its whole account ran on into the yellow bass.
TN_BINOMIAL = re.compile(r'\(([A-Z][a-z]+\.? [a-z]+[^)]*)\)')
TN_OTHER = re.compile(r'^Other names?:\s*', re.I)


def body_face(pdf):
    """The (fontname, size) most of the document's words are set in."""
    c = collections.Counter()
    for pg in pdf.pages:
        for w in pg.extract_words(extra_attrs=['size', 'fontname']):
            c[(str(w['fontname']).split('+')[-1], round(w['size'], 1))] += 1
    return c.most_common(1)[0][0] if c else (None, None)


def tn_rows(pg, face):
    """[(text, prose, {fontnames}, largest size)] for one page, in reading order.

    `prose` is the row's BODY WORDS ONLY, which is not the same as "the row is body". TWRA sets an
    anatomy caption at x=249 on the same baseline as a sentence, so the row reads
    "Black crappie are found in quiet, warm waters, and are often as- crappie" -- rejecting the
    whole row because it is not uniformly body loses the sentence and the account starts at
    "sociated with aquatic vegetation". Filtering the words keeps the sentence and drops the
    caption. A row with no body words at all is a heading or furniture, and the caller tells those
    apart by size.
    """
    out = []
    for ln in page_lines_faced(pg):
        t = join_words(ln).strip()
        if not t or re.fullmatch(r'\d{1,3}', t):
            continue
        body = [w for w in ln
                if str(w['fontname']).split('+')[-1] == face[0] and round(w['size'], 1) == face[1]]
        prose = join_words(body).strip() if body else ''
        out.append((t, prose, {str(w['fontname']).split('+')[-1] for w in ln},
                    max(round(w['size'], 1) for w in ln)))
    return out


def page_lines_faced(pg):
    d = collections.defaultdict(list)
    for w in pg.dedupe_chars().extract_words(extra_attrs=['size', 'fontname']):
        d[round(w['top'] / 2.5)].append(w)
    return [sorted(v, key=lambda w: w['x0']) for _, v in sorted(d.items())]


def read_tn_guide(path):
    """One entry per species account.

    The name and its binomial share a baseline but not a line bucket -- the italic sits 0.6pt
    higher -- so they arrive as two rows in the order (binomial, name), and a name that wraps
    leaves its LAST word on the binomial's row: "Bass(Morone mississippiensis)" then "Yellow".
    Both halves are put back rather than one of them being dropped, which is why Yellow Bass,
    Largemouth, Spotted and Redeye are here at all.
    """
    import pdfplumber
    out = []
    with pdfplumber.open(path) as pdf:
        face = body_face(pdf)
        if not face[0]:
            return []
        rows = []
        for pg in pdf.pages:
            rows.extend(tn_rows(pg, face))
    # THE HEADING FACE IS LEARNED, NOT NAMED. Every species name is set in one face and the body
    # in another; taking the face of the rows that sit beside a binomial says which is which
    # without this file knowing that TWRA's designer picked Warnock Pro.
    #
    # It matters because a heading with NO binomial still ends an account, and there are several:
    # "Temperate Bass Comparison Chart", the Cherokee bass (a hybrid, so no species name of its
    # own), the "Crappie" and "Sunfishes" group headings. Without them Yellow Bass ran on into the
    # Cherokee bass account and Redeye Bass into the crappie.
    heads = collections.Counter()
    for i, (t, prose, fname, _sz) in enumerate(rows):
        # ONLY the row that supplies the NAME. Counting the binomial's own row too elects the
        # italic face, and then every species account reads as a heading and the file empties.
        if (TN_BINOMIAL.search(t) and not prose and not TN_BINOMIAL.sub('', t).strip()
                and i + 1 < len(rows) and not rows[i + 1][1]):
            for f in rows[i + 1][2]:
                heads[f] += 1
    head_face = heads.most_common(1)[0][0] if heads else None

    cur, other, used = None, False, -1
    for i, (t, prose, fname, size) in enumerate(rows):
        # The row the heading borrowed its name from is part of the heading, not a boundary after
        # it. Without this the binomial row opens the account and the name row closes it again.
        if i == used:
            continue
        m = TN_BINOMIAL.search(t)
        if m and not prose:
            tail = TN_BINOMIAL.sub('', t).strip()
            head, borrowed = '', -1
            if i + 1 < len(rows) and not rows[i + 1][1]:
                head, borrowed = rows[i + 1][0].strip(), i + 1
            name = ' '.join(x for x in (head, tail) if x).strip(' -')
            if name and len(name) < 40:
                used = borrowed
                cur = {'name': name.title(), 'scientific': m.group(1),
                       'sections': {}, 'page': None, '_lines': []}
                out.append(cur)
                other = False
                continue
        if not prose and (head_face in (fname or set()) or size > face[1]):
            # A HEADING OF ANY KIND CLOSES THE ACCOUNT, and TWRA writes two kinds. A species name
            # is the body face turned BOLD at the same size; a section heading -- "Crappie",
            # "Sunfishes", "Temperate (True) Bass" -- is the body face at 24pt. Testing only the
            # bold face let the group headings through, and redeye bass ran on into the crappie.
            #
            # The photo credit (6pt italic) and the anatomy caption (8pt bold italic) are also
            # rows with no body words, and they sit INSIDE an account -- "TWRA Staff" lands
            # between the second and third paragraphs of the largemouth bass. Both are SMALLER
            # than the body, which is what separates furniture from a heading.
            #
            # It does not OPEN an account unless a binomial came with it, which is what keeps the
            # comparison charts out of the file.
            cur, other = None, False
            continue
        if not cur or not prose:
            continue
        if TN_OTHER.match(prose):
            # "Other names: brassy bass," / "striped jack, stripe," / "yellow belly," / "barfish"
            # -- the list wraps, and every line but the last ends in a comma. Consuming only the
            # first line put "striped jack, stripe, yellow belly, barfish" at the head of the
            # yellow bass account, where a reader would take it for a sentence.
            other = prose.rstrip().endswith(',')
            continue
        if other:
            other = prose.rstrip().endswith(',')
            continue
        cur['_lines'].append(prose)
    for e in out:
        text = dehyphen(re.sub(r'\s+', ' ', ' '.join(e.pop('_lines'))).strip())
        if len(text) > 60:
            e['sections']['Account'] = text
    return out


def sc_sections(text):
    parts = SC_RX.split(dehyphen(re.sub(r'\s+', ' ', text)))
    out = collections.OrderedDict()
    for a, b in zip(parts[1::2], parts[2::2]):
        out.setdefault(a, b.strip())
    return out


def sc_title(pg):
    """A spread's title page: the biggest type below the section banner is the fish's name.

    Every title page is the same three pieces -- a 22pt group banner at the top ("Sunfish &
    Blackbass"), the 22pt species name over the illustration, and a 15pt italic binomial under it.
    Taking the largest size below the banner reads "STRIPED BASS x WHITE BASS, Hybrid" as
    correctly as "BLUEGILL", where looking for an ALL-CAPS line misses it.
    """
    pg = pg.dedupe_chars()
    ws = [w for w in pg.extract_words(extra_attrs=['size']) if w['top'] > pg.height * 0.15]
    if not ws:
        return None, None
    big = max(round(w['size'], 1) for w in ws)
    name = [w for w in ws if round(w['size'], 1) == big]
    rest = [w for w in ws if round(w['size'], 1) < big and w['top'] > min(x['top'] for x in name)]
    sub = []
    if rest:
        nxt = max(round(w['size'], 1) for w in rest)
        sub = [w for w in rest if round(w['size'], 1) == nxt]

    def read(g):
        d = collections.defaultdict(list)
        for w in g:
            d[round(w['top'] / 2.5)].append(w)
        return ' '.join(join_words(sorted(v, key=lambda w: w['x0'])) for _, v in sorted(d.items()))

    return (read(name).title() if name else None), (read(sub) if sub else None)


def read_sc_guide(path):
    """One entry per species spread, found by the SECOND page of the spread.

    A page that prints six or more of SCDNR's ten labels is a species text page, whatever else is
    around it; its title page is the one before it. Finding the spread this way rather than by
    hunting for a latin binomial picks up the Palmetto bass hybrid, which has ten labelled
    sections and no binomial to hunt for.
    """
    import pdfplumber
    out, skipped = [], []
    with pdfplumber.open(path) as pdf:
        texts = ['\n'.join(t for t, _, _, _ in page_rows(pg)) for pg in pdf.pages]
        for i, t in enumerate(texts):
            secs = sc_sections(t)
            if len(secs) < 6 or i == 0:
                continue
            name, sub = sc_title(pdf.pages[i - 1])
            if not name:
                skipped.append('%s page %d has %d SCDNR labels but page %d carries no title'
                               % (os.path.basename(path), i + 1, len(secs), i))
                continue
            binomial = sub if sub and re.match(r'^\(?[A-Z][a-z]+ [a-z]+\)?$', sub) else None
            out.append({'name': name, 'scientific': binomial, 'sections': secs, 'page': i + 1})
    return out, skipped


def nc_head(t):
    """One printed heading, folded to the name the template means."""
    t = re.sub(r'\s+', ' ', t.replace('&', 'and')).strip(' .:')
    t = re.sub(r'^Habitats\b', 'Habitat', t, flags=re.I)
    for c in NC_CONTENT:
        if t.lower() == c.lower():
            return c
    return None


def read_nc_profile(path):
    import pdfplumber
    name = re.sub(r'^\d+_', '', os.path.basename(path))
    name = re.sub(r'-species-profile\.pdf$', '', name, flags=re.I).replace('-', ' ').title()
    with pdfplumber.open(path) as pdf:
        body = body_size(pdf)
        if not body:
            return {'name': name, 'scientific': None, 'sections': {}, 'page': 1,
                    'why': 'no text layer -- the sheet is a scan'}
        height = pdf.pages[0].height
        rows = [[r for r in page_rows(pg, body) if not is_masthead(r[1], height)]
                for pg in pdf.pages]
    secs, flow = collections.OrderedDict(), None
    for page in rows:
        # The body column first, carrying its open section across the page break; then the
        # sidebar, whose headings start and end on the page they are printed on.
        for stream in (True, False):
            cur = flow if stream else None
            for t, _, head, in_flow in page:
                if in_flow != stream:
                    continue
                if head:
                    cur = nc_head(t)
                    if cur:
                        secs.setdefault(cur, [])
                elif cur and cur in secs:
                    secs[cur].append(t)
            if stream:
                flow = cur
    secs = collections.OrderedDict((k, dehyphen(re.sub(r'\s+', ' ', ' '.join(v)).strip()))
                                   for k, v in secs.items() if v)
    return {'name': name, 'scientific': None, 'sections': secs, 'page': 1}


# ------------------------------------------------------------------------------------------ main

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--root', default='.', help='the pipeline root')
    ap.add_argument('--out', default=None, help='default <root>/registry/species_traits.json')
    ap.add_argument('--go', action='store_true', help='actually write; dry run without it')
    a = ap.parse_args()
    root = os.path.abspath(a.root)
    out = a.out or os.path.join(root, 'registry', 'species_traits.json')

    canon = species_vocab(root)
    if not canon:
        print('!! could not read RESEARCH_SPECIES_CANON out of the repo -- species names would '
              'not be the app\'s own. Not writing.')
        return 2
    print('vocabulary: %d aliases -> %d canonical names'
          % (len(canon), len(set(canon.values()))))

    entries, notes = [], []
    sc = os.path.join(root, SC_GUIDE)
    if os.path.exists(sc):
        got, skipped = read_sc_guide(sc)
        notes += skipped
        print('SCDNR  %-42s %d species spread(s)' % (SC_GUIDE, len(got)))
        for g in got:
            entries.append(('SC', 'SCDNR', SC_GUIDE, SC_USEFUL, g))
    else:
        print('!! %s is not beside the root -- no SC species traits' % SC_GUIDE)

    tn = os.path.join(root, TN_GUIDE)
    if os.path.exists(tn):
        got = read_tn_guide(tn)
        print('TWRA   %-42s %d species account(s)' % (TN_GUIDE, len(got)))
        for g in got:
            entries.append(('TN', 'TWRA', TN_GUIDE, TN_USEFUL, g))
    else:
        print('!! %s is not beside the root -- no TN species accounts' % TN_GUIDE)

    ncs = sorted(glob.glob(os.path.join(root, NC_DIR, NC_PROFILE)))
    print('NCWRC  %-42s %d profile(s)' % (os.path.join(NC_DIR, NC_PROFILE), len(ncs)))
    for p in ncs:
        g = read_nc_profile(p)
        # The walleye sheet prints its habitat and spawning prose under "History and Status" and
        # has no habitat heading at all. Fall back only when the habitat section is truly absent.
        useful = NC_USEFUL if any(k in g['sections'] for k in NC_USEFUL) else [NC_FALLBACK]
        entries.append(('NC', 'NCWRC', os.path.basename(p), useful, g))

    species, unknown = {}, []
    for state, agency, fname, useful, g in entries:
        key = canon.get(norm_species(g['name']))
        if not key:
            unknown.append('%-34s %s  no name in the app\'s vocabulary' % (g['name'], state))
            continue
        keep = {k: v for k, v in g['sections'].items() if k in useful and len(v) > 30}
        if not keep:
            unknown.append('%-34s %s  %s' % (g['name'], state,
                                             g.get('why') or 'none of %s carried text' % useful))
            continue
        species.setdefault(key, []).append({
            'state': state, 'agency': agency, 'source': fname, 'page': g.get('page'),
            'scientific': g.get('scientific'), 'sections': keep,
        })

    chars = sum(len(v) for rows in species.values() for r in rows for v in r['sections'].values())
    print('\n%d canonical species, %d rows, %d characters of agency prose:'
          % (len(species), sum(len(v) for v in species.values()), chars))
    for k in sorted(species):
        for r in species[k]:
            print('   %-32s %s  %s' % (k, r['state'],
                                       ', '.join('%s %d' % (s, len(t))
                                                 for s, t in r['sections'].items())))
    if unknown:
        # NAMED, NOT DROPPED. A fish the app has no word for is a fish the plan cannot ask about,
        # and that is worth seeing rather than silently losing.
        print('\n%d read but not written:' % len(unknown))
        for u in unknown:
            print('   ', u)
    for n in notes:
        print('   !!', n)

    doc = {'generated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
           'source': 'SCDNR Guide to Freshwater Fishes of South Carolina; '
                     'NC WRC Wildlife Profiles',
           'note': 'Per-SPECIES and statewide, not per-water. Built by build_species_traits.py '
                   '-- do not hand-edit. Personal use only, not for distribution or resale; '
                   'not for navigation.',
           'species_count': len(species), 'species': species}
    if not a.go:
        print('\ndry run -- add --go to write %s' % out)
        return 0
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(doc, f, indent=1, ensure_ascii=False)
    print('\n-> %s' % out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
