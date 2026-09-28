// THE JULY CAST STILL SET THE BAITS.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Change request 21 (2026-09-26) made a Wateree oxygen cast from 2022-07-21 stop capping a
// September trip's leads. It fixed ONE reader of that cast. Two more went on reading it as a floor:
//
//   - depthBandFor()'s clampToOxygen() cut the fish band at 19.7 ft -- the 9/28 plan's basis read
//     "built-in table, Lake Wateree ... clamped from 20 ft to the 19.7 ft anoxic line";
//   - researchIntel() told the model "Anoxic below: 19.7 ft - nothing holds under this in late
//     summer", and "Oxygen depletion begins: 16.4 ft", with no word that it was July.
//
// The model kept both of Ryan's 9/28 Wateree baits above 16.4 ft (a blade at 5-9 ft and a swimbait
// at 12-16 ft) -- the day after his own sonar on that water put the densest fish at 16-24 ft and
// half the marks below 19.7. Ryan: "i bet if you look at my sonar report from saturday everything
// we are fishing is way above the fish". It was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { depthBandFor, researchIntel, oxygenCastsOutOfSeason } from '../js/modules/plan-inputs.js';

const WATEREE = { identity: { bodyType: 'reservoir' }, limnology: { oxygen: {
  depletionDepthFt: 16.4, anoxicBelowFt: 19.7,
  note: 'measured vertical profile, EPA National Lakes Assessment 7/21/2022' } } };
const text = (x) => (Array.isArray(x) ? x.join('\n') : String(x || ''));

test('the casts are out of season in September and in season in July', () => {
  assert.deepEqual(oxygenCastsOutOfSeason(WATEREE, null, '2026-09-28'), ['July']);
  assert.equal(oxygenCastsOutOfSeason(WATEREE, null, '2026-07-10'), null);
  assert.equal(oxygenCastsOutOfSeason(WATEREE, null, null), null);
  assert.equal(oxygenCastsOutOfSeason(WATEREE, null, new Date('2026-09-28T12:00:00')).length, 1);
});

test('a July cast does not cut a September fish band, and the band says why', () => {
  const d = depthBandFor('Striped Bass', 'Lake Wateree, SC', 'fall', null, WATEREE,
                         new Date('2026-09-28T12:00:00'));
  assert.ok(d && d.band, 'a band');
  assert.ok(d.band[1] > 19.7, `the top of the band is not 19.7: ${d.band}`);
  assert.equal(d.clampedByOxygenFt, undefined);
  assert.match(d.basis, /NOT clamped to the 19\.7 ft anoxic line, which was measured in July/);
});

test('in July, and with no date, the clamp stands exactly as before', () => {
  const july = depthBandFor('Striped Bass', 'Lake Wateree, SC', 'summer', null, WATEREE,
                            new Date('2026-07-15T12:00:00'));
  const none = depthBandFor('Striped Bass', 'Lake Wateree, SC', 'fall', null, WATEREE);
  for (const d of [july, none]) {
    if (d && d.band && d.band[1] > 19.7 && d.clampedByOxygenFt == null) {
      assert.fail(`expected the 19.7 ft clamp: ${JSON.stringify(d)}`);
    }
  }
  assert.equal(none.clampedByOxygenFt, 19.7);
});

test('the model is told it was July, not that nothing holds under it', () => {
  const t = text(researchIntel(WATEREE, 'Striped Bass', 'fall', Date.now(), null,
                               { tempF: null, tempFrom: null, when: '2026-09-28T12:00:00' }));
  assert.match(t, /Anoxic below: 19\.7 ft when it was measured \(July, not this month\)/);
  assert.match(t, /NONE OF THOSE CASTS IS FROM THIS MONTH/);
  assert.doesNotMatch(t, /nothing holds under this/);
});

test('with no trip date the research reads as it always has', () => {
  const t = text(researchIntel(WATEREE, 'Striped Bass', 'fall', Date.now(), null, null));
  assert.match(t, /nothing holds under this in late summer/);
  assert.doesNotMatch(t, /NONE OF THOSE CASTS/);
});

test('both planners hand the trip date to the band', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  for (const f of ['js/modules/smart-plan-v2-wiring.js', 'js/modules/plan-water-ui.js']) {
    const s = readFileSync(join(root, f), 'utf8').replace(/\s+/g, ' ');
    assert.match(s, /depthBandFor\(species, inp\.lakeName, .{0,80}?inp\.waterTempF, researched, date\)/, f);
  }
});
