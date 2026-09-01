// NO LLM WRITES THE LAW ANY MORE.
//
// RESEARCH_REFACTOR_SCOPE_2026-08-27.md §5 counted three sources of a closure and found none of
// them authoritative: a hand-written table of six waters (deleted 2026-08-27), the digest parse,
// which has carried real closures since 2026-08-03, and a stored profile field an agent wrote.
// Moultrie proved the duplication -- its closure was in the parsed digest AND hand-typed in
// species-intel.js, one fact from two places, and only the parsed one came out of the book.
//
// The hand table went first and checkRegulations() now reads the digest. This retires the last of
// the three: the `regulations` and `saltwater_regulations` agents. §5 argues saltwater is the
// stronger case, not the weaker one -- NC closes southern flounder and spotted seatrout BY
// PROCLAMATION mid-season, so a stored block is a snapshot of a rule that can be superseded the
// following week, and fetchLiveRegsAmendments() already asks the state for exactly that.
//
// THE RUN LIST AND THE CARD ARE NOW TWO LISTS, which is what made this safe. They were one, so
// retiring an agent would have silently blanked a section of the research card -- and a section
// filled deterministically with no agent at all could never have been shown.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from './expect-shim.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(here, '..', f), 'utf8');
const live = (js) => js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const engine = live(src('js/modules/lake-research-engine.js'));
const ui = live(src('js/modules/lake-research-ui.js'));

const listNamed = (name) => {
  const m = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(engine);
  if (!m) throw new Error(`${name} not found in lake-research-engine.js`);
  return (m[1].match(/'([^']+)'/g) || []).map((q) => q.replace(/'/g, ''));
};

// Every key AGENT_DEFINITIONS declares, read off the source rather than restated.
const agentKeys = () => {
  const start = engine.indexOf('const AGENT_DEFINITIONS = {');
  const body = engine.slice(start, engine.indexOf('\n};', start));
  return (body.match(/^  ([a-z_]+):\s*\{/gm) || []).map((s) => s.trim().replace(/:\s*\{$/, ''));
};

describe('the two agents that used to write the regulations', () => {
  it('are gone from AGENT_DEFINITIONS, so runAgent() refuses them by name', () => {
    const keys = agentKeys();
    expect(keys.includes('regulations')).toBe(false);
    expect(keys.includes('saltwater_regulations')).toBe(false);
    // `identity` joined them on 2026-08-31 -- deterministic.js writes the one field of its nine
    // that had a reader (`bodyType`, from the registry's feature_type), and the chartpack was
    // already writing maxDepthFt and averageDepthFt.
    // `identity`, `estuary` and `tidal` joined them on 2026-08-31. identity: nine target fields
    // and plan-inputs.js read three, two of which the chartpack already derives and the third of
    // which the registry's feature_type answers. estuary and tidal: fifteen fields between them
    // and not one reader outside this pipeline -- the live tide and gauge path answers the cards.
    // `limnology` joined them on 2026-09-01. Ten target fields: six are read off WQP/SCDES depth
    // profiles or derived from that same secchi, one is the operator's published drawdown table,
    // and three had no reader worth a derivation. Its answers had been landing on top of the
    // measured ones under an evidence row citing the monitoring data they displaced.
    // `summary` joined them the same day. buildDeterministicSummary() already wrote that section
    // from the profile's own measured fields on every assembly; the agent then ran alone
    // afterwards, read the saved profile back, and wrote it again with its section replaced by
    // prose restating the labelled lines that sit above it in the plan prompt.
    // `habitat` joined them the same day, the last of the nine. Its twelve fields went to the
    // pack's water_features and POI layers (creek mouths, timber), the state attractor feeds,
    // `garmin_6_0` (Garmin's own seabed labels, for bottomComposition), and five that no planner
    // ever read. Vegetation is parked empty by Ryan's call rather than guessed.
    for (const k of ['identity', 'estuary', 'tidal', 'navigation', 'limnology', 'summary', 'habitat']) {
      expect(keys.includes(k)).toBe(false);
    }
    // and the two that remain are still there
    for (const k of ['biology', 'fisheries']) {
      expect(keys.includes(k)).toBe(true);
    }
  });

  it('are gone from both run orders, so the modal cannot offer them', () => {
    expect(listNamed('FRESHWATER_RESEARCH_ORDER').includes('regulations')).toBe(false);
    expect(listNamed('COASTAL_RESEARCH_ORDER').includes('saltwater_regulations')).toBe(false);
  });

  it('are gone from the wave lists, which is what actually fires them', () => {
    expect(listNamed('FRESH_WAVE1').includes('regulations')).toBe(false);
    expect(listNamed('COASTAL_WAVE1').includes('saltwater_regulations')).toBe(false);
  });

  it('are gone from the coastal validation paths, which asked an LLM to fill them anyway', () => {
    const m = /const COASTAL_VALIDATION_FIELD_PATHS = \[([\s\S]*?)\n\];/.exec(engine);
    const paths = (m[1].match(/'([^']+)'/g) || []).map((q) => q.replace(/'/g, ''));
    for (const p of ['saltwaterRegulations', 'saltwater_regulations', 'regulations']) {
      expect(paths.includes(p)).toBe(false);
    }
    // the coastal fields it exists for are untouched
    expect(paths.includes('tidal.salinityPpt')).toBe(true);
  });

  it('every agent the run order names is one AGENT_DEFINITIONS declares', () => {
    const keys = new Set(agentKeys());
    for (const list of ['FRESHWATER_RESEARCH_ORDER', 'COASTAL_RESEARCH_ORDER',
                        'FRESH_WAVE1', 'COASTAL_WAVE1']) {
      for (const k of listNamed(list)) expect(keys.has(k)).toBe(true);
    }
  });
});

describe('what runs and what the card draws are two lists', () => {
  it('the section lists are a superset of the run orders', () => {
    for (const [run, show] of [['FRESHWATER_RESEARCH_ORDER', 'FRESHWATER_PROFILE_SECTIONS'],
                               ['COASTAL_RESEARCH_ORDER', 'COASTAL_PROFILE_SECTIONS']]) {
      const shown = new Set(listNamed(show));
      for (const k of listNamed(run)) expect(shown.has(k)).toBe(true);
    }
  });

  it('and the regulations sections are still drawn, agent or no agent', () => {
    expect(listNamed('FRESHWATER_PROFILE_SECTIONS').includes('regulations')).toBe(true);
    expect(listNamed('COASTAL_PROFILE_SECTIONS').includes('saltwater_regulations')).toBe(true);
    // still labelled, or the card shows a raw key
    expect(engine).toMatch(/regulations:\s*'📜 Regulations'/);
    expect(engine).toMatch(/saltwater_regulations:\s*'📜 Saltwater Regs'/);
  });

  it('the card renders from the section list and the run modal from the agent list', () => {
    expect(ui).toMatch(/function getEffectiveResearchOrderForRender\(\)[\s\S]{0,900}?FRESHWATER_PROFILE_SECTIONS/);
    expect(ui.includes('return COASTAL_PROFILE_SECTIONS')).toBe(true);
    // the modal is the only place the RUN order may still be read in the UI
    expect(ui).toMatch(/effectiveOrderForModal = coastalForModal \? COASTAL_RESEARCH_ORDER : FRESHWATER_RESEARCH_ORDER/);
  });
});
