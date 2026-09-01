import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  COASTAL_AGENTS,
  COASTAL_AGENT_HINTS,
  COASTAL_SKIPPED_AGENTS,
  isCoastalZone,
  coastalAgentPlan,
} from '../Worker/research/coastal-agents.js';

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

describe('shared agents get coastal framing rather than duplicates', () => {
  it('hints exist only for the two reused agents', () => {
    expect(Object.keys(COASTAL_AGENT_HINTS).sort()).toEqual(['biology', 'habitat']);
  });

  it('habitat hint swaps reservoir structure for estuarine structure', () => {
    const h = COASTAL_AGENT_HINTS.habitat;
    expect(h).toMatch(/marsh edges/i);
    expect(h).toMatch(/oyster/i);
    expect(h).toMatch(/Do NOT report brush piles/i);
  });

  it('biology hint swaps the freshwater forage base for the estuarine one', () => {
    const b = COASTAL_AGENT_HINTS.biology;
    expect(b).toMatch(/shrimp/i);
    expect(b).toMatch(/mullet/i);
    expect(b).toMatch(/NOT threadfin or gizzard shad/i);
    expect(b).toMatch(/cold-stun/i);
  });

  it('agents.js appends the hint to the system prompt for coastal targets', () => {
    expect(agentsSrc).toContain('COASTAL_AGENT_HINTS[agentKey]');
    expect(agentsSrc).toContain('coastalTarget');
  });
});

describe('agent plan and skips', () => {
  // This asserted an eight-agent coastal plan naming `estuary`, `tidal`,
  // `saltwater_regulations`, `navigation` and `summary`. All five were retired across 2026-08-31
  // and 2026-09-01, and the test kept passing because coastalAgentPlan() has no live caller --
  // it agreed with the list, and the list agreed with nothing that runs.
  it('runs the two surviving agents for a coastal zone', () => {
    expect(coastalAgentPlan()).toEqual(['biology', 'fisheries']);
  });

  it('names no retired agent in the plan', () => {
    const plan = coastalAgentPlan();
    for (const a of ['identity', 'limnology', 'regulations', 'saltwater_regulations',
                     'estuary', 'tidal', 'navigation', 'summary', 'habitat']) {
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
