/**
 * autopilot-panel.js -- the steering box on the map: connect, see what it is doing, steer it, give it a route.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Built 2026-11-26 from claude/AUTOPILOT_IN_THE_APP_FOR_REVIEW_2026-11-26.md, after the first water test at
 * Second Mill. Ryan: "lets get second mill showing in the app planner tab and make the app changes for the
 * autopilot". His answers in that doc decide the shape:
 *
 *   - THE PANEL SLIDES OUT FROM THE SIDE OF THE MAP and folds to one line: "maybe a popup on the side of the
 *     map... so i can still see the map and the controls... phone screen isn't huge".
 *   - A ROUTE IS ONE LOOP AT A TIME: "route typically has been one lazy loop then there should be a way to
 *     choose to head to the next one maybe... end of the route, popup on phone asking if i am ready to head to
 *     the next leg maybe? select ok and it routes me there over water not over land". So the plan's day is
 *     cut into pieces (autopilot-route.js dayPieces()): each loop, and the runs between them. When a loop
 *     closes the box says LAP and the phone asks; yes sends the run to the next loop, and when the run ends
 *     the loop goes in by itself.
 *   - WHILE IT ASKS, THE BOX KEEPS GOING ROUND: "keep going is fine i guess".
 *   - A DROPPED LINK KEEPS STEERING: "keep following". The pause button on the mount is the stop that
 *     always works; the panel just reconnects.
 *   - THE FIRST TEST ROUTE IS TAPPED ON THE MAP: "probably the easiest way to build a route for this test".
 *
 * The box's commands are its own one-letter set (the terminal app still works beside this): H hold, < > ten
 * degrees, + - a step of the rod by hand, S stop, C center, G follow, R rod in, Q clear the route, W<lat>,<lon>; a point, J make it a loop,
 * V say what route it holds. Nothing here steers: the box does, on its own GPS and compass.
 */
import { state } from '../core/state.js';
import { createLink } from './autopilot-ble.js';
import { newStatus, applyLine, bowTrue, offLineText, distText, motorText } from '../utils/autopilot-status.js';
import { dayPieces, thin, routeCommands } from '../utils/autopilot-route.js';
import { keepLine, countLines, saveLogFile } from '../utils/autopilot-log.js';

const S = {
  open: false, folded: false, built: false,
  status: newStatus(),
  link: null, linkState: 'off', linkWhy: '',
  tapping: false, tapPts: [], tapLoop: true, clickTimer: 0,
  sending: false,
  boxRoute: null,            // { coords, loop, label } -- what was last put in the box from here
  day: null,                 // { pieces, i } -- the plan's day while it is being run
  ask: null,                 // { text, sub, yes, no, yesLabel }
  waiters: [],
  msg: '', msgBad: false,
  el: null, layer: null,
  wake: null,
  logCount: 0,
  renderQueued: false,
};

const $q = (sel) => (S.el ? S.el.querySelector(sel) : null);
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const map = () => state.MAP || null;
const ll = (c) => [c[1], c[0]];

// ── THE LINK ─────────────────────────────────────────────────────────────────────────────────────

function link() {
  if (!S.link) {
    S.link = createLink({
      onLine,
      onState: (st, why) => {
        S.linkState = st;
        S.linkWhy = why || '';
        if (st === 'on') {
          say('Connected.');
          // What route does it hold? (It keeps one through a power cycle.)
          setTimeout(() => { if (S.linkState === 'on') send('V').catch(() => {}); }, 1800);
        }
        wakeLock();
        render();
      },
    });
  }
  return S.link;
}

function send(text) {
  keepLine(text, 'out');
  return link().send(text);
}

/** Resolves with the first line `test(line)` is true for; or at once when `test(null)` is already true. */
function waitFor(test, ms, what) {
  if (test(null)) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const w = { test, resolve };
    w.timer = setTimeout(() => {
      S.waiters = S.waiters.filter((x) => x !== w);
      reject(new Error(`the box did not answer${what ? ` (${what})` : ''}`));
    }, ms);
    S.waiters.push(w);
  });
}

function onLine(line) {
  keepLine(line, 'in');
  const ev = applyLine(S.status, line);
  for (const w of [...S.waiters]) {
    if (w.test(line)) {
      clearTimeout(w.timer);
      S.waiters = S.waiters.filter((x) => x !== w);
      w.resolve(line);
    }
  }
  if (ev) onEvent(ev);
  render();
}

function buzz() { try { navigator.vibrate && navigator.vibrate([250, 120, 250]); } catch { /* none */ } }

function onEvent(ev) {
  const day = S.day;
  const cur = day && day.pieces[day.i];
  const next = day && day.pieces[day.i + 1];
  if (ev.type === 'lap') {
    if (cur && cur.kind === 'loop' && next && !S.ask) {
      buzz();
      ask({ text: `${cur.name} is done. Ready for the next leg?`,
            sub: `${next.name}, ${distText(next.lengthM)}. Until you say, it keeps going round ${cur.name.toLowerCase()}.`,
            yesLabel: 'Yes, go', yes: () => startPiece(day.i + 1) });
    } else say('Lap done. Going round again.');
  } else if (ev.type === 'end') {
    if (cur && cur.kind === 'run' && next) {
      if (next.kind === 'loop') { say(`${cur.name} done. Putting ${next.name} in.`); startPiece(day.i + 1); }
      else { buzz(); ask({ text: `${cur.name} is done.`, sub: `Next: ${next.name}, ${distText(next.lengthM)}.`, yesLabel: 'Go', yes: () => startPiece(day.i + 1) }); }
    } else { buzz(); say('End of the route. Holding the last heading.'); }
  } else if (ev.type === 'no') say(`The box said no: ${ev.text}`, true);
  else if (ev.type === 'paused') say('Paused at the mount. Press it again, or Follow, to rejoin the route.');
  else if (ev.type === 'hold-off') say(ev.text.replace(/^HOLD off: /, 'Steering off: '));
  else if (ev.type === 'fault') { buzz(); say(`${ev.text} -- check the rod's wiring.`, true); }
  else if (ev.type === 'wp-bad') say(`The box refused a point (${ev.text}).`, true);
}

// ── ROUTES ───────────────────────────────────────────────────────────────────────────────────────

/** Put a route in the box and start following it. Points go at most 8 ahead of the box's "WP n". */
async function sendRoute(coords, { loop, label }) {
  if (S.linkState !== 'on') throw new Error('not connected');
  const pts = thin(coords, { loop });
  if (pts.length < 2) throw new Error('a route needs two points or more');
  S.sending = true;
  render();
  try {
    say(`Sending ${label}: ${pts.length} points…`);
    const cmds = routeCommands(pts, { loop });
    const cleared = waitFor((l) => l != null && /^ROUTE cleared/.test(l), 5000, 'clear');
    await send('Q');
    await cleared;
    let sent = 0;
    for (const c of cmds.slice(1)) {
      if (c[0] === 'W') {
        if (sent - S.status.wpAck >= 8) await waitFor(() => sent - S.status.wpAck < 8, 6000, `point ${sent - 7}`);
        await send(c);
        sent += 1;
        if (sent % 20 === 0) say(`Sending ${label}: ${sent} of ${pts.length} points…`);
      } else if (c === 'V') {
        await waitFor(() => S.status.wpAck >= sent, 8000, 'the last point');
        const held = waitFor((l) => l != null && /^ROUTE \d+ points/.test(l), 5000, 'the route');
        await send('V');
        await held;
      } else await send(c);
    }
    if (S.status.route.n !== pts.length || S.status.route.loop !== !!loop) {
      throw new Error(`the box holds ${S.status.route.n} of ${pts.length} points`);
    }
    S.boxRoute = { coords: pts, loop: !!loop, label };
    drawRoute();
    const go = waitFor((l) => l != null && (/^FOLLOW on:/.test(l) || /^NO: /.test(l)), 6000, 'follow');
    await send('G');
    const r = await go;
    if (/^NO: /.test(r)) throw new Error(r.slice(4));
    say(`Following ${label}.`);
  } finally {
    S.sending = false;
    render();
  }
}

function startDay() {
  const pieces = dayPieces(window._planV2);
  if (!pieces.length) { say('No plan on the map to send. Build one, or tap a route.', true); return; }
  S.day = { pieces, i: 0 };
  startPiece(0);
}

async function startPiece(i) {
  if (!S.day || !S.day.pieces[i]) return;
  S.day.i = i;
  S.ask = null;
  const p = S.day.pieces[i];
  render();
  try { await sendRoute(p.coords, { loop: p.kind === 'loop', label: p.name }); } catch (e) { say(`${p.name} not sent: ${e.message}`, true); }
}

async function sendTapped() {
  if (S.tapPts.length < 2) { say('Tap two points or more on the water first.', true); return; }
  S.day = null;
  try {
    await sendRoute(S.tapPts, { loop: S.tapLoop, label: `the tapped route (${S.tapPts.length} points)` });
    setTapping(false);
  } catch (e) { say(`Not sent: ${e.message}`, true); }
}

/** Option 2, 3... of an options day: each is laid from the ramp and back, so it goes in as a loop. */
function optionTracks() {
  return ((state.DATA && state.DATA.tracks) || []).filter((t) => t && t.option > 1 && Array.isArray(t.pts) && t.pts.length > 1);
}

async function sendOption(n) {
  const t = optionTracks().find((x) => x.option === n);
  if (!t) return;
  S.day = null;
  const coords = t.pts.map((p) => (Array.isArray(p) ? [p[1], p[0]] : [p.lon, p.lat]));
  try { await sendRoute(coords, { loop: true, label: `Option ${n}` }); } catch (e) { say(`Option ${n} not sent: ${e.message}`, true); }
}

// ── TAPPING A ROUTE ──────────────────────────────────────────────────────────────────────────────

function setTapping(on) {
  S.tapping = !!on;
  // loop-on-map.js reads this so a tap for a route point is not also a turn for the loop.
  window.autopilotTapping = S.tapping;
  if (on) say('Tap the water for each point, in order. Two or more.');
  drawTap();
  render();
}

function onMapClick(e) {
  if (!S.tapping) return;
  if (document.getElementById('editMode')?.value === 'add') return;   // adding a waypoint
  clearTimeout(S.clickTimer);
  // A double tap zooms; it is not two points.
  S.clickTimer = setTimeout(() => {
    S.tapPts.push([e.latlng.lng, e.latlng.lat]);
    drawTap();
    render();
  }, 260);
}

// ── THE MAP ──────────────────────────────────────────────────────────────────────────────────────

let routeLayer = null;
let tapLayer = null;
let boatLayer = null;

function drawRoute() {
  const m = map();
  if (!m || typeof L === 'undefined') return;
  if (routeLayer) routeLayer.remove();
  routeLayer = L.layerGroup();
  const r = S.boxRoute;
  if (r && r.coords.length > 1) {
    const c = r.coords.map(ll);
    if (r.loop) c.push(c[0]);
    L.polyline(c, { color: '#000', weight: 7, opacity: 0.5, interactive: false }).addTo(routeLayer);
    L.polyline(c, { color: '#ff4081', weight: 3.5, opacity: 1, interactive: false }).addTo(routeLayer);
  }
  routeLayer.addTo(m);
}

function drawTap() {
  const m = map();
  if (!m || typeof L === 'undefined') return;
  if (tapLayer) tapLayer.remove();
  tapLayer = null;
  if (!S.tapping && !S.tapPts.length) return;
  tapLayer = L.layerGroup();
  const c = S.tapPts.map(ll);
  if (c.length > 1) {
    const line = S.tapLoop && c.length > 2 ? [...c, c[0]] : c;
    L.polyline(line, { color: '#18ffff', weight: 3, dashArray: '8,6', interactive: false }).addTo(tapLayer);
  }
  c.forEach((p, i) => {
    L.marker(p, { interactive: false, icon: L.divIcon({ className: '', iconSize: [20, 20], iconAnchor: [10, 10],
      html: `<div style="width:20px;height:20px;border-radius:50%;background:#18ffff;color:#000;font:700 11px/20px system-ui;text-align:center;border:2px solid #000">${i + 1}</div>` }) }).addTo(tapLayer);
  });
  tapLayer.addTo(map());
}

function drawBoat() {
  const m = map();
  const s = S.status;
  if (!m || typeof L === 'undefined') return;
  if (boatLayer) boatLayer.remove();
  boatLayer = null;
  if (!s.fix || !Number.isFinite(s.lat) || !Number.isFinite(s.lon) || S.linkState === 'off') return;
  boatLayer = L.layerGroup();
  const at = [s.lat, s.lon];
  const hdg = bowTrue(s.headingBox);
  if (hdg != null) {
    const r = 60 / 111320;
    const k = Math.cos(s.lat * Math.PI / 180);
    const tip = [s.lat + r * Math.cos(hdg * Math.PI / 180), s.lon + (r / k) * Math.sin(hdg * Math.PI / 180)];
    L.polyline([at, tip], { color: '#000', weight: 6, opacity: 0.6, interactive: false }).addTo(boatLayer);
    L.polyline([at, tip], { color: '#ffeb3b', weight: 3, interactive: false }).addTo(boatLayer);
  }
  const r = S.boxRoute;
  if (s.mode === 'following' && r && Number.isFinite(s.wp) && r.coords[s.wp - 1]) {
    L.circleMarker(ll(r.coords[s.wp - 1]), { radius: 10, color: '#ff4081', weight: 3, fill: false, interactive: false }).addTo(boatLayer);
  }
  L.circleMarker(at, { radius: 7, color: '#000', weight: 2.5, fillColor: '#ffeb3b', fillOpacity: 1, interactive: false }).addTo(boatLayer);
  boatLayer.addTo(m);
}

// ── KEEP THE SCREEN ON WHILE IT IS STEERING ──────────────────────────────────────────────────────

async function wakeLock() {
  const want = S.open && S.linkState !== 'off';
  try {
    if (want && !S.wake && navigator.wakeLock && document.visibilityState === 'visible') {
      S.wake = await navigator.wakeLock.request('screen');
      S.wake.addEventListener('release', () => { S.wake = null; });
    } else if (!want && S.wake) { await S.wake.release(); S.wake = null; }
  } catch { /* the screen may sleep; nothing steers from here */ }
}

// ── THE PANEL ────────────────────────────────────────────────────────────────────────────────────

function say(msg, bad = false) {
  S.msg = msg;
  S.msgBad = bad;
  render();
}

/** A question the boat is waiting on opens the panel, folded or shut. */
function ask(a) {
  S.ask = a;
  S.folded = false;
  if (!S.open) toggle();
  render();
}

const CSS = `
.ap-panel{position:absolute;right:8px;top:70px;z-index:1000;width:236px;max-height:calc(100% - 170px);overflow:auto;
  background:rgba(11,22,35,.96);color:#e8eff4;border:1px solid rgba(232,239,244,.25);border-radius:10px;
  font:12px/1.4 system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.45)}
.ap-head{display:flex;align-items:center;gap:6px;padding:7px 8px;cursor:pointer}
.ap-head b{font-size:13px}
.ap-chip{flex:1;text-align:right;color:#9fb3c3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ap-chip.on{color:#69f0ae}.ap-chip.warn{color:#ffd54f}.ap-chip.bad{color:#ff8a80}
.ap-body{padding:0 8px 8px}
.ap-nums{display:grid;grid-template-columns:1fr 1fr;gap:4px 8px;margin:6px 0}
.ap-nums div{display:flex;flex-direction:column}.ap-nums span{color:#9fb3c3;font-size:10.5px}
.ap-nums b{font-size:15px;font-variant-numeric:tabular-nums}
.ap-btns{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin:6px 0}
.ap-panel button{min-height:40px;border-radius:7px;border:1px solid rgba(232,239,244,.28);background:#1c3349;color:#e8eff4;
  font:600 13px system-ui,sans-serif;cursor:pointer;padding:4px 6px}
.ap-panel button:disabled{opacity:.38;cursor:default}
.ap-panel button.ap-on{background:#2e7d32;border-color:#69f0ae}
.ap-panel button.ap-go{background:#0277bd}
.ap-panel button.ap-stop{background:#8e2424}
.ap-wide{width:100%}
.ap-sec{border-top:1px solid rgba(232,239,244,.15);margin-top:7px;padding-top:6px}
.ap-row{display:flex;gap:5px;margin-top:5px}.ap-row button{flex:1}
.ap-day{margin-top:5px;display:flex;flex-direction:column;gap:3px}
.ap-day button{min-height:32px;text-align:left;font-weight:500}
.ap-day button.ap-cur{border-color:#ff4081;background:#3a1a2a}
.ap-msg{margin-top:6px;color:#ffd54f;min-height:1em}.ap-msg.bad{color:#ff8a80}
.ap-ask{background:#263d55;border:2px solid #ffd54f;border-radius:8px;padding:8px;margin:6px 0}
.ap-ask b{display:block;font-size:14px}.ap-ask p{margin:4px 0;color:#cfd8dc}
.ap-muted{color:#9fb3c3}
.ap-toggle a{display:block;width:30px;height:30px;line-height:30px;text-align:center;font-size:18px;background:#fff;color:#000;text-decoration:none}
`;

function build() {
  const m = map();
  if (!m || S.built) return;
  S.built = true;
  const st = document.createElement('style');
  st.textContent = CSS;
  document.head.appendChild(st);

  const Toggle = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const d = L.DomUtil.create('div', 'leaflet-bar ap-toggle');
      d.innerHTML = '<a href="#" title="Autopilot" role="button" aria-label="Autopilot">🧭</a>';
      L.DomEvent.disableClickPropagation(d);
      d.firstChild.addEventListener('click', (e) => { e.preventDefault(); toggle(); });
      return d;
    },
  });
  new Toggle().addTo(m);

  // THE BUTTONS ARE NOT REDRAWN WITH THE NUMBERS. Lines come two or three a second; a button whose
  // element is replaced between the finger going down and coming up gets no click, and Stop has to
  // work the first time. So each part is its own box, rewritten only when its own text changes:
  // the numbers every line, the buttons when the mode does.
  const el = document.createElement('div');
  el.className = 'ap-panel';
  el.style.display = 'none';
  el.innerHTML = '<div class="ap-head" data-ap="fold"><b>🧭 Autopilot</b><span class="ap-chip"></span><span class="ap-muted ap-arrow">▾</span></div>'
    + `<div class="ap-body">${PARTS.map((p) => `<div data-part="${p}"></div>`).join('')}</div>`;
  S.parts = {};
  for (const p of PARTS) S.parts[p] = el.querySelector(`[data-part="${p}"]`);
  S.chipEl = el.querySelector('.ap-chip');
  S.arrowEl = el.querySelector('.ap-arrow');
  S.bodyEl = el.querySelector('.ap-body');
  m.getContainer().appendChild(el);
  L.DomEvent.disableClickPropagation(el);
  L.DomEvent.disableScrollPropagation(el);
  el.addEventListener('click', onPanelClick);
  el.addEventListener('change', (e) => {
    if (e.target && e.target.matches('[data-ap="loop"]')) { S.tapLoop = e.target.checked; drawTap(); }
  });
  S.el = el;
  m.on('click', onMapClick);
  m.on('dblclick', () => clearTimeout(S.clickTimer));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wakeLock(); });
  setInterval(async () => { if (S.open) { S.logCount = await countLines(); render(); } }, 15000);
  // A plan built while the panel is open, with no line coming in, still lights "Send the plan".
  setInterval(() => { if (S.open) render(); }, 2000);
}

function toggle() {
  S.open = !S.open;
  if (S.el) S.el.style.display = S.open ? '' : 'none';
  if (S.open) countLines().then((n) => { S.logCount = n; render(); });
  wakeLock();
  render();
}

async function onPanelClick(e) {
  const a = e.target.closest('[data-ap],[data-ap-cmd],[data-ap-piece],[data-ap-option]');
  if (!a) return;
  if (a.hasAttribute('data-ap-cmd')) {
    const c = a.getAttribute('data-ap-cmd');
    if (c === 'R') {
      ask({ text: 'Park: pull the rod all the way in?', sub: 'Steering stops. Use it to lift the motor with the pin out.',
            yesLabel: 'Park', yes: () => send('R').catch((er) => say(er.message, true)) });
      return;
    }
    if (c === 'G' && S.day) S.ask = null;
    send(c).catch((er) => say(er.message, true));
    return;
  }
  if (a.hasAttribute('data-ap-piece')) { startPiece(Number(a.getAttribute('data-ap-piece'))); return; }
  if (a.hasAttribute('data-ap-option')) { sendOption(Number(a.getAttribute('data-ap-option'))); return; }
  const what = a.getAttribute('data-ap');
  if (what === 'fold') { S.folded = !S.folded; render(); }
  else if (what === 'close') toggle();
  else if (what === 'connect') {
    try { await link().connect(); } catch (er) { if (!/cancel/i.test(er.message)) say(`Not connected: ${er.message}`, true); }
  } else if (what === 'disconnect') link().disconnect();
  else if (what === 'tap') setTapping(!S.tapping);
  else if (what === 'undo') { S.tapPts.pop(); drawTap(); render(); }
  else if (what === 'clear') { S.tapPts = []; drawTap(); render(); }
  else if (what === 'send-tap') sendTapped();
  else if (what === 'plan') startDay();
  else if (what === 'yes') { const f = S.ask && S.ask.yes; S.ask = null; render(); if (f) f(); }
  else if (what === 'no') { S.ask = null; render(); }
  else if (what === 'log') { const n = await saveLogFile(); say(n ? `Saved ${n} lines from the day.` : 'Nothing kept yet.'); }
}

function chip() {
  const s = S.status;
  if (S.linkState === 'off') return ['Not connected', ''];
  if (S.linkState === 'connecting') return ['Connecting…', 'warn'];
  if (S.linkState === 'lost') return ['Link lost: box still steering', 'bad'];
  if (s.mode === 'following') return [`Following ${s.wp ? `${s.wp}/${s.wpOf}` : ''}`, 'on'];
  if (s.mode === 'holding') return [`Holding ${bowTrue(s.targetBox) ?? '--'}°`, 'on'];
  if (s.mode === 'paused') return ['Paused', 'warn'];
  return ['Connected, not steering', ''];
}

function render() {
  if (S.renderQueued) return;
  S.renderQueued = true;
  requestAnimationFrame(() => { S.renderQueued = false; draw(); });
}

const PARTS = ['ask', 'conn', 'nums', 'btns', 'route', 'log', 'msg'];

function put(name, html) {
  const el = S.parts && S.parts[name];
  if (el && el._html !== html) { el.innerHTML = html; el._html = html; }
}

const bluetoothHere = () => typeof navigator !== 'undefined' && !!navigator.bluetooth;

function draw() {
  drawBoat();
  if (!S.el || !S.open) return;
  const s = S.status;
  const on = S.linkState === 'on';
  const steering = s.mode === 'holding' || s.mode === 'following';
  const [chipText, chipCls] = chip();
  S.chipEl.textContent = chipText;
  S.chipEl.className = `ap-chip ${chipCls}`;
  S.arrowEl.textContent = S.folded ? '▸' : '▾';
  const showBody = !S.folded || !!S.ask;
  S.bodyEl.style.display = showBody ? '' : 'none';
  if (!showBody) return;

  const target = s.mode === 'following' ? s.aimTrue : (s.mode === 'holding' ? bowTrue(s.targetBox) : null);
  const gps = s.fix ? `${s.sats} sats · ${s.mph != null ? s.mph.toFixed(1) : '--'} mph`
    : (s.sats != null ? `no fix (${s.sats})` : '--');
  const following = s.mode === 'following';
  const askHtml = S.ask ? `<div class="ap-ask"><b>${esc(S.ask.text)}</b>${S.ask.sub ? `<p>${esc(S.ask.sub)}</p>` : ''}`
    + `<div class="ap-row"><button class="ap-go" data-ap="yes">${esc(S.ask.yesLabel || 'Yes')}</button><button data-ap="no">Not yet</button></div></div>` : '';

  const plan = dayPieces(window._planV2);
  const day = S.day;
  const dayHtml = day ? `<div class="ap-day">${day.pieces.map((p, i) => `<button data-ap-piece="${i}" class="${i === day.i ? 'ap-cur' : ''}" ${on && !S.sending ? '' : 'disabled'}>`
      + `${i === day.i ? '▶ ' : ''}${esc(p.name)} <span class="ap-muted">${distText(p.lengthM)}</span></button>`).join('')}</div>` : '';
  const opts = optionTracks();
  const optHtml = opts.length ? `<div class="ap-row">${opts.map((t) => `<button data-ap-option="${t.option}" ${on && !S.sending ? '' : 'disabled'}>Option ${t.option}</button>`).join('')}</div>` : '';
  const tapHtml = S.tapping ? `<div class="ap-muted" style="margin-top:5px">Tap the water for each point: ${S.tapPts.length} so far.</div>`
    + `<label style="display:flex;gap:6px;align-items:center;margin-top:4px"><input type="checkbox" data-ap="loop" ${S.tapLoop ? 'checked' : ''}> A loop (back to point 1 and round again)</label>`
    + `<div class="ap-row"><button data-ap="undo" ${S.tapPts.length ? '' : 'disabled'}>Undo</button><button data-ap="clear" ${S.tapPts.length ? '' : 'disabled'}>Clear</button></div>`
    + `<div class="ap-row"><button class="ap-go" data-ap="send-tap" ${on && !S.sending && S.tapPts.length > 1 ? '' : 'disabled'}>Send ${S.tapPts.length} points and follow</button></div>` : '';
  const held = s.route.n ? `${s.route.n} points, ${s.route.loop ? 'loop' : 'one way'}${S.boxRoute ? ` (${esc(S.boxRoute.label)})` : ''}` : 'none';

  put('ask', askHtml);
  put('conn', (on || S.linkState === 'lost'
      ? `<button class="ap-wide" data-ap="disconnect">Disconnect${S.link && S.link.name ? ` (${esc(S.link.name)})` : ''}</button>`
      : `<button class="ap-wide ap-go" data-ap="connect" ${S.linkState === 'connecting' || !bluetoothHere() ? 'disabled' : ''}>Connect to the box</button>`
        + (!bluetoothHere() ? '<div class="ap-msg bad">Web Bluetooth is not on here. Chrome on the phone, over https.</div>' : ''))
    + (S.linkState === 'lost' ? `<div class="ap-msg bad">${esc(S.linkWhy)}</div>` : ''));
  put('nums', `<div class="ap-nums">`
    + `<div><span>Heading</span><b>${bowTrue(s.headingBox) ?? '--'}${bowTrue(s.headingBox) != null ? '°' : ''}</b></div>`
    + `<div><span>${following ? 'Steering to' : 'Target'}</span><b>${target ?? '--'}${target != null ? '°' : ''}</b></div>`
    + `<div><span>Motor</span><b>${steering ? motorText(s.motorDeg) : '--'}</b></div>`
    + `<div><span>GPS</span><b style="font-size:12px">${esc(gps)}</b></div>`
    + (following ? `<div><span>Next point</span><b>${s.wp}/${s.wpOf} · ${distText(s.toNextM)}</b></div>`
      + `<div><span>Off the line</span><b>${offLineText(s.xteM)}</b></div>` : '')
    + `</div>`);
  put('btns', `<div class="ap-btns">`
    + `<button data-ap-cmd="H" class="${steering ? 'ap-on' : ''}" ${on && !steering ? '' : 'disabled'}>Hold</button>`
    + `<button data-ap-cmd="G" class="${following ? 'ap-on' : ''}" ${on && s.route.n > 1 && !following && !S.sending ? '' : 'disabled'}>Follow</button>`
    // WHILE IT STEERS, Left and Right move the heading it holds 10 degrees. WHEN IT DOES NOT, they turn the
    // motor by hand, a step of the rod each tap (the terminal's + and -, about 1/4" or 6 degrees). Ryan,
    // 2026-11-26: "there is no way to manually steer the boat with that screen". + (extend) turns the
    // bow left on his mount (garage_test.ino, steerSign, measured 11/26).
    + (steering
      ? `<button data-ap-cmd="<" ${on ? '' : 'disabled'}>◀ Left 10°</button>`
        + `<button data-ap-cmd=">" ${on ? '' : 'disabled'}>Right 10° ▶</button>`
      : `<button data-ap-cmd="+" ${on ? '' : 'disabled'}>◀ Turn left</button>`
        + `<button data-ap-cmd="-" ${on ? '' : 'disabled'}>Turn right ▶</button>`)
    + `<button data-ap-cmd="S" class="ap-stop" ${on ? '' : 'disabled'}>Stop</button>`
    + `<button data-ap-cmd="C" ${on ? '' : 'disabled'}>Center</button>`
    + `<button data-ap-cmd="R" ${on ? '' : 'disabled'} style="grid-column:1/3">Park (rod all the way in)</button>`
    + `</div>`);
  put('route', `<div class="ap-sec"><b>Route</b> <span class="ap-muted">in the box: ${held}</span>`
    + `<div class="ap-row"><button data-ap="tap" class="${S.tapping ? 'ap-on' : ''}">${S.tapping ? 'Done tapping' : 'Tap a route'}</button>`
    + `<button data-ap="plan" ${on && !S.sending && plan.length ? '' : 'disabled'} title="${plan.length ? `${plan.length} pieces` : 'no plan on the map'}">Send the plan</button></div>`
    + tapHtml + dayHtml + optHtml + `</div>`);
  put('log', `<div class="ap-sec"><span class="ap-muted">Log: ${S.logCount} lines on this phone</span>`
    + `<div class="ap-row"><button data-ap="log">Save the day's log</button></div></div>`);
  put('msg', `<div class="ap-msg ${S.msgBad ? 'bad' : ''}">${esc(S.msg)}</div>`);
}

// ── START ────────────────────────────────────────────────────────────────────────────────────────
(function waitForMap() {
  let tries = 0;
  const t = setInterval(() => {
    tries += 1;
    if (state.MAP_OK && state.MAP && typeof L !== 'undefined') { clearInterval(t); build(); }
    else if (tries > 240) clearInterval(t);
  }, 500);
}());

// For the console and the tests: what the panel holds, and a way to hand it a line as if the box sent it.
if (typeof window !== 'undefined') { window._autopilot = S; S.feed = onLine; }
