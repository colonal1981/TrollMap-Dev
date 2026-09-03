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
import { lakeIndex, resolveRegistryRow, identityNamesForLake } from '../registry.js';
import { researchStorageId, resolveResearchStorageId } from './keys.js';
import { applyWqpToLimnology, buildWqpEvidence, limnologyGaps } from '../../js/utils/wqp-limnology.js';

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
/**
 * THE WQP PULL, CACHED FOR THIRTY DAYS, MERGED, AND ASKED WHAT IT COULD NOT ANSWER.
 *
 * Ryan, 2026-09-02: *"is there any reason why that can't be initially pulled in the pipeline and
 * then reran every 30 days automatically and then merged back in? that is what i want to happen
 * ... we need the wqp to be there so as to know whether limnology information is needed to be
 * pulled from the facts."*
 *
 * No reason, and it was already step 4 of his own 2026-09-01 plan -- "give WQP a TTL and put its
 * refresh on the existing cron" -- written beside step 3, the sequencer, which shipped that day
 * without it. `/research/save` replaces rather than merges, so step 3 alone deleted what step 5
 * said to keep. Measured on Wateree the next morning: thermocline, anoxic depth, Secchi and
 * trophic status all null, on 64 waters.
 *
 * THIRTY DAYS IS THE SAMPLING RATE, NOT A GUESS. WQP's underlying monitoring is monthly and
 * publishes months-to-years-old samples; getSecchiSummary() below already uses the same TTL for
 * the same reason, and the 08-24 plan wrote it down: "A 30-day TTL refetches three times per new
 * sample." The cache carries `fetchedAt` so it goes stale loudly, and a fetch that fails serves
 * the stale copy rather than a null -- an old thermocline is worth incomparably more than none.
 *
 * `base` is optional. Send the profile's current limnology block and the response carries
 * `merged` (WQP applied over it), `evidence` (the citation rows for what WQP actually supplied)
 * and `gaps` (the fields WQP could NOT answer). The caller stores the first two and passes the
 * third to extraction, so a document is asked only for the limnology the measurement missed.
 */
async function handleResearchLimnologyData(request, env, opts = {}) {
  const body = await request.json().catch(() => ({}));
  const lakeName = String(body.lakeName || body.lake || '').trim();
  if (!lakeName) return new Response(JSON.stringify({ ok: false, error: 'missing lakeName' }), { status: 400, headers: JSON_HEADERS });

  const pull = await wqpCached(env, lakeName, body, opts);
  const base = body.base && typeof body.base === 'object' ? body.base : null;
  const merged = base ? applyWqpToLimnology(base, pull) : null;
  return new Response(JSON.stringify({
    ...pull,
    ...(merged ? { merged, evidence: buildWqpEvidence(pull), gaps: limnologyGaps(merged) } : {}),
  }), { headers: JSON_HEADERS });
}

const WQP_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // monthly sampling underneath; see above

/**
 * The id the PROFILE is stored under, which is the only id the thirty-day sweep can pair against.
 *
 * researchStorageId() is not that id. It sanitises whatever name it is handed, and the two sides
 * hand it different names: the batch passes the registry display name "Wateree Lake (Kershaw Co,
 * SC)" -> `wateree_lake_kershaw_co_sc`, while the profile has been filed under `lake_wateree_sc`
 * since before August. researchStorageIdCandidates() exists precisely because of that spread --
 * "Every profile written before August is under the second spelling" -- and resolving against the
 * bucket is what /research/get and /research/save already do.
 *
 * Get this wrong and nothing errors: the batch writes its cache under one id, the sweep looks for
 * it under another, and every water on the card reads as never-pulled forever. HEAD, not GET, so
 * resolving costs no bodies.
 */
async function limnologyCacheId(env, lakeName) {
  try {
    const bucket = env?.R2_TROLLMAP_CHARTPACKS;
    if (bucket?.head) {
      // EVERY NAME THE WATER IS FILED UNDER, the way handleResearchGet does it. The registry
      // display name alone is not enough and the candidate list proves it: "Wateree Lake (Kershaw
      // Co, SC)" generates wateree_lake, wateree_lake_sc and wateree_lake_kershaw_co_sc, and the
      // profile is `lake_wateree_sc` -- reachable only through the legacy name the registry
      // carries. That is the same 404 that sent J. Strom Thurmond back through the whole pipeline
      // on 2026-08-16.
      const alts = identityNamesForLake(await lakeIndex(env), lakeName) || [];
      const found = await resolveResearchStorageId(lakeName,
        (id) => bucket.head(`lakes/${id}.json`), alts);
      if (found) return found.id;
    }
  } catch (e) {
    console.warn(`[limnology-data] storage id resolve failed for ${lakeName}: ${e.message}`);
  }
  return researchStorageId(lakeName);
}

/** The pull, or the newest one inside the TTL. Never throws: a bad fetch serves the stale copy. */
async function wqpCached(env, lakeName, body, opts, knownId = null) {
  // A SECCHI-ONLY PULL IS NOT A WQP PULL AND MUST NEVER BE STORED AS ONE. `opts.secchiOnly`
  // returns early with `{ok, recordCount, secchi, recentTurbidityNTU, lastObserved}` and NO
  // thermocline, oxygen or surfaceWater. Caching that under the shared key would serve a payload
  // with a null thermocline to every later caller for thirty days -- the exact defect this whole
  // change exists to repair, reintroduced by its own cache. getSecchiSummary() calls wqpPull()
  // directly and keeps its own clarity-cache, so nothing is lost by refusing here.
  if (opts && opts.secchiOnly) return (await wqpPull(env, { ...body, lakeName }, opts)).json();
  const key = `limnology-cache/${knownId || await limnologyCacheId(env, lakeName)}.json`;
  let stale = null;
  try {
    const hit = env?.R2_TROLLMAP_CHARTPACKS ? await env.R2_TROLLMAP_CHARTPACKS.get(key) : null;
    if (hit) {
      const cached = JSON.parse(await r2Text(hit));
      if (cached.fetchedAt && Date.now() - Date.parse(cached.fetchedAt) < WQP_TTL_MS) return cached;
      stale = cached;
    }
  } catch (e) {
    console.warn(`[limnology-data] cache read failed for ${lakeName}: ${e.message}`);
  }

  let fresh = null;
  try {
    const res = await wqpPull(env, { ...body, lakeName }, opts);
    fresh = await res.json();
  } catch (e) {
    console.warn(`[limnology-data] pull failed for ${lakeName}: ${e.message}`);
  }
  // A PULL THAT CAME BACK EMPTY MUST NOT EVICT A GOOD ONE. WQP answers `ok` with zero records
  // when its own service is having a bad day as readily as when a lake is genuinely unmonitored,
  // and the difference is invisible from here.
  if (!fresh || !fresh.ok || !(fresh.recordCount > 0)) {
    if (stale) {
      console.warn(`[limnology-data] serving stale WQP for ${lakeName} (fetched ${stale.fetchedAt})`);
      return stale;
    }
    return fresh || { ok: false, error: 'WQP pull failed and no cached copy exists', thermocline: null };
  }

  fresh.fetchedAt = new Date().toISOString();
  try {
    if (env?.R2_TROLLMAP_CHARTPACKS) {
      await env.R2_TROLLMAP_CHARTPACKS.put(key, JSON.stringify(fresh),
        { httpMetadata: { contentType: 'application/json' } });
    }
  } catch (e) {
    console.warn(`[limnology-data] cache write failed for ${lakeName}: ${e.message}`);
  }
  return fresh;
}

async function wqpPull(env, body, opts = {}) {

  let { lakeName, bboxNorth, bboxSouth, bboxEast, bboxWest } = body;

  // THE REGISTRY CARRIES A BOX FOR EVERY WATER AND THIS ASKED R2 FOR A FILE INSTEAD.
  //
  // The self-derive below reads `<key>/shoreline.geojson` or `<key>/garmin_shoreline.geojson`,
  // and 157 of the shipped packs have neither -- that is
  // THE_SAME_TRAPDOOR_OPENED_UNDER_157_LAKES_2026-08-23, where North Saluda logged "WQP: could
  // not derive bbox — skipping" and WQP was silently missing 42% of the card. The browser was
  // fixed that day by reading `bounds_wsen` off lake_index.json; this endpoint never was, and it
  // is the one the batch calls. Counted 2026-09-02: 358 of 358 registry rows carry bounds_wsen.
  if (bboxNorth == null || bboxSouth == null || bboxEast == null || bboxWest == null) {
    try {
      const row = resolveRegistryRow(await lakeIndex(env), lakeName);
      const b = row && (row.bounds_wsen || row.boundsWSEN);
      if (Array.isArray(b) && b.length === 4 && b.every((n) => Number.isFinite(Number(n)))) {
        [bboxWest, bboxSouth, bboxEast, bboxNorth] = b.map(Number);
        console.log(`[limnology-data] bbox from registry bounds_wsen for ${lakeName}`);
      }
    } catch (e) {
      console.warn(`[limnology-data] registry bbox lookup failed for ${lakeName}: ${e.message}`);
    }
  }

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
  // THE ORGANISATION FIRST, THE PROJECT CODE ONLY IF THERE IS NO ORGANISATION. Measured against
  // two real responses on 2026-08-25 rather than guessed at:
  //
  //   Lake Murray (Lexington Co, SC)   11 ProjectIdentifiers -- SWS-2020..SWS-2025, HAB-Program,
  //                                    MurrayNutrients, PFAS -- against 1 organisation.
  //   Hartwell Lake (Anderson Co, SC/GA)  11 project codes against 2 organisations: Georgia DNR
  //                                    Environmental Protection Division AND South Carolina
  //                                    Department of Environmental Services.
  //
  // The field is called `programs` and a person reads it. "Georgia DNR EPD and SCDES both
  // monitor this lake" is the answer to who watches this water; "SWS-2021, SWS-2022, SWS-2023,
  // SWS-2024, SWS-2025" is the answer to what they named the files.
  //
  // Found 2026-08-25 by audit_upstream_fields.py, once it was taught that a column can be looked
  // up by name instead of reached by one.
  const iOrg = col('organizationformalname');
  const iProject = col('projectidentifier');

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
    const project = cols[iOrg] || cols[iProject] || '';
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

  // TWO DEPTHS OUT OF ONE WALK DOWN THE SAME PROFILE.
  //
  // This binned every DO reading by depth, walked down until the median fell under 2 mg/L, and
  // returned that one number. `limnology.oxygen.depletionDepthFt` -- which plan-inputs.js prints
  // to the model as "Oxygen depletion begins: N ft" -- was left for the limnology agent to
  // answer from prose, standing beside a measured anoxic floor derived from these very samples.
  //
  // The second depth is the same walk with a different threshold, so it costs one comparison.
  //
  // 5.0 mg/L IS NOT A NUMBER PICKED HERE. It is the freshwater dissolved-oxygen standard for
  // aquatic life in both states this card mostly covers -- SC R.61-68 and NC 15A NCAC 02B .0211
  // both set a 5.0 mg/L daily average. Below it the state's own rule says the water has stopped
  // supporting the fishery, which is exactly what "depletion begins" is asking. 2 mg/L for the
  // anoxic floor was already here, and the DO-profile thermocline above uses 4 mg/L for the
  // metalimnion. Three thresholds, all published, none of them ours.
  //
  // Ordering is enforced rather than assumed: a coarse 2 ft bin can put both crossings in the
  // same bin, and "depletion begins at 30 ft, nothing lives below 30 ft" is not two facts.
  let oxygen = null;
  if (allDO.length >= 3) {
    const bins = {};
    for (const r of allDO) {
      const bin = Math.floor(r.depthFt / 2) * 2;
      if (!bins[bin]) bins[bin] = [];
      bins[bin].push(r.value);
    }
    const sortedBins = Object.keys(bins).map(Number).sort((a, b) => a - b);
    const medianAt = (bin) => {
      const vals = bins[bin].slice().sort((a, b) => a - b);
      return vals[Math.floor(vals.length / 2)];
    };
    const firstBinUnder = (mgL) => {
      for (const bin of sortedBins) if (medianAt(bin) < mgL) return bin;
      return null;
    };
    const anoxicBelowFt = firstBinUnder(2);
    let depletionDepthFt = firstBinUnder(5);
    if (depletionDepthFt != null && anoxicBelowFt != null && depletionDepthFt >= anoxicBelowFt) depletionDepthFt = null;
    const noteBits = [];
    if (depletionDepthFt != null) noteBits.push(`Median dissolved oxygen falls below the 5 mg/L aquatic-life standard near ${depletionDepthFt} ft`);
    if (anoxicBelowFt != null) noteBits.push(`${noteBits.length ? 'and below' : 'Median dissolved oxygen drops below'} 2 mg/L near ${anoxicBelowFt} ft`);
    oxygen = {
      anoxicBelowFt,
      depletionDepthFt,
      evidenceCount: allDO.length,
      note: noteBits.length ? `${noteBits.join(' ')} in available depth-profile samples.` : null,
    };
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

  // ── WHY THERE IS NO THERMOCLINE, IN THE PAYLOAD, INSTEAD OF ONE SENTENCE THAT FITS ANY REASON ──
  //
  // `note` said "Depth-profile records exist but were insufficient to derive a defensible
  // thermocline" whenever ANY record carried a depth, and `depthProfileCount` is
  // `records.filter(r => r.depthFt != null).length` -- which counts a surface grab logged at
  // 0.1 m as a depth profile. So the sentence reads as a data-quality problem on a lake that may
  // simply never have been sampled below the surface, and there was no way to tell the two apart.
  //
  // Badin Lake, refreshed by the cron 2026-09-02: 131 records, ALL of them carrying a depth, 105
  // in summer, 43 of them dissolved oxygen -- and not one bin under 4 mg/L on a 5,300-acre Yadkin
  // reservoir in July. Ryan: *"i thought a thermocline could be derived though..."* It can, and
  // the derivation is sound; what could not be seen was that the samples never went deep enough
  // to have one in them.
  //
  // So the reason is DERIVED and reported. Each branch names the number that fell short, which is
  // the difference between "we cannot read this lake" and "nobody sampled it below eight feet".
  const depthsOf = (rs) => rs.map((r) => r.depthFt).filter((d) => typeof d === 'number');
  const allDepths = depthsOf(depthRecords);
  const summerDoDepths = depthsOf(summerDO);
  const summerTempDepths = depthsOf(summerTemp);
  const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
  const depths = {
    minFt: allDepths.length ? round1(Math.min(...allDepths)) : null,
    maxFt: allDepths.length ? round1(Math.max(...allDepths)) : null,
    // Distinct 2 ft bins is the number the derivation actually walks. One bin is not a profile
    // however many records are in it.
    distinctBins: new Set(allDepths.map((d) => Math.floor(d / 2) * 2)).size,
    summerDoRecords: summerDO.length,
    summerDoDeepestFt: summerDoDepths.length ? round1(Math.max(...summerDoDepths)) : null,
    summerTempRecords: summerTemp.length,
    summerTempDeepestFt: summerTempDepths.length ? round1(Math.max(...summerTempDepths)) : null,
    shallowestSummerDoMgL: null,
    largestSummerTempStepF: null,
  };
  // What the two branches came closest to. Recomputed rather than carried out of the loops above,
  // because a reason that drifts from the rule it describes is worse than no reason.
  if (summerDO.length) {
    const bins = {};
    for (const r of summerDO) {
      const b = Math.floor(r.depthFt / 2) * 2;
      (bins[b] = bins[b] || []).push(r.value);
    }
    const medians = Object.values(bins).map((v) => v.slice().sort((a, b) => a - b)[Math.floor(v.length / 2)]);
    depths.shallowestSummerDoMgL = medians.length ? round1(Math.min(...medians)) : null;
  }
  if (summerTemp.length) {
    const bins = {};
    for (const r of summerTemp) {
      const b = Math.floor(r.depthFt / 2) * 2;
      (bins[b] = bins[b] || []).push(r.value);
    }
    const keys = Object.keys(bins).map(Number).sort((a, b) => a - b);
    let step = 0;
    for (let i = 1; i < keys.length; i++) {
      const med = (k) => bins[k].slice().sort((a, b) => a - b)[Math.floor(bins[k].length / 2)];
      step = Math.max(step, med(keys[i - 1]) - med(keys[i]));
    }
    depths.largestSummerTempStepF = keys.length > 1 ? round1(step) : null;
  }

  const whyNoThermocline = () => {
    if (thermocline) return null;
    if (!depthRecords.length) return surfaceOnlyNote;
    if (depths.distinctBins <= 1) {
      return `Every record carries a depth but they fall in one 2 ft band (${depths.minFt}-${depths.maxFt} ft). `
           + 'These are surface grabs with a depth stamp, not a vertical profile.';
    }
    if (!summerDO.length && !summerTemp.length) {
      return `${depthRecords.length} depth record(s), none of them a summer (Jun-Sep) dissolved-oxygen `
           + 'or temperature reading, which is what the derivation walks.';
    }
    const bits = [];
    if (summerDO.length) {
      bits.push(summerDO.length < 3
        ? `only ${summerDO.length} summer DO reading(s), and 3 is the floor`
        : `summer DO never fell under 4 mg/L at any sampled depth (lowest binned median `
          + `${depths.shallowestSummerDoMgL} mg/L, deepest sample ${depths.summerDoDeepestFt} ft)`);
    }
    if (summerTemp.length) {
      bits.push(summerTemp.length < 3
        ? `only ${summerTemp.length} summer temperature reading(s), and 3 is the floor`
        : `largest temperature step between sampled depths was ${depths.largestSummerTempStepF} degF, `
          + `under the 5 degF the gradient rule requires (deepest sample ${depths.summerTempDeepestFt} ft)`);
    }
    return `No thermocline: ${bits.join('; ')}.`;
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
    depths,
    note: whyNoThermocline(),
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
    // The pull, not the cached-and-merged wrapper: this path wants the early secchi-only return
    // and keeps its own clarity-cache below. See the guard in wqpCached().
    const res = await wqpPull(env, { lakeName }, { secchiOnly: true });
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

/**
 * THE THIRTY-DAY REFRESH, ON THE CLOCK THAT ALREADY EXISTS.
 *
 * Ryan, 2026-09-02: *"pulled in the pipeline and then reran every 30 days automatically and then
 * merged back in ... that is what i want to happen."* Step 4 of his 2026-09-01 plan says the same
 * thing and names this cron: *"WQP refresh belongs here, gated to the N oldest waters per firing
 * so the whole card rolls over inside a month -- matching the monthly sampling underneath."*
 *
 * TWO LISTINGS AND NO BODIES. R2's list gives `uploaded` per object, so a profile is paired with
 * its cache and judged stale without reading either -- which is why the cache is keyed by
 * researchStorageId above. Only the waters that are actually past the TTL cost anything, so on a
 * normal firing this does nothing at all.
 *
 * TWO PER FIRING. The five-minute cron fires 288 times a day, so two is enough to work through
 * every water on the card in well under a day whenever a batch of them ages out together, while
 * never putting more than two WQP requests on the wire at once. It is not a throughput target; it
 * is the smallest number that cannot fall behind a monthly TTL.
 *
 * IT DOES NOT BUMP THE PROFILE VERSION. A version marks a research run -- a judgement somebody
 * made and can roll back to. This is a measurement being re-read from the same source under the
 * same method, so it writes `metadata.limnologyRefreshedAt` and leaves the version alone. Bumping
 * it would file 64 new versions a month that no human authored and bury the ones that mean
 * something. The numbers stay re-derivable from the cache either way.
 *
 * NOTHING HERE MAY TAKE THE ALERT SWEEP DOWN. scheduled() is the only path that reaches Ryan with
 * the app closed, and a throw inside it is silent -- Cloudflare does not retry. So every failure
 * is caught per water and reported in the return value, which is what the cron logs.
 */
const SWEEP_PER_FIRING = 2;

async function refreshStaleLimnology(env, opts = {}) {
  const limit = opts.limit || SWEEP_PER_FIRING;
  const out = { checked: 0, stale: 0, refreshed: 0, merged: 0, failed: [] };
  if (!env?.R2_TROLLMAP_CHARTPACKS) return out;

  const [profiles, caches] = await Promise.all([
    env.R2_TROLLMAP_CHARTPACKS.list({ prefix: 'lakes/' }),
    env.R2_TROLLMAP_CHARTPACKS.list({ prefix: 'limnology-cache/' }),
  ]);
  const cachedAt = new Map();
  for (const o of caches.objects || []) {
    const id = o.key.replace(/^limnology-cache\//, '').replace(/\.json$/, '');
    cachedAt.set(id, o.uploaded ? Date.parse(o.uploaded) : 0);
  }

  const due = [];
  for (const o of profiles.objects || []) {
    // `lakes/versions/<id>/vN.json` is history, not a profile.
    const m = /^lakes\/([^/]+)\.json$/.exec(o.key);
    if (!m) continue;
    out.checked += 1;
    const at = cachedAt.get(m[1]);
    if (at == null || Date.now() - at >= WQP_TTL_MS) due.push({ id: m[1], key: o.key, at: at || 0 });
  }
  out.stale = due.length;
  due.sort((a, b) => a.at - b.at);            // the oldest first, missing before merely old

  for (const water of due.slice(0, limit)) {
    try {
      const obj = await env.R2_TROLLMAP_CHARTPACKS.get(water.key);
      if (!obj) continue;
      const profile = JSON.parse(await r2Text(obj));
      const lakeName = profile.lakeName || profile.identity?.lakeName;
      if (!lakeName) { out.failed.push(`${water.id}: profile carries no lakeName`); continue; }

      // The id is the listing key it came from, so nothing has to resolve it again.
      const pull = await wqpCached(env, lakeName, {}, {}, water.id);
      out.refreshed += 1;
      if (!pull?.ok || !(pull.recordCount > 0)) continue;

      const merged = applyWqpToLimnology(profile.limnology || {}, pull);
      if (JSON.stringify(merged) === JSON.stringify(profile.limnology || {})) continue;
      profile.limnology = merged;
      profile._wqpLimnology = pull;
      const ev = buildWqpEvidence(pull);
      for (const [section, fields] of Object.entries(ev)) {
        profile.evidence = profile.evidence || {};
        profile.evidence[section] = profile.evidence[section] || {};
        // REPLACED, NOT APPENDED. This row says where the value now stored came from, and there
        // is one such value; appending would leave last month's citation beside this month's
        // number claiming to explain it.
        for (const [field, rows] of Object.entries(fields || {})) profile.evidence[section][field] = rows;
      }
      profile.metadata = profile.metadata || {};
      profile.metadata.limnologyRefreshedAt = new Date().toISOString();
      await env.R2_TROLLMAP_CHARTPACKS.put(water.key, JSON.stringify(profile),
        { httpMetadata: { contentType: 'application/json' } });
      out.merged += 1;
    } catch (e) {
      out.failed.push(`${water.id}: ${e && e.message}`);
    }
  }
  return out;
}

export { SUPPLEMENTAL_KEY_MAP, resolveSupplementalKeyWorker, handleResearchLimnologyData, getSecchiSummary, refreshStaleLimnology };
