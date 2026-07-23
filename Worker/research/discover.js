// research/discover.js — split from worker-research.js (behavior-preserving)
import { JSON_HEADERS } from '../worker-core.js';
import { STATE_REGULATIONS_CONFIG, tinyfishFetch, tinyfishSearch } from './clients.js';
import { KNOWN_BAD_NEPIS_IDS, buildNepisSearchUrl } from './dataset.js';
import { parseLakeBaseName } from './keys.js';

async function handleResearchDiscover(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || "").trim();
  const state = String(body.state || "SC").trim().toUpperCase();

  if (!lakeName) {
    return new Response(JSON.stringify({ success: false, error: "Missing lakeName" }), { status: 400, headers: JSON_HEADERS });
  }

  // Normalize display names once. This supports R2 source lookup without making
  // live-source discovery depend on a growing per-lake alias table.
  const baseName = parseLakeBaseName(lakeName);
  const baseLower = baseName.toLowerCase();
  const queryLake = lakeName.replace(/,\s*(SC|NC|GA|TN)(\/(?:SC|NC|GA|TN))*\s*$/i, '').trim();

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
    return null;
  };

  // State label only; regulation documents come from the approved R2 config.
  const dnrName = ({ SC: 'SCDNR', NC: 'NCWRC', GA: 'GADNR', TN: 'TWRA' })[state] || 'SCDNR';

  // Grokipedia is an allowed source, but use generic page candidates instead of
  // maintaining lake-by-lake slugs or companion-page seeds.

  const STATE_FISH_AGENCY_DOMAINS = {
    SC: ['dnr.sc.gov', 'des.sc.gov'],
    NC: ['ncwildlife.gov', 'ncwildlife.org', 'deq.nc.gov', 'files.nc.gov'],
    GA: ['georgiawildlife.com', 'georgiawildlife.blog'],
    TN: ['tn.gov/twra', 'tn.gov/environment'],
  };
  const STATE_ENVIRONMENT_DOMAINS = {
    SC: ['des.sc.gov', 'dnr.sc.gov'],
    NC: ['deq.nc.gov', 'ncwildlife.gov'],
    GA: ['epd.georgia.gov', 'georgiawildlife.com'],
    TN: ['tn.gov/environment'],
  };
  const stateFishDomain = (STATE_FISH_AGENCY_DOMAINS[state] || [])[0] || '';
  const stateEnvDomain = (STATE_ENVIRONMENT_DOMAINS[state] || [])[0] || '';

  // SCDNR fisheries survey PDFs are usually embedded in annual Freshwater
  // Fisheries Investigation / Statewide Research reports rather than a simple
  // per-lake page. Keep this as a function so the biology query list can call it
  // safely for each lake name.
  const SC_FWFI_QUERY = (lake) => `"${lake}" "Fisheries Investigations" site:dnr.sc.gov filetype:pdf`;

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
      if (/\.gov$|usace\.army\.mil|epa\.gov|usgs\.gov|ferc\.gov|tva\.com|tva\.gov|osti\.gov|noaa\.gov|santeecooper\.com|duke-energy\.com|georgiapower\.com/.test(host)) score += 3;
      else if (/\.edu$/.test(host) && (candidate.url.toLowerCase().includes(baseLower) || title.includes(baseLower))) score += 2;
    } catch {}

    // Document type bonuses
    if (/report|assessment|survey|management.plan|study|investigation/.test(title + snippet)) score += 2;
    if (url.endsWith('.pdf') || /\/open$|download\?attachment|\/media\/\d+\/download/.test(url)) score += 1;

    // Negative signals
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
    ],
    NC: (lake) => [
      `"${lake}" dam owner FERC license reservoir filetype:pdf`,
    ],
    GA: (lake) => [
      `"${lake}" dam owner FERC license reservoir filetype:pdf`,
    ],
    TN: (lake) => [
      `"${lake}" dam owner FERC license reservoir filetype:pdf`,
    ],
  },
  limnology: {
    SC: (lake) => [
      `"${lake}" dissolved oxygen water quality monitoring assessment filetype:pdf`,
      `"${lake}" thermocline hypolimnion temperature profile filetype:pdf`,
      ...(stateEnvDomain ? [`"${lake}" water quality monitoring site:${stateEnvDomain}`] : []),
    ],
    NC: (lake) => [
      `"${lake}" dissolved oxygen water quality monitoring assessment filetype:pdf`,
      `"${lake}" thermocline hypolimnion temperature profile filetype:pdf`,
      ...(stateEnvDomain ? [`"${lake}" water quality monitoring site:${stateEnvDomain}`] : []),
    ],
    GA: (lake) => [
      `"${lake}" dissolved oxygen water quality monitoring assessment filetype:pdf`,
      `"${lake}" thermocline hypolimnion temperature profile filetype:pdf`,
      ...(stateEnvDomain ? [`"${lake}" water quality monitoring site:${stateEnvDomain}`] : []),
    ],
    TN: (lake) => [
      `"${lake}" dissolved oxygen water quality monitoring assessment filetype:pdf`,
      `"${lake}" thermocline hypolimnion temperature profile filetype:pdf`,
      ...(stateEnvDomain ? [`"${lake}" water quality monitoring site:${stateEnvDomain}`] : []),
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
    ],
    NC: (lake) => [
      `"${lake}" aquatic vegetation hydrilla management -site:facebook.com -site:instagram.com`,
      `"${lake}" fish habitat enhancement assessment -site:facebook.com -site:instagram.com`,
    ],
    GA: (lake) => [
      `"${lake}" aquatic vegetation hydrilla management -site:facebook.com -site:instagram.com`,
      `"${lake}" fish habitat enhancement assessment -site:facebook.com -site:instagram.com`,
    ],
    TN: (lake) => [
      `"${lake}" aquatic vegetation hydrilla management -site:facebook.com -site:instagram.com`,
      `"${lake}" fish habitat enhancement assessment -site:facebook.com -site:instagram.com`,
    ],
  },
  navigation: {
    SC: (lake) => [
      `"${lake}" navigation hazards channel markers -site:facebook.com -site:instagram.com -site:youtube.com`,
    ],
    NC: (lake) => [
      `"${lake}" navigation hazards channel markers -site:facebook.com -site:instagram.com -site:youtube.com`,
    ],
    GA: (lake) => [
      `"${lake}" navigation hazards channel markers -site:facebook.com -site:instagram.com -site:youtube.com`,
    ],
    TN: (lake) => [
      `"${lake}" navigation hazards channel markers -site:facebook.com -site:instagram.com -site:youtube.com`,
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
  const wantsNepis        = !agentForSeeds || ['limnology'].includes(agentForSeeds);

  // Grokipedia is allowed, but never receives lake-specific routing. Try the
  // predictable public page spellings and let citation following find sources.
  const grokCandidates = [
    `https://grokipedia.com/page/Lake_${baseName.replace(/\s+/g,'_')}`,
    `https://grokipedia.com/page/Lake_${baseName.replace(/\s+/g,'_')}_Lake`,
    `https://grokipedia.com/page/${baseName.replace(/\s+/g,'_').toLowerCase()}_lake`,
    `https://grokipedia.com/page/${baseName.replace(/\s+/g,'_')}`,
  ];
  if (wantsGrokipedia) {
    addSeed({ title: `${lakeName} — Grokipedia (discovered candidate)`, type: 'HTML', authority: 'Grokipedia', url: grokCandidates[0], priority: 2, agentTags: ['identity','limnology','biology','habitat'] });
  }

  // State regulations — regulations agent only
  // NOTE: regulations agent uses KV-cached fetchStateRegulations (0 docs needed) from R2 public bucket
  // User has all regs pages that matter uploaded to R2 (https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/regulations)
  // Primary source is R2 digests, fallback to live agency pages
  const r2RegsUrl = STATE_REGULATIONS_CONFIG[state]?.pages?.[0]?.url || null;
  if (wantsRegs) {
    // R2 digest primary (user uploaded, stable, free via TinyFish)
    if (r2RegsUrl) {
      addSeed({ title: `${state} Freshwater Regulations Digest (R2)`, type: 'PDF', authority: dnrName, url: r2RegsUrl, priority: 1, agentTags: ['regulations'] });
    }
  }

  // TWRA reservoir profiles — R2-hosted static copies (live tn.gov blocks scrapers)
  // Contains species, regulations, seasonal patterns, stocking, depth, ramps for each TN lake.
  const TWRA_LAKE_PAGES = {
    'boone':            'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/twra-tn/boone.html',
    'cherokee':         'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/twra-tn/cherokee.html',
    'chilhowee':        'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/twra-tn/chilhowee.html',
    'douglas':          'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/twra-tn/douglas.html',
    'fort loudoun':     'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/twra-tn/fort-loudoun.html',
    'melton hill':      'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/twra-tn/melton-hill.html',
    'norris':           'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/twra-tn/norris.html',
    'south holston':    'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/twra-tn/south-holston.html',
    'tellico':          'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/twra-tn/tellico.html',
    'watauga':          'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/twra-tn/watauga.html',
    'boone lake':       'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/twra-tn/boone.html',
    'cherokee lake':    'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/twra-tn/cherokee.html',
    'douglas lake':     'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/twra-tn/douglas.html',
    'fort loudoun lake':'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/twra-tn/fort-loudoun.html',
    'melton hill lake': 'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/twra-tn/melton-hill.html',
    'norris lake':      'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/twra-tn/norris.html',
    'south holston lake':'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/twra-tn/south-holston.html',
    'tellico lake':     'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/twra-tn/tellico.html',
    'watauga lake':     'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/twra-tn/watauga.html',
  };

  // GADNR fishing forecasts — R2-hosted static copies (live site uses ArcGIS StoryMaps, blocks scrapers)
  // Contains species prospects, techniques, seasonal patterns, stocking, habitat per GA lake.
  const GADNR_LAKE_PAGES = {
    'allatoona':        'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/gadnr-ga/allatoona.html',
    'andrews':          'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/gadnr-ga/andrews.html',
    'bartletts ferry':  'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/gadnr-ga/bartletts-ferry.html',
    'big haynes':       'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/gadnr-ga/big-haynes.html',
    'blackshear':       'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/gadnr-ga/blackshear.html',
    'blue ridge':       'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/gadnr-ga/blue-ridge.html',
    'burton':           'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/gadnr-ga/burton.html',
    'carters':          'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/gadnr-ga/carters.html',
    'chatuge':          'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/gadnr-ga/chatuge.html',
    'chehaw':           'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/gadnr-ga/chehaw.html',
    'clarks hill':      'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/gadnr-ga/clarks-hill.html',
    'goat rock':        'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/gadnr-ga/goat-rock.html',
    'hamburg':          'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/gadnr-ga/hamburg.html',
    'hartwell':         'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/gadnr-ga/hartwell.html',
    'high falls':       'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/gadnr-ga/high-falls.html',
    'jackson':          'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/gadnr-ga/jackson.html',
    'juliette':         'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/gadnr-ga/juliette.html',
    'lanier':           'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/gadnr-ga/lanier.html',
    'nottely':          'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/gadnr-ga/nottely.html',
    'oconee':           'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/gadnr-ga/oconee.html',
    'oliver':           'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/gadnr-ga/oliver.html',
    'rabun':            'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/gadnr-ga/rabun.html',
    'russell':          'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/gadnr-ga/russell.html',
    'seed':             'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/gadnr-ga/seed.html',
    'seminole':         'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/gadnr-ga/seminole.html',
    'sinclair':         'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/gadnr-ga/sinclair.html',
    'tobesofkee':       'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/gadnr-ga/tobesofkee.html',
    'tugalo':           'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/gadnr-ga/tugalo.html',
    'walter f george':  'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/gadnr-ga/walter-f-george.html',
    'west point':       'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/gadnr-ga/west-point.html',
    'yonah':            'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/research/static/gadnr-ga/yonah.html',
  };
  if (state === 'TN' && TWRA_LAKE_PAGES[baseLower] && (!agentForSeeds || ['identity','biology','fisheries','regulations'].includes(agentForSeeds))) {
    addSeed({ title: `${baseName} TWRA Reservoir Profile`, type: 'HTML', authority: 'TWRA', url: TWRA_LAKE_PAGES[baseLower], priority: 1, agentTags: ['identity','biology','fisheries','regulations'] });
  }

  if (state === 'GA' && GADNR_LAKE_PAGES[baseLower] && (!agentForSeeds || ['identity','biology','fisheries','regulations'].includes(agentForSeeds))) {
    addSeed({ title: `${baseName} GADNR Fishing Forecast`, type: 'HTML', authority: 'GADNR', url: GADNR_LAKE_PAGES[baseLower], priority: 1, agentTags: ['identity','biology','fisheries','regulations'] });
  }

  // NEPIS EPA survey search — limnology only
  if (wantsNepis) {
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
  if (wantsGrokipedia) {
    try {
      let grokUrl = null;
      let grokText = '';
      let grokStructuredLinks = [];  // hoisted out of loop — tfGrok is block-scoped inside
      for (const candidate of grokCandidates) {
        try {
          const tfGrok = await tinyfishFetch({
            urls: [candidate],
            format: 'markdown',
            links: true,
            image_links: true,
            ttl: 86400
          }, env);
          const tfResult = tfGrok.results?.[0] || {};
          const candidateMarkdown = String(tfResult.text || '');
          const candidateLinks = tfResult.links || [];
          const isLakeArticle = /grokipedia\.com\/page\/blewett_falls_lake/i.test(candidate)
            ? /blewett\s+falls\s+lake/i.test(candidateMarkdown)
            : candidateMarkdown.length >= 200;
          if (candidateMarkdown.length >= 200 && isLakeArticle) {
            grokUrl = candidate;
            grokText = candidateMarkdown;
            // Store links for citation extraction (structured)
            if (candidateLinks.length) {
              grokStructuredLinks = candidateLinks;
            }
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
        // Extract citation URLs — prefer structured links from TinyFish (links=True), fallback to regex on markdown
        // User provided Python example: from tinyfish import TinyFish; result = client.fetch.get_contents(urls=[...], format="markdown", links=True, image_links=True)
        // result.results[0].links gives structured links
        const citationLinks = [];
        const seen = new Set();
        // Try structured links first (more reliable than regex)
        const structuredLinks = grokStructuredLinks || [];
        if (structuredLinks.length) {
          for (const u of structuredLinks) {
            const urlStr = typeof u === 'string' ? u : (u.url || u.href || '');
            if (!urlStr) continue;
            if (seen.has(urlStr)) continue;
            seen.add(urlStr);
            if (urlStr.includes('grokipedia.com')) continue;
            if (/facebook\.com|twitter\.com|youtube\.com|instagram\.com|wikipedia\.org\/wiki\/Wikipedia:/i.test(urlStr)) continue;
            citationLinks.push(urlStr);
          }
        }
        // Fallback regex on markdown for any missed links
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
            else if (/osti\.gov/.test(host)) authority = 'Academic';
            else if (/noaa\.gov/.test(host)) authority = 'Academic';
            else if (/dnr\.sc\.gov/.test(host)) authority = 'SCDNR';
            else if (/ncwildlife\.gov|ncwildlife\.org/.test(host)) authority = 'NCWRC';
            else if (/georgiawildlife\.com/.test(host)) authority = 'GADNR';
            else if (/tn\.gov/.test(host)) authority = 'TWRA';
            else if (/duke-energy\.com/.test(host)) authority = 'Duke Energy';
            else if (/ferc\.gov/.test(host)) authority = 'FERC';
            else if (/santeecooper\.com/.test(host)) authority = 'Santee Cooper';
            else if (/seafwa\.org|apms\.org/.test(host)) authority = 'Academic';
            else if (/\.edu$/.test(host) && citUrl.toLowerCase().includes(baseLower)) authority = 'Academic';
            else if (/tva\.com|tva\.gov/.test(host)) authority = 'TVA';
            else if (/southcarolinaparks\.com|scprt|state\.sc\.us|greenwoodcounty-sc\.gov|des\.sc\.gov/i.test(host)) authority = 'SC State';
            else authority = 'Web';
          } catch {}

          if (authority === 'Web') {
            queryLog.push(`  ✗ grok citation skipped (low-value): ${citUrl.slice(0,80)}`);
            continue;
          }

          const isPdf = citUrl.toLowerCase().endsWith('.pdf');
          addSeed({ title: `${lakeName} — ${authority} (via Grokipedia citation)`, type: isPdf ? 'PDF' : 'HTML', authority, url: citUrl, priority: 2, agentTags: ['identity','limnology','biology','habitat'] });
        }
      }
    } catch (e) {
      queryLog.push(`Grokipedia citation fetch failed: ${e.message}`);
    }
  }



  // ── STEP 2b: Wikipedia citation following (fallback when Grokipedia missing) ──
  // Search Wikipedia for the lake, fetch its page, extract high-value agency links.
  // Only runs for identity-type agents; skipped if Grokipedia already ran successfully.
  if (wantsGrokipedia) {
    try {
      // Build Wikipedia search query — use "Lake X" to avoid person-name collisions
      const wikiQuery = `site:wikipedia.org "Lake ${baseName}"`;
      const wikiSearch = await tinyfishSearch({
        query: wikiQuery,
        domain_type: 'web',
        purpose: `Find Wikipedia page for ${lakeName} to extract agency citation links`,
        location: 'US',
        language: 'en',
      }, env);
      const wikiUrl = wikiSearch.results?.find(r => /en\.wikipedia\.org\/wiki\//i.test(r.url))?.url;
      if (wikiUrl) {
        const wikiSlug = wikiUrl.split('/wiki/').pop();
        queryLog.push(`Wikipedia citations found: ${0} from ${wikiSlug}`);
        try {
          const wikiResult = await tinyfishFetch({ urls: [wikiUrl], format: 'markdown', links: true, ttl: 86400 }, env);
          const wikiPage = wikiResult.results?.[0] || {};
          const wikiMd = String(wikiPage.text || '');
          const wikiLinks = wikiPage.links || [];
          let wikiCitCount = 0;

          for (const citUrl of wikiLinks) {
            const urlStr = typeof citUrl === 'string' ? citUrl : (citUrl.url || citUrl.href || '');
            if (!urlStr || urlStr.includes('wikipedia.org') || urlStr.includes('wikimedia.org') || urlStr.includes('wikidata.org')) continue;
            if (/facebook\.com|twitter\.com|youtube\.com|instagram\.com|geohack|archive\.org/i.test(urlStr)) continue;

            let authority = '';
            try {
              const host = new URL(urlStr).hostname;
              if (/usace\.army\.mil/.test(host)) authority = 'USACE';
              else if (/epa\.gov|nepis/.test(host)) authority = 'EPA';
              else if (/usgs\.gov/.test(host)) authority = 'USGS';
              else if (/osti\.gov/.test(host)) authority = 'Academic';
              else if (/noaa\.gov/.test(host)) authority = 'Academic';
              else if (/dnr\.sc\.gov/.test(host)) authority = 'SCDNR';
              else if (/ncwildlife\.gov|ncwildlife\.org/.test(host)) authority = 'NCWRC';
              else if (/georgiawildlife\.com/.test(host)) authority = 'GADNR';
              else if (/tn\.gov/.test(host)) authority = 'TWRA';
              else if (/duke-energy\.com/.test(host)) authority = 'Duke Energy';
              else if (/ferc\.gov/.test(host)) authority = 'FERC';
              else if (/santeecooper\.com/.test(host)) authority = 'Santee Cooper';
              else if (/seafwa\.org|apms\.org/.test(host)) authority = 'Academic';
              else if (/\.edu$/.test(host) && urlStr.toLowerCase().includes(baseLower)) authority = 'Academic';
              else if (/tva\.com|tva\.gov/.test(host)) authority = 'TVA';
              else if (/southcarolinaparks\.com|scprt|state\.sc\.us|greenwoodcounty-sc\.gov|des\.sc\.gov/i.test(host)) authority = 'SC State';
              else authority = 'Web';
            } catch {}

            if (authority === 'Web') {
              queryLog.push(`  ✗ wiki citation skipped (low-value): ${urlStr.slice(0,80)}`);
              continue;
            }

            const isPdf = urlStr.toLowerCase().endsWith('.pdf');
            addSeed({ title: `${lakeName} — ${authority} (via Wikipedia citation)`, type: isPdf ? 'PDF' : 'HTML', authority, url: urlStr, priority: 2, agentTags: ['identity','limnology','biology','habitat'] });
            wikiCitCount++;
          }

          queryLog.push(`Wikipedia citations found: ${wikiCitCount} from ${wikiSlug}`);

          // Also seed Wikipedia page itself for infobox data (surface area, depth, etc.)
          const existingWiki = guaranteedSeeds.find(s => s.url === wikiUrl);
          if (!existingWiki) {
            addSeed({ title: `${lakeName} — Wikipedia`, type: 'HTML', authority: 'Wikipedia', url: wikiUrl, priority: 2, agentTags: ['identity'], fullText: wikiMd });
          } else if (wikiMd) {
            existingWiki.fullText = wikiMd;
          }
        } catch (wikiErr) {
          queryLog.push(`Wikipedia fetch failed for ${wikiUrl}: ${wikiErr.message}`);
        }
      } else {
        queryLog.push(`Wikipedia: no page found for ${baseName}`);
      }
    } catch (e) {
      queryLog.push(`Wikipedia citation fetch failed: ${e.message}`);
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

    const discoveryLakeNames = [queryLake];
    const queryCandidates = [];
    for (const name of discoveryLakeNames) {
      try {
        queryCandidates.push(...(stateQueries(name) || []));
      } catch (e) {
        queryLog.push(`[${agentKey}] query builder failed for ${name}: ${e.message}`);
      }
    }
    const queries = [...new Set(queryCandidates.filter(Boolean))];
    if (!queries.length) continue;
    const discoveryAliases = [
      ...new Set([
        ...discoveryLakeNames,
      ])
    ];

    const agentTags = AGENT_TO_TAGS[agentKey] || [agentKey];
    const purposeFn = AGENT_DISCOVERY_QUERIES._purposes?.[agentKey];
    const purposeStr = purposeFn ? purposeFn(queryLake, state) : `Find authoritative ${agentKey} information about ${lakeName} in ${state}`;

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
          const prefetchScore = scoreCandidateRelevance(candidate, lakeName, baseName, discoveryAliases, state);

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
            else if (/tva\.com|tva\.gov/.test(host)) authority = 'TVA';
            else if (/osti\.gov/.test(host)) authority = 'Academic';
            else if (/noaa\.gov/.test(host)) authority = 'Academic';
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

  // No live hard-coded fallback: an empty result is an honest search outcome.
  // R2 regulations, Grokipedia/Wikipedia, and search results have already been tried.

  return new Response(JSON.stringify({ success: true, sources: finalList, baseName, filteredCount: 0, queryLog }), { headers: JSON_HEADERS });
}

export { handleResearchDiscover };
