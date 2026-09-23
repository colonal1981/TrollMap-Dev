/**
 * test/a-reply-with-nothing-in-it-was-saved-as-three-fish.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * 2026-09-23, the 33-river research batch, Nolichucky River, TN. No species roster anywhere, so
 * the fisheries agent took discover mode: five documents, ten facts, and no agency source naming a
 * fish. Rule C of the discover prompt says exactly what to do then -- return
 * `"speciesFound": []` and `"trollingIntelligence": {}` -- and the model did.
 *
 * The section pick read `parsed.trollingIntelligence` only when it had keys and otherwise fell
 * back to the WHOLE reply. The normaliser then gave each top-level key four null seasons, and
 * the profile was saved with:
 *
 *     trollingIntelligence: { lakeForage: {...nulls}, speciesFound: {...nulls},
 *                             trollingIntelligence: {...nulls}, sources: [...] }
 *
 * research_lakes.py's empty-section guard did not fire, because the section was not empty. Run
 * through the app's own speciesGroupsFor() the same evening, the planner's species picker on the
 * Nolichucky offered "Striped Bass | lakeForage | speciesFound | trollingIntelligence | sources"
 * -- and nothing else. The control, the same river with no profile, offers 35 fish.
 *
 * The reply is not stored; the replies below are that reply's SHAPE, read back off what was saved.
 *
 *   node --test test/a-reply-with-nothing-in-it-was-saved-as-three-fish.test.js
 */
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import {
  pickAgentSection, fisheriesSection, FISHERIES_ENVELOPE_KEYS,
} from '../Worker/research/agents.js';

const NOLICHUCKY_REPLY = {
  lakeForage: { primary: [], secondary: [] },
  speciesFound: [],
  trollingIntelligence: {},
  sources: [{ label: 'Derived from lake profile and source documents', trust: 'DERIVED' }],
};

const SEASON = { preferredDepth: [8, 15], holding: null, waterDepthFt: null, sourceQuote: null,
                 structures: [], forage: [], recommendedPresentations: [], notes: null };

describe('the empty answer stays empty', () => {
  it('the Nolichucky reply gives no section at all', () => {
    expect(fisheriesSection(NOLICHUCKY_REPLY, 'fisheries')).toEqual({});
  });

  it('none of the reply fields can come back as a fish, from any reply', () => {
    const replies = [
      NOLICHUCKY_REPLY,
      { ...NOLICHUCKY_REPLY, trollingIntelligence: undefined },
      { note: 'no agency source names a fish', speciesFound: [], lakeForage: {} },
    ];
    for (const r of replies) {
      const keys = Object.keys(fisheriesSection(r, 'fisheries'));
      for (const k of FISHERIES_ENVELOPE_KEYS) expect(keys.includes(k)).toBe(false);
    }
  });

  it('the list is the one the prompt writes beside the section', () => {
    // If the prompt grows a new sibling field, this list has to grow with it, or that field
    // becomes a fish the first time a model leaves the section empty.
    const src = readFileSync(new URL('../Worker/research/agents.js', import.meta.url), 'utf8');
    for (const k of ['lakeForage', 'speciesFound', 'trollingIntelligence']) {
      expect(src.includes(`"${k}":`)).toBe(true);
      expect(FISHERIES_ENVELOPE_KEYS.includes(k)).toBe(true);
    }
  });
});

describe('what was already right is unchanged', () => {
  it('a wrapped section is the section', () => {
    const reply = { speciesFound: [], lakeForage: {},
                    trollingIntelligence: { 'Smallmouth Bass': { summer: SEASON } } };
    expect(Object.keys(fisheriesSection(reply, 'fisheries'))).toEqual(['Smallmouth Bass']);
  });

  it('an unwrapped reply is still read as the section, with the reply fields taken off it', () => {
    // The case the fallback was written for: the model forgets the wrapper.
    const reply = { 'Smallmouth Bass': { summer: SEASON }, lakeForage: { primary: ['Crayfish'] },
                    speciesFound: [{ species: 'Smallmouth Bass' }], sources: [] };
    expect(Object.keys(fisheriesSection(reply, 'fisheries')).sort())
      .toEqual(['Smallmouth Bass', 'sources']);
  });

  it('the section under the agent name is still accepted', () => {
    const reply = { fisheries: { 'Rainbow Trout': { spring: SEASON } } };
    expect(Object.keys(fisheriesSection(reply, 'fisheries'))).toEqual(['Rainbow Trout']);
  });
});

describe('pickAgentSection, for the agents that are not fisheries', () => {
  it('a named empty section is an empty answer, not the whole reply', () => {
    expect(pickAgentSection({ regulations: {}, sources: [] }, 'regulations', 'regulations')).toEqual({});
  });

  it('a reply naming neither key is read as unwrapped', () => {
    const reply = { lakeSpecificRegulations: { creelLimits: {} } };
    expect(pickAgentSection(reply, 'regulations', 'regulations')).toEqual(reply);
  });

  it('a reply that is not an object is no section', () => {
    expect(pickAgentSection(null, 'x', 'x')).toEqual({});
    expect(pickAgentSection([1, 2], 'x', 'x')).toEqual({});
  });
});

describe('both fisheries paths use the one pick', () => {
  const code = readFileSync(new URL('../Worker/research/agents.js', import.meta.url), 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  it('the grouped path and the single-shot path both call fisheriesSection', () => {
    expect((code.match(/fisheriesSection\(parsed, agentKey\)/g) || []).length).toBe(2);
  });

  it('the fall-through to the whole reply is gone', () => {
    expect(code.includes('parsed.trollingIntelligence || parsed[agentKey] || parsed')).toBe(false);
    expect(code.includes('Object.keys(parsed[agentKey] || {}).length > 0) ? parsed[agentKey] : parsed')).toBe(false);
  });
});

describe('the script keeps the same list to clean what was already saved', () => {
  it('research_lakes.py AGENT_ENVELOPE_KEYS equals FISHERIES_ENVELOPE_KEYS', () => {
    const py = readFileSync(new URL('../Scripts/research_lakes.py', import.meta.url), 'utf8');
    const m = py.match(/^AGENT_ENVELOPE_KEYS\s*=\s*\(([^)]*)\)/m);
    expect(Boolean(m)).toBe(true);
    const list = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    expect([...list].sort()).toEqual([...FISHERIES_ENVELOPE_KEYS].sort());
  });
});
