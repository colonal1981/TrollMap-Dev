/**
 * inshore-season.js — WHEN the inshore fish are actually caught, and how big they run.
 *
 * WHAT THIS ANSWERS THAT NOTHING ELSE COULD
 * -----------------------------------------
 * Ryan fishes inshore only and wants saltwater this fall. For a coastal trip the plan already
 * knows the tide, the current, the salinity and the charted bottom — everything about the WATER.
 * About the FISH it knew the state's size and creel limits and nothing else, because the coastal
 * side has no research profile the way a reservoir does. So "is this a September fish here" was
 * answered by the model out of recollection, which is the failure `registry/mrip_inshore.json`
 * was built to end: eleven years of NOAA's Access Point Angler Intercept Survey, filtered to
 * AREA_X = 5 (inland waters, by the survey's own field), per state, per two-month wave, with the
 * survey's own length measurements.
 *
 * It was built on 2026-09-03 and read by exactly one file — `Worker/research/agents.js` — which
 * means it reached a research prompt and never reached a plan. `00_START_HERE` has the standing
 * test: A FACT COUNTS WHEN IT REACHES buildPlanRequest(). This is the reader that makes it count.
 *
 * IT IS A STATE FACT, NOT A CREEK FACT, and it travels as its own named input for exactly the
 * reason thermoclineNormFor() does — see plan-inputs.js, where Ryan ruled on this shape: a
 * national table is not a research finding about this water, so it prints in its own section of
 * the prompt rather than inside one headed with this water's name. The block says so in words.
 *
 * NOT SAMPLED IS NOT ZERO, AND THIS IS THE WHOLE RISK IN THE FILE. MRIP does not work waves 1
 * (Jan-Feb) in South Carolina or Georgia. The file writes those as `{sampled: false}` rather than
 * `{intercepts: 0}` precisely so a reader cannot confuse them, and a reader that does confuse
 * them tells somebody the seatrout are gone in February. Every share and every rank below is
 * computed across SAMPLED waves only, and an unsampled wave returns `sampled: false` with no
 * numbers attached to it at all.
 *
 * SILENCE OVER A WRONG SENTENCE. A species the state table does not carry returns null. The
 * file's own rule is "on the roster when the survey intercepted it inland AND the state book
 * gives it a limit or a season", so an absence is one of two different sentences and we cannot
 * tell which — and every other block on this path is silent when it cannot speak.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 */

import { nameForms } from './regulations-live.js';
import { registryLoader } from './registry-loader.js';

/** The survey's own two-month waves. Kept here so a caller never types a month range. */
export const WAVES = Object.freeze({
  1: 'Jan–Feb', 2: 'Mar–Apr', 3: 'May–Jun', 4: 'Jul–Aug', 5: 'Sep–Oct', 6: 'Nov–Dec',
});

/** The wave a date falls in. Waves are calendar pairs starting in January. */
export function waveFor(date) {
  const d = date instanceof Date ? date : new Date(date);
  const m = d.getMonth() + 1;
  if (!Number.isFinite(m)) return null;
  return Math.floor((m - 1) / 2) + 1;
}

export const REGISTRY_PATH = '/chartpacks/_registry/mrip_inshore.json';

// ONE LOADER, SHARED. The fetch, the twelve-hour hold, the in-flight guard and the two rules
// about what must never be cached all live in registry-loader.js -- see the header there for why
// a bad body is refused rather than held, and why a failure is silence. The shape guard is the
// only part that is about THIS file: no `states` object means this is not the survey table.
const _survey = registryLoader(REGISTRY_PATH, (p) => p && p.states && typeof p.states === 'object' && p.states);

/**
 * Load the survey table once and hold it. NEVER THROWS -- a bucket with no object and a network
 * that dropped look the same to the caller, and both mean the plan says nothing about seasonality
 * rather than the plan failing.
 */
export const primeInshoreSeason = (opts = {}) => _survey.prime(opts);

/** Test seam, and the same name regulations-live.js uses for its own. */
export function _resetInshoreSeason() { _survey.reset(); }

/** Whether the survey table is in hand. A cold table is silence, never an answer. */
export function inshoreSeasonPrimed() { return _survey.primed(); }

/**
 * Find this species in the state's table.
 *
 * THE JOIN IS nameForms(), NOT A STRING TEST, and it is the same one the regulation layer uses.
 * The survey writes `SPOTTED SEATROUT` and the plan form says `Speckled Trout (Spotted Seatrout)`:
 * the same fish, and NEITHER STRING CONTAINS THE OTHER. A containment match here would report the
 * survey silent on seatrout while the seatrout row is open in front of it.
 */
function rowFor(table, species) {
  if (!table || typeof table !== 'object') return null;
  const want = new Set(nameForms(species));
  if (!want.size) return null;
  for (const [key, entry] of Object.entries(table)) {
    if (nameForms(key).some((f) => want.has(f))) return { key, entry };
  }
  return null;
}

/**
 * What the intercept survey says about this species, in this state, in this date's wave.
 *
 * @returns {null|{state,species,surveyName,wave,waveLabel,sampled,waveIntercepts,totalIntercepts,
 *                 sharePct,rank,sampledWaveCount,best,lengthIn,years,source,unsampledWaves}}
 *          null when nothing can be said — not primed, no such state, no such fish.
 */
export function inshoreSeasonFor(state, species, date) {
  const table = _survey.get();
  if (!table) return null;
  const st = String(state || '').trim().toUpperCase();
  const stateRow = table.states && table.states[st];
  if (!stateRow) return null;
  const hit = rowFor(stateRow.species, species);
  if (!hit) return null;

  const wave = waveFor(date);
  const byWave = (hit.entry && hit.entry.byWave) || {};

  // SAMPLED WAVES ONLY, EVERY TIME. An unsampled wave contributes nothing to the total, nothing
  // to the share and nothing to the ranking, because the survey was not there — counting it as a
  // zero would make every sampled wave look busier than it is AND make the empty months look
  // fished out. Both halves of that mistake are wrong in the same file.
  const sampled = Object.entries(byWave)
    .filter(([, v]) => v && v.sampled === true)
    .map(([w, v]) => ({ wave: Number(w), intercepts: Number(v.intercepts) || 0 }))
    .sort((a, b) => b.intercepts - a.intercepts);

  const total = sampled.reduce((s, x) => s + x.intercepts, 0);
  const here = byWave[String(wave)];
  const isSampled = !!(here && here.sampled === true);
  const n = isSampled ? (Number(here.intercepts) || 0) : null;
  const rank = isSampled ? sampled.findIndex((x) => x.wave === wave) + 1 : null;
  const best = sampled.length ? sampled[0] : null;

  return {
    state: st,
    species,
    surveyName: hit.key,
    wave,
    waveLabel: WAVES[wave] || null,
    sampled: isSampled,
    waveIntercepts: n,
    totalIntercepts: total,
    sharePct: isSampled && total > 0 ? Math.round((n / total) * 100) : null,
    rank,
    sampledWaveCount: sampled.length,
    best: best ? { wave: best.wave, label: WAVES[best.wave] || null, intercepts: best.intercepts } : null,
    lengthIn: (hit.entry && hit.entry.lengthIn) || null,
    years: Array.isArray(table.years) ? table.years : [],
    source: table.source || 'NOAA MRIP Access Point Angler Intercept Survey',
    // NAMED, NOT COUNTED. "the survey does not work Jan–Feb here" is a sentence about the survey;
    // a count of missing waves is a sentence about nothing.
    unsampledWaves: Object.entries(byWave)
      .filter(([, v]) => !v || v.sampled !== true)
      .map(([w]) => WAVES[Number(w)] || `wave ${w}`),
  };
}
