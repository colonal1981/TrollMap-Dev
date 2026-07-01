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
    date:      document.getElementById('cDate')?.value || new Date().toISOString().slice(0, 10),
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

  // Clear thumbnail preview and coords display
  const thumb = document.getElementById('cPhotoThumb');
  if (thumb) { thumb.src = ''; thumb.style.display = 'none'; }
  const status = document.getElementById('cImportStatus');
  if (status) status.textContent = '';
  const coordEl4 = document.getElementById('cCoords');
  if (coordEl4) coordEl4.value = '';

  renderCatchLog();
  await saveCatches();

  // Reset form fields
  ['cSpecies','cLength','cDepth','cLure','cLead','cNotes','cDate'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const photoInput = document.getElementById('cPhoto');
  if (photoInput) photoInput.value = '';
  document.getElementById('catchForm').style.display = 'none';
}

// ── EXIF extraction via exifr ────────────────────────────────────────────────
// exifr is a well-tested, actively maintained EXIF library available as a
// pure ES module — no build step, no CDN script tag, proper GPS parsing.
// Docs: https://github.com/MikeKovarik/exifr
let _exifr = null;
async function loadExifr() {
  if (_exifr) return _exifr;
  const mod = await import('https://cdn.jsdelivr.net/npm/exifr/dist/full.esm.js');
  _exifr = mod.default || mod;
  return _exifr;
}

async function parseEXIF(file) {
  try {
    const exifr = await loadExifr();
    const result = await exifr.parse(file, {
      gps: true,
      exif: true,
      tiff: true,
      mergeOutput: false,
    });
    if (!result) return null;

    const gps  = result.gps  || {};
    const exif = result.exif || {};
    const tiff = result.tiff || {};

    const lat = gps.latitude  ?? null;
    const lon = gps.longitude ?? null;
    const dateStr = exif.DateTimeOriginal || tiff.DateTime || null;

    // exifr returns DateTimeOriginal as a real Date object or string
    let isoDateStr = null;
    if (dateStr instanceof Date) {
      isoDateStr = dateStr.toISOString().slice(0, 19).replace('T', ' ');
    } else if (typeof dateStr === 'string') {
      isoDateStr = dateStr; // "YYYY:MM:DD HH:MM:SS" format
    }

    return { lat, lon, dateStr: isoDateStr };
  } catch (e) {
    console.warn('[catch-journal] exifr parse failed:', e);
    return null;
  }
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
      const cosLat = Math.cos(lat * Math.PI / 180);

      // Diagnostic — visible on screen (temporary)
      const sample = features[0];
      const diagEl = document.getElementById('cImportStatus');
      const diag1 = `Features: ${features.length} | Type: ${sample?.geometry?.type} | Props: ${Object.keys(sample?.properties||{}).join(',')} | bbox: ${!!sample?.bbox}`;
      if (diagEl) diagEl.textContent = diag1;

      // Pre-filter with a generous bounding box (~1 mile)
      const boxDeg = 1 / 69;
      const candidates = features.filter(feat => {
        const bbox = feat.bbox;
        if (bbox) {
          return bbox[0] - boxDeg <= lon && lon <= bbox[2] + boxDeg &&
                 bbox[1] - boxDeg <= lat && lat <= bbox[3] + boxDeg;
        }
        return true;
      });

      if (diagEl) diagEl.textContent += ` | Candidates: ${candidates.length}`;

      for (const feat of candidates) {
        const depth = feat.properties?.depth ?? feat.properties?.DEPTH ?? feat.properties?.depth_ft;
        if (depth == null) continue;
        const coords = feat.geometry?.coordinates;
        if (!coords) continue;
        const gtype = feat.geometry.type;
        const pts = gtype === 'LineString' ? coords
          : gtype === 'MultiLineString' ? coords.flat(1)
          : gtype === 'Polygon' ? coords[0]
          : coords.flat(2);
        for (const pt of pts) {
          const cLon = Array.isArray(pt[0]) ? pt[0][0] : pt[0];
          const cLat = Array.isArray(pt[0]) ? pt[0][1] : pt[1];
          if (!isFinite(cLat) || !isFinite(cLon)) continue;
          const d = Math.hypot((lat - cLat) * 69, (lon - cLon) * 69 * cosLat);
          if (d < closestDist) { closestDist = d; closestDepth = depth; }
        }
      }

      if (diagEl) diagEl.textContent += ` | Closest: ${closestDepth}ft @ ${closestDist.toFixed(4)}mi`;

      if (closestDepth != null && closestDist < 1.0) {
        depthBand = `~${closestDepth}ft contour (${closestDist < 0.1 ? 'on' : closestDist < 0.25 ? 'near' : `~${(closestDist * 5280).toFixed(0)}ft from`} contour)`;
      }
    } else {
      const diagEl2 = document.getElementById('cImportStatus');
      if (diagEl2) diagEl2.textContent = `Spatial lookup skipped — features: ${features.length} lat: ${lat} lon: ${lon}`;
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

  const exif = await parseEXIF(file);

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

  // Set date + time fields from EXIF
  const timeEl = document.getElementById('cTime');
  if (timeEl) timeEl.value = displayTime;
  const dateEl = document.getElementById('cDate');
  if (dateEl) dateEl.value = isoDateTime ? isoDateTime.slice(0, 10) : new Date().toISOString().slice(0, 10);

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
        const m = spatial.depthBand.match(/~?(\d+)/);
        if (m) depthEl.value = m[1];
      }
      // Show depth source in status immediately — don't wait for weather
      setImportStatus(`GPS found · depth ~${spatial.depthBand.match(/~?(\d+)/)?.[1] || '?'}ft from contour · fetching weather...`, 'var(--muted)');
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
      const pressStr = weather.pressureHpa > 0 ? `${weather.pressureHpa}hPa · ` : '';
      if (notesEl && !notesEl.value) {
        notesEl.value = `${weather.tempF}°F · ${pressStr}Wind ${weather.windMph}mph · ${weather.cloudPct}% cloud · ${weather.moonPhase}`;
      }
      // Show lat/lon in the GPS coords display field
      const coordEl = document.getElementById('cCoords');
      if (coordEl && lat) coordEl.value = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
      setImportStatus(
        `✓ GPS found · ${weather.tempF}°F · ${pressStr}${weather.moonPhase}`,
        'var(--accent2)'
      );
    } catch (e) {
      const coordEl2 = document.getElementById('cCoords');
      if (coordEl2 && lat) coordEl2.value = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
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
    const dateEl2 = document.getElementById('cDate');
    if (dateEl2 && !dateEl2.value) dateEl2.value = new Date().toISOString().slice(0, 10);
  });

  document.getElementById('cancelCatchBtn')?.addEventListener('click', () => {
    document.getElementById('catchForm').style.display = 'none';
    // Discard pending import data on cancel
    pending.lat = null; pending.lon = null;
    pending.weather = null; pending.structure = null; pending.photoThumb = null;
    const thumb = document.getElementById('cPhotoThumb');
    if (thumb) { thumb.src = ''; thumb.style.display = 'none'; }
    const coordEl3 = document.getElementById('cCoords');
    if (coordEl3) coordEl3.value = '';
    setImportStatus('');
  });

  document.getElementById('saveCatchBtn')?.addEventListener('click', saveNewCatch);
}

wireButtons();
