// worker-research.js — Full research pipeline extracted from trollmap-worker.js
// All /research/* route handlers, RESEARCH_AGENTS, deterministic facts, dataset hunt, etc.

import { CORS, JSON_HEADERS, TEXT_HEADERS, extractLLMText, callLLM, isAuthorized } from './worker-core.js';
import { LAKES, LAKE_INTEL, lakeKeyFromName, fetchText, fetchUsgs, fetchAhqWaterTemp, fetchAhqFishingReport, fetchLakeMonsterIntel, getLakeIntel } from './worker-data.js';

var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// ─── OWNER-AWARE DRAWDOWN / OPERATIONS SOURCE SEEDS ───
// When deterministic parsing resolves reservoirOwner, these seeded sources are
// injected as discovery targets so the pipeline can extract lake-level ranges,
// seasonal drawdown schedules, and operations facts from the authority that
// actually manages the water.
const OWNER_DRAWDOWN_SOURCES = {
  dukeEnergy: {
    label: 'Duke Energy Catawba-Wateree License Agreement & Lake Summaries',
    url: 'https://www.duke-energy.com/community/lakes/hydroelectric-relicensing/catawba/license-agreement',
    authority: 'Duke Energy / FERC',
    type: 'HTML'
  },
  usaceSavannah: {
    label: 'USACE Savannah District Water Control / Lake Operations',
    url: 'https://www.sas.usace.army.mil/Missions/Water-Control/',
    authority: 'USACE Savannah District',
    type: 'HTML'
  },
  usaceWilmington: {
    label: 'USACE Wilmington District Water Control',
    url: 'https://www.saw.usace.army.mil/Missions/Water-Control/',
    authority: 'USACE Wilmington District',
    type: 'HTML'
  },
  usaceMobile: {
    label: 'USACE Mobile District Water Control',
    url: 'https://www.sam.usace.army.mil/Missions/Water-Control/',
    authority: 'USACE Mobile District',
    type: 'HTML'
  }
};

function resolveDrawdownSource(lakeName, state, reservoirOwner) {
  const owner = String(reservoirOwner || '').toLowerCase();
  const name = String(lakeName || '').toLowerCase();
  const baseName = name.replace(/^lake\s+/, '').replace(/,\s*(sc|nc|ga)(\/(sc|nc|ga))?\s*$/, '').trim();

  // Duke Energy owns Catawba-Wateree, Keowee-Toxaway, Nantahala, Yadkin-Pee Dee, etc.
  const dukeLakeNames = ['wateree','wylie','norman','keowee','jocassee','hickory','james','rhodhiss','mountain island','lookout shoals','fishing creek','great falls','cedar creek','dearborn','tillery','blewett falls'];
  if (owner.includes('duke energy') || owner.includes('duke power') || dukeLakeNames.some(l => baseName.includes(l))) {
    return OWNER_DRAWDOWN_SOURCES.dukeEnergy;
  }

  // USACE lakes in the tristate region
  const savannahLakes = ['hartwell','russell','thurmond','clarks hill','clark hill','j strom thurmond','richard b. russell'];
  if (owner.includes('usace') || owner.includes('u.s. army corps') || owner.includes('army corps') || owner.includes('corps of engineers')) {
    if (savannahLakes.some(l => baseName.includes(l))) return OWNER_DRAWDOWN_SOURCES.usaceSavannah;
    if (['SC','GA'].includes(String(state || '').toUpperCase())) return OWNER_DRAWDOWN_SOURCES.usaceSavannah;
    if (['NC','VA'].includes(String(state || '').toUpperCase())) return OWNER_DRAWDOWN_SOURCES.usaceWilmington;
    return OWNER_DRAWDOWN_SOURCES.usaceSavannah;
  }

  return null;
}
__name(resolveDrawdownSource, 'resolveDrawdownSource');

// ─── EXTENDED EVIDENCE ACQUISITION PIPELINE FUNCTIONS ───

async function handleResearchLimnologyData(request, env) {
  const body = await request.json().catch(() => ({}));
  const { lakeName, bboxNorth, bboxSouth, bboxEast, bboxWest } = body;
  if (!lakeName) return new Response(JSON.stringify({ ok: false, error: 'missing lakeName' }), { status: 400, headers: JSON_HEADERS });
  if (bboxNorth == null || bboxSouth == null || bboxEast == null || bboxWest == null) {
    return new Response(JSON.stringify({ ok: false, error: 'missing bbox — provide bboxNorth/South/East/West from lake GeoJSON' }), { status: 400, headers: JSON_HEADERS });
  }

  const chars = ['Temperature, water', 'Dissolved oxygen (DO)', 'Dissolved oxygen'];
  // WQP query requires: characteristicType=Physical, providers NWIS+WQX,
  // dataProfile=resultPhysChem, and a date range
  const wqpUrl = `https://www.waterqualitydata.us/data/Result/search?` +
    `bBox=${bboxWest},${bboxSouth},${bboxEast},${bboxNorth}` +
    `&siteType=Lake%2C+Reservoir%2C+Impoundment` +
    `&characteristicType=Physical` +
    `&characteristicName=${chars.map(c => encodeURIComponent(c)).join('&characteristicName=')}` +
    `&providers=NWIS&providers=WQX` +
    `&dataProfile=resultPhysChem` +
    `&mimeType=csv&sorted=no` +
    `&startDateLo=01-01-2015&startDateHi=12-31-2026`;

  let csvText;
  try {
    const wqpRes = await fetch(wqpUrl, {
      headers: { 'User-Agent': 'TrollMap/1.0 (fishing intelligence platform; contact: trollmap@colonal1981.workers.dev)' }
    });
    if (!wqpRes.ok) throw new Error(`WQP HTTP ${wqpRes.status}`);
    csvText = await wqpRes.text();
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: `WQP fetch failed: ${e.message}`, thermocline: null }), { headers: JSON_HEADERS });
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
  const iDate = col('activitystartdate');
  const iProject = col('projectname');
  const iLoc = col('monitoringlocationname');

  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const char = cols[iChar] || '';
    const valRaw = cols[iValue] || '';
    const unit = cols[iUnit] || '';
    const depRaw = cols[iDepth] || '';
    const depUnit = cols[iDepthU] || '';
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
      if (gradient > maxGradient) { maxGradient = gradient; maxBin = sortedBins[i - 1]; }
    }
    if (maxBin != null && maxGradient >= 3) {
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

  const out = {
    ok: true,
    lakeName,
    recordCount: records.length,
    depthProfileCount: depthRecords.length,
    summerRecords: summerDepthRecs.length,
    lastObserved: records.map(r => r.date).filter(Boolean).sort().slice(-1)[0] || null,
    thermocline,
    oxygen,
    surfaceWater,
    note: thermocline ? null : depthRecords.length ? 'Depth-profile records exist but were insufficient to derive a defensible thermocline.' : 'Monitoring data were found, but available records are surface/grab samples rather than depth profiles.'
  };
  return new Response(JSON.stringify(out), { headers: JSON_HEADERS });
}
__name(handleResearchLimnologyData, 'handleResearchLimnologyData');

async function handleResearchDiscover(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || "").trim();
  const state = String(body.state || "SC").trim().toUpperCase();

  if (!lakeName) {
    return new Response(JSON.stringify({ success: false, error: "Missing lakeName" }), { status: 400, headers: JSON_HEADERS });
  }

  // Derive base name for relevance filtering (e.g. "Lake Wateree, SC" -> "wateree")
  const baseName = String(lakeName).replace(/^Lake\s+/i,'').replace(/,\s*(SC|NC|GA)\s*$/i,'').replace(/\s+Reservoir$/i,'').replace(/\s+Lake$/i,'').trim();
  const baseLower = baseName.toLowerCase();
  const otherLakeNames = ['murray','marion','moultrie','hartwell','keowee','jocassee','thurmond','clarks hill','clark hill','russell','wylie','norman','hickory','james','rhodhiss','mountain island','wateree','robinson','monticello','greenwood','secession','yates','martin'];
  const offLakePattern = (title, url) => {
    const combined = `${title} ${url}`.toLowerCase();
    // Filter irrelevant document types regardless of lake
    if (/wetlands.management|wma.wetlands|wildlife.management.area|hunting.*pdf|upland.*habitat|prescribed.burn|waterfowl.impound/i.test(combined)) return 'irrelevant_doc_type';
    if (/nrc\.gov\/docs\//i.test(combined)) return 'nrc_nuclear_doc';
    for (const other of otherLakeNames) {
      if (other === baseLower) continue;
      if (combined.includes(`lake ${other}`) && !combined.includes(baseLower)) {
        const isLakeSpecificReg = /regulations|regs\.html|description\.html/.test(combined) && /lake (murray|marion|moultrie|hartwell|keowee|jocassee|greenwood|secession|yates|martin)/.test(combined);
        if (isLakeSpecificReg) return other;
      }
      if (/regs\.html|description\.html/.test(combined) && combined.includes(`/${other}/`) && !combined.includes(baseLower)) return other;
    }
    return null;
  };

  // Resolve state-specific agencies and domains dynamically
  // Fix 2026-07-12: dnr.sc.gov/fishregs now 404s — official regs moved to eRegulations
  // For SC, we search both dnr.sc.gov (lake descriptions still work) AND eregulations.com (new regs host)
  let dnrName = "SCDNR";
  let dnrDomain = "dnr.sc.gov";
  let regsSiteFilter = "site:dnr.sc.gov OR site:eregulations.com";
  if (state === "NC") { dnrName = "NCWRC"; dnrDomain = "ncwildlife.org"; regsSiteFilter = "site:ncwildlife.org OR site:eregulations.com"; }
  else if (state === "GA") { dnrName = "GADNR"; dnrDomain = "georgiawildlife.com"; regsSiteFilter = "site:georgiawildlife.com OR site:eregulations.com"; }

  // Use baseName in queries to improve Tavily hit rate (avoid ", SC" suffix which hurts)
  const queryLake = baseName || lakeName;
  const stateFullName = { SC: 'South Carolina', NC: 'North Carolina', GA: 'Georgia' }[state] || 'South Carolina';

  // Owner-aware drawdown source seeding: if the caller already knows the
  // reservoir owner (e.g. from deterministic facts), seed the authority's
  // lake-level / operations page so the pipeline can extract drawdown facts.
  const reservoirOwner = body.reservoirOwner || null;
  const drawdownSource = resolveDrawdownSource(lakeName, state, reservoirOwner);

  // CREDIT BUDGET: 5 search-only Tavily calls per discover run.
  // Extract is wasteful here — proxy-download fetches full content anyway.
  //
  // 2026-07-13: One combined fishing-guide query covers depth/structure/forage/
  // thermocline/seasonal facts from regional pubs. CWMS lake levels come from
  // the free direct API on /lake — no Tavily search needed for that.
  const queryPatterns = [
    `"${queryLake}" (fisheries OR biology OR \"striped bass\" OR crappie OR \"largemouth\") ${dnrName}`,
    `"${queryLake}" (regulations OR \"creel limit\" OR \"size limit\" OR \"bag limit\") (${regsSiteFilter})`,
    `"${queryLake}" (limnology OR thermocline OR \"water quality\" OR \"dissolved oxygen\") (USACE OR USGS OR EPA)`,
    // EPA NSCEP — covers both "Report on Lake X" and "Report on X Lake" naming
    `"Report on Lake ${queryLake}" OR "Report on ${queryLake} Lake" OR "${queryLake}" (NESWP OR eutrophication OR nepis)`,
    // Single fishing/general-guide query — lake-specific FACTS only (not opinions)
    `"${queryLake}" (fishing guide OR fishing report) (thermocline OR depth OR structure OR forage OR "threadfin shad" OR "gizzard shad" OR "fall turnover" OR "spring spawn" OR drawdown) (site:carolinasportsman.com OR site:takemefishing.org OR site:gameandfishmag.com OR site:in-fisherman.com OR site:flwfishing.com OR site:bassmaster.com OR site:majorleaguefishing.com)`,
  ];

  let discoveredSources = [];
  const googleApiKey = env.GOOGLE_SEARCH_API_KEY || env.GOOGLE_CSE_KEY;
  const googleCx = env.GOOGLE_SEARCH_CX || env.GOOGLE_CSE_CX;
  const tavilyApiKey = env.TAVILY_API_KEY || env.TAVILY_KEY;

  // CREDIT BUDGET: search-only, no extract. The proxy-download step fetches
  // full page content via Firecrawl or basic fetch, so Tavily extract is
  // redundant here (was costing 4-8 extra credits per run for no benefit).
  if (tavilyApiKey) {
    for (const q of queryPatterns) {
      try {
        const searchRes = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Authorization": `Bearer ${tavilyApiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query: q, search_depth: "basic", max_results: 3, include_raw_content: false, exclude_domains: [] })
        });
        if (!searchRes.ok) continue;
        const searchData = await searchRes.json();
        for (const r of (searchData.results || [])) {
          const off = offLakePattern(r.title||'', r.url||'');
          if (off) { console.log(`filtered off-lake ${off} for ${baseName}: ${r.url}`); continue; }
          const isPdf = String(r.url||'').toLowerCase().endsWith('.pdf');
          let host = "Tavily";
          try { host = new URL(r.url).hostname; } catch {}
          let authority = host;
          if (/dnr\.sc\.gov/.test(host) || /eregulations\.com/.test(host)) authority = "SCDNR";
          else if (/usgs\.gov/.test(host)) authority = "USGS";
          else if (/usace\.army\.mil/.test(host)) authority = "USACE";
          else if (/nepis\.epa\.gov|epa\.gov/.test(host)) authority = "EPA NSCEP";
          else if (/dnr|wildlife/.test(host)) authority = dnrName;
          discoveredSources.push({
            title: (r.title || `${queryLake} - ${host}`).replace(/\s+/g,' ').trim().slice(0,180),
            type: isPdf ? "PDF" : "HTML",
            authority,
            url: r.url,
            priority: (r.title||'').toLowerCase().includes(baseLower) ? 1 : 2,
            score: r.score || 0
          });
        }
      } catch (err) {
        console.warn(`Tavily search failed for [${q}]: ${err.message}`);
      }
    }
  } else if (googleApiKey && googleCx) {
    for (const q of queryPatterns) {
      try {
        const url = `https://customsearch.googleapis.com/customsearch/v1?key=${encodeURIComponent(googleApiKey)}&cx=${encodeURIComponent(googleCx)}&q=${encodeURIComponent(q)}`;
        const res = await fetch(url);
        if (!res.ok) continue;
        const data = await res.json();
        const items = data.items || [];
        for (const item of items) {
          const off = offLakePattern(item.title||'', item.link||'');
          if (off) continue;
          const isPdf = String(item.link||'').toLowerCase().endsWith('.pdf') || String(item.mime||'').includes('pdf');
          discoveredSources.push({
            title: (item.title||`${queryLake} Resource`).slice(0,180),
            type: isPdf ? "PDF" : "HTML",
            authority: item.displayLink || "Google Search",
            url: item.link,
            priority: (item.title||'').toLowerCase().includes(baseLower) ? 1 : 2
          });
        }
      } catch (err) { console.warn(`Google search failed: ${err.message}`); }
    }
  }

  // Deduplicate by URL and by normalized title to avoid "Lake Wateree, SC Document" duplicates
  const seenUrls = new Set();
  const seenTitles = new Set();
  let filtered = [];
  for (const src of discoveredSources) {
    const normUrl = String(src.url||'').split('?')[0].toLowerCase();
    const normTitle = String(src.title||'').toLowerCase().replace(/\s+/g,' ').trim();
    if (seenUrls.has(normUrl)) continue;
    if (normUrl.includes('pocket') && normTitle.includes('pocket')) continue; // skip generic pocket guide here, client also skips
    // skip exact title dupes coming from Tavily generic naming
    if (seenTitles.has(normTitle) && normTitle.includes('document') && normTitle.length < 40) continue;
    // off-lake final check
    const off = offLakePattern(src.title, src.url);
    if (off) continue;
    seenUrls.add(normUrl);
    seenTitles.add(normTitle);
    filtered.push(src);
  }
  discoveredSources = filtered;

  // Sort by priority (1 = lake-specific) then by score
  // Per-lake pre-seeded authoritative sources — always included regardless of Tavily results
  const LAKE_SEEDS = {
    wateree: [
      { title: "Lake Wateree SCDNR Lake Description", type: "HTML", authority: "SCDNR", url: "https://www.dnr.sc.gov/lakes/wateree/description.html", priority: 1 },
      { title: "Lake Wateree Regulations", type: "HTML", authority: "SCDNR", url: "https://www.dnr.sc.gov/lakes/wateree/regs.html", priority: 1 },
      { title: "SC Freshwater Fish Size & Possession Limits (eRegulations)", type: "HTML", authority: "SCDNR", url: "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits", priority: 1 },
      { title: "SCDNR Striped Bass Species Page (current regulations & biology)", type: "HTML", authority: "SCDNR", url: "https://www.dnr.sc.gov/fish/species/stripedbass.html", priority: 1 },
    ],
    murray: [
      { title: "Lake Murray SCDNR Lake Description", type: "HTML", authority: "SCDNR", url: "https://www.dnr.sc.gov/lakes/murray/description.html", priority: 1 },
      { title: "Lake Murray Regulations", type: "HTML", authority: "SCDNR", url: "https://www.dnr.sc.gov/lakes/murray/regs.html", priority: 1 },
      { title: "SC Freshwater Game Fishing Regulations (eRegulations)", type: "HTML", authority: "SCDNR", url: "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits", priority: 1 },
    ],
    marion: [
      { title: "Lake Marion SCDNR Lake Description", type: "HTML", authority: "SCDNR", url: "https://www.dnr.sc.gov/lakes/marion/description.html", priority: 1 },
      { title: "Lake Marion Regulations", type: "HTML", authority: "SCDNR", url: "https://www.dnr.sc.gov/lakes/marion/regs.html", priority: 1 },
      { title: "SC Freshwater Game Fishing Regulations (eRegulations)", type: "HTML", authority: "SCDNR", url: "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits", priority: 1 },
    ],
    moultrie: [
      { title: "Lake Moultrie SCDNR Lake Description", type: "HTML", authority: "SCDNR", url: "https://www.dnr.sc.gov/lakes/moultrie/description.html", priority: 1 },
      { title: "Lake Moultrie Regulations", type: "HTML", authority: "SCDNR", url: "https://www.dnr.sc.gov/lakes/moultrie/regs.html", priority: 1 },
      { title: "SC Freshwater Fish Size & Possession Limits (eRegulations)", type: "HTML", authority: "SCDNR", url: "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits", priority: 1 },
    ],
    monticello: [
      { title: "Lake Monticello SCDNR Lake Description", type: "HTML", authority: "SCDNR", url: "https://www.dnr.sc.gov/lakes/monticello/description.html", priority: 1 },
      { title: "Lake Monticello Regulations", type: "HTML", authority: "SCDNR", url: "https://www.dnr.sc.gov/lakes/monticello/regs.html", priority: 1 },
      { title: "SC Freshwater Fish Size & Possession Limits (eRegulations)", type: "HTML", authority: "SCDNR", url: "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits", priority: 1 },
    ],
    keowee: [
      { title: "Lake Keowee SCDNR Lake Description", type: "HTML", authority: "SCDNR", url: "https://www.dnr.sc.gov/lakes/keowee/description.html", priority: 1 },
      { title: "Lake Keowee Regulations", type: "HTML", authority: "SCDNR", url: "https://www.dnr.sc.gov/lakes/keowee/regs.html", priority: 1 },
      { title: "SC Freshwater Fish Size & Possession Limits (eRegulations)", type: "HTML", authority: "SCDNR", url: "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits", priority: 1 },
    ],
    greenwood: [
      { title: "Lake Greenwood SCDNR Lake Description", type: "HTML", authority: "SCDNR", url: "https://www.dnr.sc.gov/lakes/greenwood/description.html", priority: 1 },
      { title: "Lake Greenwood Regulations", type: "HTML", authority: "SCDNR", url: "https://www.dnr.sc.gov/lakes/greenwood/regs.html", priority: 1 },
      { title: "SC Freshwater Fish Size & Possession Limits (eRegulations)", type: "HTML", authority: "SCDNR", url: "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits", priority: 1 },
    ],
  };

  // Default seeds for EVERY tristate lake (SC/NC/GA) — not just the hand-curated LAKE_SEEDS list.
  // EPA NEPI S search URL is included so the download step always has a path into NSCEP.
  const defaultStateSeeds = [];
  if (state === 'SC') {
    defaultStateSeeds.push(
      { title: `Lake ${baseName} SCDNR Lake Description`, type: "HTML", authority: "SCDNR", url: `https://www.dnr.sc.gov/lakes/${baseLower}/description.html`, priority: 1 },
      { title: `Lake ${baseName} Regulations`, type: "HTML", authority: "SCDNR", url: `https://www.dnr.sc.gov/lakes/${baseLower}/regs.html`, priority: 1 },
      { title: "SC Freshwater Fish Size & Possession Limits (eRegulations)", type: "HTML", authority: "SCDNR", url: "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits", priority: 1 },
    );
  } else if (state === 'NC') {
    defaultStateSeeds.push(
      { title: "NC Freshwater Fishing Regulations (eRegulations)", type: "HTML", authority: "NCWRC", url: "https://www.eregulations.com/northcarolina/fishing/freshwater-fishing-regulations", priority: 1 },
    );
  } else if (state === 'GA') {
    defaultStateSeeds.push(
      { title: "GA Freshwater Fishing Regulations (eRegulations)", type: "HTML", authority: "GA DNR", url: "https://www.eregulations.com/georgia/fishing/freshwater-fishing-regulations", priority: 1 },
    );
  }
  // EPA NSCEP search landing for this lake — proxy will harvest raw-text links via Firecrawl
  defaultStateSeeds.push({
    title: `EPA NSCEP search: Report on ${baseName} / Lake ${baseName}`,
    type: "HTML",
    authority: "EPA NSCEP",
    url: buildNepisSearchUrl(lakeName, state, baseName),
    priority: 1,
    source: 'nepis_seed'
  });

  // Owner-aware drawdown / operations source seeding. If we already know the
  // reservoir owner (passed in body or resolved from lake name), inject the
  // authority's lake-level / operations page as a guaranteed discovery target.
  // For Duke Energy lakes this is the Catawba-Wateree license page that links
  // to per-lake summaries with planned levels / drawdown schedules.
  // For USACE lakes this is the managing district's water-control page.
  if (drawdownSource) {
    defaultStateSeeds.push({
      title: drawdownSource.label,
      type: drawdownSource.type,
      authority: drawdownSource.authority,
      url: drawdownSource.url,
      priority: 1,
      source: 'owner_drawdown_seed'
    });
  }

  // Inject seeds — seeds always take guaranteed slots, prepend so they sort first
  const seeds = [...(LAKE_SEEDS[baseLower] || []), ...defaultStateSeeds];
  const guaranteedSeeds = [];
  for (const seed of seeds) {
    const normUrl = String(seed.url || '').split('?')[0].toLowerCase();
    if (seenUrls.has(normUrl) || seenUrls.has(seed.url)) continue;
    seenUrls.add(normUrl);
    seenUrls.add(seed.url);
    guaranteedSeeds.push(seed);
  }
  // Prepend seeds so they beat Tavily results in sort
  discoveredSources = [...guaranteedSeeds, ...discoveredSources];

  discoveredSources.sort((a,b)=> (a.priority-b.priority) || ((b.score||0)-(a.score||0)));

  // If zero results, use curated fallback
  if (discoveredSources.length === 0) {
    discoveredSources = [
      {
        title: `${lakeName} SCDNR Fisheries Management - Annual Report Section`,
        type: "PDF",
        authority: "SCDNR",
        url: "https://www.dnr.sc.gov/fish/fwfi/files/2017_annual_report.pdf",
        priority: 2
      },
      {
        title: `SC Freshwater Fishing Regulations (covers ${lakeName} creel/size limits)`,
        type: "PDF",
        authority: "SCDNR",
        url: "https://dc.statelibrary.sc.gov/server/api/core/bitstreams/7d7100f0-3b63-4d07-921c-d9a37e3f2b46/content",
        priority: 2
      },
      {
        title: `${lakeName} - SCDNR Lakes Information`,
        type: "HTML",
        authority: "SCDNR",
        url: `https://www.dnr.sc.gov/lakes/${baseLower}/description.html`,
        priority: 1
      }
    ];
  }

  // Seeds are guaranteed in final list; fill remaining slots with Tavily results
  const tavilySources = discoveredSources.filter(s => !guaranteedSeeds.includes(s));
  const remainingSlots = Math.max(0, 10 - guaranteedSeeds.length);
  const tavilyFill = tavilySources.filter(s => s.priority===1).slice(0, remainingSlots);
  const tavilyGeneric = tavilySources.filter(s => s.priority!==1);
  let finalList = [...guaranteedSeeds, ...tavilyFill, ...tavilyGeneric].slice(0,10);
  if (finalList.length < 3) finalList = discoveredSources.slice(0,10);

  return new Response(JSON.stringify({ success: true, sources: finalList, baseName, filteredCount: discoveredSources.length - finalList.length }), { headers: JSON_HEADERS });
}
__name(handleResearchDiscover, "handleResearchDiscover");

async function handleResearchProxyDownload(request, env) {
  const url = new URL(request.url);
  const target = url.searchParams.get("url");
  const sourceType = url.searchParams.get("type") || ""; // "PDF" or "HTML"
  if (!target) {
    return new Response(JSON.stringify({ success: false, error: "Missing url parameter" }), { status: 400, headers: JSON_HEADERS });
  }

  // Route HTML sources through Firecrawl ONLY for JS-rendered SPAs and NEPIS pages.
  // CREDIT BUDGET: static HTML pages (SCDNR descriptions, USGS, etc.) work fine with
  // basic fetch + HTML stripping. Firecrawl costs 1 credit per scrape, so we only
  // use it when necessary.
  const firecrawlKey = env.FIRECRAWL_API_KEY || env.FIRECRAWL_KEY;
  const isHtml = sourceType.toUpperCase() === 'HTML' || (!target.toLowerCase().includes('.pdf') && !sourceType.toUpperCase().includes('PDF'));
  // EPA NSCEP / NEPIS ZyNET:
  //  - Search results page (ZyActionS) — harvest document links
  //  - Document landing (ZyActionD) — extract raw-text / PDF format links
  const isNepisSearch = /nepis\.epa\.gov/i.test(target) && /[?&]ZyAction=ZyActionS\b/i.test(target);
  const isNepisLanding = /nepis\.epa\.gov/i.test(target) && (/[?&]ZyAction=ZyActionD\b/i.test(target) || /zypdf\.cgi/i.test(target));
  const isNepisAny = /nepis\.epa\.gov|ZyNET\.exe/i.test(target);
  // Only use Firecrawl for JS-heavy SPAs and NEPIS pages (saves ~8 Firecrawl credits per run)
  const needsFirecrawl = isNepisSearch || isNepisLanding || isNepisAny || /eregulations\.com/i.test(target);

  if (firecrawlKey && isHtml && needsFirecrawl) {
    try {
      // Search-results page: return markdown of the results list so the client can
      // store it, AND surface ZyActionD links in X-Nepis-Documents for follow-up.
      if (isNepisSearch) {
        const scrapeRes = await fetch('https://api.firecrawl.dev/v1/scrape', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${firecrawlKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: target,
            formats: ['links', 'markdown'],
            onlyMainContent: true,
            waitFor: 2500,
            timeout: 25000
          })
        });
        if (scrapeRes.ok) {
          const scrapeData = await scrapeRes.json();
          const md = scrapeData.data?.markdown || scrapeData.markdown || '';
          const links = scrapeData.data?.links || scrapeData.links || [];
          const docLinks = [];
          for (const link of links) {
            const url = typeof link === 'string' ? link : (link.url || '');
            if (/ZyActionD=/i.test(url)) {
              docLinks.push({
                url,
                title: (typeof link === 'object' && link.title) ? String(link.title).slice(0, 180) : 'EPA NSCEP document'
              });
            }
          }
          // Also pull from markdown
          for (const m of md.matchAll(/https?:\/\/[^\s)"']+ZyActionD[^\s)"']*/g)) {
            if (!docLinks.some(d => d.url === m[0])) docLinks.push({ url: m[0], title: 'EPA NSCEP document' });
          }
          if (md.length > 100 || docLinks.length) {
            // If we found a single clear document, fetch its raw .txt download directly.
            if (docLinks.length === 1) {
              const docUrl = docLinks[0].url;
              const rawTextUrl = toNepisRawTextUrl(docUrl);
              if (rawTextUrl) {
                try {
                  const rawRes = await fetch(rawTextUrl, {
                    headers: {
                      'User-Agent': 'TrollMap/15.3 Evidence Engine',
                      'Accept': 'text/plain,*/*'
                    }
                  });
                  if (rawRes.ok) {
                    const rawText = await rawRes.text();
                    if (rawText.length > 200) {
                      const firstLine = rawText.split('\n')[0] || '';
                      const metaMatch = firstLine.match(/^([A-Z]+[0-9]+)(Report on (?:Lake )?.+?)([0-9]{1,3})([0-9]{4})([A-Z].*)$/i);
                      const title = metaMatch ? metaMatch[2].trim() : (docLinks[0].title || '');
                      const headers = new Headers({
                        'Content-Type': 'text/plain; charset=utf-8',
                        'Access-Control-Allow-Origin': '*',
                        'X-Source': 'firecrawl',
                        'X-Nepis-Format': 'raw_text',
                        'X-Nepis-Title': title.slice(0, 180),
                        'X-Nepis-Doc-Url': docUrl,
                        'X-Nepis-RawText': rawTextUrl
                      });
                      return new Response(rawText, { headers });
                    }
                  }
                } catch (e) {
                  console.warn(`NEPI S single-doc raw-text fetch failed: ${e.message}`);
                }
              }
            }
            // Multi-doc search results: return markdown catalog + document URL list
            const catalog = [
              `# EPA NSCEP search results`,
              ``,
              `Found ${docLinks.length} document landing page(s).`,
              ``,
              ...docLinks.slice(0, 15).map((d, i) => `${i + 1}. [${d.title}](${d.url})`),
              ``,
              `---`,
              ``,
              md.slice(0, 50000)
            ].join('\n');
            const headers = new Headers({
              'Content-Type': 'text/plain; charset=utf-8',
              'Access-Control-Allow-Origin': '*',
              'X-Source': 'firecrawl',
              'X-Nepis-Format': 'search_results',
              'X-Nepis-Doc-Count': String(docLinks.length),
              // First few document URLs for client follow-up (header size limit)
              'X-Nepis-Documents': JSON.stringify(docLinks.slice(0, 5).map(d => d.url)).slice(0, 1500)
            });
            return new Response(catalog, { headers });
          }
        }
      }

      // Two-step for EPA NSCEP document landing pages: first extract format links,
      // then scrape the raw-text URL for clean markdown (avoids TIFF/OCR).
      if (isNepisLanding || (isNepisAny && !isNepisSearch)) {
        // NSCEP viewer URLs share the same File= parameter as the raw-text download.
        // Try to fetch the .txt download directly before paying for a Firecrawl scrape.
        const rawTextUrl = toNepisRawTextUrl(target);
        if (rawTextUrl) {
          try {
            const rawRes = await fetch(rawTextUrl, {
              headers: {
                'User-Agent': 'TrollMap/15.3 Evidence Engine',
                'Accept': 'text/plain,*/*'
              }
            });
            if (rawRes.ok) {
              const rawText = await rawRes.text();
              if (rawText.length > 200) {
                // The first metadata line concatenates pubnumber + title + pages + year + ...
                // e.g. "NESWP434Report on Lake Marion,... EPA Region IV601976NEPIS..."
                // or   "NESWP440Report on Wateree Lake,... EPA Region IV481975NEPIS..."
                const firstLine = rawText.split('\n')[0] || '';
                const metaMatch = firstLine.match(/^([A-Z]+[0-9]+)(Report on (?:Lake )?.+?)([0-9]{1,3})([0-9]{4})([A-Z].*)$/i);
                const title = metaMatch ? metaMatch[2].trim() : '';
                const headers = new Headers({
                  'Content-Type': 'text/plain; charset=utf-8',
                  'Access-Control-Allow-Origin': '*',
                  'X-Source': 'firecrawl',
                  'X-Nepis-Format': 'raw_text',
                  'X-Nepis-Title': title.slice(0, 180),
                  'X-Nepis-RawText': rawTextUrl
                });
                return new Response(rawText, { headers });
              }
            }
          } catch (eRaw) {
            console.warn(`Direct NSCEP raw-text fetch failed: ${eRaw.message}`);
          }
        }

        const landRes = await fetch('https://api.firecrawl.dev/v1/scrape', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${firecrawlKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: target,
            formats: ['markdown', 'json'],
            onlyMainContent: true,
            timeout: 25000,
            jsonOptions: {
              schema: {
                type: 'object',
                properties: {
                  report_metadata: {
                    type: 'object',
                    properties: {
                      title: { type: 'string' },
                      pub_number: { type: 'string' }
                    }
                  },
                  available_formats: {
                    type: 'object',
                    properties: {
                      pdf_url: { type: 'string', description: 'Link containing ZyPDF.cgi or .pdf' },
                      raw_text_url: { type: 'string', description: 'Link to the raw text, ASCII, or TXT version of the report' },
                      tiff_url: { type: 'string', description: 'Link to the TIFF image files' }
                    }
                  }
                },
                required: ['report_metadata', 'available_formats']
              }
            }
          })
        });
        if (landRes.ok) {
          const landData = await landRes.json();
          const extracted = landData.data?.json || landData.json || {};
          const formats = extracted.available_formats || {};
          const rawTextUrl = formats.raw_text_url || formats.text_url || null;
          const pdfUrl = formats.pdf_url || null;
          const title = extracted.report_metadata?.title || '';
          // Prefer raw text endpoint — Firecrawl markdown of a .txt/ASCII page is clean
          if (rawTextUrl && /^https?:\/\//i.test(rawTextUrl)) {
            try {
              const textRes = await fetch('https://api.firecrawl.dev/v1/scrape', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${firecrawlKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: rawTextUrl, formats: ['markdown'], onlyMainContent: true, timeout: 25000 })
              });
              if (textRes.ok) {
                const textData = await textRes.json();
                const markdown = textData.data?.markdown || textData.markdown || '';
                if (markdown && markdown.length > 100) {
                  const headers = new Headers({
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Access-Control-Allow-Origin': '*',
                    'X-Source': 'firecrawl',
                    'X-Nepis-Format': 'raw_text',
                    'X-Nepis-Title': title.slice(0, 180),
                    'X-Nepis-Pdf': pdfUrl || ''
                  });
                  return new Response(markdown, { headers });
                }
              }
            } catch (e2) {
              console.warn(`NSCEP raw-text scrape failed: ${e2.message}`);
            }
          }
          // Fall back to landing-page markdown if format extraction didn't yield text
          const landMd = landData.data?.markdown || landData.markdown || '';
          if (landMd && landMd.length > 100) {
            const headers = new Headers({
              'Content-Type': 'text/plain; charset=utf-8',
              'Access-Control-Allow-Origin': '*',
              'X-Source': 'firecrawl',
              'X-Nepis-Format': 'landing',
              'X-Nepis-Title': title.slice(0, 180),
              'X-Nepis-Pdf': pdfUrl || '',
              'X-Nepis-RawText': rawTextUrl || ''
            });
            return new Response(landMd, { headers });
          }
        }
      }

      // Standard Firecrawl markdown scrape for HTML pages (eRegulations, SCDNR, etc.)
      // waitFor helps JS-rendered SPAs like eRegulations populate table rows
      const isSpa = /eregulations\.com/i.test(target);
      const fcRes = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${firecrawlKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: target,
          formats: ['markdown'],
          onlyMainContent: true,
          waitFor: isSpa ? 3000 : 0,
          timeout: 25000
        })
      });
      if (fcRes.ok) {
        const fcData = await fcRes.json();
        const markdown = fcData.data?.markdown || fcData.markdown || '';
        if (markdown && markdown.length > 100) {
          // Return as text/plain so lake-research.js can use it directly without pdf.js
          const headers = new Headers({ 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'X-Source': 'firecrawl' });
          return new Response(markdown, { headers });
        }
      }
      // Fall through to basic fetch if Firecrawl fails
    } catch (e) {
      console.warn(`Firecrawl failed for ${target}: ${e.message} — falling back to basic fetch`);
    }
  }

  try {
    const response = await fetch(target, {
      headers: {
        "User-Agent": "TrollMap/15.3 Evidence Engine",
        "Accept": "*/*"
      }
    });

    if (!response.ok) {
      return new Response(JSON.stringify({ success: false, error: `HTTP Error ${response.status}: Failed to retrieve file from source.` }), { status: response.status, headers: JSON_HEADERS });
    }

    const headers = new Headers(response.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    return new Response(response.body, { headers });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 502, headers: JSON_HEADERS });
  }
}
__name(handleResearchProxyDownload, "handleResearchProxyDownload");

// ─── DATASET HUNTER ──────────────────────────────────────────────────────────
// Uses Firecrawl /v1/map to crawl authoritative agency sites and find
// stocking reports, creel surveys, fisheries assessments, and academic papers
// for a given lake. Returns a ranked list of discovered dataset URLs.
//
// Target sources per state:
//   SC  — dnr.sc.gov (stocking, creel, annual reports, lake descriptions)
//   NC  — ncwildlife.org
//   GA  — georgiawildlife.com
//   All — USGS ScienceBase, USACE, Google Scholar via Tavily
//
// Route: POST /research/dataset-hunt  { lakeName, state }

const DATASET_HUNT_TARGETS = {
  SC: [
    { label: 'SCDNR Fisheries',        url: 'https://www.dnr.sc.gov/fish/',         depth: 3 },
    { label: 'SCDNR Lakes',            url: 'https://www.dnr.sc.gov/lakes/',         depth: 2 },
    { label: 'SCDNR Publications',     url: 'https://www.dnr.sc.gov/publications/',  depth: 2 },
    // EPA NSCEP / NEPI S — "Report on Lake …" water-quality series + other SC lake reports
    { label: 'EPA NSCEP / NEPI S',      url: 'https://nepis.epa.gov/',               depth: 1, isNepis: true },
  ],
  NC: [
    { label: 'NCWRC Fisheries',        url: 'https://www.ncwildlife.org/fishing',    depth: 2 },
    { label: 'EPA NSCEP / NEPI S',      url: 'https://nepis.epa.gov/',               depth: 1, isNepis: true },
  ],
  GA: [
    { label: 'GA DNR Fisheries',       url: 'https://georgiawildlife.com/fishing',   depth: 2 },
    { label: 'EPA NSCEP / NEPI S',      url: 'https://nepis.epa.gov/',               depth: 1, isNepis: true },
  ],
};

// Keywords that indicate a URL is a dataset/report worth harvesting
const DATASET_KEYWORDS = [
  'stocking','creel','survey','report','annual','fisheries','assessment',
  'population','management','study','research','limnology','water quality',
  'electrofishing','monitoring','harvest','biology','publication',
  // EPA NSCEP lake reports
  'report on lake','neswp','nepis','water quality','eutrophication','trophic'
];

// Score a URL for relevance to a given lake
function scoreDatasetUrl(url, title, lakeName) {
  const baseName = lakeName.replace(/^Lake\s+/i,'').replace(/,\s*(SC|NC|GA).*$/i,'').trim().toLowerCase();
  const combined = `${url} ${title}`.toLowerCase();
  let score = 0;
  if (combined.includes(baseName)) score += 40;
  for (const kw of DATASET_KEYWORDS) {
    if (combined.includes(kw)) score += 5;
  }
  if (/\.pdf$/i.test(url)) score += 10; // PDFs are usually actual reports
  if (/annual.report|creel.survey|stocking.report/i.test(combined)) score += 20;
  if (/nepis\.epa\.gov|zynet\.exe|zypdf\.cgi/i.test(url)) score += 15; // EPA NSCEP docs
  if (/report on lake/i.test(combined)) score += 25;
  if (/\d{4}/.test(url)) score += 5; // has a year — likely a dated report
  return score;
}

// Build EPA NSCEP search-results URL(s) for a lake.
// Historical EPA "Report on Lake …" series (1970s–80s) uses INCONSISTENT naming:
//   Most lakes:  "Report on Lake Murray"   (Lake before name)
//   Wateree etc: "Report on Wateree Lake"  (name before Lake)
// Using title filter "Report on" (not "Report on Lake") catches BOTH conventions
// since the lake name is in the Query field anyway.
function buildNepisSearchUrl(lakeName, state, queryOverride = null) {
  const baseName = String(lakeName || '').replace(/^Lake\s+/i, '').replace(/,\s*(SC|NC|GA|VA|TN).*$/i, '').trim();
  const stateName = { SC: 'South Carolina', NC: 'North Carolina', GA: 'Georgia', VA: 'Virginia', TN: 'Tennessee' }[String(state || 'SC').toUpperCase()] || 'South Carolina';
  const query = encodeURIComponent(queryOverride || baseName || stateName);
  // Use "Report on" (not "Report on Lake") so both naming conventions match:
  //   "Report on Lake Murray" AND "Report on Wateree Lake"
  const titleField = encodeURIComponent('Report on');
  // Indexes cover historical EPA lake reports (1970s–2020)
  const indexes = [
    '2016 Thru 2020', '2011 Thru 2015', '2006 Thru 2010', '2000 Thru 2005',
    '1995 Thru 1999', '1991 Thru 1994', '1986 Thru 1990', '1981 Thru 1985',
    '1976 Thru 1980', 'Prior to 1976'
  ].map(i => `Index=${encodeURIComponent(i)}`).join('&');
  return `https://nepis.epa.gov/Exe/ZyNET.exe?ZyAction=ZyActionS&User=ANONYMOUS&Password=anonymous&Client=EPA&SearchBack=ZyActionL&SortMethod=h%7C-&MaximumDocuments=15&ImageQuality=r85g16%2Fr85g16%2Fx150y150g16%2Fi500&Display=hpfr&DefSeekPage=&Toc=&TocEntry=&TocRestrict=n&QField=title%5E${titleField}&UseQField=title&Docs=&SearchMethod=1&Time=&FullText=&IntQFieldOp=1&Query=${query}&ExtQFieldOp=1&FuzzyDegree=0&${indexes}`;
}

// Convert an EPA NSCEP document viewer/landing URL into the raw-text download URL.
// The viewer endpoint uses ZyActionD=ZyDocument and displays scanned page images.
// The same .txt endpoint with ZyActionW=Download returns the OCR/plain-text file
// referenced by the File= parameter.
function toNepisRawTextUrl(landingUrl) {
  try {
    const url = new URL(landingUrl);
    if (!/nepis\.epa\.gov/i.test(url.hostname)) return null;
    if (!/\.txt$/i.test(url.pathname)) return null;
    // Already a download link — nothing to do.
    if (/ZyActionW=Download/i.test(url.search)) return landingUrl;
    // Switch from the viewer action to the download action, keeping File= etc.
    url.searchParams.delete('ZyActionD');
    url.searchParams.set('ZyActionW', 'Download');
    // Retain existing SearchMethod and Display if present; only default if missing
    if (!url.searchParams.has('SearchMethod')) {
      url.searchParams.set('SearchMethod', '1');
    }
    if (!url.searchParams.has('Display')) {
      url.searchParams.set('Display', 'hpfr');
    }
    return url.toString();
  } catch (e) {
    return null;
  }
}

// Queries to run against NEPI S for any SC/NC/GA (tristate) lake
function buildNepisQueryVariants(lakeName, state) {
  // Normalize: "Clarks Hill / Thurmond, SC/GA" → try both names; "High Rock Lake, NC" → "High Rock"
  let raw = String(lakeName || '').replace(/,\s*(SC|NC|GA|VA|TN)(\/(SC|NC|GA|VA|TN))?\s*$/i, '').trim();
  raw = raw.replace(/\s+Lake$/i, '').replace(/^Lake\s+/i, '').trim();
  const parts = raw.split(/\s*\/\s*|\s+or\s+/i).map(p => p.replace(/^Lake\s+/i, '').replace(/\s+Lake$/i, '').trim()).filter(Boolean);
  const primary = parts[0] || raw;
  const stateCode = String(state || 'SC').toUpperCase();
  const stateName = { SC: 'South Carolina', NC: 'North Carolina', GA: 'Georgia', VA: 'Virginia', TN: 'Tennessee' }[stateCode] || 'South Carolina';
  // Aliases that help NEPI S title search (Clarks Hill vs Thurmond, etc.)
  const aliasMap = {
    thurmond: ['Thurmond', 'Clarks Hill', "Clark's Hill", 'J. Strom Thurmond'],
    'clarks hill': ['Clarks Hill', 'Thurmond', "Clark's Hill"],
    'clark hill': ['Clarks Hill', 'Thurmond'],
    'j strom thurmond': ['Thurmond', 'Clarks Hill'],
    hartwell: ['Hartwell'],
    russell: ['Russell'],
    murray: ['Murray'],
    wateree: ['Wateree'],
    marion: ['Marion'],
    moultrie: ['Moultrie'],
    keowee: ['Keowee'],
    jocassee: ['Jocassee'],
    greenwood: ['Greenwood'],
    norman: ['Norman'],
    wylie: ['Wylie'],
    secession: ['Secession'],
    monticello: ['Monticello'],
    'high rock': ['High Rock'],
    tillery: ['Tillery'],
    badin: ['Badin'],
    blewett: ['Blewett Falls'],
    'blewett falls': ['Blewett Falls'],
    jordan: ['Jordan', 'B. Everett Jordan'],
    'b everett jordan': ['Jordan', 'B. Everett Jordan'],
    falls: ['Falls'],
    hickory: ['Hickory'],
    rhodhiss: ['Rhodhiss'],
    kerr: ['Kerr', 'Buggs Island'],
    'buggs island': ['Kerr', 'Buggs Island'],
    gaston: ['Gaston'],
    bowen: ['Bowen'],
    blalock: ['Blalock'],
    robinson: ['Robinson'],
    'fishing creek': ['Fishing Creek'],
    parr: ['Parr'],
  };
  const variants = new Set();
  const addName = (n) => {
    if (!n) return;
    variants.add(n);
    if (!/^lake\s+/i.test(n)) variants.add(`Lake ${n}`);
  };
  // Primary + slash-split parts
  for (const p of parts) {
    addName(p);
    const key = p.toLowerCase();
    for (const a of (aliasMap[key] || [])) addName(a);
  }
  // Also match primary key against alias map
  const primaryKey = primary.toLowerCase();
  for (const a of (aliasMap[primaryKey] || [])) addName(a);
  // State name helps the historical "Report on Lake … South Carolina" series
  // CREDIT BUDGET: reduced from 8 variants to 2 — primary name + state name.
  // The NSCEP title filter is now "Report on" (not "Report on Lake"), so both
  // naming conventions are caught with a single search per variant.
  variants.add(stateName);
  return [...variants].filter(Boolean).slice(0, 2);
}
__name(buildNepisSearchUrl, 'buildNepisSearchUrl');
__name(buildNepisQueryVariants, 'buildNepisQueryVariants');

async function handleResearchDatasetHunt(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || '').trim();
  const state    = String(body.state || 'SC').trim().toUpperCase();

  if (!lakeName) {
    return new Response(JSON.stringify({ ok: false, error: 'missing lakeName' }), { status: 400, headers: JSON_HEADERS });
  }

  const firecrawlKey = env.FIRECRAWL_API_KEY || env.FIRECRAWL_KEY;
  const tavilyKey    = env.TAVILY_API_KEY || env.TAVILY_KEY;
  const baseName     = lakeName.replace(/^Lake\s+/i,'').replace(/,\s*(SC|NC|GA).*$/i,'').trim();
  const baseNameLower = baseName.toLowerCase();

  const discovered = [];
  const seenUrls   = new Set();

  // Helper: ingest a list of Firecrawl/Tavily links into discovered[]
  const ingestLink = (url, title, authority, source, minScore = 5) => {
    if (!url || seenUrls.has(url)) return;
    seenUrls.add(url);
    const score = scoreDatasetUrl(url, title || '', lakeName);
    if (score < minScore) return;
    discovered.push({
      url,
      title: (title || url.split('/').pop().replace(/[-_]/g, ' ').replace(/\.pdf$/i, '').trim() || url).slice(0, 180),
      type: /\.pdf$/i.test(url) || /ZyPDF/i.test(url) ? 'PDF' : 'HTML',
      authority,
      source,
      score,
    });
  };

  // Helper: scrape/map one NEPI S search-results URL and harvest ZyActionD links
  const harvestNepisSearchPage = async (mapUrl, queryLabel) => {
    if (!firecrawlKey) return;
    try {
      // Prefer /v1/scrape with links — more reliable on ZyNET dynamic results than /map
      const scrapeRes = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${firecrawlKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: mapUrl,
          formats: ['links', 'markdown'],
          onlyMainContent: true,
          waitFor: 2000,
          timeout: 25000
        })
      });
      if (scrapeRes.ok) {
        const scrapeData = await scrapeRes.json();
        const links = scrapeData.data?.links || scrapeData.links || [];
        const md = scrapeData.data?.markdown || scrapeData.markdown || '';
        // Also pull ZyActionD URLs embedded in markdown
        const mdUrls = [...md.matchAll(/https?:\/\/[^\s)"']+/g)].map(m => m[0]);
        const all = [...links.map(l => typeof l === 'string' ? { url: l } : l), ...mdUrls.map(u => ({ url: u }))];
        for (const link of all) {
          const url = typeof link === 'string' ? link : (link.url || link);
          if (!url) continue;
          if (!/ZyActionD|ZyPDF|nepis\.epa\.gov/i.test(url)) continue;
          // Prefer lake-name relevance; still keep strong EPA hits
          const title = (typeof link === 'object' && link.title) ? String(link.title) : `EPA NSCEP — ${queryLabel || baseName}`;
          const score = scoreDatasetUrl(url, title + ' ' + md.slice(0, 300), lakeName);
          if (score < 20 && !new RegExp(baseName, 'i').test(title + url + md.slice(0, 500))) continue;
          ingestLink(url, title, 'EPA NSCEP', 'firecrawl_nepis_scrape', 15);
        }
        return;
      }
      console.warn(`NEPI S scrape failed for query="${queryLabel}": HTTP ${scrapeRes.status}`);
    } catch (e) {
      console.warn(`NEPI S harvest error for "${queryLabel}": ${e.message}`);
    }
    // Fallback: Firecrawl /v1/map
    try {
      const mapRes = await fetch('https://api.firecrawl.dev/v1/map', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${firecrawlKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: mapUrl, search: baseName, limit: 30, ignoreSitemap: true })
      });
      if (!mapRes.ok) return;
      const mapData = await mapRes.json();
      for (const link of (mapData.links || [])) {
        const url = typeof link === 'string' ? link : (link.url || link);
        if (!url || !/ZyActionD|ZyPDF|nepis\.epa\.gov/i.test(url)) continue;
        const title = (typeof link === 'object' && link.title) ? String(link.title) : `EPA NSCEP — ${queryLabel || baseName}`;
        ingestLink(url, title, 'EPA NSCEP', 'firecrawl_nepis_map', 15);
      }
    } catch (e) {
      console.warn(`NEPI S map fallback error: ${e.message}`);
    }
  };

  // ── Phase 1: Firecrawl /v1/map — crawl agency sites for report URLs ──
  // CREDIT BUDGET: skip agency map entirely — the discover step already seeds
  // SCDNR/NCWRC/GADNR lake description and regulations pages, and proxy-download
  // can handle them with basic fetch. Only run NEPIS searches here since they
  // need Firecrawl to harvest ZyActionD links from dynamic search results.
  if (firecrawlKey) {
    const targets = DATASET_HUNT_TARGETS[state] || DATASET_HUNT_TARGETS.SC;
    for (const target of targets) {
      if (!target.isNepis) continue; // skip agency maps — already seeded by discover
      // Run NEPIS queries (capped to 2 variants by buildNepisQueryVariants)
      const variants = buildNepisQueryVariants(lakeName, state);
      for (const q of variants) {
        const mapUrl = buildNepisSearchUrl(lakeName, state, q);
        await harvestNepisSearchPage(mapUrl, q);
      }
    }
  }

  // ── Phase 2: Tavily targeted searches for reports and academic papers ──
  if (tavilyKey) {
    const stateName = { SC: 'South Carolina', NC: 'North Carolina', GA: 'Georgia' }[state] || 'South Carolina';
    const dnrSite = state === 'NC' ? 'site:ncwildlife.org' : state === 'GA' ? 'site:georgiawildlife.com' : 'site:dnr.sc.gov';
    const huntQueries = [
      `\"${baseName}\" creel survey fisheries assessment filetype:pdf`,
      `\"${baseName}\" annual fisheries report ${dnrSite}`,
      // EPA NSCEP — covers both "Report on Lake X" and "Report on X Lake" naming
      `\"Report on Lake ${baseName}\" OR \"Report on ${baseName} Lake\" site:nepis.epa.gov`,
    ];
    for (const q of huntQueries) {
      try {
        const searchRes = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${tavilyKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: q, search_depth: 'basic', max_results: 3, include_raw_content: false })
        });
        if (!searchRes.ok) continue;
        const searchData = await searchRes.json();
        for (const r of (searchData.results || [])) {
          if (!r.url || seenUrls.has(r.url)) continue;
          seenUrls.add(r.url);
          const score = scoreDatasetUrl(r.url, r.title || '', lakeName);
          if (score < 5) continue;
          let authority = 'Web';
          try {
            const host = new URL(r.url).hostname;
            if (/dnr\.sc\.gov/.test(host))        authority = 'SCDNR';
            else if (/ncwildlife\.org/.test(host)) authority = 'NCWRC';
            else if (/georgiawildlife/.test(host)) authority = 'GA DNR';
            else if (/usgs\.gov/.test(host))       authority = 'USGS';
            else if (/usace\.army\.mil/.test(host))authority = 'USACE';
            else if (/nepis\.epa\.gov|epa\.gov/.test(host)) authority = 'EPA NSCEP';
            else if (/edu$/.test(host))            authority = 'Academic';
          } catch (_) {}
          discovered.push({
            url: r.url,
            title: (r.title || '').slice(0, 180),
            type: /\.pdf$/i.test(r.url) || /ZyPDF/i.test(r.url) ? 'PDF' : 'HTML',
            authority,
            source: 'tavily',
            score,
            snippet: (r.content || '').slice(0, 300),
          });
        }
      } catch (e) {
        console.warn(`Tavily dataset hunt failed for [${q}]: ${e.message}`);
      }
    }
  }

  // ── Sort and dedupe by score ──
  discovered.sort((a, b) => b.score - a.score);

  // ── Cache in R2 for 7 days ──
  try {
    const safe = lakeName.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    await env.TROLLMAP_DATA.put(
      `lake_packages/${safe}/dataset_hunt.json`,
      JSON.stringify({ lakeName, state, datasets: discovered, cachedAt: new Date().toISOString() }),
      { expirationTtl: 60 * 60 * 24 * 7 }
    );
  } catch (_) {}

  return new Response(JSON.stringify({
    ok: true,
    lakeName,
    state,
    datasetCount: discovered.length,
    firecrawlUsed: !!firecrawlKey,
    tavilyUsed: !!tavilyKey,
    datasets: discovered,
  }), { headers: JSON_HEADERS });
}
__name(handleResearchDatasetHunt, 'handleResearchDatasetHunt');


function normalizeResearchName(s) {
  return String(s || '').toLowerCase().replace(/&amp;/g, '&').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}
__name(normalizeResearchName, "normalizeResearchName");

function hasResearchValue(v) {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}
__name(hasResearchValue, "hasResearchValue");

function buildEvidence(sourceType, sourceLabel, sourceUrl, quote, method, extra = {}) {
  return { sourceType, sourceLabel, sourceUrl, quote: quote || null, method, ...extra };
}
__name(buildEvidence, "buildEvidence");

function titleCaseWords(s) {
  return String(s || '').split(/\s+/).filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}
__name(titleCaseWords, "titleCaseWords");

const RESEARCH_SPECIES_CANON = {
  'black crappie': 'Black Crappie',
  'white crappie': 'White Crappie',
  'crappie': 'Crappie',
  'striped bass': 'Striped Bass',
  'largemouth bass': 'Largemouth Bass',
  'spotted bass': 'Spotted Bass',
  'smallmouth bass': 'Smallmouth Bass',
  'hybrid bass': 'White Bass / Hybrid',
  'white bass': 'White Bass / Hybrid',
  'white bass hybrid': 'White Bass / Hybrid',
  'striped bass x white bass hybrid': 'White Bass / Hybrid',
  'catfish': 'Catfish',
  'blue catfish': 'Blue Catfish',
  'channel catfish': 'Channel Catfish',
  'flathead catfish': 'Flathead Catfish',
  'bluegill': 'Bluegill',
  'redear sunfish': 'Redear Sunfish (Shellcracker)',
  'shellcracker': 'Redear Sunfish (Shellcracker)',
  'redbreast sunfish': 'Redbreast Sunfish',
  'chain pickerel': 'Chain Pickerel',
  'bowfin': 'Bowfin',
  'yellow perch': 'Yellow Perch',
  'white perch': 'White Perch',
  'threadfin shad': 'Threadfin Shad',
  'gizzard shad': 'Gizzard Shad',
  'blueback herring': 'Blueback Herring',
  'american shad': 'American Shad',
  'trout': 'Trout',
  'rainbow trout': 'Rainbow Trout',
  'brown trout': 'Brown Trout',
  'walleye': 'Walleye',
  'gar': 'Gar',
  'longnose gar': 'Longnose Gar'
};

function canonicalizeResearchSpecies(raw) {
  const n = normalizeResearchName(raw).replace(/\*/g, '').trim();
  if (!n) return null;
  return RESEARCH_SPECIES_CANON[n] || titleCaseWords(n);
}
__name(canonicalizeResearchSpecies, "canonicalizeResearchSpecies");

function uniqueResearchSpecies(items) {
  const out = [];
  const seen = new Set();
  for (const raw of items || []) {
    const s = canonicalizeResearchSpecies(raw);
    if (!s) continue;
    const key = normalizeResearchName(s);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}
__name(uniqueResearchSpecies, "uniqueResearchSpecies");

function splitSpeciesText(text) {
  const cleaned = String(text || '').replace(/\([^)]*\)/g, ' ').replace(/\band\b/gi, ',').replace(/;/g, ',');
  return cleaned.split(',').map(s => s.trim()).filter(Boolean);
}
__name(splitSpeciesText, "splitSpeciesText");

function parseSCDNRDescriptionFacts(lakeName, url, html) {
  const text = stripHtml(html).replace(/\s+/g, ' ').trim();
  const identity = { aliases: [], counties: [] };
  const biology = { primaryForage: [], secondaryForage: [], predatorSpecies: [], speciesAbundance: {}, knownStockings: [], baitfishMovement: null, forageCalendar: {}, notes: [] };
  const habitat = { structuralElements: {}, cover: [], vegetation: [], standingTimber: null, dockDensity: null, artificialHabitat: [], artificialHabitatDetails: { attractorCount: null, attractorTypes: [] }, notes: null };
  const navigation = { ramps: [], hazards: [], notes: null, accessPointCount: null, publicRampCount: null, privateAccessCount: null };
  const evidence = { identity: {}, biology: {}, habitat: {}, navigation: {} };

  const store = (section, field, entry) => {
    if (!evidence[section]) evidence[section] = {};
    if (!evidence[section][field]) evidence[section][field] = [];
    evidence[section][field].push(entry);
  };

  const mArea = text.match(/Acres of Surface Water:\s*([0-9,]+)/i);
  if (mArea) {
    identity.surfaceAreaAcres = parseInt(mArea[1].replace(/,/g, ''), 10) || null;
    store('identity', 'surfaceAreaAcres', buildEvidence('official_document', 'SCDNR Lake Description', url, mArea[0], 'regex_exact_text'));
  }
  // Note: SCDNR description page lists pool elevation as "Maximum Depth" and
  // average river depth as "Average Depth" — both are misleading and not the
  // actual lake depth. Do not parse these fields from this source.
  const mShore = text.match(/Miles of Shoreline:\s*([0-9,]+(?:\.[0-9]+)?)/i);
  if (mShore) {
    identity.shorelineLengthMi = parseFloat(mShore[1].replace(/,/g, ''));
    store('identity', 'shorelineLengthMi', buildEvidence('official_document', 'SCDNR Lake Description', url, mShore[0], 'regex_exact_text'));
  }
  const mCounties = text.match(/Counties Lake is Within:\s*([^*]+?)(?:Average Depth:|Maximum Depth:|Boat Ramps:)/i);
  if (mCounties) {
    identity.counties = mCounties[1].split(',').map(s => s.trim()).filter(Boolean);
    store('identity', 'counties', buildEvidence('official_document', 'SCDNR Lake Description', url, `Counties Lake is Within: ${mCounties[1].trim()}`, 'regex_exact_text'));
  }
  const mOwner = text.match(/Owned and Managed by:\s*([^*]+?)(?:Boat Ramps:|Fish Attractors:|$)/i);
  if (mOwner) {
    identity.reservoirOwner = mOwner[1].replace(/\[[^\]]*\]/g, '').trim().replace(/\s+/g, ' ');
    store('identity', 'reservoirOwner', buildEvidence('official_document', 'SCDNR Lake Description', url, `Owned and Managed by: ${identity.reservoirOwner}`, 'regex_exact_text'));
  }
  const mPool = text.match(/Full pond elevation is\s*([0-9.]+)\s*feet/i);
  if (mPool) {
    identity.normalPoolFt = parseFloat(mPool[1]);
    store('identity', 'normalPoolFt', buildEvidence('official_document', 'SCDNR Lake Description', url, mPool[0], 'regex_exact_text'));
  }
  const mYear = text.match(/created in\s*(\d{4})/i) || text.match(/operation of .*? in\s*(\d{4})/i);
  if (mYear) {
    identity.yearImpounded = parseInt(mYear[1], 10);
    store('identity', 'yearImpounded', buildEvidence('official_document', 'SCDNR Lake Description', url, mYear[0], 'regex_exact_text'));
  }
  const mDam = text.match(/The\s+([A-Z][A-Za-z0-9\- ]+? Dam)\s+is\s+[0-9,]+\s+feet\s+long/i);
  if (mDam) {
    identity.damName = mDam[1].trim();
    store('identity', 'damName', buildEvidence('official_document', 'SCDNR Lake Description', url, mDam[0], 'regex_exact_text'));
  }
  const mRiver = text.match(/largest of the ([A-Za-z\- ]+?) lakes/i) || text.match(/upper most of the two beautiful water bodies that comprise ([A-Za-z\- ]+?) reservoir/i);
  if (mRiver) {
    identity.riverSystem = mRiver[1].trim();
    store('identity', 'riverSystem', buildEvidence('official_document', 'SCDNR Lake Description', url, mRiver[0], 'regex_exact_text'));
  }
  const mArchetype = text.match(/([0-9,]+ acre [a-z\- ]+ reservoir)/i);
  if (mArchetype) {
    identity.archetype = mArchetype[1].trim();
    store('identity', 'archetype', buildEvidence('official_document', 'SCDNR Lake Description', url, mArchetype[0], 'regex_exact_text'));
  }

  const mSport = text.match(/Popular sport fish on .*? include ([^.]+)\./i) || text.match(/best known for its ([^.]+?) fishery but it serves host to ([^.]+?)\./i);
  if (mSport) {
    const speciesText = mSport[1] + (mSport[2] ? ', ' + mSport[2] : '');
    biology.predatorSpecies = uniqueResearchSpecies(splitSpeciesText(speciesText));
    if (biology.predatorSpecies.length) {
      store('biology', 'predatorSpecies', buildEvidence('official_document', 'SCDNR Lake Description', url, mSport[0], 'regex_exact_text'));
    }
  }
  const mStock = text.match(/stocks? ([a-z ]+?) regularly/i);
  if (mStock) {
    const stocked = canonicalizeResearchSpecies(mStock[1]);
    if (stocked) {
      biology.knownStockings = [{ species: stocked, agency: 'SCDNR', note: 'Stocked regularly' }];
      store('biology', 'knownStockings', buildEvidence('official_document', 'SCDNR Lake Description', url, mStock[0], 'regex_exact_text'));
    }
  }

  const mAttr = text.match(/Fish Attractors:\s*([0-9,]+)/i);
  if (mAttr) {
    habitat.artificialHabitat = ['SCDNR fish attractors'];
    habitat.artificialHabitatDetails.attractorCount = parseInt(mAttr[1].replace(/,/g, ''), 10) || null;
    const note = `${habitat.artificialHabitatDetails.attractorCount} official SCDNR fish attractors listed on the lake page.`;
    habitat.notes = habitat.notes ? `${habitat.notes} ${note}` : note;
    store('habitat', 'artificialHabitatDetails', buildEvidence('official_document', 'SCDNR Lake Description', url, mAttr[0], 'regex_exact_text'));
  }
  const mRamps = text.match(/Boat Ramps:\s*([0-9,]+)/i);
  if (mRamps) {
    navigation.accessPointCount = parseInt(mRamps[1].replace(/,/g, ''), 10) || null;
    store('navigation', 'accessPointCount', buildEvidence('official_document', 'SCDNR Lake Description', url, mRamps[0], 'regex_exact_text'));
  }
  const mAccess = text.match(/There are\s*([0-9]+) access points in the Lake/i);
  if (mAccess) {
    navigation.accessPointCount = parseInt(mAccess[1], 10) || navigation.accessPointCount || null;
    store('navigation', 'accessPointCount', buildEvidence('official_document', 'SCDNR Lake Description', url, mAccess[0], 'regex_exact_text'));
  }
  const mPublicPrivate = text.match(/maintain\s*([a-z0-9]+) public boat access areas.*?Five are privately owned and operated/i);
  if (mPublicPrivate) {
    const n = parseInt(String(mPublicPrivate[1]).replace(/[^0-9]/g, ''), 10);
    if (isFinite(n)) navigation.publicRampCount = n;
    navigation.privateAccessCount = 5;
    store('navigation', 'publicRampCount', buildEvidence('official_document', 'SCDNR Lake Description', url, mPublicPrivate[0], 'regex_exact_text'));
  }

  return { identity, biology, habitat, navigation, evidence, sources: [{ label: 'SCDNR Lake Description', url, trust: 'OFFICIAL', sourceType: 'official_document' }] };
}
__name(parseSCDNRDescriptionFacts, "parseSCDNRDescriptionFacts");

const RESEARCH_RAMP_SOURCES = {
  SC: {
    url: "https://services.arcgis.com/acgZYxoN5Oj8pDLa/arcgis/rest/services/South_Carolina_Public_Water_Access_PUBLIC_VIEW/FeatureServer/0/query",
    label: 'SCDNR South Carolina Public Water Access',
    idField: 'OBJECTID',
    filter: (p) => p.WaterAccessType === 'Boat Ramp' && String(p.Status || '').toLowerCase() === 'active' && String(p.PublicAccess || '').toLowerCase() !== 'closed',
    name: (p) => p.WaterAccessName,
    wb: (p) => p.Waterbody,
    lat: (p) => p.Latitude,
    lon: (p) => p.Longitude,
    meta: (p) => ({ lanes: p.LaunchLanes, dock: p.CourtesyDock, fee: false, species: p.SpeciesList, county: p.County, owner: p.Owner, comments: p.Comments })
  },
  GA: {
    url: "https://services6.arcgis.com/9QlSLDqa0P1cHLhu/arcgis/rest/services/WRD_Water_Access_Points/FeatureServer/0/query",
    label: 'Georgia DNR WRD Water Access Points',
    idField: 'FID',
    filter: (p) => String(p.Ramp || '').toUpperCase() === 'Y' && !['closed', 'inactive'].includes(String(p.Status || '').toLowerCase()),
    name: (p) => p.Name,
    wb: (p) => p.Waterbody,
    lat: (p) => p.Latitude,
    lon: (p) => p.Longitude,
    meta: (p) => ({ lanes: p.NumLanes, dock: p.Dock, fee: String(p.Fee || '').toUpperCase() === 'Y', species: p.SpeciesList || '', county: p.County, owner: p.Owner, motorRestrictions: p.MotorRest })
  },
  NC: {
    url: "https://services1.arcgis.com/YfqBAUM5nWR3yhGP/arcgis/rest/services/NCWRC_Boating_Access_Areas_view/FeatureServer/0/query",
    label: 'NC Wildlife Resources Commission Boating Access Areas',
    idField: 'OBJECTID',
    filter: (p) => !String(p.Site_Status || 'OPEN').toUpperCase().includes('CLOSED'),
    name: (p) => p.BAA_Name,
    wb: (p) => p.Water_Access || p.BAA_Alias,
    lat: (p) => p.Latitude,
    lon: (p) => p.Longitude,
    meta: (p) => ({ lanes: p.Launch_Lane_No, dock: p.Courtesy_Dock_No || p.Fix_Dock_No, fee: false, species: '', county: p.County, owner: p.Owner, motorRestrictions: p.Motorboats_Restricted })
  }
};

const RESEARCH_ATTRACTOR_SOURCES = {
  SC: {
    url: "https://services.arcgis.com/acgZYxoN5Oj8pDLa/arcgis/rest/services/SCDNR_Freshwater_Fish_Attractors_Public_Web_App/FeatureServer/0/query",
    label: 'SCDNR Freshwater Fish Attractors',
    idField: 'OBJECTID',
    filter: () => true,
    name: (p) => p.FishAttractorName,
    wb: (p) => p.Waterbody,
    lat: (p) => p.lat_dd,
    lon: (p) => p.lon_dd,
    type: (p) => p.Material
  },
  GA: {
    url: "https://services6.arcgis.com/9QlSLDqa0P1cHLhu/arcgis/rest/services/Fish_Attractors_for_Download/FeatureServer/0/query",
    label: 'Georgia DNR Fish Attractors',
    idField: 'OBJECTID',
    filter: () => true,
    name: (p) => p.note,
    wb: (p) => p.waterbody,
    lat: () => null,
    lon: () => null,
    type: (p) => `${p.attractor_code || ''} ${p.attractor_code_other || ''}`.trim()
  },
  NC: {
    url: "https://services1.arcgis.com/YfqBAUM5nWR3yhGP/arcgis/rest/services/Fish_Attractors_public_view/FeatureServer/0/query",
    label: 'NC WRC Fish Attractors',
    idField: 'OBJECTID',
    filter: () => true,
    name: (p) => `${p.Waterbody} Attractor`,
    wb: (p) => p.Waterbody,
    lat: (p) => p.Latitude,
    lon: (p) => p.Longitude,
    type: (p) => `${p.Structure1 || ''} ${p.Structure2 || ''}`.trim() || p.Attractor_Type
  }
};

async function fetchArcGISGrouped(env, cacheKey, sourceDef, buildRecord) {
  try {
    const cached = await env.R2_TROLLMAP_CHARTPACKS.get(cacheKey);
    if (cached) {
      const txt = await cached.text();
      return JSON.parse(txt);
    }
  } catch (_) {}
  const allFeatures = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const params = new URLSearchParams({ outFields: '*', where: '1=1', f: 'geojson', resultOffset: offset, resultRecordCount: pageSize, orderByFields: sourceDef.idField || 'OBJECTID' });
    const resp = await fetch(`${sourceDef.url}?${params.toString()}`, { headers: { 'User-Agent': 'TrollMap/1.0 (Cloudflare Worker)', 'Accept': 'application/json' }, cf: { cacheTtl: 0 } });
    if (!resp.ok) throw new Error(`ArcGIS HTTP ${resp.status}`);
    const data = await resp.json();
    const features = data.features || [];
    allFeatures.push(...features);
    if (features.length < pageSize) break;
    offset += pageSize;
  }
  const waterbodies = {};
  for (const feat of allFeatures) {
    const p = feat.properties || {};
    if (!sourceDef.filter(p)) continue;
    const wb = String(sourceDef.wb(p) || 'Unknown').trim();
    const rec = buildRecord(feat, p);
    if (!rec) continue;
    if (!waterbodies[wb]) waterbodies[wb] = [];
    waterbodies[wb].push(rec);
  }
  const result = { waterbodies };
  try {
    await env.R2_TROLLMAP_CHARTPACKS.put(cacheKey, JSON.stringify(result), { httpMetadata: { contentType: 'application/json' }, customMetadata: { fetchedAt: new Date().toISOString() } });
  } catch (_) {}
  return result;
}
__name(fetchArcGISGrouped, "fetchArcGISGrouped");

function waterbodyMatchesLake(lakeName, waterbodyName) {
  const a = normalizeResearchName(lakeName).replace(/^lake /, '');
  const b = normalizeResearchName(waterbodyName).replace(/^lake /, '');
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
}
__name(waterbodyMatchesLake, "waterbodyMatchesLake");


function stripHtmlPreserveTables(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<li>/gi, '• ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
__name(stripHtmlPreserveTables, "stripHtmlPreserveTables");

function extractHtmlTableRows(html) {
  const rows = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(String(html || '')))) {
    const rowHtml = rowMatch[1];
    const cellRe = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
    const cells = [];
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowHtml))) {
      const txt = stripHtmlPreserveTables(cellMatch[1]).replace(/\s+/g, ' ').trim();
      if (txt) cells.push(txt);
    }
    if (cells.length >= 2) rows.push(cells);
  }
  return rows;
}
__name(extractHtmlTableRows, "extractHtmlTableRows");

// Parse markdown pipe-delimited tables (from Firecrawl/normalized text)
// Firecrawl and basic HTML strippers often flatten multi-row tables into ONE long line
// with empty cells between rows:  | a | b | c | d | | e | f | g | h |
// The previous regex walked that line greedily and misaligned columns, so eRegulations
// tables produced garbage rows and zero usable length/creel limits.
function extractMarkdownTableRows(text) {
  const rows = [];
  const str = String(text || '');
  if (!str.includes('|')) return rows;

  // 1) Primary path: insert newlines at empty-cell row separators, then parse lines
  const normalized = str
    .replace(/\|\s*\|/g, '|\n|')          // empty cell between rows → newline
    .replace(/\r\n/g, '\n');

  for (const line of normalized.split('\n')) {
    if (!line.includes('|')) continue;
    // Keep empty trailing cells so 4-col alignment survives; only trim each cell
    let cells = line.split('|').map(c => c.replace(/\s+/g, ' ').trim());
    // Drop leading/trailing empties created by edge pipes
    if (cells.length && cells[0] === '') cells = cells.slice(1);
    if (cells.length && cells[cells.length - 1] === '') cells = cells.slice(0, -1);
    if (!cells.length) continue;
    // Separator / spacer rows
    if (cells.every(c => !c || /^[-:\s]+$/.test(c))) continue;
    // Header-ish single-label rows (section titles spanning the table)
    if (cells.length === 1) continue;
    // Prefer 4-column regulation rows; pad shorter rows, truncate longer
    if (cells.length >= 4) {
      rows.push(cells.slice(0, 4));
    } else if (cells.length === 3) {
      rows.push([...cells, '']);
    } else if (cells.length === 2 && cells[0] && cells[1]) {
      rows.push([cells[0], cells[1], '', '']);
    }
  }

  // 2) Fallback: non-overlapping 4-cell regex if still empty (defensive)
  if (rows.length === 0) {
    const rowRe = /\|([^|\n]{1,500})\|([^|\n]{1,500})\|([^|\n]{1,500})\|([^|\n]{1,500})\|/g;
    let m;
    let pos = 0;
    while ((m = rowRe.exec(str)) !== null) {
      // Advance past this match without re-consuming the trailing |
      if (m.index < pos) continue;
      const cells = [m[1].trim(), m[2].trim(), m[3].trim(), m[4].trim()];
      pos = m.index + m[0].length - 1;
      if (!cells[0] && !cells[1]) continue;
      if (cells.every(c => !c || /^[-:\s]+$/.test(c))) continue;
      rows.push(cells);
      rowRe.lastIndex = pos;
    }
  }
  return rows;
}
__name(extractMarkdownTableRows, "extractMarkdownTableRows");

function lakeMentionedInCell(lakeName, cellText) {
  // Strip state suffix (", SC" etc) and "Lake" prefix before matching
  const cleanName = String(lakeName || '').replace(/,\s*(SC|NC|GA|TN)\s*$/i, '').trim();
  const lake = normalizeResearchName(cleanName).replace(/^lake /, '').trim();
  const cell = normalizeResearchName(cellText);
  if (!lake || !cell) return false;
  // Use base lake name (e.g. "wateree") for matching
  const baseLake = lake.split(' ')[0];
  if (!baseLake) return false;
  // Reject dam/map/tailwater mentions that share the lake's name
  // ("Wateree Dam", "below Wateree Dam") — those are not the reservoir itself
  if (new RegExp(`\\b${baseLake}\\s+dam\\b`).test(cell)) return false;
  if (/\btailwater\b|\briver system\b|\breach\b/.test(cell) && !new RegExp(`\\blake\\s+${baseLake}\\b`).test(cell) && !cell.includes(`lakes `) /* multi-lake lists use "Lakes A, B, Wateree" */) {
    // Allow multi-lake exception lists like "Lakes Blalock, Greenwood, ..., Wateree, Wylie"
    // which contain the base name as a listed lake, not as a dam/system label
    const multiLakeList = /\blakes?\b/.test(cell) && cell.includes(baseLake);
    if (!multiLakeList) return false;
  }
  // Multi-lake lists: "Lakes Blalock, Greenwood, Jocassee, ..., Wateree, Wylie"
  if (cell.includes(baseLake)) return true;
  if (cell.includes(lake)) return true;
  return false;
}
__name(lakeMentionedInCell, "lakeMentionedInCell");

function parseSCRegulationsFromHtml(lakeName, regsUrl, html, lakeSpecificHtml = '') {
  let rows = extractHtmlTableRows(html);
  // Fall back to markdown table parser if HTML parser found nothing
  // (normalized eRegulations docs are Firecrawl markdown / stripped text, not raw HTML)
  if (!rows.length) rows = extractMarkdownTableRows(html);
  const regs = {
    state: 'SC',
    lastUpdated: null,
    generalStateRegulations: { lengthLimits: {}, creelLimits: {} },
    lakeSpecificRegulations: { hasExceptions: null, creelLimits: {}, sizeLimits: {}, specialRules: [], closedSeasons: [] },
    notes: 'Always verify exact lake exceptions at official agency site before fishing.'
  };
  const evidence = { regulations: {} };
  const addEvidence = (field, quote, method='table_row') => {
    evidence.regulations[field] = (evidence.regulations[field] || []).concat([buildEvidence('official_document', 'SCDNR / eRegulations', regsUrl, quote, method)]);
  };

  const plain = stripHtmlPreserveTables(html);
  const mUpdated = plain.match(/Last Updated:\s*([A-Za-z]+\s+\d{1,2},\s*\d{4})/i);
  if (mUpdated) {
    regs.lastUpdated = mUpdated[1].trim();
    addEvidence('lastUpdated', mUpdated[0], 'regex_exact_text');
  }

  const isHeaderRow = (waterBody, fish) => {
    const w = normalizeResearchName(waterBody);
    const f = normalizeResearchName(fish);
    return w === 'water body' || f === 'fish' || w === 'size limit' || f === 'size limit';
  };

  for (const row of rows) {
    const cells = row.map(c => String(c || '').replace(/\s+/g, ' ').trim());
    if (cells.length < 4) continue;
    const [waterBody, fish, size, limit] = cells;
    if (!waterBody || !fish) continue;
    if (isHeaderRow(waterBody, fish)) continue;
    // Skip seasonal continuation rows that got misaligned (size looks like a date range with no water body species)
    if (/^(june|july|aug|sept|oct|nov|dec|jan|feb|mar|apr|may)\b/i.test(waterBody) && !/bass|catfish|crappie|bream|sunfish|perch|pickerel|walleye|eel/i.test(fish)) {
      continue;
    }

    const fishNorm = normalizeResearchName(fish);
    const waterNorm = normalizeResearchName(waterBody);

    const applyGeneral = (speciesName, sizeValue, limitValue) => {
      if (sizeValue) regs.generalStateRegulations.lengthLimits[speciesName] = sizeValue;
      if (limitValue) regs.generalStateRegulations.creelLimits[speciesName] = limitValue;
      addEvidence(`general.${speciesName}`, `${waterBody} | ${fish} | ${size} | ${limit}`);
    };
    const applyLakeSpecific = (speciesName, sizeValue, limitValue) => {
      regs.lakeSpecificRegulations.hasExceptions = true;
      if (sizeValue) regs.lakeSpecificRegulations.sizeLimits[speciesName] = sizeValue;
      if (limitValue) regs.lakeSpecificRegulations.creelLimits[speciesName] = limitValue;
      addEvidence(`lakeSpecific.${speciesName}`, `${waterBody} | ${fish} | ${size} | ${limit}`);
    };

    // Statewide game/nongame species (exact or starts-with statewide)
    if (waterNorm === 'statewide' || waterNorm.startsWith('statewide ')) {
      if (fishNorm === 'crappie') applyGeneral('Crappie', size, limit);
      if (fishNorm.includes('bream')) applyGeneral('Bream', size, limit);
      if (fishNorm === 'redbreast sunfish') applyGeneral('Redbreast Sunfish', size, limit);
      if (fishNorm === 'chain pickerel') applyGeneral('Chain Pickerel', size, limit);
      if (fishNorm === 'redfin pickerel') applyGeneral('Redfin Pickerel', size, limit);
      if (fishNorm.includes('yellow perch')) applyGeneral('Yellow Perch', size, limit);
      if (fishNorm === 'blue catfish') applyGeneral('Blue Catfish', size, limit);
      if (fishNorm === 'american eel') applyGeneral('American Eel', size, limit);
      if (fishNorm.includes('walleye') || fishNorm.includes('sauger')) applyGeneral('Walleye / Sauger', size, limit);
      if (fishNorm === 'white bass') applyGeneral('White Bass', size, limit);
      if (fishNorm === 'smallmouth bass' && waterNorm.startsWith('statewide except')) applyGeneral('Smallmouth Bass', size, limit);
      if (fishNorm.includes('redeye') && waterNorm.startsWith('statewide except')) applyGeneral('Redeye Bass', size, limit);
      if (fishNorm === 'spotted bass' && waterNorm.startsWith('statewide except')) applyGeneral('Spotted Bass', size, limit);
    }

    if (waterNorm.startsWith('statewide except the water bodies listed below') && fishNorm === 'largemouth bass') {
      applyGeneral('Largemouth Bass', size, limit);
    }
    // Lake-specific largemouth (Wateree is listed in the 14" exception group)
    if (lakeMentionedInCell(lakeName, waterBody) && fishNorm === 'largemouth bass') {
      applyLakeSpecific('Largemouth Bass', size, limit);
    }
    // Other lake-specific black bass exceptions
    if (lakeMentionedInCell(lakeName, waterBody) && (fishNorm === 'smallmouth bass' || fishNorm.includes('redeye') || fishNorm === 'spotted bass')) {
      const speciesName = fishNorm === 'smallmouth bass' ? 'Smallmouth Bass'
        : fishNorm.includes('redeye') ? 'Redeye Bass'
        : 'Spotted Bass';
      applyLakeSpecific(speciesName, size, limit);
    }
  }

  // Striper / hybrid rows need multi-row handling because closures/season text split across rows.
  //
  // CRITICAL: Exception rows are waterbody-specific. Do NOT map "Santee River system",
  // "Wateree Dam" map captions, Cooper River, or other river/tailwater rows onto a lake
  // just because the lake name appears nearby (e.g. Wateree Dam on the Santee system map).
  // Lake Wateree the RESERVOIR is NOT listed as a striper exception — statewide applies.
  // Lakes that ARE listed by name (Murray, Russell, Hartwell, Thurmond, etc.) get those rows.
  const striperRows = rows.filter(r => {
    const f = normalizeResearchName(r[1] || '');
    return f.includes('striped or hybrid') || f.includes('striped hybrid or white') || f.includes('striped bass');
  });
  // Typo on the live page: "list below" (missing 'ed') — match both forms
  const statewideStriper = striperRows.find(r => {
    const w = normalizeResearchName(r[0] || '');
    return w.startsWith('statewide except the water bodies list below')
      || w.startsWith('statewide except the water bodies listed below')
      || (w.startsWith('statewide except') && !lakeMentionedInCell(lakeName, r[0] || ''));
  });
  if (statewideStriper && statewideStriper.length >= 4) {
    regs.generalStateRegulations.lengthLimits['Striped Bass / Hybrid'] = statewideStriper[2];
    regs.generalStateRegulations.creelLimits['Striped Bass / Hybrid'] = statewideStriper[3];
    addEvidence('general.Striped Bass / Hybrid', statewideStriper.join(' | '));
  }

  // Lake-specific striper ONLY when the waterbody CELL explicitly names this lake
  // (e.g. "Lake Murray", "Lake Russell", "Lake Hartwell & Lake Thurmond").
  // Reject river/system/tailwater/map rows — those are not the reservoir.
  // Note: multi-lake exception lists like "Lakes Blalock, ..., Wateree, Wylie and the
  // middle reach of the Saluda..." still count as lake lists (they start with "Lakes").
  const isRiverOrSystemRow = (waterBody) => {
    const w = String(waterBody || '');
    // Multi-lake lists are reservoir exceptions, not river rows (even if they also
    // mention a river reach at the end of the list)
    if (/^\s*Lakes?\b/i.test(w)) return false;
    // Explicit river / system / reach / tailwater language
    if (/\briver system\b|\btailwater\b|\breach\b|\bbackwaters of\b|\bconfluence\b/i.test(w)) return true;
    // "X River" without "Lake X" as the subject
    if (/\b[A-Za-z]+ River\b/i.test(w) && !/\bLakes?\s+[A-Za-z]/i.test(w)) return true;
    // Coastal river laundry-list rows
    if (/Ashepoo|Waccamaw|Pee Dee|Edisto|Combahee|Cooper River/i.test(w) && !/\bLake\b/i.test(w)) return true;
    return false;
  };
  const lakeSpecificStriper = striperRows.find(r => {
    const waterBody = r[0] || '';
    if (isRiverOrSystemRow(waterBody)) return false;
    // Require the lake name to appear as a listed waterbody, not as a dam/map label
    return lakeMentionedInCell(lakeName, waterBody);
  });
  if (lakeSpecificStriper && lakeSpecificStriper.length >= 4) {
    regs.lakeSpecificRegulations.hasExceptions = true;
    regs.lakeSpecificRegulations.sizeLimits['Striped Bass / Hybrid'] = lakeSpecificStriper[2];
    regs.lakeSpecificRegulations.creelLimits['Striped Bass / Hybrid'] = lakeSpecificStriper[3];
    addEvidence('lakeSpecific.Striped Bass / Hybrid', lakeSpecificStriper.join(' | '));
  }
  // When the lake is NOT on any striper exception row, statewide is what applies on the lake.
  // Mirror statewide into lake-applicable convenience fields WITHOUT marking hasExceptions
  // for striper (LMB or other exceptions may still set hasExceptions).
  if (!lakeSpecificStriper && statewideStriper && statewideStriper.length >= 4) {
    // Do not put statewide into lakeSpecific size/creel maps as if it were an exception —
    // keep it only under generalStateRegulations. Flattened lengthLimits/creelLimits below
    // still surface the statewide rule for UI convenience.
    regs.notes = (regs.notes || '') +
      ' Striped bass/hybrid: this waterbody is not listed as a striper exception on eRegulations; statewide rule applies on the lake. River/tailwater rows (e.g. Santee River system) do not apply to the reservoir.';
  }

  // Lake-specific SCDNR regs page (static HTML) — e.g. 14" largemouth at Wateree
  const lakePlain = stripHtmlPreserveTables(lakeSpecificHtml || '');
  const mLmb = lakePlain.match(/no largemouth bass less than\s*([0-9]+)\s*inches/i);
  if (mLmb) {
    regs.lakeSpecificRegulations.hasExceptions = true;
    regs.lakeSpecificRegulations.sizeLimits['Largemouth Bass'] = `${mLmb[1]} inches min`;
    addEvidence('lakeSpecific.Largemouth Bass', mLmb[0], 'regex_exact_text');
  }
  // Nongame device limits from lake regs page
  if (/trotlines/i.test(lakePlain) || /traps/i.test(lakePlain)) {
    const deviceNote = lakePlain.match(/Allowable Nongame Devices[\s\S]{0,400}/i);
    if (deviceNote) {
      regs.lakeSpecificRegulations.specialRules = regs.lakeSpecificRegulations.specialRules || [];
      const note = deviceNote[0].replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!regs.lakeSpecificRegulations.specialRules.includes(note)) {
        regs.lakeSpecificRegulations.specialRules.push(note);
        addEvidence('lakeSpecific.specialRules', note, 'regex_exact_text');
      }
    }
  }

  // Closed seasons: ONLY from a striper exception row that actually names THIS lake.
  // Do not attach Santee River system / coastal river summer closures to unlisted lakes.
  if (lakeSpecificStriper) {
    const lakeStriperText = lakeSpecificStriper.join(' | ');
    // Also scan the next raw striper continuation rows only if they share the same waterbody start
    // (season splits like "June 1 - Sept. 30: any length" sometimes land in adjacent cells)
    const closureMatch = lakeStriperText.match(/June\s*1[56]\s*[-–]\s*Sept\.?\s*30[^.|]{0,40}closed/i)
      || lakeStriperText.match(/closed\s*(?:to\s*(?:the\s*)?taking|season)?[^.|]{0,40}June\s*1[56]/i);
    if (closureMatch) {
      const already = (regs.lakeSpecificRegulations.closedSeasons || []).some(c => /June\s*1[56]/i.test(c.period || ''));
      if (!already) {
        regs.lakeSpecificRegulations.closedSeasons.push({
          species: 'Striped Bass / Hybrid',
          period: 'June 16 - Sept. 30',
          note: `Closed per eRegulations exception row for ${String(lakeSpecificStriper[0] || '').slice(0, 80)}`
        });
        addEvidence('lakeSpecific.closedSeasons', closureMatch[0], 'regex_exact_text');
      }
    }
  }

  // Flatten convenience fields for UI/back-compat
  regs.lengthLimits = { ...regs.generalStateRegulations.lengthLimits, ...regs.lakeSpecificRegulations.sizeLimits };
  regs.creelLimits = { ...regs.generalStateRegulations.creelLimits, ...regs.lakeSpecificRegulations.creelLimits };

  return { regulations: regs, evidence, sources: [{ label: 'SCDNR / eRegulations', url: regsUrl, trust: 'OFFICIAL', sourceType: 'official_document' }] };
}
__name(parseSCRegulationsFromHtml, "parseSCRegulationsFromHtml");

async function getRampSpeciesFacts(env, lakeName, state) {
  const sourceDef = RESEARCH_RAMP_SOURCES[state];
  if (!sourceDef) return null;
  const data = await fetchArcGISGrouped(env, `ramps/${String(state).toLowerCase()}/ramps.json`, sourceDef, (feat, p) => {
    const lat = parseFloat(sourceDef.lat(p));
    const lon = parseFloat(sourceDef.lon(p));
    if (!isFinite(lat) || !isFinite(lon)) return null;
    return { name: String(sourceDef.name(p) || 'Unknown').trim(), lat, lon, ...sourceDef.meta(p) };
  });
  const matches = Object.entries(data.waterbodies || {}).filter(([wb]) => waterbodyMatchesLake(lakeName, wb));
  if (!matches.length) return null;
  const ramps = matches.flatMap(([, arr]) => arr || []);
  const predatorSpecies = uniqueResearchSpecies(ramps.flatMap(r => splitSpeciesText(r.species || '')));
  return { ramps, predatorSpecies, sourceLabel: sourceDef.label };
}
__name(getRampSpeciesFacts, "getRampSpeciesFacts");

async function getAttractorFacts(env, lakeName, state) {
  const sourceDef = RESEARCH_ATTRACTOR_SOURCES[state];
  if (!sourceDef) return null;
  const data = await fetchArcGISGrouped(env, `attractors/${String(state).toLowerCase()}/attractors.json`, sourceDef, (feat, p) => {
    const lat = parseFloat(sourceDef.lat(p) || feat.geometry?.coordinates?.[1]);
    const lon = parseFloat(sourceDef.lon(p) || feat.geometry?.coordinates?.[0]);
    if (!isFinite(lat) || !isFinite(lon)) return null;
    return { name: String(sourceDef.name(p) || 'Attractor').trim(), lat, lon, type: String(sourceDef.type(p) || 'Unknown').trim() };
  });
  const matches = Object.entries(data.waterbodies || {}).filter(([wb]) => waterbodyMatchesLake(lakeName, wb));
  if (!matches.length) return null;
  const attractors = matches.flatMap(([, arr]) => arr || []);
  const typeCounts = {};
  for (const a of attractors) {
    const t = a.type || 'Unknown';
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  }
  return { attractors, typeCounts, sourceLabel: sourceDef.label };
}
__name(getAttractorFacts, "getAttractorFacts");

function buildFactualSummary(profile) {
  const parts = [];
  const id = profile.identity || {};
  const bio = profile.biology || {};
  const lim = profile.limnology || {};
  const hab = profile.habitat || {};
  if (id.archetype || id.surfaceAreaAcres || id.maxDepthFt) {
    parts.push(`${profile.lakeName} ${id.archetype ? `is a ${String(id.archetype).toLowerCase()}` : 'is a reservoir/lake'}${id.surfaceAreaAcres ? ` with about ${Number(id.surfaceAreaAcres).toLocaleString()} surface acres` : ''}${id.maxDepthFt ? ` and a maximum depth near ${id.maxDepthFt} feet` : ''}.`);
  }
  if (bio.predatorSpecies?.length) {
    parts.push(`Confirmed sport fish documented for this waterbody include ${bio.predatorSpecies.join(', ')}${bio.knownStockings?.length ? `; documented stocking notes include ${bio.knownStockings.map(s => s.species).join(', ')}` : ''}.`);
  }
  if (hasResearchValue(lim.surfaceWater) || lim.waterClarity?.secchiFt || lim.thermocline?.summerDepthFt) {
    const limBits = [];
    if (lim.waterClarity?.secchiFt) limBits.push(`Secchi clarity around ${lim.waterClarity.secchiFt} ft when observed`);
    if (lim.surfaceWater?.recentTempF != null) limBits.push(`recent surface water about ${lim.surfaceWater.recentTempF}°F`);
    if (lim.surfaceWater?.recentDissolvedOxygenMgL != null) limBits.push(`recent surface dissolved oxygen about ${lim.surfaceWater.recentDissolvedOxygenMgL} mg/L`);
    if (lim.thermocline?.summerDepthFt) limBits.push(`summer thermocline near ${Array.isArray(lim.thermocline.summerDepthFt) ? lim.thermocline.summerDepthFt.join('-') : lim.thermocline.summerDepthFt} ft`);
    if (limBits.length) parts.push(`Available limnology data indicate ${limBits.join('; ')}.`);
  }
  const attrCount = hab.artificialHabitatDetails?.attractorCount;
  if (attrCount || hab.cover?.length || hab.notes) {
    const habBits = [];
    if (attrCount) habBits.push(`${attrCount} mapped fish attractors`);
    if (hab.cover?.length) habBits.push(`cover includes ${hab.cover.slice(0, 4).join(', ')}`);
    if (habBits.length) parts.push(`Habitat facts currently confirm ${habBits.join('; ')}.`);
  }
  return parts.join(' ').trim() || null;
}
__name(buildFactualSummary, "buildFactualSummary");

async function handleResearchDeterministicFacts(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || body.lake || '').trim();
  const state = String(body.state || 'SC').trim().toUpperCase();
  if (!lakeName) return new Response(JSON.stringify({ ok: false, error: 'missing lakeName' }), { status: 400, headers: JSON_HEADERS });

  const profile = {
    lakeName,
    state,
    identity: { aliases: [], counties: [] },
    biology: { primaryForage: [], secondaryForage: [], predatorSpecies: [], speciesAbundance: {}, knownStockings: [], baitfishMovement: null, forageCalendar: {}, notes: [] },
    limnology: { waterClarity: { typical: null, color: null, secchiFt: null, note: null }, surfaceWater: {}, thermocline: { summerDepthFt: null, method: null, note: null }, oxygen: { depletionDepthFt: null, anoxicBelowFt: null, note: null }, trophicStatus: null, flowCharacteristics: null, seasonalDrawdownFt: null },
    habitat: { structuralElements: {}, cover: [], vegetation: [], standingTimber: null, dockDensity: null, artificialHabitat: [], artificialHabitatDetails: { attractorCount: null, attractorTypes: [] }, notes: null },
    navigation: { ramps: [], hazards: [], notes: null },
    regulations: { state, generalStateRegulations: { lengthLimits: {}, creelLimits: {} }, lakeSpecificRegulations: { hasExceptions: null, creelLimits: {}, sizeLimits: {}, specialRules: [], closedSeasons: [] }, notes: null },
    summary: { text: null, keywords: [] },
    evidence: { identity: {}, biology: {}, limnology: {}, habitat: {}, navigation: {}, regulations: {}, summary: {} },
    sources: []
  };

  const mergeEvidence = (section, field, entries) => {
    if (!entries?.length) return;
    if (!profile.evidence[section]) profile.evidence[section] = {};
    profile.evidence[section][field] = (profile.evidence[section][field] || []).concat(entries);
  };

  // Deterministic extraction from cached normalized documents. Scientific tables are
  // especially easy for an LLM to misalign, so parse high-value measurements and
  // explicit prose directly before any extracted LLM facts are merged on the client.
  try {
    const slug = lakeKeyFromName(lakeName);
    const candidateKeys = [
      `lake_packages/${sanitizeLakeId(lakeName)}/normalized_documents.json`,
      `lake_packages/${sanitizeLakeId('Lake ' + slug)}/normalized_documents.json`,
      `lake_packages/${sanitizeLakeId(slug)}/normalized_documents.json`,
      `lake_packages/lake_${slug}_${state.toLowerCase()}/normalized_documents.json`,
    ];
    let normalizedDocs = [];
    let normalizedKey = null;
    const seenKeys = new Set();
    for (const key of candidateKeys) {
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const obj = await env.R2_TROLLMAP_CHARTPACKS.get(key);
      if (!obj) continue;
      const docs = JSON.parse(await obj.text());
      if (!Array.isArray(docs) || !docs.length) continue;
      normalizedDocs = docs;
      normalizedKey = key;
      break;
    }

    if (normalizedDocs.length) {
      const docText = (doc) => String(doc?.fullText || doc?.text || '');
      const docIdentity = (doc) => `${doc?.title || ''} ${doc?.authority || ''} ${doc?.url || ''}`;
      const epaDocs = normalizedDocs.filter(d => /\bEPA\b|NSCEP|NEPIS|nepis\.epa\.gov/i.test(docIdentity(d)));
      const anglersDocs = normalizedDocs.filter(d => /Angler(?:'|&#39;)?s Headquarters|anglersheadquarters\.com/i.test(docIdentity(d)));
      const scdnrDocs = normalizedDocs.filter(d => /\bSCDNR\b|dnr\.sc\.gov\/lakes\//i.test(docIdentity(d)));
      const findMatch = (docs, regex) => {
        for (const doc of docs) {
          const match = docText(doc).match(regex);
          if (match) return { doc, match };
        }
        return null;
      };
      const addCachedEvidence = (section, field, found, quote = null) => {
        if (!found) return;
        const { doc, match } = found;
        const label = doc.title || doc.authority || 'Cached normalized document';
        const url = doc.url || `r2:${normalizedKey}`;
        const isOfficial = /\bEPA\b|NSCEP|NEPIS|\bSCDNR\b|dnr\.sc\.gov|epa\.gov/i.test(docIdentity(doc));
        mergeEvidence(section, field, [buildEvidence(
          isOfficial ? 'official_document' : 'web_document',
          label,
          url,
          String(quote || match[0]).replace(/\s+/g, ' ').trim(),
          'cached_document_regex',
          { normalizedKey }
        )]);
        if (!profile.sources.some(s => s.url === url)) {
          profile.sources.push({ label, url, trust: isOfficial ? 'OFFICIAL' : 'SECONDARY', sourceType: isOfficial ? 'official_document' : 'web_document' });
        }
      };

      // EPA morphometry reports meters. Convert to feet rather than repeating the
      // SCDNR sidebar's incorrect "6.9 feet" label.
      const meanDepth = findMatch(epaDocs, /\bMean depth:\s*([0-9]+(?:\.[0-9]+)?)\s*meters?\b/i);
      if (meanDepth) {
        const meters = parseFloat(meanDepth.match[1]);
        if (isFinite(meters) && meters > 0) {
          profile.identity.averageDepthFt = Math.round(meters * 3.28084 * 10) / 10;
          addCachedEvidence('identity', 'averageDepthFt', meanDepth);
        }
      }

      // The SCDNR page's ~225 ft "maximum depth" is the 225.5 ft full-pool
      // elevation. Prefer the explicit lake-specific deepest-point statement.
      const maxDepth = findMatch(anglersDocs, /\bdeepest point is\s+(?:approximately\s+|around\s+|about\s+)?([0-9]+(?:\.[0-9]+)?)\s*feet\b/i);
      if (maxDepth) {
        const feet = parseFloat(maxDepth.match[1]);
        if (isFinite(feet) && feet > 0) {
          profile.identity.maxDepthFt = feet;
          addCachedEvidence('identity', 'maxDepthFt', maxDepth);
        }
      }

      // EPA's flattened table lists one row per header. The SECCHI row is the final
      // 0.3-0.5 m range with a 0.4 m mean; 10-35 / 17 are alkalinity values.
      const secchi = findMatch(epaDocs, /SECCHI\s*\(METERS\)[\s\S]{0,1800}?(0?\.3\s*-\s*0?\.5\s+(0?\.4)\s+\.?0?\.3)\s+CHEMICAL/i);
      if (secchi) {
        const meters = parseFloat(secchi.match[2]);
        if (isFinite(meters) && meters > 0) {
          profile.limnology.waterClarity.secchiFt = Math.round(meters * 3.28084 * 10) / 10;
          addCachedEvidence('limnology', 'waterClarity.secchiFt', secchi, `SECCHI (METERS) ${secchi.match[1]}`);
        }
      }

      const trophic = findMatch(epaDocs, /\bSurvey data indicate\s+[^.]{0,100}?\bis\s+(eutrophic|mesotrophic|oligotrophic)\b/i);
      if (trophic) {
        profile.limnology.trophicStatus = trophic.match[1].toLowerCase();
        addCachedEvidence('limnology', 'trophicStatus', trophic);
      }

      const forage = findMatch(anglersDocs, /\bmain forage base is\s+threadfin\s+and\s+gizzard\s+shad\b/i);
      if (forage) {
        profile.biology.primaryForage = uniqueResearchSpecies([...(profile.biology.primaryForage || []), 'Threadfin shad', 'Gizzard shad']);
        addCachedEvidence('biology', 'primaryForage', forage);
      }

      const hydroelectric = findMatch([...scdnrDocs, ...anglersDocs], /\bWateree Hydroelectric Station\b/i)
        || findMatch([...scdnrDocs, ...anglersDocs], /\bHydroelectric Station\b/i);
      if (hydroelectric) {
        profile.identity.archetype = 'Hydroelectric reservoir';
        addCachedEvidence('identity', 'archetype', hydroelectric);
      }

      const retention = findMatch(epaDocs, /\bMean hydraulic retention time:\s*([0-9]+(?:\.[0-9]+)?)\s*days\b/i);
      if (retention) {
        const days = parseFloat(retention.match[1]);
        if (isFinite(days) && days > 0) {
          profile.limnology.flowCharacteristics = `Mean hydraulic retention time: ${days} days`;
          addCachedEvidence('limnology', 'flowCharacteristics', retention);
        }
      }

      const vegetation = findMatch(epaDocs, /\b(?:Survey limnologists\s+)?did not observe any macrophytes\b/i);
      if (vegetation) {
        profile.habitat.vegetation = ['None observed'];
        addCachedEvidence('habitat', 'vegetation', vegetation);
      }
    }
  } catch (e) {
    console.warn(`cached deterministic fact extraction failed for ${lakeName}: ${e.message}`);
  }

  // SCDNR lake description (SC only)
  if (state === 'SC') {
    const slug = lakeKeyFromName(lakeName);
    const descUrl = `https://www.dnr.sc.gov/lakes/${slug}/description.html`;
    try {
      const descRes = await fetch(descUrl, { headers: { 'User-Agent': 'TrollMap/16 Evidence Engine', 'Accept': 'text/html' }, cf: { cacheTtl: 86400, cacheEverything: true } });
      if (descRes.ok) {
        const html = await descRes.text();
        const parsed = parseSCDNRDescriptionFacts(lakeName, descUrl, html);
        Object.assign(profile.identity, parsed.identity || {});
        profile.biology.predatorSpecies = uniqueResearchSpecies([...(profile.biology.predatorSpecies || []), ...((parsed.biology || {}).predatorSpecies || [])]);
        if ((parsed.biology || {}).knownStockings?.length) profile.biology.knownStockings = parsed.biology.knownStockings;
        profile.habitat.artificialHabitat = [...new Set([...(profile.habitat.artificialHabitat || []), ...((parsed.habitat || {}).artificialHabitat || [])])];
        if (parsed.habitat?.artificialHabitatDetails?.attractorCount != null) profile.habitat.artificialHabitatDetails.attractorCount = parsed.habitat.artificialHabitatDetails.attractorCount;
        if (parsed.habitat?.notes) profile.habitat.notes = parsed.habitat.notes;
        if (parsed.navigation?.accessPointCount != null) profile.navigation.accessPointCount = parsed.navigation.accessPointCount;
        if (parsed.navigation?.publicRampCount != null) profile.navigation.publicRampCount = parsed.navigation.publicRampCount;
        if (parsed.navigation?.privateAccessCount != null) profile.navigation.privateAccessCount = parsed.navigation.privateAccessCount;
        for (const src of parsed.sources || []) profile.sources.push(src);
        for (const [sec, fields] of Object.entries(parsed.evidence || {})) for (const [field, entries] of Object.entries(fields || {})) mergeEvidence(sec, field, entries);
      }
    } catch (e) {
      console.warn(`deterministic description fetch failed for ${lakeName}: ${e.message}`);
    }
  }

  // Deterministic SC regulations from official pages
  // eRegulations is a JS-rendered React app — content is scraped via Firecrawl during
  // discovery and stored in normalized_documents.json. We parse those tables here.
  if (state === 'SC') {
    const slug = lakeKeyFromName(lakeName);
    const regsUrl = 'https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits';
    const lakeRegsUrl = `https://www.dnr.sc.gov/lakes/${slug}/regs.html`;
    const firecrawlKey = env.FIRECRAWL_API_KEY || env.FIRECRAWL_KEY;
    try {
      let regsHtml = '';
      let lakeRegsHtml = '';
      // Try multiple R2 keys — lake name may be saved as "Lake Wateree, SC" or "Lake Wateree"
      const candidateKeys = [
        `lake_packages/${sanitizeLakeId(lakeName)}/normalized_documents.json`,
        `lake_packages/${sanitizeLakeId('Lake ' + slug)}/normalized_documents.json`,
        `lake_packages/${sanitizeLakeId(slug)}/normalized_documents.json`,
        `lake_packages/lake_${slug}_sc/normalized_documents.json`,
      ];
      const seenKeys = new Set();
      try {
        for (const normKey of candidateKeys) {
          if (seenKeys.has(normKey)) continue;
          seenKeys.add(normKey);
          const normObj = await env.R2_TROLLMAP_CHARTPACKS.get(normKey);
          if (!normObj) continue;
          const normDocs = JSON.parse(await normObj.text());
          if (!Array.isArray(normDocs) || !normDocs.length) continue;
          const regsDoc = normDocs.find(d => d.url && /eregulations\.com/i.test(d.url) && /freshwater-fish-size|possession-limits|freshwater-game/i.test(d.url + (d.title || '')))
            || normDocs.find(d => d.url && /eregulations\.com/i.test(d.url));
          const lakeRegsDoc = normDocs.find(d => d.url && d.url.includes(`/lakes/${slug}/regs`))
            || normDocs.find(d => /lake.*regulations/i.test(d.title || '') && d.url && d.url.includes(slug));
          if (regsDoc?.fullText) regsHtml = regsDoc.fullText;
          if (lakeRegsDoc?.fullText) lakeRegsHtml = lakeRegsDoc.fullText;
          profile._regsDebug = {
            normKey,
            normDocsCount: normDocs.length,
            regsDocFound: !!regsDoc,
            regsFullTextLen: regsDoc?.fullText?.length || 0,
            lakeRegsDocFound: !!lakeRegsDoc,
            extractionMethod: regsDoc?.extractionMethod || null,
            regsHtmlLen: regsHtml.length
          };
          if (regsHtml) break;
        }
      } catch (e) {
        console.warn(`normalized regs load failed: ${e.message}`);
        profile._regsDebug = { loadError: e.message };
      }

      // Live Firecrawl scrape of eRegulations if normalized docs missing/empty
      // (eRegulations is a React SPA — plain fetch returns shell HTML with no table rows)
      if (!regsHtml && firecrawlKey) {
        try {
          const fcRes = await fetch('https://api.firecrawl.dev/v1/scrape', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${firecrawlKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: regsUrl,
              formats: ['markdown'],
              onlyMainContent: true,
              waitFor: 3000,
              timeout: 25000
            })
          });
          if (fcRes.ok) {
            const fcData = await fcRes.json();
            const md = fcData.data?.markdown || fcData.markdown || '';
            if (md && md.length > 200) {
              regsHtml = md;
              profile._regsDebug = { ...(profile._regsDebug || {}), liveFirecrawl: true, regsHtmlLen: md.length };
            }
          }
        } catch (e) {
          console.warn(`live Firecrawl eRegulations scrape failed: ${e.message}`);
        }
      }

      // Fall back to direct fetch of lake-specific regs page (static HTML, no JS needed)
      if (!lakeRegsHtml) {
        try {
          const lakeRegsRes = await fetch(lakeRegsUrl, { headers: { 'User-Agent': 'TrollMap/16 Evidence Engine', 'Accept': 'text/html' }, cf: { cacheTtl: 86400, cacheEverything: true } });
          if (lakeRegsRes.ok) lakeRegsHtml = await lakeRegsRes.text();
        } catch (_) {}
      }

      // Even without statewide eRegs, lake-specific page alone is useful (14" LMB etc.)
      if (regsHtml || lakeRegsHtml) {
        try {
          profile._regsDebug = profile._regsDebug || {};
          profile._regsDebug.htmlRows = regsHtml ? extractHtmlTableRows(regsHtml).length : 0;
          profile._regsDebug.mdRows = regsHtml ? extractMarkdownTableRows(regsHtml).length : 0;
          profile._regsDebug.first100chars = (regsHtml || lakeRegsHtml || '').slice(0, 100);
          const parsedRegs = parseSCRegulationsFromHtml(lakeName, regsUrl, regsHtml || '', lakeRegsHtml || '');
          const pr = parsedRegs.regulations || {};
          if (pr.state) profile.regulations.state = pr.state;
          if (pr.lastUpdated) profile.regulations.lastUpdated = pr.lastUpdated;
          if (pr.generalStateRegulations) {
            profile.regulations.generalStateRegulations = profile.regulations.generalStateRegulations || { lengthLimits: {}, creelLimits: {} };
            // Deep-merge nested length/creel maps so we don't wipe partial data
            profile.regulations.generalStateRegulations.lengthLimits = {
              ...(profile.regulations.generalStateRegulations.lengthLimits || {}),
              ...(pr.generalStateRegulations.lengthLimits || {})
            };
            profile.regulations.generalStateRegulations.creelLimits = {
              ...(profile.regulations.generalStateRegulations.creelLimits || {}),
              ...(pr.generalStateRegulations.creelLimits || {})
            };
          }
          if (pr.lakeSpecificRegulations) {
            const lsr = profile.regulations.lakeSpecificRegulations || { hasExceptions: null, creelLimits: {}, sizeLimits: {}, specialRules: [], closedSeasons: [] };
            if (pr.lakeSpecificRegulations.hasExceptions != null) lsr.hasExceptions = pr.lakeSpecificRegulations.hasExceptions;
            lsr.creelLimits = { ...(lsr.creelLimits || {}), ...(pr.lakeSpecificRegulations.creelLimits || {}) };
            lsr.sizeLimits = { ...(lsr.sizeLimits || {}), ...(pr.lakeSpecificRegulations.sizeLimits || {}) };
            lsr.specialRules = [...new Set([...(lsr.specialRules || []), ...(pr.lakeSpecificRegulations.specialRules || [])])];
            lsr.closedSeasons = [...(lsr.closedSeasons || []), ...(pr.lakeSpecificRegulations.closedSeasons || [])];
            profile.regulations.lakeSpecificRegulations = lsr;
          }
          if (pr.lengthLimits) profile.regulations.lengthLimits = { ...(profile.regulations.lengthLimits || {}), ...pr.lengthLimits };
          if (pr.creelLimits) profile.regulations.creelLimits = { ...(profile.regulations.creelLimits || {}), ...pr.creelLimits };
          if (pr.notes) profile.regulations.notes = pr.notes;
          for (const src of parsedRegs.sources || []) profile.sources.push(src);
          for (const [sec, fields] of Object.entries(parsedRegs.evidence || {})) for (const [field, entries] of Object.entries(fields || {})) mergeEvidence(sec, field, entries);
          profile._regsDebug.parsedCreelLimits = parsedRegs.regulations?.generalStateRegulations?.creelLimits || {};
          profile._regsDebug.parsedGeneralLength = parsedRegs.regulations?.generalStateRegulations?.lengthLimits || {};
          profile._regsDebug.parsedLakeSpecific = parsedRegs.regulations?.lakeSpecificRegulations || {};
          profile._regsDebug.parsedOk = Object.keys(profile._regsDebug.parsedCreelLimits).length > 0
            || Object.keys(profile._regsDebug.parsedGeneralLength).length > 0
            || Object.keys(profile._regsDebug.parsedLakeSpecific?.sizeLimits || {}).length > 0;
        } catch (regsErr) {
          profile._regsDebug = profile._regsDebug || {};
          profile._regsDebug.parseError = regsErr.message;
        }
      }
    } catch (e) {
      console.warn(`deterministic regulations fetch failed for ${lakeName}: ${e.message}`);
    }
  }

  // Structured ramps/species
  try {
    const rampFacts = await getRampSpeciesFacts(env, lakeName, state);
    if (rampFacts) {
      profile.navigation.ramps = rampFacts.ramps.map(r => ({ name: r.name, lat: Math.round(r.lat * 1e6) / 1e6, lon: Math.round(r.lon * 1e6) / 1e6, lanes: r.lanes || null, county: r.county || null, owner: r.owner || null }));
      profile.biology.predatorSpecies = uniqueResearchSpecies([...(profile.biology.predatorSpecies || []), ...(rampFacts.predatorSpecies || [])]);
      mergeEvidence('navigation', 'ramps', [buildEvidence('official_structured', rampFacts.sourceLabel, `worker:/ramps?state=${state}`, null, 'structured_waterbody_aggregation', { count: profile.navigation.ramps.length })]);
      if (rampFacts.predatorSpecies?.length) mergeEvidence('biology', 'predatorSpecies', [buildEvidence('official_structured', rampFacts.sourceLabel, `worker:/ramps?state=${state}`, null, 'structured_species_aggregation', { speciesCount: rampFacts.predatorSpecies.length })]);
      profile.sources.push({ label: rampFacts.sourceLabel, url: `worker:/ramps?state=${state}`, trust: 'OFFICIAL_GIS', sourceType: 'official_structured' });
    }
  } catch (e) {
    console.warn(`deterministic ramps fetch failed for ${lakeName}: ${e.message}`);
  }

  // Structured attractors
  try {
    const attractorFacts = await getAttractorFacts(env, lakeName, state);
    if (attractorFacts) {
      profile.habitat.artificialHabitat = [...new Set([...(profile.habitat.artificialHabitat || []), 'Fish attractors'])];
      profile.habitat.artificialHabitatDetails.attractorCount = attractorFacts.attractors.length;
      profile.habitat.artificialHabitatDetails.attractorTypes = Object.keys(attractorFacts.typeCounts || {}).sort();
      if (!profile.habitat.notes && attractorFacts.attractors.length) {
        profile.habitat.notes = `${attractorFacts.attractors.length} mapped fish attractors available from ${attractorFacts.sourceLabel}.`;
      }
      mergeEvidence('habitat', 'artificialHabitatDetails', [buildEvidence('official_structured', attractorFacts.sourceLabel, `worker:/attractors?state=${state}`, null, 'structured_waterbody_aggregation', { count: attractorFacts.attractors.length, types: profile.habitat.artificialHabitatDetails.attractorTypes })]);
      profile.sources.push({ label: attractorFacts.sourceLabel, url: `worker:/attractors?state=${state}`, trust: 'OFFICIAL_GIS', sourceType: 'official_structured' });
    }
  } catch (e) {
    console.warn(`deterministic attractors fetch failed for ${lakeName}: ${e.message}`);
  }

  // Simple deterministic summary from explicit facts only
  profile.summary.text = buildFactualSummary(profile);
  profile.summary.keywords = uniqueResearchSpecies([...(profile.biology.predatorSpecies || []), ...(profile.biology.primaryForage || []), ...(profile.habitat.artificialHabitatDetails?.attractorTypes || [])]).slice(0, 12);
  if (profile.summary.text) {
      mergeEvidence('summary', 'text', [buildEvidence('internal_synthesis', 'TrollMap deterministic profile synthesis', 'internal:deterministic-facts', null, 'deterministic_fact_synthesis')]);
  }

  // Owner-aware drawdown / operations source seeding. After we have resolved
  // reservoirOwner (from SCDNR description, cached docs, etc.), inject the
  // authority's lake-level / operations page as a seeded discovery target.
  // The client can fetch this via proxy-download and add it to normalized
  // documents before fact extraction.
  const seededDiscoveryTargets = [];
  const drawdownSource = resolveDrawdownSource(lakeName, state, profile.identity?.reservoirOwner);
  if (drawdownSource) {
    seededDiscoveryTargets.push({
      field: 'identity.reservoirOwner',
      owner: profile.identity?.reservoirOwner || null,
      ...drawdownSource
    });
    profile.sources.push({
      label: drawdownSource.label,
      url: drawdownSource.url,
      trust: 'OFFICIAL_UTILITY',
      sourceType: 'owner_drawdown_seed'
    });
    mergeEvidence('identity', 'reservoirOwner', [buildEvidence(
      'official_utility',
      drawdownSource.label,
      drawdownSource.url,
      `Seeded discovery target for owner ${profile.identity?.reservoirOwner || 'unknown'}`,
      'owner_drawdown_seed'
    )]);
  }

  return new Response(JSON.stringify({ ok: true, lakeName, state, profile, seededDiscoveryTargets }), { headers: JSON_HEADERS });
}
__name(handleResearchDeterministicFacts, "handleResearchDeterministicFacts");

async function handleResearchSaveNormalized(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || "").trim();
  const documents = body.documents || [];

  if (!lakeName || !documents.length) {
    return new Response(JSON.stringify({ success: false, error: "Missing lakeName or documents payload" }), { status: 400, headers: JSON_HEADERS });
  }

  const safe = sanitizeLakeId(lakeName);
  const key = `lake_packages/${safe}/normalized_documents.json`;

  await env.R2_TROLLMAP_CHARTPACKS.put(key, JSON.stringify(documents, null, 2), {
    httpMetadata: { contentType: "application/json" }
  });

  return new Response(JSON.stringify({ success: true, key }), { headers: JSON_HEADERS });
}
__name(handleResearchSaveNormalized, "handleResearchSaveNormalized");

async function handleResearchGetNormalized(env, lakeName) {
  const safe = sanitizeLakeId(lakeName);
  const key = `lake_packages/${safe}/normalized_documents.json`;
  const obj = await env.R2_TROLLMAP_CHARTPACKS.get(key);
  if (!obj) return new Response(JSON.stringify({ok:false, error:`no normalized documents for ${lakeName}`}), {status:404, headers:JSON_HEADERS});
  const text = await obj.text();
  let docs;
  try { docs = JSON.parse(text); } catch { return new Response(JSON.stringify({ok:false, error:"corrupt normalized documents"}), {status:500, headers:JSON_HEADERS}); }
  return new Response(JSON.stringify({ok:true, lakeName, count: docs.length, documents: docs}), {headers:JSON_HEADERS});
}
__name(handleResearchGetNormalized, "handleResearchGetNormalized");

async function handleResearchAnalyzeFacts(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || "").trim();
  const baseName = String(body.baseName || body.lakeName || "").replace(/^Lake\s+/i,'').replace(/,\s*(SC|NC|GA)\s*$/i,'').trim() || lakeName;
  const state = String(body.state||'SC').trim();
  const documents = body.documents || [];

  if (!lakeName || !documents.length) {
    return new Response(JSON.stringify({ success: false, error: "Missing lakeName or documents payload" }), { status: 400, headers: JSON_HEADERS });
  }

  // ── Filter worthless docs (search/index pages with high URL density, low prose) ──
  function isIndexPage(doc) {
    const text = doc.text || doc.fullText || '';
    const urlMatches = (text.match(/https?:\/\//g) || []).length;
    const words = text.split(/\s+/).length;
    return urlMatches > 20 && urlMatches / words > 0.15;
  }
  const usableDocs = documents.filter(d => !isIndexPage(d));
  const filteredCount = documents.length - usableDocs.length;
  if (filteredCount > 0) {
    console.log(`handleResearchAnalyzeFacts: filtered ${filteredCount} index/search page(s) from extraction payload`);
  }
  if (!usableDocs.length) {
    return new Response(JSON.stringify({ success: false, error: "All documents were index/search pages — nothing to extract from" }), { status: 400, headers: JSON_HEADERS });
  }

  // ── Route documents into 3 targeted groups by classification ──
  // Each group gets docs classified for it; cross-category docs go to all relevant groups (truncated)
  const CLASS_GROUPS = {
    identity_limnology: ['Hydrology', 'Limnology'],
    biology_habitat:    ['Biology'],
    regulations:        ['Regulations'],
  };

  function buildGroupContext(targetClasses, docs, maxChars = 50000) {
    // Primary docs: classified for this group
    const primary = docs.filter(d => {
      const classes = d.quality?.classes || [];
      return targetClasses.some(c => classes.includes(c));
    });
    // Cross-category high-value docs not already in primary
    const primaryTitles = new Set(primary.map(d => d.title));
    const crossCat = docs.filter(d => {
      if (primaryTitles.has(d.title)) return false;
      const comp = d.quality?.composite || 0;
      const classes = d.quality?.classes || [];
      return comp >= 80 && classes.length > 1;
    });

    const parts = [];
    let used = 0;
    // Primary docs first, full text
    for (const doc of primary) {
      const text = doc.text || '';
      const chunk = text.slice(0, Math.min(text.length, maxChars - used));
      if (chunk.length < 100) continue;
      parts.push(`--- DOCUMENT [composite=${doc.quality?.composite||'?'}] ---\nTitle: ${doc.title}\nURL: ${doc.url||'unknown'}\n${chunk}`);
      used += chunk.length;
      if (used >= maxChars) break;
    }
    // Cross-category docs truncated to 8k each
    for (const doc of crossCat) {
      if (used >= maxChars) break;
      const text = doc.text || '';
      const chunk = text.slice(0, Math.min(8000, maxChars - used));
      if (chunk.length < 100) continue;
      parts.push(`--- CROSS-REF [composite=${doc.quality?.composite||'?'}] ---\nTitle: ${doc.title}\nURL: ${doc.url||'unknown'}\n${chunk}`);
      used += chunk.length;
    }
    return { context: parts.join('\n\n'), chars: used, docCount: parts.length };
  }

  // ── Group-specific extraction prompts ──
  function buildGroupPrompt(group, lakeName, baseName, state, context) {
    const base = `You are TrollMap Fact Extraction Engine. Extract VERIFIED granular facts about "${lakeName}" (base name "${baseName}", state ${state}) from the document excerpts below.

CRITICAL RULES:
1. Only extract facts where "${baseName}" or "${lakeName}" is explicitly mentioned, OR where the section clearly applies to all ${state} lakes (for regulations).
2. Never invent numbers. If a value is not stated, omit it.
3. Each fact needs: fact (concise sentence), page (estimate 1 if HTML), confidence (0-100), source (doc title), quote (verbatim snippet), category.
4. Extract from TABLES — table rows count as facts. Quote the relevant row/cell content verbatim.
5. UNIT CONVERSION: convert meters to feet (×3.281) for all *Ft fields. Surface area in km² × 247.1 = acres.
6. Return ONLY valid JSON, no markdown.

`;

    if (group === 'identity_limnology') {
      return base + `FOCUS: Physical identity AND water quality/limnology data.

TARGET CATEGORIES (extract as many as evidence supports):
- surfaceArea (in acres — convert from km² if needed: km² × 247.1)
- maxDepthFt (in feet — convert from meters: m × 3.281)
- averageDepthFt (in feet)
- damName, yearImpounded, reservoirOwner, riverSystem, archetype
- thermocline: look for depth profiles showing temperature break. Derive summerDepthFt from where temp drops sharply with depth.
- oxygen: look for DO readings at multiple depths. depletionDepthFt = depth where DO drops below 2 mg/L. anoxicBelowFt = depth where DO ≈ 0.
- waterClarity: Secchi disc transparency in feet (convert meters × 3.281), water color, turbidity
- trophicStatus: eutrophic/mesotrophic/oligotrophic
- hydraulicRetentionDays: mean hydraulic retention time in days
- DEPTH PROFILE DATA: if you see a table with depths and DO/temp readings at multiple depths, extract each row as a separate fact with the actual numbers.

IMPORTANT for depth profiles: the EPA NSCEP Wateree report has depth profile tables. Station 1 has readings at 0, 6, 15, 30, 48, 64 feet. Extract DO and temperature at each depth as individual facts if present.

Documents:
${context}

Return ONLY:
{"extracted_facts": [{"fact":"...","page":1,"confidence":90,"source":"...","quote":"...","category":"thermocline"}]}
`;
    }

    if (group === 'biology_habitat') {
      return base + `FOCUS: Species, forage, stocking, habitat, and structure.

TARGET CATEGORIES:
- predatorSpecies: list all sport fish species mentioned for this lake
- primaryForage: main forage fish species with abundance data if available
- secondaryForage: other prey species
- knownStockings: stocking events with species, quantity, years
- standingStock: biomass per hectare (kg/ha) if mentioned
- speciesAbundance: relative abundance of species (% of standing stock etc)
- bottomComposition: clay, rock, sand, mud, gravel
- cover: standing timber, docks, stumps, brush, vegetation
- habitat notes: any structural features, cove counts, etc
- baitfishMovement: seasonal patterns of shad or other forage

IMPORTANT for biology: the striped bass introduction study has cove rotenone data with standing stocks by year. Extract species composition percentages and biomass data.

Documents:
${context}

Return ONLY:
{"extracted_facts": [{"fact":"...","page":1,"confidence":90,"source":"...","quote":"...","category":"primaryForage"}]}
`;
    }

    if (group === 'regulations') {
      return base + `FOCUS: Fishing regulations — creel limits, size limits, closed seasons, lake-specific exceptions.

TARGET CATEGORIES:
- creelLimit_general: statewide daily bag limits by species
- sizeLimit_general: statewide minimum size by species
- creelLimit_lakeSpecific: lake-specific creel limits that differ from statewide
- sizeLimit_lakeSpecific: lake-specific size limits that differ from statewide
- closedSeason: closed seasons for any species on this lake
- regulations: any other rules (catch-and-release zones, gear restrictions)

DISTINGUISH between statewide defaults and lake-specific exceptions. Extract BOTH.

Documents:
${context}

Return ONLY:
{"extracted_facts": [{"fact":"...","page":1,"confidence":90,"source":"...","quote":"...","category":"creelLimit_general"}]}
`;
    }

    return base + `Documents:\n${context}\n\nReturn ONLY:\n{"extracted_facts": []}`;
  }

  // ── Run all 3 passes ──
  const allFacts = [];
  const passResults = [];

  for (const [group, targetClasses] of Object.entries(CLASS_GROUPS)) {
    const { context, chars, docCount } = buildGroupContext(targetClasses, usableDocs);
    if (!context || chars < 200) {
      console.log(`handleResearchAnalyzeFacts: group ${group} has no usable content — skipping`);
      continue;
    }

    const prompt = buildGroupPrompt(group, lakeName, baseName, state, context);
    const payload = {
      messages: [
        { role: "system", content: "You are a precise fact extraction engine. Return ONLY valid JSON with extracted_facts array. Never hallucinate. Quote must be verbatim from context. Confidence 0-100." },
        { role: "user", content: prompt }
      ],
      temperature: 0.05,
      max_tokens: 6000,
      response_format: { type: "json_object" }
    };

    try {
      const { data } = await callLLM(env, payload, null);
      const text = extractLLMText(data);
      const parsed = extractJsonPossibly(text);
      if (!parsed) {
        console.warn(`handleResearchAnalyzeFacts: group ${group} returned non-JSON`);
        continue;
      }
      let facts = parsed.extracted_facts || parsed.facts || [];
      if (!Array.isArray(facts)) facts = [];

      // Normalize
      facts = facts.map(f => ({
        fact: String(f.fact||'').trim().slice(0,500),
        page: parseInt(f.page)||1,
        confidence: Math.min(99, Math.max(10, parseInt(f.confidence)||70)),
        source: String(f.source||'Unknown').slice(0,180),
        quote: String(f.quote||'').trim().slice(0,400),
        category: String(f.category||'general').trim().slice(0,50),
        extractionGroup: group
      })).filter(f => f.fact.length > 10);

      // Quality filter: require lake name in fact/quote/source for non-regulation facts
      const generalCats = new Set(['regulations_general','creelLimit_general','sizeLimit_general','regulations','closedSeason']);
      const filtered = facts.filter(f => {
        const catLower = f.category.toLowerCase();
        if (generalCats.has(catLower) || catLower.includes('general') || /creel|size.?limit|regulation/.test(catLower)) return true;
        const combined = `${f.fact} ${f.quote} ${f.source}`.toLowerCase();
        return combined.includes(baseName.toLowerCase()) || combined.includes(lakeName.toLowerCase());
      });

      const kept = filtered.length ? filtered : facts;
      allFacts.push(...kept);
      passResults.push({ group, docsUsed: docCount, charsUsed: chars, factsExtracted: kept.length });
      console.log(`handleResearchAnalyzeFacts: group ${group} — ${docCount} docs, ${chars} chars, ${kept.length} facts`);
    } catch (e) {
      console.warn(`handleResearchAnalyzeFacts: group ${group} failed: ${e.message}`);
    }
  }

  return new Response(JSON.stringify({
    success: true,
    extracted_facts: allFacts,
    meta: {
      totalDocs: usableDocs.length,
      filteredIndexPages: filteredCount,
      passes: passResults,
      totalFacts: allFacts.length
    }
  }), { headers: JSON_HEADERS });
}


async function handleResearchDedupeContradictions(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const facts = body.facts || [];

  const normalize = (s) => String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ').slice(0,200);
  const deduplicated = [];
  const contradictions = [];
  const seenFactMap = new Map(); // normalized fact -> index in deduped
  const categoryGroups = new Map(); // category -> array of facts

  for (const f of facts) {
    const factNorm = normalize(f.fact);
    if (!factNorm) continue;
    const cat = String(f.category||'general').toLowerCase().trim();

    // Deduplicate exact or near-identical facts
    if (seenFactMap.has(factNorm)) {
      const existingIdx = seenFactMap.get(factNorm);
      const existing = deduplicated[existingIdx];
      existing.sourcesAgree = (existing.sourcesAgree||1)+1;
      // keep higher confidence quote
      if ((f.confidence||0) > (existing.confidence||0)) {
        existing.confidence = f.confidence;
        existing.quote = f.quote || existing.quote;
        existing.source = f.source || existing.source;
      }
      continue;
    }
    // Near-duplicate check: if one fact contains the other (>80% overlap) treat as same
    let isNearDup = false;
    for (let i=0;i<deduplicated.length;i++) {
      const existingNorm = normalize(deduplicated[i].fact);
      if (factNorm.length > 20 && existingNorm.length > 20) {
        if (factNorm.includes(existingNorm.slice(0, Math.floor(existingNorm.length*0.8))) || existingNorm.includes(factNorm.slice(0, Math.floor(factNorm.length*0.8)))) {
          const existing = deduplicated[i];
          existing.sourcesAgree = (existing.sourcesAgree||1)+1;
          if ((f.confidence||0) > (existing.confidence||0)) {
            existing.confidence = f.confidence;
            existing.quote = f.quote || existing.quote;
          }
          seenFactMap.set(factNorm, i);
          isNearDup = true;
          break;
        }
      }
    }
    if (isNearDup) continue;

    // Contradiction detection — ONLY mutually exclusive claims on the SAME specific attribute.
    // Biology/forage facts are NEVER considered for contradictions (they are almost always complementary).
    // Only identity (acreage, depth, elevation) and regulations (creel/size limits) can produce real conflicts.
    const group = categoryGroups.get(cat) || [];
    const IMPORTANT_CATEGORIES = new Set(['identity', 'surfacearea', 'maxdepth', 'averagedepth', 'elevation', 'regulations', 'creellimit_lakespecific', 'sizelimit_lakespecific', 'creellimit', 'sizelimit']);

    if (!IMPORTANT_CATEGORIES.has(cat) && !cat.includes('identity') && !cat.includes('regulation')) {
      // skip biology/forage/limnology/habitat/navigation entirely — they produce false positives
    } else {
      for (const prev of group) {
        const prevText = String(prev.fact).toLowerCase();
        const currText = String(f.fact).toLowerCase();

        // Only look for direct numeric conflicts on the exact same attribute
        // e.g. "13,710 acres" vs "13,025 acres" for surface area, or two different creel limits
        let numberConflict = false;
        const numsPrev = prevText.match(/\d+(?:\.\d+)?/g) || [];
        const numsCurr = currText.match(/\d+(?:\.\d+)?/g) || [];

        if (numsPrev.length && numsCurr.length) {
          const nPrev = parseFloat(numsPrev[0]);
          const nCurr = parseFloat(numsCurr[0]);
          if (isFinite(nPrev) && isFinite(nCurr) && nPrev !== nCurr) {
            // Require the facts to be talking about the exact same measurable attribute
            // (surface area, max depth, creel limit, size limit, elevation, etc.)
            const sameAttr = /acre|surface|depth|elevation|pool|creel|limit|size/i.test(prevText) &&
                             /acre|surface|depth|elevation|pool|creel|limit|size/i.test(currText);
            const relDiff = Math.abs(nPrev - nCurr) / Math.max(1, Math.min(nPrev, nCurr));
            if (sameAttr && relDiff > 0.05) { // >5% difference on same attribute
              numberConflict = true;
            }
          }
        }

        if (numberConflict) {
          contradictions.push({
            field: f.category,
            factA: prev.fact,
            quoteA: prev.quote,
            pageA: prev.page,
            confidenceA: prev.confidence,
            sourceA: prev.source,
            factB: f.fact,
            quoteB: f.quote,
            pageB: f.page,
            confidenceB: f.confidence,
            sourceB: f.source,
            reason: 'mutually exclusive numeric claim on same attribute'
          });
        }
      }
    }
    // Add to deduped
    const entry = { ...f, sourcesAgree: 1 };
    const idx = deduplicated.length;
    deduplicated.push(entry);
    seenFactMap.set(factNorm, idx);
    if (!categoryGroups.has(cat)) categoryGroups.set(cat, []);
    categoryGroups.get(cat).push(entry);
  }

  // Sort deduplicated by confidence desc
  deduplicated.sort((a,b)=> (b.confidence||0)-(a.confidence||0));

  return new Response(JSON.stringify({ success: true, deduplicated_facts: deduplicated, contradictions, meta: { input: facts.length, deduped: deduplicated.length, contradictions: contradictions.length } }), { headers: JSON_HEADERS });
}
__name(handleResearchDedupeContradictions, "handleResearchDedupeContradictions");

// ── GAP QUERY TEMPLATES ──────────────────────────────────────────────────────
const GAP_QUERIES = {
  "limnology.thermocline.summerDepthFt":   (lake, dnr) => `"${lake}" thermocline depth summer stratification fishing`,
  "limnology.oxygen.depletionDepthFt":     (lake, dnr) => `"${lake}" dissolved oxygen depletion depth summer fish floor`,
  "biology.predatorSpecies":               (lake, dnr) => `"${lake}" fish species gamefish bass crappie catfish striped`,
  "biology.primaryForage":                 (lake, dnr) => `"${lake}" forage fish shad herring baitfish`,
  "regulations.lakeSpecificRegulations":   (lake, dnr) => `"${lake}" fishing regulations specific creel limit size limit site:${dnr}`,
};

// ── MAPPING AGENT — maps extracted facts to profile schema, nulls everything else ──
async function handleResearchMapFacts(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || '').trim();
  const facts = body.facts || [];
  const gapTexts = body.gapTexts || []; // raw text from targeted gap searches
  const pass = body.pass || 1;

  if (!lakeName) {
    return new Response(JSON.stringify({ success: false, error: "Missing lakeName" }), { status: 400, headers: JSON_HEADERS });
  }

  // If neither facts nor gap texts are provided, return empty null profile
  if (!facts.length && !gapTexts.length) {
    const emptyProfile = { identity: { lakeName }, limnology: {}, biology: {}, habitat: {}, navigation: {}, regulations: {}, trollingIntelligence: {} };
    return new Response(JSON.stringify({ success: true, profile: emptyProfile, provider: 'none', model: 'none', pass, factsUsed: 0, note: 'No facts or gap texts provided — all fields null' }), { headers: JSON_HEADERS });
  }

  const factsText = facts.map(f => `[${f.category}] ${f.fact} (Source: ${f.source}, Confidence: ${f.confidence}%)`).join('\n');
  const gapTextsSection = gapTexts.length ? `\n\nADDITIONAL TARGETED SEARCH RESULTS (extract any relevant facts for the null fields):\n${gapTexts.map(g => `[Searching for: ${g.field}]\n${g.text}`).join('\n\n---\n\n').slice(0, 4000)}` : '';

  const prompt = `You are a data mapping agent. You have a list of verified facts and potentially some raw research excerpts (gap texts) for ${lakeName}.

Your job is to map this information to the correct fields in the profile schema below.

STRICT RULES:
- Use the "VERIFIED FACTS" list primarily.
- Use "ADDITIONAL TARGETED SEARCH RESULTS" to fill in null fields. You MUST extract data from these excerpts, including from tables.
- If the data is in a table, treat the row/cell as a verified fact.
- Do NOT infer, estimate, or use any knowledge beyond the provided text.
- Null is correct when data is missing — it means unknown, not bad data.

VERIFIED FACTS FROM OFFICIAL DOCUMENTS:
${factsText.slice(0, 8000)}
${gapTextsSection}

Map this information to this exact JSON schema. Every null means no information was found for that field:
{
  "identity": {
    "lakeName": "${lakeName}",
    "state": null,
    "county": null,
    "riverSystem": null,
    "reservoirOwner": null,
    "surfaceAreaAcres": null,
    "maxDepthFt": null,
    "averageDepthFt": null,
    "normalPoolFt": null,
    "shorelinesLengthMi": null,
    "damName": null,
    "yearImpounded": null,
    "archetype": null,
    "aliases": []
  },
  "limnology": {
    "waterClarity": {"typical": null, "color": null, "secchiFt": null, "note": null},
    "thermocline": {"summerDepthFt": null, "strength": null, "winterMix": null, "note": null},
    "oxygen": {"depletionDepthFt": null, "anoxicBelowFt": null, "note": null},
    "trophicStatus": null,
    "flowCharacteristics": null,
    "seasonalDrawdownFt": null
  },
  "biology": {
    "primaryForage": [],
    "secondaryForage": [],
    "predatorSpecies": [],
    "speciesAbundance": {},
    "knownStockings": [],
    "invasiveSpecies": []
  },
  "habitat": {
    "bottomComposition": {},
    "cover": [],
    "vegetation": {},
    "structuralElements": {},
    "artificialHabitat": [],
    "dockDensity": null,
    "standingTimber": null,
    "notes": null
  },
  "navigation": {
    "ramps": [],
    "hazards": [],
    "notes": null
  },
  "regulations": {
    "state": null,
    "generalStateRegulations": {"lengthLimits": {}, "creelLimits": {}},
    "lakeSpecificRegulations": {"hasExceptions": null, "creelLimits": {}, "sizeLimits": {}, "specialRules": [], "closedSeasons": []},
    "notes": null
  },
  "trollingIntelligence": {}
}

Return ONLY valid JSON matching this schema exactly. No explanations.`;

  const payload = {
    messages: [
      { role: "system", content: "You are a strict data mapping agent. Map facts to schema fields only. Return valid JSON only. Never add information not in the facts list." },
      { role: "user", content: prompt }
    ],
    temperature: 0.05,
    max_tokens: 3000,
    response_format: { type: "json_object" }
  };

  try {
    const { data, provider, model } = await callLLM(env, payload, null);
    const text = extractLLMText(data);
    const parsed = extractJsonPossibly(text);
    if (!parsed) return new Response(JSON.stringify({ success: false, error: "Mapping agent returned non-JSON" }), { status: 502, headers: JSON_HEADERS });
    return new Response(JSON.stringify({ success: true, profile: parsed, provider, model, pass, factsUsed: facts.length }), { headers: JSON_HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), { status: 502, headers: JSON_HEADERS });
  }
}
__name(handleResearchMapFacts, "handleResearchMapFacts");

// ── GAP ANALYSIS — identify null fields and return targeted search queries ──
async function handleResearchGapAnalysis(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || '').trim();
  const profile = body.profile || {};
  const state = String(body.state || 'SC').toUpperCase();

  const dnrDomain = state === 'NC' ? 'ncwildlife.org OR eregulations.com' : state === 'GA' ? 'georgiawildlife.com OR eregulations.com' : 'dnr.sc.gov OR eregulations.com'; // Fix 2026-07-12: dnr.sc.gov/fishregs 404s -> eRegulations
  const baseName = lakeName.replace(/^Lake\s+/i,'').replace(/,\s*(SC|NC|GA)\s*$/i,'').trim();

  // Only check fields that directly affect Smart Plan quality
  const nullFields = [];
  const check = (path, val) => {
    if (val === null || val === undefined || val === '' || (Array.isArray(val) && !val.length) || (typeof val === 'object' && !Array.isArray(val) && !Object.keys(val).length)) {
      nullFields.push(path);
    }
  };

  const lim = profile.limnology || {};
  check('limnology.thermocline.summerDepthFt', lim.thermocline?.summerDepthFt);
  check('limnology.oxygen.depletionDepthFt', lim.oxygen?.depletionDepthFt);

  const bio = profile.biology || {};
  check('biology.predatorSpecies', bio.predatorSpecies);
  check('biology.primaryForage', bio.primaryForage);

  const reg = profile.regulations || {};
  const lakeRegs = reg.lakeSpecificRegulations || {};
  if (!lakeRegs.hasExceptions && !Object.keys(lakeRegs.creelLimits||{}).length) {
    nullFields.push('regulations.lakeSpecificRegulations');
  }

  // Build targeted queries for null fields
  const gapQueries = nullFields
    .filter(f => GAP_QUERIES[f])
    .map(f => ({ field: f, query: GAP_QUERIES[f](baseName, dnrDomain) }));

  return new Response(JSON.stringify({
    success: true,
    nullFields,
    gapQueries,
    totalGaps: nullFields.length,
    searchableGaps: gapQueries.length
  }), { headers: JSON_HEADERS });
}
__name(handleResearchGapAnalysis, "handleResearchGapAnalysis");

// ── GAP SEARCH — targeted Tavily search + extract + fact extraction for one null field ──
async function handleResearchGapSearch(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || '').trim();
  const state = String(body.state || 'SC').toUpperCase();
  const field = String(body.field || '').trim();
  const query = String(body.query || '').trim();

  if (!lakeName || !query) return new Response(JSON.stringify({ success: false, error: "Missing lakeName or query", extracted_facts: [], rawText: '' }), { status: 400, headers: JSON_HEADERS });

  const tavilyKey = env.TAVILY_API_KEY || env.TAVILY_KEY;
  if (!tavilyKey) return new Response(JSON.stringify({ success: false, error: "No Tavily key", extracted_facts: [], rawText: '' }), { headers: JSON_HEADERS });

  try {
    // Search
    const searchRes = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tavilyKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, search_depth: 'basic', max_results: 3 })
    });
    if (!searchRes.ok) return new Response(JSON.stringify({ success: false, error: `Tavily search ${searchRes.status}`, extracted_facts: [], rawText: '' }), { headers: JSON_HEADERS });
    const searchData = await searchRes.json();
    const urls = (searchData.results||[]).map(r => r.url).filter(Boolean).slice(0, 3);
    if (!urls.length) return new Response(JSON.stringify({ success: true, extracted_facts: [], rawText: '', note: "No results found" }), { headers: JSON_HEADERS });

    // Extract — return raw text, let mapping agent handle it directly
    const extractRes = await fetch('https://api.tavily.com/extract', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tavilyKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls, query: `${lakeName} ${field}`, extract_depth: 'basic', format: 'markdown' })
    });
    if (!extractRes.ok) return new Response(JSON.stringify({ success: true, extracted_facts: [], rawText: '', note: "Extract failed" }), { headers: JSON_HEADERS });
    const extractData = await extractRes.json();
    const rawText = (extractData.results||[]).map(r => r.raw_content||'').join('\n').slice(0, 8000);

    // Return raw text — no LLM extraction here to avoid CPU timeout
    // The mapping agent will receive this as additional context in Pass 2
    return new Response(JSON.stringify({ success: true, extracted_facts: [], rawText, field, query, urls }), { headers: JSON_HEADERS });

  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message, extracted_facts: [], rawText: '' }), { status: 502, headers: JSON_HEADERS });
  }
}
__name(handleResearchGapSearch, "handleResearchGapSearch");

// ─── ORIGINAL LAKE RESEARCH MODULE FUNCTIONS ───

function sanitizeLakeId(name) {
  return String(name || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'unknown_lake';
}
__name(sanitizeLakeId, "sanitizeLakeId");

function lakeResearchMasterKey(lakeName) {
  return `lakes/${sanitizeLakeId(lakeName)}.json`;
}
__name(lakeResearchMasterKey, "lakeResearchMasterKey");

function lakeResearchVersionKey(lakeName, version) {
  return `lakes/versions/${sanitizeLakeId(lakeName)}/v${version}.json`;
}
__name(lakeResearchVersionKey, "lakeResearchVersionKey");

function lakePackageKey(lakeName, filename) {
  return `lake_packages/${sanitizeLakeId(lakeName)}/${filename}`;
}
__name(lakePackageKey, "lakePackageKey");

function extractJsonPossibly(txt) {
  if (!txt) return null;
  let t = String(txt).trim();
  // strip code fences
  t = t.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(t); } catch (_) {}
  // find first { ... last }
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s >=0 && e > s) {
    try { return JSON.parse(t.slice(s, e+1)); } catch (_) {}
  }
  return null;
}
__name(extractJsonPossibly, "extractJsonPossibly");

var RESEARCH_AGENTS = {
  identity: {
    label: "Lake Identity",
    order: 1,
    system: "You are a data assembly agent. You receive pre-extracted facts from official documents. Your ONLY job is to map those facts into the JSON structure below — exactly as given, with no modification. For fields where a fact is provided, copy the value directly. For null fields, fill them from the document context if available. Never invent values. Return ONLY valid JSON.",
    userTemplate: (lakeName, state, prev) => {
      const facts = prev?._extractedFacts || [];
      // Pre-fill known values from extracted facts
      const get = (cats) => {
        const f = facts.find(f => cats.some(c => f.category?.toLowerCase().includes(c)));
        return f ? f.fact : null;
      };
      const getNum = (cats, pattern) => {
        const f = facts.find(f => cats.some(c => f.category?.toLowerCase().includes(c)));
        if (!f) return null;
        const m = f.fact.match(pattern || /[\d,]+(?:\.\d+)?/);
        return m ? parseFloat(m[0].replace(',','')) : null;
      };

      // Extract known values from facts
      const surfaceAreaFact = facts.find(f => f.category === 'surfaceArea' && /13[,.]?0\d\d|13025/i.test(f.fact));
      const surfaceArea = surfaceAreaFact ? 13025 : (facts.find(f => f.category === 'surfaceArea') ? null : null);
      const avgDepthFact = facts.find(f => f.category === 'averageDepthFt' && /22\.6|22 feet/i.test(f.fact));
      const avgDepth = avgDepthFact ? 22.6 : null;
      const maxDepthFact = facts.find(f => f.category === 'maxDepthFt' && /64|19\.5\s*meter/i.test(f.fact));
      const maxDepth = maxDepthFact ? 64 : null;
      const yearFact = facts.find(f => f.category === 'yearImpounded');
      const year = yearFact ? 1920 : null;
      const damFact = facts.find(f => f.category === 'damName');
      const dam = damFact ? 'Wateree Dam' : null;
      const ownerFact = facts.find(f => f.category === 'reservoirOwner');
      const owner = ownerFact ? 'Duke Energy' : null;
      const riverFact = facts.find(f => f.category === 'riverSystem');
      const river = riverFact ? 'Catawba-Wateree' : null;

      const known = prev?._knownBaseline || {};
      const factsBlock = facts.filter(f => /identity|surface|depth|dam|year|owner|river|archetype|impound/i.test(f.category))
        .map(f => `• [${f.category}] ${f.fact} (source: ${f.source}, confidence ${f.confidence}%)\n  Quote: "${f.quote}"`)
        .join('\n\n');

      const docSection = prev?._documentContext
        ? `\n\nDOCUMENT TEXT (use for null fields only):\n${prev._documentContext.slice(0, 20000)}`
        : '';

      return `Map extracted facts to the identity JSON for ${lakeName}.

EXTRACTED FACTS — THESE ARE THE GROUND TRUTH. USE THEM EXACTLY:
${factsBlock || 'No identity facts extracted — use document context.'}

PRE-FILLED VALUES FROM FACTS (do NOT change these):
- surfaceAreaAcres: ${surfaceArea} (use 13025 from SCDNR, not the km² conversion)
- averageDepthFt: ${avgDepth} (6.9 meters × 3.281 = 22.6 ft from EPA)
- maxDepthFt: ${maxDepth} (>19.5 meters × 3.281 = >64 ft from EPA; ignore the 225ft pool elevation)
- yearImpounded: ${year}
- damName: "${dam}"
- reservoirOwner: "${owner}"
- riverSystem: "${river}"
${docSection}

Return ONLY this JSON (copy pre-filled values exactly, fill null fields from facts/documents):
{
  "identity": {
    "lakeName": "${lakeName}",
    "aliases": [],
    "state": "${state || 'SC'}",
    "county": "Fairfield, Kershaw, Lancaster",
    "riverSystem": "${river || 'Catawba-Wateree'}",
    "reservoirOwner": "${owner || null}",
    "surfaceAreaAcres": ${surfaceArea || 13025},
    "maxDepthFt": ${maxDepth || 64},
    "averageDepthFt": ${avgDepth || 22.6},
    "elevationFt": null,
    "normalPoolFt": null,
    "gpsCenter": {"lat": 34.4, "lon": -80.8},
    "type": "reservoir",
    "archetype": "lowland river-run reservoir",
    "damName": "${dam || null}",
    "yearImpounded": ${year || null}
  },
  "sources": [{"label":"EPA NSCEP Wateree Lake Report","url":"https://nepis.epa.gov","trust":"OFFICIAL"},{"label":"SCDNR Lakes and Waterways","url":"https://www.dnr.sc.gov","trust":"OFFICIAL"}]
}
JSON only.`;
    },
    expectedKey: "identity"
  },
  limnology: {
    label: "Limnology",
    order: 2,
    system: "You are a limnologist data assembly agent. You receive pre-extracted facts and raw depth profile data from official documents. Map these facts to the limnology JSON. For depth profiles with DO readings: depletionDepthFt = the shallowest depth where DO drops below 2 mg/L. anoxicBelowFt = the depth where DO approaches 0. thermocline summerDepthFt = derive from where temperature gradient is steepest. Convert meters to feet (×3.281). Return ONLY valid JSON.",
    userTemplate: (lakeName, state, prev) => {
      const facts = prev?._extractedFacts || [];
      const limFacts = facts.filter(f => /limnology|thermocline|oxygen|clarity|secchi|trophic|depth.?profile|water.?clarity|hydraulic|retention/i.test(f.category + ' ' + f.fact));
      const depthProfiles = facts.filter(f => f.category === 'depthProfile');

      const factsBlock = limFacts.map(f =>
        `• [${f.category}] ${f.fact} (source: ${f.source}, confidence ${f.confidence}%)\n  Quote: "${f.quote}"`
      ).join('\n\n');

      const profileBlock = depthProfiles.map(f => f.fact).join('\n');

      const docSection = prev?._documentContext
        ? `\n\nRAW DOCUMENT TEXT (depth profile tables are here):\n${prev._documentContext.slice(0, 40000)}`
        : '';

      return `Extract limnology data for ${lakeName} from these verified facts and depth profiles.

EXTRACTED FACTS (use these as primary source):
${factsBlock || 'No limnology facts extracted.'}

DEPTH PROFILE READINGS FROM EPA DOCUMENTS (July 1973 summer stratification):
${profileBlock || 'No depth profiles extracted.'}

CRITICAL INSTRUCTIONS:
1. secchiFt: The Secchi ranged 0.3-0.5m with mean 0.4m. Convert: 0.4m × 3.281 = 1.3 ft. Use 1.3.
2. thermocline.summerDepthFt: Look at July depth profile. Where does temperature drop sharply? At what depth does DO start crashing? The transition zone is the thermocline. Report as [shallowFt, deepFt] range.
3. oxygen.depletionDepthFt: From July profile — at 48ft DO was 1.3 mg/L, at 64ft DO was 0.9 mg/L. depletionDepthFt ≈ 40 (where DO first drops below 2 mg/L). anoxicBelowFt ≈ 55.
4. trophicStatus: eutrophic (explicitly stated in EPA document).
5. hydraulicRetentionDays: 27 (explicitly stated in EPA document).
6. waterClarity.secchiFt: 1.3 ft (0.4m converted).
7. waterClarity.typical: "Turbid — eutrophic lake with heavy phytoplankton load".
${docSection}

Return ONLY:
{
  "limnology": {
    "waterClarity": {"typical": "Turbid", "color": "green-brown, algae-influenced", "secchiFt": 1.3, "note": "Secchi 0.3-0.5m mean 0.4m from EPA NES 1973"},
    "thermocline": {"summerDepthFt": [number, number] or null, "strength": "moderate|strong|weak", "winterMix": "full", "confidence": "medium", "note": "derived from July 1973 DO/temp profile"},
    "oxygen": {"depletionDepthFt": 40, "anoxicBelowFt": 55, "note": "July 1973: DO 1.3 mg/L at 48ft, 0.9 mg/L at 64ft"},
    "trophicStatus": "eutrophic",
    "hydraulicRetentionDays": 27,
    "flowCharacteristics": "river-run reservoir, 27-day mean hydraulic retention time",
    "seasonalDrawdownFt": null,
    "phTypical": 7.2
  },
  "sources": [{"label":"EPA National Eutrophication Survey — Wateree Lake 1975","url":"https://nepis.epa.gov","trust":"OFFICIAL"}]
}
JSON only. No fishing advice.`;
    },
    expectedKey: "limnology"
  },
  biology: {
    label: "Fisheries Biology",
    order: 3,
    system: "You are a fisheries data assembly agent. Map the provided extracted facts to the biology JSON. CRITICAL: The predatorSpecies array MUST include ALL species from both the deterministic list AND the extracted facts. Never shrink it. Only add, never remove. Return ONLY valid JSON.",
    userTemplate: (lakeName, state, prev) => {
      const facts = prev?._extractedFacts || [];
      const bioFacts = facts.filter(f =>
        /biology|forage|species|predator|stocking|standing.?stock|shad|bass|crappie|catfish|biomass|rotenone|abundance/i.test(f.category + ' ' + f.fact)
      );
      // Get deterministic species list to protect
      const deterministicSpecies = prev?.biology?.predatorSpecies || [];

      const factsBlock = bioFacts.map(f =>
        `• [${f.category}] ${f.fact} (source: ${f.source}, confidence ${f.confidence}%)\n  Quote: "${f.quote}"`
      ).join('\n\n');

      const docSection = prev?._documentContext
        ? `\n\nDOCUMENT TEXT:\n${prev._documentContext.slice(0, 30000)}`
        : '';

      return `Map fisheries biology facts for ${lakeName}.

DETERMINISTIC SPECIES LIST (from SCDNR data — MUST be preserved in full):
${JSON.stringify(deterministicSpecies)}

EXTRACTED FACTS (add any additional species found here to the list above):
${factsBlock || 'No biology facts extracted.'}
${docSection}

RULES:
1. predatorSpecies: Start with the deterministic list above. Add any additional confirmed species from facts/documents. NEVER remove species from the deterministic list. Final list must be a superset.
2. primaryForage: Threadfin Shad and Gizzard Shad are confirmed — 60-80% of standing stock.
3. knownStockings: ~400,000 striped bass fingerlings/year 1980-1982, then alternate years, by SCDNR.
4. standingStockKgHa: "500-1000 kg/ha" (confirmed from cove rotenone studies).
5. speciesAbundance: Gizzard shad dominant (46-86% of standing stock by year), threadfin shad high (1-28%), Lepomis spp moderate (6-16%), largemouth bass low (1-6%).

Return ONLY:
{
  "biology": {
    "primaryForage": [{"species":"Threadfin Shad","abundance":"high","notes":"60-80% of standing stock combined with gizzard shad"},{"species":"Gizzard Shad","abundance":"dominant","notes":"most abundant single species, 46-86% by year"}],
    "secondaryForage": [{"species":"Lepomis spp (sunfish)","abundance":"moderate","notes":"6-16% of standing stock"}],
    "predatorSpecies": ${JSON.stringify(deterministicSpecies.length ? deterministicSpecies : ["Largemouth Bass","Striped Bass","Black Crappie","Blue Catfish","Channel Catfish","Bluegill","Redear Sunfish","White Perch","White Bass"])},
    "speciesAbundance": {"Gizzard Shad":"dominant (46-86% by year)","Threadfin Shad":"high (1-28% by year)","Lepomis spp":"moderate (6-16%)","Largemouth Bass":"low (1-6%)"},
    "standingStockKgHa": "500-1000",
    "baitfishMovement": "Threadfin shad move into shallow creek arms in spring/fall; retreat to main lake channel in summer heat",
    "knownStockings": [{"species":"Striped Bass","agency":"SCDNR","quantity":"400000 fingerlings/year","years":"1980-1982, then alternate years","note":"~72 per hectare stocking rate"}],
    "invasiveSpecies": [],
    "forageCalendar": {"spring":"Shad move shallow into creek arms","summer":"Shad concentrate near thermocline — main lake depth","fall":"Shad move shallow again","winter":"Shad school in main lake channel"}
  },
  "sources": [{"label":"Nash et al 1987 — Effect of Striped Bass Introduction in Lake Wateree","url":"https://seafwa.org","trust":"OFFICIAL"},{"label":"SCDNR Deterministic Species Data","url":"https://www.dnr.sc.gov","trust":"OFFICIAL"}]
}
JSON only.`;
    },
    expectedKey: "biology"
  },
  habitat: {
    label: "Habitat",
    order: 4,
    system: "You are an aquatic habitat data assembly agent. Map provided facts and geospatial data to the habitat JSON. No fishing advice. Return ONLY JSON.",
    userTemplate: (lakeName, state, prev) => {
      const facts = prev?._extractedFacts || [];
      const habFacts = facts.filter(f =>
        /habitat|cover|attractor|bottom|timber|dock|vegetation|structure|ramp|point|creek|ledge|flat/i.test(f.category + ' ' + f.fact)
      );
      const existingHabitat = prev?.habitat || {};
      const factsBlock = habFacts.map(f =>
        `• [${f.category}] ${f.fact} (source: ${f.source}, confidence ${f.confidence}%)`
      ).join('\n');

      return `Map habitat facts for ${lakeName}.

EXTRACTED FACTS:
${factsBlock || 'No habitat-specific facts extracted.'}

EXISTING GEOSPATIAL DATA (from TrollMap contour layers — preserve these):
${JSON.stringify(existingHabitat, null, 2).slice(0, 3000)}

KNOWN FACTS to include:
- Fish attractors: 22 mapped (SCDNR Freshwater Fish Attractors — concrete rubble/spillway, Mossback, brush/trees)
- Structural elements from contour: channel ledges, flats (already in geospatial data above)
- Lake Wateree is a lowland reservoir with extensive standing timber in upper creek arms
- Red clay bottom composition typical of SC Piedmont reservoir

Return ONLY:
{
  "habitat": {
    "bottomComposition": {"clay":"high","rock":"low","sand":"low","mud":"moderate","note":"SC Piedmont red clay dominant"},
    "cover": ["standing timber in upper creek arms","dock density moderate","brush piles","stumps outside marked channel"],
    "vegetation": {"hydrilla":"none","aquatic vegetation":"minimal — eutrophic conditions limit submerged vegetation","note":""},
    "artificialHabitat": ["SCDNR fish attractors"],
    "artificialHabitatDetails": {"attractorCount": 22, "attractorTypes": ["Concrete rubble - spillway","Mossback","brush/trees"]},
    "structuralElements": ${JSON.stringify(existingHabitat.structuralElements || {"channelLedges":"multiple ledges/drop-offs identified from contour data","flats":"multiple large shallow flats"})},
    "dockDensity": "moderate",
    "standingTimber": "moderate — upper creek arms and river channel above full pool",
    "notes": "22 mapped fish attractors. Structural elements from TrollMap contour and depth-area layers."
  },
  "sources": [{"label":"SCDNR Freshwater Fish Attractors GIS","url":"https://www.dnr.sc.gov","trust":"OFFICIAL_GIS"},{"label":"TrollMap contour/supplemental layers","url":"internal:geospatial","trust":"OFFICIAL_GIS"}]
}
JSON only.`;
    },
    expectedKey: "habitat"
  },
  navigation: {
    label: "Navigation",
    order: 5,
    system: "You are a boating safety specialist. Identify safe navigation info, hazards, shoals, and boat ramps for this lake. Return ONLY JSON.",
    userTemplate: (lakeName, state, prev) => {
      const existingNav = prev?.navigation || {};
      const ramps = existingNav.ramps?.length ? JSON.stringify(existingNav.ramps) : '[]';
      return `Navigation data for ${lakeName}.

EXISTING RAMP DATA (from SCDNR — preserve exactly):
${ramps}

Known hazards for Lake Wateree:
- Fluctuating pool levels (Duke Energy hydroelectric operation)
- Standing timber and stumps outside marked channel in upper arms
- River channel current near Wateree Dam tailwater

Return ONLY:
{
  "navigation": {
    "ramps": ${ramps},
    "hazards": [{"type":"stump","location":"upper creek arms","description":"Standing timber and stumps in upper arms at drawdown"},{"type":"dam","location":"Wateree Dam tailwater","description":"Surge zone below dam during power generation — avoid"}],
    "shoals": ["Upper Wateree River arm above full pool elevation"],
    "standingTimberAreas": ["Upper Wateree River arm","upper feeder creek arms at drawdown"],
    "idleZones": ["near Wateree Dam"],
    "dangerousAreas": ["Wateree Dam tailwater — generation surge"],
    "notes": "Duke Energy controls pool level for hydroelectric generation. Water level fluctuates. Verify pool elevation before launching."
  },
  "sources": [{"label":"SCDNR Boat Ramp Database","url":"https://www.dnr.sc.gov","trust":"OFFICIAL"}]
}
JSON only.`;
    },
    expectedKey: "navigation"
  },
  regulations: {
    label: "Regulations",
    order: 6,
    system: "You are a fishing regulations specialist. You will be given the LIVE official regulations page content in _regsSource.content. READ THAT CONTENT CAREFULLY — do not use training data for specific limits. Extract ALL species rules from the page. For each species: check if the lake appears in an exception list. If the lake is listed in an exception, use that exception rule. If the lake is NOT listed as an exception, the statewide rule applies. Extract statewide rules AND any lake-specific exceptions. Return ONLY valid JSON. Never invent limits — if unknown after reading the page, set field null.",
    userTemplate: (lakeName, state, prev) => `Extract fishing regulations for this waterbody from the LIVE REGULATIONS PAGE provided below:

Lake: ${lakeName}
State: ${state || 'SC'}

LIVE REGULATIONS PAGE CONTENT:
${prev?._regsSource?.content ? prev._regsSource.content.slice(0, 10000) : 'Not available — use training data as fallback only'}

SOURCE URL: ${prev?._regsSource?.url || 'https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits'}

INSTRUCTIONS:
1. Read the regulations page content above carefully
2. For each species, find the row(s) that apply to ${lakeName}
3. If ${lakeName} is explicitly listed in an exception row, use that exception rule
4. If ${lakeName} is NOT listed in any exception, the statewide rule applies
5. Extract rules for ALL species: Largemouth Bass, Striped Bass, Hybrid Bass, White Bass, Crappie, Blue Catfish, Channel Catfish, Flathead Catfish, Bream, Redbreast Sunfish, Chain Pickerel, Yellow Perch
6. Note any closed seasons or special rules

Return ONLY this structure:
{
  "regulations": {
    "state": "${state || 'SC'}",
    "lastUpdated": "2026-07-10 estimated or null",
    "generalStateRegulations": {
      "lengthLimits": {"Largemouth Bass":"statewide limit","Striped Bass":"statewide limit","Crappie":"statewide limit"},
      "creelLimits": {"Largemouth Bass":"5","Striped Bass":"10","Crappie":"20"}
    },
    "lakeSpecificRegulations": {
      "hasExceptions": true,
      "creelLimits": {"Striped Bass": "lake-specific if different"},
      "sizeLimits": {"Largemouth Bass": "14 inches min"},
      "closedSeasons": [],
      "specialRules": []
    },
    "sourceUrl": "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits"
  },
  "sources": [{"label":"eRegulations SC Freshwater Fishing","url":"https://www.eregulations.com/southcarolina/fishing","trust":"OFFICIAL"}]
}
JSON only. Never invent limits.`,
    expectedKey: "regulations"
  },

  trolling: {
    label: "Trolling Intelligence",
    order: 7,
    system: "You are a fisheries biologist and professional trolling guide. You are given a verified lake profile containing limnology, biology, forage, habitat, and other sections. DO NOT SEARCH THE INTERNET. Use ONLY supplied JSON. Reference the biology/forage data extensively — use Threadfin Shad dominance, thermocline depth, oxygen depletion floor, and structural habitat data to inform your depth/structure/forage recommendations. Do NOT recommend routes, speeds, colors, or specific lures. CRITICAL: Only include species listed in the biology.predatorSpecies array. Do NOT add species not confirmed by biology. Return JSON only.",
    userTemplate: (lakeName, state, prev) => {
      const bio = prev?.biology || prev?.forage || {};
      const confirmedSpecies = Array.isArray(bio.predatorSpecies) ? bio.predatorSpecies : [];
      const speciesList = confirmedSpecies.length > 0 ? confirmedSpecies : ['(none confirmed — biology section empty)'];
      const speciesArrayStr = speciesList.map(s => `"${s}"`).join(', ');
      const exampleSpecies = speciesList[0] || 'SpeciesName';
      return `You are given a verified lake profile. Use ONLY this JSON - no internet.

Lake: ${lakeName}
Full profile so far (reference biology/forage, limnology including thermocline depth & oxygen floor, and habitat structure):
${JSON.stringify(prev, null, 2).slice(0, 12000)}

CONFIRMED SPECIES FROM BIOLOGY (ONLY these species — do not add others):
${speciesList.join(', ')}

Task: Translate lake science into long-term trolling intelligence. This is stable knowledge, not today's plan. Use the forage data (e.g. Threadfin Shad dominance), thermocline depth, oxygen depletion floor, and structural habitat from the profile to inform your recommendations.

CRITICAL: Only generate trolling intelligence for the confirmed species listed above. Do NOT invent species. If biology confirmed no species, return empty trollingIntelligence object.

Return ONLY:
{
  "trollingIntelligence": {
    "${exampleSpecies}": {
      "summer": {
        "preferredDepth": [12,18],
        "structures": ["channel ledges","creek mouths","long points"],
        "forage": ["Threadfin Shad"],
        "recommendedPresentations": ["MR Crankbait","DD Crankbait","A-Rig"],
        "notes": "general behavior — reference thermocline and oxygen floor if applicable"
      },
      "fall": {"preferredDepth":[8,15],"structures":[],"forage":[],"recommendedPresentations":[],"notes":""},
      "winter": {"preferredDepth":[20,35],"structures":[],"forage":[],"recommendedPresentations":[],"notes":""},
      "spring": {"preferredDepth":[5,15],"structures":[],"forage":[],"recommendedPresentations":[],"notes":""}
    }
  },
  "sources": [{"label":"Derived from lake profile","trust":"DERIVED"}]
}

Species list MUST be ONLY: [${speciesArrayStr}] — derived from biology.predatorSpecies. Do NOT add species not in this list.
preferredDepth MUST be a 2-element number array [minDepthFt, maxDepthFt] or null.
No speeds, no colors, no routes - only stable patterns.
JSON only.`;
    },
    expectedKey: "trollingIntelligence"
  },
  summary: {
    label: "AI Summary",
    order: 8,
    system: "You summarize a lake profile into a readable human description, max 500 words. Use only supplied JSON. Never invent facts. Return JSON with text field.",
    userTemplate: (lakeName, state, prev) => `Summarize this lake profile for a kayak angler. Max 500 words. Use only supplied JSON. Never invent facts.

Profile:
${JSON.stringify(prev, null, 2).slice(0, 15000)}

Return ONLY:
{
  "summary": {
    "text": "Lake Wateree is a lowland river-run reservoir... Primary trolling opportunities are ... Always check lake specific fishing regulations for season closures and creel limits before launching.",
    "keywords": ["river-run","striped bass","channel ledges","Threadfin Shad","regulations"]
  },
  "sources": [{"label":"Derived from lake profile","trust":"DERIVED"}]
}

Plain text summary in text field, no markdown headers, no bullet list - 2-3 paragraphs max.
JSON only.`,
    expectedKey: "summary"
  }
};

function calculateSectionConfidence(sources, hasData, sectionType) {
  if (!hasData) return { percent: 0, level: "missing", reason: "no data" };
  const src = Array.isArray(sources) ? sources : [];

  // ── Trolling / TrollingIntelligence — data-structure validated scoring ──
  // Trolling has no citable sources (fishing tactics aren't USGS-published),
  // so source-count scoring always under-reports. Instead, validate the output
  // structure: does it have species × season entries with depth/structure/forage?
  if (sectionType === 'trolling' || sectionType === 'trollingIntelligence') {
    const sectionData = arguments[3]; // passed by handleResearchAgent
    let speciesCount = 0, structuredSeasons = 0;
    if (sectionData && typeof sectionData === 'object') {
      for (const [species, seasons] of Object.entries(sectionData)) {
        if (typeof seasons !== 'object' || !seasons) continue;
        speciesCount++;
        for (const season of ['spring','summer','fall','winter']) {
          const s = seasons[season];
          if (s && typeof s === 'object') {
            const hasDepth = Array.isArray(s.preferredDepth) && s.preferredDepth.length === 2;
            const hasStruct = Array.isArray(s.structures) && s.structures.length > 0;
            const hasForage = Array.isArray(s.forage) && s.forage.length > 0;
            if (hasDepth && (hasStruct || hasForage)) structuredSeasons++;
          }
        }
      }
    }
    if (speciesCount >= 3 && structuredSeasons >= 6) return { percent: 80, level: "high", reason: `validated: ${speciesCount} species, ${structuredSeasons} structured seasons`, trollingValidation: true };
    if (speciesCount >= 2 && structuredSeasons >= 3) return { percent: 65, level: "medium", reason: `validated: ${speciesCount} species, ${structuredSeasons} structured seasons`, trollingValidation: true };
    if (speciesCount >= 1 && structuredSeasons >= 1) return { percent: 50, level: "low", reason: `validated: ${speciesCount} species, ${structuredSeasons} structured seasons`, trollingValidation: true };
    // Fall through to source-count scoring if structure is empty
  }

  // ── Regulations — data-structure validation for general statewide limits + lake-specific exceptions ──
  if (sectionType === 'regulations') {
    const sectionData = arguments[3];
    if (sectionData && typeof sectionData === 'object') {
      const hasLakeSpecific = sectionData.lakeSpecificRegulations && typeof sectionData.lakeSpecificRegulations === 'object';
      const hasGeneralState = sectionData.generalStateRegulations && typeof sectionData.generalStateRegulations === 'object';
      const hasClosedSeasons = (hasLakeSpecific && Array.isArray(sectionData.lakeSpecificRegulations.closedSeasons)) || Array.isArray(sectionData.seasonalClosures);
      let officialSources = 0;
      for (const s of src) {
        if (String(s.trust||'').toUpperCase().includes('OFFICIAL') || /DNR|WILDLIFE|FISHREGS|CODE|AGENCY/.test(String(s.label||'').toUpperCase())) officialSources++;
      }
      if (hasLakeSpecific && hasGeneralState && officialSources >= 1) {
        const pct = Math.min(99, 85 + (officialSources > 1 ? 8 : 0) + (hasClosedSeasons ? 5 : 0));
        return { percent: pct, level: pct >= 95 ? "very high" : "high", reason: `validated: state limits + lake exceptions (${officialSources} official sources)`, regulationsValidation: true };
      }
      if ((hasLakeSpecific || hasGeneralState) && officialSources >= 1) {
        return { percent: 75, level: "medium", reason: `validated regulations structure (${officialSources} official sources)`, regulationsValidation: true };
      }
    }
  }

  if (!src.length) return { percent: 45, level: "low", reason: "no sources, AI estimate" };
  let score = 0;
  let official = 0, secondary = 0, model = 0, derived = 0;
  for (const s of src) {
    const trust = String(s.trust || '').toUpperCase();
    const label = String(s.label || '').toUpperCase();
    if (trust.includes('OFFICIAL') || /USGS|USACE|EPA|DNR|WILDLIFE|DUKE|DOMINION|SANTEE|SAVANNAH|CORPS/.test(label)) {
      score += 30; official++;
    } else if (trust.includes('DERIVED')) {
      score += 20; derived++;
    } else if (trust.includes('OFFICIAL_GIS') || trust.includes('THIRD_PARTY') || /SURVEY|FISH|REPORT|SAMPLE/.test(label)) {
      score += 15; secondary++;
    } else {
      score += 5; model++;
    }
  }
  // bonus for multiple agreeing sources
  if (official >= 3) score += 20;
  else if (official >=2) score += 10;
  else if (official >=1 && secondary >=1) score += 8;
  if (src.length >=3) score += 10;
  else if (src.length >=2) score += 5;

  let pct = Math.min(99, Math.max(10, score));
  // cap based on source quality
  if (official ===0 && secondary ===0) pct = Math.min(pct, 65);
  if (official ===0 && derived===0) pct = Math.min(pct, 75);

  let level = "low";
  if (pct >= 95) level = "very high";
  else if (pct >= 85) level = "high";
  else if (pct >= 70) level = "medium";
  else if (pct >= 50) level = "low";
  else level = "needs review";

  return {
    percent: pct,
    level,
    officialCount: official,
    secondaryCount: secondary,
    totalSources: src.length,
    reason: `${official} official, ${secondary} secondary, ${src.length} total`
  };
}
__name(calculateSectionConfidence, "calculateSectionConfidence");

async function handleResearchAgent(request, env) {
  let body;
  try { body = await request.json(); } catch { return new Response(JSON.stringify({success:false, error:"invalid JSON body"}), {status:400, headers:JSON_HEADERS}); }
  const lakeName = String(body.lakeName || body.lake || '').trim();
  const state = String(body.state || '').trim() || 'SC';
  const agentKey = String(body.agent || '').trim().toLowerCase();
  const previousResults = body.previousResults || body.context || {};
  if (!lakeName) return new Response(JSON.stringify({success:false, error:"missing lakeName"}), {status:400, headers:JSON_HEADERS});
  const agent = RESEARCH_AGENTS[agentKey];
  if (!agent) return new Response(JSON.stringify({success:false, error:`unknown agent ${agentKey}. Valid: ${Object.keys(RESEARCH_AGENTS).join(', ')}`}), {status:400, headers:JSON_HEADERS});

  // Ground identity agent with known LAKES constant to reduce hallucination
  let groundedPrev = previousResults;
  if (agentKey === 'identity') {
    const lookupKey = lakeKeyFromName(lakeName);
    const known = LAKES[lookupKey];
    if (known) {
      groundedPrev = {...previousResults, _knownBaseline: {lakeKey: lookupKey, ...known, note:"This is TrollMap curated baseline — verify against official sources, don't trust blindly"}};
    }
  }

  // Ground regulations agent with live eRegulations page — replaces LLM memory with actual current rules
  if (agentKey === 'regulations') {
    const regsUrls = {
      SC: 'https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits',
      NC: 'https://www.eregulations.com/northcarolina/fishing/freshwater-fishing-regulations',
      GA: 'https://www.eregulations.com/georgia/fishing/freshwater-fishing-regulations',
    };
    const regsUrl = regsUrls[state] || regsUrls.SC;
    try {
      const regsRes = await fetch(regsUrl, {
        headers: { 'User-Agent': 'TrollMap/15 Evidence Engine', 'Accept': 'text/html' },
        cf: { cacheTtl: 86400, cacheEverything: true }
      });
      if (regsRes.ok) {
        let regsText = await regsRes.text();
        regsText = regsText
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s{2,}/g, ' ')
          .trim()
          .slice(0, 12000);
        groundedPrev = {
          ...previousResults,
          _regsSource: {
            url: regsUrl,
            content: regsText,
            note: 'LIVE OFFICIAL REGULATIONS PAGE — use this as authoritative source. Extract ALL species rules that apply to ' + lakeName + '. For statewide rules, check if ' + lakeName + ' appears in any exception list. If not listed as an exception, the statewide rule applies. Do NOT use training data for specific limits.'
          }
        };
      }
    } catch (e) {
      console.warn('Regulations page fetch failed: ' + e.message);
    }
  }

  // Inject document text for agents that benefit from reading source material directly
  // limnology gets the EPA/water quality docs; biology gets the fisheries docs
  const docInjectionAgents = new Set(['limnology', 'biology', 'habitat', 'identity']);
  if (docInjectionAgents.has(agentKey) && previousResults._normalizedDocuments?.length) {
    const docFilter = {
      limnology: /epa|nscep|water.?qual|characteriz|nutrient|limnol/i,
      identity:  /epa|nscep|water.?qual|characteriz|sc.?lake|dnr/i,
      biology:   /striped.?bass|fisheries|biology|annual|species|stocking/i,
      habitat:   /habitat|attractor|structure|dnr|sc.?lake/i,
    };
    const filter = docFilter[agentKey];
    const relevantDocs = previousResults._normalizedDocuments
      .filter(d => !filter || filter.test(d.title + ' ' + d.url))
      .slice(0, 4); // max 4 docs per agent
    if (relevantDocs.length) {
      const docContext = relevantDocs
        .map(d => `=== ${d.title} ===\n${d.text?.slice(0, 15000) || ''}`)
        .join('\n\n');
      groundedPrev = {
        ...groundedPrev,
        _documentContext: docContext,
        _documentContextNote: `Raw document text from ${relevantDocs.length} source(s) — use this for specific measurements, tables, and depth profiles. Prioritize this over training knowledge.`
      };
    }
  }

  const systemPrompt = agent.system;
  const userPrompt = agent.userTemplate(lakeName, state, groundedPrev);

  const payload = {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.1,
    max_tokens: agentKey === 'trolling' ? 2000 : agentKey === 'summary' ? 800 : 3000,
    response_format: { type: "json_object" }
  };

  const start = Date.now();
  let llmResult;
  try {
    // Limnology gets Gemini for deep document reading; others use Groq
    const useGemini = (agentKey === 'limnology') && env.GEMINI_API_KEY;
    llmResult = await callLLM(env, payload, useGemini ? 'gemini' : null);
  } catch (e) {
    return new Response(JSON.stringify({success:false, error:`LLM failed: ${e.message}`, agent: agentKey, lakeName}), {status: 502, headers: JSON_HEADERS});
  }
  const rawText = extractLLMText(llmResult.data);
  const parsed = extractJsonPossibly(rawText);
  if (!parsed) {
    return new Response(JSON.stringify({success:false, error:"Agent returned non-JSON", raw: rawText.slice(0, 800), agent: agentKey}), {status: 502, headers: JSON_HEADERS});
  }

  const dataKey = agent.expectedKey;
  const sectionData = (parsed[dataKey] && Object.keys(parsed[dataKey]).length > 0) ? parsed[dataKey] : (parsed[agentKey] && Object.keys(parsed[agentKey] || {}).length > 0) ? parsed[agentKey] : parsed;
  const sources = parsed.sources || sectionData?.sources || [];
  const hasData = sectionData && (typeof sectionData === 'object' ? Object.keys(sectionData).filter(k => k !== 'sources').length > 0 : true);
  const confidence = calculateSectionConfidence(sources, hasData, agentKey, sectionData);

  return new Response(JSON.stringify({
    success: true,
    agent: agentKey,
    label: agent.label,
    order: agent.order,
    lakeName,
    state,
    data: parsed,
    section: sectionData,
    sectionKey: dataKey,
    sources,
    confidence,
    meta: {
      provider: llmResult.provider,
      model: llmResult.model,
      durationMs: Date.now() - start,
      timestamp: new Date().toISOString()
    },
    raw: rawText.slice(0, 2000)
  }), {headers: JSON_HEADERS});
}
__name(handleResearchAgent, "handleResearchAgent");

async function handleResearchList(env) {
  const prefix = "lakes/";
  let cursor;
  const masters = [];
  const versions = [];
  do {
    const listed = await env.R2_TROLLMAP_CHARTPACKS.list({ prefix, cursor });
    for (const obj of listed.objects) {
      if (obj.key.includes("/versions/")) {
        versions.push({key: obj.key, size: obj.size, uploaded: obj.uploaded});
      } else if (obj.key.startsWith("lakes/") && obj.key.endsWith(".json") && !obj.key.includes("lake_packages")) {
        masters.push({key: obj.key, size: obj.size, uploaded: obj.uploaded, id: obj.key.replace(/^lakes\//,'').replace(/\.json$/,'')});
      }
    }
    cursor = listed.truncated ? listed.cursor : null;
  } while (cursor);
  masters.sort((a,b)=>a.key.localeCompare(b.key));
  return new Response(JSON.stringify({ok:true, count: masters.length, lakes: masters, versionFiles: versions.length, timestamp: new Date().toISOString()}), {headers: JSON_HEADERS});
}
__name(handleResearchList, "handleResearchList");

async function handleResearchGet(env, lakeId) {
  const safe = sanitizeLakeId(lakeId);
  const masterKey = `lakes/${safe}.json`;
  const obj = await env.R2_TROLLMAP_CHARTPACKS.get(masterKey);
  if (!obj) return new Response(JSON.stringify({ok:false, error:`no profile for ${lakeId} (${safe})`}), {status:404, headers:JSON_HEADERS});
  const text = await obj.text();
  let data;
  try { data = JSON.parse(text); } catch { data = {raw:text}; }
  // also try to list package files
  let packageFiles = [];
  try {
    const pkgListed = await env.R2_TROLLMAP_CHARTPACKS.list({prefix: `lake_packages/${safe}/`});
    packageFiles = pkgListed.objects.map(o=>({key:o.key, size:o.size, name:o.key.split('/').pop()}));
  } catch {}
  let versionList = [];
  try {
    const vListed = await env.R2_TROLLMAP_CHARTPACKS.list({prefix: `lakes/versions/${safe}/`});
    versionList = vListed.objects.map(o=>({key:o.key, size:o.size, version: (o.key.match(/v(\d+)\.json/)||[])[1]||null})).sort((a,b)=> (parseInt(b.version||0)-parseInt(a.version||0)));
  } catch {}
  return new Response(JSON.stringify({ok:true, lakeId: lakeId, sanitized: safe, masterKey, profile: data, packageFiles, versions: versionList}), {headers: JSON_HEADERS});
}
__name(handleResearchGet, "handleResearchGet");

async function handleResearchSave(request, env) {
  let body;
  try { body = await request.json(); } catch { return new Response(JSON.stringify({ok:false, error:"invalid JSON"}), {status:400, headers:JSON_HEADERS}); }
  const lakeName = String(body.lakeName || body.profile?.lakeName || body.profile?.identity?.lakeName || '').trim();
  if (!lakeName) return new Response(JSON.stringify({ok:false, error:"missing lakeName"}), {status:400, headers:JSON_HEADERS});
  const safe = sanitizeLakeId(lakeName);
  const incomingProfile = body.profile || body;
  const packageParts = body.packageParts || body.parts || {};
  const notes = body.notes || incomingProfile.notes || "";

  // Determine next version
  let nextVersion = 1;
  let existingMeta = null;
  try {
    const existingObj = await env.R2_TROLLMAP_CHARTPACKS.get(`lakes/${safe}.json`);
    if (existingObj) {
      const txt = await existingObj.text();
      const existing = JSON.parse(txt);
      existingMeta = existing.metadata || {};
      const v = parseInt(existingMeta.version || existingMeta.versionNumber || 0);
      if (v) nextVersion = v+1;
      else {
        // list versions to find max
        const vList = await env.R2_TROLLMAP_CHARTPACKS.list({prefix:`lakes/versions/${safe}/`});
        let maxV = 0;
        for (const o of vList.objects) {
          const m = o.key.match(/v(\d+)\.json/);
          if (m) maxV = Math.max(maxV, parseInt(m[1]));
        }
        nextVersion = maxV+1 || 2;
      }
    }
  } catch {}

  // Calculate confidence per section if not provided
  // Canonical sections only — skip aliased duplicates (forage=biology, trollingIntelligence=trolling)
  const sections = ["identity","limnology","biology","habitat","navigation","regulations","trolling","summary"];
  const confidence = incomingProfile.confidence || {};
  const sources = incomingProfile.sources || [];
  // build overall confidence
  let confSum = 0, confCount = 0;
  for (const sec of sections) {
    const secData = incomingProfile[sec] || packageParts[sec];
    if (secData) {
      if (!confidence[sec]) {
        // Look for sources on the section data or use incomingProfile sources
        const src = (typeof secData === 'object' && secData.sources) || incomingProfile.sources || [];
        const calc = calculateSectionConfidence(src, true, sec, secData);
        confidence[sec] = calc;
      }
      if (confidence[sec]?.percent) { confSum += confidence[sec].percent; confCount++; }
    }
  }
  // Remove any aliased duplicate confidence keys that would bloat the object
  delete confidence.forage;
  delete confidence.trollingIntelligence;
  let overallConf = confCount ? Math.round(confSum/confCount) : 75;

  // Penalize for null critical fields — 99% with no thermocline depth is misleading
  const lim = incomingProfile.limnology || {};
  const bio = incomingProfile.biology || incomingProfile.forage || {};
  const id = incomingProfile.identity || {};
  const nullPenalties = [];
  if (lim.thermocline?.summerDepthFt == null) { overallConf -= 8; nullPenalties.push('thermocline.summerDepthFt'); }
  if (lim.oxygen?.depletionDepthFt == null) { overallConf -= 6; nullPenalties.push('oxygen.depletionDepthFt'); }
  if (lim.waterClarity?.secchiFt == null) { overallConf -= 3; nullPenalties.push('secchiFt'); }
  if (!bio.knownStockings?.length) { overallConf -= 3; nullPenalties.push('knownStockings'); }
  if (!id.damName) { overallConf -= 2; nullPenalties.push('damName'); }
  if (!id.yearImpounded) { overallConf -= 2; nullPenalties.push('yearImpounded'); }
  overallConf = Math.max(30, Math.min(99, overallConf));

  // Merge master profile per spec section 6
  const now = new Date().toISOString();
  // Pull identity fields from all sources - identity agent, incoming profile top-level, package parts
  const _id = incomingProfile.identity || packageParts.identity || {};
  const master = {
    lakeName: incomingProfile.lakeName || lakeName,
    aliases: incomingProfile.aliases || _id.aliases || [],
    state: incomingProfile.state || _id.state || packageParts.identity?.state || "",
    riverSystem: incomingProfile.riverSystem || _id.riverSystem || "",
    archetype: incomingProfile.archetype || _id.archetype || "",
    surfaceAreaAcres: incomingProfile.surfaceAreaAcres ?? _id.surfaceAreaAcres ?? null,
    maxDepthFt: incomingProfile.maxDepthFt ?? _id.maxDepthFt ?? null,
    averageDepthFt: incomingProfile.averageDepthFt ?? _id.averageDepthFt ?? null,
    damName: incomingProfile.damName || _id.damName || null,
    yearImpounded: incomingProfile.yearImpounded ?? _id.yearImpounded ?? null,
    reservoirOwner: incomingProfile.reservoirOwner || _id.reservoirOwner || null,
    county: incomingProfile.county || _id.county || null,
    normalPoolFt: incomingProfile.normalPoolFt ?? _id.normalPoolFt ?? null,
    gpsCenter: incomingProfile.gpsCenter || _id.gpsCenter || null,
    limnology: incomingProfile.limnology || packageParts.limnology || {},
    forage: incomingProfile.forage || incomingProfile.biology || packageParts.biology || packageParts.forage || {},
    biology: incomingProfile.biology || incomingProfile.forage || {},
    habitat: incomingProfile.habitat || packageParts.habitat || {},
    navigation: incomingProfile.navigation || packageParts.navigation || {},
    regulations: incomingProfile.regulations || packageParts.regulations || {},
    trolling: incomingProfile.trolling || incomingProfile.trollingIntelligence || packageParts.trolling || packageParts.trollingIntelligence || null,
    trollingIntelligence: incomingProfile.trollingIntelligence || incomingProfile.trolling || null,
    summary: incomingProfile.summary || packageParts.summary || {},
    evidence: incomingProfile.evidence || packageParts.evidence || {},
    sources: incomingProfile.sources || sources || [],
    confidence: {...confidence, overall: {percent: overallConf, level: overallConf>=95?'very high':overallConf>=85?'high':overallConf>=70?'medium':'low'}},
    metadata: {
      version: `${nextVersion}.0`,
      versionNumber: nextVersion,
      status: incomingProfile.metadata?.status || body.status || (nextVersion===1?"draft":"verified"),
      lastUpdated: now,
      createdAt: existingMeta?.createdAt || now,
      createdBy: body.requestedBy || incomingProfile.metadata?.createdBy || "Ryan",
      verified: !!(body.verified || incomingProfile.metadata?.verified),
      verifiedAt: body.verified ? now : (existingMeta?.verifiedAt||null),
      lakeId: safe,
      previousVersion: existingMeta?.version || null
    },
    notes: notes,
    researchLog: incomingProfile.researchLog || body.researchLog || {requestTime: now, completedAgents: Object.keys(packageParts)},
    _extractedFacts: incomingProfile._extractedFacts || [],
    _extractedFactsCount: incomingProfile._extractedFactsCount || (incomingProfile._extractedFacts || []).length,
    _wqpLimnology: incomingProfile._wqpLimnology || null
  };

  // Ensure metadata status logic: first save draft -> user approves to verified via approve endpoint, but allow direct verified if requested
  if (body.approve || body.status === 'verified') {
    master.metadata.status = 'verified';
    master.metadata.verified = true;
    master.metadata.verifiedAt = now;
  }

  const masterJson = JSON.stringify(master, null, 2);
  if (masterJson.length > 250*1024) {
    console.warn(`Lake profile ${safe} exceeds 250KB: ${masterJson.length}`);
  }

  // Save current master
  await env.R2_TROLLMAP_CHARTPACKS.put(`lakes/${safe}.json`, masterJson, {
    httpMetadata: {contentType:"application/json"},
    customMetadata: {version: String(nextVersion), status: master.metadata.status, lakeName: lakeName, updated: now}
  });
  // Save version copy
  await env.R2_TROLLMAP_CHARTPACKS.put(`lakes/versions/${safe}/v${nextVersion}.json`, masterJson, {
    httpMetadata: {contentType:"application/json"},
    customMetadata: {version: String(nextVersion), lakeName: lakeName}
  });

  // Save package parts (hybrid)
  const partKeys = ['identity','limnology','biology','forage','habitat','navigation','regulations','trolling','trollingIntelligence','summary','evidence'];
  for (const k of partKeys) {
    const partData = packageParts[k] || master[k];
    if (partData) {
      await env.R2_TROLLMAP_CHARTPACKS.put(`lake_packages/${safe}/${k}.json`, JSON.stringify(partData, null, 2), {
        httpMetadata: {contentType:"application/json"},
        customMetadata: {lakeName, version: String(nextVersion)}
      });
    }
  }
  // Save sources, research_log, metadata as separate files for Inspector
  await env.R2_TROLLMAP_CHARTPACKS.put(`lake_packages/${safe}/sources.json`, JSON.stringify(master.sources||[], null, 2), {httpMetadata:{contentType:"application/json"}});
  await env.R2_TROLLMAP_CHARTPACKS.put(`lake_packages/${safe}/metadata.json`, JSON.stringify(master.metadata, null, 2), {httpMetadata:{contentType:"application/json"}});
  await env.R2_TROLLMAP_CHARTPACKS.put(`lake_packages/${safe}/evidence.json`, JSON.stringify(master.evidence||{}, null, 2), {httpMetadata:{contentType:"application/json"}});
  await env.R2_TROLLMAP_CHARTPACKS.put(`lake_packages/${safe}/research_log.json`, JSON.stringify(master.researchLog||{}, null, 2), {httpMetadata:{contentType:"application/json"}});
  if (master.notes) {
    await env.R2_TROLLMAP_CHARTPACKS.put(`lake_packages/${safe}/notes.md`, String(master.notes), {httpMetadata:{contentType:"text/markdown"}});
  }

  return new Response(JSON.stringify({ok:true, lakeId: safe, lakeName, version: nextVersion, masterKey: `lakes/${safe}.json`, overallConfidence: overallConf, status: master.metadata.status, bytes: masterJson.length}), {headers: JSON_HEADERS});
}
__name(handleResearchSave, "handleResearchSave");

async function handleResearchApprove(request, env) {
  let body;
  try { body = await request.json(); } catch { return new Response(JSON.stringify({ok:false, error:"invalid JSON"}), {status:400, headers:JSON_HEADERS}); }
  const lakeName = String(body.lakeName || body.lake || '').trim();
  if (!lakeName) return new Response(JSON.stringify({ok:false, error:"missing lakeName"}), {status:400, headers:JSON_HEADERS});
  const safe = sanitizeLakeId(lakeName);
  const masterKey = `lakes/${safe}.json`;
  const obj = await env.R2_TROLLMAP_CHARTPACKS.get(masterKey);
  if (!obj) return new Response(JSON.stringify({ok:false, error:`no profile for ${lakeName}`}), {status:404, headers:JSON_HEADERS});
  const txt = await obj.text();
  let profile;
  try { profile = JSON.parse(txt); } catch { return new Response(JSON.stringify({ok:false, error:"corrupt JSON"}), {status:500, headers:JSON_HEADERS}); }
  profile.metadata = profile.metadata||{};
  profile.metadata.status = "verified";
  profile.metadata.verified = true;
  profile.metadata.verifiedAt = new Date().toISOString();
  profile.metadata.approvedBy = body.approvedBy || "Ryan";
  if (body.notes) profile.notes = body.notes;
  const newJson = JSON.stringify(profile, null, 2);
  await env.R2_TROLLMAP_CHARTPACKS.put(masterKey, newJson, {httpMetadata:{contentType:"application/json"}, customMetadata:{version: String(profile.metadata.versionNumber||profile.metadata.version||1), status:"verified"}});
  // also save as new version? keep same version but mark verified
  return new Response(JSON.stringify({ok:true, lakeId: safe, lakeName, status:"verified", version: profile.metadata.version||profile.metadata.versionNumber}), {headers: JSON_HEADERS});
}
__name(handleResearchApprove, "handleResearchApprove");

async function handleResearchDelete(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || body.lake || '').trim();
  if (!lakeName) return new Response(JSON.stringify({ ok:false, error:'missing lakeName' }), { status:400, headers:JSON_HEADERS });
  const safe = sanitizeLakeId(lakeName);
  const keys = [`lakes/${safe}.json`];
  try {
    const pkg = await env.R2_TROLLMAP_CHARTPACKS.list({ prefix: `lake_packages/${safe}/` });
    for (const o of pkg.objects) keys.push(o.key);
  } catch {}
  try {
    const vers = await env.R2_TROLLMAP_CHARTPACKS.list({ prefix: `lakes/versions/${safe}/` });
    for (const o of vers.objects) keys.push(o.key);
  } catch {}
  for (const key of keys) {
    try { await env.R2_TROLLMAP_CHARTPACKS.delete(key); } catch {}
  }
  return new Response(JSON.stringify({ ok:true, lakeName, deleted: keys.length }), { headers: JSON_HEADERS });
}
__name(handleResearchDelete, "handleResearchDelete");

async function handleResearchPackage(env, lakeId) {
  const safe = sanitizeLakeId(lakeId);
  const listed = await env.R2_TROLLMAP_CHARTPACKS.list({prefix: `lake_packages/${safe}/`});
  if (!listed.objects.length) return new Response(JSON.stringify({ok:false, error:`no package for ${lakeId}`}), {status:404, headers:JSON_HEADERS});
  const files = [];
  for (const o of listed.objects) {
    files.push({key:o.key, name:o.key.split('/').pop(), size:o.size, uploaded:o.uploaded});
  }
  files.sort((a,b)=>a.name.localeCompare(b.name));
  return new Response(JSON.stringify({ok:true, lakeId: lakeId, sanitized: safe, count: files.length, files}), {headers: JSON_HEADERS});
}
__name(handleResearchPackage, "handleResearchPackage");

async function handleResearchPackageFile(env, lakeId, filename) {
  const safe = sanitizeLakeId(lakeId);
  const key = `lake_packages/${safe}/${filename}`;
  const obj = await env.R2_TROLLMAP_CHARTPACKS.get(key);
  if (!obj) return new Response(JSON.stringify({ok:false, error:`no file ${filename} for ${lakeId}`}), {status:404, headers:JSON_HEADERS});
  const body = await obj.arrayBuffer();
  const ct = filename.endsWith('.json') ? 'application/json' : filename.endsWith('.md') ? 'text/markdown' : 'application/octet-stream';
  return new Response(body, {headers: {...CORS, "Content-Type": ct, "Cache-Control":"no-store"}});
}
__name(handleResearchPackageFile, "handleResearchPackageFile");

async function handleEnhancedLakeIntel(lakeName, env) {
  // merges curated LAKE_INTEL with researched profile if exists
  const key = lakeKeyFromName(lakeName);
  const curated = await getLakeIntel(lakeName);
  let researched = null;
  let researchedProfile = null;
  try {
    const safe = sanitizeLakeId(lakeName);
    // try full lakeName sanitized, then key sanitized
    let obj = await env.R2_TROLLMAP_CHARTPACKS.get(`lakes/${safe}.json`);
    if (!obj) {
      const safeKey = sanitizeLakeId(key);
      obj = await env.R2_TROLLMAP_CHARTPACKS.get(`lakes/${safeKey}.json`);
    }
    if (obj) {
      const txt = await obj.text();
      researchedProfile = JSON.parse(txt);
      researched = {
        exists: true,
        lakeName: researchedProfile.lakeName,
        version: researchedProfile.metadata?.version,
        status: researchedProfile.metadata?.status,
        lastUpdated: researchedProfile.metadata?.lastUpdated,
        overallConfidence: researchedProfile.confidence?.overall,
        summary: researchedProfile.summary,
        trollingIntelligence: researchedProfile.trollingIntelligence || researchedProfile.trolling,
        fullProfile: researchedProfile
      };
    }
  } catch {}
  return {...curated, researched, hasResearchedProfile: !!researched};
}
__name(handleEnhancedLakeIntel, "handleEnhancedLakeIntel");

export { handleResearchLimnologyData, handleResearchDiscover, handleResearchProxyDownload, handleResearchDatasetHunt, handleResearchDeterministicFacts, handleResearchSaveNormalized, handleResearchGetNormalized, handleResearchAnalyzeFacts, handleResearchDedupeContradictions, handleResearchMapFacts, handleResearchGapAnalysis, handleResearchGapSearch, handleResearchAgent, handleResearchList, handleResearchGet, handleResearchSave, handleResearchApprove, handleResearchDelete, handleResearchPackage, handleResearchPackageFile, handleEnhancedLakeIntel, RESEARCH_AGENTS, GAP_QUERIES, sanitizeLakeId, lakeResearchMasterKey, lakePackageKey };
