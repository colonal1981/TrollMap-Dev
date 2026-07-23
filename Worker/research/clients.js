// research/clients.js — split from worker-research.js (behavior-preserving)
import { callLLM, extractLLMText } from '../worker-core.js';

// All /research/* route handlers, RESEARCH_AGENTS, deterministic facts, dataset hunt, etc.


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

async function tinyfishFetch({ urls, format = 'markdown', include_selectors, exclude_selectors, ttl, if_none_match, if_modified_since, include_etag_and_last_modified, links, image_links }, env) {
  const key = env.TINYFISH_API_KEY;
  if (!key) throw new Error('TINYFISH_API_KEY not configured');
  
  const body = { urls, format };
  if (include_selectors) body.include_selectors = include_selectors;
  if (exclude_selectors) body.exclude_selectors = exclude_selectors;
  if (ttl !== undefined) body.ttl = ttl;
  if (if_none_match) body.if_none_match = if_none_match;
  if (if_modified_since) body.if_modified_since = if_modified_since;
  if (include_etag_and_last_modified) body.include_etag_and_last_modified = include_etag_and_last_modified;
  if (links !== undefined) body.links = links;
  if (image_links !== undefined) body.image_links = image_links;
  
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
// R2 public bucket base URL for regulation digests
const REGS_R2_BASE = 'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/regulations';

// Effective date for switching to 2026-2027 digests (NC and TN only)
const REGS_2026_EFFECTIVE = new Date('2026-08-01');
const USE_2026 = new Date() >= REGS_2026_EFFECTIVE;

const STATE_REGULATIONS_CONFIG = {
  SC: {
    // SC 2026-2027 not yet published — use 2025-2026 digest from R2
    // Pages 18-43 contain freshwater creel/size tables and lake-specific exceptions
    pages: [{ key: 'general', url: `${REGS_R2_BASE}/sc_digest_2025_2026.pdf`, parser: 'llmParser', pageHint: 'warmwater game fish regulations pages 18-43' }]
  },
  NC: {
    // Switch to 2026-2027 digest on August 1, 2026
    pages: [{ key: 'general', url: `${REGS_R2_BASE}/${USE_2026 ? 'nc_digest_2026_2027' : 'nc_digest_2025_2026'}.pdf`, parser: 'llmParser', pageHint: 'warmwater game fish regulations — largemouth bass, crappie, catfish, walleye, striped bass sections' }]
  },
  GA: {
    // GA 2026-2027 not yet published — use 2025-2026 digest from R2
    pages: [{ key: 'general', url: `${REGS_R2_BASE}/ga_digest_2025_2026.pdf`, parser: 'llmParser', pageHint: 'freshwater fishing regulations — daily limits and size limits for warmwater species' }]
  },
  TN: {
    // Switch to 2026-2027 digest on August 1, 2026
    pages: [{ key: 'general', url: `${REGS_R2_BASE}/${USE_2026 ? 'tn_digest_2026_2027' : 'tn_digest_2025_2026'}.pdf`, parser: 'llmParser', pageHint: 'statewide creel and length limits plus lake-specific exceptions' }]
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
    .replace(/,?\s+(sc|nc|ga|tn)(?:\/(?:sc|nc|ga|tn))*$/i, '')
    .replace(/\s+(lake|reservoir)$/i, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

async function parseNCRegulationsWithLLM(text, env) {
  // NC regulations are prose-format legal rule text, not tables.
  // Extract statewide defaults and lake-specific exceptions via LLM.
  const systemPrompt =
    "You are an expert North Carolina freshwater fishing regulation parser.\n" +
    "The input is the full text of the NCWRC Inland Fishing Division Rule (15A NCAC 10C) — the official legal rule text.\n" +
    "Extract ALL statewide creel and size limits, and ALL lake-specific exceptions listed by name.\n\n" +
    "Rules about format:\n" +
    "- For statewide general rules, extract the default that applies to ALL public waters.\n" +
    "- For lake-specific exceptions, key them by the exact lake or reservoir name as written in the rule text.\n" +
    "- Species names: use 'Largemouth Bass', 'Smallmouth Bass', 'Striped Bass / Hybrid', 'White Bass', 'Crappie', 'Black Crappie', 'White Crappie', 'Bluegill', 'Catfish', 'Blue Catfish', 'Channel Catfish', 'Flathead Catfish', 'Walleye', 'Yellow Perch', 'Chain Pickerel', 'Trout', 'Kokanee Salmon'.\n" +
    "- Include special rules like 'no harvest between X and Y inches' as specialRules strings.\n\n" +
    "Return ONLY valid JSON, no markdown:\n" +
    "{\n" +
    "  \"general\": {\n" +
    "    \"<species>\": { \"sizeLimit\": \"<string or null>\", \"creelLimit\": \"<string or null>\" }\n" +
    "  },\n" +
    "  \"lakeSpecific\": {\n" +
    "    \"<lake name as written in rules>\": {\n" +
    "      \"<species>\": { \"sizeLimit\": \"<string or null>\", \"creelLimit\": \"<string or null>\", \"specialRules\": [\"<string>\"] }\n" +
    "    }\n" +
    "  }\n" +
    "}";

  // Find the warmwater species section — skip the mountain trout section at the top
  // The NC rule text starts with .0205 (mountain trout, very long) then gets to
  // .0316 (inland game fishes — bass, crappie, catfish, etc.) which is what we need.
  // Search for the Largemouth Bass section or .0316 as the anchor point.
  let warmwaterStart = text.search(/largemouth bass|10C\s*\.0316|inland game fish/i);
  if (warmwaterStart < 0) warmwaterStart = Math.min(15000, Math.floor(text.length * 0.3));
  const warmwaterText = text.slice(warmwaterStart, warmwaterStart + 30000);
  const userPrompt = "NC Inland Fishing Rule Text (warmwater species section — extract creel limits, size limits, and lake-specific exceptions for bass, crappie, catfish, walleye, etc.):\n\n" + warmwaterText;

  try {
    const llmResult = await callLLM(env, {
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      max_tokens: 4000,
      temperature: 0.1,
      response_format: { type: 'json_object' }
    });
    const raw = extractLLMText(llmResult.data).replace(/```(json)?/g, '').trim();
    const parsed = JSON.parse(raw);
    // Normalize lake names in lakeSpecific to match normalizeLakeName() format
    const normalized = { general: parsed.general || {}, lakeSpecific: {} };
    for (const [lake, speciesMap] of Object.entries(parsed.lakeSpecific || {})) {
      normalized.lakeSpecific[normalizeLakeName(lake)] = speciesMap;
    }
    return normalized;
  } catch (e) {
    console.error('parseNCRegulationsWithLLM failed:', e.message);
    return { general: {}, lakeSpecific: {} };
  }
}


async function parseRegulationsWithLLM(state, text, pageHint, env) {
  const systemPrompt = `You are an expert freshwater fishing regulation parser for ${state}.
The input is text extracted from the official state fishing regulations digest.
Extract ALL statewide creel and size limits, and ALL lake-specific or waterbody-specific exceptions.

Rules:
- For statewide/general rules: extract the default that applies to ALL public waters.
- For lake/waterbody-specific exceptions: key them by the exact waterbody name as written.
- Species names to use: 'Largemouth Bass', 'Smallmouth Bass', 'Spotted Bass', 'Striped Bass / Hybrid', 'White Bass', 'Crappie', 'Black Crappie', 'White Crappie', 'Bluegill', 'Catfish', 'Blue Catfish', 'Channel Catfish', 'Flathead Catfish', 'Walleye', 'Yellow Perch', 'Chain Pickerel', 'Muskellunge', 'Trout', 'Kokanee Salmon', 'Sauger'.
- Include special rules like slot limits, closed seasons, or combination limits as specialRules strings.
- Focus on: ${pageHint}

Return ONLY valid JSON:
{
  "general": {
    "<species>": { "sizeLimit": "<string or null>", "creelLimit": "<string or null>", "specialRules": [] }
  },
  "lakeSpecific": {
    "<waterbody name as written>": {
      "<species>": { "sizeLimit": "<string or null>", "creelLimit": "<string or null>", "specialRules": [] }
    }
  }
}`;

  // Find the warmwater/game fish section — skip hunting and intro pages
  let start = text.search(/largemouth bass|warmwater game fish|daily (bag|creel|limit)|size limit/i);
  if (start < 0) start = Math.min(10000, Math.floor(text.length * 0.2));
  const regsText = text.slice(start, start + 35000);
  const userPrompt = `${state} fishing regulations digest (${pageHint}):\n\n${regsText}`;

  try {
    const llmResult = await callLLM(env, {
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      max_tokens: 6000,
      temperature: 0.1,
      response_format: { type: 'json_object' }
    });
    const raw = extractLLMText(llmResult.data).replace(/\`\`\`(json)?/g, '').trim();
    const parsed = JSON.parse(raw);
    // Normalize lake names in lakeSpecific
    const normalized = { general: parsed.general || {}, lakeSpecific: {} };
    for (const [lake, speciesMap] of Object.entries(parsed.lakeSpecific || {})) {
      normalized.lakeSpecific[normalizeLakeName(lake)] = speciesMap;
    }
    return normalized;
  } catch (e) {
    console.error(`parseRegulationsWithLLM(${state}) failed:`, e.message);
    return { general: {}, lakeSpecific: {} };
  }
}

async function fetchStateRegulations(state, env) {
  // Bump when normalization/exception matching changes; stale v3 entries were
  // produced without reliably splitting combined waterbody headings.
  const cacheKey = `regulations:${state}:v4`;
  let cached = await env.KV.get(cacheKey, { type: 'json' });
  if (cached) return cached;
  
  const config = STATE_REGULATIONS_CONFIG[state];
  if (!config) return { general: {}, lakeSpecific: {} };
  
  const pages = config.pages;
  const urls = pages.map(p => p.url);
  
  // Fetch all pages via TinyFish (R2 public URLs are fetchable, free)
  const result = await tinyfishFetch({ urls, format: 'markdown' }, env);

  const parsed = { general: {}, lakeSpecific: {} };

  // All states now use LLM-based extraction from R2 digest PDFs
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const text = result.results?.[i]?.text || '';
    if (text.length < 500) {
      console.warn(`fetchStateRegulations(${state}): page ${i} returned insufficient text (${text.length} chars)`);
      continue;
    }
    const pageParsed = await parseRegulationsWithLLM(state, text, page.pageHint || '', env);
    if (page.key === 'general') {
      parsed.general = { ...parsed.general, ...pageParsed.general };
    }
    // Always merge lakeSpecific regardless of key
    for (const [lake, speciesMap] of Object.entries(pageParsed.lakeSpecific || {})) {
      parsed.lakeSpecific[lake] = { ...(parsed.lakeSpecific[lake] || {}), ...speciesMap };
    }
  }
  
  await env.KV.put(cacheKey, JSON.stringify(parsed), { expirationTtl: 90 * 24 * 60 * 60 });
  return parsed;
}

function getLakeRegulations(stateRegulations, lakeName) {
  const normalized = normalizeLakeName(lakeName);
  const specific = stateRegulations?.lakeSpecific || {};
  // Do not return/mutate the cached object: the old implementation could leak a
  // previous lake's exceptions into subsequent requests.
  const lakeSpecific = {};

  for (const [rawKey, val] of Object.entries(specific)) {
    const key = normalizeLakeName(rawKey);
    // Regulation digests commonly put several exceptions in one row, e.g.
    // "Lakes Blalock, Greenwood, ... Wateree ...". The LLM preserves that
    // heading as one JSON key, so exact lookup silently missed Lake Wateree.
    const matches = key === normalized || key.includes(normalized) || normalized.includes(key);
    if (matches && val && typeof val === 'object') Object.assign(lakeSpecific, val);
  }

  return {
    generalStateRegulations: stateRegulations?.general || {},
    lakeSpecificRegulations: lakeSpecific,
    hasExceptions: Object.keys(lakeSpecific).length > 0
  };
}

// ─── OWNER-AWARE DRAWDOWN / OPERATIONS SOURCE SEEDS ───
// When deterministic parsing resolves reservoirOwner, these seeded sources are
// injected as discovery targets so the pipeline can extract lake-level ranges,
// seasonal drawdown schedules, and operations facts from the authority that
// actually manages the water.

export { TINYFISH_BASE, TINYFISH_FETCH_BASE, tinyfishSearch, tinyfishFetch, FIRECRAWL_HARD_STOP, FIRECRAWL_KV_KEY, checkFirecrawlBudget, recordFirecrawlUsage, scrapeDoFetch, REGS_R2_BASE, REGS_2026_EFFECTIVE, USE_2026, STATE_REGULATIONS_CONFIG, extractMarkdownTables, parseSCTable, parseNCTable, parseGATable, parseTNStatewide, parseTNExceptions, parseTNRegion, PARSERS, normalizeLakeName, parseNCRegulationsWithLLM, parseRegulationsWithLLM, fetchStateRegulations, getLakeRegulations };
