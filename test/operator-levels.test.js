// The three operators that publish HTML instead of JSON.
//
// FIXTURES ARE THE REAL PAGE SOURCE. Ryan saved view-source from all three on 2026-08-16 into
// _pagesrc/ because neither the sandbox nor the device VM can reach these hosts; the files in
// test/fixtures/operators/ are those bytes, trimmed to the region each parser reads and
// otherwise untouched. Readings are from 2026-08-15 evening.
//
// TEXT WAS NOT ENOUGH, WHICH IS WHY THE SOURCE WAS NEEDED. Southern Company's empty Gen and
// Rain cells are &nbsp; in the markup and disappear in a tag strip, leaving
// "Allatoona 0 840.75 840" indistinguishable from a row whose first number is the elevation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseCubeLevels, parseSouthernCoLevels, parseBrookfieldFacility } from '../Worker/operators.js';
import { brookfieldShape } from '../Worker/conditions.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'operators');
const fx = (f) => readFileSync(path.join(DIR, f), 'utf8');

// ── Cube Carolinas ──────────────────────────────────────────────────────────────────────────

test('Cube: all four lakes, with the drawdown it publishes as its own column', () => {
  const { lakes, observedAt } = parseCubeLevels(fx('cube-levels.html'));
  assert.equal(lakes.length, 4);
  assert.deepEqual(lakes.map((l) => l.name), ['High Rock', 'Badin (Narrows)', 'Tuckertown', 'Falls']);
  const hr = lakes[0];
  assert.equal(hr.elevationFt, 653.40);
  assert.equal(hr.belowFullPondFt, 1.60);
  // Full pond falls out of the pair — no reference table needed.
  assert.equal(hr.fullPondFt, 655);
  assert.equal(observedAt, '8/15/2026 8:00 PM');
});

test('Cube: the forecast is an image, and the page legend is the key', () => {
  const { lakes } = parseCubeLevels(fx('cube-levels.html'));
  // fluctuate_F.gif / _S.gif — the legend on the page spells out F=FALL, S=SAME, R=RISE.
  assert.equal(lakes.find((l) => l.name === 'High Rock').forecast, 'falling');
  assert.equal(lakes.find((l) => l.name === 'Tuckertown').forecast, 'steady');
});

test('Cube: Tuckertown is the point of this — it has no pool binding at all today', () => {
  const t = parseCubeLevels(fx('cube-levels.html')).lakes.find((l) => l.name === 'Tuckertown');
  assert.equal(t.elevationFt, 595.34);
  assert.equal(t.fullPondFt, 596);
});

// ── Southern Company ────────────────────────────────────────────────────────────────────────

test('Southern Co: the column the tag strip destroyed is read correctly', () => {
  const { lakes } = parseSouthernCoLevels(fx('southernco-levels.html'));
  // Allatoona has a Rain value and Lanier does not. In text both collapse to a bare number
  // sequence; in markup the &nbsp; cell holds the position.
  const a = lakes.find((l) => l.name === 'Allatoona');
  assert.equal(a.rainIn, 0);
  assert.equal(a.currentFt, 840.75);
  assert.equal(a.fullFt, 840);
  const lanier = lakes.find((l) => l.name === 'Lanier (Buford Dam)');
  assert.equal(lanier.rainIn, null);
  assert.equal(lanier.currentFt, 1066.41);
  assert.equal(lanier.fullFt, 1071);
});

test('Southern Co: it agrees with the Corps on the two lakes they share', () => {
  const { lakes } = parseSouthernCoLevels(fx('southernco-levels.html'));
  // USACE Top of Conservation for mid-August: Hartwell 660, Thurmond 330. Two independent
  // operators, same numbers — which is the standard a derived value has to meet.
  assert.equal(lakes.find((l) => l.name === 'Hartwell').fullFt, 660);
  assert.equal(lakes.find((l) => /Clark Hill/i.test(l.name)).fullFt, 330);
  assert.equal(lakes.find((l) => /Clark Hill/i.test(l.name)).currentFt, 323.22);
});

test('Southern Co: a lake it publishes but is not reporting is kept and flagged', () => {
  const { lakes, readingsFor } = parseSouthernCoLevels(fx('southernco-levels.html'));
  const athens = lakes.find((l) => l.name === 'Athens');
  assert.ok(athens, 'Athens is on the page and must not be dropped');
  assert.equal(athens.reporting, false);
  assert.equal(athens.currentFt, null);
  // "not reporting today" and "not on the page" are different answers.
  assert.ok(lakes.filter((l) => l.reporting).length >= 20);
  assert.equal(readingsFor, '08/15/26');
});

test('Southern Co: spacer rows and the header do not become lakes', () => {
  const { lakes } = parseSouthernCoLevels(fx('southernco-levels.html'));
  assert.ok(!lakes.some((l) => !l.name || /^lake$/i.test(l.name)));
});

// ── Brookfield ──────────────────────────────────────────────────────────────────────────────

test('Brookfield: two unlabelled feet values are told apart by magnitude', () => {
  const b = parseBrookfieldFacility(fx('brookfield-santeetlah.html'));
  assert.equal(b.facility, 'Santeetlah');
  // <h5>1939.61 ft as of ...</h5> and <h5>-1.30 ft as of ...</h5>, neither with a <p> label.
  assert.equal(b.elevationFt, 1939.61);
  assert.equal(b.belowFullPondFt, 1.30);
  assert.ok(/unlabelled/.test(b.note), 'the assumption must travel with the answer');
});

test('Brookfield: the pair checks itself against the published full pond', () => {
  const b = parseBrookfieldFacility(fx('brookfield-santeetlah.html'));
  // 1939.61 + 1.30 = 1940.91, against a published full pond of 1,940.9. If the two values were
  // assigned the wrong way round this sum would be obviously wrong instead of plausible.
  assert.equal(b.fullPondFt, 1940.91);
  assert.ok(Math.abs(b.fullPondFt - 1940.9) < 0.05);
});

test('Brookfield: discharges keep the river they go into', () => {
  const b = parseBrookfieldFacility(fx('brookfield-santeetlah.html'));
  assert.equal(b.discharges.length, 2);
  assert.deepEqual(b.discharges.map((d) => d.cfs), [809.39, 54.97]);
  assert.match(b.discharges[0].into, /Little Tennessee/);
  assert.match(b.discharges[1].into, /Cheoah/);
  assert.equal(b.updatedAt, 'Sat, August 15, 08:48:53 pm (EDT)');
});

test('an empty or unexpected page returns nothing rather than guessing', () => {
  assert.deepEqual(parseCubeLevels('<html></html>').lakes, []);
  assert.deepEqual(parseSouthernCoLevels('').lakes, []);
  assert.equal(parseBrookfieldFacility('<html></html>').elevationFt, null);
});

// ── the binding the pipeline writes, and what conditions.js does with it ────────────────────
//
// scripts/bind_operator_lakes.py resolves feed names to slugs offline by geometry and writes
// `operator: {operator, feed_name, url, why}` into water_bindings.json. conditions.js reads
// that and looks the row up by feed_name — an exact string, because the fuzzy part already
// happened in the pipeline where the whole registry was available.
test('the bound feed_name finds its row exactly', () => {
  const sc = parseSouthernCoLevels(fx('southernco-levels.html'));
  // These are the strings bind_operator_lakes.py actually wrote, verbatim.
  for (const [feedName, expectFull] of [
    ['Hartwell', 660], ['Russell', 475], ['Lanier (Buford Dam)', 1071],
    ['Oconee (Wallace Dam)', 435], ['Sinclair', 340], ['Jackson (Lloyd Shoals Dam)', 530],
  ]) {
    const row = sc.lakes.find((l) => l.name === feedName);
    assert.ok(row, `bound feed_name "${feedName}" must exist on the page`);
    assert.equal(row.fullFt, expectFull);
  }
  const cu = parseCubeLevels(fx('cube-levels.html'));
  for (const feedName of ['High Rock', 'Badin (Narrows)', 'Tuckertown']) {
    assert.ok(cu.lakes.find((l) => l.name === feedName), `bound feed_name "${feedName}" must exist`);
  }
});

test('below-full-pond is derived the same way on both operators', () => {
  // Cube publishes the drawdown; Southern Company publishes current and full and it is
  // subtracted. Both reach the caller as below_full_pond_ft so the app reads one field.
  const cu = parseCubeLevels(fx('cube-levels.html')).lakes.find((l) => l.name === 'High Rock');
  assert.equal(cu.belowFullPondFt, 1.60);
  assert.equal(Math.round((cu.fullPondFt - cu.elevationFt) * 100) / 100, 1.60);

  const sc = parseSouthernCoLevels(fx('southernco-levels.html')).lakes.find((l) => l.name === 'Hartwell');
  assert.equal(Math.round((sc.fullFt - sc.currentFt) * 100) / 100, 8.31);
});

test('a lake bound to no operator is not a gap — Cube publishes four and we ship three', () => {
  const cu = parseCubeLevels(fx('cube-levels.html'));
  assert.equal(cu.lakes.length, 4);
  // "Falls" is on the page and deliberately bound to nothing: Cube's Falls Reservoir is not in
  // the index, and all three same-named candidates are other rivers.
  assert.ok(cu.lakes.some((l) => l.name === 'Falls'));
});

// ── the shape that reaches /conditions ──────────────────────────────────────────────────────
//
// A DRAWDOWN WITH NO ELEVATION IS A READING, NOT A FAILURE. Santeetlah and Cheoah publish both
// conventions; Chilhowee and Calderwood publish only feet-below-full-pool. The gate in
// operatorLevel() was `f.elevationFt != null`, which turned those two into `operator: null` and
// discarded the number that answers "how far down is the lake".

const OP = { url: 'https://www.safewaters.com/facility/chilhowee/', feed_name: 'Chilhowee',
             why: 'unique name' };

test('Brookfield: a page with only a drawdown still returns a reading', () => {
  const out = brookfieldShape(parseBrookfieldFacility(fx('brookfield-chilhowee.html')), OP);
  assert.ok(out, 'no elevation must not mean no answer');
  assert.equal(out.elevation_ft, null);
  assert.equal(out.below_full_pond_ft, 1.05);
  assert.equal(out.full_pond_ft, null, 'full pond cannot be derived from one number');
  assert.equal(out.observed_at, '2026-08-16 01:40:23 PM (EDT)');
  assert.equal(out.note, null, 'nothing was told apart by magnitude, so nothing to disclose');
});

test('Brookfield: the drawdown-only page keeps its discharge', () => {
  const out = brookfieldShape(parseBrookfieldFacility(fx('brookfield-chilhowee.html')), OP);
  assert.equal(out.discharges.length, 1);
  assert.equal(out.discharges[0].cfs, 9448.50);
  assert.match(out.discharges[0].into, /Little Tennessee/);
});

test('Brookfield: a page with both stamps observed_at from the elevation, not the drawdown', () => {
  // They are separate observations a minute apart. Stamping one with the other's time would be
  // inventing an observation.
  const f = parseBrookfieldFacility(fx('brookfield-santeetlah.html'));
  const out = brookfieldShape(f, { url: 'u', feed_name: 'Santeetlah', why: 'unique name' });
  assert.equal(out.elevation_ft, 1939.61);
  assert.equal(out.observed_at, f.elevationAt);
  assert.notEqual(f.elevationAt, f.drawdownAt);
  assert.equal(out.full_pond_ft, 1940.91);
  assert.match(out.note, /unlabelled/);
});

test('Brookfield: a page with no readings at all is still null', () => {
  assert.equal(brookfieldShape(parseBrookfieldFacility('<h1>Nowhere</h1>'), OP), null);
  assert.equal(brookfieldShape(null, OP), null);
});

test('Brookfield: the binding supplies the URL and why, never the page', () => {
  const out = brookfieldShape(parseBrookfieldFacility(fx('brookfield-chilhowee.html')), OP);
  assert.equal(out.url, OP.url);
  assert.equal(out.feed_name, 'Chilhowee');
  assert.equal(out.bound_by, 'unique name');
  assert.equal(out.source, 'Brookfield / safewaters.com');
});
