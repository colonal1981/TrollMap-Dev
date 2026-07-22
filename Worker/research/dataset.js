// research/dataset.js — split from worker-research.js (behavior-preserving)
import { JSON_HEADERS } from '../worker-core.js';

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
// NEPIS document IDs confirmed as wrong-lake false positives — score -9999 to guarantee exclusion
const KNOWN_BAD_NEPIS_IDS = new Set([
  '91024IW5', // "Monticello" wastewater plant / Lake Decatur IL — not Lake Monticello SC
  '9100D35L', // "Monticello" wastewater plants (N+S) / Pearson Creek + White Oak Creek — not Lake Monticello SC
]);

function scoreDatasetUrl(url, title, lakeName) {
  const baseName = lakeName.replace(/^Lake\s+/i,'').replace(/,\s*(SC|NC|GA|TN)(\/(?:SC|NC|GA|TN))*\s*$/i,'').trim().toLowerCase();
  const urlLower = url.toLowerCase();
  const titleLower = (title || '').toLowerCase();
  const combined = `${urlLower} ${titleLower}`;

  // Hard-block known wrong-lake NEPIS documents
  const nepisIdMatch = url.match(/\/([A-Z0-9]{6,12})\.txt/i);
  if (nepisIdMatch && KNOWN_BAD_NEPIS_IDS.has(nepisIdMatch[1].toUpperCase())) return -9999;

  let score = 0;

  // ── Lake name matching ──────────────────────────────────────────────────────
  // Lake name in URL slug is strongest signal — it's a dedicated page for this lake
  if (urlLower.includes(baseName.replace(/\s+/g, '-')) || urlLower.includes(baseName.replace(/\s+/g, '_'))) score += 50;
  else if (urlLower.includes(baseName)) score += 35;
  else if (titleLower.includes(baseName)) score += 25;
  // Full "Lake X" in title is stronger than just base name
  if (titleLower.includes(`lake ${baseName}`) || titleLower.includes(`${baseName} lake`)) score += 10;

  // ── Document type bonuses ───────────────────────────────────────────────────
  if (/\.pdf$/i.test(url)) score += 10;
  if (/\d{4}/.test(url)) score += 5; // dated report
  if (/annual.report|creel.survey|stocking.report/i.test(combined)) score += 20;
  if (/nepis\.epa\.gov|zynet\.exe|zypdf\.cgi/i.test(url)) score += 15;
  if (/report on lake/i.test(combined)) score += 25;

  // ── High-value fishing intel keywords ──────────────────────────────────────
  // These indicate the article has the specific data Smart Plan needs
  const intelKeywords = [
    'thermocline','dissolved oxygen','water quality','limnology','trophic',
    'forage','threadfin shad','gizzard shad','blueback herring',
    'depth','structure','seasonal','spawn','fall turnover',
    'striped bass','striper','crappie','largemouth','catfish',
    'trolling','jigging','downrigger','Carolina rig',
  ];
  for (const kw of intelKeywords) {
    if (combined.includes(kw)) score += 8;
  }

  // ── General dataset keywords ────────────────────────────────────────────────
  for (const kw of DATASET_KEYWORDS) {
    if (combined.includes(kw)) score += 4;
  }

  // ── Domain trust tiers ─────────────────────────────────────────────────────
  // High-trust fishing intel sources
  if (/carolinasportsman\.com|ncwildlife\.org|dnr\.sc\.gov|georgiawildlife\.com|gameandfishmag\.com/i.test(url)) score += 15;
  // Scientific / government sources
  if (/usgs\.gov|usace\.army\.mil|epa\.gov|clemson\.edu|ncsu\.edu|uga\.edu/i.test(url)) score += 10;
  // Operator relicensing sites
  if (/saludahydrorelicense\.com|parrfairfieldrelicense\.com|duke-energy\.com|dominionenergy\.com/i.test(url)) score += 20;
  // Low-value sources
  if (/pinterest|facebook|instagram|twitter|youtube|reddit|tripadvisor|yelp/i.test(url)) score -= 30;
  // Generic content that rarely has lake-specific data
  if (/wikia|fandom|lakelobster|lakeplace|waterfront|realtor|zillow/i.test(url)) score -= 20;

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
    // .txt may be in pathname OR in Dockey= query param (ZyPURL.cgi?Dockey=9100D9KA.TXT)
    const hasTxtInPath = /\.txt$/i.test(url.pathname);
    const hasTxtInQuery = /Dockey=[^&]*\.txt/i.test(url.search);
    if (!hasTxtInPath && !hasTxtInQuery) return null;
    // ZyPURL.cgi?Dockey=XXXX.TXT — direct raw text URL, return as-is
    if (/ZyPURL\.cgi/i.test(url.pathname) && hasTxtInQuery) return landingUrl;
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

async function handleResearchDatasetHunt(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || '').trim();
  const state    = String(body.state || 'SC').trim().toUpperCase();

  if (!lakeName) {
    return new Response(JSON.stringify({ ok: false, error: 'missing lakeName' }), { status: 400, headers: JSON_HEADERS });
  }

  // 2026-07-15: All hunt queries absorbed into handleResearchDiscover (categories:['pdf'],
  // categories:['research'], NEPIS seed). Eliminates this separate ~8-credit call.
  // engine.js merges 0 datasets and moves on. Remove stub once engine.js stops calling this endpoint.
  return new Response(JSON.stringify({
    ok: true, lakeName, state, datasetCount: 0,
    firecrawlUsed: false, tavilyUsed: false, datasets: [],
    note: 'absorbed into discover — 0 credits spent'
  }), { headers: JSON_HEADERS });

  const firecrawlKey = env.FIRECRAWL_API_KEY || env.FIRECRAWL_KEY;
  const baseName     = lakeName.replace(/^Lake\s+/i,'').replace(/,\s*(SC|NC|GA|TN)(\/(?:SC|NC|GA|TN))*\s*$/i,'').trim();
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
      // Prefer /v2/scrape with links — more reliable on ZyNET dynamic results than /map
      const scrapeRes = await fetch('https://api.firecrawl.dev/v2/scrape', {
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
      const mapRes = await fetch('https://api.firecrawl.dev/v2/map', {
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

  // ── Phase 2: Search for reports and academic papers (Firecrawl /v2/search) ──
  if (firecrawlKey) {
    const dnrSite = state === 'NC' ? 'site:ncwildlife.org' : state === 'GA' ? 'site:georgiawildlife.com' : 'site:dnr.sc.gov';
    const stateFullName = { SC: 'South Carolina', NC: 'North Carolina', GA: 'Georgia' }[state] || 'South Carolina';
    // Use full "Lake X" name + state in quotes to avoid matching unrelated "Murray", "Marion" etc
    const huntName = lakeName.replace(/,\s*(SC|NC|GA)\s*$/i, '').trim(); // "Lake Murray" not "Murray"
    const huntQueries = [
      `"${huntName}" "${stateFullName}" creel survey fisheries assessment filetype:pdf`,
      `"${huntName}" annual fisheries report ${dnrSite}`,
      `"Report on Lake ${baseName}" OR "Report on ${baseName} Lake" site:nepis.epa.gov`,
    ];
    for (const q of huntQueries) {
      try {
        let results = [];
        const searchRes = await fetch('https://api.firecrawl.dev/v2/search', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${firecrawlKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: q, limit: 5 })
        });
        if (!searchRes.ok) continue;
        const searchData = await searchRes.json();
        results = (searchData.data?.web || searchData.data || searchData.web || (Array.isArray(searchData) ? searchData : [])).map(r => ({
          url: r.url, title: r.title || r.metadata?.title || '', content: ''
        }));
        for (const r of results) {
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
            source: 'firecrawl_search',
            score,
            snippet: (r.content || '').slice(0, 300),
          });
        }
      } catch (e) {
        console.warn(`Dataset hunt search failed for [${q}]: ${e.message}`);
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
    datasets: discovered,
  }), { headers: JSON_HEADERS });
}

export { DATASET_HUNT_TARGETS, DATASET_KEYWORDS, KNOWN_BAD_NEPIS_IDS, scoreDatasetUrl, buildNepisSearchUrl, toNepisRawTextUrl, buildNepisQueryVariants, handleResearchDatasetHunt };
