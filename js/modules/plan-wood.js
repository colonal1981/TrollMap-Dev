/**
 * THE WOOD UNDER A TROLLING PASS, AND WHAT IT IS TO EACH ROD: HIS RULE.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 2026-10-31: *"we could avoid them on the trolling passes if we know that are bait would be
 * lower than the object... but if the bait is running higher than the object as you pointed out fish
 * like to sit right on top of those so that gives us a target possibly"*. And 2026-11-03, his two
 * numbers: the lures pass within 10 ft of his track, and he wants 5 ft between a lure and the top of
 * the wood, *"because i actually have no idea how deep my lures are"*. Both are in js/utils/wood.js.
 *
 * Called once per troll leg from assemblePlan(), after capBaitDepth(), so both planners get it. It
 * reads; it moves nothing. A snag is said on the leg -- he picks those rods up or switches them for
 * that stretch -- and the line stays where it is. Steering a leg off wood is a later step.
 *
 *   1. The wood the lures pass over: every piece within his 10 ft of the leg's line, as it is run,
 *      measured to the nearest point of the line. It counts for BOTH rods, whichever side it is on:
 *      the position is a kayak GPS fix good to a few metres, which is more than the gap between his
 *      two lines, so the app does not give a piece to one side.
 *   2. The piece's top today (topToday() in wood.js).
 *   3. Each deployed rod's deep end: the max of rodWindowOnLeg(), the same window sonarContingency()
 *      reads, so the two can never disagree about how deep one rod runs on one leg.
 *   4. Target for that rod when the top today is 5 ft or more below its deep end; a snag otherwise.
 *      A piece with no top is a snag for every rod. A rod whose depth the app cannot measure is
 *      counted as running below -- the desktop's call, not his, and the sentence says so.
 */
import { metresBetween } from './plan-candidates.js';
import { HIS_PASS_M, HIS_CLEAR_FT, topToday, topBasis, ftText, kindText } from '../utils/wood.js';

/**
 * Where `pt` falls on the polyline `coords`: metres along it to the nearest point, and metres off.
 *
 * Each segment is measured in a flat frame about `pt`, scaled by the app's own metresBetween() so a
 * metre here is a metre everywhere else in the plan. At the scale that matters -- his 10 ft -- the
 * flat frame is exact to far better than the GPS fix it is measuring.
 */
export function nearestOnLine(coords, pt) {
  const c = Array.isArray(coords) ? coords.filter((p) => Array.isArray(p) && p.length >= 2) : [];
  if (!c.length || !Array.isArray(pt)) return null;
  const d = 1e-3;
  const kx = metresBetween([pt[0], pt[1]], [pt[0] + d, pt[1]]) / d;
  const ky = metresBetween([pt[0], pt[1]], [pt[0], pt[1] + d]) / d;
  const xy = (p) => [(p[0] - pt[0]) * kx, (p[1] - pt[1]) * ky];
  if (c.length === 1) return { atM: 0, offM: metresBetween(c[0], pt) };
  let best = null;
  let along = 0;
  for (let i = 1; i < c.length; i++) {
    const [ax, ay] = xy(c[i - 1]);
    const [bx, by] = xy(c[i]);
    const vx = bx - ax, vy = by - ay;
    const len2 = vx * vx + vy * vy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / len2)) : 0;
    const px = ax + t * vx, py = ay + t * vy;
    const off = Math.hypot(px, py);
    const segM = metresBetween(c[i - 1], c[i]);
    if (!best || off < best.offM) best = { atM: along + t * segM, offM: off };
    along += segM;
  }
  return best;
}

/**
 * EVERY PIECE THE LURES PASS OVER ON THIS LEG, AND WHAT IT IS TO EACH ROD IN THE WATER.
 *
 * @param {object}   o
 * @param {number[][]} o.coords     the leg's line, drawn the way it is run
 * @param {object[]} o.pieces       woodPieces() of the pack's wood.geojson
 * @param {object}   o.deploy       { port, starboard } rod ids, or null
 * @param {object[]} o.rods         the loadout
 * @param {function} o.windowFor    (rod) => { min, max } | null -- rodWindowOnLeg() bound to the leg
 * @param {number|null} o.belowTodayFt  belowFullPoolTodayFt() of the plan's waterState
 * @returns {object[]} [{ id, kind, what, at, atM, offM, topTodayFt, topBasis,
 *                        rods: [{ rodId, deepFt, verdict }] }], in the order the boat meets them.
 *          [] for a leg with no rods in the water, a leg with no line, or no wood.
 */
export function woodOnLeg(o) {
  const pieces = (o && o.pieces) || [];
  const deploy = o && o.deploy;
  if (!pieces.length || !deploy) return [];
  const ids = [...new Set([deploy.port, deploy.starboard].filter(Boolean))];
  if (!ids.length) return [];
  const rods = (o.rods || []);
  const deep = ids.map((rodId) => {
    const rod = rods.find((r) => r && r.id === rodId);
    let w = null;
    try { w = rod && typeof o.windowFor === 'function' ? o.windowFor(rod) : null; } catch { w = null; }
    const max = w && Number(w.max);
    return { rodId, deepFt: Number.isFinite(max) ? max : null };
  });
  const out = [];
  for (const p of pieces) {
    const hit = nearestOnLine(o.coords, p.at);
    if (!hit || !(hit.offM <= HIS_PASS_M)) continue;
    const top = topToday(p, o.belowTodayFt);
    out.push({
      id: p.id, kind: p.kind, what: kindText(p),
      // Where the piece is, for an export that draws it (the ADM's optional rings). Never a waypoint.
      at: p.at,
      atM: Math.round(hit.atM), offM: Math.round(hit.offM * 10) / 10,
      topTodayFt: top ? top.ft : null,
      topBasis: topBasis(top),
      rods: deep.map(({ rodId, deepFt }) => ({
        rodId, deepFt,
        // To the hundredth before comparing, so 10.3 - 5.3 is 5 and not 4.999999.
        verdict: top && deepFt != null && Math.round((top.ft - deepFt) * 100) / 100 >= HIS_CLEAR_FT
          ? 'target' : 'snag',
      })),
      // For the sentence only: what the top was brought from. Not part of the leg's contract.
      _top: top,
    });
  }
  return out.sort((a, b) => a.atM - b.atM);
}

/** "top 6.5 ft today (his read of 11/2 was at 2.43 ft below full pool; today is 3.43)" */
function topSentence(e) {
  const t = e._top;
  if (!t) return null;
  if (t.basis === 'today') {
    const moved = t.belowThenFt != null && t.belowTodayFt != null && t.belowThenFt !== t.belowTodayFt;
    return `top ${ftText(t.ft)} ft at today's level (read on ${t.readOn}`
         + (moved ? ` with the lake ${ftText2(t.belowThenFt)} ft below full pool; it is `
                    + `${ftText2(t.belowTodayFt)} below today)` : `, the lake at the same level as today)`);
  }
  return `top ${ftText(t.ft)} ft as read on ${t.on || 'an unknown day'}, not brought to today's level `
       + (t.belowThenFt == null ? '(the app has no level for this water)'
                                : '(today\'s level is not in hand)');
}
const ftText2 = (v) => String(Math.round(v * 100) / 100);

const rodDepthText = (r) => (r.deepFt == null
  ? `${r.rodId} has no depth the app can measure, so it is counted as running below it`
  : `${r.rodId} runs to ${ftText(r.deepFt)} ft`);
/** "R1 runs to 5 ft, 1.5 ft over its top" / "R2 runs to 12 ft, 5.5 ft below its top" */
const rodAgainstTop = (r, topFt) => {
  if (r.deepFt == null) return rodDepthText(r);
  const gap = Math.round((topFt - r.deepFt) * 10) / 10;
  return `${rodDepthText(r)}, ${gap > 0 ? `${ftText(gap)} ft over its top`
    : gap < 0 ? `${ftText(-gap)} ft below its top` : 'level with its top'}`;
};

/**
 * THE WARNING ON THE LEG, for a piece that is a snag to any rod in the water: where it is, what it
 * is, its top today and how that was got, which rods run below it and how deep they run. Null for a
 * piece every rod clears -- that one is a target and is said by its cue.
 *
 * @param {string} runId
 * @param {object} e        one entry of woodOnLeg()
 * @param {string} place    "about 120 m into the pass" -- riseSentence(), placed by the caller
 */
export function woodWarning(runId, e, place) {
  const snags = e.rods.filter((r) => r.verdict === 'snag');
  if (!snags.length) return null;
  const clear = e.rods.filter((r) => r.verdict === 'target');
  const them = snags.length === 1 ? 'it' : 'them';
  const where = `${runId}: wood ${place}, ${e.offM > 0 ? `${e.offM} m off your line` : 'on your line'}`
              + ` -- ${e.what}`;
  const tail = `${snags.length === 1 ? 'Pick it up' : 'Pick them up'} or switch ${them} for that stretch.`;
  if (e.topTodayFt == null) {
    const why = e.kind === 'unsure'
      ? 'the two reads of its picture do not agree, so its top is not known'
      : 'it has never been gone over, so its top is not known';
    return `${where}. ${why[0].toUpperCase()}${why.slice(1)}, and it is counted as a snag for every `
         + `rod: ${snags.map(rodDepthText).join(', ')}. ${tail}`;
  }
  return `${where}, ${topSentence(e)}. ${snags.map((r) => rodAgainstTop(r, e.topTodayFt)).join('; ')}`
       + ` -- less than your ${HIS_CLEAR_FT} ft. `
       + (clear.length ? `${clear.map((r) => `${r.rodId} at ${ftText(r.deepFt)} ft clears it by `
                                          + `${ftText(e.topTodayFt - r.deepFt)} ft`).join(', ')}. ` : '')
       + tail;
}

/**
 * THE CUE, one spread-length before the piece, for a target and a snag alike. A target reads like
 * "wood under you, top 7 ft, your lures at 2".
 */
export function woodCueText(e, spreadM) {
  const snags = e.rods.filter((r) => r.verdict === 'snag');
  const lures = e.rods.filter((r) => r.deepFt != null).map((r) => r.deepFt);
  if (!snags.length) {
    return `wood under you, top ${ftText(e.topTodayFt)} ft, your lures at `
         + `${ftText(Math.max(...lures))}`;
  }
  const ids = snags.map((r) => r.rodId);
  const pick = `pick up or switch ${ids.join(' and ')}`;
  if (e.topTodayFt == null) {
    return `wood in ${spreadM} m, ${e.kind === 'unsure' ? 'read two ways' : 'never gone over'}, `
         + `top not known -- ${pick}`;
  }
  return `wood in ${spreadM} m, top ${ftText(e.topTodayFt)} ft${e.topBasis === 'today' ? '' : ` ${e.topBasis}`}`
       + `, ${snags.map((r) => (r.deepFt == null ? `${r.rodId} depth unknown`
                                                  : `${r.rodId} at ${ftText(r.deepFt)}`)).join(', ')}`
       + ` -- ${pick}`;
}

/** The leg's own copy: the contract fields, without the sentence's working. */
export function woodForLeg(entries) {
  return entries.map(({ _top, ...e }) => e);
}
