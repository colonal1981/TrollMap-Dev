#!/usr/bin/env python3
"""
parse_ga_fish_advisories.py -- Georgia's fish consumption guidelines as a species presence floor.

Personal use only, not for distribution or resale; not for navigation.

    py .\\scripts\\parse_ga_fish_advisories.py --registry "F:\\TrollMapPipeline\\registry"

Reads   <root>\\2023 FCG Booklet.pdf     (Guidelines For Eating Fish From Georgia Waters, GA EPD)
Writes  registry\\ga_fish_advisories.json          published
        registry\\_ga_fish_advisories_review.json  ambiguity, misses, and every row not read

WHY THIS EXISTS

The same reason the South Carolina one does, on the state where it pays most. Georgia has 40
waters in the app with no species source -- the largest hole of the four states -- and its DNR
ramp feeds carry species for only 52 of 95. Ryan settled the scope himself: *"if the lake is in
the app and that gives us info for species in the lake then we use it"*, so the whole book is
read, above and below 500 acres, and the binder drops whatever is not a water we ship.

THE BOOK HAS NO COORDINATES, AND THAT IS THE HARD PART

fetch_sc_fish_advisories.py binds name AND geometry, because South Carolina publishes polygons.
Geometry is what separated the two Lake Robinsons 190 km apart and what kept the Black Mingo
Creek advisory off the Black River whose boundary contains 85% of it. Georgia publishes a
booklet. There is nothing to point-in-polygon against, so the second signal has to be the county,
and every record says which signal it got:

  1. GEORGIA-ASSOCIATED WATERS ONLY, WHICH IS NOT `state == 'GA'`. Hartwell, Tugaloo, Yonah,
     Russell and Thurmond are all in this book and several carry a primary state of SC in our
     index -- the same border-water hole that lost Lake Wylie and J. Strom Thurmond in the first
     SC run until the state pre-filter came out. A water qualifies if its state is GA or its
     display name says GA anywhere.
  2. DISTINCTIVE TOKENS ONLY. "Lake", "River", "Creek", "Pond" identify nothing.
  3. THE COUNTY IS THE SECOND SIGNAL WHERE THE BOOK GIVES ONE. It writes "Mud Creek (Near Lula,
     Hall County)" and our display names carry "(Hall Co, GA)".
  4. AMBIGUITY IS FLAGGED, NOT GUESSED. Ryan: *"if there is ambiguity flag it and then i will
     look at it"*.

THE FONT IS THE STRUCTURE. THAT IS A MEASUREMENT, NOT A LAYOUT GUESS.

The first version of this file read the single line of text above each table and took it for the
water's name. That is wrong for a third of the book, because Georgia prints a river once and then
lists its reaches underneath:

    Chattahoochee River                                          <- Calibri-Bold 9pt
    (Buford Dam to Morgan Falls Dam)      Chattahoochee River Basin  <- Bold + BoldItalic 9pt
    Species          Site Tested        Recommendation  Chemical  <- Calibri-Bold, inside the table
    Trout Spp.       at Buford Hatchery No Restrictions           <- Calibri plain

Reading one line got `(Buford Dam to Morgan Falls Dam)`, which names no water at all, and the
Withlacoochee, the Conasauga, the Suwannee and St Catherines Sound were lost the same way. Worse,
`Barnett Shoals Dam to Lake Oconee` is a reach of the OCONEE RIVER and contains the word "Lake
Oconee" -- so a rule that pattern-matches reach shapes binds a river advisory onto a reservoir.

So the heading is read as the run of BOLD lines directly above the table, stopping at the first
line that is not bold or is set at a different size. The size test is what keeps the 12pt section
title "Georgia Public Lakes" and the 16pt "SPECIAL LISTINGS" out of the water's name while
letting the 9pt parent "Turtle River System:" in, which is a real part of it.

THE BASIN IS SPLIT OFF WITH A REGEX, NOT WITH THE ITALIC FLAG, even though the basin is always
BoldItalic. Two headings have a font run that breaks mid-word -- "Chattahoochee River Basin"
arrives as name "C" + basin "hattahoochee River Basin", and "Oconee River (Laurens County" keeps
its closing bracket in the basin -- so the italic flag locates the basin but cannot cut it
cleanly. The word "Basin" can.

TWO TABLES SWALLOW THEIR OWN HEADING. pdfplumber's ruling for Dodge County PFA (p22) and
Tallulah River (p40) starts one line higher, so the heading lands in the first cell and the line
above the table belongs to the PREVIOUS water -- which is how "Factory Pond", a site name in the
Spirit Creek table, came to be read as a water. When no bold heading is found and the first cell
names a basin, the first cell is the heading.

WHAT THIS FILE DOES NOT DO IS NAME FISH.

Every species phrase is published exactly as Georgia writes it, with only structural work done to
it: a footnote marker comes off, a size qualifier is split into its own field, and a compound
row is split into the fish it names. Turning "Bluegill Sunfish" into "Bluegill" is vocabulary,
and this codebase already has exactly one place for that -- RESEARCH_SPECIES_CANON in
Worker/research/facts-util.js, which the species floor already runs every name through. A second
private table here is how two vocabularies drift apart. Anything the book says that resolves to
nothing is REPORTED, per row and with its page, rather than guessed at or dropped.
"""

import argparse
import json
import os
import re
import sys

OUT_NAME = 'ga_fish_advisories.json'
REVIEW_NAME = '_ga_fish_advisories_review.json'
DEFAULT_PDF = '2023 FCG Booklet.pdf'
SOURCE = 'GA EPD, Guidelines For Eating Fish From Georgia Waters 2023'

GENERIC = {
    'lake', 'lakes', 'river', 'rivers', 'creek', 'creeks', 'pond', 'ponds', 'reservoir',
    'reservoirs', 'branch', 'run', 'fork', 'bay', 'sound', 'swamp', 'canal', 'basin', 'county',
    'counties', 'north', 'south', 'east', 'west', 'upper', 'lower', 'little', 'big', 'old',
    'new', 'near', 'the', 'and', 'ga', 'georgia', 'state', 'park', 'wildlife', 'management',
    'area', 'public', 'fishing', 'pfa', 'impoundment', 'system', 'special', 'listings',
    'estuary', 'arm', 'main', 'body', 'dam', 'hwy', 'road', 'bridge', 'mile', 'above', 'below',
    'millpond', 'mill', 'ponds', 'watershed', 'proj', 'unnamed', 'middle', 'saint',
}

# THE WORDS THAT ARE NOT NOISE JUST BECAUSE THEY ARE NOT NAMES. They identify nothing on their
# own, so they are stripped above -- and stripping them made "North Oconee River" agree with the
# Oconee River, "Middle Oconee River" with the same, and "Ocmulgee PFA Lake" with Little Ocmulgee
# Lake 60 km away. A qualifier one name carries and the other does not is a DIFFERENCE. Three
# wrong binds, all three of them a river or a lake being confused with a different water that
# shares its basin's name.
QUALIFIERS = {'north', 'south', 'east', 'west', 'upper', 'lower', 'middle', 'little', 'big',
              'old', 'new'}


def qualifiers(s):
    return {t for t in re.findall(r"[a-z]+", str(s or '').lower()) if t in QUALIFIERS}

# '(Kershaw Co, SC)' -- OUR stamp, not part of the water's name. Stripped before the name gate
# runs, because leaving it in makes the COUNTY a name token: the book's "Evans County PFA" then
# "agreed" with Sands Pond and Glissons Millpond, two unrelated waters that happen to sit in
# Evans County, and "Jones Creek" agreed with Allisons Lake in Jones County.
COUNTY_STAMP = re.compile(r"\s*\([^)]*\bCo\.?\s*,\s*[A-Z]{2}(?:/[A-Z]{2})?\)")


def our_name(display_name):
    return COUNTY_STAMP.sub('', str(display_name or '')).strip()


def our_names(rec, slug=''):
    """Every name the index holds for one of our waters, not just the one it displays.

    THE INDEX ALREADY KNEW BOTH SPELLINGS. The first run reported two waters the book names one
    letter differently -- "Lake Tugalo" against our Tugaloo Lake, "Hamburg Millpond" against our
    Hamburgh Millpond -- and Ryan asked whether the other spelling is a real second lake. It is
    not, and the proof was already on disk: `legacy_display_names` on Tugaloo Lake lists "Lake
    Tugalo", "Tugalo Lake" and "Tugalo", and Hamburgh Millpond lists "Hamburg Mill Pond West".
    One GNIS id each. The binder was reading `display_name` alone and throwing the rest away.

    Measured before it was trusted: across the 99 Georgia-associated waters, NOT ONE alias string
    names two different slugs, so widening the gate this way cannot introduce a collision.

    The legacy strings carry two decorations that have to come off or they add tokens that are
    not names: the water-chain prefix, "Little Ogeechee River - Hamburg Mill Pond West", which
    would have made this pond a candidate for every Ogeechee River advisory; and a trailing state
    suffix, "Tugaloo Lake, SC/GA".
    """
    out, seen = [], set()
    for n in [rec.get('display_name') or slug, rec.get('name')] + (
            rec.get('legacy_display_names') or []):
        if not n:
            continue
        n = our_name(str(n).split(' - ')[-1])
        n = re.sub(r',\s*[A-Z]{2}(?:/[A-Z]{2})?\s*$', '', n).strip()
        if n and n.lower() not in seen:
            seen.add(n.lower())
            out.append(n)
    return out


def norm(s):
    return re.sub(r'[^a-z]', '', str(s or '').lower())


def tokens(s):
    """Lowercase word tokens with the generic geography removed. Same rule as the SC binder."""
    return {t for t in re.findall(r"[a-z']+", str(s or '').lower())
            if len(t) > 2 and t not in GENERIC}


def name_agrees(book_name, our_name):
    return tokens(book_name) & tokens(our_name)


# ── reading the book ────────────────────────────────────────────────────────────────────────

# The basin phrase ends in the word "Basin" and runs one to three capitalised tokens back:
# "Altamaha River Basin", "Chattahoochee/Flint River Basin (Apalachicola)", "St. Mary's Basin".
#
# THE RIGHTMOST MATCH IS THE RIGHT ONE, AND THE LEFTMOST IS A DISASTER. `re.search` returns the
# leftmost, and on "Jackson Lake Ocmulgee River Basin" that is "Lake Ocmulgee River Basin" -- so
# the water came out as "Jackson", "Savannah River (Fort Howard)" as "Savannah River (Fort", and
# "Lake Mayers (City of Baxley)" as "Lake Mayers (City of". Every one of those then bound to the
# wrong water or to none. The shortest basin is the last place the pattern can start.
BASIN_AT = re.compile(r"(?=([A-Z]\S*(?:\s+\S+){0,2}\s+Basin\b.*$))")

# `find_tables()` puts a swallowed heading in the first cell; this is how one is recognised.
SWALLOWED = re.compile(r'Basin\b|Atlantic Ocean', re.I)


def split_basin(line):
    """'Near Baxley, Ga. (U.S. Hwy 1) Altamaha River Basin' -> (name, basin)."""
    s = re.sub(r'\s+', ' ', str(line or '')).strip()
    for m in reversed(list(BASIN_AT.finditer(s))):
        # The rightmost match is the shortest basin, but two things are not a basin's first word.
        # "River Basin" on its own is not a basin -- on "Tallulah River Savannah River Basin" it
        # leaves the water named "Tallulah River Savannah". And a cut cannot fall after an
        # abbreviation: "Cumberland Sound St. Mary's Basin" is a sound and a basin, not
        # "Cumberland Sound St." and "Mary's Basin".
        if m.group(1).split()[0].lower().strip(',') in ('river', 'creek', 'rivers', 'basin'):
            continue
        before = s[:m.start()].split()
        if before and (before[-1].endswith(('/', '-'))
                       or (before[-1].endswith('.') and len(before[-1]) <= 3)):
            continue                  # 'St. Mary's', 'Chattahoochee/Flint' -- one phrase, not two
        return s[:m.start()].strip(), m.group(1).strip()
    return s, None


def split_heading_words(ws):
    """One heading line's words -> (name, basin), using the font and then repairing the seam.

    The basin is always BoldItalic and the water name is always Bold, so the font says exactly
    where the basin starts -- but pdfplumber breaks a word wherever the font changes, and this
    book changes font mid-word twice. "Chattahoochee River Basin" arrives as a bold "C" followed
    by an italic "hattahoochee", and "Oconee River (Laurens County)" leaves its closing bracket on
    the italic side. So the font locates the seam and the SPACING repairs it: two pieces printed
    with no gap between them are one word and belong on the same side.
    """
    ws = sorted(ws, key=lambda w: w['x0'])
    ital = [i for i, w in enumerate(ws) if 'Italic' in w.get('fontname', '')]
    if not ital:
        return split_basin(' '.join(w['text'] for w in ws))
    cut = ital[0]
    if cut > 0 and abs(ws[cut]['x0'] - ws[cut - 1]['x1']) < 1.0:
        cut -= 1                      # the seam fell inside a word; keep the word whole
    name = ' '.join(w['text'] for w in ws[:cut]).strip()
    basin = ' '.join(w['text'] for w in ws[cut:]).strip()
    lead = re.match(r'^([^A-Za-z0-9]+)\s*(.*)$', basin)
    if lead:                          # a stray bracket or comma that belongs to the name
        name = (name + lead.group(1)).strip()
        basin = lead.group(2).strip()
    if 'Basin' not in basin:
        return split_basin(' '.join(w['text'] for w in ws))
    pre, real = split_basin(basin)
    if real and pre:
        # The italic run started mid-phrase: "Oconee River (Laurens" + "County) Oconee River
        # Basin". Whatever sits in front of the basin proper is part of the water's name.
        name, basin = ('%s %s' % (name, pre)).strip(), real
    return name, basin


def _is_bold(w):
    return 'Bold' in w.get('fontname', '')


def heading_lines(words, top):
    """The run of bold lines directly above a table, top-to-bottom, each as its list of words.

    Stops at the first line that is not majority-bold OR is set at a different point size than
    the line touching the table. The size test is the one that matters: "SPECIAL LISTINGS" (16pt)
    and "Georgia Public Lakes" (12pt) are bold section titles sitting directly above a 9pt water
    heading, and without it the first lake on a page is named after the section it is filed under.
    """
    rows = {}
    for w in words:
        if w['bottom'] <= top + 1:
            rows.setdefault(round(w['bottom']), []).append(w)
    out, size = [], None
    for b in sorted(rows, reverse=True):
        ws = rows[b]
        if sum(1 for w in ws if _is_bold(w)) * 2 < len(ws):
            break
        line_size = round(max(w.get('size', 0) for w in ws), 1)
        if size is None:
            size = line_size
        elif abs(line_size - size) > 0.6:
            break
        out.append(ws)
        if len(out) >= 4:
            break
    return list(reversed(out))


def table_shape(header):
    """Which of the book's three table layouts this is, or None.

    lake      Species | Less than 12" | 12" - 16" | Over 16" | Chemical
    stream    Species | Site Tested   | Recommendation | Chemical
    location  Species | Location      | Recommendation | Chemical      (the ocean tables)

    MATCHED ON THE WORDS, NEVER THE PUNCTUATION. Across 71 lake tables the size header appears as
    `Less than 12"`, `12" - 16 "`, `12” – 16”`, and once as `12" - 16" 12" - 16"` -- a duplicated
    column, which is a typo in the book.
    """
    j = ' '.join(header).lower()
    if 'species' not in j:
        return None
    if 'site tested' in j:
        return 'stream'
    if 'less than' in j:
        return 'lake'
    if 'location' in j:
        return 'location'
    return None


def read_pdf(path):
    """[{page, names, basin, shape, header, rows}] -- every table in the book with its heading."""
    try:
        import pdfplumber
    except ImportError:
        raise SystemExit('parse_ga_fish_advisories.py needs pdfplumber: pip install pdfplumber')
    blocks = []
    with pdfplumber.open(path) as pdf:
        for pno, pg in enumerate(pdf.pages, 1):
            words = pg.extract_words(extra_attrs=['fontname', 'size'])
            for tb in sorted(pg.find_tables(), key=lambda t: t.bbox[1]):
                rows = tb.extract()
                if not rows:
                    continue
                lines = heading_lines(words, tb.bbox[1])
                hrow, names, basin = 0, [], None
                if lines:
                    for ws in lines:
                        nm, bs = split_heading_words(ws)
                        if bs:
                            basin = bs
                        if nm:
                            names.append(nm)
                else:
                    first = re.sub(r'\s+', ' ', (rows[0][0] or '')).strip() if rows[0] else ''
                    if first and SWALLOWED.search(first):
                        hrow = 1                        # the table ate its own heading
                        nm, basin = split_basin(first)
                        if nm:
                            names.append(nm)
                if not names:
                    continue
                header = [(c or '').strip() for c in (rows[hrow] if len(rows) > hrow else [])]
                blocks.append({'page': pno, 'names': names, 'basin': basin,
                               'shape': table_shape(header), 'header': header,
                               'rows': rows[hrow + 1:]})
    return blocks


# ── one table's rows ────────────────────────────────────────────────────────────────────────

ADVICE = re.compile(
    r'^\s*(?:do\s*not\s*eat[a-z ]*|no\s+restrictions?|harvesting\s+prohibited\W*|'
    r'\d+\s+meals?\s*/\s*\w+|\d+\s+meals?\s+per\s+\w+|one\s+meal\s*/\s*\w+)\s*\*?\s*$', re.I)

# "All Fish", "All Species", "Other Fish" -- a scope, not a fish. The rule the SC parser learned
# on Hartwell's "All Species of Fish" and Langley Pond's "All Other Fish".
NOT_A_SPECIES = re.compile(r'^\s*(all\b|any\b|other\b|every\b)', re.I)

# A row whose first cell is prose. Georgia prints its footnotes INSIDE the table, in the species
# column, so these arrive looking exactly like a fish until they are read.
#
# A LEADING ASTERISK IS ALWAYS A FOOTNOTE, NEVER A FISH. The species rows that carry a marker put
# it at the END -- "Largemouth Bass *", "Bass Spp. *" -- and the rows that start with one are the
# footnote those markers point at: "*Only Largemouth Bass greater than 14 inches may be kept",
# "*Bass: Largemouth & Shoal", "*See also Coosa River: Special Striped Bass". They also arrive
# with every advice cell empty, which is the second thing that gives them away.
PROSE = re.compile(r'^\s*(?:\*|NOTE\b|Note\b|See\s+also\b|Main\s+Body\.|Specific\s)', re.I)

# `26” and greater in length`, `<30”`, `>32"`, `16-30”`. Split off the name and kept beside the
# advice, because "1 meal/month on a striped bass over 26 inches" is not a statement about every
# striped bass in the river.
SIZE = re.compile(
    r'\s*((?:[<>]\s*[\d.]+\s*["\u201d\u2033]?'
    r'|[\d.]+\s*[-\u2013]\s*[\d.]+\s*["\u201d\u2033]?'
    r'|[\d.]+\s*["\u201d\u2033]?\s*(?:and\s+)?(?:greater|larger|above|and\s+over)[a-z\s]*))\s*$',
    re.I)

# `Spp.`, `Sp.` -- a plural marker, not part of a fish's name. The book writes "Catfish Spp." for
# the same group SC writes "Catfish (all species)". Twenty rows in this book carry it.
PLURAL = re.compile(r'\s*\bSp{1,2}\.?\s*$', re.I)

FOOTNOTE = re.compile(r'^\s*[*\u2020\u2021]+\s*|\s*[*\u2020\u2021]+\s*$')


def is_prose(cell):
    """True when the species column holds a sentence rather than a fish."""
    s = re.sub(r'\s+', ' ', str(cell or '')).strip()
    if not s:
        return False
    if PROSE.match(s):
        return True
    if 'http' in s.lower():
        return True
    return len(s.split()) >= 9


def split_size(name):
    """('Striped Bass 26” and greater in length') -> ('Striped Bass', '26” and greater in length')"""
    s = re.sub(r'\s+', ' ', str(name or '')).strip()
    m = SIZE.search(s)
    if not m:
        return s, None
    return s[:m.start()].strip(), m.group(1).strip()


def split_species(name):
    """One published phrase -> the fish it names. Structure only; nothing is renamed.

    Four shapes, all measured in this book:
        'Redbreast & Green Sunfish'                  -> Redbreast Sunfish, Green Sunfish
        'Yellow & Brown Bullhead'                    -> Yellow Bullhead, Brown Bullhead
        'Clams, Mussels, Oysters'                    -> three
        'Black Bass Sp. (Largemouth, Smallmouth, ...)' -> the book defining its own group inline
    """
    s = re.sub(r'\s+', ' ', str(name or '')).strip()
    if not s:
        return []

    # The book naming the members of its own group: '<Group> Sp. (A, B, C)'.
    m = re.match(r'^(.*?)\s*\((.+,.+)\)\s*$', s)
    if m:
        head = PLURAL.sub('', m.group(1)).strip()
        group = head.split()[-1] if head.split() else ''
        parts = [p.strip() for p in m.group(2).split(',') if p.strip()]
        if group and len(parts) > 1:
            return ['%s %s' % (p, group) if not p.lower().endswith(group.lower()) else p
                    for p in parts]

    # A plain comma list of single words: 'Clams, Mussels, Oysters'.
    if ',' in s and '(' not in s:
        parts = [p.strip() for p in s.split(',') if p.strip()]
        if len(parts) > 1 and all(len(p.split()) == 1 for p in parts):
            return parts

    # 'A & B Group' and 'A/B Group' -- the group word belongs to both halves.
    m = re.match(r'^(.*?)\s*[&/]\s*(.*)$', s)
    if m:
        left, right = m.group(1).strip(), m.group(2).strip()
        tail = right.split()
        if left and len(tail) > 1:
            group = tail[-1]
            return ['%s %s' % (left, group), right]
        if left and tail:
            return [left, right]
    return [s]


def clean_species(published):
    """(names, size). Footnote marker off, size split out, plural marker off, compound split."""
    s = FOOTNOTE.sub('', re.sub(r'\s+', ' ', str(published or '')).strip())
    s, size = split_size(s)
    out = []
    for nm in split_species(s):
        nm = PLURAL.sub('', nm).strip().strip(',;')
        if nm:
            out.append(nm)
    return out, size


# ── the rows where the book contradicts itself, both checked ────────────────────────────────
#
# Keyed on (water, published) exactly as the SC corrections are, so a correction can only fire on
# the row it was checked against: if GA reprints the booklet and fixes the spelling, the
# correction stops matching and the run reports it as unused rather than quietly rewriting
# something nobody has looked at.
PUBLISHED_CORRECTIONS = {
    ('Lake Allatoona', 'Stripped Bass'): {
        'species': ['Striped Bass'],
        'checked': '2026-09-03',
        'why': 'A spelling error in the book. "Stripped Bass" appears once in 212 tables; the '
               'same page writes "Striped Bass" for every other water, Allatoona is a stocked '
               'striped bass reservoir, and no fish is called a stripped bass. Left as published '
               'it becomes a species that does not exist in a plan.',
    },
    ('Lake Hartwell', 'Hybrid/Strip Bass'): {
        'species': ['Hybrid Bass', 'Striped Bass'],
        'checked': '2026-09-03',
        'why': '"Strip" is the same truncation, and this row is the reason the correction table '
               'exists at all: it is Hartwell Main Body, it says DO NOT EAT in all three size '
               'classes, and it is the strongest warning in the book about a fish Ryan actually '
               'targets. The Tugaloo Arm table two rows above writes the same pair as "Hybrid & '
               'Striped Bass".',
    },
}


def correction_for(water, published):
    return PUBLISHED_CORRECTIONS.get((str(water or '').strip(), str(published or '').strip()))


# ── the one binding that reads well and is wrong ────────────────────────────────────────────
#
# Keyed on (the book's water, our slug) so it can only ever refuse the pair it was checked
# against, and the run reports it when it stops matching -- the same discipline as the published
# corrections above. A rule general enough to catch this on its own also refused Lake Sidney
# Lanier, which the book spells "Sydney", and Lanier is one of the largest waters in the state.
REJECTED_BINDINGS = {
    ('Goat Rock Lake', 'rock_eagle_lake'): {
        'checked': '2026-09-03',
        'why': 'Two different lakes 200 km apart that share the word "rock". Goat Rock Lake is a '
               'Georgia Power impoundment on the CHATTAHOOCHEE below Columbus, Harris County, '
               'and the book files it under the Chattahoochee River Basin; Rock Eagle Lake is a '
               '4-H lake in Putnam County in the Oconee River Basin, and it has its own table on '
               'p25 which binds correctly. Nothing else about the two names agrees, and Goat '
               'Rock is not a water we ship.',
    },
}


def binding_rejected(water, slug):
    return REJECTED_BINDINGS.get((str(water or '').strip(), str(slug or '').strip()))


# ── and the one the gates refuse that is the same water anyway ──────────────────────────────
#
# Same shape, same keying, same self-report. Ryan settled the rule for these: *"search up the
# alternate spellings... if they resolve to real lakes with those incorrect spellings then we
# will leave them out... if those alternate lakes do not exist in georgia then we include them."*
ACCEPTED_BINDINGS = {
    ('Hamburg Millpond (Hamburg State Park)', 'hamburgh_millpond'): {
        'checked': '2026-09-03',
        'why': 'There is no second Hamburg Millpond. Our row is GNIS 336381 in WASHINGTON '
               'County, 168 acres, and Hamburg State Park is in Washington County -- and the '
               'index already lists "Hamburg Mill Pond West" among its own legacy names, so both '
               'spellings were already on the same GNIS id before the book was read. It is '
               'named here rather than matched because the alias carries a compass word the '
               'display name does not, and the qualifier gate that keeps the North Oconee off '
               'the Oconee cannot tell that apart from a real one.',
    },
}


def binding_accepted(water, slug):
    return ACCEPTED_BINDINGS.get((str(water or '').strip(), str(slug or '').strip()))


def do_not_eat(advice):
    return bool(re.search(r'do\s*not\s*eat', str(advice or ''), re.I))


def parse_block(b, water):
    """One table -> (species records, water-level notes, rows that could not be read)."""
    out, notes, unread = [], [], []
    head = b['header']
    if not b['shape']:
        for row in b['rows']:
            cells = [(c or '').replace('\n', ' ').strip() for c in row]
            if cells and cells[0]:
                unread.append(re.sub(r'\s+', ' ', cells[0]))
        return out, notes, unread

    for row in b['rows']:
        cells = [(c or '').replace('\n', ' ').strip() for c in row]
        if not cells or not cells[0]:
            continue
        published = re.sub(r'\s+', ' ', cells[0]).strip()

        if is_prose(published):
            notes.append(published)
            continue
        if ADVICE.match(published):
            notes.append(published)                       # an advice phrase with no fish on it
            continue

        chemical = cells[-1] if len(cells) > 1 else ''
        if b['shape'] == 'lake':
            # One record per size class that carries an advice; the header names the class.
            pairs = [(cells[i], head[i] or None, None)
                     for i in range(1, min(len(cells) - 1, len(head))) if cells[i]]
        else:
            where = cells[1] if len(cells) > 2 else ''
            advice = cells[2] if len(cells) > 3 else (cells[1] if len(cells) > 1 else '')
            pairs = [(advice, None, where)] if advice else []

        if not pairs:
            unread.append(published)
            continue
        if NOT_A_SPECIES.match(published):
            for advice, size, _ in pairs:
                notes.append('%s: %s%s' % (published, advice, ' (%s)' % size if size else ''))
            continue

        fix = correction_for(water, published)
        names, size_in_name = ((fix['species'], None) if fix else clean_species(published))
        if not names:
            unread.append(published)
            continue
        for advice, size_class, where in pairs:
            for nm in names:
                rec = {'species': nm, 'advice': advice, 'published_as': published}
                if size_in_name:
                    rec['size'] = size_in_name
                elif size_class:
                    rec['size'] = size_class
                if where and where.lower() != 'not applicable':
                    rec['site'] = where
                if chemical and chemical != advice:
                    rec['chemical'] = chemical
                if fix:
                    rec['corrected'] = fix['why']
                    rec['checked'] = fix['checked']
                out.append(rec)
    return out, notes, unread


# ── binding ─────────────────────────────────────────────────────────────────────────────────

COUNTY = re.compile(r"((?:[A-Z][A-Za-z']+)(?:\s*/\s*[A-Z][A-Za-z']+)*)\s+Count(?:y|ies)")


def counties_in(text):
    """Counties the book names. 'Butts/Monroe Counties' is TWO, and the slash used to lose one."""
    out = set()
    for m in COUNTY.finditer(str(text or '')):
        for part in m.group(1).split('/'):
            if part.strip():
                out.add(part.strip().lower())
    return out


def our_counties(display_name):
    """'Mud Creek (Hall Co, GA)' -> {'hall'}. Our stamp writes 'Co', the book writes 'County'."""
    out = set()
    for m in re.finditer(r'\(([^)]*)\)', str(display_name or '')):
        for part in m.group(1).split(','):
            mm = re.match(r"^([A-Za-z][A-Za-z.' ]*?)\s+Co\.?$", part.strip())
            if mm:
                out.add(mm.group(1).strip().lower())
    return out


# A parenthetical the book uses to say WHERE, not WHAT: "(Near Lula, Hall County)",
# "(Butts/Monroe Counties)", "(Buford Dam to Morgan Falls Dam)". Its words are a place and must
# not become name tokens -- "Mud Creek (Near Powder Springs, Cobb County)" matched two unrelated
# waters on `springs`, and "Ocmulgee River (Wilcox/Dodge/Ben Hill/Telfair Counties)" reached
# Little Ocmulgee Lake because Telfair agreed. A parenthetical that names another WATER --
# "(Randy Poynter Lake)", "(Cornish Creek Reservoir)" -- is an alias and stays.
LOCALITY = re.compile(r'\b(?:near|count(?:y|ies)|ga\.|dam|hwy|highway|mile|to\s)\b', re.I)


def name_for_tokens(water):
    """The water's name with the book's place-parentheticals removed."""
    return re.sub(r'\s*\(([^)]*)\)',
                  lambda m: '' if LOCALITY.search(m.group(1)) else ' (%s)' % m.group(1),
                  str(water or '')).strip()


# The kind of water a name describes. A book row that says River and one of our rows that says
# Lake are not the same water however well the words match -- which is how the Ocmulgee River
# advisory landed on Little Ocmulgee Lake, 60 km away, on a county the river also runs through.
WATER_KIND = {
    'still': ('lake', 'lakes', 'reservoir', 'pond', 'ponds', 'millpond', 'impoundment', 'swamp'),
    'flowing': ('river', 'rivers', 'creek', 'creeks', 'branch', 'fork', 'run'),
    'coastal': ('sound', 'estuary', 'inlet', 'bay', 'harbor'),
}
KIND_OF = {w: k for k, ws in WATER_KIND.items() for w in ws}


# The registry already knows what kind of water each of our rows is, so nothing here has to read
# it out of the name. That matters most on the coast: `coast_savannah_ga` is called "Savannah
# River / Savannah, GA", and reading the words would have made the Savannah ESTUARY advisory
# conflict with the only zone it could possibly be about.
FEATURE_KIND = {'lake': 'still', 'reservoir': 'still', 'pond': 'still',
                'river': 'flowing', 'creek': 'flowing', 'stream': 'flowing',
                'coastal': 'coastal', 'estuary': 'coastal'}


def water_kinds(rec, name):
    """The kinds of water one of OUR rows is, from the registry first and the name second."""
    ft = FEATURE_KIND.get(str((rec or {}).get('feature_type') or '').lower())
    if ft:
        return {ft}
    return {KIND_OF[t] for t in re.findall(r"[a-z]+", str(name or '').lower()) if t in KIND_OF}


def primary_kind(name):
    """The kind of the water being NAMED -- the last kind word outside any parenthetical."""
    bare = re.sub(r'\s*\([^)]*\)', ' ', str(name or '')).lower()
    kinds = [KIND_OF[t] for t in re.findall(r"[a-z]+", bare) if t in KIND_OF]
    return kinds[-1] if kinds else None


def water_and_reach(names):
    """The heading lines -> the water being advised, and the stretch of it, as separate strings.

    The FIRST bold line names the water and the rest describe the reach, which is how the book is
    typeset. A colon subtitle on the first line belongs to the reach as well -- 'Lake Hartwell:
    Tugaloo Arm' and 'Coosa River: Special Striped Bass' both name their water before the colon.
    """
    if not names:
        return '', ''
    first, rest = names[0].strip(), [n.strip() for n in names[1:] if n.strip()]
    if ':' in first:
        head, tail = first.split(':', 1)
        if head.strip():
            first, rest = head.strip(), ([tail.strip()] if tail.strip() else []) + rest
    return first.strip().strip(',;'), ' '.join(rest).strip()


def _sorted_words(name):
    """A name reduced to its letters with the word order taken out.

    The word order is the whole reason this is here: the book writes "Lake Tugalo" and we ship
    "Tugaloo Lake", which is one letter and a swap. Sorting the words first leaves only the
    letter.
    """
    bare = re.sub(r'\s*\([^)]*\)', ' ', str(name or '')).lower()
    return ''.join(sorted(re.findall(r"[a-z]+", bare), key=str))


def one_letter_apart(a, b):
    """True when two normalised names differ by a single character.

    NOT A MATCHER -- nothing binds on this. It exists so that a water we ship under a different
    spelling shows up as a question instead of disappearing into the hundred-odd tables that are
    genuinely not ours. Two of them: the book writes "Lake Tugalo" and we ship "Tugaloo Lake";
    the book writes "Hamburg Millpond" and we ship "Hamburgh Millpond". Ryan decides, not this.
    """
    if a == b or abs(len(a) - len(b)) > 1:
        return False
    if len(a) > len(b):
        a, b = b, a
    for i in range(len(b)):                      # b with one character removed
        if b[:i] + b[i + 1:] == a:
            return True
    return len(a) == len(b) and sum(x != y for x, y in zip(a, b)) == 1


def near_spellings(water, candidates):
    """Our waters whose name is one character away from the book's. Reported, never bound."""
    bare = _sorted_words(water)
    out = []
    for slug, rec in candidates.items():
        name = rec.get('display_name') or slug
        if one_letter_apart(bare, _sorted_words(our_name(name))):
            out.append(name)
    return out


def ga_waters(index):
    """Our waters this book could be about.

    NOT `state == 'GA'`. Hartwell, Tugaloo, Yonah, Russell and Thurmond are all in this book and
    several carry a primary state of SC in the index -- the same border-water hole that made the
    first SC run lose Lake Wylie and J. Strom Thurmond until the state pre-filter came out.
    """
    return {slug: rec for slug, rec in index.items()
            if (rec.get('state') or '').upper() == 'GA'
            or re.search(r'\bGA\b', rec.get('display_name') or '')}


def bind(water, reach, candidates):
    """([hits], why). An empty list means nothing was chosen, and why says whether that is
    because nothing matched or because more than one did and nothing separated them.

    IT RETURNS A LIST BECAUSE A RIVER IS NOT ONE ROW. Ryan settled this on the South Carolina
    run, looking at the map: *"i can clearly see that the saluda river is both stretches... from
    greenwood to murray and then murray to the confluence."* The app ships the Chattahoochee as
    two segments and the book advises it a reach at a time; picking one segment and calling the
    other ambiguous throws away half the answer. So when every candidate left is the SAME NAME
    as the book's -- our own split of one river -- all of them are bound and each record names
    the reach it came from. Two candidates with DIFFERENT names (Ocmulgee River and Little
    Ocmulgee Lake) are still a real ambiguity and are still flagged.
    """
    want = tokens(name_for_tokens(water))
    if not want:
        return [], 'the book names nothing distinctive'
    book_counties = counties_in('%s %s' % (water, reach))
    # The name to compare against, and every name the book offers. A parenthetical is often the
    # water's REAL name with the facility in front of it -- "Paradise PFA (Lake Bobben)" is our
    # Lake Bobben, and the head "Paradise PFA" also matches Lake Paradise, a different pond in the
    # same fishing area. Comparing the parenthetical as a whole name separates them; comparing
    # single tokens cannot.
    # Compared with the word order taken out, because the book and our index disagree about it
    # constantly: "Lake Hartwell" and "Hartwell Lake", "Lake Tugalo" and "Tugaloo Lake".
    bares = {_sorted_words(water)}
    bares |= {_sorted_words(x) for x in re.findall(r'\(([^)]*)\)', water)}
    bares.discard('')
    kind = primary_kind(water)

    want_quals = qualifiers(name_for_tokens(water))
    hits, kinds_rejected, quals_rejected = [], 0, 0
    for slug, rec in candidates.items():
        name = rec.get('display_name') or slug
        if binding_accepted(water, slug):
            hits.append({'slug': slug, 'display_name': name, 'tokens': ['(checked by hand)'],
                         'county_agrees': True, 'county_conflicts': False, 'exact': False,
                         'matched_name': name})
            continue
        pool = our_names(rec, slug)
        # A name in the pool only counts if it agrees on north/south/little/upper -- those words
        # identify nothing on their own but their presence is part of a name, and stripping them
        # made "North Oconee River" agree with the Oconee.
        shared = set()
        any_token = False
        for alias in pool:
            hit = want & tokens(alias)
            if not hit:
                continue
            any_token = True
            if qualifiers(alias) == want_quals:
                shared |= hit
        if not shared:
            if any_token:
                quals_rejected += 1
            continue
        theirs = water_kinds(rec, name)
        if kind and theirs and kind not in theirs:
            kinds_rejected += 1       # a river advisory is not about a lake, however it reads
            continue
        cty = our_counties(name)
        hits.append({
            'slug': slug, 'display_name': name, 'tokens': sorted(shared),
            'county_agrees': bool(book_counties and (book_counties & cty)),
            'county_conflicts': bool(book_counties and cty and not (book_counties & cty)),
            'exact': any(_sorted_words(a) in bares for a in pool),
            'matched_name': next((a for a in pool if _sorted_words(a) in bares), name),
        })
    if not hits:
        if kinds_rejected or quals_rejected:
            said = []
            if kinds_rejected:
                said.append('%d of them is not a %s' % (kinds_rejected, kind))
            if quals_rejected:
                said.append('%d differ on north/south/little/upper, which is part of a name'
                            % quals_rejected)
            return [], 'the name agrees with our waters but ' + ' and '.join(said)
        return [], 'no Georgia water in the app shares a distinctive name token'

    # A county the book states and our row contradicts is a DIFFERENT water, not a weak match --
    # but a river runs through many counties and our stamp names only one, so a conflict alone
    # never rules a candidate out when it would leave nothing standing.
    hits = [h for h in hits if not binding_rejected(water, h['slug'])]
    if not hits:
        return [], 'the only name that agreed was checked by hand and is a different water'
    kept = [h for h in hits if not h['county_conflicts']] or hits
    exact = [h for h in kept if h['exact']]
    if len(exact) == 1:
        return exact, 'the name matches exactly'
    if len(kept) == 1:
        return kept, ('one match, and the county agrees' if kept[0]['county_agrees']
                      else 'one match')
    conf = [h for h in kept if h['county_agrees']]
    if len(conf) == 1:
        return conf, 'the county the book states picks it out'
    if len(exact) > 1:
        return exact, ('the book names one water and the app ships it in %d pieces' % len(exact))
    best = max(len(h['tokens']) for h in kept)
    top = [h for h in kept if len(h['tokens']) == best]
    if len(top) == 1:
        return top, 'most shared tokens'
    return [], 'more than one of our waters fits and nothing separates them'


# ── main ────────────────────────────────────────────────────────────────────────────────────

BASIS = ('PRESENCE FLOOR, not a roster. Georgia names a species here because it sampled it; the '
         'list says nothing about what else lives in the water, so it unions in underneath a '
         'roster and never replaces one.')


def build(blocks, index):
    cands = ga_waters(index)
    waters, ambiguous, unbound, unread_rows, near, one_word = {}, [], [], [], [], []
    blocks_seen, by_alias = [], {}
    used_corrections = set()

    for b in blocks:
        water, reach = water_and_reach(b['names'])
        species, notes, unread = parse_block(b, water)
        for s in species:
            if s.get('corrected'):
                used_corrections.add((water, s['published_as']))
        blocks_seen.append({'book_water': water})
        hits, why = bind(water, reach, cands)
        if unread:
            unread_rows.append({'water': water, 'page': b['page'], 'shape': b['shape'],
                                'bound_to': [h['slug'] for h in hits], 'rows': unread})
        if not hits:
            for nm in near_spellings(water, cands):
                row = {'book_water': water, 'page': b['page'], 'ours': nm}
                if row not in near:
                    near.append(row)
            (ambiguous if 'more than one' in why else unbound).append({
                'book_water': water, 'reach': reach, 'basin': b['basin'], 'page': b['page'],
                'why': why, 'species': sorted({s['species'] for s in species})})
            continue

        for hit in hits:
            if hit['exact']:
                by_alias.setdefault(hit['slug'], {}).setdefault(
                    hit['matched_name'], []).append({'book_water': water, 'page': b['page']})
            if not hit['exact'] and not hit['county_agrees'] and len(hit['tokens']) == 1:
                # ONE WORD AND NOTHING ELSE AGREEING. Most of these are right -- every coastal
                # sound reaches its zone this way -- but it is the thinnest binding this file
                # makes and Ryan asked to see what is thin: "if there is ambiguity flag it and
                # then i will look at it".
                row = {'book_water': water, 'page': b['page'], 'ours': hit['display_name'],
                       'word': hit['tokens'][0]}
                if row not in one_word:
                    one_word.append(row)
            slug = hit['slug']
            rec = waters.setdefault(slug, {
                'display_name': index[slug].get('display_name') or slug,
                'state': index[slug].get('state'), 'advisories': [], 'species': [],
                'do_not_eat': [], 'water_level_notes': [], 'basis': BASIS,
                'source': SOURCE,
            })
            rec['advisories'].append({
                'name': (('%s %s' % (water, reach)).strip() if reach else water),
                'basin': b['basin'], 'page': b['page'],
                'confidence': ('name+county' if hit['county_agrees']
                               else 'name, county differs' if hit['county_conflicts']
                               else 'name'),
                'matched_on': {'tokens': hit['tokens'], 'resolved_by': why},
                'source': SOURCE,
            })
            for n in notes:
                if n not in rec['water_level_notes']:
                    rec['water_level_notes'].append(n)
            for sp in species:
                if sp not in rec['species']:
                    rec['species'].append(sp)
                if do_not_eat(sp['advice']) and sp['species'] not in rec['do_not_eat']:
                    rec['do_not_eat'].append(sp['species'])

    # ONE OF OUR ROWS WEARING TWO WATERS' NAMES. Widening the name gate to read the index's
    # aliases is what surfaced it: `murder_creek_lake` is a 69-acre polygon in Jasper County that
    # carries "Lake Bennett", "Lake Margery" AND "Dairy Lake" as legacy names, and those are
    # three separate ponds in the Charlie Elliott Wildlife Center. Two different tables in the
    # book matched two different names on the same row, which is the index conflating waters and
    # not the book being unclear -- so the binds come out and the row is named for you.
    conflated = []
    for slug, names in by_alias.items():
        if len(names) < 2:
            continue
        conflated.append({'slug': slug,
                          'display_name': (index.get(slug) or {}).get('display_name') or slug,
                          'matched': {n: [b['book_water'] for b in v] for n, v in names.items()}})
        waters.pop(slug, None)

    stale = [list(k) for k in PUBLISHED_CORRECTIONS if k not in used_corrections]
    seen_waters = {b['book_water'] for b in blocks_seen}
    stale += [list(k) for k in REJECTED_BINDINGS if k[0] not in seen_waters]
    stale += [list(k) for k in ACCEPTED_BINDINGS if k[0] not in seen_waters]
    published = {
        '_note': 'Personal use only, not for distribution or resale; not for navigation. '
                 'Georgia fish consumption guidelines as a SPECIES PRESENCE FLOOR and as safety '
                 'text under the regulations. Built by parse_ga_fish_advisories.py.',
        'source': SOURCE,
        'confidence': 'NAME, and the county where the book states one. THIS BOOK HAS NO '
                      'COORDINATES -- unlike the SC advisories nothing here is confirmed by '
                      'geometry, so every binding is weaker than the name+geom standard and each '
                      'record says which signal it got.',
        'species_naming': 'Published exactly as Georgia writes it. Footnote markers, size '
                          'qualifiers and compound rows are separated structurally; no fish is '
                          'renamed here. RESEARCH_SPECIES_CANON is where a published phrase '
                          'becomes an app species.',
        'waters': waters,
        'report': {'tables_read': len(blocks), 'waters_bound': len(waters),
                   'candidates_considered': len(cands),
                   'species_records': sum(len(w['species']) for w in waters.values())},
    }
    review = {'ambiguous': ambiguous, 'conflated_index_rows': conflated,
              'bound_on_one_word': one_word,
              'spelled_differently': near, 'unbound': unbound,
              'rows_not_read': unread_rows, 'corrections_that_did_not_fire': stale}
    return published, review


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--registry', default='registry', help='folder holding lake_index.json')
    ap.add_argument('--pdf', default=None, help='default <registry>/../%s' % DEFAULT_PDF)
    ap.add_argument('--dry-run', action='store_true', help='print the summary, write nothing')
    a = ap.parse_args()

    R = a.registry
    pdf = a.pdf or os.path.join(os.path.dirname(os.path.abspath(R)) or '.', DEFAULT_PDF)
    if not os.path.exists(pdf):
        raise SystemExit('booklet not found at %s -- pass --pdf' % pdf)
    blocks = read_pdf(pdf)
    print('read %d advisory tables from %s' % (len(blocks), os.path.basename(pdf)))

    index = {k: v for k, v in json.load(open(os.path.join(R, 'lake_index.json'),
                                             encoding='utf-8')).items() if isinstance(v, dict)}
    out, review = build(blocks, index)

    w = out['waters']
    print('\nbound to %d of our Georgia-associated waters (%d considered), %d species records'
          % (len(w), out['report']['candidates_considered'], out['report']['species_records']))
    for slug in sorted(w):
        seen, uniq = set(), []
        for s in w[slug]['species']:
            if s['species'] not in seen:
                seen.add(s['species'])
                uniq.append(s['species'])
        conf = sorted({a['confidence'] for a in w[slug]['advisories']})
        print('   %-30s %-38s [%s] %s'
              % (slug, w[slug]['display_name'][:36], '/'.join(conf), ', '.join(uniq) or '(none)'))
        if w[slug]['do_not_eat']:
            print('   %-30s %s' % ('', 'DO NOT EAT: ' + ', '.join(w[slug]['do_not_eat'])))

    if review['ambiguous']:
        print('\n!! %d AMBIGUOUS -- more than one of our waters fits. FLAGGED, NOT GUESSED:'
              % len(review['ambiguous']))
        for x in review['ambiguous']:
            print('   p%-3d %-40s %s' % (x['page'], ('%s %s' % (x['book_water'], x['reach']))[:38],
                                         ', '.join(x['species'][:6])))
    if review['conflated_index_rows']:
        print('\n!! %d of OUR index rows carries the names of more than one water. DROPPED:'
              % len(review['conflated_index_rows']))
        for x in review['conflated_index_rows']:
            print('   %-24s %s' % (x['slug'], x['display_name']))
            for n, books in x['matched'].items():
                print('        matched %-22s from %s' % (n, ', '.join(books)))
    if review['bound_on_one_word']:
        print('\n?? %d binding(s) rest on ONE shared word and nothing else. Worth an eye:'
              % len(review['bound_on_one_word']))
        for x in review['bound_on_one_word']:
            print('   p%-3d %-40s -> %-34s on "%s"'
                  % (x['page'], x['book_water'][:38], x['ours'][:32], x['word']))
    if review['spelled_differently']:
        print('\n?? %d water(s) we ship under a name ONE LETTER different. NOT BOUND -- your call:'
              % len(review['spelled_differently']))
        for x in review['spelled_differently']:
            print('   p%-3d book: %-34s ours: %s' % (x['page'], x['book_water'][:32], x['ours']))
    print('\n%d of the book\'s tables are not our waters (expected -- it covers the whole state)'
          % len(review['unbound']))
    if review['rows_not_read']:
        n = sum(len(x['rows']) for x in review['rows_not_read'])
        print('!! %d row(s) in %d table(s) could not be read:'
              % (n, len(review['rows_not_read'])))
        for x in review['rows_not_read']:
            print('   p%-3d %-30s %s' % (x['page'], x['water'][:28], ' | '.join(x['rows'])[:80]))
    if review['corrections_that_did_not_fire']:
        print('!! correction(s) that matched nothing -- the book may have been reprinted:')
        for k in review['corrections_that_did_not_fire']:
            print('   %s' % (k,))

    if a.dry_run:
        print('\n--dry-run: nothing written')
        return 0
    p = os.path.join(R, OUT_NAME)
    json.dump(out, open(p, 'w', encoding='utf-8'), indent=1)
    rp = os.path.join(R, REVIEW_NAME)
    json.dump(review, open(rp, 'w', encoding='utf-8'), indent=1)
    print('\n-> %s   (%.0f KB, published)' % (p, os.path.getsize(p) / 1024))
    print('-> %s   (%.0f KB, review only)' % (rp, os.path.getsize(rp) / 1024))
    return 0


if __name__ == '__main__':
    sys.exit(main())
