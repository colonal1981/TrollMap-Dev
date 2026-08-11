/**
 * research-ids.js — the R2 storage id a lake's research profile lives under.
 *
 * PORTED FROM THE WORKER, DELIBERATELY, AND LOCKED BY A TEST.
 *
 * `worker/research/keys.js` decides where a profile is written: `lakes/<id>.json`. The browser
 * never needed to know that until the research picker had to answer "which of these waters do I
 * NOT have a profile for yet" — and `/research/list` returns ids, not display names.
 *
 * The Lake Status table solves the same problem the expensive way: it fetches every profile and
 * reads `profile.lakeName` back out, which is 60 round trips to label 60 rows. That is fine for a
 * table you open on purpose and wrong for a dropdown that populates on load.
 *
 * SO THIS IS A SECOND COPY OF A RULE, WHICH IS A COST. `test/research-ids.test.js` reads the
 * Worker's own source and asserts the two agree, because a silent drift here does not throw — it
 * quietly reports a researched lake as unresearched and sends Ryan to re-run a pipeline that
 * costs Firecrawl credits.
 *
 * Personal use only, not for distribution or resale. NOT FOR NAVIGATION.
 */

/** Mirror of `sanitizeLakeId` in worker/research/keys.js. */
export function sanitizeLakeId(name) {
  return String(name || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'unknown_lake';
}

/**
 * Mirror of `RESEARCH_CANONICAL_IDS` in worker/research/keys.js.
 *
 * Border waters carry two names and would otherwise be researched twice — SC calls it Thurmond
 * and GA calls it Clarks Hill, and both would come back "not researched" beside a profile that
 * already covers them.
 */
export const RESEARCH_CANONICAL_IDS = {
  'lake_thurmond_sc': 'clarks_hill_thurmond_sc_ga',
  'clarks_hill_lake_ga': 'clarks_hill_thurmond_sc_ga',
  'j_strom_thurmond_lake': 'clarks_hill_thurmond_sc_ga',
  'thurmond_lake_sc': 'clarks_hill_thurmond_sc_ga',
  'thurmond_lake_ga': 'clarks_hill_thurmond_sc_ga',
  'clarks_hill_thurmond_sc_ga': 'clarks_hill_thurmond_sc_ga',
  'lake_wylie_nc': 'lake_wylie_sc',
  'lake_wylie_sc_nc': 'lake_wylie_sc',
  'lake_hartwell_sc_ga': 'lake_hartwell_sc',
  'lake_russell_sc_ga': 'lake_russell_sc',
  'lake_russell_ga': 'lake_russell_sc',
  'chatuge_lake_nc': 'lake_chatuge_ga',
};

/** Mirror of `researchStorageId` in worker/research/keys.js. */
export function researchStorageId(lakeName) {
  const safe = sanitizeLakeId(lakeName);
  return RESEARCH_CANONICAL_IDS[safe] || safe;
}

/**
 * Which of these display names already have a profile.
 *
 * `ids` is whatever `/research/list` returned — objects with an `id`, or bare strings. Returns a
 * Set of the DISPLAY NAMES that resolve onto one of them, so the caller never has to hold the id
 * mapping itself.
 *
 * Matching is by exact storage id and nothing looser. A fuzzy match here would mark a water
 * researched that is not, and the failure is invisible: the lake simply stops being offered.
 */
export function researchedNames(displayNames, ids) {
  const have = new Set((ids || []).map((x) => (typeof x === 'string' ? x : x && x.id)).filter(Boolean));
  const out = new Set();
  for (const name of displayNames || []) {
    if (have.has(researchStorageId(name))) out.add(name);
  }
  return out;
}
