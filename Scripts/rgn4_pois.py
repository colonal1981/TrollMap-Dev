#!/usr/bin/env python3
"""rgn4_pois.py - the POI stage. Every labelled RGN4 point, correctly placed.

Personal use only, not for distribution or resale; not for navigation.

Replaces gmapmf_poi_v3.py, whose `_containers()` pass produced every named POI and had three
independent defects (no sub-block chaining, a -7 head offset that matches a real record head 0
times in 238, and coordinates therefore read from arbitrary mid-record bytes, a median
4.6-10.5 km out). Nothing from that path survives here.

WHAT THIS IS BUILT ON

  chain-by-closure      Session B. RGN4 chains with base width 0.
  unified grammar       Session B. type is a presence bitmask:
                        type(1) dx(2) dy(2) [+ref(3) if type&1] [+5 if type&2] [+6 if type&4]
                        + a per-mode constant tail.
  uniform head          Session A. dx at +1, dy at +3, in every mode. Confirmed against
                        ActiveCaptain at 14-40 m on named marinas.
  no hi-res term        Session A. q = 360 / 2^bits, every level, every mode. The old
                        `hires = 4 if bits == maxbits` rule cost 690-746 m at the deepest zoom.
  pool 1 labels         Session B. pool_offset = ref * 2.
  pool 2 cards          Session B. LBL +0xDE/+0xE2, direct u32 byte offsets, <gml> business
                        cards plus the plain navaid description strings.
  mode 2/7 framing      Session A. ref(3) + pad(1) at the END of the record, so the reference
                        offset is `stride - 4`, and the stride varies per sub-block (29 or 28).

THE INVARIANT

  |dx| <= subdivision width and |dy| <= subdivision height, exactly, for every correctly framed
  record -- max 1.000 on both axes over 4,333 records on three tiles. Enforced here as a hard
  filter, not a warning: a record that violates it is mis-framed and has no business being
  emitted. It catches framing errors; it cannot catch scaling errors, because the raw delta is
  unaffected by scaling.

CALIBRATED, NOT TABULATED

  The pool-2 card pointer offset is measured per tile and mode rather than hardcoded, because
  the two published values for mode 83/0 disagree (record length 34 with the card at +18 in the
  two-pool note, 21 with tail 8 in the unified-grammar note). Scanning for u32 values that land
  on a real <gml> start settles it from the data.
"""
import argparse, json, os, re, struct, sys
from collections import Counter, defaultdict

# Resolve sibling modules from this file's own directory, not a hardcoded path, so the
# module works wherever the pipeline is checked out.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path: sys.path.insert(0, _HERE)
import gmapmf_decode_v40 as V
import gmapmf_lines_v50 as L
import gmapmf_labels_v50 as B
from poi_audit import poi_rows
import rgn4_grammar as _G
from rgn4_grammar import (MODE_TAIL, walk, sb_count, sb_reclen,
                          MODE_4X, MODE_4X_RECLEN, walk_4x)

# THE SUB-BLOCK HEADER STATES ITS OWN RECORD COUNT (Session B, 2026-08-01).
#
# `header[12:14]` is a u16 count. That retires the tail search this file used to do. Closure
# plus reference resolution were never sufficient -- mode 83/0 passed both at the wrong tail --
# and the scoring stack built to work around that (box invariant, card pointers, type-0x00
# counts) was a proxy for a number the file states outright. The count is now the framing test:
#
#     accept a tail iff the walk closes EXACTLY and emits EXACTLY sb_count(hdr) records
#
# The old scorer survives only as a tie-break when more than one tail satisfies both, and as a
# fallback when the header count is absent or zero. Session B derived MODE_TAIL from the count
# rather than fitting it, so '83/0': 21 is now upstream and no longer patched here.
#
# 12/3 is genuinely per-sub-block -- 49 sub-blocks derive tail 0 and 23 derive tail 7 -- which
# is why closure argued for one and the type-0x00 test for the other all day. Both were right
# about different sub-blocks. Framing per sub-block against the stated count settles it without
# either criterion.

# ---------------------------------------------------------------------------------------------
# poi_type -- the field the app renders from.
#
# `supplemental-layers.js` keys POI_STYLE on `properties.ramp_subtype || properties.poi_type ||
# 'place_name'`, so a record without one draws as the grey generic pin no matter what it is. The
# vocabulary below is NOT invented: `nav_buoy`, `caution_buoy`, `danger_buoy`, `slow_no_wake`,
# `water_access`, `boat_ramp`, `fish_attractor`, `mile_marker`, `restricted_area`, `place_name`
# are the keys already in POI_STYLE and already emitted by `activecaptain_to_trollmap.py`, so
# Garmin points merge into the same legend rather than beside it.
#
# The three-tier resolution order matters and follows how much the file actually tells us:
#
#   1. NAME first.   Mode 5/1 is not one class -- it is Garmin's general labelled-point mode, and
#                    the label IS the class: `Road Bed`, `Creek Bed`, `Subm Bridge`,
#                    `Flooded Timber`, `Shallow Area`. 1,217 of them over four tiles. Typing 5/1
#                    by its mode would throw all of that away and call a submerged bridge a
#                    place name.
#   2. NAVAID CLASS. Mode 2/7's pool-2 string is `<class>, <shape>` -- `No Wake, Spar/Spindle
#                    Buoy`. The class before the comma is the meaning; the shape after it is how
#                    Garmin draws it. Match on the class, and match by substring, because the
#                    suffix is always there.
#   3. MODE.         Only for modes whose records carry no discriminator at all.
#
# Structure classes get their own keys rather than being flattened into `place_name`. They are
# the thing Ryan is after -- "if garmin labeled it, put a symbol there" -- and the app already
# has a precedent for exactly these in VISION_STYLE (`FLOODED_TIMBER`, `BRIDGE`, `RIPRAP`).
UNIT24 = 360.0 / (1 << 24)

TYPE_BY_NAME = {
    'road bed':        'road_bed',
    'creek bed':       'creek_bed',
    'river bed':       'river_bed',
    'hazard area':     'hazard_area',
    'subm bridge':     'submerged_bridge',
    'flooded timber':  'flooded_timber',
    'shallow area':    'shallow_area',
    'stump field':     'flooded_timber',
    'rock':            'rock',
    'rocks':           'rock',
    'wreck':           'wreck',
    'parking lot':     'parking',
    'picnic site':     'picnic',
    'campground':      'campground',
    'fuel':            'fuel_dock',
    'boat ramp':       'boat_ramp',
    'ramp':            'boat_ramp',
    'dam':             'dam',
}
# Mode 5/1 ONLY, matched as a whole word anywhere in the name.
#
# TYPE_BY_NAME above is an exact match on the whole string, so it catches Garmin's generic
# `Ramp` and nothing else. The card also carries PROPER-NAMED access -- `Augustus M Flood
# Boat Ramp`, `June Creek Boat Ramp`, `Venning Landing`, `Moores Ldg`, `Jakes Landing` --
# and every one of those was falling through to `place_name`, which is why the card looked
# like it had 26 ramps on B4E0FC when it has 39.
#
# Restricted to 5/1 on purpose. 5/1 is the layer whose label IS its class. The ramp words
# also appear in mode 8/2 (`Ldg Line` -- a LEADING line, a bearing to steer, not a place to
# launch), in mode 84/x light-list prose (`Yellow House Landing, 1 mile NW of, Cooper River`
# describes a light NEAR a landing), and in business names (`Fleet Landing Restaurant`,
# `Charleston Boat Emporium`). Gating on 5/1 drops all of those without a blocklist.
#
# Measured over B4E0DA/DB/F0/F1/FC: 985 distinct 5/1 place_name strings, 31 match, 0 false
# positives by inspection.
NAME_CLASS_5_1 = (
    (re.compile(r'\b(boat ramp|ramp|landing|ldg|launch|slipway)\b', re.I), 'boat_ramp'),
    (re.compile(r'\b(marina|yacht club|boat club|yacht basin|boat ?yard)\b', re.I), 'marina'),
)
# ...except when the name says the thing is gone or is a road, not a launch.
NAME_CLASS_VETO = re.compile(r'\bruins?\b|\bclosed\b|\bformer\b|\bldg line\b', re.I)
# Mode 2/7, matched as a SUBSTRING of the pool-2 string. Order matters: the first hit wins, so
# the specific classes precede the bare shape names that every string ends with.
NAVAID_CLASS = (
    ('no wake',                 'slow_no_wake'),
    ('minimum wake',            'slow_no_wake'),
    ('reduced wake',            'slow_no_wake'),
    ('no boats',                'restricted_area'),
    ('prohibited',              'restricted_area'),
    ('keep clear',              'caution_buoy'),
    ('water intake',            'caution_buoy'),
    # A BUOY, not the attractor. Garmin's string is `Fish Attractor Buoy, Spar/Spindle Buoy`
    # -- a floating marker on the surface. The brush pile is underneath it and belongs to the
    # DNR attractor feed. Calling this `fish_attractor` made the app treat a charted navaid as
    # a registered attractor: it fed Smart Plan's attractor list, and it sat in
    # supplemental-layers' FACILITY_TYPES, so its name was drawn as chart furniture whether or
    # not the attractor layer was switched on. 5 on B4E0F1; Ryan spotted two of them.
    ('fish attractor',          'fish_attractor_buoy'),
    ('hazard',                  'danger_buoy'),
    ('danger',                  'danger_buoy'),
    ('caution',                 'caution_buoy'),
    ('warning',                 'caution_buoy'),
    ('swim',                    'restricted_area'),
    ('beacon',                  'nav_beacon'),
    ('light',                   'nav_light'),
    ('buoy',                    'nav_buoy'),
)
# Modes whose records carry no name and no class field. Anything still unidentified keeps a
# `garmin_<mode>` key so it is VISIBLE on the map and countable in the legend rather than
# silently folded into the generic pin -- these are exactly the classes Ryan is being asked to
# identify from the chart, and he cannot identify what he cannot see.
TYPE_BY_MODE = {
    '83/0':  'marina',        # named marinas; upgraded to boat_ramp when the card lists a Ramp
    '16/1':  'fuel_dock',
    '16/9':  'marine_dealer',
    '16/0':  'boat_club',
    '15/0':  'store',         # Lowes, Target, Sears -- land retail
    '16/11': 'parking',
    '12/3':  'recreation',
    '13/6':  'picnic',
    '2/9':   'mile_marker',   # names are quoted numbers: "17", "11", "23"
    '2/10':  'mile_marker',
    '2/11':  'mile_marker',
    '7/4':   'pile',          # bridge piling; Ryan's photo, matched at 3 m
    '7/0':   'height_marker', # off-water; two header signatures, see RGN4_HEADER_IS_A_COUNT
    '7/12':  'garmin_7_12',
    '6/0':   'garmin_6_0',
    '3/4':   'garmin_3_4',
    '3/6':   'garmin_3_6',
    '3/8':   'garmin_3_8',
    '3/26':  'garmin_3_26',   # the purple triangles; B5, single symbol class, name unknown
    '4/1':   'obstruction',
    '4/7':   'obstruction',
    '4/8':   'obstruction',
    '4/10':  'obstruction',
    '4/12':  'obstruction',
    '5/1':   'place_name',    # only reached when the 5/1 record has no name at all
}
# Land classes. Kept in the output -- dropping them would be a decode decision dressed up as a
# display one -- but marked so the chartpack can filter to "on the water" in one predicate.
OFF_WATER = {'store', 'marine_dealer', 'height_marker', 'parking', 'road_shield'}


def poi_type(p):
    """Resolve one record's poi_type. Returns (type, on_water)."""
    nm = (p.get('name') or '').strip().lower().strip('"')
    if p.get('navaid'):
        for key, t in NAVAID_CLASS:
            if key in nm: break
        else:
            t = 'nav_buoy'
    elif nm in TYPE_BY_NAME:
        t = TYPE_BY_NAME[nm]
    elif nm.isdigit():
        # A bare number in mode 5/1 is a highway shield -- 97, 521, 601, 321, 77, 378 are all US
        # and SC routes through these tiles. Numeric NAVAID labels are a different thing and are
        # already handled above, so this only sees the road network.
        t = 'road_shield'
    else:
        t = TYPE_BY_MODE.get(p.get('mode'), 'place_name')
        # A marina whose own business card lists a Ramp is a ramp. This is Garmin's word for it,
        # read out of the card text, not an inference from the name -- 20 of 25 marinas carry it.
        if t == 'marina' and any('ramp' in s.lower() or 'slipway' in s.lower()
                                 for s in p.get('services', ())):
            t = 'boat_ramp'
        elif t == 'place_name' and p.get('mode') == '5/1' and not NAME_CLASS_VETO.search(nm):
            for rx, cls in NAME_CLASS_5_1:
                if rx.search(nm):
                    t = cls
                    break
    return t, t not in OFF_WATER

u16 = lambda b, p: struct.unpack_from('<H', b, p)[0]
u32 = lambda b, p: struct.unpack_from('<I', b, p)[0]
s16 = lambda b, p: int.from_bytes(b[p:p+2], 'little', signed=True)
OKTEXT = re.compile(r'^[ -~]{2,60}$')


def s24(b, p):
    v = int.from_bytes(b[p:p+3], 'little')
    return v - (1 << 24) if v & 0x800000 else v


def detail_pool(path_or_bytes):
    d = open(path_or_bytes, 'rb').read() if isinstance(path_or_bytes, str) else path_or_bytes
    at = u32(d[:0x3d], 0x21)
    h = d[at:at + u16(d, at)]
    return d[u32(h, 0xDE):u32(h, 0xDE) + u32(h, 0xE2)]


def card_starts(det):
    return {m.start() for m in re.finditer(rb'<gml>', det)}


def card(det, off):
    """Parse one <gml> business card.

    The amenity list is NOT `Services: Ramp` on one line. It is a heading in its own markup
    followed by the items on separate <br> lines, indented with &nbsp;:

        <b><i>Services:</i></b><br>&nbsp;&nbsp;&nbsp;&nbsp;Ramp<br>
        <b><i>Miscellaneous:</i></b><br>&nbsp;&nbsp;&nbsp;&nbsp;Mechanical assistance<br>

    Parsing it as inline `heading: value` finds nothing at all -- it reported 0 cards carrying
    a Ramp service where there are 14. So: split on <br>, treat a line ending in ':' as a
    section heading, and attribute the plain lines that follow to it.
    """
    end = det.find(b'</gml>', off)
    raw = det[off:end + 6 if end >= 0 else min(len(det), off + 900)].decode('latin1')
    name = None
    m = re.search(r'<b>(.*?)</b>', raw, re.S)
    if m: name = re.sub(r'<[^>]+>', ' ', m.group(1)).strip()
    txt = re.sub(r'<br\s*/?>', '\n', raw)
    txt = re.sub(r'<[^>]+>', '', txt)
    txt = txt.replace('&nbsp;', ' ').replace('&amp;', '&').replace('&#39;', "'")
    lines = [x.strip() for x in txt.split('\n') if x.strip()]
    svc = []; section = None; body = []
    AMENITY = ('services', 'miscellaneous', 'provisions', 'dockage', 'fuel', 'amenities')
    for ln in lines:
        if ln.endswith(':'):
            section = ln[:-1].strip().lower(); continue
        if section in AMENITY:
            svc += [s.strip() for s in ln.split(',') if s.strip()]
        else:
            body.append(ln)
    if name and body and body[0] == name: body = body[1:]
    return {'name': name or (lines[0] if lines else None), 'lines': body, 'services': svc}


def navaid_vocab(det):
    """Recover the plain navaid phrases between the cards, and require them to tokenise the
    region EXACTLY. A tile whose vocabulary leaves residue is gated out rather than guessed at."""
    spans = [(m.start(), m.end()) for m in re.finditer(rb'<gml>.*?</gml>', det, re.S)]
    regions = []; prev = 0
    for s, e in spans:
        if s > prev: regions.append((prev, s))
        prev = e
    if prev < len(det): regions.append((prev, len(det)))
    regions = [(s, e) for s, e in regions if e - s > 4]
    text = ''.join(det[s:e].decode('latin1') for s, e in regions)
    vocab = sorted({p for p in re.split(r'(?<=[a-z\)])(?=[A-Z"])', text) if 3 <= len(p) <= 60},
                   key=len, reverse=True)
    starts = {}; ok = True
    for s, e in regions:
        t = det[s:e].decode('latin1'); p = 0
        while p < len(t):
            for v in vocab:
                if t.startswith(v, p):
                    starts[s + p] = v; p += len(v); break
            else:
                ok = False; p += 1
    return starts, ok


def uniform(b, reclen):
    """Frame a sub-block as fixed-length records: type at +0, dx at +1, dy at +3.

    For the modes that do not follow the type bitfield at all. Mode 2/7's navaids are the case
    that matters -- Session A found the reference sits at the END of the record and the stride
    varies between sub-blocks, and used a search over strides 20-40 to find it. The header
    states the count, so the stride is `len(payload) // count` and there is nothing to search.
    """
    return [dict(type=b[p], off=p, len=reclen, dx=s16(b, p + 1), dy=s16(b, p + 3), ref=None)
            for p in range(0, len(b) - reclen + 1, reclen)]


def frame(hdr, b, mode, pool, cards, default, w=None, h=None):
    """Frame one sub-block against the record count the header states.

    Returns (records, tail, how). `how` is 'count' when the stated count was matched exactly,
    'uniform' when the count was matched by fixed-length framing instead of the type bitfield,
    and 'fit' when no count was available and the old scoring fallback was used.

    Requiring the count is much stricter than requiring closure. Closure asks only that the
    walk land on the end of the payload, which several wrong tails do; the count also has to
    come out right, and a tail that splits every record in two cannot satisfy it. Mode 83/0's
    tail 8 -- which passed closure at 97.81% AND resolved 72 of 72 references, and cost most of
    a day -- emits twice the stated number of records and is rejected on the first test.
    """
    n = sb_count(hdr)

    # The 4/x obstruction family does not follow the type bitfield: every record is 6 bytes,
    # `04 dx(2) dy(2) <class>`, class constant per mode. Session B, confirmed 53/53 in box.
    if mode in MODE_4X:
        recs = walk_4x(b)
        return ([dict(type=t, off=i * MODE_4X_RECLEN, len=MODE_4X_RECLEN, dx=dx, dy=dy,
                      ref=None, cls=c) for i, (t, dx, dy, c) in enumerate(recs)],
                None, 'count' if (n and len(recs) == n) else 'uniform')

    if n:
        ok = []
        for tail in sorted({default} | set(range(0, 26))):
            _G.MODE_TAIL[mode] = tail
            recs, used = walk(b, mode)
            if used == len(b) and len(recs) == n: ok.append((tail, recs))
        _G.MODE_TAIL[mode] = default
        if len(ok) == 1:
            return ok[0][1], ok[0][0], 'count'
        if ok:
            # More than one tail reproduces the count. Rare, and only among tails that already
            # agree on the record boundaries the file declares, so any of the old criteria is a
            # safe tie-break; the box invariant leads because a mis-framed record is outside its
            # own subdivision regardless of what else it scores.
            best = None
            for tail, recs in ok:
                nres = sum(1 for r in recs if r['ref'] is not None and B.label(pool, r['ref']))
                nbad = sum(1 for r in recs
                           if w is not None and (abs(r['dx']) > w or abs(r['dy']) > h))
                ncard = sum(1 for r in recs for off in range(0, r['len'] - 3)
                            if r['off'] + off + 4 <= len(b) and u32(b, r['off'] + off) in cards)
                score = (-nbad, nres, ncard, tail == default)
                if best is None or score > best[0]: best = (score, tail, recs)
            return best[2], best[1], 'count'
        # The type bitfield cannot reproduce the count; try fixed-length records instead.
        rl = sb_reclen(hdr, b)
        if rl and rl >= 5:
            return uniform(b, rl), None, 'uniform'

    # No usable count. Fall back to the pre-count scorer, which is what this file did before.
    best = None
    for tail in sorted({default} | set(range(0, 26))):
        _G.MODE_TAIL[mode] = tail
        recs, used = walk(b, mode)
        if used != len(b) or not recs: continue
        nres = sum(1 for r in recs if r['ref'] is not None and B.label(pool, r['ref']))
        nbad = sum(1 for r in recs if w is not None and (abs(r['dx']) > w or abs(r['dy']) > h))
        ncard = sum(1 for r in recs for off in range(0, r['len'] - 3)
                    if r['off'] + off + 4 <= len(b) and u32(b, r['off'] + off) in cards)
        score = (-nbad, nres, ncard, tail == default)
        if best is None or score > best[0]: best = (score, tail, recs)
    _G.MODE_TAIL[mode] = default
    if best is None:
        return walk(b, mode)[0], None, 'fit'
    return best[2], best[1], 'fit'


def calibrate_card_offset(bym, det, cards, pool):
    """Per mode, where in the record does the pool-2 card pointer sit? Measured, not assumed.

    This MUST frame the payload the same way extraction does. Calibrating with the mode default
    tail while extracting with a per-sub-block tail measures the offset against a different
    record layout, and the two silently disagree: business cards attached to 227 POIs before
    per-sub-block tails were introduced and 119 after, purely from this mismatch.
    """
    hist = defaultdict(Counter)
    for mode, chunks in bym.items():
        m = '%d/%d' % mode
        if m in MODE_4X: continue
        for hdr, b, sd in chunks:
            w, h = max(sd['width'], 1), max(sd['height'], 1)
            recs, _t, _how = frame(hdr, b, m, pool, cards, MODE_TAIL.get(m, 0), w, h)
            for r in recs:
                for off in range(0, r['len'] - 3):
                    p = r['off'] + off
                    if p + 4 > len(b): break
                    if u32(b, p) in cards: hist[mode][off] += 1
    out = {}
    for mode, c in hist.items():
        tot = sum(c.values()); off, n = c.most_common(1)[0]
        if tot >= 3 and n / tot >= 0.6: out[mode] = off
    return out


def extract(path):
    T = V.Tile(path)
    pool = B.lbl_pool(path)
    det = detail_pool(path)
    cards = card_starts(det)
    nav, nav_ok = navaid_vocab(det)
    pr, _ = poi_rows(T)
    N, E = s24(T.tre, 0x15) * UNIT24, s24(T.tre, 0x18) * UNIT24
    S, W = s24(T.tre, 0x1B) * UNIT24, s24(T.tre, 0x1E) * UNIT24

    bym = defaultdict(list)
    for _i, sd, ch in pr:
        if len(ch) < 16: continue
        sbs = L.chain(ch, 0)
        if not sbs: continue
        for hdr, b in sbs:
            bym[(hdr[0], hdr[1])].append((hdr, b, sd))

    card_off = calibrate_card_offset(bym, det, cards, pool)
    st = Counter(); out = []

    # ---- every mode except 2/7, framed against the stated record count ------
    for mode, chunks in bym.items():
        if mode == (2, 7): continue
        m = '%d/%d' % mode
        for hdr, b, sd in chunks:
            w, h = max(sd['width'], 1), max(sd['height'], 1)
            q = 360.0 / (1 << sd['bits'])
            clon, clat = sd['lon_raw'] * UNIT24, sd['lat_raw'] * UNIT24
            recs, tail, how = frame(hdr, b, m, pool, cards, MODE_TAIL.get(m, 0), w, h)
            st['records_' + m] += len(recs)
            st['tail_%s_%s' % (m, tail)] += 1
            st['framed_' + how] += 1
            if sb_count(hdr) and len(recs) != sb_count(hdr):
                st['count_mismatch_' + m] += 1
            for r in recs:
                # EMIT UNLABELLED RECORDS TOO.
                #
                # Skipping records with no pool-1 reference dropped 967 of 2,028 RGN4 records on
                # B4E0F1 -- 48%. Among them mode 3/26's 340 records, which Ryan's chart taps
                # identify as the ramp and pier/jetty symbols, and 70 of mode 7/0. Those records
                # have valid geometry (they satisfy the box invariant); they simply carry no
                # name, because 3/26 records are type 0x00 and have no label field at all.
                #
                # The extraction gate treats "decode mode 3/26's symbol class" as a later job.
                # That is only true if the records are in the output. Dropping them turns every
                # unsolved symbol class into a re-extraction of the whole card.
                name = B.label(pool, r['ref']) if r['ref'] is not None else None
                if name and not OKTEXT.match(name): name = None
                if name: st['named'] += 1
                else: st['unnamed'] += 1
                if abs(r['dx']) > w or abs(r['dy']) > h:
                    st['box_violation'] += 1; continue
                lat, lon = clat + r['dy'] * q, clon + r['dx'] * q
                if not (S <= lat <= N and W <= lon <= E):
                    st['out_of_tile'] += 1; continue
                p = {'mode': m, 'type_byte': r['type'],
                     'zoom': 24 - sd['bits'], 'source': 'RGN4 pool-1 ref*2',
                     # RAW RECORD BYTES, ALWAYS.
                     # The extraction gate assumes an unsolved field can be decoded later and
                     # re-applied to already-extracted output without re-reading the card. That
                     # is only true if the bytes survive. v3 carried `raw_tail` for exactly this
                     # reason and I dropped it when rewriting the stage, which would have turned
                     # every open item (mode 3/26's symbol class, the 4/x modes, the flags byte,
                     # anything the local-field store later resolves) into a re-extraction.
                     # Measured cost is a few percent of the layer; a second pass over the card
                     # is hours.
                     'raw': b[r['off']:r['off'] + r['len']].hex()}
                # The 4/x family's class byte is the only discriminator it has, so it travels
                # with the record rather than being folded into the mode name.
                if 'cls' in r: p['class_byte'] = r['cls']
                if name: p['name'] = name.replace('\n', ' ')
                if mode in card_off:
                    cp = r['off'] + card_off[mode]
                    if cp + 4 <= len(b) and u32(b, cp) in cards:
                        c = card(det, u32(b, cp))
                        if c['name']: p['card'] = c['name']
                        if c['services']: p['services'] = c['services']
                        if c['lines']: p['card_lines'] = c['lines'][:8]
                out.append((lat, lon, p))

    # ---- mode 2/7 navaids, pool 2 ------------------------------------------
    # The stride is stated, not searched. Session A found ref(3) + pad(1) at the END of the
    # record, so the reference offset is stride - 4, and searched strides 20-40 x every phase to
    # locate it. `len(payload) // sb_count(hdr)` gives it outright.
    #
    # It also VINDICATES the search rather than replacing its answer: the stated stride is 29 on
    # 60 sub-blocks of B4E0F1 and 28 on 12, exactly the two values the search returned. Session
    # B's derived tail of 19 gives 29 on type 0x02 and is the majority case, not the only one --
    # worth saying plainly, because I had written the 28s off as the search landing on a
    # reference by luck before checking the count, and the file says they are real.
    #
    # 2 sub-blocks state no usable count and are skipped rather than searched, since a stride
    # found by search is exactly the kind of fit the count exists to retire.
    if nav_ok:
        for hdr, b, sd in bym.get((2, 7), []):
            w, h = max(sd['width'], 1), max(sd['height'], 1)
            stride = sb_reclen(hdr, b)
            if not stride or stride < 8:
                st['navaid_no_count'] += 1; continue
            ro = stride - 4
            ph = 0
            st['navaid_stride_%d' % stride] += 1
            q = 360.0 / (1 << sd['bits'])
            clon, clat = sd['lon_raw'] * UNIT24, sd['lat_raw'] * UNIT24
            for hh in range(ph, len(b) - stride + 1, stride):
                if hh + ro + 3 > len(b): continue
                nm = nav.get(int.from_bytes(b[hh+ro:hh+ro+3], 'little'))
                if nm is None: continue
                dx, dy = s16(b, hh+1), s16(b, hh+3)
                if abs(dx) > w or abs(dy) > h:
                    st['box_violation'] += 1; continue
                lat, lon = clat + dy * q, clon + dx * q
                if not (S <= lat <= N and W <= lon <= E):
                    st['out_of_tile'] += 1; continue
                out.append((lat, lon, {'name': nm, 'mode': '2/7', 'type_byte': b[hh],
                                       'zoom': 24 - sd['bits'], 'navaid': True,
                                       'class': nm.split(',')[0].strip(),
                                       'source': 'RGN4 pool-2 ref at stride-4',
                                       'raw': b[hh:hh + stride].hex()}))
    else:
        st['navaids_gated_out_vocab_residue'] = 1

    # ---- dedupe: same thing at several zooms, keep the most detailed --------
    # The same POI is emitted at every zoom level, and the copies differ by only a few metres
    # once the scaling is right -- Big Mans Marina came out at 34.08122 and 34.08126. Rounding
    # coordinates cannot merge those without also merging genuinely distinct features, so
    # instead: group by name, take the most detailed zoom first, and accept a later point only
    # if it is further than MERGE_M from every point already kept for that name.
    #
    # The radius only has to beat the spread between zoom copies of ONE feature, which is a
    # few metres once the scaling is right (Big Mans Marina: 34.08122 vs 34.08126, ~4 m). It
    # must NOT be large enough to merge distinct features that share a name -- and for navaids
    # the "name" is a class, not an identity: Ryan counted four spar buoys on one hazard area,
    # and at 150 m they collapsed to one, taking mode 2/7 from 142 records to 46. 30 m keeps
    # every distinct buoy while still folding the zoom copies.
    # Two radii, because the two kinds of feature differ in what a shared name means.
    # A named business or marina appears once; 30 m folds its zoom copies safely.
    # A navaid's "name" is a CLASS -- Ryan counted four spar buoys on one hazard area, and two
    # of them sit inside 30 m of each other, so a single radius either loses a real buoy or
    # stops folding zoom copies. Zoom copies differ by ~4 m once the scaling is right, so 10 m
    # is ample for them and still keeps buoys 20 m apart distinct.
    MERGE_NAMED, MERGE_NAVAID = 30.0, 10.0
    bykey = defaultdict(list)
    for lat, lon, p in out:
        # unnamed records have no name to group on; key them by mode so they are still
        # de-duplicated across zoom levels but never merged with a named feature
        bykey[p.get('name') or ('\x00mode:' + p['mode'])].append((lat, lon, p))
    kept = []
    for nm, pts in bykey.items():
        # Deterministic ordering: most detailed zoom first, then richer records (a card and
        # services beat a bare name), then position. `-len(properties)` was an arbitrary
        # tiebreak and made which copy survived depend on dict contents -- it silently dropped
        # a Hazard buoy between runs.
        pts.sort(key=lambda t: (t[2]['zoom'],
                                -(('card' in t[2]) + ('services' in t[2])),
                                round(t[0], 6), round(t[1], 6)))
        acc = []
        for lat, lon, p in pts:
            R = MERGE_NAVAID if p.get('navaid') else MERGE_NAMED
            far = True
            for la2, lo2, _ in acc:
                dy = (lat - la2) * 111320.0
                dx = (lon - lo2) * 111320.0 * 0.826
                if dx * dx + dy * dy < R * R: far = False; break
            if far: acc.append((lat, lon, p))
        kept += acc
        st['merged_zoom_copies'] += len(pts) - len(acc)

    # Assign the field the app renders from. Done once, after dedupe, so the surviving copy of a
    # feature is the one that gets typed and the counts in `st` match the output exactly.
    for _lat, _lon, p in kept:
        t, on_water = poi_type(p)
        p['poi_type'] = t
        p['on_water'] = on_water
        st['type_' + t] += 1
    return T, kept, st, card_off


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('tiles', nargs='+')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    feats = []; allst = Counter()
    for path in a.tiles:
        T, pts, st, card_off = extract(path)
        allst.update(st)
        print('%-14s %5d POIs   card ptr offsets %s'
              % (path, len(pts), {'%d/%d' % k: v for k, v in card_off.items()}))
        for lat, lon, p in pts:
            p['tile'] = path
            feats.append({'type': 'Feature', 'properties': p,
                          'geometry': {'type': 'Point', 'coordinates': [round(lon, 6), round(lat, 6)]}})
    json.dump({'type': 'FeatureCollection',
               'properties': {'generator': 'rgn4_pois.py',
                              'note': 'Personal use only, not for distribution or resale; not for navigation.'},
               'features': feats}, open(a.out, 'w'), ensure_ascii=False)
    print('\n%d POIs -> %s' % (len(feats), a.out))
    for k, v in sorted(allst.items()):
        if k.startswith('records_'): continue
        print('   %-34s %s' % (k, v))
    c = Counter(f['properties']['mode'] for f in feats)
    print('   by mode: %s' % dict(c.most_common()))


if __name__ == '__main__':
    main()
