# Lake Wateree SC — Research Gap Analysis

**Date:** 2026-07-13  
**Comparing:** `lake_wateree_sc_research (3).json` vs `lake_packages_lake_wateree_sc_normalized_documents (6).json`

---

## Executive Summary

You're right — the normalized documents contain **dramatically more extractable data** than what ended up in the research profile. The research output has **zero `_extractedFacts`**, **zero `_wqpLimnology`**, and **zero evidence entries under `limnology`**. The profile was built almost entirely from deterministic parsers (ramps worker, eRegulations regex, SCDNR description page scrape, fish attractors worker, and geospatial layers) while the rich scientific content from the EPA report, SEAFWA paper, USGS study, Anglers HQ report, and UofSC thesis was **downloaded but never successfully extracted into the profile**.

The 14 normalized documents contain **~173K characters** of text. The research profile is only **~34K** and most of that is regulations tables + ramp coords from deterministic workers.

---

## Detailed Gap-by-Gap Analysis

### 1. `forage.primaryForage` — EMPTY ❌ (clearly stated in docs)

| Source | Extractable Quote |
|--------|-------------------|
| **SCDNR Striped Bass** (official) | *"Preferred species in freshwater are threadfin shad, gizzard shad and blueback herring."* |
| **Anglers HQ** (fishing report) | *"the main forage base is threadfin and gizzard shad"* / *"there is not a dominant population of blueback herring in Lake Wateree"* |
| **SEAFWA paper** (Table 3) | Gizzard shad 46-86% of standing stock, threadfin shad 1-28%, Lepomis spp 3-16% |

**Should be:** `["Threadfin shad", "Gizzard shad"]`  
**Secondary:** `["Lepomis spp. (bluegill/sunfish)", "Blueback herring (limited)"]`

### 2. `limnology.trophicStatus` — NULL ❌ (stated verbatim)

| Source | Extractable Quote |
|--------|-------------------|
| **EPA NSCEP Report** (official) | *"Survey data indicate Wateree Lake is eutrophic."* |
| **EPA NSCEP Report** | *"It ranked last in overall trophic quality when the 13 South Carolina lakes sampled in 1973 were compared"* |
| **UofSC Thesis (2019)** | *"elevated symptoms of excess nutrients including decreased dissolved oxygen and water clarity, elevated pH and increasing phytoplankton blooms"* |

**Should be:** `"eutrophic"`

### 3. `limnology.waterClarity.secchiFt` — NULL ❌ (data in tables)

| Source | Extractable Data |
|--------|------------------|
| **EPA Report** | Secchi data table: March mean 0.4m (~1.3 ft), range 0.3-0.5m |
| **EPA Report** | Raw data shows Secchi readings of 18", 36", 37" across sampling events |

**Should be:** `~1.3` (ft, from EPA Secchi disc measurements)

**⚠️ CRITICAL BUG:** The research file says *"Mean Secchi disc transparency in Lake Wateree was 17 meters"* — this is **wildly wrong**. The "17" in the EPA raw data is **17 inches** (one Secchi reading), not 17 meters. A 17-meter Secchi reading would make Lake Wateree one of the clearest lakes on Earth. This is a misparse/hallucination.

### 4. `limnology.oxygen.depletionDepthFt` and `anoxicBelowFt` — BOTH NULL ❌

| Source | Extractable Data |
|--------|------------------|
| **EPA Report** | *"Marked depression of dissolved oxygen with depth occurred at sampling stations 1 and 2 in July"* |
| **EPA Report** | DO profile: drops from 8.2 mg/L at surface to 0.9 mg/L at depth (station 1, July) |
| **EPA Report** | DO at station 2: 5.8 → 1.8 mg/L with depth |

**Note:** The `oxygen.note` field DID capture the qualitative statement but the quantitative fields are empty.

### 5. `limnology.thermocline.*` — ALL NULL ❌

| Source | Extractable Data |
|--------|------------------|
| **EPA Report** | Temperature/DO profile data exists in appendix tables |
| **EPA Report** | Max depth sampled 19.5m at station 1, with temp/DO profiles suggesting stratification |

The EPA data has temperature-at-depth data that could derive thermocline depth, but this requires processing the profile.

### 6. `limnology.flowCharacteristics` — NULL ❌

| Source | Extractable Data |
|--------|------------------|
| **EPA Report** | *"Mean hydraulic retention time: 27 days"* |
| **EPA Report** | *"Volume: 382.280 × 10⁶ m³"* |
| **EPA Report** | Full tributary flow data for 8 tributaries with monthly means |
| **WaterWatch** | *"Lake Wateree is the last in series of reservoirs on the Catawba River"* |

### 7. `limnology.surfaceWater` — EMPTY {} ❌

| Source | Extractable Data |
|--------|------------------|
| **Anglers HQ** (June 30, 2026) | *"Morning surface water temperatures are about 81 to 82 degrees"* |
| **Anglers HQ** (June 16) | *"about 80 to 81 degrees"* |
| **Anglers HQ** (May 26) | *"about 76 degrees"* |
| **Anglers HQ** (April 22) | *"about 70 degrees"* |

### 8. `habitat.vegetation` — EMPTY [] (legitimately sparse, but EPA confirms)

| Source | Quote |
|--------|-------|
| **EPA Report** | *"Survey limnologists did not observe any macrophytes or surface concentrations of algae during sampling visits."* |

**Should be:** `["Minimal/absent — no macrophytes observed (EPA NES 1973)"]` or similar note.

### 9. `biology.speciesAbundance` — EMPTY {} ❌

| Source | Extractable Data |
|--------|------------------|
| **SEAFWA paper** | Table 3: Average standing stocks (kg/ha) — gizzard shad, threadfin shad, Lepomis, largemouth bass by year 1977-1985 |
| **SEAFWA paper** | Table 1: Striped bass relative abundance (catch/1000m²) 1980-1986 |
| **Anglers HQ** | *"one of the premiere all-around fisheries in South Carolina"* |

### 10. `archetype` — EMPTY "" ❌

| Source | Extractable Data |
|--------|------------------|
| **SCDNR Description** | *"created in 1920 with the operation of Wateree Hydroelectric Station"* → hydroelectric reservoir |
| **Anglers HQ** | *"still managed by Duke Energy for hydroelectric power generation"* |
| **EPA Report** | *"Mean hydraulic retention time: 27 days"* → run-of-river / low-retention |

**Should be:** `"Hydroelectric reservoir"` or `"Mainstream hydroelectric impoundment"`

### 11. Lake-Specific Regulations — PARTIALLY FILLED but missing nongame devices

| Source | Data Present in Docs but Missing from Profile |
|--------|----------------------------------------------|
| **SCDNR Regs page** | Allowable nongame devices (traps: 2 rec/5 comm, trotlines: 1 line 50 hooks rec/3 lines 150 hooks comm) |

---

## Possible Data Errors in Current Profile

| Field | Current Value | Issue | Correct Value |
|-------|---------------|-------|---------------|
| `maxDepthFt` | 225 | SCDNR says "Maximum Depth: Approximately 225 feet" BUT this may conflate with "Full pond elevation is 225.5 feet". Anglers HQ says "deepest point is around 90 feet". EPA measured max 19.5m (64ft) at deepest station. | Needs resolution — 90ft (Anglers HQ) or ~225ft (SCDNR)? |
| `waterClarity.typical` | "Mean Secchi disc transparency in Lake Wateree was 17 meters" | **WRONG** — 17 is inches from one raw data point, not meters. 17m Secchi would be crystal-clear alpine water. | Mean Secchi ~0.3-0.5m (1-1.6 ft) per EPA data |
| `habitat.artificialHabitatDetails.attractorCount` | 22 | Worker data says 22, SCDNR description page says 17. Possible the worker has more recent data or includes removed attractors. | 17 (SCDNR page) or 22 (worker) — need to note discrepancy |
| Shoreline | Not in profile but SCDNR says both "216 miles" and "620 miles" on same page | Internal SCDNR contradiction | 216 miles (narrative) vs 620 (sidebar — possibly km?) |

---

## Root Cause Analysis: WHY the Gaps Exist

### 1. **`_extractedFacts` is EMPTY (0 facts extracted)**
The LLM fact extraction step (Step 7: `/research/analyze-facts`) either:
- Failed silently and the retry also returned 0 facts
- The `extractRelevantChunks()` function on the client side may have aggressively trimmed the EPA document (62K chars → 6K chunk budget for large docs) and missed the key data tables
- The LLM call may have hit a cold start / timeout

**This is the #1 problem.** With 0 extracted facts, the entire profile was built only from deterministic workers which have no concept of forage, trophicStatus, Secchi, thermocline, etc.

### 2. **`_wqpLimnology` is NULL**
The Water Quality Portal limnology fetch (Step 9) either:
- Failed to get a bounding box from the lake boundary endpoint
- Got no WQP monitoring records in the bbox
- Returned 0 records and was skipped

This means there's no measured thermocline, surface water, or DO data from monitoring stations either.

### 3. **`extractRelevantChunks()` budget is too small for dense scientific docs**
For documents >50K chars (like the EPA report), the budget is only 6K chars. The EPA report has 62K chars of dense limnological data — the function searches for "Wateree" mentions and takes 1200 chars before + 1800 chars after each mention, capped at 6 occurrences. This means the data tables deep in the EPA appendix (where the actual Secchi, DO, temperature profiles live) are likely **never sent to the LLM**.

### 4. **No "second pass" extraction for empty categories**
When the LLM returns 0 facts for forage/trophicStatus/secchi, there's no fallback that says "these categories are still empty, let me re-read the documents specifically for them." The pipeline is one-shot.

---

## Recommendations: How to Fill Gaps WITHOUT Burning Tavily/Firecrawl Credits

The normalized documents are **already downloaded and stored in R2**. All 14 documents with 173K chars of text are sitting there ready. The solution is to re-extract from what you already have:

### Option A: "Local Re-Extraction" Pass (Zero API cost for search/crawl)

Add a **post-pipeline gap-filling step** that:
1. Loads the normalized documents from R2 (already downloaded)
2. For each empty field (`primaryForage`, `trophicStatus`, `secchiFt`, etc.), runs a **targeted mini-prompt** against only the relevant document chunks
3. Uses your existing LLM chain (Groq/Cerebras) — cost is only LLM tokens, not Tavily/Firecrawl

**Implementation sketch:**
```javascript
const FIELD_EXTRACTION_PROMPTS = {
  'biology.primaryForage': {
    docPatterns: ['striped', 'species', 'fish', 'forage', 'description', 'report'],
    prompt: 'What are the primary forage/baitfish species in {{lakeName}}? Return JSON: {"primaryForage": ["species1", "species2"], "evidence": "verbatim quote"}'
  },
  'limnology.trophicStatus': {
    docPatterns: ['EPA', 'eutrophication', 'nutrient', 'water quality', 'report'],
    prompt: 'What is the trophic status of {{lakeName}}? Return JSON: {"trophicStatus": "eutrophic|mesotrophic|oligotrophic", "evidence": "verbatim quote"}'
  },
  'limnology.waterClarity.secchiFt': {
    docPatterns: ['EPA', 'secchi', 'water quality', 'clarity'],
    prompt: 'What is the Secchi disc transparency in {{lakeName}}? Convert to feet. Return JSON: {"secchiFt": number, "evidence": "verbatim quote"}'
  }
  // ... etc for each gap category
};
```

### Option B: Smarter Initial Chunking (Prevent future gaps)

Fix `extractRelevantChunks()` to:
1. **Increase the budget for scientific documents** — 6K chars for a 62K EPA report loses critical tables. Use 12-15K minimum.
2. **Keyword-aware chunking** — Instead of only searching for lake name mentions, also search for domain keywords (`secchi`, `thermocline`, `dissolved oxygen`, `forage`, `trophic`, `shad`, `herring`) and include those passages.
3. **Table-aware extraction** — When a document contains tables (detected by `|---|` or tab patterns), prioritize those chunks.

### Option C: Category-Specific Document Routing

Instead of sending all documents to one mega-prompt, route specific documents to category-specific extraction prompts:
- EPA report → limnology extraction prompt (trophic, secchi, DO, thermocline)
- SEAFWA paper → biology extraction prompt (forage, abundance, stocking)
- Anglers HQ → surface water / current conditions prompt
- SCDNR Striped Bass → species-specific biology prompt

This produces better extraction because each prompt can be laser-focused.

### Option D: Hybrid — "Re-Extract from Cache" Button

Add a UI button: **"Re-analyze cached documents"** that:
1. Pulls normalized docs from R2 (already downloaded — $0 Tavily/Firecrawl)
2. Runs ONLY Steps 7-10 of the pipeline (fact extraction → dedup → profile assembly)
3. Uses improved chunking/prompts from Options B and C
4. Saves as a new version

**This is the lowest-cost, highest-impact fix.** You already paid for the documents. You just need to read them better.

---

## Quick Win: Fields That Can Be Filled Right Now with Zero Research

These values are **verbatim in the normalized documents** and could be deterministically parsed without any LLM:

| Field | Value | Source | Method |
|-------|-------|--------|--------|
| `limnology.trophicStatus` | `"eutrophic"` | EPA Report | Regex: `/indicate.*eutrophic/i` |
| `forage.primaryForage` | `["Threadfin shad", "Gizzard shad"]` | Anglers HQ | Regex: `/main forage.*threadfin.*gizzard/i` |
| `archetype` | `"Hydroelectric reservoir"` | SCDNR Description | Regex: `/Hydroelectric Station/i` |
| `limnology.flowCharacteristics` | `"Mean hydraulic retention time: 27 days"` | EPA Report | Regex: `/retention time.*(\d+) days/i` |
| `habitat.vegetation` | `["None observed"]` | EPA Report | Regex: `/did not observe.*macrophytes/i` |

These could be added to the deterministic parser in the worker (`/research/deterministic-facts`) as regex patterns against the normalized document text — zero LLM cost, zero API credits.

---

## Summary Scorecard

| Category | # Empty Fields | # Fillable from Cached Docs | Fix Difficulty |
|----------|---------------|----------------------------|----------------|
| Forage/Biology | 5 | 4 | Easy (regex + targeted LLM) |
| Limnology | 10 | 7 | Medium (EPA tables need parsing) |
| Habitat | 4 | 1 | Low data available |
| Navigation | 2 | 0 | Low data available |
| Identity | 1 (archetype) | 1 | Easy (regex) |
| Data Errors | 2 | 2 | Need correction |
| **Total** | **24** | **15** | |

**Bottom line:** 15 of the 24 empty fields can be filled from documents you've already downloaded and paid for. The fix is better extraction, not more research.
