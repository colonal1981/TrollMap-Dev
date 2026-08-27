#!/usr/bin/env python3
"""
registry/regulations_table.json -- one table of fishing law per state, built from the books.

WHY THIS EXISTS. Regulations were being re-derived per lake by an LLM, once per water, and the
result disagreed with itself. Measured 2026-08-27 across four Santee-area lakes reading one SC
book: Marion returned 2 size limits and no striper row at all, Moultrie 3 with the closure,
Murray 8, Wateree 7 -- in three different output shapes, two of them returning creelLimits as a
sentence instead of a map. The closure that matters most, "June 16 - Sept. 30 closed", survived
into exactly ONE of 63 saved profiles, and the word "closed" was dropped from it.

The law is not per-lake research. It is ten rows in a book that changes once a year. So it is
parsed once per state per year, deterministically, and every lake reads the same table.

NOTHING HERE IS AN LLM. Two readers, by source shape:

  ruled cells   SC, NC, GA. Their tables are drawn with rules, so pdfplumber's lines/lines
                strategy returns real rows. Verified on the SC striper table and the SC state
                lakes table.
  agency HTML   TN. TWRA publishes the per-reservoir exceptions the PDF buries in a
                three-column magazine layout as a plain <ul> on each reservoir's own page.
                LEAF <li> ONLY -- nested list items emit the parent and its children both, and
                counting all of them triples every bass rule.

Personal use only, not for distribution or resale; not for navigation.
"""
import argparse, json, os, re, sys, unicodedata

DASH = re.compile(r'[‐-―−]')


def norm(s):
    """Collapse a PDF or HTML cell to one clean line.

    De-hyphenates across line breaks. The SC state lakes table emits `Hamil- ton` and
    `Boat- ing` because the cell wrapped mid-word; joining on the hyphen is not optional or
    the water body is unmatchable.
    """
    if s is None:
        return ''
    s = unicodedata.normalize('NFKC', str(s))
    s = s.replace(' ', ' ')
    s = re.sub(r'(\w)-\s*\n\s*(\w)', r'\1\2', s)
    s = re.sub(r'(\w)-\s{1,3}(?=[a-z])', r'\1', s)
    s = s.replace('\n', ' ')
    return re.sub(r'\s+', ' ', s).strip()


def slugify(s):
    s = norm(s).lower()
    s = DASH.sub('-', s)
    s = re.sub(r"[’'`]", '', s)
    s = re.sub(r'[^a-z0-9]+', '_', s)
    return s.strip('_')


def load_index(registry):
    p = os.path.join(registry, 'lake_index.json')
    if not os.path.exists(p):
        return {}
    return json.load(open(p, encoding='utf-8'))


def build_name_map(idx):
    """Every name a registry water answers to -> its slug. EXACT MATCHES ONLY.

    No fuzzy fallback, on purpose. A fuzzy matcher run on 2026-08-27 produced three confident
    wrong answers in one pass -- south_holston_tn to boone_lake, cheoah_lake_nc to
    calderwood_lake, and "Lake Russell, SC" to richard_b_russell_lake when a separate
    lake_russell exists. Anything that does not match exactly is reported, not guessed.
    """
    m = {}
    for slug, row in idx.items():
        cands = [slug, row.get('name'), row.get('display_name'), row.get('legacy_display_name')]
        cands += list(row.get('legacy_display_names') or [])
        for c in cands:
            if not c:
                continue
            k = slugify(re.sub(r'\s*\(.*?\)\s*', ' ', str(c)))
            k = re.sub(r'_(al|ga|nc|sc|tn|va)$', '', k)
            if k:
                m.setdefault(k, slug)
    return m


def resolve(name, name_map):
    """TWRA/DNR water name -> registry slug, or None. Tries the obvious equivalences only."""
    base = slugify(re.sub(r'\s*\(.*?\)\s*', ' ', name))
    tries = [base]
    for a, b in (('_reservoir', '_lake'), ('_lake', '_reservoir')):
        if base.endswith(a):
            tries.append(base[: -len(a)] + b)
    stem = re.sub(r'_(reservoir|lake)$', '', base)
    tries += [stem, 'lake_' + stem, stem + '_lake', stem + '_reservoir']
    for t in tries:
        if t in name_map:
            return name_map[t]
    return None


# ─────────────────────────────────────────────────────────────────────────────────────────────
# TENNESSEE -- TWRA per-reservoir pages
# ─────────────────────────────────────────────────────────────────────────────────────────────

SPECIES_RULE = re.compile(
    r'^(?P<species>[A-Z][A-Za-z/\s\.\'’()-]{2,60}?)\s*:\s*(?P<rule>.+)$')
CLOSED = re.compile(r'\bclosed\b|\bprohibit', re.I)
DATED = re.compile(
    r'\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*\d{1,2}\b', re.I)


def tn_rules(path):
    """The <ul> under the `Regulations` heading on a TWRA reservoir page.

    LEAF <li> ONLY. TWRA nests the per-species detail inside the combination rule, so
    `Largemouth/Smallmouth Bass: Five (5) per day in combination` contains its own
    `Largemouth Bass: 15-inch minimum` child. Taking every <li> returns the bass rule three
    times and inflates every count on the page.
    """
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(open(path, encoding='utf-8', errors='replace').read(), 'html.parser')
    for t in soup(['script', 'style', 'nav', 'footer', 'svg']):
        t.decompose()
    head = soup.find(lambda e: e.name in ('h1', 'h2', 'h3')
                     and e.get_text(strip=True).lower() == 'regulations')
    if not head:
        return None, None
    intro, items = [], []
    for el in head.find_all_next():
        if el.name in ('h1', 'h2', 'h3') and el is not head:
            break
        if el.name == 'p':
            t = norm(el.get_text(' ', strip=True))
            if t and t not in intro:
                intro.append(t)
        if el.name == 'li' and not el.find('li'):
            t = norm(el.get_text(' ', strip=True))
            if t and t not in items:
                items.append(t)
    return intro, items


def tn_parse(items):
    """Split each rule line into species + text, and flag the two things a planner acts on.

    `closed` and `dated` are RECORDED, NOT INTERPRETED. A date range in this book can be the
    closure or the open season -- Cherokee's Smallmouth rule carries both halves in one line --
    so this marks the line as carrying a date and keeps the sentence whole. Turning that into a
    calendar is a separate decision with a citation on the end of it, and it is not made here.
    """
    out = []
    for line in items:
        m = SPECIES_RULE.match(line)
        rec = {'text': line}
        if m and len(m.group('species')) < 60:
            rec['species'] = m.group('species').strip()
            rec['rule'] = m.group('rule').strip()
        if CLOSED.search(line):
            rec['mentions_closure'] = True
        if DATED.search(line):
            rec['dated'] = True
        out.append(rec)
    return out


def read_tn(html_dir, name_map):
    import glob
    waters, unmatched, no_section = {}, [], []
    files = sorted(glob.glob(os.path.join(html_dir, '*.html')))
    for p in files:
        display = os.path.basename(p).split(' in Tennessee')[0].strip()
        intro, items = tn_rules(p)
        if items is None:
            no_section.append(display)
            continue
        slug = resolve(display, name_map)
        rec = {'display': display, 'source_file': os.path.basename(p),
               'preamble': intro, 'rules': tn_parse(items)}
        if slug:
            waters[slug] = rec
        else:
            unmatched.append(rec)
    return {'waters': waters, 'unmatched_pages': [u['display'] for u in unmatched],
            'pages_without_a_regulations_section': no_section,
            'pages_read': len(files)}


# ─────────────────────────────────────────────────────────────────────────────────────────────
# SC / NC / GA -- ruled-cell tables
# ─────────────────────────────────────────────────────────────────────────────────────────────

LINES = {"vertical_strategy": "lines", "horizontal_strategy": "lines"}


def tables_on(pdf, page_no, min_rows=4, min_cols=3):
    pg = pdf.pages[page_no - 1]
    out = []
    for t in (pg.extract_tables(table_settings=LINES) or []):
        if len(t) >= min_rows and max(len(r) for r in t) >= min_cols:
            out.append([[norm(c) for c in row] for row in t])
    return out


SECTION = re.compile(r'GAME FISH SIZE & POSSESSION LIMITS\s+(.{4,70}?)\s*(?:•|$)', re.S)


def page_label(pdf, n):
    """The species-group title above the table.

    THE SC BOOK REUSES ONE HEADER. `WATER BODY | FISH | SIZE LIMIT | POSSESSION LIMIT` is the
    header of the striper table, the bream table, the black bass table and the catfish table
    alike, so matching on the header alone returns whichever page is scanned first -- which on
    2026-08-27 silently handed back the bream table labelled as the striper one. The title
    printed above it is what tells them apart.
    """
    txt = norm((pdf.pages[n - 1].extract_text() or '')[:1200])
    m = SECTION.search(txt)
    if m:
        return re.sub(r'\s+', ' ', m.group(1)).strip(' :-')
    return 'page %d' % n


def collect_tables(pdf, headers, pages):
    """EVERY table matching the header signature, each labelled by its own section title.

    Collecting all of them rather than the first is not thoroughness for its own sake: the
    species groups are separate tables with identical headers, and picking one means silently
    dropping the rest of the law.
    """
    want = [h.lower() for h in headers]
    out = []
    for n in pages:
        for t in tables_on(pdf, n):
            for hdr_i in range(0, min(6, len(t))):
                joined = ' | '.join(c.lower() for c in t[hdr_i])
                if all(w in joined for w in want):
                    out.append({'page': n, 'label': page_label(pdf, n),
                                'header': t[hdr_i],
                                'rows': carry_water_body(rows_after(t, hdr_i))})
                    break
    return out


def find_table(pdf, headers, pages):
    """The first table whose header row contains all of `headers`. Page numbers move between
    editions; column headings do not, so the table is found by its own header, not by page."""
    want = [h.lower() for h in headers]
    for n in pages:
        for t in tables_on(pdf, n):
            # NC puts its header on row 3, under two rows of page furniture that the ruled
            # cells pick up as table rows. Scanning only the top three missed it entirely.
            for hdr_i in range(0, min(6, len(t))):
                if hdr_i >= len(t):
                    continue
                joined = ' | '.join(c.lower() for c in t[hdr_i])
                if all(w in joined for w in want):
                    return n, hdr_i, t
    return None, None, None


def rows_after(t, hdr_i):
    return [r for r in t[hdr_i + 1:] if any(c for c in r)]


def carry_water_body(rows, col=0):
    """A row with an empty first cell continues the water body above it.

    That is how the SC striper table stores `June 16 - Sept. 30 closed` -- as its own row under
    the Santee River system, with no water body of its own. Read it as a fresh row and the
    closure belongs to nothing.
    """
    out, cur = [], None
    for r in rows:
        if r[col]:
            cur = r[col]
            out.append({'water_body': cur, 'cells': r, 'continuation': False})
        elif cur:
            out.append({'water_body': cur, 'cells': r, 'continuation': True})
    return out


def read_sc_state_lakes(pdf, pages_left, pages_right):
    """The state lakes table is split across a spread and the right half has NO water body.

    THE TRAP: on the right-hand page the first row is already DATA, not a header -- Lake Edgar
    Brown's limits sit in it. Skipping it the way you would any other header shifts every
    lake's limits up by one and nothing about the output looks wrong. So the halves are joined
    by position and the join REFUSES if the row counts differ.

    The check that proves it: Dargan's Pond is the only water whose OPEN DAYS is `Closed`, and
    the only one whose limits are all `N/A`. If the join slips, those stop lining up.
    """
    n, hi, left = find_table(pdf, ['county', 'water body', 'open days'], pages_left)
    if left is None:
        return None, 'no state lakes table found'
    lrows = rows_after(left, hi)
    right = None
    for rn in pages_right:
        for t in tables_on(pdf, rn, min_rows=4, min_cols=6):
            body = [r for r in t if any(c for c in r)]
            # ONE leading row of page furniture is tolerated and nothing more. The right half
            # of this spread has no header of its own -- its first data row is Lake Edgar
            # Brown's limits -- so an off-by-one here silently shifts every lake's limits.
            if len(body) == len(lrows) + 1:
                body = body[1:]
            if len(body) == len(lrows):
                right = body
                break
        if right:
            break
    if right is None:
        return None, ('right half not found or row counts differ (left has %d)' % len(lrows))
    lakes = {}
    for l, r in zip(lrows, right):
        lakes[slugify(l[1])] = {
            'county': l[0], 'water_body': l[1], 'acres': l[2],
            'open_days': l[3], 'open_to_fishing': l[4], 'max_boat_motor_hp': l[5],
            'limits': {'catfish': r[1], 'bass': r[2], 'bream': r[3],
                       'statewide_crappie_applies': r[4], 'minnows_as_bait': r[5]},
            'closed': bool(re.search(r'closed', (l[3] or '') + ' ' + (l[4] or ''), re.I)),
        }
    guard = [k for k, v in lakes.items() if v['closed']]
    return {'lakes': lakes, 'rows': len(lakes), 'closed_waters': guard}, None


def read_pdf_state(path, specs):
    """`specs` is a list of (key, header-words, candidate-pages). Anything not found is
    reported by name rather than silently omitted -- a table that quietly vanishes between
    editions is how a book gets read wrong for a year."""
    import pdfplumber
    got, missing = {}, []
    with pdfplumber.open(path) as pdf:
        last = len(pdf.pages)
        for key, headers, pages in specs:
            pages = [p for p in pages if 1 <= p <= last]
            found = collect_tables(pdf, headers, pages)
            if not found:
                missing.append({'table': key, 'looked_for': headers, 'pages_searched': pages})
                continue
            got[key] = found
        sc_lakes = None
        if any(k == 'state_lakes' for k, _, _ in specs):
            pages = [p for k, _, p in specs if k == 'state_lakes'][0]
            pages = [p for p in pages if 1 <= p <= last]
            sc_lakes, err = read_sc_state_lakes(pdf, pages, [p + 1 for p in pages])
            if err:
                missing.append({'table': 'state_lakes_join', 'why': err})
    return got, missing, sc_lakes


SPECS = {
    'SC': ('Regs2627.pdf', [
        ('striped_white_hybrid_bass', ['water body', 'fish', 'size limit'], list(range(28, 40))),
        ('state_lakes', ['county', 'water body', 'open days'], list(range(32, 42))),
    ]),
    'NC': ('nc_digest_2026_2027.pdf', [
        # NC's header text is cut by the column rules -- `SIZE LIMIT` arrives as `SIZE LIM`
        # plus `IT` in two cells -- so the match is on fragments that survive the split.
        ('warmwater_game_fish', ['species', 'size lim', 'creel'], list(range(1, 9))),
    ]),
    'GA': ('ga_digest_2026_2027.pdf', [
        ('statewide', ['species', 'daily limit'], list(range(1, 12))),
        ('water_body_exceptions', ['species', 'water body', 'possession limit'], list(range(1, 12))),
        ('saltwater', ['species', 'open season'], list(range(18, 30))),
    ]),
}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--root', default='.')
    ap.add_argument('--regs', default='Regulations')
    ap.add_argument('--tn-html', default='Tennessee_Lakes')
    ap.add_argument('--registry', default='registry')
    ap.add_argument('--read', required=True, help='the date these books were read, YYYY-MM-DD')
    ap.add_argument('--out', default='registry/regulations_table.json')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    R = lambda *p: os.path.join(a.root, *p)

    idx = load_index(R(a.registry))
    name_map = build_name_map(idx)
    print('index:    %d waters, %d name keys' % (len(idx), len(name_map)), flush=True)

    doc = {'_note': 'Personal use only, not for distribution or resale; not for navigation. '
                    'Fishing law parsed from the state books. Nothing here is LLM output.',
           'read': a.read, 'states': {}, 'problems': []}

    # A WATER WITH NO PAGE IS TWO DIFFERENT ANSWERS and only one of them is work.
    # Calderwood has a TWRA page nobody saved -- fixable by saving it. The Davy Crockett we
    # ship, on the Nolichucky in Greene County, is absent from TWRA entirely; it takes the
    # statewide table, which is what TWRA itself says happens. Reporting both as `missing`
    # every run turns a closed question back into an open one.
    absent_doc = {}
    ap_path = R(a.registry, 'no_agency_page.json')
    if os.path.exists(ap_path):
        absent_doc = json.load(open(ap_path, encoding='utf-8'))
    absent = set((absent_doc.get('absent') or {}).keys())
    unsaved = set((absent_doc.get('page_exists_not_saved') or {}).keys())

    tn = read_tn(R(a.tn_html), name_map)
    offered_tn = sorted(s for s, r in idx.items()
                        if r.get('state') == 'TN' and r.get('feature_type') == 'lake')
    gap = [s for s in offered_tn if s not in tn['waters']]  # refined below once the digest is read
    tn['offered_lakes'] = offered_tn
    tn['no_agency_page'] = {s: (absent_doc.get('absent') or {})[s] for s in gap if s in absent}
    tn['page_exists_not_saved'] = {s: (absent_doc.get('page_exists_not_saved') or {})[s]
                                   for s in gap if s in unsaved}
    tn['unexplained_gap'] = [s for s in gap if s not in absent and s not in unsaved]
    dg_path = R(a.regs, 'tn_digest_2026_2027.pdf')
    if os.path.exists(dg_path):
        dg = read_tn_digest(dg_path, idx, name_map)
        tn['digest'] = dg
        for slug in dg['waters']:
            tn['offered_lakes'] = tn.get('offered_lakes') or []
        covered = set(tn['waters']) | set(dg['waters'])
        tn['covered_by_digest_only'] = sorted(set(dg['waters']) - set(tn['waters']))
        print('TN digest: %d blocks on pages %s, %d matched (%s), %d refused for want of a '
              'county' % (dg['blocks_found'], '%d-%d' % (DIGEST_PAGES[0], DIGEST_PAGES[-1]),
                          len(dg['waters']), ', '.join(sorted(dg['waters'])) or '-',
                          len(dg['rejected_on_county'])), flush=True)
    else:
        covered = set(tn['waters'])
        doc['problems'].append({'state': 'TN', 'why': 'digest not found', 'path': dg_path})

    doc['states']['TN'] = tn
    if tn['unexplained_gap']:
        doc['problems'].append({'state': 'TN', 'why': 'offered water with no page and no '
                                'entry in no_agency_page.json', 'waters': tn['unexplained_gap']})
    print('TN:       %d pages, %d matched | statewide-only (no agency page): %s | page not '
          'saved: %s | unexplained: %s'
          % (tn['pages_read'], len(tn['waters']), sorted(tn['no_agency_page']) or '-',
             sorted(tn['page_exists_not_saved']) or '-', tn['unexplained_gap'] or '-'),
          flush=True)

    for st, (fname, specs) in SPECS.items():
        path = R(a.regs, fname)
        if not os.path.exists(path):
            doc['problems'].append({'state': st, 'why': 'digest not found', 'path': path})
            print('!! %s: %s not found' % (st, path), flush=True)
            continue
        got, missing, sc_lakes = read_pdf_state(path, specs)
        blk = {'source_file': fname, 'tables': got}
        if sc_lakes:
            blk['state_lakes'] = sc_lakes
        doc['states'][st] = blk
        for m in missing:
            doc['problems'].append(dict(m, state=st))
        counts = ', '.join('%s %d tables/%d rows' % (k, len(v), sum(len(x['rows']) for x in v))
                           for k, v in got.items())
        print('%s:       %s%s' % (st, counts or '(no tables found)',
              ('; state lakes %d rows, closed: %s' % (sc_lakes['rows'], sc_lakes['closed_waters'])
               if sc_lakes else '')), flush=True)
        for m in missing:
            print('   !! missing %s' % m, flush=True)

    if a.dry_run:
        print('\n[DRY] would write %s' % R(a.out), flush=True)
        return 0
    outp = R(a.out)
    os.makedirs(os.path.dirname(outp), exist_ok=True)
    json.dump(doc, open(outp, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print('\nwrote %s (%.0f KB)' % (outp, os.path.getsize(outp) / 1024), flush=True)
    if doc['problems']:
        print('%d problem(s) recorded in the file' % len(doc['problems']), flush=True)
    return 0




# ─────────────────────────────────────────────────────────────────────────────────────────────
# TENNESSEE -- the digest's own exceptions pages
# ─────────────────────────────────────────────────────────────────────────────────────────────
#
# The TWRA reservoir pages cover ten reservoirs. The digest covers everything else, including
# river reaches and the small lakes, and it is NOT a table -- it is a three-column magazine
# layout of headings and bullets. `pdftotext -layout` interleaves the columns into nonsense:
# it renders one reach as "ENKA Dam South Fork Holston River (confluence upstream to Great
# Smoky Mountains upstream to state line, includes with North Fork Holston River National P)",
# which is three separate entries spliced together.
#
# So columns are recovered from word coordinates. NOT by largest gap -- that under-splits a
# page whose columns sit closer together, and on the exceptions page it merged two columns into
# the single line "day, no length limit. Davy Crockett Lake (Greene County):". Columns are
# found by their LEFT EDGE: the x0 values that many words start at.

BULLET = re.compile(r'^\s*[•▪·]\s*')


def _left_edges(words, tol=3.0, min_share=0.04):
    from collections import Counter
    c = Counter(round(w['x0'] / tol) * tol for w in words)
    n = len(words)
    edges, merged = sorted(x for x, k in c.items() if k >= max(4, n * min_share)), []
    for e in edges:
        if merged and e - merged[-1] < 12:
            continue
        merged.append(e)
    return merged or [0.0]


def _column_lines(page, ytol=2.5):
    """Lines per column, each tagged by the FONT it is set in.

    TWRA's own typography is the structure, so it is read rather than guessed at. Measured on
    the 2026-2027 book, every reservoir and exceptions page:

        Agenda-Bold      10.5   the water's name          `Boone`  `Davy Crockett Lake`
        Agenda-Medium    10.5   its qualifier             `(Greene County):`  `(Rockford Dam
                                                          upstream to ... boundary):`
        Agenda-Semibold   8.5   the species inside a rule `Largemouth Bass:`
        Agenda-Regular    8.5   body
        Agenda-Bold      18.0   the section title         `Exceptions on State Park Lakes`

    An earlier version required a heading to end in a colon. The reservoir pages do not use
    one -- the heading is the bare word `Boone` -- so it found 53 blocks in an 18-page book and
    silently skipped every reservoir in Region 4.
    """
    from collections import defaultdict, Counter
    words = page.extract_words(extra_attrs=['fontname', 'size'])
    if not words:
        return []
    sizes = Counter(round(w['size'], 1) for w in words)
    body_size = sizes.most_common(1)[0][0]

    def kind(w):
        fn = w['fontname'].split('+')[-1]
        sz = round(w['size'], 1)
        if sz < body_size - 2.0:
            # The Region 4 page carries its locator map as live text -- county names and
            # reservoir labels set at 2.8pt against an 8.5pt body. Left in, they append
            # themselves to whatever rule was open and put JOHNSON HAWKINS SULLIVAN inside a
            # creel limit.
            return 'drop'
        if sz <= body_size:
            return 'body'
        if sz >= body_size + 7:
            return 'section'
        if 'Bold' in fn:
            return 'heading'
        if 'Medium' in fn:
            return 'qualifier'
        return 'body'

    edges = _left_edges(words)
    cols = defaultdict(list)
    for w in words:
        cands = [e for e in edges if e <= w['x0'] + 1.0]
        cols[max(cands) if cands else edges[0]].append(w)
    out = []
    for edge in sorted(cols):
        rows = defaultdict(list)
        for w in cols[edge]:
            rows[round(w['top'] / ytol)].append(w)
        lines = []
        for k in sorted(rows):
            ws = sorted(rows[k], key=lambda x: x['x0'])
            kinds = Counter(kind(w) for w in ws)
            lines.append({'text': norm(' '.join(w['text'] for w in ws)),
                          'kind': kinds.most_common(1)[0][0],
                          'top': min(w['top'] for w in ws)})
        out.append(lines)
    return out


SUB = re.compile(r'^\s*[»›-]\s+')

# TWRA prints this on every page. Left in the stream it appends itself to whichever rule was
# open when the page turned.
RUNNING = re.compile(r'^\s*\d*\s*\|?\s*(Reservoir REGULATIONS|Trout REGULATIONS|'
                     r'Exceptions TO STATEWIDE REGULATIONS|TWRA Fishing Lakes INFORMATION|'
                     r'\d{4}[–-]\d{4}\s+T\s?E\s?N\s?N)', re.I)


def _blocks(lines):
    """One block per water: its heading, any preamble, and its rules.

    Three shapes have to survive here, all of them real in this book:
      - a bare heading            `Boone`
      - heading plus qualifier    `Davy Crockett Lake` + `(Greene County):`
      - a preamble before rules   Norris's `Extends from the dam upstream to the Hwy. 25E
                                  bridge on the Clinch River arm...`
    Sub-bullets (`»` and `-`) belong to the bullet above them -- Cherokee's smallmouth rule is
    a parent bullet with two dated children, and promoting them to siblings loses which
    species they modify.
    """
    out, cur = [], None
    for ln in lines:
        t, k = ln['text'], ln['kind']
        if not t or k in ('section', 'drop'):
            continue
        if k == 'heading':
            if cur:
                out.append(cur)
            cur = {'heading': t, 'preamble': [], 'rules': [], 'page': ln.get('page')}
            continue
        if cur is None:
            continue
        if k == 'qualifier':
            cur['heading'] = (cur['heading'] + ' ' + t).strip()
            continue
        if BULLET.match(t):
            cur['rules'].append(BULLET.sub('', t))
        elif SUB.match(t) and cur['rules']:
            cur['rules'][-1] += ' ' + SUB.sub('', t)
        elif cur['rules']:
            cur['rules'][-1] += ' ' + t
        else:
            cur['preamble'].append(t)
    if cur:
        out.append(cur)
    return [b for b in out if b['heading'] and b['rules']]


COUNTY = re.compile(r'\(([^)]*?)\s*(?:County|Co\.)\s*\)', re.I)


# The digest's RESERVOIR pages are deliberately not read here.
#
# Those pages head each water with a bare word -- `Cherokee`, `Boone`, `Norris` -- and a bare
# word is not enough to identify a water. Matching `Cherokee` against the registry returned
# `lake_cherokee_3`, which is a different lake in a different state, and TWRA means Cherokee
# Reservoir in Hawkins County. Their multi-column flow also runs a water's rules past the
# column edge and onto the next page, which needs reading-order work this does not do yet.
#
# It costs nothing to leave them out: all ten reservoirs on those pages are covered by TWRA's
# own per-reservoir HTML, where each page is unambiguously one water and the rules are a
# plain <ul>. The digest is read for what the HTML does NOT cover -- the exceptions pages, the
# state park lakes, and the river reaches, where every heading carries a county or a described
# reach and can be identified.
DIGEST_PAGES = list(range(11, 18))


def read_tn_digest(path, idx, name_map, pages=None):
    """Every heading-and-bullets block on the TN digest's reservoir and exceptions pages.

    COUNTY DISAMBIGUATES, AND IT IS NOT OPTIONAL. Tennessee has two Davy Crockett Lakes: an
    87-acre one in Crockett County in the west, and the one we ship in Greene County on the
    Nolichucky. Their rules differ -- the Crockett Co. entry says "Largemouth Bass: no creel
    limit, only one over 18 inches", the Greene County entry says "Smallmouth/Largemouth Bass:
    five per day in combination". Matching on the name alone picks whichever is read first and
    puts a west Tennessee lake's law on an east Tennessee lake. So when a heading carries a
    county, the registry row's county MUST agree or the block is left unmatched.
    """
    import pdfplumber
    blocks, matched, unmatched = [], {}, []
    # ONE STREAM FOR THE WHOLE BOOK, in reading order: page, then column, then line.
    #
    # A water's rules do not stop at the column edge. Cherokee's thirteen rules start in the
    # first column of page 6 and finish in the second, and Ft. Loudoun's run off the bottom of
    # page 6 onto page 7. Parsing each column in isolation gave Cherokee three rules and
    # orphaned the rest -- they had no heading above them in their own column, so they were
    # silently dropped rather than reported.
    stream = []
    want = set(pages or DIGEST_PAGES)
    with pdfplumber.open(path) as pdf:
        for pi, page in enumerate(pdf.pages, start=1):
            if pi not in want:
                continue
            for col in _column_lines(page):
                for ln in col:
                    if RUNNING.match(ln['text']):
                        continue
                    ln['page'] = pi
                    stream.append(ln)
    for b in _blocks(stream):
        blocks.append(b)
    for b in blocks:
        head = b['heading'].rstrip(':').strip()
        m = COUNTY.search(head)
        county = norm(m.group(1)) if m else None
        name = norm(re.sub(r'\s*\(.*', '', head))
        slug = resolve(name, name_map)
        rec = {'heading': b['heading'], 'page': b.get('page'), 'county_in_book': county,
               'rules': tn_parse(b['rules'])}
        if slug and county:
            reg_county = norm((idx.get(slug) or {}).get('county') or '')
            if reg_county and reg_county.lower() != county.lower():
                rec['rejected'] = ('county mismatch: book says %s, registry says %s'
                                   % (county, reg_county))
                unmatched.append(rec)
                continue
        elif slug and not county:
            # A NAME WITHOUT A COUNTY IS NOT AN IDENTIFICATION. Tennessee has two Davy Crockett
            # Lakes -- 87 acres in Crockett County and the one we ship in Greene County on the
            # Nolichucky -- and their rules differ. `Pine Lake:` and `Dogwood Lake:` are names
            # a dozen states share. The registry row is only accepted when the book says which
            # county it means.
            rec['rejected'] = 'no county in the heading; name alone does not identify a water'
            unmatched.append(rec)
            continue
        if slug:
            matched.setdefault(slug, []).append(rec)
        else:
            unmatched.append(rec)
    return {'blocks_found': len(blocks), 'waters': matched,
            'unmatched_blocks': len(unmatched),
            'rejected_on_county': [u for u in unmatched if u.get('rejected')]}


if __name__ == '__main__':
    sys.exit(main())
