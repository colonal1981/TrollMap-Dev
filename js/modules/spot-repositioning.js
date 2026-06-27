/**
 * Spot Repositioning — drag a marker (GIS spot, ramp, attractor)
 * to its real-world coordinates. The marker must be actively open
 * in a popup for this to work; the helper looks it up via
 * `_isActivelyOpen` (set on popupopen by chart-import.js).
 */

import { state } from '../core/state.js';
import { setBanner } from '../core/map-init.js';

window.enableSpotRepositioning = function enableSpotRepositioning(btnEl, spotName) {
  if (!state.MAP_OK) return;

  // Find the exact Leaflet marker layer that is currently open
  let targetMarker = null;
  state.LAYER?.eachLayer((l) => { if (l._isActivelyOpen) targetMarker = l; });
  if (!targetMarker) {
    // Search the saved contour layers too
    Object.values(state.CHARTS || {}).forEach((Lyr) => {
      Lyr.layer?.eachLayer?.((m) => { if (m._isActivelyOpen) targetMarker = m; });
    });
  }

  if (targetMarker && targetMarker.dragging) {
    targetMarker.dragging.enable();
    state.MAP.closePopup();
    setBanner(`✥ Spot Nudge Mode: Physically DRAG the marker for "${spotName}" exactly from the land to your actual water ramp or structure spot and DROP IT to save forever!`);
    document.getElementById('map').style.cursor = 'grab';
  } else {
    alert('Drag controller initialized. Close this popup, click the Spot icon directly, and drag it to your exact target coordinates.');
  }
};
