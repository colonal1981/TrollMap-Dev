/**
 * smart-plan-v2-wiring.js — the DOM end of SmartPlan v2.
 *
 * Everything that knows about `document` lives here, and everything below it is pure. That split
 * is why `smart-plan-v2.js` can run its whole path in a test with no browser and no network: this
 * file reads the form, resolves the ramp, and hands over plain data.
 *
 * It deliberately does NOT import from `smart-plan.js`. That file is v1 and is going away — the
 * nine-line form read below is duplicated from its `readPlanInputs()` on purpose, because
 * importing from a module that is on the deletion tab would make the tab a lie and the deletion
 * a refactor. When v1 goes, nothing here changes.
 */

import { state, CF_WORKER_URL } from '../core/state.js';
import { resolveR2Key } from '../data/lake-keys.js';
import { getLoadedAccessIndex } from '../data/access-index.js';
import { getSeason } from '../data/species-intel.js';
import { depthBandFor, usableAhFrom } from './plan-inputs.js';
import { TACKLE_INVENTORY } from '../data/tackle-inventory.js';
import { solunarFor } from '../utils/solunar.js';
import { buildSmartPlanV2, packFetcher, modelAsker } from './smart-plan-v2.js';
import { renderPlan, PLAN_V2_CSS } from './plan-render.js';

export { depthBandFor, usableAhFrom };

const $ = (id) => document.getElementById(id);

/** The plan form. Duplicated from v1's readPlanInputs() — see the note at the top. */
export function readInputs() {
  return {
    lakeName: $('planLake')?.value || '',
    rampName: $('planRamp')?.value || '',
    dateStr: $('planDate')?.value || new Date().toISOString().slice(0, 10),
    launchTime: $('planLaunchTime')?.value || '06:00',
    returnTime: $('planReturnTime')?.value || '15:00',
    waterTempF: parseFloat($('planWaterTemp')?.value) || null,
    clarity: $('planClarity')?.value || 'Clear',
    weather: $('planWeather')?.value || '',
    poolLevel: $('planPoolLevel')?.value || '',
    motor: $('planMotor')?.value || '',
    species: [...document.querySelectorAll('#planSpeciesChecks input:checked')].map((c) => c.value),
  };
}

/** [lon, lat] of the chosen ramp, in the order every geometry in this app uses. */
export function rampCoords(lakeName, rampName) {
  const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const points = getLoadedAccessIndex()?.byLake?.get(lakeName) || [];
  const x = norm(rampName);
  const hit = points.find((p) => { const y = norm(p.name); return y && x && (x === y || x.includes(y) || y.includes(x)); })
           || points[0];
  if (hit && Number.isFinite(hit.lat)) return [hit.lon, hit.lat];
  const opt = document.querySelector('#planRamp option:checked');
  if (opt?.dataset?.lat) return [parseFloat(opt.dataset.lon), parseFloat(opt.dataset.lat)];
  return null;
}

function minutesBetween(a, b) {
  const p = (s) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(s || '')); return m ? +m[1] * 60 + +m[2] : null; };
  const x = p(a), y = p(b);
  return x != null && y != null && y > x ? y - x : null;
}

/** Only what the model can use: no raw objects, no half-populated research blobs. */
function conditionsFrom(inp, ramp, sol) {
  const c = { clarity: inp.clarity };
  if (inp.waterTempF) c.waterTempF = inp.waterTempF;
  if (inp.weather) c.forecast = inp.weather;
  if (inp.poolLevel) c.poolLevel = inp.poolLevel;
  if (sol) {
    const hh = (h) => `${String(Math.floor(((h % 24) + 24) % 24)).padStart(2, '0')}:`
                    + `${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
    c.solunar = { majors: [hh(sol.major1), hh(sol.major2)], minors: [hh(sol.minor1), hh(sol.minor2)] };
  }
  return c;
}

/** Build a plan and put it on the screen. Returns the result so a test or the console can read it. */
export async function runSmartPlanV2() {
  const status = $('smartPlanV2Status');
  const out = $('smartPlanV2Container');
  const say = (msg, bad) => {
    if (status) { status.textContent = msg; status.style.color = bad ? 'var(--warn)' : 'var(--muted)'; }
  };

  const inp = readInputs();
  if (!inp.lakeName) return say('Select a lake first', true), null;
  if (!inp.species.length) return say('Check at least one target species', true), null;

  const r2Key = resolveR2Key(inp.lakeName);
  const ramp = rampCoords(inp.lakeName, inp.rampName);
  if (!r2Key) return say(`No chartpack for ${inp.lakeName}`, true), null;
  if (!ramp) return say('Could not place that ramp', true), null;

  const date = new Date(`${inp.dateStr}T12:00:00`);
  const season = getSeason(date);
  const species = inp.species[0];
  const depth = depthBandFor(species, inp.lakeName, season, inp.waterTempF);
  if (!depth) return say(`No depth profile for ${species} in ${season}`, true), null;

  const sol = solunarFor(inp.dateStr, ramp[1], ramp[0]);
  const castableOrTrollable = TACKLE_INVENTORY.filter((l) => l.trollable || l.castable);

  say('Reading the pack…');
  let r;
  try {
    r = await buildSmartPlanV2({
      r2Key, ramp, rampName: inp.rampName, water: inp.lakeName, date: inp.dateStr,
      launchTime: inp.launchTime, returnTime: inp.returnTime,
      windowMin: minutesBetween(inp.launchTime, inp.returnTime),
      species, depthFt: depth.band, month: date.getMonth() + 1,
      usableAh: usableAhFrom(inp.motor),
      conditions: {
        ...conditionsFrom(inp, ramp, sol),
        // The model is told where the band came from, so a generic one cannot be mistaken for a
        // lake-specific one by the thing writing the reasoning.
        depthBand: { ft: depth.band, basis: depth.basis, lakeSpecific: !depth.generic },
      },
      catches: state.CATCHES || [],
      tackle: castableOrTrollable.map((l) => l.name),
      inventory: castableOrTrollable,
      fetchJson: packFetcher(CF_WORKER_URL),
      askModel: async (req) => { say('Asking the model…'); return modelAsker(CF_WORKER_URL)(req); },
    });
  } catch (e) {
    say(`Failed: ${e.message}`, true);
    if (out) out.innerHTML = `<p class="pv-empty">${e.message}</p>`;
    return null;
  }

  injectCss();
  if (!r.plan) {
    say(r.problems[0] || 'No plan', true);
    if (out) out.innerHTML = `<div class="plan-v2"><ul class="pv-warnings">${
      r.problems.map((p) => `<li>${p.replace(/[&<>]/g, '')}</li>`).join('')}</ul></div>`;
    return r;
  }

  const notes = depth.generic
    ? [`Depth band ${depth.band[0]}–${depth.band[1]} ft is generic: ${depth.basis}.`] : [];
  if (out) out.innerHTML = renderPlan(r.plan, { problems: r.problems, notes });
  say(`${r.plan.legs.filter((l) => l.type === 'troll').length} legs · `
    + `${(r.plan.budget.totalM / 1609.34).toFixed(1)} mi · ${r.plan.budget.plannedAh} Ah`
    + (depth.generic ? ' · generic depth band' : ''));

  // For the console, and for whatever reads a plan next — GPX, the map, the phone.
  window._planV2 = r.plan;
  window._planV2Result = r;
  return r;
}

let cssDone = false;
function injectCss() {
  if (cssDone || document.getElementById('plan-v2-css')) return;
  const el = document.createElement('style');
  el.id = 'plan-v2-css';
  el.textContent = PLAN_V2_CSS;
  document.head.appendChild(el);
  cssDone = true;
}

export function wireSmartPlanV2() {
  const btn = $('runSmartPlanV2Btn');
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try { await runSmartPlanV2(); } finally { btn.disabled = false; }
  });
}

if (typeof window !== 'undefined') {
  window.runSmartPlanV2 = runSmartPlanV2;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireSmartPlanV2);
  else wireSmartPlanV2();
}
