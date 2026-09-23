/**
 * test/fifty-rivers-answered-unknown-on-the-safety-route.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * `/river` is the route that makes the kayak go/no-go call, and `plan-builder.js` calls it for
 * real. It resolved its water against `RIVERS` in worker-data.js -- SIX hand-written entries --
 * and answered `{error: "unknown river"}` for the other fifty, with `available` listing the six
 * as though the app knew six rivers. It knows 56.
 *
 * WHAT THE BINDING ALREADY HELD, measured 2026-09-23 over registry/water_bindings.json:
 *
 *     rivers bound                                     56
 *     with at least one USGS gauge                     56   (median 6 each, max 17)
 *     with a pool gauge                                51
 *     with NWS flood categories on that gauge          32
 *
 * So the gauges the six type by hand are bound per water for all of them, with the site, the
 * parameter codes, the flood categories and the datum that go with them.
 *
 * AND WHAT IS STILL NOT DERIVABLE, which is why this does not simply delete RIVERS:
 *
 *     kayakThresholds   Wateree 800/2500/5000/8000 cfs; Congaree 2000/6000/12000/20000. An order
 *                       of magnitude apart, and nothing in the binding says which a new river is.
 *     centerline        estimateSurgeAt needs river miles. Every pack ships one; the Worker does
 *                       not read packs.
 *     surgeAttenuation  one curve, calibrated on one river against one trip report.
 *
 * THE DANGEROUS FAILURE THIS GUARDS. `assessKayakSafety` compares `cfs >= t.cfsDanger`. With no
 * thresholds every comparison is against `undefined`, which is false, so it falls through to
 * "Conditions appear normal — paddleable." A confident GO on a river nobody measured is worse
 * than the 404 it replaced, so the verdict is withheld and the payload says why.
 *
 *   node --test test/fifty-rivers-answered-unknown-on-the-safety-route.test.js
 */
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { riverCfgFromBinding } from '../Worker/trollmap-worker.js';
import { RIVERS } from '../Worker/worker-data.js';

const SRC = readFileSync(new URL('../Worker/trollmap-worker.js', import.meta.url), 'utf8');

// A binding in the shape build_water_bindings.py writes, trimmed to the fields read here.
const WATEREE = {
  slug: 'wateree_river',
  display_name: 'Wateree River (Richland Co, SC)',
  state: 'SC',
  feature_type: 'river',
  pool: { lid: 'CMDS1', usgs_site: '02148000', name: 'Wateree River near Camden',
          lat: 34.2444, lon: -80.6542,
          flood: { action: 16.0, minor: 24.0, moderate: 29.0, major: 35.0, units: 'ft' } },
  gauges: [
    { usgs_site: '02147801', name: 'LAKE WATEREE TAILRACE ABOVE CAMDEN, SC', lat: 34.332, lon: -80.698 },
    { usgs_site: '02148000', name: 'a duplicate of the pool site', lat: 34.2444, lon: -80.6542 },
    { name: 'a gauge with no USGS site at all', lat: 33.9, lon: -80.6 },
  ],
};

describe('a river with no RIVERS row gets its gauges from its own binding', () => {
  const cfg = riverCfgFromBinding('wateree_river', WATEREE);

  it('is labelled by the registry, not the slug', () => {
    expect(cfg.label).toBe('Wateree River (Richland Co, SC)');
  });

  it('the pool gauge is the primary one', () => {
    const primary = cfg.gauges.filter((g) => g.primary);
    expect(primary.length).toBe(1);
    expect(primary[0].site).toBe('02148000');
  });

  it('a site listed twice is carried once', () => {
    // The pool gauge is very often repeated in `gauges`. Two records for one site would make
    // `out.gauges` fetch the same USGS series twice and print the river's flow twice.
    expect(cfg.gauges.map((g) => g.site).sort()).toEqual(['02147801', '02148000']);
  });

  it('a gauge with no USGS site is dropped, because fetchUsgs has nothing to ask for', () => {
    expect(cfg.gauges.every((g) => !!g.site)).toBe(true);
  });

  it('the NWS flood categories travel with the gauge that has them', () => {
    const pool = cfg.gauges.find((g) => g.primary);
    expect(pool.flood.action).toBe(16);
    expect(pool.lid).toBe('CMDS1');
  });

  it('invents no kayak thresholds, no centreline and no attenuation curve', () => {
    expect(cfg.kayakThresholds).toBe(undefined);
    expect(cfg.centerline).toBe(undefined);
    expect(cfg.surgeAttenuation).toBe(undefined);
    expect(cfg.surgeSpeed_mph).toBe(undefined);
  });

  it('says it came from a binding, so a reader can tell the two sources apart', () => {
    expect(cfg._fromBinding).toBe(true);
  });
});

describe('the six curated rivers are unchanged', () => {
  it('still carry the things a binding cannot supply', () => {
    const wateree = RIVERS.wateree;
    expect(Array.isArray(wateree.gauges)).toBe(true);
    expect(typeof wateree.kayakThresholds.cfsDanger).toBe('number');
    expect(typeof wateree.surgeSpeed_mph).toBe('number');
  });

  it('and a name that reaches one of them still reaches it first', () => {
    // Curated-first in the resolver, because only these have a surge model.
    const curatedAt = SRC.indexOf('Object.keys(RIVERS).find((k) => r.includes(k)');
    const boundAt = SRC.indexOf('Object.keys(bound).find((k) => k === r)');
    expect(curatedAt).toBeGreaterThan(0);
    expect(boundAt).toBeGreaterThan(curatedAt);
  });
});

describe('the go/no-go is withheld rather than guessed', () => {
  it('assessKayakSafety is not reached without thresholds', () => {
    expect(SRC.includes('if (primary && !cfg.kayakThresholds)')).toBe(true);
    expect(SRC.includes('out.kayak_assessment_unavailable')).toBe(true);
  });

  it('and the reason says the numbers above are still real', () => {
    expect(SRC.includes('The gauge readings above are measured; read them yourself.')).toBe(true);
  });

  it('the fall-through in assessKayakSafety is the thing being avoided', () => {
    // If this line ever stops existing, the guard above is guarding nothing and should be
    // re-derived rather than left in place looking like care.
    expect(SRC.includes('Conditions appear normal')).toBe(true);
  });
});

describe('the route no longer tells the caller the app knows six rivers', () => {
  it('`available` is the union of the bindings and the curated table', () => {
    expect(SRC.includes('const known = Object.keys({ ...bound, ...RIVERS }).sort();')).toBe(true);
    expect(SRC.includes('available: known')).toBe(true);
  });

  it('and Object.keys(RIVERS) is no longer offered as the list of what exists', () => {
    expect(SRC.includes('available: Object.keys(RIVERS)')).toBe(false);
  });
});
