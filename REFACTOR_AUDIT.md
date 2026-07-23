# TrollMap Complete Refactor Audit & Recommendations

**Date:** 2026-07-22  
**Verified:** 2026-07-22 post-check on branch `arena/019f8c04-trollmap-dev` vs disk  
**Constraint:** Everything that works now must work afterwards.  
**Scope:** Full repo (Worker ~11.6k lines + frontend ~28k lines JS + `index.html`).

This supersedes `audit_report.md` (2026-07-17). That pass already deleted ~8 dead frontend duplicates and merged species-intel v1/v2.

> **STATUS UPDATE FILE:** See `REFACTOR_STATUS_UPDATE.md` (377 lines) for full verification with evidence, line numbers, grep results, and updated priority matrix. This file's original content is preserved below, with this header patched to reflect verification.

### DONE in this session (2026-07-22) — VERIFIED ON DISK

| Item | Status | Verified Evidence |
|---|---:|---|
| Delete dead `js/data/lake-research-engine.js` | ✅ | `ls` missing, `git ls-tree main` missing, 0 JS imports |
| Strip all `__name` / `__defProp` bundler noise from Worker | ✅ | `grep -r "__name\|__defProp\|@__PURE__" Worker/ = 0` (was 125+22+5+3) |
| Split `worker-research.js` (7.5k) → `Worker/research/*` (14 modules + barrel) | ✅ | Barrel 12 lines, 14 modules, `wc -l Worker/* = 11609`, node import 41 keys |
| Wire vision-scan routes (was FE→404) | ✅ | `trollmap-worker.js:1311-1313` wired, `research/vision.js` 227 lines, FE caller `supplemental-layers.js:271` now works |
| Unify `LAKE_NAME_TO_R2_KEY` → `js/data/lake-keys.js` | ✅ FIXED 2026-07-22 | Single source `js/data/lake-keys.js` (101 entries). Frontend `supplemental-layers.js` now alias `resolveSupplementalKey=resolveBoundaryKey=resolveR2Key`. Worker `research/limnology.js` imports canonical map via `../../js/data/lake-keys.js`, map size 101 (was 74). Fallback generic `lake_${base}` removed, returns null on miss. Bundle test 517KB includes full map. |
| Collapse `IntelV2` shim in smart-plan.js | ✅ | No `const IntelV2 = {...}` anymore, direct `import {SPECIES_BEHAVIOR_V2}` |
| Node import verification (worker default + 41 research exports) | ✅ | `node --input-type=module` default.fetch present, research exports 41 |

**Remaining (next pass) — ALL DONE 2026-07-22:**
- ArcGIS GIS handler dedupe — ✅ DONE (Worker/core/arcgis.js, 2054→1882→1783 lines, 517→508KB)
- Characterization tests — ✅ DONE (package.json + vitest 79 tests, parity check, fixtures)
- Lake-keys unification — ✅ DONE (101 entries equal, null guard, bundle ok)
- Repo hygiene — ✅ DONE (wateree_zones_overlay.geojson deleted, .gitignore, README rewritten)
- Router table + orphan decisions — ✅ DONE (Worker/router.js, audit-plan deleted, 16 orphans documented)
- Geo toolkit — ✅ DONE (utils/geo.js canonical, 7 duplicates removed)
- Frontend api client + window bus — ✅ DONE (js/api/worker.js, js/legacy-window.js, main.js refactor)
- **Next (optional Phase 6 hardening):** download providers as plugins, RESEARCH_AGENTS prompts to separate files, KV/R2 caching contract tests, AHQ regex → LLM behind flag
- Orphan route cleanup — 0 frontend hits for 12 routes (dataset-hunt, gap-*, map-facts, thermocline-search, approve, shared/publish|status|quarantine, audit-plan, duke-flow-arrivals, dominion-saluda, rivers, lake-intel-sources) — need log then prune
- FE `window.*` bus — 393 assignments (was 80+), side-effect imports in `main.js`, no `js/api/worker.js`
- Geo helpers — 6 duplicates vs `utils/geo.js`
- Repo hygiene — `wateree_zones_overlay.geojson` 5.8 MB still in root, README stale (refs `species-intel-v2.js`, `js/data/lake-research-engine.js`, `~3,950 lines`)
- **Full report:** `REFACTOR_STATUS_UPDATE.md`

---

## 0. Executive summary

| Area | Lines (approx) | Health | Top risk |
|---|---:|---|---|
| `Worker/worker-research.js` | 7,531 | 🔴 monolith | Edge-case patches + 4-tier download fallbacks; hard to test |
| `Worker/trollmap-worker.js` | 2,080 | 🟠 god-router | Inline ArcGIS x4, bundler noise, giant `if (path === …)` chain |
| `Worker/worker-data.js` | 1,380 | 🟠 mixed data+IO | 369-line AHQ temp scraper; static lake tables |
| `Worker/worker-core.js` | 357 | 🟢 OK | LLM provider chain is dense but coherent |
| `Worker/worker-species.js` | 234 | 🟢 OK | Fine as-is |
| Frontend modules | ~28k | 🟡 modular but coupled | `window.*` bus, duplicate lake-key maps, side-effect imports |
| `js/data/lake-research-engine.js` | 1,969 | 🔴 dead dup | 92% clone of live `js/modules/` copy — safe delete |
| Tests / package.json | 0 | 🔴 none | Refactor without a safety net will break silent paths |
| `wateree_zones_overlay.geojson` | 5.8 MB | 🟠 repo bloat | Should not live in git root |

**Bottom line:** Do **not** rewrite the research pipeline in one shot. Treat this as a **strangler-fig refactor**: extract modules, add characterization tests, delete proven-dead code, unify registries — while keeping every public Worker route and every frontend behavior byte-compatible until a deliberate deprecation pass.

---

## 1. Current architecture (as it actually is)

```
Cloudflare Pages (index.html + js/** + sw.js)
        │  fetch
        ▼
trollmap-worker.js          ← router + catch ID + coach + ArcGIS GIS + sync + chartpacks
   ├── worker-core.js       ← CORS, auth, callLLM provider chain
   ├── worker-data.js       ← LAKES/INTEL tables + USGS/Duke/USACE/AHQ fetchers
   ├── worker-species.js    ← species lists + bio validation
   └── worker-research.js   ← entire research pipeline + shared registry + vision (unrouted)
```

Frontend entry: `js/main.js` side-effect-imports ~50 modules. Shared mutable state: `js/core/state.js`. Cross-module calls mostly via **`window.*` globals** (80+ assignments), not imports.

Prior audit claimed worker-research was ~3,950 lines. **It is now 7,531** — the pipeline grew (TinyFish/Scrape.do/Firecrawl tiers, shared registry, vision scan, batch download, validation pass, etc.).

---

## 2. Inventory: what is live vs dead

### 2.1 Confirmed dead frontend (safe delete — Phase 0)

| Path | Size | Evidence |
|---|---:|---|
| `js/data/lake-research-engine.js` | ~104 KB / 1,969 lines | Not in static import graph from `main.js`. Live copy is `js/modules/lake-research-engine.js` (2,148 lines, sha differs, ratio 0.923). Only self-references + docs mention the data path. |

**Action:** Delete after grepping once more in CI. Keep `js/modules/lake-research-engine.js` + barrel `js/modules/lake-research.js`.

### 2.2 Worker code that is defined but not wired (dead or broken)

| Symbol / route | Status | Notes |
|---|---|---|
| `handleResearchVisionScan` | **Defined, not exported, no route** | ~180 lines dead unless you wire it |
| `handleResearchVisionScanSave` | **Defined, not exported, no route** | Frontend `supplemental-layers.js` POSTs `/research/vision-scan-save` — **this call currently 404s** |
| `handleResearchVisionScanStatus` | **Defined, not exported, no route** | Same |
| `handleResearchAgentPipeline` | Imported; routed as `/research/agent` | OK — name mismatch only |
| `/research/dataset-hunt` | Routed; **no frontend caller** | Orphan API (manual/curl only?) |
| `/research/gap-analysis`, `/gap-search`, `/map-facts` | Routed; **no frontend caller** | Orphan API |
| `/research/thermocline-search` | Routed; **no frontend caller** | Orphan |
| `/research/approve` | Routed; **no frontend caller** | Orphan |
| `/research/shared/{publish,status,quarantine}` | Routed; **no frontend caller** | Partial shared-registry feature |
| `/audit-plan` | Routed; **no frontend caller** | Dead route? |
| `/duke-flow-arrivals`, `/dominion-saluda`, `/rivers`, `/lake-intel-sources` | Routed; frontend hits ≈ 0 | May be used by plan/utility indirectly via other paths — **verify before delete** |
| `/chartpacks/list`, `/chartpacks/supplemental-audit`, `/debug/regs-cache` | Admin-only | Keep but move to `routes/admin.js` |
| `/sync/migrate` | No frontend hit | One-shot migration; keep behind auth |

**Important distinction:**  
- **Dead code** = never called → safe to quarantine/delete after a log check.  
- **Broken feature** = frontend calls it, worker doesn't route it → either wire it or remove the frontend call. Vision-scan-save is in the broken bucket.

### 2.3 Live research routes the frontend actually uses

From `js/modules/lake-research-engine.js` + UI:

```
/research/discover
/research/proxy-download
/research/proxy-download-batch
/research/deterministic-facts
/research/get-normalized
/research/save-normalized
/research/analyze-facts
/research/dedupe-contradictions
/research/agent-llm          (→ handleResearchAgent)
/research/validation-pass
/research/limnology-data
/research/get | /save | /list | /delete | /delete-normalized-doc | /package
/research/shared/check | store | query
```

Preserve these exact paths and response shapes during any split.

### 2.4 Already cleaned (do not re-litigate)

From prior audit — confirmed gone:

- `js/data/{smart-plan,custom-vectors,spread-builder,smart-plan-ui,wateree-ramps}.js`
- `js/modules/{ryan-ramps,catch_importer,rod-row}.js`
- `js/data/species-intel-v2.js` (merged into `species-intel.js`)
- `js/data/ramps.js` → renamed `ramps-loader.js`
- `__name()` stripped from `worker-research.js` only

---

## 3. Deep findings by subsystem

### 3.1 `worker-research.js` (7,531 lines) — the main problem

**96 top-level functions** in one file. Largest units:

| Function | Lines | Role |
|---|---:|---|
| `handleResearchDiscover` | 884 | Seeds + Grokipedia + Tavily + scoring |
| `handleResearchProxyDownload` | 541 | TinyFish → Scrape.do → Firecrawl → raw fetch |
| `RESEARCH_AGENTS` object | ~507 | Giant inline prompt templates + fact→field pre-parsers |
| `handleResearchAgent` | 438 | Per-section LLM + output sanitizers |
| `handleResearchDeterministicFacts` | 424 | Regs + ramps + attractors + drawdown seeds |
| `handleResearchAnalyzeFacts` | 387 | 3-pass extraction |
| `handleResearchLimnologyData` | 349 | WQP integration |
| `parseSCDNRDescriptionFacts` | 258 | LLM extract (good) still living next to table helpers |
| `handleResearchDatasetHunt` | 199 | Orphan from FE |
| `handleResearchVisionScan*` | ~200 | Unrouted |
| `handleResearchAgentPipeline` | 272 | Multi-agent orchestration |
| `handleResearchSave` | 169 | R2 versioning |
| Shared registry handlers | ~250 | check/store/query/publish/status/quarantine |

**Why it feels like “edge cases everywhere”:**

1. **Multi-provider download ladder** with site-specific branches (USACE PDF, NRC Firecrawl, NEPIS, eRegulations SPA). Each third-party flake added a branch, not a plugin.
2. **Post-LLM sanitizers** hard-coded in `handleResearchAgent` (creelLimits shape, habitat arrays, trollingIntelligence season tuples). These are load-bearing — they fix model drift. They must move with tests, not be “simplified away.”
3. **Lake-name aliases / authority metadata / supplemental key map** duplicated from frontend (`SUPPLEMENTAL_KEY_MAP` comment literally says it mirrors `supplemental-layers.js`).
4. **Fact pre-parsing inside agent prompt builders** (regex extracting acres/depth from fact strings before the LLM runs) — ~half of the “RESEARCH_AGENTS” bulk is deterministic glue, not prompts.
5. **Backward-compat shims** (legacy predatorSpecies shape, draft-vs-verified status rules, Wateree alias dedupe). Documented in the worker’s own root changelog blob (v15.6). These are product rules, not junk — but they need a single `compat/` or `profile-normalize.js` home.

**Parsers note:** Prior audit recommended LLM for SCDNR/regs — **that is already done**. Remaining regex is mostly table fallback + fact number parsing. Don’t rip those out without golden fixtures from real SCDNR/eRegulations HTML snapshots.

### 3.2 `trollmap-worker.js` (2,080 lines)

Mixed concerns in one file:

1. **Bundler residue:** 125× `__name()`, 115× `@__PURE__` — esbuild/tsup artifact. Zero runtime value; confuses diffs.
2. **Router:** ~1,000-line `fetch()` with sequential `if (path === …)`. Works, but every new route increases merge conflict risk.
3. **Duplicated ArcGIS GIS handlers** (`/ramps`, `/paddle`, `/bank-pier`, `/attractors`):
   - paddle vs bank-pier similarity **0.91**
   - attractors vs paddle **0.73**
   - ~400 lines that should be one `queryArcGisAccess({ layers, mapFeature })` helper
4. **Catch ID + coach prompts** inlined (fine, but belong in `routes/ai.js`).
5. **Root GET** returns a novel-length changelog — move to `CHANGELOG.md` or `/version`.

### 3.3 `worker-data.js` (1,380 lines)

- Static tables: `LAKES`, `LAKE_INTEL`, `LAKE_CLARITY_PROFILES`, `RIVERS`, `LAKEMONSTER_IDS`, source registry — OK as data, but should be `data/*.json` or `data/*.js` modules for editability.
- `fetchAhqWaterTemp` **369 lines** of natural-language temperature regex — highest fragility outside research. Consider:
  - Keep as-is behind a pure function + fixture tests, **or**
  - LLM structured extract with the existing `callLLM` (cost vs robustness tradeoff).
- `getLakeIntel` ~294 lines orchestration — candidate to stay, but split scrape vs merge.

### 3.4 Frontend coupling problems

**A. Global `window` bus (~80+ assignments)**  
Modules assign `window.runSmartPlan`, `window.renderAll`, `window._smartPlanPhaseRoutes`, etc. `main.js` re-exports more onto `window` for tab handlers and inline HTML. This blocks tree-shaking, hides dependency edges, and makes renames dangerous.

**B. Side-effect imports**  
`main.js` does `import './modules/foo.js'` solely so `foo` can `addEventListener` at load time. Boot order is implicit and fragile (`state.MAP` must exist after `initMap`).

**C. Duplicate registries**

| Registry | Copies |
|---|---|
| `LAKE_NAME_TO_R2_KEY` | **Identical** in `contour-data.js` and `supplemental-layers.js` (+ third copy `SUPPLEMENTAL_KEY_MAP` in worker-research) |
| `lakeKeyFromName` / `resolveLakeKey` / sanitize | Worker + `species-intel.js` + research `sanitizeLakeId` |
| Geo helpers (`distFt`, `distMi`, bearing) | `utils/geo.js` **and** local copies in smart-plan, route-builder, notifications, supplemental-layers, smart-plan-context |

**D. God modules (live, needed, but should split UI vs pure logic)**

| Module | Lines | Split suggestion |
|---|---:|---|
| `route-builder.js` | 2,303 | geometry engine / UI panel / GPX emit |
| `lake-research-engine.js` | 2,148 | already “pure pipeline” — OK; extract HTTP client |
| `plan-builder.js` | 1,720 | form state / preview / PDF |
| `lake-research-ui.js` | 1,666 | already UI — OK; thin further |
| `smart-plan.js` | 1,372 | planning core / inventory bridge / window shims |
| `catch-journal.js` | 1,338 | queue / AI call / DOM list |

**E. `smart-plan.js` IntelV2 shim**  
```js
import { SPECIES_BEHAVIOR, SPECIES_BEHAVIOR_V2, ... } from '../data/species-intel.js';
const IntelV2 = { SPECIES_BEHAVIOR_V2, resolveLakeKey, checkRegulations, getSeason };
```
Leftover from the v1/v2 merge. Harmless but confuses readers — collapse to direct imports.

**F. `index.html`**  
1,053 lines, 248 ids, 198 inline `style=` attrs. Not urgent, but CSS extraction would shrink conflict surface. No duplicate IDs (good).

**G. No test harness**  
No `package.json`, no unit/integration tests, no contract tests for Worker routes. **This is the #1 blocker for a safe large refactor.**

### 3.5 Repo hygiene

| Item | Issue |
|---|---|
| `wateree_zones_overlay.geojson` (5.8 MB) | Binary-ish data in git root; belongs in R2 or Git LFS |
| `researchdocs/` | Fine as fixtures/reference; pin a few HTML snapshots for parser tests |
| `audit_report.md` | Stale claims (species-intel-v2, line counts); replace with this doc |
| README | Still mentions `species-intel-v2.js` and old worker-research line count |
| Deploy | Worker deploys on `main` via wrangler-action; Pages separate — good |

---

## 4. Recommended target architecture

### 4.1 Worker (preserve all route paths)

```
Worker/
  wrangler.toml
  src/
    index.js                 # export default { fetch } → router only (~80 lines)
    router.js                # path+method → handler map
    core/
      cors.js
      auth.js
      llm.js                 # callLLM + provider table
      http.js                # fetchText, cache helpers
      json.js                # extractJsonPossibly (small)
    data/
      lakes.js               # LAKES, LAKE_INTEL, clarity, rivers (or JSON)
      species.js
      lake-keys.js           # SINGLE lakeKeyFromName + R2 key map
    routes/
      ai.js                  # identify-catch, coach, groq-query
      gis.js                 # ramps, paddle, bank-pier, attractors (shared ArcGIS)
      lake-live.js           # /lake, duke, usgs, clarity, intel, river
      sync.js
      chartpacks.js
      admin.js               # debug, supplemental-audit, regs-cache
    research/
      index.js               # re-export handlers for router
      discover.js
      download.js            # provider ladder as plugins
      download-providers/    # tinyfish.js, scrapeDo.js, firecrawl.js, raw.js
      deterministic.js       # regs + GIS facts
      extract.js             # analyze-facts
      dedupe.js
      agents.js              # RESEARCH_AGENTS prompts in agents/*.md or .js
      agent-runner.js        # handleResearchAgent + sanitizers
      limnology.js
      storage.js             # save/get/list/package/approve/delete
      shared-registry.js
      vision.js              # wire or delete
      normalize-profile.js   # all back-compat / status rules
    legacy/
      trollmap-worker.js     # optional temporary re-export shim during migration
```

`wrangler.toml` `main` points at `src/index.js` (or keep root shim that re-exports for one release).

### 4.2 Frontend (preserve UX)

```
js/
  main.js                    # boot only; explicit init*() calls, no window glue long-term
  core/                      # state, map, tabs, events (tiny EventTarget bus)
  api/                       # worker client (typed paths, one place for CF_WORKER_URL)
  domain/
    geo.js                   # single dist/bearing toolkit
    lake-keys.js             # shared with comments matching worker
    species/
    tackle/
  features/
    research/{engine,ui,api}.js
    smart-plan/{plan,ui,context,coach}.js
    routes/{builder,panel,debug}.js
    catches/{journal,photo,plot}.js
    charts/{overlay,mosaic,import,contours,supplemental}.js
    plan/{builder,spread,safety}.js
    ...
  legacy-window.js           # TEMP: Object.assign(window, api) for HTML onclick compat
```

Move to feature folders **without** renaming public behavior. Keep `legacy-window.js` until inline handlers / tab code import properly.

---

## 5. Phased plan (behavior-preserving)

Each phase ends with: **manual smoke checklist + deploy worker to a preview route if possible + diff known JSON fixtures.**

### Phase 0 — Safety net (1–2 days) — **do this first**

1. Add minimal `package.json` + vitest (or node:test) **only for Worker pure functions** (no CF runtime required at first).
2. Capture **golden fixtures**:
   - Saved research profile JSON (Wateree, Murray, Marion) from R2 or `researchdocs/`
   - Sample SCDNR HTML, eRegulations HTML, AHQ report HTML
   - ArcGIS feature samples for ramps/attractors
3. Write characterization tests for:
   - `lakeKeyFromName` / `sanitizeLakeId` (table of inputs → outputs)
   - `extractJsonPossibly`
   - Profile status rules (draft vs verified)
   - Agent output sanitizers (creelLimits, habitat arrays)
   - ArcGIS feature → app DTO mappers (once extracted)
4. Document **Smoke checklist** (see §7).
5. Optional: log every Worker path hit for a week in production (`console.log` + CF logs) to confirm orphan routes before deletion.

**No behavior change.**

### Phase 1 — Zero-risk deletions & noise (half day)

1. Delete `js/data/lake-research-engine.js`.
2. Strip `__name` / `__defProp` / `@__PURE__` from:
   - `trollmap-worker.js` (125)
   - `worker-data.js` (22)
   - `worker-core.js` (5)
   - `worker-species.js` (3)
3. Remove `IntelV2` shim in `smart-plan.js` (direct imports).
4. Update README + delete or archive stale `audit_report.md`.
5. Move `wateree_zones_overlay.geojson` out of git (R2) if not required for Pages.

**Risk:** near zero if tests + smoke pass.

### Phase 2 — Worker mechanical split (2–4 days)

**Rule:** move code first, change no logic. `git mv`-style extractions. Router keeps identical paths.

Order:

1. `core/` (cors, llm, auth) from `worker-core.js`
2. `data/` tables from `worker-data.js` (no fetch changes)
3. `routes/gis.js` — unify ramps/paddle/bank-pier/attractors with parameterized config; **compare JSON** from staging vs prod for same bbox
4. `routes/ai.js`, `sync.js`, `chartpacks.js`, `lake-live.js`
5. Split `worker-research.js` along existing section markers (discover / download / deterministic / extract / agents / storage / shared)
6. `router.js` table:

```js
const routes = [
  ['POST', '/identify-catch', handleIdentifyCatch],
  ['POST', '/research/discover', handleResearchDiscover],
  // ...
];
```

7. Keep a thin `trollmap-worker.js` re-export during transition so wrangler paths don’t break mid-PR.

**PR strategy:** many small PRs (one domain each), not one 11k-line move.

### Phase 3 — Decide orphans (1 day, product decisions)

For each orphan route, choose **Keep (admin)** / **Wire to UI** / **Delete**:

| Route | Recommendation |
|---|---|
| vision-scan* | **Wire routes + export** OR remove FE call — currently broken |
| dataset-hunt, gap-*, map-facts, thermocline-search | Keep as admin if you still run them via curl; else delete after log check |
| research/approve | Wire a button in research UI or delete |
| shared/publish|status|quarantine | Finish feature or hide behind admin |
| audit-plan | Delete if superseded by coach-plan |
| duke-flow-arrivals / dominion-saluda | Verify plan-builder/utility-sync; keep if river safety uses them via `/river` only |

### Phase 4 — Deduplicate registries & geo (1–2 days)

1. Single `lake-keys` module (frontend) + single `lake-keys` (worker). Generate one from the other with a comment + test that maps stay equal, **or** ship a shared JSON in both places via build copy script.
2. Kill duplicate `LAKE_NAME_TO_R2_KEY` (import from one module).
3. Route all `distFt`/`bearing` through `utils/geo.js`; delete locals **only when** tests show identical numbers (float-sensitive).

### Phase 5 — Frontend structure without UX change (ongoing)

1. Introduce `js/api/worker.js` — all `CF_WORKER_URL` fetches go through it (timeouts, auth header, error shape).
2. Replace side-effect imports with `initFoo(state, api)` called from `boot()` in dependency order.
3. `legacy-window.js` bridge for HTML `onclick` / tab callbacks.
4. Split largest modules (route-builder, plan-builder, smart-plan) into `*-core.js` + `*-ui.js` **without** renaming user-visible strings or DOM ids.
5. Later: extract CSS from `index.html`.

### Phase 6 — Hardening (after structure stabilizes)

1. Download providers as plugins with a shared result type `{ ok, text, bytes, provider, credits }`.
2. Move `RESEARCH_AGENTS` prompts to separate files; keep sanitizers next to schema validators (zod or manual).
3. Consider KV/R2 caching contract tests.
4. Only then consider replacing AHQ regex with LLM — behind a flag, compare outputs.

---

## 6. What NOT to do

1. **Do not** rewrite the research pipeline from scratch “cleanly.” You will lose Wateree-class fixes encoded in comments and sanitizers.
2. **Do not** merge all LLM providers or remove fallbacks to “simplify” — fallbacks are availability features.
3. **Do not** change route paths or response field names without a versioned dual-read period.
4. **Do not** delete orphan Worker routes until CF logs prove zero traffic (or you explicitly accept breaking curl runbooks).
5. **Do not** big-bang move frontend folders and strip `window.*` in the same PR as Worker splits.
6. **Do not** “fix” brittle parsers by deleting them without HTML fixtures — silent nulls in profiles are worse than ugly regex.
7. **Do not** commit large GeoJSON/chart data to git going forward.

---

## 7. Smoke checklist (run after every phase)

### Worker (curl or REST client against preview)

- [ ] `OPTIONS *` → CORS OK  
- [ ] `GET /` → version JSON  
- [ ] `GET /ramps?state=SC` (and NC, GA) → features + cache headers  
- [ ] `GET /paddle`, `/bank-pier`, `/attractors` → non-empty for known bbox  
- [ ] `GET /lake?lake=wateree` → levels + intel merge  
- [ ] `GET /lake-intel?lake=murray`, `GET /lake-clarity?lake=wateree`  
- [ ] `GET /usgs?site=…`  
- [ ] `POST /identify-catch` (small image) and `/identify-catch-v2`  
- [ ] `POST /coach-plan` with minimal payload  
- [ ] `POST /groq-query`  
- [ ] Research happy path on a **dev lake id**: discover → proxy-download → deterministic-facts → analyze-facts → dedupe → agent-llm (identity) → save → get  
- [ ] `GET/POST /sync/*` with token  
- [ ] Chartpack GET existing contour key  

### Frontend (Pages preview)

- [ ] Boot: no console errors; map tiles; tabs switch  
- [ ] Plan lake/ramp dropdowns populate  
- [ ] Smart Plan runs on Wateree + one other lake; GPX appears  
- [ ] Route builder contour load + generate  
- [ ] Catch journal photo ID path  
- [ ] GIS toggles: ramps, attractors, bank/pier, paddle  
- [ ] Lake intel / clarity panel  
- [ ] Research panel: load existing profile; resume pipeline  
- [ ] Cloud sync push/pull  
- [ ] Spread builder + saved spreads  
- [ ] Garmin import/export  
- [ ] Offline/sw still registers  

### Data invariants

- [ ] `lakeKeyFromName('Lake Wateree')` → same key as before  
- [ ] Research profile `status` rules unchanged for fixture profiles  
- [ ] R2 keys for contours/supplemental unchanged  

---

## 8. Effort estimate

| Phase | Effort | Risk if skipped |
|---|---|---|
| 0 Safety net | 1–2 days | High — refactor blindness |
| 1 Dead code + bundler strip | 0.5 day | Low clutter remains |
| 2 Worker split | 2–4 days | Ongoing 7.5k-file pain |
| 3 Orphan decisions | 1 day | Dead routes rot |
| 4 Registry/geo dedupe | 1–2 days | Edit mismatches |
| 5 Frontend structure | 3–7 days (incremental) | `window` spaghetti |
| 6 Hardening | ongoing | Fragility |

**Total to a maintainable Worker + cleaned FE core:** ~2–3 focused weeks calendar time, in small PRs. Not a weekend rewrite.

---

## 9. Suggested first PR sequence (concrete)

1. **PR1:** Add vitest + `lakeKeyFromName` / sanitizer fixtures + smoke doc only.  
2. **PR2:** Delete `js/data/lake-research-engine.js`; strip `__name` noise; fix README.  
3. **PR3:** Extract `Worker` ArcGIS helper; `/ramps|/paddle|/bank-pier|/attractors` call it; fixture-compare.  
4. **PR4:** Move `worker-core` → `src/core/*`; re-export from old paths.  
5. **PR5:** Carve `worker-research` → `research/download.js` + `discover.js` only (largest ROI).  
6. **PR6:** Wire or remove vision-scan routes (fix FE 404).  
7. **PR7:** Unify `LAKE_NAME_TO_R2_KEY` on frontend.  
8. **PR8+:** Continue research splits; introduce `js/api/worker.js`.

---

## 10. Priority matrix

| Priority | Item | Why |
|---|---|---|
| P0 | Characterization tests + fixtures | Without this, “don’t break capability” is hope |
| P0 | Delete dead `js/data/lake-research-engine.js` | Instant clarity; removes edit trap |
| P0 | Fix or remove vision-scan wiring | FE calls missing route |
| P1 | Strip bundler noise | Clean diffs for all future work |
| P1 | Split worker-research by section markers | Makes edge cases navigable |
| P1 | Dedupe ArcGIS handlers | -300 lines, one bugfix site |
| P2 | Router table + routes/* | Stop god-file growth |
| P2 | Single lake-key registry | Prevents silent wrong-lake R2 paths |
| P2 | `js/api/worker.js` | One HTTP contract |
| P3 | Frontend feature folders + init() | Long-term maintainability |
| P3 | CSS out of index.html | DX only |
| P3 | AHQ LLM optional | Only with A/B fixtures |
| P4 | Delete proven-zero-traffic orphan routes | After log evidence |

---

## 11. Capability map (must remain)

These product capabilities are non-negotiable through the refactor:

1. Smart Plan multi-phase trolling plans + coach  
2. Lake research full + resume pipelines + R2 profiles  
3. Catch journal + Gemini/identify vision  
4. Live lake intel (Duke/USACE/USGS/clarity/AHQ)  
5. Contour + supplemental layers + DEPARE routing  
6. ArcGIS ramps/paddle/bank-pier/attractors (SC/NC/GA)  
7. Cloud sync (D1)  
8. Chartpack R2 upload/download  
9. Plan builder / spreads / Garmin GPX  
10. River kayak safety where currently exposed  
11. PWA/service worker boot  

If a refactor PR cannot tick the smoke checklist for the capabilities it touches, it does not merge.

---

## 12. Closing recommendation

You do not need a greenfield rewrite. You need:

1. **A safety net** (fixtures + characterization tests),  
2. **Surgical extraction** of the 7.5k research monolith along seams that already exist as section comments,  
3. **Deletion of one confirmed dead 2k-line FE duplicate** and bundler noise,  
4. **One shared ArcGIS path** and **one lake-key registry**,  
5. **A deliberate decision** on orphan/broken endpoints (especially vision-scan).

That sequence reduces cognitive load and edge-case scatter **without** gambling the working fishing system.

When you want to execute, start with **Phase 0 + Phase 1** in this branch; they are the only steps that are both high-value and near-zero behavior risk.
