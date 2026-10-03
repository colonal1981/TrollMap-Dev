/**
 * plan-troll-day.js — the day trolled the way Ryan trolls it.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT HE SAID
 *
 * Ryan, 2026-10-03, on a Smart Plan that sent him across Lake Moultrie between twenty short legs:
 *
 *   > Honestly i just troll... i don't jump from spot to spot to spot... very rarely unless i am
 *   > trying to get to a specific spot do i just run without the lines out... i keep an eye on the
 *   > map to make sure i do not go to shallow for the baits i am running and i just troll.
 *   > ... you can go down one until it starts to get shallow then run back the other way a bit
 *   > deeper.
 *
 * and then the reason this exists at all:
 *
 *   > my problem is i am basically having to draw out how i troll for every lake we talk about...
 *   > there doesn't seem to be an automated way to troll
 *
 * The rule below was drawn on his Oct 3 day first (claude/HOW_HE_TROLLS_AND_WHERE_THE_LANES_BREAK
 * _2026-10-03.md, "Drawn, 10/3"), before any of it went into the app: in the same moving time it
 * trolled 18.9-19.7 km in one line with 1.9-3.2 km with lines up, against the plan's 16.1 km in
 * twenty pieces with 9.1 km with lines up. He said "Yes build that and then start the actual lane
 * work".
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE RULE, AND WHERE EVERY PART OF IT COMES FROM
 *
 * WHOLE PIECES. The water is Pick Water's own pieces (plan-pieces.js) -- each is already "a stretch
 * of water you can fish without touching the rods" -- and each one taken is trolled end to end.
 *
 * WATER DEEP ENOUGH FOR THE DEEPEST BAIT. `floorFt` comes in from the caller: the deep edge of the
 * day's fish band, because the spread is stacked through that band and the deepest rod is what
 * touches first. A piece is in the day only if it holds that much water. Nothing here picks it.
 *
 * EACH PASS STARTS WHERE THE LAST ONE ENDED. From the end of a piece, the next is the nearest end of
 * a piece the boat can reach WITH THE BAITS STILL IN: a straight hop
 *   - whose shallowest charted water, sounded every envelope step along it with the same
 *     depth_areas sampler Pick Water's joins use, is no shallower than the shallower of the two
 *     pieces holds -- one bait covers both, which is his own rule for a join: "One run only if one
 *     bait covers it." Uncharted water fails, as it does everywhere in this app;
 *   - that does not cross the charted shore (garmin_shoreline, as fit_trolling_runs' ChartedShore
 *     reads it: an outline standing free in the water is steered round, one joined to the rest of
 *     the shore is a wall -- the Pinopolis wall);
 *   - and that does not enter a keep-out zone (keep_out.geojson, build_keep_out_zones.py): *"It's
 *     fine if the line is near the buoys I just don't want it inside of them"*.
 * Nearest, and nothing else: whichever way that is -- back the other way a bit deeper, or on along
 * the edge -- is the one beside him.
 *
 * LINES UP ONLY WHEN NOTHING CAN BE REACHED THAT WAY. Then the nearest piece, run to.
 *
 * THE DAY ENDS AT THE RAMP. A piece is taken only if, once it is trolled, the time left still covers
 * TROLLING home from its far end -- so the far point of the day is one he can troll back from, and
 * the day turns for home on its own instead of running at the end. "i want to end a lane close to
 * the ramp... i do not want to waste 3 miles heading back and not being able to fish it" (2026-09-29).
 *
 * THE BATTERY IS dayCost()'S, unchanged: the day is priced the way the Water tab's card prices it,
 * in this order, and a day that does not fit loses pieces from its end until it does.
 *
 * IT STARTS WHERE HE SAYS. A piece he ticked is the first one; with none, the piece nearest the
 * ramp. Drawn both ways, the first piece decided the whole day -- so the choice is his to make.
 *
 * Straight lines throughout, like dayCost(): the router is called when the plan is assembled, as
 * it is for every day built on this tab.
 */
import { metresBetween, minutesFor } from './plan-candidates.js';
import { dayCost, TROLL_MPH, TRANSIT_MPH } from './plan-water.js';

const M_PER_DEG_LAT = 110540.0;
const mPerDegLon = (lat) => 111320.0 * Math.cos((lat * Math.PI) / 180);

// ── THE LINES A HOP MAY NOT CROSS ───────────────────────────────────────────────────────────────

function partsOf(g) {
  if (!g) return [];
  if (g.type === 'LineString') return [g.coordinates];
  if (g.type === 'MultiLineString') return g.coordinates;
  if (g.type === 'Polygon') return g.coordinates;
  if (g.type === 'MultiPolygon') return g.coordinates.flat();
  return [];
}

function segsCross(a, b, c, d) {
  // Proper or touching intersection of ab and cd, as the parameter along ab, or null.
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (den === 0) return null;
  const q = [c[0] - a[0], c[1] - a[1]];
  const t = (q[0] * s[1] - q[1] * s[0]) / den;
  const u = (q[0] * r[1] - q[1] * r[0]) / den;
  return (t >= 0 && t <= 1 && u >= 0 && u <= 1) ? t : null;
}

/**
 * The charted shore and the keep-out zones, as one segment index.
 *
 * AN OUTLINE STANDING FREE IN THE WATER IS NOT A WALL. The fitter learned this at a cost (cutting at
 * two rows of bridge piers lost 8% of Lake Keowee's lanes): a closed shore line that touches no other
 * shore line is a pier, a rock or an islet, and a boat steers round it. Everything else in the shore
 * layer, and every zone, is kept.
 *
 * @param {object[]} shoreFeatures   garmin_shoreline.geojson features
 * @param {object[]} keepOutFeatures keep_out.geojson features
 */
export function barrierIndex(shoreFeatures, keepOutFeatures, { cellDeg = 0.002 } = {}) {
  const lines = [];
  for (const f of (shoreFeatures || [])) {
    for (const c of partsOf(f && f.geometry)) if (Array.isArray(c) && c.length >= 2) lines.push({ c, shore: true });
  }
  const zones = [];
  for (const f of (keepOutFeatures || [])) {
    for (const c of partsOf(f && f.geometry)) if (Array.isArray(c) && c.length >= 2) zones.push({ c, shore: false });
  }
  const grid = new Map();
  const segs = [];
  const add = (line, li) => {
    const c = line.c;
    for (let i = 1; i < c.length; i++) {
      const a = c[i - 1], b = c[i];
      const si = segs.push({ a, b, li }) - 1;
      for (let x = Math.floor(Math.min(a[0], b[0]) / cellDeg); x <= Math.floor(Math.max(a[0], b[0]) / cellDeg); x++) {
        for (let y = Math.floor(Math.min(a[1], b[1]) / cellDeg); y <= Math.floor(Math.max(a[1], b[1]) / cellDeg); y++) {
          const k = `${x},${y}`;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(si);
        }
      }
    }
  };
  const all = [...lines, ...zones];
  all.forEach(add);
  const near = (a, b) => {
    const out = new Set();
    for (let x = Math.floor(Math.min(a[0], b[0]) / cellDeg); x <= Math.floor(Math.max(a[0], b[0]) / cellDeg); x++) {
      for (let y = Math.floor(Math.min(a[1], b[1]) / cellDeg); y <= Math.floor(Math.max(a[1], b[1]) / cellDeg); y++) {
        for (const si of (grid.get(`${x},${y}`) || [])) out.add(si);
      }
    }
    return out;
  };
  // Which closed shore outlines stand free: they touch no segment of any OTHER shore line.
  const free = new Set();
  all.forEach((line, li) => {
    if (!line.shore) return;
    const c = line.c;
    const closed = c.length > 3 && c[0][0] === c[c.length - 1][0] && c[0][1] === c[c.length - 1][1];
    if (!closed) return;
    for (let i = 1; i < c.length; i++) {
      for (const si of near(c[i - 1], c[i])) {
        const s = segs[si];
        if (s.li === li || !all[s.li].shore) continue;
        if (segsCross(c[i - 1], c[i], s.a, s.b) !== null) return;
      }
    }
    free.add(li);
  });
  return {
    shoreLines: lines.length, zoneRings: zones.length, freeStanding: free.size,
    /** True when the straight hop a->b crosses a wall or a zone edge anywhere but at its own ends. */
    crosses(a, b) {
      const len = Math.hypot((b[0] - a[0]) * mPerDegLon(a[1]), (b[1] - a[1]) * M_PER_DEG_LAT);
      if (!(len > 0)) return false;
      const eps = Math.min(0.5, 1 / len);                 // a metre at each end: a piece cut AT the wall ends on it
      for (const si of near(a, b)) {
        const s = segs[si];
        if (free.has(s.li)) continue;
        const t = segsCross(a, b, s.a, s.b);
        if (t !== null && t > eps && t < 1 - eps) return true;
      }
      return false;
    },
  };
}

/** The shallowest charted water on the straight hop a->b, sounded every `stepM`; -1 if any of it is uncharted. */
export function hopShallowestFt(a, b, depthAt, stepM = 40) {
  const len = metresBetween(a, b);
  const n = Math.max(1, Math.ceil(len / stepM));
  let low = Infinity;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const d = depthAt([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    if (d == null || !Number.isFinite(Number(d))) return -1;
    if (d < low) low = Number(d);
  }
  return low;
}

// ── THE DAY ─────────────────────────────────────────────────────────────────────────────────────

const lengthOf = (c) => { let m = 0; for (let i = 1; i < c.length; i++) m += metresBetween(c[i - 1], c[i]); return m; };

/**
 * @param {object[]} pieces   Pick Water pieces: `key`, `coords`, `holdsFt`, `lengthM`
 * @param {object}   o
 * @param {number[]} o.ramp          [lon, lat]
 * @param {number}   o.floorFt       water the deepest bait needs -- REQUIRED, from the fish band
 * @param {function} o.depthAt       ([lon,lat]) -> ft or null: depthSampler() over depth_areas -- REQUIRED
 * @param {object}   [o.barriers]    barrierIndex(); without it no wall and no zone is known, and the result says so
 * @param {number}   o.windowMin     launch to return
 * @param {number}   [o.stopMin]     minutes held back for his stop-and-casts
 * @param {number}   [o.usableAh]    the battery dayCost() prices against
 * @param {object}   [o.windByHour]  the forecast dayCost() prices against
 * @param {string}   [o.startKey]    the piece to start on -- a piece he ticked
 * @param {function} [o.keep]        (piece) -> bool, a further filter on which pieces are water for the day
 * @param {number}   [o.stepM]       how often a hop is sounded; the pack's envelope step
 */
export function trollDay(pieces, o) {
  if (!(o && Number.isFinite(o.floorFt))) {
    throw new Error('trollDay: floorFt is required — how much water the deepest bait needs comes from the day, not from here');
  }
  if (typeof (o && o.depthAt) !== 'function') {
    throw new Error('trollDay: depthAt is required — a hop with the baits in is only a hop if the water under it was sounded');
  }
  const ramp = o.ramp;
  const trollMph = o.trollMph || TROLL_MPH, transitMph = o.transitMph || TRANSIT_MPH;
  const stepM = o.stepM || 40;
  const budget = Math.max(0, (Number(o.windowMin) || 0) - (Number(o.stopMin) || 0));
  const pool = (pieces || []).filter((p) => p && Array.isArray(p.coords) && p.coords.length >= 2
    && Number(p.holdsFt) >= o.floorFt && (!o.keep || o.keep(p)));
  const used = new Set();
  const steps = [];
  let at = ramp, atHolds = null, t = 0;
  const homeTrollMin = (pt) => minutesFor(metresBetween(pt, ramp), trollMph);

  const entries = (p) => {
    const c = p.coords;
    return [{ p, from: c[0], coords: c, reversed: false }, { p, from: c[c.length - 1], coords: c.slice().reverse(), reversed: true }];
  };
  const fits = (hopMin, coords, lenM) => budget - t - hopMin - minutesFor(lenM, trollMph) >= homeTrollMin(coords[coords.length - 1]);

  for (;;) {
    const opts = [];
    for (const p of pool) {
      if (used.has(p.key)) continue;
      if (!steps.length && o.startKey && p.key !== o.startKey) continue;
      for (const e of entries(p)) opts.push({ ...e, d: metresBetween(at, e.from) });
    }
    if (!opts.length && !steps.length && o.startKey) break;           // the ticked piece is not water for this band
    opts.sort((x, y) => x.d - y.d);
    let pick = null;
    if (steps.length) {
      for (const e of opts) {
        const lenM = e.p.lengthM || lengthOf(e.coords);
        if (!fits(minutesFor(e.d, trollMph), e.coords, lenM)) continue;
        if (o.barriers && o.barriers.crosses(at, e.from)) continue;
        const need = Math.min(atHolds, Number(e.p.holdsFt));
        const low = e.d > 0 ? hopShallowestFt(at, e.from, o.depthAt, stepM) : need;
        if (low < need) continue;
        pick = { ...e, kind: 'troll', lenM, low };
        break;
      }
    }
    if (!pick) {
      for (const e of opts) {
        const lenM = e.p.lengthM || lengthOf(e.coords);
        if (!fits(minutesFor(e.d, transitMph), e.coords, lenM)) continue;
        pick = { ...e, kind: 'run', lenM, low: null };
        break;
      }
    }
    if (!pick) break;
    const hopMin = minutesFor(pick.d, pick.kind === 'troll' ? trollMph : transitMph);
    steps.push({ kind: pick.kind, from: at, to: pick.from, m: Math.round(pick.d), shallowestFt: pick.low });
    steps.push({ kind: 'piece', key: pick.p.key, runId: pick.p.runId, holdsFt: pick.p.holdsFt,
                 m: Math.round(pick.lenM), reversed: pick.reversed, coords: pick.coords });
    used.add(pick.p.key);
    t += hopMin + minutesFor(pick.lenM, trollMph);
    at = pick.coords[pick.coords.length - 1];
    atHolds = Number(pick.p.holdsFt);
  }

  // THE BATTERY, PRICED THE WAY THE CARD PRICES IT, in this order. Pieces come off the end until it fits.
  let keys = steps.filter((s) => s.kind === 'piece').map((s) => s.key);
  const byKey = new Map(pool.map((p) => [p.key, p]));
  let cost = null, dropped = 0;
  while (keys.length) {
    const picked = keys.map((k) => byKey.get(k));
    cost = dayCost(picked, { ramp, usableAh: o.usableAh, windowMin: o.windowMin, windByHour: o.windByHour,
                             order: picked.map((_, i) => i), stopMin: o.stopMin, trollMph, transitMph });
    if (cost.fits) break;
    keys = keys.slice(0, -1);
    dropped += 1;
  }
  const kept = new Set(keys);
  const trimmed = [];
  for (let i = 0; i < steps.length; i += 2) {
    if (kept.has(steps[i + 1].key)) trimmed.push(steps[i], steps[i + 1]);
  }
  const last = trimmed.length ? trimmed[trimmed.length - 1].coords : null;
  const home = last ? Math.round(metresBetween(last[last.length - 1], ramp)) : 0;
  const sum = (k) => trimmed.filter((s) => s.kind === k).reduce((a, s) => a + s.m, 0);
  const trolledM = sum('piece') + sum('troll');
  const runM = sum('run') + home;
  return {
    keys,
    steps: trimmed,
    homeM: home,
    pieces: keys.length,
    trolledM, hopTrolledM: sum('troll'), runM,
    minutes: Math.round(minutesFor(trolledM, trollMph) + minutesFor(runM, transitMph)),
    budgetMin: Math.round(budget),
    droppedForBattery: dropped,
    cost,
    floorFt: o.floorFt,
    startKey: o.startKey || null,
    wallsKnown: !!o.barriers,
  };
}

// ── THE DAY AS BUILT ────────────────────────────────────────────────────────────────────────────

/**
 * HOW THE TROLL RUNS EACH PIECE, for the plan to be built the same way.
 *
 * "Plan it as one troll" on Lake Wateree for 2026-10-04 handed the build only `keys`, the order, and
 * threw these away -- so the plan ran every piece in its drawn direction and priced every gap the
 * troll had trolled as a run with the lines up. See trollLeg() in plan-from-water.js.
 *
 * @param {object[]} steps  trollDay()'s `steps`
 * @returns {Map<string, {reversed: boolean, onTo: ?number[], onM: number, onShallowestFt: ?number}>}
 *          per piece key: whether the troll runs it against its drawn direction, and -- where the
 *          troll trolls on into the next piece -- that piece's first point, the metres to it and the
 *          shallowest charted water on the way.
 */
export function trollShape(steps) {
  const out = new Map();
  const list = Array.isArray(steps) ? steps : [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (!s || s.kind !== 'piece') continue;
    const hop = list[i + 1], next = list[i + 2];
    const on = !!(hop && hop.kind === 'troll' && next && next.kind === 'piece' && Array.isArray(hop.to));
    out.set(s.key, {
      reversed: !!s.reversed,
      onTo: on ? hop.to : null,
      onM: on ? Number(hop.m) || 0 : 0,
      onShallowestFt: on && Number.isFinite(Number(hop.shallowestFt)) ? Number(hop.shallowestFt) : null,
    });
  }
  return out;
}

/** A piece the way the troll runs it: turned, and run on into the next piece where the gap is trolled. */
export function asTrolled(piece, s) {
  if (!piece || !s) return piece;
  const c = (piece.coords || []).slice();
  if (s.reversed) c.reverse();
  if (Array.isArray(s.onTo) && s.onM > 0) c.push(s.onTo);
  return { ...piece, coords: c, lengthM: (Number(piece.lengthM) || lengthOf(piece.coords || [])) + (s.onTo ? s.onM : 0) };
}
