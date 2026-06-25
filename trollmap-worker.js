/**
 * TrollMap Cloudflare Worker — v11 (2026-06-24)
 * ─────────────────────────────────────────────────────────────────
 * New in v11:
 *   D1 cross-device sync routes:
 *     POST /sync/item/:type/:id   — push one item
 *     GET  /sync/list-updates     — delta list since timestamp
 *     GET  /sync/item/:key        — fetch one item
 *     POST /sync/migrate          — bulk push all local data
 *     DELETE /sync/item/:type/:id — tombstone an item
 *
 *   Vectorized contour routes:
 *     GET  /contours/:lake/geojson  — serve vectorized contours.geojson
 *     POST /contours/:lake/geojson  — upload vectorized contours.geojson
 *
 * D1 binding: DB (database name: trollmap_sync)
 * R2 binding: R2_TROLLMAP_CHARTPACKS (existing)
 * ───────────────────────────────────────────────────────────────── */

/**
 * TrollMap Cloudflare Worker — v10 (2026-06-17)
 * ─────────────────────────────────────────────────────────────────
 * Fixes:
 *   1. Duke Energy migrated off lakes.duke-energy.com/Data/Lakes/*.txt.
 *      The live dashboard now lives at lakes.hydro-derived.duke-energy.app.
 *      We now proxy THAT page (HTML) and let the frontend's parseDukeText()
 *      scrape it. We also try a couple of known JSON endpoints first.
 *
 *   2. USGS lake POOL gauges (where they exist) are used for elevation;
 *      USGS river-below-dam gauges are used ONLY for water temperature.
 *      No more confusing river stage with lake pool elevation.
 *
 *   3. Adds an Army Corps / SEPA fallback for federal lakes
 *      (Marion/Moultrie, Thurmond, Hartwell, Russell) where applicable.
 *
 * Routes:
 *   /duke?basin=1|2|3        → proxies live Duke dashboard HTML
 *   /lake?lake=<name>        → unified JSON {elevation_ft, water_temp_F, source}
 *   /usgs?site=...&params=...→ raw USGS IV pass-through (CORS-safe)
 *   /                        → legacy ?lake= handler kept for back-compat
 * ───────────────────────────────────────────────────────────────── */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Token',
};

const JSON_HEADERS = { ...CORS, 'Content-Type': 'application/json' };
const TEXT_HEADERS = { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' };

/* Cloudflare injects SYNC_TOKEN from your Variable binding at runtime. */
const SYNC_TOKEN = '';

async function isAuthorized(request, env) {
  const want = (env && env.SYNC_TOKEN) || (typeof SYNC_TOKEN !== 'undefined' && SYNC_TOKEN) || null;
  if (!want) return false;
  const got = request.headers.get('X-Sync-Token');
  return got === want;
}

function chartpackKey(lake, filename) {
  const safeLake = String(lake).toLowerCase().replace(/[^a-z0-9_\-]/g, '_');
  // Preserve '/' so subfolder paths (e.g. contours/<file>) round-trip correctly.
  const safeFile = String(filename).replace(/[^a-z0-9_.\-\/]/gi, '_');
  return `${safeLake}/${safeFile}`;
}

async function handleChartpackList(env) {
  const out = [];
  let cursor;
  do {
    const listed = await env.R2_TROLLMAP_CHARTPACKS.list({ cursor });
    for (const obj of listed.objects) {
      const slash = obj.key.indexOf('/');
      if (slash < 0) continue;
      const lake = obj.key.slice(0, slash);
      const file = obj.key.slice(slash + 1);
      let entry = out.find(e => e.name === lake);
      if (!entry) { entry = { name: lake, files: [], bytes: 0 }; out.push(entry); }
      entry.files.push(file);
      entry.bytes += obj.size || 0;
    }
    cursor = listed.truncated ? listed.cursor : null;
  } while (cursor);
  for (const e of out) e.files.sort();
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { chartpacks: out, count: out.length };
}

/* ───────── lake → gauge map ─────────
   pool  = USGS site that actually measures LAKE pool elevation (rare)
   river = USGS site below dam — temperature only, NEVER use stage as pool
   duke  = lake name as it appears on the Duke dashboard
   sepa  = USACE/SEPA lake key (for Marion/Moultrie/Thurmond/etc)
   normalPool = published full pool, used as last-resort fallback
*/
const LAKES = {
  wateree:  { duke:'wateree',         river:'02148000', normalPool:225.5, ahq:'lake-wateree' },
  wylie:    { duke:'wylie',           pool:'02146000',  normalPool:569.4, ahq:'lake-wylie' },
  norman:   { duke:'norman',          river:'02142500', normalPool:760.0 },  // No AHQ page for Norman (NC lake)
  keowee:   { duke:'keowee',          river:'02163500', normalPool:800.0, ahq:'lake-keowee' },
  jocassee: { duke:'jocassee',                          normalPool:1110.0, ahq:'lake-jocassee' },
  hickory:  { duke:'hickory',         river:'02143500', normalPool:935.0 },
  james:    { duke:'james',                             normalPool:1200.0 },
  rhodhiss: { duke:'rhodhiss',                          normalPool:995.1 },
  'mountain island': { duke:'mountain island',          normalPool:647.5 },

  murray:   { dominion:true,          pool:'02168500', normalPool:358.0, ahq:'lake-murray' },
  marion:   { sepa:'marion',          pool:'02169921', normalPool:75.0,  ahq:'santee-cooper-lake-marion-lake-moultrie' },
  moultrie: { sepa:'moultrie',        pool:'02172000', normalPool:75.5,  ahq:'santee-cooper-lake-marion-lake-moultrie' },
  thurmond: { sepa:'thurmond',        pool:'02196485', normalPool:330.0, ahq:'clarks-hill-lake-thurmond' },
  hartwell: { sepa:'hartwell',        pool:'02187010', normalPool:660.0, ahq:'lake-hartwell' },
  russell:  { sepa:'russell',         pool:'02191743', normalPool:475.0, ahq:'lake-russell' },
};

/* Fisherman-focused lake intelligence profiles.
   These are intentionally curated/static facts + live report snippets. The static
   profile prevents hallucinated web data; live report scrape is attached only
   when a known source page is configured. */
const LAKE_INTEL = {
  wateree: {
    displayName: 'Lake Wateree',
    primarySportFish: ['Largemouth bass', 'Striped bass', 'Catfish', 'Crappie', 'White perch'],
    forage: ['Threadfin shad', 'Gizzard shad', 'Blueback herring (system-dependent)', 'White perch'],
    stocking: 'Managed as a Catawba-Wateree reservoir; striper/hybrid regulations and stocking can change, verify SCDNR before harvest.',
    spottedBass: 'Spotted bass are present in the broader Catawba system but Wateree is still generally discussed as largemouth/striper/catfish water; verify local tournament reports for current spotted-bass pressure.',
    habitat: 'Classic river-run reservoir: creek arms, rocky points, docks, riprap, bridge pilings, humps, channel swings, blowdowns, brush piles, and lower-lake bait schools.',
    bottom: 'Mix of clay, rock, gravel, sand, and old river/creek-channel silt. Hard bottom around points/riprap is key for bass; deeper channel edges for stripers.',
    hazards: 'Drawdown exposes shallow shoals and long points. Wind stacks up on the main lake. Below Wateree Dam is a separate river/tailwater hazard zone with generation surges.',
    seasonalPattern: 'Spring: points/backs of creeks. Summer: main-lake humps/channel edges and low-light schooling. Fall: bait migration. Winter: deeper bait and slower presentations.',
    tacticalNotes: ['Use electronics to follow bait before committing to a trolling pass.', 'Wind-blown points and bridge funnels can concentrate bait.', 'Confirm current Duke lake stage and ramp usability before dawn launches.'],
  },
  murray: {
    displayName: 'Lake Murray',
    primarySportFish: ['Striped bass', 'Largemouth bass', 'Catfish', 'Crappie', 'Bream'],
    forage: ['Blueback herring', 'Threadfin shad', 'Gizzard shad'],
    stocking: 'Known regional striper reservoir; verify current SCDNR stocking/harvest notices and seasonal closures before targeting/keeping fish.',
    spottedBass: 'Spotted bass are not the defining fishery like Keowee/Hartwell; largemouth and stripers are the headline sport fisheries.',
    habitat: 'Deep clear lower lake near the dam, long points, humps, shoals, docks, riprap, creek arms, bridges, and offshore bait schools.',
    bottom: 'Mostly clay/sand with rock, gravel, and riprap; lower-lake clearer water and offshore structure matter heavily.',
    hazards: 'Recreational boat traffic can be intense. Wind across open lower lake gets rough for kayaks. Drawdowns expose shallow points and shoals.',
    seasonalPattern: 'Spring shoreline/points; summer early/late striper schooling and deeper bait; fall herring/shad movement; winter deep fish and birds/bait clues.',
    tacticalNotes: ['Blueback herring behavior drives a lot of Murray striper/bass movement.', 'Plan around boat traffic and wind fetch.', 'Use USGS 02168500 for reservoir pool, not the downstream Saluda gauge.'],
  },
  marion: {
    displayName: 'Lake Marion',
    primarySportFish: ['Largemouth bass', 'Striped bass', 'Catfish', 'Crappie', 'Bream'],
    forage: ['Threadfin shad', 'Gizzard shad', 'Blueback herring in parts of Santee-Cooper system', 'Panfish'],
    stocking: 'Santee Cooper system management changes seasonally; striped bass rules/closures are especially important to verify.',
    spottedBass: 'Spotted bass are not the main story; largemouth, catfish, crappie, bream, and stripers dominate angler focus.',
    habitat: 'Very shallow, sprawling, stump-filled reservoir with cypress, grass, swamp edges, old river runs, standing/flooded timber, canals, flats, drops, and brush.',
    bottom: 'Mud, silt, sand, old river-channel edges, stump fields, swamp timber, and shallow flats. Hard edges/ditches can be high-value when water moves.',
    hazards: 'Major stump and standing timber hazard lake. Navigation can be dangerous outside marked channels, especially at low water or in wind/fog.',
    seasonalPattern: 'Spring shallow cover/spawning pockets; summer current/river runs and shaded timber; fall bait movement; winter deep holes/creek channels and crappie structure.',
    tacticalNotes: ['Treat it like a navigation lake first and a fishing lake second.', 'Use marked channels and idle in unfamiliar stump fields.', 'Wind can make broad shallow water rough quickly.'],
  },
  moultrie: {
    displayName: 'Lake Moultrie',
    primarySportFish: ['Catfish', 'Largemouth bass', 'Striped bass', 'Crappie', 'Bream'],
    forage: ['Shad', 'Herring', 'Panfish'],
    stocking: 'Part of Santee Cooper; verify current SCDNR/Santee Cooper striper rules and stocking notices.',
    spottedBass: 'Not generally a spotted-bass takeover lake; focus is catfish, largemouth, crappie, bream, and stripers.',
    habitat: 'Broad bowl-like lake with grass edges, canals, dikes, deep open-water areas, shell/hard spots, drops, and Santee-Cooper current influences.',
    bottom: 'Mud/sand/shell/hard spots with old inundated features and canal/dike influences.',
    hazards: 'Open-water wind fetch is serious for kayaks. Current/wind around canal/dike areas can surprise. Verify lake level and wind before crossing.',
    seasonalPattern: 'Catfish year-round on ledges/drifts; bass around grass/hard edges; crappie around brush/canals; striper patterns depend heavily on season/rules.',
    tacticalNotes: ['Wind direction matters as much as lake level.', 'Use USGS 02172000 for Moultrie pool, not downstream/tailrace gauges.'],
  },
  keowee: {
    displayName: 'Lake Keowee',
    primarySportFish: ['Spotted bass', 'Largemouth bass', 'Crappie', 'Catfish'],
    forage: ['Blueback herring', 'Threadfin shad'],
    stocking: 'Clear Duke reservoir; bass fishery is strongly herring-driven. Verify SCDNR for current creel/length rules.',
    spottedBass: 'Yes — spotted bass are a dominant/major population and can outcompete largemouth in clear herring lakes. Expect offshore/herring-oriented behavior.',
    habitat: 'Deep clear water, steep points, docks, cane/brush, rock, humps, shoals, long tapering points, and blueback-oriented offshore zones.',
    bottom: 'Rock, clay, sand, gravel, steep banks, and deep clear-water structure.',
    hazards: 'Clear water demands long casts/light line. Boat traffic and steep banks. Rapid weather/wind on open water.',
    seasonalPattern: 'Spring herring spawn points; summer deep docks/brush/offshore; fall schooling; winter vertical/deep finesse.',
    tacticalNotes: ['Think spotted bass + blueback herring first.', 'Use natural colors and electronics-heavy offshore strategy.'],
  },
  hartwell: {
    displayName: 'Lake Hartwell',
    primarySportFish: ['Spotted bass', 'Largemouth bass', 'Striped bass', 'Hybrid bass', 'Catfish', 'Crappie'],
    forage: ['Blueback herring', 'Threadfin shad', 'Gizzard shad'],
    stocking: 'Large Savannah River reservoir with striper/hybrid management; verify GA/SC regulations depending where you fish.',
    spottedBass: 'Strong spotted bass population; blueback herring has shifted many bass patterns offshore and roam-oriented.',
    habitat: 'Huge clear-to-stained reservoir with timber in upper arms, docks, clay/rock points, humps, creek channels, bridges, brush, and cane piles.',
    bottom: 'Clay, rock, gravel, sand, channel silt, and timbered creek/river areas.',
    hazards: 'Big water, boat traffic, state-line regulations, standing timber in some areas, and long runs in wind.',
    seasonalPattern: 'Herring spawn in spring; offshore brush/points in summer; schooling in fall; deep timber/ditches in winter.',
    tacticalNotes: ['Find bait first.', 'Spotted bass and stripers both track herring heavily.', 'Know whether you are in SC or GA for license/rules.'],
  },
  thurmond: {
    displayName: 'Clarks Hill / J. Strom Thurmond Lake',
    primarySportFish: ['Striped bass', 'Hybrid bass', 'Largemouth bass', 'Crappie', 'Catfish'],
    forage: ['Blueback herring', 'Threadfin shad', 'Gizzard shad'],
    stocking: 'USACE/Savannah River reservoir with striper/hybrid stocking/management; verify GA/SC rules.',
    spottedBass: 'Spotted bass exist in the region but Thurmond is more commonly framed around largemouth, stripers/hybrids, crappie, and catfish than a spotted-bass takeover lake.',
    habitat: 'Large reservoir with standing timber in many arms, points, humps, bridges, creek channels, brush piles, hydrilla/grass where present, and deep lower-lake water.',
    bottom: 'Clay, rock, sand, gravel, channel silt, and extensive timbered structure.',
    hazards: 'Standing timber, long open-water runs, low-water ramp issues, and state-line regulations.',
    seasonalPattern: 'Spring points/pockets; summer deep humps/timber/thermocline; fall schooling; winter deep bait and channel structure.',
    tacticalNotes: ['Excellent electronics lake.', 'For stripers/hybrids, bait depth and oxygen/thermocline matter.'],
  },
  russell: {
    displayName: 'Lake Russell',
    primarySportFish: ['Spotted bass', 'Largemouth bass', 'Striped bass', 'Crappie', 'Catfish'],
    forage: ['Blueback herring', 'Threadfin shad'],
    stocking: 'USACE Savannah River lake with relatively stable pool; verify GA/SC rules and striper management notices.',
    spottedBass: 'Spotted bass are important and often strong due to clear water/herring-style patterns.',
    habitat: 'Deep clear reservoir, standing timber, steep rocky banks, points, humps, creek channels, and limited shoreline development.',
    bottom: 'Rock, clay, gravel, sand, and timbered old channels.',
    hazards: 'Standing timber and deep clear water. State-line/license considerations.',
    seasonalPattern: 'Herring/point bite in spring; deep timber/offshore in summer/winter; schooling in fall.',
    tacticalNotes: ['Stable water means fish may relate more to bait/season than drawdown.', 'Timber edges are key.'],
  },
  jocassee: {
    displayName: 'Lake Jocassee',
    primarySportFish: ['Trout', 'Smallmouth bass', 'Spotted bass', 'Largemouth bass'],
    forage: ['Blueback herring', 'Threadfin shad', 'Alewife/herring-type forage'],
    stocking: 'Deep cold clear reservoir with trout management; verify SCDNR trout/bass rules.',
    spottedBass: 'Spotted bass are present; deep clear-water tactics matter more than shallow power fishing much of the year.',
    habitat: 'Extremely deep, clear, steep, rocky reservoir with timber, cliffs, waterfalls, and cold-water zones.',
    bottom: 'Rock, steep clay/stone banks, deep timber, and very deep basins.',
    hazards: 'Depth drops fast. Cold water, sudden mountain weather, limited access, and long paddle distances.',
    seasonalPattern: 'Trout/cold-water patterns, deep vertical electronics work, and clear-water finesse bass tactics.',
    tacticalNotes: ['Safety first: cold deep water and limited shoreline access.', 'Electronics and downrigger/vertical presentations shine.'],
  },
};

/* ───────── helpers ───────── */
async function fetchText(url, opts={}) {
  const res = await fetch(url, {
    cf: { cacheTtl: 120, cacheEverything: true },
    headers: { 'User-Agent': 'TrollMap/10 Worker', 'Accept': 'text/html,application/json,*/*' },
    ...opts,
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

async function fetchUsgs(site, paramCd, periodDays=2) {
  // USGS's JSON endpoint occasionally returns empty value arrays even when
  // the gauge has fresh data (the metadata says the parameter exists, but
  // the JSON serializer drops the values). The RDB (tab-separated) endpoint
  // always works. So: try JSON first, then fall back to RDB.
  const out = {};
  const jsonUrl = `https://waterservices.usgs.gov/nwis/iv/?sites=${site}&parameterCd=${paramCd}&format=json&period=P${periodDays}D`;
  try {
    const r = await fetch(jsonUrl, { cf:{ cacheTtl:120 } });
    if (r.ok) {
      const j = await r.json();
      for (const ts of (j?.value?.timeSeries||[])) {
        const code = ts?.variable?.variableCode?.[0]?.value;
        const vals = ts?.values?.[0]?.values || [];
        const good = vals.filter(v => v.value !== '' && v.value !== '-999999' && v.value != null);
        if (!good.length) continue;
        const latest = parseFloat(good[good.length-1].value);
        if (!isFinite(latest)) continue;
        if (code === '00010') out.tempC = latest;
        if (code === '00065') out.gageHeight = latest;
        if (code === '00062') out.elevation = latest;
        if (code === '62614') out.elevation = latest;
        if (code === '62615') out.elevation = latest;
        if (code === '63160') out.elevationNavd88 = latest;
        if (code === '00060') out.streamflow = latest;
        out.timestamp = good[good.length-1].dateTime;
      }
    }
  } catch (_) {}

  // If JSON returned at least one useful value, we're done.
  if (out.tempC != null || out.gageHeight != null || out.elevation != null) return out;

  // Fallback: RDB tab-format. This is what the USGS website itself uses
  // and it always returns data when the gauge has any.
  try {
    const rdbUrl = `https://waterservices.usgs.gov/nwis/iv/?sites=${site}&parameterCd=${paramCd}&format=rdb&period=P${periodDays}D`;
    const r = await fetch(rdbUrl, { cf:{ cacheTtl:120 } });
    if (!r.ok) return out;
    const text = await r.text();

    // Find the header line (starts with "agency_cd") to learn column order
    const lines = text.split('\n').filter(l => l && !l.startsWith('#'));
    if (lines.length < 3) return out;
    const header = lines[0].split('\t');
    // skip the type line (5s, 15s, etc.)
    const dataLines = lines.slice(2).filter(l => l.startsWith('USGS'));
    if (!dataLines.length) return out;
    const last = dataLines[dataLines.length-1].split('\t');

    // Header columns look like: agency_cd | site_no | datetime | tz_cd | <param>_<series>_<stat> | <param>_<series>_<stat>_cd | ...
    // Parameter columns are paired: value, then qualifier code.
    for (let i = 4; i < header.length; i++) {
      const h = header[i];
      if (!h || h.endsWith('_cd')) continue;
      // Column header includes the parameter code, e.g. "12345_00010" or "12345_00010_00003"
      const m = h.match(/_(\d{5})(?:_|$)/);
      if (!m) continue;
      const code = m[1];
      const v = parseFloat(last[i]);
      if (!isFinite(v)) continue;
      if (code === '00010' && out.tempC       == null) out.tempC       = v;
      if (code === '00065' && out.gageHeight  == null) out.gageHeight  = v;
      if (code === '00062' && out.elevation   == null) out.elevation   = v;
      if (code === '62614' && out.elevation   == null) out.elevation   = v;
      if (code === '62615' && out.elevation   == null) out.elevation   = v;
      if (code === '63160' && out.elevationNavd88 == null) out.elevationNavd88 = v;
      if (code === '00060' && out.streamflow  == null) out.streamflow  = v;
    }
    if (!out.timestamp && last[2]) out.timestamp = `${last[2]} ${last[3]||''}`.trim();
  } catch (_) {}

  return out;
}

/* Live Duke API. As of 2026-06 the dashboard is an Angular SPA at
   lakes.hydro-derived.duke-energy.app/ and the real data lives at:
       https://api.hydro-derived.duke-energy.app/lakes/current-level
   Returns an array of objects with LakeDisplayName, Actual, Target, Min,
   Max, Elevation ("100.0 ft (AMSL, NGVD 29 datum)"), SurfaceArea etc.
   `Actual` is PERCENT of full pool for ~75% of lakes and FEET for the
   rest (Belews, Harris, Hyco, Robinson, Julian, Mayo, etc.) — we handle
   both. */
async function fetchDukeApi() {
  try {
    const r = await fetch('https://api.hydro-derived.duke-energy.app/lakes/current-level', {
      cf: { cacheTtl: 120, cacheEverything: true },
      headers: {
        'User-Agent': 'TrollMap/10 Worker',
        'Origin': 'https://lakes.hydro-derived.duke-energy.app',
        'Referer': 'https://lakes.hydro-derived.duke-energy.app/',
        'Accept': 'application/json',
      },
    });
    if (!r.ok) return null;
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) return null;
    return arr;
  } catch (_) { return null; }
}

/* Convert one Duke API row into normalized {pct, ft, fullPool} */
function normalizeDukeRow(row) {
  const actual = parseFloat(row.Actual);
  const elevMatch = String(row.Elevation || '').match(/([0-9]+(?:\.[0-9]+)?)/);
  const fullPool = elevMatch ? parseFloat(elevMatch[1]) : null;
  if (!isFinite(actual)) return null;

  // Heuristic: if "Actual" is in the same ballpark as the full-pool ft value, it's already feet.
  // Otherwise it's percent. Cutoff: anything > 100 is definitely feet.
  // For percent values, ft = (pct/100) * fullPool.
  let pct = null, ft = null;
  if (actual > 100 || (fullPool && Math.abs(actual - fullPool) < fullPool * 0.10 && actual > 50)) {
    // already in feet
    ft = actual;
    pct = fullPool ? (actual / fullPool) * 100 : null;
  } else {
    pct = actual;
    ft = fullPool ? (actual / 100) * fullPool : null;
  }
  return {
    name: row.LakeDisplayName || row.LakeName || '',
    pct: pct != null ? Math.round(pct*100)/100 : null,
    ft:  ft  != null ? Math.round(ft *100)/100 : null,
    fullPool,
    target: parseFloat(row.Target),
    min: parseFloat(row.Min),
    max: parseFloat(row.Max),
    date: row.Date,
    specialMessage: Array.isArray(row.SpecialMessage) && row.SpecialMessage[0] ? row.SpecialMessage[0].Text : null,
  };
}

/* Look up a single normalized lake by fuzzy name match */
async function getDukeLake(nameFragment) {
  const arr = await fetchDukeApi();
  if (!arr) return null;
  const frag = nameFragment.toLowerCase();
  const row = arr.find(r => (r.LakeDisplayName || '').toLowerCase().includes(frag)
                          || (r.LakeName        || '').toLowerCase().includes(frag));
  return row ? normalizeDukeRow(row) : null;
}

/* Legacy: still serve raw HTML for any front-end that scrapes
   (we now synthesise a tiny text doc the existing parser can read) */
async function fetchDukeDashboard(basin='1') {
  const arr = await fetchDukeApi();
  if (!arr) return null;
  // Build a plain-text rendering so existing parseDukeText() scrapers in the
  // front-end can still extract "Lake Wateree  220.76" patterns.
  const lines = arr.map(r => {
    const n = normalizeDukeRow(r);
    if (!n) return '';
    return `${n.name} · ${n.ft != null ? n.ft.toFixed(2) : 'NA'} · ${n.pct != null ? n.pct.toFixed(2)+'%' : 'NA'} · target ${isFinite(n.target)?n.target:'NA'} · full ${n.fullPool||'NA'}`;
  }).filter(Boolean);
  return { url: 'https://api.hydro-derived.duke-energy.app/lakes/current-level', text: lines.join('\n'), json: arr };
}

/* Santee Cooper public lake levels (Marion/Moultrie) */
async function fetchSanteeCooper() {
  const urls = [
    'https://www.santeecooper.com/community/lakes-and-recreation/lake-levels.aspx',
    'https://www.santeecooper.com/community/lakes-and-recreation/lake-levels',
  ];
  for (const u of urls) {
    const r = await fetchText(u);
    if (r.ok && r.text) {
      const marion   = r.text.match(/Marion[^0-9]{0,40}([0-9]{2}\.[0-9]{1,2})/i);
      const moultrie = r.text.match(/Moultrie[^0-9]{0,40}([0-9]{2}\.[0-9]{1,2})/i);
      if (marion || moultrie) {
        return {
          marion:   marion   ? parseFloat(marion[1])   : null,
          moultrie: moultrie ? parseFloat(moultrie[1]) : null,
          source:   u,
        };
      }
    }
  }
  return null;
}

/* USACE Savannah District daily lake report (Thurmond/Hartwell/Russell) */
async function fetchUsaceSavannah(lakeKey) {
  // Public daily report - tolerant scrape
  const urls = [
    'https://water.sas.usace.army.mil/Lakes.htm',
    'https://water.sas.usace.army.mil/',
  ];
  for (const u of urls) {
    const r = await fetchText(u);
    if (r.ok && r.text) {
      const name = { thurmond:'Thurmond', hartwell:'Hartwell', russell:'Russell' }[lakeKey];
      if (!name) return null;
      const m = r.text.match(new RegExp(name + '[^0-9]{0,80}([0-9]{3}\\.[0-9]{1,2})', 'i'));
      if (m) return { elevation: parseFloat(m[1]), source: u };
    }
  }
  return null;
}

/* Angler's Headquarters fishing-report scrape for water temperature.
   Their weekly reports contain phrases like:
     "Morning surface water temperatures are about 76 degrees"
     "surface water temperatures are in the upper 70s to low 80s"
     "Morning surface water temperature is 65 degrees"
   We take the FIRST occurrence on the page (= the most recent week's report).
   For range phrases ("upper 70s to low 80s") we estimate the midpoint. */
async function fetchAhqWaterTemp(slug) {
  if (!slug) return null;
  const url = `https://www.anglersheadquarters.com/pages/${slug}-fishing-report`;
  const r = await fetchText(url);
  if (!r.ok || !r.text) return null;

  // 1. Exact "N degrees" or "N to M degrees"
  const numericRe = /(?:morning\s+)?(?:surface\s+)?water\s+temperatures?\s+(?:are|is|range)\s+(?:about\s+|around\s+|from\s+|approximately\s+)?(\d{2,3})(?:\s*(?:to|[-–])\s*(\d{2,3}))?\s*degrees/i;
  const m = r.text.match(numericRe);
  if (m) {
    const a = parseInt(m[1]), b = m[2] ? parseInt(m[2]) : null;
    const tempF = b ? Math.round((a + b)/2) : a;
    return { tempF, source: url, raw: m[0], range: b ? [a,b] : null };
  }

  // 2. Vague "in the [lower|mid|upper] [N0s] to [lower|mid|upper] [M0s]"
  const vagueRe = /water\s+temperatures?\s+(?:are\s+|is\s+|now\s+)?(?:in\s+the\s+)?(lower|low|mid|upper|high)?\s*(\d{2,3})s(?:\s*(?:to|[-–])\s*(lower|low|mid|upper|high)?\s*(\d{2,3})s)?/i;
  const v = r.text.match(vagueRe);
  if (v) {
    const band = (mod, base) => {
      const b = parseInt(base);
      if (!mod || mod === 'mid') return b + 5;
      if (mod === 'lower' || mod === 'low') return b + 2;
      if (mod === 'upper' || mod === 'high') return b + 8;
      return b + 5;
    };
    const a = band(v[1], v[2]);
    const b = v[4] ? band(v[3], v[4]) : null;
    const tempF = b ? Math.round((a + b)/2) : a;
    return { tempF, source: url, raw: v[0], range: b ? [a,b] : null, approx:true };
  }
  return null;
}


const LAKE_INTEL_SOURCE_REGISTRY = {
  "default": {
    "official": [
      {
        "label": "State fisheries regulations / DNR",
        "url": "https://www.dnr.sc.gov/fishregs/",
        "trust": "OFFICIAL"
      }
    ],
    "habitat": [],
    "reports": [],
    "model": []
  },
  "wateree": {
    "official": [
      {
        "label": "Duke Energy Catawba-Wateree Lake Levels",
        "url": "https://lakes.hydro-derived.duke-energy.app/",
        "trust": "OFFICIAL_UTILITY",
        "use": "pool level / advisories"
      },
      {
        "label": "SCDNR Fishing Regulations",
        "url": "https://www.dnr.sc.gov/fishregs/",
        "trust": "OFFICIAL",
        "use": "seasons, limits, creel rules"
      },
      {
        "label": "USGS Wateree River near Camden 02148000",
        "url": "https://waterdata.usgs.gov/monitoring-location/02148000/",
        "trust": "OFFICIAL_PROXY",
        "use": "below-dam river temp/flow only, not lake pool"
      }
    ],
    "habitat": [
      {
        "label": "SCDNR fish attractor / public access GIS",
        "url": "https://data-scdnr.opendata.arcgis.com/",
        "trust": "OFFICIAL_GIS",
        "use": "ramps, public access, attractors when present"
      }
    ],
    "reports": [
      {
        "label": "Angler's Headquarters Lake Wateree Fishing Report",
        "url": "https://www.anglersheadquarters.com/pages/lake-wateree-fishing-report",
        "trust": "THIRD_PARTY_VERIFY",
        "use": "surface temp, clarity, bite/pattern report"
      }
    ],
    "model": [
      {
        "label": "LakeMonster Lake Wateree",
        "url": "https://lakemonster.com/lake/SC/Lake-Wateree-water-temperature-1072",
        "trust": "MODEL_VERIFY",
        "use": "surface temp estimate, weather, species/context"
      }
    ]
  },
  "murray": {
    "official": [
      {
        "label": "USGS Lake Murray near Columbia 02168500",
        "url": "https://waterdata.usgs.gov/monitoring-location/02168500/",
        "trust": "OFFICIAL",
        "use": "reservoir elevation"
      },
      {
        "label": "Dominion Energy Lake Murray Management",
        "url": "https://www.dominionenergy.com/projects-and-facilities/hydroelectric-power/lake-murray",
        "trust": "OFFICIAL_UTILITY",
        "use": "lake management / drawdown notices"
      },
      {
        "label": "SCDNR Fishing Regulations",
        "url": "https://www.dnr.sc.gov/fishregs/",
        "trust": "OFFICIAL",
        "use": "seasons and limits"
      }
    ],
    "habitat": [
      {
        "label": "SCDNR public access / fish habitat GIS",
        "url": "https://data-scdnr.opendata.arcgis.com/",
        "trust": "OFFICIAL_GIS"
      }
    ],
    "reports": [
      {
        "label": "Angler's Headquarters Lake Murray Fishing Report",
        "url": "https://www.anglersheadquarters.com/pages/lake-murray-fishing-report",
        "trust": "THIRD_PARTY_VERIFY"
      }
    ],
    "model": [
      {
        "label": "LakeMonster Lake Murray",
        "url": "https://lakemonster.com/lake/SC/Lake-Murray-water-temperature-1071",
        "trust": "MODEL_VERIFY"
      }
    ]
  },
  "marion": {
    "official": [
      {
        "label": "USGS Lake Marion near Elloree 02169921",
        "url": "https://waterdata.usgs.gov/monitoring-location/02169921/",
        "trust": "OFFICIAL",
        "use": "reservoir elevation"
      },
      {
        "label": "Santee Cooper Lake Data",
        "url": "https://www.santeecooper.com/community/lakes/lake-data/",
        "trust": "OFFICIAL_UTILITY",
        "use": "lake data / rule curve context"
      },
      {
        "label": "SCDNR Fishing Regulations",
        "url": "https://www.dnr.sc.gov/fishregs/",
        "trust": "OFFICIAL",
        "use": "Santee Cooper system rules"
      }
    ],
    "habitat": [
      {
        "label": "SCDNR public access / habitat GIS",
        "url": "https://data-scdnr.opendata.arcgis.com/",
        "trust": "OFFICIAL_GIS"
      }
    ],
    "reports": [
      {
        "label": "Angler's Headquarters Santee Cooper Fishing Report",
        "url": "https://www.anglersheadquarters.com/pages/santee-cooper-lake-marion-lake-moultrie-fishing-report",
        "trust": "THIRD_PARTY_VERIFY"
      }
    ],
    "model": []
  },
  "moultrie": {
    "official": [
      {
        "label": "USGS Lake Moultrie near Pinopolis 02172000",
        "url": "https://waterdata.usgs.gov/monitoring-location/02172000/",
        "trust": "OFFICIAL",
        "use": "reservoir elevation"
      },
      {
        "label": "Santee Cooper Lake Data",
        "url": "https://www.santeecooper.com/community/lakes/lake-data/",
        "trust": "OFFICIAL_UTILITY",
        "use": "lake data / rule curve context"
      },
      {
        "label": "SCDNR Fishing Regulations",
        "url": "https://www.dnr.sc.gov/fishregs/",
        "trust": "OFFICIAL"
      }
    ],
    "habitat": [
      {
        "label": "SCDNR public access / habitat GIS",
        "url": "https://data-scdnr.opendata.arcgis.com/",
        "trust": "OFFICIAL_GIS"
      }
    ],
    "reports": [
      {
        "label": "Angler's Headquarters Santee Cooper Fishing Report",
        "url": "https://www.anglersheadquarters.com/pages/santee-cooper-lake-marion-lake-moultrie-fishing-report",
        "trust": "THIRD_PARTY_VERIFY"
      }
    ],
    "model": []
  },
  "keowee": {
    "official": [
      {
        "label": "Duke Energy Lake Levels",
        "url": "https://lakes.hydro-derived.duke-energy.app/",
        "trust": "OFFICIAL_UTILITY",
        "use": "pool level / advisories"
      },
      {
        "label": "SCDNR Fishing Regulations",
        "url": "https://www.dnr.sc.gov/fishregs/",
        "trust": "OFFICIAL"
      }
    ],
    "habitat": [
      {
        "label": "SCDNR public access / habitat GIS",
        "url": "https://data-scdnr.opendata.arcgis.com/",
        "trust": "OFFICIAL_GIS"
      }
    ],
    "reports": [
      {
        "label": "Angler's Headquarters Lake Keowee Fishing Report",
        "url": "https://www.anglersheadquarters.com/pages/lake-keowee-fishing-report",
        "trust": "THIRD_PARTY_VERIFY"
      }
    ],
    "model": [
      {
        "label": "LakeMonster Lake Keowee",
        "url": "https://lakemonster.com/lake/SC/Lake-Keowee-water-temperature-1068",
        "trust": "MODEL_VERIFY"
      }
    ]
  },
  "hartwell": {
    "official": [
      {
        "label": "USGS Hartwell Lake 02187010",
        "url": "https://waterdata.usgs.gov/monitoring-location/02187010/",
        "trust": "OFFICIAL",
        "use": "reservoir elevation"
      },
      {
        "label": "USACE Savannah District Lake Levels",
        "url": "https://water.sas.usace.army.mil/",
        "trust": "OFFICIAL_FEDERAL",
        "use": "USACE lake levels"
      },
      {
        "label": "SCDNR / GA DNR Regulations",
        "url": "https://www.dnr.sc.gov/fishregs/",
        "trust": "OFFICIAL"
      }
    ],
    "reports": [
      {
        "label": "Angler's Headquarters Lake Hartwell Fishing Report",
        "url": "https://www.anglersheadquarters.com/pages/lake-hartwell-fishing-report",
        "trust": "THIRD_PARTY_VERIFY"
      }
    ],
    "model": [
      {
        "label": "LakeMonster Lake Hartwell",
        "url": "https://lakemonster.com/lake/GA/Lake-Hartwell-water-temperature-1029",
        "trust": "MODEL_VERIFY"
      }
    ]
  },
  "thurmond": {
    "official": [
      {
        "label": "USACE Savannah District Thurmond Lake",
        "url": "https://water.sas.usace.army.mil/",
        "trust": "OFFICIAL_FEDERAL",
        "use": "lake level / ramp context"
      },
      {
        "label": "SCDNR / GA DNR Regulations",
        "url": "https://www.dnr.sc.gov/fishregs/",
        "trust": "OFFICIAL"
      }
    ],
    "reports": [
      {
        "label": "Angler's Headquarters Clarks Hill Fishing Report",
        "url": "https://www.anglersheadquarters.com/pages/clarks-hill-lake-thurmond-fishing-report",
        "trust": "THIRD_PARTY_VERIFY"
      }
    ],
    "model": []
  },
  "russell": {
    "official": [
      {
        "label": "USACE Savannah District Russell Lake",
        "url": "https://water.sas.usace.army.mil/",
        "trust": "OFFICIAL_FEDERAL",
        "use": "lake level / project info"
      },
      {
        "label": "SCDNR / GA DNR Regulations",
        "url": "https://www.dnr.sc.gov/fishregs/",
        "trust": "OFFICIAL"
      }
    ],
    "reports": [
      {
        "label": "Angler's Headquarters Lake Russell Fishing Report",
        "url": "https://www.anglersheadquarters.com/pages/lake-russell-fishing-report",
        "trust": "THIRD_PARTY_VERIFY"
      }
    ],
    "model": []
  },
  "jocassee": {
    "official": [
      {
        "label": "Duke Energy Lake Levels",
        "url": "https://lakes.hydro-derived.duke-energy.app/",
        "trust": "OFFICIAL_UTILITY"
      },
      {
        "label": "SCDNR Fishing Regulations",
        "url": "https://www.dnr.sc.gov/fishregs/",
        "trust": "OFFICIAL"
      }
    ],
    "reports": [
      {
        "label": "Angler's Headquarters Lake Jocassee Fishing Report",
        "url": "https://www.anglersheadquarters.com/pages/lake-jocassee-fishing-report",
        "trust": "THIRD_PARTY_VERIFY"
      }
    ],
    "model": []
  },
  "norman": {
    "official": [
      {
        "label": "Duke Energy Lake Levels",
        "url": "https://lakes.hydro-derived.duke-energy.app/",
        "trust": "OFFICIAL_UTILITY"
      }
    ],
    "reports": [],
    "model": [
      {
        "label": "LakeMonster Lake Norman",
        "url": "https://lakemonster.com/lake/NC/Lake-Norman-water-temperature-232",
        "trust": "MODEL_VERIFY"
      }
    ]
  }
};

const LAKEMONSTER_IDS = {
  wateree: 1072,
  murray: 1071,
  keowee: 1068,
  hartwell: 1029,
  norman: 232,
};

async function fetchLakeMonsterIntel(key) {
  const id = LAKEMONSTER_IDS[key];
  if (!id) return null;
  const url = `https://lakemonster.com/lake/SC/${encodeURIComponent((LAKE_INTEL[key]?.displayName || key).replace(/\s+/g, '-'))}-water-temperature-${id}`;
  try {
    const r = await fetchText(url);
    if (!r.ok || !r.text) return null;
    const text = stripHtml(r.text);
    const water = text.match(/(?:Right Now[\s\S]{0,250}?Water\s*|Water\s*)(\d{2,3})°/i) || text.match(/Water\s*(\d{2,3})°F/i);
    const acres = text.match(/([0-9,]+)\s*acres/i);
    const elev = text.match(/([0-9,]+)\s*ft\s*elev/i);
    const fishCount = text.match(/(\d+)\s*fish species/i);
    const bite = text.match(/Bite\s*(\d\s*\/\s*5)/i);
    const pressure = text.match(/Pressure\s*([0-9.]+)\s*(rising|falling|stable)/i);
    const wind = text.match(/Wind\s*(\d{1,2})\s*mph\s*([A-Z]{1,3})?/i);
    const species = [];
    const speciesNames = ['Largemouth bass','Smallmouth bass','Spotted bass','Striped bass','White bass','Bluegill','Black crappie','White crappie','Catfish','Channel catfish','Flathead catfish','Blue catfish','Walleye','Trout'];
    for (const sp of speciesNames) {
      if (new RegExp(sp.replace(/ /g,'\\s+'), 'i').test(text) && !species.includes(sp)) species.push(sp);
    }
    let context = '';
    const ctxMatch = text.match(/Today['’]?s forecast for Lake[^.]+\./i) || text.match(/Fishable[\s\S]{0,450}?water temp[\s\S]{0,250}/i);
    if (ctxMatch) context = ctxMatch[0].replace(/\s+/g, ' ').trim().slice(0, 500);
    return {
      source: url,
      note: 'VERIFY: LakeMonster is a third-party/model/aggregate source, not official DNR/USGS/utility data.',
      waterTemp_F: water ? parseInt(water[1],10) : null,
      acreage: acres ? acres[1] : null,
      elevation_ft: elev ? elev[1] : null,
      fishSpeciesCount: fishCount ? parseInt(fishCount[1],10) : null,
      species: species.slice(0, 12),
      biteRating: bite ? bite[1].replace(/\s+/g,'') : null,
      pressure: pressure ? `${pressure[1]} ${pressure[2]}` : null,
      wind: wind ? `${wind[1]} mph${wind[2] ? ' '+wind[2] : ''}` : null,
      context,
    };
  } catch (_) { return null; }
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchAhqFishingReport(slug) {
  if (!slug) return null;
  const url = `https://www.anglersheadquarters.com/pages/${slug}-fishing-report`;
  try {
    const r = await fetchText(url);
    if (!r.ok || !r.text) return null;
    const text = stripHtml(r.text);
    const idxs = [
      text.search(/Morning surface water temperatures/i),
      text.search(/water temperatures/i),
      text.search(/Bass fishing|striper|crappie|catfish/i),
    ].filter(i => i >= 0);
    const idx = idxs.length ? Math.min(...idxs) : 0;
    let summary = text.slice(Math.max(0, idx - 180), idx + 900).trim();
    if (summary.length > 1000) summary = summary.slice(0, 1000) + '…';
    return { source: url, summary };
  } catch (_) { return null; }
}

function lakeKeyFromName(lakeName) {
  const raw = String(lakeName || '').toLowerCase();
  const normalized = raw.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const aliases = {
    wateree: 'wateree', murray: 'murray', marion: 'marion', moultrie: 'moultrie',
    keowee: 'keowee', jocassee: 'jocassee', hartwell: 'hartwell',
    thurmond: 'thurmond', 'clarks hill': 'thurmond', 'clark hill': 'thurmond',
    russell: 'russell', wylie: 'wylie', norman: 'norman',
  };
  for (const [frag, key] of Object.entries(aliases)) {
    if (normalized.includes(frag)) return key;
  }
  return normalized.split(' ')[0] || '';
}



const LAKE_CLARITY_PROFILES = {
  wateree: {
    displayName: 'Lake Wateree', center: [34.41, -80.86],
    defaultNote: 'Runoff usually stains upper/northern creeks first; lower/deeper main-lake water near the dam generally stays clearer longest.',
    zones: [
      { name:'Upper river / north end', sensitivity:1.45, base:10, likely:'stains first from Catawba/Wateree inflow and clay banks', ramps:['Lugoff / upstream river ramps'] },
      { name:'Dutchmans Creek / upper west arms', sensitivity:1.35, base:8, likely:'creek-arm runoff and shallow clay banks; expect mudlines after rain', ramps:['Dutchmans Creek area'] },
      { name:'Wateree Creek', sensitivity:1.25, base:8, likely:'first major cove south of dam; can muddy in backs while mouth stays fishable', ramps:['Wateree Creek Access Area'] },
      { name:'Beaver Creek / State Park side', sensitivity:1.05, base:6, likely:'moderate runoff; pockets stain before main points', ramps:['Lake Wateree State Park','Beaver Creek Access'] },
      { name:'Colonel / June Creek', sensitivity:1.05, base:6, likely:'creek backs stain, mouths create fishable color breaks', ramps:['Colonel Creek','June Creek'] },
      { name:'Lower main-lake channel / dam basin', sensitivity:0.70, base:2, likely:'deepest/clearest available water after rain', ramps:['Clearwater Cove Marina','Buck Hill / lower lake ramps'] },
    ]
  },
  murray: {
    displayName:'Lake Murray', center:[34.08,-81.35],
    defaultNote:'Upper river/creek arms stain first; dam/lower-lake herring water generally stays clearer.',
    zones:[
      {name:'Upper Saluda / river arms', sensitivity:1.4, base:8, likely:'muddy first after rain', ramps:['River Bend','Kempsons Bridge']},
      {name:'Major creek backs', sensitivity:1.15, base:6, likely:'stained backs, cleaner mouths', ramps:['creek-arm ramps']},
      {name:'Mid-lake points / islands', sensitivity:0.9, base:3, likely:'slight stain after moderate rain', ramps:['Hilton','Dreher Island']},
      {name:'Dam / lower lake', sensitivity:0.65, base:1, likely:'clearest water and herring-oriented bite', ramps:['Lake Murray Dam','Larry Koon']},
    ]
  },
  marion: {
    displayName:'Lake Marion', center:[33.55,-80.30],
    defaultNote:'Large shallow stump/swamp reservoir; rain creates tannic/muddy creek water and debris risk, especially in upper/swamp sections.',
    zones:[
      {name:'Upper swamp / river runs', sensitivity:1.55, base:12, likely:'muddy/tannic and debris-prone', ramps:['Rimini','Low Falls']},
      {name:'Stump flats / shallow coves', sensitivity:1.25, base:10, likely:'stained with navigation hazards', ramps:['Taw Caw','John C. Land']},
      {name:'Main-lake open water', sensitivity:0.9, base:6, likely:'wind-stained but more buffered than creek backs', ramps:['Santee State Park']},
      {name:'Canal / dam-influenced areas', sensitivity:0.8, base:4, likely:'often fishable but wind/current dependent', ramps:['C. Alex Harvin III']},
    ]
  },
  moultrie: {
    displayName:'Lake Moultrie', center:[33.28,-80.05],
    defaultNote:'Wind-driven clarity matters as much as rain; broad open water can muddy quickly on windward banks.',
    zones:[
      {name:'Windward open lake', sensitivity:1.1, base:8, likely:'wind-stained/choppy', ramps:['open-water ramps']},
      {name:'Protected leeward banks/canals', sensitivity:0.75, base:3, likely:'best clarity after weather', ramps:['protected canals']},
      {name:'Shallow grass/hard-edge zones', sensitivity:1.0, base:6, likely:'can be stained but productive on moving bait', ramps:['Fred L. Day','Hatchery']},
    ]
  },
  keowee: {
    displayName:'Lake Keowee', center:[34.70,-82.90],
    defaultNote:'Deep clear herring lake; runoff affects backs of creeks first while main points often stay clear.',
    zones:[
      {name:'Creek backs', sensitivity:1.15, base:5, likely:'slight stain after rain', ramps:['creek ramps']},
      {name:'Main-lake points / lower lake', sensitivity:0.45, base:0, likely:'usually clear', ramps:['South Cove','High Falls']},
    ]
  },
  hartwell: {
    displayName:'Lake Hartwell', center:[34.48,-82.85],
    defaultNote:'Huge herring reservoir; upper arms stain first, lower main lake stays clearer.',
    zones:[
      {name:'Upper river arms', sensitivity:1.35, base:8, likely:'stained/muddy after rain', ramps:['upper-arm ramps']},
      {name:'Creek arms', sensitivity:1.05, base:5, likely:'backs stain, mouths fishable', ramps:['creek ramps']},
      {name:'Lower main lake', sensitivity:0.65, base:2, likely:'clearest available water', ramps:['Green Pond','Broyles']},
    ]
  }
};

function classifyClarity(score){
  if(score < 20) return {clarity:'Clear', label:'Clear', select:'Clear'};
  if(score < 40) return {clarity:'Slight stain', label:'Slight stain', select:'Stained'};
  if(score < 65) return {clarity:'Stained', label:'Stained', select:'Stained'};
  if(score < 85) return {clarity:'Muddy', label:'Muddy', select:'Muddy'};
  return {clarity:'Muddy / debris risk', label:'Muddy / debris risk', select:'Muddy'};
}

function clarityLurePack(clarity){
  const c=String(clarity||'').toLowerCase();
  if(c.includes('clear')) return {
    colors:['Blueback herring','Natural pearl','Ghost shad','Bone','Silver flash'],
    tactics:['longer leads','fluorocarbon leaders','natural profiles','fish deeper/clearer main-lake structure']
  };
  if(c.includes('slight')) return {
    colors:['Pearl/chartreuse','Sexy shad','Tennessee shad','Silver/gold mix','UV white'],
    tactics:['target creek-mouth color breaks','slightly larger profile','moderate vibration']
  };
  if(c.includes('stained')) return {
    colors:['Chartreuse/white','Firetiger','Gold/copper','Orange belly','Black back'],
    tactics:['fish mudline edges','use vibration/rattles','shorten lead around cover']
  };
  return {
    colors:['Black/blue','Chartreuse/black','Bright white/chartreuse','Orange/red craw','large dark silhouette'],
    tactics:['avoid backs unless targeting catfish/cover','fish seams and hard edges','maximize vibration/scent','watch debris']
  };
}

async function fetchOpenMeteoRain(lat, lon, tripDate){
  try{
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=precipitation_sum,windspeed_10m_max,winddirection_10m_dominant&past_days=3&forecast_days=7&timezone=America%2FNew_York`;
    const r = await fetch(url, { cf:{ cacheTtl:900, cacheEverything:true } });
    if(!r.ok) return null;
    const j = await r.json();
    const times = j?.daily?.time || [];
    const precip = j?.daily?.precipitation_sum || [];
    const wind = j?.daily?.windspeed_10m_max || [];
    const wdir = j?.daily?.winddirection_10m_dominant || [];
    const idx = Math.max(0, times.indexOf(tripDate || new Date().toISOString().slice(0,10)));
    const mm = (i)=> (i>=0 && i<precip.length && isFinite(precip[i])) ? precip[i] : 0;
    const p24 = mm(idx-1);
    const p48 = mm(idx-2);
    const p72 = mm(idx-3);
    const pTrip = mm(idx);
    const total72 = p24+p48+p72+(0.5*pTrip);
    return {
      source:url, date: times[idx] || tripDate,
      precip24_mm:p24, precip48_mm:p48, precip72_mm:p72, precipTrip_mm:pTrip,
      weighted72_mm: total72,
      weighted72_in: +(total72/25.4).toFixed(2),
      windMax_mph: wind[idx] != null ? Math.round(wind[idx]*0.621371) : null,
      windDirection_deg: wdir[idx] ?? null,
    };
  } catch(_) { return null; }
}

async function getLakeClarity(lakeName, tripDate){
  const key = lakeKeyFromName(lakeName);
  const profile = LAKE_CLARITY_PROFILES[key] || { displayName: lakeName, center:[34,-81], defaultNote:'No custom clarity model yet; generic creek/runoff model used.', zones:[{name:'Creeks/upper arms', sensitivity:1.2, base:6, likely:'stain first', ramps:[]},{name:'Main lake/lower basin', sensitivity:0.75, base:2, likely:'clearest available water', ramps:[]}] };
  const [lat,lon] = profile.center;
  const rain = await fetchOpenMeteoRain(lat, lon, tripDate);
  const rainIn = rain?.weighted72_in ?? 0;
  const rainScore = rain ? Math.min(100, rainIn*35 + (rain.precip24_mm/25.4)*25 + (rain.precipTrip_mm/25.4)*20) : 20;
  const zones = profile.zones.map(z=>{
    const score = Math.max(0, Math.min(100, z.base + rainScore*z.sensitivity));
    const cls = classifyClarity(score);
    const pack = clarityLurePack(cls.clarity);
    return { ...z, score: Math.round(score), clarity: cls.clarity, select: cls.select, lureColors: pack.colors, tactics: pack.tactics };
  });
  const avg = zones.reduce((a,z)=>a+z.score,0)/Math.max(1,zones.length);
  const overall = classifyClarity(avg);
  const bestZones = [...zones].sort((a,b)=>a.score-b.score).slice(0,3);
  const dirtyZones = [...zones].sort((a,b)=>b.score-a.score).slice(0,3);
  const rampRecommendations = bestZones.map((z,i)=>({
    zone:z.name, ramps:z.ramps||[], score: Math.max(0, 100-z.score), why:`${z.clarity}; ${z.likely}. ${i===0?'Best clarity/safety starting point.':'Secondary option.'}`
  }));
  const pack = clarityLurePack(overall.clarity);
  return {
    lake: profile.displayName || lakeName, key, tripDate,
    confidence: rain ? 'medium: forecast/rainfall model, verify at ramp' : 'low: no rainfall feed, generic model',
    summary: rain ? `${profile.displayName||lakeName}: ${rain.weighted72_in}" weighted rain/runoff signal. ${overall.clarity} overall predicted; upper/creek arms likely dirtier than lower/main lake.` : `${profile.displayName||lakeName}: generic clarity estimate. Verify locally.`,
    overall: { clarity: overall.clarity, select: overall.select, score: Math.round(avg), lureColors: pack.colors, tactics: pack.tactics },
    rain, zones, bestZones, dirtyZones, rampRecommendations,
    note: profile.defaultNote,
    verify: 'Predicted from rainfall/forecast/wind/lake-zone rules — verify water color at the ramp before committing.'
  };
}

function getLakeIntelSourceRegistry(key) {
  const base = LAKE_INTEL_SOURCE_REGISTRY.default || {};
  const lake = LAKE_INTEL_SOURCE_REGISTRY[key] || {};
  const merged = { official: [], habitat: [], reports: [], model: [] };
  for (const tier of Object.keys(merged)) {
    merged[tier] = [...(base[tier] || []), ...(lake[tier] || [])];
  }
  const officialCount = merged.official.length + merged.habitat.length;
  const verifyCount = merged.reports.length + merged.model.length;
  return {
    ...merged,
    summary: {
      officialCount, verifyCount,
      trustModel: 'OFFICIAL/CURATED facts first; THIRD_PARTY/MODEL sources are supplemental and must be verified.'
    }
  };
}

async function getLakeIntel(lakeName) {
  const key = lakeKeyFromName(lakeName);
  const sourceRegistry = getLakeIntelSourceRegistry(key);
  const profile = LAKE_INTEL[key] || {
    displayName: lakeName || key || 'Unknown lake',
    primarySportFish: [], forage: [],
    stocking: 'VERIFY: No curated stocking profile yet. Check state DNR stocking, creel-limit, and lake-management pages before relying on this.',
    spottedBass: 'No verified spotted-bass note yet.',
    habitat: 'No curated habitat profile yet.',
    bottom: 'Unknown / verify with Navionics, sonar logs, local reports, and state habitat maps.',
    hazards: 'Unknown / verify ramps, lake level, stump fields, timber, shoals, and boat traffic locally.',
    seasonalPattern: 'Use current water temperature, forage, and recent reports to build a pattern.',
    tacticalNotes: ['No verified curated profile yet — treat this as a research checklist, not a fact sheet.'],
  };
  const lakeCfg = LAKES[key];
  const latestReport = lakeCfg?.ahq ? await fetchAhqFishingReport(lakeCfg.ahq) : null;
  const lakeMonster = await fetchLakeMonsterIntel(key);
  const sources = [
    { label: 'State fisheries / regulations', url: 'https://www.dnr.sc.gov/fishregs/' },
  ];
  if (latestReport?.source) sources.push({ label: "Angler's Headquarters fishing report (VERIFY: third-party scraped text)", url: latestReport.source });
  if (lakeMonster?.source) sources.push({ label: 'LakeMonster lake context (VERIFY: third-party aggregate/model)', url: lakeMonster.source });
  if (lakeCfg) sources.push({ label: 'TrollMap live level worker', url: `/lake?lake=${encodeURIComponent(key)}` });
  return {
    lake: profile.displayName || lakeName,
    key,
    profile,
    latestReport,
    lakeMonster,
    sourceRegistry,
    sources,
    timestamp: new Date().toISOString(),
    confidence: LAKE_INTEL[key] ? 'curated_profile_plus_live_scrape_when_available' : 'generic_unverified_profile',
  };
}

/* ───────── RIVERS ─────────
   For each river we track:
     - one or more USGS gauges (instantaneous values)
     - the dam(s) immediately upstream (for release-pattern detection)
     - operator metadata
     - kayak/canoe safety thresholds (see below)

   Dam release schedules are NOT published in real-time by Duke/Dominion/Santee
   Cooper for any of these rivers. The best proxy is the rate-of-change in
   the USGS gauge directly below the dam — a sudden flow spike means the dam
   started generating; flat low flow means it's quiet. We compute that on
   the fly using the 24h USGS time series.

   Kayak safety thresholds derive from published guidance:
     - <USGS BoatSafe / Roanoke Mountain Adventures / Madison River guides:
       calm <500 cfs, normal 500-1500, pushy 1500-3000, danger >3000 for
       a typical mid-sized river. We tune per-river based on local norms.
     - Sudden rate-of-rise of >2 ft/hr in gauge height is a major red flag
       (dam generation surge or flash-flood pulse).
     - Water-temperature stress: cold tailwater (<55°F) → hypothermia risk
       in a capsize, especially for kayakers. */

const RIVERS = {
  wateree: {
    label: 'Wateree River (below Wateree Dam)',
    operator: 'Duke Energy',
    damName: 'Wateree Dam',
    damLakeKey: 'wateree',   // → cross-link to LAKES.wateree pool data
    dukeBasinId: 1,          // → fetchDukeFlowArrivals(1) returns the Catawba/Wateree schedule
    // River centerline reference points: river_mi 0 = dam, increasing downstream.
    // CORRECTED 2026-06-18 — previous version had several errors:
    //   * Dam coords were ~11 mi off (had -80.86, actual -80.7004 per damsoftheworld.com & SC Picture Project)
    //   * June Creek + Colonel Creek were placed on the RIVER but they're actually
    //     ramps on LAKE Wateree (above the dam) — wrong waterbody entirely
    //   * Sparkleberry Swamp was placed at mile 35; it's actually at the BOTTOM end
    //     of the free-flowing river, at the head of Lake Marion (~mile 48)
    //   * Total length "75 mi" from SC Encyclopedia includes the Catawba portion
    //     above Lake Wateree; the free-flowing river BELOW the dam is ~48 mi
    riverLength_mi: 48,
    surgeSpeed_mph: 2.5,      // calibrated: Duke API anchor (Hwy 1/601, 7.4 mi) arrives ~3h after generation start
    // Duke's "Highway 1/Highway 601 Landing" mile-marker corresponds to the
    // USGS 02148000 gauge: "7.4 mi downstream from Wateree Dam, at river mile 68.8"
    // (per USGS site metadata https://waterdata.usgs.gov/nwis/wys_rpt/?site_no=02148000)
    dukeAnchorRiverMi: 7.4,
    dukeAnchorLat: 34.2446,
    dukeAnchorLon: -80.6540,
    // Surge severity attenuation — piecewise model calibrated against the
    // documented paddler observation of "5 ft surge still arriving at mile 35"
    // (paddling.com Wateree trip report) and the fact that the river fans into
    // Lake Marion at the confluence (~mile 48) where the surge dissipates fast.
    //   miles  0-20: 1.00 → 0.80   (full severity)
    //   miles 20-40: 0.80 → 0.60   (moderate — matches "5 ft at mile 35")
    //   miles 40-48: 0.60 → 0.20   (rapid attenuation as river enters Marion)
    //   past 48:     0.20          (in lake — surge dispersed into vast volume)
    surgeAttenuation: { type: 'piecewise', knots: [
      { mi:  0, sev: 1.00 },
      { mi: 20, sev: 0.80 },
      { mi: 40, sev: 0.60 },
      { mi: 48, sev: 0.20 },
      { mi: 999, sev: 0.20 },
    ]},
    // Centerline waypoints (N → S, downstream). Only VERIFIED locations.
    // River-miles calibrated using sinuosity factor ~1.07 derived from the
    // known Dam → Camden segment (6.9 mi straight-line = 7.4 river miles).
    // Centerline waypoints sourced from VERIFIED TrollMap LAUNCHES data
    // (index.html line 1164 "Wateree River" entry) plus USGS gauge metadata.
    // River-miles calibrated using sinuosity factor 1.07 derived from the
    // Dam → Hwy 1 segment (USGS metadata: site 02148000 = "7.4 mi downstream
    // from Wateree Dam, at river mile 68.8").
    centerline: [
      { name: 'Wateree Dam (Duke hydro plant)',           lat: 34.3376, lon: -80.7004, mi:  0.0 },
      { name: 'Lugoff (TrollMap)',                        lat: 34.33346, lon: -80.69973, mi:  0.3 },
      { name: 'Highway 1 / Camden (TrollMap; USGS 02148000 site)',
                                                           lat: 34.24486, lon: -80.65403, mi:  7.4 },
      { name: 'WT Billy Tolar (TrollMap)',                lat: 33.94721, lon: -80.62891, mi: 29.0 },
      { name: 'USGS 02148315 (below Eastover)',           lat: 33.8285, lon: -80.6204, mi: 38.0 },
      { name: 'Wateree/Congaree confluence (Sparkleberry / head of Lake Marion)',
                                                           lat: 33.7200, lon: -80.4600, mi: 48.0 },
    ],
    gauges: [
      { site: '02148000', name: 'Wateree River near Camden, SC', primary: true,
        lat: 34.2446, lon: -80.6540, riverMi: 7.4 },
      { site: '02148315', name: 'Wateree River below Eastover, SC',
        lat: 33.8285, lon: -80.6204, riverMi: 38.0 },
    ],
    // Tuned for Wateree River below the dam — typical baseflow ~500 cfs,
    // generation spikes to 5000-9000 cfs.
    kayakThresholds: {
      cfsCalm: 800, cfsNormal: 2500, cfsPushy: 5000, cfsDanger: 8000,
      gageRiseDangerFtPerHr: 1.0,  // dam-release surge cutoff
      coldTempStressF: 55,
    },
    notes: 'Wateree Dam generation typically pulses afternoons/evenings. ' +
           'A sudden rise of 2+ ft in <1 hour means generation just started — ' +
           'be off the water or well off the channel BEFORE this happens.',
  },

  congaree: {
    label: 'Congaree River (Columbia, SC)',
    operator: 'Confluence of Saluda (Dominion) + Broad (SCE&G)',
    damName: 'Lake Murray Dam (via Saluda) + Parr Shoals (via Broad)',
    gauges: [
      { site: '02169500', name: 'Congaree River at Columbia, SC', primary: true,
        lat: 33.9971, lon: -81.0470 },
      { site: '02169672', name: 'Columbia Canal at Columbia, SC',
        lat: 33.9837, lon: -81.0353 },
    ],
    kayakThresholds: {
      cfsCalm: 2000, cfsNormal: 6000, cfsPushy: 12000, cfsDanger: 20000,
      gageRiseDangerFtPerHr: 0.8,
      coldTempStressF: 55,
    },
    notes: 'Receives both Saluda (cold, dam-fed) and Broad (warm). ' +
           'Both Lake Murray and Parr Shoals can pulse independently.',
  },

  saluda: {
    label: 'Lower Saluda River (below Lake Murray Dam)',
    operator: 'Dominion Energy',
    damName: 'Lake Murray (Saluda Hydroelectric)',
    damLakeKey: 'murray',
    dominionSaluda: true,    // → scrape dominionenergy.com for color-coded flow status
    gauges: [
      { site: '02168504', name: 'Saluda River below Lake Murray Dam', primary: true,
        lat: 34.0539, lon: -81.2559 },
      { site: '02169000', name: 'Saluda River near Columbia, SC',
        lat: 33.9913, lon: -81.1031 },
    ],
    // Cold tailwater — coming off the bottom of Lake Murray. Often 52-58°F
    // even in summer. Class II-III rapids when generating.
    kayakThresholds: {
      cfsCalm: 700, cfsNormal: 2500, cfsPushy: 5500, cfsDanger: 9000,
      gageRiseDangerFtPerHr: 1.5,
      coldTempStressF: 60,  // higher cutoff — this river is cold even in summer
    },
    notes: 'COLD TAILWATER. Water is typically 50-58°F year-round (from bottom of ' +
           'Lake Murray). Hypothermia is a serious capsize risk even in July. ' +
           'Dominion generation pulses can raise flow from 700 → 7000 cfs in 30 min. ' +
           'Famous trout fishery for the same reason it\'s dangerous.',
  },

  broad: {
    label: 'Broad River (above Columbia, SC)',
    operator: 'SCE&G / Dominion (Parr Shoals)',
    damName: 'Parr Shoals Dam',
    dukeBasinId: 10,          // → BroadRiver basin in Duke API (basin 10)
    gauges: [
      { site: '02161000', name: 'Broad River near Carlisle, SC', primary: true,
        lat: 34.5878, lon: -81.4214 },
      { site: '02156500', name: 'Broad River near Gaffney, SC',
        lat: 35.0001, lon: -81.6131 },
      { site: '02160991', name: 'Broad River at Alston, SC',
        lat: 34.2737, lon: -81.2754 },
    ],
    kayakThresholds: {
      cfsCalm: 800, cfsNormal: 3000, cfsPushy: 7000, cfsDanger: 12000,
      gageRiseDangerFtPerHr: 1.2,
      coldTempStressF: 55,
    },
    notes: 'Less dam-controlled than Saluda. Major flood risk after heavy rain ' +
           'in the upstream piedmont.',
  },

  santee: {
    label: 'Santee River (below Lake Marion)',
    operator: 'Santee Cooper / USACE',
    damName: 'Wilson Dam (Lake Marion) + Santee Rediversion Canal',
    damLakeKey: 'marion',
    gauges: [
      { site: '02171645', name: 'Santee River near Pineville, SC (Fort Church)', primary: true,
        lat: 33.4196, lon: -80.0142 },
    ],
    kayakThresholds: {
      cfsCalm: 1500, cfsNormal: 5000, cfsPushy: 15000, cfsDanger: 25000,
      gageRiseDangerFtPerHr: 1.0,
      coldTempStressF: 55,
    },
    notes: 'Tidal influence in lower reaches. The Rediversion Canal returns flow ' +
           'to the Santee from the Cooper system — flow direction can reverse.',
  },

  cooper: {
    label: 'Cooper River (Pinopolis tailrace to Charleston Harbor)',
    operator: 'Santee Cooper',
    damName: 'Pinopolis Dam (Lake Moultrie)',
    damLakeKey: 'moultrie',
    gauges: [
      { site: '02172040', name: 'Cooper River at Mobay near Goose Creek, SC', primary: true,
        lat: 33.0429, lon: -79.9587 },
      { site: '02172053', name: 'Cooper River at Filbin Creek (tidal)',
        lat: 32.8807, lon: -79.9740 },
    ],
    kayakThresholds: {
      cfsCalm: 500, cfsNormal: 2500, cfsPushy: 6000, cfsDanger: 12000,
      gageRiseDangerFtPerHr: 2.0,  // tidal — gauge swings a lot naturally
      coldTempStressF: 50,
    },
    notes: 'TIDAL throughout most fishable sections. Gauge height swings ~5 ft ' +
           'with the tide regardless of dam. Pinopolis lock is operated 4x/day ' +
           'for boat passage. Salinity gradient — saltwater intrusion past the ' +
           'Tee Creek area on incoming tides.',
  },
};

/* Compute river safety assessment from a fresh USGS sample.
   Returns { status: 'go'|'caution'|'no-go', reasons: [...], metrics: {...} }
   Specifically calibrated for KAYAK / CANOE — bass boats can tolerate higher
   flows but are also more vulnerable to dam-surge wakes. */
function assessKayakSafety(riverKey, gaugeData, thresholds) {
  const t = thresholds;
  const reasons = [];
  const metrics = {};
  let level = 'go';   // go → caution → no-go (only escalates, never descends)
  const escalate = (newLevel) => {
    const order = { 'go':0, 'caution':1, 'no-go':2 };
    if (order[newLevel] > order[level]) level = newLevel;
  };

  // 1. Streamflow check
  const cfs = gaugeData.streamflow;
  if (cfs != null) {
    metrics.streamflow_cfs = cfs;
    if (cfs >= t.cfsDanger) {
      escalate('no-go');
      reasons.push(`Streamflow ${cfs} cfs is in the DANGER zone (>${t.cfsDanger} for kayak/canoe). Strong current, swimming hazardous.`);
    } else if (cfs >= t.cfsPushy) {
      escalate('caution');
      reasons.push(`Streamflow ${cfs} cfs is PUSHY for kayaks (>${t.cfsPushy}). Experienced paddlers only.`);
    } else if (cfs >= t.cfsNormal) {
      reasons.push(`Streamflow ${cfs} cfs is normal-to-high — paddleable with care.`);
    } else if (cfs >= t.cfsCalm) {
      reasons.push(`Streamflow ${cfs} cfs is in the comfortable kayaking range.`);
    } else {
      reasons.push(`Streamflow ${cfs} cfs is LOW — expect skinny water and possible portaging over shoals.`);
    }
  }

  // 2. Rate of rise (dam surge / flash flood)
  if (gaugeData.rateOfRiseFtPerHr != null) {
    metrics.rate_of_rise_ft_per_hr = Math.round(gaugeData.rateOfRiseFtPerHr * 100) / 100;
    if (gaugeData.rateOfRiseFtPerHr >= t.gageRiseDangerFtPerHr) {
      escalate('no-go');
      reasons.push(`⚠ RAPID RISE: gauge is rising at ${metrics.rate_of_rise_ft_per_hr} ft/hr — likely dam generation surge or flash flood. Get off the river.`);
    } else if (gaugeData.rateOfRiseFtPerHr >= t.gageRiseDangerFtPerHr * 0.5) {
      escalate('caution');
      reasons.push(`Gauge rising at ${metrics.rate_of_rise_ft_per_hr} ft/hr — possible dam release starting. Monitor closely.`);
    }
  }

  // 3. Water temperature — hypothermia risk in a capsize
  if (gaugeData.tempC != null) {
    const tempF = Math.round(gaugeData.tempC * 9/5 + 32);
    metrics.water_temp_F = tempF;
    if (tempF < t.coldTempStressF) {
      escalate('caution');
      reasons.push(`Water temp ${tempF}°F — COLD-WATER capsize risk. Wear PFD + appropriate thermal protection (drysuit/wetsuit recommended below ${t.coldTempStressF}°F).`);
    }
  }

  // 4. Default-go message if no issues
  if (!reasons.length) reasons.push('Conditions appear normal — paddleable.');

  return { status: level, reasons, metrics };
}

/* ---- Per-location surge math ----
   Given a user lat/lon and a river config, find:
     - approximate river-mile from dam (snap user to nearest centerline segment)
     - distance downstream from the dam in river miles
     - estimated time-of-surge-arrival at user location for the next release
     - severity attenuation factor (0..1) at user location  */
function snapToRiver(centerline, userLat, userLon) {
  // Find the centerline waypoint closest to the user (straight-line miles)
  let best = null;
  for (const wp of centerline) {
    const d = Math.hypot((wp.lat - userLat) * 69, (wp.lon - userLon) * 55);
    if (!best || d < best.dist) best = { dist: d, wp };
  }
  return best;  // { dist (mi from user to that waypoint), wp }
}

/* Linear interpolation between a sorted list of (mi, sev) knots */
function interpolateSeverity(att, mi) {
  if (!att) return 1.0;
  if (att.type === 'piecewise' && Array.isArray(att.knots) && att.knots.length >= 2) {
    const ks = att.knots;
    if (mi <= ks[0].mi) return ks[0].sev;
    if (mi >= ks[ks.length-1].mi) return ks[ks.length-1].sev;
    for (let i = 0; i < ks.length-1; i++) {
      const a = ks[i], b = ks[i+1];
      if (mi >= a.mi && mi <= b.mi) {
        const t = (mi - a.mi) / Math.max(0.001, (b.mi - a.mi));
        return a.sev + t * (b.sev - a.sev);
      }
    }
  }
  // Legacy linear fallback
  const t = Math.max(0, Math.min(1, (mi - (att.fullSeverityMi||0)) / Math.max(1, (att.dispersedMi||70) - (att.fullSeverityMi||0))));
  return Math.max(att.minFactor || 0.2, 1 - t * (1 - (att.minFactor || 0.2)));
}

function estimateSurgeAt(river, userLat, userLon) {
  if (!river.centerline || userLat == null || userLon == null) return null;
  const snap = snapToRiver(river.centerline, userLat, userLon);
  if (!snap || snap.dist > 10) return null;  // user is too far from this river

  const userRiverMi = snap.wp.mi;
  const minutesFromDam = (userRiverMi / river.surgeSpeed_mph) * 60;
  const severity = interpolateSeverity(river.surgeAttenuation, userRiverMi);

  return {
    nearestWaypoint: snap.wp.name,
    distance_to_waypoint_mi: Math.round(snap.dist * 10) / 10,
    river_mile_from_dam: Math.round(userRiverMi * 10) / 10,
    river_miles_remaining_to_confluence: Math.round((river.riverLength_mi - userRiverMi) * 10) / 10,
    minutes_from_generation_start: Math.round(minutesFromDam),
    surge_speed_mph: river.surgeSpeed_mph,
    surge_severity_factor: Math.round(severity * 100) / 100,
    surge_severity_label: severity > 0.75 ? 'full' : severity > 0.5 ? 'moderate' : severity > 0.3 ? 'reduced' : 'minor',
  };
}

async function getRiver(key, opts={}) {
  const cfg = RIVERS[key];
  if (!cfg) return { error: `unknown river: ${key}` };

  const out = {
    river: cfg.label,
    operator: cfg.operator,
    dam: cfg.damName,
    notes: cfg.notes,
    gauges: [],
    timestamp: new Date().toISOString(),
  };

  // Fetch all gauges; for the primary one also compute rate-of-rise
  for (const g of cfg.gauges) {
    const data = await fetchUsgs(g.site, '00010,00060,00065,63160', /*periodDays*/ 2);
    const rec = {
      site: g.site, name: g.name, lat: g.lat, lon: g.lon, primary: !!g.primary,
      streamflow_cfs: data.streamflow ?? null,
      gage_height_ft: data.gageHeight ?? null,
      water_elevation_ft_navd88: data.elevationNavd88 ?? null,
      water_temperature_F: data.tempC != null ? Math.round(data.tempC*9/5 + 32) : null,
      water_temperature_C: data.tempC ?? null,
      timestamp: data.timestamp ?? null,
    };
    if (g.primary) {
      // Compute rate-of-rise from the LAST HOUR of data — needs raw RDB
      const rate = await computeGageRateOfRise(g.site);
      if (rate != null) rec.rate_of_rise_ft_per_hr = Math.round(rate * 100)/100;
    }
    out.gauges.push(rec);
  }

  // Cross-link to upstream lake pool elevation
  if (cfg.damLakeKey && LAKES[cfg.damLakeKey]) {
    try {
      const lakeData = await resolveLake(cfg.damLakeKey);
      out.upstream_lake = {
        name: cfg.damLakeKey,
        elevation_ft: lakeData.elevation_ft,
        percent_full: lakeData.percent_full,
        full_pool_ft: lakeData.full_pool_ft,
        special_message: lakeData.special_message,
      };
    } catch (_) {}
  }

  // Duke scheduled flow arrivals (gold standard for Wateree, Broad, etc.)
  if (cfg.dukeBasinId) {
    const sched = await fetchDukeFlowArrivals(cfg.dukeBasinId);
    if (sched && sched.arrivals.length) {
      out.dam_schedule = {
        type: 'duke_flow_arrivals',
        operator: 'Duke Energy',
        basinName: sched.basinName,
        lastUpdated: sched.lastUpdated,
        next: sched.arrivals[0],
        upcoming: sched.arrivals.slice(0, 6),
        source: sched.source,
      };

      // If we know Duke's anchor mile + arrival time, we can back-compute the
      // generation-start time and then project the surge to any other mile.
      // Anchor arrival = generation_start + (dukeAnchorRiverMi / surgeSpeed)
      if (cfg.dukeAnchorRiverMi != null && sched.arrivals[0].arrivalEpoch) {
        const anchorTravelMs = (cfg.dukeAnchorRiverMi / cfg.surgeSpeed_mph) * 3600 * 1000;
        out.dam_schedule.generationStartEpoch = sched.arrivals[0].arrivalEpoch - anchorTravelMs;
      }
    }
  }

  // Dominion color-coded current/planned status (Lower Saluda)
  if (cfg.dominionSaluda) {
    const dom = await fetchDominionSaludaStatus();
    if (dom) {
      out.dam_schedule = {
        type: 'dominion_color_status',
        operator: 'Dominion Energy',
        currentColor:   dom.currentColor,
        plannedColor:   dom.plannedColor,
        currentRange:   dom.currentRange,
        plannedRange:   dom.plannedRange,
        currentCfsBand: dom.currentCfsBand,
        plannedCfsBand: dom.plannedCfsBand,
        colorLegend:    dom.colorLegend,
        source:         dom.source,
      };
    }
  }

  // If the caller passed user coordinates, compute their location-specific surge ETA
  if (opts.userLat != null && opts.userLon != null) {
    const loc = estimateSurgeAt(cfg, opts.userLat, opts.userLon);
    if (loc) {
      out.user_location = {
        lat: opts.userLat, lon: opts.userLon,
        ...loc,
      };
      // Project the next release to the user's mile
      if (out.dam_schedule?.generationStartEpoch != null) {
        const surgeAtUserEpoch = out.dam_schedule.generationStartEpoch + loc.minutes_from_generation_start * 60 * 1000;
        out.user_location.surge_arrival_epoch = surgeAtUserEpoch;
        out.user_location.surge_arrival_iso = new Date(surgeAtUserEpoch).toISOString();
        out.user_location.minutes_until_surge_at_user = Math.round((surgeAtUserEpoch - Date.now()) / 60000);
      }
    }
  }

  // Compute safety assessment for the primary gauge
  const primary = out.gauges.find(g => g.primary) || out.gauges[0];
  if (primary) {
    const assessment = assessKayakSafety(key, {
      streamflow: primary.streamflow_cfs,
      tempC: primary.water_temperature_C,
      rateOfRiseFtPerHr: primary.rate_of_rise_ft_per_hr,
    }, cfg.kayakThresholds);

    // Escalate based on scheduled dam release.
    // Prefer USER-LOCATION-SPECIFIC arrival time + severity if we have it.
    if (out.user_location?.minutes_until_surge_at_user != null) {
      const m = out.user_location.minutes_until_surge_at_user;
      const sev = out.user_location.surge_severity_factor;
      const sevLabel = out.user_location.surge_severity_label;
      const arrTime = new Date(out.user_location.surge_arrival_epoch).toLocaleTimeString('en-US', { timeZone: 'America/New_York' });
      const riverMi = out.user_location.river_mile_from_dam;

      // Thresholds scaled by severity — at full severity (near dam) the standard
      // 2h/6h windows apply. Farther downstream, the surge is less dramatic so we
      // can tolerate being on the water longer (but never ignore it entirely).
      const imminentMin = 120 / Math.max(0.5, sev);   // e.g., sev=0.5 → 240 min imminence
      const headsUpMin  = 360 / Math.max(0.5, sev);

      if (m > 0 && m < imminentMin && sev >= 0.5) {
        // Strong surge arriving soon at user's location
        const order = { 'go':0, 'caution':1, 'no-go':2 };
        if (order[assessment.status] < 2) assessment.status = 'no-go';
        assessment.reasons.unshift(
          `🛑 ${sevLabel.toUpperCase()} dam surge arrives at YOUR LOCATION ` +
          `(river mile ${riverMi}) in ${m} min (~${arrTime} ET). Get off the water now.`
        );
      } else if (m > 0 && m < headsUpMin) {
        if (assessment.status === 'go') assessment.status = 'caution';
        const hrs = Math.round(m / 60 * 10) / 10;
        assessment.reasons.unshift(
          `⚠ ${sevLabel.toUpperCase()} dam surge expected at YOUR LOCATION ` +
          `(river mile ${riverMi}, ~${out.user_location.river_miles_remaining_to_confluence} mi above confluence) ` +
          `at ~${arrTime} ET (in ${hrs}h). Plan to be off the water by then.`
        );
      } else if (m > 0) {
        // Far enough out that it's informational only
        const hrs = Math.round(m / 60 * 10) / 10;
        assessment.reasons.push(
          `ℹ Next dam surge reaches your location (mile ${riverMi}) in ~${hrs}h ` +
          `(${sevLabel} severity at this distance — surge weakens with distance from dam).`
        );
      }
    } else if (out.dam_schedule?.type === 'duke_flow_arrivals' && out.dam_schedule.next) {
      // No user location — fall back to the per-mile-marker logic
      const next = out.dam_schedule.next;
      const minutesUntil = (next.arrivalEpoch - Date.now()) / 60000;
      if (minutesUntil > 0 && minutesUntil < 120) {
        const order = { 'go':0, 'caution':1, 'no-go':2 };
        if (order[assessment.status] < 2) assessment.status = 'no-go';
        assessment.reasons.unshift(
          `🛑 SCHEDULED DAM RELEASE arrives at ${next.mileMarkerName} in ` +
          `${Math.round(minutesUntil)} min (~${new Date(next.arrivalEpoch).toLocaleTimeString('en-US',{timeZone:'America/New_York'})} ET). ` +
          `Severity decreases with distance from dam — pass your coordinates with ` +
          `?lat=X&lon=Y for a location-specific estimate.`
        );
      } else if (minutesUntil > 0 && minutesUntil < 360) {
        if (assessment.status === 'go') assessment.status = 'caution';
        assessment.reasons.unshift(
          `⚠ Dam release scheduled to arrive at ${next.mileMarkerName} at ` +
          `~${new Date(next.arrivalEpoch).toLocaleTimeString('en-US',{timeZone:'America/New_York'})} ET ` +
          `(in ${Math.round(minutesUntil/60*10)/10}h). For location-specific timing, ` +
          `pass your coordinates with ?lat=X&lon=Y.`
        );
      }
    }

    // Dominion color-status escalation
    if (out.dam_schedule?.type === 'dominion_color_status') {
      const cur = out.dam_schedule.currentColor;
      if (cur === 'red') {
        assessment.status = 'no-go';
        assessment.reasons.unshift('🛑 Dominion reports current flow in RED RANGE — class IV-V whitewater, dangerous even for experts.');
      } else if (cur === 'yellow') {
        if (assessment.status === 'go') assessment.status = 'caution';
        assessment.reasons.unshift('⚠ Dominion reports current flow in YELLOW RANGE — experienced paddlers only.');
      } else if (cur === 'blue') {
        assessment.reasons.push('Dominion reports current flow in BLUE RANGE (normal/safe paddling).');
      }
      // Planned color heads-up
      const plan = out.dam_schedule.plannedColor;
      if (plan && plan !== cur) {
        if (plan === 'red' || plan === 'yellow') {
          if (assessment.status === 'go') assessment.status = 'caution';
          assessment.reasons.push(`⚠ Dominion forecasts flow rising to ${plan.toUpperCase()} range — be ready to exit.`);
        }
      }
    }

    out.kayak_assessment = assessment;
  }

  return out;
}

/* Compute the gauge-height rate-of-rise over the last hour, in feet per hour.
   Uses USGS RDB format directly because we need raw timeseries (not just latest). */
async function computeGageRateOfRise(site) {
  try {
    const url = `https://waterservices.usgs.gov/nwis/iv/?sites=${site}&parameterCd=00065&format=rdb&period=PT3H`;
    const r = await fetch(url, { cf:{ cacheTtl:120 } });
    if (!r.ok) return null;
    const text = await r.text();
    const lines = text.split('\n').filter(l => l && !l.startsWith('#'));
    if (lines.length < 4) return null;
    const header = lines[0].split('\t');
    // Find the 00065 column
    let col = -1;
    for (let i = 4; i < header.length; i++) {
      if (header[i] && !header[i].endsWith('_cd') && header[i].includes('00065')) { col = i; break; }
    }
    if (col < 0) return null;

    const dataLines = lines.slice(2).filter(l => l.startsWith('USGS'));
    if (dataLines.length < 4) return null;

    // Take first and last records ~1h apart for slope
    const samples = dataLines.map(l => {
      const p = l.split('\t');
      const v = parseFloat(p[col]);
      // Parse date "YYYY-MM-DD HH:MM"
      const [date, time] = p[2].split(' ');
      const ts = new Date(`${date}T${time}:00`).getTime();
      return { ts, v };
    }).filter(s => isFinite(s.v) && isFinite(s.ts));

    if (samples.length < 2) return null;
    const latest = samples[samples.length-1];
    // Find the sample closest to 1 hour earlier
    const targetTs = latest.ts - 60*60*1000;
    let closest = samples[0];
    let bestDiff = Math.abs(samples[0].ts - targetTs);
    for (const s of samples) {
      const d = Math.abs(s.ts - targetTs);
      if (d < bestDiff) { closest = s; bestDiff = d; }
    }
    const dtHr = (latest.ts - closest.ts) / 3600000;
    if (dtHr <= 0) return null;
    return (latest.v - closest.v) / dtHr;
  } catch (_) {
    return null;
  }
}
/* ───────── DAM RELEASE SCHEDULES ─────────
   Three different sources, three different shapes:

   1. Duke Energy (Wateree, Catawba lakes, Yadkin, etc.)
      → JSON API at api.hydro-derived.duke-energy.app
      → /rivers/flow-arrivals/{basinId} returns SCHEDULED dam generation
        arrival times at named mile-markers downstream, with predicted
        recession times. This is the gold standard — actual planned schedule.
      Basin IDs: 1=Catawba (Wateree), 2=Nantahala, 3=Yadkin, 10=Broad,
                 11=Pigeon, 6=Keowee-Toxaway

   2. Dominion Energy (Lake Murray → Lower Saluda)
      → HTML scrape of the Lower Saluda page. They publish a color-coded
        flow status ("currently in the blue range") + planned status.
      → Color → CFS mapping derived from gopaddlesc.com + Discover SC:
          blue:   ~350-2000 cfs   (low, safe paddling)
          yellow: ~2000-8000 cfs  (high — experienced paddlers only)
          red:    >8000 cfs       (dangerous, class IV-V at Millrace)
          green:  <350 cfs        (very low, minimum 700 for safe paddling)

   3. Santee Cooper (Lake Marion, Moultrie, Cooper R, Santee R)
      → No public real-time generation API. Their lake-data page just links
        to authoritative USGS gauges, which we already query directly.
      Per their site: Marion pool=USGS 02169921, Marion temp=USGS 02171000,
                      Moultrie pool=USGS 02172000.
*/

const DUKE_API_BASE = 'https://api.hydro-derived.duke-energy.app';

async function fetchDukeFlowArrivals(basinId) {
  try {
    const r = await fetch(`${DUKE_API_BASE}/rivers/flow-arrivals/${basinId}`, {
      cf: { cacheTtl: 300, cacheEverything: true },
      headers: {
        'User-Agent': 'TrollMap/12 Worker',
        'Origin':  'https://lakes.hydro-derived.duke-energy.app',
        'Referer': 'https://lakes.hydro-derived.duke-energy.app/',
      },
    });
    if (!r.ok) return null;
    const j = await r.json();
    const out = [];
    const now = Date.now();
    for (const dam of (j?.Dams || [])) {
      for (const ev of (dam?.FlowArrivalRecessions || [])) {
        const arr = ev.Arrival ? new Date(ev.Arrival + (ev.Arrival.endsWith('Z') ? '' : '-04:00')) : null;
        const rec = ev.Recedes ? new Date(ev.Recedes + (ev.Recedes.endsWith('Z') ? '' : '-04:00')) : null;
        if (!arr || arr.getTime() < now - 12*3600*1000) continue;
        out.push({
          damName: ev.DamName,
          mileMarkerName: ev.MileMarkerName,
          arrival: ev.Arrival,
          recedes: ev.Recedes,
          arrivalEpoch: arr ? arr.getTime() : null,
          recedesEpoch: rec ? rec.getTime() : null,
        });
      }
    }
    out.sort((a,b) => (a.arrivalEpoch||0) - (b.arrivalEpoch||0));
    return {
      basinName:   j.RiverBasinName,
      basinId:     j.RiverBasinId,
      lastUpdated: j.LastUpdated,
      arrivals:    out,
      source:      `${DUKE_API_BASE}/rivers/flow-arrivals/${basinId}`,
    };
  } catch (e) { return null; }
}

async function fetchDominionSaludaStatus() {
  const COLOR_RANGES = {
    green:  { min: 0,    max: 350,   label: 'GREEN — very low, scraping likely' },
    blue:   { min: 350,  max: 2000,  label: 'BLUE — normal/safe paddling range' },
    yellow: { min: 2000, max: 8000,  label: 'YELLOW — high flow, experienced paddlers only' },
    red:    { min: 8000, max: 20000, label: 'RED — DANGEROUS, class IV-V whitewater, do not enter' },
  };
  try {
    const r = await fetch('https://www.dominionenergy.com/about/lakes-and-recreation/lower-saluda-river-sc', {
      cf: { cacheTtl: 600, cacheEverything: true },
      headers: { 'User-Agent': 'TrollMap/12 Worker', 'Accept': 'text/html' },
    });
    if (!r.ok) return null;
    const html = await r.text();
    const cur  = html.match(/currently in the[^<]{0,40}<span[^>]*>\s*(blue|yellow|red|green)/i);
    const plan = html.match(/expected to be in the[^<]{0,40}<span[^>]*>\s*(blue|yellow|red|green)/i);
    const currentColor = cur  ? cur[1].toLowerCase()  : null;
    const plannedColor = plan ? plan[1].toLowerCase() : null;
    return {
      currentColor,
      plannedColor,
      currentRange:   currentColor ? COLOR_RANGES[currentColor]?.label : null,
      plannedRange:   plannedColor ? COLOR_RANGES[plannedColor]?.label : null,
      currentCfsBand: currentColor ? COLOR_RANGES[currentColor] : null,
      plannedCfsBand: plannedColor ? COLOR_RANGES[plannedColor] : null,
      source: 'https://www.dominionenergy.com/about/lakes-and-recreation/lower-saluda-river-sc',
      colorLegend: COLOR_RANGES,
    };
  } catch (e) { return null; }
}

async function resolveLake(lakeName) {
  const key = Object.keys(LAKES).find(k => lakeName.toLowerCase().includes(k));
  if (!key) return { error: `unknown lake: ${lakeName}` };
  const cfg = LAKES[key];
  const out = {
    waterbody: key,
    elevation_ft: null,
    water_temperature_F: null,
    sources: [],
    timestamp: new Date().toISOString(),
  };

  // 1. Pool elevation
  //    Order: USGS reservoir gauge > Duke dashboard > Santee Cooper > USACE > normalPool
  if (cfg.pool) {
    const u = await fetchUsgs(cfg.pool, '00010,00062,62614,62615,00065');
    if (u?.elevation != null) {
      out.elevation_ft = round2(u.elevation);
      out.sources.push(`USGS ${cfg.pool} (reservoir elevation)`);
    } else if (u?.gageHeight != null && !cfg.river) {
      // fallback for sites that only report 00065 but are at the dam pool
      out.elevation_ft = round2(u.gageHeight);
      out.sources.push(`USGS ${cfg.pool} (gage height — verify against published pool)`);
    }
    if (u?.tempC != null) {
      out.water_temperature_F = Math.round(u.tempC*9/5 + 32);
      out.sources.push(`USGS ${cfg.pool} (temp)`);
    }
  }

  if (out.elevation_ft == null && cfg.duke) {
    const lake = await getDukeLake(cfg.duke);
    if (lake) {
      if (lake.ft != null)  out.elevation_ft = lake.ft;
      if (lake.pct != null) out.percent_full = lake.pct;
      out.full_pool_ft = lake.fullPool;
      out.display_level = lake.pct;
      out.display_unit = '% full pond';
      out.display_full_pool = 100.0;
      if (isFinite(lake.target)) out.target = lake.target;
      out.sources.push('Duke API /lakes/current-level');
      if (lake.specialMessage) out.special_message = lake.specialMessage;
    }
  }

  if (out.elevation_ft == null && cfg.sepa) {
    if (cfg.sepa === 'marion' || cfg.sepa === 'moultrie') {
      const sc = await fetchSanteeCooper();
      if (sc?.[cfg.sepa] != null) {
        out.elevation_ft = sc[cfg.sepa];
        out.sources.push('Santee Cooper');
      }
    } else {
      const us = await fetchUsaceSavannah(cfg.sepa);
      if (us?.elevation != null) { out.elevation_ft = us.elevation; out.sources.push('USACE'); }
    }
  }

  // 2. Water temperature
  //    Order: USGS site (with RDB fallback), then Angler's Headquarters scrape as last resort
  if (out.water_temperature_F == null && cfg.river) {
    const u = await fetchUsgs(cfg.river, '00010,00065,00060,63160');
    if (u?.tempC != null) {
      out.water_temperature_F = Math.round(u.tempC*9/5 + 32);
      out.sources.push(`USGS ${cfg.river} (water temp)`);
    }
    // While we're here, expose river-stage data too — useful tactical info even though
    // it's not the lake pool elevation
    if (u?.gageHeight != null) out.river_gage_height_ft = u.gageHeight;
    if (u?.streamflow != null) out.river_streamflow_cfs = u.streamflow;
    if (u?.elevationNavd88 != null) out.river_water_elevation_ft_navd88 = u.elevationNavd88;
    if (u?.timestamp) out.usgs_timestamp = u.timestamp;
  }
  if (out.water_temperature_F == null && cfg.ahq) {
    const a = await fetchAhqWaterTemp(cfg.ahq);
    if (a?.tempF != null) {
      out.water_temperature_F = a.tempF;
      out.water_temperature_source = `Angler's Headquarters report${a.approx ? ' (estimated from range)' : ''}: "${a.raw}"`;
      if (a.range) out.water_temperature_range_F = a.range;
      out.sources.push(`Angler's Headquarters (${cfg.ahq})`);
    }
  }

  // 3. Last-resort published normal pool
  if (out.elevation_ft == null && cfg.normalPool) {
    out.elevation_ft = cfg.normalPool;
    out.sources.push('published normal pool (fallback)');
  }

  if (out.full_pool_ft == null && cfg.normalPool) out.full_pool_ft = cfg.normalPool;
  if (out.display_level == null && out.elevation_ft != null) {
    out.display_level = out.elevation_ft;
    out.display_unit = 'ft';
    out.display_full_pool = cfg.normalPool || out.full_pool_ft || null;
  }
  out.status = out.elevation_ft != null ? 'success' : 'no_data';
  return out;
}

function round2(n){ return Math.round(n*100)/100; }

/* ───────── main fetch handler ───────── */

// ═══════════════════════════════════════════════════════════════════
// D1 SYNC ROUTES
// ═══════════════════════════════════════════════════════════════════

const SYNC_STORES = ['plan', 'spread', 'catch', 'chart', 'layer'];

async function ensureSyncSchema(db) {
  try {
    await db.exec("CREATE TABLE IF NOT EXISTS sync_items (id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, lastModified TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (type, id))");
  } catch (e) {
    if (!String(e).includes('already exists') && !String(e).includes('SQLITE_ERROR')) throw e;
  }
  try {
    await db.exec("CREATE INDEX IF NOT EXISTS idx_sync_modified ON sync_items(lastModified)");
  } catch (e) {
    if (!String(e).includes('already exists') && !String(e).includes('SQLITE_ERROR')) throw e;
  }
}

async function handleSyncPush(request, env, type, id) {
  if (!SYNC_STORES.includes(type)) {
    return new Response(JSON.stringify({ error: `unknown type: ${type}` }), { headers: JSON_HEADERS, status: 400 });
  }
  const body = await request.json();
  const { lastModified = new Date().toISOString(), deleted = false, ...data } = body;
  await ensureSyncSchema(env.DB);
  await env.DB.prepare(
    `INSERT INTO sync_items (id, type, payload, lastModified, deleted)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(type, id) DO UPDATE SET
       payload=excluded.payload,
       lastModified=excluded.lastModified,
       deleted=excluded.deleted`
  ).bind(id, type, JSON.stringify(data), lastModified, deleted ? 1 : 0).run();
  return new Response(JSON.stringify({ ok: true, type, id, lastModified }), { headers: JSON_HEADERS });
}

async function handleSyncListUpdates(url, env) {
  await ensureSyncSchema(env.DB);
  const since = url.searchParams.get('since');
  let rows;
  if (since) {
    rows = await env.DB.prepare(
      `SELECT type, id, lastModified, deleted FROM sync_items WHERE lastModified > ?1 ORDER BY lastModified ASC LIMIT 500`
    ).bind(since).all();
  } else {
    rows = await env.DB.prepare(
      `SELECT type, id, lastModified, deleted FROM sync_items ORDER BY lastModified ASC LIMIT 500`
    ).all();
  }
  const items = (rows.results || []).map(r => ({
    key: `${r.type}/${r.id}`,
    lastModified: r.lastModified,
    deleted: r.deleted === 1,
  }));
  return new Response(JSON.stringify({ items, count: items.length }), { headers: JSON_HEADERS });
}

async function handleSyncGet(env, type, id) {
  await ensureSyncSchema(env.DB);
  const row = await env.DB.prepare(
    `SELECT payload, lastModified, deleted FROM sync_items WHERE type=?1 AND id=?2`
  ).bind(type, id).first();
  if (!row) return new Response(JSON.stringify({ error: 'not found' }), { headers: JSON_HEADERS, status: 404 });
  const data = JSON.parse(row.payload);
  return new Response(JSON.stringify({
    ...data,
    lastModified: row.lastModified,
    deleted: row.deleted === 1,
  }), { headers: JSON_HEADERS });
}

async function handleSyncDelete(env, type, id) {
  await ensureSyncSchema(env.DB);
  await env.DB.prepare(
    `INSERT INTO sync_items (id, type, payload, lastModified, deleted)
     VALUES (?1, ?2, '{}', ?3, 1)
     ON CONFLICT(type, id) DO UPDATE SET deleted=1, lastModified=excluded.lastModified`
  ).bind(id, type, new Date().toISOString()).run();
  return new Response(JSON.stringify({ ok: true, tombstoned: `${type}/${id}` }), { headers: JSON_HEADERS });
}

async function handleSyncMigrate(request, env) {
  await ensureSyncSchema(env.DB);
  const body = await request.json();
  const items = body.items || [];
  let count = 0;
  const errors = [];
  for (const item of items) {
    try {
      const { type, id, lastModified = new Date().toISOString(), ...data } = item;
      if (!SYNC_STORES.includes(type) || !id) continue;
      await env.DB.prepare(
        `INSERT INTO sync_items (id, type, payload, lastModified, deleted)
         VALUES (?1, ?2, ?3, ?4, 0)
         ON CONFLICT(type, id) DO UPDATE SET
           payload=excluded.payload,
           lastModified=excluded.lastModified,
           deleted=0`
      ).bind(String(id), type, JSON.stringify(data), lastModified).run();
      count++;
    } catch (e) {
      errors.push({ item, error: e.message });
    }
  }
  return new Response(JSON.stringify({ ok: true, imported: count, errors }), { headers: JSON_HEADERS });
}

// ═══════════════════════════════════════════════════════════════════
// VECTORIZED CONTOUR ROUTES (GeoJSON stored in R2)
// ═══════════════════════════════════════════════════════════════════

function contourGeojsonKey(lake) {
  return `${lake.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}/vectors/contours.geojson`;
}

async function handleContourGeojsonGet(env, lake) {
  const key = contourGeojsonKey(lake);
  const obj = await env.R2_TROLLMAP_CHARTPACKS.get(key);
  if (!obj) return new Response(JSON.stringify({ error: 'no vectorized contours for this lake yet' }), { headers: JSON_HEADERS, status: 404 });
  return new Response(obj.body, { headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

async function handleContourGeojsonPut(request, env, lake) {
  const body = await request.arrayBuffer();
  if (!body || body.byteLength === 0) {
    return new Response(JSON.stringify({ error: 'empty body' }), { headers: JSON_HEADERS, status: 400 });
  }
  const key = contourGeojsonKey(lake);
  await env.R2_TROLLMAP_CHARTPACKS.put(key, body, {
    httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
  });
  return new Response(JSON.stringify({ ok: true, key, bytes: body.byteLength }), { headers: JSON_HEADERS });
}


export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/,'') || '/';
    const lake = (url.searchParams.get('lake') || '').toLowerCase();

    try {
      // --- /duke route: serve the live Duke /lakes/current-level data ---
      // Default: returns synthesised plain text the existing front-end scraper understands.
      // Pass ?format=json to get the raw upstream JSON array.
      if (path === '/duke' || url.searchParams.has('duke')) {
        const format = (url.searchParams.get('format') || 'text').toLowerCase();
        const d = await fetchDukeDashboard(url.searchParams.get('basin') || '1');
        if (!d) {
          return new Response(JSON.stringify({ error: 'Duke API unreachable' }), { headers: JSON_HEADERS, status: 502 });
        }
        if (format === 'json') {
          return new Response(JSON.stringify(d.json, null, 2), { headers: { ...JSON_HEADERS, 'X-Source': d.url } });
        }
        return new Response(d.text, { headers: { ...TEXT_HEADERS, 'X-Source': d.url } });
      }

      // --- /usgs passthrough ---
      if (path === '/usgs') {
        const site = url.searchParams.get('site');
        const params = url.searchParams.get('params') || '00010,00065';
        if (!site) return new Response('{"error":"missing site"}', { headers: JSON_HEADERS, status: 400 });
        const r = await fetch(`https://waterservices.usgs.gov/nwis/iv/?sites=${site}&parameterCd=${params}&format=json&period=P2D`);
        const t = await r.text();
        return new Response(t, { headers: JSON_HEADERS, status: r.status });
      }

      // --- /lake-clarity route: rainfall/runoff clarity and lure/ramp recommendations ---
      if (path === '/lake-clarity') {
        const name = url.searchParams.get('lake') || url.searchParams.get('waterbody') || '';
        const dateParam = url.searchParams.get('date') || new Date().toISOString().slice(0,10);
        if (!name) return new Response(JSON.stringify({ error:'missing lake' }), { headers: JSON_HEADERS, status:400 });
        const data = await getLakeClarity(name, dateParam);
        return new Response(JSON.stringify(data, null, 2), { headers: JSON_HEADERS });
      }

      // --- /lake-intel-sources route: trust-tier source registry ---
      if (path === '/lake-intel-sources') {
        const name = url.searchParams.get('lake') || '';
        if (name) {
          const key = lakeKeyFromName(name);
          return new Response(JSON.stringify({ key, registry: getLakeIntelSourceRegistry(key) }, null, 2), { headers: JSON_HEADERS });
        }
        return new Response(JSON.stringify(LAKE_INTEL_SOURCE_REGISTRY, null, 2), { headers: JSON_HEADERS });
      }

      // --- /lake-intel route: fisherman-focused lake briefing + latest report scrape ---
      if (path === '/lake-intel') {
        const name = url.searchParams.get('lake') || url.searchParams.get('waterbody') || '';
        if (!name) return new Response(JSON.stringify({ error: 'missing lake' }), { headers: JSON_HEADERS, status: 400 });
        const intel = await getLakeIntel(name);
        return new Response(JSON.stringify(intel, null, 2), { headers: JSON_HEADERS });
      }

      // --- /river route: real-time river conditions + kayak safety assessment ---
      //     Optional: pass ?lat=...&lon=... for location-specific surge ETA + severity
      if (path === '/river' || url.searchParams.has('river')) {
        const r = (url.searchParams.get('river') || '').toLowerCase();
        if (!r) {
          return new Response(JSON.stringify({
            error: 'missing river',
            available: Object.keys(RIVERS),
          }), { headers: JSON_HEADERS, status: 400 });
        }
        const key = Object.keys(RIVERS).find(k => r.includes(k) || k.includes(r));
        if (!key) {
          return new Response(JSON.stringify({
            error: `unknown river: ${r}`,
            available: Object.keys(RIVERS),
          }), { headers: JSON_HEADERS, status: 404 });
        }
        const userLat = parseFloat(url.searchParams.get('lat'));
        const userLon = parseFloat(url.searchParams.get('lon'));
        const opts = (isFinite(userLat) && isFinite(userLon)) ? { userLat, userLon } : {};
        const data = await getRiver(key, opts);
        return new Response(JSON.stringify(data, null, 2), { headers: JSON_HEADERS });
      }

      // --- /duke-flow-arrivals: raw Duke scheduled release JSON for a basin ---
      if (path === '/duke-flow-arrivals') {
        const basin = url.searchParams.get('basin') || '1';
        const sched = await fetchDukeFlowArrivals(basin);
        if (!sched) return new Response(JSON.stringify({error:'Duke flow-arrivals unavailable',basin}), {headers:JSON_HEADERS, status:502});
        return new Response(JSON.stringify(sched, null, 2), { headers: JSON_HEADERS });
      }

      // --- /dominion-saluda: raw Dominion color-coded Lower Saluda status ---
      if (path === '/dominion-saluda') {
        const status = await fetchDominionSaludaStatus();
        if (!status) return new Response(JSON.stringify({error:'Dominion Saluda page unavailable'}), {headers:JSON_HEADERS, status:502});
        return new Response(JSON.stringify(status, null, 2), { headers: JSON_HEADERS });
      }

      // --- /rivers route: list all available rivers ---
      if (path === '/rivers') {
        const list = Object.entries(RIVERS).map(([k, v]) => ({
          key: k, label: v.label, operator: v.operator, dam: v.damName,
          primaryGauge: (v.gauges.find(g => g.primary) || v.gauges[0]).site,
        }));
        return new Response(JSON.stringify(list, null, 2), { headers: JSON_HEADERS });
      }

      // --- /lake route or legacy ?lake= ---
      if (path === '/lake' || lake) {
        if (!lake) return new Response('{"error":"missing lake"}', { headers: JSON_HEADERS, status: 400 });
        const result = await resolveLake(lake);
        return new Response(JSON.stringify(result, null, 2), { headers: JSON_HEADERS });
      }


      // ── D1 Sync routes ──────────────────────────────────────────
      if (path.startsWith('/sync')) {
        if (!env.DB) return new Response(JSON.stringify({ error: 'D1 not configured' }), { headers: JSON_HEADERS, status: 503 });
        if (!(await isAuthorized(request, env))) {
          return new Response(JSON.stringify({ error: 'unauthorized' }), { headers: JSON_HEADERS, status: 401 });
        }
        try {

        // POST /sync/migrate — bulk import
        if (path === '/sync/migrate' && request.method === 'POST') {
          return handleSyncMigrate(request, env);
        }

        // DELETE /sync/purge-type/:type — delete all records of a type (admin cleanup)
        const purgeMatch = path.match(/^\/sync\/purge-type\/([^\/]+)$/);
        if (purgeMatch && request.method === 'DELETE') {
          const pType = purgeMatch[1];
          await ensureSyncSchema(env.DB);
          await env.DB.prepare('DELETE FROM sync_items WHERE type = ?1').bind(pType).run();
          return new Response(JSON.stringify({ ok: true, purged: pType }), { headers: JSON_HEADERS });
        }

        // GET /sync/list-updates
        if (path === '/sync/list-updates' && request.method === 'GET') {
          return handleSyncListUpdates(url, env);
        }

        // /sync/item/:type/:id
        const itemMatch = path.match(/^\/sync\/item\/([^\/]+)\/(.+)$/);
        if (itemMatch) {
          const [, type, id] = itemMatch;
          if (request.method === 'POST') return handleSyncPush(request, env, type, id);
          if (request.method === 'GET')  return handleSyncGet(env, type, id);
          if (request.method === 'DELETE') return handleSyncDelete(env, type, id);
        }

        // GET /sync/item/:key (key = "type/id")
        const keyMatch = path.match(/^\/sync\/item\/(.+)$/);
        if (keyMatch && request.method === 'GET') {
          const parts = keyMatch[1].split('/');
          const type = parts[0];
          const id = parts.slice(1).join('/');
          return handleSyncGet(env, type, id);
        }

        return new Response(JSON.stringify({ error: 'unknown sync route' }), { headers: JSON_HEADERS, status: 404 });
        } catch (syncErr) {
          return new Response(JSON.stringify({ error: `sync error: ${syncErr.message}` }), { headers: JSON_HEADERS, status: 500 });
        }
      }

      // ── Vectorized contour GeoJSON routes ───────────────────────
      const contourMatch = path.match(/^\/contours\/([^\/]+)\/geojson$/);
      if (contourMatch) {
        const lakeArg = contourMatch[1];
        if (request.method === 'GET') return handleContourGeojsonGet(env, lakeArg);
        if (request.method === 'POST' || request.method === 'PUT') {
          if (!(await isAuthorized(request, env))) {
            return new Response(JSON.stringify({ error: 'unauthorized' }), { headers: JSON_HEADERS, status: 401 });
          }
          return handleContourGeojsonPut(request, env, lakeArg);
        }
      }

      // --- Chartpack library routes (R2-backed) ---
      if (path === '/chartpacks/list') {
        const data = await handleChartpackList(env);
        return new Response(JSON.stringify(data, null, 2), { headers: JSON_HEADERS });
      }

      // Special case: /chartpacks/<lake>/index.json — generated dynamically
      // from R2 contents (we never actually upload an index.json file).
      const idxMatch = path.match(/^\/chartpacks\/([^/]+)\/index\.json$/);
      if (idxMatch) {
        const lakeName = idxMatch[1];
        const prefix = chartpackKey(lakeName, '');
        const listed = await env.R2_TROLLMAP_CHARTPACKS.list({ prefix });
        const tiles = new Set();
        let totalBytes = 0;
        for (const obj of listed.objects) {
          const fname = obj.key.slice(prefix.length);
          totalBytes += obj.size || 0;
          // Match either contours/<file> or just <file> as the tile name,
          // since upload paths can include a 'contours/' subfolder.
          const m = fname.match(/(?:^|\/)iboating_R(\d{3})_C(\d{3})_contours\.georef\.json$/i);
          if (m) tiles.add(`iboating_R${m[1]}_C${m[2]}`);
        }
        return new Response(JSON.stringify({
          lake: lakeName,
          tiles: [...tiles].sort(),
          total_bytes: totalBytes,
        }), { headers: { ...CORS, ...JSON_HEADERS, 'Cache-Control': 'no-store' } });
      }

      const cpMatch = path.match(/^\/chartpacks\/([^/]+)\/(.+)$/);
      if (cpMatch) {
        const [, lakeName, file] = cpMatch;
        const key = chartpackKey(lakeName, file);

        // GET — serve the file from R2
        if (request.method === 'GET') {
          const obj = await env.R2_TROLLMAP_CHARTPACKS.get(key);
          if (!obj) return new Response('{"error":"not found"}', { headers: JSON_HEADERS, status: 404 });
          let ct = 'application/octet-stream';
          if (file.endsWith('.png')) ct = 'image/png';
          else if (file.endsWith('.json')) ct = 'application/json';
          // No caching — every request hits R2 fresh. Avoids edge-cache 404s
          // that linger from when the file didn't exist yet.
          const headers = { ...CORS, 'Content-Type': ct, 'Cache-Control': 'no-store' };
          return new Response(obj.body, { headers });
        }

        // POST — upload to R2 (requires SYNC_TOKEN)
        if (request.method === 'POST') {
          if (!(await isAuthorized(request, env))) {
            return new Response('{"error":"unauthorized"}', { headers: JSON_HEADERS, status: 401 });
          }
          const buf = await request.arrayBuffer();
          if (!buf || buf.byteLength === 0) {
            return new Response('{"error":"empty body"}', { headers: JSON_HEADERS, status: 400 });
          }
          await env.R2_TROLLMAP_CHARTPACKS.put(key, buf, {
            httpMetadata: {
              contentType: file.endsWith('.png') ? 'image/png' : 'application/json',
              cacheControl: 'public, max-age=3600',
            },
          });
          return new Response(JSON.stringify({ uploaded: key, bytes: buf.byteLength }), { headers: JSON_HEADERS });
        }

        return new Response('{"error":"method not allowed"}', { headers: JSON_HEADERS, status: 405 });
      }

      return new Response(JSON.stringify({
        ok: true,
        worker: 'trollmap-worker',
        version: 13,
        routes: [
          '/sync/item/:type/:id               — push/get/delete a sync item (auth required)',
          '/sync/list-updates?since=<ts>      — delta list for cross-device sync (auth required)',
          '/sync/migrate                      — bulk import all local data (auth required)',
          '/contours/:lake/geojson            — serve/upload vectorized contour GeoJSON',
          '/duke?basin=1|2|3                      — raw Duke lake levels',
          '/lake?lake=wateree                     — unified lake JSON',
          '/lake-clarity?lake=wateree&date=YYYY-MM-DD — runoff clarity/ramp/lure forecast',
          '/lake-intel-sources?lake=wateree       — trust-tier source registry',
          '/lake-intel?lake=murray|marion|wateree    — fisherman lake profile + latest report scrape',
          '/river?river=wateree|congaree|saluda|broad|santee|cooper',
          '/rivers                                — list all rivers',
          '/duke-flow-arrivals?basin=1|2|3|6|10|11 — raw Duke scheduled dam releases',
          '/dominion-saluda                       — raw Dominion color-coded status',
          '/usgs?site=...&params=...              — raw USGS pass-through',
          '/chartpacks/list                       — list all uploaded chartpack lakes',
          '/chartpacks/<lake>/<file>             — serve or upload chartpack file',
        ],
      }, null, 2), { headers: JSON_HEADERS });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { headers: JSON_HEADERS, status: 500 });
    }
  }
};