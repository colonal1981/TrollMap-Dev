// research/shared.js — split from worker-research.js (behavior-preserving)
import { JSON_HEADERS } from '../worker-core.js';
import { STATE_REGULATIONS_CONFIG, fetchStateRegulations, getLakeRegulations, tinyfishFetch } from './clients.js';

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

async function handleResearchRegsDebug(request, env) {
  const url = new URL(request.url);
  const state = url.searchParams.get('state')?.toUpperCase();
  const lake = url.searchParams.get('lake') || '';
  const raw = url.searchParams.get('raw') === '1';
  const bust = url.searchParams.get('bust') === '1';
  if (!state) return new Response(JSON.stringify({ error: '?state= required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  try {
    const config = STATE_REGULATIONS_CONFIG[state];
    if (!config) return new Response(JSON.stringify({ error: 'No config for state' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    if (raw) {
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      const result = await tinyfishFetch({ urls: config.pages.map(p => p.url), format: 'markdown' }, env);
      const text = result.results?.[0]?.text || '';
      const lmbIdx = text.search(/largemouth bass/i);
      return new Response(JSON.stringify({ state, url: config.pages[0].url, length: text.length, lmbIdx, preview: text.slice(offset, offset + 3000) }, null, 2), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
    // bust=1 clears KV cache so fresh parse runs
    if (bust) {
      await env.KV.delete(`regulations:${state}:v3`).catch(() => {});
      await env.KV.delete(`regulations:${state}:v2`).catch(() => {});
    }
    const stateRegs = await fetchStateRegulations(state, env);
    const lakeRegs = lake ? getLakeRegulations(stateRegs, lake) : null;
    return new Response(JSON.stringify({
      state, lake: lake || null,
      generalKeys: Object.keys(stateRegs.general || {}),
      lakeSpecificKeys: Object.keys(stateRegs.lakeSpecific || {}).slice(0, 20),
      lakeRegs: lakeRegs || null,
      sampleGeneral: Object.fromEntries(Object.entries(stateRegs.general || {}).slice(0, 5)),
    }, null, 2), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message, stack: e.stack?.slice(0, 500) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

export { SHARED_ROOT, SHARED_ENABLED_DEFAULT, sharedEnabled, contentFingerprint, urlToDocId, SECTION_HEADING_PREFIXES, CHUNK_SIZE, CHUNK_OVERLAP, segmentDocument, chunkText, LAKE_CATALOG, tagSectionsWithLakes, CATEGORY_KEYWORDS, tagSectionsWithCategories, getSharedPointer, getSharedDocument, storeSharedDocument, getSharedRegistryEntry, handleSharedCheck, handleSharedStore, handleSharedQuery, handleSharedPublish, handleSharedStatus, handleSharedQuarantine, isQuarantined, handleResearchRegsDebug };
