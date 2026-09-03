import { readFileSync } from 'node:fs';
import { describe, it, expect } from './expect-shim.mjs';

/**
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE UPLOADER AND THE READER MUST NAME THE SAME OBJECTS.
 *
 * Worker/registry.js already carries the warning, written beside species_traits.json:
 *
 *   > Three lists, not one: here, verify_registry_r2.py's EXPECT, and Worker/registry.js.
 *
 * Four more registry objects arrived on 2026-09-03 -- the habitat weights, the ENC seabed, the
 * current stations and the eHydro index. Copying that pattern would have meant twelve edits
 * across three files and three places to forget one.
 *
 * WHAT GOES WRONG WHEN THEY DRIFT. The uploader is the only thing that puts an object in the
 * bucket and the Worker is the only thing that reads it. Add a file to one and not the other and
 * there is no error anywhere: the object is published and never read, or the loader throws at
 * request time on a water somebody is trying to plan a day on. Neither shows up until it is
 * live.
 *
 * So this test does not restate the list. It PARSES BOTH SIDES and asserts they agree, which
 * means the list can only be wrong in one place at a time and the test says which.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

const PY = readFileSync(new URL('../Scripts/upload_garmin_to_r2.py', import.meta.url), 'utf8');
const JS = readFileSync(new URL('../Worker/registry.js', import.meta.url), 'utf8');

/** The filenames in upload_garmin_to_r2.py's PASSTHROUGH_REGISTRIES table. */
function pythonTable() {
  const m = PY.match(/PASSTHROUGH_REGISTRIES\s*=\s*\{([\s\S]*?)\n\}/);
  if (!m) return null;
  return new Map(
    [...m[1].matchAll(/"([A-Za-z0-9_]+\.json)"\s*:\s*\n?\s*"([^"]*)"/g)]
      .map((x) => [x[1], x[2]]),
  );
}

/** Every '_registry/<name>.json' the Worker declares as a key constant. */
function workerKeys() {
  return new Set(
    [...JS.matchAll(/_registry\/([A-Za-z0-9_]+\.json)/g)].map((x) => x[1]),
  );
}

/** The passthrough loaders the Worker exports, and the script each one names in its error. */
function workerLoaders() {
  return [...JS.matchAll(
    /export const (\w+) = passthroughLoader\(\s*(\w+),\s*'([^']+)',/g,
  )].map((m) => ({ name: m[1], key: m[2], script: m[3] }));
}

describe('the uploader and the Worker name the same registry objects', () => {
  it('the python table is parseable at all', () => {
    const table = pythonTable();
    expect(table).not.toBe(null);
    // If this drops to zero the two assertions below pass vacuously and prove nothing.
    expect(table.size >= 4).toBe(true);
  });

  it('every file the uploader publishes has a key in the Worker', () => {
    const keys = workerKeys();
    const missing = [...pythonTable().keys()].filter((f) => !keys.has(f));
    expect(missing.join(', ')).toBe('');
  });

  it('every passthrough loader in the Worker is published by the uploader', () => {
    // The other direction, and the one that fails at request time rather than silently:
    // a loader for an object nothing uploads throws on a live plan.
    const table = pythonTable();
    const loaders = workerLoaders();
    expect(loaders.length >= 4).toBe(true);
    const keyLine = (constName) => {
      const m = JS.match(new RegExp(`${constName}\\s*=\\s*'_registry/([A-Za-z0-9_]+\\.json)'`));
      return m ? m[1] : null;
    };
    const orphans = loaders
      .map((l) => keyLine(l.key))
      .filter((f) => f && !table.has(f));
    expect(orphans.join(', ')).toBe('');
  });

  it('each loader names a real script for the run that is missing its object', () => {
    // A missing object must say what to run. "not in the bucket" alone sends somebody reading
    // the Worker to find out which of forty scripts writes it.
    for (const l of workerLoaders()) {
      expect(l.script.endsWith('.py')).toBe(true);
    }
  });

  it('the reason text for a missing file says what is lost, not just that it is missing', () => {
    // The reason is printed by the uploader when the file is absent and is the only thing
    // telling a future run what the silence costs.
    for (const [file, why] of pythonTable()) {
      expect(`${file}: ${why.length > 20}`).toBe(`${file}: true`);
    }
  });
});

describe('the new caches clear with the old ones', () => {
  it('_resetIndexCache runs the passthrough resets', () => {
    // Each passthrough loader closes over its own cache. If _resetIndexCache does not run them,
    // a test that resets the registry still reads an hour-old object and the failure looks like
    // a data problem rather than a test-isolation one.
    const body = JS.match(/export function _resetIndexCache\(\)\s*\{([\s\S]*?)\n\}/);
    expect(body).not.toBe(null);
    expect(/_extraResets/.test(body[1])).toBe(true);
  });
});
