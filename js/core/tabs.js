/**
 * Bottom-nav tab switcher.
 *
 * Wires up the four primary tabs (Map / Generate / Edit / Plan) and
 * runs per-tab setup work on activation. The original code did this
 * inline at module-evaluation time; we expose it as a function so
 * `main.js` controls initialization order.
 *
 * Cross-module calls (renderEditTables, renderPlanStats, syncUtilityData,
 * syncLakeIntelData, syncClarityIntelData, clearAllLayers) are looked up
 * on `window` at click time so we don't need to import every module
 * from here. That keeps this file's dependency surface tiny.
 *
 * NOTE: keep these calls defensive — feature modules load in parallel
 * and a user may click a tab before all of them are ready.
 */

import { state } from './state.js';

export function initTabs() {
  document.querySelectorAll('#bottomNav button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
      document.querySelectorAll('#bottomNav button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('panel-' + tab)?.classList.add('active');

      // Map tab — Leaflet needs invalidateSize() after the panel becomes visible
      // because the map was rendered when its container was hidden.
      if (tab === 'map' && state.MAP) {
        setTimeout(() => state.MAP.invalidateSize(), 50);
        if (typeof window.fitMap === 'function') window.fitMap();
      }

      // Edit tab — re-render the waypoint/track table each time it opens
      // so newly added waypoints show up without a page refresh.
      if (tab === 'edit') {
        try { window.renderEditTables?.(); } catch (_) {}
      }

      // Plan tab — refresh stats and auto-sync worker data blocks.
      if (tab === 'plan') {
        try { window.renderPlanStats?.(); } catch (_) {}

        const planLakeVal = document.getElementById('planLake')?.value;
        if (!planLakeVal) return;

        // Utility sync: prefer the named sync function, fall back to clicking the button.
        if (typeof window.syncUtilityData === 'function') {
          setTimeout(window.syncUtilityData, 400);
        } else {
          setTimeout(() => document.getElementById('syncDukeBtn')?.click(), 400);
        }
        if (typeof window.syncLakeIntelData === 'function') {
          setTimeout(window.syncLakeIntelData, 600);
        }
        if (typeof window.syncClarityIntelData === 'function') {
          setTimeout(window.syncClarityIntelData, 900);
        }
      }
    });
  });

  document.getElementById('clearAllLayersBtn')?.addEventListener('click', () => {
    try { window.clearAllLayers?.(); } catch (_) {}
  });
}
