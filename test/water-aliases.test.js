import { describe, it, expect } from './expect-shim.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

import {
  WATER_TO_R2_KEY,
  WATER_ZONE_CANDIDATES,
  resolveWaterKey,
  waterZoneCandidates,
} from '../js/data/water-aliases.js';
import { COASTAL_ZONES, isCoastalKey } from '../js/data/coastal-zones.js';
import { resolveR2Key } from '../js/data/lake-keys.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOUNDARIES = path.join(path.dirname(REPO), 'lake_boundaries');

/**
 * WHAT THIS IS GUARDING, AND WHY IT IS NOT A FORMALITY
 *
 * On 2026-08-04, before water-aliases.js existed, resolveR2Key was run over all 170 names the
 * river cutter produces. It did not merely fail to place them:
 *
 *     158 coastal pointers:   9 right   128 nothing   21 loaded the WRONG water
 *      12 river aliases:      0 right     7 nothing    5 loaded the WRONG water
 *
 * "May River" in Bluffton SC resolved to Mayo Lake in North Carolina. "Black Creek" on the Pee
 * Dee resolved to Lake Blackshear in Georgia. The fetch succeeds, contours draw, and nothing
 * says they are 400 km from the water you selected.
 *
 * The fuzzy pass will always answer, so the only durable protection is asserting that every
 * name resolves to a key that EXISTS. A dead or wrong entry then fails here rather than on the
 * water.
 */
describe('water-aliases.js — every placed waterbody name resolves to a real chartpack key', () => {
  it('generated file is not stale (regenerate with Scripts/gen_water_aliases_js.py)', () => {
    if (!fs.existsSync(path.join(BOUNDARIES, '_coastal_pointers.json'))) return; // no pipeline here
    try {
      execFileSync('python3', ['Scripts/gen_water_aliases_js.py', '--check'],
                   { cwd: REPO, stdio: 'pipe' });
    } catch (err) {
      if (err.code === 'ENOENT') return;                       // no python3 in this environment
      throw new Error(
        'water-aliases.js is out of date with the river cutter output.\n' +
        'Run: python3 Scripts/gen_water_aliases_js.py\n' +
        `${err.stdout?.toString() || ''}${err.stderr?.toString() || ''}`);
    }
  });

  it('has entries at all', () => {
    expect(Object.keys(WATER_TO_R2_KEY).length).toBeGreaterThan(100);
  });

  it('every coastal key is a real zone', () => {
    const bad = Object.entries(WATER_TO_R2_KEY)
      .filter(([, key]) => key.startsWith('coast_') && !COASTAL_ZONES[key])
      .map(([name, key]) => `${name} -> ${key}`);
    expect(bad).toEqual([]);
  });

  it('every non-coastal key is a river boundary that was actually written', () => {
    if (!fs.existsSync(BOUNDARIES)) return;                    // no pipeline beside this checkout
    const written = new Set(
      fs.readdirSync(BOUNDARIES)
        .filter((f) => f.endsWith('_river.geojson'))
        .map((f) => f.replace(/_river\.geojson$/, '')));
    if (!written.size) return;
    const bad = Object.entries(WATER_TO_R2_KEY)
      .filter(([, key]) => !key.startsWith('coast_') && !written.has(key))
      .map(([name, key]) => `${name} -> ${key}`);
    expect(bad).toEqual([]);
  });

  it('every candidate list holds only real zones, most landings first', () => {
    for (const [name, list] of Object.entries(WATER_ZONE_CANDIDATES)) {
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBeGreaterThan(0);
      expect(new Set(list).size).toBe(list.length);            // no duplicates
      for (const slug of list) {
        if (!slug.startsWith('coast_')) continue;
        if (!COASTAL_ZONES[slug]) throw new Error(`${name}: unknown zone ${slug}`);
      }
    }
  });

  it('resolveR2Key consults this table before the fuzzy pass', () => {
    // Each of these resolved to a different body of water before the table existed.
    const cases = [
      ['May River', 'coast_hilton_head_sc'],       // was mayo_lake, NC
      ['South Creek', 'coast_pamlico_sound_nc'],   // was south_holston_lake, TN
      ['Black Creek', 'great_pee_dee_river'],      // was lake_blackshear, GA
      ['Russ Creek', 'little_pee_dee_river'],      // was lake_thurmond_russell
      ['Shem Creek', 'coast_charleston_sc'],       // was nothing
      ['Cooper River', 'coast_charleston_sc'],     // was nothing
    ];
    for (const [name, want] of cases) {
      if (!WATER_TO_R2_KEY[name]) continue;        // regenerated data may drop a name
      expect(resolveR2Key(name)).toBe(want);
    }
  });

  it('does not shadow a lake that already resolved correctly', () => {
    expect(resolveR2Key('Lake Marion, SC')).toBe('lake_marion');
    expect(resolveR2Key('Lake Murray')).toBe('lake_murray');
  });

  it('a name spanning several zones still answers, and offers every candidate', () => {
    const icw = waterZoneCandidates('Intracoastal Waterway');
    if (!icw.length) return;
    expect(icw.length).toBeGreaterThan(1);
    expect(icw.every(isCoastalKey)).toBe(true);
    expect(resolveWaterKey('Intracoastal Waterway')).toBe(icw[0]);
  });

  it('tolerates junk', () => {
    expect(resolveWaterKey('')).toBe(null);
    expect(resolveWaterKey(null)).toBe(null);
    expect(resolveWaterKey(undefined)).toBe(null);
    expect(resolveWaterKey(42)).toBe(null);
    expect(waterZoneCandidates(null)).toEqual([]);
  });
});
