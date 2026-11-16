// THE LAKE AND THE WEATHER COME WITH THE CATCH: the Nightly Catch Upload runs the history check on
// the catches it has just added, and an empty archive answer is not weather.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-11-15: "for the catch log is there way for the gpx and photo import to trigger the
// history check automatically so i don't have to press a button to get lake and weather", then
// "please we can test it the next time". The archive answer below is the real one for 11/15 at
// Wateree, 2 PM (his 0045 striper at 2:32 PM, 34.36309, -80.71370), fetched that night.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkHistory, hasWeather, weatherAtHour, historySentence, WEATHER_NUMBERS }
  from '../js/utils/catch-history.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const hours = (vals) => Array.from({ length: 24 }, (_, h) => (h in vals ? vals[h] : null));
const ARCHIVE_1115 = {
  hourly: {
    temperature_2m: hours({ 13: 54.5, 14: 56.3, 15: 56.3 }),
    surface_pressure: hours({ 13: 1017.7, 14: 1017.5, 15: 1017.6 }),
    cloudcover: hours({ 13: 2, 14: 2, 15: 0 }),
    windspeed_10m: hours({ 13: 5.3, 14: 6.5, 15: 6.0 }),
    winddirection_10m: hours({ 13: 356, 14: 358, 15: 358 }),
  },
};
const EMPTY = { hourly: { temperature_2m: hours({}), surface_pressure: hours({}), cloudcover: hours({}),
                          windspeed_10m: hours({}), winddirection_10m: hours({}) } };

// A catch as the drop makes it: the sounder's depth at the mark, no lake, no weather.
const dropItem = (name, hhmm) => ({
  id: `nightly_${name}`, filename: `${name}.jpg`, datetime: `2026-11-15T${hhmm}:00`, date: '2026-11-15', time: `${hhmm}:00`,
  lat: 34.36309, lon: -80.7137, lake: '', depth: '41.3', depthSource: 'sounder_at_waypoint',
  weather: null, reviewFlags: [], ai: { notes: '' }, status: 'pending',
});
const noWait = async () => {};
const lakeFrom = (item) => { if (!item.lake) item.lake = 'Lake Wateree'; return item; };

test('weather is only had when one of its numbers is', () => {
  assert.deepEqual(WEATHER_NUMBERS, ['tempF', 'windMph', 'cloudPct', 'pressureHpa']);
  assert.equal(hasWeather(null), false);
  assert.equal(hasWeather({ tempF: null, windMph: null, cloudPct: null, pressureHpa: null, moonPhase: 'Waning Crescent' }), false,
    'the moon alone is not weather: it is worked out locally');
  assert.equal(hasWeather({ tempF: 56.3 }), true);
  assert.equal(hasWeather({ cloudPct: 0 }), true, 'a clear sky is weather');
});

test("the archive's hour is read as the journal stores it, and an empty hour is null", () => {
  const w = weatherAtHour(ARCHIVE_1115, 14, 'Waning Crescent', 'T');
  assert.deepEqual(w, { tempF: 56.3, pressureHpa: 1018, cloudPct: 2, windMph: 6.5, windDir: 358,
                        moonPhase: 'Waning Crescent', source: 'open-meteo-archive', fetchedAt: 'T' });
  assert.equal(weatherAtHour(EMPTY, 14, 'Waning Crescent'), null);
  assert.equal(weatherAtHour({}, 14), null);
});

test("the drop's catches get the lake and the weather, and the sounder's depth is kept", async () => {
  const items = [dropItem('0045', '14:32:51'), dropItem('0046', '14:51:52')];
  const asked = [];
  const steps = [];
  const r = await checkHistory(items, {
    enrich: lakeFrom,
    fetchWeather: async (it) => { asked.push(it.id); return weatherAtHour(ARCHIVE_1115, +it.time.slice(0, 2), 'Waning Crescent'); },
    onStep: (i, n) => steps.push(`${i + 1}/${n}`),
    wait: noWait,
  });
  assert.deepEqual(asked, ['nightly_0045', 'nightly_0046']);
  assert.deepEqual(steps, ['1/2', '2/2']);
  assert.deepEqual(r, { lakeFilled: 2, depthFilled: 0, weatherFilled: 2, failed: 0, checked: 2 });
  for (const it of items) {
    assert.equal(it.lake, 'Lake Wateree');
    assert.equal(it.depth, '41.3');
    assert.equal(it.weather.tempF, 56.3);
    assert.deepEqual(it.reviewFlags, ['weather_from_archive']);
  }
  assert.equal(historySentence(r, 2), 'Lake and weather filled in for all 2.');
  assert.equal(historySentence({ lakeFilled: 1, weatherFilled: 1, failed: 0 }, 1), 'Lake and weather filled in.');
});

test('an empty archive answer stays missing, and the button gets it later', async () => {
  const it = dropItem('0045', '14:32:51');
  const first = await checkHistory([it], { enrich: lakeFrom, fetchWeather: async () => weatherAtHour(EMPTY, 14), wait: noWait });
  assert.equal(it.weather, null, 'nothing stored: an object of nulls would have hidden it from the button for good');
  assert.deepEqual(it.reviewFlags, ['weather_lookup_failed']);
  assert.equal(first.failed, 1);
  assert.equal(historySentence(first, 1),
    'Lake found for 1 of 1, weather for 0 of 1; the weather archive had nothing for 1, and “Check Missing History” will try again.');

  // "Check Missing History", later: the same check, now with an answer.
  const again = await checkHistory([it], { enrich: lakeFrom, fetchWeather: async () => weatherAtHour(ARCHIVE_1115, 14), wait: noWait });
  assert.equal(again.weatherFilled, 1);
  assert.equal(it.weather.windMph, 6.5);
  assert.deepEqual(it.reviewFlags, ['weather_from_archive'], 'the old failure flag goes when it is filled');
});

test('weather it already has is not asked for again; no position is said', async () => {
  const had = dropItem('0043', '13:50:36');
  had.weather = weatherAtHour(ARCHIVE_1115, 13, 'Waning Crescent');
  const noFix = { ...dropItem('x', '15:00:00'), lat: '', lon: '' };
  const thrown = dropItem('0046', '14:51:52');
  let calls = 0;
  const r = await checkHistory([had, noFix, thrown], {
    enrich: (x) => x,
    fetchWeather: async () => { calls++; throw new Error('Open-Meteo 503'); },
    wait: noWait,
  });
  assert.equal(calls, 1, 'only the catch with a position and no weather is asked');
  assert.equal(had.weather.tempF, 54.5);
  assert.deepEqual(noFix.reviewFlags, ['weather_missing_gps']);
  assert.deepEqual(thrown.reviewFlags, ['weather_lookup_failed']);
  assert.equal(r.failed, 1);
});

test('the drop runs the check on its own catches, the button on the queue, through one function', () => {
  const j = src('js/modules/catch-journal.js');
  const drop = j.slice(j.indexOf('async function handleNightlyPhotoUpload('), j.indexOf('// ── His marks with no photos after them'));
  assert.match(drop, /queue\.unshift\(item\);\s*\n\s*added\.push\(item\);/, 'each catch the drop makes is kept');
  const check = drop.indexOf('checkHistoryOf(added');
  assert.ok(check > 0, 'the drop checks the catches it added');
  assert.ok(check < drop.indexOf('nightlyNote = status.textContent'), 'before it writes its summary');
  assert.match(drop, /historySentence\(history, added\.length\)/, 'and the summary says what it found');

  const button = j.slice(j.indexOf('async function enrichMissingHistoricalData('), j.indexOf('function parseCsv('));
  assert.match(button, /checkHistoryOf\(targets/, 'the button uses the same check');
  assert.doesNotMatch(button, /fetchHistoricalWeatherForItem/, 'and has no loop of its own');
  assert.match(j, /checkHistory\(items, \{ enrich: enrichItemFromGps, fetchWeather: fetchHistoricalWeatherForItem/);

  assert.match(j, /\$\{hasWeather\(q\.weather\) \? `<div class="okbox"/, 'the review card shows weather only when it has some');
  assert.match(j, /return weatherAtHour\(await resp\.json\(\), hour, moonPhaseLabel\(iso\)\);/);
});
