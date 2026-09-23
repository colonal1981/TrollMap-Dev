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
import { matchRampIndex, normRampName } from '../utils/ramp-match.js';
import { isNum } from '../utils/num.js';
import { getLoadedAccessIndex, registryRecordFor } from '../data/access-index.js';
import { getSeason, seasonNote } from '../data/species-intel.js';
import { depthBandFor, usableAhFrom, researchIntel, structureWeights, oxygenFloorFt,
         describeDepthBand, fishDepthEvidence, conditionsFrom, fetchRegistrySpecies,
         registryIdentity, thermoclineNormFor } from './plan-inputs.js';
import { DEFAULT_WEIGHTS, DEFAULT_RELIEF_WEIGHTS } from './plan-candidates.js';
import { TACKLE_INVENTORY } from '../data/tackle-inventory.js';
import { TRANSIT_MIN_DEPTH_FT } from './plan-water.js';
import { solunarFor } from '../utils/solunar.js';
import { checkPlanLegality, ensureRegulations, fetchForecast, fetchWaterState,
         fetchClarityAtRamp, regulationStateFor, detectCoastalZone } from './plan-preflight.js';
import { primeFishAdvisories } from '../data/fish-advisories.js';
import { primeInshoreSeason, inshoreSeasonFor } from '../data/inshore-season.js';
import { primeSeabedHabitat, seabedHabitatFor } from '../data/seabed-habitat.js';
import { buildSmartPlanV2, packFetcher, modelAsker, waterRouter } from './smart-plan-v2.js';
import { planToTimeline, installTimeline } from './plan-to-timeline.js';
import { renderSmartPlanUI, syncSpread } from './smart-plan-ui.js';
import { materialisePlan } from './plan-tracks.js';
import { loadSessionFromPlan, launchFrom } from './notifications.js';
import { patternFactsFrom, lightFactsFrom } from './plan-prompt.js';
import { syncClarityIntelData } from './lake-intel.js';
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

/**
 * [lon, lat] of the chosen ramp, in the order every geometry in this app uses.
 *
 * ── AND IT NO LONGER PICKS ONE WHEN NOBODY CHOSE ─────────────────────────────────────────────────
 *
 * This ended `|| points[0]`, so an empty ramp field planned the day from whatever launch the merged
 * access index happened to list first — a merge order nothing sorts by anything. On a LAKE that is a
 * wrong starting point and the legs are still the legs. ON A RIVER IT IS THE WHOLE DAY: since
 * 2026-09-17 the reaches are laid out walking outward from the ramp's own station on the centreline,
 * so the launch decides which water is even offered.
 *
 * Found on Ryan's 2026-09-17 Congaree bench, which exported `rampName: ""` and planned anyway. It
 * landed on Barney Jordan and was right by luck — the first access-index row for that river happens
 * to be the launch he uses. On the Lumber the first row is WAGRAM, at river station 16,450 of a
 * 219,600 m centreline, and every charted feature on that river sits between 211,650 and 219,600.
 * The same silence would have planned a day 195 km from the only water Garmin ever sounded.
 *
 * THE OPTION HE ACTUALLY CHOSE COMES FIRST, because that is the answer and the index is a lookup.
 * `#planRamp`'s options have carried `dataset.lat/lon` on the access-index branch since the live
 * feeds arrived, and on the curated-river branch since the same bench — see
 * populatePlanRampDropdown(). Reading them first also means a launch the index has never heard of
 * still places, which is what a hand-written river ramp is.
 */
export function rampCoords(lakeName, rampName) {
  const opt = document.querySelector('#planRamp option:checked');
  const oy = parseFloat(opt && opt.dataset ? opt.dataset.lat : NaN);
  const ox = parseFloat(opt && opt.dataset ? opt.dataset.lon : NaN);
  if (opt && opt.value && Number.isFinite(oy) && Number.isFinite(ox)) return [ox, oy];
  // NOTHING NAMED IS NOT A REASON TO GUESS. The caller says so out loud instead. And the matching
  // below is matchRampIndex() -- the one copy of "is this the same launch", see js/utils/ramp-match.js
  // -- rather than this function's own third version of it.
  if (!normRampName(rampName)) return null;
  // LAUNCHES FIRST, because /bank-pier reads through the access index from 2026-09-22 and it
  // names things after the ramp beside them: "Lake Wateree State Park" is the ramp, "Lake
  // Wateree State Park Bank" is a fishing platform 52 m away. Resolving a picked ramp to the
  // bank's coordinate would put the plan's start on the wrong side of the parking lot. The
  // fallback keeps every row in play when no launch matches, so nothing that resolved before
  // stops resolving.
  const all = getLoadedAccessIndex()?.byLake?.get(lakeName) || [];
  const launches = all.filter((p) => p.launch !== false);
  const points = matchRampIndex(launches, rampName, null, null) >= 0 ? launches : all;
  const i = matchRampIndex(points, rampName, null, null);
  const hit = i >= 0 ? points[i] : null;
  if (hit && Number.isFinite(hit.lat)) return [hit.lon, hit.lat];
  return null;
}

function minutesBetween(a, b) {
  const p = (s) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(s || '')); return m ? +m[1] * 60 + +m[2] : null; };
  const x = p(a), y = p(b);
  return x != null && y != null && y > x ? y - x : null;
}

/** Build a plan and put it on the screen. Returns the result so a test or the console can read it. */
/**
 * @param {object}  [opts]
 * @param {boolean} [opts.dryRun]  build the prompt and stop. No model call, no cost, no plan.
 * @param {boolean} [opts.bench]   call the model, assemble the plan, and STOP THERE -- no GPX,
 *                                 no timeline globals, no notification session.
 *
 * BOTH EXIST FOR THE SAME REASON AND IT IS NOT A SECOND PLANNER. Ryan, 2026-09-06: "i want this
 * as something to test the app before a plan is a plan... this way i am not firing alerts off on
 * my phone for a plan that i will never fish."
 *
 * So the bench runs THIS function -- the same inputs, the same prompt, the same assembler -- and
 * returns before the three things that make a plan a plan: materialisePlan() writes the GPX,
 * loadSessionFromPlan() arms the phone, and planToTimeline() installs the globals every
 * downstream reader uses. A parallel implementation would be testing itself.
 */
export async function runSmartPlanV2(opts = {}) {
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
  // TWO DIFFERENT REFUSALS, because they need two different things done about them. "Pick one" is
  // actionable; "we cannot place the one you picked" is a data problem and naming it is the fix.
  if (!ramp) {
    return say(inp.rampName ? `Could not place "${inp.rampName}" on ${inp.lakeName}`
                            : 'Select a ramp / launch first', true), null;
  }

  const date = new Date(`${inp.dateStr}T12:00:00`);
  // THE WATER GETS A SAY. `season` decides the depth band, the structure weights and which
  // research entry is read, and it was decided by the month alone -- so a plan dated September 1st
  // read the fall profile with 85 degree water in the lake. See getSeason().
  const season = getSeason(date, inp.waterTempF);

  const species = inp.species[0];

  // THE LAW FIRST, BEFORE A MODEL CALL IS SPENT ON IT. Ryan: "reg check is needed so we don't
  // plan on closed waters." A block returns here — there is no point costing a Gemini call, a
  // battery budget and a morning on a species that cannot be kept today.
  //
  // AND THE BOOK HAS TO BE IN HAND BEFORE IT CAN BE CONSULTED. checkPlanLegality() is
  // synchronous and answers out of a cache; the only thing that filled that cache was a
  // fire-and-forget line in conditions-strip.js on a different trigger, and this call sat
  // thirty-three lines ahead of the only async water work on the path. So it ran cold every
  // time and every inland lake came back "No regulation data". One await, before the read.
  await ensureRegulations(inp.lakeName, { worker: CF_WORKER_URL });
  // The plan render is synchronous, so the advisory table is warmed here beside the regulations
  // it prints under. It never throws -- a water with no advisory and no network look the same to
  // the caller, and both mean the section does not appear.
  await primeFishAdvisories({ worker: CF_WORKER_URL });
  // AND WHAT IS CAUGHT INSHORE IN THIS STATE THIS WAVE, warmed here for the same reason: the
  // prompt build is synchronous and this is a registry fetch. Never throws; a cold table is a
  // prompt with no seasonality section, which is the prompt that was there before.
  await primeInshoreSeason({ worker: CF_WORKER_URL });
  // AND THE TWO TABLES THAT ANSWER WHAT IS UNDER THE BOAT. Same route, same reason.
  await primeSeabedHabitat({ worker: CF_WORKER_URL });

  // THE RESEARCH PROFILE IS THE POINT OF THE RESEARCH PIPELINE. The first version of this file
  // ignored it entirely and used the four-lake built-in table — worse than v1, which at least put
  // the research prose in its prompt. Try the in-memory cache the research tab fills, then ask
  // the Worker, because the planner should not depend on someone having opened that tab first.
  //
  // LOADED HERE AND NOT SEVENTY LINES DOWN, because the legality check below reads its closed
  // seasons and cannot await for them. This is the same shape as the ensureRegulations() bug
  // noted above -- a synchronous check sitting ahead of the only call that fills what it reads --
  // and it is one load used by both, not a second fetch for the law.
  const researched = await loadResearchedProfile(inp.lakeName);

  const legality = checkPlanLegality(inp.lakeName, species, date, { profile: researched });
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

  // ── THE CLARITY AT HIS LAUNCH, RESOLVED HERE AND NOT READ OFF A SELECT ──────────────────────
  //
  // `inp.clarity` is the Water Clarity dropdown, and that dropdown is filled by
  // syncClarityIntelData() whenever it last happened to run -- which on a reload with the ramp
  // already set is at +1000ms with an unfilled `planRamp`, so it held the lake-wide MEAN of six
  // zones. His 22:22 bench on 2026-09-15 sent `"clarity": "Muddy"` while the model was separately
  // told `Typical clarity: stained`, and his own ramp's zone was the clearest water on the lake.
  //
  // Resolved from the ramp on the request instead. Null when the forecast is unreachable, and then
  // the form's value stands -- a failed fetch is not evidence that the water is clear.
  const clarityAtRamp = await fetchClarityAtRamp(inp.lakeName, inp.dateStr,
    { worker: CF_WORKER_URL, rampName: inp.rampName });
  if (clarityAtRamp && clarityAtRamp.select) inp.clarity = clarityAtRamp.select;
  // ── AND THE BRIEFING ON THE CARD IS REGENERATED WITH THAT RAMP, BEFORE THE PLAN IS COLLECTED ──
  //
  // #planClarityIntel is a snapshot: written whenever syncClarityIntelData last ran, saved into the
  // plan from there, and read back onto the card. It runs on lake change, tab switch, app load and a
  // button — and a restored form fires no change event, so on a reload the only run is at +1000ms
  // while the ramp dropdown is still filling. Ryan had Clearwater Cove selected the whole time and
  // the briefing still carried no line about it, because it was rendered before the box had it.
  //
  // Handed the payload fetchClarityAtRamp already fetched, so this is a re-render and not a second
  // request. Awaited, because collectPlan() reads that textarea.
  if (clarityAtRamp && clarityAtRamp.payload) {
    await syncClarityIntelData({ rampName: inp.rampName, payload: clarityAtRamp.payload })
      .catch((e) => console.warn('[plan] clarity briefing refresh failed:', e && e.message));
  }

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

  // WHAT THE REGISTRY KNOWS SWIMS HERE, whether or not this water has ever been researched.
  // Four files keyed by its slug; see fetchRegistrySpecies() and registrySpeciesFor(). Null on a
  // water the registry cannot identify, which leaves the prompt exactly as it was.
  const regRow = registryRecordFor(inp.lakeName);
  const regSpecies = await fetchRegistrySpecies(CF_WORKER_URL, inp.lakeName,
                                                (regRow || {}).state || '', species,
                                                (regRow || {}).slug || '');
  // `Lake type` off the row the browser already holds. No fetch -- see registryIdentity().
  const regId = registryIdentity(regRow);
  // THE OPERATOR'S OWN SEASONAL CURVE, off the conditions call this path already makes.
  // fetchWaterState() carries it as `pool`; see the note there for why it is not Duke-only any
  // more. Null on a water nobody manages, which is the honest answer for a natural lake.
  const regLim = (waterState && waterState.pool
                  && Number.isFinite(waterState.pool.seasonalDrawdownFt))
    ? { seasonalDrawdownFt: waterState.pool.seasonalDrawdownFt } : null;
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
      // HOURLY, NOT A DAILY MAXIMUM, and it now reaches the candidate selector as well as the
      // prompt -- see the note at the selectCandidates() call in smart-plan-v2.js. Null when the
      // forecast is unreachable, and the `problems` line further down says so rather than letting
      // a missing forecast read as a calm day.
      windByHour: forecast ? forecast.windByHour : null,
      weatherByHour: forecast ? forecast.weatherByHour : null,
      // THE LIGHT GUIDANCE ANYBODY ACTUALLY WROTE DOWN ABOUT THIS WATER. `_extractedFacts` carries
      // a fact, the quote it came from and the source; some of them tie a depth or a presentation
      // to the light, and until now nothing outside the research pipeline read one. Selected here
      // because this is where the profile is, and sent rendered, like `intel`.
      lightFacts: lightFactsFrom(researched),
      // AND THE FACTS ABOUT WHERE THE FISH SIT. `seasonalDepth`, `waterDepthUnderFish`,
      // `holdingPattern` and `seasonalPattern` are the four categories in `_extractedFacts` with
      // no structured home, so until now they reached nothing unless they happened to contain a
      // light word. Measured 2026-09-17: nine such facts on the card, all of them on the Congaree,
      // and the bench plan run on that river saw none of them. Selected here, where the profile is.
      patternFacts: patternFactsFrom(researched),
      conditions: {
        ...conditionsFrom(inp, ramp, sol, forecast, clarityAtRamp),
        // The model is told where the band came from, so a generic one cannot be mistaken for a
        // lake-specific one by the thing writing the reasoning.
        //
        // AND WHICH QUANTITY THE BAND IS. `ft` is where the FISH are, not the depth of the water,
        // and the model has to be told which or it will do what the app did for months and reason
        // about them as one number. `holding` is what separates them, `waterDepthFt` is the water
        // the research actually saw those fish over where it said so, and `sourceQuote` is the
        // sentence all of it came from.
        // ONE BUILDER, BOTH PLANNERS. This object was assembled here and Pick Water sent a
        // three-field stub of it -- no basis, no waterDepthFt, no sourceQuote and, worst,
        // no `note`, which is the only place the prompt is told what `holding` MEANS.
        // See describeDepthBand() in plan-inputs.js.
        depthBand: describeDepthBand(depth, species, season),
      },
      waterState,
      catches: state.CATCHES || [],
      // What the research pipeline actually found about this water — thermocline, oxygen,
      // forage, habitat, the lot. v2 was sending none of it.
      //
      // A CALLBACK, BECAUSE NEITHER SIDE HAS BOTH HALVES. The profile, the species and the season
      // are here; the chartpack is fetched inside buildSmartPlanV2. Passing a closure lets the
      // pack's own structure, coves, creek mouths and POIs beat the ones frozen in the profile
      // without this function downloading the pack a second time.
      // THE PACK'S FACTS AND THE REGISTRY'S, THROUGH THE ONE DOOR. `regSpecies` is awaited above
      // rather than inside the closure, because buildSmartPlanV2 calls this synchronously while
      // it assembles the prompt -- a promise here would reach researchIntel() as an object.
      // The estimate that runs ONLY where no cast answered -- see thermoclineNormFor().
      thermoclineNormFor: (pf) => thermoclineNormFor(researched, Date.now(), pf),
      // WHAT IS CAUGHT INSHORE IN THIS STATE IN THIS WAVE. Resolved here because this is where
      // the state is -- regulationStateFor() is the SAME derivation the legality check used
      // twenty lines above, and two readers of "which state is this water in" is how they drift.
      // Inland waters resolve a state and then find no coastal roster, so this is null there.
      inshoreSeason: inshoreSeasonFor(regulationStateFor(inp.lakeName), species, date),
      // THE ZONE, NOT THE STATE, because the ENC bottom is filed per coastal zone.
      // detectCoastalZone() is the same derivation checkPlanLegality() routes on, and it
      // returns null inland -- which is exactly when this block must not print.
      seabedHabitat: seabedHabitatFor(detectCoastalZone(inp.lakeName), species),
      // THE SAME DOOR AGAIN, for the same reason: the profile is here and the pack is not, and a
      // registry limnology record may beat the profile's copy. One number, read once, used by the
      // gate that decides which baits the model is even shown.
      oxygenFloorFor: (pf) => oxygenFloorFt(researched,
        regLim ? { ...(pf || {}), limnology: regLim } : pf),
      // The live surface reading and where it came from, for the squeeze block -- see
      // researchIntel(). Same value season is derived from.
      intelFor: (packFacts) => researchIntel(researched, species, season, Date.now(),
        (regSpecies || regId || regLim)
          ? { ...(packFacts || {}),
              ...(regId ? { identity: { ...regId, ...((packFacts || {}).identity || {}) } } : {}),
              ...(regSpecies ? { biology: regSpecies } : {}),
              ...(regLim ? { limnology: regLim } : {}) }
          : packFacts,
        // THE SAME NUMBER THE MODEL IS SHOWN. The conditions block prints waterState's live
        // reading, so the squeeze has to reason about that one -- two temperatures for one lake in
        // one prompt is the defect fixed in bd48bcf, and reintroducing it here would be worse
        // because these two would be the SAME field disagreeing. The form value is the fallback.
        //
        // AND THE GUARD HAS TO BE isNum, NOT Number.isFinite(Number(...)). `waterTempF` is
        // declared `null` in water-conditions.js's defaults on purpose, so the shape is the same
        // on a water with no thermometer -- and Number(null) is 0, which is finite. This line
        // therefore passed on every ungauged water and handed the squeeze a water temperature of
        // ZERO DEGREES, while `inp.waterTempF` -- the fallback the paragraph above calls the
        // fallback -- was never reached.
        //
        // Worse than a wrong number, given what the comment above promises: the conditions block
        // was fixed this morning to stay silent when nothing measured a temperature, so the two
        // had begun DISAGREEING about the same field, which is exactly the defect bd48bcf closed.
        // See js/utils/num.js -- eighth instance of this family.
        { tempF: isNum(waterState && waterState.waterTempF)
            ? Number(waterState.waterTempF) : inp.waterTempF,
          tempFrom: (waterState && waterState.waterTempFrom) || null }),
      // THE SAFETY SECTION'S HAZARD SENTENCE, which has never once had anything to say because
      // nothing filled this. Same profile, already loaded, one field further down.
      tackle: castableOrTrollable.map((l) => l.name),
      inventory: castableOrTrollable,
      // A NAME IS NOT A DEPTH. Pick Water has passed this since capBaitDepth() needed it; Smart
      // Plan never did, so the only depth information reaching the model on this path was
      // whatever was printed in a lure's name -- "DD3 Crankbait (20-25ft)". See depthNote() in
      // plan-prompt.js for what it says now, and why the shallow end is the one to trust.
      lureByName: (name) => {
        const n = String(name || '').trim().toLowerCase();
        return n ? TACKLE_INVENTORY.find((l) => String(l.name).toLowerCase() === n) || null : null;
      },
      fetchJson: packFetcher(CF_WORKER_URL),
      // Transits go over the water graph instead of straight through whatever is in the way.
      // Worker/water.js has answered POST /water/<slug>/route since it was written and nothing
      // in the browser had ever called it, so every transit in every plan Ryan has seen was a
      // straight line between two leg ends. When the endpoint cannot answer, the leg says
      // `unrouted: true`, the plan warns, and validatePlan() lists it -- it is never faked.
      // The same floor Pick Water sends. A transit is a transit whichever tab planned it.
      routeWater: waterRouter(CF_WORKER_URL, r2Key, { minDepthFt: TRANSIT_MIN_DEPTH_FT }),
      askModel: async (req) => { say('Asking the model…'); return modelAsker(CF_WORKER_URL)(req); },
      // Straight through. buildSmartPlanV2 returns {plan:null, request, candidates} and spends
      // nothing -- see the dryRun note there.
      dryRun: opts.dryRun === true,
    });
  } catch (e) {
    say(`Failed: ${e.message}`, true);
    if (out) out.innerHTML = `<p class="pv-empty">${e.message}</p>`;
    return null;
  }

  // THE PROMPT, AND NOTHING ELSE HAPPENS. Before the no-plan branch, because a dry run has no
  // plan BY DESIGN and reporting that as a failure is how a working thing reads as broken.
  if (opts.dryRun) {
    say(`Prompt built — ${(r.request?.user || '').length.toLocaleString()} characters, `
      + `${(r.candidates || []).length} candidates. Nothing was sent.`);
    return r;
  }

  // REGULATION ADVISORIES RIDE WITH THE PLAN, not into a console nobody opens. A slot limit, a
  // gear restriction or an extracted closed season is something you want on the water.
  // checkPlanLegality returns these separately from `legal` on purpose: a warning is not a block.
  //
  // MERGED HERE, WHICH IS BEFORE ANYBODY READS THE LIST. This sat below planToTimeline(), so
  // every reader above it -- the no-plan branch, the bench's `problems` array and the bench's own
  // draw -- was handed the list as it stood seven lines earlier, without a word of the law in it.
  // Ryan has been pasting that bench JSON to me. The value was right and it was addressed after
  // the readers had already read.
  if (legality.warnings && legality.warnings.length) {
    r.problems = [...legality.warnings, ...(r.problems || [])];
  }
  // And the limits that were read and are not in the way go where the app's other settled things
  // go -- see plan-assemble.js. They are still on the plan and still rendered; they are not one
  // of the things it wants to tell him before he launches.
  if (legality.notes && legality.notes.length && r.plan) {
    r.plan.decisions = [...legality.notes, ...(r.plan.decisions || [])];
  }

  if (!r.plan) {
    say(r.problems[0] || 'No plan', true);
    if (out) out.innerHTML = `<ul style="color:var(--warn);font-size:12px">${
      r.problems.map((p) => `<li>${String(p).replace(/[&<>]/g, '')}</li>`).join('')}</ul>`;
    return r;
  }

  // THE ANSWER AND WHAT THE APP MADE OF IT, AND STILL NO PLAN. `r` already carries all three
  // things the bench shows -- `request` is what the model was given, `response` what it said, and
  // `plan` plus `problems` what assemblePlan() made of that. Returning here is what keeps the
  // phone quiet and the GPX unwritten.
  if (opts.bench) {
    // AND DRAWN THE WAY THE PLAN TAB WOULD DRAW IT. Ryan, 2026-09-14: "could we use the html
    // ouput and a json output here? that way i can show you what it says but i can see the plan
    // the way it would have been drawn". So this calls THE renderer, not a second one -- a bench
    // view that drifts from the real one is worse than no bench view.
    //
    // `preview` is what makes that safe. It draws into the bench's own container and suppresses
    // every window._smartPlan* write, so collectPlan(), Preview, Print, the downloads and the GPX
    // interleave still see nothing. installTimeline() and syncSpread() are deliberately NOT called
    // here for the same reason: the spread table and the globals belong to a plan Ryan decided to
    // fish, and this is not one.
    try {
      const shown = planToTimeline(r.plan, {
        depthBand: depth.band,
        holding: depth.holding || null,
        // ── THE CARD HAS TO KNOW WHETHER THE BAND WAS MEASURED ────────────────────────────────
        //
        // Ryan, 2026-09-19, after the prompt's own note had been fixed to stop restating an
        // inferred range: *"so i still see a thing about 0-5ft suspended on troll legs"*. He was
        // reading the LEG CARD, which is the third place this claim is made and the only one he
        // looks at on the water. It printed "fish 0-5 ft · suspended" flat, as measured fact,
        // because the band and the holding word were passed here and the evidence was not.
        fishDepthEvidence: fishDepthEvidence(depth),
        warnings: r.problems || [],
      });
      renderSmartPlanUI({
        routeRods: shown.routeRods, routeSpeeds: shown.routeSpeeds,
        speedMph: shown.cards[0] ? shown.cards[0].speedMph : 2.0,
        stopCandidates: shown.stopCandidates,
        scoutReport: shown.rationale,
        solunar: sol ? `Majors ${conditionsFrom(inp, ramp, sol, null).solunar.majors.join(', ')}` : '',
        cardDefs: shown.cards, unified: shown.timeline,
        preview: 'benchPlan',
      });
      // WHAT WAS DRAWN, KEPT SO IT CAN BE WRITTEN OUT. Ryan, 2026-09-14, on the first version of
      // the bench's HTML export: "i was looking for the html plan output just like if i ran a
      // plan." The report builder takes a collectPlan()-shaped object, and every plan-derived
      // field in one comes from precisely this conversion -- so the export renders THIS, not a
      // second conversion of its own. Nothing here is written to a global; it rides on `r`.
      r.shown = shown;
    } catch (e) {
      // A DRAW THAT FAILS MUST NOT EAT THE BENCH. The prompt, the answer and the assembled JSON
      // are the point of this run; the picture is the convenience.
      console.warn('[bench] preview render failed:', e && e.message);
      const el = typeof document !== 'undefined' && document.getElementById('benchPlan');
      if (el) {
        el.innerHTML = '<p class="pv-empty">The plan could not be drawn — '
          + String((e && e.message) || e).replace(/[&<>]/g, '')
          + '. The JSON below is unaffected.</p>';
      }
    }
    say(`Answered — ${(r.plan.legs || []).length} legs, ${(r.problems || []).length} warnings. `
      + 'Drawn below. Nothing saved, nothing sent to the phone.');
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
    holding: depth.holding || null,
    fishDepthEvidence: fishDepthEvidence(depth),   // see the note on the other call site
    warnings: r.problems || [],
  });
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
    // The day being FISHED. Without it the watch expires against the day it was BUILT.
    date: inp.dateStr,
    // THE SAME `sol` THIS PLAN WAS BUILT WITH, handed over rather than left on `window` for
    // notifications.js to find. It read `window._trollmapSolunar`, which only the v1 builder
    // writes, so every v2 trip watch armed without a single bite window in it.
    solunar: sol,
    returnTime: inp.returnTime,
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

  // AN OVERRIDE THAT HAPPENS SILENTLY IS THE SAME AS NO OVERRIDE. The season decides the depth
  // band, the structure weights and which research entry is read; when the water overrules the
  // calendar it changes all three, and the whole reason getSeason() takes a temperature is that
  // a band changed under him once without anything saying so.
  const sn = seasonNote(date, inp.waterTempF);
  if (sn) r.problems = [...(r.problems || []), sn];

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
    const url = `${CF_WORKER_URL}/research/get?lake=${encodeURIComponent(lakeName)}`;
    const r = await fetch(url);
    if (r.status === 404) {
      // A 404 IS NOT PROOF THAT NOBODY RESEARCHED THIS LAKE. It is proof that nothing answered to
      // THIS NAME, and the two are not the same claim: the store holds 62 profiles under three
      // different spellings of the same lakes, which is why handleResearchGet resolves a
      // candidate list instead of one key. A silent return therefore makes a miss unfalsifiable
      // -- the plan says "no researched profile exists for this water" and nobody can tell
      // whether that means absent or unmatched.
      //
      // NOT the cause of Ryan's 2026-08-30 report. Measured against the live Worker that day,
      // `/research/get?lake=Lake Wateree, SC` answers ok with the v140.0 profile; Pick Water
      // simply never handed it to the prompt. This line stands anyway, because it is the check
      // that would have ruled the misfiling story out in one run instead of an afternoon.
      console.warn(`[plan-v2] no research profile answered to "${lakeName}" — if this lake HAS `
        + `been researched, it is filed under a name this lookup did not try.`);
      return null;
    }
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
