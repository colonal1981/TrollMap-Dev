/**
 * lake-registry.js — the 3DHP lake registry, with every access source joined on.
 *
 * WHAT THIS REPLACES
 *
 * TrollMap's lake picker used to be fed by access-index.js, which built its list from the
 * worker's /ramps route plus two hardcoded files, scdnr-state-lakes.js and user-known-lakes.js.
 * That meant the app could only show a lake if a state wildlife agency happened to list a ramp
 * on it.
 *
 * BOTH FILES ARE GONE — 2026-08-22. They are in `_to_delete/` and `check_start_here.py` asserts
 * their absence. Between them they contributed 40 extra names, 5 notes and not one water: every
 * index row they tagged already carried `3dhp`. The names they supplied now come from
 * `registry/_feed_names.json`, harvested from the live ramp feeds by `build_water_names.py`.
 * Measured before deleting anything, by running consolidate with and without them and diffing:
 * 401 rows both ways, zero names lost, zero added.
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
      // lake | river | coastal. Computed on all 1,722 registry rows and, until 2026-08-08, read
      // by nothing — which is why Catawba River, Congaree River, Edisto River, Great Pee Dee and
      // Fishing Creek Reservoir all sat in a dropdown group labelled "Lakes / Reservoirs".
      featureType: rec.feature_type || null,
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
        _normIndex = null; _normStateIndex = null;
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
// THE LABEL IS LOAD-BEARING, NOT DECORATION. `liveAccessFor()` in access-index.js classifies an
// access point by matching /\bramp\b/ and /\b(ramp|slipway|launch|landing)\b/ against this string
// -- so a bucket added here without a label carrying one of those words contributes a point the
// planner will not count as somewhere to launch. Added 2026-08-14 with the dnr buckets; the
// wording is checked by test/live-ramps-reach-the-filter.test.js.
const SOURCE_META = {
  natl:   { label: 'Boat ramp (agency)', marker: '🛥️' },
  osm:    { label: 'Slipway (OSM)',      marker: '🛶' },
  garmin: { label: 'Ramp (Garmin chart)', marker: '⚓' },
  // Built offline by scripts/build_dnr_ramps_by_lake.py from the same four state ArcGIS feeds
  // the worker serves at /ramps and /paddle. These exist so the FILE knows what the live index
  // already knew -- the Python side has no worker to ask. When both are present they describe
  // the same launches and accessDedupeKey() collapses them to one dropdown row.
  dnr:        { label: 'Boat ramp (DNR)',     marker: '🛥️' },
  dnr_paddle: { label: 'Paddle launch (DNR)', marker: '🛶' },
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

/**
 * A PARENTHETICAL IS EITHER THE COUNTY OR THE IDENTITY, AND THIS USED TO DELETE BOTH.
 *
 * Reported by Ryan 2026-08-25: a conditions card for the Lower Saluda at Saluda Shoals showed
 * flow, stage and an 87-year history from "Saluda River near WARE SHOALS", 105 km upstream on
 * the far side of Lake Greenwood AND Lake Murray, and a water temperature of 81.1 F taken on a
 * free-flowing upper river. The Lower Saluda below Murray Dam is a bottom-release tailwater and
 * does not get near that.
 *
 * The registry keeps FOUR Saludas and tells them apart in the name:
 *
 *     Saluda River (Greenville Co, SC)                 1,310 ac
 *     Saluda River (2) (Newberry Co, SC)                 722 ac
 *     Saluda River (Lower Saluda) (Lexington Co, SC)     389 ac
 *
 * `.replace(/\(.*?\)/g, ' ')` stripped EVERY parenthetical, so all three normalised to
 * `river saluda`, the index is first-writer-wins over a largest-first list, and the 1,310-acre
 * Greenville reach claimed the key for all of them. Nothing downstream could tell.
 *
 * THE TAIL IS NOISE; THE REST IS THE NAME. `(Lexington Co, SC)` and `(SC/GA)` are the registry's
 * own county stamp and carry no identity -- the caller never has them, which is the whole reason
 * they were being stripped. `(Lower Saluda)`, `(2)` and `(Union County)` are the only thing
 * separating two real waters, and a matcher that deletes them is guessing.
 *
 * `\bco\b` and not `county`: `(Union Co, NC)` is a stamp, `(Union County)` is a name.
 */
function normName(s) {
  return String(s || '')
    .toLowerCase()
    // A trailing state: "…, sc", "…, sc/ga".
    .replace(/,\s*[a-z]{2}(\/[a-z]{2})*\s*$/, ' ')
    // A trailing county stamp: "(lexington co, sc)".
    .replace(/\s*\([^()]*\bco\b[^()]*\)\s*$/, ' ')
    // A trailing bare state stamp: "(sc)", "(sc/ga)".
    .replace(/\s*\([a-z]{2}(\/[a-z]{2})*\)\s*$/, ' ')
    // Whatever parenthetical is LEFT is part of the name. Keep its words, drop its brackets.
    .replace(/[()]/g, ' ')
    .replace(/\b(lake|lakes|reservoir|rsvr|pond|millpond|impoundment|the|of)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ').filter(Boolean).sort().join(' ');
}

/**
 * THE STATE IS THE OTHER HALF OF THE NAME, AND normName THROWS IT AWAY TOO.
 *
 * With the parenthetical fix above, 11 of the 358 shipped waters still resolved to a different
 * water when asked by the name the app actually passes. EIGHT of those eleven are in different
 * states, and the caller has the state -- the access index builds every name as
 * `<feed spelling>, <ST>`, and the ST comes from which state agency published the row:
 *
 *     Lake Lanier, SC        85 ac, Greenville Co    vs   Lake Sidney Lanier, GA   38,293 ac
 *     Lake Russell, GA       88 ac, Habersham Co     vs   Richard B Russell, SC    24,608 ac
 *     Lake Cherokee, SC      51 ac, Cherokee Co      vs   Cherokee Lake, TN        30,053 ac
 *     Hunt Pond, SC          50 ac                   vs   Lake Hunt, NC              176 ac
 *
 * Every one of those was answering with the bigger water in the other state, because
 * `normName` strips `, sc` before it builds the key. Lake Lanier is the pair `check-lake-geo`
 * was written for in 2026-08-04 -- it recorded 'Lake Lanier, GA' resolving to the 85-acre SC
 * pond. Both directions are the same defect: the state was in our hands and the key dropped it.
 *
 * STATE-KEYED FIRST, STATE-BLIND SECOND. The state-blind index is kept and consulted after, so
 * a caller with no state resolves exactly as it did before. This can turn a wrong answer right
 * or a null into a hit; it cannot take away an answer that was already being given.
 *
 * THREE PAIRS ARE LEFT AND NO KEY CAN SEPARATE THEM, because they are in the same state:
 * Cedar Creek (Richland Co, SC) against Cedar Creek Reservoir (Chester Co, SC), Cypress Lake
 * (Bulloch Co, GA) against Lake Cypress (Dodge Co, GA), and Glenville Lake (Cumberland Co, NC)
 * against Lake Glenville (Jackson Co, NC). The feed name carries no county. Largest-first
 * first-writer-wins still decides those, and the smaller water is reachable by slug or by its
 * full display name -- which is a limit worth stating rather than a bug worth hiding.
 */
let _normIndex = null;
let _normStateIndex = null;

function buildNormIndexes() {
  _normIndex = new Map();
  _normStateIndex = new Map();
  for (const r of registry.list) {
    for (const n of [r.name, r.displayName, r.legacyDisplayName, ...r.legacyDisplayNames]) {
      if (!n) continue;
      const k = normName(n);
      if (!k) continue;
      // First writer wins, and the list is sorted largest-first below, so a 30-acre namesake
      // cannot claim the key belonging to the reservoir everyone means.
      if (!_normIndex.has(k)) _normIndex.set(k, r);
      // A NUMERIC PARENTHETICAL IS THE REGISTRY'S HANDWRITING, NOT THE WATER'S NAME.
      //
      // `(Lower Saluda)` and `(Union County)` are what the water is called. `(2)`, `(3)`, `(4)`
      // are what consolidate_lake_index.py writes when two rows collide, and nobody asks for a
      // river by its ordinal. Keeping the ordinal fixed "Broad River (2)" resolving to the wrong
      // Broad River and immediately broke the other direction: "Broad River, SC" is the 5,166-acre
      // Union County reach, and with the ordinal in the key it could only reach the 4,084-acre
      // Cherokee County NC one through the state-blind fallback.
      //
      // So an ordinal row claims its base name too -- IN THE STATE INDEX ONLY. The state-blind
      // index keeps the ordinal, because without a state "Broad River" genuinely is ambiguous
      // and largest-first has to break the tie as it always did.
      const bare = k.replace(/\b\d+\b/g, ' ').replace(/\s+/g, ' ').trim();
      for (const st of String(r.state || '').toUpperCase().split(/[^A-Z]+/).filter(Boolean)) {
        for (const key of (bare && bare !== k) ? [k, bare] : [k]) {
          const sk = `${st}|${key}`;
          if (!_normStateIndex.has(sk)) _normStateIndex.set(sk, r);
        }
      }
    }
  }
}

function normIndex() {
  if (!_normIndex || !_normIndex.size) buildNormIndexes();
  return _normIndex;
}

function normStateIndex() {
  if (!_normStateIndex || !_normStateIndex.size) buildNormIndexes();
  return _normStateIndex;
}

/** The state a caller stamped on a name, or null. `, SC` / `(Lexington Co, SC)` / `(SC/GA)`. */
function stateOfQuery(q) {
  const m = String(q || '').match(/(?:,\s*|\(\s*)([A-Za-z]{2})(?:\s*\/\s*[A-Za-z]{2})*\s*\)?\s*$/);
  return m ? m[1].toUpperCase() : null;
}

/**
 * The record for a lake, given a slug, a display name, a legacy LAKE_DB key, or a plain name.
 * Returns null rather than guessing.
 */
export function lakeRecordFor(query) {
  if (!query || typeof query !== 'string') return null;
  const q = query.trim();
  if (!q) return null;
  const st = stateOfQuery(q);
  const nk = normName(q);
  return registry.bySlug.get(q)
      || registry.byName.get(q)
      // The state the caller stamped, when it stamped one. See normStateIndex.
      || (st && nk ? normStateIndex().get(`${st}|${nk}`) : null)
      || normIndex().get(nk)
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
    // THE STATE, WITHOUT WHICH NO INLAND WATER HAS REGULATIONS.
    //
    // This projection is built field by field, and `state` was not one of them. It is on the
    // record -- the builder sets `state: rec.state` -- and it was dropped on the way out, so
    // `lakeDbEntryFor(x).state` has been `undefined` for every water in the app.
    //
    // plan-preflight.js reads exactly that: `st || (lakeDbEntryFor(lakeName) || {}).state ||
    // null`, under a comment saying "THE STATE IS WHAT UNLOCKS THE DIGEST. Inland it comes off
    // the registry row". The intent was right and the field was not there, so `inlandState` was
    // null on EVERY inland lake, `livePolicyFor` was never asked, and the plan said "No
    // regulation data for Lake Wateree, SC — verify with the state before you keep one" on a
    // lake whose book South Carolina names by name for blue catfish. Every offline rule in
    // registry/regulations_table.json was reaching the browser and stopping one field short of
    // the planner. Ryan saw it in a preflight on 2026-08-30.
    state: r.state || null,
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

/**
 * THE NAMES A DOCUMENT USES, WHICH ARE NOT THE NAMES THE RESOLVER USES.
 *
 * `legacy_display_names` feeds two consumers with opposite needs. The resolver wants ONE water
 * per name and breaks when two share one -- `WARE_SHOALS_IS_105_KM_FROM_SALUDA_SHOALS` is the
 * write-up of that failure, and on 2026-09-01 adding "Lake Russell" to the registry took Richard
 * B Russell Lake from 9 species to 0 because an 88-acre Habersham County pond already owned it.
 * The document matchers want the opposite: EVERY name a document might use, and the useful ones
 * are exactly the ambiguous ones.
 *
 * So the document names are derived here instead, and nothing below is written into the index:
 *
 *   1. The registry's own names, county stamp removed. `(Hall Co, GA)` is
 *      consolidate_lake_index.py's handwriting; no document carries one.
 *   2. Reach labels dropped. 54 of the 358 rows carry NHD reach names like "Big Branch - Clarks
 *      Hill Lake" and "Chattahoochee River - Lake Lanier". They are arms of the water, not names
 *      for it, and J. Strom Thurmond alone has 38 of them -- enough to fill the extractor's
 *      twelve-alias budget with creek names and leave no room for "Clarks Hill Lake".
 *   3. "Name, ST" dropped when the bare "Name" is already present.
 *   4. Lake/Reservoir generated both ways, because that swap is a rule and not a fact:
 *      "Mountain Island Lake" -> "Mountain Island Reservoir", "Lake Jocassee" -> "Jocassee
 *      Reservoir". A generated name is DISCARDED if any other registry row answers to it under
 *      the registry's own normName -- which is what keeps "Lake Cherokee" (51 ac, Cherokee Co SC)
 *      and "Cherokee Lake" (30,053 ac, TN) apart, along with Bear Creek, Cypress, Glenville,
 *      Brooks, Beaver and Hunt. Eighteen such pairs exist; the guard drops all eighteen.
 *
 * Counted 2026-09-01 across all 358 rows with the guard on: zero generated name is another
 * water's name, and no water's list exceeds the twelve the extractor will send.
 */

/**
 * The names no rule can derive and no index can hold, because another water already answers to
 * them. Each line is a decision about which water the FISHING LITERATURE means, and both of these
 * are the same shape: a reservoir everyone writes about, and a pond nobody does.
 *
 *   "Lake Lanier"  -- Lake Sidney Lanier, 38,293 ac, Hall Co GA, vs an 85-acre Greenville Co SC pond
 *   "Lake Russell" -- Richard B Russell Lake, 24,608 ac, vs an 88-acre Habersham Co GA pond
 *
 * Both ponds are under the 1,000-acre research floor, so neither is ever researched and neither
 * has documents of its own to lose. If a pond is ever added to the research set, its entry here
 * has to come out first.
 */
const DOC_ONLY_NAMES = {
  lake_sidney_lanier: ['Lake Lanier'],
  richard_b_russell_lake: ['Lake Russell', 'Russell Lake'],
};

let _nameOwners = null;
/** normName key -> the slugs that answer to it. More than one means nobody may generate it. */
function nameOwners() {
  if (_nameOwners && _nameOwners.size) return _nameOwners;
  _nameOwners = new Map();
  for (const r of registry.list) {
    for (const n of [r.name, r.displayName, r.legacyDisplayName, ...r.legacyDisplayNames]) {
      const k = normName(n);
      if (!k) continue;
      if (!_nameOwners.has(k)) _nameOwners.set(k, new Set());
      _nameOwners.get(k).add(r.slug);
    }
  }
  return _nameOwners;
}

const stripCountyStamp = (s) => String(s || '')
  .replace(/\s*\([^)]*\bCo\b[^)]*\)\s*/i, ' ').replace(/\s+/g, ' ').trim();
const stripStateSuffix = (s) => String(s || '')
  .replace(/,\s*[A-Za-z]{2}(?:\/[A-Za-z]{2})*$/, '').trim();

/** "Mountain Island Lake" -> "Mountain Island Reservoir"; "Lake Jocassee" -> "Jocassee Lake/Reservoir". */
function nounVariants(name) {
  const lead = /^Lake\s+(.+)$/i.exec(name);
  if (lead) return [`${lead[1]} Lake`, `${lead[1]} Reservoir`];
  const trail = /^(.+?)\s+(Lake|Reservoir)$/i.exec(name);
  if (trail) return [`${trail[1]} ${/lake/i.test(trail[2]) ? 'Reservoir' : 'Lake'}`];
  return [];
}

/** Every name a document about this water might use. Registry names first, generated ones last. */
export function documentNamesFromRecord(rec) {
  if (!rec) return [];
  const raw = [rec.name, rec.displayName, rec.legacyDisplayName, ...(rec.legacyDisplayNames || []),
    ...(DOC_ONLY_NAMES[rec.slug] || [])].filter(Boolean);
  const kept = raw.map(stripCountyStamp).filter((n) => n && !/ - /.test(n));
  // "Lake Wateree, SC" is dropped only when plain "Lake Wateree" is ALSO on the list. Testing the
  // stripped form against itself instead drops every name of the fifteen coastal zones, whose
  // names ARE state-suffixed -- "Charleston Harbor, SC" has no bare form to fall back to, and all
  // fifteen came back with no document names at all.
  const bareForms = new Set(kept
    .filter((n) => stripStateSuffix(n).toLowerCase() === n.toLowerCase())
    .map((n) => n.toLowerCase()));
  const real = [];
  for (const n of kept) {
    const b = stripStateSuffix(n).toLowerCase();
    if (b !== n.toLowerCase() && bareForms.has(b)) continue;
    if (!real.some((x) => x.toLowerCase() === n.toLowerCase())) real.push(n);
  }
  const owners = nameOwners();
  const generated = [];
  for (const n of real) {
    for (const v of nounVariants(n)) {
      const held = owners.get(normName(v));
      if (held && !(held.size === 1 && held.has(rec.slug))) continue;
      const k = v.toLowerCase();
      if (real.some((x) => x.toLowerCase() === k) || generated.some((x) => x.toLowerCase() === k)) continue;
      generated.push(v);
    }
  }
  return [...real, ...generated];
}

/** Same, for callers holding a name rather than a record. Falls back to the name itself. */
export function documentNamesFor(query) {
  const rec = lakeRecordFor(query);
  const names = documentNamesFromRecord(rec);
  return names.length ? names : [String(query || '')].filter(Boolean);
}
