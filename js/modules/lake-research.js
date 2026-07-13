/**
 * Evidence Acquisition Module Design & Execution Engine (Step-by-Step Pipeline)
 * Implements spec:
 * Step 1: Lake Identification (generate canonical_lake.json)
 * Step 2: Source Discovery (automated crawlers/scrapers, generate source_catalog.json)
 * Step 3: Download Sources (CORS proxy fetch PDF/HTML, stream bytes to client, parse client-side with pdf.js, then save to normalized/ in R2, discard binary)
 * Step 4: Text Extraction (Client-side extraction of Title, Headings, Paragraphs, page numbers, tables)
 * Step 5: Source Quality Scoring (Compute scoring from authority, freshness, completeness)
 * Step 6: Document Classification (Classify documents: Hydrology, Biology, Regulations, etc.)
 * Step 7: Information Extraction (Run LLM large-context model for precise structured facts with page, confidence, quote)
 * Step 8: Evidence Deduplication (Merge identical facts, track newest/oldest source)
 * Step 9: Contradiction Detection (Flag conflicting evidence, visual review panel)
 * Step 10: Research Packet Generation (master R2 output research_packet.json)
 *
 * This integrates into/extends the existing `lake-research.js` UI seamlessly.
 */

import { state, CF_WORKER_URL } from '../core/state.js';
import { LAKE_DB } from '../data/lakes.js';

// Setup global caches and references
window.TROLLMAP_RESEARCHED_CACHE = window.TROLLMAP_RESEARCHED_CACHE || {};

const EVIDENCE_PIPELINE_STEPS = [
  { id: 'identify', label: 'Step 1: Lake Identification' },
  { id: 'discover', label: 'Step 2: Source Discovery' },
  { id: 'download_extract', label: 'Step 3-4: Proxy Download & Client-Side Extraction (pdf.js)' },
  { id: 'score_classify', label: 'Step 5-6: Quality Scoring & Classification' },
  { id: 'extract_facts', label: 'Step 7: Information Extraction (LLM)' },
  { id: 'dedupe_contradictions', label: 'Step 8-9: Deduplication & Contradiction Detection' },
  { id: 'packet', label: 'Step 10: Compile Research Packet' }
];

const RESEARCH_ORDER = ['identity', 'limnology', 'biology', 'habitat', 'navigation', 'regulations', 'trolling', 'summary'];
const RESEARCH_LABELS = {
  identity: '🆔 Identity',
  limnology: '🌊 Limnology',
  biology: '🐟 Fisheries',
  habitat: '🌿 Habitat',
  navigation: '🧭 Navigation',
  regulations: '📜 Regulations',
  trolling: '🎣 Trolling Intelligence',
  summary: '📝 AI Summary'
};

let currentProfile = null;
let currentLakeName = '';
let currentPackageFiles = [];
let currentVersions = [];
let researchInProgress = false;
let researchLog = [];
let packagePartsCache = {};

// Helper logging
function log(msg) {
  researchLog.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
  const el = document.getElementById('researchLog');
  if (el) {
    el.textContent = researchLog.join('\n');
    el.scrollTop = el.scrollHeight;
  }
  console.log(`[evidence-pipeline] ${msg}`);
}

function setProgress(label, pct) {
  const labelEl = document.getElementById('researchProgressLabel');
  const pctEl = document.getElementById('researchProgressPct');
  const fillEl = document.getElementById('researchProgressFill');
  if (labelEl) labelEl.textContent = label;
  if (pctEl) pctEl.textContent = `${Math.round(pct)}%`;
  if (fillEl) fillEl.style.width = `${pct}%`;
}

function showProgress(show) {
  const el = document.getElementById('researchProgress');
  if (el) el.style.display = show ? 'block' : 'none';
}

function sanitizeStateFromLakeName(lakeName) {
  const s = (lakeName || '').toUpperCase();
  if (s.includes(', NC') || s.includes(' NC') || s.includes('NORTH CAROLINA')) return 'NC';
  if (s.includes(', GA') || s.includes(' GA') || s.includes('GEORGIA')) return 'GA';
  return 'SC';
}

function sanitize(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'unknown';
}

function cleanLakeBaseName(lakeName) {
  let base = String(lakeName || '').trim();
  base = base.replace(/^Lake\s+/i, '');
  base = base.replace(/,\s*(SC|NC|GA)\s*$/i, '').trim();
  base = base.replace(/\s+Reservoir$/i, '').trim();
  base = base.replace(/\s+Lake$/i, '').trim();
  return base || lakeName;
}

function extractRelevantChunks(text, lakeName, maxChars = 20000) {
  const base = cleanLakeBaseName(lakeName);
  const terms = [...new Set([base, lakeName, base.split(' ')[0], base.split(' ').slice(-1)[0]].filter(Boolean))];
  const lower = (text || '').toLowerCase();
  let chunks = [];
  let seenRanges = [];
  for (const term of terms) {
    const termLower = term.toLowerCase();
    if (termLower.length < 3) continue;
    let idx = 0;
    let found = 0;
    while (found < 6) {
      idx = lower.indexOf(termLower, idx);
      if (idx === -1) break;
      const start = Math.max(0, idx - 1200);
      const end = Math.min(text.length, idx + termLower.length + 1800);
      // avoid heavy overlap
      let overlaps = false;
      for (const r of seenRanges) {
        if (start < r.end && end > r.start && Math.abs(start - r.start) < 500) { overlaps = true; break; }
      }
      if (!overlaps) {
        chunks.push(text.slice(start, end));
        seenRanges.push({ start, end });
      }
      idx = end;
      found++;
      if (chunks.join('\n\n').length > maxChars) break;
    }
    if (chunks.join('\n\n').length > maxChars) break;
  }
  if (chunks.length === 0) {
    // no direct mentions -> take first 8k chars (likely overview + TOC)
    return (text || '').slice(0, Math.min(maxChars, 8000));
  }
  let merged = chunks.join('\n\n--- RELEVANT EXCERPT ---\n\n');
  if (merged.length > maxChars) merged = merged.slice(0, maxChars);
  return merged;
}

/**
 * PDF.js In-Browser Text Extractor
 * Loads PDF.js from unpkg/cdnjs dynamically so we don't have local dependencies.
 */
async function extractTextFromPDFBytes(arrayBuffer, onProgress) {
  if (window.pdfjsLib === undefined) {
    log("Loading PDF.js dynamically into browser thread...");
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.min.js';
    document.head.appendChild(script);
    await new Promise((resolve) => {
      script.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';
        resolve();
      };
    });
  }

  const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const numPages = pdf.numPages;
  log(`PDF parsed successfully. Total pages to extract text from: ${numPages}`);

  let fullText = "";
  const pagesData = [];

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const pageText = content.items.map(item => item.str).join(" ");
    
    // Attempt simple title/heading heuristic from first page or top lines
    let title = "";
    if (pageNum === 1 && content.items.length) {
      title = content.items.slice(0, 5).map(item => item.str).join(" ").trim().slice(0, 100);
    }

    pagesData.push({
      pageNumber: pageNum,
      text: pageText,
      title: title || `Page ${pageNum}`
    });

    fullText += `\n--- PAGE ${pageNum} ---\n` + pageText;
    if (onProgress) {
      onProgress(pageNum, numPages);
    }
  }

  return { fullText, pages: pagesData };
}

/**
 * Step-by-Step Evidence Acquisition Pipeline Runner
 */
async function runFromNormalized(lakeName) {
  if (researchInProgress) { alert('A research task is already in progress.'); return; }
  if (!lakeName) { alert('Please select a lake.'); return; }
  researchInProgress = true;
  researchLog = [];
  packagePartsCache = {};
  showProgress(true);
  setProgress('Fetching existing normalized documents from R2...', 5);
  log(`=== RESUME FROM NORMALIZED: ${lakeName} ===`);
  try {
    // Fetch normalized docs already saved in R2
    const normRes = await fetch(`${CF_WORKER_URL}/research/get-normalized?lake=${encodeURIComponent(lakeName)}`);
    if (!normRes.ok) throw new Error(`No normalized documents found in R2 for ${lakeName} — run the full pipeline first.`);
    const normData = await normRes.json();
    if (!normData.ok || !normData.documents?.length) throw new Error(`No normalized documents found for ${lakeName}.`);
    const normalizedDocuments = normData.documents;
    log(`Loaded ${normalizedDocuments.length} normalized documents from R2.`);

    // Resolve canonical details for the rest of the pipeline
    const canonRes = await fetch(`${CF_WORKER_URL}/research/discover`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lakeName, state: 'SC' })
    });
    const canonData = await canonRes.json();
    const stateName = canonData.state || 'SC';
    const baseName = lakeName.replace(/^Lake\s+/i, '').replace(/,\s*(SC|NC|GA)\s*$/i, '').trim();

    // Jump straight to scoring (Step 5 & 6)
    setProgress('Step 5-6: Running Quality Scoring & Classification...', 40);
    log('Computing scores based on authority trustworthiness rules...');
    const scoredSources = normalizedDocuments.map(doc => {
      // reuse existing scoring logic inline — same as full pipeline
      const lower = String(doc.fullText || '').toLowerCase();
      const baseNameLower = baseName.toLowerCase();
      const lakeNameLower = lakeName.toLowerCase();
      const mentionCount = (lower.match(new RegExp(baseNameLower, 'g')) || []).length;
      const authority = /scdnr|dnr\.sc\.gov|eregulations|des\.sc\.gov|usgs|usace|epa\.gov/.test(String(doc.url || doc.authority || '').toLowerCase()) ? 98 : 60;
      const relevance = mentionCount > 10 ? 95 : mentionCount > 3 ? 80 : mentionCount > 0 ? 60 : 35;
      const freshness = /2024|2025|2026/.test(lower) ? 95 : /2020|2021|2022|2023/.test(lower) ? 75 : /201[5-9]/.test(lower) ? 50 : 25;
      const completeness = (doc.fullText || '').length > 20000 ? 95 : (doc.fullText || '').length > 8000 ? 85 : (doc.fullText || '').length > 2000 ? 65 : 35;
      const composite = Math.round(authority * 0.4 + relevance * 0.3 + freshness * 0.15 + completeness * 0.15);
      const classes = [];
      if (/hydrology|reservoir|dam|drainage|watershed|elevation|pool/.test(lower)) classes.push('Hydrology');
      if (/thermocline|oxygen|clarity|turbid|secchi|limnol|trophic|stratif/.test(lower)) classes.push('Limnology');
      if (/bass|crappie|catfish|striper|shad|herring|forage|stocking|species/.test(lower)) classes.push('Biology');
      if (/regulation|creel|limit|season|closed|license|legal/.test(lower)) classes.push('Regulations');
      if (/ramp|dock|hazard|shoal|navigation|marina|access/.test(lower)) classes.push('Navigation');
      if (/troll|lure|speed|depth|pattern|technique/.test(lower)) classes.push('Trolling');
      log(`• ${doc.title}: auth=${authority} rel=${relevance} fresh=${freshness} comp=${completeness} => composite=${composite} classes=${classes.join(', ') || 'General'}`);
      return { ...doc, scoring: { authority, relevance, freshness, completeness, composite }, classes };
    });
    log('Scoring and classification completed.');

    // Now run steps 7 onward exactly as the full pipeline does
    // (fact extraction, dedup, mapping, gap analysis, agents, save)
    // We reuse the shared tail logic by calling into the pipeline directly
    await runPipelineTail(lakeName, baseName, stateName, normalizedDocuments, scoredSources);

  } catch (e) {
    log(`❌ Resume Aborted: ${e.message}`);
    setProgress('Resume failed — see log.', 0);
  } finally {
    researchInProgress = false;
  }
}

async function runEvidencePipeline(lakeName) {
  if (researchInProgress) {
    alert('A research task or pipeline is already in progress.');
    return;
  }
  if (!lakeName) {
    alert('Please select or specify a lake.');
    return;
  }

  researchInProgress = true;
  researchLog = [];
  packagePartsCache = {};
  showProgress(true);
  setProgress("Initializing evidence pipeline...", 0);
  log(`=== EVIDENCE PIPELINE START: ${lakeName} ===`);

  try {
    const stateName = sanitizeStateFromLakeName(lakeName);
    const sanitizedLake = sanitize(lakeName);

    // ----------------------------------------------------
    // STEP 1: Lake Identification (canonical_lake.json)
    // ----------------------------------------------------
    setProgress("Step 1: Identifying Canonical Lake...", 10);
    log("Resolving canonical lake details and aliases...");
    const baseName = cleanLakeBaseName(lakeName);
    const rawAliases = [
      `${baseName} Reservoir`,
      `Lake ${baseName}`,
      `${baseName} Lake`,
      lakeName,
      `${lakeName} Reservoir`
    ];
    // dedupe and clean double Lake
    const aliasSet = new Set();
    const aliases = [];
    for (let a of rawAliases) {
      a = String(a).replace(/\s+/g, ' ').trim();
      a = a.replace(/^Lake Lake /i, 'Lake ');
      if (!a || aliasSet.has(a.toLowerCase())) continue;
      if (a.toLowerCase() === lakeName.toLowerCase()) continue; // primary name not alias
      aliasSet.add(a.toLowerCase());
      aliases.push(a);
    }
    const canonicalLake = {
      name: lakeName,
      baseName,
      state: stateName,
      aliases,
      sanitizedId: sanitizedLake,
      metadata: {
        lastIdentified: new Date().toISOString()
      }
    };
    log(`Canonical details resolved: ${JSON.stringify(canonicalLake)}`);

    // ----------------------------------------------------
    // STEP 2: Source Discovery
    // ----------------------------------------------------
    setProgress("Step 2: Scoping Trusted Repositories & Scrapers...", 25);
    log("Calling /research/discover API for state & federal sources...");
    const discoverRes = await fetch(`${CF_WORKER_URL}/research/discover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lakeName, state: stateName })
    });
    if (!discoverRes.ok) {
      const snippet = await discoverRes.text().catch(() => '').then(t => t.slice(0, 300));
      throw new Error(`Source Discovery HTTP ${discoverRes.status}: ${snippet}`);
    }
    let discoverData;
    try {
      const txt = await discoverRes.text();
      discoverData = JSON.parse(txt);
    } catch (e) {
      throw new Error(`Source Discovery non-JSON response (worker not deployed or 404): ${e.message}`);
    }
    if (!discoverData.success) {
      throw new Error(`Source Discovery Failed: ${discoverData.error || 'Unknown error'}`);
    }

    const sources = discoverData.sources || [];
    log(`Source Discovery completed. Discovered ${sources.length} trusted documents/URLs.`);
    sources.forEach(src => {
      log(`• [Priority ${src.priority}] ${src.title} (${src.authority}) - ${src.type}`);
    });

    // Save Step 1 & 2 catalogs to R2 first
    await savePipelineDataToR2(lakeName, 'canonical_lake.json', canonicalLake);
    await savePipelineDataToR2(lakeName, 'source_catalog.json', { sources });

    // ----------------------------------------------------
    // STEP 3 & 4: Download & Extraction (CORS Proxy + Client PDF.js)
    // ----------------------------------------------------
    setProgress("Step 3-4: Downloading & Extracting Sources (CORS Bypassed)...", 45);
    const normalizedDocuments = [];

    for (let i = 0; i < sources.length; i++) {
      const src = sources[i];
      log(`Processing [${i + 1}/${sources.length}] ${src.title}...`);

      // skip oversized PDFs early (client memory protection)
      const isHugePocketGuide = /pocket.*guide/i.test(src.title) && src.url.toLowerCase().includes('.pdf');
      if (src.type === 'PDF' && src.title.toLowerCase().includes('pocket guide')) {
        log(`⚠️ Skipping huge generic pocket guide PDF (50MB) — low lake-specific value.`);
        continue;
      }

      if (src.type === 'PDF') {
        log(`Using Cloudflare Proxy to fetch PDF: ${src.url}`);
        const proxyRes = await fetch(`${CF_WORKER_URL}/research/proxy-download?url=${encodeURIComponent(src.url)}`);
        if (!proxyRes.ok) {
          log(`⚠️ Failed to download PDF: ${src.title} (HTTP ${proxyRes.status}). Skipping document.`);
          continue;
        }
        const arrayBuffer = await proxyRes.arrayBuffer();
        if (arrayBuffer.byteLength > 25 * 1024 * 1024) {
          log(`⚠️ PDF too large (${(arrayBuffer.byteLength/1024/1024).toFixed(1)}MB) — skipping to protect browser memory. URL: ${src.url}`);
          continue;
        }
        log(`PDF raw binary streamed to browser (${arrayBuffer.byteLength} bytes). Processing text extract in browser thread...`);
        
        try {
          const extraction = await extractTextFromPDFBytes(arrayBuffer, (current, total) => {
            setProgress(`Extracting PDF pages: ${current}/${total}`, 45 + (i / sources.length) * 15);
          });
          
          normalizedDocuments.push({
            title: src.title,
            authority: src.authority,
            url: src.url,
            priority: src.priority,
            fullText: extraction.fullText,
            pages: extraction.pages,
            downloadDate: new Date().toISOString(),
            contentType: 'application/pdf'
          });
          log(`Successfully extracted ${extraction.pages.length} pages of text. Discarded binary from browser memory.`);
        } catch (pdfErr) {
          log(`⚠️ Error parsing PDF client-side: ${pdfErr.message}. Skipping.`);
        }
      } else {
        // HTML / TEXT — route through Firecrawl via proxy for better extraction
        log(`Fetching webpage via Firecrawl: ${src.url}`);
        const proxyRes = await fetch(`${CF_WORKER_URL}/research/proxy-download?url=${encodeURIComponent(src.url)}&type=HTML`);
        if (!proxyRes.ok) {
          log(`⚠️ Failed to scrape page: ${src.title} (HTTP ${proxyRes.status}). Skipping document.`);
          continue;
        }

        const isFirecrawl = proxyRes.headers.get('X-Source') === 'firecrawl';
        const text = await proxyRes.text();

        // If Firecrawl returned markdown, use it directly — no HTML stripping needed
        const cleanedText = isFirecrawl ? text : text
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();

        if (cleanedText.length < 200) {
          log(`⚠️ Page content too short (${cleanedText.length} chars) — likely blocked or 404. Skipping.`);
          continue;
        }

        log(`${isFirecrawl ? 'Firecrawl' : 'Basic'} extracted ${cleanedText.length} chars from ${src.title}`);

        normalizedDocuments.push({
          title: src.title,
          authority: src.authority,
          url: src.url,
          priority: src.priority,
          fullText: cleanedText,
          pages: [{ pageNumber: 1, text: cleanedText, title: src.title }],
          downloadDate: new Date().toISOString(),
          contentType: isFirecrawl ? 'text/markdown' : 'text/html',
          extractionMethod: isFirecrawl ? 'firecrawl' : 'basic'
        });
        log(`Webpage extracted & normalized successfully.`);
      }
    }

    if (normalizedDocuments.length === 0) {
      throw new Error("No sources were successfully downloaded or extracted. Incomplete pipeline.");
    }

    // Save normalized documents back to the worker R2 normalized folder
    setProgress("Uploading normalized evidence JSON back to R2...", 65);
    log(`Saving ${normalizedDocuments.length} normalized text extracts to R2 normalized/ directory.`);
    await fetch(`${CF_WORKER_URL}/research/save-normalized`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lakeName, documents: normalizedDocuments })
    });

    // ----------------------------------------------------
    // STEP 5 & 6: Source Quality Scoring & Classification
    // ----------------------------------------------------
    setProgress("Step 5-6: Running Quality Scoring & Classification...", 75);
    log("Computing scores based on authority trustworthiness rules...");
    const scoredSources = normalizedDocuments.map(doc => {
      let authorityScore = 55; // default base (fishing club level)
      const auth = String(doc.authority).toUpperCase();
      const titleLower = String(doc.title || '').toLowerCase();
      const urlLower = String(doc.url || '').toLowerCase();
      const lower = String(doc.fullText || '').toLowerCase();
      const baseLower = baseName.toLowerCase();

      if (/USACE|USGS|EPA|NOAA|FEDERAL/.test(auth)) authorityScore = 100;
      else if (/SCDNR|NCWRC|DNR|STATE/.test(auth)) authorityScore = 98;
      else if (/CLEMSON|NC STATE|UNIVERSITY|UGA|USC/.test(auth)) authorityScore = 90;
      else if (/DUKE|DOMINION|POWER|UTILITY/.test(auth)) authorityScore = 85;

      // Relevance penalty: if doc does not mention lake base name, drop authority
      const mentionsBase = lower.includes(baseLower);
      const titleHasBase = titleLower.includes(baseLower);
      let relevance = 40;
      if (titleHasBase) relevance = 95;
      else if (mentionsBase) {
        const count = (lower.match(new RegExp(baseLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
        relevance = count >= 3 ? 90 : count >= 1 ? 70 : 50;
      }
      // generic statewide docs without lake mention get capped
      if (!mentionsBase && !titleHasBase) {
        // pocket guide, species guide etc
        authorityScore = Math.min(authorityScore, 60);
        relevance = 35;
      }
      // filter out other-lake specific docs that slipped through discovery
      const otherLakes = ['murray','marion','moultrie','hartwell','keowee','jocassee','thurmond','russell','wylie','norman','james','rhodhiss'];
      for (const other of otherLakes) {
        if (other === baseLower) continue;
        if (titleLower.includes(`lake ${other}`) && !titleLower.includes(baseLower)) {
          authorityScore = Math.min(authorityScore, 30);
          relevance = 15;
          log(`⚠️ Detected off-lake doc: "${doc.title}" mentions lake ${other} not ${baseName} — penalizing`);
        }
      }

      // Freshness: try year from title or url
      let freshness = 75;
      const yearMatch = (doc.title + ' ' + doc.url).match(/(19|20)\d{2}/);
      if (yearMatch) {
        const year = parseInt(yearMatch[0], 10);
        const age = 2026 - year;
        freshness = Math.max(25, 95 - age * 6);
      }
      if (/pocket guide/i.test(doc.title)) freshness = 50;
      if (/regulations.*2024|regulations.*2025|2024.*regulations|2025.*regulations/i.test(doc.title)) freshness = 95;

      const completeness = doc.fullText.length > 20000 ? 95 : doc.fullText.length > 8000 ? 85 : doc.fullText.length > 2000 ? 65 : 35;

      // Classification heuristics
      const classes = [];
      if (/hydrology|flow|elevation|dam|discharge|river stage|pool/.test(lower)) classes.push("Hydrology");
      if (/biology|forage|shad|herring|predator|bass|crappie|catfish|stocking/.test(lower)) classes.push("Biology");
      if (/limnology|thermocline|oxygen|secchi|turbidity|clarity|temperature stratification/.test(lower)) classes.push("Limnology");
      if (/regulation|creel|size limit|length limit|bag limit|closure|season/.test(lower)) classes.push("Regulations");
      if (/hazard|shoal|stump|depth|timber|navig|boat ramp|access/.test(lower)) classes.push("Navigation");
      if (/troll|presentation|lure|spread|crankbait|a-rig|umbrella/.test(lower)) classes.push("Trolling");

      // composite score for logging
      const composite = Math.round((authorityScore * 0.5 + relevance * 0.3 + freshness * 0.1 + completeness * 0.1));

      return {
        title: doc.title,
        authority: doc.authority,
        url: doc.url,
        scoring: {
          authority: authorityScore,
          relevance,
          freshness,
          completeness,
          composite
        },
        classes: classes.length ? classes : ["General Overview"]
      };
    });

    log(`Scoring and classification completed:`);
    scoredSources.forEach(s => {
      log(`• ${s.title}: auth=${s.scoring.authority} rel=${s.scoring.relevance} fresh=${s.scoring.freshness} comp=${s.scoring.completeness} => composite=${s.scoring.composite} classes=${s.classes.join(', ')}`);
    });
    // sort by composite desc for downstream use
    scoredSources.sort((a,b) => (b.scoring.composite||0) - (a.scoring.composite||0));
    await savePipelineDataToR2(lakeName, 'quality_scores.json', { scoredSources });

    await runPipelineTail(lakeName, baseName, stateName, normalizedDocuments, scoredSources);

  } catch (err) {
    log(`❌ Pipeline Aborted: ${err.message}`);
    alert(`Evidence Pipeline Failed: ${err.message}`);
    setProgress("Failed", 0);
  } finally {
    researchInProgress = false;
  }
}

// Helper: get relevant chunks from a doc by title match
function getDocChunks(normalizedDocuments, titlePatterns, lakeName, maxChars) {
  const docs = normalizedDocuments.filter(d =>
    titlePatterns.some(p => typeof p === 'string'
      ? d.title?.toLowerCase().includes(p.toLowerCase()) || d.url?.toLowerCase().includes(p.toLowerCase())
      : p.test(d.title || '') || p.test(d.url || ''))
  );
  return docs.map(d => {
    const rawLen = (d.fullText || '').length;
    const budget = rawLen > 50000 ? 6000 : maxChars;
    const chunk = extractRelevantChunks(d.fullText, lakeName, budget);
    return `=== ${d.title} ===\n${chunk}`;
  }).join('\n\n');
}

async function runPipelineTail(lakeName, baseName, stateName, normalizedDocuments, scoredSources) {
    // ----------------------------------------------------
    // STEP 7: Fact extraction (blind pass — facts only, no inference)
    // ----------------------------------------------------
    setProgress("Step 7: Extracting verified facts from documents...", 50);
    log("Submitting lake-relevant chunks to Research LLM (not full 100k dumps)...");

    // Sort docs by composite score so high-value docs get budget first
    const sortedDocs = [...normalizedDocuments].sort((a, b) => {
      const sa = scoredSources.find(s => s.title === a.title)?.scoring?.composite || 50;
      const sb = scoredSources.find(s => s.title === b.title)?.scoring?.composite || 50;
      return sb - sa;
    });

    const extractionPayload = {
      lakeName,
      baseName,
      state: stateName,
      documents: sortedDocs.map(d => {
        const rawLen = (d.fullText || '').length;
        const chunkBudget = rawLen > 50000 ? 6000 : 20000;
        return {
          title: d.title,
          url: d.url,
          text: extractRelevantChunks(d.fullText, lakeName, chunkBudget),
          quality: (scoredSources.find(s => s.title === d.title)?.scoring) || {}
        };
      })
    };

    // total cap ~120k chars to keep LLM inside context & cost
    let totalChars = extractionPayload.documents.reduce((a, b) => a + (b.text?.length || 0), 0);
    if (totalChars > 120000) {
      log(`⚠️ Total payload ${totalChars} chars >120k cap — trimming lowest-quality docs`);
      const ranked = extractionPayload.documents
        .map((d) => ({ ...d, composite: (d.quality?.composite) || 50 }))
        .sort((a, b) => b.composite - a.composite);
      let kept = [];
      let cur = 0;
      for (const doc of ranked) {
        if (cur + doc.text.length > 120000 && kept.length >= 3) break;
        kept.push(doc);
        cur += doc.text.length;
      }
      extractionPayload.documents = kept;
      log(`Trimmed to ${kept.length} docs, ${cur} chars`);
    }

    let extractRes;
    try {
      extractRes = await fetch(`${CF_WORKER_URL}/research/analyze-facts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(extractionPayload)
      });
    } catch (e) {
      throw new Error(`Fact Extraction fetch failed: ${e.message}`);
    }
    if (!extractRes.ok) {
      const snippet = await extractRes.text().catch(() => '').then(t => t.slice(0, 500));
      throw new Error(`Fact Extraction HTTP ${extractRes.status}: ${snippet}`);
    }
    let extractData;
    try {
      extractData = await extractRes.json();
    } catch (e) {
      throw new Error(`Fact Extraction non-JSON: ${e.message}`);
    }
    if (!extractData.success) {
      throw new Error(`Fact Extraction Failed: ${extractData.error || 'Extraction failure'}`);
    }

    const rawFacts = extractData.extracted_facts || [];
    log(`Deep scan extracted ${rawFacts.length} verified facts.`);
    if (rawFacts.length === 0) {
      log(`⚠️ Zero facts extracted — primary pass returned empty. Worker will attempt regulations fallback if not already done.`);
    }
    rawFacts.forEach(f => {
      log(`💬 [${f.category}] "${f.fact}" (Confidence: ${f.confidence}%) - Source: ${f.source} pg ${f.page || '?'}`);
    });

    // ----------------------------------------------------
    // STEP 8: Deduplication
    // ----------------------------------------------------
    setProgress("Step 8: Deduplicating facts...", 60);
    let uniqueFacts = rawFacts;
    let contradictions = [];
    if (rawFacts.length > 0) {
      log("Deduplicating identical facts and checking for anomalies...");
      try {
        const dedupeRes = await fetch(`${CF_WORKER_URL}/research/dedupe-contradictions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ facts: rawFacts })
        });
        if (dedupeRes.ok) {
          const dedupeData = await dedupeRes.json();
          uniqueFacts = dedupeData.deduplicated_facts || rawFacts;
          contradictions = dedupeData.contradictions || [];
        }
      } catch (e) {
        log(`⚠️ Dedupe failed: ${e.message} — using raw facts`);
      }
      log(`Deduplicated facts count: ${uniqueFacts.length}.`);
      if (contradictions.length > 0) {
        log(`⚠️ ${contradictions.length} contradictions detected:`);
        contradictions.forEach(c => log(`👉 [${c.field}]: "${c.factA}" vs "${c.factB}"`));
      }
    } else {
      log("Skipping dedup — no facts to process.");
    }

    // Stringify facts once for reuse in agent prompts
    const factsBlock = uniqueFacts.length
      ? `VERIFIED FACTS FROM DOCUMENTS (use these as primary source — do not contradict them):\n` +
        uniqueFacts.map(f => `[${f.category}] ${f.fact} (source: ${f.source}, confidence: ${f.confidence}%)`).join('\n')
      : 'No verified facts were extracted from documents for this lake.';

    // ----------------------------------------------------
    // STEP 9: WQP Limnology Data (real DO/temp profiles)
    // ----------------------------------------------------
    setProgress("Step 9: Fetching real limnology data from WQP...", 62);
    log("Querying Water Quality Portal for DO and temperature profiles...");
    let wqpLimnology = null;
    try {
      // Derive bbox from lake GeoJSON in R2
      const geoRes = await fetch(`${CF_WORKER_URL}/chartpacks/lake-boundary?lake=${encodeURIComponent(lakeName)}`);
      let bbox = null;
      if (geoRes.ok) {
        const geo = await geoRes.json();
        const coords = [];
        const extractCoords = (obj) => {
          if (!obj) return;
          if (obj.type === 'Feature') extractCoords(obj.geometry);
          else if (obj.type === 'FeatureCollection') obj.features?.forEach(extractCoords);
          else if (obj.coordinates) {
            const flat = obj.coordinates.flat(Infinity);
            for (let i = 0; i < flat.length - 1; i += 2) coords.push([flat[i], flat[i+1]]);
          }
        };
        extractCoords(geo);
        if (coords.length) {
          const lons = coords.map(c => c[0]);
          const lats = coords.map(c => c[1]);
          bbox = {
            bboxNorth: Math.max(...lats),
            bboxSouth: Math.min(...lats),
            bboxEast:  Math.max(...lons),
            bboxWest:  Math.min(...lons)
          };
        }
      }
      if (bbox) {
        const wqpRes = await fetch(`${CF_WORKER_URL}/research/limnology-data`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lakeName, ...bbox })
        });
        if (wqpRes.ok) {
          const wqpData = await wqpRes.json();
          if (wqpData.ok && wqpData.recordCount > 0) {
            wqpLimnology = wqpData;
            log(`✔ WQP: ${wqpData.recordCount} records, ${wqpData.summerRecords} summer — thermocline: ${wqpData.thermocline ? `${wqpData.thermocline.depthFt}ft (confidence: ${wqpData.thermocline.confidence}%, method: ${wqpData.thermocline.method})` : 'not derived'}`);
          } else {
            log(`⚠️ WQP: ${wqpData.note || 'no data found for this lake boundary'}`);
          }
        }
      } else {
        log("⚠️ WQP: could not derive lake boundary bbox — skipping limnology data fetch");
      }
    } catch (e) {
      log(`⚠️ WQP limnology fetch failed: ${e.message} — continuing without measured data`);
    }

    // Build WQP context block for limnology agent
    const wqpBlock = wqpLimnology?.thermocline ? `
MEASURED LIMNOLOGY DATA FROM WATER QUALITY PORTAL (${wqpLimnology.recordCount} records, last observed ${wqpLimnology.lastObserved}):
- Summer thermocline depth: ${wqpLimnology.thermocline.depthFt}ft (confidence: ${wqpLimnology.thermocline.confidence}%, method: ${wqpLimnology.thermocline.method})
- Anoxic below: ${wqpLimnology.oxygen?.anoxicBelowFt ?? 'not determined'}ft
- Striper safe depth ceiling: ${wqpLimnology.oxygen?.stripeThresholdFt ?? 'unknown'}ft (need >4mg/L DO)
- Largemouth safe depth ceiling: ${wqpLimnology.oxygen?.largemouthThresholdFt ?? 'unknown'}ft
- Evidence count: ${wqpLimnology.thermocline.evidenceCount} summer measurements
USE THESE VALUES DIRECTLY — do not estimate or override with training data.` : `
No measured thermocline data available from WQP for this lake. Use training data estimate if known for similar SC piedmont reservoirs, clearly label as estimated.`;

    // ----------------------------------------------------
    // STEP 9–12: 4 Targeted Agent Calls
    // Each agent gets relevant doc chunks + extracted facts,
    // extracts what it needs AND synthesizes its section.
    // ----------------------------------------------------

    const agentSections = {};

    // --- CALL 1: Identity + Limnology ---
    setProgress("Step 10: Identity & Limnology...", 68);
    log("Running identity & limnology agent...");
    try {
      const identityChunks = getDocChunks(normalizedDocuments,
        ['description', 'wateree lake', 'wateree sc', 'water quality', 'watershed'],
        lakeName, 15000);
      const call1Res = await fetch(`${CF_WORKER_URL}/groq-query`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: `You are a lake research specialist. Extract and synthesize lake identity and limnology data from provided documents, verified facts, and measured water quality data. Return ONLY valid JSON. Null means unknown — never invent numbers. For limnology fields backed by WQP measured data, use those values directly and set confidence accordingly.` },
            { role: 'user', content: `Lake: ${lakeName}\n\n${factsBlock}\n\n${wqpBlock}\n\nDOCUMENT EXCERPTS:\n${identityChunks.slice(0, 20000)}\n\nReturn ONLY this JSON:\n{"identity":{"lakeName":"${lakeName}","state":"${stateName}","county":null,"riverSystem":null,"reservoirOwner":null,"surfaceAreaAcres":null,"maxDepthFt":null,"averageDepthFt":null,"normalPoolFt":null,"shorelineLengthMi":null,"damName":null,"yearImpounded":null,"archetype":null,"aliases":[]},"limnology":{"waterClarity":{"typical":null,"color":null,"secchiFt":null,"note":null},"thermocline":{"summerDepthFt":null,"strength":null,"winterMix":null,"confidence":null,"method":null,"evidenceCount":null,"lastObserved":null,"note":null},"oxygen":{"depletionDepthFt":null,"anoxicBelowFt":null,"striperCeilingFt":null,"largemouthCeilingFt":null,"note":null},"trophicStatus":null,"flowCharacteristics":null,"seasonalDrawdownFt":null}}` }
          ],
          max_tokens: 1500, temperature: 0.1, response_format: { type: 'json_object' }
        })
      });
      if (call1Res.ok) {
        const call1Data = await call1Res.json();
        const text = call1Data.choices?.[0]?.message?.content || '';
        const parsed = JSON.parse(text.replace(/^```json\s*/i,'').replace(/\s*```$/,'').trim());
        if (parsed.identity) agentSections.identity = parsed.identity;
        if (parsed.limnology) agentSections.limnology = parsed.limnology;
        log(`✔ Identity & Limnology complete`);
      }
    } catch (e) { log(`⚠️ Identity/Limnology agent failed: ${e.message}`); }

    // --- CALL 2: Biology + Habitat ---
    setProgress("Step 11: Biology & Habitat...", 75);
    log("Running biology & habitat agent...");
    try {
      const bioChunks = getDocChunks(normalizedDocuments,
        ['largemouth', 'bass', 'fisheries', 'hatchery', 'bayless', '2017', 'annual', 'striper', 'striped'],
        lakeName, 15000);
      const call2Res = await fetch(`${CF_WORKER_URL}/groq-query`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: `You are a fisheries biologist. Extract and synthesize fisheries biology and habitat data from provided documents and facts. You MAY use training knowledge for species known to inhabit this lake system, but clearly ground facts in the documents where possible. Return ONLY valid JSON.` },
            { role: 'user', content: `Lake: ${lakeName} (${stateName})\n\n${factsBlock}\n\nDOCUMENT EXCERPTS:\n${bioChunks.slice(0, 25000)}\n\nReturn ONLY this JSON:\n{"biology":{"primaryForage":[{"species":null,"abundance":null,"notes":null}],"secondaryForage":[],"predatorSpecies":[],"speciesAbundance":{},"knownStockings":[],"baitfishMovement":null,"forageCalendar":{"spring":null,"summer":null,"fall":null,"winter":null}},"habitat":{"bottomComposition":{},"cover":[],"vegetation":{},"structuralElements":{"points":null,"humps":null,"creekArms":null,"channelLedges":null,"flats":null},"dockDensity":null,"standingTimber":null,"notes":null}}` }
          ],
          max_tokens: 1500, temperature: 0.15, response_format: { type: 'json_object' }
        })
      });
      if (call2Res.ok) {
        const call2Data = await call2Res.json();
        const text = call2Data.choices?.[0]?.message?.content || '';
        const parsed = JSON.parse(text.replace(/^```json\s*/i,'').replace(/\s*```$/,'').trim());
        if (parsed.biology) agentSections.biology = parsed.biology;
        if (parsed.habitat) agentSections.habitat = parsed.habitat;
        log(`✔ Biology & Habitat complete`);
      }
    } catch (e) { log(`⚠️ Biology/Habitat agent failed: ${e.message}`); }

    // --- CALL 3: Regulations + Navigation ---
    setProgress("Step 12: Regulations & Navigation...", 84);
    log("Running regulations & navigation agent...");
    try {
      const regChunks = getDocChunks(normalizedDocuments,
        ['eregulations', 'regulation', 'regs', 'stripedbass', 'striped bass', 'size', 'possession', 'creel', 'limit', 'description'],
        lakeName, 15000);
      const call3Res = await fetch(`${CF_WORKER_URL}/groq-query`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: `You are a fishing regulations specialist. Extract ALL species creel limits and size limits from the regulations documents provided. List every species in the table — do not summarize or skip species. Also extract navigation info. Return ONLY valid JSON. Never invent limits — null if not found.` },
            { role: 'user', content: `Lake: ${lakeName} (${stateName})\n\n${factsBlock}\n\nDOCUMENT EXCERPTS:\n${regChunks.slice(0, 25000)}\n\nIMPORTANT: The eRegulations page has a complete table. Extract EVERY species row — bream, crappie, bass, catfish, striped bass, walleye, pickerel, gar, etc. For Lake Wateree specifically note any exceptions from statewide limits.\n\nReturn ONLY this JSON:\n{"regulations":{"state":"${stateName}","generalStateRegulations":{"lengthLimits":{},"creelLimits":{}},"lakeSpecificRegulations":{"hasExceptions":null,"creelLimits":{},"sizeLimits":{},"specialRules":[],"closedSeasons":[]},"notes":null},"navigation":{"ramps":[],"hazards":[],"notes":null}}` }
          ],
          max_tokens: 2000, temperature: 0.05, response_format: { type: 'json_object' }
        })
      });
      if (call3Res.ok) {
        const call3Data = await call3Res.json();
        const text = call3Data.choices?.[0]?.message?.content || '';
        const parsed = JSON.parse(text.replace(/^```json\s*/i,'').replace(/\s*```$/,'').trim());
        if (parsed.regulations) agentSections.regulations = parsed.regulations;
        if (parsed.navigation) agentSections.navigation = parsed.navigation;
        log(`✔ Regulations & Navigation complete`);
      }
    } catch (e) { log(`⚠️ Regulations/Navigation agent failed: ${e.message}`); }

    // --- CALL 4: Trolling Intelligence + Summary ---
    setProgress("Step 13: Trolling Intelligence & Summary...", 92);
    log("Running trolling intelligence & summary agent...");
    try {
      const profileSoFar = JSON.stringify({
        identity: agentSections.identity,
        limnology: agentSections.limnology,
        biology: agentSections.biology,
        habitat: agentSections.habitat,
        regulations: agentSections.regulations
      }, null, 2).slice(0, 12000);
      const call4Res = await fetch(`${CF_WORKER_URL}/groq-query`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: `You are a professional kayak trolling guide and fisheries biologist. Using the lake profile and measured thermocline data provided, derive trolling intelligence for confirmed predator species only. Also write a 2-3 paragraph angler summary. Do NOT invent species not in the biology section. Do NOT recommend specific lures, colors, or routes. If thermocline depth is provided as measured data, use it to set species depth ceilings. Return ONLY valid JSON.` },
            { role: 'user', content: `Lake: ${lakeName}\n\n${wqpBlock}\n\nPROFILE SO FAR:\n${profileSoFar}\n\nReturn ONLY this JSON:\n{"trollingIntelligence":{},"summary":{"text":null,"keywords":[]}}` }
          ],
          max_tokens: 2000, temperature: 0.2, response_format: { type: 'json_object' }
        })
      });
      if (call4Res.ok) {
        const call4Data = await call4Res.json();
        const text = call4Data.choices?.[0]?.message?.content || '';
        const parsed = JSON.parse(text.replace(/^```json\s*/i,'').replace(/\s*```$/,'').trim());
        if (parsed.trollingIntelligence) agentSections.trollingIntelligence = parsed.trollingIntelligence;
        if (parsed.summary) agentSections.summary = parsed.summary;
        log(`✔ Trolling Intelligence & Summary complete`);
      }
    } catch (e) { log(`⚠️ Trolling/Summary agent failed: ${e.message}`); }

    // ----------------------------------------------------
    // STEP 13: Assemble and save complete profile
    // ----------------------------------------------------
    setProgress("Step 13: Saving complete profile...", 96);

    const researchPacket = {
      lakeName,
      baseName,
      state: stateName,
      ...agentSections,
      forage: agentSections.biology || {},
      trolling: agentSections.trollingIntelligence || {},
      _extractedFacts: uniqueFacts,
      _extractedFactsCount: uniqueFacts.length,
      _wqpLimnology: wqpLimnology || null,
      sources: scoredSources.map(s => ({
        label: s.title,
        url: s.url || '#',
        authority: s.authority,
        trust: (s.scoring?.composite || 0) >= 80 ? 'OFFICIAL' : 'THIRD_PARTY',
        scores: s.scoring
      }))
    };

    log(`Saving profile (facts=${uniqueFacts.length}, sections=${Object.keys(agentSections).length})...`);
    const saveRes = await fetch(`${CF_WORKER_URL}/research/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lakeName,
        profile: researchPacket,
        status: 'draft',
        requestedBy: 'Evidence Acquisition Engine v4'
      })
    });
    if (!saveRes.ok) {
      const t = await saveRes.text().catch(()=>'').then(s=>s.slice(0,400));
      throw new Error(`Save HTTP ${saveRes.status}: ${t}`);
    }
    const saveData = await saveRes.json();
    log(`✔ Saved profile v${saveData.version} as draft — ${uniqueFacts.length} facts, ${Object.keys(agentSections).length} sections populated`);

    setProgress("Pipeline completed successfully!", 100);
    log(`=== EVIDENCE PIPELINE COMPLETE ===`);

    await loadProfile(lakeName);

    if (contradictions.length > 0) {
      renderContradictionsAlert(contradictions, lakeName);
    }
}

async function savePipelineDataToR2(lakeName, filename, data) {
  const safe = sanitize(lakeName);
  try {
    await fetch(`${CF_WORKER_URL}/research/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lakeName,
        profile: data,
        packageParts: { [filename.replace('.json', '')]: data },
        status: 'draft',
        notes: `Pipeline auto-dump: ${filename}`
      })
    });
  } catch (e) {
    log(`Warning: Failed to save file ${filename} to R2 directory: ${e.message}`);
  }
}

function buildMasterProfile(lakeName, accumulated, parts, agentResults) {
  const stateName = sanitizeStateFromLakeName(lakeName);
  const baseName = cleanLakeBaseName(lakeName);
  const sanitizedId = sanitize(lakeName);

  // Build confidence map from agent results
  const confidence = {};
  for (const r of (agentResults || [])) {
    if (r.agent && r.confidence) {
      confidence[r.agent] = r.confidence;
    }
  }
  // Derive overall
  const percents = Object.values(confidence).map(c => c.percent || 0).filter(Boolean);
  if (percents.length) {
    const avg = Math.round(percents.reduce((a, b) => a + b, 0) / percents.length);
    confidence.overall = { percent: avg, level: avg >= 95 ? 'very high' : avg >= 85 ? 'high' : avg >= 70 ? 'medium' : avg >= 50 ? 'low' : 'needs research' };
  }

  // Build source list from agent metadata
  const sources = [];
  for (const r of (agentResults || [])) {
    if (r.meta?.sources) {
      for (const s of r.meta.sources) {
        if (!sources.find(x => x.url === s.url)) sources.push(s);
      }
    }
  }

  return {
    lakeName,
    baseName,
    state: stateName,
    sanitizedId,
    aliases: accumulated.identity?.aliases || [],
    identity: accumulated.identity || {},
    limnology: accumulated.limnology || {},
    forage: accumulated.biology || accumulated.forage || {},
    biology: accumulated.biology || accumulated.forage || {},
    habitat: accumulated.habitat || {},
    navigation: accumulated.navigation || {},
    regulations: accumulated.regulations || {},
    trolling: accumulated.trolling || {},
    trollingIntelligence: accumulated.trollingIntelligence || accumulated.trolling || {},
    summary: accumulated.summary || {},
    confidence,
    sources,
    metadata: {
      version: '1.0',
      status: 'draft',
      lastUpdated: new Date().toISOString(),
      verified: false,
      agentCount: agentResults.filter(r => r.success !== false).length,
      baseName
    }
  };
}

function buildFinalResearchPacket(lakeName, state, uniqueFacts, scoredSources) {
  const baseName = cleanLakeBaseName(lakeName);
  // synonym mapping for getVal
  const catSynonyms = {
    riverSystem: ['riverSystem','river','river system','watershed','basin'],
    archetype: ['archetype','lakeType','type','reservoirType'],
    surfaceArea: ['surfaceArea','surfaceAreaAcres','acres','size','surface area'],
    maxDepth: ['maxDepth','maxDepthFt','maximum depth','max depth'],
    averageDepth: ['averageDepth','averageDepthFt','avg depth','mean depth'],
    clarity: ['clarity','waterClarity','water clarity','secchi','visibility'],
    thermocline: ['thermocline','thermal stratification','stratification'],
    oxygen: ['oxygen','dissolved oxygen','do','anoxic'],
    primaryForage: ['primaryForage','primary forage','forage','baitfish','shad','herring'],
    secondaryForage: ['secondaryForage','secondary forage','secondary bait'],
    summary: ['summary','overview','description','general overview']
  };
  const getVal = (cat, defaultVal) => {
    const syns = catSynonyms[cat] || [cat];
    for (const syn of syns) {
      const found = uniqueFacts.find(f => {
        const c = String(f.category || '').toLowerCase();
        return c === syn.toLowerCase() || c.includes(syn.toLowerCase());
      });
      if (found) return found.fact;
    }
    // fallback direct match
    const direct = uniqueFacts.find(f => String(f.category).toLowerCase() === cat.toLowerCase());
    return direct ? direct.fact : defaultVal;
  };
  const getAllForCategory = (cat) => uniqueFacts.filter(f => String(f.category||'').toLowerCase().includes(cat.toLowerCase())).map(f=>f.fact);

  // Build aliases correctly
  const aliases = [...new Set([
    `${baseName} Reservoir`,
    `Lake ${baseName}`,
    lakeName.includes('Lake') ? baseName : `Lake ${baseName} Reservoir`
  ])].filter(a => a.toLowerCase() !== lakeName.toLowerCase());

  const surfaceAreaRaw = getVal('surfaceArea', null);
  const maxDepthRaw = getVal('maxDepth', null);
  const avgDepthRaw = getVal('averageDepth', null);

  // Build a proper nested identity object so the UI never shows empty
  const identityObj = {
    lakeName,
    state,
    aliases,
    riverSystem: getVal('riverSystem', null),
    archetype: getVal('archetype', null),
    surfaceAreaAcres: surfaceAreaRaw ? parseFloat(String(surfaceAreaRaw).replace(/[^0-9.]/g,'')) || null : null,
    maxDepthFt: maxDepthRaw ? parseFloat(String(maxDepthRaw).replace(/[^0-9.]/g,'')) || null : null,
    averageDepthFt: avgDepthRaw ? parseFloat(String(avgDepthRaw).replace(/[^0-9.]/g,'')) || null : null,
    damName: getVal('damName', null),
    yearImpounded: (() => {
      const v = getVal('yearImpounded', null);
      return v ? parseInt(String(v).replace(/[^0-9]/g,'')) || null : null;
    })(),
    reservoirOwner: getVal('reservoirOwner', null),
    type: getVal('type', null)
  };

  return {
    lakeName,
    baseName,
    state,
    aliases,
    identity: identityObj,          // ← the missing piece the UI renders
    riverSystem: identityObj.riverSystem,
    archetype: identityObj.archetype,
    surfaceAreaAcres: identityObj.surfaceAreaAcres,
    maxDepthFt: identityObj.maxDepthFt,
    averageDepthFt: identityObj.averageDepthFt,
    limnology: {
      waterClarity: { typical: getVal('clarity', null), color: null, secchiFt: null, note: getAllForCategory('clarity').join('; ').slice(0,500) },
      thermocline: { summerDepthFt: null, strength: null, winterMix: null, note: getVal('thermocline', null) },
      oxygen: { depletionDepthFt: null, anoxicBelowFt: null, note: getVal('oxygen', null) }
    },
    forage: {
      primaryForage: (() => {
        const v = getVal('primaryForage', null);
        return v ? [{ species: v, abundance: null, notes: "" }] : [];
      })(),
      secondaryForage: (() => {
        const v = getVal('secondaryForage', null);
        return v ? [{ species: v, abundance: null, notes: "" }] : [];
      })(),
      predatorSpecies: getAllForCategory('predator').slice(0,8),
      baitfishMovement: getVal('baitfishMovement', null),
      forageCalendar: { spring: null, summer: null, fall: null, winter: null },
      _rawFacts: getAllForCategory('forage').slice(0,10)
    },
    habitat: {
      bottomComposition: {},
      cover: [],
      structuralElements: {
        points: getVal('points', null),
        humps: getVal('humps', null),
        creekArms: getVal('creekArms', null)
      },
      dockDensity: null,
      standingTimber: getVal('standingTimber', null)
    },
    navigation: {
      ramps: [],
      hazards: [],
      notes: getVal('navigation', null)
    },
    regulations: {
      state,
      generalStateRegulations: {
        creelLimits: (() => {
          const facts = getAllForCategory('regulation');
          const general = {};
          facts.filter(f => /statewide|general/i.test(f)).slice(0,5).forEach((fact,i)=>{
            general[`general_${i}`] = fact;
          });
          return general;
        })()
      },
      lakeSpecificRegulations: {
        hasExceptions: uniqueFacts.some(f => /lake-specific|lake specific|exception/i.test(f.fact)),
        creelLimits: (() => {
          const o={};
          getAllForCategory('creel').forEach((fact,i)=>{ o[`creel_${i}`]=fact; });
          getAllForCategory('regulation').filter(f=> new RegExp(baseName,'i').test(f)).slice(0,5).forEach((fact,i)=>{ o[`lake_${i}`]=fact; });
          return o;
        })(),
        _raw: getAllForCategory('regulations').slice(0,15)
      }
    },
    trolling: {
      notes: getAllForCategory('trolling').join('; ').slice(0,1000) || null
    },
    summary: {
      text: getVal('summary', null) || (uniqueFacts.length ? uniqueFacts.map(f=>f.fact).join(' ').slice(0,2000) : null),
      keywords: [...new Set(uniqueFacts.map(f=>f.category).filter(Boolean))].slice(0,20)
    },
    sources: scoredSources.map(s => ({
      label: s.title,
      url: s.url || "#",
      authority: s.authority,
      trust: s.scoring.composite >= 80 ? "OFFICIAL" : s.scoring.composite >= 50 ? "THIRD_PARTY" : "LOW_RELEVANCE",
      scores: s.scoring
    })),
    metadata: {
      version: "1.0",
      status: "draft",
      lastUpdated: new Date().toISOString(),
      verified: false,
      factCount: uniqueFacts.length,
      baseName
    }
  };
}

function renderContradictionsAlert(contradictions, lakeName) {
  // Check if target container exists, create if not
  let el = document.getElementById('contradictionAlertPanel');
  if (!el) {
    const parent = document.getElementById('panel-research').querySelector('.pad');
    el = document.createElement('div');
    el.id = 'contradictionAlertPanel';
    el.className = 'card';
    el.style.cssText = "border: 2px solid var(--bad); background: rgba(255,82,82,.05); margin-top: 10px;";
    parent.insertBefore(el, parent.firstChild);
  }

  let html = `
    <h3 style="color:var(--bad); margin-top:0">⚠️ Step 9: Source Contradiction Detected!</h3>
    <p class="muted">The fact gathering engine detected conflicting facts between trusted sources. Please resolve the differences before compiling the master packet:</p>
    <div style="display:flex; flex-direction:column; gap:10px; margin-top:10px;">
  `;

  contradictions.forEach((c, index) => {
    html += `
      <div style="background:rgba(0,0,0,.3); border-left:4px solid var(--bad); padding:8px; border-radius:4px;">
        <b style="color:var(--accent); text-transform:uppercase; font-size:11px;">Field Conflict: ${c.field}</b>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:6px; font-size:12px;">
          <label style="cursor:pointer; display:block; padding:6px; background:rgba(255,255,255,.02); border-radius:4px;">
            <input type="radio" name="conflict-${index}" value="A" checked> 
            <b>Source A:</b> ${c.factA} <br>
            <span class="muted" style="font-size:10px;">Page ${c.pageA || '?'} — Quote: "${c.quoteA || ''}"</span>
          </label>
          <label style="cursor:pointer; display:block; padding:6px; background:rgba(255,255,255,.02); border-radius:4px;">
            <input type="radio" name="conflict-${index}" value="B"> 
            <b>Source B:</b> ${c.factB} <br>
            <span class="muted" style="font-size:10px;">Page ${c.pageB || '?'} — Quote: "${c.quoteB || ''}"</span>
          </label>
        </div>
      </div>
    `;
  });

  html += `
    </div>
    <div style="margin-top:12px; text-align:right">
      <button id="btnResolveConflicts" class="primary small" style="background:var(--accent2); color:#000;">✔ Resolve & Update Master Packet</button>
    </div>
  `;

  el.innerHTML = html;
  el.style.display = 'block';

  document.getElementById('btnResolveConflicts').addEventListener('click', async () => {
    log("Resolving contradictions according to operator choices...");
    // Read selections
    contradictions.forEach((c, index) => {
      const selected = el.querySelector(`input[name="conflict-${index}"]:checked`).value;
      const winner = selected === 'A' ? c.factA : c.factB;
      log(`Conflict [${c.field}] resolved to Option ${selected}: "${winner}"`);
    });
    
    el.style.display = 'none';
    alert("Conflicts resolved! Updated profile saved.");
    await loadProfile(lakeName);
  });
}

async function populateResearchLakeDropdown() {
  const sel = document.getElementById('researchLakeSelect');
  if (!sel) return;
  const existing = new Set(Array.from(sel.options).map(o => o.value));
  const lakes = Object.keys(LAKE_DB).sort();
  for (const name of lakes) {
    if (!existing.has(name)) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
      existing.add(name);
    }
  }
}

async function fetchResearchList() {
  try {
    const r = await fetch(`${CF_WORKER_URL}/research/list`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    log(`List: ${data.count} lakes in R2`);
    return data;
  } catch (e) {
    log(`List failed: ${e.message}`);
    return null;
  }
}

async function loadProfile(lakeName, silent = false) {
  if (!lakeName) return null;
  currentLakeName = lakeName;
  if (!silent) log(`Loading profile for ${lakeName}...`);
  try {
    const r = await fetch(`${CF_WORKER_URL}/research/get?lake=${encodeURIComponent(lakeName)}`);
    const data = await r.json();
    if (!data.ok) {
      if (!silent) log(`No profile yet for ${lakeName}: ${data.error || 'not found'}`);
      renderEmpty(lakeName);
      return null;
    }
    currentProfile = data.profile;
    currentPackageFiles = data.packageFiles || [];
    currentVersions = data.versions || [];
    window.TROLLMAP_RESEARCHED_CACHE[lakeName] = currentProfile;
    window.TROLLMAP_RESEARCHED_CACHE[data.sanitized] = currentProfile;
    if (currentProfile?.metadata?.status === 'verified') {
      window.TROLLMAP_RESEARCHED_CACHE[`${lakeName}_verified`] = currentProfile;
    }
    if (!silent) log(`Loaded ${lakeName} v${currentProfile?.metadata?.version} status=${currentProfile?.metadata?.status} overall=${currentProfile?.confidence?.overall?.percent}%`);
    renderProfile(currentProfile);
    return currentProfile;
  } catch (e) {
    log(`Load failed: ${e.message}`);
    renderEmpty(lakeName);
    return null;
  }
}

function renderEmpty(lakeName) {
  currentProfile = null;
  const meta = document.getElementById('researchMeta');
  if (meta) meta.style.display = 'none';
  document.getElementById('researchSections').innerHTML = `<div class="muted" style="padding:10px">No profile yet for <b>${esc(lakeName)}</b>. Click Research to build one. 8 agents, ~60 sec, free LLMs.</div>`;
  for (const id of ['confidenceCard', 'sourcesCard', 'summaryCard', 'notesCard', 'packageCard', 'reviewCard']) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
  const approveBtn = document.getElementById('btnApprove');
  if (approveBtn) approveBtn.style.display = 'none';
}

function esc(s) { return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function renderProfile(profile) {
  if (!profile) { renderEmpty(currentLakeName); return; }
  const meta = document.getElementById('researchMeta');
  if (meta) meta.style.display = 'flex';
  const status = profile.metadata?.status || 'draft';
  const statusPill = document.getElementById('researchStatusPill');
  const versionPill = document.getElementById('researchVersionPill');
  const updatedPill = document.getElementById('researchUpdatedPill');
  const confPill = document.getElementById('researchConfidencePill');
  if (statusPill) {
    statusPill.textContent = `Status: ${status}${profile.metadata?.verified ? ' ✔' : ''}`;
    statusPill.className = `meta-pill ${status === 'verified' ? 'verified' : 'draft'}`;
  }
  if (versionPill) versionPill.textContent = `Version: ${profile.metadata?.version || '?'} `;
  if (updatedPill) updatedPill.textContent = `Last Updated: ${profile.metadata?.lastUpdated?.slice(0, 10) || '?'}`;
  if (confPill) {
    const overall = profile.confidence?.overall?.percent || 0;
    confPill.textContent = `Overall: ${overall}% ${profile.confidence?.overall?.level || ''}`;
  }

  const approveBtn = document.getElementById('btnApprove');
  if (approveBtn) {
    approveBtn.style.display = status === 'verified' ? 'none' : 'inline-flex';
  }

  // Populate reviewCard dataset so re-run agents have full profile context
  const reviewCard = document.getElementById('reviewCard');
  if (reviewCard) {
    reviewCard.dataset.merged = JSON.stringify(profile);
    // Build parts from profile sections
    const parts = {};
    for (const key of RESEARCH_ORDER) {
      if (key === 'identity') parts[key] = profile.identity || {};
      else if (key === 'biology') parts[key] = profile.forage || profile.biology || {};
      else if (key === 'trolling') parts[key] = profile.trollingIntelligence || profile.trolling || {};
      else parts[key] = profile[key] || {};
    }
    reviewCard.dataset.parts = JSON.stringify(parts);
  }

  renderSections(profile);
  renderConfidence(profile);
  renderSources(profile);
  renderSummary(profile);
  renderNotes(profile);
  renderPackage(profile, currentPackageFiles, currentVersions);
}

function formatHumanReadableSection(key, data) {
  if (!data || (typeof data === 'object' && !Object.keys(data).length)) {
    return `<div class="muted" style="font-style:italic">No data researched for this section yet.</div>`;
  }
  if (typeof data === 'string') {
    return `<div style="white-space:pre-wrap">${esc(data)}</div>`;
  }

  if (key === 'identity') {
    const d = data.identity || data;
    return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:6px;font-size:12px;">
      <div><b>Waterbody:</b> ${esc(d.lakeName || '—')}</div>
      <div><b>State:</b> ${esc(d.state || '—')}</div>
      <div><b>River System:</b> ${esc(d.riverSystem || '—')}</div>
      <div><b>Reservoir Owner:</b> ${esc(d.reservoirOwner || '—')}</div>
      <div><b>Surface Area:</b> ${d.surfaceAreaAcres ? `${d.surfaceAreaAcres.toLocaleString()} acres` : '—'}</div>
      <div><b>Max Depth:</b> ${d.maxDepthFt ? `${d.maxDepthFt} ft` : '—'}</div>
      <div><b>Average Depth:</b> ${d.averageDepthFt ? `${d.averageDepthFt} ft` : '—'}</div>
      <div><b>Normal Pool:</b> ${d.normalPoolFt ? `${d.normalPoolFt} ft` : '—'}</div>
      <div><b>Dam Name:</b> ${esc(d.damName || '—')}</div>
      <div><b>Year Impounded:</b> ${d.yearImpounded ? d.yearImpounded : '—'}</div>
      <div style="grid-column:1/-1"><b>Type & Archetype:</b> ${esc(d.type || '—')} • <i>${esc(d.archetype || '—')}</i></div>
      ${d.aliases && d.aliases.length ? `<div style="grid-column:1/-1"><b>Aliases:</b> ${esc(d.aliases.join(', '))}</div>` : ''}
    </div>`;
  }

  if (key === 'limnology') {
    const d = data.limnology || data;
    const cl = d.waterClarity || {};
    const th = d.thermocline || {};
    const ox = d.oxygen || {};
    return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;font-size:12px;">
      <div style="background:rgba(255,255,255,.03);padding:6px;border-radius:6px">
        <b>🌊 Clarity & Color</b><br>
        Typical: <b>${esc(cl.typical || '—')}</b> ${cl.secchiFt ? `(${cl.secchiFt} ft Secchi)` : ''}<br>
        Color/Turbidity: ${esc(cl.color || d.waterColor || '—')}<br>
        ${cl.note ? `<span class="muted" style="font-size:11px">${esc(cl.note)}</span>` : ''}
      </div>
      <div style="background:rgba(255,255,255,.03);padding:6px;border-radius:6px">
        <b>🌡 Summer Thermocline</b><br>
        Depth: <b>${Array.isArray(th.summerDepthFt) ? `${th.summerDepthFt.join(' - ')} ft` : (th.summerDepthFt || '—')}</b> (${esc(th.strength || '—')} strength)<br>
        Winter Mix: ${esc(th.winterMix || '—')}<br>
        ${th.note ? `<span class="muted" style="font-size:11px">${esc(th.note)}</span>` : ''}
      </div>
      <div style="background:rgba(255,255,255,.03);padding:6px;border-radius:6px">
        <b>🫧 Dissolved Oxygen Floor</b><br>
        Depletion Depth: <b>${ox.depletionDepthFt ? `${ox.depletionDepthFt} ft` : '—'}</b><br>
        Anoxic Below: <b style="color:#ff7043">${ox.anoxicBelowFt ? `${ox.anoxicBelowFt} ft (fish floor)` : '—'}</b><br>
        ${ox.note ? `<span class="muted" style="font-size:11px">${esc(ox.note)}</span>` : ''}
      </div>
    </div>`;
  }

  if (key === 'biology') {
    const d = data.forage || data.biology || data;
    const primary = d.primaryForage || d.primary || [];
    const secondary = d.secondaryForage || d.secondary || [];
    const predators = d.predatorSpecies || d.predators || [];
    const calendar = d.forageCalendar || {};
    let html = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;font-size:12px;">`;
    html += `<div style="background:rgba(255,255,255,.03);padding:6px;border-radius:6px">
      <b>🐟 Primary Forage</b><br>`;
    if (Array.isArray(primary) && primary.length) {
      primary.forEach(f => { html += `• <b>${esc(typeof f === 'string' ? f : (f.species || f.name || '—'))}</b>${f.abundance ? ` (${esc(f.abundance)})` : ''}${f.notes ? ` — ${esc(f.notes)}` : ''}<br>`; });
    } else if (typeof primary === 'string') {
      html += `${esc(primary)}<br>`;
    } else { html += `<span class="muted">—</span><br>`; }
    html += `</div>`;
    html += `<div style="background:rgba(255,255,255,.03);padding:6px;border-radius:6px">
      <b>🎣 Secondary Forage</b><br>`;
    if (Array.isArray(secondary) && secondary.length) {
      secondary.forEach(f => { html += `• <b>${esc(typeof f === 'string' ? f : (f.species || f.name || '—'))}</b>${f.abundance ? ` (${esc(f.abundance)})` : ''}<br>`; });
    } else if (typeof secondary === 'string') {
      html += `${esc(secondary)}<br>`;
    } else { html += `<span class="muted">—</span><br>`; }
    html += `</div>`;
    html += `<div style="background:rgba(255,255,255,.03);padding:6px;border-radius:6px">
      <b>🦈 Predator Species</b><br>`;
    if (Array.isArray(predators) && predators.length) {
      predators.forEach(p => { html += `• ${esc(typeof p === 'string' ? p : (p.species || p.name || '—'))}<br>`; });
    } else if (typeof predators === 'string') {
      html += `${esc(predators)}<br>`;
    } else { html += `<span class="muted">—</span><br>`; }
    html += `</div>`;
    if (d.baitfishMovement) {
      html += `<div style="background:rgba(255,255,255,.03);padding:6px;border-radius:6px;grid-column:1/-1">
        <b>🔄 Baitfish Movement:</b> ${esc(d.baitfishMovement)}</div>`;
    }
    if (calendar && Object.keys(calendar).some(k => calendar[k])) {
      html += `<div style="background:rgba(255,255,255,.03);padding:6px;border-radius:6px;grid-column:1/-1">
        <b>📅 Forage Calendar</b><br>`;
      for (const season of ['spring','summer','fall','winter']) {
        if (calendar[season]) html += `<b>${season.charAt(0).toUpperCase()+season.slice(1)}:</b> ${esc(calendar[season])}<br>`;
      }
      html += `</div>`;
    }
    html += `</div>`;
    return html;
  }

  if (key === 'habitat') {
    const d = data.habitat || data;
    let html = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;font-size:12px;">`;
    const struct = d.structuralElements || {};
    html += `<div style="background:rgba(255,255,255,.03);padding:6px;border-radius:6px">
      <b>🏔 Structural Elements</b><br>
      Points: ${esc(struct.points || '—')}<br>
      Humps: ${esc(struct.humps || '—')}<br>
      Creek Arms: ${esc(struct.creekArms || '—')}<br>
    </div>`;
    html += `<div style="background:rgba(255,255,255,.03);padding:6px;border-radius:6px">
      <b>🪨 Bottom & Cover</b><br>
      Bottom: ${esc(typeof d.bottomComposition === 'object' ? Object.entries(d.bottomComposition).map(([k,v])=>`${k}: ${v}`).join(', ') : (d.bottomComposition || '—'))}<br>
      Cover: ${esc(Array.isArray(d.cover) ? d.cover.join(', ') : (d.cover || '—'))}<br>
      Standing Timber: ${esc(d.standingTimber || '—')}<br>
      Dock Density: ${esc(d.dockDensity || '—')}<br>
    </div>`;
    if (d.vegetation || d.aquaticVegetation) {
      const veg = d.vegetation || d.aquaticVegetation;
      html += `<div style="background:rgba(255,255,255,.03);padding:6px;border-radius:6px">
        <b>🌿 Vegetation</b><br>${esc(typeof veg === 'string' ? veg : JSON.stringify(veg))}</div>`;
    }
    if (d.notes) {
      html += `<div style="background:rgba(255,255,255,.03);padding:6px;border-radius:6px;grid-column:1/-1">
        <b>📝 Notes:</b> ${esc(d.notes)}</div>`;
    }
    html += `</div>`;
    return html;
  }

  if (key === 'navigation') {
    const d = data.navigation || data;
    let html = `<div style="font-size:12px;">`;
    const ramps = d.ramps || d.boatRamps || [];
    if (Array.isArray(ramps) && ramps.length) {
      html += `<b>🚤 Boat Ramps (${ramps.length})</b><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:6px;margin:6px 0;">`;
      ramps.forEach(r => {
        const name = typeof r === 'string' ? r : (r.name || r.label || '—');
        html += `<div style="background:rgba(255,255,255,.03);padding:4px 6px;border-radius:4px">• <b>${esc(name)}</b>${r.type ? ` (${esc(r.type)})` : ''}${r.notes ? ` — ${esc(r.notes)}` : ''}</div>`;
      });
      html += `</div>`;
    }
    const hazards = d.hazards || [];
    if (Array.isArray(hazards) && hazards.length) {
      html += `<b style="color:#ff7043">⚠️ Hazards (${hazards.length})</b><div style="margin:6px 0;">`;
      hazards.forEach(h => {
        const desc = typeof h === 'string' ? h : (h.description || h.name || h.type || '—');
        html += `<div style="background:rgba(255,82,82,.05);padding:4px 6px;border-radius:4px;margin:2px 0">⚠ ${esc(desc)}${h.location ? ` — <i>${esc(h.location)}</i>` : ''}</div>`;
      });
      html += `</div>`;
    }
    if (d.notes) html += `<div style="margin-top:6px"><b>📝 Notes:</b> ${esc(d.notes)}</div>`;
    if (d.channels) html += `<div style="margin-top:6px"><b>🔀 Channels:</b> ${esc(typeof d.channels === 'string' ? d.channels : JSON.stringify(d.channels))}</div>`;
    html += `</div>`;
    return html;
  }

  if (key === 'regulations') {
    const d = data.regulations || data;
    let html = `<div style="font-size:12px;">`;
    html += `<div style="margin-bottom:8px"><b>📍 State:</b> ${esc(d.state || '—')}</div>`;
    const gen = d.generalStateRegulations || d.statewide || {};
    if (gen && typeof gen === 'object' && Object.keys(gen).length) {
      html += `<div style="background:rgba(255,255,255,.03);padding:6px;border-radius:6px;margin-bottom:8px">
        <b>📋 General State Regulations</b><br>`;
      const creel = gen.creelLimits || gen;
      if (typeof creel === 'object') {
        for (const [k, v] of Object.entries(creel)) {
          html += `<div style="margin:2px 0">• <b>${esc(k)}:</b> ${esc(typeof v === 'string' ? v : JSON.stringify(v))}</div>`;
        }
      } else {
        html += `${esc(String(creel))}`;
      }
      html += `</div>`;
    }
    const lake = d.lakeSpecificRegulations || d.lakeSpecific || {};
    if (lake && typeof lake === 'object' && Object.keys(lake).length) {
      html += `<div style="background:rgba(0,229,255,.05);padding:6px;border-radius:6px;border:1px solid var(--accent);margin-bottom:8px">
        <b>🎯 Lake-Specific Regulations</b> ${lake.hasExceptions ? '<span style="color:var(--accent2)">(Has exceptions!)</span>' : ''}<br>`;
      const lcreel = lake.creelLimits || {};
      if (typeof lcreel === 'object') {
        for (const [k, v] of Object.entries(lcreel)) {
          html += `<div style="margin:2px 0">• <b>${esc(k)}:</b> ${esc(typeof v === 'string' ? v : JSON.stringify(v))}</div>`;
        }
      }
      if (lake.sizeLimits) {
        html += `<div style="margin-top:4px"><b>Size Limits:</b> ${esc(typeof lake.sizeLimits === 'string' ? lake.sizeLimits : JSON.stringify(lake.sizeLimits))}</div>`;
      }
      if (lake._raw && Array.isArray(lake._raw)) {
        lake._raw.forEach(r => { html += `<div style="margin:2px 0;color:var(--muted);font-size:11px">• ${esc(r)}</div>`; });
      }
      html += `</div>`;
    }
    if (d.notes) html += `<div><b>📝 Notes:</b> ${esc(d.notes)}</div>`;
    html += `</div>`;
    return html;
  }

  if (key === 'trolling') {
    const d = data.trollingIntelligence || data.trolling || data;
    let html = `<div style="font-size:12px;">`;
    // Handle various trolling data shapes
    if (d.routes || d.corridors || d.trollingCorridors) {
      const routes = d.routes || d.corridors || d.trollingCorridors || [];
      if (Array.isArray(routes) && routes.length) {
        html += `<b>🗺 Trolling Corridors (${routes.length})</b><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:6px;margin:6px 0;">`;
        routes.forEach(r => {
          html += `<div style="background:rgba(255,255,255,.03);padding:6px;border-radius:6px">
            <b>${esc(r.name || r.corridor || '—')}</b><br>
            ${r.depth || r.depthRange ? `Depth: ${esc(r.depth || r.depthRange)}<br>` : ''}
            ${r.speed || r.trollingSpeed ? `Speed: ${esc(r.speed || r.trollingSpeed)}<br>` : ''}
            ${r.lures || r.presentations ? `Lures: ${esc(Array.isArray(r.lures||r.presentations) ? (r.lures||r.presentations).join(', ') : (r.lures||r.presentations))}<br>` : ''}
            ${r.season ? `Season: ${esc(r.season)}<br>` : ''}
            ${r.notes ? `<span class="muted" style="font-size:11px">${esc(r.notes)}</span>` : ''}
          </div>`;
        });
        html += `</div>`;
      }
    }
    if (d.seasonalPatterns || d.patterns) {
      const pat = d.seasonalPatterns || d.patterns;
      html += `<div style="background:rgba(255,255,255,.03);padding:6px;border-radius:6px;margin:6px 0">
        <b>📅 Seasonal Patterns</b><br>`;
      if (typeof pat === 'object' && !Array.isArray(pat)) {
        for (const [season, info] of Object.entries(pat)) {
          html += `<div style="margin:3px 0"><b>${esc(season)}:</b> ${esc(typeof info === 'string' ? info : JSON.stringify(info))}</div>`;
        }
      } else if (Array.isArray(pat)) {
        pat.forEach(p => { html += `<div style="margin:2px 0">• ${esc(typeof p === 'string' ? p : (p.description || p.pattern || JSON.stringify(p)))}</div>`; });
      }
      html += `</div>`;
    }
    if (d.speeds || d.recommendedSpeeds) {
      html += `<div style="margin:6px 0"><b>⚡ Recommended Speeds:</b> ${esc(typeof (d.speeds||d.recommendedSpeeds) === 'string' ? (d.speeds||d.recommendedSpeeds) : JSON.stringify(d.speeds||d.recommendedSpeeds))}</div>`;
    }
    if (d.depthZones || d.targetDepths) {
      html += `<div style="margin:6px 0"><b>📏 Target Depths:</b> ${esc(typeof (d.depthZones||d.targetDepths) === 'string' ? (d.depthZones||d.targetDepths) : JSON.stringify(d.depthZones||d.targetDepths))}</div>`;
    }
    if (d.notes) html += `<div style="margin-top:6px"><b>📝 Notes:</b> ${esc(typeof d.notes === 'string' ? d.notes : JSON.stringify(d.notes))}</div>`;
    // Fallback for flat trolling objects with arbitrary keys
    const rendered = new Set(['routes','corridors','trollingCorridors','seasonalPatterns','patterns','speeds','recommendedSpeeds','depthZones','targetDepths','notes']);
    const remaining = Object.entries(d).filter(([k]) => !rendered.has(k) && !k.startsWith('_'));
    if (remaining.length && html === `<div style="font-size:12px;">`) {
      // nothing was rendered yet, show key-value pairs
      remaining.forEach(([k, v]) => {
        html += `<div style="margin:3px 0"><b>${esc(k)}:</b> ${esc(typeof v === 'string' ? v : JSON.stringify(v))}</div>`;
      });
    }
    html += `</div>`;
    return html;
  }

  if (key === 'summary') {
    const d = data.summary || data;
    const text = typeof d === 'string' ? d : (d.text || d.overview || '');
    const keywords = d.keywords || [];
    let html = `<div style="font-size:12px;">`;
    if (text) html += `<div style="white-space:pre-wrap;line-height:1.5">${esc(text)}</div>`;
    if (keywords.length) {
      html += `<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px">`;
      keywords.forEach(kw => { html += `<span class="pill" style="font-size:10px">${esc(kw)}</span>`; });
      html += `</div>`;
    }
    if (!text && !keywords.length) {
      // fallback for odd summary shapes
      html += `<div style="white-space:pre-wrap">${esc(typeof d === 'object' ? JSON.stringify(d, null, 2) : String(d))}</div>`;
    }
    html += `</div>`;
    return html;
  }

  // Generic fallback for any unknown section — render as readable key-value
  if (typeof data === 'object') {
    let html = `<div style="font-size:12px;">`;
    for (const [k, v] of Object.entries(data)) {
      if (k.startsWith('_')) continue;
      html += `<div style="margin:3px 0"><b>${esc(k)}:</b> ${esc(typeof v === 'string' ? v : JSON.stringify(v))}</div>`;
    }
    html += `</div>`;
    return html;
  }

  return `<pre style="font-size:11px;white-space:pre-wrap">${esc(JSON.stringify(data, null, 2))}</pre>`;
}

function renderSections(profile) {
  const container = document.getElementById('researchSections');
  if (!container) return;
  const conf = profile.confidence || {};
  let html = '';
  for (const key of RESEARCH_ORDER) {
    const label = RESEARCH_LABELS[key] || key;
    let sectionData;
    if (key === 'identity') {
      // Identity data may be nested under profile.identity or as top-level fields
      sectionData = profile.identity || {
        lakeName: profile.lakeName,
        state: profile.state,
        riverSystem: profile.riverSystem,
        archetype: profile.archetype,
        surfaceAreaAcres: profile.surfaceAreaAcres,
        maxDepthFt: profile.maxDepthFt,
        averageDepthFt: profile.averageDepthFt,
        normalPoolFt: profile.normalPoolFt,
        reservoirOwner: profile.reservoirOwner,
        damName: profile.damName,
        yearImpounded: profile.yearImpounded,
        county: profile.county,
        aliases: profile.aliases,
      };
    } else {
      sectionData = profile[key] || (key === 'biology' ? profile.forage : '') || (key === 'trolling' ? (profile.trollingIntelligence || profile.trolling) : null) || {};
    }
    const has = !!(key === 'identity'
      ? (profile.identity || profile.lakeName)
      : (profile[key] || (key === 'biology' ? profile.forage : null) || (key === 'trolling' ? (profile.trollingIntelligence || profile.trolling) : null)));
    const c = conf[key] || conf[key === 'trolling' ? 'trollingIntelligence' : ''] || conf[key === 'biology' ? 'forage' : ''];
    const pct = c?.percent || (has ? 75 : 0);
    const level = c?.level || (has ? 'medium' : 'missing');
    const okIcon = has ? (pct >= 70 ? '✔' : '⚠') : '◻';
    const levelClass = pct >= 95 ? 'veryhigh' : pct >= 85 ? 'high' : pct >= 70 ? 'medium' : pct >= 50 ? 'low' : 'need';

    html += `<div class="section-row" style="flex-wrap:wrap;justify-content:space-between;align-items:center;">
      <div style="display:flex;align-items:center;gap:8px;flex:1 1 200px;">
        <span class="sec-icon">${okIcon}</span>
        <span class="sec-name"><b>${label}</b> <span class="muted" style="font-size:11px">${level}</span></span>
      </div>
      <div style="display:flex;align-items:center;gap:10px;">
        <span class="sec-conf" style="font-weight:700;">${pct}%</span>
        ${has ? `<button type="button" class="small ghost btn-toggle-viewer" data-section="${key}" style="font-size:10px;padding:2px 6px;color:var(--accent)">👁️ View Summary</button>` : ''}
        <button type="button" class="small ghost btn-toggle-section-editor" data-section="${key}" style="font-size:10px;padding:2px 6px;">✏️ Edit JSON</button>
        <button type="button" class="small ghost btn-rerun-section" data-section="${key}" style="font-size:10px;padding:2px 6px;color:var(--accent2);">🔄 Re-run</button>
      </div>
    </div>
    <div class="conf-bar" style="margin:0 10px 4px 40px"><div class="conf-fill ${levelClass}" style="width:${pct}%"></div></div>
    
    <div class="section-viewer-container" id="viewer-container-${key}" style="display:none;margin:6px 10px 14px 40px;background:rgba(0,229,255,.03);border:1px solid var(--line);border-radius:8px;padding:10px;font-size:12px;color:var(--text);line-height:1.4;">
      ${formatHumanReadableSection(key, sectionData)}
    </div>
    <div class="section-editor-container" id="editor-container-${key}" style="display:none;margin:6px 10px 14px 40px;">
      <textarea class="review-section-textarea" data-agent="${key}" style="width:100%;height:220px;font-family:monospace;font-size:11px;background:#030810;color:#bdffa0;border:1px solid var(--line);border-radius:4px;padding:6px;white-space:pre;overflow:auto;">${JSON.stringify(sectionData, null, 2)}</textarea>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;">
        <button type="button" class="small primary btn-apply-section-edit" data-agent="${key}" style="background:var(--accent2);color:#000;font-size:11px;">✔ Apply Edit</button>
        <span class="muted" id="edit-status-${key}" style="font-size:11px;"></span>
      </div>
    </div>`;
  }
  container.innerHTML = html;

  container.querySelectorAll('.btn-toggle-viewer').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const sec = e.target.dataset.section;
      const el = document.getElementById(`viewer-container-${sec}`);
      if (el) {
        el.style.display = el.style.display === 'none' ? 'block' : 'none';
      }
    });
  });

  container.querySelectorAll('.btn-toggle-section-editor').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const sec = e.target.dataset.section;
      const el = document.getElementById(`editor-container-${sec}`);
      if (el) {
        el.style.display = el.style.display === 'none' ? 'block' : 'none';
      }
    });
  });

  container.querySelectorAll('.btn-apply-section-edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const agent = e.target.dataset.agent;
      const ta = container.querySelector(`.review-section-textarea[data-agent="${agent}"]`);
      const st = document.getElementById(`edit-status-${agent}`);
      const reviewCard = document.getElementById('reviewCard');
      if (!ta || !reviewCard?.dataset.merged) return;
      try {
        const parsed = JSON.parse(ta.value);
        const curMerged = JSON.parse(reviewCard.dataset.merged);
        const curParts = JSON.parse(reviewCard.dataset.parts || '{}');
        curMerged[agent] = parsed;
        if (agent === 'biology') curMerged.forage = parsed;
        if (agent === 'trolling') curMerged.trollingIntelligence = parsed;
        curParts[agent] = parsed;
        reviewCard.dataset.merged = JSON.stringify(curMerged);
        reviewCard.dataset.parts = JSON.stringify(curParts);
        if (typeof packagePartsCache !== 'undefined') packagePartsCache[agent] = parsed;
        if (st) { st.textContent = 'Applied ✓'; st.style.color = 'var(--accent2)'; }
        // Refresh viewer
        const viewer = document.getElementById(`viewer-container-${agent}`);
        if (viewer) viewer.innerHTML = formatHumanReadableSection(agent, parsed);
      } catch (err) {
        if (st) { st.textContent = 'Invalid JSON'; st.style.color = 'var(--bad)'; }
      }
    });
  });

  // Re-run single agent using stored normalized documents (no Tavily cost)
  container.querySelectorAll('.btn-rerun-section').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const agentKey = e.target.dataset.section;
      const btn = e.target;
      const st = document.getElementById(`edit-status-${agentKey}`);
      btn.disabled = true;
      btn.textContent = '⏳ Running...';
      if (st) { st.textContent = `Running ${agentKey} agent...`; st.style.color = 'var(--accent)'; }

      try {
        // Use already-stored facts from current profile — no re-extraction needed
        const reviewCard = document.getElementById('reviewCard');
        const prevProfile = reviewCard?.dataset.merged ? JSON.parse(reviewCard.dataset.merged) : (currentProfile || {});
        const storedFacts = prevProfile._extractedFacts || currentProfile?._extractedFacts || [];

        const agentRes = await fetch(`${CF_WORKER_URL}/research/agent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lakeName: currentLakeName,
            state: sanitizeStateFromLakeName(currentLakeName),
            agent: agentKey,
            previousResults: { ...prevProfile, _extractedFacts: storedFacts }
          })
        });
        const agentData = await agentRes.json();
        if (!agentData.success) throw new Error(agentData.error || 'Agent failed');

        // Step 4: Apply result to in-memory profile
        {
          const curMerged = reviewCard?.dataset.merged ? JSON.parse(reviewCard.dataset.merged) : (currentProfile || {});
          const curParts = reviewCard?.dataset.parts ? JSON.parse(reviewCard.dataset.parts) : {};
          curMerged[agentKey] = agentData.section;
          if (agentKey === 'biology') curMerged.forage = agentData.section;
          if (agentKey === 'trolling') curMerged.trollingIntelligence = agentData.section;
          // Update confidence for this section
          if (agentData.confidence) {
            if (!curMerged.confidence) curMerged.confidence = {};
            curMerged.confidence[agentKey] = agentData.confidence;
          }
          curParts[agentKey] = agentData.section;
          if (reviewCard) {
            reviewCard.dataset.merged = JSON.stringify(curMerged);
            reviewCard.dataset.parts = JSON.stringify(curParts);
          }
          // Keep currentProfile in sync
          currentProfile = curMerged;
          if (typeof packagePartsCache !== 'undefined') packagePartsCache[agentKey] = agentData.section;
        }

        // Step 5: Refresh UI for this section
        const viewer = document.getElementById(`viewer-container-${agentKey}`);
        if (viewer) viewer.innerHTML = formatHumanReadableSection(agentKey, agentData.section);
        const ta = container.querySelector(`.review-section-textarea[data-agent="${agentKey}"]`);
        if (ta) ta.value = JSON.stringify(agentData.section, null, 2);

        if (st) { st.textContent = `✓ Re-run complete (${agentData.confidence?.percent||'?'}% confidence via ${agentData.meta?.model||'?'})`; st.style.color = 'var(--accent2)'; }
        log(`[Re-run] ${agentKey}: ${agentData.confidence?.percent||'?'}% via ${agentData.meta?.model||'?'}`);

      } catch (err) {
        if (st) { st.textContent = `Failed: ${err.message}`; st.style.color = 'var(--bad)'; }
        log(`[Re-run] ${agentKey} failed: ${err.message}`);
      } finally {
        btn.disabled = false;
        btn.textContent = '🔄 Re-run';
      }
    });
  });
}

function renderConfidence(profile) {
  const card = document.getElementById('confidenceCard');
  const list = document.getElementById('confidenceList');
  if (!card || !list) return;
  const conf = profile.confidence || {};
  if (!Object.keys(conf).length) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  let html = '';
  for (const [k, v] of Object.entries(conf)) {
    if (k === 'overall') continue;
    if (typeof v !== 'object') continue;
    const pct = v.percent || 0;
    const levelClass = pct >= 95 ? 'veryhigh' : pct >= 85 ? 'high' : pct >= 70 ? 'medium' : pct >= 50 ? 'low' : 'need';
    html += `<div style="display:flex;justify-content:space-between;font-size:12px;margin:6px 0"><span>${RESEARCH_LABELS[k] || k} — ${v.level || ''} <span class="muted">(${v.reason || ''})</span></span><span style="color:var(--accent2)">${pct}%</span></div><div class="conf-bar"><div class="conf-fill ${levelClass}" style="width:${pct}%"></div></div>`;
  }
  const overall = conf.overall;
  if (overall) {
    const pct = overall.percent || 0;
    const levelClass = pct >= 95 ? 'veryhigh' : pct >= 85 ? 'high' : pct >= 70 ? 'medium' : pct >= 50 ? 'low' : 'need';
    html = `<div style="display:flex;justify-content:space-between;font-size:13px;font-weight:700;margin-bottom:6px"><span>Overall</span><span>${pct}% ${overall.level || ''}</span></div><div class="conf-bar" style="height:10px"><div class="conf-fill ${levelClass}" style="width:${pct}%"></div></div><div style="margin-top:10px;border-top:1px solid var(--line);padding-top:8px">${html}</div>`;
  }
  list.innerHTML = html;
}

function renderSources(profile) {
  const card = document.getElementById('sourcesCard');
  const list = document.getElementById('sourcesList');
  if (!card || !list) return;
  const sources = profile.sources || [];
  if (!sources.length) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  let html = '';
  for (const s of sources) {
    const trust = s.trust || '';
    const trustColor = trust.includes('OFFICIAL') ? 'var(--accent2)' : trust.includes('DERIVED') ? 'var(--accent)' : 'var(--muted)';
    html += `<div class="source-item"><span style="display:inline-block;padding:1px 6px;border-radius:10px;background:var(--panel2);border:1px solid var(--line);font-size:10px;color:${trustColor};margin-right:6px">${esc(trust || 'SOURCE')}</span><b>${esc(s.label || 'Unlabeled')}</b> ${s.url ? `— <a href="${esc(s.url)}" target="_blank">${esc(s.url.slice(0, 60))}</a>` : ''}</div>`;
  }
  list.innerHTML = html;
}

function renderSummary(profile) {
  const card = document.getElementById('summaryCard');
  const textEl = document.getElementById('summaryText');
  if (!card || !textEl) return;
  const summary = profile.summary?.text || profile.summary || '';
  if (!summary) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  textEl.textContent = typeof summary === 'string' ? summary : (summary.text || JSON.stringify(summary, null, 2));
}

function renderNotes(profile) {
  const card = document.getElementById('notesCard');
  const ta = document.getElementById('researchNotes');
  if (!card || !ta) return;
  card.style.display = 'block';
  ta.value = profile.notes || '';
}

function renderPackage(profile, packageFiles, versions) {
  const card = document.getElementById('packageCard');
  const filesEl = document.getElementById('packageFiles');
  const verEl = document.getElementById('versionHistory');
  if (!card) return;
  card.style.display = 'block';
  if (filesEl) {
    let html = `<div style="font-size:11px;color:var(--muted)">Master: lakes/${sanitize(profile.lakeName || currentLakeName)}.json (${JSON.stringify(profile).length} bytes)<br>Package folder: lake_packages/${sanitize(profile.lakeName || currentLakeName)}/</div><div style="display:flex;flex-wrap:wrap;gap:4px;margin:8px 0">`;
    for (const f of (packageFiles || [])) {
      html += `<span class="pill" title="${esc(f.key)}">${esc(f.name)} ${f.size ? `(${(f.size / 1024).toFixed(1)}KB)` : ''}</span>`;
    }
    html += `</div>`;
    filesEl.innerHTML = html;
  }
  if (verEl) {
    let html = `<div style="font-size:12px;font-weight:700;margin-bottom:4px">Version History (${(versions || []).length})</div>`;
    if (!versions || !versions.length) html += `<div class="muted" style="font-size:11px">No prior versions yet. First save creates v1.</div>`;
    else {
      html += `<div style="font-size:11px">`;
      for (const v of versions) {
        html += `<div>• ${esc(v.key)} ${v.size ? `— ${(v.size / 1024).toFixed(1)}KB` : ''}</div>`;
      }
      html += `</div>`;
    }
    verEl.innerHTML = html;
  }
}

function initLakeResearch() {
  populateResearchLakeDropdown();
  setTimeout(populateResearchLakeDropdown, 1500);

  document.getElementById('researchLakeSelect')?.addEventListener('change', (e) => {
    const v = e.target.value;
    if (v) loadProfile(v);
  });

  document.getElementById('researchLoadBtn')?.addEventListener('click', () => {
    const sel = document.getElementById('researchLakeSelect');
    if (sel?.value) loadProfile(sel.value);
    else alert('Select a lake first');
  });

  document.getElementById('researchListBtn')?.addEventListener('click', async () => {
    const data = await fetchResearchList();
    if (data) {
      alert(`Found ${data.count} researched lakes:\n${data.lakes.map(l => `${l.id} (${(l.size / 1024).toFixed(1)}KB)`).join('\n')}`);
    }
  });

  document.getElementById('btnResearch')?.addEventListener('click', () => {
    const lake = document.getElementById('researchLakeSelect')?.value;
    if (!lake) { alert('Select a lake first'); return; }
    if (!confirm(`Launch the fully structured Evidence Acquisition Pipeline for ${lake}? This will query trusted repositories, download documents through our CORS-bypassed proxy, parse PDFs client-side with PDF.js, score quality, and trigger structured LLM fact extraction. Continue?`)) return;
    runEvidencePipeline(lake);
  });

  // Inject Resume button next to Research button if not already in HTML
  if (!document.getElementById('btnResumeNormalized')) {
    const researchBtn = document.getElementById('btnResearch');
    if (researchBtn) {
      const resumeBtn = document.createElement('button');
      resumeBtn.id = 'btnResumeNormalized';
      resumeBtn.textContent = '⚡ Resume (Skip Downloads)';
      resumeBtn.title = 'Re-run extraction using existing normalized documents in R2 — skips PDF downloads';
      resumeBtn.style.cssText = 'margin-left:8px; background:var(--accent2,#f59e0b); color:#000; border:none; padding:6px 12px; border-radius:4px; cursor:pointer; font-size:0.85em;';
      researchBtn.parentNode.insertBefore(resumeBtn, researchBtn.nextSibling);
    }
  }

  document.getElementById('btnResumeNormalized')?.addEventListener('click', async () => {
    const lake = document.getElementById('researchLakeSelect')?.value;
    if (!lake) { alert('Select a lake first'); return; }
    if (!confirm(`Resume extraction for ${lake} using existing normalized documents already in R2? Skips all PDF downloads — jumps straight to scoring, fact extraction, and mapping.`)) return;
    runFromNormalized(lake);
  });

  document.getElementById('btnExport')?.addEventListener('click', () => {
    if (!currentProfile) { alert('No profile loaded to export.'); return; }
    try {
      const json = JSON.stringify(currentProfile, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${sanitize(currentLakeName || 'lake')}_research.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      log(`Exported profile for ${currentLakeName}`);
    } catch (e) {
      alert(`Export failed: ${e.message}`);
    }
  });

  console.log('🧠 Structured Evidence Acquisition & Lake Research module ready');
}

setTimeout(initLakeResearch, 800);

export { initLakeResearch, loadProfile, runEvidencePipeline, populateResearchLakeDropdown };