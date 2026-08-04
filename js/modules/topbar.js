/**
 * Topbar dropdown controls — basemap selector, edit-mode dropdown,
 * and Jump/Search modal.
 */

import { setBase, fitMap, renderMap } from '../core/map-init.js';
import { searchWaters, selectWater, invalidateWaterIndex } from './water-search.js';
import { state } from '../core/state.js';
import { pushAllLocalToCloud, pullUpdatesOnLoad } from './cloud-sync.js';

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

  document.getElementById('pushCloudBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('pushCloudBtn');
    btn.textContent = '☁️ Pushing...';
    btn.disabled = true;
    try { await pushAllLocalToCloud(); btn.textContent = '✅ Pushed'; }
    catch (err) {
      // The button says ❌ and nothing else. That is enough to know it broke and useless for
      // knowing why, and this one moves the user's data.
      console.error('[topbar] cloud push failed:', err);
      btn.textContent = '❌ Failed';
    }
    setTimeout(() => { btn.textContent = '☁️ Push'; btn.disabled = false; }, 3000);
  });

  document.getElementById('pullCloudBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('pullCloudBtn');
    btn.textContent = '⬇️ Pulling...';
    btn.disabled = true;
    try { await pullUpdatesOnLoad(); btn.textContent = '✅ Pulled'; }
    catch (err) {
      console.error('[topbar] cloud pull failed:', err);
      btn.textContent = '❌ Failed';
    }
    setTimeout(() => { btn.textContent = '⬇️ Pull'; btn.disabled = false; }, 3000);
  });

  document.getElementById('topSearchBtn')?.addEventListener('click', openModal);
  document.getElementById('mapSearchBtn')?.addEventListener('click', openModal);
  document.getElementById('searchClose')?.addEventListener('click', closeModal);

  // Close on backdrop click
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  // The "Murray quick picks" dropdown was nine hardcoded <option> tags of Lake Murray
  // coordinates in index.html, under a label that said so. Built to jump around one lake
  // during testing and never generalised. Removed 2026-08-04 -- the search below now covers
  // every water, zone, coastal pointer and ramp the app knows, which is what a quick-pick
  // list was standing in for.

  // OSM search
  document.getElementById('searchGo')?.addEventListener('click', async () => {
    const q = document.getElementById('searchInput')?.value?.trim();
    if (!q) return;
    const resultsEl = document.getElementById('searchResults');

    // OUR data first. The registry, the zones, the 158 coastal pointers and every ramp are
    // already in memory; asking a global geocoder about water this app owns was the bug.
    invalidateWaterIndex();
    const local = searchWaters(q);
    if (local.length && resultsEl) {
      const ICON = { water: 'W', zone: 'Z', pointer: '>', ramp: 'R' };
      resultsEl.innerHTML = local.map((e, i) =>
        `<div data-local="${i}" style="padding:5px 0;cursor:pointer;border-bottom:1px solid var(--line);font-size:12px;color:var(--text)">`
        + `<span style="color:var(--muted)">${ICON[e.kind] || '-'}</span> ${e.label}`
        + (e.sublabel ? `<span style="color:var(--muted);font-size:11px"> &mdash; ${e.sublabel}</span>` : '')
        + `</div>`).join('');
      resultsEl.querySelectorAll('[data-local]').forEach((el) => {
        el.addEventListener('click', () => {
          selectWater(local[Number(el.dataset.local)]);
          closeModal();
        });
      });
      return;
    }

    // Only now, and labelled, so a place that is not water stays reachable without the result
    // pretending to be one of your lakes.
    if (resultsEl) resultsEl.innerHTML = 'No match in TrollMap &mdash; searching places...';
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=5`);
      const data = await r.json();
      if (!data.length) {
        if (resultsEl) resultsEl.innerHTML = '<div style="color:var(--muted);font-size:11px">No results found</div>';
        return;
      }
      if (resultsEl) {
        resultsEl.innerHTML = '<div style="color:var(--muted);font-size:11px;padding-bottom:4px">Places (OpenStreetMap) &mdash; moves the map, does not select a water</div>'
          + data.map((d, i) =>
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
      // Nominatim rate-limits aggressively and this is now the FALLBACK, so a failure means
      // "the place lookup broke", not "search is broken".
      console.warn(`[topbar] place fallback failed:`, e && e.message);
      if (resultsEl) resultsEl.innerHTML = '<div style="color:var(--bad);font-size:11px">No TrollMap match, and the place lookup failed</div>';
    }
  });

  // Enter key triggers search
  document.getElementById('searchInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('searchGo')?.click();
  });

  // Jump to coordinates — accepts "34.377, -80.731" or "34.377 -80.731" or DMS
  document.getElementById('coordGo')?.addEventListener('click', () => {
    const raw = document.getElementById('coordInput')?.value?.trim();
    if (!raw || !state.MAP) return;
    // Split on comma or whitespace, but keep negative signs attached to numbers
    const parts = raw.split(/[,\s]+/).filter(Boolean);
    if (parts.length >= 2) {
      const lat = parseFloat(parts[0]);
      const lon = parseFloat(parts[1]);
      if (!isNaN(lat) && !isNaN(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        state.MAP.setView([lat, lon], 16);
        closeModal();
      } else {
        const coordEl = document.getElementById('coordInput');
        if (coordEl) coordEl.style.borderColor = 'var(--bad)';
        setTimeout(() => { if (coordEl) coordEl.style.borderColor = ''; }, 2000);
      }
    }
  });

  document.getElementById('coordInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('coordGo')?.click();
  });
}

wireButtons();
