import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { COASTAL_ZONES, COASTAL_SLUGS } from '../js/data/coastal-zones.js';
import { LAKE_DB } from '../js/data/lakes.js';
import { resolveR2Key } from '../js/data/lake-keys.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(REPO, 'js/modules/smart-plan.js'), 'utf8');

// smart-plan.js imports Leaflet-bound modules at load time, so we assert the
// integration contract statically plus the data-level invariants that the
// coastal branch depends on.

describe('smart-plan coastal mode — integration contract', () => {
  it('detects coastal zones from the resolved R2 key', () => {
    expect(src).toContain('detectCoastalZone');
    expect(src).toContain('isCoastalKey');
  });

  it('builds tide + salinity context and injects it into the Groq prompt', () => {
    expect(src).toContain('buildCoastalContext');
    expect(src).toContain('buildCoastalPromptBlock');
    expect(src).toMatch(/\$\{coastalBlock\}/);
  });

  it('pulls tide state and river gauges from the shared modules', () => {
    expect(src).toContain('getTideStateForZone');
    expect(src).toContain('assessZoneIntrusion');
  });

  it('treats coastal enrichment as non-fatal', () => {
    // A dead NOAA/USGS endpoint must cost precision, not the whole plan.
    const block = src.slice(src.indexOf('let coastalCtx'), src.indexOf('${coastalBlock}'));
    expect(block).toContain('try');
    expect(block).toContain('catch');
  });

  it('re-labels soundings with the launch-time tide height', () => {
    expect(src).toContain('refreshSoundingLabels');
  });
});

describe('coastal weather lookup gap', () => {
  it('only 9 of the 21 coastal zones exist in LAKE_DB', () => {
    // This is why the forecast fetch cannot rely on LAKE_DB alone.
    const inDb = COASTAL_SLUGS.filter((slug) => {
      const name = COASTAL_ZONES[slug].name;
      return Boolean(LAKE_DB[name]);
    });
    expect(inDb.length).toBeLessThan(COASTAL_SLUGS.length);
  });

  it('every coastal zone has a centre for the forecast call', () => {
    // COASTAL_ZONES is the fallback that closes the gap.
    for (const slug of COASTAL_SLUGS) {
      const [lat, lon] = COASTAL_ZONES[slug].center;
      expect(Number.isFinite(lat), `${slug} lat`).toBe(true);
      expect(Number.isFinite(lon), `${slug} lon`).toBe(true);
    }
  });

  it('smart-plan prefers the coastal centre over LAKE_DB', () => {
    expect(src).toContain('coastalCenter');
    expect(src).toMatch(/coastalCenter\s*\|\|/);
  });

  it('LAKE_DB coastal entries agree with the generated catalog', () => {
    // Where both exist they must not disagree, or the forecast would be for
    // a different piece of water than the tides.
    for (const slug of COASTAL_SLUGS) {
      const zone = COASTAL_ZONES[slug];
      const dbEntry = LAKE_DB[zone.name];
      if (!dbEntry?.center) continue;
      expect(dbEntry.center[0], `${slug} lat`).toBeCloseTo(zone.center[0], 1);
      expect(dbEntry.center[1], `${slug} lon`).toBeCloseTo(zone.center[1], 1);
      if (dbEntry.tideStation) {
        expect(dbEntry.tideStation, `${slug} station`).toBe(zone.tideStation);
      }
    }
  });
});

describe('coastal zone detection end to end', () => {
  it('every coastal display name is detected as coastal', () => {
    for (const slug of COASTAL_SLUGS) {
      const key = resolveR2Key(COASTAL_ZONES[slug].name);
      expect(key.startsWith('coast_'), `${slug} not detected`).toBe(true);
    }
  });

  it('freshwater lakes are not misdetected as coastal', () => {
    for (const name of ['Lake Murray, SC', 'Lake Wateree, SC', 'Lake Norman, NC']) {
      const key = resolveR2Key(name);
      expect(key?.startsWith('coast_') ?? false, `${name} misdetected`).toBe(false);
    }
  });
});
