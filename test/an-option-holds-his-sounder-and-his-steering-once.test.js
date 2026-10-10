// AN OPTION HOLDS THE WATER HIS SOUNDER READ, WITH HIS 5 FT STEERING ADDED ONCE.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-10-10: "I am looking at the options for lake marion at rowland subdivision landing and they
// all cross water that is too shallow". Rebuilt with the app's own trollLoop, his journal and the lake
// 3.99 ft below the chart: Option 1 ran 2.2 km under 14 ft today and touched -1 ft; Option 2 1.1 km under
// its 16 ft. Two causes. The sounder band was his reading with his 5 ft either side, and every way then
// took another 5 ft off its foot for the alarm edge, so his 19.5 ft held 9.5 ft. And under that edge every
// cell was one price, so a line with no water at his depth on its side took the bank at -1 ft as readily as
// 13. Put to him with the picture (Option 1 140 m under 14 ft, shallowest 13), he asked "13ft charted or
// 13 actual" (actual: the chart less 4 ft), then "ok".
//
// What these hold:
//   1. the sounder band is the range of his readings, as the chart band is the range of his fish's depths;
//   2. the alarm edge is that less his 5 ft, once (test 4 of the-day-is-options holds it on a lake);
//   3. under the edge, a way prices each cell by how far under it is, in both places a way can go there.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../js/modules/plan-options.js', import.meta.url), 'utf8');
const live = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('1. the sounder band is the range of his readings, not his reading with his steering in it', () => {
  assert.ok(live.includes("if (rd.length) { const fts = rd.map((r) => r.ft); kd.band = [Math.min(...fts), Math.max(...fts)]; kd.bandFrom = 'sounder'; }"));
  assert.ok(live.includes("else { kd.band = [kd.lead.lo, kd.lead.hi]; kd.bandFrom = 'chart'; }"), 'the chart band, the range of his fish');
  assert.ok(!/kd\.band = \[med - steer, med \+ steer\]/.test(live));
});

test('2. the alarm edge is the band less his 5 ft, once', () => {
  assert.ok(live.includes("edgeFt: o1.bandFrom === 'deepest' ? null : Math.round(o1.band[0] - steer)"));
  assert.ok(live.includes('if (d < lo - steer) continue;'), 'bandCost: never under the edge but where it must');
});

test('3. under the edge, the less under it the better, wherever a way can go there', () => {
  assert.ok(live.includes('const underEdge = (d, lo, steer) => (Number.isFinite(d) ? 1 + (Math.max(0, lo - steer - d) / steer) ** 2 : 1e6);'));
  assert.ok(live.includes('else if (tier[k] === 2) c[k] = t2 * underEdge(net.D[k], lo, steer);'), 'besideOn');
  assert.ok(live.includes('else if (tier[k] === 2) c[k] = t2 * underEdge(D[k], lo, steer);'), 'sideWay');
  assert.ok(!/tier\[k\] === 2\) c\[k\] = t2;/.test(live), 'no cell under the edge at one flat price');
});
