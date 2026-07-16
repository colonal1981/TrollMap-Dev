/**
 * access-index.js — Shared worker-backed access-point index.
 *
 * Pulled out of lake-ramp-select.js (2026-07-03) so more than one module can
 * use the same live DNR data without hitting the worker twice or drifting
 * out of sync. Currently used by:
 *   - lake-ramp-select.js  (Lake / Access dropdowns in the map toolbar)
 *   - catch-journal.js     (nearest-lake lookup for imported catches)
 *
 * Sources pulled from the worker:
 *   /ramps       — boat ramps
 * (paddle / bank-pier / attractors are defined in ACCESS_SOURCES below but
 *  commented out by default — see note there before enabling.)
 *
 * This module intentionally does NOT import ../data/lakes.js or
 * ../data/ramps.js. Mixing those old curated/static lists with the worker
 * data was causing duplicate lake and launch entries after the worker
 * routes became authoritative.
 */

import { state } from '../core/state.js';
import { SCDNR_STATE_LAKES } from './scdnr-state-lakes.js';
import { USER_KNOWN_LAKES } from './user-known-lakes.js';

const STATES = ['SC', 'NC', 'GA', 'TN'];
const ACCESS_SOURCES = [
  { path: '/ramps', label: 'Boat ramp', marker: '🛥️' },
  // NOTE: /bank-pier and /attractors NC field-mappings haven't been verified
  // against the live ArcGIS schema the way /ramps and /paddle have (see
  // trollmap-worker.js RAMP_SOURCES.NC comment, fixed 2026-07-03). Enable
  // these once confirmed, or they may silently under-report NC like /ramps
  // did.
  // { path: '/paddle', label: 'Paddle launch', marker: '🛶' },
  // { path: '/bank-pier', label: 'Bank / pier access', marker: '🎣' },
];

let accessIndexPromise = null;
let accessIndex = {
  lakeNames: [],
  byLake: new Map(),
};

// ── Worker URL helpers ──────────────────────────────────────────────────

function getWorkerBase() {
  // Prefer an app-provided worker URL if one exists. On GitHub Pages there is
  // no same-origin /ramps route, so same-origin gives 404s like:
  //   https://colonal1981.github.io/TrollMap-Dev/ramps?state=SC
  // Default to the deployed Cloudflare Worker instead.
  const explicit =
    window.TROLLMAP_WORKER_URL ||
    window.TROLLMAP_WORKER_BASE ||
    window.WORKER_URL ||
    window.API_BASE ||
    'https://trollmap-worker.colonal1981.workers.dev';
  return String(explicit || '').replace(/\/$/, '');
}

function workerUrl(path, stateCode) {
  return `${getWorkerBase()}${path}?state=${encodeURIComponent(stateCode)}`;
}

// ── Normalization / dedupe helpers ───────────────────────────────────────

function normalizeWaterbodyName(name) {
  return String(name || '')
    .replace(/\s+/g, ' ')
    .replace(/\b(reservoir|lake)\s+lake\b/ig, 'Lake')
    .trim();
}

function displayLakeName(rawName, stateCode) {
  const name = normalizeWaterbodyName(rawName);
  if (!name || /^unknown/i.test(name)) return '';

  // If the official data already carries state context, keep it as-is.
  if (/\b(SC|NC|GA|TN|AL|VA)\b/.test(name)) return name;

  // Do not force state suffixes for rivers/coastal waterways; for lakes, a
  // suffix helps distinguish same-named waterbodies while remaining readable.
  if (/\blake\b|\breservoir\b/i.test(name)) return `${name}, ${stateCode}`;
  return name;
}

function normalizeNameKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(boat ramp|ramp|landing|access area|access|launch|public|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Separate, looser key used only for detecting "is this the same LAKE under a
// different naming convention" — e.g. worker-derived "Wee Tee Lake, SC" vs.
// our supplemental "Wee Tee Lake (Williamsburg Co, SC)". Strips parentheticals
// and anything after a comma so county/state suffixes don't block a match.
function lakeNameDedupKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/,.*$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Look for an existing lake in the index (typically worker-derived) whose
// name matches a supplemental lake we're about to add, so we merge into it
// instead of creating a visually-duplicate second dropdown entry. A loose
// distance sanity check guards against merging two different lakes that
// happen to share a name in different regions.
function findExistingLakeKey(index, plainName, lat, lon, maxMiles = 15) {
  const targetKey = lakeNameDedupKey(plainName);
  if (!targetKey) return null;
  for (const existingName of index.byLake.keys()) {
    if (lakeNameDedupKey(existingName) !== targetKey) continue;
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      const pts = index.byLake.get(existingName) || [];
      const anyClose = pts.some(p => approxMiles(lat, lon, p.lat, p.lon) <= maxMiles);
      if (!anyClose) continue; // same name, too far away — different lake, keep separate
    }
    return existingName;
  }
  return null;
}

function coordKey(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '';
  // ~35-40 ft buckets: tight enough to merge the same site from different
  // layers without collapsing genuinely separate access points in one park.
  return `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

function accessDedupeKey(item) {
  const cKey = coordKey(item.lat, item.lon);
  const nKey = normalizeNameKey(item.name);
  if (cKey && nKey) return `${cKey}|${nKey}`;
  return cKey || nKey;
}

function formatAccessLabel(item) {
  const prefix = item.marker ? `${item.marker} ` : '';
  return `${prefix}${item.name}${item.typeLabel ? ` — ${item.typeLabel}` : ''}`;
}

function addAccessItem(index, lakeName, item) {
  if (!lakeName || !item || !Number.isFinite(item.lat) || !Number.isFinite(item.lon)) return;

  if (!index.byLake.has(lakeName)) index.byLake.set(lakeName, []);
  const list = index.byLake.get(lakeName);
  const nextKey = accessDedupeKey(item);

  const existing = list.find((x) => accessDedupeKey(x) === nextKey);
  if (existing) {
    // Preserve all source categories if a spot appears in more than one worker
    // route, but keep only one dropdown entry.
    const labels = new Set([...(existing.sourceLabels || [existing.typeLabel]), item.typeLabel].filter(Boolean));
    existing.sourceLabels = [...labels];
    existing.typeLabel = existing.sourceLabels.join(' / ');
    return;
  }

  list.push(item);
}

// ── Worker data load ─────────────────────────────────────────────────────

async function fetchAccessSource(source, stateCode) {
  const res = await fetch(workerUrl(source.path, stateCode), { cache: 'no-store' });
  if (!res.ok) throw new Error(`${source.path}?state=${stateCode} returned HTTP ${res.status}`);
  const data = await res.json();
  return { source, stateCode, data };
}

async function buildAccessIndex() {
  const index = { lakeNames: [], byLake: new Map() };

  const jobs = [];
  ACCESS_SOURCES.forEach((source) => {
    STATES.forEach((stateCode) => jobs.push(fetchAccessSource(source, stateCode)));
  });

  const results = await Promise.allSettled(jobs);
  const failures = [];

  results.forEach((result) => {
    if (result.status === 'rejected') {
      failures.push(result.reason?.message || String(result.reason));
      return;
    }

    const { source, stateCode, data } = result.value;
    const waterbodies = data?.waterbodies || {};

    Object.entries(waterbodies).forEach(([rawWaterbody, items]) => {
      const lakeName = displayLakeName(rawWaterbody, stateCode);
      if (!lakeName || !Array.isArray(items)) return;

      items.forEach((raw) => {
        const lat = Number(raw.lat);
        const lon = Number(raw.lon);
        const name = String(raw.name || 'Unnamed access point').trim();
        if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return;

        addAccessItem(index, lakeName, {
          name,
          lat,
          lon,
          typeLabel: source.label,
          sourcePath: source.path,
          sourceState: stateCode,
          marker: source.marker,
          meta: raw.meta || {},
          raw,
        });
      });
    });
  });

  // Sort lakes by state priority (SC first, then NC, GA, TN) then alphabetically within state
  const STATE_ORDER = { SC: 0, NC: 1, GA: 2, TN: 3 };
  function lakeStatePriority(name) {
    const m = name.match(/,\s*([A-Z]{2}(?:\/[A-Z]{2})?)$/);
    if (!m) return 99;
    const firstState = m[1].split('/')[0];
    return STATE_ORDER[firstState] ?? 99;
  }
  index.lakeNames = [...index.byLake.keys()].sort((a, b) => {
    const diff = lakeStatePriority(a) - lakeStatePriority(b);
    return diff !== 0 ? diff : a.localeCompare(b);
  });
  for (const list of index.byLake.values()) {
    list.sort((a, b) => formatAccessLabel(a).localeCompare(formatAccessLabel(b)));
  }

  // Merge in the SCDNR State Lakes Program supplement — small DNR-owned
  // fishing lakes that the worker's boat-ramp ArcGIS feeds don't cover (see
  // scdnr-state-lakes.js header). County kept in the display name to avoid
  // silently colliding with an unrelated same-named waterbody elsewhere.
  for (const lake of SCDNR_STATE_LAKES) {
    const existingKey = findExistingLakeKey(index, lake.name, lake.lat, lake.lon);
    const lakeName = existingKey || `${lake.name} (${lake.county} Co, ${lake.state})`;
    addAccessItem(index, lakeName, {
      name: lake.name,
      lat: lake.lat,
      lon: lake.lon,
      typeLabel: 'SCDNR State Lake',
      sourcePath: 'scdnr-state-lakes',
      sourceState: lake.state,
      marker: '🎣',
      meta: { acres: lake.acres, county: lake.county },
    });
  }

  // Merge in angler-flagged lakes not covered by any official feed — see
  // user-known-lakes.js header for per-lake sourcing.
  for (const lake of USER_KNOWN_LAKES) {
    const existingKey = findExistingLakeKey(index, lake.name, lake.lat, lake.lon);
    const lakeName = existingKey || `${lake.name} (${lake.county} Co, ${lake.state})`;
    addAccessItem(index, lakeName, {
      name: lake.name,
      lat: lake.lat,
      lon: lake.lon,
      typeLabel: 'User-known lake',
      sourcePath: 'user-known-lakes',
      sourceState: lake.state,
      marker: '📍',
      meta: { county: lake.county, note: lake.note },
    });
  }

  index.lakeNames = [...index.byLake.keys()].sort((a, b) => {
    const diff = lakeStatePriority(a) - lakeStatePriority(b);
    return diff !== 0 ? diff : a.localeCompare(b);
  });

  if (failures.length) {
    console.warn('[access-index] Some worker access feeds failed:', failures);
  }

  return index;
}

/**
 * Kick off (or return the in-flight/completed) load of the worker-backed
 * access index. Safe to call from multiple modules — only fetches once.
 */
export function loadAccessIndex() {
  if (!accessIndexPromise) {
    accessIndexPromise = buildAccessIndex().then((idx) => {
      accessIndex = idx;
      return idx;
    });
  }
  return accessIndexPromise;
}

/**
 * Synchronous accessor for whatever's currently loaded. Returns the empty
 * index (lakeNames: [], byLake: new Map()) if loadAccessIndex() hasn't
 * resolved yet — callers that need to guarantee data should await
 * loadAccessIndex() at least once first.
 */
export function getLoadedAccessIndex() {
  return accessIndex;
}

/**
 * Approximate distance in miles between two lat/lon points. Matches the
 * flat-earth approximation used elsewhere in TrollMap (contour lookups,
 * old LAKE_DB centroid lookups) rather than full haversine, since accuracy
 * beyond ~0.1mi doesn't matter at these ranges and it keeps results
 * consistent with the rest of the app.
 */
export function approxMiles(lat1, lon1, lat2, lon2) {
  const cosLat = Math.cos((lat1 * Math.PI) / 180);
  return Math.hypot((lat1 - lat2) * 69, (lon1 - lon2) * 69 * cosLat);
}

/**
 * Given a coordinate, find the nearest waterbody in the access index by
 * distance to its closest real DNR access point (not a guessed centroid).
 * Returns '' if nothing is within maxMiles of ANY known access point —
 * i.e. genuinely far from any tracked lake, rather than a stretch match.
 */
export function nearestLakeByAccessPoint(lat, lon, maxMiles = 2.0) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { lake: '', distanceMi: null };
  const idx = getLoadedAccessIndex();
  let bestLake = '';
  let bestDist = Infinity;

  for (const [lakeName, points] of idx.byLake.entries()) {
    for (const p of points) {
      const d = approxMiles(lat, lon, p.lat, p.lon);
      if (d < bestDist) {
        bestDist = d;
        bestLake = lakeName;
      }
    }
  }

  return bestDist <= maxMiles ? { lake: bestLake, distanceMi: bestDist } : { lake: '', distanceMi: bestDist === Infinity ? null : bestDist };
}

// Keep the old global helper names synchronous for legacy callers. They
// return the latest loaded worker-backed lake list; callers that need to
// force the first async load can use getUniversalLakeNamesAsync.
window.getUniversalLakeNames = function getUniversalLakeNames() {
  return accessIndex.lakeNames;
};
window.getUniversalLakeNamesAsync = async function getUniversalLakeNamesAsync() {
  const idx = await loadAccessIndex();
  return idx.lakeNames;
};

// Kick off the load immediately — don't block module loading. Both
// lake-ramp-select.js and catch-journal.js will share this same in-flight
// promise instead of triggering their own separate worker fetches.
loadAccessIndex().catch((e) => {
  console.warn('[access-index] initial load failed:', e);
});
