/**
 * test/the-lake-drowned-a-ferry-and-the-map-says-so.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * 2026-09-23. GNIS names the places a reservoir drowned -- on Wateree, Peays, Mickles and
 * Kingsburys Ferry, Dukes Ford, Aldrichs Shoal, Montgomerys Island, the Wateree Canal -- and until
 * tonight nothing drew them. Ryan: *"i do not see any of it on lake wateree"*, and on how they
 * should show, *"always on"*.
 *
 * So they ride the chart-names switch (on by default, no button of their own), in their own
 * look, and only the features INSIDE the water's outline are in the table at all.
 *
 *   node --test test/the-lake-drowned-a-ferry-and-the-map-says-so.test.js
 */
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { historicalFor, historicalMarked, historicalNote, HISTORICAL_PATH }
  from '../js/data/historical-features.js';

const PAYLOAD = { waters: { wateree_lake: [
  { id: 1, name: 'Peays Ferry', class: 'Crossing', lat: 34.41, lon: -80.83 },
  { id: 2, name: 'Wateree Canal', class: 'Canal', lat: 34.33, lon: -80.70 },
  { id: 3, name: 'Montgomerys Island', class: 'Island', lat: 34.40, lon: -80.84 },
  { id: 4, name: 'Broken', class: 'Crossing', lat: null, lon: -80.8 },
], lake_marion: [{ id: 5, name: 'Sullivan Lake', class: 'Lake', lat: 33.5, lon: -80.4 }] } };

describe('the table, per water', () => {
  it('a water gets its own features and nothing without a position', () => {
    const w = historicalFor('wateree_lake', PAYLOAD);
    expect(w.map((f) => f.name)).toEqual(['Peays Ferry', 'Wateree Canal', 'Montgomerys Island']);
  });
  it('a water with none, or no table at all, is an empty list -- never null', () => {
    expect(historicalFor('lake_murray', PAYLOAD)).toEqual([]);
    expect(historicalFor('wateree_lake', null)).toEqual([]);
    expect(historicalFor('', PAYLOAD)).toEqual([]);
  });
  it('it is read from the served name, without the drive\'s underscore', () => {
    expect(HISTORICAL_PATH).toBe('/chartpacks/_registry/gnis_historical.json');
  });
});

describe('a mark for what stood at a point, a name for what covered an area', () => {
  it('crossings, shoals, islands, canals, forts and towns are marked', () => {
    for (const c of ['Crossing', 'Rapids', 'Bar', 'Island', 'Canal', 'Military', 'Populated Place'])
      expect(historicalMarked(c)).toBe(true);
  });
  it('drowned lakes, swamps, creeks, channels and mill ponds are names only', () => {
    for (const c of ['Lake', 'Swamp', 'Stream', 'Channel', 'Reservoir', undefined])
      expect(historicalMarked(c)).toBe(false);
  });
  it('the popup says what it was and whose position it is', () => {
    const n = historicalNote({ class: 'Crossing' });
    expect(n.includes('ford or ferry')).toBe(true);
    expect(n.includes('historical')).toBe(true);
    expect(n.includes('may be approximate')).toBe(true);
  });
});

describe('always on, on the chart-names switch', () => {
  const src = readFileSync(new URL('../js/modules/supplemental-layers.js', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  const fn = code.slice(code.indexOf('function renderHistoricalLabels'),
                        code.indexOf('function hookLabelRedraw'));
  it('the pass is gated by the chart-names switch and nothing else of its own', () => {
    expect(fn.includes('!_labelsVisible')).toBe(true);
    expect(/btnHist|_histVisible/.test(code)).toBe(false);
  });
  it('the switch redraws it, the map redraws it, and a new lake primes it', () => {
    const toggle = code.slice(code.indexOf("getElementById('btnGarminNames')"));
    expect(toggle.slice(0, 600).includes('renderHistoricalLabels()')).toBe(true);
    expect(code.includes("map.on('moveend zoomend', renderHistoricalLabels)")).toBe(true);
    expect(code.includes('primeHistorical(CF_WORKER_URL)')).toBe(true);
  });
  it('it does not wait on Garmin POIs, which a water may not have', () => {
    expect(fn.includes('_poiGeoJSON')).toBe(false);
  });
});

describe('the real table, when it is on this machine', () => {
  it('Wateree carries its seven, and Biddle and Kingsbury on the shore are not among them', () => {
    let doc = null;
    try { doc = JSON.parse(readFileSync('F:/TrollMapPipeline/registry/gnis_historical.json', 'utf8')); }
    catch { return; }
    const names = historicalFor('wateree_lake', doc).map((f) => f.name);
    for (const n of ['Peays Ferry', 'Mickles Ferry', 'Dukes Ford', 'Aldrichs Shoal'])
      expect(names.includes(n)).toBe(true);
    expect(names.includes('Biddle')).toBe(false);
    expect(names.includes('Kingsbury')).toBe(false);
    expect(Object.keys(doc.waters).some((s) => s.startsWith('coast_'))).toBe(false);
  });
});
