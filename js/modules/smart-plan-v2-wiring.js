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
import { depthBandFor, usableAhFrom, researchIntel, structureWeights } from './plan-inputs.js';
import { DEFAULT_WEIGHTS, DEFAULT_RELIEF_WEIGHTS } from './plan-candidates.js';
import { TACKLE_INVENTORY } from '../data/tackle-inventory.js';
import { solunarFor } from '../utils/solunar.js';
import { checkPlanLegality, fetchForecast, fetchWaterState } from './plan-preflight.js';
import { buildSmartPlanV2, packFetcher, modelAsker, waterRouter } from './smart-plan-v2.js';
import { planToTimeline, installTimeline } from './plan-to-timeline.js';
import { renderSmartPlanUI, syncSpread } from './smart-plan-ui.js';
import { materialisePlan } from './plan-tracks.js';
import { loadSessionFromPlan, launchFrom } from './notifications.js';
import { planIssuesHtml } from './plan-issues.js';
import { renderAll } from '../core/map-init.js';

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
function conditionsFrom(inp, ramp, sol, forecast) {
  const c = { clarity: inp.clarity };
  if (inp.waterTempF) c.waterTempF = inp.waterTempF;
  if (inp.weather) c.forecast = inp.weather;
  if (inp.poolLevel) c.poolLevel = inp.poolLevel;
  // THE HOURS, NOT THE DAILY MAXIMUM. The prompt asks the model to rule on wind for a 12.5 ft
  // kayak; a daily max makes a calm dawn and a blown-out noon the same number.
  if (forecast && forecast.windByHour && forecast.windByHour.length) {
    c.windByHour = forecast.windByHour;
  }
  if (forecast && forecast.sunrise) c.sunrise = forecast.sunrise;
  if (sol) {
    const hh = (h) => `${String(Math.floor(((h % 24) + 24) % 24)).padStart(2, '0')}:`
                    + `${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
    c.solunar = { majors: [hh(sol.major1), hh(sol.major2)], minors: [hh(sol.minor1), hh(sol.minor2)] };
  }
  return c;
}

/** Build a plan and put it on the screen. Returns the result so a test or the console can read it. */
export async function runSmartPlanV2() {
  // v1's status line and v1's container. There is no second set any more.
  const status = $('smartPlanStatus');
  const out = $('smartPlanUIContainer');
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

  // THE LAW FIRST, BEFORE A MODEL CALL IS SPENT ON IT. Ryan: "reg check is needed so we don't
  // plan on closed waters." A block returns here — there is no point costing a Gemini call, a
  // battery budget and a morning on a species that cannot be kept today.
  const legality = checkPlanLegality(inp.lakeName, species, date);
  if (!legality.legal) {
    say(`${species} not legal here today`, true);
    if (out) out.innerHTML = `<p style="color:var(--warn);font-size:12px">REGULATION BLOCK — `
      + `${String(legality.reason || 'closed season or closed water').replace(/[&<>]/g, '')}</p>`;
    return { plan: null, problems: [`regulation block: ${legality.reason}`] };
  }

  // Wind is what the safety rule in the prompt is judged on — over 15 sustained or 20 gusting is
  // a no-go for a 12.5 ft kayak — and before this the model was being asked to rule on wind it
  // had never been shown. Failure is silent and empty on purpose: no forecast is a worse plan,
  // not a cancelled one.
  say('Checking the forecast…');
  const forecast = await fetchForecast(inp.lakeName, inp.dateStr,
    { launchTime: inp.launchTime, returnTime: inp.returnTime });
  if (forecast) {
    // The line goes in the form field; the HOURS go to the model. A daily maximum cannot answer
    // "is 06:00 fishable" -- see fetchForecast().
    inp.weather = forecast.summary;
    const wEl = $('planWeather');
    if (wEl) wEl.value = forecast.summary;
  }

  // WHAT THE WATER IS DOING TODAY — tide on the coast, flow and generation on a river.
  //
  // Ryan: "yes v2 gets them... it should never have not had them... are there any river specifics
  // that are missing as well... if so fix that too". Until now v2 planned every trip on clarity,
  // temperature, pool level and wind, and the conditions strip above the map was showing the flow
  // and the tide the whole time off the SAME Worker route. The planner was asking a smaller
  // question of the same endpoint.
  //
  // Fire-and-degrade like the forecast: a null water state is a poorer prompt, never a cancelled
  // plan, and the coastal block says out loud when the tide could not be read.
  const waterState = await fetchWaterState(inp.lakeName, inp.dateStr, {
    worker: CF_WORKER_URL, launchTime: inp.launchTime, species,
    // THE LAUNCH CHOOSES THE GAUGE. The Worker picks the nearest bound gauge to the point it is
    // given, and the centroid of the Congaree sits 46 km from Bates Bridge — see conditionsUrl().
    point: ramp ? { lat: ramp[1], lon: ramp[0] } : undefined,
  });

  // THE RESEARCH PROFILE IS THE POINT OF THE RESEARCH PIPELINE. The first version of this file
  // ignored it entirely and used the four-lake built-in table — worse than v1, which at least put
  // the research prose in its prompt. Try the in-memory cache the research tab fills, then ask
  // the Worker, because the planner should not depend on someone having opened that tab first.
  const researched = await loadResearchedProfile(inp.lakeName);

  const depth = depthBandFor(species, inp.lakeName, season, inp.waterTempF, researched);
  if (!depth) return say(`No depth profile for ${species} in ${season}`, true), null;

  // What THIS species wants on THIS lake in THIS season, per the research. Falls back to the
  // measured citation table when there is no profile — see DEFAULT_WEIGHTS.
  const ti = researched && (researched.trollingIntelligence || researched.trolling);
  const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z]/g, '');
  const spKey = ti && Object.keys(ti).find((k) => norm(k).includes(norm(species)) || norm(species).includes(norm(k)));
  const researchedStructures = (spKey && ti[spKey]?.[season]?.structures) || null;
  const w = structureWeights(DEFAULT_WEIGHTS, DEFAULT_RELIEF_WEIGHTS, researchedStructures);
  if (w.unmatched.length) {
    console.warn('[plan-v2] no structure type for:', w.unmatched.join(', '));
  }

  const sol = solunarFor(inp.dateStr, ramp[1], ramp[0]);
  const castableOrTrollable = TACKLE_INVENTORY.filter((l) => l.trollable || l.castable);

  say('Reading the pack…');
  let r;
  try {
    r = await buildSmartPlanV2({
      r2Key, ramp, rampName: inp.rampName, water: inp.lakeName, date: inp.dateStr,
      launchTime: inp.launchTime, returnTime: inp.returnTime,
      windowMin: minutesBetween(inp.launchTime, inp.returnTime),
      species, fishDepthFt: depth.band, holding: depth.holding, month: date.getMonth() + 1,
      weights: w.weights, reliefWeights: w.reliefWeights,
      // SCDNR / NCWRC / GA DNR WRD / TWRA, live from the Worker. Awaited rather than read off
      // gis-toggles' cache, because that cache is only filled when the map button is clicked and
      // a plan must not depend on which layers were toggled first. Failure is [] and a log, never
      // a dead plan — see getFishAttractors().
      dnrAttractors: await (window.getFishAttractors?.() ?? Promise.resolve([]))
        .catch((e) => { console.warn('[plan-v2] DNR attractor feed unavailable:', e?.message); return []; }),
      usableAh: usableAhFrom(inp.motor),
      conditions: {
        ...conditionsFrom(inp, ramp, sol, forecast),
        // The model is told where the band came from, so a generic one cannot be mistaken for a
        // lake-specific one by the thing writing the reasoning.
        //
        // AND WHICH QUANTITY THE BAND IS. `ft` is where the FISH are, not the depth of the water,
        // and the model has to be told which or it will do what the app did for months and reason
        // about them as one number. `holding` is what separates them, `waterDepthFt` is the water
        // the research actually saw those fish over where it said so, and `sourceQuote` is the
        // sentence all of it came from.
        depthBand: {
          ft: depth.band, basis: depth.basis, lakeSpecific: !depth.generic,
          meaning: 'where the fish are, not the depth of the water',
          holding: depth.holding || 'unknown',
          waterDepthFt: depth.waterDepthFt || null,
          sourceQuote: depth.sourceQuote || null,
          // THE AMBIGUITY GOES ON THE PAGE, NOT INTO A THRESHOLD. Ryan, 2026-08-10, on what to do
          // when the research says fish are doing both: "is there a way to have that pointed
          // out... maybe a comment in the plan that says fish could be either hugging the bottom
          // or suspended this time of year... and then yeah use the suspended number."
          //
          // So the filter is permissive (see eligibleForHolding) AND the day says so in words.
          // The permissive filter alone would be a silent decision, which is the failure mode
          // this whole rewrite exists to undo.
          note: depth.holding === 'both'
            ? `The research says ${species} are BOTH hugging the bottom and suspended on this `
              + `water in ${season}. Water was picked on the suspended rule, so some of these `
              + `passes are deeper than the fish. Say this in the plan and tell me to watch the `
              + `sounder for which it is on the day.`
            : depth.holding === 'suspended'
            ? `${species} are suspended here in ${season}, so the water only has to be deeper `
              + `than the fish — depth of water is not the target, the ${depth.band[0]}–`
              + `${depth.band[1]} ft the fish are holding at is.`
            : depth.holding === 'bottom'
            ? `${species} are on the bottom here in ${season}, so the depth of water IS the `
              + `target — these passes run through ${depth.band[0]}–${depth.band[1]} ft of water.`
            : `The research does not say whether ${species} are on the bottom or suspended here `
              + `in ${season}. Water was picked by matching its depth to the band, which is only `
              + `right if they are on the bottom. Treat the depths as less certain than usual.`,
        },
      },
      waterState,
      catches: state.CATCHES || [],
      // What the research pipeline actually found about this water — thermocline, oxygen,
      // forage, habitat, the lot. v2 was sending none of it.
      intel: researchIntel(researched, species, season),
      tackle: castableOrTrollable.map((l) => l.name),
      inventory: castableOrTrollable,
      fetchJson: packFetcher(CF_WORKER_URL),
      // Transits go over the water graph instead of straight through whatever is in the way.
      // Worker/water.js has answered POST /water/<slug>/route since it was written and nothing
      // in the browser had ever called it, so every transit in every plan Ryan has seen was a
      // straight line between two leg ends. When the endpoint cannot answer, the leg says
      // `unrouted: true`, the plan warns, and validatePlan() lists it -- it is never faked.
      routeWater: waterRouter(CF_WORKER_URL, r2Key),
      askModel: async (req) => { say('Asking the model…'); return modelAsker(CF_WORKER_URL)(req); },
    });
  } catch (e) {
    say(`Failed: ${e.message}`, true);
    if (out) out.innerHTML = `<p class="pv-empty">${e.message}</p>`;
    return null;
  }

  if (!r.plan) {
    say(r.problems[0] || 'No plan', true);
    if (out) out.innerHTML = `<ul style="color:var(--warn);font-size:12px">${
      r.problems.map((p) => `<li>${String(p).replace(/[&<>]/g, '')}</li>`).join('')}</ul>`;
    return r;
  }

  // ONE PATH TO THE SCREEN, AND IT IS THE ONE THAT WAS ALREADY THERE.
  //
  // v2 used to draw its own markup into its own container behind its own button, which is why
  // Preview, Print, ⬇JSON and ⬇HTML all came up empty for it: every one of those reads
  // collectPlan(), and collectPlan() reads window._smartPlanTimeline. Nothing downstream ever
  // looked at v2's DOM. So the plan is converted to timeline entries, installed on the globals
  // the tab already reads, and drawn by the renderer that draws everything else.
  const built = planToTimeline(r.plan, {
    depthBand: depth.band,
    rationale: (r.plan.notes && (r.plan.notes.scoutNotes || r.plan.notes.sonar)) || '',
  });
  // Regulation advisories ride WITH the plan, not into a console nobody opens. A slot limit or
  // a gear restriction is something you want on the water. checkPlanLegality returns these
  // separately from `legal` on purpose: a warning is not a block.
  if (legality.warnings && legality.warnings.length) {
    r.problems = [...legality.warnings, ...(r.problems || [])];
  }

  installTimeline(window, built);

  renderSmartPlanUI({
    routeRods: built.routeRods, routeSpeeds: built.routeSpeeds,
    speedMph: built.cards[0] ? built.cards[0].speedMph : 2.0,
    stopCandidates: built.stopCandidates,
    scoutReport: built.rationale,
    solunar: sol ? `Majors ${conditionsFrom(inp, ramp, sol, null).solunar.majors.join(', ')}` : '',
    // The two that make this v2's plan rather than a four-phase day: one card per leg, and a
    // timeline the assembler already ordered.
    cardDefs: built.cards, unified: built.timeline,
  });
  syncSpread(built.cards, built.routeRods, built.routeSpeeds);

  // THE PLAN HAS TO LEAVE THE APP OR IT IS NOT A PLAN.
  //
  // Ryan's last generated plan: `"gpx": { "tracks": 0, "trackPoints": 0 }` on a day describing
  // ten miles of trolling. The geometry was on `plan.legs[].coordinates` the whole time and
  // nothing copied it into `state.DATA.tracks`, which is the only thing collectPlan() — and so
  // the GPX writer, the map, the wind-exposure panel and the Tracks table — reads.
  //
  // This runs AFTER renderSmartPlanUI on purpose. That function makes its own `CAST:` waypoints
  // from the timeline; materialisePlan replaces them with one waypoint per stop at the stop's
  // own `at`, so the export carries the plan's positions rather than a second set derived from
  // them. Last writer wins, and the plan should be the last writer.
  // SAME OUTPUT AS THE WATER TAB, because there is no reason for a plan to carry less just for
  // having been chosen by the model. Pick Water gained charted-structure waypoints and Echomap
  // alerts on 2026-08-11 and this path did not, which would have meant two plans behaving
  // differently on the same boat on the same lake -- the sort of divergence you only discover in
  // the garage with the Echomap in your hand.
  const gpx = materialisePlan(r.plan, { launch: ramp, win: window, marks: true });
  // planCues() and weatherCues() go to the thing that can actually reach him. The phone is not the
  // interface; the Echomap is.
  // THE NWS HAZARDS RIDE THE SAME /conditions RESPONSE `waterState` ALREADY CAME FROM, so this
  // costs no request. Ryan, 2026-08-25: "the weather alerts absolutely need to be included in
  // the notifications.js that sends alerts from my phone to the garmin echomap."
  loadSessionFromPlan(r.plan, {
    weatherByHour: forecast ? forecast.weatherByHour : null,
    hazards: (waterState && waterState.hazards) || null,
    // The live poll needs somewhere to ask and somewhere to ask ABOUT until the boat reports a
    // position of its own. Ryan's case is weather that was not forecast, which no snapshot taken
    // at load can ever contain.
    worker: CF_WORKER_URL,
    // `ramp` is [lon, lat] here -- see rampCoords(). launchFrom() takes either shape.
    launch: launchFrom(ramp),
  });
  try { renderAll(); } catch (e) { console.warn('[plan-v2] map redraw failed:', e.message); }

  // A safety call made on a daily maximum is a safety call made on the wrong number, and the
  // plan should say which one it made. Never silently: the model was asked to rule on wind
  // either way.
  if (!(forecast && forecast.windByHour && forecast.windByHour.length)) {
    r.problems = [...(r.problems || []),
      'no hourly wind for this water — the safety call was made on a daily maximum, '
      + 'which cannot tell a calm dawn from a blown-out noon'];
  }

  // The warnings go in ABOVE the timeline, after the renderer has written the container --
  // renderSmartPlanUI sets innerHTML, so anything put there first is wiped.
  const issues = planIssuesHtml(r.plan, r.problems);
  if (issues && out) out.insertAdjacentHTML('afterbegin', issues);

  if (r.plan.safety && r.plan.safety.isGo === false) {
    window._planV2NoGo = true;
    return say(`🚨 NO-GO — ${r.plan.safety.warning || 'unsafe conditions for a kayak'}`, true),
           finish(r, gpx);
  }
  window._planV2NoGo = false;

  say(`${r.plan.legs.filter((l) => l.type === 'troll').length} legs · `
    + `${(r.plan.budget.totalM / 1609.34).toFixed(1)} mi · ${r.plan.budget.plannedAh} Ah`
    + ` · ${gpx.tracks} tracks`
    + (depth.generic ? ' · generic depth band' : ''));

  return finish(r, gpx);
}

/** For the console, and for whatever reads a plan next — GPX, the map, the phone. */
function finish(r, gpx) {
  window._planV2 = r.plan;
  window._planV2Result = r;
  window._planV2Gpx = gpx;
  return r;
}

/**
 * The lake's researched profile: the cache the research tab fills, else the Worker.
 *
 * Absence is normal and silent — most lakes have not been researched. A FAILURE is not absence
 * and gets logged, because producing these is what the whole research pipeline is for and a
 * profile that exists but will not load should be visible, not shrugged off.
 *
 * EXPORTED so the Water tab uses the same loader. It was private, and plan-water-ui.js therefore
 * passed `null` where the profile goes — which made Pick Water the four-lake built-in table by
 * construction, unable to see the research pipeline at all. Ryan, 2026-08-11: "the 4 lake hard
 * code needs to go away... that is what the research pipeline is for." Two planners reading two
 * different sources for the same question is how they drift.
 */
export async function loadResearchedProfile(lakeName) {
  if (!lakeName) return null;
  try {
    const cached = window.getResearchedProfile?.(lakeName);
    if (cached) return cached;
  } catch (e) { console.warn('[plan-v2] researched cache threw', e.message); }
  try {
    const r = await fetch(`${CF_WORKER_URL}/research/get?lake=${encodeURIComponent(lakeName)}`);
    if (r.status === 404) return null;
    if (!r.ok) { console.warn(`[plan-v2] /research/get returned ${r.status} for ${lakeName}`); return null; }
    const d = await r.json();
    return d?.profile || d?.data || d || null;
  } catch (e) {
    console.warn('[plan-v2] could not load the researched profile:', e.message);
    return null;
  }
}

export function wireSmartPlanV2() {
  // THE SAME BUTTON, NOT A SECOND ONE BESIDE IT.
  //
  // Ryan, 2026-08-08: "just use the same button and the same area instead of bolting on this new
  // idea next to it." v2 had its own #runSmartPlanV2Btn and its own container, which is how a
  // rewrite ended up presented as an alternative to the thing it replaces.
  //
  // v1 binds this button from a setTimeout in smart-plan.js, so the flag is set here and checked
  // there rather than trying to removeEventListener a handler nobody kept a reference to.
  window.__smartPlanV2Owns = true;
  const btn = $('runSmartPlanBtn');
  if (!btn || btn.dataset.v2wired) return;
  btn.dataset.v2wired = '1';
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
