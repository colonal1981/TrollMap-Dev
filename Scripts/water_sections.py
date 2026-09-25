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


def sections(text, units, paragraphs_if_unbroken=False):
    """(heads, dates, bounds): the unit indices of the headings and of the date lines, and the
    section bounds -- unit indices where a section starts, with 0 and len(units) at the ends.

    DATE LINES ARE SECTION BREAKS TOO: a weekly report page has one heading and twenty dated
    entries, and on 2026-09-25 the Clarks Hill AHQ page went whole (40,740 characters) into the
    Broad River's packet because one entry mentioned the Broad River arm.

    A PDF'S TEXT MAY HAVE NO BREAK AT ALL. The SCDNR 2007 statewide job report, as the pipeline
    stores it, is 134,011 characters with no heading, no `--- PAGE` marker and no date line: to
    the rule above it is one section, and a section that names Parr Reservoir once is the whole
    report. What such text does have is its blank lines, between the jobs, the tables and the
    pages. With `paragraphs_if_unbroken`, a document the rule finds no break in is broken at them
    instead; a document with even one heading or date line is left exactly as the rule reads it."""
    heads = [i for i, (a, b) in enumerate(units) if _is_heading(text[a:b])]
    dates = [i for i, (a, b) in enumerate(units) if _DATE_LINE.match(text[a:b].strip())]
    bounds = sorted({0, len(units), *[h for h in heads if h > 0], *[d for d in dates if d > 0]})
    if paragraphs_if_unbroken and len(bounds) <= 2:
        bounds = sorted({0, len(units), *[i for i in range(1, len(units))
                                          if re.search(r"\n\s*\n", text[units[i - 1][1]:units[i][0]])]})
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
    """text-date.js's delink(), for one line: a date line written as a link is still a date line."""
    s = re.sub(r"!?\[([^\]]*)\]\((?:[^()\s]|\([^)\s]*\))*\)", r"\1", s)
    return re.sub(r"https?://\S+", " ", s)


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
         the heading and date line above it, until `limit` characters are used.
      4. No section past the head names the water, or every one that does is already whole inside
         the first `limit` characters: the first `limit` characters, as before.

    A WINDOW DATES A FACT THE WAY THE WHOLE DOCUMENT WOULD. research/text-date.js reads three
    things, and the window keeps all three as they stand in the document:
      - the page's stamp, from the first TOP_OF_PAGE characters: the head runs at least to the end
        of the line that holds that character, so the window's top IS the document's top;
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
    heads, dates, bounds = sections(text, units, paragraphs_if_unbroken=True)

    def start_of(k):
        return 0 if k == 0 else units[k][0]

    def end_of(k):
        return units[k][0] if k < len(units) else len(text)

    spans = [(s, e, start_of(s), end_of(e)) for s, e in zip(bounds, bounds[1:])]
    named = [sp for sp in spans if _names_water(text[sp[2]:sp[3]], terms)]
    named_spans = [(a, b) for _, _, a, b in named]
    info["named_first_cut"] = _overlap([(0, limit)], named_spans)
    past_head = [sp for sp in named if sp[0] > 0]
    info["sections_named"] = len(named)
    if not past_head:
        return first_cut("no section past its head names the water")
    if all(b <= limit for _, _, _, b in past_head):
        return first_cut("every section that names the water is inside the first cut")

    # THE HEAD: the text before the first section break, where the page stamp and title sit, and
    # at least the top of the page text-date.js reads a stamp from.
    first_break = units[bounds[1]][0] if len(bounds) > 2 else len(text)
    nl = text.find("\n", TOP_OF_PAGE)
    head_end = max(first_break, len(text) if nl < 0 else nl)
    if head_end >= limit:
        return first_cut("its head fills the cut")
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
        pieces = [units[max(m for m in marks if m <= s)] for marks in (heads, dates)
                  if any(m <= s for m in marks)]
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
    info.update(windowed=True, why="sent as a window", sent=len(sent),
                named_sent=_overlap(_merge(text, keep), named_spans))
    return sent, info
