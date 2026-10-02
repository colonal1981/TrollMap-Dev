// Personal use only, not for distribution or resale; not for navigation.
//
// WHEN THE WATER WAS BEING PULLED, READ OFF THE GAUGES THAT SHOW IT -- item 46.
//
// Ryan, 2026-10-02: "yeah go ahead on 46", then, when the first version named three lakes' gauges
// by hand: "remember my rule no lake gets something that isn't available to all... build the
// general version". The gauges come from _registry/moving_water_gauges.json (built for every lake by
// Scripts/build_moving_water.py); this holds the wording and the reads. The fixture is the real
// 15-minute record, 9/22-10/2, fetched that day.
//
//   node --test test/the-water-being-pulled-is-read-off-the-gauges.test.js
process.env.TZ = 'America/New_York';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { otsuSplit, tailraceCut, seriesFrom, gaugeLine, lastHours, daysFor, TIDE_CYCLE_DAYS }
  from '../js/utils/moving-water.js';
import { fetchMovingWater, movingWaterNote } from '../js/modules/plan-preflight.js';
import { movingWaterGaugesFor, resetMovingWaterGauges, MOVING_WATER_PATH } from '../js/data/moving-water-gauges.js';
import { conditionsFrom } from '../js/modules/plan-inputs.js';
import { movingWaterBlock } from '../js/modules/plan-prompt.js';

const FX = JSON.parse(readFileSync(new URL('./fixtures/moving-water-2026-10-02.json', import.meta.url), 'utf8'));
const asPayload = (rows) => ({ features: rows.map(([time, value]) => ({ properties: { time, value } })) });
const JEF = seriesFrom(asPayload(FX['02172002_00060']));
const MON = seriesFrom(asPayload(FX['02160900_00062']));
// Rows as build_moving_water.py writes them.
const JG = { site: '02172002', param: '00060', role: 'outflow', name: 'LAKE MOULTRIE TAILRACE CANAL AT MONCKS CORNER, SC',
             via: 'cooper_river', viaName: 'Cooper River', km: 1.2 };
const MG = { site: '02160900', param: '00062', role: 'level', name: 'MONTICELLO RES NR JENKINSVILLE, SC',
             via: 'monticello_reservoir', km: 0 };

test('otsuSplit parts two groups between them', () => {
  assert.equal(otsuSplit([0, 1, 2, 10, 11, 12]), 6);
  assert.equal(otsuSplit([5, 5, 5]), null);
});

test('a tidal tailrace: the cut sits in the empty band between the tide and a run', () => {
  const cut = tailraceCut(JEF.map((p) => p.v));
  assert.ok(cut > 2000 && cut < 3500, `cut ${cut}`);
});

test('the last two days list the evening runs and the one-unit mornings, and the flow back up', () => {
  const line = gaugeLine(JG, JEF);
  for (const s of ['below the lake on Cooper River, 1.2 km from it', '9/30 16:00-23:15 (about 13,800 cfs)',
                   '10/1 06:30-08:15 (about 5,800 cfs)', '10/1 13:45-20:45', '10/2 06:30-08:00',
                   'through 10/2 09:45', 'flowing back upstream.']) {
    assert.ok(line.includes(s), `missing "${s}" in: ${line}`);
  }
});

// The rediversion canal at St. Stephen, the other gauge below Moultrie, on 10/2: a steady 100-200
// cfs, four one-reading surges in 15 days (3,400-6,700 cfs), and a few hours of back-flow after
// each. No tide. The first general line said "ran 10/1 00:45-00:45 ... the tide pushing back
// upstream": a span that was not there and a cause nobody read.
test('a surge of one reading says so, and the back-flow after it is not called the tide', () => {
  const RX = JSON.parse(readFileSync(new URL('./fixtures/rediversion-canal-2026-10-02.json', import.meta.url), 'utf8'));
  const RED = seriesFrom(asPayload(RX['02171645_00060']));
  const RG = { site: '02171645', param: '00060', role: 'outflow', name: 'REDIV CANAL AT SANTEE RIVER NR ST STEPHEN, SC',
               via: 'santee_river', viaName: 'Santee River', km: 8.2 };
  const line = gaugeLine(RG, RED);
  for (const s of ['10/1 00:45 for one reading (5,330 cfs)', '10/2 12:30 for one reading (3,410 cfs)',
                   'down to -1,120 cfs, flowing back upstream.']) {
    assert.ok(line.includes(s), `missing "${s}" in: ${line}`);
  }
  assert.doesNotMatch(line, /00:45-00:45|tide/);
});

test('a neap-tide two days does not turn the tide into a run, because the cut reads a full cycle', () => {
  const upTo = JEF.filter((p) => p.t <= Date.parse('2026-09-29T13:45:00Z'));
  const flows = [...gaugeLine(JG, upTo).matchAll(/about ([\d,]+) cfs/g)].map((m) => Number(m[1].replace(/,/g, '')));
  assert.ok(flows.length >= 1);
  assert.ok(flows.every((f) => f >= 4000), String(flows));
  assert.equal(daysFor(JG), TIDE_CYCLE_DAYS);
  assert.equal(daysFor(MG), 2);
});

test('a tidal flow that only carried the tide did not run', () => {
  const t0 = Date.parse('2026-10-01T00:00:00Z');
  const tide = Array.from({ length: 192 }, (_, i) => ({ t: t0 + i * 900e3, v: Math.round(1500 * Math.sin(i / 7.9)) }));
  assert.match(gaugeLine(JG, tide), /did not run in the 48 hours/);
});

test('any other flow or level is each day\'s low and high, with nothing decided about it', () => {
  const lvl = gaugeLine(MG, MON);
  for (const s of ["the lake's own level", '9/30 low 422.96 ft at 22:30, high 424.33 at 13:00',
                   '10/1 low 422.53 ft at 22:00, high 423.79 at 12:00']) {
    assert.ok(lvl.includes(s), `missing "${s}" in: ${lvl}`);
  }
  const t0 = Date.parse('2026-10-01T04:00:00Z');
  const dam = Array.from({ length: 192 }, (_, i) => ({ t: t0 + i * 900e3, v: (i % 96) >= 56 && (i % 96) < 80 ? 12000 : 900 }));
  const flow = gaugeLine({ ...JG, site: '0', name: 'X BELOW Y DAM' }, dam);
  assert.match(flow, /low 900 cfs at \d\d:\d\d, high 12,000 at \d\d:\d\d/);
  assert.doesNotMatch(flow, /\bran\b/);
  assert.ok(lastHours(MON).length > 150);
});

test('a river into the lake is where it is now against two days before', () => {
  const t0 = Date.parse('2026-10-01T04:00:00Z');
  const s = Array.from({ length: 192 }, (_, i) => ({ t: t0 + i * 900e3, v: 73 + i / 1000 }));
  const line = gaugeLine({ site: '02169750', param: '00065', role: 'inflow', name: 'Congaree River above Fort Motte',
                           via: 'congaree_river', viaName: 'Congaree River', km: 9.4 }, s);
  assert.match(line, /on Congaree River, which feeds the lake, 9\.4 km above it: 73\.19 ft at .*73\.00 ft 48 hours before/);
});

test('the gauges come from the registry file, for whatever lake it has them, and nothing else', async () => {
  resetMovingWaterGauges();
  const file = { waters: { any_lake_at_all: [JG, MG] } };
  const calls = [];
  const fake = async (url) => {
    calls.push(url);
    if (url.endsWith(MOVING_WATER_PATH)) return { ok: true, json: async () => file };
    return { ok: true, json: async () => asPayload(url.includes('02172002') ? FX['02172002_00060'] : FX['02160900_00062']) };
  };
  assert.deepEqual(await movingWaterGaugesFor('any_lake_at_all', { worker: 'https://w', fetch: fake }), [JG, MG]);
  const m = await fetchMovingWater('any_lake_at_all', { worker: 'https://w', fetch: fake });
  assert.equal(m.lines.length, 2);
  assert.match(m.lines[0], /^LAKE MOULTRIE TAILRACE/);
  assert.ok(calls.some((u) => /monitoring_location_id=USGS-02172002&parameter_code=00060/.test(u)));
  assert.equal(await fetchMovingWater('a_lake_the_file_has_nothing_for', { worker: 'https://w', fetch: fake }), null);
  const down = await fetchMovingWater('x', { gauges: [MG], fetch: async () => ({ ok: false, status: 503 }) });
  assert.match(down.lines[0], /could not be read \(HTTP 503\)/);
  resetMovingWaterGauges();
});

test('no lake is named in the code that decides which gauges or how they are read', () => {
  const live = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const f of ['js/utils/moving-water.js', 'js/data/moving-water-gauges.js']) {
    assert.doesNotMatch(live(f), /['"`][a-z_]*(lake|reservoir|_river)[a-z_]*['"`]/, f);
    assert.doesNotMatch(live(f), /\b0\d{7}\b/, `${f} names a gauge`);
  }
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
  assert.match(movingWaterNote(lines), /^moving water, from the gauges \(what they did, not a schedule\): LAKE MOULTRIE/);
  assert.equal(movingWaterNote([]), null);
  const prompt = readFileSync(new URL('../js/modules/plan-prompt.js', import.meta.url), 'utf8');
  assert.match(prompt, /\$\{movingWaterBlock\(o\.conditions\)\}/);
});
