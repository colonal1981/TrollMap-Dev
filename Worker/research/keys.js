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
  'lake_russell_ga': 'lake_russell_sc',
  // Lake Chatuge (GA/NC) — GA calls it Lake Chatuge, NC calls it Chatuge Lake — canonical is GA
  'chatuge_lake_nc': 'lake_chatuge_ga',
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
function researchStorageIdCandidates(lakeName) {
  const raw = sanitizeLakeId(lakeName);
  const bare = sanitizeLakeId(stripLakeQualifiers(lakeName));
  const out = [];
  const push = (x) => { if (x && !out.includes(x)) out.push(x); };
  push(RESEARCH_CANONICAL_IDS[bare]);
  push(RESEARCH_CANONICAL_IDS[raw]);
  push(bare);
  push(raw);
  return out;
}

/**
 * The first candidate key that exists in R2, or null. `probe` takes an id and resolves truthy
 * when something is stored under it -- so the caller decides what "exists" means (a master
 * profile, a package file) and this stays one rule rather than four copies of it.
 */
async function resolveResearchStorageId(lakeName, probe) {
  for (const id of researchStorageIdCandidates(lakeName)) {
    // eslint-disable-next-line no-await-in-loop
    const hit = await probe(id);
    if (hit) return { id, hit };
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

export { sanitizeLakeId, expandLakeAbbrev, stripLakeQualifiers, parseLakeBaseName, RESEARCH_CANONICAL_IDS, researchStorageId, researchStorageIdCandidates, resolveResearchStorageId, lakeResearchMasterKey, lakePackageKey, extractJsonPossibly };
