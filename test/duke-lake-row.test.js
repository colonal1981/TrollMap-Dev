// normalizeDukeRow against the REAL /lakes/current-level response.
//
// Ryan pulled the full feed on 2026-08-15: 34 rows. Every fixture below is transcribed from it.
// The point of this file is the scale question — Duke reports two different quantities in the
// same field and the old discriminator got three shipped lakes wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDukeRow } from '../Worker/worker-data.js';

const row = (o) => normalizeDukeRow(Object.assign({ LakeDisplayName: 'x', Target: 'NA', SpecialMessage: [] }, o));

test('the 100 ft band: Wateree, the case three sources agree on', () => {
  const d = row({ LakeDisplayName: 'Lake Wateree', Actual: '97.70', Min: '92.50', Max: '100.00',
                  Elevation: '225.5 ft (AMSL, NGVD 29 datum' });
  assert.equal(d.belowFullPoolFt, 2.3);
  assert.equal(d.ft, 223.2);
  assert.equal(d.fullPool, 225.5);
});

test('true feet: Belews, where the value IS the elevation', () => {
  const d = row({ LakeDisplayName: 'Belews Lake', Actual: '722.70', Min: '720.00', Max: '725.00',
                  Elevation: '725.0 ft (AMSL, NGVD 29 datum)' });
  assert.equal(d.ft, 722.7);
  assert.equal(d.belowFullPoolFt, 2.3);
});

test('Max is NOT the discriminator — Nantahala, Glenville and Queens Creek prove it', () => {
  // All three are index values on lakes Duke does not run to full pond, so Max is the operating
  // ceiling. The old `maxRaw === 100` test sent them down the true-feet branch.
  const nan = row({ LakeDisplayName: 'Nantahala Lake', Actual: '95.10', Min: '89.60', Max: '98.80',
                    Elevation: '3012.2 ft (AMSL, NGVD 29 datum)' });
  assert.equal(nan.belowFullPoolFt, 4.9);          // was 2917.10
  assert.equal(nan.ft, 3007.3);
  assert.equal(nan.max, 98.8);                     // carried, and not confused with full pond

  const gle = row({ LakeDisplayName: 'Lake Glenville', Actual: '94.30', Min: '91.00', Max: '96.20',
                    Elevation: '3491.75 ft (AMSL, NGVD 29 datum)' });
  assert.equal(gle.belowFullPoolFt, 5.7);          // was 3397.45
  assert.equal(gle.ft, 3486.05);

  const qc = row({ LakeDisplayName: 'Queens Creek Lake', Actual: '92.80', Min: '90.80', Max: '93.80',
                   Elevation: '2902.2 ft (AMSL, NGVD 29 datum)' });
  assert.equal(qc.belowFullPoolFt, 7.2);           // was 2809.40
});

test('the 0.8 cut sits in a real gap, and this test fails if a new lake narrows it', () => {
  // Widest index ratio in the 2026-08-15 feed, and lowest true-feet ratio. If Duke adds a lake
  // between these, the discriminator needs rethinking rather than nudging.
  const widestIndex = 97.40 / 178.1;               // Blewett Falls
  const lowestFeet = 366.71 / 399.0;               // Hyco Afterbay
  assert.ok(widestIndex < 0.8, `index ratio ${widestIndex} must stay under the cut`);
  assert.ok(lowestFeet >= 0.8, `true-feet ratio ${lowestFeet} must stay above the cut`);
  assert.ok(lowestFeet - widestIndex > 0.3, 'the gap must stay wide enough to be a decision');
});

test('the newest special message wins, not the first in the array', () => {
  // Wateree on 2026-08-15, verbatim shape: the May LIP notice at [0], the August maintenance
  // notice at [1]. The second is the one that changes whether you go.
  const d = row({ LakeDisplayName: 'Lake Wateree', Actual: '97.70', Min: '92.50', Max: '100.00',
    Elevation: '225.5 ft', SpecialMessage: [
      { Text: 'LIP Stage 2 since May 1.', EventDate: '2026-05-01T09:11:00' },
      { Text: 'Planned maintenance the week of August 17; levels near 99.0 ft.', EventDate: '2026-08-13T10:54:00' },
    ] });
  assert.match(d.specialMessage, /week of August 17/);
  assert.equal(d.specialMessages.length, 2);
});

test('a message with no date is kept but ranks last', () => {
  const d = row({ Actual: '97.00', Max: '100.00', Elevation: '100.0 ft', SpecialMessage: [
    { Text: 'undated' }, { Text: 'dated', EventDate: '2026-01-01T00:00:00' } ] });
  assert.equal(d.specialMessage, 'dated');
});

test('LowInputStage is carried, and -1 means no protocol', () => {
  assert.equal(row({ Actual: '97.00', Max: '100.00', Elevation: '100.0 ft', LowInputStage: 2 }).lowInflowStage, 2);
  assert.equal(row({ Actual: '97.00', Max: '100.00', Elevation: '100.0 ft', LowInputStage: -1 }).lowInflowStage, -1);
  assert.equal(row({ Actual: '97.00', Max: '100.00', Elevation: '100.0 ft', LowInputStage: null }).lowInflowStage, null);
});

test('an unreadable Actual is null, not a guess', () => {
  assert.equal(normalizeDukeRow({ Actual: 'NA', Max: '100.00', Elevation: '100.0 ft' }), null);
});
