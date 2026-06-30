/**
 * smart-plan.js — The orchestrator for TrollMap's "smart plan" feature.
 *
 * Reads the existing Plan tab fields (lake, species checkboxes, date,
 * launch time, live water temp) and produces:
 *   - a depth band recommendation per species/time-of-day
 *   - lure/technique suggestions
 *   - trolling speed
 *   - a plain-language rationale (never a black box)
 *   - regulatory flags (closed season / creel / size limits)
 *
 * Then wires the result into:
 *   - the rod spread table (via renderSpread / state.SPREAD)
 *   - Route Builder's depth-band inputs (rbDepthMin / rbDepthMax)
 *
 * This does NOT call any external AI — it's a structured lookup against
 * species-intel.js, which encodes real lake-specific behavior data and
 * verified SCDNR regulations gathered June 2026.
 */

import { state } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { newRodRow } from '../utils/rod-row.js';
import { renderSpread } from './spread-builder.js';
import {
  SPECIES_BEHAVIOR, REGULATIONS,
  getSeason, getTimeOfDay, checkRegulations, resolveLakeKey,
} from '../data/species-intel.js';

// ── Lure → color pairing ────────────────────────────────────────────────
// Maps a behavior-table lure name to one of spread-builder.js's
// COLOR_PRESETS, varied by water clarity if known. Falls back to a
// generally productive natural color.
const LURE_COLOR_DEFAULTS = {
  'Choppo 90': 'Bone / Natural',
  'Rattling Spook': 'Bone / Natural',
  'Bucktail': 'Chartreuse / White',
  'A-Rig Medium': 'Blueback Herring',
  'A-Rig Light': 'Natural Pearl / Smoke',
  'Deep Hit Stick': 'Blue / Silver Herring',
  'Umbrella Rig 3/4oz': 'Blueback Herring',
  'Crankbait': 'Sexy Shad',
  'Topwater': 'Bone / Natural',
  'Topwater shad imitation': 'Grey Shad',
  'Jigging spoon': 'Chrome / Silver',
  'Live herring free-line': null,   // live bait, no plastic color
  'Live herring downline': null,
  'Live blueback herring downline': null,
  'Live blueback herring': null,
  'Live shad downline': null,
  'Lead-core trolling': 'Sexy Shad',
  'Planer board live bait': null,
  'Down-line live herring': null,
  'Live bait downline': null,
  'Live menhaden': null,
  'Rockport Rattler jig': 'Chartreuse / Shad',
  'Jig + plastic trailer': 'Junebug / Purple',
  'Casting plugs': 'Natural Pearl / Smoke',
  'Flukes': 'Natural Pearl / Smoke',
  'Free-line herring': null,
  'Cut bait': null,
  'Live bait': null,
  'Plugs': 'Bone / Natural',
};

/**
 * Core recommendation function — pure, no DOM access. Given inputs,
 * returns a structured recommendation or a regulatory block.
 */
export function getSmartRecommendation({ lakeName, species, dateStr, launchTimeStr, waterTempF }) {
  const date = dateStr ? new Date(dateStr + 'T12:00:00') : new Date();

  // 1. Regulation check FIRST — never recommend something illegal.
  const regCheck = checkRegulations(lakeName, species, date);
  if (!regCheck.legal) {
    return {
      ok: false,
      species, lakeName,
      reason: regCheck.reason,
      regInfo: regCheck.regInfo,
    };
  }

  // 2. Look up behavior data for this lake/species. Uses the same fuzzy
  // lake-key resolution as checkRegulations(), since the Plan tab's
  // dropdown sends values like "Lake Wateree, SC" that don't exact-match
  // this file's bare "Lake Wateree" keys.
  const lakeKey = resolveLakeKey(lakeName, SPECIES_BEHAVIOR);
  const lakeData = lakeKey ? SPECIES_BEHAVIOR[lakeKey] : null;
  const speciesData = lakeData?.[species];
  if (!speciesData) {
    return {
      ok: false,
      species, lakeName,
      reason: `No behavior data available yet for ${species} on ${lakeName}. Add an entry to species-intel.js, or fish general structure (points, channel edges, ledges) and adjust based on what you mark on sonar.`,
      regInfo: regCheck.regInfo,
    };
  }

  const season = getSeason(date);
  const seasonData = speciesData[season];
  if (!seasonData) {
    return {
      ok: false,
      species, lakeName,
      reason: `No ${season} data available for ${species} on ${lakeName} yet.`,
      regInfo: regCheck.regInfo,
    };
  }

  const timeOfDay = getTimeOfDay(launchTimeStr);
  const todData = seasonData.timeOfDay[timeOfDay] || seasonData.timeOfDay['day'];

  // 3. Compute depth band — function(tempF) or fixed array, then apply
  // the time-of-day shift (negative = shallower, positive = deeper).
  let [dMin, dMax] = typeof seasonData.depthBand === 'function'
    ? seasonData.depthBand(waterTempF)
    : seasonData.depthBand;
  const shift = todData.depthShift || 0;
  dMin = Math.max(1, dMin + shift);
  dMax = Math.max(dMin + 2, dMax + shift);

  return {
    ok: true,
    species, lakeName, season, timeOfDay,
    depthMin: dMin, depthMax: dMax,
    lures: todData.lures || [],
    speed: todData.speed || 2.0,
    notes: todData.notes || '',
    regInfo: regCheck.regInfo,
    sources: seasonData.sources || [],
  };
}

/**
 * Build a human-readable rationale block for the plan preview / UI.
 */
export function buildRationaleText(rec) {
  if (!rec.ok) {
    return `⚠ ${rec.species} on ${rec.lakeName}: ${rec.reason}`;
  }
  const lines = [];
  lines.push(`${rec.species} — ${rec.lakeName}, ${rec.season} (${rec.timeOfDay})`);
  lines.push(`Target depth: ${rec.depthMin}-${rec.depthMax} ft`);
  lines.push(`Trolling speed: ${rec.speed} mph`);
  if (rec.lures.length) lines.push(`Suggested lures: ${rec.lures.join(', ')}`);
  if (rec.notes) lines.push(`Notes: ${rec.notes}`);
  if (rec.regInfo?.note) lines.push(`Regulations: ${rec.regInfo.note}`);
  if (rec.sources?.length) lines.push(`Sources: ${rec.sources.join('; ')}`);
  return lines.join('\n');
}

// ── DOM wiring ───────────────────────────────────────────────────────────

function readPlanInputs() {
  const lakeName = document.getElementById('planLake')?.value || '';
  const dateStr = document.getElementById('planDate')?.value || '';
  const launchTimeStr = document.getElementById('planLaunchTime')?.value || '';
  const waterTempStr = document.getElementById('planWaterTemp')?.value || '';
  const waterTempF = waterTempStr ? parseFloat(waterTempStr) : null;
  const species = [...document.querySelectorAll('#planSpeciesChecks input:checked')].map((c) => c.value);
  return { lakeName, dateStr, launchTimeStr, waterTempF, species };
}

/**
 * Apply a recommendation to the rod spread: fills empty rows (or adds new
 * ones if needed) with the recommended depth, lure, and color, spread
 * evenly across the suggested lure list. Does not touch rows the user has
 * already manually configured (non-empty lure field).
 */
// Kayak rig: 2 lines in the water max, no planer boards, no downriggers.
// Depth control is lead-length only (already how spread-builder.js works —
// autoCalculateLead() computes line-out by lure type + speed, no hardware
// needed). This constant exists so it's a one-line change if Ryan ever
// adds a second rod holder or fishes from a boat with more capacity.
const MAX_RODS = 2;

function applyToSpread(rec) {
  if (!rec.ok || !rec.lures.length) return;
  const lures = rec.lures.filter((l) => l); // keep all, including live-bait entries

  // Smart Plan REPLACES the spread with exactly MAX_RODS (2, kayak) rows
  // built from the recommendation. We do NOT try to detect "did the user
  // manually edit this row" vs "is this still the untouched boot-time
  // default" — that distinction is impossible to make reliably, and the
  // previous "skip rows that already have a lure" guard meant Smart Plan
  // silently did nothing whenever the 6-rod DEFAULT_SPREAD (spread-defaults.js)
  // was still loaded, which is the normal state on a fresh app load.
  // Clicking "Generate Smart Plan" is an explicit action — the user wants
  // the recommendation applied, not a partial result gated on stale defaults.
  const sides = ['Port', 'Starboard'];
  const newSpread = [];
  for (let i = 0; i < MAX_RODS; i++) {
    const lure = lures[i % lures.length];
    const row = newRodRow({
      side: sides[i % 2],
      position: 'Mid', // kayak: one practical rod position, not Bow/Mid/Stern zones
      reel: 'Spinning / 30lb 8-strand braid + 20lb fluoro leader',
      depth: String(Math.round((rec.depthMin + rec.depthMax) / 2)),
    });
    if (lure && LURE_COLOR_DEFAULTS[lure] !== undefined) {
      if (LURE_COLOR_DEFAULTS[lure]) {
        // Maps to a real spread-builder lure/color preset
        row.lure = lure;
        row.color = LURE_COLOR_DEFAULTS[lure];
      } else {
        // Live-bait technique with no plastic-lure color — note it instead
        row.notes = lure;
      }
    } else if (lure) {
      // Lure string didn't match our color map at all — still show it as
      // a note so the recommendation isn't silently dropped.
      row.notes = lure;
    }
    if (rec.notes) row.notes = (row.notes ? row.notes + ' · ' : '') + rec.notes.slice(0, 60);
    newSpread.push(row);
  }
  state.SPREAD = newSpread;

  renderSpread();
}

/**
 * Write the computed depth band + speed into the Plan tab's own
 * planTargetDepth / planSpeed fields. These are NOT cosmetic — they are
 * the actual fields buildPlanPreviewHtml() reads when generating the
 * printed report's "Core Trolling Strategy" table and the "Therefore
 * Protocol Recommendations" box. Previously those fields only ever held
 * whatever the user manually typed (or a hardcoded fallback like
 * "18-28" / "2.4" if left blank) — this is what makes the printed
 * report's recommended depth/speed genuinely computed instead of an
 * echo of user input or a placeholder.
 */
function applyToPlanFields(rec) {
  if (!rec.ok) return;
  const depthEl = document.getElementById('planTargetDepth');
  const speedEl = document.getElementById('planSpeed');
  if (depthEl) depthEl.value = `${rec.depthMin}-${rec.depthMax}`;
  if (speedEl) speedEl.value = String(rec.speed);
}

/**
 * Apply a recommendation to Route Builder's depth-band inputs, if that
 * panel is currently open / present in the DOM.
 */
function applyToRouteBuilder(rec) {
  if (!rec.ok) return;
  const minEl = document.getElementById('rbDepthMin');
  const maxEl = document.getElementById('rbDepthMax');
  const speedNote = document.getElementById('rbContourInfoText');
  if (minEl) minEl.value = rec.depthMin;
  if (maxEl) maxEl.value = rec.depthMax;
  // Route Builder doesn't have a speed field (that's a trolling-spread
  // concept, not a route-geometry concept) but we can surface it in the
  // status text so the connection between plan and route is visible.
  if (speedNote && rec.ok) {
    const existing = speedNote.textContent || '';
    if (!existing.includes('Smart depth')) {
      speedNote.insertAdjacentHTML('beforeend',
        `<br><span style="color:var(--accent2)">⚡ Smart depth band applied: ${rec.depthMin}-${rec.depthMax}ft (${rec.species}, ${rec.timeOfDay})</span>`);
    }
  }
}

/**
 * Main entry point — reads the Plan tab, generates recommendations for
 * every checked species, writes results into the plan's intel textarea,
 * and applies the FIRST legal recommendation to the spread + route builder.
 */
export function runSmartPlan() {
  const { lakeName, dateStr, launchTimeStr, waterTempF, species } = readPlanInputs();
  const outEl = document.getElementById('planSmartPlanOutput');
  const statusEl = document.getElementById('smartPlanStatus');

  if (!lakeName) {
    if (statusEl) { statusEl.textContent = 'Select a lake first'; statusEl.style.color = 'var(--bad)'; }
    return;
  }
  if (!species.length) {
    if (statusEl) { statusEl.textContent = 'Check at least one target species'; statusEl.style.color = 'var(--bad)'; }
    return;
  }

  const recs = species.map((sp) => getSmartRecommendation({ lakeName, species: sp, dateStr, launchTimeStr, waterTempF }));
  const rationale = recs.map(buildRationaleText).join('\n\n');

  if (outEl) outEl.value = rationale;

  const firstLegal = recs.find((r) => r.ok);
  if (firstLegal) {
    applyToPlanFields(firstLegal);
    applyToSpread(firstLegal);
    applyToRouteBuilder(firstLegal);
    if (statusEl) {
      statusEl.textContent = `✓ Applied ${firstLegal.species} plan: ${firstLegal.depthMin}-${firstLegal.depthMax}ft`;
      statusEl.style.color = 'var(--accent2)';
    }
  } else {
    if (statusEl) {
      statusEl.textContent = '⚠ No legal/available recommendation for checked species — see notes below';
      statusEl.style.color = 'var(--warn)';
    }
  }

  return recs;
}

// Wire the button (added to the Plan tab UI alongside the species checks)
setTimeout(() => {
  document.getElementById('runSmartPlanBtn')?.addEventListener('click', runSmartPlan);
}, 800);

window.runSmartPlan = runSmartPlan;

console.log('[smart-plan] module ready');
