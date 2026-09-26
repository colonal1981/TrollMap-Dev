// FOG HOLDS THE LAUNCH, AND A FRONT IS A NOTE.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Change request 23. Lake Wateree, 2026-09-26. Ryan: "it would not have been safe to launch earlier
// this morning... because of the cold air and the hot water there was seriously dense fog on the
// lake this morning... it was still present when i got there at 8", and "there was a huge weather
// swing and coming off of a low front... so they just may not have been wanting to chew".
//
// The fog hours are the forecast's own fog code (WMO 45/48) and the visibility beside it; the
// front is the surface pressure at the launch hour and 24 and 48 hours before. No cut-off is
// decided by the app for either -- the plan says the hours and the numbers, and the model is told
// that neither one is a no-go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hourlyWeather, fogNote, pressureTrend, fetchForecast } from '../js/modules/plan-preflight.js';
import { fogSpans, fogLowestVisibility } from '../js/utils/light-state.js';
import { airAndFrontBlock } from '../js/modules/plan-prompt.js';
import { conditionsFrom } from '../js/modules/plan-inputs.js';

// The Wateree morning, roughly: fog from before the launch to 09:00, air in the 50s over 78 F water.
const HOURLY = {
  time: ['05', '06', '07', '08', '09', '10', '11'].map((h) => `2026-09-26T${h}:00`),
  weather_code: [45, 45, 48, 45, 2, 1, 45],
  visibility: [400, 180, 90, 600, 24000, 24000, 800],
  temperature_2m: [12.5, 12.0, 12.2, 14.0, 18.0, 21.0, 23.0],
  cloudcover: [100, 100, 100, 90, 40, 20, 60],
};

test('hourlyWeather carries the fog code, the visibility and the air in °F', () => {
  const w = hourlyWeather(HOURLY, '06:00', '10:00');
  assert.deepEqual(w.map((e) => e.hour), [6, 7, 8, 9, 10]);
  assert.equal(w[0].fog, true);
  assert.equal(w[1].fog, true, '48 is freezing fog, and still fog');
  assert.equal(w[3].fog, undefined, 'partly cloudy is not fog');
  assert.equal(w[1].visibilityM, 90);
  assert.equal(w[0].airF, 54);
  assert.equal(w[3].airF, 64);
});

test('fogSpans reads contiguous fog hours as spans that end at the first clear hour', () => {
  const w = hourlyWeather(HOURLY);
  assert.deepEqual(fogSpans(w), ['05:00-09:00', '11:00-12:00']);
  assert.deepEqual(fogSpans(hourlyWeather(HOURLY, '06:00', '10:00')), ['06:00-09:00']);
  assert.deepEqual(fogSpans([]), []);
  assert.deepEqual(fogSpans(null), []);
  assert.deepEqual(fogSpans([{ hour: 7, code: 2 }]), []);
});

test('the lowest visibility is taken from the fog hours only', () => {
  assert.deepEqual(fogLowestVisibility(hourlyWeather(HOURLY)), { m: 90, hour: 7 });
  assert.equal(fogLowestVisibility([{ hour: 6, code: 45 }]), null, 'no visibility sent, none said');
});

test('fogNote says the hours, that the launch is inside them, until when, and the air over the water', () => {
  const w = hourlyWeather(HOURLY, '06:00', '14:00');
  const n = fogNote(w, { launchTime: '06:00', waterTempF: 77.6 });
  assert.match(n, /fog is forecast at the lake 06:00-09:00, 11:00-12:00/);
  assert.match(n, /visibility down to 300 ft at 07:00/);
  assert.match(n, /A 06:00 launch is inside it, and it is forecast to hold until 09:00\./);
  assert.match(n, /Air 54°F over water 78°F at 06:00\./);
});

test('fogNote says nothing about the launch when the launch is clear, and nothing at all with no fog', () => {
  const w = hourlyWeather(HOURLY, '09:00', '14:00');
  const n = fogNote(w, { launchTime: '09:00', waterTempF: 78 });
  assert.match(n, /11:00-12:00/);
  assert.doesNotMatch(n, /launch is inside/);
  assert.equal(fogNote(hourlyWeather(HOURLY, '09:00', '10:00'), { launchTime: '09:00' }), null);
});

test('no lake thermometer, no air-over-water line -- a reading below the dam is not sent here', () => {
  const n = fogNote(hourlyWeather(HOURLY, '06:00', '10:00'), { launchTime: '06:00', waterTempF: null });
  assert.doesNotMatch(n, /Air /);
});

// ── the front ───────────────────────────────────────────────────────────────────────────────

function pressureFetch(rows) {
  return async (url) => {
    assert.match(String(url), /hourly=surface_pressure/);
    assert.match(String(url), /start_date=2026-09-24&end_date=2026-09-26/);
    return { ok: true, json: async () => ({ hourly: {
      time: Object.keys(rows), surface_pressure: Object.values(rows) } }) };
  };
}

test('pressureTrend returns the launch-hour pressure and the change over 24 and 48 hours', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = pressureFetch({
    '2026-09-24T07:00': 1004.04, '2026-09-25T07:00': 1008.1, '2026-09-26T07:00': 1016.23 });
  try {
    const p = await pressureTrend(34.4, -80.9, '2026-09-26', '07:00');
    assert.equal(p.hPaAtLaunch, 1016.2);
    assert.equal(p.hPa24hBefore, 1008.1);
    assert.equal(p.hPa48hBefore, 1004);
    assert.equal(p.change24hHPa, 8.1);
    assert.equal(p.change48hHPa, 12.2);
    assert.equal(p.at, '07:00');
    assert.match(p.source, /Open-Meteo/);
  } finally { globalThis.fetch = real; }
});

test('no launch hour, or no reading at it, is no answer -- not a guessed hour', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = pressureFetch({ '2026-09-26T07:00': 1016 });
  try {
    assert.equal(await pressureTrend(34.4, -80.9, '2026-09-26', ''), null);
    assert.equal(await pressureTrend(34.4, -80.9, '2026-09-26', '09:00'), null);
    const only = await pressureTrend(34.4, -80.9, '2026-09-26', '07:00');
    assert.equal(only.change24hHPa, null, 'a missing day before is null, never zero');
  } finally { globalThis.fetch = real; }
});

test('fetchForecast carries the pressure and the fog hours, and a failed pressure call costs nothing else', async () => {
  const real = globalThis.fetch;
  let pressureAsked = 0;
  globalThis.fetch = async (url) => {
    if (/surface_pressure/.test(String(url))) { pressureAsked++; throw new Error('offline'); }
    assert.match(String(url), /visibility,temperature_2m/);
    return { ok: true, json: async () => ({
      daily: { windspeed_10m_max: [8], winddirection_10m_dominant: [200], precipitation_sum: [0],
               temperature_2m_max: [28], sunrise: ['2026-09-26T07:12'], sunset: ['2026-09-26T19:14'] },
      hourly: HOURLY }) };
  };
  try {
    const f = await fetchForecast('Winyah Bay / Georgetown, SC', '2026-09-26',
                                  { launchTime: '06:00', returnTime: '10:00' });
    assert.equal(pressureAsked, 1);
    assert.equal(f.pressureTrend, null);
    assert.deepEqual(fogSpans(f.weatherByHour), ['06:00-09:00']);
  } finally { globalThis.fetch = real; }
});

test('conditionsFrom hands the pressure to the model with its source', () => {
  const pt = { hPaAtLaunch: 1016.2, hPa24hBefore: 1008.1, change24hHPa: 8.1, at: '07:00', source: 'Open-Meteo' };
  const c = conditionsFrom({ clarity: 'Stained' }, null, null, { pressureTrend: pt });
  assert.deepEqual(c.pressureTrend, pt);
  assert.equal(conditionsFrom({ clarity: 'Stained' }, null, null, {}).pressureTrend, undefined);
});

// ── what the model is told ──────────────────────────────────────────────────────────────────

test('the prompt names the fog hours and says fog alone is not a no-go', () => {
  const b = airAndFrontBlock(hourlyWeather(HOURLY, '06:00', '10:00'), {});
  assert.match(b, /THE AIR ON THE DAY/);
  assert.match(b, /FOG IS FORECAST AT THE LAKE 06:00-09:00/);
  assert.match(b, /visibility down to 90 m at 07:00/);
  assert.match(b, /safety\.rampEvaluation/);
  assert.match(b, /Fog alone is not `isGo: false`/);
  assert.doesNotMatch(b, /pressureTrend/);
});

test('the prompt points at the pressure and asks for a note, never a no-go', () => {
  const b = airAndFrontBlock([], { pressureTrend: { hPaAtLaunch: 1016.2 } });
  assert.match(b, /`conditions\.pressureTrend`/);
  assert.match(b, /notes\.scoutNotes/);
  assert.match(b, /never a reason for `isGo: false`/);
  assert.doesNotMatch(b, /FOG/);
});

test('no fog and no pressure, no block', () => {
  assert.equal(airAndFrontBlock([{ hour: 7, code: 1 }], {}), '');
  assert.equal(airAndFrontBlock(null, null), '');
});
