// THE LANE WAS IN THE MIDDLE, AND THE CHANNEL WAS NOT.
//
// Ryan ran a real Congaree day on 2026-09-18 and said of the downstream leg from Bates Bridge:
// "the last little bit of it looks to be in very shallow / non existant water". Two measurements
// were taken of it and BOTH were wrong, because both measured the lane instead of the river:
//
//   * "the last 100 m is genuinely thin" -- the lane had 4 ft and then 6 ft under it. The same two
//     cross-sections hold 13 ft and 20 ft, out on the outside of that bend.
//   * "a 300 m hole in the chart" -- eight stations where the lane's own column had no charted
//     depth. Every one of those sections is sounded, at 10-12 ft, all of it at the far side.
//
// His answer, which is the whole defect in one line: *"the river doesn't get skinny here, the lane
// is on the wrong side of the river for deep water."*
//
// Measured across his pack afterwards: the middle column is the deepest one at 27% of the 1,671
// charted stations, and where the deep water is off centre on a curve it is on the OUTSIDE of the
// bend 64% of the time. Following the middle gives up a median 3 ft on that downstream arm, 12 ft
// at worst, 5 ft or more at 23 of 68 stations. Whole river, the water under the boat goes from a
// median 8.0 ft to 10.0 ft when the line follows the chart instead of the geometry.
//
// These assertions are the ones that would have caught it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelFractions, riverDriftRuns, LATERALS, lateralsFor,
         SIDE_ENVELOPE_M } from '../js/modules/river-drifts.js';

const FRACTIONS = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1];

/** A section 10 ft everywhere and `deepFt` in one column, so the deepest column is unambiguous. */
const sectionAt = (col, deepFt = 20) =>
  FRACTIONS.map((_, j) => (j === col ? deepFt : 10));

/**
 * A straight eastward river whose CHANNEL crosses the section -- the deep column walks from the
 * left bank to the right bank and back, one column every `hold` stations, which is what a meander
 * does to a cross-section. The centreline stays dead straight, so anything that moves is the lane.
 */
function meanderingRiver({ stations = 120, width = 120, hold = 10, nullRange = null } = {}) {
  const station_m = [], bearing_deg = [], width_m = [], depth_profile_ft = [], coords = [];
  const lon0 = -81.0, lat0 = 34.0, mPerDegLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const walk = [0, 1, 2, 3, 4, 5, 6, 7, 8, 7, 6, 5, 4, 3, 2, 1];
  for (let i = 0; i < stations; i++) {
    station_m.push(i * 50);
    bearing_deg.push(90);
    width_m.push(width);
    coords.push([lon0 + (i * 50) / mPerDegLon, lat0]);
    const blank = nullRange && i >= nullRange[0] && i <= nullRange[1];
    depth_profile_ft.push(blank ? FRACTIONS.map(() => null)
                                : sectionAt(walk[Math.floor(i / hold) % walk.length]));
  }
  return { type: 'FeatureCollection', features: [{
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: coords },
    properties: { slug: 'test_river', step_m: 50, length_m: (stations - 1) * 50,
                  stations, station_m, bearing_deg, width_m, depth_profile_ft,
                  profile_fractions: FRACTIONS },
  }] };
}

const props = (fc) => fc.features[0].properties;

test('the channel line goes where the deepest charted column is', () => {
  const p = props(meanderingRiver({ stations: 40, hold: 10 }));
  const f = channelFractions(p.depth_profile_ft, p.profile_fractions, p.width_m);
  assert.equal(f.length, p.width_m.length);
  // Stations 0-9 have the 20 ft at column 0, 10-19 at column 1, 20-29 at 2, 30-39 at 3. The line
  // settles on each of those before the next step, so the LAST station of each block is on it.
  assert.equal(f[9], 0);
  assert.equal(f[19], 0.125);
  assert.equal(f[29], 0.25);
  assert.equal(f[39], 0.375);
});

test('an unsounded station holds the line, it does not send the boat back to the middle', () => {
  // THE EXACT DEFECT. Eight stations on his downstream arm had nothing charted in the middle
  // column while the section held 10-12 ft at the far side. A lane that recentres wherever the
  // survey thins leaves the channel precisely where it has least reason to.
  const p = props(meanderingRiver({ stations: 40, hold: 40, nullRange: [15, 25] }));
  const f = channelFractions(p.depth_profile_ft, p.profile_fractions, p.width_m);
  for (let i = 15; i <= 25; i++) {
    assert.equal(f[i], 0, `station ${i} held the channel through the gap, got ${f[i]}`);
    assert.notEqual(f[i], 0.5, 'and did not fall back to the middle');
  }
});

test('the line may not move further than the envelope between two stations', () => {
  // A section that jumps bank to bank every station: the raw answer would be a 120 m sawtooth.
  const p = props(meanderingRiver({ stations: 20, hold: 1 }));
  const f = channelFractions(p.depth_profile_ft, p.profile_fractions, p.width_m);
  const w = p.width_m[0];
  for (let i = 1; i < f.length; i++) {
    const movedM = Math.abs(f[i] - f[i - 1]) * w;
    assert.ok(movedM <= SIDE_ENVELOPE_M + 1e-9,
              `station ${i} moved ${movedM.toFixed(1)} m, over the ${SIDE_ENVELOPE_M} m limit`);
  }
});

test('a swing bigger than the limit ramps THROUGH the bend, not after it', () => {
  // Forward-only limiting starts moving at the station the chart first moves and arrives up to five
  // stations -- 250 m -- later, which on a hard bend is the boat crossing to the outside once the
  // bend is over. A 120 m channel whose deep column jumps bank to bank at station 20 is that case:
  // 120 m of swing at 25 m a station is five stations of ramp.
  const p = props(meanderingRiver({ stations: 40, hold: 20 }));
  p.depth_profile_ft = p.depth_profile_ft.map((_, i) => sectionAt(i < 20 ? 0 : 8));
  const f = channelFractions(p.depth_profile_ft, p.profile_fractions, p.width_m);
  assert.equal(f[0], 0, 'it starts on the left bank');
  assert.equal(f[39], 1, 'and finishes on the right one');
  assert.ok(f[17] > 0, 'it has left the old bank BEFORE the chart moves');
  assert.ok(f[22] < 1, 'and has not reached the new one immediately after');
  // Centred: the line is half way across at the station the chart steps, give or take one station.
  const half = f.findIndex((v) => v >= 0.5);
  assert.ok(Math.abs(half - 20) <= 1, `crossed the middle at station ${half}, not near 20`);
  const w = p.width_m[0];
  for (let i = 1; i < f.length; i++) {
    assert.ok(Math.abs(f[i] - f[i - 1]) * w <= SIDE_ENVELOPE_M + 1e-9, `station ${i} jumped`);
  }
});

test('an offset carried in from a wide station is clamped to a narrow one', () => {
  const p = props(meanderingRiver({ stations: 20, hold: 20 }));
  p.width_m = p.width_m.map((w, i) => (i >= 10 ? 20 : 200));
  const f = channelFractions(p.depth_profile_ft, p.profile_fractions, p.width_m);
  for (const v of f) {
    assert.ok(v >= 0 && v <= 1, `the line stayed inside the section, got ${v}`);
  }
});

test('with no width and no profile it is the middle, and nothing throws', () => {
  assert.deepEqual(channelFractions([], FRACTIONS, [0, null, -5]), [0.5, 0.5, 0.5]);
  assert.deepEqual(channelFractions(null, null, null), []);
});

test('the drift that comes out is deeper than the one down the middle', () => {
  const river = meanderingRiver();
  const MID = { key: 'mid_channel', frac: 0.5, label: 'mid-channel' };
  const [chan] = riverDriftRuns(river, { slug: 'test_river', laterals: [LATERALS[1]] });
  const [mid] = riverDriftRuns(river, { slug: 'test_river', laterals: [MID] });
  assert.equal(chan.properties.drift.side, 'channel');
  assert.ok(chan.properties.mean_depth_ft > mid.properties.mean_depth_ft,
            `channel ${chan.properties.mean_depth_ft} ft vs middle ${mid.properties.mean_depth_ft}`);
  assert.ok(chan.properties.deepest_ft >= mid.properties.deepest_ft);
  // And the geometry actually left the centreline, which is the thing Ryan was looking at.
  const centre = river.features[0].geometry.coordinates[0][1];
  assert.ok(chan.geometry.coordinates.some((c) => Math.abs(c[1] - centre) * 111320 > 10),
            'the drawn line is off the centreline where the channel is');
  assert.ok(mid.geometry.coordinates.every((c) => Math.abs(c[1] - centre) * 111320 < 1e-6),
            'and the middle line never was');
});

test('the envelope is measured around the line, not around the centre', () => {
  // `envelope_ft` is the shallowest water within 25 m EITHER SIDE OF THE LINE. When the line moves,
  // the band has to move with it or the bait ceiling is being judged against water the boat is not
  // near -- which is the same family of defect as the lane itself.
  const river = meanderingRiver({ stations: 40, hold: 40 });   // the 20 ft is at column 0 throughout
  const [d] = riverDriftRuns(river, { slug: 'test_river', laterals: [LATERALS[1]] });
  const line = d.properties.envelope_line_ft;
  assert.ok(line.every((v) => v === 20), 'the line sits on the 20 ft column at every station');
  // The band is 25 m either side of column 0 on a 120 m channel, so it reaches column 0.125 (15 m)
  // and not column 0.25 (30 m). Both are 10 ft here, so the side envelope is 10 and never 20.
  assert.ok(d.properties.envelope_ft.every((v) => v === 10),
            'and the side band is the 10 ft beside it, not the 20 ft under it');
});

test('one line per river is still the channel, and the pair is still the quarters', () => {
  assert.deepEqual(lateralsFor(145, 100).map((l) => l.key), ['channel']);
  assert.deepEqual(lateralsFor(500, 100).map((l) => l.key), ['quarter_left', 'quarter_right']);
});

test('the drift no longer claims a single lateral fraction', () => {
  const [d] = riverDriftRuns(meanderingRiver(), { slug: 'test_river' });
  assert.equal(d.properties.drift.frac, undefined,
               'a scalar frac on a line whose position is per station would be a lie');
  assert.match(d.properties.id, /:drift:channel@/);
});

test('the reaches run to the last STATION, not to the written length of the line', () => {
  // `station_m` is arc length along the line the resampler was given; `length_m` is the chord sum
  // of the line it wrote, and they differ by the sagitta of every step -- 130,534.1 against a last
  // station of 131,600 on the Congaree. Bounding the reaches with the length stopped them 1,066 m
  // short of the end of the river, which on the Bates Bridge downstream arm was a third of the arm:
  // 2,271 m and 46 stations instead of 3,383 and 68.
  const river = meanderingRiver({ stations: 60 });
  const p = props(river);
  const lastStation = p.station_m[p.station_m.length - 1];
  p.length_m = lastStation * 0.9;            // a chord sum short of the axis, as every real pack is
  const runs = riverDriftRuns(river, { slug: 'test_river', rampStationM: 0 });
  const covered = Math.max(...runs.map((r) => r.properties.reachFromM
                                            + Math.round(r.properties.length_m)));
  assert.ok(covered > p.length_m,
            `the reaches reached past the written length (${covered} vs ${p.length_m})`);
  const stations = runs.reduce((a, r) => a + r.properties.stations, 0);
  assert.equal(stations, p.station_m.length, 'and every station is on one of them');
});

test('the producer names the station axis, and this reads the name', () => {
  // The rebuild writes `station_span_m` beside `length_m`, so the axis has a name instead of being
  // derived here. A pack built before it still works off the last station -- which is the same
  // number -- and neither may fall back to `length_m`, which is the chord sum and 0.8% short.
  const river = meanderingRiver({ stations: 40 });
  const p = props(river);
  const last = p.station_m[p.station_m.length - 1];
  p.length_m = last * 0.9;
  p.station_span_m = last;
  const named = riverDriftRuns(river, { slug: 'test_river', rampStationM: 0 });
  delete p.station_span_m;
  const derived = riverDriftRuns(river, { slug: 'test_river', rampStationM: 0 });
  const span = (rs) => Math.max(...rs.map((r) => r.properties.reachFromM
                                              + Math.round(r.properties.length_m)));
  assert.equal(span(named), span(derived), 'the name and the derivation are the same number');
  assert.equal(named.reduce((a, r) => a + r.properties.stations, 0), p.station_m.length);
});
