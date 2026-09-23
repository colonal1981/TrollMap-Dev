import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { LAKE_CLARITY_PROFILES, lakeKeyFromName } from '../Worker/worker-data.js';

// ---------------------------------------------------------------------------
// Why this test exists
//
// Ryan, 2026-09-23, told that running build_lake_drainage.py would improve the
// per-zone `sensitivity` constant: "that doesn't sound right at all for
// clarity..." He was right, and the constant was the wrong thing to look at.
//
//     score       = base + rainScore * sensitivity
//     normalScore = base
//
// `base` is a measured Secchi or turbidity baseline off the WQP, cached in R2
// and refreshed on a 30-day cron. It moves over months. `rainScore` is the ONLY
// input that describes TODAY -- and it was read at `profile.center`, which for
// any water without one of the SIX hand-authored profiles was the literal
// [34, -81]: a fixed point near Columbia, SC. Coastal zones got Charleston.
//
// Measured over the 196 bound waters with a centroid and no custom profile:
//
//     >  50 km from [34, -81]    191 of 196
//     > 150 km                   156
//     median                     226 km
//     norris_lake 366 · fort_loudoun 346 · tellico 341 · holston 336
//     his own: cooper_river 142 · santee 122 · diversion_canal 107
//
// The point was in scope at the caller the whole time: /conditions hands lat/lon
// to tideBlock() a few lines above the clarity call and returns them as `point`.
// ---------------------------------------------------------------------------

const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

describe('the clarity model reads rain at the water it is describing', () => {
  it('/conditions passes its own point to getLakeClarity', () => {
    const s = src('Worker/conditions.js');
    expect(/getLakeClarity\(nm, date, env, \{ lat, lon \}\)/.test(s)).toBe(true);
  });

  it('/lake-clarity forwards a point when it is given one', () => {
    const s = src('Worker/trollmap-worker.js');
    expect(/getLakeClarity\(name, dateParam, env, clPoint\)/.test(s)).toBe(true);
  });

  it('both app callers of /lake-clarity send lat and lon', () => {
    for (const f of ['js/modules/plan-preflight.js', 'js/modules/lake-intel.js']) {
      const s = src(f);
      // The first mention of the route is a comment in one of these files, so take the URL that
      // is actually built rather than the first match.
      const i = s.indexOf('`${worker}/lake-clarity');
      expect(i > 0).toBe(true);
      expect(/lat=\$\{Number\(/.test(s.slice(i, i + 700))).toBe(true);
    }
  });

  it('the fixed centres survive ONLY as a fallback behind the caller point', () => {
    const s = src('Worker/worker-data.js');
    // Near Columbia, and Charleston. Each must now read `at || [...]`.
    expect(/center: at \|\| \[34, -81\]/.test(s)).toBe(true);
    expect(/center: at \|\| \[32\.77, -79\.93\]/.test(s)).toBe(true);
    // And a bare `center: [34, -81]` must not come back.
    expect(/center: \[34, -81\]/.test(s)).toBe(false);
  });

  it('says where the rain was measured, so this cannot hide again', () => {
    const s = src('Worker/worker-data.js');
    expect(/rainPoint:\s*\{/.test(s)).toBe(true);
    expect(/NOT THIS WATER/.test(s)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AND THE REASON HE THOUGHT IT WAS MORE THAN SIX LAKES. He said: "i am also
// pretty sure it is on more than 6 lakes... but maybe i just thought that."
//
// Four sibling tables in one file disagree about which waters are curated:
//
//     LAKE_CLARITY_PROFILES        6   wateree murray marion moultrie keowee hartwell
//     LAKE_INTEL                   9   + thurmond russell jocassee
//     LAKE_INTEL_SOURCE_REGISTRY  11   + norman, + default
//     lakeKeyFromName aliases     14   + monticello greenwood secession wylie
//
// So eight names the alias table goes to the trouble of resolving have no
// clarity profile to resolve TO. Recorded rather than fixed: writing eight
// profiles is a fishing judgement about eight lakes and it is Ryan's, not mine.
// ---------------------------------------------------------------------------

describe('which waters are curated, counted rather than remembered', () => {
  const CURATED = ['wateree', 'murray', 'marion', 'moultrie', 'keowee', 'hartwell'];

  it('there are six clarity profiles and these are they', () => {
    expect(Object.keys(LAKE_CLARITY_PROFILES).sort()).toEqual([...CURATED].sort());
  });

  it('names the alias table resolves that have no clarity profile behind them', () => {
    // If a profile is written for one of these, it drops out of this list. That is the point:
    // the gap is counted here rather than remembered.
    const orphans = ['monticello', 'greenwood', 'secession', 'jocassee', 'thurmond',
                     'russell', 'wylie', 'norman']
      .filter((k) => !LAKE_CLARITY_PROFILES[k]);
    expect(orphans.length).toBe(8);
  });

  it('a curated lake still resolves through its alias', () => {
    expect(lakeKeyFromName('Lake Wateree (Kershaw Co, SC)')).toBe('wateree');
    expect(lakeKeyFromName('Clarks Hill / J Strom Thurmond')).toBe('thurmond');
  });

  it('an un-aliased name falls back to its first word, which is usually `lake`', () => {
    // Not a defect to fix here -- both remaining consumers try the full sanitized name first and
    // use the key only as a second chance -- but it is why a key is never a water's identity.
    expect(lakeKeyFromName('Lake Juliette')).toBe('lake');
    expect(lakeKeyFromName('Congaree River')).toBe('congaree');
  });
});
