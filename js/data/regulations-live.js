/**
 * The state regulation digest, in the browser.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHAT WAS WRONG. `checkRegulations()` in species-intel.js is gated on a hand-written table of
 * SIX named waters. (A seventh key, `Coastal SC Inshore`, sat there until 2026-08-20; zero of the
 * 1,363 names the app can offer ever resolved to it.) It is live — plan-preflight.js calls it
 * before a plan is built — and on the other 448 waters it returned
 *
 *     { legal: true, note: 'No specific regulation data available — verify locally before fishing.' }
 *
 * NEITHER CALLER READS `note`. checkPlanLegality maps `reason` and `warnings`; smart-plan reads
 * `legal` and `warnings`. So on 448 of 454 waters the app ran a legality check, got back "we do
 * not know", and displayed nothing — which is indistinguishable from "checked, you are fine".
 * The throw path directly above it DOES warn: a failed check spoke and an empty one did not.
 *
 * Meanwhile the Worker has parsed the official digest PDFs since 2026-08-03 — SC, NC, GA and TN,
 * cached in KV keyed to the digest's own identity so a new book busts its own cache — and the
 * research agents have been reading it the whole time. The browser had no route to it.
 *
 * A STATEWIDE LIMIT APPLIES TO EVERY WATER IN THE STATE. That is the gain: 454 waters get the
 * general table instead of 6 getting a hand-typed one.
 *
 * WHAT THIS STILL CANNOT DO, and it must be said rather than discovered. A size and creel limit
 * is not a closure. The digest publishes limits; it does not publish "this season is shut on this
 * water", which is what `legal: false` means. So legality still comes from the curated table's
 * `notPresent` / `closedSeason` rows, and everywhere else the honest answer is "here are the
 * limits, and nobody has told us about closures".
 *
 * SYNCHRONOUS BY DESIGN. checkRegulations() is called synchronously from two places and making it
 * async would ripple through the whole plan path. So this primes on water selection — the same
 * shape as the conditions strip — and the lookup reads a warmed cache. A cold cache is not a
 * silent pass: it is the unknown branch, which now warns.
 */

const CACHE_MS = 12 * 60 * 60 * 1000;   // the digest changes once a year; twelve hours is generous
const _cache = new Map();               // 'SC|lake murray' -> { at, payload }

/**
 * THE SALTWATER HALF IS STATEWIDE, SO IT IS STORED STATEWIDE.
 *
 * The freshwater cache is keyed `state|water` because a lake can carry its own rule -- "Lake
 * Wateree striped bass" is a real row in the digest. Saltwater has no such thing: SCDNR sets red
 * drum for South Carolina, not for Charleston Harbor. Keying it by water would file sixteen
 * identical copies AND miss on a zone that had not itself been primed while the state's book was
 * already sitting in memory.
 *
 * Every /regulations response carries it, off the same download that answers for freshwater. So
 * selecting ANY South Carolina water -- Lake Marion included -- warms the SC saltwater table.
 * One fetch, both halves, no second endpoint and no second prime.
 */
const _saltwater = new Map();           // 'SC' -> { at, table, source, state }

/** Exposed for tests. */
export function _resetRegulationsCache() { _cache.clear(); _saltwater.clear(); }

export function normalizeWaterName(v) {
  return String(v == null ? '' : v)
    .replace(/\s*\([^)]*\)\s*/g, ' ')          // the county parenthetical is metadata
    .replace(/,\s*[A-Za-z]{2}(\/[A-Za-z]{2})?\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const keyFor = (state, lakeName) =>
  `${String(state || '').trim().toUpperCase()}|${normalizeWaterName(lakeName)}`;

/**
 * Fetch and cache the digest for one water. Safe to call repeatedly; safe to fail.
 *
 * A FAILED PRIME IS NOT A PASS. It leaves the cache cold, and a cold cache reads as "unknown"
 * downstream, which warns. Nothing here can turn a network problem into permission.
 */
export async function primeRegulations(state, lakeName, opts = {}) {
  const st = String(state || '').trim().toUpperCase();
  if (!st) return null;
  const key = keyFor(st, lakeName);
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const hit = _cache.get(key);
  if (hit && now - hit.at < CACHE_MS && !opts.force) return hit.payload;

  const impl = opts.fetch || (typeof fetch === 'function' ? fetch : null);
  if (!impl) return null;
  const base = String(opts.worker || '').replace(/\/+$/, '');
  const url = `${base}/regulations?state=${encodeURIComponent(st)}`
            + `${lakeName ? `&lake=${encodeURIComponent(lakeName)}` : ''}`;
  try {
    const res = await impl(url);
    if (!res.ok) return null;
    const payload = await res.json();
    // A BROKEN PARSE MUST NOT BE CACHED AS AN ANSWER. `parse_failed` exists precisely because an
    // LLM hiccup and a state with no lake-specific rules both produce an empty object.
    if (payload && payload.parse_failed) return null;
    _cache.set(key, { at: now, payload });

    // ONLY A GOOD SALTWATER ANSWER GETS FILED, for the same reason parse_failed is checked
    // above. `saltwater_source` is set by the Worker only when the section was located AND
    // parsed; an empty table beside a present source is a parse that found nothing, which is a
    // different sentence from "the book has no rule for this fish". Both leave the coastal
    // cache COLD, and a cold cache is the unknown branch, which warns. Nothing here can turn a
    // failed parse into permission.
    const salt = payload && payload.saltwater;
    if (payload && payload.saltwater_source && salt && Object.keys(salt).length) {
      _saltwater.set(st, { at: now, table: salt, source: payload.saltwater_source, state: st });
    }
    return payload;
  } catch (_) {
    return null;
  }
}

/**
 * The names one species answers to. A PARENTHETICAL IS A SECOND NAME, NOT A NOTE:
 * `Red Drum (Redfish)` -> ['red drum', 'redfish'].
 *
 * Exported because the failure it prevents is invisible. The digest writes "Spotted Seatrout
 * (Speckled Trout)" and the species picker says "Speckled Trout (Spotted Seatrout)" -- the same
 * fish, and NEITHER STRING CONTAINS THE OTHER, so the substring pass below misses and the angler
 * is told the book says nothing about seatrout while the book is open at the seatrout row.
 */
export function nameForms(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return [];
  const forms = new Set();
  const outside = s.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (outside) forms.add(outside);
  for (const m of s.matchAll(/\(([^)]*)\)/g)) {
    const inner = String(m[1] || '').replace(/\s+/g, ' ').trim();
    if (inner) forms.add(inner);
  }
  return [...forms];
}

/** Loose species matching, because a digest writes "Largemouth bass" and the picker says "Largemouth Bass". */
function findSpecies(table, species) {
  if (!table || typeof table !== 'object') return null;
  const want = String(species || '').trim().toLowerCase();
  if (!want) return null;
  if (table[species]) return { key: species, entry: table[species] };
  for (const k of Object.keys(table)) {
    const kl = k.trim().toLowerCase();
    // WHOLE PHRASE, EITHER DIRECTION, and never a bare substring of a word: "bass" must not
    // match "Largemouth Bass" and hand somebody a black bass limit for a striper.
    if (kl === want) return { key: k, entry: table[k] };
  }
  // Alias forms, WHOLE-FORM EQUALITY ONLY. 'Trout' does not become 'Speckled Trout' here --
  // that would be the bare-substring mistake the pass above exists to avoid.
  const wantForms = nameForms(want);
  if (wantForms.length) {
    for (const k of Object.keys(table)) {
      if (nameForms(k).some(f => wantForms.includes(f))) return { key: k, entry: table[k] };
    }
  }
  for (const k of Object.keys(table)) {
    const kl = k.trim().toLowerCase();
    if (kl.includes(want) && want.length >= 5) return { key: k, entry: table[k] };
    if (want.includes(kl) && kl.length >= 5) return { key: k, entry: table[k] };
  }
  return null;
}

/**
 * The published limits for this species on this water, if the digest has been primed.
 *
 * LAKE-SPECIFIC BEATS STATEWIDE and says which it was, because "this lake has its own rule" and
 * "the statewide rule applies here" are different sentences to put in front of somebody about to
 * keep a fish.
 */
export function livePolicyFor(state, lakeName, species) {
  const hit = _cache.get(keyFor(state, lakeName));
  if (!hit || !hit.payload) return null;
  const p = hit.payload;
  const lakeHit = findSpecies(p.lake_specific, species);
  if (lakeHit) {
    return { scope: 'lake', species: lakeHit.key, state: p.state || null,
             sizeLimit: lakeHit.entry.sizeLimit ?? null, creelLimit: lakeHit.entry.creelLimit ?? null };
  }
  const genHit = findSpecies(p.general, species);
  if (genHit) {
    return { scope: 'state', species: genHit.key, state: p.state || null,
             sizeLimit: genHit.entry.sizeLimit ?? null, creelLimit: genHit.entry.creelLimit ?? null };
  }
  // PRIMED AND THE SPECIES IS NOT IN THE BOOK is a different answer from not primed. The digest
  // was read and it says nothing about this fish here.
  return { scope: 'none', species: null, state: p.state || null, sizeLimit: null, creelLimit: null };
}

/** Whether the digest has been read for this water at all. */
export function regulationsPrimed(state, lakeName) {
  return _cache.has(keyFor(state, lakeName));
}

/**
 * The published saltwater limits for this species in this state, if the digest has been primed.
 *
 * THE SIBLING OF livePolicyFor(), and deliberately the same shape, because coastal-regulations.js
 * consults it exactly the way species-intel.js consults that one. There is no `scope: 'lake'`
 * branch: saltwater limits are set per state, so 'state' and 'none' are the only two answers the
 * book can give.
 *
 * `null` means NOT PRIMED -- nobody has read the book. `scope: 'none'` means the book was read
 * and says nothing about this fish. Those are different sentences and only one of them is about
 * the fish.
 */
export function liveCoastalPolicyFor(state, species) {
  const st = String(state || '').trim().toUpperCase();
  const hit = _saltwater.get(st);
  if (!hit) return null;
  const found = findSpecies(hit.table, species);
  const source = hit.source || null;
  if (found) {
    return { scope: 'state', species: found.key, state: st,
             sizeLimit: found.entry.sizeLimit ?? null,
             creelLimit: found.entry.creelLimit ?? null,
             specialRules: Array.isArray(found.entry.specialRules) ? found.entry.specialRules : [],
             source };
  }
  return { scope: 'none', species: null, state: st, sizeLimit: null, creelLimit: null,
           specialRules: [], source };
}

/** Whether the saltwater half of the digest has been read for this state at all. */
export function coastalRegulationsPrimed(state) {
  return _saltwater.has(String(state || '').trim().toUpperCase());
}
