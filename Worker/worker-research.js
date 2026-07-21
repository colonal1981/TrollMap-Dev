// worker-research.js — Full research pipeline extracted from trollmap-worker.js
// All /research/* route handlers, RESEARCH_AGENTS, deterministic facts, dataset hunt, etc.

import { CORS, JSON_HEADERS, TEXT_HEADERS, extractLLMText, callLLM, isAuthorized } from './worker-core.js';
import { LAKES, LAKE_INTEL, lakeKeyFromName, fetchText, fetchUsgs, fetchAhqWaterTemp, fetchAhqFishingReport, fetchLakeMonsterIntel, getLakeIntel } from './worker-data.js';

var __defProp = Object.defineProperty;

// ─── TINYFISH API CLIENT ───
const TINYFISH_BASE = 'https://api.search.tinyfish.ai';
const TINYFISH_FETCH_BASE = 'https://api.fetch.tinyfish.ai';

async function tinyfishSearch({ query, domain_type = 'web', purpose, location, language, recency_minutes, after_date, before_date }, env) {
  const key = env.TINYFISH_API_KEY;
  if (!key) throw new Error('TINYFISH_API_KEY not configured');
  
  const params = new URLSearchParams({ query });
  if (domain_type) params.set('domain_type', domain_type);
  if (purpose) params.set('purpose', purpose);
  if (location) params.set('location', location);
  if (language) params.set('language', language);
  if (recency_minutes) params.set('recency_minutes', String(recency_minutes));
  if (after_date) params.set('after_date', after_date);
  if (before_date) params.set('before_date', before_date);
  
  const res = await fetch(`${TINYFISH_BASE}?${params.toString()}`, {
    headers: { 'X-API-Key': key }
  });
  if (!res.ok) throw new Error(`TinyFish Search HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function tinyfishFetch({ urls, format = 'markdown', include_selectors, exclude_selectors, ttl, if_none_match, if_modified_since, include_etag_and_last_modified }, env) {
  const key = env.TINYFISH_API_KEY;
  if (!key) throw new Error('TINYFISH_API_KEY not configured');
  
  const body = { urls, format };
  if (include_selectors) body.include_selectors = include_selectors;
  if (exclude_selectors) body.exclude_selectors = exclude_selectors;
  if (ttl !== undefined) body.ttl = ttl;
  if (if_none_match) body.if_none_match = if_none_match;
  if (if_modified_since) body.if_modified_since = if_modified_since;
  if (include_etag_and_last_modified) body.include_etag_and_last_modified = include_etag_and_last_modified;
  
  const res = await fetch(TINYFISH_FETCH_BASE, {
    method: 'POST',
    headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`TinyFish Fetch HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── FIRECRAWL CREDIT GUARD ───
// Tracks remaining Firecrawl credits in KV. Hard stop at 50 remaining to prevent
// auto-upgrade to paid tier when free credits hit 0.
// Initialize KV with current balance: await env.KV.put('firecrawl:credits_remaining', '269')
const FIRECRAWL_HARD_STOP = 50;  // Never go below this — avoids auto-upgrade to paid tier
const FIRECRAWL_KV_KEY = 'firecrawl:credits_remaining';

async function checkFirecrawlBudget(env, estimatedCredits = 1) {
  const remaining = parseInt(await env.KV.get(FIRECRAWL_KV_KEY) || '0', 10);
  if (remaining <= FIRECRAWL_HARD_STOP) {
    return { allowed: false, remaining, reason: `Firecrawl hard stop (${remaining} remaining, limit ${FIRECRAWL_HARD_STOP})` };
  }
  if (remaining - estimatedCredits <= FIRECRAWL_HARD_STOP) {
    return { allowed: false, remaining, reason: `Firecrawl would breach hard stop (${remaining} remaining)` };
  }
  return { allowed: true, remaining, useTinyFishOnly: false };
}

async function recordFirecrawlUsage(env, credits = 1) {
  const remaining = parseInt(await env.KV.get(FIRECRAWL_KV_KEY) || '0', 10);
  const newRemaining = Math.max(0, remaining - credits);
  await env.KV.put(FIRECRAWL_KV_KEY, String(newRemaining));
  console.log(`[firecrawl] used ${credits} credit(s) — ${newRemaining} remaining`);
}

// ── Scrape.do Fetch ──────────────────────────────────────────────────────────
// 1 credit/request for standard pages, 5 with render=true for JS SPAs.
// Failed requests cost 0. Returns HTML — we strip to plain text via HTMLRewriter.
// Used as fallback when TinyFish fails. Tracks remaining credits from response header.
async function scrapeDoFetch(url, env, { render = false } = {}) {
  const token = env.SCRAPEDO_API_KEY;
  if (!token) throw new Error('SCRAPEDO_API_KEY not configured');

  const encoded = encodeURIComponent(url);
  const renderParam = render ? '&render=true' : '';
  const apiUrl = `https://api.scrape.do/?token=${token}&url=${encoded}${renderParam}`;

  const res = await fetch(apiUrl, {
    headers: { 'Accept': 'text/html,application/xhtml+xml' }
  });

  // Log remaining credits from response header for monitoring
  const remaining = res.headers.get('Scrape.do-Remaining-Credits');
  const cost = res.headers.get('Scrape.do-Request-Cost');
  if (remaining) console.log(`[scrape.do] cost=${cost} remaining=${remaining} url=${url.slice(0,80)}`);

  if (!res.ok) throw new Error(`Scrape.do HTTP ${res.status}`);

  // Strip HTML to plain text using HTMLRewriter
  // Remove script, style, nav, footer, ads — keep main content
  let text = '';
  const rewriter = new HTMLRewriter()
    .on('script, style, nav, footer, header, aside, .ads, .advertisement, .cookie-banner, .newsletter, .sidebar', {
      element(el) { el.remove(); }
    })
    .on('*', {
      text(chunk) { text += chunk.text; }
    });

  await rewriter.transform(res).text();

  // Clean up whitespace
  text = text.replace(/\s+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return text;
}
const STATE_REGULATIONS_CONFIG = {
  SC: {
    pages: [
      // SCDNR official freshwater regulations booklet — pages 18-43 contain freshwater
      // creel/size tables and lake-specific exceptions. Fetched as PDF, sliced by page.
      { key: 'general', url: 'https://www.dnr.sc.gov/regs/pdf/25SCAB-PP2-RE.pdf', parser: 'scTableParser', pageRange: [18, 43] }
    ]
  },
  NC: {
    pages: [
      // NCWRC official inland fishing rule text — complete regulatory rule set as PDF
      { key: 'general', url: 'https://www.ncwildlife.gov/media/4600/download?attachment=', parser: 'ncTableParser' }
    ]
  },
  GA: {
    pages: [
      // GA DNR 2025-2026 combined hunting/fishing guide — freshwater fishing regs within
      { key: 'general', url: 'https://georgiawildlife.com/sites/default/files/wrd/pdf/regulations/GA2026_Hunting&Fishing%20Regulations.pdf', parser: 'gaTableParser' }
    ]
  },
  TN: {
    pages: [
      // TWRA statewide creel/length limits — static HTML page, no JS rendering needed
      { key: 'general', url: 'https://www.tn.gov/twra/fishing-regs/statewide-creel-length-limits.html', parser: 'tnStatewideParser' },
      { key: 'exceptions', url: 'https://www.tn.gov/twra/fishing-regs/fishing-regulation-exceptions.html', parser: 'tnExceptionsParser' },
    ]
  }
};

function extractMarkdownTables(text) {
  const tables = [];
  const lines = text.split('\n');
  let inTable = false;
  let currentTable = { headers: [], rows: [] };
  
  for (const line of lines) {
    if (line.includes('|')) {
      const cells = line.split('|').map(c => c.trim()).filter((_, i, arr) => i > 0 && i < arr.length - 1);
      if (cells.length > 0) {
        if (!inTable) {
          inTable = true;
          currentTable = { headers: cells, rows: [] };
        } else if (cells.every(c => /^[-:|]+$/.test(c))) {
          // separator row - skip
        } else if (currentTable.headers.length === 0) {
          currentTable.headers = cells;
        } else {
          currentTable.rows.push(cells);
        }
      }
    } else if (inTable) {
      if (currentTable.headers.length > 0 && currentTable.rows.length > 0) {
        tables.push(currentTable);
      }
      inTable = false;
    }
  }
  if (inTable && currentTable.headers.length > 0 && currentTable.rows.length > 0) {
    tables.push(currentTable);
  }
  return tables;
}

function parseSCTable(markdown) {
  const tables = extractMarkdownTables(markdown);
  const regs = { general: {}, lakeSpecific: {} };
  
  for (const table of tables) {
    const headers = table.headers.map(h => h.toLowerCase());
    const waterBodyIdx = headers.findIndex(h => h.includes('water body') || h.includes('waterbody'));
    const fishIdx = headers.findIndex(h => h.includes('fish'));
    const sizeIdx = headers.findIndex(h => h.includes('size'));
    const creelIdx = headers.findIndex(h => h.includes('creel') || h.includes('possession'));
    
    if (waterBodyIdx === -1 || fishIdx === -1) continue;
    
    for (const row of table.rows) {
      const waterBody = row[waterBodyIdx] || '';
      const species = row[fishIdx] || '';
      const sizeLimit = sizeIdx >= 0 ? (row[sizeIdx] || '') : '';
      const creelLimit = creelIdx >= 0 ? (row[creelIdx] || '') : '';
      
      if (!species || !waterBody) continue;
      
      const entry = { species, sizeLimit, creelLimit };
      const isStatewide = /statewide|all public waters except/i.test(waterBody);
      
      if (isStatewide) {
        regs.general[species] = entry;
      } else {
        const lakeKey = normalizeLakeName(waterBody);
        regs.lakeSpecific[lakeKey] = regs.lakeSpecific[lakeKey] || {};
        regs.lakeSpecific[lakeKey][species] = entry;
      }
    }
  }
  return regs;
}

function parseNCTable(markdown) {
  const tables = extractMarkdownTables(markdown);
  const regs = { general: {}, lakeSpecific: {} };
  
  for (const table of tables) {
    const headers = table.headers.map(h => h.toLowerCase());
    const speciesIdx = headers.findIndex(h => h.includes('species'));
    const sizeIdx = headers.findIndex(h => h.includes('size'));
    const creelIdx = headers.findIndex(h => h.includes('creel'));
    const waterBodyIdx = headers.findIndex(h => h.includes('water') || h.includes('lake') || h.includes('reservoir'));
    
    if (speciesIdx === -1) continue;
    
    for (const row of table.rows) {
      const species = row[speciesIdx] || '';
      const sizeLimit = sizeIdx >= 0 ? (row[sizeIdx] || '') : '';
      const creelLimit = creelIdx >= 0 ? (row[creelIdx] || '') : '';
      const waterBody = waterBodyIdx >= 0 ? (row[waterBodyIdx] || '') : '';
      
      if (!species) continue;
      
      const entry = { species, sizeLimit, creelLimit };
      const isStatewide = /all public waters except|statewide/i.test(waterBody) || !waterBody;
      
      if (isStatewide) {
        regs.general[species] = entry;
      } else if (waterBody) {
        const lakeKey = normalizeLakeName(waterBody);
        regs.lakeSpecific[lakeKey] = regs.lakeSpecific[lakeKey] || {};
        regs.lakeSpecific[lakeKey][species] = entry;
      }
    }
  }
  return regs;
}

function parseGATable(markdown) {
  const tables = extractMarkdownTables(markdown);
  const regs = { general: {}, lakeSpecific: {} };
  
  for (const table of tables) {
    const headers = table.headers.map(h => h.toLowerCase());
    const speciesIdx = headers.findIndex(h => h.includes('species') || h.includes('bass') || h.includes('catfish') || h.includes('crappie'));
    const limitIdx = headers.findIndex(h => h.includes('daily') || h.includes('limit'));
    const exceptionsIdx = headers.findIndex(h => h.includes('exception'));
    
    if (speciesIdx === -1) continue;
    
    for (const row of table.rows) {
      const species = row[speciesIdx] || '';
      const dailyLimit = limitIdx >= 0 ? (row[limitIdx] || '') : '';
      const exceptions = exceptionsIdx >= 0 ? (row[exceptionsIdx] || '') : '';
      
      if (!species) continue;
      
      // GA format: statewide limit in dailyLimit, lake exceptions in exceptions column
      const entry = { species, sizeLimit: '', creelLimit: dailyLimit };
      
      if (!exceptions || /no exception|—|none/i.test(exceptions)) {
        regs.general[species] = entry;
      } else {
        // Parse lake names from exceptions (e.g., "Lake Lindsay Grace — Only one bass...")
        const lakeMatches = exceptions.match(/(Lake [A-Za-z\s]+|[A-Za-z\s]+ Lake|[A-Za-z\s]+ Reservoir)/g);
        if (lakeMatches) {
          for (const lake of lakeMatches) {
            const lakeKey = normalizeLakeName(lake);
            regs.lakeSpecific[lakeKey] = regs.lakeSpecific[lakeKey] || {};
            regs.lakeSpecific[lakeKey][species] = { ...entry, creelLimit: exceptions };
          }
        }
      }
    }
  }
  return regs;
}

function parseTNStatewide(markdown) {
  const tables = extractMarkdownTables(markdown);
  const regs = { general: {}, lakeSpecific: {} };
  
  for (const table of tables) {
    const headers = table.headers.map(h => h.toLowerCase());
    const speciesIdx = headers.findIndex(h => h.includes('species'));
    const creelIdx = headers.findIndex(h => h.includes('creel'));
    const sizeIdx = headers.findIndex(h => h.includes('length') || h.includes('size'));
    
    if (speciesIdx === -1) continue;
    
    for (const row of table.rows) {
      const species = row[speciesIdx] || '';
      const creelLimit = creelIdx >= 0 ? (row[creelIdx] || '') : '';
      const sizeLimit = sizeIdx >= 0 ? (row[sizeIdx] || '') : '';
      
      if (!species) continue;
      
      regs.general[species] = { species, sizeLimit, creelLimit };
    }
  }
  return regs;
}

function parseTNExceptions(markdown) {
  const tables = extractMarkdownTables(markdown);
  const regs = { general: {}, lakeSpecific: {} };
  
  let currentLake = '';
  for (const table of tables) {
    for (const row of table.rows) {
      const cellText = row.join(' ').trim();
      // Detect lake headers (e.g., "### Barkley", "### Kentucky Lake")
      const lakeMatch = cellText.match(/^#{1,3}\s*(.+)$/);
      if (lakeMatch && !cellText.includes('|')) {
        currentLake = normalizeLakeName(lakeMatch[1]);
        continue;
      }
      
      if (!currentLake) continue;
      
      const species = row[0] || '';
      const detail = row[1] || '';
      if (!species) continue;
      
      regs.lakeSpecific[currentLake] = regs.lakeSpecific[currentLake] || {};
      regs.lakeSpecific[currentLake][species] = { species, sizeLimit: '', creelLimit: detail };
    }
  }
  return regs;
}

function parseTNRegion(markdown) {
  return parseTNExceptions(markdown); // Same format
}

const PARSERS = {
  scTableParser: parseSCTable,
  ncTableParser: parseNCTable,
  gaTableParser: parseGATable,
  tnStatewideParser: parseTNStatewide,
  tnExceptionsParser: parseTNExceptions,
  tnRegionParser: parseTNRegion
};

function normalizeLakeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/^lake\s+/i, '')
    .replace(/\s+(lake|reservoir)$/i, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

async function fetchStateRegulations(state, env) {
  const cacheKey = `regulations:${state}:v2`;
  let cached = await env.KV.get(cacheKey, { type: 'json' });
  if (cached) return cached;
  
  const config = STATE_REGULATIONS_CONFIG[state];
  if (!config) return { general: {}, lakeSpecific: {} };
  
  const pages = config.pages;
  const urls = pages.map(p => p.url);
  
  // Fetch all pages in ONE TinyFish Fetch call (batched, free)
  const result = await tinyfishFetch({ urls, format: 'markdown' }, env);
  
  const parsed = { general: {}, lakeSpecific: {} };
  
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const markdown = result.results[i]?.text || '';
    const pageData = PARSERS[page.parser](markdown);
    
    if (page.key === 'general') {
      parsed.general = pageData.general || {};
    } else {
      // Merge lake-specific from exceptions/regions
      for (const [lake, speciesMap] of Object.entries(pageData.lakeSpecific || {})) {
        parsed.lakeSpecific[lake] = { ...(parsed.lakeSpecific[lake] || {}), ...speciesMap };
      }
    }
  }
  
  await env.KV.put(cacheKey, JSON.stringify(parsed), { expirationTtl: 90 * 24 * 60 * 60 });
  return parsed;
}

function getLakeRegulations(stateRegulations, lakeName) {
  const normalized = normalizeLakeName(lakeName);
  let lakeSpecific = stateRegulations.lakeSpecific[normalized] || {};
  
  // Also check partial matches
  for (const [key, val] of Object.entries(stateRegulations.lakeSpecific)) {
    if (key.includes(normalized) || normalized.includes(key)) {
      Object.assign(lakeSpecific, val);
    }
  }
  
  return {
    generalStateRegulations: stateRegulations.general,
    lakeSpecificRegulations: lakeSpecific,
    hasExceptions: Object.keys(lakeSpecific).length > 0
  };
}

// ─── OWNER-AWARE DRAWDOWN / OPERATIONS SOURCE SEEDS ───
// When deterministic parsing resolves reservoirOwner, these seeded sources are
// injected as discovery targets so the pipeline can extract lake-level ranges,
// seasonal drawdown schedules, and operations facts from the authority that
// actually manages the water.
const DUKE_CRA_PDFS = {
  wateree:           'https://www.duke-energy.com/-/media/pdfs/community/wateree-agreement.pdf?rev=d3ee54ead58f4919960633f9b2c0a3f2',
  wylie:             'https://www.duke-energy.com/-/media/pdfs/community/wylie-agreement.pdf?rev=b1ccd83257274304a043a97d94474e5f',
  norman:            'https://www.duke-energy.com/-/media/pdfs/community/norman-agreement.pdf?rev=df2002c7986b43dabfdf4ef347b3d029',
  rhodhiss:          'https://www.duke-energy.com/-/media/pdfs/community/rhodiss-agreement.pdf?rev=3d518189847e4d4fadc621264286adba',
  'mountain island': 'https://www.duke-energy.com/-/media/pdfs/community/mtislefacsht.pdf?rev=4318d49fff6449c290ddd4affcd37c1e',
  hickory:           'https://www.duke-energy.com/-/media/pdfs/community/hickory-agreement.pdf?rev=4e0097e227a745a49e27dfe9db53aff7',
  james:             'https://www.duke-energy.com/-/media/pdfs/community/james-agreement.pdf?rev=e2633e78f0104d8896fbcc35b245f13a',
  'lookout shoals':  'https://www.duke-energy.com/-/media/pdfs/community/lookout-shoals.pdf?rev=063151e074d048b599cc83e8e07ab301',
  'fishing creek':   'https://www.duke-energy.com/-/media/pdfs/community/fishing-creek.pdf?rev=76777a1c22734366b74f2315e63d62ef',
  'great falls':     'https://www.duke-energy.com/-/media/pdfs/community/gf-rocky-creek.pdf?rev=2627ab82b93c4fdc85dd1b4e9b49ef61',
  'rocky creek':     'https://www.duke-energy.com/-/media/pdfs/community/gf-rocky-creek.pdf?rev=2627ab82b93c4fdc85dd1b4e9b49ef61',
};

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
  },
  tva: {
    label: 'Tennessee Valley Authority Reservoir Operations',
    url: 'https://www.tva.com/environment/lake-levels',
    authority: 'Tennessee Valley Authority',
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
    // Return per-lake CRA PDF if we have it, otherwise fall back to landing page
    const dukePdf = DUKE_CRA_PDFS[baseName] || Object.entries(DUKE_CRA_PDFS).find(([k]) => baseName.includes(k))?.[1];
    if (dukePdf) {
      return { label: `Duke Energy ${baseName} Lake Agreement Summary (pool levels, drawdown schedule)`, url: dukePdf, authority: 'Duke Energy / FERC', type: 'PDF' };
    }
    return OWNER_DRAWDOWN_SOURCES.dukeEnergy;
  }

  // TVA manages Tennessee Valley reservoirs.
  if (owner.includes('tennessee valley authority') || owner.includes('tva') || String(state || '').toUpperCase() === 'TN') {
    return OWNER_DRAWDOWN_SOURCES.tva;
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

// ─── EXTENDED EVIDENCE ACQUISITION PIPELINE FUNCTIONS ───


// ── Supplemental R2 Key Map — mirrors supplemental-layers.js LAKE_NAME_TO_R2_KEY ──
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

async function handleResearchDiscover(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || "").trim();
  const state = String(body.state || "SC").trim().toUpperCase();

  if (!lakeName) {
    return new Response(JSON.stringify({ success: false, error: "Missing lakeName" }), { status: 400, headers: JSON_HEADERS });
  }

  const baseName = String(lakeName).replace(/^Lake\s+/i,'').replace(/,\s*(SC|NC|GA|TN)(\/(?:SC|NC|GA|TN))*\s*$/i,'').replace(/\s+Reservoir$/i,'').replace(/\s+Lake$/i,'').trim();
  const baseLower = baseName.toLowerCase();
  const otherLakeNames = ['murray','marion','moultrie','hartwell','keowee','jocassee','thurmond','clarks hill','clark hill','russell','wylie','norman','hickory','james','rhodhiss','mountain island','wateree','robinson','monticello','greenwood','secession','yates','martin'];

  const KNOWN_BAD_NEPIS_IDS = new Set(['91024IW5','9100D35L']);

  const offLakePattern = (title, url) => {
    const combined = `${title} ${url}`.toLowerCase();
    const nepisIdMatch = url.match(/\/([A-Z0-9]{6,12})\.txt/i);
    if (nepisIdMatch && KNOWN_BAD_NEPIS_IDS.has(nepisIdMatch[1].toUpperCase())) return 'known_bad_nepis_doc';
    if (/wetlands.management|wma.wetlands|wildlife.management.area|hunting.*pdf|upland.*habitat|prescribed.burn|waterfowl.impound/i.test(combined)) return 'irrelevant_doc_type';
    if (/wateratlas\.usf\.edu/i.test(combined)) return 'irrelevant_doc_type';
    if (/kentucky.*small.*lake|illinois.*channel.*cat|mud lake.*florida|wekiva.*river|lake.*county.*florida/i.test(combined)) return 'irrelevant_doc_type';
    if (/nrc\.gov\/docs\//i.test(combined)) return 'nrc_nuclear_doc';
    if (/\.gc\.ca\/|dfo-mpo\.gc\.ca|canada\.ca|ontario\.|quebec\.|british.columbia|alberta\.|manitoba\./.test(combined)) return 'foreign_government_doc';
    if (/michigandnr\.com|michigan\.gov.*dnr|mndnr\.gov|dnr\.wi\.gov|dnr\.illinois|in\.gov.*dnr/.test(url)) return 'other_state_agency';
    if (/how.to.fish|beginner.*fishing|fishing.tips.*general|learn.to.fish|fishing.basics/.test(combined) && !combined.includes(baseLower)) return 'generic_fishing_article';
    // Legal, regulatory, and policy papers — no fishing intelligence value
    if (/legal\s+scheme|water\s+supply\s+withdrawal|water\s+rights\s+litigation|regulatory\s+scheme|hydropower\s+licen|ferc\s+licen|water\s+law|riparian\s+right|water\s+withdrawal|eminent\s+domain/i.test(combined) && !/fish|striper|bass|crappie|catfish|forage|spawn|troll|angl/i.test(combined)) return 'legal_policy_paper';
    // County/township boundary articles — "Marion and Lake County line", "Marion County line", etc.
    // These match lake base names that are also common county names (Marion, Norman, etc.)
    if (/county\s+line|township\s+line|\bcounty\b.*\bline\b/i.test(title) && !/lake\s+marion|marion\s+lake|lake\s+norman|norman\s+lake/i.test(title)) return 'county_boundary_article';
    // Social media and video platforms — never fetchable, never useful as evidence
    if (/facebook\.com|youtube\.com|instagram\.com|tiktok\.com|twitter\.com|x\.com\/(?!ai)|pinterest\.com/i.test(url)) return 'social_media';
    // Fishing forums — usable content rate is near zero, TinyFish can't fetch them anyway
    if (/stripersonline\.com|bassresource\.com|carolinasportsman\.com\/forums|fishingnc\.com\/forum|fishingsc\.com\/forum|theoutdoorstrader\.com|scstriperfishing|bassfishingforum|iceshanty\.com|fishingcommunity|thefishingwebsite|southernfishingnews\.com\/forum|fishingtalkforums|angler\.com\/forum|reddit\.com/i.test(url)) return 'fishing_forum';
    // Review/booking/aggregator sites — no fishing intelligence value
    if (/yelp\.com|tripadvisor\.com|fishingbooker\.com|getmyboat\.com|viator\.com|expedia\.com|booking\.com/i.test(url)) return 'review_booking_site';
    for (const other of otherLakeNames) {
      if (other === baseLower) continue;
      if (combined.includes(`lake ${other}`) && !combined.includes(baseLower)) {
        if (/regs\.html|description\.html/.test(combined) && combined.includes(`/${other}/`) && !combined.includes(baseLower)) return other;
      }
    }
    return null;
  };

  // State-specific config — direct agency sources, no eRegulations SPA
  let dnrName = "SCDNR";
  let regsUrl = "https://www.dnr.sc.gov/regs/pdf/25SCAB-PP2-RE.pdf";
  let regsTitle = "SC Freshwater Fishing Regulations (SCDNR)";
  if (state === "NC") { dnrName = "NCWRC"; regsUrl = "https://www.ncwildlife.gov/media/4600/download?attachment="; regsTitle = "NC Inland Fishing Regulations (NCWRC)"; }
  else if (state === "GA") { dnrName = "GADNR"; regsUrl = "https://georgiawildlife.com/sites/default/files/wrd/pdf/regulations/GA2026_Hunting&Fishing%20Regulations.pdf"; regsTitle = "GA Hunting & Fishing Regulations 2025-2026 (GADNR)"; }
  else if (state === "TN") { dnrName = "TWRA"; regsUrl = "https://www.tn.gov/twra/fishing-regs/statewide-creel-length-limits.html"; regsTitle = "Tennessee Statewide Creel & Length Limits (TWRA)"; }

  // Border lake query name overrides
  const queryLake = lakeName.replace(/,\s*(SC|NC|GA|TN)(\/(?:SC|NC|GA|TN))*\s*$/i,'').trim();
  const queryLakeOverrides = {
    'lake russell': 'Richard B. Russell Lake', 'russell': 'Richard B. Russell Lake',
    'lake thurmond': 'J. Strom Thurmond Lake', 'thurmond': 'J. Strom Thurmond Lake',
    'clarks hill': 'J. Strom Thurmond Lake', 'clark hill': 'J. Strom Thurmond Lake',
    // Worker/TWRA dropdown names are reservoir-form; search the public names.
    'norris reservoir': 'Norris Lake', 'norris lake': 'Norris Lake',
    'douglas reservoir': 'Douglas Lake', 'douglas lake': 'Douglas Lake',
    'watauga lake': 'Watauga Reservoir', 'watauga reservoir': 'Watauga Reservoir',
  };
  const queryLakeFinal = queryLakeOverrides[queryLake.toLowerCase()] || queryLake;

  // Owner-aware drawdown seeding
  const reservoirOwner = body.reservoirOwner || null;
  const drawdownSource = resolveDrawdownSource(lakeName, state, reservoirOwner);

  // ── GROKIPEDIA SLUGS ──────────────────────────────────────────────────────
  const GROKIPEDIA_SLUGS = {
    'wateree': 'lake_wateree', 'murray': 'Saluda_River',
    'blewett falls': 'blewett_falls_lake',
    'marion': 'Lake_Marion_(South_Carolina)', 'moultrie': 'Lake_Moultrie',
    'monticello': 'monticello_reservoir', 'greenwood': 'Lake_Greenwood_(South_Carolina)',
    'keowee': 'keowee', 'jocassee': 'jocassee_dam', 'hartwell': 'Lake_Hartwell',
    'wylie': 'Lake_Wylie', 'secession': 'rocky_river_south_carolina',
    'fishing creek': 'fishing_creek_reservoir', 'parr': 'parr_reservoir',
    'russell': 'Richard_B._Russell_Lake', 'thurmond': 'Savannah_River',
    'norris': 'lake_norris', 'norris lake': 'lake_norris',
    'douglas': 'douglas_lake', 'douglas lake': 'douglas_lake',
    'watauga': 'watauga_reservoir', 'watauga lake': 'watauga_reservoir',
    'clarks hill': 'Savannah_River', 'norman': 'norman_lake',
    'chatuge': 'Chatuge_Lake', 'blue ridge': 'Lake_Blue_Ridge',
    'fontana': 'Fontana_Lake', 'chickamauga': 'Chickamauga_Lake',
    'james': 'Catawba_River', 'hickory': 'Catawba_River',
    'rhodhiss': 'Catawba_River', 'mountain island': 'Catawba_River',
  };

  // ─── LAKE AUTHORITY METADATA ─────────────────────────────────────────────
  // Per-lake owner domains, state agency domains, and system/basin aliases used
  // by query builders. Keeps queries lake-agnostic — no lake name hard-coded
  // in query logic; everything flows through this table.
  const STATE_FISH_AGENCY_DOMAINS = {
    SC: ['dnr.sc.gov', 'des.sc.gov'],
    NC: ['ncwildlife.gov', 'ncwildlife.org', 'deq.nc.gov', 'files.nc.gov'],
    GA: ['georgiawildlife.com', 'georgiawildlife.blog'],
    TN: ['tn.gov/twra', 'tn.gov/environment'],
  };
  const STATE_ENVIRONMENT_DOMAINS = {
    SC: ['dnr.sc.gov', 'des.sc.gov'],
    NC: ['deq.nc.gov', 'ncwildlife.gov'],
    GA: ['epd.georgia.gov', 'georgiawildlife.com'],
    TN: ['tn.gov/environment'],
  };
  // Per-lake system/basin aliases used in searches — canonical lake name is always
  // first; basin/project aliases follow. Keyed by baseLower.
  const LAKE_SYSTEM_ALIASES = {
    'wateree':        ['Catawba-Wateree', 'Catawba-Wateree Project'],
    'wylie':          ['Catawba-Wateree', 'Catawba-Wateree Project'],
    'norman':         ['Catawba-Wateree', 'Catawba-Wateree Project'],
    'hickory':        ['Catawba-Wateree', 'Catawba-Wateree Project'],
    'james':          ['Catawba-Wateree', 'Catawba-Wateree Project'],
    'rhodhiss':       ['Catawba-Wateree', 'Catawba-Wateree Project'],
    'mountain island':['Catawba-Wateree', 'Catawba-Wateree Project'],
    'marion':         ['Santee-Cooper', 'Santee Cooper Lakes'],
    'moultrie':       ['Santee-Cooper', 'Santee Cooper Lakes'],
    'hartwell':       ['Savannah River Lakes', 'Savannah River Basin'],
    'russell':        ['Savannah River Lakes', 'Savannah River Basin'],
    'thurmond':       ['Savannah River Lakes', 'Savannah River Basin'],
    'clarks hill':    ['Savannah River Lakes', 'Savannah River Basin'],
    'oconee':         ['Oconee-Sinclair', 'Georgia Power Lakes'],
    'sinclair':       ['Oconee-Sinclair', 'Georgia Power Lakes'],
    'lanier':         ['Buford Dam', 'Lake Sidney Lanier', 'USACE Lanier'],
    'allatoona':      ['USACE Allatoona'],
    'norris':         ['TVA Lakes', 'Tennessee Valley Authority'],
    'douglas':        ['TVA Lakes', 'Tennessee Valley Authority'],
    'cherokee':       ['TVA Lakes', 'Tennessee Valley Authority'],
    'chickamauga':    ['TVA Lakes', 'Tennessee Valley Authority'],
    'fort loudoun':   ['TVA Lakes', 'Tennessee Valley Authority'],
    'tellico':        ['TVA Lakes', 'Tennessee Valley Authority'],
    'watauga':        ['TVA Lakes', 'Tennessee Valley Authority'],
    'boone':          ['TVA Lakes', 'Tennessee Valley Authority'],
  };
  // Owner domain lookup by baseLower — drives site: queries
  const LAKE_OWNER_DOMAINS = {
    'wateree': ['duke-energy.com'], 'wylie': ['duke-energy.com'],
    'norman': ['duke-energy.com'], 'hickory': ['duke-energy.com'],
    'james': ['duke-energy.com'], 'rhodhiss': ['duke-energy.com'],
    'mountain island': ['duke-energy.com'],
    'fishing creek': ['duke-energy.com'], 'great falls': ['duke-energy.com'],
    'jocassee': ['duke-energy.com'], 'keowee': ['duke-energy.com'],
    'oconee': ['georgiapower.com'], 'sinclair': ['georgiapower.com'],
    'hartwell': ['sas.usace.army.mil'], 'russell': ['sas.usace.army.mil'],
    'thurmond': ['sas.usace.army.mil'], 'clarks hill': ['sas.usace.army.mil'],
    'lanier': ['sam.usace.army.mil'], 'allatoona': ['sam.usace.army.mil'],
    'norris': ['tva.com'], 'douglas': ['tva.com'], 'cherokee': ['tva.com'],
    'chickamauga': ['tva.com'], 'fort loudoun': ['tva.com'],
    'tellico': ['tva.com'], 'watauga': ['tva.com'], 'boone': ['tva.com'],
    'marion': ['santeecooper.com'], 'moultrie': ['santeecooper.com'],
  };
  // SC SCDNR fisheries publication series — lake-agnostic, highly productive
  const SC_FWFI_QUERY = (lake) => `"${lake}" "Fisheries Investigations in Lakes and Streams" site:dnr.sc.gov/fish/fwfi`;

  const lakeOwnerDomains = LAKE_OWNER_DOMAINS[baseLower] || [];
  const lakeSystemAliases = LAKE_SYSTEM_ALIASES[baseLower] || [];
  const stateFishDomain = (STATE_FISH_AGENCY_DOMAINS[state] || [])[0] || '';
  const stateEnvDomain = (STATE_ENVIRONMENT_DOMAINS[state] || [])[0] || '';
  const ownerOrEnvDomain = lakeOwnerDomains[0] || stateEnvDomain;

  // ─── CANONICAL URL NORMALIZER ─────────────────────────────────────────────
  // Implements section 12.4 rules. Returns { canonicalUrl, requestedUrl,
  // urlAliases, sourceRevision } without modifying original URLs.
  // Used for cross-category deduplication keying only — original URLs are
  // preserved for fetching.
  function canonicalizeUrl(rawUrl) {
    let parsed;
    try { parsed = new URL(rawUrl); } catch { return { canonicalUrl: rawUrl, requestedUrl: rawUrl, urlAliases: [] }; }
    if (!['http:', 'https:'].includes(parsed.protocol)) return { canonicalUrl: rawUrl, requestedUrl: rawUrl, urlAliases: [] };

    // Lowercase scheme + hostname; remove default ports
    let host = parsed.hostname.toLowerCase();
    let path = parsed.pathname;

    // Remove fragments
    // Collapse duplicate path slashes
    path = path.replace(/\/\/+/g, '/');

    // Remove trailing slash except root
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

    // Build retained params — strip tracking, preserve functional identity params
    const TRACKING_PARAMS = new Set(['utm_source','utm_medium','utm_campaign','utm_term','utm_content','fbclid','gclid','msclkid','srsltid']);
    // Params that select disposition only (store as metadata, not identity)
    const DISPOSITION_PARAMS = new Set(['attachment','download','withWatermark','withMetadata','registerDownload']);
    const REVISION_PARAMS = new Set(['rev','ver','version']);

    const retainedParams = [];
    let sourceRevision = null;
    const urlAliases = [];

    for (const [k, v] of [...parsed.searchParams.entries()].sort((a,b) => a[0].localeCompare(b[0]))) {
      if (TRACKING_PARAMS.has(k)) continue;
      if (REVISION_PARAMS.has(k)) { sourceRevision = `${k}=${v}`; continue; } // strip from key, store as metadata
      if (DISPOSITION_PARAMS.has(k)) continue; // attachment/download are disposition-only
      // NEPIS identity params — always retain
      if (/Dockey|ZyAction|ZyEntry|File|Dockey/i.test(k)) { retainedParams.push([k, v]); continue; }
      retainedParams.push([k, v]);
    }

    // Domain adapters
    // NCWRC: normalize /open and /download?attachment routes — register as aliases of the base path
    if (/ncwildlife\.gov/i.test(host)) {
      if (path.endsWith('/open')) {
        const base = path.slice(0, -5);
        urlAliases.push(`https://${host}${base}/download?attachment`);
      } else if (path.includes('/download')) {
        const base = path.replace(/\/download$/, '');
        urlAliases.push(`https://${host}${base}/open`);
      } else if (/\/media\/\d+\/download/.test(path)) {
        // /media/{id}/download?attachment — keep as-is, no alias inference
      }
    }

    // Duke CRA PDFs: strip rev from identity key (stored as sourceRevision above)
    // UGA: strip download presentation flags, keep stable /record/{id}/files/{name}
    if (/openscholar\.uga\.edu/i.test(host)) {
      retainedParams.length = 0; // strip all UGA query params from canonical key
    }

    const qString = retainedParams.length
      ? '?' + retainedParams.map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
      : '';

    const canonicalUrl = `https://${host}${path}${qString}`;
    return { canonicalUrl, requestedUrl: rawUrl, urlAliases, sourceRevision };
  }

  // ─── PRE-FETCH RELEVANCE SCORER ──────────────────────────────────────────
  // Implements section 5 scoring. Guaranteed seeds always pass (score=999).
  // Discovered candidates below threshold are logged but not fetched.
  const PRE_FETCH_THRESHOLD = 2; // minimum score to fetch a discovered candidate
  function scoreCandidateRelevance(candidate, lakeName, baseName, aliases, state) {
    if (candidate.priority === 1) return 999; // guaranteed seed — always fetch
    const title = (candidate.title || '').toLowerCase();
    const snippet = (candidate.snippet || '').toLowerCase();
    const url = (candidate.url || '').toLowerCase();
    const baseLower = baseName.toLowerCase();
    const lakeNameLower = lakeName.toLowerCase();
    const stateLower = state.toLowerCase();
    const aliasesLower = (aliases || []).map(a => a.toLowerCase());

    let score = 0;

    // Positive signals
    if (title.includes(baseLower) || title.includes(lakeNameLower)) score += 5;
    if (snippet.includes(baseLower) || snippet.includes(lakeNameLower)) score += 4;
    if (aliasesLower.some(a => title.includes(a))) score += 4;
    if (aliasesLower.some(a => snippet.includes(a))) score += 3;

    // Authority domain bonus
    try {
      const host = new URL(candidate.url).hostname.toLowerCase();
      if (/\.gov$|usace\.army\.mil|epa\.gov|usgs\.gov|ferc\.gov|tva\.com|santeecooper\.com|duke-energy\.com|georgiapower\.com/.test(host)) score += 3;
      else if (/\.edu$/.test(host)) score += 2;
    } catch {}

    // Document type bonuses
    if (/report|assessment|survey|management.plan|study|investigation/.test(title + snippet)) score += 2;
    if (url.endsWith('.pdf') || /\/open$|download\?attachment|\/media\/\d+\/download/.test(url)) score += 1;

    // Negative signals
    const otherLakeNames = ['murray','marion','moultrie','hartwell','keowee','jocassee','thurmond','clarks hill','clark hill','russell','wylie','norman','hickory','james','rhodhiss','mountain island','wateree','robinson','monticello','greenwood','secession','lanier','oconee','sinclair','allatoona','norris','douglas','cherokee','chickamauga'];
    for (const other of otherLakeNames) {
      if (other === baseLower) continue;
      if (title.includes(`lake ${other}`) || title.includes(`${other} lake`) || title.includes(`${other} reservoir`)) {
        score -= 6;
        break;
      }
    }
    // Another state in title context (rough signal)
    const otherStates = ['florida','virginia','alabama','mississippi','arkansas','ohio','indiana','michigan','wisconsin','illinois','minnesota'];
    if (otherStates.some(s => title.includes(s))) score -= 5;
    if (/facebook\.com|instagram\.com|youtube\.com|pinterest\.com|twitter\.com/.test(url)) score -= 5;

    return score;
  }

  // ─── AGENT-SPECIFIC DISCOVERY QUERIES ───
const AGENT_DISCOVERY_QUERIES = {
  // Identity: deterministic seeds (Duke CRA, USACE, TVA) are already seeded above.
  // Search fills gaps — focused queries, one method per search.
  identity: {
    SC: (lake) => [
      `"${lake}" dam owner FERC license reservoir filetype:pdf`,
      ...(lakeOwnerDomains[0] ? [`"${lake}" reservoir project site:${lakeOwnerDomains[0]}`] : []),
      ...(lakeSystemAliases[0] ? [`"${lakeSystemAliases[0]}" "${lake}" project license reservoir filetype:pdf`] : []),
    ],
    NC: (lake) => [
      `"${lake}" dam owner FERC license reservoir filetype:pdf`,
      ...(lakeOwnerDomains[0] ? [`"${lake}" reservoir project site:${lakeOwnerDomains[0]}`] : []),
      ...(lakeSystemAliases[0] ? [`"${lakeSystemAliases[0]}" "${lake}" project license reservoir filetype:pdf`] : []),
    ],
    GA: (lake) => [
      `"${lake}" dam owner FERC license reservoir filetype:pdf`,
      ...(lakeOwnerDomains[0] ? [`"${lake}" reservoir project site:${lakeOwnerDomains[0]}`] : []),
      ...(lakeSystemAliases[0] ? [`"${lakeSystemAliases[0]}" "${lake}" project license reservoir filetype:pdf`] : []),
    ],
    TN: (lake) => [
      `"${lake}" dam owner FERC license reservoir filetype:pdf`,
      ...(lakeOwnerDomains[0] ? [`"${lake}" reservoir project site:${lakeOwnerDomains[0]}`] : []),
      ...(lakeSystemAliases[0] ? [`"${lakeSystemAliases[0]}" "${lake}" project license reservoir filetype:pdf`] : []),
    ],
  },
  limnology: {
    SC: (lake) => [
      `"${lake}" dissolved oxygen water quality monitoring assessment filetype:pdf`,
      `"${lake}" thermocline hypolimnion temperature profile filetype:pdf`,
      ...(ownerOrEnvDomain ? [`"${lake}" water quality monitoring site:${ownerOrEnvDomain}`] : []),
      ...(lakeSystemAliases[0] ? [`"${lakeSystemAliases[0]}" "${lake}" water quality monitoring filetype:pdf`] : []),
    ],
    NC: (lake) => [
      `"${lake}" dissolved oxygen water quality monitoring assessment filetype:pdf`,
      `"${lake}" thermocline hypolimnion temperature profile filetype:pdf`,
      ...(ownerOrEnvDomain ? [`"${lake}" water quality monitoring site:${ownerOrEnvDomain}`] : []),
      ...(lakeSystemAliases[0] ? [`"${lakeSystemAliases[0]}" "${lake}" water quality monitoring filetype:pdf`] : []),
    ],
    GA: (lake) => [
      `"${lake}" dissolved oxygen water quality monitoring assessment filetype:pdf`,
      `"${lake}" thermocline hypolimnion temperature profile filetype:pdf`,
      ...(ownerOrEnvDomain ? [`"${lake}" water quality monitoring site:${ownerOrEnvDomain}`] : []),
      ...(lakeSystemAliases[0] ? [`"${lakeSystemAliases[0]}" "${lake}" water quality monitoring filetype:pdf`] : []),
    ],
    TN: (lake) => [
      `"${lake}" dissolved oxygen water quality monitoring assessment filetype:pdf`,
      `"${lake}" thermocline hypolimnion temperature profile filetype:pdf`,
      ...(ownerOrEnvDomain ? [`"${lake}" water quality monitoring site:${ownerOrEnvDomain}`] : []),
      ...(lakeSystemAliases[0] ? [`"${lakeSystemAliases[0]}" "${lake}" water quality monitoring filetype:pdf`] : []),
    ],
  },
  biology: {
    // Primary: state fish agency site search. Focused fallbacks run separately.
    // Third query uses domain_type=research_paper (see _domainTypes below).
    SC: (lake) => [
      ...(stateFishDomain ? [`"${lake}" fisheries survey site:${stateFishDomain}`] : [`"${lake}" fisheries survey site:dnr.sc.gov`]),
      SC_FWFI_QUERY(lake),
      `"${lake}" striped bass forage stocking assessment -site:facebook.com -site:instagram.com -site:youtube.com`,
      `"${lake}" fisheries population habitat`,
    ],
    NC: (lake) => [
      ...(stateFishDomain ? [`"${lake}" fisheries survey site:${stateFishDomain}`] : [`"${lake}" fisheries survey site:ncwildlife.gov`]),
      `"${lake}" stocking evaluation site:${stateFishDomain || 'ncwildlife.gov'}`,
      `"${lake}" striped bass forage stocking assessment -site:facebook.com -site:instagram.com -site:youtube.com`,
      `"${lake}" fisheries population habitat`,
    ],
    GA: (lake) => [
      ...(stateFishDomain ? [`"${lake}" fisheries survey site:${stateFishDomain}`] : [`"${lake}" fisheries survey site:georgiawildlife.com`]),
      `"${lake}" stocking evaluation site:${stateFishDomain || 'georgiawildlife.com'}`,
      `"${lake}" striped bass forage stocking assessment -site:facebook.com -site:instagram.com -site:youtube.com`,
      `"${lake}" fisheries population habitat`,
    ],
    TN: (lake) => [
      ...(stateFishDomain ? [`"${lake}" fisheries survey site:${stateFishDomain}`] : [`"${lake}" fisheries survey site:tn.gov/twra`]),
      `"${lake}" stocking evaluation site:${stateFishDomain || 'tn.gov/twra'}`,
      `"${lake}" striped bass forage stocking assessment -site:facebook.com -site:instagram.com -site:youtube.com`,
      `"${lake}" fisheries population habitat`,
    ],
  },
  // Domain types per agent — 'web' by default, 'research_paper' for biology academic query
  _domainTypes: {
    // biology: [primary site:, SC series / stocking, forage web, academic]
    biology: ['web', 'web', 'web', 'research_paper'],
  },
  // Per-agent TinyFish purpose strings — passed via API, not injected into query text
  _purposes: {
    identity:    (lake, st) => `Find authoritative dam owner, FERC license, and reservoir identity documents for ${lake} in ${st}. Prefer government agencies, reservoir owners, and FERC filings.`,
    limnology:   (lake, st) => `Find authoritative water quality, dissolved oxygen, thermocline, and limnology studies for ${lake} in ${st}. Prefer government agencies, reservoir owners, and peer-reviewed studies.`,
    biology:     (lake, st) => `Find authoritative fisheries surveys, stocking records, and fish population assessments for ${lake} in ${st}. Prefer state fish agencies, universities, and original studies.`,
    habitat:     (lake, st) => `Find authoritative aquatic habitat, vegetation, and structural enhancement assessments for ${lake} in ${st}. Prefer state agencies and original studies.`,
    navigation:  (lake, st) => `Find authoritative navigation hazards, shoals, channel markers, and access information for ${lake} in ${st}. Reject generic boating pages that do not name this lake.`,
    regulations: (lake, st) => `Find authoritative fishing regulations, creel limits, and size limits for ${lake} in ${st}. Prefer state fish agency regulation digests.`,
    fisheries:   (lake, st) => `Find authoritative seasonal fishing patterns, current fishing reports, and angler catch data for ${lake} in ${st}. Reject social media and generic aggregation pages.`,
  },
  habitat: {
    SC: (lake) => [
      `"${lake}" aquatic vegetation hydrilla management -site:facebook.com -site:instagram.com`,
      `"${lake}" fish habitat enhancement assessment -site:facebook.com -site:instagram.com`,
      ...(lakeOwnerDomains[0] ? [`"${lake}" shoreline habitat management site:${lakeOwnerDomains[0]}`] : []),
    ],
    NC: (lake) => [
      `"${lake}" aquatic vegetation hydrilla management -site:facebook.com -site:instagram.com`,
      `"${lake}" fish habitat enhancement assessment -site:facebook.com -site:instagram.com`,
      ...(lakeOwnerDomains[0] ? [`"${lake}" shoreline habitat management site:${lakeOwnerDomains[0]}`] : []),
    ],
    GA: (lake) => [
      `"${lake}" aquatic vegetation hydrilla management -site:facebook.com -site:instagram.com`,
      `"${lake}" fish habitat enhancement assessment -site:facebook.com -site:instagram.com`,
      ...(lakeOwnerDomains[0] ? [`"${lake}" shoreline habitat management site:${lakeOwnerDomains[0]}`] : []),
    ],
    TN: (lake) => [
      `"${lake}" aquatic vegetation hydrilla management -site:facebook.com -site:instagram.com`,
      `"${lake}" fish habitat enhancement assessment -site:facebook.com -site:instagram.com`,
      ...(lakeOwnerDomains[0] ? [`"${lake}" shoreline habitat management site:${lakeOwnerDomains[0]}`] : []),
    ],
  },
  navigation: {
    SC: (lake) => [
      `"${lake}" navigation hazards channel markers -site:facebook.com -site:instagram.com -site:youtube.com`,
      ...(lakeOwnerDomains[0] ? [`"${lake}" navigation shoal markers hazards site:${lakeOwnerDomains[0]}`] : []),
    ],
    NC: (lake) => [
      `"${lake}" navigation hazards channel markers -site:facebook.com -site:instagram.com -site:youtube.com`,
      ...(lakeOwnerDomains[0] ? [`"${lake}" navigation shoal markers hazards site:${lakeOwnerDomains[0]}`] : []),
    ],
    GA: (lake) => [
      `"${lake}" navigation hazards channel markers -site:facebook.com -site:instagram.com -site:youtube.com`,
      ...(lakeOwnerDomains[0] ? [`"${lake}" navigation shoal markers hazards site:${lakeOwnerDomains[0]}`] : []),
    ],
    TN: (lake) => [
      `"${lake}" navigation hazards channel markers -site:facebook.com -site:instagram.com -site:youtube.com`,
      ...(lakeOwnerDomains[0] ? [`"${lake}" navigation shoal markers hazards site:${lakeOwnerDomains[0]}`] : []),
    ],
  },
  regulations: {
    // Regulations primarily sourced from deterministic seeds (eRegulations, SCDNR regs page).
    // Discovery fallback only — one focused query per state.
    SC: (lake) => [`"${lake}" fishing regulations exceptions site:${stateFishDomain || 'dnr.sc.gov'}`],
    NC: (lake) => [`"${lake}" fishing regulations exceptions site:${stateFishDomain || 'ncwildlife.gov'}`],
    GA: (lake) => [`"${lake}" fishing regulations exceptions site:${stateFishDomain || 'georgiawildlife.com'}`],
    TN: (lake) => [`"${lake}" fishing regulations exceptions site:${stateFishDomain || 'tn.gov/twra'}`],
  },
  fisheries: {
    // Two separate queries per section 12.6: current reports (recency window) +
    // evergreen seasonal patterns (no recency). Handled separately in search loop
    // via _fisheries_recency flag below.
    SC: (lake) => [
      `"${lake}" fishing report -site:facebook.com -site:instagram.com -site:youtube.com`,
      `"${lake}" seasonal fishing patterns bass crappie striped bass -site:facebook.com -site:instagram.com -site:youtube.com`,
    ],
    NC: (lake) => [
      `"${lake}" fishing report -site:facebook.com -site:instagram.com -site:youtube.com`,
      `"${lake}" seasonal fishing patterns bass crappie striped bass -site:facebook.com -site:instagram.com -site:youtube.com`,
    ],
    GA: (lake) => [
      `"${lake}" fishing report -site:facebook.com -site:instagram.com -site:youtube.com`,
      `"${lake}" seasonal fishing patterns bass crappie striped bass -site:facebook.com -site:instagram.com -site:youtube.com`,
    ],
    TN: (lake) => [
      `"${lake}" fishing report -site:facebook.com -site:instagram.com -site:youtube.com`,
      `"${lake}" seasonal fishing patterns bass crappie striped bass -site:facebook.com -site:instagram.com -site:youtube.com`,
    ],
  },
  // Fisheries query 0 gets recency window (45 days primary); query 1 is evergreen
  _fisheries_recency: [64800, null],
  summary: { SC: () => [], NC: () => [], GA: () => [], TN: () => [] }
};
const AGENT_TO_TAGS = {
  identity: ['identity'],
  limnology: ['limnology'],
  biology: ['biology'],
  habitat: ['habitat'],
  navigation: ['navigation'],
  regulations: ['regulations'],
  fisheries: ['fisheries'],
  summary: ['summary']
};

const KNOWN_BAD_NEPIS = new Set(['monticello']);
  const skipNepis = KNOWN_BAD_NEPIS.has(baseLower);

  const firecrawlKey = env.FIRECRAWL_API_KEY || env.FIRECRAWL_KEY;
  const seenUrls = new Set();
  const queryLog = [];
  let discoveredSources = [];

  // ── STEP 1: Guaranteed seeds (always included) ──────────────────────────
  const guaranteedSeeds = [];

  const addSeed = (seed) => {
    const normUrl = String(seed.url || '').split('?')[0].toLowerCase();
    if (seenUrls.has(normUrl)) return;
    seenUrls.add(normUrl);
    seenUrls.add(seed.url);
    guaranteedSeeds.push(seed);
  };

  // ── Agent-aware seed filtering ───────────────────────────────────────────
  // When a specific agent is requested, only seed sources relevant to that agent.
  // Full pipeline (no agent param) gets all seeds as before.
  // Seed relevance map: which agents care about each seed type
  const agentForSeeds = String(body.agent || '').trim().toLowerCase() || null;
  const wantsGrokipedia   = !agentForSeeds || ['identity','limnology','biology','habitat'].includes(agentForSeeds);
  const wantsRegs         = !agentForSeeds || agentForSeeds === 'regulations';
  const wantsScdnrDesc    = !agentForSeeds || ['identity','habitat','navigation'].includes(agentForSeeds);
  const wantsScdnrRegs    = !agentForSeeds || agentForSeeds === 'regulations';
  const wantsNepis        = !agentForSeeds || ['limnology'].includes(agentForSeeds);
  const wantsOwnerDoc     = !agentForSeeds || ['identity','limnology'].includes(agentForSeeds);
  const wantsDukeCra      = !agentForSeeds || ['identity','limnology'].includes(agentForSeeds);

  // Grokipedia — identity/limnology/biology/habitat only
  const grokSlug = GROKIPEDIA_SLUGS[baseLower];
  const grokCandidates = grokSlug
    ? [`https://grokipedia.com/page/${grokSlug}`]
    : [
        `https://grokipedia.com/page/${baseName.replace(/\s+/g,'_').toLowerCase()}_lake`,
        `https://grokipedia.com/page/Lake_${baseName.replace(/\s+/g,'_')}`,
        `https://grokipedia.com/page/${baseName.replace(/\s+/g,'_')}_Lake`,
        `https://grokipedia.com/page/${baseName.replace(/\s+/g,'_')}`,
      ];
  const resolvedGrokUrl = grokCandidates[0];
  if (wantsGrokipedia) {
    if (grokSlug) {
      addSeed({ title: `${lakeName} — Grokipedia`, type: 'HTML', authority: 'Grokipedia', url: resolvedGrokUrl, priority: 1, agentTags: ['identity','limnology','biology','habitat'] });
    } else {
      addSeed({ title: `${lakeName} — Grokipedia (auto)`, type: 'HTML', authority: 'Grokipedia', url: resolvedGrokUrl, priority: 2, agentTags: ['identity','limnology','biology','habitat'] });
    }
    if (baseLower === 'hartwell') {
      addSeed({ title: 'Savannah River — Grokipedia', type: 'HTML', authority: 'Grokipedia', url: 'https://grokipedia.com/page/Savannah_River', priority: 2, agentTags: ['identity','limnology'] });
    }
    if (baseLower === 'thurmond' || baseLower === 'clarks hill') {
      addSeed({ title: 'Little River (Columbia County, GA) — Grokipedia', type: 'HTML', authority: 'Grokipedia', url: 'https://grokipedia.com/page/little_river_columbia_county_georgia', priority: 2, agentTags: ['identity'] });
    }
  }

  // State regulations — regulations agent only
  // NOTE: regulations agent uses KV-cached fetchStateRegulations (0 docs needed).
  // eRegulations seed is kept as fallback only if KV cache miss.
  if (wantsRegs) {
    addSeed({ title: regsTitle, type: 'HTML', authority: dnrName, url: regsUrl, priority: 1, agentTags: ['regulations'] });
    if (state === 'GA') {
      addSeed({ title: 'GA General Freshwater Regulations (eRegulations)', type: 'HTML', authority: 'GADNR', url: 'https://www.eregulations.com/georgia/fishing/general-regulations', priority: 1, agentTags: ['regulations'] });
    }
  }

  // SCDNR lake description — identity/habitat/navigation only
  if (wantsScdnrDesc && state === 'SC') {
    addSeed({ title: `Lake ${baseName} SCDNR Lake Description`, type: 'HTML', authority: 'SCDNR', url: `https://www.dnr.sc.gov/lakes/${baseLower}/description.html`, priority: 1, agentTags: ['identity','habitat','navigation'] });
  }

  // SCDNR regs page — regulations agent only
  if (wantsScdnrRegs && state === 'SC') {
    addSeed({ title: `Lake ${baseName} Regulations`, type: 'HTML', authority: 'SCDNR', url: `https://www.dnr.sc.gov/lakes/${baseLower}/regs.html`, priority: 1, agentTags: ['regulations'] });
  }

  // TWRA reservoir profiles — regulations + identity
  const TWRA_LAKE_PAGES = {
    'norris': 'https://www.tn.gov/twra/fishing/where-to-fish/east-tennessee-r4/norris-reservoir.html',
    'douglas': 'https://www.tn.gov/twra/fishing/where-to-fish/east-tennessee-r4/douglas-reservoir.html',
    'watauga': 'https://www.tn.gov/twra/fishing/where-to-fish/east-tennessee-r4/watauga-reservoir.html',
  };
  if (state === 'TN' && TWRA_LAKE_PAGES[baseLower] && (!agentForSeeds || ['regulations','identity'].includes(agentForSeeds))) {
    addSeed({ title: `${baseName} TWRA Reservoir Profile`, type: 'HTML', authority: 'TWRA', url: TWRA_LAKE_PAGES[baseLower], priority: 1, agentTags: ['regulations','identity'] });
  }

  // Owner/drawdown source — identity + limnology only
  if (wantsOwnerDoc && drawdownSource) {
    addSeed({ title: drawdownSource.label, type: drawdownSource.type, authority: drawdownSource.authority, url: drawdownSource.url, priority: 1, agentTags: ['identity','limnology'] });
  }

  // Duke CRA PDF — identity + limnology only
  if (wantsDukeCra) {
    const durCra = DUKE_CRA_PDFS[baseLower];
    if (durCra) {
      addSeed({ title: `${baseName} Lake Management Agreement — Duke Energy CRA`, type: 'PDF', authority: 'Duke Energy / FERC', url: durCra, priority: 1, agentTags: ['identity','limnology'] });
    }
  }

  // State agency fishing news/trends page — best source of current seasonal pattern data
  // Tagged fisheries only — these are narrative fishing reports not regulatory docs
  const STATE_FISHING_NEWS = {
    SC: { title: 'SCDNR Freshwater Fishing Trends', url: 'https://www.dnr.sc.gov/news/freshwater.html', authority: 'SCDNR' },
    NC: { title: 'NCWRC Fishing Reports', url: 'https://www.ncwildlife.org/Fishing/Fishing-Where-to-Fish/Fishing-Reports', authority: 'NCWRC' },
    GA: { title: 'Georgia DNR Fishing Forecasts', url: 'https://georgiawildlife.com/fishing/reports', authority: 'GADNR' },
    TN: { title: 'TWRA Fishing Reports', url: 'https://www.tn.gov/twra/fishing/fishing-reports.html', authority: 'TWRA' },
  };
  const fishingNews = STATE_FISHING_NEWS[state];
  if (fishingNews && (!agentForSeeds || agentForSeeds === 'fisheries')) {
    addSeed({ title: fishingNews.title, type: 'HTML', authority: fishingNews.authority, url: fishingNews.url, priority: 1, agentTags: ['fisheries'] });
  }

  // NEPIS EPA survey search — limnology only
  if (wantsNepis && !skipNepis) {
    addSeed({
      title: `EPA NSCEP search: Report on ${baseName} / Lake ${baseName}`,
      type: 'HTML', authority: 'EPA NSCEP',
      url: buildNepisSearchUrl(lakeName, state, baseName),
      priority: 2, source: 'nepis_seed', agentTags: ['limnology']
    });
  }

  // ── STEP 2: Grokipedia citation following ────────────────────────────────
  // Fetch the Grokipedia page and extract all citation URLs — these are the
  // same authoritative sources Grokipedia used, handed to us for free.
  // Uses TinyFish (free) instead of Firecrawl. Links are extracted from markdown.
  // Only run for agents that benefit from Grokipedia citations.
  if (wantsGrokipedia && (grokSlug || grokCandidates.length > 1)) {
    try {
      let grokUrl = null;
      let grokText = '';
      for (const candidate of grokCandidates) {
        try {
          const tfGrok = await tinyfishFetch({
            urls: [candidate],
            format: 'markdown',
            ttl: 86400
          }, env);
          const candidateMarkdown = String(tfGrok.results?.[0]?.text || '');
          const isLakeArticle = /grokipedia\.com\/page\/blewett_falls_lake/i.test(candidate)
            ? /blewett\s+falls\s+lake/i.test(candidateMarkdown)
            : candidateMarkdown.length >= 200;
          if (candidateMarkdown.length >= 200 && isLakeArticle) {
            grokUrl = candidate;
            grokText = candidateMarkdown;
            const grokSeed = guaranteedSeeds.find(s => s.authority === 'Grokipedia');
            if (grokSeed && grokSeed.url !== candidate) {
              grokSeed.url = candidate;
              grokSeed.title = `${lakeName} — Grokipedia`;
            }
            break;
          }
        } catch (tfGrokErr) {
          queryLog.push(`Grokipedia TinyFish fetch failed for ${candidate}: ${tfGrokErr.message}`);
        }
      }

      if (!grokUrl) { queryLog.push('Grokipedia: no valid page found for any candidate'); }
      if (grokUrl && grokText) {
        // Extract citation URLs from markdown — Grokipedia reference links appear as:
        // [1]: https://... or [[1]](https://...) or plain URLs in reference section
        const citationLinks = [];
        const seen = new Set();
        for (const m of grokText.matchAll(/\]\(?(https?:\/\/[^\s)\]"']+)/g)) {
          const u = m[1];
          if (seen.has(u)) continue;
          seen.add(u);
          if (u.includes('grokipedia.com')) continue;
          if (/facebook\.com|twitter\.com|youtube\.com|instagram\.com|wikipedia\.org\/wiki\/Wikipedia:/i.test(u)) continue;
          citationLinks.push(u);
        }

        queryLog.push(`Grokipedia citations found: ${citationLinks.length}`);

        for (const citUrl of citationLinks.slice(0, 15)) {
          // Extract a meaningful title from the URL for offLakePattern title check
          const urlTitle = decodeURIComponent(citUrl.split('/').pop().replace(/[_-]/g,' ').replace(/\.[a-z]+$/i,''));
          const off = offLakePattern(urlTitle, citUrl);
          if (off) { queryLog.push(`  ✗ grok citation rejected (${off}): ${citUrl.slice(0,80)}`); continue; }

          // Authority-aware filtering — only seed high-value domains from citations
          // Skip generic/commercial domains that won't have lake intelligence
          let authority = '';
          try {
            const host = new URL(citUrl).hostname;
            if (/usace\.army\.mil/.test(host)) authority = 'USACE';
            else if (/epa\.gov|nepis/.test(host)) authority = 'EPA';
            else if (/usgs\.gov/.test(host)) authority = 'USGS';
            else if (/dnr\.sc\.gov/.test(host)) authority = 'SCDNR';
            else if (/ncwildlife\.gov|ncwildlife\.org/.test(host)) authority = 'NCWRC';
            else if (/georgiawildlife\.com/.test(host)) authority = 'GADNR';
            else if (/tn\.gov/.test(host)) authority = 'TWRA';
            else if (/duke-energy\.com/.test(host)) authority = 'Duke Energy';
            else if (/ferc\.gov/.test(host)) authority = 'FERC';
            else if (/santeecooper\.com/.test(host)) authority = 'Santee Cooper';
            else if (/seafwa\.org|apms\.org|\.edu$/.test(host)) authority = 'Academic';
            else if (/tva\.com/.test(host)) authority = 'TVA';
            else authority = 'Web';
          } catch {}

          // Skip low-value domains from Grokipedia citations entirely
          if (authority === 'Web') {
            queryLog.push(`  ✗ grok citation skipped (low-value domain): ${citUrl.slice(0,80)}`);
            continue;
          }

          const isPdf = citUrl.toLowerCase().endsWith('.pdf');
          addSeed({ title: `${lakeName} — ${authority} (via Grokipedia citation)`, type: isPdf ? 'PDF' : 'HTML', authority, url: citUrl, priority: 2, agentTags: ['identity','limnology','biology','habitat'] });
        }

        // Store markdown inline so proxy-download can skip re-fetching
        const existingGrok = guaranteedSeeds.find(s => s.url === grokUrl);
        if (existingGrok && grokText) existingGrok.fullText = grokText;
      }
    } catch (e) {
      queryLog.push(`Grokipedia citation fetch failed: ${e.message}`);
    }
  }

  // ── STEP 3: Agent-specific search queries ───────────────────────────────
  const agent = String(body.agent || "").trim().toLowerCase();
  const agentsToDiscover = agent ? [agent] : Object.keys(AGENT_DISCOVERY_QUERIES);
  
  // Cross-category candidate pool — all agents deposit here; dedup by canonical URL
  // before returning so a URL requested by multiple agents is fetched only once.
  const canonicalToCandidate = new Map(); // canonicalUrl -> candidate object

  for (const agentKey of agentsToDiscover) {
    if (!AGENT_DISCOVERY_QUERIES[agentKey]) continue;

    const stateQueries = AGENT_DISCOVERY_QUERIES[agentKey][state];
    if (!stateQueries) continue;

    const queries = stateQueries(queryLakeFinal);
    if (!queries.length) continue;

    const agentTags = AGENT_TO_TAGS[agentKey] || [agentKey];
    const purposeFn = AGENT_DISCOVERY_QUERIES._purposes?.[agentKey];
    const purposeStr = purposeFn ? purposeFn(queryLakeFinal, state) : `Find authoritative ${agentKey} information about ${lakeName} in ${state}`;

    for (let qIndex = 0; qIndex < queries.length; qIndex++) {
      const q = queries[qIndex];
      const domainTypes = AGENT_DISCOVERY_QUERIES._domainTypes?.[agentKey];
      const domainType = domainTypes?.[qIndex] || 'web';

      // Fisheries: first query gets recency window (45d primary), second is evergreen
      const recencyWindows = agentKey === 'fisheries' ? AGENT_DISCOVERY_QUERIES._fisheries_recency : null;
      const recencyMinutes = recencyWindows ? recencyWindows[qIndex] : null;

      try {
        let rawResults = [];

        // TinyFish handles all discovery search — free, no credits spent.
        // Firecrawl is fetch-only (proxy-download). Never use Firecrawl for search.
        try {
          const tfParams = {
            query: q,
            domain_type: domainType,
            purpose: purposeStr,
            location: 'US',
            language: 'en',
          };
          if (recencyMinutes) tfParams.recency_minutes = recencyMinutes;
          const tfResult = await tinyfishSearch(tfParams, env);
          rawResults = tfResult.results || [];
          queryLog.push(`[${agentKey}${domainType !== 'web' ? ':' + domainType : ''}${recencyMinutes ? ':' + recencyMinutes + 'm' : ''}] TinyFish: ${q.slice(0,80)} → ${rawResults.length} results`);

          // Fisheries current-report fallback: if < 3 results at 45d, retry at 180d
          if (agentKey === 'fisheries' && qIndex === 0 && rawResults.length < 3 && recencyMinutes === 64800) {
            try {
              const tfFallback = await tinyfishSearch({ ...tfParams, recency_minutes: 259200 }, env);
              const fallbackResults = tfFallback.results || [];
              queryLog.push(`[fisheries] recency fallback 180d: ${fallbackResults.length} additional results`);
              const existingUrls = new Set(rawResults.map(r => String(r.url||'').toLowerCase()));
              rawResults = [...rawResults, ...fallbackResults.filter(r => !existingUrls.has(String(r.url||'').toLowerCase()))];
            } catch (fbErr) {
              queryLog.push(`[fisheries] recency fallback failed: ${fbErr.message}`);
            }
          }
        } catch (tfErr) {
          queryLog.push(`[${agentKey}] TinyFish failed: ${tfErr.message}`);
          continue;
        }

        queryLog.push(`[${agentKey}] ${q.slice(0, 100)} → ${rawResults.length} results`);

        for (const r of rawResults) {
          const off = offLakePattern(r.title||'', r.url||'');
          if (off) { queryLog.push(`  ✗ off-lake (${off}): ${(r.title||r.url).slice(0,80)}`); continue; }

          const { canonicalUrl, urlAliases, sourceRevision } = canonicalizeUrl(r.url || '');

          // Pre-fetch relevance score — using preserved snippet from TinyFish result
          const snippet = r.snippet || r.description || r.summary || '';
          const candidate = {
            title: (r.title || `${queryLake} - Web`).replace(/\s+/g,' ').trim().slice(0,180),
            url: r.url,
            canonicalUrl,
            urlAliases,
            sourceRevision: sourceRevision || undefined,
            snippet: snippet.slice(0, 400),
            siteName: r.site_name || r.siteName || '',
            publishedDate: r.date || r.published_date || '',
            searchScore: r.score || 0,
          };
          const prefetchScore = scoreCandidateRelevance(candidate, lakeName, baseName, lakeSystemAliases, state);

          if (prefetchScore < PRE_FETCH_THRESHOLD) {
            queryLog.push(`  ✗ below threshold (score ${prefetchScore}): ${(r.title||r.url).slice(0,80)}`);
            continue;
          }

          // Cross-category dedup by canonical URL — merge agentTags if already seen
          if (canonicalToCandidate.has(canonicalUrl)) {
            const existing = canonicalToCandidate.get(canonicalUrl);
            const merged = [...new Set([...(existing.agentTags || []), ...agentTags])];
            existing.agentTags = merged;
            queryLog.push(`  ↔ merged tags for ${canonicalUrl.slice(0,80)} → [${merged.join(',')}]`);
            continue;
          }

          // Also check raw URL for seeds already in seenUrls
          const normUrl = String(r.url||'').split('?')[0].toLowerCase();
          if (seenUrls.has(normUrl) || seenUrls.has(canonicalUrl)) {
            // Already seeded — just merge tags
            const existingByCanon = canonicalToCandidate.get(canonicalUrl);
            if (existingByCanon) existingByCanon.agentTags = [...new Set([...(existingByCanon.agentTags||[]), ...agentTags])];
            continue;
          }
          seenUrls.add(normUrl);
          seenUrls.add(canonicalUrl);
          if (urlAliases.length) urlAliases.forEach(a => seenUrls.add(a.split('?')[0].toLowerCase()));

          const isPdf = String(r.url||'').toLowerCase().endsWith('.pdf') || /\/open$|download\?attachment|\/media\/\d+\/download/.test(String(r.url||''));
          let authority = 'Web';
          try {
            const host = new URL(r.url).hostname;
            if (/usace\.army\.mil/.test(host)) authority = 'USACE';
            else if (/epa\.gov|nepis/.test(host)) authority = 'EPA';
            else if (/usgs\.gov/.test(host)) authority = 'USGS';
            else if (/dnr\.sc\.gov/.test(host)) authority = 'SCDNR';
            else if (/ncwildlife\.gov|ncwildlife\.org/.test(host)) authority = 'NCWRC';
            else if (/georgiawildlife\.com/.test(host)) authority = 'GADNR';
            else if (/tn\.gov/.test(host)) authority = 'TWRA';
            else if (/eregulations\.com/.test(host)) authority = dnrName;
            else if (/carolinasportsman|anglersheadquarters|gameandfishmag|takemefishing|santeecoopercountry|lakemartinvoice|visitlakelanier|lakelanier|visitfloridakeys|visitnc|scprt|southcarolinaparks/.test(host)) authority = 'Fishing Guide';
            else if (/grokipedia\.com/.test(host)) authority = 'Grokipedia';
          } catch {}

          queryLog.push(`  ✓ found (score ${prefetchScore}): ${(r.title||r.url).slice(0,80)}`);

          const fullCandidate = {
            ...candidate,
            type: isPdf ? 'PDF' : 'HTML',
            authority,
            priority: 2,
            prefetchScore,
            fullText: r.markdown || r.content || null,
            agentTags: [...agentTags],
            discoveredBy: agentKey,
          };
          canonicalToCandidate.set(canonicalUrl, fullCandidate);
          discoveredSources.push(fullCandidate);
        }
      } catch (err) {
        console.warn(`Search failed for [${agentKey}] [${q.slice(0,80)}]: ${err.message}`);
      }
    }
  }

  // ── STEP 4: Combine, sort, return ────────────────────────────────────────
  let finalList = [...guaranteedSeeds, ...discoveredSources];
  finalList.sort((a,b) => (a.priority - b.priority) || ((b.score||0) - (a.score||0)));

  // Add agentTags to guaranteed seeds based on what they're relevant for
  for (const seed of guaranteedSeeds) {
    if (!seed.agentTags) {
      if (/SCDNR|NCWRC|GADNR|TWRA|eregulations/i.test(seed.authority || seed.url || '')) {
        seed.agentTags = ['regulations', 'identity', 'navigation', 'habitat'];
      } else if (/Grokipedia/i.test(seed.authority)) {
        seed.agentTags = ['identity', 'limnology', 'biology', 'habitat', 'navigation'];
      } else if (/EPA|USGS|USACE|Duke Energy|FERC/i.test(seed.authority)) {
        seed.agentTags = ['identity', 'limnology'];
      } else {
        seed.agentTags = ['general'];
      }
    }
  }

  // Fallback if nothing found
  if (finalList.length === 0) {
    finalList = [
      { title: `${lakeName} SCDNR Lakes Information`, type: 'HTML', authority: 'SCDNR', url: `https://www.dnr.sc.gov/lakes/${baseLower}/description.html`, priority: 1 },
      { title: regsTitle, type: 'HTML', authority: dnrName, url: regsUrl, priority: 1 },
    ];
  }

  return new Response(JSON.stringify({ success: true, sources: finalList, baseName, filteredCount: 0, queryLog }), { headers: JSON_HEADERS });
}


async function handleResearchProxyDownload(request, env) {
  const url = new URL(request.url);
  const target = url.searchParams.get("url");
  const sourceType = url.searchParams.get("type") || ""; // "PDF" or "HTML"
  if (!target) {
    return new Response(JSON.stringify({ success: false, error: "Missing url parameter" }), { status: 400, headers: JSON_HEADERS });
  }

  // Ensure custom response headers (X-Source, X-Nepis-*) are readable by the
  // browser. Cloudflare blocks non-safelisted headers on cross-origin responses
  // unless Access-Control-Expose-Headers explicitly names them.
  const exposeHeaders = (headers) => {
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Expose-Headers', 'X-Source, X-Nepis-Format, X-Nepis-Title, X-Nepis-Doc-Url, X-Nepis-RawText, X-Nepis-Pdf, X-Nepis-Doc-Count, X-Nepis-Documents, ETag, Last-Modified');
    return headers;
  };

  // Hard-block Florida lake databases for non-Florida states
  if (/wateratlas\.usf\.edu/i.test(target)) {
    const stateParam = url.searchParams.get('state') || '';
    // WaterAtlas is a Florida-only lake database — never relevant for SC/NC/GA/TN lakes
    console.log(`Blocked WaterAtlas (Florida lake DB) for non-Florida lake: ${target}`);
    return new Response(JSON.stringify({ success: false, error: 'WaterAtlas is Florida-only, not relevant for this lake' }), { status: 403, headers: JSON_HEADERS });
  }

  // Hard-block known wrong-lake NEPIS documents before wasting a Firecrawl credit
  const nepisIdMatch = target.match(/\/([A-Z0-9]{6,12})\.txt/i);
  if (nepisIdMatch && KNOWN_BAD_NEPIS_IDS.has(nepisIdMatch[1].toUpperCase())) {
    console.log(`Blocked known-bad NEPIS doc in proxy-download: ${nepisIdMatch[1]}`);
    return new Response(JSON.stringify({ success: false, error: `Blocked known-bad NEPIS document: ${nepisIdMatch[1]}` }), { status: 403, headers: JSON_HEADERS });
  }

  // Route HTML sources through Firecrawl ONLY for JS-rendered SPAs and NEPIS pages.
  // CREDIT BUDGET:
  // - NEPIS/eRegulations/Grokipedia → Firecrawl (custom logic, SPA rendering, NEPIS two-step)
  // - All other HTML → Jina Reader (r.jina.ai) — free 10M token pool, 0 Firecrawl credits
  // - PDFs → basic fetch → browser PDF.js (unchanged)
  const firecrawlKey = env.FIRECRAWL_API_KEY || env.FIRECRAWL_KEY;
  const jinaKey = env.JINA_API_KEY || null;
  const isHtml = sourceType.toUpperCase() === 'HTML' || (!target.toLowerCase().includes('.pdf') && !sourceType.toUpperCase().includes('PDF'));
  // EPA NSCEP / NEPIS ZyNET:
  //  - Search results page (ZyActionS) — harvest document links
  //  - Document landing (ZyActionD) — extract raw-text / PDF format links
  const isNepisSearch = /nepis\.epa\.gov/i.test(target) && /[?&]ZyAction=ZyActionS\b/i.test(target);
  const isNepisLanding = /nepis\.epa\.gov/i.test(target) && (/[?&]ZyAction=ZyActionD\b/i.test(target) || /zypdf\.cgi/i.test(target) || /ZyPURL\.cgi/i.test(target));
  const isNepisAny = /nepis\.epa\.gov|ZyNET\.exe/i.test(target);
  // Pages that MUST stay on Firecrawl: NEPIS (custom two-step), eRegulations (React SPA needs
  // waitFor:3000 to render table rows), Grokipedia (JS-rendered)
  const needsFirecrawl = isNepisSearch || isNepisLanding || isNepisAny;

  if (firecrawlKey && isHtml && needsFirecrawl) {
    try {
      // Search-results page: return markdown of the results list so the client can
      // store it, AND surface ZyActionD links in X-Nepis-Documents for follow-up.
      if (isNepisSearch) {
        const scrapeRes = await fetch('https://api.firecrawl.dev/v2/scrape', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${firecrawlKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: target,
            formats: ['links', 'markdown'],
            onlyMainContent: true,
            timeout: 120000
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
                      const headers = exposeHeaders(new Headers({
                        'Content-Type': 'text/plain; charset=utf-8',
                        'X-Source': 'firecrawl',
                        'X-Nepis-Format': 'raw_text',
                        'X-Nepis-Title': title.slice(0, 180),
                        'X-Nepis-Doc-Url': docUrl,
                        'X-Nepis-RawText': rawTextUrl
                      }));
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
            const headers = exposeHeaders(new Headers({
              'Content-Type': 'text/plain; charset=utf-8',
              'X-Source': 'firecrawl',
              'X-Nepis-Format': 'search_results',
              'X-Nepis-Doc-Count': String(docLinks.length),
              // First few document URLs for client follow-up (header size limit)
              'X-Nepis-Documents': JSON.stringify(docLinks.slice(0, 5).map(d => d.url)).slice(0, 1500)
            }));
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
                const headers = exposeHeaders(new Headers({
                  'Content-Type': 'text/plain; charset=utf-8',
                  'X-Source': 'firecrawl',
                  'X-Nepis-Format': 'raw_text',
                  'X-Nepis-Title': title.slice(0, 180),
                  'X-Nepis-RawText': rawTextUrl
                }));
                return new Response(rawText, { headers });
              }
            }
          } catch (eRaw) {
            console.warn(`Direct NSCEP raw-text fetch failed: ${eRaw.message}`);
          }
        }

        const landRes = await fetch('https://api.firecrawl.dev/v2/scrape', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${firecrawlKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: target,
            formats: ['markdown', 'json'],
            onlyMainContent: true,
            timeout: 120000,
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
              const textRes = await fetch('https://api.firecrawl.dev/v2/scrape', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${firecrawlKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: rawTextUrl, formats: ['markdown'], onlyMainContent: true, timeout: 120000 })
              });
              if (textRes.ok) {
                const textData = await textRes.json();
                const markdown = textData.data?.markdown || textData.markdown || '';
                if (markdown && markdown.length > 100) {
                  const headers = exposeHeaders(new Headers({
                    'Content-Type': 'text/plain; charset=utf-8',
                    'X-Source': 'firecrawl',
                    'X-Nepis-Format': 'raw_text',
                    'X-Nepis-Title': title.slice(0, 180),
                    'X-Nepis-Pdf': pdfUrl || ''
                  }));
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
            const headers = exposeHeaders(new Headers({
              'Content-Type': 'text/plain; charset=utf-8',
              'X-Source': 'firecrawl',
              'X-Nepis-Format': 'landing',
              'X-Nepis-Title': title.slice(0, 180),
              'X-Nepis-Pdf': pdfUrl || '',
              'X-Nepis-RawText': rawTextUrl || ''
            }));
            return new Response(landMd, { headers });
          }
        }
      }

      // Standard Firecrawl markdown scrape for HTML pages (eRegulations, SCDNR, etc.)
      // waitFor helps JS-rendered SPAs like eRegulations populate table rows.
      // maxAge: static agency pages (SCDNR descriptions, eRegulations) rarely change —
      // if Firecrawl has a cached version < 7 days old it returns it for 0 additional credits.
      const isSpa = false; // eRegulations removed — no SPA sources remain in this path
      const isStaticAgencyPage = /dnr\.sc\.gov\/lakes|ncwildlife\.org|georgiawildlife\.com/i.test(target);
      const fcRes = await fetch('https://api.firecrawl.dev/v2/scrape', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${firecrawlKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: target,
          formats: ['markdown'],
          onlyMainContent: true,
          waitFor: isSpa ? 6000 : 0,  // eRegulations React SPA needs extra render time
          timeout: 25000,
          ...(isStaticAgencyPage ? { maxAge: 604800000 } : {}) // 7-day cache for stable pages
        })
      });
      if (fcRes.ok) {
        const fcData = await fcRes.json();
        const markdown = fcData.data?.markdown || fcData.markdown || '';
        if (markdown && markdown.length > 100) {
          // Return as text/plain so lake-research.js can use it directly without pdf.js
          const headers = exposeHeaders(new Headers({ 'Content-Type': 'text/plain; charset=utf-8', 'X-Source': 'firecrawl' }));
          return new Response(markdown, { headers });
        }
      }
      // Fall through to basic fetch if Firecrawl fails
    } catch (e) {
      console.warn(`Firecrawl failed for ${target}: ${e.message} — falling back to basic fetch`);
    }
  }

  // ── TinyFish Fetch for ordinary HTML and PDF documents ──────────────────
  // TinyFish can extract PDF text directly as well as render HTML. Trying it
  // before streaming a PDF avoids browser-side binary parsing and gives the
  // evidence pipeline normalized text. Reserved SPA/NEPIS pages retain their
  // custom Firecrawl handling. If extraction is insufficient, fall through to
  // the existing HTML fallbacks or the direct binary fetch for PDFs.
  if (!needsFirecrawl) {
    let tfSucceeded = false;
    try {
      const tfResult = await tinyfishFetch({
        urls: [target],
        format: 'markdown',
        ...(isHtml ? {
          include_selectors: ['main', 'article', '.content', '#main-content'],
          exclude_selectors: ['nav', 'footer', '.sidebar', '.ads', 'script', 'style']
        } : {}),
        ttl: 86400
      }, env);
      const markdown = tfResult.results[0]?.text || '';
      if (tfResult.errors?.length) {
        for (const err of tfResult.errors) {
          console.warn(`TinyFish fetch error for ${err.url}: ${err.error}`);
        }
      }
      if (markdown && markdown.length > 200) {
        tfSucceeded = true;
        const headers = exposeHeaders(new Headers({
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Source': 'tinyfish'
        }));
        return new Response(markdown, { headers });
      }
      console.warn(`TinyFish insufficient content (${markdown.length} chars) for ${target} — trying Firecrawl`);
    } catch (tfErr) {
      console.warn(`TinyFish error for ${target}: ${tfErr.message} — trying Firecrawl`);
    }

    // Scrape.do fallback — Cloudflare bypass, residential proxies, 1 credit/page
    // Only fires when TinyFish returned insufficient content. Failed requests cost 0.
    let scrapeDoSucceeded = false;
    if (!tfSucceeded && isHtml) {
      try {
        // Use render=true for known JS-heavy domains, plain fetch for everything else
        const needsRender = /anglersheadquarters|majorleaguefishing|omniafishing|carolinasportsman|gameandfishmag/i.test(target);
        const sdText = await scrapeDoFetch(target, env, { render: needsRender });
        if (sdText && sdText.length > 200) {
          scrapeDoSucceeded = true;
          const headers = exposeHeaders(new Headers({
            'Content-Type': 'text/plain; charset=utf-8',
            'X-Source': 'scrapedo'
          }));
          return new Response(sdText, { headers });
        }
        console.warn(`Scrape.do returned insufficient content (${sdText?.length || 0} chars) for ${target} — trying Firecrawl`);
      } catch (sdErr) {
        console.warn(`Scrape.do error for ${target}: ${sdErr.message} — trying Firecrawl`);
      }
    }

    // Firecrawl fallback — only when both TinyFish and Scrape.do failed and budget allows
    if (isHtml && !tfSucceeded && !scrapeDoSucceeded && firecrawlKey) {
      try {
        const budget = await checkFirecrawlBudget(env, 1);
        if (budget.allowed) {
          const fcRes = await fetch('https://api.firecrawl.dev/v2/scrape', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${firecrawlKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: target,
              formats: ['markdown'],
              onlyMainContent: true,
              timeout: 25000,
            })
          });
          if (fcRes.ok) {
            const fcData = await fcRes.json();
            const markdown = fcData.data?.markdown || fcData.markdown || '';
            if (markdown && markdown.length > 200) {
              await recordFirecrawlUsage(env, 1);
              const headers = exposeHeaders(new Headers({
                'Content-Type': 'text/plain; charset=utf-8',
                'X-Source': 'firecrawl-fallback'
              }));
              return new Response(markdown, { headers });
            }
          }
          console.warn(`Firecrawl fallback also failed for ${target} — trying Jina`);
        } else {
          console.warn(`Firecrawl budget exhausted — skipping fallback for ${target}, trying Jina`);
        }
      } catch (fcErr) {
        console.warn(`Firecrawl fallback error for ${target}: ${fcErr.message} — trying Jina`);
      }
    }

    // Jina Reader — last resort before basic fetch (HTML only)
    if (isHtml) try {
      const jinaUrl = `https://r.jina.ai/${target}`;
      const jinaHeaders = {
        'Accept': 'text/plain',
        'X-Return-Format': 'markdown',
        'X-No-Cache': 'false',
        'X-Remove-Selector': 'nav, footer, .sidebar, #ads, .advertisement, .cookie-banner',
      };
      if (jinaKey) jinaHeaders['Authorization'] = `Bearer ${jinaKey}`;
      const jinaRes = await fetch(jinaUrl, { headers: jinaHeaders });
      if (jinaRes.ok) {
        const markdown = await jinaRes.text();
        if (markdown && markdown.length > 200) {
          const headers = exposeHeaders(new Headers({
            'Content-Type': 'text/plain; charset=utf-8',
            'X-Source': 'jina'
          }));
          return new Response(markdown, { headers });
        }
      }
      console.warn(`Jina Reader failed for ${target}: HTTP ${jinaRes.status} — falling back to basic fetch`);
    } catch (e) {
      console.warn(`Jina Reader error for ${target}: ${e.message} — falling back to basic fetch`);
    }
  }

  // ── USACE-specific Scrape.do PDF fallback ───────────────────────────────────
  // Per section 12.7: shared cache -> TinyFish -> direct Worker fetch ->
  // Scrape.do GET (USACE only). Firecrawl not attempted for USACE unless Scrape.do
  // also fails and source is explicitly high-priority (not implemented here).
  if (!isHtml && /usace\.army\.mil|\.usace\.army\.mil/i.test(target)) {
    const scrapeToken = env.SCRAPEDO_API_KEY;
    if (scrapeToken) {
      try {
        const sdRes = await fetch(`https://api.scrape.do/?token=${scrapeToken}&url=${encodeURIComponent(target)}`, {
          headers: { 'Accept': 'application/pdf,*/*' }
        });
        const remaining = sdRes.headers.get('Scrape.do-Remaining-Credits');
        const cost = sdRes.headers.get('Scrape.do-Request-Cost');
        if (remaining) console.log(`[scrape.do USACE PDF] cost=${cost} remaining=${remaining} url=${target.slice(0,80)}`);
        if (sdRes.ok) {
          const sdHeaders = exposeHeaders(new Headers(sdRes.headers));
          sdHeaders.set('X-Source', 'scrapedo-usace');
          return new Response(sdRes.body, { headers: sdHeaders });
        }
        console.warn(`Scrape.do USACE PDF fallback HTTP ${sdRes.status} for ${target}`);
      } catch (sdErr) {
        console.warn(`Scrape.do USACE PDF fallback error for ${target}: ${sdErr.message}`);
      }
    }
  }

  // ── NRC-specific Firecrawl PDF fallback ─────────────────────────────────────
  // Per section 12.7: TinyFish fails for NRC; direct Worker returns 403; Scrape.do
  // also fails. Firecrawl succeeds. Narrowly scoped — only fires for nrc.gov after
  // all cheaper paths fail.
  if (!isHtml && /nrc\.gov/i.test(target) && firecrawlKey) {
    try {
      const nrcBudget = await checkFirecrawlBudget(env, 1);
      if (nrcBudget.allowed) {
        const nrcRes = await fetch('https://api.firecrawl.dev/v2/scrape', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${firecrawlKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: target, formats: ['markdown'], onlyMainContent: true, timeout: 30000 })
        });
        if (nrcRes.ok) {
          const nrcData = await nrcRes.json();
          const nrcText = nrcData.data?.markdown || nrcData.markdown || '';
          if (nrcText && nrcText.length > 200) {
            await recordFirecrawlUsage(env, 1);
            console.log(`[firecrawl NRC PDF] success (${nrcText.length} chars): ${target.slice(0,80)}`);
            return new Response(nrcText, { headers: exposeHeaders(new Headers({ 'Content-Type': 'text/plain; charset=utf-8', 'X-Source': 'firecrawl-nrc' })) });
          }
        }
      } else {
        console.warn(`Firecrawl budget exhausted — skipping NRC PDF fallback for ${target}`);
      }
    } catch (nrcErr) {
      console.warn(`Firecrawl NRC PDF fallback error for ${target}: ${nrcErr.message}`);
    }
  }

  // ── Basic fetch (PDF binary → client runs PDF.js; HTML final fallback) ───────
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

    const headers = exposeHeaders(new Headers(response.headers));
    return new Response(response.body, { headers });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 502, headers: JSON_HEADERS });
  }
}

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


function normalizeResearchName(s) {
  return String(s || '').toLowerCase().replace(/&amp;/g, '&').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function hasResearchValue(v) {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

function buildEvidence(sourceType, sourceLabel, sourceUrl, quote, method, extra = {}) {
  return { sourceType, sourceLabel, sourceUrl, quote: quote || null, method, ...extra };
}

function titleCaseWords(s) {
  return String(s || '').split(/\s+/).filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

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

// Species that must never appear in predatorSpecies regardless of doc content
// Includes protected/endangered species, non-game fish, and forage/baitfish
const NON_GAME_SPECIES = new Set([
  'shortnose sturgeon', 'atlantic sturgeon', 'lake sturgeon', 'pallid sturgeon',
  'paddlefish', 'american eel', 'lamprey', 'sea lamprey',
  'threadfin shad', 'gizzard shad', 'blueback herring', 'american shad', 'alewife',
  'carp', 'common carp', 'bighead carp', 'silver carp', 'grass carp',
  'corbicula', 'asian clam', 'zebra mussel',
  'gar', 'longnose gar', 'spotted gar', 'alligator gar',
  'drum', 'freshwater drum', 'buffalo', 'bigmouth buffalo', 'smallmouth buffalo',
  'sucker', 'white sucker', 'redhorse',
]);

function uniqueResearchSpecies(items) {
  const out = [];
  const seen = new Set();
  for (const raw of items || []) {
    const s = canonicalizeResearchSpecies(raw);
    if (!s) continue;
    const key = normalizeResearchName(s);
    if (seen.has(key)) continue;
    if (NON_GAME_SPECIES.has(key)) continue; // never add non-game/protected/baitfish
    seen.add(key);
    out.push(s);
  }
  return out;
}

function splitSpeciesText(text) {
  const cleaned = String(text || '').replace(/\([^)]*\)/g, ' ').replace(/\band\b/gi, ',').replace(/;/g, ',');
  return cleaned.split(',').map(s => s.trim()).filter(Boolean);
}

async function parseSCDNRDescriptionFacts(lakeName, url, html, env) {
  const text = stripHtmlPreserveTables(html).replace(/\s+/g, ' ').trim();
  const systemPrompt = "You are an expert South Carolina biology and DNR document parser.\n" +
"Extract the following lake facts and details from the provided South Carolina DNR lake description page text.\n\n" +
"For each field, extract:\n" +
"1. The extracted 'value' (adhering to the specified type: number, string, array, etc.).\n" +
"2. The exact 'quote' from the text supporting this extraction.\n\n" +
"JSON Schema to return:\n" +
"{\n" +
"  \"surfaceAreaAcres\": { \"value\": <number|null>, \"quote\": <string|null> },\n" +
"  \"shorelineLengthMi\": { \"value\": <number|null>, \"quote\": <string|null> },\n" +
"  \"counties\": { \"value\": <array of strings>, \"quote\": <string|null> },\n" +
"  \"reservoirOwner\": { \"value\": <string|null>, \"quote\": <string|null> },\n" +
"  \"normalPoolFt\": { \"value\": <number|null>, \"quote\": <string|null> },\n" +
"  \"yearImpounded\": { \"value\": <number|null>, \"quote\": <string|null> },\n" +
"  \"damName\": { \"value\": <string|null>, \"quote\": <string|null> },\n" +
"  \"riverSystem\": { \"value\": <string|null>, \"quote\": <string|null> },\n" +
"  \"archetype\": { \"value\": <string|null>, \"quote\": <string|null> },\n" +
"  \"predatorSpecies\": { \"value\": <array of strings>, \"quote\": <string|null> },\n" +
"  \"knownStockings\": { \"value\": [ { \"species\": <string>, \"agency\": \"SCDNR\", \"note\": <string> } ], \"quote\": <string|null> },\n" +
"  \"attractorCount\": { \"value\": <number|null>, \"quote\": <string|null> },\n" +
"  \"accessPointCount\": { \"value\": <number|null>, \"quote\": <string|null> },\n" +
"  \"publicRampCount\": { \"value\": <number|null>, \"quote\": <string|null> },\n" +
"  \"privateAccessCount\": { \"value\": <number|null>, \"quote\": <string|null> }\n" +
"}\n\n" +
"Notes for extraction rules:\n" +
"- SCDNR description page lists pool elevation as \"Maximum Depth\" and average river depth as \"Average Depth\" — both are misleading and not the actual lake depth. Do not parse these fields into any depth field.\n" +
"- \"counties\" should be the counties within which the lake is located (e.g. [\"Kershaw\", \"Fairfield\", \"Lancaster\"]).\n" +
"- \"predatorSpecies\" are popular sport fish mentioned (e.g. [\"Striped Bass\", \"Largemouth Bass\", \"Crappie\", \"Catfish\"]).\n" +
"- Respond ONLY with valid, raw JSON. Do not include markdown formatting or backticks.";

  const userPrompt = `Lake Name: ${lakeName}\nUrl: ${url}\nText Content:\n${text.slice(0, 12000)}`;

  const identity = { aliases: [], counties: [] };
  const biology = { primaryForage: [], secondaryForage: [], predatorSpecies: [], speciesAbundance: {}, knownStockings: [], baitfishMovement: null, forageCalendar: {}, notes: [] };
  const habitat = { structuralElements: {}, cover: [], vegetation: [], standingTimber: null, dockDensity: null, riprapLocations: [], namedCreekMouths: [], timberFields: null, shallowFlatAreas: null, artificialHabitat: [], artificialHabitatDetails: { attractorCount: null, attractorTypes: [] }, notes: null };
  const navigation = { ramps: [], hazards: [], notes: null, accessPointCount: null, publicRampCount: null, privateAccessCount: null };
  const evidence = { identity: {}, biology: {}, habitat: {}, navigation: {} };

  const store = (section, field, entry) => {
    if (!evidence[section]) evidence[section] = {};
    if (!evidence[section][field]) evidence[section][field] = [];
    evidence[section][field].push(entry);
  };

  try {
    const llmResult = await callLLM(env, {
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      max_tokens: 1500,
      temperature: 0.1,
      response_format: { type: 'json_object' }
    });
    const llmText = extractLLMText(llmResult.data).replace(/`{3}(json)?/g, '').trim();
    const parsed = JSON.parse(llmText);

    if (parsed) {
      // 1. Identity
      if (parsed.surfaceAreaAcres?.value != null) {
        identity.surfaceAreaAcres = parsed.surfaceAreaAcres.value;
        if (parsed.surfaceAreaAcres.quote) {
          store('identity', 'surfaceAreaAcres', buildEvidence('official_document', 'SCDNR Lake Description', url, parsed.surfaceAreaAcres.quote, 'llm_extraction'));
        }
      }
      if (parsed.shorelineLengthMi?.value != null) {
        identity.shorelineLengthMi = parsed.shorelineLengthMi.value;
        if (parsed.shorelineLengthMi.quote) {
          store('identity', 'shorelineLengthMi', buildEvidence('official_document', 'SCDNR Lake Description', url, parsed.shorelineLengthMi.quote, 'llm_extraction'));
        }
      }
      if (Array.isArray(parsed.counties?.value) && parsed.counties.value.length) {
        identity.counties = parsed.counties.value;
        if (parsed.counties.quote) {
          store('identity', 'counties', buildEvidence('official_document', 'SCDNR Lake Description', url, parsed.counties.quote, 'llm_extraction'));
        }
      }
      if (parsed.reservoirOwner?.value) {
        identity.reservoirOwner = parsed.reservoirOwner.value;
        if (parsed.reservoirOwner.quote) {
          store('identity', 'reservoirOwner', buildEvidence('official_document', 'SCDNR Lake Description', url, parsed.reservoirOwner.quote, 'llm_extraction'));
        }
      }
      if (parsed.normalPoolFt?.value != null) {
        identity.normalPoolFt = parsed.normalPoolFt.value;
        if (parsed.normalPoolFt.quote) {
          store('identity', 'normalPoolFt', buildEvidence('official_document', 'SCDNR Lake Description', url, parsed.normalPoolFt.quote, 'llm_extraction'));
        }
      }
      if (parsed.yearImpounded?.value != null) {
        identity.yearImpounded = parsed.yearImpounded.value;
        if (parsed.yearImpounded.quote) {
          store('identity', 'yearImpounded', buildEvidence('official_document', 'SCDNR Lake Description', url, parsed.yearImpounded.quote, 'llm_extraction'));
        }
      }
      if (parsed.damName?.value) {
        identity.damName = parsed.damName.value;
        if (parsed.damName.quote) {
          store('identity', 'damName', buildEvidence('official_document', 'SCDNR Lake Description', url, parsed.damName.quote, 'llm_extraction'));
        }
      }
      if (parsed.riverSystem?.value) {
        identity.riverSystem = parsed.riverSystem.value;
        if (parsed.riverSystem.quote) {
          store('identity', 'riverSystem', buildEvidence('official_document', 'SCDNR Lake Description', url, parsed.riverSystem.quote, 'llm_extraction'));
        }
      }
      if (parsed.archetype?.value) {
        identity.archetype = parsed.archetype.value;
        if (parsed.archetype.quote) {
          store('identity', 'archetype', buildEvidence('official_document', 'SCDNR Lake Description', url, parsed.archetype.quote, 'llm_extraction'));
        }
      }

      // 2. Biology
      if (Array.isArray(parsed.predatorSpecies?.value) && parsed.predatorSpecies.value.length) {
        biology.predatorSpecies = uniqueResearchSpecies(parsed.predatorSpecies.value);
        if (parsed.predatorSpecies.quote) {
          store('biology', 'predatorSpecies', buildEvidence('official_document', 'SCDNR Lake Description', url, parsed.predatorSpecies.quote, 'llm_extraction'));
        }
      }
      if (Array.isArray(parsed.knownStockings?.value) && parsed.knownStockings.value.length) {
        biology.knownStockings = parsed.knownStockings.value;
        if (parsed.knownStockings.quote) {
          store('biology', 'knownStockings', buildEvidence('official_document', 'SCDNR Lake Description', url, parsed.knownStockings.quote, 'llm_extraction'));
        }
      }

      // 3. Habitat
      if (parsed.attractorCount?.value != null) {
        habitat.artificialHabitat = ['SCDNR fish attractors'];
        habitat.artificialHabitatDetails.attractorCount = parsed.attractorCount.value;
        const note = `s${parsed.attractorCount.value} official SCDNR fish attractors listed on the lake page.`;
        habitat.notes = note;
        if (parsed.attractorCount.quote) {
          store('habitat', 'artificialHabitatDetails', buildEvidence('official_document', 'SCDNR Lake Description', url, parsed.attractorCount.quote, 'llm_extraction'));
        }
      }

      // 4. Navigation
      if (parsed.accessPointCount?.value != null) {
        navigation.accessPointCount = parsed.accessPointCount.value;
        if (parsed.accessPointCount.quote) {
          store('navigation', 'accessPointCount', buildEvidence('official_document', 'SCDNR Lake Description', url, parsed.accessPointCount.quote, 'llm_extraction'));
        }
      }
      if (parsed.publicRampCount?.value != null) {
        navigation.publicRampCount = parsed.publicRampCount.value;
        if (parsed.publicRampCount.quote) {
          store('navigation', 'publicRampCount', buildEvidence('official_document', 'SCDNR Lake Description', url, parsed.publicRampCount.quote, 'llm_extraction'));
        }
      }
      if (parsed.privateAccessCount?.value != null) {
        navigation.privateAccessCount = parsed.privateAccessCount.value;
        if (parsed.privateAccessCount.quote) {
          store('navigation', 'privateAccessCount', buildEvidence('official_document', 'SCDNR Lake Description', url, parsed.privateAccessCount.quote, 'llm_extraction'));
        }
      }
    }
  } catch (err) {
    console.error(`LLM SCDNR Description Fact extraction failed: ${err.message}`);
  }

  return { identity, biology, habitat, navigation, evidence, sources: [{ label: 'SCDNR Lake Description', url, trust: 'OFFICIAL', sourceType: 'official_document' }] };
}

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
  },
  TN: {
    url: "https://services3.arcgis.com/PWXNAH2YKmZY7lBq/arcgis/rest/services/Boat_Launch_Sites/FeatureServer/0/query",
    label: 'Tennessee Wildlife Resources Agency Boat Launch Sites',
    idField: 'OBJECTID',
    filter: (p) => p.Type === 'Boat Launch' && String(p.IncludeWeb || '').toLowerCase() === 'yes' && !/^(none|0)$/i.test(String(p.Ramps || '')),
    name: (p) => p.Name,
    wb: (p) => p.Waterway,
    lat: (p) => p.Latitude,
    lon: (p) => p.Longitude,
    meta: (p) => ({ lanes: p.Lanes, dock: String(p.CourtesyDock || '').toLowerCase() === 'yes', fee: String(p.AccessFee || '').toLowerCase() === 'yes', species: '', county: p.County, owner: p.Owner, launchable: p.Launchable })
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
  },
  TN: {
    url: "https://services3.arcgis.com/PWXNAH2YKmZY7lBq/arcgis/rest/services/Fish_Attractor_Locations_view/FeatureServer/0/query",
    label: 'Tennessee Wildlife Resources Agency Fish Attractors',
    idField: 'OBJECTID',
    filter: () => true,
    name: (p) => p.Site_Name || (p.Embayment ? `${p.WaterBody} - ${p.Embayment}` : `${p.WaterBody} Attractor`),
    wb: (p) => p.WaterBody,
    lat: (p) => p.YLat,
    lon: (p) => p.XLong,
    type: (p) => [p.StructureTypes, p.Artificial, p.Natural_].filter(Boolean).join(', ') || 'Unknown'
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

function waterbodyMatchesLake(lakeName, waterbodyName) {
  const a = normalizeResearchName(lakeName).replace(/^lake /, '');
  const b = normalizeResearchName(waterbodyName).replace(/^lake /, '');
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
}


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

// Slice PDF.js extracted text to a page range using --- PAGE n --- markers.
// Used to extract only the relevant section from large combined PDF guides.
function slicePdfPageRange(text, startPage, endPage) {
  if (!text) return text;
  const lines = text.split('\n');
  const result = [];
  let inRange = false;
  for (const line of lines) {
    const pageMatch = line.match(/^---\s*PAGE\s*(\d+)\s*---$/i);
    if (pageMatch) {
      const pageNum = parseInt(pageMatch[1], 10);
      inRange = pageNum >= startPage && pageNum <= endPage;
    }
    if (inRange) result.push(line);
  }
  // If no PAGE markers found (e.g. TinyFish returned plain text), return full text
  return result.length > 0 ? result.join('\n') : text;
}

async function parseSCRegulationsFromHtml(lakeName, regsUrl, html, lakeSpecificHtml = '', env) {
  const systemPrompt = "You are an expert South Carolina freshwater fisheries regulation parser.\n" +
"Your task is to extract size and creel (possession) limits from South Carolina's official freshwater fishing regulations (SCDNR regulations booklet, pages 18-43).\n\n" +
"Extract both:\n" +
"1. Statewide (general) regulations.\n" +
"2. Lake-specific regulations / exceptions for the specified lake body.\n\n" +
"JSON Schema to return:\n" +
"{\n" +
"  \"lastUpdated\": <string|null>,\n" +
"  \"generalStateRegulations\": {\n" +
"    \"lengthLimits\": {\n" +
"       // mapping of species to exact size limit strings, e.g. \"No limit\" or \"14 inch minimum\"\n" +
"    },\n" +
"    \"creelLimits\": {\n" +
"       // mapping of species to creel limit strings, e.g. \"15 per day\" or \"5 per day\"\n" +
"    }\n" +
"  },\n" +
"  \"lakeSpecificRegulations\": {\n" +
"    \"hasExceptions\": <boolean|null>,\n" +
"    \"sizeLimits\": {\n" +
"       // species exceptions for this specific lake\n" +
"    },\n" +
"    \"creelLimits\": {\n" +
"       // creel exceptions for this specific lake\n" +
"    },\n" +
"    \"specialRules\": [\n" +
"       // array of special regulation rules or notes for this lake\n" +
"    ],\n" +
"    \"closedSeasons\": [\n" +
"       // array of objects like { \"species\": <string>, \"period\": <string>, \"note\": <string> }\n" +
"    ]\n" +
"  },\n" +
"  \"evidence\": {\n" +
"     // For any extracted regulation, map the field path (e.g. \"general.Crappie\" or \"lakeSpecific.Largemouth Bass\") to the exact matching text row/sentence quote as a string\n" +
"  }\n" +
"}\n\n" +
"Species names should be canonicalized to match:\n" +
"\"Crappie\", \"Bream\", \"Redbreast Sunfish\", \"Chain Pickerel\", \"Redfin Pickerel\", \"Yellow Perch\", \"Blue Catfish\", \"American Eel\", \"Walleye / Sauger\", \"White Bass\", \"Smallmouth Bass\", \"Redeye Bass\", \"Spotted Bass\", \"Largemouth Bass\", \"Striped Bass / Hybrid\"\n\n" +
"Special Rules:\n" +
"- If the lake is listed as a Striper/Hybrid exception, capture it under lakeSpecificRegulations. If it's NOT explicitly listed, note that the statewide regulation applies.\n" +
"- Do NOT map Santee River system, Wateree Dam, or Cooper River rules as lake exceptions unless they explicitly refer to the reservoir body itself.\n" +
"- Respond ONLY with valid, raw JSON. Do not include markdown formatting or backticks.";

  const cleanHtml = stripHtmlPreserveTables(html).replace(/\s+/g, ' ').trim();
  const cleanLakeHtml = stripHtmlPreserveTables(lakeSpecificHtml).replace(/\s+/g, ' ').trim();

  const userPrompt = `Lake Name: 	ext${lakeName}\nUrl: ${regsUrl}\nStatewide Text:\n${cleanHtml.slice(0, 15000)}\n\nLake-Specific Text:\n${cleanLakeHtml.slice(0, 8000)}`;

  const regs = {
    state: 'SC',
    lastUpdated: null,
    generalStateRegulations: { lengthLimits: {}, creelLimits: {} },
    lakeSpecificRegulations: { hasExceptions: null, creelLimits: {}, sizeLimits: {}, specialRules: [], closedSeasons: [] },
    notes: 'Always verify exact lake exceptions at official agency site before fishing.'
  };
  const evidence = { regulations: {} };

  try {
    const llmResult = await callLLM(env, {
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      max_tokens: 2000,
      temperature: 0.1,
      response_format: { type: 'json_object' }
    });
    const llmText = extractLLMText(llmResult.data).replace(/`{3}(json)?/g, '').trim();
    const parsed = JSON.parse(llmText);

    if (parsed) {
      if (parsed.lastUpdated) regs.lastUpdated = parsed.lastUpdated;
      if (parsed.generalStateRegulations) {
        regs.generalStateRegulations.lengthLimits = parsed.generalStateRegulations.lengthLimits || {};
        regs.generalStateRegulations.creelLimits = parsed.generalStateRegulations.creelLimits || {};
      }
      if (parsed.lakeSpecificRegulations) {
        regs.lakeSpecificRegulations.hasExceptions = parsed.lakeSpecificRegulations.hasExceptions ?? null;
        regs.lakeSpecificRegulations.sizeLimits = parsed.lakeSpecificRegulations.sizeLimits || {};
        regs.lakeSpecificRegulations.creelLimits = parsed.lakeSpecificRegulations.creelLimits || {};
        regs.lakeSpecificRegulations.specialRules = parsed.lakeSpecificRegulations.specialRules || [];
        regs.lakeSpecificRegulations.closedSeasons = parsed.lakeSpecificRegulations.closedSeasons || [];
      }
      if (parsed.evidence) {
        for (const [key, quote] of Object.entries(parsed.evidence)) {
          evidence.regulations[key] = [buildEvidence('official_document', 'SCDNR / eRegulations', regsUrl, quote, 'llm_extraction')];
        }
      }
    }
  } catch (err) {
    console.error(`LLM eRegulations Fact extraction failed: ${err.message}`);
  }

  // Flatten convenience fields for UI/back-compat
  regs.lengthLimits = { ...regs.generalStateRegulations.lengthLimits, ...regs.lakeSpecificRegulations.sizeLimits };
  regs.creelLimits = { ...regs.generalStateRegulations.creelLimits, ...regs.lakeSpecificRegulations.creelLimits };

  return { regulations: regs, evidence, sources: [{ label: 'SCDNR / eRegulations', url: regsUrl, trust: 'OFFICIAL', sourceType: 'official_document' }] };
}

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
    habitat: { structuralElements: {}, cover: [], vegetation: [], standingTimber: null, dockDensity: null, riprapLocations: [], namedCreekMouths: [], timberFields: null, shallowFlatAreas: null, artificialHabitat: [], artificialHabitatDetails: { attractorCount: null, attractorTypes: [] }, notes: null },
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
        const parsed = await parseSCDNRDescriptionFacts(lakeName, descUrl, html, env);
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

  // Deterministic regulations from official pages — SC, NC, and GA
  // eRegulations is a JS-rendered React app — content is scraped via Firecrawl during
  // discovery and stored in normalized_documents.json. We parse those tables here.
  {
    const slug = lakeKeyFromName(lakeName);
    const regsUrl = state === 'NC'
      ? 'https://www.ncwildlife.gov/media/4600/download?attachment='
      : state === 'GA'
        ? 'https://georgiawildlife.com/sites/default/files/wrd/pdf/regulations/GA2026_Hunting&Fishing%20Regulations.pdf'
        : state === 'TN'
          ? 'https://www.tn.gov/twra/fishing-regs/statewide-creel-length-limits.html'
          : 'https://www.dnr.sc.gov/regs/pdf/25SCAB-PP2-RE.pdf';
    const lakeRegsUrl = state === 'SC' ? `https://www.dnr.sc.gov/lakes/${slug}/regs.html` : null;
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
          const regsDoc = normDocs.find(d => d.url && /dnr\.sc\.gov\/regs\/pdf|ncwildlife\.gov\/media\/4600|georgiawildlife\.com.*regulations|tn\.gov\/twra\/fishing-regs/i.test(d.url))
            || normDocs.find(d => d.url && /eregulations\.com/i.test(d.url)); // legacy fallback
          const lakeRegsDoc = state === 'SC'
            ? (normDocs.find(d => d.url && d.url.includes(`/lakes/${slug}/regs`))
              || normDocs.find(d => /lake.*regulations/i.test(d.title || '') && d.url && d.url.includes(slug)))
            : null;
          if (regsDoc?.fullText) {
            let text = regsDoc.fullText;
            // Slice SC regulations PDF to freshwater pages 18-43 only
            // Full booklet includes hunting/saltwater — we only need freshwater creel/size tables
            if (/dnr\.sc\.gov\/regs\/pdf/i.test(regsDoc.url || '')) {
              text = slicePdfPageRange(text, 18, 43);
            }
            // Slice GA regulations PDF to fishing section (approx pages 44-80)
            // Combined hunting/fishing guide — fishing section starts around page 44
            if (/georgiawildlife\.com.*regulations/i.test(regsDoc.url || '')) {
              text = slicePdfPageRange(text, 44, 85);
            }
            regsHtml = text;
          }
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

      // Live fetch fallback when normalized cache is empty (first run only).
      // SC: TinyFish can't fetch dnr.sc.gov PDF server-side — use Tavily extract
      //     (1 credit per 5 URLs, so ~1 credit). After first run the PDF content
      //     is cached client-side by the regulations agent and this never fires again.
      // NC/GA/TN: TinyFish handles their static HTML/PDF sources directly.
      if (!regsHtml) {
        try {
          if (state === 'SC') {
            const tavilyKey = env.TAVILY_API_KEY;
            if (tavilyKey) {
              const tvRes = await fetch('https://api.tavily.com/extract', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${tavilyKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ urls: [regsUrl], extract_depth: 'basic', format: 'markdown', include_images: false })
              });
              if (tvRes.ok) {
                const tvData = await tvRes.json();
                const raw = tvData.results?.[0]?.raw_content || '';
                if (raw && raw.length > 200) {
                  regsHtml = slicePdfPageRange(raw, 18, 43);
                  profile._regsDebug = { ...(profile._regsDebug || {}), liveTavily: true, regsHtmlLen: regsHtml.length };
                }
              }
            }
          } else {
            // NC/GA/TN — TinyFish handles these directly
            const tfRegs = await tinyfishFetch({ urls: [regsUrl], format: 'markdown', ttl: 604800 }, env);
            const md = tfRegs.results?.[0]?.text || '';
            if (md && md.length > 200) {
              let text = md;
              if (/georgiawildlife\.com.*regulations/i.test(regsUrl)) text = slicePdfPageRange(text, 44, 85);
              regsHtml = text;
              profile._regsDebug = { ...(profile._regsDebug || {}), liveTinyFish: true, regsHtmlLen: regsHtml.length };
            }
          }
        } catch (e) {
          console.warn(`live regs fetch failed for ${regsUrl}: ${e.message}`);
        }
      }

      // Fall back to direct fetch of lake-specific regs page (SC only — static HTML)
      if (!lakeRegsHtml && state === 'SC' && lakeRegsUrl) {
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
          // SC: use deterministic HTML parser. NC/GA: store raw text for agent extraction
          const parsedRegs = state === 'SC'
            ? await parseSCRegulationsFromHtml(lakeName, regsUrl, regsHtml || '', lakeRegsHtml || '', env)
            : { regulations: { state, rawRegsText: (regsHtml || '').slice(0, 8000) }, sources: [{ label: `${state} Freshwater Fishing Regulations`, url: regsUrl, authority: state === 'NC' ? 'NCWRC' : state === 'TN' ? 'TWRA' : 'GADNR', trust: 'OFFICIAL' }], evidence: {} };
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

async function handleResearchSaveNormalized(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || "").trim();
  const documents = body.documents || [];
  const agentTags = Array.isArray(body.agentTags) ? body.agentTags : []; // NEW: per-doc agent tags

  if (!lakeName || !documents.length) {
    return new Response(JSON.stringify({ success: false, error: "Missing lakeName or documents payload" }), { status: 400, headers: JSON_HEADERS });
  }

  const safe = sanitizeLakeId(lakeName);
  const key = `lake_packages/${safe}/normalized_documents.json`;

  // Relevance gate — reject docs with no mention of the lake name, base name, or state
  // Prevents off-lake docs (wrong state, wrong lake, tangential articles) from polluting
  // the normalized cache and causing false species extractions downstream
  const baseName = lakeName.replace(/^Lake\s+/i, '').replace(/,\s*(SC|NC|GA|TN)(\/(?:SC|NC|GA|TN))*\s*$/i, '').trim();
  const stateMatch = lakeName.match(/,\s*(SC|NC|GA|TN)/i);
  const state = stateMatch ? stateMatch[1].toUpperCase() : '';
  const searchTerms = [
    lakeName.toLowerCase(),
    baseName.toLowerCase(),
    ...(state ? [state.toLowerCase(), ` ${state.toLowerCase()} `, `${state.toLowerCase()} lake`, `lake ${baseName.toLowerCase()}`] : [])
  ];

  const filteredDocuments = documents.filter(doc => {
    const title = (doc.title || '').toLowerCase();
    const preview = (doc.fullText || doc.text || '').slice(0, 3000).toLowerCase();
    const url = (doc.url || '').toLowerCase();
    const combined = title + ' ' + url + ' ' + preview;

    // Must match BOTH lake name/base name AND state — prevents off-state lakes with same name
    // e.g. "Marion Lake, MN" passes lake name check but fails state check
    const lakeNameTerms = [lakeName.toLowerCase(), baseName.toLowerCase()];
    const stateTerms = state ? [
      ` ${state.toLowerCase()} `, `(${state.toLowerCase()})`,
      state.toLowerCase() + ' lake', 'south carolina', 'north carolina',
      'georgia', 'tennessee', 'santee', 'scdnr', 'ncwrc', 'gadnr'
    ] : [];

    const hasLakeName = lakeNameTerms.some(t => combined.includes(t));
    const hasState = !state || stateTerms.some(t => combined.includes(t));

    // Official/priority sources (eRegulations, SCDNR, EPA NSCEP, WQP, Grokipedia) pass automatically
    const isOfficialSource = /eregulations\.com|dnr\.sc\.gov|dnr\.nc\.gov|epd\.georgia|epa\.gov|waterqualitydata|grokipedia|santeecooper|ncwildlife|tw\.gov/i.test(url);

    return isOfficialSource || (hasLakeName && hasState);
  });

  // Add agentTags to each document if provided
  const docsWithTags = filteredDocuments.map((doc, i) => ({
    ...doc,
    agentTags: doc.agentTags || (agentTags[i] || []),
    discoveredBy: doc.discoveredBy || (agentTags[i] ? agentTags[i][0] : 'unknown'),
    fetchedAt: doc.fetchedAt || new Date().toISOString()
  }));

  const rejected = documents.length - filteredDocuments.length;
  if (rejected > 0) {
    console.log(`save-normalized [${lakeName}]: rejected ${rejected} off-lake doc(s) of ${documents.length} total`);
  }

  await env.R2_TROLLMAP_CHARTPACKS.put(key, JSON.stringify(docsWithTags, null, 2), {
    httpMetadata: { contentType: "application/json" }
  });

  return new Response(JSON.stringify({ success: true, key, saved: docsWithTags.length, rejected }), { headers: JSON_HEADERS });
}

async function handleResearchGetNormalized(env, lakeName) {
  const LEGACY_PROFILE_KEYS = {
    'lake_thurmond_sc':       'clarks_hill_thurmond_sc_ga',
    'clarks_hill_lake_ga':    'clarks_hill_thurmond_sc_ga',
    'j_strom_thurmond_lake':  'clarks_hill_thurmond_sc_ga',
    'thurmond_lake_sc':       'clarks_hill_thurmond_sc_ga',
    'richard_b_russell_lake': 'lake_russell_sc_ga',
    'lake_russell_ga':        'lake_russell_sc_ga',
    'lake_russell_sc':        'lake_russell_sc_ga',
  };
  let safe = sanitizeLakeId(lakeName);
  const key = `lake_packages/${safe}/normalized_documents.json`;
  let obj = await env.R2_TROLLMAP_CHARTPACKS.get(key).catch(() => null);
  if (!obj && LEGACY_PROFILE_KEYS[safe]) {
    obj = await env.R2_TROLLMAP_CHARTPACKS.get(`lake_packages/${LEGACY_PROFILE_KEYS[safe]}/normalized_documents.json`).catch(() => null);
    if (obj) safe = LEGACY_PROFILE_KEYS[safe];
  }
  if (!obj) return new Response(JSON.stringify({ok:false, error:`no normalized documents for ${lakeName}`}), {status:404, headers:JSON_HEADERS});
  const text = await obj.text();
  let docs;
  try { docs = JSON.parse(text); } catch { return new Response(JSON.stringify({ok:false, error:"corrupt normalized documents"}), {status:500, headers:JSON_HEADERS}); }
  return new Response(JSON.stringify({ok:true, lakeName, count: docs.length, documents: docs}), {headers:JSON_HEADERS});
}

async function handleResearchAnalyzeFacts(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || "").trim();
  const baseName = String(body.baseName || body.lakeName || "").replace(/^Lake\s+/i,'').replace(/,\s*(SC|NC|GA|TN)(\/(?:SC|NC|GA|TN))*\s*$/i,'').trim() || lakeName;
  const state = String(body.state||'SC').trim();
  const documents = body.documents || [];
  // Optional low-cost Smart Plan recovery mode. Documents still come from the
  // caller's saved R2 normalized corpus; this merely narrows extraction focus.
  const targetFields = Array.isArray(body.targetFields) ? body.targetFields.filter(Boolean).slice(0, 20) : [];

  if (!lakeName || !documents.length) {
    return new Response(JSON.stringify({ success: false, error: "Missing lakeName or documents payload" }), { status: 400, headers: JSON_HEADERS });
  }

  // Filter index/search pages — high URL density, low prose content
  const isIndexPage = (doc) => {
    const text = doc.text || doc.fullText || '';
    const urlMatches = (text.match(/https?:\/\//g) || []).length;
    const words = text.split(/\s+/).length;
    return urlMatches > 40 && urlMatches / words > 0.15;
  };

  const usableDocs = documents.filter(d => !isIndexPage(d));
  const filteredCount = documents.length - usableDocs.length;
  if (filteredCount > 0) {
    console.log(`handleResearchAnalyzeFacts: filtered ${filteredCount} index/search page(s)`);
  }

  if (!usableDocs.length) {
    return new Response(JSON.stringify({ success: false, error: "All documents were index/search pages" }), { status: 400, headers: JSON_HEADERS });
  }

  // Per-document extraction — one LLM call per document
  // This ensures every document gets fully read instead of competing for context budget
  const allFacts = [];
  const docResults = [];

  const SYSTEM = "You are a precise fact extraction engine. Extract verified facts about the specified lake from this single document. Return ONLY valid JSON with extracted_facts array. Never hallucinate. Quote must be verbatim from the document. Confidence 0-100.";


  // ── Keyword sentence harvester ─────────────────────────────────────────────
  // Scans raw document text for sentences containing high-value keywords plus
  // a numeric value. Injects flagged sentences directly into the extraction
  // prompt so the LLM sees the relevant evidence rather than hunting for it.
  const HARVEST_KEYWORDS = [
    // Identity / morphometry
    /normal\s+pool|full\s+pool|pool\s+elevation|pool\s+level|surface\s+elevation/i,
    /thermocline|metalimnion|epilimnion|hypolimnion|stratif/i,
    /dissolved\s+oxygen|\bdo\b.*mg\/l|mg\/l.*\bdo\b|anox|hypox/i,
    /secchi|water\s+clarity|turbidity|clarity/i,
    /trophic|eutrophic|mesotrophic|oligotrophic/i,
    /drawdown|rule\s+curve|guide\s+curve|seasonal.*level|winter.*pool|summer.*pool|normal.*target|target.*level|year.round.*level|level.*year.round|full.*pool|full.pond/i,
    /threadfin|gizzard|blueback|alewife|shad.*forage|forage.*shad/i,
    /retention\s+time|residence\s+time|hydraulic/i,
    /standing\s+timber|submerged\s+timber|stump|cypress.*lake|flooded.*timber/i,
    /riprap|rip[- ]rapped|rocky\s+(?:bank|shoreline)|dam\s+face|causeway|bridge\s+approach/i,
    /creek\s+(?:mouth|arm)|river\s+arm|cove|tributary\s+mouth|inlet/i,
    /dock(?:s|\s+density)|marina|pier|shallow\s+flat|spawning\s+(?:flat|cove)|fish\s+attractor/i,
  ];

  function harvestKeywordSentences(text, maxSentences = 20, lakeAliases = []) {
    if (!text || text.length < 100) return [];
    // Build alias regex if aliases provided — flags sentences mentioning the lake by any known name
    const aliasRx = lakeAliases.length
      ? new RegExp(lakeAliases.map(a => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i')
      : null;
    // Split on sentence boundaries
    const sentences = text
      .replace(/\r\n/g, '\n')
      .split(/(?<=[.!?])\s+(?=[A-Z])|\n{2,}/)
      .map(s => s.replace(/\s+/g, ' ').trim())
      .filter(s => s.length > 20 && s.length < 800);

    const flagged = [];
    const seen = new Set();
    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i];
      if (seen.has(s)) continue;
      const hasKeyword = HARVEST_KEYWORDS.some(rx => rx.test(s));
      const hasAlias = aliasRx ? aliasRx.test(s) : false;
      const hasNumber = /\d/.test(s);
      const isCastingTarget = /riprap|rip[- ]rapped|creek\s+(?:mouth|arm)|river\s+arm|cove|tributary\s+mouth|inlet|dock|marina|pier|shallow\s+flat|spawning\s+(?:flat|cove)|fish\s+attractor|timber/i.test(s);
      if ((hasKeyword || hasAlias) && (hasNumber || isCastingTarget || hasAlias)) {
        // Include the next sentence too (handles two-sentence fact patterns)
        const pair = i + 1 < sentences.length
          ? s + ' ' + sentences[i + 1]
          : s;
        flagged.push(pair.slice(0, 600));
        seen.add(s);
        if (flagged.length >= maxSentences) break;
      }
    }
    return flagged;
  }

    const buildDocPrompt = (doc, lakeName, baseName, state) => {
    const combined = (doc.title || '') + ' ' + (doc.url || '');
    const isRegulations = /regulation|regs|eregulation|creel|size.?limit|bag.?limit/i.test(combined);
    const isLimnology = /epa|nscep|water.?qual|limnol|nutrient|eutrophication|characteriz|ferc.*ea|environmental.?assess|relicens|phytoplankton|journal.*water|water.*journal/i.test(combined);
    const isBiology = /fisheries|biology|annual.report|investigations|stocking|species|creel.survey|electrofishing|bass|bream|crappie|striper|catfish|sunfish|perch/i.test(combined);
    const isOperator = /duke.energy|dominion|santee.cooper|usace|army.corps|ferc|cra|agreement/i.test(combined);
    const isGuide = /sportsman|fishing.report|guide|carolinasportsman|anglersheadquarters|takemefishing|hot.*spot|night.*bass|monster|striper.*lake|lake.*striper|bassin|fishing.*sc|sc.*fishing/i.test(combined);
    const isSCDNR = /dnr\.sc\.gov|dnr\.nc\.gov|gadnr|description\.html|lake.*description|scdnr|ncwrc|fisheries.*fact|fact.*sheet/i.test(combined);
    const isGrokipedia = /grokipedia\.com/i.test(doc.url || '');

    const focusParts = [];
    if (isGrokipedia) focusParts.push(`
PRIORITY FIELDS for this Grokipedia reference article — extract ALL of the following if present:

MORPHOMETRY & IDENTITY:
- Surface area in acres
- Maximum depth in feet
- Average/mean depth in feet
- Normal pool elevation (feet NGVD or NAVD)
- Total storage capacity (acre-feet)
- Active/usable storage capacity (acre-feet)
- Shoreline miles
- Year impounded/completed
- Dam name(s) and type
- Reservoir owner/operator (current)
- River system / watershed
- County/counties
- GPS coordinates or location description
- FERC license number and expiration

POOL MANAGEMENT & OPERATIONS:
- Daily water level fluctuation range (feet)
- Seasonal drawdown amount (feet)
- Normal minimum pool elevation
- Pumped storage cycle description
- Hydroelectric capacity (MW)

LIMNOLOGY — extract every number you find:
- Thermocline depth in summer (feet or meters — convert to feet)
- Hypolimnetic anoxia depth (where DO drops below 2 mg/L)
- Surface dissolved oxygen range (mg/L)
- Water clarity / Secchi depth (feet or meters)
- Trophic status (oligotrophic/mesotrophic/eutrophic)
- Total phosphorus (mg/L)
- Chlorophyll-a (µg/L)
- pH range
- Water temperature ranges
- Thermal stratification details

BIOLOGY — extract every species and forage reference:
- All sport fish species documented (list each separately)
- Primary forage fish species (gizzard shad, threadfin shad, alewife, etc.)
- Secondary forage species
- Total number of documented fish species
- Any priority/rare/endangered species present
- Stocking programs (species, quantities, years, agency)
- Trophy fish potential mentions

HABITAT & NAVIGATION:
- Fish attractors (count, types)
- Boat ramps (count, locations)
- Access points
- Fishing restrictions (no jet skis, no water skiing, speed limits, etc.)
- Nuclear exclusion zones or restricted areas
- Standing timber / submerged structure

WATER QUALITY:
- Impairments or 303(d) listings
- PCB or contamination advisories
- E. coli or bacteria issues
- Thermal discharge effects (nuclear/industrial cooling)`);

    if (isLimnology) focusParts.push(`
PRIORITY FIELDS for this document type:
- Thermocline depth: the SPECIFIC DEPTH in meters or feet where temperature drops sharply (epilimnion thickness). Convert meters × 3.281 to feet. Example fact: "Thermocline in Lake X develops at 4-6 meters (~13-20 feet)."
- Oxygen depletion depth: the SPECIFIC DEPTH where DO drops below 2 mg/L. Example fact: "DO drops below 2 mg/L below 5 meters (~16 feet) in Lake X."
- Secchi depth: actual measured value in meters or feet. Example: "Secchi depth averaged 1.2 meters (3.9 feet)."
- Temperature at multiple depths (derive thermocline where temp drops sharply)
- Surface area (in km² or acres — note units), mean depth, max depth (in meters — convert to feet)
- Hydraulic retention time in days
- Trophic status (eutrophic/mesotrophic/oligotrophic)
- Total phosphorus and chlorophyll-a values
- Drawdown schedule / rule curve target elevations
UNIT WARNING: The EPA NES summary table has multiple rows. SECCHI row values are 0.3-0.5m. Alkalinity row is 10-35 mg/L. Do NOT confuse these. Temperature row is in °C.
CRITICAL: If you see a depth value near a thermocline or oxygen keyword, ALWAYS extract it with the specific number. "Oxygen depletion below the thermocline is widespread" is NOT a useful fact without the depth.`);

    if (isBiology) focusParts.push(`
PRIORITY FIELDS for this document type:
- Species present (all game fish and forage species mentioned for this lake)
- Stocking events (species, quantity, year, agency)
- Standing stock biomass (kg/ha) from cove rotenone or electrofishing data
- Species composition percentages (% of standing stock)
- Growth data, PSD/RSD values, electrofishing CPUE
- Forage fish species and relative abundance
- Florida bass allele frequency if mentioned`);

    if (isRegulations) focusParts.push(`
PRIORITY FIELDS for this document type:
- Creel limits by species (statewide AND lake-specific exceptions)
- Size/length limits by species
- Closed seasons (note which waterbodies they apply to — Santee River ≠ Lake Wateree)
- Any gear restrictions or special rules for this lake`);

    if (isOperator) focusParts.push(`
PRIORITY FIELDS for this document type:
- Pool level targets by month (Guide Curve column from CRA table — local datum feet)
- Minimum and maximum pool elevations
- Drawdown schedule and target elevations
- Normal full pool elevation
- ANY sentence mentioning a target lake level, normal operating level, or year-round target (e.g. "normal target lake level is 97 feet year-round")
- Fixed target elevations even without a monthly table`);

    if (isGuide) focusParts.push(`
PRIORITY FIELDS for this document type:
- Thermocline depth (any mention of depth where fish concentrate, e.g. "thermocline at 16 feet")
- Seasonal patterns by species
- Structure types where fish are found
- Forage behavior and depth preferences`);

    if (isSCDNR) focusParts.push(`
PRIORITY FIELDS for this SCDNR/agency lake description or fact sheet:
- Surface area in acres
- Shoreline miles
- Average and maximum depth in feet
- Normal pool elevation
- Boat ramps (count and locations)
- Fish attractors (count and types)
- Fishing access locations
- Marinas
- Species present (list each separately)
- Stocking programs
- Any lake-specific regulations mentioned`);

    // Fallback: if no type matched, use a broad general prompt so no doc gets zero guidance
    if (focusParts.length === 0) focusParts.push(`
PRIORITY FIELDS — extract any of the following present in this document:
- Morphometry: surface area, depth, shoreline, pool elevation
- Limnology: thermocline depth, dissolved oxygen, Secchi depth, trophic status, water clarity
- Biology: species present, stocking, forage fish, standing stock
- Regulations: creel limits, size limits, closed seasons
- Habitat: fish attractors, structure, vegetation
- Navigation: boat ramps, access points, hazards`);

    const targetedRecoveryInstructions = targetFields.length ? `\nTARGETED SMART PLAN RECOVERY: The only requested gaps are ${targetFields.join(', ')}. Prioritize exact, lake-attributed evidence for those fields. Do not return generic facts merely because they are present.` : '';
    const focusInstructions = focusParts.join('\n\n') + targetedRecoveryInstructions;
    const _baseNameStripped = baseName.replace(/,\s*(SC|NC|GA|TN)(\/[A-Z]{2})?\s*$/i, '').trim();
    const _lakeNameStripped = 'Lake ' + _baseNameStripped;

    // ── Document aliases: real-world names used in documents for lakes with
    // non-standard display names (slash names, dual names, renamed lakes, etc.)
    const DOCUMENT_ALIASES = {
      'clarks hill / thurmond': ['Clarks Hill Lake', 'J. Strom Thurmond Lake', 'Lake Thurmond', 'Thurmond Lake', 'Clarks Hill Reservoir', 'Strom Thurmond Lake'],
      'lake russell': ['Richard B. Russell Lake', 'Lake Russell', 'Russell Lake', 'R.B. Russell Lake'],
      'lake wylie': ['Lake Wylie', 'Wylie Lake', 'Lake Wylie Reservoir'],
      'lake monticello': ['Lake Monticello', 'Monticello Reservoir', 'Broad River Reservoir'],
      'fishing creek reservoir': ['Fishing Creek Reservoir', 'Fishing Creek Lake', 'Nitrolee Dam'],
      'lake greenwood': ['Lake Greenwood', 'Buzzard Roost Reservoir'],
      'lake jocassee': ['Lake Jocassee', 'Jocassee Reservoir'],
      'mountain island lake': ['Mountain Island Lake', 'Mountain Island Reservoir'],
      'high rock lake': ['High Rock Lake', 'High Rock Reservoir'],
      'blewett falls lake': ['Blewett Falls Lake', 'Blewett Falls Reservoir', 'Lake Tillery'],
      'lake hartwell': ['Lake Hartwell', 'Hartwell Lake', 'Hartwell Reservoir'],
    };
    const _aliasKey = _baseNameStripped.toLowerCase().replace(/,\s*(sc|nc|ga|tn)(\/[a-z]{2})?\s*$/i, '').trim();
    const _docAliases = DOCUMENT_ALIASES[_aliasKey] || [];
    const _aliasClause = _docAliases.length
      ? ` OR any of these known aliases: ${_docAliases.map(a => `"${a}"`).join(', ')}`
      : '';

    const _flagged = harvestKeywordSentences(doc.text || '', 20, _docAliases);
    const _flaggedBlock = _flagged.length
      ? '⚑ FLAGGED PASSAGES (keyword matches — prioritize extracting facts from these):\n' +
        _flagged.map((s, i) => `[${i+1}] ${s.replace(/`/g, "'").replace(/\$/g, 'USD')}`).join('\n') + '\n\n'
      : '';
    return `Extract ALL verified facts about "${lakeName}" (base name "${baseName}", state ${state}) from this document.

DOCUMENT: ${doc.title}
URL: ${doc.url || 'unknown'}
${focusInstructions}

RULES:
1. Only extract facts that explicitly mention "${baseName}" or "${lakeName}" or "${_baseNameStripped}" or "${_lakeNameStripped}"${_aliasClause}, OR are general ${state} statewide regulations that apply to this lake.
1a. MULTI-LAKE DOCUMENTS: If this document covers multiple lakes or water bodies, only extract numeric facts (depths, areas, temperatures, DO levels, Secchi depths) where the specific number is explicitly attributed to "${_baseNameStripped}" or "${_lakeNameStripped}"${_docAliases.length ? ` or one of its aliases (${_docAliases.join(', ')})` : ''} in the same sentence or the immediately preceding sentence. If a number appears in a paragraph or table row that also discusses another lake, skip it unless the attribution to this lake is unambiguous. When in doubt, omit the fact.
2. Never invent numbers. If a value is not in this document, omit it.
3. Convert all measurements: meters × 3.281 = feet; km² × 247.1 = acres.
   CRITICAL: If you see "Surface area: 205.58 kilometers²" or similar — that is km², convert it: 205.58 × 247.1 = 50,798 acres. NEVER report the raw km² number as if it were acres.
4. For table data: extract each meaningful row as a separate fact with the row content as the quote.
5. If this document has NO information about "${_baseNameStripped}" or "${_lakeNameStripped}"${_aliasClause}, return {"extracted_facts": []}.${_flaggedBlock}DOCUMENT TEXT:
${(doc.text || '').slice(0, 150000)}

Return ONLY:
{"extracted_facts": [{"fact": "concise sentence", "page": 1, "confidence": 85, "source": "${doc.title.slice(0,80)}", "quote": "verbatim text", "category": "category_name"}]}

Categories: surfaceArea, maxDepthFt, averageDepthFt, thermocline, oxygen, secchi, trophicStatus, hydraulicRetentionDays, predatorSpecies, primaryForage, stocking, standingStock, speciesAbundance, creelLimit_general, creelLimit_lakeSpecific, sizeLimit_general, sizeLimit_lakeSpecific, closedSeason, poolLevel, drawdownSchedule, habitatCover, structuralElement, ramp, hazard, reservoirOwner, damName, yearImpounded, riverSystem, county, consumptionAdvisory, summary
CRITICAL CATEGORY RULES:
- thermocline: MUST include the actual depth in feet or meters (e.g. 'thermocline at 4-6m', 'epilimnion extends to 20 feet'). Do NOT file vague facts like 'thermocline is present' without a depth.
- oxygen: MUST include the depth where DO drops below 2 mg/L (e.g. 'DO < 2 mg/L below 5 meters'). Do NOT file vague facts like 'oxygen depletion occurs' without a depth.
- secchi: MUST include the actual Secchi depth value in meters or feet.
- consumptionAdvisory: use for mercury advisories, meal frequency limits due to contamination — NOT for creel limits`;
  };

  for (let i = 0; i < usableDocs.length; i++) {
    const doc = usableDocs[i];
    const docText = doc.text || doc.fullText || '';
    if (!docText || docText.length < 100) {
      console.log(`handleResearchAnalyzeFacts: skipping empty doc [${i+1}]: ${doc.title}`);
      continue;
    }

    try {
      const prompt = buildDocPrompt(doc, lakeName, baseName, state);
      const payload = {
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: prompt }
        ],
        temperature: 0.05,
        max_tokens: 4000,
        response_format: { type: "json_object" }
      };

      const { data } = await callLLM(env, payload, null);
      const text = extractLLMText(data);
      const parsed = extractJsonPossibly(text);

      if (!parsed) {
        console.warn(`handleResearchAnalyzeFacts: doc [${i+1}] "${doc.title}" returned non-JSON`);
        docResults.push({ doc: doc.title, facts: 0, error: 'non-JSON' });
        continue;
      }

      let facts = parsed.extracted_facts || parsed.facts || [];
      if (!Array.isArray(facts)) facts = [];

      // Normalize
      facts = facts.map(f => ({
        fact: String(f.fact||'').trim().slice(0,500),
        page: parseInt(f.page)||1,
        confidence: Math.min(99, Math.max(10, parseInt(f.confidence)||70)),
        source: String(f.source || doc.title || 'Unknown').slice(0,180),
        quote: String(f.quote||'').trim().slice(0,400),
        category: String(f.category||'general').trim().slice(0,50)
      })).filter(f => f.fact.length > 10);

      // Quality filter: require lake mention for non-regulation facts
      const generalCats = new Set(['creelLimit_general','sizeLimit_general','regulations_general','closedSeason']);
      // Build alias check strings for this lake
      const _qfAliasKey2 = baseName.toLowerCase().replace(/,\s*(sc|nc|ga|tn)(\/[a-z]{2})?\s*$/i, '').trim();
      const _qfAliases = ({
        'clarks hill / thurmond': ['clarks hill lake', 'j. strom thurmond lake', 'lake thurmond', 'thurmond lake', 'clarks hill reservoir', 'strom thurmond lake'],
        'lake russell': ['richard b. russell lake', 'lake russell', 'russell lake', 'r.b. russell lake'],
        'lake wylie': ['lake wylie', 'wylie lake'],
        'lake monticello': ['lake monticello', 'monticello reservoir'],
        'fishing creek reservoir': ['fishing creek reservoir', 'fishing creek lake', 'nitrolee dam'],
        'lake greenwood': ['lake greenwood', 'buzzard roost reservoir'],
        'lake hartwell': ['lake hartwell', 'hartwell lake', 'hartwell reservoir'],
        'mountain island lake': ['mountain island lake', 'mountain island reservoir'],
        'high rock lake': ['high rock lake', 'high rock reservoir'],
        'blewett falls lake': ['blewett falls lake', 'blewett falls reservoir'],
      })[_qfAliasKey2] || [];
      const kept = facts.filter(f => {
        if (generalCats.has(f.category) || /general|creel|size.?limit|regulation/i.test(f.category)) return true;
        const combined = `${f.fact} ${f.quote} ${f.source}`.toLowerCase();
        if (combined.includes(baseName.toLowerCase()) || combined.includes(lakeName.toLowerCase())) return true;
        return _qfAliases.some(alias => combined.includes(alias));
      });

      allFacts.push(...kept);
      docResults.push({ doc: doc.title, facts: kept.length });
      console.log(`handleResearchAnalyzeFacts: doc [${i+1}/${usableDocs.length}] "${doc.title.slice(0,50)}" → ${kept.length} facts`);

    } catch (e) {
      console.warn(`handleResearchAnalyzeFacts: doc [${i+1}] failed: ${e.message}`);
      docResults.push({ doc: doc.title, facts: 0, error: e.message });
    }
  }

  return new Response(JSON.stringify({
    success: true,
    extracted_facts: allFacts,
    meta: {
      totalDocs: usableDocs.length,
      filteredIndexPages: filteredCount,
      docResults,
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
    // WQP metadata categories — useless for research profile, filter entirely
    const WQP_NOISE_CATS = new Set(['monitoringlocationidentifier','monitoringlocationname','monitoringlocationtypename',
      'monitoringlocationdescription','huc','latitude','longitude','datum','identifier','sitetype',
      'maintainer','watershed','coordinates','country','location']);
    if (WQP_NOISE_CATS.has(cat)) continue; // skip WQP metadata facts entirely

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
            // Don't flag as contradiction if facts mention different species
            const speciesNames = /largemouth|striped|hybrid|crappie|catfish|bream|walleye|pickerel|perch|bass|bluegill|redear|muskellunge|muskie/i;
            const prevSpecies = (prevText.match(speciesNames) || [])[0] || '';
            const currSpecies = (currText.match(speciesNames) || [])[0] || '';
            const differentSpecies = prevSpecies && currSpecies && prevSpecies.toLowerCase() !== currSpecies.toLowerCase();
            // Don't flag seasonal rules as contradictions (Oct-May vs Jun-Sep etc)
            const seasonPattern = /jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d+\s*-\s*(may|sept|oct)|spring|summer|fall|winter|seasonal/i;
            const bothSeasonal = seasonPattern.test(prevText) && seasonPattern.test(currText);
            // Skip if both facts contain the same set of numbers — different phrasing of same fact
            const allNumsPrev = new Set((prevText.match(/\d+(?:\.\d+)?/g) || []).map(Number));
            const allNumsCurr = new Set((currText.match(/\d+(?:\.\d+)?/g) || []).map(Number));
            const sameNumbers = [...allNumsPrev].every(n => allNumsCurr.has(n)) && [...allNumsCurr].every(n => allNumsPrev.has(n));
            // 15% threshold filters rounding noise (48k vs 51k acres = 6.25%) while
            // catching real conflicts (13k vs 51k acres = 292%)
            if (sameAttr && relDiff > 0.15 && !differentSpecies && !bothSeasonal && !sameNumbers) {
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

  // Deduplicate contradictions by field — keep only the highest-confidence pair per field
  // (per-document extraction produces N facts per field, leading to N*(N-1)/2 contradiction pairs)
  const seenContraField = new Map();
  const dedupedContradictions = contradictions.filter(c => {
    const key = String(c.field).toLowerCase();
    const pairConf = (c.confidenceA || 0) + (c.confidenceB || 0);
    if (!seenContraField.has(key) || pairConf > seenContraField.get(key).conf) {
      seenContraField.set(key, { conf: pairConf, c });
      return false; // will re-add from map below
    }
    return false;
  });
  // Re-add best pair per field
  seenContraField.forEach(({ c }) => dedupedContradictions.push(c));

  return new Response(JSON.stringify({ success: true, deduplicated_facts: deduplicated, contradictions: dedupedContradictions, meta: { input: facts.length, deduped: deduplicated.length, contradictions: dedupedContradictions.length } }), { headers: JSON_HEADERS });
}

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
    "invasiveSpecies": [],
    "spawnTiming": {},
    "forageSpatial": null
  },
  "habitat": {
    "bottomComposition": {},
    "cover": [],
    "vegetation": {},
    "structuralElements": {},
    "artificialHabitat": [],
    "dockDensity": null,
    "riprapLocations": [],
    "namedCreekMouths": [],
    "timberFields": null,
    "shallowFlatAreas": null,
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

// ── GAP ANALYSIS — identify null fields and return targeted search queries ──
async function handleResearchGapAnalysis(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || '').trim();
  const profile = body.profile || {};
  const state = String(body.state || 'SC').toUpperCase();

  const dnrDomain = state === 'NC' ? 'ncwildlife.org OR eregulations.com' : state === 'GA' ? 'georgiawildlife.com OR eregulations.com' : 'dnr.sc.gov OR eregulations.com'; // Fix 2026-07-12: dnr.sc.gov/fishregs 404s -> eRegulations
  const baseName = lakeName.replace(/^Lake\s+/i,'').replace(/,\s*(SC|NC|GA|TN)(\/(?:SC|NC|GA|TN))*\s*$/i,'').trim();

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

// ── GAP SEARCH — targeted Tavily search + extract + fact extraction for one null field ──
async function handleResearchGapSearch(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || '').trim();
  const state = String(body.state || 'SC').toUpperCase();
  const field = String(body.field || '').trim();
  const query = String(body.query || '').trim();

  if (!lakeName || !query) return new Response(JSON.stringify({ success: false, error: "Missing lakeName or query", extracted_facts: [], rawText: '' }), { status: 400, headers: JSON_HEADERS });

  const firecrawlKey = env.FIRECRAWL_API_KEY || env.FIRECRAWL_KEY;
  if (!firecrawlKey) return new Response(JSON.stringify({ success: false, error: "No Firecrawl key", extracted_facts: [], rawText: '' }), { headers: JSON_HEADERS });

  try {
    // Search + scrape in one call via Firecrawl /v2/search
    const searchRes = await fetch('https://api.firecrawl.dev/v2/search', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${firecrawlKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit: 3 })
    });
    if (!searchRes.ok) return new Response(JSON.stringify({ success: false, error: `Firecrawl search ${searchRes.status}`, extracted_facts: [], rawText: '' }), { headers: JSON_HEADERS });
    const searchData = await searchRes.json();
    const results = searchData.data?.web || searchData.data || searchData.web || (Array.isArray(searchData) ? searchData : []);
    if (!results.length) return new Response(JSON.stringify({ success: true, extracted_facts: [], rawText: '', note: "No results found" }), { headers: JSON_HEADERS });

    // Firecrawl /v2/search returns markdown content inline — no separate extract call needed
    const urls = results.map(r => r.url).filter(Boolean);
    const rawText = results.map(r => {
      const content = r.markdown || r.content || r.description || '';
      return content ? `## ${r.title || r.url}\n${content}` : '';
    }).filter(Boolean).join('\n\n').slice(0, 8000);

    // Return raw text — mapping agent handles extraction
    return new Response(JSON.stringify({ success: true, extracted_facts: [], rawText, field, query, urls }), { headers: JSON_HEADERS });

  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message, extracted_facts: [], rawText: '' }), { status: 502, headers: JSON_HEADERS });
  }
}

// ─── ORIGINAL LAKE RESEARCH MODULE FUNCTIONS ───

function sanitizeLakeId(name) {
  return String(name || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'unknown_lake';
}

function lakeResearchMasterKey(lakeName) {
  return `lakes/${sanitizeLakeId(lakeName)}.json`;
}

function lakePackageKey(lakeName, filename) {
  return `lake_packages/${sanitizeLakeId(lakeName)}/${filename}`;
}

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

var RESEARCH_AGENTS = {
  identity: {
    label: "Lake Identity",
    order: 1,
    system: "You are a data assembly agent for lake identity and pool management data. Map extracted facts to the JSON fields. CRITICAL RULES: (1) surfaceAreaAcres must be in ACRES — if source gives km², multiply by 247.1; (2) maxDepthFt is actual water depth — NEVER use pool elevation as depth; (3) For Duke Energy CRA pool tables the columns are: Month | Guide Curve ft | Minimum ft | Maximum ft in local datum; (4) riverSystem must be a river/watershed name like 'Saluda River' or 'Catawba-Wateree' — NEVER a HUC code or monitoring site description; (5) archetype must be a lake type like 'large hydroelectric reservoir' — NEVER a water quality site type like 'other-surface water site'; (6) Never invent values. Return ONLY valid JSON. (8) county: use an array for multi-county or multi-state lakes (e.g. ['York, SC', 'Gaston, NC', 'Mecklenburg, NC']). For single county use a string. Never leave null if county information is present in the facts. (7) normalPoolFt is the STATIC full pool surface elevation in feet NGVD/NAVD (e.g. 265.3, 385.5, 569.4, 75.5) — NEVER a daily fluctuation range, drawdown amount, or year range. If you see phrases like 'fluctuate up to X feet', 'averaging X feet per day', 'up to X feet daily', or 'X feet year-round fluctuation', those are fluctuation amounts NOT pool elevations — set normalPoolFt to null. If the only pool number is a fluctuation or a year range, set normalPoolFt to null. Valid pool elevations are typically 3-digit numbers (e.g. 265, 385, 569) for NGVD/NAVD, or 2-digit numbers representing local datum (e.g. 97 for Duke Energy lakes). Single-digit or ambiguous numbers should be set to null unless clearly labeled as pool elevation.",
    userTemplate: (lakeName, state, prev) => {
      const facts = prev?._extractedFacts || [];

      const surfaceFact = facts.find(f => f.category === 'surfaceArea' && /acre/i.test(f.fact))
        || facts.find(f => f.category === 'surfaceArea');
      const surfaceArea = surfaceFact ? (() => {
        const m = surfaceFact.fact.match(/([\d,]+(?:\.\d+)?)\s*acres?/i);
        if (m) return parseFloat(m[1].replace(',',''));
        const km = surfaceFact.fact.match(/([\d,]+(?:\.\d+)?)\s*km/i);
        if (km) return Math.round(parseFloat(km[1].replace(',','')) * 247.1);
        return null;
      })() : null;

      const maxFact = facts.find(f => f.category === 'maxDepthFt' && !/225|pool|elevation/i.test(f.fact));
      const maxDepth = maxFact ? (() => {
        const m = maxFact.fact.match(/([\d.]+)\s*f(?:ee)?t/i);
        if (m) return parseFloat(m[1]);
        const met = maxFact.fact.match(/([\d.]+)\s*met/i);
        if (met) return Math.round(parseFloat(met[1]) * 3.281);
        return null;
      })() : null;

      const avgFact = facts.find(f => f.category === 'averageDepthFt');
      const avgDepth = avgFact ? (() => {
        const m = avgFact.fact.match(/([\d.]+)\s*f(?:ee)?t/i);
        if (m) return parseFloat(m[1]);
        const met = avgFact.fact.match(/([\d.]+)\s*met/i);
        if (met) return Math.round(parseFloat(met[1]) * 3.281 * 10) / 10;
        return null;
      })() : null;

      const identityFacts = facts.filter(f => {
        if (!/identity|surface|depth|dam|year|owner|river|archetype|impound|county|pool|drawdown|elevation|normal/i.test(f.category)) return false;
        // Exclude poolLevel facts that are just fluctuation ranges — not pool elevations
        if (f.category === 'poolLevel' && !/elevation|ngvd|navd|feet above|ft msl|\d{3}\s*f/i.test(f.fact)) return false;
        return true;
      }).map(f => `• [${f.category}] ${f.fact} (source: ${f.source}, confidence ${f.confidence}%)\n  Quote: "${f.quote}"`).join('\n\n');

      const ownerText = (facts.find(f => f.category === 'reservoirOwner')?.fact || '').toLowerCase();
      const isDuke = /duke/i.test(ownerText);

      const dukePoolSection = isDuke ? `

DUKE ENERGY CRA POOL LEVEL TABLE — IF PRESENT IN DOCUMENTS:
The CRA agreement PDF has a table: Month(s) | Guide Curve (target ft) | Minimum ft | Maximum ft (local datum, typically 93-100 range).
Extract into poolManagement: guideCurveFt by month, minimumFt, maximumFt, drawdownSchedule [{months, targetFt}].
Set drawdownType: "scheduled" and normalPoolFt to the Maximum column value.` : '';

      const docSection = prev?._documentContext
        ? `\n\nDOCUMENT TEXT:\n${prev._documentContext.slice(0, 60000)}`
        : '';

      return `Map identity facts for ${lakeName} (${state}).

EXTRACTED FACTS:
${identityFacts || 'No identity facts — use document context.'}

RULES:
- surfaceAreaAcres: ${surfaceArea !== null ? surfaceArea : 'extract from facts (acres preferred; km² × 247.1)'}
- maxDepthFt: ${maxDepth !== null ? maxDepth : 'from EPA/USGS only — reject pool elevation values'}
- averageDepthFt: ${avgDepth !== null ? avgDepth : 'convert meters × 3.281 if needed'}
${dukePoolSection}
${docSection}

Return ONLY valid JSON:
{
  "identity": {
    "lakeName": "${lakeName}",
    "aliases": [],
    "state": "${state || ''}",
    "county": null,
    "riverSystem": null,
    "reservoirOwner": null,
    "surfaceAreaAcres": ${surfaceArea !== null ? surfaceArea : null},
    "maxDepthFt": ${maxDepth !== null ? maxDepth : null},
    "averageDepthFt": ${avgDepth !== null ? avgDepth : null},
    "elevationFt": null,
    "normalPoolFt": null,
    "type": "reservoir",
    "archetype": null,
    "damName": null,
    "yearImpounded": null,
    "drawdownType": null,
    "poolManagement": null
  },
  "sources": []
}
JSON only.`;
    },
    expectedKey: "identity"
  },
  limnology: {
    label: "Limnology",
    order: 2,
    system: "You are a limnologist data assembly agent. Map extracted facts and depth profile data to the limnology JSON. depletionDepthFt = shallowest depth where DO drops below 2 mg/L. anoxicBelowFt = depth where DO approaches 0. thermocline summerDepthFt = single number (midpoint of thermocline range, in feet). Convert meters to feet (×3.281). All numeric fields must be numbers or null — NEVER strings. Return ONLY valid JSON.",
    userTemplate: (lakeName, state, prev) => {
      const facts = prev?._extractedFacts || [];
      const limFacts = facts.filter(f =>
        /limnology|thermocline|oxygen|clarity|secchi|trophic|depth.?profile|water.?clarity|hydraulic|retention|do_depth|temp_depth/i.test(f.category + ' ' + f.fact)
      );
      const factsBlock = limFacts.map(f =>
        `• [${f.category}] ${f.fact} (source: ${f.source}, confidence ${f.confidence}%)\n  Quote: "${f.quote}"`
      ).join('\n\n');

      const docSection = prev?._documentContext
        ? `\n\nRAW DOCUMENT TEXT (look for depth profile tables with DO and temperature readings at multiple depths):\n${prev._documentContext.slice(0, 40000)}`
        : '';

      return `Extract limnology data for ${lakeName} from facts and documents.

EXTRACTED FACTS:
${factsBlock || 'No limnology facts extracted — derive from document depth profiles.'}

INSTRUCTIONS:
1. secchiFt: The EPA NES table has a row labeled "SECCHI (METERS)" — that is the only row for Secchi. Values are typically 0.3-0.5m for turbid lakes. Convert meters × 3.281. NEVER use alkalinity (10-35 mg/L), conductivity, pH, or any other row as Secchi. If Secchi is in meters, the feet value will be LESS THAN 5 ft for most SE reservoirs. A secchiFt value above 10 is almost certainly wrong — reject it.
2. thermocline.summerDepthFt: find where temperature drops sharply with depth in summer profiles. Report as a SINGLE NUMBER (the midpoint in feet, e.g. 19 for a 16-22ft range). NEVER a string, NEVER a range string like "16-22".
3. oxygen.depletionDepthFt: depth where DO first drops below 2 mg/L in summer. Must be a number or null — never the string "null".
4. oxygen.anoxicBelowFt: depth where DO approaches 0. Must be a number or null — never the string "null".
5. trophicStatus: derive from phosphorus, Secchi, chlorophyll data if present.
6. hydraulicRetentionDays: look for "retention time" or "residence time" in days. Number or null.
7. All depth values in feet — convert meters × 3.281.
8. CRITICAL: Every numeric field must be a JSON number or JSON null. Never use the string "null", never use a range string. If data is unavailable, use JSON null.
${docSection}

Return ONLY:
{
  "limnology": {
    "waterClarity": {"typical": null, "color": null, "secchiFt": null, "note": null},
    "thermocline": {"summerDepthFt": null, "strength": null, "winterMix": null, "confidence": null, "note": null},
    "oxygen": {"depletionDepthFt": null, "anoxicBelowFt": null, "note": null},
    "trophicStatus": null,
    "hydraulicRetentionDays": null,
    "flowCharacteristics": null,
    "seasonalDrawdownFt": null,
    "phTypical": null
  },
  "sources": []
}
JSON only.`;
    },
    expectedKey: "limnology"
  },
  biology: {
    label: "Fisheries Biology",
    order: 3,
    system: "You are a fisheries data assembly agent. Map extracted facts to the biology JSON. CRITICAL: predatorSpecies MUST include ALL species from the deterministic list — never shrink it. Only add species confirmed in facts/documents. Return ONLY valid JSON.",
    userTemplate: (lakeName, state, prev) => {
      const facts = prev?._extractedFacts || [];
      const bioFacts = facts.filter(f =>
        /biology|forage|species|predator|stocking|standing.?stock|shad|bass|crappie|catfish|biomass|rotenone|abundance|invasive|herring|spawn|bream|bluegill|crawfish|crayfish|perch/i.test(f.category + ' ' + f.fact)
      );

      // Split facts: official agency sources vs web/guide sources
      // Only official sources can confirm new species presence
      const OFFICIAL_SRC = /scdnr|ncwrc|ncwildlife|gadnr|twra|eregulations|dnr\.sc\.gov|dnr\.nc\.gov|ncwildlife\.gov|epd\.georgia|wildlife\.ga|epa\.gov|usgs\.gov|usace|santee.?cooper|duke.?energy|ferc|statewide.?fisheries|annual.?report|management.?plan|survey.*\d{4}|\d{4}.*survey/i;
      const officialFacts = bioFacts.filter(f => OFFICIAL_SRC.test(f.source || ''));
      const webFacts = bioFacts.filter(f => !OFFICIAL_SRC.test(f.source || ''));

      const deterministicSpecies = prev?.biology?.predatorSpecies || [];

      const officialFactsBlock = officialFacts.map(f =>
        `• [${f.category}] ${f.fact} (source: ${f.source}, confidence ${f.confidence}%)\n  Quote: "${f.quote}"`
      ).join('\n\n');

      const webFactsBlock = webFacts.map(f =>
        `• [${f.category}] ${f.fact} (source: ${f.source}, confidence ${f.confidence}%)\n  Quote: "${f.quote}"`
      ).join('\n\n');

      const docSection = prev?._documentContext
        ? `\n\nDOCUMENT TEXT (look for species lists, stocking records, cove rotenone data, biomass tables, spawn timing, forage location notes):\n${prev._documentContext.slice(0, 80000)}`
        : '';

      return `Map fisheries biology facts for ${lakeName}.

DETERMINISTIC SPECIES LIST (MUST be preserved — only add, never remove):
${JSON.stringify(deterministicSpecies)}

OFFICIAL AGENCY FACTS (SCDNR, NCWRC, EPA, USGS, eRegulations, DNR, Santee Cooper — authoritative for species presence):
${officialFactsBlock || 'None.'}

WEB / GUIDE FACTS (fishing guides, social media, commercial sites — use for forage/behavior/stocking only, NOT species presence):
${webFactsBlock || 'None.'}
${docSection}

RULES:
1. predatorSpecies: start with deterministic list above. ONLY add a species if it appears in the OFFICIAL AGENCY FACTS section or in official agency document text. NEVER add a species based solely on web/guide sources like Omnia Fishing, fishing reports, or social media — these are unreliable for confirming species presence. Never remove. NEVER add: sturgeon, paddlefish, gar, eel, lamprey, shad, herring, carp, drum, buffalo, sucker, or any protected/endangered/baitfish species — these are NOT predator species.
2. primaryForage: extract from facts AND document text. If shad (threadfin shad, gizzard shad, blueback herring) are mentioned as forage or baitfish in any document, include them. Do not leave primaryForage empty if forage species appear in the source material.
3. knownStockings: extract actual stocking events with species, quantities, years if mentioned.
4. standingStockKgHa: extract biomass figures from rotenone or electrofishing data if present.
5. speciesAbundance: use actual percentage data from documents if available.
6. spawnTiming: extract spawn timing per species if mentioned (e.g. "largemouth bass spawn late March to early May when water reaches 62-68°F"). Use format {"species": "timing description"}.
7. forageSpatial: if documents mention WHERE forage concentrates (e.g. "bream in shallow rocky coves", "shad school in open mid-lake water near dam", "crappie at creek mouths"), extract that as a single descriptive string.
8. baitfishMovement: if documents describe seasonal or behavioral movement of bait species, extract as a seasonal object {"spring": "...", "summer": "...", "fall": "...", "winter": "..."}. Include spatial context (e.g. "suspend over humps near thermocline", "push into creek backs"). Omit seasons with no document support.
9. Keep spawnTiming keyed by the exact species name and preserve temperature/date triggers when stated.
10. forageSpatial must name the area or habitat where forage is reported; do not turn a generic forage species statement into a location.
11. speciesBehavior: CRITICAL — for each predator species, extract lake-specific depth ranges, structure associations, and behavioral notes per season from documents. This replaces generic species intel in Smart Plan. If a document says "largemouth bass holding in 5-8 feet around woody cover" — that goes in speciesBehavior.Largemouth Bass.summer. If no species-specific depth/structure data exists in documents, omit that species from speciesBehavior.

Return ONLY:
{
  "biology": {
    "primaryForage": [],
    "secondaryForage": [],
    "predatorSpecies": ${JSON.stringify(deterministicSpecies.length ? deterministicSpecies : [])},
    "speciesAbundance": {},
    "standingStockKgHa": null,
    "baitfishMovement": { "spring": null, "summer": null, "fall": null, "winter": null },
    "knownStockings": [],
    "invasiveSpecies": [],
    "forageCalendar": {},
    "spawnTiming": {},
    "forageSpatial": null,
    "speciesBehavior": {}
  },
  "sources": []
}
speciesBehavior schema per species: { "spring": {"depthRange": [minFt, maxFt], "structure": [], "notes": null}, "summer": {...}, "fall": {...}, "winter": {...}, "spawnTiming": {"waterTempF": null, "typicalMonths": []}, "spawnHabitat": null, "lakeSpecificNotes": null }
depthRange is [minFt, maxFt] array or null. Only populate seasons with document evidence. JSON only.`;
    },
    expectedKey: "biology"
  },
  habitat: {
    label: "Habitat",
    order: 4,
    system: "You are an aquatic habitat data assembly agent. Map facts and geospatial data to the habitat JSON. No fishing advice. Return ONLY valid JSON.",
    userTemplate: (lakeName, state, prev) => {
      const facts = prev?._extractedFacts || [];
      const habFacts = facts.filter(f =>
        /habitat|cover|attractor|bottom|timber|dock|vegetation|structure|point|creek|ledge|flat|ramp|bridge|riprap|cove|arm|shallow|marina|pier/i.test(f.category + ' ' + f.fact)
      );
      const existingHabitat = prev?.habitat || {};
      const factsBlock = habFacts.map(f =>
        `• [${f.category}] ${f.fact} (source: ${f.source}, confidence ${f.confidence}%)`
      ).join('\n');

      return `Map habitat facts for ${lakeName}.

EXTRACTED FACTS:
${factsBlock || 'No habitat facts extracted.'}

EXISTING GEOSPATIAL DATA (from TrollMap contour/supplemental layers — preserve these exactly):
${JSON.stringify(existingHabitat, null, 2).slice(0, 3000)}

RULES:
CASTING EXTRACTION REQUIREMENTS — these fields power the casting stop builder. Search the full document, including captions, tables, map labels, and prose. Preserve named locations verbatim and do not replace a specific location with a generic category.
1. dockDensity: if documents describe dock concentration (e.g. "heavily docked residential shoreline", "sparse docks", "marina on north end"), capture as a descriptive string. null if not mentioned.
2. riprapLocations: list specific riprap areas if mentioned (e.g. dam face, causeways, bridge approaches, rip-rapped banks). Array of strings.
3. namedCreekMouths: extract named creek mouths or arms if mentioned in documents (e.g. "Bear Creek arm", "Dutchman Creek mouth"). Array of strings. These are high-value casting targets.
4. timberFields: if documents describe flooded timber areas or submerged wood concentrations, capture as descriptive string with location if available.
5. shallowFlatAreas: if documents describe specific named shallow flat areas or coves good for casting/spawning, capture as descriptive string.
6. Include evidence-backed location details even when no numeric value is present; an empty array/null is correct only when the document contains no support.
7. Do not infer casting locations from generic lake geography or fishing knowledge.
8. standingTimber: boolean or description if submerged timber is present lake-wide.
9. cover: array of cover types present (docks, brush, timber, riprap, etc.).
10. Preserve all existing geospatial structuralElements and artificialHabitatDetails exactly.

Return ONLY:
{
  "habitat": {
    "bottomComposition": {},
    "cover": [],
    "vegetation": {},
    "artificialHabitat": [],
    "artificialHabitatDetails": ${JSON.stringify(existingHabitat.artificialHabitatDetails || null)},
    "structuralElements": ${JSON.stringify(existingHabitat.structuralElements || {})},
    "dockDensity": null,
    "riprapLocations": [],
    "namedCreekMouths": [],
    "timberFields": null,
    "shallowFlatAreas": null,
    "standingTimber": null,
    "notes": ${JSON.stringify(existingHabitat.notes || null)}
  },
  "sources": []
}
JSON only.`;
    },
    expectedKey: "habitat"
  },
  navigation: {
    label: "Navigation",
    order: 5,
    system: "You are a boating safety data assembly agent. Map ramp data and hazard facts to the navigation JSON. Return ONLY valid JSON.",
    userTemplate: (lakeName, state, prev) => {
      const existingNav = prev?.navigation || {};
      const ramps = existingNav.ramps?.length ? JSON.stringify(existingNav.ramps) : '[]';
      const facts = prev?._extractedFacts || [];
      const navFacts = facts.filter(f =>
        /ramp|hazard|shoal|navigation|timber|dam|bridge|tailwater|surge|idle|access/i.test(f.category + ' ' + f.fact)
      ).map(f => `• ${f.fact} (source: ${f.source})`).join('\n');

      return `Navigation data for ${lakeName}.

EXISTING RAMP DATA (from SCDNR — preserve exactly):
${ramps}

EXTRACTED HAZARD FACTS:
${navFacts || 'No navigation facts extracted — derive from lake type and operator.'}

Return ONLY:
{
  "navigation": {
    "ramps": ${ramps},
    "hazards": [],
    "shoals": [],
    "standingTimberAreas": [],
    "idleZones": [],
    "dangerousAreas": [],
    "notes": null
  },
  "sources": []
}
JSON only.`;
    },
    expectedKey: "navigation"
  },

  regulations: {
    label: "Regulations",
    order: 6,
    system: "You are a fishing regulations specialist. Extract fishing regulations from the provided live regulations page content. For each species: check if the lake appears in an exception list. If listed, use the exception rule. If not listed, the statewide rule applies. Return ONLY valid JSON. Never invent limits — if unknown, set null.",
    userTemplate: (lakeName, state, prev) => {
      const facts = (prev?._extractedFacts || [])
        .filter(f => /regulation|creel|limit|season|closed|gear|size.*limit|possession|sizeLimit|creelLimit/i.test(f.category + ' ' + f.fact))
        .slice(0, 30);
      const factsBlock = facts.map(f => `• [${f.category}] ${f.fact} (source: ${f.source})`).join('\n');
      const regsContent = prev?._regsSource?.content
        ? prev._regsSource.content.slice(0, 30000)
        : 'Not available';
      return `Extract fishing regulations for ${lakeName} (${state}).

LIVE REGULATIONS PAGE:
${regsContent}

EXTRACTED REGULATION FACTS (use to fill species-specific fields):
${factsBlock || 'None extracted'}

INSTRUCTIONS:
1. Read the regulations page above carefully
2. For each species, find rows that apply to ${lakeName}
3. If ${lakeName} is in an exception row, use that exception rule
4. If not listed, statewide rule applies
5. Extract rules for: Largemouth Bass, Striped Bass / Hybrid, White Bass, Crappie, Blue Catfish, Channel Catfish, Bream, Chain Pickerel

CRITICAL STRUCTURE RULES — violations will corrupt the profile:
- creelLimits MUST be a JSON object with species name keys. NEVER a string, NEVER an array.
- sizeLimits MUST be a JSON object with species name keys. NEVER a string, NEVER an array.
- specialRules is ONLY for gear restrictions (trotlines, traps, slot limits, unusual rules). NEVER put creel or size limits here.
- Every species you find a creel limit for MUST appear as a key in creelLimits.
- Every species you find a size limit for MUST appear as a key in sizeLimits.

CORRECT example for Lake Murray:
"creelLimits": {
  "Striped Bass / Hybrid": "5",
  "Largemouth Bass": "5 combined black bass",
  "Crappie": "20",
  "White Bass": "10",
  "Bream": "30",
  "Blue Catfish": "25",
  "Chain Pickerel": "30"
}
"sizeLimits": {
  "Largemouth Bass": "14 inches min",
  "Striped Bass / Hybrid": "Oct. 1 - May 31: 21 inches min; June 1 - Sept. 30: any length",
  "Crappie": "8 inches min"
}

WRONG — do NOT do this:
"creelLimits": "The crappie regulation is 20 fish per day"  ← STRING, NOT ALLOWED
"creelLimits": ["20 crappie per day"]  ← ARRAY, NOT ALLOWED

Return ONLY valid JSON:
{
  "regulations": {
    "state": "${state || 'SC'}",
    "lakeSpecificRegulations": {
      "hasExceptions": true,
      "creelLimits": {},
      "sizeLimits": {},
      "closedSeasons": [],
      "specialRules": []
    },
    "notes": "Verify at official agency site before fishing."
  },
  "sources": [{"label":"eRegulations SC Freshwater Fishing","url":"https://www.eregulations.com/southcarolina/fishing","trust":"OFFICIAL"}]
}
JSON only. Never output a string or array for creelLimits or sizeLimits.`;
    },
    expectedKey: "regulations"
  },

  fisheries: {
    label: "Species Intelligence",
    order: 7,
    system: "You are a fisheries biologist and professional fishing guide. You are given a verified lake profile AND raw text from source documents (fishing guides, reports, agency surveys). Extract seasonal species behavior from BOTH the profile AND the source documents. CONSENSUS RULE: When multiple sources cover the same species/season, use the depth range and structure that appears in the majority of sources. If sources contradict (e.g. 3 say 15-25ft and 1 says 5ft), use the majority position and note the discrepancy in the notes field. Do not average contradicting values — pick the consensus. Do not invent data when sources are silent — return null for that season. Prioritize official agency documents over fishing guide content when they conflict. Do NOT recommend routes, speeds, or specific lure colors. CRITICAL: Only include species listed in the biology.predatorSpecies array. Return JSON only.",
    userTemplate: (lakeName, state, prev) => {
      const bio = prev?.biology || prev?.forage || {};
      const confirmedSpecies = Array.isArray(bio.predatorSpecies) ? bio.predatorSpecies : [];
      const speciesList = confirmedSpecies.length > 0 ? confirmedSpecies : ['(none confirmed — biology section empty)'];
      const speciesArrayStr = speciesList.map(s => `"${s}"`).join(', ');
      const exampleSpecies = speciesList[0] || 'SpeciesName';
      const primaryForage = Array.isArray(bio.primaryForage) ? bio.primaryForage : (typeof bio.primaryForage === 'string' ? [bio.primaryForage] : []);
      const secondaryForage = Array.isArray(bio.secondaryForage) ? bio.secondaryForage : (typeof bio.secondaryForage === 'string' ? [bio.secondaryForage] : []);
      const allForage = [...primaryForage, ...secondaryForage];
      const forageStr = allForage.length > 0 ? allForage.join(', ') : 'unknown';
      const docSection = prev?._documentContext
        ? `\n\nSOURCE DOCUMENTS (extract seasonal depth, structure, and behavior from these — this is primary evidence):\n${prev._documentContext}`
        : '';
      return `You are given a verified lake profile and source documents. Extract seasonal fishing intelligence from BOTH.

Lake: ${lakeName}
Lake profile (use for confirmed species, forage, limnology context):
${JSON.stringify(prev, null, 2).slice(0, 12000)}
${docSection}

CONFIRMED SPECIES (ONLY these — do not add others):
${speciesList.join(', ')}

CONFIRMED LAKE FORAGE: ${forageStr}
Use forage intelligently — match what each predator species actually eats, not the full lake forage list:
- Striped Bass / Largemouth Bass / Spotted Bass: primary forage is shad (threadfin, gizzard, blueback herring)
- Crappie: small shad, minnows
- Catfish: shad, bream, crawfish — opportunistic
- Bluegill / Panfish: insects, small invertebrates, tiny minnows — NOT shad or herring
- If source documents specify forage for a species/season, use exactly that
- If documents are silent, use species-appropriate forage from the confirmed lake list
- Never assign the full lake forage list to every species — that is wrong

Task: For each confirmed species, extract seasonal depth ranges, key structures, forage, and behavior notes from the source documents above. Use the profile (thermocline, oxygen floor, forage) to fill gaps where documents are silent. This is stable long-term intelligence, not a daily plan.

CRITICAL SPECIES COVERAGE: Every species in the confirmed list MUST appear in trollingIntelligence, even if some seasons are null. For species with seasonal closures (e.g. Striped Bass closed June-August on Lake Marion), still include all four seasons — use null for closed/unknown seasons, but populate open seasons from document evidence. Do not silently omit any confirmed species.

SPECIFIC EXTRACTION TARGETS — look for these in the source documents:
- Striped Bass spring: look for "pre-spawn", "staging", "spawning tributaries", "spring run", "March", "April", "May", "58-68°F" — extract depth, structure, forage from that context
- Striped Bass fall: look for "October", "fall striper", "post-closure", "schooling" — extract what you find
- Largemouth Bass winter: look for "cold water", "winter bass", "January", "February", "deep timber", "creek channels in winter", "jigs spoons worms" — if a doc says "bass move back to deep water where jigs, spoons and heavily weighted worms are productive" that is winter LMB data; populate notes even if no explicit depth is given
- Striped Bass winter: look for "deep water", "shiner minnows", "drifting", "winter striper" — if a doc says "stripers are in deep water where drifting with large shiner minnows is effective" that is winter striper data; populate notes and use depth from fall as estimate if no winter depth stated
- If a document says "pre-spawn striped bass staging near spawning tributaries following shad schools" — that is spring striper data, extract it

If a document gives specific depth ranges or seasonal behavior for a species on ${lakeName}, use it — do not replace document evidence with generic inferences.

SCHEMA RULES — every season entry MUST follow this exact structure, no exceptions:
{
  "preferredDepth": [minFt, maxFt],   ← 2-element number array, or null if truly unknown
  "structures": [],                    ← array of strings, never omit this key
  "forage": [],                        ← array of strings, never omit this key
  "recommendedPresentations": [],      ← array of strings, never omit this key
  "notes": ""                          ← string or null, never omit this key
}

NEVER output a bare array like [5, 12] for a season — that is invalid. Every season must be a full object or null.
If you only know the depth range for a species but not structures/forage, still return the full object with preferredDepth populated and empty arrays for the rest.
If a season is completely unknown, use null for that season entry.

Return ONLY:
{
  "trollingIntelligence": {
    "${exampleSpecies}": {
      "summer": {
        "preferredDepth": [12,18],
        "structures": ["channel ledges","creek mouths","long points"],
        "forage": ["Threadfin Shad"],
        "recommendedPresentations": ["MR Crankbait","DD Crankbait","A-Rig"],
        "notes": "behavior notes drawn from source documents"
      },
      "fall": {"preferredDepth":[8,15],"structures":[],"forage":[],"recommendedPresentations":[],"notes":""},
      "winter": {"preferredDepth":[20,35],"structures":[],"forage":[],"recommendedPresentations":[],"notes":""},
      "spring": {"preferredDepth":[5,15],"structures":[],"forage":[],"recommendedPresentations":[],"notes":""}
    }
  },
  "sources": [{"label":"Derived from lake profile and source documents","trust":"DERIVED"}]
}

Species list MUST be ONLY: [${speciesArrayStr}] — do NOT add species not in this list.
preferredDepth MUST be a 2-element number array [minDepthFt, maxDepthFt] or null — NEVER a bare array at the season level.
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
      NC: 'https://www.eregulations.com/northcarolina/fishing/warm-water-game-fish-regulations',
      GA: 'https://www.eregulations.com/georgia/fishing/game-species-daily-limits',
      TN: 'https://www.tn.gov/twra/fishing/regulations.html',
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
          .slice(0, 30000);
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
  // fisheries gets fishing guide/report docs — seasonal behavior lives in these, not the profile
  // identity uses _extractedFacts only — raw docs make prompt too large for Cerebras TPM
  const docInjectionAgents = new Set(['limnology', 'biology', 'habitat', 'fisheries']);
  if (docInjectionAgents.has(agentKey) && previousResults._normalizedDocuments?.length) {
    const docFilter = {
      limnology: /epa|nscep|water.?qual|characteriz|nutrient|limnol/i,
      identity:  /epa|nscep|water.?qual|characteriz|sc.?lake|dnr/i,
      biology:   /striped.?bass|fisheries|biology|annual|species|stocking|fish|bass|crappie|catfish|pattern|forage|shad|herring|omnia|conventional|sportsman|tactic|guide/i,
      habitat:   /habitat|attractor|structure|dnr|sc.?lake/i,
      fisheries: /fish|bass|crappie|striper|catfish|pattern|season|depth|behavior|report|tactic|guide|omnia|conventional|sportsman/i,
    };
    const filter = docFilter[agentKey];
    // Gemini free-tier requests must stay comfortably below token-per-minute
    // limits. Limnology already receives extracted facts, so two focused source
    // excerpts are enough for table/profile confirmation; eight large docs made
    // the paid/free model route hit quota while biology still succeeded.
    const maxDocs = agentKey === 'limnology' ? 2 : agentKey === 'fisheries' ? 8 : 8;
    const charsPerDoc = agentKey === 'limnology' ? 15000 : agentKey === 'fisheries' ? 150000 : 40000;
    const relevantDocs = previousResults._normalizedDocuments
      .filter(d => !filter || filter.test(d.title + ' ' + d.url))
      .slice(0, maxDocs);
    if (relevantDocs.length) {
      const docContext = relevantDocs
        .map(d => `=== ${d.title} ===\n${d.text?.slice(0, charsPerDoc) || ''}`)
        .join('\n\n');
      groundedPrev = {
        ...groundedPrev,
        _documentContext: docContext,
        _documentContextNote: `Raw document text from ${relevantDocs.length} source(s) — use this for specific measurements, tables, and depth profiles. Prioritize this over training knowledge.`
      };
    }
  }

  // For regulations agent — filter facts to only regulation-relevant ones to keep prompt size manageable
  if (agentKey === 'regulations' && groundedPrev._extractedFacts?.length) {
    const regsCats = new Set(['sizeLimit_lakeSpecific','creelLimit_lakeSpecific','sizeLimit_general',
      'creelLimit_general','closedSeason','gearRestrictions','regulations_general','regulations']);
    groundedPrev = {
      ...groundedPrev,
      _extractedFacts: groundedPrev._extractedFacts
        .filter(f => regsCats.has(f.category) || /regulation|creel|limit|season|closed|gear|size.*limit|possession/i.test(f.category + ' ' + f.fact))
        .slice(0, 40)  // cap at 40 facts max
    };
  }

  // ── Fisheries agent: run one LLM call per species group for focused extraction ──
  // Running all 17 species in one call causes token budget compression — striper spring
  // and other minority-season data gets dropped. Split into groups, merge results.
  if (agentKey === 'fisheries') {
    const bio = groundedPrev?.biology || {};
    const allSpecies = Array.isArray(bio.predatorSpecies) ? bio.predatorSpecies : [];

    // Dedup species before grouping:
    // Black Crappie / White Crappie are redundant with Crappie for trolling intel purposes
    // Merge them all into a single 'Crappie' representative to avoid 3 near-identical calls
    const SPECIES_MERGE = {
      'Black Crappie': 'Crappie',
      'White Crappie': 'Crappie',
      'Redear Sunfish Shellcracker': 'Redear Sunfish (Shellcracker)',
      'Redear Sunfish': 'Redear Sunfish (Shellcracker)',
    };
    const deduped = [];
    const dedupSeen = new Set();
    for (const s of allSpecies) {
      const canonical = SPECIES_MERGE[s] || s;
      if (!dedupSeen.has(canonical)) { dedupSeen.add(canonical); deduped.push(canonical); }
    }

    // Group species by fishing category
    const SPECIES_GROUPS = {
      bass:    ['Largemouth Bass', 'Smallmouth Bass', 'Spotted Bass', 'Alabama Bass', 'Striped Bass', 'White Bass', 'Yellow Bass', 'Redeye Bass'],
      crappie: ['Crappie'],
      catfish: ['Catfish', 'Blue Catfish', 'Flathead Catfish', 'Channel Catfish', 'Bullhead'],
      panfish: ['Bream', 'Bluegill', 'Redear Sunfish (Shellcracker)', 'Bowfin', 'White Perch', 'Yellow Perch', 'Walleye', 'Sauger'],
      other:   ['Pickerel', 'Chain Pickerel', 'Pike', 'Muskie', 'Trout', 'Brown Trout', 'Rainbow Trout', 'Brook Trout'],
    };

    // Assign each confirmed species to a group
    const grouped = {};
    const assigned = new Set();
    for (const [group, members] of Object.entries(SPECIES_GROUPS)) {
      const matched = deduped.filter(s => members.some(m => s.toLowerCase().includes(m.toLowerCase()) || m.toLowerCase().includes(s.toLowerCase())));
      if (matched.length) { grouped[group] = matched; matched.forEach(s => assigned.add(s)); }
    }
    // Any unmatched species go into 'other'
    const unmatched = deduped.filter(s => !assigned.has(s));
    if (unmatched.length) grouped['other'] = [...(grouped['other'] || []), ...unmatched];

    const groupEntries = Object.entries(grouped).filter(([, sp]) => sp.length > 0);
    console.log(`fisheries agent: ${allSpecies.length} species split into ${groupEntries.length} groups: ${groupEntries.map(([g,sp]) => `${g}(${sp.length})`).join(', ')}`);

    // Build a per-group prompt using the same userTemplate but with a filtered species list
    const buildGroupPrompt = (groupSpecies) => {
      const groupPrev = { ...groundedPrev, biology: { ...bio, predatorSpecies: groupSpecies } };
      return agent.userTemplate(lakeName, state, groupPrev);
    };

    // Run all groups concurrently
    const groupPromises = groupEntries.map(async ([groupName, groupSpecies]) => {
      const userPrompt = buildGroupPrompt(groupSpecies);
      const payload = {
        messages: [
          { role: "system", content: agent.system },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.1,
        max_tokens: 5000,
        response_format: { type: "json_object" }
      };
      try {
        const llmResult = await callLLM(env, payload, null);
        const rawText = extractLLMText(llmResult.data);
        const parsed = extractJsonPossibly(rawText);
        if (!parsed) {
          console.warn(`fisheries group ${groupName}: non-JSON response`);
          return {};
        }
        return parsed.trollingIntelligence || parsed[agentKey] || parsed || {};
      } catch (e) {
        console.warn(`fisheries group ${groupName} failed: ${e.message}`);
        return {};
      }
    });

    const groupResults = await Promise.all(groupPromises);

    // Merge all group results into single trollingIntelligence object
    const mergedIntelligence = {};
    for (const groupResult of groupResults) {
      for (const [species, seasons] of Object.entries(groupResult)) {
        if (species === 'sources') continue;
        mergedIntelligence[species] = seasons;
      }
    }

    // Run normalization pass (same as post-processing below)
    const SEASONS = ['spring', 'summer', 'fall', 'winter'];
    const normalizedMerged = {};
    for (const [species, seasons] of Object.entries(mergedIntelligence)) {
      if (!seasons || typeof seasons !== 'object') { normalizedMerged[species] = seasons; continue; }
      const normSeasons = {};
      for (const season of SEASONS) {
        const entry = seasons[season];
        if (entry === null || entry === undefined) {
          normSeasons[season] = null;
        } else if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'number') {
          normSeasons[season] = { preferredDepth: entry, structures: [], forage: [], recommendedPresentations: [], notes: null };
        } else if (typeof entry === 'object' && !Array.isArray(entry)) {
          normSeasons[season] = {
            preferredDepth: Array.isArray(entry.preferredDepth) && entry.preferredDepth.length === 2 ? entry.preferredDepth : null,
            structures: Array.isArray(entry.structures) ? entry.structures : [],
            forage: Array.isArray(entry.forage) ? entry.forage : [],
            recommendedPresentations: Array.isArray(entry.recommendedPresentations) ? entry.recommendedPresentations : [],
            notes: entry.notes || null
          };
        } else {
          normSeasons[season] = null;
        }
      }
      normalizedMerged[species] = normSeasons;
    }

    const elapsed = Date.now();
    return new Response(JSON.stringify({
      success: true,
      agent: agentKey,
      section: normalizedMerged,
      confidence: { percent: 35 },
      meta: { model: 'multi-group', provider: 'gemini-free' },
      sources: [{ label: 'Derived from lake profile and source documents', trust: 'DERIVED' }]
    }), { headers: JSON_HEADERS });
  }

  const systemPrompt = agent.system;
  const userPrompt = agent.userTemplate(lakeName, state, groundedPrev);
  
  // Safety check — if prompt is too large, truncate _extractedFacts further
  const promptLen = systemPrompt.length + userPrompt.length;
  if (promptLen > 80000 && groundedPrev._extractedFacts?.length > 5) {
    console.warn(`handleResearchAgent: ${agentKey} prompt too large (${promptLen} chars) — truncating facts`);
    groundedPrev = { ...groundedPrev, _extractedFacts: groundedPrev._extractedFacts.slice(0, 5) };
  }

  const payload = {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.1,
    max_tokens: agentKey === 'trolling' ? 2000 : agentKey === 'summary' ? 800 : agentKey === 'fisheries' ? 8000 : 3000,
    response_format: { type: "json_object" }
  };

  const start = Date.now();
  let llmResult;
  try {
    // Use the exact same default free-tier routing chain as biology, habitat,
    // identity, and regulations. Limnology used to force the Gemini route,
    // bypassing the successful default fallback/rate routing used by the other
    // agents even when they ultimately reported Flash-Lite.
    llmResult = await callLLM(env, payload, null);
  } catch (e) {
    return new Response(JSON.stringify({success:false, error:`LLM failed: ${e.message}`, agent: agentKey, lakeName}), {status: 502, headers: JSON_HEADERS});
  }
  const rawText = extractLLMText(llmResult.data);
  const parsed = extractJsonPossibly(rawText);
  if (!parsed) {
    return new Response(JSON.stringify({success:false, error:"Agent returned non-JSON", raw: rawText.slice(0, 800), agent: agentKey}), {status: 502, headers: JSON_HEADERS});
  }

  const dataKey = agent.expectedKey;
  let sectionData = (parsed[dataKey] && Object.keys(parsed[dataKey]).length > 0) ? parsed[dataKey] : (parsed[agentKey] && Object.keys(parsed[agentKey] || {}).length > 0) ? parsed[agentKey] : parsed;
  const sources = parsed.sources || sectionData?.sources || [];

  // Sanitize limnology output — coerce string "null" and range strings to proper types
  if (agentKey === 'limnology' && sectionData) {
    const lim = sectionData;
    const coerceNum = (v) => {
      if (v === null || v === undefined) return null;
      if (typeof v === 'number') return v;
      if (typeof v === 'string') {
        if (v === 'null' || v === '' || v === 'unknown') return null;
        // Range string like "16-22" — take midpoint
        const rangeMatch = v.match(/^([\d.]+)\s*[-–]\s*([\d.]+)$/);
        if (rangeMatch) return Math.round((parseFloat(rangeMatch[1]) + parseFloat(rangeMatch[2])) / 2);
        const num = parseFloat(v);
        return isFinite(num) ? num : null;
      }
      return null;
    };
    if (lim.thermocline) {
      lim.thermocline.summerDepthFt = coerceNum(lim.thermocline.summerDepthFt);
    }
    if (lim.oxygen) {
      lim.oxygen.depletionDepthFt = coerceNum(lim.oxygen.depletionDepthFt);
      lim.oxygen.anoxicBelowFt = coerceNum(lim.oxygen.anoxicBelowFt);
    }
    if (lim.waterClarity) {
      lim.waterClarity.secchiFt = coerceNum(lim.waterClarity.secchiFt);
    }
    lim.hydraulicRetentionDays = coerceNum(lim.hydraulicRetentionDays) ?? lim.hydraulicRetentionDays;
    lim.seasonalDrawdownFt = coerceNum(lim.seasonalDrawdownFt) ?? lim.seasonalDrawdownFt;
  }

  // Sanitize regulations output — fix malformed creelLimits/sizeLimits
  // Agent sometimes returns these as strings or arrays instead of {species: limit} objects
  if (agentKey === 'regulations' && sectionData) {
    const cleanCreel = {};
    const cleanSize = {};
    const lsr = sectionData.lakeSpecificRegulations || {};

    // If creelLimits/sizeLimits came back as a string or array, they're malformed — discard them
    // so the deterministic parser's correct values aren't overwritten with garbage
    const creelSource = (lsr.creelLimits && typeof lsr.creelLimits === 'object' && !Array.isArray(lsr.creelLimits))
      ? lsr.creelLimits : {};
    const sizeSource = (lsr.sizeLimits && typeof lsr.sizeLimits === 'object' && !Array.isArray(lsr.sizeLimits))
      ? lsr.sizeLimits : {};

    // Only keep properly keyed species entries (not creel_0, creel_1, size_0, etc.)
    const numberedKeyPattern = /^(creel|size|limit)_\d+$/i;
    for (const [k, v] of Object.entries(creelSource)) {
      if (!numberedKeyPattern.test(k) && typeof v === 'string') cleanCreel[k] = v;
    }
    for (const [k, v] of Object.entries(sizeSource)) {
      if (!numberedKeyPattern.test(k) && typeof v === 'string') cleanSize[k] = v;
    }
    // Also filter specialRules — remove nongame device garbage and misplaced creel/size rules
    const cleanSpecialRules = (lsr.specialRules || []).filter(r =>
      typeof r === 'string' && r.length < 200 && !/Allowable Nongame Devices|Marking of Nongame|Facebook RSS/i.test(r)
      && !/\d+\s*(inch|in\b|fish|per day|creel|possession|limit)/i.test(r) // misplaced limits
    );

    sectionData = {
      ...sectionData,
      lakeSpecificRegulations: {
        ...lsr,
        creelLimits: cleanCreel,
        sizeLimits: cleanSize,
        specialRules: cleanSpecialRules
      }
    };
  }

  // Normalize habitat output — fix string fields that should be arrays
  // The habitat agent sometimes writes cover/riprapLocations/namedCreekMouths as comma-separated strings
  if (agentKey === 'habitat' && sectionData && typeof sectionData === 'object') {
    const ARRAY_FIELDS = ['cover', 'riprapLocations', 'namedCreekMouths', 'artificialHabitat'];
    for (const field of ARRAY_FIELDS) {
      const val = sectionData[field];
      if (typeof val === 'string' && val.trim()) {
        // Convert comma-separated string to array
        sectionData[field] = val.split(',').map(s => s.trim()).filter(Boolean);
      } else if (val == null) {
        sectionData[field] = [];
      }
    }
  }

  // Normalize trollingIntelligence — fix bare array season entries like [5, 15]
  // Agent sometimes shortcuts secondary species to just a depth array instead of full season object
  if (agentKey === 'fisheries' && sectionData && typeof sectionData === 'object') {
    console.log(`[fisheries-debug] sectionData keys: ${Object.keys(sectionData).join(', ')}`);
    console.log(`[fisheries-debug] first entry sample: ${JSON.stringify(Object.entries(sectionData)[0])?.slice(0, 200)}`);
    const SEASONS = ['spring', 'summer', 'fall', 'winter'];
    const normalized = {};
    for (const [species, seasons] of Object.entries(sectionData)) {
      if (species === 'sources') { normalized[species] = seasons; continue; }
      if (!seasons || typeof seasons !== 'object') { normalized[species] = seasons; continue; }
      const normSeasons = {};
      for (const season of SEASONS) {
        const entry = seasons[season];
        if (entry === null || entry === undefined) {
          normSeasons[season] = null;
        } else if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'number') {
          // Bare depth array — promote to full season object
          normSeasons[season] = {
            preferredDepth: entry,
            structures: [],
            forage: [],
            recommendedPresentations: [],
            notes: null
          };
        } else if (typeof entry === 'object' && !Array.isArray(entry)) {
          // Full object — ensure all required keys present
          normSeasons[season] = {
            preferredDepth: Array.isArray(entry.preferredDepth) && entry.preferredDepth.length === 2 ? entry.preferredDepth : null,
            structures: Array.isArray(entry.structures) ? entry.structures : [],
            forage: Array.isArray(entry.forage) ? entry.forage : [],
            recommendedPresentations: Array.isArray(entry.recommendedPresentations) ? entry.recommendedPresentations : [],
            notes: entry.notes || null
          };
        } else {
          normSeasons[season] = null;
        }
      }
      normalized[species] = normSeasons;
    }
    sectionData = normalized;
  }

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

// ─── PER-AGENT PIPELINE ENDPOINT ───
// Orchestrates: discover → fetch → extract → enrich for a SINGLE agent
// POST /research/agent { lakeName, state, agent, mode, targetFields, previousResults }
async function handleResearchAgentPipeline(request, env) {
  let body;
  try { body = await request.json(); } catch { return new Response(JSON.stringify({success:false, error:"invalid JSON body"}), {status:400, headers:JSON_HEADERS}); }
  const lakeName = String(body.lakeName || body.lake || '').trim();
  const state = String(body.state || '').trim() || 'SC';
  const agentKey = String(body.agent || '').trim().toLowerCase();
  const mode = String(body.mode || 'full').trim(); // 'full' or 'resume'
  const targetFields = Array.isArray(body.targetFields) ? body.targetFields : [];
  const previousResults = body.previousResults || {};

  if (!lakeName) return new Response(JSON.stringify({success:false, error:"missing lakeName"}), {status:400, headers:JSON_HEADERS});
  if (!agentKey) return new Response(JSON.stringify({success:false, error:"missing agent"}), {status:400, headers:JSON_HEADERS});
  if (!RESEARCH_AGENTS[agentKey]) return new Response(JSON.stringify({success:false, error:`unknown agent ${agentKey}`}), {status:400, headers:JSON_HEADERS});

  try {
    // Step 1: Discover sources for this agent
    const discoverReq = new Request('internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lakeName, state, agent: agentKey, reservoirOwner: body.reservoirOwner, predatorSpecies: body.predatorSpecies })
    });
    const discoverRes = await handleResearchDiscover(discoverReq, env);
    if (!discoverRes.ok) throw new Error(`Discover failed: ${discoverRes.status}`);
    const discoverData = await discoverRes.json();
    if (!discoverData.success) throw new Error(discoverData.error || 'Discovery failed');
    const sources = discoverData.sources || [];

    // Filter sources for this agent
    const agentSources = sources.filter(s => s.agentTags?.includes(agentKey) || !s.agentTags);
    if (!agentSources.length) {
      return new Response(JSON.stringify({ success: true, agent: agentKey, section: {}, factsCount: 0, docsUsed: 0, note: 'No sources found for this agent' }), { headers: JSON_HEADERS });
    }

    // Step 2: Fetch/normalize documents (if mode=full) or load existing (if mode=resume)
    let normalizedDocuments = [];
    if (mode === 'full') {
      // Regulations agent: data is in KV-cached deterministic facts — no docs needed
      if (agentKey === 'regulations') {
        console.log(`[agent-pipeline] regulations: skipping fetch — data from deterministic facts KV cache`);
      } else {
        // Load existing normalized docs for this lake — skip anything already fresh
        let existingDocs = [];
        try {
          const normRes = await handleResearchGetNormalized(env, lakeName);
          if (normRes.ok) {
            const normData = await normRes.json();
            existingDocs = normData.documents || [];
          }
        } catch (_) {}

        // TTL map by source type — how long before we refetch (ms)
        const TTL_MS = {
          academic:   365 * 24 * 60 * 60 * 1000, // SEAFWA, USGS, EPA surveys — static forever
          official:   90  * 24 * 60 * 60 * 1000, // SCDNR, eRegulations, FERC — annual cycles
          news:       30  * 24 * 60 * 60 * 1000, // SCDNR news, stocking updates
          anecdotal:  14  * 24 * 60 * 60 * 1000, // fishing reports, tournament results, social
        };

        function getDocTtl(url) {
          const u = String(url || '').toLowerCase();
          if (/seafwa\.org|usgs\.gov|nepis\.epa\.gov|epa\.gov|asmfc\.org|apms\.org|seafwa|\.edu/.test(u)) return TTL_MS.academic;
          if (/dnr\.sc\.gov|ncwildlife\.org|georgiawildlife|tn\.gov|eregulations\.com|ferc\.gov|duke-energy\.com|santeecooper\.com|usace\.army\.mil/.test(u)) return TTL_MS.official;
          if (/news|report|stocking|annual|trends|freshwater\.html|fishing-report/.test(u)) return TTL_MS.news;
          return TTL_MS.anecdotal;
        }

        const existingByUrl = new Map(existingDocs.map(d => [String(d.url || '').split('?')[0].toLowerCase(), d]));
        const now = Date.now();

        for (const src of agentSources) {
          // Skip PDF/HTML already in R2 and still fresh
          const normUrl = String(src.url || '').split('?')[0].toLowerCase();
          const existing = existingByUrl.get(normUrl);
          if (existing?.fetchedAt) {
            // If we have an etag, use conditional fetch — let the origin tell us if it changed
            if (existing.etag) {
              try {
                const condResult = await tinyfishFetch({
                  urls: [src.url],
                  format: 'markdown',
                  if_none_match: existing.etag,
                  include_etag_and_last_modified: true,
                  ttl: 0 // bypass TinyFish cache for conditional check
                }, env);
                const condPage = condResult.results?.[0];
                if (condPage?.not_modified) {
                  console.log(`[agent-pipeline] etag hit (not modified): ${src.url.slice(0,80)}`);
                  const merged = { ...existing, agentTags: [...new Set([...(existing.agentTags || []), agentKey])] };
                  normalizedDocuments.push(merged);
                  existingByUrl.set(normUrl, merged);
                  continue;
                } else if (condPage?.text && condPage.text.length > 200) {
                  console.log(`[agent-pipeline] etag miss (content changed): ${src.url.slice(0,80)}`);
                  const doc = {
                    title: src.title, url: src.url, fullText: condPage.text,
                    agentTags: [...new Set([...(src.agentTags || [agentKey]), agentKey])],
                    discoveredBy: src.discoveredBy || agentKey,
                    fetchedAt: new Date().toISOString(),
                    etag: condPage.etag || null,
                    lastModified: condPage.last_modified || null,
                  };
                  normalizedDocuments.push(doc);
                  existingByUrl.set(normUrl, doc);
                  continue;
                }
                // Fall through to full fetch if conditional fetch failed
              } catch (condErr) {
                console.warn(`[agent-pipeline] conditional fetch failed for ${src.url}: ${condErr.message} — falling through to full fetch`);
              }
            } else {
              // No etag — fall back to TTL-based check
              const age = now - new Date(existing.fetchedAt).getTime();
              const ttl = getDocTtl(src.url);
              if (age < ttl) {
                console.log(`[agent-pipeline] cache hit (${Math.round(age/86400000)}d old, ttl ${Math.round(ttl/86400000)}d): ${src.url.slice(0,80)}`);
                const merged = { ...existing, agentTags: [...new Set([...(existing.agentTags || []), agentKey])] };
                normalizedDocuments.push(merged);
                existingByUrl.set(normUrl, merged);
                continue;
              } else {
                console.log(`[agent-pipeline] cache stale (${Math.round(age/86400000)}d old, ttl ${Math.round(ttl/86400000)}d) — refetching: ${src.url.slice(0,80)}`);
              }
            }
          }

          // Not cached or stale — fetch it
          try {
            const proxyReq = new Request(`https://internal/research/proxy-download?url=${encodeURIComponent(src.url)}&type=${src.type || 'HTML'}`, {
              method: 'GET',
            });
            const proxyRes = await handleResearchProxyDownload(proxyReq, env);
            if (proxyRes.ok) {
              const xSource = proxyRes.headers?.get('X-Source') || 'unknown';
              const xEtag = proxyRes.headers?.get('ETag') || proxyRes.headers?.get('X-ETag') || null;
              const xLastModified = proxyRes.headers?.get('Last-Modified') || proxyRes.headers?.get('X-Last-Modified') || null;
              // Content-Type determines text vs binary — TinyFish returns text/plain even for
              // PDF URLs it extracted. Only binary application/pdf needs PDF.js on the Worker
              // side; but Workers don't have PDF.js — binary PDFs must be returned to client.
              // So here we accept text responses and skip binary ones (client handles via
              // lake-research-engine.js which has PDF.js access).
              const ct = proxyRes.headers?.get('Content-Type') || '';
              let text = '';
              if (ct.includes('application/pdf')) {
                // Binary PDF came back — this shouldn't happen in Worker-side pipeline
                // (proxy-download should have extracted it via TinyFish). Log and skip;
                // the client-side runner (lake-research-engine.js) will handle this URL
                // with PDF.js when it processes the source list directly.
                console.warn(`[agent-pipeline] binary PDF returned by proxy for ${src.url.slice(0,80)} — skipping Worker-side; client will handle`);
              } else {
                text = await proxyRes.text();
              }
              if (text && text.length > 200) {
                const doc = {
                  title: src.title, url: src.url, fullText: text,
                  agentTags: src.agentTags || [agentKey],
                  discoveredBy: src.discoveredBy || agentKey,
                  fetchedAt: new Date().toISOString(),
                  etag: xEtag,
                  lastModified: xLastModified,
                  snippet: src.snippet || null,
                  siteName: src.siteName || null,
                  publishedDate: src.publishedDate || null,
                  prefetchScore: src.prefetchScore || null,
                };
                normalizedDocuments.push(doc);
                existingByUrl.set(normUrl, doc);
                console.log(`[agent-pipeline] fetched (${xSource}, ${text.length} chars): ${src.url.slice(0,80)}`);
              } else if (!ct.includes('application/pdf')) {
                console.warn(`[agent-pipeline] fetch returned insufficient content (${text.length} chars) via ${xSource}: ${src.url.slice(0,80)}`);
              }
            } else {
              console.warn(`[agent-pipeline] proxy download HTTP ${proxyRes.status} for ${src.url.slice(0,80)}`);
            }
          } catch (e) {
            console.warn(`Proxy download failed for ${src.url}: ${e.message}`);
          }
        }

        // Merge new/updated docs back into R2 — don't overwrite docs from other agents
        if (normalizedDocuments.length) {
          // Build merged list: existing docs not touched by this run + new/refreshed docs
          const updatedUrls = new Set(normalizedDocuments.map(d => String(d.url || '').split('?')[0].toLowerCase()));
          const untouched = existingDocs.filter(d => !updatedUrls.has(String(d.url || '').split('?')[0].toLowerCase()));
          const merged = [...untouched, ...normalizedDocuments];
          const saveReq = new Request('internal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lakeName, documents: merged })
          });
          await handleResearchSaveNormalized(saveReq, env);
        }
      }
    } else {
      // Resume mode: load existing normalized docs and filter by agentTags
      const normRes = await handleResearchGetNormalized(env, lakeName);
      if (normRes.ok) {
        const normData = await normRes.json();
        normalizedDocuments = (normData.documents || []).filter(d => d.agentTags?.includes(agentKey));
      }
    }

    if (!normalizedDocuments.length) {
      return new Response(JSON.stringify({ success: true, agent: agentKey, section: {}, factsCount: 0, docsUsed: 0, note: 'No documents available for this agent' }), { headers: JSON_HEADERS });
    }

    // Step 3: Extract facts with targetFields
    const analyzeReq = new Request('internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lakeName,
        baseName: lakeName.replace(/^Lake\s+/i,'').replace(/,\s*(SC|NC|GA|TN)(\/(?:SC|NC|GA|TN))*\s*$/i,'').trim(),
        state,
        docIndex: 0,
        documents: normalizedDocuments.slice(0, 12).map(d => ({ title: d.title, url: d.url, text: d.fullText?.slice(0, 150000) }))
      })
    });
    const analyzeRes = await handleResearchAnalyzeFacts(analyzeReq, env);
    if (!analyzeRes.ok) throw new Error(`Analyze facts failed: ${analyzeRes.status}`);
    const analyzeData = await analyzeRes.json();
    const extractedFacts = analyzeData.extracted_facts || [];

    // Step 4: Deduplicate
    const dedupeReq = new Request('internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ facts: extractedFacts })
    });
    const dedupeRes = await handleResearchDedupeContradictions(dedupeReq, env);
    let uniqueFacts = extractedFacts;
    if (dedupeRes.ok) {
      const dedupeData = await dedupeRes.json();
      uniqueFacts = dedupeData.deduplicated_facts || extractedFacts;
    }

    // Step 5: Run agent enrichment
    const agentReq = new Request('internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lakeName,
        state,
        agent: agentKey,
        previousResults: {
          ...previousResults,
          _extractedFacts: uniqueFacts,
          _normalizedDocuments: normalizedDocuments.slice(0, agentKey === 'fisheries' ? 25 : 12).map(d => ({ title: d.title, url: d.url, text: d.fullText?.slice(0, agentKey === 'fisheries' ? 150000 : 40000) }))
        }
      })
    });
    const agentRes = await handleResearchAgent(agentReq, env);
    if (!agentRes.ok) throw new Error(`Agent ${agentKey} failed: ${agentRes.status}`);
    const agentData = await agentRes.json();

    return new Response(JSON.stringify({
      success: true,
      agent: agentKey,
      section: agentData.section,
      confidence: agentData.confidence,
      sources: agentData.sources,
      factsCount: uniqueFacts.length,
      docsUsed: normalizedDocuments.length,
      docTitles: normalizedDocuments.map(d => d.title?.slice(0, 80)),
      factsSample: uniqueFacts.slice(0, 5).map(f => `[${f.category}] ${String(f.fact||'').slice(0,80)}`),
      queryLog: discoverData.queryLog || [],
    }), { headers: JSON_HEADERS });

  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message, agent: agentKey }), { status: 502, headers: JSON_HEADERS });
  }
}

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

async function handleResearchGet(env, lakeId) {
  // ── Legacy key redirect: new canonical DNR names → existing R2 profile keys ──
  // When the dropdown switched from hand-typed display names to DNR canonical
  // names, some dual-named lakes (Thurmond/Clarks Hill, Russell) got new
  // sanitized IDs. Redirect so the UI can load existing profiles under either name.
  const LEGACY_PROFILE_KEYS = {
    'lake_thurmond_sc':       'clarks_hill_thurmond_sc_ga',
    'clarks_hill_lake_ga':    'clarks_hill_thurmond_sc_ga',
    'j_strom_thurmond_lake':  'clarks_hill_thurmond_sc_ga',
    'thurmond_lake_sc':       'clarks_hill_thurmond_sc_ga',
    'richard_b_russell_lake': 'lake_russell_sc_ga',
    'lake_russell_ga':        'lake_russell_sc_ga',
    'lake_russell_sc':        'lake_russell_sc_ga',
  };
  let safe = sanitizeLakeId(lakeId);
  const legacySafe = LEGACY_PROFILE_KEYS[safe];
  if (legacySafe) {
    // Check if profile exists under new key first; if not, use legacy key
    const newObj = await env.R2_TROLLMAP_CHARTPACKS.get(`lakes/${safe}.json`).catch(() => null);
    if (!newObj) safe = legacySafe;
  }
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
  const sections = ["identity","limnology","biology","habitat","navigation","regulations","fisheries","summary"];
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
  delete confidence.trollingIntelligence; delete confidence.fisheries;
  let overallConf = confCount ? Math.round(confSum/confCount) : 75;

  // Penalize for null critical fields — 99% with no thermocline depth is misleading
  const lim = incomingProfile.limnology || {};
  const bio = incomingProfile.biology || incomingProfile.forage || {};
  const id = incomingProfile.identity || {};
  const nullPenalties = [];
  const fieldStatus = incomingProfile.fieldStatus || {};
  const confidenceExempt = (path) => ['not_applicable', 'not_available_after_targeted_review'].includes(fieldStatus[path]?.status);
  if (lim.thermocline?.summerDepthFt == null && !confidenceExempt('limnology.thermocline.summerDepthFt')) { overallConf -= 8; nullPenalties.push('thermocline.summerDepthFt'); }
  if (lim.oxygen?.depletionDepthFt == null && !confidenceExempt('limnology.oxygen.depletionDepthFt')) { overallConf -= 6; nullPenalties.push('oxygen.depletionDepthFt'); }
  if (lim.waterClarity?.secchiFt == null && !confidenceExempt('limnology.waterClarity.secchiFt')) { overallConf -= 3; nullPenalties.push('secchiFt'); }
  if (!bio.knownStockings?.length && !confidenceExempt('biology.knownStockings')) { overallConf -= 3; nullPenalties.push('knownStockings'); }
  if (!id.damName && !confidenceExempt('identity.damName')) { overallConf -= 2; nullPenalties.push('damName'); }
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
    trollingIntelligence: incomingProfile.trollingIntelligence || incomingProfile.trolling || incomingProfile.fisheries || packageParts.trollingIntelligence || packageParts.trolling || packageParts.fisheries || null,
    summary: incomingProfile.summary || packageParts.summary || {},
    evidence: incomingProfile.evidence || packageParts.evidence || {},
    fieldStatus: incomingProfile.fieldStatus || {},
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
  const partKeys = ['identity','limnology','biology','forage','habitat','navigation','regulations','trollingIntelligence','summary','evidence'];
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

async function handleResearchDeleteNormalizedDoc(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || '').trim();
  const docUrl = String(body.url || '').trim();
  if (!lakeName) return new Response(JSON.stringify({ ok: false, error: 'missing lakeName' }), { status: 400, headers: JSON_HEADERS });
  if (!docUrl) return new Response(JSON.stringify({ ok: false, error: 'missing url' }), { status: 400, headers: JSON_HEADERS });

  const safe = sanitizeLakeId(lakeName);
  const key = `lake_packages/${safe}/normalized_documents.json`;
  const obj = await env.R2_TROLLMAP_CHARTPACKS.get(key).catch(() => null);
  if (!obj) return new Response(JSON.stringify({ ok: false, error: 'no normalized documents found' }), { status: 404, headers: JSON_HEADERS });

  let docs;
  try { docs = JSON.parse(await obj.text()); } catch { return new Response(JSON.stringify({ ok: false, error: 'corrupt normalized documents' }), { status: 500, headers: JSON_HEADERS }); }

  const normTarget = docUrl.split('?')[0].toLowerCase();
  const before = docs.length;
  const filtered = docs.filter(d => String(d.url || '').split('?')[0].toLowerCase() !== normTarget);
  const removed = before - filtered.length;

  if (removed === 0) return new Response(JSON.stringify({ ok: false, error: 'document not found in cache', url: docUrl }), { status: 404, headers: JSON_HEADERS });

  await env.R2_TROLLMAP_CHARTPACKS.put(key, JSON.stringify(filtered, null, 2), { httpMetadata: { contentType: 'application/json' } });
  console.log(`[delete-normalized-doc] removed ${removed} doc(s) matching ${docUrl} from ${lakeName}`);
  return new Response(JSON.stringify({ ok: true, lakeName, url: docUrl, removed, remaining: filtered.length }), { headers: JSON_HEADERS });
}

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

async function handleResearchPackageFile(env, lakeId, filename) {
  const safe = sanitizeLakeId(lakeId);
  const key = `lake_packages/${safe}/${filename}`;
  const obj = await env.R2_TROLLMAP_CHARTPACKS.get(key);
  if (!obj) return new Response(JSON.stringify({ok:false, error:`no file ${filename} for ${lakeId}`}), {status:404, headers:JSON_HEADERS});
  const body = await obj.arrayBuffer();
  const ct = filename.endsWith('.json') ? 'application/json' : filename.endsWith('.md') ? 'text/markdown' : 'application/octet-stream';
  return new Response(body, {headers: {...CORS, "Content-Type": ct, "Cache-Control":"no-store"}});
}

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
        trollingIntelligence: researchedProfile.trollingIntelligence,
        fullProfile: researchedProfile
      };
    }
  } catch {}
  return {...curated, researched, hasResearchedProfile: !!researched};
}

async function handleResearchValidationPass(request, env) {
  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ success:false, error:'invalid JSON' }), { status:400, headers:JSON_HEADERS });
  }
  const lakeName = String(body.lakeName || '').trim();
  const nullFields = Array.isArray(body.nullFields) ? body.nullFields.filter(Boolean) : [];
  // The client sends extractedFacts (array); retain facts for backward compatibility.
  const rawFacts = body.extractedFacts || body.facts || [];
  const facts = Array.isArray(rawFacts)
    ? rawFacts.map(f => `[${f.category || 'fact'}] ${f.fact || f.quote || ''}`).filter(Boolean).join('\n')
    : String(rawFacts || '').trim();

  if (!lakeName || !nullFields.length || !facts) {
    return new Response(JSON.stringify({ success:false, error:'missing lakeName, nullFields, or extractedFacts', filled:{} }), { status:400, headers:JSON_HEADERS });
  }

  const prompt = `Fill only requested null fields in a lake research profile for ${lakeName}.

REQUESTED FIELDS:\n${nullFields.join('\n')}

EXTRACTED, SOURCE-BACKED FACTS:\n${facts.slice(0, 30000)}

Return only a JSON object whose keys are requested dot paths and whose values are explicitly supported by the facts. Omit unsupported fields. Do not infer.
Rules: depth values must be specific and convert meters × 3.281; normalPoolFt must be an actual pool elevation, not a fluctuation; trophicStatus must be eutrophic, mesotrophic, oligotrophic, or oligotrophic/mesotrophic. thermocline.strength is qualitative only (for example weak, moderate, strong, distinct); never put a depth, a depth range, feet, or meters in that field.`;
  const payload = {
    messages: [
      { role: 'system', content: 'You are a JSON-only evidence extraction agent. Never guess.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0,
    max_tokens: 800,
    response_format: { type: 'json_object' }
  };
  try {
    const llmResult = await callLLM(env, payload, null);
    const parsed = extractJsonPossibly(extractLLMText(llmResult.data));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return new Response(JSON.stringify({ success:false, error:'validation agent returned non-JSON', filled:{} }), { status:502, headers:JSON_HEADERS });
    }
    const allowed = new Set(nullFields);
    // Accept either the requested flat dot-path object or a defensive
    // { filled: { ... } } wrapper from a provider that follows the endpoint
    // name rather than the prompt literally.
    const candidate = parsed.filled && typeof parsed.filled === 'object' && !Array.isArray(parsed.filled)
      ? parsed.filled : parsed;
    const validFieldValue = (path, value) => {
      if (path === 'limnology.thermocline.strength') {
        const text = String(value || '').toLowerCase();
        // A measurement belongs in summerDepthFt, not the qualitative strength field.
        if (/\b(m|meters?|feet|ft)\b|^\s*\d/.test(text)) return /\b(weak|moderate|strong|distinct)\b/.test(text) && !/\d/.test(text);
      }
      return true;
    };
    const filled = Object.fromEntries(Object.entries(candidate).filter(([path, value]) =>
      allowed.has(path) && value !== null && value !== '' && !(Array.isArray(value) && !value.length) && validFieldValue(path, value)
    ));
    return new Response(JSON.stringify({ success:true, filled, meta:{ provider:llmResult.provider, model:llmResult.model } }), { headers:JSON_HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ success:false, error:String(e.message || e), filled:{} }), { status:502, headers:JSON_HEADERS });
  }
}


async function handleResearchThermoclineSearch(request, env) {
  const body = await request.json().catch(() => ({}));
  const { lakeName } = body;
  if (!lakeName) return new Response(JSON.stringify({ ok: false, error: 'missing lakeName' }), { status: 400, headers: JSON_HEADERS });

  // Strip state suffix for queries
  const queryLake = lakeName.replace(/,\s*(SC|NC|GA|TN)(\/(?:SC|NC|GA|TN))*\s*$/i, '').trim();

  const queries = [
    `"${queryLake}" thermocline depth summer`,
    `"${queryLake}" summer fishing depth water temperature`,
    `"${queryLake}" fishing guide summer depths`,
  ];

  const articles = [];
  const queryResults = [];
  console.log(`[thermocline-search] Starting for ${lakeName} — ${queries.length} queries`);
  for (const q of queries) {
    try {
      console.log(`[thermocline-search] Query: ${q}`);
      const tfResult = await tinyfishSearch({
        query: q,
        domain_type: 'web',
        purpose: `Find thermocline depth and summer fishing depth information for ${queryLake}`,
        location: 'US',
        language: 'en',
      }, env);
      const results = tfResult.results || [];
      let added = 0;
      for (const r of results) {
        const content = r.snippet || r.description || r.summary || r.markdown || r.content || '';
        if (!r.url || !content) continue;
        const normUrl = String(r.url).split('?')[0].toLowerCase();
        if (articles.some(a => a.url.split('?')[0].toLowerCase() === normUrl)) continue;
        articles.push({ url: r.url, title: r.title || r.url, content: content.slice(0, 3000) });
        added++;
        if (articles.length >= 5) break;
      }
      queryResults.push({ query: q, found: results.length, added });
      console.log(`[thermocline-search] → ${results.length} results, ${added} added (total articles: ${articles.length})`);
      if (articles.length >= 5) break;
    } catch (e) {
      console.warn(`[thermocline-search] query error: ${e.message}`);
      queryResults.push({ query: q, error: e.message });
    }
  }

  if (!articles.length) {
    console.log(`[thermocline-search] No articles found — returning early`);
    return new Response(JSON.stringify({ ok: true, thermocline: null, note: 'No guide articles found for thermocline search', articles: [], queryResults }), { headers: JSON_HEADERS });
  }
  console.log(`[thermocline-search] ${articles.length} articles collected — running LLM extract`);

  // Lightweight LLM extract — one call, all articles combined
  const articleText = articles.map((a, i) => `--- Article ${i+1}: ${a.title}\nURL: ${a.url}\n${a.content}`).join('\n\n');
  const systemPrompt = `You are a fishing intelligence analyst. Extract thermocline depth information from fishing guide articles about ${queryLake}. Return ONLY valid JSON, no markdown, no preamble.`;
  const userPrompt = `From the following articles about ${queryLake}, extract any mention of thermocline depth, depth at which fish hold in summer, or the depth below which water becomes too warm or too cold for fish activity.

${articleText}

Return JSON in this exact shape:
{
  "found": true or false,
  "summerThermoclineDepthFt": number or null,
  "depthRangeMin": number or null,
  "depthRangeMax": number or null,
  "confidence": "low" or "very_low",
  "confidenceScore": number between 20 and 45,
  "sourceCount": number of articles that mentioned depth,
  "note": "brief explanation of what was found and from which sources",
  "warning": "Anecdotal — derived from guide articles, not measured vertical profiles"
}

If no thermocline or depth information is found, return found: false and null for all depth fields.`;

  let thermocline = null;
  try {
    const llmResult = await callLLM(env, {
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      max_tokens: 400,
      temperature: 0.1,
      response_format: { type: 'json_object' },
    });
    const text = extractLLMText(llmResult.data).replace(/\`\`\`json|\`\`\`/g, '').trim();
    const parsed = JSON.parse(text);
    if (parsed.found && parsed.summerThermoclineDepthFt != null) {
      thermocline = {
        summerThermoclineDepthFt: parsed.summerThermoclineDepthFt,
        depthRangeMin: parsed.depthRangeMin ?? null,
        depthRangeMax: parsed.depthRangeMax ?? null,
        confidence: 'low',
        confidenceScore: Math.min(45, Math.max(20, parsed.confidenceScore ?? 35)),
        sourceCount: parsed.sourceCount ?? articles.length,
        method: 'anecdotal_guide_articles',
        note: parsed.note || null,
        warning: 'Derived from fishing guide articles — not measured vertical profiles. Use as behavioral estimate only.',
      };
    }
  } catch (e) {
    console.warn(`[thermocline-search] LLM extract failed: ${e.message}`);
  }

  if (thermocline) {
    console.log(`[thermocline-search] ✔ Thermocline derived: ${thermocline.summerThermoclineDepthFt}ft (confidence ${thermocline.confidenceScore}%)`);
  } else {
    console.log(`[thermocline-search] ✗ No thermocline extracted from ${articles.length} articles`);
  }
  return new Response(JSON.stringify({
    ok: true,
    thermocline,
    articleCount: articles.length,
    articles: articles.map(a => ({ title: a.title, url: a.url })),
    queryResults,
    note: thermocline ? null : 'Articles found but no thermocline/depth information extracted',
  }), { headers: JSON_HEADERS });
}


// ── Vision Structure Scanner ──────────────────────────────────────────────────
// ── Vision Scan — single tile analysis endpoint ──────────────────────────────
// Tiling and ESRI image fetching happens client-side (no worker timeout issues).
// Worker receives one base64 image + bounds, runs Gemini, returns structures.
async function handleResearchVisionScan(request, env) {
  const body = await request.json().catch(() => ({}));
  const { lakeName, tileBounds } = body;
  if (!lakeName) return new Response(JSON.stringify({ ok: false, error: 'missing lakeName' }), { status: 400, headers: JSON_HEADERS });

  // Tile plan request — return bbox and tile list so browser can drive the scan
  if (!tileBounds) {
    const resolvedKey = resolveSupplementalKeyWorker(lakeName);

    // Load boundary geometry — prefer shoreline.geojson, fall back to 3DHP boundary polygon.
    // Shoreline is a LineString (i-boating derived); boundary is a Polygon (USGS 3DHP).
    // Both work for bbox derivation and point-in-polygon tile filtering.
    let geo = null;
    let boundarySource = null;
    const shorelineObj = await env.R2_TROLLMAP_CHARTPACKS.get(`supplemental/${resolvedKey}/shoreline.geojson`);
    if (shorelineObj) {
      geo = JSON.parse(await shorelineObj.text());
      boundarySource = 'shoreline';
    } else {
      const boundaryObj = await env.R2_TROLLMAP_CHARTPACKS.get(`boundaries/${resolvedKey}_3dhp.geojson`);
      if (boundaryObj) {
        geo = JSON.parse(await boundaryObj.text());
        boundarySource = '3dhp_boundary';
      }
    }
    if (!geo) return new Response(JSON.stringify({ ok: false, error: `no shoreline or 3DHP boundary found for ${resolvedKey}` }), { status: 400, headers: JSON_HEADERS });
    console.log(`[vision-scan] using ${boundarySource} for tile plan: ${resolvedKey}`);

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
    if (!coords.length) return new Response(JSON.stringify({ ok: false, error: `no coords in ${boundarySource}` }), { status: 400, headers: JSON_HEADERS });
    const lons = coords.map(c => c[0]), lats = coords.map(c => c[1]);
    const bboxW = Math.min(...lons), bboxE = Math.max(...lons);
    const bboxS = Math.min(...lats), bboxN = Math.max(...lats);
    // Scale tile size to lake extent — target ~8x8 grid
    const latSpan = bboxN - bboxS;
    const lonSpan = bboxE - bboxW;
    const TILE_DEG = Math.max(0.004, Math.max(latSpan, lonSpan) / 8);
    const MAX_TILES = 100;

    // Point-in-polygon — only tile centers inside the lake boundary
    function pointInPoly(lon, lat, polyCoords) {
      let inside = false;
      for (let i = 0, j = polyCoords.length - 1; i < polyCoords.length; j = i++) {
        const xi = polyCoords[i][0], yi = polyCoords[i][1];
        const xj = polyCoords[j][0], yj = polyCoords[j][1];
        if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
      }
      return inside;
    }

    const tiles = [];
    for (let lat = bboxS; lat < bboxN; lat += TILE_DEG) {
      for (let lon = bboxW; lon < bboxE; lon += TILE_DEG) {
        const cLat = lat + TILE_DEG / 2;
        const cLon = lon + TILE_DEG / 2;
        if (!pointInPoly(cLon, cLat, coords)) continue;
        tiles.push({ s: lat, n: Math.min(lat + TILE_DEG, bboxN), w: lon, e: Math.min(lon + TILE_DEG, bboxE) });
        if (tiles.length >= MAX_TILES) break;
      }
      if (tiles.length >= MAX_TILES) break;
    }
    // Write initial status
    try {
      await env.R2_TROLLMAP_CHARTPACKS.put(
        `supplemental/${resolvedKey}/vision-scan-status.json`,
        JSON.stringify({ status: 'scanning', lakeName, lakeKey: resolvedKey, boundarySource, tilesTotal: tiles.length, tilesProcessed: 0, structuresFound: 0, startedAt: new Date().toISOString() }),
        { httpMetadata: { contentType: 'application/json' } }
      );
    } catch (_) {}
    return new Response(JSON.stringify({ ok: true, tiles, lakeKey: resolvedKey }), { headers: JSON_HEADERS });
  }

  // Single tile analysis — worker fetches ESRI image (no CORS) + runs Gemini
  if (!tileBounds) return new Response(JSON.stringify({ ok: false, error: 'missing tileBounds' }), { status: 400, headers: JSON_HEADERS });

  const geminiKeys = [env.GEMINI_FREE_API_KEY, env.GEMINI_FREE2_API_KEY, env.GEMINI_FREE3_API_KEY, env.GEMINI_FREE4_API_KEY, env.GEMINI_FREE5_API_KEY].filter(Boolean);
  if (!geminiKeys.length) return new Response(JSON.stringify({ ok: false, error: 'no Gemini keys' }), { status: 500, headers: JSON_HEADERS });

  // Fetch ESRI satellite image from worker (no CORS restrictions)
  const { s, n, w, e } = tileBounds;
  const bbox = `${w},${s},${e},${n}`;
  const esriUrl = `https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/export?bbox=${encodeURIComponent(bbox)}&bboxSR=4326&imageSR=4326&size=800,800&format=jpg&transparent=false&f=image`;
  const imgController = new AbortController();
  const imgTimeout = setTimeout(() => imgController.abort(), 12000);
  let imgRes;
  try {
    imgRes = await fetch(esriUrl, { signal: imgController.signal });
  } finally {
    clearTimeout(imgTimeout);
  }
  if (!imgRes.ok) return new Response(JSON.stringify({ ok: false, error: `ESRI ${imgRes.status}`, features: [] }), { headers: JSON_HEADERS });

  const buf = await imgRes.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  const imageBase64 = btoa(binary);

  const MODEL = 'gemini-3.1-flash-lite';
  const prompt = `Analyze this aerial/satellite image of a freshwater lake.

Identify ONLY these structure types that are CLEARLY VISIBLE:
1. DOCK_CLUSTER — 3 or more docks/piers concentrated in one area
2. RIPRAP — rock or concrete revetment along a shoreline
3. BRIDGE — bridge crossing the water with visible pilings
4. FLOODED_TIMBER — standing dead trees or stumps in or at water's edge

DO NOT report individual docks, vegetation, boats, or anything below the water surface.
Give the centre of each detected structure as INTEGER PIXEL coordinates in the 800x800 image: x is pixels from the LEFT (0–799) and y is pixels from the TOP (0–799). Do not use latitude/longitude, percentages, fractions, or normalized 0–1 coordinates. A marker must identify the visible structure itself, not a nearby shoreline or the centre of the tile.

Return ONLY valid JSON:
{"structures":[{"type":"DOCK_CLUSTER|RIPRAP|BRIDGE|FLOODED_TIMBER","x":400,"y":400,"confidence":0.85,"description":"brief","dock_count_estimate":null}],"has_water":true}
If nothing found: {"structures":[],"has_water":true}`;

  for (let attempt = 0; attempt < geminiKeys.length; attempt++) {
    const key = geminiKeys[attempt % geminiKeys.length];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ inline_data: { mime_type: 'image/jpeg', data: imageBase64 } }, { text: prompt }] }],
          generationConfig: { temperature: 0.05, maxOutputTokens: 600, responseMimeType: 'application/json' }
        })
      });
      if (r.status === 429) { continue; }
      if (!r.ok) throw new Error(`Gemini ${r.status}`);
      const data = await r.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      const result = JSON.parse(text.replace(/```json|```/g, '').trim());
      console.log(`[vision-scan] raw structures: ${JSON.stringify(result.structures)} tileBounds: ${JSON.stringify({s,n,w,e})}`);
      const IMG_SIZE = 800;
      const features = (result.structures || [])
        .filter(st => (st.confidence || 0) >= 0.6)
        .map(st => {
          // Robust coordinate parsing — handles Gemini inventing field names like "y_760"
          const extract = (axis) => {
            if (st[axis] !== undefined) return parseFloat(st[axis]);
            if (st[`${axis}_frac`] !== undefined) return parseFloat(st[`${axis}_frac`]);
            if (st[`${axis}_pixel`] !== undefined) return parseFloat(st[`${axis}_pixel`]);
            const key = Object.keys(st).find(k => k.toLowerCase().startsWith(axis));
            return key ? parseFloat(st[key]) : null;
          };
          const xVal = extract('x');
          const yVal = extract('y');
          // Reject invalid coordinates — never default to tile centre
          if (!Number.isFinite(xVal) || !Number.isFinite(yVal) || xVal < 0 || xVal >= IMG_SIZE || yVal < 0 || yVal >= IMG_SIZE) return null;
          const xFrac = xVal / IMG_SIZE;
          const yFrac = yVal / IMG_SIZE;
          return {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [w + (e - w) * xFrac, n - (n - s) * yFrac] },
            properties: { structure_type: st.type, confidence: st.confidence, description: st.description || '', dock_count_estimate: st.dock_count_estimate || null, source: 'gemini_vision', image_position_px: { x: xVal, y: yVal }, tile_bounds: { s, n, w, e }, scanned_at: new Date().toISOString() }
          };
        })
        .filter(Boolean);
      return new Response(JSON.stringify({ ok: true, hasWater: result.has_water, features }), { headers: JSON_HEADERS });
    } catch (e) {
      if (attempt === geminiKeys.length - 1) {
        return new Response(JSON.stringify({ ok: false, error: e.message, features: [] }), { headers: JSON_HEADERS });
      }
    }
  }
  return new Response(JSON.stringify({ ok: false, error: 'all Gemini keys failed', features: [] }), { headers: JSON_HEADERS });
}

// Save accumulated vision scan results to R2
async function handleResearchVisionScanSave(request, env) {
  const body = await request.json().catch(() => ({}));
  const { lakeName, features, tilesTotal, tilesProcessed, tilesSkipped } = body;
  if (!lakeName || !features) return new Response(JSON.stringify({ ok: false, error: 'missing lakeName or features' }), { status: 400, headers: JSON_HEADERS });
  const resolvedKey = resolveSupplementalKeyWorker(lakeName);
  const geojson = {
    type: 'FeatureCollection', features,
    metadata: { lakeName, lakeKey: resolvedKey, tilesTotal, tilesProcessed, tilesSkipped, structuresFound: features.length, scannedAt: new Date().toISOString(), model: 'gemini-3.1-flash-lite' }
  };
  await env.R2_TROLLMAP_CHARTPACKS.put(`supplemental/${resolvedKey}/vision-structure.geojson`, JSON.stringify(geojson), { httpMetadata: { contentType: 'application/json' } });
  await env.R2_TROLLMAP_CHARTPACKS.put(`supplemental/${resolvedKey}/vision-scan-status.json`,
    JSON.stringify({ status: 'complete', lakeName, lakeKey: resolvedKey, tilesTotal, tilesProcessed, structuresFound: features.length, completedAt: new Date().toISOString() }),
    { httpMetadata: { contentType: 'application/json' } }
  );
  return new Response(JSON.stringify({ ok: true, structuresFound: features.length }), { headers: JSON_HEADERS });
}


async function handleResearchVisionScanStatus(request, env) {
  const body = await request.json().catch(() => ({}));
  const { lakeName } = body;
  if (!lakeName) return new Response(JSON.stringify({ ok: false, error: 'missing lakeName' }), { status: 400, headers: JSON_HEADERS });
  const resolvedKey = resolveSupplementalKeyWorker(lakeName);
  try {
    const statusObj = await env.R2_TROLLMAP_CHARTPACKS.get(`supplemental/${resolvedKey}/vision-scan-status.json`);
    if (!statusObj) return new Response(JSON.stringify({ ok: true, status: 'not_started' }), { headers: JSON_HEADERS });
    const status = JSON.parse(await statusObj.text());
    // Check if GeoJSON result also exists
    const resultObj = await env.R2_TROLLMAP_CHARTPACKS.head(`supplemental/${resolvedKey}/vision-structure.geojson`);
    return new Response(JSON.stringify({ ok: true, ...status, hasResult: !!resultObj }), { headers: JSON_HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { headers: JSON_HEADERS });
  }
}


// ─── PHASE 2: SHARED R2 DOCUMENT REGISTRY ────────────────────────────────────
// A canonical source is fetched and normalized no more than once, regardless of
// how many lakes or categories use it. Documents are stored immutably by version;
// a generation pointer controls which index is active. Kill switch:
// SHARED_RESEARCH_ENABLED=false falls back to current per-lake behavior.

const SHARED_ROOT = 'research/shared';
const SHARED_ENABLED_DEFAULT = true;

function sharedEnabled(env) {
  const v = env.SHARED_RESEARCH_ENABLED;
  if (v === undefined || v === null) return SHARED_ENABLED_DEFAULT;
  return String(v).toLowerCase() !== 'false';
}

// ── Fingerprint ───────────────────────────────────────────────────────────────
// Bounded content fingerprint per section 12.3 — not a full cryptographic hash.
// Input capped ~12KB so Worker CPU cost is negligible.
async function contentFingerprint(title, text) {
  const len = text.length;
  const mid = Math.floor(len / 2);
  const sig = [
    (title || '').trim().toLowerCase(),
    String(len),
    text.slice(0, 4096),
    text.slice(Math.max(0, mid - 2048), mid + 2048),
    text.slice(Math.max(0, len - 4096))
  ].join('\x00');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sig));
  return 'fp:' + Array.from(new Uint8Array(buf)).slice(0, 8).map(b => b.toString(16).padStart(2,'0')).join('');
}

// ── Canonical URL → document ID ───────────────────────────────────────────────
async function urlToDocId(canonicalUrl) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalUrl));
  return 'doc-' + Array.from(new Uint8Array(buf)).slice(0, 12).map(b => b.toString(16).padStart(2,'0')).join('');
}

// ── Segmentation ──────────────────────────────────────────────────────────────
// Deterministic split per section 12.2. No LLM. Page markers → headings → chunks.
const SECTION_HEADING_PREFIXES = /^(Chapter|Section|Appendix|Summary|Introduction|Abstract|Study Title|Job Title|Results|Discussion|Methods|Background|\d+\.\s)/i;
const CHUNK_SIZE = 12000;
const CHUNK_OVERLAP = 800;

function segmentDocument(fullText, docId) {
  if (!fullText) return [];
  const lines = fullText.split('\n');
  const pages = [];
  let currentPage = null;

  // Pass 1: split on --- PAGE n --- markers
  for (const line of lines) {
    const pm = line.match(/^---\s*PAGE\s*(\d+)\s*---$/i);
    if (pm) {
      if (currentPage) pages.push(currentPage);
      currentPage = { pageNum: parseInt(pm[1], 10), lines: [] };
    } else if (currentPage) {
      currentPage.lines.push(line);
    }
  }
  if (currentPage) pages.push(currentPage);

  // If no page markers, treat entire text as one "page"
  if (!pages.length) {
    pages.push({ pageNum: 1, lines });
  }

  // Pass 2: detect section headings within pages
  const rawSections = [];
  let currentSection = null;

  const isHeading = (line) => {
    const t = line.trim();
    if (!t || t.length > 140 || t.length < 3) return false;
    if (/^#{1,4}\s/.test(t)) return true; // Markdown heading
    if (SECTION_HEADING_PREFIXES.test(t)) return true;
    // Title case heuristic: mostly uppercase or title-cased short line
    const words = t.split(/\s+/);
    if (words.length <= 10) {
      const uppercaseRatio = words.filter(w => /^[A-Z]/.test(w)).length / words.length;
      if (uppercaseRatio >= 0.6) return true;
    }
    return false;
  };

  for (const page of pages) {
    const pageLines = page.lines;
    for (let i = 0; i < pageLines.length; i++) {
      const line = pageLines[i];
      const prevBlank = i === 0 || !pageLines[i-1].trim();
      const nextBlank = i === pageLines.length - 1 || !pageLines[i+1]?.trim();
      if (isHeading(line) && (prevBlank || nextBlank)) {
        if (currentSection) rawSections.push({ ...currentSection, endPage: page.pageNum });
        currentSection = { heading: line.trim(), startPage: page.pageNum, endPage: page.pageNum, lines: [] };
      } else if (currentSection) {
        currentSection.lines.push(line);
        currentSection.endPage = page.pageNum;
      } else {
        // Pre-heading content — put in a preamble section
        if (!rawSections.length) {
          if (!currentSection) currentSection = { heading: '', startPage: page.pageNum, endPage: page.pageNum, lines: [] };
          currentSection.lines.push(line);
        }
      }
    }
  }
  if (currentSection) rawSections.push({ ...currentSection });

  // If no sections found, use page groups up to CHUNK_SIZE
  if (!rawSections.length || (rawSections.length === 1 && !rawSections[0].heading)) {
    const allText = fullText;
    return chunkText(allText, `${docId}-s00`, '', 1, pages.length || 1);
  }

  // Pass 3: chunk sections that exceed CHUNK_SIZE
  const sections = [];
  let sIdx = 0;
  for (const sec of rawSections) {
    const text = sec.lines.join('\n').trim();
    if (!text) continue;
    const sId = `${docId}-s${String(sIdx).padStart(2,'0')}`;
    const chunks = chunkText(text, sId, sec.heading, sec.startPage, sec.endPage);
    sections.push({ sectionId: sId, heading: sec.heading, startPage: sec.startPage, endPage: sec.endPage, chunks });
    sIdx++;
  }
  return sections;
}

function chunkText(text, sectionId, heading, startPage, endPage) {
  if (text.length <= CHUNK_SIZE) {
    return [{ chunkId: `${sectionId}-01`, text, overlapBefore: 0 }];
  }
  const chunks = [];
  let offset = 0;
  let cIdx = 1;
  while (offset < text.length) {
    let end = Math.min(offset + CHUNK_SIZE, text.length);
    // Break at paragraph boundary if possible
    if (end < text.length) {
      const paraBreak = text.lastIndexOf('\n\n', end);
      if (paraBreak > offset + CHUNK_SIZE / 2) end = paraBreak;
    }
    const overlap = offset > 0 ? CHUNK_OVERLAP : 0;
    const chunkStart = Math.max(0, offset - overlap);
    chunks.push({
      chunkId: `${sectionId}-${String(cIdx).padStart(2,'0')}`,
      text: text.slice(chunkStart, end),
      overlapBefore: overlap
    });
    offset = end;
    cIdx++;
  }
  return chunks;
}

// ── Lake catalog for deterministic tagging ────────────────────────────────────
// All canonical lake names + approved aliases used for section tagging.
// Keyed by lakeSlug → { canonical, aliases }
const LAKE_CATALOG = (() => {
  const entries = {
    'lake-wateree': { canonical: 'Lake Wateree', aliases: ['Wateree Lake', 'Catawba-Wateree'] },
    'lake-murray': { canonical: 'Lake Murray', aliases: ['Murray Lake', 'Saluda River Lake'] },
    'lake-marion': { canonical: 'Lake Marion', aliases: ['Santee-Cooper', 'Santee Cooper Lakes', 'Lake Marion South Carolina'] },
    'lake-moultrie': { canonical: 'Lake Moultrie', aliases: ['Santee-Cooper', 'Santee Cooper Lakes'] },
    'lake-hartwell': { canonical: 'Lake Hartwell', aliases: ['Hartwell Lake', 'Hartwell Reservoir', 'Savannah River Lakes'] },
    'lake-russell': { canonical: 'Lake Russell', aliases: ['Richard B. Russell Lake', 'R.B. Russell Lake', 'Savannah River Lakes'] },
    'lake-thurmond': { canonical: 'Lake Thurmond', aliases: ['J. Strom Thurmond Lake', 'Clarks Hill Lake', 'Clarks Hill Reservoir', 'Savannah River Lakes'] },
    'lake-keowee': { canonical: 'Lake Keowee', aliases: ['Keowee Reservoir', 'Catawba-Wateree'] },
    'lake-jocassee': { canonical: 'Lake Jocassee', aliases: ['Jocassee Reservoir'] },
    'lake-wylie': { canonical: 'Lake Wylie', aliases: ['Wylie Lake', 'Catawba-Wateree'] },
    'lake-norman': { canonical: 'Lake Norman', aliases: ['Norman Lake', 'Catawba-Wateree', 'Catawba-Wateree Project'] },
    'lake-hickory': { canonical: 'Lake Hickory', aliases: ['Hickory Lake', 'Catawba-Wateree'] },
    'lake-james': { canonical: 'Lake James', aliases: ['James Lake', 'Catawba-Wateree'] },
    'lake-rhodhiss': { canonical: 'Lake Rhodhiss', aliases: ['Rhodhiss Lake', 'Catawba-Wateree'] },
    'mountain-island-lake': { canonical: 'Mountain Island Lake', aliases: ['Mountain Island Reservoir', 'Catawba-Wateree'] },
    'lake-greenwood': { canonical: 'Lake Greenwood', aliases: ['Greenwood Lake', 'Buzzard Roost Reservoir'] },
    'lake-monticello': { canonical: 'Lake Monticello', aliases: ['Monticello Reservoir', 'Broad River Reservoir'] },
    'lake-oconee': { canonical: 'Lake Oconee', aliases: ['Oconee Lake'] },
    'lake-sinclair': { canonical: 'Lake Sinclair', aliases: ['Sinclair Lake', 'Oconee-Sinclair'] },
    'lake-lanier': { canonical: 'Lake Lanier', aliases: ['Lake Sidney Lanier', 'Buford Dam Lake'] },
    'lake-allatoona': { canonical: 'Lake Allatoona', aliases: ['Allatoona Lake'] },
    'norris-lake': { canonical: 'Norris Lake', aliases: ['Norris Reservoir', 'TVA Lakes'] },
    'douglas-lake': { canonical: 'Douglas Lake', aliases: ['Douglas Reservoir', 'TVA Lakes'] },
    'chickamauga-lake': { canonical: 'Chickamauga Lake', aliases: ['Chickamauga Reservoir', 'TVA Lakes'] },
    'fort-loudoun-lake': { canonical: 'Fort Loudoun Lake', aliases: ['Fort Loudoun Reservoir', 'TVA Lakes'] },
    'tellico-lake': { canonical: 'Tellico Lake', aliases: ['Tellico Reservoir', 'TVA Lakes'] },
    'watauga-lake': { canonical: 'Watauga Lake', aliases: ['Watauga Reservoir', 'TVA Lakes'] },
  };
  return entries;
})();

// Tag sections with lake slugs by deterministic name matching
function tagSectionsWithLakes(sections) {
  const allNames = [];
  for (const [slug, entry] of Object.entries(LAKE_CATALOG)) {
    allNames.push({ slug, name: entry.canonical, isAlias: false });
    for (const alias of entry.aliases) {
      allNames.push({ slug, name: alias, isAlias: true });
    }
  }

  return sections.map(sec => {
    const lakeMatches = [];
    const searchText = [sec.heading, sec.chunks?.[0]?.text?.slice(0, 1500) || ''].join(' ');

    for (const { slug, name, isAlias } of allNames) {
      const rx = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      const headingMatch = rx.test(sec.heading);
      const bodyMatch = rx.test(searchText);
      if (headingMatch || bodyMatch) {
        const existing = lakeMatches.find(m => m.lakeSlug === slug);
        const confidence = headingMatch ? 1.0 : isAlias ? 0.7 : 0.85;
        if (!existing || confidence > existing.confidence) {
          const matchObj = {
            lakeSlug: slug,
            matchedText: name,
            matchLocation: headingMatch ? 'heading' : 'body',
            confidence,
            isAlias
          };
          if (existing) Object.assign(existing, matchObj);
          else lakeMatches.push(matchObj);
        }
      }
    }
    return { ...sec, lakeMatches };
  });
}

// Tag sections with categories by keyword rules per section 12.2
const CATEGORY_KEYWORDS = {
  biology:    /\b(stocking|recruitment|population|electrofishing|gill.?net|species.?abundance|spawning|biomass|rotenone|forage|shad|herring|bass|crappie|catfish|predator|baitfish)\b/i,
  limnology:  /\b(dissolved.?oxygen|temperature.?profile|thermocline|nutrient|chlorophyll|secchi|trophic|phosphorus|nitrogen|turbidity|conductivity|alkalinity|stratifi|hypolimnion|epilimnion)\b/i,
  habitat:    /\b(vegetation|hydrilla|substrate|woody.?debris|fish.?attractor|shoreline|stump|timber|brush|structure|riprap|cove|creek.?mouth)\b/i,
  navigation: /\b(shoal|hazard|channel.?marker|navigation|boat.?ramp|access|dock|buoy|stump|shallow)\b/i,
  regulations:/\b(creel|size.?limit|possession|closed.?season|slot.?limit|harvest|bag.?limit|length.?limit)\b/i,
  fisheries:  /\b(angler|seasonal.?pattern|catch.?rate|fishing.?mortality|creel.?survey|catch.?per.?effort|cpue|tournament|catch.?and.?release)\b/i,
  identity:   /\b(owner|dam|impoundment|license|project.?number|ferc|reservoir|acreage|surface.?area|watershed|elevation|normal.?pool)\b/i,
};

function tagSectionsWithCategories(sections) {
  return sections.map(sec => {
    const searchText = [sec.heading, sec.chunks?.map(c => c.text.slice(0, 500)).join(' ') || ''].join(' ');
    const categories = [];
    for (const [cat, rx] of Object.entries(CATEGORY_KEYWORDS)) {
      if (rx.test(searchText)) categories.push(cat);
    }
    return { ...sec, categories: categories.length ? categories : ['general'] };
  });
}

// ── Shared registry R2 helpers ────────────────────────────────────────────────
async function getSharedPointer(env) {
  try {
    const obj = await env.R2_TROLLMAP_CHARTPACKS.get(`${SHARED_ROOT}/pointers/current.json`);
    if (!obj) return null;
    return JSON.parse(await obj.text());
  } catch { return null; }
}

async function getSharedDocument(env, docId, versionId) {
  try {
    const key = versionId
      ? `${SHARED_ROOT}/documents/${docId}/versions/${versionId}.json`
      : `${SHARED_ROOT}/documents/${docId}/latest.json`;
    const obj = await env.R2_TROLLMAP_CHARTPACKS.get(key);
    if (!obj) return null;
    return JSON.parse(await obj.text());
  } catch { return null; }
}

async function storeSharedDocument(env, docRecord) {
  const { id, versionId } = docRecord;
  const vKey = `${SHARED_ROOT}/documents/${id}/versions/${versionId}.json`;
  const latestKey = `${SHARED_ROOT}/documents/${id}/latest.json`;
  const json = JSON.stringify(docRecord, null, 2);
  await env.R2_TROLLMAP_CHARTPACKS.put(vKey, json, { httpMetadata: { contentType: 'application/json' } });
  await env.R2_TROLLMAP_CHARTPACKS.put(latestKey, json, { httpMetadata: { contentType: 'application/json' } });
}

async function getSharedRegistryEntry(env, canonicalUrl) {
  try {
    const docId = await urlToDocId(canonicalUrl);
    const obj = await env.R2_TROLLMAP_CHARTPACKS.get(`${SHARED_ROOT}/documents/${docId}/latest.json`);
    if (!obj) return null;
    return JSON.parse(await obj.text());
  } catch { return null; }
}

// ── POST /research/shared/check ───────────────────────────────────────────────
// Check if a canonical URL is in the shared registry.
// Returns the document record if found, including sections.
async function handleSharedCheck(request, env) {
  if (!sharedEnabled(env)) return new Response(JSON.stringify({ ok: false, disabled: true }), { headers: JSON_HEADERS });
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const { canonicalUrl } = body;
  if (!canonicalUrl) return new Response(JSON.stringify({ ok: false, error: 'missing canonicalUrl' }), { status: 400, headers: JSON_HEADERS });
  const doc = await getSharedRegistryEntry(env, canonicalUrl);
  if (!doc) return new Response(JSON.stringify({ ok: false, found: false }), { headers: JSON_HEADERS });
  return new Response(JSON.stringify({ ok: true, found: true, document: doc }), { headers: JSON_HEADERS });
}

// ── POST /research/shared/store ───────────────────────────────────────────────
// Store a fetched+normalized document into the shared registry.
// Segments, tags, fingerprints, and writes immutable version.
async function handleSharedStore(request, env) {
  if (!sharedEnabled(env)) return new Response(JSON.stringify({ ok: false, disabled: true }), { headers: JSON_HEADERS });
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const { canonicalUrl, requestedUrl, finalUrl, title, providerTitle, fullText, authority, fetchProvider, etag, lastModified, sourceRevision, urlAliases, categoryHints } = body;
  if (!canonicalUrl || !fullText) return new Response(JSON.stringify({ ok: false, error: 'missing canonicalUrl or fullText' }), { status: 400, headers: JSON_HEADERS });

  const docId = await urlToDocId(canonicalUrl);
  const fp = await contentFingerprint(title || '', fullText);
  const versionId = `v${Date.now()}`;

  // Check if we already have this fingerprint — avoid re-storing unchanged content
  const existing = await getSharedRegistryEntry(env, canonicalUrl);
  if (existing?.contentFingerprint === fp) {
    // Update lastCheckedAt only
    existing.lastCheckedAt = new Date().toISOString();
    await storeSharedDocument(env, existing);
    return new Response(JSON.stringify({ ok: true, docId, versionId: existing.versionId, unchanged: true }), { headers: JSON_HEADERS });
  }

  // Segment the document
  let sections = segmentDocument(fullText, docId);
  sections = tagSectionsWithLakes(sections);
  sections = tagSectionsWithCategories(sections);

  // Determine scope from lake matches across all sections
  const allSlugs = [...new Set(sections.flatMap(s => s.lakeMatches?.map(m => m.lakeSlug) || []))];
  const scope = allSlugs.length === 0 ? 'unknown' : allSlugs.length === 1 ? 'lake' : allSlugs.length <= 3 ? 'multi-lake' : 'statewide';

  // Determine indexStatus
  const hasReliableSections = sections.some(s => s.lakeMatches?.length > 0 || s.categories?.some(c => c !== 'general'));
  const indexStatus = hasReliableSections ? 'indexed' : 'ambiguous';

  const docRecord = {
    id: docId,
    versionId,
    canonicalUrl,
    requestedUrl: requestedUrl || canonicalUrl,
    finalUrl: finalUrl || canonicalUrl,
    urlAliases: urlAliases || [],
    sourceRevision: sourceRevision || null,
    contentFingerprint: fp,
    providerTitle: providerTitle || null,
    title: title || providerTitle || null,
    titleSource: title ? 'document_first_page' : 'provider',
    authority: authority || 'unknown',
    scope,
    lakeSlugs: allSlugs,
    fetchProvider: fetchProvider || 'unknown',
    fetchedAt: new Date().toISOString(),
    lastCheckedAt: new Date().toISOString(),
    etag: etag || null,
    lastModified: lastModified || null,
    indexStatus,
    sections,
  };

  await storeSharedDocument(env, docRecord);
  console.log(`[shared-store] stored ${docId} (${scope}, ${sections.length} sections, lakes: [${allSlugs.join(', ')}])`);
  return new Response(JSON.stringify({ ok: true, docId, versionId, scope, sections: sections.length, lakeSlugs: allSlugs, indexStatus }), { headers: JSON_HEADERS });
}

// ── POST /research/shared/query ───────────────────────────────────────────────
// Get sections from a shared document relevant to a specific lake + categories.
async function handleSharedQuery(request, env) {
  if (!sharedEnabled(env)) return new Response(JSON.stringify({ ok: false, disabled: true }), { headers: JSON_HEADERS });
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const { canonicalUrl, lakeSlug, categories } = body;
  if (!canonicalUrl) return new Response(JSON.stringify({ ok: false, error: 'missing canonicalUrl' }), { status: 400, headers: JSON_HEADERS });

  const doc = await getSharedRegistryEntry(env, canonicalUrl);
  if (!doc) return new Response(JSON.stringify({ ok: false, found: false }), { headers: JSON_HEADERS });

  const requestedCategories = categories || [];
  const sections = (doc.sections || []).filter(sec => {
    // Include if: section matches lake slug, or doc is statewide/single-lake for this lake
    const lakeMatch = !lakeSlug ||
      doc.scope === 'statewide' ||
      (doc.scope === 'lake' && doc.lakeSlugs?.includes(lakeSlug)) ||
      sec.lakeMatches?.some(m => m.lakeSlug === lakeSlug);
    const categoryMatch = !requestedCategories.length ||
      sec.categories?.some(c => requestedCategories.includes(c));
    return lakeMatch && categoryMatch;
  });

  // Assemble text from matching sections
  const text = sections.map(sec => {
    const heading = sec.heading ? `\n## ${sec.heading}\n` : '';
    const chunks = (sec.chunks || []).map(c => c.text).join('\n');
    return heading + chunks;
  }).join('\n\n');

  return new Response(JSON.stringify({
    ok: true, found: true,
    docId: doc.id, versionId: doc.versionId,
    title: doc.title, authority: doc.authority,
    scope: doc.scope, matchedSections: sections.length,
    text: text.slice(0, 150000)
  }), { headers: JSON_HEADERS });
}

// ── POST /research/shared/publish ─────────────────────────────────────────────
// Publish a new generation — builds manifest of all stored documents,
// validates, then atomically swaps the current pointer.
async function handleSharedPublish(request, env) {
  if (!sharedEnabled(env)) return new Response(JSON.stringify({ ok: false, disabled: true }), { headers: JSON_HEADERS });

  const genId = `gen-${Date.now()}`;
  try {
    // List all shared documents
    const listed = await env.R2_TROLLMAP_CHARTPACKS.list({ prefix: `${SHARED_ROOT}/documents/` });
    const latestKeys = listed.objects.filter(o => o.key.endsWith('/latest.json'));

    const manifest = { generationId: genId, publishedAt: new Date().toISOString(), documents: [] };
    for (const obj of latestKeys) {
      const docObj = await env.R2_TROLLMAP_CHARTPACKS.get(obj.key);
      if (!docObj) continue;
      const doc = JSON.parse(await docObj.text());
      manifest.documents.push({
        id: doc.id, versionId: doc.versionId, canonicalUrl: doc.canonicalUrl,
        title: doc.title, authority: doc.authority, scope: doc.scope,
        lakeSlugs: doc.lakeSlugs, indexStatus: doc.indexStatus,
        sections: doc.sections?.length || 0, fetchedAt: doc.fetchedAt
      });
    }

    // Write generation manifest
    await env.R2_TROLLMAP_CHARTPACKS.put(
      `${SHARED_ROOT}/generations/${genId}/manifest.json`,
      JSON.stringify(manifest, null, 2),
      { httpMetadata: { contentType: 'application/json' } }
    );

    // Rotate pointers — previous ← current, current ← new
    const currentObj = await env.R2_TROLLMAP_CHARTPACKS.get(`${SHARED_ROOT}/pointers/current.json`);
    if (currentObj) {
      const current = await currentObj.text();
      await env.R2_TROLLMAP_CHARTPACKS.put(`${SHARED_ROOT}/pointers/previous.json`, current, { httpMetadata: { contentType: 'application/json' } });
    }
    await env.R2_TROLLMAP_CHARTPACKS.put(
      `${SHARED_ROOT}/pointers/current.json`,
      JSON.stringify({ generationId: genId, publishedAt: new Date().toISOString(), documentCount: manifest.documents.length }),
      { httpMetadata: { contentType: 'application/json' } }
    );

    console.log(`[shared-publish] generation ${genId} published — ${manifest.documents.length} documents`);
    return new Response(JSON.stringify({ ok: true, generationId: genId, documentCount: manifest.documents.length }), { headers: JSON_HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: JSON_HEADERS });
  }
}

// ── GET /research/shared/status ───────────────────────────────────────────────
async function handleSharedStatus(request, env) {
  if (!sharedEnabled(env)) return new Response(JSON.stringify({ ok: true, enabled: false }), { headers: JSON_HEADERS });
  const pointer = await getSharedPointer(env);
  const listed = await env.R2_TROLLMAP_CHARTPACKS.list({ prefix: `${SHARED_ROOT}/documents/` }).catch(() => ({ objects: [] }));
  const latestCount = listed.objects.filter(o => o.key.endsWith('/latest.json')).length;
  return new Response(JSON.stringify({ ok: true, enabled: true, pointer, storedDocuments: latestCount }), { headers: JSON_HEADERS });
}

// ── POST /research/shared/quarantine ─────────────────────────────────────────
async function handleSharedQuarantine(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const { canonicalUrl, reason } = body;
  if (!canonicalUrl) return new Response(JSON.stringify({ ok: false, error: 'missing canonicalUrl' }), { status: 400, headers: JSON_HEADERS });
  const docId = await urlToDocId(canonicalUrl);
  await env.R2_TROLLMAP_CHARTPACKS.put(
    `${SHARED_ROOT}/quarantine/${docId}.json`,
    JSON.stringify({ docId, canonicalUrl, reason: reason || 'manual', quarantinedAt: new Date().toISOString() }),
    { httpMetadata: { contentType: 'application/json' } }
  );
  return new Response(JSON.stringify({ ok: true, docId, quarantined: true }), { headers: JSON_HEADERS });
}

async function isQuarantined(env, canonicalUrl) {
  const docId = await urlToDocId(canonicalUrl);
  const obj = await env.R2_TROLLMAP_CHARTPACKS.get(`${SHARED_ROOT}/quarantine/${docId}.json`).catch(() => null);
  return !!obj;
}

export { handleResearchThermoclineSearch, handleResearchLimnologyData, handleResearchDiscover, handleResearchProxyDownload, handleResearchDatasetHunt, handleResearchDeterministicFacts, handleResearchSaveNormalized, handleResearchGetNormalized, handleResearchAnalyzeFacts, handleResearchDedupeContradictions, handleResearchMapFacts, handleResearchGapAnalysis, handleResearchGapSearch, handleResearchAgent, handleResearchAgentPipeline, handleResearchValidationPass, handleResearchList, handleResearchGet, handleResearchSave, handleResearchApprove, handleResearchDelete, handleResearchDeleteNormalizedDoc, handleResearchPackage, handleResearchPackageFile, handleEnhancedLakeIntel, RESEARCH_AGENTS, GAP_QUERIES, sanitizeLakeId, lakeResearchMasterKey, lakePackageKey, handleSharedCheck, handleSharedStore, handleSharedQuery, handleSharedPublish, handleSharedStatus, handleSharedQuarantine };
