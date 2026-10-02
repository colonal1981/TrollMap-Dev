// Personal use only, not for distribution or resale; not for navigation.
//
// A GAUGE ON THE MAIN LAKE DOES NOT READ A POOL CUT OFF FROM IT.
//
// 2026-10-02. His first plan from Monticello's Recreation Lake ramp (fishing_plan (21).json) carried
// the main reservoir's gauge as "the lake's own level":
//
//   MONTICELLO RES NR JENKINSVILLE, SC (USGS 02160900), the lake's own level, in the 48 hours
//   through 10/2 16:45: 9/30 low 422.96 ft at 22:30, high 424.29 at 17:15; ...
//
// and "423.34 ft · full pool 425 ft" as where the water was, and the model told him to "watch the
// current at the ramp and on the channel edges". The Recreational Lake is held at a stable level and
// no gauge reads it. Ryan: "did you not say that the FERC license states that rec area does not
// fluctuate like the main lake does?" Asked how a plan from such a ramp should handle the lake's
// gauges, he chose to leave them off.
//
// The fixture is Monticello's own pools.json (the 285-acre Recreational Lake is pool 1).
//
//   node --test test/a-gauge-on-the-main-lake-does-not-read-the-rec-lake.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cutOffPool, poolOnlyState, cutOffNote } from '../js/data/lake-pools.js';
import { CONDITION_FACTS, CONDITION_ELSEWHERE, conditionsPromptBlock } from '../js/modules/plan-prompt.js';

const read = (...p) => readFileSync(new URL(`../${p.join('/')}`, import.meta.url), 'utf8');
const MON = JSON.parse(read('test', 'fixtures', 'monticello-pools-2026-10-02.json'));
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const REC_RAMP = [-81.313542, 34.379239];     // Recreation Lake Boat Ramp
const RAMP_99 = [-81.317874, 34.376271];      // 99 Boat Ramp, main lake

// The shape fetchWaterState() answers for a lake, with the main reservoir's readings in it.
const LAKE = {
  ok: true, slug: 'monticello_reservoir', displayName: 'Monticello Reservoir', featureType: 'lake',
  levelFt: 423.34, fullPoolFt: 425, belowFullPoolFt: 1.66, levelSource: 'usgs:00062',
  observedAt: '2026-10-02T20:45:00Z', operatorMessage: 'pumped storage in service',
  trend24h: -0.4, trendUnits: 'ft', waterTempF: 81, waterTempGauge: 'USGS 02160900',
  pool: { seasonalDrawdownFt: 2 }, seasonalDrawdownFt: 2,
  unpublished: ['turbidity'], silent: [],
  windMph: 4, windDirDeg: 209, gustMph: 5, windStation: 'KCAE',
  pressureMb: 1002.7, pressureFrom: 'obs', moonPhase: 'waxing gibbous', moonIllumination: 0.8,
  sunrise: '07:21', sunset: '19:05', civilDawn: '06:56', civilDusk: '19:30',
  hazards: [], hazardsAllClear: true, accessAlerts: [],
};

test('the Recreation Lake ramp is on a cut-off pool, and the 99 ramp is not', () => {
  const cut = cutOffPool(MON, REC_RAMP);
  assert.equal(cut.pool, 1);
  assert.equal(Math.round(cut.acres), 285);
  assert.equal(cutOffPool(MON, RAMP_99), null);
  assert.equal(cutOffPool(null, REC_RAMP), null, 'no pools file, no restriction');
});

test('a cut-off pool keeps the sky and the notices, and loses every gauge reading', () => {
  const s = poolOnlyState(LAKE);
  for (const k of ['levelFt', 'fullPoolFt', 'belowFullPoolFt', 'levelSource', 'observedAt',
    'operatorMessage', 'trend24h', 'waterTempF', 'waterTempGauge', 'pool', 'seasonalDrawdownFt',
    'unpublished', 'silent']) assert.equal(k in s, false, `${k} is the main lake's`);
  for (const k of ['ok', 'slug', 'featureType', 'windMph', 'gustMph', 'pressureMb', 'moonPhase',
    'sunrise', 'civilDawn', 'hazards', 'accessAlerts']) assert.equal(s[k], LAKE[k], `${k} is the sky's`);
  assert.equal(poolOnlyState(null), null);
});

test('every key it keeps is one the conditions block knows by name', () => {
  const known = new Set([...CONDITION_FACTS.flatMap((f) => f.keys), ...Object.keys(CONDITION_ELSEWHERE)]);
  const kept = Object.keys(poolOnlyState(Object.fromEntries([...known].map((k) => [k, 1]))));
  assert.ok(kept.length > 20);
  for (const k of kept) assert.ok(known.has(k), k);
});

test('the prompt is told the wind and nothing about the level', () => {
  const block = conditionsPromptBlock(poolOnlyState(LAKE));
  assert.doesNotMatch(block, /423|425|level|81/i);
  const full = conditionsPromptBlock(LAKE);
  assert.match(full, /81/, 'the same state uncut does print the main lake temperature');
});

test('the plan says so in one line', () => {
  assert.equal(cutOffNote(null), null);
  const note = cutOffNote(cutOffPool(MON, REC_RAMP));
  assert.match(note, /^no gauge reads the 285-acre pool this ramp launches onto/);
  assert.match(note, /no level, moving water or water temperature/);
});

test('Smart Plan asks first, and the moving water, the level and the form all follow it', () => {
  const s = code(read('js', 'modules', 'smart-plan-v2-wiring.js'));
  const cut = s.indexOf('const cut = cutOffPool(await poolsFor(r2Key), ramp);');
  assert.ok(cut > 0);
  assert.ok(s.indexOf('if (cut) keepToThePool(inp);') > cut);
  assert.ok(s.indexOf('getSeason(date, inp.waterTempF)') > s.indexOf('if (cut) keepToThePool(inp);'),
    'the season is decided after the main lake temperature is gone');
  assert.match(s, /const movingAsk = \(opts\.dryRun \|\| cut\) \? null/);
  assert.match(s, /const waterState = cut \? poolOnlyState\(lakeState\) : lakeState;/);
  assert.match(s, /const cutNote = cutOffNote\(cut\);/);
  const keep = s.slice(s.indexOf('export function keepToThePool('));
  const body = keep.slice(0, keep.indexOf('\n}\n'));
  for (const id of ['planWaterTemp', 'planPoolLevel', 'planFullPool', 'planBelowFullPool']) {
    assert.ok(body.includes(`'${id}'`), id);
  }
});

test('Pick Water does the same in both halves', () => {
  const s = code(read('js', 'modules', 'plan-water-ui.js'));
  const cut = s.indexOf('const cut = cutOffPool(await poolsFor(r2Key), ramp);');
  assert.ok(cut > 0 && s.indexOf('if (cut) keepToThePool(inp);') > cut);
  assert.ok(s.indexOf('const depth = depthBandFor(') > s.indexOf('if (cut) keepToThePool(inp);'));
  assert.match(s, /const movingAsk = cut \? null : fetchMovingWater\(/);
  assert.match(s, /const levelState = cut \? poolOnlyState\(lakeState\) : lakeState;/);
  assert.match(s, /cutOff: cut,/);
  assert.match(s, /const waterState = T\.cutOff \? poolOnlyState\(lakeState\) : lakeState;/);
  assert.match(s, /const cutNote = cutOffNote\(T\.cutOff\);/);
});
