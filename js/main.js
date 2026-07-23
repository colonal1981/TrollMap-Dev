/**
 * TrollMap GPX Studio v10 — modular entry point (refactored Phase 5)
 *
 * This is the ONLY <script> loaded by index.html. It:
 *   1. Imports every JS module (each module wires its own DOM
 *      button handlers via side effects — to be replaced by init*() calls in future).
 *   2. Opens IndexedDB and restores any persisted working data.
 *   3. Initializes the Leaflet map + tab switcher.
 *   4. Sets up the default rod spread + plan dropdowns.
 *   5. Initializes legacy window bridge for HTML onclick compat (Phase 5)
 *   6. Initializes centralized worker API client (js/api/worker.js)
 *
 * Cross-module shared state lives in core/state.js (the `state` singleton).
 * Helpers that popup buttons invoke across modules are now consolidated in
 * legacy-window.js (temporary) and api/worker.js (permanent client).
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
import { ensureLegacyGlobals, initLegacyWindowBridge } from './legacy-window.js';
import { CF_WORKER_URL } from './api/worker.js';

// ── Module imports — order matters: any module that references ──
//    `state.MAP` must come AFTER initMap() runs in boot() below.
//    Side-effect imports wire DOM handlers at load time (legacy pattern).
//    Future refactor will replace with explicit initFoo(state, api) calls.

// Core / data / utilities (no DOM wiring)
import './utils/escape.js';
import './utils/parsers.js';
import './utils/geo.js'; // single source for dist/bearing (Phase 4)
import './utils/dedupe.js';
import './utils/rod-row.js';
import './data/ramps-loader.js';
import './data/lakes.js';
import './data/lake-keys.js'; // single source 101 entries

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
import { initTackleInventoryPanel } from './modules/tackle-inventory-ui.js';
import './modules/lake-research.js';

// ── Plan-tab helpers — now via legacy-window bridge + direct exports ──
import { populatePlanLakeDropdown, populatePlanRampDropdown } from './modules/plan-builder.js';

// Ensure legacy globals exist early (window._smartPlanPhaseRoutes etc) so modules that reference them don't crash
ensureLegacyGlobals();

// ── Bootstrap ────────────────────────────────────────────────────────

async function boot() {
  try {
    // Open IndexedDB and restore persisted working data
    await dbReady(async () => {
      try {
        await restoreWorkingData();
      } catch (e) {
        console.warn('Working data restore failed:', e);
      }
      try {
        await (await import('./modules/chart-import.js')).loadAllLayers();
      } catch (e) {
        console.warn('Layers restore failed:', e);
      }
      try {
        const { loadSavedSpreads } = await import('./modules/saved-spreads.js');
        await loadSavedSpreads();
      } catch (e) {
        console.warn('Spreads restore failed:', e);
      }
      try {
        const { loadCatches } = await import('./modules/catch-journal.js');
        await loadCatches();
      } catch (e) {
        console.warn('Catches restore failed:', e);
      }

      // Populate plan dropdowns once DB is ready
      try {
        populatePlanLakeDropdown();
      } catch (e) {
        console.warn('Plan lake dropdown:', e);
      }
      try {
        const lake = document.getElementById('planLake')?.value;
        if (lake) populatePlanRampDropdown(lake);
      } catch (e) {
        console.warn('Plan ramp dropdown:', e);
      }
      setTimeout(() => {
        try {
          const lake = document.getElementById('planLake')?.value;
          if (lake) populatePlanRampDropdown(lake);
        } catch (e) {}
      }, 1000);
    });

    // Initialize the Leaflet map (this populates state.MAP and renders base tiles)
    initMap();

    // Initialize legacy window bridge AFTER map is ready (needs state.MAP for some globals)
    try {
      await initLegacyWindowBridge(state);
    } catch (e) {
      console.warn('Legacy window bridge failed:', e);
    }

    // Restore charts AFTER map is ready so Leaflet layers can be added
    try {
      const { restoreCharts } = await import('./modules/chart-mosaic.js');
      await restoreCharts();
    } catch (e) {
      console.warn('Charts restore failed:', e);
    }

    // Pull cloud updates (non-blocking)
    pullUpdatesOnLoad().catch((e) => console.warn('Cloud pull failed:', e));
    initTackleInventoryPanel();

    // Seed default 6-rod spread on first run
    if (!state.SPREAD || state.SPREAD.length === 0) {
      state.SPREAD = DEFAULT_SPREAD.slice();
    }

    // First render
    const { renderAll: renderAllFn } = await import('./core/map-init.js');
    const { renderSpread } = await import('./modules/spread-builder.js');
    renderAllFn();
    renderSpread();

    // Wire up tabs
    initTabs();

    console.log(`✓ TrollMap modular build loaded (worker: ${CF_WORKER_URL})`);
  } catch (e) {
    console.error('TrollMap boot failed:', e);
    document.body.insertAdjacentHTML(
      'afterbegin',
      `<div style="background:#b3261e;color:#fff;padding:14px;font-family:monospace">
        <b>TrollMap failed to load.</b><br>
        <pre style="white-space:pre-wrap;margin:8px 0 0">${(e && e.stack) || e}</pre>
      </div>`
    );
  }
}

boot();
