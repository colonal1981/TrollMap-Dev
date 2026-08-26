/**
 * TrollMap GPX Studio v10 — modular entry point.
 *
 * This is the ONLY <script> loaded by index.html. It:
 *   1. Imports every JS module (each module wires its own DOM
 *      button handlers via side effects).
 *   2. Opens IndexedDB and restores any persisted working data.
 *   3. Initializes the Leaflet map + tab switcher.
 *   4. Sets up the default rod spread + plan dropdowns.
 *
 * Cross-module shared state lives in core/state.js (the `state`
 * singleton). Helpers that popup buttons invoke across modules
 * (sendWptToGenerator, enableSpotRepositioning, showCatchPhoto)
 * are exposed on `window` by their owning modules.
 */

import { openDB, ready as dbReady } from './utils/db.js';
import { state } from './core/state.js';
import {
  initMap,
  renderAll,
  persistWorkingData,
  restoreWorkingData,
} from './core/map-init.js';
import { initTabs } from './core/tabs.js';
import { DEFAULT_SPREAD } from './data/spread-defaults.js';

// ── Module imports — order matters: any module that references ──
//    `state.MAP` must come AFTER initMap() runs in boot() below.   ──

// Core / data / utilities (no DOM wiring)
import './utils/escape.js';
import './utils/parsers.js';
import './utils/geo.js';
import './utils/dedupe.js';
import './utils/rod-row.js';
import './data/ramps-loader.js';
// `import './data/lakes.js'` was here. It was a bare side-effect import of a file whose only
// content is `export const LAKE_DB = {...}` -- so it had no side effect to run, and once
// ramps.js dropped its unused LAKE_DB import on 2026-08-02 nothing in the app read the file
// at all. Removed so `data/lakes.js` is fully orphaned and can be deleted; the 50 curated
// lakes, their gauge ids, pool curves and ramps were folded into lake_index.json by
// consolidate_lake_index.py, which is what made the file removable in the first place.

// Feature modules (each wires its own button handlers on import)
import './modules/gps.js';
import './modules/ramps.js';
import './modules/chart-overlay.js';
import './modules/chart-mosaic.js';
import './modules/chart-import.js';
import './modules/custom-vectors.js';
import './modules/spread-builder.js';
import './modules/saved-spreads.js';
import './modules/catch-journal.js';
import './modules/garmin-parser.js';
import './modules/file-io.js';
import './modules/topbar.js';
import './modules/lake-ramp-select.js';
import './modules/noaa-tides.js';
import './modules/conditions-strip.js';
import './modules/utility-sync.js';
import './modules/lake-intel.js';
import './modules/plan-builder.js';
import './modules/edit.js';
import './modules/track-reverse.js';
import './modules/contour-data.js';
import './modules/capture-panel.js';
import './modules/routes-panel.js';
import './modules/fishing-index.js';
import './modules/measure-tool.js';
import './modules/catch-plot.js';
import './modules/waypoint-to-generator.js';
import './modules/spot-repositioning.js';
import './modules/safety-checklist.js';
import './modules/gis-toggles.js';
import './modules/layers-panel.js';
import './modules/ble-motor.js';
import './modules/wet-hands-remote.js';
import './modules/gear-autopilot.js';
import './modules/auto-crop.js';
import './modules/catch-photo.js';
import './modules/osm-structure.js';
import './modules/quickdraw-key.js';
import './modules/sw-register.js';
import './modules/supplemental-layers.js';
import './modules/coastal-layers.js';
import './modules/species-selector.js';
import './modules/notifications.js';
import './modules/plan-tab-wiring.js';
// SmartPlan v2. v1 was deleted 2026-08-20 -- it had been unreachable since v2 shipped
// (smart-plan.js checked window.__smartPlanV2Owns and never bound Generate), and the
// Groq coach went with it: startCoachSession was called from v1 and nowhere else.
// Ryan, 2026-08-20: "Cut v1, let the coach go".
import './modules/smart-plan-v2-wiring.js';
// Pick Water — the tab where the fisherman chooses the water before the model sees anything.
// AFTER smart-plan-v2-wiring, which it imports readInputs/rampCoords from so there is one form
// and no second copy to drift out of step. See claude/THE_FISHERMAN_CHOOSES_2026-08-10.md.
import { initWaterTab } from './modules/plan-water-ui.js';
initWaterTab();
import { pullUpdatesOnLoad, pushAllLocalToCloud } from './modules/cloud-sync.js';
import { initTackleInventoryPanel } from './modules/tackle-inventory-ui.js'
import './modules/lake-research.js';

// ── Plan-tab dropdown helpers are exposed on `window` so the ──
//    tab switcher in core/tabs.js can invoke them by name.        ──
import { populatePlanLakeDropdown, populatePlanRampDropdown, isPlanRiverValue, getPlanRiverDef } from './modules/plan-builder.js';
import { syncLakeIntelData, syncClarityIntelData } from './modules/lake-intel.js';
import { syncUtilityData } from './modules/utility-sync.js';
import { renderSpread } from './modules/spread-builder.js';
import { loadSavedSpreads } from './modules/saved-spreads.js';
import { loadCatches } from './modules/catch-journal.js';
import { restoreCharts } from './modules/chart-mosaic.js';
import { loadAllLayers } from './modules/chart-import.js';
import { renderEditTables } from './modules/edit.js';
import { renderPlanStats } from './modules/plan-builder.js';

window.populatePlanLakeDropdown = populatePlanLakeDropdown;
window.populatePlanRampDropdown = populatePlanRampDropdown;
window.syncLakeIntelData = syncLakeIntelData;
window.syncClarityIntelData = syncClarityIntelData;
window.syncUtilityData = syncUtilityData;
window.renderSpread = renderSpread;
window.loadSavedSpreads = loadSavedSpreads;
window.loadCatches = loadCatches;
window.restoreCharts = restoreCharts;
window.loadAllLayers = loadAllLayers;
window.renderEditTables = renderEditTables;
window.renderPlanStats = renderPlanStats;
window.pushAllLocalToCloud = pushAllLocalToCloud;
window.isPlanRiverValue = isPlanRiverValue;
window.getPlanRiverDef = getPlanRiverDef;

// `window.DB` lived here. It was labelled a "legacy alias — some older modules reference
// window.DB instead of importing from utils/db.js", but the migration it implied had never
// happened in either direction: this file was the ONLY place that imported utils/db.js
// directly, and all twelve consumers reached the store exclusively through the global. Every
// read and write paid a `import('./utils/db.js').then(...)` round trip that a static import
// does for free, which is the "no actual code base changes that make things run more
// efficiently" Ryan was describing.
//
// It also hid a bug. `db` was a getter returning `openDB()`, i.e. a Promise, so the
// `if (!window.DB?.db) return;` readiness guard used at 21 call sites could never be true.
// utils/db.js now exports isReady() for that. Removed 2026-08-03.

// ── Bootstrap ────────────────────────────────────────────────────────

async function boot() {
  try {
    // Open IndexedDB and restore persisted working data
    await dbReady(async () => {
      // Restore persisted state from IndexedDB
      try { await restoreWorkingData(); } catch (e) { console.warn('Working data restore failed:', e); }
      try { await loadAllLayers(); } catch (e) { console.warn('Layers restore failed:', e); }
      try { await loadSavedSpreads(); } catch (e) { console.warn('Spreads restore failed:', e); }
      try { await loadCatches(); } catch (e) { console.warn('Catches restore failed:', e); }

      // Populate plan dropdowns once DB is ready
      try { populatePlanLakeDropdown(); } catch (e) { console.warn('Plan lake dropdown:', e); }
      try {
        const lake = document.getElementById('planLake')?.value;
        if (lake) populatePlanRampDropdown(lake);
      } catch (e) { console.warn('Plan ramp dropdown:', e); }
      // Re-run ramp population after a short delay in case restoreWorkingData
      // hasn't finished setting planLake value yet
      setTimeout(() => {
        try {
          const lake = document.getElementById('planLake')?.value;
          if (lake) populatePlanRampDropdown(lake);
        } catch (err) {
          // A retry a second after load, for the case where restoreWorkingData had not yet
          // set planLake. If it throws, the ramp dropdown stays empty and looks like the lake
          // has no access points.
          console.warn('[main] delayed ramp population failed:', err);
        }
      }, 1000);
    });

    // Initialize the Leaflet map (this populates state.MAP and renders base tiles)
    initMap();

    // Restore charts AFTER map is ready so Leaflet layers can be added
    try { await restoreCharts(); } catch (e) { console.warn('Charts restore failed:', e); }

    // Pull cloud updates (non-blocking — fires after local restore is done)
    pullUpdatesOnLoad().catch((e) => console.warn('Cloud pull failed:', e));
    initTackleInventoryPanel();

    // Seed default 6-rod spread on first run (when SPREAD is empty)
    if (!state.SPREAD || state.SPREAD.length === 0) {
      state.SPREAD = DEFAULT_SPREAD.slice();
    }

    // First render of map + edit tables + plan stats + spread table
    renderAll();
    renderSpread();

    // Wire up the bottom-nav tab switcher
    initTabs();

    console.log('✓ TrollMap modular build loaded');
  } catch (e) {
    console.error('TrollMap boot failed:', e);
    document.body.insertAdjacentHTML(
      'afterbegin',
      `<div style="background:#b3261e;color:#fff;padding:14px;font-family:monospace">
        <b>TrollMap failed to load.</b><br>
        <pre style="white-space:pre-wrap;margin:8px 0 0">${(e && e.stack) || e}</pre>
      </div>`,
    );
  }
}

// Kick off the boot. All imports above have already executed by now
// (modules attach their event handlers and wire buttons eagerly),
// so all we need to do is open the DB + initialize the map + restore.
boot();