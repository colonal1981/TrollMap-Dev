import { describe, it, expect } from './expect-shim.mjs';
import fs from 'fs';
import path from 'path';

// `researchdocs/` is excluded from the project's sync filters, so it is absent from most
// checkouts. `fs.readdirSync` on a missing directory THROWS, which made this file error out
// rather than fail cleanly -- the whole suite reported an exception instead of a skip. Golden
// fixtures that may legitimately not be present should skip, loudly, not crash.
const HAS_RESEARCHDOCS = fs.existsSync('researchdocs');
if (!HAS_RESEARCHDOCS) {
  console.log('# skip: researchdocs/ not in this checkout (excluded from sync) — '
            + 'golden-fixture characterization not run');
}

describe('golden fixtures — researchdocs and data files exist for characterization', () => {
  it('researchdocs contains lake research profiles', { skip: !HAS_RESEARCHDOCS }, () => {
    const dir = 'researchdocs';
    const files = fs.readdirSync(dir);
    const researchJsons = files.filter(f => f.includes('_research') && f.endsWith('.json'));
    expect(researchJsons.length).toBeGreaterThanOrEqual(3);
    // Wateree, Marion, Monticello at least
    expect(files.join(' ')).toMatch(/wateree/i);
    expect(files.join(' ')).toMatch(/marion/i);
  });

  it('researchdocs research JSON has required top-level fields', { skip: !HAS_RESEARCHDOCS }, () => {
    const dir = 'researchdocs';
    const files = fs.readdirSync(dir).filter(f => f.includes('wateree') && f.includes('_research'));
    expect(files.length).toBeGreaterThanOrEqual(1);
    const file = path.join(dir, files[0]);
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Characterization of current profile shape — if this changes, tests will catch drift
    expect(json).toHaveProperty('lakeName');
    expect(json).toHaveProperty('state');
    expect(json).toHaveProperty('surfaceAreaAcres');
    // limnology may be partial but should exist
    expect(json).toHaveProperty('limnology');
  });

  // These three files were snapshots of DNR ArcGIS services the Worker already
  // proxies live. They could only ever be staler than the feed, and they masked a
  // real bug for a month: the Worker's GA attractor config returned null lat/lon,
  // so /attractors served Georgia with no coordinates -- invisible, because the
  // front end read Georgia from the snapshot instead. bank-pier, paddle and
  // attractors are now fetched live for all four states in gis-toggles.js.
  //
  // The test is inverted on purpose. It used to assert these existed; it now
  // asserts they are gone AND that no code reaches for them, so re-adding a
  // snapshot fails CI instead of quietly reintroducing the drift.
  const DEAD_SNAPSHOTS = [
    'data/tristate-bank-pier.json',
    'data/tristate-paddle.json',
    'data/tristate-hotspots.json',
  ];

  it('the tristate-*.json GIS snapshots are gone (live from the Worker now)', () => {
    for (const f of DEAD_SNAPSHOTS) {
      expect(fs.existsSync(f)).toBe(false);
    }
  });

  it('no source file references a dead tristate snapshot', () => {
    const roots = ['js', 'Worker', 'index.html'];
    const offenders = [];
    const walk = (p) => {
      if (!fs.existsSync(p)) return;
      if (fs.statSync(p).isDirectory()) {
        for (const e of fs.readdirSync(p)) walk(`${p}/${e}`);
        return;
      }
      if (!/\.(js|mjs|html)$/.test(p)) return;
      const src = fs.readFileSync(p, 'utf8');
      for (const f of DEAD_SNAPSHOTS) {
        const base = f.split('/').pop();
        // Ignore comments explaining why they are gone.
        for (const line of src.split('\n')) {
          if (line.includes(base) && !/^\s*(\/\/|\*|\/\*)/.test(line)) {
            offenders.push(`${p}: ${line.trim().slice(0, 90)}`);
          }
        }
      }
      for (const sym of ['TRISTATE_MASTER_BANK_PIER', 'TRISTATE_MASTER_PADDLE', 'TRISTATE_MASTER_HOTSPOTS']) {
        for (const line of src.split('\n')) {
          if (line.includes(sym) && !/^\s*(\/\/|\*|\/\*)/.test(line)) {
            offenders.push(`${p}: ${line.trim().slice(0, 90)}`);
          }
        }
      }
    };
    roots.forEach(walk);
    expect(offenders).toEqual([]);
  });

  it('wateree_zones_overlay.geojson is still in repo (P1 hygiene task to move)', () => {
    // This file is 5.8 MB and should be moved to R2/LFS — test documents current bloat
    const exists = fs.existsSync('wateree_zones_overlay.geojson');
    const size = exists ? fs.statSync('wateree_zones_overlay.geojson').size : 0;
    // Currently exists, but future PR should remove — when removed, update this test
    if (exists) {
      expect(size).toBeGreaterThan(5_000_000);
    } else {
      // If already removed, that's actually the desired end state
      expect(exists).toBe(false);
    }
  });
});
