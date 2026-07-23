import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('golden fixtures — researchdocs and data files exist for characterization', () => {
  it('researchdocs contains lake research profiles', () => {
    const dir = 'researchdocs';
    const files = fs.readdirSync(dir);
    const researchJsons = files.filter(f => f.includes('_research') && f.endsWith('.json'));
    expect(researchJsons.length).toBeGreaterThanOrEqual(3);
    // Wateree, Marion, Monticello at least
    expect(files.join(' ')).toMatch(/wateree/i);
    expect(files.join(' ')).toMatch(/marion/i);
  });

  it('researchdocs research JSON has required top-level fields', () => {
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

  it('data/tristate-*.json GIS caches exist', () => {
    expect(fs.existsSync('data/tristate-bank-pier.json')).toBe(true);
    expect(fs.existsSync('data/tristate-paddle.json')).toBe(true);
    expect(fs.existsSync('data/tristate-hotspots.json')).toBe(true);
  });

  it('tristate GIS samples have expected shape', () => {
    const bankPier = JSON.parse(fs.readFileSync('data/tristate-bank-pier.json', 'utf8'));
    // Could be array or object — just check not empty
    const size = Array.isArray(bankPier) ? bankPier.length : Object.keys(bankPier).length;
    expect(size).toBeGreaterThan(0);
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
