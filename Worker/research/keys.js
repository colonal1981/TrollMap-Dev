// research/keys.js — split from worker-research.js (behavior-preserving)

function sanitizeLakeId(name) {
  return String(name || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'unknown_lake';
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
  try { return JSON.parse(t); } catch (_) {}
  // find first { ... last }
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s >=0 && e > s) {
    try { return JSON.parse(t.slice(s, e+1)); } catch (_) {}
  }
  return null;
}

export { sanitizeLakeId, RESEARCH_CANONICAL_IDS, researchStorageId, lakeResearchMasterKey, lakePackageKey, extractJsonPossibly };
