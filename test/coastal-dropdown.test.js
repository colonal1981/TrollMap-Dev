import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { COASTAL_ZONES, COASTAL_SLUGS, coastalNamesByState } from '../js/data/coastal-zones.js';
import { resolveR2Key } from '../js/data/lake-keys.js';
import { LAKE_DB } from '../js/data/lakes.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const planBuilderSrc = readFileSync(path.join(REPO, 'js/modules/plan-builder.js'), 'utf8');
const rampSelectSrc = readFileSync(path.join(REPO, 'js/modules/lake-ramp-select.js'), 'utf8');
const smartPlanSrc = readFileSync(path.join(REPO, 'js/modules/smart-plan.js'), 'utf8');

/**
 * Regression guard for the "everything works but nothing is selectable" class
 * of bug: the coastal engine shipped complete while both waterbody dropdowns
 * were still populated exclusively from inland sources, so no coastal zone
 * could be picked and none of the coastal code paths were reachable.
 */

describe('the gap this closes', () => {
  it('the worker access index has no coastal coverage', () => {
    // #lakeSelect was built only from loadAccessIndex(), which fetches inland
    // DNR boat ramps. Nothing coastal ever appeared.
    expect(rampSelectSrc).toContain('loadAccessIndex');
  });

  it('LAKE_DB alone cannot back a coastal ramp list', () => {
    const missing = COASTAL_SLUGS.filter((s) => !LAKE_DB[COASTAL_ZONES[s].name]);
    // 12 of 21 zones absent -> an empty ramp dropdown and no launch coords.
    expect(missing.length).toBeGreaterThan(0);
  });
});

describe('both waterbody dropdowns offer coastal zones', () => {
  it('plan-builder groups coastal zones by state', () => {
    expect(planBuilderSrc).toContain('coastalNamesByState');
    for (const label of ['SC Coast', 'GA Coast', 'NC Coast']) {
      expect(planBuilderSrc, `plan-builder missing "${label}"`).toContain(label);
    }
  });

  it('map toolbar groups coastal zones by state', () => {
    expect(rampSelectSrc).toContain('coastalNamesByState');
    for (const label of ['SC Coast', 'GA Coast', 'NC Coast']) {
      expect(rampSelectSrc, `lake-ramp-select missing "${label}"`).toContain(label);
    }
  });

  it('the grouping covers all 21 zones exactly once', () => {
    const g = coastalNamesByState();
    const all = [...g.SC, ...g.GA, ...g.NC];
    expect(all).toHaveLength(21);
    expect(new Set(all).size).toBe(21);
  });
});

describe('option values round-trip to R2 keys', () => {
  it('every option value resolves back to its own coastal slug', () => {
    // The option value must be the full display name including the state
    // suffix, because resolveR2Key() keys off it. Using the trimmed label
    // would silently break layer + tide loading.
    const g = coastalNamesByState();
    for (const name of [...g.SC, ...g.GA, ...g.NC]) {
      const key = resolveR2Key(name);
      expect(key, `resolveR2Key(${name})`).toMatch(/^coast_/);
      expect(COASTAL_ZONES[key].name).toBe(name);
    }
  });

  it('the visible label drops the state suffix but the value keeps it', () => {
    expect(planBuilderSrc).toMatch(/opt\.value = name;.*replace\(\/,\\s\*\[A-Z\]\{2\}\$\//s);
  });
});

describe('coastal ramps are wired everywhere a launch point is needed', () => {
  it('plan-builder ramp dropdown reads the coastal catalog', () => {
    expect(planBuilderSrc).toContain('isCoastalKey');
    expect(planBuilderSrc).toMatch(/zone\.ramps/);
  });

  it('ramp options carry coordinates for SmartPlan', () => {
    expect(planBuilderSrc).toContain('dataset.lat');
    expect(planBuilderSrc).toContain('dataset.lon');
  });

  it('map toolbar builds coastal access points from the catalog', () => {
    expect(rampSelectSrc).toMatch(/zone[\s\S]{0,200}ramps/);
  });

  it('smart-plan sources coastal ramps from the catalog, not the access index', () => {
    expect(smartPlanSrc).toContain('_coastalZoneForRamp');
  });

  it('the launch fallback is no longer inland Columbia for coastal zones', () => {
    // 34.0/-81.0 is ~100 miles inland; using it for an estuary would produce
    // a plan on dry land.
    expect(smartPlanSrc).toMatch(/_coastalZoneForRamp\?\.center/);
  });

  it('every zone has at least one ramp with usable coordinates', () => {
    for (const slug of COASTAL_SLUGS) {
      const ramps = Object.entries(COASTAL_ZONES[slug].ramps || {});
      expect(ramps.length, `${slug} has no ramps`).toBeGreaterThan(0);
      for (const [name, c] of ramps) {
        expect(Number.isFinite(c[0]), `${slug}/${name} lat`).toBe(true);
        expect(Number.isFinite(c[1]), `${slug}/${name} lon`).toBe(true);
      }
    }
  });
});

describe('selecting a coastal zone reaches the coastal subsystems', () => {
  it('map toolbar fits the zone bbox rather than the ramp cluster', () => {
    // A sound is far larger than its two or three ramps.
    expect(rampSelectSrc).toContain('zone.bbox');
  });

  it('zone selection still triggers contour + supplemental loading', () => {
    expect(rampSelectSrc).toContain('loadContourForLake');
    expect(rampSelectSrc).toContain('loadSupplementalForLake');
  });

  it('each zone reaches tide, layer and species subsystems by its key', () => {
    for (const slug of COASTAL_SLUGS) {
      const zone = COASTAL_ZONES[slug];
      expect(resolveR2Key(zone.name)).toBe(slug);   // layers + contours
      expect(zone.tideStation).toMatch(/^\d{7}$/);  // tide panel
      expect(['SC', 'GA', 'NC']).toContain(zone.state); // species + regs
    }
  });
});
