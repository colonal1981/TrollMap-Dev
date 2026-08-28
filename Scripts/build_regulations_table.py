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
from html.parser import HTMLParser
from collections import Counter, defaultdict

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


def _pdfplumber():
    """pdfplumber is the one dependency this script cannot do without. Say so in one line
    naming the install, rather than dropping a traceback on whoever runs it."""
    try:
        import pdfplumber
        return pdfplumber
    except ImportError:
        sys.exit('pdfplumber is required to read the state books.\n'
                 '  py -m pip install pdfplumber')


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
    # `Lake Tugaloo` IS `Tugaloo Lake`. The books put the word first and the registry puts it
    # last, and neither spelling reaches the other through the suffix swaps above -- `Lake
    # Tugaloo` slugifies to lake_tugaloo, which ends in no suffix to swap, so tugaloo_lake was
    # never tried and four SC rules on a water we ship went unresolved. Still an EXACT lookup:
    # this adds one more spelling to ask for, not a fuzzy match.
    if base.startswith('lake_'):
        tries.append(base[len('lake_'):] + '_lake')
    if base.endswith('_lake'):
        tries.append('lake_' + base[:-len('_lake')])
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


class _TwraParser(HTMLParser):
    """The `Regulations` section of a TWRA reservoir page, using the standard library only.

    bs4 is not installed on the pipeline box and this script should not require an install to
    run -- it failed there on `ModuleNotFoundError: No module named 'bs4'` after parsing nothing.
    The page is regular enough that html.parser is sufficient: find the heading whose text is
    exactly `Regulations`, then take the <li> and <p> that follow it until the next heading.

    LEAF <li> ONLY, which is why depth is tracked. TWRA nests the per-species detail inside the
    combination rule, so an <li> that contains another <li> is a wrapper and its text is the
    concatenation of its children -- counting it returns every bass rule three times.
    """
    HEAD = ('h1', 'h2', 'h3', 'h4')

    def __init__(self):
        HTMLParser.__init__(self, convert_charrefs=True)
        self.in_head = None
        self.head_text = []
        self.started = False
        self.done = False
        self.li_depth = 0
        self.li_had_child = []
        self.buf = []
        self.items = []
        self.paras = []
        self.in_p = False

    def handle_starttag(self, tag, attrs):
        if self.done:
            return
        if tag in ('script', 'style'):
            self.skip = True
        if tag in self.HEAD:
            self.in_head = tag
            self.head_text = []
            if self.started:
                self.done = True
            return
        if not self.started:
            return
        if tag == 'li':
            if self.li_depth:
                self.li_had_child[-1] = True
            self.li_depth += 1
            self.li_had_child.append(False)
            self.buf.append([])
        elif tag == 'p':
            self.in_p = True
            self.buf.append([])

    def handle_endtag(self, tag):
        if tag in self.HEAD and self.in_head:
            txt = norm(' '.join(self.head_text))
            if txt.lower() == 'regulations':
                self.started = True
            self.in_head = None
            return
        if not self.started or self.done:
            return
        if tag == 'li' and self.li_depth:
            txt = norm(' '.join(self.buf.pop()))
            leaf = not self.li_had_child.pop()
            self.li_depth -= 1
            if leaf and txt and txt not in self.items:
                self.items.append(txt)
        elif tag == 'p' and self.in_p:
            txt = norm(' '.join(self.buf.pop()))
            self.in_p = False
            if txt and txt not in self.paras:
                self.paras.append(txt)

    def handle_data(self, data):
        if self.in_head is not None:
            self.head_text.append(data)
        elif self.started and self.buf:
            self.buf[-1].append(data)


def tn_rules(path):
    """The rules under the `Regulations` heading on a TWRA reservoir page."""
    html = open(path, encoding='utf-8', errors='replace').read()
    html = re.sub(r'(?is)<(script|style)[^>]*>.*?</\1>', ' ', html)
    p = _TwraParser()
    try:
        p.feed(html)
    except Exception:
        pass
    if not p.started:
        return None, None
    return p.paras, p.items


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
        cl = closures_in(line)
        if cl:
            rec['closures'] = cl
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


def rules_only_edges(pdf, page_no, min_len=40.0):
    """The vertical rules the book actually DREW on this page.

    column_edges() takes the corners of pdfplumber's own cells, and those come from rects as
    well as lines -- so every row-shading block and colour panel on the page contributes two
    more `column boundaries`, and several of them land in the middle of a sentence. On NC's
    page 1 that gave nine verticals where the table has four, with 77.8 and 88.1 inside the
    WATER BODY column and 230.0 inside SIZE LIMIT. It is where `14-inch minimum, except 2 may
    be less than 14 inches` came apart into `14-inch minimum, e` and `xcept 2 may be`.

    A drawn vertical line is a rule somebody put there on purpose. Filtered by length, because
    a two-point tick is a bullet or a fraction bar and not a column.
    """
    pg = pdf.pages[page_no - 1]
    # LENGTH IS MEASURED AT THE X, NOT PER SEGMENT. A book draws a column rule either as one
    # line down the table or as one short segment beside every row, and NC does both -- its
    # page 1 rules run the full height while page 4's are per-row, none of them 40 points long.
    # Requiring a single long segment threw page 4's entire grid away and left it borrowing
    # another page's, which is how `8-inch min` / `imum` survived the first repair.
    drawn = defaultdict(float)
    for l in pg.lines:
        if abs(l['x0'] - l['x1']) < 0.6:
            drawn[round(l['x0'], 1)] += abs(l['y1'] - l['y0'])
    return sorted(x for x, total in drawn.items()
                  if total >= min_len and -1 <= x <= pg.width + 1)


def column_edges(pdf, page_no):
    """The vertical rules of the biggest ruled table on a page, inside the page box."""
    pg = pdf.pages[page_no - 1]
    found = pg.find_tables(table_settings=LINES)
    if not found:
        return []
    t = max(found, key=lambda x: len(x.cells))
    xs = {round(c[0], 1) for c in t.cells if c} | {round(c[2], 1) for c in t.cells if c}
    return sorted(x for x in xs if -1 <= x <= pg.width + 1)


def page_word_oracle(pdf, page_no, spread=1):
    """Every word the book actually prints around this page, as the judge of an extraction.

    ONE ORACLE, USED BY BOTH REPAIRS. extract_text() reads glyph runs in reading order without
    the ruled grid, so a word that appears in a cell and not here was made by the grid rather
    than printed by the book. heal_merged_cells() uses it to decide whether to join two cells
    and cells_that_cut_a_word() uses it to decide whether anything is still wrong; they must
    agree or the second undoes the first's verdict.

    Normalised the SAME WAY the cells are. norm() de-hyphenates across a line break, so a cell
    holding `Intra-\ncoastal` becomes `intracoastal` while the raw page still reads `Intra` and
    `coastal` -- and NC page 1's Intracoastal Waterway was reported as damage on every run for
    no other reason.

    The facing pages count, both of them. A table row can begin above the head of its page or
    run past its foot, and NC's list of community fishing waters does both -- judged against
    one page alone, Lake Corriher and Tumbling Rock Reservoir read as invented.
    """
    out = set()
    for k in range(page_no - spread, page_no + spread + 1):
        if k < 1 or k > len(pdf.pages):
            continue
        try:
            out |= set(re.findall(r'[a-z]{3,}', norm(pdf.pages[k - 1].extract_text() or '').lower()))
        except Exception:
            pass
    return out


def _join_fragments(x, y, page_words):
    """Two halves of one printed line, joined the way the page says they were."""
    # TIES ARE THE COMMON CASE and the tie-break is where this gets decided. `14` + `inches`
    # scores the same joined either way, because the oracle only reads letter runs of three or
    # more and `14inches` still yields `inches`. So does `inch` + `es` -- and those two want
    # OPPOSITE answers. A blanket preference for the space produced `less than 14 inch es` on
    # Lake Santeetlah's largemouth rule; a blanket preference for closing produced `14inches`.
    #
    # So on a tie, ask the page: if closing the seam spells a word it prints, close it.
    scored = []
    for sep in (' ', ''):
        cand = x + sep + y
        bad = sum(1 for w in re.findall(r'[a-z]{3,}', cand.lower()) if w not in page_words)
        scored.append((bad, cand))
    best_bad = min(b for b, _c in scored)
    tied = [c for b, c in scored if b == best_bad]
    if len(tied) == 1:
        return tied[0]
    tail = re.findall(r'[A-Za-z]+', x)
    head = re.findall(r'[A-Za-z]+', y)
    if tail and head and (tail[-1] + head[0]).lower() in page_words:
        return x + y
    return x + ' ' + y


def _seam_spells_a_word(a, b, page_words):
    """Do these two cells meet in the middle of a word?

    THE CUT-WORD CHECK CANNOT SEE THIS ONE. NC writes Cape Fear River's striped bass rule as
    `No striped bass may be possessed.` across the SIZE and CREEL columns, and the vertical cuts
    it into `No striped bass ma` and `y be possessed.` -- fragments of two characters and one.
    The oracle only reads letter runs of three or more, so neither is ever tested, every other
    word in the row is real, and the row passes as undamaged. A total prohibition then reaches a
    consumer as a size limit reading `No striped bass ma`, which is the worst thing this file
    can produce: not a gap, but an answer that is wrong.

    The seam is visible even when the fragments are not. `ma` + `y` spells `may`, which the page
    prints, and neither half is a word on its own -- that last part is what stops it firing on
    `14-inch minimum` beside `5`, where nothing joins.
    """
    la, lb = str(a).split('\n'), str(b).split('\n')
    if len(la) != len(lb):
        return False
    for x, y in zip(la, lb):
        tail = re.findall(r'[A-Za-z]+', x)
        head = re.findall(r'[A-Za-z]+', y)
        if not tail or not head:
            continue
        t, h = tail[-1].lower(), head[0].lower()
        if t in page_words or h in page_words:
            continue                      # both sides are whole words; nothing was cut
        if (t + h) in page_words:
            return True
    return False


def heal_merged_cells(cells, page_words):
    """Put back a sentence the book wrote across two columns and the grid cut in half.

    A ruled reader applies every vertical to every row, and a book does not. NC writes

        No freshwater mussels including the Asian clam may be taken or possessed.

    across the SIZE LIMIT and DAILY CREEL LIMIT columns as one merged cell, with no rule drawn
    between them on that row -- so the vertical at x=435.6 cuts both of its lines and the two
    cells come back interleaved:

        cell 1: `No freshwater mussels inclu` / `taken or p`
        cell 2: `ding the Asian clam may be`  / `ossessed.`

    THE LINE BREAKS SURVIVE EXTRACTION, which is the whole reason this needs no geometry.
    Joining the two cells line for line -- first line to first line, second to second --
    restores exactly what the book printed. Joining the strings whole would give
    `...inclu taken or pding...`, which is why the naive repair is wrong.

    WHETHER to join is not guessed either: a pair is merged only if merging removes words that
    the page does not print. The page is the oracle here as it is in cells_that_cut_a_word(),
    and a row nothing is wrong with is returned untouched.

    The merged text lands in the FIRST cell of the pair and the second is emptied, so every
    column index a spec declares still points where it did. That is also what the book means:
    there is no separate creel value on a row where the creel column is part of the sentence.
    """
    def cut(cs):
        return {w for c in cs if c
                for w in re.findall(r'[a-z]{3,}', str(c).lower()) if w not in page_words}

    if not page_words:
        return cells
    if not cut(cells) and not any(
            a and b and _seam_spells_a_word(a, b, page_words)
            for a, b in zip(cells, cells[1:])):
        return cells
    cells = list(cells)
    for i in range(len(cells) - 1):
        a, b = cells[i], cells[i + 1]
        if not a or not b:
            continue
        la, lb = str(a).split('\n'), str(b).split('\n')
        if len(la) != len(lb):
            continue                      # not two halves of the same wrapped block
        # WITH A SPACE OR WITHOUT IT, DECIDED LINE BY LINE. The cut falls inside a word on one
        # line and between two words on the next, in the same pair of cells:
        #
        #     No margined madtom | and tadpole madtom      -> needs the space
        #     may be p          | ossessed.                -> must not have one
        #
        # so a separator chosen once for the pair is wrong on half of it, and NC's madtom rule
        # came out either as `madtomand` or as `p ossessed.` depending which was picked. The
        # page decides each line, the same judge that decided to join the cells at all.
        joined = '\n'.join(_join_fragments(x, y, page_words) for x, y in zip(la, lb))
        trial = cells[:i] + [joined, ''] + cells[i + 2:]
        # Fewer cut words, OR a seam that spelled a word and no longer does. The second clause
        # is the only thing that can repair a cut the three-character floor hides.
        if len(cut(trial)) < len(cut(cells)) or (
                _seam_spells_a_word(a, b, page_words)
                and len(cut(trial)) <= len(cut(cells))):
            cells = trial
    return cells


def tables_on(pdf, page_no, min_rows=4, min_cols=3, settings=None):
    pg = pdf.pages[page_no - 1]
    # Computed once per page and only if a table is found. Healing happens BEFORE norm(),
    # which collapses the line breaks the repair depends on.
    words = None
    out = []
    for t in (pg.extract_tables(table_settings=settings or LINES) or []):
        if len(t) >= min_rows and max(len(r) for r in t) >= min_cols:
            if words is None:
                words = page_word_oracle(pdf, page_no)
            out.append([[norm(c) for c in heal_merged_cells(row, words)] for row in t])
    return out


SECTION = re.compile(r'GAME FISH SIZE & POSSESSION LIMITS\s+(.{4,70}?)\s*(?:•|$)', re.S)


IN_TABLE_TITLE = re.compile(r'((?:NONGAME|GAME) FISH SIZE & POSSESSION LIMITS)\s*(.{0,60})')


def row_section(cells):
    """The section title when it arrives as a table row rather than page text.

    Page 30 of the SC book carries TWO sections in one ruled grid -- NONGAME FISH, then GAME
    FISH: BREAM, REDBREAST SUNFISH, CRAPPIE... -- so a single label per page is wrong there.
    It also means the earlier labels `page 30` and `page 31` were not unidentified tables; they
    were correctly extracted tables whose title happened to live in a cell.
    """
    for c in cells:
        m = IN_TABLE_TITLE.search(c or '')
        if m:
            return norm((m.group(1) + ' ' + (m.group(2) or '')).strip())
    return None


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

    def take(n, tabs):
        """EVERY matching table on the page, not the first. The species groups are separate
        tables with identical headers -- SC's saltwater spread carries two on one page -- and
        stopping at the first silently drops the rest of the law. That is this function's
        whole reason for existing and it was briefly undone on 2026-08-28."""
        got = []
        for t in tabs:
            for hdr_i in range(0, min(6, len(t))):
                joined = ' | '.join(c.lower() for c in t[hdr_i])
                if all(w in joined for w in want):
                    rows = rows_after(t, hdr_i)
                    sect = None
                    for r in t[:hdr_i + 1]:
                        sect = row_section(r) or sect
                    got.append({'page': n, 'label': sect or page_label(pdf, n),
                                'header': t[hdr_i], 'rows': carry_water_body(rows)})
                    break
        return got

    def by_drawn_rules(n):
        """The page re-read against the rules the book actually drew on it."""
        xs = rules_only_edges(pdf, n)
        if len(xs) < 3:
            return []
        return take(n, tables_on(pdf, n, settings={
            'vertical_strategy': 'explicit', 'explicit_vertical_lines': xs,
            'horizontal_strategy': 'lines'}))

    read = []
    for n in pages:
        got = take(n, tables_on(pdf, n))
        if got:
            # A GRID THAT CUT A WORD WAS NOT THE TABLE'S GRID. The default reading takes its
            # verticals from pdfplumber's cell corners, which include the edges of every
            # shading rect on the page, and on NC's pages five of those land inside sentences.
            # Re-read against the drawn rules and keep that reading only if it is measurably
            # less damaged -- the page's own text is the judge either way, so this can never
            # make a page worse and never touches a page that was already clean.
            hurt = len(cells_that_cut_a_word(pdf, got))
            if hurt:
                retry = by_drawn_rules(n)
                if retry and len(cells_that_cut_a_word(pdf, retry)) < hurt:
                    for rec in retry:
                        rec['columns_from_drawn_rules'] = True
                    got = retry
        else:
            # NO HEADER MATCHED, AND THE GRID IS WHY. NC page 1 has five spurious verticals
            # and they cut `DAILY CREEL LIMIT*` into `DAILY CR` and `EEL LIMIT`, so nothing
            # matched and the page fell through to the continuation path -- which rescued it by
            # borrowing the NEXT page's cell corners, themselves polluted by two more. That is
            # where every cut row on page 1 came from. A page's own drawn rules are tried before
            # any other page's anything.
            got = by_drawn_rules(n)
            for rec in got:
                rec['columns_from_drawn_rules'] = True
        if got:
            out.extend(got)
            read.append(n)

    # A CONTINUATION PAGE OF THE SAME TABLE IS THE SAME TABLE, and its columns are in the same
    # places. NC's WARMWATER GAME FISH and NONGAME tables each run over two pages; the second
    # page of each carries extra vertical rules -- at x 3.5, 13.6, 77.8, 88.1 and 230 -- that
    # the first does not, and they cut straight through the text. `Lake Santeetlah (Graham Co.)`
    # came back as `Lake Sante` + `etl` + `ah (Graham Co.)`, so no header matched, no rows were
    # read, and the run still said it had found the table.
    #
    # THE GEOMETRY COMES OUT OF THE BOOK, NOT OUT OF A GUESS: the columns of a page that DID
    # read are handed to the page that did not, as explicit verticals. Striped bass and bodie
    # bass with their per-water rules are on one of those pages.
    if read:
        for n in [p for p in pages if p not in read]:
            for src in read:
                # The drawn rules first here too, for the same reason: the cell corners of the
                # source page carry its shading rects along with its columns.
                xs = rules_only_edges(pdf, src) or column_edges(pdf, src)
                if len(xs) < 3:
                    continue
                st = {'vertical_strategy': 'explicit', 'explicit_vertical_lines': xs,
                      'horizontal_strategy': 'lines'}
                got = take(n, tables_on(pdf, n, settings=st))
                if got:
                    for rec in got:
                        rec['columns_from_page'] = src
                    out.extend(got)
                    break
    return sorted(out, key=lambda r: r['page'])


def pages_the_rules_hid(pdf, headers, pages, taken):
    """Pages whose TEXT carries this table and whose RULING would not give it up.

    ABSENCE HAS TO BE PART OF THE VERDICT, NOT A FOOTNOTE UNDER IT -- the same lesson
    chart_currency.py learned about a tile the current store does not have.

    NC's nongame table runs over two pages. Page 14 extracts cleanly. Page 15 -- GRASS CARP,
    KING MACKEREL, MULLET, RIVER HERRING, and the grass carp possession bans naming Lake James,
    Lookout Shoals, Mountain Island, Wylie, Gaston, Kerr, Norman and Roanoke Rapids -- comes back
    from the ruled reader as single merged cells like `Inland Fi NONG SPECIES GRASS C`. The
    table was found, the run said so, and half of it was never read. Nothing reported that,
    because "found a table" and "read the table" were the same sentence.

    This is deliberately a TEXT test, not another table strategy: if the words are on the page
    and no ruled row matched them, that is a page a person needs to know about.

    `taken` is every page already read BY ANY READER, not just by this table's ruling. GA page 3
    prints the words SPECIES and DAILY LIMIT in the prose above the statewide table, which sits
    on page 4, so this reported page 3 as `READ BUT NOT ALL OF IT` on every run since the ledger
    was built -- while read_ga_prose() was reading all twenty-two of its rules. A warning that is
    wrong every time is the same failure as no warning at all.
    """
    want = [h.lower() for h in headers]
    hid = []
    for n in pages:
        if n in taken:
            continue
        try:
            txt = (pdf.pages[n - 1].extract_text() or '').lower()
        except Exception:
            continue
        # ON ONE LINE, because a header row is one line. Against the whole page this fired on
        # six tables at once, including NC page 1 -- an introduction that happens to use the
        # words species, size limit and creel in prose. A list that cries wolf is a list nobody
        # reads, which is the same failure as reporting nothing.
        if any(all(w in line for w in want) for line in txt.splitlines()):
            hid.append(n)
    return hid


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


# ─────────────────────────────────────────────────────────────────────────────────────────────
# PROSE -- the law GA keeps in sentences instead of cells
# ─────────────────────────────────────────────────────────────────────────────────────────────
#
# Georgia is at four waters with a rule while South Carolina is at thirty-four, and the reason
# is not that Georgia regulates less. Its per-water length limits are a bulleted list under an
# all-caps species heading, and its seasons are four sentences. No table reader can ever see
# either. Ryan, reading the page this comes off: "size limits for georgia are not on the chart,
# they are on the page before that".
#
# THE COLUMNS OVERLAP, SO THEY CANNOT BE FOUND BY LOOKING FOR WHITE SPACE. extract_text() reads
# straight across a three-column page and returns `There is no closed season for fishing in
# • Lake Blue Ridge: no minimum (0 inches) River; Oconee` as one line. There is no vertical
# gutter to split on either -- the ink histogram is unbroken from x=13 to x=540, because lines
# wrap to different widths. What IS clean is where each column STARTS: every bullet on the page
# begins at x=36, 207 or 378, and so does every heading. The grid is read off those marks, once
# for the whole section, because the book uses one grid.

BULLET = re.compile(r'^\s*[•\u2022\u25cf\u00b7]\s*')
CAPS_LINE = re.compile(r'^[A-Z][A-Z0-9 ,&/\.\'()-]{3,}$')
STATEWIDE_DEFAULT = re.compile(r'^(?P<rule>[^:]*\b(?:inch|inches)\b[^:]*)\s+statewide\b', re.I)


def column_starts(pages, min_sep=120.0, expect=None):
    """Where each column begins, read off the bullets of the pages themselves.

    BULLETS ONLY, AND ONLY WHERE THEY START A LINE. A first pass counted every all-caps word,
    which on this page includes CLOSED and GA sitting mid-sentence at x=77 and x=113; the grid
    came out at those and the crops cut through `Spring` and `BASS`. A bullet glyph is only ever
    at a column's left edge, and there are twenty-two of them on the page.
    """
    marks = Counter()
    for pg in pages:
        for w in pg.extract_words():
            if BULLET.match(w['text']):
                marks[round(w['x0'])] += 1

    # NOT the leftmost word of each line. extract_words() reads straight across a three-column
    # page, so the third column's bullets never begin a line -- taking only line-initial words
    # found two columns of three and the crop then merged the last two.
    def grid(floor):
        starts = []
        for x in sorted(marks):
            if marks[x] < floor:
                continue
            if not starts or x - starts[-1] >= min_sep:
                starts.append(x)
        return starts

    starts = grid(2)                       # one bullet is an indent, not a column
    # A DECLARED COLUMN COUNT OUTRANKS THAT RULE, and only where it is declared. GA's
    # demarcation page has three columns and one of them carries a single bullet, so the
    # >= 2 test found two edges and the crop cut the middle column's text in half -- the first
    # clause named four rivers and lost six. Where the caller says how many columns the page
    # has, a lone bullet is allowed to be a column, but only if that produces exactly the
    # declared number. Anything else falls back, because a count that does not come out is
    # evidence the grid is wrong, not licence to use a worse one.
    if expect and len(starts) != expect:
        loose = grid(1)
        if len(loose) == expect:
            starts = loose
    return starts


def column_lines(page, starts, top=0.0, bottom=1.0):
    """The page's text, column by column, in reading order.

    ONE LIST PER COLUMN, because nothing may join across a column boundary. The banner
    `FRESHWATER FISHING REGULATIONS` is split by the boundary into `FRESHWATER FISHING REGULA`
    and `ATIONS`; both are all-caps, so with the columns concatenated the heading-joining rule
    glued them onto the next real heading and EVANS COUNTY arrived as `FRESHWATER FISHING REGULA
    PUBLIC FISHING AREAS`. Two other fixes were tried first and both were worse: a height crop
    cut through the banner's glyphs and returned interleaved text, and dropping lines that
    repeat across pages dropped four real areas, because several PFAs publish the same species
    list word for word.
    """
    y0, y1 = page.height * top, page.height * bottom
    if len(starts) < 2:
        return [(page.crop((0, y0, page.width, y1)).extract_text() or '').splitlines()]
    out = []
    for i, x in enumerate(starts):
        x1 = (starts[i + 1] if i + 1 < len(starts) else int(page.width)) - 4
        seg = page.crop((max(0, x - 4), y0, min(page.width, x1), y1))
        out.append((seg.extract_text() or '').splitlines())
    return out


UNFINISHED = re.compile(r'(?:[,&/-]|\([^)]*)$')


def _joins_up(prev, nxt):
    """Is `nxt` the rest of the heading `prev`, or a new heading under a banner?

    A HEADING WRAPS ONLY WHERE IT IS VISIBLY UNFINISHED. `MARBEN PFA (CHARLIE ELLIOTT` has an
    open bracket and `STRIPED BASS, WHITE BASS, &` ends on an ampersand; both continue. The
    page banner `FRESHWATER FISHING REGULA` ends on nothing, and joining it swallowed EVANS
    COUNTY -- as its other half, `ATIONS`, prefixed HUGH M. GILLIS.

    Three cleverer versions of this were tried and all three were worse: cropping by height cut
    through the banner's glyphs, dropping lines that repeat across pages dropped four real areas
    because several PFAs publish the same species list word for word, and refusing to join
    across a column boundary did nothing because the banner sits inside one column.
    """
    return bool(UNFINISHED.search(prev.strip()))


def _paras(lines):
    """Bullets and headings as whole units, with their wrapped continuations folded in."""
    out = []
    for raw in lines:
        t = norm(raw)
        if not t:
            continue
        if BULLET.match(t):
            out.append(['bullet', BULLET.sub('', t)])
        elif CAPS_LINE.match(t):
            # `STRIPED BASS, WHITE BASS, &` and `HYBRID WHITE-STRIPED BASS` are one heading.
            if out and out[-1][0] == 'head' and _joins_up(out[-1][1], t):
                out[-1][1] += ' ' + t
            else:
                out.append(['head', t])
        else:
            if out and out[-1][0] in ('bullet', 'text'):
                out[-1][1] += ' ' + t
            else:
                out.append(['text', t])
    return out


def read_ga_prose(pdf, pages):
    """GA's LENGTH LIMITS and SEASONS, as rows a resolver can bind.

    Returns rows shaped like a table's, so everything downstream -- resolve_water_body,
    closures_in, expand_species -- treats them exactly like a ruled row and nothing special
    has to know they came out of a paragraph.
    """
    live = [(n, pdf.pages[n - 1]) for n in pages if 1 <= n <= len(pdf.pages)]
    if not live:
        return []
    starts = column_starts([p for _n, p in live])
    rows, section, species, default = [], None, None, None
    for pageno, pg in live:
      for col in column_lines(pg, starts):
        for kind, text in _paras(col):
            if kind == 'head':
                up = text.upper()
                if up.startswith('SEASONS'):
                    section, species, default = 'seasons', None, None
                elif up.startswith('LENGTH LIMITS'):
                    section, species, default = 'length_limits', None, None
                elif section == 'length_limits':
                    species, default = text, None
                continue
            if section == 'length_limits' and kind == 'text' and species:
                md = STATEWIDE_DEFAULT.match(text)
                if md:
                    default = md.group('rule').strip()
                    rows.append({'cells': ['Statewide', species, default, text],
                                 'species': species, 'statewide_default': True,
                                 'page': pageno})
                continue
            if kind != 'bullet':
                continue
            if section == 'seasons':
                where, _, rule = text.partition(':')
                rows.append({'cells': [where.strip(), None, (rule or text).strip(), text],
                             'species': None, 'season': True, 'page': pageno})
            elif section == 'length_limits' and species:
                where, _, rule = text.partition(':')
                if not rule:
                    # NO COLON IS NOT NO RULE. `The minimum length is 27 inches on the Savannah
                    # River and its tributaries downstream of J. Strom Thurmond Dam` names a
                    # water we ship, inside a sentence. The whole bullet goes to the resolver,
                    # which pulls water names out of prose or reports it unresolved -- both are
                    # better than dropping it. A pointer like `See table on page 63` resolves to
                    # nothing and says so.
                    rows.append({'cells': [text, species, text, text],
                                 'species': species, 'statewide_default': False,
                                 'named_in_a_sentence': True, 'page': pageno})
                    continue
                rows.append({'cells': [where.strip(), species, rule.strip(), text],
                             'species': species, 'statewide_default': False, 'page': pageno})
    return rows


PFA_COUNTY = re.compile(r'^(?P<county>[A-Z][A-Za-z\. ]+?(?:/[A-Z][A-Za-z\. ]+?)*)\s+Count(?:y|ies)\b')
PFA_LABEL = re.compile(r'^(Fish\s+[Ss]pecies|Note|Water|Facilities|Directions|Fee|Restrictions|From|LICENSES)\s*:', )
FISH_SPECIES = re.compile(r'^Fish\s+[Ss]pecies\s*:\s*(?P<list>.+)$')
PFA_NOTE = re.compile(r'^Note\s*:\s*(?P<note>.+)$')
PFA_WATER = re.compile(r'^Water\s*:\s*(?P<water>.+)$')


def read_ga_pfa(pdf, pages):
    """Georgia's Public Fishing Areas -- its answer to SC's state lakes table.

    Ryan: "this looks to be the sc state lake equivalent in georgia... are we reading it".
    It was not. Same shape as SC's: an area-wide default with per-area overrides, except
    Georgia writes it as headed paragraphs instead of a ruled table.

    A HEADING IS ONLY A PFA IF A `Fish Species:` LINE FOLLOWS IT. The same pages carry a county
    map whose labels are live text -- `DECATUR GRADY THOMAS BROOKS LOWNDES CLINCH CHARLTON
    CAMDEN` is one all-caps line -- and every one of them would otherwise read as an area.

    The `Fish Species:` list rides on the row. Nothing consumes it here; it is the per-water
    species list the research side has been short of, and dropping it because this reader is
    about limits is how it gets re-derived later.
    """
    live = [(n, pdf.pages[n - 1]) for n in pages if 1 <= n <= len(pdf.pages)]
    if not live:
        return []
    starts = column_starts([p for _n, p in live])
    rows, head, pending, county = [], None, None, None

    def labelled(lines):
        """Paragraphs that break on a LABEL as well as on a bullet or a heading.

        _paras() folds every non-bullet, non-heading line into the one above it, which is right
        for a wrapped sentence and wrong here: `Fish Species: Largemouth bass, ...` arrived
        glued to the phone number above it and no area was ever recognised.
        """
        out = []
        for raw in lines:
            t = norm(raw)
            if not t:
                continue
            if CAPS_LINE.match(t):
                if out and out[-1][0] == 'head' and _joins_up(out[-1][1], t):
                    out[-1][1] += ' ' + t
                else:
                    out.append(['head', t])
            elif PFA_LABEL.match(t):
                out.append(['label', t])
            elif out and out[-1][0] in ('label', 'text'):
                out[-1][1] += ' ' + t
            else:
                out.append(['text', t])
        return out

    def flush(pageno=None):
        if pending and pending.get('notes'):
            for nt in pending['notes']:
                rows.append({'cells': [pending['area'], None, nt, nt,
                                       pending.get('county')],
                             'species': None, 'pfa': True, 'page': pending.get('page'),
                             'fish_species': pending.get('species'),
                             'water': pending.get('water')})
        elif pending:
            rows.append({'cells': [pending['area'], None, '', pending.get('species') or '',
                                   pending.get('county')],
                         'species': None, 'pfa': True, 'page': pending.get('page'),
                         'fish_species': pending.get('species'),
                         'water': pending.get('water')})

    for pageno, pg in live:
      for col in column_lines(pg, starts):
        flush(); pending, head, county = None, None, None
        for kind, text in labelled(col):
            if kind == 'head':
                flush()
                pending, head, county = None, text, None
                continue
            m_sp = FISH_SPECIES.match(text)
            if m_sp and head:
                flush()
                pending = {'area': head, 'species': m_sp.group('list').strip(),
                           'notes': [], 'county': county, 'page': pageno}
                continue
            m_c = PFA_COUNTY.match(text)
            if m_c and head and not pending:
                county = m_c.group('county').strip()
                continue
            if not pending:
                continue
            m_n = PFA_NOTE.match(text)
            if m_n:
                pending['notes'].append(m_n.group('note').strip())
                continue
            m_w = PFA_WATER.match(text)
            if m_w:
                pending['water'] = m_w.group('water').strip()
    flush()
    return rows


SC_SECTION = re.compile(r'^(Seasons|Prohibited Practices|Selling and Importing|'
                        r'Methods and Devices|Freshwater Game Fish)\s*$')
# A CLOSURE THAT REPEATS IS NOT A CLOSURE THIS APP CAN EXPRESS, and typing it as one shuts a
# lake for good. `Hatchery WMA on Lake Moultrie is closed to fishing each Saturday until 12:00
# noon` matches the undated branch of closures_in() exactly -- `closed to fishing` plus the word
# closed, no dates -- and would have come out as Lake Moultrie, all fishing, permanently shut.
RECURRING = re.compile(r'\b(each|every|weekly|daily)\s+(mon|tues|wednes|thurs|fri|satur|sun)day\b'
                       r'|\b(mon|tues|wednes|thurs|fri|satur|sun)days\b'
                       r'|\bweeks?\s+(prior|before|after)\b'
                       r'|\b(prior to|after)\s+the\b', re.I)


def read_sc_prose(pdf, pages):
    """SCDNR's `Seasons` block, which is where South Carolina says what is shut.

    The ruled tables carry the per-species windows; this page carries the AREA closures, and
    they name real water: Cantey Bay, Black Bottom and Savannah Branch on Lake Marion shut
    Nov. 1 through Feb. 28, and the Hatchery WMA on Lake Moultrie.

    Its headings are title case -- `Seasons`, `Prohibited Practices` -- so the all-caps rule the
    GA reader uses does not see them, and its bullets carry the water inside the sentence rather
    than before a colon. Both are handled here rather than by loosening the GA reader onto a
    book it was not read against.
    """
    live = [(n, pdf.pages[n - 1]) for n in pages if 1 <= n <= len(pdf.pages)]
    if not live:
        return []
    starts = column_starts([p for _n, p in live])
    def blocks(lines):
        """_paras() folds a short title-case line into the paragraph above it, which is right
        for a wrapped sentence and wrong for `Seasons` -- so the section headings break the
        stream themselves. Same shape of fix as the PFA labels one page-family over."""
        out = []
        for raw in lines:
            t = norm(raw)
            if not t:
                continue
            if SC_SECTION.match(t):
                out.append(['section', t])
            elif BULLET.match(t):
                out.append(['bullet', BULLET.sub('', t)])
            elif out and out[-1][0] in ('bullet', 'text'):
                out[-1][1] += ' ' + t
            else:
                out.append(['text', t])
        return out

    rows = []
    for pageno, pg in live:
        for col in column_lines(pg, starts):
            section = None
            for kind, text in blocks(col):
                if kind == 'section':
                    section = text.strip()
                    continue
                if section != 'Seasons' or kind != 'bullet':
                    continue
                if re.search(r'\bsee\b.*\bpage\s+\d+', text, re.I) and 'prohibit' not in text.lower():
                    continue          # `see Freshwater Fish Size and Possession limits page 30`
                # THE SENTENCE ONCE. Carrying it in three cells made closures_in() read it
                # three times and Lake Marion's area closure arrived in triplicate.
                rows.append({'cells': [text, None, ''], 'species': None,
                             'season': True, 'page': pageno,
                             'recurring': bool(RECURRING.search(text))})
    return rows


DEMARCATION_HEAD = re.compile(r'SALTWATER DEMARCATION LINE', re.I)
# Which of the three clauses a sentence is. The book writes them as three bullets and they do
# not mean the same thing, so they are not flattened into one list of river names.
DEMARC_CLAUSE = [
    # ORDER IS THE TIE-BREAK, most specific first. The crabbing bullet also contains the words
    # `seaward of the points at which`, so a looser test placed above it would file GA's crab
    # line as the finfish line and move the boundary by a railroad.
    ('crabbing only', re.compile(r'for purposes of crabbing', re.I)),
    ('salt for its entire length',
     re.compile(r'designated as salt water for (?:their|its) entire length', re.I)),
    ('salt seaward of a named crossing',
     re.compile(r'\bline of demarcation\b|\bseaward of these points\b', re.I)),
]
# The landmark a clause draws its line at. `Georgia Highway 25/South Carolina 170` is ONE
# crossing written as two route numbers, so the second half is part of the match rather than a
# designation of its own -- split, it reads as two lines on a river the book gives one.
CROSSING = re.compile(r'\b((?:U\.?S\.?|Georgia|South Carolina|Interstate|I)[- ]?'
                      r'(?:Highway\s*)?\d+(?:\s*/\s*(?:South Carolina|Georgia|SC|GA)'
                      r'\s*(?:Highway\s*)?\d+)?'
                      r'|Seaboard Coastline Railroad)\b')


def read_ga_demarcation(pdf, pages, columns=3):
    """Georgia's saltwater demarcation line -- the page that says which water is which.

    THIS PAGE DEFINES A WORD THE TABLES ALREADY USE. GA's freshwater striped bass rule ends
    `...and from saltwater`, and its saltwater table carries a separate `Striped bass
    (Saltwater)` row at 22 inches. Both turn on a term neither page defines. This one does:
    the line is where U.S. 17 crosses ten named rivers, where GA 25 / SC 170 crosses the
    Savannah, and seven more streams that are salt end to end.

    WHAT IT DOES NOT DO IS CLASSIFY A WATER. The Satilla is named here, and the Satilla we
    offer is bound in Pierce County, tens of miles above US 17. Calling it saltwater on the
    strength of the name would be an inference from a county, not a reading of the book. So
    each clause is emitted as an address with its sentence attached, resolve_water_body() binds
    the names the way it binds every other address, and the record says where the line is
    rather than which side of it a water sits on.

    The crabbing clause is read and kept as its own clause rather than dropped, because it is
    the one place the book draws a DIFFERENT line for the same rivers -- the Seaboard Coastline
    Railroad, not US 17. Nothing in the planner asks it today; misfiling it under the finfish
    line later would be worse than carrying it labelled.

    Three columns, declared. column_starts() reads bullets, and on this page the bullets are in
    the demarcation column and the FIVE THINGS box only -- two of the three -- so the automatic
    grid merged the definitions column into the first and cut the first bullet in half. A
    column COUNT is a fact about the page's layout, in the same class as the page numbers and
    column indices already declared in SPECS, and unlike a pixel it survives a reflow.
    """
    live = [(n, pdf.pages[n - 1]) for n in pages if 1 <= n <= len(pdf.pages)]
    rows = []
    for pageno, pg in live:
        # THE BULLETS ARE THE COLUMN EDGES, with the count declared because one of the three
        # columns holds a single bullet. An even split of the text block was tried first and
        # was wrong by about ten points: these bullets hang outside the text indent, so every
        # computed edge landed to the right of its own bullet and orphaned it.
        starts = column_starts([pg], expect=columns)
        if len(starts) != columns:
            continue

        # THE SECTION, IN READING ORDER, ACROSS THE COLUMN BREAK. It begins under its own
        # heading in one column and finishes at the top of the next, and both halves are needed
        # -- the first bullet names four rivers before the break and six after it. Collection
        # stops at the next heading in each column, which is what keeps the FIVE THINGS YOU CAN
        # DO sidebar out; the leading heading of a later column is the page banner, split down
        # the middle by the same boundary, and is skipped rather than treated as a stop.
        run, started = [], False
        for col in column_lines(pg, starts):
            taken = 0
            for kind, text in _paras(col):
                if not started:
                    if kind == 'head' and DEMARCATION_HEAD.search(text):
                        started = True
                    continue
                if kind == 'head':
                    if taken == 0:
                        continue          # the banner, cut in half by the column boundary
                    break                 # a real heading -- the section is over
                run.append((kind, text))
                taken += 1
        if not run:
            continue

        # ONE CLAUSE PER BULLET, TAKEN FROM THE PARAGRAPH STREAM. Splitting the joined text on
        # the glyph was tried and cannot work: _paras() strips the glyph when it recognises the
        # bullet, so by the time the text is joined the boundaries are gone and all three
        # clauses arrive as one. A `text` paragraph before the first bullet is the section's
        # own lead-in; after one, it is that bullet continuing -- which is how the first clause
        # gets the six rivers that sit on the other side of the column break.
        clauses = []
        for kind, text in run:
            if kind == 'bullet':
                clauses.append(text)
            elif clauses:
                clauses[-1] += ' ' + text
        for part in clauses:
            part = norm(re.sub(r'^[,;\s]+', '', part))
            part = re.sub(r'\s+\d{1,3}$', '', part)   # the folio, swept up by the last clause
            if len(part) < 40:
                continue
            clause = next((name for name, rx in DEMARC_CLAUSE if rx.search(part)), None)
            if not clause:
                continue
            rows.append({'cells': [part, None, part], 'species': None,
                         'demarcation': True, 'clause': clause,
                         'crossings': sorted(set(CROSSING.findall(part))),
                         'named_in_a_sentence': True, 'page': pageno})
    return rows


PROSE = {
    'SC': [('seasons', [20], 'sc',
            {'water_col': 0, 'species_col': 1, 'name_in_sentence': True})],
    # (key, pages, reader, opts). Shaped exactly like a ruled table on the way out, so
    # resolve_state_tables(), project_by_water() and closures_in() need to know nothing about
    # where the rows came from.
    'GA': [('length_limits_and_seasons', [3], 'ga',
            {'water_col': 0, 'species_col': 1}),
           ('public_fishing_areas', [8, 9, 10], 'ga_pfa',
            {'water_col': 0, 'species_col': 1, 'county_col': 4}),
           # The definition behind `and from saltwater`, which two tables already lean on.
           ('saltwater_demarcation', [22], 'ga_demarc',
            {'water_col': 0, 'species_col': None})],
}


def read_prose_state(path, state):
    pdfplumber = _pdfplumber()
    out = {}
    with pdfplumber.open(path) as pdf:
        for key, pages, reader, _opts in PROSE.get(state) or []:
            rows = (read_ga_prose(pdf, pages) if reader == 'ga'
                    else read_ga_pfa(pdf, pages) if reader == 'ga_pfa'
                    else read_ga_demarcation(pdf, pages) if reader == 'ga_demarc'
                    else read_sc_prose(pdf, pages) if reader == 'sc' else [])
            if rows:
                # ONE PSEUDO-TABLE PER PAGE, not one for the section. The page ledger asks which
                # pages were read, and a three-page PFA listing filed under `pages[0]` reported
                # two of its own pages as never read.
                by_page = {}
                for r in rows:
                    by_page.setdefault(r.get('page') or pages[0], []).append(r)
                out[key] = [{'page': p, 'label': 'prose: %s' % key,
                             'header': ['water', 'species', 'rule', 'sentence'],
                             'rows': rs}
                            for p, rs in sorted(by_page.items())]
    return out


LAW_WORDS = re.compile(r'\b(inch|inches|creel|per day|daily limit|possession limit|'
                       r'size limit|closed season|open season|minimum length|no minimum)\b', re.I)


def page_ledger(pdf, read_pages, smap, declared):
    """Every page of the book placed in exactly one bucket, so `read` means something.

    THE COUNT THAT MATTERS IS NOT HOW MANY PAGES WERE READ. It is how many carry fishing law and
    were NOT. Before this, 18 of 168 pages across the three books had been read and nothing in
    the pipeline could tell "not a regulation page" from "a regulation page nobody read" -- so
    every gap found on 2026-08-28 was found by a person turning pages.

    A page carries law if it names at least TWO species the map knows AND a limit or season
    word. Two, not one: a species profile or a records table names one fish in passing. The test
    over-reports and that is the safe direction -- an over-reported page is one judgement, made
    once, and recorded in registry/pages_not_law.json with its reason.

    `declared` is that file. It is written by whoever reads the page, never by this script, and
    a page in it is accounted for rather than silently skipped.
    """
    phrases = sorted({p.lower() for p in smap_phrases(smap) if len(p) > 4},
                     key=len, reverse=True)
    if not phrases:
        return None
    rx = re.compile('|'.join(re.escape(p) for p in phrases))
    out = {'read': [], 'not_law': [], 'blank': [], 'declared': [], 'unaccounted': []}
    for n in range(1, len(pdf.pages) + 1):
        if n in read_pages:
            out['read'].append(n)
            continue
        try:
            text = pdf.pages[n - 1].extract_text() or ''
        except Exception:
            text = ''
        if not text.strip():
            out['blank'].append(n)
            continue
        law = len(set(rx.findall(text.lower()))) >= 2 and bool(LAW_WORDS.search(text))
        if not law:
            out['not_law'].append(n)
        elif str(n) in declared:
            out['declared'].append({'page': n, 'why': declared[str(n)]})
        else:
            out['unaccounted'].append(n)
    return out


def read_tn_statewide(path, page=1):
    """TWRA's `Statewide Creel and Length Limits`, which nothing had ever read.

    TENNESSEE HAD NO STATEWIDE DEFAULTS AT ALL, and "TN is 100% covered" hid it: true of the
    ten lakes the card offers, and silent about the book. Every TN water without a
    lake-specific exception answered nothing, on a page that says in its own words -- "If you
    are fishing a location that does not have exceptions listed in this guide, then the
    statewide limits apply."

    Found because Ryan asked whether 168 pages was all four states. It was three: TN reads
    pages 11-17 through its own reader and never passed through the page ledger.
    """
    pdfplumber = _pdfplumber()
    with pdfplumber.open(path) as pdf:
        if page > len(pdf.pages):
            return []
        for t in tables_on(pdf, page, min_rows=4, min_cols=3):
            for hdr_i in range(0, min(4, len(t))):
                joined = ' | '.join(c.lower() for c in t[hdr_i])
                if 'species' in joined and 'creel' in joined:
                    # Off the same header every other table's are read from. These records are
                    # built here rather than in the row loop, which is twice now the reason
                    # they missed something the rest of the pipeline does for free.
                    scol, ccol = limit_columns(t[hdr_i])
                    out = []
                    for row in rows_after(t, hdr_i):
                        cells = row['cells'] if isinstance(row, dict) else row
                        sp = (cells[0] or '').strip() if cells else ''
                        if not sp:
                            continue
                        rec = {'source': 'TN tn_digest_2026_2027.pdf',
                               'table': 'tn_statewide', 'label': 'page %d' % page,
                               'page': page, 'address': 'Statewide',
                               'cells': list(cells), 'species': sp}
                        for fld, ix in (('size_limit', scol), ('creel_limit', ccol)):
                            if ix is not None and ix < len(cells) and cells[ix]:
                                rec[fld] = cells[ix]
                        out.append(rec)
                    return out
    return []


def _is_a_cut_word(w, page_words):
    """Is this word a PIECE of something the page prints, or just a word the page lacks?

    THE DIFFERENCE IS THE WHOLE TEST, and getting it wrong costs law. `a word the page does not
    print` was the first cut of this rule and it was too loose: SC's book returned `hardhead`,
    `southern`, `hamilton`, `american` and `permitting` as damage, from cells that are perfectly
    well formed -- `Flounders (Southern, Summer & Gulf)`, `Dunn's Pond on Hamilton Ridge`. Those
    rows were then WITHHELD from /regulations as untrustworthy, which is a worse failure than
    the one this function exists to catch: real law, read correctly, refused.

    Why they are absent at all is pdfplumber's business, not this file's -- extract_text() and
    extract_tables() do not always recover the same glyphs from a page, and on SC page 50 the
    first word inside a parenthesis is one of the ones text mode drops. This function cannot
    assume the two agree. What it CAN say precisely is what a grid cut looks like:

    A CUT WORD IS A FRAGMENT: the page prints a longer word that this is the front or back of.
    `xcept` of `except`, `inche` of `inches`, `mit` of `limit`, `regardle` of `regardless`,
    `posse` of `possessed`. That is the entire test.

    The obvious companion test -- does it split into two words the page prints, catching a
    fusion like `archeryequipment` -- is deliberately NOT here. `hardhead` splits into `hard`
    and `head`, and a page that says "landed with head and tail intact" prints both, so the
    test would condemn a real species name. It is also no longer needed: _join_fragments()
    consults this same page before choosing whether to close a join, and takes the closed form
    only when it strictly reduces unknown words -- so a wrong fusion cannot be produced in the
    first place.
    """
    for pw in page_words:
        if len(pw) <= len(w):
            continue
        # THE ORACLE HAS SEAMS OF ITS OWN. extract_text() fuses words across a line or column
        # break, and SC page 50's neighbour yields `permitamerican` -- which ends in `american`
        # and so made `American Shad` look like a fragment of something. A longer page word
        # that decomposes into the candidate plus ANOTHER page word is an artifact of the same
        # kind this function is trying to detect, and cannot be the evidence for it.
        if pw.startswith(w) and pw[len(w):] not in page_words:
            return True
        if pw.endswith(w) and pw[:len(pw) - len(w)] not in page_words:
            return True
    return False


def cells_that_cut_a_word(pdf, tables):
    """Rows whose ruled extraction sliced through a word, judged against the page's own text.

    NC's statewide largemouth bass limit reads `14-inch minimum, except 2 may be less than 14
    inches`. The ruled reader returns it as four cells: `14-inch minimum, e`, `xcept 2 may be`,
    `less than 14`, `inches`. The row is there, the row is wrong, and nothing said so -- the
    same failure page ledger was built for, one level down. It matters more now that these
    records are served: shipping a mangled limit is worse than shipping none, because it looks
    like an answer.

    THE PAGE IS ITS OWN ORACLE. extract_text() reads glyph runs in reading order without the
    ruled grid, so a word that appears in a cell and NOT in the page's own text was cut by the
    grid, not printed by the book. `xcept`, `inche`, `onl` and `hes` are in the cells and in no
    book. No heuristic, no dictionary, no threshold -- just the two readings of one page
    disagreeing, which is exactly the thing worth reporting.

    Two-letter and shorter runs are skipped: they are initials and units as often as damage,
    and the damage this catches is never that small.
    """
    bad = []
    for tb in tables:
        n = tb.get('page')
        page_words = page_word_oracle(pdf, n)
        if not page_words:
            continue
        for row in tb.get('rows') or []:
            cut = sorted({w for c in (row.get('cells') or []) if c
                          for w in re.findall(r'[a-z]{3,}', str(c).lower())
                          if w not in page_words and _is_a_cut_word(w, page_words)})
            if cut:
                # MARKED ON THE ROW, not only counted in a report. These records are served
                # now, and a limit that reads `14-inch minimum, e` must not reach somebody
                # about to keep a fish looking like an answer.
                row['text_cut_by_the_grid'] = cut
                bad.append({'page': n, 'cells': row.get('cells'), 'not_on_the_page': cut})
    return bad


def read_pdf_state(path, specs, smap=None, declared=None, extra_read=()):
    """`specs` is a list of (key, header-words, candidate-pages). Anything not found is
    reported by name rather than silently omitted -- a table that quietly vanishes between
    editions is how a book gets read wrong for a year."""
    pdfplumber = _pdfplumber()
    got, missing, ledger = {}, [], None
    with pdfplumber.open(path) as pdf:
        last = len(pdf.pages)
        for key, headers, pages, _opts in specs:
            pages = [p for p in pages if 1 <= p <= last]
            found = collect_tables(pdf, headers, pages)
            if not found:
                missing.append({'table': key, 'looked_for': headers, 'pages_searched': pages})
                continue
            # The state lakes spread's RIGHT page is read by read_sc_state_lakes() below, by
            # position rather than by header, so it is not unread -- it is read elsewhere.
            found_pages = {f['page'] for f in found}
            seen_pages = found_pages | set(extra_read)
            if key == 'state_lakes':
                seen_pages |= {p + 1 for p in found_pages}
            hid = pages_the_rules_hid(pdf, headers, pages, seen_pages)
            if hid:
                missing.append({'table': key, 'why': 'the page carries this table in its text '
                                'and its ruling yields no matching row -- READ BUT NOT ALL OF '
                                'IT', 'pages_not_read': hid,
                                'pages_read': sorted({f['page'] for f in found})})
            cut = cells_that_cut_a_word(pdf, found)
            if cut:
                missing.append({'table': key, 'why': 'the ruled grid sliced through words that '
                                'the page itself prints whole -- the row was found and what it '
                                'says is wrong', 'rows_cut': len(cut),
                                'examples': cut[:4]})
            got[key] = found
        sc_lakes = None
        if any(k == 'state_lakes' for k, _, _, _ in specs):
            pages = [p for k, _, p, _ in specs if k == 'state_lakes'][0]
            pages = [p for p in pages if 1 <= p <= last]
            sc_lakes, err = read_sc_state_lakes(pdf, pages, [p + 1 for p in pages])
            if err:
                missing.append({'table': 'state_lakes_join', 'why': err})
        read_pages = {f['page'] for tabs in got.values() for f in tabs} | set(extra_read)
        if sc_lakes:
            # The spread's RIGHT page is read by read_sc_state_lakes() by position rather than
            # by header, so it is read -- just not by collect_tables. ONLY the state lakes
            # table's own pages get the +1: applying it to every read page marked the page after
            # each striped-bass table as read too, which is three pages this has no business
            # vouching for.
            read_pages |= {f['page'] + 1 for f in (got.get('state_lakes') or [])}
        ledger = page_ledger(pdf, read_pages, smap or {}, declared or {})
    return got, missing, sc_lakes, ledger


# WHICH COLUMN HOLDS THE ADDRESS is not the same in every book, and assuming column 0 put 104
# NC and GA rows into `unresolved` when the books were read perfectly well.
#
#   SC   column 0 is the water body                    `Santee River system`
#   NC   column 0 is the water SCOPE under an all-caps SPECIES BAND -- `WHITE BASS` heads the
#        band and `All inland fishing waters and...` is the address under it. The band rows are
#        headings, not addresses, and reading them as waters looks for a lake called WHITE BASS.
#   GA   the statewide table's column 0 is a SPECIES and carries no address at all; the rule is
#        statewide by construction. Only its water-body exceptions table has an address, in
#        column 1.
BAND = re.compile(r'^[A-Z][A-Z0-9 &/\.\'(),-]{3,}$')
# A BAND THAT NAMES WATER IS A SUB-HEADING, NOT A FISH.
#
# NC heads its striped bass block `STRIPED BASS AND BODIE BASS (STRIPED BASS HYBRID)` and then
# splits it with `INLAND IMPOUNDMENTS AND TRIBUTARIES` and `COASTAL RIVERS AND IMPOUNDMENTS`.
# Both are all-caps rows with an empty rest, so both read as a new species and overwrote the
# real one -- which is why North Carolina answered for zero of the fifteen plan species on
# striped bass while its book plainly sets one.
ADDRESS_BAND = re.compile(r'\b(WATERS?|IMPOUNDMENTS?|RIVERS?|TRIBUTARIES|LAKES?|RESERVOIRS?|'
                          r'CREEKS?|SOUNDS?|COASTAL|INLAND|JOINT|STATEWIDE)\b')

SPECS = {
    'SC': ('Regs2627.pdf', [
        ('striped_white_hybrid_bass', ['water body', 'fish', 'size limit'], list(range(28, 40)),
         {'water_col': 0}),
        ('state_lakes', ['county', 'water body', 'open days'], list(range(32, 42)),
         {'water_col': 1, 'county_col': 0}),
        # SC's coast, out of the same book. Its column is headed CLOSED SEASON where GA's is
        # OPEN SEASON -- the opposite sense on identical-looking strings, which is exactly why
        # the sense is declared here beside the column rather than guessed from the contents.
        ('saltwater', ['species', 'closed season', 'bag limit'], list(range(45, 60)),
         {'water_col': None, 'species_col': 0, 'season_col': 1, 'season_sense': 'closed',
          'implicitly': 'statewide coastal'}),
    ]),
    'NC': ('nc_digest_2026_2027.pdf', [
        # NC's header text is cut by the column rules -- `SIZE LIMIT` arrives as `SIZE LIM`
        # plus `IT` in two cells -- so the match is on fragments that survive the split.
        ('warmwater_game_fish', ['species', 'size lim', 'creel'], list(range(1, 9)),
         {'water_col': 0, 'species_bands': True}),
        # NONGAME, added 2026-08-28 because Ryan asked whether it was being read. It was not,
        # and it carries a PLAN SPECIES: `CATFISH (BLUE, CHANNEL, & FLATHEAD)` with named-water
        # exceptions -- the Pee Dee below Blewett Falls at 5 in combination, Badin Lake and the
        # Dan River with no creel limit on blue catfish. Cobia carries a season in its creel
        # cell, `1 (May 1 - Dec. 31)`, the same shape as flounder's in the game table.
        #
        # `creel` is NOT a usable header fragment here: the column rule cuts DAILY CREEL LIMIT
        # into `DAILY CR` and `EEL LIMIT`, so the word creel survives in neither cell. Matching
        # on it found nothing and read as "this table does not exist".
        ('nongame_fish', ['species', 'size lim', 'daily cr'], list(range(12, 16)),
         {'water_col': 0, 'species_bands': True}),
    ]),
    'GA': ('ga_digest_2026_2027.pdf', [
        ('statewide', ['species', 'daily limit'], list(range(1, 12)),
         {'water_col': None, 'species_col': 0, 'implicitly': 'statewide'}),
        ('water_body_exceptions', ['species', 'water body', 'possession limit'], list(range(1, 12)),
         {'water_col': 1, 'species_col': 0}),
        ('saltwater', ['species', 'open season'], list(range(18, 30)),
         {'water_col': None, 'species_col': 0, 'season_col': 1,
          'implicitly': 'statewide coastal'}),
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
    systems = load_systems(R(a.registry))
    # LOADED BEFORE THE FIRST READER, not before the state loop. resolve_state_tables() needs
    # the species map -- a band phrase the map already knows is a species, and only an unknown
    # one is tested for water nouns -- but so does Tennessee's page ledger, and TN is read forty
    # lines above the state loop. Bound down there, both names were local-before-assignment and
    # TN's ledger threw on every run since it was added. It threw inside a try that files the
    # failure as a `problem`, so the book came out looking like a data question -- `page ledger
    # failed` -- rather than the line-ordering bug it was. Second one of these found today.
    smap = load_species_map(R(a.registry))
    nlp = os.path.join(R(a.registry), 'pages_not_law.json')
    not_law = (json.load(open(nlp, encoding='utf-8')).get('pages') or {}) \
        if os.path.exists(nlp) else {}
    wcp = os.path.join(R(a.registry), 'water_chain.json')
    chain = (json.load(open(wcp, encoding='utf-8')).get('waters') or {}) if os.path.exists(wcp) else {}
    print('chain:    %d waters, %d book systems defined' % (len(chain), len(systems.get('systems') or {})), flush=True)
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
              'county' % (dg['blocks_found'], _runs(DIGEST_PAGES),
                          len(dg['waters']), ', '.join(sorted(dg['waters'])) or '-',
                          len(dg['rejected_on_county'])), flush=True)
        # TENNESSEE'S BOOK WAS OUTSIDE THE LEDGER ENTIRELY, and "TN is 100% covered" hid it:
        # true of the ten lakes the card offers, and silent about the other ten pages of the
        # digest. Ryan, seeing the total: "168 pages is this the combined page count from all 4
        # states?" It was three. TN reads its pages through its own reader, so it never passed
        # through read_pdf_state() and never got counted. When it finally ran it reported eight
        # unaccounted pages, seven of which were the reservoir regulations.
        try:
            pdfplumber = _pdfplumber()
            with pdfplumber.open(dg_path) as tnpdf:
                # Page 1 is read too -- by read_tn_statewide(), not by the block reader --
                # so it goes in with the rest or the ledger reports the statewide table as a
                # page carrying law that nothing looked at.
                tn['pages'] = page_ledger(tnpdf, set(DIGEST_PAGES) | {1}, smap,
                                          (not_law.get('TN') or {}))
            led = tn['pages']
            if led:
                print('          pages: %d read, %d carry no fishing law, %d blank, %d '
                      'declared, %d UNACCOUNTED %s'
                      % (len(led['read']), len(led['not_law']), len(led['blank']),
                         len(led['declared']), len(led['unaccounted']),
                         led['unaccounted'] or ''), flush=True)
                for n in led['unaccounted']:
                    doc['problems'].append({'state': 'TN', 'why': 'this page carries fishing '
                                            'law and nothing read it -- read it, or record why '
                                            'not in registry/pages_not_law.json', 'page': n})
        except Exception as exc:
            doc['problems'].append({'state': 'TN', 'why': 'page ledger failed: %s' % exc})
        tn['statewide_table'] = read_tn_statewide(dg_path)
        print('TN statewide: %d rows off page 1 of the digest'
              % len(tn['statewide_table']), flush=True)
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
        prose = read_prose_state(path, st)
        declared = (not_law.get(st) or {})
        prose_pages = {t['page'] for tabs in prose.values() for t in tabs}
        got, missing, sc_lakes, ledger = read_pdf_state(path, specs, smap, declared,
                                                        extra_read=prose_pages)
        got.update(prose)
        specs = list(specs) + [(k, [], p, o) for k, p, _r, o in (PROSE.get(st) or [])]
        blk = {'source_file': fname, 'tables': got, 'pages': ledger}
        if ledger:
            print('%-9s pages: %d read, %d carry no fishing law, %d blank, %d declared, '
                  '%d UNACCOUNTED %s'
                  % ('', len(ledger['read']), len(ledger['not_law']), len(ledger['blank']),
                     len(ledger['declared']), len(ledger['unaccounted']),
                     ledger['unaccounted'] or ''), flush=True)
            for n in ledger['unaccounted']:
                doc['problems'].append({'state': st, 'why': 'this page carries fishing law and '
                                        'nothing read it -- read it, or record why not in '
                                        'registry/pages_not_law.json', 'page': n})
        if sc_lakes:
            blk['state_lakes'] = sc_lakes
        doc['states'][st] = blk
        for m in missing:
            doc['problems'].append(dict(m, state=st))
        res = resolve_state_tables(blk, st, name_map, idx, systems, chain, specs, smap)
        blk['resolution'] = res
        for f in res['system_assertion_failures']:
            doc['problems'].append(dict(f, state=st))
        counts = ', '.join('%s %d tables/%d rows' % (k, len(v), sum(len(x['rows']) for x in v))
                           for k, v in got.items())
        print('%s:       %s%s' % (st, counts or '(no tables found)',
              ('; state lakes %d rows, closed: %s' % (sc_lakes['rows'], sc_lakes['closed_waters'])
               if sc_lakes else '')), flush=True)
        for m in missing:
            print('   !! missing %s' % m, flush=True)
        print('   resolved: %s' % (res['stats'] or 'nothing'), flush=True)
        for f in res['system_assertion_failures']:
            print('   !! SYSTEM ASSERTION FAILED %s' % f, flush=True)

    by_water, statewide = project_by_water(doc, idx, SPECS, smap)
    doc['by_water'] = by_water
    doc['statewide'] = statewide
    print('\nby water: %d of %d offered waters carry at least one rule; statewide defaults for '
          '%s' % (len(by_water), len(idx), ', '.join(sorted(statewide)) or '-'), flush=True)

    sm = check_species_map(doc, R(a.registry))
    doc['species_map_check'] = sm
    if sm.get('checked'):
        print('species:  %d phrases in the books, %d unmapped; %d closure(s) cannot fire because '
              'the plan form has no checkbox for the fish'
              % (sm['phrases_in_the_books'], len(sm['unmapped']),
                 len(sm['closures_that_cannot_fire'])), flush=True)
        if sm['unmapped']:
            for u in sm['unmapped']:
                print('   !! UNMAPPED SPECIES PHRASE: %r' % u, flush=True)
            doc['problems'].append({'why': 'species phrases with no entry in species_map.json',
                                    'phrases': sm['unmapped']})
    else:
        print('!! species map not checked: %s' % sm.get('why'), flush=True)

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


def _runs_of_a_kind(words, kind):
    """Consecutive words of one kind, in reading order, as (kind, words) runs."""
    out = []
    for w in words:
        k = kind(w)
        if out and out[-1][0] == k:
            out[-1][1].append(w)
        else:
            out.append((k, [w]))
    return out


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
        if sz >= body_size + 4:
            # SECTION TITLE, NOT A WATER. The threshold was body + 7, tuned on the 18pt
            # `Exceptions on State Park Lakes`, and the reservoir pages carry 15pt sidebar
            # titles -- `Commercial Fishing in Tennessee` -- which fell through to the Bold
            # test and were read as reservoirs. Nothing on this book is set between 10.5 and
            # 15, so the line goes in the gap rather than on either edge of it.
            return 'section'
        if 'Bold' in fn:
            return 'heading'
        if 'Medium' in fn:
            return 'qualifier'
        return 'body'

    # ONE COLUMN FINDER FOR THE WHOLE FILE. This used to have its own, _left_edges(), which
    # kept a bucket of word-x0s only if it held more than 4% of the page's words -- a threshold
    # that rises with the text on the page, so the denser a page got the fewer columns it
    # found. On the 2026-2027 book it returned ONE column for pages 6 and 8, a single column
    # starting at x=378 for page 13 (discarding two-thirds of the page), and two of three for
    # page 3, where it cut the heading `Tims Ford` down the middle and lost Percy Priest
    # entirely. Pages 11-17 have been read through it since the TN reader was written.
    #
    # column_starts() reads the bullets instead, and a bullet only ever sits at a column's left
    # edge. It returns [36, 207, 378] on every rules page of this book, and nothing on the
    # pages that carry no bullets -- which are the pages that carry no rules.
    edges = [float(x) for x in column_starts([page])] or [0.0]
    cols = defaultdict(list)
    for w in words:
        cands = [e for e in edges if e <= w['x0'] + 1.0]
        cols[max(cands) if cands else edges[0]].append(w)
    out = []
    for edge in sorted(cols):
        # CLUSTERED, NOT BUCKETED. `round(top / ytol)` puts two words on the same printed line
        # in different rows whenever that line happens to straddle a bucket edge, which is
        # exactly what happened to `Guntersville` at top=423.4 and its `(Tennessee Section
        # Only)` at 424.4 -- one point apart, two buckets, and the reservoir lost its name to
        # its own qualifier. Grouping by distance from the row already open has no edges.
        rows = []
        for w in sorted(cols[edge], key=lambda x: x['top']):
            if rows and w['top'] - rows[-1][0] <= ytol:
                rows[-1][1].append(w)
            else:
                rows.append((w['top'], [w]))
        lines = []
        for _top, row in rows:
            ws = sorted(row, key=lambda x: x['x0'])
            # A CHANGE OF KIND MID-LINE IS A BOUNDARY, because on this book the typography IS
            # the structure. Taking the majority kind for the whole line glued whatever shared
            # a baseline with a heading onto the heading: `28 | South Holston (TN + VA Rules)`
            # kept the folio, and Melton Hill and Watauga each came out with a sentence of the
            # facing advertisement inside the water's name. Splitting the run is safe both ways
            # -- _blocks() rejoins a `qualifier` onto the heading above it, so `South Holston`
            # and `(TN + VA Rules)` still arrive as one water.
            for kd, seg in _runs_of_a_kind(ws, kind):
                txt = norm(' '.join(w['text'] for w in seg))
                if not txt:
                    continue
                lines.append({'text': txt, 'kind': kd,
                              'top': min(w['top'] for w in seg)})
        out.append(lines)
    return out


# `(Greene County):`, `(TN + VA Rules)`, `(Rockford Dam upstream to ... boundary):`
QUALIFIER = re.compile(r'^\(|:\s*$')

SUB = re.compile(r'^\s*[»›-]\s+')

# TWRA prints this on every page. Left in the stream it appends itself to whichever rule was
# open when the page turned.
RUNNING = re.compile(r'^\s*\d*\s*\|?\s*(Reservoir REGULATIONS|Trout REGULATIONS|'
                     r'Exceptions TO STATEWIDE REGULATIONS|TWRA Fishing Lakes INFORMATION|'
                     r'\d{4}[–-]\d{4}\s+T\s?E\s?N\s?N)', re.I)

# The folio on its own. Splitting a line where its typography changes leaves the page number
# standing by itself in whichever column the running head crossed, and a bare `23` set in the
# heading face reads as a water called 23.
FOLIO = re.compile(r'^\s*\|?\s*\d{1,3}\s*\|?\s*$')


def _join_wrapped(a, b):
    """Join a line to the one it continues, healing a word the typesetter broke.

    TWRA's columns are narrow and it hyphenates freely: `combina- tion`, `mini- mum`,
    `restric- tions`. Joined with a space those reach the record as two words that are neither,
    and every consumer downstream -- species matching, the plan card, anything grepping a creel
    limit -- sees a word that does not exist. A trailing hyphen before a lower-case
    continuation is a broken word; a trailing hyphen before anything else is a real one, as in
    `catch-` at the end of a phrase, so the test looks at what follows.
    """
    a, b = (a or '').rstrip(), (b or '').lstrip()
    if a.endswith('-') and b[:1].islower():
        return a[:-1] + b
    return (a + ' ' + b).strip()


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
        if k == 'qualifier' and QUALIFIER.match(t):
            cur['heading'] = (cur['heading'] + ' ' + t).strip()
            continue
        if k == 'qualifier':
            # SET LIKE A QUALIFIER IS NOT THE SAME AS BEING ONE. The facing advertisements on
            # the reservoir pages are set in the same 10.5pt Medium as `(Greene County):`, so
            # joining every one of them to the heading above gave Melton Hill and Watauga a
            # sentence of ad copy inside the water's name. A real qualifier is bracketed or
            # ends in a colon; anything else set that way is somebody else's paragraph.
            continue
        if BULLET.match(t):
            cur['rules'].append(BULLET.sub('', t))
        elif SUB.match(t) and cur['rules']:
            cur['rules'][-1] = _join_wrapped(cur['rules'][-1], SUB.sub('', t))
        elif cur['rules']:
            cur['rules'][-1] = _join_wrapped(cur['rules'][-1], t)
        else:
            cur['preamble'].append(t)
    if cur:
        out.append(cur)
    # A HEADING WITH NO LETTERS IN IT IS NOT A NAME. Splitting a line where its typography
    # changes leaves a stray `:` standing alone wherever the colon after a name was set in the
    # body face; four of them arrived as waters called `:`.
    return [b for b in out if re.search(r'[A-Za-z]', b['heading'] or '') and b['rules']]


COUNTY = re.compile(r'\(([^)]*?)\s*(?:County|Co\.)\s*\)', re.I)


# THE RESERVOIR PAGES ARE READ HERE NOW, and until 2026-08-28 they were not.
#
# The reasoning for leaving them out is still on this page and it was not silly: TWRA publishes
# a per-reservoir HTML page for each of these waters, where the page is unambiguously one water
# and the rules are a plain <ul>, so the digest was read only for what the HTML does not cover.
# What that missed is that the HTML is TWRA's summary and the digest is the law, and nothing
# ever compared them. It also left pages 2-8 -- Regions 1 through 4, every TVA reservoir in the
# state -- outside the page ledger, which is how they went seven editions without being read.
#
# They head each water with a bare word, `Cherokee`, `Boone`, `Norris`, and the rule that a
# heading without a county cannot identify a water refused all thirty-two of them. That rule is
# now two tests instead of one: the name must be used once in the book AND match exactly one
# lake in the state. Both Davy Crockett Lakes still refuse, on the county they each print.
DIGEST_PAGES = list(range(2, 9)) + list(range(11, 18))


def _runs(pages):
    """`[2..8, 11..17]` as `2-8, 11-17` -- the page list the run prints for itself."""
    out, ps = [], sorted(set(pages))
    for n in ps:
        if out and n == out[-1][1] + 1:
            out[-1][1] = n
        else:
            out.append([n, n])
    return ', '.join('%d' % a if a == b else '%d-%d' % (a, b) for a, b in out)


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
    from collections import Counter
    pdfplumber = _pdfplumber()
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
                    if RUNNING.match(ln['text']) or FOLIO.match(ln['text']):
                        continue
                    ln['page'] = pi
                    stream.append(ln)
    for b in _blocks(stream):
        blocks.append(b)
    # HOW OFTEN THE BOOK USES EACH NAME, counted before anything is bound. This is what makes a
    # heading without a county safe to read: `Cherokee` appears once in the whole digest and
    # `Davy Crockett Lake` appears twice. Counted from the book rather than assumed, so a
    # future edition that adds a second Cherokee starts refusing instead of guessing.
    used = Counter(norm(re.sub(r'\s*\(.*', '', b['heading'].rstrip(':').strip())).lower()
                   for b in blocks)
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
        elif not county:
            # A NAME WITHOUT A COUNTY IS NOT AN IDENTIFICATION -- UNLESS NOTHING ELSE ANSWERS
            # TO IT. Tennessee has two Davy Crockett Lakes, 87 acres in Crockett County and the
            # one we ship in Greene County on the Nolichucky, and their rules differ. But the
            # reservoir pages head every water with a bare word -- `Cherokee`, `Boone`,
            # `Norris` -- and refusing all of them left seven pages of law for almost every
            # Tennessee water this app offers sitting unread behind a rule written for
            # `Pine Lake:`.
            #
            # So the name has to be alone twice over: once in the book, which `used` counts,
            # and once in the state, which resolve_in_state() checks by requiring exactly one
            # registry lake whose name contains every word of the book's. Either one failing is
            # a refusal with its reason, not a coin toss. Note this deliberately does NOT use
            # resolve(), which is state-blind and answered `Cherokee` with a lake in Texas.
            if used[name.lower()] > 1:
                rec['rejected'] = ('the book heads %d blocks with this name and none of them '
                                   'says which county' % used[name.lower()])
                unmatched.append(rec)
                continue
            slug = resolve_in_state(name, 'TN', idx)
        if slug:
            matched.setdefault(slug, []).append(rec)
        else:
            unmatched.append(rec)
    return {'blocks_found': len(blocks), 'waters': matched,
            'unmatched_blocks': len(unmatched),
            'rejected_on_county': [u for u in unmatched if u.get('rejected')]}




# ─────────────────────────────────────────────────────────────────────────────────────────────
# RESOLUTION -- what water does a book row actually address?
# ─────────────────────────────────────────────────────────────────────────────────────────────
#
# The books address rules four different ways and only one of them is a lake name:
#
#   a name          `Lake Murray`, `Lake Russell`, `Lake Hartwell & Lake Thurmond`
#   a semicolon list `Ashepoo River; Ashley River; Back River in Jasper County; ... ` -- 22 waters
#                    sharing one closure
#   a SYSTEM        `Santee River system (see map, page 31)` -- the address of the striper
#                    closure that governs Lake Marion and Lake Moultrie, neither of which is
#                    named anywhere in that row. Resolved by walking water_chain.json upstream
#                    from the system's root, stopping at the dams the book itself names.
#   a default       `Statewide except the water bodies list below:`
#
# Reading the book correctly and then not knowing which of our waters it speaks to leaves 166
# rows of law addressed to nobody, which is where this stood before today.

SYSTEM_RE = re.compile(r'^(.*?)\s+system\b', re.I)
SEE_MAP = re.compile(r'\s*\(see map[^)]*\)', re.I)
# `Statewide` is only SC's word for it. NC says `All public fishing waters`, `All inland fishing
# waters and joint fishing waters`, `All public waters except those listed below:` -- 18 rows
# that are the default rule and were being looked up as if they named a lake.
# A river address that names where it starts or stops. Not a rejection -- a qualification.
REACH = re.compile(r'\b(down|up)stream of\b|\bseaward of\b|\b(above|below)\s+(the\s+)?'
                   r'[A-Z]|\bfrom\s+.{0,40}\bto\b', re.I)

STATEWIDE = re.compile(r'^\s*(statewide|all\s+(public|inland)\s+(fishing\s+)?waters'
                       r'|all\s+waters\s+of\s+the\s+state)\b', re.I)

# A DEFAULT THAT COVERS ONE KIND OF WATER, NOT ALL OF THEM.
#
# North Carolina writes its statewide striped bass rule as `Impounded inland waters and their
# tributaries except those listed below:` -- the same shape as `all inland waters except those
# listed below`, but true only of impoundments. NC sets its rivers and sounds separately, by
# management area (Roanoke, Albemarle, Central-Southern).
#
# The matcher did not recognise the phrasing at all, so NC's striped bass and hybrid limits --
# the app's own main species -- reached no water in the state. Widening STATEWIDE to admit it
# would have been worse than leaving it: 17 rivers and 3 coastal waters we offer in NC would
# have been handed an impoundment's limit, which the book gives them nowhere.
#
# So the scope travels with the record and the feature type is what answers it.
SCOPED_STATEWIDE = [
    (re.compile(r'^\s*impounded\s+inland\s+waters\b', re.I), ['lake'],
     'impounded inland waters -- the book sets rivers and sounds separately'),
]

# Table furniture that is not an address at all -- a header cell the ruled grid picked up, a
# species band, or the bullet paragraph above the table.
NOT_AN_ADDRESS = re.compile(r'^(water body|fish|species|size limit|possession limit|'
                            r'daily limit|creel|county|open days|game fish|•)', re.I)

# `Lakes Hartwell, Keowee, Russell (including the Lake Hartwell tailwater), Thurmond and
# Tugaloo` is one cell naming five waters. `the Chattooga and Savannah Rivers` is two. Neither
# uses a semicolon, which is what the first splitter looked for.
PLURAL_LEAD = re.compile(r'^\s*(?:the\s+)?(Lakes|Rivers|Reservoirs)\s+', re.I)
TRAIL_PLURAL = re.compile(r'\s+(Rivers|Lakes|Creeks|Reservoirs)\s*$', re.I)
LEAD_JUNK = re.compile(r'^\s*(and|includes|including)\s+', re.I)
TRIB_TAIL = re.compile(r'\s+and\s+(its\s+)?tributaries\b.*$', re.I)
# `Saluda River (Middle Reach) All waters of Saluda River from backwaters of Lake Murray at SC
# Hwy 395 upstream to Lake Greenwood Dam` -- the cell is the name AND the reach description. The
# name is what can be looked up; the description is provenance.
DESC_TAIL = re.compile(r'\s+All waters of\b.*$', re.I)
# The plural lead stops carrying once the list turns into a described reach:
# `Lakes Blalock, Greenwood, ... and the middle reach of the Saluda River` -- `the middle reach`
# is not a lake, and prefixing it produced the water `Lake the middle reach of the Saluda River`.
NOT_A_BARE_NAME = re.compile(r'^(the|upper|lower|middle)\b', re.I)
# A described reach rather than a name: the words a book uses to bound one.
QUALIFIER_PHRASE = re.compile(r'\b(of|above|below|up|down|upstream|downstream|from|to|'
                              r'including|except|between|within|portion|waters)\b', re.I)


def _atoms(part):
    """One address fragment -> the individual water names inside it.

    Applied to EVERY semicolon part, not just to a cell with no semicolons. The first version
    split on `;` and stopped, so `Great Pee Dee and Little Pee Dee Rivers` -- one part of a
    22-water list -- stayed a single lump and matched nothing.
    """
    t = DESC_TAIL.sub('', TRIB_TAIL.sub('', LEAD_JUNK.sub('', norm(part)))).strip(' .,;')
    if not t:
        return []
    # `In the following waters and their tributaries: • B. Everett Jordan Reservoir • Cape Fear
    # River • ...` -- NC puts a bulleted list inside one cell.
    if '•' in t:
        out = []
        for b in t.split('•')[1:]:
            out.extend(_atoms(b))
        return out
    if ' & ' in t:
        out = []
        for b in t.split(' & '):
            out.extend(_atoms(b))
        return out
    m = PLURAL_LEAD.match(t)
    if m:
        noun = {'lakes': 'Lake', 'rivers': 'River', 'reservoirs': 'Reservoir'}[m.group(1).lower()]
        bits = [b.strip() for b in re.split(r',|\s+and\s+', t[m.end():]) if b.strip()]
        out = []
        for b in bits:
            b = re.sub(r'\s*\(.*?\)', '', b).strip()
            if not b or NOT_A_BARE_NAME.match(b):
                continue
            out.append('%s %s' % (noun, b) if noun == 'Lake' else '%s %s' % (b, noun))
        return out
    m2 = TRAIL_PLURAL.search(t)
    if m2 and re.search(r'\s+and\s+|,', t[:m2.start()]):
        noun = m2.group(1)[:-1]
        bits = [re.sub(r'^the\s+', '', b.strip(), flags=re.I)
                for b in re.split(r',|\s+and\s+', t[:m2.start()]) if b.strip()]
        return ['%s %s' % (b, noun) for b in bits if b]
    if re.search(r'\s+and\s+(?=(Lake|Little|Big)\b)', t):
        return [b.strip() for b in re.split(r'\s+and\s+(?=(?:Lake|Little|Big)\b)', t) if b.strip()]
    return [t]


def load_systems(registry):
    p = os.path.join(registry, 'reg_systems.json')
    return json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {'systems': {}}


def system_members(chain, defn):
    """Waters inside a book system: walk upstream from the root, stop at the named dams."""
    stops = set((defn.get('stop_at') or {}).keys())
    seen, out, q = set(), [], [defn['root']]
    while q:
        s = q.pop()
        if s in seen or s in stops:
            continue
        seen.add(s)
        if s in chain:
            out.append(s)
        for u in (chain.get(s) or {}).get('upstream') or []:
            q.append(u)
    return sorted(out)


def check_system(members, defn):
    """The boundary assertions. A walk that quietly stops meaning what the book means is worse
    than no walk, so the definition carries the waters that must and must not be in it."""
    bad = []
    for s in defn.get('must_include') or []:
        if s not in members:
            bad.append('missing ' + s)
    for s in defn.get('must_exclude') or []:
        if s in members:
            bad.append('wrongly included ' + s)
    return bad


COUNTY_NAME_STOP = frozenset(('lake', 'lakes', 'reservoir', 'pond', 'the', 'of'))


# The books abbreviate what the registry spells out. TWRA heads a reservoir `Ft. Loudoun` and
# the registry calls it `Fort Loudoun Lake`, so the word-subset test failed on `ft` vs `fort`
# and a water we ship read as one we do not offer. Expanded on the way in, in the one place
# both sides of every comparison pass through, rather than aliased per reader.
ABBREV = {'ft': 'fort', 'mt': 'mount', 'st': 'saint', 'jr': 'junior', 'n': 'north',
          's': 'south', 'e': 'east', 'w': 'west', 'no': 'north', 'so': 'south'}


def _bare_words(s):
    s = re.sub(r'\s*\([^)]*\)\s*$', '', s or '').lower().replace(u'\u2019', "'")
    return set(ABBREV.get(w, w) for w in re.findall(r"[a-z0-9]+", s)
               if w not in COUNTY_NAME_STOP)


def resolve_by_county(name, county, state, idx):
    """A book name word-for-word inside the registry's, settled by the county the row prints.

    THE BOOK AND THE REGISTRY DO NOT HAVE TO AGREE ON A NAME TO BE TALKING ABOUT THE SAME
    WATER. SCDNR's state lakes table says `Lake Paul Wallace`; the registry says `Lake
    Wallace`, Marlboro County. resolve() is exact by design and found nothing, the join
    dropped the row without a word, and the 2026-2027 book's `Currently closed pending
    repairs` -- the dam went out after the 2025-2026 book was printed -- never reached the
    water. The card showed it open.

    This is not a fuzzy match. Every word of one name is in the other, the water is in the
    book's state, the county the book prints in its own column equals the county the registry
    holds, and EXACTLY ONE water survives all three. Anything else returns None and is
    reported.
    """
    if not (name and county and state):
        return None
    pw = _bare_words(name)
    if not pw:
        return None
    want = norm(county).strip().lower()
    keep = []
    for slug, row in idx.items():
        if row.get('feature_type') != 'lake' or state not in (row.get('state') or ''):
            continue
        if norm(str(row.get('county') or '')).strip().lower() != want:
            continue
        rw = _bare_words(row.get('name'))
        if rw and (pw <= rw or rw <= pw):
            keep.append(slug)
    return keep[0] if len(keep) == 1 else None


TWO_STATE = re.compile(r'\b(AL|GA|NC|SC|TN|VA)\s*/\s*(AL|GA|NC|SC|TN|VA)\b')


def _spans_two_states(row):
    """Does the registry itself say this water is in two states?"""
    return bool(TWO_STATE.search('%s %s' % (row.get('display_name') or '', row.get('state') or '')))


# Words that may sit capitalised in front of a water's name without making it a different
# water: sentence openers and function words. Anything else in front of `Satilla River` --
# `Little`, `South`, `Big`, `North` -- names another river, and GA's demarcation list uses five
# of them. Function words are a closed class of English; unlike a list of modifiers it cannot
# fall behind the books, and the failure it allows is dropping a bind rather than inventing one.
NAME_LEADERS = {'the', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'of', 'to', 'from', 'for',
                'all', 'both', 'its', 'their', 'this', 'these', 'those', 'any', 'each',
                'above', 'below', 'near', 'upon', 'into', 'onto', 'with', 'by', 'is', 'are',
                'was', 'were', 'be', 'that', 'which', 'including', 'includes', 'included',
                'except', 'between', 'along', 'across', 'up', 'down', 'via'}


def _part_of_a_longer_name(text, at):
    """Is the name at this position the tail of a longer proper name?

    `Little Satilla River` contains `Satilla River` on clean word boundaries, and the two are
    different rivers -- the book puts the Little Satilla in the clause that is salt water end
    to end and the Satilla in the clause that is salt only below U.S. 17. Matching the tail
    said the Satilla we offer is saltwater for its whole length, which is not what the page
    says about it anywhere.
    """
    before = text[:at]
    m = re.search(r"([A-Za-z][A-Za-z'\-]*)\s+$", before)
    if not m:
        return False                        # start of the string, or punctuation in between
    w = m.group(1)
    return w[:1].isupper() and w.lower() not in NAME_LEADERS


def waters_named_in(text, state, idx):
    """Registry waters whose FULL NAME appears as a phrase inside a sentence.

    NOT SUBSTRING MATCHING, which this project has ruled out and was right to. The unit here is
    the registry's whole name -- `Lake Marion`, `Lake Moultrie` -- matched on word boundaries,
    scoped to the book's own state, and only for names of two words or more. A single
    distinctive token like `Marion` is never matched on its own, which is the failure that rule
    exists to stop.

    It exists because SCDNR writes its area closures as sentences with the water inside them:
    `All watercraft and fishing are prohibited Nov. 1 through Feb. 28 on Cantey Bay, Black
    Bottom and Savannah Branch in Lake Marion`. There is no address column to read; the address
    is in the prose, and the alternative is throwing a real closure away.
    """
    t = norm(text)
    if not t or not state:
        return []
    hits = []
    for slug, row in idx.items():
        if state not in (row.get('state') or ''):
            continue
        name = re.sub(r'\s*\([^)]*\)\s*$', '', str(row.get('name') or '')).strip()
        if len(name.split()) < 2:
            continue
        for m in re.finditer(r'\b%s\b' % re.escape(name), t, re.I):
            if _part_of_a_longer_name(t, m.start()):
                continue
            hits.append((len(name), slug))
            break
    # Longest name first, so `Richard B Russell Lake` is preferred over a shorter one inside it.
    hits.sort(reverse=True)
    out, seen = [], set()
    for _n, slug in hits:
        if slug not in seen:
            seen.add(slug)
            out.append(slug)
    return out


def resolve_in_state(name, state, idx):
    """One water in the book's own state whose name contains every word of the book's.

    `Lake Lanier` is inside `Lake Sidney Lanier` and there is exactly one of those in Georgia.
    Exact-set membership, not fuzzy scoring, and it must be ALONE -- two candidates is an
    ambiguity to report, not a coin to toss.
    """
    pw = _bare_words(name)
    if not pw or not state:
        return None
    keep = [slug for slug, row in idx.items()
            if row.get('feature_type') == 'lake' and state in (row.get('state') or '')
            and _bare_words(row.get('name')) and pw <= _bare_words(row.get('name'))]
    return keep[0] if len(keep) == 1 else None


def resolve_water_body(text, state, name_map, idx, systems, chain, sysmembers,
                       county=None):
    """One book address -> {kind, waters, unresolved}. Never a guess: anything that does not
    resolve is named in `unresolved` so it can be seen rather than silently dropped."""
    t = norm(text)
    if not t:
        return None
    if NOT_AN_ADDRESS.match(t):
        return {'kind': 'not_an_address', 'text': t, 'waters': [],
                'note': 'table furniture, not a water body'}
    if STATEWIDE.match(t):
        return {'kind': 'statewide', 'text': t, 'waters': [],
                'note': 'applies to every water in the state except those the book lists'}
    for rx, kinds, why in SCOPED_STATEWIDE:
        if rx.match(t):
            return {'kind': 'statewide', 'text': t, 'waters': [],
                    'applies_to_feature_types': list(kinds),
                    'note': 'applies to every %s in the state except those the book lists -- %s'
                            % (' or '.join(kinds), why)}
    parts = []
    for chunk in re.split(r';', t):
        parts.extend(_atoms(chunk))
    # A PLAIN COMMA LIST OF NAMES, split only when every piece is a water we know.
    #
    # `Hyco Lake, Moss Lake, Oak Hollow Lake, Lake Townsend, Farmer Lake and Salem Lake` is one
    # cell naming six lakes, four of which we offer, and _atoms() leaves it whole because each
    # item carries its own noun -- there is no `Lakes X, Y and Z` lead for PLURAL_LEAD to catch
    # and no semicolon. Splitting every address on commas would shatter `Dan River (Caswell
    # Co.), downstream of Danville, VA`, so the split is kept ONLY if each piece resolves on its
    # own. A list that does not fully resolve is left exactly as it was and reported unresolved,
    # which is the answer it had before.
    if len(parts) == 1 and not resolve(parts[0], name_map):
        bits = [b.strip(' .') for b in re.split(r',|\s+and\s+', parts[0]) if b.strip(' .')]
        # A NAME WE DO NOT OFFER IS NOT A REASON TO REFUSE THE ONES WE DO. Requiring every
        # piece to resolve was the first rule here and it kept the list whole, because the
        # book names Farmer Lake and Salem Lake and we carry neither -- so Hyco, Oak Hollow
        # and Townsend went on answering nothing. What must not be split is a described reach,
        # and a reach says so: `Dan River (Caswell Co.), downstream of Danville, VA` has a
        # preposition in it and a list of names does not.
        if len(bits) > 1 and not any(QUALIFIER_PHRASE.search(b) for b in bits) \
                and sum(1 for b in bits if resolve(b, name_map)) >= 2:
            parts = bits

    waters, unresolved, kinds = [], [], set()
    for part in parts:
        p = SEE_MAP.sub('', part).strip(' .,;')
        m = SYSTEM_RE.match(p)
        if m:
            key = '%s:%s_system' % (state, slugify(m.group(1)))
            defn = (systems.get('systems') or {}).get(key)
            if defn:
                waters.extend(sysmembers[key])
                kinds.add('system')
            else:
                unresolved.append({'text': p, 'why': 'system %s is not defined in '
                                   'reg_systems.json' % key})
            continue
        # `Back River in Jasper County` / `Pocotaligo in Beaufort, Jasper, and Hampton Counties`
        p2 = re.sub(r'\s+in\s+[A-Z][A-Za-z, ]*Count(?:y|ies)\b.*$', '', p).strip()
        # THE COUNTY IN THE BOOK IS THERE BECAUSE THE NAME IS NOT ENOUGH.
        # `Lake Robinson (Greenville County)` is one of two Lake Robinsons we carry, and
        # dropping the parenthetical is exactly how the OTHER Lake Robinson's full pool of
        # 900 ft ended up on this one. If the book names a county, the registry row must agree.
        cm = COUNTY.search(p)
        # The address carries its own county in NC and GA. SC's state lakes table puts it in a
        # column instead, so the caller hands it in -- same fact, different place on the page.
        want_county = norm(cm.group(1)) if cm else (norm(county) if county else None)
        slug = resolve(p2, name_map)
        if slug and want_county:
            got = norm((idx.get(slug) or {}).get('county') or '')
            if got and got.lower() != want_county.lower():
                # The prefix has to be the BARE name. Built from the string with the
                # parenthetical still on it, `lake_robinson_greenville_county` prefixes
                # nothing and the right water -- lake_robinson_greer -- was rejected along
                # with the wrong one.
                stem = slugify(re.sub(r'\s*\(.*?\)', '', p2))
                alt = None
                for cand, cslug in name_map.items():
                    if (cand == stem or cand.startswith(stem + '_')) and \
                            norm((idx.get(cslug) or {}).get('county') or '').lower() \
                            == want_county.lower():
                        alt = cslug
                        break
                if alt:
                    slug = alt
                elif (idx.get(slug) or {}).get('state') != state:
                    # A BORDER WATER HAS TWO COUNTIES AND TWO BOOKS. North Carolina's book
                    # addresses `Lake Chatuge (Clay Co.)`; the registry places it in Towns Co,
                    # Georgia, because that is where its centroid falls. Both are correct --
                    # the lake straddles the line -- and NC's rules govern the NC portion.
                    # Rejecting on county here would drop a real rule on a real water.
                    kinds.add('across_state_line')
                else:
                    unresolved.append({'text': p, 'why': 'county mismatch: book says %s, '
                                       '%s is in %s' % (want_county, slug, got)})
                    continue
        if not slug and want_county:
            slug = resolve_by_county(p2, want_county, state, idx)
            if slug:
                waters.append(slug)
                kinds.add('name+county')
                continue
        # A BOOK MAY NOT NAME A WATER IN ANOTHER STATE. Georgia's length limits say `Lake
        # Lanier: 14 inches`; the registry's `Lake Lanier` is an 84.8-acre pond in Greenville
        # County, South Carolina, and Georgia's is `Lake Sidney Lanier`. An exact match with no
        # county to check it against put a Georgia bass limit on a South Carolina pond -- the
        # same failure the agency reader had this morning, in a second reader.
        #
        # A genuine border water is kept: the index marks it as spanning a line, and NC's book
        # addressing Lake Chatuge in Clay County is a real rule on a real water.
        # LAKES ONLY. A river genuinely flows through more than one state and the registry files
        # it by its centroid -- the Savannah is `Aiken Co, GA` and South Carolina's book governs
        # it, the Lumber is `Robeson Co, NC` and South Carolina's book governs its own reach.
        # Gating those dropped four real rules. A LAKE sits in one place, so a lake in the wrong
        # state is the Lanier mistake and nothing else.
        row_ = idx.get(slug) or {}
        if slug and row_.get('feature_type') == 'lake' \
                and state not in (row_.get('state') or '') \
                and not _spans_two_states(row_):
            alt = resolve_in_state(p2, state, idx)
            if alt:
                waters.append(alt)
                kinds.add('name+state')
                continue
            unresolved.append({'text': p, 'why': 'the only lake of that name is in %s and this '
                               'is the %s book' % (row_.get('state'), state)})
            continue
        if not slug and not want_county:
            # NOTHING MATCHED EXACTLY AND THE BOOK NAMES NO COUNTY, so try the same rule the
            # wrong-state branch uses: one
            # lake in this book's state whose name contains every word of the book's. Georgia
            # heads its Public Fishing Area entries `HUGH M. GILLIS` and `DODGE COUNTY` while
            # the registry names them `Hugh M. Gillis PFA` and `Dodge County PFA Lake`. It must
            # be ALONE in the state -- two candidates is an ambiguity to report, not a guess.
            #
            # AND ONLY WHERE NO COUNTY IS STATED. `OCMULGEE` is unique-in-Georgia against `Little
            # Ocmulgee Lake`, and they are different waters: the PFA is in Bleckley and Pulaski,
            # Little Ocmulgee is in Telfair. The book prints the county on the line under the
            # heading, so it is read rather than guessed past.
            alt = resolve_in_state(p2, state, idx)
            if alt:
                waters.append(alt)
                kinds.add('name+state')
                continue
        if slug:
            waters.append(slug)
            kinds.add('name')
        else:
            unresolved.append({'text': p, 'why': 'no registry water of that name'})
    seen, ordered = set(), []
    for w in waters:
        if w not in seen:
            seen.add(w)
            ordered.append(w)
    return {'kind': '+'.join(sorted(kinds)) or 'unresolved', 'text': t,
            'waters': ordered, 'unresolved': unresolved}


def opts_for(specs, key):
    for k, _h, _p, o in specs:
        if k == key:
            return o or {}
    return {}


def smap_phrases(smap):
    """Every phrase registry/species_map.json knows, in one set."""
    out = set(smap.get('book_phrases') or {})
    for blk in ('partly_mapped', 'no_home_in_the_form'):
        out |= {k for k in (smap.get(blk) or {}) if not k.startswith('_')}
    return out


def resolve_state_tables(block, state, name_map, idx, systems, chain, specs=(),
                         smap=None):
    """Attach resolved waters to every row of every table already read for a state."""
    sysmembers, sysproblems = {}, []
    for key, defn in (systems.get('systems') or {}).items():
        if not key.startswith(state + ':'):
            continue
        mem = system_members(chain, defn)
        bad = check_system(mem, defn)
        sysmembers[key] = mem
        if bad:
            sysproblems.append({'system': key, 'assertions_failed': bad})
    stats = Counter()
    for key, tables in (block.get('tables') or {}).items():
        o = opts_for(specs, key)
        wcol = o.get('water_col', 0)
        for tb in tables:
            band = None
            last = None
            for row in tb['rows']:
                cells = row['cells']
                first = cells[0] if cells else ''
                if o.get('species_bands') and first and BAND.match(first) \
                        and not any(c for c in cells[1:]):
                    # `WHITE BASS` heads the band; the addresses live in the rows beneath it.
                    #
                    # ORDER MATTERS AND KEEPS THE UNMAPPED CHECK HONEST. A phrase the species
                    # map already knows is a species, whatever words are in it. Only a phrase
                    # the map does NOT know is tested for water nouns, so a genuinely new
                    # species band still reaches check_species_map() and fails loudly there
                    # instead of being quietly demoted to a sub-heading.
                    known = smap_phrases(smap)
                    if first not in known and ADDRESS_BAND.search(first):
                        row['address_band'] = first
                        row['is_band_heading'] = True
                        if band:
                            row['species_band'] = band
                        stats['address_band'] += 1
                        continue
                    band = first
                    row['species_band'] = first
                    row['is_band_heading'] = True
                    stats['species_band'] += 1
                    continue
                if band:
                    row['species_band'] = band
                if wcol is None:
                    row['resolved'] = {'kind': 'implicit', 'text': o.get('implicitly', 'statewide'),
                                       'waters': [], 'note': 'this table carries no water '
                                       'address; the rule applies by construction'}
                    stats['implicit'] += 1
                    continue
                if row.get('continuation'):
                    # A CONTINUATION ROW INHERITS THE ADDRESS ABOVE IT, and this is the row
                    # that matters. `June 16 - Sept. 30 closed` is its own row under the Santee
                    # River system with no water body of its own. Skipping it left the closure
                    # attached to nothing -- the whole card showed ONE hard closure, and it was
                    # a state park lake, while Marion and Moultrie showed none.
                    if last is not None:
                        row['resolved'] = dict(last, inherited_from_row_above=True)
                    continue
                addr = cells[wcol] if len(cells) > wcol else ''
                ccol = o.get('county_col')
                cty = cells[ccol] if (ccol is not None and len(cells) > ccol) else None
                r = resolve_water_body(addr, state, name_map, idx, systems, chain, sysmembers,
                                       county=cty)
                # THE ADDRESS IS THE SENTENCE on SC's seasons bullets, so the water is found by
                # its whole name inside the prose rather than by an address column. Applied here
                # so the run's own stats say `name+in a sentence` rather than `unresolved` for a
                # row that did in fact resolve.
                #
                # THE ROW'S OWN FLAG COUNTS, not only the table's. read_ga_prose already marks
                # the bullets whose address is a sentence -- a length-limit bullet with no colon
                # in it -- and only those. The table-level option would turn the treatment on
                # for every GA length-limit row including `Lake Blackshear: 14 inches`, which
                # has a perfectly good address column. Believing the row is both narrower and
                # already computed; GA needed no new declaration at all.
                if r and (o.get('name_in_sentence') or row.get('named_in_a_sentence')) \
                        and not (r.get('waters') or []):
                    named = waters_named_in(addr, state, idx)
                    if named:
                        r = dict(r, waters=named, kind='name+in a sentence', unresolved=[])
                        # A REACH IS NOT THE WHOLE RIVER. GA's 22-inch striped bass rule binds
                        # `Ocmulgee River downstream of the GA Hwy 96 bridge`, and the registry
                        # water it matches is the whole Ocmulgee. The bind is still worth
                        # having -- the alternative is the rule reaching nothing -- but a
                        # consumer must not read it as covering every mile. The sentence is
                        # carried whole in `text`; this says out loud that it qualifies itself.
                        if REACH.search(addr):
                            r['address_is_a_reach'] = True
                if r:
                    row['resolved'] = r
                    if r.get('waters') or r['kind'] in ('statewide', 'implicit'):
                        last = r
                    stats[r['kind']] += 1
                    stats['waters'] += len(r['waters'])
                    stats['unresolved_parts'] += len(r.get('unresolved') or [])
    return {'system_members': {k: len(v) for k, v in sysmembers.items()},
            'system_assertion_failures': sysproblems, 'stats': dict(stats)}




# ─────────────────────────────────────────────────────────────────────────────────────────────
# THE PROJECTION -- what a consumer actually asks for
# ─────────────────────────────────────────────────────────────────────────────────────────────
#
# The table above is shaped like the BOOKS: by state, by table, by row, addressed the way the
# book addresses things. A consumer never asks that. It asks "what applies on this water", and
# it asks at plan time with a slug in its hand.
#
# So the published object is keyed by slug, with each state's default carried separately --
# because "the digest was read and it says nothing lake-specific here" and "nobody has read the
# digest" are different sentences and only one of them is a gap. That distinction is the same
# one livePolicyFor() already draws between `scope: none` and null, and it is the reason a
# statewide default has to ship alongside the exceptions rather than instead of them.

def load_species_map(registry):
    p = os.path.join(registry, 'species_map.json')
    return json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {}


def expand_species(phrase, smap):
    """A book phrase -> the plan form's species, plus what the book covers and the form cannot.

    RESOLVED HERE, ONCE, NOT AT RUNTIME IN TWO PLACES. The Worker and the browser both need this
    answer and neither should be doing the judgement -- it lives in registry/species_map.json and
    is baked into the record, so a closure arrives already knowing which checkboxes it governs.
    """
    if not phrase:
        return {'plan_species': [], 'basis': 'no species named'}
    bp = (smap.get('book_phrases') or {})
    if phrase in bp:
        return {'plan_species': list(bp[phrase]), 'basis': 'exact'}
    pm = (smap.get('partly_mapped') or {})
    if phrase in pm and isinstance(pm[phrase], dict):
        return {'plan_species': list(pm[phrase].get('plan') or []),
                'also_covers': list(pm[phrase].get('also_covers') or []),
                'basis': 'partial -- the book is wider than the form'}
    nh = (smap.get('no_home_in_the_form') or {})
    if phrase in nh:
        return {'plan_species': [], 'basis': 'no checkbox for this fish',
                'note': nh[phrase]}
    return {'plan_species': [], 'basis': 'UNMAPPED'}


# WHICH COLUMN IS THE SIZE AND WHICH IS THE CREEL, read off the header the table prints.
#
# Declaring them per spec was the obvious alternative and it is worse: SC's book is 124 pages
# nobody in this session could open, and a column index typed for a table you have not seen is
# a guess wearing a fact's clothes. The header says it in the book's own words, it survives the
# column rules splitting it -- `DAILY CR` + `EEL LIMIT` still starts in the cell the value is
# in -- and a book that renames its columns next year fails loudly instead of quietly reading
# the wrong one.
SIZE_COL = re.compile(r'size lim|minimum size|length lim|\bsize\b', re.I)
CREEL_COL = re.compile(r'creel|daily cr|daily limit|possession limit|bag limit', re.I)


def limit_columns(header):
    """(size, creel) column indexes for a table, or None where the book prints no such column.

    GA's statewide table has a DAILY LIMIT and no size column at all -- its length limits are on
    the prose page, which is what Ryan said when he sent it: "size limits for georgia are not on
    the chart, they are on the page before that". None here means the book does not print one,
    which is a different answer from a column nobody looked for.
    """
    h = [str(c or '') for c in (header or [])]
    size = next((i for i, c in enumerate(h) if SIZE_COL.search(c)), None)
    creel = next((i for i, c in enumerate(h) if CREEL_COL.search(c)), None)
    return size, creel


def project_by_water(doc, idx, all_specs=None, smap=None):
    by = {}
    # DECLARED BEFORE THE FIRST WRITER, not beside the loop that writes it most. The TN block
    # below appends to `statewide` and the binding sat forty lines under it, which makes the
    # name local for the whole function and raises UnboundLocalError on the first TN row. It
    # never fired while TN's statewide table was empty, so the commit that added the table
    # shipped a build that could not run.
    statewide = {}

    def add(slug, rec):
        if slug not in idx:
            return
        by.setdefault(slug, {'state': idx[slug].get('state'),
                             'display_name': idx[slug].get('display_name'),
                             'rules': []})['rules'].append(rec)

    # TENNESSEE'S STATEWIDE DEFAULTS, which the other three states have had all along. The
    # page says so itself: "If you are fishing a location that does not have exceptions listed
    # in this guide, then the statewide limits apply."
    for rec in ((doc['states'].get('TN') or {}).get('statewide_table') or []):
        # THROUGH THE SAME SPECIES RESOLUTION AS EVERY OTHER ROW. These records are built by
        # read_tn_statewide() and appended straight here, so they never met the row loop below
        # and never met expand_species() -- all eighteen arrived with a species and no
        # plan_species, which means TWRA's entire statewide table reached the plan form as
        # nothing. The phrases were in species_map.json the whole time; nothing was asking it.
        if rec.get('species') and not rec.get('plan_species'):
            ex = expand_species(rec['species'], smap or {})
            rec['plan_species'] = ex['plan_species']
            rec['species_basis'] = ex['basis']
            if ex.get('also_covers'):
                rec['also_covers'] = ex['also_covers']
        statewide.setdefault('TN', []).append(rec)

    for slug, recs in ((doc['states'].get('TN') or {}).get('waters') or {}).items():
        for r in recs if isinstance(recs, list) else [recs]:
            add(slug, {'source': 'TWRA reservoir page', 'source_ref': r.get('source_file'),
                       'preamble': r.get('preamble') or [], 'rules': r.get('rules') or []})
    for slug, recs in (((doc['states'].get('TN') or {}).get('digest') or {}).get('waters')
                       or {}).items():
        for r in recs:
            add(slug, {'source': 'TN digest exceptions', 'source_ref': 'page %s' % r.get('page'),
                       'heading': r.get('heading'), 'rules': r.get('rules') or []})

    for st, blk in doc['states'].items():
        specs = (all_specs or {}).get(st, ('', []))[1]
        for key, tables in (blk.get('tables') or {}).items():
            for tb in tables:
                band = None
                last_species = None
                for row in tb['rows']:
                    if row.get('is_band_heading'):
                        band = row.get('species_band')
                        continue
                    r = row.get('resolved') or {}
                    cells = [c for c in row['cells'] if c]
                    if not cells:
                        continue
                    rec = {'source': '%s %s' % (st, blk.get('source_file')),
                           'table': key, 'label': tb.get('label'), 'page': tb.get('page'),
                           'address': r.get('text'), 'cells': row['cells']}
                    # THE TWO NUMBERS A PERSON ACTUALLY ASKS FOR, pulled out at build time so
                    # no consumer has to work out which cell is which. The browser's callers
                    # read sizeLimit and creelLimit and nothing else; a record that carries
                    # only `cells` reaches them as an anonymous list and is dropped, which is
                    # the same shape of failure as the note that neither caller read.
                    scol_i, ccol_i = limit_columns(tb.get('header'))
                    for fld, ix in (('size_limit', scol_i), ('creel_limit', ccol_i)):
                        if ix is not None and ix < len(row['cells']) and row['cells'][ix]:
                            rec[fld] = row['cells'][ix]
                    # WHICH SPECIES IS SHUT, carried onto every closure record.
                    #
                    # `June 16 - Sept. 30 closed` is the STRIPED BASS row. Without the species
                    # on the record a consumer reads it as "Lake Marion is closed" and refuses
                    # a crappie trip in July on a lake that is open. The species sits in the
                    # FISH column of the SC tables and in the all-caps band on NC's.
                    # Column 1 is the FISH column only where column 0 is the address. On the
                    # SC state lakes table column 1 IS the water body, and reading it as a
                    # species gave Lake Edwin B. Johnson a closure on the species
                    # "Lake Edwin B. Johnson". Where no species column exists the closure is
                    # not species-scoped -- it shuts the water, which is what those rows say.
                    o2 = opts_for(specs, key)
                    sp = None
                    # A SPEC THAT SAYS WHERE THE SPECIES IS MUST BE BELIEVED. GA's saltwater
                    # table declares species_col: 0 and this code read column 1 anyway, because
                    # the rule was written as "column 1 where column 0 is the address". So all
                    # 31 saltwater rows came out with no species and `shuts the water`.
                    scol = o2.get('species_col')
                    if o2.get('species_bands') and band:
                        # THE BAND IS THE SPECIES ON A BANDED TABLE, and column 1 is a size
                        # limit. NC heads each block with an all-caps species -- FLOUNDER, RED
                        # DRUM, SPOTTED SEATROUT -- and puts the water in column 0 and the
                        # length in column 1. The "column 1 is the fish where column 0 is the
                        # address" rule took the length, so NC's only closure in the whole book,
                        # flounder's two-week season `1 (Sept. 1 - Sept. 14.)`, arrived on a
                        # species called `15-inch minimum`. The spec already said species_bands;
                        # this believes it.
                        sp = band
                    elif scol is not None and len(row['cells']) > scol \
                            and row['cells'][scol] and not row.get('continuation'):
                        sp = row['cells'][scol]
                    elif o2.get('water_col', 0) == 0 and len(row['cells']) > 1 \
                            and row['cells'][1] and not row.get('continuation'):
                        sp = row['cells'][1]
                    # A SPREAD REPEATS ITS HEADER AND rows_after() ONLY SKIPS THE FIRST ONE.
                    # SC's saltwater table runs over five pages and prints `SPECIES | CLOSED
                    # SEASON IN FEDERAL WATERS` again partway down, which arrived as a closure
                    # on a fish called SPECIES. Furniture, not a row.
                    if sp and norm(sp).strip().lower() in ('species', 'water body', 'county'):
                        continue
                    sp = sp or band or (last_species if row.get('continuation') else None)
                    all_species = o2.get('water_col', 0) != 0 and scol is None
                    cl = []
                    if row.get('recurring'):
                        # Typed `unknown` so it warns with the book's own sentence and can never
                        # gate. A Saturday-morning closure is real and this app cannot say it.
                        for c in closures_in(' '.join(cells)):
                            c['effect'], c['applies_to'] = 'unknown', 'unknown'
                            c['note'] = ('the book states this closure as a repeating one -- a '
                                         'weekday or a window relative to another season -- '
                                         'which this app cannot express, so it warns rather '
                                         'than shutting the water')
                            c['species'] = None
                            c['species_known'] = False
                            c['plan_species'] = []
                            c['species_basis'] = 'not species-scoped'
                            cl.append(c)
                        if cl:
                            rec['closures'] = cl
                        if r.get('kind') in ('statewide', 'implicit'):
                            statewide.setdefault(st, []).append(rec)
                        for slug in r.get('waters') or []:
                            add(slug, dict(rec, matched_via=r.get('kind')))
                        continue
                    seas = o2.get('season_col')
                    if seas is not None and len(row['cells']) > seas:
                        cl.extend(season_column(row['cells'][seas], sp,
                                                o2.get('season_sense', 'open')))
                    for c in cells:
                        if seas is not None and c == row['cells'][seas]:
                            continue          # the column already answered; do not read it twice
                        cl.extend(closures_in(c))
                    if cl:
                        for c in cl:
                            c['species'] = None if all_species else sp
                            c['species_known'] = bool(sp) and not all_species
                            if all_species:
                                c['applies_to'] = 'all_fishing'
                                c['note'] = 'no species column in this table -- shuts the water'
                                c['plan_species'] = list((smap or {}).get('plan_species', {})
                                                         .get('values') or [])
                                c['species_basis'] = 'every species -- the water is shut'
                            elif o2.get('implicitly') == 'statewide coastal':
                                # NOT AN UNMAPPED PHRASE, AND NOT A SILENT ZERO. Cobia and
                                # Atlantic sturgeon are not missing from species_map.json --
                                # that map is the FRESHWATER plan form's fifteen checkboxes and
                                # a saltwater fish has no business in it. So these gate nothing
                                # by construction and say why, rather than arriving as UNMAPPED
                                # and reading like a lookup that failed.
                                c['plan_species'] = []
                                c['species_basis'] = ('coastal species -- the freshwater plan '
                                                      'form has no checkbox for it')
                            else:
                                ex = expand_species(sp, smap or {})
                                c['plan_species'] = ex['plan_species']
                                c['species_basis'] = ex['basis']
                                if ex.get('also_covers'):
                                    c['also_covers'] = ex['also_covers']
                        rec['closures'] = cl
                    # THE SPECIES ON THE RECORD, not only on its closures. `sp` has been
                    # computed here all along and was spent entirely on closure records, so a
                    # rule that carries a limit and no closure -- which is most of them, and
                    # all 103 statewide rows -- reached a consumer as an anonymous list of
                    # cells. Anything wanting to answer "what may I keep" had to guess which
                    # cell was the fish, which is the judgement this file resolves once at
                    # build time precisely so neither the Worker nor the browser makes it.
                    if sp and not all_species:
                        rec['species'] = sp
                        if o2.get('implicitly') == 'statewide coastal':
                            # Same reasoning as the closure branch: species_map.json is the
                            # FRESHWATER plan form's fifteen checkboxes and a saltwater fish
                            # has no business in it. Says so rather than reading as UNMAPPED.
                            rec['plan_species'] = []
                            rec['species_basis'] = ('coastal species -- the freshwater plan '
                                                    'form has no checkbox for it')
                        else:
                            ex = expand_species(sp, smap or {})
                            rec['plan_species'] = ex['plan_species']
                            rec['species_basis'] = ex['basis']
                            if ex.get('also_covers'):
                                rec['also_covers'] = ex['also_covers']
                    if sp and not row.get('continuation'):
                        last_species = sp
                    if band:
                        rec['species_band'] = band
                    if row.get('continuation'):
                        rec['continues_the_row_above'] = True
                    if row.get('text_cut_by_the_grid'):
                        # Carried so a consumer can refuse it. The row is real and its address
                        # resolved; what the book SAYS in it did not survive extraction.
                        rec['text_cut_by_the_grid'] = row['text_cut_by_the_grid']
                    if o2.get('implicitly') == 'statewide coastal':
                        # SAID ON THE RECORD, NOT INFERRED FROM THE TABLE'S NAME. A consumer
                        # asking "what shuts a season on this coast" should not have to know
                        # that GA's happens to be the table called `saltwater`.
                        rec['scope'] = 'statewide coastal'
                    if row.get('demarcation'):
                        # A BOUNDARY, NOT A LIMIT, and which boundary matters. Two of GA's three
                        # clauses draw the finfish line and the third draws a different one for
                        # crab pots, at a railroad instead of U.S. 17. Flattened together they
                        # would move the line by miles on the two rivers named in both.
                        rec['kind_of_rule'] = 'where saltwater begins'
                        rec['clause'] = row.get('clause')
                        rec['crossings'] = row.get('crossings') or []
                        rec['governs'] = ('crab pots only' if row.get('clause') == 'crabbing only'
                                          else 'finfish')
                    if r.get('applies_to_feature_types'):
                        # THE SCOPE TRAVELS OR THE RECORD IS A LIE. NC's striped bass default
                        # covers impounded inland waters, and we offer 17 rivers and 3 coastal
                        # waters in that state which the book governs by management area
                        # instead. Served without this, every one of them would be handed an
                        # impoundment's 20-inch minimum that the book gives them nowhere.
                        rec['applies_to_feature_types'] = list(r['applies_to_feature_types'])
                    if r.get('address_is_a_reach'):
                        # THE BOOK ADDRESSED PART OF THIS RIVER, and the registry has one slug
                        # for the whole of it. Said out loud so a card can print the sentence
                        # instead of implying the rule runs bank to bank.
                        rec['address_is_a_reach'] = True
                    if r.get('kind') in ('statewide', 'implicit'):
                        statewide.setdefault(st, []).append(rec)
                    for slug in r.get('waters') or []:
                        add(slug, dict(rec, matched_via=r.get('kind')))
        nmap = build_name_map(idx)
        for slug, lake in ((blk.get('state_lakes') or {}).get('lakes') or {}).items():
            hit = resolve(lake['water_body'], nmap) \
                or resolve_by_county(lake['water_body'], lake.get('county'), st, idx)
            if hit:
                rec = {'source': '%s state lakes table' % st, 'state_lake': lake}
                # THE COLUMN SAYS IT, SO THE SENTENCE DOES NOT HAVE TO. closures_in() reads
                # prose and is deliberately tight -- it wants `closed to boating and fishing`
                # or a date window. The 2026-2027 book shuts Lake Paul Wallace with
                # `Every day (Currently closed pending repairs)`, which is neither, so the
                # water bound and still read as open. This table has a column whose whole job
                # is to say which days the water is open; when that column says closed, that
                # IS the closure, and the book's own sentence travels with it. Loosening the
                # prose regex instead would have put false closures through 124 pages.
                shut = re.search(r'\bclosed\b', lake.get('open_days') or '', re.I)
                already = {c.get('text') for r in (by.get(hit, {}).get('rules') or [])
                           for c in (r.get('closures') or [])}
                if shut and lake['open_days'] not in already:
                    rec['closures'] = [{
                        'effect': 'closed', 'applies_to': 'all_fishing',
                        'start': None, 'end': None, 'text': lake['open_days'],
                        'note': 'the OPEN DAYS column of the state lakes table says so, and '
                                'this table has no species column -- it shuts the water',
                        'species': None, 'species_known': False,
                        'plan_species': list((smap or {}).get('plan_species', {})
                                             .get('values') or []),
                        'species_basis': 'every species -- the water is shut',
                    }]
                add(hit, rec)
            else:
                # A STATE LAKE THAT BINDS TO NOTHING USED TO VANISH HERE. Three of these
                # eighteen rows say the water is shut; one of the three is a water the card
                # offers. Silence is what let it ship open.
                doc.setdefault('problems', []).append(
                    {'state': st, 'why': 'state lakes row bound to no registry water',
                     'water_body': lake.get('water_body'), 'county': lake.get('county'),
                     'closed': lake.get('closed')})
    return by, statewide




# ─────────────────────────────────────────────────────────────────────────────────────────────
# CLOSURES -- a sentence turned into a window, WITHOUT deciding what it forbids
# ─────────────────────────────────────────────────────────────────────────────────────────────
#
# This is the one piece here with a citation on the end of it, so it is deliberately timid.
#
# A date range in these books is not self-describing. `Oct. 1 - June 15: 26 inches min` is an
# open season with a slot. `June 16 - Sept. 30 closed` is a closure. `Season is open from
# April 1-15` is a closure everywhere outside it. `closed to snagging from March 1-31` closes
# one METHOD on one reach and nothing else. Reading the dates without reading what they govern
# is how a planner tells you a lake is shut when it is open, or open when it is shut.
#
# So a window is emitted only when the sentence says so, and `applies_to` records WHAT is shut.
# Only `all_fishing` and `harvest` should ever produce a hard block; everything else is a
# warning with the sentence attached, because the sentence is what a person can actually check.

MONTHS = {'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6, 'jul': 7,
          'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12}
MD = r'(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)[a-z]*\.?\s*(\d{1,2}))'
RANGE = re.compile(MD + r'\s*(?:through|thru|to|[-–—])\s*' + MD, re.I)
# `Season is open from April 1-15` and `closed to snagging from March 1-31` -- one month, two
# days. Missing this dropped the paddlefish season entirely and found only the second half of
# Cherokee's two-part snagging closure.
SAME_MONTH = re.compile(r'(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)[a-z]*\.?\s*'
                        r'(\d{1,2})\s*(?:through|thru|to|[-–—])\s*(\d{1,2})\b', re.I)
LIMIT_TAIL = re.compile(r'\b(inch|inches|minimum|maximum|per day|no length limit|PLR|slot)\b', re.I)
CLOSED_WORD = re.compile(r'\bclosed\b|\bprohibit(?:ed)?\b|\bno harvest\b|\bunlawful\b', re.I)
OPEN_WORD = re.compile(r'\bseason is open\b|\bopen from\b|\bmay be harvested\b', re.I)
METHOD = re.compile(r'\bclosed to (\w+)', re.I)
NO_FISHING = re.compile(r'\b(all watercraft and fishing|no fishing|closed to (?:boating and )?'
                        r'fishing|fishing (?:is )?prohibited|closed fishing zone|'
                        r'closed to boating and fishing)\b', re.I)


def _md(mon, day):
    return '%02d-%02d' % (MONTHS[mon[:3].lower()], int(day))


def closures_in(text):
    """Every date-bounded rule in one sentence, typed by what it governs."""
    t = norm(text)
    if not t:
        return []
    out = []
    spans = [(m.start(), m.end(), _md(m.group(1), m.group(2)), _md(m.group(3), m.group(4)))
             for m in RANGE.finditer(t)]
    for m in SAME_MONTH.finditer(t):
        if any(a <= m.start() < b for a, b, _s, _e in spans):
            continue
        spans.append((m.start(), m.end(), _md(m.group(1), m.group(2)),
                      _md(m.group(1), m.group(3))))
    for _s0, _e0, start, end in sorted(spans):
        m = type('M', (), {'start': lambda self, _v=_s0: _v, 'end': lambda self, _v=_e0: _v})()
        tail = t[m.end():m.end() + 90]
        head = t[max(0, m.start() - 90):m.start()]
        near = head + ' ' + tail
        rec = {'start': start, 'end': end, 'text': t}
        meth = METHOD.search(near)
        if NO_FISHING.search(near):
            rec.update(effect='closed', applies_to='all_fishing')
        elif meth and meth.group(1).lower() not in ('fishing', 'boating'):
            rec.update(effect='closed', applies_to='method:' + meth.group(1).lower())
        elif OPEN_WORD.search(head[-34:]):
            # THE PHRASE THAT GOVERNS A RANGE SITS AGAINST IT, and the open one comes BEFORE:
            # `Season is open from April 1-15`. Checking the tail first read the paddlefish
            # season as a closure, because `Culling is prohibited.` follows it in the same
            # sentence -- calling an open season shut, which is the failure direction that
            # actually costs a trip.
            rec.update(effect='open_only', applies_to='harvest')
        elif CLOSED_WORD.search(tail[:30]) or CLOSED_WORD.search(t[m.end():m.end() + 12]):
            rec.update(effect='closed', applies_to='harvest')
        elif OPEN_WORD.search(near):
            rec.update(effect='open_only', applies_to='harvest')
        elif LIMIT_TAIL.search(tail[:70]):
            # `Oct. 1 - June 15: 26 inches min` -- a window with a size or creel limit inside
            # it. Real, useful, and NOT a closure. Typed so it can be shown without ever
            # blocking a trip.
            rec.update(effect='limit_window', applies_to='harvest')
        else:
            rec.update(effect='unknown', applies_to='unknown')
        out.append(rec)
    if not out and NO_FISHING.search(t) and re.search(r'\bclosed\b', t, re.I):
        out.append({'effect': 'closed', 'applies_to': 'all_fishing', 'start': None,
                    'end': None, 'text': t, 'note': 'no dates given -- closed outright'})
    return out




ALL_YEAR = re.compile(r'^\s*all\s*year\s*\.?\s*$', re.I)
NO_HARVEST = re.compile(r'^\s*no\s+harvest\s*\.?\s*$', re.I)


NO_RULE = re.compile(r'^\s*no\s+associated\s+regulations\.?\s*$', re.I)
FEDERAL = re.compile(r'\bfederal\s+waters\b', re.I)
# A CLOSURE WITH A PLACE IN IT IS NOT A STATEWIDE CLOSURE. `May 1 to May 31 in state waters
# south of 032 31.0 N latitude (Jeremy Inlet, Edisto Island)` shuts one stretch of coast, and
# nothing here knows where the boat is.
SUB_AREA = re.compile(r'\b(except in|south of|north of|east of|west of|latitude|inlet|'
                      r'lower reach|upper reach|river\b)', re.I)
# A GEAR RESTRICTION IS NOT A CLOSED SEASON, and it sits in the CLOSED SEASON column anyway.
# `May not be harvested by gig Dec. 1 - Feb. 28` leaves rod and reel entirely alone. Retyping
# its window as a harvest closure -- which is what the bare-window rule below does if this does
# not catch it first -- shuts red drum and seatrout for three months of legal fishing.
BY_GEAR = re.compile(r'\bby\s+(gig|gigs|spear|spearing|spear\s*gun|net|nets|cast\s*net|'
                     r'trawl|seine|snagging|snatch\w*)\b', re.I)


def season_column(text, species, sense='open'):
    """A column that states a season, typed from the column instead of from prose.

    THE SAME LESSON AS THE STATE LAKES OPEN DAYS COLUMN, one table over. GA's saltwater table
    heads a column `OPEN SEASON` and answers it 31 times; closures_in() reads prose and found
    one thing in all 31 -- Cobia's `Mar. 1 - Oct. 31` -- and typed it `unknown / all_fishing`,
    which is both the wrong effect and the wrong scope. That string is Cobia's OPEN season. A
    parser that reads an open season as a closure of the whole coast is the failure direction
    that costs a trip, and it got there by reading the sentence instead of the column.

    Four answers, and the vocabulary was counted before it was written, not guessed:
    `All year` 23 times, blank 3, `No Harvest` once, one date range, and three sentences that
    are not seasons at all (federal quota language, a spilled species list).

      All year          -> nothing to emit, and that is an ANSWER, not silence
      No Harvest        -> closed, and to HARVEST -- the book does not forbid catching it
      a date range      -> open_only, the window the take is allowed in
      anything else     -> unknown, carrying the book's sentence so it can be quoted

    AND THE TWO STATES HEAD THE COLUMN THE OPPOSITE WAY ROUND. Georgia's says OPEN SEASON and
    South Carolina's says CLOSED SEASON, so the same string means opposite things and the sense
    is read off the header rather than assumed. `sense='closed'` is SC's, where the column is
    prose about a closure and closures_in() is the right reader for it -- what is added is the
    undated `Possession prohibited`, which has no window and no NO_FISHING phrase, and the two
    scopes that must NEVER block:

      federal waters   we fish inside the 3-mile line; a federal closure is not ours to enforce
      a sub-area       `south of 032 31.0 N latitude`, `except in lower reach of the Savannah
                       River` -- real closures on one stretch of coast, and nothing here knows
                       where the boat is. Both warn, carrying the book's sentence.

    Returns a list, so a caller can extend() it the way it extends closures_in().
    """
    t = norm(text)
    if not t or NO_RULE.match(t):
        return []
    if sense == 'closed':
        unk = [{'effect': 'unknown', 'applies_to': 'unknown', 'start': None, 'end': None,
                'text': t}]
        if FEDERAL.search(t):
            unk[0]['note'] = ('the CLOSED SEASON column names FEDERAL waters -- outside the '
                              '3-mile line, and not what this app plans on')
            return unk
        if SUB_AREA.search(t):
            unk[0]['note'] = ('the CLOSED SEASON column names one stretch of coast, and nothing '
                              'here knows where the boat is')
            return unk
        got = closures_in(t)
        if got:
            for c in got:
                # A BARE WINDOW IN A COLUMN HEADED `CLOSED SEASON` IS THE CLOSURE. closures_in()
                # reads the sentence around a date range and `Jan. 1 - Apr. 30` has no sentence
                # around it, so it comes back `unknown` -- correct for prose and wrong here,
                # because the header already said what the window means. Only a window is
                # retyped; undated prose it could not classify stays unknown and warns.
                gear = BY_GEAR.search(t)
                if gear and c.get('applies_to') in (None, 'unknown', 'harvest'):
                    c['effect'] = 'closed'
                    c['applies_to'] = 'method:' + re.sub(r'\s+', '', gear.group(1).lower())
                elif c.get('effect') == 'unknown' and c.get('start') and c.get('end'):
                    c['effect'], c['applies_to'] = 'closed', 'harvest'
                c.setdefault('note', 'the CLOSED SEASON column says so')
            return got
        if CLOSED_WORD.search(t):
            return [{'effect': 'closed', 'applies_to': 'harvest', 'start': None, 'end': None,
                     'text': t, 'note': 'the CLOSED SEASON column says so, with no dates given'}]
        return unk
    if ALL_YEAR.match(t):
        return []
    if NO_HARVEST.match(t):
        return [{'effect': 'closed', 'applies_to': 'harvest', 'start': None, 'end': None,
                 'text': t, 'note': 'the OPEN SEASON column says so'}]
    windows = closures_in(t)
    if windows:
        for w in windows:
            # The column is headed OPEN SEASON. A window in it is the open one, whatever the
            # prose typer made of it.
            w['effect'] = 'open_only'
            w['applies_to'] = 'harvest'
            w['note'] = 'the OPEN SEASON column names the window the take is allowed in'
        return windows
    return [{'effect': 'unknown', 'applies_to': 'unknown', 'start': None, 'end': None,
             'text': t, 'note': 'the OPEN SEASON column holds something that is not a season'}]


def statewide_records(doc):
    """Statewide rows re-shaped so check_species_map() can walk them like any other record.

    The species sits in a different place per table -- an all-caps band on NC's, column 0 on
    GA's, column 1 on SC's -- and the SPEC already says which. Read it from there rather than
    guessing, which is the mistake that put `15-inch minimum` in a species field.
    """
    out = []
    for st, recs in (doc.get('statewide') or {}).items():
        by_key = {k: (o or {}) for k, _h, _p, o in (SPECS.get(st, ('', []))[1] or [])}
        for r in recs:
            if r.get('scope') == 'statewide coastal':
                continue          # a coastal species has no checkbox in a freshwater form
            if r.get('species'):
                # A record that already names its own species -- the TN statewide table builds
                # them that way -- does not need the spec consulted at all.
                out.append({'species': r['species'], 'closures': [], 'rules': []})
                continue
            o = by_key.get(r.get('table'), {})
            cells = r.get('cells') or []
            if o.get('species_bands') and r.get('species_band'):
                nm = r['species_band']
            elif o.get('species_col') is not None and len(cells) > o['species_col']:
                nm = cells[o['species_col']]
            elif o.get('water_col', 0) == 0 and len(cells) > 1:
                nm = cells[1]
            else:
                nm = None
            nm = (nm or '').strip()
            if nm:
                out.append({'species': nm, 'closures': [], 'rules': []})
    return out


def check_species_map(doc, registry):
    """Every species phrase the books use must be in registry/species_map.json.

    A PHRASE THE MAP DOES NOT KNOW IS A BUILD ERROR, NOT A SILENT SKIP. The alternative is a
    closure that quietly matches no species and therefore never fires -- which looks exactly
    like a lake with no closure. The books add and reword species between editions, so this
    will trip, and it should.
    """
    p = os.path.join(registry, 'species_map.json')
    if not os.path.exists(p):
        return {'checked': False, 'why': 'species_map.json not found'}
    m = json.load(open(p, encoding='utf-8'))
    known = set(m.get('book_phrases') or {})
    known |= {k for k in (m.get('partly_mapped') or {}) if not k.startswith('_')}
    known |= {k for k in (m.get('no_home_in_the_form') or {}) if not k.startswith('_')}
    plan = set((m.get('plan_species') or {}).get('values') or [])
    seen = set()

    def walk(recs):
        for r in recs:
            if r.get('species'):
                seen.add(r['species'])
            # AND THE BAND, which is where a banded table keeps its species. by_water records
            # carry it as `species_band`, so every NC species reached this check as nothing at
            # all -- `STRIPED BASS AND BODIE BASS (STRIPED BASS HYBRID)` among them, on three
            # waters, while the run reported 0 unmapped.
            if r.get('species_band'):
                seen.add(r['species_band'])
            for c in (r.get('closures') or []):
                if c.get('species'):
                    seen.add(c['species'])
            walk(r.get('rules') or [])
    for w in (doc.get('by_water') or {}).values():
        walk(w.get('rules') or [])
    # AND THE STATEWIDE RECORDS, WHICH ARE THE ONES THAT GOVERN ALMOST EVERY LAKE.
    #
    # This walked by_water only, so it reported `0 unmapped` for a year while the statewide
    # table -- the answer for every water without an exception -- mapped to ONE of the fifteen
    # plan species in Georgia, NONE in North Carolina and six in South Carolina. Ryan:
    # "most lakes do not have a specific limit... a per lake number isn't ever going to work...
    # unless you are extracting the general regulation for each species and assigning that to
    # each lake". He is right, and the statewide half was the half nothing checked.
    #
    # `Bream (includes bluegill, flier, warmouth, pumpkinseed, green sunfish, redear
    # (shellcracker) and spotted sunfish)` is the case that shows the cost: SC's own definition
    # of six plan species, sitting unmapped and therefore answering for none of them.
    walk(statewide_records(doc))
    unmapped = sorted(seen - known)
    # A closure that gates nothing because the form cannot name its fish is the planner gap,
    # counted here so it is a number rather than an impression.
    homeless = {k for k in (m.get('no_home_in_the_form') or {}) if not k.startswith('_')}
    cannot_fire = []
    for slug, w in (doc.get('by_water') or {}).items():
        def cw(recs):
            for r in recs:
                for c in (r.get('closures') or []):
                    if c.get('effect') == 'closed' and c.get('species') in homeless:
                        cannot_fire.append({'water': slug, 'species': c['species'],
                                            'window': '%s..%s' % (c.get('start'), c.get('end'))})
                cw(r.get('rules') or [])
        cw(w.get('rules') or [])
    return {'checked': True, 'phrases_in_the_books': len(seen), 'unmapped': unmapped,
            'plan_species': sorted(plan), 'species_with_no_home': sorted(homeless),
            'closures_that_cannot_fire': cannot_fire}


if __name__ == '__main__':
    sys.exit(main())
