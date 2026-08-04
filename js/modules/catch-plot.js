/**
 * Plot Catches on Map — toggle catch markers on the map. Markers
 * are styled differently for "trophy" catches (≥30 inches).
 */

import { state } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { registerLayer, wireButton } from '../core/layer-registry.js';

// Catch markers are derived from state.CATCHES, which grows as you log fish, so this is a
// `rebuild: true` layer -- it re-derives on every show instead of caching the first draw.
let _mapped = 0;

registerLayer({
  id: 'catches',
  button: 'btnShowCatches',
  rebuild: true,
  enabled: () => !!state.MAP_OK,
  activeBg: 'var(--accent2)',
  activeColor: '#062d00',
  label: (on) => (on ? `\u{1F41F} Hide (${_mapped})` : '\u{1F41F} Catches'),
  build: () => {
    const CATCH_LAYER = L.layerGroup();
    let mapped = 0;
      state.CATCHES.forEach((c) => {
      const lat = parseFloat(c.lat), lon = parseFloat(c.lon);
      if (isNaN(lat) || isNaN(lon) || !lat || !lon) return;
      const isTrophy = c.length && parseFloat(c.length) >= 30;
      const ico = isTrophy ? '🏆' : '🐟';
      const bg  = isTrophy ? '#b06a00' : '#007a8a';
      const bdr = isTrophy ? '#ffb703' : '#00e5ff';

      const marker = L.marker([lat, lon], {
        icon: L.divIcon({
          className: '',
          html: `<div style="background:${bg};color:#fff;font-size:12px;font-weight:700;font-family:system-ui,sans-serif;padding:3px 7px;border-radius:6px;border:2px solid ${bdr};white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.6);cursor:pointer">${ico} ${esc(c.species || 'Fish')} ${c.length ? c.length + '"' : ''}</div>`,
          iconAnchor: [12, 12],
        }),
      });
      marker.bindPopup(`
        <b style="font-size:15px;color:#0d4f8b">${ico} ${esc(c.species || 'Fish')} ${c.length ? c.length + '"' : ''}</b><br>
        <b>Lure:</b> ${esc(c.lure || '—')}<br>
        <b>Depth:</b> ${esc(c.depth || '—')} ft · <b>Lead:</b> ${esc(c.lead || '—')} ft<br>
        <b>Time:</b> ${esc(c.time || '—')} · ${esc(c.date || '—')}<br>
        <div style="background:#f0f4f8;padding:6px;border-radius:4px;margin-top:6px;font-size:12px">${esc(c.notes || 'No notes.')}</div>
      `);
      CATCH_LAYER.addLayer(marker);
      mapped++;
    });

    _mapped = mapped;
    if (!mapped) {
      alert('No catches with GPS coordinates yet.\nMake sure GPS is active when logging catches.');
      return null;
    }
    return CATCH_LAYER;
  },
  // Framing the map on the catches and jumping to the map tab are things that happen when
  // the layer GOES ON, not part of drawing it.
  onShow: () => {
    state.MAP.fitBounds(
      state.CATCHES
        .filter((c) => parseFloat(c.lat) && parseFloat(c.lon))
        .map((c) => [parseFloat(c.lat), parseFloat(c.lon)]),
      { padding: [40, 40] },
    );
    document.querySelector('#bottomNav button[data-tab="map"]')?.click();
  },
});

wireButton('catches');
