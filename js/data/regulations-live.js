/**
 * The state regulation digest, in the browser.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHAT WAS WRONG. `checkRegulations()` in species-intel.js is gated on a hand-written table of
 * SIX named waters plus Coastal SC Inshore. It is live — plan-preflight.js and smart-plan.js both
 * call it before a plan is built — and on the other 448 waters it returned
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

/** Exposed for tests. */
export function _resetRegulationsCache() { _cache.clear(); }

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
    return payload;
  } catch (_) {
    return null;
  }
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
