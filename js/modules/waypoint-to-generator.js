/**
 * One-Click Waypoint → Lane Connect — clicking a waypoint popup
 * button sends its lat/lng to the Generate tab's start or end
 * input. Used by the ramp markers and catch markers.
 */

window.sendWptToGenerator = function sendWptToGenerator(lat, lon, target) {
  if (target === 'start') {
    const latIn = document.getElementById('gLat1');
    const lonIn = document.getElementById('gLon1');
    if (latIn) latIn.value = lat.toFixed(5);
    if (lonIn) lonIn.value = lon.toFixed(5);
  } else {
    const latIn = document.getElementById('gLat2');
    const lonIn = document.getElementById('gLon2');
    if (latIn) latIn.value = lat.toFixed(5);
    if (lonIn) lonIn.value = lon.toFixed(5);
  }

  // Close any open popup on the map
  const map = window.MAP;
  if (map) map.closePopup();

  // Switch to the Generate tab
  document.querySelector('#bottomNav button[data-tab="generate"]')?.click();

  // Flash the input to confirm
  const elLat = document.getElementById(target === 'start' ? 'gLat1' : 'gLat2');
  const elLon = document.getElementById(target === 'start' ? 'gLon1' : 'gLon2');
  if (elLat) { elLat.style.borderColor = 'var(--accent2)'; setTimeout(() => elLat.style.borderColor = '', 1200); }
  if (elLon) { elLon.style.borderColor = 'var(--accent2)'; setTimeout(() => elLon.style.borderColor = '', 1200); }
};
