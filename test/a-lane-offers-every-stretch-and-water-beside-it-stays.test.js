// A lane offers every stretch of it that is a pass, and a lane beside it that goes somewhere else
// stays a piece.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-10-01, on Pick Water from Rowland on Lake Marion: "i am not seeing any lanes in the
// deeper water in wyboo creek". There were lanes down the channel, and two things hid them:
//
//   - buildPieces() kept ONE stretch of each lane, the one carrying the deepest bait. #17, the
//     27.9 ft lane, runs 1.05 mi down the Wyboo channel and 5.7 mi in all, and its one stretch was
//     out in the open lake, past the line he drew across the creek mouth.
//   - a group of lanes that share water was ONE piece. #503 runs 0.82 mi of the channel holding
//     28 ft and was dropped for #484, which holds 30 ft for 0.52 mi.
//
// Shown both, he said "yeah lets do that". Every stretch of at least his pass length is now a
// piece, and a lane in a group is kept when it carries a pass length of water the kept ones do not.

import { describe, it } from './expect-shim.mjs';
import assert from 'node:assert/strict';
import { buildPieces } from '../js/modules/plan-pieces.js';

const LAT = 33.5, LON = -80.2;
const kx = 111320 * Math.cos(LAT * Math.PI / 180), ky = 110540;
const at = ([x, y]) => [LON + x / kx, LAT + y / ky];
const lane = (id, xy, env) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: xy.map(at) },
  properties: { id, fitted: true, envelope_step_m: 40, envelope_m: 25, envelope_ft: env,
                envelope_line_ft: env.map((v) => v + 2), envelope_deep_ft: env.map((v) => v + 4) } });
const along = (n, x0 = 0, y = 0) => Array.from({ length: n }, (_, i) => [x0 + i * 40, y]);

describe('a lane offers every stretch of it that is a pass', () => {
  it('a 30 ft kilometre and then 20 ft for 960 m are two pieces, the second named by where it starts', () => {
    const env = [...Array(26).fill(30), ...Array(25).fill(20)];
    const got = buildPieces([lane('fake#0', along(51), env)], { clearFt: 0, minM: 805, depths: [10, 20, 30] });
    const rows = got.pieces.map((p) => [p.runId, p.holdsFt, p.lengthM]).sort((a, b) => b[1] - a[1]);
    assert.deepEqual(rows, [['fake#0', 30, 1000], ['fake#0@1040', 20, 960]]);
    const second = got.pieces.find((p) => p.runId === 'fake#0@1040');
    assert.ok(second.envelope.every((v) => v === 20), 'the second piece carries its own stations');
    assert.equal(Math.max(...second.offers.map((o) => o.depthFt)), 20,
      'and offers only what its own water carries');
  });

  it('what is left after the deepest stretch is not a piece when it is shorter than his pass', () => {
    const env = [...Array(26).fill(30), ...Array(15).fill(20)];
    const got = buildPieces([lane('fake#0', along(41), env)], { clearFt: 0, minM: 805, depths: [10, 20, 30] });
    assert.deepEqual(got.pieces.map((p) => [p.runId, p.holdsFt]), [['fake#0', 30]]);
  });
});

describe('a lane beside the kept one stays a piece when it goes somewhere the kept one does not', () => {
  // A: 30 ft for 1000 m. B: 28 ft, 10 m beside A for 800 m, then turns away for 960 m. C: 26 ft,
  // 15 m the other side of A for all of it. One group; A is kept first as it always was, B carries
  // 920 m of water outside A's swath, C carries none.
  const A = lane('fake#A', along(26), Array(26).fill(30));
  const bxy = [...along(21, 0, 10), ...Array.from({ length: 25 }, (_, i) => [800, 50 + i * 40])];
  const B = lane('fake#B', bxy, Array(46).fill(28));
  const C = lane('fake#C', along(26, 0, -15), Array(26).fill(26));
  const got = buildPieces([C, B, A], { clearFt: 0, minM: 805, depths: [10, 20, 26, 28, 30] });

  it('keeps the deepest and the one that leaves, and drops the one that only shadows', () => {
    assert.deepEqual(got.pieces.map((p) => [p.runId, p.holdsFt, p.duplicates]).sort(),
      [['fake#A', 30, 3], ['fake#B', 28, 3]]);
  });

  // Since 2026-10-02 a member is dropped only when a kept one sharing its water is at least as deep
  // AND at least as long (see the next describe). So this B is no longer than A: 800 m beside it,
  // then 200 m away, 1000 m in all against A's 1000.
  it('does not keep the one that leaves when its own water is shorter than his pass', () => {
    const short = lane('fake#B', [...along(21, 0, 10), ...Array.from({ length: 5 }, (_, i) => [800, 50 + i * 40])],
      Array(26).fill(28));
    const g2 = buildPieces([C, short, A], { clearFt: 0, minM: 805, depths: [10, 20, 26, 28, 30] });
    assert.deepEqual(g2.pieces.map((p) => p.runId), ['fake#A']);
  });
});

describe('a longer lane is not dropped for a deeper, shorter one', () => {
  // Wyboo Creek, Lake Marion, 2026-10-01: #19 runs his 28 ft line for 1,440 m and was dropped for
  // #484, which holds 30 ft for 840 m, because only 550-ish m of #19 is outside #484's swath. Ryan:
  // "those lines are somewhat close to what i drew but not actually the ones i drew at all".
  // Here: D 30 ft for 840 m; L 28 ft for 1,440 m, 10 m beside D and on past its end; S 28 ft for
  // 840 m on D's other side. One group.
  const D = lane('fake#484', along(22), Array(22).fill(30));
  const L = lane('fake#19', along(37, 0, 10), Array(37).fill(28));
  const S = lane('fake#503', along(22, 0, -10), Array(22).fill(28));
  const got = buildPieces([S, L, D], { clearFt: 0, minM: 805, depths: [10, 20, 28, 30] });

  it('keeps the deeper one and the longer one, and drops the one no better on either count', () => {
    assert.deepEqual(got.pieces.map((p) => [p.runId, p.holdsFt, p.lengthM, p.duplicates]).sort(),
      [['fake#19', 28, 1440, 3], ['fake#484', 30, 840, 3]]);
  });

  it('and still drops the longer one when the kept one is as long as it', () => {
    const D2 = lane('fake#484', along(37, 0, 0), Array(37).fill(30));
    const g2 = buildPieces([L, D2], { clearFt: 0, minM: 805, depths: [10, 20, 28, 30] });
    assert.deepEqual(g2.pieces.map((p) => p.runId), ['fake#484']);
  });
});
