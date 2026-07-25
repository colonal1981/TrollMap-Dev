import { describe, it, expect } from 'vitest';
import {
  parseNoaaTime,
  toNoaaDate,
  interpolateHeight,
  classifyStage,
  stageLabel,
  tideAdjustedDepth,
} from '../js/modules/tide-engine.js';

// Helper: build an hourly prediction series like CO-OPS returns.
function hourly(dateStr, values, startHour = 0) {
  return values.map((v, i) => ({
    t: `${dateStr} ${String(startHour + i).padStart(2, '0')}:00`,
    v: String(v),
  }));
}

describe('parseNoaaTime', () => {
  it('parses CO-OPS local time as local wall-clock', () => {
    const d = parseNoaaTime('2026-07-24 14:30');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(6); // July
    expect(d.getDate()).toBe(24);
    expect(d.getHours()).toBe(14);
    expect(d.getMinutes()).toBe(30);
  });

  it('tolerates ISO-style T separator', () => {
    expect(parseNoaaTime('2026-07-24T06:00').getHours()).toBe(6);
  });

  it('returns null on junk rather than an Invalid Date', () => {
    expect(parseNoaaTime('')).toBeNull();
    expect(parseNoaaTime(null)).toBeNull();
    expect(parseNoaaTime('not a time')).toBeNull();
  });
});

describe('toNoaaDate', () => {
  it('strips dashes for the CO-OPS begin_date param', () => {
    expect(toNoaaDate('2026-07-24')).toBe('20260724');
  });
});

describe('interpolateHeight — continuous tide height', () => {
  const day = '2026-07-24';

  it('returns the exact value at a sample point', () => {
    const series = hourly(day, [1.0, 2.0, 3.0]);
    expect(interpolateHeight(series, parseNoaaTime(`${day} 01:00`))).toBeCloseTo(2.0, 6);
  });

  it('interpolates linearly at the midpoint', () => {
    const series = hourly(day, [2.0, 4.0]);
    const mid = parseNoaaTime(`${day} 00:30`);
    expect(interpolateHeight(series, mid)).toBeCloseTo(3.0, 6);
  });

  it('interpolates at an arbitrary fraction', () => {
    const series = hourly(day, [0.0, 4.0]);
    const q = parseNoaaTime(`${day} 00:15`);
    expect(interpolateHeight(series, q)).toBeCloseTo(1.0, 6);
  });

  it('handles falling tide (negative slope)', () => {
    const series = hourly(day, [5.0, 1.0]);
    expect(interpolateHeight(series, parseNoaaTime(`${day} 00:30`))).toBeCloseTo(3.0, 6);
  });

  it('handles below-datum negative heights on a spring low', () => {
    const series = hourly(day, [-0.5, -1.5]);
    expect(interpolateHeight(series, parseNoaaTime(`${day} 00:30`))).toBeCloseTo(-1.0, 6);
  });

  it('returns null outside the series instead of extrapolating', () => {
    const series = hourly(day, [1.0, 2.0], 6); // 06:00 and 07:00 only
    expect(interpolateHeight(series, parseNoaaTime(`${day} 03:00`))).toBeNull();
    expect(interpolateHeight(series, parseNoaaTime(`${day} 23:00`))).toBeNull();
  });

  it('is robust to unsorted input', () => {
    const series = [
      { t: `${day} 02:00`, v: '3.0' },
      { t: `${day} 00:00`, v: '1.0' },
      { t: `${day} 01:00`, v: '2.0' },
    ];
    expect(interpolateHeight(series, parseNoaaTime(`${day} 01:30`))).toBeCloseTo(2.5, 6);
  });

  it('degrades to null on empty or malformed input', () => {
    expect(interpolateHeight([], new Date())).toBeNull();
    expect(interpolateHeight(null, new Date())).toBeNull();
    expect(interpolateHeight(hourly(day, [1, 2]), null)).toBeNull();
  });
});

describe('classifyStage — flood / ebb / slack', () => {
  const day = '2026-07-24';
  // A realistic semidiurnal day: low 03:00, high 09:00, low 15:00, high 21:00
  const hilo = [
    { t: `${day} 03:00`, v: '0.2', type: 'L' },
    { t: `${day} 09:00`, v: '5.4', type: 'H' },
    { t: `${day} 15:00`, v: '0.4', type: 'L' },
    { t: `${day} 21:00`, v: '5.1', type: 'H' },
  ];

  it('rising toward a high is flood', () => {
    expect(classifyStage(hilo, parseNoaaTime(`${day} 06:00`))).toBe('flood');
  });

  it('falling toward a low is ebb', () => {
    expect(classifyStage(hilo, parseNoaaTime(`${day} 12:00`))).toBe('ebb');
  });

  it('near a high turn is high slack', () => {
    expect(classifyStage(hilo, parseNoaaTime(`${day} 09:00`))).toBe('high');
    expect(classifyStage(hilo, parseNoaaTime(`${day} 09:30`))).toBe('high');
    expect(classifyStage(hilo, parseNoaaTime(`${day} 08:30`))).toBe('high');
  });

  it('near a low turn is low slack', () => {
    expect(classifyStage(hilo, parseNoaaTime(`${day} 15:00`))).toBe('low');
    expect(classifyStage(hilo, parseNoaaTime(`${day} 14:20`))).toBe('low');
  });

  it('outside the slack window resumes flood/ebb', () => {
    // 46+ min after the 09:00 high -> ebbing toward the 15:00 low
    expect(classifyStage(hilo, parseNoaaTime(`${day} 10:00`))).toBe('ebb');
    // 46+ min after the 03:00 low -> flooding toward the 09:00 high
    expect(classifyStage(hilo, parseNoaaTime(`${day} 04:00`))).toBe('flood');
  });

  it('infers stage after the final event of the series', () => {
    // After the last high, water must be falling.
    expect(classifyStage(hilo, parseNoaaTime(`${day} 23:30`))).toBe('ebb');
  });

  it('returns null on empty input', () => {
    expect(classifyStage([], new Date())).toBeNull();
    expect(classifyStage(null, new Date())).toBeNull();
  });
});

describe('stageLabel', () => {
  it('labels every stage and degrades quietly', () => {
    expect(stageLabel('flood')).toMatch(/Flood/);
    expect(stageLabel('ebb')).toMatch(/Ebb/);
    expect(stageLabel('high')).toMatch(/High/);
    expect(stageLabel('low')).toMatch(/Low/);
    expect(stageLabel(null)).toBe('');
  });
});

describe('tideAdjustedDepth — MLLW correction', () => {
  it('adds a positive tide to the charted depth', () => {
    // 4ft charted at MLLW with 2.5ft of tide = 6.5ft under the keel
    expect(tideAdjustedDepth(4, 2.5)).toBeCloseTo(6.5, 6);
  });

  it('subtracts a below-datum negative tide', () => {
    expect(tideAdjustedDepth(4, -0.8)).toBeCloseTo(3.2, 6);
  });

  it('falls back to the conservative charted depth when tide is unknown', () => {
    // Degrading to MLLW is the safe direction: it under-reports water.
    expect(tideAdjustedDepth(4, null)).toBe(4);
    expect(tideAdjustedDepth(4, undefined)).toBe(4);
    expect(tideAdjustedDepth(4, NaN)).toBe(4);
  });

  it('returns null when the charted depth itself is unusable', () => {
    expect(tideAdjustedDepth(null, 2)).toBeNull();
    expect(tideAdjustedDepth(undefined, 2)).toBeNull();
    expect(tideAdjustedDepth('deep', 2)).toBeNull();
  });

  it('accepts numeric strings from geojson properties', () => {
    expect(tideAdjustedDepth('6', '1.5')).toBeCloseTo(7.5, 6);
  });
});
