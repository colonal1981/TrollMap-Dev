#!/usr/bin/env python3
"""GMAPMF area-region (RGN1) record walk. B2, 2026-08-01, partial.

Personal use only, not for distribution or resale; not for navigation.

GRAMMAR, in precedence order after the selectors:

  1. depth band `bc|bd|be|bf <lo8> <hi8>` or `dc|dd|de|df <a> <b> <c>`
                                          self-delimiting, 3 or 4 bytes, + `02 10` and
                                          + `09` + u32 trailer when present
  2. opcode bit 1 -> attribute block      variable, TERMINATED by `09` + u32
  3. opcode bit 0 -> 3-byte label ref     (present in the format; effectively unused
                                           in this region -- see below)

Order matters. Testing bit 1 before the band tag costs mode 3/17 45 points of closure and
mode 3/3 80, because a banded record can also have bit 1 set and the `09` scan then runs
past the band into the next record.

CLOSURE over B4E0F1 + B4E0DA + B4E0DB + C4E0F1: **93.22%**, 50,460 records
(18,655 banded, 8,258 attribute-only, 23,547 plain).

  100.00%  6/20 (12,838 records -- the largest area mode), 1/10, 3/8, 1/1, 1/11,
           11/19, 3/3, 3/4, 13/1, 11/8, 1/5
   97.73%  3/2
   73.81%  3/17   -- C's banded mode; needs the tag-priority scan, as the contour
                     line modes do. Use area_walk.rec_end from gmapmf_areas_v50_probe
                     for band alignment on C.
    ~0%    5/3, 5/12  -- variable block opening `02 20`, same shape as line modes 5/3
                         and 5/7. One unsolved grammar, four modes, both regions.

AREAS CARRY NO POOL-1 LABEL. Across four tiles only 4 area records have opcode bit 0 set
and none of their references resolve. Area names therefore have to come from the
local-field store (B3), like line names. Do not go looking for them in the record.

THE ATTRIBUTE BLOCKS ARE AN ENUMERABLE SET -- 14 distinct blobs in the whole region:

    3670 x  12 10 07 0f c6 02      mode 6/20, class A
    3501 x  12 10 07 0f 51 07      mode 6/20, class B
     917 x  40 02 10               mode 3/2   (the bank strip marker)
     109 x  02 10                  mode 6/20
      15 x  12 10 07 0f 9c 03      + 04 06 x13, 1b 06 x12, 78 06 x9, 57 03 x7
       5 x  (long one-offs in 5/12 and 3/17)

So mode 6/20's 12,838 polygons split into two roughly equal classes by a 2-byte code at
blob offset +4, plus a small tail. The 2-byte code does NOT resolve as a pool-1 label:
`u16@+1` appears to resolve for every blob, but that is the constant `10 07` = 1808
landing on a string start by coincidence -- the exact false positive Session A warned
about. The codes are class identifiers and still need a mapping.
"""
# THE DEPTH-BAND TAGS ARE A FAMILY, AND THE TWO LOW BITS ARE THE PAGE.
#
# A band is two depths, a floor and a ceiling, and the tag says how wide each field is and
# whether it has rolled over. `bc` and `bf` are not "fine" and "coarse" -- they are the SAME
# ladder with different page bits, which is why both of them carry (0,3) and (0,37) and
# (73,110). MEASURED 2026-08-22 by matching each ring's vertices to the contour vertices they
# are drawn from, on C4E0CC (North Saluda), C4E0C9 (Fontana) and C4E19A (Pamlico + offshore):
#
#                      floor+ceiling as written      with the page bits
#     bc   45,000 rings          99.5%                     99.5%
#     be    1,742 rings          25.7%                     97.0%
#     bf   23,725 rings           0.00%                    99.9%
#
# `bf` was wrong on every single record it ever produced. Two byte-identical families:
#
#     bc bd be bf  <lo8> <hi8>        floor = lo8 + 256*(tag&1),  ceiling = hi8 + 256*(tag>>1&1)
#     dc dd de df  <a> <b> <c>        two 12-bit fields nibble-packed into three bytes:
#                                       floor12   = a | (b & 0x0f) << 8
#                                       ceiling12 = (b >> 4) | c << 4
#                                     floor = floor12 + 4096*(tag&1)
#                                     ceiling = ceiling12 + 4096*(tag>>1&1)
#
# So bit 0 says the floor has rolled into the next page and bit 1 says the ceiling has. Which
# is why `bd` and `dd` do not exist anywhere on the card and never can: they would mean a floor
# one page above its own ceiling. Their absence is the proof the scheme is read right.
#
# THE THREE THINGS THIS REPLACES, ALL OF THEM WRONG:
#
#   * "`be <lo> 00` is an OPEN band, deeper than <lo>, no ceiling." It is not open. It is the
#     one band that straddles a page line, so its ceiling reads 0 because 256 mod 256 is 0.
#     `be 253 00` is 253-256 dm, a one-foot band. And the second byte is NOT always zero --
#     `be 219 37` is 21.9 m to 29.3 m and appears 288 times across these three tiles, with its
#     ceiling byte thrown away.
#   * "`be` carries only 219, 238 and 253, so Garmin does not band below 83 ft." Garmin bands
#     all the way down. Those three are simply the rungs that sit just under 256 dm.
#   * "The band is one byte and there is no wider field to find." 00_START_HERE.md said that,
#     and it was measured while the contour decoder was still capped at one byte too, so
#     nothing in the data was able to contradict it. The ceiling was confirming itself.
#
# RANGE. Eight-bit fields reach 511 dm (167.7 ft) and twelve-bit fields reach 8,191 dm
# (2,687 ft), which covers everything on this card -- the deepest contour anywhere in the
# freshwater set is Fontana at 1,280 dm and the offshore tiles top out under 8,000.
BAND_TAGS_8  = (0xbc, 0xbd, 0xbe, 0xbf)   # <lo8> <hi8>,      page = 256
BAND_TAGS_12 = (0xdc, 0xdd, 0xde, 0xdf)   # <a> <b> <c>,      page = 4096
BAND_TAG     = 0xbc                        # the one form that carries no bytes into `attr`

# `f8` is a one-byte tag that runs to the ordinary `09` + u32 trailer. It is not a band.
# Measured across nine tiles it appears only in mode 3/17: 1,343 records.
TRAILER_ONLY_TAG  = 0xf8

def _band(b, a, tag):
    """(floor_dm, ceiling_dm, bytes_consumed) for one band tag, or None if it is not one."""
    if tag in BAND_TAGS_8:
        return (b[a+1] + (256 if tag & 1 else 0),
                b[a+2] + (256 if tag & 2 else 0), 3)
    if tag in BAND_TAGS_12:
        lo = b[a+1] | ((b[a+2] & 0x0f) << 8)
        hi = (b[a+2] >> 4) | (b[a+3] << 4)
        return (lo + (4096 if tag & 1 else 0),
                hi + (4096 if tag & 2 else 0), 4)
    return None

def walk(b, win=40, tail=0):
    """Yield (record, end) for one area sub-block payload. Returns (records, consumed)."""
    out = []; q = 0; n = len(b)
    while q < n:
        op = b[q]
        cw = (op >> 6) + 1; sw = ((op >> 4) & 3) + 1; nw = ((op >> 3) & 1) + 1
        need = 1 + 2*cw + nw
        if q + need > n: break
        cnt = int.from_bytes(b[q+1+2*cw:q+need], "little")
        if cnt == 0: break
        a = q + need + cnt*sw
        e = a; band = None; attr = b""
        # AN ATTRIBUTE IS FOUND BY ITS TAG. `op & 2` DOES NOT PREDICT ONE.
        #
        # The band tag is THREE bytes, `bc <lo> <hi>`.  `02 10` is a separate optional
        # attribute that follows it on the B tiles and is absent on C's coarse zooms.
        # Reading it as a 5-byte `bc lo hi 02 10` loses every record whose band has no
        # `02 10` -- 26% of mode 3/17's payload, which is the whole z2-z5 overview
        # shading on the C tiles.  See B2_AREA_3BYTE_BAND_2026-08-01.md.
        #
        # `bc` was tested here unconditionally and the other five tags only inside `elif op & 2`.
        # That split is why mode 3/17 stalled on the marine tiles: a record with bit 1 clear and a
        # `bf`, `be`, `dc`, `de`, `df` or `f8` attribute left that attribute unconsumed, the next
        # pass read the tag byte as an opcode, and every record after it framed against the wrong
        # offset. Half of C4E19A's area region went unread that way -- 365,429 of 733,857 bytes,
        # and with them every depth area in Pamlico Sound.
        #
        # Each tag below is self-delimiting, so the opcode bit is not needed to find one. Bit 1
        # still selects the fallback: an untagged block that runs to a `09` + u32 trailer.
        #
        # MEASURED 2026-08-21 across nine tiles: 100.00% byte coverage on all nine, stalls
        # 151 -> 0 on C4E19A and 57 -> 0 on C4E0FD, and the three lake tiles that already closed
        # at 100% decode identically, record for record, attribute for attribute.
        tag = b[a] if a < n else None
        # A BAND BYTE CAN BE 0x09, AND 0x09 IS ALSO THE TRAILER MARKER.
        #
        # `bf 06 09` is a legitimate band whose ceiling byte is 9. Scanning the attribute block
        # for the first 0x09 finds THAT byte, ends the record three bytes early, and every
        # record after it in the sub-block is framed against the wrong offset -- which was the
        # whole of mode 3/17's 179 stalls and 214,326 abandoned bytes on C4E0CE. Both band forms
        # are self-delimiting, so read the band first and start the trailer scan after it.
        #
        # Measured on C4E0CE: byte coverage 94.40% -> 100.00%, stalls 179 -> 0, and the
        # depth_areas layer 102,637 -> 115,641 polygons.
        width = 3 if tag in BAND_TAGS_8 else (4 if tag in BAND_TAGS_12 else 0)
        if width and a + width <= n:
            lo, hi, width = _band(b, a, tag)
            band = (lo, hi); e = a + width
            # `bc` has never carried its own bytes into `attr` and 115,641 polygons a tile is
            # the reason to keep it that way; every other band tag always has.
            if tag != BAND_TAG: attr = b[a:e]
            if e+2 <= n and b[e] == 0x02 and b[e+1] == 0x10: e += 2
            if e+5 <= n and b[e] == 0x09: e += 5
        elif tag == TRAILER_ONLY_TAG or op & 2:
            r = a; hit = -1
            while r < min(n, a+win):
                if b[r] == 0x09 and r+5 <= n: hit = r; break
                r += 1
            if hit < 0: break
            attr = b[a:hit]; e = hit + 5
        ref = None
        if op & 1:
            if e+3 <= n: ref = b[e] | b[e+1] << 8 | b[e+2] << 16
            e += 3
        # `tail` exists so regions_v51 can retry a sub-block that will not close. It used to
        # live in a COPY of this function, which is how the bf/be bands above reached the first
        # attempt and not the retry -- the retry silently kept the one-tag grammar. One walker.
        e += tail
        if e > n or e <= q: break
        out.append(dict(op=op, cw=cw, sw=sw, cnt=cnt, start=q, gstart=q+need, gend=a,
                        band=band, attr=attr, ref=ref, end=e))
        q = e
    return out, q
