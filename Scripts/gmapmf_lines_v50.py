#!/usr/bin/env python3
"""GMAPMF line-region decoder v50 -- chain by closure, tag-priority records.

Personal use only, not for distribution or resale; not for navigation.

WHAT CHANGED FROM v40, and why it matters
-----------------------------------------
v40 framed a TRE7 row by a byte-pattern marker test on each candidate sub-block header
(`ch[h+9]==0x00 and ch[h+10] in (0x00,0x80) and ch[h+14]==0`) and consumed a `bw`-byte
base prefix before EVERY header.  Both are wrong:

  * the base prefix is present only on the FIRST sub-block of a row;
  * the marker pattern holds for some sub-block modes and not others, so valid headers
    were rejected and the rest of the row was dumped into one undivided slice.

Measured on B4E0F1's line region that walker chained 722 sub-blocks and 16.1% of bytes.
Chaining by CLOSURE instead -- accept a `bw` iff following `plen` at header[2:4] lands
exactly on the end of the row -- gives 2,183 sub-blocks and 100% of bytes, and picks a
unique `bw` on every tile tested (B4E0F1/DA/F0 = 3, C4E0F1 and B4E0DB = 2, A4D = 3).
No other `bw` closes more than 1% of rows, so the detection is unambiguous.

v40 also treated the depth tag as the record DELIMITER, scanning for `91 05 06` / `11 05 06`
and cutting there.  Records are actually sequential: head + selectors + OPTIONAL attribute
region, and the depth tag is one possible attribute.  Features that carry no depth tag were
therefore either swallowed into the next contour's geometry prefix or dropped as the
un-emitted remainder after the last tag in a payload.

CORRECTNESS METRIC
------------------
Byte coverage alone proves nothing -- a desynced walk still consumes every byte.  The check
that actually bites is TAG ALIGNMENT: what fraction of raw `91 05 06` / `11 05 06`
occurrences in the payload land exactly at a record's end-of-geometry (+ attribute length).
A desynced walker scores ~12%; this one scores 99.07-100.00% on every tile measured.
An earlier version of this file scored 99.14% byte coverage while aligning only 11.8% of
tags -- the coverage number was meaningless.  Always report tag alignment.

SUB-BLOCK MODE = FEATURE CLASS
------------------------------
`(header[0], header[1])` is the mode.  Every depth tag on B4E0F1 (6,703 of 6,703) is in
mode 3/1 and none is in any other mode; on C4E0F1 all 12,129 are in mode 3/8.  Rendered,
the other modes on B4E0F1 are: 8/3 local roads, 8/2 secondary roads, 8/1 highways,
4/12 lake shoreline, 1/12 hydrography (river channel, ponds, islands), 6/1 mostly closed
rings.  Modes 8/1, 8/2, 8/3, 4/12, 1/12 and 5/7 decode with 0.00% of vertices outside the
tile bounds.  Mode 1/6 (99 features on B4E0F1) and part of mode 6/1 still decode wrong --
their record head appears to carry an extra field -- so treat those two as UNVERIFIED.
"""
import re, struct
from collections import Counter

FH = 15                                  # sub-block header length
TAG  = bytes.fromhex("910506")           # final depth tag,  + 5-byte trailer `09` + u32
TAG2 = bytes.fromhex("110506")           # non-final depth tag, 4 bytes, no trailer

def chain(row, bw):
    """Split a TRE7 row into sub-blocks. Returns [(header, payload)] or None if it does
    not close exactly on the end of the row."""
    p = bw; out = []
    while p < len(row):
        if p + FH > len(row): return None
        plen = int.from_bytes(row[p+2:p+4], "little")
        if plen == 0 or p + FH + plen > len(row): return None
        out.append((row[p:p+FH], row[p+FH:p+FH+plen]))
        p += FH + plen
    return out if p == len(row) else None

def detect_bw(rows, candidates=(2, 3, 4, 1, 0, 5)):
    """The base-prefix width is whichever value makes every row close exactly."""
    best = (0, None)
    for bw in candidates:
        n = sum(1 for r in rows if chain(r, bw) is not None)
        if n > best[0]: best = (n, bw)
    return best[1], (best[0] / len(rows) if rows else 0.0)

def head_at(b, p, n):
    """Record head. op packs the field widths: bits 6-7 coord width-1, bits 4-5 selector
    width-1, bit 3 count width-1. NOTE: v40 rejected odd opcodes ('bit0=1 -> line path');
    measured, odd opcodes parse with the identical layout, so they are accepted here."""
    if p >= n: return None
    op = b[p]
    cw = (op >> 6) + 1; sw = ((op >> 4) & 3) + 1; nw = ((op >> 3) & 1) + 1
    need = 1 + 2*cw + nw
    if p + need > n: return None
    cnt = int.from_bytes(b[p+1+2*cw:p+need], "little")
    if cnt == 0: return None
    e = p + need + cnt*sw
    if e > n: return None
    return dict(op=op, cw=cw, sw=sw, nw=nw, cnt=cnt, hstart=p, gstart=p+need, gend=e)

def rec_end(b, q, n, win=16):
    """Consume the attribute region that follows the selectors.

    Order matters: look for a depth TAG first, and only then for the next parsable head.
    Reversed, the attribute bytes themselves (`98 3d` -- 0x98 is a legal opcode) parse as a
    record and the walk desyncs. That single ordering choice is the difference between 11.8%
    and 99.99% tag alignment on B4E0F1."""
    for r in range(q, min(n, q+win)):
        if b[r:r+3] == TAG and r+9 <= n and b[r+4] == 9: return r+9, b[r+3], r-q
        if b[r:r+3] == TAG2 and r+4 <= n:                return r+4, b[r+3], r-q
    for r in range(q, min(n, q+win)):
        if head_at(b, r, n) is not None: return r, None, r-q
    return q, None, 0

def walk_payload(b, win=16):
    """Yield (head, depth_dm, attr_len, end) for every record in one sub-block payload."""
    out = []; q = 0; n = len(b)
    while q < n:
        h = head_at(b, q, n)
        if h is None: break
        e, dm, al = rec_end(b, h["gend"], n, win)
        if e <= q: break
        out.append((h, dm, al, e)); q = e
    return out, q

def tag_alignment(rows, bw, win=16):
    """The correctness self-check. Returns (aligned, raw_tags)."""
    raw = hit = 0
    for row in rows:
        sbs = chain(row, bw)
        if sbs is None: continue
        for _hdr, b in sbs:
            tags = {m.start() for m in re.finditer(re.escape(TAG), b)} | \
                   {m.start() for m in re.finditer(re.escape(TAG2), b)}
            raw += len(tags)
            recs, _ = walk_payload(b, win)
            hit += len(tags & {h["gend"] + al for h, _d, al, _e in recs})
    return hit, raw


# ---------------------------------------------------------------------------
# LINE-REGION ATTRIBUTE POLICY  (B1, 2026-08-01)
#
# The two modes that decoded wrong are fixed, and the fix is the same rule the RGN4
# point records use: **opcode bit 0 means a 3-byte label reference follows the
# selectors.**  That is a format-level rule shared across regions, not a per-mode
# quirk, and it explains v40's `if op & 1: return None` guard -- those records carry a
# trailing field, so a parser that ignored it desynced, and the conclusion drawn was
# that odd opcodes were "a different code path". They are not.
#
#   mode 6/1  county / state boundaries
#       T = 3 if op & 1 else 0   ->  100.00% closure, 10,001 records,
#       1,120/1,120 of the odd-opcode references resolve to a boundary name,
#       100.00% of anchors inside their own subdivision box (was 4.2% outside the tile)
#   mode 1/6
#       T = 1                    ->  100.00% closure, 100.00% in-box
#   modes 8/3 8/2 8/1 8/0 1/12 1/13 4/12 3/19   roads, shoreline, hydrography
#       T = 0                    ->  100.00% closure, 100.00% in-box
#   modes 3/1 (B) and 3/8 (C)    depth contours
#       use the tag-priority walk in rec_end(); 99.99% / 100.00% tag alignment
#   modes 5/3, 5/7               STILL OPEN -- variable attribute block opening `02 20`,
#                                the RGN2 grammar shape. 67 + 179 records.
#
# HI-RES IS REGION-SPECIFIC. Do not port v47's `prefix & 0x8000` rule to the line
# region. Scored on subdivision-box containment over four tiles:
#     hires = 4 always      99.89 - 100.00%
#     bits == maxbits       99.86 -  99.90%
#     prefix & 0x8000       22.86 -  88.87%
#     base top bit          22.86 -  88.87%
#     hires = 0             22.86 -  49.86%
# Lines want 4. Session A measured RGN4 points want 0, against ActiveCaptain. Both are
# right; they are different regions.
#
# EXTERNAL CONFIRMATION of all of the above, end to end: the NC/SC state line recovered
# from mode 6/1 on B4E0DA, compared against the Census 1:500,000 state boundary --
# a reference sharing no code, no format and no coordinate convention with the tile:
#     74 zoom-0 vertices, median 9 m, p90 17 m, max 20 m
# ---------------------------------------------------------------------------

LINE_ATTR = {
    "6/1": lambda op: 3 if op & 1 else 0,
    "1/6": lambda op: 1,
}
LINE_TAG_MODES = {"3/1", "3/8"}          # use rec_end() -- depth tag, not a constant tail

def line_tail(mode, op):
    """Constant trailing bytes after the selectors, for the non-contour line modes."""
    return LINE_ATTR.get(mode, lambda _o: 0)(op)

def walk_line_payload(b, mode, pool=None, label_fn=None):
    """Records in one line-region sub-block payload.

    Contour modes fall through to walk_payload(); everything else uses line_tail().
    Yields dicts with op, cw, sw, cnt, gstart, gend, end, and `ref` when bit 0 is set."""
    if mode in LINE_TAG_MODES:
        recs, used = walk_payload(b)
        return [dict(op=h["op"], cw=h["cw"], sw=h["sw"], cnt=h["cnt"], gstart=h["gstart"],
                     start=h["gstart"] - (1 + 2*h["cw"] + ((h["op"] >> 3) & 1) + 1),
                     gend=h["gend"], end=e, depth_dm=dm, ref=None)
                for h, dm, _al, e in recs], used
    out = []; q = 0; n = len(b)
    while q < n:
        op = b[q]
        cw = (op >> 6) + 1; sw = ((op >> 4) & 3) + 1; nw = ((op >> 3) & 1) + 1
        need = 1 + 2*cw + nw
        if q + need > n: break
        cnt = int.from_bytes(b[q+1+2*cw:q+need], "little")
        if cnt == 0: break
        a = q + need + cnt*sw
        e = a + line_tail(mode, op)
        if e > n: break
        ref = (b[a] | b[a+1] << 8 | b[a+2] << 16) if (op & 1 and a+3 <= n) else None
        out.append(dict(op=op, cw=cw, sw=sw, cnt=cnt, start=q, gstart=q+need, gend=a, end=e,
                        depth_dm=None, ref=ref))
        q = e
    return out, q
