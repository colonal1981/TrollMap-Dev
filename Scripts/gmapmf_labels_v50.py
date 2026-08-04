#!/usr/bin/env python3
"""GMAPMF label resolution -- SOLVED 2026-07-31, Session B.

Personal use only, not for distribution or resale; not for navigation.

THE RULE
--------
A feature's label reference is a 3-byte little-endian value inside the record.
The string lives in the LBL pool at:

        pool_offset = value * 2

The pool is a run of NUL-terminated UTF-8 strings starting at LBL header +0x15
(offset) / +0x19 (length). Strings are laid out at even offsets, which is why the
reference is halved -- the same convention classic Garmin IMG uses for LBL offsets.

EVIDENCE
--------
B4E0F1 RGN4 mode 5/1: 896 records carry 132 distinct reference values in the range
1691..2852. Multiplied by 2, **132 of 132** land exactly on a string start (a byte
whose predecessor is NUL). Raw, /2, and -base all score under 7%. There is no other
plausible reading.

Resolved, they are the actual chart labels:

    Lake Wateree, Kington Lake, Ford Pond, Adams Mill Pond, Kendall Lake,
    Flooded Timber, Shallow Area, Hazard Area, Parking Lot,
    and the road shields 601, 521, 441, 401, 378, 341, 154, 97, 76, 41, 34, 31, 28, 23, 20, 15, 12, 1

The rule holds across the other RGN4 modes too, which is how the mode -> class map
below was established:

    mode  5/1   general POIs, road shields, named water bodies, hazard/flooded-timber markers
    mode  2/7   NAVAIDS -- "Hazard, Spar/Spindle Buoy", "No Wake, Spar/Spindle Buoy",
                "Fish Attractor Buoy, Spar/Spindle Buoy", "Water Intake Keep Clear, Spar/Spindle Buoy"
    mode 83/0   MARINAS by name -- Clearwater Cove Marina, Lakeside Marina,
                Wateree Lake RV Park and Marina, Wateree Marina
                (this is the `ch[0] == 83` anomaly from the firmware brief, item #8 --
                 not a broken element type, a named-POI mode)
    mode 15/0   businesses -- Williams Sporting Goods Inc, Sears Roebuck Company,
                Simpsons Ace Hardware
    mode 12/3   recreation areas -- Wateree Recreation Area, NOSCA Pines Ranch
    mode 16/11  Parking Lot
    mode  3/26  multi-language type concepts (Minimum Wake and its translations)

RGN4 RECORD GRAMMAR, mode 5/1 (100.00% of payload consumed on B4E0F1)
--------------------------------------------------------------------
    type(1) dx(2, LE signed) dy(2, LE signed) label_ref(3, LE)
    then, gated by bits in `type`:
        bit 1 set -> 5 more bytes   (observed: `81 07 21 08 NN`)
        bit 2 set -> 6 more bytes   (observed: `e0 09 00 00 ff ff`)

    type distribution on B4E0F1: 0x01 x494, 0x03 x400, 0x07 x2.
    Brute-forcing both attribute lengths over 0..8 gives a unique maximum at (5, 6)
    and it consumes the payload EXACTLY -- 100.00%, not 99.x%.

    RGN4 rows chain with base width 0 (no base prefix at all): 325/325 rows on
    B4E0F1 close exactly, 577 sub-blocks. Use gmapmf_lines_v50.chain/detect_bw.

The other modes are variable-length in a way a fixed stride cannot express, so the
per-mode grammars are still open. The LABEL RULE itself is mode-independent.
"""
import struct
def u16(b,p): return struct.unpack_from('<H',b,p)[0]
def u32(b,p): return struct.unpack_from('<I',b,p)[0]

def lbl_pool(path_or_bytes):
    d = open(path_or_bytes,'rb').read() if isinstance(path_or_bytes,str) else path_or_bytes
    at = u32(d[:0x3d], 0x21)
    h  = d[at:at+u16(d,at)]
    off, ln = u32(h,0x15), u32(h,0x19)
    return d[off:off+ln]

def label(pool, ref):
    """Resolve a 3-byte label reference to its string. Returns None if it does not
    point at a string start -- use that as the validity test for a candidate field."""
    o = ref * 2
    if not (0 <= o < len(pool)): return None
    if o and pool[o-1] != 0:     return None      # not a string start -> not a label ref
    e = pool.find(b'\0', o)
    if e < 0: return None
    try:    return pool[o:e].decode('utf-8')
    except: return pool[o:e].decode('latin1')

def string_starts(pool):
    return {0} | {i+1 for i,c in enumerate(pool) if c == 0}

def parse_mode_5_1(b, a2=5, a4=6):
    """RGN4 mode 5/1 records. Returns (records, bytes_consumed); consumed == len(b)
    when the grammar is right."""
    out=[]; p=0; n=len(b)
    while p+8 <= n:
        t = b[p]
        rec = dict(type=t,
                   dx=int.from_bytes(b[p+1:p+3],'little',signed=True),
                   dy=int.from_bytes(b[p+3:p+5],'little',signed=True),
                   ref=b[p+5] | b[p+6]<<8 | b[p+7]<<16)
        q = p+8
        for bit,ln in ((2,a2),(4,a4)):
            if t & bit:
                if q+ln > n: return out,p
                q += ln
        rec['attr'] = b[p+8:q]
        out.append(rec); p = q
    return out, p


# ---------------------------------------------------------------------------
# POOL 2 -- the rich-detail store.  Added 2026-07-31 after the pool-1 rule.
#
# LBL header +0xDE (offset) / +0xE2 (length) is a SECOND string region, and it is
# addressed differently: a **direct u32 byte offset**, not ref*2.
#
# It holds two kinds of content interleaved:
#   * `<gml>...</gml>` HTML detail cards -- business name in <b>, then street
#     address, phone, website, and a Services / Provisions / Miscellaneous list
#     (Ramp, Slipway, Fuel, Pumpout, Restrooms, Shower, Laundry, Restaurant,
#      Campsites, Canoeing/Kayaking, Mechanical assistance, Car parking,
#      Private port or marina, Fishing/diving)
#   * plain per-instance description strings, e.g. the navaid qualifiers
#     "Hazard, Spar/Spindle Buoy", "Fish Attractor Buoy, Spar/Spindle Buoy"
#
# It is NOT NUL-delimited like pool 1 -- 8,907 bytes with 2 NULs on B4E0F1 --
# so use the `<gml>` sentinel to find card starts.
#
# CROSS-CHECK.  A record carries both references, and they agree on every record
# tested: pool-1 short label vs pool-2 card <b>name</b>, 48/48 on B4E0F1 across
# modes 15/0 (20), 16/11 (16) and 83/0 (12). Two independent fields, two pools,
# two addressing schemes, same answer -- that is the validation.
#
# RGN4 record layouts measured on B4E0F1:
#   mode  5/1   type(1) dx(2) dy(2) pool_ref(3), +5 if type&2, +6 if type&4
#   mode 15/0   20 bytes: pool_ref at +5, gml u32 at +16     (20/20 resolve)
#   mode 16/11  20 bytes: pool_ref at +5, gml u32 at +16     (16/16)
#   mode 83/0   34 bytes: pool_ref at +5, gml u32 at +18     (12/12)
# ---------------------------------------------------------------------------
import re as _re

POI_GRAMMAR = {            # mode -> (record_len, pool_ref_off, gml_u32_off)
    (15, 0):  (20, 5, 16),
    (16, 11): (20, 5, 16),
    (83, 0):  (34, 5, 18),
}

def detail_pool(path_or_bytes):
    """LBL pool 2: the <gml> card / description store."""
    d = open(path_or_bytes,'rb').read() if isinstance(path_or_bytes,str) else path_or_bytes
    at = u32(d[:0x3d], 0x21)
    h  = d[at:at+u16(d,at)]
    off, ln = u32(h,0xDE), u32(h,0xE2)
    return d[off:off+ln]

def card_starts(detail):
    return {m.start() for m in _re.finditer(rb'<gml>', detail)}

def card(detail, off):
    """Parse the <gml> card at a direct byte offset. Returns a dict or None."""
    if not (0 <= off < len(detail)) or detail[off:off+5] != b'<gml>': return None
    end = detail.find(b'</gml>', off)
    if end < 0: return None
    body = detail[off:end].decode('latin1')
    name = _re.search(r'<b>(.*?)</b>', body)
    lines = [x for x in _re.split(r'<br\s*/?>', _re.sub(r'<(?!/?b\b|/?i\b)[^>]*>', '', body)) if x.strip()]
    services = [m.group(1).strip() for m in _re.finditer(r'&nbsp;&nbsp;&nbsp;&nbsp;([^<&]+)', body)]
    return dict(offset=off, name=(name.group(1) if name else None),
                lines=[x.strip() for x in lines], services=services, raw=body)
