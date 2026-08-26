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

import { state, CF_WORKER_URL } from '../core/state.js';
import { planCues, weatherCues } from './plan-assemble.js';
import { geoDistanceFt as distFt } from '../utils/geo.js';

import { callGlobal } from '../utils/call-global.js';
// The same guard the sync routes use. Registering a device and arming a watch are
// WRITES -- without it anyone who learned the URL could point Ryan's phone at a lake
// he is not on.
import { workerHeaders } from '../utils/worker-auth.js';
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

// WHAT THE LAST fire() ACTUALLY DID, so selfTest() can report it instead of guessing. A
// console.warn on a phone is a message nobody will ever read.
let _lastFire = { at: null, via: null, ok: null, error: null };
export function lastFire() { return { ..._lastFire }; }

/**
 * ANDROID CHROME DOES NOT SUPPORT `new Notification()` AND HAS NOT SINCE 2016.
 *
 * On a phone the page-level constructor throws `TypeError: Illegal constructor`, and the catch
 * below turned that into a console.warn — on a device with no console open, in a dry bag, which
 * is the exact situation this feature exists for. The supported path is the SERVICE WORKER's
 * showNotification(), and this app already registers a service worker in sw-register.js; it
 * simply was never asked to show anything.
 *
 * Service worker first, page constructor second. Desktop keeps working either way, and the
 * fallback is what makes this safe to ship without a device in hand to test on.
 */
// NO EMOJI IN ANY OF THESE STRINGS, AND THE TEST BELOW ENFORCES IT.
//
// Ryan photographed a live notification on the Echomap on 2026-08-26. Every notification this
// app raises relays there through Garmin Connect, and a marine chartplotter renders a limited
// glyph set -- a leading emoji costs the first and most-read position on the line to draw an
// empty box. The phone tray is not the audience; the plotter is. Worker/alerts.js strips the
// same characters from the PUSH path at its own boundary; this half simply does not write them.
async function fire(title, body, tag = null) {
  if (!_enabled) return false;
  if (!('Notification' in window) || Notification.permission !== 'granted') {
    _lastFire = { at: Date.now(), via: null, ok: false,
                  error: ('Notification' in window) ? `permission=${Notification.permission}` : 'no Notification API' };
    return false;
  }
  const opts = { body, icon: './icons/icon-192.png', silent: false };
  if (tag) opts.tag = tag;
  try {
    const reg = ('serviceWorker' in navigator)
      ? await navigator.serviceWorker.getRegistration() : null;
    if (reg && typeof reg.showNotification === 'function') {
      await reg.showNotification(title, opts);
      _lastFire = { at: Date.now(), via: 'serviceWorker', ok: true, error: null };
      return true;
    }
  } catch (e) {
    // Fall through to the page constructor rather than giving up: a registration that exists
    // but is not yet active throws here, and on desktop the constructor still works.
    _lastFire = { at: Date.now(), via: 'serviceWorker', ok: false, error: e && e.message };
  }
  try {
    const n = new Notification(title, opts);
    setTimeout(() => { try { n.close(); } catch (_) {} }, 8000);
    _lastFire = { at: Date.now(), via: 'page', ok: true, error: null };
    return true;
  } catch (e) {
    _lastFire = { at: Date.now(), via: 'page', ok: false, error: e && e.message };
    console.warn('[notifications] fire failed:', e && e.message);
    return false;
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
      fire('Solunar Major Starting', `Peak bite window at ${hToStr(m.h)} - be on fish.`, 'solunar-major');
    }
  }

  // Solunar minors
  for (const m of _session.solunarMinors) {
    if (!m.fired && now >= m.h - warnH && now < m.h) {
      m.fired = true;
      fire('Solunar Minor', `Secondary bite window at ${hToStr(m.h)}.`, 'solunar-minor');
    }
  }

  // Band change
  for (const b of _session.bandChangeTimes) {
    if (!b.fired && now >= b.h - (10 / 60) && now < b.h) {
      b.fired = true;
      fire('Band Change', `Switch to ${b.label} in ~10 minutes.`, 'band-change');
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
      ? (w.severity === 'stop' ? 'NWS warning' : 'NWS advisory')
      : (w.severity === 'stop' ? 'Get off the water' : 'Weather');
    fire(title, w.label, `${w.kind || 'weather'}-${w.severity}`);
  }

  // Return time warning
  if (_session.returnTimeH && !_session.returnFired) {
    const warnReturnH = RETURN_WARN_MIN / 60;
    if (now >= _session.returnTimeH - warnReturnH && now < _session.returnTimeH) {
      _session.returnFired = true;
      fire('Head Back Soon', `Return time is ${hToStr(_session.returnTimeH)} - ${RETURN_WARN_MIN} min remaining.`, 'return-time');
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

    // REGISTER THE SERVER-SIDE WATCH FOR THIS TRIP. Deliberately not awaited: a plan must render
    // whether or not a push subscription succeeds, and every failure is recorded in pushState()
    // for selfTest() to report rather than thrown into a plan that was otherwise fine.
    //
    // The watch expires at the RETURN TIME this plan already computed, so nothing has to remember
    // to turn it off and a trip that runs long simply stops being watched rather than buzzing
    // about a lake he left hours ago.
    if (_enabled && _session.hazardWorker && _session.launchPos) {
      const until = Number.isFinite(_session.returnTimeH)
        ? (() => { const d = new Date(); d.setHours(0, 0, 0, 0);
                   return new Date(d.getTime() + _session.returnTimeH * 3600e3).toISOString(); })()
        : null;
      // EVERYTHING THE DAY HAS TO SAY, not just the weather. The cue list this session already
      // built is uploaded with the watch so the cron can fire it while the app is closed.
      const isoAt = (h) => { const d = new Date(); d.setHours(0, 0, 0, 0);
                             return new Date(d.getTime() + h * 3600e3).toISOString(); };
      const cues = [
        ..._session.solunarMajors.map((m) => ({ at: isoAt(m.h), title: 'Solunar Major',
          body: `Peak bite window at ${hToStr(m.h)}`, tag: 'solunar-major', severity: 'note' })),
        ..._session.bandChangeTimes.map((b) => ({ at: isoAt(b.h), title: 'Band Change',
          body: `Switch to ${b.label}`, tag: `band-${b.label}`, severity: 'note' })),
        ..._session.weatherCues.map((w) => ({ at: isoAt(w.h), title: w.severity === 'stop'
          ? 'Get off the water' : 'Weather', body: w.label, tag: `weather-${w.severity}`,
          severity: w.severity })),
        ...(Number.isFinite(_session.returnTimeH) ? [{ at: isoAt(_session.returnTimeH - RETURN_WARN_MIN / 60),
          title: 'Head back soon', body: `Return time is ${hToStr(_session.returnTimeH)}`,
          tag: 'return-time', severity: 'note' }] : []),
      ];
      startTripWatch(_session.hazardWorker, {
        lat: _session.launchPos.lat, lon: _session.launchPos.lon,
        until, water: o.water || null, slug: o.slug || null, cues,
      });
    }
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
          fire('Fishing Spot Nearby', `Community spot ${Math.round(ft)}ft ahead.`, id);
        }
      }
      for (const att of (ctx.attractors || [])) {
        const id = `att-${att.lat?.toFixed(5)},${att.lon?.toFixed(5)}`;
        if (_firedPins.has(id)) continue;
        const ft = distFt(lat, lon, att.lat, att.lon);
        if (ft <= PROXIMITY_RADIUS_FT) {
          _firedPins.add(id);
          const name = att.name || 'Fish Attractor';
          fire(`${name}`, `${Math.round(ft)}ft ahead.`, id);
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
    fire('Wind Alert', `Wind now ${Math.round(windMph)} mph - conditions changing.`, 'wind-alert');
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
// ── The bell survives a reload ────────────────────────────────────────────────
//
// `_enabled` was module state and nothing else, so every page load turned alerts off again
// WITHOUT SAYING SO. The bell had been pressed; the app had forgotten.
//
// Measured 2026-08-26: Ryan pressed the bell on his desktop -- the device registered
// server-side, which persists -- then built a SmartPlan for Wateree and no trip watch was
// armed, because arming one is gated on `_enabled` and a reload had silently cleared it. On
// the phone it is worse: the registration sticks, so `devices` counts it and everything LOOKS
// armed while the cue schedule that has to travel with a plan never leaves.
//
// A toggle that forgets is a toggle that lies about its own state.
const ENABLED_KEY = 'trollmap_notifications_on';
function rememberEnabled(on) {
  try {
    if (on) localStorage.setItem(ENABLED_KEY, '1');
    else localStorage.removeItem(ENABLED_KEY);
  } catch (_) { /* private mode: the bell works, it just will not survive a reload */ }
}
function wasEnabled() {
  try { return localStorage.getItem(ENABLED_KEY) === '1'; } catch (_) { return false; }
}

export async function enableNotifications(opts = {}) {
  const granted = await requestNotificationPermission();
  if (!granted) {
    // A RESTORE MUST NOT POP AN ALERT BOX. Permission can be revoked between visits, and a
    // modal on page load is not how he should learn that.
    if (!opts.silent) alert('Notification permission denied. Enable notifications in your browser settings.');
    rememberEnabled(false);
    return false;
  }
  _enabled = true;
  rememberEnabled(true);
  _firedPins.clear();
  loadSessionFromSmartPlan();
  _tickInterval = setInterval(tick, 30000);
  // THE BELL MEANS "ALERTS ON", AND IT MEANS THE SAME THING EVERYWHERE. Pressed on the phone it
  // registers the device that will receive them -- the one moment the app has to be open there.
  // Pressed at the desk it registers the desk too, which is harmless and occasionally useful.
  // Ryan asked directly whether this button was all he needed; it is, once, per device.
  // CF_WORKER_URL IS A NAMED EXPORT OF state.js, NOT A PROPERTY ON `state`. The first version
  // of this line read `state.CF_WORKER_URL`, which is undefined, so registerAlertDevice() bailed
  // on its first line -- silently, every time, no matter how often the bell was toggled. Ryan
  // toggled it three times against a Worker that was correctly configured and watched `devices`
  // stay at 0. Every other file in this app imports the constant; this one guessed at it.
  startProximityWatch();
  // The unforecast case. Runs whether or not a plan was loaded -- weather does not wait for one.
  startHazardPoll();

  // THE PHONE HAS NO CONSOLE, SO THE PHONE HAS TO SAY IT OUT LOUD.
  //
  // Registration failed silently three times in a row on Ryan's Pixel while the bell showed ON
  // and the Worker reported `configured: true`. The reason existed the whole time, in
  // pushState().error, reachable only from a JavaScript console -- which does not exist on the
  // device this feature is FOR. A diagnostic you cannot reach from where the fault happens is
  // not a diagnostic.
  //
  // So the startup notification stops being an advertisement and starts being a status line. It
  // travels the one channel already proven to work on that phone, and it reaches the Echomap
  // too. "Alerts On" said nothing true; this says whether anything will actually arrive.
  registerAlertDevice(CF_WORKER_URL).then((ok) => {
    // A RESTORE IS NOT A DECISION. Announcing "alerts ready" on every page load trains him to
    // ignore the one that says NOT armed, so a silent restore stays quiet unless it FAILED --
    // a failure is news whether or not he just pressed something.
    if (ok && opts.silent) return;
    if (ok) {
      fire('TrollMap alerts ready',
           `This device will receive solunar windows, band changes and weather warnings.`,
           'startup');
    } else {
      // NAMED, NOT "something went wrong". The reason is the whole point of the message.
      fire('TrollMap alerts NOT armed',
           `Nothing will reach this device. ${pushState().error || 'reason unknown'}`,
           'startup');
    }
  });
  updateUI();
  return true;
}

export function disableNotifications() {
  _enabled = false;
  rememberEnabled(false);
  clearInterval(_tickInterval);
  _tickInterval = null;
  stopProximityWatch();
  stopHazardPoll();
  updateUI();
}

export function isEnabled() { return _enabled; }

// ── Push: the half that works with the phone asleep ───────────────────────────
//
// The in-page poll above is instant WHILE THE APP IS OPEN and frozen the moment it is not.
// Ryan's phone rides in a PFD pocket with the screen off. This registers a server-side watch so
// Cloudflare can wake the phone instead of the phone having to stay awake to ask.
//
// BOTH PATHS STAY. They are not redundant: the poll is immediate and free while he is looking
// at the app, and push is the only thing that reaches him when he is not.

let _pushState = { registered: false, endpoint: null, error: null, label: null };
let _watchState = { armed: false, until: null, cues: 0, devices: 0, warning: null };
export function pushState() { return { ..._pushState }; }
export function watchState() { return { ..._watchState }; }

/** base64url -> Uint8Array, which is what pushManager.subscribe wants for the server key. */
function keyBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(String(b64).replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * A LAUNCH POINT, FROM EITHER SHAPE A RAMP ARRIVES IN.
 *
 * `rampCoords()` in smart-plan-v2-wiring returns `[lon, lat]` -- "the order every geometry in
 * this app uses", says its own doc comment on the line above it. A DNR ramp record is an object
 * with `.lat` and `.lon`. Both reach loadSessionFromPlan, through different call sites.
 *
 * Both of my call sites asked for `.lat` on the array, got undefined, and passed `launch: null`
 * -- so the gate that arms a trip watch never opened. Ryan toggled the bell, refreshed, rebuilt
 * the plan and watched `active_watches` stay at 0 four separate times, while every other line of
 * the self-test came back green. The file documented the shape and I guessed at it anyway; this
 * is the second time tonight the same mistake cost him a round trip.
 *
 * One function that knows both conventions beats two call sites that each assume one.
 */
export function launchFrom(ramp) {
  if (!ramp) return null;
  if (Array.isArray(ramp)) {
    const lon = Number(ramp[0]);
    const lat = Number(ramp[1]);
    return (Number.isFinite(lat) && Number.isFinite(lon)) ? { lat, lon } : null;
  }
  const lat = Number(ramp.lat);
  const lon = Number(ramp.lon);
  return (Number.isFinite(lat) && Number.isFinite(lon)) ? { lat, lon } : null;
}

/**
 * REGISTER THIS DEVICE. Once, ever, from the phone.
 *
 * Ryan, 2026-08-26: "i dont plan from my phone" and "i do not use trollmap on the water." A
 * device is a place alerts GO; it has nothing to do with where planning happens and it outlives
 * every trip. Registering the browser that loads the plan — which is what the first version of
 * this did — delivers every warning to a desk at home.
 *
 * This is the ONLY moment the app needs to be open on the phone. After it, never again.
 */
export async function registerAlertDevice(worker) {
  _pushState = { registered: false, endpoint: null, error: null, label: null };
  try {
    if (!worker) throw new Error('no worker URL');
    if (!('serviceWorker' in navigator)) throw new Error('no service worker support');
    if (!('PushManager' in window)) throw new Error('no push support in this browser');
    if (!(await requestNotificationPermission())) throw new Error('notification permission denied');
    const workerBase = String(worker).replace(/\/+$/, '');

    // THE SERVICE WORKER NEEDS THIS AND CANNOT IMPORT IT. It wakes with no page, no module graph
    // and no state.js, so the base URL is left where it can find it on its own.
    try {
      const c = await caches.open('trollmap-cfg');
      await c.put('/__worker_url', new Response(workerBase));
    } catch (_) { /* private mode; the SW falls back to its degraded text */ }

    const reg = await navigator.serviceWorker.ready;
    const r = await fetch(`${workerBase}/alerts/vapid-public`, { cache: 'no-store' });
    const j = await r.json().catch(() => null);
    // A CONFIGURATION PROBLEM IS NOT A BUG AND SAYS SO. The Worker names which key is missing;
    // passing it through verbatim is the difference between "nobody set the keys" and "broken".
    if (!r.ok || !j || !j.key) throw new Error((j && j.error) || `vapid key unavailable (HTTP ${r.status})`);

    const existing = await reg.pushManager.getSubscription();
    const sub = existing || await reg.pushManager.subscribe({
      userVisibleOnly: true, applicationServerKey: keyBytes(j.key),
    });
    // A LABEL, NOT A FINGERPRINT. Enough to tell the Pixel from the desktop in a list of two.
    const label = /Android/i.test(navigator.userAgent) ? 'phone'
                : /iPhone|iPad/i.test(navigator.userAgent) ? 'phone' : 'desktop';
    const post = await fetch(`${workerBase}/alerts/device`, {
      method: 'POST', headers: workerHeaders(),
      body: JSON.stringify({ subscription: sub.toJSON(), label }),
    });
    if (!post.ok) throw new Error(`device registration rejected (HTTP ${post.status})`);
    const ok = await post.json().catch(() => ({}));
    _pushState = { registered: true, endpoint: sub.endpoint, error: null, label: ok.label || label };
    return true;
  } catch (e) {
    _pushState.error = (e && e.message) || String(e);
    console.warn('[notifications] device registration failed:', _pushState.error);
    return false;
  }
}

/**
 * ARM A WATCH FOR THIS TRIP, from whatever machine is doing the planning.
 *
 * Carries the plan's OWN cue schedule as well as the place. Ryan: "i want bait changes, and
 * everything else sent as notifications to the echomap." Those cues fire today from a 30-second
 * timer in a page that is never open on the water, so they travel with the watch or they do not
 * happen.
 */
export async function startTripWatch(worker, { lat, lon, until, water, slug, cues } = {}) {
  try {
    const workerBase = String(worker || '').replace(/\/+$/, '');
    if (!workerBase || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const r = await fetch(`${workerBase}/alerts/watch`, {
      method: 'POST', headers: workerHeaders(),
      body: JSON.stringify({ lat, lon, until, water, slug, cues: cues || [] }),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) throw new Error(`watch rejected (HTTP ${r.status})`);
    _watchState = { armed: true, until: j.until, cues: j.cues, devices: j.devices, warning: j.warning || null };
    // A WATCH THAT PROTECTS NOBODY IS SAID OUT LOUD. The Worker counts the registered devices
    // and returns it precisely so this cannot look armed when nothing will receive it.
    if (j.warning) console.warn('[notifications]', j.warning);
    return j;
  } catch (e) {
    _watchState = { armed: false, until: null, cues: 0, devices: 0, warning: (e && e.message) || String(e) };
    console.warn('[notifications] trip watch failed:', _watchState.warning);
    return null;
  }
}


/**
 * PROVE THE CHAIN IN THE DRIVEWAY, NOT IN A STORM.
 *
 * Ryan, 2026-08-25: "honestly completely untested... i have not actually been on the water since
 * we turned that feature on." This is the only path in the app that INTERRUPTS him, it is the
 * one carrying weather warnings, and every link in it fails silently by design — a permission
 * that was never granted, a constructor that throws on Android, a poll whose worker URL was
 * never passed, a fetch that 502s. None of those show up as anything on a phone screen.
 *
 * So: exercise every link for real and return what each one did. Run it from the console or
 * from `window.trollmapNotificationSelfTest()`. It fires a REAL notification, because a test
 * that stubs the last step tests everything except the part that breaks.
 */
export async function selfTest() {
  const out = { at: new Date().toISOString(), checks: [] };
  const add = (name, ok, detail) => out.checks.push({ name, ok, detail });

  add('notifications enabled in this session', !!_enabled,
      _enabled ? 'on' : 'off — press the bell first, nothing below will fire');
  const hasApi = 'Notification' in window;
  add('Notification API present', hasApi, hasApi ? '' : 'this browser has none');
  add('permission granted', hasApi && Notification.permission === 'granted',
      hasApi ? Notification.permission : 'n/a');

  let reg = null;
  try {
    reg = ('serviceWorker' in navigator) ? await navigator.serviceWorker.getRegistration() : null;
  } catch (e) { /* reported below */ }
  // THE ONE THAT MATTERS ON ANDROID. Without an active registration the page constructor is the
  // only route left, and on Android Chrome that route throws.
  add('service worker registered and active', !!(reg && reg.active),
      reg ? (reg.active ? (reg.scope || 'active') : 'registered but not active yet — reload once')
          : 'none — on Android no notification can be shown at all');

  add('geolocation available', 'geolocation' in navigator,
      ('geolocation' in navigator) ? '' : 'proximity and live position will not work');
  // TWO DIFFERENT FACTS, AND REPORTING THEM AS ONE HID THE BUG. A live browser fix says where
  // the phone is; a launch point says what the watch is ABOUT. This line said "live fix" and
  // looked green while `launchPos` was null and the watch could never arm.
  add('live position fix', !!_lastPos, _lastPos ? 'yes' : 'none yet');
  add('plan launch point known', !!_session.launchPos,
      _session.launchPos ? `${_session.launchPos.lat.toFixed(4)}, ${_session.launchPos.lon.toFixed(4)}`
                         : 'none — a trip watch cannot arm without one');

  add('a plan is loaded', !!(_session.weatherCues || _session.solunarMajors || []).length
      || !!_session.returnTimeH, 'cues: ' + ((_session.weatherCues || []).length)
      + ' weather, ' + ((_session.solunarMajors || []).length) + ' solunar major');

  // The live hazard poll, end to end, against the real Worker.
  const at = _lastPos || _session.launchPos;
  if (!_session.hazardWorker) {
    add('hazard poll configured', false,
        'no worker URL on this session — the poll returns immediately and has never run.'
        + ' loadSessionFromPlan() was called without { worker }');
  } else if (!at) {
    add('hazard poll configured', false, 'worker set but no position to ask about');
  } else {
    add('hazard poll configured', true, _session.hazardWorker);
    try {
      const u = `${_session.hazardWorker}/hazards?lat=${at.lat.toFixed(4)}&lon=${at.lon.toFixed(4)}&_=${Date.now()}`;
      const r = await fetch(u, { cache: 'no-store' });
      const j = r.ok ? await r.json() : null;
      add('hazard endpoint answers', !!(j && Array.isArray(j.items)),
          r.ok ? `HTTP ${r.status}, ${j && Array.isArray(j.items) ? j.items.length : '?'} hazard(s) here now`
               : `HTTP ${r.status}`);
    } catch (e) {
      add('hazard endpoint answers', false, e && e.message);
    }
  }

  // PUSH IS THE ONLY LINE HERE THAT MATTERS WITH THE PHONE IN A POCKET. Everything else in this
  // list describes a chain that runs only while the app is open and awake.
  // THE TWO LINES THAT MATTER WITH THE PHONE IN A POCKET. Everything else in this list describes
  // a chain that only runs while the app is open and awake, which on the water it never is.
  add('THIS DEVICE registered for alerts', _pushState.registered,
      _pushState.registered ? `as "${_pushState.label}"`
        : (_pushState.error || 'not registered — nothing will reach this device'));
  add('trip watch armed', _watchState.armed,
      _watchState.armed
        ? `${_watchState.cues} cue(s), ${_watchState.devices} device(s), until ${_watchState.until}`
        : (_watchState.warning || 'no plan has armed one'));

  add('poll timer running', !!_hazardPoll, _hazardPoll ? `every ${HAZARD_POLL_MS / 60000} min` : 'stopped');
  add('cue timer running', !!_tickInterval, _tickInterval ? 'every 30 s' : 'stopped');

  // THE REAL THING, THROUGH THE REAL PATH. Everything above can pass while this fails.
  const wasEnabled = _enabled;
  _enabled = true;
  const fired = await fire('TrollMap self-test',
    'If you can read this on your phone, the alert path works end to end.', 'selftest');
  _enabled = wasEnabled;
  add('notification actually shown', !!fired,
      fired ? `via ${_lastFire.via}` : (_lastFire.error || 'no route worked'));

  out.ok = out.checks.every((c) => c.ok);
  // Printed as a table because this is read on a phone, where a wall of JSON is unreadable.
  try { console.table(out.checks); } catch (_) { console.log(out.checks); }
  return out;
}

if (typeof window !== 'undefined') window.trollmapNotificationSelfTest = selfTest;

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

// RESTORE THE BELL. Only when permission is still granted -- a stored flag is a memory of a
// decision, not a substitute for the permission itself, and asking again on page load would be
// its own kind of rude.
if (typeof window !== 'undefined' && wasEnabled()
    && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
  enableNotifications({ silent: true }).then((ok) => {
    console.log('[notifications] restored from last session:', ok ? 'on' : 'failed');
  });
}

console.log('[notifications] module ready');
