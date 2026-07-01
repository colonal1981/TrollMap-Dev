/**
 * Lake Database + Boat Ramp Launch dropdowns in the map toolbar.
 *
 * Populates #lakeSelect with all lakes from LAKE_DB + TRISTATE_MASTER_RAMPS,
 * then populates #rampSelect when a lake is selected. Also flies the map
 * to the selected lake/ramp and syncs the planLake/planRamp fields.
 */

import { state } from '../core/state.js';
import { LAKE_DB } from '../data/lakes.js';
import { TRISTATE_MASTER_RAMPS } from '../data/ramps.js';
import { dedupeLaunchesList } from '../utils/dedupe.js';

// ── Build the merged lake name list ─────────────────────────────────────

function getUniversalLakeNames() {
  const list = new Set(Object.keys(LAKE_DB));
  ['SC', 'NC', 'GA'].forEach((st) => {
    Object.keys(TRISTATE_MASTER_RAMPS[st] || {}).forEach((lk) => {
      if (!lk || lk === 'SC Waterways' || lk === 'GA Waterways' || lk === 'NC Waterways') return;
      let match = false;
      for (const existing of list) {
        if (
          existing.toUpperCase().includes(lk.toUpperCase()) ||
          lk.toUpperCase().includes(existing.split(',')[0].toUpperCase())
        ) {
          match = true;
          break;
        }
      }
      if (!match) list.add(`${lk.replace(/^\w/, (c) => c.toUpperCase())}, ${st}`);
    });
  });
  return [...list].sort();
}

window.getUniversalLakeNames = getUniversalLakeNames;

// ── Populate lake dropdown ───────────────────────────────────────────────

function populateLakeSelect() {
  const lakeSelect = document.getElementById('lakeSelect');
  if (!lakeSelect) return;

  getUniversalLakeNames().forEach((lakeName) => {
    const opt = document.createElement('option');
    opt.value = lakeName;
    opt.textContent = lakeName;
    lakeSelect.appendChild(opt);
  });
}

// ── Lake change handler ──────────────────────────────────────────────────

function onLakeChange(selLakeName) {
  const rampSel = document.getElementById('rampSelect');
  if (rampSel) rampSel.innerHTML = '<option value="">-- Master Ramps Index --</option>';
  if (!selLakeName) {
    if (rampSel) rampSel.disabled = true;
    return;
  }

  // Fly map to lake
  if (LAKE_DB[selLakeName] && state.MAP_OK) {
    const C = LAKE_DB[selLakeName].center;
    state.MAP.setView([C[0], C[1]], C[2] || 11);
  } else if (state.MAP_OK && selLakeName) {
    const lkClean = selLakeName.split(',')[0].trim();
    const st = selLakeName.split(',')[1]?.trim() || 'SC';
    const rampsObj = (TRISTATE_MASTER_RAMPS[st] || {})[lkClean];
    if (rampsObj && Object.values(rampsObj).length) {
      state.MAP.fitBounds(Object.values(rampsObj), { padding: [40, 40] });
    }
  }

  // Sync planLake if not already set
  const planLakeEl = document.getElementById('planLake');
  if (planLakeEl && !planLakeEl.value) planLakeEl.value = selLakeName;

  // Populate ramp dropdown
  if (!rampSel) return;
  rampSel.disabled = false;

  let matchedLaunches = {};
  if (LAKE_DB[selLakeName]?.ramps) {
    Object.assign(matchedLaunches, LAKE_DB[selLakeName].ramps);
  }

  const lkUpper = selLakeName.toUpperCase();
  ['SC', 'NC', 'GA'].forEach((st) => {
    Object.keys(TRISTATE_MASTER_RAMPS[st] || {}).forEach((k) => {
      if (lkUpper.includes(k.toUpperCase()) || k.toUpperCase().includes(lkUpper.split(',')[0])) {
        Object.assign(matchedLaunches, TRISTATE_MASTER_RAMPS[st][k]);
      }
    });
  });

  const deduped = dedupeLaunchesList(matchedLaunches);
  const rampNames = Object.keys(deduped).sort();

  if (rampNames.length) {
    rampNames.forEach((rName) => {
      const opt = document.createElement('option');
      opt.value = rName;
      opt.textContent = rName;
      opt.dataset.coords = deduped[rName].join(',');
      rampSel.appendChild(opt);
    });
  } else {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '— custom lake launch —';
    rampSel.appendChild(opt);
  }
}

// ── Ramp change handler ──────────────────────────────────────────────────

function onRampChange(selOpt) {
  if (!selOpt.value || !selOpt.dataset.coords || !state.MAP_OK) return;
  const [lat, lon] = selOpt.dataset.coords.split(',').map(Number);
  state.MAP.setView([lat, lon], 15);
  const planRampEl = document.getElementById('planRamp');
  if (planRampEl) planRampEl.value = selOpt.value;
}

// ── Wire everything ──────────────────────────────────────────────────────

function wire() {
  // Try to populate immediately, and set a tiny timeout to catch the async fetch if needed
  setTimeout(populateLakeSelect, 500);

  document.getElementById('lakeSelect')?.addEventListener('change', (e) => {
    onLakeChange(e.target.value);
  });

  document.getElementById('rampSelect')?.addEventListener('change', function () {
    onRampChange(this.options[this.selectedIndex]);
  });
}

wire();
