import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { COASTAL_ZONES, COASTAL_SLUGS } from '../js/data/coastal-zones.js';
import { resolveR2Key } from '../js/data/lake-keys.js';
// Still imported: LAKE_DB is dead to the app but alive to the pipeline. See the
// 'LAKE_DB is dead to the app' test below for why the file is not deleted yet.
import { LAKE_DB } from '../js/data/lakes.js';

const sep = path.sep;
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

  it('LAKE_DB is dead to the app', () => {
    // This replaced a test that asserted LAKE_DB's coastal bounds AGREE with the generated
    // catalog. That test was guarding a corpse. Every reference to LAKE_DB left in js/ is a
    // comment recording its removal -- ramps.js, plan-builder.js, smart-plan.js,
    // lake-research-engine.js and utility-sync.js all say so in their own words -- and
    // nothing outside test/ imports data/lakes.js at all. Ryan, plainly: "LAKE_DB is dead
    // abandoned code."
    //
    // Keeping the sync test meant every edit to coastal_catalog.py forced a matching edit to
    // a structure with no readers, and going green depended on maintaining data nothing uses.
    // The real invariant is that it stays unused, so that is what is asserted.
    // NOT "the file is gone" -- not yet. It is dead to the APP but still live to the
    // PIPELINE: consolidate_lake_index.py reads `lake_db` out of registry/js_lists.json,
    // which js/data/dump_js_lists.mjs generates from this file, and two registry entries --
    // "Congaree River (to SC-601)" and "Wateree River" -- currently list lake_db as their
    // ONLY source. Deleting it today would drop them from the index silently.
    //
    // Both are rivers, so make_river_boundaries.py should produce them from the DNR ramp
    // feeds. Once it does and they carry a second source, the file goes -- see DELETION_TAB.
    // Until then the invariant is narrower: nothing in the running app may read it.
    const offenders = [];
    for (const f of walkJs(JS)) {
      const src = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      // dump_js_lists.mjs is the pipeline generator, not app code -- it is allowed.
      if (f.endsWith(`${sep}lakes.js`) || f.endsWith(`${sep}dump_js_lists.mjs`)) continue;
      if (/from\s+['"][^'"]*data\/lakes\.js['"]/.test(src) || /\bLAKE_DB\b/.test(src)) {
        offenders.push(f.slice(JS.length + 1));
      }
    }
    expect(offenders).toEqual([]);
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
