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
| files | 708 |
| jsModules | 415 |
| pyScripts | 287 |
| routes | 57 |
| routesUncalled | 0 |
| routesMutatingUngated | 18 |
| feeds | 139 |
| deadExports | 185 |
| orphanModules | 7 |
| duplicateFnNames | 50 |
| crossModuleGlobals | 39 |
| unresolvedImports | 0 |

## Worker routes

**The `hosts near` column is PROXIMITY, NOT A CALL GRAPH.** It is every outbound URL literal
within 3,000 characters of the route match, first three shown. Measured 2026-09-17: bounding it
to the route's own handler instead drops 32 host entries to 13, because the arcgis URLs are in
shared constants that the handlers reach through helpers -- so the narrow answer is EMPTY for
`/ramps`, which certainly does fetch them. Neither window can follow a helper call. Read this
column as "arcgis is reachable from around here", never as "this route fetches that".

| route | method | auth | hosts near | R2 | called from |
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
| `/lake-clarity` | ANY | open | — | — | lake-intel.js<br>plan-preflight.js |
| `/lake-intel` | ANY | open | — | — | main.js<br>lake-intel.js<br>plan-water-ui.js<br>smart-plan-v2-wiring.js |
| `/lake-intel-sources` | ANY | open | — | — | **nothing** |
| `/lake-research` | GET | open | services.arcgis.com<br>services6.arcgis.com | — | main.js |
| `/lakes/` | GET | open | services.arcgis.com<br>services6.arcgis.com<br>services1.arcgis.com | — | **nothing** |
| `/lakes/list` | GET | open | — | — | **nothing** |
| `/paddle` | ANY | open | services.arcgis.com<br>services6.arcgis.com<br>services1.arcgis.com | — | access-index.js<br>gis-toggles.js |
| `/ramps` | ANY | open | services.arcgis.com<br>services6.arcgis.com<br>services1.arcgis.com | — | access-index.js<br>ramps-loader.js<br>main.js |
| `/regulations` | ANY | open | — | — | regulations-live.js<br>lake-research-engine.js |
| `/research/agent-llm` | POST | open | — | — | lake-research-engine.js |
| `/research/analyze-facts` | POST | open | — | — | lake-research-engine.js |
| `/research/approve` | POST | **REQUIRED (list)** | — | — | **nothing** |
| `/research/dataset-hunt` | POST | **REQUIRED (list)** | — | — | **nothing** |
| `/research/dedupe-contradictions` | POST | open | — | — | lake-research-engine.js |
| `/research/delete` | POST | **REQUIRED (list)** | — | — | lake-research-ui.js |
| `/research/delete-normalized-doc` | POST | **REQUIRED (list)** | — | — | lake-research-ui.js |
| `/research/deterministic-facts` | POST | open | — | — | lake-research-engine.js |
| `/research/discover` | POST | open | — | — | lake-research-engine.js |
| `/research/gap-analysis` | POST | open | — | — | **nothing** |
| `/research/gap-search` | POST | open | — | — | **nothing** |
| `/research/get` | GET | open | — | — | lake-research-engine.js<br>lake-research-ui.js<br>smart-plan-v2-wiring.js |
| `/research/get-normalized` | GET | open | — | — | lake-research-engine.js |
| `/research/limnology-data` | POST | open | — | — | lake-research-engine.js<br>wqp-limnology.js |
| `/research/list` | GET | open | — | — | lake-research-ui.js |
| `/research/map-facts` | POST | open | — | — | **nothing** |
| `/research/package` | GET | open | services.arcgis.com<br>services6.arcgis.com | — | lake-research-ui.js |
| `/research/proxy-download` | GET | open | — | — | lake-research-engine.js |
| `/research/proxy-download-batch` | POST | open | — | — | lake-research-engine.js |
| `/research/save` | POST | **REQUIRED (list)** | — | — | lake-research-engine.js<br>lake-research-ui.js |
| `/research/save-normalized` | POST | **REQUIRED (list)** | — | — | lake-research-engine.js |
| `/research/shared/check` | POST | open | — | — | lake-research-engine.js |
| `/research/shared/publish` | POST | **REQUIRED (list)** | services.arcgis.com | — | **nothing** |
| `/research/shared/quarantine` | POST | **REQUIRED (list)** | services.arcgis.com | — | **nothing** |
| `/research/shared/query` | POST | open | services.arcgis.com | — | lake-research-engine.js |
| `/research/shared/status` | GET | open | services.arcgis.com | — | **nothing** |
| `/research/shared/store` | POST | **REQUIRED (list)** | services.arcgis.com | — | lake-research-engine.js |
| `/research/thermocline-search` | POST | open | — | — | **nothing** |
| `/research/validation-pass` | POST | open | services.arcgis.com<br>services6.arcgis.com<br>services1.arcgis.com | — | lake-research-engine.js |
| `/river` | ANY | **REQUIRED (inline)** | — | — | plan-builder.js<br>plan-inputs.js |
| `/rivers` | ANY | **REQUIRED (inline)** | — | — | **nothing** |
| `/species` | ANY | open | — | — | plan-inputs.js |
| `/sync` | ANY | **REQUIRED (prefix)** | — | — | cloud-sync.js |
| `/sync/list-updates` | GET | **REQUIRED (prefix)** | — | — | cloud-sync.js |
| `/sync/migrate` | POST | **REQUIRED (prefix)** | — | — | **nothing** |
| `/usgs` | ANY | open | waterservices.usgs.gov | — | lake-research-engine.js |

### Non-GET routes not in MUTATING_ROUTES

Read-shaped POSTs (LLM proxies, search) are deliberately open — see the comment above
`MUTATING_ROUTES`. Anything here that WRITES is a hole.

- `POST /build` — Worker/trollmap-worker.js:1026
- `POST /identify-catch` — Worker/trollmap-worker.js:1032
- `POST /identify-catch-v2` — Worker/trollmap-worker.js:1040
- `POST /groq-query` — Worker/trollmap-worker.js:1047
- `POST /research/thermocline-search` — Worker/trollmap-worker.js:1064
- `POST /research/limnology-data` — Worker/trollmap-worker.js:1069
- `POST /research/deterministic-facts` — Worker/trollmap-worker.js:1072
- `POST /research/discover` — Worker/trollmap-worker.js:1075
- `POST /research/analyze-facts` — Worker/trollmap-worker.js:1092
- `POST /research/dedupe-contradictions` — Worker/trollmap-worker.js:1095
- `POST /research/map-facts` — Worker/trollmap-worker.js:1098
- `POST /research/gap-analysis` — Worker/trollmap-worker.js:1101
- `POST /research/gap-search` — Worker/trollmap-worker.js:1104
- `POST /research/agent-llm` — Worker/trollmap-worker.js:1107
- `POST /research/proxy-download-batch` — Worker/trollmap-worker.js:1138
- `POST /research/shared/check` — Worker/trollmap-worker.js:1142
- `POST /research/shared/query` — Worker/trollmap-worker.js:1148
- `POST /research/validation-pass` — Worker/trollmap-worker.js:1180

## Routes nothing calls

_none_

## External feeds

| host | side | refs | first seen |
|---|---|---|---|
| w | browser | 46 | test/book-statewide-browser.test.js:61 |
| pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev | worker | 42 | Worker/research/clients.js:506 |
| www.ncwildlife.gov | pipeline, browser | 36 | Scripts/fetch_agency_lake_pages.py:175 |
| www.dnr.sc.gov | pipeline, worker, browser | 32 | Scripts/fetch_agency_lake_pages.py:67 |
| storymaps.arcgis.com | pipeline | 31 | Scripts/fetch_ga_lakes.py:5 |
| x | pipeline, browser | 25 | Scripts/capture_upstreams.py:260 |
| trollmap-worker.colonal1981.workers.dev | pipeline, browser | 22 | Scripts/audit_research_fields.py:43 |
| lakes.hydro-derived.duke-energy.app | pipeline, worker | 18 | Scripts/capture_upstreams.py:184 |
| www.carolinasportsman.com | worker, browser | 18 | Worker/reports.js:60 |
| www.anglersheadquarters.com | worker, browser | 17 | Worker/reports.js:66 |
| w.example | browser | 17 | test/notification-delivery.test.js:180 |
| www.eregulations.com | pipeline, worker, browser | 15 | Scripts/test_fetch_agency_nc.py:46 |
| georgiawildlife.blog | worker, browser | 15 | Worker/reports.js:54 |
| www.tn.gov | worker, browser | 13 | Worker/reports.js:72 |
| waterservices.usgs.gov | pipeline, worker | 12 | Scripts/build_water_bindings.py:123 |
| github.com | pipeline | 11 | Scripts/build_fishbase_traits.py:87 |
| api.firecrawl.dev | worker, browser | 11 | Worker/research/clients.js:277 |
| nepis.epa.gov | worker, browser | 9 | Worker/research/dataset.js:10 |
| www.ndbc.noaa.gov | pipeline, worker, browser | 8 | Scripts/bind_ndbc_stations.py:23 |
| api.hydro-derived.duke-energy.app | pipeline, worker | 8 | Scripts/bind_water_levels.py:48 |
| services.arcgis.com | pipeline, worker | 8 | Scripts/build_dnr_ramps_by_lake.py:157 |
| www.tva.com | pipeline, worker, browser | 8 | Scripts/build_water_bindings.py:118 |
| www.epa.gov | pipeline | 8 | Scripts/fetch_nla_limnology.py:76 |
| services6.arcgis.com | pipeline, worker | 7 | Scripts/build_dnr_ramps_by_lake.py:178 |
| services1.arcgis.com | pipeline, worker | 7 | Scripts/build_dnr_ramps_by_lake.py:198 |
| services3.arcgis.com | pipeline, worker | 7 | Scripts/build_dnr_ramps_by_lake.py:213 |
| api.tidesandcurrents.noaa.gov | pipeline, worker, browser | 7 | Scripts/build_water_bindings.py:121 |
| www.waterqualitydata.us | pipeline, worker, browser | 7 | Scripts/capture_upstreams.py:125 |
| usgs-nims-images.s3.amazonaws.com | pipeline, worker, browser | 6 | Scripts/build_camera_index.py:61 |
| www.ncpaws.org | pipeline, browser | 6 | Scripts/build_nc_species_by_lake.py:61 |
| water.noaa.gov | pipeline | 6 | Scripts/build_water_bindings.py:674 |
| worker | pipeline, browser | 6 | Scripts/capture_upstreams.py:260 |
| waterdata.usgs.gov | worker, browser | 6 | Worker/worker-data.js:933 |
| lakemonster.com | worker | 6 | Worker/worker-data.js:957 |
| www.youtube.com | browser | 6 | test/a-platform-is-not-a-verdict.test.js:31 |
| api.waterdata.usgs.gov | pipeline, worker, browser | 5 | Scripts/build_camera_index.py:59 |
| georgiawildlife.com | pipeline, worker, browser | 5 | Scripts/fetch_agency_lake_pages.py:88 |
| data-scdnr.opendata.arcgis.com | worker | 5 | Worker/worker-data.js:941 |
| fcm.googleapis.com | browser | 5 | test/push-alerts.test.js:47 |
| cwms-data.usace.army.mil | pipeline, worker | 4 | Scripts/build_water_bindings.py:119 |
| aa.usno.navy.mil | pipeline, worker, browser | 4 | Scripts/capture_upstreams.py:21 |
| dashboard.waterdata.usgs.gov | pipeline, worker | 4 | Scripts/capture_upstreams.py:152 |
| cdnjs.cloudflare.com | pipeline, browser | 4 | Scripts/show_missing_water.py:308 |
| grokipedia.com | worker | 4 | Worker/research/discover.js:735 |
| unpkg.com | browser | 4 | index.html:8 |
| x.gov | browser | 4 | test/proxy-target-type.test.js:31 |
| www.google.com | pipeline | 3 | Scripts/build_garmin_water_inventory.py:649 |
| mapservices.weather.noaa.gov | pipeline, worker | 3 | Scripts/build_lake_drainage.py:152 |
| www.licor.cloud | pipeline, worker | 3 | Scripts/fetch_licor_dashboard.py:26 |
| seafwa.org | pipeline, browser | 3 | Scripts/test_fetch_agency_nc.py:41 |
| dash.cloudflare.com | pipeline | 3 | Scripts/trollmap_r2_clean.py:6 |
| api.scrape.do | worker | 3 | Worker/research/clients.js:475 |
| www.dominionenergy.com | worker | 3 | Worker/trollmap-worker.js:390 |
| www.santeecooper.com | worker, browser | 3 | Worker/worker-data.js:1016 |
| water.sas.usace.army.mil | worker | 3 | Worker/worker-data.js:1125 |
| api.open-meteo.com | worker, browser | 3 | Worker/worker-data.js:1448 |
| www.topografix.com | browser | 3 | js/utils/parsers.js:162 |
| www.garmin.com | browser | 3 | js/utils/parsers.js:163 |
| www.facebook.com | browser | 3 | test/a-platform-is-not-a-verdict.test.js:43 |
| www.safewaters.com | browser | 3 | test/operator-levels.test.js:173 |
| w.dev | browser | 3 | test/shared-latest-pointer.test.js:73 |
| ww4.cubecarolinas.com | pipeline, worker | 2 | Scripts/bind_operator_lakes.py:192 |
| lakes.southernco.com | pipeline, worker | 2 | Scripts/bind_operator_lakes.py:194 |
| www.fishbase.se | pipeline | 2 | Scripts/build_fishbase_traits.py:85 |
| gis.des.sc.gov | pipeline | 2 | Scripts/fetch_sc_fish_advisories.py:43 |
| fonts.googleapis.com | pipeline | 2 | Scripts/regulations_report.py:647 |
| safewaters.com | pipeline | 2 | Scripts/test_bind_operator_lakes.py:127 |
| api.water.noaa.gov | worker | 2 | Worker/conditions.js:872 |
| azapp-lakespublic-prd-001.azurewebsites.net | worker | 2 | Worker/conditions.js:1639 |
| generativelanguage.googleapis.com | worker | 2 | Worker/trollmap-worker.js:815 |
| coastalgadnr.org | worker, browser | 2 | Worker/worker-data.js:1782 |
| server.arcgisonline.com | browser | 2 | js/core/map-init.js:29 |
| 127.0.0.1 | browser | 2 | js/modules/capture-panel.js:14 |
| www.reddit.com | browser | 2 | test/a-platform-is-not-a-verdict.test.js:46 |
| cofc.edu | browser | 2 | test/discover-authority.test.js:45 |
| worker.example | browser | 2 | test/notification-delivery.test.js:144 |
| www.sas.usace.army.mil | browser | 2 | test/proxy-target-type.test.js:21 |
| x.pdf | browser | 2 | test/search-cascade.test.js:240 |
| carolinasportsman.com | browser | 2 | test/the-scorer-buried-the-catalpa-worm.test.js:101 |
| hydro.nationalmap.gov | pipeline | 1 | Scripts/build_lake_drainage.py:61 |
| api.epa.gov | pipeline | 1 | Scripts/build_water_advisories.py:56 |
| . | pipeline | 1 | Scripts/capture_upstreams.py:30 |
| services7.arcgis.com | pipeline | 1 | Scripts/fetch_ehydro_surveys.py:40 |
| wiki.openstreetmap.org | pipeline | 1 | Scripts/fetch_osm_coastal.py:343 |
| www.des.sc.gov | pipeline | 1 | Scripts/parse_lake_program_reports.py:400 |
| www.weather.gov | pipeline | 1 | Scripts/probe_ndbc_stations.py:11 |
| fonts.gstatic.com | pipeline | 1 | Scripts/regulations_report.py:648 |
| afspubs.onlinelibrary.wiley.com | pipeline | 1 | Scripts/test_fetch_agency_nc.py:42 |
| www.tandfonline.com | pipeline | 1 | Scripts/test_fetch_agency_nc.py:43 |
| prd-tnm.s3.amazonaws.com | pipeline | 1 | Scripts/trollmap_nhd_boundaries.py:34 |
| api.cloudflare.com | pipeline | 1 | Scripts/trollmap_r2_clean.py:39 |
| trollmap.pages.dev | worker | 1 | Worker/alerts.js:187 |
| internal | worker | 1 | Worker/alerts.js:222 |
| forecast.weather.gov | worker | 1 | Worker/conditions.js:268 |
| publicservice.dominionenergyse.com | worker | 1 | Worker/conditions.js:1649 |
| api.tavily.com | worker | 1 | Worker/research/clients.js:239 |
| s.jina.ai | worker | 1 | Worker/research/clients.js:311 |
| www.ncwildlife.org | worker | 1 | Worker/research/dataset.js:13 |
| r.jina.ai | worker | 1 | Worker/research/download.js:676 |
| api.groq.com | worker | 1 | Worker/worker-core.js:143 |
| openrouter.ai | worker | 1 | Worker/worker-core.js:156 |
| trollmap.dev | worker | 1 | Worker/worker-core.js:169 |
| api.cerebras.ai | worker | 1 | Worker/worker-core.js:176 |
| deq.nc.gov | worker | 1 | Worker/worker-data.js:1783 |
| static.cloudflareinsights.com | browser | 1 | index.html:1442 |
| tile.openstreetmap.org | browser | 1 | js/core/map-init.js:33 |
| saltwaterfishing.sc.gov | browser | 1 | js/data/coastal-regulations.js:91 |
| fishing-app.gpsnauticalcharts.com | browser | 1 | js/modules/capture-panel.js:15 |
| archive-api.open-meteo.com | browser | 1 | js/modules/catch-journal.js:159 |
| cdn.jsdelivr.net | browser | 1 | js/modules/catch-journal.js:1103 |
| www.openstreetmap.org | browser | 1 | js/modules/ramps.js:59 |
| nominatim.openstreetmap.org | browser | 1 | js/modules/topbar.js:107 |
| www.instagram.com | browser | 1 | test/a-platform-is-not-a-verdict.test.js:41 |
| www.tiktok.com | browser | 1 | test/a-platform-is-not-a-verdict.test.js:44 |
| www.sctrails.net | browser | 1 | test/a-platform-is-not-a-verdict.test.js:90 |
| youtube.com | browser | 1 | test/a-platform-is-not-a-verdict.test.js:99 |
| x.com | browser | 1 | test/a-platform-is-not-a-verdict.test.js:110 |
| www.sad.usace.army.mil | browser | 1 | test/discover-authority.test.js:20 |
| www.osti.gov | browser | 1 | test/discover-authority.test.js:23 |
| tidesandcurrents.noaa.gov | browser | 1 | test/discover-authority.test.js:24 |
| lakelevels.duke-energy.com | browser | 1 | test/discover-authority.test.js:29 |
| elibrary.ferc.gov | browser | 1 | test/discover-authority.test.js:30 |
| southcarolinaparks.com | browser | 1 | test/discover-authority.test.js:34 |
| www.whitehouse.gov | browser | 1 | test/discover-authority.test.js:83 |
| dnr.state.mn.us | browser | 1 | test/doc-relevance.test.js:28 |
| www.dnr.state.mn.us | browser | 1 | test/doc-relevance.test.js:99 |
| a.com | browser | 1 | test/doc-relevance.test.js:106 |
| b.com | browser | 1 | test/doc-relevance.test.js:107 |
| triadncwater.gov | browser | 1 | test/doc-relevance.test.js:151 |
| www.congareeriverkeeper.org | browser | 1 | test/doc-relevance.test.js:164 |
| lakeforktrophybass.com | browser | 1 | test/doc-relevance.test.js:175 |
| www.bigcrappie.com | browser | 1 | test/doc-relevance.test.js:180 |
| www.gastongov.com | browser | 1 | test/duke-access-alerts.test.js:39 |
| identity-names.test.invalid | browser | 1 | test/identity-names.test.js:24 |
| api.search.tinyfish.ai | browser | 1 | test/research-discover-policy.test.js:15 |
| api.fetch.tinyfish.ai | browser | 1 | test/research-discover-policy.test.js:26 |
| www.gameandfishmag.com | browser | 1 | test/test_facts_reach_the_saved_profile.py:279 |
| www.usgs.gov | browser | 1 | test/the-scorer-buried-the-catalpa-worm.test.js:57 |
| api.weather.gov | browser | 1 | test/wwa-hazards.test.js:19 |

## R2 key shapes

| op | key expression | where |
|---|---|---|
| get | `cacheKey` | Worker/core/arcgis.js:91 |
| put | `cacheKey` | Worker/core/arcgis.js:327 |
| get | `cacheKey` | Worker/core/arcgis.js:356 |
| put | `safeKey` | Worker/research/deterministic.js:307 |
| put | `key` | Worker/research/deterministic.js:389 |
| get | ``lake_packages/${id}/normalized_documents.json`` | Worker/research/deterministic.js:410 |
| get | ``lake_packages/${LEGACY_PROFILE_KEYS[safe]}/normalized_documents.json`` | Worker/research/deterministic.js:415 |
| get | `cacheKey` | Worker/research/facts-util.js:586 |
| put | `cacheKey` | Worker/research/facts-util.js:623 |
| get | `key` | Worker/research/limnology.js:168 |
| put | `key` | Worker/research/limnology.js:199 |
| get | ``${lakeKey}/shoreline.geojson`` | Worker/research/limnology.js:242 |
| get | ``${lakeKey}/garmin_shoreline.geojson`` | Worker/research/limnology.js:243 |
| get | `key` | Worker/research/limnology.js:778 |
| put | `key` | Worker/research/limnology.js:810 |
| get | `SWEEP_STATE_KEY` | Worker/research/limnology.js:876 |
| put | `SWEEP_STATE_KEY` | Worker/research/limnology.js:890 |
| get | `water.key` | Worker/research/limnology.js:969 |
| put | `water.key` | Worker/research/limnology.js:1060 |
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
| get | ``lakes/${id}.json`` | Worker/research/storage.js:62 |
| get | `vKey` | Worker/research/storage.js:81 |
| list | `{ prefix: `lakes/versions/${safe}/` }` | Worker/research/storage.js:86 |
| list | `{prefix: `lake_packages/${safe}/`}` | Worker/research/storage.js:119 |
| list | `{prefix: `lakes/versions/${safe}/`}` | Worker/research/storage.js:128 |
| get | ``lakes/${id}.json`` | Worker/research/storage.js:153 |
| get | ``lakes/${safe}.json`` | Worker/research/storage.js:164 |
| list | `{prefix:`lakes/versions/${safe}/`}` | Worker/research/storage.js:173 |
| put | ``lakes/${safe}.json`` | Worker/research/storage.js:341 |
| put | ``lakes/versions/${safe}/v${nextVersion}.json`` | Worker/research/storage.js:346 |
| put | ``lake_packages/${safe}/${k}.json`` | Worker/research/storage.js:356 |
| put | ``lake_packages/${safe}/sources.json`` | Worker/research/storage.js:363 |
| put | ``lake_packages/${safe}/metadata.json`` | Worker/research/storage.js:364 |
| put | ``lake_packages/${safe}/evidence.json`` | Worker/research/storage.js:365 |
| put | ``lake_packages/${safe}/research_log.json`` | Worker/research/storage.js:366 |
| put | ``lake_packages/${safe}/notes.md`` | Worker/research/storage.js:368 |
| get | ``lakes/${id}.json`` | Worker/research/storage.js:396 |
| get | `masterKey` | Worker/research/storage.js:400 |
| put | `masterKey` | Worker/research/storage.js:412 |
| get | `key` | Worker/research/storage.js:427 |
| put | `key` | Worker/research/storage.js:440 |
| get | ``lakes/${id}.json`` | Worker/research/storage.js:467 |
| head | ``lakes/${safe}.json`` | Worker/research/storage.js:470 |
| list | `{ prefix: `lake_packages/${safe}/` }` | Worker/research/storage.js:478 |
| list | `{ prefix: `lakes/versions/${safe}/` }` | Worker/research/storage.js:486 |
| delete | `key` | Worker/research/storage.js:496 |
| list | `{ prefix: `lake_packages/${id}/` }` | Worker/research/storage.js:510 |
| get | ``lake_packages/${id}/${filename}`` | Worker/research/storage.js:526 |
| get | ``lakes/${safe}.json`` | Worker/research/storage.js:546 |
| get | ``lakes/${safeKey}.json`` | Worker/research/storage.js:549 |
| get | `key` | Worker/trollmap-worker.js:656 |
| put | `key` | Worker/trollmap-worker.js:671 |
| get | `key` | Worker/trollmap-worker.js:1940 |
| list | `{ prefix }` | Worker/trollmap-worker.js:1961 |
| get | `key` | Worker/trollmap-worker.js:1990 |
| put | `key` | Worker/trollmap-worker.js:2026 |
| get | `chartpackKey(slug` | Worker/water.js:142 |
| get | `chartpackKey(slug` | Worker/water.js:155 |
| list | `{ cursor` | Worker/worker-core.js:417 |

## Data files — who reads them

| file | read by |
|---|---|
| `   nearest different pools. Geometry cannot separate them; registry/_duke_dams.json` | Scripts/bind_dams_to_waters.py:267 |
| `  1. add the row to registry/lakes.json and registry/tile_lake_map.json` | Scripts/boundary_from_3dhp.py:270 |
| ` because they
     came out of FishBase in the first place. Order, Family and Occurrence come free with them.
  2. registry/species_traits.json` | Scripts/build_fishbase_traits.py:39 |
| `../../registry/lake_index.json` | test/the-search-was-anchored-on-a-phrase-no-page-contains.test.js:62 |
| `../registry/lake_index.json` | test/keys_smoke.mjs:21<br>test/registry_smoke.mjs:21 |
| `<packs>/../registry/_r2_only.txt` | Scripts/r2_vs_local.py:435 |
| `data/tristate-bank-pier.json` | test/fixtures.test.js:51 |
| `data/tristate-hotspots.json` | test/fixtures.test.js:53 |
| `data/tristate-paddle.json` | test/fixtures.test.js:52 |
| `default <repo>/../registry/_research_field_consumers.json` | Scripts/audit_research_fields.py:314 |
| `default <repo>/../registry/_research_profiles_cache.json` | Scripts/audit_research_fields.py:312 |
| `default <root>/registry/species_traits.json` | Scripts/build_species_traits.py:799 |
| `not in registry/pages_not_law.json` | Scripts/build_regulations_table.py:2204 |
| `r2_audit.py --save output. Default <packs>/../registry/_r2_listing.json` | Scripts/r2_vs_local.py:429 |
| `registry/_bathy_graphs.json` | Scripts/bathy_graph.py:487 |
| `registry/_coastal_pointers.json` | Scripts/gen_water_aliases_js.py:105 |
| `registry/_cwms_inventory.json` | Scripts/probe_cwms_catalog.py:62 |
| `registry/_deletion_tab.json` | Scripts/merge_duplicate_waters.py:42 |
| `registry/_feed_names.json` | Scripts/build_water_names.py:74<br>Scripts/consolidate_lake_index.py:13<br>Scripts/consolidate_lake_index.py:1009 |
| `registry/_full_pool_hunt.json` | Scripts/build_full_pool_hunt.py:63 |
| `registry/_ndbc_stations.json` | Scripts/probe_ndbc_stations.py:47 |
| `registry/_nhd_bindings.json` | Scripts/merge_duplicate_waters.py:41 |
| `registry/_r2_listing.json` | Scripts/r2_vs_local.py:29 |
| `registry/_reflag_routable.json` | Scripts/reflag_routable.py:100 |
| `registry/_sensor_feeds.json` | Scripts/bind_water_levels.py:89<br>Scripts/build_full_pool_hunt.py:72<br>Scripts/build_full_pool_hunt.py:87<br>Scripts/build_full_pool_hunt.py:241 |
| `registry/_start_here_facts.json` | Scripts/check_start_here.py:29 |
| `registry/_trolling_runs.json` | Scripts/build_full_pool_hunt.py:71<br>Scripts/build_full_pool_hunt.py:86 |
| `registry/_uncharted.csv` | Scripts/uncharted_report.py:354 |
| `registry/_usgs_current_conditions.json` | Scripts/pull_usgs_current_conditions.py:65 |
| `registry/_water_bindings_review.json` | Scripts/triage_water_bindings.py:10 |
| `registry/charted.json` | Scripts/build_structure.py:90<br>Scripts/build_trolling_runs.py:62<br>Scripts/build_water_features.py:100 |
| `registry/curated_lakes.json` | Scripts/remove_registry_water.py:48 |
| `registry/duke_lake_levels.json` | Scripts/bind_water_levels.py:85<br>Scripts/build_full_pool_hunt.py:70<br>Scripts/build_full_pool_hunt.py:85 |
| `registry/full_pool.json` | Scripts/build_full_pool_hunt.py:69<br>Scripts/build_full_pool_hunt.py:83<br>Scripts/validate_pool_numbers.py:32 |
| `registry/gauge_overrides.json` | Scripts/build_water_bindings.py:1608 |
| `registry/lake_aliases.json` | Scripts/build_dnr_ramps_by_lake.py:66<br>Scripts/remove_registry_water.py:48<br>Scripts/uncharted_report.py:31<br>Scripts/uncharted_report.py:346 |
| `registry/lake_display_names.json` | Scripts/merge_duplicate_waters.py:61 |
| `registry/lake_index.json` | Scripts/bind_dams_to_waters.py:43<br>Scripts/build_dnr_ramps_by_lake.py:32<br>Scripts/build_duke_dam_table.py:37<br>Scripts/build_full_pool_hunt.py:73<br>Scripts/build_full_pool_hunt.py:89<br>Scripts/build_water_chain.py:66<br>Scripts/find_duplicate_waters.py:39<br>Scripts/gen_water_aliases_js.py:109<br>Scripts/lookup_3dhp.py:11<br>Scripts/match_waters_to_nhd.py:41<br>Scripts/merge_duplicate_waters.py:40<br>Scripts/migrate_merged_slugs.py:50<br>Scripts/refresh_yield.py:126<br>Scripts/sweep_unclaimed.py:52<br>Scripts/sweep_unclaimed.py:226<br>Scripts/uncharted_report.py:345 |
| `registry/lakes.json` | Scripts/cut_boundaries_batch.py:55<br>Scripts/make_coastal_boundaries.py:17<br>Scripts/sweep_unclaimed.py:352<br>Scripts/verify_registry_r2.py:48 |
| `registry/nc_species_by_lake.json` | Scripts/build_nc_species_by_lake.py:9 |
| `registry/nla_limnology.json` | Scripts/derive_nes_limnology.py:15 |
| `registry/no_full_pool.json` | Scripts/build_full_pool_hunt.py:74<br>Scripts/build_full_pool_hunt.py:92<br>Scripts/build_full_pool_hunt.py:216 |
| `registry/osm_ramps_by_lake.json` | Scripts/make_osm_ramps_by_lake.py:12 |
| `registry/pages_not_law.json` | Scripts/build_regulations_table.py:2245 |
| `registry/region_mask.json` | Scripts/build_coverage_cache.py:37<br>Scripts/make_region_mask.py:8<br>Scripts/sweep_unclaimed.py:61 |
| `registry/regulations_table.json` | Scripts/build_regulations_table.py:2081 |
| `registry/species_map.json` | Scripts/declare_species_with_no_home.py:13 |
| `registry/tile_lake_map.json` | Scripts/find_affected_tiles.py:104 |
| `registry/water_bindings.json` | Scripts/build_full_pool_hunt.py:68<br>Scripts/build_full_pool_hunt.py:82<br>Scripts/build_water_bindings.py:1914<br>Scripts/triage_water_bindings.py:18 |
| `registry/water_chain.json` | Scripts/build_water_chain.py:67 |
| `registry/water_states.json` | Scripts/label_water_states.py:35 |

## JS modules

| module | lines | exports | imported by | dead exports | purpose |
|---|---|---|---|---|---|
| `Scripts/app_offers.mjs` | 67 | 0 | 0 | 0 | app_offers.mjs -- write the slug list the pipeline scripts should be scoped to. |
| `Scripts/lake_depth_stats.mjs` | 103 | 0 | 0 | 0 | lake_depth_stats.mjs — max and average depth for one chartpack, from the app's own functio |
| `Scripts/make_counties.mjs` | 49 | 0 | 0 | 0 | make_counties.mjs -- flatten us-atlas counties-10m TopoJSON into a GeoJSON the Python |
| `Scripts/research_todo.mjs` | 189 | 0 | 0 | 0 | research_todo.mjs — which waters the Research tab would offer, asked of the app's own code |
| `Scripts/which_profile_serves.mjs` | 269 | 0 | 0 | 0 | which_profile_serves.mjs -- which stored profile the PICKER's names actually reach. |
| `Worker/alerts.js` | 676 | 6 | 3 | 0 | Web Push, because the phone is asleep in a PFD pocket. |
| `Worker/cameras.js` | 176 | 5 | 1 | **4** | Worker/cameras.js — the current frame from a USGS NIMS camera. |
| `Worker/conditions.js` | 5026 | 66 | 36 | **3** | Worker/conditions.js — one call that answers "what is this water doing right now". |
| `Worker/core/arcgis.js` | 401 | 7 | 3 | **2** | Worker/core/arcgis.js — shared ArcGIS helper for ramps/paddle/bank-pier/attractors |
| `Worker/core/ramp-sources.js` | 137 | 2 | 3 | 0 | ramp-sources.js — the four state ramp feeds, in ONE table. |
| `Worker/ndbc.js` | 236 | 6 | 2 | **1** | NDBC realtime2 — the measured half of the weather this app shows. |
| `Worker/operators.js` | 331 | 6 | 3 | 0 | operators.js — the three utility operators that publish HTML tables instead of JSON. |
| `Worker/registry.js` | 876 | 39 | 14 | 0 | The lake index, read by the Worker. |
| `Worker/reports.js` | 622 | 18 | 9 | **4** | reports.js — recent fishing reports for one water, from the people who were on it. |
| `Worker/research/agency-pages.js` | 221 | 9 | 2 | **2** | agency-pages.js — the state's own description of a lake, found through the state's own ind |
| `Worker/research/agents.js` | 2170 | 12 | 9 | **4** | research/agents.js — split from worker-research.js (behavior-preserving) |
| `Worker/research/behaviour.js` | 197 | 2 | 1 | 0 | research/behaviour.js — reading fishing behaviour out of already-extracted facts. |
| `Worker/research/clients.js` | 1362 | 46 | 12 | 0 | research/clients.js — split from worker-research.js (behavior-preserving) |
| `Worker/research/coastal-agents.js` | 328 | 6 | 5 | 0 | coastal-agents.js — saltwater-specific research agents. |
| `Worker/research/dataset.js` | 443 | 10 | 5 | **4** | research/dataset.js — split from worker-research.js (behavior-preserving) |
| `Worker/research/deterministic.js` | 976 | 8 | 11 | 0 | research/deterministic.js — split from worker-research.js (behavior-preserving) |
| `Worker/research/discover.js` | 1390 | 11 | 7 | 0 | research/discover.js — split from worker-research.js (behavior-preserving) |
| `Worker/research/download.js` | 708 | 4 | 3 | 0 | research/download.js — split from worker-research.js (behavior-preserving) |
| `Worker/research/extract.js` | 884 | 6 | 1 | 0 | research/extract.js — split from worker-research.js (behavior-preserving) |
| `Worker/research/facts-util.js` | 984 | 24 | 7 | **12** | research/facts-util.js — split from worker-research.js (behavior-preserving) |
| `Worker/research/keys.js` | 186 | 12 | 14 | 0 |  |
| `Worker/research/limnology.js` | 1083 | 5 | 6 | 0 | research/limnology.js — split from worker-research.js (behavior-preserving) |
| `Worker/research/shared.js` | 714 | 29 | 3 | **13** | research/shared.js — split from worker-research.js (behavior-preserving) |
| `Worker/research/storage.js` | 789 | 11 | 4 | 0 | research/storage.js — split from worker-research.js (behavior-preserving) |
| `Worker/research/water-type-hints.js` | 311 | 4 | 6 | 0 | water-type-hints.js — the framing a research agent gets for the KIND of water it is on. |
| `Worker/sensor.js` | 94 | 3 | 2 | 0 | sensor.js — operator-run sensors that are not USGS, not CWMS and not NWS. |
| `Worker/trollmap-worker.js` | 2092 | 1 | 0 | 0 | r2Text is used by /chartpacks/lake-boundary (line ~1711). It was added to worker-core.js |
| `Worker/water.js` | 1050 | 4 | 3 | 0 | Worker/water.js — the compute plane over the static pack layers. |
| `Worker/webpush.js` | 162 | 2 | 2 | 0 | Worker/webpush.js — putting the words INSIDE the push. |
| `Worker/worker-core.js` | 550 | 11 | 23 | 0 | worker-core.js — Shared infrastructure: CORS headers, LLM provider chain, fetchText |
| `Worker/worker-data.js` | 2060 | 27 | 8 | 0 | worker-data.js — Static lake/river data extracted from trollmap-worker.js |
| `Worker/worker-research.js` | 14 | 41 | 1 | 0 | worker-research.js — public API barrel (impl in Worker/research/*) |
| `Worker/worker-species.js` | 230 | 10 | 1 | 0 | worker-species.js — Species lists and ecological validation |
| `js/core/layer-registry.js` | 300 | 18 | 8 | **6** | core/layer-registry.js — one owner for every toggleable map layer. |
| `js/core/map-init.js` | 470 | 17 | 16 | **6** | Leaflet map initialization + base-layer switching + waypoint/track |
| `js/core/state.js` | 63 | 2 | 49 | 0 | Shared mutable application state. |
| `js/core/tabs.js` | 76 | 1 | 1 | 0 | Bottom-nav tab switcher. |
| `js/data/access-index.js` | 962 | 12 | 15 | 0 | access-index.js — Shared worker-backed access-point index. |
| `js/data/cameras.js` | 1014 | 3 | 2 | **1** | GENERATED by Scripts/build_camera_index.py -- do not hand-edit. |
| `js/data/coastal-regulations.js` | 519 | 9 | 4 | 0 | coastal-regulations.js — saltwater size/creel/season rules for SC, GA, NC. |
| `js/data/coastal-zones.js` | 289 | 6 | 25 | 0 | coastal-zones.js — SC / GA coastal + tidal zone catalog. |
| `js/data/fish-advisories.js` | 189 | 6 | 4 | 0 | fish-advisories.js — what a state says about EATING what you keep. |
| `js/data/fishing-style-profile.js` | 135 | 5 | 7 | **4** | fishing-style-profile.js — Ryan's actual gear, platform, and technique |
| `js/data/ga-access-species.js` | 110 | 2 | 1 | **1** | js/data/ga-access-species.js — the fish Georgia publishes as 48 yes/no columns. |
| `js/data/inshore-season.js` | 152 | 7 | 3 | 0 | inshore-season.js — WHEN the inshore fish are actually caught, and how big they run. |
| `js/data/lake-keys.js` | 581 | 4 | 28 | 0 | Shared lake display-name → R2 key map. |
| `js/data/lake-registry.js` | 833 | 17 | 16 | 0 | lake-registry.js — the 3DHP lake registry, with every access source joined on. |
| `js/data/lure-knowledge.js` | 1759 | 29 | 20 | **1** | lure-knowledge.js — Lure behavior profiles and scoring engine. |
| `js/data/ramps-loader.js` | 209 | 2 | 4 | 0 | ramps.js — Tri-state (SC/NC/GA) boat ramp database. |
| `js/data/registry-loader.js` | 81 | 2 | 2 | **1** | registry-loader.js — one cached fetch for the `_registry/*.json` tables. |
| `js/data/regulations-live.js` | 498 | 10 | 10 | 0 | The state regulation digest, in the browser. |
| `js/data/research-ids.js` | 195 | 7 | 5 | 0 | research-ids.js — the R2 storage id a lake's research profile lives under. |
| `js/data/seabed-habitat.js` | 179 | 6 | 3 | 0 | seabed-habitat.js — what this fish wants off the bottom, and what this zone's bottom IS. |
| `js/data/species-intel.js` | 708 | 7 | 10 | 0 |  |
| `js/data/spread-defaults.js` | 59 | 1 | 1 | 0 | Default six-rod trolling spread, initialized on app load. |
| `js/data/tackle-inventory.js` | 525 | 9 | 20 | **2** | tackle-inventory.js — Ryan's personal lure inventory. |
| `js/data/thermocline-norms.js` | 168 | 3 | 2 | 0 | thermocline-norms.js -- where the thermocline typically sits, by lake max |
| `js/data/water-aliases.js` | 188 | 4 | 5 | 0 | water-aliases.js — DNR waterbody name → chartpack key. |
| `js/data/water-filter.js` | 438 | 8 | 9 | 0 | water-filter.js — one predicate, three surfaces, and a bias toward keeping things. |
| `js/data/water-picker.js` | 248 | 7 | 4 | 0 | WHICH WATERS A PICKER OFFERS, AND WHAT EACH ONE IS. One answer for every tab. |
| `js/lazy-data.js` | 61 | 0 | 0 | 0 | lazy-data.js — on-demand loader for optional GIS data files. |
| `js/main.js` | 222 | 0 | 0 | 0 | TrollMap GPX Studio v10 — modular entry point. |
| `js/modules/auto-crop.js` | 37 | 0 | 1 | 0 | Auto-Crop — strips the phone status bar and Navionics zoom controls |
| `js/modules/ble-motor.js` | 204 | 0 | 1 | 0 | BLE Motor — XZNY / JBD / Xiaoxiang-style BMS pairing via Web Bluetooth API. |
| `js/modules/capture-panel.js` | 432 | 1 | 1 | **1** | capture-panel.js — Contour capture workflow panel. |
| `js/modules/catch-journal.js` | 1423 | 2 | 3 | 0 | catch-journal.js — TrollMap Catch Center |
| `js/modules/catch-photo.js` | 34 | 0 | 1 | 0 | Catch Verification Photo Lightbox — full-screen viewer for a |
| `js/modules/catch-plot.js` | 72 | 0 | 1 | 0 | Plot Catches on Map — toggle catch markers on the map. Markers |
| `js/modules/chart-import.js` | 435 | 2 | 2 | **1** | Contour / GIS layer import — load a KML, GPX, or GeoJSON file |
| `js/modules/chart-mosaic.js` | 435 | 5 | 3 | **2** | Chart mosaic — saved depth-contour overlay layers. |
| `js/modules/chart-overlay.js` | 492 | 1 | 1 | **1** | Chart overlay — the SINGLE working image being georeferenced. |
| `js/modules/cloud-sync.js` | 475 | 4 | 3 | 0 | Cloud Sync — auto-push on save, auto-pull on load. |
| `js/modules/coastal-layers.js` | 383 | 5 | 1 | **5** | coastal-layers.js — oyster beds, marsh edges and depth soundings. |
| `js/modules/coastal-scoring.js` | 289 | 15 | 3 | **1** | coastal-scoring.js — tide- and structure-aware spot scoring for inshore |
| `js/modules/conditions-strip.js` | 746 | 2 | 1 | **2** | The state of the water, above the map, before you plan anything. |
| `js/modules/contour-data.js` | 642 | 10 | 5 | **6** | contour-data.js — Contour dataset lazy loader + lake selector integration. |
| `js/modules/custom-vectors.js` | 146 | 4 | 2 | **2** | custom-vectors.js — imported GeoJSON layers. |
| `js/modules/edit.js` | 253 | 1 | 2 | 0 | Edit tab — table-based view of waypoints + tracks with inline |
| `js/modules/file-io.js` | 87 | 0 | 1 | 0 | Top-bar File I/O — Load / New / Save GPX. |
| `js/modules/fishing-index.js` | 309 | 0 | 1 | 0 | fishing-index.js — Fisherman-friendly overlay on top of SCDNR data |
| `js/modules/garmin-parser.js` | 119 | 0 | 1 | 0 | Garmin Catch Parser — import a GPX file from a Garmin chartplotter |
| `js/modules/gear-autopilot.js` | 45 | 0 | 1 | 0 |  |
| `js/modules/gis-toggles.js` | 289 | 1 | 1 | **1** |  |
| `js/modules/gps.js` | 106 | 3 | 1 | **3** | GPS tracking — current location marker, follow mode, and recorded |
| `js/modules/lake-intel.js` | 459 | 2 | 4 | 0 | Lake Intelligence + Clarity Forecast — pulls fisherman-focused |
| `js/modules/lake-ramp-select.js` | 497 | 8 | 3 | 0 | Worker-backed Lake / Access dropdowns in the map toolbar. |
| `js/modules/lake-research-engine.js` | 2940 | 26 | 2 | **6** | lake-research-engine.js — Pipeline logic, geo helpers, fact building |
| `js/modules/lake-research-ui.js` | 2135 | 4 | 1 | 0 |  |
| `js/modules/lake-research.js` | 4 | 6 | 1 | **6** | lake-research.js — barrel re-export |
| `js/modules/layers-panel.js` | 105 | 4 | 1 | **2** | layers-panel.js — the one place every map overlay is turned on and off. |
| `js/modules/measure-tool.js` | 106 | 0 | 1 | 0 | Distance & Bearing Measurement Tool — click two points on the |
| `js/modules/noaa-tides.js` | 228 | 1 | 1 | **1** | NOAA Coastal Tides — Plan-tab tide panel. |
| `js/modules/notifications.js` | 965 | 14 | 4 | 0 | notifications.js — On-water alerts for TrollMap |
| `js/modules/osm-structure.js` | 145 | 0 | 1 | 0 | osm-structure.js — OSM Structure Layer Toggle |
| `js/modules/plan-assemble.js` | 1422 | 8 | 18 | 0 | plan-assemble.js — ordered candidates + the model's judgement → a plan v2 object. |
| `js/modules/plan-bench.js` | 268 | 1 | 1 | 0 | THE BENCH — test the app before a plan is a plan. |
| `js/modules/plan-builder.js` | 3019 | 11 | 10 | 0 | Plan Builder — the Plan tab form, save/load, preview rendering, |
| `js/modules/plan-candidates.js` | 2301 | 37 | 27 | **7** | Candidate legs for a day's plan — the payload the model chooses from. |
| `js/modules/plan-from-water.js` | 515 | 1 | 3 | 0 | plan-from-water.js — the water is already chosen. Build the day around it. |
| `js/modules/plan-inputs.js` | 1217 | 16 | 18 | 0 | plan-inputs.js — the parts of "what am I planning" that are not the DOM. |
| `js/modules/plan-issues.js` | 98 | 2 | 4 | 0 | plan-issues.js — what the plan says about itself, in the shape the tab can show. |
| `js/modules/plan-pieces.js` | 915 | 8 | 7 | **1** | plan-pieces.js — turning charted lanes into the water a fisherman actually chooses from. |
| `js/modules/plan-preflight.js` | 675 | 12 | 11 | 0 | plan-preflight.js — the two things that must happen before a plan is worth building. |
| `js/modules/plan-prompt.js` | 1915 | 21 | 25 | 0 | plan-prompt.js — what the model is asked, and what comes back. |
| `js/modules/plan-tab-wiring.js` | 73 | 0 | 1 | 0 | plan-tab-wiring.js |
| `js/modules/plan-to-timeline.js` | 584 | 6 | 12 | 0 | plan-to-timeline.js — a v2 plan, in the shape the rest of the Plan tab already reads. |
| `js/modules/plan-tracks.js` | 445 | 8 | 7 | **1** | plan-tracks.js — a v2 plan, materialised into the tracks and waypoints the export path rea |
| `js/modules/plan-water-index.js` | 226 | 3 | 2 | 0 | plan-water-index.js — the two spatial lookups the water reasons need, and nothing else. |
| `js/modules/plan-water-ui.js` | 1558 | 5 | 2 | 0 | plan-water-ui.js — the Water tab. The screen where the fisherman chooses. |
| `js/modules/plan-water.js` | 1426 | 24 | 8 | **1** | plan-water.js — offer the water, with reasons, and let the fisherman choose. |
| `js/modules/qdc-decoder.js` | 520 | 6 | 2 | 0 | qdc-decoder.js — pure functions: raw .qdc folder → grid → contour GeoJSON. |
| `js/modules/quickdraw-key.js` | 95 | 0 | 1 | 0 | Depth key — the legend for the one depth ladder. |
| `js/modules/ramp-cameras.js` | 85 | 2 | 2 | 0 | USGS NIMS camera frames in the boat-ramp popup. |
| `js/modules/ramps.js` | 151 | 3 | 1 | **3** | Boat-ramp layer (concrete ramps across SC/NC/GA/TN, live from state DNR feeds). |
| `js/modules/river-drifts.js` | 347 | 7 | 3 | **1** | A RIVER LEG IS A DRIFT, NOT A LANE. |
| `js/modules/routes-panel.js` | 218 | 0 | 1 | 0 | routes-panel.js — the right slide-in panel. |
| `js/modules/safety-checklist.js` | 114 | 0 | 1 | 0 | Autonomous Safety Checklist — auto-compiles a tactical safety |
| `js/modules/saved-spreads.js` | 82 | 1 | 2 | 0 | Saved rod spreads — name a rod configuration and persist it |
| `js/modules/smart-plan-route.js` | 190 | 3 | 0 | **3** | smart-plan-route.js — turn SmartPlan's intent into geometry the Worker built. |
| `js/modules/smart-plan-ui.js` | 1020 | 8 | 4 | 0 | smart-plan-ui.js — Unified Trip Timeline (Trolling + Stop-and-Cast interleaved) |
| `js/modules/smart-plan-v2-wiring.js` | 647 | 7 | 4 | 0 | smart-plan-v2-wiring.js — the DOM end of SmartPlan v2. |
| `js/modules/smart-plan-v2.js` | 637 | 6 | 7 | 0 | smart-plan-v2.js — the whole plan, one path. |
| `js/modules/species-selector.js` | 450 | 3 | 5 | **1** | species-selector.js — swap the Plan tab's target-species checkboxes between |
| `js/modules/spot-repositioning.js` | 33 | 0 | 1 | 0 | Spot Repositioning — drag a marker (GIS spot, ramp, attractor) |
| `js/modules/spread-builder.js` | 385 | 13 | 6 | **10** | Rod Spread Builder — the table UI in the Plan tab where each rod |
| `js/modules/supplemental-layers.js` | 1494 | 14 | 2 | **12** | supplemental-layers.js — Supplemental PBF-extracted layer integration. |
| `js/modules/sw-register.js` | 13 | 0 | 1 | 0 | Service Worker registration — registers ./sw.js once the page |
| `js/modules/tackle-inventory-ui.js` | 173 | 2 | 3 | 0 | tackle-inventory-ui.js — Collapsible tackle inventory panel in the Plan tab. |
| `js/modules/tide-engine.js` | 336 | 14 | 9 | 0 | tide-engine.js — NOAA CO-OPS tide data as a reusable module. |
| `js/modules/topbar.js` | 179 | 0 | 1 | 0 | Topbar dropdown controls — basemap selector, edit-mode dropdown, |
| `js/modules/track-reverse.js` | 60 | 0 | 1 | 0 | Track Reversal Studio — append a reversed copy of the first |
| `js/modules/usgs-gauges.js` | 170 | 6 | 2 | **3** | usgs-gauges.js — river discharge as a salinity proxy for coastal zones. |
| `js/modules/utility-sync.js` | 162 | 1 | 2 | 0 | Live water conditions for the selected Plan lake — ONE read, one unit. |
| `js/modules/water-search.js` | 201 | 4 | 2 | 0 | water-search.js — search everything TrollMap knows, not everything OpenStreetMap knows. |
| `js/modules/waypoint-to-generator.js` | 33 | 0 | 1 | 0 | One-Click Waypoint → Lane Connect — clicking a waypoint popup |
| `js/modules/wet-hands-remote.js` | 101 | 0 | 1 | 0 | Wet Hands Remote — keyboard + gamepad navigation shortcuts so |
| `js/utils/bench-export.js` | 130 | 3 | 3 | 0 | WRITING OUT WHAT THE BENCH SHOWS — the two pure builders behind the export buttons. |
| `js/utils/bench-read.js` | 105 | 3 | 2 | 0 | READING WHAT WAS SENT AND WHAT CAME BACK — the two pure questions behind the bench. |
| `js/utils/call-global.js` | 70 | 2 | 7 | 0 | callGlobal — invoke a function that another module hung on `window`, without letting it |
| `js/utils/cameras.js` | 172 | 9 | 3 | **2** | Which USGS cameras are on this water, and the newest frame from one. |
| `js/utils/clarity-at-ramp.js` | 139 | 3 | 4 | 0 | clarity-at-ramp.js — WHICH CLARITY ZONE HE IS LAUNCHING IN, AND THEREFORE WHAT THE PLAN IS |
| `js/utils/coastal-optgroups.js` | 69 | 1 | 2 | 0 | coastal-optgroups.js — append one coastal-zone <optgroup> per state to a <select>. |
| `js/utils/coerce.js` | 309 | 10 | 5 | 0 | Coercion helpers for biology arrays that may be malformed in stored profiles. |
| `js/utils/compass.js` | 37 | 2 | 4 | 0 | compass.js — the sixteen-point compass, once. |
| `js/utils/db.js` | 339 | 14 | 18 | 0 | IndexedDB layer for TrollMap persistence. |
| `js/utils/dedupe.js` | 52 | 1 | 2 | 0 | Spatial + text deduplication for boat-ramp launches. |
| `js/utils/depth-palette.js` | 90 | 3 | 5 | 0 | depth-palette.js — ONE depth ladder for every layer that colours by depth. |
| `js/utils/doc-relevance.js` | 311 | 6 | 3 | 0 | doc-relevance.js — the off-lake gate, moved off the Worker. |
| `js/utils/escape.js` | 17 | 1 | 23 | 0 | HTML-escape a string for safe interpolation into innerHTML. |
| `js/utils/geo.js` | 458 | 18 | 12 | **7** | Pure geographic / coordinate math helpers. |
| `js/utils/geojson-coords.js` | 128 | 4 | 4 | 0 | Walking GeoJSON coordinates, and the bounding box that falls out of it. |
| `js/utils/light-state.js` | 424 | 16 | 5 | **3** | light-state.js — WHAT THE LIGHT IS AT A GIVEN MOMENT OF A GIVEN DAY ON A GIVEN WATER. |
| `js/utils/num.js` | 48 | 2 | 4 | 0 | ONE PLACE TO ASK "IS THIS A NUMBER", BECAUSE Number(null) IS 0 AND 0 IS FINITE. |
| `js/utils/oz.js` | 24 | 1 | 4 | 0 | oz.js — weights the way they are written on a packet. |
| `js/utils/pack-facts.js` | 695 | 9 | 4 | **7** | pack-facts.js -- every fact a chartpack can answer on its own, from GeoJSON the caller hol |
| `js/utils/parsers.js` | 325 | 6 | 4 | 0 | Format parsers — GPX, KML, GeoJSON. |
| `js/utils/rod-row.js` | 39 | 1 | 4 | 0 | Build a single rod-spread row with sensible defaults. |
| `js/utils/solunar.js` | 145 | 2 | 4 | 0 | utils/solunar.js — moon-driven feeding windows. ONE implementation. |
| `js/utils/species-phase.js` | 102 | 3 | 1 | 0 | WHAT THE FISH ARE DOING AT THIS HOUR — a stated rule, not invented per-lake numbers. |
| `js/utils/structure-markers.js` | 143 | 4 | 2 | **1** | structure-markers.js — humps and ledges, read from the pack the pipeline builds. |
| `js/utils/viewport-cull.js` | 129 | 7 | 5 | **1** | Viewport culling for big GeoJSON layers. |
| `js/utils/water-conditions.js` | 923 | 7 | 8 | 0 | ONE READ FOR THE STATE OF THE WATER. |
| `js/utils/worker-auth.js` | 63 | 3 | 6 | 0 | utils/worker-auth.js — the shared secret for TrollMap's own Worker, in one place. |
| `js/utils/wqp-limnology.js` | 344 | 10 | 6 | 0 | js/utils/wqp-limnology.js — what the Water Quality Portal pull means, in one place. |
| `sw.js` | 263 | 0 | 0 | 0 | TrollMap service worker — v18 (the shell was frozen at v17, 2026-08-16) |
| `test/a-base-name-must-be-findable-not-unique.test.js` | 132 | 0 | 0 | 0 | TWO JOBS, TWO RULES, AND ONE REGEX WAS DOING BOTH. |
| `test/a-depth-without-a-light-state.test.js` | 160 | 0 | 0 | 0 |  |
| `test/a-lane-the-fitter-refused.test.js` | 90 | 0 | 0 | 0 |  |
| `test/a-norm-is-not-a-measurement.test.js` | 201 | 0 | 0 | 0 | test/a-norm-is-not-a-measurement.test.js |
| `test/a-platform-is-not-a-verdict.test.js` | 138 | 0 | 0 | 0 | A video is judged on whether it names the water, not on being a video. |
| `test/a-rated-depth-came-off-a-box.test.js` | 293 | 0 | 0 | 0 | A RATED DEPTH CAME OFF A BOX, AND THE MODEL WAS READING IT OFF A NAME. |
| `test/a-reach-note-is-not-the-name-of-the-water.test.js` | 120 | 0 | 0 | 0 | A REACH NOTE IS NOT THE NAME OF THE WATER. |
| `test/a-river-leg-is-a-drift-not-a-lane.test.js` | 489 | 0 | 0 | 0 | A RIVER LEG IS A DRIFT, NOT A LANE. |
| `test/a-river-was-asked-for-a-paddle-trip.test.js` | 207 | 0 | 0 | 0 | The river query set spent a query on paddling and had none left for a season. |
| `test/a-river-was-asked-for-a-thermocline.test.js` | 129 | 0 | 0 | 0 | ONE HALF OF THE PIPELINE WAS HUNTING FOR WHAT THE OTHER HALF REFUSES TO REPORT. |
| `test/a-river-was-handed-the-reservoir-queries.test.js` | 162 | 0 | 0 | 0 | A RIVER WAS HANDED THE RESERVOIR QUERIES, BECAUSE THE TABLE WAS KEYED ON THE WRONG THING. |
| `test/a-threshold-is-not-a-contour.test.js` | 235 | 0 | 0 | 0 | A THRESHOLD IS NOT A CONTOUR, AND THE CARD CALLED IT THE TARGET. |
| `test/agency-domains.test.js` | 85 | 0 | 0 | 0 | A TABLE THAT LOOKS LIKE A KNOB AND IS NOT CONNECTED. |
| `test/agency-guidance-block.test.js` | 170 | 0 | 0 | 0 | agency-guidance-block.test.js — the state's own lake page reaches the fisheries agent. |
| `test/agency-pages.test.js` | 224 | 0 | 0 | 0 | The state's own lake index, resolved to the water this app ships. |
| `test/agency-table-lookup.test.js` | 90 | 0 | 0 | 0 | The agency profile tables are keyed by the AGENCY's name for the lake, not by ours. |
| `test/agent-prompt-echo.test.js` | 75 | 0 | 0 | 0 | Agents must not be asked to echo back data they did not produce. |
| `test/arcgis-filter-guard.test.js` | 203 | 0 | 0 | 0 |  |
| `test/bait-depth-ceiling.test.js` | 518 | 0 | 0 | 0 |  |
| `test/book-statewide-browser.test.js` | 174 | 0 | 0 | 0 | THE BOOK ANSWERING WHERE THE MODEL DID NOT. |
| `test/cast-spot-kinds.test.js` | 96 | 0 | 0 | 0 | FIVE THOUSAND CAST SPOTS AND A WINDOW ONTO THIRTY OF THEM. |
| `test/cast-spots-need-no-lane.test.js` | 211 | 0 | 0 | 0 | A CAST SPOT HAS NOTHING TO DO WITH A TROLLING LANE. |
| `test/catch-sync-fits.test.js` | 88 | 0 | 0 | 0 | TEN MEGABYTES OF FISH PHOTOGRAPHS, PUSHED AS ONE DATABASE ROW, EVERY PAGE LOAD. |
| `test/chart-datum.test.js` | 648 | 0 | 0 | 0 | What the chart was drawn at, versus where the water is today. |
| `test/check-imports.mjs` | 137 | 0 | 0 | 0 | check-imports.mjs — every named import across js/ must resolve to a real export. |
| `test/check-lake-geo.mjs` | 311 | 0 | 0 | 0 | check-lake-geo.mjs — a name must map to a lake in the right PLACE. |
| `test/check-lake-keys-parity.mjs` | 57 | 0 | 0 | 0 | !/usr/bin/env node |
| `test/check-tackle-parity.mjs` | 314 | 0 | 0 | 0 | check-tackle-parity.mjs — runner-free tackle parity check. |
| `test/cloud-sync.test.js` | 131 | 0 | 0 | 0 | test/cloud-sync.test.js -- a deleted plan must actually tombstone in the cloud. |
| `test/coastal-agents.test.js` | 274 | 0 | 0 | 0 |  |
| `test/coastal-dropdown.test.js` | 283 | 0 | 0 | 0 |  |
| `test/coastal-landing.test.js` | 125 | 0 | 0 | 0 |  |
| `test/coastal-layers.test.js` | 78 | 0 | 0 | 0 |  |
| `test/coastal-ramps-dynamic.test.js` | 26 | 0 | 0 | 0 |  |
| `test/coastal-regulations-live.test.js` | 528 | 0 | 0 | 0 | THE SAME FILE AS FRESHWATER, AND IT ALWAYS WAS. |
| `test/coastal-regulations.test.js` | 298 | 0 | 0 | 0 |  |
| `test/coastal-scoring.test.js` | 282 | 0 | 0 | 0 |  |
| `test/coastal-zones-parity.test.js` | 192 | 0 | 0 | 0 |  |
| `test/coerce.test.js` | 298 | 0 | 0 | 0 |  |
| `test/conditions-bindings.test.js` | 419 | 0 | 0 | 0 | Harness: exercise handleConditions with a stubbed R2 + stubbed upstreams. |
| `test/conditions-follow-the-ramp.test.js` | 120 | 0 | 0 | 0 | The point you ask about is the answer you get. |
| `test/confidence.test.js` | 157 | 0 | 0 | 0 |  |
| `test/coord-jump.test.js` | 109 | 0 | 0 | 0 | THE JUMP BUTTON WAS WIRED AND RETURNED ON ITS FIRST LINE. |
| `test/credit-guards.test.js` | 228 | 0 | 0 | 0 | THE TWO PLACES A PAID SERVICE'S BALANCE WAS A NUMBER SOMEBODY TYPED. |
| `test/cwms-series.test.js` | 434 | 0 | 0 | 0 | Picking the Corps' pool elevation out of forty-two candidates, and the metres trap. |
| `test/cwms-units.test.js` | 202 | 0 | 0 | 0 | THE CORPS PUBLISHES ITS OWN UNIT TABLE, AND OURS WAS A HAND-TYPED SUBSET OF IT. |
| `test/data-reaches-the-app.test.js` | 329 | 0 | 0 | 0 |  |
| `test/db-writes.test.js` | 232 | 0 | 0 | 0 | test/db-writes.test.js — a write either happened or it did not, and the caller must be abl |
| `test/depth-null-is-not-zero.test.js` | 121 | 0 | 0 | 0 | A DEPTH NOBODY MEASURED IS NOT A DEPTH OF ZERO. |
| `test/depth-palette.test.js` | 140 | 0 | 0 | 0 |  |
| `test/deterministic-regression.test.js` | 58 | 0 | 0 | 0 | ONE OPTIONAL ENRICHMENT COULD TAKE THE WHOLE HANDLER DOWN. |
| `test/discover-authority.test.js` | 106 | 0 | 0 | 0 | authorityForUrl -- the domain-trust ladder shared by the Grok and Wikipedia citation paths |
| `test/dnr-registry-merge.test.js` | 227 | 0 | 0 | 0 |  |
| `test/doc-relevance.test.js` | 188 | 0 | 0 | 0 | The off-lake gate, which could not be tested where it used to live. |
| `test/duke-access-alerts.test.js` | 152 | 0 | 0 | 0 | What is shut, and why the water is where it is. |
| `test/duke-alerts-water.test.js` | 209 | 0 | 0 | 0 | THREE ALERTS FROM THREE OTHER RIVER BASINS, ON ONE WORD. |
| `test/duke-feed-reach.test.js` | 84 | 0 | 0 | 0 | Every lake Duke publishes, reachable — not the nine in the table. |
| `test/duke-lake-row.test.js` | 83 | 0 | 0 | 0 | normalizeDukeRow against the REAL /lakes/current-level response. |
| `test/duke-operating-range.test.js` | 278 | 0 | 0 | 0 | The guide curve, the drought stage as a NUMBER, and where this date usually sits. |
| `test/duke-release-direction.test.js` | 396 | 0 | 0 | 0 | Inflow or outflow: which side of a lake a Duke release comes from. |
| `test/echomap-text.test.js` | 87 | 0 | 0 | 0 | THE TARGET DISPLAY IS A CHARTPLOTTER, NOT A PHONE TRAY. |
| `test/expect-shim.mjs` | 221 | 8 | 140 | 0 | test/expect-shim.mjs -- `describe`/`it`/`expect` on top of node:test and node:assert. |
| `test/facts-are-not-agent-scoped.test.js` | 86 | 0 | 0 | 0 | A FIX BUILT ON A PREMISE NOBODY MEASURED. |
| `test/fake-indexeddb.mjs` | 186 | 2 | 4 | 0 | test/fake-indexeddb.mjs — a small in-memory IndexedDB, enough for utils/db.js. |
| `test/fifteen-of-twenty-four-reached-the-model.test.js` | 95 | 0 | 0 | 0 |  |
| `test/fish-advisories.test.js` | 266 | 0 | 0 | 0 |  |
| `test/fish-it-back.test.js` | 378 | 0 | 0 | 0 |  |
| `test/fishing-reports.test.js` | 413 | 0 | 0 | 0 | The four fishing-report sources, parsed and matched to water this app ships. |
| `test/fixtures.test.js` | 107 | 0 | 0 | 0 |  |
| `test/flow-percentile.test.js` | 102 | 0 | 0 | 0 | Where today's flow sits in this river's own history. |
| `test/ga-demarcation.test.js` | 119 | 0 | 0 | 0 | GEORGIA'S SALTWATER DEMARCATION LINE -- the page that defines a word two tables already us |
| `test/gap-analysis-roster.test.js` | 70 | 0 | 0 | 0 |  |
| `test/geojson-coords.test.js` | 136 | 0 | 0 | 0 | test/geojson-coords.test.js — the bounding box, and the 3D case the old heuristic got wron |
| `test/georgia-oyster-was-looked-for-in-north-carolina.test.js` | 150 | 0 | 0 | 0 | GEORGIA'S OYSTER WAS SEARCHED FOR IN NORTH CAROLINA, AND THE RUN SAID "none in bbox". |
| `test/grid-cut-words.test.js` | 187 | 0 | 0 | 0 | A ROW THE RULED GRID CUT THROUGH IS NOT A LIMIT. |
| `test/hand-written-tables.test.js` | 384 | 0 | 0 | 0 | THE TABLES THAT NEVER GREW WHEN THE APP DID. |
| `test/hazard-cues.test.js` | 238 | 0 | 0 | 0 | NWS WATCHES AND WARNINGS AS ECHOMAP ALERTS. |
| `test/identity-names.test.js` | 162 | 0 | 0 | 0 | identity-names.test.js — the two copies of the identity-name rule must agree, and neither  |
| `test/keys_smoke.mjs` | 104 | 0 | 0 | 0 | keys_smoke.mjs -- prove every shipped lake's display name resolves to its own R2 key. |
| `test/lake-keys-parity.test.js` | 120 | 0 | 0 | 0 |  |
| `test/lake-keys.test.js` | 230 | 0 | 0 | 0 |  |
| `test/lake-name.test.js` | 76 | 0 | 0 | 0 |  |
| `test/lake-picker-groups.test.js` | 220 | 1 | 0 | **1** |  |
| `test/lake-registry.test.js` | 189 | 0 | 0 | 0 | test/lake-registry.test.js -- the registry resolves lake names to the right lake. |
| `test/layer-registry.test.js` | 333 | 0 | 0 | 0 | test/layer-registry.test.js — one owner for layer visibility, and it stays one. |
| `test/layers-panel.test.js` | 181 | 0 | 0 | 0 | test/layers-panel.test.js — the bar stays slim and no toggle goes missing. |
| `test/light-not-the-clock.test.js` | 350 | 0 | 0 | 0 |  |
| `test/limnology-sweep-advances.test.js` | 228 | 0 | 0 | 0 | The WQP sweep must advance past a water it cannot do. |
| `test/live-ramps-reach-the-filter.test.js` | 367 | 0 | 0 | 0 |  |
| `test/mrip-inshore-gate.test.js` | 130 | 0 | 0 | 0 |  |
| `test/nc-striped-bass.test.js` | 77 | 0 | 0 | 0 | NORTH CAROLINA'S STRIPED BASS RULE REACHED NO WATER IN THE STATE. |
| `test/ndbc-realtime2.test.js` | 161 | 0 | 0 | 0 | NDBC realtime2, against rows transcribed from the LIVE files on 2026-08-25. |
| `test/no-agent-writes-the-law.test.js` | 147 | 0 | 0 | 0 | NO LLM WRITES THE LAW ANY MORE. |
| `test/nobody-measured-which-bait-is-best.test.js` | 303 | 0 | 0 | 0 | test/nobody-measured-which-bait-is-best.test.js |
| `test/notification-delivery.test.js` | 246 | 0 | 0 | 0 | THE ONLY PATH IN THIS APP THAT INTERRUPTS RYAN, AND IT HAS NEVER RUN IN THE FIELD. |
| `test/nwps-flood-context.test.js` | 208 | 0 | 0 | 0 | WHAT FLOODS AT WHAT STAGE, AND WHERE TODAY SITS AGAINST THIS GAUGE'S OWN RECORD. |
| `test/nwps-flow-units.test.js` | 72 | 0 | 0 | 0 | The unit that travels with the value, and nothing else. |
| `test/obs-bearing.test.js` | 82 | 0 | 0 | 0 | "WIND 5 MPH FROM 999°" |
| `test/one-prompt-two-planners.test.js` | 397 | 2 | 0 | **2** | ONE PROMPT, TWO PLANNERS, AND ONLY ONE OF THEM FILLING IT IN. |
| `test/operator-levels.test.js` | 217 | 0 | 0 | 0 | The three operators that publish HTML instead of JSON. |
| `test/pack-beats-the-profile.test.js` | 284 | 0 | 0 | 0 | A derivation stored in a profile is a photograph of a chart that has since been replaced. |
| `test/persistence.test.js` | 142 | 0 | 0 | 0 | test/persistence.test.js — one persistence path, and a readiness check that can actually f |
| `test/picker-order.test.js` | 114 | 0 | 0 | 0 |  |
| `test/plan-assemble.test.js` | 811 | 0 | 0 | 0 |  |
| `test/plan-candidates-poi-spots.test.js` | 253 | 0 | 0 | 0 | pois.geojson -> spot features. The layer that carries 17% of Wateree's near[] marks and th |
| `test/plan-depth-band.test.js` | 278 | 0 | 0 | 0 |  |
| `test/plan-export-reads-the-plan.test.js` | 315 | 0 | 0 | 0 |  |
| `test/plan-from-water.test.js` | 297 | 0 | 0 | 0 |  |
| `test/plan-issues.test.js` | 129 | 0 | 0 | 0 |  |
| `test/plan-pieces.test.js` | 179 | 0 | 0 | 0 |  |
| `test/plan-preflight.test.js` | 183 | 0 | 0 | 0 |  |
| `test/plan-prompt.test.js` | 569 | 0 | 0 | 0 |  |
| `test/plan-save-and-battery.test.js` | 163 | 2 | 0 | **1** | TWO FEATURES DELETED FROM THE PAGE, WITH THEIR CODE LEFT RUNNING. |
| `test/plan-to-timeline.test.js` | 281 | 0 | 0 | 0 |  |
| `test/plan-tracks.test.js` | 651 | 0 | 0 | 0 |  |
| `test/plan-water-geometry.test.js` | 255 | 0 | 0 | 0 |  |
| `test/plan-water-state.test.js` | 346 | 0 | 0 | 0 | WHAT THE WATER IS DOING TODAY, and the two prompts it writes. |
| `test/plan-water.test.js` | 286 | 0 | 0 | 0 |  |
| `test/plan-weights.test.js` | 553 | 0 | 0 | 0 |  |
| `test/preflight-knows-the-state.test.js` | 80 | 0 | 0 | 0 | THE REGULATIONS REACHED THE BROWSER AND STOPPED ONE FIELD SHORT OF THE PLANNER. |
| `test/pressure-trend.test.js` | 91 | 0 | 0 | 0 | The barometer, and the eleven-day-old reading that made the staleness guard necessary. |
| `test/prompt-budget.test.js` | 73 | 0 | 0 | 0 | The prompt budget guard, which used to report success and do nothing. |
| `test/proxy-target-type.test.js` | 57 | 0 | 0 | 0 | Whether a proxy target is a PDF, and why the URL has to outrank the caller's type param. |
| `test/push-alerts.test.js` | 324 | 0 | 0 | 0 | WEB PUSH: THE ONLY PATH THAT REACHES RYAN ON THE WATER. |
| `test/qdc-decoder.test.js` | 139 | 0 | 0 | 0 | Behaviour tests for the raw QDC reader and the contour engine on top of it. |
| `test/r2-gzip.test.js` | 149 | 0 | 0 | 0 | r2-gzip.test.js — the Worker must unwrap what the pipeline compresses. |
| `test/ramp-sources.test.js` | 164 | 0 | 0 | 0 |  |
| `test/ramps-reach-research.test.js` | 56 | 0 | 0 | 0 | Why a 41,000-acre reservoir reported "ramps: 0". |
| `test/registry-catalog.test.js` | 66 | 0 | 0 | 0 | test/registry-catalog.test.js -- the registry may answer "what does this site publish", bu |
| `test/registry-grounding.test.js` | 189 | 0 | 0 | 0 | Ground the identity agent on 454 waters instead of 15. |
| `test/registry-passthrough-parity.test.js` | 111 | 1 | 0 | **1** |  |
| `test/registry_smoke.mjs` | 225 | 0 | 0 | 0 | registry_smoke.mjs -- run the REAL lake_index.json through the REAL lake-registry.js and |
| `test/regs-reach-the-plan.test.js` | 136 | 0 | 0 | 0 | THE BOOK WAS PARSED, SHIPPED, SERVED — AND THE PLANNER NEVER SAW IT. |
| `test/regulations-closures.test.js` | 331 | 0 | 0 | 0 | The books can say no, and this is the proof that they say it to the right person on the ri |
| `test/regulations-live.test.js` | 143 | 0 | 0 | 0 | A check that ran, said "I don't know", and showed nothing. |
| `test/regulations-matching.test.js` | 27 | 0 | 0 | 0 |  |
| `test/regulations-wiring.test.js` | 470 | 0 | 0 | 0 | regulations-wiring.test.js — the regulation digest actually reaches the agents |
| `test/research-approve-resolves.test.js` | 119 | 0 | 0 | 0 | Approving a profile must reach the SAME object /research/get returns. |
| `test/research-discover-policy.test.js` | 88 | 0 | 0 | 0 |  |
| `test/research-ids.test.js` | 162 | 0 | 0 | 0 |  |
| `test/research-keys.test.js` | 108 | 0 | 0 | 0 |  |
| `test/research-reaches-the-plan.test.js` | 233 | 0 | 0 | 0 |  |
| `test/research-storage-keys.test.js` | 148 | 0 | 0 | 0 | Which key a lake's research profile is filed under. |
| `test/research-version-read.test.js` | 72 | 0 | 0 | 0 | The version history has to be readable, or it is not history. |
| `test/santee-cooper.test.js` | 202 | 0 | 0 | 0 | SANTEE COOPER PUBLISHES MORE THAN DUKE OR DOMINION, AND I TOLD RYAN FIVE TIMES IT PUBLISHE |
| `test/sc-seasons-prose.test.js` | 73 | 0 | 0 | 0 | SC'S SEASONS BLOCK, AND THE CLOSURE THAT MUST NOT SHUT A LAKE. |
| `test/search-cascade.test.js` | 324 | 0 | 0 | 0 | FIVE OF SIX SEARCHES HAD NO FALLBACK AT ALL. |
| `test/seasonal-drawdown.test.js` | 100 | 0 | 0 | 0 |  |
| `test/sensor-feed.test.js` | 85 | 0 | 0 | 0 | A PUBLIC OPERATOR SENSOR, WHERE NO NETWORK GAUGE EXISTS. |
| `test/shared-latest-pointer.test.js` | 214 | 0 | 0 | 0 | shared-latest-pointer.test.js — latest.json stopped being a second copy of the document. |
| `test/shared-pack.test.js` | 67 | 0 | 0 | 0 |  |
| `test/shared-store-cpu.test.js` | 88 | 0 | 0 | 0 | Tagging a document's sections, on a 10 ms CPU budget. |
| `test/silent-parameters.test.js` | 171 | 0 | 0 | 0 | THE THIRD STATE: a parameter a bound site PUBLISHES and did not answer with. |
| `test/site-catalog.test.js` | 75 | 0 | 0 | 0 | Which parameters a site actually publishes, instead of asking for twelve and seeing what |
| `test/smart-plan-coastal.test.js` | 200 | 0 | 0 | 0 |  |
| `test/smart-plan-route.test.js` | 92 | 0 | 0 | 0 |  |
| `test/smart-plan-v2.test.js` | 585 | 0 | 0 | 0 |  |
| `test/solunar.test.js` | 124 | 0 | 0 | 0 | test/solunar.test.js — one solunar model, and the two consumers cannot drift apart again. |
| `test/species-at-plan-time.test.js` | 421 | 0 | 0 | 0 |  |
| `test/species-form-closes-the-books.test.js` | 168 | 0 | 0 | 0 | species-form-closes-the-books.test.js — the plan form and the four regulation digests agre |
| `test/species-phase.test.js` | 103 | 0 | 0 | 0 | A stated rule instead of invented per-lake numbers. |
| `test/species-selector.test.js` | 138 | 0 | 0 | 0 |  |
| `test/species-traits-block.test.js` | 116 | 0 | 0 | 0 | species-traits-block.test.js — the state's own account of the FISH reaches the fisheries a |
| `test/squeezed-from-both-ends.test.js` | 109 | 0 | 0 | 0 | test/squeezed-from-both-ends.test.js |
| `test/stageflow-trend.test.js` | 84 | 0 | 0 | 0 | Which way the water has been going. |
| `test/statewide-served.test.js` | 96 | 0 | 0 | 0 | THE STATEWIDE TABLE THE BUILD MADE AND NOBODY SERVED. |
| `test/structural-elements-contract.test.js` | 152 | 2 | 0 | **2** |  |
| `test/structure-cache-schema.test.js` | 66 | 0 | 0 | 0 | A RULES CHANGE THAT THE BROWSER NEVER HEARS ABOUT. |
| `test/structure-from-pack.test.js` | 107 | 0 | 0 | 0 | Humps and ledges come from the pack, uncapped, not from the research profile. |
| `test/summary-builders-agree.test.js` | 123 | 0 | 0 | 0 |  |
| `test/supplemental-layer-registry.test.js` | 91 | 0 | 0 | 0 | test/supplemental-layer-registry.test.js — the last two hand-rolled layers stay migrated. |
| `test/surface-sample-dated.test.js` | 156 | 0 | 0 | 0 | AN AUGUST PLAN WAS BEING TOLD THE SURFACE WAS 43.88 DEGREES. |
| `test/sw-shell-freshness.test.js` | 67 | 0 | 0 | 0 | The app shell must not be answered from a cache minted five weeks ago. |
| `test/sync_smoke.mjs` | 121 | 0 | 0 | 0 | sync_smoke.mjs -- prove a deleted plan actually tombstones in the cloud. |
| `test/tackle-parity.test.js` | 292 | 0 | 0 | 0 |  |
| `test/template-literal-tdz.test.js` | 277 | 2 | 0 | 0 |  |
| `test/the-bait-was-nowhere-near-the-fish.test.js` | 119 | 0 | 0 | 0 |  |
| `test/the-bench-reads-what-was-sent.test.js` | 177 | 0 | 0 | 0 |  |
| `test/the-bench-would-not-hand-me-the-plan.test.js` | 170 | 0 | 0 | 0 | test/the-bench-would-not-hand-me-the-plan.test.js |
| `test/the-benthic-layer-was-drawn-as-oyster.test.js` | 117 | 0 | 0 | 0 | THE BENTHIC LAYER WAS DRAWN AS OYSTER, AND IT IS NOT OYSTER. |
| `test/the-cache-was-counted-in-packs-and-spent-in-megabytes.test.js` | 130 | 0 | 0 | 0 | THE CACHE WAS COUNTED IN PACKS AND SPENT IN MEGABYTES. |
| `test/the-card-showed-the-salinity-and-the-plan-had-none.test.js` | 293 | 0 | 0 | 0 | THE CARD SHOWED THE SALINITY AND THE PLAN FOR THE SAME DAY HAD NONE. |
| `test/the-cast-was-in-the-bucket-and-nothing-read-it.test.js` | 149 | 0 | 0 | 0 | test/the-cast-was-in-the-bucket-and-nothing-read-it.test.js |
| `test/the-chart-was-sounded-at-full-pool.test.js` | 80 | 0 | 0 | 0 | test/the-chart-was-sounded-at-full-pool.test.js |
| `test/the-chord-is-a-direction-the-boat-never-travels.test.js` | 229 | 0 | 0 | 0 | THE CHORD IS A DIRECTION THE BOAT NEVER TRAVELS. |
| `test/the-clarity-was-the-average-of-water-he-was-not-fishing.test.js` | 514 | 2 | 0 | **2** | THE PLAN WAS BUILT ON THE MEAN OF SIX ZONES, FIVE OF WHICH HE WAS NOT GOING NEAR. |
| `test/the-clock-refreshes-the-thermocline.test.js` | 250 | 0 | 0 | 0 | test/the-clock-refreshes-the-thermocline.test.js |
| `test/the-clock-runs-at-ground-speed-and-the-draw-does-not.test.js` | 88 | 0 | 0 | 0 | THE DRAW IS AT THROUGH-WATER SPEED AND THE CLOCK RUNS AT GROUND SPEED. |
| `test/the-closed-season-was-in-the-profile-and-nobody-read-it.test.js` | 194 | 0 | 0 | 0 | THE RESEARCH PIPELINE EXTRACTED A CLOSED SEASON AND THE PLANNER NEVER ASKED FOR IT. |
| `test/the-coast-had-no-fish.test.js` | 118 | 0 | 0 | 0 | test/the-coast-had-no-fish.test.js |
| `test/the-day-ran-out-at-eight-in-the-morning.test.js` | 93 | 0 | 0 | 0 | test/the-day-ran-out-at-eight-in-the-morning.test.js |
| `test/the-day-turns-him-around-and-the-clock-usually-wins.test.js` | 132 | 0 | 0 | 0 | THE DAY TURNS HIM AROUND, AND SAYING WHICH CONSTRAINT BINDS IS THE WHOLE VALUE. |
| `test/the-extracted-builder-was-type-checked-and-never-run.test.js` | 177 | 0 | 0 | 0 | THE EXTRACTED BUILDER WAS TYPE-CHECKED AND NEVER RUN. |
| `test/the-fish-depth-and-the-bottom-were-one-number.test.js` | 81 | 0 | 0 | 0 |  |
| `test/the-fish-was-measured-and-nobody-asked.test.js` | 84 | 0 | 0 | 0 | test/the-fish-was-measured-and-nobody-asked.test.js |
| `test/the-forage-was-established-and-thrown-away.test.js` | 128 | 0 | 0 | 0 |  |
| `test/the-head-is-the-weight.test.js` | 361 | 0 | 0 | 0 | the-head-is-the-weight.test.js |
| `test/the-inch-mark-ended-the-string.test.js` | 91 | 0 | 0 | 0 | test/the-inch-mark-ended-the-string.test.js |
| `test/the-plan-shows-what-the-model-was-sent.test.js` | 140 | 0 | 0 | 0 |  |
| `test/the-prompt-was-sent-object-object.test.js` | 69 | 0 | 0 | 0 | the-prompt-was-sent-object-object.test.js — an array of objects joined is not a sentence. |
| `test/the-push-carries-the-words.test.js` | 297 | 0 | 0 | 0 | THE PUSH CARRIES THE WORDS, AND THE RFC SAYS WHETHER IT IS DOING IT RIGHT. |
| `test/the-save-erased-what-it-did-not-manage.test.js` | 80 | 0 | 0 | 0 | test/the-save-erased-what-it-did-not-manage.test.js |
| `test/the-scorer-buried-the-catalpa-worm.test.js` | 112 | 0 | 0 | 0 | The pre-fetch scorer gave a fishing magazine nothing and took nine points off a video. |
| `test/the-search-was-anchored-on-a-phrase-no-page-contains.test.js` | 125 | 0 | 0 | 0 | EVERY RESEARCH SEARCH WAS EXACT-PHRASE-ANCHORED ON A STRING THAT EXISTS NOWHERE. |
| `test/the-shortfall-report-said-six-of-four.test.js` | 79 | 0 | 0 | 0 | test/the-shortfall-report-said-six-of-four.test.js |
| `test/the-spoon-was-flying-a-kite.test.js` | 176 | 0 | 0 | 0 | test/the-spoon-was-flying-a-kite.test.js |
| `test/the-state-was-half-the-name-and-the-resolver-dropped-it.test.js` | 105 | 0 | 0 | 0 | THE STATE WAS HALF THE NAME AND THE RESOLVER DROPPED IT. |
| `test/the-survey-knew-when-and-only-a-research-prompt-was-told.test.js` | 255 | 0 | 0 | 0 | ELEVEN YEARS OF INTERCEPTS, READ BY ONE RESEARCH PROMPT AND NO PLAN. |
| `test/the-tab-shows-what-the-plan-gets.test.js` | 82 | 0 | 0 | 0 |  |
| `test/the-thermocline-was-saved-over.test.js` | 237 | 0 | 0 | 0 | test/the-thermocline-was-saved-over.test.js |
| `test/the-tide-is-the-current-and-fourteen-zones-had-no-station.test.js` | 212 | 0 | 0 | 0 | THE TIDE IS THE CURRENT, AND FOURTEEN OF SIXTEEN COASTAL ZONES HAD NO STATION. |
| `test/the-warning-fired-after-the-answer.test.js` | 80 | 0 | 0 | 0 |  |
| `test/the-water-outranks-the-calendar.test.js` | 115 | 1 | 0 | **1** |  |
| `test/there-is-no-open-band.test.js` | 116 | 0 | 0 | 0 | THERE IS NO SUCH THING AS AN OPEN BAND. This file used to assert the opposite, at length. |
| `test/three-of-nine-reasons-and-the-biggest-was-silent.test.js` | 114 | 0 | 0 | 0 | THREE OF NINE REASONS, AND THE BIGGEST ONE WAS SILENT. |
| `test/tide-engine.test.js` | 182 | 0 | 0 | 0 |  |
| `test/tn-reservoir-pages.test.js` | 99 | 0 | 0 | 0 | TENNESSEE'S RESERVOIR PAGES -- seven pages of law for almost every TN water we offer. |
| `test/tva-reservoir.test.js` | 152 | 0 | 0 | 0 | TVA's four reservoir routes, shaped. |
| `test/two-pickers-two-value-schemes-and-one-resolver.test.js` | 121 | 0 | 0 | 0 | TWO PICKERS, TWO VALUE SCHEMES, AND ONE RESOLVER THAT ONLY KNEW ONE OF THEM. |
| `test/two-tables-that-are-a-sentence-together.test.js` | 292 | 0 | 0 | 0 | THE HABITAT MATRIX AND THE CHARTED BOTTOM, READ BY ONE RESEARCH PROMPT AND NOTHING ELSE. |
| `test/usace-levels.test.js` | 170 | 0 | 0 | 0 | The Corps' conservation pool, evaluated for a date. |
| `test/usgs-dashboard.test.js` | 198 | 0 | 0 | 0 | TWO FACTS THIS APP HAD FOR SOME WATERS AND NOT OTHERS. |
| `test/usgs-gauges.test.js` | 108 | 0 | 0 | 0 |  |
| `test/usgs-series-pick.test.js` | 286 | 0 | 0 | 0 | WHEN A GAUGE HAS TWO SENSORS, WHICH ONE IS THE READING? |
| `test/water-aliases.test.js` | 126 | 0 | 0 | 0 |  |
| `test/water-cameras.test.js` | 144 | 0 | 0 | 0 | One camera roster, two questions, and they are not the same question. |
| `test/water-chain-loader.test.js` | 91 | 0 | 0 | 0 | The chain has to reach the Worker, and a missing object must not look like an empty chain. |
| `test/water-conditions.test.js` | 884 | 0 | 0 | 0 | One read for the state of the water. |
| `test/water-endpoints.test.js` | 305 | 0 | 0 | 0 | water-endpoints.test.js — the compute plane, pinned against the ways it has already broken |
| `test/water-filter.test.js` | 178 | 0 | 0 | 0 |  |
| `test/water-search.test.js` | 96 | 0 | 0 | 0 |  |
| `test/water-straighten.test.js` | 206 | 0 | 0 | 0 |  |
| `test/where-two-pieces-are-one-run.test.js` | 365 | 0 | 0 | 0 | WHERE TWO PIECES ARE ONE RUN. |
| `test/winter-was-the-answer-to-every-bad-date.test.js` | 69 | 0 | 0 | 0 | test/winter-was-the-answer-to-every-bad-date.test.js |
| `test/worker-auth.test.js` | 200 | 0 | 0 | 0 | test/worker-auth.test.js — writes to the Worker are gated, and the client can get through. |
| `test/worker-cors.test.js` | 44 | 0 | 0 | 0 |  |
| `test/worker-data.test.js` | 63 | 0 | 0 | 0 |  |
| `test/worker-external-imports.test.js` | 149 | 0 | 0 | 0 | test/worker-external-imports.test.js — the Worker bundle's reach outside Worker/. |
| `test/wqp-bbox.test.js` | 96 | 0 | 0 | 0 |  |
| `test/wqp-columns.test.js` | 123 | 0 | 0 | 0 | EVERY COLUMN limnology.js LOOKS UP HAS TO EXIST IN THE PROFILE IT ASKED FOR. |
| `test/wwa-hazards.test.js` | 157 | 0 | 0 | 0 | A BLANK IS A SPACE, A WATCH IS NOT A WARNING, AND `event` WAS NEVER AN EVENT. |
| `test/zero-degrees-is-not-a-missing-thermometer.test.js` | 98 | 0 | 0 | 0 | ZERO DEGREES IS NOT A MISSING THERMOMETER. |
| `tools/audit.mjs` | 544 | 0 | 0 | 0 | tools/audit.mjs — generate the map of this codebase, from the codebase. |
| `tools/audit_duplication.mjs` | 159 | 0 | 0 | 0 | !/usr/bin/env node |
| `tools/audit_silent_catches.mjs` | 240 | 0 | 0 | 0 | !/usr/bin/env node |

### Modules nothing imports

- `Scripts/app_offers.mjs` — 67 lines, 0 exports
- `Scripts/lake_depth_stats.mjs` — 103 lines, 0 exports
- `Scripts/make_counties.mjs` — 49 lines, 0 exports
- `Scripts/research_todo.mjs` — 189 lines, 0 exports
- `Scripts/which_profile_serves.mjs` — 269 lines, 0 exports
- `js/modules/smart-plan-route.js` — 190 lines, 3 exports
- `sw.js` — 263 lines, 0 exports

### Exported but never imported by name

- `Worker/cameras.js`: frameStamp, frameUrls, handleCameraFrame, CAMERA_ROUTES
- `Worker/conditions.js`: dukeBasinWhy, isBelowDam, CONDITIONS_ROUTES
- `Worker/core/arcgis.js`: fetchArcGisAllFeatures, getCachedGis
- `Worker/ndbc.js`: NDBC_BASE
- `Worker/reports.js`: REPORT_SOURCES, AHQ_HUBS, ARTICLE_MAX_AGE_DAYS, fetchReports
- `Worker/research/agency-pages.js`: AGENCY_INDEXES, agencyIndexEntries
- `Worker/research/agents.js`: COASTAL_AGENTS, COASTAL_SKIPPED_AGENTS, isCoastalZone, coastalAgentPlan
- `Worker/research/dataset.js`: DATASET_HUNT_TARGETS, DATASET_KEYWORDS, scoreDatasetUrl, buildNepisQueryVariants
- `Worker/research/facts-util.js`: normalizeResearchName, titleCaseWords, NON_GAME_SPECIES, parseSCDNRDescriptionFacts, RESEARCH_RAMP_SOURCES, RESEARCH_ATTRACTOR_SOURCES, fetchArcGISGrouped, stripHtmlPreserveTables, extractHtmlTableRows, extractMarkdownTableRows, slicePdfPageRange, parseSCRegulationsFromHtml
- `Worker/research/shared.js`: SHARED_ENABLED_DEFAULT, sharedEnabled, contentFingerprint, urlToDocId, SECTION_HEADING_PREFIXES, CHUNK_SIZE, CHUNK_OVERLAP, segmentDocument, chunkText, CATEGORY_KEYWORDS, getSharedPointer, getSharedRegistryEntry, isQuarantined
- `js/core/layer-registry.js`: setMapAccessor, hasLayer, layerIds, isEnabled, invalidate, _reset
- `js/core/map-init.js`: onMapClick, fillCoord, suggestName, startPick, clearPreview, showPreview
- `js/data/cameras.js`: NIMS_S3
- `js/data/fishing-style-profile.js`: isLiveBaitTechnique, isSaltwaterBait, isLiveBaitAvailable, canHoldStation
- `js/data/ga-access-species.js`: GA_ACCESS_SPECIES_COLUMNS
- `js/data/lure-knowledge.js`: getSpeedRange
- `js/data/registry-loader.js`: REGISTRY_CACHE_MS
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
- `js/modules/gis-toggles.js`: getFishAttractors
- `js/modules/gps.js`: startGPS, stopGPS, wireGpsButtons
- `js/modules/lake-research-engine.js`: runAgents, runAgent, assembleAndSaveProfile, packDerivedFacts, getCoastalR2Key, getCoastalZoneMeta
- `js/modules/lake-research.js`: initLakeResearch, loadProfile, saveCurrentResearchProfile, populateResearchLakeDropdown, runFullPipeline, runResume
- `js/modules/layers-panel.js`: isOpen, close
- `js/modules/noaa-tides.js`: stageLabel
- `js/modules/plan-candidates.js`: AMPS_REF_MPH, AMPS_REF_A, AMPS_EXP, groupDocks, sliceLine, catchSupport, pointToSegmentM
- `js/modules/plan-pieces.js`: stretchCoords
- `js/modules/plan-tracks.js`: stopName
- `js/modules/plan-water.js`: ampHoursAlong
- `js/modules/ramps.js`: toggleRampLayer, buildRampLayer, toggleChartLayersPanel
- `js/modules/river-drifts.js`: DRIFT_JOIN_KINDS
- `js/modules/smart-plan-route.js`: requestPlan, renderPlan, describePlan
- `js/modules/species-selector.js`: refreshSpeciesChecks
- `js/modules/spread-builder.js`: ROD_PRESETS, REEL_PRESETS, COLOR_PRESETS, ARIG_WEIGHTS, JIGHEAD_WEIGHTS, TRAILER_SIZES, jigheadForRod, depthWindow, leadForDepth, isLeadControlled
- `js/modules/supplemental-layers.js`: STRUCTURE_RULES_AT_BUMP, getStructureGeoJSON, getDepthAreaGeoJSON, getLakeBoundaryGeoJSON, bringDepthAreasToBack, redrawDepthAreas, loadSupplementalForLake, getSupplementalContext, refreshDepthAreaColors, getOsmStructures, LAKE_NAME_TO_R2_KEY, resolveR2Key
- `js/modules/usgs-gauges.js`: fetchCurrentDischarge, fetchMeanDischarge, assessSite
- `js/utils/cameras.js`: kmBetween, FRAME_TTL_MS
- `js/utils/geo.js`: distMiFromCoords, bearing, bearingFromCoords, destination, distToRingFt, ftToDegLat, ftToDegLon
- `js/utils/light-state.js`: LIGHT_PHRASES, lightKindOf, skyAt
- `js/utils/pack-facts.js`: deriveDepthStatistics, getBoundaryOuterRing, structuresFromPack, waterFeaturesFromPack, deriveDepthAreaStructures, derivePoiStructures, bottomCompositionFromPois
- `js/utils/structure-markers.js`: holesFromPack
- `js/utils/viewport-cull.js`: featureBBox
- `test/lake-picker-groups.test.js`: pickerLabel
- `test/one-prompt-two-planners.test.js`: assemblePlan, planRoute
- `test/plan-save-and-battery.test.js`: autoPlanName
- `test/registry-passthrough-parity.test.js`: _resetIndexCache
- `test/structural-elements-contract.test.js`: humpsFromPack, ledgesFromPack
- `test/the-clarity-was-the-average-of-water-he-was-not-fishing.test.js`: syncClarityIntelData, fetchClarityAtRamp
- `test/the-water-outranks-the-calendar.test.js`: getSeason

## Same function name in more than one file

- `walk()` — js/utils/viewport-cull.js:20, test/check-imports.mjs:48, test/data-reaches-the-app.test.js:34, test/hand-written-tables.test.js:290, test/persistence.test.js:27, test/worker-auth.test.js:29, test/worker-external-imports.test.js:43, tools/audit.mjs:56, tools/audit_duplication.mjs:73, tools/audit_silent_catches.mjs:189
- `wireButtons()` — js/modules/catch-journal.js:1414, js/modules/chart-mosaic.js:390, js/modules/chart-overlay.js:387, js/modules/edit.js:236, js/modules/file-io.js:52, js/modules/ramps.js:137, js/modules/saved-spreads.js:73, js/modules/spread-builder.js:349, js/modules/topbar.js:10
- `init()` — js/modules/coastal-layers.js:338, js/modules/gis-toggles.js:263, js/modules/layers-panel.js:70, js/modules/routes-panel.js:131, js/modules/species-selector.js:430, js/modules/supplemental-layers.js:1453
- `run()` — js/modules/plan-bench.js:164, test/conditions-bindings.test.js:235, test/plan-weights.test.js:103, test/plan-weights.test.js:155, test/silent-parameters.test.js:103, test/smart-plan-v2.test.js:19
- `leg()` — test/fish-it-back.test.js:43, test/plan-assemble.test.js:26, test/plan-export-reads-the-plan.test.js:28, test/plan-tracks.test.js:30, test/the-plan-shows-what-the-model-was-sent.test.js:31
- `cacheGet()` — Worker/water.js:97, js/modules/tide-engine.js:27, js/modules/usgs-gauges.js:28, js/utils/db.js:273
- `cacheSet()` — Worker/water.js:105, js/modules/tide-engine.js:37, js/modules/usgs-gauges.js:35, js/utils/db.js:288
- `getMap()` — js/modules/coastal-layers.js:74, js/modules/gis-toggles.js:16, js/modules/osm-structure.js:40, js/modules/supplemental-layers.js:215
- `mapReady()` — js/modules/coastal-layers.js:76, js/modules/gis-toggles.js:20, js/modules/osm-structure.js:42, js/modules/supplemental-layers.js:217
- `say()` — js/modules/lake-intel.js:24, js/modules/lake-intel.js:288, js/modules/noaa-tides.js:77, js/modules/utility-sync.js:25
- `esc()` — js/modules/conditions-strip.js:72, js/modules/lake-research-ui.js:357, js/utils/escape.js:1
- `wire()` — js/modules/conditions-strip.js:720, js/modules/lake-ramp-select.js:475, js/modules/noaa-tides.js:64
- `makeEnv()` — test/conditions-bindings.test.js:76, test/limnology-sweep-advances.test.js:27, test/mrip-inshore-gate.test.js:62
- `withFetch()` — test/credit-guards.test.js:26, test/cwms-series.test.js:194, test/usgs-series-pick.test.js:20
- `lane()` — test/plan-pieces.test.js:77, test/plan-water.test.js:14, test/where-two-pieces-are-one-run.test.js:31
- `json()` — Worker/cameras.js:48, Worker/water.js:127
- `cached()` — Worker/conditions.js:93, Worker/reports.js:535
- `getJson()` — Worker/conditions.js:104, js/modules/usgs-gauges.js:84
- `getText()` — Worker/conditions.js:110, Worker/research/agency-pages.js:164
- `kmBetween()` — Worker/conditions.js:659, js/utils/cameras.js:40
- `num()` — Worker/ndbc.js:46, js/utils/num.js:42
- `sampleDated()` — Worker/research/facts-util.js:878, js/modules/lake-research-engine.js:478
- `sanitizeLakeId()` — Worker/research/keys.js:1, js/data/research-ids.js:24
- `stripLakeQualifiers()` — Worker/research/keys.js:23, js/data/research-ids.js:108
- `researchStorageId()` — Worker/research/keys.js:55, js/data/research-ids.js:102
- `legacyStorageName()` — Worker/research/keys.js:77, js/data/research-ids.js:119
- `researchStorageIdCandidates()` — Worker/research/keys.js:94, js/data/research-ids.js:129
- `resolveLakeKey()` — Worker/trollmap-worker.js:431, js/data/species-intel.js:153
- `isEnabled()` — js/core/layer-registry.js:97, js/modules/notifications.js:644
- `show()` — js/core/layer-registry.js:126, sw.js:206
- `toggle()` — js/core/layer-registry.js:167, js/modules/layers-panel.js:68
- `getWorkerBase()` — js/data/access-index.js:73, js/modules/gis-toggles.js:51
- `formatAccessLabel()` — js/data/access-index.js:360, js/modules/lake-ramp-select.js:210
- `workerBase()` — js/data/lake-registry.js:82, sw.js:135
- `openDB()` — js/data/tackle-inventory.js:343, js/utils/db.js:28
- `normalizeRows()` — js/lazy-data.js:1, js/modules/gis-toggles.js:47
- `row()` — js/modules/conditions-strip.js:98, js/modules/plan-water-ui.js:353
- `paint()` — js/modules/conditions-strip.js:638, js/modules/plan-water-ui.js:709
- `setAtPath()` — js/modules/lake-research-engine.js:813, js/modules/lake-research-ui.js:69
- `put()` — js/modules/plan-builder.js:2728, js/utils/db.js:113

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
| `window.TROLLMAP_WORKER_URL` | Scripts/research_todo.mjs<br>test/identity-names.test.js | **nothing** |
| `window.TrollMapData` | js/lazy-data.js | **nothing** |
| `window.TrollMapFishingIndex` | js/modules/fishing-index.js | **nothing** |
| `window.WET_HANDS_ACTIVE` | js/modules/wet-hands-remote.js | **nothing** |
| `window.__rampsLayerVisible` | js/modules/ramps.js | js/modules/supplemental-layers.js |
| `window.__smartPlanV2Owns` | js/modules/smart-plan-v2-wiring.js | **nothing** |
| `window._groqPlanTimeline` | — | js/modules/plan-builder.js |
| `window._osmActiveLakeKey` | js/modules/supplemental-layers.js | js/modules/osm-structure.js |
| `window._planV2` | js/modules/plan-water-ui.js<br>js/modules/smart-plan-v2-wiring.js<br>test/plan-export-reads-the-plan.test.js<br>test/the-plan-shows-what-the-model-was-sent.test.js | js/modules/plan-builder.js<br>test/plan-export-reads-the-plan.test.js |
| `window._planV2Gpx` | js/modules/plan-water-ui.js<br>js/modules/smart-plan-v2-wiring.js | **nothing** |
| `window._planV2NoGo` | js/modules/plan-water-ui.js<br>js/modules/smart-plan-v2-wiring.js | **nothing** |
| `window._planV2Result` | js/modules/plan-water-ui.js<br>js/modules/smart-plan-v2-wiring.js<br>test/the-plan-shows-what-the-model-was-sent.test.js | js/modules/plan-builder.js<br>test/the-plan-shows-what-the-model-was-sent.test.js |
| `window._seedOsmStructureData` | js/modules/supplemental-layers.js | **nothing** |
| `window._smartPlanCastRods` | — | js/modules/plan-builder.js |
| `window._smartPlanPhaseRoutes` | js/modules/plan-builder.js | js/modules/plan-builder.js |
| `window._smartPlanRationale` | — | js/modules/plan-builder.js |
| `window._smartPlanRouteRods` | js/modules/smart-plan-ui.js | js/modules/plan-builder.js |
| `window._smartPlanRouteSpeeds` | js/modules/smart-plan-ui.js | js/modules/plan-builder.js |
| `window._smartPlanRunId` | js/modules/smart-plan-route.js | **nothing** |
| `window._smartPlanSolunar` | test/solunar.test.js | **nothing** |
| `window._smartPlanStopCandidates` | js/modules/smart-plan-ui.js | js/modules/plan-builder.js |
| `window._smartPlanTimeline` | js/modules/smart-plan-ui.js | js/modules/plan-builder.js<br>js/modules/smart-plan-ui.js |
| `window._smartRouteGeoJSON` | js/modules/contour-data.js | **nothing** |
| `window._spEditRod` | js/modules/smart-plan-ui.js | js/modules/smart-plan-ui.js |
| `window._trollmapSolunar` | js/modules/plan-builder.js | js/modules/notifications.js<br>test/solunar.test.js |
| `window._trollmapTide` | js/modules/noaa-tides.js<br>js/modules/supplemental-layers.js | js/modules/noaa-tides.js<br>js/modules/supplemental-layers.js |

## Pipeline scripts

| script | flags | purpose |
|---|---|---|
| `Scripts/_pattr.py` | — |  |
| `Scripts/albers_inv.py` | — | Inverse of lookup_3dhp.albers -- EPSG:6350 metres back to WGS84 lon/lat. |
| `Scripts/apply_drawn_coast.py` | --registry --lines --cell-m --only --go | !/usr/bin/env python3 |
| `Scripts/area_audit.py` | — | !/usr/bin/env python3 |
| `Scripts/attach_arms.py` | --worklist --gpkg --boundaries --slug --max-overlap --pad-km --go | !/usr/bin/env python3 |
| `Scripts/audit_boundary_rings.py` | --registry --boundaries --fix --min-cover --min-mine --max-drift --min-pct --only | !/usr/bin/env python3 |
| `Scripts/audit_drive_sources.py` | --root --json --all --unknown-min-mb --min-mb --exclude --quiet | audit_drive_sources.py -- what is on the drive, and what the pipeline actually reads. |
| `Scripts/audit_limnology_gaps.py` | --registry --min-acres --out | !/usr/bin/env python3 |
| `Scripts/audit_packs.py` | --packs --registry --report --baseline --tolerance --strict --min-samples --min-off --only --limit -v | audit_packs.py - is the pipeline making the packs better or worse? |
| `Scripts/audit_packs_vs_extract.py` | --extract --packs --registry --map --min-vertices --top | !/usr/bin/env python3 |
| `Scripts/audit_research_fields.py` | --repo --profiles --worker --profile-cache --refresh-profiles --out --show | !/usr/bin/env python3 |
| `Scripts/audit_scripts.py` | --dir --manifest --sort --go --files | audit_scripts.py — which of the 239 scripts in scripts/ are still load-bearing. |
| `Scripts/audit_upstream_fields.py` | --repo --capture --dir --out --exclude --decisions --show-decided --self-test | audit_upstream_fields.py -- WHAT DOES THE UPSTREAM SEND THAT NOTHING IN THIS REPO READS? |
| `Scripts/bathy_graph.py` | --root --registry --pack --only-lakes --all-packs --scope --coarsen --out-name --report --dry-run --overwrite | Build a water graph from OUR OWN bathymetry instead of Garmin's MAR mesh. |
| `Scripts/bind_dams_to_waters.py` | --registry --dams --max-km --tolerance --owner --json | bind_dams_to_waters.py -- bind USACE dams to registry waters by WHERE THEY ARE, and make each |
| `Scripts/bind_ndbc_stations.py` | --registry --active --margin-km --write | bind_ndbc_stations.py -- attach NDBC weather and water-quality stations to registry slugs. |
| `Scripts/bind_operator_lakes.py` | --registry --pagesrc --write | bind_operator_lakes.py -- attach utility-operator level feeds to registry slugs. |
| `Scripts/bind_water_levels.py` | --root --registry --go | !/usr/bin/env python3 |
| `Scripts/boundary_from_3dhp.py` | --gpkg --id --slug --name --state --out-dir --dry-run | boundary_from_3dhp.py -- a registry boundary from a 3DHP id, with no name matching anywhere. |
| `Scripts/boundary_gaps.py` | --gpkg --coverage --boundaries --out --bbox --min-acres --gap | boundary_gaps.py -- shipped packs that are missing an arm of their own lake. |
| `Scripts/build_agency_lake_facts.py` | --root --state --limit --registry --out --chartpack | registry/agency_lake_facts.json -- what the state agencies already publish about our waters. |
| `Scripts/build_all_chartpacks.py` | --extract --registry --map --out --report --buffer-m --states --min-charted --only-layers --limit --only-tiles --ship-list --require-depth-area --report-only --only-lakes --keep-zoom --max-segment-m | !/usr/bin/env python3 |
| `Scripts/build_camera_index.py` | --registry --app --margin-km --raw | build_camera_index.py - bake a footprint-only USGS NIMS camera index. |
| `Scripts/build_chartpack.py` | --extract --key --bbox --boundary --buffer-m --ac --out --archive | build_chartpack.py - turn per-tile extractor output into one lake's R2 chartpack. |
| `Scripts/build_coverage_cache.py` | --extract --out --region --force | !/usr/bin/env python3 |
| `Scripts/build_data_map.py` | --registry --repo --out | !/usr/bin/env python3 |
| `Scripts/build_dnr_ramps_by_lake.py` | --registry --state --tol-m --from-dump --no-geometry --compare --curated-report --self-test --go | !/usr/bin/env python3 |
| `Scripts/build_document_limnology.py` | --registry --go | !/usr/bin/env python3 |
| `Scripts/build_duke_dam_table.py` | --registry --json | build_duke_dam_table.py -- which Duke powerhouse forms which water, checked against evidence. |
| `Scripts/build_fishbase_traits.py` | --registry --go --limit --refresh --delay --timeout | !/usr/bin/env python3 |
| `Scripts/build_full_pool_hunt.py` | --root --runs-field --min-runs --min-acres --worth-it-acres --table-cut --out-md --out-json | Build the full-pool hunt list -- the waters that still have no full-pool datum. |
| `Scripts/build_garmin_water_inventory.py` | --extract --out --geojson-dir --tol --box-frac --min-acres --zoom --at --radius-km --index --region-mask --no-region --max-boxiness --coverage --min-da-share --boundaries --arm-km | !/usr/bin/env python3 |
| `Scripts/build_hylak_crosswalk.py` | --registry --shp --go | !/usr/bin/env python3 |
| `Scripts/build_lake_drainage.py` | --registry --min-order --max-reaches --no-reaches --out --only --limit --min-acres -v | build_lake_drainage.py - derive each lake's catchment, and with it how fast it stains. |
| `Scripts/build_lake_registry.py` | --gpkg --out --bbox --min-area-km2 --types --precision --states-geojson --state-order --time-budget --state --restart --list-types | build_lake_registry.py — the single lake list, built straight from 3DHP, keyed by GNIS id. |
| `Scripts/build_lake_rivers.py` | --gpkg --registry --out --min-share --max-names --pad-km --only --limit --index-only | !/usr/bin/env python3 |
| `Scripts/build_mrip_inshore.py` | --root --min-intercepts --top --dry-run | build_mrip_inshore.py -- the inshore roster and its seasons, measured instead of named. |
| `Scripts/build_nc_species_by_lake.py` | --registry --areas --out --cache --sleep --refresh --date --nc-pages --stocking-root --go | !/usr/bin/env python3 |
| `Scripts/build_regulations_table.py` | --root --regs --tn-html --registry --read --out --dry-run | registry/regulations_table.json -- one table of fishing law per state, built from the books. |
| `Scripts/build_river_centrelines.py` | --registry --chartpack --gpkg --report --only --step --window --mask-cell --probe --depth-cell --no-depth --max-width-m --trib-m --min-chain-m --dry-run --quiet | build_river_centrelines.py -- give every river a centreline, a direction and a curvature, and stamp |
| `Scripts/build_species_habitat_weights.py` | --root --dry-run | build_species_habitat_weights.py -- species x habitat weights, from a published ranking. |
| `Scripts/build_species_traits.py` | --root --out --go | !/usr/bin/env python3 |
| `Scripts/build_structure.py` | --packs --registry --force --report --only-lakes --limit --ship-only --all-packs --index --jobs --min-score | build_structure.py - humps, ledges and slope for every lake, from geometry alone. |
| `Scripts/build_thermocline_norms.py` | --registry --repo --go | !/usr/bin/env python3 |
| `Scripts/build_trolling_runs.py` | --packs --min-len-m --simplify-m --reach-m --annotate-m --chord-m --chord-tol-dm --chord-samples --only --only-lakes --force --jobs --report --registry --ship-only | build_trolling_runs.py - turn stored contour fragments into runs a boat can actually troll. |
| `Scripts/build_water_advisories.py` | --registry --key --cycle --out -v | build_water_advisories.py - EPA ATTAINS impairments, bound to waters CONSERVATIVELY. |
| `Scripts/build_water_bindings.py` | --registry --cache --out --report --review-out --lake-rivers --overrides --stage --margin-km --force --pause | build_water_bindings.py - bind every water in the registry to its gauges and operator. |
| `Scripts/build_water_chain.py` | --nhd --registry --out --bindings --no-bindings --links --no-links --only --write --show --layers | build_water_chain.py -- work out which of Ryan's waters sit above which, from NHDPlus HR, |
| `Scripts/build_water_features.py` | --packs --relief-m --curve-m --probe-m --min-bulge-m --sep-m --mouth-m --annotate-m --only --only-lakes --force --report --registry --ship-only | build_water_features.py - derive the structure types the fishing intel actually asks for. |
| `Scripts/build_water_graphs.py` | --tiles --tiles-fallback --registry --map --out --layer --seam-m --buffer-m --only-lakes --force --limit --report | build_water_graphs.py - a routing graph over navigable water, one per lake. |
| `Scripts/build_water_names.py` | --registry --out --go --boundaries | !/usr/bin/env python3 |
| `Scripts/capability_census.py` | --registry --dev --root --out | capability_census.py - what this app can actually answer, per water, as a number. |
| `Scripts/capture_upstreams.py` | --repo --registry --out --water --host --subst --timeout --list --all --self-test | capture_upstreams.py -- find every upstream URL IN THE CODE, fill in its holes, fetch it, save |
| `Scripts/chart_currency.py` | --manifest --against --pattern --registry --only-mine --ship-list | !/usr/bin/env python3 |
| `Scripts/check_body_is_one_water.py` | --extract --index --bodies --slug-file --out --cell-m --lat-ref --min-cells --max-tiles --resume | !/usr/bin/env python3 |
| `Scripts/check_garmin_bathymetry.py` | --extract --bodies --index --slugs --slug-file --out --max-tiles --resume | !/usr/bin/env python3 |
| `Scripts/check_pipeline_parity.py` | — | check_pipeline_parity.py — the lists that must agree, checked before a build. |
| `Scripts/check_registry_invariants.py` | --registry --spread-factor --quiet --map --source --report | !/usr/bin/env python3 |
| `Scripts/check_start_here.py` | --root --repo --facts --bless --list | !/usr/bin/env python3 |
| `Scripts/classify_salt_fresh.py` | --line --feeds --self-test --show | !/usr/bin/env python3 |
| `Scripts/coastal_catalog.py` | — | coastal_catalog.py — TrollMap coastal/tidal zone definitions for SC and GA. |
| `Scripts/coastal_pinch.py` | --packs --feeds --radius-km --only --ramp-tolerance-m --write --go --list-lost | !/usr/bin/env python3 |
| `Scripts/coastal_preview.py` | --packs --feeds --radius-km --only --out --simplify | !/usr/bin/env python3 |
| `Scripts/compare_index_names.py` | --before --after --show | !/usr/bin/env python3 |
| `Scripts/consolidate_lake_index.py` | --registry --charted --out --states --max-km --keep-unbuildable --packs --keep-closed --min-charted --keep-unnamed --keep-packless --region-mask --ship-keep --no-region --ship-list --tile-list --dropped-report --names --aliases --counties | consolidate_lake_index.py - fold every lake list in the app into ONE record per lake. |
| `Scripts/convert_hotspots_to_geojson.py` | — | convert_hotspots_to_geojson.py — Converts tristate_hotspot.json array to GeoJSON. |
| `Scripts/cut_boundaries_batch.py` | --worklist --gpkg --registry --stage --legacy --pad-km --kinds --extract --labels --no-gate --gate-report --limit --dry-run | !/usr/bin/env python3 |
| `Scripts/declare_species_with_no_home.py` | --registry --table --write | declare_species_with_no_home.py - close the vocabulary against the books, without guessing. |
| `Scripts/deep_lakes.py` | --packs --index --all --csv | !/usr/bin/env python3 |
| `Scripts/derive_nes_limnology.py` | --registry --go | !/usr/bin/env python3 |
| `Scripts/derive_waterbodies.py` | --tiles --out --cell-m --min-cells --per-feature --lat-ref --jobs --limit --force | derive_waterbodies.py — find the lakes from the CONTOURS, not from a boundary file. |
| `Scripts/derived_bboxes.py` | — | Generated by trollmap_bbox_derivation.py |
| `Scripts/diagnose_mar_adj.py` | --tiles --registry --lake --layer --max-tiles | !/usr/bin/env python3 |
| `Scripts/diff_profile_versions.py` | --registry --before --lake --show-versions | !/usr/bin/env python3 |
| `Scripts/dump_lbl_pool.py` | --navaids-only --walk --limit | dump_lbl_pool.py - print a GMP tile's label pool as plain text. |
| `Scripts/extract_coastal_habitat.py` | --zone --zones --dry-run --no-gzip --skip-upload --list-layers --inspect | extract_coastal_habitat.py — Extract and clip coastal habitat data to TrollMap |
| `Scripts/extract_enc_seabed.py` | --root --zone --min-band --upload --dry-run --list-layers | extract_enc_seabed.py -- bottom composition out of the NOAA charts we already have. |
| `Scripts/fetch_agency_lake_pages.py` | --state --refresh --root --go --force --delay --allow-shrink | !/usr/bin/env python3 |
| `Scripts/fetch_dnr_paddle.py` | --state --out --stdout --compare | Pull paddle-launch access sites straight from the four state DNR ArcGIS feeds. |
| `Scripts/fetch_duke_pool.py` | --root --registry --captures --cache --out --offline --go --delay | !/usr/bin/env python3 |
| `Scripts/fetch_ehydro_surveys.py` | --root --zone --since --dry-run | fetch_ehydro_surveys.py -- index the USACE channel surveys that cover our water. |
| `Scripts/fetch_ga_lakes.py` | — |  |
| `Scripts/fetch_licor_dashboard.py` | --dashboard --days --limit --interval --out-dir | Read any PUBLIC LI-COR Cloud (Davra) dashboard: discover its sensors, pull their data. |
| `Scripts/fetch_nc_fish_advisories.py` | --registry --go --from-raw --max-km | !/usr/bin/env python3 |
| `Scripts/fetch_nla_limnology.py` | --registry --go --refresh --years | !/usr/bin/env python3 |
| `Scripts/fetch_noaa_current_stations.py` | --root --stations --save-raw --max-km --dry-run | fetch_noaa_current_stations.py -- bind NOAA tidal-current stations to the coastal zones. |
| `Scripts/fetch_osm_coastal.py` | --zone --dry-run --list | fetch_osm_coastal.py — Extracts fishing-relevant OSM structures for TrollMap |
| `Scripts/fetch_osm_structures.py` | --lake --dry-run --no-gzip --list --out-dir --no-local --catalog-only --from-cache --jobs --index --pbf --keep-tmp | !/usr/bin/env python3 |
| `Scripts/fetch_sc_fish_advisories.py` | --registry --from-raw --dry-run | fetch_sc_fish_advisories.py -- SC fish consumption advisories as a species presence floor. |
| `Scripts/find_affected_tiles.py` | --extract --map --out --limit | Which tiles must be re-extracted after the 2026-08-21 depth fixes, and which lakes rebuilt. |
| `Scripts/find_duplicate_waters.py` | --registry --pad --min-box --engine --json | find_duplicate_waters.py -- find registry waters that are the same water under two slugs. |
| `Scripts/find_r2_orphans.py` | --packs --manifest --out --quiet-seconds --force | find_r2_orphans.py -- list R2 objects whose local file is gone, and REFUSE to do it if the |
| `Scripts/fit_trolling_runs.py` | --packs --only --ship-only --registry --max-turn-deg --min-leg-m --min-fit-m --min-stretch-m --resample-m --max-pts --grid-m --max-cells --safety-cells --deep-bias-m --deep-bridge-m --deep-bridge-dm --bridge-m --bridge-dm --seed-push-m --tol-dm --ceiling-dm --iters --only-lakes --jobs --structure-seed-m --structure-min-leg-m --relief-m --no-structure-seeds --envelope-m --envelope-step-m --annotate-m --reach-m --backup-dir --limit --refit --dry-run --report | fit_trolling_runs.py - turn stitched contours into lines a boat can actually be steered along. |
| `Scripts/gen_coastal_zones_js.py` | — | gen_coastal_zones_js.py — generate js/data/coastal-zones.js from coastal_catalog.py. |
| `Scripts/gen_water_aliases_js.py` | --dir --index --lake-keys --registry-boundaries --out --check | !/usr/bin/env python3 |
| `Scripts/geomcore.py` | — | Overlap measurement for find_duplicate_waters.py, fastest available engine first. |
| `Scripts/gmapmf_areas_v51.py` | — | GMAPMF area-region (RGN1) record walk. B2, 2026-08-01, partial. |
| `Scripts/gmapmf_decode_v40.py` | --out --level | !/usr/bin/env python3 |
| `Scripts/gmapmf_labels_v50.py` | — | !/usr/bin/env python3 |
| `Scripts/gmapmf_lines_v50.py` | — | GMAPMF line-region decoder v50 -- chain by closure, tag-priority records. |
| `Scripts/gmapmf_mar_v1.py` | — | GARMIN NGSR MAR reader — the auto-guidance safe-water mesh that ships |
| `Scripts/gmapmf_regions_v51.py` | — | Tile-level decoders for the LINE and AREA regions, on the corrected framing. |
| `Scripts/harvest_operator_pools.py` | --pagesrc --registry --out --tolerance-ft | harvest_operator_pools.py - read the OPERATOR pages already on disk and emit full pool. |
| `Scripts/id_unclaimed_water.py` | --in --out --gpkg --index --radius --grid --min-acres --flow-m --min-cover --min-da --allow-no-da --include-attached --include-narrow --limit | !/usr/bin/env python3 |
| `Scripts/in_region.py` | --mask --check --audit-registry --index --boundaries --out | !/usr/bin/env python3 |
| `Scripts/index_waterbodies.py` | --src --out --threads --resume | index_waterbodies.py — reduce the 100 GB waterbodies_named/ folder to a ~10 MB index. |
| `Scripts/install_registry_boundary.py` | --registry --boundaries --labels --lake --from-tsv --state --name --go | !/usr/bin/env python3 |
| `Scripts/label_water_states.py` | --registry --shp --states --step --min-share --out | label_water_states.py - which states each water actually touches, from its own shape. |
| `Scripts/lake_catalog.py` | — | !/usr/bin/env python3 |
| `Scripts/lookup_3dhp.py` | --gpkg --near --radius --gnis --name --limit | lookup_3dhp.py -- ask the 3DHP GeoPackage what it knows about a water. |
| `Scripts/make_coastal_boundaries.py` | --catalog --out --only --go | !/usr/bin/env python3 |
| `Scripts/make_key_map.py` | --lake-keys --slugs --out --max-km | make_key_map.py - decide which R2 key each registry lake writes to, BEFORE anything uploads. |
| `Scripts/make_osm_ramps_by_lake.py` | --registry --ramps --margin-m --go | !/usr/bin/env python3 |
| `Scripts/make_region_mask.py` | --shp --out --states --cell --pad-km --poly --label | !/usr/bin/env python3 |
| `Scripts/make_river_boundaries.py` | --gpkg --feeds --out --sidecars --index --only --narrow-region --flowing-only --ramp-tol --join-tol --no-split --salt-line --catalog --coastal-slack-km --extract --garmin-cache --max-reach-km --pad-km --min-km2 --lakes --go | !/usr/bin/env python3 |
| `Scripts/mar_route.py` | — | mar_route.py - turn a MAR layer into a navigable-water routing graph and route on it. |
| `Scripts/match_waters_to_nhd.py` | --registry --nhd --only --gdb --min-overlap --min-area-ratio --json | match_waters_to_nhd.py -- bind registry waters to NHD waterbodies by the ground they cover, |
| `Scripts/measure_gwrap.py` | --gdb --layers --attrs | measure_gwrap.py — what G-WRAPData2021 holds for the zones the app actually offers. |
| `Scripts/merge_ac_pois.py` | --packs --registry --db --only-lakes --radius-m --list --dry-run | !/usr/bin/env python3 |
| `Scripts/merge_duplicate_waters.py` | --registry --decisions --bindings --tab --write | merge_duplicate_waters.py -- fold one registry water into another, from an explicit decision |
| `Scripts/migrate_merged_slugs.py` | --registry --decisions --include-derived --fold --values --boundaries --adopt-min-cover --write | migrate_merged_slugs.py -- carry a merge through every registry sidecar keyed by slug. |
| `Scripts/mirror_research_profiles.py` | --registry --lake --force --dry-run --jobs | !/usr/bin/env python3 |
| `Scripts/missing_waterbodies.py` | --gpkg --coverage --claimed --out --index --bbox --min-acres --max-acres --min-charted --featuretype | missing_waterbodies.py -- 3DHP polygons that have no registry boundary, and do have soundings. |
| `Scripts/name_from_garmin.py` | --boundaries --labels --pois --registry --slug --unregistered --mode --near-km --generic-pct --label-cache --tsv | !/usr/bin/env python3 |
| `Scripts/name_waterbodies.py` | --waterbodies --gpkg --out --min-area-km2 --geom-min-km2 --jobs --batch --limit --named-only | !/usr/bin/env python3 |
| `Scripts/nhd_near.py` | --near --radius --gdb --layers --out | !/usr/bin/env python3 |
| `Scripts/ocr_nes_working_papers.py` | --pdfs --out --jobs --glob | !/usr/bin/env python3 |
| `Scripts/orphan_ids.py` | --repo --json | orphan_ids.py - every element the JS reaches for that the page does not have. |
| `Scripts/osm_ramps.py` | --pbf --out | !/usr/bin/env python3 |
| `Scripts/pack_stamp.py` | — | !/usr/bin/env python3 |
| `Scripts/parse_ga_fish_advisories.py` | --registry --pdf --dry-run | parse_ga_fish_advisories.py -- Georgia's fish consumption guidelines as a species presence floor. |
| `Scripts/parse_lake_program_reports.py` | --registry --pdfs --glob --go | !/usr/bin/env python3 |
| `Scripts/parse_nes_working_papers.py` | --pages --registry --only --dump-station --go | !/usr/bin/env python3 |
| `Scripts/poi_audit.py` | — | !/usr/bin/env python3 |
| `Scripts/poi_source_compare.py` | --garmin --iboating --out --radius-m --verbose | poi_source_compare.py - does Garmin already have i-Boating's POIs? |
| `Scripts/pool_from_nhdplus.py` | --root --registry --nhd --out --only --go | !/usr/bin/env python3 |
| `Scripts/probe_cwms_catalog.py` | --registry --offices --page-size --timeout --max-pages --self-test | probe_cwms_catalog.py -- what does the Corps actually publish, and for which of OUR waters? |
| `Scripts/probe_licor_randleman.py` | — | Probe the PTRWA / LI-COR Cloud (Davra) feed for Randleman Lake water level. |
| `Scripts/probe_ndbc_stations.py` | --registry --jobs --timeout --rows --self-test | probe_ndbc_stations.py -- which of the bound NWS gauge ids are ALSO live NDBC weather stations? |
| `Scripts/probe_nhd_vaa.py` | --gdb --top | probe_nhd_vaa.py -- read-only look at one NHDPlus HR geodatabase. |
| `Scripts/probe_nwps_bulk.py` | --csv --registry --cache --out --keep-csv --self-test | probe_nwps_bulk.py -- one download against 371, and it carries more than the 371 did. |
| `Scripts/probe_wqp_depth_history.py` | --registry --only --min-acres --jobs --resume --do-only --api --from-csv --out | !/usr/bin/env python3 |
| `Scripts/profile_holes.py` | --profiles --since --report --top | profile_holes.py -- what is actually empty in the research profiles. |
| `Scripts/prune_r2_keys.py` | --key-map --packs --dry-run --go --force | !/usr/bin/env python3 |
| `Scripts/prune_r2_objects.py` | --list --go --stop-on-error | prune_r2_objects.py — delete an EXPLICIT list of R2 keys, one per line. |
| `Scripts/prune_shadowed_profiles.py` | --registry --go | !/usr/bin/env python3 |
| `Scripts/pull_usgs_current_conditions.py` | --registry --top --timeout --all-params --bbox --since --from-file --self-test | pull_usgs_current_conditions.py -- ONE request for every live water-quality reading, then join |
| `Scripts/pull_usgs_dashboard.py` | --collection --registry --top --timeout --params --layer --bbox --since --day --from-file --self-test | pull_usgs_dashboard.py -- the USGS National Water Dashboard's OData service, all four useful |
| `Scripts/r2_audit.py` | --worker --from --save --delete-list --registry --propose-unoffered --packs --js | r2_audit.py — what is actually in the R2 bucket, and what of it can go. |
| `Scripts/r2_gzip.py` | — | !/usr/bin/env python3 |
| `Scripts/r2_vs_local.py` | --packs --listing --max-age-h --out --show --no-drive-scan --reindex --index-age-h | !/usr/bin/env python3 |
| `Scripts/reclaim_packs.py` | --packs --registry --report --only-lakes --list --dry-run | !/usr/bin/env python3 |
| `Scripts/recompute_charted.py` | --packs --registry --report --buffer-m --no-prune | recompute_charted.py - fix the charted fraction from the BUILT packs. No rebuild. |
| `Scripts/reflag_routable.py` | --root --pack --only-lakes --from-report --scope --reach-m --report --write | Re-flag `routable` on trolling runs that already exist, against the graph that is there now. |
| `Scripts/refresh_yield.py` | --registry --old --new --shipped-only --top --all-tiles --min-vertices | refresh_yield.py — how many lakes does a tile refresh actually put on the map? |
| `Scripts/registry_census.py` | --registry --code --recurse --report --apply | registry_census.py -- what in the registry is provably redundant, and what only looks it. |
| `Scripts/regulations_report.py` | --root --registry --out --fragment | registry/regulations_table.json -> one HTML page a person can spot-check. |
| `Scripts/remeasure_boundaries.py` | --registry --lake --from-tsv --tolerance-deg --area-tolerance-pct --go | !/usr/bin/env python3 |
| `Scripts/remove_registry_water.py` | --slugs --registry --reason --date --go | !/usr/bin/env python3 |
| `Scripts/research_lakes.py` | --registry --include-rivers --repo --lake --from-report --todo --needs-limnology --state --min-acres --jobs --limit --tpm --dry-run --report --limnology-only --verbose | research_lakes.py -- the trolling-intelligence batch, as a pipeline step. |
| `Scripts/resolve_feature_types.py` | --gpkg --registry --staging --index --state --out | !/usr/bin/env python3 |
| `Scripts/restore_originals.py` | --packs --backup-dir --write --only --only-lakes | restore_originals.py -- put every pack back to its ORIGINAL contour geometry. |
| `Scripts/restore_verified_stamps.py` | --registry --dry-run | !/usr/bin/env python3 |
| `Scripts/rgn4_grammar.py` | — | !/usr/bin/env python3 |
| `Scripts/rgn4_pois.py` | --out | rgn4_pois.py - the POI stage. Every labelled RGN4 point, correctly placed. |
| `Scripts/rsd_body.py` | --start --tlv-bytes | rsd_body.py - what is inside one Garmin .RSD block. |
| `Scripts/rsd_draw.py` | --start --read --pings --palette --down-black --down-white --side-black --side-white --aspect --out-dir | rsd_draw.py - draw a Garmin .RSD the way a sounder draws it. |
| `Scripts/rsd_fields.py` | --start --read --pings --scan | rsd_fields.py - find depth and position by asking what tracks what. |
| `Scripts/rsd_frames.py` | --chunk --max-bad --out | rsd_frames.py - prove the Garmin .RSD framing across the whole file. |
| `Scripts/rsd_image.py` | --start --read --pings --out-dir | rsd_image.py - draw a Garmin .RSD recording, all three channels, from 16-bit samples. |
| `Scripts/rsd_probe1.py` | --window --at | rsd_probe1.py - what IS a Garmin .RSD? Measured, not assumed. |
| `Scripts/rsd_probe2.py` | --window --at | rsd_probe2.py - find the record boundary before guessing at any field. |
| `Scripts/rsd_probe3.py` | --window --at | rsd_probe3.py - the record marker, its stride, and one whole header. |
| `Scripts/rsd_render.py` | --start --columns --kind --sample-start --out | rsd_render.py - draw the echo samples and find out whether this is a sonar picture. |
| `Scripts/rsd_samplestart.py` | --start --read --n | rsd_samplestart.py - find where the echo samples really begin, per ping. |
| `Scripts/rsd_scale.py` | --cell --samples --known-ft --known-sample | rsd_scale.py - solve feet-per-sample by fitting the RSD's bottom against Quickdraw. |
| `Scripts/rsd_sidescan.py` | --start --read --sample-start --pings --out-dir | rsd_sidescan.py - the three channels, each drawn as itself. |
| `Scripts/rsd_sidevu.py` | --start --read --pings --width --black --white --gap --out | rsd_sidevu.py - side imaging drawn as a plan view, with slant-range correction. |
| `Scripts/rsd_track.py` | --out --chunk --channel --max-jump-ft --lat-lo --lat-hi --lon-lo --lon-hi | rsd_track.py - every ping's position and its bottom, for the whole recording. |
| `Scripts/rsd_walk.py` | --start --limit-bytes --chunk | rsd_walk.py - walk the Garmin .RSD record chain and prove it holds. |
| `Scripts/show_missing_water.py` | --slug --registry --nhd --out --top --min-draw | !/usr/bin/env python3 |
| `Scripts/split_merged_boundaries.py` | --registry --only --spread-factor --report --go | !/usr/bin/env python3 |
| `Scripts/stamp_lake_depths.py` | --index --chartpack --boundaries --jobs --lake --force --dry-run | !/usr/bin/env python3 |
| `Scripts/suggest_name_aliases.py` | --registry --max-edits --min-key --write | !/usr/bin/env python3 |
| `Scripts/sweep_unclaimed.py` | --coverage --boundaries --claimed --out --min-acres --max-acres --index --near-km --min-da --near-cells --min-fill --region-mask --no-region --allow-no-da --report | sweep_unclaimed.py -- Garmin bathymetry that belongs to no water we know about. |
| `Scripts/test_a_renamed_water_keeps_no_door_open.py` | — | !/usr/bin/env python3 |
| `Scripts/test_audit_boundary_rings.py` | — | audit_boundary_rings.py -- does it find a flattened boundary, repair it, and leave alone |
| `Scripts/test_audit_drive_sources.py` | — | test_audit_drive_sources.py -- the finder must not report an unread file as read. |
| `Scripts/test_audit_limnology_gaps.py` | — | !/usr/bin/env python3 |
| `Scripts/test_bathy_coarsen.py` | — | coarsen_cells() -- the 2x2 aggregation that made the coastal graphs fit. |
| `Scripts/test_bind_dams.py` | — | Unit tests for bind_dams_to_waters, plus an end-to-end run against a synthetic registry. |
| `Scripts/test_bind_operator_lakes.py` | — | Synthetic end-to-end test for bind_operator_lakes.py. |
| `Scripts/test_boundary_3dhp_rings.py` | — | boundary_from_3dhp.py: does a hole survive the read and reach the GeoJSON. |
| `Scripts/test_build_data_map.py` | — | test_build_data_map.py -- the map has to find the places that were actually missed. |
| `Scripts/test_build_document_limnology.py` | — | !/usr/bin/env python3 |
| `Scripts/test_build_fishbase_traits.py` | — | !/usr/bin/env python3 |
| `Scripts/test_build_hylak_crosswalk.py` | — | !/usr/bin/env python3 |
| `Scripts/test_build_water_bindings_parms.py` | — | test_build_water_bindings_parms.py -- pins what a bound USGS site records about itself. |
| `Scripts/test_build_water_chain.py` | — | Exercise build_water_chain's real functions -- imported from the shipped file, not copies. |
| `Scripts/test_build_water_names.py` | — | test_build_water_names.py -- a ramp may only name the water it is on. |
| `Scripts/test_coastal_and_client_ramps.py` | — | !/usr/bin/env python3 |
| `Scripts/test_coastal_exclusion.py` | — | A coastal zone must not carry a water that owns its own boundary. |
| `Scripts/test_coastal_species_map.py` | — | !/usr/bin/env python3 |
| `Scripts/test_consolidate_coastal_gate.py` | — | consolidate_lake_index.py -- a coastal zone the catalog dropped must leave the index. |
| `Scripts/test_consolidate_merge_gate.py` | — | consolidate_lake_index.py -- a merged-away slug must not come back. |
| `Scripts/test_coverage_cache.py` | — | Synthetic end-to-end test for build_coverage_cache.py. Known answers, asserted. |
| `Scripts/test_derive_nes_limnology.py` | — | !/usr/bin/env python3 |
| `Scripts/test_ehydro_surveys.py` | — | test_ehydro_surveys.py -- an ArcGIS failure must not read as "this water has no surveys". |
| `Scripts/test_enc_seabed.py` | — | test_enc_seabed.py -- the bottom must not be reclassified on the way in. |
| `Scripts/test_entity_residue_in_titles.py` | — | !/usr/bin/env python3 |
| `Scripts/test_feature_type_corrections.py` | — | The feature_type cascade, and the one correction sitting on top of it. |
| `Scripts/test_fetch_agency_nc.py` | — | !/usr/bin/env python3 |
| `Scripts/test_fetch_nc_fish_advisories.py` | — | test_fetch_nc_fish_advisories.py -- run with `py .\scripts\test_fetch_nc_fish_advisories.py`. |
| `Scripts/test_fetch_nla_limnology.py` | — | test_fetch_nla_limnology.py -- run with `py .\scripts\test_fetch_nla_limnology.py`. |
| `Scripts/test_find_duplicates.py` | — | Registry-level tests for find_duplicate_waters.py. Geometry maths lives in test_geomcore.py. |
| `Scripts/test_ga_access_species.py` | — | !/usr/bin/env python3 |
| `Scripts/test_ga_fish_advisories.py` | — | test_ga_fish_advisories.py -- the parser must read the shapes the book actually prints. |
| `Scripts/test_garmin_inventory.py` | — | Synthetic end-to-end test for build_garmin_water_inventory.py. |
| `Scripts/test_geomcore.py` | — |  |
| `Scripts/test_habitat_join.py` | — | test_habitat_join.py -- oyster and marsh onto a trolling run, tested without a chartpack. |
| `Scripts/test_hucs_for.py` | — | hucs_for(): the binding decides the basin, the table is only a fallback. |
| `Scripts/test_id_unclaimed.py` | — | Synthetic end-to-end test for id_unclaimed_water.py. Known answers, asserted. |
| `Scripts/test_layer_value_summary.py` | — | test_layer_value_summary.py -- the thing that decides what a layer CONTAINS, tested without a |
| `Scripts/test_make_osm_ramps_by_lake.py` | — | A retired slug must not outbid the keeper it was merged into. |
| `Scripts/test_match_nhd_partial_write.py` | — | !/usr/bin/env python3 |
| `Scripts/test_match_waters.py` | — | Drives match_waters_to_nhd.py against a REAL geodatabase read by REAL pyogrio. |
| `Scripts/test_merge_region_access.py` | — | A coastal zone must not inherit a creek's access classification. |
| `Scripts/test_merge_waters.py` | — |  |
| `Scripts/test_migrate_slugs.py` | — |  |
| `Scripts/test_mirror_research_profiles.py` | — | test_mirror_research_profiles.py -- the parts that do not need the network. |
| `Scripts/test_mrip_inshore.py` | — | test_mrip_inshore.py -- the rule must reproduce the roster a person already validated. |
| `Scripts/test_name_collisions.py` | — | !/usr/bin/env python3 |
| `Scripts/test_nc_agency_reader.py` | — | !/usr/bin/env python3 |
| `Scripts/test_ncpaws_access.py` | — | !/usr/bin/env python3 |
| `Scripts/test_no_literal_percent.py` | — | !/usr/bin/env python3 |
| `Scripts/test_noaa_current_stations.py` | — | test_noaa_current_stations.py -- the binding must not invent a station on a water that has none. |
| `Scripts/test_parse_nes_working_papers.py` | — | !/usr/bin/env python3 |
| `Scripts/test_partial_write_guards.py` | — | !/usr/bin/env python3 |
| `Scripts/test_probe_wqp_depth_history.py` | — | test_probe_wqp_depth_history.py -- run with `py .\scripts\test_probe_wqp_depth_history.py`. |
| `Scripts/test_process_vpu.py` | — | End-to-end test of process_vpu with a fake pyogrio, so the function that actually |
| `Scripts/test_prune_report.py` | — | test_prune_report.py -- the report prune_r2_objects.py did not write. |
| `Scripts/test_r2_audit_coastal_tier.py` | — | An empty COASTAL_PRIMARY means the tier is OFF, not that nothing qualifies. |
| `Scripts/test_r2_audit_retired.py` | — | RETIRED_PACK_FILES in r2_audit.py: dead by name, and it has to outrank the app veto. |
| `Scripts/test_r2_audit_unoffered.py` | — | The index rule in r2_audit.py: off by default, and it cannot fire on a bad read. |
| `Scripts/test_region_mask.py` | — | Synthetic end-to-end test for make_region_mask.py + in_region.py. Known answers, asserted. |
| `Scripts/test_remove_registry_water.py` | — | !/usr/bin/env python3 |
| `Scripts/test_research_lakes_carry.py` | — | test_research_lakes_carry.py -- the run may only change what it computed. |
| `Scripts/test_restore_verified_stamps.py` | — | test_restore_verified_stamps.py -- the parts that do not need the network. |
| `Scripts/test_river_centrelines.py` | — | test_river_centrelines.py -- the sign conventions in build_river_centrelines.py, pinned. |
| `Scripts/test_sc_fish_advisories.py` | — | test_sc_fish_advisories.py -- the parser must read the water Ryan checked by hand. |
| `Scripts/test_sc_marine_links.py` | — | !/usr/bin/env python3 |
| `Scripts/test_sc_marine_traits.py` | — | !/usr/bin/env python3 |
| `Scripts/test_sc_roster_reader.py` | — | !/usr/bin/env python3 |
| `Scripts/test_show_missing_water.py` | — | The parts of show_missing_water.py that do not need a geodatabase. |
| `Scripts/test_slim_registry.py` | — | What ships in _registry/lakes.json, and what does not. |
| `Scripts/test_species_habitat_weights.py` | — | test_species_habitat_weights.py -- a weight must not be stronger than the matrix said. |
| `Scripts/test_species_traits.py` | — | !/usr/bin/env python3 |
| `Scripts/test_stamp_lake_depths.py` | — | test_stamp_lake_depths.py -- the decision that writes to Ryan's registry. |
| `Scripts/test_stocking_plan.py` | — | !/usr/bin/env python3 |
| `Scripts/test_structure_seeds.py` | — | A trolling pass may be seeded by a structure, not only by a contour. |
| `Scripts/test_sweep_gates.py` | — | Synthetic end-to-end test for the two gates added to sweep_unclaimed.py: |
| `Scripts/test_the_batch_offers_what_the_preset_says.py` | — | !/usr/bin/env python3 |
| `Scripts/test_trim_at_salt_line.py` | — | trim_at_salt_line.py, on geometry small enough to check by eye. |
| `Scripts/tests/test_charted.py` | — | test_charted.py — a shoreline outline is not a survey. |
| `Scripts/tests/test_chording.py` | — | test_chording.py — the shortcut must cut the cove and refuse the point. |
| `Scripts/tile_lake_map.py` | --labels --registry --out --states --index --accessible-only --tiles-out | tile_lake_map.py - which GMP tiles cover which registry lakes, and vice versa. |
| `Scripts/tile_store_diff.py` | --card --new --letters --out-tiles --min-growth | tile_store_diff.py — compare two Garmin tile stores and say what a re-extract would buy. |
| `Scripts/time_fisheries_run.py` | --lake --state --repeat --skip-extract --lakes-in-batch --jobs --verbose | time_fisheries_run.py -- how long does ONE lake's trolling-intelligence run actually take? |
| `Scripts/triage_water_bindings.py` | --registry --out --accept-all-singles --accept | !/usr/bin/env python3 |
| `Scripts/trim_at_salt_line.py` | --boundaries --slug --line --out --go | !/usr/bin/env python3 |
| `Scripts/trim_pack_strays.py` | --chartpack --boundaries --buffer-m --lake --state-file --seconds --go | !/usr/bin/env python3 |
| `Scripts/trollmap_extract_all.py` | --out --layers --letters --jobs --limit --tiles --zoom0-only --min-area --force --gzip | trollmap_extract_all.py - ONE pass over a Garmin GMAPMF tile (or the whole card) that |
| `Scripts/trollmap_lake_boundaries.py` | --lake --list --overwrite --dump-names | trollmap_lake_boundaries.py - Extract lake boundaries from USGS 3DHP GeoPackage |
| `Scripts/trollmap_nhd_boundaries.py` | --lake --overwrite --dump-names --list | trollmap_nhd_boundaries.py — Extract lake boundaries from NHDPlus HR GDB files |
| `Scripts/trollmap_pipeline.py` | --output --lake --zooms --max-cove-dist --min-features | trollmap_pipeline.py — Unified TrollMap Extraction Pipeline |
| `Scripts/trollmap_pipeline_coastal.py` | --output --zone --zooms --contours-only --max-cove-dist --min-features | trollmap_pipeline_coastal.py — TrollMap Coastal Zone Extraction Pipeline |
| `Scripts/trollmap_r2_clean.py` | --all --contours --supplemental --boundaries --dry-run --list | trollmap_r2_clean.py — Wipe TrollMap R2 data using Cloudflare API. |
| `Scripts/uncharted_report.py` | --worker --dumps --registry --aliases --contours --out --user-agent --min-ramps --access-pad --lakes-only --spread-km --dump-feeds | !/usr/bin/env python3 |
| `Scripts/upload_garmin_to_r2.py` | --root --layers --all --lake --prefix --jobs --gzip --no-gzip --dry-run --force --manifest --timeout --boundaries --no-boundaries --index --all-packs --registry --with-pipeline-layers --coastal-primary --max-mb | upload_garmin_to_r2.py — push the Garmin-derived layers to R2, fast and resumably. |
| `Scripts/upload_to_r2.py` | --all --contours --supplemental --boundaries --lake --dry-run | upload_to_r2.py — Upload all TrollMap pipeline outputs to R2 in clean structure. |
| `Scripts/validate_pool_numbers.py` | --registry --out | validate_pool_numbers.py - check the research pipeline's normalPoolFt against known good. |
| `Scripts/verify_registry_r2.py` | --registry --worker --prefix --timeout | verify_registry_r2.py -- are the three files the APP reads actually in R2, and are they current? |
| `Scripts/verify_river_boundaries.py` | --dir --overlap-report --max-gap-km | !/usr/bin/env python3 |
| `Scripts/wqp_clarity_coverage.py` | --registry --out --states --characteristic --since --min-acres --timeout | wqp_clarity_coverage.py - which of our lakes actually have a clarity measurement. |
| `Scripts/zone_coverage.py` | --catalog --feeds --line --out | !/usr/bin/env python3 |
| `test/test_facts_reach_the_saved_profile.py` | — | The facts a run extracts have to reach the document /research/save receives. |
| `test/verify_grokipedia_windows.py` | — | Windows-friendly Python test for Grokipedia/Wikipedia citation extraction |
