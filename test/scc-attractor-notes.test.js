// Santee Cooper Country's depth and buoy notes on SCDNR's Marion and Moultrie attractors.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-10-01: "does this match what we have from dnr
// https://www.santeecoopercountry.org/fishing/attractors/" and, to showing their depth and buoy
// notes in the popup, "both sound good" (APP_CHANGE_REQUESTS item 43).
//
// What these hold:
//   1. every note sits on a point the live SCDNR feed had on 2026-10-01, and each pair is mutual:
//      SCC's site is that point's nearest SCC site and that point is the site's nearest SCDNR point;
//   2. the numbering difference is kept as found: SCC's 20 is SCDNR's Marion #21;
//   3. SCC's comment is carried verbatim, the missing buoy included, and a material is written
//      only where the two lists name different ones;
//   4. a note is SCC's word under SCDNR's point: SC rows only, the point never moves, and the
//      popup names the source, the date and which way SCC's coordinate lies;
//   5. the map layer shows it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCC_ATTRACTOR_NOTES, SCC_ATTRACTOR_SOURCE, sccNoteFor, offsetToScc } from '../js/data/scc-attractor-notes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(HERE, '..', f), 'utf8');
const FEED = JSON.parse(read('test/fixtures/scdnr-attractors-santee-cooper.2026-10-01.json')).points;
const NOTES = Object.entries(SCC_ATTRACTOR_NOTES);
const metres = (a, b) => offsetToScc(a.lat, a.lon, b).m;

test('every note is on a point SCDNR publishes, and every pair is mutual', () => {
  assert.equal(NOTES.length, 32);
  const byName = new Map(FEED.map((p) => [p.name, p]));
  for (const [name, e] of NOTES) {
    const p = byName.get(name);
    assert.ok(p, `${name} is not in the SCDNR feed`);
    const nearestScc = NOTES.reduce((best, [, o]) => (metres(p, o) < metres(p, best) ? o : best), e);
    assert.equal(nearestScc.scc, e.scc, `${name}: SCC site ${e.scc} is not its nearest SCC site`);
    const nearestDnr = FEED.reduce((best, q) => (metres(q, e) < metres(best, e) ? q : best), p);
    assert.equal(nearestDnr.name, name, `SCC site ${e.scc}: ${name} is not its nearest SCDNR point`);
  }
});

test('SCC numbers SCDNR\'s Marion #21 as 20, and the three Marion sites SCC does not list get nothing', () => {
  assert.equal(SCC_ATTRACTOR_NOTES['Fish Attractor #21 Lake Marion'].scc, '20');
  assert.ok(!NOTES.some(([, e]) => e.scc === '21'));
  for (const n of [34, 35, 36]) assert.equal(SCC_ATTRACTOR_NOTES[`Fish Attractor #${n} Lake Marion`], undefined);
  for (let n = 1; n <= 19; n++) assert.equal(SCC_ATTRACTOR_NOTES[`Fish Attractor #${n} Lake Moultrie`].scc, String(n));
});

test('the comment is SCC\'s, verbatim; a material is written only where the lists differ', () => {
  const m16 = SCC_ATTRACTOR_NOTES['Fish Attractor #16 Lake Moultrie'];
  assert.equal(m16.buoy, 'NO');
  assert.equal(m16.note, 'BUOY MISSING');
  assert.equal(m16.depthFt, 20);
  assert.equal(SCC_ATTRACTOR_NOTES['Fish Attractor #11 Lake Moultrie'].note, 'BUOY OFF 198 FEET TO THE EAST');
  const withMaterial = NOTES.filter(([, e]) => e.material).map(([, e]) => e.scc).sort();
  assert.deepEqual(withMaterial, ['3', '4']);
  for (const [name, e] of NOTES.filter(([, e]) => e.material)) {
    assert.equal(FEED.find((p) => p.name === name).type, 'brush/trees');
    assert.match(e.note, /CULVERT/);
  }
  assert.equal(SCC_ATTRACTOR_SOURCE.checked, '2026-10-01');
  assert.match(SCC_ATTRACTOR_SOURCE.url, /^https:\/\/www\.santeecoopercountry\.org\/fishing\/attractors\/$/);
});

test('a note is for SC rows only and says how far and which way SCC\'s coordinate is', () => {
  const p = FEED.find((q) => q.name === 'Fish Attractor #1 Lake Moultrie');
  assert.equal(sccNoteFor({ ...p, state: 'GA' }), null);
  assert.equal(sccNoteFor({ ...p, name: 'Fish Attractor #1 Lake Murray', state: 'SC' }), null);
  const n = sccNoteFor({ ...p, state: 'SC' });
  assert.equal(n.scc, '1');
  assert.equal(n.offset.dir, 'NE');
  assert.ok(n.offset.m > 20 && n.offset.m < 30, `${n.offset.m}`);
});

test('the attractor popup shows the note under SCDNR\'s point and does not move it', () => {
  const src = read('js/modules/gis-toggles.js');
  assert.match(src, /import \{ sccNoteFor, SCC_ATTRACTOR_SOURCE \} from '\.\.\/data\/scc-attractor-notes\.js';/);
  assert.match(src, /buildPopup\(h\.name \|\| 'Attractor', type, lat, lon, ico, color, sccNoteHtml\(sccNoteFor\(h\)\)\)/);
  assert.match(src, /L\.circleMarker\(\[lat, lon\]/);
  const fn = src.slice(src.indexOf('function sccNoteHtml'), src.indexOf('function buildPopup'));
  for (const s of ['SCC_ATTRACTOR_SOURCE.label', 'SCC_ATTRACTOR_SOURCE.checked', 'n.depthFt', 'n.note', 'n.material', 'n.offset.dir']) {
    assert.ok(fn.includes(s), `the popup note does not show ${s}`);
  }
});
