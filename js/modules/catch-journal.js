/**
 * catch-journal.js — TrollMap Catch Center
 *
 * Drop-in replacement for js/modules/catch-journal.js.
 * Adds:
 *   - CSV import into a human review queue
 *   - support for old v2 recovered CSVs and newer v3 sorter CSVs
 *   - large local photo preview via local helper server
 *   - verified species/length fields before approving to journal
 *   - export of cleaned candidates CSV
 */

import { state } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { LAKE_DB } from '../data/lakes.js';
import { loadAccessIndex, nearestLakeByAccessPoint } from '../data/access-index.js';
import { LURE_PRESETS } from './spread-builder.js';

const DEFAULT_HELPER = 'http://127.0.0.1:8787';
const QUEUE_DB_KEY = 'catch_import_queue';
const CATCHES_DB_KEY = 'catches';

function getCatches() { return state.CATCHES || (state.CATCHES = []); }
function setCatches(arr) { state.CATCHES = arr || []; }
function getQueue() { return state.CATCH_IMPORT_QUEUE || (state.CATCH_IMPORT_QUEUE = []); }
function setQueue(arr) { state.CATCH_IMPORT_QUEUE = arr || []; }

let selectedQueueId = null;
let currentSubtab = 'review';
const localPhotoUrls = new Map(); // filename(lower) -> object URL from folder picker
const localPhotoFiles = new Map();
window.TM_CATCH_PHOTO_URLS = localPhotoUrls;
window.TM_CATCH_PHOTO_FILES = localPhotoFiles;

const SPECIES = [
  '', 'Striped Bass', 'White Bass / Hybrid', 'Largemouth Bass', 'Spotted Bass', 'Smallmouth Bass',
  'Crappie', 'Black Crappie', 'White Crappie', 'Catfish', 'Blue Catfish', 'Channel Catfish', 'Flathead Catfish',
  'Bowfin', 'Chain Pickerel', 'Bluegill', 'Sunfish (Panfish)', 'Redear Sunfish (Shellcracker)',
  'Yellow Perch', 'Gar', 'Longnose Gar', 'Red Drum (Redfish)', 'Speckled Trout (Spotted Seatrout)',
  'Flounder', 'American Shad', 'Other Fish', 'Not Fish'
];

function parseBool(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return ['true', '1', 'yes', 'y'].includes(s);
}
function cleanSpecies(s) {
  s = String(s || '').trim();
  const map = {
    'White Bass/Hybrid': 'White Bass / Hybrid',
    'Hybrid': 'White Bass / Hybrid',
    'Striper': 'Striped Bass',
    'Black Bass': 'Largemouth Bass',
    'Bowfin (Mudfish)': 'Bowfin',
    'Mudfish': 'Bowfin',
    'Bowfin Mudfish': 'Bowfin',
    'Black Crappie': 'Crappie',
    'White Crappie': 'Crappie',
    'Red Drum (Redfish)': 'Red Drum (Redfish)',
    'Speckled Trout (Spotted Seatrout)': 'Speckled Trout (Spotted Seatrout)',
    'Sunfish': 'Sunfish (Panfish)',
    // FIX (2026-07-03): Shad was dropped from SPECIES at some point — 2
    // existing catches logged under the plain 'Shad' string were left
    // orphaned. Restored as 'American Shad' to match SCDNR's own
    // terminology; this mapping normalizes any pre-existing rows.
    'Shad': 'American Shad',
    'No Fish': 'Not Fish',
    'None': ''
  };
  return map[s] || s;
}
function inferSpeciesFromNotes(species, notes) {
  const raw = cleanSpecies(species);
  if (raw && !['other fish', 'unknown', 'not fish', 'no fish'].includes(raw.toLowerCase())) {
    return { species: raw, flag: '' };
  }
  const n = String(notes || '').toLowerCase();
  const patterns = [
    ['Striped Bass', /\b(striped bass|striper)\b/],
    ['Largemouth Bass', /\b(largemouth|large mouth|black bass)\b/],
    ['Smallmouth Bass', /\bsmallmouth\b/],
    ['Spotted Bass', /\bspotted bass\b/],
    ['Crappie', /\b(crappie|black crappie|white crappie)\b/],
    ['Catfish', /\b(catfish|blue cat|channel cat|flathead|barbels)\b/],
    ['Bowfin', /\b(bowfin|mudfish)\b/],
    ['Chain Pickerel', /\b(chain pickerel|pickerel)\b/],
    ['Bluegill', /\bbluegill\b/],
    ['Sunfish (Panfish)', /\b(sunfish|panfish|shellcracker|redear|redbreast)\b/],
    ['Gar', /\bgar\b/],
    ['Yellow Perch', /\byellow perch\b/],
    ['White Bass / Hybrid', /\b(white bass|hybrid)\b/],
    ['Red Drum (Redfish)', /\b(redfish|red drum)\b/],
    ['Speckled Trout (Spotted Seatrout)', /\b(speckled trout|spotted seatrout)\b/],
    ['Flounder', /\bflounder\b/]
  ];
  for (const [sp, re] of patterns) if (re.test(n)) return { species: sp, flag: 'inferred_from_notes' };
  return { species: raw, flag: '' };
}
function stableId(obj) {
  const key = [obj.sha256, obj.filename, obj.datetime, obj.sourcePath].filter(Boolean).join('|');
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return 'cq_' + (h >>> 0).toString(16);
}
function splitDateTime(dt) {
  dt = String(dt || '').trim();
  if (!dt) return { date: '', time: '' };
  if (dt.includes('T')) {
    const [d, t] = dt.split('T');
    return { date: d, time: (t || '').slice(0, 8) };
  }
  if (dt.includes(' ')) {
    const [d, t] = dt.split(' ');
    return { date: d.replaceAll(':', '-'), time: (t || '').slice(0, 8) };
  }
  return { date: dt.slice(0, 10), time: '' };
}
function displayTime(t) {
  t = String(t || '').trim();
  if (!t) return '';
  const m = t.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return t;
  let h = +m[1]; const min = m[2]; const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${min} ${ap}`;
}

function moonPhaseLabel(isoDate) {
  const d = new Date(isoDate);
  if (Number.isNaN(+d)) return '';
  const JD = d / 86400000 + 2440587.5;
  const phase = ((JD - 2451550.1) / 29.530588) % 1;
  const p = phase < 0 ? phase + 1 : phase;
  if (p < 0.03 || p > 0.97) return 'New Moon';
  if (p < 0.22) return 'Waxing Crescent';
  if (p < 0.28) return 'First Quarter';
  if (p < 0.47) return 'Waxing Gibbous';
  if (p < 0.53) return 'Full Moon';
  if (p < 0.72) return 'Waning Gibbous';
  if (p < 0.78) return 'Last Quarter';
  return 'Waning Crescent';
}

function itemIsoDateTime(item) {
  if (item?.datetime) return String(item.datetime).replace(' ', 'T');
  if (item?.date) return `${item.date}T${item.time || '12:00:00'}`;
  return '';
}

async function fetchHistoricalWeatherForItem(item) {
  const lat = parseFloat(item?.lat), lon = parseFloat(item?.lon);
  const iso = itemIsoDateTime(item);
  if (!isFinite(lat) || !isFinite(lon) || !iso) return null;
  const dateOnly = iso.slice(0, 10);
  let hour = parseInt((iso.split('T')[1] || '12:00').slice(0, 2), 10);
  if (!isFinite(hour) || hour < 0 || hour > 23) hour = 12;
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${dateOnly}&end_date=${dateOnly}&hourly=temperature_2m,surface_pressure,cloudcover,windspeed_10m,winddirection_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FNew_York`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Open-Meteo ${resp.status}`);
  const data = await resp.json();
  const h = data.hourly || {};
  return {
    tempF: h.temperature_2m?.[hour] != null ? Math.round(h.temperature_2m[hour] * 10) / 10 : null,
    pressureHpa: h.surface_pressure?.[hour] != null ? Math.round(h.surface_pressure[hour]) : null,
    cloudPct: h.cloudcover?.[hour] ?? null,
    windMph: h.windspeed_10m?.[hour] != null ? Math.round(h.windspeed_10m[hour] * 10) / 10 : null,
    windDir: h.winddirection_10m?.[hour] ?? null,
    moonPhase: moonPhaseLabel(iso),
    source: 'open-meteo-archive',
    fetchedAt: new Date().toISOString()
  };
}

function nearestLakeAndContour(latRaw, lonRaw) {
  const lat = parseFloat(latRaw), lon = parseFloat(lonRaw);
  const out = { lake: '', depth: '', depthBand: '', contourDistanceMi: null };
  if (!isFinite(lat) || !isFinite(lon)) return out;

  // Lake name: prefer the worker-backed access index (hundreds of real
  // DNR-known waterbodies, matched by distance to an actual access point)
  // over the curated LAKE_DB (~40 lakes, matched by distance to a guessed
  // centroid within a flat 20mi fallback radius). Falls back to LAKE_DB
  // only if the access index has nothing within range — e.g. before the
  // worker fetch has resolved, or the worker is briefly unreachable.
  try {
    const accessMatch = nearestLakeByAccessPoint(lat, lon, 2.0);
    if (accessMatch.lake) {
      out.lake = accessMatch.lake;
      out.lakeSource = 'access-index';
      out.lakeMatchDistanceMi = accessMatch.distanceMi;
    } else {
      const db = LAKE_DB || {};
      let bestName = '', bestDist = Infinity;
      for (const [name, info] of Object.entries(db)) {
        if (!info?.center) continue;
        const cLat = Array.isArray(info.center) ? info.center[0] : info.center.lat;
        const cLon = Array.isArray(info.center) ? info.center[1] : info.center.lon;
        if (!isFinite(cLat) || !isFinite(cLon)) continue;
        const d = Math.hypot((lat - cLat) * 69, (lon - cLon) * 69 * Math.cos(lat * Math.PI / 180));
        const radius = info.radiusMi || info.radius || 20;
        if (d < bestDist && d <= radius) { bestDist = d; bestName = name; }
      }
      if (bestName) {
        out.lake = bestName;
        out.lakeSource = 'lake-db-fallback';
        out.lakeMatchDistanceMi = bestDist;
      }
    }
  } catch (_) {}

  // Nearest loaded contour from TrollMap contour layer.
  try {
    const contourData = state.ACTIVE_CONTOUR;
    const features = contourData?.smart?.features || contourData?.raw?.features || [];
    if (!features.length) return out;
    const cosLat = Math.cos(lat * Math.PI / 180);
    const boxDeg = 1 / 69; // 1 mile prefilter
    let closestDepth = null, closestDist = Infinity;
    const candidates = features.filter(feat => {
      const b = feat.bbox;
      if (!b) return true;
      return b[0] - boxDeg <= lon && lon <= b[2] + boxDeg && b[1] - boxDeg <= lat && lat <= b[3] + boxDeg;
    });
    for (const feat of candidates) {
      const depth = feat.properties?.depth ?? feat.properties?.DEPTH ?? feat.properties?.depth_ft ?? feat.properties?.Depth;
      if (depth == null || depth === '') continue;
      const geom = feat.geometry;
      const coords = geom?.coordinates;
      if (!coords) continue;
      let lines = [];
      if (geom.type === 'LineString') lines = [coords];
      else if (geom.type === 'MultiLineString') lines = coords;
      else if (geom.type === 'Polygon') lines = coords;
      else if (geom.type === 'MultiPolygon') lines = coords.flat(1);
      else continue;
      for (const line of lines) {
        for (const pt of line) {
          if (!Array.isArray(pt) || pt.length < 2) continue;
          const cLon = Number(pt[0]), cLat = Number(pt[1]);
          if (!isFinite(cLat) || !isFinite(cLon)) continue;
          const d = Math.hypot((lat - cLat) * 69, (lon - cLon) * 69 * cosLat);
          if (d < closestDist) { closestDist = d; closestDepth = depth; }
        }
      }
    }
    if (closestDepth != null && closestDist <= 1.0) {
      out.depth = String(closestDepth);
      out.contourDistanceMi = closestDist;
      const relation = closestDist < 0.10 ? 'on' : closestDist < 0.25 ? 'near' : 'near';
      out.depthBand = `~${closestDepth}ft contour (${relation}, ${closestDist.toFixed(2)} mi)`;
    }
  } catch (_) {}
  return out;
}

function enrichItemFromGps(item) {
  if (!item) return item;
  const spatial = nearestLakeAndContour(item.lat, item.lon);
  if (!item.lake && spatial.lake) item.lake = spatial.lake;
  if (!item.depth && spatial.depth) item.depth = spatial.depth;
  if (spatial.depthBand) {
    item.structure = { depthBand: spatial.depthBand, contourDistanceMi: spatial.contourDistanceMi };
    const note = `Depth lookup: ${spatial.depthBand}`;
    if (!String(item.ai?.notes || '').includes('Depth lookup:')) {
      item.ai.notes = [item.ai?.notes || '', note].filter(Boolean).join(' | ');
    }
    if (!item.reviewFlags.includes('depth_from_contours')) item.reviewFlags.push('depth_from_contours');
  } else if (item.lat && item.lon && !item.reviewFlags.includes('depth_not_found')) {
    item.reviewFlags.push('depth_not_found');
  }
  return item;
}

function normalizeCsvRow(row, importedFrom = 'csv') {
  const filename = row.filename || row.file || row.name || '';
  const datetime = row.master_datetime || row.datetime || row.datetime_v3 || row.datetime_v2 || row.date_time || row.timestamp || '';
  const { date, time } = splitDateTime(datetime);
  const notes = row.master_notes || row.notes || row.stage2_notes || row.ai_notes || '';
  const rawSpecies = cleanSpecies(row.master_species || row.verified_species || row.species || row.stage2_species || row.ai_species || row.stage1_species || '');
  const inferred = inferSpeciesFromNotes(rawSpecies, notes);

  const masterFishPresent = Object.prototype.hasOwnProperty.call(row, 'master_has_fish') && String(row.master_has_fish || '').trim() !== '';
  const hasFishFieldPresent = Object.prototype.hasOwnProperty.call(row, 'has_fish') && String(row.has_fish || '').trim() !== '';
  const stage1FishFieldPresent = Object.prototype.hasOwnProperty.call(row, 'stage1_fish') && String(row.stage1_fish || '').trim() !== '';
  const finalSpecies = cleanSpecies(row.master_species || row.verified_species || row.species || row.stage2_species || row.ai_species || '');
  const finalSpeciesSaysFish = !!finalSpecies && !['not fish', 'no fish', 'error', 'none', 'unknown'].includes(finalSpecies.toLowerCase());
  
  let hasFish = false;
  if (masterFishPresent) hasFish = parseBool(row.master_has_fish);
  else if (hasFishFieldPresent) hasFish = parseBool(row.has_fish);
  else if (stage1FishFieldPresent) hasFish = parseBool(row.stage1_fish) || finalSpeciesSaysFish;
  else hasFish = finalSpeciesSaysFish;

  const onBoard = parseBool(row.master_on_bump_board || row.on_bump_board || row.on_bump_board_v3 || row.on_bump_board_v2);
  const aiLen = String(row.master_length_inches || row.length_inches || row.length_inches_v3 || row.length_inches_v2 || row.ai_length || row.aiLength || '').trim();
  const conf = row.master_confidence || row.confidence || row.stage2_confidence || row.stage1_confidence || '';
  const flags = [];
  if (!hasFish) flags.push('not_fish_or_rejected');
  if (onBoard) flags.push('verify_board_length_from_photo');
  if (onBoard && !aiLen) flags.push('board_missing_length');
  if (!inferred.species || ['Other Fish', 'Unknown'].includes(inferred.species)) flags.push('species_needs_review');
  if (inferred.flag) flags.push(inferred.flag);
  if (String(conf).toLowerCase().includes('low')) flags.push('low_confidence');
  if (rawSpecies !== inferred.species && inferred.species) flags.push('species_normalized');

  const item = {
    id: '',
    status: hasFish ? 'pending' : 'rejected_candidate',
    reviewFlags: [...new Set(flags)],
    filename,
    sourcePath: row.source_path || row.path || row.local_path || '',
    sha256: row.sha256 || '',
    datetime, date, time,
    lat: row.master_lat || row.lat || row.lat_v3 || row.lat_v2 || '', lon: row.master_lon || row.lon || row.lon_v3 || row.lon_v2 || '', lake: row.lake || '', depth: row.depth || '',
    ai: {
      hasFish, onBoard,
      species: rawSpecies,
      inferredSpecies: inferred.species,
      length: aiLen,
      confidence: conf,
      model: row.source_model || row.stage2_model || row.model || 'master_catalog',
      notes
    },
    verified: {
      hasFish,
      onBoard,
      species: row.verified_species || inferred.species || rawSpecies || '',
      length: row.verified_length_inches || row.verified_length || (onBoard ? aiLen : ''),
      lengthVerified: parseBool(row.length_verified) || !!(onBoard && aiLen),
      reviewed: false
    },
    weather: null,
    structure: null,
    importedFrom,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    raw: row
  };
  item.id = row.id || stableId(item);
  return item;
}

async function saveCatches() {
  try { await window.DB?.put('journal', { name: CATCHES_DB_KEY, data: getCatches() }); } catch (_) {}
  // Sync to cloud so catches are available across devices
  try { window.pushItemOnSave?.('catch', CATCHES_DB_KEY, { name: CATCHES_DB_KEY, data: getCatches() }); } catch (_) {}
}
async function saveQueue() {
  try { await window.DB?.put('journal', { name: QUEUE_DB_KEY, data: getQueue() }); } catch (_) {}
}
export async function loadCatches() {
  try {
    const r = await window.DB?.get('journal', CATCHES_DB_KEY);
    if (r) setCatches(r.data || []);
    const q = await window.DB?.get('journal', QUEUE_DB_KEY);
    if (q) setQueue(q.data || []);
  } catch (_) {}
  renderCatchCenter();
}

function helperBase() {
  return document.getElementById('catchHelperUrl')?.value?.trim() || localStorage.getItem('trollmapCatchHelperUrl') || DEFAULT_HELPER;
}
function baseName(p) {
  return String(p || '').split(/[\\/]/).pop().toLowerCase();
}
function imageUrl(item) {
  if (!item) return '';
  if (item.photoDataUrl) return item.photoDataUrl; // live nightly upload — stored directly, no folder needed
  const keys = [item.filename, baseName(item.sourcePath)].map(x => String(x || '').toLowerCase()).filter(Boolean);
  for (const key of keys) if (localPhotoUrls.has(key)) return localPhotoUrls.get(key);
  // Do NOT fall back to http://localhost from an HTTPS GitHub Pages app; Chrome blocks it as mixed content.
  // If no folder-picked file matches, show a no-photo warning instead of causing console spam.
  return '';
}
function thumbUrl(item) { return imageUrl(item); }

function catchPanelHost() {
  const panel = document.querySelector('#panel-catch .pad');
  return panel || document.getElementById('panel-catch');
}

export function renderCatchLog() { renderJournalOnly(); }

function renderCatchCenter() {
  const host = catchPanelHost();
  if (!host) return;
  host.innerHTML = `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        <h3 style="margin:0">🐟 Catch Center</h3>
        <div class="muted">AI candidates → human verified journal</div>
      </div>
      <div class="subtabs" style="margin-top:10px">
        <button data-catchsub="journal">📓 Journal</button>
        <button data-catchsub="import">📥 Import CSV</button>
        <button data-catchsub="review">✅ Review Queue</button>
        <button data-catchsub="analytics">📊 Analytics</button>
      </div>
      <div id="catchCenterBody"></div>
    </div>`;
  host.querySelectorAll('[data-catchsub]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.catchsub === currentSubtab);
    btn.addEventListener('click', () => { currentSubtab = btn.dataset.catchsub; renderCatchCenter(); });
  });
  renderCatchSubtab();
}

function renderCatchSubtab() {
  const body = document.getElementById('catchCenterBody');
  if (!body) return;
  if (currentSubtab === 'journal') renderJournalOnly(body);
  else if (currentSubtab === 'import') renderImport(body);
  else if (currentSubtab === 'analytics') renderAnalytics(body);
  else renderReview(body);
}

async function recheckJournalLakes(body = document.getElementById('catchCenterBody')) {
  const status = body?.querySelector('#journalRecheckStatus');
  const catches = getCatches();
  if (!catches.length) { if (status) status.textContent = 'No confirmed catches to check.'; return; }

  if (status) status.textContent = 'Loading lake database…';
  try { await loadAccessIndex(); } catch (_) {}

  let filled = 0, changed = 0, noGps = 0, stillBlank = 0;
  catches.forEach((c) => {
    if (!c.lat || !c.lon) { noGps++; return; }
    const spatial = nearestLakeAndContour(c.lat, c.lon);
    if (!spatial.lake) { stillBlank++; return; }
    if (!c.lake) {
      // Was blank — fill it in. This is the main case: catches imported
      // before a lake existed in LAKE_DB / the access index / the SCDNR
      // State Lakes supplement now resolve correctly.
      c.lake = spatial.lake;
      c.lakeSource = spatial.lakeSource;
      c.lakeMatchDistanceMi = spatial.lakeMatchDistanceMi;
      filled++;
    } else if (c.lake !== spatial.lake) {
      // Already had a value that disagrees with the current best match.
      // Deliberately NOT overwritten — a manually-entered or previously
      // correct lake name shouldn't be silently replaced. Flagged instead
      // so it can be reviewed.
      if (!c.reviewFlags) c.reviewFlags = [];
      if (!c.reviewFlags.includes('lake_mismatch_on_recheck')) {
        c.reviewFlags.push('lake_mismatch_on_recheck');
      }
      c.lakeRecheckSuggestion = spatial.lake;
      changed++;
    }
  });

  await saveCatches();
  renderJournalOnly(body);
  const newStatus = body?.querySelector('#journalRecheckStatus');
  if (newStatus) {
    newStatus.textContent =
      `Filled in ${filled} blank lake${filled === 1 ? '' : 's'}.` +
      (changed ? ` ${changed} existing entr${changed === 1 ? 'y' : 'ies'} disagreed with the current match — flagged for review, not overwritten.` : '') +
      (stillBlank ? ` ${stillBlank} still unmatched (no known lake within range).` : '') +
      (noGps ? ` ${noGps} skipped (no GPS on the catch).` : '');
  }
}

function renderJournalOnly(body = document.getElementById('catchCenterBody')) {
  const catches = getCatches();
  if (!body) return;
  body.innerHTML = `
    <div class="row">
      <button id="manualCatchBtn" class="primary small">+ Manual Catch</button>
      <button id="exportJournalBtn" class="small">⬇ Export Journal CSV</button>
      <button id="recheckLakesBtn" class="small">📍 Re-check Lakes (GPS)</button>
      <button id="deleteAllJournalBtn" class="warn small">🗑 Delete ALL Journal Catches</button>
      <span class="muted">${catches.length} confirmed catches</span>
    </div>
    <div id="journalRecheckStatus" class="muted" style="margin:4px 0;font-size:12px"></div>
    <div id="catchLogList"></div>`;
  const list = body.querySelector('#catchLogList');
  if (!catches.length) {
    list.innerHTML = '<p class="muted">No confirmed catches yet. Import CSV rows into the review queue, then approve them.</p>';
  } else {
    list.innerHTML = catches.map((c, i) => `
      <div style="display:flex;align-items:flex-start;gap:8px;padding:8px 0;border-bottom:1px solid var(--line);font-size:12px">
        <span style="font-size:18px">🐟</span>
        <div style="flex:1;min-width:0">
          <div><b>${esc(c.species || 'Fish')}</b>${c.length ? ` · ${esc(c.length)}"` : ''} · ${esc(c.date || '')} ${esc(c.time || '')} · ${esc(c.lake || '')}${c.reviewFlags?.includes('lake_mismatch_on_recheck') ? ` <span style="color:#e0a030">⚠ suggested: ${esc(c.lakeRecheckSuggestion || '')}</span>` : ''}</div>
          <div class="muted">${c.depth ? `Depth: ${esc(c.depth)}ft` : ''}${c.sourceFile ? ` · ${esc(c.sourceFile)}` : ''}${c.verification?.length ? ` · length: ${esc(c.verification.length)}` : ''}</div>
          ${c.notes ? `<div style="margin-top:2px">${esc(c.notes)}</div>` : ''}
        </div>
        <button data-delcatch="${i}" class="small">🗑</button>
      </div>`).join('');
  }
  body.querySelector('#manualCatchBtn')?.addEventListener('click', () => addManualCatch());
  body.querySelector('#exportJournalBtn')?.addEventListener('click', exportJournalCsv);
  body.querySelector('#recheckLakesBtn')?.addEventListener('click', () => recheckJournalLakes(body));
  body.querySelector('#deleteAllJournalBtn')?.addEventListener('click', async () => {
    const n = getCatches().length;
    if (!n) return;
    if (!confirm(`Delete ALL ${n} confirmed journal catches? This does not delete the review queue or photos.`)) return;
    setCatches([]);
    await saveCatches();
    renderJournalOnly(body);
  });
  body.querySelectorAll('[data-delcatch]').forEach(btn => btn.addEventListener('click', async () => {
    getCatches().splice(+btn.dataset.delcatch, 1);
    await saveCatches(); renderJournalOnly(body);
  }));
}

function renderImport(body) {
  body.innerHTML = `
    <div class="card" style="margin:0 0 12px 0;border-color:var(--accent)">
      <h3>🌙 Nightly Catch Upload — live AI ID, no offline script needed</h3>
      <p class="muted">Drop tonight's photos straight in. For each catch: shoot the <b>fish-on-board photo first</b>, then the <b>lure photo second</b>, within about 90 seconds of each other — TrollMap pairs them by timestamp automatically (swap button in review if it guesses wrong). AI only runs on the fish photo (species + length); the lure photo is never sent to AI — you just pick the lure yourself while looking at it, free.</p>
      <div class="filebox" id="nightlyDropBox">Drop tonight's photos here or click to choose (select all of them at once)</div>
      <input id="nightlyPhotoInput" type="file" accept="image/*" multiple class="hidden">
      <div id="nightlyUploadStatus" class="muted" style="margin-top:8px"></div>
    </div>
    <div class="grid" style="grid-template-columns:minmax(280px,1fr) minmax(280px,1fr);gap:12px">
      <div class="card" style="margin:0">
        <h3>📥 Import sorter CSV</h3>
        <p class="muted">Supports recovered v2 CSVs from 2023–2025 and the newer v3 2026 CSV.</p>
        <div class="filebox" id="csvDropBox">Drop CSV here or click to choose</div>
        <input id="catchCsvInput" type="file" accept=".csv" multiple class="hidden">
        <label style="display:flex;gap:6px;align-items:center;margin-top:8px"><input type="checkbox" id="boardOnlyImport" checked> board fish only / skip handheld fish</label>
        <label style="display:flex;gap:6px;align-items:center;margin-top:4px"><input type="checkbox" id="importRejectedRows"> include not-fish/rejected rows in queue</label>
        <label style="display:flex;gap:6px;align-items:center;margin-top:4px"><input type="checkbox" id="replaceQueueOnImport"> replace current queue</label>
        <div id="csvImportStatus" class="muted" style="margin-top:8px"></div>
      </div>
      <div class="card" style="margin:0">
        <h3>🖼 Photo folder for review</h3>
        <p class="muted">Recommended: choose the same Google Photos year folder as the CSV. TrollMap will match by filename and show large photos without localhost/mixed-content issues.</p>
        <button id="pickPhotoFolderBtn" class="primary small">📂 Select Photo Folder</button>
        <input id="catchPhotoFolderInput" type="file" webkitdirectory directory multiple class="hidden">
        <label style="display:flex;gap:6px;align-items:center;margin-top:8px"><input type="checkbox" id="filterPhotosByCsv" checked> only import photos listed in CSV/queue (recommended for root Takeout folders)</label>
        <div id="photoFolderStatus" class="muted" style="margin-top:8px">No folder selected.</div>
        <hr style="border:0;border-top:1px solid var(--line);margin:12px 0">
        <h3>🖥 Optional local helper</h3>
        <p class="muted">Only needed if you do not use folder picker. HTTPS GitHub Pages may block HTTP helper images.</p>
        <label>Helper URL</label>
        <input id="catchHelperUrl" value="${esc(localStorage.getItem('trollmapCatchHelperUrl') || DEFAULT_HELPER)}" style="width:100%">
        <div class="row" style="margin-top:8px"><button id="saveHelperUrlBtn" class="small">Save URL</button><button id="testHelperBtn" class="small">Test</button></div>
        <div id="helperStatus" class="muted"></div>
      </div>
    </div>`;
  const nightlyInput = body.querySelector('#nightlyPhotoInput');
  const nightlyBox = body.querySelector('#nightlyDropBox');
  nightlyBox.addEventListener('click', () => nightlyInput.click());
  nightlyBox.addEventListener('dragover', e => { e.preventDefault(); nightlyBox.classList.add('ok'); });
  nightlyBox.addEventListener('dragleave', () => nightlyBox.classList.remove('ok'));
  nightlyBox.addEventListener('drop', e => {
    e.preventDefault(); nightlyBox.classList.remove('ok');
    handleNightlyPhotoUpload([...e.dataTransfer.files].filter(f => f.type.startsWith('image/')), body);
  });
  nightlyInput.addEventListener('change', e => handleNightlyPhotoUpload([...e.target.files], body));
  const input = body.querySelector('#catchCsvInput');
  const box = body.querySelector('#csvDropBox');
  box.addEventListener('click', () => input.click());
  box.addEventListener('dragover', e => { e.preventDefault(); box.classList.add('ok'); });
  box.addEventListener('dragleave', () => box.classList.remove('ok'));
  box.addEventListener('drop', e => {
    e.preventDefault(); box.classList.remove('ok');
    importCsvFiles([...e.dataTransfer.files].filter(f => f.name.toLowerCase().endsWith('.csv')));
  });
  input.addEventListener('change', e => importCsvFiles([...e.target.files]));
  body.querySelector('#pickPhotoFolderBtn')?.addEventListener('click', () => body.querySelector('#catchPhotoFolderInput')?.click());
  body.querySelector('#catchPhotoFolderInput')?.addEventListener('change', e => indexPhotoFolder([...e.target.files], body));
  body.querySelector('#saveHelperUrlBtn')?.addEventListener('click', () => {
    localStorage.setItem('trollmapCatchHelperUrl', body.querySelector('#catchHelperUrl').value.trim() || DEFAULT_HELPER);
    body.querySelector('#helperStatus').textContent = 'Saved.';
  });
  body.querySelector('#testHelperBtn')?.addEventListener('click', testHelper);
}

function renderReview(body) {
  const queue = getQueue();
  if (!selectedQueueId && queue.length) selectedQueueId = queue.find(q => q.status === 'pending')?.id || queue[0].id;
  const selected = queue.find(q => q.id === selectedQueueId) || null;
  const counts = {
    total: queue.length,
    pending: queue.filter(q => q.status === 'pending').length,
    approved: queue.filter(q => q.status === 'approved' || q.status === 'imported').length,
    rejected: queue.filter(q => String(q.status).includes('reject')).length,
    board: queue.filter(q => q.verified?.onBoard || q.ai?.onBoard).length
  };
  body.innerHTML = `
    <div class="row">
      <button id="reviewPendingBtn" class="small">Pending ${counts.pending}</button>
      <button id="exportQueueBtn" class="small">⬇ Export Cleaned CSV</button>
      <button id="enrichQueueBtn" class="small">🌦 Check Missing History</button>
      <button id="approveAllPendingBtn" class="small primary">✅ Approve All Pending</button>
      <button id="clearImportedBtn" class="small">Clear imported/approved</button>
      <button id="clearQueueBtn" class="warn small">🗑 Clear Queue</button>
      <span class="muted">Total ${counts.total} · Board ${counts.board} · Approved ${counts.approved} · Rejected ${counts.rejected}</span>
    </div>
    <div id="queueEnrichStatus" class="muted" style="margin:4px 0 8px"></div>
    <div style="display:grid;grid-template-columns:320px minmax(500px,1fr);gap:12px;align-items:start">
      <div class="card" style="margin:0;max-height:72vh;overflow:auto;padding:8px" id="queueList"></div>
      <div class="card" style="margin:0" id="queueDetail"></div>
    </div>`;
  renderQueueList(body.querySelector('#queueList'), queue);
  renderQueueDetail(body.querySelector('#queueDetail'), selected);
  body.querySelector('#exportQueueBtn')?.addEventListener('click', exportQueueCsv);
  body.querySelector('#enrichQueueBtn')?.addEventListener('click', () => enrichMissingHistoricalData(body));
  body.querySelector('#reviewPendingBtn')?.addEventListener('click', () => { selectedQueueId = queue.find(q => q.status === 'pending')?.id || selectedQueueId; renderReview(body); });
  body.querySelector('#approveAllPendingBtn')?.addEventListener('click', async () => {
    const pending = getQueue().filter(q => q.status === 'pending');
    if (!pending.length) return;
    if (!confirm(`Approve all ${pending.length} pending catches to journal?`)) return;
    for (const q of pending) await approveQueueItem(q);
    await saveCatches(); await saveQueue();
    renderCatchSubtab();
  });
  body.querySelector('#clearImportedBtn')?.addEventListener('click', async () => {
    setQueue(getQueue().filter(q => !['approved', 'imported'].includes(q.status)));
    await saveQueue(); renderReview(body);
  });
  body.querySelector('#clearQueueBtn')?.addEventListener('click', async () => {
    const n = getQueue().length;
    if (!n) return;
    if (!confirm(`Clear ALL ${n} review queue item(s)? This does not delete confirmed journal catches or photos.`)) return;
    setQueue([]); selectedQueueId = null;
    await saveQueue(); renderReview(body);
  });
}

function renderQueueList(el, queue) {
  if (!queue.length) { el.innerHTML = '<p class="muted">No queue yet. Import a CSV first.</p>'; return; }
  el.innerHTML = queue.map(q => {
    const sp = q.verified?.species || q.ai?.inferredSpecies || q.ai?.species || 'Fish';
    const len = q.verified?.length || q.ai?.length || '';
    const active = q.id === selectedQueueId;
    const flag = q.reviewFlags?.includes('verify_board_length_from_photo') ? '📏' : q.verified?.hasFish ? '🐟' : '🚫';
    const statusColor = q.status === 'pending' ? 'var(--warn)' : q.status === 'imported' || q.status === 'approved' ? 'var(--accent2)' : 'var(--bad)';
    return `<div data-qid="${esc(q.id)}" style="cursor:pointer;padding:8px;border:1px solid ${active ? 'var(--accent)' : 'var(--line)'};border-radius:8px;margin-bottom:6px;background:${active ? 'rgba(0,229,255,.08)' : 'var(--panel2)'}">
      <div style="display:flex;justify-content:space-between;gap:8px"><b>${flag} ${esc(sp)}</b><span style="color:${statusColor};font-size:11px">${esc(q.status)}</span></div>
      <div class="muted">${esc(q.filename)}${len ? ` · ${esc(len)}"` : ''}</div>
      <div class="muted">${esc(q.date || '')} ${esc(displayTime(q.time))}</div>
    </div>`;
  }).join('');
  el.querySelectorAll('[data-qid]').forEach(row => row.addEventListener('click', () => { selectedQueueId = row.dataset.qid; renderCatchSubtab(); }));
}
function speciesOptions(current) {
  const all = SPECIES.includes(current) ? SPECIES : [current, ...SPECIES];
  return all.map(s => `<option value="${esc(s)}" ${s === current ? 'selected' : ''}>${esc(s || '— select —')}</option>`).join('');
}
function renderQueueDetail(el, q) {
  if (!q) { el.innerHTML = '<p class="muted">Select a queue item.</p>'; return; }
  const img = imageUrl(q);
  const lureImg = q.lurePhotoDataUrl || '';
  const flags = q.reviewFlags || [];
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
      <div><h3 style="margin:0 0 4px">${esc(q.filename)}</h3><div class="muted">${esc(q.datetime || '')} · ${esc(q.sourcePath || 'no source path')}</div></div>
      <div class="row"><button id="prevQueueBtn" class="small">←</button><button id="nextQueueBtn" class="small">→</button></div>
    </div>
    <div style="display:flex;gap:10px;align-items:flex-start;margin:10px 0">
      ${img ? `<div style="flex:1;background:#050b12;border:1px solid var(--line);border-radius:10px;padding:8px;text-align:center"><img id="reviewPhoto" src="${esc(img)}" style="max-width:100%;max-height:72vh;border-radius:8px;object-fit:contain" onerror="this.insertAdjacentHTML('afterend','<div class=&quot;warnbox&quot;>Image failed to load from selected folder.</div>');this.style.display='none';"></div>` : `<div class="warnbox" style="flex:1">No matching local photo selected. Go to Import CSV → Select Photo Folder for this year. Looking for: ${esc(q.filename || baseName(q.sourcePath) || 'unknown')}</div>`}
      ${lureImg ? `<div style="width:160px;flex-shrink:0;background:#050b12;border:1px solid var(--line);border-radius:10px;padding:8px;text-align:center">
        <div class="muted" style="font-size:11px;margin-bottom:4px">🎣 Lure photo</div>
        <img id="lurePhoto" src="${esc(lureImg)}" style="max-width:100%;max-height:200px;border-radius:6px;object-fit:contain;cursor:zoom-in">
        <button id="swapPhotosBtn" class="small" style="width:100%;margin-top:6px" title="If TrollMap guessed fish/lure backwards for this catch, swap them">🔄 Swap fish/lure</button>
      </div>` : ''}
    </div>
    <div class="grid" style="grid-template-columns:repeat(4,minmax(120px,1fr));gap:8px">
      <div><label>Verified species</label><select id="rvSpecies">${speciesOptions(q.verified?.species || '')}</select></div>
      <div><label>Verified length in</label><input id="rvLength" value="${esc(q.verified?.length || '')}" placeholder="look at photo"></div>
      <div><label>AI length</label><input value="${esc(q.ai?.length || '')}" readonly></div>
      <div><label>Confidence</label><input value="${esc(q.ai?.confidence || '')}" readonly></div>
      <div><label>Date</label><input id="rvDate" value="${esc(q.date || '')}"></div>
      <div><label>Time</label><input id="rvTime" value="${esc(q.time || '')}"></div>
      <div><label>Lake</label><input id="rvLake" value="${esc(q.lake || '')}"></div>
      <div><label>Depth ft</label><input id="rvDepth" value="${esc(q.depth || '')}"></div>
      <div><label>Latitude</label><input id="rvLat" value="${esc(q.lat || '')}"></div>
      <div><label>Longitude</label><input id="rvLon" value="${esc(q.lon || '')}"></div>
      <div><label>Has fish</label><select id="rvHasFish"><option value="true" ${q.verified?.hasFish ? 'selected' : ''}>Yes</option><option value="false" ${!q.verified?.hasFish ? 'selected' : ''}>No</option></select></div>
      <div><label>On board</label><select id="rvOnBoard"><option value="true" ${q.verified?.onBoard ? 'selected' : ''}>Yes</option><option value="false" ${!q.verified?.onBoard ? 'selected' : ''}>No</option></select></div>
      <div><label>Lure ${lureImg ? '' : '(no paired photo — type freely)'}</label>${lureOptions(q.lure || '')}</div>
    </div>
    <div style="margin-top:8px"><label>Notes</label><textarea id="rvNotes" rows="4">${esc(q.ai?.notes || '')}</textarea></div>
    <div class="muted" style="margin-top:6px">AI species: ${esc(q.ai?.species || '')}${q.ai?.inferredSpecies && q.ai.inferredSpecies !== q.ai.species ? ` → ${esc(q.ai.inferredSpecies)}` : ''} · Model: ${esc(q.ai?.model || '')} · Flags: ${esc(flags.join(', ') || 'none')}</div>
    ${q.weather ? `<div class="okbox" style="font-size:12px">🌦 ${q.weather.tempF ?? '?'}°F · Wind ${q.weather.windMph ?? '?'}mph · ${q.weather.cloudPct ?? '?'}% cloud · ${q.weather.pressureHpa ?? '?'} hPa · ${esc(q.weather.moonPhase || '')}</div>` : `<div class="warnbox" style="font-size:12px">Historical weather/moon not loaded yet. Use “Check Missing History”.</div>`}
    <div class="row" style="margin-top:10px">
      <button id="saveQueueEditsBtn" class="small">💾 Save edits</button>
      <button id="approveCatchBtn" class="primary small">✅ Approve to Journal</button>
      <button id="rejectCatchBtn" class="warn small">🚫 Reject</button>
      <button id="markPendingBtn" class="small">↩ Pending</button>
    </div>`;
  el.querySelector('#saveQueueEditsBtn')?.addEventListener('click', async () => { applyDetailEdits(q); await saveQueue(); renderCatchSubtab(); });
  setTimeout(attachPhotoZoom, 100);
  el.querySelector('#lurePhoto')?.addEventListener('click', () => zoomPhoto(lureImg));
  el.querySelector('#swapPhotosBtn')?.addEventListener('click', async () => {
    // Swap: the "fish" photo becomes the lure reference, and vice versa.
    // AI results/species stay attached to whichever slot is now the fish
    // photo is ambiguous after a swap (we never re-ran AI on the other
    // photo), so clear AI fields and flag for manual re-entry rather than
    // showing stale species/length that may not match the new fish photo.
    const oldFish = q.photoDataUrl, oldFishFilename = q.filename;
    q.photoDataUrl = q.lurePhotoDataUrl;
    q.filename = q.lureFilename || q.filename;
    q.lurePhotoDataUrl = oldFish;
    q.lureFilename = oldFishFilename;
    q.ai = { species: '', length: '', confidence: '', notes: 'Swapped fish/lure — AI was run on the other photo, re-verify species/length manually.', model: '' };
    if (!q.reviewFlags) q.reviewFlags = [];
    if (!q.reviewFlags.includes('photos_swapped')) q.reviewFlags.push('photos_swapped');
    await saveQueue();
    renderCatchSubtab();
  });
  el.querySelector('#approveCatchBtn')?.addEventListener('click', async () => { applyDetailEdits(q); await approveQueueItem(q); moveNext(); renderCatchSubtab(); });
  el.querySelector('#rejectCatchBtn')?.addEventListener('click', async () => { q.status = 'rejected'; q.updatedAt = new Date().toISOString(); await saveQueue(); moveNext(); renderCatchSubtab(); });
  el.querySelector('#markPendingBtn')?.addEventListener('click', async () => { q.status = 'pending'; q.updatedAt = new Date().toISOString(); await saveQueue(); renderCatchSubtab(); });
  el.querySelector('#prevQueueBtn')?.addEventListener('click', () => { moveRelative(-1); renderCatchSubtab(); });
  el.querySelector('#nextQueueBtn')?.addEventListener('click', () => { moveRelative(1); renderCatchSubtab(); });
}
function lureOptions(current) {
  // Free-text input backed by a datalist so any lure preset can be picked
  // quickly, but a lure that isn't in the catalog can still be typed.
  const options = LURE_PRESETS.filter(l => !l.startsWith('—')).map(l => `<option value="${esc(l)}">`).join('');
  return `<input id="rvLure" list="rvLureList" value="${esc(current)}" placeholder="type or pick lure"><datalist id="rvLureList">${options}</datalist>`;
}
function applyDetailEdits(q) {
  q.verified = q.verified || {};
  q.verified.species = document.getElementById('rvSpecies')?.value || '';
  q.verified.length = document.getElementById('rvLength')?.value || '';
  q.verified.lengthVerified = !!q.verified.length && !!q.verified.onBoard;
  q.verified.hasFish = document.getElementById('rvHasFish')?.value === 'true';
  q.verified.onBoard = document.getElementById('rvOnBoard')?.value === 'true';
  q.date = document.getElementById('rvDate')?.value || '';
  q.time = document.getElementById('rvTime')?.value || '';
  q.lake = document.getElementById('rvLake')?.value || '';
  q.depth = document.getElementById('rvDepth')?.value || '';
  q.lat = document.getElementById('rvLat')?.value || '';
  q.lon = document.getElementById('rvLon')?.value || '';
  q.lure = document.getElementById('rvLure')?.value || '';
  q.ai.notes = document.getElementById('rvNotes')?.value || '';
  q.verified.reviewed = true;
  q.updatedAt = new Date().toISOString();
}
function queueIndex() { return Math.max(0, getQueue().findIndex(q => q.id === selectedQueueId)); }
function moveRelative(delta) {
  const q = getQueue(); if (!q.length) return;
  const ix = queueIndex(); selectedQueueId = q[Math.max(0, Math.min(q.length - 1, ix + delta))]?.id || selectedQueueId;
}
function moveNext() {
  const q = getQueue();
  const next = q.find(x => x.status === 'pending' && x.id !== selectedQueueId);
  if (next) selectedQueueId = next.id; else moveRelative(1);
}

async function approveQueueItem(q) {
  if (!q.verified?.hasFish) { q.status = 'rejected'; await saveQueue(); return; }
  const catches = getCatches();
  const sourceFile = q.filename;
  const existingIx = catches.findIndex(c => c.sourceFile === sourceFile && sourceFile);
  const entry = {
    species: q.verified.species || q.ai?.inferredSpecies || q.ai?.species || '',
    length: q.verified.length || q.ai?.length || '',
    depth: q.depth || '',
    // FIX (2026-07-03): this was hardcoded to '' unconditionally, silently
    // discarding any lure tag on every single approval — the root cause of
    // the lure field always being blank on approved catches, going back to
    // whenever this line was first written.
    lure: q.lure || '', lead: '',
    time: displayTime(q.time),
    date: q.date || '',
    lake: q.lake || '',
    lat: q.lat || '', lon: q.lon || '',
    notes: q.ai?.notes || '',
    weather: q.weather || null,
    structure: q.structure || null,
    sourceFile,
    sourcePath: q.sourcePath || '',
    importedFrom: q.importedFrom || 'review-queue',
    verification: {
      reviewed: true,
      species: q.verified.species ? 'human-reviewed' : 'ai',
      length: q.verified.length ? 'human-visual' : 'ai-unverified',
      onBoard: q.verified.onBoard,
      sourceModel: q.ai?.model || '',
      approvedAt: new Date().toISOString(),
      // v2 extended
      length_source: q.ai?.length_source || '',
      board_detected: q.ai?.board_detected || false,
      data_quality: q.ai?.data_quality || null,
    },
    data_generation: q.importedFrom === 'nightly_upload' ? 'gen2_instrumented' : 'gen1_historical',
    trollmap_tags: q.ai?.trollmap_tags || [],
  };
  if (existingIx >= 0) catches[existingIx] = entry; else catches.unshift(entry);
  q.status = 'imported'; q.updatedAt = new Date().toISOString();
  await saveCatches(); await saveQueue();
}


async function enrichMissingHistoricalData(body = document.getElementById('catchCenterBody')) {
  const status = body?.querySelector('#queueEnrichStatus') || document.getElementById('queueEnrichStatus');
  const queue = getQueue();
  if (!queue.length) { if (status) status.textContent = 'No queue items to check.'; return; }
  // Make sure the worker-backed lake index has resolved at least once before
  // running lake lookups on a batch, so early items in the batch don't get
  // pushed into the LAKE_DB fallback just because the fetch hadn't finished.
  try { await loadAccessIndex(); } catch (_) {}
  let depthUpdated = 0, weatherUpdated = 0, failed = 0;
  const targets = queue.filter(q => q.status !== 'rejected' && q.status !== 'rejected_candidate');
  for (let i = 0; i < targets.length; i++) {
    const item = targets[i];
    if (status) status.textContent = `Checking historical data ${i + 1}/${targets.length}: ${item.filename}`;
    const beforeDepth = item.depth;
    enrichItemFromGps(item);
    if (!beforeDepth && item.depth) depthUpdated++;
    if (!item.weather && item.lat && item.lon && (item.datetime || item.date)) {
      try {
        item.weather = await fetchHistoricalWeatherForItem(item);
        if (item.weather) {
          weatherUpdated++;
          if (!item.reviewFlags.includes('weather_from_archive')) item.reviewFlags.push('weather_from_archive');
        }
        // avoid hammering Open-Meteo
        await new Promise(r => setTimeout(r, 250));
      } catch (e) {
        failed++;
        if (!item.reviewFlags.includes('weather_lookup_failed')) item.reviewFlags.push('weather_lookup_failed');
      }
    } else if (!item.weather && (item.datetime || item.date)) {
      if (!item.reviewFlags.includes('weather_missing_gps')) item.reviewFlags.push('weather_missing_gps');
    }
    item.updatedAt = new Date().toISOString();
  }
  await saveQueue();
  if (status) {
    status.textContent = `✓ Historical check complete: depth filled ${depthUpdated}, weather/moon filled ${weatherUpdated}${failed ? `, weather failures ${failed}` : ''}.`;
    status.style.color = 'var(--accent2)';
  }
  renderCatchSubtab();
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (ch === '"') {
      if (inQuotes && next === '"') { field += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) { row.push(field); field = ''; }
    else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && next === '\n') i++;
      row.push(field); field = '';
      if (row.some(x => String(x).trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field); if (row.some(x => String(x).trim() !== '')) rows.push(row);
  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim().replace(/^\uFEFF/, ''));
  return rows.slice(1).map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}
async function importCsvFiles(files) {
  const status = document.getElementById('csvImportStatus');
  const includeRejected = document.getElementById('importRejectedRows')?.checked;
  const boardOnly = document.getElementById('boardOnlyImport')?.checked !== false; // default true
  const replace = document.getElementById('replaceQueueOnImport')?.checked;
  if (replace) setQueue([]);
  // Same reasoning as enrichMissingHistoricalData: make sure the worker-backed
  // lake index has resolved at least once before running lookups on rows
  // that are about to be enriched from GPS.
  try { await loadAccessIndex(); } catch (_) {}
  let added = 0, skipped = 0, skippedHandheld = 0;
  let autoApproved = 0;
  for (const file of files) {
    const text = await file.text();
    const rows = parseCsv(text);
    for (const row of rows) {
      const item = enrichItemFromGps(normalizeCsvRow(row, file.name));
      // Auto-approve rows already marked as imported in the CSV — skip review queue
      if (row.review_status === 'imported') {
        if (!getCatches().some(c => c.sourceFile === item.filename && item.filename)) {
          item.status = 'imported';
          item.verified.reviewed = true;
          await approveQueueItem(item);
          autoApproved++;
        } else { skipped++; }
        continue;
      }
      if (!includeRejected && !item.verified.hasFish) { skipped++; continue; }
      if (boardOnly && !item.verified.onBoard) { skippedHandheld++; continue; }
      if (getQueue().some(q => q.id === item.id)) { skipped++; continue; }
      getQueue().push(item); added++;
    }
  }
  await saveQueue();
  if (status) status.textContent = `${autoApproved ? `Auto-approved ${autoApproved} to journal. ` : ''}${added ? `Added ${added} to review queue. ` : ''}${skippedHandheld ? `Skipped ${skippedHandheld} handheld. ` : ''}${skipped ? `Skipped ${skipped} duplicate. ` : ''}`.trim();
  currentSubtab = 'review'; selectedQueueId = getQueue().find(q => q.status === 'pending')?.id || getQueue()[0]?.id || null;
  setTimeout(renderCatchCenter, 700);
}
function indexPhotoFolder(files, body) {
  let count = 0;
  let skippedFilter = 0;
  const filterActive = document.getElementById('filterPhotosByCsv')?.checked !== false;
  const q = getQueue();
  const c = getCatches();
  const allowedKeys = new Set();
  if (filterActive && (q.length > 0 || c.length > 0)) {
    [...q, ...c].forEach(item => {
      if (item.filename) allowedKeys.add(String(item.filename).trim().toLowerCase());
      if (item.sourcePath) allowedKeys.add(String(baseName(item.sourcePath)).trim().toLowerCase());
    });
  }

  const imageRe = /\.(jpe?g|png|webp|gif|bmp)$/i;
  for (const f of files) {
    if (!imageRe.test(f.name)) continue;
    const key = f.name.toLowerCase();
    if (allowedKeys.size > 0 && !allowedKeys.has(key)) {
      skippedFilter++;
      continue;
    }
    if (localPhotoUrls.has(key)) URL.revokeObjectURL(localPhotoUrls.get(key));
    localPhotoFiles.set(key, f);
    localPhotoUrls.set(key, URL.createObjectURL(f));
    count++;
  }
  const status = body?.querySelector('#photoFolderStatus') || document.getElementById('photoFolderStatus');
  const matched = q.filter(item => {
    const keys = [item.filename, baseName(item.sourcePath)].map(x => String(x || '').toLowerCase()).filter(Boolean);
    return keys.some(k => localPhotoUrls.has(k));
  }).length;
  if (status) {
    const filterMsg = skippedFilter ? ` (filtered out ${skippedFilter.toLocaleString()} non-CSV photos)` : '';
    status.textContent = `Indexed ${count.toLocaleString()} image(s)${filterMsg}. Matched ${matched}/${q.length} current queue item(s).`;
    status.style.color = matched || !q.length ? 'var(--accent2)' : 'var(--warn)';
  }
  renderCatchSubtab();
}

async function testHelper() {
  const out = document.getElementById('helperStatus');
  const url = helperBase().replace(/\/$/, '') + '/health';
  try {
    const r = await fetch(url); const j = await r.json();
    out.textContent = j.ok ? `✓ Helper online (${j.name || 'TrollMap helper'})` : 'Helper responded but not OK';
    out.style.color = j.ok ? 'var(--accent2)' : 'var(--warn)';
  } catch (e) { out.textContent = `Not reachable: ${e.message}`; out.style.color = 'var(--bad)'; }
}

function csvEscape(v) {
  v = String(v ?? '');
  return /[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}
function downloadCsv(name, rows) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const text = [headers.join(','), ...rows.map(r => headers.map(h => csvEscape(r[h])).join(','))].join('\n');
  const blob = new Blob([text], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function exportQueueCsv() {
  const rows = getQueue().map(q => ({
    review_status: q.status, review_flags: (q.reviewFlags || []).join('|'), filename: q.filename,
    datetime: q.datetime, date: q.date, time: q.time, lat: q.lat, lon: q.lon, lake: q.lake, depth: q.depth,
    has_fish: q.verified?.hasFish, on_bump_board: q.verified?.onBoard,
    species: q.verified?.species || q.ai?.inferredSpecies || q.ai?.species,
    verified_length_inches: q.verified?.length || '', ai_length_inches: q.ai?.length || '',
    length_verified: !!q.verified?.length,
    confidence: q.ai?.confidence || '', source_model: q.ai?.model || '', notes: q.ai?.notes || '',
    tempF: q.weather?.tempF ?? '', windMph: q.weather?.windMph ?? '', windDir: q.weather?.windDir ?? '', cloudPct: q.weather?.cloudPct ?? '', pressureHpa: q.weather?.pressureHpa ?? '', moonPhase: q.weather?.moonPhase || '',
    sha256: q.sha256 || '', source_path: q.sourcePath || '', imported_from: q.importedFrom || ''
  }));
  downloadCsv('trollmap_catch_review_queue_cleaned.csv', rows);
}
function exportJournalCsv() {
  const rows = getCatches().map(c => ({
    species: c.species, length: c.length, date: c.date, time: c.time, lake: c.lake, depth: c.depth,
    lat: c.lat, lon: c.lon, lure: c.lure, lead: c.lead, notes: c.notes,
    tempF: c.weather?.tempF ?? '', windMph: c.weather?.windMph ?? '', windDir: c.weather?.windDir ?? '', cloudPct: c.weather?.cloudPct ?? '', pressureHpa: c.weather?.pressureHpa ?? '', moonPhase: c.weather?.moonPhase || '',
    sourceFile: c.sourceFile, sourcePath: c.sourcePath, importedFrom: c.importedFrom,
    lengthVerification: c.verification?.length || '', speciesVerification: c.verification?.species || ''
  }));
  downloadCsv('trollmap_catch_journal.csv', rows);
}

function renderAnalytics(body) {
  const catches = getCatches();
  const queue = getQueue();
  const bySpecies = {};
  catches.forEach(c => { const s = c.species || 'Unknown'; bySpecies[s] = (bySpecies[s] || 0) + 1; });
  body.innerHTML = `
    <div class="grid" style="grid-template-columns:repeat(4,1fr);gap:8px">
      <div class="card"><div class="muted">Confirmed</div><div class="big">${catches.length}</div></div>
      <div class="card"><div class="muted">Queue</div><div class="big">${queue.length}</div></div>
      <div class="card"><div class="muted">Pending</div><div class="big">${queue.filter(q => q.status === 'pending').length}</div></div>
      <div class="card"><div class="muted">Board queue</div><div class="big">${queue.filter(q => q.verified?.onBoard || q.ai?.onBoard).length}</div></div>
    </div>
    <div class="card"><h3>Species</h3>${Object.entries(bySpecies).sort((a,b)=>b[1]-a[1]).map(([s,n]) => `<div>${esc(s)}: <b>${n}</b></div>`).join('') || '<p class="muted">No catches yet.</p>'}</div>`;
}
async function addManualCatch() {
  const species = prompt('Species?'); if (species === null) return;
  const length = prompt('Length inches?') || '';
  getCatches().unshift({ species, length, date: new Date().toISOString().slice(0,10), time: new Date().toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit'}), notes: '', importedFrom: 'manual' });
  await saveCatches(); renderCatchSubtab();
}

// Legacy buttons may exist before render override; wire defensively.
// ── Nightly Catch Upload — live multi-photo intake with fish/lure pairing ────
// Convention: shoot the fish-on-board photo FIRST, then the lure photo
// SECOND, within PAIR_WINDOW_S of each other. Photos are grouped by EXIF
// timestamp; earlier photo in a pair = fish (gets sent to AI), later = lure
// (never sent to AI — user tags it manually in review, since that's free
// and just as fast as trying to get AI to guess correctly). A cluster of
// exactly 2 is treated as a pair; anything else (1, or 3+) is treated as
// individual unpaired fish photos rather than guessing at a grouping.
const PAIR_WINDOW_S = 90;

// Load exif-js ourselves — don't depend on catch_importer.js having already
// injected it, since module load order isn't guaranteed.
if (!document.querySelector('script[src*="exif-js"]')) {
  const exifScript = document.createElement('script');
  exifScript.src = 'https://cdn.jsdelivr.net/npm/exif-js';
  document.head.appendChild(exifScript);
}

function ensureExifLoaded() {
  return new Promise((resolve) => {
    if (window.EXIF) return resolve();
    const check = setInterval(() => {
      if (window.EXIF) { clearInterval(check); resolve(); }
    }, 200);
    setTimeout(() => { clearInterval(check); resolve(); }, 5000); // give up after 5s, proceed without EXIF
  });
}

function extractExif(file) {
  return new Promise((resolve) => {
    if (!window.EXIF) return resolve({ file, timestamp: null, isoDatetime: null, lat: null, lon: null });
    window.EXIF.getData(file, function () {
      let lat = null, lon = null;
      const rawLat = window.EXIF.getTag(this, 'GPSLatitude');
      const rawLon = window.EXIF.getTag(this, 'GPSLongitude');
      const latRef = window.EXIF.getTag(this, 'GPSLatitudeRef');
      const lonRef = window.EXIF.getTag(this, 'GPSLongitudeRef');
      if (rawLat && rawLon) {
        lat = rawLat[0] + rawLat[1] / 60 + rawLat[2] / 3600;
        lon = rawLon[0] + rawLon[1] / 60 + rawLon[2] / 3600;
        if (latRef === 'S') lat = -lat;
        if (lonRef === 'W') lon = -lon;
      }
      const dateStr = window.EXIF.getTag(this, 'DateTimeOriginal'); // "YYYY:MM:DD HH:MM:SS"
      let isoDatetime = null, timestamp = null;
      if (dateStr) {
        const parts = dateStr.split(' ');
        if (parts.length === 2) {
          isoDatetime = `${parts[0].replace(/:/g, '-')}T${parts[1]}`;
          timestamp = new Date(isoDatetime).getTime() / 1000;
        }
      }
      if (timestamp == null) timestamp = file.lastModified / 1000; // fallback: file mtime
      resolve({ file, timestamp, isoDatetime, lat, lon });
    });
  });
}

// Group photos into clusters by timestamp proximity. Returns array of
// arrays (each inner array is a cluster of photos taken within
// PAIR_WINDOW_S of the previous one).
function clusterByTimestamp(items) {
  const sorted = [...items].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const clusters = [];
  for (const item of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && item.timestamp != null && last[last.length - 1].timestamp != null
        && (item.timestamp - last[last.length - 1].timestamp) <= PAIR_WINDOW_S) {
      last.push(item);
    } else {
      clusters.push([item]);
    }
  }
  return clusters;
}

function fileToDataUrl(file, maxPx = 1024) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(''); };
    img.src = url;
  });
}

async function handleNightlyPhotoUpload(files, body) {
  const status = body?.querySelector('#nightlyUploadStatus') || document.getElementById('nightlyUploadStatus');
  if (!files.length) return;
  if (status) status.textContent = `Reading ${files.length} photo(s)...`;
  await ensureExifLoaded();

  const withExif = await Promise.all(files.map(extractExif));
  const clusters = clusterByTimestamp(withExif);

  let created = 0, aiCalled = 0, aiFailed = 0;
  const queue = getQueue();

  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    if (status) status.textContent = `Processing catch ${i + 1} of ${clusters.length}...`;

    // Exactly 2 in a cluster = fish+lure pair (earlier = fish, later = lure).
    // Anything else = treat each photo as its own unpaired fish photo rather
    // than guessing at a grouping.
    const isPair = cluster.length === 2;
    const fishItems = isPair ? [cluster[0]] : cluster;
    const lureItem = isPair ? cluster[1] : null;

    for (const fishItem of fishItems) {
      const [photoDataUrl, lureDataUrl] = await Promise.all([
        fileToDataUrl(fishItem.file, 1024),
        lureItem ? fileToDataUrl(lureItem.file, 640) : Promise.resolve(''),
      ]);

      let ai = null;
      try {
        ai = await identifyFishWithGemini(fishItem.file, {
          lake: document.getElementById('planLake')?.value || '',
          date: dt.split('T')[0],
          lat: fishItem.lat,
          lon: fishItem.lon,
        });
        aiCalled++;
      } catch (e) {
        aiFailed++;
        console.warn('[catch-journal] Nightly AI ID failed:', e.message);
      }

      const dt = fishItem.isoDatetime || new Date(fishItem.timestamp * 1000).toISOString();
      const { date, time } = splitDateTime(dt.replace('T', ' '));

      const item = {
        id: `nightly_${fishItem.timestamp}_${Math.random().toString(36).slice(2, 8)}`,
        filename: fishItem.file.name,
        sourcePath: '',
        datetime: dt, date, time,
        lat: fishItem.lat ?? '', lon: fishItem.lon ?? '',
        lake: '', depth: '',
        photoDataUrl,
        lurePhotoDataUrl: lureDataUrl,
        lureFilename: lureItem?.file?.name || '',
        lure: '', // filled in manually during review — never sent to AI
        // NOTE: /identify-catch's actual response shape is
        // {species, lengthInches, confidence, notes} — no has_fish or
        // on_bump_board fields exist. This endpoint's species classification
        // is also hard-restricted to Striped Bass/Largemouth/Smallmouth/
        // Crappie/Catfish/White Bass-Hybrid only; other species (bowfin,
        // bream, gar, pickerel, redfish, trout, flounder, shad) will come
        // back misclassified into one of those 6 until that prompt is
        // widened — always human-review species on those catches.
        ai: ai ? {
          species: ai.species || '', length: ai.lengthInches ?? '', confidence: ai.confidence || '',
          notes: ai.notes || '', model: 'Gemini 2.5-flash v13 (SC trolling taxonomy)',
          inferredSpecies: ai.species || '',
          // v2 extended fields — stored on the item, displayed in review, ignored by old code safely
          has_fish: ai.has_fish ?? true,
          on_bump_board: ai.on_bump_board ?? true,
          length_source: ai.length_source || '',
          board_detected: !!ai.board_detected,
          board_type: ai.board_type || '',
          measurement_confidence: ai.measurement_confidence || ai.confidence || '',
          species_confidence: ai.species_confidence ?? null,
          alt_species: ai.alt_species || [],
          id_features: ai.id_features || [],
          data_quality: ai.data_quality || null,
          trollmap_tags: ai.trollmap_tags || [],
        } : { species: '', length: '', confidence: '', notes: 'AI call failed — enter manually.', model: '' },
        verified: {
          species: ai?.species || '', length: ai?.lengthInches ?? '',
          // has_fish/on_bump_board don't exist in this endpoint's response —
          // default true, since a nightly-uploaded fish photo is a catch by
          // definition of this workflow; correct manually if wrong.
          hasFish: true, onBoard: true,
          reviewed: false,
        },
        weather: null,
        reviewFlags: ai === null ? ['ai_call_failed'] : [],
        status: 'pending',
        importedFrom: 'nightly_upload',
        updatedAt: new Date().toISOString(),
      };
      queue.unshift(item);
      created++;
    }
  }

  setQueue(queue);
  await saveQueue();
  if (status) {
    status.textContent = `✓ Added ${created} catch(es) to review queue. AI ID ran on ${aiCalled}${aiFailed ? ` (${aiFailed} failed — check flagged items)` : ''}. Review below.`;
  }
  renderCatchSubtab();
}

// ── Gemini fish identification (for single photo drop) ───────────────────────
async function resizeForGemini(imgFile, maxPx = 1344) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(imgFile);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob(blob => resolve(blob || imgFile), 'image/jpeg', 0.88);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(imgFile); };
    img.src = url;
  });
}

// ── helper: blob → base64 ─────────────────────────────────────────────────────
async function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

// Context-aware Gemini ID — sends lake/date/GPS/species_hint to /identify-catch-v2.
// Falls back to the legacy binary endpoint if v2 fails.
async function identifyFishWithGemini(imgFile, context = {}) {
  const WORKER_URL = (typeof CF_WORKER_URL !== 'undefined' ? CF_WORKER_URL : (window.CF_WORKER_URL || 'https://trollmap-worker.colonal1981.workers.dev'));
  try {
    const resized = await resizeForGemini(imgFile, 1344);
    const b64 = await blobToBase64(resized);

    const lakeEl = document.getElementById('planLake');
    const ctx = {
      lake: context.lake || lakeEl?.value || '',
      date: context.date || new Date().toISOString().slice(0, 10),
      lat: context.lat ?? null,
      lon: context.lon ?? null,
      species_hint: context.species_hint || SPECIES.filter(s => s && s !== 'Not Fish'),
      trolling_session: true,
      assume_board: true, // nightly upload workflow is always board photos
      ...context
    };

    // Try v2 JSON endpoint first
    const resp = await fetch(`${WORKER_URL}/identify-catch-v2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_base64: b64, mime_type: 'image/jpeg', context: ctx })
    });

    if (resp.ok) {
      const data = await resp.json();
      if (data.success && data.analysis) {
        const a = data.analysis;
        // Ensure back-compat fields exist
        a.species = a.species || 'Other Fish';
        a.lengthInches = a.lengthInches ?? a.length_inches ?? null;
        a.confidence = a.confidence || (a.species_confidence >= 0.85 ? 'high' : a.species_confidence >= 0.6 ? 'medium' : 'low');
        return a;
      }
    }

    // Fallback → legacy binary endpoint
    const resp2 = await fetch(`${WORKER_URL}/identify-catch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'image/jpeg', 'X-Image-Type': 'image/jpeg',
        'X-Lake': ctx.lake || '', 'X-Date': ctx.date || '',
        'X-Lat': ctx.lat != null ? String(ctx.lat) : '',
        'X-Lon': ctx.lon != null ? String(ctx.lon) : '',
        'X-Species-Hint': (ctx.species_hint || []).join(','),
        'X-Assume-Board': 'true'
      },
      body: resized
    });
    if (!resp2.ok) throw new Error(`Worker ${resp2.status}`);
    const data2 = await resp2.json();
    if (!data2.success) throw new Error(data2.error || 'Unknown');
    return data2.analysis;

  } catch (e) {
    console.warn('[catch-journal] Gemini ID failed:', e.message);
    return null;
  }
}

// ── Photo zoom overlay ────────────────────────────────────────────────────────
function initPhotoZoom() {
  if (document.getElementById('photoZoomOverlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'photoZoomOverlay';
  overlay.style.cssText = 'display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.92);cursor:zoom-out;align-items:center;justify-content:center;';
  overlay.innerHTML = '<img id="photoZoomImg" style="max-width:96vw;max-height:96vh;object-fit:contain;border-radius:8px;">';
  overlay.addEventListener('click', () => { overlay.style.display = 'none'; });
  document.body.appendChild(overlay);
}

function zoomPhoto(src) {
  initPhotoZoom();
  const overlay = document.getElementById('photoZoomOverlay');
  const img = document.getElementById('photoZoomImg');
  img.src = src;
  overlay.style.display = 'flex';
}

// Add zoom to review photo after render
function attachPhotoZoom() {
  const photo = document.getElementById('reviewPhoto');
  if (photo && !photo._zoomWired) {
    photo._zoomWired = true;
    photo.style.cursor = 'zoom-in';
    photo.title = 'Click to zoom';
    photo.addEventListener('click', () => zoomPhoto(photo.src));
  }
}

function wireButtons() {
  renderCatchCenter();
  // Attach zoom after render
  setTimeout(attachPhotoZoom, 500);
}

wireButtons();
