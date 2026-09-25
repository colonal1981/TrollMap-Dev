/**
 * registry-here.test.js -- a registry that is on disk is never reported missing.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * On 2026-09-24 three smoke checks built their path with URL.pathname, which on Windows is
 * "/F:/...", and printed SKIP on the ONLY machine that has the registry. Every registry test now
 * skips through registry-here.mjs, so the same slip there would hide all of them at once, on the
 * one run that matters, and still come out green.
 *
 * This asks the disk by a different road -- a file: URL handed straight to existsSync, which node
 * turns into a path correctly on every platform -- and fails if the file is there and the helper
 * says it is not. In the cloud the file is absent and this passes. On Ryan's machine it is present,
 * found, and this passes. It fails only when the helper's path logic breaks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { REGISTRY, registryPath, registryIsHere, registryMissing } from './registry-here.mjs';

const ON_DISK = existsSync(new URL('../../registry/lake_index.json', import.meta.url));

test('a lake_index.json that is on disk is not reported missing', () => {
  if (!ON_DISK) return;   // nothing on disk, so there is nothing the helper could hide
  assert.equal(registryIsHere(), true, `the helper looked for the registry at ${REGISTRY}`);
  assert.equal(registryMissing('lake_index.json'), false,
    `lake_index.json is on disk and the helper looked for it at ${registryPath('lake_index.json')}`);
});

test('the helper and the disk agree either way', () => {
  assert.equal(existsSync(registryPath('lake_index.json')), ON_DISK);
});

test('a missing registry says which file the test reads', () => {
  const why = registryMissing('no_such_registry_file.json');
  assert.equal(typeof why, 'string');
  assert.match(why, /no_such_registry_file\.json/);
});
