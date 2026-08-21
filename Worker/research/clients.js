// research/clients.js — split from worker-research.js (behavior-preserving)
import { callLLM, extractLLMText } from '../worker-core.js';

// All /research/* route handlers, RESEARCH_AGENTS, deterministic facts, dataset hunt, etc.


// ─── TINYFISH API CLIENT ───
const TINYFISH_BASE = 'https://api.search.tinyfish.ai';
const TINYFISH_FETCH_BASE = 'https://api.fetch.tinyfish.ai';

/** Comma-separated, the way TinyFish wants domain lists. Arrays or a string both work in. */
function csvDomains(v) {
  const list = Array.isArray(v) ? v : String(v || '').split(',');
  const out = list.map((d) => String(d || '').trim()).filter(Boolean);
  return out.length ? out.join(',') : null;
}

async function tinyfishSearch({ query, domain_type = 'web', purpose, location, language, recency_minutes, after_date, before_date, include_domains, exclude_domains, pub_year_min, pub_year_max }, env) {
  const key = env.TINYFISH_API_KEY;
  if (!key) throw new Error('TINYFISH_API_KEY not configured');

  const params = new URLSearchParams({ query });
  if (domain_type) params.set('domain_type', domain_type);
  if (purpose) params.set('purpose', purpose);
  if (location) params.set('location', location);
  if (language) params.set('language', language);

  // DOMAIN FILTERING BY PARAMETER, NOT BY OPERATOR. TinyFish still accepts `site:`/`-site:`
  // inside the query but documents them as DEPRECATED, and says why: the dedicated params
  // "don't collide with other query syntax". Ours collide constantly -- 52 of the 76 operator
  // uses in discover.js sit next to a quoted phrase in the same string.
  const inc = csvDomains(include_domains);
  const exc = csvDomains(exclude_domains);
  if (inc) params.set('include_domains', inc);
  if (exc) params.set('exclude_domains', exc);

  // RESEARCH PAPERS DO NOT TAKE A DATE WINDOW. TinyFish: recency_minutes / after_date /
  // before_date "are not supported for domain_type=research_paper" -- pub_year_min/max replace
  // them. Passing both is an invalid request, and `biology` query 3 is a research_paper search
  // sitting one config change away from acquiring a recency window it cannot use.
  const isPaper = domain_type === 'research_paper';
  if (isPaper) {
    if (recency_minutes || after_date || before_date) {
      console.warn('[tinyfish] dropping the date window on a research_paper search — '
                 + 'that endpoint takes pub_year_min/pub_year_max instead');
    }
    if (Number.isFinite(pub_year_min)) params.set('pub_year_min', String(pub_year_min));
    if (Number.isFinite(pub_year_max)) params.set('pub_year_max', String(pub_year_max));
  } else {
    if (recency_minutes) params.set('recency_minutes', String(recency_minutes));
    if (after_date) params.set('after_date', after_date);
    if (before_date) params.set('before_date', before_date);
  }
  
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

// ─── ONE SEARCH, FOUR PROVIDERS, IN COST ORDER ───
//
// Ryan, 2026-08-20: *"these are the tools i have tinyfish, jina.ai, tavily, firecrawl, and
// scrape.do -- wire them in as appropriate for the skills that they all have"*.
//
// WHAT WAS WRONG. Six places in the research engine ran a web search and FIVE of them called
// tinyfishSearch() bare: if TinyFish returned nothing, that was the end of the question. The
// sixth -- handleResearchGapSearch() -- had a full TinyFish -> Tavily -> Firecrawl cascade
// written inline, so the capability existed, was paid for, and one caller in six could reach it.
// This is that cascade lifted out, not a new one invented.
//
// THE ORDER IS THE COST, AND JINA IS LAST HERE FOR A REASON WORTH WRITING DOWN.
//
//   tinyfish   free
//   tavily     1 credit (basic). 1,000 in hand. The ONLY fallback that can express this app's
//              date filters exactly -- see the recency note below.
//   firecrawl  1 credit. 1,764 in hand, and the balance is now read from the account.
//   jina       s.jina.ai. NOT available without a key, and a fixed 10,000 tokens per search
//              whatever it returns -- about 200 searches out of the ~2M left on a pool that
//              DOES NOT REFILL. It is last because it is the only finite one.
//
// And note the asymmetry with readUrl(): r.jina.ai is FREE keyless, so Jina is near the top of
// the fetch chain and at the bottom of this one. Same vendor, opposite ends, because the two
// halves of it are priced completely differently.
//
// A FALLBACK MUST NOT SILENTLY ANSWER A DIFFERENT QUESTION. Callers pass `recency_minutes`,
// `after_date` and `before_date`, and a provider that cannot express them would return results
// from outside the window while looking like it worked -- a filter that quietly does nothing.
// Tavily takes start_date/end_date/time_range and can express all three exactly. Firecrawl's
// search takes `tbs`, which only has day/week/month/year buckets, so it is given one ONLY when
// the requested window rounds to a bucket without widening; otherwise that rung is skipped and
// the reason is logged. Jina's search takes no date filter at all, so it is skipped outright
// whenever a window was asked for.

/** Whole days back, rounded UP so the window can only narrow, never widen. */
function daysFromRecency(recencyMinutes) {
  if (!Number.isFinite(recencyMinutes) || recencyMinutes <= 0) return null;
  return Math.max(1, Math.ceil(recencyMinutes / 1440));
}

/**
 * Firecrawl `tbs` for a window, or null when no bucket fits.
 *
 * THE BUCKET MUST NEVER BE WIDER THAN THE WINDOW. The first version of this read
 * `days <= 31 ? 'qdr:m' : days <= 365 ? 'qdr:y'`, which turned a 45-day request into "the past
 * YEAR" -- results eight months too old, returned as though they answered the question. Caught by
 * its own test before it ran anywhere.
 *
 * So it picks the largest bucket whose span is at or under the request. That NARROWS: a 45-day
 * window is served by the past month, which may miss two weeks of valid results but cannot
 * return an invalid one. Missing something and inventing something are not the same error, and
 * only one of them is silent.
 */
function tbsForDays(days) {
  if (!Number.isFinite(days) || days < 1) return null;
  if (days >= 365) return 'qdr:y';
  if (days >= 31) return 'qdr:m';
  if (days >= 7) return 'qdr:w';
  return 'qdr:d';
}

/** `YYYY-MM-DD`, `days` before now. Exact — no bucketing, so nothing is widened. */
function startDateForDays(days, now = Date.now()) {
  if (!Number.isFinite(days) || days < 1) return null;
  return new Date(now - days * 86400000).toISOString().slice(0, 10);
}

/**
 * Normalise any provider's row WITHOUT throwing away what it sent.
 *
 * THE FIRST VERSION OF THIS RETURNED A FIXED SHAPE and that was a regression, committed the same
 * day. discover.js reads more off a result than the four obvious fields:
 *
 *     r.site_name / r.siteName      -> candidate.siteName
 *     r.date / r.published_date     -> candidate.publishedDate
 *     r.score                       -> candidate.searchScore
 *     r.pdf_url                     -> a DIRECT PDF LINK on research_paper results
 *
 * publishedDate and searchScore both feed scoreCandidateRelevance(), so a shape that dropped them
 * quietly degraded the ranking of every result while every test stayed green. Normalising to a
 * shape without reading the consumer first is the same mistake as counting the wrong thing.
 *
 * So: spread the original row, then FILL what is missing. Never overwrite what a provider
 * actually said -- a real snippet is better than markdown truncated to snippet length.
 */
function normaliseHit(r, provider) {
  const content = r.markdown || r.content || r.snippet || r.description || r.raw_content || '';
  return {
    ...r,
    url: r.url || r.link || null,
    title: r.title || r.url || null,
    content,
    // Callers variously read .markdown/.snippet/.description. Fill the ones the provider did not
    // send so switching provider cannot silently empty a field one call site happens to use.
    markdown: r.markdown || content,
    snippet: r.snippet || content,
    description: r.description || content,
    // Tavily and Firecrawl spell the date differently; carry both spellings so the consumer's
    // `r.date || r.published_date` finds it whoever answered.
    published_date: r.published_date || r.publishedDate || r.date || undefined,
    provider,
  };
}

/**
 * Search the web, falling down the cost ladder until something answers.
 *
 * Drop-in for tinyfishSearch(): same parameter names, and `.results` in the same shape.
 * Additionally returns `provider` (who answered) and `skipped` (who was not asked, and why),
 * so a run that quietly fell through to the expensive rung says so in the log.
 */
async function searchWeb(params, env) {
  const { query, recency_minutes, after_date, before_date,
          include_domains, exclude_domains } = params || {};
  const incList = (Array.isArray(include_domains) ? include_domains
                  : String(include_domains || '').split(',')).map((d) => String(d).trim()).filter(Boolean);
  const excList = (Array.isArray(exclude_domains) ? exclude_domains
                  : String(exclude_domains || '').split(',')).map((d) => String(d).trim()).filter(Boolean);
  // Firecrawl and Jina publish no domain parameter, so for those two the restriction goes back
  // into the query as operators -- which is what every provider was being given before today.
  // Not a regression for them; TinyFish and Tavily are the two that get upgraded to real params.
  const operatorSuffix = [
    incList.length ? `(${incList.map((d) => `site:${d}`).join(' OR ')})` : '',
    ...excList.map((d) => `-site:${d}`),
  ].filter(Boolean).join(' ');
  const queryWithOperators = operatorSuffix ? `${query} ${operatorSuffix}` : query;
  const wantsWindow = !!(recency_minutes || after_date || before_date);
  const days = daysFromRecency(recency_minutes);
  const skipped = [];
  const enough = (rows) => Array.isArray(rows) && rows.length > 0;

  // 1. TINYFISH — free, and the only one that takes every parameter natively.
  try {
    const tf = await tinyfishSearch(params, env);
    if (enough(tf && tf.results)) {
      return { results: tf.results.map((r) => normaliseHit(r, 'tinyfish')), provider: 'tinyfish', skipped };
    }
  } catch (e) {
    console.warn(`[search] tinyfish failed for "${String(query).slice(0, 60)}": ${e.message}`);
  }

  // 2. TAVILY — 1 credit, and it can express the window exactly, so nothing is lost by falling here.
  if (env.TAVILY_API_KEY) {
    try {
      const body = { query, search_depth: 'basic', include_answer: false, max_results: 5 };
      // Tavily takes real arrays: 300 include, 150 exclude.
      if (incList.length) body.include_domains = incList.slice(0, 300);
      if (excList.length) body.exclude_domains = excList.slice(0, 150);
      if (after_date) body.start_date = after_date;
      if (before_date) body.end_date = before_date;
      // EXACT, not bucketed. `time_range` only has day/week/month/year, so a 45-day window
      // would have to become "year" -- the same widening bug tbsForDays() carries a note about.
      // start_date states the actual boundary, so falling to Tavily loses nothing at all.
      if (days != null && !after_date && !before_date) body.start_date = startDateForDays(days);
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.TAVILY_API_KEY}` },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const j = await res.json();
        if (enough(j && j.results)) {
          console.log(`[search] tavily answered "${String(query).slice(0, 60)}" (${j.results.length} results)`);
          return { results: j.results.map((r) => normaliseHit(r, 'tavily')), provider: 'tavily', skipped };
        }
      } else {
        console.warn(`[search] tavily HTTP ${res.status}`);
      }
    } catch (e) {
      console.warn(`[search] tavily error: ${e.message}`);
    }
  } else {
    skipped.push('tavily: no TAVILY_API_KEY');
  }

  // 3. FIRECRAWL — 1 credit, budget-guarded, and only when the window survives the bucketing.
  // `tbs` is a relative bucket. It cannot express "after 2026-08-14" at all, so an absolute
  // window skips this rung outright rather than being approximated into something else.
  const absoluteWindow = !!(after_date || before_date);
  const tbs = absoluteWindow ? null : tbsForDays(days);
  const windowLost = wantsWindow && !tbs;
  if (windowLost) {
    // Refusing beats answering a different question.
    skipped.push(`firecrawl: cannot express the requested date window (${after_date || ''}${before_date ? '..' + before_date : ''}${days ? days + 'd' : ''}) without widening it`);
  }
  const firecrawlKey = env.FIRECRAWL_API_KEY || env.FIRECRAWL_KEY;
  if (firecrawlKey && !windowLost) {
    const budget = await checkFirecrawlBudget(env, 1);
    if (budget.allowed) {
      try {
        const body = { query: queryWithOperators, limit: 5 };
        if (tbs) body.tbs = tbs;
        const res = await fetch('https://api.firecrawl.dev/v2/search', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${firecrawlKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          const j = await res.json();
          const rows = (j.data && (j.data.web || j.data)) || [];
          if (enough(rows)) {
            await recordFirecrawlUsage(env, 1);
            console.log(`[search] firecrawl answered "${String(query).slice(0, 60)}" (${rows.length} results)`);
            return { results: rows.map((r) => normaliseHit(r, 'firecrawl')), provider: 'firecrawl', skipped };
          }
        } else {
          console.warn(`[search] firecrawl HTTP ${res.status}`);
        }
      } catch (e) {
        console.warn(`[search] firecrawl error: ${e.message}`);
      }
    } else {
      skipped.push(`firecrawl: ${budget.reason}`);
    }
  } else if (!firecrawlKey) {
    skipped.push('firecrawl: no FIRECRAWL_API_KEY');
  }

  // 4. JINA s.jina.ai — LAST, and only when no date window was asked for.
  //
  // 10,000 tokens flat per search out of a pool that does not refill, and its search endpoint
  // takes no date filter at all, so a windowed query cannot be honoured here even approximately.
  if (wantsWindow) {
    skipped.push('jina: s.jina.ai takes no date filter, and the query asked for one');
  } else if (env.JINA_API_KEY) {
    try {
      const res = await fetch(`https://s.jina.ai/${encodeURIComponent(queryWithOperators)}`, {
        headers: {
          'Authorization': `Bearer ${env.JINA_API_KEY}`,
          'Accept': 'application/json',
          'X-Return-Format': 'markdown',
        },
      });
      if (res.ok) {
        const j = await res.json();
        const rows = (j && (j.data || j.results)) || [];
        if (enough(rows)) {
          console.warn(`[search] JINA answered "${String(query).slice(0, 60)}" — that is ~10,000 tokens `
                     + `off a pool that does not refill. Everything cheaper had already failed.`);
          return { results: rows.map((r) => normaliseHit(r, 'jina')), provider: 'jina', skipped };
        }
      } else {
        console.warn(`[search] jina HTTP ${res.status}`);
      }
    } catch (e) {
      console.warn(`[search] jina error: ${e.message}`);
    }
  } else {
    skipped.push('jina: no JINA_API_KEY (s.jina.ai has no keyless tier, unlike r.jina.ai)');
  }

  // NOBODY ANSWERED IS AN ANSWER, and it is not the same as "there is nothing out there".
  console.warn(`[search] no provider answered "${String(query).slice(0, 80)}"`
             + (skipped.length ? ` — skipped: ${skipped.join('; ')}` : ''));
  return { results: [], provider: null, skipped };
}

// ─── FIRECRAWL CREDIT GUARD ───
//
// FIRECRAWL IS ASKED WHAT IS LEFT. IT IS NOT TOLD.
//
// This used to be a hand-typed number in KV, seeded by pasting the balance off the dashboard --
// `env.KV.put('firecrawl:credits_remaining', '269')` -- and decremented locally from there. That
// is a restated fact, and a restated fact is stale the moment the thing it describes changes.
// It went stale in the worst possible direction on 2026-08-20: Ryan topped up to 1,764 credits
// and the counter, still counting down from 269, had nothing to do with reality.
//
// Worse, the read was `parseInt(await env.KV.get(KEY) || '0', 10)`. A MISSING KEY READ AS ZERO,
// which is below the hard stop, which disables Firecrawl entirely -- silently, and looking
// exactly like "you are out of credits". An absent number and a number that is zero are not the
// same fact and only one of them means stop.
//
// So the balance now comes from Firecrawl: GET /v2/team/credit-usage -> data.remainingCredits.
// It is cached for FIRECRAWL_TTL_MS so a research run costs a couple of balance checks an hour
// rather than one per page, and `recordFirecrawlUsage` decrements the cache between refreshes so
// a burst inside one window cannot overshoot the floor.
//
// A BALANCE WE COULD NOT READ IS NOT A BALANCE OF ZERO. When the account endpoint cannot be
// reached and nothing is cached, this refuses AND SAYS THE BALANCE IS UNKNOWN, so the log
// distinguishes "out of credits" from "could not ask" -- which is the distinction the old `|| '0'`
// threw away.
const FIRECRAWL_HARD_STOP = 50;  // Never go below this — avoids auto-upgrade to paid tier
const FIRECRAWL_KV_KEY = 'firecrawl:credits_remaining';   // cache: {"remaining":N,"at":epochMs}
const FIRECRAWL_TTL_MS = 30 * 60 * 1000;

/** The account balance, straight from Firecrawl. null when it could not be asked. */
async function fetchFirecrawlBalance(env) {
  const key = env.FIRECRAWL_API_KEY || env.FIRECRAWL_KEY;
  if (!key) return null;
  try {
    const res = await fetch('https://api.firecrawl.dev/v2/team/credit-usage', {
      headers: { 'Authorization': `Bearer ${key}` },
    });
    if (!res.ok) {
      console.warn(`[firecrawl] credit-usage HTTP ${res.status} — balance not refreshed`);
      return null;
    }
    const j = await res.json();
    const n = j && j.data && j.data.remainingCredits;
    // A balance endpoint that answers 200 with no number is a shape change, not a zero balance.
    if (!Number.isFinite(n)) {
      console.warn('[firecrawl] credit-usage returned no remainingCredits — balance not refreshed');
      return null;
    }
    return n;
  } catch (e) {
    console.warn(`[firecrawl] credit-usage error: ${e && e.message} — balance not refreshed`);
    return null;
  }
}

/** The cached balance and its age, or null when nothing has ever been cached. */
async function readFirecrawlCache(env) {
  const raw = await env.KV.get(FIRECRAWL_KV_KEY);
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    if (Number.isFinite(o && o.remaining)) return { remaining: o.remaining, at: Number(o.at) || 0 };
  } catch (_) {
    // The old format was a bare number. Read it rather than throwing the balance away, but treat
    // it as infinitely old so the next check refreshes from the account.
    const n = parseInt(raw, 10);
    if (Number.isFinite(n)) return { remaining: n, at: 0 };
  }
  return null;
}

async function writeFirecrawlCache(env, remaining, at) {
  await env.KV.put(FIRECRAWL_KV_KEY, JSON.stringify({ remaining, at }));
}

async function checkFirecrawlBudget(env, estimatedCredits = 1) {
  const now = Date.now();
  let cache = await readFirecrawlCache(env);
  if (!cache || now - cache.at > FIRECRAWL_TTL_MS) {
    const live = await fetchFirecrawlBalance(env);
    if (live !== null) {
      cache = { remaining: live, at: now };
      await writeFirecrawlCache(env, live, now);
      console.log(`[firecrawl] balance refreshed from account: ${live} credit(s)`);
    }
  }

  if (!cache) {
    // Never "0 remaining". Nobody said zero; nobody could be asked.
    return { allowed: false, remaining: null,
             reason: 'Firecrawl balance UNKNOWN — the account endpoint could not be reached and '
                   + 'nothing is cached. This is not the same as being out of credits.' };
  }
  const remaining = cache.remaining;
  if (remaining <= FIRECRAWL_HARD_STOP) {
    return { allowed: false, remaining, reason: `Firecrawl hard stop (${remaining} remaining, limit ${FIRECRAWL_HARD_STOP})` };
  }
  if (remaining - estimatedCredits <= FIRECRAWL_HARD_STOP) {
    return { allowed: false, remaining, reason: `Firecrawl would breach hard stop (${remaining} remaining)` };
  }
  return { allowed: true, remaining, useTinyFishOnly: false };
}

/**
 * Decrement the cached balance after a spend.
 *
 * This is the guard BETWEEN refreshes, not the source of truth -- the next refresh overwrites it
 * with whatever Firecrawl says. It exists so that a burst of twenty pages inside one TTL window
 * cannot spend past the floor on a balance read once at the start of it.
 *
 * It never CREATES a cache entry. Inventing a balance from a spend would put a number in KV that
 * no one measured, which is the whole thing this rewrite removes.
 */
async function recordFirecrawlUsage(env, credits = 1) {
  const cache = await readFirecrawlCache(env);
  if (!cache) {
    console.log(`[firecrawl] used ${credits} credit(s) — no cached balance to decrement`);
    return;
  }
  const newRemaining = Math.max(0, cache.remaining - credits);
  await writeFirecrawlCache(env, newRemaining, cache.at);
  console.log(`[firecrawl] used ${credits} credit(s) — ${newRemaining} remaining (cached)`);
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

// Which of those dates were actually read off the document, and which are inherited.
//
// SC and GA are quoted: Regs2627.pdf page 1 says "August 14, 2026-August 14, 2027",
// and 26GAAB-LR.pdf says "effective for the period of July 1, 2026 through June 30,
// 2027". NC and TN are NOT verified. They kept August 1 because that is the date the
// old shared constant happened to hold — the same unexamined inheritance that had SC
// switching eleven days early. Both digests on the drive are page-range excerpts that
// do not include their covers, and neither NCWRC's nor TWRA's site states a date
// plainly enough to rely on.
//
// This is recorded rather than guessed because an unverified date that looks like a
// verified one is how the SC bug survived. Checking costs one look at each cover.
const REGS_DATE_VERIFIED = { SC: true, GA: true, NC: false, TN: false };
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


// THE SALTWATER HALF OF THE SAME BOOK.
//
// Ryan, 2026-08-20: "why would we hard code regulations... i want it to match freshwater
// exactly... its the same exact files as freshwater". It is. The SC digest is 29 pages: 1-18
// freshwater, 19-20 boating, 21-29 saltwater. GA's is 1-20 / 21-29. Both are already downloaded
// on every cold /regulations call, and freshwaterRegionOf() then cuts the saltwater half off
// before the parser sees it.
//
// So this takes a `kind` instead of gaining a twin. Three things differ and nothing else does:
// the noun in the prompt, the species vocabulary, and the anchor the 35k window starts from --
// searching for "largemouth bass" in a saltwater table finds nothing and falls back to 20% in,
// which is the middle of a licence page.
//
// Saltwater returns `general` only. These limits are set per STATE, not per waterbody: there is
// no saltwater equivalent of "Lake Wateree striped bass". lakeSpecific stays empty by design
// rather than by accident.
const REG_VOCAB = {
  freshwater: {
    noun: 'freshwater',
    anchor: /largemouth bass|warmwater game fish|daily (bag|creel|limit)|size limit/i,
    species: "'Largemouth Bass', 'Smallmouth Bass', 'Spotted Bass', 'Striped Bass / Hybrid', "
           + "'White Bass', 'Crappie', 'Black Crappie', 'White Crappie', 'Bluegill', 'Catfish', "
           + "'Blue Catfish', 'Channel Catfish', 'Flathead Catfish', 'Walleye', 'Yellow Perch', "
           + "'Chain Pickerel', 'Muskellunge', 'Trout', 'Kokanee Salmon', 'Sauger'",
    extra: '- For lake/waterbody-specific exceptions: key them by the exact waterbody name as written.',
  },
  saltwater: {
    noun: 'saltwater / inshore',
    anchor: /red drum|spotted seatrout|sheepshead|size & catch limits|inshore finfish/i,
    // THESE EXACT STRINGS ARE THE APP'S KEYS -- js/data/coastal-regulations.js
    // COASTAL_SPECIES_LIST. "Spotted Seatrout (Speckled Trout)" and "Speckled Trout (Spotted
    // Seatrout)" are the same fish and neither string contains the other, so a lookup by
    // substring misses and the angler is told the book says nothing about seatrout.
    species: "'Red Drum (Redfish)', 'Speckled Trout (Spotted Seatrout)', 'Southern Flounder', "
           + "'Black Drum', 'Sheepshead', 'Tripletail', 'Bluefish', 'Cobia', 'Spanish Mackerel', "
           + "'King Mackerel', 'Striped Bass'",
    extra: "- A SLOT has both ends: \"18-25 inch TL\" is a minimum of 18 AND a maximum of 25. Never\n"
         + "  collapse a slot to its minimum -- keeping a 30 inch fish out of an 18-25 slot is illegal\n"
         + "  and a lost maximum reads as permission.\n"
         + "- A CLOSED SEASON is not a limit. Put closures in specialRules verbatim, including dates.\n"
         + "- Vessel limits (\"not to exceed 10 per boat\") belong in specialRules, not creelLimit.\n"
         + "- lakeSpecific MUST be empty: saltwater limits here are statewide.",
  },
};

async function parseRegulationsWithLLM(state, text, pageHint, env, kind = 'freshwater') {
  const V = REG_VOCAB[kind] || REG_VOCAB.freshwater;
  const systemPrompt = `You are an expert ${V.noun} fishing regulation parser for ${state}.
The input is text extracted from the official state fishing regulations digest.
Extract ALL statewide creel and size limits, and ALL lake-specific or waterbody-specific exceptions.

Rules:
- For statewide/general rules: extract the default that applies to ALL public waters.
${V.extra}
- Species names to use: ${V.species}.
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

  // Find the limits table — skip licence, gear and intro pages.
  let start = text.search(V.anchor);
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
    console.error(`parseRegulationsWithLLM(${state}, ${kind}) failed:`, e.message);
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

  if (useDigest2026(state) && REGS_DATE_VERIFIED[state] === false) {
    console.warn(`fetchStateRegulations(${state}): serving the 2026-2027 digest on an ` +
                 `UNVERIFIED effective date (${REGS_EFFECTIVE[state].toISOString().slice(0,10)} ` +
                 `was inherited, not read off the cover).`);
  }
  
  const pages = config.pages;
  const urls = pages.map(p => p.url);
  
  // Fetch all pages via TinyFish (R2 public URLs are fetchable, free)
  const result = await tinyfishFetch({ urls, format: 'markdown' }, env);

  const parsed = { general: {}, lakeSpecific: {}, saltwater: {} };
  let anyPageFailed = false;

  // All states now use LLM-based extraction from R2 digest PDFs
  const digestText = [];
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const full = result.results?.[i]?.text || '';
    // Keep the WHOLE page even when its freshwater region is too short to parse. The saltwater
    // pass below reads `digestText`, and a digest whose freshwater half failed to extract still
    // carries a perfectly good saltwater half.
    if (full) digestText.push(full);
    const text = freshwaterRegionOf(full);
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

  // THE OTHER HALF OF THE SAME DOWNLOAD. freshwaterRegionOf() above cut the saltwater section
  // off each page before the freshwater parser saw it. Parsing that section costs one more LLM
  // call and NO extra fetch -- the bytes are already in `digestText`. Without this the saltwater
  // table is downloaded on every cold call and thrown away, and the app falls back to a
  // hand-typed table that a person has to re-read off a PDF every August.
  //
  // ONCE, not once per page. Every state ships a single digest page today, but a second page
  // would otherwise re-locate and re-parse the same saltwater section and bill for it twice.
  //
  // A saltwater failure does NOT set anyPageFailed. States differ: SC and GA carry saltwater in
  // the same book, TN has no coast at all, and treating "this state has no saltwater section"
  // as a broken parse would drop every freshwater answer to a 1-hour TTL.
  if (SALTWATER_DIGEST[state] && digestText.length) {
    const ext = extractSaltwaterDigest(state, digestText.join('\n'));
    if (ext.located && (ext.text || '').length >= 500) {
      const saltParsed = await parseRegulationsWithLLM(
        state, ext.text, `${state} saltwater / inshore finfish size and catch limits`,
        env, 'saltwater');
      if (saltParsed.failed) {
        console.warn(`fetchStateRegulations(${state}): saltwater parse failed -- ` +
                     `freshwater is unaffected: ${saltParsed.error}`);
      } else {
        parsed.saltwater = { ...(parsed.saltwater || {}), ...(saltParsed.general || {}) };
        parsed.saltwaterSource = { anchor: ext.anchor || null,
                                   published: SALTWATER_DIGEST[state].published || null };
      }
    } else {
      console.warn(`fetchStateRegulations(${state}): no saltwater section located in the digest`);
    }
  }
  
  // CACHE ONLY A GOOD RESULT.
  // Empty-because-it-broke must not be cacheable. A failed parse, or a parse that
  // yielded nothing at all, gets a 1-hour TTL so the next request retries instead
  // of serving "this state has no regulations" until November.
  // Saltwater deliberately does NOT count here. This gate exists to stop an empty freshwater
  // parse being cached for 90 days; a state with saltwater rows and no freshwater ones is still
  // a broken freshwater parse, and TN having no saltwater at all is not a failure of anything.
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

// A window reaching 1,200 characters BACKWARDS can cross out of the saltwater section
// and pull freshwater limits in with it. On the shipped books it does not, because
// both saltwater sections open with pages of licence and gear text before the first
// species name -- so the reach back lands on more saltwater. That is luck about this
// year's layout, not a property of the format, and it is the same "arithmetic, not a
// guarantee" that the freshwater 35,000-character window had.
//
// So a window may not reach back past the last FRESHWATER species name before it. The
// purpose of reaching back at all is to catch the table header above a row
// ("SIZE LIMIT  DAILY CREEL LIMIT"), and a header never sits on the far side of
// another species' row.
const FRESHWATER_ONLY =
  /largemouth|smallmouth|spotted bass|crappie|walleye|bluegill|bream|redear|muskellunge|sauger|kokanee|mountain trout|rock bass|chain pickerel|white perch|yellow perch|bullhead/gi;

function extractSaltwaterDigest(state, text) {
  const cfg = SALTWATER_DIGEST[state];
  if (!cfg) return { text: null, located: false };

  // 'section' is a PREFERENCE, not a requirement. The running head is precise when it
  // is there -- it keeps the section's licence and gear pages, which carry no species
  // name and would otherwise be dropped. But it is an assumption about one text
  // extractor's output, and the Worker reads these through TinyFish as markdown, not
  // through pdftotext. If markdown renders the head as "## Saltwater Fishing" the
  // case-sensitive match fails, and the old code then returned null -- meaning SC and
  // GA would have silently had no digest at all, permanently, while looking like a
  // careful agent declining to guess. That is the exact failure this whole file was
  // written to remove.
  //
  // So a missed head degrades to the species-window pass over the whole document,
  // which is what NC uses and needs no head. Safe here because it is measured: in both
  // SC and GA, zero occurrences of "red drum", "seatrout" or "flounder" fall in the
  // freshwater half, so whole-document windows pull no freshwater content.
  let body = text, anchor = 'whole';
  if (cfg.scope === 'section') {
    const sliced = sliceSaltwaterSection(text);
    if (sliced.located) { body = sliced.text; anchor = 'head'; }
    else console.warn('extractSaltwaterDigest: no running head — falling back to species windows');
  }

  // Collect a window round every target species mention, then merge the overlaps.
  // End positions of every freshwater species name, so a window can be floored at the
  // nearest one behind it.
  FRESHWATER_ONLY.lastIndex = 0;
  const fwEnds = [...body.matchAll(FRESHWATER_ONLY)].map(m => m.index + m[0].length);

  const spans = [];
  SALTWATER_SPECIES.lastIndex = 0;
  for (const m of body.matchAll(SALTWATER_SPECIES)) {
    let floor = 0;
    for (const e of fwEnds) { if (e >= m.index) break; floor = e; }
    spans.push([Math.max(0, floor, m.index - WIN_BEFORE), Math.min(body.length, m.index + WIN_AFTER)]);
  }
  if (!spans.length) return { text: null, located: false, anchor };

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
  return { text: (preamble + parts.join('\n[...]\n')).slice(0, DIGEST_BUDGET), located: true, anchor };
}

// The saltwater section's RUNNING HEAD, matched case-sensitively. Both books set it
// in caps -- SC letter-spaced ("S A L T W A T E R  F I S H I N G"), GA plain
// ("SALTWATER FISHING REGULATIONS") -- so the pattern tolerates whitespace and
// markdown punctuation between letters but not a change of case.
//
// Case matters more than it looks. A case-insensitive search matched the sentence
// "...saltwater fishing license. If fishing in both fresh and saltwaters..." in the
// middle of SC's FRESHWATER nongame rules, 18,000 characters before the real
// section, and produced a slice that read as saltwater and was mostly trotline law.
// Measured on the shipped digests, the case-sensitive head matches 5 times in SC and
// 12 in GA, every one inside the saltwater section: zero occurrences of "red drum",
// "seatrout" or "flounder" fall before the first hit, and zero occurrences of
// "largemouth" fall after it.
const SALTWATER_HEAD =
  /S[\s#*_>|-]*A[\s#*_>|-]*L[\s#*_>|-]*T[\s#*_>|-]*W[\s#*_>|-]*A[\s#*_>|-]*T[\s#*_>|-]*E[\s#*_>|-]*R[\s#*_>|-]+F[\s#*_>|-]*I[\s#*_>|-]*S[\s#*_>|-]*H[\s#*_>|-]*I[\s#*_>|-]*N[\s#*_>|-]*G/;

function sliceSaltwaterSection(text) {
  const m = SALTWATER_HEAD.exec(text);
  // No head, no slice. Returning the tail as a guess would hand the agent a document
  // that is labelled the saltwater baseline and is not one.
  if (!m) return { text: null, located: false };
  return { text: text.slice(m.index), located: true };
}

// Everything before the saltwater running head.
//
// The freshwater parser slices 35,000 characters forward from its first species hit,
// and the SC and GA digests now CONTAIN their saltwater sections -- so for the first
// time that window can run past the boundary and feed a saltwater limits table to a
// prompt whose species vocabulary is freshwater. Today it does not, because those
// digests extract to ~108k and ~118k characters and the boundary sits past the
// window. That is arithmetic about one text extractor, not a property of the data:
// a more compact extraction, or a digest with a shorter freshwater half, moves it.
//
// Cutting at the head makes it structural. When no head is found nothing is
// truncated, so a digest with no saltwater section is unaffected.
function freshwaterRegionOf(text) {
  const m = SALTWATER_HEAD.exec(text);
  if (!m) return text;
  const head = text.slice(0, m.index);
  return head.length >= 500 ? head : text;   // never truncate into uselessness
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
    out = { url: page.url, digestId, published: cfg.published, located: true,
            anchor: ext.anchor, content: ext.text };
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
    // after_date is a HARD constraint here -- an amendment from before the digest took effect
    // is not an amendment. searchWeb() only falls to a provider that can express it.
    const res = await searchWeb({
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

export { TINYFISH_BASE, TINYFISH_FETCH_BASE, tinyfishSearch, tinyfishFetch, searchWeb, daysFromRecency, tbsForDays, startDateForDays, normaliseHit, csvDomains, FIRECRAWL_HARD_STOP, FIRECRAWL_KV_KEY, FIRECRAWL_TTL_MS, fetchFirecrawlBalance, checkFirecrawlBudget, recordFirecrawlUsage, scrapeDoFetch, REGS_R2_BASE, REGS_2026_EFFECTIVE, REGS_EFFECTIVE, REGS_DATE_VERIFIED, useDigest2026, USE_2026, STATE_REGULATIONS_CONFIG, SALTWATER_DIGEST, SALTWATER_HEAD, FRESHWATER_ONLY, sliceSaltwaterSection, freshwaterRegionOf, extractSaltwaterDigest, DIGEST_BUDGET, fetchSaltwaterRegulations, fetchLiveRegsAmendments, extractMarkdownTables, parseSCTable, parseNCTable, parseGATable, parseTNStatewide, parseTNExceptions, parseTNRegion, PARSERS, normalizeLakeName, parseNCRegulationsWithLLM, parseRegulationsWithLLM, fetchStateRegulations, getLakeRegulations };
