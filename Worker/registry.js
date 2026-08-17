/**
 * The lake index, read by the Worker.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHY THIS EXISTS. Ryan, 2026-08-17: *"whats next on the list of hard coded things that never got
 * expanded when the app grew"*. `LAKES` in worker-data.js was the biggest of them — fifteen waters
 * of 454, written before the registry did. Measuring it found that its only public door, `/lake`,
 * has no caller, and that `normalPool` is byte-identical to a field the live Duke feed already
 * publishes for 35 lakes. So the table was underserving almost nothing.
 *
 * Almost. The research identity agent is told *"Never invent values"* and then handed a
 * `_knownBaseline` for fifteen waters and NOTHING for the other 439 — on the one call in the
 * pipeline whose whole job is to state what the lake is. That is where the fifteen-lake gate was
 * costing something real.
 *
 * `_registry/lake_index.json` has been in the same R2 bucket `waterBindings()` reads from since
 * the registry shipped, carrying name, state, county, acres, GNIS, centroid and feature type for
 * all 454. Read here the same way, for the same reason: the pipeline owns it, and a second copy
 * of a per-water fact inside the Worker is how five separate nine-lake Duke lists happened.
 *
 * NOTHING IN THIS FILE FETCHES A MEASUREMENT. It answers "what water is this", not "what is it
 * doing right now" — that is /conditions, and it has its own bindings.
 */

import { r2Text } from './worker-core.js';

export const LAKE_INDEX_KEY = '_registry/lake_index.json';
export const INDEX_TTL_S = 3600;

let _index = null;
let _indexAt = 0;

/** Exposed for tests. Nothing in the Worker should need to call this. */
export function _resetIndexCache() { _index = null; _indexAt = 0; }

/**
 * The index, cached per isolate for an hour.
 *
 * Same cadence and same failure mode as `waterBindings()`: the object changes when the PIPELINE
 * uploads, not when the Worker deploys, so an hour is the right staleness and a missing object is
 * an error naming the script that writes it rather than a silent empty index. An empty index and
 * an unread one are the same shape and must not be.
 */
export async function lakeIndex(env, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  if (!opts.fresh && _index && now - _indexAt < INDEX_TTL_S * 1000) return _index;
  const bucket = (env && env.R2_TROLLMAP_CHARTPACKS) || opts.bucket;
  if (!bucket) throw new Error('R2_TROLLMAP_CHARTPACKS is not bound to this Worker');
  const obj = await bucket.get(LAKE_INDEX_KEY);
  if (!obj) throw new Error(`${LAKE_INDEX_KEY} is not in the bucket — run upload_garmin_to_r2.py`);
  // r2Text, NOT obj.text(). A gzipped object comes back mangled from text() alone, and
  // test/r2-gzip.test.js asserts no Worker file calls it directly. It caught this one.
  const parsed = JSON.parse(await r2Text(obj));
  const rows = parsed && (parsed.lakes || parsed);
  if (!rows || typeof rows !== 'object' || Array.isArray(rows)) {
    throw new Error(`${LAKE_INDEX_KEY} is not an object keyed by slug`);
  }
  _index = rows;
  _indexAt = now;
  return rows;
}

const lower = (v) => String(v == null ? '' : v).trim().toLowerCase();

/** The county parenthetical is metadata, not part of the water's name. */
const bare = (v) => lower(v).replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * One registry row for a name, or null.
 *
 * FOUR EXACT PASSES, THEN ONE THAT CAN REFUSE. Slug, display name, legacy display names, bare
 * name — all exact, all case-folded, none of them a substring test. `resolveLakeKey()` in
 * trollmap-worker.js is a substring matcher and the sixth member of that family; it handed Lake
 * Wateree's pool config to the Wateree RIVER and Lake Marion's to Graves Lake in Marion COUNTY.
 * None of that is possible here because nothing matches on a fragment.
 *
 * THE LAST PASS REFUSES RATHER THAN GUESSES. Stripping "(Marlboro Co, SC)" off "Lake Wallace"
 * is exactly the collapse `lint:keys` fails on: the county suffix exists precisely because two
 * waters share a name. So the bare-name bucket is built first, and a name landing in a bucket of
 * more than one returns null. An ambiguous answer here becomes a hallucination anchor on the
 * wrong lake, which is worse than no anchor at all.
 */
export function resolveRegistryRow(index, lakeName) {
  if (!index || typeof index !== 'object') return null;
  const want = lower(lakeName);
  if (!want) return null;

  if (index[lakeName]) return index[lakeName];
  for (const slug of Object.keys(index)) if (lower(slug) === want) return index[slug];

  const rows = Object.values(index).filter((r) => r && typeof r === 'object');

  // EVERY PASS BELOW COUNTS BEFORE IT ANSWERS, and the registry is why. `lake_robinson` and
  // `lake_robinson_greer` BOTH carry name "Lake Robinson" and BOTH carry legacy display name
  // "Lake Robinson, SC" — one on the Pee Dee, one above Greenville, 200 km apart. An earlier
  // draft of this function used `rows.find()` on those fields and would have returned whichever
  // came first in the file: a silent coin toss, written into a baseline labelled authoritative.
  //
  // Only `display_name` is unique by construction — the county parenthetical exists for exactly
  // this. Ambiguity ABORTS rather than falling through, because every later pass is looser and
  // nothing looser can break a tie the stricter test could not.
  const one = (matches) => (matches.length === 1 ? matches[0] : matches.length ? null : undefined);
  const passes = [
    rows.filter((r) => lower(r.display_name) === want),
    rows.filter((r) => lower(r.legacy_display_name) === want
      || (Array.isArray(r.legacy_display_names) && r.legacy_display_names.some((n) => lower(n) === want))),
    rows.filter((r) => lower(r.name) === want),
  ];
  for (const matches of passes) {
    const hit = one(matches);
    if (hit !== undefined) return hit;         // null here means AMBIGUOUS, and stops the search
  }

  const key = bare(lakeName);
  if (!key) return null;
  const buckets = new Map();
  for (const r of rows) {
    for (const cand of [r.display_name, r.name, r.legacy_display_name,
                        ...(Array.isArray(r.legacy_display_names) ? r.legacy_display_names : [])]) {
      const b = bare(cand);
      if (!b) continue;
      if (!buckets.has(b)) buckets.set(b, new Set());
      buckets.get(b).add(r);
    }
  }
  const hit = buckets.get(key);
  return hit && hit.size === 1 ? [...hit][0] : null;
}

/**
 * What the identity agent is allowed to be told.
 *
 * DELIBERATELY NOT THE WHOLE ROW. The old baseline spread `...LAKES[key]`, which handed the model
 * `duke: "wateree"`, `river: "02148000"` and `ahq: "lake-wateree"` — foreign keys for three other
 * services, presented as curated facts about the lake. A USGS site number sitting in a baseline
 * labelled "TrollMap curated" is an invitation to write it into a field that wants something else.
 *
 * What is here is what the agent's own rules say it gets wrong: county (it must not be null when
 * the information exists), surfaceAreaAcres (it must not be km2), and the pool elevation (it must
 * not be a fluctuation range). Those three plus the name the registry actually ships.
 *
 * `normalPoolFt` is passed in rather than looked up, and it carries its own source string, because
 * the only acceptable pool number here is one a live feed published today. The constant it
 * replaces was hand-typed and identical to what Duke was already serving.
 */
export function identityBaseline(row, pool = null) {
  if (!row || typeof row !== 'object') return null;
  // Number(null) IS 0, AND SO IS Number(''). This function had `Number.isFinite(Number(v))` for
  // about ten minutes and my own test caught it: a row with area_acres null reported a lake of
  // zero acres, and a pool of `{ ft: null }` reported a full pond at sea level. Seventh instance
  // of this family this week. Absence is checked BEFORE the conversion, never after.
  //
  // AND Number('   ') IS ALSO 0, which the first fix missed and the test caught on the next run.
  // So does Number([]) and Number([7]). Only a number or a non-blank string is a number here;
  // everything else is absence.
  const n = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v !== 'string' || v.trim() === '') return null;
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  };
  const out = {
    source: 'TrollMap registry — registry/lake_index.json, built by consolidate_lake_index.py',
    slug: row.slug || null,
    displayName: row.display_name || row.name || null,
    name: row.name || null,
    state: row.state || null,
    county: row.county || null,
    gnis: row.gnis || null,
    surfaceAreaAcres: n(row.area_acres),
    centroid: Array.isArray(row.centroid) && row.centroid.length === 2 ? row.centroid : null,
    featureType: row.feature_type || null,
    normalPoolFt: null,
    normalPoolSource: null,
    note: 'Registry identity, not a measurement. Verify against official sources; do not trust '
        + 'blindly. A null field means the registry does not carry it, NOT that the lake has none.',
  };
  // A GNIS id that is really a slug is not a GNIS id. consolidate_lake_index.py writes
  // "slug:congaree_river" where no GNIS feature exists, and passing that off as a federal
  // identifier is how a model comes to cite one.
  if (out.gnis && !/^gnis:/i.test(out.gnis)) out.gnis = null;
  const ft = pool ? n(pool.ft) : null;
  if (ft !== null) {
    out.normalPoolFt = ft;
    out.normalPoolSource = pool.source || null;
  }
  return out;
}
