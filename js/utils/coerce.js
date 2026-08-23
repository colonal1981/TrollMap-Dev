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
 * The Worker already imports from js/utils and js/data (see research/limnology.js), so one
 * definition serves both.
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

/**
 * Anything a model emitted, as a list.
 *
 * `coerceSpeciesArray` above parses a species list -- it splits on commas, semicolons, slashes
 * and the word "and", because that is what a model writes when asked for species. Most fields
 * are not that. `cover`, `navigationHazards`, `lureColors`, `tactics`, the source-registry rows:
 * a display list, where splitting a string would invent structure that was never in the answer.
 *
 * So this one normalizes the CONTAINER and touches nothing inside it. A string is one item, an
 * object is its values, an array is itself with the holes removed, and nothing is `[]`.
 *
 * WHY IT EXISTS. `if (v?.length)` is true for a string, and a string has no `.join`. That crash
 * has now happened three times on three different fields -- `knownStockings`, then
 * `predatorSpecies`, then `h.cover` on 2026-08-23, which took the whole Lake Intelligence
 * briefing down and replaced it with the manual checklist. The first two were each repaired in
 * place with an `Array.isArray` ladder that taught the next field nothing. This is the ladder,
 * written once.
 */
export function coerceList(v) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.filter((x) => x != null && x !== '');
  if (typeof v === 'object') return Object.values(v).filter((x) => x != null && x !== '');
  return [v];
}

/**
 * A list of labels, from rows that are `{label, url}` objects when the agent behaves and bare
 * strings when it does not. Both render as a label; a row with neither drops out rather than
 * printing "[object Object]" into a briefing.
 */
export function coerceLabels(v) {
  return coerceList(v)
    .map((x) => (x && typeof x === 'object') ? (x.label || x.name || '') : x)
    .filter(Boolean);
}

/**
 * The number a sentence states about ONE quantity.
 *
 * WHAT THIS REPLACES, AND WHY IT IS NOT A STYLE PREFERENCE.
 *
 * lake-research-engine.js defined this twice, identically:
 *
 *     const parseNum = (s) => parseFloat(String(s||'').replace(/[^0-9.]/g,''));
 *
 * That deletes every character which is not a digit or a dot and reads what is left as one
 * number. It does not parse a number out of a sentence; it collects the sentence's digits.
 * Given the two facts Lake Jocassee's own research run extracted from a FERC licence:
 *
 *   "shoreline length of 92.4 miles and a surface area of 7,980 acres at full pool
 *    elevation of 1,110 feet."          ->  92.47980111        (should be 7980)
 *   "usable storage capacity is 225,387 acre-feet between elevations 1,110 and
 *    1,080 feet."                        ->  22538711101080     (should be 1110, or nothing)
 *
 * Both landed in the shipped profile. The second one is worse than wrong: 92.4798 acres then
 * made the geometry override reject a correctly measured 7,680 acres as "83x the fact value,
 * polygon overlap detected", so a real measurement was thrown away to protect a corrupt one.
 *
 * HOW THIS ONE WORKS. It pairs each number in the text with the word that follows it, keeps
 * the pairs whose unit the caller asked for, and then:
 *
 *   - if a `prefer` pattern is given, keeps only numbers introduced by it
 *     ("full pool elevation of 1,110 feet" -> 1110);
 *   - returns the value only when exactly ONE distinct candidate survives.
 *
 * AMBIGUOUS MEANS NULL. "between elevations 1,110 and 1,080 feet" states two elevations and
 * therefore states no normal pool; the caller's job is to try the next fact, not to average
 * them or take the first. Refusing is the whole point -- every value this used to invent was
 * a number no source ever wrote down.
 *
 * @param {string} text     the sentence to read
 * @param {object} spec     {unit, exclude, prefer} -- all optional RegExps, all case-insensitive
 * @returns {number|null}
 */
export function numberFromText(text, spec = {}) {
  const s = String(text == null ? '' : text);
  if (!s) return null;
  const { unit = null, exclude = null, prefer = null, reject = null } = spec;

  // Every number in the sentence, with the word it is attached to and where it sat:
  // "7,980 acres", "225,387 acre-feet", "1,110-foot contour".
  const re = /(\d[\d,]*(?:\.\d+)?)[\s-]*([A-Za-z][A-Za-z-]*)?/g;
  const hits = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    const value = parseFloat(m[1].replace(/,/g, ''));
    if (!isFinite(value)) continue;
    hits.push({ value, word: m[2] || '', at: m.index, numEnd: m.index + m[1].length });
  }
  if (!hits.length) return null;

  // A RANGE SHARES ITS UNIT WITH ITS OWN FIRST HALF. "between elevations 1,110 and 1,080
  // feet" attaches "feet" to 1,080 and the word "and" to 1,110 -- so a rule that only reads
  // the word immediately after each number sees exactly one elevation in a sentence that
  // states two, and confidently returns the wrong one. The gap between the pair has to be
  // nothing but a conjunction or a dash for the unit to carry backwards; " miles and a
  // surface area of " is not that, which is what keeps 92.4 from being read as acres.
  const bridge = /^[\s,\-–]*(?:and|to|or|through)?[\s,\-–]*$/i;
  for (let i = hits.length - 2; i >= 0; i--) {
    const gap = s.slice(hits[i].numEnd, hits[i + 1].at);
    if (bridge.test(gap)) hits[i].word = hits[i + 1].word;
  }

  const kept = hits.filter((h) => {
    // "225,387 acre-feet" must not read as feet, and the unit word alone decides that.
    if (exclude && exclude.test(h.word)) return false;
    if (unit && !unit.test(h.word)) return false;
    return true;
  }).map((h) => ({ ...h, lead: s.slice(Math.max(0, h.at - 48), h.at) }));
  if (!kept.length) return null;

  const pick = (rows) => {
    const distinct = [...new Set(rows.map((r) => r.value))];
    return distinct.length === 1 ? distinct[0] : null;
  };

  // A normal pool is by definition not the minimum one, so a sentence that introduces its
  // number as a minimum or a drought floor is answering a different question.
  const usable = reject ? kept.filter((h) => !reject.test(h.lead)) : kept;
  if (!usable.length) return null;

  if (prefer) {
    const led = usable.filter((h) => prefer.test(h.lead));
    if (led.length) return pick(led);
  }
  return pick(usable);
}

export const IDENTITY_MEASURES = {
  surfaceAreaAcres: { unit: /^acres?$/i,            exclude: /acre-?feet/i },
  maxDepthFt:       { unit: /^(?:feet|ft|foot)$/i,  exclude: /acre-?feet/i,
                      prefer: /(?:max(?:imum)?|deepest|deep)[^.]{0,40}$/i },
  averageDepthFt:   { unit: /^(?:feet|ft|foot)$/i,  exclude: /acre-?feet/i,
                      prefer: /(?:average|mean)[^.]{0,40}$/i },
  normalPoolFt:     { unit: /^(?:feet|ft|foot)$/i,  exclude: /acre-?feet/i,
                      prefer: /(?:full[\s-]?pool|normal\s+(?:maximum|pool))[^.]{0,40}$/i,
                      reject: /(?:minimum|drought|lowest|low\s+inflow)[^.]{0,40}$/i },
  yearImpounded:    { unit: /^$|^[a-z-]+$/i },
};

// A SAVED PROFILE KEEPS EVERY KEY IT HAS EVER HELD.
//
// That is deliberate. mergeMissing() and the agent merge both preserve anything an agent did
// not return, so omitting a field keeps the deterministic value instead of wiping it -- which
// is what test/agent-prompt-echo.test.js exists to protect. The cost is that a field whose
// PRODUCER was deleted lives in the document for ever, and nothing in a re-run can reach it,
// because there is nothing left to overwrite it WITH.
//
// structuresFromPack() stopped emitting humpCoordinates and ledgeCoordinates when the
// coordinates moved into the pack; they were 549 KB of Thurmond's 810 KB profile. Lake
// Jocassee's profile still carried the eight humps and eight ledges the old browser adapter
// had derived from depth areas: 400-500 "acre" humps sitting in 3-7 ft of water, seven of the
// eight outside the lake, one of them 27 km away in Lake Glenville. Re-running habitat on
// 2026-08-23 returned them byte for byte, which is what sent us looking.
//
// Dropping them costs nothing measurable: structureFor() reads these arrays only when a pack
// has no structure.geojson, and all 373 shipped packs have one as of 2026-08-23. The fallback
// stays for a pack that legitimately lacks structure -- it just has nothing stale left to
// serve.
//
// A row goes in here when a producer is deleted. It comes out when every saved profile has
// been through one assembly since.
export const RETIRED_PROFILE_FIELDS = [
  ['habitat', 'structuralElements', 'humpCoordinates'],
  ['habitat', 'structuralElements', 'ledgeCoordinates'],
];

export function pruneRetiredFields(profile) {
  const dropped = [];
  if (!profile || typeof profile !== 'object') return dropped;
  for (const path of RETIRED_PROFILE_FIELDS) {
    let node = profile;
    for (let i = 0; i < path.length - 1 && node && typeof node === 'object'; i++) node = node[path[i]];
    const leaf = path[path.length - 1];
    if (node && typeof node === 'object' && Object.prototype.hasOwnProperty.call(node, leaf)) {
      const v = node[leaf];
      dropped.push(path.join('.') + (Array.isArray(v) ? ' (' + v.length + ')' : ''));
      delete node[leaf];
    }
  }
  return dropped;
}
