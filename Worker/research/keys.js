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
function parseLakeBaseName(displayName) {
  const stripped = String(displayName || '')
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

export { sanitizeLakeId, expandLakeAbbrev, parseLakeBaseName, RESEARCH_CANONICAL_IDS, researchStorageId, lakeResearchMasterKey, lakePackageKey, extractJsonPossibly };
