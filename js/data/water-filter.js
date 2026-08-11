/**
 * water-filter.js — one predicate, three surfaces, and a bias toward keeping things.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * Ryan: "the registry needs to shrink... if they have no bathymetry at all they are either
 * private or too small to worry about fishing... and very obscure." 1,746 entries, 833 of them
 * under fifty acres, and only 290 with a mapped ramp.
 *
 * And: "this needs to apply to waters that we get from dnr and not the registry as well" — which
 * is why the predicate lives here rather than in a dropdown. DNR waters never touch the registry;
 * `access-index.js` merges them live from the Worker's /ramps and /paddle routes. A registry-side
 * filter would not touch one of them.
 *
 * `lake-ramp-select.js` already had a working filter — state, size band, has-ramp, well-charted,
 * with a live count and per-lake badges, tested against a mock registry. It was welded to
 * `#lakeSelect`, the map toolbar, which is the one dropdown that needed it least. This is that
 * logic pulled out and given presets.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE THREE THINGS THAT MAKE THIS HARDER THAN A FILTER
 *
 * 1. `charted` HAS THREE STATES AND ONE OF THEM IS "NOBODY LOOKED".
 *
 *    699 entries are nonzero, 995 are zero, and 52 are NULL — including all 22 coastal zones,
 *    which were not rows in registry/lakes.json when recompute_charted.py last ran. Reading null
 *    as false deletes the entire coast. `null` means unmeasured, and the only safe reading of
 *    unmeasured is KEEP.
 *
 * 2. SOME ENTRIES HAVE NO PACK, AND THAT IS A BUILD GAP, NOT AN ALIAS.
 *
 *    I wrote here that `bates_old_river_sc` "has no pack and never should" because its water is
 *    inside `congaree_river`. That was false, and Ryan called it what it was:
 *
 *      > bates river is an oxbow off of the congaree completely separate water... that is like
 *      > saying lake wateree isn't its own water because the wateree river connects to it
 *
 *    An oxbow is water CUT OFF from the river — that is what makes it an oxbow. It falls inside
 *    the Congaree pack's bounding box and that says nothing at all about whether it is the same
 *    water. Bates needs its own pack; nobody has built one.
 *
 *    So there is no clever containment test to write here. "Has bathymetry" and "has a pack" are
 *    different questions, and the gap between them is a BUILD LIST, not something a predicate can
 *    resolve away. Waters in that gap are kept — see KEEP_ALWAYS — and the fix is to extract
 *    them, not to redefine them as part of a neighbour.
 *
 * 3. AN UNRESOLVED WATER IS KEPT.
 *
 *    A DNR water that fails to match a registry row looks exactly like a water that deserves
 *    cutting. access-index.js already carries three layers of fuzzy matching precisely because
 *    the names do not line up. Silence must not delete anything.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * AND THE PRECEDENT THAT SHOULD GOVERN EVERY DEFAULT HERE
 *
 * The first cut of the map filter defaulted to `ACCESS_OPEN` and hid Wittee Lake and Ferry Lake —
 * the two lakes that motivated building it. "Hiding the two lakes that motivated this entire
 * exercise would have been worse than shipping no filter."
 *
 * So `KEEP_ALWAYS` below is not a convenience. It is the test that a preset has not eaten the
 * water the app exists for.
 */

/**
 * TRUTHY IN A WAY THAT SURVIVES CROSSING LANGUAGES.
 *
 * `ramps` in the registry is an ARRAY. Python's `bool([])` is False and JavaScript's `Boolean([])`
 * is TRUE, so the same field over the same file reported 290 waters with a ramp from a Python
 * probe and 1,746 from this module — and `registryCut` therefore kept all 1,746 and dropped
 * nothing while reporting a clean pass.
 *
 * It is the quietest class of bug in this project: not a wrong answer, an answer that agrees with
 * itself in one language and disagrees across the boundary. Both halves of this app read the same
 * registry.
 */
function has(v) {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === 'object') return Object.keys(v).length > 0;
  return Boolean(v);
}

/** Tri-state, because the two-state reading of this field is what deletes the coast. */
export function chartedState(rec) {
  if (!rec) return 'unknown';
  const v = rec.charted;
  if (v === null || v === undefined) return 'unknown';
  return Number(v) > 0 ? 'yes' : 'no';
}

/**
 * WATER THAT MUST NEVER BE HIDDEN, whatever a preset says.
 *
 * Matched loosely on purpose — a registry display name carries a county and a state suffix
 * ("Wateree Lake (Kershaw Co, SC)") and the same water arrives from DNR without them.
 */
export const KEEP_ALWAYS = [
  'wateree lake', 'lake marion', 'lake moultrie', 'monticello reservoir', 'lake murray',
  'congaree river', 'lower saluda river', 'broad river', 'bates old river',
  'wateree river', 'santee river',
];

/**
 * MATCHED AGAINST THE NAME ONLY, WITH THE COUNTY SUFFIX STRIPPED FIRST.
 *
 * The first version matched bare tokens as substrings — 'marion', 'murray', 'lanier' — against
 * the full display name. Registry names carry a county: "Chapman Lake (Marion Co, GA)",
 * "Coosawattee River (Murray Co, GA)", "Carter Lake (Lanier Co, GA)". So 24 unrelated waters
 * matched the keep-list, `registryCut` kept all 1,746 and dropped NOTHING, and it looked like the
 * rule was simply generous rather than broken.
 *
 * A safety list that silently swallows the thing it is protecting against is worse than no list:
 * it cannot fail loudly, and this one reported a clean pass over a cut that never happened.
 */
export function isKeepAlways(name) {
  const n = String(name || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')   // "(Kershaw Co, SC)" — county and state live in here
    .replace(/,.*$/, '')           // and here, when there are no parentheses
    .replace(/\s+/g, ' ')
    .trim();
  return KEEP_ALWAYS.some((k) => n === k || n.startsWith(k + ' ') || n.endsWith(' ' + k));
}

/**
 * NO CONTAINMENT TEST. THIS FIELD IS FOR GENUINE DUPLICATES ONLY.
 *
 * The registry does hold true duplicates — there are two `Congaree River (to SC-601)` entries, one
 * charted and one not — and a pipeline pass can reconcile those and stamp `covered_by`.
 *
 * It is NOT for waters that merely sit inside another pack's bounds. I tried that: a bounding-box
 * containment test took the charted count from 699 to 1,336, "resolving" 637 waters, most of which
 * are simply farm ponds inside a big lake's box. And even a correct point-in-polygon would have
 * been wrong in principle, because Bates Old River is an oxbow — separate water that needs its own
 * extraction, not a name for the Congaree.
 *
 * Absent field means no duplicate was found, which is the normal case.
 *
 * THE BODY UNDER THIS COMMENT WAS NEVER WRITTEN. The docstring landed and the function did not,
 * and because nothing in the app imported this module the gap was invisible: `makePredicate()`
 * threw `ReferenceError: coveredBy is not defined` on the first record whose `charted` was 0 —
 * which is to say it had never once been executed. Found 2026-08-11 by COUNTING the research cut
 * rather than by reading it, thirty seconds after wiring it into the research picker.
 *
 * Same shape as the palette regression in 00_START_HERE: the half of a change most likely to be
 * lost is not the new file, it is everything around it.
 */
function coveredBy(rec) {
  if (!rec) return null;
  const v = rec.covered_by ?? rec.coveredBy ?? null;
  return v ? String(v) : null;
}

/**
 * Does this water have bathymetry?
 *
 * 'yes' | 'no' | 'unknown'. `unknown` is a real answer and callers must not collapse it.
 */
export function hasBathymetry(rec) {
  const own = chartedState(rec);
  if (own !== 'no') return own;          // yes, or unknown — both stand on their own
  // Only a reconciled DUPLICATE counts here. A water that is merely near a charted pack is its
  // own water and its own build job.
  return coveredBy(rec) ? 'yes' : 'no';
}

/**
 * THE PRESETS.
 *
 * Each is a question a surface is actually asking, not a severity level.
 */
export const PRESETS = {
  /**
   * The map. Unchanged behaviour: show what is reachable, hide almost nothing. The toolbar is
   * for looking at water, and looking is free.
   */
  map: {
    label: 'Reachable water',
    /**
     * "ANY OF THE BARS" — Ryan said it twice and the first cut of this preset ignored him.
     *
     *   > i dont think we need to display all of those lakes in any of the bars if they have no
     *   > bathymetry at all they are either private or too small to worry about fishing
     *   > ... and this needs to apply to waters that we get from dnr and not the registry as well
     *
     * This used to be `keep: () => true` on my own reasoning that "looking is free". That was me
     * deciding what the map was for. What he asked for is a bar without 900 farm ponds in it.
     *
     * `unknown` still passes — 52 rows are null, including all 22 coastal zones, and unmeasured is
     * not the same as empty. Only a measured zero is dropped.
     */
    keep: (rec, { bath, isCoastal }) => isCoastal || bath !== 'no',
    keepUnresolved: false,
  },

  /**
   * The planner. You cannot plan a trolling day on water with no contours and nowhere to launch,
   * so anything else in this list is a dead end you have to click to discover.
   *
   * `unknown` bathymetry still passes if there is a ramp — an unmeasured lake with a launch is a
   * question, not a no.
   */
  planner: {
    label: 'Water you can plan a day on',
    keep: (rec, { bath, hasRamp }) => (bath === 'yes' && hasRamp)
                                   || (bath === 'unknown' && hasRamp),
    /**
     * A water the registry cannot identify has no chartpack, so the planner cannot plan it — it
     * is exactly the "dead end you have to click to discover" this preset exists to remove. The
     * DNR feeds put 424 of those in the list; `#planLake` had no filter of any kind on it.
     */
    keepUnresolved: false,
  },

  /**
   * Research. Ryan: a filter "mainly for coastal and large impoundments lakes that are actually
   * researchable".
   *
   * Size is a PROXY and a poor one — what makes a water researchable is whether anyone has
   * written about it, and a 400-acre lake with a tournament circuit beats a 2,000-acre one
   * nobody fishes. It is the best proxy available until the research pass itself reports back,
   * and its confidence score is the thing that should eventually replace this.
   */
  research: {
    label: 'Worth researching',
    minAcres: 1000,
    includeRivers: false,

    /**
     * AN UNRESOLVED WATER IS DROPPED HERE, AND ONLY HERE.
     *
     * `makePredicate` keeps a record it cannot resolve, on the reasoning that a failure to match
     * is indistinguishable from a water that deserves cutting. That is right for the map, where
     * looking is free — and wrong for this one, which is a work list that spends Firecrawl
     * credits. 424 of the 1,196 pickable names carry no registry record at all (his own console:
     * "772 of 1196 pickable lake names carry a registry record"), so under the blanket rule every
     * one of them passed regardless of size, and the filtered list still ran past six hundred.
     * A water the registry cannot even identify is precisely the one with nothing written about
     * it. isKeepAlways() still runs first, so nothing he fishes can be dropped this way.
     */
    keepUnresolved: false,

    /**
     * RIVERS ARE THEIR OWN QUESTION AND ACREAGE CANNOT ANSWER IT.
     *
     * Ryan, 2026-08-11: "almost all rivers are over 1000 acres but not sure about researching
     * them". He is right, and the number is worse than unhelpful — a river's acreage is the area
     * of a RIBBON, so it measures length, not whether anyone writes about the fishing. The 72
     * that passed included the Savannah, the Great Pee Dee and the Congaree beside Judd Slough
     * and Richland Creek, plus two that are simply wrong: the Mississippi at 163,923 acres in TN,
     * and Reelfoot Lake typed as a river.
     *
     * The research agents also ask lake questions — thermocline, forage, structure — where a
     * river's answers are flow, gauge and shoals. So rivers are off by default and behind their
     * own switch, his call. KEEP_ALWAYS still carries the Congaree, the Wateree, the Broad, the
     * Santee and the Lower Saluda through regardless, because those are waters he fishes.
     */
    keep: (rec, { bath, isCoastal, isRiver, acres }, cfg) => {
      if (isCoastal) return true;
      if (isRiver && !cfg.includeRivers) return false;
      return bath !== 'no' && acres >= (cfg.minAcres ?? 1000);
    },
  },
};

/**
 * Build a predicate for one surface.
 *
 * @param {string}   presetName  key of PRESETS
 * @param {object[]} records     the whole registry, for bounds resolution
 * @param {object}   [cfg]       overrides, e.g. { minAcres: 500 }
 * @returns {function(object=, string=): boolean}  (record, displayName) => keep?
 */
export function makePredicate(presetName, records, cfg = {}) {
  const preset = PRESETS[presetName] || PRESETS.map;
  const merged = { ...preset, ...cfg };

  return function keep(rec, displayName) {
    const name = displayName || (rec && (rec.display_name || rec.name)) || '';
    // Never hide the water the app exists for. Checked FIRST so no preset can reach past it.
    if (isKeepAlways(name)) return true;
    // An unresolved water — DNR sends plenty — cannot demonstrate anything, and a failure to
    // match is indistinguishable from a water that deserves cutting. Keep it, UNLESS the preset
    // says otherwise: see `keepUnresolved` on the research preset for why that one differs.
    if (!rec) return merged.keepUnresolved !== false;

    const bath = hasBathymetry(rec);
    // THE FILE IS snake_case AND THE APP IS camelCase, AND THIS READ ONLY ONE OF THEM.
    //
    // Ryan, 2026-08-11: "your river filter isn't working in research..." It was not, and nothing
    // I had measured could have shown it. `lake-registry.js` normalises every row on load —
    // `area_acres` becomes `areaAcres`, `ramp_sources` becomes `rampSources`, and
    // `feature_type` becomes **featureType** — so the record `registryRecordFor()` hands back is
    // NOT the shape of `registry/lake_index.json`.
    //
    // `rec.feature_type === 'river'` is therefore always false in the browser, and every river
    // sailed through the switch that was supposed to hold it back. `isCoastal` was broken the same
    // way and only survived because the `coast_` slug test carries it.
    //
    // I counted 141 / 203 / 260 / 751 straight off the JSON file, which is snake_case, so every
    // number I quoted was right about the file and wrong about the app. That is the trap
    // 00_START_HERE names in as many words: describe HIS machine, not this one. Both spellings
    // are read now, and the test uses a camelCase record because that is what the app produces.
    const pick = (a, b) => (rec[a] !== undefined ? rec[a] : rec[b]);
    const type = pick('feature_type', 'featureType');
    const facts = {
      bath,
      hasRamp: has(rec.ramps) || has(rec.ramp_sources) || has(rec.rampSources),
      isCoastal: type === 'coastal' || String(rec.slug || '').startsWith('coast_'),
      isRiver: type === 'river',
      acres: Number(pick('area_acres', 'areaAcres') || 0),
    };
    return Boolean(merged.keep(rec, facts, merged));
  };
}

/**
 * The registry cut itself — what would survive a prune, and what would go.
 *
 * Rule D from claude/SHRINKING_THE_REGISTRY_2026-08-11.md: charted, or coastal, or has a ramp, or
 * is a river. Keeps 843 of 1,746 and everything Ryan has named.
 *
 * Returns both halves. A deletion that cannot say what it removed is not reviewable, and this one
 * is derived from a flag that has been wrong twice.
 */
export function registryCut(records, cfg = {}) {
  const keep = [], drop = [];
  for (const rec of (records || [])) {
    const name = rec.display_name || rec.name || '';
    const bath = hasBathymetry(rec);
    const isCoastal = rec.feature_type === 'coastal' || String(rec.slug || '').startsWith('coast_');
    const survives = isKeepAlways(name)
                  || bath !== 'no'
                  || isCoastal
                  || has(rec.ramps) || has(rec.ramp_sources) || has(rec.rampSources)
                  || rec.feature_type === 'river'
                  || Number(rec.area_acres || 0) >= (cfg.minAcres ?? Infinity);
    (survives ? keep : drop).push(rec);
  }
  return { keep, drop };
}
