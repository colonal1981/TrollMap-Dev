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
  if (fromResearch) return fromResearch;

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
  if (own) return { band: own, basis: `built-in table, ${key}`, generic: false, source: 'table' };

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
  return {
    band: [Math.min(...across.map((x) => x[0])), Math.max(...across.map((x) => x[1]))],
    basis: `${s} across the ${across.length} lakes in the built-in table — `
         + `${lakeName} has no researched profile and is not one of them`,
    generic: true,
    source: 'table-union',
  };
}

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
