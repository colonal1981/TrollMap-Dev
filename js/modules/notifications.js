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
import { planCues, weatherCues } from './plan-assemble.js';
import { geoDistanceFt as distFt } from '../utils/geo.js';

import { callGlobal } from '../utils/call-global.js';
// ── Config ────────────────────────────────────────────────────────────────────
const PROXIMITY_RADIUS_FT = 300;   // fire when within 300ft of a pin
const PROXIMITY_CHECK_MS  = 15000; // check position every 15 seconds
const SOLUNAR_WARN_MIN    = 15;    // notify 15 min before major/minor
const RETURN_WARN_MIN     = 30;    // notify 30 min before return time
const WIND_THRESHOLD_MPH  = 15;    // alert when wind crosses this value
// FIVE MINUTES IS THE SERVICE'S OWN CADENCE, not a number picked here. The NWS WWA MapServer
// republishes every five minutes and the Worker's `TTL.wwa` is 300 s to match, so a phone polling
// faster is reading a cache and spending battery to do it.
const HAZARD_POLL_MS      = 5 * 60 * 1000;

// ── State ─────────────────────────────────────────────────────────────────────
let _enabled = false;
let _session = {
  solunarMajors: [],    // [{ h: 7.55, fired: false }, ...]
  solunarMinors: [],
  bandChangeTimes: [],
  weatherCues: [],       // [{ h: 12.8, label: 'Thunderstorms from 14:00…', severity, fired }]
  returnTimeH: null,
  returnFired: false,
  windFired: false,
  lastWindMph: 0,
};
let _proximityWatcher = null;
let _hazardPoll = null;
// THE BOAT'S LAST KNOWN POSITION, filled by the proximity watcher that is already running. A
// second geolocation subscription for the hazard poll would double the GPS cost for a fix the
// app already has.
let _lastPos = null;
// cap_id of every product already announced this session. NWS reissues and updates a warning
// under the same id, and being told about the same storm every five minutes is how someone turns
// notifications off on the day they matter.
let _seenHazards = new Set();
let _tickInterval = null;
let _firedPins = new Set(); // pin IDs already notified this session
// The day's plan, as things to say when he gets near them. Empty until loadSessionFromPlan().
let _planPins = [];

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

// distFt now imported from utils/geo.js (canonical)

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

  // WEATHER, ON THE CLOCK ON PURPOSE — see weatherCues(). A storm arrives when it arrives, so
  // this is the one alert that must not wait for the boat to reach a coordinate.
  //
  // FIRED AT ITS OWN HOUR, NOT TEN MINUTES BEFORE IT LIKE A BAND CHANGE. The evacuation cue has
  // ALREADY been shifted back by the run home when it was built — "leave by 12:48" for a 14:00
  // storm — so warning early again would double-count the lead and start nagging at noon about
  // weather two hours out.
  for (const w of (_session.weatherCues || [])) {
    if (w.fired || now < w.h) continue;
    w.fired = true;
    // An NWS product gets its own title. "Get off the water" is the right words for a storm we
    // inferred from a forecast; it is the wrong words for a Small Craft Advisory, and it buries
    // the one thing that came from a forecaster rather than from us.
    const title = w.kind === 'hazard'
      ? (w.severity === 'stop' ? '⚠️ NWS warning' : '⚠️ NWS advisory')
      : (w.severity === 'stop' ? '⛈️ Get off the water' : '🌧️ Weather');
    fire(title, w.label, `${w.kind || 'weather'}-${w.severity}`);
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
      _lastPos = { lat, lon };
      checkProximity(lat, lon);
    }, null, { enableHighAccuracy: true, timeout: 5000 });
  }, PROXIMITY_CHECK_MS);
}

/**
 * WEATHER THAT WAS NOT FORECAST, WHILE HE IS ALREADY ON THE WATER.
 *
 * Ryan, 2026-08-25: *"if there is a forecast that is going to drive a watch or warning i am not
 * going to plan to be on the water... now if weather creeps on while i am on the water that
 * wasn't forecasted then that is where the alert to my phone would be absolutely beneficial."*
 *
 * THE FIRST VERSION OF THIS COULD NOT DO THAT AND LOOKED LIKE IT COULD. It built the cue list
 * once, from a hazards snapshot taken when the plan loaded, so a warning ISSUED AFTER LAUNCH --
 * the only case he asked for -- never arrived. A feature that covers the forecast case and
 * silently misses the unforecast one is worse than no feature, because it earns trust it cannot
 * honour.
 *
 * So the hazards are asked for again, from the BOAT'S position, on the service's own cadence.
 * Position matters: a warning polygon has an edge, and being told you have drifted under one is
 * the whole point.
 *
 * A FAILED POLL IS NOT AN ALL-CLEAR. Nothing is announced on an error and nothing is marked seen,
 * so the next poll re-asks. Silence here must never be mistaken for good news.
 */
async function pollHazards() {
  if (!_enabled || !_session.hazardWorker) return;
  const at = _lastPos || _session.launchPos;
  if (!at) return;
  let j;
  try {
    const u = `${_session.hazardWorker}/hazards?lat=${at.lat.toFixed(4)}&lon=${at.lon.toFixed(4)}`
            + `&_=${Date.now()}`;
    const r = await fetch(u, { cache: 'no-store' });
    if (!r.ok) return;
    j = await r.json();
  } catch (e) {
    console.warn('[notifications] hazard poll failed:', e && e.message);
    return;
  }
  if (!j || j.error || !Array.isArray(j.items)) return;

  const fresh = j.items.filter((h) => h && h.id && !_seenHazards.has(h.id));
  if (!fresh.length) return;
  for (const h of fresh) _seenHazards.add(h.id);

  // Through the SAME cue builder the plan uses, so a watch issued at noon still gets the leave-by
  // computed from this plan's furthest point rather than a bare "a watch exists".
  for (const c of (_session.makeHazardCues ? _session.makeHazardCues(fresh) : [])) {
    _session.weatherCues.push({ h: c.atHour, label: c.what, severity: c.severity,
                                fired: false, kind: 'hazard' });
  }
}

function startHazardPoll() {
  if (_hazardPoll) return;
  pollHazards();                                   // ask once at launch, then on the cadence
  _hazardPoll = setInterval(pollHazards, HAZARD_POLL_MS);
}

function stopHazardPoll() {
  if (_hazardPoll) { clearInterval(_hazardPoll); _hazardPoll = null; }
  _seenHazards = new Set();
}

function stopProximityWatch() {
  if (_proximityWatcher) {
    clearInterval(_proximityWatcher);
    _proximityWatcher = null;
  }
}

/**
 * THE PLAN'S OWN CUES, LOADED FOR THE ECHOMAP.
 *
 * The phone is not the interface. Ryan: "other than using it to take photos i really do not use it
 * much... that is why we have the notifications being sent to the echomap." So everything the day
 * has to say reaches him as a notification or it does not reach him.
 *
 * planCues() and weatherCues() have both existed and had ZERO call sites. This connects them.
 *
 * FIRED ON POSITION, NOT ON PROGRESS. The cue objects carry `atM` — metres along the day — and it
 * would be easy to fire them by tracking how far he has come. That needs a running total that
 * drifts the moment he stops to fish, which is the whole reason PLAN_SCHEMA_V2 refuses times. Real
 * proximity to a real coordinate has no such drift: it is right whether he took the legs in order,
 * skipped three, or spent an hour on one stretch. The existing proximity watcher already does it.
 *
 * WEATHER IS THE EXCEPTION AND STAYS ON THE CLOCK, because a storm arrives when it arrives — see
 * weatherCues(). Those ride the 30-second tick rather than the position watch.
 */
export function loadSessionFromPlan(plan, o = {}) {
  _planPins = [];
  const legAt = (id) => ((plan && plan.legs) || []).find((l) => l.id === id) || null;
  const pointOn = (leg, atLegM) => {
    const co = (leg && leg.coordinates) || [];
    if (co.length < 2 || !(leg.lengthM > 0)) return co[0] || null;
    const k = Math.max(0, Math.min(co.length - 1,
                                   Math.round((atLegM / leg.lengthM) * (co.length - 1))));
    return co[k];
  };
  try {
    for (const cue of planCues(plan)) {
      const leg = cue.legId ? legAt(cue.legId) : null;
      let at = null;
      if (cue.kind === 'stop' && leg) {
        const s = (leg.stops || []).find((x) => x.id === cue.ref);
        at = (s && s.at) || pointOn(leg, cue.atM - (leg.startM || 0));
      } else if (leg) {
        at = pointOn(leg, cue.atM - (leg.startM || 0));
      }
      if (!at || !Number.isFinite(at[0]) || !Number.isFinite(at[1])) continue;
      const title = cue.kind === 'stop' ? '🎯 Stop and cast'
                  : cue.kind === 'depth' ? '⚠️ Shallow ahead'
                  : cue.kind === 'change' ? '🪝 Lure change'
                  : '📍 Coming up';
      _planPins.push({ id: `plan-${cue.kind}-${cue.ref}`, lat: at[1], lon: at[0],
                       title, body: cue.what || '' });
    }
    // The clock half. One notice, at the hour it is due, and the storm one already carries the
    // leave-by time computed from the run home.
    _session.weatherCues = (weatherCues(plan, o.weatherByHour,
      { transitMph: o.transitMph, hazards: o.hazards }) || [])
      .map((c) => ({ h: c.atHour, label: c.what, severity: c.severity, fired: false,
                     kind: c.kind || 'weather' }));

    // WHAT THE LIVE POLL NEEDS, kept on the session so pollHazards() does not have to rebuild the
    // plan's geometry every five minutes. `makeHazardCues` closes over THIS plan, so a warning
    // issued at noon gets the leave-by from this trip's furthest point rather than a bare notice.
    _session.hazardWorker = o.worker ? String(o.worker).replace(/\/+$/, '') : null;
    _session.launchPos = (o.launch && Number.isFinite(o.launch.lat) && Number.isFinite(o.launch.lon))
      ? { lat: o.launch.lat, lon: o.launch.lon } : null;
    _session.makeHazardCues = (hazards) =>
      weatherCues(plan, null, { transitMph: o.transitMph, hazards }) || [];
    // Anything already in effect at load has been announced by the cue list above; the poll must
    // not say it again five minutes later.
    for (const h of (o.hazards || [])) if (h && h.id) _seenHazards.add(h.id);
    console.log('[notifications] plan loaded:', _planPins.length, 'position cues,',
                _session.weatherCues.length, 'weather cues');
  } catch (e) {
    console.warn('[notifications] loadSessionFromPlan failed:', e && e.message);
  }
  return { positionCues: _planPins.length, weatherCues: (_session.weatherCues || []).length };
}

function checkProximity(lat, lon) {
  // THE PLAN FIRST. These are the things the day was built to tell him, and unlike the community
  // spots below they are his own plan talking, so they go before anything else can use up the
  // notification's moment.
  for (const pin of _planPins) {
    if (_firedPins.has(pin.id)) continue;
    const ft = distFt(lat, lon, pin.lat, pin.lon);
    if (ft <= PROXIMITY_RADIUS_FT) {
      _firedPins.add(pin.id);
      fire(pin.title, pin.body, pin.id);
    }
  }

  // The QuickDraw pin block was here until 2026-08-07. It read window.getMyStructures(),
  // which went with the structure mapper. Deleted rather than left in place: it used
  // optional chaining with an empty-array fallback, so it would have gone on looking
  // alive forever while contributing nothing. The alerts below run on real data.

  // Supplemental fishing spots
  {
    try {
      // 0.1 mi = ~530ft. These are proximity alerts: one that never fires is invisible, so a
      // throwing implementation has to reach the console rather than the void.
      const ctx = callGlobal('getSupplementalContext', lat, lon, 0.1) || {};
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
    } catch (err) {
      // Proximity alerts for attractors. Silence here means no alerts ever fire and the
      // feature looks switched off rather than broken.
      console.warn('[notifications] attractor proximity check failed:', err);
    }
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
    // Solunar from global set by plan-builder after calcSolunar runs
    const sol = window._trollmapSolunar;
    if (sol) {
      _session.solunarMajors = [sol.major1, sol.major2]
        .filter(h => h != null).map(h => ({ h, fired: false }));
      _session.solunarMinors = [sol.minor1, sol.minor2]
        .filter(h => h != null).map(h => ({ h, fired: false }));
    }

    // Band change times from global set by smart-plan after phases computed
    const phases = window._trollmapPhases || [];
    _session.bandChangeTimes = [];
    for (let i = 1; i < phases.length; i++) {
      const routes = window._smartPlanPhaseRoutes || [];
      const route = routes[i] || {};
      const depthLabel = route.depthMin != null ? `${route.depthMin}–${route.depthMax}ft` : '';
      _session.bandChangeTimes.push({
        h: phases[i].startH,
        label: `Band ${i + 1}${depthLabel ? ' (' + depthLabel + ')' : ''}`,
        fired: false,
      });
    }

    // Return time from plan form
    const returnVal = document.getElementById('planReturnTime')?.value;
    if (returnVal) {
      _session.returnTimeH = parseTimeStr(returnVal);
      _session.returnFired = false;
    }

    console.log('[notifications] Session loaded:', {
      majors: _session.solunarMajors.length,
      minors: _session.solunarMinors.length,
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
  // The unforecast case. Runs whether or not a plan was loaded -- weather does not wait for one.
  startHazardPoll();
  fire('🎣 TrollMap Alerts On', 'You\'ll get notified for solunar windows, band changes, and nearby structure.', 'startup');
  updateUI();
  return true;
}

export function disableNotifications() {
  _enabled = false;
  clearInterval(_tickInterval);
  _tickInterval = null;
  stopProximityWatch();
  stopHazardPoll();
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

// Called by plan-builder after calcSolunar
window.trollmapLoadSolunarNotifications = function(sol) {
  if (!_enabled) return;
  _session.solunarMajors = [sol.major1, sol.major2]
    .filter(h => h != null).map(h => ({ h, fired: false }));
  _session.solunarMinors = [sol.minor1, sol.minor2]
    .filter(h => h != null).map(h => ({ h, fired: false }));
};

// Called by smart-plan after phases computed
window.trollmapLoadPhaseNotifications = function(phases) {
  if (!_enabled) return;
  _session.bandChangeTimes = [];
  const routes = window._smartPlanPhaseRoutes || [];
  for (let i = 1; i < phases.length; i++) {
    const route = routes[i] || {};
    const depthLabel = route.depthMin != null ? `${route.depthMin}–${route.depthMax}ft` : '';
    _session.bandChangeTimes.push({
      h: phases[i].start,
      label: `Band ${i + 1}${depthLabel ? ' (' + depthLabel + ')' : ''}`,
      fired: false,
    });
  }
};

// Called by smart-plan when plan completes
window.trollmapReloadNotificationSession = function() {
  if (!_enabled) return;
  loadSessionFromSmartPlan();
  _firedPins.clear(); // reset proximity on new plan
  console.log('[notifications] Session reloaded after Smart Plan');
};

console.log('[notifications] module ready');
