// research/keys.js — split from worker-research.js (behavior-preserving)

function sanitizeLakeId(name) {
  return String(name || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'unknown_lake';
}

// Expand common name abbreviations so map lookups match the R2/TWRA document
// naming regardless of how the app spells the lake. TrollMap calls it
// "Ft. Loudoun Reservoir" while the R2 TWRA profile + LAKE_SYSTEM_ALIASES +
// LAKE_OWNER_DOMAINS are all keyed "fort loudoun". Without this, baseLower would
// be "ft. loudoun" and every baseLower-keyed lookup misses (TWRA seed never
// fires). Exported so the test suite can lock the behavior.
function expandLakeAbbrev(s) {
  return String(s || '')
    .replace(/\bft\.?\s+/gi, 'Fort ')
    .replace(/\bft\.?\s*$/gi, 'Fort')
    .replace(/\s+/g, ' ')
    .trim();
}

// Derive the lake "base name" used for baseLower-keyed lookups: strip the
// leading "Lake", the state suffix, and trailing Reservoir/Lake, then expand
// abbreviations. Mirrors the computation in research/discover.js so both the
// worker and the tests share one definition.
/**
 * Strip the qualifiers consolidate_lake_index.py added and the profile store never saw.
 *
 * In August the index started naming lakes by county, so "Hartwell Lake" became
 * "Hartwell Lake (Anderson Co, SC/GA)". Every baseLower-keyed lookup in this codebase was
 * written before that and matches on the bare name, and the state-suffix regex below is
 * anchored to the END of the string -- so a trailing ")" defeats it and the parenthetical
 * survives into the key. Measured 2026-08-16: that is why J. Strom Thurmond discovered
 * "0 seeds" with 41 agency pages sitting in the table waiting for it.
 */
function stripLakeQualifiers(name) {
  return String(name || '')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/,\s*(SC|NC|GA|TN)(\/(?:SC|NC|GA|TN))*\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseLakeBaseName(displayName) {
  const stripped = stripLakeQualifiers(displayName)
    .replace(/^Lake\s+/i, '')
    .replace(/,\s*(SC|NC|GA|TN)(\/(?:SC|NC|GA|TN))*\s*$/i, '')
    .replace(/\s+Reservoir$/i, '')
    .replace(/\s+Lake$/i, '')
    .trim();
  return expandLakeAbbrev(stripped);
}

const RESEARCH_CANONICAL_IDS = {
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
};

function researchStorageId(lakeName) {
  const safe = sanitizeLakeId(lakeName);
  return RESEARCH_CANONICAL_IDS[safe] || safe;
}

/**
 * Every key a profile for this lake could be living under, best first.
 *
 * READ PATHS MUST TRY ALL OF THEM. On 2026-08-16 the app asked for
 * "J. Strom Thurmond Reservoir (Lincoln Co, GA/SC)", got a 404, and researched from scratch a
 * lake that already had a 95%-confidence verified profile -- landing a 31% draft beside it.
 * The county suffix is not in any key ever written, and RESEARCH_CANONICAL_IDS above exists
 * precisely to stop this lake from splitting in two. The suffix walked straight past it.
 *
 * Bare before raw, canonical before literal: an older profile written under the pre-county
 * name is the one with the research in it, and it must win over a key that only exists
 * because the display name changed.
 */
/** The county parenthetical `consolidate_lake_index.py` added, and nothing else. */
const COUNTY_PAREN = /\s*\([^)]*\bCo\b[^)]*\)\s*/i;

/**
 * The name this lake was called BEFORE the index started naming by county: "Lake Murray, SC".
 *
 * NOT `stripLakeQualifiers`, which removes every parenthetical. "Saluda River (2) (Newberry Co,
 * SC)" has to come back as "Saluda River (2), SC" and not as "Saluda River" -- there are four
 * Saluda Rivers in the registry and the "(2)" is the only thing telling them apart. So only the
 * parenthetical containing "Co" is removed, and the state it carried is put back on the end.
 */
function legacyStorageName(name) {
  const s = String(name || '');
  const m = COUNTY_PAREN.exec(s);
  if (!m) return s;
  const st = /,\s*((?:SC|NC|GA|TN)(?:\/(?:SC|NC|GA|TN))*)\s*\)?\s*$/i.exec(m[0]);
  const base = s.replace(COUNTY_PAREN, ' ').replace(/\s+/g, ' ').trim();
  return st ? `${base}, ${st[1].toUpperCase()}` : base;
}

function researchStorageIdCandidates(lakeName) {
  const raw = sanitizeLakeId(lakeName);
  const bare = sanitizeLakeId(stripLakeQualifiers(lakeName));
  // THE FORM 59 OF THE 62 PROFILES ARE ACTUALLY FILED UNDER, and it was missing until
  // 2026-08-23. The Thurmond fix above added `bare` and `raw` and stopped there, so it rescued
  // exactly the lakes whose stored id happens to be one of those two -- Thurmond's own id IS
  // the county form, which is why it looked fixed. Measured against the live bucket:
  //   /research/get?lake=Lake Murray (Newberry Co, SC)  -> 404
  //   /research/get?lake=Lake Murray, SC                -> ok, v76.0
  // Every profile written before August is under the second spelling.
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
 * The first candidate key that exists in R2, or null. `probe` takes an id and resolves truthy
 * when something is stored under it -- so the caller decides what "exists" means (a master
 * profile, a package file) and this stays one rule rather than four copies of it.
 */
/**
 * The id this lake's profile is actually filed under, or null.
 *
 * `altNames` is every OTHER name the registry says this water answers to, supplied by the caller
 * because this module is pure and has no index. It is tried after the caller's own name, so a
 * water whose profile sits under its current spelling is unaffected.
 *
 * WHY IT TAKES THEM AT ALL. A profile is stored under whatever the water was CALLED the day it
 * was written; rename the water and the object answers to nothing. Measured 2026-09-01 across all
 * 80 profiles in the bucket: four waters had two profiles each, and in every case the older and
 * better one was filed under a name the registry still carries.
 *
 *   Richard B Russell Lake   lake_russell_sc     + lake_richard_russell_ga
 *   Lake Sidney Lanier       lake_lanier_ga      + lake_sidney_lanier_hall_co_ga
 *   Nottely Lake             lake_nottely_ga     + nottely_lake_ga
 *   Watauga Lake             watauga_tn          + watauga_lake_tn
 */
async function resolveResearchStorageId(lakeName, probe, altNames = []) {
  const seen = new Set();
  const tries = [lakeName, ...(Array.isArray(altNames) ? altNames : [])];
  for (const name of tries) {
    for (const id of researchStorageIdCandidates(name)) {
      if (seen.has(id)) continue;
      seen.add(id);
      // eslint-disable-next-line no-await-in-loop
      const hit = await probe(id);
      if (hit) return { id, hit };
    }
  }
  return null;
}

function lakeResearchMasterKey(lakeName) {
  return `lakes/${researchStorageId(lakeName)}.json`;
}

function lakePackageKey(lakeName, filename) {
  return `lake_packages/${researchStorageId(lakeName)}/${filename}`;
}

function extractJsonPossibly(txt) {
  if (!txt) return null;
  let t = String(txt).trim();
  // strip code fences
  t = t.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
  // Both catches here are intentionally silent, and this is the one place in the Worker where
  // that is the whole design rather than an oversight. This function exists BECAUSE an LLM
  // returns not-quite-JSON: the first parse is the optimistic path, the brace-slice is the
  // salvage attempt, and null is the honest "no object in there". A failed parse is the
  // expected input, not an error -- logging it would fire on every prose-wrapped reply.
  // Audited 2026-08-03. What the caller must not do is treat null as an empty object.
  try { return JSON.parse(t); } catch (_) {}
  // find first { ... last }
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s >=0 && e > s) {
    // The salvage attempt. Audited 2026-08-03 -- see the note above; silence is the design.
    try { return JSON.parse(t.slice(s, e+1)); } catch (_) {}
  }
  return null;
}

export { sanitizeLakeId, expandLakeAbbrev, stripLakeQualifiers, legacyStorageName, parseLakeBaseName, RESEARCH_CANONICAL_IDS, researchStorageId, researchStorageIdCandidates, resolveResearchStorageId, lakeResearchMasterKey, lakePackageKey, extractJsonPossibly };
