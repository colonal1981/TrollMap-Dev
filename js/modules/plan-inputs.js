/**
 * plan-inputs.js — the parts of "what am I planning" that are not the DOM.
 *
 * Split out of `smart-plan-v2-wiring.js` because that file's own opening line says everything
 * that knows about `document` lives there and everything below it is pure — and then these two
 * were sitting in it. They are pure, they carry the awkward domain facts, and they are the two
 * things most worth testing, so they go where a test can reach them: the wiring module cannot be
 * imported outside a browser at all, since its import graph reaches `window`.
 */

import { SPECIES_BEHAVIOR_V2, resolveLakeKey } from '../data/species-intel.js';

/**
 * THE WHOLE DAY'S DEPTH BAND, not a phase's.
 *
 * v1 split the day into three phases and narrowed the band for each, because it built four fixed
 * out-and-back routes and had to decide up front which depth each one ran. v2 has no phases: the
 * model is handed every reachable leg in the species' range and decides itself what to fish when.
 * So this is `preferredDepth`, unnarrowed.
 *
 * ---------------------------------------------------------------------------------------------
 * THE RESEARCH PROFILE COMES FIRST. THIS IS THE WHOLE POINT OF THE RESEARCH PIPELINE.
 *
 * Ryan, 2026-08-07: "i thought that whole thing was supposed to be replaced by the research
 * pipeline... please tell me we are using all of that great data that is sitting there."
 *
 * He was right and the first version of this file was wrong. The research pipeline's fisheries
 * agent — "🧠 Species Intelligence" — writes `trollingIntelligence` into every lake's profile,
 * and its shape is `[species][season].preferredDepth`: the SAME field as the hardcoded table,
 * derived per lake from real sources, for every lake that has been researched.
 *
 * SPECIES_BEHAVIOR_V2 covers four lakes. The research profiles cover whatever has been run. So
 * the order is: the lake's own researched answer, then the hardcoded table, then the union of
 * table lakes as a labelled generic. Each step down is worse and each says so in `source`.
 *
 * `preferredDepth` from the table is sometimes a function of water temperature, and planWaterTemp
 * is often blank, so the null case has to work — fall through rather than filtering the whole
 * lake out on a bad number. Research profiles store a plain array.
 * ---------------------------------------------------------------------------------------------
 *
 * @param {object} [researched] the profile from window.getResearchedProfile() or /research/get
 */
export function depthBandFor(species, lakeName, season, waterTempF, researched) {
  // getSeason() returns 'summer', and every caller that hand-wrote 'Summer' got silently no
  // plan. Normalise here rather than trusting six call sites to agree.
  const seasonKey = String(season || '').toLowerCase();
  const fromResearch = researchedBand(researched, species, seasonKey);
  if (fromResearch) return clampToOxygen(fromResearch, researched);

  const sp = SPECIES_BEHAVIOR_V2?.[species];
  if (!sp) return null;
  const s = seasonKey;

  const read = (node) => {
    const pref = node && node.preferredDepth;
    if (!pref) return null;
    let band = pref;
    // preferredDepth is a function of water temperature on some lakes, and planWaterTemp is
    // often blank. A throw or a nonsense answer must fall through, not filter out the lake.
    if (typeof pref === 'function') { try { band = pref(waterTempF); } catch { return null; } }
    if (!Array.isArray(band) || band.length !== 2) return null;
    const [a, b] = band.map(Number);
    return Number.isFinite(a) && Number.isFinite(b) && b > a ? [a, b] : null;
  };

  const key = resolveLakeKey(lakeName, sp);
  const own = key && sp[key] ? read(sp[key][s]) : null;
  if (own) return clampToOxygen({ band: own, basis: `built-in table, ${key}`, generic: false, source: 'table' }, researched);

  // ---------------------------------------------------------------------------------------
  // THE TABLE COVERS FOUR LAKES. THE APP SHIPS FIFTEEN HUNDRED PACKS.
  //
  // SPECIES_BEHAVIOR_V2 holds Wateree, Murray, Marion and Moultrie; v1 holds two. Every other
  // water has no profile for any species, and there is no `default_SC_reservoir` key despite
  // three places reaching for one. v1 hid this: getPhaseRecommendation() returns null and the
  // caller falls into a hardcoded 12-18 / 22-28 ft in its own catch block, so a Hartwell plan
  // has always been built on two numbers nobody chose for Hartwell.
  //
  // Refusing to plan would be honest and would also block the ship rule -- "if it has
  // bathymetry ship it". So instead: take what this species does in this season on the lakes
  // the table DOES cover, and widen to their union. That is derived from real data about the
  // fish rather than a number I made up, and wide is the safe direction for a FILTER -- the
  // model still chooses within it, and a band that is too narrow silently removes the lake.
  //
  // `generic: true` rides along so the UI can say so and the model can be told. Do not let it
  // get dropped on the way through; a generic band presented as a lake-specific one is exactly
  // the sort of quiet fiction this rebuild exists to remove.
  // ---------------------------------------------------------------------------------------
  const across = Object.keys(sp).map((k) => read(sp[k] && sp[k][s])).filter(Boolean);
  if (!across.length) return null;
  return clampToOxygen({
    band: [Math.min(...across.map((x) => x[0])), Math.max(...across.map((x) => x[1]))],
    basis: `${s} across the ${across.length} lakes in the built-in table — `
         + `${lakeName} has no researched profile and is not one of them`,
    generic: true,
    source: 'table-union',
  }, researched);
}

/**
 * NOTHING LIVES UNDER THE ANOXIC LAYER, SO DO NOT OFFER LEGS THERE.
 *
 * Ryan's call, 2026-08-07, asked directly: clamp the band to the anoxic depth. On a stratified
 * reservoir in late summer the water below the oxygen line is empty, and a band that reaches into
 * it spends candidate slots on legs no fish can be holding along.
 *
 * The clamp is stated, never silent — `basis` says it happened and `clampedByOxygenFt` carries
 * the number, so a 15-40 ft band showing up as 15-30 is explainable rather than mysterious.
 *
 * ONE CASE IS NOT CLAMPED: an anoxic depth at or above the top of the band. That is the profile
 * contradicting itself — it would leave no fishable water at all — and quietly returning an empty
 * or inverted band would be worse than saying so. The band stands and `oxygenConflict` is set.
 */
function clampToOxygen(result, researched) {
  const anoxic = Number(researched?.limnology?.oxygen?.anoxicBelowFt);
  if (!result || !Number.isFinite(anoxic) || anoxic <= 0) return result;
  const [lo, hi] = result.band;
  if (anoxic >= hi) return result;                       // band already sits in living water
  if (anoxic <= lo) {
    return { ...result,
      oxygenConflict: `the profile puts anoxic water above ${lo} ft, which would leave nothing `
                    + 'fishable — band left alone, check the profile',
      anoxicBelowFt: anoxic };
  }
  return {
    ...result,
    band: [lo, anoxic],
    basis: `${result.basis}, clamped from ${hi} ft to the ${anoxic} ft anoxic line`,
    clampedByOxygenFt: anoxic,
  };
}

// ---------------------------------------------------------------------------------------------
// WEIGHTING THE WATER BY WHAT THE RESEARCH SAYS MATTERS HERE
//
// `selectCandidates` ranks legs by what they pass, using DEFAULT_WEIGHTS: hump 3, creek_mouth 3,
// point 2, ledge 2, cove 1 — the same on every lake, for every species, in every season. That
// table decides which legs are even OFFERED to the model, and it is a guess.
//
// The research profile answers exactly that question per lake and season. Wateree, summer,
// Striped Bass: "main lake points, creek mouths, lower lake basin". So boost the types the
// research named instead of pretending every lake is the same.
//
// A BOOST, NOT A REPLACEMENT. The research names a handful of structure kinds in prose; it is not
// a complete ranking, and zeroing everything it failed to mention would throw away a hump because
// an LLM wrote three bullet points instead of five.
//
// Phrases it cannot map are RETURNED, not dropped. "lower lake basin" and "current breaks" have
// no equivalent in the pipeline's `near[]` vocabulary, and that gap should be visible.
// ---------------------------------------------------------------------------------------------

/**
 * The lake's own researched answer, which beats anything hardcoded.
 *
 * `trollingIntelligence` is written by the research pipeline's fisheries agent and is shaped
 * `[species][season].preferredDepth` — the same field as the built-in table, but derived from
 * sources for THIS lake. Species keys come from an LLM, so they are matched loosely: "Striped
 * Bass", "striped bass" and "Striper" all have to find each other, or the profile silently does
 * nothing and we fall back to a table that does not know this lake.
 */
export function researchedBand(profile, species, seasonKey) {
  const ti = profile && (profile.trollingIntelligence || profile.trolling);
  if (!ti || typeof ti !== 'object') return null;

  const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z]/g, '');
  const want = norm(species);
  if (!want) return null;
  const hit = Object.keys(ti).find((k) => {
    const n = norm(k);
    return n === want || n.includes(want) || want.includes(n);
  });
  if (!hit) return null;

  const band = ti[hit] && ti[hit][seasonKey] && ti[hit][seasonKey].preferredDepth;
  if (!Array.isArray(band) || band.length !== 2) return null;
  const [a, b] = band.map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;

  return {
    band: [a, b],
    basis: `researched profile for this lake — ${hit}, ${seasonKey}`,
    generic: false,
    source: 'research',
  };
}

/** The 20% LiFePO4 reserve is not optional, so it comes off here and never reaches the model. */
export function usableAhFrom(motorField) {
  const m = String(motorField || '').match(/(\d+)\s*ah/i);
  return (m ? parseInt(m[1], 10) : 100) * 0.8;
}

// The lead a named structure gets over an unnamed one. Set to the top of the measured citation
// table, so ANY type the profile named for this species and season outranks ANY type it did not,
// while the measured counts still order things within each group. A multiplier would not do
// that: timber's base of 27 beats a doubled point at 22, so the profile naming points and not
// timber would still have handed back a timber leg.
export const RESEARCH_LEAD = 27;

const STRUCTURE_PHRASES = [
  [/creek\s*mouth|tributary mouth|feeder creek/i, ['creek_mouth']],
  [/\bpoint/i, ['point']],
  [/\bcove|pocket\b|\bbasin\b|\barm\b/i, ['cove']],
  [/hump|offshore structure|sunken island|shoal|high spot/i, ['hump']],
  [/ledge|drop\s*-?\s*off|break\s*line|breakline|\bbluff/i, ['ledge']],
  [/timber|laydown|stump|brush|wood|treetop/i, ['timber', 'attractor']],
  [/attractor|fish habitat|reef ball|brush\s*pile/i, ['attractor', 'pile']],
  [/bridge|causeway|piling/i, ['bridge', 'pile']],
  [/\bflat|shallow|shoreline/i, ['shallow']],
];

// Relief is a property of the run, not a feature on it, so the phrases that describe the WATER
// rather than a thing in it map here instead. "river channel" is the second most-cited item in
// the whole table and has no `near[]` type at all — it is relief.
const RELIEF_PHRASES = [
  [/river channel|channel|current break|\bcut\b|old river/i, ['channel_edge']],
  [/\bflat/i, ['flat']],
  [/steep|bluff|wall/i, ['steep_bank']],
  [/break/i, ['break']],
];

/**
 * Weights for THIS species, THIS season, on THIS lake.
 *
 * TROLLING_RUNS_THE_LINE_WAS_ALWAYS_THERE_2026-08-06.md put the judgement here on purpose:
 * "Whether six stands of flooded timber beat nine humps depends on the species, the season and
 * where the forage is, and that judgement lives in the app's trollingIntelligence, not in a
 * pipeline script." A constant table in the app is that same mistake moved one file over, so the
 * constants are only the fallback for a lake nobody has researched.
 *
 * A LEAD, NOT A REPLACEMENT. The profile names a handful of structure kinds in prose; it is not a
 * complete ranking, and zeroing everything it failed to mention would throw away a timber stand
 * because an LLM wrote three bullet points instead of five.
 *
 * Phrases that map to nothing are RETURNED, not dropped. "lower lake basin" and "current breaks"
 * had no equivalent when this was written, and that gap belongs in the open.
 *
 * @param {object}   base           DEFAULT_WEIGHTS
 * @param {object}   baseRelief     DEFAULT_RELIEF_WEIGHTS
 * @param {string[]} structures     the researched `structures` list for this species and season
 */
export function structureWeights(base, baseRelief, structures) {
  const weights = { ...base };
  const reliefWeights = { ...baseRelief };
  const matched = new Set();
  const unmatched = [];

  for (const phrase of (structures || [])) {
    const text = String(phrase || '');
    if (!text.trim()) continue;
    let hit = false;

    for (const [re, types] of STRUCTURE_PHRASES) {
      if (!re.test(text)) continue;
      for (const t of types) {
        // Only lead something the ranker already scores. Inventing a weight for a type the
        // pipeline never emits would look like it worked and do nothing — which is exactly the
        // shape of the docks gap, and that one is recorded rather than faked.
        if (base[t] > 0) { weights[t] = base[t] + RESEARCH_LEAD; matched.add(t); hit = true; }
      }
    }
    for (const [re, kinds] of RELIEF_PHRASES) {
      if (!re.test(text)) continue;
      for (const k of kinds) {
        if (baseRelief[k] > 0) { reliefWeights[k] = baseRelief[k] + RESEARCH_LEAD; matched.add(`relief:${k}`); hit = true; }
      }
    }
    if (!hit) unmatched.push(text);
  }
  return { weights, reliefWeights, matched: [...matched].sort(), unmatched };
}

/**
 * What the research pipeline found about this water, as prose for the prompt.
 *
 * The pipeline stores far more than a depth band, and none of it was reaching v2. What is
 * selected here is what changes a day's fishing:
 *
 *   - THERMOCLINE AND OXYGEN. On a stratified reservoir in August these are not colour, they are
 *     the constraint: fish are squeezed between the thermocline and the anoxic layer, and a
 *     depth band that ignores them is describing water nothing can live in.
 *   - FORAGE. What they are eating and where it moves is the argument for a lure.
 *   - HABITAT the chartpack cannot see — timber fields, attractor counts, bottom composition.
 *   - CLARITY and DRAWDOWN, which move fish shallow or deep independently of season.
 *
 * Left out on purpose: regulations (checked separately and hard-blocking), source registries, and
 * anything the pipeline marks unverified. A field the research could not establish is absent
 * rather than empty — the model must not read a blank as a zero.
 */
export function researchIntel(profile, species, season) {
  if (!profile) return null;
  const out = [];
  const s = String(season || '').toLowerCase();
  const put = (label, v, unit = '') => {
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) return;
    out.push(`${label}: ${Array.isArray(v) ? v.join('; ') : v}${unit}`);
  };

  const id = profile.identity || {};
  const lim = profile.limnology || {};
  const bio = profile.biology || {};
  const hab = profile.habitat || {};

  put('Lake type', id.archetype || id.bodyType);
  put('Max depth', id.maxDepthFt, ' ft');
  put('Average depth', id.averageDepthFt, ' ft');

  // The two that decide where the fish can physically be.
  if (lim.thermocline?.summerDepthFt) {
    out.push(`Thermocline in summer: ${lim.thermocline.summerDepthFt} ft`
      + (lim.thermocline.strength ? ` (${lim.thermocline.strength})` : ''));
  }
  put('Anoxic below', lim.oxygen?.anoxicBelowFt, ' ft — nothing holds under this in late summer');
  put('Oxygen depletion begins', lim.oxygen?.depletionDepthFt, ' ft');
  put('Trophic status', lim.trophicStatus);
  put('Typical clarity', lim.waterClarity?.typical);
  put('Secchi', lim.waterClarity?.secchiFt, ' ft');
  put('Seasonal drawdown', lim.seasonalDrawdownFt, ' ft');
  put('Flow', lim.flowCharacteristics);

  // Ryan's call, 2026-08-07: these belong in the plan. What else is in the lake and how
  // abundant the target actually is are both arguments about lure and presentation.
  put('Other predators here', bio.predatorSpecies);
  put('How abundant the target is', bio.speciesAbundance);
  put('Primary forage', bio.primaryForage);
  put('Secondary forage', bio.secondaryForage);
  put('Baitfish movement', bio.baitfishMovement);
  put('Forage location', bio.forageSpatial);
  put('Spawn timing', bio.spawnTiming);
  put('Stockings', bio.knownStockings);

  put('Standing timber', hab.standingTimber || hab.timberFields);
  put('Fish attractors', hab.artificialHabitatDetails?.attractorCount);
  put('Attractor types', hab.artificialHabitatDetails?.attractorTypes);
  put('Bottom', hab.bottomComposition);
  put('Vegetation', hab.vegetation);
  put('Named creek mouths', hab.namedCreekMouths);

  // The fisheries agent's own words for this species and season, beyond the depth band.
  const band = researchedBand(profile, species, s);
  const ti = profile.trollingIntelligence || profile.trolling;
  if (ti && band) {
    const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z]/g, '');
    const key = Object.keys(ti).find((k) => norm(k).includes(norm(species)) || norm(species).includes(norm(k)));
    const node = key && ti[key] && ti[key][s];
    if (node) {
      // FIELD NAMES CHECKED AGAINST A REAL PROFILE, 2026-08-07 — Lake Wateree, Striped Bass.
      // The pipeline writes `structures`, `forage` and `recommendedPresentations`. My first
      // guesses were `preferredStructure` and `preferredPresentation`, which matched nothing, so
      // the richest part of the profile silently produced an empty line. The alternates are kept
      // because older profiles may predate the current agent, but the real names come first.
      out.push(`Researched for ${key}, ${s}: ${band.band[0]}-${band.band[1]} ft`);
      put('  structures', node.structures || node.preferredStructure || node.structure);
      put('  forage here, this season', node.forage);
      put('  presentations', node.recommendedPresentations || node.preferredPresentation || node.presentation);
      put('  notes', node.notes);
    }
  }

  const summary = profile.summary?.text || (typeof profile.summary === 'string' ? profile.summary : null);
  if (summary) out.push(`Summary: ${String(summary).slice(0, 1200)}`);

  if (!out.length) return null;
  const verified = profile.metadata?.status === 'verified' || profile.metadata?.verified;
  return `Researched profile for this lake${verified ? ' (verified)' : ' (NOT yet verified — weigh accordingly)'}:\n`
       + out.map((l) => `- ${l}`).join('\n');
}
