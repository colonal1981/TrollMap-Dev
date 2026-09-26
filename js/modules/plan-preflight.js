/**
 * plan-preflight.js — the two things that must happen before a plan is worth building.
 *
 * WHY THESE TWO AND NOT THE OTHER TWO
 * -----------------------------------
 * v2 took over the Generate button, which left four things v1's `runSmartPlan()` did around the
 * plan without a home. Ryan ruled on each, 2026-08-08:
 *
 *   regulations  KEEP — "reg check is needed so we don't plan on closed waters"
 *   weather      KEEP — "weather is huge for the plan need to fetch"
 *   scout waypoints  KILL — "i think was replaced by the way the new engine handles things"
 *   coach        KILL — "it wasn't as useful as i thought it would be"
 *
 * So this module is the two survivors, lifted out of a 1,510-line file that is on the deletion
 * tab. `detectCoastalZone` came with them because it is what decides which regulation table
 * applies, and leaving it in v1 would have meant v2 importing from the module it replaces —
 * which would make deleting v1 a refactor instead of a delete.
 *
 * A THIRD JOINED THEM ON 2026-08-20, and the header above was wrong to say two. Ryan: "yes v2
 * gets them... it should never have not had them... are there any river specifics that are
 * missing as well... if so fix that too". `fetchWaterState()` is what the water is DOING today —
 * tide on the coast, flow and generation on a river. It belongs beside these because it has the
 * same shape as the other two: fetched once, before a model call is spent, and a failure is a
 * poorer plan rather than a cancelled one.
 *
 * A REGULATION BLOCK IS NOT A WARNING. It returns `legal: false` and the caller stops. The point
 * of asking is to not spend a model call, a battery budget and a morning planning a species that
 * cannot be kept, or water that is closed on the day. It is the one check in the whole path that
 * is about the law rather than the fish.
 */

import { getSeason, checkRegulations } from '../data/species-intel.js';
import { checkCoastalRegulations } from '../data/coastal-regulations.js';
import { COASTAL_ZONES, isCoastalKey } from '../data/coastal-zones.js';
import { resolveR2Key } from '../data/lake-keys.js';
import { lakeDbEntryFor, lakeRecordFor } from '../data/lake-registry.js';
import { launchStateOn, primeWaterStateParts } from '../data/water-state-parts.js';
import { primeRegulations, regulationsPrimed } from '../data/regulations-live.js';
import { fetchWaterConditions, flowClaritySentence } from '../utils/water-conditions.js';
import { getTideStateForZone } from './tide-engine.js';
import { assessZoneIntrusion } from './usgs-gauges.js';
import { DEPTH_BANDS, normalizeCoastalSpecies, tacticalNote } from './coastal-scoring.js';
import { clarityForPlan, versusNormalAt } from '../utils/clarity-at-ramp.js';
import { compassOf } from '../utils/compass.js';

/** The coastal zone this water is, or null for everything inland. */
export function detectCoastalZone(lakeName) {
  const key = lakeName ? resolveR2Key(lakeName) : null;
  return isCoastalKey(key) ? key : null;
}

/**
 * The state this water's regulations live under, coastal zone first.
 *
 * One derivation, because checkPlanLegality() and ensureRegulations() must agree about it or the
 * cache is warmed under one key and read under another.
 *
 * @param {string} lakeName
 * @param {[number, number]} [at]  the launch, [lon, lat]. Only read on a water in two states.
 */
export function regulationStateFor(lakeName, at = null) {
  return regulationStatePlace(lakeName, at).state;
}

/**
 * WHICH STATE'S BOOK, AND HOW THAT WAS DECIDED.
 *
 * A water in two states is under two books, and the one that governs a morning is the one for
 * the bank he launches from. 28 of the 352 waters we offer cross a line (label_water_states.py),
 * and this used the registry row's one state for all of them -- which 3DHP assigns from the
 * centroid, so a put-in in Cherokee County, SC on the Broad was checked against North Carolina's
 * statewide limits. Now, on a water with more than one state, the launch is placed on the Census
 * line (water-state-parts.js) and its state's book is the one read.
 *
 * WHEN THE LAUNCH CANNOT BE PLACED -- no position, the state lines not loaded, or a launch more
 * than the binding distance from the water -- the row's state is used, as before, and `basis:
 * 'row'` says so, so the caller can tell him which book was read and that it may be the wrong one.
 *
 * @returns {{state: string|null, states: string[], basis: 'coastal'|'single'|'launch'|'row', why: string}}
 */
export function regulationStatePlace(lakeName, at = null) {
  const zoneKey = detectCoastalZone(lakeName);
  const zst = zoneKey ? (COASTAL_ZONES[zoneKey] || {}).state : null;
  if (zst) return { state: zst, states: [zst], basis: 'coastal', why: '' };
  const e = lakeDbEntryFor(lakeName) || {};
  const rowState = e.state || null;
  const states = Array.isArray(e.states) && e.states.length ? e.states : (rowState ? [rowState] : []);
  if (states.length < 2) return { state: rowState || states[0] || null, states, basis: 'single', why: '' };
  const hit = launchStateOn(e.slug, at);
  if (hit.state) return { state: hit.state, states, basis: 'launch', why: hit.why };
  return { state: rowState || states[0], states, basis: 'row', why: hit.why };
}

/**
 * Warm the regulation digest for this water, and say whether it is warm.
 *
 * THE CHECK WAS READING A CACHE NOTHING ON ITS PATH HAD FILLED.
 *
 * `checkRegulations()` is synchronous by design -- it is called from deep inside the plan build,
 * where nothing can await -- so it answers out of `regulations-live.js`'s cache and treats a cold
 * cache as "unknown", which warns. That is the correct shape. What was missing is anybody filling
 * it: `primeRegulations()` had exactly ONE caller in the app, a fire-and-forget line in
 * conditions-strip.js that runs when the conditions strip refreshes, on a different trigger
 * entirely. And smart-plan-v2-wiring.js calls checkPlanLegality() at line 117 while its only
 * async water work happens at line 150 -- thirty-three lines LATER.
 *
 * So on the plan path the cache was reliably cold, `livePolicyFor()` was never consulted, and
 * every inland lake reported "No regulation data for <lake> — verify with the state before you
 * keep one" no matter how much of the book had been parsed. Ryan saw it on Lake Wateree twice.
 *
 * `regulationsPrimed()` already existed for exactly this and had NO CALLERS. It does now.
 *
 * AND ON A WATER IN TWO STATES, THE LINE FIRST. regulationStateFor() places the launch with a
 * synchronous read of water-state-parts.js, so the file has to be in hand before the state is
 * asked for -- the same cold-cache shape as the book itself. Fetched only for a water that
 * crosses a line; every other water never asks for it.
 *
 * @param {object} [opts]
 * @param {string} [opts.worker]
 * @param {[number, number]} [opts.at]  the launch, [lon, lat] -- pass the same one to
 *                                      checkPlanLegality() or the two disagree about the state
 * @returns {Promise<boolean>} true when the digest is in hand
 */
export async function ensureRegulations(lakeName, opts = {}) {
  if (regulationStatePlace(lakeName).states.length > 1) {
    await primeWaterStateParts({ worker: opts.worker });
  }
  const st = regulationStateFor(lakeName, opts.at);
  if (!st) return false;
  if (regulationsPrimed(st, lakeName)) return true;
  try {
    await primeRegulations(st, lakeName, { worker: opts.worker });
  } catch (e) {
    // A FAILED PRIME IS NOT A PASS. It leaves the cache cold, the check falls to "unknown", and
    // that warns. Nothing here can turn a network problem into permission.
    console.warn('[preflight] could not prime regulations for', lakeName, e && e.message);
  }
  return regulationsPrimed(st, lakeName);
}

// profileClosures() STOOD HERE. It read `regulations.lakeSpecificRegulations.closedSeasons` off the
// researched profile and warned with each sentence. Only the Research tab's coastal assembler ever
// wrote that field -- one stored profile of 133 carries any, Santee River Delta, a shellfish-season
// sentence -- and the tab was deleted on 2026-09-25 (Ryan: "nothing the tab writes should be used
// anymore"). The state book and the hand table below are what block, and they are unchanged.

/**
 * May this species be fished on this water on this date?
 *
 * CALL `await ensureRegulations(lakeName, { worker })` FIRST. This function cannot await, so a
 * cold cache reads as "we know nothing about this water" -- which is honest, and useless when the
 * book is sitting one fetch away.
 *
 * It reads no research profile. The profile's extracted closed seasons were a third source here
 * until 2026-09-25 -- see the note above -- and the book and the hand table are the two left.
 *
 * @param {object} [o]
 * @param {[number, number]} [o.at] the launch, [lon, lat] -- the same one ensureRegulations() had
 * @returns {{legal: boolean, reason: string, warnings: string[], coastal: boolean}}
 */
export function checkPlanLegality(lakeName, species, date, o = {}) {
  const zoneKey = detectCoastalZone(lakeName);
  const st = zoneKey ? (COASTAL_ZONES[zoneKey] || {}).state : null;
  // THE STATE IS WHAT UNLOCKS THE DIGEST. Inland it comes off the registry row, which this file
  // already reads for other reasons; on the coast the zone carries it. Without a state,
  // checkRegulations falls to its unknown branch — which now warns instead of saying nothing.
  // On a water in two states it is the launch's -- see regulationStatePlace().
  const place = st ? null : regulationStatePlace(lakeName, o.at);
  const inlandState = st || (place && place.state);
  const lineNotes = [];
  const lineWarnings = [];
  if (place && place.states.length > 1) {
    const both = place.states.join(' and ');
    if (place.basis === 'launch') {
      lineNotes.push(`This water is in ${both}. The launch is in ${place.state}, so ${place.state}'s `
                   + 'book is the one checked.');
    } else {
      lineWarnings.push(`This water is in ${both} and the launch could not be placed on either side `
                      + `of the line (${place.why}), so ${place.state}'s book was checked. If you `
                      + `put in on the other side, check that state's limits before you keep one.`);
    }
  }
  let r;
  try {
    r = st ? checkCoastalRegulations(st, species, date)
           : checkRegulations(lakeName, species, date, inlandState);
  } catch (e) {
    // A THROWN LOOKUP IS NOT PERMISSION. But it is also not a refusal — blocking every plan
    // because a table has a bad row would be worse than the thing it guards against. Say so
    // loudly, let it through, and let the warning carry into the plan.
    console.warn('[preflight] regulation check threw:', e && e.message);
    return { legal: true, reason: '', coastal: !!zoneKey,
             warnings: [`Could not check ${species} regulations here — verify before you keep one.`] };
  }
  return {
    legal: r ? r.legal !== false : true,
    reason: (r && r.reason) || '',
    warnings: [...((r && r.warnings) || []), ...lineWarnings],
    // Read, and not in the way. Carried separately so the caller can show it without it counting
    // as one of the things the plan wants to tell him.
    notes: [...lineNotes, ...((r && r.notes) || [])],
    // Which state's book was read and why -- null on the coast, where the zone decides.
    regulationState: place,
    // The published limits, when the digest answered. A caller that shows nothing else should
    // still be able to show these.
    limits: (r && r.limits) || null,
    coastal: !!zoneKey,
  };
}

// THE COMPASS IS IN ONE PLACE NOW -- see js/utils/compass.js for the four copies this was.

/**
 * The day's forecast for this water: the line the plan form shows, AND the hourly wind the
 * safety call actually needs.
 *
 * WHY THE HOURLY ARRAY EXISTS
 *
 * This used to request `daily=windspeed_10m_max,winddirection_10m_dominant` and flatten it to one
 * sentence. The prompt then asks the model to rule on wind safety for a 12.5 ft kayak — sustained
 * over 15 mph or gusts over 20 is a no-go — against a DAILY MAXIMUM. A calm 06:00 and a 15 mph
 * noon are the same number, so the model either cancels a fishable dawn or blesses a day that
 * turns on him at eleven. PLAN_SCHEMA_V2 asks for `conditions.windByHour` and the app was
 * computing something else and calling it conditions.
 *
 * The array is clipped to the trip window when one is given, because wind at 22:00 is not a fact
 * about this trip and padding the prompt with it makes the real hours harder to see.
 *
 * @param {string} lakeName
 * @param {string} dateStr    YYYY-MM-DD
 * @param {object} [o]
 * @param {string} [o.launchTime] 'HH:MM' — clips the start of windByHour
 * @param {string} [o.returnTime] 'HH:MM' — clips the end
 * @returns {Promise<null|{summary:string, windByHour:{hour:number,mph:number,deg:number}[],
 *                         sunrise:string|null, sunset:string|null}>}
 *          null when there is no centre to ask about, or the fetch fails. NOT a partly-filled
 *          object: a caller cannot tell a missing forecast from a calm one otherwise.
 */
export async function fetchForecast(lakeName, dateStr, o = {}) {
  try {
    const zoneKey = detectCoastalZone(lakeName);
    const centre = (zoneKey && (COASTAL_ZONES[zoneKey] || {}).center)
                || (lakeDbEntryFor(lakeName) || {}).center;
    if (!centre) return null;
    const [lat, lon] = centre;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
      + '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,'
      + 'windspeed_10m_max,winddirection_10m_dominant,precipitation_sum'
      // The hour-by-hour wind the safety rule is actually about.
      // THUNDER IS NOT A WIND PROBLEM. Ryan: "not just wind... thunderstorms/rain would be a big
      // one too". Lightning is the one hazard a pedal kayak cannot outrun, so the hourly WMO code
      // and the precipitation probability come back with the wind — codes 95/96/99 are
      // thunderstorm, and they are a different question from "is it fishable".
      // AND THE CLOUD, because "early morning topwater" and "they stayed up all day, it was
      // cloudy" are the same fact about light and a guide says both. Ryan, 2026-09-05: "its not
      // going to say at 6am... early morning... dawn... first light... midday... evening...
      // overcast vs daylight". Civil twilight answers the hour; only this answers the sky, and
      // it rides the request that was already being made.
      + '&hourly=windspeed_10m,winddirection_10m,windgusts_10m,weather_code,'
      + 'precipitation_probability,precipitation,cloudcover'
      + `&timezone=auto&start_date=${dateStr}&end_date=${dateStr}`;
    const res = await fetch(url, { signal: AbortSignal.timeout ? AbortSignal.timeout(4500) : undefined });
    if (!res.ok) return null;
    const d = await res.json();
    const D = d && d.daily;
    if (!D) return null;
    const dir = compassOf((D.winddirection_10m_dominant || [])[0] || 0);
    const mph = Math.round(((D.windspeed_10m_max || [])[0] || 0) * 0.621371);
    const precip = (D.precipitation_sum || [])[0] || 0;
    const hi = (D.temperature_2m_max || [])[0];
    const summary = `Wind ${dir} ${mph} mph · Precip ${precip}mm`
                  + (hi != null ? ` · High ${Math.round(hi)}°` : '');
    return {
      summary,
      windByHour: hourlyWind(d && d.hourly, o.launchTime, o.returnTime),
      weatherByHour: hourlyWeather(d && d.hourly, o.launchTime, o.returnTime),
      sunrise: clock((D.sunrise || [])[0]),
      sunset: clock((D.sunset || [])[0]),
    };
  } catch (e) {
    console.warn('[preflight] forecast fetch failed:', e && e.message);
    return null;
  }
}

/** Drop keys that nobody answered, so an absent field means "not answered" and never "zero". */
function prune(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined && v !== '') out[k] = v;
  return Object.keys(out).length ? out : null;
}

const settled = (r) => (r.status === 'fulfilled' ? r.value : null);

/** The launch instant, because a tide stage at noon is not the tide stage at 06:00. */
/**
 * THE CLARITY AT THE LAUNCH, RESOLVED WHERE THE PLAN KNOWS ITS RAMP.
 *
 * ── THE THIRD ATTEMPT AT THIS, AND THE FIRST ONE THAT CANNOT DEPEND ON RENDER ORDER ────────────
 *
 * Ryan, 2026-09-14: "this is probably correct in the creeks or the northern section of the lake but
 * i highly doubt it is applicable near clearwater cove... what is it using to calculate the
 * clarity??? i thought we made it location aware?"
 *
 * Attempt one added an AT YOUR RAMP sentence to the briefing and left the lake-wide mean going into
 * the Water Clarity select, which is what the model and the colour engine read. Attempt two made
 * that select ramp-aware and added a `planRamp` change listener. His 22:22 bench, seven minutes
 * after that shipped and with it live, still sent `"clarity": "Muddy"`:
 *
 *   the briefing is written by syncClarityIntelData(), which fires on lake change, tab switch, app
 *   load and a button -- and on a reload with the ramp ALREADY set, no change event fires at all,
 *   while the app-load run at +1000ms reads a `planRamp` the access index has not finished filling.
 *   So the select held the mean, and the plan read the select.
 *
 * A value the plan depends on cannot come out of a DOM element whose contents depend on which async
 * render finished first. The ramp is on the request; the zones come from the Worker; so the answer
 * is worked out HERE, beside fetchWaterState() and fetchForecast(), at the moment the plan is built.
 * The select goes on being set for the colour UI and is no longer what the plan stands on.
 *
 * Returns clarityForPlan()'s object plus the lake-wide figure for comparison, or null when the
 * forecast is unreachable -- and null means the caller keeps whatever the form said, because a
 * failed fetch is not evidence that the water is clear.
 */
export async function fetchClarityAtRamp(lakeName, dateStr, o = {}) {
  const worker = o.worker;
  const rampName = String(o.rampName || '').trim();
  if (!worker || !lakeName) return null;
  try {
    // THE POINT, BECAUSE THE RAINFALL IS THE ONLY THING IN THAT MODEL THAT IS ABOUT TODAY. Without
    // it the Worker reads rain at a fixed spot near Columbia for any water with no hand-authored
    // clarity profile -- a median 226 km away. `o.point` is the launch where the caller has one,
    // which is also the point /conditions chooses its gauges with; the registry centroid otherwise.
    const rec = lakeRecordFor(lakeName);
    const isLaunch = !!(o.point && Number.isFinite(Number(o.point.lat)) && Number.isFinite(Number(o.point.lon)));
    const pt = isLaunch
      ? o.point
      : (rec && Number.isFinite(Number(rec.lat)) && Number.isFinite(Number(rec.lon)) ? rec : null);
    // `at=launch` only when the point IS his launch. The Worker then reads the baseline at the
    // measured station nearest it (`atLaunch`); a centroid is not where he is fishing, and for one
    // the lake-wide average stays.
    const url = `${worker}/lake-clarity?lake=${encodeURIComponent(lakeName)}`
              + `&date=${encodeURIComponent(dateStr || '')}`
              + (pt ? `&lat=${Number(pt.lat)}&lon=${Number(pt.lon)}` : '')
              + (isLaunch ? '&at=launch' : '')
              // The registry water, so the Worker reads THIS water's watershed and never hands a
              // name that merely contains "wateree" another lake's hand-written zones.
              + (rec && rec.slug ? `&slug=${encodeURIComponent(rec.slug)}` : '');
    const res = o.fetchJson ? await o.fetchJson(url) : await (await fetch(url)).json();
    if (!res || res.error) return null;
    const got = clarityForPlan(res, rampName);
    if (!got.select) return null;
    return {
      ...got,
      // THE PAYLOAD IT ALREADY PAID FOR. The briefing on the card is rendered from this same
      // response, and re-fetching it there would be two requests for one answer -- and, worse, two
      // answers if the two requests straddled a forecast update.
      payload: res,
      // WHAT IT USUALLY IS HERE, AND HOW FAR TODAY IS OFF IT. Ryan, 2026-09-15: "i just need to
      // know what 'normal' is and how far it is off from that normal... stained water means more
      // on say lake murray than it does on wateree." See versusNormalAt().
      versusNormal: versusNormalAt(res, rampName),
      rampName: rampName || null,
      zoneName: got.zone ? got.zone.name : null,
      lakeWide: res.overall ? (res.overall.clarity || null) : null,
      lakeWideScore: res.overall && Number.isFinite(Number(res.overall.score))
        ? Number(res.overall.score) : null,
      zoneCount: Array.isArray(res.zones) ? res.zones.length : null,
      // The zone's own colours where a zone answered, so the card and the spread stop quoting a
      // palette picked for the average of six.
      lureColors: got.zone && Array.isArray(got.zone.lureColors) ? got.zone.lureColors
        : (res.overall && Array.isArray(res.overall.lureColors) ? res.overall.lureColors : []),
    };
  } catch (err) {
    console.warn('[preflight] clarity-at-ramp unavailable:', err && err.message);
    return null;
  }
}

export function launchMoment(dateStr, launchTime) {
  const day = String(dateStr || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(String(launchTime || ''));
  if (!m) return new Date(`${day}T12:00:00`);
  let h = parseInt(m[1], 10);
  const ap = (m[3] || '').toUpperCase();
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  const d = new Date(`${day}T00:00:00`);
  d.setHours(h, parseInt(m[2], 10), 0, 0);
  return d;
}

/** 06:41 out of a Date, for a prompt that should not carry ISO strings. */
const hhmm = (d) => (d instanceof Date && !isNaN(d)
  ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : null);

/**
 * WHAT THE WATER IS DOING TODAY. The third precondition — see the header.
 *
 * v2 planned every trip on clarity, temperature, pool level and wind. On a RIVER that leaves out
 * the number that decides the day: a river at a normal stage pushing 8,000 cfs is a different
 * trip from the same stage at 400, and the stage alone does not say which — that is Ryan's own
 * reasoning, already written into conditionsStrip(). On the COAST it leaves out the tide, which
 * is the only thing that moves at all.
 *
 * ALMOST NONE OF THIS IS NEW DATA. /conditions/<slug> has returned flow, flood category, dam
 * generation, projected releases, tidal current, surge and salinity since it was written, and
 * conditions-strip.js has painted them above the map the whole time. The planner was asking a
 * different, smaller question of the same Worker. This asks the one the strip asks.
 *
 * THE TIDE STAGE IS THE ONE THING /conditions CANNOT GIVE. It returns the next event, and "next
 * event is high" cannot separate a flooding tide from slack high water — opposite days on a
 * grass flat, and the key DEPTH_BANDS and tacticalNote() are indexed by. classifyStage() reads
 * the whole hi/lo series, so a coastal zone costs one NOAA call on top.
 *
 * EVERY SOURCE FAILS TO NULL, SEPARATELY. A dead NOAA station must not cost the river its flow
 * and a missing USGS gauge must not cost the coast its tide, so this is allSettled per source
 * rather than one try/catch over the lot.
 *
 * @param {string} lakeName
 * @param {string} dateStr    YYYY-MM-DD
 * @param {object} [o]
 * @param {string} [o.worker]      CF worker base; without it the /conditions half is skipped
 * @param {string} [o.launchTime]  'HH:MM' — the instant the tide stage is read at
 * @param {string} [o.species]     the target, for the tide-stage depth band and tactic
 * @param {{lat:number,lon:number}} [o.point] the launch, which CHOOSES THE GAUGE — see conditionsUrl
 * @param {function} [o.fetchConditions] injected for tests; also stands in for a missing registry
 *                                    record, since a test has no loaded registry to look one up in
 * @param {function} [o.fetchTide]       injected for tests
 * @param {function} [o.fetchIntrusion]  injected for tests
 * @returns {Promise<null|{featureType:string|null, river:object|null, tidal:object|null}>}
 *          null when nothing answered at all — which is different from a river with no gauge.
 */
export async function fetchWaterState(lakeName, dateStr, o = {}) {
  const zoneKey = detectCoastalZone(lakeName);
  const rec = lakeRecordFor(lakeName);
  const when = launchMoment(dateStr, o.launchTime);

  const getCond = o.fetchConditions
    || ((w, r) => fetchWaterConditions(w, r, { date: dateStr, point: o.point || undefined }));
  const getTide = o.fetchTide || ((k) => getTideStateForZone(k, { dateStr, when }));
  const getIntr = o.fetchIntrusion || ((k) => assessZoneIntrusion(k));

  const [condR, tideR, intrR] = await Promise.allSettled([
    (o.worker && (rec || o.fetchConditions)) ? getCond(o.worker, rec) : Promise.resolve(null),
    zoneKey ? getTide(zoneKey) : Promise.resolve(null),
    zoneKey ? getIntr(zoneKey) : Promise.resolve(null),
  ]);
  for (const [what, r] of [['conditions', condR], ['tide', tideR], ['intrusion', intrR]]) {
    if (r.status === 'rejected') console.warn(`[preflight] ${what} unavailable:`, r.reason?.message);
  }

  // A FAILED /conditions RETURNS A FULL OBJECT OF NULLS plus `error`, which reads exactly like
  // "this water has no gauge" if you only look at the fields. Drop it rather than describe a
  // river as flowless because the request timed out.
  const raw = settled(condR);
  if (raw && raw.error) console.warn(`[preflight] conditions for ${lakeName}: ${raw.error}`);
  const c = raw && !raw.error ? raw : null;
  const tide = settled(tideR);
  const intr = settled(intrR);
  // NOT `if (!c && !tide) return null`. THE INSHORE RESTRICTION IS A FACT ABOUT THE WATER, not
  // about whether a station answered. A coastal zone where NOTHING answered is MORE dangerous
  // than one where the tide came back, and returning null here would drop the strongest safety
  // rule in the prompt exactly when it matters most — a network failure quietly deleting a
  // constraint. So a zone always yields a tidal marker; the block says the stage was not read.
  if (!c && !tide && !zoneKey) return null;

  const featureType = (c && c.featureType) || (rec && rec.featureType) || (zoneKey ? 'coastal' : null);
  const isRiver = featureType === 'river';

  // A TIDAL RIVER'S RAW DISCHARGE REVERSES TWICE A DAY, so its instantaneous value is not the
  // river's flow. The filtered figure wins where it exists and SAYS it is the filtered one —
  // conditionsStrip() made the same choice for the same reason.
  const net = c && c.tidalFlowCfs != null;
  const river = c && (isRiver || c.flowCfs != null || c.generatingNow != null) ? prune({
    flowCfs: net ? c.tidalFlowCfs : c.flowCfs,
    flowIsTidallyFiltered: net ? true : null,
    flowVsNormal: c.flowBand || null,
    flowMedianCfs: c.flowMedian ?? null,
    // The river's own measured clarity at flows in today's band -- the card's sentence, verbatim.
    flowClarity: flowClaritySentence(c.flowClarity),
    flowGauge: c.flowGauge || null,
    stageFt: c.stageFt ?? null,
    stageBasis: c.stageBasis || null,
    // "no_flooding" is the normal state; naming it every day trains you to stop reading the line.
    floodCategory: c.floodCategory && !/^no[_ ]?flood/i.test(c.floodCategory)
      ? String(c.floodCategory).replace(/_/g, ' ') : null,
    ftBelowFloodAction: Number.isFinite(c.stageVsActionFt) ? -c.stageVsActionFt : null,
    // GENERATING IS THE CURRENT on a tailwater, and `false` is as useful as `true` — "not
    // generating" is why nothing is moving.
    generatingNow: typeof c.generatingNow === 'boolean' ? c.generatingNow : null,
    generationNext: c.generationNext || null,
    // Only a PROJECTION. An observed discharge is already `flowCfs` above, and printing it again
    // as though it were a schedule is the mistake `kind` exists to prevent.
    projectedRelease: c.releases && c.releases.kind === 'projected' ? c.releases.next : null,
    gaugeOutOfService: c.gaugeOutOfService || null,
  }) : null;

  const primary = normalizeCoastalSpecies(o.species);
  const stage = (tide && tide.stage) || null;
  const hasTideSignal = !!(zoneKey || tide || (c && (c.nextTide || c.currentKn != null || c.tideStation)));
  const next = tide && tide.nextEvent
    ? prune({ type: tide.nextEvent.type, at: hhmm(tide.nextEvent.at),
              heightFt: round1(tide.nextEvent.heightFt) })
    : (c && c.nextTide
        ? prune({ type: c.nextTide.type, at: String(c.nextTide.at || '').slice(11, 16) || null })
        : null);

  const tidal = hasTideSignal ? prune({
    zone: zoneKey ? (COASTAL_ZONES[zoneKey] || {}).name || null : null,
    station: (tide && tide.station) || (c && c.tideStation) || null,
    stage,
    stageLabel: (tide && tide.stageLabel) || null,
    heightFtAboveMllw: tide ? round1(tide.heightFt) : null,
    dailyRangeFt: tide ? round1(tide.rangeFt) : null,
    nextEvent: next,
    currentKn: c && Number.isFinite(c.currentKn) ? c.currentKn : null,
    currentType: (c && c.currentType) || null,
    // THE SET, AND WHERE THE PREDICTION WAS TAKEN. All four of these were computed by
    // water-conditions.js and forwarded to the conditions STRIP and nowhere else, so the prompt's
    // Current line has said "flood 1.8 kn" with no direction and no station since it was written.
    //
    // The direction is the half that decides a drift: there is no spot-lock on a pedal kayak, so
    // which way the water is running is which way the bait goes and which way the pedal work is.
    // And the distance is what says whether the prediction is about this creek at all -- the
    // nearest station to a Charleston marsh ramp can be the harbour entrance.
    currentDirDeg: c && Number.isFinite(c.currentDirDeg) ? c.currentDirDeg : null,
    currentAt: (c && c.currentAt) || null,
    currentStation: (c && c.currentStation) || null,
    currentStationKm: c && Number.isFinite(c.currentStationKm) ? c.currentStationKm : null,
    currentBoundBy: (c && c.currentBoundBy) || null,
    surgeVsPredictedFt: c && Number.isFinite(c.surgeFt) && Math.abs(c.surgeFt) >= 0.3 ? c.surgeFt : null,
    salinityPpt: c && Number.isFinite(c.salinityPpt) ? c.salinityPpt : null,
    // THE SONDE'S psu, WHICH IS THE ONLY SALT ACE BASIN AND ST. HELENA HAVE. Neither zone binds
    // a USGS site publishing 00480 or 00095, so `salinityPpt` and `conductanceUsCm` are null on
    // both and this line is the whole difference between a plan that knows the water is salt and
    // one that does not. It is a separate field because psu is not ppt and nothing converts.
    salinityPsu: c && Number.isFinite(c.salinityPsu) ? c.salinityPsu : null,
    conductanceUsCm: c && Number.isFinite(c.conductanceUsCm) ? c.conductanceUsCm : null,
    // WHICH GAUGE AND HOW FAR, the same three fields the tidal current needed and for the same
    // reason. `saltGauge` and `saltBasis` have been computed by water-conditions.js since it was
    // written and have reached nothing; the prompt said "Salinity 12 ppt at the gauge" on a zone
    // binding eight that publish it.
    saltGauge: (c && c.saltGauge) || null,
    saltGaugeKm: c && Number.isFinite(c.saltGaugeKm) ? c.saltGaugeKm : null,
    saltBasis: (c && c.saltBasis) || null,
    // The tide-stage band and tactic, which only exist for the three species coastal-scoring.js
    // was built around. A fourth species gets the rules and no band, which is honest.
    depthBandFt: (primary && stage && DEPTH_BANDS[primary]) ? DEPTH_BANDS[primary][stage] || null : null,
    tactic: (primary && stage) ? tacticalNote(primary, stage) || null : null,
    freshwaterIntrusion: intr && intr.active
      ? prune({ message: intr.message, rivers: (intr.rivers || []).join(', ') || null })
      : null,
  }) : null;

  // AN ACTIVE WARNING OVER THE WATER IS WHAT THE WATER IS DOING TODAY, which is this function's
  // whole subject. It rides the same /conditions response as the flow and the tide -- no second
  // request -- and it is the reason this early return had to change: a lake with no river block
  // and no tide is most of the registry, and returning null there threw the hazards away with
  // everything else.
  const hazards = (c && Array.isArray(c.hazards) && c.hazards.length) ? c.hazards : null;
  const allClear = c && c.hazardsAllClear === true;

  // HOW FAR THE OPERATOR MOVES THIS LAKE ACROSS A YEAR, and the same argument as the hazards
  // above: a reservoir with no river block and no tide is most of the registry, so an early
  // return would throw this away on exactly the waters that have one.
  //
  // Ryan, 2026-09-04: "why only duke". It is not Duke any more -- Worker/conditions.js reports
  // the swing off whichever of USACE, TVA or Duke runs the water, and water-conditions.js names
  // which in `seasonalDrawdownFrom`. A number with no operator behind it is the kind of fact
  // this codebase keeps getting caught on, so the source travels with it.
  const pool = (c && Number.isFinite(c.seasonalDrawdownFt))
    ? { seasonalDrawdownFt: c.seasonalDrawdownFt, from: c.seasonalDrawdownFrom || null }
    : null;

  // ── STOP HAND-LISTING WHAT THE READERS ARE ALLOWED TO SEE ──────────────────────────────────
  //
  // This returned six keys. `/conditions` parses about sixty, and the two comments above record
  // two previous rounds of the same repair -- hazards, then the operator's drawdown -- each one
  // adding a key to the list and a clause to the guard. The third time it is the LIST that is
  // wrong, not the length of it.
  //
  // What the six-key return was throwing away, measured 2026-09-05 against water-conditions.js:
  //
  //   civilDawn, civilDusk, sunrise, sunset   the almanac, from USNO. The file's own note says
  //                                           "CIVIL TWILIGHT, NOT SUNRISE. The fishing day
  //                                           starts when you can see to launch" -- and civil
  //                                           dawn has never once reached a prompt.
  //   moonPhase, moonIllumination, popPct     read, parsed, dropped here.
  //   levelFt, fullPoolFt, belowFullPoolFt,   poolPromptBlock() and levelSentence() read these
  //     levelSource, feedName, operatorMessage  OFF THE TOP LEVEL of this object. They are not
  //                                           in the six, at the top level or anywhere else, so
  //                                           "WHERE THE WATER IS TODAY" -- the block that tells
  //                                           the model every charted depth is sounded at full
  //                                           pool -- has returned '' on every water, always.
  //                                           the-chart-was-sounded-at-full-pool.test.js is
  //                                           green because it hands buildPlanRequest a
  //                                           conditions-shaped object directly. Nothing ever
  //                                           tested that this function produces that shape.
  //   waterTempF, dissolvedOxygenMgL,         the numbers the Sep 5 Wateree plan was missing.
  //     droughtLevel, flowAnomaly, flowMedian
  //
  // So: the parsed conditions ARE the water state, and the derived blocks ride on top of it.
  // Derived keys go last so a computed featureType beats the feed's null. A reader that needs a
  // field the feed already carries no longer needs this line edited to get it.
  //
  // The guard goes with it. `!river && !tidal && !hazards && !pool` is most of the registry --
  // a plain reservoir with a level and an almanac and nothing else -- and returning null there
  // threw away exactly what a lake plan needs. Nothing at all is still nothing.
  if (!c && !river && !tidal && !hazards && !pool) return null;
  return { ...(c || {}), featureType, river, tidal, hazards, hazardsAllClear: allClear, pool };
}

function round1(v) {
  return Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
}

/** '2026-08-10T06:41' → '06:41'. Open-Meteo returns local time when timezone=auto. */
function clock(iso) {
  const m = /T(\d{2}:\d{2})/.exec(String(iso || ''));
  return m ? m[1] : null;
}

/** The hour of an Open-Meteo hourly timestamp, or null. */
function hourOf(iso) {
  const m = /T(\d{2}):/.exec(String(iso || ''));
  return m ? Number(m[1]) : null;
}

const hhToHour = (s) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(s || ''));
  return m ? Number(m[1]) : null;
};

/**
 * [{hour, mph, deg}] for the trip window. Open-Meteo answers in km/h by default and the whole
 * app is mph, so the conversion happens here, once, with the same 0.621371 the daily line above
 * already uses. Gusts ride along when the API gives them: the no-go rule has a separate gust
 * threshold (20 mph) and dropping them would leave half of it unanswerable.
 */
/**
 * The hours that are a SAFETY question rather than a fishing one.
 *
 * WMO weather codes: 95 is thunderstorm, 96 and 99 are thunderstorm with hail. Those are the
 * codes that mean get off the water — lightning is the single hazard a 12.5 ft pedal kayak has no
 * answer to, and unlike wind it does not build gradually enough to read from the seat.
 *
 * Rain on its own is graded, not blocked: 61-67 and 80-82 are rain and showers, which are a
 * comfort and a visibility problem and Ryan's call, not the app's.
 */
export function hourlyWeather(hourly, from, to) {
  const times = (hourly && hourly.time) || [];
  const codes = (hourly && hourly.weather_code) || [];
  const prob = (hourly && hourly.precipitation_probability) || [];
  const mm = (hourly && hourly.precipitation) || [];
  const cloud = (hourly && hourly.cloudcover) || [];
  const p = (s) => { const m = /^(\d{1,2}):/.exec(String(s || '')); return m ? +m[1] : null; };
  const lo = p(from), hi = p(to);
  const out = [];
  for (let i = 0; i < times.length; i++) {
    const h = Number(String(times[i]).slice(11, 13));
    if (!Number.isFinite(h)) continue;
    // The whole day is kept when no window was given, but a window clips it -- a storm at 20:00
    // is not a warning for someone off the water at 15:00.
    if (lo != null && h < lo) continue;
    if (hi != null && h > hi) continue;
    const code = Number(codes[i]);
    const e = { hour: h };
    if (Number.isFinite(code)) {
      e.code = code;
      e.thunder = code >= 95;
      e.rain = (code >= 61 && code <= 67) || (code >= 80 && code <= 82);
    }
    if (Number.isFinite(Number(prob[i]))) e.chancePct = Number(prob[i]);
    if (Number.isFinite(Number(mm[i]))) e.mm = Number(mm[i]);
    // Percent sky covered. Kept as the number Open-Meteo sent -- no band, no label. Whoever
    // reads it decides what counts as overcast, and this file is not that reader.
    if (Number.isFinite(Number(cloud[i]))) e.cloudPct = Number(cloud[i]);
    out.push(e);
  }
  return out;
}

export function hourlyWind(hourly, launchTime, returnTime) {
  const times = (hourly && hourly.time) || [];
  const speed = (hourly && hourly.windspeed_10m) || [];
  const deg = (hourly && hourly.winddirection_10m) || [];
  const gust = (hourly && hourly.windgusts_10m) || [];
  const from = hhToHour(launchTime), to = hhToHour(returnTime);
  const out = [];
  for (let i = 0; i < times.length; i++) {
    const h = hourOf(times[i]);
    if (h == null) continue;
    if (from != null && h < from) continue;
    if (to != null && h > to) continue;
    const mph = Number(speed[i]);
    if (!Number.isFinite(mph)) continue;
    const e = { hour: h, mph: Math.round(mph * 0.621371), deg: Math.round(Number(deg[i]) || 0) };
    const g = Number(gust[i]);
    if (Number.isFinite(g)) e.gustMph = Math.round(g * 0.621371);
    out.push(e);
  }
  return out;
}

export { getSeason };
