Okay, if you caught the fish at 1:10 PM EST, and TrollMap is actively displaying "6:10 PM", then I know *exactly* what is happening.

JavaScript determines the local time by reading your browser's internal timezone. Some work computers, VPNs, and privacy extensions (like Brave or Chrome's anti-fingerprinting) intentionally mask your real timezone and tell the browser it is located in "UTC" to prevent tracking!

Because your browser thinks it's in Greenwich, London, it refuses to subtract the 5 hours for South Carolina, so it just displays the raw UTC time from Google Takeout.

**The Fix:**
I am going to hardcode the time parsing logic to explicitly target the `America/New_York` timezone, completely ignoring what your browser thinks its timezone is!

Here is the fully patched `catch-journal.js` (including the dual-drag logic so you don't need ExifTool). Just copy and paste this entire block over your existing file:

```javascript
/**
 * catch-journal.js — Catch Journal with Zero-Friction Photo Import
 *
 * Stores structured catch data only — NO photos in IndexedDB.
 * Photos are used transiently to extract EXIF metadata, then discarded.
 */

import { state } from '../core/state.js';
import { esc } from '../utils/escape.js';

function getCatches() { return state.CATCHES; }
function setCatches(arr) { state.CATCHES = arr; }

const pending = { lat: null, lon: null, weather: null, structure: null, photoThumb: null };

async function saveCatches() {
  if (!window.DB?.db) return;
  try { await window.DB.put('journal', { name: 'catches', data: getCatches() }); } catch (_) {}
}

export async function loadCatches() {
  if (!window.DB?.db) return;
  try {
    const r = await window.DB.get('journal', 'catches');
    if (r) setCatches(r.data || []);
    renderCatchLog();
  } catch (_) {}
}

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
          ${c.depth ? 'Depth: ' + c.depth + 'ft' : ''} ${c.lure ? ' · ' + esc(c.lure) : ''} ${c.lead ? ' · Lead: ' + c.lead + 'ft' : ''}
        </div>
        ${c.weather ? `<br>${c.weather.tempF}°F · ${c.weather.pressureHpa} hPa · Wind ${c.weather.windMph}mph · ${c.weather.cloudPct}% cloud · ${esc(c.weather.moonPhase || '')}` : ''}
        ${c.structure?.depthBand ? `<br>📍 ${esc(c.structure.depthBand)}` : ''}
        ${c.notes ? `<br>${esc(c.notes)}` : ''}
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

async function saveNewCatch() {
  const catches = getCatches();
  catches.unshift({
    species: document.getElementById('cSpecies')?.value || '',
    length: document.getElementById('cLength')?.value || '',
    depth: document.getElementById('cDepth')?.value || '',
    lure: document.getElementById('cLure')?.value || '',
    lead: document.getElementById('cLead')?.value || '',
    time: document.getElementById('cTime')?.value || '',
    notes: document.getElementById('cNotes')?.value || '',
    photo: null, 
    date: window._pendingCatchDate || new Date().toISOString().slice(0, 10),
    lake: document.getElementById('planLake')?.value || '',
    lat: pending.lat || '',
    lon: pending.lon || '',
    weather: pending.weather || null,
    structure: pending.structure || null,
  });

  pending.lat = null; pending.lon = null; pending.weather = null; pending.structure = null; pending.photoThumb = null;
  window._pendingCatchDate = null;

  const thumb = document.getElementById('cPhotoThumb');
  if (thumb) { thumb.src = ''; thumb.style.display = 'none'; }
  const status = document.getElementById('cImportStatus');
  if (status) status.textContent = '';
  const coordEl4 = document.getElementById('cCoords');
  if (coordEl4) coordEl4.value = '';

  renderCatchLog();
  await saveCatches();

  ['cSpecies','cLength','cDepth','cLure','cLead','cNotes','cDate'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  
  const photoInput = document.getElementById('cPhoto');
  if (photoInput) photoInput.value = '';
  document.getElementById('catchForm').style.display = 'none';
}

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
    const result = await exifr.parse(file, { gps: true, exif: true, tiff: true, mergeOutput: false });
    if (!result) return null;
    const gps = result.gps || {};
    const exif = result.exif || {};
    const tiff = result.tiff || {};
    const lat = gps.latitude ?? null;
    const lon = gps.longitude ?? null;
    const dateStr = exif.DateTimeOriginal || tiff.DateTime || null;
    
    let isoDateStr = null;
    if (dateStr instanceof Date) {
      isoDateStr = dateStr.toISOString().slice(0, 19).replace('T', ' ');
    } else if (typeof dateStr === 'string') {
      isoDateStr = dateStr; 
    }
    return { lat, lon, dateStr: isoDateStr };
  } catch (e) { return null; }
}

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

async function fetchHistoricalWeather(lat, lon, isoDateTime) {
  const dateOnly = isoDateTime.slice(0, 10);
  const hour = parseInt(isoDateTime.slice(11, 13));
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${dateOnly}&end_date=${dateOnly}&hourly=temperature_2m,surface_pressure,cloudcover,windspeed_10m,winddirection_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FNew_York`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Weather API ${resp.status}`);
  const data = await resp.json();
  const h = data.hourly;
  return {
    tempF: Math.round(h.temperature_2m[hour] * 10) / 10,
    pressureHpa: Math.round(h.surface_pressure[hour]),
    cloudPct: h.cloudcover[hour],
    windMph: Math.round(h.windspeed_10m[hour] * 10) / 10,
    windDir: h.winddirection_10m[hour],
    moonPhase: moonPhaseLabel(isoDateTime),
  };
}

function spatialLookup(lat, lon) {
  try {
    const LAKE_DB = window.LAKE_DB || {};
    let lakeName = null;
    let bestDist = Infinity;
    for (const [name, info] of Object.entries(LAKE_DB)) {
      if (!info.center) continue;
      const dLat = (lat - info.center[0]) * 69;
      const dLon = (lon - info.center[1]) * 69 * Math.cos(lat * Math.PI / 180);
      const dist = Math.sqrt(dLat * dLat + dLon * dLon);
      if (dist < bestDist && dist < (info.radiusMi || 15)) { bestDist = dist; lakeName = name; }
    }
    let depthBand = null;
    const contourData = state.ACTIVE_CONTOUR;
    const features = contourData?.smart?.features || contourData?.raw?.features || [];
    if (features.length && lat && lon) {
      let closestDepth = null;
      let closestDist = Infinity;
      const cosLat = Math.cos(lat * Math.PI / 180);
      const boxDeg = 1 / 69;
      const candidates = features.filter(feat => {
        const bbox = feat.bbox;
        if (bbox) return bbox[0] - boxDeg <= lon && lon <= bbox[2] + boxDeg && bbox[1] - boxDeg <= lat && lat <= bbox[3] + boxDeg;
        return true;
      });
      for (const feat of candidates) {
        const depth = feat.properties?.depth ?? feat.properties?.DEPTH ?? feat.properties?.depth_ft;
        if (depth == null) continue;
        const coords = feat.geometry?.coordinates;
        if (!coords) continue;
        const gtype = feat.geometry.type;
        const pts = gtype === 'LineString' ? coords : gtype === 'MultiLineString' ? coords.flat(1) : gtype === 'Polygon' ? coords[0] : coords.flat(2);
        for (const pt of pts) {
          const cLon = Array.isArray(pt[0]) ? pt[0][0] : pt[0];
          const cLat = Array.isArray(pt[0]) ? pt[0][1] : pt[1];
          if (!isFinite(cLat) || !isFinite(cLon)) continue;
          const d = Math.hypot((lat - cLat) * 69, (lon - cLon) * 69 * cosLat);
          if (d < closestDist) { closestDist = d; closestDepth = depth; }
        }
      }
      if (closestDepth != null && closestDist < 1.0) {
        depthBand = `~${closestDepth}ft contour (${closestDist < 0.1 ? 'on' : closestDist < 0.25 ? 'near' : 'near'} contour)`;
      }
    }
    return { lakeName, depthBand };
  } catch (e) { return { lakeName: null, depthBand: null }; }
}

function setImportStatus(msg, color) {
  const el = document.getElementById('cImportStatus');
  if (el) { el.textContent = msg; el.style.color = color || 'var(--accent2)'; }
}

async function processCatchPhoto(imgFile, jsonFile = null) {
  if (!imgFile && !jsonFile) return;
  
  document.querySelector('#bottomNav button[data-tab="catch"]')?.click();
  const catchForm = document.getElementById('catchForm');
  if (catchForm) catchForm.style.display = 'block';
  
  setImportStatus('Reading photo metadata...', 'var(--muted)');
  let lat = null, lon = null, dateStr = null;

  if (jsonFile) {
    setImportStatus('Parsing Google Takeout JSON sidecar...', 'var(--muted)');
    const text = await jsonFile.text();
    try {
      const payload = JSON.parse(text);
      if (payload.geoData && payload.geoData.latitude !== 0.0) {
        lat = payload.geoData.latitude;
        lon = payload.geoData.longitude;
      }
      if (payload.photoTakenTime && payload.photoTakenTime.timestamp) {
        const utcMs = parseInt(payload.photoTakenTime.timestamp) * 1000;
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
        });
        const parts = formatter.formatToParts(new Date(utcMs));
        const p = {};
        parts.forEach(({ type, value }) => { p[type] = value; });
        dateStr = `${p.year}:${p.month}:${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second}`;
      }
    } catch(e) {}
  }

  if (!lat || !dateStr) {
    if (imgFile) {
      const exif = await parseEXIF(imgFile);
      if (exif) {
        if (!lat) lat = exif.lat;
        if (!lon) lon = exif.lon;
        if (!dateStr) dateStr = exif.dateStr;
      }
    }
  }

  if (!dateStr) {
    setImportStatus('No EXIF or JSON data found', 'var(--warn)');
    return;
  }

  let isoDateTime = null;
  let displayTime = '';
  if (dateStr) {
    const [datePart, timePart] = dateStr.split(' ');
    if (datePart && timePart) {
      isoDateTime = `${datePart.replace(/:/g, '-')}T${timePart}`;
      window._pendingCatchDate = datePart.replace(/:/g, '-');
      let [h, m, s] = timePart.split(':');
      let hr = parseInt(h);
      let ampm = hr >= 12 ? 'PM' : 'AM';
      hr = hr % 12;
      hr = hr ? hr : 12; 
      displayTime = `${hr}:${m} ${ampm}`;
    }
  }

  const timeEl = document.getElementById('cTime');
  if (timeEl) timeEl.value = displayTime;
  const dateEl = document.getElementById('cDate');
  if (dateEl) dateEl.value = isoDateTime ? isoDateTime.slice(0, 10) : new Date().toISOString().slice(0, 10);

  pending.lat = lat; pending.lon = lon;

  if (imgFile) {
    const thumb = document.getElementById('cPhotoThumb');
    if (thumb) {
      const url = URL.createObjectURL(imgFile);
      thumb.src = url;
      thumb.style.display = 'block';
      thumb.onload = () => URL.revokeObjectURL(url);
    }
  }

  if (lat && lon) {
    const spatial = spatialLookup(lat, lon);
    pending.structure = spatial;
    if (spatial.lakeName) {
      const lakeEl = document.getElementById('planLake');
      if (lakeEl && !lakeEl.value) lakeEl.value = spatial.lakeName;
    }
    if (spatial.depthBand) {
      const depthEl = document.getElementById('cDepth');
      if (depthEl && !depthEl.value) {
        const m = spatial.depthBand.match(/~?(\d+)/);
        if (m) depthEl.value = m[1];
      }
      setImportStatus(`GPS found · depth ~${spatial.depthBand.match(/~?(\d+)/)?.[1] || '?'}ft from contour · fetching weather...`, 'var(--muted)');
    }
  }

  if (lat && lon && isoDateTime) {
    setImportStatus('Fetching historical weather...', 'var(--muted)');
    try {
      const weather = await fetchHistoricalWeather(lat, lon, isoDateTime);
      pending.weather = weather;
      const notesEl = document.getElementById('cNotes');
      const pressStr = weather.pressureHpa > 0 ? `${weather.pressureHpa}hPa · ` : '';
      if (notesEl && !notesEl.value) {
        notesEl.value = `${weather.tempF}°F · ${pressStr}Wind ${weather.windMph}mph · ${weather.cloudPct}% cloud · ${weather.moonPhase}`;
      }
      const coordEl = document.getElementById('cCoords');
      if (coordEl && lat) coordEl.value = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
      setImportStatus(`✓ GPS found · ${weather.tempF}°F · Wind ${weather.windMph}mph · ${weather.moonPhase}`, 'var(--accent2)');
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

const dropOverlay = document.createElement('div');
dropOverlay.id = 'catchDropOverlay';
dropOverlay.innerHTML = `
  <div style="pointer-events:none;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;border:3px dashed var(--accent2);border-radius:16px;background:rgba(10,20,30,0.95)">
    <span style="font-size:48px">📸</span>
    <div style="color:var(--accent2);font-size:18px;font-weight:700;margin-top:12px">Drop Catch Photo (and JSON) to Import</div>
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
document.body.addEventListener('dragleave', () => { if (--dragCounter <= 0) { dragCounter = 0; dropOverlay.style.display = 'none'; } });
document.body.addEventListener('dragover', e => e.preventDefault());
document.body.addEventListener('drop', async e => {
  e.preventDefault(); dragCounter = 0; dropOverlay.style.display = 'none';
  const files = e.dataTransfer.files;
  if (!files || files.length === 0) return;
  let imgFile = null, jsonFile = null;
  for (let i = 0; i < files.length; i++) {
    if (files[i].name.endsWith('.json')) jsonFile = files[i];
    else if (files[i].type.startsWith('image/')) imgFile = files[i];
  }
  if (imgFile || jsonFile) processCatchPhoto(imgFile, jsonFile);
});

function wireButtons() {
  const photoInput = document.getElementById('cPhoto');
  if (photoInput) {
    if (!photoInput.hasAttribute('multiple')) photoInput.setAttribute('multiple', 'multiple');
    photoInput.addEventListener('change', e => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      let imgFile = null, jsonFile = null;
      for (let i = 0; i < files.length; i++) {
        if (files[i].name.endsWith('.json')) jsonFile = files[i];
        else if (files[i].type.startsWith('image/')) imgFile = files[i];
      }
      if (imgFile || jsonFile) processCatchPhoto(imgFile, jsonFile);
    });
  }

  document.getElementById('addCatchBtn')?.addEventListener('click', () => {
    document.getElementById('catchForm').style.display = 'block';
    const timeEl = document.getElementById('cTime');
    if (timeEl && !timeEl.value) timeEl.value = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const dateEl2 = document.getElementById('cDate');
    if (dateEl2 && !dateEl2.value) dateEl2.value = new Date().toISOString().slice(0, 10);
  });

  document.getElementById('cancelCatchBtn')?.addEventListener('click', () => {
    document.getElementById('catchForm').style.display = 'none';
    pending.lat = null; pending.lon = null; pending.weather = null; pending.structure = null; pending.photoThumb = null;
    const thumb = document.getElementById('cPhotoThumb');
    if (thumb) { thumb.src = ''; thumb.style.display = 'none'; }
    const coordEl3 = document.getElementById('cCoords');
    if (coordEl3) coordEl3.value = '';
    setImportStatus('');
  });

  document.getElementById('saveCatchBtn')?.addEventListener('click', saveNewCatch);
}

wireButtons();
```
