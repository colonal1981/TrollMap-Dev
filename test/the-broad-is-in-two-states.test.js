/**
 * test/the-broad-is-in-two-states.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 2026-09-24: "Need to fix the broads... is there a way for rivers that flow through multiple
 * states to carry that information?"
 *
 * The measurement already existed. label_water_states.py tests every water's outline against the
 * Census state lines, and 28 of the 352 waters we offer touch more than one state -- the Broad is
 * NC 56 / SC 44 of its outline. Exactly one reader used it, the regulations builder. Everything
 * else had one state per water, the registry row's, and the Broad's row says NC with its centroid
 * in Cherokee County, SC. Three things followed from that one field:
 *
 *   1. The Worker opened NC WRC's species file only when the state it was handed was NC, so a
 *      caller that said "Broad River, SC" or "French Broad River, TN" shut the only roster either
 *      water has (8 and 7 species). The file is keyed by slug; the slug is the gate now.
 *   2. research_todo.mjs kept the row's state over the name's stamp -- deliberately, because of 1.
 *      With 1 fixed, a stamp naming a state the water's outline reaches is the state it is
 *      researched under.
 *   3. A plan launched from 99 Island, in Cherokee County, SC, was checked against North
 *      Carolina's statewide book. The launch is placed on the Census line now (water-state-parts
 *      .js), and 1,146 of 1,166 launches on the 27 two-state waters were placed, every one in the
 *      state the full outline puts it in; the other 20 are beyond reach of their water and say so.
 *
 *   node --test test/the-broad-is-in-two-states.test.js
 */
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';

const FX = JSON.parse(readFileSync(
  new URL('./fixtures/the-broad-is-in-two-states.2026-09-24.json', import.meta.url), 'utf8'));
const WATER = JSON.parse(readFileSync(
  new URL('./fixtures/the-app-knew-the-water.2026-09-23.json', import.meta.url), 'utf8'));
const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

// The registry the app loads, before anything imports lake-registry.js.
globalThis.window = globalThis;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => FX.lake_index });

const { registrySpeciesFor } = await import('../Worker/research/deterministic.js');
const { _resetIndexCache } = await import('../Worker/registry.js');
const { stateFor, statesOf, stampAllows } = await import('../Scripts/research_todo_rules.mjs');
const parts = await import('../js/data/water-state-parts.js');
const reg = await import('../js/data/lake-registry.js');
await reg.loadLakeRegistry();
const pre = await import('../js/modules/plan-preflight.js');

const launch = (name) => {
  const l = FX.launches.find((x) => x.name === name);
  if (!l) throw new Error(`fixture has no launch ${name}`);
  return l;
};

// ── 1. the roster ────────────────────────────────────────────────────────────────────────────
describe('NC WRC\'s roster opens on the slug, whatever state the caller said', () => {
  const KEYS = {
    '_registry/lake_index.json': WATER.lake_index,
    '_registry/nc_species_by_lake.json': WATER.nc_species_by_lake,
  };
  const env = () => ({
    R2_TROLLMAP_CHARTPACKS: {
      get: async (key) => (KEYS[key]
        ? { text: async () => JSON.stringify(KEYS[key]),
            arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(KEYS[key])).buffer }
        : null),
    },
  });
  const ask = async (name, state, slug) => {
    _resetIndexCache();
    return registrySpeciesFor(env(), name, state, slug);
  };

  for (const [name, slug, st] of [['Broad River, SC', 'broad_river', 'SC'],
                                  ['French Broad River, TN', 'french_broad_river', 'TN']]) {
    it(`"${name}" asked as ${st} gets the same roster as asked as NC`, async () => {
      const asNc = await ask(name, 'NC', slug);
      const asOwn = await ask(name, st, slug);
      expect(asNc.predatorSpecies.length >= 7).toBe(true);
      expect(JSON.stringify(asOwn.predatorSpecies)).toBe(JSON.stringify(asNc.predatorSpecies));
      expect(asOwn.sources.some((s) => s.label === 'NC WRC public fishing areas')).toBe(true);
    });
  }

  it('the state test is gone from the code, not only from this path', () => {
    const lines = src('../Worker/research/deterministic.js').split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l));
    expect(lines.some((l) => l.includes("if (st === 'NC' || !st)"))).toBe(false);
  });
});

// ── 2. the research state ───────────────────────────────────────────────────────────────────
describe('a border water is researched under the state its name says, when it is in that state', () => {
  const broad = { slug: 'broad_river', state: 'NC', states: ['NC', 'SC'] };

  it('the stamp wins when the outline reaches it', () => {
    expect(stateFor('Broad River, SC', broad)).toBe('SC');
    expect(stateFor('French Broad River, TN',
      { slug: 'french_broad_river', state: 'NC', states: ['NC', 'TN'] })).toBe('TN');
  });

  it('the row wins when the stamp names a state the water never touches', () => {
    expect(stateFor('Broad River, GA', broad)).toBe('NC');
  });

  it('a row the measurement has not reached keeps its own state, as before', () => {
    expect(stateFor('Broad River, SC', { slug: 'broad_river', state: 'NC' })).toBe('NC');
  });

  it('with no row the stamp is all there is', () => {
    expect(stateFor('Silver Lake, GA', null)).toBe('GA');
    expect(stateFor('Nowhere', null)).toBe(null);
  });

  it('statesOf puts the row\'s own state first and adds the measured ones', () => {
    expect(statesOf({ state: 'SC', states: ['GA', 'SC'] })).toEqual(['SC', 'GA']);
    expect(statesOf({ state: 'NC' })).toEqual(['NC']);
    expect(statesOf(null)).toEqual([]);
  });

  it('a stamp the outline reaches is not refused as a cross-state binding', () => {
    expect(stampAllows(broad, 'Broad River, SC')).toBe(true);
    expect(stampAllows({ slug: 'silver_lake_3', state: 'SC', states: ['SC'] }, 'Silver Lake, GA'))
      .toBe(false);
  });
});

// ── 3. the launch's book ────────────────────────────────────────────────────────────────────
describe('the launch is placed on the Census line', () => {
  const payload = FX.water_state_parts;

  it('every launch in the fixture lands in the state the full outline put it in', () => {
    expect(FX.launches.length >= 10).toBe(true);
    for (const l of FX.launches) {
      expect(parts.launchStateOn('broad_river', [l.lon, l.lat], payload).state).toBe(l.state);
    }
  });

  it('both sides are represented, or the test above proves one', () => {
    expect(FX.launches.some((l) => l.state === 'SC')).toBe(true);
    expect(FX.launches.some((l) => l.state === 'NC')).toBe(true);
  });

  it('99 Island is South Carolina and Gray\'s Bridge is North Carolina', () => {
    const a = launch('99 Island');
    const b = launch("GRAY'S BRIDGE");
    expect(parts.launchStateOn('broad_river', [a.lon, a.lat], payload).state).toBe('SC');
    expect(parts.launchStateOn('broad_river', [b.lon, b.lat], payload).state).toBe('NC');
  });

  it('nowhere near the water is not a state, and says why', () => {
    const r = parts.launchStateOn('broad_river', [-80.0, 33.0], payload);
    expect(r.state).toBe(null);
    expect(/from the water/.test(r.why)).toBe(true);
  });

  it('no file, no water, no position: null, each with its own reason', () => {
    expect(parts.launchStateOn('broad_river', [-81.6, 35.0], null).why).toBe('the state lines have not loaded');
    expect(parts.launchStateOn('lake_wateree', [-80.9, 34.4], payload).why)
      .toBe('this water does not cross a state line');
    expect(parts.launchStateOn('broad_river', null, payload).why).toBe('the launch has no position');
  });

  it('a hole is not the polygon', () => {
    const g = { type: 'Polygon', coordinates: [
      [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
      [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]] };
    expect(parts.inGeometry(1, 1, g)).toBe(true);
    expect(parts.inGeometry(5, 5, g)).toBe(false);
  });
});

describe('the preflight reads the launch\'s book', () => {
  it('the registry entry carries every state, and a row without them falls back to its own', () => {
    expect(reg.lakeRecordFor('broad_river').states).toEqual(['NC', 'SC']);
    expect(reg.lakeDbEntryFor('broad_river').states).toEqual(['NC', 'SC']);
    expect(reg.lakeRecordFor('broad_river_2').states).toEqual(['SC']);
    expect(reg.lakeDbEntryFor('broad_river').state).toBe('NC');   // `state` is not moved
  });

  it('before the line has loaded, the row\'s state is used and the basis says so', () => {
    parts._resetWaterStateParts();
    const a = launch('99 Island');
    const p = pre.regulationStatePlace('broad_river', [a.lon, a.lat]);
    expect(p.state).toBe('NC');
    expect(p.basis).toBe('row');
  });

  it('with the line loaded, 99 Island reads South Carolina\'s book', async () => {
    await parts.primeWaterStateParts({ worker: 'https://w.test', force: true,
      fetch: async () => ({ ok: true, json: async () => FX.water_state_parts }) });
    const a = launch('99 Island');
    const p = pre.regulationStatePlace('broad_river', [a.lon, a.lat]);
    expect(p.state).toBe('SC');
    expect(p.basis).toBe('launch');
    expect(pre.regulationStateFor('broad_river', [a.lon, a.lat])).toBe('SC');
    const b = launch("GRAY'S BRIDGE");
    expect(pre.regulationStateFor('broad_river', [b.lon, b.lat])).toBe('NC');
  });

  it('a one-state water never asks where the launch is', () => {
    const p = pre.regulationStatePlace('broad_river_2', [-81.0, 34.0]);
    expect(p.basis).toBe('single');
    expect(p.state).toBe('SC');
  });

  it('the legality check says which book it read, and warns when it could not place the launch', () => {
    const a = launch('99 Island');
    const placed = pre.checkPlanLegality('broad_river', 'Largemouth Bass',
      new Date('2026-09-24T12:00:00'), { at: [a.lon, a.lat] });
    expect(placed.notes.some((n) => /launch is in SC/.test(n))).toBe(true);
    expect(placed.regulationState.state).toBe('SC');
    const lost = pre.checkPlanLegality('broad_river', 'Largemouth Bass',
      new Date('2026-09-24T12:00:00'), {});
    expect(lost.warnings.some((w) => /could not be placed/.test(w))).toBe(true);
  });
});

// ── the wiring, because a preflight nobody hands the launch to is decoration ────────────────
describe('both planners hand the launch to the law', () => {
  for (const f of ['../js/modules/smart-plan-v2-wiring.js', '../js/modules/plan-water-ui.js']) {
    it(f.split('/').pop(), () => {
      const s = src(f);
      expect(s.includes('ensureRegulations(inp.lakeName, { worker: CF_WORKER_URL, at: ramp })')).toBe(true);
      expect(s.includes('checkPlanLegality(inp.lakeName, species, date, { profile: researched, at: ramp })')).toBe(true);
    });
  }

  it('the file reaches the bucket, and the checker knows it should be there', () => {
    // Beside lake_index.json, not in PASSTHROUGH_REGISTRIES: the app reads it, the Worker does not.
    expect(src('../Scripts/upload_garmin_to_r2.py')
      .includes('f"{args.prefix}_registry/water_state_parts.json"')).toBe(true);
    expect(src('../Scripts/verify_registry_r2.py')
      .includes('("water_state_parts.json", "water_state_parts.json", "verbatim",')).toBe(true);
    expect(src('../js/data/water-state-parts.js')
      .includes("'/chartpacks/_registry/water_state_parts.json'")).toBe(true);
  });

  it('consolidate carries the measured states onto every row before it writes the index', () => {
    const c = src('../Scripts/consolidate_lake_index.py');
    const carry = c.indexOf("carry_measured_states(idx, os.path.join(R, 'water_states.json'))");
    const dump = c.indexOf("json.dump(idx, open(a.out, 'w', encoding='utf-8'), indent=1)");
    expect(carry > 0 && dump > carry).toBe(true);
  });

  it('the launch reach is the ramp binding distance, one number in two scripts', () => {
    const reach = /'--launch-reach-m', type=float, default=([\d.]+)/.exec(src('../Scripts/label_water_states.py'));
    const tol = /'--tol-m', type=float, default=([\d.]+)/.exec(src('../Scripts/build_dnr_ramps_by_lake.py'));
    expect(reach && tol && Number(reach[1]) === Number(tol[1])).toBe(true);
  });
});
