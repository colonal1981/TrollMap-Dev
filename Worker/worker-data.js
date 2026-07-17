var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker-data.js — Static lake/river data extracted from trollmap-worker.js
// LAKES, LAKE_INTEL, LAKE_INTEL_SOURCE_REGISTRY, LAKEMONSTER_IDS, LAKE_CLARITY_PROFILES, RIVERS

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
    cf: { cacheTtl: 900, cacheEverything: true },
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
    const r = await fetch(jsonUrl, { cf: { cacheTtl: 900 } });
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
    const r = await fetch(rdbUrl, { cf: { cacheTtl: 900 } });
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
      cf: { cacheTtl: 900, cacheEverything: true },
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

// Query the USACE Corps Water Management System (CWMS) Data API for the
// latest reservoir elevation for a given lake. Falls back to a location-name
// search against /locations if no specific CWMS location ID is configured.
async function fetchCwmsLakeLevel(lakeName, lakeKey) {
  const base = 'https://cwms-data.usace.army.mil/cwms-data';
  const nameFrag = String(lakeName || lakeKey || '')
    .replace(/^lake\s+/i, '')
    .replace(/,\s*(sc|nc|ga)(\/(sc|nc|ga))?\s*$/i, '')
    .trim();
  if (!nameFrag) return null;

  // Known CWMS location IDs for tristate USACE lakes (Savannah District).
  // These are the official CWMS location names used by the district.
  const CWMS_LOCATIONS = {
    hartwell: 'Hartwell',
    russell: 'Russell',
    thurmond: 'Thurmond',
    'clarks hill': 'Thurmond',
    'clark hill': 'Thurmond',
    'j strom thurmond': 'Thurmond'
  };

  const locId = CWMS_LOCATIONS[lakeKey] || CWMS_LOCATIONS[nameFrag.toLowerCase()];

  // Try the configured location ID first.
  if (locId) {
    try {
      // Latest value endpoint for the elevation time series.
      const tsUrl = `${base}/timeseries?name=${encodeURIComponent(locId)}.Elev.Inst.0.0.USACE-RAW&office=SA&unit=ft`;
      const r = await fetch(tsUrl, {
        headers: { 'User-Agent': 'TrollMap/16 Worker', 'Accept': 'application/json' },
        cf: { cacheTtl: 900 }
      });
      if (r.ok) {
        const j = await r.json();
        // CWMS CDA response shape: { values: [[dateTs, value, quality]], ... }
        const vals = j?.values || j?.value?.values || [];
        if (vals.length) {
          const latest = vals[vals.length - 1];
          const elevation = parseFloat(latest[1]);
          if (isFinite(elevation)) {
            return {
              elevation_ft: elevation,
              source: tsUrl,
              location: locId,
              timestamp: latest[0] || null,
              method: 'cwms_cda_timeseries'
            };
          }
        }
      }
    } catch (e) {
      console.warn(`CWMS configured-location fetch failed for ${locId}: ${e.message}`);
    }
  }

  // Fallback: search /locations for the lake name and return the first match.
  try {
    const searchUrl = `${base}/locations?name=${encodeURIComponent(nameFrag)}&office=SA`;
    const r = await fetch(searchUrl, {
      headers: { 'User-Agent': 'TrollMap/16 Worker', 'Accept': 'application/json' },
      cf: { cacheTtl: 86400 }
    });
    if (r.ok) {
      const j = await r.json();
      const locations = j?.locations || j || [];
      const match = locations.find(loc => {
        const n = String(loc?.name || loc?.location_id || loc?.id || '').toLowerCase();
        return n.includes(nameFrag.toLowerCase()) || n.includes(String(lakeKey || '').toLowerCase());
      });
      if (match) {
        const matchedName = match.name || match.location_id || match.id;
        const tsUrl = `${base}/timeseries?name=${encodeURIComponent(matchedName)}.Elev.Inst.0.0.USACE-RAW&office=SA&unit=ft`;
        try {
          const tsR = await fetch(tsUrl, {
            headers: { 'User-Agent': 'TrollMap/16 Worker', 'Accept': 'application/json' },
            cf: { cacheTtl: 900 }
          });
          if (tsR.ok) {
            const tsJ = await tsR.json();
            const vals = tsJ?.values || tsJ?.value?.values || [];
            if (vals.length) {
              const latest = vals[vals.length - 1];
              const elevation = parseFloat(latest[1]);
              if (isFinite(elevation)) {
                return {
                  elevation_ft: elevation,
                  source: tsUrl,
                  location: matchedName,
                  timestamp: latest[0] || null,
                  method: 'cwms_cda_search'
                };
              }
            }
          }
        } catch (e2) {
          console.warn(`CWMS fallback timeseries fetch failed for ${matchedName}: ${e2.message}`);
        }
      }
    }
  } catch (e) {
    console.warn(`CWMS location search failed for ${nameFrag}: ${e.message}`);
  }

  return null;
}
__name(fetchCwmsLakeLevel, "fetchCwmsLakeLevel");
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
        "label": "SCDNR Freshwater Size & Possession Limits (eRegulations)",
        "url": "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits",
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
        "label": "SCDNR Freshwater Size & Possession Limits (eRegulations)",
        "url": "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits",
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
        "label": "SCDNR Freshwater Size & Possession Limits (eRegulations)",
        "url": "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits",
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
        "label": "SCDNR Freshwater Size & Possession Limits (eRegulations)",
        "url": "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits",
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
        "label": "SCDNR Freshwater Size & Possession Limits (eRegulations)",
        "url": "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits",
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
        "label": "SCDNR Freshwater Size & Possession Limits (eRegulations)",
        "url": "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits",
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
        "label": "SCDNR / GA DNR Freshwater Regs (eRegulations)",
        "url": "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits",
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
        "label": "SCDNR / GA DNR Freshwater Regs (eRegulations)",
        "url": "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits",
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
        "label": "SCDNR / GA DNR Freshwater Regs (eRegulations)",
        "url": "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits",
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
        "label": "SCDNR Freshwater Size & Possession Limits (eRegulations)",
        "url": "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits",
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
    monticello: "monticello",
    greenwood: "greenwood",
    secession: "secession",
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
    { label: "State fisheries / regulations", url: "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits" }
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

export { LAKES, LAKE_INTEL, LAKE_INTEL_SOURCE_REGISTRY, LAKEMONSTER_IDS, LAKE_CLARITY_PROFILES, RIVERS, lakeKeyFromName, fetchText, fetchUsgs, fetchAhqWaterTemp, fetchAhqFishingReport, fetchLakeMonsterIntel, getLakeIntel, getLakeClarity, getLakeIntelSourceRegistry, getDukeLake, fetchSanteeCooper, fetchUsaceSavannah, fetchCwmsLakeLevel, fetchDukeDashboard };