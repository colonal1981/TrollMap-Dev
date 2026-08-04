/**
 * Casting Rings — draws a 60ft dashed cyan circle around every
 * waypoint so the user can see exactly where they need to put
 * their lure on the first pass. Non-interactive (no click events).
 */

import { state } from '../core/state.js';
import { registerLayer, wireButton } from '../core/layer-registry.js';

// Rings are derived from state.DATA.waypoints, so they are rebuilt on every show rather
// than cached -- `rebuild: true`. Caching drew the previous GPX's waypoints after loading a
// new one.
let _drawn = 0;

registerLayer({
  id: 'castingRings',
  button: 'btnCastingRings',
  rebuild: true,
  enabled: () => !!state.MAP_OK,
  label: (on) => (on ? `\u2B55 Hide Rings (${_drawn})` : '\u2B55 Casting Rings'),
  build: () => {
    const group = L.layerGroup();
    _drawn = 0;
    state.DATA.waypoints.forEach((w) => {
      const lat = parseFloat(w.lat), lon = parseFloat(w.lon);
      if (isNaN(lat) || isNaN(lon) || !lat || !lon) return;
      group.addLayer(L.circle([lat, lon], {
        radius: 18.288,  // 60ft in meters
        color: '#00e5ff',
        weight: 2,
        dashArray: '6, 6',
        fillColor: '#00e5ff',
        fillOpacity: 0.08,
        interactive: false,
      }));
      _drawn++;
    });
    if (!_drawn) {
      alert('No waypoints loaded to draw casting rings around.\nLoad a GPX file or drop waypoints first.');
      return null;    // registry leaves the button off rather than lighting it over nothing
    }
    return group;
  },
});

wireButton('castingRings');
