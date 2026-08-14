import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(path.join(REPO, 'js/modules/lake-ramp-select.js'), 'utf8');

// ---------------------------------------------------------------------------
// Why this test exists
//
// Ryan sent a screenshot of "Lakes / Reservoirs (483)" containing Catawba
// River, Congaree River, Edisto River and Great Pee Dee River -- all
// feature_type "river" in his own registry -- alongside Adams Grist Mill
// Lake, Biggin Creek and Buggy Branch, which have no registry row at all and
// were showing while a size filter was set.
//
// Two defects, and they compound:
//   1. registryRecordFor() was an exact string lookup, so a lake that IS in
//      the registry could come back as null
//   2. a null record passed every filter -- `if (!rec) return true`
//
// So a lookup miss became an unfilterable entry. This is the SECOND report of
// the filter bar not working; the first is recorded in access-index.js's
// pass-1 note. Which is why the behaviour is pinned here rather than left to
// the next screenshot.
// ---------------------------------------------------------------------------

// The module reaches window/document at import time via its dependency graph, so the two pure
// decisions are re-implemented from the SOURCE OF TRUTH constants rather than imported. Anything
// asserted here that drifts from the file shows up as a source assertion below.
const RIVERISH = /\b(river|creek|branch|run|fork|canal|slough|bayou|prong|swamp)\b/i;
const stateOf = (name, rec) => rec?.state
  || (/,\s*([A-Z]{2})\s*$/.exec(String(name || '')) || [])[1] || null;

describe('the picker groups by state, then by water type', () => {
  it('orders states SC, NC, GA, TN', () => {
    // Ryan, 2026-08-08, asked directly. SC first because that is where he fishes.
    expect(SRC.includes("STATE_ORDER = ['SC', 'NC', 'GA', 'TN']")).toBe(true);
  });

  it('orders lakes, then rivers, then coast inside each state', () => {
    expect(SRC.includes("[['lake', 'Lakes'], ['river', 'Rivers'], ['coastal', 'Coast']]")).toBe(true);
  });

  it('reads feature_type off the registry rather than guessing at a name', () => {
    const reg = readFileSync(path.join(REPO, 'js/data/lake-registry.js'), 'utf8');
    expect(reg.includes('featureType: rec.feature_type')).toBe(true);
    expect(SRC.includes('rec?.featureType')).toBe(true);
  });

  it('no longer heads a mixed list "Lakes / Reservoirs"', () => {
    // The label in the screenshot. It said "Lakes" over five rivers.
    //
    // Comments are stripped first. The first version of this assertion grepped the whole file
    // and failed on the comment explaining the fix -- which is precisely the failure mode
    // DELETION_TAB records as having cost four deploys on 2026-08-04.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    expect(code.includes('Lakes / Reservoirs')).toBe(false);
    expect(code.includes('grp.label = `${stateCode} — ${typeLabel}')).toBe(true);
  });

  it('folds coastal zones under their state instead of appending them', () => {
    expect(SRC.includes('coastalNamesByState')).toBe(true);
    expect(SRC.includes('appendCoastalOptgroups')).toBe(false);
  });
});

describe('a state can be worked out for any entry, registry row or not', () => {
  it('prefers the registry', () => {
    expect(stateOf('Anything, NC', { state: 'SC' })).toBe('SC');
  });

  it('falls back to the suffix every DNR name carries', () => {
    // displayLakeName() appends ", SC" to every waterbody from a per-state feed.
    expect(stateOf('Buggy Branch, SC')).toBe('SC');
    expect(stateOf('PAMLICO SOUND, NC')).toBe('NC');
    expect(stateOf('Winyah Bay / Georgetown, SC')).toBe('SC');
  });

  it('returns null rather than guessing when there is no signal', () => {
    // These land in an "Other" group instead of being silently dropped.
    expect(stateOf('Some Pond')).toBe(null);
    expect(stateOf('')).toBe(null);
  });
});

describe('the name heuristic only runs when the registry has nothing', () => {
  it('calls the obvious ones rivers', () => {
    for (const n of ['Enoree River, SC', 'Biggin Creek, SC', 'Buggy Branch, SC',
                     'Horseshoe Creek, SC', 'Congaree Creek, SC']) {
      expect(RIVERISH.test(n)).toBe(true);
    }
  });

  it('leaves lakes alone', () => {
    for (const n of ['Adams Grist Mill Lake, SC', 'Broadway Lake, SC',
                     'Andrew Jackson State Park Lake, SC', 'HB Robinson Lake (Darlington Co, SC)']) {
      expect(RIVERISH.test(n)).toBe(false);
    }
  });

  it('is a display grouping and says so', () => {
    // If this ever starts being treated as data, the comment is the thing that stops it.
    expect(SRC.includes('display grouping, not a')).toBe(true);
  });
});

describe('a filter an entry cannot answer now excludes it', () => {
  it('no longer passes everything without a registry record', () => {
    expect(SRC.includes('if (!rec) return true;')).toBe(false);
  });

  it('excludes unknown-size entries from a size band', () => {
    expect(SRC.includes('if (f.size || f.wellCharted) return false;')).toBe(true);
  });

  it('still answers state and ramps for them, because both are knowable', () => {
    // State from the suffix; ramps from the live access index, which is the same data the
    // Access dropdown under it is built from.
    //
    // Was an inline `pts.some((p) => /ramp/i.test(p.typeLabel || ''))` here, and a second copy
    // of the same regex in lakeBadge(), and nothing at all in the filter for entries that DO
    // have a registry record. Three readings of one fact, and the one that mattered read a
    // baked file. They all go through liveAccessFor() now — see
    // test/live-ramps-reach-the-filter.test.js.
    expect(SRC.includes("if (f.state && stateOf(lakeName, rec) !== f.state) return false;")).toBe(true);
    expect(SRC.includes('liveAccessFor(lakeName).ramps > 0')).toBe(true);
  });

  it('asks the live index for the has-ramp box even when a registry row exists', () => {
    // THE ROW THAT HAS A RECORD IS THE ONE THAT WAS WRONG. `rec.rampSources` is baked into
    // lake_access.json and reads 0 on 67 waters the DNR feeds list ramps for — every river
    // Ryan asked about among them. `rampSources` stays as the OR, never as the AND.
    expect(SRC.includes('if (f.rampOnly && !rec.rampSources) return false;')).toBe(false);
    expect(SRC.includes('liveAccessFor(lakeName).ramps || rec.rampSources')).toBe(true);
  });
});

describe('the registry lookup tolerates the names the picker actually offers', () => {
  const IDX = readFileSync(path.join(REPO, 'js/data/access-index.js'), 'utf8');

  it('is no longer a bare exact-match Map get', () => {
    expect(IDX.includes('return accessIndex.registryByName?.get(lakeName) || null;')).toBe(false);
    expect(IDX.includes('normalizeRegistryKey')).toBe(true);
  });

  it('folds only punctuation, case and the state suffix', () => {
    // Deliberately NOT the water-type word and NOT token order: SC has two Lake Wallaces, and
    // "Lake Wallace" and "Wallace Lake" are different waters.
    const norm = (name) => String(name || '').toLowerCase()
      .replace(/\(([^)]*)\)/g, ' ').replace(/,\s*[a-z]{2}\s*$/, ' ')
      .replace(/[^a-z0-9]+/g, ' ').trim();
    expect(norm('Broadway Lake, SC')).toBe(norm('Broadway Lake'));
    expect(norm('HB Robinson Lake (Darlington Co, SC)')).toBe(norm('HB Robinson Lake'));
    expect(norm('Lake Wallace') === norm('Wallace Lake')).toBe(false);
    expect(norm('Norris Lake') === norm('Norris Reservoir')).toBe(false);
  });
});
