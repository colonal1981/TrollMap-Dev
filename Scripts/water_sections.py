#!/usr/bin/env python3
r"""water_sections.py -- which part of a document is about THIS water, for every reader that asks.

Personal use only, not for distribution or resale; not for navigation.

ONE RULE, TWO READERS. claude_species.py chose the passages of a document that are about a water
for the Claude step's packet. research_lakes.py sent every document to extraction cut to its first
EXTRACT_DOC_CHARS, and the extractor takes only facts that name the water -- so a statewide report
whose Parr Reservoir section starts at character 93,713 was read for 20,000 characters about other
waters and gave nothing for Parr. Measured on the desktop on 2026-09-25 over the stored documents of
84 waters: 69 documents named the water only past the cut, 131 more named it more often past the
cut than before it. The rule that finds a water's sections was already written; it lives here now
so both scripts read the same one.

  A SECTION runs from one heading, `--- PAGE` marker or date line to the next.
  A document whose title or address names the water is about the water, all of it.
  One that does not is about the water only in the sections that name it, and the nearest heading
  and date line above such a section travel with it.

window() is the second reader: it chooses WHICH `limit` characters of a document are sent, never
how many. See its docstring for the order and for how a windowed document keeps its dates.
"""
import re

# ── WHAT A SECTION IS ──────────────────────────────────────────────────────────────────────────

_MONTH = (r"(?:January|February|March|April|May|June|July|August|September|October|November|"
          r"December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?")
# Worker/research/text-date.js carries this regex verbatim as DATE_LINE: a fact is dated by the
# nearest line of this kind above its quote.
_DATE_LINE = re.compile(rf"^\W*(?:{_MONTH}\s+\d{{1,2}}(?:,?\s+\d{{4}})?|\d{{1,2}}\s+{_MONTH},?\s+\d{{4}}|"
                        r"\d{4}-\d{2}-\d{2})\W*$", re.I)

# The top of a page, where its stamp is read: text-date.js's TOP_OF_PAGE and build_packet()'s
# "date near the top of the page". One span for every reader of it; test_extract_window.py fails if
# the Worker's number and this one part.
TOP_OF_PAGE = 4000


def _units(text):
    """(start, end) of every sentence-ish piece: split after . ! ?, at blank lines, and around a
    line that is a heading or a date on its own.

    NOT AT EVERY LINE BREAK. PDF text wraps mid-sentence, and the first cut split there: the SCDNR
    survey's "58% ... at depths of 30-\\n59 feet below the surface" became two pieces, neither
    holding "30-59 feet", and the one sentence that says how deep Murray's summer stripers are
    was not kept."""
    cuts = set()
    for m in re.finditer(r"(?<=[.!?])\s+|\n\s*\n", text):
        cuts.add((m.start(), m.end()))
    pos = 0
    for line in text.split("\n"):
        a, b = pos, pos + len(line)
        if line.strip() and (_is_heading(line) or _DATE_LINE.match(line.strip())):
            cuts.add((a, a))
            cuts.add((b, b))
        pos = b + 1
    out, start = [], 0
    for a, b in sorted(cuts):
        if a < start:
            continue
        if text[start:a].strip():
            out.append((start, a))
        start = b
    if text[start:].strip():
        out.append((start, len(text)))
    # Trim each piece to its text so a kept slice never starts or ends in whitespace.
    trimmed = []
    for a, b in out:
        s = text[a:b]
        a2 = a + (len(s) - len(s.lstrip()))
        b2 = b - (len(s) - len(s.rstrip()))
        if b2 > a2:
            trimmed.append((a2, b2))
    return trimmed


def _is_heading(s):
    t = s.strip()
    return (t.startswith("#") or t.startswith("--- PAGE")
            or (len(t) <= 90 and t.startswith("**") and t.endswith("**") and len(t) > 4))


def _names_water(text, terms):
    low = text.lower()
    return any(re.search(r"\b" + re.escape(t.lower()) + r"\b", low) for t in terms if t)


def water_terms(lake, aliases, base):
    """The strings that mean THIS water in document text: the matching name the extractor uses,
    and every alias the registry carries, each without its county or state stamp."""
    out = [base]
    for a in aliases or []:
        b = re.sub(r"\s*\([^)]*\)\s*", " ", str(a))
        b = re.sub(r",\s*[A-Z]{2}(/[A-Z]{2})*\s*$", "", b).strip()
        if b and b.lower() not in {x.lower() for x in out}:
            out.append(b)
    return [t for t in out if len(t) >= 3]


def _is_date_line(text, a, b):
    """Is unit text[a:b] a date line: a date that is the WHOLE of its line?

    text-date.js's definition, which reads lines. _units() also cuts after ". ", so without this a
    sentence that is only a date inside a longer line counted as one -- Blalock's FY2016-17
    accountability report, "...following the effective date of the section. (June 30, 2015).",
    made "(June 30, 2015)." the date line above a section, and sent after a BREAK it stood on a
    line of its own and dated 313 sentences the whole report leaves undated."""
    if not _DATE_LINE.match(text[a:b].strip()):
        return False
    start = text.rfind("\n", 0, a) + 1
    end = text.find("\n", b)
    return text[start:len(text) if end < 0 else end].strip() == text[a:b].strip()


def sections(text, units, paragraphs_past=None):
    """(heads, dates, bounds): the unit indices of the headings and of the date lines, and the
    section bounds -- unit indices where a section starts, with 0 and len(units) at the ends.

    DATE LINES ARE SECTION BREAKS TOO: a weekly report page has one heading and twenty dated
    entries, and on 2026-09-25 the Clarks Hill AHQ page went whole (40,740 characters) into the
    Broad River's packet because one entry mentioned the Broad River arm.

    A SECTION LONGER THAN THE READER CAN TAKE IS BROKEN AT ITS BLANK LINES. The SCDNR 2007
    statewide job report, as the pipeline stores it, is 134,011 characters with no heading, no
    `--- PAGE` marker and no date line: to the rule above it is one section, and a section that
    names Parr Reservoir once is the whole report. A 60,000-character section that names the water
    near its end is the same problem inside a document that does have breaks. What such text has is
    its blank lines, between the jobs, the tables and the pages. With `paragraphs_past` (the
    window's own cut), a section longer than it is broken at them; every other section is read
    exactly as the rule above reads it."""
    heads = [i for i, (a, b) in enumerate(units) if _is_heading(text[a:b])]
    dates = [i for i, (a, b) in enumerate(units) if _is_date_line(text, a, b)]
    bounds = sorted({0, len(units), *[h for h in heads if h > 0], *[d for d in dates if d > 0]})
    if paragraphs_past:
        extra = []
        for s, e in zip(bounds, bounds[1:]):
            a = 0 if s == 0 else units[s][0]
            b = units[e][0] if e < len(units) else len(text)
            if b - a > paragraphs_past:
                extra += [i for i in range(s + 1, e)
                          if re.search(r"\n\s*\n", text[units[i - 1][1]:units[i][0]])]
        bounds = sorted({*bounds, *extra})
    return heads, dates, bounds


# THE PIPELINE'S OWN WORDS ARE NOT THE PAGE'S. Worker/research/discover.js seeds a page it found in
# a Grokipedia or Wikipedia article's citations under a title it writes itself --
# `${lakeName} — ${authority} (via Grokipedia citation)`, and the same "(via Wikipedia citation)" --
# so that title names the water because the pipeline put the name there, whatever the page is
# about. A cited statewide report would otherwise count as "about this water, all of it".
_OUR_CITATION_TITLE = re.compile(r"\(via [^)]* citation\)\s*$", re.I)


def title_names_water(title, url, terms):
    """Does the document's own title or address name this water?"""
    title = "" if _OUR_CITATION_TITLE.search(str(title or "")) else str(title or "")
    url = str(url or "")
    return _names_water(title + " " + url.replace("-", " ").replace("_", " "), terms)


# ── THE WINDOW ─────────────────────────────────────────────────────────────────────────────────

# Between two pieces that are not next to each other in the document. It is no date line and holds
# no date, so text-date.js cannot read it as a stamp or as the line above a quote; and it has words
# in it, so a quote cannot run across it: text-date.js and extract.js find a quote by its letters
# and digits with every run of anything else read as one space, and "[...]" alone would have let
# the last words of one piece and the first of the next read as one sentence.
BREAK = "\n\n[... text not sent ...]\n\n"


def _delink(s):
    """text-date.js's delink(): a date line written as a link is still a date line, and the top of
    the page is counted without its links."""
    s = re.sub(r"!?\[([^\]]*)\]\((?:[^()\s]|\([^)\s]*\))*\)", r"\1", s)
    return re.sub(r"https?://\S+", " ", s)


def _head_end(text, limit):
    """Where the head ends: the first line end at which the head, read the way text-date.js reads
    a page, holds the page's whole top -- or `limit` if it cannot within the cut.

    TOP_OF_PAGE COUNTS CHARACTERS AFTER THE LINKS ARE TAKEN OUT. readPage() delinks the whole text
    and then reads its first TOP_OF_PAGE characters. A page whose top is thick with addresses -- a
    SCDNR board meeting packet sent for Lake Bowen -- has its top 4,000 read characters reach well
    past character 4,000 of the stored text; a head cut at 4,000 let the next piece of the window
    into the read top, and a "May 20, 2021" line 40 pages down dated the packet's cover. So the
    head ends only where its delinked text is the delinked page's, through the end of the line that
    holds the TOP_OF_PAGE-th character."""
    whole = _delink(text)
    nl = whole.find("\n", TOP_OF_PAGE)
    need = len(whole) if nl < 0 else nl
    end = text.find("\n", TOP_OF_PAGE)
    while 0 <= end < limit:
        read = _delink(text[:end])
        if len(read) >= need and whole.startswith(read[:need]):
            return end
        end = text.find("\n", end + 1)
    return limit


def _sole_year(s):
    ys = set(re.findall(r"\b(?:1[89]|20)\d{2}\b", s))
    return len(ys) == 1


def _merge(text, ranges):
    """Sorted, and joined where two ranges touch or only whitespace lies between them, so text
    that is contiguous in the document is contiguous in what is sent."""
    out = []
    for a, b in sorted(ranges):
        if out and (a <= out[-1][1] or not text[out[-1][1]:a].strip()):
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


def _render(text, ranges):
    return BREAK.join(text[a:b] for a, b in _merge(text, ranges))


def _overlap(ranges, spans):
    n = 0
    for a, b in ranges:
        for c, d in spans:
            n += max(0, min(b, d) - max(a, c))
    return n


def window(text, title, url, terms, limit):
    """(sent_text, info): which `limit` characters of one document are sent to a model.

      1. Text that fits is sent unchanged.
      2. A document whose own title or address names the water: its first `limit` characters.
      3. Otherwise its head, then the sections that name the water in document order, each with
         the heading above it, until `limit` characters are used -- when that carries more of the
         water's text than the first `limit` characters do.
      4. Otherwise the first `limit` characters, as before: when no section past the head names
         the water, when every one that does is already whole inside the first cut, when the head
         alone reaches the cut, or when the window, with its date lines and breaks, would carry
         less of the water than the first cut does (named_sent against named_first_cut).

    A WINDOW DATES A FACT THE WAY THE WHOLE DOCUMENT WOULD. research/text-date.js reads three
    things, and the window keeps all three as they stand in the document:
      - the page's stamp, from the first TOP_OF_PAGE characters once links are taken out: the head
        runs to the end of the line that holds that character (_head_end()), so the window's top
        IS the document's top;
      - the nearest date line above a quote, and the year of a month-and-day line, which it counts
        through the page's order ("October 2" under "January 8" is the year before): EVERY date
        line of the document is kept, in order, including those of entries that are not sent --
        leave one out and a newest-first page with two entries left reads as oldest-first;
      - a year from the first heading that names one, when nothing else dates the page: kept.
    Pieces that are not next to each other are joined by BREAK.

    `info`: windowed (bool), why, chars (the document's length), sent (characters sent),
    named_first_cut and named_sent (characters that lie in a section naming the water, in the
    first `limit` characters and in what is sent), sections_named and sections_sent.
    """
    text = str(text or "")
    info = {"windowed": False, "why": None, "chars": len(text), "sent": 0,
            "named_first_cut": 0, "named_sent": 0, "sections_named": 0, "sections_sent": 0}

    def first_cut(why):
        info["why"] = why
        info["sent"] = min(len(text), limit)
        info["named_sent"] = info["named_first_cut"]
        return text[:limit], info

    if len(text) <= limit:
        info["why"] = "fits"
        info["sent"] = len(text)
        return text, info
    if title_names_water(title, url, terms):
        info["why"] = "its title or address names the water"
        info["sent"] = limit
        return text[:limit], info

    units = _units(text)
    heads, dates, bounds = sections(text, units, paragraphs_past=limit)

    def start_of(k):
        return 0 if k == 0 else units[k][0]

    def end_of(k):
        return units[k][0] if k < len(units) else len(text)

    spans = [(s, e, start_of(s), end_of(e)) for s, e in zip(bounds, bounds[1:])]
    named = [sp for sp in spans if _names_water(text[sp[2]:sp[3]], terms)]
    named_spans = [(a, b) for _, _, a, b in named]
    info["named_first_cut"] = _overlap([(0, limit)], named_spans)
    info["sections_named"] = len(named)

    # THE HEAD is the top of the page text-date.js reads a stamp from: to the end of the line that
    # holds its TOP_OF_PAGE-th character as it reads it (_head_end()), and no further. It used to run to the first section break, and
    # in 16 of the 69 stored documents that name the water only past the cut that break was past
    # the cut too -- Hartwell's 2013 report at 84,691 -- so the head filled the cut and the
    # document went as its first cut, the very job reports the window is for.
    head_end = _head_end(text, limit)
    if head_end >= limit:
        return first_cut("the line at the top of the page runs past the cut")
    past_head = [sp for sp in named if sp[3] > head_end]
    if not past_head:
        return first_cut("no section past its head names the water")
    if all(b <= limit for _, _, _, b in past_head):
        return first_cut("every section that names the water is inside the first cut")
    keep = [(0, head_end)]

    # Every date line past the head, and the first heading that names a year.
    pos, year_heading = 0, False
    for line in text.split("\n"):
        a, b = pos, pos + len(line)
        pos = b + 1
        t = _delink(line)
        if not year_heading and re.match(r"^\s*#", t) and _sole_year(t):
            year_heading = True
            if a >= head_end:
                keep.append((a, b))
        if a >= head_end and t.strip() and _DATE_LINE.match(t.strip()):
            keep.append((a, b))
    if len(_render(text, keep)) >= limit:
        return first_cut("its head and date lines fill the cut")

    for s, e, a, b in past_head:
        # The heading above it. The date line above it is already kept, with every other one.
        pieces = [units[max(m for m in heads if m <= s)]] if any(m <= s for m in heads) else []
        trial = keep + pieces + [(a, b)]
        over = len(_render(text, trial)) - limit
        if over <= 0:
            keep = trial
            info["sections_sent"] += 1
            continue
        # The last section goes in as far as the cut allows, ending at a line end where it has one.
        end = b - over
        while end > a:
            cut = text.rfind("\n", a, end)
            end = cut if cut > a else end
            trial = keep + pieces + [(a, end)]
            over = len(_render(text, trial)) - limit
            if over <= 0:
                keep = trial
                info["sections_sent"] += 1
                break
            end -= over
        break

    sent = _render(text, keep)
    named_sent = _overlap(_merge(text, keep), named_spans)
    # THE WINDOW ONLY WHEN IT CARRIES MORE OF THE WATER. Its date lines and breaks take room, and
    # on 24 stored documents it carried less than the first cut would have -- Falls Lake's NCWRC
    # fishing reports 7,880 characters against 12,919.
    if named_sent <= info["named_first_cut"]:
        return first_cut("the first cut carries as much of the water")
    info.update(windowed=True, why="sent as a window", sent=len(sent), named_sent=named_sent)
    return sent, info
