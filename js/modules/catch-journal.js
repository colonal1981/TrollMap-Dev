/**
 * catch-journal.js — Catch Journal with Zero-Friction Photo Import
 *
 * Stores structured catch data only — NO photos in IndexedDB.
 * Photos are used transiently to extract EXIF metadata, then discarded.
 *
 * Per-catch record schema:
 *   species, length, time, depth, lure, lead, notes,
 *   date, lake, lat, lon,
 *   weather: { tempF, pressureHpa, cloudPct, windMph, moonPhase }
 *   structure: { depthBand, nearestContour }
 *
 * Photo import pipeline (drag-drop or file picker):
 *   1. Read EXIF client-side (native browser API — no CDN library)
 *   2. GPS coords → contour spatial lookup → lake + depth band
 *   3. Timestamp + coords → Open-Meteo historical API → weather
 *   4. Timestamp → moon phase (pure math)
 *   5. Pre-fill catch form, discard photo blob
 */

import { state }  from '../core/state.js';
import { esc }    from '../utils/escape.js';

// ── State helpers ─────────────────────────────────────────────────────────────
function getCatches() { return state.CATCHES; }
function setCatches(arr) { state.CATCHES = arr; }

// Pending data from photo import — cleared after save
const pending = { lat: null, lon: null, weather: null, structure: null, photoThumb: null };

// ── IDB persistence ───────────────────────────────────────────────────────────
async function saveCatches() {
  if (!window.DB?.db) return;
  try { await window.DB.put('journal', { name: 'catches', data: getCatches() }); } catch (_) {}
}

export async function loadCatches() {
  if (!window.DB?.db) return;
  try {
    const r = await window.DB.get('journal', 'catches');
    console.log('[IDB] catches found:', r ? (r.data?.length || 0) : 0);
    if (r) setCatches(r.data || []);
    renderCatchLog();
  } catch (_) {}
}

// ── Catch log renderer ────────────────────────────────────────────────────────
export function renderCatchLog() {
  const host = document.getElementById('catchLog');
  if (!host) return;
  const catches = getCatches();
  if (!catches.length) {
    host.innerHTML = '<p class="muted" style="font-size:12px">No catches logged yet.</p>';
    return;
  }
  host.innerHTML = catches.map((c, i) => `
    <div style="display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid var(--line);font-size:12px">
      <span style="font-size:16px">🐟</span>
      <div style="flex:1;min-width:0">
        <div><b>${esc(c.species || 'Fish')}</b>${c.length ? ' · ' + c.length + '"' : ''} · ${esc(c.time || '')} · ${esc(c.lake || '')}</div>
        <div style="color:var(--muted);font-size:11px;margin-top:2px">
          ${c.depth ? 'Depth: ' + c.depth + 'ft' : ''}
          ${c.lure  ? ' · ' + esc(c.lure) : ''}
          ${c.lead  ? ' · Lead: ' + c.lead + 'ft' : ''}
        </div>
        ${c.weather ? `<div style="color:var(--muted);font-size:11px">${c.weather.tempF}°F · ${c.weather.pressureHpa} hPa · Wind ${c.weather.windMph}mph · ${c.weather.cloudPct}% cloud · ${esc(c.weather.moonPhase || '')}</div>` : ''}
        ${c.structure?.depthBand ? `<div style="color:var(--accent2);font-size:11px">📍 ${esc(c.structure.depthBand)}</div>` : ''}
        ${c.notes ? `<div style="color:var(--muted);font-size:11px;margin-top:2px">${esc(c.notes)}</div>` : ''}
      </div>
      <button data-ci="${i}" style="padding:1px 6px;font-size:11px;flex-shrink:0">🗑</button>
    </div>
  `).join('');

  host.querySelectorAll('[data-ci]').forEach(el => {
    el.addEventListener('click', async e => {
      const catches = getCatches();
      catches.splice(+e.currentTarget.dataset.ci, 1);
      renderCatchLog();
      await saveCatches();
    });
  });
}

// ── Save new catch ─────────────────────────────────────────────────────────────
async function saveNewCatch() {
  const catches = getCatches();
  catches.unshift({
    species:   document.getElementById('cSpecies')?.value || '',
    length:    document.getElementById('cLength')?.value  || '',
    depth:     document.getElementById('cDepth')?.value   || '',
    lure:      document.getElementById('cLure')?.value    || '',
    lead:      document.getElementById('cLead')?.value    || '',
    time:      document.getElementById('cTime')?.value    || '',
    notes:     document.getElementById('cNotes')?.value   || '',
    date:      new Date().toISOString().slice(0, 10),
    lake:      document.getElementById('planLake')?.value || '',
    lat:       pending.lat || '',
    lon:       pending.lon || '',
    weather:   pending.weather  || null,
    structure: pending.structure || null,
  });

  // Clear pending — photo blob is discarded here, nothing stored
  pending.lat = null;
  pending.lon = null;
  pending.weather = null;
  pending.structure = null;
  pending.photoThumb = null;

  // Clear thumbnail preview
  const thumb = document.getElementById('cPhotoThumb');
  if (thumb) { thumb.src = ''; thumb.style.display = 'none'; }
  const status = document.getElementById('cImportStatus');
  if (status) status.textContent = '';

  renderCatchLog();
  await saveCatches();

  // Reset form fields
  ['cSpecies','cLength','cDepth','cLure','cLead','cNotes'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const photoInput = document.getElementById('cPhoto');
  if (photoInput) photoInput.value = '';
  document.getElementById('catchForm').style.display = 'none';
}

// ── EXIF extraction (native browser — no CDN library) ─────────────────────────
// Parses the bare minimum of EXIF tags from a JPEG ArrayBuffer.
// Handles GPS (IFD GPS), DateTimeOriginal (IFD EXIF), and basic offsets.
function parseEXIF(buffer) {
  const view = new DataView(buffer);
  if (view.getUint16(0) !== 0xFFD8) return null; // not JPEG

  let offset = 2;
  while (offset < view.byteLength - 2) {
    const marker = view.getUint16(offset);
    offset += 2;
    if (marker === 0xFFE1) break; // APP1 — EXIF
    if ((marker & 0xFF00) !== 0xFF00) break;
    offset += view.getUint16(offset); // skip this segment
  }
  if (offset >= view.byteLength) return null;

  const segLen = view.getUint16(offset);
  const app1 = new DataView(buffer, offset + 2, segLen - 2);
  if (app1.getUint32(0) !== 0x45786966) return null; // 'Exif'

  const tiffOffset = 6;
  const little = app1.getUint16(tiffOffset) === 0x4949;
  const get16 = o => app1.getUint16(tiffOffset + o, little);
  const get32 = o => app1.getUint32(tiffOffset + o, little);

  function readIFD(ifdOffset) {
    const tags = {};
    const count = get16(ifdOffset);
    for (let i = 0; i < count; i++) {
      const base = ifdOffset + 2 + i * 12;
      const tag  = get16(base);
      const type = get16(base + 2);
      const num  = get32(base + 4);
      const valOffset = base + 8;
      if (type === 2) { // ASCII
        const strOffset = num > 4 ? get32(valOffset) : valOffset;
        let str = '';
        for (let j = 0; j < num - 1; j++) str += String.fromCharCode(app1.getUint8(tiffOffset + strOffset + j));
        tags[tag] = str;
      } else if (type === 5) { // RATIONAL
        const rOff = get32(valOffset);
        const vals = [];
        for (let j = 0; j < num; j++) {
          const n = get32(tiffOffset + rOff + j * 8);
          const d = get32(tiffOffset + rOff + j * 8 + 4);
          vals.push(d ? n / d : 0);
        }
        tags[tag] = num === 1 ? vals[0] : vals;
      } else if (type === 3 && num === 1) {
        tags[tag] = get16(valOffset);
      } else if (type === 4 && num === 1) {
        tags[tag] = get32(valOffset);
      }
    }
    return tags;
  }

  const ifd0 = readIFD(get32(4));
  const exifIFD = ifd0[0x8769] ? readIFD(ifd0[0x8769]) : {};
  const gpsIFD  = ifd0[0x8825] ? readIFD(ifd0[0x8825]) : {};

  // Parse GPS rational arrays → decimal degrees
  let lat = null, lon = null;
  if (gpsIFD[0x0002] && gpsIFD[0x0004]) {
    const la = gpsIFD[0x0002];
    const lo = gpsIFD[0x0004];
    lat = la[0] + la[1] / 60 + la[2] / 3600;
    lon = lo[0] + lo[1] / 60 + lo[2] / 3600;
    if (gpsIFD[0x0001] === 'S') lat = -lat;
    if (gpsIFD[0x0003] === 'W') lon = -lon;
  }

  // DateTimeOriginal tag 0x9003 → "YYYY:MM:DD HH:MM:SS"
  const dateStr = exifIFD[0x9003] || ifd0[0x0132] || null;

  return { lat, lon, dateStr };
}

// ── Moon phase (pure math, no API) ───────────────────────────────────────────
function moonPhaseLabel(isoDate) {
  const d = new Date(isoDate);
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

// ── Historical weather from Open-Meteo ───────────────────────────────────────
async function fetchHistoricalWeather(lat, lon, isoDateTime) {
  const dateOnly = isoDateTime.slice(0, 10);
  const hour = parseInt(isoDateTime.slice(11, 13));
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${dateOnly}&end_date=${dateOnly}&hourly=temperature_2m,surface_pressure,cloudcover,windspeed_10m,winddirection_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Weather API ${resp.status}`);
  const data = await resp.json();
  const h = data.hourly;
  return {
    tempF:       Math.round(h.temperature_2m[hour] * 10) / 10,
    pressureHpa: Math.round(h.surface_pressure[hour]),
    cloudPct:    h.cloudcover[hour],
    windMph:     Math.round(h.windspeed_10m[hour] * 10) / 10,
    windDir:     h.winddirection_10m[hour],
    moonPhase:   moonPhaseLabel(isoDateTime),
  };
}

// ── Spatial lookup — which lake + depth band at these coords ─────────────────
function spatialLookup(lat, lon) {
  try {
    // Lake identification — check against LAKE_DB center + rough radius
    const LAKE_DB = window.LAKE_DB || {};
    let lakeName = null;
    let bestDist = Infinity;
    for (const [name, info] of Object.entries(LAKE_DB)) {
      if (!info.center) continue;
      const dLat = (lat - info.center[0]) * 69;
      const dLon = (lon - info.center[1]) * 69 * Math.cos(lat * Math.PI / 180);
      const dist = Math.sqrt(dLat * dLat + dLon * dLon);
      if (dist < bestDist && dist < (info.radiusMi || 15)) {
        bestDist = dist;
        lakeName = name;
      }
    }

    // Depth band from loaded contour data
    let depthBand = null;
    const contourData = state.ACTIVE_CONTOUR;
    const features = contourData?.smart?.features || contourData?.raw?.features || [];

    if (features.length && lat && lon) {
      let closestDepth = null;
      let closestDist = Infinity;
      for (const feat of features) {
        const depth = feat.properties?.depth ?? feat.properties?.DEPTH;
        if (depth == null) continue;
        const coords = feat.geometry?.coordinates;
        if (!coords) continue;
        // For LineString — find closest point on the contour line
        const pts = feat.geometry.type === 'LineString' ? coords : coords.flat();
        for (const [cLon, cLat] of pts) {
          const d = Math.hypot((lat - cLat) * 69, (lon - cLon) * 69 * Math.cos(lat * Math.PI / 180));
          if (d < closestDist) { closestDist = d; closestDepth = depth; }
        }
      }
      if (closestDepth != null && closestDist < 0.25) { // within ~0.25 miles
        depthBand = `~${closestDepth}ft contour (${closestDist < 0.1 ? 'on' : 'near'} contour)`;
      }
    }

    return { lakeName, depthBand };
  } catch (e) {
    console.warn('[catch-journal] spatial lookup failed:', e);
    return { lakeName: null, depthBand: null };
  }
}

// ── Set import status message ──────────────────────────────────────────────────
function setImportStatus(msg, color) {
  const el = document.getElementById('cImportStatus');
  if (el) { el.textContent = msg; el.style.color = color || 'var(--accent2)'; }
}

// ── Main photo processor ──────────────────────────────────────────────────────
async function processCatchPhoto(file) {
  if (!file || !file.type.startsWith('image/')) {
    setImportStatus('Not an image file', 'var(--bad)');
    return;
  }

  // Open catch tab + form
  document.querySelector('#bottomNav button[data-tab="catch"]')?.click();
  const catchForm = document.getElementById('catchForm');
  if (catchForm) catchForm.style.display = 'block';

  setImportStatus('Reading photo metadata...', 'var(--muted)');

  const buffer = await file.arrayBuffer();
  const exif = parseEXIF(buffer);

  if (!exif) {
    setImportStatus('No EXIF data found in photo', 'var(--warn)');
    return;
  }

  const { lat, lon, dateStr } = exif;

  // Parse EXIF date "YYYY:MM:DD HH:MM:SS" → ISO
  let isoDateTime = null;
  let displayTime = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  if (dateStr) {
    const [datePart, timePart] = dateStr.split(' ');
    if (datePart && timePart) {
      isoDateTime = `${datePart.replace(/:/g, '-')}T${timePart}`;
      displayTime = new Date(isoDateTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    }
  }

  // Set time field immediately
  const timeEl = document.getElementById('cTime');
  if (timeEl) timeEl.value = displayTime;

  // Store GPS
  pending.lat = lat;
  pending.lon = lon;

  // Show thumbnail (not stored, display only)
  const thumb = document.getElementById('cPhotoThumb');
  if (thumb) {
    const url = URL.createObjectURL(file);
    thumb.src = url;
    thumb.style.display = 'block';
    thumb.onload = () => URL.revokeObjectURL(url); // free memory immediately after display
  }

  // Spatial lookup (synchronous, local data)
  if (lat && lon) {
    const spatial = spatialLookup(lat, lon);
    pending.structure = spatial;
    if (spatial.lakeName) {
      // Pre-fill lake in plan form if empty
      const lakeEl = document.getElementById('planLake');
      if (lakeEl && !lakeEl.value) lakeEl.value = spatial.lakeName;
    }
    if (spatial.depthBand) {
      const depthEl = document.getElementById('cDepth');
      if (depthEl && !depthEl.value) {
        // Extract numeric depth from "~18ft contour..." string
        const m = spatial.depthBand.match(/~?(\d+)/);
        if (m) depthEl.value = m[1];
      }
    }
  }

  // Weather fetch (async, needs GPS + date)
  if (lat && lon && isoDateTime) {
    setImportStatus('Fetching historical weather...', 'var(--muted)');
    try {
      const weather = await fetchHistoricalWeather(lat, lon, isoDateTime);
      pending.weather = weather;
      // Show weather summary in notes as a starting point
      const notesEl = document.getElementById('cNotes');
      if (notesEl && !notesEl.value) {
        notesEl.value = `${weather.tempF}°F · ${weather.pressureHpa}hPa · Wind ${weather.windMph}mph · ${weather.cloudPct}% cloud · ${weather.moonPhase}`;
      }
      setImportStatus(
        `✓ ${lat ? 'GPS found' : 'No GPS'} · ${weather.tempF}°F · ${weather.pressureHpa}hPa · ${weather.moonPhase}`,
        'var(--accent2)'
      );
    } catch (e) {
      setImportStatus(`GPS found · Weather unavailable (${e.message})`, 'var(--warn)');
    }
  } else if (!lat) {
    setImportStatus('⚠ No GPS in photo — fill in location manually', 'var(--warn)');
  } else {
    setImportStatus('⚠ No timestamp in photo', 'var(--warn)');
  }
}

// ── Drag-drop import ──────────────────────────────────────────────────────────
const dropOverlay = document.createElement('div');
dropOverlay.id = 'catchDropOverlay';
dropOverlay.innerHTML = `
  <div style="pointer-events:none;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;border:3px dashed var(--accent2);border-radius:16px;background:rgba(10,20,30,0.95)">
    <span style="font-size:48px">📸</span>
    <div style="color:var(--accent2);font-size:18px;font-weight:700;margin-top:12px">Drop Catch Photo to Import</div>
    <div style="color:var(--muted);font-size:12px;margin-top:6px">Extracts GPS · Time · Weather · Depth</div>
    <div style="color:var(--muted);font-size:11px;margin-top:4px">Photo is not stored — only the data</div>
  </div>
`;
Object.assign(dropOverlay.style, {
  position: 'fixed', top: '12px', left: '12px', right: '12px', bottom: '60px',
  zIndex: '99999', display: 'none', backdropFilter: 'blur(4px)',
});
document.body.appendChild(dropOverlay);

let dragCounter = 0;
document.body.addEventListener('dragenter', e => { e.preventDefault(); dragCounter++; dropOverlay.style.display = 'block'; });
document.body.addEventListener('dragleave', ()  => { if (--dragCounter <= 0) { dragCounter = 0; dropOverlay.style.display = 'none'; } });
document.body.addEventListener('dragover',  e => e.preventDefault());
document.body.addEventListener('drop', async e => {
  e.preventDefault();
  dragCounter = 0;
  dropOverlay.style.display = 'none';
  const file = e.dataTransfer.files?.[0];
  if (file) processCatchPhoto(file);
});

// ── Wire buttons ──────────────────────────────────────────────────────────────
function wireButtons() {
  // File picker also triggers EXIF import
  document.getElementById('cPhoto')?.addEventListener('change', e => {
    if (e.target.files?.[0]) processCatchPhoto(e.target.files[0]);
  });

  document.getElementById('addCatchBtn')?.addEventListener('click', () => {
    document.getElementById('catchForm').style.display = 'block';
    const timeEl = document.getElementById('cTime');
    if (timeEl && !timeEl.value) {
      timeEl.value = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    }
  });

  document.getElementById('cancelCatchBtn')?.addEventListener('click', () => {
    document.getElementById('catchForm').style.display = 'none';
    // Discard pending import data on cancel
    pending.lat = null; pending.lon = null;
    pending.weather = null; pending.structure = null; pending.photoThumb = null;
    const thumb = document.getElementById('cPhotoThumb');
    if (thumb) { thumb.src = ''; thumb.style.display = 'none'; }
    setImportStatus('');
  });

  document.getElementById('saveCatchBtn')?.addEventListener('click', saveNewCatch);
}

wireButtons();
