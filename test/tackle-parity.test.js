import { describe, it, expect } from './expect-shim.mjs';
import { TACKLE_INVENTORY } from '../js/data/tackle-inventory.js';
import { LURE_KNOWLEDGE, LURE_COLORS, depthWindow, leadForDepth, canReachDepth } from '../js/data/lure-knowledge.js';
import { TYPE_LABELS } from '../js/modules/tackle-inventory-ui.js';
import { FISHING_STYLE } from '../js/data/fishing-style-profile.js';

/**
 * tackle parity — the tackle system's facts must agree across the files that
 * hold them. Same guard as lake-keys-parity.test.js, for the one data system
 * that never had one.
 *
 * These are NOT behaviour tests. A behaviour test asserts the code matches the
 * data — `getIdealSpeed('crankbait_sr')` returns 2.5 — and would pass happily
 * while 2.5 contradicts the other file that also claims to know. These assert
 * the data matches itself, which is the only way to see a coordination bug from
 * outside the module that has it.
 *
 * Every failure recorded here was found in a real audit on 2026-08-02, not
 * imagined.
 */

const types = [...new Set(TACKLE_INVENTORY.map(l => l.type))];
const trollable = TACKLE_INVENTORY.filter(l => l.trollable);

// ── Debt ledgers ────────────────────────────────────────────────────────────
// Known disagreements, listed so they cannot get WORSE and so the list is
// visible rather than the failure being silent. Shrink these; never add.

// EMPTIED 2026-08-02. The inventory speed copy is deleted, so there is nothing
// to disagree with. Ryan's rule replaced it: speed is a hard limit only for lipped
// baits (3mph), and for everything else the binding constraint is lead length.
const KNOWN_SPEED_DRIFT = new Set([]);

// EMPTIED 2026-08-02 by the depth refactor: the inventory copy of
// presentationSignature is gone, so there is nothing left to disagree.
const KNOWN_SIGNATURE_DRIFT = new Set([]);

// EMPTIED 2026-08-02: LURE_DIVE_DEPTHS is deleted. Depth comes from the type.
const KNOWN_NO_DIVE_ENTRY = new Set([]);

describe('tackle inventory — internal integrity', () => {
  it('has no duplicate ids', () => {
    const ids = TACKLE_INVENTORY.map(l => l.id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  it('every entry has an id, a name and a type', () => {
    for (const l of TACKLE_INVENTORY) {
      expect(l.id, JSON.stringify(l)).toBeTruthy();
      expect(l.name, l.id).toBeTruthy();
      expect(l.type, l.id).toBeTruthy();
    }
  });

  it('no two entries share a name (names are used as keys elsewhere)', () => {
    const names = TACKLE_INVENTORY.map(l => l.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes).toEqual([]);
  });
});

describe('tackle parity — every type resolves in all three tables', () => {
  // The 2026-08-02 audit found five types missing from TYPE_LABELS alone
  // (underspin, spoon_casting, jig_football, jig_finesse_ned, popping_cork),
  // which rendered a blank Type column in the panel with no error anywhere.

  it('every inventory type has a LURE_KNOWLEDGE block', () => {
    expect(types.filter(t => !LURE_KNOWLEDGE[t])).toEqual([]);
  });

  it('every inventory type has a LURE_COLORS entry', () => {
    expect(types.filter(t => !LURE_COLORS[t])).toEqual([]);
  });

  it('every inventory type has a TYPE_LABELS entry', () => {
    expect(types.filter(t => !TYPE_LABELS[t])).toEqual([]);
  });

  it('every LURE_KNOWLEDGE type is owned by at least one lure', () => {
    // Catches the reverse mistake: a type added to knowledge and then never
    // used, which looks like coverage but is dead weight.
    const orphans = Object.keys(LURE_KNOWLEDGE).filter(t => !types.includes(t));
    expect(orphans).toEqual([]);
  });

  it('every LURE_COLORS clarity map has all three keys', () => {
    for (const [t, m] of Object.entries(LURE_COLORS)) {
      expect(Object.keys(m).sort(), t).toEqual(['clear', 'muddy', 'stained']);
    }
  });
});

describe('speed model — hard limits only where physics breaks', () => {
  it('no inventory entry carries a troll speed any more', () => {
    const stragglers = TACKLE_INVENTORY.filter(l => 'trollSpeedMin' in l || 'trollSpeedMax' in l);
    expect(stragglers.map(l => l.id)).toEqual([]);
  });

  it('every type declares whether its speed limit is hard', () => {
    for (const [t, k] of Object.entries(LURE_KNOWLEDGE)) {
      expect(typeof k.speedIsHardLimit, t).toBe('boolean');
    }
  });

  it('no lipped bait is allowed past 3mph — above that it leaves its rated depth', () => {
    for (const [t, k] of Object.entries(LURE_KNOWLEDGE)) {
      if (k.depthMode !== 'rated') continue;
      expect(k.speed.max, t).toBeLessThanOrEqual(3.0);
      expect(k.speedIsHardLimit, t).toBe(true);
    }
  });

  it('lead-controlled baits do NOT impose a hard speed limit', () => {
    for (const [t, k] of Object.entries(LURE_KNOWLEDGE)) {
      if (k.depthMode !== 'lead' || !k.speed) continue;
      expect(k.speedIsHardLimit, t).toBe(false);
    }
  });

  it('speed windows are internally sane (min <= ideal <= max)', () => {
    for (const [t, k] of Object.entries(LURE_KNOWLEDGE)) {
      if (!k.speed) continue;                 // cast-only types are never trolled
      expect(k.speed.min, t).toBeLessThanOrEqual(k.speed.ideal);
      expect(k.speed.ideal, t).toBeLessThanOrEqual(k.speed.max);
    }
  });

  it('canReachDepth reports lead as the binding constraint, not speed', () => {
    const bucktail = TACKLE_INVENTORY.find(l => l.id === 'bucktail_1oz');
    const fast = canReachDepth(bucktail, 20, 2.8, { maxLeadFt: 120 });
    expect(fast.limitedBy, 'a bucktail is never speed-limited').not.toBe('speed');
    const tooDeep = canReachDepth(bucktail, 40, 1.8, { maxLeadFt: 120 });
    expect(tooDeep.ok).toBe(false);
    expect(tooDeep.limitedBy).toBe('lead');

    const sr = TACKLE_INVENTORY.find(l => l.id === 'cb_sr');
    expect(canReachDepth(sr, 4, 3.4, { maxLeadFt: 120 }).limitedBy).toBe('speed');
    expect(canReachDepth(sr, 20, 2.0, { maxLeadFt: 120 }).limitedBy).toBe('rating');
    expect(canReachDepth(sr, 4, 2.5, { maxLeadFt: 120 }).ok).toBe(true);
  });
});

describe('depth model — one source, four modes', () => {
  // Depth used to live in tackle-inventory.js, lure-knowledge.js AND
  // spread-builder.js's LURE_DIVE_DEPTHS (keyed by display name, so a rename
  // silently orphaned it — which happened). Now it lives once, on the type.

  it('no inventory entry carries a dive depth any more', () => {
    const stragglers = TACKLE_INVENTORY.filter(l => 'diveDepthMin' in l || 'diveDepthMax' in l);
    expect(stragglers.map(l => l.id)).toEqual([]);
  });

  it('no inventory entry carries a presentationSignature any more', () => {
    const stragglers = TACKLE_INVENTORY.filter(l => 'presentationSignature' in l);
    expect(stragglers.map(l => l.id)).toEqual([]);
  });

  // 'none' is the fourth, added 2026-08-30. A cast-only soft plastic has no trolling depth at
  // all -- it planes at 2 mph -- and `depthMode: 'lead'` had it answering "80 ft of lead runs to
  // 15 ft" for a Fluke. Ryan: "and if it is weightless you think a fluke at 2mph is even going to
  // sink?" A band and a lead ratio are both meaningless for it, so it carries neither.
  it('every type declares a depthMode, and only rated/surface carry a band', () => {
    for (const [t, k] of Object.entries(LURE_KNOWLEDGE)) {
      expect(['rated', 'lead', 'surface', 'none'], t).toContain(k.depthMode);
      if (k.depthMode === 'lead' || k.depthMode === 'none') expect(k.ratedDepth, t).toBeNull();
      else expect(k.ratedDepth, t).toBeTruthy();
    }
  });

  it('every lead-controlled type has a leadRatio, and no other type does', () => {
    for (const [t, k] of Object.entries(LURE_KNOWLEDGE)) {
      if (k.depthMode === 'surface') continue;
      if (k.depthMode === 'none') { expect(k.leadRatio, t).toBeNull(); continue; }
      expect(k.leadRatio, t).toBeDefined();
    }
  });

  it('a mode-none type is never trollable in the inventory', () => {
    // The two must agree or one of them is lying about the same bait.
    for (const l of TACKLE_INVENTORY) {
      if (LURE_KNOWLEDGE[l.type]?.depthMode === 'none') expect(l.trollable, l.id).toBe(false);
    }
  });

  it('leadForDepth is monotonic in depth and never negative', () => {
    for (const l of trollable) {
      let prev = -1;
      for (const d of [2, 5, 10, 15, 20, 30, 40]) {
        const lead = leadForDepth(l, d, 1.8);
        expect(lead, `${l.id} @${d}ft`).toBeGreaterThanOrEqual(0);
        if (LURE_KNOWLEDGE[l.type].depthMode !== 'surface') {
          expect(lead, `${l.id} @${d}ft`).toBeGreaterThanOrEqual(prev);
        }
        prev = lead;
      }
    }
  });

  it('rated baits report their printed band regardless of lead', () => {
    for (const l of trollable) {
      const k = LURE_KNOWLEDGE[l.type];
      if (k.depthMode !== 'rated') continue;
      const a = depthWindow(l, { speedMph: 1.4, leadFt: 20 });
      const b = depthWindow(l, { speedMph: 2.6, leadFt: 200 });
      expect(a, l.id).toEqual(b);
      expect(a.min, l.id).toBe(k.ratedDepth.min);
    }
  });

  it('a rated bait is never leaded past its bill', () => {
    for (const l of trollable) {
      const k = LURE_KNOWLEDGE[l.type];
      if (k.depthMode !== 'rated') continue;
      const atMax  = leadForDepth(l, k.ratedDepth.max, 1.8);
      const absurd = leadForDepth(l, 60, 1.8);
      expect(absurd, `${l.id} asked for 60ft`).toBe(atMax);
    }
  });

  it('lead-controlled baits round-trip depth -> lead -> depth', () => {
    for (const l of trollable) {
      if (LURE_KNOWLEDGE[l.type].depthMode !== 'lead') continue;
      for (const d of [8, 15, 25, 35]) {
        const lead = leadForDepth(l, d, 1.8);
        const back = depthWindow(l, { speedMph: 1.8, leadFt: lead });
        expect(back.min, `${l.id} @${d}ft -> ${lead}ft lead`).toBeLessThanOrEqual(d);
        expect(back.max, `${l.id} @${d}ft -> ${lead}ft lead`).toBeGreaterThanOrEqual(d);
      }
    }
  });
});

describe('gear profile — the checklist must not assert equipment that is not owned', () => {
  // safety-checklist.js used to hardcode a drift sock, an anchor trolley, a 30ft
  // rope, a re-entry ladder and a dry suit. Ryan owns none of those. It now
  // reads FISHING_STYLE.gear; these assert the keys it reads exist.
  const REQUIRED = [
    'stakeoutPoleFt', 'anchorRopeFt', 'maxStationaryDepthFt', 'driftSock',
    'sternLight360', 'headlamp', 'whistle', 'pfd',
    'drySuit', 'wadersWithBelt', 'selfRescueLadder', 'spareClothes',
  ];

  it('FISHING_STYLE.gear exists and has every key the checklist reads', () => {
    expect(FISHING_STYLE.gear).toBeTruthy();
    expect(REQUIRED.filter(k => !(k in FISHING_STYLE.gear))).toEqual([]);
  });

  it('stationary depth is consistent with the rope and pole actually owned', () => {
    const g = FISHING_STYLE.gear;
    expect(g.maxStationaryDepthFt).toBeLessThanOrEqual(g.anchorRopeFt);
    expect(g.stakeoutPoleFt).toBeLessThan(g.maxStationaryDepthFt);
  });
});
