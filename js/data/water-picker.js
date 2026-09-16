/**
 * WHICH WATERS A PICKER OFFERS, AND WHAT EACH ONE IS. One answer for every tab.
 *
 * Ryan, 2026-09-15: "why are there different pickers... shouldn't all 3 tabs have the ability to
 * show the exact same picker?" and "i want the exact same 355 bodies of water to be possible in the
 * picker but filtered as appropriate."
 *
 * There were three builders. The map bucketed by state and by what the registry says a water IS.
 * The planner had one "Lakes" group holding every inland name plus a hardcoded six-row "Rivers /
 * Tailwaters" group, so the other 52 river rows -- Edisto, Cooper, Catawba, Black River, Great Pee
 * Dee -- sat under "Lakes", and those six carried a `river:` value scheme nothing outside
 * plan-builder.js understood. Research built a third.
 *
 * The FILTER was already shared, in water-filter.js, one preset per surface, and those differences
 * are real: looking is free on the map, you cannot plan a day on water with no ramp, research wants
 * water worth writing about. The RENDERING was not shared, and all three of the picker defects
 * found on 2026-09-15 lived in that duplication.
 *
 * WHY THIS FILE EXISTS RATHER THAN LIVING IN lake-ramp-select.js, where it was first written: that
 * module imports contour-data.js, which touches Leaflet at load. Moving the picker question into it
 * made plan-builder.js require a map to be tested, and two suites that could import plan-builder
 * stopped being able to. A question about which waters exist has no business needing a renderer.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 */
import { getLoadedAccessIndex, registryRecordFor } from './access-index.js';
import { COASTAL_ZONES, isCoastalKey, coastalNamesByState } from './coastal-zones.js';
import { resolveR2Key } from './lake-keys.js';

export const STATE_ORDER = ['SC', 'NC', 'GA', 'TN'];
// Lakes, rivers, coast — within each state. Ryan, 2026-08-08: "i want lakes then rivers then
// coastal for each state... i actually don't like how it is now."
export const TYPE_ORDER = [['lake', 'Lakes'], ['river', 'Rivers'], ['coastal', 'Coast']];

const RIVERISH = /\b(river|creek|branch|run|fork|canal|slough|bayou|prong|swamp)\b/i;

/** SC / NC / GA / TN for any picker entry, registry-backed or not. */
/**
 * What a row READS as, once the heading has said everything it already says.
 *
 * The group is "SC — Coast", so "Winyah Bay / Georgetown, SC (Georgetown Co, SC)" says SC three
 * times. This used to strip only a trailing ", SC", which the county parenthetical defeats --
 * so registry rows kept their county while DNR rows did not, and the same group held two shapes.
 *
 * ONLY THE PARENTHETICAL CARRYING "Co" IS REMOVED, and that is the whole trick. Four Saluda
 * Rivers are told apart by "(2)" and "(Lower Saluda)", the two Lake Robinsons by "(Greer)", and
 * a Cane Creek Lake by "(Union County)" -- none of which is a county abbreviation, and all of
 * which survive. Checked across the whole index: exactly one pair would render identically
 * inside one state group, and it is the Robinson pair that lake_display_names.json renames.
 *
 * This is display only. `opt.value` stays the full name, because that is the key every other
 * module looks the water up by.
 */
export function pickerLabel(name) {
  return String(name || '')
    .replace(/\s*\([^)]*\bCo\b[^)]*\)\s*/i, ' ')
    .replace(/,\s*[A-Z]{2}(?:\/[A-Z]{2})*\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * THE ORDER OF A GROUP IS THE ORDER OF WHAT IT SAYS, NOT THE ORDER IT WAS COLLECTED IN.
 *
 * Ryan, 2026-09-04, on Richard B Russell: "its at the bottom of the SC list not alphabetically
 * where it should have been."
 *
 * The buckets were rendered in PUSH order and never sorted. That was invisible for every water
 * whose name agrees with its registry about which state it is in, and it is exactly wrong for the
 * ones that do not:
 *
 *   access-index.js sorts `lakeNames` with lakeStatePriority(), which reads the state off the
 *   NAME's suffix -- so "Lake Richard Russell, GA" sits in the GA run, after every SC name.
 *
 *   buildLakeSelect() buckets with stateOf(name, rec), which reads the state off the REGISTRY
 *   RECORD -- and richard_b_russell_lake is "Richard B Russell Lake (Abbeville Co, SC/GA)", so
 *   the row lands in SC.
 *
 * Sorted by one notion of state, grouped by another. The row is placed in the right group and
 * arrives after everything already in it: bottom of "SC — Lakes", under a label reading "Lake
 * Richard Russell", which is neither where it belongs nor anywhere a person would look.
 *
 * Sorted on pickerLabel() and not on the raw name, because the label is the string on screen and
 * a list whose visible order does not match its visible text is the same bug wearing a different
 * hat. The raw name breaks ties so the order is stable when two waters read alike.
 *
 * Fixes the class, not the lake: any water whose registry state and name suffix disagree had this,
 * and eleven rows in lake_index carry a two-state suffix.
 */
export function sortForDisplay(names) {
  return [...(names || [])].sort((a, b) =>
    pickerLabel(a).localeCompare(pickerLabel(b), undefined, { numeric: true, sensitivity: 'base' })
    || String(a).localeCompare(String(b)));
}

export function stateOf(lakeName, rec) {
  if (rec?.state) return rec.state;
  // Every DNR name gets a ", SC" suffix from displayLakeName(), and coastal zone names carry
  // one too. That is the only state signal a registry-less entry has, and it is reliable
  // because the feeds are fetched per state.
  const m = /,\s*([A-Z]{2})\s*$/.exec(String(lakeName || ''));
  return m ? m[1] : null;
}

/**
 * lake / river / coastal.
 *
 * `feature_type` is authoritative and comes from the registry — 1,471 lakes, 229 rivers, 22
 * coastal across the index. For an entry with no registry row there is nothing to read, so the
 * NAME is used, and only to decide which heading it sits under. It is a display grouping, not a
 * claim about the water: putting Enoree River under "Lakes / Reservoirs" is the thing being
 * fixed, and guessing from the word "River" is strictly better than that.
 */
export function typeOf(lakeName, rec) {
  if (isCoastalKey(resolveR2Key(lakeName))) return 'coastal';
  if (rec?.featureType) return rec.featureType;
  return RIVERISH.test(String(lakeName || '')) ? 'river' : 'lake';
}

/**
 * True if a picker entry survives the current filters.
 *
 * AN ENTRY THE FILTER CANNOT ANSWER FOR NOW FAILS THAT FILTER. It used to pass everything:
 * `if (!rec) return true`. Ryan, 2026-08-08: "if i choose >1000 acres i still get tiny little
 * mill ponds that do not have contours because they are only being fed by DNR list." Adams Grist
 * Mill Lake, Biggin Creek, Buggy Branch and Horseshoe Creek have no registry row at all, so
 * nothing knows their size — and they were showing under "over 1000 acres" regardless.
 *
 * State and has-ramp ARE answerable without a registry row: the state comes off the name suffix
 * and the ramps are counted from the live access index, which is the same data the Access
 * dropdown under it is built from. Only size and charted are unanswerable, and those are exactly
 * the two that now exclude.
 *
 * This is the second attempt at this bug — see the pass-1 note in access-index.js, which fixed
 * the 641 lakes that HAD a registry row the lookup could not find. What is left after that fix
 * is the genuinely registry-less, and this is what to do about them.
 */
/**
 * THE ROWS A WATER PICKER OFFERS, BUCKETED BY STATE AND TYPE. One builder for every tab.
 *
 * Ryan, 2026-09-15: "i want the exact same 355 bodies of water to be possible in the picker but
 * filtered as appropriate."
 *
 * There were three builders. The map bucketed by `stateOf` x `typeOf`, which asks the registry
 * what a water IS. The planner had a "Lakes" group holding every inland name plus a hardcoded
 * six-row "Rivers / Tailwaters" group, so the other 52 river rows in the registry sat under
 * "Lakes" -- Edisto, Cooper, Catawba, Black River, all of them -- and the six carried a `river:`
 * value scheme nothing outside plan-builder.js understood. Research built a third.
 *
 * The FILTER was already shared: makePredicate() and the presets in js/data/water-filter.js, one
 * question per surface, and those differences are real. The RENDERING was not, and every one of
 * the three name/type/value defects found on 2026-09-15 lived in that duplication.
 *
 * So `keep` is the only thing a caller varies. Everything else -- which waters exist, what each
 * one is, which state it is in, how the groups are ordered -- is answered once, here.
 *
 * COASTAL ZONES COME THROUGH THE INDEX, not from a second source. lake_index.json carries all 13
 * `coast_` rows with 14 to 72 ramps each, so the registry merge already puts every one of them in
 * `byLake`. The fallback loop below exists only for a zone the registry has not shipped, and it
 * is skipped for anything already emitted -- which is the double-listing Ryan reported on
 * 2026-08-23: "A whole bunch of coastal areas are in the picker twice."
 *
 * `opts.index` IS INJECTED FOR THE SAME REASON ndbcReadings() takes its own fetcher: so this can
 * be run in a test without standing up the app. That is not a nicety here -- this function shipped
 * once with the map's entire render loop still inside it, `node --check` passed because render code
 * is valid JavaScript anywhere, and nothing called it until both pickers threw on a live page.
 *
 * @param {(rec:object|null, name:string) => boolean} keep  the surface's own predicate
 * @param {{coastalFilters?: object, index?: object}} opts  the map's toolbar state, when there is
 *        one, and an access index to read instead of the loaded one
 * @returns {Map<string, string[]>} `${state}|${type}` -> names
 */
export function bucketWaters(keep, opts = {}) {
  const idx = opts.index || getLoadedAccessIndex();
  const f = opts.coastalFilters || null;
  const buckets = new Map();          // `${state}|${type}` -> string[]
  const put = (state, type, name) => {
    if (!state) return;
    const k = `${state}|${type}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(name);
  };

  const emittedCoastal = new Set();
  (idx?.lakeNames || []).forEach((lakeName) => {
    const rec = registryRecordFor(lakeName);
    if (!keep(rec, lakeName)) return;
    const slug = rec?.slug || resolveR2Key(lakeName);
    if (slug && isCoastalKey(slug)) emittedCoastal.add(slug);
    put(stateOf(lakeName, rec), typeOf(lakeName, rec), lakeName);
  });

  // ── COASTAL ZONES, ONCE EACH ────────────────────────────────────────────────────────────
  //
  // The comment that stood here said "coastal zones are not in the access index — the worker
  // only covers inland DNR ramps". That was true when it was written and has not been true for
  // a while: `lake_index.json` carries all 16 `coast_` rows, so the registry merge puts every
  // one of them into `byLake`, and COASTAL_MANUAL_RAMPS adds zone names there directly too.
  //
  // So this loop was adding a SECOND row for every zone, under a different spelling of the same
  // water. Ryan, 2026-08-23: *"A whole bunch of coastal areas are in the picker twice but they
  // all seem to have bathymetry"* -- both rows resolve, because both are the same zone.
  //
  //   registry:      "Winyah Bay / Georgetown, SC (Georgetown Co, SC)"
  //   COASTAL_ZONES: "Winyah Bay / Georgetown, SC"
  //
  // Murrells Inlet and St. Helena Sound have no county in their registry name, so those two
  // were being added twice under a string identical to itself. Matching on the SLUG catches
  // both shapes; matching on the name would have caught only one.
  //
  // The loop stays, because a zone the registry has not shipped still has to be reachable --
  // the tide, oyster and marsh layers hang off it.
  const zoneSlugByName = new Map();
  for (const [slug, z] of Object.entries(COASTAL_ZONES || {})) {
    if (z && z.name) zoneSlugByName.set(z.name, slug);
  }
  const coastal = coastalNamesByState();
  for (const [stateCode, names] of Object.entries(coastal || {})) {
    for (const name of (names || [])) {
      // A zone has no acreage and no registry row, so it answers the same filters a DNR-fed
      // name does — and must not vanish just because the state box is set to its own state.
      if (f && f.state && f.state !== stateCode) continue;
      if (f && (f.size || f.wellCharted)) continue;
      if (!f && !keep(null, name)) continue;
      const slug = zoneSlugByName.get(name);
      if (slug && emittedCoastal.has(slug)) continue;   // already offered under its registry name
      put(stateCode, 'coastal', name);
    }
  }

  // THE RENDER BELONGS TO THE CALLER AND USED TO BE IN HERE, 2026-09-15 -> 2026-09-16.
  //
  // Extracting the map's builder, I cut the block at the wrong place and left its whole render
  // loop inside this function -- optgroups, options, `lakeSelect`, and a call to lakeBadge() that
  // stayed behind in lake-ramp-select.js. `node --check` passed, because the render code is valid
  // JavaScript wherever it sits, and the tests I wrote read the source and imported typeOf and
  // stateOf rather than CALLING this. So both pickers threw `lakeBadge is not defined` on the
  // first load after the deploy and neither one populated at all.
  //
  // Ryan: "you broke it". He was right, and the lesson is the cheap one: a function that has just
  // been extracted has to be RUN, not type-checked. There is a test that runs it now.
  //
  // This returns buckets and touches no DOM. The two callers render them, and they differ --
  // the map adds lakeBadge() to every row and the planner does not.
  return buckets;
}

