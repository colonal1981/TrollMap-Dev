"""report_text.py -- what a report's own words say, read the same way for every source and every water: the depths it
states, how the fish were caught, the lures and the bait, the time of day, the kinds of water, and sentence by sentence
where in the water it puts the fish, which lures it names, and which of them it trolls (his way).

Ryan, 11/6: "I am a fisherman... i am not a striper fisherman... I troll... if that means i catch stripers great, if that
means i catch largemouth still great... same with catfish or crappie". So the lures are read for every fish, trolling
is any trolling (long-lining crappie jigs, pulling crankbaits, spider rigs, trout spoons), and bait is kept apart from
the lures: "the one thing i am not going to do... is live bait in freshwater on my kayak". A bait report still says
where the fish were and how deep; it is the lure that is struck, not the report.

Personal use only, not for distribution or resale; not for navigation.

One copy of each rule. parse_reports.py and build_reports.py both read these; before 11/5 the depth and method rules
lived in parse_reports.py and the sentence rules in build_reports.py.
"""
import re

# "35-45 ft", "35 to 45 feet", and the magazine's "8- to 12-foot depth range" (the first number's hyphen left hanging)
DEPTH = re.compile(r'(\d{1,3})(?:\s*(?:[-–—]\s*to|-|–|—|to)\s*(\d{1,3}))?\+?\s*(?:-\s*)?(feet|foot|ft\b)', re.I)

def depths(text):
    """Every depth stated, read as water depth ("in 35-45 ft"), fish depth ("at 20 feet", "suspended") or unclear."""
    out = []
    for m in DEPTH.finditer(text):
        a, b = int(m.group(1)), int(m.group(2)) if m.group(2) else None
        after = text[m.end():m.end() + 25].lower()
        before = text[max(0, m.start() - 40):m.start()].lower()
        # "the middle of the water column in 15-30 feet" is where the fish are, not the water under them
        kind = ('fish' if re.search(r'(column|down|suspended)\s+(?:in|at|around)?\s*$', before)
                else 'water' if re.match(r'\s*(of water|deep\b|of depth)', after) or re.search(r'\bin\s*$', before)
                else 'fish' if re.search(r'(suspend|down\s*$|at\s*$|around\s*$|holding)', before)
                or re.match(r'\s*down\b', after) else 'unclear')
        out.append({'ft': [a, b] if b else [a], 'kind': kind,
                    'words': text[max(0, m.start() - 50):m.end() + 30].replace('\n', ' ')})
    return out

# Trolling is any trolling, every fish: "long-lining" and "spider rigs" are how crappie are trolled, and "pulling
# crankbaits" is trolling them. "pulling" alone is not ("pulling them off the bank").
TROLLING = (r'\btroll|long-?lin(?:e|es|ed|ing|ers?)\b|spider[- ]?rig|'
            r'\bpull(?:s|ed|ing)?\s+(?:\w+\s+){0,2}(?:crank|plug|jig|spoon|lure|bait|grub|swimbait|rig)')
METHODS = [('trolling', TROLLING), ('umbrella rig', r'umbrella|a-rig|alabama rig'),
           ('planer board', r'planer'), ('live bait', r'live (bait|herring|shad|blueback)|free-?lin'),
           ('down-rod', r'down-?rods?|downlin'), ('cut bait', r'cut bait|cut herring|cut shad'),
           ('casting', r'\bcast(ing)?\b|crankbait|bucktail|topwater|top water'), ('jigging', r'\bjig')]

def methods(text):
    t = text.lower()
    return [k for k, rx in METHODS if re.search(rx, t)]

KINDS_OF_WATER = [('humps', r'\bhumps?\b|\bhills?\b|high spots?'), ('flats', r'\bflats?\b'),
                  ('creek channels', r'creek channels?|\bcreeks?\b'),
                  ('river / main channel', r'river channel|main (lake )?channel|old river|channel edge|the channel'),
                  ('deep water near the dam', r'(deep water|deep).{0,40}(dam|pinopolis)|(dam|pinopolis).{0,40}deep'),
                  ('open water', r'open water|main lake|out in the lake'), ('points', r'\bpoints?\b'),
                  ('trees / timber', r'\btrees?\b|timber|stumps?'),
                  ('schooling / birds', r'school(ing)? (fish|striper)|on top|birds|gulls|busting')]

def kinds_of_water(text):
    t = text.lower()
    return [k for k, rx in KINDS_OF_WATER if re.search(rx, t)]

SENT = re.compile(r'(?<=[.!?])(?=\s*[A-Z])')
FT = re.compile(r'(\d{1,2})(?:\s*(?:-\s*to|-|to)\s*(\d{1,2}))?(?:\s*plus)?\s*(?:-|\s)?(?:feet|foot|ft\b|\')', re.I)
POS = [('bottom', r'on the bottom|close to the bottom|near the bottom|flat on the bottom|stacked up on the bottom|'
                  r'off the bottom|along the bottom|hugging the bottom|bottom-hugging'),
       ('suspended', r'suspend|middle of (?:the )?water column|higher? in the water column|above the (?:fish|school)|'
                     r'variety of depths|throughout the water column'),
       ('top', r'schooling|busting|on top\b(?! of)|surface|topwater|top water|birds? (?:diving|working)|diving birds')]
# Not where the fish are: "morning surface water temperatures are in the low 60s" (AHQ opens every week with it), and
# a "suspending jerkbait" is a lure.
NOT_POSITION = re.compile(r'surface (?:water )?temp\w*|surface temperatures?|water surface temp\w*|'
                          r'suspending (?:jerk ?baits?|stick ?baits?|minnows?|baits?|plugs?|lures?)', re.I)
ARIG = re.compile(r'umbrella|a-rigs?\b|alabama rigs?', re.I)
TROLL = re.compile(TROLLING, re.I)


# ---- lures, bait and the time of day (11/6) -------------------------------------------------------------------------
# A family a report names, by its words. Earlier families claim their words first, so "deep-diving crankbaits" is a deep
# crankbait and not a crankbait as well, and "topwater plugs" is topwater. The names are report_contract.LURES.
_SOFT_WORM = (r"(?:trick|finesse|ribbon[- ]?tail|curly[- ]?tail|straight[- ]?tail|stick|magnum|floating|speed|monster|"
              r"u-?tail|zoom|shaky ?head|plastic|soft|texas[- ]rigged|wacky[- ]rigged|power|culprit|ol'? ?monster)\s+worms?")
LURE_WORDS = [
    ('A-rig', r'umbrella[- ]?rigs?|\ba-rigs?\b|\barigs?\b|alabama[- ]rigs?|yumbrellas?'),
    ('square bill', r'square[- ]?bills?(?:\s+crank ?baits?)?'),
    ('deep crankbait', r'(?:deep[- ]?(?:diving|divers?|running|runners?)|\bdd ?\d\d\b|\b\d{1,2}xd\b|stretch[ -]?\d\ds?)'
                       r'(?:\s+(?:crank ?baits?|cranks|plugs?|lures?|baits?))?|deep crank ?baits?|deep cranks|deep plugs?'),
    ('lipless crankbait', r'lipless(?:\s+(?:crank ?baits?|cranks|baits?))?|rat-?l-?traps?|rattle ?traps?|red eye shads?|rattle ?baits?'),
    ('topwater', r"top ?water(?:\s+(?:plugs?|baits?|lures?|poppers?))?|poppers?\b|pop-?r'?s?\b|chug ?bugs?|buzz ?baits?|"
                 r"walking baits?|walk(?:ing)?[- ]the[- ]dog|zara spooks?|\bspooks?\b|sammys?\b|prop ?baits?|"
                 r"(?:whopper )?plopp?ers?\b|wake ?baits?|\bfrogs?\b|devil'?s horse|jitterbugs?|popping plugs?|chuggers?|"
                 r"surface (?:plugs?|lures?|baits?)"),
    ('jerkbait', r'jerk ?baits?|husky jerks?|\brogues?\b|vision (?:110|onet)|suspending (?:stick ?baits?|minnows?|baits?)|'
                 r'(?:floating|jointed|rapala|swimming|countdown) minnows?|minnow (?:plugs?|baits?|lures?)|twitch ?baits?|\bx-?raps?\b'),
    # "Bandit" and "Norman" only as the lure ("Bandit 200 series", "Norman's DD22"), not "the last speckled bandit"
    # or "Norman, Okla."; "spoon billed Rebels" is a crankbait, not a spoon; a Rebel Pop-R is topwater.
    ('crankbait', r"crank ?baits?|\bcranks\b|shad raps?|bandit (?:\d{3}|crank\w*|series|plugs?)|\bplugs?\b|\bbombers?\b|"
                  r"\brebels?\b(?!\s+pop)|wiggle warts?|\bwarts?\b|norman'?s?\s+(?:dd|crank|deep)\w*|"
                  r"spoon[- ]?bill(?:ed)?(?:\s+\w+)?"),
    ('bladed jig', r'chatter ?baits?|bladed (?:swim )?jigs?|vibrating jigs?'),
    ('spinnerbait', r'spinner ?baits?|spinner-baits?|beetle ?spins?'),
    ('underspin', r'underspins?|spot chokers?|fish head spins?'),
    ('swimbait', r'swim ?baits?|paddle ?tails?|sea shads?|\bkeitechs?\b|swim (?:shad|minnow)s?|boot ?tails?'),
    ('blade bait', r'blade baits?|silver buddys?|silver buddies|\bbinsky'),
    ('spoon', r'(?:jigging |flutter |casting |trolling )?spoons?\b|\bhopkins\b|kastmasters?'),
    ('inline spinner', r'in-?line spinners?|rooster ?tails?|\bmepps\b|panther martins?|dura-?spins?'),
    ('bucktail', r'bucktails?|hair jigs?'),
    ('soft plastic', _SOFT_WORM + r'|soft plastics?|plastic (?:lizards?|baits?|craws?|grubs?|frogs?)|shaky ?heads?|'
                     r'texas[- ]rig\w*|carolina[- ]rig\w*|ned[- ]?rigs?|drop[- ]?shot\w*|wacky[- ]rig\w*|senkos?|\bflukes?\b|'
                     r'\blizards?\b|creature baits?|\btubes?\b|\bgrubs?\b|soft jerk ?baits?|craw (?:trailers?|baits?)|'
                     r'\bzoom\b|\bbrush ?hogs?\b|speed craws?'),
    ('jig', r'\bjigs?\b|jig-?(?:and|n)-?(?:pig|craw|trailer)s?|football jigs?|swim jigs?|flipping jigs?|crappie jigs?|'
            r'marabou(?: jigs?)?|tube jigs?|jiffy jigs?|road ?runners?|jig ?heads?|hal-?flys?|\bjigged\b'),
]
LURE_RX = [(k, re.compile(v, re.I)) for k, v in LURE_WORDS]
BAIT_FAMILIES = ['live bait', 'cut bait', 'prepared bait']
_LIVE = re.compile(r'live (?:bait|herring|shad|bluebacks?|minnows?|shiners?|bream|bluegills?|perch|crawfish|worms?|'
                   r'nightcrawlers?|eels?)|\bminnows?\b|\bshiners?\b|night ?crawlers?|crickets?|red wigglers?|wax ?worms?|'
                   r'meal ?worms?|grass shrimp|free-?lin\w*|down-?lin\w*|down-?rods?|'
                   r'(?:herring|bluebacks?|shad|shiners?|bream)\s+(?:on|under|fished|free-?lined|pulled)\b|'
                   r'(?:using|with|on|fishing|baited with)\s+(?:herring|bluebacks?|shad|shiners?)\b', re.I)
_CUT = re.compile(r'cut (?:bait|herring|shad|bream|perch|eels?|mullet|bluegills?|skipjack)|cut[- ]bait|'
                  r'(?:strips|pieces|chunks|fillets|bits) of (?:herring|shad|bream|perch|eel)|chunk(?:ed|ing)? (?:herring|shad)|'
                  r'(?:fresh|dead|frozen) (?:herring|shad|bait)', re.I)
_PREP = re.compile(r'chicken livers?|stink ?baits?|dip ?baits?|punch ?baits?|hot ?dogs?|dough ?balls?|catfish nuggets?|'
                   r'\bshrimp\b|\bcheese\b', re.I)
# A bare "worm" is a plastic worm in a bass report and a live one in a bream or catfish report.
_BARE_WORM = re.compile(r'\bworms?\b', re.I)
_BASS = {'black bass', 'largemouth bass', 'spotted bass', 'smallmouth bass'}
# The word before "minnow" that makes it a lure (a Rapala minnow is a jerkbait, minnows are bait).
_MINNOW_LURE = re.compile(r'(?:floating|jointed|rapala|swimming|countdown|suspending|shad)\s+$', re.I)
TIMES = [('first light', r'first light|daybreak|day break|\bdawn\b|sunrise|sun-?up|at daylight|before daylight|'
                         r'early (?:in the )?mornings?|early-?mornings?|pre-?dawn|before the sun|until the sun (?:gets|comes) up'),
         ('morning', r'\bmornings?\b(?!\s+(?:surface\s+)?(?:water\s+)?temp)|mid-?morning'),
         ('midday', r'mid-?day|middle of the day|\bnoon\b|heat of the day'),
         ('afternoon', r'\bafternoons?\b|mid-?afternoon'),
         ('evening', r'\bevenings?\b|\bdusk\b|sunset|sundown|last light|late in the (?:day|evening)|until dark|before dark|'
                     r'twilight|late afternoon'),
         # "cool nights" is the weather, not when to fish
         ('night', r'(?<!cool )(?<!cold )(?<!warm )(?<!cooler )(?<!colder )(?<!warmer )(?<!chilly )\bnights?\b(?!\s*crawl)|after dark|\bat dark\b|night-?time|under (?:the )?lights|lighted docks?|'
                   r'green lights?|night fishing')]
TIME_RX = [(k, re.compile(v, re.I)) for k, v in TIMES]


def _claim(text, pairs):
    """Each (name, rx) in order claims its matches; a later name's match that overlaps one already claimed is not
    counted. Returns [(name, start, end)] in the order the names are listed."""
    taken, out = [], []
    for name, rx in pairs:
        for m in rx.finditer(text):
            if any(m.start() < b and a < m.end() for a, b in taken): continue
            taken.append((m.start(), m.end())); out.append((name, m.start(), m.end()))
    return out


def _bait_spans(text, species=()):
    out = []
    for name, rx in (('live bait', _LIVE), ('cut bait', _CUT), ('prepared bait', _PREP)):
        for m in rx.finditer(text):
            if name == 'live bait' and m.group(0).lower().startswith('minnow') and _MINNOW_LURE.search(text[:m.start()]):
                continue
            if name == 'live bait' and re.match(r'minnows?\s+(?:plugs?|baits?|lures?)', text[m.start():], re.I):
                continue
            out.append((name, m.start(), m.end()))
    sp = set(species or ())
    if sp and not (sp & _BASS):
        out += [('live bait', m.start(), m.end()) for m in _BARE_WORM.finditer(text)
                if not re.search(_SOFT_WORM + r'\s*$', text[:m.end()], re.I)]
    return out


def lures(text, species=()):
    """The lure families a report names, in report_contract.LURES order. A Carolina rig in a sentence that names bait
    is a bait rig ("Carolina rigs with live herring"), not a plastic."""
    found = set()
    for x in SENT.split(text):
        bait_here = bool(_bait_spans(x, species))
        for name, a, b in _claim(x, LURE_RX):
            if name == 'soft plastic' and bait_here and re.match(r'carolina', x[a:b], re.I): continue
            found.add(name)
        sp = set(species or ())
        if sp and sp <= _BASS:                                    # a bare "worm" in a bass report is a plastic one
            if any(not re.search(_SOFT_WORM + r'\s*$', x[:m.end()], re.I) for m in _BARE_WORM.finditer(x)):
                found.add('soft plastic')
    return [k for k, _ in LURE_WORDS if k in found]


def bait(text, species=()):
    """Bait the report fishes: live, cut, or prepared. Never his on fresh water; the report still says where and how deep."""
    found = {n for n, _, _ in _bait_spans(text, species)}
    return [k for k in BAIT_FAMILIES if k in found]


def times(text):
    found = {n for n, _, _ in _claim(text, TIME_RX)}
    return [k for k, _ in TIMES if k in found]


def sentences(text, species=()):
    """The sentences that put the fish on the bottom, suspended or on top, or that name a lure. Each says where in the
    water (`fish`), the lures it names, the ones it trolls (`his_way`; an A-rig always counts), the time of day, and
    the depths in it."""
    out = []
    for x in SENT.split(text):
        clean = NOT_POSITION.sub(' ', x)
        pos = [k for k, rx in POS if re.search(rx, clean, re.I)]
        named = lures(x, species)
        trolled = bool(TROLL.search(x))
        way = [k for k in named if k == 'A-rig' or trolled]
        if pos or named:
            out.append({'said': x.strip(), 'fish': pos, 'lures': named, 'his_way': way, 'time': times(x),
                        'ft': [[int(a), int(b or a)] for a, b in FT.findall(x)]})
    return out
