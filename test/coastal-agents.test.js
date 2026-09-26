import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isCoastalZone } from '../Worker/research/coastal-agents.js';
import { RESEARCH_AGENTS } from '../Worker/research/agents.js';
import { WATER_TYPE_HINTS, waterTypeHint } from '../Worker/research/water-type-hints.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentsSrc = readFileSync(path.join(REPO, 'Worker/research/agents.js'), 'utf8');
const discoverSrc = readFileSync(path.join(REPO, 'Worker/research/discover.js'), 'utf8');

// THE SIX AGENTS NOTHING RAN WERE DELETED ON 2026-09-25: identity, navigation and regulations,
// and the coastal estuary, tidal and saltwater_regulations. Two describe blocks of prompt tests
// stood here for the coastal three, and two more further down for their plan and their discovery
// queries. What is asserted now is that none of the six comes back.
describe('the six agents nothing ran stay gone', () => {
  const SIX = ['identity', 'navigation', 'regulations', 'estuary', 'tidal', 'saltwater_regulations'];
  it('RESEARCH_AGENTS defines none of them', () => {
    for (const k of SIX) expect(RESEARCH_AGENTS[k], `${k} is back in RESEARCH_AGENTS`).toBeUndefined();
  });
  it('discover.js has no query table for any of them', () => {
    for (const k of SIX) {
      expect(new RegExp(`^  ${k}:\\s*\\{`, 'm').test(discoverSrc), `${k} queries are back`).toBe(false);
    }
  });
});

describe('the water gets framed for what it is', () => {
  // WHAT THIS REPLACED, AND WHY IT IS WORTH READING. The four tests here used to assert
  // `Object.keys(COASTAL_AGENT_HINTS).sort()` was `['biology','habitat']` and that agents.js
  // CONTAINED the string 'COASTAL_AGENT_HINTS[agentKey]'. Both agents were retired on
  // 2026-09-01. The hint could not reach any agent that runs, every coastal research pass used
  // the freshwater prompt, and all four tests stayed green -- because they described the file
  // instead of exercising it. DELETION_TAB.md lists that shape; this is what it costs.
  //
  // The first test below is the one that would have caught it, and it is derived rather than
  // typed: every agent a hint is keyed on must be an agent that actually exists.
  it('EVERY HINT IS KEYED ON AN AGENT THAT RUNS', () => {
    const live = new Set(Object.keys(RESEARCH_AGENTS));
    const dead = [];
    for (const [waterType, byAgent] of Object.entries(WATER_TYPE_HINTS)) {
      for (const agentKey of Object.keys(byAgent)) {
        if (!live.has(agentKey)) dead.push(`${waterType}.${agentKey}`);
      }
    }
    expect(dead.join(', ')).toBe('');
  });

  it('a coastal zone gets estuary framing on the agent that runs there', () => {
    // fisheries is the one agent the Worker defines, and it is this one.
    expect(Object.keys(RESEARCH_AGENTS)).toEqual(['fisheries']);
    const h = waterTypeHint('coastal', 'fisheries');
    expect(h).toMatch(/marsh edges/i);
    expect(h).toMatch(/oyster/i);
    expect(h).toMatch(/Do NOT report brush piles/i);
    expect(h).toMatch(/shrimp/i);
    expect(h).toMatch(/mullet/i);
    expect(h).toMatch(/NOT threadfin or gizzard shad/i);
    expect(h).toMatch(/cold-stun/i);
  });

  it('a river gets moving-water framing and is told what a river is not', () => {
    const h = waterTypeHint('river', 'fisheries');
    expect(h).toMatch(/discharge/i);
    expect(h).toMatch(/cfs/);
    expect(h).toMatch(/current seams/i);
    expect(h).toMatch(/do NOT report a[\s\S]{0,40}thermocline/i);
    expect(h).toMatch(/no full pool/i);
    // The eleven tidal rivers are named, because on those both flow and tide apply.
    expect(h).toMatch(/Cooper/);
  });

  it('the retired agent keys do not come back', () => {
    // `habitat` and `biology` are the keys the dead table used. A hint under either would be
    // unreachable again and would look like coverage again.
    for (const waterType of Object.keys(WATER_TYPE_HINTS)) {
      expect(waterTypeHint(waterType, 'habitat')).toBe('');
      expect(waterTypeHint(waterType, 'biology')).toBe('');
    }
  });

  it('a lake gets no hint at all, and junk never throws', () => {
    // A reservoir is what the base prompts were written for; framing it would be noise.
    expect(waterTypeHint('lake', 'fisheries')).toBe('');
    for (const bad of [null, undefined, '', 42, {}, 'LAKE ']) {
      expect(waterTypeHint(bad, 'fisheries')).toBe('');
    }
    expect(waterTypeHint('coastal', 'no_such_agent')).toBe('');
  });

  it('case does not decide it — feature_type is written lowercase but not guaranteed', () => {
    expect(waterTypeHint('COASTAL', 'fisheries')).toBe(waterTypeHint('coastal', 'fisheries'));
  });

  it('agents.js resolves the water type from the registry, not from a zoneKey nobody sends', () => {
    // The old expression asked body.zoneKey (research_lakes.py sends none) and then
    // previousResults._zoneMeta.slug (read in two places, written in none), so it was false on
    // every run. This asserts the replacement is wired, and the tests above assert what it does.
    expect(agentsSrc).toContain('waterTypeHint(waterType, agentKey)');
    // The dead READ is gone. `_zoneMeta` is still named in comments here, so the test asks for
    // the expression rather than the word --
    // forbidding the word would forbid explaining why it went.
    expect(/previousResults\?\._zoneMeta/.test(agentsSrc)).toBe(false);
  });
});

describe('isCoastalZone', () => {
  it('detects coast_ slugs only', () => {
    expect(isCoastalZone('coast_charleston_sc')).toBe(true);
    expect(isCoastalZone('lake_murray')).toBe(false);
    expect(isCoastalZone('')).toBe(false);
    expect(isCoastalZone(null)).toBe(false);
    expect(isCoastalZone(undefined)).toBe(false);
  });
});
