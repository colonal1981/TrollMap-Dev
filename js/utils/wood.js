/**
 * The wood he has gone over: what the pack holds, and its top at today's level.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Read by the map's Wood button (js/modules/wood-layer.js) and by the plan's wood rule
 * (js/modules/plan-wood.js, called from assemblePlan()). Written by Scripts/build_wood.py from
 * registry/wood/<slug>.json, one Point per piece, into the pack as wood.geojson.
 *
 * HIS TWO NUMBERS, AND THE ONLY TWO IN HERE. Ryan, 2026-11-03: *"i would say less than 10 ft out from
 * the side of the boat... 7ft rods almost straight out... but curved slightly to the rear of the
 * kayak... and as far as above i would say we need 5ft of clearance... just because i actually have
 * no idea how deep my lures are... even the ones with depth printed on them do not run exactly those
 * depths"*. So the lures pass over a band 10 ft either side of his track, and a piece of wood is a
 * target only when its top is at least 5 ft deeper than where the app guesses a lure runs.
 */

/** Ryan, 2026-11-03: the lures pass within this of his track, either side. */
export const HIS_PASS_FT = 10;
/** Ryan, 2026-11-03: a lure this far over the top of the wood, or more, is over it, not in it. */
export const HIS_CLEAR_FT = 5;
/** The international foot. A unit, not a choice. */
export const FT_M = 0.3048;
export const HIS_PASS_M = HIS_PASS_FT * FT_M;

/** Kinds with no top to stand on: seen only off to the side, or the two reads of it disagree. */
export const NO_TOP_KINDS = new Set(['no_height', 'unsure']);

const num = (v) => (v == null || v === '' ? NaN : Number(v));
/** To the tenth of a foot, the precision every depth in the wood file is written to. */
const tenth = (v) => Math.round(v * 10) / 10;
/** A depth as words: 6.5, 10, 2.4 -- no trailing ".0". */
export const ftText = (v) => String(tenth(v));

/**
 * The pack's FeatureCollection as pieces. Nothing is dropped here either: a feature with no
 * position is the only thing left out, because it cannot be drawn or passed over.
 */
export function woodPieces(fc) {
  const out = [];
  for (const f of ((fc && fc.features) || [])) {
    const c = f && f.geometry && f.geometry.coordinates;
    const p = (f && f.properties) || {};
    if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1]) || !p.id) continue;
    out.push({
      id: p.id, kind: p.kind || null, at: [c[0], c[1]],
      what: p.what ?? null, seen: p.seen ?? null, hisMark: p.his_mark ?? null,
      reads: Array.isArray(p.reads) ? p.reads : [],
      heightFt: Number.isFinite(num(p.height_ft)) ? num(p.height_ft) : null,
    });
  }
  return out;
}

/**
 * "11/1" off a read's own time, as it was written -- the local date on the water, not the date in
 * whatever zone the phone happens to be in.
 */
export function readDay(at) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(at || ''));
  return m ? `${Number(m[2])}/${Number(m[3])}` : null;
}

/**
 * THE PIECE'S TOP TODAY, AND HOW IT WAS GOT.
 *
 * For each read with a top: `top_ft - (feet below full pool today - its below_full_pool_ft)` where
 * both are known -- a lake lower today brings the top nearer the surface -- and otherwise the top as
 * read. The piece's top is the shallowest of these.
 *
 * `belowTodayFt` is belowFullPoolTodayFt() (js/utils/water-conditions.js): today's feet below full
 * pool on the same scale the reads were stamped on, NOT less the chart's level, because these are
 * his sounder's depths and not the chart's.
 *
 * @returns {null | {ft:number, basis:'today'|'as_read', on:string|null, readOn:string|null,
 *                   belowThenFt:number|null, belowTodayFt:number|null}}
 *          null for a piece with no top (no_height, unsure, or no read with a top).
 */
export function topToday(piece, belowTodayFt) {
  if (!piece || NO_TOP_KINDS.has(piece.kind)) return null;
  const today = num(belowTodayFt);
  let best = null;
  for (const r of (piece.reads || [])) {
    const top = num(r && r.top_ft);
    if (!Number.isFinite(top)) continue;
    const then = num(r.below_full_pool_ft);
    const both = Number.isFinite(then) && Number.isFinite(today);
    const ft = tenth(both ? top - (today - then) : top);
    const cand = { ft, basis: both ? 'today' : 'as_read', on: both ? null : readDay(r.at),
                   readOn: readDay(r.at), belowThenFt: Number.isFinite(then) ? then : null,
                   belowTodayFt: both ? today : null };
    // The shallowest wins; at a tie the one brought to today does, being the better-founded.
    if (!best || ft < best.ft || (ft === best.ft && best.basis !== 'today' && cand.basis === 'today')) {
      best = cand;
    }
  }
  return best;
}

/** "today" or "as read on 11/1" -- the leg's `topBasis`. Null with no top. */
export function topBasis(top) {
  if (!top) return null;
  return top.basis === 'today' ? 'today' : `as read on ${top.on || 'an unknown day'}`;
}

/**
 * The number beside a mark on the map. "6 ft" brought to today, "10 ft on 11/1" as read.
 *
 * Whole feet, ROUNDED DOWN -- toward the surface -- so the glance never shows a top deeper than the
 * reads put it. The tap shows every read to the tenth.
 */
export function woodMarkLabel(top) {
  if (!top) return '';
  const ft = `${Math.floor(top.ft)} ft`;
  return top.basis === 'today' ? ft : `${ft}${top.on ? ` on ${top.on}` : ''}`;
}

/**
 * THE SIZE OF A MARK, AGAINST THE TALLEST PIECE ON THAT WATER, NOT A TABLE.
 *
 * The mark's AREA is in proportion to the piece's height, so a tree twice as tall reads as twice
 * the mark: radius = maxPx * sqrt(height / tallest). The tallest piece on the water gets `maxPx`,
 * which the caller takes from the map's own largest structure mark (osm-structure.js draws a dam at
 * 10 px), so the wood sits in the same visual range as everything else drawn on the water.
 *
 * A piece with no height -- never gone over, or read two ways -- gets `maxPx` too, hollow: it could
 * be as tall as anything here, and a small mark would say it was small.
 */
export function markRadiusPx(heightFt, tallestFt, maxPx) {
  const h = num(heightFt), t = num(tallestFt);
  if (!Number.isFinite(h) || !Number.isFinite(t) || t <= 0) return maxPx;
  return maxPx * Math.sqrt(Math.max(0, Math.min(h, t)) / t);
}

/** Who read it, in words: Claude through the Worker, the desktop, or both. */
export function readByText(readBy) {
  const by = new Set(Array.isArray(readBy) ? readBy : []);
  const api = by.has('claude_api'), desk = by.has('desktop');
  if (api && desk) return 'Claude through the Worker and the desktop, both';
  if (api) return 'Claude through the Worker';
  if (desk) return 'the desktop';
  return by.size ? [...by].join(', ') : 'not recorded';
}

/** What the piece is, as a phrase for a sentence. */
export function kindText(piece) {
  const k = piece && piece.kind;
  const h = piece && Number.isFinite(piece.heightFt) ? ` standing ${ftText(piece.heightFt)} ft` : '';
  const base = k === 'wood' ? `wood${h || ' 2 ft or more'} off the bottom`
    : k === 'low_wood' ? `low wood${h || ' under 2 ft'} off the bottom`
    : k === 'no_height' ? 'wood the side imaging saw off to the side'
    : k === 'unsure' ? 'something the two reads of its picture do not agree on'
    : 'wood';
  const extra = [piece && piece.what, piece && piece.hisMark && piece.what !== piece.hisMark
    && !(piece.what || '').includes(piece.hisMark) ? piece.hisMark : null].filter(Boolean);
  return extra.length ? `${base} (${extra.join('; ')})` : base;
}
