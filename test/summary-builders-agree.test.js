import { readFileSync } from 'node:fs';
import { describe, it, expect } from './expect-shim.mjs';
import { buildFactualSummary, sampleDated, hasResearchValue } from '../Worker/research/facts-util.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE SENTENCE MUST NOT OUTLIVE THE NUMBERS IT STATES
//
// `summary.text` is a deterministic restatement of identity + biology + limnology + habitat, and
// `researchIntel()` hands it to the model — so it is the copy of those numbers that reaches a
// plan. It exists twice: `buildFactualSummary` in the Worker and `buildDeterministicSummary` in
// `js/modules/lake-research-engine.js`, because a browser cannot import a Worker module. Since
// 2026-08-24 `handleResearchSave` rebuilds the stored sentence with the Worker's copy while the
// app builds the one it shows with the client's, so a wording drift between them would rewrite
// every profile's summary on every save and show the user a different sentence from the one on
// disk. The client's source is READ here, not paraphrased.
//
// The profile below is Fishing Creek Reservoir (Lancaster Co, SC) v7.0 as actually saved on
// 2026-08-24 — the run that fixed maxDepthFt 100 -> 39 and averageDepthFt 1015 -> 12.1 and left
// the sentence saying 3,431 acres and 100 feet.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const ENGINE = readFileSync(new URL('../js/modules/lake-research-engine.js', import.meta.url), 'utf8');

/** The client's builder, lifted from its own source so a change there fails here. */
function clientBuilder() {
  const body = /function buildDeterministicSummary\(profile\)\s*\{([\s\S]*?)\n\}/.exec(ENGINE);
  expect(Boolean(body)).toBe(true);
  // `_state` is the module's mutable singleton; only `_state.currentLakeName` is read, and only
  // when the profile carries no lakeName.
  // eslint-disable-next-line no-new-func
  const fn = new Function('profile', '_state', 'sampleDated', 'hasResearchValue', body[1]);
  return (profile) => fn(profile, { currentLakeName: null }, sampleDated, hasResearchValue);
}

const FISHING_CREEK = {
  lakeName: 'Fishing Creek Reservoir, SC',
  identity: {
    archetype: 'large hydroelectric reservoir',
    surfaceAreaAcres: 2170,
    maxDepthFt: 39,
    averageDepthFt: 12.1,
  },
  biology: {
    predatorSpecies: ['Largemouth Bass', 'Bluegill', 'Black Crappie', 'Blue Catfish', 'Striped Bass'],
    knownStockings: [{ species: 'Striped Bass', frequency: 'Annually' }],
  },
  limnology: {
    waterClarity: { secchiFt: '0.8 to 2.5' },
    surfaceWater: { recentTempF: 69.69, recentDissolvedOxygenMgL: 8.39, lastObserved: '2026-05-05' },
    thermocline: { summerDepthFt: null },
  },
  habitat: {
    // A STRING, not an array. This is what the deterministic path writes.
    cover: 'fish attractors, logjams',
    artificialHabitatDetails: { attractorCount: 5, attractorTypes: ['brush/trees'] },
    structuralElements: {
      points: 'several prominent shoreline points visible in boundary geometry',
      creekArms: 'multiple creek arms / embayments visible in boundary geometry',
      channelLedges: 'mid-depth contour density indicates multiple ledges / drop-offs',
      humps: 'multiple closed contour loops suggest several offshore humps or high spots',
    },
  },
};

describe('the stored summary states the numbers the profile states', () => {
  it('reads maxDepthFt and surfaceAreaAcres out of identity, not out of the old sentence', () => {
    const text = buildFactualSummary(FISHING_CREEK);
    expect(text.includes('a maximum depth near 39 feet')).toBe(true);
    expect(text.includes('about 2,170 surface acres')).toBe(true);
    expect(text.includes('100 feet')).toBe(false);
    expect(text.includes('3,431')).toBe(false);
  });

  it('A STRING HAS .length AND NO .join — habitat.cover must not throw', () => {
    // `hab.cover.slice(0, 4).join(', ')` on the string above threw a TypeError and took the
    // whole summary with it. Fourth field in this family.
    const text = buildFactualSummary(FISHING_CREEK);
    expect(text.includes('cover includes fish attractors, logjams')).toBe(true);
  });

  it('keeps the structure clause, which is the only part that says what the CHART holds', () => {
    const text = buildFactualSummary(FISHING_CREEK);
    expect(text.includes('mapped structure includes points, creekArms, channelLedges, humps')).toBe(true);
  });

  it('emits no habitat sentence at all rather than an empty one', () => {
    const bare = { ...FISHING_CREEK, habitat: { notes: 'a note and nothing else' } };
    const text = buildFactualSummary(bare);
    expect(text.includes('Habitat facts currently confirm')).toBe(false);
  });

  it('returns null when there is nothing to say', () => {
    expect(buildFactualSummary({ lakeName: 'Nowhere' })).toBe(null);
  });
});

describe('the two builders agree word for word', () => {
  const theirs = clientBuilder();
  const cases = [
    ['the live Fishing Creek shape', FISHING_CREEK],
    ['no archetype', { ...FISHING_CREEK, identity: { surfaceAreaAcres: 2170, maxDepthFt: 39 } }],
    ['depth but no acreage', { ...FISHING_CREEK, identity: { archetype: 'reservoir', maxDepthFt: 39 } }],
    ['an array cover', { ...FISHING_CREEK, habitat: { ...FISHING_CREEK.habitat, cover: ['brush', 'riprap'] } }],
    ['a thermocline range', {
      ...FISHING_CREEK,
      limnology: { ...FISHING_CREEK.limnology, thermocline: { summerDepthFt: [16, 22] } },
    }],
    ['a dated surface sample', {
      ...FISHING_CREEK,
      limnology: {
        ...FISHING_CREEK.limnology,
        surfaceWater: { recentTempF: 85.5, recentTempLastObserved: '2026-08-21', lastObserved: '2026-05-05' },
      },
    }],
    ['nothing at all', { lakeName: 'Nowhere' }],
  ];
  for (const [label, profile] of cases) {
    it(`${label}`, () => {
      expect(buildFactualSummary(profile)).toBe(theirs(profile));
    });
  }
});
