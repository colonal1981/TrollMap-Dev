import { describe, it, expect } from './expect-shim.mjs';

/**
 * A ROSTER OF ONE IS A GAP, AND IT USED TO READ AS FILLED.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * handleResearchGapAnalysis decides which fields get a targeted search. Its `check` asks only
 * whether a value is empty, so `["Largemouth Bass"]` counted as a complete species list and the
 * gap query written for exactly that case never ran.
 *
 * Ryan, 2026-09-04: "i don't think there is any lake that only has 1 species of game fish."
 *
 * Lake Greenwood is the water that exposed it — 10,363 acres, 97% charted, five ramps, sixteen
 * fish attractors, and one fish in its profile since version 17. Parr Shoals (10 species) and
 * Monticello (12) were sampled to confirm this is an outlier rather than the normal state.
 *
 * The handler needs a Worker environment and a dynamic import of discover.js, so what is tested
 * here is the RULE, held identical to the source. If the source changes and this does not, the
 * last assertion fails.
 */

const SRC = new URL('../Worker/research/extract.js', import.meta.url);

/** The rule as the handler applies it: empty is a gap, and so is a roster of one. */
function isGap(predatorSpecies) {
  const val = predatorSpecies;
  const empty = val === null || val === undefined || val === ''
    || (Array.isArray(val) && !val.length)
    || (typeof val === 'object' && !Array.isArray(val) && !Object.keys(val).length);
  return empty || (Array.isArray(val) && val.length === 1);
}

describe('which species lists get a second search', () => {
  it('AN EMPTY ROSTER IS A GAP, which it always was', () => {
    expect(isGap([])).toBe(true);
    expect(isGap(null)).toBe(true);
    expect(isGap(undefined)).toBe(true);
  });

  it('A ROSTER OF ONE IS A GAP, which is the change', () => {
    // Lake Greenwood, version 17.
    expect(isGap(['Largemouth Bass'])).toBe(true);
  });

  it('a real roster is left alone', () => {
    // Parr Shoals, version 19 — and the smallmouth no registry file holds.
    expect(isGap(['Largemouth Bass', 'Smallmouth Bass', 'White Crappie', 'Blue Catfish',
                  'Channel Catfish', 'Flathead Catfish', 'Bluegill',
                  'Redear Sunfish (Shellcracker)', 'Redbreast Sunfish', 'Pumpkinseed'])).toBe(false);
  });

  it('TWO IS LEFT ALONE, because nobody said two was too few', () => {
    // Thin on ten thousand acres, certainly. But the claim encoded here is the one that was
    // made, and picking a bigger number would be inventing a threshold and then writing a
    // comment to justify it.
    expect(isGap(['Largemouth Bass', 'Bluegill'])).toBe(false);
  });

  it('THE RULE ABOVE IS THE RULE IN THE SOURCE', async () => {
    // A rule copied into a test drifts from the code it describes. This reads the handler and
    // fails if the length check is edited or removed without this file being updated.
    const src = await (await import('node:fs/promises')).readFile(SRC, 'utf8');
    expect(src.includes('bio.predatorSpecies.length === 1')).toBe(true);
    expect(src.includes("nullFields.push('biology.predatorSpecies')")).toBe(true);
    // and the gap query it unlocks still exists
    expect(src.includes('"biology.predatorSpecies"')).toBe(true);
  });
});
