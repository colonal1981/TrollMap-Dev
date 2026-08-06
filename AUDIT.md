# TrollMap audit — GENERATED, do not edit

Regenerate with `node tools/audit.mjs`. Written by `tools/audit.mjs` from source, so it
cannot drift from the tree. If something here is wrong, the code changed.

Every "unused" finding below is a QUESTION, not a verdict. This is regex over source, not a
type-aware pass — a binding reached through a computed name, a runtime-built string, or the
Python side will read as dead here and may not be. See the `lakes.js` near miss in
`DELETION_TAB.md`: "no production JS imports it" was true, "nothing depends on it" was false.

## Summary

| metric | count |
|---|---|
| files | 244 |
| jsModules | 178 |
| pyScripts | 64 |
| routes | 58 |
| routesUncalled | 13 |
| routesMutatingUngated | 19 |
| feeds | 77 |
| deadExports | 159 |
| orphanModules | 4 |
| duplicateFnNames | 27 |
| crossModuleGlobals | 48 |
| unresolvedImports | 0 |

## Worker routes

| route | method | auth | fetches | R2 | called from |
|---|---|---|---|---|---|
| `/attractors` | ANY | open | services.arcgis.com<br>services6.arcgis.com<br>services1.arcgis.com | — | gis-toggles.js |
| `/bank-pier` | ANY | open | services.arcgis.com<br>services6.arcgis.com<br>services1.arcgis.com | — | gis-toggles.js |
| `/build` | POST | open | — | — | **nothing** |
| `/chartpacks/lake-boundary` | GET | open | — | R2_TROLLMAP_CHARTPACKS.get<br>R2_TROLLMAP_CHARTPACKS.list | lake-research-engine.js<br>supplemental-layers.js |
| `/chartpacks/list` | ANY | open | — | R2_TROLLMAP_CHARTPACKS.list<br>R2_TROLLMAP_CHARTPACKS.get | **nothing** |
| `/coach-plan` | POST | open | — | — | groq-coach.js |
| `/debug/regs-cache` | ANY | **REQUIRED (inline)** | — | — | **nothing** |
| `/dominion-saluda` | ANY | **REQUIRED (inline)** | — | — | **nothing** |
| `/duke` | ANY | open | waterservices.usgs.gov | — | duke-energy.js |
| `/duke-flow-arrivals` | ANY | **REQUIRED (inline)** | — | — | **nothing** |
| `/groq-query` | POST | open | — | — | groq-coach.js<br>smart-plan.js |
| `/identify-catch` | POST | open | — | — | catch-journal.js |
| `/identify-catch-v2` | POST | open | — | — | catch-journal.js |
| `/lake` | ANY | **REQUIRED (inline)** | — | — | lake-research-engine.js<br>utility-sync.js |
| `/lake-clarity` | ANY | open | — | — | lake-intel.js |
| `/lake-intel` | ANY | open | — | — | main.js<br>lake-intel.js |
| `/lake-intel-sources` | ANY | open | — | — | **nothing** |
| `/lake-research` | GET | open | services.arcgis.com<br>services6.arcgis.com<br>services1.arcgis.com | — | main.js |
| `/lakes/` | GET | open | services.arcgis.com<br>services6.arcgis.com<br>services1.arcgis.com | — | **nothing** |
| `/lakes/list` | GET | open | — | — | **nothing** |
| `/paddle` | ANY | open | services.arcgis.com<br>services6.arcgis.com<br>services1.arcgis.com | — | access-index.js<br>gis-toggles.js |
| `/ramps` | ANY | open | services.arcgis.com<br>services6.arcgis.com<br>services1.arcgis.com | — | access-index.js<br>ramps-loader.js<br>main.js |
| `/research/agent-llm` | POST | open | — | — | lake-research-engine.js |
| `/research/analyze-facts` | POST | open | — | — | lake-research-engine.js |
| `/research/approve` | POST | **REQUIRED (list)** | services.arcgis.com | — | **nothing** |
| `/research/dataset-hunt` | POST | **REQUIRED (list)** | — | — | **nothing** |
| `/research/dedupe-contradictions` | POST | open | — | — | lake-research-engine.js |
| `/research/delete` | POST | **REQUIRED (list)** | services.arcgis.com | — | lake-research-ui.js |
| `/research/delete-normalized-doc` | POST | **REQUIRED (list)** | services.arcgis.com | — | lake-research-ui.js |
| `/research/deterministic-facts` | POST | open | — | — | lake-research-engine.js |
| `/research/discover` | POST | open | — | — | lake-research-engine.js |
| `/research/gap-analysis` | POST | open | — | — | **nothing** |
| `/research/gap-search` | POST | open | — | — | **nothing** |
| `/research/get` | GET | open | — | — | lake-research-engine.js<br>lake-research-ui.js |
| `/research/get-normalized` | GET | open | — | — | lake-research-engine.js |
| `/research/limnology-data` | POST | open | — | — | lake-research-engine.js |
| `/research/list` | GET | open | — | — | lake-research-ui.js |
| `/research/map-facts` | POST | open | — | — | **nothing** |
| `/research/package` | GET | open | services.arcgis.com<br>services6.arcgis.com<br>services1.arcgis.com | — | lake-research-ui.js |
| `/research/proxy-download` | GET | open | — | — | lake-research-engine.js |
| `/research/proxy-download-batch` | POST | open | services.arcgis.com | — | lake-research-engine.js |
| `/research/save` | POST | **REQUIRED (list)** | services.arcgis.com | — | lake-research-engine.js<br>lake-research-ui.js |
| `/research/save-normalized` | POST | **REQUIRED (list)** | — | — | lake-research-engine.js |
| `/research/shared/check` | POST | open | services.arcgis.com<br>services6.arcgis.com | — | lake-research-engine.js |
| `/research/shared/publish` | POST | **REQUIRED (list)** | services.arcgis.com<br>services6.arcgis.com | — | **nothing** |
| `/research/shared/quarantine` | POST | **REQUIRED (list)** | services.arcgis.com<br>services6.arcgis.com<br>services1.arcgis.com | — | **nothing** |
| `/research/shared/query` | POST | open | services.arcgis.com<br>services6.arcgis.com | — | lake-research-engine.js |
| `/research/shared/status` | GET | open | services.arcgis.com<br>services6.arcgis.com | — | **nothing** |
| `/research/shared/store` | POST | **REQUIRED (list)** | services.arcgis.com<br>services6.arcgis.com | — | lake-research-engine.js |
| `/research/thermocline-search` | POST | open | — | — | **nothing** |
| `/research/validation-pass` | POST | open | services.arcgis.com<br>services6.arcgis.com<br>services1.arcgis.com | — | lake-research-engine.js |
| `/river` | ANY | **REQUIRED (inline)** | — | — | plan-builder.js |
| `/rivers` | ANY | **REQUIRED (inline)** | — | — | **nothing** |
| `/sync` | ANY | **REQUIRED (prefix)** | — | — | cloud-sync.js |
| `/sync/list-updates` | GET | **REQUIRED (prefix)** | — | R2_TROLLMAP_CHARTPACKS.get | cloud-sync.js |
| `/sync/migrate` | POST | **REQUIRED (prefix)** | — | — | **nothing** |
| `/usgs` | ANY | open | waterservices.usgs.gov | — | lake-research-engine.js |
| `limnology.thermocline.strength` | ANY | open | — | — | lake-research-engine.js<br>smart-plan.js |

### Non-GET routes not in MUTATING_ROUTES

Read-shaped POSTs (LLM proxies, search) are deliberately open — see the comment above
`MUTATING_ROUTES`. Anything here that WRITES is a hole.

- `POST /build` — Worker/trollmap-worker.js:1133
- `POST /identify-catch` — Worker/trollmap-worker.js:1139
- `POST /identify-catch-v2` — Worker/trollmap-worker.js:1147
- `POST /coach-plan` — Worker/trollmap-worker.js:1154
- `POST /groq-query` — Worker/trollmap-worker.js:1157
- `POST /research/thermocline-search` — Worker/trollmap-worker.js:1174
- `POST /research/limnology-data` — Worker/trollmap-worker.js:1179
- `POST /research/deterministic-facts` — Worker/trollmap-worker.js:1182
- `POST /research/discover` — Worker/trollmap-worker.js:1185
- `POST /research/analyze-facts` — Worker/trollmap-worker.js:1202
- `POST /research/dedupe-contradictions` — Worker/trollmap-worker.js:1205
- `POST /research/map-facts` — Worker/trollmap-worker.js:1208
- `POST /research/gap-analysis` — Worker/trollmap-worker.js:1211
- `POST /research/gap-search` — Worker/trollmap-worker.js:1214
- `POST /research/agent-llm` — Worker/trollmap-worker.js:1217
- `POST /research/proxy-download-batch` — Worker/trollmap-worker.js:1240
- `POST /research/shared/check` — Worker/trollmap-worker.js:1244
- `POST /research/shared/query` — Worker/trollmap-worker.js:1250
- `POST /research/validation-pass` — Worker/trollmap-worker.js:1282

## Routes nothing calls

- `/build` (Worker/trollmap-worker.js:1133)
- `/research/thermocline-search` (Worker/trollmap-worker.js:1174)
- `/research/dataset-hunt` (Worker/trollmap-worker.js:1188)
- `/research/map-facts` (Worker/trollmap-worker.js:1208)
- `/research/gap-analysis` (Worker/trollmap-worker.js:1211)
- `/research/gap-search` (Worker/trollmap-worker.js:1214)
- `/lakes/list` (Worker/trollmap-worker.js:1220)
- `/research/shared/status` (Worker/trollmap-worker.js:1256)
- `/lake-intel-sources` (Worker/trollmap-worker.js:1590)
- `/duke-flow-arrivals` (Worker/trollmap-worker.js:1637)
- `/dominion-saluda` (Worker/trollmap-worker.js:1643)
- `/rivers` (Worker/trollmap-worker.js:1648)
- `/sync/migrate` (Worker/trollmap-worker.js:1669)

## External feeds

| host | side | refs | first seen |
|---|---|---|---|
| pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev | worker | 42 | Worker/research/clients.js:120 |
| www.dnr.sc.gov | worker, browser | 12 | Worker/research/dataset.js:6 |
| trollmap-worker.colonal1981.workers.dev | pipeline, browser | 11 | Scripts/make_river_boundaries.py:8 |
| api.firecrawl.dev | worker | 9 | Worker/research/dataset.js:269 |
| services.arcgis.com | pipeline, worker | 7 | Scripts/fetch_dnr_paddle.py:64 |
| services1.arcgis.com | pipeline, worker | 7 | Scripts/fetch_dnr_paddle.py:76 |
| services6.arcgis.com | pipeline, worker | 7 | Scripts/fetch_dnr_paddle.py:92 |
| services3.arcgis.com | pipeline, worker | 7 | Scripts/fetch_dnr_paddle.py:102 |
| nepis.epa.gov | worker, browser | 6 | Worker/research/dataset.js:10 |
| lakes.hydro-derived.duke-energy.app | worker, browser | 6 | Worker/trollmap-worker.js:383 |
| www.topografix.com | browser | 6 | js/modules/garmin-export.js:65 |
| api.waterdata.usgs.gov | pipeline, browser | 4 | Scripts/build_water_bindings.py:97 |
| www.waterqualitydata.us | pipeline, worker, browser | 4 | Scripts/wqp_clarity_coverage.py:49 |
| grokipedia.com | worker | 4 | Worker/research/discover.js:481 |
| unpkg.com | browser | 4 | index.html:8 |
| worker | browser | 4 | test/deterministic-regression.test.js:6 |
| mapservices.weather.noaa.gov | pipeline, worker | 3 | Scripts/build_lake_drainage.py:152 |
| waterservices.usgs.gov | pipeline, worker | 3 | Scripts/build_water_bindings.py:98 |
| dash.cloudflare.com | pipeline | 3 | Scripts/trollmap_r2_clean.py:6 |
| api.scrape.do | worker | 3 | Worker/research/clients.js:89 |
| generativelanguage.googleapis.com | worker | 3 | Worker/research/vision.js:126 |
| www.dominionenergy.com | worker, browser | 3 | Worker/trollmap-worker.js:426 |
| www.santeecooper.com | browser | 3 | js/modules/utility-sync.js:49 |
| x | browser | 3 | test/arcgis-filter-guard.test.js:176 |
| w.dev | browser | 3 | test/shared-latest-pointer.test.js:73 |
| www.tva.com | pipeline, browser | 2 | Scripts/build_water_bindings.py:93 |
| api.tidesandcurrents.noaa.gov | pipeline, browser | 2 | Scripts/build_water_bindings.py:96 |
| github.com | pipeline | 2 | Scripts/r2_audit.py:103 |
| aa.usno.navy.mil | worker, browser | 2 | Worker/conditions.js:116 |
| api.search.tinyfish.ai | worker, browser | 2 | Worker/research/clients.js:8 |
| api.fetch.tinyfish.ai | worker, browser | 2 | Worker/research/clients.js:9 |
| georgiawildlife.com | worker, browser | 2 | Worker/research/dataset.js:17 |
| coastalgadnr.org | worker, browser | 2 | Worker/worker-data.js:1256 |
| deq.nc.gov | worker, browser | 2 | Worker/worker-data.js:1257 |
| www.eregulations.com | worker, browser | 2 | Worker/worker-data.js:1259 |
| server.arcgisonline.com | browser | 2 | js/core/map-init.js:29 |
| 127.0.0.1 | browser | 2 | js/modules/capture-panel.js:14 |
| cdnjs.cloudflare.com | browser | 2 | js/modules/lake-research-engine.js:825 |
| api.open-meteo.com | browser | 2 | js/modules/plan-builder.js:778 |
| cofc.edu | browser | 2 | test/discover-authority.test.js:45 |
| hydro.nationalmap.gov | pipeline | 1 | Scripts/build_lake_drainage.py:61 |
| api.water.noaa.gov | pipeline | 1 | Scripts/build_water_bindings.py:92 |
| cwms-data.usace.army.mil | pipeline | 1 | Scripts/build_water_bindings.py:94 |
| wiki.openstreetmap.org | pipeline | 1 | Scripts/fetch_osm_coastal.py:343 |
| prd-tnm.s3.amazonaws.com | pipeline | 1 | Scripts/trollmap_nhd_boundaries.py:33 |
| api.cloudflare.com | pipeline | 1 | Scripts/trollmap_r2_clean.py:39 |
| forecast.weather.gov | worker | 1 | Worker/conditions.js:151 |
| www.ncwildlife.org | worker | 1 | Worker/research/dataset.js:13 |
| r.jina.ai | worker | 1 | Worker/research/download.js:384 |
| api.tavily.com | worker | 1 | Worker/research/extract.js:763 |
| services.arcgisonline.com | worker | 1 | Worker/research/vision.js:91 |
| api.hydro-derived.duke-energy.app | worker | 1 | Worker/trollmap-worker.js:376 |
| api.groq.com | worker | 1 | Worker/worker-core.js:126 |
| openrouter.ai | worker | 1 | Worker/worker-core.js:139 |
| trollmap.dev | worker | 1 | Worker/worker-core.js:152 |
| api.cerebras.ai | worker | 1 | Worker/worker-core.js:159 |
| static.cloudflareinsights.com | browser | 1 | index.html:1146 |
| tile.openstreetmap.org | browser | 1 | js/core/map-init.js:33 |
| saltwaterfishing.sc.gov | browser | 1 | js/data/coastal-regulations.js:53 |
| fishing-app.gpsnauticalcharts.com | browser | 1 | js/modules/capture-panel.js:15 |
| archive-api.open-meteo.com | browser | 1 | js/modules/catch-journal.js:159 |
| cdn.jsdelivr.net | browser | 1 | js/modules/catch-journal.js:1067 |
| lakes.duke-energy.com | browser | 1 | js/modules/duke-energy.js:147 |
| www.garmin.com | browser | 1 | js/modules/garmin-export.js:66 |
| www.openstreetmap.org | browser | 1 | js/modules/ramps.js:58 |
| nominatim.openstreetmap.org | browser | 1 | js/modules/topbar.js:106 |
| www.sad.usace.army.mil | browser | 1 | test/discover-authority.test.js:20 |
| waterdata.usgs.gov | browser | 1 | test/discover-authority.test.js:22 |
| www.osti.gov | browser | 1 | test/discover-authority.test.js:23 |
| tidesandcurrents.noaa.gov | browser | 1 | test/discover-authority.test.js:24 |
| www.ncwildlife.gov | browser | 1 | test/discover-authority.test.js:26 |
| www.tn.gov | browser | 1 | test/discover-authority.test.js:28 |
| lakelevels.duke-energy.com | browser | 1 | test/discover-authority.test.js:29 |
| elibrary.ferc.gov | browser | 1 | test/discover-authority.test.js:30 |
| seafwa.org | browser | 1 | test/discover-authority.test.js:32 |
| southcarolinaparks.com | browser | 1 | test/discover-authority.test.js:34 |
| www.whitehouse.gov | browser | 1 | test/discover-authority.test.js:83 |

## R2 key shapes

| op | key expression | where |
|---|---|---|
| get | `cacheKey` | Worker/core/arcgis.js:91 |
| put | `cacheKey` | Worker/core/arcgis.js:327 |
| get | `cacheKey` | Worker/core/arcgis.js:356 |
| put | `key` | Worker/research/deterministic.js:146 |
| get | `key` | Worker/research/deterministic.js:165 |
| get | ``lake_packages/${LEGACY_PROFILE_KEYS[safe]}/normalized_documents.json`` | Worker/research/deterministic.js:167 |
| get | `cacheKey` | Worker/research/facts-util.js:357 |
| put | `cacheKey` | Worker/research/facts-util.js:394 |
| get | ``${lakeKey}/shoreline.geojson`` | Worker/research/limnology.js:43 |
| get | `key` | Worker/research/limnology.js:415 |
| put | `key` | Worker/research/limnology.js:450 |
| get | ``${SHARED_ROOT}/pointers/current.json`` | Worker/research/shared.js:253 |
| get | `key` | Worker/research/shared.js:306 |
| put | `vKey` | Worker/research/shared.js:345 |
| put | `latestKey` | Worker/research/shared.js:347 |
| put | ``${SHARED_ROOT}/documents/${docId}/latest.json`` | Worker/research/shared.js:410 |
| list | `{ prefix: `${SHARED_ROOT}/documents/`` | Worker/research/shared.js:516 |
| get | `obj.key` | Worker/research/shared.js:530 |
| head | `vKey` | Worker/research/shared.js:550 |
| put | `obj.key` | Worker/research/shared.js:552 |
| put | ``${SHARED_ROOT}/generations/${genId}/manifest.json`` | Worker/research/shared.js:576 |
| get | ``${SHARED_ROOT}/pointers/current.json`` | Worker/research/shared.js:583 |
| put | ``${SHARED_ROOT}/pointers/previous.json`` | Worker/research/shared.js:586 |
| put | ``${SHARED_ROOT}/pointers/current.json`` | Worker/research/shared.js:588 |
| put | ``${SHARED_ROOT}/quarantine/${docId}.json`` | Worker/research/shared.js:644 |
| get | ``${SHARED_ROOT}/quarantine/${docId}.json`` | Worker/research/shared.js:654 |
| list | `{ prefix` | Worker/research/storage.js:14 |
| get | `masterKey` | Worker/research/storage.js:31 |
| list | `{prefix: `lake_packages/${safe}/`}` | Worker/research/storage.js:48 |
| list | `{prefix: `lakes/versions/${safe}/`}` | Worker/research/storage.js:57 |
| get | ``lakes/${safe}.json`` | Worker/research/storage.js:79 |
| list | `{prefix:`lakes/versions/${safe}/`}` | Worker/research/storage.js:88 |
| put | ``lakes/${safe}.json`` | Worker/research/storage.js:208 |
| put | ``lakes/versions/${safe}/v${nextVersion}.json`` | Worker/research/storage.js:213 |
| put | ``lake_packages/${safe}/${k}.json`` | Worker/research/storage.js:223 |
| put | ``lake_packages/${safe}/sources.json`` | Worker/research/storage.js:230 |
| put | ``lake_packages/${safe}/metadata.json`` | Worker/research/storage.js:231 |
| put | ``lake_packages/${safe}/evidence.json`` | Worker/research/storage.js:232 |
| put | ``lake_packages/${safe}/research_log.json`` | Worker/research/storage.js:233 |
| put | ``lake_packages/${safe}/notes.md`` | Worker/research/storage.js:235 |
| get | `masterKey` | Worker/research/storage.js:248 |
| put | `masterKey` | Worker/research/storage.js:260 |
| get | `key` | Worker/research/storage.js:275 |
| put | `key` | Worker/research/storage.js:288 |
| list | `{ prefix: `lake_packages/${safe}/` }` | Worker/research/storage.js:301 |
| list | `{ prefix: `lakes/versions/${safe}/` }` | Worker/research/storage.js:309 |
| delete | `key` | Worker/research/storage.js:319 |
| list | `{prefix: `lake_packages/${safe}/`}` | Worker/research/storage.js:333 |
| get | `key` | Worker/research/storage.js:346 |
| get | ``lakes/${safe}.json`` | Worker/research/storage.js:362 |
| get | ``lakes/${safeKey}.json`` | Worker/research/storage.js:365 |
| get | ``supplemental/${resolvedKey}/shoreline.geojson`` | Worker/research/vision.js:21 |
| get | ``boundaries/${resolvedKey}_3dhp.geojson`` | Worker/research/vision.js:26 |
| put | ``supplemental/${resolvedKey}/vision-scan-status.json`` | Worker/research/vision.js:69 |
| put | ``supplemental/${resolvedKey}/vision-structure.geojson`` | Worker/research/vision.js:187 |
| put | ``supplemental/${resolvedKey}/vision-scan-status.json`` | Worker/research/vision.js:188 |
| get | ``supplemental/${resolvedKey}/vision-scan-status.json`` | Worker/research/vision.js:202 |
| head | ``supplemental/${resolvedKey}/vision-structure.geojson`` | Worker/research/vision.js:206 |
| get | `key` | Worker/trollmap-worker.js:656 |
| put | `key` | Worker/trollmap-worker.js:671 |
| get | `key` | Worker/trollmap-worker.js:1733 |
| list | `{ prefix }` | Worker/trollmap-worker.js:1754 |
| get | `key` | Worker/trollmap-worker.js:1783 |
| put | `key` | Worker/trollmap-worker.js:1819 |
| get | `chartpackKey(slug` | Worker/water.js:76 |
| get | `chartpackKey(slug` | Worker/water.js:87 |
| list | `{ cursor` | Worker/worker-core.js:342 |

## Data files — who reads them

| file | read by |
|---|---|
| `../registry/lake_index.json` | test/keys_smoke.mjs:21<br>test/registry_smoke.mjs:21 |
| `curated lakes: %d from registry/curated_lakes.json` | Scripts/consolidate_lake_index.py:306 |
| `data/tristate-bank-pier.json` | test/fixtures.test.js:51 |
| `data/tristate-hotspots.json` | test/fixtures.test.js:53 |
| `data/tristate-paddle.json` | test/fixtures.test.js:52 |
| `registry/lakes.json` | Scripts/make_coastal_boundaries.py:17 |
| `registry/osm_ramps_by_lake.json` | Scripts/make_osm_ramps_by_lake.py:12 |

## JS modules

| module | lines | exports | imported by | dead exports | purpose |
|---|---|---|---|---|---|
| `Scripts/make_counties.mjs` | 49 | 0 | 0 | 0 | make_counties.mjs -- flatten us-atlas counties-10m TopoJSON into a GeoJSON the Python |
| `Worker/conditions.js` | 313 | 2 | 1 | **1** | Worker/conditions.js — one call that answers "what is this water doing right now". |
| `Worker/core/arcgis.js` | 401 | 7 | 2 | **2** | Worker/core/arcgis.js — shared ArcGIS helper for ramps/paddle/bank-pier/attractors |
| `Worker/research/agents.js` | 1309 | 10 | 4 | **5** | research/agents.js — split from worker-research.js (behavior-preserving) |
| `Worker/research/clients.js` | 888 | 38 | 10 | 0 | research/clients.js — split from worker-research.js (behavior-preserving) |
| `Worker/research/coastal-agents.js` | 264 | 5 | 3 | 0 | coastal-agents.js — saltwater-specific research agents. |
| `Worker/research/dataset.js` | 430 | 8 | 3 | **4** | research/dataset.js — split from worker-research.js (behavior-preserving) |
| `Worker/research/deterministic.js` | 178 | 3 | 2 | 0 | research/deterministic.js — split from worker-research.js (behavior-preserving) |
| `Worker/research/discover.js` | 957 | 2 | 3 | 0 | research/discover.js — split from worker-research.js (behavior-preserving) |
| `Worker/research/download.js` | 606 | 2 | 1 | 0 | research/download.js — split from worker-research.js (behavior-preserving) |
| `Worker/research/extract.js` | 829 | 6 | 1 | 0 | research/extract.js — split from worker-research.js (behavior-preserving) |
| `Worker/research/facts-util.js` | 682 | 22 | 1 | **17** | research/facts-util.js — split from worker-research.js (behavior-preserving) |
| `Worker/research/keys.js` | 94 | 8 | 8 | 0 | research/keys.js — split from worker-research.js (behavior-preserving) |
| `Worker/research/limnology.js` | 463 | 4 | 5 | 0 | research/limnology.js — split from worker-research.js (behavior-preserving) |
| `Worker/research/shared.js` | 697 | 29 | 2 | **16** | research/shared.js — split from worker-research.js (behavior-preserving) |
| `Worker/research/storage.js` | 576 | 11 | 2 | 0 | research/storage.js — split from worker-research.js (behavior-preserving) |
| `Worker/research/vision.js` | 222 | 3 | 0 | **3** | research/vision.js — split from worker-research.js (behavior-preserving) |
| `Worker/trollmap-worker.js` | 1886 | 1 | 0 | 0 | r2Text is used by /chartpacks/lake-boundary (line ~1711). It was added to worker-core.js |
| `Worker/water.js` | 739 | 2 | 1 | **1** | Worker/water.js — the compute plane over the static pack layers. |
| `Worker/worker-core.js` | 433 | 10 | 20 | 0 | worker-core.js — Shared infrastructure: CORS headers, LLM provider chain, fetchText |
| `Worker/worker-data.js` | 1534 | 20 | 4 | 0 | worker-data.js — Static lake/river data extracted from trollmap-worker.js |
| `Worker/worker-research.js` | 14 | 37 | 1 | 0 | worker-research.js — public API barrel (impl in Worker/research/*) |
| `Worker/worker-species.js` | 230 | 10 | 1 | 0 | worker-species.js — Species lists and ecological validation |
| `js/core/layer-registry.js` | 300 | 18 | 9 | **6** | core/layer-registry.js — one owner for every toggleable map layer. |
| `js/core/map-init.js` | 453 | 17 | 17 | **4** | Leaflet map initialization + base-layer switching + waypoint/track |
| `js/core/state.js` | 63 | 2 | 48 | 0 | Shared mutable application state. |
| `js/core/tabs.js` | 70 | 1 | 1 | 0 | Bottom-nav tab switcher. |
| `js/data/access-index.js` | 677 | 9 | 5 | 0 | access-index.js — Shared worker-backed access-point index. |
| `js/data/coastal-regulations.js` | 261 | 6 | 3 | 0 | coastal-regulations.js — saltwater size/creel/season rules for SC, GA, NC. |
| `js/data/coastal-zones.js` | 427 | 6 | 21 | 0 | coastal-zones.js — SC / GA / NC coastal + tidal zone catalog. |
| `js/data/dump_js_lists.mjs` | 38 | 0 | 0 | 0 | Dump the hardcoded JS lake lists to JSON so the Python side never has to parse JS. |
| `js/data/fishing-style-profile.js` | 135 | 5 | 6 | **3** | fishing-style-profile.js — Ryan's actual gear, platform, and technique |
| `js/data/lake-keys.js` | 399 | 4 | 18 | **1** | Shared lake display-name → R2 key map. |
| `js/data/lake-registry.js` | 399 | 13 | 8 | 0 | lake-registry.js — the 3DHP lake registry, with every access source joined on. |
| `js/data/lure-knowledge.js` | 982 | 15 | 7 | **4** | lure-knowledge.js — Lure behavior profiles and scoring engine. |
| `js/data/ramps-loader.js` | 209 | 2 | 4 | 0 | ramps.js — Tri-state (SC/NC/GA) boat ramp database. |
| `js/data/scdnr-state-lakes.js` | 46 | 1 | 2 | 0 | scdnr-state-lakes.js — SCDNR State Lakes Program. |
| `js/data/species-intel.js` | 599 | 9 | 2 | **4** | species-intel.js — TrollMap Unified Species behavior + regulations knowledge base. |
| `js/data/species-strategies.js` | 549 | 11 | 2 | **6** | species-strategies.js — Fishing behavior and tactical strategies per species. |
| `js/data/spread-defaults.js` | 59 | 1 | 1 | 0 | Default six-rod trolling spread, initialized on app load. |
| `js/data/tackle-inventory.js` | 381 | 6 | 6 | **1** | tackle-inventory.js — Ryan's personal lure inventory. |
| `js/data/user-known-lakes.js` | 47 | 1 | 2 | 0 | user-known-lakes.js — Angler-flagged SC lakes not covered elsewhere. |
| `js/data/water-aliases.js` | 263 | 4 | 5 | 0 | water-aliases.js — DNR waterbody name → chartpack key. |
| `js/lazy-data.js` | 61 | 0 | 0 | 0 | lazy-data.js — on-demand loader for optional GIS data files. |
| `js/main.js` | 213 | 0 | 0 | 0 | TrollMap GPX Studio v10 — modular entry point. |
| `js/modules/auto-crop.js` | 37 | 0 | 1 | 0 | Auto-Crop — strips the phone status bar and Navionics zoom controls |
| `js/modules/ble-motor.js` | 204 | 0 | 1 | 0 | BLE Motor — XZNY / JBD / Xiaoxiang-style BMS pairing via Web Bluetooth API. |
| `js/modules/capture-panel.js` | 432 | 1 | 1 | **1** | capture-panel.js — Contour capture workflow panel. |
| `js/modules/casting-rings.js` | 47 | 0 | 1 | 0 | Casting Rings — draws a 60ft dashed cyan circle around every |
| `js/modules/catch-journal.js` | 1387 | 2 | 3 | 0 | catch-journal.js — TrollMap Catch Center |
| `js/modules/catch-photo.js` | 34 | 0 | 1 | 0 | Catch Verification Photo Lightbox — full-screen viewer for a |
| `js/modules/catch-plot.js` | 72 | 0 | 1 | 0 | Plot Catches on Map — toggle catch markers on the map. Markers |
| `js/modules/chart-import.js` | 435 | 2 | 2 | **1** | Contour / GIS layer import — load a KML, GPX, or GeoJSON file |
| `js/modules/chart-mosaic.js` | 435 | 5 | 3 | **2** | Chart mosaic — saved depth-contour overlay layers. |
| `js/modules/chart-overlay.js` | 492 | 1 | 1 | **1** | Chart overlay — the SINGLE working image being georeferenced. |
| `js/modules/cloud-sync.js` | 389 | 4 | 3 | 0 | Cloud Sync — auto-push on save, auto-pull on load. |
| `js/modules/coastal-layers.js` | 345 | 5 | 1 | **5** | coastal-layers.js — oyster beds, marsh edges and depth soundings. |
| `js/modules/coastal-scoring.js` | 289 | 15 | 3 | **1** | coastal-scoring.js — tide- and structure-aware spot scoring for inshore |
| `js/modules/contour-data.js` | 585 | 10 | 7 | **4** | contour-data.js — Contour dataset lazy loader + lake selector integration. |
| `js/modules/custom-vectors.js` | 615 | 0 | 1 | 0 | custom-vectors.js — Structure Intel Layer |
| `js/modules/duke-energy.js` | 180 | 2 | 3 | **1** | Duke Energy scraper — proxies the live Duke Energy lake-level |
| `js/modules/edit.js` | 253 | 1 | 2 | 0 | Edit tab — table-based view of waypoints + tracks with inline |
| `js/modules/file-io.js` | 86 | 0 | 1 | 0 | Top-bar File I/O — Load / New / Save GPX. |
| `js/modules/fishing-index.js` | 309 | 0 | 1 | 0 | fishing-index.js — Fisherman-friendly overlay on top of SCDNR data |
| `js/modules/garmin-export.js` | 89 | 1 | 1 | **1** | Garmin-formatted GPX export. |
| `js/modules/garmin-parser.js` | 119 | 0 | 1 | 0 | Garmin Catch Parser — import a GPX file from a Garmin chartplotter |
| `js/modules/gear-autopilot.js` | 45 | 0 | 1 | 0 |  |
| `js/modules/gis-toggles.js` | 271 | 0 | 1 | 0 |  |
| `js/modules/gps.js` | 106 | 3 | 1 | **3** | GPS tracking — current location marker, follow mode, and recorded |
| `js/modules/groq-coach.js` | 694 | 2 | 2 | **1** | groq-coach.js — TrollMap Fishing Coach (Chat Mode) |
| `js/modules/lake-intel.js` | 324 | 2 | 2 | 0 | Lake Intelligence + Clarity Forecast — pulls fisherman-focused |
| `js/modules/lake-ramp-select.js` | 406 | 0 | 1 | 0 | Worker-backed Lake / Access dropdowns in the map toolbar. |
| `js/modules/lake-research-engine.js` | 3004 | 23 | 3 | 0 | lake-research-engine.js — Pipeline logic, geo helpers, fact building |
| `js/modules/lake-research-ui.js` | 1851 | 4 | 1 | 0 |  |
| `js/modules/lake-research.js` | 4 | 6 | 1 | **6** | lake-research.js — barrel re-export |
| `js/modules/layers-panel.js` | 102 | 4 | 1 | **2** | layers-panel.js — the one place every map overlay is turned on and off. |
| `js/modules/measure-tool.js` | 106 | 0 | 1 | 0 | Distance & Bearing Measurement Tool — click two points on the |
| `js/modules/noaa-tides.js` | 228 | 1 | 1 | **1** | NOAA Coastal Tides — Plan-tab tide panel. |
| `js/modules/notifications.js` | 376 | 6 | 1 | **6** | notifications.js — On-water alerts for TrollMap |
| `js/modules/osm-structure.js` | 145 | 0 | 1 | 0 | osm-structure.js — OSM Structure Layer Toggle |
| `js/modules/pinch-point-finder.js` | 337 | 0 | 1 | 0 | Pinch Point Finder — analyzes vectorized depth contours to locate |
| `js/modules/plan-builder.js` | 2017 | 7 | 6 | 0 | Plan Builder — the Plan tab form, save/load, preview rendering, |
| `js/modules/plan-tab-wiring.js` | 64 | 0 | 1 | 0 | plan-tab-wiring.js |
| `js/modules/qdc-decoder.js` | 356 | 3 | 1 | 0 | qdc-decoder.js — pure functions: raw .qdc folder → grid → contour GeoJSON. |
| `js/modules/quickdraw-key.js` | 50 | 0 | 1 | 0 | Garmin Quickdraw 8-Band Depth Key — a floating legend showing |
| `js/modules/ramps.js` | 140 | 3 | 1 | **3** | Boat-ramp layer (concrete ramps across SC/NC/GA/TN, live from state DNR feeds). |
| `js/modules/route-builder.js` | 2340 | 5 | 2 | **4** | route-builder.js — Unified route generation panel. |
| `js/modules/route-debug.js` | 152 | 0 | 1 | 0 | route-debug.js |
| `js/modules/routes-panel.js` | 213 | 0 | 1 | 0 | routes-panel.js — Right slide-in panel shell with 3 tabs: |
| `js/modules/safety-checklist.js` | 114 | 0 | 1 | 0 | Autonomous Safety Checklist — auto-compiles a tactical safety |
| `js/modules/saved-spreads.js` | 82 | 1 | 2 | 0 | Saved rod spreads — name a rod configuration and persist it |
| `js/modules/smart-plan-context.js` | 520 | 2 | 1 | 0 | smart-plan-context.js — Context builder for Smart Plan. |
| `js/modules/smart-plan-ui.js` | 798 | 5 | 1 | **2** | smart-plan-ui.js — Unified Trip Timeline (Trolling + Stop-and-Cast interleaved) |
| `js/modules/smart-plan.js` | 1696 | 6 | 1 | **6** | smart-plan.js — TrollMap Smart Plan Orchestrator |
| `js/modules/species-selector.js` | 169 | 1 | 1 | **1** | species-selector.js — swap the Plan tab's target-species checkboxes between |
| `js/modules/spot-repositioning.js` | 33 | 0 | 1 | 0 | Spot Repositioning — drag a marker (GIS spot, ramp, attractor) |
| `js/modules/spread-builder.js` | 371 | 13 | 8 | **10** | Rod Spread Builder — the table UI in the Plan tab where each rod |
| `js/modules/supplemental-layers.js` | 1446 | 11 | 3 | **8** | supplemental-layers.js — Supplemental PBF-extracted layer integration. |
| `js/modules/sw-register.js` | 13 | 0 | 1 | 0 | Service Worker registration — registers ./sw.js once the page |
| `js/modules/tackle-inventory-ui.js` | 170 | 2 | 3 | 0 | tackle-inventory-ui.js — Collapsible tackle inventory panel in the Plan tab. |
| `js/modules/tide-engine.js` | 336 | 14 | 9 | 0 | tide-engine.js — NOAA CO-OPS tide data as a reusable module. |
| `js/modules/topbar.js` | 163 | 0 | 1 | 0 | Topbar dropdown controls — basemap selector, edit-mode dropdown, |
| `js/modules/track-reverse.js` | 60 | 0 | 1 | 0 | Track Reversal Studio — append a reversed copy of the first |
| `js/modules/usgs-gauges.js` | 170 | 6 | 2 | **3** | usgs-gauges.js — river discharge as a salinity proxy for coastal zones. |
| `js/modules/utility-sync.js` | 267 | 1 | 2 | 0 | Live Utility & USGS sync — pulls real-time lake pool elevation |
| `js/modules/water-search.js` | 201 | 4 | 2 | 0 | water-search.js — search everything TrollMap knows, not everything OpenStreetMap knows. |
| `js/modules/waypoint-to-generator.js` | 33 | 0 | 1 | 0 | One-Click Waypoint → Lane Connect — clicking a waypoint popup |
| `js/modules/wet-hands-remote.js` | 101 | 0 | 1 | 0 | Wet Hands Remote — keyboard + gamepad navigation shortcuts so |
| `js/utils/call-global.js` | 70 | 2 | 9 | 0 | callGlobal — invoke a function that another module hung on `window`, without letting it |
| `js/utils/coastal-optgroups.js` | 46 | 1 | 4 | 0 | coastal-optgroups.js — append the SC / GA / NC coastal zone <optgroup>s to a <select>. |
| `js/utils/coerce.js` | 109 | 4 | 4 | 0 | Coercion helpers for biology arrays that may be malformed in stored profiles. |
| `js/utils/db.js` | 339 | 14 | 18 | 0 | IndexedDB layer for TrollMap persistence. |
| `js/utils/dedupe.js` | 52 | 1 | 2 | 0 | Spatial + text deduplication for boat-ramp launches. |
| `js/utils/depth-palette.js` | 90 | 3 | 4 | 0 | depth-palette.js — ONE depth ladder for every layer that colours by depth. |
| `js/utils/escape.js` | 17 | 1 | 27 | 0 | HTML-escape a string for safe interpolation into innerHTML. |
| `js/utils/geo.js` | 398 | 17 | 12 | **8** | Pure geographic / coordinate math helpers. |
| `js/utils/geojson-coords.js` | 104 | 3 | 4 | 0 | Walking GeoJSON coordinates, and the bounding box that falls out of it. |
| `js/utils/parsers.js` | 228 | 5 | 3 | 0 | Format parsers — GPX, KML, GeoJSON. |
| `js/utils/rod-row.js` | 39 | 1 | 5 | 0 | Build a single rod-spread row with sensible defaults. |
| `js/utils/solunar.js` | 145 | 2 | 3 | 0 | utils/solunar.js — moon-driven feeding windows. ONE implementation. |
| `js/utils/worker-auth.js` | 63 | 3 | 5 | 0 | utils/worker-auth.js — the shared secret for TrollMap's own Worker, in one place. |
| `sw.js` | 71 | 0 | 0 | 0 | TrollMap service worker — v17 (evidence pipeline fixes, 2026-07-12) |
| `test/arcgis-filter-guard.test.js` | 203 | 0 | 0 | 0 |  |
| `test/arcgis-mapping.test.js` | 86 | 0 | 0 | 0 |  |
| `test/check-imports.mjs` | 123 | 0 | 0 | 0 | check-imports.mjs — every named import across js/ must resolve to a real export. |
| `test/check-lake-geo.mjs` | 126 | 0 | 0 | 0 | check-lake-geo.mjs — a curated name must map to a lake in the right PLACE. |
| `test/check-lake-keys-parity.mjs` | 57 | 0 | 0 | 0 | !/usr/bin/env node |
| `test/check-tackle-parity.mjs` | 244 | 0 | 0 | 0 | check-tackle-parity.mjs — runner-free tackle parity check. |
| `test/cloud-sync.test.js` | 131 | 0 | 0 | 0 | test/cloud-sync.test.js -- a deleted plan must actually tombstone in the cloud. |
| `test/coastal-agents.test.js` | 213 | 0 | 0 | 0 |  |
| `test/coastal-dropdown.test.js` | 181 | 0 | 0 | 0 |  |
| `test/coastal-layers.test.js` | 78 | 0 | 0 | 0 |  |
| `test/coastal-ramps-dynamic.test.js` | 26 | 0 | 0 | 0 |  |
| `test/coastal-regulations.test.js` | 255 | 0 | 0 | 0 |  |
| `test/coastal-scoring.test.js` | 282 | 0 | 0 | 0 |  |
| `test/coastal-zones-parity.test.js` | 164 | 0 | 0 | 0 |  |
| `test/coerce.test.js` | 81 | 0 | 0 | 0 |  |
| `test/confidence.test.js` | 157 | 0 | 0 | 0 |  |
| `test/db-writes.test.js` | 232 | 0 | 0 | 0 | test/db-writes.test.js — a write either happened or it did not, and the caller must be abl |
| `test/depth-palette.test.js` | 140 | 0 | 0 | 0 |  |
| `test/deterministic-regression.test.js` | 17 | 0 | 0 | 0 |  |
| `test/discover-authority.test.js` | 106 | 0 | 0 | 0 | authorityForUrl -- the domain-trust ladder shared by the Grok and Wikipedia citation paths |
| `test/dnr-registry-merge.test.js` | 208 | 0 | 0 | 0 |  |
| `test/expect-shim.mjs` | 221 | 8 | 42 | 0 | test/expect-shim.mjs -- `describe`/`it`/`expect` on top of node:test and node:assert. |
| `test/fake-indexeddb.mjs` | 186 | 2 | 4 | 0 | test/fake-indexeddb.mjs — a small in-memory IndexedDB, enough for utils/db.js. |
| `test/fixtures.test.js` | 107 | 0 | 0 | 0 |  |
| `test/geojson-coords.test.js` | 136 | 0 | 0 | 0 | test/geojson-coords.test.js — the bounding box, and the 3D case the old heuristic got wron |
| `test/keys_smoke.mjs` | 97 | 0 | 0 | 0 | keys_smoke.mjs -- prove every shipped lake's display name resolves to its own R2 key. |
| `test/lake-keys-parity.test.js` | 93 | 0 | 0 | 0 |  |
| `test/lake-keys.test.js` | 131 | 0 | 0 | 0 |  |
| `test/lake-name.test.js` | 76 | 0 | 0 | 0 |  |
| `test/lake-registry.test.js` | 189 | 0 | 0 | 0 | test/lake-registry.test.js -- the registry resolves lake names to the right lake. |
| `test/layer-registry.test.js` | 331 | 0 | 0 | 0 | test/layer-registry.test.js — one owner for layer visibility, and it stays one. |
| `test/layers-panel.test.js` | 148 | 0 | 0 | 0 | test/layers-panel.test.js — the bar stays slim and no toggle goes missing. |
| `test/persistence.test.js` | 142 | 0 | 0 | 0 | test/persistence.test.js — one persistence path, and a readiness check that can actually f |
| `test/r2-gzip.test.js` | 149 | 0 | 0 | 0 | r2-gzip.test.js — the Worker must unwrap what the pipeline compresses. |
| `test/registry_smoke.mjs` | 163 | 0 | 0 | 0 | registry_smoke.mjs -- run the REAL lake_index.json through the REAL lake-registry.js and |
| `test/regulations-matching.test.js` | 27 | 0 | 0 | 0 |  |
| `test/regulations-wiring.test.js` | 470 | 0 | 0 | 0 | regulations-wiring.test.js — the regulation digest actually reaches the agents |
| `test/research-discover-policy.test.js` | 88 | 0 | 0 | 0 |  |
| `test/research-keys.test.js` | 108 | 0 | 0 | 0 |  |
| `test/shared-latest-pointer.test.js` | 214 | 0 | 0 | 0 | shared-latest-pointer.test.js — latest.json stopped being a second copy of the document. |
| `test/smart-plan-coastal.test.js` | 116 | 0 | 0 | 0 |  |
| `test/solunar.test.js` | 124 | 0 | 0 | 0 | test/solunar.test.js — one solunar model, and the two consumers cannot drift apart again. |
| `test/summary-agent.test.js` | 104 | 0 | 0 | 0 |  |
| `test/supplemental-layer-registry.test.js` | 91 | 0 | 0 | 0 | test/supplemental-layer-registry.test.js — the last two hand-rolled layers stay migrated. |
| `test/sync_smoke.mjs` | 121 | 0 | 0 | 0 | sync_smoke.mjs -- prove a deleted plan actually tombstones in the cloud. |
| `test/tackle-parity.test.js` | 242 | 0 | 0 | 0 |  |
| `test/tide-engine.test.js` | 182 | 0 | 0 | 0 |  |
| `test/usgs-gauges.test.js` | 108 | 0 | 0 | 0 |  |
| `test/water-aliases.test.js` | 124 | 0 | 0 | 0 |  |
| `test/water-search.test.js` | 63 | 0 | 0 | 0 |  |
| `test/worker-auth.test.js` | 200 | 0 | 0 | 0 | test/worker-auth.test.js — writes to the Worker are gated, and the client can get through. |
| `test/worker-data.test.js` | 60 | 0 | 0 | 0 |  |
| `test/worker-external-imports.test.js` | 109 | 0 | 0 | 0 | test/worker-external-imports.test.js — the Worker bundle's reach outside Worker/. |
| `tools/audit.mjs` | 489 | 0 | 0 | 0 | tools/audit.mjs — generate the map of this codebase, from the codebase. |
| `tools/audit_duplication.mjs` | 159 | 0 | 0 | 0 | !/usr/bin/env node |
| `tools/audit_silent_catches.mjs` | 240 | 0 | 0 | 0 | !/usr/bin/env node |

### Modules nothing imports

- `Scripts/make_counties.mjs` — 49 lines, 0 exports
- `Worker/research/vision.js` — 222 lines, 3 exports
- `js/data/dump_js_lists.mjs` — 38 lines, 0 exports
- `sw.js` — 71 lines, 0 exports

### Exported but never imported by name

- `Worker/conditions.js`: CONDITIONS_ROUTES
- `Worker/core/arcgis.js`: fetchArcGisAllFeatures, getCachedGis
- `Worker/research/agents.js`: COASTAL_AGENTS, COASTAL_AGENT_HINTS, COASTAL_SKIPPED_AGENTS, isCoastalZone, coastalAgentPlan
- `Worker/research/dataset.js`: DATASET_HUNT_TARGETS, DATASET_KEYWORDS, scoreDatasetUrl, buildNepisQueryVariants
- `Worker/research/facts-util.js`: normalizeResearchName, hasResearchValue, titleCaseWords, RESEARCH_SPECIES_CANON, canonicalizeResearchSpecies, NON_GAME_SPECIES, splitSpeciesText, parseSCDNRDescriptionFacts, RESEARCH_RAMP_SOURCES, RESEARCH_ATTRACTOR_SOURCES, fetchArcGISGrouped, waterbodyMatchesLake, stripHtmlPreserveTables, extractHtmlTableRows, extractMarkdownTableRows, slicePdfPageRange, parseSCRegulationsFromHtml
- `Worker/research/shared.js`: SHARED_ENABLED_DEFAULT, sharedEnabled, contentFingerprint, urlToDocId, SECTION_HEADING_PREFIXES, CHUNK_SIZE, CHUNK_OVERLAP, segmentDocument, chunkText, LAKE_CATALOG, tagSectionsWithLakes, CATEGORY_KEYWORDS, tagSectionsWithCategories, getSharedPointer, getSharedRegistryEntry, isQuarantined
- `Worker/research/vision.js`: handleResearchVisionScan, handleResearchVisionScanSave, handleResearchVisionScanStatus
- `Worker/water.js`: WATER_ROUTES
- `js/core/layer-registry.js`: setMapAccessor, hasLayer, layerIds, isEnabled, invalidate, _reset
- `js/core/map-init.js`: onMapClick, fillCoord, suggestName, startPick
- `js/data/fishing-style-profile.js`: isLiveBaitTechnique, isSaltwaterBait, canHoldStation
- `js/data/lake-keys.js`: LAKE_NAMES_WITHOUT_PACK
- `js/data/lure-knowledge.js`: getJigheadForDepth, getSpeedRange, getSeason, JIGHEADS_OWNED_OZ
- `js/data/species-intel.js`: REGULATIONS, TOD, getTimeOfDay, getBehaviorV1Compat
- `js/data/species-strategies.js`: SPECIES_STRATEGIES, getStrategy, getPreferredStructure, getStrategyNotes, getTimePhase, buildLureContext
- `js/data/tackle-inventory.js`: getRecommendedSpeed
- `js/modules/capture-panel.js`: buildCapturePanel
- `js/modules/chart-import.js`: addContourLayer
- `js/modules/chart-mosaic.js`: addAffineChartLayer, chartsApi
- `js/modules/chart-overlay.js`: refreshChartOverlayTransforms
- `js/modules/coastal-layers.js`: refreshSoundingLabels, loadCoastalLayersForZone, clearCoastalLayers, getSoundingsNear, getCoastalLayerState
- `js/modules/coastal-scoring.js`: COASTAL_SPECIES
- `js/modules/contour-data.js`: loadContourByR2Key, clearContourLabels, renderContourLayer, LAKE_NAME_TO_R2_KEY
- `js/modules/duke-energy.js`: parseDukeText
- `js/modules/garmin-export.js`: exportGarminGPX
- `js/modules/gps.js`: startGPS, stopGPS, wireGpsButtons
- `js/modules/groq-coach.js`: stopCoachSession
- `js/modules/lake-research.js`: initLakeResearch, loadProfile, saveCurrentResearchProfile, populateResearchLakeDropdown, runFullPipeline, runResume
- `js/modules/layers-panel.js`: isOpen, close
- `js/modules/noaa-tides.js`: stageLabel
- `js/modules/notifications.js`: requestNotificationPermission, checkWindAlert, loadSessionFromSmartPlan, enableNotifications, disableNotifications, isEnabled
- `js/modules/ramps.js`: toggleRampLayer, buildRampLayer, toggleChartLayersPanel
- `js/modules/route-builder.js`: clearDepthEdgeCache, setClipPolygon, setClipFromRamp, generateAndCommitRoute
- `js/modules/smart-plan-ui.js`: buildUnifiedTimeline, assignRouteRods
- `js/modules/smart-plan.js`: capPassSpeed, applyStoredSmartPlanDepth, detectCoastalZone, buildCoastalContext, buildCoastalPromptBlock, runSmartPlan
- `js/modules/species-selector.js`: refreshSpeciesChecks
- `js/modules/spread-builder.js`: ROD_PRESETS, REEL_PRESETS, COLOR_PRESETS, ARIG_WEIGHTS, JIGHEAD_WEIGHTS, TRAILER_SIZES, jigheadForRod, depthWindow, leadForDepth, isLeadControlled
- `js/modules/supplemental-layers.js`: getLakeBoundaryGeoJSON, bringDepthAreasToBack, loadSupplementalForLake, getSupplementalContext, refreshDepthAreaColors, getOsmStructures, LAKE_NAME_TO_R2_KEY, resolveR2Key
- `js/modules/usgs-gauges.js`: fetchCurrentDischarge, fetchMeanDischarge, assessSite
- `js/utils/geo.js`: distMiFromCoords, bearing, bearingFromCoords, destination, distToRingFt, ftToDegLat, ftToDegLon, parseCoord

## Same function name in more than one file

- `wireButtons()` — js/modules/catch-journal.js:1378, js/modules/chart-mosaic.js:390, js/modules/chart-overlay.js:387, js/modules/edit.js:236, js/modules/file-io.js:51, js/modules/ramps.js:126, js/modules/saved-spreads.js:73, js/modules/spread-builder.js:335, js/modules/topbar.js:9
- `init()` — js/modules/coastal-layers.js:300, js/modules/gis-toggles.js:245, js/modules/layers-panel.js:70, js/modules/pinch-point-finder.js:314, js/modules/routes-panel.js:126, js/modules/species-selector.js:151, js/modules/supplemental-layers.js:1406
- `walk()` — test/check-imports.mjs:48, test/persistence.test.js:27, test/worker-auth.test.js:29, test/worker-external-imports.test.js:43, tools/audit.mjs:56, tools/audit_duplication.mjs:73, tools/audit_silent_catches.mjs:189
- `cacheGet()` — Worker/water.js:47, js/modules/tide-engine.js:27, js/modules/usgs-gauges.js:28, js/utils/db.js:273
- `cacheSet()` — Worker/water.js:55, js/modules/tide-engine.js:37, js/modules/usgs-gauges.js:35, js/utils/db.js:288
- `getMap()` — js/modules/coastal-layers.js:36, js/modules/gis-toggles.js:16, js/modules/osm-structure.js:40, js/modules/supplemental-layers.js:159
- `mapReady()` — js/modules/coastal-layers.js:38, js/modules/gis-toggles.js:20, js/modules/osm-structure.js:42, js/modules/supplemental-layers.js:161
- `say()` — js/modules/lake-intel.js:19, js/modules/lake-intel.js:252, js/modules/noaa-tides.js:77, js/modules/utility-sync.js:62
- `setStatus()` — js/modules/cloud-sync.js:42, js/modules/route-builder.js:2071, js/modules/smart-plan.js:712
- `getJson()` — Worker/conditions.js:62, js/modules/usgs-gauges.js:84
- `isEnabled()` — js/core/layer-registry.js:97, js/modules/notifications.js:288
- `toggle()` — js/core/layer-registry.js:167, js/modules/layers-panel.js:68
- `getWorkerBase()` — js/data/access-index.js:74, js/modules/gis-toggles.js:51
- `formatAccessLabel()` — js/data/access-index.js:320, js/modules/lake-ramp-select.js:141
- `getSeason()` — js/data/lure-knowledge.js:740, js/data/species-intel.js:63
- `openDB()` — js/data/tackle-inventory.js:249, js/utils/db.js:28
- `normalizeRows()` — js/lazy-data.js:1, js/modules/gis-toggles.js:47
- `wire()` — js/modules/lake-ramp-select.js:384, js/modules/noaa-tides.js:64
- `setAtPath()` — js/modules/lake-research-engine.js:979, js/modules/lake-research-ui.js:63
- `esc()` — js/modules/lake-research-ui.js:256, js/utils/escape.js:1
- `put()` — js/modules/plan-builder.js:1766, js/utils/db.js:113
- `destination()` — js/modules/route-builder.js:44, js/utils/geo.js:124
- `angleDiff()` — js/modules/route-builder.js:376, js/modules/smart-plan.js:342
- `hStr()` — js/modules/smart-plan.js:278, js/modules/smart-plan.js:834
- `distToRingFt()` — js/modules/smart-plan.js:409, js/utils/geo.js:149
- `norm()` — js/modules/supplemental-layers.js:732, js/modules/water-search.js:42
- `depthColor()` — js/utils/depth-palette.js:50, js/utils/geo.js:276

## Cross-module state on `window`

| global | written by | read by |
|---|---|---|
| `window.ACTIVE_BLE_BMS` | js/modules/ble-motor.js | **nothing** |
| `window.CUSTOM_VECTOR_LAYERS` | js/modules/custom-vectors.js | **nothing** |
| `window.LAKE_BOUNDARY_GEOJSON` | js/modules/supplemental-layers.js | **nothing** |
| `window.LAST_CLARITY_INTEL` | js/modules/lake-intel.js | **nothing** |
| `window.LAST_LAKE_INTEL` | js/modules/lake-intel.js | **nothing** |
| `window.LAST_PLAN_RIVER_DATA` | js/modules/plan-builder.js | **nothing** |
| `window.MAP` | js/core/map-init.js | **nothing** |
| `window.PLAN_RIVERS` | js/modules/plan-builder.js | **nothing** |
| `window.SUPPLEMENTAL_DEPTH_GEOJSON` | js/modules/supplemental-layers.js | **nothing** |
| `window.SUPPLEMENTAL_DEPTH_LAYER` | js/modules/supplemental-layers.js | **nothing** |
| `window.TM_CATCH_PHOTO_FILES` | js/modules/catch-journal.js | **nothing** |
| `window.TM_CATCH_PHOTO_URLS` | js/modules/catch-journal.js | **nothing** |
| `window.TROLLMAP_RESEARCHED_CACHE` | js/modules/lake-research-engine.js | **nothing** |
| `window.TrollMapData` | js/lazy-data.js | **nothing** |
| `window.TrollMapFishingIndex` | js/modules/fishing-index.js | **nothing** |
| `window.WET_HANDS_ACTIVE` | js/modules/wet-hands-remote.js | **nothing** |
| `window.__rampsLayerVisible` | js/modules/ramps.js | js/modules/supplemental-layers.js |
| `window._clipRadiusMi` | js/modules/route-builder.js | js/modules/route-builder.js |
| `window._coastalContext` | js/modules/smart-plan.js | **nothing** |
| `window._deleteStructure` | js/modules/custom-vectors.js | js/modules/custom-vectors.js |
| `window._downloadRouteDebug` | js/modules/route-debug.js | js/modules/route-debug.js |
| `window._groqPlanTimeline` | js/modules/smart-plan.js | js/modules/plan-builder.js |
| `window._lastRouteBuildAudit` | js/modules/route-builder.js | **nothing** |
| `window._osmActiveLakeKey` | js/modules/supplemental-layers.js | js/modules/osm-structure.js |
| `window._rbPickMode` | js/modules/route-builder.js | js/modules/route-builder.js |
| `window._rbRemoveWpt` | js/modules/route-builder.js | js/modules/route-builder.js |
| `window._rbSavedWptCache` | js/modules/route-builder.js | js/modules/route-builder.js |
| `window._removeVisionStructure` | js/modules/supplemental-layers.js | js/modules/supplemental-layers.js |
| `window._routeBuilderClipActive` | js/modules/route-builder.js | **nothing** |
| `window._routeDebug` | js/modules/route-debug.js | js/modules/route-builder.js<br>js/modules/route-debug.js |
| `window._routeDebugScores` | — | js/modules/route-debug.js |
| `window._routeDebug_sLat` | js/modules/route-builder.js | js/modules/route-builder.js |
| `window._seedOsmStructureData` | js/modules/supplemental-layers.js | **nothing** |
| `window._smartPlanCastRods` | js/modules/smart-plan.js | js/modules/plan-builder.js |
| `window._smartPlanCommittedTracks` | js/modules/smart-plan.js | **nothing** |
| `window._smartPlanFishingContext` | — | js/modules/groq-coach.js |
| `window._smartPlanPhaseRoutes` | js/modules/plan-builder.js<br>js/modules/smart-plan.js | js/modules/notifications.js<br>js/modules/plan-builder.js<br>js/modules/smart-plan.js |
| `window._smartPlanRationale` | js/modules/smart-plan.js | js/modules/plan-builder.js |
| `window._smartPlanRouteRods` | js/modules/smart-plan-ui.js<br>js/modules/smart-plan.js | js/modules/groq-coach.js<br>js/modules/plan-builder.js |
| `window._smartPlanRouteSpeeds` | js/modules/smart-plan-ui.js<br>js/modules/smart-plan.js | js/modules/plan-builder.js |
| `window._smartPlanSolunar` | test/solunar.test.js | **nothing** |
| `window._smartPlanStopCandidates` | js/modules/smart-plan-ui.js<br>js/modules/smart-plan.js | js/modules/plan-builder.js |
| `window._smartPlanTimeline` | js/modules/smart-plan-ui.js | js/modules/plan-builder.js<br>js/modules/smart-plan-ui.js |
| `window._smartRouteGeoJSON` | js/modules/contour-data.js | js/modules/pinch-point-finder.js |
| `window._spEditRod` | js/modules/smart-plan-ui.js | js/modules/smart-plan-ui.js |
| `window._trollmapPhases` | js/modules/smart-plan.js | js/modules/notifications.js |
| `window._trollmapSolunar` | js/modules/plan-builder.js | js/modules/notifications.js<br>test/solunar.test.js |
| `window._trollmapTide` | js/modules/noaa-tides.js<br>js/modules/supplemental-layers.js | js/modules/noaa-tides.js<br>js/modules/supplemental-layers.js |

## Pipeline scripts

| script | flags | purpose |
|---|---|---|
| `Scripts/area_audit.py` | — | !/usr/bin/env python3 |
| `Scripts/audit_packs.py` | --packs --registry --report --baseline --tolerance --strict --only --limit -v | audit_packs.py - is the pipeline making the packs better or worse? |
| `Scripts/audit_scripts.py` | --dir --manifest --sort --go --files | !/usr/bin/env python3 |
| `Scripts/build_all_chartpacks.py` | --extract --registry --map --out --report --buffer-m --states --min-charted --only-layers --limit --only-tiles --ship-list --require-depth-area --report-only --only-lakes --keep-zoom --max-segment-m | build_all_chartpacks.py - cut every registry lake out of the per-tile extract, in one pass. |
| `Scripts/build_chartpack.py` | --extract --key --bbox --boundary --buffer-m --ac --out --archive | !/usr/bin/env python3 |
| `Scripts/build_lake_drainage.py` | --registry --min-order --max-reaches --no-reaches --out --only --limit --min-acres -v | build_lake_drainage.py - derive each lake's catchment, and with it how fast it stains. |
| `Scripts/build_structure.py` | --packs --registry --report --only-lakes --limit --min-score | build_structure.py - humps, ledges and slope for every lake, from geometry alone. |
| `Scripts/build_trolling_runs.py` | --packs --min-len-m --simplify-m --reach-m --annotate-m --only --report | build_trolling_runs.py - turn stored contour fragments into runs a boat can actually troll. |
| `Scripts/build_water_bindings.py` | --registry --cache --out --report --stage --margin-km --force | build_water_bindings.py - bind every water in the registry to its gauges and operator. |
| `Scripts/build_water_features.py` | --packs --relief-m --curve-m --probe-m --min-bulge-m --sep-m --mouth-m --annotate-m --only --report | build_water_features.py - derive the structure types the fishing intel actually asks for. |
| `Scripts/build_water_graphs.py` | --tiles --registry --map --out --layer --seam-m --buffer-m --only-lakes --limit --report | build_water_graphs.py - a routing graph over navigable water, one per lake. |
| `Scripts/check_pipeline_parity.py` | — | check_pipeline_parity.py — the lists that must agree, checked before a build. |
| `Scripts/classify_salt_fresh.py` | --line --feeds --self-test --show | !/usr/bin/env python3 |
| `Scripts/coastal_catalog.py` | — | !/usr/bin/env python3 |
| `Scripts/consolidate_lake_index.py` | --registry --js-lists --charted --out --states --max-km --names --aliases --counties | !/usr/bin/env python3 |
| `Scripts/derived_bboxes.py` | — | Generated by trollmap_bbox_derivation.py |
| `Scripts/dump_lbl_pool.py` | --navaids-only --walk --limit | dump_lbl_pool.py - print a GMP tile's label pool as plain text. |
| `Scripts/extract_coastal_habitat.py` | --zone --zones --dry-run --no-gzip --skip-upload --list-layers | extract_coastal_habitat.py — Extract and clip coastal habitat data to TrollMap |
| `Scripts/fetch_dnr_paddle.py` | --state --out --stdout --compare | !/usr/bin/env python3 |
| `Scripts/fetch_osm_coastal.py` | --zone --dry-run --list | fetch_osm_coastal.py — Extracts fishing-relevant OSM structures for TrollMap |
| `Scripts/fetch_osm_structures.py` | --lake --dry-run --no-gzip --list --out-dir --catalog-only --from-cache --jobs --index --pbf --keep-tmp | !/usr/bin/env python3 |
| `Scripts/gen_coastal_zones_js.py` | — | !/usr/bin/env python3 |
| `Scripts/gen_water_aliases_js.py` | --dir --index --lake-keys --registry-boundaries --check | !/usr/bin/env python3 |
| `Scripts/gmapmf_areas_v51.py` | — | !/usr/bin/env python3 |
| `Scripts/gmapmf_decode_v40.py` | --out --level | !/usr/bin/env python3 |
| `Scripts/gmapmf_labels_v50.py` | — | !/usr/bin/env python3 |
| `Scripts/gmapmf_lines_v50.py` | — | !/usr/bin/env python3 |
| `Scripts/gmapmf_mar_v1.py` | — | GARMIN NGSR MAR reader — the auto-guidance safe-water mesh that ships |
| `Scripts/gmapmf_regions_v51.py` | — | !/usr/bin/env python3 |
| `Scripts/install_registry_boundary.py` | --registry --boundaries --labels --lake --state --name --go | !/usr/bin/env python3 |
| `Scripts/lake_catalog.py` | — | !/usr/bin/env python3 |
| `Scripts/make_coastal_boundaries.py` | --catalog --out --only --go | !/usr/bin/env python3 |
| `Scripts/make_key_map.py` | --lake-keys --slugs --out --max-km | make_key_map.py - decide which R2 key each registry lake writes to, BEFORE anything uploads. |
| `Scripts/make_osm_ramps_by_lake.py` | --registry --ramps --margin-m --go | !/usr/bin/env python3 |
| `Scripts/make_river_boundaries.py` | --gpkg --feeds --out --index --only --narrow-region --flowing-only --ramp-tol --join-tol --no-split --salt-line --catalog --coastal-slack-km --extract --garmin-cache --max-reach-km --pad-km --min-km2 --lakes --go | !/usr/bin/env python3 |
| `Scripts/mar_route.py` | — | mar_route.py - turn a MAR layer into a navigable-water routing graph and route on it. |
| `Scripts/osm_ramps.py` | --pbf --out | !/usr/bin/env python3 |
| `Scripts/poi_audit.py` | — | !/usr/bin/env python3 |
| `Scripts/poi_source_compare.py` | --garmin --iboating --out --radius-m --verbose | poi_source_compare.py - does Garmin already have i-Boating's POIs? |
| `Scripts/prune_r2_keys.py` | --key-map --packs --dry-run --go --force | !/usr/bin/env python3 |
| `Scripts/prune_r2_objects.py` | --list --go --stop-on-error | !/usr/bin/env python3 |
| `Scripts/r2_audit.py` | --worker --from --save --delete-list --registry | r2_audit.py — what is actually in the R2 bucket, and what of it can go. |
| `Scripts/r2_gzip.py` | — | !/usr/bin/env python3 |
| `Scripts/recompute_charted.py` | --packs --registry --report --buffer-m --no-prune | !/usr/bin/env python3 |
| `Scripts/restitch_water_graphs.py` | --packs --max-m --warn-m --report --dry-run | restitch_water_graphs.py - repair severed water graphs in place, without rebuilding them. |
| `Scripts/rgn4_grammar.py` | — | !/usr/bin/env python3 |
| `Scripts/rgn4_pois.py` | --out | rgn4_pois.py - the POI stage. Every labelled RGN4 point, correctly placed. |
| `Scripts/suggest_name_aliases.py` | --registry --max-edits --min-key --write | !/usr/bin/env python3 |
| `Scripts/tile_lake_map.py` | --labels --registry --out --states --index --accessible-only --tiles-out | !/usr/bin/env python3 |
| `Scripts/trim_pack_strays.py` | --chartpack --boundaries --buffer-m --lake --state-file --seconds --go | !/usr/bin/env python3 |
| `Scripts/trollmap_extract_all.py` | --out --layers --letters --jobs --limit --tiles --zoom0-only --min-area --force --gzip | !/usr/bin/env python3 |
| `Scripts/trollmap_lake_boundaries.py` | --lake --list --overwrite --dump-names | trollmap_lake_boundaries.py - Extract lake boundaries from USGS 3DHP GeoPackage |
| `Scripts/trollmap_nhd_boundaries.py` | --lake --overwrite --dump-names --list | !/usr/bin/env python3 |
| `Scripts/trollmap_pipeline.py` | --output --lake --zooms --max-cove-dist --min-features | trollmap_pipeline.py — Unified TrollMap Extraction Pipeline |
| `Scripts/trollmap_pipeline_coastal.py` | --output --zone --zooms --contours-only --max-cove-dist --min-features | !/usr/bin/env python3 |
| `Scripts/trollmap_r2_clean.py` | --all --contours --supplemental --boundaries --dry-run --list | trollmap_r2_clean.py — Wipe TrollMap R2 data using Cloudflare API. |
| `Scripts/upload_boundaries_to_r2.py` | --lake --dry-run --no-gzip | upload_boundaries_to_r2.py — Uploads 3DHP lake boundary GeoJSONs to R2 |
| `Scripts/upload_garmin_to_r2.py` | --root --layers --all --lake --prefix --jobs --gzip --no-gzip --dry-run --force --manifest --timeout --registry --with-pipeline-layers --coastal-primary --max-mb | upload_garmin_to_r2.py — push the Garmin-derived layers to R2, fast and resumably. |
| `Scripts/upload_to_r2.py` | --all --contours --supplemental --boundaries --lake --dry-run | upload_to_r2.py — Upload all TrollMap pipeline outputs to R2 in clean structure. |
| `Scripts/upload_to_r2_coastal.py` | --all --contours --supplemental --boundaries --lake --dry-run --no-gzip | !/usr/bin/env python3 |
| `Scripts/verify_river_boundaries.py` | --dir --overlap-report --max-gap-km | !/usr/bin/env python3 |
| `Scripts/wqp_clarity_coverage.py` | --registry --out --states --characteristic --since --min-acres --timeout | wqp_clarity_coverage.py - which of our lakes actually have a clarity measurement. |
| `Scripts/zone_coverage.py` | --catalog --feeds --line --out | !/usr/bin/env python3 |
| `test/verify_grokipedia_windows.py` | — | Windows-friendly Python test for Grokipedia/Wikipedia citation extraction |
