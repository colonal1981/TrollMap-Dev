/**
 * Top-bar File I/O — Load / New / Save GPX.
 *
 * Load: opens a file picker for .gpx/.txt/.xml/.geojson/.json/.kml,
 *        parses it via parsers.js, replaces state.DATA.
 * New:  resets state.DATA to empty.
 * Save: triggers a download of state.DATA serialized as a standard
 *       GPX file (not the Garmin-flavored variant — see garmin-export).
 */

import { state } from '../core/state.js';
import { parseGPX, parseKML, kmlToGeoJSON, buildGPX, geoJSONToLines } from '../utils/parsers.js';
import { setFilename, getFilename, renderAll } from '../core/map-init.js';

/**
 * Update the toolbar label and store the loaded filename. Called
 * after every Load / New so the rest of the UI can show context.
 */
function afterLoad(name) {
  setFilename(name.replace(/\.txt$/, ''));
  const fl = document.getElementById('fileLabel');
  if (fl) fl.textContent = `${name} — ${state.DATA.waypoints.length} wpts, ${state.DATA.tracks.length} tracks`;
  renderAll();
}

/**
 * Parse a loaded file by extension. KML and GeoJSON get converted
 * to internal line format; GPX is parsed directly.
 */
async function parseLoadedFile(file) {
  const text = await file.text();
  if (file.name.match(/\.kml$/i)) {
    const features = parseKML(text);
    const geo = kmlToGeoJSON(features);
    const lines = geoJSONToLines(geo);
    return {
      waypoints: [],
      tracks: lines.map((l, i) => ({ name: `KML_${i + 1}`, pts: l.coords })),
    };
  }
  if (file.name.match(/\.(geo)?json$/i)) {
    const geo = JSON.parse(text);
    const lines = geoJSONToLines(geo);
    return {
      waypoints: [],
      tracks: lines.map((l, i) => ({ name: `GeoJSON_${i + 1}`, pts: l.coords })),
    };
  }
  // GPX / .txt / .xml
  return parseGPX(text);
}

function wireButtons() {
  // Load — pick a file, parse it, replace DATA
  document.getElementById('fileInput')?.addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      state.DATA = await parseLoadedFile(f);
      afterLoad(f.name);
    } catch (err) {
      alert('Error: ' + err.message);
    }
  });

  // New — clear DATA
  document.getElementById('newBtn')?.addEventListener('click', () => {
    state.DATA = { waypoints: [], tracks: [] };
    afterLoad('new.gpx');
  });

  // Save — download DATA as standard GPX
  document.getElementById('saveBtn')?.addEventListener('click', () => {
    const gpx = buildGPX(state.DATA);
    const blob = new Blob([gpx], { type: 'application/gpx+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const fname = getFilename().endsWith('.gpx') ? getFilename() : getFilename() + '.gpx';
    a.download = fname;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

wireButtons();
