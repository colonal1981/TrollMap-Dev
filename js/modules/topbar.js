/**
 * Topbar dropdown controls — basemap selector, edit-mode dropdown,
 * and Jump/Search modal.
 */

import { setBase, fitMap, renderMap } from '../core/map-init.js';
import { state } from '../core/state.js';

function wireButtons() {
  document.getElementById('basemap')?.addEventListener('change', (e) => {
    setBase(e.target.value);
  });

  document.getElementById('fitBtn')?.addEventListener('click', () => {
    fitMap();
  });

  document.getElementById('editMode')?.addEventListener('change', () => {
    renderMap();
  });

  // ── Jump / Search modal ──────────────────────────────────────────────

  const modal = document.getElementById('searchModal');

  function openModal() {
    if (modal) modal.classList.add('open');
  }
  function closeModal() {
    if (modal) modal.classList.remove('open');
  }

  document.getElementById('topSearchBtn')?.addEventListener('click', openModal);
  document.getElementById('mapSearchBtn')?.addEventListener('click', openModal);
  document.getElementById('searchClose')?.addEventListener('click', closeModal);

  // Close on backdrop click
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  // Quick pick dropdown — jump to preset location
  document.getElementById('quickPick')?.addEventListener('change', (e) => {
    const val = e.target.value;
    if (!val || !state.MAP) return;
    const parts = val.split(',');
    if (parts.length >= 2) {
      const lat = parseFloat(parts[0]);
      const lon = parseFloat(parts[1]);
      const zoom = parts[2] ? parseInt(parts[2]) : 14;
      state.MAP.setView([lat, lon], zoom);
      closeModal();
    }
    e.target.value = '';
  });

  // OSM search
  document.getElementById('searchGo')?.addEventListener('click', async () => {
    const q = document.getElementById('searchInput')?.value?.trim();
    if (!q) return;
    const resultsEl = document.getElementById('searchResults');
    if (resultsEl) resultsEl.innerHTML = 'Searching…';
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=5`);
      const data = await r.json();
      if (!data.length) {
        if (resultsEl) resultsEl.innerHTML = '<div style="color:var(--muted);font-size:11px">No results found</div>';
        return;
      }
      if (resultsEl) {
        resultsEl.innerHTML = data.map((d, i) =>
          `<div data-idx="${i}" style="padding:4px 0;cursor:pointer;border-bottom:1px solid var(--line);font-size:12px;color:var(--text)" data-lat="${d.lat}" data-lon="${d.lon}">${d.display_name}</div>`
        ).join('');
        resultsEl.querySelectorAll('[data-lat]').forEach(el => {
          el.addEventListener('click', () => {
            state.MAP?.setView([parseFloat(el.dataset.lat), parseFloat(el.dataset.lon)], 14);
            closeModal();
          });
        });
      }
    } catch (e) {
      if (resultsEl) resultsEl.innerHTML = '<div style="color:var(--bad);font-size:11px">Search failed</div>';
    }
  });

  // Enter key triggers search
  document.getElementById('searchInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('searchGo')?.click();
  });

  // Jump to coordinates
  document.getElementById('coordGo')?.addEventListener('click', () => {
    const raw = document.getElementById('coordInput')?.value?.trim();
    if (!raw || !state.MAP) return;
    const parts = raw.split(/[\s,]+/);
    if (parts.length >= 2) {
      const lat = parseFloat(parts[0]);
      const lon = parseFloat(parts[1]);
      if (!isNaN(lat) && !isNaN(lon)) {
        state.MAP.setView([lat, lon], 16);
        closeModal();
      }
    }
  });

  document.getElementById('coordInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('coordGo')?.click();
  });
}

wireButtons();
