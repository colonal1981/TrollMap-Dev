// A RIVER WAS HANDED THE RESERVOIR QUERIES, BECAUSE THE TABLE WAS KEYED ON THE WRONG THING.
//
// `AGENT_DISCOVERY_QUERIES` in discover.js is keyed agent -> STATE. A state is not a kind of
// water, so every river in the app has run the lake query set verbatim. Counted 2026-09-16 over
// the 68 query and purpose strings in that table: "reservoir" appears eight times, "thermocline"
// six, "dam" six, "hydrilla" four -- and "river", "discharge", "cfs", "streamflow", "tailrace",
// "scour" and "bend" appear ZERO times between them.
//
// The fix is not a second mechanism. `water-type-hints.js` already owns what a river IS for the
// PROMPT; it now owns it for the SEARCH too, under the same key order and the same fall-through
// to nothing, so a lake runs exactly what it ran yesterday.
//
// WHAT THIS FILE CAN AND CANNOT TEST. The selection lives inside a Worker route handler that
// wants env, R2 and fetch, so the behaviour tested here is the pure lookup -- which is where the
// substance is. The two assertions about discover.js at the bottom are TRIPWIRES ON A NAME and
// this file says so out loud, because 00_START_HERE.md records what happens when a grep is
// allowed to stand in for a contract: structural-elements-contract.test.js was green for the
// whole time the feature it guarded was dead.
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { waterTypeSearch, WATER_TYPE_SEARCH } from '../Worker/research/water-type-hints.js';

const NAME = 'Congaree River';
const STATE = 'SC';

// Every word in here describes a standing body of water and is wrong on a river. They are the
// words actually present in the lake table, not a list invented for this test.
const RESERVOIR_WORDS = [
  'reservoir', 'thermocline', 'hypolimnion', 'pool elevation', 'full pool',
  'drawdown', 'hydrilla', 'guide curve', 'impoundment',
];

// What water-type-hints.js tells the fisheries agent to report on a river. A search that never
// says any of these cannot find a document that does.
const RIVER_WORDS = ['shoal', 'ledge', 'bend', 'current', 'flow', 'float', 'seam', 'hole'];

describe('the river query set', () => {
  it('exists for fisheries, which is the one agent the driver actually posts', () => {
    const got = waterTypeSearch('river', 'fisheries', NAME, STATE);
    expect(got).toBeTruthy();
    expect(Array.isArray(got.queries)).toBe(true);
    expect(got.queries.length).toBe(3);
    expect(typeof got.purpose).toBe('string');
  });

  it('names the water in every query, so a search cannot drift to another river', () => {
    const { queries } = waterTypeSearch('river', 'fisheries', NAME, STATE);
    for (const q of queries) expect(q.includes(`"${NAME}"`)).toBe(true);
  });

  it('says nothing about a reservoir anywhere in the queries or the purpose', () => {
    const got = waterTypeSearch('river', 'fisheries', NAME, STATE);
    const all = [...got.queries, got.purpose].join(' ').toLowerCase();
    for (const w of RESERVOIR_WORDS) {
      // The purpose is allowed to name one to REJECT it; the queries never are.
      for (const q of got.queries) expect(q.toLowerCase().includes(w)).toBe(false);
    }
    expect(all.includes('pool elevation')).toBe(true);   // present only in the rejection clause
  });

  it('names what the river hint asks the agent to report', () => {
    const { queries } = waterTypeSearch('river', 'fisheries', NAME, STATE);
    const hay = queries.join(' ').toLowerCase();
    const hit = RIVER_WORDS.filter((w) => hay.includes(w));
    expect(hit.length >= 5).toBe(true);
  });

  it('gives three DISTINCT queries, so the Set dedupe cannot collapse them', () => {
    const { queries } = waterTypeSearch('river', 'fisheries', NAME, STATE);
    expect(new Set(queries).size).toBe(3);
    for (const q of queries) expect(q.trim().length > 0).toBe(true);
  });
});

describe('the purpose string rejects the wrong shape of document', () => {
  // The coastal purposes already do this -- "reject reservoir thermocline and dissolved-oxygen
  // studies, this system does not thermally stratify" -- and it is the half that steers the
  // ranker. A river does not stratify either and nobody had said so.
  it('tells the ranker this is moving water and not a reservoir', () => {
    const { purpose } = waterTypeSearch('river', 'fisheries', NAME, STATE);
    const p = purpose.toLowerCase();
    expect(p.includes('river')).toBe(true);
    expect(p.includes('not a reservoir')).toBe(true);
    expect(p.includes('reject')).toBe(true);
  });

  it('asks for the water-level fact a river actually has', () => {
    const { purpose } = waterTypeSearch('river', 'fisheries', NAME, STATE);
    const p = purpose.toLowerCase();
    expect(p.includes('cfs')).toBe(true);
    expect(p.includes('not pool elevation')).toBe(true);
  });

  it('names the state it was given', () => {
    const a = waterTypeSearch('river', 'fisheries', NAME, 'GA');
    expect(a.purpose.includes('GA')).toBe(true);
  });
});

describe('every other water falls through to the state table unchanged', () => {
  it('a lake gets nothing', () => {
    expect(waterTypeSearch('lake', 'fisheries', 'Lake Murray', STATE)).toBe(null);
  });

  it('a coastal zone gets nothing -- it already has its own agents', () => {
    expect(waterTypeSearch('coastal', 'fisheries', 'ACE Basin', STATE)).toBe(null);
  });

  it('an agent with no river entry gets nothing', () => {
    for (const k of ['identity', 'navigation', 'regulations', 'limnology', 'habitat', 'biology']) {
      expect(waterTypeSearch('river', k, NAME, STATE)).toBe(null);
    }
  });

  it('a missing, empty or unknown water type gets nothing', () => {
    expect(waterTypeSearch('', 'fisheries', NAME, STATE)).toBe(null);
    expect(waterTypeSearch(null, 'fisheries', NAME, STATE)).toBe(null);
    expect(waterTypeSearch(undefined, 'fisheries', NAME, STATE)).toBe(null);
    expect(waterTypeSearch('estuary', 'fisheries', NAME, STATE)).toBe(null);
  });

  it('is case-insensitive on the water type, because feature_type is read off a row', () => {
    expect(waterTypeSearch('RIVER', 'fisheries', NAME, STATE)).toBeTruthy();
  });

  it('carries exactly one water type today, so a new one cannot be added silently', () => {
    expect(Object.keys(WATER_TYPE_SEARCH)).toEqual(['river']);
  });
});

describe('discover.js asks the registry what kind of water this is -- TRIPWIRES', () => {
  // READ THIS BEFORE TRUSTING THE THREE BELOW. They are greps on a NAME, not checks on a
  // BEHAVIOUR, because the selection sits inside a route handler that wants env, R2 and fetch.
  // A rename keeps them green while the wiring rots. They exist to catch a DELETION, which is
  // the one failure a grep genuinely does catch, and nothing more.
  const src = readFileSync(new URL('../Worker/research/discover.js', import.meta.url), 'utf8');

  it('imports the lookup rather than growing a second copy of it', () => {
    expect(src.includes("from './water-type-hints.js'")).toBe(true);
    expect(src.includes('waterTypeSearch')).toBe(true);
  });

  it('resolves the registry row instead of only sniffing the key prefix', () => {
    expect(src.includes('resolveRegistryRow(await lakeIndex(env), lakeName)')).toBe(true);
    expect(src.includes('feature_type')).toBe(true);
    // `waterType === 'coastal'` with the coast_ prefix as its fallback stood here. It chose between
    // the freshwater and the coastal agent sets for a request with no agent; the coastal agents
    // went on 2026-09-25 and a request must now name its agent, so there is no set to choose.
  });

  it('still falls back to the state table, which nothing here replaces', () => {
    expect(src.includes('AGENT_DISCOVERY_QUERIES[agentKey][state]')).toBe(true);
    expect(src.includes('if (!typed && !stateQueries) continue;')).toBe(true);
  });

  it('leaves the fisheries recency window a two-entry array, so query 2 is evergreen', () => {
    // Three river queries against a two-entry window is deliberate: recencyWindows[2] reads
    // undefined and `if (recencyMinutes)` is falsy, which is exactly what an evergreen query
    // wants. If that array ever grows, this says so before a third search gets a 45-day fence.
    expect(src.includes('_fisheries_recency: [64800, null]')).toBe(true);
  });
});
