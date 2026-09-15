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
const wiringSrc = readFileSync(path.join(REPO, 'js/modules/smart-plan-v2-wiring.js'), 'utf8');

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
 *
 * ── NC COASTAL IS CUT, AND THIS FILE WAS THE LAST THING STILL ASKING FOR IT ──
 *
 * The three NC zones went on 2026-09-01 (a4bfd02) with the hand-typed NCDMF
 * regulation table they had no rules behind, and the cut was finished on
 * 2026-09-03 (a46f558) in the catalog that GENERATES coastal-zones.js. Ryan,
 * on the second: "But keep NC coastal cut... i do not want it back in". Asked
 * again 2026-09-15, on finding these three assertions red: "NC zones used to
 * exist but they have been removed... the test probably needs to be updated".
 *
 * So the catalog has been SC and GA only since -- 13 zones, 9 and 4 -- and this
 * file spread `g.NC` into two arrays (`g.NC is not iterable`) and expected an
 * 'NC Coast' optgroup label. It is the same stale-side failure a46f558 records
 * one layer down: the cut happened and what described it stayed put.
 *
 * The assertions below now say SC and GA, and they say it in the direction that
 * fails if NC comes back rather than the direction that tolerates it -- a
 * `toContain(['SC','GA','NC'])` on a zone's state passed either way, which is
 * how it survived the cut without anybody noticing.
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
  //
  // 2026-08-08: the map picker no longer uses the helper, and that is not drift.
  //
  // Ryan: "i want lakes then rivers then coastal for each state." The picker now builds twelve
  // groups -- SC/NC/GA/TN x Lakes/Rivers/Coast -- so its coastal zones sit under their own
  // state beside that state's lakes and rivers, not in three groups bolted on the end. There is
  // no shape of `appendCoastalOptgroups` that produces that, because the helper owns the
  // grouping and the picker needs to own it instead.
  //
  // What still has to hold is the thing the duplication was actually risking: every dropdown
  // gets its zones from the SAME SOURCE, so none of them can quietly go stale. So the picker is
  // required to call `coastalNamesByState` and the other two to call the helper -- and the count
  // check below still pins EVERY zone reaching a dropdown -- against COASTAL_SLUGS.length
  // rather than a literal, because the count is data and hardcoding it means three tests to
  // edit every time a zone is added or cut. It was 22 until the six out-of-region zones went
  // on 2026-08-19.
  const HELPER_CALLERS = [
    ['plan-builder', planBuilderSrc],
    ['lake-research-ui', researchUiSrc],
  ];

  it('the dropdowns that share a grouping share the builder', () => {
    for (const [name, src] of HELPER_CALLERS) {
      expect(src, `${name} does not call appendCoastalOptgroups`).toContain('appendCoastalOptgroups');
      expect(src, `${name} still has its own copy of the loop`).not.toContain('coastalNamesByState()');
    }
  });

  it('the map picker groups coastal by state itself, from the same source', () => {
    expect(rampSelectSrc, 'picker no longer sources zones from coastal-zones.js')
      .toContain('coastalNamesByState');
    expect(rampSelectSrc, 'picker should not also append the helper groups')
      .not.toContain('appendCoastalOptgroups');
    // The grouping it replaced the helper with.
    expect(rampSelectSrc).toContain("STATE_ORDER = ['SC', 'NC', 'GA', 'TN']");
  });

  it('the shared helper groups coastal zones by state', () => {
    const select = makeSelect();
    const added = appendCoastalOptgroups(select);
    expect(added).toBe(COASTAL_SLUGS.length);   // every zone, whatever that count is
    const labels = select.children.map((c) => c.label);
    expect(labels).toEqual(['SC Coast', 'GA Coast']);
  });

  it('and the groups are the states the catalog declares, not a list typed in the helper', () => {
    // `GROUPS` in coastal-optgroups.js was a literal that still asked for an NC group two weeks
    // after NC was cut, and it produced nothing only because the loop skips a state with no
    // zones -- a dead entry that nothing could see and that NC would have come back through.
    // It is derived now, so this test reads the catalog and the helper and requires them to
    // agree, which is a claim that survives a state being added or cut either way.
    const select = makeSelect();
    appendCoastalOptgroups(select);
    const fromHelper = select.children.map((c) => c.label.replace(/ Coast$/, ''));
    const fromCatalog = [...new Set(COASTAL_SLUGS.map((s) => COASTAL_ZONES[s].state))];
    expect(fromHelper.slice().sort()).toEqual(fromCatalog.slice().sort());
    // SC leads, because that is where Ryan fishes, and that is the one thing still stated.
    expect(fromHelper[0]).toBe('SC');
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

  it('the grouping covers every zone exactly once', () => {
    // WAS `[...g.SC, ...g.GA, ...g.NC]`, which threw rather than failed once NC left the catalog.
    // Reading every bucket the grouping returns is the version that cannot go stale: a state added
    // or cut changes the data and this still counts all of it.
    const g = coastalNamesByState();
    const all = Object.values(g).flat();
    expect(all).toHaveLength(COASTAL_SLUGS.length);
    expect(new Set(all).size).toBe(COASTAL_SLUGS.length);
    // AND NO EMPTY BUCKET, which is what a typed list leaves behind when its state is cut.
    for (const [st, names] of Object.entries(g)) {
      expect(names.length > 0, `${st} is an empty bucket`).toBe(true);
    }
  });
});

describe('option values round-trip to R2 keys', () => {
  it('every option value resolves back to its own coastal slug', () => {
    // The option value must be the full display name including the state
    // suffix, because resolveR2Key() keys off it. Using the trimmed label
    // would silently break layer + tide loading.
    const g = coastalNamesByState();
    for (const name of Object.values(g).flat()) {
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

  // ── A GAP, RECORDED RATHER THAN DELETED ─────────────────────────────────────────────────
  //
  // These two assertions read smart-plan.js and passed. smart-plan.js was v1, unreachable since
  // v2 shipped -- so they were green against code that never ran, and the fix they guard has
  // never been in the running app.
  //
  // v1 had `_coastalZoneForRamp`, so a coastal plan launched from the ZONE CATALOG. v2's
  // rampCoords() reads getLoadedAccessIndex().byLake, falls back to points[0], then to an
  // <option> dataset, then to null. For a coastal zone with nothing in the access index, that
  // is the inland-Columbia problem the second assertion existed to prevent.
  //
  // A TRIPWIRE, not a deletion: if the catalog lookup is ported into v2 this fails and forces
  // these back into real contracts. Silence is not evidence either way.
  it('RECORDS A GAP: v2 sources ramps from the access index, not the zone catalog', () => {
    expect(wiringSrc).toContain('getLoadedAccessIndex');
    expect(wiringSrc.includes('_coastalZoneForRamp'),
      'v2 has the catalog lookup now -- rewrite this as a real assertion').toBe(false);
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
  it('map toolbar frames the zone, not the ramp cluster', () => {
    // A sound is far larger than its two or three ramps, so selecting the zone must not
    // reframe on the ramps. It used to fitBounds(zone.bbox); it now hands the whole zone to
    // landOnCoastalZone(), which lands on the zone's own center at a fixed zoom because the
    // bbox is a clip rectangle whose midpoint is 20.5 km from Murrells Inlet.
    //
    // THIS ASSERTION IS A GREP AND THAT IS THE PROBLEM WITH IT. It passed for as long as the
    // string 'zone.bbox' survived anywhere in the file, and it failed on a change that kept
    // the behaviour it exists to protect. The behaviour itself is covered properly, against
    // the real function and real zone data, in coastal-landing.test.js. Kept only as a cheap
    // guard that the call site still passes the ZONE and not a ramp list.
    expect(rampSelectSrc).toMatch(/landOnCoastalZone\(\s*state\.MAP\s*,\s*zone\s*\)/);
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
      // SC AND GA, AND THE ASSERTION FAILS IF A THIRD APPEARS. This read
      // `['SC','GA','NC']).toContain(zone.state)` and so passed both before and after the NC cut,
      // which is exactly why nothing flagged the three dead zones for two days. Every state here
      // must also have a regulation table behind it -- that is what coastal-regulations.test.js
      // enforces, and it is why the zones and the table had to be cut in the same commit.
      expect(['SC', 'GA']).toContain(zone.state); // species + regs
    }
  });
});
