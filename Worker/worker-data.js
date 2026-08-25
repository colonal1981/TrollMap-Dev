
// worker-data.js — Static lake/river data extracted from trollmap-worker.js
// LAKES, LAKE_INTEL, LAKE_INTEL_SOURCE_REGISTRY, LAKEMONSTER_IDS, LAKE_CLARITY_PROFILES, RIVERS

import { matchWaterName, reportTokens } from './reports.js';

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
// WHICH SENSOR, WHEN A SITE HAS TWO.
//
// Ten of the sites this app binds publish MORE THAN ONE live series on a parameter code it
// maps, and until now the winner was decided by arrival order -- the JSON loop below kept the
// LAST series it saw and the RDB loop below that kept the FIRST, so the two paths disagreed
// with each other and neither one chose on any principle. Measured 2026-08-25 against the
// state series catalogues already cached for the binder, and confirmed against USGS's own
// monitoring-location payload for the two waters where it costs something today:
//
//   Lake Murray (Lexington Co, SC)      02168500   00010, 00300   'TOP' and 'BOTTOM'
//   Lake Marion (Clarendon Co, SC)      02169921   00062          '[NAVD88]' and '[NGVD29]'
//   Charleston Harbor, SC               021720712  00065          '' and 'AUX'
//   Rediversion Canal nr St Stephen SC  02171637   00010, 00300   'TOP' and 'BOTTOM'
//   Cooper R at Hwy 17 / Pier K / Wando / Savannah R at Garden City -- same shape.
//
// Two live consequences. On Lake Marion the coin flip is between two VERTICAL DATUMS about a
// foot apart, on the pool number itself. And the parameter selection was just widened, so a
// bound site carrying a TOP and a BOTTOM thermistor was about to start answering "what is the
// surface temperature" with a bottom reading, half the time, with nothing on screen to say so.
//
// USGS states which sensor a series came from, in the same words in both formats: the JSON
// carries it at values[].method[].methodDescription, and the RDB carries it in the
// "TS_ID Parameter Description" comment block this file used to discard with the rest of the
// '#' lines. Both are the `loc_web_ds` string from the site catalogue.
const SUBLOC_TOP = /\b(TOP|SURFACE|SURF)\b/i;
const SUBLOC_MIDDLE = /\bMID(DLE)?\b/i;
const SUBLOC_BOTTOM = /\bBOT(TOM)?\b/i;
const SUBLOC_NAVD88 = /NAVD\s*-?\s*88/i;
const SUBLOC_AUX = /\bAUX(ILIARY)?\b/i;
// Codes measured through the water column, where the sensor's depth changes the answer.
const COLUMN_PARMS = new Set(["00010", "00300", "00095", "00480", "63680"]);
// Codes that are a water-surface elevation, where the descriptor names a vertical datum.
const ELEV_PARMS = new Set(["00062", "62614", "62615"]);

/**
 * Lower is preferred. A site with one series always scores 0 and is unaffected.
 *
 * Column parameters rank surface-first, because the question this app asks is what the fish
 * are in, and that is the top of the column. Bottom is kept rather than discarded -- it is a
 * real reading and on a shallow tidal river it may be the only one -- but it never beats a
 * surface sensor that is also reporting.
 *
 * Elevation prefers the series WITHOUT a NAVD88 tag. That is a continuity decision, not a
 * geodetic one: Lake Marion's legacy series has fed this app's pool comparison since the app
 * existed, `normalPool` is stated against it, and NAVD88 sits about a foot below NGVD29 in the
 * lower Santee. Silently switching datum would move the displayed pool by a foot with no code
 * change to point at. The NAVD88 series is not thrown away -- fetchUsgs routes it to
 * `elevationNavd88`, which already has readers.
 *
 * An AUX gage-height sensor is a backup for the primary and loses to it.
 */
function seriesRank(code, desc) {
  const d = String(desc || "").trim();
  if (COLUMN_PARMS.has(code)) {
    if (SUBLOC_TOP.test(d)) return 0;
    if (!d) return 1;
    if (SUBLOC_BOTTOM.test(d)) return 4;
    if (SUBLOC_MIDDLE.test(d)) return 3;
    return 2;
  }
  if (ELEV_PARMS.has(code)) {
    // Untagged first. An untagged elevation series is the site's plain pool reading; a tagged
    // one is a named structure -- Lake Murray publishes an "Emergency Spillway (ES)" series on
    // 00062 -- and a spillway is not the lake.
    if (!d) return 0;
    return SUBLOC_NAVD88.test(d) ? 2 : 1;
  }
  if (SUBLOC_AUX.test(d)) return 2;
  return d ? 1 : 0;
}

/** The newer of two USGS timestamps, either of which may be missing or unparseable. */
function newerStamp(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!isFinite(ta)) return b;
  if (!isFinite(tb)) return a;
  return tb > ta ? b : a;
}

/**
 * TS_ID -> description, read from the RDB comment block. The RDB names its value columns
 * `<ts_id>_<parm_cd>`, so this is the only way that format can tell a TOP thermistor from a
 * BOTTOM one, and the lines it lives on were being filtered out before anything looked at them.
 */
function rdbSeriesDescriptions(text) {
  const map = {};
  for (const line of String(text || "").split("\n")) {
    if (!line.startsWith("#")) continue;
    const m = line.match(/^#\s+(\d+)\s+(\d{5})\s+(.*)$/);
    if (m) map[m[1]] = m[3].trim();
  }
  return map;
}
async function fetchUsgs(site, paramCd, periodDays = 2) {
  const out = {};
  const jsonUrl = `https://waterservices.usgs.gov/nwis/iv/?sites=${site}&parameterCd=${paramCd}&format=json&period=P${periodDays}D`;
  try {
    const r = await fetch(jsonUrl, { cf: { cacheTtl: 900 } });
    if (r.ok) {
      const j = await r.json();
      // Collect first, choose second. Assigning inside the loop is what let arrival order pick
      // the sensor; a site with one series per code lands here unchanged.
      const best = new Map();
      let navd88Elev = null;
      for (const ts of j?.value?.timeSeries || []) {
        const code = ts?.variable?.variableCode?.[0]?.value;
        // ONE LETTER, AND THIS WHOLE BRANCH HAS NEVER RETURNED A READING.
        //
        // WaterML nests the points at values[0].VALUE -- an array of {value, dateTime,
        // qualifiers} -- and this line asked for values[0].values, which does not exist. `vals`
        // was [] on every series of every site, `good` was empty, every iteration hit the
        // `continue`, and the gate below fell through to the RDB fallback. That has been true
        // since Worker/worker-data.js was first committed on 2026-07-13, which means every USGS
        // number this app has ever shown came from RDB and the JSON request in front of it was
        // a wasted round-trip on every gauge, on every refresh, for six weeks.
        //
        // Found 2026-08-25 only because a stubbed-fetch test asked the JSON path for a value
        // and got undefined. js/modules/usgs-gauges.js has had the shape written down in a
        // comment the entire time -- `value.timeSeries[].values[].value[]` -- and iterates it
        // correctly. Two readers of the same feed, one right, one silently dead.
        const vals = ts?.values?.[0]?.value || [];
        const good = vals.filter((v) => v.value !== "" && v.value != null);
        if (!good.length) continue;
        const latest = parseFloat(good[good.length - 1].value);
        // -999999 is USGS's no-data sentinel and it arrives spelled several ways -- "-999999",
        // "-999999.0", and with a trailing 0 count on some series. Comparing the STRING caught
        // exactly one of those. The client-side reader has always tested the number.
        if (!isFinite(latest) || latest <= -999999) continue;
        const desc = ts?.values?.[0]?.method?.[0]?.methodDescription || "";
        if (ELEV_PARMS.has(code) && SUBLOC_NAVD88.test(desc)) navd88Elev = latest;
        const rank = seriesRank(code, desc);
        const prev = best.get(code);
        if (prev && prev.rank <= rank) continue;
        best.set(code, { value: latest, when: good[good.length - 1].dateTime, rank, desc });
      }
      for (const [code, pick] of best) {
        const latest = pick.value;
        if (code === "00010") out.tempC = latest;
        if (code === "00065") out.gageHeight = latest;
        if (code === "00062") out.elevation = latest;
        if (code === "62614") out.elevation = latest;
        if (code === "62615") out.elevation = latest;
        if (code === "63160") out.elevationNavd88 = latest;
        if (code === "00060") out.streamflow = latest;
        // ADDED 2026-08-16 after Ryan asked whether we use every applicable data type USGS
        // publishes. Verified against this same endpoint, not from memory: site 02147801 --
        // the Wateree tailrace this app already reads for temperature -- serves 00010, 00060,
        // 00065, 00300 and 63160 today, and we were asking for three of the five.
        //   00300  dissolved oxygen. The summer oxygen squeeze decides what depth holds fish;
        //          the research schema already has limnology.oxygen.depletionDepthFt for it.
        //   63680  turbidity in FNU. A MEASURED clarity number where the clarity model
        //          otherwise runs on rainfall.
        if (code === "00300") out.doMgL = latest;
        if (code === "63680") out.turbidityFnu = latest;
        // COASTAL. 72137 is "Streamflow, tidally filtered, ft3/s" -- the net flow with the tidal
        // sloshing removed, which on a tidal river is the only discharge number that means
        // anything. 00095 is specific conductance, and on the coast it is what actually
        // separates fresh water from brackish from salt.
        if (code === "72137") out.tidalFlow = latest;
        if (code === "00095") out.spCond = latest;
        // 00480 is salinity in ppt. Requested and mapped, and it is expected to be ABSENT: the
        // state inventory lists 14 South Carolina locations for it, and the instantaneous-values
        // service returned ZERO series for it on 2026-08-16 while returning 8 for 00095 and 2
        // for 72137. Those 14 are discrete samples, not a live feed. Kept because GA and NC are
        // separate services and because a mapped-but-unrequested code is the bug this file just
        // had with 63160 -- but nothing should present its absence as fresh water.
        if (code === "00480") out.salinityPpt = latest;
        out.timestamp = newerStamp(out.timestamp, pick.when);
      }
      // A NAVD88 elevation series that lost the `elevation` contest above is still a reading
      // this app already has a field and readers for. 63160 fills it when the site publishes
      // one; this is the same number from a site that states its datum in the descriptor.
      if (out.elevationNavd88 == null && navd88Elev != null) out.elevationNavd88 = navd88Elev;
    }
  } catch (_) {
    // Intentionally silent: this is the JSON attempt, and the RDB request immediately below
    // is its designed fallback -- USGS serves the same values in both formats and the older
    // RDB endpoint is the more reliable of the two. Audited 2026-08-03. A warning here would
    // fire on every gauge that only answers RDB, which is a routine condition, not a fault.
  }
  // A site that answered JSON with ONLY the newer codes must not fall through to a second
  // request it does not need. This gate listed three fields when the mapper knew five.
  if (out.tempC != null || out.gageHeight != null || out.elevation != null
      || out.elevationNavd88 != null || out.streamflow != null
      || out.doMgL != null || out.turbidityFnu != null
      || out.tidalFlow != null || out.spCond != null || out.salinityPpt != null) return out;
  try {
    const rdbUrl = `https://waterservices.usgs.gov/nwis/iv/?sites=${site}&parameterCd=${paramCd}&format=rdb&period=P${periodDays}D`;
    const r = await fetch(rdbUrl, { cf: { cacheTtl: 900 } });
    if (!r.ok) return out;
    const text = await r.text();
    const seriesDesc = rdbSeriesDescriptions(text);
    const lines = text.split("\n").filter((l) => l && !l.startsWith("#"));
    if (lines.length < 3) return out;
    const header = lines[0].split("	");
    const dataLines = lines.slice(2).filter((l) => l.startsWith("USGS"));
    if (!dataLines.length) return out;
    const last = dataLines[dataLines.length - 1].split("	");
    // Same choice as the JSON path, made the same way, so the fallback cannot disagree with
    // the primary about which thermistor a lake's temperature came from. Column order used to
    // decide it here and arrival order decided it above.
    const best = new Map();
    let navd88Elev = null;
    for (let i = 4; i < header.length; i++) {
      const h = header[i];
      if (!h || h.endsWith("_cd")) continue;
      const m = h.match(/^(\d+)_(\d{5})(?:_|$)/) || h.match(/_(\d{5})(?:_|$)/);
      if (!m) continue;
      const code = m.length > 2 ? m[2] : m[1];
      const v = parseFloat(last[i]);
      if (!isFinite(v)) continue;
      const desc = m.length > 2 ? (seriesDesc[m[1]] || "") : "";
      if (ELEV_PARMS.has(code) && SUBLOC_NAVD88.test(desc)) navd88Elev = v;
      const rank = seriesRank(code, desc);
      const prev = best.get(code);
      if (prev && prev.rank <= rank) continue;
      best.set(code, { value: v, rank });
    }
    for (const [code, pick] of best) {
      const v = pick.value;
      if (code === "00010" && out.tempC == null) out.tempC = v;
      if (code === "00065" && out.gageHeight == null) out.gageHeight = v;
      if (code === "00062" && out.elevation == null) out.elevation = v;
      if (code === "62614" && out.elevation == null) out.elevation = v;
      if (code === "62615" && out.elevation == null) out.elevation = v;
      if (code === "63160" && out.elevationNavd88 == null) out.elevationNavd88 = v;
      if (code === "00060" && out.streamflow == null) out.streamflow = v;
      if (code === "00300" && out.doMgL == null) out.doMgL = v;
      if (code === "63680" && out.turbidityFnu == null) out.turbidityFnu = v;
      if (code === "72137" && out.tidalFlow == null) out.tidalFlow = v;
      if (code === "00095" && out.spCond == null) out.spCond = v;
      if (code === "00480" && out.salinityPpt == null) out.salinityPpt = v;
    }
    if (out.elevationNavd88 == null && navd88Elev != null) out.elevationNavd88 = navd88Elev;
    if (!out.timestamp && last[2]) out.timestamp = `${last[2]} ${last[3] || ""}`.trim();
  } catch (err) {
    // Unlike the JSON attempt above, this one has nothing after it. Whatever `out` holds at
    // this point is what the gauge reports, and an empty `out` renders as a gauge with no
    // reading -- identical to a gauge that is genuinely offline. They are not the same
    // problem and only one of them is ours to fix.
    console.warn(`[usgs] RDB fallback failed for site ${site}:`, err && err.message);
  }
  return out;
}
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
// Duke's SpecialMessage array is not ordered, and on a lake with both a standing drought notice
// and a this-week operational one, the operational one is what matters. Sorted by EventDate,
// newest wins; rows without a date fall to the back rather than being dropped.
function pickNewestMessage(list) {
  if (!Array.isArray(list)) return null;
  const withText = list.filter((m) => m && typeof m.Text === 'string' && m.Text.trim());
  if (!withText.length) return null;
  const t = (m) => { const n = Date.parse(m.EventDate || ''); return Number.isFinite(n) ? n : -Infinity; };
  return withText.slice().sort((a, b) => t(b) - t(a))[0].Text;
}

function normalizeDukeRow(row) {
  const actual = parseFloat(row.Actual);
  const elevMatch = String(row.Elevation || "").match(/([0-9]+(?:\.[0-9]+)?)/);
  const fullPool = elevMatch ? parseFloat(elevMatch[1]) : null;
  if (!isFinite(actual)) return null;
  const maxRaw = parseFloat(row.Max);
  // DUKE'S NUMBER IS FEET, AND IT IS FEET BELOW FULL POND, AND IT LOOKS EXACTLY LIKE A PERCENTAGE.
  //
  // A live Wateree row: Actual "98.00", Min "92.50", Max "100.00", Elevation "225.5 ft (AMSL,
  // NGVD 29 datum". Every lake in the feed has Max 100, from Lake James at about 1,200 ft of real
  // elevation down to Wateree at 225.5, which is what makes it read as a percentage.
  //
  // It is not one. Duke hangs a HUNDRED-FOOT BAND under each full pond and reports position
  // inside it, so the number is feet above that band's floor AND a percentage of the band, at the
  // same time, numerically identical. Wateree's floor is 125.5 and its full pond is 225.5.
  //
  // `Min` proves it and Norman proves it twice. Wateree's Min of 92.50 as a percentage of
  // elevation is 208.6 ft -- 17 ft of drawdown, which this reservoir has never seen -- while as
  // `100 - value` it is 7.5 ft, which is a Low Inflow Protocol minimum. Norman's Min of 91 is
  // either 69 ft down or 9 ft down, and Norman's operating range is about 10.
  //
  // The old code did `actual / 100 * fullPool`, treating the index as a fraction of the elevation
  // above SEA LEVEL. For Wateree that returned 220.99 ft instead of 223.50 -- and 220.99 is so
  // close to a plausible reading that it survived review twice, including once by someone who had
  // just been handed the raw row. On Norman it returned 735.07 instead of about 751, a 16 ft
  // error. Nothing about that formula was ever right; it was only ever unfalsifiable.
  //
  // Garmin references its soundings to full pond and does not adjust for drawdown, so this
  // number is what stands between a charted depth and the water actually under the boat.
  // WHICH CONVENTION A ROW USES IS NOT DECIDED BY `Max`.
  //
  // This read `maxRaw === 100`, and the comment above says "Every lake in the feed has Max 100".
  // The full response, pulled 2026-08-15: 34 rows, and ELEVEN do not. Eight report true feet and
  // have a real elevation in Max -- Belews 725.00, Hyco 410.50, Mayo 434.00, Robinson 221.65,
  // Julian 2165.00, Harris 220.00, Sutton 10.50, Hyco Afterbay 399.00 -- and those the old test
  // routed correctly, by accident, through the else branch.
  //
  // The other three are the bug. Nantahala Max 98.80, Queens Creek 93.80, Lake Glenville 96.20:
  // index values on lakes Duke does not run all the way to full pond, so `Max` is the operating
  // ceiling, not the band top. The old test saw Max != 100, took the else branch, and read the
  // index as feet above sea level:
  //
  //     Nantahala      ft 95.10   below full pool 2,917.10 ft
  //     Lake Glenville ft 94.30   below full pool 3,397.45 ft
  //     Queens Creek   ft 92.80   below full pool 2,809.40 ft
  //
  // Nantahala and Glenville are both in the index and both ship. conditions.js `chartDatum()`
  // gates on Number.isFinite() alone, so those numbers were publishable.
  //
  // Decided by the VALUE instead. The band is always 100 ft under full pond, so an index is a
  // small number against a large full pond and true feet are within a few percent of it. The
  // widest index ratio in the feed is Blewett Falls at 97.40/178.1 = 0.547; the lowest true-feet
  // ratio is Hyco Afterbay at 366.71/399 = 0.919. A 0.8 cut sits in that gap with room either
  // side, and the test asserts the margin so a new lake narrowing it fails loudly.
  let belowFullPoolFt = null, ft = null;
  const ratio = (fullPool != null && fullPool > 0) ? actual / fullPool : null;
  const isTrueFeet = ratio != null && ratio >= 0.8;
  if (isTrueFeet) {
    // The value already IS feet above sea level.
    ft = actual;
    belowFullPoolFt = fullPool - actual;
  } else if (actual <= 100) {
    // Feet inside the 100 ft band hung under full pond. `Max` says how high Duke runs it, which
    // is a different fact and is carried through separately.
    belowFullPoolFt = 100 - actual;
    ft = fullPool != null ? fullPool - belowFullPoolFt : null;
  } else if (fullPool != null) {
    ft = actual;
    belowFullPoolFt = fullPool - actual;
  }
  return {
    name: row.LakeDisplayName || row.LakeName || "",
    // The raw index, under a name that cannot be mistaken for a share of anything. Kept because
    // it is the number printed on Duke's own site, so it is the one a person can check against.
    index: actual,
    belowFullPoolFt: belowFullPoolFt != null ? Math.round(belowFullPoolFt * 100) / 100 : null,
    ft: ft != null ? Math.round(ft * 100) / 100 : null,
    fullPool,
    target: parseFloat(row.Target),
    min: parseFloat(row.Min),
    // NOT full pond. How high Duke actually runs it -- 100 on the Catawba lakes, 98.80 on
    // Nantahala, 96.20 on Glenville. Carried because the difference is real water.
    max: maxRaw,
    date: row.Date,
    // Which Low Inflow Protocol stage the basin is in, straight off the row and read by nothing
    // until now. 2 across Catawba-Wateree and Tuckasegee on 2026-08-15, which is why half these
    // lakes are down: recreation flow schedules suspended, irrigation limited to two days a
    // week, and ramps closing as levels fall. -1 and null both mean "no protocol in force".
    lowInflowStage: Number.isFinite(parseInt(row.LowInputStage, 10)) ? parseInt(row.LowInputStage, 10) : null,
    // THE NEWEST MESSAGE, NOT THE FIRST ONE.
    //
    // This took SpecialMessage[0]. Duke sends an array and it is not sorted newest-first: on
    // 2026-08-15 Lake Wateree carried the 2026-05-01 basin-wide LIP notice at [0] and, at [1],
    // "Due to planned maintenance at the Wateree Hydro Station the week of August 17, 2026,
    // Lake Wateree water levels are expected to rise over the weekend and remain near 99.0 feet
    // (local datum) during the week." Cedar Cliff is the same shape. The one a person needs
    // before deciding whether to go is the one that was being dropped.
    specialMessage: pickNewestMessage(row.SpecialMessage),
    specialMessages: Array.isArray(row.SpecialMessage)
      ? row.SpecialMessage.filter((m) => m && m.Text).map((m) => ({ text: m.Text, eventDate: m.EventDate || null }))
      : []
  };
}
// MOVED HERE FROM trollmap-worker.js 2026-08-16. It is a Duke API fetch and every other one
// already lives in this file; it had to move so /conditions could call it without importing
// the router. Behaviour is unchanged.
var DUKE_API_BASE = "https://api.hydro-derived.duke-energy.app";

/**
 * Duke's own list of the basins it publishes flow arrivals for.
 *
 * Ryan pasted it on 2026-08-17 after `RIVERS.dukeBasinId 1` was refused for Wateree Lake:
 *
 *   RiverId  1   RiverName "Catawba"        riverDescription "Catawba - Wateree"
 *   RiverId  2   RiverName "Nantahala"      riverDescription "Nantahala/Tuckasegee Area"
 *   RiverId  3   RiverName "Yadkin"         riverDescription "Yadkin-Pee Dee"
 *   RiverId 10   RiverName "BroadRiver"     riverDescription "Broad River Basin"
 *   RiverId  6   RiverName "Keowee Toxaway" riverDescription "Keowee - Toxaway"
 *   RiverId 11   RiverName "PigeonRiver"    riverDescription "Pigeon River"
 *   RiverId  4   RiverName "Others"         riverDescription "Other Lakes and Rivers"
 *
 * SEVEN BASINS, PUBLISHED, AGAINST TWO HAND-TYPED IDS IN `RIVERS`. The id was never derivable
 * and it never had to be typed either — this endpoint is the index, and reading it is the same
 * move that replaced the TWRA and SCDNR seed lists with the agencies' own region pages.
 */
async function fetchDukeRivers() {
  try {
    const r = await fetch(`${DUKE_API_BASE}/rivers/get-rivers`, {
      cf: { cacheTtl: 21600, cacheEverything: true },
      headers: {
        "User-Agent": "TrollMap/12 Worker",
        "Origin": "https://lakes.hydro-derived.duke-energy.app",
        "Referer": "https://lakes.hydro-derived.duke-energy.app/",
        "Accept": "application/json"
      }
    });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j) && j.length ? j : null;
  } catch (_) {
    return null;
  }
}
/**
 * Duke's release SCHEDULE, per dam, and the endpoint that finally answers for a reservoir.
 *
 * Ryan pasted it on 2026-08-17. `/rivers/flow-arrivals/{basin}` is a paddler's product — when a
 * surge reaches a river access point — and had nothing for Lake Wateree. This one does:
 *
 *   {"riverId":1,"riverName":"Wateree","Releases":[
 *      {"StartDateTime":"08/17/26 No Flow Release", ... ,"Units":"N/A"}, ... ]}
 *
 * Eleven dams across four basins, three days each, and Wateree is one of them.
 *
 * `riverName` HERE IS THE DAM, NOT THE RIVER. On /rivers/get-rivers the same field name means
 * the basin ("Catawba"); here it means the powerhouse (Bridgewater, Oxford, Wylie, GF Long
 * Bypass, Wateree, Tillery, Walters, Nantahala, East Fork, West Fork). Two endpoints from the
 * same service, one field name, two different things.
 *
 * `riverId` IS THE BASIN, and it is what ties a dam back to /rivers/get-rivers.
 */
/**
 * Duke's access-area alerts: what is closed, and why the water is where it is.
 *
 * Ryan pasted it 2026-08-17 and it carries the reason behind the number the last commit added.
 * Basin-wide, under "All Projects":
 *
 *   "On May 1, 2026, the Catawba Wateree River Basin entered Stage 2 of the Low Inflow Protocol
 *    (LIP) ... recreation flow schedules have been suspended as required under Stage 2 of the LIP."
 *
 * That is WHY Lake Wateree reads "No Flow Release" three days running, and a stated zero with its
 * cause beside it is a different thing from a stated zero on its own.
 *
 * And on the lake itself: "Buck Hill Access Area will close on March 2, 2026 for approximately
 * one year due to construction work at the Wateree hydro facility. Please use alternate sites,
 * such as Colonels Creek or White Oak Creek." The app offers ramps; Duke says one of them is shut
 * for a year and names the alternates.
 */
/**
 * Duke's operating range for one lake: the guide curve, five years of daily level, and a
 * NUMERIC drought stage.
 *
 * Ryan found it 2026-08-17 while looking for something else. `/lakes/operating-range/24` — and 24
 * is Lake Wateree's `lakepondLocationId`, which /access-alerts already publishes for every Duke
 * lake. A foreign key that cannot be derived and did not have to be typed.
 *
 * WHAT IS IN IT, all on the 100-ft index scale where 100 is full pond:
 *
 *   lakeDetails     LakeName, Elevation "225.5 ft (AMSL, NGVD 29 datum", lastUpdated
 *   history         one row per DAY since 2021: average, target, min, max, droughtStage
 *   forecast        31 days ahead of target/min/max — the published guide, not the drought one
 *   operatingRange  twelve rows, the guide curve by month
 *
 * `droughtStage` IS THE LOW INFLOW PROTOCOL AS A NUMBER. -1 is none declared, then 0, 1, 2. The
 * access-alerts endpoint says the same thing in a paragraph of HTML prose; this says it in a
 * field, with the date it changed sitting in the row before.
 */
async function fetchDukeOperatingRange(locationId) {
  const id = Number(locationId);
  if (!Number.isFinite(id)) return null;
  try {
    const r = await fetch(`${DUKE_API_BASE}/lakes/operating-range/${id}`, {
      cf: { cacheTtl: 3600, cacheEverything: true },
      headers: {
        "User-Agent": "TrollMap/12 Worker",
        "Origin": "https://lakes.hydro-derived.duke-energy.app",
        "Referer": "https://lakes.hydro-derived.duke-energy.app/",
        "Accept": "application/json"
      }
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j && (j.history || j.operatingRange) ? j : null;
  } catch (_) {
    return null;
  }
}
async function fetchDukeAccessAlerts() {
  try {
    const r = await fetch(`${DUKE_API_BASE}/access-alerts`, {
      cf: { cacheTtl: 3600, cacheEverything: true },
      headers: {
        "User-Agent": "TrollMap/12 Worker",
        "Origin": "https://lakes.hydro-derived.duke-energy.app",
        "Referer": "https://lakes.hydro-derived.duke-energy.app/",
        "Accept": "application/json"
      }
    });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j) && j.length ? j : null;
  } catch (_) {
    return null;
  }
}
async function fetchDukeActiveRun() {
  try {
    const r = await fetch(`${DUKE_API_BASE}/rivers/active-run`, {
      cf: { cacheTtl: 300, cacheEverything: true },
      headers: {
        "User-Agent": "TrollMap/12 Worker",
        "Origin": "https://lakes.hydro-derived.duke-energy.app",
        "Referer": "https://lakes.hydro-derived.duke-energy.app/",
        "Accept": "application/json"
      }
    });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j) && j.length ? j : null;
  } catch (_) {
    return null;
  }
}
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
        const arr = ev.Arrival ? new Date(ev.Arrival + (ev.Arrival.endsWith("Z") ? "" : "-04:00")) : null;
        const rec = ev.Recedes ? new Date(ev.Recedes + (ev.Recedes.endsWith("Z") ? "" : "-04:00")) : null;
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

async function getDukeLake(nameFragment) {
  const arr = await fetchDukeApi();
  if (!arr) return null;
  const frag = nameFragment.toLowerCase();
  const row = arr.find((r) => (r.LakeDisplayName || "").toLowerCase().includes(frag) || (r.LakeName || "").toLowerCase().includes(frag));
  return row ? normalizeDukeRow(row) : null;
}
/**
 * The Duke row for a water, found in the LIVE FEED rather than in the table above.
 *
 * Ryan, 2026-08-16: "did you see the answer for duke... is that wired up... dont just take it
 * off a list if that data isn't live somewhere". It was not wired up. He pasted the whole
 * /lakes/current-level response on 08-15 -- THIRTY-FOUR lakes -- and LAKES above carries a
 * duke binding on NINE. resolveLake() refuses any name that is not one of its fifteen keys, so
 * Tillery, Blewett Falls, Lookout Shoals, Hyco and Robinson have been in the response and
 * unreachable the whole time. Knowing the answer is not the same as the data being live.
 *
 * The feed is the list. Nothing is added to the table.
 *
 * WHY NOT getDukeLake: that one takes a fragment and calls .includes(), the substring family
 * fixed in bba2a33 -- "james" claims any name containing it. This matches whole tokens, both
 * directions, with the flowing-water guard.
 *
 * KNOWN AMBIGUITY, STATED RATHER THAN HIDDEN: Duke publishes "Lake Robinson" and the registry
 * ships TWO -- lake_robinson (Darlington, 2,098 ac) and lake_robinson_greer (Greenville,
 * 804 ac) -- which both still carry the legacy name "Lake Robinson, SC". Duke's is the
 * Darlington one. Until that legacy name is stripped from the Greer row (deletion tab,
 * pending) a Greer request can match it, so the feed name that answered is returned on every
 * response and a wrong match is visible instead of silent.
 */
async function dukeRowForNames(waterNames) {
  const arr = await fetchDukeApi();
  if (!arr) return null;
  let best = null;
  for (const r of arr) {
    for (const cand of [r.LakeDisplayName, r.LakeName]) {
      if (!cand) continue;
      // Duke never publishes an aggregate row, so the feed name may not be the broader one:
      // "Mountain Island Lake" must not answer for "Mountain Lake".
      const matched = matchWaterName(cand, waterNames, { sourceMayBeBroader: false });
      if (!matched) continue;
      const ct = reportTokens(cand); const wt = reportTokens(matched);
      let overlap = 0;
      for (const t of ct) if (wt.has(t)) overlap += 1;
      if (!best || overlap > best.overlap) best = { row: r, feedName: cand, matched, overlap };
    }
  }
  if (!best) return null;
  const n = normalizeDukeRow(best.row);
  return n ? { ...n, duke_feed_name: best.feedName, matched_registry_name: best.matched } : null;
}

async function fetchDukeDashboard(basin = "1") {
  const arr = await fetchDukeApi();
  if (!arr) return null;
  const lines = arr.map((r) => {
    const n = normalizeDukeRow(r);
    if (!n) return "";
    return `${n.name} \xB7 ${n.ft != null ? n.ft.toFixed(2) + " ft AMSL" : "NA"} \xB7 ${n.belowFullPoolFt != null ? n.belowFullPoolFt.toFixed(2) + " ft below full pond" : "NA"} \xB7 index ${n.index} \xB7 target ${isFinite(n.target) ? n.target : "NA"} \xB7 full ${n.fullPool || "NA"}`;
  }).filter(Boolean);
  return { url: "https://api.hydro-derived.duke-energy.app/lakes/current-level", text: lines.join("\n"), json: arr };
}
// SANTEE COOPER NO LONGER PUBLISHES A LEVEL PAGE, AND ITS REPLACEMENT PAGE POINTS AT USGS.
//
// This used to regex two numbers out of santeecooper.com/community/lakes-and-recreation/
// lake-levels[.aspx]. Both of those returned 404 on 2026-08-24. The page that replaced them --
// /community/lakes/lake-data/ -- publishes no levels at all; it links to USGS monitoring
// locations 02171000, 02169921 and 02172000. So the fallback was scraping a page whose successor
// tells you to go to USGS, which is where the chain above already started.
//
// This is a SECOND SITE, not a second source. `LAKES.marion.pool` is 02169921 (Elloree) and the
// caller only reaches here when that returned nothing. 02171000 is LAKE MARION NEAR PINEVILLE,
// site type LK, publishing 00062 continuously since 2007-10-01 -- 6,902 values -- plus 62615
// since 2023. Verified against the series catalogue 2026-08-24.
//
// MOULTRIE GETS NOTHING HERE ON PURPOSE. The only USGS site Santee Cooper names for it is
// 02172000, which IS `LAKES.moultrie.pool` and has already been tried by the time this runs.
// Inventing a fallback that repeats the call above would look like resilience and be a retry.
//
// NOT TEMPERATURE. 02171000 also serves 00010, 00300, 00400 and 00095 -- but its catalogue marks
// every one of them `Bottom`. A bottom reading on a stratified lake in August is not the water a
// kayak sits on, and returning it as `water_temperature_F` would be wrong by a wide margin in
// exactly the season it matters. Elevation only.
const SANTEE_MARION_BACKUP_SITE = "02171000";
async function fetchSanteeCooper() {
  const u = await fetchUsgs(SANTEE_MARION_BACKUP_SITE, "00062,62615");
  const ft = u?.elevation != null ? u.elevation
           : u?.elevationNavd88 != null ? u.elevationNavd88 : null;
  if (ft == null) return null;
  return {
    marion: ft,
    moultrie: null,
    source: `USGS ${SANTEE_MARION_BACKUP_SITE} (Lake Marion near Pineville, reservoir elevation)`
  };
}
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
    const band = (mod, base) => {
      const b2 = parseInt(base);
      if (!mod || mod === "mid") return b2 + 5;
      if (mod === "lower" || mod === "low") return b2 + 2;
      if (mod === "upper" || mod === "high") return b2 + 8;
      return b2 + 5;
    };
    const a = band(v[1], v[2]);
    const b = v[4] ? band(v[3], v[4]) : null;
    const tempF = b ? Math.round((a + b) / 2) : a;
    return { tempF, source: url, raw: v[0], range: b ? [a, b] : null, approx: true };
  }
  return null;
}
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
        "url": "https://www.dominionenergy.com/en/About/Lakes-and-Recreation/Lake-Murray-SC",
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
function stripHtml(html) {
  return String(html || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}
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
    const idx = Math.max(0, times.indexOf(tripDate || (new Date()).toISOString().slice(0, 10)));
    const mm = (i) => i >= 0 && i < precip.length && isFinite(precip[i]) ? precip[i] : 0;
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
/**
 * Water clarity for a lake, measured where a measurement exists and modelled where it does not.
 *
 * WHAT CHANGED 2026-08-06
 *
 * This used to be rainfall ONLY. `Worker/research/limnology.js` was already fetching secchi
 * depth from the Water Quality Portal and computing avg/min/max -- and this function, the one
 * that answers "how clear is the water", never looked at any of it. Lake Murray has 39 real
 * readings since 2024 running 11.8 ft in spring to 3.6 ft in late summer; none of it reached
 * the app.
 *
 * Now: the measured secchi average sets each zone's BASELINE, and the rain model moves it from
 * there. Where there is no measurement the behaviour is exactly what it was before, so nothing
 * regresses on the lakes WQP does not cover.
 *
 * `measured: false` is not "clear water" -- it is "nobody has looked". The response says which
 * it is, and the UI has to keep them apart. TN reservoirs are all in the second bucket.
 */
async function getLakeClarity(lakeName, tripDate, env) {
  const key = lakeKeyFromName(lakeName);

  const isCoastal = (
    String(lakeName || "").toLowerCase().startsWith('coast_') ||
    String(lakeName || "").toLowerCase().includes('coast') ||
    String(lakeName || "").toLowerCase().includes('inlet') ||
    String(lakeName || "").toLowerCase().includes('sound') ||
    String(lakeName || "").toLowerCase().includes('delta') ||
    String(lakeName || "").toLowerCase().includes('harbor') ||
    String(lakeName || "").toLowerCase().includes('basin') ||
    String(lakeName || "").toLowerCase().includes('port royal')
  );

  let defaultProfile = null;
  if (isCoastal) {
    defaultProfile = {
      displayName: lakeName,
      center: [32.77, -79.93], // Default center (Charleston area)
      defaultNote: "Tidal flush regulates clarity. Upper/marsh creeks stain after heavy local runoff; inlets and open sounds stay clearer via ocean exchange.",
      zones: [
        { name: "Inshore Creeks / Upper Marsh", sensitivity: 1.2, base: 10, likely: "stains first from land/marsh runoff after rain", ramps: [] },
        { name: "Inlets / Outer Sound / Open Water", sensitivity: 0.7, base: 3, likely: "clearest water via ocean tidal exchange", ramps: [] }
      ]
    };
  } else {
    defaultProfile = {
      displayName: lakeName,
      center: [34, -81],
      defaultNote: "No custom clarity model yet; generic creek/runoff model used.",
      zones: [
        { name: "Creeks/upper arms", sensitivity: 1.2, base: 6, likely: "stain first", ramps: [] },
        { name: "Main lake/lower basin", sensitivity: 0.75, base: 2, likely: "clearest available water", ramps: [] }
      ]
    };
  }

  const profile = LAKE_CLARITY_PROFILES[key] || defaultProfile;
  const [lat, lon] = profile.center;
  const rain = await fetchOpenMeteoRain(lat, lon, tripDate);
  const rainIn = rain?.weighted72_in ?? 0;
  const rainScore = rain ? Math.min(100, rainIn * 35 + rain.precip24_mm / 25.4 * 25 + rain.precipTrip_mm / 25.4 * 20) : 20;

  // MEASURED BASELINE. Secchi is a depth in feet -- more feet is clearer -- while this model's
  // score runs the other way, 0 clear to 100 muddy. Map across the range the classifier's own
  // bands imply: 12 ft of visibility is Clear (score ~5), 1 ft is Muddy (score ~75). Linear
  // between, clamped, because the classifier's bands are linear too.
  //
  // The zone `base` values stay as the FALLBACK for lakes with no measurement. They are hand-
  // authored guesses; a real reading beats them, and only for the lake it was taken on.
  // NOT ON COASTAL ZONES. Measured 2026-08-06: the coastal slugs have enormous bounding boxes --
  // ACE Basin is 693,000 acres and catches 70 WQP stations, Charleston Harbor 37, Beaufort/Port
  // Royal 74. Averaging stations spread across a whole estuary into one number is not a clarity
  // reading for anywhere in particular, and tidal exchange means the inlet and the upper marsh
  // creeks genuinely differ by more than the average could ever express. The zone model already
  // says exactly that in its own note.
  //
  // A per-zone nearest-station join would work here. Until that exists, coastal keeps the
  // rainfall+tide model it has, rather than being handed a confident average of the wrong thing.
  let measured = null;
  try {
    if (env && !isCoastal) {
      const { getSecchiSummary } = await import('./research/limnology.js');
      measured = await getSecchiSummary(env, lakeName);
    }
  } catch (e) {
    console.warn(`[clarity] measured baseline unavailable for ${lakeName}: ${e.message}`);
  }
  const secchiFt = measured?.avgSecchiDepthFt ?? null;
  const ntu = measured?.recentTurbidityNTU ?? null;

  // Secchi if we have it, turbidity if we do not. Turbidity is log-distributed -- the step from
  // 1 to 5 NTU matters as much as 20 to 100 -- so it maps through log10 rather than linearly,
  // landing on the SAME Clear / Slight stain / Stained / Muddy bands the classifier already uses:
  //     1 NTU -> Clear      5 -> Slight stain      25 -> Stained      100+ -> Muddy
  // Published NTU bands, not a curve fitted to our own data. A fitted curve would look more
  // precise than it is; 166 lakes carry both measurements and can CHECK these bands instead.
  const measuredBase =
      secchiFt != null ? Math.max(0, Math.min(100, 75 - (secchiFt - 1) * (70 / 11)))
    : ntu != null      ? Math.max(0, Math.min(100, 35 * Math.log10(Math.max(ntu, 0.5)) + 5))
    : null;

  const zones = profile.zones.map((z) => {
    // A zone's own character still applies: a creek arm is dirtier than the main lake even when
    // the lake-wide average is clear. Keep the zone's offset from its profile's own mean.
    const profileMean = profile.zones.reduce((a, x) => a + x.base, 0) / Math.max(1, profile.zones.length);
    const base = measuredBase == null ? z.base : Math.max(0, measuredBase + (z.base - profileMean));
    const score = Math.max(0, Math.min(100, base + rainScore * z.sensitivity));
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
    // Say which of the three this is. "Modelled" and "measured then adjusted" deserve different
    // trust, and "no measurement exists" must never render as "the water is clear".
    confidence: measured && rain ? "good: measured secchi baseline + rainfall adjustment, verify at ramp"
              : measured ? "medium: measured secchi baseline, no rainfall feed"
              : rain ? "medium: forecast/rainfall model only \u2014 no clarity measurements for this water"
              : "low: no rainfall feed, generic model",
    measured: measured ? {
      avgSecchiDepthFt: measured.avgSecchiDepthFt,
      minSecchiDepthFt: measured.minSecchiDepthFt,
      maxSecchiDepthFt: measured.maxSecchiDepthFt,
      sampleCount: measured.sampleCount,
      lastObserved: measured.lastObserved,
      recentTurbidityNTU: measured.recentTurbidityNTU ?? null,
      fetchedAt: measured.fetchedAt,
      source: "Water Quality Portal (waterqualitydata.us) \u2014 NWIS + STORET",
    } : null,
    measuredNote: measured
      ? null
      : "No secchi measurements published for this water. The estimate below is a rainfall model, "
        + "not an observation \u2014 absence of data is not clear water.",
    summary: measured
      ? `${profile.displayName || lakeName}: typically ${measured.avgSecchiDepthFt} ft visibility (${measured.sampleCount} readings, ${measured.minSecchiDepthFt}\u2013${measured.maxSecchiDepthFt} ft). ${rain ? `${rain.weighted72_in}" weighted rain signal moves it to ` : ''}${overall.clarity} for this trip; creek arms dirtier than the main lake.`
      : rain ? `${profile.displayName || lakeName}: ${rain.weighted72_in}" weighted rain/runoff signal. ${overall.clarity} overall predicted; upper/creek arms likely dirtier than lower/main lake.` : `${profile.displayName || lakeName}: generic clarity estimate. Verify locally.`,
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
async function getLakeIntel(lakeName) {
  const key = lakeKeyFromName(lakeName);
  const sourceRegistry = getLakeIntelSourceRegistry(key);

  const isCoastal = (
    String(lakeName || "").toLowerCase().startsWith('coast_') ||
    String(lakeName || "").toLowerCase().includes('coast') ||
    String(lakeName || "").toLowerCase().includes('inlet') ||
    String(lakeName || "").toLowerCase().includes('sound') ||
    String(lakeName || "").toLowerCase().includes('delta') ||
    String(lakeName || "").toLowerCase().includes('harbor') ||
    String(lakeName || "").toLowerCase().includes('basin') ||
    String(lakeName || "").toLowerCase().includes('port royal')
  );

  let profile;
  if (LAKE_INTEL[key]) {
    profile = LAKE_INTEL[key];
  } else if (isCoastal) {
    profile = {
      displayName: lakeName || key || "Coastal Zone",
      primarySportFish: ["Red Drum (Redfish)", "Spotted Seatrout (Speckled Trout)", "Southern Flounder"],
      forage: ["Shrimp", "Finger Mullet", "Mud Minnows", "Menhaden", "Blue Crab"],
      stocking: "VERIFY: No curated marine stocking profile yet. Check state saltwater regulations before relying on this.",
      spottedBass: "N/A \u2014 Inshore Marine / Estuary.",
      habitat: "Salt marsh edges (Spartina), oyster reefs/rakes, tidal creek mouths, mud flats, and dock pilings.",
      bottom: "Silt, mud, sand, and oyster shell bars. Verify local navigation paths on MLLW nautical charts.",
      hazards: "Severe tidal swings, oyster rakes (extremely sharp, severe kayak hazard), strong tidal currents, wind-driven chop, and shoals.",
      seasonalPattern: "Tides drive all inshore patterns. Flood tide: target flooded grass marsh edges with gold spoons/topwaters. Ebb tide: target creek mouths, drop-offs, and oyster points with soft plastic paddletails.",
      tacticalNotes: [
        "Inshore Marine \u2014 NOT a freshwater lake/reservoir.",
        "Strictly restricted to inshore waters. Do NOT go past the jetties on a kayak.",
        "Always sync tides before launching. Low tide drains the creeks and can leave a kayak stranded on mud flats."
      ]
    };
  } else {
    profile = {
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
  }

  const lakeCfg = LAKES[key];
  const latestReport = lakeCfg?.ahq ? await fetchAhqFishingReport(lakeCfg.ahq) : null;
  const lakeMonster = await fetchLakeMonsterIntel(key);

  const stateCode = (
    String(lakeName || "").toLowerCase().includes('sc') ? 'SC' :
    String(lakeName || "").toLowerCase().includes('ga') ? 'GA' :
    String(lakeName || "").toLowerCase().includes('nc') ? 'NC' : 'SC'
  );

  const sources = isCoastal ? [
    stateCode === 'SC' ? { label: "SCDNR Saltwater Fishing Regulations (eRegulations)", url: "https://www.eregulations.com/southcarolina/fishing/general-information" } :
    stateCode === 'GA' ? { label: "Georgia DNR Coastal Resources Division", url: "https://coastalgadnr.org/fishing" } :
    { label: "NC DMF Saltwater Fishing Regulations", url: "https://deq.nc.gov/about/divisions/marine-fisheries" }
  ] : [
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
    timestamp: (new Date()).toISOString(),
    confidence: (LAKE_INTEL[key] || isCoastal) ? "curated_profile_plus_live_scrape_when_available" : "generic_unverified_profile"
  };
}
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

export { normalizeDukeRow, dukeRowForNames, fetchDukeFlowArrivals, fetchDukeRivers, fetchDukeActiveRun, fetchDukeAccessAlerts, fetchDukeOperatingRange, LAKES, LAKE_INTEL, LAKE_INTEL_SOURCE_REGISTRY, LAKEMONSTER_IDS, LAKE_CLARITY_PROFILES, RIVERS, lakeKeyFromName, fetchText, fetchUsgs, seriesRank, rdbSeriesDescriptions, newerStamp, fetchAhqWaterTemp, fetchAhqFishingReport, fetchLakeMonsterIntel, getLakeIntel, getLakeClarity, getLakeIntelSourceRegistry, getDukeLake, fetchSanteeCooper, fetchUsaceSavannah, fetchCwmsLakeLevel, fetchDukeDashboard };