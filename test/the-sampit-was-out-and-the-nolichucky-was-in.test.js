/**
 * test/the-sampit-was-out-and-the-nolichucky-was-in.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Two things the research work list got wrong, both measured on Ryan's machine 2026-09-23.
 *
 * THE FLOOR. PRESETS.research held rivers to the 1,000-acre floor once the river switch was on,
 * under a note saying a river's acreage measures a ribbon. Of the 55 rivers the picker binds it
 * admitted 34 and shut out 21, upside down: the Nolichucky (3,398 ac, 12 buildable trolling runs)
 * in, the Sampit (721 ac, 1,861 runs) out. A river is now judged on its soundings like every other
 * water, and research_todo.mjs orders the list by buildable runs instead of cutting it.
 *
 * THE SECOND RESOLVER. research_todo.mjs falls back to lakeRecordFor() when the access index
 * cannot bind a name, and that goes state-blind: 28 of the 127 names that reach it came back as a
 * water in a state the name rules out -- "Silver Lake, GA" and "Goose Creek, TN" as SC lakes,
 * "Cherokee Lake, GA" as the TVA reservoir. Those bindings are refused now. The same rule moved
 * into lakeRecordFor() itself changed 36 resolutions, the extra eight being border reservoirs the
 * app's other callers resolve correctly; it stays in the script.
 *
 *   node --test test/the-sampit-was-out-and-the-nolichucky-was-in.test.js
 */
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { makePredicate } from '../js/data/water-filter.js';
import { stampedStates, stampAllows, stateFor, orderByRuns } from '../Scripts/research_todo_rules.mjs';

const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

// The file's spelling and the app's, as water-filter.test.js insists: a predicate is only
// correct against the record its caller actually holds.
const fileRec = (o = {}) => ({ name: 'Somewhere', slug: 'somewhere', state: 'SC', area_acres: 2000,
                               charted: 0.9, feature_type: 'lake', ...o });
const appRec = (o = {}) => {
  const { area_acres: a, feature_type: f, ...rest } = fileRec(o);
  return { ...rest, areaAcres: a, featureType: f };
};

describe('a river is judged on its soundings, not on the acreage of a ribbon', () => {
  const off = makePredicate('research', null);
  const on = makePredicate('research', null, { includeRivers: true });

  it('the Sampit comes through with the switch on, in both record shapes', () => {
    for (const make of [fileRec, appRec]) {
      const sampit = make({ name: 'Sampit River', slug: 'sampit_river', feature_type: 'river',
                            area_acres: 721, charted: 0.88 });
      expect(on(sampit, 'Sampit River, SC')).toBe(true);
      // Black Mingo Creek, 149 acres and 774 runs: the size of the number is not the question.
      const mingo = make({ feature_type: 'river', area_acres: 149, charted: 0.8 });
      expect(on(mingo, 'Black Mingo Creek, SC')).toBe(true);
    }
  });

  it('the switch is still the switch', () => {
    for (const make of [fileRec, appRec]) {
      const river = make({ feature_type: 'river', area_acres: 721, charted: 0.88 });
      expect(off(river, 'Sampit River, SC')).toBe(false);
    }
  });

  it('a river with no soundings stays out, which is the test every other water passes', () => {
    for (const make of [fileRec, appRec]) {
      expect(on(make({ feature_type: 'river', area_acres: 9000, charted: 0 }), 'Judd Slough'))
        .toBe(false);
    }
  });

  it('the acre floor is the lakes\' alone, and moving it does not move a river', () => {
    const tight = makePredicate('research', null, { includeRivers: true, minAcres: 5000 });
    expect(tight(fileRec({ feature_type: 'river', area_acres: 721 }), 'Sampit River, SC')).toBe(true);
    expect(tight(fileRec({ area_acres: 4000 }), 'Somewhere Lake')).toBe(false);
    expect(on(fileRec({ area_acres: 999 }), 'Somewhere Lake')).toBe(false);
    expect(on(fileRec({ area_acres: 1000 }), 'Somewhere Lake')).toBe(true);
  });
});

describe('the work list comes most buildable runs first, and nothing is cut', () => {
  const RUNS = { sampit_river: { runs: 1861 }, nolichucky_river: { runs: 12 },
                 wateree_river: { runs: 2178 }, uwharrie_river: { runs: 958 } };
  const rows = [
    { name: 'Nolichucky River, TN', slug: 'nolichucky_river' },
    { name: 'Nowhere Built, SC', slug: 'nowhere_built' },
    { name: 'Sampit River, SC', slug: 'sampit_river' },
    { name: 'No Row, GA', slug: null },
    { name: 'Wateree River, SC', slug: 'wateree_river' },
    { name: 'UWHARRIE RIVER, NC', slug: 'uwharrie_river' },
  ];

  it('orders by runs, and carries the count on the row', () => {
    const out = orderByRuns(rows, RUNS);
    expect(out.map((r) => r.slug).slice(0, 4))
      .toEqual(['wateree_river', 'sampit_river', 'uwharrie_river', 'nolichucky_river']);
    expect(out[0].runs).toBe(2178);
  });

  it('a water with no count goes last in the order it came, and is not dropped', () => {
    const out = orderByRuns(rows, RUNS);
    expect(out.length).toBe(rows.length);
    expect(out.slice(4).map((r) => r.name)).toEqual(['Nowhere Built, SC', 'No Row, GA']);
    expect(out.slice(4).every((r) => r.runs === null)).toBe(true);
  });

  it('a zero is a measurement and sorts as one, ahead of no measurement', () => {
    const out = orderByRuns([{ name: 'a', slug: null }, { name: 'b', slug: 'z' }], { z: { runs: 0 } });
    expect(out.map((r) => r.name)).toEqual(['b', 'a']);
  });

  it('does not touch the rows it was given', () => {
    const before = JSON.stringify(rows);
    orderByRuns(rows, RUNS);
    expect(JSON.stringify(rows)).toBe(before);
  });
});

describe('a name that says which state it is in cannot be bound to another one', () => {
  it('reads every stamp shape the picker writes', () => {
    expect(stampedStates('Silver Lake, GA')).toEqual(['GA']);
    expect(stampedStates('Lake Sidney Lanier (Hall Co, GA)')).toEqual(['GA']);
    expect(stampedStates('Hartwell Lake (SC/GA)')).toEqual(['SC', 'GA']);
    expect(stampedStates('Broad River')).toEqual([]);
  });

  it('refuses the four that were measured going across a line', () => {
    expect(stampAllows({ slug: 'silver_lake_3', state: 'SC' }, 'Silver Lake, GA')).toBe(false);
    expect(stampAllows({ slug: 'goose_creek_reservoir', state: 'SC' }, 'Goose Creek, TN')).toBe(false);
    expect(stampAllows({ slug: 'cherokee_lake', state: 'TN' }, 'Cherokee Lake, GA')).toBe(false);
    expect(stampAllows({ slug: 'coast_murrells_inlet_sc', state: 'SC' }, 'INTRACOASTAL WATERWAY, NC'))
      .toBe(false);
  });

  it('allows a row that carries the state, a row with none, and a name with none', () => {
    expect(stampAllows({ state: 'GA/SC' }, 'Hartwell Lake, SC')).toBe(true);
    expect(stampAllows({ state: 'GA' }, 'Hartwell Lake (SC/GA)')).toBe(true);
    expect(stampAllows({ state: 'GA' }, 'Lake Sidney Lanier (Hall Co, GA)')).toBe(true);
    expect(stampAllows({ state: '' }, 'Somewhere, SC')).toBe(true);
    expect(stampAllows({ state: 'SC' }, 'Broad River')).toBe(true);
    expect(stampAllows(null, 'Silver Lake, GA')).toBe(true);
  });

  it('a refused name keeps its own state; a bound one keeps its row\'s', () => {
    expect(stateFor('Silver Lake, GA', null)).toBe('GA');
    expect(stateFor('Lake Sidney Lanier (Hall Co, GA)', null)).toBe('GA');
    // The Worker opens NC WRC's roster only under NC, and it holds broad_river's 8 species.
    expect(stateFor('Broad River, SC', { slug: 'broad_river', state: 'NC' })).toBe('NC');
    expect(stateFor('Nowhere', null)).toBe(null);
  });
});

describe('research_todo.mjs and research_lakes.py are wired to all of it', () => {
  const todo = src('../Scripts/research_todo.mjs');
  const py = src('../Scripts/research_lakes.py');

  it('the fallback is checked before it is used, and the refusal is reported', () => {
    expect(todo).not.toContain('const rec = viaIndex || lakeRecordFor(name);');
    expect(todo).toContain('stampAllows(fallback, name)');
    expect(todo).toContain('reportRefused();');
  });

  it('the state comes through stateFor()', () => {
    expect(todo).toContain('state: stateFor(name, rec)');
  });

  it('--min-acres and --runs reach the list', () => {
    expect(todo).toContain('keepCfg.minAcres = minAcresArg');
    expect(todo).toContain('orderByRuns(described, runsBySlug)');
    expect(py).toContain('argv += ["--min-acres", str(min_acres)]');
    expect(py).toContain('argv += ["--runs", os.path.abspath(runs_path)]');
    expect(py).toContain('"_trolling_runs.json"');
  });

  it('the registry path mirrors the preset: no acre floor for a river', () => {
    expect(py).toContain('if not is_river and (row.get("area_acres") or 0) < args.min_acres:');
  });
});

describe('the real run counts, when they are on this machine', () => {
  const path = new URL('../../registry/_trolling_runs.json', import.meta.url);
  const have = existsSync(path);
  it(have ? 'the Sampit outranks the Nolichucky, and the Wateree outranks both'
          : 'skipped: registry/_trolling_runs.json is not on this machine', () => {
    if (!have) return;
    const lakes = JSON.parse(readFileSync(path, 'utf8')).lakes;
    const out = orderByRuns([{ slug: 'nolichucky_river' }, { slug: 'sampit_river' },
                             { slug: 'wateree_river' }], lakes);
    expect(out.map((r) => r.slug)).toEqual(['wateree_river', 'sampit_river', 'nolichucky_river']);
  });
});
