/**
 * plan-channels.js — where a fitted lane runs IN a channel, measured off the chart.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * Ryan, 2026-10-01, on Lake Marion from Rowland Subdivision, with the 28-30 ft water down the
 * middle of Wyboo Creek and along its east-west channel drawn on a screenshot: *"why does there
 * need to be some sort of structure to draw a trolling lane? just the fact that it is a deep creek
 * channel is structure in itself... it is called out as something to fish for striper"*. Then:
 * *"I just want that water in the middle of the creek and the east to west channel to be offered
 * in smart plan... Whatever the best method is to get it added"*.
 *
 * The app had a word for a channel and could not see this one. `relief` is one word for a whole
 * lane, from `build_water_features.py classify()`: `channel_edge` when water 15 ft deeper is within
 * 250 m. That is a lane on a bank above a river channel. Wyboo's channel is a trough a few feet
 * deeper than the flats around it -- under the 28-29 ft lines the bottom only reaches 31-34 -- so
 * the lanes down its middle were tagged `flat` and `break`, and Smart Plan, which builds a leg
 * around the things a lane passes, had nothing to build one on.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE RULE, AND WHERE ITS TWO NUMBERS COME FROM
 *
 * A station of a lane is IN A CHANNEL when, looking straight out from the lane on EACH side, the
 * bottom comes up more than `FLAT_DROP_FT` above the water under the line within
 * `RELIEF_RADIUS_M`. Water that rises on both sides is a trough, and a trough is a channel: a
 * creek bed, the cut between an island and the bank, the middle of a cove's old creek.
 *
 * Neither number is new. `RELIEF_RADIUS_M` (250 m) is the radius the relief word is already
 * measured over, pinned to the Python defaults by its own test. `FLAT_DROP_FT` (4 ft) is
 * `classify()`'s own line between `flat` and everything else: a rise of 4 ft or less is what the
 * app already calls flat. The probe steps out at the lane's own envelope half-width, the 25 m the
 * boat wanders, because that is the finest spacing anything else in the pack is measured at.
 *
 * A probe that lands outside every depth area is counted as 0 ft: past the edge of the charted
 * water is the bank, and the bank is the strongest rise there is.
 *
 * It is a pipeline measurement. The depth areas are the biggest file in a pack (51 MB on Marion)
 * and Smart Plan deliberately never downloads them, so `Scripts/stamp_channels.mjs` runs this
 * once per pack and ships the answer as `channels.json`.
 */

import { RELIEF_RADIUS_M } from './plan-pieces.js';

export { RELIEF_RADIUS_M };

/**
 * `build_water_features.py classify()`: `if drop <= 4: return 'flat'`. Copied, not chosen; the test
 * reads the Python and goes red the day it moves.
 */
export const FLAT_DROP_FT = 4;

/** The kind a channel hit carries in a lane's `near` list. */
export const CHANNEL_KIND = 'channel';

const KY = 110540;
const kxAt = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

/**
 * The stretches of one fitted lane that run in a channel, as [fromM, toM] along the lane.
 *
 * @param {object}   run      a trolling_runs feature with `envelope_line_ft` and `envelope_step_m`
 * @param {function} depthAt  ([lon, lat]) => ft | {ft} | null, the app's depthSampler()
 * @param {object}   [o]
 * @param {number}   [o.radiusM]  defaults to RELIEF_RADIUS_M
 * @param {number}   [o.riseFt]   defaults to FLAT_DROP_FT
 * @param {number}   [o.probeM]   defaults to the lane's own `envelope_m`, else 25
 * @returns {number[][]}
 */
export function channelStretches(run, depthAt, o = {}) {
  const p = (run && run.properties) || {};
  const coords = run && run.geometry && run.geometry.coordinates;
  const line = p.envelope_line_ft;
  if (!Array.isArray(coords) || coords.length < 2 || !Array.isArray(line) || !line.length) return [];
  const step = Number(p.envelope_step_m) || 40;
  const radiusM = o.radiusM ?? RELIEF_RADIUS_M;
  const riseFt = o.riseFt ?? FLAT_DROP_FT;
  const probeM = o.probeM ?? (Number(p.envelope_m) || 25);
  const kx = kxAt(coords[0][1]);

  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + Math.hypot((coords[i][0] - coords[i - 1][0]) * kx,
                                     (coords[i][1] - coords[i - 1][1]) * KY));
  }
  const total = cum[cum.length - 1];
  let seg = 1;
  const at = (m) => {
    // Stations are asked in order, so the segment search only ever moves forward.
    if (m < cum[seg - 1]) seg = 1;
    while (seg < coords.length - 1 && cum[seg] < m) seg++;
    const a = coords[seg - 1], b = coords[seg];
    const L = cum[seg] - cum[seg - 1] || 1;
    const u = Math.max(0, Math.min(1, (m - cum[seg - 1]) / L));
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  };
  const ftAt = (q) => {
    const d = depthAt(q);
    const v = d && typeof d === 'object' ? d.ft : d;
    return Number.isFinite(v) ? v : 0;
  };

  const flags = new Array(line.length).fill(false);
  for (let s = 0; s < line.length; s++) {
    const own = line[s];
    if (!(own > 0)) continue;
    const m = Math.min(s * step, total);
    const q = at(m);
    const q0 = at(Math.max(0, m - step));
    const q1 = at(Math.min(total, m + step));
    let dx = (q1[0] - q0[0]) * kx, dy = (q1[1] - q0[1]) * KY;
    const L = Math.hypot(dx, dy);
    if (!(L > 0)) continue;
    dx /= L; dy /= L;
    // Left of travel is (-dy, dx), right is (dy, -dx); each side's shallowest within the radius.
    let left = Infinity, right = Infinity;
    for (let off = probeM; off <= radiusM + 1e-9; off += probeM) {
      left = Math.min(left, ftAt([q[0] + (-dy * off) / kx, q[1] + (dx * off) / KY]));
      right = Math.min(right, ftAt([q[0] + (dy * off) / kx, q[1] + (-dx * off) / KY]));
      // Both sides already rise far enough: nothing further out can undo it.
      if (own - left > riseFt && own - right > riseFt) break;
    }
    flags[s] = own - Math.max(left, right) > riseFt;
  }

  const out = [];
  for (let i = 0; i < flags.length;) {
    if (!flags[i]) { i++; continue; }
    let j = i;
    while (j + 1 < flags.length && flags[j + 1]) j++;
    out.push([Math.round(i * step), Math.round(Math.min(j * step, total))]);
    i = j + 1;
  }
  return out;
}

/**
 * Near-shaped hits along each stretch, one every `stepM`, so a window can be seeded on the channel
 * and grow along it the way it grows along a line of docks. They are scored ONCE per window (see
 * scoreWindow() in plan-candidates.js): the channel is the water, not a thing in it.
 */
export function channelHits(stretches, stepM) {
  const out = [];
  if (!Array.isArray(stretches) || !(stepM > 0)) return out;
  for (const [a, b] of stretches) {
    for (let s = a; s < b; s += stepM) out.push({ s, t: CHANNEL_KIND, d: 0 });
    out.push({ s: b, t: CHANNEL_KIND, d: 0 });
  }
  return out;
}

/** Metres of [fromM, toM] that lie in the stretches. */
export function channelMetres(stretches, fromM, toM) {
  let m = 0;
  for (const [a, b] of (stretches || [])) m += Math.max(0, Math.min(b, toM) - Math.max(a, fromM));
  return m;
}
