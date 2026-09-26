
// worker-data.js — Static lake/river data extracted from trollmap-worker.js
// LAKES, LAKE_INTEL_SOURCE_REGISTRY, LAKEMONSTER_IDS, LAKE_CLARITY_PROFILES, RIVERS

import { matchWaterName, reportTokens, parseAhqPage } from './reports.js';
import { num as numOrNull } from '../js/utils/num.js';
import { geoDistanceKm } from '../js/utils/geo.js';
import { GENERIC_LAKE_ZONES, GENERIC_RIVER_ZONES, watershedSensitivity, riverFlowSensitivity,
         zonesForSensitivity } from './clarity-sensitivity.js';

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
// LAKE_INTEL WAS HERE UNTIL 2026-09-24 -- nine hand-written lake profiles (wateree, murray,
// marion, moultrie, keowee, hartwell, thurmond, russell, jocassee). Ryan ruled it redundant on
// 2026-08-15: every field lands in the research profile, and all nine have one. Measured the day it
// went: each of the nine carries predatorSpecies (8-20), a habitat block and trollingIntelligence
// (7-17 species), and lake-intel.js reads those first and fell back to this table only for a block
// the profile lacked -- which none of the nine does. Its one live use was hidden: fetchLakeMonsterIntel
// built its URL from this table's displayName, so LAKEMONSTER_IDS now carries LakeMonster's own page
// path instead. See docs/claude WHAT_WAS_NEVER_EXPANDED_2026-08-15.md.
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

/**
 * WHICH ELEVATION CODE IS THE LAKE, WHEN A SITE PUBLISHES MORE THAN ONE.
 *
 * Stable, documented, and it carries the losers rather than discarding them. See the block in
 * fetchUsgs for why no datum is preferred: Hyco needs the named one and Murray needs the unnamed
 * one, and picking either everywhere breaks the other.
 *
 * 00062 first because it is what this app has shown on every lake whose operator publishes a
 * full pool on the same scale -- Murray at 358, Marion at 75. The order is the point; being
 * first is not a claim that it is the better datum.
 */
const ELEV_CODE_ORDER = ['00062', '62615', '62614'];
const ELEV_CODE_DATUM = {
  '00062': 'above datum (USGS does not name it in the code)',
  '62614': 'NGVD 1929',
  '62615': 'NAVD 1988',
};

function applyElevation(out, candidates) {
  const list = (candidates || []).filter((c) => c && Number.isFinite(c.value));
  if (!list.length) return out;
  const rank = (c) => {
    const i = ELEV_CODE_ORDER.indexOf(c.code);
    return i < 0 ? ELEV_CODE_ORDER.length : i;
  };
  const sorted = list.slice().sort((a, b) => rank(a) - rank(b) || a.code.localeCompare(b.code));
  const win = sorted[0];
  out.elevation = win.value;
  out.elevation_code = win.code;
  out.elevation_datum = ELEV_CODE_DATUM[win.code] || null;
  const others = sorted.slice(1);
  if (others.length) {
    out.elevation_alternatives = others.map((c) => ({
      code: c.code, value: c.value, datum: ELEV_CODE_DATUM[c.code] || null,
      sublocation: c.desc || null,
    }));
    // SAID OUT LOUD WHEN IT MATTERS. Two datums a foot apart is a datum question; two readings
    // four hundred feet apart is a local gage datum being read as a sea-level elevation, and a
    // consumer that is never told cannot tell those apart from the number alone.
    const spread = Math.abs(win.value - others[others.length - 1].value);
    out.elevation_disagrees_ft = Math.round(spread * 100) / 100;
  }
  return out;
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
      const elevCandidates = [];
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
        // THREE ELEVATION CODES, ONE FIELD, AND WHICHEVER ARRIVED LAST USED TO WIN.
        //
        // 00062, 62614 and 62615 all wrote `out.elevation` unconditionally, so a site publishing
        // more than one of them produced a different answer depending on the order USGS happened
        // to serialise the response. Not hypothetical: site 02077280 at the Hyco Lake dam
        // (Person Co, NC) answered live on 2026-08-25 with 00062 = 8.81 AND 62614 = 408.6 in the
        // same response. FOUR HUNDRED FEET APART, on a coin flip.
        //
        // They disagree because they are not the same measurement. 62614 is above NGVD 1929 and
        // 62615 is above NAVD 1988 -- both named national datums. 00062 is "elevation of
        // reservoir water surface ABOVE DATUM", and USGS does not say which datum in the code; at
        // Hyco it is a local staff gage sitting around the 400 ft contour, which is why 8.81.
        //
        // NOTHING HERE PICKS A DATUM FOR A LAKE, because there is no answer that is right
        // everywhere. On Lake Murray (Lexington Co, SC) the same pair reads 00062 = 356.57 and
        // 62615 = 355.26 against a published 358 ft full pool, and there it is the UNNAMED datum
        // that matches what the operator publishes. Preferring the named one would move Murray
        // by 1.3 ft to fix Hyco by 400.
        //
        // So: a STABLE order, which is strictly better than a coin flip and preserves what this
        // app has been showing; and `elevation_alternatives`, so when a site publishes two that
        // disagree the disagreement is visible instead of resolved by serialisation order.
        if (ELEV_PARMS.has(code)) {
          elevCandidates.push({ code, value: latest, desc: pick.desc || null });
        }
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
      applyElevation(out, elevCandidates);
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
    const elevCandidates = [];
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
      // Same choice as the JSON path, made the same way. First-wins by column order was as
      // arbitrary as last-wins by serialisation order; see applyElevation.
      if (ELEV_PARMS.has(code)) elevCandidates.push({ code, value: v, desc: null });
      if (code === "63160" && out.elevationNavd88 == null) out.elevationNavd88 = v;
      if (code === "00060" && out.streamflow == null) out.streamflow = v;
      if (code === "00300" && out.doMgL == null) out.doMgL = v;
      if (code === "63680" && out.turbidityFnu == null) out.turbidityFnu = v;
      if (code === "72137" && out.tidalFlow == null) out.tidalFlow = v;
      if (code === "00095" && out.spCond == null) out.spCond = v;
      if (code === "00480" && out.salinityPpt == null) out.salinityPpt = v;
    }
    if (out.elevationNavd88 == null && navd88Elev != null) out.elevationNavd88 = navd88Elev;
    if (out.elevation == null) applyElevation(out, elevCandidates);
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
    // ── "NA" IS NOT A NUMBER AND NaN IS NOT null ──────────────────────────────────────────────
    //
    // `parseFloat("NA")` is NaN, and `NaN != null` is TRUE. Twelve lakes in the live feed send
    // Target "NA" -- Tillery, Blewett Falls, Keowee, Bad Creek, Tuckasegee, and every lake in the
    // "Others" basin (Harris, Hyco, Hyco Afterbay, Julian, Mayo, Robinson, Sutton) -- so any
    // consumer that guards with `!= null` instead of Number.isFinite() took NaN as a target and
    // arithmetic on it returns NaN all the way out. js/utils/num.js is numOrNull() here, and
    // conditions.js uses it on the operating-range rows; this row shape never got it.
    // Measured against Ryan's 2026-09-23 capture of /lakes/current-level.
    target: numOrNull(row.Target),
    min: numOrNull(row.Min),
    // NOT full pond. How high Duke actually runs it -- 100 on the Catawba lakes, 98.80 on
    // Nantahala, 96.20 on Glenville. Carried because the difference is real water.
    max: maxRaw,
    date: row.Date,
    // Which Low Inflow Protocol stage the basin is in, straight off the row and read by nothing
    // until now. 2 across Catawba-Wateree and Tuckasegee on 2026-08-15, which is why half these
    // lakes are down: recreation flow schedules suspended, irrigation limited to two days a
    // week, and ramps closing as levels fall. -1 and null both mean "no protocol in force".
    // ── -1 IS "NO DROUGHT DECLARED", NOT STAGE MINUS ONE ─────────────────────────────────────
    //
    // conditions.js says exactly that about the same concept arriving on a different endpoint --
    // `/lakes/operating-range/{id}`'s droughtStage -- and maps -1 to null there. This path kept
    // the raw -1, so one app held two encodings of "no drought": null from one Duke endpoint and
    // -1 from the other. In Ryan's 2026-09-23 capture, four lakes send -1 (Nantahala, Tillery,
    // Blewett Falls, Waterville), nine send null, Ninety-Nine Islands sends 0, and the Tuckasegee
    // basin sends 3 while Catawba-Wateree sends 2.
    //
    // `lowInflowStageRaw` keeps what was published, because -1 and an absent field are different
    // statements: one says the operator checked and declared nothing, the other says the feed had
    // no opinion.
    lowInflowStage: (() => {
      const n = parseInt(row.LowInputStage, 10);
      return Number.isFinite(n) && n >= 0 ? n : null;
    })(),
    lowInflowStageRaw: Number.isFinite(parseInt(row.LowInputStage, 10)) ? parseInt(row.LowInputStage, 10) : null,
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
/**
 * US/EASTERN FOR A GIVEN DATE, because Duke publishes local time with no offset on it.
 *
 * `parseDukeRunTime` defaulted to '-04:00' and `fetchDukeFlowArrivals` appends the same literal,
 * so from the first Sunday in November to the second Sunday in March every Duke release time,
 * arrival and recession has been an hour late. On a two-hour release window -- Wateree publishes
 * exactly that on 2026-09-24, 17:00 to 19:00 -- an hour is most of the fact.
 *
 * Computed, not tabled: ask the runtime what the offset is for that instant in America/New_York.
 * The date is parsed once as UTC to get an instant to ask about, which is off by at most the
 * offset itself and cannot cross a DST boundary that a same-day release would care about.
 */
function easternOffsetFor(y, mo, d) {
  try {
    const probe = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), 17, 0, 0));
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', timeZoneName: 'shortOffset',
    }).formatToParts(probe);
    const tz = (parts.find((x) => x.type === 'timeZoneName') || {}).value || '';
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(tz);
    if (!m) return '-05:00';
    return `${m[1]}${String(m[2]).padStart(2, '0')}:${m[3] || '00'}`;
  } catch (_) {
    // A runtime with no tz data must not silently pick summer. EST is the standard offset.
    return '-05:00';
  }
}

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
/**
 * Duke's recreation calendars: /calendar-v2, the release schedules Duke publishes as PDFs.
 *
 * Read 2026-09-24 through Duke's own lakes site (registry/_duke_calendar_v2_2026-09-24.json): 25
 * rows over four locations -- 1 Catawba-Wateree, 2 Nantahala/Tuckasegee, 3 Pee Dee below Tillery,
 * 11 Pigeon below Walters. Eleven are PDFs (the Nantahala main stem and bypass, the Tuckasegee, the
 * West Fork Tuckasegee bypass, Tillery and the Pee Dee's boating times and map, Walters, the Great
 * Falls long bypass warning and the Catawba-Wateree Stage 2 message) and fourteen are the USGS
 * gauges Duke names for those releases. The PDF links are plain paths under lakes.hydro-derived,
 * not the week-long presigned links the retired /calendar handed out, so they can be linked.
 *
 * The body arrives wrapped -- `{statusCode, body: "<json>", headers}` -- in the capture under
 * test/fixtures/operators/, and bare in what the browser showed; both are read.
 */
async function fetchDukeCalendar() {
  try {
    const r = await fetch(`${DUKE_API_BASE}/calendar-v2`, {
      cf: { cacheTtl: 21600, cacheEverything: true },
      headers: {
        "User-Agent": "TrollMap/12 Worker",
        "Origin": "https://lakes.hydro-derived.duke-energy.app",
        "Referer": "https://lakes.hydro-derived.duke-energy.app/",
        "Accept": "application/json"
      }
    });
    if (!r.ok) return null;
    return parseDukeCalendar(await r.json());
  } catch (_) {
    return null;
  }
}

/** Duke's calendar payload -> [{id, locationId, name, url, isPdf, published, usgsSite}], or null. */
function parseDukeCalendar(j) {
  let x = j;
  if (x && typeof x.body === 'string') {
    try { x = JSON.parse(x.body); } catch (_) { return null; }
  }
  const rows = Array.isArray(x) ? x : (x && Array.isArray(x.calendar) ? x.calendar : null);
  if (!rows) return null;
  const out = rows.filter((r) => r && r.url && r.location_id != null).map((r) => ({
    id: r.rec_calendar_id ?? r.id ?? null,
    locationId: Number(r.location_id),
    name: String(r.name || '').replace(/\.pdf$/i, '').trim(),
    url: String(r.url),
    isPdf: r.is_pdf === true,
    published: r.published_dtm || r.published || null,
    // The gauge rows are USGS monitoring-location links; the site number is the foreign key
    // that ties a Duke location to the waters the registry bound that gauge to.
    usgsSite: (/USGS-(\d{8,15})/.exec(String(r.url)) || [])[1] || null,
  }));
  return out.length ? out : null;
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
        // US/EASTERN FOR THAT DATE, not EDT year-round. Duke publishes "2026-09-24T18:48:00"
        // with no offset on it; appending a literal -04:00 makes every arrival and recession an
        // hour late from November to March. easternOffsetFor() asks the runtime.
        const stamp = (v) => {
          if (!v) return null;
          const str = String(v);
          if (str.endsWith('Z')) return new Date(str);
          const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(str);
          return new Date(str + (d ? easternOffsetFor(d[1], d[2], d[3]) : '-05:00'));
        };
        const arr = stamp(ev.Arrival);
        const rec = stamp(ev.Recedes);
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
// REMOVED 2026-08-25: fetchSanteeCooper, fetchUsaceSavannah and CWMS_PROJECT.
//
// All three were reachable only through the `/lake` route, which had no caller
// anywhere in js/. Between them they were a six-row table of Corps project names, a
// scrape of water.sas.usace.army.mil for a three-digit number sitting next to a lake
// name, and a Santee Cooper reader that had already been rewritten to read USGS 02171000
// under a different name.
//
// Ryan, 2026-08-25: *"nothing hand written... everything expandable... if i decide to add
// every single lake that garmin has in the US into the app tomorrow this stuff should be
// able to expand with it"*. None of the three could have grown past the five lakes
// somebody typed. `/conditions` answers all five off water_bindings.json with nothing
// typed: usaceLevels() picks the project from the district's own roster of published
// conservation pools, and Marion and Moultrie resolve through their bound USGS sites.

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
// LAKEMONSTER'S OWN PAGE FOR EACH LAKE -- state, slug and id, the path its site resolves to. A
// foreign key, not data: nothing in the registry can produce another site's URL.
//
// IT WAS A BARE ID, AND THE URL AROUND IT WAS GUESSED. fetchLakeMonsterIntel() built
// `/lake/SC/<LAKE_INTEL displayName>-water-temperature-<id>`, so it leaned on a table ruled redundant
// and hard-coded one state for all five. Measured 2026-09-24 by fetching each: Wateree, Murray and
// Keowee resolved; Hartwell did not (LakeMonster files it under Georgia) and Norman did not (North
// Carolina, and it had no LAKE_INTEL name, so it asked for "norman"). A wrong path answers 200 with a
// generic page that the temperature regex then read as nothing. These are the pages each resolves to.
var LAKEMONSTER_IDS = {
  wateree: "South-Carolina/Lake-Wateree-1072",
  murray: "South-Carolina/Lake-Murray-1071",
  keowee: "South-Carolina/Lake-Keowee-1068",
  hartwell: "Georgia/Lake-Hartwell-1029",
  norman: "North-Carolina/Lake-Norman-232"
};
async function fetchLakeMonsterIntel(key) {
  const page = LAKEMONSTER_IDS[key];
  if (!page) return null;
  const url = `https://lakemonster.com/lake/${page}`;
  try {
    const r = await fetchText(url);
    if (!r.ok || !r.text) return null;
    const text = stripHtml(r.text);
    // THE BODY IS DRAWN BY SCRIPT, SO THE TITLE IS WHERE THE NUMBER IS. Fetched 2026-09-24:
    // stripHtml() leaves "Lake Murray Water Temp Today: 76°F | LakeMonster" and nothing else
    // with a degree sign in it, so the two patterns below matched on no lake at all, before or after
    // the page paths were fixed. They are kept for a page that renders server-side again.
    const titleTemp = text.match(/Water Temp[^0-9]{0,20}(\d{2,3})\s*\u00B0/i);
    const water = titleTemp || text.match(/(?:Right Now[\s\S]{0,250}?Water\s*|Water\s*)(\d{2,3})°/i) || text.match(/Water\s*(\d{2,3})°F/i);
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
// The page is read by parseAhqPage() in reports.js since 2026-09-25. This file carried its own
// copy of the same five anchors and four water-temp searches, the one reports.js was lifted from.
async function fetchAhqFishingReport(slug) {
  if (!slug) return null;
  const url = "https://www.anglersheadquarters.com/pages/" + slug + "-fishing-report";
  try {
    const r = await fetchText(url);
    if (!r.ok || !r.text) return null;
    const summary = parseAhqPage(r.text);
    return summary ? { source: url, summary } : null;
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
// Each profile names the registry water it was written for (`slug`), so a name that merely
// CONTAINS "wateree" or "marion" -- the Wateree River, a lake in Marion County -- does not get
// this lake's zones, ramps and rain point. See getLakeClarity.
var LAKE_CLARITY_PROFILES = {
  wateree: {
    displayName: "Lake Wateree",
    slug: "wateree_lake",
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
    slug: "lake_murray",
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
    slug: "lake_marion",
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
    slug: "lake_moultrie",
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
    slug: "lake_keowee",
    center: [34.7, -82.9],
    defaultNote: "Deep clear herring lake; runoff affects backs of creeks first while main points often stay clear.",
    zones: [
      { name: "Creek backs", sensitivity: 1.15, base: 5, likely: "slight stain after rain", ramps: ["creek ramps"] },
      { name: "Main-lake points / lower lake", sensitivity: 0.45, base: 0, likely: "usually clear", ramps: ["South Cove", "High Falls"] }
    ]
  },
  hartwell: {
    displayName: "Lake Hartwell",
    slug: "hartwell_lake",
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
 * The clarity station a launch reads, with its distance in km, or null: the NEAREST station whose
 * record is at least as long as this water's median station record. Straight line, and the
 * payload says which station and how far, so one across a point in another arm is visible rather
 * than silently trusted. Stations without a position or a reading are skipped.
 *
 * ── A NEARER STATION WITH A SHORT RECORD IS PASSED OVER, AND NAMED ──────────────────────────────
 *
 * Asked 2026-09-24 whether a launch should read the nearest station even when it has only a few
 * readings, or a farther one with a long record, Ryan: "I dont know the answer to your
 * question... which is more accurate?". So it was measured, leave-one-out: every station in turn
 * plays the launch, its own average is the answer, and each rule predicts it from the OTHER
 * stations on that water. Only stations INSIDE the water's outline count (see on-water.js) --
 * 503 on 53 waters, after 304 in the boxes but off the water were dropped.
 *
 *     where the nearest station's record is shorter than the water's median and a longer one is
 *     farther (a median 1.1 km farther), scored against launches whose own record is long
 *     (86 launches on 30 waters):
 *
 *                                  median error    same clarity band
 *       nearest, any record          1.00 ft          79.1%
 *       nearest long record          0.55 ft          84.9%       <- this
 *       biggest record on the water  0.85 ft          70.9%
 *       the water's average          0.73 ft          75.6%
 *
 *     Head to head over all 154 such launches: the long record is closer on 85, the nearest on
 *     56. By the nearest station's own record, over every launch: 1 reading 0.95 vs 1.85 ft,
 *     2-3 readings 0.30 vs 1.00 ft, 4-9 readings 0.70 vs 0.80 ft; at 10 or more the nearest is
 *     a shade better, 0.50 vs 0.60 ft, which is the price of a water whose median record is
 *     long. Over every launch the rule is 0.60 ft against 0.70, 79.3% against 78.1%.
 *
 * Why the short record loses: a station with a handful of readings is usually one survey, taken in
 * one season, and Secchi swings with the season (Murray reads 11.8 ft in spring and 3.6 ft in late
 * summer). Its average is that season, not this water's normal. Scored against short-record
 * launches instead, the two rules come out closer -- because short-record stations near each other
 * share the same survey and agree with each other, not with the long run.
 *
 * "Long" is the water's own median record, not a count typed here: on Murray, whose 43 stations run
 * 2 to 115 readings, that is 8; on a water surveyed lightly everywhere it is lower. The payload names
 * the nearer station it passed over and how many readings it had, so the choice is never hidden.
 */
function nearestClarityStation(stations, lat, lon) {
  const usable = [];
  for (const s of stations || []) {
    const sLat = Number(s && s.lat), sLon = Number(s && s.lon), ft = Number(s && s.avgSecchiDepthFt);
    if (!Number.isFinite(sLat) || !Number.isFinite(sLon) || !Number.isFinite(ft)) continue;
    const km = geoDistanceKm(lat, lon, sLat, sLon);   // the one haversine, in js/utils/geo.js
    usable.push({ s, km, n: Number(s.sampleCount) || 0 });
  }
  if (!usable.length) return null;
  const counts = usable.map((u) => u.n).sort((a, b) => a - b);
  const mid = counts.length >> 1;
  const medianN = counts.length % 2 ? counts[mid] : (counts[mid - 1] + counts[mid]) / 2;
  const byKm = (a, b) => a.km - b.km;
  const nearest = [...usable].sort(byKm)[0];
  const chosen = usable.filter((u) => u.n >= medianN).sort(byKm)[0] || nearest;
  const round = (km) => Math.round(km * 10) / 10;
  const out = { ...chosen.s, km: round(chosen.km), medianRecord: medianN };
  if (chosen !== nearest) {
    out.passedOver = { id: nearest.s.id, name: nearest.s.name, km: round(nearest.km),
                       sampleCount: nearest.n };
  }
  return out;
}

/**
 * WHAT THE MEASURED BASELINE IS, IN WORDS -- SECCHI WHERE THERE IS ONE, TURBIDITY WHERE NOT.
 *
 * getSecchiSummary() answers with turbidity alone when a water has no Secchi reading: 122 of 512
 * inland lakes (limnology.js, 2026-08-06), Lake Norman and every TVA reservoir among them, and the
 * river pieces. The baseline score already used it. The sentences did not: they read the Secchi
 * fields unconditionally, and on the Broad River (Cherokee Co, SC) on 2026-09-24 the card said
 * "typically undefined ft visibility (undefined readings, undefined-undefined ft)" and the plan
 * was handed "undefined measured secchi readings averaging undefined ft".
 *
 * `short` is the summary's form; the long form is the evidence behind "normally". Null when the
 * summary carries neither, so the caller says what it says for no measurement at all.
 */
export function measuredEvidence(m, short = false) {
  if (!m) return null;
  if (m.avgSecchiDepthFt != null) {
    return short
      ? `typically ${m.avgSecchiDepthFt} ft visibility (${m.sampleCount} readings, ${m.minSecchiDepthFt}\u2013${m.maxSecchiDepthFt} ft)`
      : `${m.sampleCount} measured secchi readings averaging ${m.avgSecchiDepthFt} ft (${m.minSecchiDepthFt}\u2013${m.maxSecchiDepthFt} ft)`;
  }
  if (m.recentTurbidityNTU != null) {
    const on = m.recentTurbidityLastObserved ? ` on ${m.recentTurbidityLastObserved}` : '';
    return short
      ? `${m.recentTurbidityNTU} NTU turbidity at its latest reading${on}, no Secchi readings`
      : `turbidity of ${m.recentTurbidityNTU} NTU at its latest reading${on} -- no Secchi readings exist for it`;
  }
  return null;
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

/**
 * The registry water a clarity request is about, with the registry files the model reads (the
 * river clarity-by-flow table only for a river).
 * `slug` is the caller's when it sent one the index knows, else the row the name resolves to --
 * the same resolveRegistryRow() the WQP pull takes its box from, so the watershed, the Secchi
 * and the hand profile below can never be three different waters. Everything is null when the
 * bucket has no registry (the tests' stub buckets), and the model then behaves as it always did.
 */
async function registryWaterFor(env, lakeName, slug = null) {
  if (!env || !env.R2_TROLLMAP_CHARTPACKS) return { slug: slug || null, chain: null, index: null, flowTable: null };
  const reg = await import('./registry.js');
  const [index, chain] = await Promise.all([
    reg.lakeIndex(env).catch(() => null),
    reg.waterChain(env).catch(() => null),
  ]);
  const own = slug && (!index || index[slug]) ? slug : null;
  const row = own ? null : (index ? reg.resolveRegistryRow(index, lakeName) : null);
  const found = own || (row && row.slug) || null;
  // A river's rain rate is read off its own readings at high flow, so the table is fetched only
  // when the water is a river. The loader keeps it an hour per isolate, like the chain.
  const flowTable = found && index && index[found] && index[found].feature_type === 'river'
    ? await reg.riverClarityByFlow(env).catch(() => null) : null;
  return { slug: found, chain, index, flowTable };
}

/**
 * ── THE RAIN THAT DRIVES THIS MODEL WAS BEING MEASURED NEAR COLUMBIA FOR EVERY WATER BUT SIX ──
 *
 * Ryan, 2026-09-23, on being told the drainage run would improve the per-zone `sensitivity`
 * constant: *"that doesn't sound right at all for clarity..."*.
 *
 * THIS COMMENT MISREAD HIM, and he said so the next day: *"what i said for clarity that was not
 * right was that it was only on 6 waters... i have nothing to say about the method... i just
 * thought it was already on all waters since i had already asked for everything for one water to
 * be on all of them"*. The objection was to SIX, not to drainage. The rain point below was a real
 * defect found while looking at it and stays fixed; the per-water sensitivity he did want is now
 * read off each water's watershed -- see Worker/clarity-sensitivity.js.
 *
 * `score = base + rainScore * sensitivity`. `base` is a measured Secchi or turbidity baseline off
 * the WQP, cached in R2 and refreshed on a 30-day cron, and it moves on the scale of months.
 * `rainScore` is the ONLY input in here that describes today -- 72 h of weighted rainfall -- and it
 * was fetched at `profile.center`.
 *
 * Six lakes have a hand-authored profile with a real point on the water. Everything else fell to
 * `defaultProfile`, whose center is the literal `[34, -81]`: a fixed spot near Columbia, SC. Every
 * coastal zone fell to `[32.77, -79.93]`, Charleston.
 *
 * Measured 2026-09-23 over the 196 bound waters with a centroid and no custom profile:
 *
 *     more than  50 km from [34, -81]    191 of 196
 *     more than 150 km                   156
 *     median distance                    226 km
 *
 *     norris_lake        366 km      fort_loudoun_lake  346 km      tellico_lake  341 km
 *     holston_river      336 km      clinch_river       335 km      chilhowee     323 km
 *
 * And his own water: Cooper River 142 km, Santee 122 km, Diversion Canal 107 km, Greenwood 100 km.
 * The Congaree is 6 km, which is luck.
 *
 * So on 337 of 343 freshwater waters the only thing that made clarity move day to day was rain in
 * another part of the state, and on the TVA lakes another part of the country. No sensitivity
 * constant can fix a rainfall reading taken 226 km away.
 *
 * THE POINT WAS ALWAYS IN SCOPE AT THE CALLER. `/conditions` computes `lat`/`lon`, hands them to
 * tideBlock() on the line above this call, and puts them in its own response as `point`. It passed
 * the display NAME only.
 *
 * The six profiles keep their own centers: those were chosen per lake by someone who fishes them,
 * and a launch-point rainfall is not an improvement on a deliberate choice. `rainPoint` goes into
 * the payload either way, because a number that arrives without saying where it was measured is
 * exactly what this was.
 */
async function getLakeClarity(lakeName, tripDate, env, point = null, opts = {}) {
  const key = lakeKeyFromName(lakeName);
  const at = point && Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lon))
    ? [Number(point.lat), Number(point.lon)] : null;
  const water = await registryWaterFor(env, lakeName, (opts && opts.slug) || (point && point.slug) || null);
  // ── A HAND PROFILE IS ONE LAKE'S, NOT EVERY NAME THAT CONTAINS ITS WORD ─────────────────────
  //
  // lakeKeyFromName() matches a fragment anywhere in the name. Measured 2026-09-24 over the
  // registry's names: "Wateree River (Richland Co, SC)" -- a river -- got Lake Wateree's six zones,
  // its ramps and its rain point; "Graves Lake (Marion Co, SC)" and "Russ Lake (Marion Co, SC)" got
  // Lake Marion's from their COUNTY; and Thurmond's legacy "Murray Creek - Clarks Hill Lake" got
  // Lake Murray's. Each profile now carries the slug of the water it was written for, and when the
  // request resolves to a registry water, only that water gets it. With no registry to resolve
  // against, the fragment match stands, as before.
  const handFor = LAKE_CLARITY_PROFILES[key] || null;
  const hand = handFor && (!water.slug || !handFor.slug || handFor.slug === water.slug) ? handFor : null;

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
  // A river piece's two generic zones are its two ends, not a lake's arms and basin.
  const isRiverWater = !!(water.index && water.slug && water.index[water.slug]
    && water.index[water.slug].feature_type === 'river');
  const genericZones = isRiverWater ? GENERIC_RIVER_ZONES : GENERIC_LAKE_ZONES;
  if (isCoastal) {
    defaultProfile = {
      displayName: lakeName,
      // The caller's own point where it gave one. Charleston only as the last resort, and the
      // note below says which happened.
      center: at || [32.77, -79.93],
      defaultNote: "Tidal flush regulates clarity. Upper/marsh creeks stain after heavy local runoff; inlets and open sounds stay clearer via ocean exchange."
        + (at ? "" : " RAINFALL IS FROM CHARLESTON, not this zone — no point was given."),
      zones: [
        { name: "Inshore Creeks / Upper Marsh", sensitivity: 1.2, base: 10, likely: "stains first from land/marsh runoff after rain", ramps: [] },
        { name: "Inlets / Outer Sound / Open Water", sensitivity: 0.7, base: 3, likely: "clearest water via ocean tidal exchange", ramps: [] }
      ]
    };
  } else {
    // ── THIS WATER'S OWN RAIN SENSITIVITY, FROM ITS OWN WATERSHED OR ITS OWN READINGS ─────────
    //
    // The two generic zones used to carry the same 1.2 and 0.75 on every water. Now a lake's
    // level comes from its flush ratio in water_chain.json, ranked across every lake, and a
    // river's from how much murkier its own readings run above normal flow than at it
    // (river_clarity_by_flow.json), ranked across every river. Both are placed on those same two
    // numbers' range, and each zone keeps its share of the spread. A water neither ranking placed
    // keeps the generic rates and says why. See Worker/clarity-sensitivity.js for the method.
    const shed = isRiverWater
      ? riverFlowSensitivity(water.flowTable, water.slug)
      : watershedSensitivity(water.chain, water.slug, { index: water.index });
    const own = shed.source === 'watershed' || shed.source === 'river-flow';
    defaultProfile = {
      displayName: lakeName,
      center: at || [34, -81],
      defaultNote: (isRiverWater
          ? `A river's two zones are its upper and lower reaches. ${own
              ? `Its rain response is its own: ${shed.why}.`
              : `It keeps the generic rain rates: ${shed.why}.`} Where its flow sits against its `
            + 'normal, and its own clarity at that flow, are on the card.'
          : own
            ? `No hand-written zones for this water. Its rain response is its own: ${shed.why}.`
            : "No custom clarity model yet; generic creek/runoff model used.")
        + (at ? "" : " RAINFALL IS FROM A FIXED POINT NEAR COLUMBIA, SC, not this water — no "
                   + "point was given, and on most waters that is over 200 km away."),
      zones: own
        ? zonesForSensitivity(shed.value, genericZones)
        : genericZones.map((z) => ({ ...z, ramps: [] })),
      sensitivity: shed,
    };
  }

  const profile = hand || defaultProfile;
  // WHAT THE RAIN IS MULTIPLIED BY HERE, AND WHERE THAT NUMBER CAME FROM. `value` is the mean of
  // the zones actually used, which is what `overall` and `atLaunch` apply.
  const meanSens = Math.round(profile.zones.reduce((a, z) => a + z.sensitivity, 0)
    / Math.max(1, profile.zones.length) * 1000) / 1000;
  const sensitivity = hand
    ? { value: meanSens, source: 'hand-authored',
        why: `${hand.displayName}'s ${hand.zones.length} zones were written by hand, by someone who fishes it`,
        // Beside it, what its watershed alone would have said -- the cross-check, not the answer.
        watershed: (() => {
          const w = watershedSensitivity(water.chain, water.slug, { index: water.index });
          return w.source === 'watershed' ? w : null;
        })() }
    : isCoastal
      ? { value: meanSens, source: 'coastal', why: 'tidal exchange sets clarity on a coastal zone; its two zones keep their own rates' }
      : { ...defaultProfile.sensitivity, value: meanSens };
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
  // ── THE MEASURED WATER NEAREST HIS LAUNCH, NOT THE LAKE'S AVERAGE ──────────────────────────
  //
  // The WQP pull keeps each Secchi station with its own average now. On Lake Murray those run from
  // 1.7 ft at the top of the river arm to 9.0 ft near the dam, and on Hartwell from 5.3 to 16.3 ft;
  // the lake-wide mean of either is water nobody launches into. So when the caller says the point
  // IS the launch, the baseline is the nearest station's own reading.
  //
  // THE NEAREST, NOT A BLEND. A weighted blend needs a weighting and a radius, and both would be
  // numbers picked here. The nearest station is a measurement of real water with no parameter, and
  // the payload names it and says how far it is, so a station across a point in another arm can be
  // seen for what it is. Only for a launch: a centroid or a map tap is not where he is fishing, and
  // there the lake-wide average stays, unchanged.
  //
  // KEPT BESIDE THE ZONES, NOT MIXED INTO THEM. The zones stay exactly what they were -- the
  // lake-wide baseline plus each zone's offset -- because their job is comparing areas of the
  // lake against each other. The launch gets its own answer, `atLaunch`, below.
  const isLaunch = !!(at && point && point.isLaunch);
  const local = isLaunch && measured && Array.isArray(measured.stations)
    ? nearestClarityStation(measured.stations, at[0], at[1]) : null;
  const secchiFt = measured?.avgSecchiDepthFt ?? null;
  const ntu = measured?.recentTurbidityNTU ?? null;

  // Secchi if we have it, turbidity if we do not. Turbidity is log-distributed -- the step from
  // 1 to 5 NTU matters as much as 20 to 100 -- so it maps through log10 rather than linearly,
  // landing on the SAME Clear / Slight stain / Stained / Muddy bands the classifier already uses:
  //     1 NTU -> Clear      5 -> Slight stain      25 -> Stained      100+ -> Muddy
  // Published NTU bands, not a curve fitted to our own data. A fitted curve would look more
  // precise than it is; 166 lakes carry both measurements and can CHECK these bands instead.
  const secchiScore = (ft) => Math.max(0, Math.min(100, 75 - (ft - 1) * (70 / 11)));
  const measuredBase =
      secchiFt != null ? secchiScore(secchiFt)
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
    // ── AND WHAT THIS ZONE IS ON AN ORDINARY DAY ──────────────────────────────────────────────
    //
    // Ryan, 2026-09-15: "i just need to know what 'normal' is and how far it is off from that
    // normal... stained water means more on say lake murray than it does on wateree."
    //
    // He is right and the model already contained the answer without ever computing it. The score
    // is `base + rainScore * sensitivity`, so the SAME model with no rain in it IS this water's
    // ordinary state -- its own baseline, in its own terms, with nothing invented and no threshold
    // to pick. Wateree's normal is stained because Wateree's measured secchi is 2.4 ft; Murray's is
    // clearer because Murray's readings are. One rule, every lake, no per-lake table.
    //
    // The rainfall is the ONLY input in here that describes today. So the gap between these two
    // numbers is exactly, and only, what the weather did -- which is the thing worth telling him.
    const normalScore = Math.max(0, Math.min(100, base));
    const normalCls = classifyClarity(normalScore);
    return { ...z, score: Math.round(score), clarity: cls.clarity, select: cls.select,
             normalScore: Math.round(normalScore), normalClarity: normalCls.clarity,
             lureColors: pack2.colors, tactics: pack2.tactics };
  });
  const avg = zones.reduce((a, z) => a + z.score, 0) / Math.max(1, zones.length);
  const overall = classifyClarity(avg);
  const avgNormal = zones.reduce((a, z) => a + z.normalScore, 0) / Math.max(1, zones.length);
  const overallNormal = classifyClarity(avgNormal);
  const bestZones = [...zones].sort((a, b) => a.score - b.score).slice(0, 3);
  const dirtyZones = [...zones].sort((a, b) => b.score - a.score).slice(0, 3);
  const rampRecommendations = bestZones.map((z, i) => ({
    zone: z.name,
    ramps: z.ramps || [],
    score: Math.max(0, 100 - z.score),
    why: `${z.clarity}; ${z.likely}. ${i === 0 ? "Best clarity/safety starting point." : "Secondary option."}`
  }));
  const pack = clarityLurePack(overall.clarity);

  // ── WHAT IS NORMAL HERE, AND HOW FAR OFF IS TODAY ─────────────────────────────────────────────
  //
  // Ryan, 2026-09-15: "i just need to know what 'normal' is and how far it is off from that
  // normal... stained water means more on say lake murray than it does on wateree."
  //
  // The word on its own cannot carry that and never could. STAINED on Wateree, whose 583 measured
  // secchi readings average 2.4 ft, is Tuesday; STAINED on a lake that usually reads eight feet is
  // an event. Both are the same word, so the word has to travel with the water's own baseline.
  //
  // `overallNormal` is this model with no rain in it — the lake as it ordinarily sits — and the
  // rainfall is the only input here that describes TODAY. So `offNormal` is the number of bands the
  // weather moved it, and it is a subtraction, not a threshold: zero rain gives zero movement and
  // the honest answer is "normal for this water", which is what his dry-day card should have said
  // from the start instead of calling his home lake muddy.
  const BANDS = ["Clear", "Slight stain", "Stained", "Muddy", "Muddy / debris risk"];
  const bandIndex = (c) => Math.max(0, BANDS.indexOf(String(c)));
  const offNormal = bandIndex(overall.clarity) - bandIndex(overallNormal.clarity);
  const dirtier = offNormal > 0;
  const rainPhrase = rain && rain.weighted72_in
    ? `${rain.weighted72_in}" of weighted rain in 72 hours`
    : "no rain worth speaking of in 72 hours";
  const normally = {
    clarity: overallNormal.clarity,
    select: overallNormal.select,
    score: Math.round(avgNormal),
    // The evidence for the word, so "normal" is never just an assertion.
    basis: measuredEvidence(measured)
      || "this water's zone model — no clarity measurements exist for it",
  };
  const versusNormal = {
    bands: offNormal,
    dirtier,
    // Written the way he asked for it: what it usually is, what it is today, and what moved it.
    sentence: offNormal === 0
      ? `${overall.clarity} is NORMAL for this water — ${normally.basis}, and ${rainPhrase}.`
      : `Usually ${overallNormal.clarity} here (${normally.basis}). Today ${overall.clarity} — `
        + `${Math.abs(offNormal)} band${Math.abs(offNormal) === 1 ? "" : "s"} `
        + `${dirtier ? "DIRTIER" : "CLEANER"} than normal, on ${rainPhrase}.`,
  };

  // ── THE LAUNCH'S OWN ANSWER ────────────────────────────────────────────────────────────────
  //
  // The same model as every zone -- measured baseline, plus rain through a sensitivity -- with the
  // baseline read at the nearest station with a full record (see nearestClarityStation for why a
  // nearer one with a short record is passed over). The sensitivity is the mean of this water's
  // zones, which is exactly what `overall` already applies (a mean of zone scores is the mean base
  // plus rain times the mean sensitivity), so this adds no number the model did not already hold.
  // Null when the point is not a launch or no station on this water carries a position; the
  // client then falls back to the zone that names the ramp, then to the lake, as before.
  const atLaunch = local ? (() => {
    const sens = profile.zones.reduce((a, z) => a + z.sensitivity, 0) / Math.max(1, profile.zones.length);
    const base = secchiScore(local.avgSecchiDepthFt);
    const score = Math.max(0, Math.min(100, base + rainScore * sens));
    const cls = classifyClarity(score);
    const usual = classifyClarity(base);
    const bands = bandIndex(cls.clarity) - bandIndex(usual.clarity);
    const where = local.name || local.id;
    const lp = clarityLurePack(cls.clarity);
    return {
      station: { id: local.id, name: local.name, lat: local.lat, lon: local.lon, km: local.km,
                 avgSecchiDepthFt: local.avgSecchiDepthFt, sampleCount: local.sampleCount,
                 firstObserved: local.firstObserved, lastObserved: local.lastObserved },
      score: Math.round(score), clarity: cls.clarity, select: cls.select,
      normalScore: Math.round(base), normalClarity: usual.clarity,
      lureColors: lp.colors, tactics: lp.tactics,
      // A nearer station with a short record, if one was passed over -- see nearestClarityStation.
      passedOver: local.passedOver || null,
      why: (local.passedOver
             ? `the nearest station with a full record is ${where}, ${local.km} km away: `
             : `the nearest measured water to the launch is ${where}, ${local.km} km away: `)
         + `${local.sampleCount} Secchi reading${local.sampleCount === 1 ? "" : "s"}`
         + `${local.firstObserved ? ` ${local.firstObserved.slice(0, 4)}–${String(local.lastObserved || "").slice(0, 4)}` : ""}`
         + ` averaging ${local.avgSecchiDepthFt} ft`
         + (measured && measured.avgSecchiDepthFt != null
           ? ` (the whole lake averages ${measured.avgSecchiDepthFt} ft)` : "")
         + (local.passedOver
           ? `; ${local.passedOver.name || local.passedOver.id}, ${local.passedOver.km} km away, was `
             + `passed over -- ${local.passedOver.sampleCount} reading`
             + `${local.passedOver.sampleCount === 1 ? "" : "s"}, fewer than this water's median `
             + `station's ${local.medianRecord}, and a short record is usually one season`
           : ""),
      versusNormal: {
        bands, dirtier: bands > 0,
        sentence: bands === 0
          ? `${cls.clarity} is NORMAL near ${where}, and ${rainPhrase}.`
          : `Near ${where} it is usually ${usual.clarity}. Today ${cls.clarity} — `
            + `${Math.abs(bands)} band${Math.abs(bands) === 1 ? "" : "s"} `
            + `${bands > 0 ? "DIRTIER" : "CLEANER"} than normal, on ${rainPhrase}.`,
      },
    };
  })() : null;

  // ── WHICH OF THE TWO ZONES THE LAUNCH IS IN, ON A WATER NOBODY WROTE ZONES FOR ─────────────────
  //
  // Ryan, 2026-09-24: "i just thought it was already on all waters since i had already asked for
  // everything for one water to be on all of them". The six hand profiles name the ramps in each
  // zone, so a plan on those lakes is built on the launch's own zone. Everywhere else the two
  // generic zones named no launch, and the plan got the lake-wide mean of both.
  //
  // What puts a launch in "upper arms" or "main lake / lower basin" is where it sits between the
  // lake's OUTLET and its far end. registry/water_ends.json carries both, from NHDPlus (see
  // Scripts/build_water_ends.py), and the launch goes to the zone whose end is nearer -- the same
  // no-parameter rule as the nearest station. Measured 2026-09-24 on the 30 lakes with three or
  // more positioned Secchi stations: the far-end half is murkier than the outlet half on 21 of the
  // 26 where both halves have a station. The five that go the other way are Monticello and Keowee
  // (pumped storage: clear water is pumped in at the top), Moultrie (fed by the Diversion Canal),
  // Hiwassee, and Hartwell -- and three of those have hand profiles, which this never touches.
  //
  // Only for a launch, only without a hand profile, never on the coast; and the payload names both
  // distances so a launch near the middle is visibly near the middle.
  let launchZone = null;
  if (isLaunch && !hand && !isCoastal && water.slug && zones.length === 2) {
    try {
      const { waterEnds } = await import('./registry.js');
      const e = (await waterEnds(env))[water.slug];
      if (e && Array.isArray(e.outlet) && Array.isArray(e.far)) {
        const kmTo = (p) => {
          const r = Math.PI / 180;
          const h = Math.sin((p[0] - at[0]) * r / 2) ** 2
                  + Math.cos(at[0] * r) * Math.cos(p[0] * r) * Math.sin((p[1] - at[1]) * r / 2) ** 2;
          return Math.round(2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h))) * 10) / 10;
        };
        const outletKm = kmTo(e.outlet);
        const farKm = kmTo(e.far);
        const upper = farKm < outletKm;
        // By NAME, not position in the list: the generic table says which zone is which.
        const z = zones.find((x) => x.name === genericZones[upper ? 0 : 1].name);
        if (z) launchZone = {
          name: z.name, outletKm, farKm,
          why: `the launch is ${outletKm} km from where the lake lets out and ${farKm} km from `
             + `its far end, so it is in the ${upper ? 'upper' : 'lower'} half`,
        };
      }
    } catch (e) {
      console.warn(`[clarity] water ends unavailable for ${water.slug}: ${e.message}`);
    }
  }

  return {
    lake: profile.displayName || lakeName,
    key,
    // Which generic zone the launch is in, by where it sits between the outlet and the far end.
    launchZone,
    // The registry water this answer is about, so a caller can see it is the one it meant.
    water: water.slug,
    tripDate,
    // The launch's own clarity, read at the measured station nearest it. See `atLaunch` above.
    atLaunch,
    // WHAT RAIN IS MULTIPLIED BY ON THIS WATER, AND WHERE THAT CAME FROM: 'hand-authored' (the six),
    // 'watershed' (a lake's own flush ratio, ranked), 'river-flow' (a river's own readings above
    // normal flow against at it, ranked), 'coastal', or 'generic' with the reason.
    sensitivity,
    // WHERE THE RAIN WAS MEASURED, AND WHETHER IT IS THIS WATER. The rainfall is the only input in
    // this model that describes today, and until 2026-09-23 it came from a fixed point near
    // Columbia on every water without one of the six hand-authored profiles -- a median of 226 km
    // away over the 196 bound waters that fell to the default. A number that cannot say where it
    // was taken is how that survived, so it says.
    rainPoint: { lat: profile.center[0], lon: profile.center[1],
                 isThisWater: !!(at && profile.center === at),
                 basis: hand ? "the lake's own hand-authored point"
                      : at ? "the point the caller asked about"
                      : "A FIXED FALLBACK, NOT THIS WATER — no point was given" },
    // What this water ordinarily is, and how far today sits off it. See versusNormal above.
    normally,
    versusNormal,
    // Say which of the three this is. "Modelled" and "measured then adjusted" deserve different
    // trust, and "no measurement exists" must never render as "the water is clear".
    confidence: measured && rain ? `good: measured ${secchiFt != null ? 'secchi' : 'turbidity'} baseline + rainfall adjustment, verify at ramp`
              : measured ? `medium: measured ${secchiFt != null ? 'secchi' : 'turbidity'} baseline, no rainfall feed`
              : rain ? "medium: forecast/rainfall model only \u2014 no clarity measurements for this water"
              : "low: no rainfall feed, generic model",
    measured: measured ? {
      avgSecchiDepthFt: measured.avgSecchiDepthFt,
      minSecchiDepthFt: measured.minSecchiDepthFt,
      maxSecchiDepthFt: measured.maxSecchiDepthFt,
      sampleCount: measured.sampleCount,
      lastObserved: measured.lastObserved,
      recentTurbidityNTU: measured.recentTurbidityNTU ?? null,
      recentTurbidityLastObserved: measured.recentTurbidityLastObserved ?? null,
      fetchedAt: measured.fetchedAt,
      // Every station on this water with its own average, so the card can show the spread the
      // lake-wide number hides.
      stations: Array.isArray(measured.stations) ? measured.stations : [],
      // Whether these readings were tested for being ON this water rather than merely inside its
      // box, and which stations were left out. See Worker/research/on-water.js.
      onWater: measured.onWater || null,
      source: "Water Quality Portal (waterqualitydata.us) \u2014 NWIS + STORET",
    } : null,
    measuredNote: measured
      ? null
      : "No secchi measurements published for this water. The estimate below is a rainfall model, "
        + "not an observation \u2014 absence of data is not clear water.",
    summary: measuredEvidence(measured, true)
      ? `${profile.displayName || lakeName}: ${measuredEvidence(measured, true)}. ${rain ? `${rain.weighted72_in}" weighted rain signal moves it to ` : ''}${overall.clarity} for this trip${isRiverWater ? '' : '; creek arms dirtier than the main lake'}.`
      : rain ? `${profile.displayName || lakeName}: ${rain.weighted72_in}" weighted rain/runoff signal. ${overall.clarity} overall predicted${isRiverWater ? '' : '; upper/creek arms likely dirtier than lower/main lake'}.` : `${profile.displayName || lakeName}: generic clarity estimate. Verify locally.`,
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

  // No curated lake profile any more -- LAKE_INTEL is gone, see the note where it was. A lake's
  // profile is its RESEARCH profile, which handleEnhancedLakeIntel() attaches beside this and
  // lake-intel.js reads first; what is built here is the checklist for a water with none.
  let profile;
  if (isCoastal) {
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
    confidence: isCoastal ? "curated_profile_plus_live_scrape_when_available" : "generic_unverified_profile"
  };
}
var RIVERS = {
  wateree: {
    label: "Wateree River (below Wateree Dam)",
    operator: "Duke Energy",
    damName: "Wateree Dam",
    damLakeKey: "wateree",
    // → cross-link to LAKES.wateree pool data
    // NO dukeBasinId. It was typed here and on `broad`, and on four of the six rivers it was
    // simply absent -- so /river had a release schedule for two rivers and {error} for the rest.
    // dukeBasinFor() resolves all seven basins Duke publishes from /rivers/get-rivers plus this
    // water's own bound gauge names, and /conditions has used it since 2026-08-17.
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
    // `surgeSpeed_mph`, a typed 2.5, STOOD HERE UNTIL 2026-09-24 and is gone. Duke's own 2026-09-24
    // schedule -- generation 17:00, arrival at Highway 1/Highway 601 Landing 18:48 -- measures
    // 4.1-4.2 mph, and the time at any launch is now read off Duke's timed places on the pack's
    // centreline (surgeAt in Worker/river-geometry.js). A river with fewer than two timed places
    // gets no ETA and says why, rather than this number.
    //
    // `dukeAnchorRiverMi`, `dukeAnchorLat` and `dukeAnchorLon` went the day before, for the same
    // reason: Duke publishes the generation start outright on /rivers/active-run.
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
    // NO dukeBasinId -- see the note on `wateree`. "BroadRiver" is one token in Duke's roster
    // and dukeBasinFor() splits the case boundary before matching it.
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

export { easternOffsetFor, normalizeDukeRow, dukeRowForNames, fetchDukeFlowArrivals, fetchDukeRivers, fetchDukeActiveRun, fetchDukeAccessAlerts, fetchDukeOperatingRange, fetchDukeCalendar, parseDukeCalendar, LAKES, LAKE_INTEL_SOURCE_REGISTRY, LAKEMONSTER_IDS, LAKE_CLARITY_PROFILES, RIVERS, lakeKeyFromName, fetchText, fetchUsgs, seriesRank, rdbSeriesDescriptions, newerStamp, applyElevation, fetchLakeMonsterIntel, getLakeIntel, getLakeClarity, getLakeIntelSourceRegistry };