// Personal use only, not for distribution or resale; not for navigation.
//
// A `-site:` EXCLUSION IS NOT A `site:` PIN.
//
// discover.js appends the spelled-out state to an open-web query unless the query already pins a
// site. The check was /\bsite:/, which also matches "-site:facebook.com", so every lake fisheries
// query went out without its state.
//
//   node --test test/a-site-exclusion-is-not-a-site-pin.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryPinsSite } from '../Worker/research/discover.js';

test('exclusions do not pin the query, so the state is added', () => {
  assert.equal(queryPinsSite('"Lake Murray" fishing report -site:facebook.com -site:youtube.com'), false);
  assert.equal(queryPinsSite('"Lake Murray" seasonal fishing patterns bass crappie striped bass'), false);
});

test('a site: operator still pins it, wherever it sits', () => {
  assert.equal(queryPinsSite('site:dnr.sc.gov "Lake Murray" fish'), true);
  assert.equal(queryPinsSite('"Lake Murray" fish site:dnr.sc.gov'), true);
  assert.equal(queryPinsSite('"Lake Murray" SITE:dnr.sc.gov -site:facebook.com'), true);
});
