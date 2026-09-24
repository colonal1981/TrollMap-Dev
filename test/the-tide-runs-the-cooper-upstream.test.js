// Personal use only, not for distribution or resale; not for navigation.
//
// A NEGATIVE DISCHARGE IS THE TIDE, NOT A LOW RIVER.
//
// The Cooper's USGS discharge goes negative on a flooding tide. `assessKayakSafety` banded cfs
// from danger down to calm and caught everything under `cfsCalm` in its last branch, so every
// flood tide on the Cooper printed "Streamflow -<n> cfs is LOW -- expect skinny water and
// possible portaging over shoals" on a tidal river several metres deep. The Santee's own notes
// in worker-data.js say its flow can reverse too.
//
// The function is not exported and the Worker module pulls in the whole route table, so it is
// lifted from source. A failed lift fails the test rather than silently testing nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../Worker/trollmap-worker.js', import.meta.url), 'utf8');
const start = SRC.indexOf('function assessKayakSafety(');
assert.ok(start >= 0, 'assessKayakSafety must exist');
const end = SRC.indexOf('\n}', start);
assert.ok(end > start, 'it must be a top-level function');
const assessKayakSafety = new Function(`${SRC.slice(start, end + 2)}\nreturn assessKayakSafety;`)();

// Bands shaped like a river's: the numbers only have to order the branches.
const T = { cfsDanger: 20000, cfsPushy: 10000, cfsNormal: 3000, cfsCalm: 500,
            gageRiseDangerFtPerHr: 1, coldTempStressF: 60 };

test('a reversed flow is not called LOW', () => {
  const r = assessKayakSafety('cooper', { streamflow: -4200 }, T);
  assert.equal(r.reasons.some((s) => /\bLOW\b/.test(s)), false, r.reasons.join(' | '));
  assert.equal(r.reasons.some((s) => /portag/i.test(s)), false, r.reasons.join(' | '));
});

test('it says the water is running upstream, and carries the number', () => {
  const r = assessKayakSafety('cooper', { streamflow: -4200 }, T);
  assert.ok(r.reasons.some((s) => /UPSTREAM/.test(s) && s.includes('-4200')), r.reasons.join(' | '));
  assert.equal(r.metrics.streamflow_cfs, -4200);
});

test('a reversal decides nothing on its own -- the tide is not what the bands were set against', () => {
  assert.equal(assessKayakSafety('cooper', { streamflow: -4200 }, T).status, 'go');
  // ...and the other signals still decide: a rapid rise on the same reading is still no-go.
  const r = assessKayakSafety('cooper', { streamflow: -4200, rateOfRiseFtPerHr: 2 }, T);
  assert.equal(r.status, 'no-go');
});

test('a real low river still reads LOW', () => {
  const r = assessKayakSafety('congaree', { streamflow: 120 }, T);
  assert.ok(r.reasons.some((s) => /\bLOW\b/.test(s)), r.reasons.join(' | '));
});

test('zero is not a reversal', () => {
  const r = assessKayakSafety('congaree', { streamflow: 0 }, T);
  assert.equal(r.reasons.some((s) => /UPSTREAM/.test(s)), false);
});
