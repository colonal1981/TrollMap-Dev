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

const DEFAULT_HELPER = 'http://127.0.0.1:8787';
const QUEUE_DB_KEY = 'catch_import_queue';
const CATCHES_DB_KEY = 'catches';

function getCatches() { return state.CATCHES || (state.CATCHES = []); }
function setCatches(arr) { state.CATCHES = arr || []; }
function getQueue() { return state.CATCH_IMPORT_QUEUE || (state.CATCH_IMPORT_QUEUE = []); }
function setQueue(arr) { state.CATCH_IMPORT_QUEUE = arr || []; }

let selectedQueueId = null;
let currentSubtab = 'review';

const SPECIES = [
  '', 'Striped Bass', 'White Bass / Hybrid', 'Largemouth Bass', 'Spotted Bass', 'Smallmouth Bass',
  'Crappie', 'Black Crappie', 'White Crappie', 'Catfish', 'Blue Catfish', 'Channel Catfish', 'Flathead Catfish',
  'Bowfin', 'Chain Pickerel', 'Bluegill', 'Sunfish (Panfish)', 'Redear Sunfish (Shellcracker)',
  'Yellow Perch', 'Gar', 'Longnose Gar', 'Red Drum (Redfish)', 'Speckled Trout (Spotted Seatrout)',
  'Flounder', 'Other Fish', 'Not Fish'
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
    'Sunfish': 'Sunfish (Panfish)',
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
function normalizeCsvRow(row, importedFrom = 'csv') {
  const filename = row.filename || row.file || row.name || '';
  const datetime = row.datetime || row.date_time || row.timestamp || '';
  const { date, time } = splitDateTime(datetime);
  const notes = row.notes || row.stage2_notes || row.ai_notes || '';
  const rawSpecies = cleanSpecies(row.verified_species || row.species || row.stage2_species || row.ai_species || row.stage1_species || '');
  const inferred = inferSpeciesFromNotes(rawSpecies, notes);

  // IMPORTANT: Do not treat stage1_species alone as proof of a fish.
  // The recovered v2 CSVs often have stage1_fish=False while stage1_species says
  // "Other Fish" or another guess. Those should NOT enter the review queue unless
  // stage1_fish is explicitly true, stage2 produced a real species, or v3 has_fish=true.
  const hasFishFieldPresent = Object.prototype.hasOwnProperty.call(row, 'has_fish') && String(row.has_fish || '').trim() !== '';
  const stage1FishFieldPresent = Object.prototype.hasOwnProperty.call(row, 'stage1_fish') && String(row.stage1_fish || '').trim() !== '';
  const finalSpecies = cleanSpecies(row.verified_species || row.species || row.stage2_species || row.ai_species || '');
  const finalSpeciesSaysFish = !!finalSpecies && !['not fish', 'no fish', 'error', 'none'].includes(finalSpecies.toLowerCase());
  let hasFish = false;
  if (hasFishFieldPresent) hasFish = parseBool(row.has_fish);
  else if (stage1FishFieldPresent) hasFish = parseBool(row.stage1_fish) || finalSpeciesSaysFish;
  else hasFish = finalSpeciesSaysFish;

  const onBoard = parseBool(row.on_bump_board);
  const aiLen = String(row.length_inches || row.ai_length || row.aiLength || '').trim();
  const conf = row.confidence || row.stage2_confidence || row.stage1_confidence || '';
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
    lat: row.lat || '', lon: row.lon || '', lake: row.lake || '', depth: row.depth || '',
    ai: {
      hasFish, onBoard,
      species: rawSpecies,
      inferredSpecies: inferred.species,
      length: aiLen,
      confidence: conf,
      model: row.source_model || row.stage2_model || row.model || '',
      notes
    },
    verified: {
      hasFish,
      onBoard,
      species: row.verified_species || inferred.species || rawSpecies || '',
      length: row.verified_length_inches || row.verified_length || '',
      lengthVerified: parseBool(row.length_verified),
      reviewed: false
    },
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
function imageUrl(item) {
  if (!item?.sourcePath) return '';
  return `${helperBase().replace(/\/$/, '')}/image?path=${encodeURIComponent(item.sourcePath)}`;
}
function thumbUrl(item) {
  if (!item?.sourcePath) return '';
  return `${helperBase().replace(/\/$/, '')}/image?path=${encodeURIComponent(item.sourcePath)}`;
}

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

function renderJournalOnly(body = document.getElementById('catchCenterBody')) {
  const catches = getCatches();
  if (!body) return;
  body.innerHTML = `
    <div class="row">
      <button id="manualCatchBtn" class="primary small">+ Manual Catch</button>
      <button id="exportJournalBtn" class="small">⬇ Export Journal CSV</button>
      <span class="muted">${catches.length} confirmed catches</span>
    </div>
    <div id="catchLogList"></div>`;
  const list = body.querySelector('#catchLogList');
  if (!catches.length) {
    list.innerHTML = '<p class="muted">No confirmed catches yet. Import CSV rows into the review queue, then approve them.</p>';
  } else {
    list.innerHTML = catches.map((c, i) => `
      <div style="display:flex;align-items:flex-start;gap:8px;padding:8px 0;border-bottom:1px solid var(--line);font-size:12px">
        <span style="font-size:18px">🐟</span>
        <div style="flex:1;min-width:0">
          <div><b>${esc(c.species || 'Fish')}</b>${c.length ? ` · ${esc(c.length)}"` : ''} · ${esc(c.date || '')} ${esc(c.time || '')} · ${esc(c.lake || '')}</div>
          <div class="muted">${c.depth ? `Depth: ${esc(c.depth)}ft` : ''}${c.sourceFile ? ` · ${esc(c.sourceFile)}` : ''}${c.verification?.length ? ` · length: ${esc(c.verification.length)}` : ''}</div>
          ${c.notes ? `<div style="margin-top:2px">${esc(c.notes)}</div>` : ''}
        </div>
        <button data-delcatch="${i}" class="small">🗑</button>
      </div>`).join('');
  }
  body.querySelector('#manualCatchBtn')?.addEventListener('click', () => addManualCatch());
  body.querySelector('#exportJournalBtn')?.addEventListener('click', exportJournalCsv);
  body.querySelectorAll('[data-delcatch]').forEach(btn => btn.addEventListener('click', async () => {
    getCatches().splice(+btn.dataset.delcatch, 1);
    await saveCatches(); renderJournalOnly(body);
  }));
}

function renderImport(body) {
  body.innerHTML = `
    <div class="grid" style="grid-template-columns:minmax(280px,1fr) minmax(280px,1fr);gap:12px">
      <div class="card" style="margin:0">
        <h3>📥 Import sorter CSV</h3>
        <p class="muted">Supports recovered v2 CSVs from 2023–2025 and the newer v3 2026 CSV.</p>
        <div class="filebox" id="csvDropBox">Drop CSV here or click to choose</div>
        <input id="catchCsvInput" type="file" accept=".csv" multiple class="hidden">
        <label style="display:flex;gap:6px;align-items:center;margin-top:8px"><input type="checkbox" id="importRejectedRows"> include not-fish/rejected rows in queue</label>
        <label style="display:flex;gap:6px;align-items:center;margin-top:4px"><input type="checkbox" id="replaceQueueOnImport"> replace current queue</label>
        <div id="csvImportStatus" class="muted" style="margin-top:8px"></div>
      </div>
      <div class="card" style="margin:0">
        <h3>🖥 Local photo helper</h3>
        <p class="muted">Run the helper server so TrollMap can show large local images from the CSV path column.</p>
        <label>Helper URL</label>
        <input id="catchHelperUrl" value="${esc(localStorage.getItem('trollmapCatchHelperUrl') || DEFAULT_HELPER)}" style="width:100%">
        <div class="row" style="margin-top:8px"><button id="saveHelperUrlBtn" class="small">Save URL</button><button id="testHelperBtn" class="small">Test</button></div>
        <div id="helperStatus" class="muted"></div>
      </div>
    </div>`;
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
      <button id="clearImportedBtn" class="small">Clear imported/approved</button>
      <span class="muted">Total ${counts.total} · Board ${counts.board} · Approved ${counts.approved} · Rejected ${counts.rejected}</span>
    </div>
    <div style="display:grid;grid-template-columns:320px minmax(500px,1fr);gap:12px;align-items:start">
      <div class="card" style="margin:0;max-height:72vh;overflow:auto;padding:8px" id="queueList"></div>
      <div class="card" style="margin:0" id="queueDetail"></div>
    </div>`;
  renderQueueList(body.querySelector('#queueList'), queue);
  renderQueueDetail(body.querySelector('#queueDetail'), selected);
  body.querySelector('#exportQueueBtn')?.addEventListener('click', exportQueueCsv);
  body.querySelector('#reviewPendingBtn')?.addEventListener('click', () => { selectedQueueId = queue.find(q => q.status === 'pending')?.id || selectedQueueId; renderReview(body); });
  body.querySelector('#clearImportedBtn')?.addEventListener('click', async () => {
    setQueue(getQueue().filter(q => !['approved', 'imported'].includes(q.status)));
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
  const flags = q.reviewFlags || [];
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
      <div><h3 style="margin:0 0 4px">${esc(q.filename)}</h3><div class="muted">${esc(q.datetime || '')} · ${esc(q.sourcePath || 'no source path')}</div></div>
      <div class="row"><button id="prevQueueBtn" class="small">←</button><button id="nextQueueBtn" class="small">→</button></div>
    </div>
    ${img ? `<div style="margin:10px 0;background:#050b12;border:1px solid var(--line);border-radius:10px;padding:8px;text-align:center"><img id="reviewPhoto" src="${esc(img)}" style="max-width:100%;max-height:72vh;border-radius:8px;object-fit:contain" onerror="this.insertAdjacentHTML('afterend','<div class=&quot;warnbox&quot;>Image unavailable. Start local helper server or check CSV path.</div>');this.style.display='none';"></div>` : `<div class="warnbox">No photo path in CSV row.</div>`}
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
    </div>
    <div style="margin-top:8px"><label>Notes</label><textarea id="rvNotes" rows="4">${esc(q.ai?.notes || '')}</textarea></div>
    <div class="muted" style="margin-top:6px">AI species: ${esc(q.ai?.species || '')}${q.ai?.inferredSpecies && q.ai.inferredSpecies !== q.ai.species ? ` → ${esc(q.ai.inferredSpecies)}` : ''} · Model: ${esc(q.ai?.model || '')} · Flags: ${esc(flags.join(', ') || 'none')}</div>
    <div class="row" style="margin-top:10px">
      <button id="saveQueueEditsBtn" class="small">💾 Save edits</button>
      <button id="approveCatchBtn" class="primary small">✅ Approve to Journal</button>
      <button id="rejectCatchBtn" class="warn small">🚫 Reject</button>
      <button id="markPendingBtn" class="small">↩ Pending</button>
    </div>`;
  el.querySelector('#saveQueueEditsBtn')?.addEventListener('click', async () => { applyDetailEdits(q); await saveQueue(); renderCatchSubtab(); });
  el.querySelector('#approveCatchBtn')?.addEventListener('click', async () => { applyDetailEdits(q); await approveQueueItem(q); moveNext(); renderCatchSubtab(); });
  el.querySelector('#rejectCatchBtn')?.addEventListener('click', async () => { q.status = 'rejected'; q.updatedAt = new Date().toISOString(); await saveQueue(); moveNext(); renderCatchSubtab(); });
  el.querySelector('#markPendingBtn')?.addEventListener('click', async () => { q.status = 'pending'; q.updatedAt = new Date().toISOString(); await saveQueue(); renderCatchSubtab(); });
  el.querySelector('#prevQueueBtn')?.addEventListener('click', () => { moveRelative(-1); renderCatchSubtab(); });
  el.querySelector('#nextQueueBtn')?.addEventListener('click', () => { moveRelative(1); renderCatchSubtab(); });
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
    lure: '', lead: '',
    time: displayTime(q.time),
    date: q.date || '',
    lake: q.lake || '',
    lat: q.lat || '', lon: q.lon || '',
    notes: q.ai?.notes || '',
    weather: null,
    structure: null,
    sourceFile,
    sourcePath: q.sourcePath || '',
    importedFrom: q.importedFrom || 'review-queue',
    verification: {
      reviewed: true,
      species: q.verified.species ? 'human-reviewed' : 'ai',
      length: q.verified.length ? 'human-visual' : 'ai-unverified',
      onBoard: q.verified.onBoard,
      sourceModel: q.ai?.model || '',
      approvedAt: new Date().toISOString()
    }
  };
  if (existingIx >= 0) catches[existingIx] = entry; else catches.unshift(entry);
  q.status = 'imported'; q.updatedAt = new Date().toISOString();
  await saveCatches(); await saveQueue();
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
  const replace = document.getElementById('replaceQueueOnImport')?.checked;
  if (replace) setQueue([]);
  let added = 0, skipped = 0;
  for (const file of files) {
    const text = await file.text();
    const rows = parseCsv(text);
    for (const row of rows) {
      const item = normalizeCsvRow(row, file.name);
      if (!includeRejected && !item.verified.hasFish) { skipped++; continue; }
      if (getQueue().some(q => q.id === item.id)) { skipped++; continue; }
      getQueue().push(item); added++;
    }
  }
  await saveQueue();
  if (status) status.textContent = `Imported ${added} queue items${skipped ? ` · skipped ${skipped}` : ''}.`;
  currentSubtab = 'review'; selectedQueueId = getQueue().find(q => q.status === 'pending')?.id || getQueue()[0]?.id || null;
  setTimeout(renderCatchCenter, 700);
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
    sha256: q.sha256 || '', source_path: q.sourcePath || '', imported_from: q.importedFrom || ''
  }));
  downloadCsv('trollmap_catch_review_queue_cleaned.csv', rows);
}
function exportJournalCsv() {
  const rows = getCatches().map(c => ({
    species: c.species, length: c.length, date: c.date, time: c.time, lake: c.lake, depth: c.depth,
    lat: c.lat, lon: c.lon, lure: c.lure, lead: c.lead, notes: c.notes,
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
function wireButtons() {
  renderCatchCenter();
}

wireButtons();
