// His unit keeps ten characters of a waypoint's name, and the part he acts on goes first.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Read off his ECHOMAP's own export, 2026-09-28 (28Sep26_Trip\ADMEXPORT.ADM and 28SEP26EXPORT.GPX):
// a waypoint's name is kept in 10 bytes and its comment in 20, a route's name in 15, a track's in
// 20, and a waypoint's note (<desc>) is not kept at all. 34 of the 61 waypoint names came back
// exactly 10 long -- `S1.1 · doc`, `dock clust`, `obstructio` -- and the new leg starts would have
// read `L3 start 2`. Offered the part he acts on first in the ten and the comment as a second
// line, a boundary in its leg's colour, and two files to test re-import by ID, Ryan: "sure".
//
// What these hold:
//   1. fitUnit() takes the first candidate that fits, and unitLabel() keeps the depth whole;
//   2. every waypoint a plan writes fits 10, every comment 20, every cue line 15, every track 20;
//   3. the GPX carries the comment;
//   4. each cue line carries its leg's colour, a lure change included, and the ADM writes it as
//      Garmin's colour index.

import { describe, it } from './expect-shim.mjs';
import assert from 'node:assert/strict';
import { fitUnit, unitLabel, UNIT_CHARS, planWaypoints, planCueLines, planTracks, legColor }
  from '../js/modules/plan-tracks.js';
import { buildGPX } from '../js/utils/parsers.js';
import { bdyFile, cueBoundaries, colorIndex, GARMIN_COLOR_ORDER } from '../js/utils/adm.js';

describe('a name is fitted, not cut', () => {
  it('takes the first candidate that fits, and cuts the last only when none does', () => {
    assert.equal(fitUnit(['point dry-33ft', 'pt dry-33ft', 'pt dry-33'], 10), 'pt dry-33');
    assert.equal(fitUnit(['abcdefghijkl'], 10), 'abcdefghij');
    assert.equal(fitUnit([null, '', 'L1 end'], 10), 'L1 end');
  });

  it('keeps the depth whole and shortens the word', () => {
    assert.deepEqual(unitLabel('point', 'dry-33'), { name: 'pt dry-33', cmt: 'point dry-33ft' });
    assert.deepEqual(unitLabel('hole', '48'), { name: 'hole 48ft', cmt: 'hole 48ft' });
    assert.deepEqual(unitLabel('dock cluster', null), { name: 'docks', cmt: 'dock cluster' });
    assert.deepEqual(unitLabel('obstruction', null), { name: 'obstr', cmt: 'obstruction' });
    assert.deepEqual(unitLabel('outside bend hole', '12'), { name: 'hole 12ft', cmt: 'out bend hole 12ft' });
    assert.equal(unitLabel('cove', 'dry-12').name, 'cov dry-12', 'no shorter word, so the word is cut, not the depth');
    assert.equal(unitLabel('hump', 'dry').name, 'hump dry');
  });
});

// Wateree, 3.5 ft down on 9/28, with a leg at every length of id the plans use.
const LAT = 34.38;
const line = (a, b, lat = LAT) => Array.from({ length: 11 }, (_, i) => [a + (b - a) * i / 10, lat]);
const KINDS = ['point', 'cove', 'hump', 'hole', 'dock_cluster', 'dock_line', 'obstruction',
  'attractor', 'timber', 'hazard', 'shallow', 'creek_mouth', 'ledge', 'pile'];
const legs = [];
for (let i = 0; i < 12; i++) {
  const id = `L${i + 1}`;
  const lon = -80.72 + i * 0.01;
  legs.push({
    id, type: i % 4 === 3 ? 'transit' : 'troll', runId: `wateree_lake#${i}`, depthFt: 8 + i * 9,
    drawdownFt: 1.15, startM: i * 1000, lengthM: 1000, coordinates: line(lon, lon + 0.009),
    stops: [{ id: `S${i + 1}.1`, at: [lon + 0.004, LAT], atM: 400, depthFt: i === 5 ? 0.5 : 20 + i,
              structureType: KINDS[i % KINDS.length] }],
    marks: KINDS.map((k, j) => ({ id: `m${i}.${j}`, type: k, at: [lon + 0.0005 * j, LAT + 0.001],
      atM: 50 * j, charted: true, depthFt: j % 3 ? 10 + j * 7 : null,
      shallowFt: k === 'point' || k === 'cove' ? 0.4 + j : null, deepWithinM: 30 })),
  });
}
const plan = { legs, changes: [
  { id: 'C1', atM: 2500, rodId: 'R3', to: 'DD2 Crankbait' },
  { id: 'C2', atM: 10500, rodId: 'R12', to: 'Carolina rig, 3/4 oz' },
] };
const wps = planWaypoints(plan, [-80.7288, 34.3793], 'run', { marks: true });
const cues = planCueLines(plan, wps, 'run');

describe('everything a plan writes fits what his unit keeps', () => {
  it('every waypoint name fits ten and every comment twenty', () => {
    assert.ok(wps.length > 100);
    const long = wps.filter((w) => w.name.length > UNIT_CHARS.name);
    assert.deepEqual(long.map((w) => w.name), []);
    const longCmt = wps.filter((w) => w.cmt && w.cmt.length > UNIT_CHARS.comment);
    assert.deepEqual(longCmt.map((w) => w.cmt), []);
  });

  it('every cue line fits fifteen and every track twenty', () => {
    assert.deepEqual(cues.filter((c) => c.name.length > UNIT_CHARS.route).map((c) => c.name), []);
    assert.deepEqual(planTracks(plan).filter((t) => t.name.length > UNIT_CHARS.track).map((t) => t.name), []);
  });

  it('a stop names its id and kind, a leg start its band, and each comment carries the rest', () => {
    const stop = wps.find((w) => w.stopId === 'S1.1');
    assert.equal(stop.name, 'S1.1 point');
    assert.equal(stop.cmt, 'point 19ft', '20 charted, 1.15 ft down');
    assert.equal(cues.find((c) => c.name.startsWith('S1-1')).name, 'S1-1 point 19ft',
      'a cue line keeps fifteen, so it has room for the depth');
    const start = wps.find((w) => w.legStart && w.legId === 'L1');
    assert.equal(start.name, 'L1 2-12ft');
    const change = wps.find((w) => w.changeId === 'C1');
    assert.equal(change.name, 'R3 DD2 Cra');
    assert.equal(change.cmt, 'R3 DD2 Crankbait', 'the whole lure, dropping "tie on" to fit');
  });

  it('writes the comment into the GPX, where the unit shows it as the second line', () => {
    const gpx = buildGPX({ waypoints: wps, tracks: [], routes: [] });
    assert.match(gpx, /<name>S1\.1 point<\/name>[\s\S]*?<cmt>point 19ft<\/cmt>/);
    assert.match(gpx, /<name>L1 2-12ft<\/name>[\s\S]*?<cmt>alarm 2-12 shd 3-13<\/cmt>/);
  });
});

describe('a boundary is drawn in its leg\'s colour', () => {
  it('every cue line carries the colour its leg\'s track draws in, a lure change included', () => {
    const tracks = new Map(planTracks(plan).map((t) => [t.legId, t.color]));
    for (const c of cues) assert.equal(c.color, tracks.get(c.legId), c.name);
    const change = cues.find((c) => c.cueKind === 'change' && c.name.startsWith('R3'));
    assert.equal(change.legId, 'L3', 'the change at 2,500 m falls on L3');
    assert.equal(legColor(legs[0], 0), '#00e5ff');
  });

  it('writes Garmin\'s colour index, in the order his unit\'s tracks carry it', () => {
    assert.equal(GARMIN_COLOR_ORDER[colorIndex('#00e5ff')], 'Cyan');
    assert.equal(GARMIN_COLOR_ORDER[colorIndex('#ff6d00')], 'DarkYellow');
    assert.equal(GARMIN_COLOR_ORDER[colorIndex('#7c4dff')], 'Magenta');
    assert.equal(colorIndex(null), 14, 'no colour is the Cyan his unit gives a converted route');
    const bds = cueBoundaries(cues);
    const bdy = bdyFile(bds, () => 0.5);
    const d = new DataView(bdy.buffer, bdy.byteOffset);
    let off = d.getUint32(0x25, true);
    for (const b of bds) {
      assert.equal(d.getUint32(off + 85, true), b.color);
      off = d.getUint32(off + 104, true) + 16 * b.pts.length;
    }
    assert.ok(new Set(bds.map((b) => b.color)).size > 3, 'more than one colour on the card');
  });
});
