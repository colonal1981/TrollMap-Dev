/**
 * GPS tracking — current location marker, follow mode, and recorded
 * track that becomes a DATA.tracks entry on stop.
 *
 * Wired to the three GPS toolbar buttons (📍 / 🔒 / ⏺) via
 * wireGpsButtons(), which is called automatically on module load.
 */

import { state } from '../core/state.js';

/**
 * Start watching the device's GPS position. Idempotent: if already
 * watching, this is a no-op. Each fix updates GPS_MARKER, pans the
 * map if FOLLOW_GPS is true, and (if recording) appends to GPS_TRACK
 * and grows GPS_LINE.
 */
export function startGPS() {
  if (!navigator.geolocation) {
    alert('No GPS on this device');
    return;
  }
  state.GPS_WATCH = navigator.geolocation.watchPosition(
    (pos) => {
      const ll = [pos.coords.latitude, pos.coords.longitude];

      if (!state.GPS_MARKER) {
        state.GPS_MARKER = L.circleMarker(ll, {
          radius: 8,
          color: '#00e5ff',
          fillColor: '#00e5ff',
          fillOpacity: 0.8,
          weight: 2,
        }).addTo(state.MAP).bindTooltip('You');
      } else {
        state.GPS_MARKER.setLatLng(ll);
      }

      if (state.FOLLOW_GPS) state.MAP.panTo(ll);

      if (state.RECORDING) {
        state.GPS_TRACK.push(ll);
        if (!state.GPS_LINE) {
          state.GPS_LINE = L.polyline(state.GPS_TRACK, { color: '#00e5ff', weight: 3 }).addTo(state.MAP);
        } else {
          state.GPS_LINE.setLatLngs(state.GPS_TRACK);
        }
      }
    },
    (err) => { console.warn('GPS error', err); },
    { enableHighAccuracy: true, maximumAge: 10000 },
  );
}

/** Stop the GPS watch and clear the watch ID. Keeps the marker on the map. */
export function stopGPS() {
  if (state.GPS_WATCH) {
    navigator.geolocation.clearWatch(state.GPS_WATCH);
    state.GPS_WATCH = null;
  }
}

/**
 * Wire the three GPS buttons in the top-left floating toolbar.
 * Runs once on module load. Safe to call before MAP is initialized —
 * the handlers check MAP_OK before doing anything.
 */
export function wireGpsButtons() {
  // 📍 — center on GPS: start watch if not running, otherwise pan to last fix
  document.getElementById('btnGps')?.addEventListener('click', () => {
    if (!state.GPS_WATCH) startGPS();
    else if (state.GPS_MARKER) state.MAP?.panTo(state.GPS_MARKER.getLatLng());
  });

  // 🔒/🔓 — toggle follow mode
  document.getElementById('btnFollow')?.addEventListener('click', (e) => {
    state.FOLLOW_GPS = !state.FOLLOW_GPS;
    e.target.textContent = state.FOLLOW_GPS ? '🔓 Follow' : '🔒 Follow';
    e.target.style.background = state.FOLLOW_GPS ? 'var(--accent)' : 'var(--panel2)';
  });

  // ⏺/⏹ — toggle recording. On stop, commit GPS_TRACK to DATA.tracks.
  document.getElementById('recordBtn')?.addEventListener('click', (e) => {
    state.RECORDING = !state.RECORDING;
    e.target.classList.toggle('recording', state.RECORDING);
    e.target.textContent = state.RECORDING ? '⏹ Stop' : '⏺ Rec';

    // Auto-start GPS when beginning recording.
    if (state.RECORDING && !state.GPS_WATCH) startGPS();

    // Commit the recorded track on stop.
    if (!state.RECORDING && state.GPS_TRACK.length > 1) {
      const name = 'GPS_' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      state.DATA.tracks.push({ name, pts: state.GPS_TRACK.slice() });
      state.GPS_TRACK = [];
      if (state.GPS_LINE) {
        state.MAP.removeLayer(state.GPS_LINE);
        state.GPS_LINE = null;
      }
      try { window.renderAll?.(); } catch (_) {}
    }
  });
}

wireGpsButtons();
