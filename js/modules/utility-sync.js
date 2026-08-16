/**
 * Live water conditions for the selected Plan lake — ONE read, one unit.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 2026-08-16: *"i will almost never want anything alongside... i hate the bolt on
 * approach... merge reduce make better, make it smarter."*
 *
 * WHAT THIS FILE USED TO BE: a seven-lake hand-typed table (`UTILITY_FEEDS`, with `normalPool`
 * and `minPool` as strings), a substring lookup into it, a `/lake` call, a Duke-dashboard call
 * behind a second substring match, a USGS temperature call, and a fallback that filled the form
 * with a hardcoded operating curve when everything else failed. Duke lakes came out as a
 * PERCENT and every other lake as FEET, in the same two form fields.
 *
 * WHAT IT IS NOW: `/conditions/{slug}`, which resolves the level from `water_bindings.json` —
 * 147 bound lakes, 19 of them with a live operator feed — and returns feet for all of them.
 *
 * THE FALLBACK IS GONE ON PURPOSE. Writing a published normal pool into the Current Level field
 * when nothing answered makes a guess indistinguishable from a reading, and the trip decision
 * downstream cannot tell them apart. An empty field with a stated reason is the honest answer.
 */

import { CF_WORKER_URL } from '../core/state.js';
import { lakeRecordFor } from '../data/lake-registry.js';
import { fetchWaterConditions, levelSentence } from '../utils/water-conditions.js';

function say(msg, isErr) {
  const statusEl = document.getElementById('utilitySyncStatus');
  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.style.color = isErr ? 'var(--bad)' : 'var(--accent2)';
}

function setVal(id, v) {
  const el = document.getElementById(id);
  if (!el) return;
  el.value = v == null ? '' : String(v);
}

/** The box above the form: which source answered, what it said, and where to check it. */
function paintAssessment(rec, c) {
  const boxEl = document.getElementById('utilityAssessmentBox');
  const titleEl = document.getElementById('uTitle');
  const descEl = document.getElementById('uDesc');
  const linkEl = document.getElementById('uLink');
  if (!boxEl) return;
  if (!rec) { boxEl.style.display = 'none'; return; }
  boxEl.style.display = 'block';
  if (titleEl) {
    titleEl.textContent = c && c.levelSource
      ? c.levelSource
      : `${rec.displayName || rec.name} — no level feed bound`;
  }
  if (descEl) {
    const bits = [levelSentence(c)];
    if (c && c.observedAt) bits.push(`Observed ${c.observedAt}.`);
    if (c && c.waterTempF != null) {
      bits.push(c.waterTempFrom === 'tailwater'
        // The river below the dam is not the lake, and saying so costs one clause.
        ? `Water temp ${c.waterTempF} °F from the TAILWATER gauge${c.waterTempGauge ? ` (${c.waterTempGauge})` : ''} — below the dam, not the lake.`
        : `Water temp ${c.waterTempF} °F${c.waterTempGauge ? ` (${c.waterTempGauge})` : ''}.`);
    }
    if (c && c.usaceTargetFt != null) {
      bits.push(`Corps target pool for ${c.usaceProject || 'this project'} today: ${c.usaceTargetFt} ft — a target, not a reading.`);
    }
    descEl.textContent = bits.join(' ');
  }
  if (linkEl) {
    if (c && c.levelUrl) { linkEl.href = c.levelUrl; linkEl.style.display = ''; }
    else linkEl.style.display = 'none';
  }
}

/** Resolve the Plan form's current selection to a registry record. */
function selectedRecord() {
  const lakeStr = document.getElementById('planLake')?.value
                || document.getElementById('lakeSelect')?.value
                || '';
  if (!lakeStr) return null;
  return lakeRecordFor(lakeStr) || lakeRecordFor(lakeStr.split(',')[0].trim()) || null;
}

/** Main sync — one request, then the form and the box say the same thing. */
export async function syncUtilityData() {
  const lakeStr = document.getElementById('planLake')?.value
                || document.getElementById('lakeSelect')?.value
                || '';

  // River trips delegate to syncPlanRiverData (when available)
  if (typeof window.isPlanRiverValue === 'function' && window.isPlanRiverValue(lakeStr)) {
    if (typeof window.syncPlanRiverData === 'function') await window.syncPlanRiverData();
    return;
  }

  const rec = selectedRecord();
  const syncBtn = document.getElementById('syncDukeBtn');
  if (syncBtn) { syncBtn.style.background = 'var(--accent)'; syncBtn.style.color = '#000'; }
  say('Reading live conditions…', false);

  try {
    if (!rec) {
      say(`"${lakeStr}" does not resolve to a lake in the registry.`, true);
      paintAssessment(null, null);
      return;
    }
    const worker = CF_WORKER_URL || window.CF_WORKER_URL;
    const planDate = document.getElementById('planDate')?.value || undefined;
    const c = await fetchWaterConditions(worker, rec, { date: planDate });
    paintAssessment(rec, c);

    if (c.error) { say(`Live conditions unavailable: ${c.error}`, true); return; }

    // FEET, ALWAYS. `planFullPool` and `planPoolLevel` were a percent on Duke lakes and feet
    // everywhere else, which the trip decision then read through a units branch. One unit
    // removes the branch and makes two lakes comparable.
    setVal('planFullPool', c.fullPoolFt != null ? c.fullPoolFt.toFixed(1) : '');
    setVal('planPoolLevel', c.levelFt != null ? c.levelFt.toFixed(1) : '');
    // The drawdown is its own field because it is the number that survives when a lake
    // publishes no absolute elevation — Brookfield's Chilhowee and Calderwood do exactly that.
    setVal('planBelowFullPool', c.belowFullPoolFt != null ? c.belowFullPoolFt.toFixed(2) : '');
    if (c.waterTempF != null && c.waterTempFrom !== 'tailwater') setVal('planWaterTemp', c.waterTempF);

    if (c.belowFullPoolFt == null && c.levelFt == null) {
      say(c.pending || 'No source publishes a level for this water.', true);
      return;
    }
    say(`✓ ${levelSentence(c)}`, false);
  } catch (err) {
    // No hardcoded curve gets written here. A guess in the Current Level field is
    // indistinguishable from a reading by the time the trip decision reads it.
    console.warn('[utility-sync] conditions read failed:', err);
    say(`Live conditions failed: ${String((err && err.message) || err)}`, true);
  } finally {
    if (syncBtn) setTimeout(() => { syncBtn.style.background = ''; syncBtn.style.color = ''; }, 1000);
  }
}

window.syncUtilityData = syncUtilityData;

// ── Wire the Lake dropdown + sync button ────────────────────────────────

function wireLakeDropdown() {
  const lakeSel = document.getElementById('planLake');
  if (!lakeSel) return;
  lakeSel.addEventListener('change', () => { syncUtilityData(); });
}

function wireSyncButton() {
  document.getElementById('syncDukeBtn')?.addEventListener('click', syncUtilityData);
}

setTimeout(() => {
  wireLakeDropdown();
  wireSyncButton();
  // Auto-trigger once on app load (gives the form an initial fill)
  setTimeout(syncUtilityData, 800);
}, 500);
