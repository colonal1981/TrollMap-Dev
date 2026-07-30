# GMAPMF contour decode — turnover review + planned next steps

> **STATUS 2026-07-29 (late):** Decode path = firmware-exact end-to-end
> (AppendWay seed = way anchor; element base inert/sentinel — §9).
> Failure LOCALIZED: containment by level — bits≤22: 87–95%, bits-23: 57%,
> **bits-24: 1.9% (74/3,799)**. Whole-chunk center misassignment ruled out by
> rigid re-home tests; conclusion: `0x1bc/0x1c0` is reloaded per element-run
> inside bits-24 chunks via a per-record subdivision tag we don't parse.
> **ONE key ask left: decompile the caller of FUN_03f0c9c0** (the function
> owning the element iterator + feature object) — it holds the
> record→subdivision assignment rule. Minor asks in §9. 4-tile merge ON HOLD.

## 6. Day-2 results (2026-07-28) — Phase 1 executed

**Setup completed:** all 3 helper modules received; `gmapmf_subdivisions_exact.py`
run clean (972 C / 989 B subdivisions, levels `bits+zoom=24` confirmed at all
8 levels); 3DHP reference verified against audit; scoring harness built
(`score_contours_3dhp.py` — with Claude's STRtree patch applied and
regression-verified bit-identical vs the pre-patch baseline; note shapely
2.1.x `query_nearest` always returns `(2,N)` index *pairs*, even with
`all_matches=False` — both fixes are needed together).
NOTE: pip installs do not persist between sandbox turns —
`python3 -m pip install zstandard shapely numpy matplotlib` first thing.

**Exports (config = NOWRAP + `--shift-mode`, C4E0F1, unfiltered):**
6,639 RGN3 records → 6,634 features, 5 unresolved. Three modes scored
(lake-clipped view):

| ≤10 ft band | median mean err (train/test) | contained | pass (mean≤5,max≤10) |
|---|---|---|---|
| v1 pre-fix baseline | **147 m** | (2,594/2,594 filtered) | 75 |
| none | 174 m | 958 (23.6%) | 56 |
| **anchor-only (WINNER)** | **18.4 / 20.2 m** | **1,776 (42.1%)** | **590** |
| both (v1 scale) | 27.4 / 29.4 m | 1,536 (36.4%) | 403 |

- Canary **sub 331 / key 0x4BD4**: anchor-only reproduces the golden 24 pts /
  178.0 m path exactly; "both" breaks it (356 m). Deltas are therefore
  **level-scale-free** (firmware `CopyDeltas` correct); record anchors are at
  level bit-depth (`2^(24-bits)` factor) — the hybrid hypothesis won.
- Shallow distribution is bimodal post-fix: **55% of ≤10 ft features ≤25 m
  mean error, p25 = 6 m** — the shoreline population is truly fixed.
- Visuals: `reports/wateree_redfan_zoom.png` (fan knots pre-fix →
  shoreline-hugging post-fix) and `reports/wateree_prefic_vs_postfix_overview.png`
  (**CRITICAL — Ryan's caveat answered: unfiltered output is still
  majority-misplaced; the earlier containment filter was hiding this**).

**Residual failure decomposition (from full-tile scoring, 4,858/6,634 features
escape the water polygon):**

| Mode | Signature | Count | Interpretation |
|---|---|---|---|
| **Wide-anchor loops** | raw anchor magnitude 8k–30k (vs contained p90 <2k), start lands ~9× extent from center, shapes smooth/coherent, 84% land inside *some far* subdivision, no constant sub-offset, NOT absolute coords, NOT s16 saturation | ~1,920 | `base_x/base_y` in firmware's `x = (raw<<shift)+base` is NOT always the TRE2 center — exactly the known-untraced addend |
| **Tight-anchor escapes** | anchor raw <1k (correct placement) yet path leaves water | ~1,060 | delta-chain/way-splitting issue — the algorithm doc's open question (UnpackWays selector grouping/splitting into ways) |

Both queues point at the SAME Ghidra target: **trace `FUN_03f0c9c0`
(UnpackWays' caller)** for (a) what populates `base_x/base_y` per record and
(b) how selectors are grouped/split into output ways.

**Current deliverables (C4E0F1, v3 config):**
- `exports/C4E0F1-v3-full-unfiltered.geojson` (6,634 features)
- `exports/C4E0F1-v3-water-contained.geojson` (1,776 features) — usable for
  TrollMap NOW with the caveat that deep coverage is partial
- `reports/nowrap-anchor-only-fulltile.json` (+ per-mode reports), the two
  PNGs above

**NOT yet done:** any 4-tile run is deferred — the same failure modes will
replicate identically, and tile-seam stitching on top of a 27%-correct
unfiltered set would produce false conclusions.

## 7. Immediate next steps (ordered)

### 7a. Chain-base hypothesis (2026-07-28) — TESTED AND REJECTED ❌

Following the read of `FUN_03f0c9c0`'s decompile, a `--chain-base` experiment
(chained each record's base to the previous record's end position within each
RGN3 chunk) was implemented and scored. **Rejected decisively:**
- Canary sub 331 / key 0x4BD4: golden 24 pts/178 m feature landed **7.5 km**
  from its validated position.
- Deep-channel control distance distribution moved the wrong way.
- Position-vs-containment analysis across 68 selector-bearing RGN3 chunks
  (6,634 records): containment is FLAT (~26–40%) for stream positions 0–9 —
  even first-in-chunk records fail at the same rate, which kills every
  in-chunk chaining model regardless of details.
- The v4 export was deleted; the flag remains in the script (marked REJECTED
  in its help text) for reference only.

### 7b. What the `FUN_03f0c9c0` decompile DOES pin down (evidence-cited)

1. **Base is written once per record from carried state, and never updated
   inside the record loop**: `*(param_3+0x10) = *(param_1+0x498)` before each
   `UnpackWays` call; `0x498` has no writer anywhere in this function. So the
   base is CONSTANT within one function call — the unit of base assignment is
   the **seek/element-run**, not the record and not the chunk.
2. One call processes a run of elements via the `param_2` iterator
   (`*(param_2+10)` counting from 1 up to `(param_3+0x18)&0xfff`), with seek
   helpers (`FUN_03f47ac0`→`FUN_03f07620`) repositioning between runs and
   12-bit continuation links (`param_1+0x25f8/0x25fc`) for truncated reads.
3. Therefore `0x498` is initialized in the **seek/init path**:
   `FUN_03f06700` / `FUN_03f06c80` / `FUN_03f070c0` (entry),
   `FUN_03f47ac0` (seek), or this function's caller. That is the missing
   piece — matches the two-mode empirical split perfectly (records whose
   seek-element base ≈ TRE2 center = contained/canary; records whose element
   inherits a carried position = wide-anchor loops).
4. Opcode bit semantics refined (from the same decompile): per-record layout
   is `opcode(1) + 2*width anchor + count + N*(1+((opcode>>4)&3)) selectors`,
   width = `(opcode>>6)+1` (1–4 B! our parser only handles 1/2 — no 0x80
   opcodes occur in the Wateree tiles, so currently safe), and **bits
   0x01/0x02 gate extra trailing fields** (bit0x01 + last-record → 3-byte
   extra value → `param_3+0x1c`, likely depth-adjacent; bit0x02 → aux
   processed by `FUN_03f47f40`). `0x52` (our dominant opcode) has bit0x02
   SET, yet our trailer-scan parser decodes those records cleanly, so aux
   appears to be zero-length externally for this tile — flag as a caveat if
   record-level fields ever misalign.

### 7c. Exact Ghidra shopping list (next pull — each item resolves a named hole)

1. **`FUN_03f0abc0` (UnpackWays) full body** — where does the way anchor come
   from (confirm `param_3+0x10` usage), and is `param_1+0x48x`/`0x49x`
   (anything in 0x488–0x4a4) WRITTEN there?
2. **All writers of `param_1+0x490 .. 0x4a4`** — especially whatever sets
   `0x498` (the base) during seek/init; this is THE answer to the wide-anchor
   population. Grep the whole pseudocode file for `0x498`, `0x490`, `0x4a0`,
   `0x488`, `0x48a`.
3. **`FUN_03f0b900`** (element-iterator advance, called inside the record
   loop) — defines what an "element" is vs our chunk/envelope structure.
4. **`FUN_03f47ac0` + `FUN_03f07620`** (seek/reposition) — what coordinate
   state, if any, travels with a seek.
5. **`FUN_03f06700` / `FUN_03f06c80` / `FUN_03f070c0`** (the three entry
   paths) — initial-ization of the base at element-run start.
6. Optional: the 3-byte last-record field's semantics (`param_3+0x1c`) —
   confirm whether it's the depth value and how it maps to our
   `91 05 06 <dm> 09 <tr>` trailer.

### 7d. Standing (unchanged) steps after the base question is answered

4. Implement the seek-element base, re-validate: canary (24 pts/178 m), deep
   channel control, shallow band ~18–20 m, target **unfiltered containment
   ≥70%** (currently 26.8%) + escaped-population collapse.
5. Then 4-tile run (C4E0DB/C4E0F0/C4E0DA), seams, merged export.

## 8. Element-header base question (2026-07-29) — VERIFIED, WITH A CRITICAL CORRECTION

Claude's `ARENA_HANDOVER_2026-07-29.md` correctly identifies the mechanism
(`FUN_03f0b900` reads a 15-byte element header; bytes 4–11 land in
`param_1+0x498`, copied to `param_3+0x10` before each UnpackWays call).
Its proposed fix ("read the base from element header bytes 4–11, replace
TRE2 center") **WILL NOT WORK and must not be implemented as written** —
verified directly against the file bytes:

- **The 8 "base" fields in the Wateree RGN3 stream are constant sentinel
  templates, not coordinates.** Across all 186 mode-(1,13) RGN3 chunks,
  bytes 6–13 are ONE value: `80 00 00 C0 02 00 80 7F` (float32 pair ≈
  (-2.0, NaN)). Across all 100 mode-(3,8) nested envelopes, bytes 5–12 are
  ONE value: `08 63 D6 02 00 80 42`. A coordinate would vary per element;
  these don't. Reading them as bases would inject the same garbage point
  into every feature.
- **Header shape however IS confirmed** (matches `FUN_03f0b900` exactly):
  `b0,b1` type/mode; `u16 @ +2` = byte span to next element; **u16 @ +12 =
  record count** (values 107/68/41/30 = exact nested-record counts of the
  sampled chunks); `byte @ +14` = extra skip. The u16-length-at-bytes-2–3
  (plus flag byte 4 = 0x80) explains why all 186 chunks carry `byte6=0x80`.
- **Canary base proof:** entry 94 of sub-331's envelope (the `0x4BD4`
  canary) decodes to raw=(-827, 474); its validated start requires
  base = (−3,762,570, 1,601,486) = **the TRE2 center EXACTLY** (diff 0,0).
  So for contained records the v3 model (base = TRE2 center) is provably
  correct, and the sentinel interpretation is consistent: when the header
  base is a sentinel, the loader falls back to subdivision position.

**Anchor-shift reconciliation (big win, closes the shift question):**
`FUN_03f06c80` sets `0x1bc/0x1c0 = TRE2 center << 8` (32-bit space);
UnpackWays anchors at `raw<<shift + center<<8`. For firmware to equal the
empirically winning factor 2^(24−bits) on anchors, the anchor shift must
be **32 − bits**, while the CopyDeltas delta shift is
**32 − (bits + zoom)** (= 8 constant on Wateree → deltas level-free in
UNIT24). I.e. anchors are stored at level quantization (classic Garmin),
deltas at (bits+zoom) quantization. **v3 "anchor-only" is therefore the
firmware-exact configuration**, not just the empirical winner. Ship as
canonical; the A/B/C debate is closed.

**Where the remaining bug actually lives:** the escaped populations
(73% of features) need a base that is NOT their own TRE2 center.
`FUN_03f06700` (entry path) maintains coordinate state arrays at
`0x1d4..0x21c` with **delta-conditional writes** (`field = local − prev`
vs `field = local` on first vs subsequent reads, gated by flag bits at
`param_1+0x168`), navigates a TRE record table with variable record size
(`*(param_1+0x15e)`), and `FUN_03f070c0` fans those out into element
cursor arrays at `0x394..0x486`. Element-level positions are delta-chained
across reads — matching the wide-anchor population's coherent walk across
subdivisions (84% land inside some far subdivision, no constant offset,
shapes intact).

**Next Ghidra asks (final, narrow):**
1. `param_1+0x168` flag-bit semantics (which coordinate fields are
   delta-encoded vs absolute, per element type).
2. In `FUN_03f06700`: which file section the `param_1+0x120/0x130` buffer
   caches (TRE2? TRE7? RGN?), and the `uVar2`→element mapping.
3. `ghidra_full_pseudocode.txt` (UnpackWays/AppendWay bodies) — which
   value actually SEEDS delta accumulation: the way-anchor
   (`center + raw<<shift`, 0x1bc-based) or the way base (`param_3+0x10`,
   0x498-based)? Decides the tight-anchor escape population.
4. What handles the float32(-2.0, NaN) sentinel bases (fallback path to
   0x1bc/0x1c0 or to chained element position?).

## 9. AppendWay confirmed + failure localized to bits-24 (2026-07-29, later)

**§8 item 3 CLOSED by `ARENA_HANDOVER_2026-07-29b.md`:** AppendWay seeds the
accumulator from the **way anchor** (`raw<<shift + 0x1bc/0x1c0`, computed in
UnpackWays into `param_6+0x20/0x28`); the element base (`param_3+0x10` ←
`0x498`) is **never read in the coordinate path** — consistent with our
sentinel-constant finding. LoadWay index entries are offset pairs (length =
next−current, mathematically equal to our counts+cumsum), K=2046 divisor
reconfirmed, deinterleaved lanes reconfirmed, ZigZag+`<<shift` reconfirmed.
**The v3 accumulation pipeline is firmware-exact end-to-end.** Also closed:
our 14-byte-exact TRE2 parser matches firmware's own navigation (FUN_03f06c80
applies `-2 per record past the 0x15c inherited level` = 14-byte stride for
the bits-24 level; boundary arithmetic matches to the byte). `0x220 = 0` for
all levels in this tile.

**Failure now localized with high precision — it is level-specific:**

| level | contained / total | rate |
|---|---|---|
| bits 19–22 | 218 / 242 | 87–95% |
| bits 23 | 1,484 / 2,593 | 57.2% |
| **bits 24** | **74 / 3,799** | **1.9%** |

The 8 zero-containment chunks (588, 616, 628, 752, 856, 921, 956, 556...) are
ALL bits-24, with in-lake sane centers, but feature starts scatter 2–25 km
(far beyond their ~2 km cells). Tests THIS SESSION that localised it:
- No duplicate (prefix,keys) features across chunks → no double-decode/
  chunk-sharing.
- Chunk→subdivision mapping is sound (TRE7 positional alignment exact;
  firmware element id = global 1-based TRE2 index, its navigation arithmetic
  reproduces our byte offsets exactly).
- **Whole-chunk center reassignment REJECTED**: rigid re-home search over all
  969 candidate centers fixes at most 28/66 starts (sub 856) and≈0 full paths
  (6/60 bits-24 shallow features re-home at ≥90%, to implausible centers).
  One center per chunk is right for some records and wrong for others —
  i.e. **0x1bc/0x1c0 is being RELOADED per element-run INSIDE bits-24
  chunks**, driven by a per-record/per-element subdivision tag our parser
  never extracts.

**THE one remaining unknown — and the next (final) Ghidra ask:**
decompile the **caller of FUN_03f0c9c0** (the feature loader that owns the
`param_2` element iterator and the `param_3` feature object whose
`(param_3+0x18)&0xfff` = element count). That function decides **which
subdivision id (uVar2 → `FUN_03f06c80(uVar2)`) each element-run seeks to**,
i.e. it contains the record→subdivision assignment that bits-24 records
violate in our decoder. Secondary asks:
- `FUN_03f47ac0`'s table at `param_1+0xdd8` (element list keyed by the
  `0x488 = sVar2 + header_byte0` element-type id — likely how records map to
  subdivisions without explicit tags);
- the 3-byte last-record field (`local_70→param_3+0x1c`) semantics fully;
- confirm bits bytes at `param_1+0x14a+level` = [17..24] (shift sanity).

**Standing experimental result strengthening the above:** switch mode
"anchor-only" remains canonical (42% containment, ≤10 ft band ~18–20 m); but
note its win was concentrated in bits≤23 (bits-24 is shift-invariant at
factor 1, so mode choice never touched the dominant failure class).

---

## 10. BREAKTHROUGH (2026-07-29, evening): bits-24 chunks are HI-RES (2^28 quantum) + v4 export

The §9 "bits-24 failure" is solved at the quantum level and largely fixed
end-to-end. Two independent byte-level causes were found and corrected in
`gmapmf_arc_contours_v4.py` (VERSION `-v4-HIRES`); lo-res decoding is
byte-identical to v3 (canary regression intact, zero endpoint conflicts).

### 10.1 Firmware-exact opcode width maps (FUN_03f0c9c0)

v3 decoded selector records with boolean width flags (`0x40`→2-byte coords,
`0x10`→2-byte selectors, `0x08`→2-byte counts). Firmware actually uses:

```
coord_width    = (opcode >> 6) + 1        ∈ {1,2,3,4}
selector_width = ((opcode >> 4) & 3) + 1  ∈ {1,2,3,4}
count_width    = ((opcode >> 3) & 1) + 1  ∈ {1,2}
```

14 chunks (the LO-prefix bits-24 ones holding (3,19)-mode nested envelopes)
use `0x80`-class opcodes (3–4-byte anchors) and were silently dropped or
mis-parsed under v3. With exact widths they parse cleanly.

### 10.2 Hi-res quantum — prefix bit 15 is the marker

Evidence chain (all diag scripts + report JSONs in the workspace):

1. **Step-length fingerprint.** Failing long features (e.g. chunk 752,
   1,553 points) had median step ≈ 234 m; the contained population's median
   step is ≈ 14.7 m. Ratio 16.0 = 2^4 — a pure scale problem, not a
   topology/chaining problem.
2. **Quantum confirmation.** Re-scaling anchors AND shared-arc deltas by
   1/16 makes the long failing features fit the 3DHP water at containment
   1.00 (direct, no translation) for the majority; median step collapses
   to ≈ 11 m. Interpretation: these chunks are quantized at 2^28 units
   per 360° (level bits=28), i.e. one level finer than UNIT24.
3. **FFT/correlation rejection of re-homing.** At scale 1, exhaustive
   translation search of failing features against the water mask and
   depth-band masks scores ≤ 0.16 (report `correlate_long_fails.json`) —
   they do not exist anywhere in the tile at that scale; so they were
   never misplaced, only mis-scaled. Whole-chunk re-home at 16×
   (`chunk_rehome16.json`) is underdetermined (many centers tie), again
   pointing at scale, not base.
4. **Marker.** Across all 68 feature-bearing RGN3 chunks: the 25 chunks
   with `prefix & 0x8000` are exactly the 25 known-bad bits-24 chunks
   (mean containment 7.0% at scale 1); the 43 with `prefix < 0x8000`
   decode fine (mean 83.3%). Zero overlap at the 50% line. The chunk
   prefix high bit = hi-res flag for these tiles (plausibly tied to the
   FUN_03f06700 flag-map bit 15 = `0x210/0x214` cursor slot).

### 10.3 v4 results (official scorer, metric-space vs 3DHP, 80/20 split)

| metric | v3 (anchor-only) | v4 (hi-res) |
|---|---|---|
| full-tile containment | 26.8% (1,776/6,634) | **56.0% (3,827/6,830)** |
| lake-clip containment | 42.1% | **57.7%** |
| ≤10 ft median mean err (clip, train/test) | 18.4 / 20.2 m | **10.0 / 10.9 m** |
| ≤10 ft passing (≤5 m mean, ≤10 m max) | 590 | **1,141** |
| 10–28 ft median mean err (clip) | 269 m | 126–141 m |

Exports: `C4E0F1-v4-full-unfiltered.geojson` (6,830) and
`C4E0F1-v4-water-contained.geojson` (3,827). Reports: `v4-fulltile.json`,
`v4-lakeclip.json`. Canary (sub 331, key 0x4BD4) unchanged: 24 pts / 178 m.

### 10.4 Residual: base varies PER RECORD inside hi-res chunks (the one remaining Ghidra ask)

Per-feature placement study on all 3,774 hi-res RGN3 depth records
(`hires_place_v2.pkl`, exhaustive translation search at 125 m grid):
- 2,121 (56%) sit **directly** at their own chunk center — done;
- 785 (21%) fit the water at containment ≥ 0.9 only after a translation,
  median |t| ≈ 2.7 km, up to ~12 km;
- 868 (23%) unplaced. Class point counts: direct median 5 pts, placed 9,
  bad 15 (mean 129) — i.e. short records place trivially at the own-center
  default, while the residual is concentrated in the LONGEST, most
  informative records (the same population that was 16×-oversized at v3).

The wanted translations are **different per record within one chunk**
(e.g. chunk 856: 26 distinct translations spread over 24 km) and only 28%
of them land within 250 m of another TRE2 subdivision center — so the base
is NOT "a neighboring cell" either. This kills every chunk-level base theory
and matches the c-handover item-2 mechanism: for hi-res runs the anchor base
is reloaded per element-run (FUN_03f06c80 re-seek per uVar2) and the
record→subdivision assignment lives in the **caller of FUN_03f0c9c0** — the
function that owns the element iterator and decides uVar2 per element-run.
**That caller decompile is the single remaining blocker.** (Also still open:
the abs/delta cursor slots `0x1d4..0x21c` fanned per subdivision by
FUN_03f070c0 may carry an addend our pure record-bytes anchor misses — the
distances wanted are too structured for coincidence.)

Known harmless artefacts: 2,608 of 9,443 RGN3 selector records are not
depth-bearing (other line classes) and are excluded by design; 29 RGN2
hi-res chunks exist (polygon landmass shading) — not yet analyzed.

### 10.5 Ryan report + asks sent

Breakthrough summary + v4/v3 score deltas + the one Ghidra ask (caller of
FUN_03f0c9c0) are being reported to Ryan. On his answer: implement the
per-element-run base in v5, re-run, re-score (regression gates: canary
24 pts/178 m; ≤10 ft band median ≤ ~11 m; containment ≥ 56% full-tile —
expect a large jump if the residual 44% of hi-res records land).

---

## (Original day-1 review below — kept for history)

(Prepared 2026-07-28 by picking up the ARENA_HANDOVER.md brief and auditing
every uploaded file against it.)

## 1. What was reviewed

| File | What it is | Status after review |
|---|---|---|
| `ARENA_HANDOVER.md` | The master brief: 11 firmware-confirmed findings, rejected hypotheses, tile coverage, resume point | Authoritative — plan below follows its "CURRENT STATE / NEXT STEP" list |
| `gmapmf_algorithm_complete.md` | Detailed algorithm writeup (items 1–10) + consolidated `decode_way` reference pseudocode | Matches handover; open question = selector grouping/ordering within one way |
| `gmapmf_arc_contours_exact.py.txt` | Exporter v2026-07-28-v1 | **Clean** — see finding A below. Becomes the canonical pipeline |
| `gmapmf_arc_contours.py.txt` | Exporter v2026-07-27-v1 | **Retire to reference-only** — see finding B (contradicts handover labeling) |
| `B4E0F1-3DHP-codec-audit.md` / `(1).md` | B-tile shoreline audit, two versions | Version (1) supersedes: the "Lake Wateree labeled polygon in B RGN2 sub 966" lead was debunked (label index `D9 06` was a coincidental selector value inside opcode `0x56`) |
| `C4E0F1-firmware-decoded- / -complete-water-contained.geojson` | 2,594 / 1,440 features, both from the 07-28-v1 script | Both are **pre-item-11** and both are **water-contained-filtered** — the unfiltered export Ryan asked for was never produced |
| `C4E0F1.GMP`, `B4E0F1.GMP`, `G4E0F1.MAR` | The actual binaries (mislabeled `.txt`) | Restored to proper names in `gmapmf/data/` |
| `wateree-tiles.txt` | 4-tile coverage scan results | Matches handover |

## 2. Findings from re-auditing the scripts themselves

**A. The handover's "stale ArcStore" warning about `gmapmf_arc_contours_exact.py`
is outdated.** Both uploaded scripts already carry the firmware-correct
`ArcStore`: deinterleaved X-then-Y delta lanes (item 1) and 2046 ways per index
block (item 6). The uploaded exact script is the post-fix copy.

**B. The 2026-07-28 "exact" script is the most firmware-faithful pipeline, and
the 2026-07-27 "main" script (which the handover calls the corrected one)
still contains two rejected mechanisms.** Inspecting the code:
- 07-27 script: still applies the `next_index` hop-count shift heuristic
  (**rejected per item 3**) and anchors each selector via a
  topology-endpoint-consensus DSU instead of the firmware's
  chained-accumulator model (**contradicts items 7/9**). Do not export from it.
- 07-28 script: chained accumulator across selectors, reverse =
  backward-walk-and-subtract, exact-TRE shift requirement (`shift24`,
  = 0 for all Wateree levels). Its one remaining bug is exactly the pending
  item 11: `wrap_to_extent(raw_x, width)` on the record anchor.

**C. Item-11 fix is already applied and staged** in
`gmapmf/gmapmf_arc_contours_nowrap.py` (VERSION tag `...-v2-NOWRAP`,
syntax-checked, `wrap_to_extent` fully removed; firmware formula
`coordinate = center + raw × UNIT × factor`).

**D. Nothing runnable is currently blocked by code — it's blocked by inputs.**
Both exporters import three helper modules that were **not** uploaded, and
both require `--centers`, the GeoJSON emitted by
`gmapmf_subdivisions_exact.py` (also not uploaded). The 16-entry TRE1
nibble-shuffle table lives only in that script's source, so it cannot be
reconstructed here from the handover text alone.

## 3. Inputs needed from Ryan (blockers — handover said to verify these)

1. ~~**`gmapmf_subdivisions_exact.py`**~~ ✅ RECEIVED 2026-07-28; centers
   generated and verified for C4E0F1 (972) and B4E0F1 (989).
2. **Helper modules** — ⛔ **STILL THE ONLY HARD BLOCKER for the run**:
   `gmapmf_selector_occurrences.py`, `gmapmf_topology_endpoint_trial.py`,
   `gmapmf_topology_endpoint_trial_v2.py`. (Ryan was asked for these with the
   first batch; only items 1 and 3 arrived.)
3. ~~**USGS 3DHP Wateree Lake polygon**~~ ✅ RECEIVED; geometry verified
   against the audit's recorded stats.
4. Later (Phase 2): the other three tiles from the SD card — `C4E0DB.GMP`
   (NE), `C4E0F0.GMP` (SW), `C4E0DA.GMP` (NW) — and their B companions.
5. Only if Phase 2b triggers: `ghidra_full_pseudocode.txt` around
   `FUN_03f0c9c0` (UnpackWays' caller) for the `base_x/base_y` provenance trace.

## 4. Prep already done in this workspace

```
gmapmf/
  data/                              # binaries restored from uploads
    C4E0F1.GMP  B4E0F1.GMP  G4E0F1.MAR
    C4E0F1-subdivisions.json         # NEW: exact centers, 972 subs verified (834/969 data rows in lake bounds)
    B4E0F1-subdivisions.json         # NEW: 989 subs verified, clean 4-byte padding
    lake-wateree-3dhp-reference.geojson  # NEW: verified vs audit — 17,282 ext verts, 54 islands, bounds match
  gmapmf_subdivisions_exact.py       # received 2026-07-28, run clean on both tiles
  gmapmf_arc_contours_nowrap.py      # v2-NOWRAP: item-11 fix applied, staged to run
  gmapmf_arc_contours_2026-07-27_REFERENCE_ONLY.py  # do not export from this
  score_contours_3dhp.py             # NEW: metric-space scoring + water-contained-filter reproduction (tested)
  reports/baseline-decoded.json      # NEW: pre-fix baseline numbers (see §4b)
  C4E0F1-firmware-decoded-water-contained.geojson   # baseline (pre-fix), for diffing
  C4E0F1-firmware-complete-water-contained.geojson  # baseline (pre-fix), for diffing
  NEXT_STEPS.md                      # this document
```
- `zstandard` + `shapely` + `numpy` installed.
- Patched decoder passes `ast` syntax check; no code-level `wrap_to_extent`
  references remain.
- Decrypted TRE1 levels confirm the firmware claim at every level on both
  tiles: `bits + zoom == 24` (17+7 … 24+0).

### 4b. Pre-fix baseline captured (2026-07-28)

Scoring harness reproduces Ryan's water-contained filter exactly
(2,594/2,594 = 100% on the old export) and quantifies the pre-fix state:

| Band | n | median mean err | p90 mean err | passes (mean≤5, max≤10) |
|---|---:|---:|---:|---:|
| ≤10 ft | 1,999 | ~147 m | ~365 m | 75 |
| 10–28 ft | 401 | ~186 m | ~485 m | 12 |
| >28 ft | 194 | ~220 m | ~362 m | 6 |

Even the *filtered* export is ~150–220 m off the shoreline on median — the
contain filter only proved segments stayed over water, not that they were the
right contours. A successful item-11 fix should collapse ≤10 ft median mean
error to small tens of meters or less. (Caveat: for >28 ft mid-lake channel
contours, large distance-to-shore can be *correct* geometry — treat that
band's pass rate as a weak proxy; containment + control points matter more.)

## 5. Open technical item discovered this session: delta/anchor shift scale

The exact exporter multiplies BOTH anchor and deltas by `factor = 1 << shift24`
(from centers, `shift24 = 24 - bits`). But handover item 3 (firmware
`CopyDeltas` trace) says the DELTA shift is `32 - (bits + zoom)`; with
bits+zoom=24 constant, deltas need **no** extra scale on top of UNIT24 —
for any level. Impact is large: **511 of 969 C4E0F1 data-bearing subdivisions
are bits<24** (`2^(24-bits)` up to ×32 on this tile).

Plausible reconciliation: deltas are truly level-scale-free (firmware), while
record ANCHORS are stored at the level's bit depth (classic Garmin) and do
need `2^(24-bits)`. Both pre-fix exports applied the per-level factor to both
quantities, so this was never isolated — and the anchor-wrap bug would have
masked it.

**Experiment once unblocked:** run the item-11-fixed pipeline in three shift
modes and let 3DHP scoring decide —
- `A`: per-level factor on anchor AND deltas (v1 behavior);
- `B`: per-level factor on anchor only, factor 1 on deltas (hybrid hypothesis);
- `C`: factor 1 on both (strict item-3 reading).
Independent variable is nested inside the item-11 fix; run all three with
wrapping OFF. The ≤10 ft band's median mean error and containment rate are
the decision metrics (150 m / 100%-junk baseline above).

## 5. Planned next steps

### Phase 1 — confirm item 11 on C4E0F1 only (the exact resume point)
1. Drop the missing modules + centers GeoJSON (§3 items 1–2) into `gmapmf/`.
2. Run `gmapmf_arc_contours_nowrap.py` on `data/C4E0F1.GMP`.
3. **Export BOTH the full unfiltered feature set and the 3DHP-water-contained
   filtered set** (Ryan's caveat: the 100%-within-5 m filter is very
   aggressive — 1,440/6,429 last time — so the filter itself may have been
   hiding good output; never judge the fix from the filtered view alone).
4. Spot checks, in order:
   - Sub 331, key `0x4BD4`: expect ~24 points / ~178 m path / 0% outside
     3DHP water (the K=2046-regression canary).
   - Deep-channel control point `34.36720, -80.72432` (64 dm / 21 ft record).
   - **The red-fan test**: shallow (≤10 ft) single-selector ways — which are
     84.8% of shallow records with median 2 vertices — should now hug the
     shoreline instead of radiating from collapsed points in open water.
5. Score metric-space (project to local meters, sample ~3 m along each path,
   distance to nearest 3DHP boundary point), median/P90 mean+max error per
   depth band, with the established `(subdivision*1009 + record) mod 5`
   train/test split. Compare feature counts and containment % against the
   2,594/1,440 pre-fix baselines.

### Phase 2a — if the fan pattern is resolved
6. Re-run the identical corrected pipeline on `C4E0DB`, `C4E0F0`, `C4E0DA`
   and merge for true full-lake coverage (C4E0F1 alone is only the SE
   quadrant; full 3DHP lake bounds W −80.937 / E −80.699 / S 34.333 / N
   34.542 span all four tiles). Watch tile-seam issues: shared-arc keys are
   tile-local, so contours cut by a tile boundary will appear as two
   half-features needing endpoint stitching/dedup — spot-check seams first.
7. Deliver merged lake-wide GeoJSON: unfiltered + water-contained versions,
   for TrollMap integration (personal use only, not for navigation).

### Phase 2b — if the fan persists after item 11
8. Return to Ghidra: trace what populates `base_x`/`base_y` in the firmware
   anchor formula `x = (raw << shift) + base` by walking back from
   `UnpackWays`' caller `FUN_03f0c9c0` (already partially decompiled per
   handover — need `ghidra_full_pseudocode.txt` re-uploaded).
9. Secondary open question queued from `gmapmf_algorithm_complete.md`:
   whether `UnpackWays` sorts/groups selectors before chaining, i.e. some
   records may actually encode multiple independent ways that the current
   one-record-one-LineString model wrongly stitches together.

### Standing guardrails (from handover — do not regress)
- Do not re-test rejected hypotheses: MAR-as-contours, RGN2/RGN3 crossed
  buffers, interleaved lanes, 2045/block, hop-count shift, fixed 16-byte TRE2
  stride, anchor wrapping.
- Validation stays metric-space against 3DHP with the 80/20 split — no
  "looks plausible on a map" sign-off.
- Every export ships an unfiltered companion file.

---

## §11 — v5: firmware record framing (2026-07-29 evening)

Source: full `FUN_03f0c9c0` decompile (head + tail) supplied by Ryan.

### §11.1 Theory eliminated: per-element-run subdivision
Caller resolves subdivision ONCE before the record loop from
`*(short *)(param_3 + 0x1a)`; no `FUN_03f06c80` call inside the `do/while`.
TRE2 center `0x1bc/0x1c0` is FIXED per chunk walk. 07-29c step 4 was inference,
not code. **Do not re-test per-element/per-record base reassignment.**
Corroborating data: corr(|t|, n_points) = -0.135; 785 translations continuous,
median 2.7 km, 29% near any center; subdiv-index offsets unstructured
(-554/-583/-618).

### §11.2 `param_1 + 0x220` — hi-res quantum is firmware-backed
`FUN_03f0abc0`: `uVar2 = 0x20 - (bits@0x1af + X@0x220)`; same `uVar2` passed to
LoadWay, so it scales anchors AND deltas. bits=24, X=4 -> 2^28 quantum = our
HIRES_SCALE 0.0625. `prefix & 0x8000` is a PROXY for whatever sets 0x220.

### §11.3 THE FIX: two-form record tag
Firmware walks records contiguously. Tag forms:
  `11 05 06 <dm>`                   -> more records follow
  `91 05 06 <dm> 09 7a 00 00 00`    -> LAST record (bit7 = bVar6), 3-byte
                                       field -> *(param_3+0x1c) + pad
v4's scanner recognised ONLY the 0x91 form => every non-last record was glued
to its neighbour, and 28 envelopes were dropped whole on tail mismatch.
Result: **100/100 (3,8) envelopes parse clean; 100/100 match declared
u16@+12 record count.** Depth ladder became 3/6/9/12/15/18/21/24/30 dm =
1..8,10 ft (integer-foot intervals); junk values 73/46/34/55 disappeared.

### §11.4 Scores
Lake-clip: 6,653 scored, 3,844 contained (57.8%) [v4 57.7%]; <=10ft median
10.9/10.0 m test/train (unchanged); passing 1,141 (unchanged); 10-28ft
136/126 m; >28ft 320/308 m. Full tile 9,181 features [v4 6,830], contained
3,844 (41.9% - denominator inflated by unscoreable non-Wateree features).
Regression: 6,823 features byte-identical v4<->v5, 3,822 contained in both,
**0 lost**. v5 is a strict superset.

### §11.5 Open: the 2,342 recovered records
2,333 of 2,342 fall OUTSIDE the lake bbox; only 17 water-contained. Either
(a) neighbouring hydrography the 3DHP reference doesn't cover, or (b) same
residual base problem. Depth ladder clean + shapes coherent leans (a) but
UNPROVEN. 4-tile merge is the discriminator (seam alignment).

### §11.6 REJECTED: arc-key base offset (`+ *(int *)(param_1+0x358)`)
LoadWay adds `0x358` to every arc key. Tested key-base offsets: 21-37%
"fixed" by raw containment — BUT null control offset -15013 scored 37.5%,
beating all principled candidates. Cause: wrong key -> shorter arc -> path
collapses (median 190 m -> 14 m) -> trivially inside water polygon.
With a length-preserving constraint (|L - L0| <= 10%) all candidates fell to
0.2-2.1% = noise. **METHODOLOGY GUARD: any placement/base test MUST hold path
length fixed; raw containment rewards degenerate collapse.**

### §11.7 Next Ghidra asks
- `FUN_03f47f40` (local_50 & 4) and `FUN_03f4a620` (local_50 & 2) bodies —
  record-variant handlers that consume stream bytes and advance local_68.
- Writes to `param_1 + 0x220` and `param_1 + 0x358` (replace the 0x8000 proxy).

---

## §12 — depth-aware validation (2026-07-29, late)

### §12.1 The old metric was depth-confounded
`score_contours_3dhp.py` measures distance to the 3DHP SHORELINE. Deep contours
belong far offshore, so the metric charges them for being correct:
corr(depth_ft, mean_err) = **+0.872**, slope ~8.7 m per foot (v5, lake-clip).
The ">28 ft = 312-370 m" figure was therefore largely BATHYMETRY, not decode
error. Shoreline distance stays valid for the <=10 ft band only.

### §12.2 New scorer: `score_bathymetric.py`
Three depth-aware / oracle-free tests. v5 results (lake-clip, 6,651 features):
- **Nesting monotonicity**: Spearman **rho = 0.952**; median dist-from-shore
  3.5 m (1 ft) -> 14 m (4 ft) -> 57 m (10 ft) -> 173 m (24 ft) -> 290 m (30 ft).
  Deep contours are structurally SOUND.
- **Per-depth dispersion**: IQR/median falls ~1.5 (shallow) -> 0.56-0.88 (26-30 ft).
  Deep contours agree with each other better than shallow ones.
- **Crossing count**: 24,235 different-depth crossings, 2,046 same-depth,
  9.5% of features self-intersecting. THIS is the real defect.

### §12.3 Crossing count is a VALIDATED oracle-free proxy
Cross-checked against 3DHP truth (n=6,651): 0 -> 7.8 m; 1-2 -> 13.9 m;
3-9 -> 36.0 m; 10-49 -> 104 m; 50+ -> 202 m. Rank corr **0.498**.
Combined gate (0 crossings AND is_simple): 2,414 features, median err 7.6 m
vs 41.7 m for the rest.
**Works with NO reference polygon => usable on the 3 tiles with no 3DHP data.**

### §12.4 METHODOLOGY GUARD: never length-normalise the crossing score
crossings-per-km INVERTS the signal (rank corr 0.498 -> 0.179; the "100+/km"
bucket had the LOWEST error at 14.6 m) because short mis-placed stubs get tiny
denominators. Use the RAW COUNT. Same trap class as 11.6 path-collapse.

### §12.5 Where the defect lives
crossings by pair: hires x hires 14,690 | hires x lores 9,530 | lores x lores 2,061.
corr(path_len, crossings) = 0.815; longest 1% average 107 crossings each;
top 10% of features hold 54% of all crossings.
Calibration gradient: all clipped 3.64/feature -> water-contained 0.94 ->
contained AND <=10 ft **0.17** (20x). The shallow contained set is nearly clean.

### §12.6 Ruled out this session (do not re-test)
- **Mid-path base reload**: long hi-res paths show NO giant step. max/median
  step ratio 6.0 for long hires vs 6.0 for long lores (identical); med step
  10.7 m vs 12.4 m. No discontinuity => base is not being reloaded mid-record.
- **Long records are spliced/glued contours**: turn-angle analysis shows long
  hi-res paths are SMOOTHER than lo-res (frac>150deg 0.002 vs 0.005; median
  turn 15.1deg vs 20.4deg). They are genuine single contours, not concatenations.

---

## §13 — v6: cw=3 anchor shift + crossing-metric correction (2026-07-29)

### §13.1 THE FIX: 3-byte anchors carry 4 fractional bits
Records whose flags byte gives coord_width==3 (opcodes 0x82/0x92/0x42/0x52)
were read as whole UNIT24 units => anchors 16x too large => features flung up
to 370 km from the lake.

In-file proof (no 3DHP oracle): does the anchor fit its OWN subdivision cell
(width/height from TRE2)?
| interpretation      | fits own cell | cell-fill ratio  |
|---------------------|---------------|------------------|
| raw 24-bit (v5)     | 0/733         | --               |
| raw >> 8            | 733/733       | 0.047 (implausible) |
| **raw >> 4**        | **733/733**   | **0.75 med / 0.999 max** |
| cw=2 known-good ref | --            | 0.60 / 0.49      |
`>>4` is the only reading whose cell occupancy matches known-good records, and
matches firmware `32-(bits+X)` applied to a 24-bit field. Implemented in
`gmapmf_arc_contours_v6.py` (`decode_selector_record`, coord_width==3).

### §13.2 v6 results (lake-clip)
features in lake bbox 6,651 -> **6,794**; water-contained 3,844 -> **3,879**;
<=10 ft passing 1,141 -> **1,146** (median 10.2/11.1 m, flat);
features beyond 80 km **919 -> 193** (-79%).
Modest headline movement because most rescued features sit outside the 3DHP
reference footprint.

### §13.3 CORRECTION to §12.5 — "long hi-res features are the defect" was WRONG
Exposure-adjusted analysis kills that claim. Crossings/neighbours-in-bbox:
<50 pts 0.034 | 50-200 0.236 | 200-1k 0.196 | >1k 0.180 — FLAT above 50 points.
Long features accumulate crossings because they overlap more neighbours
(median exposure 31 -> 749), not because they are more broken.
Also ruled out for long paths: cell overflow (only 5% lores / 1% hires exceed
their own cell), and doubling-back (bbox_diag/path_len 0.24-0.45 is normal for
sinuous shorelines).

### §13.4 METHODOLOGY GUARD: crossing count is SIZE-CONFOUNDED
rank corr(crossings, path_len) = 0.796, vs 0.498 with true error. Controlling
for size, the crossing signal largely evaporates:
  <20 pts : zero-crossing 7.7 m vs has-crossings 21.1 m  (still informative)
  20-50   : 69.9 m vs 73.6 m                              (NO discrimination)
=> Crossing count is a valid QA flag for SHORT features only. Do NOT use it as
a global quality gate or a cross-tile scoring metric without size stratification.
This supersedes the unqualified §12.3 framing.

### §13.5 Within-chunk crossings (9,561 = 33%) remain unexplained
Zero arc-key sharing between crossing pairs; depth gaps broad (only 23% within
2 ft) so it is not adjacent contours grazing. A rigid per-chunk base error
cannot produce them. Still open.

---

## §14 — THE REAL PROBLEM: we export arcs, not contours (2026-07-29, night)

Ryan's visual review ("I see things that have the potential to be contours but
they definitely aren't there yet") is CORRECT and the metrics agree. §12/§13
aggregate stats masked this: point-cloud-level correctness is NOT contour-level
correctness.

### §14.1 Evidence
- Endpoint connectivity: only **28%** of same-depth endpoints meet another
  fragment within 15 m. A real contour set is ~100%.
- **70% of exported features are SINGLE-ARC** (median 4 points).
  arc_count histogram: 1->6411, 2->1782, 3->495, 4->177, 5->113 ... max 99.
  Points scale with arcs (1 arc=4 pts, 3=28, 5=58, 10=143) => arcs are
  fragments, and a contour is a CHAIN of them.
- 16% of features are bare 2-vertex segments; 13% under 10 m long.
- 61 near-straight features >500 m (one 89 km) = artefacts.
- Only 12% of fragments are closed rings.

### §14.2 The gaps are NOT a base error (ruled out)
- Near-miss gap vectors (1-50 m, n=8,145): mean (-0.36,+0.10) m, median (0,0),
  std (12.3,12.2); direction histogram uniform (max/min bin 1.6).
  => NO systematic translation. Do not chase a global/per-chunk base offset
  for the gaps.
- Gap size vs within-fragment vertex spacing: gap median **7.5 m** vs step
  median **10.0 m**, ratio **0.75**. The gap is LESS THAN ONE VERTEX STEP =>
  fragments are genuinely adjacent pieces of one contour.

### §14.3 Geometric stitching is NOT the fix
Greedy same-depth endpoint chaining: 6,794 fragments -> 4,355 chains at 15 m
tol; largest chain only 8 fragments (25 m tol: 4,013 chains, largest 10).
Real contours need chains of hundreds. Also 21% of open endpoints have NO
same-depth partner among 20 nearest. Stitching by proximity is a band-aid that
cannot reconstruct the intended topology.

### §14.4 The actual fix: follow the ARC CHAIN in the format
The firmware links arcs into a feature via the selector list; we already read
selectors but each nested depth RECORD is being emitted as one feature. The
question is what links multiple RECORDS into one contour. Candidates:
 - the TOP-payload selector records (parked in v4 as "huge aggregate way-lists",
   up to 928 selectors) may BE the contour-level assembly, with nested records
   as the per-arc detail. Revisit: top payload = contour topology, not junk.
 - `param_3+0x1c` 3-byte last-record field / the 0x91-vs-0x11 last flag may
   delimit contour groups rather than envelope ends.

### §14.5 Status honesty
NOT usable for fishing. Shapes are largely right and locally well-placed
(<=10 ft median ~10 m; deep local nesting 87.8%) but the output is a fragment
soup, not contours. Ledge/hump layers built on it (make_striper_layers.py) are
premature and must not be trusted -- a "9 km ledge" assembled from unjoined
scraps is not a 9 km ledge.

---

## §15 — 0x91 group-delimiter hypothesis: TESTED AND REJECTED (2026-07-29)

Claimed in-session that the 0x91-vs-0x11 tag bit delimits contour groups, on
the basis that "99.7% of groups have a consistent depth". **That statistic was
an artifact and the hypothesis is FALSE.**

- 7,129 groups, but **7,103 (99.6%) are size 1**. A single-record group is
  depth-consistent BY DEFINITION, so the 99.7% measured nothing.
- Of the 26 groups that could actually fail: **4 same-depth, 22 mixed-depth.**
  Real pass rate 15% -- worse than chance.
- Intra-group endpoint chaining (n=2,061 consecutive pairs): median gap
  **502 m**; only 2% under 5 m, 11% under 50 m. Records inside a "group" do
  not join.

METHODOLOGY GUARD (third of this kind, cf. 11.6 path-collapse and 13.4
size-confounding): **when a grouping/partition rule is scored, report the
score on the INFORMATIVE subset only.** Degenerate partitions (all-singletons,
all-one-group) score perfectly on consistency metrics while encoding nothing.

Status: 0x91 remains best explained as the firmware's `bVar6` last-record flag
feeding the 3-byte `*(param_3+0x1c)` read. It is a stream-parsing flag, not
topology. v7 (group plumbing) is retained ONLY as instrumentation --
geometry output is byte-identical to v6; do not treat v7 as an improvement.

## §16 — Tile bounds parser (CONFIRMED, from Ryan)

TRE header fields, each s24 * UNIT24:
  +0x15 north | +0x18 east | +0x1B south | +0x1E west
Verified against C4E0F1: W=-80.8594 E=-80.1562 S=33.9029 N=34.4872 (exact).

All FOUR Wateree tiles confirmed present on the card (Arena earlier claimed
4E0DB was missing -- that was a hand-transcription error by Arena, corrected
by Ryan's own scan; the file is at 8e/0a/4E0DB):
  4E0F1 SE  W=-80.8594 E=-80.1562 S=33.9029 N=34.4872
  4E0DB NE  W=-80.8594 E=-80.1562 S=34.4872 N=35.0674
  4E0DA NW  W=-81.5625 E=-80.8594 S=34.4872 N=35.0674
  4E0F0 SW  W=-81.5625 E=-80.8594 S=33.9029 N=34.4872
Tile size ~0.703 x 0.584 deg = ~64 x 65 km.

CONSEQUENCE: 13.x reasoning that "features beyond 80 km cannot belong to an
adjacent tile" assumed 20-40 km tiles and is INVALID. With 64 km tiles,
strays up to ~90 km may be legitimate neighbour-tile content. Re-test once
the other three tiles are loaded.

---

## §17 — FUN_03f47f40 / FUN_03f4a620 decoded (2026-07-29, Ryan)

Both are ATTRIBUTE parsers. Neither carries contour topology. This closes the
last two unread functions from the FUN_03f0c9c0 record loop.

### §17.1 FUN_03f47f40 = aux-feature attribute reader (flags bit 2)
Reads ONE byte `local_9`, derives a payload length:
    local_9>>5 == 4 -> local_8 = 1
                 5 -> 2
                 6 -> 3
                 7 -> varint via FUN_03f4e84c
             else    -> 0
then advances `*param_5 += local_8`. Dispatches on a 42-entry table at
DAT_05b13af8 (stride 8: {type_u8, ..., match_short, u32 flagmask, type_char})
into ~20 typed attribute handlers (FUN_03f61ca0/61d50/61dec/61fa0/620b0/62168/
621a8/624e0/6256c/62648/62728/62820/62920/62d2c). Case 0xf/0x10 read a
label/index sized by FUN_03f66ba0(param_1) -- that is the LBL-pointer width.

**INDEPENDENT CONFIRMATION THAT 15 WAS RIGHT TO RETRACT:** for our two tags,
0x11 -> local_9>>5 = 0 -> local_8 = 0 aux bytes; 0x91 -> >>5 = 4 -> 1 aux byte.
The 0x91-vs-0x11 difference is purely an AUX-PAYLOAD LENGTH CODE. It is not a
group/topology delimiter. Byte evidence (15) and firmware now agree.

### §17.2 FUN_03f4a620 = attribute-bitmask walker (flags bit 1)
Driven by `*(uint *)(param_2 + 0x10)`: a 29-bit ATTRIBUTE-PRESENCE MASK walked
bit by bit (uVar10 = 0..0x1c). For each set bit it takes a 2-bit width code
from the following words (`param_2 + 0x14 + (i>>4)*4`, shifted `(i&0xf)<<1`),
consuming (code+1) bytes, or a varint when code == 3. Field destinations
depend on `*param_4` (feature class 0/2/4) and write into param_4+0x08..0x37.
Bit 0x1e/0xf opens a NESTED sub-mask (second 32-bit mask + its own width
table) -- that is the extended-attribute block.

### §17.3 The "sentinel" at param_3+0x10 IS this bitmask (reinterpretation)
FUN_03f0c9c0 does `*(param_3 + 0x10) = *(param_1 + 0x498)` (8 bytes), and
FUN_03f4a620 then reads `param_2 + 0x10` as the mask and `+0x14` as the width
table. So the 8 "sentinel" bytes are not inert padding -- they are
(attr_mask u32, width_table u32).

Measured on C4E0F1, (3,8) element header [4:12], CONSTANT across all 100:
    00 08 63 d6 02 00 80 42
    attr mask  = 0xd6630800 -> bits {11,16,17,21,22,25,26,28}
    width tbl  = 0x42800002
Constant => every depth feature in this tile carries the SAME attribute set.
Consistent with 10/13.4 (dead field for COORDINATES) while explaining what it
actually is. Does not affect geometry decode.

### §17.4 Consequence for the contour problem
Flags bit1 and bit2 are now fully accounted for as ATTRIBUTE parsing. Neither
supplies arc->contour grouping. The FUN_03f0c9c0 record loop is now decoded
end to end with NO topology field remaining. Therefore contour assembly is
NOT in the RGN3 record stream at all -- it must come from elsewhere
(LBL/label association, or the renderer joining by geometry at draw time).
Next probe: FUN_03f66ba0 (LBL pointer width) + whether depth features carry a
label index that is shared across the arcs of one contour.

---

## §18 — LBL section opened: NO per-feature labels (2026-07-29)

The LBL section was in C4E0F1 all along at root+0x21 -> 0x00000409. We had
never opened it. Contents:

  LBL data block: start=0x001bc97a len=62
  "Flattened Marine Map" / "GARMIN LTD. AND ITS SUBSIDIARIES" / "2026"

That is the ENTIRE label section: map name, copyright, year. 62 bytes.
There are no per-feature label records, so there is no label index that could
group arcs into a contour. The 17.4 "next probe" (LBL association) is CLOSED
NEGATIVE without needing FUN_03f66ba0.

Trailing 863 bytes after the text are a 5-byte repeating pattern
(XX 8f 8e 27 d4) plus what looks like a signature/hash blob -- not feature data.

### §18.1 Where this leaves contour assembly
Exhausted inside the tile:
  - RGN3 record stream: fully decoded, no topology field (17.4)
  - top-payload selector lists: 2-8% overlap (14)
  - 0x91 tag: aux-length code, not a delimiter (15, 17.1)
  - arc-key base offsets: noise (11.6)
  - geometric proximity stitching: max chain 8 (14.3)
  - LBL: no feature labels at all (18)

REMAINING HYPOTHESIS, now the leading one: Garmin does NOT store contours as
joined polylines. It stores independent arc fragments and the renderer draws
them as-is. Under that reading our "70% single-arc, median 4 points" output is
FAITHFUL, and producing continuous contours for TrollMap is a DOWNSTREAM
problem (our job), not a decode bug.
Test that by rendering fragments as-is at chartplotter zoom and comparing to
a photo of the Garmin unit showing the same area -- Ryan can shoot that.

---

## §19 — GROUND TRUTH PHOTO: Garmin renders LONG CONTINUOUS CONTOURS (2026-07-29)

Ryan photographed his chartplotter panning Lake Wateree (120 ft scale bar,
Fairfield/Kershaw county line visible, depths 25-42 ft).

WHAT THE SCREEN SHOWS:
  - Long, smooth, CONTINUOUS contour lines spanning the whole screen width
  - 1-FOOT contour intervals (25,27,28,29,30,32,33,34,35,36,38,39,40,41,42)
  - Tight nested bands on slopes, closed rings around humps
  - Inline depth labels placed along each contour
  - NO fragmentation, NO scraps, NO straight-line artefacts

=> 18.1 HYPOTHESIS IS DEAD. Garmin does NOT store disconnected arc fragments.
   The device draws exactly the continuous contours we have failed to produce.
   Our fragmented output is OUR bug, not a faithful rendering of the source.
   Do not re-raise "maybe Garmin stores fragments".

ALSO PROVEN BY THE PHOTO:
  - Depth values ARE per-foot integers -> our integer-foot ladder (11.3) is right
  - Labels are rendered INLINE along contours, yet LBL contains only the
    copyright string (18). So the label TEXT is generated from the depth value
    at draw time; absence of LBL feature records is EXPECTED and is not
    evidence about topology. 18 remains true but is NOT evidence for 18.1.

CROSS-CHECK vs our v6 output for the same depth band:
    depth_ft 25..42 -> 42,60,125,45,38,72,41,33,63,29,25,67,12,12,20,23,21,28
    median points per feature: 4 to 42 (median ~17)
  The device draws a handful of long lines per depth; we emit dozens of short
  ones. Same data, wrong assembly -- consistent with the 14 finding that we
  export ARCS, not contours.

## §20 — COVERAGE BUG FOUND (2026-07-29): 455 dropped chunks

parse_chunk gated on `(chunk[2],chunk[3]) == (1,13)` and silently returned for
everything else. RGN3 actually contains:
    (1,13):  186 chunks, 214,813 bytes (79.3%)
    (3, 8):  455 chunks,  56,037 bytes (20.7%)   <-- SILENTLY DROPPED
    (3,19):    1 chunk,       22 bytes
Top-level (3,8) chunks use the SAME 17-byte header and the SAME record format.
Header-size sweep is unambiguous: hs=17 -> 455/455 parse cleanly (next best
hs=19 -> 50/455).
Recovered: 2,935 additional depth records (+32% over 9,181), clean integer-foot
depth ladder, 1-10 selectors per record.

LESSON: add an explicit counter + warning for every chunk mode encountered and
not parsed. A silent `return` on unexpected data hid 20% of the section for the
entire project.

---

## §21 — v9: per-tile chunk prefix width + 4-tile merge (2026-07-29)

### §21.1 BUG: chunk prefix width is NOT fixed at 2 bytes
C4E0F0 decoded to ZERO records under v8. Cause: v8 hardcoded the chunk mode
bytes at chunk[2],chunk[3] (2-byte prefix). C4E0F0 uses a THREE-byte prefix.
Mode-match sweep is unambiguous:
    C4E0F1  lead=2 -> 100% known modes | lead=3 -> 0%
    C4E0DA  lead=2 -> 100%             | lead=3 -> 0%
    C4E0DB  lead=2 -> 100%             | lead=3 -> 0%
    C4E0F0  lead=2 ->   0%             | lead=3 -> 100%
v9 auto-detects `lead` per tile+section by scoring mode bytes against the
known set {(1,13),(3,8),(3,19)} for RGN3 and {(1,11)} for RGN2. Header length
is lead+15; all chunk field offsets are now lead-relative.
Result: C4E0F0 0 -> 95,429 features. C4E0F1 regression exact (12,115 = v8).

NOTE: RGN2 lead detection scores poorly (23-32%) because RGN2 uses other modes
we have not enumerated. RGN3 (the depth section) hits 100% on every tile, so
depth decode is unaffected. Enumerate RGN2 modes before trusting polygons.

### §21.2 Four-tile decode totals
    C4E0F1   12,115 decoded ->  9,685 intersect lake bbox
    C4E0F0   95,429 decoded ->  2,217
    C4E0DA   11,468 decoded ->    956
    C4E0DB    1,591 decoded ->     15
    merged 12,873 -> 12,869 after dedupe (only 4 cross-tile duplicates)
Output: exports/wateree-4tile-v9.geojson (21.8 MB)
C4E0F0 is 16.8 MB / 8,046 subdivisions but contributes only 2,217 lake
features -- it is mostly Broad River / Parr Reservoir to the west.

### §21.3 Scores (4-tile merged, lake clip)
    features 12,869 | water-contained 7,131 (55.4%)
    <=10ft  median 11.6/11.3 m test/train, passing 2,062
    10-28ft median 167/159 m
    >28ft   median 300/279 m
vs v8 single tile (9,685 scored): <=10ft 9.9/9.5 m, passing 1,701.
Median error rose slightly because the merge ADDS the three neighbour tiles'
lake-edge features, which are scored against a reference that only covers
Wateree proper; absolute passing count rose 1,701 -> 2,062 (+21%).

### §21.4 Process note (timeout)
A single combined decode+merge+score run over 4 tiles (one 16.8 MB) timed out.
Correct pattern, used here: decode each tile in its OWN invocation, write
per-tile GeoJSON, then merge with a streaming bbox filter, then score once.
Never chain all four stages in one command.
