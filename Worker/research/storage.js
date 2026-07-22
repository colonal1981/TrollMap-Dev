// research/storage.js — split from worker-research.js (behavior-preserving)
import { CORS, JSON_HEADERS, callLLM, extractLLMText } from '../worker-core.js';
import { getLakeIntel, lakeKeyFromName } from '../worker-data.js';
import { tinyfishSearch } from './clients.js';
import { RESEARCH_CANONICAL_IDS, extractJsonPossibly, researchStorageId, sanitizeLakeId } from './keys.js';
import { calculateSectionConfidence } from './agents.js';

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
  const requestedSafe = sanitizeLakeId(lakeId);
  let safe = researchStorageId(lakeId);
  // Preserve existing legacy redirects for unrelated historical names.
  const LEGACY_PROFILE_KEYS = {
    'lake_thurmond_sc': 'clarks_hill_thurmond_sc_ga',
    'clarks_hill_lake_ga': 'clarks_hill_thurmond_sc_ga',
    'j_strom_thurmond_lake': 'clarks_hill_thurmond_sc_ga',
    'thurmond_lake_sc': 'clarks_hill_thurmond_sc_ga',
    'richard_b_russell_lake': 'lake_russell_sc',
    'lake_russell_ga': 'lake_russell_sc',
    'lake_russell_sc_ga': 'lake_russell_sc',
  };
  if (!RESEARCH_CANONICAL_IDS[requestedSafe] && LEGACY_PROFILE_KEYS[requestedSafe]) {
    safe = LEGACY_PROFILE_KEYS[requestedSafe];
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
  const safe = researchStorageId(lakeName);
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
  const safe = researchStorageId(lakeName);
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

  const safe = researchStorageId(lakeName);
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
  const safe = researchStorageId(lakeName);
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
  const safe = researchStorageId(lakeId);
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
  const safe = researchStorageId(lakeId);
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
    const safe = researchStorageId(lakeName);
    // try full lakeName sanitized, then key sanitized
    let obj = await env.R2_TROLLMAP_CHARTPACKS.get(`lakes/${safe}.json`);
    if (!obj) {
      const safeKey = researchStorageId(key);
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

export { handleResearchList, handleResearchGet, handleResearchSave, handleResearchApprove, handleResearchDeleteNormalizedDoc, handleResearchDelete, handleResearchPackage, handleResearchPackageFile, handleEnhancedLakeIntel, handleResearchValidationPass, handleResearchThermoclineSearch };
