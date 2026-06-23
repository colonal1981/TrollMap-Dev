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

async function loadCatches() {
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
    photo:   photoDataUrl,
    date:    new Date().toISOString().slice(0, 10),
    lake:    document.getElementById('planLake')?.value || '',
    lat:     '',
    lon:     '',
  });

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
  document.getElementById('addCatchBtn')?.addEventListener('click', () => {
    document.getElementById('catchForm').style.display = 'block';
    document.getElementById('cTime').value = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  });
  document.getElementById('cancelCatchBtn')?.addEventListener('click', () => {
    document.getElementById('catchForm').style.display = 'none';
  });
  document.getElementById('saveCatchBtn')?.addEventListener('click', saveNewCatch);
}

wireButtons();
