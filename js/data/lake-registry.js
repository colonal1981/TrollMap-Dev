/**
 * lake-registry.js — the 3DHP lake registry, with every access source joined on.
 *
 * WHAT THIS REPLACES
 *
 * TrollMap's lake picker has been fed by access-index.js, which builds its list from the
 * worker's /ramps route plus two hardcoded files (scdnr-state-lakes.js, 18 lakes;
 * user-known-lakes.js, 5). That means the app can only show a lake if a state wildlife
 * agency happens to list a ramp on it — 213 lakes have chartpacks in R2.
 *
 * The registry is built offline from USGS 3DHP grouped by GNIS id and joined against
 * PAD-US, the national boat-ramp CSV and OSM slipways (see build_lake_index.py). In the
 * four states it holds 1,551 lakes, 322 of which have public or credentialed land on the
 * bank. Wittee Lake, Ferry Lake and Dawhoo Lake are all in it; none of them reach the
 * picker today.
 *
 * NO WORKER CHANGE IS NEEDED. The existing /chartpacks/<key>/<file> route serves any R2
 * object, so the index lives at `_registry/lake_index.json` and comes back through the same
 * code path (including writeHttpMetadata, so a gzipped upload still decodes).
 *
 * WHY THE RECORDS KEEP EVERY SOURCE SEPARATE
 *
 * 215 lakes have a ramp in the national CSV and 210 in OSM, but only 139 in both. Neither
 * is a superset. A single `hasRamp` boolean would be wrong about a third of the time in
 * each direction, so `ramps` is an object keyed by source and `ramp_sources` counts how
 * many independently agree. Likewise `access` (what PAD-US says about the public) and
 * `access_for_me` (adjusted for Ryan's credentials) are separate fields and neither is ever
 * overwritten by ramp evidence — being able to launch and being allowed to be there are
 * different questions.
 */

const REGISTRY_PATH = '/chartpacks/_registry/lake_index.json';

// `charted` is null until the card-wide Garmin extraction runs, and null must never read as
// false — Garmin's coverage is partial WITHIN a lake (Wee Tee has three basins and the
// middle one is unsurveyed), so it is stored as a fraction, not a flag.
export const ACCESS_OPEN = new Set(['Open Access', 'Open With Credential']);

// REACHABLE, not OPEN, is the right default and this was got wrong first time round.
//
// Filtering to ACCESS_OPEN hides `Restricted Access` — and Wittee Lake and Ferry Lake are
// both Restricted, because their banks are Wee Tee State Forest and a state forest wants
// you registered. Those two are the whole reason this registry exists: SCDNR has a ramp on
// Wittee and the app could not show the lake. A default that hides them is worse than no
// filter at all.
//
// `Unknown` is included for the same reason it is never folded into Closed upstream — it
// means nobody recorded an access rule, which is not a decision to exclude the public. Only
// `Closed Access` is genuinely a no.
export const ACCESS_REACHABLE = new Set([
  'Open Access', 'Open With Credential', 'Restricted Access', 'Unknown',
]);

export const DEFAULT_FILTER = {
  states: null,          // null = all; else e.g. new Set(['SC'])
  minAcres: 0,
  maxAcres: Infinity,
  // Show a lake if it is not known-closed AND something suggests you can get to it: public
  // land on the bank in any class, or a ramp in any source. Roughly 550 of 1,551.
  reachableOnly: true,
  openOnly: false,       // stricter: public or credentialed only
  rampOnly: false,       // only lakes with at least one mapped ramp
  chartedOnly: false,    // only lakes with Garmin soundings (no-op while charted is null)
};

let registryPromise = null;
let registry = { bySlug: new Map(), byName: new Map(), list: [], loaded: false };

function workerBase() {
  const explicit =
    window.TROLLMAP_WORKER_URL ||
    window.TROLLMAP_WORKER_BASE ||
    window.WORKER_URL ||
    window.API_BASE ||
    'https://trollmap-worker.colonal1981.workers.dev';
  return String(explicit || '').replace(/\/$/, '');
}

/**
 * Display name for the picker. `display_name` from the registry is "Name, ST"; the state
 * suffix is kept because access-index.js's own lakeStatePriority() sorts on it, and because
 * `Lake Wallace` exists twice in SC alone at 273 and 155 acres.
 */
function displayName(rec) {
  return rec.display_name || `${rec.name}, ${rec.state}`;
}

async function fetchRegistry() {
  const url = `${workerBase()}${REGISTRY_PATH}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`lake registry ${url} returned HTTP ${res.status}`);
  const raw = await res.json();

  const bySlug = new Map();
  const byName = new Map();
  const list = [];
  for (const [slug, rec] of Object.entries(raw || {})) {
    if (!rec || !Array.isArray(rec.centroid)) continue;
    const entry = {
      slug,
      name: rec.name,
      state: rec.state,
      displayName: displayName(rec),
      gnis: rec.gnis || null,
      areaAcres: Number(rec.area_acres) || 0,
      // GeoJSON order is [lon, lat]; Leaflet wants [lat, lon]. Converting here once is the
      // difference between one bug and one per call site.
      lat: Number(rec.centroid[1]),
      lon: Number(rec.centroid[0]),
      boundsWSEN: rec.bounds_wsen || null,
      access: rec.access || null,
      accessForMe: rec.access_for_me || null,
      accessVia: rec.access_via || null,
      accessUnits: rec.access_units || [],
      proclamation: rec.proclamation || [],
      ramps: rec.ramps || {},
      rampSources: Number(rec.ramp_sources) || 0,
      inR2: !!rec.in_r2,
      charted: rec.charted === null || rec.charted === undefined ? null : Number(rec.charted),
    };
    if (!Number.isFinite(entry.lat) || !Number.isFinite(entry.lon)) continue;
    bySlug.set(slug, entry);
    byName.set(entry.displayName, entry);
    list.push(entry);
  }
  return { bySlug, byName, list, loaded: true };
}

export function loadLakeRegistry() {
  if (!registryPromise) {
    registryPromise = fetchRegistry()
      .then((r) => { registry = r; return r; })
      .catch((e) => {
        // A missing registry must not take the picker down with it — the app has to keep
        // working off the worker's DNR feeds alone, exactly as it did before.
        console.warn('[lake-registry] load failed, falling back to DNR feeds only:', e.message);
        registry = { bySlug: new Map(), byName: new Map(), list: [], loaded: false };
        return registry;
      });
  }
  return registryPromise;
}

export function getLoadedRegistry() {
  return registry;
}

export function lakeBySlug(slug) {
  return registry.bySlug.get(slug) || null;
}

export function lakeByDisplayName(name) {
  return registry.byName.get(name) || null;
}

/** Apply a filter to the registry. Returns entries, already sorted for display. */
export function filterLakes(opts = {}) {
  const f = { ...DEFAULT_FILTER, ...opts };
  const STATE_ORDER = { SC: 0, NC: 1, GA: 2, TN: 3 };
  return registry.list
    .filter((r) => {
      if (f.states && !f.states.has(r.state)) return false;
      if (r.areaAcres < f.minAcres || r.areaAcres > f.maxAcres) return false;
      if (f.openOnly && !ACCESS_OPEN.has(r.accessForMe)) return false;
      if (f.reachableOnly && !f.openOnly) {
        if (r.accessForMe === 'Closed Access') return false;
        if (!ACCESS_REACHABLE.has(r.accessForMe) && !r.rampSources) return false;
      }
      if (f.rampOnly && !r.rampSources) return false;
      // charted === null means "not measured yet", which is not the same as "no soundings".
      // Filtering it out would hide every lake until the extraction finishes.
      if (f.chartedOnly && r.charted !== null && !(r.charted > 0)) return false;
      return true;
    })
    .sort((a, b) => {
      const d = (STATE_ORDER[a.state] ?? 99) - (STATE_ORDER[b.state] ?? 99);
      return d !== 0 ? d : a.displayName.localeCompare(b.displayName);
    });
}

/** Counts for the filter UI, so it can show what each toggle would cost. */
export function registryStats() {
  const s = { total: registry.list.length, byState: {},
              open: 0, reachable: 0, ramps: 0, charted: 0, closed: 0 };
  for (const r of registry.list) {
    s.byState[r.state] = (s.byState[r.state] || 0) + 1;
    if (ACCESS_OPEN.has(r.accessForMe)) s.open += 1;
    if (r.accessForMe === 'Closed Access') s.closed += 1;
    else if (ACCESS_REACHABLE.has(r.accessForMe) || r.rampSources) s.reachable += 1;
    if (r.rampSources) s.ramps += 1;
    if (r.charted > 0) s.charted += 1;
  }
  return s;
}

/**
 * Access points a registry lake carries, flattened into the shape access-index.js uses.
 * Sources keep their own marker so the ramp dropdown says where each one came from —
 * a national-CSV ramp is agency data, an OSM slipway is volunteered, and the user should
 * be able to tell them apart before driving somewhere.
 */
const SOURCE_META = {
  natl:   { label: 'Boat ramp (agency)', marker: '🛥️' },
  osm:    { label: 'Slipway (OSM)',      marker: '🛶' },
  garmin: { label: 'Ramp (Garmin chart)', marker: '⚓' },
};

export function accessPointsFor(rec) {
  const out = [];
  for (const [src, items] of Object.entries(rec.ramps || {})) {
    const meta = SOURCE_META[src] || { label: src, marker: '📍' };
    for (const it of items || []) {
      const lat = Number(it.lat);
      const lon = Number(it.lon);
      out.push({
        name: it.name || it.wb || 'Unnamed access point',
        // The national CSV carries coordinates; the OSM per-lake file does not, so those
        // points fall back to the lake centroid rather than being dropped. They still tell
        // you a launch exists, which is the thing that was missing.
        lat: Number.isFinite(lat) ? lat : rec.lat,
        lon: Number.isFinite(lon) ? lon : rec.lon,
        typeLabel: meta.label,
        marker: meta.marker,
        sourcePath: `registry:${src}`,
        sourceState: rec.state,
        meta: { waterbody: it.wb, type: it.type, source: it.src, approximate: !Number.isFinite(lat) },
      });
    }
  }
  return out;
}
