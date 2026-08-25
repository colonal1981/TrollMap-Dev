// test/registry-catalog.test.js -- the registry may answer "what does this site publish", but
// only when its answer can be told apart from the old builder's.
//
// Bindings written before 2026-08-25 hold `00060,00065` and nothing else, because
// build_water_bindings.py intersected the fetched catalogue down to level and flow one line
// before writing. If conditions.js believed such a list, waterProbe would decide that no site
// on any water publishes 00010 and skip every temperature request -- a stale registry turning
// into a silent, total loss of water temperature with no error anywhere.
import { describe, it } from 'node:test';
import { expect } from './expect-shim.mjs';
import { registryCatalog, usgsSitesFor } from '../Worker/conditions.js';

describe('registryCatalog — trusts the registry only when it can be told apart', () => {
  it('refuses a level-only list: that is what the OLD builder wrote', () => {
    expect(registryCatalog(['00060', '00065'])).toBe(null);
    expect(registryCatalog(['00062', '62614', '62615'])).toBe(null);
  });

  it('believes a list naming anything outside level and flow', () => {
    const cat = registryCatalog(['00010', '00060', '00065', '00300', '63160']);
    expect(cat).toBeTruthy();
    expect(Boolean(cat['00010'])).toBe(true);
    expect(Boolean(cat['00300'])).toBe(true);
    expect(Boolean(cat['63680'])).toBe(false);
  });

  it('refuses an empty or missing list rather than claiming nothing is published', () => {
    expect(registryCatalog([])).toBe(null);
    expect(registryCatalog(null)).toBe(null);
    expect(registryCatalog(undefined)).toBe(null);
  });

  it('a weather-station site is believed — Hartwell 02187010 after the rebuild', () => {
    const cat = registryCatalog(['00020', '00035', '00036', '00045', '00052', '00062', '62608']);
    expect(Boolean(cat && cat['00045'])).toBe(true);
    expect(Boolean(cat && cat['00010'])).toBe(false);
  });
});

describe('usgsSitesFor — carries the registry parameter list through', () => {
  const b = {
    pool: { usgs_site: '02171000', name: 'LAKE MARION NEAR PINEVILLE', lat: 33.44, lon: -80.16,
            usgs_parms: ['00010', '00062', '62615'] },
    gauges: [{ usgs_site: '02148000', name: 'WATEREE RIVER NR CAMDEN', lat: 34.24, lon: -80.65,
               parms: '00060,00065' }],
  };
  const sites = usgsSitesFor(b, 33.45, -80.17);

  it('reads an array under usgs_parms', () => {
    expect(sites.find((s) => s.site === '02171000').parms).toContain('00010');
  });

  it('reads a comma string under parms', () => {
    const g = sites.find((s) => s.site === '02148000');
    expect(g.parms).toContain('00060');
    expect(g.parms).toContain('00065');
  });

  it('a site with no parms recorded yields an empty list, never undefined', () => {
    const bare = usgsSitesFor({ pool: { usgs_site: '01', name: 'x', lat: 1, lon: 1 } }, 1, 1);
    expect(Array.isArray(bare[0].parms)).toBe(true);
    expect(bare[0].parms.length).toBe(0);
    expect(registryCatalog(bare[0].parms)).toBe(null);
  });
});
