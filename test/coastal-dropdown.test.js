import { describe, it, expect, beforeEach, vi } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { COASTAL_ZONES, COASTAL_SLUGS, coastalNamesByState } from '../js/data/coastal-zones.js';
import { resolveR2Key } from '../js/data/lake-keys.js';
import { appendCoastalOptgroups } from '../js/utils/coastal-optgroups.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const planBuilderSrc = readFileSync(path.join(REPO, 'js/modules/plan-builder.js'), 'utf8');
const rampSelectSrc = readFileSync(path.join(REPO, 'js/modules/lake-ramp-select.js'), 'utf8');
const researchUiSrc = readFileSync(path.join(REPO, 'js/modules/lake-research-ui.js'), 'utf8');
const smartPlanSrc = readFileSync(path.join(REPO, 'js/modules/smart-plan.js'), 'utf8');

/**
 * The smallest DOM that appendCoastalOptgroups touches: createElement, appendChild and the
 * label / value / textContent properties. Enough to assert what it builds without pulling a
 * whole DOM implementation into the suite for three element types.
 */
function makeSelect() {
  const node = () => ({ children: [], appendChild(c) { this.children.push(c); } });
  globalThis.document = globalThis.document || {};
  globalThis.document.createElement = node;
  return node();
}

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

  it('the coastal zones are the only source of coastal ramps', () => {
    // This used to assert that LAKE_DB covered only 10 of the 22 zones, so it could not back
    // a coastal ramp list on its own. That is still true and no longer worth testing: the
    // file is deleted. What matters now is that every zone can supply what the dropdown
    // needs, since nothing else can.
    for (const slug of COASTAL_SLUGS) {
      const z = COASTAL_ZONES[slug];
      expect(Boolean(z && z.name), `${slug} name`).toBe(true);
      expect(Array.isArray(z.center) && z.center.length >= 2, `${slug} center`).toBe(true);
    }
  });
});

describe('both waterbody dropdowns offer coastal zones', () => {
  // This used to assert that each module's SOURCE contained `coastalNamesByState` and the
  // three group labels -- which was really a test that the loop had been copy-pasted into
  // that file. It had been, THREE times: lake-ramp-select.js, lake-research-ui.js and
  // plan-builder.js each built the same optgroups from the same call, byte for byte apart
  // from the variable holding the <select>. The duplication audit only saw two of them,
  // because plan-builder's copy put `opt.value` and `opt.textContent` on one line and fell
  // under the 8-line window.
  //
  // They now share js/utils/coastal-optgroups.js, so the test asserts what actually matters:
  // every dropdown calls the one builder, and the one builder produces the three groups.
  const CALLERS = [
    ['plan-builder', planBuilderSrc],
    ['lake-ramp-select', rampSelectSrc],
    ['lake-research-ui', researchUiSrc],
  ];

  it('every waterbody dropdown builds its coastal groups from the shared helper', () => {
    for (const [name, src] of CALLERS) {
      expect(src, `${name} does not call appendCoastalOptgroups`).toContain('appendCoastalOptgroups');
      expect(src, `${name} still has its own copy of the loop`).not.toContain('coastalNamesByState()');
    }
  });

  it('the shared helper groups coastal zones by state', () => {
    const select = makeSelect();
    const added = appendCoastalOptgroups(select);
    expect(added).toBe(22);
    const labels = select.children.map((c) => c.label);
    expect(labels).toEqual(['SC Coast', 'GA Coast', 'NC Coast']);
  });

  it('the option value keeps the state suffix, the visible label drops it', () => {
    const select = makeSelect();
    appendCoastalOptgroups(select);
    const opts = select.children.flatMap((g) => g.children);
    const winyah = opts.find((o) => o.value.startsWith('Winyah Bay'));
    expect(Boolean(winyah)).toBe(true);
    expect(winyah.value).toBe('Winyah Bay / Georgetown, SC');
    expect(winyah.textContent).toBe('Winyah Bay / Georgetown');
    // The VALUE is what resolveR2Key() keys off; trimming it would break layer + tide loading.
    expect(resolveR2Key(winyah.value)).toBe('coast_winyah_bay_sc');
  });

  it('the grouping covers all 22 zones exactly once', () => {
    const g = coastalNamesByState();
    const all = [...g.SC, ...g.GA, ...g.NC];
    expect(all).toHaveLength(22);
    expect(new Set(all).size).toBe(22);
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

  // The "label drops the suffix, value keeps it" assertion that used to live here read
  // plan-builder's source for the literal regex. It now lives one describe up, against the
  // shared helper's actual output, which is the thing that has to hold.
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
