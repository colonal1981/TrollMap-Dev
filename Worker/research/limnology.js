// research/limnology.js — split from worker-research.js (behavior-preserving)
import { JSON_HEADERS } from '../worker-core.js';
import { handleResearchThermoclineSearch } from './storage.js';

const SUPPLEMENTAL_KEY_MAP = {
  'Lake Marion, SC': 'lake_marion', 'Lake Moultrie, SC': 'lake_moultrie',
  'Lake Murray, SC': 'lake_murray', 'Lake Wateree, SC': 'lake_wateree_fishing_creek',
  'Fishing Creek Reservoir, SC': 'lake_wateree_fishing_creek', 'Lake Wylie, SC/NC': 'lake_wylie',
  'Lake Hartwell, SC/GA': 'lake_hartwell', 'Lake Greenwood, SC': 'lake_greenwood_secession',
  'Lake Secession, SC': 'lake_greenwood_secession', 'Lake Keowee, SC': 'lake_keowee',
  'Lake Jocassee, SC/NC': 'lake_jocassee', 'Lake Russell, SC/GA': 'lake_thurmond_russell',
  'Lake Russell, GA': 'lake_thurmond_russell', 'Lake Russell, SC': 'lake_thurmond_russell',
  'Richard B. Russell Lake, GA': 'lake_thurmond_russell', 'Clarks Hill / Thurmond, SC/GA': 'lake_thurmond_russell',
  'Lake Thurmond, SC': 'lake_thurmond_russell', 'Clarks Hill Lake, GA': 'lake_thurmond_russell',
  'Lake Monticello, SC': 'lake_monticello_parr', 'Parr Reservoir, SC': 'lake_monticello_parr',
  'Lake Robinson, SC': 'north_saluda_reservoir', 'Lake Bowen, SC': 'lake_bowen', 'Lake Blalock, SC': 'lake_blalock',
  'Lake Norman, NC': 'lake_norman_mountain_island', 'Mountain Island Lake, NC': 'lake_norman_mountain_island',
  'Lake Norman (South), NC': 'lake_norman', 'Lake Hickory, NC': 'lake_hickory_rhodhiss',
  'Lake Rhodhiss, NC': 'lake_hickory_rhodhiss', 'Lake James, NC': 'lake_james',
  'High Rock Lake, NC': 'yadkin_river_chain', 'Badin Lake, NC': 'yadkin_river_chain',
  'Lake Tillery, NC': 'yadkin_river_chain', 'Blewett Falls Lake, NC': 'yadkin_river_chain',
  'Jordan Lake, NC': 'jordan_lake', 'Falls Lake, NC': 'falls_lake',
  'W. Kerr Scott Reservoir, NC': 'w_kerr_scott_reservoir', 'Shearon Harris Reservoir, NC': 'shearon_harris_reservoir',
  'Randleman Lake, NC': 'randleman_lake', 'Lake Mackintosh, NC': 'lake_mackintosh',
  'Lake Townsend, NC': 'lake_townsend', 'Lake Michie / Little River, NC': 'lake_michie',
  'Belews Lake, NC': 'belews_lake', 'Hyco Lake, NC': 'hyco_lake', 'Mayo Lake, NC': 'mayo_lake',
  'Nantahala Lake, NC': 'nantahala_lake', 'Lake Santeetlah, NC': 'lake_santeetlah',
  'Hiwassee Lake, NC': 'hiwassee_lake', 'Fontana Lake, NC': 'fontana_lake', 'Lake Cheoah, NC': 'lake_cheoah',
  'Lake Oconee, GA': 'lake_oconee', 'Lake Sinclair, GA': 'lake_sinclair', 'Lake Lanier, GA': 'lake_lanier',
  'Lake Jackson, GA': 'lake_juliette_high_falls', 'Lake Juliette / High Falls, GA': 'lake_juliette_high_falls',
  'Lake Blackshear, GA': 'lake_blackshear', 'Lake Allatoona, GA': 'lake_allatoona',
  'Tobesofkee Reservoir, GA': 'tobesofkee_reservoir', 'Lake Blue Ridge, GA': 'lake_blue_ridge',
  'Lake Nottely, GA': 'lake_nottely', 'Lake Burton, GA': 'lake_burton', 'Lake Chatuge, GA/NC': 'lake_chatuge',
  'Norris Lake, TN': 'norris_lake', 'Norris Reservoir, TN': 'norris_lake',
  'Douglas Lake, TN': 'douglas_lake', 'Douglas Reservoir, TN': 'douglas_lake',
  'Cherokee Lake, TN': 'cherokee_lake', 'Cherokee Reservoir, TN': 'cherokee_lake',
  'Fort Loudoun Lake, TN': 'fort_loudoun_lake', 'Fort Loudoun Reservoir, TN': 'fort_loudoun_lake',
  'Tellico Lake, TN': 'tellico_lake', 'Tellico Reservoir, TN': 'tellico_lake',
  'Watauga Lake, TN': 'watauga_boone_chain', 'Boone Lake, TN': 'watauga_boone_chain',
  'Boone Reservoir, TN': 'watauga_boone_chain',
};
function resolveSupplementalKeyWorker(lakeName) {
  if (!lakeName) return null;
  if (SUPPLEMENTAL_KEY_MAP[lakeName]) return SUPPLEMENTAL_KEY_MAP[lakeName];
  const stripped = lakeName.replace(/,\s*[A-Z]{2}(\/[A-Z]{2})?$/, '').trim();
  if (SUPPLEMENTAL_KEY_MAP[stripped]) return SUPPLEMENTAL_KEY_MAP[stripped];
  const dl = stripped.toLowerCase();
  const found = Object.entries(SUPPLEMENTAL_KEY_MAP).find(([k]) => {
    const kl = k.toLowerCase().replace(/,\s*[a-z]{2}(\/[a-z]{2})?$/, '').trim();
    return dl.includes(kl) || kl.includes(dl);
  });
  if (found) return found[1];
  const base = lakeName.split(',')[0].trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  return base.startsWith('lake_') ? base : `lake_${base}`;
}

async function handleResearchLimnologyData(request, env) {
  const body = await request.json().catch(() => ({}));
  let { lakeName, bboxNorth, bboxSouth, bboxEast, bboxWest } = body;
  if (!lakeName) return new Response(JSON.stringify({ ok: false, error: 'missing lakeName' }), { status: 400, headers: JSON_HEADERS });

  // If no bbox provided, self-derive from supplemental shoreline GeoJSON (available for all lakes)
  if (bboxNorth == null || bboxSouth == null || bboxEast == null || bboxWest == null) {
    try {
      const lakeKey = resolveSupplementalKeyWorker(lakeName);
      const shorelineObj = await env.R2_TROLLMAP_CHARTPACKS.get(`supplemental/${lakeKey}/shoreline.geojson`);
      if (!shorelineObj) throw new Error(`no shoreline.geojson in R2 for ${lakeKey}`);
      const geo = JSON.parse(await shorelineObj.text());
      const coords = [];
      const extractCoords = (obj) => {
        if (!obj) return;
        if (obj.type === 'Feature') extractCoords(obj.geometry);
        else if (obj.type === 'FeatureCollection') obj.features?.forEach(extractCoords);
        else if (obj.coordinates) {
          const flat = obj.coordinates.flat(Infinity);
          const stride = (flat.length % 3 === 0 && flat.length % 2 !== 0) ? 3 : 2;
          for (let i = 0; i < flat.length - stride + 1; i += stride) coords.push([flat[i], flat[i+1]]);
        }
      };
      extractCoords(geo);
      if (!coords.length) throw new Error('no coordinates extracted from shoreline');
      const lons = coords.map(c => c[0]);
      const lats = coords.map(c => c[1]);
      bboxWest  = Math.min(...lons);
      bboxEast  = Math.max(...lons);
      bboxSouth = Math.min(...lats);
      bboxNorth = Math.max(...lats);
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
  ];
  const wqpUrl = 'https://www.waterqualitydata.us/data/Result/search?' + [
    `bBox=${bboxWest},${bboxSouth},${bboxEast},${bboxNorth}`,
    `siteType=${enc('Lake, Reservoir, Impoundment')}`,
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
  const iProject = col('projectname');
  const iLoc = col('monitoringlocationname');

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
    const project = cols[iProject] || '';
    const location = cols[iLoc] || '';
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
    records.push({ type, value: Math.round(value * 100) / 100, unit: outUnit, depthFt, month, date, project, location });
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

  const surfaceWater = {
    recentTempF: summarizeType('temperature')?.value ?? null,
    recentDissolvedOxygenMgL: summarizeType('do')?.value ?? null,
    recentTurbidityNTU: summarizeType('turbidity')?.value ?? null,
    recentConductivity: summarizeType('conductivity')?.value ?? null,
    recentAlkalinityMgL: summarizeType('alkalinity')?.value ?? null,
    recentHardnessMgL: summarizeType('hardness')?.value ?? null,
    lastObserved: [summarizeType('temperature')?.lastObserved, summarizeType('do')?.lastObserved, summarizeType('turbidity')?.lastObserved].filter(Boolean).sort().slice(-1)[0] || null,
    programs: [...new Set(records.map(r => r.project).filter(Boolean))],
    note: 'Summary reflects the most recent available surface/grab samples by characteristic from WQP/SCDES monitoring sites within the lake boundary.'
  };


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

export { SUPPLEMENTAL_KEY_MAP, resolveSupplementalKeyWorker, handleResearchLimnologyData };
