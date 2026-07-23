// research/discover.js — split from worker-research.js (behavior-preserving)
import { JSON_HEADERS } from '../worker-core.js';
import { tinyfishFetch, tinyfishSearch } from './clients.js';
import { DUKE_CRA_PDFS, resolveDrawdownSource } from './drawdown.js';
import { KNOWN_BAD_NEPIS_IDS, buildNepisSearchUrl } from './dataset.js';

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
  // NOTE: regulations agent uses KV-cached fetchStateRegulations (0 docs needed) from R2 public bucket
  // User has all regs pages that matter uploaded to R2 (https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/regulations)
  // Primary source is R2 digests, fallback to live agency pages
  const REGS_R2_BASE = 'https://pub-36d686650ccc4a4aa9993ae9b2d29713.r2.dev/regulations';
  const R2_REGS_MAP = {
    SC: `${REGS_R2_BASE}/sc_digest_2025_2026.pdf`,
    NC: `${REGS_R2_BASE}/nc_digest_2025_2026.pdf`,
    GA: `${REGS_R2_BASE}/ga_digest_2025_2026.pdf`,
    TN: `${REGS_R2_BASE}/tn_digest_2025_2026.pdf`,
  };
  if (wantsRegs) {
    // R2 digest primary (user uploaded, stable, free via TinyFish)
    const r2RegsUrl = R2_REGS_MAP[state];
    if (r2RegsUrl) {
      addSeed({ title: `${state} Freshwater Regulations Digest (R2)`, type: 'PDF', authority: dnrName, url: r2RegsUrl, priority: 1, agentTags: ['regulations'] });
    }
    // Live agency page fallback
    addSeed({ title: regsTitle, type: 'HTML', authority: dnrName, url: regsUrl, priority: 2, agentTags: ['regulations'] });
    if (state === 'GA') {
      addSeed({ title: 'GA General Freshwater Regulations (eRegulations)', type: 'HTML', authority: 'GADNR', url: 'https://www.eregulations.com/georgia/fishing/general-regulations', priority: 2, agentTags: ['regulations'] });
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
  // Expanded from 3 to 10 based on user's local HTML archive (2026-07-22)
  // These pages contain almost every detail needed for TN lakes: surface area, max depth,
  // dam, owner, species, regulations, boat ramps, etc. — see https://www.tn.gov/twra/fishing/where-to-fish/east-tennessee-r4/
  const TWRA_LAKE_PAGES = {
    'boone': 'https://www.tn.gov/twra/fishing/where-to-fish/east-tennessee-r4/boone-reservoir.html',
    'cherokee': 'https://www.tn.gov/twra/fishing/where-to-fish/east-tennessee-r4/cherokee-reservoir.html',
    'chilhowee': 'https://www.tn.gov/twra/fishing/where-to-fish/east-tennessee-r4/chilhowee-reservoir.html',
    'douglas': 'https://www.tn.gov/twra/fishing/where-to-fish/east-tennessee-r4/douglas-reservoir.html',
    'fort loudoun': 'https://www.tn.gov/twra/fishing/where-to-fish/east-tennessee-r4/fort-loudoun-reservoir.html',
    'melton hill': 'https://www.tn.gov/twra/fishing/where-to-fish/east-tennessee-r4/melton-hill-reservoir.html',
    'norris': 'https://www.tn.gov/twra/fishing/where-to-fish/east-tennessee-r4/norris-reservoir.html',
    'south holston': 'https://www.tn.gov/twra/fishing/where-to-fish/east-tennessee-r4/south-holston-reservoir.html',
    'tellico': 'https://www.tn.gov/twra/fishing/where-to-fish/east-tennessee-r4/tellico-reservoir.html',
    'watauga': 'https://www.tn.gov/twra/fishing/where-to-fish/east-tennessee-r4/watauga-reservoir.html',
    // Aliases for baseName matching (boone lake vs boone reservoir, etc.)
    'boone lake': 'https://www.tn.gov/twra/fishing/where-to-fish/east-tennessee-r4/boone-reservoir.html',
    'cherokee lake': 'https://www.tn.gov/twra/fishing/where-to-fish/east-tennessee-r4/cherokee-reservoir.html',
    'douglas lake': 'https://www.tn.gov/twra/fishing/where-to-fish/east-tennessee-r4/douglas-reservoir.html',
    'fort loudoun lake': 'https://www.tn.gov/twra/fishing/where-to-fish/east-tennessee-r4/fort-loudoun-reservoir.html',
    'melton hill lake': 'https://www.tn.gov/twra/fishing/where-to-fish/east-tennessee-r4/melton-hill-reservoir.html',
    'norris lake': 'https://www.tn.gov/twra/fishing/where-to-fish/east-tennessee-r4/norris-reservoir.html',
    'south holston lake': 'https://www.tn.gov/twra/fishing/where-to-fish/east-tennessee-r4/south-holston-reservoir.html',
    'tellico lake': 'https://www.tn.gov/twra/fishing/where-to-fish/east-tennessee-r4/tellico-reservoir.html',
    'watauga lake': 'https://www.tn.gov/twra/fishing/where-to-fish/east-tennessee-r4/watauga-reservoir.html',
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

    const isClarksHillThurmond =
      /thurmond|clarks?\s+hill/i.test(`${queryLake} ${queryLakeFinal}`);
    const discoveryLakeNames = isClarksHillThurmond
      ? [
          queryLakeFinal,
          'J. Strom Thurmond Lake',
          'Clarks Hill Lake',
        ]
      : [queryLakeFinal];
    const queries = [
      ...new Set(
        discoveryLakeNames.flatMap(name => stateQueries(name))
      )
    ];
    if (!queries.length) continue;
    const discoveryAliases = [
      ...new Set([
        ...lakeSystemAliases,
        ...discoveryLakeNames,
        ...(isClarksHillThurmond
          ? ['J. Strom Thurmond Lake', 'Clarks Hill Lake']
          : []),
      ])
    ];

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

export { handleResearchDiscover };
