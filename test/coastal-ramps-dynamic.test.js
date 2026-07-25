import { describe, it, expect } from 'vitest';
import { COASTAL_ZONES } from '../js/data/coastal-zones.js';

describe('Coastal Ramps Dynamic Mapping', () => {
  it('identifies coordinates within coastal zone bboxes correctly', () => {
    // Charleston Harbor, SC
    const charleston = COASTAL_ZONES['coast_charleston_sc'];
    expect(charleston).toBeDefined();
    const [[south, west], [north, east]] = charleston.bbox;

    // A point inside Charleston Harbor (e.g. Shem Creek coordinates)
    const latIn = 32.795;
    const lonIn = -79.883;
    expect(latIn).toBeGreaterThanOrEqual(south);
    expect(latIn).toBeLessThanOrEqual(north);
    expect(lonIn).toBeGreaterThanOrEqual(west);
    expect(lonIn).toBeLessThanOrEqual(east);

    // A point outside Charleston Harbor (e.g. in the ocean/different zone)
    const latOut = 35.0;
    const lonOut = -76.0;
    const isInside = latOut >= south && latOut <= north && lonOut >= west && lonOut <= east;
    expect(isInside).toBe(false);
  });
});
