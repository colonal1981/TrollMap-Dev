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
