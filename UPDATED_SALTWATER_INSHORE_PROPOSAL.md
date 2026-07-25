# Proposal: Incorporating Saltwater Inshore Fishing into Personal Research & SmartPlan (v2.0 - Streamlined)

**Species Focus:** Red Drum (Redfish), Spotted Seatrout (Speckled Trout), Southern Flounder  
**Region:** GA, SC, NC Coastal Waters  
**Date:** 2026-07-21 | **Version:** 2.0 (Personal App & GA/SC/NC Focused)  

---

## 1. Executive Summary

This proposal outlines the lightweight updates needed to expand our personal TrollMap instance from freshwater reservoirs to **saltwater inshore fishing** across **GA, SC, and NC coastal estuaries**.

Because this is a personal app (not a commercial SaaS product), we don't need complex multi-state licensing, massive 10TB data pipelines, or 34-week corporate roadmaps. We already have working NOAA tide integration (`noaa-tides.js`) and inshore species profiles (`species-intel.js`). 

To make TrollMap fully dialed for GA/SC/NC inshore trips, we only need two practical upgrades:
1. **USGS River Gauge Salinity Proxy:** Using local USGS river discharge and gauge height to instantly detect freshwater runoff ("it rained upstream, salinity crashed, trout pushed out to inlets").
2. **Inshore SmartPlan Weighting:** Tuning our existing multi-phase planning logic to prioritize tide stage (incoming/outgoing/high/low), oyster points, and creek mouths for Redfish, Trout, and Flounder.

---

## 2. Codebase Reality & What's Already Good

* **NOAA Tides (`js/modules/noaa-tides.js`):** Already fetching real-time predictions, MLLW datums, and high/low tables for SC, NC, and GA coastal stations.
* **Species Intelligence (`js/data/species-intel.js`):** Red Drum, Speckled Trout, and Southern Flounder are already seeded with inshore trolling profiles, paddle tail / gold spoon / popping cork recommendations, and seasonal behaviors.
* **SmartPlan & Routing (`js/modules/smart-plan.js`):** Already builds out-and-back trolling tracks, phase timings, and gear profiles.

---

## 3. Simplified Data Strategy (GA, SC, NC Focus)

### A. Tides & Water Movement
* Leverage existing NOAA CO-OPS tide station selectors for coastal SC (Charleston, Winyah Bay, Port Royal), NC (Wilmington, Beaufort), and GA (Savannah, Brunswick).
* Use tide stage to trigger tactical advice in SmartPlan (e.g., *flood tide = work Spartina grass edges; ebb tide = target creek mouths and oyster points*).

### B. Practical Salinity & Runoff Proxy (USGS)
* Instead of heavy satellite Copernicus pipelines, query local **USGS River Discharge/Gauge APIs** near coastal rivers (e.g., Cooper River, Ashley River, Savannah River, Santee River).
* **Logic:** If USGS river gauge discharge spikes >30% above normal baseflow due to recent rain, flag a **Freshwater Intrusion Warning** in SmartPlan: *"Heavy runoff detected upstream — expect salinity drop. Trout will push toward inlets; redfish will slide out of flooded marsh."*

### C. Regional Scope (GA, SC, NC Only)
* Focus regulations, local hotspots, and ramp data strictly on our home region (GA/SC/NC coastal waters).

---

## 4. Species Quick Playbook for SmartPlan

* **Red Drum (Redfish):** Prioritize flooded Spartina marsh edges on incoming/high tide (+1.5ft+); oyster points and creek mouths on moving water.
* **Spotted Seatrout:** Target grass flat potholes and drop-offs. If USGS rain/runoff spike occurs, penalize low-salinity upper creeks and favor inlet-adjacent structure.
* **Southern Flounder:** Target pinch points, creek mouths, and dock pilings during mid-incoming/outgoing tidal flow.

---

## 5. Lightweight Implementation Plan

* **Step 1:** Verify coastal station dropdowns in NOAA Tides module for GA, SC, and NC.
* **Step 2:** Add a simple USGS river gauge check to SmartPlan weather/conditions readout to warn of heavy freshwater runoff after rain.
* **Step 3:** Tune SmartPlan scoring weights to favor tide stage and structure proximity for Red Drum, Trout, and Flounder in SC/NC/GA coastal modes.

---
*Ready to build iteratively as needed for personal weekend trips!*
