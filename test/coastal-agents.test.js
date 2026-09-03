import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  COASTAL_AGENTS,
  COASTAL_SKIPPED_AGENTS,
  isCoastalZone,
  coastalAgentPlan,
} from '../Worker/research/coastal-agents.js';
import { RESEARCH_AGENTS } from '../Worker/research/agents.js';
import { WATER_TYPE_HINTS, waterTypeHint } from '../Worker/research/water-type-hints.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentsSrc = readFileSync(path.join(REPO, 'Worker/research/agents.js'), 'utf8');
const discoverSrc = readFileSync(path.join(REPO, 'Worker/research/discover.js'), 'utf8');

describe('coastal agents — the three saltwater-specific ones', () => {
  it('defines estuary, tidal and saltwater_regulations', () => {
    expect(Object.keys(COASTAL_AGENTS).sort())
      .toEqual(['estuary', 'saltwater_regulations', 'tidal']);
  });

  it('matches the RESEARCH_AGENTS shape so the review UI renders them', () => {
    for (const [key, agent] of Object.entries(COASTAL_AGENTS)) {
      expect(agent.label, `${key}.label`).toBeTruthy();
      expect(typeof agent.order, `${key}.order`).toBe('number');
      expect(agent.system, `${key}.system`).toBeTruthy();
      expect(typeof agent.userTemplate, `${key}.userTemplate`).toBe('function');
      expect(agent.expectedKey, `${key}.expectedKey`).toBeTruthy();
      expect(agent.coastal).toBe(true);
    }
  });

  it('produces JSON-only prompts naming the zone', () => {
    for (const [key, agent] of Object.entries(COASTAL_AGENTS)) {
      const prompt = agent.userTemplate('Charleston Harbor', 'SC', {});
      expect(prompt, `${key} prompt`).toContain('Charleston Harbor');
      expect(prompt, `${key} must demand JSON`).toMatch(/JSON only|Return ONLY/);
    }
  });

  it('estuary refuses reservoir fields that have no coastal meaning', () => {
    const sys = COASTAL_AGENTS.estuary.system;
    expect(sys).toMatch(/normalPoolFt/);
    expect(sys).toMatch(/NEVER/);
    const prompt = COASTAL_AGENTS.estuary.userTemplate('Winyah Bay', 'SC', {});
    expect(prompt).not.toMatch(/thermocline/i);
    expect(prompt).toMatch(/meanTidalRangeFt/);
  });

  it('tidal replaces thermocline/anoxia with salinity structure', () => {
    const sys = COASTAL_AGENTS.tidal.system;
    expect(sys).toMatch(/do NOT thermally stratify|never emit thermocline/i);
    const prompt = COASTAL_AGENTS.tidal.userTemplate('Bogue Sound', 'NC', {});
    expect(prompt).toMatch(/salinityPpt/);
    expect(prompt).toMatch(/flushingTimeDays/);
    expect(prompt).toMatch(/stratificationType/);
  });

  it('tidal surfaces the USGS rivers that drive salinity', () => {
    const prompt = COASTAL_AGENTS.tidal.userTemplate('Charleston Harbor', 'SC', {
      _zoneMeta: { usgsRivers: ['Cooper River', 'Ashley River'] },
    });
    expect(prompt).toContain('Cooper River');
    expect(prompt).toMatch(/130%/);
  });
});

describe('saltwater_regulations — the two-layer digest + live design', () => {
  it('treats the R2 digest as baseline and a live source as override', () => {
    const sys = COASTAL_AGENTS.saltwater_regulations.system;
    expect(sys).toMatch(/BASELINE/);
    expect(sys).toMatch(/LIVE source wins/i);
    expect(sys).toMatch(/supersededByProclamation/);
  });

  it('knows the digests expire and change by proclamation', () => {
    const sys = COASTAL_AGENTS.saltwater_regulations.system;
    expect(sys).toMatch(/mid-August/i);
    expect(sys).toMatch(/proclamation/i);
  });

  it('flags verificationRequired when no live source is supplied', () => {
    const prompt = COASTAL_AGENTS.saltwater_regulations.userTemplate('Cape Fear River', 'NC', {
      _regsSource: { content: 'Red drum 18-27 inches, 1 per day', published: '2025-2026' },
    });
    expect(prompt).toMatch(/verificationRequired/);
    expect(prompt).toContain('Red drum 18-27 inches');
    expect(prompt).toMatch(/No live amendment source/);
  });

  it('tells the model the live source overrides a conflicting digest', () => {
    const prompt = COASTAL_AGENTS.saltwater_regulations.userTemplate('Charleston Harbor', 'SC', {
      _regsSource: { content: 'Red drum 15-23 inches, 2 per day' },
      _liveRegsSource: { content: 'Effective July 1 2026: red drum 18-25 inches, 1 per day' },
    });
    expect(prompt).toMatch(/overrides the digest/i);
    expect(prompt).toContain('18-25');
  });

  it('captures both slot bounds, not just a minimum', () => {
    // Collapsing a slot to a minimum would authorise keeping an oversize fish.
    const prompt = COASTAL_AGENTS.saltwater_regulations.userTemplate('Savannah River', 'GA', {});
    expect(prompt).toMatch(/minSizeIn/);
    expect(prompt).toMatch(/maxSizeIn/);
    expect(prompt).toMatch(/slot-managed|slot upper bound/i);
  });

  it('covers the three target species plus closure state', () => {
    const prompt = COASTAL_AGENTS.saltwater_regulations.userTemplate('Pamlico Sound', 'NC', {});
    expect(prompt).toMatch(/redDrum/);
    expect(prompt).toMatch(/spottedSeatrout/);
    expect(prompt).toMatch(/southernFlounder/);
    expect(prompt).toMatch(/harvestClosed/);
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
    // coastalAgentPlan() returns exactly one agent, and it is this one.
    expect(coastalAgentPlan()).toEqual(['fisheries']);
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
    // The dead READ is gone. `_zoneMeta` is still named in two comments here, and in two RETIRED
    // agents in coastal-agents.js, so the test asks for the expression rather than the word --
    // forbidding the word would forbid explaining why it went.
    expect(/previousResults\?\._zoneMeta/.test(agentsSrc)).toBe(false);
  });
});

describe('agent plan and skips', () => {
  // This asserted an eight-agent coastal plan naming `estuary`, `tidal`,
  // `saltwater_regulations`, `navigation` and `summary`. All five were retired across 2026-08-31
  // and 2026-09-01, and the test kept passing because coastalAgentPlan() has no live caller --
  // it agreed with the list, and the list agreed with nothing that runs.
  it('runs the one surviving agent for a coastal zone', () => {
    expect(coastalAgentPlan()).toEqual(['fisheries']);
  });

  it('names no retired agent in the plan', () => {
    const plan = coastalAgentPlan();
    for (const a of ['identity', 'limnology', 'regulations', 'saltwater_regulations',
                     'estuary', 'tidal', 'navigation', 'summary', 'habitat', 'biology']) {
      expect(plan).not.toContain(a);
    }
  });

  it('documents why every agent it does not run is missing', () => {
    const plan = coastalAgentPlan();
    // Every skipped agent carries a reason, and no agent is both run and skipped.
    for (const [agent, reason] of Object.entries(COASTAL_SKIPPED_AGENTS)) {
      expect(plan).not.toContain(agent);
      expect(reason.length).toBeGreaterThan(20);
    }
    // And the three coastal-specific agents that were built and then retired are all accounted
    // for here rather than quietly forgotten.
    for (const a of ['estuary', 'tidal', 'saltwater_regulations']) {
      expect(Object.keys(COASTAL_SKIPPED_AGENTS)).toContain(a);
    }
  });

  it('registers coastal agents into the shared registry', () => {
    expect(agentsSrc).toContain('Object.assign(RESEARCH_AGENTS, COASTAL_AGENTS)');
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

describe('coastal discovery queries target marine sources', () => {
  it('defines query sets for all three coastal agents in SC/GA/NC', () => {
    for (const agent of ['estuary', 'tidal', 'saltwater_regulations']) {
      expect(discoverSrc, `${agent} queries missing`).toMatch(
        new RegExp(`${agent}:\\s*\\{[\\s\\S]{0,900}?NC:`)
      );
    }
  });

  it('points at marine agencies rather than the freshwater ones', () => {
    expect(discoverSrc).toMatch(/coastalgadnr\.org/);
    expect(discoverSrc).toMatch(/NCDMF|deq\.nc\.gov/);
    expect(discoverSrc).toMatch(/noaa\.gov/);
  });

  it('bounds regulation-amendment searches by recency', () => {
    // Amendments only matter if they postdate the printed digest.
    expect(discoverSrc).toContain('_saltwater_regs_recency');
  });

  it('keeps coastal and freshwater agent sets disjoint', () => {
    expect(discoverSrc).toContain('COASTAL_AGENT_KEYS');
    expect(discoverSrc).toContain('isCoastalTarget');
  });

  it('tags coastal sections so they map onto existing profile slots', () => {
    expect(discoverSrc).toMatch(/estuary:\s*\['estuary',\s*'identity'\]/);
    expect(discoverSrc).toMatch(/tidal:\s*\['tidal',\s*'limnology'\]/);
  });
});
