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
 *   /paddle      — SCDNR paddling access sites (enabled 2026-08-02)
 * (/bank-pier and /attractors are defined in ACCESS_SOURCES below but stay off —
 *  see the note there.)
 *
 * Plus, since 2026-08-02, the offline-built 3DHP lake registry (data/lake-registry.js).
 * That is what lets the picker show a lake no state agency lists a ramp on — Wittee Lake
 * being the case that proved it: SCDNR HAS a ramp there, and the app could not show the
 * lake, so the ramp was unreachable. The registry is merged last and deduped against the
 * worker data, so it only ever adds.
 *
 * This module intentionally does NOT import ../data/lakes.js or
 * ../data/ramps.js. Mixing those old curated/static lists with the worker
 * data was causing duplicate lake and launch entries after the worker
 * routes became authoritative.
 */

import { state } from '../core/state.js';
import { SCDNR_STATE_LAKES } from './scdnr-state-lakes.js';
import { USER_KNOWN_LAKES } from './user-known-lakes.js';
import { COASTAL_ZONES } from './coastal-zones.js';
import { loadLakeRegistry, filterLakes, accessPointsFor, getLoadedRegistry } from './lake-registry.js';
import { registerR2Key } from './lake-keys.js';

// Manual coastal ramps not in DNR ArcGIS feed — add here when a known
// kayak/small-boat launch is missing from the official database.
const COASTAL_MANUAL_RAMPS = [
  {
    zoneName: 'Murrells Inlet / Pawleys Island, SC',
    name: 'Oyster Landing (Kayak/Sm Boat)',
    lat: 33.54751,
    lon: -79.04484,
    note: 'Open beach kayak/small boat launch at end of dirt road near Huntington State Park entrance',
  },
];

const STATES = ['SC', 'NC', 'GA', 'TN'];
const ACCESS_SOURCES = [
  { path: '/ramps', label: 'Boat ramp', marker: '🛥️' },
  // /paddle enabled 2026-08-02. Its NC field mapping was verified alongside /ramps in the
  // 2026-07-03 worker fix (see trollmap-worker.js RAMP_SOURCES.NC), which is what the note
  // below was waiting on. It is a purpose-built paddling-launch feed — 131 sites over 67
  // waterbodies in SC — and a kayak launch is often the ONLY access a small impoundment has.
  { path: '/paddle', label: 'Paddle launch', marker: '🛶' },
  // /bank-pier stays off: Ryan's explicit call, a bank/pier point is not a launch and would
  // make lakes look reachable by boat when they are not. /attractors NC field mappings are
  // still unverified against the live ArcGIS schema.
  // { path: '/bank-pier', label: 'Bank / pier access', marker: '🎣' },
];

// Registry lakes shown by default: the ones with a chartpack, i.e. with Garmin soundings.
// 434 of 1,551. Access is a badge on the record, never the gate -- see lake-registry.js
// DEFAULT_FILTER for why every access-based default hid a lake Ryan actually fishes.
const REGISTRY_DEFAULT_FILTER = { shippedOnly: true };

let accessIndexPromise = null;
let accessIndex = {
  lakeNames: [],
  byLake: new Map(),
  // slug -> registry record, and lake display name -> registry record, for every lake the
  // registry contributed. Callers that need a centroid, an access verdict or an R2 slug read
  // these; byLake stays what it always was, a name -> access-point list.
  registryByName: new Map(),
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

  // Append state suffix to all waterbodies — creeks, rivers, and branches
  // are just as ambiguous as lakes across a 4-state coverage area.
  return `${name}, ${stateCode}`;
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

// Generic waterbody words carry no identity. "Parr Shoals" and "Parr Shoals Reservoir" are one
// water; "Lake Wateree" and "Wateree Lake" are one water. Stripping these is what lets a DNR
// name meet a 3DHP name in the middle.
//
// It is NOT safe on its own and must never be used without the bbox check below: `Lake Murray`
// (48,761 ac) and `Murray Pond` (148 ac) both reduce to "murray", they are 12 miles apart, and
// the 15-mile radius test would happily merge them. The audit called that pair out by name.
const GENERIC_WATER_WORDS = /\b(lake|lakes|reservoir|pond|millpond|mill\s+pond|impoundment|sp|state\s+park|the)\b/g;

export function lakeNameLooseKey(name) {
  return lakeNameDedupKey(name).replace(GENERIC_WATER_WORDS, ' ').replace(/[^a-z0-9]+/g, '');
}

// Every name a registry record answers to, not just its primary one.
//
// This is the fix for the duplicate rows. `lake_index.json` already ships the curated
// disagreements as `legacy_display_names` -- wateree_lake carries ['Wateree Lake, SC',
// 'Lake Wateree, SC'], lake_william_c_bowen carries 'Lake Bowen, SC' -- and lake-registry.js
// already indexes all of them. findExistingLakeKey was only ever handed `rec.name`, so the
// variants were downloaded on every page load and never consulted, and the DNR name sat in the
// picker beside the registry name as a second row for the same water.
function recordNameVariants(rec, plainName) {
  const out = [];
  const push = (n) => { if (n && !out.includes(n)) out.push(n); };
  push(plainName);
  if (rec) {
    push(rec.name);
    push(rec.displayName);
    push(rec.legacyDisplayName);
    for (const n of (rec.legacyDisplayNames || [])) push(n);
  }
  return out;
}

// Is this access point inside the lake's own bounding box? Padded, because a boat ramp sits on
// the SHORE -- strictly outside the water polygon -- and an unpadded box rejects most of them.
// 0.005 deg is about 550 m, the same order as the river cutter's --ramp-tol.
function pointInRecordBounds(rec, lat, lon, padDeg = 0.005) {
  const b = rec && rec.boundsWSEN;
  if (!Array.isArray(b) || b.length !== 4) return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  const [w, s, e, n] = b;
  return lat >= s - padDeg && lat <= n + padDeg && lon >= w - padDeg && lon <= e + padDeg;
}

// A DNR waterbody name can cover two lakes that have nothing to do with each other.
// SC's "Lake Robinson" carries two ramps 203 km apart -- J. Verne Smith Park on Greenville
// Water's Lake Robinson, and the Duke cooling lake on Black Creek near Hartsville. GA's
// "Lake Russell" and "White Oak Creek" do the same at 345 and 352 km. The picker built ONE
// entry from the name, the map fitted every point in it, and selecting the lake zoomed out
// to a viewport spanning both.
//
// Splitting the NAME into clusters would be guesswork. The registry record already knows
// where its water is, so once a record has claimed an entry, drop the points that are not
// on it. Bounds plus a 5 km margin, because a ramp can sit up a tributary or down an access
// road; on a big reservoir the bbox is large and nothing is dropped.
//
// Deliberately conservative: it never empties an entry, and it never touches an entry no
// registry record claimed -- a river or the Intracoastal SHOULD span 300 km, and those have
// no bounds to be judged against anyway.
export function pruneAccessToRecord(index, lakeName, rec, marginKm = 5) {
  const b = rec && rec.boundsWSEN;
  if (!Array.isArray(b) || b.length !== 4) return 0;
  const pts = index.byLake.get(lakeName);
  if (!pts || pts.length < 2) return 0;
  const [w, s, e, n] = b;
  const dLat = marginKm / 111;
  const keep = pts.filter((p) => {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return true;
    const dLon = marginKm / (111 * Math.max(0.1, Math.cos(p.lat * Math.PI / 180)));
    return p.lat >= s - dLat && p.lat <= n + dLat && p.lon >= w - dLon && p.lon <= e + dLon;
  });
  if (!keep.length || keep.length === pts.length) return 0;
  index.byLake.set(lakeName, keep);
  return pts.length - keep.length;
}

// One water, several DNR names, TWO feeds.
//
// `findExistingLakeKey` returns ONE key and stops, which is right for choosing what to call
// the lake and wrong for cleaning up after it. Fishing Creek Reservoir arrives twice: as
// "Fishing Creek Reservoir" on /ramps and as "Fishing Creek" on /paddle. Pass A matches the
// first exactly, returns, and the paddle entry is orphaned in the picker as its own row with
// one access point and no pack behind it -- so it looks like a lake with no contours.
//
// So after a record has claimed its entry, absorb the OTHER entries that are demonstrably the
// same water: same loose name, and EVERY one of their points inside this lake's bounds.
//
// "Every", not "some", on purpose. A creek that runs past a reservoir and out the other side
// has points outside it and is genuinely different water -- Fishing Creek the creek is not
// Fishing Creek Reservoir. Requiring all of them means a name only collapses when there is
// nothing left of it outside the lake.
export function absorbDuplicateEntries(index, lakeName, rec) {
  const b = rec && rec.boundsWSEN;
  if (!Array.isArray(b) || b.length !== 4 || !index.byLake.has(lakeName)) return 0;
  const target = lakeNameLooseKey(lakeName);
  if (!target || target.length < 3) return 0;
  const keep = index.byLake.get(lakeName);
  let absorbed = 0;
  for (const other of [...index.byLake.keys()]) {
    if (other === lakeName) continue;
    if (lakeNameLooseKey(other) !== target) continue;
    const pts = index.byLake.get(other) || [];
    if (!pts.length) continue;
    if (!pts.every((p) => pointInRecordBounds(rec, p.lat, p.lon))) continue;
    for (const p of pts) {
      const dup = keep.some((q) => q.name === p.name
        && Math.abs((q.lat || 0) - (p.lat || 0)) < 1e-6
        && Math.abs((q.lon || 0) - (p.lon || 0)) < 1e-6);
      if (!dup) keep.push(p);
    }
    index.byLake.delete(other);
    index.registryByName.delete(other);
    absorbed += 1;
  }
  return absorbed;
}

// Look for an existing lake in the index (typically worker-derived) whose name matches a
// supplemental lake we're about to add, so we merge into it instead of creating a
// visually-duplicate second dropdown entry.
//
// TWO passes, and they cover different things -- neither is redundant:
//
//   A. exact name, any variant, + the 15-mile radius. Handles the curated disagreements that
//      no rule could derive: Clarks Hill Lake is J. Strom Thurmond Reservoir; the DNR's
//      "Lake Bowen" is lake_william_c_bowen in SC and NOT the Bowen Lake in Evans Co, GA.
//   B. loose name + the point actually inside this lake's bbox. Handles mechanical variation
//      no table should have to enumerate -- Lake X / X Lake, apostrophes, "SP Lake", Pond vs
//      Millpond -- which matters because the DNR feeds are a LIVE ArcGIS pull. A name that
//      changes upstream next month still merges without anyone regenerating a file.
//
// Pass B refuses on geometry where a name alone would say yes, which is the point: on the live
// feeds it merges 24 more waterbodies while correctly declining Lake Bowen -> Bowen Lake (GA),
// LAKE JORDAN -> Jordan Millpond (GA), Blalock Reservoir -> Lake Blalock (SC), and
// Fox Lake (GA) -> Fox Reservoir (NC).
export function findExistingLakeKey(index, plainName, lat, lon, maxMiles = 15, rec = null) {
  const variants = recordNameVariants(rec, plainName);
  const exactKeys = new Set(variants.map(lakeNameDedupKey).filter(Boolean));
  if (!exactKeys.size) return null;

  const pointsFor = (existingName) => index.byLake.get(existingName) || [];

  // Pass A — exact on any variant, guarded by distance.
  for (const existingName of index.byLake.keys()) {
    if (!exactKeys.has(lakeNameDedupKey(existingName))) continue;
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      const anyClose = pointsFor(existingName)
        .some(p => approxMiles(lat, lon, p.lat, p.lon) <= maxMiles);
      if (!anyClose) continue; // same name, too far away — different lake, keep separate
    }
    return existingName;
  }

  // Pass B — loose name, guarded by containment rather than radius. Requires a record with
  // real bounds; without them there is no second signal and we decline rather than guess.
  const looseKeys = new Set(variants.map(lakeNameLooseKey).filter(k => k && k.length >= 3));
  if (!looseKeys.size || !rec || !Array.isArray(rec.boundsWSEN)) return null;
  for (const existingName of index.byLake.keys()) {
    if (!looseKeys.has(lakeNameLooseKey(existingName))) continue;
    const pts = pointsFor(existingName);
    if (!pts.length) continue;                       // nothing to corroborate with
    if (!pts.some(p => pointInRecordBounds(rec, p.lat, p.lon))) continue;
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
  const index = { lakeNames: [], byLake: new Map(), registryByName: new Map() };

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

        // Map coastal ramps from state FWC / DNR APIs to our coastal zones based on bounding box and state
        if (source.path === '/ramps') {
          for (const [zoneKey, zone] of Object.entries(COASTAL_ZONES)) {
            if (zone.state === stateCode && zone.bbox) {
              const [[south, west], [north, east]] = zone.bbox;
              if (lat >= south && lat <= north && lon >= west && lon <= east) {
                addAccessItem(index, zone.name, {
                  name,
                  lat,
                  lon,
                  typeLabel: 'Coastal ramp',
                  sourcePath: source.path,
                  sourceState: stateCode,
                  marker: '⛵',
                  meta: raw.meta || {},
                  raw,
                });
              }
            }
          }
        }
      });
    });
  });

  // Sort lakes by state priority (SC first, then NC, GA, TN) then alphabetically within state
  const STATE_ORDER = { SC: 0, NC: 1, GA: 2, TN: 3 };
  function lakeStatePriority(name) {
    // Matches ", SC" at end OR "(County Co, SC)" parenthetical format from SCDNR state lakes
    const m = name.match(/,\s*([A-Z]{2}(?:\/[A-Z]{2})?)\)?$/) || name.match(/\(.*,\s*([A-Z]{2})\)\s*$/);
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

  // ── 3DHP lake registry ────────────────────────────────────────────────
  //
  // Merged LAST and deliberately: findExistingLakeKey() folds a registry lake into a
  // worker-derived entry when the names match and a known access point is within 15 miles,
  // so Wateree does not appear twice. What survives as a new entry is genuinely new — the
  // lakes no state ramp feed lists. On 2026-08-02 that is the difference between 213 lakes
  // and 322 accessible ones, including Wittee (SCDNR has the ramp; the LAKE was missing),
  // Ferry and Dawhoo.
  //
  // Awaited rather than fired-and-forgotten so the first populateLakeSelect() sees the full
  // list. loadLakeRegistry() swallows its own failure and returns an empty registry, so a
  // missing or unreachable index degrades to exactly the previous behaviour.
  try {
    await loadLakeRegistry();

    // PASS 1 -- KNOW about every lake. Adds nothing to the dropdown.
    //
    // This used to be folded into pass 2, so only the ~448 lakes the picker OFFERS ever got a
    // registryByName entry. Everything else in the list came from the DNR ramp feeds with no
    // registry record behind it -- and lake-ramp-select.js's passesFilters() opens with
    // `if (!rec) return true`, so those lakes ignored the state dropdown, the size band and
    // both checkboxes. Ryan, 2026-08-03: "your state dropdown, size, and check boxes do not
    // seem to have any effect". Measured on his live index: 1,089 names in the dropdown, 448
    // filterable, 641 immune. A filter bar that silently governs 41% of a list is worse than
    // no filter bar.
    //
    // A DNR-fed lake that 3DHP also named now carries its record, so the filters reach it.
    // `getLoadedRegistry().list` is sorted shipped-first then largest-first, and
    // findExistingLakeKey() matches on name AND position, so a small namesake cannot claim a
    // DNR entry that belongs to the big lake next to it.
    const all = getLoadedRegistry().list;
    for (const rec of all) {
      const key = findExistingLakeKey(index, rec.name, rec.lat, rec.lon, 15, rec) || rec.displayName;
      if (!index.registryByName.has(key)) index.registryByName.set(key, rec);
    }

    // PASS 2 -- OFFER the lakes the picker should show, and only those.
    //
    // R2 keys are registered HERE, not in pass 1, and that is deliberate: an unshipped lake
    // has no pack in R2, and resolveR2Key() treats a registry slug as authoritative over the
    // curated map. Registering one for an unshipped lake would take a name that currently
    // resolves to a real curated pack and point it at a 404.
    let added = 0;
    let pruned = 0;
    let folded = 0;
    for (const rec of filterLakes(REGISTRY_DEFAULT_FILTER)) {
      const existingKey = findExistingLakeKey(index, rec.name, rec.lat, rec.lon, 15, rec);
      const lakeName = existingKey || rec.displayName;
      if (!existingKey) added += 1;
      index.registryByName.set(lakeName, rec);   // shipped record wins over a pass-1 namesake
      pruned += pruneAccessToRecord(index, lakeName, rec);
      folded += absorbDuplicateEntries(index, lakeName, rec);
      // Teach lake-keys.js the slug so contour/chartpack loads resolve without fuzzy
      // matching. Curated names already in LAKE_NAME_TO_R2_KEY are left alone.
      registerR2Key(lakeName, rec.slug);

      const pts = accessPointsFor(rec);
      for (const p of pts) addAccessItem(index, lakeName, p);

      // A lake with no mapped ramp still has to be selectable and still has to fly the map
      // somewhere — that IS the discovery case, 141 of the 322. Without a point here the
      // entry would exist with an empty access list and the map would not move.
      if (!pts.length && !index.byLake.has(lakeName)) {
        index.byLake.set(lakeName, []);
      }
    }
    if (added) console.info(`[access-index] registry contributed ${added} lakes not in the DNR feeds`);
    if (pruned) console.info(`[access-index] dropped ${pruned} access point(s) that sit outside the lake they were filed under`);
    if (folded) console.info(`[access-index] folded ${folded} duplicate DNR name(s) into the lake they belong to`);
    // Was `registryByName.size of byLake.size`, which printed "1560 of 1104" — more than
    // all of them. The two maps are keyed differently: registryByName holds every registry
    // NAME VARIANT, byLake holds DNR waterbody names, and neither contains the other. The
    // number that means something is how many pickable names actually resolve.
    let filterable = 0;
    for (const name of index.byLake.keys()) if (index.registryByName.has(name)) filterable++;
    console.info(`[access-index] ${filterable} of ${index.byLake.size} pickable lake names `
               + `carry a registry record and are therefore filterable`);
  } catch (e) {
    console.warn('[access-index] registry merge skipped:', e?.message || e);
  }

  // Merge manual coastal ramps not in DNR feed
  for (const ramp of COASTAL_MANUAL_RAMPS) {
    addAccessItem(index, ramp.zoneName, {
      name: ramp.name,
      lat: ramp.lat,
      lon: ramp.lon,
      typeLabel: 'Kayak/Small Boat Launch',
      sourcePath: 'manual',
      sourceState: 'SC',
      marker: '🛶',
      meta: { note: ramp.note },
    });
  }

  // Rebuild the name list LAST. The earlier sort ran before the registry and the manual
  // coastal ramps were merged, so anything added after it would exist in byLake and never
  // appear in the dropdown — a silent omission of exactly the new lakes this is for.
  index.lakeNames = [...index.byLake.keys()].sort((a, b) => {
    const diff = lakeStatePriority(a) - lakeStatePriority(b);
    return diff !== 0 ? diff : a.localeCompare(b);
  });

  if (failures.length) {
    console.warn('[access-index] Some worker access feeds failed:', failures);
  }

  return index;
}

/** The registry record behind a picker entry, or null if it came from a DNR feed. */
export function registryRecordFor(lakeName) {
  return accessIndex.registryByName?.get(lakeName) || null;
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
window.getLoadedAccessIndex = function getLoadedAccessIndex() {
  return accessIndex;
};

// Kick off the load immediately — don't block module loading. Both
// lake-ramp-select.js and catch-journal.js will share this same in-flight
// promise instead of triggering their own separate worker fetches.
loadAccessIndex().catch((e) => {
  console.warn('[access-index] initial load failed:', e);
});
