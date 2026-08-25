// research/limnology.js — split from worker-research.js (behavior-preserving)
// SINGLE SOURCE OF TRUTH for lake→R2 key: js/data/lake-keys.js (101 entries)
// Previously this file had a truncated copy (74 entries) with a fallback that
// generated generic lake_${base} keys on miss, masking missing entries and
// causing shoreline.geojson R2 misses → bbox self-derive failed → geospatial
// adapter / thermocline pipeline silently skipped. Fixed by importing canonical map.
import { JSON_HEADERS, r2Text } from '../worker-core.js';
import { handleResearchThermoclineSearch } from './storage.js';
import { LAKE_NAME_TO_R2_KEY as SUPPLEMENTAL_KEY_MAP, resolveR2Key } from '../../js/data/lake-keys.js';

import { boundsOf } from '../../js/utils/geojson-coords.js';

function resolveSupplementalKeyWorker(lakeName) {
  return resolveR2Key(lakeName);
}

/**
 * @param opts.secchiOnly  Return as soon as the water-clarity numbers are known.
 *
 * WHY THE FLAG RATHER THAN AN EXTRACTED FUNCTION
 *
 * getLakeClarity() needs the secchi summary this function already computes, and nothing else
 * from it. Pulling the WQP fetch and CSV parse out into a shared helper is the tidier change,
 * but it is surgery in the middle of a 336-line handler that works, and this codebase's own
 * history is refactors that stop half done. Copying the parse into a second function is worse
 * still -- that is how the attractor config ended up in two files and drifted for a month.
 *
 * So: one optional flag, and the existing call path is byte-identical when it is absent.
 *
 * It matters that this returns EARLY. Past the secchi block this function may fire an inline
 * Firecrawl guide-article search for the thermocline, which the code below deliberately gates
 * to avoid burning credits on small lakes. Clarity would trigger that on every cache miss.
 */
async function handleResearchLimnologyData(request, env, opts = {}) {
  const body = await request.json().catch(() => ({}));
  let { lakeName, bboxNorth, bboxSouth, bboxEast, bboxWest } = body;
  if (!lakeName) return new Response(JSON.stringify({ ok: false, error: 'missing lakeName' }), { status: 400, headers: JSON_HEADERS });

  // If no bbox provided, self-derive from supplemental shoreline GeoJSON (available for all lakes)
  if (bboxNorth == null || bboxSouth == null || bboxEast == null || bboxWest == null) {
    try {
      const lakeKey = resolveSupplementalKeyWorker(lakeName);
      // TWO SPELLINGS, TWO PIPELINES. `shoreline.geojson` comes from the i-Boating coastal
      // pipeline (upload_to_r2_coastal.py) and exists for COASTAL ZONES ONLY. Every freshwater
      // pack ships `garmin_shoreline.geojson` from upload_garmin_to_r2.py instead. The comment
      // above says "available for all lakes" and it never was, which is why the note at the top
      // of this file records shoreline.geojson R2 misses killing the bbox self-derive.
      const shorelineObj = await env.R2_TROLLMAP_CHARTPACKS.get(`${lakeKey}/shoreline.geojson`)
                        || await env.R2_TROLLMAP_CHARTPACKS.get(`${lakeKey}/garmin_shoreline.geojson`);
      if (!shorelineObj) throw new Error(`no shoreline.geojson or garmin_shoreline.geojson in R2 for ${lakeKey}`);
      const geo = JSON.parse(await r2Text(shorelineObj));
      const b = boundsOf(geo);
      if (!b) throw new Error('no coordinates extracted from shoreline');
      bboxWest  = b.west;
      bboxEast  = b.east;
      bboxSouth = b.south;
      bboxNorth = b.north;
      console.log(`[limnology-data] bbox self-derived from shoreline: W${bboxWest.toFixed(4)} S${bboxSouth.toFixed(4)} E${bboxEast.toFixed(4)} N${bboxNorth.toFixed(4)}`);
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: `bbox not provided and shoreline self-derive failed: ${e.message}` }), { status: 400, headers: JSON_HEADERS });
    }
  }

  // Build WQP URL manually — URLSearchParams encodes spaces as + which WQP rejects; use %20 throughout
  const enc = (s) => encodeURIComponent(s).replace(/%20/g, '%20'); // encodeURIComponent already uses %20, not +
  const wqpChars = [
    'Temperature, water',
    'Dissolved oxygen (DO)',
    'Dissolved oxygen',
    'Depth, Secchi disk depth',
    // Turbidity was NOT requested here, so `recentTurbidityNTU` below was always null and the
    // clarity fallback that depends on it could never fire. Measured 2026-08-06: 122 of our
    // lakes have turbidity and NO secchi -- Lake Norman and every TVA reservoir among them.
    'Turbidity',
  ];
  const wqpUrl = 'https://www.waterqualitydata.us/data/Result/search?' + [
    `bBox=${bboxWest},${bboxSouth},${bboxEast},${bboxNorth}`,
    // NO siteType FILTER. WQP types five of Lake Norman's clarity stations as `Stream` because
    // they sit on the Catawba corridor; filtering to lakes drops them and reports a 30,000-acre
    // reservoir as unmonitored. The bBox already constrains this to the lake -- geometry decides,
    // not the supplier's label. Same reasoning as Scripts/wqp_clarity_coverage.py.

    ...wqpChars.map(c => `characteristicName=${enc(c)}`),
    `startDateLo=01-01-2015`,
    `startDateHi=12-31-2026`,
    `mimeType=csv`,
    `zip=no`,
    `dataProfile=resultPhysChem`,
    `providers=NWIS`,
    `providers=STORET`,
  ].join('&');

  let csvText;
  try {
    const controller = new AbortController();
    const wqpTimeout = setTimeout(() => controller.abort(), 25000);
    let wqpRes;
    try {
      // Pass URL as a Request object to prevent Cloudflare from re-encoding %20 → +
      const wqpReq = new Request(wqpUrl, {
        method: 'GET',
        headers: { 'User-Agent': 'TrollMap/1.0 (fishing intelligence platform; contact: trollmap@colonal1981.workers.dev)' },
        signal: controller.signal,
      });
      wqpRes = await fetch(wqpReq);
    } finally {
      clearTimeout(wqpTimeout);
    }
    if (!wqpRes.ok) throw new Error(`WQP HTTP ${wqpRes.status}`);
    csvText = await wqpRes.text();
  } catch (e) {
    const reason = e.name === 'AbortError' ? 'WQP request timed out after 25s — try again, large lakes may need a second attempt' : `WQP fetch failed: ${e.message}`;
    console.warn(`[limnology-data] ${reason} — lake=${lakeName}`);
    return new Response(JSON.stringify({ ok: false, error: reason, thermocline: null }), { headers: JSON_HEADERS });
  }

  function parseCSVLine(line) {
    const result = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (ch === ',' && !inQ) {
        result.push(cur.trim()); cur = '';
      } else {
        cur += ch;
      }
    }
    result.push(cur.trim());
    return result;
  }

  const lines = csvText.split('\n').filter(Boolean);
  if (lines.length < 2) {
    return new Response(JSON.stringify({ ok: true, recordCount: 0, thermocline: null, oxygen: null, surfaceWater: null, note: 'No WQP monitoring data found for this lake boundary' }), { headers: JSON_HEADERS });
  }

  const headers = parseCSVLine(lines[0]);
  const col = (name) => headers.findIndex(h => h.toLowerCase().includes(name.toLowerCase()));
  const iChar = col('characteristicname');
  const iValue = col('resultmeasurevalue');
  const iUnit = col('resultmeasure/measureunitcode');
  const iDepth = col('activitydepthheightmeasure/measurevalue');
  const iDepthU = col('activitydepthheightmeasure/measureunitcode');
  const iResultDepth = col('resultdepthheightmeasure/measurevalue');
  const iResultDepthU = col('resultdepthheightmeasure/measureunitcode');
  const iDate = col('activitystartdate');
  // `programs` HAS BEEN AN EMPTY ARRAY SINCE IT WAS WRITTEN.
  //
  // `col()` is a case-insensitive SUBSTRING match against the header row, and the resultPhysChem
  // profile has no column containing "projectname" -- it has `ProjectIdentifier`. So iProject was
  // -1, `cols[-1]` is undefined in JavaScript rather than an error, `project` was '' on every
  // record, and `.filter(Boolean)` then emptied both `programs` lists. The surfaceWater block has
  // been reporting "no monitoring programs" for every lake in the app.
  //
  // ProjectIdentifier is a code like `SC-DES-AMB`; OrganizationFormalName is the readable name of
  // whoever runs it. Take the code when there is one and the organisation when there is not,
  // matching how depth already falls back from ActivityDepth to ResultDepth two lines below.
  //
  // Found 2026-08-25 by audit_upstream_fields.py, once it was taught that a column can be looked
  // up by name instead of reached by one.
  const iProject = col('projectidentifier');
  const iOrg = col('organizationformalname');

  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const char = cols[iChar] || '';
    const valRaw = cols[iValue] || '';
    const unit = cols[iUnit] || '';
    // Use ActivityDepth first, fall back to ResultDepth (GA EPD stores depth here)
    const depRaw = cols[iDepth] || cols[iResultDepth] || '';
    const depUnit = cols[iDepthU] || cols[iResultDepthU] || '';
    const date = cols[iDate] || '';
    const project = cols[iProject] || cols[iOrg] || '';
    const val = parseFloat(valRaw);
    if (isNaN(val)) continue;
    let dep = parseFloat(depRaw);
    let depthFt = null;
    if (!isNaN(dep) && dep >= 0) {
      depthFt = dep;
      if (depUnit.toLowerCase().includes('m') && !depUnit.toLowerCase().includes('ft')) depthFt = dep * 3.28084;
      depthFt = Math.round(depthFt * 10) / 10;
    }
    const lowerChar = char.toLowerCase();
    let type = null;
    if (/temperature/.test(lowerChar)) type = 'temperature';
    else if (/dissolved oxygen|oxygen/.test(lowerChar)) type = 'do';
    else if (/turbidity/.test(lowerChar)) type = 'turbidity';
    else if (/secchi/.test(lowerChar) || /depth.*secchi|secchi.*depth/.test(lowerChar)) type = 'secchi';

    else if (/conductivity/.test(lowerChar)) type = 'conductivity';
    else if (/alkalinity/.test(lowerChar)) type = 'alkalinity';
    else if (/hardness/.test(lowerChar)) type = 'hardness';
    if (!type) continue;
    let value = val;
    let outUnit = unit;
    if (type === 'temperature' && (unit.toLowerCase().includes('deg c') || unit === 'deg C' || unit === 'C')) {
      value = val * 9 / 5 + 32;
      outUnit = 'deg F';
    }
    const month = date ? parseInt(date.split('-')[1], 10) : null;
    // `location` was captured here from a column lookup that never resolved either, and nothing
    // has ever read it. Removed rather than repaired: an unread field on every record is how the
    // next person loses ten minutes deciding whether it matters.
    records.push({ type, value: Math.round(value * 100) / 100, unit: outUnit, depthFt, month, date, project });
  }

  if (records.length === 0) {
    return new Response(JSON.stringify({ ok: true, recordCount: 0, thermocline: null, oxygen: null, surfaceWater: null, note: 'WQP returned data but no usable records found' }), { headers: JSON_HEADERS });
  }

  const depthRecords = records.filter(r => r.depthFt != null);
  const summerDepthRecs = depthRecords.filter(r => r.month >= 6 && r.month <= 9);
  const summerDO = summerDepthRecs.filter(r => r.type === 'do');
  const summerTemp = summerDepthRecs.filter(r => r.type === 'temperature');
  const allDO = depthRecords.filter(r => r.type === 'do');

  let thermocline = null;
  if (summerDO.length >= 3) {
    const doBins = {};
    for (const r of summerDO) {
      const bin = Math.floor(r.depthFt / 2) * 2;
      if (!doBins[bin]) doBins[bin] = [];
      doBins[bin].push(r.value);
    }
    const sortedBins = Object.keys(doBins).map(Number).sort((a, b) => a - b);
    for (const bin of sortedBins) {
      const vals = doBins[bin].slice().sort((a, b) => a - b);
      const median = vals[Math.floor(vals.length / 2)];
      if (median < 4) {
        thermocline = { depthFt: bin, confidence: summerDO.length >= 10 ? 88 : summerDO.length >= 5 ? 75 : 60, method: 'derived_from_do_profile', evidenceCount: summerDO.length };
        break;
      }
    }
  }
  if (!thermocline && summerTemp.length >= 3) {
    const tempBins = {};
    for (const r of summerTemp) {
      const bin = Math.floor(r.depthFt / 2) * 2;
      if (!tempBins[bin]) tempBins[bin] = [];
      tempBins[bin].push(r.value);
    }
    const sortedBins = Object.keys(tempBins).map(Number).sort((a, b) => a - b);
    let maxGradient = 0, maxBin = null;
    for (let i = 1; i < sortedBins.length; i++) {
      const shallowVals = tempBins[sortedBins[i - 1]].slice().sort((a, b) => a - b);
      const deepVals = tempBins[sortedBins[i]].slice().sort((a, b) => a - b);
      const shallowMed = shallowVals[Math.floor(shallowVals.length / 2)];
      const deepMed = deepVals[Math.floor(deepVals.length / 2)];
      const gradient = shallowMed - deepMed;
      if (gradient > maxGradient) { maxGradient = gradient; maxBin = sortedBins[i]; }
    }
    if (maxBin != null && maxGradient >= 5 && maxBin >= 6) {
      thermocline = { depthFt: maxBin, confidence: summerTemp.length >= 10 ? 80 : summerTemp.length >= 5 ? 65 : 50, method: 'derived_from_temp_gradient', evidenceCount: summerTemp.length };
    }
  }

  let oxygen = null;
  if (allDO.length >= 3) {
    const bins = {};
    for (const r of allDO) {
      const bin = Math.floor(r.depthFt / 2) * 2;
      if (!bins[bin]) bins[bin] = [];
      bins[bin].push(r.value);
    }
    const sortedBins = Object.keys(bins).map(Number).sort((a, b) => a - b);
    let anoxicBelowFt = null;
    for (const bin of sortedBins) {
      const vals = bins[bin].slice().sort((a, b) => a - b);
      const median = vals[Math.floor(vals.length / 2)];
      if (median < 2) { anoxicBelowFt = bin; break; }
    }
    oxygen = { anoxicBelowFt, note: anoxicBelowFt != null ? `Median dissolved oxygen drops below 2 mg/L near ${anoxicBelowFt} ft in available depth-profile samples.` : null };
  }

  const latestDateByType = {};
  for (const r of records) {
    if (!latestDateByType[r.type] || r.date > latestDateByType[r.type]) latestDateByType[r.type] = r.date;
  }
  const summarizeType = (type) => {
    const latestDate = latestDateByType[type];
    if (!latestDate) return null;
    const vals = records.filter(r => r.type === type && r.date === latestDate).map(r => r.value).filter(v => isFinite(v));
    if (!vals.length) return null;
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const programs = [...new Set(records.filter(r => r.type === type && r.date === latestDate).map(r => r.project).filter(Boolean))];
    return { value: Math.round(avg * 100) / 100, lastObserved: latestDate, sampleCount: vals.length, programs };
  };

  // Seasonal surface temp summary — useful for shallow lakes where thermocline is never derivable
  const seasonalTemp = (() => {
    const byMonth = {};
    for (const r of records.filter(r => r.type === 'temperature' && r.month)) {
      if (!byMonth[r.month]) byMonth[r.month] = [];
      byMonth[r.month].push(r.value);
    }
    const avg = (arr) => arr.length ? Math.round(arr.reduce((a,b) => a+b,0) / arr.length * 10) / 10 : null;
    const validF = (arr) => arr.filter(v => v >= 32 && v <= 110); // sanity-clamp: realistic water temps in °F
    const summerMonths = [6,7,8,9].filter(m => byMonth[m]?.length);
    const winterMonths = [12,1,2,3].filter(m => byMonth[m]?.length);
    return {
      summerAvgTempF: summerMonths.length ? avg(validF(summerMonths.flatMap(m => byMonth[m]))) : null,
      winterAvgTempF: winterMonths.length ? avg(validF(winterMonths.flatMap(m => byMonth[m]))) : null,
      peakSummerTempF: summerMonths.length ? (() => {
        const validTemps = summerMonths.flatMap(m => byMonth[m]).filter(v => v >= 32 && v <= 110);
        return validTemps.length ? Math.round(Math.max(...validTemps) * 10) / 10 : null;
      })() : null,
      monthsObserved: Object.keys(byMonth).map(Number).sort((a,b) => a-b),
    };
  })();

  // Secchi depth summary
  const secchiRecords = records.filter(r => r.type === 'secchi');
  const secchi = secchiRecords.length ? (() => {
    const vals = secchiRecords.map(r => {
      // Secchi is often in meters — convert to ft
      let v = r.value;
      // Convert to feet — WQP uses 'm' (pCode 00078) or 'in' (pCode 00077)
      const u = (r.unit || '').toLowerCase().trim();
      if (u === 'm' || u === 'meters' || u === 'meter') v = v * 3.28084;
      else if (u === 'in' || u === 'inches' || u === 'inch') v = v / 12;
      return Math.round(v * 10) / 10;
    }).filter(v => v > 0 && v <= 40); // cap at 40ft — max realistic freshwater Secchi; removes bad records
    if (!vals.length) return null;
    const avg = vals.reduce((a,b) => a+b,0) / vals.length;
    return {
      avgSecchiDepthFt: Math.round(avg * 10) / 10,
      minSecchiDepthFt: Math.min(...vals),
      maxSecchiDepthFt: Math.max(...vals),
      sampleCount: vals.length,
      lastObserved: secchiRecords.map(r => r.date).sort().slice(-1)[0] || null,
    };
  })() : null;

  // EACH CHARACTERISTIC CARRIES ITS OWN SAMPLE DATE.
  //
  // `lastObserved` below is the NEWEST of temperature, DO and turbidity and it stays, because
  // consumers read it. But it is the wrong date to print beside any one of them: on a lake where
  // DO was sampled this summer and temperature last December, the group's date makes the
  // temperature look eight months fresher than it is.
  //
  // These are grab samples of whatever age WQP last recorded, and nothing refreshes them. Lake
  // Norman's temperature is 43.88F from 2025-12-16, and it was reaching an August Smart Plan
  // prompt as "recent surface water about 43.88F" -- undated, in the same prompt as a live 85.5F
  // reading off USGS 00010 at 0214264790. The prose that hands these to a model has to be able
  // to date them, and it could not, because `summarizeType` already computes the per-type date
  // and it was being thrown away on write.
  const swTemp = summarizeType('temperature');
  const swDO = summarizeType('do');
  const swTurbidity = summarizeType('turbidity');
  const surfaceWater = {
    recentTempF: swTemp?.value ?? null,
    recentTempLastObserved: swTemp?.lastObserved ?? null,
    recentDissolvedOxygenMgL: swDO?.value ?? null,
    recentDissolvedOxygenLastObserved: swDO?.lastObserved ?? null,
    recentTurbidityNTU: swTurbidity?.value ?? null,
    recentTurbidityLastObserved: swTurbidity?.lastObserved ?? null,
    recentConductivity: summarizeType('conductivity')?.value ?? null,
    recentAlkalinityMgL: summarizeType('alkalinity')?.value ?? null,
    recentHardnessMgL: summarizeType('hardness')?.value ?? null,
    lastObserved: [swTemp?.lastObserved, swDO?.lastObserved, swTurbidity?.lastObserved].filter(Boolean).sort().slice(-1)[0] || null,
    programs: [...new Set(records.map(r => r.project).filter(Boolean))],
    note: 'Summary reflects the most recent available surface/grab samples by characteristic from WQP/SCDES monitoring sites within the lake boundary.'
  };


  // Clarity only ever wants these. Return before the Firecrawl-backed thermocline search below.
  if (opts.secchiOnly) {
    return new Response(JSON.stringify({
      ok: true,
      lakeName,
      recordCount: records.length,
      secchi,
      recentTurbidityNTU: surfaceWater.recentTurbidityNTU,
      lastObserved: records.map(r => r.date).filter(Boolean).sort().slice(-1)[0] || null,
    }), { headers: JSON_HEADERS });
  }

  const surfaceOnlyNote = !thermocline && !depthRecords.length
    ? 'Monitoring data were found, but available records are surface/grab samples only — no vertical depth profiles. Thermocline cannot be derived from this source.'
    : null;

  // Trigger guide article search whenever thermocline is null — surface-only OR insufficient depth data
  let thermoclineAnecdotal = null;
  let thermoclineSearchResults = null;
  // Only fire thermocline search if WQP had NO depth data at all (not surface-only — that still has useful data)
  // This prevents burning Firecrawl credits on every small lake that lacks depth profiling
  if (!thermocline && depthRecords.length === 0) {
    try {
      console.log(`[limnology-data] no thermocline derived — triggering inline guide article search for ${lakeName}`);
      const tcReq = new Request('internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lakeName })
      });
      const tcRes = await handleResearchThermoclineSearch(tcReq, env);
      if (tcRes.ok) {
        const tcData = await tcRes.clone().json();
        thermoclineAnecdotal = tcData.thermocline || null;
        thermoclineSearchResults = { articles: tcData.articles || [], queryResults: tcData.queryResults || [], note: tcData.note };
        console.log(`[limnology-data] thermocline search: ${thermoclineAnecdotal ? thermoclineAnecdotal.summerThermoclineDepthFt + 'ft anecdotal' : 'no result'}`);
      }
    } catch (e) {
      console.warn(`[limnology-data] inline thermocline search failed: ${e.message}`);
    }
  }

  const out = {
    ok: true,
    lakeName,
    recordCount: records.length,
    depthProfileCount: depthRecords.length,
    summerRecords: summerDepthRecs.length,
    lastObserved: records.map(r => r.date).filter(Boolean).sort().slice(-1)[0] || null,
    thermocline,
    thermoclineAnecdotal,
    thermoclineSearch: thermoclineSearchResults,
    oxygen,
    surfaceWater,
    seasonalTemp,
    secchi,
    surfaceOnlyNote,
    note: thermocline ? null : depthRecords.length ? 'Depth-profile records exist but were insufficient to derive a defensible thermocline.' : surfaceOnlyNote,
  };
  return new Response(JSON.stringify(out), { headers: JSON_HEADERS });
}

/**
 * Measured water clarity for one lake, cached in R2.
 *
 * The Water Quality Portal takes up to 25 seconds for a large lake, so it cannot be called
 * while somebody is waiting for a clarity answer. It is also monitored roughly MONTHLY -- Lake
 * Murray has 39 secchi readings across two years -- so a fresh fetch per request would be 25
 * seconds spent re-reading a number that changes twelve times a year.
 *
 * Cached in R2 rather than committed to the repo as a data file. A committed snapshot is what
 * `data/tristate-*.json` were, and they shadowed the live DNR feeds for a month without anyone
 * noticing. A cache with a TTL goes stale loudly (the timestamp is in the payload) and heals
 * itself; a file in git goes stale silently and needs a human to remember.
 *
 * Returns null when there is no measurement -- which is NOT the same as clear water, and the
 * caller has to keep those apart. SC and GA are well covered; NC is thin; TN reservoirs have
 * effectively nothing, because TVA does not submit secchi to WQP under these characteristic
 * names. See USGS_NOAA_DATASET_SWEEP_2026-08-06.md.
 */
const SECCHI_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // monthly sampling; 30 days is already generous

async function getSecchiSummary(env, lakeName) {
  if (!lakeName || !env?.R2_TROLLMAP_CHARTPACKS) return null;
  const key = `clarity-cache/${resolveSupplementalKeyWorker(lakeName)}.json`;

  try {
    const hit = await env.R2_TROLLMAP_CHARTPACKS.get(key);
    if (hit) {
      const cached = JSON.parse(await r2Text(hit));
      if (cached.fetchedAt && Date.now() - Date.parse(cached.fetchedAt) < SECCHI_TTL_MS) return cached;
      // Stale. Fall through and refetch, but keep it as the fallback if WQP is down --
      // a month-old measurement beats a guess.
      var stale = cached;
    }
  } catch (e) {
    console.warn(`[clarity] cache read failed for ${lakeName}: ${e.message}`);
  }

  try {
    const req = new Request('internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lakeName }),
    });
    const res = await handleResearchLimnologyData(req, env, { secchiOnly: true });
    const data = await res.json();
    // Secchi OR turbidity. Measured 2026-08-06 across 512 inland lakes: 170 have secchi, 288
    // have turbidity, and 122 have turbidity and no secchi -- including Lake Norman and every
    // TVA reservoir. Requiring secchi threw all of those away and fell back to guessing.
    if (!data.ok || (!data.secchi && data.recentTurbidityNTU == null)) {
      console.log(`[clarity] no clarity measurements for ${lakeName} (${data.recordCount || 0} WQP records)`);
      return (typeof stale !== 'undefined' && stale) || null;
    }
    const out = {
      lakeName,
      fetchedAt: new Date().toISOString(),
      ...(data.secchi || {}),
      recentTurbidityNTU: data.recentTurbidityNTU ?? null,
      basis: data.secchi ? 'secchi' : 'turbidity',
      lastObserved: data.lastObserved || null,
    };
    await env.R2_TROLLMAP_CHARTPACKS.put(key, JSON.stringify(out), {
      httpMetadata: { contentType: 'application/json' },
    }).catch(e => console.warn(`[clarity] cache write failed for ${lakeName}: ${e.message}`));
    return out;
  } catch (e) {
    // Distinguish "no data" from "lookup failed" -- returning null for both is the defect
    // Stage 5 of the refactor plan is about. A stale reading is a real measurement; say so.
    console.warn(`[clarity] WQP lookup failed for ${lakeName}: ${e.message}`);
    return (typeof stale !== 'undefined' && stale) || null;
  }
}

export { SUPPLEMENTAL_KEY_MAP, resolveSupplementalKeyWorker, handleResearchLimnologyData, getSecchiSummary };
