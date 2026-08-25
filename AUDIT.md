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
| files | 459 |
| jsModules | 290 |
| pyScripts | 163 |
| routes | 57 |
| routesUncalled | 0 |
| routesMutatingUngated | 18 |
| feeds | 107 |
| deadExports | 210 |
| orphanModules | 4 |
| duplicateFnNames | 42 |
| crossModuleGlobals | 39 |
| unresolvedImports | 0 |

## Worker routes

| route | method | auth | fetches | R2 | called from |
|---|---|---|---|---|---|
| `/attractors` | ANY | open | services.arcgis.com<br>services6.arcgis.com<br>services1.arcgis.com | — | gis-toggles.js |
| `/bank-pier` | ANY | open | services.arcgis.com<br>services6.arcgis.com<br>services1.arcgis.com | — | gis-toggles.js |
| `/build` | POST | open | — | — | **nothing** |
| `/chartpacks/lake-boundary` | GET | open | — | R2_TROLLMAP_CHARTPACKS.get<br>R2_TROLLMAP_CHARTPACKS.list | lake-research-engine.js<br>supplemental-layers.js |
| `/chartpacks/list` | ANY | open | — | R2_TROLLMAP_CHARTPACKS.list<br>R2_TROLLMAP_CHARTPACKS.get | **nothing** |
| `/debug/regs-cache` | ANY | **REQUIRED (inline)** | — | — | **nothing** |
| `/dominion-saluda` | ANY | **REQUIRED (inline)** | — | — | **nothing** |
| `/duke-flow-arrivals` | ANY | **REQUIRED (inline)** | — | — | **nothing** |
| `/groq-query` | POST | open | — | — | smart-plan-v2.js |
| `/hazards` | ANY | open | waterservices.usgs.gov | — | notifications.js |
| `/identify-catch` | POST | open | — | — | catch-journal.js |
| `/identify-catch-v2` | POST | open | — | — | catch-journal.js |
| `/lake-clarity` | ANY | open | — | — | lake-intel.js |
| `/lake-intel` | ANY | open | — | — | main.js<br>lake-intel.js |
| `/lake-intel-sources` | ANY | open | — | — | **nothing** |
| `/lake-research` | GET | open | services.arcgis.com<br>services6.arcgis.com<br>services1.arcgis.com | — | main.js |
| `/lakes/` | GET | open | services.arcgis.com<br>services6.arcgis.com<br>services1.arcgis.com | — | **nothing** |
| `/lakes/list` | GET | open | — | — | **nothing** |
| `/paddle` | ANY | open | services.arcgis.com<br>services6.arcgis.com<br>services1.arcgis.com | — | access-index.js<br>gis-toggles.js |
| `/ramps` | ANY | open | services.arcgis.com<br>services6.arcgis.com<br>services1.arcgis.com | — | access-index.js<br>ramps-loader.js<br>main.js |
| `/regulations` | ANY | open | — | — | regulations-live.js<br>lake-research-engine.js |
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
| `/research/get` | GET | open | — | — | lake-research-engine.js<br>lake-research-ui.js<br>smart-plan-v2-wiring.js |
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
| `/river` | ANY | **REQUIRED (inline)** | — | — | plan-builder.js<br>plan-inputs.js |
| `/rivers` | ANY | **REQUIRED (inline)** | — | — | **nothing** |
| `/sync` | ANY | **REQUIRED (prefix)** | — | — | cloud-sync.js |
| `/sync/list-updates` | GET | **REQUIRED (prefix)** | — | — | cloud-sync.js |
| `/sync/migrate` | POST | **REQUIRED (prefix)** | — | — | **nothing** |
| `/usgs` | ANY | open | waterservices.usgs.gov | — | lake-research-engine.js |
| `limnology.thermocline.strength` | ANY | open | — | — | lake-research-engine.js |

### Non-GET routes not in MUTATING_ROUTES

Read-shaped POSTs (LLM proxies, search) are deliberately open — see the comment above
`MUTATING_ROUTES`. Anything here that WRITES is a hole.

- `POST /build` — Worker/trollmap-worker.js:978
- `POST /identify-catch` — Worker/trollmap-worker.js:984
- `POST /identify-catch-v2` — Worker/trollmap-worker.js:992
- `POST /groq-query` — Worker/trollmap-worker.js:999
- `POST /research/thermocline-search` — Worker/trollmap-worker.js:1016
- `POST /research/limnology-data` — Worker/trollmap-worker.js:1021
- `POST /research/deterministic-facts` — Worker/trollmap-worker.js:1024
- `POST /research/discover` — Worker/trollmap-worker.js:1027
- `POST /research/analyze-facts` — Worker/trollmap-worker.js:1044
- `POST /research/dedupe-contradictions` — Worker/trollmap-worker.js:1047
- `POST /research/map-facts` — Worker/trollmap-worker.js:1050
- `POST /research/gap-analysis` — Worker/trollmap-worker.js:1053
- `POST /research/gap-search` — Worker/trollmap-worker.js:1056
- `POST /research/agent-llm` — Worker/trollmap-worker.js:1059
- `POST /research/proxy-download-batch` — Worker/trollmap-worker.js:1082
- `POST /research/shared/check` — Worker/trollmap-worker.js:1086
- `POST /research/shared/query` — Worker/trollmap-worker.js:1092
- `POST /research/validation-pass` — Worker/trollmap-worker.js:1124

## Routes nothing calls

_none_

## External feeds

| host | side | refs | first seen |
|---|---|---|---|
| pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev | worker | 42 | Worker/research/clients.js:506 |
| www.dnr.sc.gov | worker, browser | 23 | Worker/research/agency-pages.js:34 |
| w | browser | 20 | test/coastal-regulations-live.test.js:50 |
| x | pipeline, browser | 19 | Scripts/capture_upstreams.py:260 |
| lakes.hydro-derived.duke-energy.app | pipeline, worker | 18 | Scripts/capture_upstreams.py:184 |
| www.anglersheadquarters.com | worker, browser | 16 | Worker/reports.js:63 |
| georgiawildlife.blog | worker, browser | 15 | Worker/reports.js:51 |
| trollmap-worker.colonal1981.workers.dev | pipeline, browser | 14 | Scripts/audit_research_fields.py:43 |
| www.eregulations.com | worker, browser | 13 | Worker/worker-data.js:909 |
| w.example | browser | 13 | test/smart-plan-v2.test.js:411 |
| waterservices.usgs.gov | pipeline, worker | 12 | Scripts/build_water_bindings.py:123 |
| www.carolinasportsman.com | worker, browser | 12 | Worker/reports.js:57 |
| www.tn.gov | worker, browser | 12 | Worker/reports.js:69 |
| api.firecrawl.dev | worker, browser | 11 | Worker/research/clients.js:277 |
| github.com | pipeline | 9 | Scripts/capture_upstreams.py:65 |
| nepis.epa.gov | worker, browser | 9 | Worker/research/dataset.js:10 |
| services.arcgis.com | pipeline, worker | 8 | Scripts/build_dnr_ramps_by_lake.py:153 |
| services6.arcgis.com | pipeline, worker | 8 | Scripts/build_dnr_ramps_by_lake.py:165 |
| services1.arcgis.com | pipeline, worker | 8 | Scripts/build_dnr_ramps_by_lake.py:177 |
| services3.arcgis.com | pipeline, worker | 8 | Scripts/build_dnr_ramps_by_lake.py:188 |
| www.tva.com | pipeline, worker, browser | 8 | Scripts/build_water_bindings.py:118 |
| usgs-nims-images.s3.amazonaws.com | pipeline, worker, browser | 6 | Scripts/build_camera_index.py:61 |
| api.tidesandcurrents.noaa.gov | pipeline, worker, browser | 6 | Scripts/build_water_bindings.py:121 |
| water.noaa.gov | pipeline | 6 | Scripts/build_water_bindings.py:609 |
| api.hydro-derived.duke-energy.app | worker | 6 | Worker/conditions.js:1767 |
| waterdata.usgs.gov | worker, browser | 6 | Worker/worker-data.js:933 |
| lakemonster.com | worker | 6 | Worker/worker-data.js:957 |
| www.topografix.com | browser | 6 | js/modules/garmin-export.js:65 |
| api.waterdata.usgs.gov | pipeline, worker, browser | 5 | Scripts/build_camera_index.py:59 |
| www.waterqualitydata.us | pipeline, worker, browser | 5 | Scripts/capture_upstreams.py:125 |
| worker | pipeline, browser | 5 | Scripts/capture_upstreams.py:260 |
| data-scdnr.opendata.arcgis.com | worker | 5 | Worker/worker-data.js:941 |
| mapservices.weather.noaa.gov | pipeline, worker | 4 | Scripts/build_lake_drainage.py:152 |
| cwms-data.usace.army.mil | pipeline, worker | 4 | Scripts/build_water_bindings.py:119 |
| aa.usno.navy.mil | pipeline, worker, browser | 4 | Scripts/capture_upstreams.py:21 |
| dashboard.waterdata.usgs.gov | pipeline, worker | 4 | Scripts/capture_upstreams.py:152 |
| cdnjs.cloudflare.com | pipeline, browser | 4 | Scripts/show_missing_water.py:308 |
| grokipedia.com | worker | 4 | Worker/research/discover.js:544 |
| unpkg.com | browser | 4 | index.html:8 |
| x.gov | browser | 4 | test/proxy-target-type.test.js:31 |
| www.google.com | pipeline | 3 | Scripts/build_garmin_water_inventory.py:649 |
| dash.cloudflare.com | pipeline | 3 | Scripts/trollmap_r2_clean.py:6 |
| api.scrape.do | worker | 3 | Worker/research/clients.js:475 |
| www.dominionenergy.com | worker | 3 | Worker/trollmap-worker.js:387 |
| www.santeecooper.com | worker, browser | 3 | Worker/worker-data.js:1016 |
| water.sas.usace.army.mil | worker | 3 | Worker/worker-data.js:1125 |
| api.open-meteo.com | worker, browser | 3 | Worker/worker-data.js:1448 |
| www.safewaters.com | browser | 3 | test/operator-levels.test.js:173 |
| w.dev | browser | 3 | test/shared-latest-pointer.test.js:73 |
| ww4.cubecarolinas.com | pipeline, worker | 2 | Scripts/bind_operator_lakes.py:192 |
| lakes.southernco.com | pipeline, worker | 2 | Scripts/bind_operator_lakes.py:194 |
| www.ncpaws.org | pipeline | 2 | Scripts/build_nc_species_by_lake.py:61 |
| www.ndbc.noaa.gov | pipeline | 2 | Scripts/probe_ndbc_stations.py:36 |
| safewaters.com | pipeline | 2 | Scripts/test_bind_operator_lakes.py:127 |
| api.water.noaa.gov | worker | 2 | Worker/conditions.js:808 |
| azapp-lakespublic-prd-001.azurewebsites.net | worker | 2 | Worker/conditions.js:1530 |
| georgiawildlife.com | worker, browser | 2 | Worker/research/dataset.js:17 |
| generativelanguage.googleapis.com | worker | 2 | Worker/trollmap-worker.js:800 |
| coastalgadnr.org | worker, browser | 2 | Worker/worker-data.js:1717 |
| deq.nc.gov | worker, browser | 2 | Worker/worker-data.js:1718 |
| server.arcgisonline.com | browser | 2 | js/core/map-init.js:29 |
| 127.0.0.1 | browser | 2 | js/modules/capture-panel.js:14 |
| cofc.edu | browser | 2 | test/discover-authority.test.js:45 |
| x.pdf | browser | 2 | test/search-cascade.test.js:240 |
| hydro.nationalmap.gov | pipeline | 1 | Scripts/build_lake_drainage.py:61 |
| api.epa.gov | pipeline | 1 | Scripts/build_water_advisories.py:56 |
| . | pipeline | 1 | Scripts/capture_upstreams.py:30 |
| wiki.openstreetmap.org | pipeline | 1 | Scripts/fetch_osm_coastal.py:343 |
| www.weather.gov | pipeline | 1 | Scripts/probe_ndbc_stations.py:11 |
| prd-tnm.s3.amazonaws.com | pipeline | 1 | Scripts/trollmap_nhd_boundaries.py:34 |
| api.cloudflare.com | pipeline | 1 | Scripts/trollmap_r2_clean.py:39 |
| forecast.weather.gov | worker | 1 | Worker/conditions.js:233 |
| publicservice.dominionenergyse.com | worker | 1 | Worker/conditions.js:1540 |
| api.tavily.com | worker | 1 | Worker/research/clients.js:239 |
| s.jina.ai | worker | 1 | Worker/research/clients.js:311 |
| www.ncwildlife.org | worker | 1 | Worker/research/dataset.js:13 |
| r.jina.ai | worker | 1 | Worker/research/download.js:676 |
| api.groq.com | worker | 1 | Worker/worker-core.js:126 |
| openrouter.ai | worker | 1 | Worker/worker-core.js:139 |
| trollmap.dev | worker | 1 | Worker/worker-core.js:152 |
| api.cerebras.ai | worker | 1 | Worker/worker-core.js:159 |
| static.cloudflareinsights.com | browser | 1 | index.html:1284 |
| tile.openstreetmap.org | browser | 1 | js/core/map-init.js:33 |
| saltwaterfishing.sc.gov | browser | 1 | js/data/coastal-regulations.js:91 |
| fishing-app.gpsnauticalcharts.com | browser | 1 | js/modules/capture-panel.js:15 |
| archive-api.open-meteo.com | browser | 1 | js/modules/catch-journal.js:159 |
| cdn.jsdelivr.net | browser | 1 | js/modules/catch-journal.js:1067 |
| www.garmin.com | browser | 1 | js/modules/garmin-export.js:66 |
| www.openstreetmap.org | browser | 1 | js/modules/ramps.js:59 |
| nominatim.openstreetmap.org | browser | 1 | js/modules/topbar.js:106 |
| www.sad.usace.army.mil | browser | 1 | test/discover-authority.test.js:20 |
| www.osti.gov | browser | 1 | test/discover-authority.test.js:23 |
| tidesandcurrents.noaa.gov | browser | 1 | test/discover-authority.test.js:24 |
| www.ncwildlife.gov | browser | 1 | test/discover-authority.test.js:26 |
| lakelevels.duke-energy.com | browser | 1 | test/discover-authority.test.js:29 |
| elibrary.ferc.gov | browser | 1 | test/discover-authority.test.js:30 |
| seafwa.org | browser | 1 | test/discover-authority.test.js:32 |
| southcarolinaparks.com | browser | 1 | test/discover-authority.test.js:34 |
| www.whitehouse.gov | browser | 1 | test/discover-authority.test.js:83 |
| dnr.state.mn.us | browser | 1 | test/doc-relevance.test.js:27 |
| a.com | browser | 1 | test/doc-relevance.test.js:61 |
| b.com | browser | 1 | test/doc-relevance.test.js:62 |
| www.gastongov.com | browser | 1 | test/duke-access-alerts.test.js:39 |
| www.sas.usace.army.mil | browser | 1 | test/proxy-target-type.test.js:21 |
| api.search.tinyfish.ai | browser | 1 | test/research-discover-policy.test.js:15 |
| api.fetch.tinyfish.ai | browser | 1 | test/research-discover-policy.test.js:26 |
| api.weather.gov | browser | 1 | test/wwa-hazards.test.js:19 |

## R2 key shapes

| op | key expression | where |
|---|---|---|
| get | `cacheKey` | Worker/core/arcgis.js:91 |
| put | `cacheKey` | Worker/core/arcgis.js:327 |
| get | `cacheKey` | Worker/core/arcgis.js:356 |
| put | `safeKey` | Worker/research/deterministic.js:175 |
| put | `key` | Worker/research/deterministic.js:257 |
| get | ``lake_packages/${id}/normalized_documents.json`` | Worker/research/deterministic.js:278 |
| get | ``lake_packages/${LEGACY_PROFILE_KEYS[safe]}/normalized_documents.json`` | Worker/research/deterministic.js:283 |
| get | `cacheKey` | Worker/research/facts-util.js:373 |
| put | `cacheKey` | Worker/research/facts-util.js:410 |
| get | ``${lakeKey}/shoreline.geojson`` | Worker/research/limnology.js:48 |
| get | ``${lakeKey}/garmin_shoreline.geojson`` | Worker/research/limnology.js:49 |
| get | `key` | Worker/research/limnology.js:465 |
| put | `key` | Worker/research/limnology.js:500 |
| get | ``${SHARED_ROOT}/pointers/current.json`` | Worker/research/shared.js:270 |
| get | `key` | Worker/research/shared.js:323 |
| put | `vKey` | Worker/research/shared.js:362 |
| put | `latestKey` | Worker/research/shared.js:364 |
| put | ``${SHARED_ROOT}/documents/${docId}/latest.json`` | Worker/research/shared.js:427 |
| list | `{ prefix: `${SHARED_ROOT}/documents/`` | Worker/research/shared.js:533 |
| get | `obj.key` | Worker/research/shared.js:547 |
| head | `vKey` | Worker/research/shared.js:567 |
| put | `obj.key` | Worker/research/shared.js:569 |
| put | ``${SHARED_ROOT}/generations/${genId}/manifest.json`` | Worker/research/shared.js:593 |
| get | ``${SHARED_ROOT}/pointers/current.json`` | Worker/research/shared.js:600 |
| put | ``${SHARED_ROOT}/pointers/previous.json`` | Worker/research/shared.js:603 |
| put | ``${SHARED_ROOT}/pointers/current.json`` | Worker/research/shared.js:605 |
| put | ``${SHARED_ROOT}/quarantine/${docId}.json`` | Worker/research/shared.js:661 |
| get | ``${SHARED_ROOT}/quarantine/${docId}.json`` | Worker/research/shared.js:671 |
| list | `{ prefix` | Worker/research/storage.js:15 |
| get | ``lakes/${id}.json`` | Worker/research/storage.js:34 |
| list | `{prefix: `lake_packages/${safe}/`}` | Worker/research/storage.js:54 |
| list | `{prefix: `lakes/versions/${safe}/`}` | Worker/research/storage.js:63 |
| get | ``lakes/${id}.json`` | Worker/research/storage.js:88 |
| get | ``lakes/${safe}.json`` | Worker/research/storage.js:98 |
| list | `{prefix:`lakes/versions/${safe}/`}` | Worker/research/storage.js:107 |
| put | ``lakes/${safe}.json`` | Worker/research/storage.js:259 |
| put | ``lakes/versions/${safe}/v${nextVersion}.json`` | Worker/research/storage.js:264 |
| put | ``lake_packages/${safe}/${k}.json`` | Worker/research/storage.js:274 |
| put | ``lake_packages/${safe}/sources.json`` | Worker/research/storage.js:281 |
| put | ``lake_packages/${safe}/metadata.json`` | Worker/research/storage.js:282 |
| put | ``lake_packages/${safe}/evidence.json`` | Worker/research/storage.js:283 |
| put | ``lake_packages/${safe}/research_log.json`` | Worker/research/storage.js:284 |
| put | ``lake_packages/${safe}/notes.md`` | Worker/research/storage.js:286 |
| get | `masterKey` | Worker/research/storage.js:299 |
| put | `masterKey` | Worker/research/storage.js:311 |
| get | `key` | Worker/research/storage.js:326 |
| put | `key` | Worker/research/storage.js:339 |
| get | ``lakes/${id}.json`` | Worker/research/storage.js:354 |
| list | `{ prefix: `lake_packages/${safe}/` }` | Worker/research/storage.js:358 |
| list | `{ prefix: `lakes/versions/${safe}/` }` | Worker/research/storage.js:366 |
| delete | `key` | Worker/research/storage.js:376 |
| list | `{ prefix: `lake_packages/${id}/` }` | Worker/research/storage.js:390 |
| get | ``lake_packages/${id}/${filename}`` | Worker/research/storage.js:406 |
| get | ``lakes/${safe}.json`` | Worker/research/storage.js:425 |
| get | ``lakes/${safeKey}.json`` | Worker/research/storage.js:428 |
| get | `key` | Worker/trollmap-worker.js:641 |
| put | `key` | Worker/trollmap-worker.js:656 |
| get | `key` | Worker/trollmap-worker.js:1633 |
| list | `{ prefix }` | Worker/trollmap-worker.js:1654 |
| get | `key` | Worker/trollmap-worker.js:1683 |
| put | `key` | Worker/trollmap-worker.js:1719 |
| get | `chartpackKey(slug` | Worker/water.js:76 |
| get | `chartpackKey(slug` | Worker/water.js:87 |
| list | `{ cursor` | Worker/worker-core.js:342 |

## Data files — who reads them

| file | read by |
|---|---|
| `   nearest different pools. Geometry cannot separate them; registry/_duke_dams.json` | Scripts/bind_dams_to_waters.py:267 |
| `  1. add the row to registry/lakes.json and registry/tile_lake_map.json` | Scripts/boundary_from_3dhp.py:270 |
| `../registry/lake_index.json` | test/keys_smoke.mjs:21<br>test/registry_smoke.mjs:21 |
| `<packs>/../registry/_r2_only.txt` | Scripts/r2_vs_local.py:435 |
| `data/tristate-bank-pier.json` | test/fixtures.test.js:51 |
| `data/tristate-hotspots.json` | test/fixtures.test.js:53 |
| `data/tristate-paddle.json` | test/fixtures.test.js:52 |
| `default <repo>/../registry/_research_field_consumers.json` | Scripts/audit_research_fields.py:314 |
| `default <repo>/../registry/_research_profiles_cache.json` | Scripts/audit_research_fields.py:312 |
| `r2_audit.py --save output. Default <packs>/../registry/_r2_listing.json` | Scripts/r2_vs_local.py:429 |
| `registry/_coastal_pointers.json` | Scripts/gen_water_aliases_js.py:105 |
| `registry/_cwms_inventory.json` | Scripts/probe_cwms_catalog.py:62 |
| `registry/_deletion_tab.json` | Scripts/merge_duplicate_waters.py:42 |
| `registry/_feed_names.json` | Scripts/build_water_names.py:55<br>Scripts/consolidate_lake_index.py:13<br>Scripts/consolidate_lake_index.py:849 |
| `registry/_ndbc_stations.json` | Scripts/probe_ndbc_stations.py:47 |
| `registry/_nhd_bindings.json` | Scripts/merge_duplicate_waters.py:41 |
| `registry/_r2_listing.json` | Scripts/r2_vs_local.py:29 |
| `registry/_start_here_facts.json` | Scripts/check_start_here.py:29 |
| `registry/_usgs_current_conditions.json` | Scripts/pull_usgs_current_conditions.py:65 |
| `registry/_water_bindings_review.json` | Scripts/triage_water_bindings.py:10 |
| `registry/charted.json` | Scripts/build_structure.py:51<br>Scripts/build_trolling_runs.py:62<br>Scripts/build_water_features.py:100 |
| `registry/curated_lakes.json` | Scripts/remove_registry_water.py:48 |
| `registry/gauge_overrides.json` | Scripts/build_water_bindings.py:1457 |
| `registry/lake_aliases.json` | Scripts/build_dnr_ramps_by_lake.py:66<br>Scripts/remove_registry_water.py:48 |
| `registry/lake_display_names.json` | Scripts/merge_duplicate_waters.py:61 |
| `registry/lake_index.json` | Scripts/bind_dams_to_waters.py:43<br>Scripts/build_dnr_ramps_by_lake.py:32<br>Scripts/build_duke_dam_table.py:37<br>Scripts/build_water_chain.py:66<br>Scripts/find_duplicate_waters.py:39<br>Scripts/gen_water_aliases_js.py:109<br>Scripts/lookup_3dhp.py:11<br>Scripts/match_waters_to_nhd.py:41<br>Scripts/merge_duplicate_waters.py:40<br>Scripts/migrate_merged_slugs.py:50<br>Scripts/sweep_unclaimed.py:52<br>Scripts/sweep_unclaimed.py:226 |
| `registry/lakes.json` | Scripts/cut_boundaries_batch.py:55<br>Scripts/make_coastal_boundaries.py:17<br>Scripts/sweep_unclaimed.py:352<br>Scripts/verify_registry_r2.py:48 |
| `registry/nc_species_by_lake.json` | Scripts/build_nc_species_by_lake.py:9 |
| `registry/osm_ramps_by_lake.json` | Scripts/make_osm_ramps_by_lake.py:12 |
| `registry/region_mask.json` | Scripts/build_coverage_cache.py:37<br>Scripts/make_region_mask.py:8<br>Scripts/sweep_unclaimed.py:61 |
| `registry/tile_lake_map.json` | Scripts/find_affected_tiles.py:104 |
| `registry/water_bindings.json` | Scripts/triage_water_bindings.py:18 |
| `registry/water_chain.json` | Scripts/build_water_chain.py:67 |

## JS modules

| module | lines | exports | imported by | dead exports | purpose |
|---|---|---|---|---|---|
| `Scripts/make_counties.mjs` | 49 | 0 | 0 | 0 | make_counties.mjs -- flatten us-atlas counties-10m TopoJSON into a GeoJSON the Python |
| `Worker/cameras.js` | 176 | 5 | 1 | **4** | Worker/cameras.js — the current frame from a USGS NIMS camera. |
| `Worker/conditions.js` | 4495 | 63 | 32 | **2** | Worker/conditions.js — one call that answers "what is this water doing right now". |
| `Worker/core/arcgis.js` | 401 | 7 | 2 | **2** | Worker/core/arcgis.js — shared ArcGIS helper for ramps/paddle/bank-pier/attractors |
| `Worker/operators.js` | 331 | 6 | 3 | 0 | operators.js — the three utility operators that publish HTML tables instead of JSON. |
| `Worker/registry.js` | 342 | 12 | 6 | **3** | The lake index, read by the Worker. |
| `Worker/reports.js` | 553 | 17 | 8 | **4** | reports.js — recent fishing reports for one water, from the people who were on it. |
| `Worker/research/agency-pages.js` | 221 | 9 | 2 | **2** | agency-pages.js — the state's own description of a lake, found through the state's own ind |
| `Worker/research/agents.js` | 1694 | 11 | 6 | **5** | research/agents.js — split from worker-research.js (behavior-preserving) |
| `Worker/research/behaviour.js` | 197 | 2 | 1 | 0 | research/behaviour.js — reading fishing behaviour out of already-extracted facts. |
| `Worker/research/clients.js` | 1362 | 46 | 12 | 0 | research/clients.js — split from worker-research.js (behavior-preserving) |
| `Worker/research/coastal-agents.js` | 264 | 5 | 3 | 0 | coastal-agents.js — saltwater-specific research agents. |
| `Worker/research/dataset.js` | 430 | 8 | 3 | **4** | research/dataset.js — split from worker-research.js (behavior-preserving) |
| `Worker/research/deterministic.js` | 294 | 3 | 2 | 0 | research/deterministic.js — split from worker-research.js (behavior-preserving) |
| `Worker/research/discover.js` | 1094 | 5 | 5 | 0 | research/discover.js — split from worker-research.js (behavior-preserving) |
| `Worker/research/download.js` | 708 | 4 | 3 | 0 | research/download.js — split from worker-research.js (behavior-preserving) |
| `Worker/research/extract.js` | 818 | 6 | 1 | 0 | research/extract.js — split from worker-research.js (behavior-preserving) |
| `Worker/research/facts-util.js` | 754 | 23 | 5 | **14** | research/facts-util.js — split from worker-research.js (behavior-preserving) |
| `Worker/research/keys.js` | 181 | 12 | 10 | **1** | research/keys.js — split from worker-research.js (behavior-preserving) |
| `Worker/research/limnology.js` | 513 | 4 | 4 | 0 | research/limnology.js — split from worker-research.js (behavior-preserving) |
| `Worker/research/shared.js` | 714 | 29 | 3 | **13** | research/shared.js — split from worker-research.js (behavior-preserving) |
| `Worker/research/storage.js` | 639 | 11 | 2 | 0 | research/storage.js — split from worker-research.js (behavior-preserving) |
| `Worker/trollmap-worker.js` | 1785 | 1 | 0 | 0 | r2Text is used by /chartpacks/lake-boundary (line ~1711). It was added to worker-core.js |
| `Worker/water.js` | 925 | 2 | 2 | **1** | Worker/water.js — the compute plane over the static pack layers. |
| `Worker/worker-core.js` | 433 | 10 | 22 | 0 | worker-core.js — Shared infrastructure: CORS headers, LLM provider chain, fetchText |
| `Worker/worker-data.js` | 1995 | 27 | 7 | 0 | worker-data.js — Static lake/river data extracted from trollmap-worker.js |
| `Worker/worker-research.js` | 14 | 37 | 1 | 0 | worker-research.js — public API barrel (impl in Worker/research/*) |
| `Worker/worker-species.js` | 230 | 10 | 1 | 0 | worker-species.js — Species lists and ecological validation |
| `js/core/layer-registry.js` | 300 | 18 | 8 | **6** | core/layer-registry.js — one owner for every toggleable map layer. |
| `js/core/map-init.js` | 470 | 17 | 16 | **6** | Leaflet map initialization + base-layer switching + waypoint/track |
| `js/core/state.js` | 63 | 2 | 49 | 0 | Shared mutable application state. |
| `js/core/tabs.js` | 70 | 1 | 1 | 0 | Bottom-nav tab switcher. |
| `js/data/access-index.js` | 896 | 11 | 8 | 0 | access-index.js — Shared worker-backed access-point index. |
| `js/data/cameras.js` | 1014 | 3 | 2 | **1** | GENERATED by Scripts/build_camera_index.py -- do not hand-edit. |
| `js/data/coastal-regulations.js` | 509 | 9 | 4 | 0 | coastal-regulations.js — saltwater size/creel/season rules for SC, GA, NC. |
| `js/data/coastal-zones.js` | 327 | 6 | 23 | 0 | coastal-zones.js — SC / GA / NC coastal + tidal zone catalog. |
| `js/data/fishing-style-profile.js` | 135 | 5 | 5 | **4** | fishing-style-profile.js — Ryan's actual gear, platform, and technique |
| `js/data/lake-keys.js` | 512 | 4 | 24 | 0 | Shared lake display-name → R2 key map. |
| `js/data/lake-registry.js` | 524 | 13 | 11 | 0 | lake-registry.js — the 3DHP lake registry, with every access source joined on. |
| `js/data/lure-knowledge.js` | 1083 | 20 | 12 | **4** | lure-knowledge.js — Lure behavior profiles and scoring engine. |
| `js/data/ramps-loader.js` | 209 | 2 | 4 | 0 | ramps.js — Tri-state (SC/NC/GA) boat ramp database. |
| `js/data/regulations-live.js` | 228 | 8 | 5 | 0 | The state regulation digest, in the browser. |
| `js/data/research-ids.js` | 121 | 7 | 2 | **1** | research-ids.js — the R2 storage id a lake's research profile lives under. |
| `js/data/species-intel.js` | 582 | 7 | 7 | **3** |  |
| `js/data/species-strategies.js` | 549 | 11 | 0 | **11** | species-strategies.js — Fishing behavior and tactical strategies per species. |
| `js/data/spread-defaults.js` | 59 | 1 | 1 | 0 | Default six-rod trolling spread, initialized on app load. |
| `js/data/tackle-inventory.js` | 381 | 6 | 9 | **2** | tackle-inventory.js — Ryan's personal lure inventory. |
| `js/data/water-aliases.js` | 198 | 4 | 5 | 0 | water-aliases.js — DNR waterbody name → chartpack key. |
| `js/data/water-filter.js` | 438 | 8 | 7 | 0 | water-filter.js — one predicate, three surfaces, and a bias toward keeping things. |
| `js/lazy-data.js` | 61 | 0 | 0 | 0 | lazy-data.js — on-demand loader for optional GIS data files. |
| `js/main.js` | 217 | 0 | 0 | 0 | TrollMap GPX Studio v10 — modular entry point. |
| `js/modules/auto-crop.js` | 37 | 0 | 1 | 0 | Auto-Crop — strips the phone status bar and Navionics zoom controls |
| `js/modules/ble-motor.js` | 204 | 0 | 1 | 0 | BLE Motor — XZNY / JBD / Xiaoxiang-style BMS pairing via Web Bluetooth API. |
| `js/modules/capture-panel.js` | 432 | 1 | 1 | **1** | capture-panel.js — Contour capture workflow panel. |
| `js/modules/catch-journal.js` | 1387 | 2 | 3 | 0 | catch-journal.js — TrollMap Catch Center |
| `js/modules/catch-photo.js` | 34 | 0 | 1 | 0 | Catch Verification Photo Lightbox — full-screen viewer for a |
| `js/modules/catch-plot.js` | 72 | 0 | 1 | 0 | Plot Catches on Map — toggle catch markers on the map. Markers |
| `js/modules/chart-import.js` | 435 | 2 | 2 | **1** | Contour / GIS layer import — load a KML, GPX, or GeoJSON file |
| `js/modules/chart-mosaic.js` | 435 | 5 | 3 | **2** | Chart mosaic — saved depth-contour overlay layers. |
| `js/modules/chart-overlay.js` | 492 | 1 | 1 | **1** | Chart overlay — the SINGLE working image being georeferenced. |
| `js/modules/cloud-sync.js` | 389 | 4 | 3 | 0 | Cloud Sync — auto-push on save, auto-pull on load. |
| `js/modules/coastal-layers.js` | 345 | 5 | 1 | **5** | coastal-layers.js — oyster beds, marsh edges and depth soundings. |
| `js/modules/coastal-scoring.js` | 289 | 15 | 3 | **1** | coastal-scoring.js — tide- and structure-aware spot scoring for inshore |
| `js/modules/conditions-strip.js` | 695 | 2 | 1 | **2** | The state of the water, above the map, before you plan anything. |
| `js/modules/contour-data.js` | 645 | 10 | 5 | **6** | contour-data.js — Contour dataset lazy loader + lake selector integration. |
| `js/modules/custom-vectors.js` | 146 | 4 | 2 | **2** | custom-vectors.js — imported GeoJSON layers. |
| `js/modules/edit.js` | 253 | 1 | 2 | 0 | Edit tab — table-based view of waypoints + tracks with inline |
| `js/modules/file-io.js` | 86 | 0 | 1 | 0 | Top-bar File I/O — Load / New / Save GPX. |
| `js/modules/fishing-index.js` | 309 | 0 | 1 | 0 | fishing-index.js — Fisherman-friendly overlay on top of SCDNR data |
| `js/modules/garmin-export.js` | 89 | 1 | 1 | **1** | Garmin-formatted GPX export. |
| `js/modules/garmin-parser.js` | 119 | 0 | 1 | 0 | Garmin Catch Parser — import a GPX file from a Garmin chartplotter |
| `js/modules/gear-autopilot.js` | 45 | 0 | 1 | 0 |  |
| `js/modules/gis-toggles.js` | 289 | 1 | 1 | **1** |  |
| `js/modules/gps.js` | 106 | 3 | 1 | **3** | GPS tracking — current location marker, follow mode, and recorded |
| `js/modules/lake-intel.js` | 332 | 2 | 2 | 0 | Lake Intelligence + Clarity Forecast — pulls fisherman-focused |
| `js/modules/lake-ramp-select.js` | 615 | 6 | 1 | **6** | Worker-backed Lake / Access dropdowns in the map toolbar. |
| `js/modules/lake-research-engine.js` | 3406 | 23 | 3 | 0 | lake-research-engine.js — Pipeline logic, geo helpers, fact building |
| `js/modules/lake-research-ui.js` | 1989 | 4 | 1 | 0 |  |
| `js/modules/lake-research.js` | 4 | 6 | 1 | **6** | lake-research.js — barrel re-export |
| `js/modules/layers-panel.js` | 105 | 4 | 1 | **2** | layers-panel.js — the one place every map overlay is turned on and off. |
| `js/modules/measure-tool.js` | 106 | 0 | 1 | 0 | Distance & Bearing Measurement Tool — click two points on the |
| `js/modules/noaa-tides.js` | 228 | 1 | 1 | **1** | NOAA Coastal Tides — Plan-tab tide panel. |
| `js/modules/notifications.js` | 548 | 7 | 3 | **5** | notifications.js — On-water alerts for TrollMap |
| `js/modules/osm-structure.js` | 145 | 0 | 1 | 0 | osm-structure.js — OSM Structure Layer Toggle |
| `js/modules/plan-assemble.js` | 872 | 8 | 10 | 0 | plan-assemble.js — ordered candidates + the model's judgement → a plan v2 object. |
| `js/modules/plan-builder.js` | 2547 | 10 | 7 | 0 | Plan Builder — the Plan tab form, save/load, preview rendering, |
| `js/modules/plan-candidates.js` | 1410 | 26 | 16 | **9** | Candidate legs for a day's plan — the payload the model chooses from. |
| `js/modules/plan-from-water.js` | 306 | 1 | 2 | 0 | plan-from-water.js — the water is already chosen. Build the day around it. |
| `js/modules/plan-inputs.js` | 527 | 9 | 5 | **1** | plan-inputs.js — the parts of "what am I planning" that are not the DOM. |
| `js/modules/plan-issues.js` | 78 | 1 | 2 | 0 | plan-issues.js — what the plan says about itself, in the shape the tab can show. |
| `js/modules/plan-pieces.js` | 361 | 4 | 3 | **1** | plan-pieces.js — turning charted lanes into the water a fisherman actually chooses from. |
| `js/modules/plan-preflight.js` | 413 | 8 | 4 | **2** | plan-preflight.js — the two things that must happen before a plan is worth building. |
| `js/modules/plan-prompt.js` | 755 | 13 | 5 | **1** | plan-prompt.js — what the model is asked, and what comes back. |
| `js/modules/plan-tab-wiring.js` | 68 | 0 | 1 | 0 | plan-tab-wiring.js |
| `js/modules/plan-to-timeline.js` | 407 | 6 | 6 | **1** | plan-to-timeline.js — a v2 plan, in the shape the rest of the Plan tab already reads. |
| `js/modules/plan-tracks.js` | 220 | 6 | 4 | **1** | plan-tracks.js — a v2 plan, materialised into the tracks and waypoints the export path rea |
| `js/modules/plan-water-index.js` | 134 | 2 | 2 | 0 | plan-water-index.js — the two spatial lookups the water reasons need, and nothing else. |
| `js/modules/plan-water-ui.js` | 912 | 4 | 1 | **3** | plan-water-ui.js — the Water tab. The screen where the fisherman chooses. |
| `js/modules/plan-water.js` | 1287 | 21 | 5 | 0 | plan-water.js — offer the water, with reasons, and let the fisherman choose. |
| `js/modules/qdc-decoder.js` | 520 | 6 | 2 | 0 | qdc-decoder.js — pure functions: raw .qdc folder → grid → contour GeoJSON. |
| `js/modules/quickdraw-key.js` | 95 | 0 | 1 | 0 | Depth key — the legend for the one depth ladder. |
| `js/modules/ramp-cameras.js` | 85 | 2 | 2 | 0 | USGS NIMS camera frames in the boat-ramp popup. |
| `js/modules/ramps.js` | 151 | 3 | 1 | **3** | Boat-ramp layer (concrete ramps across SC/NC/GA/TN, live from state DNR feeds). |
| `js/modules/routes-panel.js` | 218 | 0 | 1 | 0 | routes-panel.js — the right slide-in panel. |
| `js/modules/safety-checklist.js` | 114 | 0 | 1 | 0 | Autonomous Safety Checklist — auto-compiles a tactical safety |
| `js/modules/saved-spreads.js` | 82 | 1 | 2 | 0 | Saved rod spreads — name a rod configuration and persist it |
| `js/modules/smart-plan-route.js` | 190 | 3 | 0 | **3** | smart-plan-route.js — turn SmartPlan's intent into geometry the Worker built. |
| `js/modules/smart-plan-ui.js` | 911 | 5 | 2 | **3** | smart-plan-ui.js — Unified Trip Timeline (Trolling + Stop-and-Cast interleaved) |
| `js/modules/smart-plan-v2-wiring.js` | 424 | 7 | 2 | **4** | smart-plan-v2-wiring.js — the DOM end of SmartPlan v2. |
| `js/modules/smart-plan-v2.js` | 295 | 6 | 5 | 0 | smart-plan-v2.js — the whole plan, one path. |
| `js/modules/species-selector.js` | 298 | 3 | 2 | **1** | species-selector.js — swap the Plan tab's target-species checkboxes between |
| `js/modules/spot-repositioning.js` | 33 | 0 | 1 | 0 | Spot Repositioning — drag a marker (GIS spot, ramp, attractor) |
| `js/modules/spread-builder.js` | 371 | 13 | 6 | **10** | Rod Spread Builder — the table UI in the Plan tab where each rod |
| `js/modules/supplemental-layers.js` | 1436 | 13 | 2 | **11** | supplemental-layers.js — Supplemental PBF-extracted layer integration. |
| `js/modules/sw-register.js` | 13 | 0 | 1 | 0 | Service Worker registration — registers ./sw.js once the page |
| `js/modules/tackle-inventory-ui.js` | 170 | 2 | 3 | 0 | tackle-inventory-ui.js — Collapsible tackle inventory panel in the Plan tab. |
| `js/modules/tide-engine.js` | 336 | 14 | 9 | 0 | tide-engine.js — NOAA CO-OPS tide data as a reusable module. |
| `js/modules/topbar.js` | 163 | 0 | 1 | 0 | Topbar dropdown controls — basemap selector, edit-mode dropdown, |
| `js/modules/track-reverse.js` | 60 | 0 | 1 | 0 | Track Reversal Studio — append a reversed copy of the first |
| `js/modules/usgs-gauges.js` | 170 | 6 | 2 | **3** | usgs-gauges.js — river discharge as a salinity proxy for coastal zones. |
| `js/modules/utility-sync.js` | 158 | 1 | 2 | 0 | Live water conditions for the selected Plan lake — ONE read, one unit. |
| `js/modules/water-search.js` | 201 | 4 | 2 | 0 | water-search.js — search everything TrollMap knows, not everything OpenStreetMap knows. |
| `js/modules/waypoint-to-generator.js` | 33 | 0 | 1 | 0 | One-Click Waypoint → Lane Connect — clicking a waypoint popup |
| `js/modules/wet-hands-remote.js` | 101 | 0 | 1 | 0 | Wet Hands Remote — keyboard + gamepad navigation shortcuts so |
| `js/utils/call-global.js` | 70 | 2 | 7 | 0 | callGlobal — invoke a function that another module hung on `window`, without letting it |
| `js/utils/cameras.js` | 172 | 9 | 3 | **2** | Which USGS cameras are on this water, and the newest frame from one. |
| `js/utils/coastal-optgroups.js` | 46 | 1 | 3 | 0 | coastal-optgroups.js — append the SC / GA / NC coastal zone <optgroup>s to a <select>. |
| `js/utils/coerce.js` | 292 | 10 | 5 | 0 | Coercion helpers for biology arrays that may be malformed in stored profiles. |
| `js/utils/db.js` | 339 | 14 | 18 | 0 | IndexedDB layer for TrollMap persistence. |
| `js/utils/dedupe.js` | 52 | 1 | 2 | 0 | Spatial + text deduplication for boat-ramp launches. |
| `js/utils/depth-palette.js` | 90 | 3 | 5 | 0 | depth-palette.js — ONE depth ladder for every layer that colours by depth. |
| `js/utils/doc-relevance.js` | 86 | 3 | 2 | 0 | doc-relevance.js — the off-lake gate, moved off the Worker. |
| `js/utils/escape.js` | 17 | 1 | 24 | 0 | HTML-escape a string for safe interpolation into innerHTML. |
| `js/utils/geo.js` | 401 | 17 | 9 | **8** | Pure geographic / coordinate math helpers. |
| `js/utils/geojson-coords.js` | 128 | 4 | 4 | 0 | Walking GeoJSON coordinates, and the bounding box that falls out of it. |
| `js/utils/parsers.js` | 228 | 5 | 3 | 0 | Format parsers — GPX, KML, GeoJSON. |
| `js/utils/rod-row.js` | 39 | 1 | 4 | 0 | Build a single rod-spread row with sensible defaults. |
| `js/utils/solunar.js` | 145 | 2 | 3 | 0 | utils/solunar.js — moon-driven feeding windows. ONE implementation. |
| `js/utils/species-phase.js` | 102 | 3 | 1 | 0 | WHAT THE FISH ARE DOING AT THIS HOUR — a stated rule, not invented per-lake numbers. |
| `js/utils/structure-markers.js` | 103 | 3 | 2 | 0 | structure-markers.js — humps and ledges, read from the pack the pipeline builds. |
| `js/utils/viewport-cull.js` | 129 | 7 | 5 | **1** | Viewport culling for big GeoJSON layers. |
| `js/utils/water-conditions.js` | 802 | 7 | 7 | 0 | ONE READ FOR THE STATE OF THE WATER. |
| `js/utils/worker-auth.js` | 63 | 3 | 5 | 0 | utils/worker-auth.js — the shared secret for TrollMap's own Worker, in one place. |
| `sw.js` | 94 | 0 | 0 | 0 | TrollMap service worker — v18 (the shell was frozen at v17, 2026-08-16) |
| `test/agency-domains.test.js` | 85 | 0 | 0 | 0 | A TABLE THAT LOOKS LIKE A KNOB AND IS NOT CONNECTED. |
| `test/agency-pages.test.js` | 224 | 0 | 0 | 0 | The state's own lake index, resolved to the water this app ships. |
| `test/agency-table-lookup.test.js` | 90 | 0 | 0 | 0 | The agency profile tables are keyed by the AGENCY's name for the lake, not by ours. |
| `test/agent-prompt-echo.test.js` | 79 | 0 | 0 | 0 | Agents must not be asked to echo back data they did not produce. |
| `test/arcgis-filter-guard.test.js` | 203 | 0 | 0 | 0 |  |
| `test/bait-depth-ceiling.test.js` | 97 | 0 | 0 | 0 |  |
| `test/chart-datum.test.js` | 578 | 0 | 0 | 0 | What the chart was drawn at, versus where the water is today. |
| `test/check-imports.mjs` | 137 | 0 | 0 | 0 | check-imports.mjs — every named import across js/ must resolve to a real export. |
| `test/check-lake-geo.mjs` | 311 | 0 | 0 | 0 | check-lake-geo.mjs — a name must map to a lake in the right PLACE. |
| `test/check-lake-keys-parity.mjs` | 57 | 0 | 0 | 0 | !/usr/bin/env node |
| `test/check-tackle-parity.mjs` | 244 | 0 | 0 | 0 | check-tackle-parity.mjs — runner-free tackle parity check. |
| `test/cloud-sync.test.js` | 131 | 0 | 0 | 0 | test/cloud-sync.test.js -- a deleted plan must actually tombstone in the cloud. |
| `test/coastal-agents.test.js` | 213 | 0 | 0 | 0 |  |
| `test/coastal-dropdown.test.js` | 223 | 0 | 0 | 0 |  |
| `test/coastal-landing.test.js` | 125 | 0 | 0 | 0 |  |
| `test/coastal-layers.test.js` | 78 | 0 | 0 | 0 |  |
| `test/coastal-ramps-dynamic.test.js` | 26 | 0 | 0 | 0 |  |
| `test/coastal-regulations-live.test.js` | 369 | 0 | 0 | 0 | THE SAME FILE AS FRESHWATER, AND IT ALWAYS WAS. |
| `test/coastal-regulations.test.js` | 293 | 0 | 0 | 0 |  |
| `test/coastal-scoring.test.js` | 282 | 0 | 0 | 0 |  |
| `test/coastal-zones-parity.test.js` | 171 | 0 | 0 | 0 |  |
| `test/coerce.test.js` | 298 | 0 | 0 | 0 |  |
| `test/conditions-bindings.test.js` | 416 | 0 | 0 | 0 | Harness: exercise handleConditions with a stubbed R2 + stubbed upstreams. |
| `test/conditions-follow-the-ramp.test.js` | 120 | 0 | 0 | 0 | The point you ask about is the answer you get. |
| `test/confidence.test.js` | 157 | 0 | 0 | 0 |  |
| `test/credit-guards.test.js` | 228 | 0 | 0 | 0 | THE TWO PLACES A PAID SERVICE'S BALANCE WAS A NUMBER SOMEBODY TYPED. |
| `test/cwms-series.test.js` | 434 | 0 | 0 | 0 | Picking the Corps' pool elevation out of forty-two candidates, and the metres trap. |
| `test/cwms-units.test.js` | 202 | 0 | 0 | 0 | THE CORPS PUBLISHES ITS OWN UNIT TABLE, AND OURS WAS A HAND-TYPED SUBSET OF IT. |
| `test/data-reaches-the-app.test.js` | 329 | 0 | 0 | 0 |  |
| `test/db-writes.test.js` | 232 | 0 | 0 | 0 | test/db-writes.test.js — a write either happened or it did not, and the caller must be abl |
| `test/depth-null-is-not-zero.test.js` | 95 | 0 | 0 | 0 | A DEPTH NOBODY MEASURED IS NOT A DEPTH OF ZERO. |
| `test/depth-palette.test.js` | 140 | 0 | 0 | 0 |  |
| `test/deterministic-regression.test.js` | 17 | 0 | 0 | 0 |  |
| `test/discover-authority.test.js` | 106 | 0 | 0 | 0 | authorityForUrl -- the domain-trust ladder shared by the Grok and Wikipedia citation paths |
| `test/dnr-registry-merge.test.js` | 227 | 0 | 0 | 0 |  |
| `test/doc-relevance.test.js` | 84 | 0 | 0 | 0 | The off-lake gate, which could not be tested where it used to live. |
| `test/duke-access-alerts.test.js` | 152 | 0 | 0 | 0 | What is shut, and why the water is where it is. |
| `test/duke-alerts-water.test.js` | 166 | 0 | 0 | 0 | THREE ALERTS FROM THREE OTHER RIVER BASINS, ON ONE WORD. |
| `test/duke-feed-reach.test.js` | 84 | 0 | 0 | 0 | Every lake Duke publishes, reachable — not the nine in the table. |
| `test/duke-lake-row.test.js` | 83 | 0 | 0 | 0 | normalizeDukeRow against the REAL /lakes/current-level response. |
| `test/duke-operating-range.test.js` | 278 | 0 | 0 | 0 | The guide curve, the drought stage as a NUMBER, and where this date usually sits. |
| `test/duke-release-direction.test.js` | 396 | 0 | 0 | 0 | Inflow or outflow: which side of a lake a Duke release comes from. |
| `test/expect-shim.mjs` | 221 | 8 | 89 | 0 | test/expect-shim.mjs -- `describe`/`it`/`expect` on top of node:test and node:assert. |
| `test/facts-are-not-agent-scoped.test.js` | 86 | 0 | 0 | 0 | A FIX BUILT ON A PREMISE NOBODY MEASURED. |
| `test/fake-indexeddb.mjs` | 186 | 2 | 4 | 0 | test/fake-indexeddb.mjs — a small in-memory IndexedDB, enough for utils/db.js. |
| `test/fishing-reports.test.js` | 331 | 0 | 0 | 0 | The four fishing-report sources, parsed and matched to water this app ships. |
| `test/fixtures.test.js` | 107 | 0 | 0 | 0 |  |
| `test/flow-percentile.test.js` | 102 | 0 | 0 | 0 | Where today's flow sits in this river's own history. |
| `test/geojson-coords.test.js` | 136 | 0 | 0 | 0 | test/geojson-coords.test.js — the bounding box, and the 3D case the old heuristic got wron |
| `test/hand-written-tables.test.js` | 337 | 0 | 0 | 0 | THE TABLES THAT NEVER GREW WHEN THE APP DID. |
| `test/hazard-cues.test.js` | 238 | 0 | 0 | 0 | NWS WATCHES AND WARNINGS AS ECHOMAP ALERTS. |
| `test/keys_smoke.mjs` | 104 | 0 | 0 | 0 | keys_smoke.mjs -- prove every shipped lake's display name resolves to its own R2 key. |
| `test/lake-keys-parity.test.js` | 116 | 0 | 0 | 0 |  |
| `test/lake-keys.test.js` | 185 | 0 | 0 | 0 |  |
| `test/lake-name.test.js` | 76 | 0 | 0 | 0 |  |
| `test/lake-picker-groups.test.js` | 207 | 1 | 0 | **1** |  |
| `test/lake-registry.test.js` | 189 | 0 | 0 | 0 | test/lake-registry.test.js -- the registry resolves lake names to the right lake. |
| `test/layer-registry.test.js` | 333 | 0 | 0 | 0 | test/layer-registry.test.js — one owner for layer visibility, and it stays one. |
| `test/layers-panel.test.js` | 166 | 0 | 0 | 0 | test/layers-panel.test.js — the bar stays slim and no toggle goes missing. |
| `test/live-ramps-reach-the-filter.test.js` | 344 | 0 | 0 | 0 |  |
| `test/nwps-flood-context.test.js` | 208 | 0 | 0 | 0 | WHAT FLOODS AT WHAT STAGE, AND WHERE TODAY SITS AGAINST THIS GAUGE'S OWN RECORD. |
| `test/nwps-flow-units.test.js` | 72 | 0 | 0 | 0 | The unit that travels with the value, and nothing else. |
| `test/obs-bearing.test.js` | 82 | 0 | 0 | 0 | "WIND 5 MPH FROM 999°" |
| `test/operator-levels.test.js` | 217 | 0 | 0 | 0 | The three operators that publish HTML instead of JSON. |
| `test/persistence.test.js` | 142 | 0 | 0 | 0 | test/persistence.test.js — one persistence path, and a readiness check that can actually f |
| `test/plan-assemble.test.js` | 811 | 0 | 0 | 0 |  |
| `test/plan-candidates-poi-spots.test.js` | 253 | 0 | 0 | 0 | pois.geojson -> spot features. The layer that carries 17% of Wateree's near[] marks and th |
| `test/plan-depth-band.test.js` | 278 | 0 | 0 | 0 |  |
| `test/plan-export-reads-the-plan.test.js` | 283 | 0 | 0 | 0 |  |
| `test/plan-from-water.test.js` | 184 | 0 | 0 | 0 |  |
| `test/plan-issues.test.js` | 87 | 0 | 0 | 0 |  |
| `test/plan-pieces.test.js` | 140 | 0 | 0 | 0 |  |
| `test/plan-preflight.test.js` | 170 | 0 | 0 | 0 |  |
| `test/plan-prompt.test.js` | 496 | 0 | 0 | 0 |  |
| `test/plan-to-timeline.test.js` | 281 | 0 | 0 | 0 |  |
| `test/plan-tracks.test.js` | 422 | 0 | 0 | 0 |  |
| `test/plan-water-geometry.test.js` | 240 | 0 | 0 | 0 |  |
| `test/plan-water-state.test.js` | 250 | 0 | 0 | 0 | WHAT THE WATER IS DOING TODAY, and the two prompts it writes. |
| `test/plan-water.test.js` | 255 | 0 | 0 | 0 |  |
| `test/plan-weights.test.js` | 472 | 0 | 0 | 0 |  |
| `test/pressure-trend.test.js` | 91 | 0 | 0 | 0 | The barometer, and the eleven-day-old reading that made the staleness guard necessary. |
| `test/prompt-budget.test.js` | 73 | 0 | 0 | 0 | The prompt budget guard, which used to report success and do nothing. |
| `test/proxy-target-type.test.js` | 57 | 0 | 0 | 0 | Whether a proxy target is a PDF, and why the URL has to outrank the caller's type param. |
| `test/qdc-decoder.test.js` | 139 | 0 | 0 | 0 | Behaviour tests for the raw QDC reader and the contour engine on top of it. |
| `test/r2-gzip.test.js` | 149 | 0 | 0 | 0 | r2-gzip.test.js — the Worker must unwrap what the pipeline compresses. |
| `test/ramps-reach-research.test.js` | 56 | 0 | 0 | 0 | Why a 41,000-acre reservoir reported "ramps: 0". |
| `test/registry-catalog.test.js` | 66 | 0 | 0 | 0 | test/registry-catalog.test.js -- the registry may answer "what does this site publish", bu |
| `test/registry-grounding.test.js` | 189 | 0 | 0 | 0 | Ground the identity agent on 454 waters instead of 15. |
| `test/registry_smoke.mjs` | 225 | 0 | 0 | 0 | registry_smoke.mjs -- run the REAL lake_index.json through the REAL lake-registry.js and |
| `test/regulations-live.test.js` | 134 | 0 | 0 | 0 | A check that ran, said "I don't know", and showed nothing. |
| `test/regulations-matching.test.js` | 27 | 0 | 0 | 0 |  |
| `test/regulations-wiring.test.js` | 470 | 0 | 0 | 0 | regulations-wiring.test.js — the regulation digest actually reaches the agents |
| `test/research-discover-policy.test.js` | 88 | 0 | 0 | 0 |  |
| `test/research-ids.test.js` | 140 | 0 | 0 | 0 |  |
| `test/research-keys.test.js` | 108 | 0 | 0 | 0 |  |
| `test/research-reaches-the-plan.test.js` | 201 | 0 | 0 | 0 |  |
| `test/research-storage-keys.test.js` | 90 | 0 | 0 | 0 | Which key a lake's research profile is filed under. |
| `test/santee-cooper.test.js` | 202 | 0 | 0 | 0 | SANTEE COOPER PUBLISHES MORE THAN DUKE OR DOMINION, AND I TOLD RYAN FIVE TIMES IT PUBLISHE |
| `test/search-cascade.test.js` | 324 | 0 | 0 | 0 | FIVE OF SIX SEARCHES HAD NO FALLBACK AT ALL. |
| `test/shared-latest-pointer.test.js` | 214 | 0 | 0 | 0 | shared-latest-pointer.test.js — latest.json stopped being a second copy of the document. |
| `test/shared-pack.test.js` | 67 | 0 | 0 | 0 |  |
| `test/shared-store-cpu.test.js` | 88 | 0 | 0 | 0 | Tagging a document's sections, on a 10 ms CPU budget. |
| `test/silent-parameters.test.js` | 132 | 0 | 0 | 0 | THE THIRD STATE: a parameter a bound site PUBLISHES and did not answer with. |
| `test/site-catalog.test.js` | 75 | 0 | 0 | 0 | Which parameters a site actually publishes, instead of asking for twelve and seeing what |
| `test/smart-plan-coastal.test.js` | 200 | 0 | 0 | 0 |  |
| `test/smart-plan-route.test.js` | 92 | 0 | 0 | 0 |  |
| `test/smart-plan-v2.test.js` | 427 | 0 | 0 | 0 |  |
| `test/solunar.test.js` | 124 | 0 | 0 | 0 | test/solunar.test.js — one solunar model, and the two consumers cannot drift apart again. |
| `test/species-phase.test.js` | 103 | 0 | 0 | 0 | A stated rule instead of invented per-lake numbers. |
| `test/species-selector.test.js` | 138 | 0 | 0 | 0 |  |
| `test/stageflow-trend.test.js` | 84 | 0 | 0 | 0 | Which way the water has been going. |
| `test/structural-elements-contract.test.js` | 143 | 2 | 0 | **2** |  |
| `test/structure-from-pack.test.js` | 107 | 0 | 0 | 0 | Humps and ledges come from the pack, uncapped, not from the research profile. |
| `test/summary-agent.test.js` | 104 | 0 | 0 | 0 |  |
| `test/summary-builders-agree.test.js` | 123 | 0 | 0 | 0 |  |
| `test/supplemental-layer-registry.test.js` | 91 | 0 | 0 | 0 | test/supplemental-layer-registry.test.js — the last two hand-rolled layers stay migrated. |
| `test/surface-sample-dated.test.js` | 119 | 0 | 0 | 0 | AN AUGUST PLAN WAS BEING TOLD THE SURFACE WAS 43.88 DEGREES. |
| `test/sw-shell-freshness.test.js` | 67 | 0 | 0 | 0 | The app shell must not be answered from a cache minted five weeks ago. |
| `test/sync_smoke.mjs` | 121 | 0 | 0 | 0 | sync_smoke.mjs -- prove a deleted plan actually tombstones in the cloud. |
| `test/tackle-parity.test.js` | 242 | 0 | 0 | 0 |  |
| `test/template-literal-tdz.test.js` | 277 | 2 | 0 | 0 |  |
| `test/there-is-no-open-band.test.js` | 85 | 0 | 0 | 0 | THERE IS NO SUCH THING AS AN OPEN BAND. This file used to assert the opposite, at length. |
| `test/tide-engine.test.js` | 182 | 0 | 0 | 0 |  |
| `test/tva-reservoir.test.js` | 152 | 0 | 0 | 0 | TVA's four reservoir routes, shaped. |
| `test/usace-levels.test.js` | 170 | 0 | 0 | 0 | The Corps' conservation pool, evaluated for a date. |
| `test/usgs-dashboard.test.js` | 198 | 0 | 0 | 0 | TWO FACTS THIS APP HAD FOR SOME WATERS AND NOT OTHERS. |
| `test/usgs-gauges.test.js` | 108 | 0 | 0 | 0 |  |
| `test/usgs-series-pick.test.js` | 286 | 0 | 0 | 0 | WHEN A GAUGE HAS TWO SENSORS, WHICH ONE IS THE READING? |
| `test/water-aliases.test.js` | 126 | 0 | 0 | 0 |  |
| `test/water-cameras.test.js` | 144 | 0 | 0 | 0 | One camera roster, two questions, and they are not the same question. |
| `test/water-chain-loader.test.js` | 91 | 0 | 0 | 0 | The chain has to reach the Worker, and a missing object must not look like an empty chain. |
| `test/water-conditions.test.js` | 840 | 0 | 0 | 0 | One read for the state of the water. |
| `test/water-endpoints.test.js` | 305 | 0 | 0 | 0 | water-endpoints.test.js — the compute plane, pinned against the ways it has already broken |
| `test/water-filter.test.js` | 178 | 0 | 0 | 0 |  |
| `test/water-search.test.js` | 96 | 0 | 0 | 0 |  |
| `test/water-straighten.test.js` | 206 | 0 | 0 | 0 |  |
| `test/worker-auth.test.js` | 200 | 0 | 0 | 0 | test/worker-auth.test.js — writes to the Worker are gated, and the client can get through. |
| `test/worker-cors.test.js` | 44 | 0 | 0 | 0 |  |
| `test/worker-data.test.js` | 63 | 0 | 0 | 0 |  |
| `test/worker-external-imports.test.js` | 109 | 0 | 0 | 0 | test/worker-external-imports.test.js — the Worker bundle's reach outside Worker/. |
| `test/wqp-bbox.test.js` | 96 | 0 | 0 | 0 |  |
| `test/wqp-columns.test.js` | 123 | 0 | 0 | 0 | EVERY COLUMN limnology.js LOOKS UP HAS TO EXIST IN THE PROFILE IT ASKED FOR. |
| `test/wwa-hazards.test.js` | 157 | 0 | 0 | 0 | A BLANK IS A SPACE, A WATCH IS NOT A WARNING, AND `event` WAS NEVER AN EVENT. |
| `tools/audit.mjs` | 497 | 0 | 0 | 0 | tools/audit.mjs — generate the map of this codebase, from the codebase. |
| `tools/audit_duplication.mjs` | 159 | 0 | 0 | 0 | !/usr/bin/env node |
| `tools/audit_silent_catches.mjs` | 240 | 0 | 0 | 0 | !/usr/bin/env node |

### Modules nothing imports

- `Scripts/make_counties.mjs` — 49 lines, 0 exports
- `js/data/species-strategies.js` — 549 lines, 11 exports
- `js/modules/smart-plan-route.js` — 190 lines, 3 exports
- `sw.js` — 94 lines, 0 exports

### Exported but never imported by name

- `Worker/cameras.js`: frameStamp, frameUrls, handleCameraFrame, CAMERA_ROUTES
- `Worker/conditions.js`: dukeBasinWhy, CONDITIONS_ROUTES
- `Worker/core/arcgis.js`: fetchArcGisAllFeatures, getCachedGis
- `Worker/registry.js`: DAM_TABLE_KEY, NC_SPECIES_KEY, INDEX_TTL_S
- `Worker/reports.js`: REPORT_SOURCES, AHQ_HUBS, ARTICLE_MAX_AGE_DAYS, fetchReports
- `Worker/research/agency-pages.js`: AGENCY_INDEXES, agencyIndexEntries
- `Worker/research/agents.js`: COASTAL_AGENTS, COASTAL_AGENT_HINTS, COASTAL_SKIPPED_AGENTS, isCoastalZone, coastalAgentPlan
- `Worker/research/dataset.js`: DATASET_HUNT_TARGETS, DATASET_KEYWORDS, scoreDatasetUrl, buildNepisQueryVariants
- `Worker/research/facts-util.js`: normalizeResearchName, titleCaseWords, RESEARCH_SPECIES_CANON, canonicalizeResearchSpecies, NON_GAME_SPECIES, parseSCDNRDescriptionFacts, RESEARCH_RAMP_SOURCES, RESEARCH_ATTRACTOR_SOURCES, fetchArcGISGrouped, stripHtmlPreserveTables, extractHtmlTableRows, extractMarkdownTableRows, slicePdfPageRange, parseSCRegulationsFromHtml
- `Worker/research/keys.js`: legacyStorageName
- `Worker/research/shared.js`: SHARED_ENABLED_DEFAULT, sharedEnabled, contentFingerprint, urlToDocId, SECTION_HEADING_PREFIXES, CHUNK_SIZE, CHUNK_OVERLAP, segmentDocument, chunkText, CATEGORY_KEYWORDS, getSharedPointer, getSharedRegistryEntry, isQuarantined
- `Worker/water.js`: WATER_ROUTES
- `js/core/layer-registry.js`: setMapAccessor, hasLayer, layerIds, isEnabled, invalidate, _reset
- `js/core/map-init.js`: onMapClick, fillCoord, suggestName, startPick, clearPreview, showPreview
- `js/data/cameras.js`: NIMS_S3
- `js/data/fishing-style-profile.js`: isLiveBaitTechnique, isSaltwaterBait, isLiveBaitAvailable, canHoldStation
- `js/data/lure-knowledge.js`: getJigheadForDepth, getSpeedRange, getSeason, JIGHEADS_OWNED_OZ
- `js/data/research-ids.js`: stripLakeQualifiers
- `js/data/species-intel.js`: REGULATIONS, TOD, getTimeOfDay
- `js/data/species-strategies.js`: SPECIES_STRATEGIES, getStrategy, getPhaseDepth, getPresentationPriority, getPreferredStructure, getStrategySpeed, getStrategyNotes, getPhaseNotes, normalizeSpecies, getTimePhase, buildLureContext
- `js/data/tackle-inventory.js`: selectBestLure, getRecommendedSpeed
- `js/modules/capture-panel.js`: buildCapturePanel
- `js/modules/chart-import.js`: addContourLayer
- `js/modules/chart-mosaic.js`: addAffineChartLayer, chartsApi
- `js/modules/chart-overlay.js`: refreshChartOverlayTransforms
- `js/modules/coastal-layers.js`: refreshSoundingLabels, loadCoastalLayersForZone, clearCoastalLayers, getSoundingsNear, getCoastalLayerState
- `js/modules/coastal-scoring.js`: COASTAL_SPECIES
- `js/modules/conditions-strip.js`: showConditionsFor, refreshConditions
- `js/modules/contour-data.js`: getActiveContour, onContourChange, loadContourByR2Key, clearContourLabels, renderContourLayer, LAKE_NAME_TO_R2_KEY
- `js/modules/custom-vectors.js`: removeCustomVectorLayer, renderVectorList
- `js/modules/garmin-export.js`: exportGarminGPX
- `js/modules/gis-toggles.js`: getFishAttractors
- `js/modules/gps.js`: startGPS, stopGPS, wireGpsButtons
- `js/modules/lake-ramp-select.js`: STATE_ORDER, TYPE_ORDER, pickerLabel, stateOf, typeOf, passesFilters
- `js/modules/lake-research.js`: initLakeResearch, loadProfile, saveCurrentResearchProfile, populateResearchLakeDropdown, runFullPipeline, runResume
- `js/modules/layers-panel.js`: isOpen, close
- `js/modules/noaa-tides.js`: stageLabel
- `js/modules/notifications.js`: requestNotificationPermission, checkWindAlert, loadSessionFromSmartPlan, enableNotifications, disableNotifications
- `js/modules/plan-candidates.js`: AMPS_REF_MPH, AMPS_REF_A, AMPS_EXP, ampsAtMph, groupDocks, eligibleForHolding, sliceLine, catchSupport, pointToSegmentM
- `js/modules/plan-inputs.js`: normaliseHolding
- `js/modules/plan-pieces.js`: stretchCoords
- `js/modules/plan-preflight.js`: hourlyWeather, getSeason
- `js/modules/plan-prompt.js`: SIDES
- `js/modules/plan-to-timeline.js`: markMi
- `js/modules/plan-tracks.js`: stopName
- `js/modules/plan-water-ui.js`: findWater, pickedWater, buildFromPicked
- `js/modules/ramps.js`: toggleRampLayer, buildRampLayer, toggleChartLayersPanel
- `js/modules/smart-plan-route.js`: requestPlan, renderPlan, describePlan
- `js/modules/smart-plan-ui.js`: reelForLure, buildUnifiedTimeline, assignRouteRods
- `js/modules/smart-plan-v2-wiring.js`: runSmartPlanV2, wireSmartPlanV2, depthBandFor, usableAhFrom
- `js/modules/species-selector.js`: refreshSpeciesChecks
- `js/modules/spread-builder.js`: ROD_PRESETS, REEL_PRESETS, COLOR_PRESETS, ARIG_WEIGHTS, JIGHEAD_WEIGHTS, TRAILER_SIZES, jigheadForRod, depthWindow, leadForDepth, isLeadControlled
- `js/modules/supplemental-layers.js`: getStructureGeoJSON, getDepthAreaGeoJSON, getLakeBoundaryGeoJSON, bringDepthAreasToBack, redrawDepthAreas, loadSupplementalForLake, getSupplementalContext, refreshDepthAreaColors, getOsmStructures, LAKE_NAME_TO_R2_KEY, resolveR2Key
- `js/modules/usgs-gauges.js`: fetchCurrentDischarge, fetchMeanDischarge, assessSite
- `js/utils/cameras.js`: kmBetween, FRAME_TTL_MS
- `js/utils/geo.js`: distMiFromCoords, bearing, bearingFromCoords, destination, distToRingFt, ftToDegLat, ftToDegLon, parseCoord
- `js/utils/viewport-cull.js`: featureBBox
- `test/lake-picker-groups.test.js`: pickerLabel
- `test/structural-elements-contract.test.js`: humpsFromPack, ledgesFromPack

## Same function name in more than one file

- `walk()` — js/utils/viewport-cull.js:20, test/check-imports.mjs:48, test/data-reaches-the-app.test.js:34, test/hand-written-tables.test.js:257, test/persistence.test.js:27, test/worker-auth.test.js:29, test/worker-external-imports.test.js:43, tools/audit.mjs:56, tools/audit_duplication.mjs:73, tools/audit_silent_catches.mjs:189
- `wireButtons()` — js/modules/catch-journal.js:1378, js/modules/chart-mosaic.js:390, js/modules/chart-overlay.js:387, js/modules/edit.js:236, js/modules/file-io.js:51, js/modules/ramps.js:137, js/modules/saved-spreads.js:73, js/modules/spread-builder.js:335, js/modules/topbar.js:9
- `init()` — js/modules/coastal-layers.js:300, js/modules/gis-toggles.js:263, js/modules/layers-panel.js:70, js/modules/routes-panel.js:131, js/modules/species-selector.js:278, js/modules/supplemental-layers.js:1395
- `run()` — test/conditions-bindings.test.js:235, test/plan-weights.test.js:103, test/plan-weights.test.js:155, test/silent-parameters.test.js:76, test/smart-plan-v2.test.js:19
- `cacheGet()` — Worker/water.js:47, js/modules/tide-engine.js:27, js/modules/usgs-gauges.js:28, js/utils/db.js:273
- `cacheSet()` — Worker/water.js:55, js/modules/tide-engine.js:37, js/modules/usgs-gauges.js:35, js/utils/db.js:288
- `getMap()` — js/modules/coastal-layers.js:36, js/modules/gis-toggles.js:16, js/modules/osm-structure.js:40, js/modules/supplemental-layers.js:173
- `mapReady()` — js/modules/coastal-layers.js:38, js/modules/gis-toggles.js:20, js/modules/osm-structure.js:42, js/modules/supplemental-layers.js:175
- `say()` — js/modules/lake-intel.js:20, js/modules/lake-intel.js:260, js/modules/noaa-tides.js:77, js/modules/utility-sync.js:25
- `esc()` — js/modules/conditions-strip.js:72, js/modules/lake-research-ui.js:354, js/utils/escape.js:1
- `wire()` — js/modules/conditions-strip.js:669, js/modules/lake-ramp-select.js:593, js/modules/noaa-tides.js:64
- `withFetch()` — test/credit-guards.test.js:26, test/cwms-series.test.js:194, test/usgs-series-pick.test.js:20
- `leg()` — test/plan-assemble.test.js:26, test/plan-export-reads-the-plan.test.js:28, test/plan-tracks.test.js:28
- `json()` — Worker/cameras.js:48, Worker/water.js:61
- `cached()` — Worker/conditions.js:87, Worker/reports.js:471
- `getJson()` — Worker/conditions.js:98, js/modules/usgs-gauges.js:84
- `getText()` — Worker/conditions.js:104, Worker/research/agency-pages.js:164
- `kmBetween()` — Worker/conditions.js:595, js/utils/cameras.js:40
- `sampleDated()` — Worker/research/facts-util.js:665, js/modules/lake-research-engine.js:339
- `sanitizeLakeId()` — Worker/research/keys.js:1, js/data/research-ids.js:1
- `stripLakeQualifiers()` — Worker/research/keys.js:22, js/data/research-ids.js:56
- `researchStorageId()` — Worker/research/keys.js:74, js/data/research-ids.js:50
- `legacyStorageName()` — Worker/research/keys.js:95, js/data/research-ids.js:67
- `researchStorageIdCandidates()` — Worker/research/keys.js:112, js/data/research-ids.js:77
- `resolveLakeKey()` — Worker/trollmap-worker.js:428, js/data/species-intel.js:87
- `isEnabled()` — js/core/layer-registry.js:97, js/modules/notifications.js:460
- `toggle()` — js/core/layer-registry.js:167, js/modules/layers-panel.js:68
- `getWorkerBase()` — js/data/access-index.js:73, js/modules/gis-toggles.js:51
- `formatAccessLabel()` — js/data/access-index.js:360, js/modules/lake-ramp-select.js:328
- `getSeason()` — js/data/lure-knowledge.js:740, js/data/species-intel.js:66
- `openDB()` — js/data/tackle-inventory.js:249, js/utils/db.js:28
- `normalizeRows()` — js/lazy-data.js:1, js/modules/gis-toggles.js:47
- `row()` — js/modules/conditions-strip.js:98, js/modules/plan-water-ui.js:215
- `paint()` — js/modules/conditions-strip.js:587, js/modules/plan-water-ui.js:464
- `setAtPath()` — js/modules/lake-research-engine.js:1222, js/modules/lake-research-ui.js:66
- `put()` — js/modules/plan-builder.js:2276, js/utils/db.js:113
- `norm()` — js/modules/supplemental-layers.js:703, js/modules/water-search.js:42
- `depthColor()` — js/utils/depth-palette.js:50, js/utils/geo.js:279
- `fakeMap()` — test/coastal-landing.test.js:4, test/layer-registry.test.js:26
- `fakeKV()` — test/credit-guards.test.js:14, test/regulations-wiring.test.js:99

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
| `window.__smartPlanV2Owns` | js/modules/smart-plan-v2-wiring.js | **nothing** |
| `window._groqPlanTimeline` | — | js/modules/plan-builder.js |
| `window._osmActiveLakeKey` | js/modules/supplemental-layers.js | js/modules/osm-structure.js |
| `window._planV2` | js/modules/plan-water-ui.js<br>js/modules/smart-plan-v2-wiring.js<br>test/plan-export-reads-the-plan.test.js | js/modules/plan-builder.js<br>test/plan-export-reads-the-plan.test.js |
| `window._planV2Gpx` | js/modules/plan-water-ui.js<br>js/modules/smart-plan-v2-wiring.js | **nothing** |
| `window._planV2NoGo` | js/modules/smart-plan-v2-wiring.js | **nothing** |
| `window._planV2Result` | js/modules/plan-water-ui.js<br>js/modules/smart-plan-v2-wiring.js | **nothing** |
| `window._seedOsmStructureData` | js/modules/supplemental-layers.js | **nothing** |
| `window._smartPlanCastRods` | — | js/modules/plan-builder.js |
| `window._smartPlanPhaseRoutes` | js/modules/plan-builder.js | js/modules/notifications.js<br>js/modules/plan-builder.js |
| `window._smartPlanRationale` | — | js/modules/plan-builder.js |
| `window._smartPlanRouteRods` | js/modules/smart-plan-ui.js | js/modules/plan-builder.js |
| `window._smartPlanRouteSpeeds` | js/modules/smart-plan-ui.js | js/modules/plan-builder.js |
| `window._smartPlanRunId` | js/modules/smart-plan-route.js | **nothing** |
| `window._smartPlanSolunar` | test/solunar.test.js | **nothing** |
| `window._smartPlanStopCandidates` | js/modules/smart-plan-ui.js | js/modules/plan-builder.js |
| `window._smartPlanTimeline` | js/modules/smart-plan-ui.js | js/modules/plan-builder.js<br>js/modules/smart-plan-ui.js |
| `window._smartRouteGeoJSON` | js/modules/contour-data.js | **nothing** |
| `window._spEditRod` | js/modules/smart-plan-ui.js | js/modules/smart-plan-ui.js |
| `window._trollmapPhases` | — | js/modules/notifications.js |
| `window._trollmapSolunar` | js/modules/plan-builder.js | js/modules/notifications.js<br>test/solunar.test.js |
| `window._trollmapTide` | js/modules/noaa-tides.js<br>js/modules/supplemental-layers.js | js/modules/noaa-tides.js<br>js/modules/supplemental-layers.js |

## Pipeline scripts

| script | flags | purpose |
|---|---|---|
| `Scripts/apply_drawn_coast.py` | --registry --lines --cell-m --only --go | !/usr/bin/env python3 |
| `Scripts/area_audit.py` | — | !/usr/bin/env python3 |
| `Scripts/attach_arms.py` | --worklist --gpkg --boundaries --slug --max-overlap --pad-km --go | !/usr/bin/env python3 |
| `Scripts/audit_boundary_rings.py` | --registry --boundaries --fix --min-cover --min-mine --max-drift --min-pct --only | !/usr/bin/env python3 |
| `Scripts/audit_packs.py` | --packs --registry --report --baseline --tolerance --strict --min-samples --min-off --only --limit -v | audit_packs.py - is the pipeline making the packs better or worse? |
| `Scripts/audit_packs_vs_extract.py` | --extract --packs --registry --map --min-vertices --top | !/usr/bin/env python3 |
| `Scripts/audit_research_fields.py` | --repo --profiles --worker --profile-cache --refresh-profiles --out --show | !/usr/bin/env python3 |
| `Scripts/audit_scripts.py` | --dir --manifest --sort --go --files | audit_scripts.py — which of the 239 scripts in scripts/ are still load-bearing. |
| `Scripts/audit_upstream_fields.py` | --repo --capture --dir --out --exclude --decisions --show-decided --self-test | audit_upstream_fields.py -- WHAT DOES THE UPSTREAM SEND THAT NOTHING IN THIS REPO READS? |
| `Scripts/bind_dams_to_waters.py` | --registry --dams --max-km --tolerance --owner --json | bind_dams_to_waters.py -- bind USACE dams to registry waters by WHERE THEY ARE, and make each |
| `Scripts/bind_operator_lakes.py` | --registry --pagesrc --write | bind_operator_lakes.py -- attach utility-operator level feeds to registry slugs. |
| `Scripts/boundary_from_3dhp.py` | --gpkg --id --slug --name --state --out-dir --dry-run | boundary_from_3dhp.py -- a registry boundary from a 3DHP id, with no name matching anywhere. |
| `Scripts/boundary_gaps.py` | --gpkg --coverage --boundaries --out --bbox --min-acres --gap | boundary_gaps.py -- shipped packs that are missing an arm of their own lake. |
| `Scripts/build_all_chartpacks.py` | --extract --registry --map --out --report --buffer-m --states --min-charted --only-layers --limit --only-tiles --ship-list --require-depth-area --report-only --only-lakes --keep-zoom --max-segment-m | !/usr/bin/env python3 |
| `Scripts/build_camera_index.py` | --registry --app --margin-km --raw | build_camera_index.py - bake a footprint-only USGS NIMS camera index. |
| `Scripts/build_chartpack.py` | --extract --key --bbox --boundary --buffer-m --ac --out --archive | build_chartpack.py - turn per-tile extractor output into one lake's R2 chartpack. |
| `Scripts/build_coverage_cache.py` | --extract --out --region --force | !/usr/bin/env python3 |
| `Scripts/build_dnr_ramps_by_lake.py` | --registry --state --tol-m --from-dump --no-geometry --compare --curated-report --self-test --go | !/usr/bin/env python3 |
| `Scripts/build_duke_dam_table.py` | --registry --json | build_duke_dam_table.py -- which Duke powerhouse forms which water, checked against evidence. |
| `Scripts/build_garmin_water_inventory.py` | --extract --out --geojson-dir --tol --box-frac --min-acres --zoom --at --radius-km --index --region-mask --no-region --max-boxiness --coverage --min-da-share --boundaries --arm-km | !/usr/bin/env python3 |
| `Scripts/build_lake_drainage.py` | --registry --min-order --max-reaches --no-reaches --out --only --limit --min-acres -v | build_lake_drainage.py - derive each lake's catchment, and with it how fast it stains. |
| `Scripts/build_lake_rivers.py` | --gpkg --registry --out --min-share --max-names --pad-km --only --limit --index-only | !/usr/bin/env python3 |
| `Scripts/build_nc_species_by_lake.py` | --registry --areas --out --cache --sleep --refresh --date --go | !/usr/bin/env python3 |
| `Scripts/build_structure.py` | --packs --registry --force --report --only-lakes --limit --ship-only --min-score | build_structure.py - humps, ledges and slope for every lake, from geometry alone. |
| `Scripts/build_trolling_runs.py` | --packs --min-len-m --simplify-m --reach-m --annotate-m --chord-m --chord-tol-dm --chord-samples --only --only-lakes --force --jobs --report --registry --ship-only | build_trolling_runs.py - turn stored contour fragments into runs a boat can actually troll. |
| `Scripts/build_water_advisories.py` | --registry --key --cycle --out -v | build_water_advisories.py - EPA ATTAINS impairments, bound to waters CONSERVATIVELY. |
| `Scripts/build_water_bindings.py` | --registry --cache --out --report --review-out --lake-rivers --overrides --stage --margin-km --force --pause | build_water_bindings.py - bind every water in the registry to its gauges and operator. |
| `Scripts/build_water_chain.py` | --nhd --registry --out --bindings --no-bindings --links --no-links --only --write --show --layers | build_water_chain.py -- work out which of Ryan's waters sit above which, from NHDPlus HR, |
| `Scripts/build_water_features.py` | --packs --relief-m --curve-m --probe-m --min-bulge-m --sep-m --mouth-m --annotate-m --only --only-lakes --force --report --registry --ship-only | build_water_features.py - derive the structure types the fishing intel actually asks for. |
| `Scripts/build_water_graphs.py` | --tiles --registry --map --out --layer --seam-m --buffer-m --only-lakes --force --limit --report | build_water_graphs.py - a routing graph over navigable water, one per lake. |
| `Scripts/build_water_names.py` | --registry --out --go | !/usr/bin/env python3 |
| `Scripts/capture_upstreams.py` | --repo --registry --out --water --host --subst --timeout --list --all --self-test | capture_upstreams.py -- find every upstream URL IN THE CODE, fill in its holes, fetch it, save |
| `Scripts/chart_currency.py` | --manifest --against --pattern --registry --only-mine --ship-list | !/usr/bin/env python3 |
| `Scripts/check_body_is_one_water.py` | --extract --index --bodies --slug-file --out --cell-m --lat-ref --min-cells --max-tiles --resume | !/usr/bin/env python3 |
| `Scripts/check_garmin_bathymetry.py` | --extract --bodies --index --slugs --slug-file --out --max-tiles --resume | !/usr/bin/env python3 |
| `Scripts/check_pipeline_parity.py` | — | check_pipeline_parity.py — the lists that must agree, checked before a build. |
| `Scripts/check_registry_invariants.py` | --registry --spread-factor --quiet --map --source --report | !/usr/bin/env python3 |
| `Scripts/check_start_here.py` | --root --repo --facts --bless --list | !/usr/bin/env python3 |
| `Scripts/classify_salt_fresh.py` | --line --feeds --self-test --show | !/usr/bin/env python3 |
| `Scripts/coastal_catalog.py` | — | coastal_catalog.py — TrollMap coastal/tidal zone definitions for SC, GA, and NC. |
| `Scripts/compare_index_names.py` | --before --after --show | !/usr/bin/env python3 |
| `Scripts/consolidate_lake_index.py` | --registry --charted --out --states --max-km --keep-unbuildable --packs --keep-closed --min-charted --keep-unnamed --keep-packless --region-mask --ship-keep --no-region --ship-list --tile-list --dropped-report --names --aliases --counties | consolidate_lake_index.py - fold every lake list in the app into ONE record per lake. |
| `Scripts/cut_boundaries_batch.py` | --worklist --gpkg --registry --stage --legacy --pad-km --kinds --extract --labels --no-gate --gate-report --limit --dry-run | !/usr/bin/env python3 |
| `Scripts/deep_lakes.py` | --packs --index --all --csv | !/usr/bin/env python3 |
| `Scripts/derive_waterbodies.py` | --tiles --out --cell-m --min-cells --per-feature --lat-ref --jobs --limit --force | derive_waterbodies.py — find the lakes from the CONTOURS, not from a boundary file. |
| `Scripts/derived_bboxes.py` | — | Generated by trollmap_bbox_derivation.py |
| `Scripts/diagnose_mar_adj.py` | --tiles --registry --lake --layer --max-tiles | !/usr/bin/env python3 |
| `Scripts/dump_lbl_pool.py` | --navaids-only --walk --limit | dump_lbl_pool.py - print a GMP tile's label pool as plain text. |
| `Scripts/extract_coastal_habitat.py` | --zone --zones --dry-run --no-gzip --skip-upload --list-layers | extract_coastal_habitat.py — Extract and clip coastal habitat data to TrollMap |
| `Scripts/fetch_dnr_paddle.py` | --state --out --stdout --compare | !/usr/bin/env python3 |
| `Scripts/fetch_osm_coastal.py` | --zone --dry-run --list | fetch_osm_coastal.py — Extracts fishing-relevant OSM structures for TrollMap |
| `Scripts/fetch_osm_structures.py` | --lake --dry-run --no-gzip --list --out-dir --no-local --catalog-only --from-cache --jobs --index --pbf --keep-tmp | !/usr/bin/env python3 |
| `Scripts/find_affected_tiles.py` | --extract --map --out --limit | Which tiles must be re-extracted after the 2026-08-21 depth fixes, and which lakes rebuilt. |
| `Scripts/find_duplicate_waters.py` | --registry --pad --min-box --engine --json | find_duplicate_waters.py -- find registry waters that are the same water under two slugs. |
| `Scripts/find_r2_orphans.py` | --packs --manifest --out --quiet-seconds --force | find_r2_orphans.py -- list R2 objects whose local file is gone, and REFUSE to do it if the |
| `Scripts/fit_trolling_runs.py` | --packs --only --ship-only --registry --max-turn-deg --min-leg-m --min-fit-m --min-stretch-m --resample-m --max-pts --grid-m --max-cells --safety-cells --deep-bias-m --deep-bridge-m --deep-bridge-dm --bridge-m --bridge-dm --seed-push-m --tol-dm --ceiling-dm --iters --only-lakes --jobs --envelope-m --envelope-step-m --annotate-m --reach-m --backup-dir --limit --refit --dry-run --report | fit_trolling_runs.py - turn stitched contours into lines a boat can actually be steered along. |
| `Scripts/gen_coastal_zones_js.py` | — | !/usr/bin/env python3 |
| `Scripts/gen_water_aliases_js.py` | --dir --index --lake-keys --registry-boundaries --out --check | !/usr/bin/env python3 |
| `Scripts/geomcore.py` | — | Overlap measurement for find_duplicate_waters.py, fastest available engine first. |
| `Scripts/gmapmf_areas_v51.py` | — | GMAPMF area-region (RGN1) record walk. B2, 2026-08-01, partial. |
| `Scripts/gmapmf_decode_v40.py` | --out --level | !/usr/bin/env python3 |
| `Scripts/gmapmf_labels_v50.py` | — | !/usr/bin/env python3 |
| `Scripts/gmapmf_lines_v50.py` | — | GMAPMF line-region decoder v50 -- chain by closure, tag-priority records. |
| `Scripts/gmapmf_mar_v1.py` | — | GARMIN NGSR MAR reader — the auto-guidance safe-water mesh that ships |
| `Scripts/gmapmf_regions_v51.py` | — | Tile-level decoders for the LINE and AREA regions, on the corrected framing. |
| `Scripts/id_unclaimed_water.py` | --in --out --gpkg --index --radius --grid --min-acres --flow-m --min-cover --min-da --allow-no-da --include-attached --include-narrow --limit | !/usr/bin/env python3 |
| `Scripts/in_region.py` | --mask --check --audit-registry --index --boundaries --out | !/usr/bin/env python3 |
| `Scripts/index_waterbodies.py` | --src --out --threads --resume | index_waterbodies.py — reduce the 100 GB waterbodies_named/ folder to a ~10 MB index. |
| `Scripts/install_registry_boundary.py` | --registry --boundaries --labels --lake --from-tsv --state --name --go | !/usr/bin/env python3 |
| `Scripts/lake_catalog.py` | — | !/usr/bin/env python3 |
| `Scripts/lookup_3dhp.py` | --gpkg --near --radius --gnis --name --limit | lookup_3dhp.py -- ask the 3DHP GeoPackage what it knows about a water. |
| `Scripts/make_coastal_boundaries.py` | --catalog --out --only --go | !/usr/bin/env python3 |
| `Scripts/make_key_map.py` | --lake-keys --slugs --out --max-km | make_key_map.py - decide which R2 key each registry lake writes to, BEFORE anything uploads. |
| `Scripts/make_osm_ramps_by_lake.py` | --registry --ramps --margin-m --go | !/usr/bin/env python3 |
| `Scripts/make_region_mask.py` | --shp --out --states --cell --pad-km --poly --label | !/usr/bin/env python3 |
| `Scripts/make_river_boundaries.py` | --gpkg --feeds --out --sidecars --index --only --narrow-region --flowing-only --ramp-tol --join-tol --no-split --salt-line --catalog --coastal-slack-km --extract --garmin-cache --max-reach-km --pad-km --min-km2 --lakes --go | !/usr/bin/env python3 |
| `Scripts/mar_route.py` | — | mar_route.py - turn a MAR layer into a navigable-water routing graph and route on it. |
| `Scripts/match_waters_to_nhd.py` | --registry --nhd --only --gdb --min-overlap --min-area-ratio --json | match_waters_to_nhd.py -- bind registry waters to NHD waterbodies by the ground they cover, |
| `Scripts/merge_ac_pois.py` | --packs --registry --db --only-lakes --radius-m --list --dry-run | !/usr/bin/env python3 |
| `Scripts/merge_duplicate_waters.py` | --registry --decisions --bindings --tab --write | merge_duplicate_waters.py -- fold one registry water into another, from an explicit decision |
| `Scripts/migrate_merged_slugs.py` | --registry --decisions --include-derived --fold --values --boundaries --adopt-min-cover --write | migrate_merged_slugs.py -- carry a merge through every registry sidecar keyed by slug. |
| `Scripts/missing_waterbodies.py` | --gpkg --coverage --claimed --out --index --bbox --min-acres --max-acres --min-charted --featuretype | missing_waterbodies.py -- 3DHP polygons that have no registry boundary, and do have soundings. |
| `Scripts/name_from_garmin.py` | --boundaries --labels --pois --registry --slug --unregistered --mode --near-km --generic-pct --label-cache --tsv | !/usr/bin/env python3 |
| `Scripts/name_waterbodies.py` | --waterbodies --gpkg --out --min-area-km2 --geom-min-km2 --jobs --batch --limit --named-only | !/usr/bin/env python3 |
| `Scripts/nhd_near.py` | --near --radius --gdb --layers --out | !/usr/bin/env python3 |
| `Scripts/osm_ramps.py` | --pbf --out | !/usr/bin/env python3 |
| `Scripts/pack_stamp.py` | — | !/usr/bin/env python3 |
| `Scripts/poi_audit.py` | — | !/usr/bin/env python3 |
| `Scripts/poi_source_compare.py` | --garmin --iboating --out --radius-m --verbose | poi_source_compare.py - does Garmin already have i-Boating's POIs? |
| `Scripts/probe_cwms_catalog.py` | --registry --offices --page-size --timeout --max-pages --self-test | probe_cwms_catalog.py -- what does the Corps actually publish, and for which of OUR waters? |
| `Scripts/probe_ndbc_stations.py` | --registry --jobs --timeout --rows --self-test | probe_ndbc_stations.py -- which of the bound NWS gauge ids are ALSO live NDBC weather stations? |
| `Scripts/probe_nhd_vaa.py` | --gdb --top | probe_nhd_vaa.py -- read-only look at one NHDPlus HR geodatabase. |
| `Scripts/probe_nwps_bulk.py` | --csv --registry --cache --out --keep-csv --self-test | probe_nwps_bulk.py -- one download against 371, and it carries more than the 371 did. |
| `Scripts/prune_r2_keys.py` | --key-map --packs --dry-run --go --force | !/usr/bin/env python3 |
| `Scripts/prune_r2_objects.py` | --list --go --stop-on-error | prune_r2_objects.py — delete an EXPLICIT list of R2 keys, one per line. |
| `Scripts/pull_usgs_current_conditions.py` | --registry --top --timeout --all-params --bbox --since --from-file --self-test | pull_usgs_current_conditions.py -- ONE request for every live water-quality reading, then join |
| `Scripts/pull_usgs_dashboard.py` | --collection --registry --top --timeout --params --layer --bbox --since --day --from-file --self-test | pull_usgs_dashboard.py -- the USGS National Water Dashboard's OData service, all four useful |
| `Scripts/r2_audit.py` | --worker --from --save --delete-list --registry --propose-unoffered --packs --js | r2_audit.py — what is actually in the R2 bucket, and what of it can go. |
| `Scripts/r2_gzip.py` | — | !/usr/bin/env python3 |
| `Scripts/r2_vs_local.py` | --packs --listing --max-age-h --out --show --no-drive-scan --reindex --index-age-h | !/usr/bin/env python3 |
| `Scripts/reclaim_packs.py` | --packs --registry --report --only-lakes --list --dry-run | !/usr/bin/env python3 |
| `Scripts/recompute_charted.py` | --packs --registry --report --buffer-m --no-prune | recompute_charted.py - fix the charted fraction from the BUILT packs. No rebuild. |
| `Scripts/remeasure_boundaries.py` | --registry --lake --from-tsv --tolerance-deg --area-tolerance-pct --go | !/usr/bin/env python3 |
| `Scripts/remove_registry_water.py` | --slugs --registry --reason --date --go | !/usr/bin/env python3 |
| `Scripts/resolve_feature_types.py` | --gpkg --registry --staging --index --state --out | !/usr/bin/env python3 |
| `Scripts/restore_originals.py` | --packs --backup-dir --write --only | restore_originals.py -- put every pack back to its ORIGINAL contour geometry. |
| `Scripts/rgn4_grammar.py` | — | !/usr/bin/env python3 |
| `Scripts/rgn4_pois.py` | --out | rgn4_pois.py - the POI stage. Every labelled RGN4 point, correctly placed. |
| `Scripts/show_missing_water.py` | --slug --registry --nhd --out --top --min-draw | !/usr/bin/env python3 |
| `Scripts/split_merged_boundaries.py` | --registry --only --spread-factor --report --go | !/usr/bin/env python3 |
| `Scripts/suggest_name_aliases.py` | --registry --max-edits --min-key --write | !/usr/bin/env python3 |
| `Scripts/sweep_unclaimed.py` | --coverage --boundaries --claimed --out --min-acres --max-acres --index --near-km --min-da --near-cells --min-fill --region-mask --no-region --allow-no-da --report | sweep_unclaimed.py -- Garmin bathymetry that belongs to no water we know about. |
| `Scripts/test_audit_boundary_rings.py` | — | audit_boundary_rings.py -- does it find a flattened boundary, repair it, and leave alone |
| `Scripts/test_bind_dams.py` | — | Unit tests for bind_dams_to_waters, plus an end-to-end run against a synthetic registry. |
| `Scripts/test_bind_operator_lakes.py` | — | Synthetic end-to-end test for bind_operator_lakes.py. |
| `Scripts/test_boundary_3dhp_rings.py` | — | boundary_from_3dhp.py: does a hole survive the read and reach the GeoJSON. |
| `Scripts/test_build_water_bindings_parms.py` | — | test_build_water_bindings_parms.py -- pins what a bound USGS site records about itself. |
| `Scripts/test_build_water_chain.py` | — | Exercise build_water_chain's real functions -- imported from the shipped file, not copies. |
| `Scripts/test_coastal_exclusion.py` | — | A coastal zone must not carry a water that owns its own boundary. |
| `Scripts/test_consolidate_merge_gate.py` | — | consolidate_lake_index.py -- a merged-away slug must not come back. |
| `Scripts/test_coverage_cache.py` | — | Synthetic end-to-end test for build_coverage_cache.py. Known answers, asserted. |
| `Scripts/test_find_duplicates.py` | — | Registry-level tests for find_duplicate_waters.py. Geometry maths lives in test_geomcore.py. |
| `Scripts/test_garmin_inventory.py` | — | Synthetic end-to-end test for build_garmin_water_inventory.py. |
| `Scripts/test_geomcore.py` | — |  |
| `Scripts/test_hucs_for.py` | — | hucs_for(): the binding decides the basin, the table is only a fallback. |
| `Scripts/test_id_unclaimed.py` | — | Synthetic end-to-end test for id_unclaimed_water.py. Known answers, asserted. |
| `Scripts/test_make_osm_ramps_by_lake.py` | — | A retired slug must not outbid the keeper it was merged into. |
| `Scripts/test_match_nhd_partial_write.py` | — | !/usr/bin/env python3 |
| `Scripts/test_match_waters.py` | — | Drives match_waters_to_nhd.py against a REAL geodatabase read by REAL pyogrio. |
| `Scripts/test_merge_region_access.py` | — | A coastal zone must not inherit a creek's access classification. |
| `Scripts/test_merge_waters.py` | — |  |
| `Scripts/test_migrate_slugs.py` | — |  |
| `Scripts/test_no_literal_percent.py` | — | !/usr/bin/env python3 |
| `Scripts/test_process_vpu.py` | — | End-to-end test of process_vpu with a fake pyogrio, so the function that actually |
| `Scripts/test_prune_report.py` | — | test_prune_report.py -- the report prune_r2_objects.py did not write. |
| `Scripts/test_r2_audit_coastal_tier.py` | — | An empty COASTAL_PRIMARY means the tier is OFF, not that nothing qualifies. |
| `Scripts/test_r2_audit_retired.py` | — | RETIRED_PACK_FILES in r2_audit.py: dead by name, and it has to outrank the app veto. |
| `Scripts/test_r2_audit_unoffered.py` | — | The index rule in r2_audit.py: off by default, and it cannot fire on a bad read. |
| `Scripts/test_region_mask.py` | — | Synthetic end-to-end test for make_region_mask.py + in_region.py. Known answers, asserted. |
| `Scripts/test_remove_registry_water.py` | — | !/usr/bin/env python3 |
| `Scripts/test_show_missing_water.py` | — | The parts of show_missing_water.py that do not need a geodatabase. |
| `Scripts/test_slim_registry.py` | — | What ships in _registry/lakes.json, and what does not. |
| `Scripts/test_sweep_gates.py` | — | Synthetic end-to-end test for the two gates added to sweep_unclaimed.py: |
| `Scripts/test_trim_at_salt_line.py` | — | trim_at_salt_line.py, on geometry small enough to check by eye. |
| `Scripts/tests/test_charted.py` | — | test_charted.py — a shoreline outline is not a survey. |
| `Scripts/tests/test_chording.py` | — | test_chording.py — the shortcut must cut the cove and refuse the point. |
| `Scripts/tile_lake_map.py` | --labels --registry --out --states --index --accessible-only --tiles-out | tile_lake_map.py - which GMP tiles cover which registry lakes, and vice versa. |
| `Scripts/triage_water_bindings.py` | --registry --out --accept-all-singles --accept | !/usr/bin/env python3 |
| `Scripts/trim_at_salt_line.py` | --boundaries --slug --line --out --go | !/usr/bin/env python3 |
| `Scripts/trim_pack_strays.py` | --chartpack --boundaries --buffer-m --lake --state-file --seconds --go | !/usr/bin/env python3 |
| `Scripts/trollmap_extract_all.py` | --out --layers --letters --jobs --limit --tiles --zoom0-only --min-area --force --gzip | trollmap_extract_all.py - ONE pass over a Garmin GMAPMF tile (or the whole card) that |
| `Scripts/trollmap_lake_boundaries.py` | --lake --list --overwrite --dump-names | trollmap_lake_boundaries.py - Extract lake boundaries from USGS 3DHP GeoPackage |
| `Scripts/trollmap_nhd_boundaries.py` | --lake --overwrite --dump-names --list | trollmap_nhd_boundaries.py — Extract lake boundaries from NHDPlus HR GDB files |
| `Scripts/trollmap_pipeline.py` | --output --lake --zooms --max-cove-dist --min-features | trollmap_pipeline.py — Unified TrollMap Extraction Pipeline |
| `Scripts/trollmap_pipeline_coastal.py` | --output --zone --zooms --contours-only --max-cove-dist --min-features | trollmap_pipeline_coastal.py — TrollMap Coastal Zone Extraction Pipeline |
| `Scripts/trollmap_r2_clean.py` | --all --contours --supplemental --boundaries --dry-run --list | trollmap_r2_clean.py — Wipe TrollMap R2 data using Cloudflare API. |
| `Scripts/upload_garmin_to_r2.py` | --root --layers --all --lake --prefix --jobs --gzip --no-gzip --dry-run --force --manifest --timeout --boundaries --no-boundaries --index --all-packs --registry --with-pipeline-layers --coastal-primary --max-mb | upload_garmin_to_r2.py — push the Garmin-derived layers to R2, fast and resumably. |
| `Scripts/upload_to_r2.py` | --all --contours --supplemental --boundaries --lake --dry-run | upload_to_r2.py — Upload all TrollMap pipeline outputs to R2 in clean structure. |
| `Scripts/verify_registry_r2.py` | --registry --worker --prefix --timeout | verify_registry_r2.py -- are the three files the APP reads actually in R2, and are they current? |
| `Scripts/verify_river_boundaries.py` | --dir --overlap-report --max-gap-km | !/usr/bin/env python3 |
| `Scripts/wqp_clarity_coverage.py` | --registry --out --states --characteristic --since --min-acres --timeout | wqp_clarity_coverage.py - which of our lakes actually have a clarity measurement. |
| `Scripts/zone_coverage.py` | --catalog --feeds --line --out | !/usr/bin/env python3 |
| `test/verify_grokipedia_windows.py` | — | Windows-friendly Python test for Grokipedia/Wikipedia citation extraction |
