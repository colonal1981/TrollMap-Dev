/**
 * registry-here.mjs -- the one place a node test asks whether ../registry is on this machine.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * `registry/` is pipeline OUTPUT. It sits beside the checkout on Ryan's machine, CI fetches three
 * of its objects into the same place before `npm test`, and a cloud checkout has none of it. A test
 * that reads it used to die on ENOENT there, and every cloud session had to sort "that is just the
 * registry" from a real failure by hand. Now such a test asks here and is REPORTED AS SKIPPED, with
 * the file it reads in the reason. It is never passed silently.
 *
 * THE PATH IS BUILT WITH fileURLToPath, NOT URL.pathname. On Windows `.pathname` is
 * "/F:/TrollMapPipeline/...", which is no path at all: on 2026-09-24 registry_smoke, keys_smoke and
 * sync_smoke printed SKIP and exited 0 on the one machine that HAS the registry. A skip that fires
 * there hides the test from the only run that could have caught anything.
 * registry-here.test.js fails if lake_index.json is on disk and this module says it is not.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = fileURLToPath(new URL('..', import.meta.url));

/** The absolute path of ../registry, beside the repo. */
export const REGISTRY = path.join(REPO, '..', 'registry');

/** The absolute path of one registry file. */
export const registryPath = (file) => path.join(REGISTRY, file);

/** true when the ../registry folder exists on this machine. */
export const registryIsHere = () => existsSync(REGISTRY);

/**
 * The skip reason for a test that reads these registry files, or false when all of them are here.
 * Shaped for node:test's `skip` option: `test(name, { skip: registryMissing('x.json') }, fn)`.
 */
export function registryMissing(...files) {
  if (!registryIsHere()) return `../registry is not here: this test reads ${files.join(', ')}`;
  const absent = files.filter((f) => !existsSync(registryPath(f)));
  return absent.length ? `../registry has no ${absent.join(', ')}: this test reads it` : false;
}
