/**
 * Top-bar File I/O — Load / New / Save GPX.
 *
 * Load: opens a file picker for .gpx/.txt/.xml/.geojson/.json/.kml,
 *        parses it via parsers.js, replaces state.DATA.
 * New:  resets state.DATA to empty.
 * Save: triggers a download of state.DATA serialized by buildGPX() in parsers.js --
 *       the only GPX writer in the app. It emits the Garmin gpxx extensions, so this
 *       one file is what ActiveCaptain and the Echomap read.
 */

import { state } from '../core/state.js';
import { parseGPX, parseKML, kmlToGeoJSON, buildGPX, geoJSONToLines } from '../utils/parsers.js';
import { admFile, cueBoundaries } from '../utils/adm.js';
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

  // Save ADM -- the plan's cue lines as boundaries, for the card. His unit imports boundaries
  // only from an .adm, and ActiveCaptain carries a GPX but not an ADM, so this one goes on the
  // card: Where To > Menu > Manage User Data > Data Transfer > File Type ADM > Merge from Card.
  // Named for the plan's day, TMmmdd.ADM, short and plain so the unit's file list shows it whole.
  document.getElementById('saveAdmBtn')?.addEventListener('click', () => {
    const boundaries = cueBoundaries(state.DATA && state.DATA.routes);
    if (!boundaries.length) {
      alert('No plan cue lines to write. Build a plan, or load one saved since 2026-09-28 '
        + '(older saved plans did not keep their cue lines); the ADM holds them as boundaries.');
      return;
    }
    const day = (window._planV2 && window._planV2.meta && window._planV2.meta.date) || '';
    const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(day);
    const now = new Date();
    const mmdd = m ? `${m[1]}${m[2]}`
      : `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const blob = new Blob([admFile(boundaries, { when: now })], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `TM${mmdd}.ADM`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

wireButtons();
