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
      } catch (_) { /* fall through */ }
    }
    return t.split(/[,;/]|\band\b/i).map(s => s.trim()).filter(Boolean);
  }
  if (typeof v === 'object') return [String(v.species || v.name || '').trim()].filter(Boolean);
  return [String(v).trim()].filter(Boolean);
}
