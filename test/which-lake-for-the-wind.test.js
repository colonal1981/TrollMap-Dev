// Personal use only, not for distribution or resale; not for navigation.
//
// WHICH LAKE FOR THE DAY'S WIND (change request 85).
//
// Ryan, 2026-11-09: "the app should be able to check the forecast for the main lakes near me and tell me which one is
// the best for the forecast". His lakes and ramps are js/data/my-lakes.js; of the closure: "definitely no striper on
// marion or moultrie during the closure", then "just use the same logic that prevents a plan being made during a
// closure".
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { lakesFor } from '../js/data/my-lakes.js';
import { waterNearRamp, dayWaves, dayWeather, rankLakes, pickRamp, rowLines, hoursText, shortReason, weighLake,
         NEAR_RAMP_M } from '../js/modules/which-lake.js';
import { shoreRays } from '../js/utils/wind-waves.js';
import { waterTest } from '../js/modules/river-drifts.js';
import { fetchForecast } from '../js/modules/plan-preflight.js';

describe('his lakes, by the fish and the month', () => {
  it('Monticello is only for bass; every other lake for what he ticked', () => {
    expect(lakesFor(['Striped Bass'], '2026-11-11').some((L) => /Monticello/.test(L.lake))).toBe(false);
    const both = lakesFor(['Striped Bass', 'Largemouth Bass'], '2026-11-11');
    expect(both.find((L) => /Monticello/.test(L.lake)).species).toEqual(['Largemouth Bass']);
    expect(both.find((L) => /Murray/.test(L.lake)).species).toEqual(['Striped Bass', 'Largemouth Bass']);
    expect(both.find((L) => /Monticello/.test(L.lake)).ramps.map((r) => r.name)).toEqual(['Monticello Boat Ramp', '99 Boat Ramp']);
    expect(both.find((L) => /Monticello/.test(L.lake)).pick).toBe('sheltered');
  });

  it('Marion is Rowland in the fall and winter and Pack\'s from March, Low Falls the other way in', () => {
    const nov = lakesFor(['Striped Bass'], '2026-11-11').find((L) => /Marion/.test(L.lake));
    expect(nov.ramps.map((r) => r.name)).toEqual(['Rowland Subdivision']);
    const apr = lakesFor(['Striped Bass'], '2027-04-10').find((L) => /Marion/.test(L.lake));
    expect(apr.ramps.map((r) => r.name)).toEqual(["Pack's Landing"]);
    expect(apr.other).toBe('Low Falls Landing');
  });

  it('Bates is offered as the fallback, and the other ramps are his', () => {
    const all = lakesFor(['Largemouth Bass'], '2026-11-11');
    expect(all.find((L) => /Bates/.test(L.lake)).fallback).toBe(true);
    const ramp = (re) => all.find((L) => re.test(L.lake)).ramps[0].name;
    expect(ramp(/Murray/)).toBe('Hilton Recreation Area');
    expect(ramp(/Wateree/)).toBe('Clearwater Cove');
    expect(ramp(/Moultrie/)).toBe('Short Stay Boat Ramp');
  });
});

// A 6 km square of open water with a 600 m cove cut into its west side; the ramp at the back of the cove.
const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const LAT = 34, KX = 111320 * Math.cos(LAT * Math.PI / 180);
const lonAt = (m) => -81 + m / KX, latAt = (m) => LAT + m / 111320;
const BOUNDARY = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [
  sq(lonAt(0), latAt(0), lonAt(6000), latAt(6000)) ] } }] };
const RAMP = [lonAt(150), latAt(3000)];
const rays = shoreRays(BOUNDARY), inside = waterTest(BOUNDARY);

describe('the waves on the water near the ramp', () => {
  const pts = waterNearRamp(inside, RAMP);

  it('takes the water within 3 miles of the ramp and nothing off it', () => {
    expect(pts.length).toBeGreaterThan(100);
    for (const p of pts) expect(inside(p[0], p[1])).toBe(true);
    const far = Math.max(...pts.map((p) => Math.hypot((p[0] - RAMP[0]) * KX, (p[1] - RAMP[1]) * 111320)));
    expect(far <= NEAR_RAMP_M).toBe(true);
  });

  it('a light wind is under 1 ft everywhere all day', () => {
    const w = dayWaves(pts, rays, [{ hour: 7, mph: 3, deg: 90 }, { hour: 8, mph: 4, deg: 90 }]);
    expect(w.roughHours).toEqual([]);
    expect(w.worstFt < 1).toBe(true);
    expect(w.calmAtWorst).toBe(1);
  });

  it('a strong wind across six km of water is over 1 ft somewhere, and the lee shore stays calm', () => {
    const w = dayWaves(pts, rays, [{ hour: 7, mph: 4, deg: 90 }, { hour: 13, mph: 18, deg: 90 }]);
    expect(w.worstHour).toBe(13);
    expect(w.worstFt >= 1).toBe(true);
    expect(w.roughHours).toEqual([13]);
    expect(w.calmAtWorst > 0 && w.calmAtWorst < 1).toBe(true);
  });
});

describe('best first', () => {
  const row = (lake, worstFt, calmAtWorst, o = {}) => ({
    lake, ramp: 'R', species: ['Striped Bass'], closed: [], fallback: !!o.fallback,
    waves: { worstFt, worstHour: 12, calmAtWorst, roughHours: worstFt >= 1 ? [12] : [], hours: [], points: 100 },
    weather: { minMph: 3, maxMph: 8, fromDeg: 225, maxGust: o.gust || 12, noGo: o.noGo || [], thunder: o.thunder || [],
               rain: [], model: 'the National Weather Service blend (NBM)' },
  });

  it('under 1 ft all day, then the most calm water, then storms; Bates last whatever its numbers', () => {
    const ranked = rankLakes([
      row('Rough, little calm', 1.6, 0.2), row('Bates', 0.1, 1, { fallback: true }), row('Calm', 0.7, 1),
      row('Calmer', 0.4, 1), row('Rough, mostly calm', 1.3, 0.8), row('Thunder', 0.3, 1, { thunder: [14] }),
    ]).map((r) => r.lake);
    expect(ranked).toEqual(['Calmer', 'Calm', 'Rough, mostly calm', 'Rough, little calm', 'Thunder', 'Bates']);
  });

  it('Monticello puts in at whichever ramp is more sheltered that day', () => {
    const a = { ...row('Lake Monticello, SC', 0.9, 1), ramp: 'Monticello Boat Ramp' };
    const b = { ...row('Lake Monticello, SC', 0.5, 1), ramp: '99 Boat Ramp' };
    expect(pickRamp([a, b], 'sheltered').best.ramp).toBe('99 Boat Ramp');
    expect(pickRamp([a, b], 'first').best.ramp).toBe('Monticello Boat Ramp');
  });

  it('each row says the waves, the wind, the fish, and the no-go when the wind is over it', () => {
    const r = row('Lake Murray, SC', 1.3, 0.64, { gust: 24, noGo: [{ hour: 13, mph: 12, gustMph: 24 }] });
    r.closed = [{ species: 'Hybrid', reason: 'Hybrid harvest is closed (06-16 to 09-30)' }];
    const t = rowLines(r).join(' ');
    expect(t).toContain('Waves reach 1.3 ft on the most open water within 3 mi at 12:00; 64% of that water stays under 1 ft then.');
    expect(t).toContain('Wind SW 3–8 mph, gusts to 24. No rain forecast.');
    expect(t).toContain("Over the plans' no-go (15 mph sustained, 20 gusting) 13:00.");
    expect(t).toContain('For Striped Bass. Not Hybrid: Hybrid harvest is closed (06-16 to 09-30).');
    expect(hoursText([11, 12, 13, 15])).toBe('11:00–13:00, 15:00');
  });

  it('a row whose wind is not the footer\'s model says which it is; the lakes are asked one at a time', () => {
    const r = row('Lake Murray, SC', 0.3, 1);
    expect(rowLines(r, 1, 'the National Weather Service blend (NBM)').join(' ')).not.toContain('Wind from');
    expect(rowLines(r, 1, "Open-Meteo's default model (the GFS in the US)").join(' '))
      .toContain('Wind from the National Weather Service blend (NBM) here.');
    const src = readFileSync(new URL('../js/modules/which-lake.js', import.meta.url), 'utf8');
    expect(src).toContain('for (const L of lakes) {\n    got.push(await weighLake(');
  });

  it('the wind and weather come off the plans\' forecast shape', () => {
    const x = dayWeather({ windModel: 'NBM', windByHour: [{ hour: 7, mph: 4, deg: 200, gustMph: 9 },
      { hour: 13, mph: 16, deg: 250, gustMph: 19 }], weatherByHour: [{ hour: 14, thunder: true }, { hour: 15, rain: true }] });
    expect(x.maxMph).toBe(16);
    expect(x.noGo.map((n) => n.hour)).toEqual([13]);
    expect(x.thunder).toEqual([14]);
    expect(x.rain).toEqual([15]);
  });
});

describe('a closed fish is the plans\' own refusal', () => {
  const deps = (legalFor) => ({
    ensureRegulations: async () => true,
    checkPlanLegality: (lake, s) => (legalFor(lake, s) ? { legal: true, reason: '' }
      : { legal: false, reason: `${s} harvest is closed (06-16 to 09-30): "June 16 - Sept. 30 closed except..."` }),
    fetchForecast: async () => ({ windByHour: [{ hour: 7, mph: 5, deg: 90, gustMph: 8 }], weatherByHour: [] }),
    packFetcher: () => async () => BOUNDARY, CF_WORKER_URL: 'https://worker', resolveR2Key: () => 'k',
    shoreRays, waterTest,
  });
  const L = { lake: 'Lake Moultrie, SC', ramps: [{ name: 'Short Stay Boat Ramp', at: RAMP }], species: ['Striped Bass', 'Catfish'],
              pick: 'first', fallback: false, other: null };

  it('a lake with every ticked fish closed has no row, only the reason', async () => {
    const r = await weighLake({ ...L, species: ['Striped Bass'] }, '2026-07-01', '06:00', '15:00', deps(() => false));
    expect(r.ramp).toBeUndefined();
    expect(r.closed[0].reason).toBe('Striped Bass harvest is closed (06-16 to 09-30)');
  });

  it('a lake with one fish open keeps its row for that fish and names the closed one', async () => {
    const r = await weighLake(L, '2026-07-01', '06:00', '15:00', deps((lake, s) => s === 'Catfish'));
    expect(r.ramp).toBe('Short Stay Boat Ramp');
    expect(r.species).toEqual(['Catfish']);
    expect(r.closed.map((c) => c.species)).toEqual(['Striped Bass']);
    expect(r.waves.roughHours).toEqual([]);
  });

  it('the card asks checkPlanLegality and writes no closure dates of its own', () => {
    const src = readFileSync(new URL('../js/modules/which-lake.js', import.meta.url), 'utf8')
      + readFileSync(new URL('../js/data/my-lakes.js', import.meta.url), 'utf8');
    expect(src).toContain('checkPlanLegality(L.lake, s, date, { at })');
    expect(/06-16|June 16|closedSeason/.test(src.replace(/\/\/.*$|\/\*[\s\S]*?\*\/|^\s*\*.*$/gm, ''))).toBe(false);
    expect(shortReason('X harvest is closed (06-16 to 09-30): "June..."')).toBe('X harvest is closed (06-16 to 09-30)');
  });
});

describe('the forecast is asked at the ramp', () => {
  it('fetchForecast takes the ramp\'s position, and the card skips the pressure', async () => {
    const urls = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (u) => { urls.push(String(u)); return { ok: true, json: async () => ({ daily: { sunrise: [], sunset: [] }, hourly: { time: [] } }) }; };
    try {
      await fetchForecast('Lake Murray, SC', '2026-11-11', { at: [-81.328882, 34.094287], pressure: false });
    } finally { globalThis.fetch = real; }
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u).toContain('latitude=34.094287&longitude=-81.328882');
    expect(urls.some((u) => /surface_pressure/.test(u))).toBe(false);
  });

  it('the plan prompt still reads the same no-go line', () => {
    const src = readFileSync(new URL('../js/modules/plan-prompt.js', import.meta.url), 'utf8');
    expect(src).toContain('Sustained wind over ${NO_GO_SUSTAINED_MPH} mph, or gusts over ${NO_GO_GUST_MPH}, is a no-go.');
  });

  it('the card sits on the planner tab and its module is loaded', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    expect(html.indexOf('id="whichLakeBtn"')).toBeGreaterThan(html.indexOf('id="planSpeciesChecks"'));
    expect(readFileSync(new URL('../js/main.js', import.meta.url), 'utf8')).toContain("import './modules/which-lake.js';");
  });
});
