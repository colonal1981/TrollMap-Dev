// FIVE THOUSAND CAST SPOTS AND A WINDOW ONTO THIRTY OF THEM.
//
// Ryan, doing a Pick Water on Wateree: "the entire screen is full of humps and points and no way
// to find any other structure — 5020 cast spots · 16 on water you have picked · showing 30".
//
// The list is ordered free-first then nearest and cut at 30. That ordering is right and it is
// also a trapdoor: whichever kind happens to be commonest near the picked water fills the whole
// window, and every other kind sits behind it with no way to reach it. Wateree carries humps,
// ledges, points, coves, creek mouths, timber, brush piles, charted attractors, DNR brushpiles
// and two kinds of dock line — eight of them unreachable.
//
// A filter with counts is the fix, and the counting is the part worth testing: "brush pile 41"
// is the difference between choosing and guessing, and a count that describes the FILTERED list
// rather than the water would change meaning under him every time he clicked.
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
globalThis.window = globalThis;
globalThis.document = { getElementById: () => null, querySelectorAll: () => [],
                        querySelector: () => null, createElement: () => ({ style: {} }) };
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });

const ui = await import('../js/modules/plan-water-ui.js');
const src = readFileSync(join(here, '..', 'js/modules/plan-water-ui.js'), 'utf8');

const spot = (type, what, free) => ({ type, what, free });

describe('spotKindCounts', () => {
  const priced = [
    spot('hump', 'offshore hump', true), spot('hump', 'offshore hump', false),
    spot('hump', 'offshore hump', false),
    spot('point', 'point', true),
    spot('pile', 'brush pile', false), spot('pile', 'brush pile', false),
    spot('cove', 'cove', false),
  ];

  it('counts every kind present, and how many are on water already picked', () => {
    const rows = ui.spotKindCounts(priced);
    const by = Object.fromEntries(rows.map((r) => [r.type, r]));
    expect(by.hump.n).toBe(3);
    expect(by.hump.free).toBe(1);
    expect(by.pile.n).toBe(2);
    expect(by.pile.free).toBe(0);
    expect(by.cove.n).toBe(1);
  });

  it('leads with kinds that have spots on picked water, then the commonest', () => {
    const order = ui.spotKindCounts(priced).map((r) => r.type);
    // hump and point both have a free spot; hump has more of them. pile and cove have none, and
    // pile is commoner. A kind with nothing free is still listed — it is exactly what he opens
    // the filter to find.
    expect(order).toEqual(['hump', 'point', 'pile', 'cove']);
  });

  it('carries the KIND label, not one spot\'s own name', () => {
    // A DNR brushpile carries its published name -- "Fish Attractor #4 Lake Wateree" -- which is
    // right on a row and absurd on a chip. The first render of this filter offered a button
    // labelled with one attractor's name and a count of 3,898. SPOT_KINDS is the vocabulary.
    expect(ui.spotKindCounts(priced)[0].what).toBe('offshore hump');
    const named = [{ type: 'dnr_attractor', what: 'Fish Attractor #4 Lake Wateree', free: false },
                   { type: 'dnr_attractor', what: 'Fish Attractor #9 Lake Wateree', free: false }];
    expect(ui.spotKindCounts(named)[0].what).toBe('DNR brushpile');
    expect(ui.spotKindCounts(named)[0].n).toBe(2);
  });

  it('survives an empty or malformed list rather than throwing under a repaint', () => {
    expect(ui.spotKindCounts([])).toEqual([]);
    expect(ui.spotKindCounts(null)).toEqual([]);
    expect(ui.spotKindCounts([null, {}, spot('cove', 'cove', false)]).length).toBe(1);
  });
});

describe('the filter narrows what is listed, never what is counted', () => {
  it('the free tally is taken from the whole water, not the filtered view', () => {
    // If this ever reads `shown`, the headline number changes every time he clicks a chip and
    // stops describing the water at all.
    expect(src.includes('const free = priced.filter((x) => x.free).length;')).toBe(true);
  });

  it('an empty selection is every kind, which is what it did before there was a filter', () => {
    expect(src.includes('T.spotKinds.size ? priced.filter((x) => T.spotKinds.has(x.type)) : priced'))
      .toBe(true);
  });

  it('one kind is not a choice, so no chips are drawn', () => {
    expect(src.includes('if (rows.length < 2) return \'\'')).toBe(true);
  });

  it('and the chips are wired to repaint', () => {
    expect(src.includes("closest?.('[data-kind]')")).toBe(true);
  });
});
