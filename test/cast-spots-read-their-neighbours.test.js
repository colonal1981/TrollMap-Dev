// Personal use only, not for distribution or resale; not for navigation.
//
// castSpots() SEARCHES A GRID NOW (2026-09-26), because on Murray every sighting measured every
// charted feature of its kind and Pick Water hung the browser. The grid must give the same spots,
// in the same order, as the plain scan it replaced. The reference below IS that scan, verbatim
// but for its name, and the lakes here are built to hit its edges: sightings just inside and just
// outside the 250 m snap, two features at exactly the same distance, merges that chain as a kept
// spot moves, and keys that collide after the move.
import { describe, it, expect } from './expect-shim.mjs';
import { castSpots, SPOT_KINDS } from '../js/modules/plan-water.js';
import { metresBetween } from '../js/modules/plan-candidates.js';

function oldCastSpots(lanes, { features = null, mergeM = 60, extraSpots = null } = {}) {
  const raw = [];
  for (const e of (extraSpots || [])) {
    if (!e || !Array.isArray(e.at) || !SPOT_KINDS[e.type]) continue;
    raw.push({ type: e.type, what: e.what || SPOT_KINDS[e.type], at: e.at, offM: e.offM ?? 0 });
  }
  for (const f of (features || [])) {
    const g = f && f.geometry;
    const kind = (f.properties || {}).kind;
    if (!g || g.type !== 'Point' || !SPOT_KINDS[kind]) continue;
    if (!Array.isArray(g.coordinates) || g.coordinates.length < 2) continue;
    raw.push({ type: kind, what: SPOT_KINDS[kind], at: g.coordinates, offM: 0 });
  }
  for (const f of (lanes || [])) {
    const p = (f && f.properties) || {};
    const coords = (f.geometry && f.geometry.coordinates) || [];
    const total = p.length_m || 0;
    if (!coords.length || !total) continue;
    for (const n of (p.near || [])) {
      const label = SPOT_KINDS[n.t];
      if (!label || n.s == null) continue;
      const at = coords[Math.max(0, Math.min(coords.length - 1, Math.round((n.s / total) * (coords.length - 1))))];
      if (at) raw.push({ type: n.t, what: label, at, offM: n.d });
    }
  }
  const byKind = new Map();
  for (const f of (features || [])) {
    const g = f && f.geometry;
    const kind = (f.properties || {}).kind;
    if (!g || !kind || g.type !== 'Point') continue;
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push({ at: g.coordinates, id: (f.properties || {}).id || null,
                            depthFt: Number((f.properties || {}).depth_ft) });
  }
  const out = new Map();
  for (const r of raw) {
    const real = byKind.get(r.type);
    let key = null, at = r.at, id = null, depthFt = null;
    if (real) {
      let best = null, bd = Infinity;
      for (const c of real) { const d = metresBetween(r.at, c.at); if (d < bd) { bd = d; best = c; } }
      if (best && bd <= 250) {
        at = best.at; id = best.id;
        depthFt = Number.isFinite(best.depthFt) && best.depthFt > 0 ? best.depthFt : null;
        key = `${r.type}@${at[0].toFixed(5)},${at[1].toFixed(5)}`;
      } else continue;
    }
    if (!key) {
      for (const [k, v] of out) {
        if (v.type !== r.type) continue;
        if (metresBetween(r.at, v.at) <= mergeM) { key = k; break; }
      }
      if (!key) key = `${r.type}~${r.at[0].toFixed(5)},${r.at[1].toFixed(5)}`;
    }
    const prev = out.get(key);
    if (!prev || r.offM < prev.offM) {
      out.set(key, { key: `s${out.size}`, type: r.type, what: r.what, at, offM: r.offM, structureId: id, depthFt });
    }
  }
  return [...out.values()];
}

let seed = 99;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pt = (lon, lat, kind, props = {}) => ({ type: 'Feature', properties: { kind, ...props },
                                               geometry: { type: 'Point', coordinates: [lon, lat] } });
const M = 1 / 111195;                         // about a metre of latitude, in degrees

describe('castSpots() gives what the plain scan gave', () => {
  it('snaps at 250 m and not past it, and a tie goes to the feature listed first', () => {
    const hump1 = pt(-81.3, 34.09, 'hump', { id: 'h1', depth_ft: 22 });
    const hump2 = pt(-81.3, 34.09 + 480 * M, 'hump', { id: 'h2', depth_ft: 30 });   // 240 m from the middle
    const lane = { type: 'Feature', properties: { length_m: 1000, near: [
      { t: 'hump', s: 0, d: 10 }, { t: 'hump', s: 500, d: 5 }, { t: 'hump', s: 1000, d: 3 }] },
      geometry: { type: 'LineString', coordinates: [[-81.3, 34.09 - 249 * M], [-81.3, 34.09 + 240 * M], [-81.3, 34.09 + 731 * M]] } };
    const o = { features: [hump1, hump2] };
    const got = castSpots([lane], o);
    expect(JSON.stringify(got)).toBe(JSON.stringify(oldCastSpots([lane], o)));
    expect(got.map((s) => s.structureId).join()).toBe('h1,h2');
  });

  it('merges timber into the first spot kept, including after that spot has moved', () => {
    const coords = [];
    for (let i = 0; i < 40; i++) coords.push([-81.31 + i * 20 * M * 1.2, 34.08]);
    const near = [];
    for (let i = 0; i < 40; i++) near.push({ t: 'timber', s: i * 25, d: 40 - i });   // each closer than the last
    const lane = { type: 'Feature', properties: { length_m: 975, near }, geometry: { type: 'LineString', coordinates: coords } };
    const got = castSpots([lane, lane], { mergeM: 60 });
    expect(JSON.stringify(got)).toBe(JSON.stringify(oldCastSpots([lane, lane], { mergeM: 60 })));
  });

  it('agrees on a random lake of features, lanes and state piles', () => {
    for (let trial = 0; trial < 12; trial++) {
      const kinds = ['hump', 'hole', 'point', 'cove', 'ledge', 'timber', 'pile', 'attractor'];
      const features = [];
      for (let i = 0; i < 300; i++) {
        const k = kinds[Math.floor(rnd() * 5)];      // only the first five have a file
        features.push(pt(-81.35 + 0.08 * rnd(), 34.05 + 0.06 * rnd(), k, { id: `f${i}`, depth_ft: Math.round(40 * rnd()) }));
      }
      // Two features on the same spot, so a tie is certain somewhere.
      features.push(pt(features[0].geometry.coordinates[0], features[0].geometry.coordinates[1], features[0].properties.kind, { id: 'twin' }));
      const lanes = [];
      for (let l = 0; l < 60; l++) {
        const x = -81.35 + 0.08 * rnd(), y = 34.05 + 0.06 * rnd(), cs = [];
        for (let i = 0; i < 30; i++) cs.push([x + i * 30 * M * 1.2 * (rnd() - 0.3), y + i * 30 * M * (rnd() - 0.3)]);
        const near = [];
        for (let i = 0; i < 25; i++) near.push({ t: kinds[Math.floor(rnd() * kinds.length)], s: Math.round(870 * rnd()), d: Math.round(100 * rnd()) });
        lanes.push({ type: 'Feature', properties: { length_m: 870, near }, geometry: { type: 'LineString', coordinates: cs } });
      }
      const extraSpots = [];
      for (let i = 0; i < 20; i++) extraSpots.push({ type: 'dnr_attractor', at: [-81.35 + 0.08 * rnd(), 34.05 + 0.06 * rnd()], what: `pile ${i}` });
      const o = { features, extraSpots, mergeM: 30 + 80 * rnd() };
      expect(JSON.stringify(castSpots(lanes, o))).toBe(JSON.stringify(oldCastSpots(lanes, o)));
    }
  });
});
