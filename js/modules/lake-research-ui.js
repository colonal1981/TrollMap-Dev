import { state, CF_WORKER_URL } from '../core/state.js';
import { _state, runEvidencePipeline, runFromNormalized, validateExistingFacts, recoverSmartPlanFacts, deriveGeospatialStructureFacts, RESEARCH_ORDER, RESEARCH_LABELS, cloneJson, hasResearchValue, sanitize, sanitizeStateFromLakeName, log } from './lake-research-engine.js';


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
  for (const id of ['confidenceCard', 'sourcesCard', 'summaryCard', 'notesCard', 'packageCard', 'reviewCard']) {
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
  renderPackage(profile, _state.currentPackageFiles, _state.currentVersions);
  renderReviewCard(profile);
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
        html += `• <b>${esc(s.species || '—')}</b>${s.agency ? ` (${esc(s.agency)})` : ''}${s.note ? ` — ${esc(s.note)}` : ''}<br>`;
      });
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
        if (typeof _state.packagePartsCache !== 'undefined') _state.packagePartsCache[agent] = parsed;
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
        // Pass extracted facts AND normalized document text so agent has real evidence
        const reviewCard = document.getElementById('reviewCard');
        const prevProfile = reviewCard?.dataset.merged ? JSON.parse(reviewCard.dataset.merged) : (_state.currentProfile || {});
        const storedFacts = prevProfile._extractedFacts || _state.currentProfile?._extractedFacts || [];

        // Fetch normalized documents from R2 to give agent actual source text
        let normalizedDocs = [];
        try {
          const normRes = await fetch(`${CF_WORKER_URL}/research/get-normalized?lake=${encodeURIComponent(_state.currentLakeName)}`);
          if (normRes.ok) {
            const normData = await normRes.json();
            if (normData.ok && normData.documents?.length) {
              normalizedDocs = normData.documents.map(d => ({
                title: d.title,
                url: d.url,
                text: (d.fullText || d.text || '').slice(0, 20000)
              }));
            }
          }
        } catch (e) {
          log(`[Re-run] Could not fetch normalized docs: ${e.message} — agent will use stored facts only`);
        }

        const agentRes = await fetch(`${CF_WORKER_URL}/research/agent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lakeName: _state.currentLakeName,
            state: sanitizeStateFromLakeName(_state.currentLakeName),
            agent: agentKey,
            previousResults: {
              ...prevProfile,
              _extractedFacts: storedFacts,
              _normalizedDocuments: normalizedDocs
            }
          })
        });
        const agentData = await agentRes.json();
        if (!agentData.success) throw new Error(agentData.error || 'Agent failed');

        // Step 4: Apply result to in-memory profile
        {
          const curMerged = reviewCard?.dataset.merged ? JSON.parse(reviewCard.dataset.merged) : (_state.currentProfile || {});
          const curParts = reviewCard?.dataset.parts ? JSON.parse(reviewCard.dataset.parts) : {};
          if (agentKey === 'biology') {
            // Protect deterministic fields — never let LLM re-run overwrite confirmed species data with empty arrays
            const existing = curMerged.biology || {};
            const merged = { ...existing, ...agentData.section };
            if (existing.predatorSpecies?.length && !agentData.section.predatorSpecies?.length) merged.predatorSpecies = existing.predatorSpecies;
            if (existing.knownStockings?.length && !agentData.section.knownStockings?.length) merged.knownStockings = existing.knownStockings;
            curMerged.biology = merged;
            curMerged.forage = merged;
          } else {
            curMerged[agentKey] = agentData.section;
          }
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
          // Keep _state.currentProfile in sync
          _state.currentProfile = curMerged;
          if (typeof _state.packagePartsCache !== 'undefined') _state.packagePartsCache[agentKey] = agentData.section;
        }

        // Step 5: Refresh UI for this section
        const viewer = document.getElementById(`viewer-container-${agentKey}`);
        if (viewer) viewer.innerHTML = formatHumanReadableSection(agentKey, agentData.section);
        const ta = container.querySelector(`.review-section-textarea[data-agent="${agentKey}"]`);
        if (ta) ta.value = JSON.stringify(agentData.section, null, 2);

        if (st) { st.textContent = `✓ Re-run complete (${agentData.confidence?.percent||'?'}% confidence via ${agentData.meta?.model||'?'})`; st.style.color = 'var(--accent2)'; }
        log(`[Re-run] ${agentKey}: ${agentData.confidence?.percent||'?'}% via ${agentData.meta?.model||'?'}`);

        // ── Field-level capture/miss logging for new casting-relevant fields ──
        const sec = agentData.section || {};
        if (agentKey === 'biology') {
          const newFields = {
            spawnTiming:   sec.spawnTiming,
            forageSpatial: sec.forageSpatial,
            baitfishMovement: sec.baitfishMovement,
          };
          for (const [field, val] of Object.entries(newFields)) {
            const isEmpty = !val || (typeof val === 'object' && !Array.isArray(val) && Object.keys(val).length === 0) || (Array.isArray(val) && val.length === 0);
            if (!isEmpty) {
              log(`[Re-run] ✅ biology.${field}: ${typeof val === 'object' ? JSON.stringify(val) : val}`);
            } else {
              log(`[Re-run] ⬜ biology.${field}: not found in documents`);
            }
          }
          // Also log primary forage and stocking for comparison
          if (sec.primaryForage?.length) log(`[Re-run] ✅ biology.primaryForage: ${sec.primaryForage.join(', ')}`);
          if (sec.knownStockings?.length) log(`[Re-run] ✅ biology.knownStockings: ${sec.knownStockings.length} stocking event(s)`);
          if (sec.predatorSpecies?.length) log(`[Re-run] ✅ biology.predatorSpecies: ${sec.predatorSpecies.length} species`);
        }

        if (agentKey === 'habitat') {
          const newFields = {
            dockDensity:     sec.dockDensity,
            riprapLocations: sec.riprapLocations,
            namedCreekMouths: sec.namedCreekMouths,
            timberFields:    sec.timberFields,
            shallowFlatAreas: sec.shallowFlatAreas,
          };
          for (const [field, val] of Object.entries(newFields)) {
            const isEmpty = !val || (Array.isArray(val) && val.length === 0) || val === '' || val === 'null';
            if (!isEmpty) {
              log(`[Re-run] ✅ habitat.${field}: ${Array.isArray(val) ? val.join(', ') : val}`);
            } else {
              log(`[Re-run] ⬜ habitat.${field}: not found in documents`);
            }
          }
          // Also log cover and attractor count for context
          if (sec.cover?.length) log(`[Re-run] ✅ habitat.cover: ${sec.cover.join(', ')}`);
          if (sec.artificialHabitatDetails?.attractorCount) log(`[Re-run] ✅ habitat.attractors: ${sec.artificialHabitatDetails.attractorCount}`);
          if (sec.dockDensity === null) log(`[Re-run] ℹ️ habitat.dockDensity null — source docs may not describe dock concentration`);
        }

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
  if (filesEl) {
    let html = `<div style="font-size:11px;color:var(--muted)">Master: lakes/${sanitize(profile.lakeName || _state.currentLakeName)}.json (${JSON.stringify(profile).length} bytes)<br>Package folder: lake_packages/${sanitize(profile.lakeName || _state.currentLakeName)}/</div><div style="display:flex;flex-wrap:wrap;gap:4px;margin:8px 0">`;
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

function renderReviewCard(profile) {
  const card = document.getElementById('reviewCard');
  const list = document.getElementById('reviewList');
  if (!card || !list) return;
  const status = profile?.metadata?.status || 'draft';
  if (!profile || status === 'verified') {
    card.style.display = 'none';
    return;
  }
  card.style.display = 'block';
  const conf = profile.confidence || {};
  const rows = [];
  for (const key of RESEARCH_ORDER) {
    const data = key === 'identity'
      ? (profile.identity || {})
      : key === 'biology'
        ? (profile.biology || profile.forage || {})
        : key === 'trolling'
          ? (profile.trollingIntelligence || profile.trolling || null)
          : profile[key];
    const pct = conf[key]?.percent || (hasResearchValue(data) ? 70 : 0);
    const needsReview = pct < 70 || !hasResearchValue(data);
    rows.push(`<div class="review-card ${needsReview ? 'need' : ''}">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
        <div><b>${esc(RESEARCH_LABELS[key] || key)}</b><br><span class="muted" style="font-size:11px">${needsReview ? 'Needs review / may be incomplete' : 'Looks populated'}</span></div>
        <div style="font-weight:700;color:${needsReview ? 'var(--bad)' : 'var(--accent2)'}">${pct}%</div>
      </div>
    </div>`);
  }
  list.innerHTML = rows.join('');
}

async function saveCurrentResearchProfile(status = 'draft') {
  const reviewCard = document.getElementById('reviewCard');
  const merged = reviewCard?.dataset.merged ? JSON.parse(reviewCard.dataset.merged) : (_state.currentProfile ? cloneJson(_state.currentProfile) : null);
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

  document.getElementById('btnApproveReview')?.addEventListener('click', async () => {
    if (!_state.currentProfile || !_state.currentLakeName) { alert('Load a profile first'); return; }
    if (!confirm(`Approve and save ${_state.currentLakeName} as VERIFIED?`)) return;
    try {
      await saveCurrentResearchProfile('verified');
      await loadProfile(_state.currentLakeName, true);
      alert(`${_state.currentLakeName} saved as VERIFIED.`);
    } catch (e) {
      alert(`Approve failed: ${e.message}`);
      log(`Approve failed: ${e.message}`);
    }
  });

  document.getElementById('btnSaveDraft')?.addEventListener('click', async () => {
    if (!_state.currentProfile || !_state.currentLakeName) { alert('Load a profile first'); return; }
    try {
      await saveCurrentResearchProfile('draft');
      await loadProfile(_state.currentLakeName, true);
      alert(`${_state.currentLakeName} draft saved.`);
    } catch (e) {
      alert(`Draft save failed: ${e.message}`);
      log(`Draft save failed: ${e.message}`);
    }
  });

  document.getElementById('btnResearch')?.addEventListener('click', () => {
    const lake = document.getElementById('researchLakeSelect')?.value;
    if (!lake) { alert('Select a lake first'); return; }
    if (!confirm(`Launch the factual lake research pipeline for ${lake}? This will pull official pages and GIS sources first, fetch accessible documents, parse PDFs client-side with PDF.js, and only use quoted/source-backed extraction where needed. Continue?`)) return;
    runEvidencePipeline(lake, { onComplete: loadProfile, onContradictions: renderContradictionsAlert });
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
    runFromNormalized(lake, { onComplete: loadProfile, onContradictions: renderContradictionsAlert });
  });

  // This is intentionally separate from Resume: it does not discover, scrape,
  // download, parse PDFs, or re-extract documents. It only asks the validation
  // agent to map fields from facts already saved in the research profile.
  if (!document.getElementById('btnValidateExistingFacts')) {
    const resumeBtn = document.getElementById('btnResumeNormalized');
    const anchor = resumeBtn || document.getElementById('btnResearch');
    if (anchor) {
      const validateBtn = document.createElement('button');
      validateBtn.id = 'btnValidateExistingFacts';
      validateBtn.textContent = '✓ Validate Existing Facts';
      validateBtn.title = 'Fill supported empty fields from facts already saved in the profile — no discovery, downloads, or document re-extraction';
      validateBtn.style.cssText = 'margin-left:8px; background:var(--panel2); color:var(--accent); border:1px solid var(--accent); padding:6px 12px; border-radius:4px; cursor:pointer; font-size:0.85em;';
      anchor.parentNode.insertBefore(validateBtn, anchor.nextSibling);
    }
  }

  document.getElementById('btnValidateExistingFacts')?.addEventListener('click', async () => {
    const lake = document.getElementById('researchLakeSelect')?.value;
    if (!lake) { alert('Select a lake first'); return; }
    if (!confirm(`Validate existing extracted facts for ${lake}? This skips discovery, downloads, and full document re-extraction; it only fills currently empty supported fields when saved facts explicitly support them.`)) return;
    const button = document.getElementById('btnValidateExistingFacts');
    if (button) { button.disabled = true; button.textContent = '⏳ Validating…'; }
    try {
      const result = await validateExistingFacts(lake, { onComplete: loadProfile });
      alert(`Existing-fact validation finished. Requested ${result.fieldsRequested} empty fields; filled ${result.fieldsFilled} evidence-backed field(s).`);
    } catch (err) {
      alert(`Existing-fact validation failed: ${err.message}`);
    } finally {
      if (button) { button.disabled = false; button.textContent = '✓ Validate Existing Facts'; }
    }
  });

  // One-and-done recovery for only fields Smart Plan actually consumes. It
  // re-extracts no more than five high-value R2 documents, then records any
  // remaining applicable gap as reviewed/unavailable so it stops penalizing confidence.
  if (!document.getElementById('btnSmartPlanRecovery')) {
    const anchor = document.getElementById('btnValidateExistingFacts') || document.getElementById('btnResumeNormalized') || document.getElementById('btnResearch');
    if (anchor) {
      const recoverBtn = document.createElement('button');
      recoverBtn.id = 'btnSmartPlanRecovery';
      recoverBtn.textContent = '🎯 Smart Plan Recovery';
      recoverBtn.title = 'One targeted re-extraction of the highest-value saved documents for Smart Plan gaps, then finalize remaining reviewed gaps';
      recoverBtn.style.cssText = 'margin-left:8px; background:var(--accent2); color:#000; border:none; padding:6px 12px; border-radius:4px; cursor:pointer; font-size:0.85em;';
      anchor.parentNode.insertBefore(recoverBtn, anchor.nextSibling);
    }
  }
  document.getElementById('btnSmartPlanRecovery')?.addEventListener('click', async () => {
    const lake = document.getElementById('researchLakeSelect')?.value;
    if (!lake) { alert('Select a lake first'); return; }
    if (!confirm(`Run the one-time Smart Plan Recovery for ${lake}? It uses only saved R2 documents, re-extracts at most five high-value sources, and finalizes any still-unavailable Smart Plan fields so they no longer reduce confidence.`)) return;
    const button = document.getElementById('btnSmartPlanRecovery');
    if (button) { button.disabled = true; button.textContent = '⏳ Recovering…'; }
    try {
      const result = await recoverSmartPlanFacts(lake, { onComplete: loadProfile });
      // Auto-verify — Smart Plan Recovery is the final research step
      if (_state.currentProfile) {
        _state.currentProfile.metadata = _state.currentProfile.metadata || {};
        _state.currentProfile.metadata.status = 'verified';
        await fetch(`${CF_WORKER_URL}/research/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lakeName: lake,
            profile: _state.currentProfile,
            status: 'verified',
            approve: true,
            verified: true,
            requestedBy: 'Smart Plan Recovery auto-verify'
          })
        });
        await loadProfile(lake, true);
      }
      alert(`Smart Plan Recovery complete: ${result.documents} cached documents checked, ${result.facts} facts recovered, ${result.filled} fields filled, ${result.finalized} remaining reviewed gaps finalized.\n\n✔ Profile marked as verified.`);
    } catch (err) {
      alert(`Smart Plan Recovery failed: ${err.message}`);
    } finally {
      if (button) { button.disabled = false; button.textContent = '🎯 Smart Plan Recovery'; }
    }
  });

  // Standalone geospatial adapter re-run — no pipeline, no downloads, no Tavily
  // Pulls contour/boundary/supplemental layers from R2, merges into current profile, saves.
  if (!document.getElementById('btnRerunGeospatial')) {
    const anchor = document.getElementById('btnSmartPlanRecovery') || document.getElementById('btnValidateExistingFacts') || document.getElementById('btnResumeNormalized') || document.getElementById('btnResearch');
    if (anchor) {
      const geoBtn = document.createElement('button');
      geoBtn.id = 'btnRerunGeospatial';
      geoBtn.textContent = '🗺️ Rerun Geospatial';
      geoBtn.title = 'Re-derive structural habitat fields from R2 contour/boundary/supplemental layers and merge into the current profile — no pipeline, no downloads';
      geoBtn.style.cssText = 'margin-left:8px; background:var(--panel2); color:var(--accent); border:1px solid var(--accent); padding:6px 12px; border-radius:4px; cursor:pointer; font-size:0.85em;';
      anchor.parentNode.insertBefore(geoBtn, anchor.nextSibling);
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
      if (!geoStruct) {
        log('[Geospatial] ⚠️ No structural fields returned — contour/boundary layers may not be loaded for this lake.');
        alert('Geospatial adapter returned no data. Check that contour and boundary layers are loaded in R2 for this lake.');
        return;
      }

      // Merge into current in-memory profile
      const profile = cloneJson(_state.currentProfile);

      // Merge habitat — geo output wins for structural elements, existing narrative preserved
      profile.habitat = profile.habitat || {};
      const existingNotes = profile.habitat.notes || '';
      const geoNotes = geoStruct.habitat?.notes || '';
      Object.assign(profile.habitat, geoStruct.habitat || {});
      profile.habitat.notes = [existingNotes, geoNotes].filter(Boolean).join(' ') || profile.habitat.notes;

      // Merge evidence — geoStruct.evidence is { habitat: { 'structuralElements.foo': [...] } }
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

      profile.metadata = profile.metadata || {};
      profile.metadata.lastGeospatialRun = new Date().toISOString();

      // Save to R2
      _state.currentProfile = profile;
      const res = await fetch(`${CF_WORKER_URL}/research/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lakeName: lake,
          profile,
          status: profile.metadata?.status || 'draft',
          approve: profile.metadata?.status === 'verified',
          verified: profile.metadata?.status === 'verified',
          requestedBy: 'Geospatial Adapter Rerun'
        })
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => '');
        throw new Error(`Save failed: ${res.status} ${msg.slice(0, 200)}`);
      }

      const fields = Object.keys(geoStruct.habitat?.structuralElements || {}).join(', ') || 'structure notes only';
      log(`[Geospatial] ✔ Done — fields: ${fields}`);
      await loadProfile(lake, true);
      alert(`Geospatial adapter complete.\nFields derived: ${fields}`);
    } catch (err) {
      log(`[Geospatial] ✗ ${err.message}`);
      alert(`Geospatial rerun failed: ${err.message}`);
    } finally {
      if (button) { button.disabled = false; button.textContent = '🗺️ Rerun Geospatial'; }
    }
  });


    // Standalone WQP limnology data fetch — no pipeline, just hits WQP for this lake
  if (!document.getElementById('btnRunWQP')) {
    const anchor = document.getElementById('btnRerunGeospatial') || document.getElementById('btnSmartPlanRecovery') || document.getElementById('btnResearch');
    if (anchor) {
      const wqpBtn = document.createElement('button');
      wqpBtn.id = 'btnRunWQP';
      wqpBtn.textContent = '💧 Run WQP';
      wqpBtn.title = 'Fetch WQP limnology data (thermocline, DO, Secchi, seasonal temp) and merge into profile. If WQP returns surface samples only, automatically runs a targeted guide article search for anecdotal thermocline depth — no pipeline required';
      wqpBtn.style.cssText = 'margin-left:8px; background:var(--panel2); color:var(--accent); border:1px solid var(--accent); padding:6px 12px; border-radius:4px; cursor:pointer; font-size:0.85em;';
      anchor.parentNode.insertBefore(wqpBtn, anchor.nextSibling);
    }
  }

  document.getElementById('btnRunWQP')?.addEventListener('click', async () => {
    const lake = _state.currentLakeName || document.getElementById('researchLakeSelect')?.value;
    if (!lake) { alert('Load a lake first'); return; }
    if (!_state.currentProfile) { alert('No profile loaded — load the lake profile first'); return; }
    const button = document.getElementById('btnRunWQP');
    if (button) { button.disabled = true; button.textContent = '⏳ Fetching…'; }

    // Local log helper that writes directly to the DOM element and forces visibility
    const wqpLog = (msg) => {
      _state.researchLog.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
      const el = document.getElementById('researchLog');
      if (el) {
        el.textContent = _state.researchLog.join('\n');
        el.scrollTop = el.scrollHeight;
        // Ensure parent panel is visible
        let p = el.parentElement;
        while (p && p !== document.body) {
          if (p.style.display === 'none') p.style.display = '';
          p = p.parentElement;
        }
      }
    };

    wqpLog(`[WQP] Fetching limnology data for ${lake}…`);
    try {
      const res = await fetch(`${CF_WORKER_URL}/research/limnology-data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lakeName: lake })
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => '');
        throw new Error(`WQP request failed: ${res.status} ${msg.slice(0, 200)}`);
      }
      const wqpData = await res.json();

      // ── Verbose response logging ──────────────────────────────────────────
      wqpLog(`[WQP] ─── Response for ${lake} ───`);
      wqpLog(`[WQP] Total records parsed: ${wqpData.recordCount ?? 0}`);
      wqpLog(`[WQP] Depth-profile records: ${wqpData.depthProfileCount ?? 0}`);
      wqpLog(`[WQP] Summer depth records: ${wqpData.summerRecords ?? 0}`);
      wqpLog(`[WQP] Last observed: ${wqpData.lastObserved || 'unknown'}`);
      if (wqpData.thermocline) {
        wqpLog(`[WQP] ✔ Thermocline: ${wqpData.thermocline.depthFt}ft — method: ${wqpData.thermocline.method} — evidence: ${wqpData.thermocline.evidenceCount} records — confidence: ${wqpData.thermocline.confidence}`);
      } else {
        wqpLog(`[WQP] ✗ Thermocline: not derived${wqpData.surfaceOnlyNote ? ' (surface samples only)' : ''}`);
      }
      if (wqpData.oxygen) {
        wqpLog(`[WQP] O2 anoxic below: ${wqpData.oxygen.anoxicBelowFt != null ? wqpData.oxygen.anoxicBelowFt + 'ft' : 'not derived'}`);
      }
      if (wqpData.secchi) {
        wqpLog(`[WQP] Secchi avg: ${wqpData.secchi.avgSecchiDepthFt}ft (n=${wqpData.secchi.sampleCount}, range ${wqpData.secchi.minSecchiDepthFt}–${wqpData.secchi.maxSecchiDepthFt}ft)`);
      } else {
        wqpLog(`[WQP] Secchi: no data`);
      }

      if (wqpData.seasonalTemp) {
        wqpLog(`[WQP] Seasonal temp — summer avg: ${wqpData.seasonalTemp.summerAvgTempF ?? 'n/a'}°F, peak: ${wqpData.seasonalTemp.peakSummerTempF ?? 'n/a'}°F, winter avg: ${wqpData.seasonalTemp.winterAvgTempF ?? 'n/a'}°F`);
      }
      if (wqpData.surfaceWater?.recentTempF != null) {
        wqpLog(`[WQP] Most recent surface temp: ${wqpData.surfaceWater.recentTempF}°F, DO: ${wqpData.surfaceWater.recentDissolvedOxygenMgL ?? 'n/a'} mg/L`);
      }
      if (wqpData.surfaceOnlyNote) {
        wqpLog(`[WQP] ⚠️ ${wqpData.surfaceOnlyNote}`);
      }
      if (!wqpData.thermocline) {
        wqpLog(`[WQP] Running guide article thermocline search…`);
      }
      if (wqpData.thermoclineAnecdotal) {
        wqpLog(`[WQP] ✔ Anecdotal thermocline from ${wqpData.thermoclineAnecdotal.sourceCount} article(s): ~${wqpData.thermoclineAnecdotal.summerThermoclineDepthFt}ft (confidence ${wqpData.thermoclineAnecdotal.confidenceScore}%)`);
        wqpLog(`[WQP] Anecdotal note: ${wqpData.thermoclineAnecdotal.note || 'none'}`);
      } else if (!wqpData.thermocline) {
        wqpLog(`[WQP] ✗ Guide article search: no thermocline depth found`);
      }
      if (wqpData.thermoclineSearch?.articles?.length) {
        wqpLog(`[WQP] Articles searched (${wqpData.thermoclineSearch.articles.length}):`);
        wqpData.thermoclineSearch.articles.forEach((a, i) => wqpLog(`[WQP]   ${i+1}. ${a.title} — ${a.url}`));
      }
      if (wqpData.thermoclineSearch?.queryResults?.length) {
        wqpLog(`[WQP] Query results:`);
        wqpData.thermoclineSearch.queryResults.forEach(q => wqpLog(`[WQP]   "${q.query}" → ${q.found ?? 0} results, ${q.added ?? 0} used${q.error ? ' ERROR: ' + q.error : ''}`));
      }
      if (wqpData.note && !wqpData.surfaceOnlyNote) wqpLog(`[WQP] Note: ${wqpData.note}`);
      wqpLog(`[WQP] ─────────────────────────────────`);

      if (!wqpData.ok || !wqpData.recordCount) {
        wqpLog(`[WQP] ⚠️ ${wqpData.note || wqpData.error || 'No data returned'}`);
        alert(`WQP returned no data for ${lake}.\n${wqpData.note || wqpData.error || ''}`);
        return;
      }

      // Merge into current profile
      const profile = cloneJson(_state.currentProfile);
      profile.limnology = profile.limnology || {};

      if (wqpData.thermocline) {
        profile.limnology.thermocline = profile.limnology.thermocline || {};
        profile.limnology.thermocline.summerDepthFt = wqpData.thermocline.depthFt ?? profile.limnology.thermocline.summerDepthFt;
        profile.limnology.thermocline.strength = wqpData.thermocline.strength ?? profile.limnology.thermocline.strength;
        profile.limnology.thermocline.confidence = 'measured';
        profile.limnology.thermocline.note = `WQP-derived from ${wqpData.recordCount} records (${wqpData.thermocline.method})`;
      }
      if (!wqpData.thermocline && wqpData.thermoclineAnecdotal) {
        profile.limnology.thermocline = profile.limnology.thermocline || {};
        profile.limnology.thermocline.summerDepthFt = wqpData.thermoclineAnecdotal.summerThermoclineDepthFt;
        profile.limnology.thermocline.depthRangeMin = wqpData.thermoclineAnecdotal.depthRangeMin ?? null;
        profile.limnology.thermocline.depthRangeMax = wqpData.thermoclineAnecdotal.depthRangeMax ?? null;
        profile.limnology.thermocline.confidence = 'low';
        profile.limnology.thermocline.confidenceScore = wqpData.thermoclineAnecdotal.confidenceScore;
        profile.limnology.thermocline.note = wqpData.thermoclineAnecdotal.note || null;
        profile.limnology.thermocline.warning = wqpData.thermoclineAnecdotal.warning;
      }
      if (wqpData.surfaceWater) {
        profile.limnology.surfaceWater = profile.limnology.surfaceWater || {};
        if (wqpData.surfaceWater.recentTempF != null) profile.limnology.surfaceWater.recentTempF = wqpData.surfaceWater.recentTempF;
        if (wqpData.surfaceWater.recentDissolvedOxygenMgL != null) profile.limnology.surfaceWater.recentDissolvedOxygenMgL = wqpData.surfaceWater.recentDissolvedOxygenMgL;
      }
      if (wqpData.secchi) {
        profile.limnology.waterClarity = profile.limnology.waterClarity || {};
        profile.limnology.waterClarity.secchiFt = wqpData.secchi.avgSecchiDepthFt;
        profile.limnology.waterClarity.secchiNote = `WQP avg from ${wqpData.secchi.sampleCount} samples (range ${wqpData.secchi.minSecchiDepthFt}–${wqpData.secchi.maxSecchiDepthFt}ft, last observed ${wqpData.secchi.lastObserved})`;
      }

      if (wqpData.seasonalTemp) {
        profile.limnology.surfaceWater = profile.limnology.surfaceWater || {};
        if (wqpData.seasonalTemp.summerAvgTempF != null) profile.limnology.surfaceWater.summerAvgTempF = wqpData.seasonalTemp.summerAvgTempF;
        if (wqpData.seasonalTemp.winterAvgTempF != null) profile.limnology.surfaceWater.winterAvgTempF = wqpData.seasonalTemp.winterAvgTempF;
        if (wqpData.seasonalTemp.peakSummerTempF != null) profile.limnology.surfaceWater.peakSummerTempF = wqpData.seasonalTemp.peakSummerTempF;
      }
      if (wqpData.oxygen) {
        profile.limnology.oxygen = profile.limnology.oxygen || {};
        if (wqpData.oxygen.depletionDepthFt != null) profile.limnology.oxygen.depletionDepthFt = wqpData.oxygen.depletionDepthFt;
        if (wqpData.oxygen.anoxicBelowFt != null) profile.limnology.oxygen.anoxicBelowFt = wqpData.oxygen.anoxicBelowFt;
      }

      profile.metadata = profile.metadata || {};
      profile.metadata.lastWQPRun = new Date().toISOString();
      profile.metadata.wqpRecordCount = wqpData.recordCount;

      _state.currentProfile = profile;
      const saveRes = await fetch(`${CF_WORKER_URL}/research/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lakeName: lake,
          profile,
          status: profile.metadata?.status || 'draft',
          approve: profile.metadata?.status === 'verified',
          verified: profile.metadata?.status === 'verified',
          requestedBy: 'WQP Standalone Run'
        })
      });
      if (!saveRes.ok) throw new Error(`Save failed: ${saveRes.status}`);

      const thermoMsg = wqpData.thermocline
        ? `thermocline ${wqpData.thermocline.depthFt}ft (measured)`
        : wqpData.thermoclineAnecdotal
          ? `thermocline ~${wqpData.thermoclineAnecdotal.summerThermoclineDepthFt}ft (anecdotal, confidence ${wqpData.thermoclineAnecdotal.confidenceScore}%)`
          : wqpData.surfaceOnlyNote ? 'surface samples only — no thermocline' : 'no thermocline derived';
      const secchiMsg = wqpData.secchi ? `secchi avg ${wqpData.secchi.avgSecchiDepthFt}ft` : '';

      const seasonalMsg = wqpData.seasonalTemp?.summerAvgTempF ? `summer avg ${wqpData.seasonalTemp.summerAvgTempF}°F` : '';
      const summary = [thermoMsg, secchiMsg, seasonalMsg].filter(Boolean).join(' | ');
      wqpLog(`[WQP] ✔ Saved — ${wqpData.recordCount} records — ${summary}`);
      await loadProfile(lake, true);
      alert(`WQP complete — ${wqpData.recordCount} records.\n${summary}`);
    } catch (err) {
      wqpLog(`[WQP] ✗ ${err.message}`);
      alert(`WQP fetch failed: ${err.message}`);
    } finally {
      if (button) { button.disabled = false; button.textContent = '💧 Run WQP'; }
    }
  });

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
    const picker = document.getElementById('refreshPicker');
    if (picker) picker.style.display = 'block';
  });
  document.getElementById('btnCancelRefresh')?.addEventListener('click', () => {
    const picker = document.getElementById('refreshPicker');
    if (picker) picker.style.display = 'none';
  });
  document.getElementById('btnDoRefresh')?.addEventListener('click', async () => {
    if (!_state.currentLakeName) { alert('Load a lake first'); return; }
    const picker = document.getElementById('refreshPicker');
    const selected = Array.from(document.querySelectorAll('#refreshPicker input[type="checkbox"]:checked')).map(el => el.value);
    if (!selected.length) { alert('Pick at least one section'); return; }
    if (picker) picker.style.display = 'none';
    log(`Refresh requested for sections: ${selected.join(', ')} — running full factual refresh from existing normalized docs.`);
    await runFromNormalized(_state.currentLakeName, { onComplete: loadProfile, onContradictions: renderContradictionsAlert });
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
    if (logEl) logEl.textContent = 'Log cleared.';
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
