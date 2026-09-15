/**
 * seabed-habitat.js — what this fish wants off the bottom, and what this zone's bottom IS.
 *
 * TWO REGISTRIES, ONE QUESTION, AND NEITHER IS AN ANSWER ALONE.
 *
 * `species_habitat_weights.json` is the South Atlantic habitat matrix: every species scored
 * against six structure classes and seven substrate classes, BY LIFE STAGE. It says a sheepshead
 * wants hard bottom at 3.5 and fine at 1.0, and a red drum the other way round.
 *
 * `enc_seabed_by_zone.json` is what NOAA's ENC cells label the bottom as, per coastal zone, in
 * the SAME substrate vocabulary. It says Charleston's 270 charted seabed features are 212 fine,
 * 15 shell and 3 hard.
 *
 * Separately each is a column of numbers. Together they are a sentence: a sheepshead's preferred
 * bottom is the rarest thing the chart labels in this zone, so it has to be met by STRUCTURE --
 * the 281 pilings, 138 bridges and 88 rip-rap runs the same file counts -- rather than by seabed.
 * That is the whole reason they are read in one module and printed in one block.
 *
 * Both were built 2026-09-03 and read only by `Worker/research/agents.js`. By the standing test --
 * a fact counts when it reaches buildPlanRequest() -- neither counted.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: lead the leg ranker. The matrix's six structure classes are
 * `channel_edge, creek_mouth, dock_piling, grass_flat, marsh_edge, oyster`, and the trolling runs
 * in a COASTAL pack carry `hump, pile, hazard, point, cove, obstruction, creek_mouth` in `near[]`
 * plus the four relief kinds. Measured on coast_charleston_sc, 2026-09-15: 11,939 runs, and not
 * one `marsh_edge`, `oyster`, `grass_flat` or `dock_piling` mark among them. Two of the six
 * classes can reach the ranker and four cannot, and the two that cannot are the two the matrix
 * rates highest for every inshore species in the roster. structureWeights() already states the
 * rule this obeys: "Inventing a weight for a type the pipeline never emits would look like it
 * worked and do nothing." Closing that gap is a pipeline join, not an app read, and it is written
 * up rather than faked. So this travels to the MODEL, which chooses among the legs the ranker
 * offers and can be told what the fish wants on them.
 *
 * A COUNT OF CHARTED FEATURES IS NOT A FRACTION OF THE BOTTOM. The ENC numbers are how many
 * polygons the chart labels with a given substrate, which is a fact about the CHART. Every zone
 * on this coast comes back dominated by `fine`, so the number discriminates between SPECIES on
 * one zone and barely at all between zones. The block says both halves of that.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 */

import { registryLoader } from './registry-loader.js';

export const HABITAT_PATH = '/chartpacks/_registry/species_habitat_weights.json';
export const SEABED_PATH = '/chartpacks/_registry/enc_seabed_by_zone.json';

const _habitat = registryLoader(HABITAT_PATH,
  (p) => p && p.species && typeof p.species === 'object' && p.species);
const _seabed = registryLoader(SEABED_PATH,
  (p) => p && p.zones && typeof p.zones === 'object' && p.zones);

/**
 * Warm both tables. NEVER THROWS, and one failing does not take the other down: the matrix is
 * regional and the seabed is per zone, built by different scripts on different days, and a zone
 * with a matrix answer and no chart answer is a real state worth half a block.
 */
export async function primeSeabedHabitat(opts = {}) {
  const [h, s] = await Promise.all([_habitat.prime(opts), _seabed.prime(opts)]);
  return { habitat: !!h, seabed: !!s };
}

export function seabedHabitatPrimed() { return { habitat: _habitat.primed(), seabed: _seabed.primed() }; }
export function _resetSeabedHabitat() { _habitat.reset(); _seabed.reset(); }

/** Highest first, and only what the matrix actually rated. A 0.0 is a rating, not an absence. */
function ranked(obj) {
  if (!obj || typeof obj !== 'object') return [];
  return Object.entries(obj)
    .filter(([, v]) => Number.isFinite(Number(v)))
    .map(([k, v]) => ({ key: k, rank: Number(v) }))
    .sort((a, b) => b.rank - a.rank || a.key.localeCompare(b.key));
}

/**
 * The matrix row for this species.
 *
 * THE MATRIX CARRIES ITS OWN NAMES AND SO DOES THE PLAN FORM. `matrixNames` is the join the
 * builder already wrote -- `Red Drum (Redfish)` holds `["Red Drum"]` -- so the key is tried first
 * and the aliases second. A containment test would match `Black Drum` inside nothing and
 * `Red Drum` inside `Black Drum`'s row on a bad day; exact keys do not have that problem.
 */
function matrixRowFor(species) {
  const table = _habitat.get();
  if (!table) return null;
  const want = String(species || '').trim().toLowerCase();
  if (!want) return null;
  for (const [key, entry] of Object.entries(table.species || {})) {
    if (key.trim().toLowerCase() === want) return { key, entry };
    const aliases = Array.isArray(entry && entry.matrixNames) ? entry.matrixNames : [];
    if (aliases.some((a) => String(a).trim().toLowerCase() === want)) return { key, entry };
  }
  return null;
}

/**
 * What the two tables say together, for this coastal zone and this fish.
 *
 * @param {string} zoneKey  a `coast_*` slug, from detectCoastalZone()
 * @param {string} species  the plan form's species name
 * @returns {null|{zone, species, matrixName, rankScale, stages, bottom, chartStructure,
 *                 restricted, wantsRare, features}}
 *          null when neither half can speak. Either half alone still returns.
 */
export function seabedHabitatFor(zoneKey, species) {
  const row = matrixRowFor(species);
  const seabedTable = _seabed.get();
  const zone = (zoneKey && seabedTable && seabedTable.zones) ? seabedTable.zones[zoneKey] : null;
  if (!row && !zone) return null;

  // THE STAGES ARE KEPT APART, AND THAT IS THE POINT OF THE FILE. Red drum rate marsh edge 4.0
  // as juveniles and 2.0 as adults; a reader that takes the strongest number across stages makes
  // every adult weight too strong. Ryan's slot fish is 18-25 inches and whether that is an adult
  // is a question about the fish, not about this table -- so every stage the matrix carries is
  // handed over labelled, and nothing here collapses them.
  const stages = {};
  for (const [stage, v] of Object.entries((row && row.entry.structures) || {})) {
    stages[stage] = { ...(stages[stage] || {}), structures: ranked(v) };
  }
  for (const [stage, v] of Object.entries((row && row.entry.substrates) || {})) {
    stages[stage] = { ...(stages[stage] || {}), substrates: ranked(v) };
  }

  const bottom = ranked(zone && zone.bySubstrate);
  const adultSubs = (stages.adult && stages.adult.substrates) || [];

  // THE SENTENCE THE TWO TABLES MAKE. The fish's top-rated bottom, measured against how much of
  // that bottom the chart actually labels here. `null` when either half is missing -- an absence
  // must not read as "the bottom it wants is not here", which is a much stronger claim.
  let wantsRare = null;
  if (adultSubs.length && bottom.length) {
    // A TIE AT THE TOP IS A TIE, NOT A WINNER. `ranked` breaks ties alphabetically so it can
    // return a list; picking [0] and calling it "what this fish wants" would turn seatrout's
    // fine-2/shell-2 into a preference for fine, which the matrix never states.
    const best = adultSubs[0].rank;
    const tops = adultSubs.filter((x) => x.rank === best);
    const total = bottom.reduce((s, b) => s + b.rank, 0);
    const charted = tops.reduce((s, t) => s + ((bottom.find((b) => b.key === t.key) || {}).rank || 0), 0);
    wantsRare = {
      wants: tops.map((t) => t.key),
      rating: best,
      // MEDIUM IS NOT A PREFERENCE. When the best bottom rating a fish carries is 2.0 or less the
      // matrix is saying the bottom does not decide this fish -- seatrout tops out at Medium on
      // every substrate and at Very High on grass flat and marsh edge. Reporting "wants fine" off
      // a 2.0 would put the emphasis on the half that does not matter.
      weak: best <= 2,
      chartedFeatures: charted,
      chartedTotal: total,
      // "scarce" is measured, not judged: under a tenth of what the chart labels here.
      scarce: charted * 10 < total,
      dominant: bottom[0].key,
    };
  }

  return {
    zone: zoneKey || null,
    species,
    matrixName: row ? row.key : null,
    rankScale: (_habitat.get() || {}).rankScale || null,
    region: (_habitat.get() || {}).region || null,
    stages,
    bottom,
    features: zone ? Number(zone.features) || 0 : 0,
    seabedFeatures: zone ? Number((zone.byKind || {}).seabed) || 0 : 0,
    // THE HARD STRUCTURE THE SEABED DOES NOT CARRY. A sheepshead wanting hard bottom in a zone
    // whose chart labels three hard-bottom polygons is not out of luck -- it is on the pilings.
    // Trimmed to the six biggest, because a list of eleven counts reads as inventory rather than
    // as an argument for where to fish.
    chartStructure: ranked(zone && zone.byKind).filter((k) =>
      ['piling', 'bridge', 'wreck', 'rock', 'obstruction'].includes(k.key))
      .concat(ranked(zone && zone.byCategory).filter((c) =>
        ['pier', 'rip_rap', 'groyne', 'breakwater', 'sea_wall', 'wharf'].includes(c.key)))
      .sort((a, b) => b.rank - a.rank).slice(0, 6),
    // Counts only. We hold no shapes for these, and a plan that implied otherwise would be
    // navigating on a number.
    restricted: zone && zone.blocksUs ? ranked(zone.blocksUs) : [],
    wantsRare,
  };
}
