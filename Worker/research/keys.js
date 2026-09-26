// research/keys.js — split from worker-research.js (behavior-preserving)
//
// THE STORAGE-ID RULE IS IMPORTED, NOT MIRRORED, SINCE 2026-09-25. sanitizeLakeId,
// stripLakeQualifiers, researchStorageId, legacyStorageName and researchStorageIdCandidates were
// written here and copied into js/data/research-ids.js, byte for byte, with a test holding the two
// together. research-ids.js is the one copy now, the way RESEARCH_CANONICAL_IDS already was.
import { RESEARCH_CANONICAL_IDS, sanitizeLakeId, stripLakeQualifiers, researchStorageId,
         legacyStorageName, researchStorageIdCandidates } from '../../js/data/research-ids.js';

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

function parseLakeBaseName(displayName) {
  const stripped = stripLakeQualifiers(displayName)
    .replace(/^Lake\s+/i, '')
    .replace(/,\s*(SC|NC|GA|TN)(\/(?:SC|NC|GA|TN))*\s*$/i, '')
    .replace(/\s+Reservoir$/i, '')
    .replace(/\s+Lake$/i, '')
    .trim();
  return expandLakeAbbrev(stripped);
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

export { expandLakeAbbrev, parseLakeBaseName, RESEARCH_CANONICAL_IDS, resolveResearchStorageId, lakeResearchMasterKey, lakePackageKey, extractJsonPossibly, sanitizeLakeId, stripLakeQualifiers, legacyStorageName, researchStorageId, researchStorageIdCandidates };
