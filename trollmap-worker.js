var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// trollmap-worker.js
var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Sync-Token, X-Image-Type, X-Lake, X-Date, X-Lat, X-Lon, X-Species-Hint, X-Assume-Board",
  "Access-Control-Max-Age": "60"
};
var JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };
var TEXT_HEADERS = { ...CORS, "Content-Type": "text/plain; charset=utf-8" };
var SYNC_TOKEN = "";
async function isAuthorized(request, env) {
  const want = env && env.SYNC_TOKEN || typeof SYNC_TOKEN !== "undefined" && SYNC_TOKEN || null;
  if (!want) return false;
  const got = request.headers.get("X-Sync-Token");
  return got === want;
}
__name(isAuthorized, "isAuthorized");
function chartpackKey(lake, filename) {
  const safeLake = String(lake).toLowerCase().replace(/[^a-z0-9_\-]/g, "_");
  const safeFile = String(filename).replace(/[^a-z0-9_.\-\/]/gi, "_");
  return `${safeLake}/${safeFile}`;
}
__name(chartpackKey, "chartpackKey");
async function handleChartpackList(env) {
  const out = [];
  let cursor;
  do {
    const listed = await env.R2_TROLLMAP_CHARTPACKS.list({ cursor });
    for (const obj of listed.objects) {
      const slash = obj.key.indexOf("/");
      if (slash < 0) continue;
      const lake = obj.key.slice(0, slash);
      const file = obj.key.slice(slash + 1);
      let entry = out.find((e) => e.name === lake);
      if (!entry) {
        entry = { name: lake, files: [], bytes: 0 };
        out.push(entry);
      }
      entry.files.push(file);
      entry.bytes += obj.size || 0;
    }
    cursor = listed.truncated ? listed.cursor : null;
  } while (cursor);
  for (const e of out) e.files.sort();
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { chartpacks: out, count: out.length };
}
__name(handleChartpackList, "handleChartpackList");
var LAKES = {
  wateree: { duke: "wateree", river: "02148000", normalPool: 225.5, ahq: "lake-wateree" },
  wylie: { duke: "wylie", pool: "02146000", normalPool: 569.4, ahq: "lake-wylie" },
  norman: { duke: "norman", river: "02142500", normalPool: 760 },
  // No AHQ page for Norman (NC lake)
  keowee: { duke: "keowee", river: "02163500", normalPool: 800, ahq: "lake-keowee" },
  jocassee: { duke: "jocassee", normalPool: 1110, ahq: "lake-jocassee" },
  hickory: { duke: "hickory", river: "02143500", normalPool: 935 },
  james: { duke: "james", normalPool: 1200 },
  rhodhiss: { duke: "rhodhiss", normalPool: 995.1 },
  "mountain island": { duke: "mountain island", normalPool: 647.5 },
  murray: { dominion: true, pool: "02168500", normalPool: 358, ahq: "lake-murray" },
  marion: { sepa: "marion", pool: "02169921", normalPool: 75, ahq: "santee-cooper-lake-marion-lake-moultrie" },
  moultrie: { sepa: "moultrie", pool: "02172000", normalPool: 75.5, ahq: "santee-cooper-lake-marion-lake-moultrie" },
  thurmond: { sepa: "thurmond", pool: "02196485", normalPool: 330, ahq: "clarks-hill-lake-thurmond" },
  hartwell: { sepa: "hartwell", pool: "02187010", normalPool: 660, ahq: "lake-hartwell" },
  russell: { sepa: "russell", pool: "02191743", normalPool: 475, ahq: "lake-russell" }
};
var LAKE_INTEL = {
  wateree: {
    displayName: "Lake Wateree",
    primarySportFish: ["Largemouth bass", "Striped bass", "Catfish", "Crappie", "White perch"],
    forage: ["Threadfin shad", "Gizzard shad", "Blueback herring (system-dependent)", "White perch"],
    stocking: "Managed as a Catawba-Wateree reservoir; striper/hybrid regulations and stocking can change, verify SCDNR before harvest.",
    spottedBass: "Spotted bass are present in the broader Catawba system but Wateree is still generally discussed as largemouth/striper/catfish water; verify local tournament reports for current spotted-bass pressure.",
    habitat: "Classic river-run reservoir: creek arms, rocky points, docks, riprap, bridge pilings, humps, channel swings, blowdowns, brush piles, and lower-lake bait schools.",
    bottom: "Mix of clay, rock, gravel, sand, and old river/creek-channel silt. Hard bottom around points/riprap is key for bass; deeper channel edges for stripers.",
    hazards: "Drawdown exposes shallow shoals and long points. Wind stacks up on the main lake. Below Wateree Dam is a separate river/tailwater hazard zone with generation surges.",
    seasonalPattern: "Spring: points/backs of creeks. Summer: main-lake humps/channel edges and low-light schooling. Fall: bait migration. Winter: deeper bait and slower presentations.",
    tacticalNotes: ["Use electronics to follow bait before committing to a trolling pass.", "Wind-blown points and bridge funnels can concentrate bait.", "Confirm current Duke lake stage and ramp usability before dawn launches."]
  },
  murray: {
    displayName: "Lake Murray",
    primarySportFish: ["Striped bass", "Largemouth bass", "Catfish", "Crappie", "Bream"],
    forage: ["Blueback herring", "Threadfin shad", "Gizzard shad"],
    stocking: "Known regional striper reservoir; verify current SCDNR stocking/harvest notices and seasonal closures before targeting/keeping fish.",
    spottedBass: "Spotted bass are not the defining fishery like Keowee/Hartwell; largemouth and stripers are the headline sport fisheries.",
    habitat: "Deep clear lower lake near the dam, long points, humps, shoals, docks, riprap, creek arms, bridges, and offshore bait schools.",
    bottom: "Mostly clay/sand with rock, gravel, and riprap; lower-lake clearer water and offshore structure matter heavily.",
    hazards: "Recreational boat traffic can be intense. Wind across open lower lake gets rough for kayaks. Drawdowns expose shallow points and shoals.",
    seasonalPattern: "Spring shoreline/points; summer early/late striper schooling and deeper bait; fall herring/shad movement; winter deep fish and birds/bait clues.",
    tacticalNotes: ["Blueback herring behavior drives a lot of Murray striper/bass movement.", "Plan around boat traffic and wind fetch.", "Use USGS 02168500 for reservoir pool, not the downstream Saluda gauge."]
  },
  marion: {
    displayName: "Lake Marion",
    primarySportFish: ["Largemouth bass", "Striped bass", "Catfish", "Crappie", "Bream"],
    forage: ["Threadfin shad", "Gizzard shad", "Blueback herring in parts of Santee-Cooper system", "Panfish"],
    stocking: "Santee Cooper system management changes seasonally; striped bass rules/closures are especially important to verify.",
    spottedBass: "Spotted bass are not the main story; largemouth, catfish, crappie, bream, and stripers dominate angler focus.",
    habitat: "Very shallow, sprawling, stump-filled reservoir with cypress, grass, swamp edges, old river runs, standing/flooded timber, canals, flats, drops, and brush.",
    bottom: "Mud, silt, sand, old river-channel edges, stump fields, swamp timber, and shallow flats. Hard edges/ditches can be high-value when water moves.",
    hazards: "Major stump and standing timber hazard lake. Navigation can be dangerous outside marked channels, especially at low water or in wind/fog.",
    seasonalPattern: "Spring shallow cover/spawning pockets; summer current/river runs and shaded timber; fall bait movement; winter deep holes/creek channels and crappie structure.",
    tacticalNotes: ["Treat it like a navigation lake first and a fishing lake second.", "Use marked channels and idle in unfamiliar stump fields.", "Wind can make broad shallow water rough quickly."]
  },
  moultrie: {
    displayName: "Lake Moultrie",
    primarySportFish: ["Catfish", "Largemouth bass", "Striped bass", "Crappie", "Bream"],
    forage: ["Shad", "Herring", "Panfish"],
    stocking: "Part of Santee Cooper; verify current SCDNR/Santee Cooper striper rules and stocking notices.",
    spottedBass: "Not generally a spotted-bass takeover lake; focus is catfish, largemouth, crappie, bream, and stripers.",
    habitat: "Broad bowl-like lake with grass edges, canals, dikes, deep open-water areas, shell/hard spots, drops, and Santee-Cooper current influences.",
    bottom: "Mud/sand/shell/hard spots with old inundated features and canal/dike influences.",
    hazards: "Open-water wind fetch is serious for kayaks. Current/wind around canal/dike areas can surprise. Verify lake level and wind before crossing.",
    seasonalPattern: "Catfish year-round on ledges/drifts; bass around grass/hard edges; crappie around brush/canals; striper patterns depend heavily on season/rules.",
    tacticalNotes: ["Wind direction matters as much as lake level.", "Use USGS 02172000 for Moultrie pool, not downstream/tailrace gauges."]
  },
  keowee: {
    displayName: "Lake Keowee",
    primarySportFish: ["Spotted bass", "Largemouth bass", "Crappie", "Catfish"],
    forage: ["Blueback herring", "Threadfin shad"],
    stocking: "Clear Duke reservoir; bass fishery is strongly herring-driven. Verify SCDNR for current creel/length rules.",
    spottedBass: "Yes \u2014 spotted bass are a dominant/major population and can outcompete largemouth in clear herring lakes. Expect offshore/herring-oriented behavior.",
    habitat: "Deep clear water, steep points, docks, cane/brush, rock, humps, shoals, long tapering points, and blueback-oriented offshore zones.",
    bottom: "Rock, clay, sand, gravel, steep banks, and deep clear-water structure.",
    hazards: "Clear water demands long casts/light line. Boat traffic and steep banks. Rapid weather/wind on open water.",
    seasonalPattern: "Spring herring spawn points; summer deep docks/brush/offshore; fall schooling; winter vertical/deep finesse.",
    tacticalNotes: ["Think spotted bass + blueback herring first.", "Use natural colors and electronics-heavy offshore strategy."]
  },
  hartwell: {
    displayName: "Lake Hartwell",
    primarySportFish: ["Spotted bass", "Largemouth bass", "Striped bass", "Hybrid bass", "Catfish", "Crappie"],
    forage: ["Blueback herring", "Threadfin shad", "Gizzard shad"],
    stocking: "Large Savannah River reservoir with striper/hybrid management; verify GA/SC regulations depending where you fish.",
    spottedBass: "Strong spotted bass population; blueback herring has shifted many bass patterns offshore and roam-oriented.",
    habitat: "Huge clear-to-stained reservoir with timber in upper arms, docks, clay/rock points, humps, creek channels, bridges, brush, and cane piles.",
    bottom: "Clay, rock, gravel, sand, channel silt, and timbered creek/river areas.",
    hazards: "Big water, boat traffic, state-line regulations, standing timber in some areas, and long runs in wind.",
    seasonalPattern: "Herring spawn in spring; offshore brush/points in summer; schooling in fall; deep timber/ditches in winter.",
    tacticalNotes: ["Find bait first.", "Spotted bass and stripers both track herring heavily.", "Know whether you are in SC or GA for license/rules."]
  },
  thurmond: {
    displayName: "Clarks Hill / J. Strom Thurmond Lake",
    primarySportFish: ["Striped bass", "Hybrid bass", "Largemouth bass", "Crappie", "Catfish"],
    forage: ["Blueback herring", "Threadfin shad", "Gizzard shad"],
    stocking: "USACE/Savannah River reservoir with striper/hybrid stocking/management; verify GA/SC rules.",
    spottedBass: "Spotted bass exist in the region but Thurmond is more commonly framed around largemouth, stripers/hybrids, crappie, and catfish than a spotted-bass takeover lake.",
    habitat: "Large reservoir with standing timber in many arms, points, humps, bridges, creek channels, brush piles, hydrilla/grass where present, and deep lower-lake water.",
    bottom: "Clay, rock, sand, gravel, channel silt, and extensive timbered structure.",
    hazards: "Standing timber, long open-water runs, low-water ramp issues, and state-line regulations.",
    seasonalPattern: "Spring points/pockets; summer deep humps/timber/thermocline; fall schooling; winter deep bait and channel structure.",
    tacticalNotes: ["Excellent electronics lake.", "For stripers/hybrids, bait depth and oxygen/thermocline matter."]
  },
  russell: {
    displayName: "Lake Russell",
    primarySportFish: ["Spotted bass", "Largemouth bass", "Striped bass", "Crappie", "Catfish"],
    forage: ["Blueback herring", "Threadfin shad"],
    stocking: "USACE Savannah River lake with relatively stable pool; verify GA/SC rules and striper management notices.",
    spottedBass: "Spotted bass are important and often strong due to clear water/herring-style patterns.",
    habitat: "Deep clear reservoir, standing timber, steep rocky banks, points, humps, creek channels, and limited shoreline development.",
    bottom: "Rock, clay, gravel, sand, and timbered old channels.",
    hazards: "Standing timber and deep clear water. State-line/license considerations.",
    seasonalPattern: "Herring/point bite in spring; deep timber/offshore in summer/winter; schooling in fall.",
    tacticalNotes: ["Stable water means fish may relate more to bait/season than drawdown.", "Timber edges are key."]
  },
  jocassee: {
    displayName: "Lake Jocassee",
    primarySportFish: ["Trout", "Smallmouth bass", "Spotted bass", "Largemouth bass"],
    forage: ["Blueback herring", "Threadfin shad", "Alewife/herring-type forage"],
    stocking: "Deep cold clear reservoir with trout management; verify SCDNR trout/bass rules.",
    spottedBass: "Spotted bass are present; deep clear-water tactics matter more than shallow power fishing much of the year.",
    habitat: "Extremely deep, clear, steep, rocky reservoir with timber, cliffs, waterfalls, and cold-water zones.",
    bottom: "Rock, steep clay/stone banks, deep timber, and very deep basins.",
    hazards: "Depth drops fast. Cold water, sudden mountain weather, limited access, and long paddle distances.",
    seasonalPattern: "Trout/cold-water patterns, deep vertical electronics work, and clear-water finesse bass tactics.",
    tacticalNotes: ["Safety first: cold deep water and limited shoreline access.", "Electronics and downrigger/vertical presentations shine."]
  }
};
async function fetchText(url, opts = {}) {
  const res = await fetch(url, {
    cf: { cacheTtl: 120, cacheEverything: true },
    headers: { "User-Agent": "TrollMap/10 Worker", "Accept": "text/html,application/json,*/*" },
    ...opts
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
}
__name(fetchText, "fetchText");
async function fetchUsgs(site, paramCd, periodDays = 2) {
  const out = {};
  const jsonUrl = `https://waterservices.usgs.gov/nwis/iv/?sites=${site}&parameterCd=${paramCd}&format=json&period=P${periodDays}D`;
  try {
    const r = await fetch(jsonUrl, { cf: { cacheTtl: 120 } });
    if (r.ok) {
      const j = await r.json();
      for (const ts of j?.value?.timeSeries || []) {
        const code = ts?.variable?.variableCode?.[0]?.value;
        const vals = ts?.values?.[0]?.values || [];
        const good = vals.filter((v) => v.value !== "" && v.value !== "-999999" && v.value != null);
        if (!good.length) continue;
        const latest = parseFloat(good[good.length - 1].value);
        if (!isFinite(latest)) continue;
        if (code === "00010") out.tempC = latest;
        if (code === "00065") out.gageHeight = latest;
        if (code === "00062") out.elevation = latest;
        if (code === "62614") out.elevation = latest;
        if (code === "62615") out.elevation = latest;
        if (code === "63160") out.elevationNavd88 = latest;
        if (code === "00060") out.streamflow = latest;
        out.timestamp = good[good.length - 1].dateTime;
      }
    }
  } catch (_) {
  }
  if (out.tempC != null || out.gageHeight != null || out.elevation != null) return out;
  try {
    const rdbUrl = `https://waterservices.usgs.gov/nwis/iv/?sites=${site}&parameterCd=${paramCd}&format=rdb&period=P${periodDays}D`;
    const r = await fetch(rdbUrl, { cf: { cacheTtl: 120 } });
    if (!r.ok) return out;
    const text = await r.text();
    const lines = text.split("\n").filter((l) => l && !l.startsWith("#"));
    if (lines.length < 3) return out;
    const header = lines[0].split("	");
    const dataLines = lines.slice(2).filter((l) => l.startsWith("USGS"));
    if (!dataLines.length) return out;
    const last = dataLines[dataLines.length - 1].split("	");
    for (let i = 4; i < header.length; i++) {
      const h = header[i];
      if (!h || h.endsWith("_cd")) continue;
      const m = h.match(/_(\d{5})(?:_|$)/);
      if (!m) continue;
      const code = m[1];
      const v = parseFloat(last[i]);
      if (!isFinite(v)) continue;
      if (code === "00010" && out.tempC == null) out.tempC = v;
      if (code === "00065" && out.gageHeight == null) out.gageHeight = v;
      if (code === "00062" && out.elevation == null) out.elevation = v;
      if (code === "62614" && out.elevation == null) out.elevation = v;
      if (code === "62615" && out.elevation == null) out.elevation = v;
      if (code === "63160" && out.elevationNavd88 == null) out.elevationNavd88 = v;
      if (code === "00060" && out.streamflow == null) out.streamflow = v;
    }
    if (!out.timestamp && last[2]) out.timestamp = `${last[2]} ${last[3] || ""}`.trim();
  } catch (_) {
  }
  return out;
}
__name(fetchUsgs, "fetchUsgs");
async function fetchDukeApi() {
  try {
    const r = await fetch("https://api.hydro-derived.duke-energy.app/lakes/current-level", {
      cf: { cacheTtl: 120, cacheEverything: true },
      headers: {
        "User-Agent": "TrollMap/10 Worker",
        "Origin": "https://lakes.hydro-derived.duke-energy.app",
        "Referer": "https://lakes.hydro-derived.duke-energy.app/",
        "Accept": "application/json"
      }
    });
    if (!r.ok) return null;
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) return null;
    return arr;
  } catch (_) {
    return null;
  }
}
__name(fetchDukeApi, "fetchDukeApi");
function normalizeDukeRow(row) {
  const actual = parseFloat(row.Actual);
  const elevMatch = String(row.Elevation || "").match(/([0-9]+(?:\.[0-9]+)?)/);
  const fullPool = elevMatch ? parseFloat(elevMatch[1]) : null;
  if (!isFinite(actual)) return null;
  let pct = null, ft = null;
  if (actual > 100 || fullPool && Math.abs(actual - fullPool) < fullPool * 0.1 && actual > 50) {
    ft = actual;
    pct = fullPool ? actual / fullPool * 100 : null;
  } else {
    pct = actual;
    ft = fullPool ? actual / 100 * fullPool : null;
  }
  return {
    name: row.LakeDisplayName || row.LakeName || "",
    pct: pct != null ? Math.round(pct * 100) / 100 : null,
    ft: ft != null ? Math.round(ft * 100) / 100 : null,
    fullPool,
    target: parseFloat(row.Target),
    min: parseFloat(row.Min),
    max: parseFloat(row.Max),
    date: row.Date,
    specialMessage: Array.isArray(row.SpecialMessage) && row.SpecialMessage[0] ? row.SpecialMessage[0].Text : null
  };
}
__name(normalizeDukeRow, "normalizeDukeRow");
async function getDukeLake(nameFragment) {
  const arr = await fetchDukeApi();
  if (!arr) return null;
  const frag = nameFragment.toLowerCase();
  const row = arr.find((r) => (r.LakeDisplayName || "").toLowerCase().includes(frag) || (r.LakeName || "").toLowerCase().includes(frag));
  return row ? normalizeDukeRow(row) : null;
}
__name(getDukeLake, "getDukeLake");
async function fetchDukeDashboard(basin = "1") {
  const arr = await fetchDukeApi();
  if (!arr) return null;
  const lines = arr.map((r) => {
    const n = normalizeDukeRow(r);
    if (!n) return "";
    return `${n.name} \xB7 ${n.ft != null ? n.ft.toFixed(2) : "NA"} \xB7 ${n.pct != null ? n.pct.toFixed(2) + "%" : "NA"} \xB7 target ${isFinite(n.target) ? n.target : "NA"} \xB7 full ${n.fullPool || "NA"}`;
  }).filter(Boolean);
  return { url: "https://api.hydro-derived.duke-energy.app/lakes/current-level", text: lines.join("\n"), json: arr };
}
__name(fetchDukeDashboard, "fetchDukeDashboard");
async function fetchSanteeCooper() {
  const urls = [
    "https://www.santeecooper.com/community/lakes-and-recreation/lake-levels.aspx",
    "https://www.santeecooper.com/community/lakes-and-recreation/lake-levels"
  ];
  for (const u of urls) {
    const r = await fetchText(u);
    if (r.ok && r.text) {
      const marion = r.text.match(/Marion[^0-9]{0,40}([0-9]{2}\.[0-9]{1,2})/i);
      const moultrie = r.text.match(/Moultrie[^0-9]{0,40}([0-9]{2}\.[0-9]{1,2})/i);
      if (marion || moultrie) {
        return {
          marion: marion ? parseFloat(marion[1]) : null,
          moultrie: moultrie ? parseFloat(moultrie[1]) : null,
          source: u
        };
      }
    }
  }
  return null;
}
__name(fetchSanteeCooper, "fetchSanteeCooper");
async function fetchUsaceSavannah(lakeKey) {
  const urls = [
    "https://water.sas.usace.army.mil/Lakes.htm",
    "https://water.sas.usace.army.mil/"
  ];
  for (const u of urls) {
    const r = await fetchText(u);
    if (r.ok && r.text) {
      const name = { thurmond: "Thurmond", hartwell: "Hartwell", russell: "Russell" }[lakeKey];
      if (!name) return null;
      const m = r.text.match(new RegExp(name + "[^0-9]{0,80}([0-9]{3}\\.[0-9]{1,2})", "i"));
      if (m) return { elevation: parseFloat(m[1]), source: u };
    }
  }
  return null;
}
__name(fetchUsaceSavannah, "fetchUsaceSavannah");
async function fetchAhqWaterTemp(slug) {
  if (!slug) return null;
  const url = `https://www.anglersheadquarters.com/pages/${slug}-fishing-report`;
  const r = await fetchText(url);
  if (!r.ok || !r.text) return null;
  const numericRe = /(?:morning\s+)?(?:surface\s+)?water\s+temperatures?\s+(?:are|is|range)\s+(?:about\s+|around\s+|from\s+|approximately\s+)?(\d{2,3})(?:\s*(?:to|[-–])\s*(\d{2,3}))?\s*degrees/i;
  const m = r.text.match(numericRe);
  if (m) {
    const a = parseInt(m[1]), b = m[2] ? parseInt(m[2]) : null;
    const tempF = b ? Math.round((a + b) / 2) : a;
    return { tempF, source: url, raw: m[0], range: b ? [a, b] : null };
  }
  const vagueRe = /water\s+temperatures?\s+(?:are\s+|is\s+|now\s+)?(?:in\s+the\s+)?(lower|low|mid|upper|high)?\s*(\d{2,3})s(?:\s*(?:to|[-–])\s*(lower|low|mid|upper|high)?\s*(\d{2,3})s)?/i;
  const v = r.text.match(vagueRe);
  if (v) {
    const band = /* @__PURE__ */ __name((mod, base) => {
      const b2 = parseInt(base);
      if (!mod || mod === "mid") return b2 + 5;
      if (mod === "lower" || mod === "low") return b2 + 2;
      if (mod === "upper" || mod === "high") return b2 + 8;
      return b2 + 5;
    }, "band");
    const a = band(v[1], v[2]);
    const b = v[4] ? band(v[3], v[4]) : null;
    const tempF = b ? Math.round((a + b) / 2) : a;
    return { tempF, source: url, raw: v[0], range: b ? [a, b] : null, approx: true };
  }
  return null;
}
__name(fetchAhqWaterTemp, "fetchAhqWaterTemp");
var LAKE_INTEL_SOURCE_REGISTRY = {
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
var LAKEMONSTER_IDS = {
  wateree: 1072,
  murray: 1071,
  keowee: 1068,
  hartwell: 1029,
  norman: 232
};
async function fetchLakeMonsterIntel(key) {
  const id = LAKEMONSTER_IDS[key];
  if (!id) return null;
  const url = `https://lakemonster.com/lake/SC/${encodeURIComponent((LAKE_INTEL[key]?.displayName || key).replace(/\s+/g, "-"))}-water-temperature-${id}`;
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
    const speciesNames = ["Largemouth bass", "Smallmouth bass", "Spotted bass", "Striped bass", "White bass", "Bluegill", "Black crappie", "White crappie", "Catfish", "Channel catfish", "Flathead catfish", "Blue catfish", "Walleye", "Trout"];
    for (const sp of speciesNames) {
      if (new RegExp(sp.replace(/ /g, "\\s+"), "i").test(text) && !species.includes(sp)) species.push(sp);
    }
    let context = "";
    const ctxMatch = text.match(/Today['’]?s forecast for Lake[^.]+\./i) || text.match(/Fishable[\s\S]{0,450}?water temp[\s\S]{0,250}/i);
    if (ctxMatch) context = ctxMatch[0].replace(/\s+/g, " ").trim().slice(0, 500);
    return {
      source: url,
      note: "VERIFY: LakeMonster is a third-party/model/aggregate source, not official DNR/USGS/utility data.",
      waterTemp_F: water ? parseInt(water[1], 10) : null,
      acreage: acres ? acres[1] : null,
      elevation_ft: elev ? elev[1] : null,
      fishSpeciesCount: fishCount ? parseInt(fishCount[1], 10) : null,
      species: species.slice(0, 12),
      biteRating: bite ? bite[1].replace(/\s+/g, "") : null,
      pressure: pressure ? `${pressure[1]} ${pressure[2]}` : null,
      wind: wind ? `${wind[1]} mph${wind[2] ? " " + wind[2] : ""}` : null,
      context
    };
  } catch (_) {
    return null;
  }
}
__name(fetchLakeMonsterIntel, "fetchLakeMonsterIntel");
function stripHtml(html) {
  return String(html || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}
__name(stripHtml, "stripHtml");
async function fetchAhqFishingReport(slug) {
  if (!slug) return null;
  const url = "https://www.anglersheadquarters.com/pages/" + slug + "-fishing-report";
  try {
    const r = await fetchText(url);
    if (!r.ok || !r.text) return null;

    // AHQ pages have a large nav/product header before the fishing report.
    // Anchor in raw HTML BEFORE stripping tags — nav links are <a> elements
    // that disappear on strip, but the text they generate still lands in the
    // stripped output before the real report content.
    // Strategy: find the first <article, <div class="rte", or a known
    // AHQ content marker in raw HTML and slice there before stripping.
    let rawHtml = r.text;
    const htmlAnchors = [
      rawHtml.search(/<article[\s>]/i),
      rawHtml.search(/class=["'][^"']*\brte\b[^"']*["']/i),
      rawHtml.search(/class=["'][^"']*article[^"']*body[^"']*["']/i),
      rawHtml.search(/Learn more about/i),
      rawHtml.search(/Recent [A-Za-z]+ (Lake|Fishing)/i),
    ].filter(i => i >= 0);
    if (htmlAnchors.length) {
      rawHtml = rawHtml.slice(Math.min(...htmlAnchors));
    }

    const text = stripHtml(rawHtml);

    const idxs = [
      text.search(/morning surface water temp/i),
      text.search(/water temp/i),
      text.search(/striper|striped bass|largemouth|crappie|catfish/i),
      text.search(/fishing has been|bite has been|fish are/i),
    ].filter((i) => i >= 0);
    if (!idxs.length) return null;
    const idx = Math.min(...idxs);
    let summary = text.slice(Math.max(0, idx - 100), idx + 900).trim();
    if (summary.length > 1e3) summary = summary.slice(0, 1e3) + "\u2026";
    return { source: url, summary };
  } catch (_) {
    return null;
  }
}
__name(fetchAhqFishingReport, "fetchAhqFishingReport");
function lakeKeyFromName(lakeName) {
  const raw = String(lakeName || "").toLowerCase();
  const normalized = raw.replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const aliases = {
    wateree: "wateree",
    murray: "murray",
    marion: "marion",
    moultrie: "moultrie",
    keowee: "keowee",
    jocassee: "jocassee",
    hartwell: "hartwell",
    thurmond: "thurmond",
    "clarks hill": "thurmond",
    "clark hill": "thurmond",
    russell: "russell",
    wylie: "wylie",
    norman: "norman"
  };
  for (const [frag, key] of Object.entries(aliases)) {
    if (normalized.includes(frag)) return key;
  }
  return normalized.split(" ")[0] || "";
}
__name(lakeKeyFromName, "lakeKeyFromName");
var LAKE_CLARITY_PROFILES = {
  wateree: {
    displayName: "Lake Wateree",
    center: [34.41, -80.86],
    defaultNote: "Runoff usually stains upper/northern creeks first; lower/deeper main-lake water near the dam generally stays clearer longest.",
    zones: [
      { name: "Upper river / north end", sensitivity: 1.45, base: 10, likely: "stains first from Catawba/Wateree inflow and clay banks", ramps: ["Lugoff / upstream river ramps"] },
      { name: "Dutchmans Creek / upper west arms", sensitivity: 1.35, base: 8, likely: "creek-arm runoff and shallow clay banks; expect mudlines after rain", ramps: ["Dutchmans Creek area"] },
      { name: "Wateree Creek", sensitivity: 1.25, base: 8, likely: "first major cove south of dam; can muddy in backs while mouth stays fishable", ramps: ["Wateree Creek Access Area"] },
      { name: "Beaver Creek / State Park side", sensitivity: 1.05, base: 6, likely: "moderate runoff; pockets stain before main points", ramps: ["Lake Wateree State Park", "Beaver Creek Access"] },
      { name: "Colonel / June Creek", sensitivity: 1.05, base: 6, likely: "creek backs stain, mouths create fishable color breaks", ramps: ["Colonel Creek", "June Creek"] },
      { name: "Lower main-lake channel / dam basin", sensitivity: 0.7, base: 2, likely: "deepest/clearest available water after rain", ramps: ["Clearwater Cove Marina", "Buck Hill / lower lake ramps"] }
    ]
  },
  murray: {
    displayName: "Lake Murray",
    center: [34.08, -81.35],
    defaultNote: "Upper river/creek arms stain first; dam/lower-lake herring water generally stays clearer.",
    zones: [
      { name: "Upper Saluda / river arms", sensitivity: 1.4, base: 8, likely: "muddy first after rain", ramps: ["River Bend", "Kempsons Bridge"] },
      { name: "Major creek backs", sensitivity: 1.15, base: 6, likely: "stained backs, cleaner mouths", ramps: ["creek-arm ramps"] },
      { name: "Mid-lake points / islands", sensitivity: 0.9, base: 3, likely: "slight stain after moderate rain", ramps: ["Hilton", "Dreher Island"] },
      { name: "Dam / lower lake", sensitivity: 0.65, base: 1, likely: "clearest water and herring-oriented bite", ramps: ["Lake Murray Dam", "Larry Koon"] }
    ]
  },
  marion: {
    displayName: "Lake Marion",
    center: [33.55, -80.3],
    defaultNote: "Large shallow stump/swamp reservoir; rain creates tannic/muddy creek water and debris risk, especially in upper/swamp sections.",
    zones: [
      { name: "Upper swamp / river runs", sensitivity: 1.55, base: 12, likely: "muddy/tannic and debris-prone", ramps: ["Rimini", "Low Falls"] },
      { name: "Stump flats / shallow coves", sensitivity: 1.25, base: 10, likely: "stained with navigation hazards", ramps: ["Taw Caw", "John C. Land"] },
      { name: "Main-lake open water", sensitivity: 0.9, base: 6, likely: "wind-stained but more buffered than creek backs", ramps: ["Santee State Park"] },
      { name: "Canal / dam-influenced areas", sensitivity: 0.8, base: 4, likely: "often fishable but wind/current dependent", ramps: ["C. Alex Harvin III"] }
    ]
  },
  moultrie: {
    displayName: "Lake Moultrie",
    center: [33.28, -80.05],
    defaultNote: "Wind-driven clarity matters as much as rain; broad open water can muddy quickly on windward banks.",
    zones: [
      { name: "Windward open lake", sensitivity: 1.1, base: 8, likely: "wind-stained/choppy", ramps: ["open-water ramps"] },
      { name: "Protected leeward banks/canals", sensitivity: 0.75, base: 3, likely: "best clarity after weather", ramps: ["protected canals"] },
      { name: "Shallow grass/hard-edge zones", sensitivity: 1, base: 6, likely: "can be stained but productive on moving bait", ramps: ["Fred L. Day", "Hatchery"] }
    ]
  },
  keowee: {
    displayName: "Lake Keowee",
    center: [34.7, -82.9],
    defaultNote: "Deep clear herring lake; runoff affects backs of creeks first while main points often stay clear.",
    zones: [
      { name: "Creek backs", sensitivity: 1.15, base: 5, likely: "slight stain after rain", ramps: ["creek ramps"] },
      { name: "Main-lake points / lower lake", sensitivity: 0.45, base: 0, likely: "usually clear", ramps: ["South Cove", "High Falls"] }
    ]
  },
  hartwell: {
    displayName: "Lake Hartwell",
    center: [34.48, -82.85],
    defaultNote: "Huge herring reservoir; upper arms stain first, lower main lake stays clearer.",
    zones: [
      { name: "Upper river arms", sensitivity: 1.35, base: 8, likely: "stained/muddy after rain", ramps: ["upper-arm ramps"] },
      { name: "Creek arms", sensitivity: 1.05, base: 5, likely: "backs stain, mouths fishable", ramps: ["creek ramps"] },
      { name: "Lower main lake", sensitivity: 0.65, base: 2, likely: "clearest available water", ramps: ["Green Pond", "Broyles"] }
    ]
  }
};
function classifyClarity(score) {
  if (score < 20) return { clarity: "Clear", label: "Clear", select: "Clear" };
  if (score < 40) return { clarity: "Slight stain", label: "Slight stain", select: "Stained" };
  if (score < 65) return { clarity: "Stained", label: "Stained", select: "Stained" };
  if (score < 85) return { clarity: "Muddy", label: "Muddy", select: "Muddy" };
  return { clarity: "Muddy / debris risk", label: "Muddy / debris risk", select: "Muddy" };
}
__name(classifyClarity, "classifyClarity");
function clarityLurePack(clarity) {
  const c = String(clarity || "").toLowerCase();
  if (c.includes("clear")) return {
    colors: ["Blueback herring", "Natural pearl", "Ghost shad", "Bone", "Silver flash"],
    tactics: ["longer leads", "fluorocarbon leaders", "natural profiles", "fish deeper/clearer main-lake structure"]
  };
  if (c.includes("slight")) return {
    colors: ["Pearl/chartreuse", "Sexy shad", "Tennessee shad", "Silver/gold mix", "UV white"],
    tactics: ["target creek-mouth color breaks", "slightly larger profile", "moderate vibration"]
  };
  if (c.includes("stained")) return {
    colors: ["Chartreuse/white", "Firetiger", "Gold/copper", "Orange belly", "Black back"],
    tactics: ["fish mudline edges", "use vibration/rattles", "shorten lead around cover"]
  };
  return {
    colors: ["Black/blue", "Chartreuse/black", "Bright white/chartreuse", "Orange/red craw", "large dark silhouette"],
    tactics: ["avoid backs unless targeting catfish/cover", "fish seams and hard edges", "maximize vibration/scent", "watch debris"]
  };
}
__name(clarityLurePack, "clarityLurePack");
async function fetchOpenMeteoRain(lat, lon, tripDate) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=precipitation_sum,windspeed_10m_max,winddirection_10m_dominant&past_days=3&forecast_days=7&timezone=America%2FNew_York`;
    const r = await fetch(url, { cf: { cacheTtl: 900, cacheEverything: true } });
    if (!r.ok) return null;
    const j = await r.json();
    const times = j?.daily?.time || [];
    const precip = j?.daily?.precipitation_sum || [];
    const wind = j?.daily?.windspeed_10m_max || [];
    const wdir = j?.daily?.winddirection_10m_dominant || [];
    const idx = Math.max(0, times.indexOf(tripDate || (/* @__PURE__ */ new Date()).toISOString().slice(0, 10)));
    const mm = /* @__PURE__ */ __name((i) => i >= 0 && i < precip.length && isFinite(precip[i]) ? precip[i] : 0, "mm");
    const p24 = mm(idx - 1);
    const p48 = mm(idx - 2);
    const p72 = mm(idx - 3);
    const pTrip = mm(idx);
    const total72 = p24 + p48 + p72 + 0.5 * pTrip;
    return {
      source: url,
      date: times[idx] || tripDate,
      precip24_mm: p24,
      precip48_mm: p48,
      precip72_mm: p72,
      precipTrip_mm: pTrip,
      weighted72_mm: total72,
      weighted72_in: +(total72 / 25.4).toFixed(2),
      windMax_mph: wind[idx] != null ? Math.round(wind[idx] * 0.621371) : null,
      windDirection_deg: wdir[idx] ?? null
    };
  } catch (_) {
    return null;
  }
}
__name(fetchOpenMeteoRain, "fetchOpenMeteoRain");
async function getLakeClarity(lakeName, tripDate) {
  const key = lakeKeyFromName(lakeName);
  const profile = LAKE_CLARITY_PROFILES[key] || { displayName: lakeName, center: [34, -81], defaultNote: "No custom clarity model yet; generic creek/runoff model used.", zones: [{ name: "Creeks/upper arms", sensitivity: 1.2, base: 6, likely: "stain first", ramps: [] }, { name: "Main lake/lower basin", sensitivity: 0.75, base: 2, likely: "clearest available water", ramps: [] }] };
  const [lat, lon] = profile.center;
  const rain = await fetchOpenMeteoRain(lat, lon, tripDate);
  const rainIn = rain?.weighted72_in ?? 0;
  const rainScore = rain ? Math.min(100, rainIn * 35 + rain.precip24_mm / 25.4 * 25 + rain.precipTrip_mm / 25.4 * 20) : 20;
  const zones = profile.zones.map((z) => {
    const score = Math.max(0, Math.min(100, z.base + rainScore * z.sensitivity));
    const cls = classifyClarity(score);
    const pack2 = clarityLurePack(cls.clarity);
    return { ...z, score: Math.round(score), clarity: cls.clarity, select: cls.select, lureColors: pack2.colors, tactics: pack2.tactics };
  });
  const avg = zones.reduce((a, z) => a + z.score, 0) / Math.max(1, zones.length);
  const overall = classifyClarity(avg);
  const bestZones = [...zones].sort((a, b) => a.score - b.score).slice(0, 3);
  const dirtyZones = [...zones].sort((a, b) => b.score - a.score).slice(0, 3);
  const rampRecommendations = bestZones.map((z, i) => ({
    zone: z.name,
    ramps: z.ramps || [],
    score: Math.max(0, 100 - z.score),
    why: `${z.clarity}; ${z.likely}. ${i === 0 ? "Best clarity/safety starting point." : "Secondary option."}`
  }));
  const pack = clarityLurePack(overall.clarity);
  return {
    lake: profile.displayName || lakeName,
    key,
    tripDate,
    confidence: rain ? "medium: forecast/rainfall model, verify at ramp" : "low: no rainfall feed, generic model",
    summary: rain ? `${profile.displayName || lakeName}: ${rain.weighted72_in}" weighted rain/runoff signal. ${overall.clarity} overall predicted; upper/creek arms likely dirtier than lower/main lake.` : `${profile.displayName || lakeName}: generic clarity estimate. Verify locally.`,
    overall: { clarity: overall.clarity, select: overall.select, score: Math.round(avg), lureColors: pack.colors, tactics: pack.tactics },
    rain,
    zones,
    bestZones,
    dirtyZones,
    rampRecommendations,
    note: profile.defaultNote,
    verify: "Predicted from rainfall/forecast/wind/lake-zone rules \u2014 verify water color at the ramp before committing."
  };
}
__name(getLakeClarity, "getLakeClarity");
function getLakeIntelSourceRegistry(key) {
  const base = LAKE_INTEL_SOURCE_REGISTRY.default || {};
  const lake = LAKE_INTEL_SOURCE_REGISTRY[key] || {};
  const merged = { official: [], habitat: [], reports: [], model: [] };
  for (const tier of Object.keys(merged)) {
    merged[tier] = [...base[tier] || [], ...lake[tier] || []];
  }
  const officialCount = merged.official.length + merged.habitat.length;
  const verifyCount = merged.reports.length + merged.model.length;
  return {
    ...merged,
    summary: {
      officialCount,
      verifyCount,
      trustModel: "OFFICIAL/CURATED facts first; THIRD_PARTY/MODEL sources are supplemental and must be verified."
    }
  };
}
__name(getLakeIntelSourceRegistry, "getLakeIntelSourceRegistry");
async function getLakeIntel(lakeName) {
  const key = lakeKeyFromName(lakeName);
  const sourceRegistry = getLakeIntelSourceRegistry(key);
  const profile = LAKE_INTEL[key] || {
    displayName: lakeName || key || "Unknown lake",
    primarySportFish: [],
    forage: [],
    stocking: "VERIFY: No curated stocking profile yet. Check state DNR stocking, creel-limit, and lake-management pages before relying on this.",
    spottedBass: "No verified spotted-bass note yet.",
    habitat: "No curated habitat profile yet.",
    bottom: "Unknown / verify with Navionics, sonar logs, local reports, and state habitat maps.",
    hazards: "Unknown / verify ramps, lake level, stump fields, timber, shoals, and boat traffic locally.",
    seasonalPattern: "Use current water temperature, forage, and recent reports to build a pattern.",
    tacticalNotes: ["No verified curated profile yet \u2014 treat this as a research checklist, not a fact sheet."]
  };
  const lakeCfg = LAKES[key];
  const latestReport = lakeCfg?.ahq ? await fetchAhqFishingReport(lakeCfg.ahq) : null;
  const lakeMonster = await fetchLakeMonsterIntel(key);
  const sources = [
    { label: "State fisheries / regulations", url: "https://www.dnr.sc.gov/fishregs/" }
  ];
  if (latestReport?.source) sources.push({ label: "Angler's Headquarters fishing report (VERIFY: third-party scraped text)", url: latestReport.source });
  if (lakeMonster?.source) sources.push({ label: "LakeMonster lake context (VERIFY: third-party aggregate/model)", url: lakeMonster.source });
  if (lakeCfg) sources.push({ label: "TrollMap live level worker", url: `/lake?lake=${encodeURIComponent(key)}` });
  return {
    lake: profile.displayName || lakeName,
    key,
    profile,
    latestReport,
    lakeMonster,
    sourceRegistry,
    sources,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    confidence: LAKE_INTEL[key] ? "curated_profile_plus_live_scrape_when_available" : "generic_unverified_profile"
  };
}
__name(getLakeIntel, "getLakeIntel");
var RIVERS = {
  wateree: {
    label: "Wateree River (below Wateree Dam)",
    operator: "Duke Energy",
    damName: "Wateree Dam",
    damLakeKey: "wateree",
    // → cross-link to LAKES.wateree pool data
    dukeBasinId: 1,
    // → fetchDukeFlowArrivals(1) returns the Catawba/Wateree schedule
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
    surgeSpeed_mph: 2.5,
    // calibrated: Duke API anchor (Hwy 1/601, 7.4 mi) arrives ~3h after generation start
    // Duke's "Highway 1/Highway 601 Landing" mile-marker corresponds to the
    // USGS 02148000 gauge: "7.4 mi downstream from Wateree Dam, at river mile 68.8"
    // (per USGS site metadata https://waterdata.usgs.gov/nwis/wys_rpt/?site_no=02148000)
    dukeAnchorRiverMi: 7.4,
    dukeAnchorLat: 34.2446,
    dukeAnchorLon: -80.654,
    // Surge severity attenuation — piecewise model calibrated against the
    // documented paddler observation of "5 ft surge still arriving at mile 35"
    // (paddling.com Wateree trip report) and the fact that the river fans into
    // Lake Marion at the confluence (~mile 48) where the surge dissipates fast.
    //   miles  0-20: 1.00 → 0.80   (full severity)
    //   miles 20-40: 0.80 → 0.60   (moderate — matches "5 ft at mile 35")
    //   miles 40-48: 0.60 → 0.20   (rapid attenuation as river enters Marion)
    //   past 48:     0.20          (in lake — surge dispersed into vast volume)
    surgeAttenuation: { type: "piecewise", knots: [
      { mi: 0, sev: 1 },
      { mi: 20, sev: 0.8 },
      { mi: 40, sev: 0.6 },
      { mi: 48, sev: 0.2 },
      { mi: 999, sev: 0.2 }
    ] },
    // Centerline waypoints (N → S, downstream). Only VERIFIED locations.
    // River-miles calibrated using sinuosity factor ~1.07 derived from the
    // known Dam → Camden segment (6.9 mi straight-line = 7.4 river miles).
    // Centerline waypoints sourced from VERIFIED TrollMap LAUNCHES data
    // (index.html line 1164 "Wateree River" entry) plus USGS gauge metadata.
    // River-miles calibrated using sinuosity factor 1.07 derived from the
    // Dam → Hwy 1 segment (USGS metadata: site 02148000 = "7.4 mi downstream
    // from Wateree Dam, at river mile 68.8").
    centerline: [
      { name: "Wateree Dam (Duke hydro plant)", lat: 34.3376, lon: -80.7004, mi: 0 },
      { name: "Lugoff (TrollMap)", lat: 34.33346, lon: -80.69973, mi: 0.3 },
      {
        name: "Highway 1 / Camden (TrollMap; USGS 02148000 site)",
        lat: 34.24486,
        lon: -80.65403,
        mi: 7.4
      },
      { name: "WT Billy Tolar (TrollMap)", lat: 33.94721, lon: -80.62891, mi: 29 },
      { name: "USGS 02148315 (below Eastover)", lat: 33.8285, lon: -80.6204, mi: 38 },
      {
        name: "Wateree/Congaree confluence (Sparkleberry / head of Lake Marion)",
        lat: 33.72,
        lon: -80.46,
        mi: 48
      }
    ],
    gauges: [
      {
        site: "02148000",
        name: "Wateree River near Camden, SC",
        primary: true,
        lat: 34.2446,
        lon: -80.654,
        riverMi: 7.4
      },
      {
        site: "02148315",
        name: "Wateree River below Eastover, SC",
        lat: 33.8285,
        lon: -80.6204,
        riverMi: 38
      }
    ],
    // Tuned for Wateree River below the dam — typical baseflow ~500 cfs,
    // generation spikes to 5000-9000 cfs.
    kayakThresholds: {
      cfsCalm: 800,
      cfsNormal: 2500,
      cfsPushy: 5e3,
      cfsDanger: 8e3,
      gageRiseDangerFtPerHr: 1,
      // dam-release surge cutoff
      coldTempStressF: 55
    },
    notes: "Wateree Dam generation typically pulses afternoons/evenings. A sudden rise of 2+ ft in <1 hour means generation just started \u2014 be off the water or well off the channel BEFORE this happens."
  },
  congaree: {
    label: "Congaree River (Columbia, SC)",
    operator: "Confluence of Saluda (Dominion) + Broad (SCE&G)",
    damName: "Lake Murray Dam (via Saluda) + Parr Shoals (via Broad)",
    gauges: [
      {
        site: "02169500",
        name: "Congaree River at Columbia, SC",
        primary: true,
        lat: 33.9971,
        lon: -81.047
      },
      {
        site: "02169672",
        name: "Columbia Canal at Columbia, SC",
        lat: 33.9837,
        lon: -81.0353
      }
    ],
    kayakThresholds: {
      cfsCalm: 2e3,
      cfsNormal: 6e3,
      cfsPushy: 12e3,
      cfsDanger: 2e4,
      gageRiseDangerFtPerHr: 0.8,
      coldTempStressF: 55
    },
    notes: "Receives both Saluda (cold, dam-fed) and Broad (warm). Both Lake Murray and Parr Shoals can pulse independently."
  },
  saluda: {
    label: "Lower Saluda River (below Lake Murray Dam)",
    operator: "Dominion Energy",
    damName: "Lake Murray (Saluda Hydroelectric)",
    damLakeKey: "murray",
    dominionSaluda: true,
    // → scrape dominionenergy.com for color-coded flow status
    gauges: [
      {
        site: "02168504",
        name: "Saluda River below Lake Murray Dam",
        primary: true,
        lat: 34.0539,
        lon: -81.2559
      },
      {
        site: "02169000",
        name: "Saluda River near Columbia, SC",
        lat: 33.9913,
        lon: -81.1031
      }
    ],
    // Cold tailwater — coming off the bottom of Lake Murray. Often 52-58°F
    // even in summer. Class II-III rapids when generating.
    kayakThresholds: {
      cfsCalm: 700,
      cfsNormal: 2500,
      cfsPushy: 5500,
      cfsDanger: 9e3,
      gageRiseDangerFtPerHr: 1.5,
      coldTempStressF: 60
      // higher cutoff — this river is cold even in summer
    },
    notes: "COLD TAILWATER. Water is typically 50-58\xB0F year-round (from bottom of Lake Murray). Hypothermia is a serious capsize risk even in July. Dominion generation pulses can raise flow from 700 \u2192 7000 cfs in 30 min. Famous trout fishery for the same reason it's dangerous."
  },
  broad: {
    label: "Broad River (above Columbia, SC)",
    operator: "SCE&G / Dominion (Parr Shoals)",
    damName: "Parr Shoals Dam",
    dukeBasinId: 10,
    // → BroadRiver basin in Duke API (basin 10)
    gauges: [
      {
        site: "02161000",
        name: "Broad River near Carlisle, SC",
        primary: true,
        lat: 34.5878,
        lon: -81.4214
      },
      {
        site: "02156500",
        name: "Broad River near Gaffney, SC",
        lat: 35.0001,
        lon: -81.6131
      },
      {
        site: "02160991",
        name: "Broad River at Alston, SC",
        lat: 34.2737,
        lon: -81.2754
      }
    ],
    kayakThresholds: {
      cfsCalm: 800,
      cfsNormal: 3e3,
      cfsPushy: 7e3,
      cfsDanger: 12e3,
      gageRiseDangerFtPerHr: 1.2,
      coldTempStressF: 55
    },
    notes: "Less dam-controlled than Saluda. Major flood risk after heavy rain in the upstream piedmont."
  },
  santee: {
    label: "Santee River (below Lake Marion)",
    operator: "Santee Cooper / USACE",
    damName: "Wilson Dam (Lake Marion) + Santee Rediversion Canal",
    damLakeKey: "marion",
    gauges: [
      {
        site: "02171645",
        name: "Santee River near Pineville, SC (Fort Church)",
        primary: true,
        lat: 33.4196,
        lon: -80.0142
      }
    ],
    kayakThresholds: {
      cfsCalm: 1500,
      cfsNormal: 5e3,
      cfsPushy: 15e3,
      cfsDanger: 25e3,
      gageRiseDangerFtPerHr: 1,
      coldTempStressF: 55
    },
    notes: "Tidal influence in lower reaches. The Rediversion Canal returns flow to the Santee from the Cooper system \u2014 flow direction can reverse."
  },
  cooper: {
    label: "Cooper River (Pinopolis tailrace to Charleston Harbor)",
    operator: "Santee Cooper",
    damName: "Pinopolis Dam (Lake Moultrie)",
    damLakeKey: "moultrie",
    gauges: [
      {
        site: "02172040",
        name: "Cooper River at Mobay near Goose Creek, SC",
        primary: true,
        lat: 33.0429,
        lon: -79.9587
      },
      {
        site: "02172053",
        name: "Cooper River at Filbin Creek (tidal)",
        lat: 32.8807,
        lon: -79.974
      }
    ],
    kayakThresholds: {
      cfsCalm: 500,
      cfsNormal: 2500,
      cfsPushy: 6e3,
      cfsDanger: 12e3,
      gageRiseDangerFtPerHr: 2,
      // tidal — gauge swings a lot naturally
      coldTempStressF: 50
    },
    notes: "TIDAL throughout most fishable sections. Gauge height swings ~5 ft with the tide regardless of dam. Pinopolis lock is operated 4x/day for boat passage. Salinity gradient \u2014 saltwater intrusion past the Tee Creek area on incoming tides."
  }
};
function assessKayakSafety(riverKey, gaugeData, thresholds) {
  const t = thresholds;
  const reasons = [];
  const metrics = {};
  let level = "go";
  const escalate = /* @__PURE__ */ __name((newLevel) => {
    const order = { "go": 0, "caution": 1, "no-go": 2 };
    if (order[newLevel] > order[level]) level = newLevel;
  }, "escalate");
  const cfs = gaugeData.streamflow;
  if (cfs != null) {
    metrics.streamflow_cfs = cfs;
    if (cfs >= t.cfsDanger) {
      escalate("no-go");
      reasons.push(`Streamflow ${cfs} cfs is in the DANGER zone (>${t.cfsDanger} for kayak/canoe). Strong current, swimming hazardous.`);
    } else if (cfs >= t.cfsPushy) {
      escalate("caution");
      reasons.push(`Streamflow ${cfs} cfs is PUSHY for kayaks (>${t.cfsPushy}). Experienced paddlers only.`);
    } else if (cfs >= t.cfsNormal) {
      reasons.push(`Streamflow ${cfs} cfs is normal-to-high \u2014 paddleable with care.`);
    } else if (cfs >= t.cfsCalm) {
      reasons.push(`Streamflow ${cfs} cfs is in the comfortable kayaking range.`);
    } else {
      reasons.push(`Streamflow ${cfs} cfs is LOW \u2014 expect skinny water and possible portaging over shoals.`);
    }
  }
  if (gaugeData.rateOfRiseFtPerHr != null) {
    metrics.rate_of_rise_ft_per_hr = Math.round(gaugeData.rateOfRiseFtPerHr * 100) / 100;
    if (gaugeData.rateOfRiseFtPerHr >= t.gageRiseDangerFtPerHr) {
      escalate("no-go");
      reasons.push(`\u26A0 RAPID RISE: gauge is rising at ${metrics.rate_of_rise_ft_per_hr} ft/hr \u2014 likely dam generation surge or flash flood. Get off the river.`);
    } else if (gaugeData.rateOfRiseFtPerHr >= t.gageRiseDangerFtPerHr * 0.5) {
      escalate("caution");
      reasons.push(`Gauge rising at ${metrics.rate_of_rise_ft_per_hr} ft/hr \u2014 possible dam release starting. Monitor closely.`);
    }
  }
  if (gaugeData.tempC != null) {
    const tempF = Math.round(gaugeData.tempC * 9 / 5 + 32);
    metrics.water_temp_F = tempF;
    if (tempF < t.coldTempStressF) {
      escalate("caution");
      reasons.push(`Water temp ${tempF}\xB0F \u2014 COLD-WATER capsize risk. Wear PFD + appropriate thermal protection (drysuit/wetsuit recommended below ${t.coldTempStressF}\xB0F).`);
    }
  }
  if (!reasons.length) reasons.push("Conditions appear normal \u2014 paddleable.");
  return { status: level, reasons, metrics };
}
__name(assessKayakSafety, "assessKayakSafety");
function snapToRiver(centerline, userLat, userLon) {
  let best = null;
  for (const wp of centerline) {
    const d = Math.hypot((wp.lat - userLat) * 69, (wp.lon - userLon) * 55);
    if (!best || d < best.dist) best = { dist: d, wp };
  }
  return best;
}
__name(snapToRiver, "snapToRiver");
function interpolateSeverity(att, mi) {
  if (!att) return 1;
  if (att.type === "piecewise" && Array.isArray(att.knots) && att.knots.length >= 2) {
    const ks = att.knots;
    if (mi <= ks[0].mi) return ks[0].sev;
    if (mi >= ks[ks.length - 1].mi) return ks[ks.length - 1].sev;
    for (let i = 0; i < ks.length - 1; i++) {
      const a = ks[i], b = ks[i + 1];
      if (mi >= a.mi && mi <= b.mi) {
        const t2 = (mi - a.mi) / Math.max(1e-3, b.mi - a.mi);
        return a.sev + t2 * (b.sev - a.sev);
      }
    }
  }
  const t = Math.max(0, Math.min(1, (mi - (att.fullSeverityMi || 0)) / Math.max(1, (att.dispersedMi || 70) - (att.fullSeverityMi || 0))));
  return Math.max(att.minFactor || 0.2, 1 - t * (1 - (att.minFactor || 0.2)));
}
__name(interpolateSeverity, "interpolateSeverity");
function estimateSurgeAt(river, userLat, userLon) {
  if (!river.centerline || userLat == null || userLon == null) return null;
  const snap = snapToRiver(river.centerline, userLat, userLon);
  if (!snap || snap.dist > 10) return null;
  const userRiverMi = snap.wp.mi;
  const minutesFromDam = userRiverMi / river.surgeSpeed_mph * 60;
  const severity = interpolateSeverity(river.surgeAttenuation, userRiverMi);
  return {
    nearestWaypoint: snap.wp.name,
    distance_to_waypoint_mi: Math.round(snap.dist * 10) / 10,
    river_mile_from_dam: Math.round(userRiverMi * 10) / 10,
    river_miles_remaining_to_confluence: Math.round((river.riverLength_mi - userRiverMi) * 10) / 10,
    minutes_from_generation_start: Math.round(minutesFromDam),
    surge_speed_mph: river.surgeSpeed_mph,
    surge_severity_factor: Math.round(severity * 100) / 100,
    surge_severity_label: severity > 0.75 ? "full" : severity > 0.5 ? "moderate" : severity > 0.3 ? "reduced" : "minor"
  };
}
__name(estimateSurgeAt, "estimateSurgeAt");
async function getRiver(key, opts = {}) {
  const cfg = RIVERS[key];
  if (!cfg) return { error: `unknown river: ${key}` };
  const out = {
    river: cfg.label,
    operator: cfg.operator,
    dam: cfg.damName,
    notes: cfg.notes,
    gauges: [],
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  };
  for (const g of cfg.gauges) {
    const data = await fetchUsgs(
      g.site,
      "00010,00060,00065,63160",
      /*periodDays*/
      2
    );
    const rec = {
      site: g.site,
      name: g.name,
      lat: g.lat,
      lon: g.lon,
      primary: !!g.primary,
      streamflow_cfs: data.streamflow ?? null,
      gage_height_ft: data.gageHeight ?? null,
      water_elevation_ft_navd88: data.elevationNavd88 ?? null,
      water_temperature_F: data.tempC != null ? Math.round(data.tempC * 9 / 5 + 32) : null,
      water_temperature_C: data.tempC ?? null,
      timestamp: data.timestamp ?? null
    };
    if (g.primary) {
      const rate = await computeGageRateOfRise(g.site);
      if (rate != null) rec.rate_of_rise_ft_per_hr = Math.round(rate * 100) / 100;
    }
    out.gauges.push(rec);
  }
  if (cfg.damLakeKey && LAKES[cfg.damLakeKey]) {
    try {
      const lakeData = await resolveLake(cfg.damLakeKey);
      out.upstream_lake = {
        name: cfg.damLakeKey,
        elevation_ft: lakeData.elevation_ft,
        percent_full: lakeData.percent_full,
        full_pool_ft: lakeData.full_pool_ft,
        special_message: lakeData.special_message
      };
    } catch (_) {
    }
  }
  if (cfg.dukeBasinId) {
    const sched = await fetchDukeFlowArrivals(cfg.dukeBasinId);
    if (sched && sched.arrivals.length) {
      out.dam_schedule = {
        type: "duke_flow_arrivals",
        operator: "Duke Energy",
        basinName: sched.basinName,
        lastUpdated: sched.lastUpdated,
        next: sched.arrivals[0],
        upcoming: sched.arrivals.slice(0, 6),
        source: sched.source
      };
      if (cfg.dukeAnchorRiverMi != null && sched.arrivals[0].arrivalEpoch) {
        const anchorTravelMs = cfg.dukeAnchorRiverMi / cfg.surgeSpeed_mph * 3600 * 1e3;
        out.dam_schedule.generationStartEpoch = sched.arrivals[0].arrivalEpoch - anchorTravelMs;
      }
    }
  }
  if (cfg.dominionSaluda) {
    const dom = await fetchDominionSaludaStatus();
    if (dom) {
      out.dam_schedule = {
        type: "dominion_color_status",
        operator: "Dominion Energy",
        currentColor: dom.currentColor,
        plannedColor: dom.plannedColor,
        currentRange: dom.currentRange,
        plannedRange: dom.plannedRange,
        currentCfsBand: dom.currentCfsBand,
        plannedCfsBand: dom.plannedCfsBand,
        colorLegend: dom.colorLegend,
        source: dom.source
      };
    }
  }
  if (opts.userLat != null && opts.userLon != null) {
    const loc = estimateSurgeAt(cfg, opts.userLat, opts.userLon);
    if (loc) {
      out.user_location = {
        lat: opts.userLat,
        lon: opts.userLon,
        ...loc
      };
      if (out.dam_schedule?.generationStartEpoch != null) {
        const surgeAtUserEpoch = out.dam_schedule.generationStartEpoch + loc.minutes_from_generation_start * 60 * 1e3;
        out.user_location.surge_arrival_epoch = surgeAtUserEpoch;
        out.user_location.surge_arrival_iso = new Date(surgeAtUserEpoch).toISOString();
        out.user_location.minutes_until_surge_at_user = Math.round((surgeAtUserEpoch - Date.now()) / 6e4);
      }
    }
  }
  const primary = out.gauges.find((g) => g.primary) || out.gauges[0];
  if (primary) {
    const assessment = assessKayakSafety(key, {
      streamflow: primary.streamflow_cfs,
      tempC: primary.water_temperature_C,
      rateOfRiseFtPerHr: primary.rate_of_rise_ft_per_hr
    }, cfg.kayakThresholds);
    if (out.user_location?.minutes_until_surge_at_user != null) {
      const m = out.user_location.minutes_until_surge_at_user;
      const sev = out.user_location.surge_severity_factor;
      const sevLabel = out.user_location.surge_severity_label;
      const arrTime = new Date(out.user_location.surge_arrival_epoch).toLocaleTimeString("en-US", { timeZone: "America/New_York" });
      const riverMi = out.user_location.river_mile_from_dam;
      const imminentMin = 120 / Math.max(0.5, sev);
      const headsUpMin = 360 / Math.max(0.5, sev);
      if (m > 0 && m < imminentMin && sev >= 0.5) {
        const order = { "go": 0, "caution": 1, "no-go": 2 };
        if (order[assessment.status] < 2) assessment.status = "no-go";
        assessment.reasons.unshift(
          `\u{1F6D1} ${sevLabel.toUpperCase()} dam surge arrives at YOUR LOCATION (river mile ${riverMi}) in ${m} min (~${arrTime} ET). Get off the water now.`
        );
      } else if (m > 0 && m < headsUpMin) {
        if (assessment.status === "go") assessment.status = "caution";
        const hrs = Math.round(m / 60 * 10) / 10;
        assessment.reasons.unshift(
          `\u26A0 ${sevLabel.toUpperCase()} dam surge expected at YOUR LOCATION (river mile ${riverMi}, ~${out.user_location.river_miles_remaining_to_confluence} mi above confluence) at ~${arrTime} ET (in ${hrs}h). Plan to be off the water by then.`
        );
      } else if (m > 0) {
        const hrs = Math.round(m / 60 * 10) / 10;
        assessment.reasons.push(
          `\u2139 Next dam surge reaches your location (mile ${riverMi}) in ~${hrs}h (${sevLabel} severity at this distance \u2014 surge weakens with distance from dam).`
        );
      }
    } else if (out.dam_schedule?.type === "duke_flow_arrivals" && out.dam_schedule.next) {
      const next = out.dam_schedule.next;
      const minutesUntil = (next.arrivalEpoch - Date.now()) / 6e4;
      if (minutesUntil > 0 && minutesUntil < 120) {
        const order = { "go": 0, "caution": 1, "no-go": 2 };
        if (order[assessment.status] < 2) assessment.status = "no-go";
        assessment.reasons.unshift(
          `\u{1F6D1} SCHEDULED DAM RELEASE arrives at ${next.mileMarkerName} in ${Math.round(minutesUntil)} min (~${new Date(next.arrivalEpoch).toLocaleTimeString("en-US", { timeZone: "America/New_York" })} ET). Severity decreases with distance from dam \u2014 pass your coordinates with ?lat=X&lon=Y for a location-specific estimate.`
        );
      } else if (minutesUntil > 0 && minutesUntil < 360) {
        if (assessment.status === "go") assessment.status = "caution";
        assessment.reasons.unshift(
          `\u26A0 Dam release scheduled to arrive at ${next.mileMarkerName} at ~${new Date(next.arrivalEpoch).toLocaleTimeString("en-US", { timeZone: "America/New_York" })} ET (in ${Math.round(minutesUntil / 60 * 10) / 10}h). For location-specific timing, pass your coordinates with ?lat=X&lon=Y.`
        );
      }
    }
    if (out.dam_schedule?.type === "dominion_color_status") {
      const cur = out.dam_schedule.currentColor;
      if (cur === "red") {
        assessment.status = "no-go";
        assessment.reasons.unshift("\u{1F6D1} Dominion reports current flow in RED RANGE \u2014 class IV-V whitewater, dangerous even for experts.");
      } else if (cur === "yellow") {
        if (assessment.status === "go") assessment.status = "caution";
        assessment.reasons.unshift("\u26A0 Dominion reports current flow in YELLOW RANGE \u2014 experienced paddlers only.");
      } else if (cur === "blue") {
        assessment.reasons.push("Dominion reports current flow in BLUE RANGE (normal/safe paddling).");
      }
      const plan = out.dam_schedule.plannedColor;
      if (plan && plan !== cur) {
        if (plan === "red" || plan === "yellow") {
          if (assessment.status === "go") assessment.status = "caution";
          assessment.reasons.push(`\u26A0 Dominion forecasts flow rising to ${plan.toUpperCase()} range \u2014 be ready to exit.`);
        }
      }
    }
    out.kayak_assessment = assessment;
  }
  return out;
}
__name(getRiver, "getRiver");
async function computeGageRateOfRise(site) {
  try {
    const url = `https://waterservices.usgs.gov/nwis/iv/?sites=${site}&parameterCd=00065&format=rdb&period=PT3H`;
    const r = await fetch(url, { cf: { cacheTtl: 120 } });
    if (!r.ok) return null;
    const text = await r.text();
    const lines = text.split("\n").filter((l) => l && !l.startsWith("#"));
    if (lines.length < 4) return null;
    const header = lines[0].split("	");
    let col = -1;
    for (let i = 4; i < header.length; i++) {
      if (header[i] && !header[i].endsWith("_cd") && header[i].includes("00065")) {
        col = i;
        break;
      }
    }
    if (col < 0) return null;
    const dataLines = lines.slice(2).filter((l) => l.startsWith("USGS"));
    if (dataLines.length < 4) return null;
    const samples = dataLines.map((l) => {
      const p = l.split("	");
      const v = parseFloat(p[col]);
      const [date, time] = p[2].split(" ");
      const ts = (/* @__PURE__ */ new Date(`${date}T${time}:00`)).getTime();
      return { ts, v };
    }).filter((s) => isFinite(s.v) && isFinite(s.ts));
    if (samples.length < 2) return null;
    const latest = samples[samples.length - 1];
    const targetTs = latest.ts - 60 * 60 * 1e3;
    let closest = samples[0];
    let bestDiff = Math.abs(samples[0].ts - targetTs);
    for (const s of samples) {
      const d = Math.abs(s.ts - targetTs);
      if (d < bestDiff) {
        closest = s;
        bestDiff = d;
      }
    }
    const dtHr = (latest.ts - closest.ts) / 36e5;
    if (dtHr <= 0) return null;
    return (latest.v - closest.v) / dtHr;
  } catch (_) {
    return null;
  }
}
__name(computeGageRateOfRise, "computeGageRateOfRise");
var DUKE_API_BASE = "https://api.hydro-derived.duke-energy.app";
async function fetchDukeFlowArrivals(basinId) {
  try {
    const r = await fetch(`${DUKE_API_BASE}/rivers/flow-arrivals/${basinId}`, {
      cf: { cacheTtl: 300, cacheEverything: true },
      headers: {
        "User-Agent": "TrollMap/12 Worker",
        "Origin": "https://lakes.hydro-derived.duke-energy.app",
        "Referer": "https://lakes.hydro-derived.duke-energy.app/"
      }
    });
    if (!r.ok) return null;
    const j = await r.json();
    const out = [];
    const now = Date.now();
    for (const dam of j?.Dams || []) {
      for (const ev of dam?.FlowArrivalRecessions || []) {
        const arr = ev.Arrival ? /* @__PURE__ */ new Date(ev.Arrival + (ev.Arrival.endsWith("Z") ? "" : "-04:00")) : null;
        const rec = ev.Recedes ? /* @__PURE__ */ new Date(ev.Recedes + (ev.Recedes.endsWith("Z") ? "" : "-04:00")) : null;
        if (!arr || arr.getTime() < now - 12 * 3600 * 1e3) continue;
        out.push({
          damName: ev.DamName,
          mileMarkerName: ev.MileMarkerName,
          arrival: ev.Arrival,
          recedes: ev.Recedes,
          arrivalEpoch: arr ? arr.getTime() : null,
          recedesEpoch: rec ? rec.getTime() : null
        });
      }
    }
    out.sort((a, b) => (a.arrivalEpoch || 0) - (b.arrivalEpoch || 0));
    return {
      basinName: j.RiverBasinName,
      basinId: j.RiverBasinId,
      lastUpdated: j.LastUpdated,
      arrivals: out,
      source: `${DUKE_API_BASE}/rivers/flow-arrivals/${basinId}`
    };
  } catch (e) {
    return null;
  }
}
__name(fetchDukeFlowArrivals, "fetchDukeFlowArrivals");
async function fetchDominionSaludaStatus() {
  const COLOR_RANGES = {
    green: { min: 0, max: 350, label: "GREEN \u2014 very low, scraping likely" },
    blue: { min: 350, max: 2e3, label: "BLUE \u2014 normal/safe paddling range" },
    yellow: { min: 2e3, max: 8e3, label: "YELLOW \u2014 high flow, experienced paddlers only" },
    red: { min: 8e3, max: 2e4, label: "RED \u2014 DANGEROUS, class IV-V whitewater, do not enter" }
  };
  try {
    const r = await fetch("https://www.dominionenergy.com/about/lakes-and-recreation/lower-saluda-river-sc", {
      cf: { cacheTtl: 600, cacheEverything: true },
      headers: { "User-Agent": "TrollMap/12 Worker", "Accept": "text/html" }
    });
    if (!r.ok) return null;
    const html = await r.text();
    const cur = html.match(/currently in the[^<]{0,40}<span[^>]*>\s*(blue|yellow|red|green)/i);
    const plan = html.match(/expected to be in the[^<]{0,40}<span[^>]*>\s*(blue|yellow|red|green)/i);
    const currentColor = cur ? cur[1].toLowerCase() : null;
    const plannedColor = plan ? plan[1].toLowerCase() : null;
    return {
      currentColor,
      plannedColor,
      currentRange: currentColor ? COLOR_RANGES[currentColor]?.label : null,
      plannedRange: plannedColor ? COLOR_RANGES[plannedColor]?.label : null,
      currentCfsBand: currentColor ? COLOR_RANGES[currentColor] : null,
      plannedCfsBand: plannedColor ? COLOR_RANGES[plannedColor] : null,
      source: "https://www.dominionenergy.com/about/lakes-and-recreation/lower-saluda-river-sc",
      colorLegend: COLOR_RANGES
    };
  } catch (e) {
    return null;
  }
}
__name(fetchDominionSaludaStatus, "fetchDominionSaludaStatus");
async function resolveLake(lakeName) {
  const key = Object.keys(LAKES).find((k) => lakeName.toLowerCase().includes(k));
  if (!key) return { error: `unknown lake: ${lakeName}` };
  const cfg = LAKES[key];
  const out = {
    waterbody: key,
    elevation_ft: null,
    water_temperature_F: null,
    sources: [],
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  };
  if (cfg.pool) {
    const u = await fetchUsgs(cfg.pool, "00010,00062,62614,62615,00065");
    if (u?.elevation != null) {
      out.elevation_ft = round2(u.elevation);
      out.sources.push(`USGS ${cfg.pool} (reservoir elevation)`);
    } else if (u?.gageHeight != null && !cfg.river) {
      out.elevation_ft = round2(u.gageHeight);
      out.sources.push(`USGS ${cfg.pool} (gage height \u2014 verify against published pool)`);
    }
    if (u?.tempC != null) {
      out.water_temperature_F = Math.round(u.tempC * 9 / 5 + 32);
      out.sources.push(`USGS ${cfg.pool} (temp)`);
    }
  }
  if (out.elevation_ft == null && cfg.duke) {
    const lake = await getDukeLake(cfg.duke);
    if (lake) {
      if (lake.ft != null) out.elevation_ft = lake.ft;
      if (lake.pct != null) out.percent_full = lake.pct;
      out.full_pool_ft = lake.fullPool;
      out.display_level = lake.pct;
      out.display_unit = "% full pond";
      out.display_full_pool = 100;
      if (isFinite(lake.target)) out.target = lake.target;
      out.sources.push("Duke API /lakes/current-level");
      if (lake.specialMessage) out.special_message = lake.specialMessage;
    }
  }
  if (out.elevation_ft == null && cfg.sepa) {
    if (cfg.sepa === "marion" || cfg.sepa === "moultrie") {
      const sc = await fetchSanteeCooper();
      if (sc?.[cfg.sepa] != null) {
        out.elevation_ft = sc[cfg.sepa];
        out.sources.push("Santee Cooper");
      }
    } else {
      const us = await fetchUsaceSavannah(cfg.sepa);
      if (us?.elevation != null) {
        out.elevation_ft = us.elevation;
        out.sources.push("USACE");
      }
    }
  }
  if (out.water_temperature_F == null && cfg.river) {
    const u = await fetchUsgs(cfg.river, "00010,00065,00060,63160");
    if (u?.tempC != null) {
      out.water_temperature_F = Math.round(u.tempC * 9 / 5 + 32);
      out.sources.push(`USGS ${cfg.river} (water temp)`);
    }
    if (u?.gageHeight != null) out.river_gage_height_ft = u.gageHeight;
    if (u?.streamflow != null) out.river_streamflow_cfs = u.streamflow;
    if (u?.elevationNavd88 != null) out.river_water_elevation_ft_navd88 = u.elevationNavd88;
    if (u?.timestamp) out.usgs_timestamp = u.timestamp;
  }
  if (out.water_temperature_F == null && cfg.ahq) {
    const a = await fetchAhqWaterTemp(cfg.ahq);
    if (a?.tempF != null) {
      out.water_temperature_F = a.tempF;
      out.water_temperature_source = `Angler's Headquarters report${a.approx ? " (estimated from range)" : ""}: "${a.raw}"`;
      if (a.range) out.water_temperature_range_F = a.range;
      out.sources.push(`Angler's Headquarters (${cfg.ahq})`);
    }
  }
  if (out.elevation_ft == null && cfg.normalPool) {
    out.elevation_ft = cfg.normalPool;
    out.sources.push("published normal pool (fallback)");
  }
  if (out.full_pool_ft == null && cfg.normalPool) out.full_pool_ft = cfg.normalPool;
  if (out.display_level == null && out.elevation_ft != null) {
    out.display_level = out.elevation_ft;
    out.display_unit = "ft";
    out.display_full_pool = cfg.normalPool || out.full_pool_ft || null;
  }
  out.status = out.elevation_ft != null ? "success" : "no_data";
  return out;
}
__name(resolveLake, "resolveLake");
function round2(n) {
  return Math.round(n * 100) / 100;
}
__name(round2, "round2");
var SYNC_STORES = ["plan", "spread", "catch", "chart", "layer"];
async function ensureSyncSchema(db) {
  try {
    await db.exec("CREATE TABLE IF NOT EXISTS sync_items (id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, lastModified TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (type, id))");
  } catch (e) {
    if (!String(e).includes("already exists") && !String(e).includes("SQLITE_ERROR")) throw e;
  }
  try {
    await db.exec("CREATE INDEX IF NOT EXISTS idx_sync_modified ON sync_items(lastModified)");
  } catch (e) {
    if (!String(e).includes("already exists") && !String(e).includes("SQLITE_ERROR")) throw e;
  }
}
__name(ensureSyncSchema, "ensureSyncSchema");
async function handleSyncPush(request, env, type, id) {
  if (!SYNC_STORES.includes(type)) {
    return new Response(JSON.stringify({ error: `unknown type: ${type}` }), { headers: JSON_HEADERS, status: 400 });
  }
  const body = await request.json();
  const { lastModified = (/* @__PURE__ */ new Date()).toISOString(), deleted = false, ...data } = body;
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
__name(handleSyncPush, "handleSyncPush");
async function handleSyncListUpdates(url, env) {
  await ensureSyncSchema(env.DB);
  const since = url.searchParams.get("since");
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
  const items = (rows.results || []).map((r) => ({
    key: `${r.type}/${r.id}`,
    lastModified: r.lastModified,
    deleted: r.deleted === 1
  }));
  return new Response(JSON.stringify({ items, count: items.length }), { headers: JSON_HEADERS });
}
__name(handleSyncListUpdates, "handleSyncListUpdates");
async function handleSyncGet(env, type, id) {
  await ensureSyncSchema(env.DB);
  const row = await env.DB.prepare(
    `SELECT payload, lastModified, deleted FROM sync_items WHERE type=?1 AND id=?2`
  ).bind(type, id).first();
  if (!row) return new Response(JSON.stringify({ error: "not found" }), { headers: JSON_HEADERS, status: 404 });
  const data = JSON.parse(row.payload);
  return new Response(JSON.stringify({
    ...data,
    lastModified: row.lastModified,
    deleted: row.deleted === 1
  }), { headers: JSON_HEADERS });
}
__name(handleSyncGet, "handleSyncGet");
async function handleSyncDelete(env, type, id) {
  await ensureSyncSchema(env.DB);
  await env.DB.prepare(
    `INSERT INTO sync_items (id, type, payload, lastModified, deleted)
     VALUES (?1, ?2, '{}', ?3, 1)
     ON CONFLICT(type, id) DO UPDATE SET deleted=1, lastModified=excluded.lastModified`
  ).bind(id, type, (/* @__PURE__ */ new Date()).toISOString()).run();
  return new Response(JSON.stringify({ ok: true, tombstoned: `${type}/${id}` }), { headers: JSON_HEADERS });
}
__name(handleSyncDelete, "handleSyncDelete");
async function handleSyncMigrate(request, env) {
  await ensureSyncSchema(env.DB);
  const body = await request.json();
  const items = body.items || [];
  let count = 0;
  const errors = [];
  for (const item of items) {
    try {
      const { type, id, lastModified = (/* @__PURE__ */ new Date()).toISOString(), ...data } = item;
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
__name(handleSyncMigrate, "handleSyncMigrate");
function contourGeojsonKey(lake) {
  return `${lake.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}/vectors/contours.geojson`;
}
__name(contourGeojsonKey, "contourGeojsonKey");
async function handleContourGeojsonGet(env, lake) {
  const key = contourGeojsonKey(lake);
  const obj = await env.R2_TROLLMAP_CHARTPACKS.get(key);
  if (!obj) return new Response(JSON.stringify({ error: "no vectorized contours for this lake yet" }), { headers: JSON_HEADERS, status: 404 });
  return new Response(obj.body, { headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
__name(handleContourGeojsonGet, "handleContourGeojsonGet");
async function handleContourGeojsonPut(request, env, lake) {
  const body = await request.arrayBuffer();
  if (!body || body.byteLength === 0) {
    return new Response(JSON.stringify({ error: "empty body" }), { headers: JSON_HEADERS, status: 400 });
  }
  const key = contourGeojsonKey(lake);
  await env.R2_TROLLMAP_CHARTPACKS.put(key, body, {
    httpMetadata: { contentType: "application/json", cacheControl: "no-store" }
  });
  return new Response(JSON.stringify({ ok: true, key, bytes: body.byteLength }), { headers: JSON_HEADERS });
}
__name(handleContourGeojsonPut, "handleContourGeojsonPut");
var SPECIES_MIDLANDS_SANTEE = [
  "Striped Bass",
  "Largemouth Bass",
  "White Bass / Hybrid",
  "Chain Pickerel",
  "Bowfin",
  "Bowfin (Mudfish)",
  "Black Crappie",
  "White Crappie",
  "Crappie",
  "Bluegill",
  "Redear Sunfish (Shellcracker)",
  "Redbreast Sunfish",
  "Sunfish (Panfish)",
  "Yellow Perch",
  "Blue Catfish",
  "Channel Catfish",
  "Flathead Catfish",
  "Catfish",
  "Longnose Gar",
  "Spotted Gar",
  "Gar",
  "American Shad",
  "Herring",
  "Common Carp",
  "Grass Carp",
  "Tilapia"
];
var SPECIES_UPSTATE = [
  "Spotted Bass",
  "Largemouth Bass",
  "Smallmouth Bass",
  "Striped Bass",
  "Rainbow / Brown Trout",
  "Trout",
  "Black Crappie",
  "White Crappie",
  "Crappie",
  "Channel Catfish",
  "Catfish",
  "Walleye",
  "Yellow Perch",
  "Bluegill",
  "Chain Pickerel"
];
var SPECIES_COASTAL_SALTWATER = [
  "Red Drum (Redfish)",
  "Speckled Trout (Spotted Seatrout)",
  "Flounder",
  "Black Drum",
  "Sheepshead",
  "Bluefish",
  "Spanish Mackerel",
  "Black Sea Bass",
  "Atlantic Croaker",
  "Whiting / Sea Mullet",
  "Cobia",
  "Striped Bass",
  "Ladyfish",
  "Jack Crevalle",
  // freshwater strays in tidal creeks
  "Largemouth Bass",
  "Bowfin",
  "Catfish",
  "Bluegill",
  "Sunfish (Panfish)",
  "Gar"
];
var SPECIES_ALL_TROLLMAP = [.../* @__PURE__ */ new Set([
  ...SPECIES_MIDLANDS_SANTEE,
  ...SPECIES_UPSTATE,
  ...SPECIES_COASTAL_SALTWATER,
  // catch-journal canonical aliases
  "Spotted Bass",
  "Smallmouth Bass",
  "Blue Catfish",
  "Channel Catfish",
  "Flathead Catfish",
  "Bowfin",
  "Chain Pickerel",
  "Bluegill",
  "Redear Sunfish (Shellcracker)",
  "Sunfish (Panfish)",
  "Warmouth",
  "Yellow Perch",
  "White Perch",
  "Longnose Gar",
  "Gar",
  "Red Drum (Redfish)",
  "Speckled Trout (Spotted Seatrout)",
  "Flounder",
  "American Shad",
  "White Bass / Hybrid",
  "Crappie",
  "Catfish",
  "Other Fish",
  "Not Fish"
])].sort();
function getSpeciesListForGps(lat, lon) {
  if (!isFinite(lat) || !isFinite(lon)) return SPECIES_MIDLANDS_SANTEE;
  if (lon > -80.2 && lat < 33.8) return SPECIES_COASTAL_SALTWATER;
  if (lat > 34.5 && lon < -82) return SPECIES_UPSTATE;
  return SPECIES_MIDLANDS_SANTEE;
}
__name(getSpeciesListForGps, "getSpeciesListForGps");
var MAX_BIOLOGICAL_LENGTH = {
  "Largemouth Bass": 26.5,
  "Spotted Bass": 24,
  "Smallmouth Bass": 24.5,
  "Black Crappie": 18.5,
  "White Crappie": 18.5,
  "Crappie": 18.5,
  "Bluegill": 14,
  "Redear Sunfish (Shellcracker)": 15,
  "Redbreast Sunfish": 12,
  "Sunfish (Panfish)": 14,
  "Yellow Perch": 16,
  "White Bass / Hybrid": 30,
  "Chain Pickerel": 28.5,
  "Bowfin": 36,
  "Bowfin (Mudfish)": 36,
  "Striped Bass": 52,
  "Flounder": 32,
  "Speckled Trout (Spotted Seatrout)": 34,
  "Red Drum (Redfish)": 55
};
function checkBiologicalLength(species, length) {
  if (!length || !species) return [true, ""];
  const maxLen = MAX_BIOLOGICAL_LENGTH[species] ?? MAX_BIOLOGICAL_LENGTH[species?.replace(" (Mudfish)", "")] ?? 60;
  if (length > maxLen) return [false, `\u26A0\uFE0F LENGTH ANOMALY: Reported length (${length} in) exceeds biological limit for ${species} (max ~${maxLen} in).`];
  if (length < 3) return [false, `\u26A0\uFE0F LENGTH ANOMALY: Reported length (${length} in) is implausibly small.`];
  return [true, ""];
}
__name(checkBiologicalLength, "checkBiologicalLength");
var PURE_SALTWATER = /* @__PURE__ */ new Set([
  "Red Drum (Redfish)",
  "Speckled Trout (Spotted Seatrout)",
  "Flounder",
  "Black Drum",
  "Sheepshead",
  "Bluefish",
  "Spanish Mackerel",
  "Black Sea Bass",
  "Atlantic Croaker",
  "Whiting / Sea Mullet",
  "Cobia",
  "Ladyfish",
  "Jack Crevalle"
]);
var PURE_FRESHWATER = /* @__PURE__ */ new Set([
  "Largemouth Bass",
  "Spotted Bass",
  "Smallmouth Bass",
  "Black Crappie",
  "White Crappie",
  "Crappie",
  "Chain Pickerel",
  "Bowfin",
  "Bowfin (Mudfish)",
  "Bluegill",
  "Redear Sunfish (Shellcracker)",
  "Redbreast Sunfish",
  "Sunfish (Panfish)",
  "Warmouth",
  "Walleye",
  "Rainbow / Brown Trout",
  "Trout",
  "Blue Catfish",
  "Channel Catfish",
  "Flathead Catfish",
  "Catfish",
  "Longnose Gar",
  "Spotted Gar",
  "Gar",
  "Yellow Perch",
  "White Perch",
  "Common Carp",
  "Grass Carp",
  "Tilapia"
]);
function checkEcologicalReality(lat, lon, species) {
  if (!isFinite(lat) || !isFinite(lon) || !species) return [true, ""];
  const s = String(species);
  if (["Not Fish", "No Fish", "Unknown", "Other Fish", "", "Other"].includes(s)) return [true, ""];
  if (34.3 <= lat && lat <= 34.42 && -80.22 <= lon && lon <= -80.08) {
    if (/Striped Bass|Striper|Hybrid/i.test(s)) {
      return [false, `\u26A0\uFE0F ECOLOGICAL ANOMALY: ${s} reported in Lake Robinson area (Darlington Co). Lake Robinson has NO established Striped Bass population.`];
    }
  }
  if (34.24 <= lat && lat <= 34.38 && -81.38 <= lon && lon <= -81.25) {
    if (/Striped Bass|Striper/i.test(s)) {
      return [false, `\u26A0\uFE0F ECOLOGICAL ANOMALY: ${s} reported in Monticello/Parr Reservoir area. No stocked striper population here.`];
    }
  }
  const is_murrells_inlet = 33.45 <= lat && lat <= 33.7 && lon >= -79.15;
  const is_charleston_coast = lat <= 32.9 && lon >= -79.95;
  const is_southern_coast = lat <= 32.45 && lon >= -80.75;
  if (is_murrells_inlet || is_charleston_coast || is_southern_coast) {
    if (PURE_FRESHWATER.has(s) || /Bass|Crappie|Pickerel|Bowfin|Catfish|Bluegill|Sunfish|Perch|Gar/i.test(s) && !/Striped Bass|White Bass|Sea Bass/i.test(s)) {
      const pureCheck = [...PURE_FRESHWATER].some((pf) => s === pf);
      if (pureCheck) {
        const place = is_murrells_inlet ? "Murrells Inlet / Grand Strand Estuary" : "High-Salinity Coastal Marine Estuary";
        return [false, `\u26A0\uFE0F ECOLOGICAL ANOMALY: Pure freshwater species (${s}) reported in ${place}.`];
      }
    }
  }
  if (lon <= -80.35 && lat >= 33.2) {
    if (PURE_SALTWATER.has(s)) {
      return [false, `\u26A0\uFE0F ECOLOGICAL ANOMALY: Pure saltwater marine species (${s}) reported in inland freshwater reservoir.`];
    }
  }
  if (/Smallmouth Bass/i.test(s)) {
    const in_monticello_parr = 34.15 <= lat && lat <= 34.45 && -81.45 <= lon && lon <= -81.15;
    const in_upstate_mountains = lat >= 34.5 && lon <= -82;
    if (!(in_monticello_parr || in_upstate_mountains)) {
      return [false, `\u26A0\uFE0F ECOLOGICAL ANOMALY: Smallmouth Bass reported outside valid habitat (only possible in Monticello/Parr Reservoir or cold Upstate mountain waters).`];
    }
  }
  if (/Trout|Walleye/i.test(s)) {
    if (lat < 34.5 || lon > -82) {
      return [false, `\u26A0\uFE0F ECOLOGICAL ANOMALY: Coldwater species (${s}) reported outside cold mountain waters.`];
    }
  }
  return [true, ""];
}
__name(checkEcologicalReality, "checkEcologicalReality");
function buildStage1Prompt(species_list, assume_board = false, lat = null, lon = null) {
  const species_str = species_list.map((s) => `"${s}"`).join(", ");
  const gps_tag = isFinite(lat) && isFinite(lon) ? `Photo GPS location: lat=${lat.toFixed(4)}, lon=${lon.toFixed(4)} \u2014 ${lon > -80.2 && lat < 33.8 ? "COASTAL SALTWATER" : "INLAND FRESHWATER"}` : `Photo GPS location: GPS unknown`;
  const board_task = assume_board ? `TASK 1 \u2014 BUMP BOARD: This photo is confirmed to contain a fish on a bump board. on_bump_board = true.` : `TASK 1 \u2014 BUMP BOARD DETECTION
A bump board is ANY rigid measuring device with a perpendicular nose stop and inch markings.
Common boards: Ketch Board (yellow), Hawg Trough, Golden Rule, homemade wood board.
IMPORTANT: Do NOT reject bump board because:
  - board is dirty, wet, or has stickers on it
  - numbers are faded or partially visible
  - board edge is cropped out of frame
  - fish tail hangs slightly off the end
If ANY measuring device with markings is present under the fish \u2192 on_bump_board = true`;
  return `You are a precise fisheries technician for a South Carolina kayak angler.
Return ONLY valid JSON. Temperature = 0. No guessing. No placeholders.
${gps_tag}
IMPORTANT: Use the GPS location to rule out impossible species. Inland freshwater GPS = no saltwater fish possible.

${board_task}

TASK 2 \u2014 SPECIES IDENTIFICATION
This angler fishes South Carolina freshwater lakes AND coastal saltwater. Species priority rules:

STRIPED BASS (highest priority freshwater):
  - 7-8 UNBROKEN horizontal black stripes running full body length
  - Forked tail, two separate dorsal fins
  - JUVENILE RULE: Never classify as White Bass/Hybrid because fish is small (<20 inches)
  - If continuous horizontal stripes are visible \u2192 classify as Striped Bass regardless of size

BOWFIN:
  - Single LONG dorsal fin running most of body length (not two separate fins)
  - Rounded tail (not forked)
  - Dark eyespot near base of tail \u2014 WARNING: this eyespot looks like a redfish spot but bowfin are FRESHWATER
  - Olive/brown/dark color, no stripes
  - CRITICAL: Bowfin have ONE continuous dorsal fin. Red Drum have TWO separate dorsal fins.
  - If GPS coordinates are inland/freshwater and fish has eyespot \u2192 Bowfin, NOT Red Drum

CHAIN PICKEREL:
  - Long duck-bill snout, very toothy
  - Chain-link or reticulated pattern on sides (not stripes)
  - Elongated body

CATFISH:
  - Visible whiskers/barbels around mouth
  - Smooth skin, no scales
  - No horizontal stripes
  - Blue Catfish: slate blue, straight anal fin
  - Channel Catfish: olive with dark spots, rounded anal fin
  - Flathead Catfish: flat broad head, lower jaw protruding, mottled yellow/brown

BASS (Largemouth / Spotted / Smallmouth):
  - Largemouth: jaw PAST eye, dorsal deeply notched, dark lateral blotchy band, no tongue tooth patch
  - Spotted Bass: jaw to MID-eye, rough tooth patch on tongue, dorsal fins connected, rows small spots below lateral line
  - Smallmouth: bronze, vertical bars, jaw BEFORE eye \u2013 ONLY Upstate / Jocassee / Broad River \u2013 DO NOT default Smallmouth in Wateree/Murray/Marion

CRAPPIE:
  - Deep compressed panfish
  - Black Crappie: 7-8 dorsal spines, irregular speckling
  - White Crappie: 5-6 dorsal spines, vertical barring
  - If spines not countable \u2192 "Crappie"

SUNFISH / PANFISH:
  - Bluegill: blue-purple gill flap, vertical barring, orange breast
  - Redear Sunfish (Shellcracker): red/orange margin on opercular flap
  - If uncertain beyond family \u2192 "Sunfish (Panfish)"

SALTWATER SPECIES (if coastal GPS or saltwater environment visible):
  - Red Drum (Redfish): copper/bronze body, ONE OR MORE black spots near tail base, TWO separate dorsal fins, no stripes, chin NO barbels
  - Speckled Trout: silver with scattered black spots on body AND fins, canine teeth
  - Flounder: FLAT fish, both eyes on same side, lies flat, mottled brown

GAR:
  - Long needle snout, ganoid diamond scales, long cylindrical body
  - Longnose Gar: snout >2\xD7 head length

Species choices (pick closest match): [${species_str}, "Other Fish"]

TASK 3 \u2014 LENGTH MEASUREMENT
ONLY if fish is on bump board:
  Step 1: Find nose touching bump stop (this is the 0 mark)
  Step 2: Find the FURTHEST tail tip \u2014 not the body end, the actual fin tip
  Step 3: Read ruler mark where tail tip ends
  Step 4: Round to nearest 0.25 inch \u2014 tail pinched \u2013 if ruler mark is not clearly readable \u2192 length_inches = null
  Step 5: If ruler mark is not clearly readable \u2192 length_inches = null
  CRITICAL \u2014 IGNORE ALL OF THESE when reading length:
    - Numbers on fish finders, GPS units, depth sounders, or any electronics in the photo
    - Stickers or labels on the board
    - The far end of the board
    - Your estimate of how big the fish looks
  READ ONLY the ruler mark on the bump board where the tail tip ends

Return ONLY this JSON:
{"has_fish": <true/false>, "on_bump_board": <true/false>, "species": "<exact species from list>", "length_inches": <number or null>, "confidence": "high|medium|low", "notes": "<what you see: tail tip position, visible ruler marks, species field marks>"}`;
}
__name(buildStage1Prompt, "buildStage1Prompt");
var CATCH_JSON_SCHEMA = {
  type: "OBJECT",
  properties: {
    has_fish: { type: "BOOLEAN" },
    on_bump_board: { type: "BOOLEAN" },
    species: { type: "STRING" },
    length_inches: { type: ["NUMBER", "NULL"] },
    confidence: { type: "STRING", enum: ["high", "medium", "low"] },
    notes: { type: "STRING" }
  },
  required: ["has_fish", "on_bump_board", "species", "confidence"]
};
async function handleIdentifyCatch(request, env) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");
  const latHeader = parseFloat(request.headers.get("X-Lat"));
  const lonHeader = parseFloat(request.headers.get("X-Lon"));
  const lake = request.headers.get("X-Lake") || "";
  const date = request.headers.get("X-Date") || "";
  const speciesHintHeader = (request.headers.get("X-Species-Hint") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const mimeType = request.headers.get("X-Image-Type") || request.headers.get("Content-Type") || "image/jpeg";
  const imageBuffer = await request.arrayBuffer();
  const bytes = new Uint8Array(imageBuffer);
  let binary = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  const base64String = btoa(binary);
  let species_list = speciesHintHeader.length ? speciesHintHeader : getSpeciesListForGps(latHeader, lonHeader);
  const extra = ["Striped Bass", "Largemouth Bass", "Spotted Bass", "Smallmouth Bass", "Crappie", "Blue Catfish", "Channel Catfish", "Flathead Catfish", "Catfish", "Bowfin", "Bowfin (Mudfish)", "Chain Pickerel", "Bluegill", "Redear Sunfish (Shellcracker)", "Sunfish (Panfish)", "Yellow Perch", "White Bass / Hybrid", "Longnose Gar", "Gar", "Red Drum (Redfish)", "Speckled Trout (Spotted Seatrout)", "Flounder", "American Shad", "Other Fish", "Not Fish"];
  species_list = [.../* @__PURE__ */ new Set([...species_list, ...extra])];
  const assume_board = (request.headers.get("X-Assume-Board") || "").toLowerCase() === "true";
  const prompt = buildStage1Prompt(species_list, assume_board, isFinite(latHeader) ? latHeader : null, isFinite(lonHeader) ? lonHeader : null);
  const payload = {
    systemInstruction: { parts: [{ text: "You are a precise fisheries technician. Return ONLY valid JSON. Temperature = 0." }] },
    contents: [{ parts: [
      { text: prompt },
      { inlineData: { mime_type: mimeType, data: base64String } }
    ] }],
    generationConfig: {
      temperature: 0,
      response_mime_type: "application/json",
      response_schema: CATCH_JSON_SCHEMA
    }
  };
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const geminiResp = await fetch(geminiUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (!geminiResp.ok) {
    const errText = await geminiResp.text();
    throw new Error(`Gemini API ${geminiResp.status}: ${errText.slice(0, 300)}`);
  }
  const geminiData = await geminiResp.json();
  const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error("Empty response from Gemini");
  let analysis;
  try {
    analysis = JSON.parse(rawText);
  } catch (e) {
    const m = rawText.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("Gemini returned non-JSON: " + rawText.slice(0, 200));
    analysis = JSON.parse(m[0]);
  }
  const SPECIES_MAP = {
    "Bowfin (Mudfish)": "Bowfin",
    "Mudfish": "Bowfin",
    "Black Crappie": "Crappie",
    "White Crappie": "Crappie",
    "Red Drum": "Red Drum (Redfish)",
    "Redfish": "Red Drum (Redfish)",
    "Spotted Seatrout": "Speckled Trout (Spotted Seatrout)",
    "Speckled Trout": "Speckled Trout (Spotted Seatrout)",
    "Redear Sunfish": "Redear Sunfish (Shellcracker)",
    "Shellcracker": "Redear Sunfish (Shellcracker)",
    "Bluegill": "Bluegill",
    "Panfish": "Sunfish (Panfish)",
    "Bream": "Sunfish (Panfish)",
    "White Bass": "White Bass / Hybrid",
    "Hybrid Bass": "White Bass / Hybrid",
    "Hybrid": "White Bass / Hybrid",
    "Wiper": "White Bass / Hybrid",
    "Striper": "Striped Bass",
    "Striped bass": "Striped Bass",
    "Largemouth bass": "Largemouth Bass",
    "Spotted bass": "Spotted Bass",
    "Smallmouth bass": "Smallmouth Bass",
    "Blue catfish": "Blue Catfish",
    "Channel catfish": "Channel Catfish",
    "Flathead catfish": "Flathead Catfish",
    "No Fish": "Not Fish",
    "None": "Not Fish",
    "Shad": "American Shad"
  };
  let species = analysis.species || "Other Fish";
  species = SPECIES_MAP[species] || species;
  const has_fish = analysis.has_fish ?? true;
  const on_bump_board = analysis.on_bump_board ?? false;
  let length_inches = analysis.length_inches;
  if (length_inches != null) {
    length_inches = Math.round(Number(length_inches) * 4) / 4;
  }
  let confidence = analysis.confidence || "medium";
  let notes = analysis.notes || "";
  if (isFinite(latHeader) && isFinite(lonHeader) && has_fish) {
    const [eco_ok, eco_warn] = checkEcologicalReality(latHeader, lonHeader, species);
    if (!eco_ok) {
      notes = `${eco_warn} | ${notes}`.replace(/^\s*\|\s*|\s*\|\s*$/g, "");
      confidence = "low";
      if (/Bowfin.*Red Drum|Red Drum.*Bowfin|eyespot/i.test(eco_warn)) {
        if (lonHeader <= -80.35) species = "Bowfin";
      }
    }
  }
  if (length_inches != null && has_fish) {
    const [len_ok, len_warn] = checkBiologicalLength(species, Number(length_inches));
    if (!len_ok) {
      notes = `${len_warn} | ${notes}`.replace(/^\s*\|\s*|\s*\|\s*$/g, "");
      confidence = "low";
    }
  }
  const out = {
    // fish_sorter_v4 canonical (python-compatible)
    has_fish,
    on_bump_board,
    species,
    length_inches: length_inches ?? null,
    confidence,
    notes,
    // catch-journal.js camelCase compat
    lengthInches: length_inches ?? null,
    species_confidence: confidence === "high" ? 0.9 : confidence === "medium" ? 0.65 : 0.4,
    // extended v2 fields
    length_source: on_bump_board ? length_inches != null ? "board_ruler" : "board_no_read" : "body_estimate",
    board_detected: !!on_bump_board,
    board_type: on_bump_board ? "generic" : "none",
    measurement_confidence: confidence,
    data_quality: {
      species: confidence === "high" ? "ai_verified" : "ai",
      length: on_bump_board && length_inches != null ? "board_verified" : length_inches != null ? "estimated" : "missing",
      lure: "missing",
      speed: "missing",
      depth: "missing",
      gps: isFinite(latHeader) && isFinite(lonHeader) ? "exif" : "missing"
    },
    trollmap_tags: [],
    source_model: "gemini-2.5-flash fish_sorter_v4"
  };
  if (/Bowfin/i.test(species)) out.trollmap_tags.push("reaction_feeder", "vegetation_trolling_target");
  if (/Striped Bass/i.test(species)) out.trollmap_tags.push("trolling_primary", "thermocline");
  if (/Red Drum|Redfish/i.test(species)) out.trollmap_tags.push("inshore", "tide_dependent");
  if (on_bump_board) out.trollmap_tags.push("board_measured");
  return out;
}
__name(handleIdentifyCatch, "handleIdentifyCatch");
async function handleIdentifyCatchV2(request, env) {
  let ctx = {};
  let mime_type = "image/jpeg";
  let image_base64 = null;
  try {
    const body = await request.json();
    image_base64 = body.image_base64;
    mime_type = body.mime_type || mime_type;
    ctx = body.context || {};
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: "invalid JSON body \u2013 expected {image_base64, context{}}" }), { status: 400, headers: JSON_HEADERS });
  }
  if (!image_base64) {
    return new Response(JSON.stringify({ success: false, error: "missing image_base64" }), { status: 400, headers: JSON_HEADERS });
  }
  const fakeReq = {
    headers: { get: /* @__PURE__ */ __name((k) => {
      const map = {
        "X-Image-Type": mime_type,
        "Content-Type": mime_type,
        "X-Lake": ctx.lake || "",
        "X-Date": ctx.date || "",
        "X-Lat": ctx.lat != null ? String(ctx.lat) : "",
        "X-Lon": ctx.lon != null ? String(ctx.lon) : "",
        "X-Species-Hint": (ctx.species_hint || []).join(","),
        "X-Assume-Board": ctx.assume_board ? "true" : ""
      };
      return map[k] || null;
    }, "get") },
    arrayBuffer: /* @__PURE__ */ __name(async () => {
      const bin = atob(image_base64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return arr.buffer;
    }, "arrayBuffer")
  };
  const analysis = await handleIdentifyCatch(fakeReq, env);
  return new Response(JSON.stringify({
    success: true,
    analysis,
    context_used: ctx,
    taxonomy_version: "fish_sorter_v4 / TrollMap v13",
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  }), { headers: JSON_HEADERS });
}
__name(handleIdentifyCatchV2, "handleIdentifyCatchV2");
var COACH_SYSTEM_PROMPT = `You are an expert kayak fishing guide and tactical advisor for TrollMap.

Your job is to review a trolling plan and find EXACTLY ONE improvement \u2014 the single change most likely to increase catch rate given the conditions, fish behavior, and angler equipment.

ANGLER CONSTRAINTS (never violate these):
- Spinning rods only \u2014 no conventional reels, no downriggers
- No freshwater live bait
- Maximum 2 rods in the water at once (port + starboard)
- Equipment list is fixed \u2014 only suggest lures the angler owns
- Kayak platform: Native Watersports Slayer Propel Max 12.5 + NK180 24V stern-mount electric outboard motor
  Faster speeds drain battery faster; speed suggestions must be realistic for a full-day kayak session
- Depth control: lead length only (no downriggers, no planer boards)
- If the plan includes a planMeta.speedRationale, the speed was deliberately chosen by the primary AI guide. Do NOT suggest changing speed unless you have a specific safety concern or strong catch-rate evidence that directly contradicts the rationale.

LURE-SPECIFIC HARD CONSTRAINTS (non-negotiable):
- Flutter Spoon: angler owns exactly ONE system \u2014 3/4oz Nichols 4" Shattered Glass Silver + 2oz torpedo
  inline weight (2.75oz total). Color is ALWAYS Shattered Glass Silver \u2014 no other color exists.
  This is a TROLLING presentation at 1.6-2.4mph, NOT a vertical jigging lure.
  Only ONE rod can run the flutter spoon at any time.
- A-Rig (umbrella rig): comes in Light/Medium/Heavy sizes. Port and Starboard CAN both run
  A-rigs simultaneously at different sizes/leads to cover different depth zones.
- Port and Starboard rods are COMPLEMENTARY \u2014 they should cover different depth zones or
  presentations simultaneously, not the same lure on both rods.

ROD PAIRING LOGIC:
- A valid spread has two DIFFERENT presentations covering different water column zones
- Flutter Spoon + A-Rig is a valid pairing (different action profiles, different depths)
- A-Rig Light + A-Rig Medium is a valid pairing (same family, different depths)
- Flutter Spoon + Flutter Spoon is INVALID \u2014 only one spoon system exists
- Do NOT swap lures between port and starboard if it creates an invalid pairing
- Do NOT suggest flutter_spoon_color changes \u2014 color is always Shattered Glass Silver

YOU MAY ONLY SUGGEST CHANGES TO THESE FIELDS:
lure, lure_size, lead_length, trolling_speed, target_depth,
phase_timing, rod_assignment, inline_weight, route_pattern, casting_stop_suggestion

YOU MUST NEVER SUGGEST CHANGES TO:
lure_color for flutter spoon, species, lake, launch_ramp, weather, safety_limits,
battery_limits, gear_not_owned, live_bait, conventional_reels

RESPONSE FORMAT \u2014 return ONLY this JSON object, no other text:
{
  "has_suggestion": true,
  "suggestion": {
    "field": "the field being changed",
    "phase": 1,
    "rod": "Port",
    "current_value": "what it is now",
    "recommended_value": "what to change it to",
    "confidence": 0.87,
    "reasons": ["reason 1", "reason 2", "reason 3"],
    "warnings": ["any cautions"],
    "evidence_sources": ["catch_history", "water_temp", "clarity", "solunar", "structure", "community_spots", "general_knowledge"]
  },
  "no_suggestion_reason": "only populate if has_suggestion is false"
}

If you cannot find a meaningful improvement, set has_suggestion to false.
Never invent lures the angler does not own. Never suggest live bait.`;
async function handleCoachPlan(request, env) {
  try {
    const body = await request.json();
    const groqKey = env?.GROQ_API_KEY;
    if (!groqKey) {
      return new Response(JSON.stringify({ success: false, error: "Groq API key not configured" }), { status: 500, headers: JSON_HEADERS });
    }
    const { payload, previousSuggestions = [] } = body;
    if (!payload) {
      return new Response(JSON.stringify({ success: false, error: "Missing payload" }), { status: 400, headers: JSON_HEADERS });
    }
    let userMessage = `Review this trolling plan and find ONE improvement.

PLAN:
${JSON.stringify(payload, null, 2)}`;
    if (previousSuggestions.length > 0) {
      const accepted = previousSuggestions.filter((s) => s.status === "accepted" || !s.status);
      const skipped = previousSuggestions.filter((s) => s.status === "skipped");
      if (accepted.length > 0) {
        userMessage += `

ACCEPTED CHANGES \u2014 these are now LIVE in the plan, do not reverse or re-suggest:
`;
        accepted.forEach((s, i) => {
          userMessage += `${i + 1}. [ACCEPTED] ${s.field}${s.phase ? ` Phase ${s.phase}` : ""}${s.rod ? ` ${s.rod}` : ""}: "${s.current_value}" \u2192 "${s.recommended_value}"
`;
        });
      }
      if (skipped.length > 0) {
        userMessage += `
SKIPPED SUGGESTIONS \u2014 angler passed on these, do not re-suggest:
`;
        skipped.forEach((s, i) => {
          userMessage += `${i + 1}. [SKIPPED] ${s.field}${s.phase ? ` Phase ${s.phase}` : ""}${s.rod ? ` ${s.rod}` : ""}: "${s.current_value}" \u2192 "${s.recommended_value}"
`;
        });
      }
      userMessage += `
CURRENT SPREAD STATE (after accepted changes):
- Check accepted changes above to understand what each rod is currently running
- Do not suggest a change that would undo an accepted change or create an invalid rod pairing
`;
    }
    userMessage += `

Return ONLY the JSON object. Find the single highest-confidence improvement, or set has_suggestion to false if the plan is already well-optimized.`;
    const groqPayload = {
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: COACH_SYSTEM_PROMPT },
        { role: "user", content: userMessage }
      ],
      temperature: 0.15,
      max_tokens: 800,
      response_format: { type: "json_object" }
    };
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${groqKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(groqPayload)
    });
    const j = await r.json();
    if (!r.ok) {
      return new Response(JSON.stringify({ success: false, error: j.error?.message || `Groq HTTP ${r.status}` }), { status: r.status, headers: JSON_HEADERS });
    }
    let suggestion = {};
    try {
      suggestion = JSON.parse(j.choices?.[0]?.message?.content || "{}");
    } catch (_) {
      suggestion = { has_suggestion: false, no_suggestion_reason: "Parse error" };
    }
    return new Response(JSON.stringify({ success: true, ...suggestion }), { headers: JSON_HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers: JSON_HEADERS });
  }
}
__name(handleCoachPlan, "handleCoachPlan");
var trollmap_worker_default = {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const lake = (url.searchParams.get("lake") || "").toLowerCase();
    try {
      if (path === "/identify-catch" && request.method === "POST") {
        try {
          const analysis = await handleIdentifyCatch(request, env);
          return new Response(JSON.stringify({ success: true, analysis }), { headers: JSON_HEADERS });
        } catch (err) {
          return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: JSON_HEADERS });
        }
      }
      if (path === "/identify-catch-v2" && request.method === "POST") {
        try {
          return await handleIdentifyCatchV2(request, env);
        } catch (err) {
          return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: JSON_HEADERS });
        }
      }
      if (path === "/audit-plan" && request.method === "POST") {
        try {
          const body = await request.json();
          const groqKey = env.GROQ_API_KEY;
          if (!groqKey) {
            return new Response(JSON.stringify({ success: false, error: "GROQ_API_KEY not configured on worker environment" }), { status: 500, headers: JSON_HEADERS });
          }
          const SYSTEM_PROMPT = `You are a crusty, veteran South Carolina fishing guide. You have zero patience for "textbook" plans that make no tactical sense in the real world. You speak plainly and critically.

ANGLER PROFILE \u2014 apply these constraints strictly:
- Watercraft: Native Watersports Slayer Propel Max 12.5 pedal kayak + NK180 Pro 24V bow-mount trolling motor
- Rods: Spinning rods ONLY. A-rigs on spinning rods are confirmed working gear.
- No lead-core, no conventional reels, no planer boards, no downriggers
- Depth control: Lead length only.
- Max 2 rods in the water simultaneously.
- Trolling-first angler.
- Freshwater live bait: NOT available (no livewell).

TACTICAL AUDIT RULES \u2014 Flag these as MAJOR ERRORS:
1. DEPTH MISMATCHES: 
   - Flag any A-Rig or Deep Crankbait running shallower than 10-12ft. (Trolling an A-Rig at 5ft is a waste of time).
   - Flag any lure with a max dive of 15ft being run in 25ft of water without clear rationale.
   - Flag any "Deep" lure running too deep for the target species/season (e.g., Stripers in summer usually stack 16-20ft; 30ft is too deep).
2. LURE MISMATCHES:
   - If the plan calls for "Shallow" water (<10ft) but uses an A-Rig, flag it. Suggest Squarebills, Lipless, Spinnerbaits, or Topwater.
3. LOGIC GAPS:
   - If the plan suggests "Dawn" tactics but uses deep-water lures at depths that don't match morning schooling behavior.

CRITIQUE FORMAT \u2014 respond ONLY with valid JSON, no markdown fences:
{
  "overall_score": <1-10>,
  "confidence": "<high|medium|low>",
  "verdict": "<one punchy, honest sentence overall take>",
  "scores": {
    "depth_alignment": <1-10>,
    "lure_selection": <1-10>,
    "speed_cadence": <1-10>,
    "battery_management": <1-10>,
    "safety": <1-10>
  },
  "flags": ["<specific tactical error>", ...],
  "fixes": ["<actionable professional fix>", ...],
  "keeper_moves": ["<what actually makes sense>", ...],
  "local_intel": "<one SC-specific tip the plan missed>"
}

Be direct. If the plan is tactically stupid, say so. Keep flags and fixes to 2-3 items each.`;
          const p = body.plan || body;
          const meta = p.meta || p;
          const spread = (p.spread || []).map((r2) => ({
            side: r2.side,
            position: r2.position,
            rod: r2.rod || "",
            reel: r2.reel || "",
            lure: r2.lure || r2.notes?.split("\xB7")[0]?.trim() || "",
            depth: r2.depth,
            lead: r2.lead,
            notes: r2.notes?.slice(0, 120) || ""
          })).filter((r2) => r2.lure || r2.notes);
          const cleanPlan = {
            lake: meta.lake || p.lake,
            species: meta.species || p.species,
            date: meta.date || p.date,
            ramp: meta.ramp || p.ramp,
            launchTime: meta.launchTime || p.launchTime,
            returnTime: meta.returnTime || p.returnTime,
            waterTemp: meta.waterTemp || p.waterTemp ? `${meta.waterTemp || p.waterTemp}` : null,
            poolLevel: meta.poolLevel || p.poolLevel || null,
            weather: meta.weather || p.weather || "",
            clarity: meta.clarity || p.clarity || "",
            motor: meta.motor || p.motor || "",
            solunar: meta.solunar || p.solunar || "",
            spread: spread.slice(0, 6),
            tackle: p.tackle || "",
            safety: p.safety || "",
            notes: p.notes || "",
            rationale: (p.rationale || "").slice(0, 1500)
            // first 800 chars of rationale only
          };
          const userMessage = `Audit this trolling plan. Apply the angler profile constraints strictly \u2014 flag anything that assumes gear or bait this angler does not have. Identify the single most dangerous safety gap if any. Return ONLY the JSON object described in your system prompt.

PLAN DATA:
${JSON.stringify(cleanPlan, null, 2)}`;
          const payload = {
            model: "llama-3.3-70b-versatile",
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: userMessage }
            ],
            temperature: 0.15,
            response_format: { type: "json_object" }
          };
          const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: { "Authorization": `Bearer ${groqKey}`, "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          const j = await r.json();
          if (!r.ok) {
            return new Response(JSON.stringify({ success: false, error: j.error?.message || `Groq API HTTP ${r.status}` }), { status: r.status, headers: JSON_HEADERS });
          }
          let audit = {};
          try {
            audit = JSON.parse(j.choices?.[0]?.message?.content || "{}");
          } catch (_) {
            audit = { error: "parse failed", raw: j.choices?.[0]?.message?.content };
          }
          return new Response(JSON.stringify({ success: true, audit }), { headers: JSON_HEADERS });
        } catch (err) {
          return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: JSON_HEADERS });
        }
      }
      if (path === "/coach-plan" && request.method === "POST") {
        return handleCoachPlan(request, env);
      }
      if (path === "/groq-query" && request.method === "POST") {
        try {
          const body = await request.json();
          const groqKey = env?.GROQ_API_KEY;
          if (!groqKey) return new Response(JSON.stringify({ error: "Groq API key not configured" }), { status: 500, headers: JSON_HEADERS });
          const { messages, model = "llama-3.3-70b-versatile", max_tokens = 200, temperature = 0.2 } = body;
          if (!messages?.length) return new Response(JSON.stringify({ error: "Missing messages" }), { status: 400, headers: JSON_HEADERS });
          const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: { "Authorization": `Bearer ${groqKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model, messages, max_tokens, temperature })
          });
          const data = await r.json();
          if (!r.ok) return new Response(JSON.stringify({ error: data.error?.message || `Groq HTTP ${r.status}` }), { status: r.status, headers: JSON_HEADERS });
          return new Response(JSON.stringify(data), { headers: JSON_HEADERS });
        } catch (e) {
          return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: JSON_HEADERS });
        }
      }
      if (path === "/detect-structure" && request.method === "POST") {
        try {
          const body = await request.json();
          const apiKey = env.GEMINI_API_KEY;
          if (!apiKey) {
            return new Response(JSON.stringify({ success: false, error: "GEMINI_API_KEY not configured" }), { status: 500, headers: JSON_HEADERS });
          }
          const {
            image_base64,
            mime_type = "image/jpeg",
            bounds,
            image_width = 1024,
            image_height = 600
          } = body;
          if (!image_base64 || !bounds?.north || !bounds?.south || !bounds?.east || !bounds?.west) {
            return new Response(JSON.stringify({ success: false, error: "missing image_base64 or bounds" }), { status: 400, headers: JSON_HEADERS });
          }
          const SYSTEM_PROMPT = `You are analyzing a satellite/aerial image of a South Carolina lake or river for fishing-relevant structures.

First, confirm water is visible. If no water body is present, return {"has_water":false,"features":[],"image_notes":"No water visible"}.

STRICT RULE: Only report structures that have a VISIBLE PHYSICAL CONNECTION to the shoreline or are clearly sitting in/on the water. A structure floating in open water with no visible connection to shore is almost certainly a false read \u2014 omit it. When in doubt, omit.

For each structure DIRECTLY OVER OR TOUCHING the water, identify:
- Docks/boat docks (rectangular platforms extending from shore over water \u2014 must be attached to shore)
- Piers (longer linear walkways into water \u2014 must connect to land)
- Boat ramps (light-colored concrete sloping from shore into water)
- Boathouses (roofed structures over water \u2014 must be shore-connected)
- Timber/logs (clearly visible debris in the water, not shadows)
- Fish attractors (dark man-made patches in shallow water near shore)

DO NOT flag: swimming pools, buildings set back from water, roads, shadows, trees, boat wakes, reflections, open water with no structure, or anything without a clear physical connection to shore or the water surface.

Return position as precise FRACTION of image dimensions:
- x_frac: 0.0 (left edge) to 1.0 (right edge)
- y_frac: 0.0 (top edge) to 1.0 (bottom edge)

Place the fraction at the point where the structure meets the water, not the far end. Only include structures you are 75%+ confident about. Fewer accurate results is better than many uncertain ones.`;
          const userPrompt = `Analyze this ${image_width}x${image_height} satellite image. Bounds: N=${bounds.north.toFixed(6)}, S=${bounds.south.toFixed(6)}, E=${bounds.east.toFixed(6)}, W=${bounds.west.toFixed(6)}. Return ONLY valid JSON: {"has_water":true,"features":[{"type":"dock|pier|boat_ramp|boathouse|timber|fish_attractor","x_frac":0.0,"y_frac":0.0,"confidence":0.0,"description":"brief","fishing_notes":"why this matters"}],"image_notes":"description"}`;
          const payload = {
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [{ parts: [
              { text: userPrompt },
              { inlineData: { mime_type, data: image_base64 } }
            ] }],
            generationConfig: {
              temperature: 0,
              response_mime_type: "application/json",
              thinkingConfig: { thinkingBudget: 0 }
            }
          };
          const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
          let r, attempts = 0;
          while (attempts < 3) {
            r = await fetch(geminiUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
            if (r.status !== 503) break;
            attempts++;
            if (attempts < 3) await new Promise((res) => setTimeout(res, 1e3 * attempts));
          }
          if (!r.ok) {
            const errText = await r.text();
            return new Response(JSON.stringify({ success: false, error: `Gemini ${r.status}: ${errText.slice(0, 300)}` }), { status: r.status, headers: JSON_HEADERS });
          }
          const gData = await r.json();
          const rawText = gData.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!rawText) return new Response(JSON.stringify({ success: false, error: "Empty Gemini response" }), { status: 500, headers: JSON_HEADERS });
          let result = {};
          try {
            result = JSON.parse(rawText);
          } catch (_) {
            result = { error: "parse failed", raw: rawText.slice(0, 500) };
          }
          const latRange = bounds.north - bounds.south;
          const lonRange = bounds.east - bounds.west;
          if (Array.isArray(result.features)) {
            result.features = result.features.map((f) => ({
              ...f,
              lat: bounds.north - f.y_frac * latRange,
              lon: bounds.west + f.x_frac * lonRange
            }));
            const before = result.features.length;
            result.features = result.features.filter((f) => {
              const fromWest = (f.lon - bounds.west) / lonRange;
              const fromEast = (bounds.east - f.lon) / lonRange;
              const fromNorth = (bounds.north - f.lat) / latRange;
              const fromSouth = (f.lat - bounds.south) / latRange;
              return Math.min(fromWest, fromEast, fromNorth, fromSouth) <= 0.35;
            });
            const dropped = before - result.features.length;
            if (dropped > 0) {
              result.image_notes = (result.image_notes || "") + ` [${dropped} open-water false positive${dropped > 1 ? "s" : ""} removed]`;
            }
          }
          return new Response(JSON.stringify({ success: true, ...result }), { headers: JSON_HEADERS });
        } catch (err) {
          return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: JSON_HEADERS });
        }
      }
      if (path === "/ramps") {
        const state = (url.searchParams.get("state") || "SC").toUpperCase();
        const forceRefresh = url.searchParams.has("refresh");
        const cacheKey = `ramps/${state.toLowerCase()}/ramps.json`;
        const CACHE_TTL_DAYS = 7;
        const RAMP_SOURCES = {
          SC: {
            url: "https://services.arcgis.com/acgZYxoN5Oj8pDLa/arcgis/rest/services/South_Carolina_Public_Water_Access_PUBLIC_VIEW/FeatureServer/0/query",
            filter: /* @__PURE__ */ __name((p) => p.WaterAccessType === "Boat Ramp" && p.Status?.toLowerCase() === "active" && p.PublicAccess?.toLowerCase() !== "closed", "filter"),
            name: /* @__PURE__ */ __name((p) => p.WaterAccessName, "name"),
            wb: /* @__PURE__ */ __name((p) => p.Waterbody, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.Latitude, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.Longitude, "lon"),
            meta: /* @__PURE__ */ __name((p) => ({ lanes: p.LaunchLanes, dock: p.CourtesyDock, fee: false, species: p.SpeciesList, county: p.County, owner: p.Owner, comments: p.Comments }), "meta"),
            label: "SCDNR South Carolina Public Water Access"
          },
          GA: {
            url: "https://services6.arcgis.com/9QlSLDqa0P1cHLhu/arcgis/rest/services/WRD_Water_Access_Points/FeatureServer/0/query",
            idField: "FID",
            // GA's objectIdFieldName is FID, not OBJECTID — using OBJECTID in orderByFields causes a 400 from ArcGIS, silently zeroing out results
            // Real schema confirmed 2026-07-03 via outFields=* query — field
            // names (Name/Waterbody/Latitude/Longitude/Status) were already
            // correct, but Ramp/Fee are single-letter "Y"/"N" booleans, not
            // the strings "yes"/"no" this filter was checking for. Every
            // record failed the check, so GA returned 0 waterbodies/0 ramps
            // regardless of cache state.
            filter: /* @__PURE__ */ __name((p) => String(p.Ramp || "").toUpperCase() === "Y" && !["closed", "inactive"].includes(String(p.Status || "").toLowerCase()), "filter"),
            name: /* @__PURE__ */ __name((p) => p.Name, "name"),
            wb: /* @__PURE__ */ __name((p) => p.Waterbody, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.Latitude, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.Longitude, "lon"),
            meta: /* @__PURE__ */ __name((p) => ({ lanes: p.NumLanes, dock: p.Dock, fee: String(p.Fee || "").toUpperCase() === "Y", county: p.County, owner: p.Owner, motorRestrictions: p.MotorRest }), "meta"),
            label: "Georgia DNR WRD Water Access Points"
          },
          NC: {
            url: "https://services1.arcgis.com/YfqBAUM5nWR3yhGP/arcgis/rest/services/NCWRC_Boating_Access_Areas_view/FeatureServer/0/query",
            // Real schema confirmed 2026-07-03 via outFields=* query — NC WRC does NOT
            // use STATUS/SITE_NAME/WATER_BODY like SC/GA. Every prior field guess missed,
            // so all 267 records collapsed into a single "Unknown" waterbody bucket.
            filter: /* @__PURE__ */ __name((p) => !String(p.Site_Status || "OPEN").toUpperCase().includes("CLOSED"), "filter"),
            name: /* @__PURE__ */ __name((p) => p.BAA_Name, "name"),
            wb: /* @__PURE__ */ __name((p) => p.Water_Access || p.BAA_Alias, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.Latitude, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.Longitude, "lon"),
            meta: /* @__PURE__ */ __name((p) => ({ lanes: p.Launch_Lane_No, dock: p.Courtesy_Dock_No || p.Fix_Dock_No, fee: false, county: p.County, owner: p.Owner, motorRestrictions: p.Motorboats_Restricted }), "meta"),
            label: "NC Wildlife Resources Commission Boating Access Areas"
          }
        };
        const source = RAMP_SOURCES[state];
        if (!source) {
          return new Response(JSON.stringify({ error: `Unknown state: ${state}. Use SC, GA, or NC.` }), { headers: JSON_HEADERS, status: 400 });
        }
        if (!forceRefresh) {
          try {
            const cached = await env.R2_TROLLMAP_CHARTPACKS.get(cacheKey);
            if (cached) {
              const meta = cached.customMetadata || {};
              const fetchedAt = meta.fetchedAt ? new Date(meta.fetchedAt) : null;
              const ageMs = fetchedAt ? Date.now() - fetchedAt.getTime() : Infinity;
              if (ageMs < CACHE_TTL_DAYS * 24 * 60 * 60 * 1e3) {
                const body = await cached.text();
                return new Response(body, { headers: { ...JSON_HEADERS, "X-Cache": "HIT", "X-Cache-Age": String(Math.round(ageMs / 36e5)) + "h" } });
              }
            }
          } catch (_) {
          }
        }
        async function fetchAllRampFeatures(baseUrl, idField = "OBJECTID") {
          const allFeatures = [];
          let offset = 0;
          const pageSize2 = 1e3;
          while (true) {
            const params = new URLSearchParams({ outFields: "*", where: "1=1", f: "geojson", resultOffset: offset, resultRecordCount: pageSize2, orderByFields: idField });
            const resp = await fetch(`${baseUrl}?${params}`, {
              headers: { "User-Agent": "TrollMap/1.0 (Cloudflare Worker)", "Accept": "application/json" },
              cf: { cacheTtl: 0 }
            });
            if (!resp.ok) throw new Error(`ArcGIS HTTP ${resp.status}`);
            const data = await resp.json();
            const features = data.features || [];
            allFeatures.push(...features);
            if (features.length < pageSize2) break;
            offset += pageSize2;
          }
          return allFeatures;
        }
        __name(fetchAllRampFeatures, "fetchAllRampFeatures");
        try {
          const features = await fetchAllRampFeatures(source.url, source.idField);
          const waterbodies = {};
          for (const feat of features) {
            const p = feat.properties || {};
            if (!source.filter(p)) continue;
            const lat = parseFloat(source.lat(p));
            const lon = parseFloat(source.lon(p));
            if (!isFinite(lat) || !isFinite(lon) || lat === 0 || lon === 0) continue;
            const wb = (source.wb(p) || "Unknown").trim();
            const name = (source.name(p) || "Unknown").trim();
            if (!waterbodies[wb]) waterbodies[wb] = [];
            waterbodies[wb].push({ name, lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6, ...source.meta(p) });
          }
          for (const wb of Object.keys(waterbodies)) {
            waterbodies[wb].sort((a, b) => a.name.localeCompare(b.name));
          }
          const result = {
            state,
            source: source.label,
            fetched: (/* @__PURE__ */ new Date()).toISOString(),
            count: Object.values(waterbodies).reduce((s, r) => s + r.length, 0),
            waterbodyCount: Object.keys(waterbodies).length,
            waterbodies
          };
          const body = JSON.stringify(result);
          await env.R2_TROLLMAP_CHARTPACKS.put(cacheKey, body, {
            httpMetadata: { contentType: "application/json" },
            customMetadata: { fetchedAt: result.fetched, state, count: String(result.count) }
          });
          return new Response(body, { headers: { ...JSON_HEADERS, "X-Cache": "MISS", "X-Ramp-Count": String(result.count) } });
        } catch (err) {
          try {
            const stale = await env.R2_TROLLMAP_CHARTPACKS.get(cacheKey);
            if (stale) {
              const body = await stale.text();
              return new Response(body, { headers: { ...JSON_HEADERS, "X-Cache": "STALE", "X-Cache-Error": err.message } });
            }
          } catch (_) {
          }
          return new Response(JSON.stringify({ error: `Failed to fetch ${state} ramp data: ${err.message}` }), { headers: JSON_HEADERS, status: 502 });
        }
      }
      if (path === "/paddle") {
        const state = (url.searchParams.get("state") || "SC").toUpperCase();
        const forceRefresh = url.searchParams.has("refresh");
        const cacheKey = `paddle/${state.toLowerCase()}/paddle.json`;
        const CACHE_TTL_DAYS = 7;
        const PADDLE_SOURCES = {
          SC: {
            url: "https://services.arcgis.com/acgZYxoN5Oj8pDLa/arcgis/rest/services/South_Carolina_Public_Water_Access_PUBLIC_VIEW/FeatureServer/0/query",
            filter: /* @__PURE__ */ __name((p) => p.WaterAccessType === "Paddle Launch" && p.Status?.toLowerCase() === "active" && p.PublicAccess?.toLowerCase() !== "closed", "filter"),
            name: /* @__PURE__ */ __name((p) => p.WaterAccessName, "name"),
            wb: /* @__PURE__ */ __name((p) => p.Waterbody, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.Latitude, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.Longitude, "lon"),
            meta: /* @__PURE__ */ __name((p) => ({ subtype: p.WaterAccessSubType, county: p.County, owner: p.Owner }), "meta")
          },
          GA: {
            url: "https://services6.arcgis.com/9QlSLDqa0P1cHLhu/arcgis/rest/services/WRD_Water_Access_Points/FeatureServer/0/query",
            idField: "FID",
            // GA's objectIdFieldName is FID, not OBJECTID
            filter: /* @__PURE__ */ __name((p) => String(p.CanoeAcc || "").toLowerCase() === "y" && !["closed", "inactive"].includes(String(p.Status || "").toLowerCase()), "filter"),
            name: /* @__PURE__ */ __name((p) => p.Name, "name"),
            wb: /* @__PURE__ */ __name((p) => p.Waterbody, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.Latitude, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.Longitude, "lon"),
            meta: /* @__PURE__ */ __name((p) => ({ county: p.County, owner: p.Owner }), "meta")
          },
          NC: {
            url: "https://services1.arcgis.com/YfqBAUM5nWR3yhGP/arcgis/rest/services/NCWRC_Boating_Access_Areas_view/FeatureServer/0/query",
            filter: /* @__PURE__ */ __name((p) => (String(p.Non_Motorized_Access || "").toLowerCase() === "yes" || String(p.Portable_Boat_Access_Type || "").length > 0) && String(p.Site_Status || "").toLowerCase() === "open", "filter"),
            name: /* @__PURE__ */ __name((p) => p.BAA_Name, "name"),
            wb: /* @__PURE__ */ __name((p) => p.Water_Access, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.Latitude, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.Longitude, "lon"),
            meta: /* @__PURE__ */ __name((p) => ({ type: p.Portable_Boat_Access_Type, county: p.County, owner: p.Owner }), "meta")
          }
        };
        const source = PADDLE_SOURCES[state];
        if (!source) return new Response(JSON.stringify({ error: `Unknown state: ${state}` }), { headers: JSON_HEADERS, status: 400 });
        if (!forceRefresh) {
          const cached = await env.R2_TROLLMAP_CHARTPACKS.get(cacheKey);
          if (cached) {
            const ageDays = (Date.now() - new Date(cached.uploaded).getTime()) / 864e5;
            if (ageDays < CACHE_TTL_DAYS) {
              return new Response(await cached.text(), { headers: { ...JSON_HEADERS, "X-Cache": "HIT", "X-Cache-Age-Days": ageDays.toFixed(1) } });
            }
          }
        }
        try {
          let allFeatures = [];
          let offset = 0;
          const idField = source.idField || "OBJECTID";
          while (true) {
            const params = new URLSearchParams({ outFields: "*", where: "1=1", f: "geojson", resultOffset: offset, resultRecordCount: 1e3, orderByFields: idField });
            const resp = await fetch(`${source.url}?${params.toString()}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            if (data.features) allFeatures.push(...data.features);
            if (!data.features || data.features.length < pageSize) break;
            offset += 1e3;
          }
          const waterbodies = {};
          for (const feat of allFeatures) {
            const p = feat.properties || {};
            if (!source.filter(p)) continue;
            let wb = String(source.wb(p) || "Unknown Waterbody").trim() || "Unknown Waterbody";
            let name = String(source.name(p) || "Unnamed Launch").trim();
            const lat = Number(source.lat(p) || feat.geometry?.coordinates?.[1]);
            const lon = Number(source.lon(p) || feat.geometry?.coordinates?.[0]);
            if (!lat || !lon || isNaN(lat) || isNaN(lon)) continue;
            if (!waterbodies[wb]) waterbodies[wb] = [];
            waterbodies[wb].push({ name, lat, lon, meta: source.meta(p) });
          }
          const result = { state, source: source.url, count: Object.values(waterbodies).flat().length, waterbodies };
          const body = JSON.stringify(result);
          await env.R2_TROLLMAP_CHARTPACKS.put(cacheKey, body, { customMetadata: { uploaded: (/* @__PURE__ */ new Date()).toISOString() } });
          return new Response(body, { headers: { ...JSON_HEADERS, "X-Cache": "MISS" } });
        } catch (err) {
          return new Response(JSON.stringify({ error: err.message }), { headers: JSON_HEADERS, status: 502 });
        }
      }
      if (path === "/bank-pier") {
        const state = (url.searchParams.get("state") || "SC").toUpperCase();
        const forceRefresh = url.searchParams.has("refresh");
        const cacheKey = `bankpier/${state.toLowerCase()}/bankpier.json`;
        const CACHE_TTL_DAYS = 7;
        const BANKPIER_SOURCES = {
          SC: {
            url: "https://services.arcgis.com/acgZYxoN5Oj8pDLa/arcgis/rest/services/South_Carolina_Public_Water_Access_PUBLIC_VIEW/FeatureServer/0/query",
            filter: /* @__PURE__ */ __name((p) => (p.WaterAccessType === "Bank" || p.WaterAccessType === "Pier" || String(p.FishingPier || "").toLowerCase() === "yes") && p.Status?.toLowerCase() === "active" && p.PublicAccess?.toLowerCase() !== "closed", "filter"),
            name: /* @__PURE__ */ __name((p) => p.WaterAccessName, "name"),
            wb: /* @__PURE__ */ __name((p) => p.Waterbody, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.Latitude, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.Longitude, "lon"),
            meta: /* @__PURE__ */ __name((p) => ({ type: p.WaterAccessType, pier: p.FishingPier }), "meta")
          },
          GA: {
            url: "https://services6.arcgis.com/9QlSLDqa0P1cHLhu/arcgis/rest/services/WRD_Water_Access_Points/FeatureServer/0/query",
            idField: "FID",
            // GA's objectIdFieldName is FID, not OBJECTID
            filter: /* @__PURE__ */ __name((p) => (String(p.BankFish || "").toLowerCase() === "y" || String(p.PierFish || "").toLowerCase() === "y") && !["closed", "inactive"].includes(String(p.Status || "").toLowerCase()), "filter"),
            name: /* @__PURE__ */ __name((p) => p.Name, "name"),
            wb: /* @__PURE__ */ __name((p) => p.Waterbody, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.Latitude, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.Longitude, "lon"),
            meta: /* @__PURE__ */ __name((p) => ({ bankFish: p.BankFish, pierFish: p.PierFish }), "meta")
          },
          NC: {
            url: "https://services1.arcgis.com/YfqBAUM5nWR3yhGP/arcgis/rest/services/NCWRC_Public_Fishing_Areas_view/FeatureServer/0/query",
            filter: /* @__PURE__ */ __name((p) => String(p.Site_Status || "").toLowerCase() === "open", "filter"),
            name: /* @__PURE__ */ __name((p) => p.PFA_Name, "name"),
            wb: /* @__PURE__ */ __name((p) => p.Water_Access, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.Latitude, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.Longitude, "lon"),
            meta: /* @__PURE__ */ __name((p) => ({ pier: p.Fishing_Pier, bank: p.Bank_Access }), "meta")
          }
        };
        const source = BANKPIER_SOURCES[state];
        if (!source) return new Response(JSON.stringify({ error: `Unknown state: ${state}` }), { headers: JSON_HEADERS, status: 400 });
        if (!forceRefresh) {
          const cached = await env.R2_TROLLMAP_CHARTPACKS.get(cacheKey);
          if (cached) {
            const ageDays = (Date.now() - new Date(cached.uploaded).getTime()) / 864e5;
            if (ageDays < CACHE_TTL_DAYS) {
              return new Response(await cached.text(), { headers: { ...JSON_HEADERS, "X-Cache": "HIT", "X-Cache-Age-Days": ageDays.toFixed(1) } });
            }
          }
        }
        try {
          let allFeatures = [];
          let offset = 0;
          const idField = source.idField || "OBJECTID";
          while (true) {
            const params = new URLSearchParams({ outFields: "*", where: "1=1", f: "geojson", resultOffset: offset, resultRecordCount: 1e3, orderByFields: idField });
            const resp = await fetch(`${source.url}?${params.toString()}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            if (data.features) allFeatures.push(...data.features);
            if (!data.features || data.features.length < pageSize) break;
            offset += 1e3;
          }
          const waterbodies = {};
          for (const feat of allFeatures) {
            const p = feat.properties || {};
            if (!source.filter(p)) continue;
            let wb = String(source.wb(p) || "Unknown Waterbody").trim() || "Unknown Waterbody";
            let name = String(source.name(p) || "Unnamed Spot").trim();
            const lat = Number(source.lat(p) || feat.geometry?.coordinates?.[1]);
            const lon = Number(source.lon(p) || feat.geometry?.coordinates?.[0]);
            if (!lat || !lon || isNaN(lat) || isNaN(lon)) continue;
            if (!waterbodies[wb]) waterbodies[wb] = [];
            waterbodies[wb].push({ name, lat, lon, meta: source.meta(p) });
          }
          for (const wb of Object.keys(waterbodies)) waterbodies[wb].sort((a, b) => a.name.localeCompare(b.name));
          const result = { state, source: source.url, count: Object.values(waterbodies).flat().length, waterbodies };
          const body = JSON.stringify(result);
          await env.R2_TROLLMAP_CHARTPACKS.put(cacheKey, body, { customMetadata: { uploaded: (/* @__PURE__ */ new Date()).toISOString() } });
          return new Response(body, { headers: { ...JSON_HEADERS, "X-Cache": "MISS" } });
        } catch (err) {
          return new Response(JSON.stringify({ error: err.message }), { headers: JSON_HEADERS, status: 502 });
        }
      }
      if (path === "/attractors") {
        const state = (url.searchParams.get("state") || "SC").toUpperCase();
        const forceRefresh = url.searchParams.has("refresh");
        const cacheKey = `attractors/${state.toLowerCase()}/attractors.json`;
        const CACHE_TTL_DAYS = 7;
        const ATTRACTOR_SOURCES = {
          SC: {
            url: "https://services.arcgis.com/acgZYxoN5Oj8pDLa/arcgis/rest/services/SCDNR_Freshwater_Fish_Attractors_Public_Web_App/FeatureServer/0/query",
            filter: /* @__PURE__ */ __name((p) => true, "filter"),
            // All records in this DB are attractors
            name: /* @__PURE__ */ __name((p) => p.FishAttractorName, "name"),
            wb: /* @__PURE__ */ __name((p) => p.Waterbody, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.lat_dd, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.lon_dd, "lon"),
            type: /* @__PURE__ */ __name((p) => p.Material, "type")
          },
          GA: {
            url: "https://services6.arcgis.com/9QlSLDqa0P1cHLhu/arcgis/rest/services/Fish_Attractors_for_Download/FeatureServer/0/query",
            // NOTE: different GA feature service than /ramps, /paddle, /bank-pier
            // (which all use WRD_Water_Access_Points, confirmed idField: FID).
            // This one hasn't been checked against its own schema — don't assume
            // FID applies here too. If this route also returns 0 for GA, query
            // this service's outFields=* first to confirm its real
            // objectIdFieldName before guessing at an idField override.
            filter: /* @__PURE__ */ __name((p) => true, "filter"),
            name: /* @__PURE__ */ __name((p) => p.note, "name"),
            wb: /* @__PURE__ */ __name((p) => p.waterbody, "wb"),
            lat: /* @__PURE__ */ __name((p) => null, "lat"),
            // We pull from geometry
            lon: /* @__PURE__ */ __name((p) => null, "lon"),
            type: /* @__PURE__ */ __name((p) => `${p.attractor_code || ""} ${p.attractor_code_other || ""}`.trim(), "type")
          },
          NC: {
            url: "https://services1.arcgis.com/YfqBAUM5nWR3yhGP/arcgis/rest/services/Fish_Attractors_public_view/FeatureServer/0/query",
            filter: /* @__PURE__ */ __name((p) => true, "filter"),
            name: /* @__PURE__ */ __name((p) => `${p.Waterbody} Attractor`, "name"),
            // NC doesn't have names, just types
            wb: /* @__PURE__ */ __name((p) => p.Waterbody, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.Latitude, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.Longitude, "lon"),
            type: /* @__PURE__ */ __name((p) => `${p.Structure1 || ""} ${p.Structure2 || ""}`.trim() || p.Attractor_Type, "type")
          }
        };
        const source = ATTRACTOR_SOURCES[state];
        if (!source) return new Response(JSON.stringify({ error: `Unknown state: ${state}` }), { headers: JSON_HEADERS, status: 400 });
        if (!forceRefresh) {
          const cached = await env.R2_TROLLMAP_CHARTPACKS.get(cacheKey);
          if (cached) {
            const ageDays = (Date.now() - new Date(cached.uploaded).getTime()) / 864e5;
            if (ageDays < CACHE_TTL_DAYS) {
              return new Response(await cached.text(), { headers: { ...JSON_HEADERS, "X-Cache": "HIT", "X-Cache-Age-Days": ageDays.toFixed(1) } });
            }
          }
        }
        try {
          let allFeatures = [];
          let offset = 0;
          while (true) {
            const params = new URLSearchParams({ outFields: "*", where: "1=1", f: "geojson", resultOffset: offset, resultRecordCount: 1e3, orderByFields: "OBJECTID" });
            const resp = await fetch(`${source.url}?${params.toString()}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            if (data.features) allFeatures.push(...data.features);
            if (!data.features || data.features.length < 1e3) break;
            offset += 1e3;
          }
          const waterbodies = {};
          for (const feat of allFeatures) {
            const p = feat.properties || {};
            if (!source.filter(p)) continue;
            let wb = String(source.wb(p) || "Unknown Waterbody").trim() || "Unknown Waterbody";
            let name = String(source.name(p) || "Attractor").trim() || "Attractor";
            const lat = Number(source.lat(p) || feat.geometry?.coordinates?.[1]);
            const lon = Number(source.lon(p) || feat.geometry?.coordinates?.[0]);
            if (!lat || !lon || isNaN(lat) || isNaN(lon)) continue;
            if (!waterbodies[wb]) waterbodies[wb] = [];
            waterbodies[wb].push({ name, lat, lon, type: String(source.type(p) || "Unknown").trim() });
          }
          for (const wb of Object.keys(waterbodies)) waterbodies[wb].sort((a, b) => a.name.localeCompare(b.name));
          const result = { state, source: source.url, count: Object.values(waterbodies).flat().length, waterbodies };
          const body = JSON.stringify(result);
          await env.R2_TROLLMAP_CHARTPACKS.put(cacheKey, body, { customMetadata: { uploaded: (/* @__PURE__ */ new Date()).toISOString() } });
          return new Response(body, { headers: { ...JSON_HEADERS, "X-Cache": "MISS" } });
        } catch (err) {
          return new Response(JSON.stringify({ error: err.message }), { headers: JSON_HEADERS, status: 502 });
        }
      }
      if (path === "/duke" || url.searchParams.has("duke")) {
        const format = (url.searchParams.get("format") || "text").toLowerCase();
        const d = await fetchDukeDashboard(url.searchParams.get("basin") || "1");
        if (!d) {
          return new Response(JSON.stringify({ error: "Duke API unreachable" }), { headers: JSON_HEADERS, status: 502 });
        }
        if (format === "json") {
          return new Response(JSON.stringify(d.json, null, 2), { headers: { ...JSON_HEADERS, "X-Source": d.url } });
        }
        return new Response(d.text, { headers: { ...TEXT_HEADERS, "X-Source": d.url } });
      }
      if (path === "/usgs") {
        const site = url.searchParams.get("site");
        const params = url.searchParams.get("params") || "00010,00065";
        if (!site) return new Response('{"error":"missing site"}', { headers: JSON_HEADERS, status: 400 });
        const r = await fetch(`https://waterservices.usgs.gov/nwis/iv/?sites=${site}&parameterCd=${params}&format=json&period=P2D`);
        const t = await r.text();
        return new Response(t, { headers: JSON_HEADERS, status: r.status });
      }
      if (path === "/lake-clarity") {
        const name = url.searchParams.get("lake") || url.searchParams.get("waterbody") || "";
        const dateParam = url.searchParams.get("date") || (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
        if (!name) return new Response(JSON.stringify({ error: "missing lake" }), { headers: JSON_HEADERS, status: 400 });
        const data = await getLakeClarity(name, dateParam);
        return new Response(JSON.stringify(data, null, 2), { headers: JSON_HEADERS });
      }
      if (path === "/lake-intel-sources") {
        const name = url.searchParams.get("lake") || "";
        if (name) {
          const key = lakeKeyFromName(name);
          return new Response(JSON.stringify({ key, registry: getLakeIntelSourceRegistry(key) }, null, 2), { headers: JSON_HEADERS });
        }
        return new Response(JSON.stringify(LAKE_INTEL_SOURCE_REGISTRY, null, 2), { headers: JSON_HEADERS });
      }
      if (path === "/lake-intel") {
        const name = url.searchParams.get("lake") || url.searchParams.get("waterbody") || "";
        if (!name) return new Response(JSON.stringify({ error: "missing lake" }), { headers: JSON_HEADERS, status: 400 });
        const intel = await getLakeIntel(name);
        return new Response(JSON.stringify(intel, null, 2), { headers: JSON_HEADERS });
      }
      if (path === "/river" || url.searchParams.has("river")) {
        const r = (url.searchParams.get("river") || "").toLowerCase();
        if (!r) {
          return new Response(JSON.stringify({
            error: "missing river",
            available: Object.keys(RIVERS)
          }), { headers: JSON_HEADERS, status: 400 });
        }
        const key = Object.keys(RIVERS).find((k) => r.includes(k) || k.includes(r));
        if (!key) {
          return new Response(JSON.stringify({
            error: `unknown river: ${r}`,
            available: Object.keys(RIVERS)
          }), { headers: JSON_HEADERS, status: 404 });
        }
        const userLat = parseFloat(url.searchParams.get("lat"));
        const userLon = parseFloat(url.searchParams.get("lon"));
        const opts = isFinite(userLat) && isFinite(userLon) ? { userLat, userLon } : {};
        const data = await getRiver(key, opts);
        return new Response(JSON.stringify(data, null, 2), { headers: JSON_HEADERS });
      }
      if (path === "/duke-flow-arrivals") {
        const basin = url.searchParams.get("basin") || "1";
        const sched = await fetchDukeFlowArrivals(basin);
        if (!sched) return new Response(JSON.stringify({ error: "Duke flow-arrivals unavailable", basin }), { headers: JSON_HEADERS, status: 502 });
        return new Response(JSON.stringify(sched, null, 2), { headers: JSON_HEADERS });
      }
      if (path === "/dominion-saluda") {
        const status = await fetchDominionSaludaStatus();
        if (!status) return new Response(JSON.stringify({ error: "Dominion Saluda page unavailable" }), { headers: JSON_HEADERS, status: 502 });
        return new Response(JSON.stringify(status, null, 2), { headers: JSON_HEADERS });
      }
      if (path === "/rivers") {
        const list = Object.entries(RIVERS).map(([k, v]) => ({
          key: k,
          label: v.label,
          operator: v.operator,
          dam: v.damName,
          primaryGauge: (v.gauges.find((g) => g.primary) || v.gauges[0]).site
        }));
        return new Response(JSON.stringify(list, null, 2), { headers: JSON_HEADERS });
      }
      if (path === "/lake" || lake) {
        if (!lake) return new Response('{"error":"missing lake"}', { headers: JSON_HEADERS, status: 400 });
        const result = await resolveLake(lake);
        return new Response(JSON.stringify(result, null, 2), { headers: JSON_HEADERS });
      }
      if (path.startsWith("/sync")) {
        if (!env.DB) return new Response(JSON.stringify({ error: "D1 not configured" }), { headers: JSON_HEADERS, status: 503 });
        if (!await isAuthorized(request, env)) {
          return new Response(JSON.stringify({ error: "unauthorized" }), { headers: JSON_HEADERS, status: 401 });
        }
        try {
          if (path === "/sync/migrate" && request.method === "POST") {
            return await handleSyncMigrate(request, env);
          }
          const purgeMatch = path.match(/^\/sync\/purge-type\/([^\/]+)$/);
          if (purgeMatch && request.method === "DELETE") {
            const pType = purgeMatch[1];
            await ensureSyncSchema(env.DB);
            await env.DB.prepare("DELETE FROM sync_items WHERE type = ?1").bind(pType).run();
            return new Response(JSON.stringify({ ok: true, purged: pType }), { headers: JSON_HEADERS });
          }
          if (path === "/sync/list-updates" && request.method === "GET") {
            return await handleSyncListUpdates(url, env);
          }
          const itemMatch = path.match(/^\/sync\/item\/([^\/]+)\/(.+)$/);
          if (itemMatch) {
            const [, type, id] = itemMatch;
            if (request.method === "POST") return await handleSyncPush(request, env, type, id);
            if (request.method === "GET") return await handleSyncGet(env, type, id);
            if (request.method === "DELETE") return await handleSyncDelete(env, type, id);
          }
          const keyMatch = path.match(/^\/sync\/item\/(.+)$/);
          if (keyMatch && request.method === "GET") {
            const parts = keyMatch[1].split("/");
            const type = parts[0];
            const id = parts.slice(1).join("/");
            return await handleSyncGet(env, type, id);
          }
          return new Response(JSON.stringify({ error: "unknown sync route" }), { headers: JSON_HEADERS, status: 404 });
        } catch (syncErr) {
          return new Response(JSON.stringify({ error: `sync error: ${syncErr.message}` }), { headers: JSON_HEADERS, status: 500 });
        }
      }
      const contourMatch = path.match(/^\/contours\/([^\/]+)\/geojson$/);
      if (contourMatch) {
        const lakeArg = contourMatch[1];
        if (request.method === "GET") return handleContourGeojsonGet(env, lakeArg);
        if (request.method === "POST" || request.method === "PUT") {
          if (!await isAuthorized(request, env)) {
            return new Response(JSON.stringify({ error: "unauthorized" }), { headers: JSON_HEADERS, status: 401 });
          }
          return handleContourGeojsonPut(request, env, lakeArg);
        }
      }
      if (path === "/chartpacks/list") {
        const data = await handleChartpackList(env);
        return new Response(JSON.stringify(data, null, 2), { headers: JSON_HEADERS });
      }
      const idxMatch = path.match(/^\/chartpacks\/([^/]+)\/index\.json$/);
      if (idxMatch) {
        const lakeName = idxMatch[1];
        const prefix = chartpackKey(lakeName, "");
        const listed = await env.R2_TROLLMAP_CHARTPACKS.list({ prefix });
        const tiles = /* @__PURE__ */ new Set();
        let totalBytes = 0;
        for (const obj of listed.objects) {
          const fname = obj.key.slice(prefix.length);
          totalBytes += obj.size || 0;
          const m = fname.match(/(?:^|\/)iboating_R(\d{3})_C(\d{3})_contours\.georef\.json$/i);
          if (m) tiles.add(`iboating_R${m[1]}_C${m[2]}`);
        }
        return new Response(JSON.stringify({
          lake: lakeName,
          tiles: [...tiles].sort(),
          total_bytes: totalBytes
        }), { headers: { ...CORS, ...JSON_HEADERS, "Cache-Control": "no-store" } });
      }
      const cpMatch = path.match(/^\/chartpacks\/([^/]+)\/(.+)$/);
      if (cpMatch) {
        const [, lakeName, file] = cpMatch;
        const key = chartpackKey(lakeName, file);
        if (request.method === "GET") {
          const obj = await env.R2_TROLLMAP_CHARTPACKS.get(key);
          if (!obj) return new Response('{"error":"not found"}', { headers: JSON_HEADERS, status: 404 });
          let ct = "application/octet-stream";
          if (file.endsWith(".png")) ct = "image/png";
          else if (file.endsWith(".json")) ct = "application/json";
          const headers = { ...CORS, "Content-Type": ct, "Cache-Control": "no-store" };
          return new Response(obj.body, { headers });
        }
        if (request.method === "POST") {
          if (!await isAuthorized(request, env)) {
            return new Response('{"error":"unauthorized"}', { headers: JSON_HEADERS, status: 401 });
          }
          const buf = await request.arrayBuffer();
          if (!buf || buf.byteLength === 0) {
            return new Response('{"error":"empty body"}', { headers: JSON_HEADERS, status: 400 });
          }
          await env.R2_TROLLMAP_CHARTPACKS.put(key, buf, {
            httpMetadata: {
              contentType: file.endsWith(".png") ? "image/png" : "application/json",
              cacheControl: "public, max-age=3600"
            }
          });
          return new Response(JSON.stringify({ uploaded: key, bytes: buf.byteLength }), { headers: JSON_HEADERS });
        }
        return new Response('{"error":"method not allowed"}', { headers: JSON_HEADERS, status: 405 });
      }
      return new Response(JSON.stringify({
        ok: true,
        worker: "trollmap-worker",
        version: 13,
        routes: [
          "/sync/item/:type/:id               \u2014 push/get/delete a sync item (auth required)",
          "/sync/list-updates?since=<ts>      \u2014 delta list for cross-device sync (auth required)",
          "/sync/migrate                      \u2014 bulk import all local data (auth required)",
          "/contours/:lake/geojson            \u2014 serve/upload vectorized contour GeoJSON",
          "/duke?basin=1|2|3                      \u2014 raw Duke lake levels",
          "/lake?lake=wateree                     \u2014 unified lake JSON",
          "/lake-clarity?lake=wateree&date=YYYY-MM-DD \u2014 runoff clarity/ramp/lure forecast",
          "/lake-intel-sources?lake=wateree       \u2014 trust-tier source registry",
          "/lake-intel?lake=murray|marion|wateree    \u2014 fisherman lake profile + latest report scrape",
          "/river?river=wateree|congaree|saluda|broad|santee|cooper",
          "/rivers                                \u2014 list all rivers",
          "/duke-flow-arrivals?basin=1|2|3|6|10|11 \u2014 raw Duke scheduled dam releases",
          "/dominion-saluda                       \u2014 raw Dominion color-coded status",
          "/usgs?site=...&params=...              \u2014 raw USGS pass-through",
          "/chartpacks/list                       \u2014 list all uploaded chartpack lakes",
          "/chartpacks/<lake>/<file>             \u2014 serve or upload chartpack file"
        ]
      }, null, 2), { headers: JSON_HEADERS });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { headers: JSON_HEADERS, status: 500 });
    }
  }
};
export {
  trollmap_worker_default as default
};
//# sourceMappingURL=trollmap-worker.js.map
