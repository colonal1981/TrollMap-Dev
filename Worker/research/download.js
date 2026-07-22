// research/download.js — split from worker-research.js (behavior-preserving)
import { JSON_HEADERS } from '../worker-core.js';
import { checkFirecrawlBudget, recordFirecrawlUsage, scrapeDoFetch, tinyfishFetch } from './clients.js';
import { KNOWN_BAD_NEPIS_IDS, toNepisRawTextUrl } from './dataset.js';

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

async function handleResearchProxyDownloadBatch(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const { urls } = body; // array of { url, canonicalUrl, title, type }
  if (!Array.isArray(urls) || !urls.length) {
    return new Response(JSON.stringify({ ok: false, error: 'missing urls array' }), { status: 400, headers: JSON_HEADERS });
  }

  const scrapedoKey = env.SCRAPEDO_TOKEN || env.SCRAPEDO_API_KEY;

  // Separate into TinyFish-eligible and special-case URLs
  const tinyFishBatch = [];
  const specialUrls = [];

  for (const item of urls) {
    const target = item.url || '';
    const isPdf = (item.type || '').toUpperCase() === 'PDF' || /\.pdf(?:$|[?#])/i.test(target);
    const isNepis = /nepis\.epa\.gov|ZyNET\.exe/i.test(target);
    const isWaterAtlas = /wateratlas\.usf\.edu/i.test(target);

    if (isPdf || isNepis || isWaterAtlas) {
      specialUrls.push({ ...item, reason: isPdf ? 'pdf' : isNepis ? 'nepis' : 'blocked' });
    } else {
      tinyFishBatch.push(item);
    }
  }

  const results = [];

  // Batch fetch HTML URLs via TinyFish
  if (tinyFishBatch.length > 0) {
    const batchUrls = tinyFishBatch.map(item => item.url);
    let tfResults = [];
    let tfFailed = [...tinyFishBatch]; // assume all failed until proven otherwise

    try {
      const tfData = await tinyfishFetch({ urls: batchUrls, format: 'markdown', ttl: 86400 }, env);
      tfResults = tfData.results || [];
      tfFailed = [];

      for (let i = 0; i < tinyFishBatch.length; i++) {
        const item = tinyFishBatch[i];
        const result = tfResults[i];
        const text = result?.text || result?.markdown || result?.content || '';
        if (text && text.length > 200) {
          results.push({ url: item.url, text, source: 'tinyfish', ok: true, title: item.title });
        } else {
          tfFailed.push(item); // too short — retry on Scrape.do
        }
      }
    } catch (e) {
      console.warn(`[batch-fetch] TinyFish batch failed: ${e.message} — falling back to Scrape.do for all`);
      tfFailed = [...tinyFishBatch];
    }

    // Retry TinyFish failures on Scrape.do — up to 5 concurrent (Scrape.do limit)
    if (!scrapedoKey) {
      for (const item of tfFailed) {
        results.push({ url: item.url, text: '', source: 'none', ok: false, error: 'TinyFish failed, no Scrape.do key', title: item.title });
      }
    } else {
      const sdFetch = async (item) => {
        try {
          const sdUrl = `https://api.scrape.do?token=${scrapedoKey}&url=${encodeURIComponent(item.url)}&render=false&super=false`;
          const sdController = new AbortController();
          const sdTimer = setTimeout(() => sdController.abort(), 8000);
          let sdRes;
          try {
            sdRes = await fetch(sdUrl, { headers: { 'Accept': 'text/html,*/*' }, signal: sdController.signal });
          } finally {
            clearTimeout(sdTimer);
          }
          if (sdRes.ok) {
            const html = await sdRes.text();
            const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            if (text.length > 200) return { url: item.url, text, source: 'scrapedo', ok: true, title: item.title };
          }
          return { url: item.url, text: '', source: 'scrapedo', ok: false, error: `Scrape.do ${sdRes.status}`, title: item.title };
        } catch (e2) {
          const isTimeout = e2.name === 'AbortError';
          return { url: item.url, text: '', source: 'none', ok: false, error: isTimeout ? 'Scrape.do timeout (8s)' : e2.message, title: item.title };
        }
      };
      // Run up to 5 concurrent Scrape.do fetches
      const SD_CONCURRENCY = 5;
      for (let i = 0; i < tfFailed.length; i += SD_CONCURRENCY) {
        const batch = tfFailed.slice(i, i + SD_CONCURRENCY);
        const batchResults = await Promise.all(batch.map(sdFetch));
        results.push(...batchResults);
      }
    }
  }

  // Special URLs return as unhandled — engine fetches these individually
  for (const item of specialUrls) {
    results.push({ url: item.url, text: '', source: 'unhandled', ok: false, reason: item.reason, title: item.title });
  }

  return new Response(JSON.stringify({ ok: true, results }), { headers: JSON_HEADERS });
}


// A canonical source is fetched and normalized no more than once, regardless of
// how many lakes or categories use it. Documents are stored immutably by version;
// a generation pointer controls which index is active. Kill switch:
// SHARED_RESEARCH_ENABLED=false falls back to current per-lake behavior.

export { handleResearchProxyDownload, handleResearchProxyDownloadBatch };
