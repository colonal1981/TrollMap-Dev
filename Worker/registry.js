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
export const WATER_CHAIN_KEY = '_registry/water_chain.json';
export const DAM_TABLE_KEY = '_registry/dam_table.json';
export const NC_SPECIES_KEY = '_registry/nc_species_by_lake.json';
export const REGULATIONS_KEY = '_registry/regulations.json';
export const FULL_POOL_KEY = '_registry/full_pool.json';
export const INDEX_TTL_S = 3600;

let _index = null;
let _indexAt = 0;
let _chain = null;
let _chainAt = 0;
let _dams = null;
let _damsAt = 0;
let _ncSpecies = null;
let _ncSpeciesAt = 0;

/** Exposed for tests. Nothing in the Worker should need to call this. */
export function _resetIndexCache() {
  _regs = null; _regsAt = 0;
  _pool = null; _poolAt = 0;
  _index = null; _indexAt = 0; _chain = null; _chainAt = 0; _dams = null; _damsAt = 0;
  _ncSpecies = null; _ncSpeciesAt = 0;
}

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

/**
 * Which waters sit immediately above and below each one.
 *
 * WHAT THIS IS FOR. Duke publishes one release row per powerhouse and nothing in the payload says
 * which side of a lake a given dam is on. Ryan: *"for wateree if fishing north end then cedar
 * creek dam release would flow down into the lake"*. The dam above is inflow, the lake's own is
 * outflow, and telling them apart needs the river network. `releaseDirection()` in conditions.js
 * reads `upstream` from here.
 *
 * DERIVED, NOT TYPED. build_water_chain.py walks NHDPlus HR: HydroSeq decreases downstream, so a
 * lake's outlet is its minimum, and following DnHydroSeq to the next registry water gives the
 * neighbour. It re-measures that direction per basin and refuses one that is not clean.
 *
 * `side_channel` marks an oxbow -- a water whose upstream basin dwarfs its own catchment, like
 * lowthers_lake off the Big Pee Dee at 21,302 km2 against 25.2. Its level follows the river's
 * gauge, not a pool elevation, which is the opposite of how a storage reservoir behaves.
 *
 * MISSING IS NOT EMPTY. Same rule as lakeIndex: a bucket without the object throws and names the
 * script that writes it, because an unpublished chain and a chain that places nothing look
 * identical from here and mean completely different things.
 */
export async function waterChain(env, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  if (!opts.fresh && _chain && now - _chainAt < INDEX_TTL_S * 1000) return _chain;
  const bucket = (env && env.R2_TROLLMAP_CHARTPACKS) || opts.bucket;
  if (!bucket) throw new Error('R2_TROLLMAP_CHARTPACKS is not bound to this Worker');
  const obj = await bucket.get(WATER_CHAIN_KEY);
  if (!obj) {
    throw new Error(`${WATER_CHAIN_KEY} is not in the bucket — run build_water_chain.py --write, `
                  + 'then upload_garmin_to_r2.py --registry');
  }
  // r2Text, NOT obj.text(). test/r2-gzip.test.js asserts no Worker file calls text() directly.
  const parsed = JSON.parse(await r2Text(obj));
  const rows = parsed && (parsed.waters || parsed);
  if (!rows || typeof rows !== 'object' || Array.isArray(rows)) {
    throw new Error(`${WATER_CHAIN_KEY} is not an object keyed by slug`);
  }
  _chain = rows;
  _chainAt = now;
  return rows;
}

/**
 * Which water each dam impounds.
 *
 * THE CHAIN SAYS WHICH WATER IS UPSTREAM. THIS SAYS WHICH WATER A DAM BELONGS TO.
 * `releaseDirection()` in conditions.js needs both: without the chain it cannot tell above from
 * below, and without this it cannot tell what "Cedar Creek" refers to. Duke publishes one row
 * per powerhouse and never says which lake it sits on.
 *
 * MERGED FROM TWO SOURCES THAT COVER DIFFERENT GROUND. The derived half binds every USACE dam
 * to a registry water by POSITION and makes it agree with the chain's drainage before it counts
 * -- an independent survey and a network derivation landing on the same number. The hand half
 * is read off Duke's own plant map and wins on conflict, because the survey genuinely cannot
 * separate the Great Falls-Dearborn structures: they all report 4,140 sq mi, which is inside
 * tolerance of two pools at once.
 *
 * Keys are spelled by normalizeDamName(), so a lookup here and a Duke payload agree.
 */
export async function damTable(env, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  if (!opts.fresh && _dams && now - _damsAt < INDEX_TTL_S * 1000) return _dams;
  const bucket = (env && env.R2_TROLLMAP_CHARTPACKS) || opts.bucket;
  if (!bucket) throw new Error('R2_TROLLMAP_CHARTPACKS is not bound to this Worker');
  const obj = await bucket.get(DAM_TABLE_KEY);
  if (!obj) {
    throw new Error(`${DAM_TABLE_KEY} is not in the bucket — run build_duke_dam_table.py and `
                  + 'bind_dams_to_waters.py, then upload_garmin_to_r2.py');
  }
  const parsed = JSON.parse(await r2Text(obj));
  const rows = parsed && (parsed.dams || parsed);
  if (!rows || typeof rows !== 'object' || Array.isArray(rows)) {
    throw new Error(`${DAM_TABLE_KEY} is not an object keyed by dam name`);
  }
  _dams = rows;
  _damsAt = now;
  return rows;
}

/**
 * Fish species per North Carolina water, keyed by registry slug.
 *
 * WHY NORTH CAROLINA HAS ITS OWN FILE. `RESEARCH_RAMP_SOURCES` reads a species list off each
 * state's ramp feed, and NC is the one state that publishes none: the NC WRC Boating Access
 * Areas layer carries 42 fields and no species among them, so `getRampSpeciesFacts` returns
 * nothing for every NC water. NC is also the one state absent from `AGENCY_INDEXES` -- SC has
 * SCDNR lake pages, TN has TWRA reservoir pages, GA has its StoryMaps, and NC WRC publishes a
 * map instead of pages. So North Carolina had neither source, and biology fell entirely to
 * whatever the web agents could find. Lake Glenville (Jackson Co, NC) came back on 2026-08-24
 * with zero predator species and biology gated at 35% while carrying the word "walleye" in its
 * own summary keywords.
 *
 * The map's own backend answers it. `build_nc_species_by_lake.py` joins ncpaws.org's location
 * list to the registry and writes this file; the uploader publishes it beside lake_index.json.
 *
 * Cached per isolate for an hour, same cadence and same failure mode as the three above: the
 * object changes when the PIPELINE uploads, not when the Worker deploys, and a missing object
 * is an error naming the script that writes it rather than a silent empty map. The caller in
 * research/deterministic.js catches, because a lake with no species file must still produce a
 * profile.
 */
export async function ncSpeciesByLake(env, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  if (!opts.fresh && _ncSpecies && now - _ncSpeciesAt < INDEX_TTL_S * 1000) return _ncSpecies;
  const bucket = (env && env.R2_TROLLMAP_CHARTPACKS) || opts.bucket;
  if (!bucket) throw new Error('R2_TROLLMAP_CHARTPACKS is not bound to this Worker');
  const obj = await bucket.get(NC_SPECIES_KEY);
  if (!obj) {
    throw new Error(`${NC_SPECIES_KEY} is not in the bucket -- run build_nc_species_by_lake.py, `
                  + 'then upload_garmin_to_r2.py');
  }
  const parsed = JSON.parse(await r2Text(obj));
  const rows = parsed && parsed.lakes;
  if (!rows || typeof rows !== 'object' || Array.isArray(rows)) {
    throw new Error(`${NC_SPECIES_KEY} has no "lakes" object keyed by registry slug`);
  }
  _ncSpecies = rows;
  _ncSpeciesAt = now;
  return rows;
}

let _regs = null;
let _regsAt = 0;
let _pool = null;
let _poolAt = 0;

/**
 * The law, parsed from the state books by build_regulations_table.py.
 *
 * Fifth object in this family and the same contract as the four above it: read from R2, cached
 * per isolate for an hour, and a missing object is an error naming the script that writes it
 * rather than a silent empty map. It changes when the PIPELINE uploads, not when the Worker
 * deploys.
 *
 * WHY IT EXISTS AT ALL. Regulations were being re-derived per lake by an LLM. Four Santee-area
 * lakes reading one South Carolina book returned four different subsets of it in three different
 * shapes, and `June 16 - Sept. 30 closed` -- the rule governing Lake Marion and Lake Moultrie --
 * survived into ONE of 63 saved profiles with the word "closed" stripped off it. The law is not
 * per-lake research; it is a handful of tables that change once a year.
 */
/**
 * FULL POOL PER WATER -- the elevation a Garmin chart was sounded to.
 *
 * Built offline into registry/full_pool.json and published slim. 71 waters as of 2026-08-27,
 * up from 55 that morning: twelve Duke lakes read off the operator's own
 * /lakes/operating-range payload, and Secession from the City of Abbeville's FERC rule curve.
 *
 * WHY IT SHIPS AS `{ft, units, source, datum}` AND NOT A BARE NUMBER. The datum is half the
 * fact. Duke states NGVD 29; the NWS gauges state NAVD88 on 38 waters and NGVD29 on 15; the two
 * differ by roughly half a foot to a foot in the Carolinas, which is the same size as a real
 * drawdown on a lake held near full. Subtracting across them produces a number that looks like
 * feet and is not -- so a caller that means to subtract has to be able to check first.
 *
 * ABSENT IS NOT ZERO. A water with no row has never been looked up, and `no_full_pool` carries
 * the ones where the question is a category error -- a river and a tidal zone have no pool.
 */
export async function fullPoolTable(env, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  if (!opts.fresh && _pool && now - _poolAt < INDEX_TTL_S * 1000) return _pool;
  const bucket = (env && env.R2_TROLLMAP_CHARTPACKS) || opts.bucket;
  if (!bucket) throw new Error('R2_TROLLMAP_CHARTPACKS is not bound to this Worker');
  const obj = await bucket.get(FULL_POOL_KEY);
  if (!obj) {
    throw new Error(`${FULL_POOL_KEY} is not in the bucket -- run upload_garmin_to_r2.py`);
  }
  const parsed = JSON.parse(await r2Text(obj));
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`${FULL_POOL_KEY} did not parse to an object`);
  }
  _pool = parsed;
  _poolAt = now;
  return parsed;
}


export async function regulationsTable(env, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  if (!opts.fresh && _regs && now - _regsAt < INDEX_TTL_S * 1000) return _regs;
  const bucket = (env && env.R2_TROLLMAP_CHARTPACKS) || opts.bucket;
  if (!bucket) throw new Error('R2_TROLLMAP_CHARTPACKS is not bound to this Worker');
  const obj = await bucket.get(REGULATIONS_KEY);
  if (!obj) {
    throw new Error(`${REGULATIONS_KEY} is not in the bucket -- run build_regulations_table.py, `
                  + 'then upload_garmin_to_r2.py');
  }
  const parsed = JSON.parse(await r2Text(obj));
  if (!parsed || typeof parsed.by_water !== 'object' || !parsed.by_water) {
    throw new Error(`${REGULATIONS_KEY} has no "by_water" object keyed by registry slug`);
  }
  _regs = parsed;
  _regsAt = now;
  return parsed;
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
export function identityBaseline(row, pool = null, poolManagement = null) {
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

  // THE DRAWDOWN SCHEDULE, WHEN THE OPERATOR PUBLISHES IT AS DATA.
  //
  // The identity agent's prompt tells it to find a Duke CRA pool table inside a PDF and extract
  // "Month | Guide Curve | Minimum | Maximum" out of it. /lakes/operating-range returns exactly
  // that table as JSON for every Duke lake with a location id. Handed over here, the agent has
  // nothing to extract and nothing to get wrong.
  //
  // IT ALSO CORRECTS A DATUM BUG IN THAT PROMPT. "normalPoolFt to the Maximum column value" is
  // 100 on a Duke lake — the top of the local index — where the field wants feet NGVD/NAVD.
  // Wateree's full pond is 225.5. Both scales are published here and each is labelled.
  if (poolManagement && poolManagement.poolManagement) {
    out.normalPoolFt = n(poolManagement.normalPoolFt) ?? out.normalPoolFt;
    out.normalPoolDatum = poolManagement.normalPoolDatum || null;
    out.normalPoolSource = poolManagement.source || out.normalPoolSource;
    out.drawdownType = poolManagement.drawdownType || null;
    out.seasonalDrawdownFt = n(poolManagement.seasonalDrawdownFt);
    out.poolManagement = poolManagement.poolManagement;
  }
  return out;
}
