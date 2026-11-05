"""report_text.py -- what a report's own words say, read the same way for every source and every water: the depths it
states, how the fish were caught, the kinds of water, and sentence by sentence where in the water it puts the fish
and whether it is his way of fishing (trolled A-rigs or crankbaits).

Personal use only, not for distribution or resale; not for navigation.

One copy of each rule. parse_reports.py and build_reports.py both read these; before 11/5 the depth and method rules
lived in parse_reports.py and the sentence rules in build_reports.py.
"""
import re

DEPTH = re.compile(r'(\d{1,3})(?:\s*(?:-|–|—|to)\s*(\d{1,3}))?\+?\s*(?:-\s*)?(feet|foot|ft\b)', re.I)

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

METHODS = [('trolling', r'\btroll'), ('umbrella rig', r'umbrella|a-rig|alabama rig'),
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
FT = re.compile(r'(\d{1,2})(?:\s*(?:-|to)\s*(\d{1,2}))?(?:\s*plus)?\s*(?:-|\s)?(?:feet|foot|ft\b|\')', re.I)
POS = [('bottom', r'on the bottom|close to the bottom|near the bottom|flat on the bottom|stacked up on the bottom|'
                  r'off the bottom|along the bottom|hugging the bottom|bottom-hugging'),
       ('suspended', r'suspend|middle of (?:the )?water column|higher? in the water column|above the (?:fish|school)|'
                     r'variety of depths|throughout the water column'),
       ('top', r'schooling|busting|on top\b(?! of)|surface|topwater|top water|birds? (?:diving|working)|diving birds')]
ARIG = re.compile(r'umbrella|a-rigs?\b|alabama rigs?', re.I)
CRANK = re.compile(r'crank ?baits?|deep[- ](?:div|runn)\w*|stretch[ -]?\d+|rattle ?traps?|\bplugs?\b', re.I)  # "Stretch-25s"
TROLL = re.compile(r'\btroll\w*|\bpull(?:ing|ed)?\b', re.I)

def sentences(text):
    """The sentences that put the fish on the bottom, suspended or on top, or that are his way of fishing."""
    out = []
    for x in SENT.split(text):
        pos = [k for k, rx in POS if re.search(rx, x, re.I)]
        arig = bool(ARIG.search(x)); crank = bool(CRANK.search(x) and TROLL.search(x))
        if pos or arig or crank:
            out.append({'said': x.strip(), 'fish': pos, 'his_way': (['A-rig'] if arig else []) + (['crankbait'] if crank else []),
                        'ft': [[int(a), int(b or a)] for a, b in FT.findall(x)]})
    return out
