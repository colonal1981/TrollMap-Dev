import { describe, it, expect } from './expect-shim.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  COASTAL_ZONES,
  COASTAL_SLUGS,
  isCoastalKey,
  getCoastalZone,
  coastalZonesByState,
  coastalNamesByState,
} from '../js/data/coastal-zones.js';
import { LAKE_NAME_TO_R2_KEY, resolveR2Key } from '../js/data/lake-keys.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('coastal-zones.js — generated catalog stays in sync with coastal_catalog.py', () => {
  it('generated file is not stale (regenerate with Scripts/gen_coastal_zones_js.py)', () => {
    let result = 'skipped';
    try {
      execFileSync('python3', ['Scripts/gen_coastal_zones_js.py', '--check'], {
        cwd: REPO,
        stdio: 'pipe',
      });
      result = 'ok';
    } catch (err) {
      // Only fail on a real staleness signal. If python3 is unavailable in
      // this environment the generator can't run and the check is inert.
      if (err.code === 'ENOENT') return;
      throw new Error(
        `coastal-zones.js is out of date with Scripts/coastal_catalog.py.\n` +
        `Run: python3 Scripts/gen_coastal_zones_js.py\n` +
        `${err.stdout?.toString() || ''}${err.stderr?.toString() || ''}`
      );
    }
    expect(['ok', 'skipped']).toContain(result);
  });

  // 16, not 22. The six NC sounds and the Georgia-Florida corner were cut from
  // Scripts/coastal_catalog.py on 2026-08-19: they are outside the region polygon, so
  // consolidate_lake_index.py had been dropping them from lake_index.json on every run while
  // coastal-zones.js went on offering them in the picker. Ryan: "those names are just there so
  // they can select water i dont want them to select". Measured before cutting: no river in the
  // index has a ramp within 25 km of any of the six, so nothing depends on them for the NC/GA
  // salt test in make_river_boundaries.py.
  //
  // 13 since 2026-09-03, and THIS ASSERTION WAS THE STALE SIDE for two days. a4bfd02 cut the
  // three remaining NC zones out of the app on 2026-09-01 and did not touch coastal_catalog.py,
  // so the generator's source said 16, its output said 13, and the number here said 16 -- which
  // made the failure read like the app had lost three zones rather than like the catalog had
  // kept three. The staleness check above is the one that says which side is wrong; this line
  // only says how many there should be, and it is worth having precisely because a regeneration
  // that silently drops a zone leaves both files agreeing with each other and nothing else.
  it('has all 13 coastal zones', () => {
    expect(COASTAL_SLUGS).toHaveLength(13);
  });

  it('every slug is prefixed coast_ so isCoastalKey() detection is reliable', () => {
    for (const slug of COASTAL_SLUGS) {
      expect(slug.startsWith('coast_')).toBe(true);
      expect(isCoastalKey(slug)).toBe(true);
    }
  });

  it('isCoastalKey() rejects freshwater keys and junk', () => {
    expect(isCoastalKey('murray')).toBe(false);
    expect(isCoastalKey('lake_wateree')).toBe(false);
    expect(isCoastalKey('')).toBe(false);
    expect(isCoastalKey(null)).toBe(false);
    expect(isCoastalKey(undefined)).toBe(false);
    expect(isCoastalKey(42)).toBe(false);
  });

  it('every zone has the fields SmartPlan and the tide panel depend on', () => {
    for (const slug of COASTAL_SLUGS) {
      const z = COASTAL_ZONES[slug];
      expect(z.slug, `${slug}.slug`).toBe(slug);
      expect(z.name, `${slug}.name`).toBeTruthy();
      // NC left on 2026-09-01 and is not coming back: Ryan, 2026-09-03, "But keep NC coastal
      // cut... i do not want it back in". An NC zone reaching this file again is a bug.
      expect(['SC', 'GA'], `${slug}.state`).toContain(z.state);
      expect(z.coastal).toBe(true);

      // NOAA CO-OPS station IDs are 7 digits.
      expect(z.tideStation, `${slug}.tideStation`).toMatch(/^\d{7}$/);

      const [lat, lon] = z.center;
      expect(lat, `${slug} center lat`).toBeGreaterThan(30);
      expect(lat, `${slug} center lat`).toBeLessThan(37);
      expect(lon, `${slug} center lon`).toBeGreaterThan(-82);
      expect(lon, `${slug} center lon`).toBeLessThan(-75);

      // bbox is [[south, west], [north, east]] — Leaflet order.
      const [[south, west], [north, east]] = z.bbox;
      expect(south, `${slug} bbox south<north`).toBeLessThan(north);
      expect(west, `${slug} bbox west<east`).toBeLessThan(east);

      // Centre must fall inside its own bbox.
      expect(lat).toBeGreaterThanOrEqual(south);
      expect(lat).toBeLessThanOrEqual(north);
      expect(lon).toBeGreaterThanOrEqual(west);
      expect(lon).toBeLessThanOrEqual(east);

      expect(Array.isArray(z.usgsGauges), `${slug}.usgsGauges`).toBe(true);
    }
  });

  it('ramp coordinates are plausible and numeric', () => {
    for (const slug of COASTAL_SLUGS) {
      const z = COASTAL_ZONES[slug];
      for (const [rampName, coords] of Object.entries(z.ramps || {})) {
        expect(coords, `${slug} / ${rampName}`).toHaveLength(2);
        const [lat, lon] = coords;
        expect(Number.isFinite(lat), `${slug} / ${rampName} lat`).toBe(true);
        expect(Number.isFinite(lon), `${slug} / ${rampName} lon`).toBe(true);
        expect(lat).toBeGreaterThan(30);
        expect(lat).toBeLessThan(37);
        expect(lon).toBeGreaterThan(-82);
        expect(lon).toBeLessThan(-75);
      }
    }
  });

  it('USGS gauge site IDs are 8-digit NWIS identifiers', () => {
    for (const slug of COASTAL_SLUGS) {
      for (const site of COASTAL_ZONES[slug].usgsGauges) {
        expect(site, `${slug} gauge ${site}`).toMatch(/^\d{8}$/);
      }
    }
  });

  it('every zone display name resolves through resolveR2Key() to its own slug', () => {
    // This is the contract supplemental-layers.js and contour-data.js rely on:
    // pick a coastal zone in the UI -> resolveR2Key(displayName) -> R2 prefix.
    for (const slug of COASTAL_SLUGS) {
      const displayName = COASTAL_ZONES[slug].name;
      expect(resolveR2Key(displayName), `resolveR2Key(${displayName})`).toBe(slug);
    }
  });

  it('lake-keys.js contains an entry for every coastal zone', () => {
    const mapped = new Set(Object.values(LAKE_NAME_TO_R2_KEY));
    for (const slug of COASTAL_SLUGS) {
      expect(mapped.has(slug), `lake-keys.js missing ${slug}`).toBe(true);
    }
  });

  it('tide stations are shared sensibly and all zones are covered', () => {
    const byStation = {};
    for (const slug of COASTAL_SLUGS) {
      const st = COASTAL_ZONES[slug].tideStation;
      (byStation[st] ||= []).push(slug);
    }
    // Adjacent zones legitimately share a station; the thing worth refusing is every zone
    // collapsing onto one, which would mean a tide panel showing the same water everywhere.
    // This used to read `>= 8` and started failing the moment the catalog went 16 -> 13 with
    // six stations left -- a number that tracked the zone count rather than the property it
    // was there to protect. Stated as the property instead: more than one station, and no
    // single station speaking for more than half the coast.
    expect(Object.keys(byStation).length).toBeGreaterThan(1);
    const busiest = Math.max(...Object.values(byStation).map((z) => z.length));
    expect(busiest <= COASTAL_SLUGS.length / 2, `one station covers ${busiest} of ${COASTAL_SLUGS.length} zones`).toBe(true);
  });

  it('getCoastalZone() returns zones and null for unknown slugs', () => {
    expect(getCoastalZone('coast_charleston_sc').name).toBe('Charleston Harbor, SC');
    expect(getCoastalZone('nope')).toBeNull();
    expect(getCoastalZone(undefined)).toBeNull();
  });

  it('state grouping covers every zone with no leaks', () => {
    // Summed over whatever buckets the generator emitted, not over a typed SC/GA/NC list.
    // The typed version threw a TypeError the day NC left, and a TypeError does not say
    // "a state was removed" -- it says "cannot read length of undefined" in a test named for
    // leaks. The generator derives the buckets from the catalog; so does this.
    const grouped = coastalNamesByState();
    const total = Object.values(grouped).reduce((n, names) => n + names.length, 0);
    expect(total).toBe(COASTAL_SLUGS.length);
    expect(Object.keys(grouped).sort()).toEqual(['GA', 'SC']);
    expect(coastalZonesByState('SC')).toHaveLength(grouped.SC.length);
    expect(coastalZonesByState('ga')).toHaveLength(grouped.GA.length);
    expect(coastalZonesByState('XX')).toHaveLength(0);
  });

  it('slugs and display names are unique', () => {
    const names = COASTAL_SLUGS.map((s) => COASTAL_ZONES[s].name);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(COASTAL_SLUGS).size).toBe(COASTAL_SLUGS.length);
  });
});
