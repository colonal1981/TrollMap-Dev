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

// Each digest comes into force on the date printed on its own cover, and those
// dates are not the same. The SC 2026-2027 book reads "August 14, 2026-August 14,
// 2027"; GA's reads "effective for the period of July 1, 2026 through June 30,
// 2027"; NC and TN run from August 1. One shared August 1 constant therefore
// published SC's new limits eleven days before they were law and held GA's back by
// a month. The fishing year is per-state, so the switch has to be per-state.
const REGS_EFFECTIVE = {
  SC: new Date('2026-08-14'),
  GA: new Date('2026-07-01'),
  NC: new Date('2026-08-01'),
  TN: new Date('2026-08-01')
};
// Kept for existing importers. NC/TN keep the original date, so this is unchanged.
const REGS_2026_EFFECTIVE = REGS_EFFECTIVE.NC;
const useDigest2026 = (state) => new Date() >= (REGS_EFFECTIVE[state] || REGS_2026_EFFECTIVE);
const USE_2026 = useDigest2026('NC');

// `url` is a getter rather than a string, so which digest a page points at is
// resolved when it is read instead of when the module loads. An isolate that
// started before an effective date would otherwise serve the previous year's book
// for as long as it lived. Every consumer still just reads `pg.url`.
function digestPage(state, name2026, name2025, pageHint) {
  const pg = { key: 'general', parser: 'llmParser', pageHint };
  Object.defineProperty(pg, 'url', {
    enumerable: true,
    get() { return `${REGS_R2_BASE}/${useDigest2026(state) ? name2026 : name2025}.pdf`; }
  });
  return pg;
}

const STATE_REGULATIONS_CONFIG = {
  SC: {
    // Cut from Regs2627.pdf pages 28-56 (29 pages). Digest pages 1-18 are freshwater
    // limits, state lakes and nongame device rules; 19-20 boating; 21-29 saltwater.
    // If the pdf is not in R2 yet, tinyfishFetch returns short text, the page is
    // skipped, and fetchStateRegulations caches the empty result for ONE HOUR rather
    // than 90 days -- so it self-heals on the next request after the upload.
    pages: [digestPage('SC', 'sc_digest_2026_2027', 'sc_digest_2025_2026',
      'freshwater fish size & possession limits, state lakes, nongame device limits by location, shad & herring -- digest pages 3-18')]
  },
  NC: {
    pages: [digestPage('NC', 'nc_digest_2026_2027', 'nc_digest_2025_2026',
      'warmwater game fish regulations \u2014 largemouth bass, crappie, catfish, walleye, striped bass sections')]
  },
  GA: {
    // Cut from 26GAAB-LR.pdf pages 62-90 (29 pages). Digest pages 1-20 freshwater,
    // 21-29 saltwater. In force since July 1, 2026 -- GA was still on the 2025-2026
    // book a month after its own successor took effect.
    pages: [digestPage('GA', 'ga_digest_2026_2027', 'ga_digest_2025_2026',
      'freshwater fishing regulations \u2014 daily limits and size limits for warmwater species')]
  },
  TN: {
    pages: [digestPage('TN', 'tn_digest_2026_2027', 'tn_digest_2025_2026',
      'statewide creel and length limits plus lake-specific exceptions')]
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
    // `failed: true` so the caller can tell "the parse broke" from "this state
    // publishes no lake-specific rules". Before 2026-08-03 both returned an empty
    // object and the empty one got cached for 90 days -- a single LLM hiccup
    // silently removed a state's fishing regulations for a quarter of a year.
    return { general: {}, lakeSpecific: {}, failed: true, error: e.message };
  }
}

async function fetchStateRegulations(state, env) {
  // Bump when normalization/exception matching changes; stale v3 entries were
  // produced without reliably splitting combined waterbody headings.
  //
  // THE DIGEST IDENTITY IS PART OF THE KEY. USE_2026 flipped on 2026-08-01 and NC
  // and TN switched to their 2026-2027 digests -- but the key did not change, so a
  // KV entry written in July still served 2025-2026 limits from the OLD pdf, and
  // would have kept doing so until its 90-day TTL expired in late October. A
  // regulation cache that cannot tell which document it parsed is a cache that
  // serves last year's law. Deriving the key from the actual source URLs means any
  // digest swap invalidates itself, with nobody needing to remember to bust it.
  const digestIds = (STATE_REGULATIONS_CONFIG[state]?.pages || [])
    .map(pg => (pg.url || '').split('/').pop().replace(/\.pdf$/i, '')).join('+');
  const cacheKey = `regulations:${state}:v5:${digestIds || 'nodigest'}`;
  let cached = await env.KV.get(cacheKey, { type: 'json' });
  if (cached) return cached;
  
  const config = STATE_REGULATIONS_CONFIG[state];
  if (!config) return { general: {}, lakeSpecific: {} };
  
  const pages = config.pages;
  const urls = pages.map(p => p.url);
  
  // Fetch all pages via TinyFish (R2 public URLs are fetchable, free)
  const result = await tinyfishFetch({ urls, format: 'markdown' }, env);

  const parsed = { general: {}, lakeSpecific: {} };
  let anyPageFailed = false;

  // All states now use LLM-based extraction from R2 digest PDFs
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const text = result.results?.[i]?.text || '';
    if (text.length < 500) {
      console.warn(`fetchStateRegulations(${state}): page ${i} returned insufficient text (${text.length} chars)`);
      continue;
    }
    const pageParsed = await parseRegulationsWithLLM(state, text, page.pageHint || '', env);
    if (pageParsed.failed) anyPageFailed = true;
    if (page.key === 'general') {
      parsed.general = { ...parsed.general, ...pageParsed.general };
    }
    // Always merge lakeSpecific regardless of key
    for (const [lake, speciesMap] of Object.entries(pageParsed.lakeSpecific || {})) {
      parsed.lakeSpecific[lake] = { ...(parsed.lakeSpecific[lake] || {}), ...speciesMap };
    }
  }
  
  // CACHE ONLY A GOOD RESULT.
  // Empty-because-it-broke must not be cacheable. A failed parse, or a parse that
  // yielded nothing at all, gets a 1-hour TTL so the next request retries instead
  // of serving "this state has no regulations" until November.
  const isEmpty = !Object.keys(parsed.general).length && !Object.keys(parsed.lakeSpecific).length;
  const ttl = (anyPageFailed || isEmpty) ? 60 * 60 : 90 * 24 * 60 * 60;
  if (anyPageFailed || isEmpty) {
    console.warn(`fetchStateRegulations(${state}): ${anyPageFailed ? 'a page failed to parse' : 'parsed nothing'} — caching for 1h, not 90d`);
  }
  await env.KV.put(cacheKey, JSON.stringify({ ...parsed, cachedAt: Date.now(), degraded: anyPageFailed || isEmpty }),
                   { expirationTtl: ttl });
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

// -- Saltwater -----------------------------------------------------------------
// The freshwater path parses the digest through a prompt whose species vocabulary
// is explicitly freshwater, so handing its output to the saltwater agent hands it a
// table with no red drum in it. That agent was written to read digest TEXT -- its
// own first rule is "The R2 digest provided is the BASELINE" -- so text is what it
// gets: the same pdf, sliced to its saltwater section, unparsed.
//
// NC is deliberately absent. The NC digest is the inland book; saltwater there is
// NC Marine Fisheries, published separately and amended by proclamation, so NC has
// no digest baseline and must rely on the live check below.
const SALTWATER_DIGEST = {
  SC: { published: '2026-2027 (effective August 14, 2026)', scope: 'section' },
  GA: { published: '2026-2027 (effective July 1, 2026)',    scope: 'section' },
  NC: {
    published: '2026-2027',
    // NC was excluded here on 2026-08-03 on the assumption that its digest is the
    // inland book and saltwater is Marine Fisheries' separate publication. Ryan:
    // "i am pretty sure NC combines fresh and salt on the same charts" -- and the
    // file says so. FLOUNDER, RED DRUM and SPOTTED SEATROUT are rows in the same
    // WARMWATER GAME FISH table as largemouth bass, flounder directly under
    // BULLHEADS, with real slots: red drum 18" min / nothing over 27", 1 per day;
    // spotted seatrout 14" min / nothing between 20 and 26", 3 per day; flounder
    // 15" min, 1 per day and a two-week season. Excluding NC removed the only
    // authoritative source for the species a kayak actually targets there.
    //
    // There is no saltwater running head to slice to, so the whole book is searched.
    scope: 'whole',
    jurisdiction:
      'NC JURISDICTION NOTE -- these limits are the Wildlife Resources Commission\'s and apply to ' +
      'INLAND and JOINT fishing waters when caught by hook and line. They do NOT govern COASTAL ' +
      'waters, which are the Division of Marine Fisheries\' and change by proclamation -- the digest ' +
      'itself prints "Established by Division of Marine Fisheries" and "Unless Changed by Proclamation" ' +
      'in those rows. If the zone lies in coastal waters, prefer the live amendment source and set ' +
      'verificationRequired true.'
  }
};

// The coastal agent template slices `_regsSource.content` to 12,000 characters
// (coastal-agents.js:160). Handing it 36,000 meant two thirds were dropped before
// the model saw them, silently, with the surviving third chosen by nothing more
// than where the section happened to start -- GA's first "red drum" landed at
// character 9,515, 2,500 short of being cut off. So the extract is built around the
// species rows and budgeted to fit whole.
const DIGEST_BUDGET = 11000;

const SALTWATER_SPECIES =
  /red drum|puppy drum|channel bass|spotted seatrout|seatrout|sea trout|flounder|sheepshead|black drum|tripletail/gi;

// Generous, because pdftotext emits table columns out of order: in the NC book a
// species' size limit, its water classification and its creel limit arrive on three
// separate lines with other rows interleaved. A tight window round the species name
// would cut a slot limit away from the number that bounds it.
const WIN_BEFORE = 1200, WIN_AFTER = 2000;

function extractSaltwaterDigest(state, text) {
  const cfg = SALTWATER_DIGEST[state];
  if (!cfg) return { text: null, located: false };

  let body = text;
  if (cfg.scope === 'section') {
    const sliced = sliceSaltwaterSection(text);
    if (!sliced.located) return { text: null, located: false };
    body = sliced.text;
  }

  // Collect a window round every target species mention, then merge the overlaps.
  const spans = [];
  SALTWATER_SPECIES.lastIndex = 0;
  for (const m of body.matchAll(SALTWATER_SPECIES)) {
    spans.push([Math.max(0, m.index - WIN_BEFORE), Math.min(body.length, m.index + WIN_AFTER)]);
  }
  if (!spans.length) return { text: null, located: false };

  const merged = [];
  for (const s of spans.sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push(s);
  }

  // The preamble comes out of the same budget it precedes. Adding it afterwards put
  // NC at 11,510 against the template's 12,000-character cut -- inside the limit by
  // luck, and silently losing its tail the moment the note is reworded.
  const preamble = cfg.jurisdiction ? cfg.jurisdiction + '\n\n' : '';
  const budget = DIGEST_BUDGET - preamble.length;

  const parts = [];
  let used = 0;
  for (const [a, b] of merged) {
    if (used >= budget) { parts.push('\n[...truncated: digest budget reached...]'); break; }
    const chunk = body.slice(a, Math.min(b, a + (budget - used)));
    parts.push(chunk);
    used += chunk.length;
  }
  // Hard cap. The '[...]' joiners are not free and the per-chunk accounting above
  // does not charge for them, so the budget is enforced once more on the result.
  return { text: (preamble + parts.join('\n[...]\n')).slice(0, DIGEST_BUDGET), located: true };
}

function sliceSaltwaterSection(text) {
  // The marker is the section's RUNNING HEAD, matched case-sensitively. Both books
  // set it in caps -- SC letter-spaced ("S A L T W A T E R  F I S H I N G"), GA
  // plain ("SALTWATER FISHING REGULATIONS") -- so the pattern tolerates arbitrary
  // whitespace between letters but not a change of case.
  //
  // Case matters more than it looks. A case-insensitive search matched the sentence
  // "...saltwater fishing license. If fishing in both fresh and saltwaters..." in the
  // middle of SC's FRESHWATER nongame rules, 18,000 characters before the real
  // section, and produced a slice that read as saltwater and was mostly trotline law.
  // Measured on the shipped digests, the case-sensitive head matches 5 times in SC and
  // 12 in GA, every one of them inside the saltwater section: zero occurrences of
  // "red drum", "seatrout" or "flounder" fall before the first hit, and zero
  // occurrences of "largemouth" fall after it.
  const head = /S\s*A\s*L\s*T\s*W\s*A\s*T\s*E\s*R\s+F\s*I\s*S\s*H\s*I\s*N\s*G/;
  const m = head.exec(text);
  // No head, no slice. Returning the tail as a guess would hand the agent a document
  // that is labelled the saltwater baseline and is not one; a null lets it take its
  // own honest "No R2 digest available -- do not guess limits; return nulls" branch.
  if (!m) return { text: null, located: false };
  return { text: text.slice(m.index), located: true };
}

async function fetchSaltwaterRegulations(state, env) {
  const cfg = SALTWATER_DIGEST[state];
  const page = STATE_REGULATIONS_CONFIG[state]?.pages?.[0];
  if (!cfg || !page) return null;

  // Same rule as the freshwater cache: the digest's identity is part of the key, so
  // a digest swap invalidates itself and nobody has to remember to bust it.
  const digestId = (page.url || '').split('/').pop().replace(/\.pdf$/i, '');
  const cacheKey = `saltwater-regs:${state}:v1:${digestId}`;
  const cached = await env.KV.get(cacheKey, { type: 'json' });
  if (cached) return cached;

  let out;
  try {
    const result = await tinyfishFetch({ urls: [page.url], format: 'markdown' }, env);
    const text = result.results?.[0]?.text || '';
    if (text.length < 500) {
      console.warn(`fetchSaltwaterRegulations(${state}): digest returned ${text.length} chars -- not caching`);
      return null;
    }
    const ext = extractSaltwaterDigest(state, text);
    if (!ext.located) {
      console.warn(`fetchSaltwaterRegulations(${state}): no saltwater species rows found in the digest -- not caching`);
      return null;
    }
    out = { url: page.url, digestId, published: cfg.published, located: true, content: ext.text };
  } catch (e) {
    console.warn(`fetchSaltwaterRegulations(${state}) failed: ${e.message}`);
    return null;  // a failure is not "this state has no saltwater rules"
  }
  await env.KV.put(cacheKey, JSON.stringify(out),
                   { expirationTtl: 90 * 24 * 60 * 60 });
  return out;
}

// Ryan, 2026-08-03: "the regulations agent should use those first and then a live
// check for news of any changes". The digest is an annual book. NC closes southern
// flounder and spotted seatrout by proclamation mid-season; SC and GA amend by
// regulation. This is the second half of that sentence -- a date-bounded search for
// amendments published since the digest took effect.
//
// It returns null rather than an empty object when the search is unavailable, and
// that distinction matters: the saltwater agent sets `verificationRequired` on the
// absence of a live source, and an empty-but-present source would silently clear
// that flag while confirming nothing.
const LIVE_REGS_QUERY = {
  SC: 'SCDNR saltwater fishing regulation change red drum spotted seatrout flounder size creel limit',
  GA: 'Georgia DNR Coastal Resources Division saltwater fishing regulation change red drum seatrout flounder limit',
  NC: 'NC Marine Fisheries proclamation southern flounder spotted seatrout season closure size limit'
};

async function fetchLiveRegsAmendments(state, env) {
  const query = LIVE_REGS_QUERY[state];
  if (!query) return null;
  const cacheKey = `live-regs:${state}:v1`;
  const cached = await env.KV.get(cacheKey, { type: 'json' });
  if (cached) return cached;

  const since = REGS_EFFECTIVE[state] || REGS_2026_EFFECTIVE;
  const after = since.toISOString().slice(0, 10);
  let out;
  try {
    const res = await tinyfishSearch({
      query, domain_type: 'web', location: 'US', language: 'en', after_date: after,
      purpose: `Find regulation amendments or proclamations issued after ${after} that change saltwater size, slot or creel limits in ${state}.`
    }, env);
    const hits = (res?.results || []).slice(0, 6);
    if (!hits.length) return null;
    out = {
      queriedAt: Date.now(),
      after,
      urls: hits.map(h => h.url).filter(Boolean),
      content: hits.map(h =>
        `- ${h.title || h.url || 'untitled'} (${h.url || 'no url'})\n  ` +
        String(h.markdown || h.content || h.snippet || h.description || '').slice(0, 600)
      ).join('\n')
    };
  } catch (e) {
    console.warn(`fetchLiveRegsAmendments(${state}) failed: ${e.message}`);
    return null;  // no source is not the same as no changes
  }
  // Short TTL on purpose. This exists to be fresher than the digest; a 90-day cache
  // of "what changed lately" is the same failure as the annual book it backstops.
  await env.KV.put(cacheKey, JSON.stringify(out), { expirationTtl: 12 * 60 * 60 });
  return out;
}

export { TINYFISH_BASE, TINYFISH_FETCH_BASE, tinyfishSearch, tinyfishFetch, FIRECRAWL_HARD_STOP, FIRECRAWL_KV_KEY, checkFirecrawlBudget, recordFirecrawlUsage, scrapeDoFetch, REGS_R2_BASE, REGS_2026_EFFECTIVE, REGS_EFFECTIVE, useDigest2026, USE_2026, STATE_REGULATIONS_CONFIG, SALTWATER_DIGEST, sliceSaltwaterSection, extractSaltwaterDigest, DIGEST_BUDGET, fetchSaltwaterRegulations, fetchLiveRegsAmendments, extractMarkdownTables, parseSCTable, parseNCTable, parseGATable, parseTNStatewide, parseTNExceptions, parseTNRegion, PARSERS, normalizeLakeName, parseNCRegulationsWithLLM, parseRegulationsWithLLM, fetchStateRegulations, getLakeRegulations };
