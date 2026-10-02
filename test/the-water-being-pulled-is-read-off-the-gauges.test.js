// Personal use only, not for distribution or resale; not for navigation.
//
// WHEN THE WATER WAS BEING PULLED, READ OFF THE GAUGES THAT SHOW IT -- item 46.
//
// Checked 2026-10-01: Jefferies' tailrace (USGS 02172002) is plain on/off and Monticello's level
// (02160900) falls in the evening and refills in the morning. Offered as a moving-water line in the
// plan, given as the last days' hours; Ryan, 2026-10-02: "yeah go ahead on 46". The fixture is the
// real 15-minute record, 9/22-10/2, fetched that day.
//
//   node --test test/the-water-being-pulled-is-read-off-the-gauges.test.js
process.env.TZ = 'America/New_York';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { otsuSplit, tailraceCut, seriesFrom, gaugeLine, lastHours, MOVING_WATER_GAUGES, TIDE_CYCLE_DAYS }
  from '../js/utils/moving-water.js';
import { fetchMovingWater, movingWaterNote } from '../js/modules/plan-preflight.js';
import { conditionsFrom } from '../js/modules/plan-inputs.js';
import { movingWaterBlock } from '../js/modules/plan-prompt.js';

const FX = JSON.parse(readFileSync(new URL('./fixtures/moving-water-2026-10-02.json', import.meta.url), 'utf8'));
const asPayload = (rows) => ({ features: rows.map(([time, value]) => ({ properties: { time, value } })) });
const JEF = seriesFrom(asPayload(FX['02172002_00060']));
const MON = seriesFrom(asPayload(FX['02160900_00062']));
const JG = MOVING_WATER_GAUGES.lake_moultrie[0];
const MG = MOVING_WATER_GAUGES.monticello_reservoir[0];

test('otsuSplit parts two groups between them', () => {
  assert.equal(otsuSplit([0, 1, 2, 10, 11, 12]), 6);
  assert.equal(otsuSplit([5, 5, 5]), null);
});

test('on ten days of Jefferies the cut sits in the empty band between the tide and a run', () => {
  const cut = tailraceCut(JEF.map((p) => p.v));
  assert.ok(cut > 2000 && cut < 3500, `cut ${cut}`);
});

test('the last two days list the evening runs and the one-unit mornings, and name the tide', () => {
  const line = gaugeLine(JG, JEF);
  for (const s of ['9/30 16:00-23:15 (about 13,800 cfs)', '10/1 06:30-08:15 (about 5,800 cfs)',
                   '10/1 13:45-20:45', '10/2 06:30-08:00', 'through 10/2 09:45', 'the tide']) {
    assert.ok(line.includes(s), `missing "${s}" in: ${line}`);
  }
});

test('a neap-tide two days does not turn the tide into a run', () => {
  // 9/27-9/29: the strongest reverse flow in those two days was only 1,120 cfs, and the tide's own
  // upper half averaged about 1,200. Read over the cycle, no run is "about 1,000 cfs".
  const upTo = JEF.filter((p) => p.t <= Date.parse('2026-09-29T13:45:00Z'));
  const line = gaugeLine(JG, upTo);
  const flows = [...line.matchAll(/about ([\d,]+) cfs/g)].map((m) => Number(m[1].replace(/,/g, '')));
  assert.ok(flows.length >= 1);
  assert.ok(flows.every((f) => f >= 4000), line);
  assert.equal(JG.days, TIDE_CYCLE_DAYS);
});

test('a tailrace that only carried the tide did not run', () => {
  const t0 = Date.parse('2026-10-01T00:00:00Z');
  const tide = Array.from({ length: 192 }, (_, i) => ({ t: t0 + i * 900e3, v: Math.round(1500 * Math.sin(i / 7.9)) }));
  assert.match(gaugeLine(JG, tide), /did not run in the 48 hours/);
});

test('Monticello: when the level fell and when it rose, an evening and a morning at a time', () => {
  const line = gaugeLine(MG, MON);
  for (const s of ['fell 9/30 17:00-22:00', 'rose 10/1 09:00-12:00', 'fell 10/1 17:00-22:00', 'rose 10/2 01:00-07:00']) {
    assert.ok(line.includes(s), `missing "${s}" in: ${line}`);
  }
  assert.equal(lastHours(MON).length > 150, true);
});

test('the plan asks only the waters that have one, and a gauge that fails says so', async () => {
  const fake = async (url) => ({ ok: true, json: async () => asPayload(
    url.includes('02172002') ? FX['02172002_00060'] : FX['02160900_00062']) });
  const m = await fetchMovingWater('lake_moultrie', { fetch: fake });
  assert.equal(m.lines.length, 1);
  assert.match(m.lines[0], /^Jefferies tailrace/);
  assert.equal(await fetchMovingWater('wateree_lake', { fetch: fake }), null);
  const down = await fetchMovingWater('monticello_reservoir', { fetch: async () => ({ ok: false, status: 503 }) });
  assert.match(down.lines[0], /could not be read \(HTTP 503\)/);
  const marion = await fetchMovingWater('lake_marion', { fetch: fake });
  assert.equal(marion.lines.length, 3);
});

test('it reaches the model as history, and him as one line', () => {
  const lines = [gaugeLine(JG, JEF)];
  const c = conditionsFrom({ clarity: 'Stained' }, [-80, 33.2], null, null, null, { lines });
  assert.deepEqual(c.movingWater, lines);
  assert.equal(conditionsFrom({ clarity: 'Stained' }, [-80, 33.2], null, null, null, null).movingWater, undefined);
  const block = movingWaterBlock(c);
  assert.match(block, /HISTORY, not a schedule/);
  assert.match(block, /never tell him when the water will move today/);
  assert.equal(movingWaterBlock({}), '');
  assert.match(movingWaterNote(lines), /^moving water, from the gauges \(what they did, not a schedule\): Jefferies/);
  assert.equal(movingWaterNote([]), null);
  const prompt = readFileSync(new URL('../js/modules/plan-prompt.js', import.meta.url), 'utf8');
  assert.match(prompt, /\$\{movingWaterBlock\(o\.conditions\)\}/);
});
