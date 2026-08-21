#!/usr/bin/env python3
"""Tile-level decoders for the LINE and AREA regions, on the corrected framing.

Personal use only, not for distribution or resale; NOT FOR NAVIGATION.

Replaces `gmapmf_decode_v40.decode_tile` (contours) and `gmapmf_area_v1.decode` (areas).
Both of those chain sub-blocks with a base prefix before EVERY header and validate headers
with a byte-pattern marker; both are wrong, and between them they cost 82% of the line
region and the whole unbanded half of the area region. See
B1_LINE_MODES_FIXED / B2_AREA_GRAMMAR / B2_PER_SUBBLOCK_AND_HUFFMAN.

What changes for the caller:
  * `contours` is unchanged in content (+2.3% in count) but now comes with the rest of the
    line region beside it, classified by sub-block mode;
  * areas gain a `lake_id` where the record carries one.
"""
import math, struct
from collections import Counter
import gmapmf_decode_v40 as V
import gmapmf_lines_v50 as L
import gmapmf_areas_v51 as AR
import gmapmf_labels_v50 as B

UNIT24 = 360.0 / (1 << 24)

# Sub-block mode -> layer. Modes not listed fall to "lines_other" so nothing is silently
# dropped; a mode moving between products shows up as a count change, not a hole.
LINE_CLASS = {
    "3/1": "contours", "3/8": "contours",          # B, C -- the only modes carrying depth tags
    "8/3": "roads_local", "8/2": "roads_secondary", "8/1": "roads_highway", "8/0": "roads_other",
    "4/12": "shoreline",
    "1/12": "hydrography", "1/13": "hydrography", "3/19": "hydrography",
    "6/1": "boundaries",
}
# Geometry not verified -- see B1. Emitted, but flagged, never silently mixed in.
LINE_UNVERIFIED = {"1/6", "5/3", "5/7"}

AREA_UNVERIFIED = {"5/3", "5/12"}

# B2: area sub-block mode -> layer, measured on B4E0F1 zoom 0 against the MAR safe-water
# mask and rendered per mode (see B2_AREA_CLASSES_2026-08-01.md).  Banded records keep
# their depth layer regardless of mode; this map covers the records that carry no band.
AREA_CLASS = {
    "1/1":   "docks",              # 2,292 on B4E0F1; median 48 m2; 97.9% within 15 m of the
                                   # water edge; one per lot, perpendicular to the bank
    "6/20":  "waterbody",          # named when the record carries a lake id, else unnamed
    "11/19": "waterbody",          # 412 of 424 rings are byte-identical to plain 6/20
    "1/10":  "land_fill",          # subdivision box with the named water body as a hole
    "13/1":  "tile_background",    # subdivision box, no holes, under everything
    "1/5":   "areas_other",
    "1/11":  "tile_background",   # C's single background mode; B splits it into 1/10 + 13/1
}
# 11/19 and un-idded 6/20 are the same features emitted twice.  Emit one.
AREA_DUPLICATE_OF = {"11/19": "6/20"}


def _tile_bounds(path):
    d = open(path, "rb").read()
    tre = struct.unpack_from("<I", d, 0x19)[0]
    t = d[tre:tre + 0x146]
    def s24(b, p):
        v = b[p] | b[p+1] << 8 | b[p+2] << 16
        return v - (1 << 24) if v & 0x800000 else v
    return [s24(t, o) * UNIT24 for o in (0x15, 0x18, 0x1b, 0x1e)]   # N, E, S, W


def _walk_geometry(b, rec, arc, base, clon, clat, q):
    """Selector list -> coordinate list, shared by both regions."""
    cw, sw = rec["cw"], rec["sw"]
    nw = ((rec["op"] >> 3) & 1) + 1
    hs = rec["gstart"] - (2 * cw + nw)
    def sv(o, w):
        v = int.from_bytes(b[o:o+w], "little"); k = 1 << (8*w - 1); return (v ^ k) - k
    lon, lat = clon + sv(hs, cw) * q, clat + sv(hs + cw, cw) * q
    pts = [(lon, lat)]
    mask = (1 << (8*sw - 1)) - 1; dbit = 1 << (8*sw - 1)
    miss = 0
    for k in range(rec["cnt"]):
        sr = int.from_bytes(b[rec["gstart"] + k*sw: rec["gstart"] + (k+1)*sw], "little")
        w = arc.way((sr & mask) + base)
        if w is None:
            miss += 1; continue
        seq = w[1]
        if sr & dbit: seq = [(-dx, -dy) for dx, dy in reversed(seq)]
        for dx, dy in seq:
            lon += dx * q; lat += dy * q; pts.append((lon, lat))
    return pts, miss


def decode_lines(path, zoom0_only=False):
    """Every feature in the line region, classified. Returns (features, stats)."""
    T = V.Tile(path); A = V.ArcStore(path, verbose=False)
    pool = B.lbl_pool(path)
    rows = [(s, ch) for _i, s, ch in T.chunks() if len(ch) >= 16]
    bw, frac = L.detect_bw([ch for _s, ch in rows])
    maxbits = max(l["bits"] for l in T.levels if l["count"])
    N, E, S, W = _tile_bounds(path)
    out = []; st = Counter(); st["bw"] = bw; st["rows_closing_pct"] = round(100 * frac, 2)
    for s, ch in rows:
        sbs = L.chain(ch, bw)
        if sbs is None:
            st["rows_unchained"] += 1; continue
        base = int.from_bytes(ch[:bw], "little")
        bits = s["bits"]; zoom = 24 - bits
        if zoom0_only and zoom != 0: continue
        q = 360.0 / (1 << (bits + 4))            # lines use hires=4; see B1
        clon, clat = s["lon_raw"] * UNIT24, s["lat_raw"] * UNIT24
        for hdr, b in sbs:
            mode = "%d/%d" % (hdr[0], hdr[1])
            recs, used = L.walk_line_payload(b, mode)
            st["bytes_total"] += len(b); st["bytes_used"] += used
            if used < len(b):
                # Nothing is discarded unseen.  The bytes we cannot frame are emitted
                # as their own record so a later grammar can be applied to the OUTPUT
                # instead of requiring a second pass over the card.
                st["subblock_stalls"] += 1; st["bytes_unparsed"] += len(b) - used
                out.append({"pts": [], "closed": False, "props": {
                    "layer": "unparsed", "mode": mode, "zoom": zoom,
                    "subdivision": s["si"], "sb_header": hdr.hex(),
                    "raw": b[used:].hex(), "bytes_unparsed": len(b) - used}})
            cls = LINE_CLASS.get(mode, "lines_other")
            sbh = hdr.hex()
            for r in recs:
                pts, miss = _walk_geometry(b, r, A, base, clon, clat, q)
                st["arc_missing"] += miss
                pr = {"layer": cls, "mode": mode, "zoom": zoom,
                      "subdivision": s["si"], "n_selectors": r["cnt"],
                      # RAW BYTES SURVIVE THE EXTRACTION.  An undecoded field is cheap;
                      # an unrecorded byte is a second pass over the card.
                      "raw": b[r["start"]:r["end"]].hex(), "sb_header": sbh}
                if len(pts) < 2:
                    # emitted, not dropped -- geometry unusable, bytes still carried
                    pr["layer"] = "degenerate"; pr["degenerate"] = True
                    st["degenerate"] += 1
                    out.append({"pts": pts, "props": pr, "closed": False})
                    continue
                if r.get("depth_dm") is not None:
                    dm = r["depth_dm"]
                    pr.update(depth_dm=dm, depth_ft=round(dm / 3.048, 1),
                              depth_m=round(dm / 10.0, 2))
                if r.get("ref"):
                    # POI_LABELS_SOLVED: pool offset = ref * 2. Session A's rule on top --
                    # drop ref < 8, because `01 00 00` is everywhere in padding and resolves
                    # to the product header string.
                    pr["ref"] = r["ref"]
                    nm = B.label(pool, r["ref"]) if r["ref"] >= 8 else None
                    if nm and nm != "Flattened Marine Map":
                        pr["name"] = nm.replace("\n", " ")
                        st["named"] += 1
                if mode in LINE_UNVERIFIED:
                    pr["unverified_geometry"] = True
                    st["unverified"] += 1
                out.append({"pts": pts, "props": pr, "closed": pts[0] == pts[-1]})
                st[cls] += 1
    st["coverage_pct"] = round(100 * st["bytes_used"] / max(1, st["bytes_total"]), 2)
    st["tag_aligned"], st["tag_raw"] = L.tag_alignment([ch for _s, ch in rows], bw)
    return out, st


def _walk_tail(b, tail):
    """AR.walk with `tail` extra bytes per record."""
    out = []; q = 0; n = len(b)
    while q < n:
        op = b[q]
        cw = (op >> 6) + 1; sw = ((op >> 4) & 3) + 1; nw = ((op >> 3) & 1) + 1
        need = 1 + 2*cw + nw
        if q + need > n: break
        cnt = int.from_bytes(b[q+1+2*cw:q+need], "little")
        if cnt == 0: break
        a = q + need + cnt*sw; e = a; band = None; attr = b""
        if a+3 <= n and b[a] == 0xbc:                 # 3-byte band; see AR.walk
            band = (b[a+1], b[a+2]); e = a + 3
            if e+2 <= n and b[e] == 0x02 and b[e+1] == 0x10: e += 2
            if e+5 <= n and b[e] == 0x09: e += 5
        elif op & 2:
            r = a; hit = -1
            while r < min(n, a+40):
                if b[r] == 0x09 and r+5 <= n: hit = r; break
                r += 1
            if hit < 0: break
            attr = b[a:hit]; e = hit + 5
        ref = None
        if op & 1:
            if e+3 <= n: ref = b[e] | b[e+1] << 8 | b[e+2] << 16
            e += 3
        e += tail
        if e > n or e <= q: break
        out.append(dict(op=op, cw=cw, sw=sw, cnt=cnt, start=q, gstart=q+need, gend=a,
                        band=band, attr=attr, ref=ref, end=e))
        q = e
    return out, q


def _inbox(b, rec, s, q):
    cw = rec["cw"]; nw = ((rec["op"] >> 3) & 1) + 1
    hs = rec["gstart"] - (2*cw + nw)
    def sv(o, w):
        v = int.from_bytes(b[o:o+w], "little"); k = 1 << (8*w - 1); return (v ^ k) - k
    hw = s["width"] * 360.0 / (1 << s["bits"]); hh = s["height"] * 360.0 / (1 << s["bits"])
    return abs(sv(hs, cw) * q) <= hw * 1.1 and abs(sv(hs+cw, cw) * q) <= hh * 1.1


def decode_areas(path, zoom0_only=False):
    """Every polygon in the area region, with a lake id where the record carries one."""
    from area_audit import area_rows
    T = V.Tile(path); A = V.ArcStore(path, verbose=False)
    rows = [(s, c) for _i, s, c in area_rows(T) if len(c) >= 16]
    bw, frac = L.detect_bw([c for _s, c in rows])
    out = []; st = Counter(); st["bw"] = bw; st["rows_closing_pct"] = round(100 * frac, 2)
    for s, ch in rows:
        sbs = L.chain(ch, bw)
        if sbs is None:
            st["rows_unchained"] += 1; continue
        base = int.from_bytes(ch[:bw], "little")
        bits = s["bits"]; zoom = 24 - bits
        if zoom0_only and zoom != 0: continue
        q = 360.0 / (1 << (bits + 4))
        clon, clat = s["lon_raw"] * UNIT24, s["lat_raw"] * UNIT24
        for hdr, b in sbs:
            mode = "%d/%d" % (hdr[0], hdr[1])
            # Per-sub-block tail, not per mode (Session A). Require exact closure, then
            # let the box invariant lead the score -- closure alone accepts a wrong tail.
            recs, used = AR.walk(b); tail = 0
            if used < len(b):
                best = None
                for t in range(1, 10):
                    r2, u2 = _walk_tail(b, t)
                    if u2 == len(b):
                        viol = sum(1 for x in r2 if not _inbox(b, x, s, q))
                        cand = (-viol, len(r2), -t)
                        if best is None or cand > best[0]: best = (cand, r2, u2, t)
                if best: _c, recs, used, tail = best
            st["tail_%d" % tail] += 1
            st["bytes_total"] += len(b); st["bytes_used"] += used
            if used < len(b):
                st["subblock_stalls"] += 1; st["bytes_unparsed"] += len(b) - used
                out.append({"pts": [], "props": {
                    "layer": "unparsed", "mode": mode, "zoom": zoom,
                    "subdivision": s["si"], "sb_header": hdr.hex(),
                    "raw": b[used:].hex(), "bytes_unparsed": len(b) - used}})
            sbh = hdr.hex()
            for r in recs:
                pts, miss = _walk_geometry(b, r, A, base, clon, clat, q)
                st["arc_missing"] += miss
                at = r["attr"]
                pr = {"mode": mode, "zoom": zoom, "subdivision": s["si"],
                      "n_selectors": r["cnt"],
                      "raw": b[r["start"]:r["end"]].hex(), "sb_header": sbh,
                      "sb_tail": tail}
                if at:
                    pr["attr"] = at.hex(" ")          # ALWAYS, not only on the else branch
                if len(pts) < 4:
                    pr["layer"] = "degenerate"; pr["degenerate"] = True
                    st["degenerate"] += 1
                    out.append({"pts": pts, "props": pr}); continue
                if r["band"]:
                    lo, hi = r["band"]
                    # AN OPEN BAND HAS A FLOOR AND NO CEILING. `be <lo> 00` is Garmin's "deeper
                    # than <lo>", and it is the deepest thing on the card -- there is no band
                    # below 83 ft, only this. Writing `depth_max_dm = lo` would turn a lower
                    # bound into a measurement and cap every deep lake at its shallowest possible
                    # reading, which is the mistake the one-byte contour depth already made once.
                    if hi is None:
                        pr.update(depth_min_dm=lo, depth_max_dm=None,
                                  depth_min_ft=round(lo / 3.048), depth_max_ft=None,
                                  open_band=True,
                                  band="deeper than %d ft" % round(lo / 3.048))
                    else:
                        pr.update(depth_min_dm=lo, depth_max_dm=hi,
                                  depth_min_ft=round(lo / 3.048), depth_max_ft=round(hi / 3.048),
                                  band="%d-%d ft" % (round(lo / 3.048), round(hi / 3.048)))
                    pr["layer"] = "depth_areas"; st["depth_areas"] += 1
                elif len(at) >= 6 and at[:4] == b"\x12\x10\x07\x0f":
                    # B2: the u16 at +4 of a `12 10 07 0f` attribute is a WATER-BODY ID.
                    # Gate on the prefix, never on length -- a short attribute is not an id.
                    pr["lake_id"] = at[4:6].hex(" ")
                    pr["layer"] = "waterbody"; pr["named"] = True
                    st["waterbody_named"] += 1
                elif at:
                    pr["layer"] = "areas"; st["areas"] += 1
                else:
                    pr["layer"] = AREA_CLASS.get(mode, "areas_other")
                    st[pr["layer"]] += 1
                    if mode in AREA_DUPLICATE_OF:
                        pr["duplicate_of_mode"] = AREA_DUPLICATE_OF[mode]
                        st["duplicate_rings"] += 1
                if mode in AREA_UNVERIFIED:
                    pr["unverified_geometry"] = True; st["unverified"] += 1
                out.append({"pts": pts, "props": pr})
    st["coverage_pct"] = round(100 * st["bytes_used"] / max(1, st["bytes_total"]), 2)
    return out, st
