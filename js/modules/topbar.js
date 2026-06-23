/**
 * Topbar dropdown controls — basemap selector, Fit-to-bounds button,
 * and edit-mode dropdown (view/add/delete).
 */

import { setBase, fitMap, renderMap } from '../core/map-init.js';

function wireButtons() {
  document.getElementById('basemap')?.addEventListener('change', (e) => {
    setBase(e.target.value);
  });

  document.getElementById('fitBtn')?.addEventListener('click', () => {
    fitMap();
  });

  // Edit mode dropdown — re-render the map so waypoint markers
  // reflect the new mode (drag handles in 'view', click-to-delete
  // in 'delete', and nothing in 'add' since that's handled in onMapClick).
  document.getElementById('editMode')?.addEventListener('change', () => {
    renderMap();
  });
}

wireButtons();
