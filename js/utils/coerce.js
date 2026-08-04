// Coercion helpers for biology arrays that may be malformed in stored profiles.
//
// A prior LLM run can persist `knownStockings` / `predatorSpecies` as a string or
// plain object. That previously crashed profile assembly
// ("biology.knownStockings.map is not a function") — most often when resuming a
// single agent (e.g. Species Intelligence) that loads the biology section
// straight from the saved profile, so a malformed value bypassed every
// `Array.isArray` defense and blew up during the deterministic-summary step.
//
// These helpers normalize such values into clean arrays so downstream `.map` /
// `.join` calls never throw.

// Coerce a possibly-malformed knownStockings value into a clean array of
// { species } objects.
export function coerceStockingsArray(v) {
  if (Array.isArray(v)) {
    return v.filter(Boolean).map(s =>
      (s && typeof s === 'object' && typeof s.species === 'string')
        ? s
        : { species: String(s == null ? '' : s).trim() }
    ).filter(s => s.species);
  }
  if (v == null) return [];
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.startsWith('[') || t.startsWith('{')) {
      try {
        const p = JSON.parse(t);
        if (Array.isArray(p)) return coerceStockingsArray(p);
        if (p && typeof p === 'object') return coerceStockingsArray([p]);
      // Intentionally silent, and the comment below already says so: this is a parser that TRIES
      // JSON first and falls back to plain splitting. A string that is not JSON is the expected
      // input, not an error. Audited 2026-08-03.
      } catch (_) { /* fall through to plain splitting */ }
    }
    return t.split(/[,;]/).map(s => s.trim()).filter(Boolean).map(s => ({ species: s }));
  }
  if (typeof v === 'object') return coerceStockingsArray([v]);
  return [];
}

// Coerce a possibly-malformed species/predator list (string/object/array) into a
// clean array of trimmed strings.
export function coerceSpeciesArray(v) {
  if (Array.isArray(v)) return v.map(s => String(s == null ? '' : s).trim()).filter(Boolean);
  if (v == null) return [];
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.startsWith('[')) {
      try {
        const p = JSON.parse(t);
        if (Array.isArray(p)) return coerceSpeciesArray(p);
      // Intentionally silent: JSON first, plain splitting second. A string that is not JSON is
      // the expected input here, not an error. Audited 2026-08-03.
      } catch (_) { /* fall through */ }
    }
    return t.split(/[,;/]|\band\b/i).map(s => s.trim()).filter(Boolean);
  }
  if (typeof v === 'object') return [String(v.species || v.name || '').trim()].filter(Boolean);
  return [String(v).trim()].filter(Boolean);
}

/**
 * A limnology number that may have arrived as a string, a range, or the word "null".
 *
 * LLM output and profiles saved by earlier runs put `"16-22"`, `"unknown"`, `""` and the
 * literal string `"null"` into fields that every consumer treats as a number. This existed
 * twice, byte for byte: once in Worker/research/agents.js as it sanitises a limnology
 * response, and once in js/modules/lake-research-engine.js as it merges saved sections. Two
 * copies of a coercion rule is how a range like "16-22" starts meaning 19 on one side of the
 * wire and NaN on the other.
 *
 * The Worker already imports from js/utils and js/data (see research/vision.js and
 * research/limnology.js), so one definition serves both.
 *
 * A range takes its midpoint, rounded — the caller wants a depth to fish, not an interval.
 *
 * @returns {number|null} null for anything that is not a usable number
 */
export function coerceNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    if (v === 'null' || v === '' || v === 'unknown') return null;
    const range = v.match(/^([\d.]+)\s*[-–]\s*([\d.]+)$/);
    if (range) return Math.round((parseFloat(range[1]) + parseFloat(range[2])) / 2);
    const num = parseFloat(v);
    return isFinite(num) ? num : null;
  }
  return null;
}

/**
 * Does this value carry anything a research section can be built from?
 *
 * `null`, `''`, `[]` and `{}` are all "the agent returned the field and it is empty", which is
 * different from "the agent did not answer" and different again from a real zero. Every
 * caller needs the same three-way distinction, and this existed twice -- Worker/research/
 * facts-util.js and js/modules/lake-research-engine.js -- so a change to what counts as empty
 * would have had to be made in two places or silently disagree across the wire.
 */
export function hasResearchValue(v) {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}
