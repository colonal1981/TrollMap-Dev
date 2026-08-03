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
  // CONTOURS ARE THE LIST. Ryan, 2026-08-02: "i want a list of lakes with contours... i am
  // willing to bet if it has contours i can fish it... i highly doubt garmin mapped private
  // property." The extraction measured it: 434 of 1,551 have soundings, and 14 of 14 lakes
  // sampled as charted came back PAD-US Open Access.
  //
  // So the default is `shipped` -- a chartpack exists in R2 -- not an access class. Access
  // is something the record CARRIES and the badge displays; it is not what decides whether
  // the lake is in the list. Every access-based default tried before this hid a lake Ryan
  // fishes: openOnly dropped Wittee and Ferry (state forest, Restricted), and any of them
  // would have dropped Bates Old River, which 3DHP never named and Garmin charted anyway.
  shippedOnly: true,
  reachableOnly: false,  // not known-closed AND land on the bank or a ramp somewhere
  openOnly: false,       // stricter: public or credentialed only
  rampOnly: false,       // only lakes with at least one mapped ramp
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
      shipped: !!rec.shipped,
      packMb: rec.pack_mb ?? null,
      legacyDisplayName: rec.legacy_display_name || null,
      // A lake can have more than one former name: the "Name, ST" it carried before
      // consolidate_lake_index.py started naming by county, and the curated LAKE_DB key it
      // binds to. Both may be sitting in a saved plan or catch, so both stay resolvable.
      legacyDisplayNames: Array.isArray(rec.legacy_display_names) ? rec.legacy_display_names
                        : (rec.legacy_display_name ? [rec.legacy_display_name] : []),
      usgs: rec.usgs || null,
      duke: rec.duke || null,
      dominion: rec.dominion || null,
      normalPool: rec.normalPool ?? null,
      minPool: rec.minPool ?? null,
      county: rec.county || null,
      note: rec.note || null,
      sources: rec.source || [],
    };
    if (!Number.isFinite(entry.lat) || !Number.isFinite(entry.lon)) continue;
    bySlug.set(slug, entry);
    list.push(entry);
  }

  // Shipped first, then largest. Slugs are unique; DISPLAY NAMES ARE NOT -- 40 names in the
  // 1,565-record index are shared by two or more lakes, and 12 of those groups contain a lake
  // that shipped. `Long Pond, GA` is four different ponds, one of them 301 ac and three under
  // 160.
  //
  // byName used to be filled inside the loop above, which made it LAST-writer-wins in whatever
  // order the JSON happened to enumerate, while normIndex() below was first-writer-wins over
  // this sorted list. The two disagreed, so the same string could resolve to two different
  // lakes depending on which function you asked -- and asking for `Lake Oconee, GA` could hand
  // back the 39-acre namesake instead of the 17,436-acre reservoir, with the app then fetching
  // the wrong pack. Building the map here, first-writer-wins, gives both paths one rule.
  //
  // `shipped` outranks area because a shipped lake is one the user can actually open. That
  // alone resolves 9 of the 12 groups. The remaining 3 are shipped-vs-shipped and need a
  // distinguishable LABEL, not a tie-break -- see disambiguateDisplayNames() below.
  list.sort((a, b) => (Number(b.shipped) - Number(a.shipped))
                   || ((b.areaAcres || 0) - (a.areaAcres || 0)));
  disambiguateDisplayNames(list);
  for (const entry of list) if (!byName.has(entry.displayName)) byName.set(entry.displayName, entry);
  return { bySlug, byName, list, loaded: true };
}

/**
 * Give every lake a display name no other lake shares.
 *
 * Only collisions among SHIPPED lakes actually reach the user -- those are the ones the picker
 * offers, so two identical rows are two rows you cannot tell apart. Unshipped namesakes are
 * left alone; the sort above already guarantees the shipped one wins the lookup.
 *
 * The suffix is surface area. `county` is null for every colliding record in the index, so it
 * is not available to disambiguate with, and acreage is the one field that is always present,
 * always differs, and actually means something on the water: Forest Lake, SC is 169 ac or
 * 127 ac and Ryan knows which one he fishes.
 */
function disambiguateDisplayNames(list) {
  const groups = new Map();
  for (const r of list) {
    if (!r.shipped) continue;
    if (!groups.has(r.displayName)) groups.set(r.displayName, []);
    groups.get(r.displayName).push(r);
  }
  for (const [name, rs] of groups) {
    if (rs.length < 2) continue;
    for (const r of rs) {
      r.legacyDisplayName = r.legacyDisplayName || name;   // keep the old string resolvable
      r.displayName = `${name} (${Math.round(r.areaAcres).toLocaleString()} ac)`;
    }
  }
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
      // shipped is the primary gate: a pack exists, so selecting the lake shows you data.
      // charted === null still means "never measured" and must not read as "no soundings" --
      // the 14 lakes with no boundary polygon are in that state.
      if (f.shippedOnly && !r.shipped && r.charted !== null) return false;
      if (f.openOnly && !ACCESS_OPEN.has(r.accessForMe)) return false;
      if (f.reachableOnly && !f.openOnly) {
        if (r.accessForMe === 'Closed Access') return false;
        if (!ACCESS_REACHABLE.has(r.accessForMe) && !r.rampSources) return false;
      }
      if (f.rampOnly && !r.rampSources) return false;
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
              open: 0, reachable: 0, ramps: 0, charted: 0, closed: 0, shipped: 0 };
  for (const r of registry.list) {
    s.byState[r.state] = (s.byState[r.state] || 0) + 1;
    if (ACCESS_OPEN.has(r.accessForMe)) s.open += 1;
    if (r.accessForMe === 'Closed Access') s.closed += 1;
    else if (ACCESS_REACHABLE.has(r.accessForMe) || r.rampSources) s.reachable += 1;
    if (r.rampSources) s.ramps += 1;
    if (r.charted > 0) s.charted += 1;
    if (r.shipped) s.shipped += 1;
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


// ── ONE RESOLVER, USED BY EVERYTHING ─────────────────────────────────────────
//
// Before this, four modules each rolled their own name matcher against LAKE_DB and they did
// not agree with each other:
//
//   smart-plan.js:748     Object.values(LAKE_DB).find(e => lakeName.includes(e.name.split(',')[0]))
//   plan-builder.js:709   Object.keys(LAKE_DB).find(k => cleanLake.includes(k) || k.includes(cleanLake))
//   utility-sync.js:66    the same substring test, written again
//   catch-journal.js:192  nearest curated centroid within 20 miles
//
// Three different substring rules means the same lake name can resolve to different entries
// in the planner and in the journal. Substring matching is also actively wrong at this
// scale: "Lake Wallace" is a substring of nothing useful and SC has two of them, 273 and 155
// acres.
//
// So: exact lookups only, in a defined order, and a null when nothing matches. A null is a
// better answer than a confidently wrong lake -- a caller can fall back, but it cannot
// detect that it was handed the wrong reservoir's pool level.

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/,\s*[a-z]{2}(\/[a-z]{2})*\s*$/, '')
    .replace(/\b(lake|lakes|reservoir|rsvr|pond|millpond|impoundment|the|of)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ').filter(Boolean).sort().join(' ');
}

let _normIndex = null;
function normIndex() {
  if (_normIndex && _normIndex.size) return _normIndex;
  _normIndex = new Map();
  for (const r of registry.list) {
    for (const n of [r.name, r.displayName, r.legacyDisplayName, ...r.legacyDisplayNames]) {
      if (!n) continue;
      const k = normName(n);
      // First writer wins, and the list is sorted largest-first below, so a 30-acre namesake
      // cannot claim the key belonging to the reservoir everyone means.
      if (k && !_normIndex.has(k)) _normIndex.set(k, r);
    }
  }
  return _normIndex;
}

/**
 * The record for a lake, given a slug, a display name, a legacy LAKE_DB key, or a plain name.
 * Returns null rather than guessing.
 */
export function lakeRecordFor(query) {
  if (!query || typeof query !== 'string') return null;
  const q = query.trim();
  if (!q) return null;
  return registry.bySlug.get(q)
      || registry.byName.get(q)
      || normIndex().get(normName(q))
      || null;
}

/**
 * LAKE_DB-shaped view of a registry record, so the modules that consumed `data/lakes.js` can
 * switch import without rewriting how they read it. `center` and `bounds` are derived from
 * the registry geometry; usgs/duke/dominion/normalPool/minPool and the curated ramp list are
 * carried through by consolidate_lake_index.py, which is why lakes.js can be deleted at all.
 */
export function lakeDbEntryFor(query) {
  const r = lakeRecordFor(query);
  if (!r) return null;
  const b = r.boundsWSEN;
  const ramps = {};
  for (const item of (r.ramps?.curated || r.ramps?.natl || [])) {
    if (Number.isFinite(item.lat) && Number.isFinite(item.lon)) ramps[item.name] = [item.lat, item.lon];
  }
  return {
    slug: r.slug,
    name: r.displayName,
    center: [r.lat, r.lon, r.areaAcres > 5000 ? 11 : r.areaAcres > 500 ? 12 : 13],
    bounds: Array.isArray(b) && b.length === 4 ? [[b[1], b[0]], [b[3], b[2]]] : null,
    usgs: r.usgs || null,
    duke: r.duke || null,
    dominion: r.dominion || null,
    normalPool: r.normalPool ?? null,
    minPool: r.minPool ?? null,
    ramps,
  };
}

/** Display names for a dropdown, largest first within state. Replaces Object.keys(LAKE_DB). */
export function lakeNamesForPicker(opts) {
  return filterLakes(opts).map((r) => r.displayName);
}
