// A mark sits where it says, and says what is under it.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-09-28, on Wateree, with a photo of his ECHOMAP:
//   "What's with this point that says 31 ft but it's sitting on the bank in less than 5 ft of
//    water" -- the pack's feature there is shallow_side_ft 0.4, deep_side_ft 34.3,
//    deepest_within_m 39. The mark is the tip; the number was the deepest water 39 m off it.
//   "And then next to it is a dock cluster but that symbol is sitting in 20ft of water" -- a dock
//    group was looked up as `dock_cluster` in an index that only holds single docks, so it never
//    resolved and kept the point on the trolling line.
//
// What these hold:
//   1. the structure index carries a point's or a cove's tip depth and how far off the deep side is;
//   2. a point mark is named tip-to-drop in today's water, and its note says how far off the drop is;
//   3. a tip the lake has dropped off is "dry", and a feature with no tip depth keeps one number;
//   4. a dock cluster or a dock line is looked up as a dock, and lands on the nearest one.

import { describe, it } from './expect-shim.mjs';
import assert from 'node:assert/strict';
import { structureIndex, resolveStructure, lookupKind, RESOLVE_MARGIN_M } from '../js/modules/plan-candidates.js';
import { planWaypoints } from '../js/modules/plan-tracks.js';

const TIP = [-80.72916, 34.37479];
const POINT = { type: 'Feature', geometry: { type: 'Point', coordinates: TIP },
  properties: { kind: 'point', bulge_m: 146, deep_side_ft: 34.3, shallow_side_ft: 0.4,
                deepest_within_m: 39, relief: 'channel_edge' } };

describe('the index keeps both depths of a point', () => {
  it('carries the tip and how far off the deep side is, as the pack gave them', () => {
    const r = resolveStructure(TIP, 'point', 5, structureIndex([POINT]));
    assert.equal(r.depthFt, 34.3);
    assert.equal(r.shallowFt, 0.4);
    assert.equal(r.deepWithinM, 39);
  });

  it('leaves them out where the pack has none, rather than calling them 0', () => {
    const bare = { ...POINT, properties: { kind: 'point', deep_side_ft: 12 } };
    const r = resolveStructure(TIP, 'point', 5, structureIndex([bare]));
    assert.equal(r.shallowFt, null);
    assert.equal(r.deepWithinM, null);
    const hump = { ...POINT, properties: { kind: 'hump', depth_ft: 14, shallow_side_ft: 3 } };
    assert.equal(resolveStructure(TIP, 'hump', 5, structureIndex([hump])).shallowFt, null,
      'only a point or a cove is placed at its shallow side');
  });
});

const legWith = (mark, extra = {}) => ({ legs: [{
  id: 'L1', type: 'troll', depthFt: 20, runId: 'wateree_lake#1', startM: 0, lengthM: 900,
  coordinates: [[-80.7300, 34.3740], [-80.7280, 34.3740]], stops: [],
  marks: [{ id: 'p0', type: 'point', at: TIP, atM: 300, charted: true, ...mark }], ...extra }] });
const markOf = (plan) => planWaypoints(plan, null, 'r', { marks: true }).find((w) => w.chartMark);

describe('a point mark names the tip and the drop', () => {
  it('on Wateree 9/28: the tip is dry and the drop is 33 ft, 39 m off', () => {
    // 1.15 ft is Wateree 3.5 ft down against its chart's measured level (js/data/chart-levels.js).
    const w = markOf(legWith({ depthFt: 34.3, shallowFt: 0.4, deepWithinM: 39 }, { drawdownFt: 1.15 }));
    assert.equal(w.name, 'point dry-33ft');
    assert.match(w.tacticalNote, /the mark is the tip, 0\.4 ft on the chart, out of the water today/);
    assert.match(w.tacticalNote, /the deep side is 34\.3 ft on the chart, 33\.2 ft today/);
    assert.match(w.tacticalNote, /within 39 m of the tip/);
    assert.equal(w.depth, 33.2, 'the waypoint depth is still the drop, which is what is fished');
  });

  it('where no level applies the chart stands, tip and drop both', () => {
    const w = markOf(legWith({ depthFt: 34.3, shallowFt: 0.4, deepWithinM: 39 }));
    assert.equal(w.name, 'point 0-34ft');
    assert.match(w.tacticalNote, /the mark is the tip, 0\.4 ft on the chart; the deep side is 34\.3 ft on the chart, within 39 m/);
  });

  it('a tip still under water gives its depth', () => {
    const w = markOf(legWith({ depthFt: 18, shallowFt: 6, deepWithinM: 25 }, { drawdownFt: 1.15 }));
    assert.equal(w.name, 'point 5-17ft');
  });

  it('a feature with no tip depth keeps the one number it has', () => {
    const w = markOf(legWith({ depthFt: 12 }));
    assert.equal(w.name, 'point 12ft');
  });
});

describe('a dock group lands on a dock', () => {
  it('looks a cluster and a line up as a single dock, and nothing else changes kind', () => {
    assert.equal(lookupKind('dock_cluster'), 'dock');
    assert.equal(lookupKind('dock_line'), 'dock');
    assert.equal(lookupKind('dock'), 'dock');
    assert.equal(lookupKind('point'), 'point');
  });

  it('resolves to the nearest dock polygon inside the pass radius, not the trolling line', () => {
    // A dock polygon 60 m north of the line, as docks.geojson carries it (no kind, `layer: docks`).
    const ring = [[-80.72862, 34.37440], [-80.72858, 34.37440], [-80.72858, 34.37444],
                  [-80.72862, 34.37444], [-80.72862, 34.37440]];
    const dock = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] },
                   properties: { layer: 'docks' } };
    const index = structureIndex([dock]);
    const onLine = [-80.7286, 34.3739];
    const offM = 55;
    assert.equal(resolveStructure(onLine, 'dock_cluster', offM * 1.25 + RESOLVE_MARGIN_M, index), null,
      'looked up as itself, a group never resolves -- the 9/28 plan had six on the line');
    const s = resolveStructure(onLine, lookupKind('dock_cluster'), offM * 1.25 + RESOLVE_MARGIN_M, index);
    assert.ok(s, 'looked up as a dock it lands on one');
    assert.ok(Math.abs(s.lat - 34.37442) < 1e-4 && Math.abs(s.lon + 80.7286) < 1e-4);
  });
});
