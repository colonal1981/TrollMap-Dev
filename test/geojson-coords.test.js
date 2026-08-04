/**
 * test/geojson-coords.test.js — the bounding box, and the 3D case the old heuristic got wrong.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * The case that matters is `an even number of 3D positions`. Both retired implementations
 * decided a coordinate stream was 3D only when its number count divided by three and NOT by
 * two. Six positions with altitude is eighteen numbers, and eighteen divides by both — so they
 * stepped through it two numbers at a time, pairing a latitude with the next longitude, and
 * returned a box built from points that do not exist. This project's own pipeline emits
 * MultiPolygon Z, so that was not a hypothetical shape.
 */
import { describe, it, expect } from './expect-shim.mjs';
import { boundsOf, collectPositions, forEachPosition } from '../js/utils/geojson-coords.js';

// A real-ish SC lake footprint, kept small enough to check by eye.
const RING_2D = [[-81.20, 34.05], [-81.10, 34.05], [-81.10, 34.15], [-81.20, 34.15], [-81.20, 34.05]];
const RING_3D = RING_2D.map(([x, y]) => [x, y, 0.0]);

describe('boundsOf — 2D geometry', () => {
  it('a bare Polygon', () => {
    expect(boundsOf({ type: 'Polygon', coordinates: [RING_2D] }))
      .toEqual({ west: -81.20, south: 34.05, east: -81.10, north: 34.15 });
  });

  it('a Feature wrapping it', () => {
    const f = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [RING_2D] } };
    expect(boundsOf(f)).toEqual({ west: -81.20, south: 34.05, east: -81.10, north: 34.15 });
  });

  it('a FeatureCollection spanning two disjoint polygons', () => {
    const far = RING_2D.map(([x, y]) => [x + 1, y + 1]);
    const fc = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Polygon', coordinates: [RING_2D] } },
        { type: 'Feature', geometry: { type: 'Polygon', coordinates: [far] } },
      ],
    };
    expect(boundsOf(fc)).toEqual({ west: -81.20, south: 34.05, east: -80.10, north: 35.15 });
  });
});

describe('boundsOf — 3D geometry, including the count the old heuristic misread', () => {
  it('a 5-position 3D ring (15 numbers — the old code got this one right)', () => {
    // 15 % 3 === 0 and 15 % 2 !== 0, so the retired heuristic chose stride 3 correctly.
    expect(boundsOf({ type: 'Polygon', coordinates: [RING_3D] }))
      .toEqual({ west: -81.20, south: 34.05, east: -81.10, north: 34.15 });
  });

  it('a 6-position 3D ring (18 numbers — the old code got this one WRONG)', () => {
    // THE REGRESSION. 18 % 3 === 0 but 18 % 2 === 0 as well, so `% 2 !== 0` failed and the
    // stream was read two numbers at a time: (-81.20, 34.05), (0, -81.10), (34.05, 0), …
    // Latitudes and altitudes became longitudes. The box that came out spanned zero.
    const ring6 = [
      [-81.20, 34.05, 0.0], [-81.15, 34.05, 0.0], [-81.10, 34.10, 0.0],
      [-81.10, 34.15, 0.0], [-81.20, 34.15, 0.0], [-81.20, 34.05, 0.0],
    ];
    const b = boundsOf({ type: 'Polygon', coordinates: [ring6] });
    expect(b).toEqual({ west: -81.20, south: 34.05, east: -81.10, north: 34.15 });

    // Everything stays in its own hemisphere: no altitude leaked into a coordinate.
    expect(b.west < -80 && b.east < -80).toBe(true);
    expect(b.south > 33 && b.north < 35).toBe(true);
  });

  it('MultiPolygon Z with a hole — the shape the 3DHP pipeline emits', () => {
    const hole = [[-81.18, 34.07, 0.0], [-81.12, 34.07, 0.0], [-81.12, 34.13, 0.0], [-81.18, 34.07, 0.0]];
    const mp = { type: 'MultiPolygon', coordinates: [[RING_3D, hole]] };
    // A hole is inside the outer ring, so it must not move the box.
    expect(boundsOf(mp)).toEqual({ west: -81.20, south: 34.05, east: -81.10, north: 34.15 });
  });

  it('altitude is dropped, not returned as a coordinate', () => {
    const pts = collectPositions({ type: 'Polygon', coordinates: [RING_3D] });
    expect(pts.every((p) => p.length === 2)).toBe(true);
    expect(pts[0]).toEqual([-81.20, 34.05]);
  });
});

describe('boundsOf — nothing usable means null, not a box at the origin', () => {
  const empties = [
    ['null', null],
    ['undefined', undefined],
    ['an empty FeatureCollection', { type: 'FeatureCollection', features: [] }],
    ['a Feature with no geometry', { type: 'Feature', properties: {}, geometry: null }],
    ['a Polygon with an empty ring', { type: 'Polygon', coordinates: [[]] }],
    ['a string', 'not geojson'],
  ];
  for (const [label, value] of empties) {
    it(`${label} -> null`, () => {
      // Callers divide by the span to pick a tile size. A {0,0,0,0} box divides by zero;
      // null makes them take their own "no boundary" branch.
      expect(boundsOf(value)).toBe(null);
    });
  }

  it('a malformed member does not lose its healthy siblings', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: null },
        { type: 'Feature', geometry: { type: 'Polygon', coordinates: [RING_2D] } },
      ],
    };
    expect(boundsOf(fc)).toEqual({ west: -81.20, south: 34.05, east: -81.10, north: 34.15 });
  });

  it('non-finite coordinates are skipped rather than poisoning the box', () => {
    const bad = { type: 'MultiPoint', coordinates: [[NaN, 34.1], [-81.15, 34.10]] };
    expect(boundsOf(bad)).toEqual({ west: -81.15, south: 34.10, east: -81.15, north: 34.10 });
  });
});

describe('forEachPosition — every geometry type reaches the callback', () => {
  const cases = [
    ['Point', { type: 'Point', coordinates: [-81.1, 34.1] }, 1],
    ['MultiPoint', { type: 'MultiPoint', coordinates: [[-81.1, 34.1], [-81.2, 34.2]] }, 2],
    ['LineString', { type: 'LineString', coordinates: RING_2D }, 5],
    ['MultiLineString', { type: 'MultiLineString', coordinates: [RING_2D, RING_2D] }, 10],
    ['Polygon', { type: 'Polygon', coordinates: [RING_2D] }, 5],
    ['MultiPolygon', { type: 'MultiPolygon', coordinates: [[RING_2D]] }, 5],
    ['GeometryCollection', {
      type: 'GeometryCollection',
      geometries: [{ type: 'Point', coordinates: [-81.1, 34.1] }, { type: 'Polygon', coordinates: [RING_2D] }],
    }, 6],
  ];
  for (const [label, geo, expected] of cases) {
    it(`${label} yields ${expected} position(s)`, () => {
      let n = 0;
      forEachPosition(geo, () => n++);
      expect(n).toBe(expected);
    });
  }
});
