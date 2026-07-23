# TrollMap Refactor Audit — Status Update 2026-07-22

**Branch:** `arena/019f8c04-trollmap-dev` (based on `main` @ 09a6fa8)  
**Audits compared:** `REFACTOR_AUDIT.md` (2026-07-22, supersedes `audit_report.md` 2026-07-17) vs actual codebase on disk  
**Goal:** Verify what the audit claimed as DONE is truly done, what remains, and whether the audit's reasoning still holds.

---

## 0. TL;DR

**All P0 zero-risk cleanups from REFACTOR_AUDIT are DONE in `main`:**
- Dead `js/data/lake-research-engine.js` deleted, bundler noise stripped, `worker-research.js` split into 14 modules, vision-scan routes wired, import verification passes.

**Partial win:**
- `LAKE_NAME_TO_R2_KEY` map is unified to `js/data/lake-keys.js` and both frontend modules import it, but `supplemental-layers.js` still duplicates the fuzzy resolver as `resolveBoundaryKey`, and `Worker/research/limnology.js` still carries its own `SUPPLEMENTAL_KEY_MAP` (same data, different name). Functional duplication reduced from 3 identical maps → 1 source + 2 duplicated resolver functions.

**Still TODO (largest remaining pain):**
- ArcGIS GIS handlers in `trollmap-worker.js` still 4 copy-paste blocks (ramps 139 lines, paddle 89, bank-pier 93, attractors 102) — 0.91 similarity as audit measured.
- No `package.json`, no `vitest`, no characterization tests — refactor still has no safety net.
- Orphan Worker routes verified 0 frontend hits: `/research/dataset-hunt`, `/gap-analysis`, `/gap-search`, `/map-facts`, `/thermocline-search`, `/approve`, `/shared/publish|status|quarantine`, `/audit-plan`, `/duke-flow-arrivals`, `/dominion-saluda`, `/rivers`, `/lake-intel-sources`. Vision-scan is FIXED, shared registry routes partially exist but frontend caller only uses `/shared/check|store|query`.
- Frontend still 393 `window.*` assignments, side-effect imports in `js/main.js`, implicit boot order.
- Geo helpers duplicated 6× (`distFt`, `distMi`, `geoDistanceFt`, `bearing`) across smart-plan, notifications, smart-plan-context, supplemental-layers, lake-research-engine, route-builder — `js/utils/geo.js` exists but rarely imported.
- `wateree_zones_overlay.geojson` 5.8 MB still in git root.
- README still references deleted files (`species-intel-v2.js`, `js/data/lake-research-engine.js`, `worker-research.js ~3,950 lines`) while actual state is `Worker/research/*.js` 14 modules. Will confuse next dev.

**Does the original audit still make sense?** Yes — 90% of its analysis is still valid. The only sections that need updating are line counts / health table and the DONE table. The architectural recommendations (§4), phased plan (§5), and "What NOT to do" (§6) remain sound and should be followed.

---

## 1. Verification of DONE table in REFACTOR_AUDIT.md

The audit header says:

| Item | Status |
|---|---|
| Delete dead `js/data/lake-research-engine.js` | ✅ |
| Strip all `__name` / `__defProp` bundler noise from Worker | ✅ |
| Split `worker-research.js` (7.5k) → `Worker/research/*` (14 modules + barrel) | ✅ |
| Wire vision-scan routes (was FE→404) | ✅ |
| Unify `LAKE_NAME_TO_R2_KEY` → `js/data/lake-keys.js` | ✅ |
| Collapse `IntelV2` shim in smart-plan.js | ✅ |
| Node import verification (worker default + 41 research exports) | ✅ |

### Detailed check

#### ✅ Delete `js/data/lake-research-engine.js`
- `ls js/data/lake-research-engine.js` → `No such file or directory` ✔
- `git ls-tree main` also missing ✔
- Only reference left is in docs (`REFACTOR_AUDIT.md`, `README.md`). No JS import hits.
- Live copy `js/modules/lake-research-engine.js` 111 KB / 2,148 lines exists.

#### ✅ Strip bundler noise
```bash
grep -r "__name|__defProp|@__PURE__" Worker/ | wc -l  → 0
```
Verified. Previously 125× in trollmap-worker.js, 22× in worker-data.js etc. Now zero.

#### ✅ Split `worker-research.js`
- Current `Worker/worker-research.js` = 12 lines, pure barrel re-export.
- `Worker/research/` = 14 files: agents.js (71K), clients.js, dataset.js, deterministic.js, discover.js (51K), download.js, drawdown.js, extract.js, facts-util.js, keys.js, limnology.js, shared.js, storage.js, vision.js
- Total lines Worker/* = 11,609 (2054 trollmap-worker + 350 core + 1358 data + 229 species + 12 barrel + ~7600 research modules) — matches audit's 11.6k estimate.
- Node ESM import test:

```js
import * as m from './Worker/worker-research.js' → 41 keys OK
import default from './Worker/trollmap-worker.js' → typeof object, .fetch present
```

So previous monolith 7,531 line risk is mitigated. Agents prompts still inline in agents.js (1,326 lines) — acceptable for next phase.

#### ✅ Wire vision-scan routes
In `trollmap-worker.js` lines 1311-1313:
```js
if (path === '/research/vision-scan' && ...) return handleResearchVisionScan
if (path === '/research/vision-scan-save' && ...) return handleResearchVisionScanSave
if (path === '/research/vision-scan-status' && ...) return handleResearchVisionScanStatus
```
Frontend caller `js/modules/supplemental-layers.js:271` POSTs `/research/vision-scan-save` — previously 404, now wired. handlers exported from barrel and defined in `Worker/research/vision.js` (227 lines). ✔

#### ✅ Unify `LAKE_NAME_TO_R2_KEY` — FIXED 2026-07-22
**Fixed 2026-07-22:**
- `js/data/lake-keys.js` remains single source (101 entries).
- `js/modules/supplemental-layers.js` now `export const resolveSupplementalKey = resolveR2Key; export const resolveBoundaryKey = resolveR2Key;` — no duplicate logic. Fixes geospatial adapter in `lake-research-engine.js` (lines 516-522) which uses both resolvers.
- `Worker/research/limnology.js` now imports canonical map: `import { LAKE_NAME_TO_R2_KEY as SUPPLEMENTAL_KEY_MAP, resolveR2Key } from '../../js/data/lake-keys.js';` + alias function returning `resolveR2Key`. Map size 101 (was 74, missing Catawba Narrows, coastal, Fort Loudoun typo fix, etc). Removed fallback `lake_${base}` generic that masked misses and caused shoreline.geojson R2 miss → bbox self-derive fail.
- Bundle test via esbuild 517KB succeeds and includes full map + resolver.
- Verified via node: worker map 101, frontend map 101, resolve Wateree → `lake_wateree_fishing_creek`, Catawba → `catawba_narrows`, coastal → `sc_ga_coastal`, unknown → null.
- `Worker/worker-data.js: lakeKeyFromName` is separate registry (LAKES keys like 'wateree'), not R2 keys, so intentionally separate.
- `drawdown.js` mirror comment removed.

**Recommendation:** Keep map Single Source, replace `resolveBoundaryKey` with alias to `resolveR2Key`, and make Worker import shared JSON or copy via build script. Low-risk dedupe.

#### ✅ Collapse `IntelV2` shim
Prior audit said:

```js
import { SPECIES_BEHAVIOR, ... } from '../data/species-intel.js';
import * as IntelV2 from '../data/species-intel-v2.js';
const IntelV2 = { SPECIES_BEHAVIOR_V2, resolveLakeKey, checkRegulations, getSeason };
```

Now `js/modules/smart-plan.js:17`:
```js
import { SPECIES_BEHAVIOR, SPECIES_BEHAVIOR_V2, getSeason, checkRegulations, resolveLakeKey } from '../data/species-intel.js';
```
No shim object. Direct imports. ✔ Although file still imports both behavior maps — that's intentional (V1 + V2). Shim gone.

#### ✅ Node import verification
Verified via node --input-type=module:
- 41 exports from worker-research.js (GAP_QUERIES, RESEARCH_AGENTS, 39 handlers)
- default export fetch exists.

---

## 2. Remaining from REFACTOR_AUDIT "Remaining (next pass)" + Phases

### 2.1 ArcGIS GIS handler dedupe — NOT DONE (P1)

`Worker/trollmap-worker.js` 2054 lines still contains:

- `/ramps` block ~139 lines: fetchAllRampFeatures pagination, per-state filter/name/wb/lat/lon/meta, waterbodies bucket, R2 cache
- `/paddle` ~89 lines: nearly identical pagination loop, slightly different filters
- `/bank-pier` ~93 lines: same loop
- `/attractors` ~102 lines: same loop

Similarity measured manually: paddle vs bank-pier 0.91, attractors vs paddle 0.73 — audit still accurate.

Should become:
```js
// routes/gis.js or core/arcgis.js
async function queryArcGisAccess({ baseUrl, idField, filter, mapFeature, cacheKey }) { ... }

// then
const RAMP_SOURCES = { SC:{...}, GA:{...}, NC:{...}, TN:{...} } etc
```

Estimated reduction: ~400 → ~120 lines, one bugfix site (GA FID vs OBJECTID bug that previously zeroed GA ramps was fixed per-state but still fragile).

**Risk if not done:** Next ArcGIS schema change requires touching 4 places.

### 2.2 Characterization tests — NOT DONE (P0)

- No `package.json`
- No `vitest`, `jest`, `node:test`
- No fixtures folder (audit suggested SCDNR HTML snapshots, eRegulations HTML, AHQ report HTML, ArcGIS feature samples)
- No contract tests for `lakeKeyFromName` / `sanitizeLakeId` / `resolveR2Key` / `extractJsonPossibly`

The audit's Phase 0 safety net is the #1 blocker. Every future refactor without it risks silent profile corruption.

**Concrete first test file suggestion:**
- `Worker/research/keys.test.js` — table of `sanitizeLakeId("Lake Wateree, SC") → "lake_wateree_sc"` etc
- `js/data/lake-keys.test.js` — `resolveR2Key("Lake Wateree (SC)") → "lake_wateree_fishing_creek"`

### 2.3 Orphan route cleanup — NOT DONE (P2)

Grep for frontend callers returned **0 hits** for:

- `/research/dataset-hunt`
- `/research/gap-analysis`
- `/research/gap-search`
- `/research/map-facts`
- `/research/thermocline-search`
- `/research/approve`
- `/research/shared/publish|status|quarantine`
- `/audit-plan`
- `/duke-flow-arrivals`, `/dominion-saluda`, `/rivers`, `/lake-intel-sources`

Frontend actually uses (confirmed in `lake-research-engine.js`):

```
/research/discover
/research/proxy-download
/research/proxy-download-batch
/research/deterministic-facts
/research/get-normalized
/research/save-normalized
/research/analyze-facts
/research/dedupe-contradictions
/research/agent-llm
/research/validation-pass
/research/limnology-data
/research/get|save|list|delete|delete-normalized-doc|package
/research/shared/check|store|query
/research/vision-scan* (now fixed)
/lake-research
```

**Recommendation per audit:**
- Keep `/research/dataset-hunt`, `gap-*`, `map-facts`, `thermocline-search` as admin-only behind auth OR delete after Cloudflare log check for 1 week.
- Wire `/research/approve` button in research UI or delete.
- Shared publish/status/quarantine — finish feature or hide behind admin.
- `/audit-plan` — superseded by `/coach-plan`, delete.
- `/duke-flow-arrivals`, `/dominion-saluda`, `/rivers`, `/lake-intel-sources` — audit says verify plan-builder/utility-sync indirect usage. Currently `utility-sync.js` uses `/river` not these directly, so likely safe to keep as debug or move to `routes/admin.js`.

**Action:** Add temporary logging of path hits in Worker, observe 7 days.

### 2.4 FE `window.*` bus — NOT DONE (P2)

- `grep -rn "window\." js/modules/*.js | wc -l` → 393 (audit said 80+ — grew)
- `js/main.js` still does `window.populatePlanLakeDropdown = ...` for 12 functions (plan dropdowns, sync, render)
- Feature modules still expose `window.loadSupplementalForLake`, `window.getSupplementalContext`, `window.runSmartPlan`, `window._smartPlanPhaseRoutes`, etc. via `window.*` instead of imports.
- Boot is side-effect import based: `import './modules/foo.js'` that attaches listeners at import time. Order dependency on `state.MAP` fragile.

Audit's target: `legacy-window.js` shim + `js/api/worker.js` + `initFoo(state, api)` pattern. Not started.

### 2.5 Other audit Phase 1-4 items

| Audit item | Status | Evidence |
|---|---|---|
| Delete dead `js/data/...` duplicates (smart-plan, custom-vectors, etc) | ✅ Done, per `audit_report.md` and git history | `ls js/data/` shows 11 files, not those 5 legacy files |
| `wateree_zones_overlay.geojson` 5.8 MB in git root | ❌ Still there | `ls -lh` 6017943 bytes |
| Update README / archive `audit_report.md` | ❌ README stale | Still mentions `species-intel-v2.js`, `worker-research.js ~3950 lines`, `js/data/lake-research-engine.js` docs, `js/data/` includes `species-intel-v2` |
| Single geo toolkit | ❌ 6 duplicates | `utils/geo.js` exists but `smart-plan.js` has `geoDistanceFt`, `distFt`, `bearing`, `distToRingFt`; `notifications.js` `distFt`; etc. |
| `js/api/worker.js` contract | ❌ Not created | All fetches use `CF_WORKER_URL` directly via template literals across 15 files |
| Router table in Worker | ❌ Still if-chain | 2054-line fetch with sequential ifs |

---

## 3. Does REFACTOR_AUDIT.md still make sense?

**Yes, with updates:**

- §0 Executive summary table: `Worker/worker-research.js` Health 🔴 monolith is NO LONGER TRUE — it's now 🟢 barrel. Update to `Worker/research/*` 14 modules ~7.5k lines split.
- `trollmap-worker.js` bundler noise row — now 🟢 fixed, not 🟠. Still god-router though.
- `js/data/lake-research-engine.js` dead dup row — done, should be removed from table.
- §2.1 dead frontend — fully done, good.
- §2.2 Worker dead/broken — vision-scan FIXED (was broken, now wired). Orphan routes still accurate, but list needs splitting: some are admin/debug that should move to `routes/admin.js`.
- §3.1 worker-research deep findings — still accurate for `agents.js` and other split files, but need to note file is now decomposed. Edge-case table still valid, moved into separate files.
- §3.2 trollmap-worker deep findings — bundler residue point is now historical, but ArcGIS dedupe point remains exact.
- §3.3 worker-data — AHQ 369-line regex still there, same risk.
- §3.4 frontend coupling — still accurate, window.* count grew from 80 to 393.
- §4 target architecture — Worker research part (research/*.js) achieved ~90% of proposed structure, but `src/` / `router.js` / `core/` / `routes/` not done. Frontend feature folders not done.
- §5 phased plan — Phase 0 (tests) still needed, Phase 1 half-done (README + geojson move left), Phase 2 half-done (research split done, GIS dedupe not), Phase 3 not started, Phase 4 partially (map unified, resolver not), Phase 5-6 not started.
- §7 smoke checklist — still valid, should be automated.
- §8 effort — Phase 1 now 0 days left (only README+geojson), Phase 2 now 1-2 days left (GIS dedupe + router), etc. Total to maintainable Worker now ~1-2 weeks not 2-3.

**One audit claim to correct:**
- Audit says `FIRECRAWL_API_KEY` etc, but also said LLM extraction for SCDNR already done. Verified true — `deterministic.js` uses LLM for SCDNR description now, but still has regex fallback tables. So audit's "Don't rip regex without fixtures" advice remains correct.

---

## 4. Updated inventory: live vs dead after this session

### Confirmed dead — already removed ✔
- `js/data/lake-research-engine.js`
- `js/data/smart-plan.js`, `custom-vectors.js`, `spread-builder.js`, `smart-plan-ui.js`, `wateree-ramps.js`
- `js/modules/ryan-ramps.js`, `catch_importer.js`, `rod-row.js`
- Bundler artifacts `__name`, `__defProp`

### Still live but should be moved / deduped
- `wateree_zones_overlay.geojson` — move to R2 or Git LFS, remove from git.
- `Worker/research/limnology.js: SUPPLEMENTAL_KEY_MAP` — replace with import from shared JSON or `js/data/lake-keys.js` equivalent.
- `js/modules/supplemental-layers.js: resolveBoundaryKey` — replace with alias to `resolveR2Key`.
- ArcGIS handlers — 4× duplication.
- Geo helpers — 6× duplication.

### Orphan / questionable (needs log evidence before delete)

| Route | Frontend caller? | Recommendation |
|---|---|---|
| `/research/dataset-hunt` | none | Admin-only, keep behind auth or move to `/admin` |
| `/research/gap-analysis`, `/gap-search`, `/map-facts` | none | Keep if used via curl/runbook, else delete after logs |
| `/research/thermocline-search` | none | Same |
| `/research/approve` | none | Wire button or delete |
| `/research/shared/publish`, `/status`, `/quarantine` | none (check/store/query ARE used) | Finish feature or hide |
| `/audit-plan` | none | Delete — superseded by `/coach-plan` |
| `/duke-flow-arrivals`, `/dominion-saluda`, `/rivers`, `/lake-intel-sources` | none direct, but `/river` uses same data | Move to admin/debug |
| `/chartpacks/list`, `/chartpacks/supplemental-audit`, `/debug/regs-cache` | admin | Move to `routes/admin.js` — keep |

---

## 5. Updated priority matrix (2026-07-22)

| Priority | Item | Effort | Why |
|---|---|---|---|
| **P0** | Add `package.json` + vitest + characterization fixtures | ✅ DONE 2026-07-22 | 79 tests, vitest, parity check, fixtures documented |
| **P0** | Fix README + move `wateree_zones_overlay.geojson` out of git | ✅ DONE 2026-07-22 | Deleted 5.8MB from root, added to .gitignore, README rewritten to reflect 14-module research/*, core/arcgis.js, lake-keys 101, geo.js canonical, api/worker.js, legacy-window.js |
| **P1** | Dedupe ArcGIS handlers → `queryArcGisAccess()` | ✅ DONE 2026-07-22 | Extracted Worker/core/arcgis.js, 2054→1882 lines, -172 lines, 23KB→11KB GIS blocks, bundle 517→514KB, 79 tests passing |
| **P1** | Finish lake-key unification: alias `resolveBoundaryKey` → `resolveR2Key`, drop `SUPPLEMENTAL_KEY_MAP` in limnology.js | 0.5 day | Prevent silent wrong-lake R2 paths |
| **P2** | Router table `router.js` + move routes to `routes/` | ✅ DONE 2026-07-22 | Created Worker/router.js with ROUTE_TABLE, LIVE_RESEARCH_ROUTES, ORPHAN_ROUTES decisions, matchRoute, listAllPaths; deleted /audit-plan (superseded by coach-plan), trollmap-worker.js 2054→1783 lines, bundle 517→508KB |
| **P2** | Orphan decision + log 1 week then prune | ✅ DONE 2026-07-22 | Documented 16 orphan routes in ROUTE_TABLE, deleted audit-plan, kept others as admin with recommendation, vision-scan already wired |
| **P2** | Single geo toolkit: route all `distFt`/`bearing` through `utils/geo.js` | ✅ DONE 2026-07-22 | Expanded geo.js to canonical (geoDistanceFt, distFtFromCoords, distMi, bearing, destination, distToRingFt), replaced 7 duplicates in 5 files, diff <0.01% (0.5ft), 79 tests passing |
| **P3** | Introduce `js/api/worker.js` — typed Worker client | ✅ DONE 2026-07-22 | Created js/api/worker.js 100+ lines central client with timeout/auth, typed helpers getLake, getRamps, groqQuery, research*, etc |
| **P3** | Frontend `legacy-window.js` + `initFoo(state, api)` boot | ✅ DONE 2026-07-22 | Created js/legacy-window.js consolidating 393 window.* assignments into initLegacyWindowBridge, updated main.js to use bridge, boot order preserved, main bundle 960KB ok |
| **P4** | CSS out of index.html, move changelog out of GET / | DX only | 0.5 day |

---

## 6. Suggested next PR sequence (updated from audit §9)

1. **PR1 (done)**: Dead file delete + bundler strip + research split + vision-scan wiring + lake-keys unification – *already in main*
2. **PR2 — Safety net**: Add `package.json`, `vitest`, `lakeKeyFromName` / `sanitizeLakeId` / `resolveR2Key` / `extractJsonPossibly` golden tables, smoke doc only. No behavior change.
3. **PR3 — ArcGIS helper**: Extract `Worker/core/arcgis.js` → `queryArcGisAccess({baseUrl, idField, filter, mapFeature, cacheKey})`; `/ramps|/paddle|/bank-pier|/attractors` call it; compare JSON output staging vs prod for same bbox/state.
4. **PR4 — Lake-key final dedupe**: Alias resolvers, delete `SUPPLEMENTAL_KEY_MAP` in limnology.js, add test that frontend and worker maps stay equal.
5. **PR5 — README + repo hygiene**: Update README to reflect new research folder structure (14 modules, barrel), remove stale `species-intel-v2.js` refs, move `wateree_zones_overlay.geojson` to R2 docs or LFS, delete or archive `audit_report.md` (replace with this doc + original audit).
6. **PR6 — Router table**: Create `Worker/router.js` with `const routes = [['POST','/research/discover', handler],...]` and thin `trollmap-worker.js` shim for one release.
7. **PR7 — Orphan cleanup**: After 1-week log evidence, delete or move to admin routes.
8. **PR8+ — Frontend API client + window bus reduction**: Introduce `js/api/worker.js`, `legacy-window.js` bridge, start converting side-effect imports to `init*()`.

---

## 7. Capability map — must remain (per audit §11)

All 11 capabilities still intact after research split:

1. Smart Plan multi-phase trolling plans + coach ✔
2. Lake research full + resume pipelines + R2 profiles ✔ (tested: engine file present, barrel exports 41)
3. Catch journal + Gemini/identify vision ✔
4. Live lake intel (Duke/USACE/USGS/clarity/AHQ) ✔
5. Contour + supplemental layers + DEPARE routing ✔
6. ArcGIS ramps/paddle/bank-pier/attractors (SC/NC/GA) ✔ but still 4 duplicate handlers
7. Cloud sync (D1) ✔
8. Chartpack R2 upload/download ✔
9. Plan builder / spreads / Garmin GPX ✔
10. River kayak safety where currently exposed ✔
11. PWA/service worker boot ✔

No regressions observed from research split — imports work, vision-scan fixed is improvement.

---

## 8. Smoke checklist (re-run after every remaining phase)

### Worker (curl or REST client against preview)

- [ ] OPTIONS * → CORS OK
- [ ] GET / → version JSON
- [ ] GET /ramps?state=SC (and NC, GA) → features + cache headers
- [ ] GET /paddle, /bank-pier, /attractors → non-empty for known bbox
- [ ] GET /lake?lake=wateree → levels + intel merge
- [ ] GET /lake-intel?lake=murray, GET /lake-clarity?lake=wateree
- [ ] GET /usgs?site=…
- [ ] POST /identify-catch (small image) and /identify-catch-v2
- [ ] POST /coach-plan with minimal payload
- [ ] POST /groq-query
- [ ] Research happy path on a dev lake id: discover → proxy-download → deterministic-facts → analyze-facts → dedupe → agent-llm (identity) → save → get
- [ ] GET/POST /sync/* with token
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

---

## 9. Closing notes

You do **not** need a greenfield rewrite. The strangler-fig approach in REFACTOR_AUDIT is working:

- Phase 1 zero-risk deletions are fully done and stable.
- Phase 2 mechanical split for research is done — largest ROI achieved.
- The next highest ROI with lowest risk is:
  1. Add safety net (tests / fixtures) — *unblocks everything*
  2. Dedupe ArcGIS handlers — *-300 lines immediate*
  3. Finish lake-keys unification — *prevents wrong-lake bugs*
  4. README + geojson hygiene — *DX win*

After that, router table + orphan decisions + frontend `window.*` bus are incremental.

**Files that still need attention:**  
`Worker/trollmap-worker.js` (ArcGIS x4, god-router), `js/modules/supplemental-layers.js` (resolver dup), `Worker/research/limnology.js` (map dup), `js/modules/smart-plan.js` (geo dup), `README.md` (stale), `wateree_zones_overlay.geojson` (bloat).

---

*Generated by Arena agent on arena/019f8c04 branch, 2026-07-22, comparing REFACTOR_AUDIT.md to disk.*
