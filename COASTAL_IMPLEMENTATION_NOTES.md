# Coastal Expansion — Implementation Notes

Companion to `COASTAL_ARENA_BRIEF.md`. Records what was built, what differs
from the brief and why, and what still needs verifying against live endpoints.

**Status:** all four phases complete · 260/260 tests across 20 files
**Branch:** `arena/019f96d6-trollmap-dev`

---

## 1. What was built

| Commit | Area | Key files |
|---|---|---|
| `4edd298` | Zone catalog | `js/data/coastal-zones.js` (generated), `Scripts/gen_coastal_zones_js.py` |
| `390fbe6` | Tide engine + panel | `js/modules/tide-engine.js`, `js/modules/noaa-tides.js`, `index.html` |
| `f163140` | Coastal layers | `js/modules/coastal-layers.js` |
| `5022a78` | Scoring, salinity, agents | `js/modules/coastal-scoring.js`, `js/modules/usgs-gauges.js`, `Worker/research/coastal-agents.js` |
| (this) | Species selection + season gate | `js/data/coastal-regulations.js`, `js/modules/species-selector.js` |

---

## 2. Corrections to the brief

The brief described some infrastructure as ready that was not, and some data
that turned out to be stale. None of this changed the plan, but it changed the
work.

### `noaa-tides.js` was dead code
The brief lists it under "Existing Infrastructure (Already Working)". It
queried six DOM IDs — `#noaaStationSelect`, `#syncTidesBtn`, `#tideSyncStatus`,
`#liveTideStageReadout`, `#tidesAssessmentTableWrap`, `#tidesAssessmentBody` —
**none of which existed in `index.html`**. `wireButtons()` hit
`if (!syncBtn) return;` on every page load. `plan-builder.js:711` has always
read an empty string from `getNoaaTideRows()`. The panel is now built and the
module rewired.

### `hilo` cannot drive depth correction
The brief's depth formula needs a height at an arbitrary time, but the old
module only requested `interval=hilo` (~4 points/day). `tide-engine.js` also
pulls `interval=h` and interpolates linearly between hourly samples.

### USGS `iv` cannot produce a 30-day mean
Brief §3 gives `/nwis/iv/?...&parameterCd=00060` for the 130% rule. That
endpoint returns instantaneous values only. The baseline needs
`/nwis/dv/?...&statCd=00003&period=P30D`. Both are queried.

### `LAKE_DB` covers only 9 of 21 zones
`runSmartPlan()` sourced the Open-Meteo forecast from `LAKE_DB`, so 12 coastal
zones silently got no weather. Now falls back to `COASTAL_ZONES.center`.

### Saltwater species were unreachable, and the season gate did not cover them
Two gaps found after the first four commits.

**The Plan tab's species checkboxes were hardcoded freshwater** — Striped Bass,
Hybrid, Largemouth, Catfish, Crappie, White Bass, Bowfin. Red Drum, Speckled
Trout and Flounder could not be selected at all, so none of the coastal
species intel or tide scoring was reachable from the UI. `species-selector.js`
now swaps the list based on the selected waterbody.

**`checkRegulations()` could not protect coastal zones.** The `REGULATIONS` map
in `species-intel.js` is keyed by lake name, and its one `'Coastal SC Inshore'`
entry is a key that no real zone name resolves to. Every coastal trip returned
`{legal: true, note: 'No specific regulation data available'}`. Verified before
the fix:

```
Pamlico Sound / Neuse River, NC + Speckled Trout, 15 Feb 2026
  -> legal=true          (species was closed statewide by proclamation)
```

`js/data/coastal-regulations.js` keys by **state** (correct for saltwater, and
21 zone entries fewer to maintain) and returns the same shape, so the existing
hard block in `runSmartPlan()` works unchanged. Closed species are also
disabled in the checkbox list, so the plan cannot be requested in the first
place.

Closures block; **gear restrictions only warn** — SC's Dec–Feb gig closure on
red drum and trout does not affect rod and reel, so blocking the plan would be
wrong.

### Five tests were already failing on `main`
Unrelated to this work — they encoded a pre-split world (101 map entries, a
single shared `sc_ga_coastal` key, a `Fort Loundon` typo alias). Repaired in
`4edd298`.

### Regulation numbers in brief §6 are unreliable
See section 4 below. The brief, the code, and the R2 digests disagreed with
each other and with current law.

---

## 3. Design decisions worth knowing

**The zone catalog is generated, not written.**
`js/data/coastal-zones.js` is produced from `Scripts/coastal_catalog.py`, which
already drives the R2 pipeline. Hand-copying is how `lake-keys.js` and
`limnology.js` drifted (`AGENT_GUIDE.md` §1). After editing the Python catalog:

```bash
python3 Scripts/gen_coastal_zones_js.py
```

`test/coastal-zones-parity.test.js` fails if the generated file is stale.

**Missing data degrades toward caution.** No tide sync means soundings show
charted MLLW, which *under-reports* water. A dead USGS gauge means no intrusion
warning rather than a fabricated one. Zones with no gauge coverage (13 of 21)
skip the check entirely instead of borrowing an unrelated basin.

**Scoring is pure.** `coastal-scoring.js` has no DOM and no fetch, so the
tide/structure model is unit-testable without Leaflet or NOAA. `smart-plan.js`
supplies the inputs.

---

## 4. Regulations — read this before trusting any limit

The R2 digests **do** contain saltwater tables (I was wrong in an earlier
message that they were missing — they are sections inside the freshwater
digests, exactly as you said):

- SC: `sc_digest_2025_2026.pdf` → "FINFISH: INSHORE & OFFSHORE"
- GA: `ga_digest_2025_2026.pdf` → "Finfish Seasons, Limits, Sizes"
- NC: `nc_digest_2025_2026.pdf` → combined inland/coastal table

Both SC and GA digests also define the **freshwater/saltwater dividing line**,
which is useful for establishing where each zone legally sits.

### Known conflicts as of 2026-07-24

| | R2 digest (2025-26) | `species-intel.js` | Brief §6 | Actual |
|---|---|---|---|---|
| SC Red Drum | 15–23", 2/day | 15–23", 3/day | 15–23", 3/day | **18–25", 1/day, 2/boat** (eff. 2026-07-01) |
| SC Seatrout | 14" TL, 10/day | 14", 10/day ✅ | 10" ❌ | 14", 10/day |
| SC Flounder | 16" TL, 5/day, 10/boat | ✅ match | — | 16", 5/day |
| GA Red Drum | 14 TL, 23 max, 5/day | absent | ✅ match | 14–23", 5/day |
| GA Seatrout | 14 TL, 15/day | absent | 12", 10/day ❌ | 14", 15/day |
| NC Seatrout | — | absent | 12", 10/day | **Closed by proclamation Feb 6 – Jun 30 2026** |
| NC S. Flounder | — | absent | "periodic closures" | **No recreational season in coastal waters** |

The **Actual** column is what `js/data/coastal-regulations.js` encodes, as the
offline baseline that gates plan creation. Each state entry carries `verifyBy`
(SC/GA 2026-08-15, NC 2026-09-01); past that date `checkCoastalRegulations()`
returns `stale: true` and attaches a warning telling the angler to confirm with
the agency, rather than silently asserting expired numbers.

The `saltwater_regulations` agent remains the authoritative live layer: it
parses the digest as baseline and layers a recency-bounded search for
amendments; the live source wins via `supersededByProclamation`, and
`verificationRequired` is set whenever nothing confirmed the digest. Where a
researched profile exists it should win over the static table.

This matters because `runSmartPlan()` hard-blocks on `checkRegulations()`. A
digest-only path would confidently authorise an out-of-slot red drum today.

### When the new digests land (mid-August)

SC and GA 2026-27 should be a filename swap in `STATE_REGULATIONS_CONFIG`
(`Worker/research/clients.js:126`), following the existing `USE_2026` pattern
already used for NC/TN. Confirmed `sc_digest_2026_2027.pdf` is not in R2 yet.

---

## 5. Agent split

| Agent | Coastal | Why |
|---|---|---|
| `estuary` | **new** | replaces `identity` — no dam, no pool elevation |
| `tidal` | **new** | replaces `limnology` — salinity/flushing, not thermocline/anoxia |
| `saltwater_regulations` | **new** | replaces `regulations` — freshwater digest sections miss saltwater species |
| `habitat` | shared + hint | marsh/oyster/creek instead of brush piles |
| `biology` | shared + hint | shrimp/mullet/crab instead of shad/herring |
| `navigation`, `fisheries`, `summary` | shared as-is | generic enough for estuaries |
| `identity`, `limnology`, `regulations` | skipped | see `COASTAL_SKIPPED_AGENTS` |

Coastal agents are `Object.assign`-ed into `RESEARCH_AGENTS`, so
`handleResearchAgent`, the confidence scorer and the review UI in
`lake-research-ui.js` pick them up with no special-casing — profiles stay
hand-authorable in the existing UI.

Discovery is gated on `body.zoneKey`/`body.lakeKey` starting with `coast_`.
**Callers must pass one of those** for a coastal zone to select the marine
agent set; without it the freshwater set runs.

---

## 6. Not verified against live endpoints

This sandbox has no egress to the worker, NOAA, or USGS. (R2 was readable via a
separate tool, which is how the digests above were confirmed.) Every fetch path
is coded to documented API shapes and tested with realistic fixtures —
including NWIS's `-999999` sentinel — but the following need a real browser run:

- [ ] Tide sync against a live NOAA station; check stage and height read sensibly
- [ ] `oyster_beds` / `marsh_edges` / `depth_soundings` actually render
- [ ] GA zones 404 on oyster cleanly (expected — no public shapefile)
- [ ] Sounding labels legible at zoom 13+ and re-label after a tide sync
- [ ] A coastal SmartPlan run end to end
- [ ] USGS intrusion path — hard to test outside a real runoff event
- [ ] One coastal research agent run per new agent, to check output shape
- [ ] Species checkboxes swap to saltwater on selecting a coastal zone
- [ ] NC Southern Flounder shows as CLOSED and cannot be ticked
- [ ] Changing the trip date re-evaluates closures (NC seatrout before/after 30 Jun)

Two assumptions worth confirming with real data:
1. **Sounding density.** If a zone has tens of thousands of soundings, zoom 13
   may still be too dense; `SOUNDING_MIN_ZOOM` in `coastal-layers.js` is one
   constant to raise, or add viewport culling.
2. **Structure classification.** `classifyStructure()` was written against the
   property names in `fetch_osm_coastal.py` / `trollmap_pipeline_coastal.py`.
   Worth spot-checking one real `osm-structures.geojson` to confirm the values
   match at runtime.

---

## 7. Tuning the scoring model

Weights live in `TIDE_WEIGHTS` in `js/modules/coastal-scoring.js`, transcribed
from brief §4B. They are the most opinionated part of this work and the most
likely to need adjustment from real trips. Also:

- `STRUCTURE_RADIUS_FT` — how far each structure holds fish
- `DEPTH_BANDS` — preferred working depth per species and stage
- `SLACK_WINDOW_MIN` (`tide-engine.js`) — currently 45 min either side of a
  turn, deliberately generous since bite quality falls off before the
  astronomical turn
- `INTRUSION_THRESHOLD` — 1.3 per the brief
