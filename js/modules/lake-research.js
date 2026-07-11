/**
 * Lake Research Module v1.0 — Minimal MVP
 * 
 * Implements spec:
 * - Lake selector from existing SC/NC/GA dropdown
 * - 8-agent pipeline orchestrated client-side via POST /research/agent
 * - Hybrid R2 storage: lakes/*.json master + lake_packages/* split + versions/
 * - Confidence calculated from trust tiers (worker)
 * - Sources, Notes editable, Export/Import, Version history
 * - Review + Human Approval (draft -> verified)
 * - Smart Plan auto-use with badge
 *
 * Worker endpoints (reuses R2_TROLLMAP_CHARTPACKS):
 *  POST /research/agent       - run single agent
 *  GET  /research/list        - list masters
 *  GET  /research/get?lake=.. - get master+pkg+versions
 *  POST /research/save        - save merged
 *  POST /research/approve     - verify
 *  GET  /research/package?lake=.. - list package files
 *  GET  /lake-research?lake=..   - enhanced intel (curated + researched)
 */

import { state, CF_WORKER_URL } from '../core/state.js';
import { LAKE_DB } from '../data/lakes.js';

const RESEARCH_ORDER = ['identity','limnology','biology','habitat','navigation','regulations','trolling','summary'];
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
let packagePartsCache = {}; // holds per-agent results

// Cache for Smart Plan auto-use
window.TROLLMAP_RESEARCHED_CACHE = window.TROLLMAP_RESEARCHED_CACHE || {};
window.getResearchedProfile = (lakeName) => {
  const key = lakeName?.toLowerCase() || '';
  // try exact match or sanitized
  for (const k of Object.keys(window.TROLLMAP_RESEARCHED_CACHE)) {
    if (k.toLowerCase().includes(key) || key.includes(k.toLowerCase())) {
      return window.TROLLMAP_RESEARCHED_CACHE[k];
    }
  }
  return null;
};

function log(msg) {
  researchLog.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
  const el = document.getElementById('researchLog');
  if (el) {
    el.textContent = researchLog.join('\n');
    el.scrollTop = el.scrollHeight;
  }
  console.log(`[research] ${msg}`);
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
  const s = (lakeName||'').toUpperCase();
  if (s.includes(', NC') || s.includes(' NC') || s.includes('NORTH CAROLINA')) return 'NC';
  if (s.includes(', GA') || s.includes(' GA') || s.includes('GEORGIA')) return 'GA';
  return 'SC';
}

async function populateResearchLakeDropdown() {
  const sel = document.getElementById('researchLakeSelect');
  if (!sel) return;
  const existing = new Set(Array.from(sel.options).map(o=>o.value));
  // from LAKE_DB
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
  // also from planLake dropdown if already populated
  const planSel = document.getElementById('planLake');
  if (planSel) {
    for (const opt of Array.from(planSel.options)) {
      if (opt.value && !existing.has(opt.value)) {
        const n = document.createElement('option');
        n.value = opt.value;
        n.textContent = opt.value;
        sel.appendChild(n);
        existing.add(opt.value);
      }
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

async function loadProfile(lakeName, silent=false) {
  if (!lakeName) return null;
  currentLakeName = lakeName;
  if (!silent) log(`Loading profile for ${lakeName}...`);
  try {
    const r = await fetch(`${CF_WORKER_URL}/research/get?lake=${encodeURIComponent(lakeName)}`);
    const data = await r.json();
    if (!data.ok) {
      if (!silent) log(`No profile yet for ${lakeName}: ${data.error||'not found'}`);
      renderEmpty(lakeName);
      return null;
    }
    currentProfile = data.profile;
    currentPackageFiles = data.packageFiles||[];
    currentVersions = data.versions||[];
    // cache for Smart Plan
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
  for (const id of ['confidenceCard','sourcesCard','summaryCard','notesCard','packageCard','reviewCard']) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
  const approveBtn = document.getElementById('btnApprove');
  if (approveBtn) approveBtn.style.display = 'none';
}

function esc(s) { return String(s||'').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function renderProfile(profile) {
  if (!profile) { renderEmpty(currentLakeName); return; }
  const meta = document.getElementById('researchMeta');
  if (meta) meta.style.display = 'flex';
  const status = profile.metadata?.status||'draft';
  const statusPill = document.getElementById('researchStatusPill');
  const versionPill = document.getElementById('researchVersionPill');
  const updatedPill = document.getElementById('researchUpdatedPill');
  const confPill = document.getElementById('researchConfidencePill');
  if (statusPill) {
    statusPill.textContent = `Status: ${status}${profile.metadata?.verified?' ✔':''}`;
    statusPill.className = `meta-pill ${status==='verified'?'verified':'draft'}`;
  }
  if (versionPill) versionPill.textContent = `Version: ${profile.metadata?.version||'?'} `;
  if (updatedPill) updatedPill.textContent = `Last Updated: ${profile.metadata?.lastUpdated?.slice(0,10)||'?'}`;
  if (confPill) {
    const overall = profile.confidence?.overall?.percent || 0;
    confPill.textContent = `Overall: ${overall}% ${profile.confidence?.overall?.level||''}`;
  }

  const approveBtn = document.getElementById('btnApprove');
  if (approveBtn) {
    approveBtn.style.display = status==='verified' ? 'none' : 'inline-flex';
  }

  renderSections(profile);
  renderConfidence(profile);
  renderSources(profile);
  renderSummary(profile);
  renderNotes(profile);
  renderPackage(profile, currentPackageFiles, currentVersions);
}

function renderSections(profile) {
  const container = document.getElementById('researchSections');
  if (!container) return;
  const conf = profile.confidence||{};
  let html = '';
  for (const key of RESEARCH_ORDER) {
    const label = RESEARCH_LABELS[key]||key;
    const sectionData = profile[key] || (key==='biology' ? profile.forage : '') || (key==='trolling' ? (profile.trollingIntelligence||profile.trolling) : null) || {};
    const has = !!(profile[key] || profile[key==='biology' ? 'forage' : ''] || (key==='trolling' && (profile.trollingIntelligence||profile.trolling)));
    const c = conf[key] || conf[key==='trolling' ? 'trollingIntelligence' : ''] || conf[key==='biology' ? 'forage' : ''];
    const pct = c?.percent|| (has?75:0);
    const level = c?.level|| (has?'medium':'missing');
    const okIcon = has ? (pct>=70 ? '✔' : '⚠') : '◻';
    const levelClass = pct>=95?'veryhigh':pct>=85?'high':pct>=70?'medium':pct>=50?'low':'need';
    
    html += `<div class="section-row" style="flex-wrap:wrap;justify-content:space-between;align-items:center;">
      <div style="display:flex;align-items:center;gap:8px;flex:1 1 200px;">
        <span class="sec-icon">${okIcon}</span>
        <span class="sec-name"><b>${label}</b> <span class="muted" style="font-size:11px">${level}</span></span>
      </div>
      <div style="display:flex;align-items:center;gap:10px;">
        <span class="sec-conf" style="font-weight:700;">${pct}%</span>
        <button type="button" class="small ghost btn-toggle-section-editor" data-section="${key}" style="font-size:10px;padding:2px 6px;">✏️ Edit JSON</button>
      </div>
    </div>
    <div class="conf-bar" style="margin:0 10px 4px 40px"><div class="conf-fill ${levelClass}" style="width:${pct}%"></div></div>
    <div class="section-editor-container" id="editor-container-${key}" style="display:none;margin:4px 10px 12px 40px;background:#060f1a;border:1px solid var(--line);border-radius:6px;padding:8px;">
      <div style="font-size:11px;color:var(--accent);margin-bottom:4px;">Make direct changes to this section's JSON below. If something is wrong or different for this lake, edit or delete it:</div>
      <textarea class="section-loaded-textarea" id="textarea-section-${key}" data-section="${key}" style="width:100%;height:220px;font-family:monospace;font-size:11px;background:#030810;color:#bdffa0;border:1px solid var(--line);border-radius:4px;padding:6px;white-space:pre;overflow:auto;">${esc(JSON.stringify(sectionData, null, 2))}</textarea>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;">
        <div style="display:flex;gap:6px;">
          <button type="button" class="small primary btn-save-section-loaded" data-section="${key}" style="background:var(--accent2);color:#000;font-size:11px;">💾 Apply Section Change</button>
          <button type="button" class="small ghost btn-format-section-loaded" data-section="${key}" style="font-size:11px;">✨ Format</button>
        </div>
        <span id="status-section-${key}" class="muted" style="font-size:11px;"></span>
      </div>
    </div>`;
  }
  container.innerHTML = html;

  container.querySelectorAll('.btn-toggle-section-editor').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const sec = e.target.dataset.section;
      const el = document.getElementById(`editor-container-${sec}`);
      if (el) {
        el.style.display = el.style.display === 'none' ? 'block' : 'none';
      }
    });
  });

  container.querySelectorAll('.btn-format-section-loaded').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const sec = e.target.dataset.section;
      const ta = document.getElementById(`textarea-section-${sec}`);
      if (ta) {
        try {
          const parsed = JSON.parse(ta.value);
          ta.value = JSON.stringify(parsed, null, 2);
          const st = document.getElementById(`status-section-${sec}`);
          if (st) st.textContent = 'Formatted ✓';
        } catch (err) {
          alert(`Cannot format — invalid JSON: ${err.message}`);
        }
      }
    });
  });

  container.querySelectorAll('.btn-save-section-loaded').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const sec = e.target.dataset.section;
      const ta = document.getElementById(`textarea-section-${sec}`);
      const st = document.getElementById(`status-section-${sec}`);
      if (!ta || !currentProfile) return;
      try {
        const parsed = JSON.parse(ta.value);
        currentProfile[sec] = parsed;
        if (sec === 'biology') currentProfile.forage = parsed;
        if (sec === 'trolling') currentProfile.trollingIntelligence = parsed;
        if (sec === 'trollingIntelligence') currentProfile.trolling = parsed;
        packagePartsCache[sec] = parsed;

        if (st) {
          st.textContent = 'Applied in memory ✓ (click Approve/Save above to persist)';
          st.style.color = 'var(--accent2)';
        }
        log(`Directly modified ${sec} JSON in loaded profile.`);
        setTimeout(() => { if (st) st.textContent = ''; }, 4000);
      } catch (err) {
        alert(`Failed to apply section JSON — syntax error:\n${err.message}`);
        if (st) {
          st.textContent = 'Invalid JSON syntax ❌';
          st.style.color = 'var(--bad)';
        }
      }
    });
  });
}

function renderConfidence(profile) {
  const card = document.getElementById('confidenceCard');
  const list = document.getElementById('confidenceList');
  if (!card||!list) return;
  const conf = profile.confidence||{};
  if (!Object.keys(conf).length) { card.style.display='none'; return; }
  card.style.display='block';
  let html='';
  for (const [k,v] of Object.entries(conf)) {
    if (k==='overall') continue;
    if (typeof v!=='object') continue;
    const pct = v.percent||0;
    const levelClass = pct>=95?'veryhigh':pct>=85?'high':pct>=70?'medium':pct>=50?'low':'need';
    html += `<div style="display:flex;justify-content:space-between;font-size:12px;margin:6px 0"><span>${RESEARCH_LABELS[k]||k} — ${v.level||''} <span class="muted">(${v.reason||''})</span></span><span style="color:var(--accent2)">${pct}%</span></div><div class="conf-bar"><div class="conf-fill ${levelClass}" style="width:${pct}%"></div></div>`;
  }
  const overall = conf.overall;
  if (overall) {
    const pct = overall.percent||0;
    const levelClass = pct>=95?'veryhigh':pct>=85?'high':pct>=70?'medium':pct>=50?'low':'need';
    html = `<div style="display:flex;justify-content:space-between;font-size:13px;font-weight:700;margin-bottom:6px"><span>Overall</span><span>${pct}% ${overall.level||''}</span></div><div class="conf-bar" style="height:10px"><div class="conf-fill ${levelClass}" style="width:${pct}%"></div></div><div style="margin-top:10px;border-top:1px solid var(--line);padding-top:8px">${html}</div>`;
  }
  list.innerHTML = html;
}

function renderSources(profile) {
  const card = document.getElementById('sourcesCard');
  const list = document.getElementById('sourcesList');
  if (!card||!list) return;
  const sources = profile.sources||[];
  if (!sources.length) { card.style.display='none'; return; }
  card.style.display='block';
  let html='';
  for (const s of sources) {
    const trust = s.trust||'';
    const trustColor = trust.includes('OFFICIAL') ? 'var(--accent2)' : trust.includes('DERIVED') ? 'var(--accent)' : 'var(--muted)';
    html += `<div class="source-item"><span style="display:inline-block;padding:1px 6px;border-radius:10px;background:var(--panel2);border:1px solid var(--line);font-size:10px;color:${trustColor};margin-right:6px">${esc(trust||'SOURCE')}</span><b>${esc(s.label||'Unlabeled')}</b> ${s.url?`— <a href="${esc(s.url)}" target="_blank">${esc(s.url.slice(0,60))}</a>`:''}</div>`;
  }
  // also check per-section sources inside confidence? Already aggregated but show extras from packageParts
  list.innerHTML = html;
}

function renderSummary(profile) {
  const card = document.getElementById('summaryCard');
  const textEl = document.getElementById('summaryText');
  if (!card||!textEl) return;
  const summary = profile.summary?.text || profile.summary || '';
  if (!summary) { card.style.display='none'; return; }
  card.style.display='block';
  textEl.textContent = typeof summary==='string'? summary : (summary.text||JSON.stringify(summary,null,2));
}

function renderNotes(profile) {
  const card = document.getElementById('notesCard');
  const ta = document.getElementById('researchNotes');
  if (!card||!ta) return;
  card.style.display='block';
  ta.value = profile.notes||'';
}

function renderPackage(profile, packageFiles, versions) {
  const card = document.getElementById('packageCard');
  const filesEl = document.getElementById('packageFiles');
  const verEl = document.getElementById('versionHistory');
  if (!card) return;
  card.style.display='block';
  if (filesEl) {
    let html=`<div style="font-size:11px;color:var(--muted)">Master: lakes/${sanitize(profile.lakeName||currentLakeName)}.json (${JSON.stringify(profile).length} bytes)<br>Package folder: lake_packages/${sanitize(profile.lakeName||currentLakeName)}/</div><div style="display:flex;flex-wrap:wrap;gap:4px;margin:8px 0">`;
    for (const f of (packageFiles||[])) {
      html+=`<span class="pill" title="${esc(f.key)}">${esc(f.name)} ${f.size?`(${(f.size/1024).toFixed(1)}KB)`:''}</span>`;
    }
    html+=`</div>`;
    filesEl.innerHTML = html;
  }
  if (verEl) {
    let html=`<div style="font-size:12px;font-weight:700;margin-bottom:4px">Version History (${(versions||[]).length})</div>`;
    if (!versions||!versions.length) html+=`<div class="muted" style="font-size:11px">No prior versions yet. First save creates v1.</div>`;
    else {
      html+=`<div style="font-size:11px">`;
      for (const v of versions) {
        html+=`<div>• ${esc(v.key)} ${v.size?`— ${(v.size/1024).toFixed(1)}KB`:''}</div>`;
      }
      html+=`</div>`;
    }
    verEl.innerHTML = html;
  }
}

function sanitize(str) {
  return String(str||'').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'').slice(0,80)||'unknown';
}

async function callAgent(lakeName, agentKey, previousResults) {
  const stateName = sanitizeStateFromLakeName(lakeName);
  const payload = {
    lakeName,
    state: stateName,
    agent: agentKey,
    previousResults
  };
  const r = await fetch(`${CF_WORKER_URL}/research/agent`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(payload)
  });
  const data = await r.json();
  if (!data.success) throw new Error(data.error||`Agent ${agentKey} failed`);
  return data;
}

async function runResearch(lakeName, selectedAgents=null) {
  if (researchInProgress) { alert('Research already running'); return; }
  if (!lakeName) { alert('Select a lake first'); return; }
  researchInProgress = true;
  researchLog = [];
  packagePartsCache = {};
  showProgress(true);
  setProgress(`Starting research for ${lakeName}...`, 0);
  log(`=== RESEARCH START ${lakeName} ===`);
  const order = selectedAgents && selectedAgents.length ? selectedAgents : RESEARCH_ORDER;
  // ensure identity first if not included but needed for context? If refreshing partial, we need identity context - try load existing
  let accumulated = {};
  // if refreshing, preload existing profile as context
  if (selectedAgents) {
    try {
      const existing = await loadProfile(lakeName, true);
      if (existing) accumulated = {...existing};
    } catch {}
  }

  let results = [];
  for (let i=0;i<order.length;i++) {
    const agentKey = order[i];
    const pct = (i/order.length)*100;
    setProgress(`Running ${RESEARCH_LABELS[agentKey]||agentKey} (${i+1}/${order.length})...`, pct);
    log(`Agent ${i+1}/${order.length}: ${agentKey}...`);
    try {
      const res = await callAgent(lakeName, agentKey, accumulated);
      const chain = res.meta?.fallbackChain?.length ? ` [tried: ${res.meta.fallbackChain.join(' → ')}]` : '';
      log(`✔ ${agentKey}: confidence ${res.confidence?.percent}% via ${res.meta?.model} (${res.meta?.durationMs}ms) sources:${res.sources?.length||0}${chain}`);
      packagePartsCache[agentKey] = res.section;
      packagePartsCache[res.sectionKey] = res.section;
      // merge into accumulated for next agents
      accumulated[res.sectionKey] = res.section;
      if (agentKey==='identity') accumulated.identity = res.section;
      if (agentKey==='biology') { accumulated.biology = res.section; accumulated.forage = res.section; }
      if (agentKey==='trolling') { accumulated.trollingIntelligence = res.section; accumulated.trolling = res.section; }
      // keep sources aggregated
      accumulated._sources = [...(accumulated._sources||[]), ...(res.sources||[])];
      results.push(res);
      setProgress(`Completed ${RESEARCH_LABELS[agentKey]||agentKey}`, ((i+1)/order.length)*100);
      await new Promise(r=>setTimeout(r, 200));
    } catch (e) {
      log(`✘ ${agentKey} failed: ${e.message}`);
      // continue but mark need review
      packagePartsCache[agentKey] = {error: e.message, failed:true};
    }
  }

  setProgress(`Merging results...`, 95);
  log(`Merging ${Object.keys(packagePartsCache).length} sections...`);
  // Build final merged profile per spec section 6
  const merged = buildMasterProfile(lakeName, accumulated, packagePartsCache, results);
  log(`Merged profile: ${JSON.stringify(merged).length} bytes, overall confidence ~${merged.confidence?.overall?.percent||'?'}%`);
  setProgress(`Ready for review`, 100);
  log(`=== RESEARCH COMPLETE — Review required ===`);
  // Show review screen
  renderReview(merged, results);
  researchInProgress = false;
  return merged;
}

function buildMasterProfile(lakeName, accumulated, parts, agentResults) {
  const identity = accumulated.identity || parts.identity || {};
  const now = new Date().toISOString();
  // aggregate sources from all agents
  let allSources = [];
  let conf = {};
  for (const r of agentResults) {
    if (r.sources) allSources = allSources.concat(r.sources);
    if (r.confidence) conf[r.sectionKey||r.agent] = r.confidence;
  }
  // deduplicate sources by label
  const seen = new Set();
  allSources = allSources.filter(s=>{ const k=(s.label||'')+'|'+(s.url||''); if (seen.has(k)) return false; seen.add(k); return true; });

  let confSum=0, confCount=0;
  for (const v of Object.values(conf)) { if (v.percent) { confSum+=v.percent; confCount++; } }
  const overall = confCount? Math.round(confSum/confCount):75;

  const master = {
    lakeName: identity.lakeName || lakeName,
    aliases: identity.aliases || [],
    state: identity.state || sanitizeStateFromLakeName(lakeName),
    riverSystem: identity.riverSystem || "",
    archetype: identity.archetype || "",
    surfaceAreaAcres: identity.surfaceAreaAcres ?? null,
    maxDepthFt: identity.maxDepthFt ?? null,
    averageDepthFt: identity.averageDepthFt ?? null,
    limnology: accumulated.limnology || parts.limnology || {},
    forage: accumulated.forage || accumulated.biology || parts.biology || {},
    biology: accumulated.biology || {},
    habitat: accumulated.habitat || parts.habitat || {},
    navigation: accumulated.navigation || parts.navigation || {},
    regulations: accumulated.regulations || parts.regulations || {},
    trolling: accumulated.trolling || accumulated.trollingIntelligence || parts.trolling || parts.trollingIntelligence || {},
    trollingIntelligence: accumulated.trollingIntelligence || accumulated.trolling || {},
    summary: accumulated.summary || parts.summary || {},
    sources: allSources,
    confidence: {...conf, overall:{percent:overall, level: overall>=95?'very high':overall>=85?'high':overall>=70?'medium':'low'}},
    metadata: {
      version: "1.0",
      versionNumber: 1,
      status: "draft",
      lastUpdated: now,
      createdAt: now,
      createdBy: "Ryan",
      verified: false,
      lakeId: sanitize(lakeName)
    },
    notes: document.getElementById('researchNotes')?.value || "",
    researchLog: {
      requestTime: now,
      lakeName,
      completedAgents: agentResults.map(r=>r.agent),
      agentMeta: agentResults.map(r=>({agent:r.agent, model:r.meta?.model, provider:r.meta?.provider, durationMs:r.meta?.durationMs, confidence:r.confidence})),
      log: researchLog
    }
  };
  return master;
}

function renderReview(merged, agentResults) {
  const card = document.getElementById('reviewCard');
  const list = document.getElementById('reviewList');
  if (!card||!list) return;
  card.style.display='block';
  // store merged for save
  card.dataset.merged = JSON.stringify(merged);
  card.dataset.parts = JSON.stringify(packagePartsCache);
  let html='';
  for (const r of agentResults) {
    const pct = r.confidence?.percent||0;
    const need = pct<70;
    const levelClass = pct>=95?'veryhigh':pct>=85?'high':pct>=70?'medium':pct>=50?'low':'need';
    html+=`<div class="review-card ${need?'need':''}">
      <div style="display:flex;justify-content:space-between"><b>${RESEARCH_LABELS[r.agent]||r.agent}</b><span style="font-size:11px;color:${need?'var(--bad)':'var(--accent2)'}">${pct}% ${r.confidence?.level||''} — ${r.confidence?.reason||''}</span></div>
      <div class="conf-bar"><div class="conf-fill ${levelClass}" style="width:${pct}%"></div></div>
      <div style="font-size:11px;color:var(--muted);margin-top:4px">Model: ${esc(r.meta?.model||'?')} • ${r.meta?.durationMs||0}ms • ${r.sources?.length||0} sources</div>
      <details style="margin-top:6px" open>
        <summary style="font-size:11px;color:var(--accent);cursor:pointer;font-weight:bold;">View & Direct Edit JSON (Interactive)</summary>
        <div style="font-size:10px;color:var(--muted);margin:4px 0;">If any creel limit, size limit, or lake fact is wrong, edit or delete it below right before saving:</div>
        <textarea class="review-section-textarea" data-agent="${r.agent}" style="width:100%;height:200px;font-family:monospace;font-size:11px;background:#030810;color:#bdffa0;border:1px solid var(--line);border-radius:4px;padding:6px;white-space:pre;overflow:auto;">${esc(JSON.stringify(r.section, null, 2))}</textarea>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;">
          <button type="button" class="small primary btn-apply-review-section" data-agent="${r.agent}" style="background:var(--accent2);color:#000;font-size:11px;">✔ Apply Section Edit</button>
          <span class="status-review-section muted" id="status-review-${r.agent}" style="font-size:11px;"></span>
        </div>
      </details>
      <div style="margin-top:8px;display:flex;gap:6px">
        <label style="font-size:11px;display:flex;align-items:center;gap:4px"><input type="checkbox" class="review-accept" data-agent="${r.agent}" ${pct>=70?'checked':''}> Accept ${pct<50?'— Needs Review':''}</label>
      </div>
    </div>`;
  }
  list.innerHTML = html;

  list.querySelectorAll('.btn-apply-review-section').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const agent = e.target.dataset.agent;
      const ta = list.querySelector(`.review-section-textarea[data-agent="${agent}"]`);
      const st = document.getElementById(`status-review-${agent}`);
      if (!ta || !card.dataset.merged) return;
      try {
        const parsed = JSON.parse(ta.value);
        const curMerged = JSON.parse(card.dataset.merged);
        const curParts = JSON.parse(card.dataset.parts || '{}');
        curMerged[agent] = parsed;
        if (agent === 'biology') curMerged.forage = parsed;
        if (agent === 'trolling') curMerged.trollingIntelligence = parsed;
        curParts[agent] = parsed;
        card.dataset.merged = JSON.stringify(curMerged);
        card.dataset.parts = JSON.stringify(curParts);
        packagePartsCache[agent] = parsed;
        if (st) {
          st.textContent = 'Applied to Review Buffer ✓';
          st.style.color = 'var(--accent2)';
        }
      } catch (err) {
        alert(`Cannot apply edit — invalid JSON:\n${err.message}`);
      }
    });
  });

  // scroll to review
  card.scrollIntoView({behavior:'smooth'});
}

async function saveProfile(status='draft') {
  const reviewCard = document.getElementById('reviewCard');
  let merged, parts;
  if (reviewCard && reviewCard.style.display !== 'none' && reviewCard.dataset.merged) {
    try {
      merged = JSON.parse(reviewCard.dataset.merged);
      parts = JSON.parse(reviewCard.dataset.parts || '{}');
      // Automatically incorporate any direct edits from textareas on the review screen right before saving
      document.querySelectorAll('.review-section-textarea').forEach(ta => {
        const agent = ta.dataset.agent;
        if (agent && ta.value) {
          try {
            const parsed = JSON.parse(ta.value);
            merged[agent] = parsed;
            if (agent === 'biology') merged.forage = parsed;
            if (agent === 'trolling') merged.trollingIntelligence = parsed;
            parts[agent] = parsed;
            packagePartsCache[agent] = parsed;
          } catch (e) {
            console.warn(`Warning: unparsed JSON in review textarea for ${agent}`, e);
          }
        }
      });
    } catch {}
  }
  // if no review, use currentProfile as base
  if (!merged) {
    if (!currentProfile) { alert('No profile to save'); return; }
    merged = currentProfile;
    parts = packagePartsCache;
  }
  // check accept checkboxes
  const accepts = Array.from(document.querySelectorAll('.review-accept'));
  if (accepts.length) {
    const rejected = accepts.filter(cb=>!cb.checked).map(cb=>cb.dataset.agent);
    if (rejected.length) {
      if (!confirm(`You have ${rejected.length} sections not accepted (${rejected.join(', ')}). Save anyway as draft? Low confidence sections will be flagged Needs Review.`)) return;
    }
  }
  // merge notes
  const notes = document.getElementById('researchNotes')?.value || merged.notes || "";
  merged.notes = notes;
  merged.metadata = merged.metadata||{};
  merged.metadata.status = status;

  log(`Saving ${merged.lakeName} as ${status}...`);
  try {
    const r = await fetch(`${CF_WORKER_URL}/research/save`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        lakeName: merged.lakeName,
        profile: merged,
        packageParts: parts||{},
        notes,
        status,
        requestedBy: "Ryan",
        verified: status==='verified',
        researchLog: merged.researchLog
      })
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error||'save failed');
    log(`✔ Saved ${data.lakeName} v${data.version} ${data.status} ${data.overallConfidence}% ${data.bytes} bytes`);
    alert(`Saved ${data.lakeName} v${data.version} as ${data.status}\nConfidence: ${data.overallConfidence}%\n${data.bytes} bytes\nKey: ${data.masterKey}`);
    // reload
    await loadProfile(merged.lakeName);
    // hide review
    if (reviewCard) reviewCard.style.display='none';
    // update Smart Plan badge
    updateSmartPlanBadge(merged.lakeName);
  } catch (e) {
    log(`✘ Save failed: ${e.message}`);
    alert(`Save failed: ${e.message}`);
  }
}

async function approveProfile() {
  const lakeName = currentLakeName || document.getElementById('researchLakeSelect')?.value;
  if (!lakeName) { alert('No lake selected'); return; }
  log(`Approving ${lakeName} as verified...`);
  try {
    const r = await fetch(`${CF_WORKER_URL}/research/approve`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({lakeName, approvedBy:"Ryan", notes: document.getElementById('researchNotes')?.value||""})
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error||'approve failed');
    log(`✔ Approved ${lakeName} as verified v${data.version}`);
    alert(`Approved ${lakeName} as verified!`);
    await loadProfile(lakeName);
    updateSmartPlanBadge(lakeName);
  } catch (e) {
    log(`✘ Approve failed: ${e.message}`);
    alert(`Approve failed: ${e.message}`);
  }
}

function exportProfile() {
  if (!currentProfile) { alert('No profile loaded'); return; }
  const blob = new Blob([JSON.stringify(currentProfile, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sanitize(currentProfile.lakeName||currentLakeName)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  log(`Exported ${currentProfile.lakeName}`);
}

async function importProfile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const profile = JSON.parse(text);
    const lakeName = profile.lakeName || profile.identity?.lakeName || file.name.replace(/\.json$/,'');
    if (!confirm(`Import ${lakeName} v${profile.metadata?.version||'?'}? This will create new version in R2.`)) return;
    log(`Importing ${lakeName}...`);
    const r = await fetch(`${CF_WORKER_URL}/research/save`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        lakeName,
        profile,
        packageParts: {
          identity: profile.identity,
          limnology: profile.limnology,
          biology: profile.biology||profile.forage,
          habitat: profile.habitat,
          navigation: profile.navigation,
          regulations: profile.regulations,
          trolling: profile.trolling||profile.trollingIntelligence,
          trollingIntelligence: profile.trollingIntelligence||profile.trolling,
          summary: profile.summary
        },
        notes: profile.notes||"",
        status: profile.metadata?.status||'verified',
        requestedBy: "import"
      })
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error||'import failed');
    log(`✔ Imported ${data.lakeName} v${data.version}`);
    alert(`Imported ${data.lakeName} v${data.version}`);
    await loadProfile(data.lakeName);
  } catch (e) {
    log(`✘ Import failed: ${e.message}`);
    alert(`Import failed: ${e.message}`);
  }
}

function openMasterJsonEditor() {
  const card = document.getElementById('masterJsonEditCard');
  const ta = document.getElementById('masterJsonTextarea');
  const st = document.getElementById('masterJsonStatus');
  if (!card || !ta) return;
  if (!currentProfile) {
    alert('No profile currently loaded. Select or load a lake profile first.');
    return;
  }
  card.style.display = 'block';
  ta.value = JSON.stringify(currentProfile, null, 2);
  if (st) st.textContent = '';
  card.scrollIntoView({behavior: 'smooth'});
}

function closeMasterJsonEditor() {
  const card = document.getElementById('masterJsonEditCard');
  if (card) card.style.display = 'none';
}

function formatMasterJsonEditor() {
  const ta = document.getElementById('masterJsonTextarea');
  const st = document.getElementById('masterJsonStatus');
  if (!ta) return;
  try {
    const parsed = JSON.parse(ta.value);
    ta.value = JSON.stringify(parsed, null, 2);
    if (st) {
      st.textContent = 'Formatted ✓';
      st.style.color = 'var(--accent2)';
    }
  } catch (err) {
    alert(`Invalid JSON syntax — cannot format:\n${err.message}`);
    if (st) {
      st.textContent = 'Syntax Error ❌';
      st.style.color = 'var(--bad)';
    }
  }
}

async function saveMasterJsonEditor() {
  const ta = document.getElementById('masterJsonTextarea');
  const st = document.getElementById('masterJsonStatus');
  if (!ta) return;
  let parsed;
  try {
    parsed = JSON.parse(ta.value);
  } catch (err) {
    alert(`Invalid JSON syntax:\n${err.message}`);
    return;
  }
  
  if (st) st.textContent = 'Saving master profile to R2...';
  const lakeName = parsed.lakeName || currentLakeName || document.getElementById('researchLakeSelect')?.value;
  if (!lakeName) {
    alert('Missing lakeName in profile');
    return;
  }

  currentProfile = parsed;
  const parts = {
    identity: parsed.identity,
    limnology: parsed.limnology,
    biology: parsed.biology || parsed.forage,
    forage: parsed.forage || parsed.biology,
    habitat: parsed.habitat,
    navigation: parsed.navigation,
    regulations: parsed.regulations,
    trolling: parsed.trolling || parsed.trollingIntelligence,
    trollingIntelligence: parsed.trollingIntelligence || parsed.trolling,
    summary: parsed.summary
  };
  Object.assign(packagePartsCache, parts);

  try {
    const r = await fetch(`${CF_WORKER_URL}/research/save`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        lakeName,
        profile: parsed,
        packageParts: parts,
        notes: parsed.notes || document.getElementById('researchNotes')?.value || "",
        status: parsed.metadata?.status || 'verified',
        requestedBy: "master-editor"
      })
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'save failed');
    if (st) {
      st.textContent = `✔ Saved v${data.version} successfully!`;
      st.style.color = 'var(--accent2)';
    }
    log(`✔ Directly edited and saved master JSON for ${lakeName} v${data.version}`);
    alert(`Saved ${lakeName} v${data.version} via Master JSON Editor!\nBytes: ${data.bytes}\nOverall Confidence: ${data.overallConfidence}%`);
    await loadProfile(lakeName);
  } catch (e) {
    if (st) {
      st.textContent = `Save failed: ${e.message}`;
      st.style.color = 'var(--bad)';
    }
    alert(`Save failed: ${e.message}`);
  }
}

async function updateSmartPlanBadge(lakeName) {
  // Try fetch enhanced intel and show badge in Plan tab
  try {
    const r = await fetch(`${CF_WORKER_URL}/lake-research?lake=${encodeURIComponent(lakeName)}`);
    if (!r.ok) return;
    const data = await r.json();
    if (data.hasResearchedProfile && data.researched?.status==='verified') {
      const badgeId = 'smartPlanResearchBadge';
      let badge = document.getElementById(badgeId);
      if (!badge) {
        const planCard = document.querySelector('#plan-builder .card');
        if (planCard) {
          badge = document.createElement('div');
          badge.id = badgeId;
          badge.style.cssText = 'background:rgba(118,255,3,.15);border:1px solid var(--accent2);color:#bdffa0;border-radius:8px;padding:8px 10px;font-size:12px;margin:8px 0';
          planCard.prepend(badge);
        }
      }
      if (badge) {
        badge.innerHTML = `🧠 Using Verified Research Profile: <b>${esc(data.researched.lakeName)}</b> v${esc(data.researched.version)} • ${data.researched.overallConfidence?.percent||'?'}% confidence • ${esc(data.researched.status)} • Last: ${data.researched.lastUpdated?.slice(0,10)||''} <span style="float:right"><button id="viewResearchProfileBtn" class="small" style="font-size:10px">View</button></span>`;
        badge.style.display='block';
        document.getElementById('viewResearchProfileBtn')?.addEventListener('click', ()=>{
          document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
          document.querySelectorAll('#bottomNav button').forEach(b=>b.classList.remove('active'));
          document.querySelector('[data-tab=\"research\"]')?.classList.add('active');
          document.getElementById('panel-research')?.classList.add('active');
          loadProfile(lakeName);
        });
      }
    }
  } catch {}
}

function initLakeResearch() {
  populateResearchLakeDropdown();
  setTimeout(populateResearchLakeDropdown, 1500);

  document.getElementById('researchLakeSelect')?.addEventListener('change', (e)=>{
    const v = e.target.value;
    if (v) loadProfile(v);
  });

  document.getElementById('researchLoadBtn')?.addEventListener('click', ()=>{
    const sel = document.getElementById('researchLakeSelect');
    if (sel?.value) loadProfile(sel.value);
    else alert('Select a lake first');
  });

  document.getElementById('researchListBtn')?.addEventListener('click', async ()=>{
    const data = await fetchResearchList();
    if (data) {
      alert(`Found ${data.count} researched lakes:\n${data.lakes.map(l=>`${l.id} (${(l.size/1024).toFixed(1)}KB)`).join('\n')}\n\n${data.versionFiles} version files`);
      // repopulate dropdown with researched lakes too
      const sel = document.getElementById('researchLakeSelect');
      for (const lake of data.lakes) {
        const exists = Array.from(sel.options).some(o=>o.value.toLowerCase().includes(lake.id)||lake.id.includes(o.value.toLowerCase().replace(/[^a-z0-9]/g,'_')));
        if (!exists) {
          const opt = document.createElement('option');
          opt.value = lake.id.replace(/_/g,' ');
          opt.textContent = `📦 ${lake.id} — researched`;
          sel.appendChild(opt);
        }
      }
    }
  });

  document.getElementById('btnResearch')?.addEventListener('click', ()=>{
    const lake = document.getElementById('researchLakeSelect')?.value;
    if (!lake) { alert('Select a lake first'); return; }
    if (!confirm(`Research ${lake}? This will run 8 AI agents (~60 sec) and cost ~8 LLM calls (free tier). Continue?`)) return;
    runResearch(lake);
  });

  document.getElementById('btnRefresh')?.addEventListener('click', ()=>{
    const picker = document.getElementById('refreshPicker');
    if (picker) picker.style.display = picker.style.display==='none'?'block':'none';
  });

  document.getElementById('btnCancelRefresh')?.addEventListener('click', ()=>{
    const picker = document.getElementById('refreshPicker');
    if (picker) picker.style.display='none';
  });

  document.getElementById('btnDoRefresh')?.addEventListener('click', ()=>{
    const lake = document.getElementById('researchLakeSelect')?.value;
    if (!lake) { alert('Select lake'); return; }
    const checked = Array.from(document.querySelectorAll('#refreshPicker input[type=checkbox]:checked')).map(cb=>cb.value);
    if (!checked.length) { alert('Pick at least one section'); return; }
    document.getElementById('refreshPicker').style.display='none';
    runResearch(lake, checked);
  });

  document.getElementById('btnApprove')?.addEventListener('click', approveProfile);
  document.getElementById('btnExport')?.addEventListener('click', exportProfile);
  document.getElementById('researchImportInput')?.addEventListener('change', (e)=>{
    const f = e.target.files[0];
    if (f) importProfile(f);
    e.target.value='';
  });

  document.getElementById('btnSaveNotes')?.addEventListener('click', async ()=>{
    if (!currentProfile) { alert('No profile loaded'); return; }
    const notes = document.getElementById('researchNotes')?.value||'';
    currentProfile.notes = notes;
    const statusEl = document.getElementById('notesStatus');
    if (statusEl) statusEl.textContent='Saving...';
    try {
      const r = await fetch(`${CF_WORKER_URL}/research/save`, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          lakeName: currentProfile.lakeName||currentLakeName,
          profile: currentProfile,
          packageParts: {
            identity: currentProfile.identity,
            limnology: currentProfile.limnology,
            biology: currentProfile.biology||currentProfile.forage,
            habitat: currentProfile.habitat,
            navigation: currentProfile.navigation,
            regulations: currentProfile.regulations,
            trolling: currentProfile.trolling||currentProfile.trollingIntelligence,
            summary: currentProfile.summary
          },
          notes,
          status: currentProfile.metadata?.status||'draft'
        })
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error);
      if (statusEl) statusEl.textContent=`Saved v${data.version} ✓`;
      setTimeout(()=>{ if (statusEl) statusEl.textContent=''; }, 2000);
      log(`Notes saved v${data.version}`);
    } catch (e) {
      if (statusEl) statusEl.textContent=`Failed: ${e.message}`;
      log(`Notes save failed: ${e.message}`);
    }
  });

  document.getElementById('btnApproveReview')?.addEventListener('click', ()=>saveProfile('verified'));
  document.getElementById('btnSaveDraft')?.addEventListener('click', ()=>saveProfile('draft'));

  document.getElementById('btnDebugProfile')?.addEventListener('click', ()=>{
    const out = document.getElementById('debugOutput');
    if (!out) return;
    out.style.display = out.style.display==='none'?'block':'none';
    if (currentProfile) out.textContent = JSON.stringify(currentProfile, null, 2);
    else out.textContent = 'No profile loaded\npackagePartsCache:\n'+JSON.stringify(packagePartsCache, null, 2);
  });

  document.getElementById('btnClearResearchCache')?.addEventListener('click', ()=>{
    researchLog=[];
    const el = document.getElementById('researchLog');
    if (el) el.textContent='Log cleared';
    showProgress(false);
  });

  document.getElementById('btnEditMasterJson')?.addEventListener('click', openMasterJsonEditor);
  document.getElementById('btnCloseMasterJson')?.addEventListener('click', closeMasterJsonEditor);
  document.getElementById('btnFormatMasterJson')?.addEventListener('click', formatMasterJsonEditor);
  document.getElementById('btnSaveMasterJson')?.addEventListener('click', saveMasterJsonEditor);

  // Smart Plan auto-check when lake changes
  const planLake = document.getElementById('planLake');
  if (planLake) {
    planLake.addEventListener('change', (e)=>{
      if (e.target.value) updateSmartPlanBadge(e.target.value);
    });
  }

  // Also check on tab switch to research
  document.querySelector('[data-tab=\"research\"]')?.addEventListener('click', ()=>{
    populateResearchLakeDropdown();
  });

  console.log('🧠 Lake Research module ready');
}

// Load after delay to ensure DOM ready
setTimeout(initLakeResearch, 800);

export { initLakeResearch, loadProfile, runResearch, populateResearchLakeDropdown };
