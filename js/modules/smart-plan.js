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
  getSeason, getTimeOfDay, checkRegulations,
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

  // 2. Look up behavior data for this lake/species.
  const lakeData = SPECIES_BEHAVIOR[lakeName];
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
function applyToSpread(rec) {
  if (!rec.ok || !rec.lures.length) return;
  const lures = rec.lures.filter((l) => l); // keep all, including live-bait entries

  // Use existing empty rows first, then add new ones up to 6 total rods
  // if the spread is currently empty or sparse.
  const targetRodCount = Math.max(state.SPREAD.length, Math.min(6, lures.length * 2));
  while (state.SPREAD.length < targetRodCount) {
    state.SPREAD.push(newRodRow());
  }

  const sides = ['Port', 'Starboard'];
  const positions = ['Bow', 'Mid', 'Stern'];
  let lureIdx = 0;

  state.SPREAD.forEach((rod, i) => {
    if (rod.lure && rod.lure.trim()) return; // don't overwrite user's manual picks
    const lure = lures[lureIdx % lures.length];
    lureIdx++;
    rod.side = rod.side || sides[i % 2];
    rod.position = rod.position || positions[Math.floor(i / 2) % 3];
    rod.depth = String(Math.round((rec.depthMin + rec.depthMax) / 2));
    if (lure && LURE_COLOR_DEFAULTS[lure] !== undefined) {
      // Only set lure/color if it maps to an actual spread-builder preset.
      // Live-bait entries (color=null) get a notes annotation instead.
      if (LURE_COLOR_DEFAULTS[lure]) {
        rod.lure = lure;
        rod.color = LURE_COLOR_DEFAULTS[lure];
      } else {
        rod.notes = (rod.notes ? rod.notes + ' · ' : '') + lure;
      }
    }
    rod.notes = rod.notes || rec.notes?.slice(0, 60) || '';
  });

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
