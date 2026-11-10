// Personal use only, not for distribution or resale; not for navigation.
//
// TWO DEEP DIVERS, BOTH IN THE FISH'S DEPTH.
//
// Ryan, 2026-11-06, of the runs and moves at 3 mph: "put 2 deep diving crankbaits that match the fishing depth and
// allowable depth for that run". His 11/9 Clearwater plan on Wateree (fish 10-20 ft, the reports' water 19-35 ft) went
// out on its three moves with an MR (6-12 ft) and an SR (3-5 ft): the pair as a whole touched the fish (the MR's last
// 2 ft), so the SR, rated 15 ft above them, came along; and the moves' pair was held to the shallowest of the reports'
// water (19 ft), which nothing deeper than an MR clears. Now both baits reach into the fish's depth where any pair
// does, the pair need clear only the deepest line the loops ride, and between pairs as much in the fish the one with
// fewer baits under them goes ("fish look up", 8/11).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDivers, runCrankbaits, pairTiers, inFish, belowFish, layAreas } from '../js/modules/plan-areas.js';
import { TACKLE_INVENTORY } from '../js/data/tackle-inventory.js';

const CRANKS = runCrankbaits(TACKLE_INVENTORY);
const station = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const CUM = station(150, (i) => i * 40);
const types = (r) => r.rods.map((x) => x.type).sort().join();

test('a run over 20-24 ft floors with the fish at 10-20 ft goes out with two baits in the fish, not an SR', () => {
  // The first 30% of the run holds 20 ft, the rest 24 ft: the DD1 and MR (need 23) go in later than the MR and SR (17).
  const r = runDivers(station(150, (i) => (i < 45 ? 20 : 24)), CUM, CRANKS, { fishFt: [10, 20] });
  assert.equal(types(r), 'crankbait_dd1,crankbait_mr');
  assert.equal(r.inFish, 'both');
  assert.ok(r.rods.every((x) => x.max >= 10 && x.min <= 20), types(r));
});

test('where no two baits fit the fish, one in it beats none, and fewer below the fish beats deeper', () => {
  const pr = (a, b) => ({ rods: [a, b].map((t) => CRANKS.find((c) => c.type === t)) });
  const dd43 = pr('crankbait_dd4', 'crankbait_dd3'), dd32 = pr('crankbait_dd3', 'crankbait_dd2');
  const t = pairTiers([dd43, dd32], [20, 23]);
  assert.equal(t.tier, 'one');                                   // the DD2's 16-20 ends where the fish start
  assert.equal(inFish(dd43, [20, 23]), inFish(dd32, [20, 23]));  // the DD3 alone reaches them in both
  assert.equal(belowFish(dd43, [20, 23]), 1);                    // the DD4 (25 ft+) runs under them
  assert.equal(belowFish(dd32, [20, 23]), 0);
  assert.equal(pairTiers([dd32], null).tier, 'none');            // no fish depth: nothing to sort on
});

// A lake on a grid (as in the-day-is-spent-in-the-areas), banded like the 11/9 water: 10, 19, 27 and a 35 ft core, the
// ramp on the south shore and the area beside it, so the day has no run and the moves take their own pair.
const ring = ([w, s, e, n]) => [[w, s], [e, s], [e, n], [w, n], [w, s]];
const band = (outer, inner, ft) => ({ type: 'Feature', properties: { depth_max_ft: ft },
  geometry: { type: 'Polygon', coordinates: inner ? [ring(outer), ring(inner).reverse()] : [ring(outer)] } });
const B10 = [-80.0, 33.2, -79.98, 33.26], B20 = [-79.998, 33.2015, -79.982, 33.2585];
const B35 = [-79.996, 33.203, -79.984, 33.257], B45 = [-79.993, 33.206, -79.987, 33.254];
const LAKE = [band(B10, B20, 10), band(B20, B35, 19), band(B35, B45, 27), band(B45, null, 35)];

test("an area by the ramp: its moves' two divers are both in the fish, cleared by its deepest line, not its shallowest water", () => {
  const day = layAreas({ ramp: [-79.99, 33.2004], daFeatures: LAKE, places: [{ at: [-79.99, 33.208], name: 'By The Ramp', n: 3, why: 'x' }],
                         waterFt: [19, 35], fishFt: [10, 20], windowMin: 360, stopMin: 0, cranks: CRANKS, launchTime: '08:30' });
  assert.ok(!day.error, day.error);
  const a = day.areas[0];
  assert.ok(a.pair, 'the moves have a pair');
  assert.ok(a.pair.rods.every((x) => x.max >= 10 && x.min <= 20 && x.type !== 'crankbait_sr'), a.pair.rods.map((x) => x.name).join());
  assert.equal(a.pair.rods.length, 2);
  // held to the shallowest of the reports' water (19 ft) the pair could be no deeper than an MR: the old way's answer
  assert.ok(a.pair.needFt > 19, `need ${a.pair.needFt}`);
});
