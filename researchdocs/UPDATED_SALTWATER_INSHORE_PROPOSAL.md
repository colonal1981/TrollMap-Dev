# Proposal: Incorporating Saltwater Inshore Fishing into Research & SmartPlan (v1.1)

**Species Focus:** Red Drum (Redfish), Spotted Seatrout (Speckled Trout), Southern Flounder  
**Date:** 2026-07-21 | **Version:** 1.1 (Codebase-Aligned & Updated)  
**Status:** Architecture & Engineering Specification for Review

---

## 1. Executive Summary & Codebase Alignment

This proposal outlines the product, data, and engineering changes required to expand our current freshwater-centric **Research** and **SmartPlan** platforms to support **saltwater inshore fishing** across coastal estuaries, bays, and marshes.

### Codebase Reality Check (What Exists vs. What is Needed)
A rigorous comparison against the current `TrollMap-Dev` repository reveals a strong foundational baseline already in place:
1. **NOAA Tides Integration (`js/modules/noaa-tides.js` & `lakes.js`):** The repository *already* includes NOAA CO-OPS API integration for coastal SC/NC/GA stations (e.g., Charleston Harbor, Winyah Bay, Port Royal Sound, Calibogue Sound), pulling MLLW predictions and generating tide stage advice.
2. **Inshore Species Intelligence (`js/data/species-intel.js`):** Red Drum (Redfish), Speckled Trout (Spotted Seatrout), and Southern Flounder are already seeded in `REGULATIONS` and `SPECIES_BEHAVIOR_V2` with specialized inshore trolling profiles, seasonal behavior, and tidal movement triggers.
3. **Remaining Engineering Scope:** While tides and basic species rules exist, expanding to full inshore capability requires:
   - **Tide-Aware Contours (TAC):** Upgrading static contour rendering (`contour-data.js`) to dynamically adjust depth and expose mud/oyster flats based on real-time tide time-sliders.
   - **Saltwater Environmental Brain:** Automated ingestion of salinity (ppt), Sentinel-2 turbidity, SST, and vector layers for oyster reefs, seagrass beds, and marsh boundaries.
   - **SmartPlan Inshore Scoring v2:** Rewriting the multi-factor scoring algorithm to weigh tide stage, current velocity, salinity fronts, and clarity filters.

Inshore is fundamentally different from freshwater: The environment is not static. Depth, accessible water, fish location, and safe navigation change hourly with the tide. To credibly serve inshore anglers targeting the Big 3, we must build upon our existing tidal hooks to deliver a world-class inshore experience.

---

## 2. Current State & Gap Analysis

| Component | Current TrollMap Logic | Gap for Full Inshore Saltwater | Current Implementation Status |
| :--- | :--- | :--- | :--- |
| **Contours** | Static depth relative to full pool / contour lines (e.g., 5ft, 10ft). | Chart datum (MLLW) ≠ actual water. Flats that are 6" at low tide become 3.5ft at high tide and flood into the marsh. Needs time-aware correction. | **Partial:** Static contour GeoJSON loaded; NOAA tide table exists but not yet tied directly to depth tile offsets. |
| **Seasonality** | Driven by Water Temp + Spawn Phase (Pre/Spawn/Post). | Inshore seasonality is driven by **Tide + Salinity + Bait Migration + Temperature + Photoperiod.** | **Good:** `SPECIES_BEHAVIOR_V2` includes spring/summer/fall/winter profiles for Redfish & Trout. |
| **Structure** | Points, humps, brush piles, weedlines, ledges. | **Different taxonomy:** Oyster reefs, seagrass beds (turtle grass, shoal grass), potholes, mangrove shorelines, spartina marsh creeks, jetties. | **Partial:** Supplemental layers handle freshwater attractors; inshore habitat polygons need integration. |
| **Planning Logic** | Wind + Pressure + Water Temp + Time of Day. | Must add: **Tide stage (incoming/outgoing/high/low), tidal current velocity, moon phase impact, wind-driven tide (blowout), salinity gradient, water clarity.** | **Partial:** NOAA high/low predictions fetched; multi-factor inshore scoring formula needs expansion. |

---

## 3. Species Intelligence Requirements

We have established foundational profiles in `species-intel.js`, but must expand them into comprehensive playbooks.

### A. Red Drum (Sciaenops ocellatus)
* **Biology to Model:** Euryhaline (0-40 ppt, prefers 15-30 ppt), temp tolerance 40–90°F. Slot fish (state-dependent 18–27") are structure-oriented in creeks; bull reds (>27") move to inlets/passes. Negative correlation with high turbidity.
* **Critical Research Content:** Tailing behavior on flood tides, schooling patterns, sight-fishing vs. blind casting, low-light feeding dominance, crustacean vs. mullet forage.
* **SmartPlan Logic:** Prioritize: 1) Flooded spartina/mangrove edges on high tide (+1.5ft+ above MLLW), 2) Oyster points and dock corners on moving tides, 3) Inlet passes on last 2 hours outgoing for bulls. Penalize slack tide.

### B. Spotted Seatrout (Cynoscion nebulosus)
* **Biology to Model:** Highly sensitive. Requires >10 ppt salinity, thrives 15–25 ppt. Lethal stress <45°F and >90°F. Sensitive to water clarity and freshwater intrusion after rain.
* **Critical Research Content:** Grass flat + pothole dependency, "slicks" as feeding indicators, temperature-driven winter deep hole congregations.
* **SmartPlan Logic:** Require Seagrass + Sand Pothole layer. Prioritize water temp 70–82°F optimal. Heavy penalty if salinity <10 ppt or turbidity >2ft visibility.

### C. Southern Flounder (Paralichthys lethostigma)
* **Biology to Model:** Ambush predator, camouflage master. Migration is key: heavy inshore abundance Mar–Oct, offshore migration Oct–Dec to spawn. Highly structure/site specific.
* **Critical Research Content:** Structure orientation (1–3ft drop ledges, creek mouths, dock pilings, oyster bars), tide-driven funnel points, mud vs. sand bottom preference.
* **SmartPlan Logic:** Pinch points algorithm: creek mouths, cuts between bars, passes, bridge pilings. Best bite on strongest tidal flow (mid outgoing/incoming). Depth 2–8ft.

---

## 4. Data Strategy: What We Need to Acquire & Build

### 4.1 Core Feature: Tide-Aware Contours (TAC)
* **Problem:** NOAA charts are referenced to Mean Lower Low Water (MLLW). On a +2.5ft tide, a flat charted as 1ft deep is actually 3.5ft deep, and areas charted as land (marsh) become navigable.
* **Solution Architecture — Tide-Aware Contour Engine:**
  1. **Base Bathymetry Layer:** NOAA NCEI Continuously Updated DEMs (~3m resolution) and USACE hydrographic surveys.
  2. **Water Level Correction Service:** Build on existing NOAA CO-OPS API integration (`noaa-tides.js`), incorporating NOAA VDatum conversions and wind-driven surge corrections from the NOAA ETSS model.
  3. **Dynamic Visualization:** Depth shading that changes via time slider, marsh flood/exposure layers, dry bars & flats rendering, and safe navigation hazard overlays (<2ft at planned tide).

### 4.2 Other Critical Inshore Data Layers
* **Water Quality:** Salinity (ppt) & Salinity Fronts (Copernicus CMEMS, USGS river gauges), Water Clarity / Turbidity (Sentinel-2), Sea Surface Temperature (NOAA GOES / GHRSST).
* **Physical & Habitat:** Wind vs. Tide dominance, Seagrass beds (NOAA C-CAP), Oyster reef polygons (State DNR / TNC), Marsh / mangrove lines (USFWS NWI), Bottom composition (usSEABED).
* **Human & Regulations:** Shallow hazard boat ramps with tide viability warnings, multi-state regulations engine (FWC FL, TPWD TX, LDWF LA, SCDNR SC, NCDMF NC).

---

## 5. Research Module — Detailed Changes Required

* **Content Architecture:** Establish `/saltwater/inshore/` taxonomy branch in `lake-research.js` replacing "Spawn Phase" with "Migratory Phase" + "Tide Phase".
* **Species Data Schema Additions:**
  ```json
  {
    "salinity_preference_range": [15, 20, 28, 35],
    "temp_tolerance": { "lethal_low": 42, "optimal_min": 68, "optimal_max": 82, "lethal_high": 92 },
    "tide_preference": { "incoming": 0.9, "high": 0.8, "outgoing": 0.7, "slack": 0.3 },
    "structure_affinity": ["oyster_reef", "seagrass_edge", "pothole", "dock_piling"]
  }
  ```
* **Interactive UX:** Embedded Tide Simulator previewing flat depth at +0.5ft vs. +2.5ft, habitat map previewers, and tactical video libraries.

---

## 6. SmartPlan Module — Detailed Changes Required

### 6.1 Back-End Services & Enhancements
* **Tide Intelligence Service:** Expand `noaa-tides.js` into a unified `/tides/point` harmonic prediction endpoint with automatic substation interpolation.
* **TAC Tile Server:** Dynamic raster tile server serving depth at timestamp (`/{z}/{x}/{y}.png?t=timestamp`).
* **Saltwater Environmental Service:** Hourly ingest of salinity, SST, turbidity, and wind-driven tides.

### 6.2 SmartPlan Logic Re-Write (Species Engine v2)
```javascript
InshoreScore = w1 * TideStageScore(species) +
               w2 * TidalCurrentSpeed +
               w3 * SalinityFit +
               w4 * ClarityFit +
               w5 * TempFit +
               w6 * StructureProximity(species) +
               w7 * WindvsTideConflict +
               w8 * TimeOfDay +
               w9 * BaitMigrationTiming;
```

### 6.3 Front-End & Map UX Changes
1. **Saltwater Mode Toggle:** Switch between Freshwater, Inshore Salt, and Offshore modes to re-skin base maps, contours, and scoring models.
2. **Linked Time Slider & Tide Chart:** Scraping trip time updates map depth shading in real-time with precise true-depth readouts.
3. **Specialized Spot Predictions:** Generate inshore-specific spot types ("Tailing Alert", "Pothole Drift", "Funnel Ambush") with automated explanations.
4. **Trip Planning & Safety Advisories:** Launch time tide viability warnings and shallow route hazard alerts.

---

## 7. Technical Architecture & Data Pipeline Summary

* **Phase 0 - Foundation (Completed / In Progress):** NOAA CO-OPS tide integration (`noaa-tides.js`), coastal lake database entries (`lakes.js`), and basic inshore species behavior (`species-intel.js`).
* **Phase 1 - TAC MVP (8–10 weeks):** Build TAC Tile Server and link front-end time slider to depth raster offsets.
* **Phase 2 - Environmental Brain (6 weeks):** Ingest Copernicus salinity, SST, and turbidity into `/inshore/conditions`.
* **Phase 3 - Research Content (8 weeks):** Deploy Redfish, Trout, and Flounder playbooks with regional variants.
* **Phase 4 - SmartPlan Species Engine v2 (8 weeks):** Deploy multi-factor inshore scoring and spot rationale UI.
* **Phase 5 - QA & State Expansion (4 weeks):** Pilot testing in Florida, Texas, and Louisiana, followed by Carolinas and Georgia.

---

## 8. Third-Party & Licensing Costs Estimate

* **NOAA CO-OPS / NCEI:** Free (Public)
* **Copernicus Marine Service (Salinity/SST):** Free (requires account, 10TB/mo ingest)
* **Sentinel-2 Turbidity Processing (SentinelHub):** ~$300/mo
* **NOAA C-CAP Habitat & State Oyster Layers:** Free (Manual GIS acquisition)
* **Mapbox GL + Custom Terrain:** ~40% tile usage increase

---

## 9. Risks & Mitigations

1. **Risk:** Tide interpolation in back bays is inaccurate.
   * **Mitigation:** Use station-based predictions with clear disclaimers ("Interpolated — use chart for navigation"); plan ADCIRC model integration for v2.
2. **Risk:** Salinity models are coarse (~9km resolution) vs. creek-level needs.
   * **Mitigation:** Use model as gradient indicator combined with USGS river gauge freshwater influx penalties.
3. **Risk:** User confusion between MLLW chart and true depth liability.
   * **Mitigation:** Display both chart depth and true depth with explicit safety disclaimers.

---

## 10. Success Metrics & Appendix

* **Research:** Time-on-page for inshore species > freshwater average; completion rate of Tide Playbook chapters.
* **SmartPlan:** Percentage of inshore trips planned with time slider adjusted (>70% target); reduction in "dry launch" complaints.
* **Business:** Conversion rate of saltwater anglers in FL/TX/LA; premium upsell adoption for TAC layers.
* **Appendix User Story:** *"As a TX angler planning for Saturday, I open SmartPlan, switch to Inshore, and drop a pin on West Matagorda. The tide chart shows Low 0.3ft at 6am and High 2.1ft at 11:30am. Scrubbing to 10am floods the flats blue (2.4ft true depth), revealing oyster reef chains and auto-generating a Red Drum tailing zone alert."*

---
*Next Steps:*
1. Approve data stack + TAC tile approach.
2. Greenlight content brief for Redfish/Trout/Flounder playbooks.
3. Assign backend engineer for Tide Intelligence Service and front-end time-slider TAC prototype.
