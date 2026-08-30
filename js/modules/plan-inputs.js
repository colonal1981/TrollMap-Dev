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

  // ---------------------------------------------------------------------------------------
  // THE PICKER AND THE TABLE DO NOT USE THE SAME NAMES, AND NOBODY NOTICED.
  //
  // Ryan, 2026-08-08, looking at the Plan tab: "how many species did you say there was when you
  // were talking about structure... good thing i can plan for all of them huh."
  //
  // The picker offers seven freshwater species. The table keys three of them differently:
  //
  //     picker "Hybrid"      table "White Bass / Hybrid"
  //     picker "White Bass"  table "White Bass / Hybrid"
  //     picker "Catfish"     table "Blue Catfish", "Channel Catfish", "Flathead Catfish"
  //
  // An exact lookup returns undefined for all three, `depthBandFor` returns null, and the planner
  // refuses with "No depth profile" before it reads the pack. THREE OF THE SEVEN SPECIES IN THE
  // PICKER COULD NOT PRODUCE A PLAN AT ALL. Loose matching was already written for the research
  // profile — where an LLM writes the keys — and the built-in table needed it just as badly.
  //
  // When a picker name spans several table keys, as "Catfish" does, the bands are UNIONED rather
  // than one being picked. Choosing blue over flathead on alphabetical order would be inventing a
  // fish, and the union is the honest read of "catfish" as an ask.
  // ---------------------------------------------------------------------------------------
  const keys = matchSpeciesKeys(SPECIES_BEHAVIOR_V2, species);
  if (!keys.length) return null;
  const sp = SPECIES_BEHAVIOR_V2[keys[0]];
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

  // Across every table key this picker name matched: the lake's own entry, then the species-wide
  // default.
  //
  // CORRECTION, 2026-08-08. An earlier comment here claimed there was no `default_SC_reservoir`
  // key "despite three places reaching for one". Wrong: TWELVE of the table's thirteen species
  // have exactly that key, and the two saltwater ones have `Coastal SC Inshore`. Only Striped
  // Bass is keyed per lake. v1 walked lake -> default -> nothing; I dropped the middle step when
  // I rewrote this, which sent every species but stripers down the union fallback for no reason.
  const DEFAULTS = ['default_SC_reservoir', 'Coastal SC Inshore'];
  const owns = [];
  for (const k of keys) {
    const node = SPECIES_BEHAVIOR_V2[k];
    const lakeKey = resolveLakeKey(lakeName, node);
    if (lakeKey && node[lakeKey]) {
      const b = read(node[lakeKey][s]);
      if (b) { owns.push({ key: k, band: b, lakeKey, lakeSpecific: true }); continue; }
    }
    for (const d of DEFAULTS) {
      const b = node[d] ? read(node[d][s]) : null;
      if (b) { owns.push({ key: k, band: b, lakeKey: d, lakeSpecific: false }); break; }
    }
  }
  if (owns.length) {
    const band = [Math.min(...owns.map((x) => x.band[0])), Math.max(...owns.map((x) => x.band[1]))];
    const named = owns.map((x) => x.key).join(' + ');
    // A species-wide default is not a lake-specific answer, and must not be dressed as one.
    const lakeSpecific = owns.every((x) => x.lakeSpecific);
    return clampToOxygen({
      band,
      basis: `built-in table, ${owns.map((x) => x.lakeKey).join(' / ')}`
           + `${owns.length > 1 ? ` — ${named} combined` : ''}`,
      generic: !lakeSpecific, source: 'table',
      // THE TABLE HAS NO ANSWER FOR THIS AND MUST NOT PRETEND TO. SPECIES_BEHAVIOR_V2 predates
      // the fish-depth/water-depth split entirely; its `preferredDepth` numbers were written
      // without anyone deciding which quantity they were. Stated as null rather than omitted so
      // the consumer sees an explicit "not known" instead of an absent key it might read as false.
      holding: null, waterDepthFt: null, sourceQuote: null,
    }, researched);
  }

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
  const across = keys.flatMap((k) => Object.keys(SPECIES_BEHAVIOR_V2[k])
    .map((lk) => read(SPECIES_BEHAVIOR_V2[k][lk] && SPECIES_BEHAVIOR_V2[k][lk][s]))).filter(Boolean);
  if (!across.length) return null;
  return clampToOxygen({
    band: [Math.min(...across.map((x) => x[0])), Math.max(...across.map((x) => x[1]))],
    basis: `${s} across the ${across.length} lakes in the built-in table — `
         + `${lakeName} has no researched profile and is not one of them`,
    generic: true,
    source: 'table-union',
    holding: null, waterDepthFt: null, sourceQuote: null,
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
/**
 * Every key in a species table that a picker name could mean.
 *
 * Exact first. Then containment either way, which is what makes "Hybrid" find
 * "White Bass / Hybrid" and "Catfish" find all three catfish. Returns ALL matches, because
 * collapsing three catfish to one on alphabetical order would be picking a fish for him.
 */
export function matchSpeciesKeys(table, species) {
  if (!table || !species) return [];
  if (table[species]) return [species];
  const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z]/g, '');
  const want = norm(species);
  if (!want) return [];
  return Object.keys(table).filter((k) => {
    const n = norm(k);
    return n === want || n.includes(want) || want.includes(n);
  });
}

export function researchedBand(profile, species, seasonKey) {
  const ti = profile && profile.trollingIntelligence;
  if (!ti || typeof ti !== 'object') return null;

  const hit = matchSpeciesKeys(ti, species)[0];
  if (!hit) return null;

  const node = (ti[hit] && ti[hit][seasonKey]) || null;
  const band = node && node.preferredDepth;
  if (!Array.isArray(band) || band.length !== 2) return null;
  const [a, b] = band.map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;

  return {
    band: [a, b],
    basis: `researched profile for this lake — ${hit}, ${seasonKey}`,
    generic: false,
    source: 'research',
    // ── THE THREE FIELDS THAT DECIDE WHICH WATER IS ELIGIBLE ──────────────────────────────
    //
    // `band` is where the FISH are. It is not the depth of the water, and every version of this
    // file before 2026-08-10 handed it downstream as though it were, which is how selectCandidates
    // came to compare a fish band against a contour's charted depth. See
    // claude/WHAT_SMARTPLAN_IS_2026-08-09.md, "fish depth is not water depth".
    //
    // `holding` is what makes the two separable: 'bottom' means the floor IS the target and the
    // water should match the band; 'suspended' means the fish are up in the column and any water
    // deeper than them will do, with no upper limit. The research pass populates it per lake and
    // per season, cited, which is the only reason this rule can be written at all.
    //
    // THIS IS ALSO WHERE THE WHITELIST BUG KEEPS COMING BACK. A normaliser that enumerates keys
    // is a whitelist whether or not it is written as one, and this function has silently dropped
    // every field but `preferredDepth` since it was written -- `holding` and `waterDepthFt` were
    // populated in the profile and simply never arrived. Anything added to the season node in
    // Worker/research/agents.js has to be named here too or it does not exist downstream.
    holding: normaliseHolding(node.holding),
    waterDepthFt: pairOrNull(node.waterDepthFt),
    // The sentence the numbers came from. Carried so a plan can say WHY it thinks the fish are at
    // 20 ft -- an uncited number and a sourced one look identical in JSON, and on Wateree the
    // striper 15-40 that turned out to be real and the bream 1-5 that turned out to be textbook
    // read exactly the same until the quote was there to check.
    sourceQuote: typeof node.sourceQuote === 'string' && node.sourceQuote.trim()
      ? node.sourceQuote.trim() : null,
    species: hit,
    season: seasonKey,
  };
}

/**
 * `holding` as one of the four things it is allowed to be, or null.
 *
 * TOLERANT ON THE WAY IN, STRICT ON THE WAY OUT. The value is written by a language model, so it
 * arrives as 'Suspended', 'bottom-relating', 'on the bottom' and worse. Coercing those is right.
 * INVENTING one is not: anything unreadable becomes null, and null is a question for Ryan rather
 * than a default, because the two rules cut in opposite directions and guessing wrong either
 * deletes the deep water suspended fish live over or offers water no bottom fish is on.
 */
export function normaliseHolding(v) {
  const s = String(v == null ? '' : v).toLowerCase().trim();
  if (!s) return null;
  if (/\bboth\b|either|mixed|some.*bottom.*some.*suspend|varies/.test(s)) return 'both';
  if (/suspend|water column|off the bottom|pelagic|open water/.test(s)) return 'suspended';
  if (/bottom|benthic|on the floor|hugging/.test(s)) return 'bottom';
  return null;
}

/** A [min, max] pair of finite feet, or null. Same shape rule as `preferredDepth`. */
function pairOrNull(v) {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [a, b] = v.map(Number);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? [a, b] : null;
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
  [/\bcoves?\b|\bpockets?\b|\bbasins?\b|\barms?\b/i, ['cove']],
  [/hump|offshore structure|sunken island|shoal|high spot/i, ['hump']],
  [/ledge|drop\s*-?\s*off|break\s*line|breakline|\bbluff/i, ['ledge']],
  [/timber|laydown|stump|brush|wood|treetop/i, ['timber', 'attractor']],
  [/attractor|fish habitat|reef ball|brush\s*pile/i, ['attractor', 'pile']],
  [/bridge|causeway|piling/i, ['bridge', 'pile']],
  [/\bdocks?\b|boat\s*house/i, ['dock_line', 'dock_cluster', 'dock']],
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
 * Phrases that map to nothing are RETURNED, not dropped, and the size of that pile is measured
 * rather than guessed: 3,036 structure phrases across 59 researched waters, 645 of them (21%)
 * still landing on no type as of 2026-08-26. What is left is not a regex problem — rock and
 * riprap (94 phrases), deep holes (66), weed and vegetation (53) and cypress (38) name real cover
 * that the CHARTPACK does not carry, so leading them here would raise a weight for a type nothing
 * emits. That gap stays in `unmatched`, in the open, where it can be counted.
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
        // pipeline never emits would look like it worked and do nothing — riprap and cypress are
        // named by 132 phrases between them and are recorded in `unmatched` rather than faked.
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
export function researchIntel(profile, species, season, now = Date.now()) {
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
  // This said "at least 29.4 ft" whenever the profile carried `averageDepthIsLowerBound`, which
  // existed because `be` was read as a band with no ceiling. It is not one -- it straddles a
  // 256 dm page line, so its ceiling byte reads 0. Every polygon has both ends, the mean is a
  // mean, and the hedge is gone with the flag. See the depth grammar in 00_START_HERE.md.
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
  const ti = profile.trollingIntelligence;
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
  return `Researched profile for this lake${verified ? ' (verified)' : ' (NOT yet verified — weigh accordingly)'}`
       + `${ageSentence(profile, now)}:\n`
       + out.map((l) => `- ${l}`).join('\n');
}

/**
 * THE DEPTH BAND, AS THE PROMPT HAS TO RECEIVE IT.
 *
 * Ryan, 2026-08-30, on a Pick Water day: "if the water is only 20 feet how is the target 20-25ft
 * ... this thing still has no understanding of suspended fish."
 *
 * Smart Plan built this object inline and it is the single most carefully written thing in that
 * file -- four branches that spell out, in words, what `holding` MEANS for the day. Pick Water
 * sent `{ ft, holding, meaning }`: the bare word "suspended" and no instruction attached to it.
 * Same class as `intel`, `hazards` and `snapEligible` earlier the same day, and the one with the
 * biggest consequence, because holding is the difference between "put the bait at the fish" and
 * "put the bait near the bottom".
 *
 * So it lives here, once, and both planners call it. `depth` is depthBandFor()'s return.
 */
export function describeDepthBand(depth, species, season) {
  const band = (depth && depth.band) || null;
  const holding = (depth && depth.holding) || 'unknown';
  const sp = species || 'the target';
  const se = season || 'this season';
  const lo = band ? band[0] : null, hi = band ? band[1] : null;

  // THE AMBIGUITY GOES ON THE PAGE, NOT INTO A THRESHOLD. Ryan, 2026-08-10, on what to do when
  // the research says fish are doing both: "is there a way to have that pointed out... maybe a
  // comment in the plan that says fish could be either hugging the bottom or suspended this time
  // of year... and then yeah use the suspended number."
  const note = holding === 'both'
    ? `The research says ${sp} are BOTH hugging the bottom and suspended on this water in ${se}. `
      + `Water was picked on the suspended rule, so some of these passes are deeper than the `
      + `fish. Say this in the plan and tell me to watch the sounder for which it is on the day.`
    : holding === 'suspended'
    ? `${sp} are suspended here in ${se}, so the water only has to be deeper than the fish — `
      + `depth of water is not the target, the ${lo}–${hi} ft the fish are holding at is.`
    : holding === 'bottom'
    ? `${sp} are on the bottom here in ${se}, so the depth of water IS the target — these passes `
      + `run through ${lo}–${hi} ft of water.`
    : `The research does not say whether ${sp} are on the bottom or suspended here in ${se}. `
      + `Water was picked by matching its depth to the band, which is only right if they are on `
      + `the bottom. Treat the depths as less certain than usual.`;

  return {
    ft: band,
    basis: (depth && depth.basis) || null,
    lakeSpecific: depth ? !depth.generic : false,
    meaning: 'where the fish are, not the depth of the water',
    holding,
    waterDepthFt: (depth && depth.waterDepthFt) || null,
    sourceQuote: (depth && depth.sourceQuote) || null,
    note,
  };
}

/**
 * WHAT THE RESEARCH SAYS WILL HURT YOU HERE.
 *
 * `buildPlanRequest` has read `o.hazards` for the SAFETY section since it was written and NO
 * CALLER HAS EVER FILLED IT -- not Smart Plan, not Pick Water. The sentence it guards ("there
 * are N marked hazard zones on this water") describes charted geometry, and no chartpack carries
 * a hazards layer: wateree_lake holds contours, depth_areas, docks, shoreline, hydrography,
 * pois, structure, trolling_runs, water_features, water_graph and waterbody. There is nothing
 * for it to count, which is why it never fired.
 *
 * The hazards this app actually holds are PROSE, in the research profile's navigation section,
 * put there by the agent whose targetFields are `navigation.ramps`, `navigation.hazards`,
 * `navigation.notes`. On Lake Wateree, SC they are a bridge replacement on S-20-101 and storm
 * activity near the dam. Both planners already load that profile.
 *
 * lake-intel.js reads `nav.navigationHazards` for the same briefing, and NOTHING IS FILED UNDER
 * THAT NAME -- the agent writes `navigation.hazards`, so the Lake Intelligence Briefing has been
 * printing no hazards for every lake that has some. Same bug as `preferredStructure` above, same
 * fix: the real field first, the guesses kept as alternates for older profiles.
 *
 * `drawdownNotes` comes along because lake-intel.js already counts it as a navigation hazard,
 * and one definition of the phrase beats three.
 */
export function researchHazards(profile) {
  const nav = (profile && profile.navigation) || {};
  const out = [];
  const push = (v) => {
    if (v === null || v === undefined) return;
    // An entry is a sentence or an object; lake-research-ui.js renders the same two shapes and
    // reads description/name/type off the object form, so those names come from a real profile
    // rather than from me.
    const t = String(typeof v === 'string' ? v
      : (v.description || v.name || v.text || v.hazard || v.type || '')).trim();
    if (!t) return;
    const loc = typeof v === 'object' && v && v.location ? ` (${String(v.location).trim()})` : '';
    const line = `${t}${loc}`;
    if (!out.includes(line)) out.push(line);
  };
  const raw = nav.hazards ?? nav.navigationHazards ?? (profile && profile.hazards);
  if (Array.isArray(raw)) raw.forEach(push); else push(raw);
  push(nav.drawdownNotes);
  return out;
}

/**
 * HOW OLD THE RESEARCH IS, in the one place that hands it to a model.
 *
 * `metadata.lastUpdated` has been written on every profile since storage.js was built, and THREE
 * places in the UI already show it to a person — lake-intel.js and two in lake-research-ui.js.
 * The plan path read the profile and never read its date, so a profile researched in March and
 * one from last week produced a byte-identical prompt.
 *
 * That matters more than it looks. The research pipeline bounds its current-fisheries-report
 * search to 45 days AT RESEARCH TIME, so that section is handed over as "current" however long
 * ago research actually ran. A model told the age writes a different, more honest plan; a model
 * told nothing cannot know to.
 *
 * A profile with no date gets said so too. Undated is not fresh.
 */
export function ageSentence(profile, now = Date.now()) {
  const raw = profile && profile.metadata && profile.metadata.lastUpdated;
  const t = raw ? Date.parse(raw) : NaN;
  if (!Number.isFinite(t)) return ', of unknown age — it carries no research date';
  const days = Math.max(0, Math.round((now - t) / 86400000));
  if (days <= 30) return `, researched ${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.round(days / 30);
  // THE SEASON IS THE THING THAT WENT STALE, not the calendar. Six-month-old research describes
  // a different water temperature, a different thermocline and different fish.
  return `, researched about ${months} month${months === 1 ? '' : 's'} ago (${days} days) — `
       + `treat anything it calls "current" as ${days > 120 ? 'a different season' : 'possibly out of date'}`;
}
