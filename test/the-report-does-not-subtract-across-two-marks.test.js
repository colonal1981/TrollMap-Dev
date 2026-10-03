// Personal use only, not for distribution or resale; not for navigation.
//
// 2026-10-03. The card withholds "how far down" when the lake's level and its full pool are measured
// from different marks, because across datums the subtraction can be a foot out or flip sign. The
// printed report did it anyway: Moultrie's 71.6 (a NAVD88 reading) from Marion's 76.8 came out as
// "CAUTION: lake is 5.2 ft below full pool", and Marion and Murray were doing the same. Ryan: "you can
// fix both of those open items".
import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { statedDrawdown, levelSentence } from '../js/utils/water-conditions.js';

const BUILDER = readFileSync(new URL('../js/modules/plan-builder.js', import.meta.url), 'utf8');

describe('how far down, from a saved plan, only when somebody said so', () => {
  it('a stated drawdown is used as it is', () => {
    expect(statedDrawdown({ poolLevel: '72.8', fullPool: '75.5', belowFullPool: '2.74' }))
      .toEqual({ below: 2.74, withheld: false });
    // Chilhowee: feet below full pool and no elevation at all.
    expect(statedDrawdown({ poolLevel: '', fullPool: '', belowFullPool: '1.18' }).below).toBe(1.18);
  });

  it('both numbers with no stated drawdown is the Worker withholding it, and is not subtracted', () => {
    // His saved 10/4 Moultrie plan, verbatim.
    const r = statedDrawdown({ poolLevel: '71.6', fullPool: '76.8', belowFullPool: '' });
    expect(Number.isNaN(r.below)).toBe(true);
    expect(r.withheld).toBe(true);
  });

  it('a file saved before the field existed keeps the old subtraction', () => {
    expect(statedDrawdown({ poolLevel: '357.0', fullPool: '360' })).toEqual({ below: 3, withheld: false });
  });

  it('nothing loaded is nothing, not withheld', () => {
    expect(statedDrawdown({ poolLevel: '', fullPool: '', belowFullPool: '' }))
      .toEqual({ below: NaN, withheld: false });
    expect(statedDrawdown({ poolLevel: '', fullPool: '76.8', belowFullPool: '' }).withheld).toBe(false);
  });
});

describe('the report and the card say so instead', () => {
  it('the go/no-go and the badge read statedDrawdown, and neither subtracts on its own any more', () => {
    expect(BUILDER).toContain('const dd = statedDrawdown(p.meta);');
    expect(BUILDER).toContain('const { below, withheld } = statedDrawdown(p.meta);');
    expect(/poolVal - fullVal/.test(BUILDER)).toBe(false);
    expect(/full - lvl/.test(BUILDER)).toBe(false);
  });

  it('a withheld difference is a note, not a CAUTION', () => {
    expect(BUILDER).toMatch(/\} else if \(dd\.withheld\) \{\s*\/\/[^\n]*\n[^\n]*\n\s*addNote\(/);
  });

  it('the level sentence names why there is no difference', () => {
    // Marion on 2026-10-03: LMES1 on NAVD88 against the registry's 76.8.
    const s = levelSentence({ levelFt: 73.0, fullPoolFt: 76.8, belowFullPoolFt: null,
                              levelSource: 'registry levels: nws:HP' });
    expect(s).toContain('73.00 ft');
    expect(s).toContain('full pool 76.8 ft');
    expect(s).toContain('measured from different marks');
    // and a lake whose difference is earned does not get the sentence
    const m = levelSentence({ levelFt: 72.76, fullPoolFt: 75.5, belowFullPoolFt: 2.74, levelSource: 'x' });
    expect(m).toContain('2.74 ft below full pool');
    expect(m).not.toContain('different marks');
  });
});
