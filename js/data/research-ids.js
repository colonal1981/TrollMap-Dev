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

// The registry is NOT part of the mirror below -- keys.js is pure and stays pure. This import
// is used only by researchedNames(), which is client-only and has no counterpart in the Worker.
import { identityNamesFor } from './lake-registry.js';

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

/** Mirror of `stripLakeQualifiers` in worker/research/keys.js. */
export function stripLakeQualifiers(name) {
  return String(name || '')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/,\s*(SC|NC|GA|TN)(\/(?:SC|NC|GA|TN))*\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const COUNTY_PAREN = /\s*\([^)]*\bCo\b[^)]*\)\s*/i;

/** Mirror of `legacyStorageName` in worker/research/keys.js. */
export function legacyStorageName(name) {
  const s = String(name || '');
  const m = COUNTY_PAREN.exec(s);
  if (!m) return s;
  const st = /,\s*((?:SC|NC|GA|TN)(?:\/(?:SC|NC|GA|TN))*)\s*\)?\s*$/i.exec(m[0]);
  const base = s.replace(COUNTY_PAREN, ' ').replace(/\s+/g, ' ').trim();
  return st ? `${base}, ${st[1].toUpperCase()}` : base;
}

/** Mirror of `researchStorageIdCandidates` in worker/research/keys.js. */
export function researchStorageIdCandidates(lakeName) {
  const raw = sanitizeLakeId(lakeName);
  const bare = sanitizeLakeId(stripLakeQualifiers(lakeName));
  const legacy = sanitizeLakeId(legacyStorageName(lakeName));
  const out = [];
  const push = (x) => { if (x && !out.includes(x)) out.push(x); };
  push(RESEARCH_CANONICAL_IDS[bare]);
  push(RESEARCH_CANONICAL_IDS[legacy]);
  push(RESEARCH_CANONICAL_IDS[raw]);
  push(bare);
  push(legacy);
  push(raw);
  return out;
}

/**
 * Which of these display names already have a profile.
 *
 * `ids` is whatever `/research/list` returned — objects with an `id`, or bare strings. Returns a
 * Set of the DISPLAY NAMES that resolve onto one of them, so the caller never has to hold the id
 * mapping itself.
 *
 * IT MATCHES THE SAME CANDIDATE SET THE WORKER'S READ PATH TRIES, and until 2026-08-23 it matched
 * only `researchStorageId` — the WRITE rule. That is the wrong question. "Do I have a profile for
 * this water" is answered by whether `/research/get` would find one, and that call tries the bare
 * name, the pre-county "Name, ST" name and the literal name in turn. Asking with one spelling
 * reported North Saluda and both Lake Robinsons as unresearched while their profiles sat in the
 * bucket, and sent Ryan to re-run a pipeline that spends Firecrawl credits.
 *
 * This is NOT a fuzzy match. It is the exact set of keys the Worker will look under; a name that
 * matches here is a name `/research/get` will resolve. A fuzzy match would mark a water researched
 * that is not, and the failure would be invisible — the lake simply stops being offered.
 */
export function researchedNames(displayNames, ids) {
  const have = new Set((ids || []).map((x) => (typeof x === 'string' ? x : x && x.id)).filter(Boolean));
  const out = new Set();
  for (const name of displayNames || []) {
    // ONE NAME IS NOT ENOUGH, AND FOUR WATERS PROVED IT ON 2026-09-01.
    //
    // A profile is filed under whatever the water was CALLED the day it was written. Rename it and
    // the object stays where it is, answering to nothing -- so this reported four waters as
    // unresearched, the batch researched them again, and each ended the night with two profiles:
    //
    //   Richard B Russell Lake   lake_russell_sc     + lake_richard_russell_ga
    //   Lake Sidney Lanier       lake_lanier_ga      + lake_sidney_lanier_hall_co_ga
    //   Nottely Lake             lake_nottely_ga     + nottely_lake_ga
    //   Watauga Lake             watauga_tn          + watauga_lake_tn
    //
    // The July profiles are the better ones -- Lanier's has a 22.5 ft thermocline, anoxia below
    // 30 ft and an 8.6 ft Secchi where the new one is null in all three -- and the registry never
    // stopped knowing the names they are filed under: `legacy_display_names` still carries
    // "Watauga, TN" and "Lake Nottely, GA", and RESEARCH_CANONICAL_IDS already maps
    // `lake_russell_ga`. Nothing needed typing. The question was asked with one spelling.
    //
    // identityNamesFor() is the registry's answer to "what else is this water called", with a
    // guard that refuses any name a second row also carries -- both Lake Robinsons answer to
    // "Lake Robinson, SC" and neither may reach the other's profile through it. Measured over all
    // 358 rows against all 80 objects in the bucket: no profile is claimed by two waters.
    const names = [name, ...identityNamesFor(name)];
    if (names.some((n) => researchStorageIdCandidates(n).some((id) => have.has(id)))) out.add(name);
  }
  return out;
}
