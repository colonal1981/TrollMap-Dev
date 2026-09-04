import { describe, it, expect } from './expect-shim.mjs';
import { seasonalSwingFt, tvaShape, usaceShape } from '../Worker/conditions.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SEASONAL DRAWDOWN IS NOT A DUKE FACT
//
// Ryan, 2026-09-04: "why only duke... i am still confused there".
//
// `seasonalDrawdownFt` is a line researchIntel() prints, and its only producer was
// dukePoolManagement() -- the swing in Duke's monthly target index, computed on the research path
// and nowhere else. So a Duke lake could carry it and Hartwell, Thurmond, Cherokee and Douglas
// could not, on a number their operators publish just as plainly.
//
// All three publish a seasonal curve, and Worker/conditions.js already parsed all three:
//
//   Duke    /lakes/operating-range     monthly target index      dukePoolManagement()
//   TVA     guide.items[].GuideCurve   a set point per day       tvaShape()
//   USACE   Top of Conservation        seasonal-values[].value   usaceSeasonalValue()
//
// One pure function asks each of them the same question: how far apart are the highest and lowest
// targets across the year.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('seasonalSwingFt — one question, three feeds', () => {
  it('is the distance between the highest and lowest target', () => {
    expect(seasonalSwingFt([656, 656, 660, 660, 656])).toBe(4);
  });

  it('says 0 for a lake held flat, because that is the answer and not an absence', () => {
    expect(seasonalSwingFt([100, 100, 100])).toBe(0);
  });

  it('refuses to call one set point a curve', () => {
    expect(seasonalSwingFt([660])).toBe(null);
    expect(seasonalSwingFt([])).toBe(null);
    expect(seasonalSwingFt(null)).toBe(null);
  });

  it('drops a missing set point instead of reading it as zero feet', () => {
    // `Number(null)` IS 0 and 0 is a finite elevation, so a coerced gap becomes the lowest target
    // of the year and Hartwell's 4 ft drawdown reads as 660. Fourth occurrence of this trap here
    // and it is a standing rule.
    expect(seasonalSwingFt([656, null, 'x', 660])).toBe(4);
    expect(seasonalSwingFt([656, undefined, '', 660])).toBe(4);
    expect(seasonalSwingFt([656, true, 660])).toBe(4);
  });
});

describe('TVA reads the whole year of its guide curve, not just today', () => {
  const guide = { items: [
    { Day: '01/15/2026', GuideCurve: '1370.0' },
    { Day: '06/15/2026', GuideCurve: '1382.0' },
    { Day: '12/15/2026', GuideCurve: '1372.5' },
  ] };

  it('reports the swing across the set points', () => {
    expect(tvaShape([], guide, [], [], '06/15', null).seasonal_drawdown_ft).toBe(12);
  });

  it('and still reports today, which is a different question', () => {
    expect(tvaShape([], guide, [], [], '06/15', null).guide_curve_ft).toBe(1382);
  });
});

describe("USACE reads Top of Conservation's own set points", () => {
  // Hartwell: 656 in winter, 660 from April to mid-October. "October 15" is expressed as
  // month 9 + 20160 minutes, which is exactly 14 days — see usaceSeasonalValue().
  const levels = [{
    'location-level-id': 'Hartwell.Elev.Inst.0.Top of Conservation',
    'specified-level-id': 'Top of Conservation',
    'office-id': 'SAS',
    'interval-origin': '2026-01-01T00:00:00Z',
    'interpolate-string': 'T',
    'seasonal-values': [
      { 'offset-months': 0, 'offset-minutes': 0, value: 656 },
      { 'offset-months': 3, 'offset-minutes': 0, value: 660 },
      { 'offset-months': 9, 'offset-minutes': 20160, value: 656 },
    ],
  }];

  it('reports the 4 ft swing that was in the level all along', () => {
    expect(usaceShape(levels, 'Hartwell', Date.parse('2026-07-01T12:00:00Z')).seasonal_drawdown_ft)
      .toBe(4);
  });

  it("and today's target is still read off the curve, interpolated where the level says to", () => {
    // July 1 sits between April 1 (660) and Oct 15 (656) with interpolate-string "T", so 658.14
    // is the curve being read correctly rather than a set point being held.
    expect(usaceShape(levels, 'Hartwell', Date.parse('2026-07-01T12:00:00Z')).conservation_pool_ft)
      .toBe(658.14);
  });

  it('a project with no Top of Conservation reports no swing rather than zero', () => {
    const only = [{ 'location-level-id': 'X.Elev.Inst.0.Bottom of Conservation',
                    'specified-level-id': 'Bottom of Conservation', 'office-id': 'SAS',
                    'constant-value': 620 }];
    expect(usaceShape(only, 'X', Date.now()).seasonal_drawdown_ft).toBe(null);
  });
});
