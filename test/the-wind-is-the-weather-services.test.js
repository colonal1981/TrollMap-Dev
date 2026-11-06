// Personal use only, not for distribution or resale; not for navigation.
//
// THE WIND IS THE NATIONAL WEATHER SERVICE'S BLEND, AND A WINDIER MODEL IS SAID BESIDE IT.
//
// Ryan, 2026-11-06, of his Sunday on Moultrie: "something is wayyyy off... i am not seeing anything close those wind
// forecasts on any of the apps i am checking for this sunday", then "i am pretty much showing a north wind at 2-3mph
// most of the day online... i thought it was supposed to be calm". The plan's Open-Meteo request named no model, and
// for the US that is the GFS: 12 mph gusting 18 at 06:00 in the middle of Moultrie on 11/8, where the National Weather
// Service had 7 and Moncks Corner 3, and its blend (NBM) 6.5. The numbers below are those, in Open-Meteo's km/h.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nbmWind, nbmDaily, withNbmWind, windierHour, NBM, NBM_NAME, DEFAULT_NAME } from '../js/utils/nws-wind.js';
import { fetchForecast, hourlyWind } from '../js/modules/plan-preflight.js';
import { conditionsFrom } from '../js/modules/plan-inputs.js';
import { windSourceLine } from '../js/modules/plan-prompt.js';

const DAY = '2026-11-08';
const T = Array.from({ length: 24 }, (_, h) => `${DAY}T${String(h).padStart(2, '0')}:00`);
const kmh = (mph) => mph / 0.621371;
// The middle of Moultrie, 11/8, as asked on 11/6.
const GFS = { 0: 12, 1: 17, 2: 19, 3: 18, 4: 18, 5: 15, 6: 12, 7: 10, 8: 7, 9: 6, 10: 5, 11: 5, 12: 4, 13: 4, 14: 4, 15: 3 };
const GFS_GUST = { 6: 18, 7: 17, 8: 15 };
const BLEND = { 0: 3, 1: 3, 2: 4, 3: 4, 4: 5, 5: 5, 6: 7, 7: 6, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1, 13: 1, 14: 1, 15: 0 };
const series = (m) => T.map((_, h) => (m[h] != null ? kmh(m[h]) : kmh(2)));
const DEFAULT_ANSWER = {
  daily: { windspeed_10m_max: [kmh(19)], winddirection_10m_dominant: [31], precipitation_sum: [0],
           temperature_2m_max: [20.7], sunrise: [`${DAY}T06:44`], sunset: [`${DAY}T17:21`] },
  hourly: { time: T, windspeed_10m: series(GFS), winddirection_10m: T.map(() => 40),
            windgusts_10m: T.map((_, h) => kmh(GFS_GUST[h] || (GFS[h] || 2) + 5)) },
};
const BLEND_ANSWER = {
  daily: { windspeed_10m_max: [12.2], winddirection_10m_dominant: [25] },
  hourly: { time: T, windspeed_10m: series(BLEND), winddirection_10m: T.map(() => 30),
            windgusts_10m: T.map(() => 12) },
};
const ok = (j) => ({ ok: true, json: async () => j });

function stub({ blend = BLEND_ANSWER } = {}) {
  const asked = [];
  const f = async (url) => {
    const u = String(url); asked.push(u);
    if (/surface_pressure/.test(u)) return { ok: false };
    if (u.includes(`models=${NBM}`)) return blend ? ok(blend) : { ok: false };
    return ok(DEFAULT_ANSWER);
  };
  return { f, asked };
}

test('the blend is asked for the one day, for the wind only, by name', async () => {
  const { f, asked } = stub();
  const n = await nbmWind(33.3131, -80.0655, DAY, { fetchImpl: f });
  assert.ok(n && n.hourly && n.daily);
  assert.match(asked[0], /models=ncep_nbm_conus/);
  assert.match(asked[0], /start_date=2026-11-08&end_date=2026-11-08/);
  assert.match(asked[0], /hourly=windspeed_10m,winddirection_10m,windgusts_10m/);
  assert.deepEqual(nbmDaily(n), { maxKmh: 12.2, dirDeg: 25 });
});

test('no blend is null, never a calm day: an empty answer, a refusal, or no network', async () => {
  const empty = { hourly: { time: T, windspeed_10m: T.map(() => null) } };
  assert.equal(await nbmWind(33.3, -80.0, DAY, { fetchImpl: async () => ok(empty) }), null);
  assert.equal(await nbmWind(33.3, -80.0, DAY, { fetchImpl: async () => ({ ok: false }) }), null);
  assert.equal(await nbmWind(33.3, -80.0, DAY, { fetchImpl: async () => { throw new Error('offline'); } }), null);
  assert.equal(await nbmWind(33.3, -80.0, 'Sunday', { fetchImpl: async () => ok(BLEND_ANSWER) }), null);
});

test('an hour the forecast leaves empty is not 0 mph', () => {
  const w = hourlyWind({ time: T.slice(0, 3), windspeed_10m: [null, 10, ''], windgusts_10m: [null, null, 5],
                         winddirection_10m: [0, 0, 0] });
  assert.deepEqual(w, [{ hour: 1, mph: 6, deg: 0 }]);
});

test('the day is the blend, and the GFS is said beside it where it is clearly windier', async () => {
  const { f } = stub();
  const real = globalThis.fetch; globalThis.fetch = f;
  try {
    const fc = await fetchForecast('Winyah Bay / Georgetown, SC', DAY, { launchTime: '06:00', returnTime: '15:00' });
    assert.equal(fc.windModel, NBM_NAME);
    assert.equal(fc.windByHour[0].hour, 6);
    assert.equal(fc.windByHour[0].mph, 7, 'the blend, not the GFS 12');
    assert.deepEqual(fc.windOther, { model: DEFAULT_NAME, hour: 6, mph: 7, otherMph: 12, otherGustMph: 18 });
    assert.match(fc.summary, /^Wind NNE 8 mph/, "the headline is the blend's day too, not the GFS's 2 AM 19");
  } finally { globalThis.fetch = real; }
});

test('with no blend for the date the default model is used, and named as the default', async () => {
  const { f } = stub({ blend: null });
  const real = globalThis.fetch; globalThis.fetch = f;
  try {
    const fc = await fetchForecast('Winyah Bay / Georgetown, SC', DAY, { launchTime: '06:00', returnTime: '15:00' });
    assert.equal(fc.windModel, DEFAULT_NAME);
    assert.equal(fc.windByHour[0].mph, 12);
    assert.equal(fc.windOther, null);
    assert.match(fc.summary, /^Wind NNE 19 mph/);
  } finally { globalThis.fetch = real; }
});

test('windier means 4 mph more and half again as much, at its clearest hour', () => {
  const blend = [{ hour: 6, mph: 7 }, { hour: 7, mph: 6 }, { hour: 8, mph: 5 }];
  assert.deepEqual(windierHour(blend, [{ hour: 6, mph: 12, gustMph: 18 }, { hour: 7, mph: 10 }, { hour: 8, mph: 7 }]),
                   { hour: 6, mph: 7, otherMph: 12, otherGustMph: 18 });
  assert.equal(windierHour(blend, [{ hour: 6, mph: 10 }, { hour: 7, mph: 9 }]), null, '3 mph more is the same day');
  assert.equal(windierHour([{ hour: 6, mph: 12 }], [{ hour: 6, mph: 16 }]), null, 'a third more is the same day');
  assert.equal(windierHour([], [{ hour: 6, mph: 20 }]), null);
});

test("the trip report's table gets the blend's wind where it has one, and keeps the rest of the hour", () => {
  const h = { time: T.slice(0, 2), windspeed_10m: [30, 30], winddirection_10m: [10, 10], windgusts_10m: [40, 40],
              temperature_2m: [15, 16] };
  const n = { hourly: { time: T.slice(0, 2), windspeed_10m: [5, null], winddirection_10m: [20, null], windgusts_10m: [8, null] } };
  const m = withNbmWind(h, n);
  assert.deepEqual(m.windspeed_10m, [5, 30]);
  assert.deepEqual(m.winddirection_10m, [20, 10]);
  assert.deepEqual(m.temperature_2m, [15, 16]);
  assert.equal(withNbmWind(h, null), h);
  const src = readFileSync(new URL('../js/modules/plan-builder.js', import.meta.url), 'utf8');
  assert.match(src, /const nbm = await nbmWind\(lat, lon, date\);/);
  assert.match(src, /data\.hourly = withNbmWind\(data\.hourly, nbm\)/);
});

test('the plan carries whose wind it is, and the model is told to give both numbers', () => {
  const windOther = { model: DEFAULT_NAME, hour: 6, mph: 7, otherMph: 12, otherGustMph: 18 };
  const c = conditionsFrom({ clarity: 'Stained' }, null, null,
                           { windByHour: [{ hour: 6, mph: 7, deg: 30 }], windModel: NBM_NAME, windOther });
  assert.equal(c.windModel, NBM_NAME);
  assert.deepEqual(c.windOther, windOther);
  const line = windSourceLine(c);
  assert.match(line, /forecast of the National Weather Service blend \(NBM\) for the middle of this water/);
  assert.match(line, /12 mph gusting 18 at 06:00, where the blend has 7/);
  assert.match(line, /leave the call to him\. Build the day on the blend\./);
  assert.match(windSourceLine({ windModel: DEFAULT_NAME }), /had no answer for this date/);
  assert.equal(windSourceLine({}), '');
  const prompt = readFileSync(new URL('../js/modules/plan-prompt.js', import.meta.url), 'utf8');
  assert.match(prompt, /is it a dangerous windward launch\?\$\{windSourceLine\(o\.conditions\)\}/);
});
