import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { COASTAL_ZONES, COASTAL_SLUGS } from '../js/data/coastal-zones.js';
import { resolveR2Key } from '../js/data/lake-keys.js';

const JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'js');
function walkJs(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walkJs(p, out);
    else if (e.endsWith('.js')) out.push(p);
  }
  return out;
}

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

  it('enforces strict inshore kayak safety constraints for coastal zones', () => {
    expect(src).toContain('coastalSafetyBlock');
    expect(src).toContain('COASTAL KAYAK RESTRICTION');
    expect(src).toContain('STRICT SAFETY CONSTRAINT');
  });
});

describe('coastal weather lookup gap', () => {
  it('every coastal zone has a centre for the forecast call', () => {
    // COASTAL_ZONES is the fallback that closes the gap.
    for (const slug of COASTAL_SLUGS) {
      const [lat, lon] = COASTAL_ZONES[slug].center;
      expect(Number.isFinite(lat), `${slug} lat`).toBe(true);
      expect(Number.isFinite(lon), `${slug} lon`).toBe(true);
    }
  });

  it('smart-plan prefers the coastal centre over any curated centre', () => {
    expect(src).toContain('coastalCenter');
    expect(src).toMatch(/coastalCenter\s*\|\|/);
  });

  it('nothing in the app imports js/data/lakes.js — the file is gone', () => {
    // js/data/lakes.js was deleted 2026-08-04. It had been listed as dead code three times
    // and was not dead: consolidate_lake_index.py read it as the ONLY source of USGS gauge
    // sites (Marion, Moultrie, Murray, Parr Shoals, Wateree), Duke and Dominion basin
    // bindings, normal/min pool elevations, and the curated ramp lists on 38 index rows.
    // Deleting it as written would have stripped all of that silently, because the index
    // still builds — it just builds without gauges.
    //
    // The data moved to registry/curated_lakes.json, beside the index it feeds, where it is
    // obviously pipeline input rather than an orphaned app module. What this test guards is
    // that it never comes BACK into js/ — a re-added lakes.js would be read by nothing and
    // would start the same misdiagnosis over.
    const offenders = [];
    for (const f of walkJs(JS)) {
      const cleaned = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      if (/from\s+['"][^'"]*data\/lakes\.js['"]/.test(cleaned) || /\bLAKE_DB\b/.test(cleaned)) {
        offenders.push(f.slice(JS.length + 1));
      }
    }
    expect(offenders).toEqual([]);
    expect(existsSync(path.join(JS, 'data', 'lakes.js'))).toBe(false);
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
