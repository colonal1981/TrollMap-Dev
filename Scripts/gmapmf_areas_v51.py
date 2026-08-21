#!/usr/bin/env python3
"""GMAPMF area-region (RGN1) record walk. B2, 2026-08-01, partial.

Personal use only, not for distribution or resale; not for navigation.

GRAMMAR, in precedence order after the selectors:

  1. depth band `bc <lo> <hi> 02 10`      self-delimiting, 5 bytes,
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
BAND_TAG = 0xbc          # fine band, rides directly after the selectors
# TWO MORE BAND TAGS, AND THEY RIDE INSIDE THE ATTRIBUTE BLOCK.
#
# `bc` is the fine ladder and it is the only one this walker recognised, so every polygon using
# the other two was framed correctly, had its depth left inside an opaque `attr` blob, and was
# filed by regions_v51 as a generic "area" instead of bathymetry. On C4E0CE that is 5,699 depth
# polygons -- 4,935 coarse and 764 open -- routed away from the depth_areas layer.
#
#   bf <lo> <hi>    coarse band ladder, 0..238 dm. 35 distinct pairs, all ascending.
#   be <lo> 00      OPEN band: "deeper than <lo>", no upper bound. Second byte is always 0.
#
# `be` carries only three values ever -- 219, 238 and 253 dm (71.9, 78.1, 83.0 ft) -- the top
# three rungs of the ladder. GARMIN DOES NOT BAND BELOW 83 FT. It stops and marks the rest open,
# which is why no depth-area byte anywhere on the card exceeds one byte, and why hunting for a
# wider field here was hunting for something that does not exist.
#
# MEASURED, C4E0CE, within 6 km of Lake Jocassee's centroid: mean distance from the centre is
# 2,791 m for `be`, 3,051 m for `bf`, 3,240 m for `bc`, and the deepest `be` rung (253 dm) is the
# most central of all at 2,616 m. Deeper is more central. These are the deep-basin polygons.
BAND_COARSE = 0xbf
BAND_OPEN   = 0xbe

def walk(b, win=40):
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
        # The band tag is THREE bytes, `bc <lo> <hi>`.  `02 10` is a separate optional
        # attribute that follows it on the B tiles and is absent on C's coarse zooms.
        # Reading it as a 5-byte `bc lo hi 02 10` loses every record whose band has no
        # `02 10` -- 26% of mode 3/17's payload, which is the whole z2-z5 overview
        # shading on the C tiles.  See B2_AREA_3BYTE_BAND_2026-08-01.md.
        banded = a+3 <= n and b[a] == BAND_TAG
        if banded:
            band = (b[a+1], b[a+2]); e = a + 3
            if e+2 <= n and b[e] == 0x02 and b[e+1] == 0x10: e += 2
            if e+5 <= n and b[e] == 0x09: e += 5
        elif op & 2:
            r = a; hit = -1
            while r < min(n, a+win):
                if b[r] == 0x09 and r+5 <= n: hit = r; break
                r += 1
            if hit < 0: break
            attr = b[a:hit]; e = hit + 5
            # A depth band inside the attribute block is still a depth band. `hi` is None for an
            # open band -- the polygon has a floor and no ceiling, and inventing one would turn a
            # bound into a measurement.
            if len(attr) >= 3 and attr[0] in (BAND_COARSE, BAND_OPEN):
                band = (attr[1], None if attr[0] == BAND_OPEN else attr[2])
        ref = None
        if op & 1:
            if e+3 <= n: ref = b[e] | b[e+1] << 8 | b[e+2] << 16
            e += 3
        if e > n or e <= q: break
        out.append(dict(op=op, cw=cw, sw=sw, cnt=cnt, start=q, gstart=q+need, gend=a,
                        band=band, attr=attr, ref=ref, end=e))
        q = e
    return out, q
