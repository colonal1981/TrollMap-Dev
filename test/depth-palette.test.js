import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DEPTH_BANDS, depthColor, depthLegend } from '../js/utils/depth-palette.js';
import { displayDepth, setDisplayTide, getDisplayTide, isTideCorrected } from '../js/modules/tide-engine.js';

const JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'js');

describe('one depth ladder', () => {
  it('gives the same colour to the same depth, whichever layer asks', () => {
    // The bug, concretely: at 15 ft the polygon drew #e9c46a, the contour drew #f4a261 and a
    // sounding drew #4fc3f7. Three layers, three answers, one depth.
    for (const ft of [1, 3, 6, 15, 24, 30, 40, 50, 60, 90]) {
      expect(depthColor(ft)).toBe(depthColor(ft));
    }
    expect(depthColor(15)).toBe('#f4a261');
  });

  it('keeps every deep-water threshold the freshwater table had', () => {
    // Ryan approved a finer SHALLOW end, not a repaint of water he already reads fine.
    for (const [ft, color] of [[20, '#f4a261'], [28, '#e9c46a'], [36, '#2a9d8f'],
                               [45, '#00e5ff'], [55, '#0077b6'], [65, '#7b2d8b']]) {
      expect(depthColor(ft)).toBe(color);
      expect(depthColor(ft + 0.1)).not.toBe(color);
    }
    expect(depthColor(200)).toBe('#ffffff');
  });

  it('splits the old single red band on the soundings 2/4/8 ft breaks', () => {
    // Everything under 10 ft used to be one flat red, which is the exact range where a kayak
    // decision gets made.
    const shallow = [depthColor(1), depthColor(3), depthColor(6)];
    expect(new Set(shallow).size).toBe(3);
    expect(depthColor(1.9)).toBe(depthColor(2));
    expect(depthColor(2.1)).toBe(depthColor(4));
  });

  it('bands are ordered and cover every depth', () => {
    let prev = -Infinity;
    for (const b of DEPTH_BANDS) {
      expect(b.max > prev).toBe(true);
      prev = b.max;
    }
    expect(DEPTH_BANDS[DEPTH_BANDS.length - 1].max).toBe(Infinity);
  });

  it('a missing depth reads as unsurveyed, not as a hole', () => {
    for (const v of [null, undefined, NaN, 'deep']) {
      expect(depthColor(v)).toBe('#ffffff');
    }
  });

  it('the legend covers the ladder with no gaps', () => {
    const rows = depthLegend();
    expect(rows.length).toBe(DEPTH_BANDS.length);
    expect(rows[0].min).toBe(0);
    for (let i = 1; i < rows.length; i++) expect(rows[i].min).toBe(rows[i - 1].max);
  });
});

describe('one tide rule', () => {
  it('a lake never tide-corrects, even with a tide set', () => {
    // The failure this guards: a stale coastal tide leaking onto Murray adds feet to every
    // contour, and the only symptom is depths that look slightly generous.
    setDisplayTide(5);
    expect(displayDepth(12, false)).toBe(12);
    expect(displayDepth(12, true)).toBe(17);
    setDisplayTide(null);
  });

  it('tidal water falls back to charted MLLW when tides have not synced', () => {
    setDisplayTide(null);
    expect(isTideCorrected()).toBe(false);
    expect(displayDepth(8, true)).toBe(8);
  });

  it('a below-datum spring low subtracts', () => {
    setDisplayTide(-1.5);
    expect(displayDepth(6, true)).toBe(4.5);
    setDisplayTide(null);
  });

  it('setDisplayTide rejects junk rather than turning it into zero', () => {
    setDisplayTide(3);
    expect(getDisplayTide()).toBe(3);
    setDisplayTide('high');
    expect(getDisplayTide()).toBe(null);
    expect(displayDepth(6, true)).toBe(6);
  });

  it('no depth means no depth, not zero feet of water', () => {
    setDisplayTide(4);
    expect(displayDepth(null, true)).toBe(null);
    expect(displayDepth('', true)).toBe(null);
    expect(displayDepth(null, false)).toBe(null);
    setDisplayTide(null);
  });

  it('colour and label agree once both go through the same pair', () => {
    setDisplayTide(4);
    const charted = 3;
    const shown = displayDepth(charted, true);
    expect(shown).toBe(7);
    expect(depthColor(shown)).toBe(depthColor(7));
    expect(depthColor(shown)).not.toBe(depthColor(charted));
    setDisplayTide(null);
  });
});

describe('no layer keeps its own palette or its own tide any more', () => {
  const read = (p) => readFileSync(path.join(JS, p), 'utf8');

  it('the three private band tables are gone', () => {
    expect(read('modules/contour-data.js')).not.toContain('const DEPTH_COLORS = [');
    const sup = read('modules/supplemental-layers.js');
    expect(sup).not.toContain('const DEPTH_BANDS = [');
    expect(sup).not.toContain('const DEPTH_BANDS_COASTAL = [');
  });

  it('soundings no longer hardcode their own thresholds', () => {
    const src = read('modules/coastal-layers.js');
    expect(src).not.toContain("shown < 2  ? '#e53935'");
    expect(src).toContain('depthColor(shown)');
  });

  it('nobody adds a tide height by hand any more', () => {
    // `chartedFt + _coastalTideHeightFt` existed in two places; both are displayDepth() now.
    const sup = read('modules/supplemental-layers.js');
    expect(sup).not.toContain('chartedFt + _coastalTideHeightFt');
  });

  it('every depth-drawing module imports the shared palette', () => {
    for (const f of ['modules/contour-data.js', 'modules/supplemental-layers.js',
                     'modules/coastal-layers.js']) {
      expect(read(f)).toContain("depth-palette.js");
    }
  });
});
