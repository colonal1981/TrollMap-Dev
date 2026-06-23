/**
 * Casting Rings — draws a 60ft dashed cyan circle around every
 * waypoint so the user can see exactly where they need to put
 * their lure on the first pass. Non-interactive (no click events).
 */

import { state } from '../core/state.js';

let ringsActive = false;
let ringsLayer = null;

const btn = document.getElementById('btnCastingRings');

if (btn) {
  btn.addEventListener('click', () => {
    if (!state.MAP_OK) return;
    if (!ringsLayer) ringsLayer = L.layerGroup();

    if (ringsActive) {
      state.MAP.removeLayer(ringsLayer);
      ringsActive = false;
      btn.style.background = '';
      btn.style.color = '';
      btn.textContent = '⭕ Casting Rings';
      return;
    }

    ringsLayer.clearLayers();
    let drawn = 0;

    state.DATA.waypoints.forEach((w) => {
      const lat = parseFloat(w.lat), lon = parseFloat(w.lon);
      if (isNaN(lat) || isNaN(lon) || !lat || !lon) return;

      const circle = L.circle([lat, lon], {
        radius: 18.288,  // 60ft in meters
        color: '#00e5ff',
        weight: 2,
        dashArray: '6, 6',
        fillColor: '#00e5ff',
        fillOpacity: 0.08,
        interactive: false,
      });
      ringsLayer.addLayer(circle);
      drawn++;
    });

    if (!drawn) {
      alert('No waypoints loaded to draw casting rings around.\nLoad a GPX file or drop waypoints first.');
      return;
    }

    ringsLayer.addTo(state.MAP);
    ringsActive = true;
    btn.style.background = 'var(--accent)';
    btn.style.color = '#000';
    btn.textContent = `⭕ Hide Rings (${drawn})`;
  });
}
