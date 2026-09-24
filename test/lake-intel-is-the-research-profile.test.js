/**
 * test/lake-intel-is-the-research-profile.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * LAKE_INTEL -- nine hand-written lake profiles -- was ruled redundant on 2026-08-15 ("lake intel
 * should have been replaced by the research pipeline") and was still imported on 2026-09-23 (the
 * register's lake-intel-still-imported). It went on 2026-09-24. Two things are pinned here:
 *
 *   1. Nothing curated is served any more: a lake's intel is the live context plus its research
 *      profile, and the checklist stands in only where there is no research.
 *   2. The one thing LAKE_INTEL was quietly doing -- naming the LakeMonster page -- is done by
 *      LakeMonster's own page path, which also fixes the two of five that never resolved.
 *
 *   node --test test/lake-intel-is-the-research-profile.test.js
 */
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';

const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

// Every outbound fetch is answered with a page shaped like LakeMonster's REAL one, and recorded.
// Fetched 2026-09-24: the body is drawn by script, so after the tags and scripts are stripped the
// temperature survives only in the title. A stub with the number in the body is how the scrape
// looked fine in a test while returning null for every lake live.
const asked = [];
globalThis.fetch = async (url) => {
  asked.push(String(url));
  const html = '<html><head><title>Lake Murray Water Temp Today: 76°F | LakeMonster</title>'
    + '<script>window.__DATA__ = {"waterTemp": 76}</script></head>'
    + '<body><div id="root"></div></body></html>';
  return { ok: true, status: 200, text: async () => html, json: async () => ({}) };
};

const W = await import('../Worker/worker-data.js');

describe('LAKE_INTEL is gone and nothing curated is served', () => {
  it('the table is not exported and no Worker file imports it', () => {
    expect('LAKE_INTEL' in W).toBe(false);
    expect(/\bLAKE_INTEL\b\s*,/.test(src('../Worker/trollmap-worker.js'))).toBe(false);
    expect(/^var LAKE_INTEL = \{/m.test(src('../Worker/worker-data.js'))).toBe(false);
  });
  it('a lake that had a curated profile now gets the checklist, marked unverified', async () => {
    asked.length = 0;
    const d = await W.getLakeIntel('Lake Wateree');
    expect(d.confidence).toBe('generic_unverified_profile');
    expect(d.profile.primarySportFish).toEqual([]);
    // The live context is untouched: the source registry and the LakeMonster read still arrive.
    expect(!!d.sourceRegistry).toBe(true);
    expect(d.lakeMonster && d.lakeMonster.waterTemp_F).toBe(76);
  });
  it('lake-intel.js reads the research profile first for every block that fell back to it', () => {
    const js = src('../js/modules/lake-intel.js');
    expect(js.includes('if(rp?.biology)')).toBe(true);
    expect(js.includes('if(rp?.habitat)')).toBe(true);
    expect(js.includes('if(rp?.trollingIntelligence)')).toBe(true);
  });
});

describe('LakeMonster is asked for its own page', () => {
  const want = {
    wateree: 'https://lakemonster.com/lake/South-Carolina/Lake-Wateree-1072',
    murray: 'https://lakemonster.com/lake/South-Carolina/Lake-Murray-1071',
    keowee: 'https://lakemonster.com/lake/South-Carolina/Lake-Keowee-1068',
    // The two the guessed URL never reached: Hartwell is filed under Georgia, Norman under NC.
    hartwell: 'https://lakemonster.com/lake/Georgia/Lake-Hartwell-1029',
    norman: 'https://lakemonster.com/lake/North-Carolina/Lake-Norman-232',
  };
  for (const [key, url] of Object.entries(want)) {
    it(`${key} -> ${url.split('/lake/')[1]}`, async () => {
      asked.length = 0;
      const got = await W.fetchLakeMonsterIntel(key);
      expect(asked).toEqual([url]);
      expect(got.source).toBe(url);
      expect(got.waterTemp_F).toBe(76);
    });
  }
  it('a lake with no LakeMonster page asks nothing', async () => {
    asked.length = 0;
    expect(await W.fetchLakeMonsterIntel('jocassee')).toBe(null);
    expect(asked).toEqual([]);
  });
});
