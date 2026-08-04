/**
 * Saved rod spreads — name a rod configuration and persist it
 * to IndexedDB so you can quickly switch spreads between trips.
 */

import { state } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { setBanner } from '../core/map-init.js';
import { renderSpread } from './spread-builder.js';
import { put as dbPut, getAll as dbGetAll, isReady as dbIsReady, tryDel } from '../utils/db.js';

// Module-level cache mirroring what's in IndexedDB.
let SAVED_SPREADS = {};

export async function loadSavedSpreads() {
  if (!dbIsReady()) return;
  try {
    const all = await dbGetAll('spreads');
    console.log('[IDB] spreads found:', all.length);
    SAVED_SPREADS = {};
    all.forEach((s) => { SAVED_SPREADS[s.name] = s.rods; });
    refreshSpreadsSelect();
  } catch (e) {
    console.warn('[IDB] loadSavedSpreads error:', e);
  }
}

function refreshSpreadsSelect() {
  const sel = document.getElementById('savedSpreadsSelect');
  if (!sel) return;
  sel.innerHTML = '<option value="">— load a saved spread —</option>' +
    Object.keys(SAVED_SPREADS).map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
}

async function saveCurrentSpread() {
  if (!state.SPREAD.length) { alert('No rods in spread'); return; }
  const defaultName = (document.getElementById('planName')?.value || '') + ' Spread';
  const name = prompt('Save spread as:', defaultName);
  if (!name) return;
  SAVED_SPREADS[name] = state.SPREAD.map((r) => Object.assign({}, r));
  if (dbIsReady()) {
    try {
      await dbPut('spreads', { name, rods: SAVED_SPREADS[name] });
      setBanner(`✅ Spread "${name}" saved`);
      setTimeout(() => setBanner(''), 2500);
    } catch (e) {
      alert('Spread save failed: ' + e);
    }
  }
  refreshSpreadsSelect();
  const sel = document.getElementById('savedSpreadsSelect');
  if (sel) sel.value = name;
}

async function deleteSavedSpread() {
  const name = document.getElementById('savedSpreadsSelect')?.value;
  if (!name) { alert('Select a spread first'); return; }
  if (!confirm(`Delete "${name}"?`)) return;
  delete SAVED_SPREADS[name];
  if (dbIsReady()) {
    // The in-memory delete above already happened. If the store write fails silently the
    // spread reappears on the next load, which reads as the delete button not working.
    await tryDel('spreads', name, `spread "${name}"`);
  }
  refreshSpreadsSelect();
}

function loadSpreadFromSelect(e) {
  const name = e.target.value;
  if (!name || !SAVED_SPREADS[name]) return;
  state.SPREAD = SAVED_SPREADS[name].map((r) => Object.assign({}, r));
  renderSpread();
}

function wireButtons() {
  document.getElementById('saveSpreadBtn')?.addEventListener('click', saveCurrentSpread);
  document.getElementById('delSpreadBtn')?.addEventListener('click', deleteSavedSpread);
  document.getElementById('savedSpreadsSelect')?.addEventListener('change', loadSpreadFromSelect);
}

wireButtons();
