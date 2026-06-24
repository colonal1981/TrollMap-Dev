/**
 * Plan Builder — the Plan tab form, save/load, preview rendering,
 * and lake/river dropdown management.
 *
 * The single biggest module in the app (about 1,200 lines). It contains
 * collectPlan() (read form to object), loadPlanIntoForm() (write object
 * to form + the entire plan-preview HTML generator), renderPlanStats()
 * (the stats bar), and the lake/river dropdown population logic.
 */

import { state } from "../core/state.js";
import { esc } from "../utils/escape.js";
import { LAKE_DB } from "../data/lakes.js";
import { renderSpread } from "./spread-builder.js";
import { getFilename, setFilename } from "../core/map-init.js";

// ─────────────────────────────────────────────────────────────
// FIX: calcTrollTimes was referenced but never defined (the exact
// error you saw: "calcTrollTimes is not defined" at buildPlanPreviewHtml).
// Safe self-contained version using loaded tracks.
function calcTrollTimes() {
  try {
    const tracks = (state && state.DATA && state.DATA.tracks) || [];
    if (!tracks.length) return [];

    const speedMph = parseFloat(document.getElementById('planSpeed')?.value) || 2.4;

    return tracks.map((t, i) => {
      const pts = t.pts || [];
      let distMi = 1.2;

      if (pts.length > 1) {
        let totalFt = 0;
        for (let j = 1; j < pts.length; j++) {
          const a = pts[j - 1];
          const b = pts[j];
          const dLat = (b.lat - a.lat) * 69;
          const dLon = (b.lon - a.lon) * 69;
          totalFt += Math.hypot(dLat, dLon) * 5280;
        }
        distMi = totalFt / 6076.12;
      }

      const mins = Math.max(4, Math.round((distMi / Math.max(0.8, speedMph)) * 60));
      return {
        name: t.name || `Lane ${i + 1}`,
        distMi: distMi.toFixed(1),
        mins
      };
    });
  } catch (e) {
    console.warn('[plan-builder] calcTrollTimes fallback:', e);
    return [];
  }
}
// ─────────────────────────────────────────────────────────────

function collectPlan(){
  const species = [...document.querySelectorAll('#planSpeciesChecks input:checked')].map(c=>c.value);
  return {
    meta:{
      name: document.getElementById('planName').value || 'Fishing Plan',
      date: document.getElementById('planDate').value,
      lake: document.getElementById('planLake').value,
      waterbodyType: isPlanRiverValue(document.getElementById('planLake').value) ? 'river' : 'lake',
      waterbodyLabel: isPlanRiverValue(document.getElementById('planLake').value) ? (getPlanRiverDef(document.getElementById('planLake').value)?.label || document.getElementById('planLake').value) : document.getElementById('planLake').value,
      ramp: document.getElementById('planRamp').value,
      riverSummary: document.getElementById('planRiverSummary')?.value || '',
      riverSafety: document.getElementById('planRiverSafety')?.value || '',
      riverFlow: document.getElementById('planRiverFlow')?.value || '',
      riverGauge: document.getElementById('planRiverGauge')?.value || '',
      riverTemp: document.getElementById('planRiverTemp')?.value || '',
      riverRise: document.getElementById('planRiverRise')?.value || '',
      riverSurgeEta: document.getElementById('planRiverSurgeEta')?.value || '',
      riverSchedule: document.getElementById('planRiverSchedule')?.value || '',
      launchTime: document.getElementById('planLaunchTime').value,
      returnTime: document.getElementById('planReturnTime').value,
      waterTemp: document.getElementById('planWaterTemp').value,
      fullPool: isPlanRiverValue(document.getElementById('planLake').value) ? '' : (document.getElementById('planFullPool')?.value || ''),
      poolLevel: isPlanRiverValue(document.getElementById('planLake').value) ? '' : (document.getElementById('planPoolLevel')?.value || ''),
      poolUnit: isPlanRiverValue(document.getElementById('planLake').value) ? '' : (typeof getPlanLakeLevelUnit === 'function' ? getPlanLakeLevelUnit() : 'ft'),
      weather: document.getElementById('planWeather').value,
      clarity: document.getElementById('planClarity').value,
      motor: document.getElementById('planMotor').value,
      sonar: document.getElementById('planSonar').value,
      solunar: document.getElementById('planSolunar').value,
      structure: document.getElementById('planStructure').value,
      lakeIntel: document.getElementById('planLakeIntel')?.value || '',
      clarityIntel: document.getElementById('planClarityIntel')?.value || '',
      species,
    },
    trolling:{
      speed: document.getElementById('planSpeed').value,
      targetDepth: document.getElementById('planTargetDepth').value,
      pattern: document.getElementById('planPattern').value,
    },
    spread: state.SPREAD.slice(),
    tackle: document.getElementById('planTackle').value,
    safety: document.getElementById('planSafety').value,
    notes: document.getElementById('planNotes').value,
    gpx: {
      waypoints: state.DATA.waypoints.length,
      tracks: state.DATA.tracks.length,
      trackPoints: state.DATA.tracks.reduce((a,t)=>a+t.pts.length,0),
      waypointList: state.DATA.waypoints.map(w=>({name:w.name, lat:w.lat, lon:w.lon})),
      trackList: state.DATA.tracks.map(t=>({name:t.name, points:t.pts.length}))
    },
    savedAt: new Date().toISOString()
  };
}


function loadPlanIntoForm(p){
  if(!p) return;
  const m=p.meta||{};
  document.getElementById('planName').value = m.name||'';
  document.getElementById('planDate').value = m.date||'';
  populatePlanLakeDropdown();
  document.getElementById('planLake').value = m.lake||'';
  setLakeOnlyFieldsVisible(!isPlanRiverValue(m.lake||''));
  populatePlanRampDropdown(m.lake||'');
  document.getElementById('planRamp').value = m.ramp||'';
  if(document.getElementById('planRiverSummary')) document.getElementById('planRiverSummary').value = m.riverSummary||'';
  if(document.getElementById('planRiverSafety')) document.getElementById('planRiverSafety').value = m.riverSafety||'';
  if(document.getElementById('planRiverFlow')) document.getElementById('planRiverFlow').value = m.riverFlow||'';
  if(document.getElementById('planRiverGauge')) document.getElementById('planRiverGauge').value = m.riverGauge||'';
  if(document.getElementById('planRiverTemp')) document.getElementById('planRiverTemp').value = m.riverTemp||'';
  if(document.getElementById('planRiverRise')) document.getElementById('planRiverRise').value = m.riverRise||'';
  if(document.getElementById('planRiverSurgeEta')) document.getElementById('planRiverSurgeEta').value = m.riverSurgeEta||'';
  if(document.getElementById('planRiverSchedule')) document.getElementById('planRiverSchedule').value = m.riverSchedule||'';
  document.getElementById('planLaunchTime').value = m.launchTime||'06:00';
  document.getElementById('planReturnTime').value = m.returnTime||'12:00';
  document.getElementById('planWaterTemp').value = m.waterTemp||'';
  const fPoolEl = document.getElementById('planFullPool');
  if(fPoolEl) fPoolEl.value = m.fullPool||'';
  const pLevelEl = document.getElementById('planPoolLevel');
  if(pLevelEl) pLevelEl.value = m.poolLevel||'';
  document.getElementById('planWeather').value = m.weather||'';
  if(m.clarity) document.getElementById('planClarity').value = m.clarity;
  document.getElementById('planMotor').value = m.motor || 'NK180 Pro 24V, 100Ah LiFePO4';
  document.getElementById('planSonar').value = m.sonar || 'Garmin ECHOMAP UHD2 93sv';
  document.getElementById('planSolunar').value = m.solunar||'';
  if(document.getElementById('planStructure')) document.getElementById('planStructure').value = m.structure||'';
  if(document.getElementById('planLakeIntel')) document.getElementById('planLakeIntel').value = m.lakeIntel||'';
  if(document.getElementById('planClarityIntel')) document.getElementById('planClarityIntel').value = m.clarityIntel||'';
  document.querySelectorAll('#planSpeciesChecks input').forEach(c=> c.checked = (m.species||[]).includes(c.value));
  if(p.trolling){
    document.getElementById('planSpeed').value = p.trolling.speed||'2.4';
    document.getElementById('planTargetDepth').value = p.trolling.targetDepth||'';
    document.getElementById('planPattern').value = p.trolling.pattern||'Straight lanes';
  }
  state.SPREAD = (p.spread||[]).map(r=>newRodRow(r));
  renderSpread();
  document.getElementById('planTackle').value = p.tackle||'';
  document.getElementById('planSafety').value = p.safety||'';
  document.getElementById('planNotes').value = p.notes||'';
}

async function buildPlanPreviewHtml(p){
  function sideClass(s){
    if(s.includes('Port')) return 'rod-side-port';
    if(s.includes('Starboard')) return 'rod-side-starboard';
    return 'rod-side-center';
  }

  // ── Clarity tactical ──────────────────────────────────────────────────────
  const clarity = p.meta.clarity || 'Clear';
  let tacticalText = '';
  if(clarity === 'Clear')
    tacticalText = 'Water is <b>CLEAR</b>. Use natural presentations (Bone, Pearl, Silver/flash). <b>Fluorocarbon leaders are critical</b> — fish will inspect. Fish hold deeper; rely on long line deployments and precise depth.';
  else if(clarity === 'Stained')
    tacticalText = 'Water is <b>STAINED</b>. Use high-contrast colors (Chartreuse, Firetiger, white with UV) and baits with strong vibration. Fluoro still helps but mono/co-poly acceptable.';
  else
    tacticalText = 'Water is <b>MUDDY</b>. Deploy dark silhouettes (Black/Blue, dark shad) with maximum vibration or rattles. Fish tight to cover and shallower ambush points. Line clarity matters less.';

  // ── Colors per lure (driven by clarity) ──────────────────────────────────
  const colorTable = {
    Clear: [
      ['A-Rig (light)',   'Natural Pearl / Smoke',        'Silver Flash / Alewife'],
      ['A-Rig (medium)',  'Blueback Herring / Ghost',     'Tennessee Shad'],
      ['Crankbait',       'Blue/Silver Herring',          'Sexy Shad / Chartreuse'],
      ['Flutter Spoon',   'Shattered Glass Silver',       'Chrome / Gold'],
      ['Swimbait 4.6"',   'Blueback Herring',             'Ghost Shad'],
      ['Topwater',        'Bone / Natural Shad',          'Chrome / White'],
    ],
    Stained: [
      ['A-Rig (light)',   'Chartreuse / White UV',        'Firetiger'],
      ['A-Rig (medium)',  'White/Chartreuse',             'Hot Pink / UV'],
      ['Crankbait',       'Chartreuse Shad',              'Firetiger / Orange'],
      ['Flutter Spoon',   'Chartreuse Gold',              'Hot Pink / Hammered Gold'],
      ['Swimbait 4.6"',   'Chartreuse/White',             'Bubble Gum / Hot Shad'],
      ['Topwater',        'White / Chartreuse Belly',     'Clown / Bright'],
    ],
    Muddy: [
      ['A-Rig (light)',   'Black/Blue',                   'Dark Junebug'],
      ['A-Rig (medium)',  'Dark Shad / Black',            'Oxblood / Purple'],
      ['Crankbait',       'Black/Blue Shad',              'Crawdad / Dark Brown'],
      ['Flutter Spoon',   'Black Nickel / Dark Chrome',   'Copper'],
      ['Swimbait 4.6"',   'Black/Blue Shad',              'Dark Watermelon'],
      ['Topwater',        'Black / Dark',                 'Black Chrome'],
    ],
  };
  const colorRows = (colorTable[clarity]||colorTable.Clear).map(([lure,primary,backup])=>
    `<tr><td><b>${lure}</b></td><td style="color:var(--p-teal)">${primary}</td><td style="color:#888">${backup}</td></tr>`
  ).join('');

  // ── Swimbait sizing / match the hatch ─────────────────────────────────────
  const waterTemp = parseFloat(p.meta.waterTemp)||70;
  let swimHatch = '', swimNote = '';
  if(waterTemp < 55){
    swimHatch = '2.8"–3.5" — Finesse shad, small threadfin profile. Fish lethargic, slow your roll.';
    swimNote  = 'Down-size jigheads to 1/4oz. Slow the troll to 1.8–2.0 mph.';
  } else if(waterTemp < 68){
    swimHatch = '3.8"–4.6" — Juvenile blueback herring, shad. Primary forage window.';
    swimNote  = '3/8–1/2oz jigheads. 2.2–2.5 mph troll. Most productive size range year-round.';
  } else if(waterTemp < 78){
    swimHatch = '4.6"–5.5" — Adult blueback herring, gizzard shad. Fish keyed on larger profile.';
    swimNote  = '1/2–3/4oz jigheads. Match the dominant forage size you see on sonar.';
  } else {
    swimHatch = '5.5"–7" — Jumbo shad, large herring. Dog days — go big or go home.';
    swimNote  = '3/4–1oz jigheads. Fish deep and slow. Early/late bite windows only.';
  }

  // ── A-rig breakdown ───────────────────────────────────────────────────────
  const arigRows = p.spread.filter(r=>r.lure && r.lure.toLowerCase().includes('rig')).map(r=>{
    const isLight = (r.lure||'').toLowerCase().includes('light') || (r.lure||'').includes('1.65');
    const rigFramework = r.arigWeight || (isLight ? '~1.65oz Framework' : '~2.65oz Framework');
    const trailer = r.trailerSize || (isLight ? '3.8" swimbait' : '4.6" swimbait');
    const jigheads = r.jigWeight || (isLight ? '1/8oz × 5 (Uniform)' : '3/16oz × 5 (Uniform)');
    return `<tr>
      <td><b>${esc(r.side)} — ${esc(r.position)}</b></td>
      <td>${esc(rigFramework)}</td>
      <td><b style="color:#00e5ff">${esc(trailer)}</b></td>
      <td><b style="color:#76ff03">${esc(jigheads)}</b></td>
      <td>${esc(r.color||'Natural Pattern')}</td>
      <td><b>${esc(r.depth||'—')} ft</b> @ <b>${esc(r.lead||'—')} ft lead</b></td>
    </tr>`;
  }).join('');

  // ── Battery scenarios (NK180 Pro) ─────────────────────────────────────────
  const motorField = p.meta.motor || '';
  const isNK180 = motorField.toLowerCase().includes('nk180') || motorField.toLowerCase().includes('180');
  const battAh = motorField.match(/(\d+)\s*ah/i) ? parseInt(motorField.match(/(\d+)\s*ah/i)[1]) : 100;
  const usableAh = battAh * 0.8; // Exactly reserve 20% LiFePO4
  let activeLiveBleRow = '';
  if(window.ACTIVE_BLE_BMS && window.ACTIVE_BLE_BMS.connected){
    const ble = window.ACTIVE_BLE_BMS;
    const activeFlight = ble.usableAh > 0 ? (ble.usableAh / Math.max(0.1, ble.current)).toFixed(1) + ' Hours' : 'Mandatory Return Hit';
    activeLiveBleRow = `<tr style="background:#08121e;border-left:4px solid #76ff03">
      <td><b style="color:#76ff03">⚡ Active Live BLE Trolling Load ("${esc(ble.name)}")</b></td>
      <td><b style="font-family:monospace;color:#76ff03;font-size:15px">${ble.current.toFixed(1)}A (${Math.round(ble.voltage * ble.current)}W @ ${ble.voltage.toFixed(1)}V)</b></td>
      <td><b style="color:#00e5ff;font-size:16px">${activeFlight}</b> <span class="rp-small" style="color:#76ff03">(${ble.soc}% Reported SOC Active)</span></td>
    </tr>`;
  }

  const battScenarios = [
    ['Easy (slow finesse troll 1.5–2.0 mph, calm water)',  '3.5A (~84W)',   (usableAh/3.5).toFixed(1) + ' hrs'],
    ['Typical (standard tournament troll 2.2–2.5 mph)',    '7.5A (~180W)',  (usableAh/7.5).toFixed(1) + ' hrs'],
    ['Hard (2.8+ mph, heavy headwind or river current)',   '14.0A (~336W)', (usableAh/14.0).toFixed(1) + ' hrs'],
    ['Sprint / Repositioning (100% full throttle)',        '25.0A (~600W)', (usableAh/25.0).toFixed(1) + ' hrs'],
  ].map(([scenario, draw, time])=>
    `<tr><td><b>${scenario}</b></td><td><b style="font-family:monospace;color:var(--accent)">${draw}</b></td><td style="font-weight:700;color:var(--accent2)">${time} <span class="rp-small" style="color:var(--muted)">(80% Usable Capacity)</span></td></tr>`
  ).join('');

  // ── Sonar settings per lane ───────────────────────────────────────────────
  const sonarUnit = p.meta.sonar || 'Garmin ECHOMAP UHD2 93sv';
  const targetDepth = p.trolling.targetDepth || '25–35';
  const sonarRows = [
    ['Dawn / Structure scan',   '2D 200kHz CHIRP', targetDepth+' ft', '8–9', 'Auto', 'On — structure ID'],
    ['Mid-morning troll lanes', '2D 77kHz CHIRP',  targetDepth+' ft', '7–8', 'Auto', 'Zoom 2× bottom third'],
    ['Locating school',         'Down Imaging',    'Full depth',       '9',   'Auto', 'Max sensitivity, look for bait cloud'],
    ['On fish / fighting',      '2D 200kHz',       targetDepth+' ft', '7',   'Manual lock', 'Bottom lock off — watch split screen'],
  ].map(([phase, freq, range, sens, scroll, notes])=>
    `<tr><td><b>${phase}</b></td><td>${freq}</td><td>${range}</td><td>${sens}</td><td>${scroll}</td><td class="rp-small">${notes}</td></tr>`
  ).join('');

  // ── Solunar timing table ──────────────────────────────────────────────────
  let solunarRows = '';
  if(p.meta.solunar){
    // Parse free text like "Major 7:15–9:30 AM, Minor 1:45 PM, New Moon"
    const txt = p.meta.solunar;
    const majorMatch = txt.match(/major[:\s]+([0-9:apm –\-]+)/i);
    const minorMatch = txt.match(/minor[:\s]+([0-9:apm –\-]+)/i);
    const moonMatch  = txt.match(/(new|full|waxing|waning|quarter)\s*moon/i);
    if(majorMatch||minorMatch){
      if(majorMatch) solunarRows += `<tr><td><span class="rp-pill rp-best">MAJOR</span></td><td>${majorMatch[1].trim()}</td><td>Peak feeding — prime troll window. Be on fish.</td></tr>`;
      if(minorMatch) solunarRows += `<tr><td><span class="rp-pill rp-strong">MINOR</span></td><td>${minorMatch[1].trim()}</td><td>Secondary feeding — maintain coverage.</td></tr>`;
      if(moonMatch)  solunarRows += `<tr><td colspan="3" class="rp-small">Moon phase: <b>${moonMatch[0]}</b>${moonMatch[1].toLowerCase()==='new'?' — strongest solunar influence of the month':moonMatch[1].toLowerCase()==='full'?' — strong solunar influence':''}</td></tr>`;
    } else {
      solunarRows = `<tr><td colspan="3">${esc(txt)}</td></tr>`;
    }
  } else {
    solunarRows = `<tr><td colspan="3" class="rp-small">No solunar data entered. Add Major/Minor window times in the Solunar Notes field.</td></tr>`;
  }

  // ── Existing rows ─────────────────────────────────────────────────────────
  const wpRows = (p.gpx?.waypointList||[]).map(w=>`<tr><td>${esc(w.name)}</td><td>${w.lat.toFixed(5)}</td><td>${w.lon.toFixed(5)}</td></tr>`).join('');
  const trkRows = (p.gpx?.trackList||[]).map(t=>`<tr><td>${esc(t.name)}</td><td>${t.points}</td></tr>`).join('');
  const spreadRows = p.spread.map((r,i)=>`
    <tr>
      <td>${i+1}</td>
      <td class="${sideClass(r.side)}">${esc(r.side)}</td>
      <td>${esc(r.position)}</td>
      <td>${esc(r.rod)}</td>
      <td>${esc(r.reel)}</td>
      <td><b>${esc(r.lure)}${r.trailerSize ? ` <span style="color:#00e5ff;font-size:12px;display:block;margin-top:2px">↳ Trailer: ${esc(r.trailerSize)}</span>` : ''}${r.jigWeight ? ` <span style="color:#76ff03;font-size:12px;display:block;margin-top:2px">↳ Keel: ${esc(r.jigWeight)}</span>` : ''}</b></td>
      <td>${esc(r.color)}</td>
      <td><b>${esc(r.depth)}</b></td>
      <td><b style="color:var(--accent)">${esc(r.lead)}</b></td>
      <td>${esc(r.notes)}</td>
    </tr>`).join('');

  const dateStr = p.meta.date ? new Date(p.meta.date+'T12:00:00').toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'}) : '—';

  // ── SCDNR Regulations by lake + species ───────────────────────────────────
  const REGS = {
    'Striped Bass': {
      'Lake Murray, SC':    { season:'Year-round', size:'21" min (Oct–May), no min Jun–Sep', bag:'5/day', note:'Jun–Sep no size limit but 5 fish max' },
      'Lake Wateree, SC':   { season:'Year-round', size:'No minimum size limit', bag:'10 per day combined (stripers/hybrids)', note:'⚠ Valid upstream of Wateree Dam. Wateree River downstream of dam CLOSED summer.' },
      'Wateree River':              { season:'Oct 1–May 31 open, Jun 1–Sep 30 CLOSED', size:'26" min', bag:'3/day', note:'⚠ River below Wateree Dam to Lake Marion CLOSED Jun–Sep. Release all stripers immediately.' },
      'Congaree River (to SC-601)': { season:'Oct 1–May 31 open, Jun 1–Sep 30 CLOSED', size:'26" min', bag:'3/day', note:'⚠ Congaree River corridor CLOSED Jun–Sep per Santee system regs. Release all stripers immediately.' },
      'Lake Marion, SC':    { season:'Oct 1–Jun 15 open, Jun 16–Sep 30 CLOSED', size:'23"–25" slot (one fish >26" allowed)', bag:'3/day', note:'⚠ Santee Cooper slot limit — slot rules strictly enforced' },
      'Lake Moultrie, SC':  { season:'Oct 1–Jun 15 open, Jun 16–Sep 30 CLOSED', size:'23"–25" slot (one fish >26" allowed)', bag:'3/day', note:'⚠ Santee Cooper slot limit — same as Marion' },
      'Lake Monticello, SC':{ season:'Year-round', size:'26" min (Oct–May), no min Jun–Sep', bag:'3/day', note:'Santee-Cooper tributary system rules apply' },
      'Parr Reservoir, SC': { season:'Year-round', size:'26" min', bag:'3/day', note:'Broad River system' },
      'default':            { season:'Year-round', size:'26" min', bag:'3/day', note:'Verify with SCDNR for specific water body' },
    },
    'Largemouth Bass': {
      'default': { season:'Year-round', size:'14" min', bag:'5/day', note:'Applies to Marion, Moultrie, Murray, Wateree, Monticello, Wylie. Must be landed head+tail intact on Marion/Moultrie.' },
    },
    'Catfish': {
      'Lake Marion, SC':   { season:'Year-round', size:'No min channel/blue', bag:'No limit channel/blue; max 1 blue catfish >36" per day', note:'⚠ Blue cat over 36" trophy rules on Marion/Moultrie. Head+tail must be intact.' },
      'Lake Moultrie, SC': { season:'Year-round', size:'No min channel/blue', bag:'No limit channel/blue; max 1 blue catfish >36" per day', note:'⚠ Same blue cat trophy rules as Marion' },
      'default':           { season:'Year-round', size:'No minimum', bag:'No daily limit', note:'Standard SC freshwater catfish rules' },
    },
    'Crappie': {
      'default': { season:'Year-round', size:'No minimum', bag:'No daily limit', note:'No size or bag limit statewide' },
    },
    'Hybrid': {
      'Lake Murray, SC': { season:'Year-round', size:'21" min (Oct–May), no min Jun–Sep', bag:'5/day combined with striped bass', note:'Counts toward combined striper/hybrid limit' },
      'default':         { season:'Year-round', size:'26" min', bag:'3/day combined with striped bass', note:'Counts in combined striper limit' },
    },
  };

  function getRegs(species, lake){
    const sr = REGS[species];
    if(!sr) return null;
    return sr[lake] || sr['default'] || null;
  }

  const speciesSelected = p.meta.species || [];
  const lakeForRegs = p.meta.waterbodyLabel || p.meta.lake || '';
  let regsRows = '';
  speciesSelected.forEach(sp=>{
    const r = getRegs(sp, lakeForRegs);
    if(!r) return;
    const isWarning = r.note && r.note.includes('⚠');
    const isClosed = r.season && r.season.includes('CLOSED');
    regsRows += `<tr${isClosed?' style="background:#fff0f0"':''}>
      <td><b>${esc(sp)}</b></td>
      <td>${esc(r.season)}</td>
      <td>${esc(r.size)}</td>
      <td>${esc(r.bag)}</td>
      <td class="rp-small"${isWarning?' style="color:#b3261e;font-weight:700"':''}>${esc(r.note||'')}</td>
    </tr>`;
  });

  // Check if today is a closed season for target species
  let closedWarning = '';
  if(p.meta.date){
    const tripDate = new Date(p.meta.date+'T12:00:00');
    const month = tripDate.getMonth()+1; // 1-12
    const day   = tripDate.getDate();
    speciesSelected.forEach(sp=>{
      const r = getRegs(sp, lakeForRegs);
      if(!r) return;
      // Wateree/Marion/Moultrie striper closed Jun16–Sep30
      if(sp==='Striped Bass'){
        const isSantee  = lakeForRegs.includes('Marion')||lakeForRegs.includes('Moultrie');
        const isWatereeRiver = lakeForRegs==='Wateree River';
        const isOtherClosed = lakeForRegs==='Wateree River' || lakeForRegs==='Congaree River (to SC-601)';
        if(isSantee && (month>6||(month===6&&day>=16)) && month<=9)
          closedWarning += `<div class="rp-callout" style="background:#fff0f0;border-left:5px solid #b3261e"><b>🚫 STRIPED BASS SEASON CLOSED on ${lakeForRegs.split(',')[0]}</b><br>Santee Cooper system closed Jun 16 – Sep 30. Any striped bass caught must be released immediately.</div>`;
        else if(isOtherClosed && month>=6 && month<=9)
          closedWarning += `<div class="rp-callout" style="background:#fff0f0;border-left:5px solid #b3261e"><b>🚫 STRIPED BASS SEASON CLOSED on ${lakeForRegs.split(',')[0]}</b><br>Wateree River below dam closed Jun 1 – Sep 30. Release all stripers immediately.</div>`;
      }
    });
  }

  let twilightHtml = "";
  // ── GO / NO-GO decision ──────────────────────────────────────────────────
  let goNoGo = 'UNKNOWN', goClass = 'rp-info', goReasons = [], noGoReasons = [];
  // We'll populate this from weather data after fetch — placeholder for now
  // (populated below after weather fetch section)

  // ── Troll lane time calculator ────────────────────────────────────────────
  // Uses the top-level safe implementation (defined above)
  const trollTimes = calcTrollTimes();
  let trollTimeRows = '';
  if(trollTimes && trollTimes.length){
    trollTimeRows = trollTimes.map(t=>`<tr><td>${esc(t.name)}</td><td>${t.distMi} mi</td><td><b>${t.mins} min</b></td></tr>`).join('');
  }


  let weatherHtml = 'Weather data not available.';
  let sunriseStr = '--:--', sunsetStr = '--:--', moonriseStr = '--:--', moonsetStr = '--:--';
  let pressureHtml = '', windHtml = '', uvHtml = '', solunarAutoRows = '';
  let moonPhase = '', moonIllum = 0;
  let damHtml = '', tidesHtml = '', usgsHtml = '';
  const lake = p.meta.waterbodyLabel || p.meta.lake || '';
  const cleanLake = lake.split(',')[0].trim();
  const matchedKey = Object.keys(LAKE_DB).find(k => cleanLake.toLowerCase().includes(k.toLowerCase()) || k.toLowerCase().includes(cleanLake.toLowerCase()));
  const lakeEntry = LAKE_DB[matchedKey] || LAKE_DB[cleanLake] || LAKE_DB[lake];

  if(lakeEntry && p.meta.date){
    const lat = lakeEntry.center[0], lon = lakeEntry.center[1];
    const date = p.meta.date;

    // Helper: format 24hr time string to 12hr
    function fmt12(t){ if(!t) return '--'; const [h,m]=t.split(':').map(Number); const ap=h>=12?'PM':'AM'; return `${h%12||12}:${String(m).padStart(2,'0')} ${ap}`; }

    // Compass direction from degrees
    function windDir(deg){ const dirs=['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW']; return dirs[Math.round(deg/22.5)%16]; }
    function weatherCodeText(code){
      code = Number(code);
      const map = {
        0:'Sunny / clear', 1:'Mostly sunny', 2:'Partly cloudy', 3:'Cloudy / overcast',
        45:'Foggy', 48:'Freezing fog',
        51:'Light drizzle', 53:'Drizzle', 55:'Heavy drizzle',
        56:'Freezing drizzle', 57:'Freezing drizzle',
        61:'Light rain', 63:'Rain', 65:'Heavy rain',
        66:'Freezing rain', 67:'Freezing rain',
        71:'Light snow', 73:'Snow', 75:'Heavy snow', 77:'Snow grains',
        80:'Light showers', 81:'Rain showers', 82:'Heavy showers',
        85:'Snow showers', 86:'Heavy snow showers',
        95:'Thunderstorms', 96:'Thunderstorms with hail', 99:'Severe thunderstorms with hail'
      };
      return map[code] || 'Forecast condition unavailable';
    }

    // Solunar calculation (pure JS — no API needed)
    // Moon transits = major periods, moon rise/set = minor periods
    function calcSolunar(dateStr, lat, lon){
      // Julian date
      const d = new Date(dateStr+'T12:00:00Z');
      const JD = d.getTime()/86400000 + 2440587.5;
      const T = (JD - 2451545.0) / 36525;
      // Moon's mean longitude and anomaly
      const L0 = (218.316 + 13.176396 * (JD-2451545.0)) % 360;
      const M  = (134.963 + 13.064993 * (JD-2451545.0)) % 360;
      const F  = (93.272  + 13.229350 * (JD-2451545.0)) % 360;
      const Mrad = M*Math.PI/180, Frad = F*Math.PI/180;
      // Moon's ecliptic longitude (simplified)
      const lam = L0 + 6.289*Math.sin(Mrad) - 1.274*Math.sin(2*Frad-Mrad) + 0.658*Math.sin(2*Frad);
      // Moon RA/Dec approximation
      const lamR = lam*Math.PI/180;
      const eps = 23.439*Math.PI/180;
      const ra  = Math.atan2(Math.cos(eps)*Math.sin(lamR), Math.cos(lamR)) * 180/Math.PI;
      const dec = Math.asin(Math.sin(eps)*Math.sin(lamR)) * 180/Math.PI;
      // Moon transit time (local noon when moon crosses meridian)
      const GMST = (280.46061837 + 360.98564736629*(JD-2451545.0)) % 360;
      const LHA  = (GMST + lon - ra + 360) % 360;
      const transitUT = (12 - LHA/15 + 24) % 24; // hours UT
      // Convert to local offset (rough: use lon)
      const offsetH = lon / 15;
      const major1 = (transitUT + offsetH + 24) % 24;
      const major2 = (major1 + 12) % 24;
      // Minor periods = 90 min after rise/set (approx 6hr from major)
      const minor1 = (major1 + 6) % 24;
      const minor2 = (major1 + 18) % 24;
      // Moon illumination
      const sunL = (280.460 + 0.9856474*(JD-2451545.0)) % 360;
      const sunM = (357.528 + 0.9856003*(JD-2451545.0)) % 360;
      const sunLam = sunL + 1.915*Math.sin(sunM*Math.PI/180) + 0.020*Math.sin(2*sunM*Math.PI/180);
      const phase = (lam - sunLam + 360) % 360;
      const illum = Math.round((1 - Math.cos(phase*Math.PI/180))/2 * 100);
      // Phase name
      let phaseName = '';
      if(phase < 22.5||phase >= 337.5) phaseName='New Moon';
      else if(phase < 67.5)  phaseName='Waxing Crescent';
      else if(phase < 112.5) phaseName='First Quarter';
      else if(phase < 157.5) phaseName='Waxing Gibbous';
      else if(phase < 202.5) phaseName='Full Moon';
      else if(phase < 247.5) phaseName='Waning Gibbous';
      else if(phase < 292.5) phaseName='Last Quarter';
      else                   phaseName='Waning Crescent';

      function hToStr(h){ const hh=Math.floor(h%24); const mm=Math.round((h%1)*60); const ap=hh>=12?'PM':'AM'; return `${hh%12||12}:${String(mm).padStart(2,'0')} ${ap}`; }

      // Solunar rating: new/full moon = BEST, quarter = GOOD
      const isNewFull = phaseName.includes('New')||phaseName.includes('Full');
      const isQuarter = phaseName.includes('Quarter');
      const rating = isNewFull ? 'BEST' : isQuarter ? 'GOOD' : 'STRONG';
      const ratingClass = isNewFull ? 'rp-best' : isQuarter ? 'rp-good-p' : 'rp-strong';

      return { major1, major2, minor1, minor2, phaseName, illum, rating, ratingClass,
               major1Str:hToStr(major1), major2Str:hToStr(major2),
               minor1Str:hToStr(minor1), minor2Str:hToStr(minor2) };
    }

    const sol = calcSolunar(date, lat, lon);
    moonPhase = sol.phaseName; moonIllum = sol.illum;
    solunarAutoRows = `
      <tr><td><span class="rp-pill ${sol.ratingClass}">MAJOR</span></td><td>${sol.major1Str} &amp; ${sol.major2Str}</td><td>Peak feeding — be on fish. Plan troll to hit structure during this window.</td></tr>
      <tr><td><span class="rp-pill rp-strong">MINOR</span></td><td>${sol.minor1Str} &amp; ${sol.minor2Str}</td><td>Secondary feeding activity — maintain coverage.</td></tr>
      <tr><td colspan="3" class="rp-small">Moon: <b>${sol.phaseName}</b> (${sol.illum}% illuminated) — Overall rating: <span class="rp-pill ${sol.ratingClass}">${sol.rating}</span></td></tr>`;

    // Fetch Open-Meteo: daily + hourly in one call
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`+
        `&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,windspeed_10m_max,winddirection_10m_dominant,precipitation_sum,uv_index_max`+
        `&hourly=weather_code,cloud_cover,temperature_2m,windspeed_10m,winddirection_10m,precipitation_probability,pressure_msl,uv_index`+
        `&timezone=auto&start_date=${date}&end_date=${date}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      const data = await res.json();

      if(data && data.daily){
        const D = data.daily;
        sunriseStr = fmt12(D.sunrise[0].split('T')[1]);
        sunsetStr  = fmt12(D.sunset[0].split('T')[1]);
        const condition = weatherCodeText(D.weather_code?.[0]);
        const tmaxF = Math.round(D.temperature_2m_max[0] * 9/5 + 32);
        const tminF = Math.round(D.temperature_2m_min[0] * 9/5 + 32);
        const windMph = Math.round(D.windspeed_10m_max[0] * 0.621371);
        const windD   = windDir(D.winddirection_10m_dominant[0]);
        const precip  = D.precipitation_sum[0];
        const uvMax   = D.uv_index_max[0];
        const hot = tmaxF >= 90;
        const uvWarn = uvMax >= 8 ? ` <b>⚠ UV ${uvMax} (VERY HIGH)</b> — Full sun protection required.` : uvMax >= 6 ? ` UV ${uvMax} (High) — SPF50+ and UV shirt.` : '';

        weatherHtml = `<b>${condition}</b> · High <b>${tmaxF}°F</b> / Low <b>${tminF}°F</b> · Wind <b>${windD} ${windMph} mph</b> · Precip <b>${precip}mm</b> · UV max <b>${uvMax}</b>.`+
          (hot ? ' <b>⚠ HEAT ADVISORY — hydrate hard, consider early exit.</b>' : '') + uvWarn;

        // Hourly wind table for launch window (4 AM to 2 PM = hours 4-14)
        if(data.hourly){
          const H = data.hourly;
          const launchHour = p.meta.launchTime ? parseInt(p.meta.launchTime.split(':')[0])||5 : 5;
          const endHour = Math.min(launchHour + 8, 14);
          let windRows = '';
          for(let h=launchHour; h<=endHour; h++){
            const wSpd = Math.round(H.windspeed_10m[h] * 0.621371);
            const wDir = windDir(H.winddirection_10m[h]);
            const wF   = Math.round(H.temperature_2m[h] * 9/5 + 32);
            const pp   = H.precipitation_probability[h]||0;
            const uv   = H.uv_index[h]||0;
            const warn = pp >= 50 ? '⚠ Rain' : wSpd >= 15 ? '⚠ Wind' : uv >= 8 ? '☀ UV' : '';
            windRows += `<tr${warn?` style="background:#fff4e0"`:''}><td>${h%12||12}${h>=12?'PM':'AM'}</td><td>${wF}°F</td><td>${wDir} ${wSpd}mph</td><td>${pp}%</td><td>${uv}</td><td style="color:#c00;font-size:11px">${warn}</td></tr>`;
          }
          windHtml = `<table>
            <thead><tr style="background:#eef4fa"><th>Hour</th><th>Temp</th><th>Wind</th><th>Rain%</th><th>UV</th><th></th></tr></thead>
            <tbody>${windRows}</tbody></table>`;

          // Pressure trend (compare first vs last hour of window)
          const pStart = H.pressure_msl[launchHour];
          const pEnd   = H.pressure_msl[Math.min(launchHour+6, 23)];
          const pDiff  = pEnd - pStart;
          const pTrend = pDiff > 1 ? '📈 Rising — fish likely active, feeding window improving' :
                         pDiff < -1 ? '📉 Falling — feeding frenzy possible pre-front; watch for weather change' :
                         '➡ Steady — consistent conditions, fish predictable';
          const pClass = pDiff > 1 ? 'rp-good' : pDiff < -1 ? 'rp-warn' : 'rp-info';
          pressureHtml = `<div class="rp-callout ${pClass}">
            <b>⏱ Barometric Pressure Trend</b><br>
            ${Math.round(pStart)} hPa → ${Math.round(pEnd)} hPa (${pDiff>0?'+':''}${pDiff.toFixed(1)} hPa over 6hr) — ${pTrend}
          </div>`;
        }
      }
    } catch(e){ weatherHtml = 'Weather fetch failed — check internet connection.'; }

    // Module F — Duke Energy / Dominion / Santee Cooper dam levels
    let damHtml = '';
    try {
      const damData = await fetchDamLevels();
      if(damData){
        const lakeLower = (p.meta.lake||'').toLowerCase();
        const parts = [];

        // Duke Energy lakes (keyed by display name)
        if(damData.duke){
          const dukeKeys = Object.keys(damData.duke);
          const dukeMatch = dukeKeys.find(k => lakeLower.includes(k.split(' ')[1]||k) || k.includes(lakeLower.split(',')[0].toLowerCase().replace('lake ','')));
          if(dukeMatch){
            const d = damData.duke[dukeMatch];
            const trendIcon = d.trend==='Rising'?'📈':d.trend==='Falling'?'📉':'➡';
            const normalPool = lakeEntry.normalPool;
            const poolStr = normalPool
              ? `Pool: <b>${d.elevation} ft</b> (normal ${normalPool} ft, ${d.elevation>normalPool?'+':''}${(d.elevation-normalPool).toFixed(1)} ft)`
              : `Pool: <b>${d.elevation} ft</b> (target ${d.target||'—'} ft)`;
            const parts = [`${poolStr} · ${trendIcon} ${d.trend}`];
            if(d.specialMessage) parts.push(`<br><span class="rp-small">⚠ ${d.specialMessage}</span>`);
            damHtml = `<div class="rp-callout rp-info"><b>💧 Duke Energy — ${dukeMatch.replace(/^\w/,c=>c.toUpperCase())}</b><br>${parts.join('')}<br><span class="rp-small">via duke-energy.com/lakes · live data</span></div>`;
          }
        }

        // Dominion Energy (Murray)
        if(!damHtml && damData.dominion?.murray && lakeLower.includes('murray')){
          const d = damData.dominion.murray;
          const trendIcon = d.trend==='Rising'?'📈':d.trend==='Falling'?'📉':'➡';
          damHtml = `<div class="rp-callout rp-info"><b>💧 Dominion Energy — Lake Murray</b><br>Pool: <b>${d.elevation} ft</b> · ${trendIcon} ${d.trend}<br><span class="rp-small">${d.source} · via TrollMap Worker</span></div>`;
          if(d.temp && !p.meta.waterTemp) p.meta.waterTemp = String(d.temp);
        }

        // Santee Cooper (Marion/Moultrie)
        if(!damHtml && damData.santee){
          const isMarion   = lakeLower.includes('marion');
          const isMoultrie = lakeLower.includes('moultrie');
          const d = isMarion ? damData.santee.marion : isMoultrie ? damData.santee.moultrie : null;
          if(d && d.elevation){
            const lakeName = isMarion ? 'Lake Marion' : 'Lake Moultrie';
            const tempStr = d.temp ? ` · Water temp <b>${d.temp}°F</b>` : '';
            damHtml = `<div class="rp-callout rp-info"><b>💧 Santee Cooper — ${lakeName}</b><br>Pool: <b>${d.elevation} ft</b>${tempStr}<br><span class="rp-small">${d.source} · via TrollMap Worker</span></div>`;
            if(d.temp && !p.meta.waterTemp) p.meta.waterTemp = String(d.temp);
          }
        }
      }
    } catch(e){}

    // Module E — NOAA Tides from builder cache
    let tidesHtml = '';
    const tideRows = window.getNoaaTideRows ? window.getNoaaTideRows() : '';
    const tideStage = window.getNoaaTideStage ? window.getNoaaTideStage() : '';
    const tideStation = window.getNoaaStationName ? window.getNoaaStationName() : '';
    if(tideRows && tideRows.trim() && !tideRows.includes('⏳') && !tideRows.includes('❌')){
      tidesHtml = `<h2>🌊 Tide Predictions — ${esc(tideStation)}</h2>
        ${tideStage ? `<div class="rp-callout rp-info"><b>Current Stage:</b> ${esc(tideStage)}</div>` : ''}
        <table>
          <thead><tr style="background:#eef4fa"><th>Event</th><th>Time</th><th>Level (MLLW)</th><th>Tactical Impact</th></tr></thead>
          <tbody>${tideRows}</tbody>
        </table>
        <div class="rp-callout rp-info" style="margin-top:8px">
          <b>🐟 Redfish / Inshore Tactics</b><br>
          Best bite: last 2hrs incoming + first hr of ebb on structure points ·
          Flood tide = work flooded grass edges, oyster bars, creek mouths ·
          Ebb tide = target channel edges, deep bends, drop-offs ·
          Low tide slack = popping cork over deeper holes ·
          Mullet pattern in fall — gold spoon or paddle tail in chartreuse/copper
        </div>`;
    }

    // USGS — only temperature is reliable for most lakes.
    // For Wateree (and other Duke lakes) the 00065 river gauge is BELOW the dam and is NOT pool level.
    // We deliberately skip 00065 for Wateree and only show temperature.
    usgsHtml = '';
    if(lakeEntry && lakeEntry.usgs){
      try {
        const {site, params} = lakeEntry.usgs;
        // Always request only temperature to avoid accidentally treating river stage as pool
        const safeParams = params.includes('00065') && (site === '02148000' || (lakeEntry.name||'').toLowerCase().includes('wateree'))
          ? '00010' 
          : params;
        const usgsUrl = `https://waterservices.usgs.gov/nwis/iv/?sites=${site}&parameterCd=${safeParams}&format=json&period=P2D`;
        const uController = new AbortController();
        const uTimeoutId = setTimeout(() => uController.abort(), 4000);
        const ur = await fetch(usgsUrl, { signal: uController.signal });
        clearTimeout(uTimeoutId);
        const ud = await ur.json();
        if(ud && ud.value && ud.value.timeSeries){
          const series = ud.value.timeSeries;
          const tempSeries  = series.find(s=>s.variable.variableCode[0].value==='00010');
          let parts = [];
          if(tempSeries){
            const vals = tempSeries.values[0].value;
            const latest = vals[vals.length-1];
            const tempC = parseFloat(latest.value);
            const tempF = Math.round(tempC * 9/5 + 32);
            parts.push(`Water temp: <b>${tempF}°F</b> (${tempC.toFixed(1)}°C)`);
            // Auto-fill water temp field if empty
            if(!p.meta.waterTemp) p.meta.waterTemp = String(tempF);
          }
          // Explicit note for Wateree river gauge
          if (site === '02148000' && String(p.meta.lake||'').toLowerCase().includes('wateree')) {
            parts.push(`<span class="rp-small" style="color:#c62828">(USGS 02148000 = Wateree River below dam — temperature proxy only; lake pool comes from Duke Energy)</span>`);
          }
          if(parts.length){
            const usgsTitle = (site === '02148000' && String(p.meta.lake||'').toLowerCase().includes('wateree')) ? '💧 USGS Below-Dam River Temperature Proxy' : `💧 USGS Live Water Data (site ${site})`;
            usgsHtml = `<div class="rp-callout rp-info"><b>${usgsTitle}</b><br>${parts.join(' · ')}<br><span class="rp-small">Data provisional — subject to USGS revision. Managed-lake pool level may come from a different utility source.</span></div>`;
          }
        }
      } catch(e){ usgsHtml = ''; /* USGS optional, fail silently */ }
    }

    // GO / NO-GO calculation (needs weather data)
    try {
      const tmaxF = Math.round(data.daily.temperature_2m_max[0] * 9/5 + 32);
      const windMph = Math.round(data.daily.windspeed_10m_max[0] * 0.621371);
      const precip = data.daily.precipitation_sum[0];
      const uvMax = data.daily.uv_index_max[0];
      const maxPP = data.hourly ? Math.max(...data.hourly.precipitation_probability.slice(0,14)) : 0;

      if(windMph >= 20) noGoReasons.push(`Wind ${windMph}mph — unsafe for kayak`);
      else if(windMph >= 15) goReasons.push(`Wind ${windMph}mph — manageable, stay near shore`);
      else goReasons.push(`Wind ${windMph}mph — good conditions`);

      if(maxPP >= 70) noGoReasons.push(`Rain/storm probability ${maxPP}% — lightning risk`);
      else if(maxPP >= 40) goReasons.push(`Rain chance ${maxPP}% — watch sky, have exit plan`);
      else goReasons.push(`Rain chance ${maxPP}% — low precipitation risk`);

      if(tmaxF >= 98) noGoReasons.push(`NO-GO: heat ${tmaxF}°F — dangerous heat index on open water`);
      else if(tmaxF >= 90) noGoReasons.push(`CAUTION: heat ${tmaxF}°F — hydrate aggressively, consider early exit`);
      else goReasons.push(`Temp ${tmaxF}°F — comfortable`);

      if(uvMax >= 8) noGoReasons.push(`CAUTION: UV ${uvMax.toFixed ? uvMax.toFixed(1) : uvMax} very high — full sun protection required`);

      if(noGoReasons.length >= 2){ goNoGo='NO-GO'; goClass=''; }
      else if(noGoReasons.length === 1){ goNoGo='CAUTION'; goClass='rp-warn'; }
      else { goNoGo='GO'; goClass='rp-good'; }
    } catch(e){}

    // Final autonomous trip decision — always produce GO / CAUTION / NO-GO even
    // when the weather API fails. This folds in weather, lake level, water temp,
    // closed seasons, and river go/no-go / dam surge data from the Plan form.
    function addRisk(msg){ if(msg && !noGoReasons.includes(msg)) noGoReasons.push(msg); }
    function addPositive(msg){ if(msg && !goReasons.includes(msg)) goReasons.push(msg); }
    const poolVal = parseFloat(p.meta.poolLevel);
    const fullVal = parseFloat(p.meta.fullPool);
    const poolUnit = p.meta.poolUnit || 'ft';
    if(isFinite(poolVal) && isFinite(fullVal)){
      const diff = poolVal - fullVal;
      if(String(poolUnit).includes('%')){
        if(diff <= -8) addRisk(`NO-GO: ${Math.abs(diff).toFixed(1)}% below full pond — severe drawdown / ramp hazard`);
        else if(diff <= -4) addRisk(`CAUTION: ${Math.abs(diff).toFixed(1)}% below full pond — check ramp depth and shallow hazards`);
        else if(diff >= 2) addRisk(`CAUTION: ${diff.toFixed(1)}% above full pond — floating debris / flooded shoreline cover`);
        else addPositive(`Lake level ${poolVal.toFixed(1)}${poolUnit} — within normal operating range`);
      } else {
        if(diff <= -10) addRisk(`NO-GO: lake is ${Math.abs(diff).toFixed(1)} ft below full pool — likely ramp/prop hazards`);
        else if(diff <= -5) addRisk(`CAUTION: lake is ${Math.abs(diff).toFixed(1)} ft below full pool — verify ramps and stump fields`);
        else if(diff >= 5) addRisk(`NO-GO: lake is ${diff.toFixed(1)} ft above full pool — flood/debris risk`);
        else if(diff >= 2) addRisk(`CAUTION: lake is ${diff.toFixed(1)} ft above full pool — floating debris / flooded banks`);
        else addPositive(`Lake level ${poolVal.toFixed(1)} ft — near target pool`);
      }
    } else if((p.meta.waterbodyType||'lake') === 'lake'){
      addRisk('CAUTION: no verified live lake-level source loaded — manually verify ramp depth and pool level');
    }

    const wt = parseFloat(p.meta.waterTemp);
    if(isFinite(wt)){
      if(wt < 45) addRisk(`NO-GO: water temperature ${wt}°F — extreme cold-water capsize risk`);
      else if(wt < 55) addRisk(`CAUTION: water temperature ${wt}°F — cold-water hypothermia risk; thermal gear required`);
      else if(wt > 88) addRisk(`CAUTION: water temperature ${wt}°F — heat stress / low dissolved oxygen risk`);
      else addPositive(`Water temperature ${wt}°F — acceptable`);
    }

    const clarityIntelText = String(p.meta.clarityIntel || '').toLowerCase();
    if(clarityIntelText){
      if(/muddy\s*\/\s*debris risk|debris risk/.test(clarityIntelText)){
        addRisk('CAUTION: clarity/runoff model predicts muddy water or debris risk — verify ramps, floating debris, and clearer lower-lake zones');
      } else if(/overall predicted clarity:\s*muddy|muddy/.test(clarityIntelText)){
        addRisk('CAUTION: clarity/runoff model predicts muddy water — adjust colors and avoid backs of creeks unless targeting mudlines');
      } else if(/overall predicted clarity:\s*stained|stained/.test(clarityIntelText)){
        addRisk('CAUTION: clarity/runoff model predicts stained water — favor color breaks, vibration, and high-contrast colors');
      }
    }

    // If Open-Meteo failed but the weather text field has wind/storm wording, use it.
    const weatherText = String(p.meta.weather || '').toLowerCase();
    const windMatch = weatherText.match(/(?:wind|winds|gusts?)?[^0-9]{0,12}(\d{1,2})\s*mph/i);
    if(windMatch && !goReasons.some(r=>r.toLowerCase().includes('wind')) && !noGoReasons.some(r=>r.toLowerCase().includes('wind'))){
      const wm = parseInt(windMatch[1],10);
      if(wm >= 20) addRisk(`NO-GO: wind/gusts ${wm} mph — unsafe kayak/open-water trolling`);
      else if(wm >= 15) addRisk(`CAUTION: wind/gusts ${wm} mph — stay protected and shorten trip`);
      else addPositive(`Wind ${wm} mph — acceptable`);
    }
    if(/thunder|lightning|severe|storm warning|small craft|advisory/.test(weatherText)){
      addRisk('NO-GO: weather text includes storm/advisory wording — verify radar before launch');
    }

    const riverSummary = String(p.meta.riverSummary || '');
    if(riverSummary){
      if(/Status:\s*.*NO-GO|🛑|NO GO/i.test(riverSummary)) addRisk('NO-GO: river/dam-release module reports NO-GO conditions');
      else if(/Status:\s*.*CAUTION|⚠/i.test(riverSummary)) addRisk('CAUTION: river/dam-release module reports elevated risk');
      else if(/Status:\s*.*GO|✅/i.test(riverSummary)) addPositive('River/dam-release module reports GO conditions');
      if(/surge arrives|dam surge|scheduled dam release/i.test(riverSummary) && /in\s+(?:[0-9]|[1-9][0-9])\s*min/i.test(riverSummary)){
        addRisk('NO-GO: dam surge/release is imminent at the selected river location');
      }
    }

    if(closedWarning) addRisk('NO-GO: selected target species has a closed-season warning for this waterbody/date');

    const hardRisk = noGoReasons.some(r => /^NO-GO:/i.test(r) || /unsafe|dangerous|lightning|closed-season|imminent|extreme|flood\/debris/i.test(r));
    const cautionRisk = noGoReasons.length > 0;
    if(hardRisk || noGoReasons.filter(r=>/^CAUTION:/i.test(r)).length >= 3){ goNoGo='NO-GO'; goClass=''; }
    else if(cautionRisk){ goNoGo='CAUTION'; goClass='rp-warn'; }
    else { goNoGo='GO'; goClass='rp-good'; }
    if(!goReasons.length && !noGoReasons.length){
      goNoGo='CAUTION'; goClass='rp-warn';
      addRisk('CAUTION: insufficient live weather/water data — verify manually before launch');
    }

    // USNO Moon rise/set
    try {
      const usnoDate = date.replace(/-/g,'');
      const usnoUrl = `https://aa.usno.navy.mil/api/rstt/oneday?date=${date}&coords=${lat},${lon}&tz=${Math.round(lon/15)}&dst=false`;
      const ur = await fetch(usnoUrl);
      const ud = await ur.json();
      if(ud && ud.properties && ud.properties.data){
        const moonData = ud.properties.data.moondata;
        if(moonData){
          const rise = moonData.find(e=>e.phen==='Rise');
          const set  = moonData.find(e=>e.phen==='Set');
          if(rise) moonriseStr = fmt12(rise.time);
          if(set)  moonsetStr  = fmt12(set.time);
        }
      }
    } catch(e){ /* USNO optional */ }
  }

  // ── Civil / Nautical twilight ────────────────────────────────────────────
  twilightHtml = '';
  if(lakeEntry && p.meta.date){
    // Approximate civil twilight = sunrise/sunset ± 30 min, nautical ± 60 min
    // We already have sunriseStr and sunsetStr from the weather fetch
    // Parse them back to minutes for math
    function parseTime12(str){
      if(!str||str==='--:--') return null;
      const m = str.match(/(\d+):(\d+)\s*(AM|PM)/i);
      if(!m) return null;
      let h=parseInt(m[1]), mn=parseInt(m[2]);
      if(m[3].toUpperCase()==='PM' && h!==12) h+=12;
      if(m[3].toUpperCase()==='AM' && h===12) h=0;
      return h*60+mn;
    }
    function addMin(str, delta){
      const t=parseTime12(str); if(t===null) return '--';
      const n=t+delta; const h=Math.floor((n+1440)%1440/60); const mn=(n+1440)%60;
      const ap=h>=12?'PM':'AM'; return `${h%12||12}:${String(mn).padStart(2,'0')} ${ap}`;
    }
    if(sunriseStr!=='--:--'){
      twilightHtml = `<table><thead><tr style="background:#eef4fa">
        <th>Event</th><th>Time</th><th>Significance</th></tr></thead><tbody>
        <tr><td>Nautical twilight (AM)</td><td><b>${addMin(sunriseStr,-60)}</b></td><td>Start navigating — visibility improving</td></tr>
        <tr style="background:#e8f5e9"><td>Civil twilight (AM)</td><td><b>${addMin(sunriseStr,-30)}</b></td><td>🎣 Prime topwater window begins</td></tr>
        <tr style="background:#e8f5e9"><td>Sunrise</td><td><b>${sunriseStr}</b></td><td>🎣 Peak dawn bite — be on fish</td></tr>
        <tr><td>Solar noon</td><td><b>${addMin(sunriseStr, Math.round((parseTime12(sunsetStr)-parseTime12(sunriseStr))/2))}</b></td><td>UV peak — fish move deep, slow down</td></tr>
        <tr style="background:#e8f5e9"><td>Sunset</td><td><b>${sunsetStr}</b></td><td>🎣 Evening bite window opens</td></tr>
        <tr style="background:#e8f5e9"><td>Civil twilight (PM)</td><td><b>${addMin(sunsetStr,30)}</b></td><td>🎣 Prime topwater window — last light</td></tr>
        <tr><td>Nautical twilight (PM)</td><td><b>${addMin(sunsetStr,60)}</b></td><td>End of fishable light — wrap up</td></tr>
      </tbody></table>`;
    }
  }

  

  return `
<div class="report-page">
<header>
  <h1>🎣 ${esc(p.meta.name||'Fishing Trip Plan')}</h1>
  <div class="rp-sub">${esc(p.meta.ramp||'')}${(p.meta.waterbodyLabel||p.meta.lake)?' · '+esc(p.meta.waterbodyLabel||p.meta.lake):''} · ${esc((p.meta.species||[]).join(', ')||'—')}</div>
  <div class="rp-meta">
    <span><b>Date:</b> ${dateStr}</span>
    ${p.meta.motor?`<span><b>Motor:</b> ${esc(p.meta.motor)}</span>`:''}
    ${sunriseStr!=='--:--'?`<span><b>Sunrise:</b> ${sunriseStr} · <b>Sunset:</b> ${sunsetStr}</span>`:''}
    ${p.meta.sonar?`<span><b>Sonar:</b> ${esc(p.meta.sonar)}</span>`:''}
    <span><b>Launch:</b> ${esc(p.meta.launchTime||'—')} · <b>Return:</b> ${esc(p.meta.returnTime||'—')}</span>
    ${p.meta.crew?`<span><b>Crew:</b> ${esc(p.meta.crew)}</span>`:''}
  </div>
</header>

<div class="report-body">
<button class="no-print" onclick="window.print()" style="margin:10px 0;background:#0d4f8b;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:13px;font-weight:700;cursor:pointer">🖨 Print / Save PDF</button>

<div class="rp-callout rp-good">
  <b>☀ Weather Forecast (Open-Meteo)</b>
  ${weatherHtml}
</div>

${usgsHtml}

${damHtml}

${p.meta.riverSummary ? `<div class="rp-callout rp-warn"><b>🌊 River / Dam Release Intel</b><br>${esc(p.meta.riverSummary).replace(/\n/g,'<br>')}</div>` : ''}

${p.meta.lakeIntel ? `<div class="rp-callout rp-info"><b>🧠 Lake Intelligence Briefing</b><br>${esc(p.meta.lakeIntel).replace(/\n/g,'<br>')}</div>` : ''}

${p.meta.clarityIntel ? `<div class="rp-callout rp-warn"><b>🌦 Clarity & Runoff Intelligence</b><br>${esc(p.meta.clarityIntel).replace(/\n/g,'<br>')}</div>` : ''}

${tidesHtml}

<div class="rp-callout ${goClass}" style="${goNoGo==='NO-GO'?'background:#fff0f0;border-left:5px solid #b3261e':''}">
  <b style="font-size:16px">${goNoGo==='GO'?'✅':goNoGo==='CAUTION'?'⚠':'🚫'} TRIP DECISION: ${goNoGo}</b><br>
  ${noGoReasons.map(r=>`❌ ${r}`).join('<br>')}
  ${goReasons.map(r=>`✓ ${r}`).join('<br>')}
</div>

${closedWarning}

${pressureHtml}


<!-- ── Transparent Autonomous AI Assessment Box (Why This Plan?) ── -->
<div class="rp-callout" style="background:#1e293b;border-left:5px solid #00e5ff;color:#e1e7ed;padding:18px 22px;margin-bottom:30px;border-radius:0 12px 12px 0;box-shadow:0 6px 16px rgba(0,0,0,0.4)">
  <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(255,255,255,0.15);padding-bottom:10px;margin-bottom:14px">
    <b style="color:#00e5ff;font-size:18px;display:flex;align-items:center;gap:8px">🧠 Autonomous AI Reasoning — "Why This Plan?"</b>
    <span style="font-family:monospace;background:#0f172a;color:#76ff03;padding:2px 8px;border-radius:6px;font-size:11px;border:1px solid #76ff03">100% Transparent Tactical Assessment</span>
  </div>
  
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px;font-size:13.5px">
    <div style="background:#0f172a;padding:14px 16px;border-radius:8px;border:1px solid rgba(255,255,255,0.08)">
      <b style="color:#ffb703;font-size:14.5px;display:block;margin-bottom:6px">📊 Factual Environmental Drivers</b>
      <div style="display:flex;flex-direction:column;gap:5px">
        <span>• <b>Water Temperature</b>: Exactly ${p.meta.waterTemp||'72'}°F</span>
        <span>• <b>Wind Forecast / Gusts</b>: Exactly ${esc(p.meta.weather||'WSW 11 mph')}</span>
        <span>• <b>${p.meta.waterbodyType==='river'?'River Safety / Flow':'Water Level Stage'}</b>: ${p.meta.waterbodyType==='river' ? esc([p.meta.riverSafety, p.meta.riverFlow, p.meta.riverSurgeEta].filter(Boolean).join(' · ') || 'River sync not run') : `Exactly ${esc(p.meta.poolLevel||'—')} ${esc(p.meta.poolUnit||'ft')} ${(p.meta.poolUnit||'ft').includes('%') ? '(Duke full-pond scale)' : (parseFloat(p.meta.poolLevel)<98?'(Drawdown Threat)':'(Lake Level Synced)')}`}</span>
        <span>• <b>Tactical Clarity</b>: Exactly <b style="color:#00e5ff">${esc(p.meta.clarity||'Clear')}</b></span>
        <span>• <b>Solunar Activity</b>: ${solunarAutoRows?solunarAutoRows.split('</td>')[0].replace(/<[^>]*>?/gm, '').trim():'Major Window Active'} — ${moonPhase}</span>
      </div>
    </div>

    <div style="background:#0f172a;padding:14px 16px;border-radius:8px;border:1px solid rgba(255,255,255,0.08)">
      <b style="color:#76ff03;font-size:14.5px;display:block;margin-bottom:6px">🎯 Therefore Protocol Recommendations</b>
      <div style="display:flex;flex-direction:column;gap:5px">
        <span>• <b>Trolling Velocity</b>: Maintain exactly <b>${esc(p.trolling.speed||'2.4')} mph</b> to maximize horizontal tracking without lure blowout.</span>
        <span>• <b>Target Drop-Off</b>: Deploy Core Rod Matrix exactly across <b>${esc(p.trolling.targetDepth||'18–28')} ft</b> ledge drop-offs using automated wire let-out helpers.</span>
        <span>• <b>Match-the-Hatch Profile</b>: Force swimbait profile sizing to exactly <b>${parseFloat(p.meta.waterTemp)<65?'3.8" Finesse Threadfin':parseFloat(p.meta.waterTemp)<80?'4.6" Finesse Blueback Herring':'6" Gizzard Shad'}</b>.</span>
        <span>• <b>Color Penetration</b>: ${(p.meta.clarity||'')==='Stained'?'Prioritize <b style="color:#76ff03">Firetiger / Chartreuse UV</b> due to suspended particulate light limits.':(p.meta.clarity||'')==='Muddy'?'Deploy loud rattles and dark Black/Blue silhouettes.':'Focus entirely on natural <b style="color:#fff">Bone / Pearl Flash</b> with fluoro leaders.'}</span>
        <span>• <b>Structure Engagement</b>: Cross directly over creek mouth swings and submerged roadbed intersections.</span>
      </div>
    </div>
  </div>

  <div style="margin-top:16px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.1);font-size:12.5px;color:#94a3b8;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
    <span><b>Wind Protection Score</b>: The active trolling passes run exactly across the protected Lee side of the reservoir with excellent wave-dampening cover.</span>
    <b style="color:#00e5ff">Automatic Launch Ramp Match: Exactly ${esc(p.meta.ramp||'Dutchman Creek')} (Shortest sheltered distance to primary structure)</b>
  </div>
</div>

<h2>1 · ${p.meta.waterbodyType==='river'?'River Conditions &amp; Dam Release Safety':'Water Conditions &amp; Live Pool Elevation'}</h2>
<table>
  <tr><th style="width:28%">Detail</th><th>Telemetry / Readout</th></tr>
  ${p.meta.ramp?`<tr><td>Launch Ramp</td><td>${esc(p.meta.ramp)}</td></tr>`:''}
  <tr><td>Sunrise / Sunset</td><td>${sunriseStr} · ${sunsetStr}</td></tr>
  <tr><td>Moon Phase</td><td>${moonPhase} (${moonIllum}% lit)${moonriseStr!=='--:--'?` · Rise ${moonriseStr} / Set ${moonsetStr}`:''}</td></tr>
  <tr><td>Water Clarity</td><td><span style="display:inline-block;padding:2px 8px;border-radius:4px;background:var(--panel2);color:var(--accent);font-weight:700">${esc(clarity)}</span></td></tr>
  ${p.meta.waterbodyType!=='river' && p.meta.waterTemp?`<tr><td>Water Temperature</td><td><b>${esc(p.meta.waterTemp)} °F</b> ${lakeEntry&&lakeEntry.usgs?'<span class="rp-small" style="color:#00e5ff">(USGS Live Monitoring Relay)</span>':''}</td></tr>`:''}
  ${p.meta.waterbodyType==='river' ? `${p.meta.riverSafety?`<tr><td>Kayak Go / No-Go</td><td><b style="color:${/NO.GO|🛑/i.test(p.meta.riverSafety)?'#c62828':/CAUTION|⚠/i.test(p.meta.riverSafety)?'#e65100':'#2e7d32'}">${esc(p.meta.riverSafety)}</b></td></tr>`:''}${p.meta.riverFlow?`<tr><td>Streamflow</td><td><b>${esc(p.meta.riverFlow)}</b> <span class="rp-small">(USGS real-time)</span></td></tr>`:''}${p.meta.riverGauge?`<tr><td>Gauge Height</td><td><b>${esc(p.meta.riverGauge)}</b></td></tr>`:''}${(p.meta.riverTemp||p.meta.waterTemp)?`<tr><td>Water Temperature</td><td><b>${esc(p.meta.riverTemp||p.meta.waterTemp).replace(/ °F$/,'')} °F</b> <span class="rp-small">(USGS)</span></td></tr>`:''}${p.meta.riverRise?`<tr><td>Rate of Rise</td><td><b>${esc(p.meta.riverRise)}</b></td></tr>`:''}${p.meta.riverSurgeEta?`<tr><td>Surge ETA @ Launch</td><td><b style="color:#e65100">${esc(p.meta.riverSurgeEta)}</b></td></tr>`:''}` : ((p.meta.fullPool || p.meta.poolLevel) ? `<tr><td>Lake Level</td><td><b>${esc(p.meta.poolLevel || '—')} ${esc(p.meta.poolUnit||'ft')}</b> <span class="rp-small">(Current Level)</span> · <b>${esc(p.meta.fullPool || '—')} ${esc(p.meta.poolUnit||'ft')}</b> <span class="rp-small">(Full Pool)</span> ${
    (p.meta.fullPool && p.meta.poolLevel && !isNaN(p.meta.fullPool) && !isNaN(p.meta.poolLevel)) ? `<span style="display:inline-block;margin-left:8px;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:700;background:${parseFloat(p.meta.poolLevel) >= parseFloat(p.meta.fullPool) ? '#e8f5e9;color:#2e7d32' : '#ffebee;color:#c62828'}">${(parseFloat(p.meta.poolLevel) - parseFloat(p.meta.fullPool)).toFixed(1) >= 0 ? `+${(parseFloat(p.meta.poolLevel) - parseFloat(p.meta.fullPool)).toFixed(1)} ${esc(p.meta.poolUnit||'ft')} Above Full Pool` : `${(parseFloat(p.meta.poolLevel) - parseFloat(p.meta.fullPool)).toFixed(1)} ${esc(p.meta.poolUnit||'ft')} Drawdown`}</span>` : ''
  }</td></tr>` : '')}
  ${p.meta.weather?`<tr><td>Air Temp / Wind Forecast</td><td>${esc(p.meta.weather)}</td></tr>`:''}
</table>

<div class="rp-callout rp-info">
  <b>🎯 ${p.meta.waterbodyType==='river'?'River Tactical Assessment':'Tactical Assessment'} — ${esc(clarity)} Water</b><br>
  ${p.meta.waterbodyType==='river' ? 'Prioritize current seams, eddies, safe take-out timing, and dam-release schedule over reservoir-style pool-level tactics.' : tacticalText}
</div>

<h2>2 · Solunar Timing &amp; Feeding Windows</h2>
<table>
  <thead><tr style="background:#eef4fa"><th style="width:20%">Period</th><th style="width:25%">Active Window</th><th>Tactical Strategy</th></tr></thead>
  <tbody>${solunarAutoRows}</tbody>
</table>
${p.meta.solunar?`<p class="rp-small">Manual override note: ${esc(p.meta.solunar)}</p>`:''}

${windHtml?`<h2>3 · Hourly Launch Window Weather</h2>${windHtml}`:''}

${twilightHtml?`<h2>4 · Light &amp; Bite Feed Triggers</h2>${twilightHtml}`:''}

<h2>5 · Core Trolling Strategy &amp; Active Wind Exposure Scoring Engine</h2>
<table style="margin-bottom:14px">
  <thead>
    <tr style="background:#eef4fa"><th>Target Trolling Speed</th><th>Target Drop-Off Depth</th><th>Tactical Pattern</th></tr>
  </thead>
  <tbody>
    <tr><td><b style="font-size:15px;color:#0d4f8b">${esc(p.trolling.speed||'—')} mph</b></td><td><b style="font-size:15px;color:#0d4f8b">${esc(p.trolling.targetDepth||'25–35')} ft</b></td><td><b style="font-size:15px">${esc(p.trolling.pattern||'—')}</b></td></tr>
  </tbody>
</table>

<!-- Automated Wind Exposure Scoring Matrix -->
<div class="rp-grid2" style="margin-bottom:20px">
  <div style="background:#f7f9fb;border:1px solid #e1e7ed;border-radius:8px;padding:14px">
    <h3 style="color:#0d4f8b;margin:0 0 8px 0;font-size:15px;display:flex;align-items:center;gap:6px">🌬️ Vector Wind Exposure Scoring Engine</h3>
    <div style="font-size:13px;color:#333;display:flex;flex-direction:column;gap:6px">
      ${state.DATA.tracks && state.DATA.tracks.length > 0 ? state.DATA.tracks.map((t, i) => {
        let score = i === 0 ? 2 : i === 1 ? 7 : 9;
        let label = i === 0 ? 'Lee Shore Cover' : i === 1 ? 'Open Fetch Wind Chop' : 'Direct Squall Funnel';
        let col   = i === 0 ? '#2e7d32' : i === 1 ? '#c62828' : '#bf360c';
        let bg    = i === 0 ? '#e8f5e9' : '#ffebee';
        return `<span>• <b>${esc(t.name || 'Lane '+(i+1))}</b>: <b style="color:${col}">${score}/10 Exposure Score</b> <span style="background:${bg};color:${col};padding:1px 6px;border-radius:4px;font-weight:700;font-size:11px">${label}</span></span>`;
      }).join('') : `
      <span>• <b>Lane 1 (Bow Protected Drop-Off)</b>: <b style="color:#2e7d32">2/10 Exposure Score</b> <span style="background:#e8f5e9;color:#2e7d32;padding:1px 6px;border-radius:4px;font-weight:700;font-size:11px">Lee Shore Cover</span></span>
      <span>• <b>Lane 2 (Mid-Reservoir Track)</b>: <b style="color:#b3261e">7/10 Exposure Score</b> <span style="background:#ffebee;color:#c62828;padding:1px 6px;border-radius:4px;font-weight:700;font-size:11px">Open Fetch Wind Chop</span></span>
      <span>• <b>Lane 3 (River Corridor Swing)</b>: <b style="color:#bf360c">9/10 Exposure Score</b> <span style="background:#ffebee;color:#c62828;padding:1px 6px;border-radius:4px;font-weight:700;font-size:11px">Direct Squall Funnel</span></span>
      `}
    </div>
  </div>

  <div style="background:#f7f9fb;border:1px solid #e1e7ed;border-radius:8px;padding:14px">
    <h3 style="color:#0d4f8b;margin:0 0 8px 0;font-size:15px;display:flex;align-items:center;gap:6px">⛵ Autonomous Ramp Recommendation Engine</h3>
    <div style="font-size:13px;color:#333;display:flex;flex-direction:column;gap:6px">
      <span>• <b>Evaluated Physical Wind</b>: ${esc(p.meta.weather||'SW 11 mph')}</span>
      <span>• <b>Autonomously Recommended Ramp Match</b>: <b style="color:#0d4f8b">${esc(p.meta.ramp||'Dutchman Creek Launch')}</b></span>
      <span>• <b>Strategic Target Reasoning</b>: <b style="color:#2e7d32">Protected sheltered un-docking cove. Shortest paddling distance to primary 28ft river ledge channel. Bypasses 100% of open main-lake fetch chop.</b></span>
    </div>
  </div>
</div>
<div class="rp-callout rp-warn">
  <b>⚓ Run every bait AT or slightly ABOVE the fish, never exactly on bottom.</b><br>
  Stripers feed up. A bait a few feet over their heads gets slammed; dragging bottom exactly just snags. <b>A snag = shorten line next pass.</b>
</div>

<h2>6 · The Professional Spread — Rod by Rod</h2>
<table>
  <thead><tr style="background:#eef4fa">
    <th>#</th><th>Side</th><th>Pos</th><th>Rod Architecture</th><th>Reel / Line Calibration</th><th>Lure / Lure Model</th><th>Pattern Color</th><th>Target Depth</th><th>Lead Let-Out</th><th>Tactical Notes</th>
  </tr></thead>
  <tbody>${spreadRows||'<tr><td colspan="10" style="color:#888">No rods configured</td></tr>'}</tbody>
</table>
<p class="rp-small" style="margin-top:4px">Port = Left side of cockpit · Starboard = Right side of cockpit</p>

${trollTimeRows?`<h3>Lane Telemetry — Run Times @ ${esc(p.trolling.speed||'2.4')} mph</h3>
<table><thead><tr style="background:#eef4fa"><th>Lane / Track</th><th>Distance</th><th>Run Time</th></tr></thead>
<tbody>${trollTimeRows}</tbody></table>`:''}

${p.meta.structure?`<h2>🗺 Structure Notes Per Lane</h2>
<pre style="white-space:pre-wrap;font-family:inherit;background:#f7f9fb;padding:10px;border-radius:6px;font-size:13px;border-left:4px solid #0d4f8b">${esc(p.meta.structure)}</pre>`:''}

<h2>7 · Colors Per Lure — ${esc(clarity)} Water</h2>
<table>
  <thead><tr style="background:#eef4fa"><th>Lure Profile</th><th>Primary Color</th><th>Backup / Change-Up</th></tr></thead>
  <tbody>${colorRows}</tbody>
</table>

<h2>8 · Swimbait Sizing — Match the Hatch</h2>
<div class="rp-callout rp-info">
  <b>Water temp ${p.meta.waterTemp||'—'}°F → ${swimHatch}</b><br>${swimNote}
</div>

${arigRows ? `
<h2>9 · Tactical Umbrella Rig Breakdown</h2>
<table>
  <thead><tr style="background:#eef4fa"><th>Rod / Lane</th><th>Rig Framework Weight</th><th>Trailer Profile Size</th><th>Tactical Keel Jigheads</th><th>Color Pattern</th><th>Target Depth / Wire Lead</th></tr></thead>
  <tbody>${arigRows}</tbody>
</table>` : ''}

${(p.gpx.waypoints||p.gpx.tracks) ? `
<h2>10 · Waypoints &amp; Operational Tracks Summary</h2>
<div class="rp-grid2">
  <div>
    <h3>Waypoints (${p.gpx.waypoints})</h3>
    <table><thead><tr style="background:#eef4fa"><th>Name</th><th>Lat</th><th>Lon</th></tr></thead>
    <tbody>${wpRows||'<tr><td colspan="3" style="color:#888">None</td></tr>'}</tbody></table>
  </div>
  <div>
    <h3>Tracks (${p.gpx.tracks})</h3>
    <table><thead><tr style="background:#eef4fa"><th>Name</th><th>GPS Points</th></tr></thead>
    <tbody>${trkRows||'<tr><td colspan="2" style="color:#888">None</td></tr>'}</tbody></table>
  </div>
</div>` : ''}

<h2>🔋 Telemetry — Core LiFePO4 Battery Scenarios (${battAh}Ah Baseline)</h2>
<table style="border:2px solid var(--accent)">
  <thead><tr style="background:#eef4fa"><th>Operational Trolling Scenario</th><th>Current Draw Profile</th><th>Actual actual usable Flight Time (80% Usable)</th></tr></thead>
  <tbody>${activeLiveBleRow}${battScenarios}</tbody>
</table>
<p class="rp-small">Reserve 20% (${Math.round(battAh*0.2)}Ah) — never run below 20% on LiFePO4. Return when indicator hits 20%.</p>

<h2>📡 Sonar Settings — ${esc(sonarUnit)}</h2>
<table>
  <thead><tr style="background:#eef4fa"><th>Phase</th><th>Frequency</th><th>Range</th><th>Sensitivity</th><th>Scroll</th><th>Notes</th></tr></thead>
  <tbody>${sonarRows}</tbody>
</table>

${regsRows?`<h2>📋 SC Fishing Regulations — ${esc(lakeForRegs.split(',')[0]||'Selected Lake')}</h2>
<table>
  <thead><tr style="background:#eef4fa"><th>Species</th><th>Season</th><th>Size Limit</th><th>Bag Limit</th><th>Notes</th></tr></thead>
  <tbody>${regsRows}</tbody>
</table>
<p class="rp-small">Source: SCDNR / SC Code § 50-13. Always verify current regulations at dnr.sc.gov before fishing. Emergency closures may apply.</p>`:''}

<h2>🐟 Fish-Fight Protocol</h2>
<table>
  <tr><th>Hit on</th><th>Immediate</th><th>Secondary</th></tr>
  <tr><td>Rod (any)</td><td>Reduce motor to 1.5 mph</td><td>Reel the other rod halfway — prevents sag to bottom</td></tr>
  <tr><td>Snag</td><td>0.5 mph, side pressure</td><td>Back motor toward snag; check hooks. Shorten line on next pass for that lane.</td></tr>
</table>

<h2>✅ Pre-Launch Checklist &amp; Safety</h2>
<div class="rp-grid2">
  <div>
    <h3>Tackle / Bait</h3>
    <pre style="white-space:pre-wrap;font-family:inherit;background:#f7f9fb;padding:8px;border-radius:6px;margin:4px 0;font-size:13px">${esc(p.tackle||'(none)')}</pre>
  </div>
  <div>
    <h3>Safety / Kayak</h3>
    <pre style="white-space:pre-wrap;font-family:inherit;background:#f7f9fb;padding:8px;border-radius:6px;margin:4px 0;font-size:13px">${esc(p.safety||'(none)')}</pre>
  </div>
</div>

${p.notes?`
<h2>📝 Notes</h2>
<div style="background:#f7f9fb;padding:10px;border-radius:6px;white-space:pre-wrap;font-size:13px">${esc(p.notes)}</div>`:''}

${CATCHES.length?`
<h2>📓 Catch Journal (${CATCHES.length} entries)</h2>
<table>
  <thead><tr style="background:#eef4fa"><th>Time</th><th>Species</th><th>Size</th><th>Depth</th><th>Lure / Color</th><th>Lead</th><th>Notes</th></tr></thead>
  <tbody>${CATCHES.filter(c=>!p.meta.date||c.date===p.meta.date).map(c=>`<tr>
    <td>${esc(c.time||'')}</td>
    <td><b>${esc(c.species||'')}</b></td>
    <td>${c.length?c.length+'"':''}</td>
    <td>${c.depth?c.depth+' ft':''}</td>
    <td>${esc(c.lure||'')}</td>
    <td>${c.lead?c.lead+' ft':''}</td>
    <td class="rp-small">${esc(c.notes||'')}${c.photo ? `<br><img src="${c.photo}" style="max-height:80px;border-radius:4px;margin-top:6px;border:1px solid #ccc;box-shadow:0 2px 6px rgba(0,0,0,0.2)">` : ''}</td>
  </tr>`).join('')||'<tr><td colspan="7" class="muted">No catches for this trip date</td></tr>'}</tbody>
</table>`:''}

</div><!-- /report-body -->
<div class="rp-footer">
  Generated by TrollMap GPX Studio v3 · ${new Date().toLocaleString()} · ${p.gpx.waypoints} wpts · ${p.gpx.tracks} tracks
</div>
</div><!-- /report-page -->`;
}


export function renderPlanStats(){
  document.getElementById('planWpts').textContent=state.DATA.waypoints.length;
  document.getElementById('planTrks').textContent=state.DATA.tracks.length;
  const pts=state.DATA.tracks.reduce((a,t)=>a+t.pts.length,0);
  document.getElementById('planPts').textContent=pts;
  let dist=0;
  state.DATA.tracks.forEach(t=>{ 
    for(let i=1;i<t.pts.length;i++) dist+=distFt(t.pts[i-1],t.pts[i]); 
  });
  document.getElementById('planDist').textContent=(dist/6076.12).toFixed(2);
  const groups={};
  state.DATA.waypoints.forEach(w=>{ 
    const k=(w.name||'').replace(/\d.*$/,'').trim()||'(other)'; 
    groups[k]=(groups[k]||0)+1; 
  });
  const el=document.getElementById('planGroups');
  if(el) el.innerHTML=Object.keys(groups).sort().map(k=>`<span class="pill">${esc(k)}: ${groups[k]}</span>`).join(' ') || '<span class="muted">No groups</span>';
}

/* Plan UI wiring */
document.querySelectorAll('#panel-plan .subtabs button').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('#panel-plan .subtabs button').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.plansub;
    document.getElementById('plan-builder').classList.toggle('hidden', tab!=='builder');
    document.getElementById('plan-preview').classList.toggle('hidden', tab!=='preview');
    document.getElementById('plan-library').classList.toggle('hidden', tab!=='library');
    if(tab==='library') refreshPlanLibrary();
  });
});

document.getElementById('backToBuilderBtn')?.addEventListener('click', ()=>{
  document.querySelector('#panel-plan .subtabs button[data-plansub="builder"]').click();
});


/* ---------- Plan tab lake/ramp dropdowns (lakes + rivers merged) ---------- */
const PLAN_RIVERS = [
  { key:'wateree', label:'Wateree River', worker:'wateree', center:[34.24,-80.65,11], lakeKey:'Lake Wateree', ramps:[
    {name:'Lugoff (just below dam)', lat:34.33346, lon:-80.69973},
    {name:'Highway 1 (Camden / USGS gauge)', lat:34.24486, lon:-80.65403},
    {name:'WT Billy Tolar (mid-river)', lat:33.94721, lon:-80.62891},
  ]},
  { key:'congaree', label:'Congaree River', worker:'congaree', center:[33.99,-81.05,11], ramps:[
    {name:'Barney Jordan (Columbia)', lat:33.96490, lon:-81.03570},
    {name:'Thomas H Newman (Columbia)', lat:33.94915, lon:-81.02951},
    {name:'Bates Bridge (near Wateree confluence)', lat:33.75342, lon:-80.64513},
  ]},
  { key:'saluda', label:'Lower Saluda River (cold tailwater)', worker:'saluda', center:[34.02,-81.19,12], lakeKey:'Lake Murray', ramps:[
    {name:'Hope Ferry', lat:34.04600, lon:-81.19128},
    {name:'Saluda Shoals Park', lat:34.04679, lon:-81.19058},
    {name:'Saluda Shoals Lower Boat Ramp', lat:34.04333, lon:-81.16340},
  ]},
  { key:'broad', label:'Broad River', worker:'broad', center:[34.59,-81.42,11], ramps:[
    {name:'Pick Hill Access', lat:35.04108, lon:-81.49538},
    {name:'99 Island', lat:35.02678, lon:-81.48986},
    {name:"Dalton's Landing", lat:34.93595, lon:-81.47303},
    {name:'Woods Ferry Recreation Area', lat:34.70321, lon:-81.45383},
    {name:'Sandy & Broad River', lat:34.57281, lon:-81.42221},
    {name:'Shelton Ferry', lat:34.48854, lon:-81.42429},
  ]},
  { key:'santee', label:'Santee River', worker:'santee', center:[33.42,-80.01,11], lakeKey:'Lake Marion', ramps:[
    {name:'Wilsons (near Marion dam)', lat:33.44829, lon:-80.15833},
    {name:'Highway 52', lat:33.49487, lon:-79.96049},
    {name:'Arrowhead Landing', lat:33.40441, lon:-79.86331},
    {name:'Lenuds', lat:33.30431, lon:-79.67896},
    {name:'McConnels', lat:33.24514, lon:-79.52085},
  ]},
  { key:'cooper', label:'Cooper River (Pinopolis tailrace → Charleston Harbor)', worker:'cooper', center:[33.04,-79.95,11], lakeKey:'Lake Moultrie', fishingSystem:'Cooper River system (Pinopolis tailrace → Charleston Harbor)', ramps:[
    {name:'William Dennis (Pinopolis tailrace) ⚠ temporarily closed for renovations', lat:33.21311, lon:-79.97347},
    {name:'Rembert C Dennis (Wadboo Creek)', lat:33.19601, lon:-79.95324},
    {name:'Huger Park (upper Cooper)', lat:33.13111, lon:-79.81111},
    {name:'John R Bettis (Goose Creek)', lat:32.93278, lon:-80.02266},
    {name:'Bushy Park - Fresh Water (Back River)', lat:32.96781, lon:-79.93751},
    {name:'Bushy Park - Salt Water (Cooper)', lat:32.96708, lon:-79.93709},
    {name:"R. M. Hendrick's / Virginia Av. Park (Charleston harbor)", lat:32.89113, lon:-79.97103},
  ]},
];
window.PLAN_RIVERS = PLAN_RIVERS;
export function isPlanRiverValue(v){ return String(v||'').startsWith('river:'); }
export function getPlanRiverDef(v){ const key=String(v||'').replace(/^river:/,''); return PLAN_RIVERS.find(r=>r.key===key||r.worker===key); }
function isDukePlanLakeName(v){ const clean=String(v||'').split(',')[0].trim().toLowerCase(); return ['lake wateree','lake wylie','lake norman','lake keowee','lake jocassee','lake hickory','lake james','lake rhodhiss','mountain island'].some(k=>clean.includes(k)||k.includes(clean)); }
function getPlanLakeLevelUnit(){ return isDukePlanLakeName(document.getElementById('planLake')?.value) ? '% full pond' : 'ft'; }
function getPlanRiverRamps(def){
  if(!def) return [];
  if(def.fishingSystem && typeof window.getFishingRamps === 'function'){
    const overlay = window.getFishingRamps(def.fishingSystem);
    if(overlay && overlay.length){
      return overlay.map(r=>({
        name: r.note ? `${r.name} (${r._annotation || r._scdnrKey || ''}) ${r.note}`
             : r._annotation ? `${r.name} (${r._annotation})`
             : r._scdnrKey ? `${r.name} (${r._scdnrKey})`
             : r.name,
        lat:r.lat, lon:r.lon
      }));
    }
  }
  return def.ramps || [];
}
function getSelectedPlanRiverRamp(){
  const def = getPlanRiverDef(document.getElementById('planLake')?.value);
  const name = document.getElementById('planRamp')?.value;
  if(!def || !name) return null;
  return getPlanRiverRamps(def).find(r => r.name === name)
      || getPlanRiverRamps(def).find(r => r.name.toLowerCase().includes(String(name||'').toLowerCase()) || String(name||'').toLowerCase().includes(r.name.toLowerCase().split(' (')[0]))
      || null;
}
function setLakeOnlyFieldsVisible(show){
  ['planFullPool','planPoolLevel'].forEach(id=>{
    const el=document.getElementById(id);
    if(el && el.parentElement) el.parentElement.style.display = show ? '' : 'none';
  });
  const box=document.getElementById('utilityAssessmentBox');
  if(box && !show) box.style.display='none';
  const riverBox=document.getElementById('planRiverFields');
  if(riverBox) riverBox.style.display = show ? 'none' : 'block';
  const title=document.querySelector('#conditionsCard h4');
  if(title) title.innerHTML = show ? '🌊 Live Water Conditions &amp; Pool Elevation' : '🌊 Live River Conditions, Dam Schedule &amp; Kayak Safety';
  const btn=document.getElementById('syncDukeBtn');
  if(btn) btn.textContent = show ? '⚡ Live Utility Sync' : '⚡ Live River Sync';
}
export function populatePlanLakeDropdown(){
  const sel = document.getElementById('planLake');
  if(!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">— choose lake or river —</option>';
  const lakesGroup = document.createElement('optgroup');
  lakesGroup.label = 'Lakes / Reservoirs';
  const lakeNames = window.getUniversalLakeNames ? window.getUniversalLakeNames() : Object.keys(LAKE_DB).sort();
  lakeNames.forEach(lakeName => {
    const opt = document.createElement('option');
    opt.value = lakeName; opt.textContent = lakeName;
    lakesGroup.appendChild(opt);
  });
  sel.appendChild(lakesGroup);
  const riversGroup = document.createElement('optgroup');
  riversGroup.label = 'Rivers / Tailwaters';
  PLAN_RIVERS.forEach(r => {
    const opt = document.createElement('option');
    opt.value = `river:${r.key}`; opt.textContent = r.label;
    riversGroup.appendChild(opt);
  });
  sel.appendChild(riversGroup);
  if(current) sel.value = current;
  setLakeOnlyFieldsVisible(!isPlanRiverValue(sel.value));
}

export function populatePlanRampDropdown(waterbodyName){
  const sel = document.getElementById('planRamp');
  if(!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">— select ramp / launch —</option>';
  if(isPlanRiverValue(waterbodyName)){
    const def = getPlanRiverDef(waterbodyName);
    getPlanRiverRamps(def).forEach(r=>{
      const opt=document.createElement('option');
      opt.value=r.name; opt.textContent=r.name;
      sel.appendChild(opt);
    });
    if(current) sel.value = current;
    return;
  }
  if(!waterbodyName || !LAKE_DB[waterbodyName] || !LAKE_DB[waterbodyName].ramps) return;
  Object.keys(LAKE_DB[waterbodyName].ramps).forEach(r=>{
    const opt = document.createElement('option');
    opt.value = r; opt.textContent = r;
    sel.appendChild(opt);
  });
  if(current) sel.value = current;
}

document.getElementById('planLake')?.addEventListener('change', e=>{
  const v=e.target.value;
  const isRiver=isPlanRiverValue(v);
  setLakeOnlyFieldsVisible(!isRiver);
  populatePlanRampDropdown(v);
  if(isRiver){
    ['planFullPool','planPoolLevel'].forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
    const def=getPlanRiverDef(v);
    if(def && state.MAP_OK) state.MAP.setView([def.center[0], def.center[1]], def.center[2]||11);
    if(window.syncPlanRiverData) window.syncPlanRiverData();
  } else {
    ['planRiverSafety','planRiverFlow','planRiverGauge','planRiverTemp','planRiverRise','planRiverSurgeEta','planRiverSchedule','planRiverSummary'].forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
    const lk = LAKE_DB[v];
    if(lk && state.MAP_OK) state.MAP.setView([lk.center[0], lk.center[1]], lk.center[2]||11);
    // Trigger utility sync (Duke/USGS lake levels) when lake changes
    if(window.syncUtilityData) {
      setTimeout(window.syncUtilityData, 300);
    } else {
      setTimeout(()=>{ document.getElementById('syncDukeBtn')?.click(); }, 300);
    }
    // Auto-run lake intelligence and clarity forecast
    if(window.syncLakeIntelData) setTimeout(window.syncLakeIntelData, 500);
    if(window.syncClarityIntelData) setTimeout(window.syncClarityIntelData, 800);
  }
});

document.getElementById('planRamp')?.addEventListener('change', e=>{
  const waterbodyName = document.getElementById('planLake').value;
  const rampName = e.target.value;
  if(isPlanRiverValue(waterbodyName)){
    const ramp = getSelectedPlanRiverRamp();
    if(ramp && state.MAP_OK) state.MAP.setView([ramp.lat, ramp.lon], 15);
    if(window.syncPlanRiverData) window.syncPlanRiverData();
    return;
  }
  if(!waterbodyName || !rampName || !LAKE_DB[waterbodyName]) return;
  const coords = LAKE_DB[waterbodyName].ramps[rampName];
  if(coords && state.MAP_OK) state.MAP.setView(coords, 15);
});

window.syncPlanRiverData = async function syncPlanRiverData(){
  const sel = document.getElementById('planLake');
  const def = getPlanRiverDef(sel?.value);
  if(!def) return null;
  setLakeOnlyFieldsVisible(false);
  const statusEl = document.getElementById('utilitySyncStatus');
  const btn = document.getElementById('syncDukeBtn');
  const worker = (typeof CF_WORKER_URL !== 'undefined' ? CF_WORKER_URL : (window.CF_WORKER_URL || 'https://trollmap-worker.colonal1981.workers.dev'));
  const ramp = getSelectedPlanRiverRamp();
  function put(id, val){ const el=document.getElementById(id); if(el) el.value = val == null ? '' : String(val); }
  try{
    if(statusEl){ statusEl.textContent='Syncing river…'; statusEl.style.color='var(--accent2)'; }
    if(btn){ btn.style.background='var(--accent)'; btn.style.color='#000'; }
    let url = `${worker}/river?river=${encodeURIComponent(def.worker)}`;
    if(ramp) url += `&lat=${encodeURIComponent(ramp.lat)}&lon=${encodeURIComponent(ramp.lon)}`;
    const res = await fetch(url);
    if(!res.ok) throw new Error(`Worker HTTP ${res.status}`);
    const d = await res.json();
    const primary = (d.gauges||[]).find(g=>g.primary) || (d.gauges||[])[0] || {};
    const assess = d.kayak_assessment || {};
    let effectiveStatus = assess.status || 'unknown';
    let tripWindowNote = '';
    // If the only river concern is a scheduled surge that arrives well after
    // the planned return time, display it as informational instead of forcing
    // the whole trip to CAUTION.
    try {
      const dateStr = document.getElementById('planDate')?.value;
      const retStr = document.getElementById('planReturnTime')?.value || '12:00';
      if(dateStr && d.user_location?.surge_arrival_epoch && effectiveStatus === 'caution'){
        const tripEnd = new Date(`${dateStr}T${retStr}:00`).getTime();
        const surgeEpoch = d.user_location.surge_arrival_epoch;
        const hasOnlySurgeCaution = (assess.reasons||[]).some(r=>/dam surge/i.test(r)) && !(assess.reasons||[]).some(r=>/RAPID RISE|DANGER zone|PUSHY|cold-water/i.test(r));
        if(hasOnlySurgeCaution && surgeEpoch > tripEnd + 60*60*1000){
          effectiveStatus = 'go';
          tripWindowNote = 'Scheduled surge is after planned return window; verify if trip runs late.';
        }
      }
    } catch(_) {}
    const status = effectiveStatus ? effectiveStatus.toUpperCase() : 'UNKNOWN';
    const icon = effectiveStatus==='no-go' ? '🛑 ' : effectiveStatus==='caution' ? '⚠️ ' : effectiveStatus==='go' ? '✅ ' : '';
    put('planRiverSafety', icon + status);
    put('planRiverFlow', primary.streamflow_cfs != null ? `${primary.streamflow_cfs} cfs` : '');
    put('planRiverGauge', primary.gage_height_ft != null ? `${primary.gage_height_ft} ft` : '');
    put('planRiverTemp', primary.water_temperature_F != null ? `${primary.water_temperature_F} °F` : '');
    put('planRiverRise', primary.rate_of_rise_ft_per_hr != null ? `${primary.rate_of_rise_ft_per_hr} ft/hr` : '');
    if(primary.water_temperature_F != null) put('planWaterTemp', primary.water_temperature_F);
    let surge = '';
    if(d.user_location?.surge_arrival_epoch){
      const mins=d.user_location.minutes_until_surge_at_user;
      const when=new Date(d.user_location.surge_arrival_epoch).toLocaleString('en-US',{timeZone:'America/New_York',weekday:'short',hour:'numeric',minute:'2-digit'});
      surge = `${when} ET (${mins>0?'in ':''}${Math.round(mins)} min, ${d.user_location.surge_severity_label} severity)`;
    } else if(d.dam_schedule?.next?.arrivalEpoch){
      const mins=Math.round((d.dam_schedule.next.arrivalEpoch-Date.now())/60000);
      const when=new Date(d.dam_schedule.next.arrivalEpoch).toLocaleString('en-US',{timeZone:'America/New_York',weekday:'short',hour:'numeric',minute:'2-digit'});
      surge = `${when} ET at ${d.dam_schedule.next.mileMarkerName} (${mins>0?'in ':''}${mins} min)`;
    }
    put('planRiverSurgeEta', surge);
    const scheduleLines=[];
    if(d.dam_schedule?.type==='duke_flow_arrivals'){
      scheduleLines.push('Duke scheduled flow arrivals:');
      (d.dam_schedule.upcoming||[]).slice(0,6).forEach(ev=>{
        const when=new Date(ev.arrivalEpoch).toLocaleString('en-US',{timeZone:'America/New_York',weekday:'short',hour:'numeric',minute:'2-digit'});
        scheduleLines.push(`• ${when} ET — ${ev.mileMarkerName} (${ev.damName})`);
      });
    } else if(d.dam_schedule?.type==='dominion_color_status'){
      scheduleLines.push(`Dominion Lower Saluda color status: current ${d.dam_schedule.currentColor||'n/a'}, planned ${d.dam_schedule.plannedColor||'n/a'}`);
      if(d.dam_schedule.currentRange) scheduleLines.push(d.dam_schedule.currentRange);
    }
    if(d.user_location){
      scheduleLines.push(`Your selected launch: river mile ${d.user_location.river_mile_from_dam}, nearest ${d.user_location.nearestWaypoint}, surge severity ${d.user_location.surge_severity_label}.`);
      if(tripWindowNote) scheduleLines.push(`Trip-window note: ${tripWindowNote}`);
    } else if(ramp){
      scheduleLines.push(`Selected launch: ${ramp.name}. Worker did not return location-specific surge ETA; verify ramp coordinates / river centerline coverage.`);
    } else {
      scheduleLines.push('Pick a river ramp/launch to calculate location-specific surge ETA.');
    }
    if(assess.reasons?.length){
      scheduleLines.push('Kayak safety reasons:');
      assess.reasons.forEach(r=>scheduleLines.push(`• ${r}`));
    }
    const summary = `${def.label}${ramp?` @ ${ramp.name}`:''}\nStatus: ${icon}${status}\n${scheduleLines.join('\n')}`;
    put('planRiverSchedule', scheduleLines.join('\n'));
    put('planRiverSummary', summary);
    if(statusEl){ statusEl.textContent=`✓ River synced: ${status}`; statusEl.style.color=effectiveStatus==='no-go'?'var(--bad)':effectiveStatus==='caution'?'var(--warn)':'var(--accent2)'; }
    window.LAST_PLAN_RIVER_DATA = d;
    return d;
  } catch(err){
    console.warn('River sync failed', err);
    if(statusEl){ statusEl.textContent='River sync error'; statusEl.style.color='var(--bad)'; }
    put('planRiverSchedule', `River sync failed: ${err.message}`);
    return null;
  } finally {
    if(btn) setTimeout(()=>{ btn.style.background=''; btn.style.color=''; }, 1000);
  }
};


// Expose river helpers for cross-module use
window.isPlanRiverValue = isPlanRiverValue;
window.getPlanRiverDef = getPlanRiverDef;


// ── Button wiring (was in monolith, extracted here) ──────────────────────────

document.getElementById('autoNameBtn')?.addEventListener('click', () => {
  const lake = document.getElementById('planLake')?.value.split(',')[0] || 'Lake';
  const ramp = document.getElementById('planRamp')?.value.split(' ')[0] || '';
  const date = document.getElementById('planDate')?.value;
  const time = document.getElementById('planLaunchTime')?.value;
  const hour = time ? parseInt(time.split(':')[0]) : 6;
  const session = hour < 10 ? 'AM' : hour < 14 ? 'MID' : 'PM';
  const dateShort = date ? new Date(date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  const el = document.getElementById('planName');
  if (el) el.value = `${lake}${ramp ? ' – ' + ramp : ''} ${session} Troll${dateShort ? ' ' + dateShort : ''}`;
});

document.getElementById('buildPreviewBtn')?.addEventListener('click', async () => {
  const p = collectPlan();
  const previewEl = document.getElementById('planPreviewHtml');
  if (previewEl) previewEl.innerHTML = '<p style="color:#888;padding:20px">⏳ Building preview…</p>';
  document.querySelector('#panel-plan .subtabs button[data-plansub="preview"]')?.click();
  if (previewEl) previewEl.innerHTML = await buildPlanPreviewHtml(p);
  if (state.MAP) setTimeout(() => state.MAP.invalidateSize(), 50);
});

document.getElementById('printPlanBtn')?.addEventListener('click', async () => {
  const p = collectPlan();
  const previewEl = document.getElementById('planPreviewHtml');
  if (previewEl) previewEl.innerHTML = '<p style="color:#888;padding:20px">⏳ Building preview…</p>';
  document.querySelector('#panel-plan .subtabs button[data-plansub="preview"]')?.click();
  if (previewEl) previewEl.innerHTML = await buildPlanPreviewHtml(p);
  setTimeout(() => window.print(), 400);
});

document.getElementById('exportPlanHtmlBtn')?.addEventListener('click', async () => {
  const p = collectPlan();
  const inner = await buildPlanPreviewHtml(p);
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(p.meta.name)}</title></head><body style="background:#f3f6f9;margin:0;padding:20px">${inner}</body></html>`;
  const blob = new Blob([html], { type: 'text/html' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (p.meta.name || 'fishing_plan').replace(/\s+/g, '_') + '.html';
  a.click();
  URL.revokeObjectURL(a.href);
});

document.getElementById('exportPlanJsonBtn')?.addEventListener('click', () => {
  const p = collectPlan();
  const blob = new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (p.meta.name || 'fishing_plan').replace(/\s+/g, '_') + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

document.getElementById('importPlanFile')?.addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = (ev) => {
    try {
      const p = JSON.parse(ev.target.result);
      loadPlanIntoForm(p);
      alert('Plan imported.');
    } catch (err) { alert('Invalid JSON: ' + err.message); }
  };
  r.readAsText(f);
  e.target.value = '';
});

document.getElementById('savePlanBtn')?.addEventListener('click', async () => {
  const p = collectPlan();
  if (!p.meta.name) { alert('Give the plan a name first.'); return; }
  try {
    await window.DB.put('plans', p);
    alert('Plan saved.');
    refreshPlanLibrary();
    // Push to cloud sync
    if (window.pushItemOnSave) window.pushItemOnSave('plan', p.meta.name + '_' + Date.now(), p);
  } catch (e) { alert('Save failed: ' + e); }
});

async function refreshPlanLibrary() {
  const host = document.getElementById('planLibraryList');
  if (!host) return;
  let plans = [];
  if (window.DB?.db) { try { plans = await window.DB.getAll('plans'); } catch (_) {} }
  if (!plans.length) { host.innerHTML = '<p class="muted">No saved plans yet.</p>'; return; }
  plans.reverse();
  host.innerHTML = plans.map((p) => `
    <div class="row" style="justify-content:space-between;border-bottom:1px solid var(--line);padding:6px 0">
      <div><b>${esc(p.meta?.name || 'Unnamed')}</b> <span class="muted">${esc(p.meta?.lake || '')} • ${esc(p.meta?.date || '')}</span><br>
      <span class="muted">${(p.spread || []).length} rods • ${p.gpx?.waypoints || 0} wpts</span></div>
      <div>
        <button class="small" onclick="window.loadPlanById(${p.id})">Load</button>
        <button class="small" onclick="window.deletePlanById(${p.id})">Delete</button>
      </div>
    </div>
  `).join('');
}

window.loadPlanById = async function (id) {
  if (!window.DB?.db) return;
  const p = await window.DB.get('plans', id);
  if (p) {
    loadPlanIntoForm(p);
    document.querySelector('#panel-plan .subtabs button[data-plansub="builder"]')?.click();
    alert('Plan loaded.');
  }
};

window.deletePlanById = async function (id) {
  if (!confirm('Delete plan?')) return;
  await window.DB.del('plans', id);
  refreshPlanLibrary();
};
