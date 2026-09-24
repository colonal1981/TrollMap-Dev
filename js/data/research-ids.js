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
 * quietly reports a researched lake as unresearched and sends Ryan to re-run a pipeline he has
 * already paid for in time.
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
 * THE ONE COPY. Border waters carry two names and would otherwise be researched twice -- SC calls
 * it Thurmond and GA calls it Clarks Hill, and both would come back "not researched" beside a
 * profile that already covers them.
 *
 * THIS FILE USED TO SAY "Mirror of RESEARCH_CANONICAL_IDS in worker/research/keys.js", AND THE
 * MIRROR DRIFTED. hand-written-tables.test.js was written to catch exactly that -- "two copies
 * means that fix has to land twice" -- and on 2026-09-05 it was catching it: the Worker's copy
 * had been corrected on 2026-09-04 and this one had not, so the browser still carried
 * `'lake_russell_ga': 'lake_russell_sc'`. That row hands Lake Russell (Habersham Co, GA), an
 * 88-acre Forest Service lake, the whole profile of Richard B Russell -- 24,608 acres, 15
 * species, its depth and its trolling intelligence -- on a lake Ryan could paddle across.
 *
 * So there is no mirror now. `Worker/research/keys.js` imports this, the way
 * `Worker/research/limnology.js` already imports `js/data/lake-keys.js`.
 */
export const RESEARCH_CANONICAL_IDS = {
  // Clarks Hill / Thurmond (SC/GA) — SC calls it Thurmond, GA calls it Clarks Hill
  'lake_thurmond_sc': 'clarks_hill_thurmond_sc_ga',
  'clarks_hill_lake_ga': 'clarks_hill_thurmond_sc_ga',
  'j_strom_thurmond_lake': 'clarks_hill_thurmond_sc_ga',
  'thurmond_lake_sc': 'clarks_hill_thurmond_sc_ga',
  'thurmond_lake_ga': 'clarks_hill_thurmond_sc_ga',
  'clarks_hill_thurmond_sc_ga': 'clarks_hill_thurmond_sc_ga',
  // Lake Wylie (SC/NC) — canonical is SC profile
  'lake_wylie_nc': 'lake_wylie_sc',
  'lake_wylie_sc_nc': 'lake_wylie_sc',
  // Lake Hartwell (SC/GA) — canonical is SC profile
  'lake_hartwell_sc_ga': 'lake_hartwell_sc',
  // Lake Russell (SC/GA) — SC calls it Lake Russell, GA calls it Lake Russell — canonical is SC profile
  'lake_russell_sc_ga': 'lake_russell_sc',
  // 'lake_russell_ga' IS NOT THIS LAKE. Measured 2026-09-04: the index carries Lake Russell
  // (Habersham Co, GA), an 88-acre Forest Service lake a hundred miles from the Savannah, whose
  // own legacy name "Lake Russell, GA" sanitizes to exactly that key. This row handed it Richard
  // B Russell's whole profile -- 24,608 acres, 15 species, its depth and its trolling
  // intelligence -- on a lake Ryan could paddle across. Richard B Russell still reaches
  // lake_russell_sc through its own identity name "Lake Russell, SC", which is a name it
  // actually answers to; the GA lake now correctly reaches nothing, because it has nothing.
  //
  // A CANONICAL MAP KEYED ON A NAME COLLIDES WHEN TWO WATERS SHARE THE NAME. Every row here is
  // hand-written, and each one is a claim that one spelling belongs to one water. Check the
  // index for a second owner before adding another.
  // Lake Chatuge (GA/NC) — GA calls it Lake Chatuge, NC calls it Chatuge Lake — canonical is GA
  'chatuge_lake_nc': 'lake_chatuge_ga',
  // Richard B Russell (SC/GA) — GA's feed calls it "Lake Richard Russell", SC's calls it
  // "Lake Russell", so the picker offers the ONE reservoir twice and the two entries were
  // reaching two different profiles: a 2026-09-01 batch draft at 54% against the verified one.
  // Ryan, looking at his own app: "The app is showing me Lake Richard Russell, GA".
  //
  // COLLISION CHECKED, which is the rule the removed lake_russell_ga row was written without:
  // "Lake Richard Russell" belongs to no other water in the index. "Lake Russell" does -- the
  // 88-acre Habersham Co lake -- which is exactly why that key is not in this table and this
  // one is.
  'lake_richard_russell_ga': 'lake_russell_sc',
  // The rest of the 2026-09-01 fork, from the same cause: the batch drove from the registry's
  // county-stamped names before /research/save could map them back, so three more waters gained
  // a second, thinner profile under the spelling the picker happens to show. Ryan's research
  // picker, read off his screen 2026-09-04: "Lake Sidney Lanier (Hall Co, GA)", "Nottely Lake,
  // GA", "Watauga Lake, TN" -- each landing on a three-source draft while the verified profile
  // sat somewhere the picker never asks for.
  //
  // COLLISION CHECKED against the app's own 877-name list: each key below is produced by
  // EXACTLY ONE picker name. That check is the whole difference between these rows and the
  // lake_russell_ga row that was removed above.
  'lake_sidney_lanier_hall_co_ga': 'lake_lanier_ga',
  'nottely_lake_ga': 'lake_nottely_ga',
  'watauga_lake_tn': 'watauga_tn',
  'watagua_tn': 'watauga_tn',
  // ── THE CONGAREE, 2026-09-17, AND IT IS THE SAME CAUSE POINTING THE OTHER WAY ─────────────────
  //
  // The whole of 2026-09-16 went into researching this river -- 62 extracted facts, a per-species
  // trollingIntelligence block including the Largemouth Bass entry -- and NOT ONE LINE OF IT REACHED
  // A PLAN. Found by running the app: a dry bench from Barney Jordan logged
  //
  //     [plan-v2] no research profile answered to "Congaree River, SC"
  //     [plan-candidates] holding unknown for this species/season -- water was filtered with the
  //     old fish-band-vs-water-depth test. Bands from the built-in table never carry holding; only
  //     a researched profile does.
  //
  // so the day ran on the generic depth band, the default structure weights and no thermocline,
  // while the river's own profile sat in the bucket.
  //
  // THE PICKER'S NAME COMES FROM THE DNR RAMP FEED AND THE PROFILE IS FILED UNDER THE REGISTRY'S.
  // The feed says `wb: "Congaree River"` + SC, so the picker offers "Congaree River, SC"; the
  // registry row is "Congaree River (to SC-601) (Richland Co, SC)" and research_lakes.py drove from
  // that. researchStorageIdCandidates("Congaree River, SC") tries `congaree_river` and
  // `congaree_river_sc`; the object is `congaree_river_to_sc_601_richland_co_sc`. Two spellings, no
  // overlap -- the same shape as the four waters above, except that here the batch wrote the LONG
  // name and the picker asks for the short one.
  //
  // BOTH KEYS, BECAUSE THE READ AND THE WRITE ASK DIFFERENTLY. `researchStorageIdCandidates()`
  // reaches for the bare `congaree_river` first, and `researchStorageId()` -- the WRITE rule --
  // sanitizes the picker name to `congaree_river_sc`. Mapping only the read would leave the next
  // save creating a second profile under the picker's spelling, which is precisely how the
  // 2026-09-01 fork happened.
  //
  // COLLISION CHECKED in the running app against the picker's own list: `congaree_river` and
  // `congaree_river_sc` are each produced by EXACTLY ONE name, "Congaree River, SC", and it is the
  // only name in the index containing the word at all. which_profile_serves.mjs reported it as
  // STRANDED before this row and does not after.
  'congaree_river': 'congaree_river_to_sc_601_richland_co_sc',
  'congaree_river_sc': 'congaree_river_to_sc_601_richland_co_sc',
  // ── THE UPPER SALUDA IS ONE RIVER TO RESEARCH, 2026-09-24 ─────────────────────────────────────
  //
  // A DIFFERENT SHAPE FROM EVERY ROW ABOVE: not one water under two spellings but two registry
  // waters that are one piece of research. The map splits the Saluda at its reservoirs --
  // saluda_river above Lake Greenwood, saluda_river_2 from Greenwood to Lake Murray -- and that is
  // right for display. Ryan, on the research: "the upper saluda all the way from before saluda
  // lake to murray is probably ok as 1 piece... then lower saluda is a completely type of river".
  // No document on the web says which reach it is about, so two profiles would be one corpus read
  // twice and diverging by accident.
  //
  // THE TARGET IS THE ONE BOTH PICKER ENTRIES ALREADY READ. Measured with which_profile_serves.mjs:
  // "Saluda River (Greenville Co, SC)" (saluda_river) and "Saluda River, SC" (saluda_river_2) both
  // reach saluda_river_sc today, the first through its legacy name and the second through its raw
  // one. What these rows stop is the WRITE forking it: research_lakes.py drives from registry
  // names, and "Saluda River (Greenville Co, SC)" is how saluda_river_greenville_co_sc -- the
  // second, hidden profile of the same water -- got written on 2026-09-23. saluda_river_2's own
  // names would have been the third.
  //
  // COLLISION CHECKED against the picker's 876 names and the identity names the Worker tries
  // beside each: `saluda_river_greenville_co_sc` is produced by "Saluda River (Greenville Co, SC)"
  // alone, and the two `saluda_river_2_*` keys by no picker name at all -- they are the registry's
  // own spellings of that row. NOT `saluda_river`: "Saluda River (Lower Saluda), SC" produces it
  // too, and the Lower Saluda is the one reach that is a different river.
  //
  // AND THE TARGET MAPS TO ITSELF, the way Thurmond's does. Without it "Saluda River, SC" asks for
  // the bare `saluda_river` FIRST -- the key the Lower Saluda shares -- and reaches saluda_river_sc
  // only because nothing is stored under the bare one yet. A canonical row is tried before any
  // bare key, so the self-map is what makes the upper entries ask for their own profile first.
  // `saluda_river_sc` is produced only by those two entries (same check).
  'saluda_river_sc': 'saluda_river_sc',
  'saluda_river_greenville_co_sc': 'saluda_river_sc',
  'saluda_river_2_sc': 'saluda_river_sc',
  'saluda_river_2_newberry_co_sc': 'saluda_river_sc',
  // ── A WATER READS ITS OWN PROFILE BEFORE A SPELLING IT SHARES, 2026-09-24 ────────────────────
  //
  // THE CHATTAHOOCHEE BELOW BUFORD DAM WAS PLANNED ON THE TROUT STREAM ABOVE LAKE LANIER. Both
  // pieces carry the legacy spelling "Chattahoochee River, GA" -- the Fulton Co row as its legacy
  // name, the White Co piece as the name the picker shows for it -- and the candidate order tries a
  // legacy spelling before a water's own current id, deliberately (Thurmond, 2026-08-16: an older
  // profile under the pre-county name must beat a new draft). So "Chattahoochee River (Fulton Co,
  // GA)", the cold tailwater through Atlanta, was served chattahoochee_river_ga -- the Helen trout
  // water's research -- while its own 75 KB profile sat unread. which_profile_serves.mjs listed it
  // as a FORK; with the upper Saluda settled above, it was the only one left.
  //
  // A SELF-MAP AND NOT A REORDER. Putting raw before legacy for every water would also fix this,
  // and would let every future batch draft written under a county name outrank the older profile
  // beside it -- the exact case the order exists for. A canonical row is tried before either, for
  // this one id.
  //
  // COLLISION CHECKED against the picker's 876 names and the identity names the Worker tries
  // beside each: `chattahoochee_river_fulton_co_ga` is produced by "Chattahoochee River (Fulton
  // Co, GA)" alone. The White Co entry, "Chattahoochee River, GA", still reaches its own
  // chattahoochee_river_ga first -- its own name's candidates are exhausted before any alias.
  'chattahoochee_river_fulton_co_ga': 'chattahoochee_river_fulton_co_ga',
  // THE FRENCH BROAD'S RESEARCH IS FILED UNDER TENNESSEE AND IS ABOUT NORTH CAROLINA. It was run as
  // "French Broad River, TN", a name the picker does not offer, so the water the picker does offer
  // -- "FRENCH BROAD RIVER, NC", the registry's french_broad_river, 94% NC by its own outline --
  // reached nothing. Read before pointing anything at it: of the profile's 152 facts, 31 name NC
  // places (Asheville, Hot Springs, Pisgah, NCPAWS' access list) and 5 name Tennessee ones, all a
  // Knox/Sevier consumption advisory below Douglas Dam. It is this water's research.
  //
  // COLLISION CHECKED the same way: `french_broad_river_nc` and `french_broad_river_haywood_co_nc`
  // are produced only by names of french_broad_river. NOT the bare `french_broad_river`, which the
  // TN spelling produces too.
  'french_broad_river_nc': 'french_broad_river_tn',
  'french_broad_river_haywood_co_nc': 'french_broad_river_tn',
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
 * bucket, and sent Ryan to re-run a pipeline for waters that were already done.
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
