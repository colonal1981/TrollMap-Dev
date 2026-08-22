#!/usr/bin/env python3
"""trollmap_extract_all.py - ONE pass over a Garmin GMAPMF tile (or the whole card) that
pulls out every layer we know how to decode.

Personal use only, not for distribution or resale; NOT FOR NAVIGATION.

    python trollmap_extract_all.py F:\\TrollMapPipeline\\garmin\\charts\\Tiles --out F:\\TrollMapPipeline\\extract --jobs 4
    python trollmap_extract_all.py B4E0F1.GMP --out ./out

--JOBS IS A NUMBER ABOUT THE MACHINE, AND THIS LINE USED TO SAY 12.

The argparse default is 1. The 12 in this usage line was copied into the re-extract runbook as
though it were a setting, and on 2026-08-21 it thrashed Ryan's computer badly enough to take the
Cowork bridge VM down mid-run. He watched it finish anyway: "jobs --12 not a good idea... this is
thrashing my computer but i will let it run."

THE CEILING IS RAM, NOT CORES. --jobs feeds ProcessPoolExecutor(max_workers=N), so each job is a
full Python process holding one entire decoded tile in memory -- C4E0CE alone is 155,252 contours.
Twelve of those at once, alongside whatever else the machine is doing, is the problem.

4 is a back-off, not a measurement. Time a fixed --tiles list at 2, 4 and 6 on the actual machine
and put the winner here. A command in a docstring is a dependency: 00_START_HERE.md says so, and
this line is what it was talking about.

Layers produced, one GeoJSON per tile per layer, named the way TrollMap's R2 layout expects:

    contours/<TILE>.geojson      LineStrings   depth_ft, depth_m, zoom          (RGN3, B and C)
    depth_areas/<TILE>.geojson   Polygons      depth_min_ft, depth_max_ft, band (RGN2 `bc` bands)
    waterbodies/<TILE>.geojson   Polygons      area_m2                          (RGN2, no attribute)
    areas/<TILE>.geojson         Polygons      attr, ac_hint                    (RGN2, other attrs)
    pois/<TILE>.geojson          Points        type, name, detail               (RGN4, B tiles only)

B vs C, decided from the file rather than the filename:
    C tiles declare RGN4 with LENGTH 0 and carry a 62-byte label pool - no names at all.
    B tiles carry RGN4 (27 KB on Wateree) and a 5,736-byte pool + 10 KB instance blob.
So POIs only ever come from B. Contours and depth bands come from both; pick per the
B-vs-C reconciliation note before deciding which to ship.

Resumable (skips a tile whose outputs all exist), parallel (--jobs), and every tile is
isolated - one bad tile cannot kill the run.

Requires, in the same directory:
    gmapmf_regions_v51.py    line + area regions (needs gmapmf_lines_v50, gmapmf_areas_v51,
                             gmapmf_labels_v50, gmapmf_decode_v40 for Tile/ArcStore, area_audit)
    rgn4_pois.py             RGN4 POIs, navaids and business cards
"""
from __future__ import annotations
import argparse, gzip, json, math, os, re, struct, sys, traceback
from collections import Counter
from concurrent.futures import ProcessPoolExecutor, as_completed

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path: sys.path.insert(0, HERE)

# The AREA layer names MUST match gmapmf_regions_v51.AREA_CLASS exactly. decode_areas() buckets
# by the `layer` it puts on each feature, and the extractor only writes buckets whose name it
# already knows -- so a name that drifts produces an EMPTY layer and a clean exit rather than an
# error. That is what happened when B2_AREA_CLASSES renamed the classes on 2026-08-01: the
# decoder started emitting `waterbody` and `docks`, this list still said `waterbodies` and
# `shoreline_docks`, and both came out 0 on tiles that hold 2,225 and 2,292 polygons.
LAYERS = ("contours", "shoreline", "hydrography", "roads", "boundaries", "lines_other",
          "depth_areas", "waterbody", "docks", "land_fill", "tile_background",
          "areas", "areas_other", "pois", "labels")
AREA_LAYERS = ("depth_areas", "waterbody", "docks", "land_fill",
               "tile_background", "areas", "areas_other")

# decode_lines / decode_areas return a per-feature `layer`; roads_* collapse to one file.
def _layer_file(name):
    return "roads" if name.startswith("roads") else name
NOTE = "Personal use only, not for distribution or resale; not for navigation."

def u16(b, p): return struct.unpack_from("<H", b, p)[0]
def u32(b, p): return struct.unpack_from("<I", b, p)[0]

def tile_kind(path):
    """('B'|'C', rgn4_len, lbl_pool_len) read from the headers, not the filename."""
    with open(path, "rb") as f:
        root = f.read(0x3D)
        if root[2:12] != b"GMAPMF GMP": return None, 0, 0
        f.seek(u32(root, 0x1D)); rgn = f.read(0x7D)
        f.seek(u32(root, 0x21)); lbl = f.read(0x40)
    r4l = u32(rgn, 0x59); pool = u32(lbl, 0x19)
    return ("B" if r4l else "C"), r4l, pool

def area_m2(pts):
    if len(pts) < 3: return 0.0
    lat0 = sum(q[1] for q in pts) / len(pts); k = math.cos(math.radians(lat0)); a = 0.0
    for i in range(len(pts)):
        x1, y1 = pts[i]; x2, y2 = pts[(i + 1) % len(pts)]
        a += (x1 * k) * y2 - (x2 * k) * y1
    return abs(a / 2.0) * (111320.0 ** 2)

def ring(pts):
    """Close a polygon ring. Returns None for anything that cannot be one.

    This used to index r[0] unconditionally and raised IndexError on an empty point list. The
    exception propagated out of extract_tile(), so ONE degenerate record killed the tile: C4E0F0
    lost all 14,514 of its depth bands and landed in _failures.json as
    `IndexError: list index out of range`, with nothing to say which record or which layer.
    Card-wide that is a whole tile's shading lost to a single empty list, and the failure list
    gives no clue it is a data condition rather than a decode crash.

    A ring needs three distinct points. Fewer is a degenerate record, not an error, so it is
    dropped and counted rather than raised.
    """
    if len(pts) < 3: return None
    r = [[round(x, 7), round(y, 7)] for x, y in pts]
    if r[0] != r[-1]: r.append(r[0])
    return r if len(r) >= 4 else None

def fc(feats, src, layer):
    return {"type": "FeatureCollection",
            "properties": {"source": os.path.basename(src), "layer": layer,
                           "generator": "trollmap_extract_all.py", "note": NOTE},
            "features": feats}


# ---------------------------------------------------------------------------
# A1: every emitted feature must lie inside the tile it came from.
#
# `arc_missing` is real and it produces coordinates that are not merely off, they are absurd:
# on C4E0F0, 95,266 contour vertices (1.8%) land outside the tile's own declared box and the
# worst is 79,866 DEGREES from it. Unclipped these draw lines across the continent.
#
# The rule is drop-the-feature, not clip-the-vertex. A stray vertex means the delta chain
# desynced, so the rest of that feature's geometry is not trustworthy either -- keeping the
# in-range half would silently ship a wrong contour instead of an obviously wrong one.
#
# Tolerance 1e-3 deg (~110 m) separates the two populations cleanly. Measured on C4E0F0:
#   214 features have a vertex outside the box at ANY tolerance
#   122 features have one beyond 1e-3     <- corruption, dropped
#    92 are within 1e-3                   <- ordinary edge rounding, kept
# Cost: 122 of 100,163 features, 0.12%.
BOUNDS_TOL_DEG = 1e-3


def in_tile(pts, box, tol=BOUNDS_TOL_DEG):
    """True if every point is inside the tile box within tol. box = (w, s, e, n)."""
    if not box:
        return True
    w, s, e, n = box
    for x, y in pts:
        if x < w - tol or x > e + tol or y < s - tol or y > n + tol:
            return False
    return True


# ---------------------------------------------------------------------------
# A2: mode 1/1 sanity bounds.
#
# 1/1 is shore structure -- it sits on ramps and docks alike (4 of 4 SCDNR Wateree ramps
# within 18 m; the lone 104 m2 polygon at Dawhoo is the state forest ramp). But the raw
# stream carries two kinds of junk that must not ship:
#
#   * exactly ONE ~0.037 x 0.044 degree rectangle per tile -- 12 to 17 MILLION m2. It is a
#     framing artifact, identical in shape on B4E0F6, B4E0F1 and B4E0FC. A dock is not
#     4 km across.
#   * 27-36% of records under 5 m2. A 2 m2 polygon is not a structure at any zoom.
#
# The Wateree pack ALREADY IN R2 has 16,792 "docks" and therefore contains one blob and
# several thousand specks. Real ramps measured 43.8 / 58.2 / 104.2 / 186.2 / 286.4 m2 and
# the dock median is 31.8 m2, so both cuts clear the real population by a wide margin.
STRUCT_MIN_M2 = 5.0
STRUCT_MAX_M2 = 10000.0


def s24(b, p):
    v = b[p] | b[p+1] << 8 | b[p+2] << 16
    return v - (1 << 24) if v & 0x800000 else v

UNIT24 = 360.0 / (1 << 24)

def label_inventory(path, tid, kind):
    """Every string in the tile's LBL, with the tile's bounds, as one small JSON.

    The pool is not one flat list -- it has three regions, and conflating them is what made
    `type` resolution unreliable:

      region 1  multi-language TYPE concept blocks. IDENTICAL IN EVERY TILE, so `types` is
                2,589 copies of one list -- dedupe it at merge time. Each concept is ~30 consecutive
                translations with the ENGLISH name first and a non-Latin entry second.
                This region is PRODUCT-WIDE: it is the same vocabulary in every tile, so a
                name appearing here is NOT evidence the tile contains one.
      region 2  place names (towns, counties, ponds) -- single language.
      region 3  per-tile INSTANCE labels: marina and ramp names, and the feature names we
                have been hunting (Hazard Area, Flooded Timber, Shallow Area). A name here
                IS evidence the tile carries that feature.

    Region 1 ends at the last non-Latin entry, which is detectable. The region 2 / 3 boundary
    is not cleanly detectable, so this does NOT guess it -- every entry past region 1 is
    emitted with its offset and downstream can classify. `types` carries the concept heads,
    which ARE reliably detectable (ASCII entry immediately followed by a non-Latin one).

    C tiles carry a 62-byte pool holding only the copyright, so this is effectively B-only;
    C files are still written so the layer is complete and resume works.
    """
    d = open(path, "rb").read()
    root = d[:0x3D]
    tre_at = u32(root, 0x19); tre = d[tre_at:tre_at+0x30]
    lat = u32(root, 0x21); lbl = d[lat:lat+u16(d, lat)]
    ps, pl = u32(lbl, 0x15), u32(lbl, 0x19)
    pool = d[ps:ps+pl]
    bs, bl = u32(lbl, 0x0de), u32(lbl, 0x0e2)
    blob = d[bs:bs+bl] if 0 < bl < len(d) else b""

    ent = []
    p = 0
    while p < len(pool):
        e = pool.find(b"\x00", p)
        e = len(pool) if e < 0 else e
        if e > p:
            try: ent.append((p, pool[p:e].decode("utf-8")))
            except UnicodeDecodeError: ent.append((p, None))
        p = e + 1
    def asc(t): return t is not None and t.isascii() and any(c.isalpha() for c in t)
    def foreign(t): return t is not None and any(ord(c) > 0x2000 for c in t)
    def arabic(t):  return t is not None and any(0x600 <= ord(c) <= 0x6FF for c in t)

    r1_end = max((o for o, t in ent if foreign(t)), default=-1)
    # A concept head is the ENGLISH entry that opens a translation block. "ASCII followed by
    # a non-Latin entry" alone is not enough -- Estonian and Italian translations sit mid-block
    # and are also ASCII, so that rule returns 'Minimaalne lainetus' and 'Scia minima' as if
    # they were heads. Blocks run ~30 entries, so keep only the first candidate per block.
    # The block's SECOND entry is specifically Arabic. Testing "any non-Latin" instead lets
    # CJK entries qualify -- 'Scia minima' is followed by CJK -- which adds candidates and
    # breaks the spacing rule below. Farsi also sits ~9 entries into each block and is Arabic
    # script, so keep only the first candidate per ~35-entry block.
    types = []; last = -99
    for i, (o, t) in enumerate(ent):
        if asc(t) and i + 1 < len(ent) and arabic(ent[i+1][1]) and i - last >= 15:
            types.append({"off": o, "text": t}); last = i
    strings = [{"off": o, "text": t} for o, t in ent if o > r1_end and asc(t)]

    gml = []
    for m in re.finditer(rb"<gml>(.{0,400}?)</gml>", blob, re.S):
        txt = "".join(chr(c) if 0x20 <= c < 0x7f else " " for c in m.group(1))
        gml.append({"off": m.start(), "text": re.sub(r"\s+", " ", txt).strip()})

    return {"tile": tid, "kind": kind,
            "bounds": {"north": round(s24(tre, 0x15)*UNIT24, 6),
                       "east":  round(s24(tre, 0x18)*UNIT24, 6),
                       "south": round(s24(tre, 0x1B)*UNIT24, 6),
                       "west":  round(s24(tre, 0x1E)*UNIT24, 6)},
            "pool": {"offset": ps, "length": pl, "region1_ends_at": r1_end},
            "types": types, "strings": strings, "gml": gml,
            "note": NOTE}

def extract_tile(path, outdir, want, zoom0_only, min_area, gz=False):
    """Decode one tile into every requested layer. Returns a stats dict; never raises."""
    global GZIP
    GZIP = gz                                  # set per worker process, not inherited
    tid = os.path.splitext(os.path.basename(path))[0]
    res = {"tile": tid, "ok": True, "counts": {}, "error": None}
    try:
        kind, r4l, pool = tile_kind(path)
        if kind is None:
            res.update(ok=False, error="not a GMAPMF GMP"); return res
        res["kind"] = kind

        # ---- LINE region (contours + roads + shoreline + hydrography + boundaries) ----
        # Was gmapmf_decode_v40.decode_tile, which chained sub-blocks with a base prefix
        # before EVERY header and validated headers by a byte pattern. Both wrong: it read
        # 722 of B4E0F1's 2,183 sub-blocks and emitted 6,551 of 37,034 records. It also
        # used the depth tag as the record delimiter, so every feature WITHOUT a depth tag
        # -- the whole road network, the shoreline, the hydrography, the county boundaries --
        # was dropped. See B1_LINE_MODES_FIXED_2026-08-01.
        line_layers = {"contours", "shoreline", "hydrography", "roads", "boundaries",
                       "lines_other"} & set(want)
        if line_layers:
            import gmapmf_regions_v51 as RG
            lf, lst = RG.decode_lines(path, zoom0_only)
            n, e, s, w = RG._tile_bounds(path)
            box = (w, s, e, n)
            buckets = {}
            noob = 0
            for f in lf:
                if not in_tile(f["pts"], box):
                    noob += 1; continue
                pr = dict(f["props"]); pr["tile"] = tid
                buckets.setdefault(_layer_file(pr["layer"]), []).append(
                    {"type": "Feature", "properties": pr,
                     "geometry": {"type": "LineString",
                                  "coordinates": [[round(x, 7), round(y, 7)] for x, y in f["pts"]]}})
            if noob:
                res["counts"]["lines_out_of_tile"] = noob
            # QA. Byte coverage is NOT the correctness metric here -- a desynced walk still
            # consumes every byte (99.14% coverage at 11.8% tag alignment, measured). TAG
            # ALIGNMENT is: what fraction of raw depth tags land exactly at a record boundary.
            aligned, rawtags = lst["tag_aligned"], lst["tag_raw"]
            con = buckets.get("contours", [])
            st = []
            for f in con:
                c = f["geometry"]["coordinates"]
                for u, v in zip(c, c[1:]):
                    st.append(math.hypot((u[0]-v[0])*92000.0, (u[1]-v[1])*111320.0))
            st.sort()
            qa = {"base_width": lst["bw"], "rows_closing_pct": lst["rows_closing_pct"],
                  "byte_coverage_pct": lst["coverage_pct"],
                  "tag_alignment": "%d/%d" % (aligned, rawtags),
                  "tag_alignment_pct": round(100 * aligned / rawtags, 2) if rawtags else None,
                  "arc_missing": lst["arc_missing"], "n_contours": len(con)}
            if st:
                med = st[len(st)//2]
                qa.update(median_step_m=round(med, 2), p99_step_m=round(st[int(0.99*len(st))], 1),
                          max_step_m=round(st[-1], 1))
            qa["suspect"] = bool(lst["rows_closing_pct"] < 99.0
                                 or (rawtags and aligned / rawtags < 0.98)
                                 or (st and st[-1] > 5000.0)
                                 or (len(con) >= 200 and st and not (6.0 <= st[len(st)//2] <= 25.0)))
            if qa["suspect"]:
                res["suspect"] = True
            for name in ("contours", "shoreline", "hydrography", "roads", "boundaries", "lines_other"):
                if name not in want: continue
                doc = fc(buckets.get(name, []), path, name)
                if name == "contours": doc["properties"]["qa"] = qa
                _write(outdir, name, tid, doc)
                res["counts"][name] = len(buckets.get(name, []))

        # ---- AREA region -----------------------------------------------------
        # Was gmapmf_area_v1.decode, which carries the identical chain defect. The grammar
        # is: depth band `bc lo hi 02 10` (self-delimiting) FIRST, then an opcode-bit-1
        # attribute block terminated by `09`+u32, then an opcode-bit-0 label ref -- and the
        # tail is per SUB-BLOCK, not per mode. Testing bit 1 before the band costs mode 3/17
        # 45 points of closure. See B2_AREA_GRAMMAR / B2_PER_SUBBLOCK_AND_HUFFMAN.
        area_layers = set(AREA_LAYERS) & set(want)
        if area_layers:
            import gmapmf_regions_v51 as RG
            af, ast = RG.decode_areas(path, zoom0_only)
            n, e, s, w = RG._tile_bounds(path)
            abox = (w, s, e, n)
            ab = {}
            ndegen = noob = nstruct = 0
            for f in af:
                a = area_m2(f["pts"])
                if a < min_area: continue
                if not in_tile(f["pts"], abox):
                    noob += 1; continue
                pr = dict(f["props"]); pr["tile"] = tid; pr["area_m2"] = round(a, 1)
                # A2: docks/1-1 only. Depth bands and waterbodies are legitimately huge and
                # legitimately tiny, so the cut is applied to the structure layer alone.
                if pr.get("layer") == "docks" and not (STRUCT_MIN_M2 <= a <= STRUCT_MAX_M2):
                    nstruct += 1; continue
                rg = ring(f["pts"])
                if rg is None:
                    ndegen += 1; continue
                ab.setdefault(pr["layer"], []).append(
                    {"type": "Feature", "properties": pr,
                     "geometry": {"type": "Polygon", "coordinates": [rg]}})
            if ndegen: res["counts"]["areas_degenerate"] = ndegen
            if noob: res["counts"]["areas_out_of_tile"] = noob
            if nstruct: res["counts"]["docks_out_of_size"] = nstruct
            aqa = {"base_width": ast["bw"], "rows_closing_pct": ast["rows_closing_pct"],
                   "byte_coverage_pct": ast["coverage_pct"],
                   "arc_missing": ast["arc_missing"],
                   "suspect": bool(ast["rows_closing_pct"] < 99.0 or ast["coverage_pct"] < 85.0)}
            if aqa["suspect"]:
                res["suspect"] = True
            for name in AREA_LAYERS:
                if name not in want: continue
                doc = fc(ab.get(name, []), path, name)
                if name == "depth_areas": doc["properties"]["qa"] = aqa
                _write(outdir, name, tid, doc)
                res["counts"][name] = len(ab.get(name, []))

        # ---- labels (LBL string pool + <gml> blob) ---------------------------
        if "labels" in want:
            _write(outdir, "labels", tid, label_inventory(path, tid, kind))
            res["counts"]["labels"] = 1

        # ---- POIs (RGN4) - B tiles only --------------------------------------
        # rgn4_pois.extract() REPLACES gmapmf_poi_v3.extract(). v3's named POIs all came from
        # its _containers() pass, which had three independent disqualifying defects: it never
        # chained sub-blocks (so every feature carried the wrong mode), its -7 head offset
        # matched a real record head 0 times in 238, and it therefore read coordinates from
        # arbitrary mid-record bytes -- a median 4.6-10.5 km from the true position. v3 also
        # applied `hires = 4` at the deepest level, which RGN4 does not use at all and which
        # cost a further 690-746 m there.
        #
        # rgn4_pois returns (T, [(lat, lon, props)], stats, card_offsets) rather than GeoJSON
        # features, so it is wrapped here. Every emitted record satisfies |dx| <= subdivision
        # width and |dy| <= height (1 violation in 3,791 named records across three tiles), and
        # named marinas land 14-40 m from ActiveCaptain's independent survey.
        if "pois" in want:
            if kind == "B":
                from rgn4_pois import extract as poi_extract
                _T, pts, _st, _co = poi_extract(path)
                pf = []
                for lat, lon, pr in pts:
                    pr = dict(pr); pr["tile"] = tid
                    pf.append({"type": "Feature", "properties": pr,
                               "geometry": {"type": "Point",
                                            "coordinates": [round(lon, 6), round(lat, 6)]}})
                _write(outdir, "pois", tid, fc(pf, path, "pois"))
                res["counts"]["pois"] = len(pf)
                for k in ("box_violation", "out_of_tile", "navaids_gated_out_vocab_residue"):
                    if _st.get(k): res["counts"]["pois_" + k] = _st[k]
            else:
                # C declares RGN4 with length 0 - there are no POIs to find. Still write the
                # empty collection, or --resume would re-run every C tile forever.
                _write(outdir, "pois", tid, fc([], path, "pois"))
                res["counts"]["pois"] = 0
    except Exception as e:
        res.update(ok=False, error="%s: %s" % (type(e).__name__, e),
                   trace=traceback.format_exc()[-600:])
    return res

GZIP = False

def _ext(layer):
    return ".json" if layer == "labels" else ".geojson"

def _write(outdir, layer, tid, doc):
    d = os.path.join(outdir, layer); os.makedirs(d, exist_ok=True)
    base = os.path.join(d, tid + _ext(layer))
    if GZIP:
        with gzip.open(base + ".gz", "wt", encoding="utf-8", compresslevel=6) as f:
            json.dump(doc, f, ensure_ascii=False)
    else:
        with open(base, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False)

def done(outdir, tid, want):
    """Is every requested layer present AND READABLE for this tile?

    Existence alone is not enough, and that cost a whole run. Ryan's machine went down
    during the C pass at --jobs 12 with workers mid-write; the truncated outputs still
    existed, so the --jobs 3 resume skipped them and four tiles carried half-written
    depth_areas all the way to the chartpack build:

        C4E0CC  386 KB   truncated at char 2,740,896
        C4E0E6   34 MB   truncated at char 188,355,131
        C4E0E7   19 MB   truncated at char 105,743,193
        C4E1A1   26 MB   truncated at char 148,643,934

    Not a size effect -- C4E0E4 at 75 MB is intact. It is simply whatever was open when the
    process died. A gzip trailer check catches exactly this: a truncated .gz has no valid
    CRC, and reading the last block is cheap next to re-decoding the tile.
    """
    suf = ".gz" if GZIP else ""
    for l in want:
        fp = os.path.join(outdir, l, tid + _ext(l) + suf)
        if not os.path.exists(fp):
            return False
        if suf:
            try:
                with gzip.open(fp, "rb") as f:
                    while f.read(1 << 20):
                        pass
            except Exception:
                return False
    return True

def find_tiles(root, letters):
    if os.path.isfile(root): return [root]
    out = []
    for dp, _dn, fn in os.walk(root):
        for n in fn:
            if n.upper().endswith(".GMP") and n[0].upper() in letters:
                out.append(os.path.join(dp, n))
    return sorted(out)

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("path", help="a .GMP file, or the Tiles directory to walk")
    ap.add_argument("--out", required=True)
    ap.add_argument("--layers", default=",".join(LAYERS),
                    help="comma-separated subset of: " + ", ".join(LAYERS))
    ap.add_argument("--letters", default="BC", help="tile letters to process (default BC)")
    ap.add_argument("--jobs", type=int, default=1)
    ap.add_argument("--limit", type=int)
    ap.add_argument("--tiles",
                    help="tile ids: comma-separated (4E0F1,4E0F0), or a path to a file with one "
                         "per line, with or without a leading @. A leading tile letter is "
                         "stripped, so B4E0F1, C4E0F1 and 4E0F1 all mean the same tile. "
                         "outputs/ship_tiles.txt is the list the shipped lakes actually touch; "
                         "consolidate_lake_index.py writes it.")
    ap.add_argument("--zoom0-only", action="store_true", help="most detailed level only")
    ap.add_argument("--min-area", type=float, default=0.0, help="drop polygons below this m2")
    ap.add_argument("--force", action="store_true", help="re-do tiles that already have output")
    ap.add_argument("--gzip", action="store_true",
                    help="write .geojson.gz instead of .geojson (about 5x smaller)")
    a = ap.parse_args()

    global GZIP
    GZIP = a.gzip
    want = tuple(x for x in a.layers.split(",") if x in LAYERS)
    if not want: sys.exit("no valid layers in --layers")
    tiles = find_tiles(a.path, set(a.letters.upper()))
    if a.tiles:
        # Accept @file as well as a comma list, and normalise the tile letter away.
        #
        # tile_lake_map.py writes FULL ids one per line (B4E0FC), because that is what the
        # label files are named. This matcher compares against `basename[1:]` -- the id with
        # its letter stripped -- so feeding that list in verbatim matched ZERO tiles and the
        # run exited cleanly having done nothing. That is the silent-zero failure the guide
        # already records twice. Strip a leading letter from whatever is supplied so
        # B4E0FC, C4E0FC and 4E0FC all name the same tile, which they do.
        # A BARE PATH, WITH OR WITHOUT THE @.
        #
        # `@` is a PowerShell landmine -- `@"` opens a here-string, so `--tiles @"F:\x.txt"`
        # dies with "No characters are allowed after a here-string header", and a bare `@F:\...`
        # reads as the splat operator. build_all_chartpacks._slug_list took the bare path for
        # exactly this reason on 2026-08-03 and this flag never did, so the only spelling that
        # worked here was one nobody would guess.
        src = a.tiles
        if src.startswith("@"):
            src = src[1:]
        if os.path.exists(src):
            with open(src, encoding="utf-8") as f:
                src = ",".join(ln.strip() for ln in f if ln.strip())
        keep = set()
        for t in src.replace("\n", ",").split(","):
            t = t.strip().upper()
            if not t:
                continue
            keep.add(t[1:] if t[0].isalpha() and len(t) > 1 else t)
        tiles = [t for t in tiles if os.path.splitext(os.path.basename(t))[0][1:] in keep]
        if not tiles:
            sys.exit("--tiles matched 0 tiles under %s. Ids given: %s..."
                     % (a.path, ", ".join(sorted(keep)[:5])))
    if not a.force:
        tiles = [t for t in tiles if not done(a.out, os.path.splitext(os.path.basename(t))[0], want)]
    if a.limit: tiles = tiles[:a.limit]
    os.makedirs(a.out, exist_ok=True)
    print("%d tiles, layers: %s, jobs %d" % (len(tiles), ",".join(want), a.jobs))
    if not tiles: print("nothing to do (use --force to redo)"); return

    tot, fails, suspect, n = Counter(), [], [], 0
    def absorb(r):
        nonlocal n
        n += 1
        if r["ok"]:
            for k, v in r["counts"].items(): tot[k] += v
            if r.get("suspect"): suspect.append(r["tile"])
        else:
            fails.append((r["tile"], r["error"]))
        if n % 25 == 0 or n == len(tiles):
            print("  %d/%d  %s  failures %d"
                  % (n, len(tiles), " ".join("%s=%d" % kv for kv in sorted(tot.items())), len(fails)),
                  flush=True)

    if a.jobs > 1:
        with ProcessPoolExecutor(max_workers=a.jobs) as ex:
            futs = [ex.submit(extract_tile, t, a.out, want, a.zoom0_only, a.min_area, a.gzip) for t in tiles]
            for f in as_completed(futs): absorb(f.result())
    else:
        for t in tiles: absorb(extract_tile(t, a.out, want, a.zoom0_only, a.min_area, a.gzip))

    print("\nDONE  %d tiles" % len(tiles))
    for k, v in sorted(tot.items()): print("   %-14s %d" % (k, v))
    if suspect:
        print("   SUSPECT geometry (median step outside 6-20 m, or a >5 km segment): %d"
              % len(suspect))
        print("     %s" % ", ".join(sorted(suspect)[:20]))
    if fails:
        print("   failures: %d" % len(fails))
        for t, e in fails[:15]: print("     %-10s %s" % (t, e))
    # WRITE IT EVEN WHEN IT IS EMPTY, OR A CLEAN RUN LEAVES THE LAST RUN'S FAILURES STANDING.
    #
    # This was guarded by `if fails:`, so a run with nothing to report simply did not touch the
    # file -- and _failures.json kept naming C4E09B and its zstd error for eight days after the
    # 21Aug26 ActiveCaptain pull decoded that tile perfectly. On 2026-08-21 the extract printed
    # "failures 0" and the file on disk still said otherwise, dated 08-13. A leftover that reads
    # as current is the exact trap 00_START_HERE opens with, and an empty list says "asked, none"
    # where an absent file says nothing at all.
    with open(os.path.join(a.out, "_failures.json"), "w", encoding="utf-8") as f:
        json.dump(fails, f, indent=1)

if __name__ == "__main__":
    main()
