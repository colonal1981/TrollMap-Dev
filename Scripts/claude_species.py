#!/usr/bin/env python3
r"""claude_species.py -- the species answers written by Claude from the documents Gemini fetched.

Personal use only, not for distribution or resale; not for navigation.

WHY THIS EXISTS. Ryan, 2026-09-24, after reading the Lake Murray comparison: "i am not opposed to
just letting you do all of the actual json building from the docs... you building the actual
research profiles after gemini is done makes the most sense". Measured on Murray the same day
(THE_ANSWERS_WERE_IN_THE_MATERIAL_AND_THE_SPECIES_STEP_READ_THE_FIRST_TWELVE_2026-09-24.md): the
stored Lite answer had 23 entries, 7 whose quote was missing or appears in no document and 16 whose
depth is not in its own quote, while the dated guide reports that answer most of it were in the
corpus and never reached the step that writes the answer.

WHAT GEMINI STILL DOES. Discovery, download, the off-lake gate, fact extraction and the Lite species
groups all run exactly as before and save exactly as before. This runs AFTER that, on what the run
stored, and replaces only `trollingIntelligence`. If Claude is unavailable -- a usage limit, a
timeout, an answer that fails the checks -- the Lite answer the run already saved stays.

HOW.
  1. build_packet(): every stored document, cut to the sentences that talk about fish doing
     something (a fish word and a depth, method, place, season or temperature cue), each with one
     sentence of context either side, plus the headings and date lines above them so a weekly
     report's entries keep their dates and a multi-lake article keeps its lake headings. A
     document whose title and address do not name this water keeps only the sections that do.
     Nothing is paraphrased: every kept span is a verbatim slice of the stored text.
  2. One `claude -p` call on Ryan's subscription, no tools, no session saved, no CLAUDE.md, the
     answer constrained by a JSON schema built from this water's roster.
  3. check_section(): every entry must quote the stored corpus verbatim and every depth number
     must appear in its own quote. An entry that fails is dropped to null and named in the report
     -- the same checks the Murray comparison ran on both answers.

Nothing here writes to the profile. research_lakes.species_groups_only() writes the report beside
the stored answer and saves only on --save, as it does for the Gemini models.
"""
import json
import os
import re
import shutil
import subprocess
import tempfile
import time

SEASONS = ("spring", "summer", "fall", "winter")
ENTRY_KEYS = ("preferredDepth", "holding", "waterDepthFt", "sourceQuote", "structures", "forage",
              "recommendedPresentations", "notes")
HOLDING = ("bottom", "suspended", "both")

# WHICH CLAUDE. "opus" and "sonnet" are the CLI's own aliases for the latest of each; --claude-model
# passes straight through.
#
# SONNET, FROM ONE MEASUREMENT. Lake Murray, 2026-09-24 -- the biggest corpus in the set, 46
# documents, 2.9M characters, packet 345K: claude-sonnet-5 answered in 318 s on 139K tokens in and
# 38K out, and all 30 entries it wrote passed the checks with none dropped. Against the answer
# written by hand from the same corpus it agreed season for season on every striper, crappie and
# catfish entry but three, and each of those three picked a different dated report from the same
# page. It also labelled every template-page entry as one. Ryan is close to his weekly limit and
# not his session limit, so the lighter model is the default until a water shows it is not enough.
DEFAULT_MODEL = "sonnet"

# A DEADLINE FOR A HUNG PROCESS, NOT A TUNING KNOB. The call's measured duration goes in the report;
# this only has to be longer than any answer that is going to arrive.
CLAUDE_TIMEOUT = 1800

# A usage limit is not per water: once the subscription says no, every later water in the batch
# would spend a process start to hear it again. The first refusal stops Claude for the rest of the
# run, and the Lite answers those waters already saved are what they keep.
_LIMIT_WORDS = re.compile(r"usage limit|rate limit|limit reached|quota|too many requests|\b429\b|"
                          r"credit balance|weekly limit|session limit", re.I)
_stopped = {"why": None}


def claude_exe():
    """The CLI, wherever this machine has it. TROLLMAP_CLAUDE_EXE wins; then PATH; then the
    installer's default (it does not add itself to PATH on Windows -- it said so on install)."""
    for c in (os.environ.get("TROLLMAP_CLAUDE_EXE"), shutil.which("claude"),
              os.path.expanduser(os.path.join("~", ".local", "bin", "claude.exe")),
              os.path.expanduser(os.path.join("~", ".local", "bin", "claude"))):
        if c and os.path.isfile(c):
            return c
    return None


# ── THE PACKET ─────────────────────────────────────────────────────────────────────────────────

def norm(s):
    """What 'verbatim' means to the checks: markdown bold, curly quotes, dash kinds, whitespace and
    case do not count; every other character does."""
    s = str(s or "").replace("**", "")
    s = (s.replace("’", "'").replace("‘", "'").replace("“", '"')
          .replace("”", '"').replace("–", "-").replace("—", "-"))
    # A PDF line wrap after a hyphen is not a space: the survey's "30-\n59 feet" is "30-59 feet"
    # to anyone reading it, and "down-\nlining" is "down-lining".
    s = re.sub(r"-[ \t]*\n\s*", "-", s)
    s = re.sub(r"(?<=\d)-\s+(?=\d)", "-", s)
    return re.sub(r"\s+", " ", s).strip().lower()


# A FISH WORD AND A BEHAVIOUR CUE, BOTH, OR THE SENTENCE IS NOT ABOUT WHERE FISH ARE OR HOW THEY
# ARE CAUGHT. The first cut also took season, month and place words as cues and kept 77,000
# characters of the Murray FERC licence -- its acronym list ("Fish and Wildlife Service ... degrees
# Celsius ... cubic feet per second"), fishway prescriptions and dock permits. The season comes
# from the date lines kept above each passage, not from the sentence.
_FISH_GENERIC = (r"fish(?:ing|ed|es|ermen|erman)?|angler\w*|bass|striper\w*|crappie|specks?|"
                 r"smallies|smallie|largemouths?|smallmouths?|spots\b|redeyes?|shoal bass|"
                 r"catfish|cats|bream|panfish|bluegill\w*|shellcracker\w*|redear|perch|hybrid\w*|"
                 r"trout|walleye|sauger|musk\w*|pickerel|pike|bite|biting")
_CUE = re.compile(
    r"\d\s*(?:-|to|–)\s*\d+\s*(?:feet|foot|ft)\b|\d+\s*(?:feet|foot|ft)\s+(?:of water|deep|down)"
    r"|feet of water|feet down|foot (?:range|depths?)|"
    r"troll\w*|drift(?:s|ed|ing)?\b|anchor(?:ed|ing)\b|down-?rods?|down-?lin\w*|free-?lin\w*|"
    r"planer\w*|long-?lin\w*|spider[- ]rig\w*|tight-?lin\w*|jig(?:s|ging|head\w*)?\b|spoons?\b|"
    r"crankbait\w*|swimbait\w*|top-?water|buzzbait\w*|live bait|cut bait|dip bait|minnows?\b|"
    r"herring|\bshad\b|lures?\b|"
    r"suspend\w*|water column|(?:on|near|off|along) the bottom|school(?:s|ed|ing)\b|shallow\w*|"
    r"deep(?:er|est)? water|"
    r"brush ?piles?|brush\b|docks?\b|bridges?\b|ledges?\b|humps?\b|rip-?rap|timber|grass|"
    r"cane piles?|attractors?|drop-?offs?|points?\b|creek mouths?|flats\b|"
    r"thermocline|refuge|\d+\s*(?:degrees|°)|"
    # RIVER WORDS. The first cut was written from lake reports and kept nothing of "Shoals block off
    # the river at least every half mile" or "a haven for eating sized channel catfish" on the
    # Broad River, 2026-09-25 -- a river is fished by current, shoal, hole and bend, not by depth.
    r"shoals?\b|current|eddy|eddies|seams?\b|riffles?|rapids|runs?\b|pools?\b|holes?\b|bends?\b|"
    r"log ?jams?|laydowns?|snags?|undercut|banks?\b|tail ?race|tail ?water|below the dam|"
    r"spillway|flows?\b|cfs\b|releases?\b|tides?\b|tidal|slack|creek mouths?|sloughs?|oxbows?|"
    r"float(?:ing)?\b|wad(?:e|ing)\b|kayak\w*|canoe\w*|haven|plenty of|good numbers|"
    r"\d+\s*(?:-|to)\s*\d+\s*(?:pounds?|lbs?|inch\w*)", re.I)
_MONTH = (r"(?:January|February|March|April|May|June|July|August|September|October|November|"
          r"December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?")
_DATE_LINE = re.compile(rf"^\W*(?:{_MONTH}\s+\d{{1,2}}(?:,?\s+\d{{4}})?|\d{{1,2}}\s+{_MONTH},?\s+\d{{4}}|"
                        r"\d{4}-\d{2}-\d{2})\W*$", re.I)
_DATE_ANY = re.compile(rf"(?:{_MONTH}\s+\d{{1,2}},?\s+\d{{4}}|\d{{1,2}}\s+{_MONTH},?\s+\d{{4}}|"
                       r"\b\d{4}-\d{2}-\d{2}\b|(?:Published|Updated)[:\s*]+[A-Za-z]{3,9}\.? \d{1,2},? \d{4})",
                       re.I)


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


def doc_spans(text, fish, terms, doc_names_water):
    """The kept slices of one document, verbatim, in order. Returns [(start, end)]."""
    units = _units(text)
    if not units:
        return []
    heads = [i for i, (a, b) in enumerate(units) if _is_heading(text[a:b])]
    dates = [i for i, (a, b) in enumerate(units) if _DATE_LINE.match(text[a:b].strip())]
    # A section runs from one heading or date line to the next. A document that does not name this
    # water in its title or address keeps only the sections that name it -- a statewide report is
    # about every lake it covers, and the Hartwell half of a two-lake article is not this water's.
    # DATE LINES ARE SECTION BREAKS TOO: a weekly report page has one heading and twenty dated
    # entries, and on 2026-09-25 the Clarks Hill AHQ page went whole (40,740 characters) into the
    # Broad River's packet because one entry mentioned the Broad River arm.
    bounds = sorted({0, len(units), *[h for h in heads if h > 0], *[d for d in dates if d > 0]})
    in_scope = [False] * len(units)
    for s, e in zip(bounds, bounds[1:]):
        ok = doc_names_water or _names_water(text[units[s][0]:units[e - 1][1]], terms)
        for i in range(s, e):
            in_scope[i] = ok
    keep = set()
    for i, (a, b) in enumerate(units):
        s = text[a:b]
        if in_scope[i] and fish.search(s) and _CUE.search(s):
            keep.update(j for j in (i - 1, i, i + 1) if 0 <= j < len(units) and in_scope[j])
            # The nearest heading and the nearest date line above a kept sentence travel with it:
            # "October 30" over a guide's paragraph is the only place that paragraph's date is.
            for marks in (heads, dates):
                above = [m for m in marks if m < i]
                if above:
                    keep.add(above[-1])
    spans = []
    for i in sorted(keep):
        a, b = units[i]
        if spans and i - 1 in keep and spans[-1][2] == i - 1:
            spans[-1] = (spans[-1][0], b, i)
        else:
            spans.append((a, b, i))
    return [(a, b) for a, b, _ in spans]


def fish_pattern(roster):
    """A fish word: the generic ones, each roster name whole, and the NOUN of each name -- the last
    word of every part ("Catfish" of "Channel Catfish", "Shellcracker" of "Redear Sunfish
    (Shellcracker)"). Not every word: "Channel", "Blue", "White" and "Black" are how a hydrology
    report talks about everything else, and a sentence about the river channel is not about fish."""
    words = set()
    for sp in roster or []:
        for part in re.split(r"[/()]", sp):
            part = part.strip()
            ws = re.findall(r"[A-Za-z]{4,}", part)
            if ws:
                words.add(re.escape(ws[-1]))
                words.add(r"\s+".join(re.escape(w) for w in part.split()))
    extra = ("|" + "|".join(sorted(words))) if words else ""
    return re.compile(r"\b(?:" + _FISH_GENERIC + extra + r")\b", re.I)


def water_kind(name):
    """'river' for a river, creek, canal or tailrace by its own name, else 'lake'. The app's names
    say it: "Broad River, SC", "Chessie Creek, SC", "Diversion Canal (Berkeley Co, SC)", "Tail Race
    Canal, SC". A reservoir named for its creek ("Fishing Creek Reservoir") is a lake."""
    n = re.sub(r"\s*\([^)]*\)", "", str(name or ""))
    if re.search(r"\b(reservoir|lake|pond)\b", n, re.I):
        return "lake"
    return "river" if re.search(r"\b(river|creek|canal|tail ?race)\b", n, re.I) else "lake"


def packet_facts(profile):
    """What the app already knows about the water, from the profile, in a few lines."""
    bio = profile.get("biology") or {}
    lim = profile.get("limnology") or {}
    lines = []
    pf = bio.get("primaryForage")
    sf = bio.get("secondaryForage")
    if pf or sf:
        lines.append(f"FORAGE ON RECORD: primary {pf or '-'}; secondary {sf or '-'}")
    th = (lim.get("thermocline") or {}).get("summerDepthFt")
    ox = (lim.get("oxygen") or {}).get("anoxicBelowFt")
    sw = lim.get("surfaceWater") or {}
    wc = lim.get("waterClarity") or {}
    bits = []
    if th is not None:
        bits.append(f"summer thermocline {th} ft")
    if ox is not None:
        bits.append(f"low oxygen below {ox} ft")
    if wc.get("secchiFt") is not None:
        bits.append(f"clarity {wc.get('secchiFt')} ft ({wc.get('note') or wc.get('typical') or ''})")
    if sw.get("recentTempF") is not None:
        bits.append(f"surface {sw['recentTempF']}°F on {sw.get('recentTempLastObserved')}")
    for k in ("surfaceAreaAcres", "maxDepthFt", "averageDepthFt"):
        if profile.get(k) is not None:
            bits.append(f"{k} {profile[k]}")
    if bits:
        lines.append("MEASURED / ON RECORD: " + "; ".join(bits))
    return lines


def build_packet(lake, state, profile, documents, roster, aliases=None, base=None, today=None):
    """(packet_text, stats). `documents` is the stored corpus in its own order."""
    base = base or lake
    terms = water_terms(lake, aliases, base)
    fish = fish_pattern(roster)
    head = [f"WATER: {lake} ({state})",
            f"KIND: {water_kind(lake)}",
            f"ALSO CALLED: {', '.join(t for t in terms if t.lower() != base.lower()) or '-'}",
            f"TODAY: {today or time.strftime('%Y-%m-%d')}",
            "SPECIES TO ANSWER (use these exact keys, all of them): " + json.dumps(roster),
            *packet_facts(profile), ""]
    parts, stats = [], {"documents": 0, "documents_with_text": 0, "chars_stored": 0,
                        "chars_kept": 0, "per_doc": []}
    for i, d in enumerate(documents or []):
        text = str(d.get("fullText") or d.get("text") or "")
        if len(text) < 200:
            continue
        stats["documents"] += 1
        stats["chars_stored"] += len(text)
        title, url = str(d.get("title") or ""), str(d.get("url") or "")
        named = _names_water(title + " " + url.replace("-", " ").replace("_", " "), terms)
        spans = doc_spans(text, fish, terms, named)
        kept = sum(b - a for a, b in spans)
        stats["per_doc"].append({"doc": i, "title": title[:80], "stored": len(text), "kept": kept})
        if not spans:
            continue
        stats["documents_with_text"] += 1
        stats["chars_kept"] += kept
        found = _DATE_ANY.search(text[:4000])
        body = "\n[...]\n".join(text[a:b].strip() for a, b in spans)
        parts.append(f"=== DOC {i}: {title} ===\nurl: {url}\n"
                     + (f"date near the top of the page: {found.group(0)}\n" if found else "")
                     + f"kept {kept:,} of {len(text):,} characters\n\n{body}\n")
    return "\n".join(head) + "\n" + "\n".join(parts), stats


# ── THE QUESTION ───────────────────────────────────────────────────────────────────────────────

RULES = """You are writing the species answers ("trollingIntelligence") for ONE water in a personal
kayak-trolling app. The packet after these rules holds every document the research run fetched for
this water, cut down to the passages that talk about fish, each under its own "=== DOC n ===" header,
and what the app already knows about the water. A program checks your answer against the stored
documents, so follow the QUOTE and NUMBER rules exactly.

WHAT TO RETURN. Every species in SPECIES TO ANSWER, keyed by exactly that name, with four seasons:
spring, summer, fall, winter. A season is null when nothing in the packet about THIS water covers
it; otherwise an object with exactly these keys:
  preferredDepth  [min, max] feet BELOW THE SURFACE where the fish are, or null
  holding         "bottom" | "suspended" | "both" | null
  waterDepthFt    [min, max] feet of WATER the pattern happens over, or null
  sourceQuote     the passage that supports the depth and holding, copied exactly
  structures      places and cover on this water the sources name (creeks, islands, bridges, brush)
  forage          what the sources say the fish are eating then
  recommendedPresentations  baits, lures and methods the sources name, in their words
  notes           see NOTES
A species with nothing in the packet gets four nulls. Never invent one to fill it.
Also return "coverage": two or three sentences saying which documents in the packet are about this
water, what they cover, and why the species or seasons you left null are null.

SEASONS ARE THE APP'S CALENDAR: spring Mar 20-Jun 20, summer Jun 21-Sep 21, fall Sep 22-Dec 20,
winter Dec 21-Mar 19. A dated report belongs to the season its date falls in. Many pages are a
series of dated entries; the date line above a passage is its date. When a report says the pattern
is still the previous season's (for example water still in the upper 70s in early October), you may
use it for that season and must say so in notes.
A first-hand account on this water that describes how and where a species is caught but gives no
season: put it under the season(s) its own words point to (water temperature, spawning, low summer
flow, cold water, a month). If nothing in it points to a season, put it under the season of the
page's date if it has one; if it has neither, put it under every season it does not contradict and
say in notes that the source names no season. Do not leave a species null because its best source
is undated -- null means the packet has nothing on it.

KIND (lake or river) is in the header. A RIVER is fished by current, shoals, holes, runs, eddies,
bends, banks, landings, tides and flow, not by depth bands. A river entry with null depths is a good
entry: say where (the stretch, shoal, bridge, landing, creek mouth), how (float, wade, anchor,
drift, cast to the bank, fish the hole below the shoal), and the flow, tide or water level the
source gives, in notes. waterDepthFt on a river is the depth of the hole or run when a source states
one. "holding" on a river: bottom for fish in holes, on the bottom or behind rocks; suspended for
fish chasing bait in the current or schooling.

WHICH SOURCES WIN.
1. Dated first-hand accounts ON THIS WATER beat everything else: guide and tournament-angler
   reports, a guide interview, an agency survey or report. When they disagree, prefer the newer and
   say so.
2. The weakest sources are pages that generate patterns from a template (every season and species
   reads alike, water temperatures and depth bands stamped into each), pages that say they are
   synthesized or AI-written, and guide-service sales pages. Use one only when nothing better covers
   that species and season, and then say in notes that it is the only source and what kind it is.
3. Only text about THIS water counts. Multi-lake articles, statewide reports and regional pages
   cover other waters too. For a LAKE, a passage about another lake, or about the river below its
   dam, is not about it. For a RIVER, this water is the river named in the header, in that state:
   a river of the same name somewhere else (another state's Black River, the Georgia Broad River),
   a different river, or a lake the river runs into or out of is not it. A passage about the river
   itself counts even when the page is mostly about something else.
4. General knowledge of the species is not a source. Do not fill a season from spawning biology,
   from another season or from another water. Measured values in the header (thermocline, oxygen,
   clarity) may be mentioned in notes; they are never the depth answer.
5. A report about a group ("catfish", "bream", "black bass") supports each member species on the
   list that the same reports say is being caught; say so in notes. A key that is itself a group
   name ("Catfish", "Crappie") takes the group's reports.

QUOTE AND NUMBERS -- an entry that breaks these is thrown away.
- sourceQuote is copied character for character from ONE place in the packet: a sentence or a run
  of consecutive text. Never join two pieces, never cross a "[...]" gap, never tidy the wording.
- Every number in preferredDepth and waterDepthFt must appear in sourceQuote. If the best passage
  has no number, both are null and the depth goes into notes in words.
- Never widen: "about 50 feet" is [50, 50]; "50-60 feet" is [50, 60].
- "in 20-25 feet of water" is the WATER. "15-18 feet down" is the FISH. A passage can give both.
  Fish on the bottom, on brush or on a ledge are at the water depth, so both arrays take it.
- Free-lines and unweighted planer boards run near the top over the stated water: suspended,
  preferredDepth null unless the bait depth is stated.

HOLDING. suspended: up in the water column (schooling, under birds, free-lines, "X feet down",
over the channel). bottom: on or within a few feet of the bottom (anchored cut bait, jigs on rock or
brush, "near the bottom", on the ledge). both: the sources describe two groups at once that season.
null when they do not say.

NOTES are what the angler reads. A few plain sentences: who said it and when (the source and its
date as the packet shows it); where on the water (named creeks, islands, bridges, arms, up or down
the lake); the other patterns the sources give for that season with their own depths; and anything
a TROLLER should know -- whether anyone trolls, pulls boards or free-lines, long-lines or pulls jigs
for this species that season, how deep and where. Say when sources disagree and which you followed.
Do not repeat the quote.

Return the structure only.
"""


def schema_for(roster):
    num2 = {"type": ["array", "null"], "items": {"type": "number"}, "minItems": 2, "maxItems": 2}
    strs = {"type": "array", "items": {"type": "string"}}
    season = {"type": ["object", "null"], "additionalProperties": False,
              "required": list(ENTRY_KEYS),
              "properties": {"preferredDepth": num2,
                             "holding": {"type": ["string", "null"], "enum": [*HOLDING, None]},
                             "waterDepthFt": num2,
                             "sourceQuote": {"type": ["string", "null"]},
                             "structures": strs, "forage": strs, "recommendedPresentations": strs,
                             "notes": {"type": ["string", "null"]}}}
    species = {"type": "object", "additionalProperties": False, "required": list(SEASONS),
               "properties": {s: {"$ref": "#/$defs/season"} for s in SEASONS}}
    return {"type": "object", "additionalProperties": False,
            "required": ["trollingIntelligence", "coverage"],
            "$defs": {"season": season, "species": species},
            "properties": {"coverage": {"type": "string"},
                           "trollingIntelligence": {
                "type": "object", "additionalProperties": False, "required": list(roster),
                "properties": {sp: {"$ref": "#/$defs/species"} for sp in roster}}}}


def ask_claude(packet, roster, model=DEFAULT_MODEL, timeout=CLAUDE_TIMEOUT, run=subprocess.run):
    """(section or None, meta). One call; `run` is injectable so the tests never start the CLI."""
    meta = {"model_asked": model}
    if _stopped["why"]:
        meta["error"] = f"Claude stopped for this run: {_stopped['why']}"
        return None, meta
    exe = claude_exe()
    if not exe:
        meta["error"] = ("claude CLI not found -- set TROLLMAP_CLAUDE_EXE, or install Claude Code "
                         "(it lands in ~/.local/bin)")
        return None, meta
    cmd = [exe, "-p", "Write the species answers for the water in the packet, following the rules "
                      "at its top.",
           "--output-format", "json", "--json-schema", json.dumps(schema_for(roster)),
           "--model", model, "--tools", "", "--no-session-persistence", "--strict-mcp-config",
           "--safe-mode", "--system-prompt",
           "You write research data for a personal fishing app. You answer only in the "
           "requested structure, from the documents you are given."]
    t0 = time.perf_counter()
    try:
        with tempfile.TemporaryDirectory() as cwd:     # no CLAUDE.md, no project settings
            p = run(cmd, input=RULES + "\n\n" + packet, capture_output=True, text=True,
                    encoding="utf-8", cwd=cwd, timeout=timeout)
    except subprocess.TimeoutExpired:
        meta["error"] = f"claude did not answer within {timeout} s"
        return None, meta
    meta["seconds"] = round(time.perf_counter() - t0, 1)
    try:
        out = json.loads(p.stdout or "")
    except json.JSONDecodeError:
        why = (p.stderr or p.stdout or "no output").strip()[:400]
        meta["error"] = f"claude exit {p.returncode}: {why}"
        if _LIMIT_WORDS.search(why):
            _stopped["why"] = why[:200]
        return None, meta
    usage = out.get("usage") or {}
    mu = out.get("modelUsage") or {}
    meta.update({"model": next(iter(mu), None),
                 "input_tokens": usage.get("input_tokens"),
                 "cache_creation_input_tokens": usage.get("cache_creation_input_tokens"),
                 "cache_read_input_tokens": usage.get("cache_read_input_tokens"),
                 "output_tokens": usage.get("output_tokens"),
                 # What the same call would cost at API list price. It is NOT what the subscription
                 # charges; it is the one number the CLI gives for "how big was that".
                 "api_list_price_usd": out.get("total_cost_usd"),
                 "api_seconds": round((out.get("duration_api_ms") or 0) / 1000, 1)})
    if out.get("is_error") or out.get("subtype") != "success":
        why = str(out.get("result") or out.get("subtype") or "error")[:400]
        meta["error"] = f"claude: {why}"
        if _LIMIT_WORDS.search(why):
            _stopped["why"] = why[:200]
        return None, meta
    got = out.get("structured_output")
    if not isinstance(got, dict):
        try:
            got = json.loads(out.get("result") or "")
        except json.JSONDecodeError:
            meta["error"] = "claude answered without the structure"
            return None, meta
    section = got.get("trollingIntelligence") if isinstance(got, dict) else None
    if isinstance(got, dict) and got.get("coverage"):
        meta["coverage"] = str(got["coverage"])[:2000]
    if not isinstance(section, dict):
        meta["error"] = "claude's answer has no trollingIntelligence"
        return None, meta
    return section, meta


# ── THE CHECKS ─────────────────────────────────────────────────────────────────────────────────

def _depth_ok(v):
    return v is None or (isinstance(v, list) and len(v) == 2
                         and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in v)
                         and 0 <= v[0] <= v[1])


def entry_problem(e, corpus_norm):
    """Why this season entry cannot be saved, or None. `corpus_norm` is [norm(text)] per document."""
    if not isinstance(e, dict):
        return "not an object"
    missing = [k for k in ENTRY_KEYS if k not in e]
    if missing:
        return "missing " + ", ".join(missing)
    if not _depth_ok(e.get("preferredDepth")) or not _depth_ok(e.get("waterDepthFt")):
        return "a depth is not [min, max]"
    if e.get("holding") not in (*HOLDING, None):
        return f"holding {e.get('holding')!r}"
    q = norm(e.get("sourceQuote"))
    if not q:
        return "no quote"
    if not any(q in t for t in corpus_norm):
        return "the quote is not in any stored document"
    for k in ("preferredDepth", "waterDepthFt"):
        for n in e.get(k) or []:
            if not re.search(rf"(?<![\d.]){n:g}(?![\d])", q):
                return f"{k} {n:g} is not in the quote"
    return None


def check_section(section, roster, documents):
    """(clean section, problems). Every roster species present; a failing entry becomes null."""
    corpus_norm = [norm(d.get("fullText") or d.get("text") or "") for d in documents or []]
    clean, problems = {}, []
    for sp in roster:
        got = (section or {}).get(sp)
        if not isinstance(got, dict):
            problems.append(f"{sp}: not answered -- four nulls")
            got = {}
        clean[sp] = {}
        for se in SEASONS:
            e = got.get(se)
            if e is None:
                clean[sp][se] = None
                continue
            why = entry_problem(e, corpus_norm)
            if why:
                problems.append(f"{sp} {se}: {why} -- dropped")
                clean[sp][se] = None
            else:
                clean[sp][se] = {k: e[k] for k in ENTRY_KEYS}
    for k in (section or {}):
        if k not in roster:
            problems.append(f"{k}: not on the roster -- dropped")
    return clean, problems


def roster_for(profile):
    """The species to answer: the keys the last run's section carries -- the Worker has already
    merged names for one fish into them (Black and White Crappie into Crappie) -- else the
    confirmed list. Recomputing that merge here would be a second copy of a rule agents.js owns."""
    ti = profile.get("trollingIntelligence") or {}
    keys = [k for k in ti if k != "sources"]
    if keys:
        return keys, "the stored section's species"
    bio = profile.get("biology") or {}
    return list(bio.get("predatorSpecies") or []), "biology.predatorSpecies"


def answer(lake, state, profile, documents, aliases=None, base=None, model=DEFAULT_MODEL,
           run=subprocess.run):
    """(clean section or None, meta). The whole step on one water's stored profile and corpus."""
    roster, roster_from = roster_for(profile)
    meta = {"roster": roster, "roster_from": roster_from}
    if not roster:
        meta["error"] = "no species roster on the profile -- run the full research first"
        return None, meta
    packet, stats = build_packet(lake, state, profile, documents, roster, aliases, base)
    meta["packet_chars"] = len(packet)
    meta["packet"] = {k: v for k, v in stats.items() if k != "per_doc"}
    meta["packet_docs"] = stats["per_doc"]
    section, m = ask_claude(packet, roster, model=model, run=run)
    meta.update(m)
    if section is None:
        return None, meta
    # KEPT AS ANSWERED, beside the checked copy, so an entry the checks dropped can be read and the
    # check argued with -- a rule that throws things away must show what it threw.
    meta["raw_section"] = section
    clean, problems = check_section(section, roster, documents)
    meta["problems"] = problems
    meta["entries"] = sum(1 for sp in clean.values() for e in sp.values() if e)
    meta["entries_dropped"] = sum(1 for p in problems if p.endswith("-- dropped"))
    if not meta["entries"]:
        meta["error"] = "no entry survived the checks"
        return None, meta
    return clean, meta
