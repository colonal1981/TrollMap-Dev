/**
 * Catch Journal — log each fish caught with species, length,
 * time, depth, lure, lead, and an optional verification photo.
 *
 * Persisted to IndexedDB `journal.catches` (single record under
 * the name "catches"). Photos are stored as data URLs in the
 * record — keep that in mind if you log many catches with photos.
 */

import { state } from '../core/state.js';
import { esc } from '../utils/escape.js';

// Module-level mirror of CATCHES (we keep state.CATCHES as the
// canonical store; this is a reference to avoid name shadowing).
function getCatches() { return state.CATCHES; }
function setCatches(arr) { state.CATCHES = arr; }

/** Render the catch-log list under the journal section. */
export function renderCatchLog() {
  const host = document.getElementById('catchLog');
  if (!host) return;
  const catches = getCatches();
  if (!catches.length) {
    host.innerHTML = '<p class="muted" style="font-size:12px">No catches logged yet.</p>';
    return;
  }
  host.innerHTML = catches.map((c, i) => `
    <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--line);font-size:12px">
      <span>🐟</span>
      <span style="flex:1"><b>${esc(c.species || 'Fish')}</b>${c.length ? ' ' + c.length + '"' : ''} · ${esc(c.lure || '')} · ${esc(c.depth || '')}ft · ${esc(c.time || '')}</span>
      ${c.photo ? `<button onclick="window.showCatchPhoto(${i})" style="padding:1px 6px;font-size:11px;background:var(--accent2);color:#000;border:none;font-weight:700">🖼️ Photo</button>` : ''}
      <button data-ci="${i}" style="padding:1px 6px;font-size:11px">🗑</button>
    </div>
  `).join('');

  host.querySelectorAll('[data-ci]').forEach((el) => {
    el.addEventListener('click', async (e) => {
      const catches = getCatches();
      catches.splice(+e.target.dataset.ci, 1);
      renderCatchLog();
      await saveCatches();
    });
  });
}

async function saveCatches() {
  if (!window.DB?.db) return;
  try {
    await window.DB.put('journal', { name: 'catches', data: getCatches() });
  } catch (_) {}
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

async function saveNewCatch() {
  const photoInput = document.getElementById('cPhoto');
  let photoDataUrl = '';

  if (photoInput && photoInput.files[0]) {
    const file = photoInput.files[0];
    if (file.size > 4 * 1024 * 1024) {
      if (!confirm('This photo is large (>4MB). Save it anyway?')) {
        photoInput.value = '';
        return;
      }
    }
    photoDataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  const catches = getCatches();
  catches.unshift({
    species: document.getElementById('cSpecies')?.value || '',
    length:  document.getElementById('cLength')?.value  || '',
    depth:   document.getElementById('cDepth')?.value   || '',
    lure:    document.getElementById('cLure')?.value    || '',
    lead:    document.getElementById('cLead')?.value    || '',
    time:    document.getElementById('cTime')?.value    || '',
    notes:   document.getElementById('cNotes')?.value   || '',
    photo:   window._pendingCatchPhotoBase64 || photoDataUrl,
    date:    new Date().toISOString().slice(0, 10),
    lake:    document.getElementById('planLake')?.value || '',
    lat:     window._pendingCatchLat || '',
    lon:     window._pendingCatchLon || '',
  });

  // Clear pending data
  window._pendingCatchPhotoBase64 = null;
  window._pendingCatchLat = null;
  window._pendingCatchLon = null;


  renderCatchLog();
  await saveCatches();

  // Reset the form
  ['cSpecies', 'cLength', 'cDepth', 'cLure', 'cLead', 'cNotes'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  if (photoInput) photoInput.value = '';
  document.getElementById('catchForm').style.display = 'none';
}

function wireButtons() {
  // Hook the manual file input to the EXIF processor too!
  const photoInput = document.getElementById('cPhoto');
  if (photoInput) {
    photoInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        processCatchPhoto(e.target.files[0]);
      }
    });
  }

  document.getElementById('addCatchBtn')?.addEventListener('click', () => {
    document.getElementById('catchForm').style.display = 'block';
    if (!document.getElementById('cTime').value) {
      document.getElementById('cTime').value = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    }
  });
  document.getElementById('cancelCatchBtn')?.addEventListener('click', () => {
    document.getElementById('catchForm').style.display = 'none';
  });
  document.getElementById('saveCatchBtn')?.addEventListener('click', saveNewCatch);
}

wireButtons();


// ── EXIF Catch Importer (Zero-Friction Phase 1) ───────────────────────

// 1. Load EXIF library
const exifScript = document.createElement('script');
exifScript.src = 'https://cdn.jsdelivr.net/npm/exif-js';
document.head.appendChild(exifScript);

// 2. Global Dropzone UI
const dropOverlay = document.createElement('div');
dropOverlay.innerHTML = `<div style="pointer-events:none; display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; border: 4px dashed #00e5ff; border-radius: 20px; background: rgba(11, 22, 35, 0.95);">
    <span style="font-size: 60px;">📸</span>
    <h2 style="color:white; margin-top:20px;">Drop Catch Photo to Import</h2>
    <p style="color:#aaa;">Extracts Time & GPS -> Fetches Weather -> Auto-Fills Form</p>
</div>`;
Object.assign(dropOverlay.style, {
    position: 'fixed', top: '10px', left: '10px', right: '10px', bottom: '10px',
    zIndex: '999999', display: 'none', backdropFilter: 'blur(5px)', transition: 'all 0.2s'
});
document.body.appendChild(dropOverlay);

let dragCounter = 0;
document.body.addEventListener('dragenter', (e) => { e.preventDefault(); });
document.body.addEventListener('dragover', (e) => { e.preventDefault(); });
document.body.addEventListener('dragenter', () => {
    dragCounter++;
    dropOverlay.style.display = 'block';
});
document.body.addEventListener('dragleave', () => {
    dragCounter--;
    if (dragCounter === 0) dropOverlay.style.display = 'none';
});
document.body.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropOverlay.style.display = 'none';
    
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        processCatchPhoto(e.dataTransfer.files[0]);
    }
});

// Temporary storage for the dropped photo so saveNewCatch can use it
window._pendingCatchPhotoBase64 = null;
window._pendingCatchLat = null;
window._pendingCatchLon = null;

function processCatchPhoto(file) {
    if (!window.EXIF) {
        alert("EXIF library is still loading. Try again in 2 seconds.");
        return;
    }
    
    // Switch to the Catch tab automatically
    document.querySelector('#bottomNav button[data-tab="catch"]')?.click();
    
    // Open the form
    const catchForm = document.getElementById('catchForm');
    if (catchForm) catchForm.style.display = 'block';
    
    const notesEl = document.getElementById('cNotes');
    const timeEl = document.getElementById('cTime');
    
    if (notesEl) notesEl.value = "Analyzing Photo Metadata...";

    EXIF.getData(file, function() {
        try {
            let latDec = null, lonDec = null;
            let dateStr = EXIF.getTag(this, "DateTimeOriginal"); // "YYYY:MM:DD HH:MM:SS"
            
            let lat = EXIF.getTag(this, "GPSLatitude");
            let lon = EXIF.getTag(this, "GPSLongitude");
            let latRef = EXIF.getTag(this, "GPSLatitudeRef");
            let lonRef = EXIF.getTag(this, "GPSLongitudeRef");
            
            if (lat && lon) {
                latDec = lat[0] + (lat[1]/60) + (lat[2]/3600);
                lonDec = lon[0] + (lon[1]/60) + (lon[2]/3600);
                if (latRef === "S") latDec = -latDec;
                if (lonRef === "W") lonDec = -lonDec;
            }

            const reader = new FileReader();
            reader.onload = async (e) => {
                window._pendingCatchPhotoBase64 = e.target.result;
                window._pendingCatchLat = latDec;
                window._pendingCatchLon = lonDec;
                
                let isoDate = null;
                let displayTime = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                
                if (dateStr) {
                    const parts = dateStr.split(" ");
                    if (parts.length === 2) {
                        isoDate = `${parts[0].replace(/:/g, '-')}T${parts[1]}`;
                        displayTime = new Date(isoDate).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                    }
                }
                
                if (timeEl) timeEl.value = displayTime;

                // Fetch Weather if we have GPS and Time
                let weatherStr = "No GPS found on photo (Android stripped it).";
                if (latDec && isoDate) {
                    if (notesEl) notesEl.value = "Fetching historical weather...";
                    try {
                        const dateOnly = isoDate.split('T')[0];
                        const hour = parseInt(isoDate.split('T')[1].split(':')[0]);
                        const url = `https://api.open-meteo.com/v1/forecast?latitude=${latDec}&longitude=${lonDec}&start_date=${dateOnly}&end_date=${dateOnly}&hourly=temperature_2m,surface_pressure,cloudcover,windspeed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto`;
                        
                        const wResp = await fetch(url);
                        if (wResp.ok) {
                            const wData = await wResp.json();
                            const temp = wData.hourly.temperature_2m[hour];
                            const press = wData.hourly.surface_pressure[hour];
                            const cloud = wData.hourly.cloudcover[hour];
                            const wind = wData.hourly.windspeed_10m[hour];
                            weatherStr = `${temp}°F | ${press} hPa | Wind: ${wind}mph | ${cloud}% Cloud`;
                        } else {
                            weatherStr = "Weather API failed.";
                        }
                    } catch (e) {
                        weatherStr = "Weather fetch error.";
                    }
                }
                
                if (notesEl) notesEl.value = weatherStr;
                alert(`Photo Analyzed!\n\nTime: ${displayTime}\nGPS: ${latDec ? 'Found!' : 'Missing'}\nWeather: ${weatherStr}\n\nFill out Species/Length and click Save.`);

            };
            reader.readAsDataURL(file);

        } catch (err) {
            if (notesEl) notesEl.value = `Error parsing EXIF: ${err.message}`;
        }
    });
}
