/**
 * notifications.js — On-water alerts for TrollMap
 *
 * Fires browser notifications that forward to Garmin ECHOMAP via
 * ActiveCaptain Bluetooth pairing (same channel as SMS/phone alerts).
 *
 * Triggers:
 *  - Solunar major/minor windows (15 min heads-up)
 *  - Smart Plan band change (transition time approaching)
 *  - Trip return time (30 min warning)
 *  - QuickDraw pin proximity (structure nearby)
 *  - Supplemental fishing spot proximity
 *  - Wind threshold crossed
 *
 * All timers and watchers are cleared when notifications are disabled
 * or the session ends. Nothing runs in the background after the page
 * is closed.
 */

import { state } from '../core/state.js';

// ── Config ────────────────────────────────────────────────────────────────────
const PROXIMITY_RADIUS_FT = 300;   // fire when within 300ft of a pin
const PROXIMITY_CHECK_MS  = 15000; // check position every 15 seconds
const SOLUNAR_WARN_MIN    = 15;    // notify 15 min before major/minor
const RETURN_WARN_MIN     = 30;    // notify 30 min before return time
const WIND_THRESHOLD_MPH  = 15;    // alert when wind crosses this value

// ── State ─────────────────────────────────────────────────────────────────────
let _enabled = false;
let _session = {
  solunarMajors: [],    // [{ h: 7.55, fired: false }, ...]
  solunarMinors: [],
  bandChangeTimes: [],  // [{ h: 9.0, label: 'Band 2', fired: false }]
  returnTimeH: null,
  returnFired: false,
  windFired: false,
  lastWindMph: 0,
};
let _proximityWatcher = null;
let _tickInterval = null;
let _firedPins = new Set(); // pin IDs already notified this session

// ── Permission ────────────────────────────────────────────────────────────────
export async function requestNotificationPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  const result = await Notification.requestPermission();
  return result === 'granted';
}

// ── Core fire function ────────────────────────────────────────────────────────
function fire(title, body, tag = null) {
  if (!_enabled) return;
  if (Notification.permission !== 'granted') return;
  try {
    const opts = { body, icon: './icons/icon-192.png', silent: false };
    if (tag) opts.tag = tag;
    const n = new Notification(title, opts);
    // Auto-close after 8 seconds
    setTimeout(() => n.close(), 8000);
  } catch (e) {
    console.warn('[notifications] fire failed:', e.message);
  }
}

// ── Time helpers ──────────────────────────────────────────────────────────────
function nowH() {
  const d = new Date();
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
}

function hToStr(h) {
  const hh = Math.floor(h % 24);
  const mm  = Math.round((h % 1) * 60);
  const ap  = hh >= 12 ? 'PM' : 'AM';
  return `${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${ap}`;
}

function distFt(lat1, lon1, lat2, lon2) {
  const R = 3958.8 * 5280; // feet
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Tick — runs every 30 seconds while session is active ─────────────────────
function tick() {
  const now = nowH();
  const warnH = SOLUNAR_WARN_MIN / 60;

  // Solunar majors
  for (const m of _session.solunarMajors) {
    if (!m.fired && now >= m.h - warnH && now < m.h) {
      m.fired = true;
      fire('🌕 Solunar Major Starting', `Peak bite window at ${hToStr(m.h)} — be on fish.`, 'solunar-major');
    }
  }

  // Solunar minors
  for (const m of _session.solunarMinors) {
    if (!m.fired && now >= m.h - warnH && now < m.h) {
      m.fired = true;
      fire('🌙 Solunar Minor', `Secondary bite window at ${hToStr(m.h)}.`, 'solunar-minor');
    }
  }

  // Band change
  for (const b of _session.bandChangeTimes) {
    if (!b.fired && now >= b.h - (10 / 60) && now < b.h) {
      b.fired = true;
      fire('🎣 Band Change', `Switch to ${b.label} in ~10 minutes.`, 'band-change');
    }
  }

  // Return time warning
  if (_session.returnTimeH && !_session.returnFired) {
    const warnReturnH = RETURN_WARN_MIN / 60;
    if (now >= _session.returnTimeH - warnReturnH && now < _session.returnTimeH) {
      _session.returnFired = true;
      fire('⏱ Head Back Soon', `Return time is ${hToStr(_session.returnTimeH)} — ${RETURN_WARN_MIN} min remaining.`, 'return-time');
    }
  }
}

// ── Proximity watcher ─────────────────────────────────────────────────────────
function startProximityWatch() {
  if (_proximityWatcher) return;
  if (!navigator.geolocation) return;

  _proximityWatcher = setInterval(() => {
    navigator.geolocation.getCurrentPosition(pos => {
      const { latitude: lat, longitude: lon } = pos.coords;
      checkProximity(lat, lon);
    }, null, { enableHighAccuracy: true, timeout: 5000 });
  }, PROXIMITY_CHECK_MS);
}

function stopProximityWatch() {
  if (_proximityWatcher) {
    clearInterval(_proximityWatcher);
    _proximityWatcher = null;
  }
}

function checkProximity(lat, lon) {
  // QuickDraw pins
  const pins = window.getMyStructures?.() || [];
  for (const pin of pins) {
    const pLat = pin.lat ?? pin.geometry?.coordinates?.[1];
    const pLon = pin.lon ?? pin.geometry?.coordinates?.[0];
    if (!pLat || !pLon) continue;
    const id = pin.id || `${pLat.toFixed(5)},${pLon.toFixed(5)}`;
    if (_firedPins.has(id)) continue;
    const ft = distFt(lat, lon, pLat, pLon);
    if (ft <= PROXIMITY_RADIUS_FT) {
      _firedPins.add(id);
      const type = pin.type || pin.properties?.type || 'Structure';
      const name = pin.name || pin.properties?.name || type;
      fire(`📍 ${name} Ahead`, `${Math.round(ft)}ft — ${type.replace(/_/g, ' ')}`, `pin-${id}`);
    }
  }

  // Supplemental fishing spots
  if (window.getSupplementalContext) {
    try {
      const ctx = window.getSupplementalContext(lat, lon, 0.1); // 0.1 mi = ~530ft
      for (const spot of (ctx.fishingPoints || [])) {
        const id = `spot-${spot.lat?.toFixed(5)},${spot.lon?.toFixed(5)}`;
        if (_firedPins.has(id)) continue;
        const ft = distFt(lat, lon, spot.lat, spot.lon);
        if (ft <= PROXIMITY_RADIUS_FT) {
          _firedPins.add(id);
          fire('🎣 Fishing Spot Nearby', `Community spot ${Math.round(ft)}ft ahead.`, id);
        }
      }
      for (const att of (ctx.attractors || [])) {
        const id = `att-${att.lat?.toFixed(5)},${att.lon?.toFixed(5)}`;
        if (_firedPins.has(id)) continue;
        const ft = distFt(lat, lon, att.lat, att.lon);
        if (ft <= PROXIMITY_RADIUS_FT) {
          _firedPins.add(id);
          const name = att.name || 'Fish Attractor';
          fire(`🪵 ${name}`, `${Math.round(ft)}ft ahead.`, id);
        }
      }
    } catch (_) {}
  }
}

// ── Wind alert (called externally when weather updates) ───────────────────────
export function checkWindAlert(windMph) {
  if (!_enabled) return;
  _session.lastWindMph = windMph;
  if (!_session.windFired && windMph >= WIND_THRESHOLD_MPH) {
    _session.windFired = true;
    fire('💨 Wind Alert', `Wind now ${Math.round(windMph)} mph — conditions changing.`, 'wind-alert');
  }
  // Reset so it can fire again if wind drops and rises again
  if (windMph < WIND_THRESHOLD_MPH - 3) {
    _session.windFired = false;
  }
}

// ── Session load from Smart Plan ──────────────────────────────────────────────
export function loadSessionFromSmartPlan() {
  try {
    // Solunar times from plan-builder's calcSolunar output stored on window
    const solunarStr = document.getElementById('planSolunarDisplay')?.textContent || '';
    const majorMatch = solunarStr.match(/(\d{1,2}:\d{2}\s*[AP]M).*?(\d{1,2}:\d{2}\s*[AP]M)/i);
    if (majorMatch) {
      _session.solunarMajors = [parseTimeStr(majorMatch[1]), parseTimeStr(majorMatch[2])]
        .filter(Boolean).map(h => ({ h, fired: false }));
    }

    // Band change times from Smart Plan phase routes
    const phases = window._smartPlanPhaseRoutes || [];
    _session.bandChangeTimes = [];
    // Band 2 starts roughly when Band 1 outbound + inbound time elapses
    // Use phase timing from phaseInfo if available
    const phaseInfoEl = document.getElementById('planPhaseInfo');
    if (phaseInfoEl) {
      try {
        const info = JSON.parse(phaseInfoEl.dataset.phases || '[]');
        for (let i = 1; i < info.length; i++) {
          _session.bandChangeTimes.push({
            h: info[i].startH,
            label: `Band ${i + 1} (${info[i].depthMin || ''}–${info[i].depthMax || ''}ft)`,
            fired: false,
          });
        }
      } catch (_) {}
    }

    // Return time
    const returnVal = document.getElementById('planReturnTime')?.value;
    if (returnVal) {
      _session.returnTimeH = parseTimeStr(returnVal);
      _session.returnFired = false;
    }

    console.log('[notifications] Session loaded:', {
      majors: _session.solunarMajors.length,
      bands: _session.bandChangeTimes.length,
      returnH: _session.returnTimeH,
    });
  } catch (e) {
    console.warn('[notifications] loadSession failed:', e.message);
  }
}

function parseTimeStr(str) {
  if (!str) return null;
  const m = String(str).match(/(\d{1,2}):(\d{2})\s*([AP]M)?/i);
  if (!m) return null;
  let h = parseInt(m[1]);
  const min = parseInt(m[2]);
  const ap = (m[3] || '').toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return h + min / 60;
}

// ── Enable / disable ──────────────────────────────────────────────────────────
export async function enableNotifications() {
  const granted = await requestNotificationPermission();
  if (!granted) {
    alert('Notification permission denied. Enable notifications in your browser settings.');
    return false;
  }
  _enabled = true;
  _firedPins.clear();
  loadSessionFromSmartPlan();
  _tickInterval = setInterval(tick, 30000);
  startProximityWatch();
  fire('🎣 TrollMap Alerts On', 'You\'ll get notified for solunar windows, band changes, and nearby structure.', 'startup');
  updateUI();
  return true;
}

export function disableNotifications() {
  _enabled = false;
  clearInterval(_tickInterval);
  _tickInterval = null;
  stopProximityWatch();
  updateUI();
}

export function isEnabled() { return _enabled; }

// ── Settings UI ───────────────────────────────────────────────────────────────
function updateUI() {
  const btn = document.getElementById('notificationsToggleBtn');
  const status = document.getElementById('notificationsStatus');
  if (btn) {
    btn.textContent = _enabled ? '🔔 Alerts On' : '🔕 Alerts Off';
    btn.style.background = _enabled ? 'var(--accent2)' : '';
    btn.style.color = _enabled ? '#000' : '';
  }
  if (status) {
    status.textContent = _enabled
      ? `Active · Proximity ${PROXIMITY_RADIUS_FT}ft · Wind >${WIND_THRESHOLD_MPH}mph`
      : 'Off';
    status.style.color = _enabled ? 'var(--accent2)' : 'var(--muted)';
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
setTimeout(() => {
  const btn = document.getElementById('notificationsToggleBtn');
  if (btn) {
    btn.addEventListener('click', async () => {
      if (_enabled) {
        disableNotifications();
      } else {
        await enableNotifications();
      }
    });
  }

  // Hook into Smart Plan completion to auto-reload session data
  const smartPlanBtn = document.getElementById('runSmartPlanBtn');
  if (smartPlanBtn) {
    // Re-load session 3 seconds after Smart Plan runs (data will be rendered by then)
    const orig = window.runSmartPlan;
    if (orig) {
      window.runSmartPlan = async function(...args) {
        const result = await orig(...args);
        if (_enabled) setTimeout(loadSessionFromSmartPlan, 3000);
        return result;
      };
    }
  }

  updateUI();
}, 800);

// Expose for weather module to call
window.trollmapCheckWindAlert = checkWindAlert;

console.log('[notifications] module ready');
