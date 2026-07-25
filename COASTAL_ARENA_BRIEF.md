# TrollMap Coastal Expansion — Arena Implementation Brief
**Species Focus:** Red Drum (Redfish), Spotted Seatrout (Speckled Trout), Southern Flounder  
**Region:** SC, GA, NC Coastal Waters (21 zones)  
**Date:** 2026-07-24 | **Status:** Data pipeline complete — JS/Worker implementation needed

---

## 1. What's Already Done (Don't Rebuild)

### Data Pipeline — COMPLETE
All coastal data is extracted, processed, and uploaded to R2 under a flat `{zone_slug}/` structure. Every coastal zone has:

```
{zone_slug}/contours.geojson          # MLLW-referenced depth contours
{zone_slug}/depth_areas.geojson       # DEPARE depth polygons
{zone_slug}/depth_soundings.geojson   # Point depth soundings
{zone_slug}/pois.geojson              # Boat ramps, fish attractors, nav aids
{zone_slug}/shoreline.geojson         # Coastline + pier + obstruction features
{zone_slug}/osm-structures.geojson    # Piers, ramps, marinas, bridges, jetties,
                                       # nav beacons/buoys, moorings, tidal channels
{zone_slug}/oyster_beds.geojson       # SC/NC zones (SCDNR + NCDMF BENTHIC)
{zone_slug}/marsh_edges.geojson       # ESI code 9/10 salt marsh lines (SC/GA/NC)
```

**GA zones** have marsh_edges only (no public oyster shapefile available).

### R2 Access Pattern
All files served via worker: `${CF_WORKER_URL}/chartpacks/{zone_slug}/{filename}`

### Existing Infrastructure (Already Working)
- **`noaa-tides.js`** — fetches real-time NOAA CO-OPS tide predictions, MLLW datums, high/low tables
- **`species-intel.js`** — Red Drum, Speckled Trout, Southern Flounder already have inshore trolling profiles, gear recommendations, seasonal behaviors
- **`smart-plan.js`** — builds out-and-back trolling tracks, phase timings, gear profiles (freshwater only currently)
- **`supplemental-layers.js`** — loads depth_areas, fishing spots, POIs, OSM structures per zone key
- **`lake-keys.js`** — `resolveR2Key()` already maps all 21 coastal zone display names to R2 slugs
- **`contour-data.js`** — loads contours per zone key, already knows coastal zone descriptions

### Tide Datum
i-Boating coastal contours confirmed MLLW-referenced (matches NOAA charts).  
**Tide adjustment math:** `actual_depth_ft = stored_depth_ft + current_tide_height_ft`  
Where `current_tide_height_ft` comes from NOAA CO-OPS via `noaa-tides.js`.

---

## 2. The 21 Coastal Zones

Defined in `coastal_catalog.py` (also needs a JS equivalent — see Section 4):

| Slug | Name | State | Tide Station |
|------|------|-------|-------------|
| coast_winyah_bay_sc | Winyah Bay / Georgetown | SC | 8661070 |
| coast_murrells_inlet_sc | Murrells Inlet / Pawleys Island | SC | 8661070 |
| coast_santee_delta_sc | Santee River Delta / North Inlet | SC | 8661070 |
| coast_charleston_sc | Charleston Harbor | SC | 8665530 |
| coast_ace_basin_sc | ACE Basin / Edisto | SC | 8665530 |
| coast_st_helena_sc | St. Helena Sound | SC | 8670870 |
| coast_beaufort_sc | Beaufort / Port Royal Sound | SC | 8670870 |
| coast_hilton_head_sc | Hilton Head / Calibogue Sound | SC | 8670870 |
| coast_savannah_ga | Savannah River / Savannah | GA | 8670659 |
| coast_ossabaw_st_catherines_ga | Ossabaw / St. Catherines Sound | GA | 8677344 |
| coast_sapelo_altamaha_ga | Sapelo Sound / Altamaha River | GA | 8679511 |
| coast_brunswick_st_simons_ga | Brunswick / St. Simons Sound | GA | 8679511 |
| coast_cumberland_st_marys_ga | Cumberland Island / St. Marys | GA | 8720357 |
| coast_brunswick_nc | Brunswick County / Shallotte Inlet | NC | 8658120 |
| coast_cape_fear_nc | Cape Fear River / Wilmington | NC | 8658120 |
| coast_topsail_new_river_nc | Topsail Island / New River Inlet | NC | 8658163 |
| coast_bogue_sound_nc | Bogue Sound / Morehead City | NC | 8656483 |
| coast_core_sound_nc | Core Sound / Cape Lookout | NC | 8656483 |
| coast_pamlico_sound_nc | Pamlico Sound / Neuse River | NC | 8654467 |
| coast_outer_banks_nc | Outer Banks / Oregon Inlet | NC | 8654467 |
| coast_albemarle_sound_nc | Albemarle Sound / Elizabeth City | NC | 8651370 |

---

## 3. USGS River Gauge Salinity Proxy

These gauge site IDs feed the freshwater intrusion warning. Query USGS NWIS API:
`https://waterservices.usgs.gov/nwis/iv/?sites={site_id}&parameterCd=00060&format=json`

| River | USGS Site ID | Covers |
|-------|-------------|--------|
| Cooper River | 02172002 | Charleston Harbor |
| Ashley River | 02172300 | Charleston Harbor |
| Santee River | 02171700 | Winyah Bay, Santee Delta |
| Savannah River | 02198500 | Savannah, Ossabaw |
| Cape Fear River | 02105769 | Cape Fear, Brunswick NC |
| Neuse River | 02091814 | Pamlico Sound |

**Logic:** If current discharge > 130% of 30-day mean → flag Freshwater Intrusion Warning.  
Effect on species: Trout push toward inlets, Redfish slide out of flooded marsh.

---

## 4. What Arena Needs to Build

### A. Coastal Zone JS Catalog (`js/data/coastal-zones.js`)
A JS equivalent of `coastal_catalog.py` — zone metadata for use in SmartPlan and UI:
```javascript
export const COASTAL_ZONES = {
  'coast_charleston_sc': {
    name: 'Charleston Harbor, SC',
    state: 'SC',
    tideStation: '8665530',
    center: [32.77, -79.93],
    bbox: [[32.60, -80.10], [32.95, -79.75]],
    ramps: { ... },
    usgsGauges: ['02172002', '02172300'],  // Cooper + Ashley
  },
  // ... all 21 zones
};
```

### B. Coastal SmartPlan Logic (`js/modules/smart-plan.js` additions)

Coastal mode detection: if `resolveR2Key(lakeName)` returns a slug starting with `coast_`, use coastal scoring.

**Tide Stage Scoring:**
```
flood tide (rising, < high):
  → Redfish: +++ marsh edges, ++ oyster points
  → Trout:   ++ grass flat potholes
  → Flounder: + creek mouths

high tide (+1.5ft above MLLW):
  → Redfish: +++ flooded Spartina edges (use marsh_edges.geojson proximity)
  → Trout:   ++ potholes in grass flats
  → Flounder: neutral

ebb tide (falling, > low):
  → Redfish: ++ oyster points, +++ creek mouths
  → Trout:   +++ creek mouths and drop-offs
  → Flounder: +++ pinch points, creek mouths, dock pilings

low tide:
  → All species: avoid shallow flats, focus on channels and deep holes
```

**Structure Proximity Scoring (from R2 data):**
- Oyster points: score within 200m of `oyster_beds.geojson` features
- Marsh edges: score within 100m of `marsh_edges.geojson` during flood/high
- Creek mouths: derive from `osm-structures.geojson` TIDAL_CHANNEL features intersecting shoreline
- Dock pilings: `osm-structures.geojson` PIER features for flounder

**Depth Adjustment:**
Apply tide height to contour depths before routing:
```javascript
const actualDepth = feature.properties.depth_ft + currentTideHeightFt;
```

**Freshwater Intrusion Warning:**
If USGS discharge spike detected for zone's river(s):
- Penalize upper creek zones
- Favor inlet-adjacent structure
- Surface warning in SmartPlan output: *"Heavy runoff detected — salinity likely depressed. Trout pushing toward inlets; redfish sliding out of marsh."*

### C. Coastal Research Profiles (worker-research.js additions)

Each coastal zone needs a research profile in R2 at `lakes/{zone_slug}.json` covering:
- Zone description and access info
- Primary target species with seasonal notes
- Tidal fishing playbook (per species, per tide stage)
- Key structure types present (from osm-structures metadata)
- Local regulations (SC/GA/NC saltwater — size/bag limits, seasons, flounder closure awareness)
- USGS gauge context for salinity proxy

### D. UI Updates

**Zone Selector:** Coastal zones should appear in the lake selector dropdown, grouped under "SC Coast", "GA Coast", "NC Coast" sections.

**Tide Panel Integration:** When a coastal zone is selected, the tide panel should auto-populate with the zone's tide station ID and show current stage (flood/ebb/high/low) prominently.

**Depth Sounding Display:** `depth_soundings.geojson` can be rendered as labeled point markers at higher zoom levels (zoom 13+) showing actual depth values, tide-adjusted.

---

## 5. Species Playbook Reference

### Red Drum (Redfish)
- **Best:** Incoming/flood tide on Spartina marsh edges; oyster points on moving water
- **Structure:** Marsh edges, oyster reefs, tidal creek intersections with flats
- **Depth:** 1-4ft on flood; creek channels 4-8ft on ebb
- **Lures:** Gold spoon, paddle tail on 1/4oz jighead, popping cork + DOA shrimp

### Spotted Seatrout (Speckled Trout)
- **Best:** Early morning grass flat potholes; creek mouths on ebb
- **Structure:** Grass flat depressions, channel edges, dock pilings
- **Depth:** 2-6ft over grass; 6-12ft in channels
- **Salinity sensitivity:** High — penalize upper creeks after heavy rain
- **Lures:** Mirrolure, soft plastics under popping cork

### Southern Flounder
- **Best:** Mid-incoming/outgoing tidal flow at pinch points
- **Structure:** Creek mouths, inlet throats, dock pilings, channel edges
- **Depth:** 4-12ft in current
- **Lures:** Gulp! shrimp on jighead, slow drag on bottom

---

## 6. Regulations Awareness

SC, GA, and NC saltwater regs are already loaded via the regulations pipeline for freshwater. Coastal zones need:
- **Flounder closure season awareness** (NC has periodic closures)
- **Red Drum slot limits** (SC: 15-23", 3/day; GA: 14-23", 5/day; NC: 18-27", 1/day)
- **Speckled Trout limits** (SC: 10", 10/day; GA: 12", 10/day; NC: 12", 10/day)

---

## 7. Technical Notes for Arena

- Worker URL: `CF_WORKER_URL` from `js/core/state.js`
- R2 fetch pattern: `${CF_WORKER_URL}/chartpacks/{zone_slug}/{filename}`
- Zone slug resolution: `resolveR2Key(displayName)` in `js/data/lake-keys.js` already handles all 21 zones
- Tide data: `noaa-tides.js` — pass `tideStation` from `COASTAL_ZONES` catalog
- All coastal slugs start with `coast_` — use this to detect coastal mode
- `supplemental-layers.js` already handles loading depth_areas, POIs, OSM structures by zone key — coastal zones work automatically with existing infrastructure
- New coastal-specific layers (oyster_beds, marsh_edges, depth_soundings) need new fetch/render functions
