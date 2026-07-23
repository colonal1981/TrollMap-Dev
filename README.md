# TrollMap — Kayak Fishing Intelligence Platform

A full-suite fishing application built for trolling-first kayak anglers across 66 southeastern US lakes (SC/NC/GA/TN). Started as a trolling lane generator, now a modular ES-modules web app with AI-assisted fish ID, Smart Plan route generation, catch journaling, live lake intelligence, satellite structure detection, and a multi-step lake research pipeline that builds verified intelligence profiles from official documents.

**Live app:** `https://trollmap-dev.pages.dev`
**API worker:** `https://trollmap-worker.colonal1981.workers.dev`

---

## What it does

- **Smart Plan** — AI-generated multi-phase trolling plans per species/lake/season. Produces GPX routes, rod spread recommendations with lead lengths, and a Groq plan audit with scored categories (depth, lure, speed, battery, safety). Uses verified research profiles when available.
- **Lake Research Pipeline** — Multi-step evidence acquisition engine that discovers, downloads, and extracts verified facts from official sources (SCDNR, USGS, EPA, Duke Energy, USACE) to build structured lake intelligence profiles stored in R2. Runs 3-pass targeted LLM extraction by document category, followed by 5 data-assembly agents. Supports full pipeline and resume-from-normalized modes.
- **Catch Journal** — Nightly photo upload workflow with Gemini vision AI for species ID and length measurement, fish/lure photo pairing, GPS lake matching against full DNR access-point database (SC/NC/GA)
- **Live Lake Intelligence** — Water level (Duke Energy API, USACE CWMS API, USGS), dam flow schedules, clarity forecast, solunar timing, species-specific tactical notes, and verified research profile integration
- **Contour Routes** — Depth-contour-following sine-sweep trolling lanes from GeoJSON datasets across 66 lakes. DEPARE depth polygon routing with contour fallback.
- **Supplemental Layers** — SCDNR fish attractors, fishing points/lines, POIs, shoreline data extracted from PBF tile cache and stored in R2 (329 files, 668MB, 70 lakes)
- **Structure Detection** — Groq Llama 4 Scout vision AI detects docks, piers, boat ramps, and timber from the satellite basemap viewport
- **Ramp Database** — Live SC/NC/GA DNR boat ramp data via Cloudflare Worker (ArcGIS REST APIs), per-state IDB cache with independent TTLs
- **Plan Builder** — Full fishing trip plan with rod spread, tackle notes, safety checklist, preview, and PDF export
- **GIS Layers** — SCDNR fish attractors/brush piles, bank/pier access, paddle launches, ramps, catch plot, pinch point finder
- **Garmin Integration** — GPX import/export with Garmin extensions, Quickdraw depth key overlay
- **Cloud Sync** — Cross-device sync via Cloudflare D1 + R2

---

## Architecture

```
trollmap-dev (Cloudflare Pages — auto-deploys from GitHub)
├── index.html
├── sw.js                         # Service worker v16
├── manifest.json                 # PWA metadata
├── js/
│   ├── main.js                   # Entry point (side-effect imports → boot)
│   ├── lazy-data.js              # Optional GIS JSON loader
│   ├── api/                      # (planned) typed worker client - see REFACTOR_AUDIT
│   ├── utils/                    # escape, dedupe, rod-row, db, geo (single source for dist/bearing), parsers
│   ├── data/                     # lakes, access-index, species-intel (unified v1+v2),
│   │                             # lake-keys (single source 101 entries → R2 key), tackle-inventory,
│   │                             # fishing-style-profile, scdnr-state-lakes, user-known-lakes,
│   │                             # spread-defaults, ramps-loader
│   ├── core/                     # state (singleton), tabs, map-init
│   └── modules/                  # ~45+ feature modules (see below)
├── data/                         # Tri-state GIS caches (tristate-*.json) — not contours; contours in R2
├── researchdocs/                 # Golden fixtures: research profiles, normalized docs, EPA PDFs
└── test/                         # Vitest safety net: lake-keys, research-keys, arcgis mappers, fixtures

trollmap-worker (Cloudflare Worker — ES modules, deployed via wrangler)
├── wrangler.toml
├── trollmap-worker.js            # Main fetch router (1882 lines after P1 dedupe, was 2054) + LLM provider chain
├── worker-core.js                # CORS, JSON headers, callLLM provider chain, auth
├── worker-data.js                # LAKES, LAKE_INTEL, RIVERS, clarity profiles, lake/duke/USGS fetchers
├── worker-species.js             # Species lists, ecological validation
├── worker-research.js            # 12-line barrel re-exporting research/*
├── core/
│   └── arcgis.js                 # Shared ArcGIS helper (P1 dedupe): fetchAllFeatures, getCachedGis, handleGisRoute
└── research/                     # Full research pipeline split from 7.5k monolith → 14 modules (P0)
    ├── keys.js                   # sanitizeLakeId, researchStorageId, lakeResearchMasterKey (canonical lake id logic)
    ├── discover.js               # Source discovery (Tavily + seeded URLs)
    ├── download.js               # TinyFish → Scrape.do → Firecrawl → raw fallbacks
    ├── deterministic.js          # SCDNR regs parser, ramp/attractor GIS seeding
    ├── extract.js                # 3-pass targeted LLM fact extraction
    ├── agents.js                 # RESEARCH_AGENTS prompts + sanitizers (1326 lines)
    ├── storage.js                # save/get/list/package/approve/delete, confidence scoring
    ├── shared.js                 # Shared R2 document registry check/store/query/publish
    ├── limnology.js              # WQP integration + supplemental R2 key map (now imports js/data/lake-keys.js single source 101 entries)
    ├── vision.js                 # Vision-scan routes (wired, was 404)
    ├── clients.js, dataset.js, drawdown.js, facts-util.js, etc.

Frontend research modules (js/modules/)
├── lake-research-engine.js       # Pipeline logic, geospatial adapter (uses resolveSupplementalKey/BoundaryKey now unified to js/data/lake-keys.js)
├── lake-research-ui.js           # Research panel UI, renderers, editors
└── lake-research.js              # Barrel re-export

Refactor status: See REFACTOR_AUDIT.md (original) + REFACTOR_STATUS_UPDATE.md (verification) — P0 safety net (vitest 79 tests) and P1 ArcGIS dedupe done.
```

---

## Key modules

| Module | What it does |
|---|---|
| `smart-plan.js` | Multi-phase route planning, species-intel (unified) brain, Groq coach call, uses geo.js canonical |
| `route-builder.js` | Contour-following + DEPARE polygon GPX route generator |
| `plan-builder.js` | Plan form, preview, PDF export |
| `catch-journal.js` | Photo upload, AI ID queue, nightly workflow |
| `lake-intel.js` | Lake intelligence + clarity forecast + verified research profile |
| `lake-research-engine.js` | Evidence acquisition pipeline, geospatial structure derivation |
| `lake-research-ui.js` | Research panel UI, contradiction resolution, per-section re-run |
| `species-intel.js` | Unified species intel (merged v1 regulations + v2 trolling brain, 101 lakes, lake-keys aware) |
| `fishing-style-profile.js` | Angler gear/style constraints (spinning only, no live bait FW) |
| `access-index.js` | Shared worker-backed lake/ramp index (SC/NC/GA DNR) |
| `contour-data.js` | Lazy per-lake contour loading, 24hr IndexedDB TTL, 66-lake registry |
| `supplemental-layers.js` | DEPARE depth polygons, fishing points/POIs, boundary layers |
| `osm-structure.js` | Groq vision dock/structure detection from satellite imagery |
| `gis-toggles.js` | Attractor/ramp/bank-pier/paddle layer toggles |
| `spread-builder.js` | Rod spread table, lure catalog, auto lead-length calculation |
| `duke-energy.js` | Duke Energy lake level dashboard scraper (via worker proxy) |
| `pinch-point-finder.js` | Depth-contour saddle/funnel detection |
| `ble-motor.js` | Web Bluetooth NK180/BMS integration |

---

## Lake Research Pipeline

The research pipeline builds verified intelligence profiles for each lake from official documents. Profiles are stored in R2 and consumed by Smart Plan and Lake Intel.

### Pipeline stages (full run ~7 Tavily credits)

1. **Deterministic facts** — SCDNR regulations parser, ramp/attractor GIS, owner-aware drawdown source seeding
2. **Source discovery** — 5 Tavily searches + seeded URLs (SCDNR, EPA NSCEP, Duke CRA PDFs, USACE, fishing guide publications)
3. **Dataset hunt** — EPA NSCEP + SCDNR annual report discovery via Firecrawl
4. **Download & normalize** — Firecrawl HTML extraction + browser-side PDF.js extraction (client-side, no server CPU)
5. **Scoring & classification** — Authority/relevance/freshness/completeness scoring; class tagging (Hydrology, Limnology, Biology, Regulations, Navigation, Trolling)
6. **3-pass targeted extraction** — Documents routed by classification to 3 focused LLM passes (identity+limnology / biology+habitat / regulations). Index page filter prevents search result pages from burning context budget.
7. **Deduplication + contradiction detection** — Fact merging with source agreement tracking
8. **Deterministic baseline** — SCDNR regs, ramp data, attractor GIS, geospatial structure derivation from contour/supplemental/boundary layers
9. **WQP limnology** — Water Quality Portal depth profile query for DO and temperature
10. **5 agent calls** — Data-assembly agents (identity, limnology, biology, habitat, regulations) receive extracted facts as mandatory pre-filled values + document text. Never overwrite deterministic fields.
11. **Save** — Versioned profile to R2 with confidence scoring (penalized for null critical fields)

**Resume mode** (0 Tavily credits) — skips discovery and download, re-runs extraction from existing normalized documents in R2.

### Owner-aware seeding

Operator-specific sources are automatically injected based on `reservoirOwner`:
- **Duke Energy** → per-lake CRA agreement PDF (pool levels, drawdown schedule) for all 10 Catawba-Wateree chain lakes
- **USACE** → Savannah or Wilmington District water control pages; CWMS Data API for live pool elevation
- **All lakes** → EPA NSCEP search, state DNR description + regulations pages

### Profile schema (key fields)

```
identity:    surfaceAreaAcres, maxDepthFt, averageDepthFt, damName,
             yearImpounded, reservoirOwner, riverSystem, archetype,
             county, normalPoolFt, drawdownType, poolManagement
limnology:   thermocline.summerDepthFt, oxygen.depletionDepthFt,
             oxygen.anoxicBelowFt, waterClarity.secchiFt,
             trophicStatus, hydraulicRetentionDays, waterColor
biology:     predatorSpecies, primaryForage, knownStockings,
             standingStockKgHa, speciesAbundance, forageCalendar
habitat:     structuralElements (points, humps, creekArms,
             channelLedges, flats), cover, artificialHabitatDetails
navigation:  ramps (9 for Wateree), hazards
regulations: generalStateRegulations, lakeSpecificRegulations,
             closedSeasons
```

---

## LLM Provider Chain

| Priority | Provider | Models | Notes |
|---|---|---|---|
| 1 | Groq | `openai/gpt-oss-120b` | Primary — Smart Plan, agents |
| 2 | OpenRouter | `llama-3.3-70b` | Fallback |
| 3 | Cerebras | `gpt-oss-120b` | Fallback |
| 4 | Nvidia NIM | Llama 4 Maverick | Fallback |
| 5 | Gemini | `gemini-2.5-flash` | Limnology agent only; `excludeFromGeneral: true` |

---

## Species coverage (species-intel.js unified)

Striped Bass, Largemouth Bass, White Bass/Hybrid, Crappie, Blue Catfish, Channel Catfish, Flathead Catfish, Bowfin, Chain Pickerel, Red Drum (Redfish), Speckled Trout, Bluegill, Redear Sunfish (Shellcracker)

All entries are trolling-first, spinning-gear-only, freshwater-live-bait-unavailable by default. See `fishing-style-profile.js` for the full angler constraint profile.

---

## Worker bindings

| Binding | Type | Purpose |
|---|---|---|
| `DB` | D1 | Cloud sync database |
| `R2_TROLLMAP_CHARTPACKS` | R2 | Contour chartpacks, supplemental layers, research profiles, normalized documents |
| `GEMINI_API_KEY` | Secret | Fish ID vision AI + limnology agent |
| `GROQ_API_KEY` | Secret | Smart Plan, agents, structure detection |
| `OPENROUTER_API_KEY` | Secret | LLM fallback |
| `CEREBRAS_API_KEY` | Secret | LLM fallback |
| `NVIDIA_API_KEY` | Secret | LLM fallback |
| `TAVILY_API_KEY` | Secret | Source discovery (1,000 credits/month budget) |
| `FIRECRAWL_API_KEY` | Secret | HTML + PDF extraction |
| `SYNC_TOKEN` | Var | Cloud sync auth |

---

## Deployment

**Frontend (automatic):** Push to GitHub → Cloudflare Pages auto-deploys within ~60 seconds.

**Worker (manual):**
```powershell
cd F:\Worker
wrangler deploy
```

Worker is split across core/ + research/* modules — `wrangler.toml` declares `trollmap-worker.js` as main entry point; it imports `worker-core.js`, `worker-data.js`, `worker-species.js`, `worker-research.js` (12-line barrel), `core/arcgis.js`, and `research/*.js` (14 modules). Single source for R2 keys is `js/data/lake-keys.js` (101 entries) used by both frontend and worker (via `../../js/data/lake-keys.js` import in `research/limnology.js`). Tests via `npm test` (vitest 79 tests).

`wrangler.toml` in the project root declares all bindings. Secrets set separately:
```powershell
wrangler secret put GEMINI_API_KEY
wrangler secret put GROQ_API_KEY
wrangler secret put TAVILY_API_KEY
wrangler secret put FIRECRAWL_API_KEY
```

---

## R2 Storage Layout

```
trollmap-chartpacks (R2 bucket) — note: `wateree_zones_overlay.geojson` (5.8MB) removed from git root (2026-07-22) and moved to R2, .gitignore covers it
```
trollmap-chartpacks (R2 bucket)
├── [lake_key]/contours.geojson          # Contour GeoJSON (66 lakes)
├── supplemental/[lake_key]/             # DEPARE, fishing points, POIs, shoreline
├── boundaries/[lake_key].geojson        # Lake boundary polygons
├── lakes/[lake_id].json                 # Research profile master (versioned)
├── lakes/versions/[lake_id]/v[n].json   # Version history
└── lake_packages/[lake_id]/             # Normalized documents, package parts
    ├── normalized_documents.json
    ├── quality_scores.json
    └── [section].json
```

---

## Platform

- **Watercraft:** Native Watersports Slayer Propel Max 12.5 + NK180 Pro 24V electric outboard (stern mount)
- **Sonar:** Garmin ECHOMAP UHD2 93sv + ECHOMAP 93sv chartplotter
- **Battery:** 100Ah LiFePO4
- **Rods:** Spinning only — no lead-core, no conventional reels, no planer boards, no downriggers
- **Rigging:** 30lb braid → swivel snap (A-rigs, spoons); 30lb braid + 3-4ft 20lb fluoro leader + loop knot (all other lures)
- **Primary waters:** Lake Wateree (home lake), Marion, Moultrie, Murray, Monticello + 61 additional SE lakes
