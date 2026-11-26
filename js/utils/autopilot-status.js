/**
 * autopilot-status.js -- what the steering box is doing, read off the lines it sends.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * The box (firmware garage_test.ino, 2026-11-26) talks in lines, the same ones the terminal app shows:
 *
 *   HDG 213 47uT r0 q0 GPS s9 2.1mph c128 h0.9 33.91829,-80.38016    every 2 s (1 s while the rod moves)
 *   HOLD 214 h213 e+1 r+0 m+2 g1.0      every second while holding: target, heading, error, turn rate,
 *                                       motor angle (+ = turning right), speed gain
 *   FOLLOW wp 3/12 d140 x-4 aim 128     every second while following: the point it is heading for, metres
 *                                       to it, metres off the line (+ = right of it), the TRUE bearing it steers
 *   2003mV IS0 -100                     every second: the rod's pot, the current sense, the move, the speed
 *   and events: HOLD on / HOLD to / HOLD off: why / FOLLOW on: / FOLLOW off: / LAP / END: / ROUTE ... /
 *   WP n / NO: why / POT FAULT ...
 *
 * THE BOX'S HEADING IS NOT THE BOW'S. HDG and HOLD read the board's Y arrow, magnetic, and the arrow
 * points 90 degrees right of the bow (ARROW_DEG); magnetic north is 8.2 degrees west of true at Sumter
 * (DECL_DEG, WMM2025). The firmware's own conversion is trueToHdg(t) = t - DECL + 90, so the bow's
 * TRUE heading -- the one the map and the GPS course use -- is HDG + DECL - 90. Both constants are the
 * firmware's; change them there and here together.
 */
export const DECL_DEG = -8.2;
export const ARROW_DEG = 90;

const wrap = (d) => ((d % 360) + 360) % 360;
/** The bow's true heading from a number the box reports (HDG, or a HOLD target). */
export const bowTrue = (boxDeg) => (Number.isFinite(boxDeg) ? wrap(Math.round(boxDeg + DECL_DEG - ARROW_DEG)) : null);

export function newStatus() {
  return {
    mode: 'off',            // off | holding | following | paused
    headingBox: null,       // the box's own number (arrow, magnetic)
    targetBox: null,
    aimTrue: null,          // while following: the true bearing it steers
    motorDeg: null,         // + = turning right
    sats: null, fix: false, mph: null, courseDeg: null, lat: null, lon: null,
    wp: null, wpOf: null, toNextM: null, xteM: null,
    route: { n: 0, loop: false },
    wpAck: 0,               // the last "WP n"
    potMv: null,
    lastFollowAt: 0,
    flat: false,            // L: learning the compass on the boat (one flat circle)
    flatTurned: 0,          // degrees of that circle turned through so far
    trim: null,             // B: the box's saved heading trim, degrees
  };
}

/**
 * Read one line into `s` (changed in place). Returns an event for the lines that are news, else null:
 * {type: 'lap'|'end'|'no'|'hold-on'|'hold-off'|'paused'|'follow-on'|'follow-off'|'route'|'cleared'|'wp'|'wp-bad'|'fault', text}
 */
export function applyLine(s, line, now = Date.now()) {
  const t = String(line || '').trim();
  if (!t) return null;
  let m;
  if ((m = /^HDG (\d+)\b/.exec(t))) s.headingBox = Number(m[1]);
  else if (/^HDG [?-]/.test(t)) s.headingBox = null;
  if (/^HDG /.test(t)) {
    if ((m = /GPS s(\d+) ([\d.]+)mph c(\d+) h[\d.]+ (-?[\d.]+),(-?[\d.]+)/.exec(t))) {
      s.sats = Number(m[1]); s.mph = Number(m[2]); s.courseDeg = Number(m[3]);
      s.lat = Number(m[4]); s.lon = Number(m[5]); s.fix = true;
    } else if ((m = /GPS nofix s(\d+)/.exec(t))) { s.sats = Number(m[1]); s.fix = false; s.mph = null; }
    else if (/GPS --/.test(t)) { s.sats = null; s.fix = false; s.mph = null; }
    return null;
  }
  if ((m = /^HOLD (\d+) h(\d+) e([+-]?\d+) r([+-]?\d+) m([+-]?\d+)/.exec(t))) {
    s.targetBox = Number(m[1]); s.headingBox = Number(m[2]); s.motorDeg = Number(m[5]);
    if (s.mode !== 'following' || now - s.lastFollowAt > 3000) s.mode = 'holding';
    return null;
  }
  if ((m = /^FOLLOW wp (\d+)\/(\d+) d(\d+) x([+-]?\d+) aim (\d+)/.exec(t))) {
    s.mode = 'following'; s.lastFollowAt = now;
    s.wp = Number(m[1]); s.wpOf = Number(m[2]); s.toNextM = Number(m[3]); s.xteM = Number(m[4]);
    s.aimTrue = Number(m[5]);
    return null;
  }
  if ((m = /^(\d+)mV IS\d+ /.exec(t))) { s.potMv = Number(m[1]); return null; }
  if ((m = /^HOLD on (\d+)/.exec(t))) { s.mode = 'holding'; s.targetBox = Number(m[1]); return { type: 'hold-on', text: t }; }
  if ((m = /^HOLD to (\d+)/.exec(t))) { s.targetBox = Number(m[1]); return null; }
  if (/^HOLD off:/.test(t)) {
    s.mode = /rejoin/.test(t) ? 'paused' : 'off';
    s.motorDeg = null;
    return { type: s.mode === 'paused' ? 'paused' : 'hold-off', text: t };
  }
  if ((m = /^FOLLOW on: (\d+) points, (loop|one way)/.exec(t))) {
    s.mode = 'following'; s.lastFollowAt = now;
    s.route = { n: Number(m[1]), loop: m[2] === 'loop' };
    return { type: 'follow-on', text: t };
  }
  if (/^FOLLOW off/.test(t)) { s.mode = 'holding'; s.wp = null; return { type: 'follow-off', text: t }; }
  if (t === 'LAP') return { type: 'lap', text: t };
  if (/^END\b/.test(t)) { s.mode = 'holding'; s.wp = null; return { type: 'end', text: t }; }
  if (/^ROUTE cleared/.test(t)) { s.route = { n: 0, loop: false }; s.wpAck = 0; return { type: 'cleared', text: t }; }
  if ((m = /^ROUTE (\d+) points, (loop|one way)/.exec(t))) {
    s.route = { n: Number(m[1]), loop: m[2] === 'loop' };
    return { type: 'route', text: t };
  }
  if ((m = /^WP (\d+)$/.exec(t))) { s.wpAck = Number(m[1]); return { type: 'wp', text: t }; }
  if (/^WP (bad|full)/.test(t)) return { type: 'wp-bad', text: t };
  if (/^NO: /.test(t)) return { type: 'no', text: t.slice(4) };
  if (/^POT FAULT/.test(t)) return { type: 'fault', text: t };
  // The compass on the boat (L, B; firmware 11/26): progress quietly, the rest said.
  if ((m = /^LEARN boat: \d+ readings, turned through (\d+)/.exec(t))) { s.flatTurned = Number(m[1]); return null; }
  if (/^LEARN boat on/.test(t)) { s.flat = true; s.flatTurned = 0; return { type: 'compass', text: t }; }
  if (/^LEARN boat off/.test(t)) { s.flat = false; return { type: 'compass', text: t }; }
  if ((m = /^compass cal .* trim ([+-]?[\d.]+)/.exec(t))) { s.trim = Number(m[1]); return null; }
  if ((m = /^TRIM ([+-][\d.]+)/.exec(t))) { s.trim = Number(m[1]); return { type: 'compass', text: t }; }
  if (/^TRIM cleared/.test(t) || /^CAL saved/.test(t)) { s.trim = 0; return { type: 'compass', text: t }; }
  if (/^(boat pull|not a full circle|fit (failed|out of range)|BOW bad|[KL] is learning)/.test(t)) return { type: 'compass', text: t };
  return null;
}

/** "12 ft right" / "on the line". `xteM` is + to the right of the line, facing along it. */
export function offLineText(xteM) {
  if (!Number.isFinite(xteM)) return '--';
  const ft = Math.round(Math.abs(xteM) * 3.28084);
  return ft < 3 ? 'on the line' : `${ft} ft ${xteM > 0 ? 'right' : 'left'}`;
}

/** "140 yd" up to a quarter mile, then miles. */
export function distText(m) {
  if (!Number.isFinite(m)) return '--';
  return m < 402 ? `${Math.round(m * 1.09361)} yd` : `${(m / 1609.34).toFixed(2)} mi`;
}

/** "8° right" -- the way the motor is turned; + is right. */
export function motorText(deg) {
  if (!Number.isFinite(deg)) return '--';
  return deg === 0 ? 'straight' : `${Math.abs(deg)}° ${deg > 0 ? 'right' : 'left'}`;
}
