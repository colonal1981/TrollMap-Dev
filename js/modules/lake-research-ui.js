import { state, CF_WORKER_URL } from '../core/state.js';
import { _state, runFullPipeline, runResume, validateExistingFacts, recoverSmartPlanFacts, deriveGeospatialStructureFacts, RESEARCH_ORDER, RESEARCH_LABELS, cloneJson, hasResearchValue, sanitize, sanitizeStateFromLakeName, log, renderLog } from './lake-research-engine.js';


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
    log('Resolving contradictions according to operator choices...');

    if (!_state.currentProfile || !_state.currentLakeName) {
      log('⚠️ No profile loaded — cannot apply resolutions.');
      return;
    }

    // Deep-set a value at a dot-path in an object, creating intermediate objects as needed
    function setAtPath(obj, path, value) {
      const parts = path.split('.');
      let cursor = obj;
      for (let i = 0; i < parts.length - 1; i++) {
        if (cursor[parts[i]] == null || typeof cursor[parts[i]] !== 'object') {
          cursor[parts[i]] = {};
        }
        cursor = cursor[parts[i]];
      }
      cursor[parts[parts.length - 1]] = value;
    }

    const patched = cloneJson(_state.currentProfile);
    let resolvedCount = 0;

    contradictions.forEach((c, index) => {
      const radio = el.querySelector(`input[name="conflict-${index}"]:checked`);
      if (!radio) return;
      const selected = radio.value;
      const winner = selected === 'A' ? c.factA : c.factB;
      const winnerSource = selected === 'A' ? c.sourceA : c.sourceB;
      log(`  [${c.field}] → Option ${selected}: "${winner}" (${winnerSource || 'unknown source'})`);

      // Apply to the correct nested path in the profile
      // c.field may be dot-notation (e.g. "limnology.thermocline.summerDepthFt")
      // or a flat key — handle both
      try {
        // Map contradiction category names to actual profile field paths
        const fieldMap = {
          'surfaceArea':      'surfaceAreaAcres',
          'maxDepthFt':       'maxDepthFt',
          'averageDepthFt':   'averageDepthFt',
          'sizeLimit_lakeSpecific': 'regulations.lakeSpecificRegulations.sizeLimits',
          'creelLimit_lakeSpecific': 'regulations.lakeSpecificRegulations.creelLimits',
        };
        const profilePath = fieldMap[c.field] || c.field;

        // For numeric fields, extract the number from the fact sentence
        const numericFields = new Set(['surfaceAreaAcres','maxDepthFt','averageDepthFt','hydraulicRetentionDays','normalPoolFt']);
        let valueToSet = winner;
        if (numericFields.has(profilePath)) {
          const numMatch = winner.match(/[\d,]+(?:\.\d+)?/);
          if (numMatch) {
            valueToSet = parseFloat(numMatch[0].replace(/,/g,''));
          }
        }

        setAtPath(patched, profilePath, valueToSet);
        resolvedCount++;
      } catch (e) {
        log(`  ⚠️ Could not apply ${c.field}: ${e.message}`);
      }
    });

    if (resolvedCount === 0) {
      log('No resolutions applied.');
      return;
    }

    // Stamp the patch in metadata
    patched.metadata = patched.metadata || {};
    patched.metadata.lastResolvedAt = new Date().toISOString();
    patched.metadata.resolvedContradictions = (patched.metadata.resolvedContradictions || 0) + resolvedCount;

    // Write back to in-memory state
    _state.currentProfile = patched;

    // POST to /research/save
    log(`Saving resolved profile (${resolvedCount} field(s) patched)...`);
    try {
      const res = await fetch(`${CF_WORKER_URL}/research/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lakeName: _state.currentLakeName,
          profile: patched,
          status: patched.metadata?.status || 'draft',
          approve: patched.metadata?.status === 'verified',
          verified: patched.metadata?.status === 'verified',
          requestedBy: 'Contradiction Resolution UI'
        })
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => '');
        throw new Error(`Save failed: ${res.status} ${msg.slice(0, 200)}`);
      }
      log(`✔ Resolved profile saved to R2.`);
      el.style.display = 'none';
      // Silent reload to re-render with resolved values
      await loadProfile(_state.currentLakeName, true);
    } catch (e) {
      log(`✗ Save failed: ${e.message}`);
    }
  });
}

async function populateResearchLakeDropdown() {
  const sel = document.getElementById('researchLakeSelect');
  if (!sel) return;

  // Research deliberately shares the exact worker-backed access index used by
  // the map/plan pickers. Do not merge LAKE_DB here: static aliases create
  // alternate R2 IDs for the same lake and defeat the canonical dropdown.
  let lakes = [];
  try {
    // access-index.js owns the shared in-flight load and exposes this global
    // for legacy modules. Do not import it here: deployment layouts may serve
    // research modules from a different asset base than access-index.js.
    if (window.getUniversalLakeNamesAsync) lakes = await window.getUniversalLakeNamesAsync();
    else if (window.getUniversalLakeNames) lakes = window.getUniversalLakeNames();
  } catch (err) {
    console.warn('[research] Unable to load the shared access index:', err);
  }

  const current = sel.value;
  const placeholder = Array.from(sel.options).find(o => !o.value);
  sel.replaceChildren();
  sel.appendChild(placeholder || new Option('Select a lake…', ''));
  for (const name of lakes) sel.appendChild(new Option(name, name));
  if (lakes.includes(current)) sel.value = current;
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
  _state.currentLakeName = lakeName;
  if (!silent) log(`Loading profile for ${lakeName}...`);
  try {
    const r = await fetch(`${CF_WORKER_URL}/research/get?lake=${encodeURIComponent(lakeName)}`);
    const data = await r.json();
    if (!data.ok) {
      if (!silent) log(`No profile yet for ${lakeName}: ${data.error || 'not found'}`);
      renderEmpty(lakeName);
      return null;
    }
    _state.currentProfile = data.profile;
    _state.currentPackageFiles = data.packageFiles || [];
    _state.currentVersions = data.versions || [];
    window.TROLLMAP_RESEARCHED_CACHE[lakeName] = _state.currentProfile;
    window.TROLLMAP_RESEARCHED_CACHE[data.sanitized] = _state.currentProfile;
    if (_state.currentProfile?.metadata?.status === 'verified') {
      window.TROLLMAP_RESEARCHED_CACHE[`${lakeName}_verified`] = _state.currentProfile;
    }
    if (!silent) log(`Loaded ${lakeName} v${_state.currentProfile?.metadata?.version} status=${_state.currentProfile?.metadata?.status} overall=${_state.currentProfile?.confidence?.overall?.percent}%`);
    renderProfile(_state.currentProfile);
    return _state.currentProfile;
  } catch (e) {
    log(`Load failed: ${e.message}`);
    renderEmpty(lakeName);
    return null;
  }
}

function renderEmpty(lakeName) {
  _state.currentProfile = null;
  const meta = document.getElementById('researchMeta');
  if (meta) meta.style.display = 'none';
  document.getElementById('researchSections').innerHTML = `<div class="muted" style="padding:10px">No profile yet for <b>${esc(lakeName)}</b>. Click Research to build one. Factual pipeline first (official pages, GIS, WQP), then quoted document extraction for anything else.</div>`;
  for (const id of ['sourcesCard', 'summaryCard', 'notesCard', 'packageCard']) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
  const approveBtn = document.getElementById('btnApprove');
  if (approveBtn) approveBtn.style.display = 'none';
  const deleteBtn = document.getElementById('btnDeleteResearch');
  if (deleteBtn) deleteBtn.style.display = 'none';
}

function esc(s) { return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function renderProfile(profile) {
  if (!profile) { renderEmpty(_state.currentLakeName); return; }
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
  const deleteBtn = document.getElementById('btnDeleteResearch');
  if (deleteBtn) {
    deleteBtn.style.display = 'inline-flex';
  }

  // Store merged profile and parts in _state for section editors
  _state.mergedProfile = cloneJson(profile);
  const parts = {};
  for (const key of RESEARCH_ORDER) {
    if (key === 'identity') parts[key] = profile.identity || {};
    else if (key === 'biology') parts[key] = profile.forage || profile.biology || {};
    else if (key === 'fisheries') parts[key] = profile.trollingIntelligence || profile.trolling || {};
    else parts[key] = profile[key] || {};
  }
  _state.profileParts = parts;

  renderSections(profile);
  renderSources(profile);
  renderSummary(profile);
  renderNotes(profile);
  renderPackage(profile, _state.currentPackageFiles, _state.currentVersions);
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
      <div><b>County/Counties:</b> ${esc(Array.isArray(d.counties) ? d.counties.join(', ') : (d.county || '—'))}</div>
      <div><b>River System:</b> ${esc(d.riverSystem || '—')}</div>
      <div><b>Reservoir Owner:</b> ${esc(d.reservoirOwner || '—')}</div>
      <div><b>Surface Area:</b> ${d.surfaceAreaAcres ? `${Number(d.surfaceAreaAcres).toLocaleString()} acres${d._geometryDerived ? ' 🗺️' : ''}` : '—'}</div>
      <div><b>Max Depth:</b> ${d.maxDepthFt ? `${d.maxDepthFt} ft${d._geometryDerived ? ' 🗺️' : ''}` : '—'}</div>
      <div><b>Average Depth:</b> ${d.averageDepthFt ? `${d.averageDepthFt} ft${d._geometryDerived ? ' 🗺️' : ''}` : '—'}${d._geometryDerived && d._bathymetryMeta?.coverage ? `<span class="muted" style="font-size:10px;margin-left:4px">(${Math.round(d._bathymetryMeta.coverage*100)}% bathy coverage)</span>` : ''}</div>
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
    const sw = d.surfaceWater || {};
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
        <b>🌡 Surface Monitoring</b><br>
        Temp: <b>${sw.recentTempF != null ? `${sw.recentTempF} °F` : '—'}</b><br>
        DO: <b>${sw.recentDissolvedOxygenMgL != null ? `${sw.recentDissolvedOxygenMgL} mg/L` : '—'}</b><br>
        Turbidity: <b>${sw.recentTurbidityNTU != null ? `${sw.recentTurbidityNTU} NTU` : '—'}</b><br>
        ${sw.lastObserved ? `<span class="muted" style="font-size:11px">Last observed: ${esc(sw.lastObserved)}</span>` : ''}
      </div>
      <div style="background:rgba(255,255,255,.03);padding:6px;border-radius:6px">
        <b>🌡 Summer Thermocline</b><br>
        Depth: <b>${Array.isArray(th.summerDepthFt) ? `${th.summerDepthFt.join(' - ')} ft` : (th.summerDepthFt || '—')}</b>${th.method ? ` (${esc(th.method)})` : ''}<br>
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
    if (Array.isArray(d.knownStockings) && d.knownStockings.length) {
      html += `<div style="background:rgba(255,255,255,.03);padding:6px;border-radius:6px;grid-column:1/-1">
        <b>🐣 Documented Stocking / Management Notes</b><br>`;
      d.knownStockings.forEach(s => {
        if (typeof s === 'string') {
          html += `• <b>${esc(s)}</b><br>`;
        } else {
          html += `• <b>${esc(s.species || '—')}</b>${s.quantity ? ` — ${esc(String(s.quantity))} stocked` : ''}${s.year ? ` (${esc(String(s.year))})` : ''}${s.location ? ` at ${esc(s.location)}` : ''}${s.agency ? ` (${esc(s.agency)})` : ''}${s.note ? ` — ${esc(s.note)}` : ''}<br>`;
        }
      });
      html += `</div>`;
    }
    if (d.speciesBehavior && Object.keys(d.speciesBehavior).length) {
      const SEASONS = ['spring','summer','fall','winter'];
      const SEASON_EMOJI = { spring: '🌸', summer: '☀️', fall: '🍂', winter: '❄️' };
      html += `<div style="background:rgba(255,255,255,.03);padding:6px;border-radius:6px;grid-column:1/-1">
        <b>🧠 Species Behavior (Lake-Specific)</b>`;
      for (const [species, data] of Object.entries(d.speciesBehavior)) {
        html += `<div style="margin:6px 0 2px;font-weight:600">${esc(species)}</div>`;
        html += `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:4px">`;
        SEASONS.forEach(season => {
          const s = data[season];
          if (!s) return;
          const depth = Array.isArray(s.depthRange) ? `${s.depthRange[0]}–${s.depthRange[1]}ft` : null;
          const structs = Array.isArray(s.structure) ? s.structure.slice(0,2).join(', ') : null;
          html += `<div style="background:rgba(255,255,255,.04);padding:4px;border-radius:4px;font-size:11px">
            <b>${SEASON_EMOJI[season]} ${season.charAt(0).toUpperCase()+season.slice(1)}</b><br>
            ${depth ? `📏 ${esc(depth)}<br>` : ''}
            ${structs ? `🏗 ${esc(structs)}<br>` : ''}
            ${s.notes ? `<span style="color:var(--muted)">${esc(s.notes.slice(0,80))}</span>` : ''}
          </div>`;
        });
        if (data.lakeSpecificNotes) html += `<div style="grid-column:1/-1;font-size:11px;color:var(--muted);margin-top:2px">📌 ${esc(data.lakeSpecificNotes)}</div>`;
        html += `</div>`;
      }
      html += `</div>`;
    }
    if (d.spawnTiming && Object.keys(d.spawnTiming).length) {
      html += `<div style="background:rgba(255,255,255,.03);padding:6px;border-radius:6px;grid-column:1/-1">
        <b>🥚 Spawn Timing</b><br>${Object.entries(d.spawnTiming).map(([species, timing]) => `<b>${esc(species)}:</b> ${esc(timing)}<br>`).join('')}</div>`;
    }
    if (d.forageSpatial) {
      html += `<div style="background:rgba(255,255,255,.03);padding:6px;border-radius:6px;grid-column:1/-1">
        <b>🦐 Forage Concentration</b><br>${esc(d.forageSpatial)}</div>`;
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
    const castingFields = [
      ['🪨 Riprap Locations', d.riprapLocations],
      ['🌊 Named Creek Mouths / Arms', d.namedCreekMouths],
      ['🌲 Timber Fields', d.timberFields],
      ['🏖 Shallow Flats / Coves', d.shallowFlatAreas]
    ];
    const hasCasting = castingFields.some(([, value]) => Array.isArray(value) ? value.length : value);
    if (hasCasting) {
      html += `<div style="background:rgba(70,130,180,.10);padding:6px;border-radius:6px;grid-column:1/-1">
        <b>🎯 Casting Structure & Location Targets</b><br>
        ${castingFields.filter(([, value]) => Array.isArray(value) ? value.length : value).map(([label, value]) => `<div style="margin-top:3px"><b>${label}:</b> ${esc(Array.isArray(value) ? value.join('; ') : value)}</div>`).join('')}
      </div>`;
    }
    if (d.artificialHabitatDetails?.attractorCount || (Array.isArray(d.artificialHabitatDetails?.attractorTypes) && d.artificialHabitatDetails.attractorTypes.length)) {
      html += `<div style="background:rgba(255,255,255,.03);padding:6px;border-radius:6px">
        <b>🧱 Artificial Habitat</b><br>
        Attractor Count: ${esc(d.artificialHabitatDetails?.attractorCount ?? '—')}<br>
        Types: ${esc((d.artificialHabitatDetails?.attractorTypes || []).join(', ') || '—')}
      </div>`;
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
    html += `<div style="margin-bottom:8px"><b>📍 State:</b> ${esc(d.state || '—')}${d.lastUpdated ? ` · <span class="muted">Updated ${esc(d.lastUpdated)}</span>` : ''}</div>`;

    // Helper: render species → {size, creel} rows from nested maps
    const renderSpeciesTable = (lengthMap, creelMap, emptyLabel) => {
      const lengthMapSafe = (lengthMap && typeof lengthMap === 'object') ? lengthMap : {};
      const creelMapSafe = (creelMap && typeof creelMap === 'object') ? creelMap : {};
      const species = [...new Set([...Object.keys(lengthMapSafe), ...Object.keys(creelMapSafe)])];
      if (!species.length) return `<div class="muted" style="font-size:11px">${esc(emptyLabel || 'No limits extracted')}</div>`;
      let out = `<div style="display:grid;grid-template-columns:1.2fr 1fr 1fr;gap:2px 8px;margin-top:4px;font-size:11px">
        <div class="muted" style="font-weight:700">Species</div>
        <div class="muted" style="font-weight:700">Size Limit</div>
        <div class="muted" style="font-weight:700">Creel / Possession</div>`;
      for (const sp of species.sort((a, b) => a.localeCompare(b))) {
        const sizeVal = lengthMapSafe[sp];
        const creelVal = creelMapSafe[sp];
        out += `<div><b>${esc(sp)}</b></div>
          <div>${esc(sizeVal != null && sizeVal !== '' ? String(sizeVal) : '—')}</div>
          <div>${esc(creelVal != null && creelVal !== '' ? String(creelVal) : '—')}</div>`;
      }
      out += `</div>`;
      return out;
    };

    const gen = d.generalStateRegulations || d.statewide || {};
    const genLength = gen.lengthLimits || d.lengthLimits || {};
    const genCreel = gen.creelLimits || d.creelLimits || {};
    const hasGen = (gen && typeof gen === 'object' && (Object.keys(genLength).length || Object.keys(genCreel).length || Object.keys(gen).some(k => k !== 'lengthLimits' && k !== 'creelLimits' && gen[k])));
    if (hasGen || Object.keys(genLength).length || Object.keys(genCreel).length) {
      html += `<div style="background:rgba(255,255,255,.03);padding:8px;border-radius:6px;margin-bottom:8px">
        <b>📋 General State Regulations</b>`;
      html += renderSpeciesTable(genLength, genCreel, 'No statewide limits parsed');
      // Any leftover non-map fields
      for (const [k, v] of Object.entries(gen)) {
        if (k === 'lengthLimits' || k === 'creelLimits') continue;
        if (v == null || v === '' || (typeof v === 'object' && !Object.keys(v).length)) continue;
        html += `<div style="margin:3px 0;font-size:11px">• <b>${esc(k)}:</b> ${esc(typeof v === 'string' ? v : JSON.stringify(v))}</div>`;
      }
      html += `</div>`;
    }

    const lake = d.lakeSpecificRegulations || d.lakeSpecific || {};
    const lakeSize = lake.sizeLimits || {};
    const lakeCreel = lake.creelLimits || {};
    const lakeHasContent = (lake && typeof lake === 'object') && (
      lake.hasExceptions ||
      Object.keys(lakeSize).length ||
      Object.keys(lakeCreel).length ||
      (Array.isArray(lake.closedSeasons) && lake.closedSeasons.length) ||
      (Array.isArray(lake.specialRules) && lake.specialRules.length) ||
      (Array.isArray(lake._raw) && lake._raw.length)
    );
    if (lakeHasContent) {
      html += `<div style="background:rgba(0,229,255,.05);padding:8px;border-radius:6px;border:1px solid var(--accent);margin-bottom:8px">
        <b>🎯 Lake-Specific Regulations</b> ${lake.hasExceptions ? '<span style="color:var(--accent2)">(Has exceptions!)</span>' : ''}`;
      html += renderSpeciesTable(lakeSize, lakeCreel, 'No lake-specific creel/size exceptions');
      if (Array.isArray(lake.closedSeasons) && lake.closedSeasons.length) {
        html += `<div style="margin-top:8px"><b style="color:#ff7043">🚫 Closed Seasons</b>`;
        lake.closedSeasons.forEach(c => {
          if (typeof c === 'string') {
            html += `<div style="margin:2px 0;font-size:11px">• ${esc(c)}</div>`;
          } else {
            html += `<div style="margin:2px 0;font-size:11px">• <b>${esc(c.species || 'Species')}</b>: ${esc(c.period || '')}${c.times ? ` (${esc(c.times)})` : ''}${c.note ? ` — <span class="muted">${esc(c.note)}</span>` : ''}</div>`;
          }
        });
        html += `</div>`;
      }
      if (Array.isArray(lake.specialRules) && lake.specialRules.length) {
        html += `<div style="margin-top:6px"><b>📌 Special Rules</b>`;
        lake.specialRules.forEach(r => {
          html += `<div style="margin:2px 0;font-size:11px">• ${esc(typeof r === 'string' ? r : JSON.stringify(r))}</div>`;
        });
        html += `</div>`;
      }
      if (lake._raw && Array.isArray(lake._raw)) {
        lake._raw.forEach(r => { html += `<div style="margin:2px 0;color:var(--muted);font-size:11px">• ${esc(r)}</div>`; });
      }
      html += `</div>`;
    } else if (!hasGen && !Object.keys(genLength).length) {
      // Nothing parsed — show empty state so UI doesn't look broken
      html += `<div class="muted" style="padding:8px;background:rgba(255,82,82,.05);border-radius:6px;margin-bottom:8px">
        No regulations data extracted yet. Re-run research (or Resume from normalized) after the eRegulations parser fix so statewide + lake-specific limits populate here.
      </div>`;
    }

    // Flat convenience fields if present and not already covered
    if (d.licenseRequirements) {
      html += `<div style="margin:4px 0;font-size:11px"><b>🪪 License:</b> ${esc(d.licenseRequirements)}</div>`;
    }
    if (Array.isArray(d.protectedSpecies) && d.protectedSpecies.length) {
      html += `<div style="margin:4px 0;font-size:11px"><b>🛡️ Protected:</b> ${esc(d.protectedSpecies.join(', '))}</div>`;
    }
    if (d.notes) html += `<div style="margin-top:6px"><b>📝 Notes:</b> ${esc(d.notes)}</div>`;
    if (d.sourceUrl) html += `<div class="muted" style="margin-top:4px;font-size:10px">Source: <a href="${esc(d.sourceUrl)}" target="_blank" rel="noopener" style="color:var(--accent)">${esc(d.sourceUrl)}</a></div>`;
    html += `</div>`;
    return html;
  }

  if (key === 'fisheries') {
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
      // Check if this is the new per-species seasonal format
      const isSpeciesSeasonal = remaining.every(([k, v]) =>
        typeof v === 'object' && v !== null &&
        ['summer','fall','winter','spring'].some(s => s in v)
      );
      if (isSpeciesSeasonal) {
        const SEASONS = ['spring','summer','fall','winter'];
        const SEASON_EMOJI = { spring: '🌸', summer: '☀️', fall: '🍂', winter: '❄️' };
        remaining.forEach(([species, seasons]) => {
          html += `<div style="margin:8px 0;background:rgba(255,255,255,.04);border-radius:6px;padding:8px">`;
          html += `<div style="font-weight:700;margin-bottom:6px">🐟 ${esc(species)}</div>`;
          html += `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:6px">`;
          SEASONS.forEach(season => {
            const s = seasons[season];
            if (!s) return;
            const depth = Array.isArray(s.preferredDepth) ? `${s.preferredDepth[0]}–${s.preferredDepth[1]}ft` : (s.preferredDepth || '—');
            const structs = Array.isArray(s.structures) ? s.structures.slice(0,3).join(', ') : (s.structures || '');
            const forage = Array.isArray(s.forage) ? s.forage.join(', ') : (s.forage || '');
            const pres = Array.isArray(s.recommendedPresentations) ? s.recommendedPresentations.slice(0,2).join(', ') : '';
            html += `<div style="background:rgba(255,255,255,.04);padding:6px;border-radius:4px">
              <div style="font-weight:600;margin-bottom:3px">${SEASON_EMOJI[season]} ${season.charAt(0).toUpperCase()+season.slice(1)}</div>
              ${depth ? `<div style="font-size:11px">📏 ${esc(depth)}</div>` : ''}
              ${structs ? `<div style="font-size:11px">🏗 ${esc(structs)}</div>` : ''}
              ${forage ? `<div style="font-size:11px">🦟 ${esc(forage)}</div>` : ''}
              ${pres ? `<div style="font-size:11px;color:var(--accent2)">🎣 ${esc(pres)}</div>` : ''}
              ${s.notes ? `<div style="font-size:10px;color:var(--muted);margin-top:3px">${esc(s.notes)}</div>` : ''}
            </div>`;
          });
          html += `</div></div>`;
        });
      } else {
        // Original fallback — raw key/value
        remaining.forEach(([k, v]) => {
          html += `<div style="margin:3px 0"><b>${esc(k)}:</b> ${esc(typeof v === 'string' ? v : JSON.stringify(v))}</div>`;
        });
      }
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
  let html = '';
  for (const key of RESEARCH_ORDER) {
    const label = RESEARCH_LABELS[key] || key;
    let sectionData;
    if (key === 'identity') {
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
      sectionData = profile[key] || (key === 'biology' ? profile.forage : '') || (key === 'fisheries' ? (profile.trollingIntelligence || profile.trolling) : null) || {};
    }
    const has = !!(key === 'identity'
      ? (profile.identity || profile.lakeName)
      : (profile[key] || (key === 'biology' ? profile.forage : null) || (key === 'fisheries' ? (profile.trollingIntelligence || profile.trolling) : null)));
    const okIcon = has ? '✔' : '◻';

    html += `<div class="section-row" style="flex-wrap:wrap;justify-content:space-between;align-items:center;">
      <div style="display:flex;align-items:center;gap:8px;flex:1 1 200px;">
        <span class="sec-icon">${okIcon}</span>
        <span class="sec-name"><b>${label}</b></span>
      </div>
      <div style="display:flex;align-items:center;gap:10px;">
        ${has ? `<button type="button" class="small ghost btn-toggle-viewer" data-section="${key}" style="font-size:10px;padding:2px 6px;color:var(--accent)">👁️ View Summary</button>` : ''}
        <button type="button" class="small ghost btn-toggle-section-editor" data-section="${key}" style="font-size:10px;padding:2px 6px;">✏️ Edit JSON</button>
      </div>
    </div>
    
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
    btn.addEventListener('click', async (e) => {
      const agent = e.target.dataset.agent;
      const ta = container.querySelector(`.review-section-textarea[data-agent="${agent}"]`);
      const st = document.getElementById(`edit-status-${agent}`);
      if (!ta || !_state.mergedProfile) return;
      try {
        const parsed = JSON.parse(ta.value);
        const curMerged = _state.mergedProfile ? cloneJson(_state.mergedProfile) : {};
        const curParts = _state.profileParts ? cloneJson(_state.profileParts) : {};
        curMerged[agent] = parsed;
        if (agent === 'biology') curMerged.forage = parsed;
        if (agent === 'fisheries') curMerged.trollingIntelligence = parsed;
        curParts[agent] = parsed;
        _state.mergedProfile = curMerged;
        _state.profileParts = curParts;
        if (typeof _state.packagePartsCache !== 'undefined') _state.packagePartsCache[agent] = parsed;
        // Refresh viewer
        const viewer = document.getElementById(`viewer-container-${agent}`);
        if (viewer) viewer.innerHTML = formatHumanReadableSection(agent, parsed);

        // ── Save to R2 via worker so edits persist ────────────────────────
        // Build the full profile from merged state and save it. This mirrors
        // the master JSON save flow so individual section edits are committed
        // to the same R2 key that loadProfile reads from.
        if (_state.currentLakeName && _state.currentProfile) {
          if (st) { st.textContent = 'Saving…'; st.style.color = 'var(--accent)'; }
          try {
            const fullProfile = cloneJson(_state.currentProfile);
            // Merge the edited section into the full profile so un-edited
            // sections are preserved on save.
            fullProfile[agent] = parsed;
            if (agent === 'biology') fullProfile.forage = parsed;
            if (agent === 'fisheries') fullProfile.trollingIntelligence = parsed;
            const res = await fetch(`${CF_WORKER_URL}/research/save`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                lakeName: _state.currentLakeName,
                profile: fullProfile,
                status: fullProfile?.metadata?.status || _state.currentProfile?.metadata?.status || 'draft',
                approve: fullProfile?.metadata?.status === 'verified',
                verified: fullProfile?.metadata?.status === 'verified',
                notes: fullProfile?.notes || '',
                requestedBy: `Section edit: ${agent}`
              })
            });
            if (!res.ok) {
              const msg = await res.text().catch(() => '');
              throw new Error(`HTTP ${res.status}: ${msg.slice(0, 200)}`);
            }
            // Update the in-memory currentProfile so subsequent saves/loads are consistent
            _state.currentProfile = fullProfile;
            if (st) { st.textContent = 'Applied & saved ✓'; st.style.color = 'var(--accent2)'; }
            log(`✔ Section [${agent}] edited and saved to R2 for ${_state.currentLakeName}`);
          } catch (saveErr) {
            if (st) { st.textContent = 'Applied (save failed)'; st.style.color = 'var(--bad)'; }
            log(`⚠️ Section [${agent}] applied in-memory but save to R2 failed: ${saveErr.message}`);
          }
        } else {
          if (st) { st.textContent = 'Applied ✓'; st.style.color = 'var(--accent2)'; }
        }
      } catch (err) {
        if (st) { st.textContent = 'Invalid JSON'; st.style.color = 'var(--bad)'; }
      }
    });
  });
}



function renderSources(profile) {
  const card = document.getElementById('sourcesCard');
  const list = document.getElementById('sourcesList');
  if (!card || !list) return;
  const sources = profile.sources || [];
  if (!sources.length) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  let html = '';
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    if (!s || (!s.label && !s.url)) continue; // skip fully blank entries
    const trust = s.trust || '';
    const trustColor = trust.includes('OFFICIAL') ? 'var(--accent2)' : trust.includes('DERIVED') ? 'var(--accent)' : 'var(--muted)';
    // Only show delete button for real HTTP(S) URLs that could be in the normalized cache
    // Internal/GIS sources (worker://, internal:) are not in normalized_documents.json
    const isDeletable = s.url && /^https?:\/\//i.test(s.url);
    const deleteBtn = isDeletable
      ? `<button data-idx="${i}" data-url="${esc(s.url)}" class="del-norm-doc" title="Remove from normalized cache" style="margin-left:8px;padding:1px 6px;font-size:10px;background:transparent;border:1px solid var(--line);border-radius:4px;color:var(--muted);cursor:pointer">✕ cache</button>`
      : '';
    html += `<div class="source-item" style="display:flex;align-items:center;gap:4px;flex-wrap:wrap"><span style="display:inline-block;padding:1px 6px;border-radius:10px;background:var(--panel2);border:1px solid var(--line);font-size:10px;color:${trustColor};margin-right:4px">${esc(trust || 'SOURCE')}</span><b>${esc(s.label || 'Unlabeled')}</b>${s.url && s.url !== '#' ? ` — <a href="${esc(s.url)}" target="_blank" rel="noopener" style="color:var(--accent)">${esc(s.url.slice(0, 60))}</a>` : ''}${deleteBtn}</div>`;
  }
  list.innerHTML = html;

  // Wire delete buttons
  list.querySelectorAll('.del-norm-doc').forEach(btn => {
    btn.addEventListener('click', async () => {
      const docUrl = btn.dataset.url;
      const lakeName = _state.currentLakeName;
      if (!lakeName || !docUrl) return;
      if (!confirm(`Remove this document from the normalized cache for ${lakeName}?\n\n${docUrl}\n\nThis does not affect the saved profile — only the cached fetch.`)) return;
      btn.disabled = true;
      btn.textContent = '…';
      try {
        const res = await fetch(`${CF_WORKER_URL}/research/delete-normalized-doc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lakeName, url: docUrl })
        });
        const data = await res.json();
        if (data.ok) {
          btn.closest('.source-item').style.opacity = '0.4';
          btn.textContent = '✓ removed';
        } else {
          btn.textContent = '✕ error';
          btn.title = data.error || 'failed';
          btn.disabled = false;
        }
      } catch (e) {
        btn.textContent = '✕ error';
        btn.title = e.message;
        btn.disabled = false;
      }
    });
  });
}

function renderSummary(profile) {
  const card = document.getElementById('summaryCard');
  const textEl = document.getElementById('summaryText');
  if (!card || !textEl) return;
  const summary = profile.summary?.text || profile.summary || '';
  const summaryText = typeof summary === 'string' ? summary : (summary.text || JSON.stringify(summary, null, 2));
  const biology = profile.biology || profile.forage || {};
  const habitat = profile.habitat || {};
  const casting = [];
  const add = (label, value) => {
    if (Array.isArray(value) && value.length) casting.push(`${label}: ${value.join('; ')}`);
    else if (value != null && String(value).trim()) casting.push(`${label}: ${value}`);
  };
  add('Riprap', habitat.riprapLocations);
  add('Creek mouths/arms', habitat.namedCreekMouths);
  add('Timber fields', habitat.timberFields);
  add('Docks', habitat.dockDensity);
  add('Shallow flats/coves', habitat.shallowFlatAreas);
  add('Forage locations', biology.forageSpatial);
  if (Object.keys(biology.spawnTiming || {}).length) add('Spawn timing', Object.entries(biology.spawnTiming).map(([k,v]) => `${k}: ${v}`).join('; '));
  const castingHtml = casting.length ? `<div style="margin-top:10px;padding:8px;border-left:3px solid var(--accent);background:rgba(255,255,255,.03)"><b>🎯 Casting targets</b><br>${casting.map(esc).join('<br>')}</div>` : '';
  if (!summaryText && !casting.length) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  textEl.innerHTML = `${summaryText ? `<div style="white-space:pre-wrap">${esc(summaryText)}</div>` : ''}${castingHtml}`;
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

  const lakeName = profile.lakeName || _state.currentLakeName;
  const safeKey = sanitize(lakeName);

  if (filesEl) {
    let html = `<div style="font-size:11px;color:var(--muted)">Master: lakes/${safeKey}.json (${JSON.stringify(profile).length} bytes)<br>Package folder: lake_packages/${safeKey}/</div><div style="display:flex;flex-wrap:wrap;gap:4px;margin:8px 0">`;
    for (const f of (packageFiles || [])) {
      html += `<span class="pill pkg-file-btn" data-file="${esc(f.name)}" title="${esc(f.key)}" style="cursor:pointer;text-decoration:underline dotted">${esc(f.name)} ${f.size ? `(${(f.size / 1024).toFixed(1)}KB)` : ''}</span>`;
    }
    html += `</div>`;
    filesEl.innerHTML = html;

    filesEl.querySelectorAll('.pkg-file-btn').forEach(btn => {
      btn.addEventListener('click', () => openPackageFile(lakeName, btn.dataset.file));
    });
  }

  if (verEl) {
    let html = `<div style="font-size:12px;font-weight:700;margin-bottom:4px">Version History (${(versions || []).length})</div>`;
    if (!versions || !versions.length) html += `<div class="muted" style="font-size:11px">No prior versions yet. First save creates v1.</div>`;
    else {
      html += `<div style="font-size:11px">`;
      for (const v of versions) {
        const vfile = v.key.split('/').pop();
        html += `<div>• <span class="pkg-ver-btn" data-file="${esc(vfile)}" data-key="${esc(v.key)}" style="cursor:pointer;color:var(--accent);text-decoration:underline dotted">${esc(v.key)}</span> ${v.size ? `— ${(v.size / 1024).toFixed(1)}KB` : ''}</div>`;
      }
      html += `</div>`;
    }
    verEl.innerHTML = html;

    verEl.querySelectorAll('.pkg-ver-btn').forEach(btn => {
      btn.addEventListener('click', () => openVersionFile(lakeName, btn.dataset.file));
    });
  }
}

async function openPackageFile(lakeName, filename) {
  const modal = ensureJsonModal();
  modal.setTitle(`${filename} — ${lakeName}`);
  modal.show('Loading…');
  try {
    const res = await fetch(`${CF_WORKER_URL}/research/package?lake=${encodeURIComponent(lakeName)}&file=${encodeURIComponent(filename)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();

    // normalized_documents.json is huge — render as a doc list with delete buttons
    if (filename === 'normalized_documents.json') {
      let docs;
      try { docs = JSON.parse(text); } catch { docs = null; }
      if (Array.isArray(docs)) {
        modal.showNormalizedDocs(docs, lakeName);
        return;
      }
    }

    // All other files — pretty-print JSON with syntax highlight
    let pretty;
    try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { pretty = text; }
    modal.showJson(pretty);
  } catch (e) {
    modal.show(`Error: ${e.message}`);
  }
}

async function openVersionFile(lakeName, vfile) {
  const modal = ensureJsonModal();
  modal.setTitle(`${vfile} — ${lakeName}`);
  modal.show('Loading…');
  try {
    const safeKey = sanitize(lakeName);
    const res = await fetch(`${CF_WORKER_URL}/research/package?lake=${encodeURIComponent(lakeName)}&file=${encodeURIComponent(vfile)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    let pretty;
    try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { pretty = text; }
    modal.showJson(pretty);
  } catch (e) {
    modal.show(`Error: ${e.message}`);
  }
}

function ensureJsonModal() {
  let overlay = document.getElementById('pkgJsonModal');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'pkgJsonModal';
    overlay.style.cssText = 'display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.75);overflow:auto;padding:24px';
    overlay.innerHTML = `
      <div id="pkgJsonModalInner" style="max-width:900px;margin:0 auto;background:var(--panel,#1a1a2e);border:1px solid var(--line,#333);border-radius:8px;overflow:hidden">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--line,#333)">
          <b id="pkgJsonModalTitle" style="font-size:13px;color:var(--text,#eee)"></b>
          <button id="pkgJsonModalClose" style="background:transparent;border:none;color:var(--muted,#999);font-size:18px;cursor:pointer;padding:0 4px">✕</button>
        </div>
        <div id="pkgJsonModalBody" style="padding:16px;max-height:80vh;overflow:auto;font-size:11px;font-family:monospace;white-space:pre-wrap;color:var(--text,#eee);word-break:break-all"></div>
      </div>`;
    document.body.appendChild(overlay);
    document.getElementById('pkgJsonModalClose').addEventListener('click', () => { overlay.style.display = 'none'; });
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.style.display = 'none'; });
  }
  const body = document.getElementById('pkgJsonModalBody');
  const title = document.getElementById('pkgJsonModalTitle');
  return {
    setTitle: (t) => { title.textContent = t; },
    show: (text) => { body.innerHTML = esc(text); overlay.style.display = 'block'; },
    showJson: (json) => {
      // Basic syntax coloring
      const colored = json
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, match => {
          if (/^"/.test(match)) return match.endsWith(':') ? `<span style="color:#7ec8e3">${match}</span>` : `<span style="color:#c3e88d">${match}</span>`;
          if (/true|false/.test(match)) return `<span style="color:#f78c6c">${match}</span>`;
          if (/null/.test(match)) return `<span style="color:#999">${match}</span>`;
          return `<span style="color:#f78c6c">${match}</span>`;
        });
      body.innerHTML = colored;
      overlay.style.display = 'block';
    },
    showNormalizedDocs: (docs, lakeName) => {
      let html = `<div style="font-size:12px;margin-bottom:12px;color:var(--muted,#999)">${docs.length} cached documents — click ✕ to remove from cache</div>`;
      for (const doc of docs) {
        const url = doc.url || '';
        const title = doc.title || 'Untitled';
        const tags = (doc.agentTags || []).join(', ');
        const fetched = doc.fetchedAt ? new Date(doc.fetchedAt).toLocaleDateString() : '';
        const chars = doc.fullText?.length || 0;
        html += `<div style="border:1px solid var(--line,#333);border-radius:4px;padding:8px;margin-bottom:8px;display:flex;align-items:flex-start;gap:8px">
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:12px;color:var(--text,#eee);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(title)}</div>
            ${url ? `<div style="font-size:10px;color:var(--accent,#6af);white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><a href="${esc(url)}" target="_blank" rel="noopener" style="color:inherit">${esc(url)}</a></div>` : ''}
            <div style="font-size:10px;color:var(--muted,#999);margin-top:2px">${esc(tags)}${fetched ? ` · ${fetched}` : ''}${chars ? ` · ${(chars/1000).toFixed(0)}k chars` : ''}</div>
          </div>
          <button class="norm-del-btn" data-url="${esc(url)}" data-lake="${esc(lakeName)}" style="flex-shrink:0;padding:2px 8px;font-size:11px;background:transparent;border:1px solid var(--line,#333);border-radius:4px;color:var(--muted,#999);cursor:pointer">✕</button>
        </div>`;
      }
      body.innerHTML = html;
      overlay.style.display = 'block';

      body.querySelectorAll('.norm-del-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const docUrl = btn.dataset.url;
          const lake = btn.dataset.lake;
          if (!docUrl || !lake) return;
          if (!confirm(`Remove from normalized cache?\n\n${docUrl}`)) return;
          btn.disabled = true; btn.textContent = '…';
          try {
            const res = await fetch(`${CF_WORKER_URL}/research/delete-normalized-doc`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ lakeName: lake, url: docUrl })
            });
            const data = await res.json();
            if (data.ok) { btn.closest('div[style]').style.opacity = '0.35'; btn.textContent = '✓'; }
            else { btn.textContent = '✕'; btn.disabled = false; btn.title = data.error || 'failed'; }
          } catch(e) { btn.textContent = '✕'; btn.disabled = false; btn.title = e.message; }
        });
      });
    }
  };
}



async function saveCurrentResearchProfile(status = 'draft') {
  const merged = _state.mergedProfile ? cloneJson(_state.mergedProfile) : (_state.currentProfile ? cloneJson(_state.currentProfile) : null);
  if (!merged || !_state.currentLakeName) throw new Error('No profile loaded');
  const notesVal = document.getElementById('researchNotes')?.value || merged.notes || '';
  merged.notes = notesVal;
  merged.metadata = merged.metadata || {};
  merged.metadata.status = status;
  merged.metadata.verified = status === 'verified';
  if (status === 'verified') merged.metadata.verifiedAt = new Date().toISOString();
  const res = await fetch(`${CF_WORKER_URL}/research/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lakeName: _state.currentLakeName,
      profile: merged,
      status,
      approve: status === 'verified',
      verified: status === 'verified',
      notes: notesVal,
      requestedBy: 'Lake Research UI'
    })
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`Save failed: ${res.status} ${msg.slice(0, 200)}`);
  }
  return res.json();
}

function initLakeResearch() {
  populateResearchLakeDropdown();

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

  document.getElementById('btnApprove')?.addEventListener('click', async () => {
    if (!_state.currentProfile || !_state.currentLakeName) { alert('Load a profile first'); return; }
    if (!confirm(`Mark ${_state.currentLakeName} as verified? This will save the current in-memory profile to R2 as VERIFIED.`)) return;
    try {
      await saveCurrentResearchProfile('verified');
      await loadProfile(_state.currentLakeName, true);
      alert(`${_state.currentLakeName} saved as VERIFIED.`);
    } catch (e) {
      alert(`Approve failed: ${e.message}`);
      log(`Approve failed: ${e.message}`);
    }
  });





  // ── Agent Selection Modal ──────────────────────────────────────────────────
  // Creates the modal on first use and reuses it — shown for both Run and Resume
  function showAgentModal(mode, onConfirm) {
    let modal = document.getElementById('agentSelectModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'agentSelectModal';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9999;display:flex;align-items:center;justify-content:center;';
      modal.innerHTML = `
        <div style="background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:24px;min-width:320px;max-width:420px">
          <h3 style="margin:0 0 4px" id="agentModalTitle">Select Agents</h3>
          <p class="muted" style="font-size:12px;margin:0 0 16px" id="agentModalDesc"></p>
          <div style="display:flex;gap:8px;margin-bottom:12px">
            <button id="agentSelectAll" class="small ghost" style="font-size:11px">☑ All</button>
            <button id="agentSelectNone" class="small ghost" style="font-size:11px">☐ None</button>
          </div>
          <div id="agentCheckboxList" style="display:flex;flex-direction:column;gap:8px;margin-bottom:20px"></div>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button id="agentModalCancel" class="small ghost">Cancel</button>
            <button id="agentModalConfirm" class="small primary">Run Selected</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
    }

    const AGENT_LABELS = {
      identity:    '🆔 Identity',
      limnology:   '🌊 Limnology',
      biology:     '🐟 Fisheries Biology',
      habitat:     '🌿 Habitat',
      navigation:  '🧭 Navigation',
      regulations: '📜 Regulations',
      fisheries:   '🧠 Species Intelligence',
      summary:     '📝 AI Summary'
    };

    const title = mode === 'full' ? '🔬 Full Pipeline — Select Agents' : '⚡ Resume — Select Agents';
    const desc = mode === 'full'
      ? 'Runs discovery, downloads, and extraction for selected agents. Uses Firecrawl credits.'
      : 'Uses existing normalized documents from R2. No downloads, no Firecrawl credits.';

    document.getElementById('agentModalTitle').textContent = title;
    document.getElementById('agentModalDesc').textContent = desc;

    const list = document.getElementById('agentCheckboxList');
    list.innerHTML = RESEARCH_ORDER.map(key => `
      <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px">
        <input type="checkbox" name="agentSelect" value="${key}" checked style="width:16px;height:16px">
        <span>${AGENT_LABELS[key] || key}</span>
      </label>
    `).join('');

    document.getElementById('agentSelectAll').onclick = () => list.querySelectorAll('input').forEach(cb => cb.checked = true);
    document.getElementById('agentSelectNone').onclick = () => list.querySelectorAll('input').forEach(cb => cb.checked = false);
    document.getElementById('agentModalCancel').onclick = () => { modal.style.display = 'none'; };
    document.getElementById('agentModalConfirm').onclick = () => {
      const selected = [...list.querySelectorAll('input:checked')].map(cb => cb.value);
      if (!selected.length) { alert('Select at least one agent.'); return; }
      modal.style.display = 'none';
      onConfirm(selected);
    };

    modal.style.display = 'flex';
  }

  // ── Run (Full Pipeline) ──────────────────────────────────────────────────────
  document.getElementById('btnResearch')?.addEventListener('click', () => {
    const lake = document.getElementById('researchLakeSelect')?.value;
    if (!lake) { alert('Select a lake first'); return; }
    showAgentModal('full', (selectedAgents) => {
      runFullPipeline(lake, selectedAgents, { onComplete: loadProfile, onContradictions: renderContradictionsAlert });
    });
  });

  // ── Resume (Skip Downloads) ──────────────────────────────────────────────────
  if (!document.getElementById('btnResumeNormalized')) {
    const researchBtn = document.getElementById('btnResearch');
    if (researchBtn) {
      const resumeBtn = document.createElement('button');
      resumeBtn.id = 'btnResumeNormalized';
      resumeBtn.textContent = '⚡ Resume';
      resumeBtn.title = 'Re-run using existing normalized documents in R2 — skips downloads';
      resumeBtn.style.cssText = 'margin-left:8px;background:var(--accent2,#f59e0b);color:#000;border:none;padding:6px 12px;border-radius:4px;cursor:pointer;font-size:0.85em;';
      researchBtn.parentNode.insertBefore(resumeBtn, researchBtn.nextSibling);
    }
  }
  document.getElementById('btnResumeNormalized')?.addEventListener('click', () => {
    const lake = document.getElementById('researchLakeSelect')?.value;
    if (!lake) { alert('Select a lake first'); return; }
    showAgentModal('resume', (selectedAgents) => {
      runResume(lake, selectedAgents, { onComplete: loadProfile, onContradictions: renderContradictionsAlert });
    });
  });

  // ── Smart Plan Recovery ──────────────────────────────────────────────────────
  if (!document.getElementById('btnSmartPlanRecovery')) {
    const anchor = document.getElementById('btnResumeNormalized') || document.getElementById('btnResearch');
    if (anchor) {
      const btn = document.createElement('button');
      btn.id = 'btnSmartPlanRecovery';
      btn.textContent = '🎯 Smart Plan Recovery';
      btn.title = 'Targeted re-extraction of highest-value documents for Smart Plan gaps. Never overwrites existing data.';
      btn.style.cssText = 'margin-left:8px;background:var(--panel2);color:var(--accent);border:1px solid var(--accent);padding:6px 12px;border-radius:4px;cursor:pointer;font-size:0.85em;';
      anchor.parentNode.insertBefore(btn, anchor.nextSibling);
    }
  }
  document.getElementById('btnSmartPlanRecovery')?.addEventListener('click', async () => {
    const lake = document.getElementById('researchLakeSelect')?.value;
    if (!lake) { alert('Select a lake first'); return; }
    if (!confirm(`Run Smart Plan Recovery for ${lake}?\n\nRe-extracts up to 5 high-value cached documents to fill Smart Plan gaps. Never overwrites existing sections.`)) return;
    const button = document.getElementById('btnSmartPlanRecovery');
    if (button) { button.disabled = true; button.textContent = '⏳ Recovering…'; }
    try {
      const result = await recoverSmartPlanFacts(lake, { onComplete: loadProfile });
      alert(`Smart Plan Recovery complete: ${result.documents} documents checked, ${result.facts} facts recovered, ${result.filled} fields filled, ${result.finalized} gaps finalized.`);
    } catch (err) {
      alert(`Smart Plan Recovery failed: ${err.message}`);
    } finally {
      if (button) { button.disabled = false; button.textContent = '🎯 Smart Plan Recovery'; }
    }
  });

  // ── Geospatial Rerun ─────────────────────────────────────────────────────────
  if (!document.getElementById('btnRerunGeospatial')) {
    const anchor = document.getElementById('btnSmartPlanRecovery') || document.getElementById('btnResumeNormalized') || document.getElementById('btnResearch');
    if (anchor) {
      const btn = document.createElement('button');
      btn.id = 'btnRerunGeospatial';
      btn.textContent = '🗺️ Rerun Geospatial';
      btn.title = 'Re-derive structural habitat fields from R2 contour/boundary layers — no downloads';
      btn.style.cssText = 'margin-left:8px;background:var(--panel2);color:var(--accent);border:1px solid var(--accent);padding:6px 12px;border-radius:4px;cursor:pointer;font-size:0.85em;';
      anchor.parentNode.insertBefore(btn, anchor.nextSibling);
    }
  }
  document.getElementById('btnRerunGeospatial')?.addEventListener('click', async () => {
    const lake = _state.currentLakeName || document.getElementById('researchLakeSelect')?.value;
    if (!lake) { alert('Load a lake first'); return; }
    if (!_state.currentProfile) { alert('No profile loaded — load the lake profile first'); return; }
    const button = document.getElementById('btnRerunGeospatial');
    if (button) { button.disabled = true; button.textContent = '⏳ Running…'; }
    log(`[Geospatial] Re-running geospatial adapter for ${lake}…`);
    try {
      const geoStruct = await deriveGeospatialStructureFacts(lake);
      if (!geoStruct) { alert('Geospatial adapter returned no data. Check that contour and boundary layers are loaded in R2 for this lake.'); return; }
      const profile = cloneJson(_state.currentProfile);
      profile.habitat = profile.habitat || {};
      const existingNotes = profile.habitat.notes || '';
      const geoNotes = geoStruct.habitat?.notes || '';
      Object.assign(profile.habitat, geoStruct.habitat || {});
      profile.habitat.notes = [existingNotes, geoNotes].filter(Boolean).join(' ') || profile.habitat.notes;
      if (geoStruct.evidence) {
        profile.evidence = profile.evidence || {};
        for (const [section, fieldMap] of Object.entries(geoStruct.evidence)) {
          if (!fieldMap || typeof fieldMap !== 'object') continue;
          profile.evidence[section] = profile.evidence[section] || {};
          for (const [k, v] of Object.entries(fieldMap)) {
            const existing = profile.evidence[section][k];
            const existingArr = Array.isArray(existing) ? existing : (existing ? [existing] : []);
            const newArr = Array.isArray(v) ? v : (v ? [v] : []);
            profile.evidence[section][k] = [...existingArr, ...newArr];
          }
        }
      }
      if (geoStruct.sources?.length) {
        const existingUrls = new Set((profile.sources || []).map(s => s.url));
        for (const s of geoStruct.sources) {
          if (!existingUrls.has(s.url)) { (profile.sources = profile.sources || []).push(s); existingUrls.add(s.url); }
        }
      }
      const saveRes = await fetch(`${CF_WORKER_URL}/research/save`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lakeName: lake, profile, status: profile?.metadata?.status || 'draft', requestedBy: 'Geospatial Rerun' })
      });
      if (!saveRes.ok) throw new Error(`Save failed: ${saveRes.status}`);
      _state.currentProfile = profile;
      await loadProfile(lake, true);
      log(`[Geospatial] ✔ Geospatial fields updated and saved.`);
      alert('Geospatial fields updated successfully.');
    } catch (err) {
      alert(`Geospatial rerun failed: ${err.message}`);
      log(`[Geospatial] ✗ ${err.message}`);
    } finally {
      if (button) { button.disabled = false; button.textContent = '🗺️ Rerun Geospatial'; }
    }
  });

  // ── Lake Status Overview ─────────────────────────────────────────────────────
  if (!document.getElementById('btnLakeStatusOverview')) {
    const anchor = document.getElementById('btnRerunGeospatial') || document.getElementById('btnSmartPlanRecovery') || document.getElementById('btnResearch');
    if (anchor) {
      const btn = document.createElement('button');
      btn.id = 'btnLakeStatusOverview';
      btn.textContent = '📋 Lake Status';
      btn.title = 'View research status for all lakes';
      btn.style.cssText = 'margin-left:8px;background:var(--panel2);color:var(--text);border:1px solid var(--line);padding:6px 12px;border-radius:4px;cursor:pointer;font-size:0.85em;';
      anchor.parentNode.insertBefore(btn, anchor.nextSibling);
    }
  }
  document.getElementById('btnLakeStatusOverview')?.addEventListener('click', async () => {
    let modal = document.getElementById('lakeStatusModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'lakeStatusModal';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;';
      modal.innerHTML = '<div style="background:var(--panel,#1e1e1e);border:1px solid var(--line,#333);border-radius:10px;width:min(900px,95vw);max-height:85vh;display:flex;flex-direction:column;overflow:hidden;">'
        + '<div style="padding:14px 18px;border-bottom:1px solid var(--line,#333);display:flex;align-items:center;gap:12px;">'
        + '<span style="font-weight:700;font-size:1em;flex:1;">📋 Lake Research Status</span>'
        + '<input id="lakeStatusFilter" placeholder="Filter lakes..." style="padding:5px 10px;border:1px solid var(--line,#333);border-radius:4px;background:var(--panel2,#252525);color:var(--text,#eee);font-size:0.85em;width:200px;">'
        + '<select id="lakeStatusFilterState" style="padding:5px 8px;border:1px solid var(--line,#333);border-radius:4px;background:var(--panel2,#252525);color:var(--text,#eee);font-size:0.85em;">'
        + '<option value="">All states</option><option value="SC">SC</option><option value="NC">NC</option><option value="GA">GA</option><option value="TN">TN</option>'
        + '</select>'
        + '<select id="lakeStatusFilterStatus" style="padding:5px 8px;border:1px solid var(--line,#333);border-radius:4px;background:var(--panel2,#252525);color:var(--text,#eee);font-size:0.85em;">'
        + '<option value="">All statuses</option><option value="verified">✅ Verified</option><option value="draft">🔄 Draft</option>'
        + '</select>'
        + '<button id="lakeStatusClose" style="background:none;border:none;color:var(--text,#eee);font-size:1.2em;cursor:pointer;padding:0 4px;">✕</button>'
        + '</div>'
        + '<div id="lakeStatusBody" style="overflow-y:auto;flex:1;padding:8px 0;"><div style="text-align:center;padding:40px;color:var(--muted,#888);">⏳ Loading...</div></div>'
        + '<div id="lakeStatusFooter" style="padding:10px 18px;border-top:1px solid var(--line,#333);font-size:0.8em;color:var(--muted,#888);"></div>'
        + '</div>';
      document.body.appendChild(modal);

      document.getElementById('lakeStatusClose').addEventListener('click', () => modal.remove());
      modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

      const filterFn = () => {
        const q = (document.getElementById('lakeStatusFilter')?.value || '').toLowerCase();
        const st = document.getElementById('lakeStatusFilterState')?.value || '';
        const sv = document.getElementById('lakeStatusFilterStatus')?.value || '';
        document.querySelectorAll('.lake-status-row').forEach(row => {
          const show = (!q || (row.dataset.name || '').includes(q))
            && (!st || row.dataset.state === st)
            && (!sv || row.dataset.status === sv);
          row.style.display = show ? '' : 'none';
        });
      };
      document.getElementById('lakeStatusFilter')?.addEventListener('input', filterFn);
      document.getElementById('lakeStatusFilterState')?.addEventListener('change', filterFn);
      document.getElementById('lakeStatusFilterStatus')?.addEventListener('change', filterFn);
    }

    const body = document.getElementById('lakeStatusBody');
    const footer = document.getElementById('lakeStatusFooter');
    body.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted,#888);">⏳ Loading...</div>';

    try {
      const res = await fetch(CF_WORKER_URL + '/research/list');
      const data = await res.json();
      if (!data.ok || !data.lakes?.length) { body.innerHTML = '<div style="padding:20px;color:var(--muted)">No profiles found.</div>'; return; }

      const BATCH = 6;
      const profiles = [];
      for (let i = 0; i < data.lakes.length; i += BATCH) {
        const batch = data.lakes.slice(i, i + BATCH);
        const results = await Promise.all(batch.map(async lake => {
          try {
            const r = await fetch(CF_WORKER_URL + '/research/get?lake=' + encodeURIComponent(lake.id));
            if (!r.ok) return { id: lake.id, error: true };
            const d = await r.json();
            return { id: lake.id, profile: d.profile };
          } catch (e) { return { id: lake.id, error: true }; }
        }));
        profiles.push(...results);
      }

      const statusIcon = function(s) { return s === 'verified' ? '✅' : s === 'draft' ? '🔄' : '❓'; };
      const pct = function(p) { return p && p.confidence && p.confidence.overall ? p.confidence.overall.percent : '—'; };
      const stateOf = function(id) {
        if (/_sc$/.test(id) || id.includes('_sc_')) return 'SC';
        if (/_nc$/.test(id) || id.includes('_nc_')) return 'NC';
        if (/_ga$/.test(id) || id.includes('_ga_') || /_sc_ga$/.test(id)) return 'GA';
        if (/_tn$/.test(id) || id.includes('_tn_')) return 'TN';
        return '—';
      };

      let verified = 0, draft = 0;
      let tableHTML = '<table style="width:100%;border-collapse:collapse;">'
        + '<thead><tr style="border-bottom:2px solid var(--line,#333);position:sticky;top:0;background:var(--panel,#1e1e1e);">'
        + '<th style="padding:8px 18px;text-align:left;font-size:0.78em;color:var(--muted);font-weight:600;">LAKE</th>'
        + '<th style="padding:8px 12px;text-align:left;font-size:0.78em;color:var(--muted);font-weight:600;">STATE</th>'
        + '<th style="padding:8px 12px;text-align:left;font-size:0.78em;color:var(--muted);font-weight:600;">STATUS</th>'
        + '<th style="padding:8px 12px;text-align:left;font-size:0.78em;color:var(--muted);font-weight:600;">OVERALL</th>'
        + '<th style="padding:8px 18px;text-align:left;font-size:0.78em;color:var(--muted);font-weight:600;">LAST UPDATED</th>'
        + '</tr></thead><tbody>';

      profiles.forEach(function(p) {
        const profile = p.profile;
        const status = (profile && profile.metadata && profile.metadata.status) || '—';
        const lakeName = (profile && profile.lakeName) || p.id.replace(/_/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
        const overall = pct(profile);
        const updated = (profile && profile.metadata && profile.metadata.lastUpdated)
          ? new Date(profile.metadata.lastUpdated).toLocaleDateString() : '—';
        const state = stateOf(p.id);
        const pctColor = overall >= 90 ? 'var(--accent2,#4ade80)' : overall >= 70 ? 'var(--accent,#38bdf8)' : 'var(--muted,#888)';
        if (status === 'verified') verified++;
        else if (status === 'draft') draft++;
        tableHTML += '<tr class="lake-status-row"'
          + ' data-name="' + lakeName.toLowerCase() + '"'
          + ' data-state="' + state + '"'
          + ' data-status="' + status + '"'
          + ' data-lake="' + lakeName + '"'
          + ' style="cursor:pointer;border-bottom:1px solid var(--line,#333);">'
          + '<td style="padding:8px 18px;font-size:0.85em;font-weight:500;">' + lakeName + '</td>'
          + '<td style="padding:8px 12px;font-size:0.8em;color:var(--muted);">' + state + '</td>'
          + '<td style="padding:8px 12px;font-size:0.85em;">' + statusIcon(status) + ' ' + status + '</td>'
          + '<td style="padding:8px 12px;font-size:0.85em;color:' + pctColor + ';">' + (overall !== '—' ? overall + '%' : '—') + '</td>'
          + '<td style="padding:8px 18px;font-size:0.8em;color:var(--muted);">' + updated + '</td>'
          + '</tr>';
      });

      tableHTML += '</tbody></table>';
      body.innerHTML = tableHTML;

      body.querySelectorAll('.lake-status-row').forEach(function(row) {
        row.addEventListener('click', function() {
          const ln = row.dataset.lake;
          if (ln) { document.getElementById('lakeStatusModal')?.remove(); setTimeout(() => { const sel = document.getElementById('researchLakeSelect'); if (sel) { sel.value = ln; sel.dispatchEvent(new Event('change')); } }, 50); return; }
        });
        row.addEventListener('mouseenter', function() { row.style.background = 'var(--panel2,#252525)'; });
        row.addEventListener('mouseleave', function() { row.style.background = ''; });
      });

      footer.textContent = profiles.length + ' profiles — ' + verified + ' verified, ' + draft + ' draft';
    } catch (e) {
      body.innerHTML = '<div style="padding:20px;color:var(--warn,#f87171);">Failed to load: ' + e.message + '</div>';
    }
  });


  // ── WQP (Water Quality Portal) ───────────────────────────────────────────────
  document.getElementById('btnSaveNotes')?.addEventListener('click', async () => {
    if (!_state.currentProfile || !_state.currentLakeName) { alert('Load a profile first'); return; }
    const st = document.getElementById('notesStatus');
    try {
      if (st) { st.textContent = 'Saving…'; st.style.color = 'var(--accent)'; }
      await saveCurrentResearchProfile(_state.currentProfile?.metadata?.status === 'verified' ? 'verified' : 'draft');
      await loadProfile(_state.currentLakeName, true);
      if (st) { st.textContent = 'Saved ✓'; st.style.color = 'var(--accent2)'; }
    } catch (e) {
      if (st) { st.textContent = `Save failed: ${e.message}`; st.style.color = 'var(--bad)'; }
      log(`Save notes failed: ${e.message}`);
    }
  });

  document.getElementById('btnEditMasterJson')?.addEventListener('click', () => {
    if (!_state.currentProfile) { alert('Load a profile first'); return; }
    const card = document.getElementById('masterJsonEditCard');
    const ta = document.getElementById('masterJsonTextarea');
    const st = document.getElementById('masterJsonStatus');
    if (ta) ta.value = JSON.stringify(_state.currentProfile, null, 2);
    if (st) st.textContent = '';
    if (card) card.style.display = 'block';
  });
  document.getElementById('btnCloseMasterJson')?.addEventListener('click', () => {
    const card = document.getElementById('masterJsonEditCard');
    if (card) card.style.display = 'none';
  });
  document.getElementById('btnFormatMasterJson')?.addEventListener('click', () => {
    const ta = document.getElementById('masterJsonTextarea');
    const st = document.getElementById('masterJsonStatus');
    if (!ta) return;
    try {
      ta.value = JSON.stringify(JSON.parse(ta.value), null, 2);
      if (st) { st.textContent = 'Formatted'; st.style.color = 'var(--accent2)'; }
    } catch (e) {
      if (st) { st.textContent = `Invalid JSON: ${e.message}`; st.style.color = 'var(--bad)'; }
    }
  });
  document.getElementById('btnSaveMasterJson')?.addEventListener('click', async () => {
    const ta = document.getElementById('masterJsonTextarea');
    const st = document.getElementById('masterJsonStatus');
    if (!ta || !_state.currentLakeName) return;
    try {
      const parsed = JSON.parse(ta.value);
      if (st) { st.textContent = 'Saving…'; st.style.color = 'var(--accent)'; }
      const res = await fetch(`${CF_WORKER_URL}/research/save`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lakeName: _state.currentLakeName,
          profile: parsed,
          status: parsed?.metadata?.status || _state.currentProfile?.metadata?.status || 'draft',
          approve: parsed?.metadata?.status === 'verified',
          verified: parsed?.metadata?.status === 'verified',
          notes: parsed?.notes || '',
          requestedBy: 'Lake Research Master JSON Editor'
        })
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${msg.slice(0, 200)}`);
      }
      await loadProfile(_state.currentLakeName, true);
      const card = document.getElementById('masterJsonEditCard');
      if (card) card.style.display = 'none';
      if (st) { st.textContent = 'Saved ✓'; st.style.color = 'var(--accent2)'; }
    } catch (e) {
      if (st) { st.textContent = `Save failed: ${e.message}`; st.style.color = 'var(--bad)'; }
      log(`Master JSON save failed: ${e.message}`);
    }
  });

  document.getElementById('researchImportInput')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const txt = await file.text();
      const parsed = JSON.parse(txt);
      const importedLake = parsed.lakeName || parsed.identity?.lakeName || _state.currentLakeName;
      if (!importedLake) throw new Error('Imported JSON missing lakeName');
      const res = await fetch(`${CF_WORKER_URL}/research/save`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lakeName: importedLake, profile: parsed, status: parsed?.metadata?.status || 'draft', notes: parsed?.notes || '', requestedBy: 'Lake Research Import' })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      document.getElementById('researchLakeSelect').value = importedLake;
      await loadProfile(importedLake, true);
      alert(`Imported profile for ${importedLake}`);
    } catch (err) {
      alert(`Import failed: ${err.message}`);
      log(`Import failed: ${err.message}`);
    } finally {
      e.target.value = '';
    }
  });

  document.getElementById('btnRefresh')?.addEventListener('click', () => {
    if (!_state.currentLakeName) { alert('Load a lake first'); return; }
    showAgentModal('resume', (selectedAgents) => {
      runResume(_state.currentLakeName, selectedAgents, { onComplete: loadProfile, onContradictions: renderContradictionsAlert });
    });
  });

  document.getElementById('btnDeleteResearch')?.addEventListener('click', async () => {
    if (!_state.currentLakeName) { alert('Load a lake first'); return; }
    if (!confirm(`Delete researched profile for ${_state.currentLakeName}? This removes the master JSON, package parts, and versions from R2.`)) return;
    try {
      const res = await fetch(`${CF_WORKER_URL}/research/delete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lakeName: _state.currentLakeName })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      renderEmpty(_state.currentLakeName);
      _state.currentProfile = null;
      alert(`Deleted research for ${_state.currentLakeName}`);
    } catch (e) {
      alert(`Delete failed: ${e.message}`);
      log(`Delete failed: ${e.message}`);
    }
  });

  document.getElementById('btnDebugProfile')?.addEventListener('click', () => {
    const out = document.getElementById('debugOutput');
    if (!out) return;
    out.style.display = out.style.display === 'none' ? 'block' : 'none';
    out.textContent = _state.currentProfile ? JSON.stringify(_state.currentProfile, null, 2) : 'No profile loaded';
  });
  document.getElementById('btnClearResearchCache')?.addEventListener('click', () => {
    _state.researchLog = [];
    const logEl = document.getElementById('researchLog');
    if (logEl) { logEl.textContent = 'Log cleared.'; logEl.style.display = 'none'; }
    const out = document.getElementById('debugOutput');
    if (out) out.textContent = '';
  });

  document.getElementById('btnExport')?.addEventListener('click', () => {
    if (!_state.currentProfile) { alert('No profile loaded to export.'); return; }
    try {
      const json = JSON.stringify(_state.currentProfile, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${sanitize(_state.currentLakeName || 'lake')}_research.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      log(`Exported profile for ${_state.currentLakeName}`);
    } catch (e) {
      alert(`Export failed: ${e.message}`);
    }
  });

  console.log('🧠 Structured Evidence Acquisition & Lake Research module ready');
}

setTimeout(initLakeResearch, 800);

window.getResearchedProfile = function getResearchedProfile(lakeName) {
  if (!lakeName) return null;
  const direct = window.TROLLMAP_RESEARCHED_CACHE?.[lakeName];
  if (direct) return direct;
  const safe = sanitize(lakeName);
  return window.TROLLMAP_RESEARCHED_CACHE?.[safe] || null;
};

export { initLakeResearch, loadProfile, saveCurrentResearchProfile, populateResearchLakeDropdown };
