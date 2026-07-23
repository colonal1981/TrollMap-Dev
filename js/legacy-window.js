/**
 * js/legacy-window.js — Phase 5 frontend structure: temporary bridge for window.* bus
 *
 * Previously, 393 window.* assignments were scattered across 20+ modules:
 *   window.runSmartPlan, window.renderAll, window._smartPlanPhaseRoutes, etc.
 * This made renames dangerous and blocked tree-shaking.
 *
 * Target architecture (per REFACTOR_AUDIT.md §4.2):
 *   js/
 *     main.js — boot only, explicit init*() calls
 *     api/worker.js — typed worker client
 *     legacy-window.js — TEMP bridge: Object.assign(window, api) for HTML onclick compat
 *
 * This file consolidates all window.* assignments in one place, so future PRs
 * can gradually replace inline HTML onclick handlers with proper imports.
 *
 * It intentionally does NOT import heavy modules — it dynamically imports them
 * on boot to avoid circular dependencies and to keep main.js side-effect-free.
 *
 * Usage in main.js:
 *   import { initLegacyWindowBridge } from './legacy-window.js';
 *   await initLegacyWindowBridge(state);
 */

export async function initLegacyWindowBridge(state) {
  // Import modules that previously assigned window.* and re-expose their APIs
  // This is a temporary bridge — each window.* should be replaced by proper import
  // in the module that actually needs it.

  const [
    mapInit,
    planBuilder,
    spreadBuilder,
    savedSpreads,
    catchJournal,
    chartMosaic,
    chartImport,
    editModule,
    planStatsModule,
    lakeIntel,
    utilitySync,
    supplemental,
    contourData,
    smartPlan,
    routeBuilder,
    // add more as needed
  ] = await Promise.all([
    import('./core/map-init.js'),
    import('./modules/plan-builder.js'),
    import('./modules/spread-builder.js'),
    import('./modules/saved-spreads.js'),
    import('./modules/catch-journal.js'),
    import('./modules/chart-mosaic.js'),
    import('./modules/chart-import.js'),
    import('./modules/edit.js'),
    import('./modules/plan-builder.js'),
    import('./modules/lake-intel.js'),
    import('./modules/utility-sync.js'),
    import('./modules/supplemental-layers.js').catch(() => ({})),
    import('./modules/contour-data.js').catch(() => ({})),
    import('./modules/smart-plan.js').catch(() => ({})),
    import('./modules/route-builder.js').catch(() => ({})),
  ]);

  // Core map / state
  if (typeof window !== 'undefined') {
    window.MAP = state.MAP;
    window.state = state;

    // Plan dropdowns (used by tabs.js)
    window.populatePlanLakeDropdown = planBuilder.populatePlanLakeDropdown;
    window.populatePlanRampDropdown = planBuilder.populatePlanRampDropdown;
    window.isPlanRiverValue = planBuilder.isPlanRiverValue;
    window.getPlanRiverDef = planBuilder.getPlanRiverDef;
    window.renderPlanStats = planBuilder.renderPlanStats;

    // Spread / catches / charts
    window.renderSpread = spreadBuilder.renderSpread;
    window.loadSavedSpreads = savedSpreads.loadSavedSpreads;
    window.loadCatches = catchJournal.loadCatches;
    window.restoreCharts = chartMosaic.restoreCharts;
    window.loadAllLayers = chartImport.loadAllLayers;
    window.renderEditTables = editModule.renderEditTables;

    // Lake intel / clarity
    window.syncLakeIntelData = lakeIntel.syncLakeIntelData;
    window.syncClarityIntelData = lakeIntel.syncClarityIntelData;
    window.syncUtilityData = utilitySync.syncUtilityData;

    // Cloud sync
    const cloudSync = await import('./modules/cloud-sync.js').catch(() => ({}));
    if (cloudSync.pushAllLocalToCloud) {
      window.pushAllLocalToCloud = cloudSync.pushAllLocalToCloud;
    }

    // Supplemental / contour
    if (supplemental.loadSupplementalForLake) {
      window.loadSupplementalForLake = supplemental.loadSupplementalForLake;
    }
    if (supplemental.getSupplementalContext) {
      window.getSupplementalContext = supplemental.getSupplementalContext;
    }
    if (contourData.loadContourForLake) {
      window.loadContourForLake = contourData.loadContourForLake;
    }

    // Smart plan
    if (smartPlan.runSmartPlan) {
      window.runSmartPlan = smartPlan.runSmartPlan;
      window.applyStoredSmartPlanDepth = smartPlan.applyStoredSmartPlanDepth;
    }

    // Route builder globals used by inline HTML and other modules
    if (typeof window._smartPlanPhaseRoutes === 'undefined') window._smartPlanPhaseRoutes = [];
    if (typeof window._smartPlanRouteRods === 'undefined') window._smartPlanRouteRods = {};
    if (typeof window._trollmapPhases === 'undefined') window._trollmapPhases = [];
    if (typeof window.ACTIVE_BLE_BMS === 'undefined') window.ACTIVE_BLE_BMS = null;

    // Legacy DB alias (some older modules reference window.DB)
    const dbModule = await import('./utils/db.js').catch(() => null);
    if (dbModule) {
      window.DB = {
        get db() {
          return dbModule.openDB();
        },
        put: (...args) => dbModule.put(...args),
        get: (...args) => dbModule.get(...args),
        getAll: (...args) => dbModule.getAll(...args),
        del: (...args) => dbModule.del(...args),
        clear: (...args) => dbModule.clear(...args),
      };
    }

    console.log('[legacy-window] bridge init — consolidated window.* assignments');
  }
}

// For backward compat, also expose a synchronous version that just ensures globals exist
export function ensureLegacyGlobals() {
  if (typeof window === 'undefined') return;
  if (!window._smartPlanPhaseRoutes) window._smartPlanPhaseRoutes = [];
  if (!window._smartPlanRouteRods) window._smartPlanRouteRods = {};
  if (!window._trollmapPhases) window._trollmapPhases = [];
  if (!window.ACTIVE_BLE_BMS) window.ACTIVE_BLE_BMS = null;
}
