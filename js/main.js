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
import './data/lakes.js';

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
import './modules/garmin-export.js';
import './modules/file-io.js';
import './modules/topbar.js';
import './modules/lake-ramp-select.js';
import './modules/noaa-tides.js';
import './modules/duke-energy.js';
import './modules/utility-sync.js';
import './modules/lake-intel.js';
import './modules/plan-builder.js';
import './modules/smart-plan.js';
import './modules/edit.js';
import './modules/track-reverse.js';
import './modules/contour-data.js';
import './modules/capture-panel.js';
import './modules/route-builder.js';
import './modules/routes-panel.js';
import './modules/fishing-index.js';
import './modules/measure-tool.js';
import './modules/catch-plot.js';
import './modules/waypoint-to-generator.js';
import './modules/spot-repositioning.js';
import './modules/safety-checklist.js';
import './modules/gis-toggles.js';
import './modules/ble-motor.js';
import './modules/wet-hands-remote.js';
import './modules/gear-autopilot.js';
import './modules/auto-crop.js';
import './modules/casting-rings.js';
import './modules/catch-photo.js';
import './modules/osm-structure.js';
import './modules/quickdraw-key.js';
import './modules/sw-register.js';
import './modules/supplemental-layers.js';
import './modules/groq-coach.js';
import './modules/notifications.js';
import './modules/route-debug.js';
import './modules/plan-tab-wiring.js';
import { pullUpdatesOnLoad, pushAllLocalToCloud } from './modules/cloud-sync.js';
import './modules/pinch-point-finder.js'; // still used by route-builder.js
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

// ── DB legacy alias — some older modules reference window.DB ──
//    instead of importing { put, get, ... } from utils/db.js. ──
window.DB = {
  get db() { return openDB(); },  // returns the cached promise
  put: (...args) => import('./utils/db.js').then((m) => m.put(...args)),
  get: (...args) => import('./utils/db.js').then((m) => m.get(...args)),
  getAll: (...args) => import('./utils/db.js').then((m) => m.getAll(...args)),
  del: (...args) => import('./utils/db.js').then((m) => m.del(...args)),
  clear: (...args) => import('./utils/db.js').then((m) => m.clear(...args)),
};

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
        } catch (e) {}
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