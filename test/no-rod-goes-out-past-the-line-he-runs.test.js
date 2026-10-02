/**
 * no-rod-goes-out-past-the-line-he-runs.test.js
 *
 * 2026-10-02. Ryan's first Opus plan, Moultrie AM for Oct 3, put R1's DD4 Crankbait out on 180 ft of
 * lead on all ten of its legs. He runs 120 ft -- "i dont think i would want much more than that
 * dragging behind me with 2 lines out" -- and FISHING_STYLE.rigging.maxLeadFt has said so since
 * 2026-08-02. The model did not invent 180: the prompt's lure table told it the DD4 takes "182 ft of
 * lead at its deepest", 35 ft times a 5.2 working ratio with no source behind it, and nothing after
 * the model held a crankbait's lead to the line. A Sonnet plan had done 150 at Murray on 9/27.
 *
 * Asked what the lead was based on and shown the makers' figures and the one Precision Trolling
 * curve found (a Bandit Walleye Deep: 20 ft on 117 ft of 10 lb mono, 22 ft on 195), his answer:
 * "Hold them to 120 ft".
 *
 *   node --test test/no-rod-goes-out-past-the-line-he-runs.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 */
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { trollableBaits, leadForDepth } from '../js/data/lure-knowledge.js';
import { holdLeadsToTheLine } from '../js/modules/plan-assemble.js';
import { planFromWater } from '../js/modules/plan-from-water.js';
import { planToTimeline } from '../js/modules/plan-to-timeline.js';
import { TACKLE_INVENTORY } from '../js/data/tackle-inventory.js';
import { FISHING_STYLE } from '../js/data/fishing-style-profile.js';
import { connectionFor } from '../js/data/lure-knowledge.js';

const LINE = FISHING_STYLE.rigging.maxLeadFt;
const byName = (n) => TACKLE_INVENTORY.find((l) => l.name === n) || null;
const DD4 = 'DD4 Crankbait (25ft+)';
const src = (f) => readFileSync(new URL(`../js/modules/${f}`, import.meta.url), 'utf8');

describe('the lure table the model reads stops at the line', () => {
  const { legal } = trollableBaits(TACKLE_INVENTORY.filter((l) => l.trollable),
                                   { speedMph: 2.0, maxLeadFt: LINE });
  const row = (id) => legal.find((l) => l.id === id);

  it('the line he runs is still 120 ft', () => {
    expect(LINE).toBe(120);
  });

  it('the DD4 and the DD3 are quoted at 120 ft, marked as the line and not the depth', () => {
    expect(leadForDepth(byName(DD4), 35, 2.0)).toBe(182);   // what the table used to say
    for (const id of ['cb_dd4', 'cb_dd3']) {
      expect(row(id).leadFt).toBe(LINE);
      expect(row(id).leadIsLimit).toBe(true);
    }
  });

  it('a crankbait that gets there inside the line keeps its own lead', () => {
    expect(row('cb_dd2').leadFt).toBe(76);                  // 20 ft x 3.8
    expect(row('cb_dd2').leadIsLimit).toBe(undefined);
  });

  it('the box depth is still the box depth -- the names and ratings were kept', () => {
    expect(row('cb_dd4').covers).toEqual([25, 35]);
  });

  it('and the table says the line is what stops it, rather than "at its deepest"', () => {
    const s = src('plan-prompt.js');
    expect(s.includes("l.leadIsLimit ? `, ${l.leadFt} ft of lead, the most he runs`")).toBe(true);
  });
});

describe('the bag is held to the line once for the day', () => {
  const loadout = { why: 'x', rods: [
    { id: 'R1', lure: DD4, role: 'troll', leadFt: 180 },
    { id: 'R5', lure: 'P-Line Laser Minnow 2oz (PLM2)', role: 'troll', leadFt: 150 },
    { id: 'R6', lure: '3" Lipless Crankbait', role: 'troll', leadFt: 60 },
  ] };

  it('shortens what is past it and leaves the rest alone', () => {
    const { loadout: out } = holdLeadsToTheLine(loadout, byName);
    expect(out.rods.map((r) => r.leadFt)).toEqual([120, 120, 60]);
    expect(out.rods[2]).toBe(loadout.rods[2]);
    expect(out.why).toBe('x');
  });

  it('does not touch the answer it was handed', () => {
    holdLeadsToTheLine(loadout, byName);
    expect(loadout.rods[0].leadFt).toBe(180);
  });

  it('says it once a rod, and says the box depth was never measured on that much line', () => {
    const { notes } = holdLeadsToTheLine(loadout, byName);
    expect(notes.length).toBe(2);
    expect(notes[0]).toBe(`R1: the plan put a ${DD4} on 180 ft of lead, and you run no more than `
      + '120 ft — it goes out on 120 ft. Its box rates it 25-35 ft; nothing the app has measured '
      + 'says how much of that it reaches on 120 ft.');
    // A lead-controlled bait's depth is worked out on the leg from the new lead; no box to quote.
    expect(notes[1]).toBe('R5: the plan put a P-Line Laser Minnow 2oz (PLM2) on 150 ft of lead, '
      + 'and you run no more than 120 ft — it goes out on 120 ft.');
  });

  it('a bag with no rods, or none past the line, comes back as it was', () => {
    expect(holdLeadsToTheLine(null).loadout).toEqual({ rods: [] });
    const ok = { rods: [{ id: 'R6', lure: 'x', leadFt: 60 }] };
    expect(holdLeadsToTheLine(ok).notes).toEqual([]);
    expect(holdLeadsToTheLine(ok).loadout.rods[0]).toBe(ok.rods[0]);
  });
});

describe('the plan, end to end: 180 asked, 120 on the card', () => {
  const RAMP = [-80.7107, 34.3486];
  const piece = (key, lon, lat, holdsFt) => ({
    key, runId: `wateree_lake#${key}`,
    coords: Array.from({ length: 40 }, (_, i) => [lon + i * 0.0004, lat + i * 0.00012]),
    lengthM: 1800, laneLengthM: 4000, holdsFt, near: [], partners: [],
    reasons: { for: ['1.1 mi'], against: [] },
    envelope: Array(20).fill(holdsFt + 2), envelopeStepM: 90, chartedFrac: 1,
  });
  const PICKED = [piece(1, -80.705, 34.350, 45), piece(2, -80.700, 34.345, 45)];
  const TACKLE = TACKLE_INVENTORY.filter((l) => l.trollable).map((l) => l.name);
  const connectionOf = (n) => { const h = byName(n); return h ? connectionFor(h.type) : null; };

  it('every troll entry quotes 120 and the plan says why', async () => {
    const r = await planFromWater({
      picked: PICKED, spots: [], ramp: RAMP, slug: 'wateree_lake', usableAh: 80, windowMin: 480,
      launchTime: '06:30', returnTime: '13:00', tackle: TACKLE, connectionOf, lureByName: byName,
      askModel: async () => JSON.stringify({
        loadout: { rods: [{ id: 'R1', lure: DD4, role: 'troll', leadFt: 180 },
                          { id: 'R6', lure: '3" Lipless Crankbait', role: 'troll', leadFt: 60 }] },
        legs: PICKED.map((p) => ({ runId: p.runId, deploy: { port: 'R1', starboard: 'R6' }, why: 'x' })),
        stops: [], changes: [],
      }),
      planArgs: { water: 'Lake Wateree, SC', ramp: 'Clearwater Cove', date: '2026-07-29',
                  species: ['Striped Bass'], usableAh: 80, tackle: TACKLE, conditions: {} },
    });
    const R1 = r.plan.loadout.rods.find((x) => x.lure === DD4);
    expect(R1.leadFt).toBe(120);
    expect(r.plan.decisions.some((d) => d.includes('on 180 ft of lead, and you run no more than 120 ft'))).toBe(true);
    const leads = planToTimeline(r.plan).timeline.filter((e) => e.type === 'troll')
      .flatMap((e) => e.rods || []).filter((v) => v.lure === DD4).map((v) => Number(v.lead));
    expect(leads.length > 0).toBe(true);
    for (const l of leads) expect(l).toBe(120);
  });

  it('a lead the app works out itself stops at the line too', () => {
    const s = src('plan-assemble.js');
    expect(s.includes('const want = Number.isFinite(full) ? Math.min(full, MAX_LEAD_FT) : null;')).toBe(true);
    expect(s.includes('if (leadFt > MAX_LEAD_FT) {')).toBe(true);
    expect(s.includes('const held = holdLeadsToTheLine(o.loadout, o.lureByName);')).toBe(true);
    expect(s.includes('loadout: held.loadout,')).toBe(true);
  });
});
