import { describe, it, expect } from './expect-shim.mjs';
import { COASTAL_ZONES } from '../js/data/coastal-zones.js';
import { landOnCoastalZone, COASTAL_LANDING_ZOOM, focusRamp, RAMP_MIN_ZOOM }
  from '../js/utils/viewport-cull.js';

// Selecting a coastal zone used to fitBounds() its clip rectangle, which put the whole 56,000
// feature pack on screen. It now lands at a fixed zoom -- and the first version of that landed
// on the MIDDLE OF THE BOX, so "Murrells Inlet" showed Myrtle Beach, 20.5 km up the coast.
//
// A bbox midpoint is not a place. It is an artifact of where the clip happened to be cut, and
// on five of the 22 zones it is more than 5 km from the water the zone is named after -- all
// five of them SC zones. Every zone already carries a hand-set `center`; use it.

function fakeMap() {
  const calls = [];
  return { calls, setView: (c, z) => calls.push({ center: c, zoom: z }) };
}

function bboxMid(bbox) {
  const [[s, w], [n, e]] = bbox;
  return [(s + n) / 2, (w + e) / 2];
}

function km([aLat, aLon], [bLat, bLon]) {
  const R = 6371, r = Math.PI / 180;
  const h = Math.sin((bLat - aLat) * r / 2) ** 2 +
            Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin((bLon - aLon) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

describe('coastal landing lands on the zone, not on its clip box', () => {
  it('every zone has a center, and it sits inside its own bbox', () => {
    const bad = [];
    for (const [slug, z] of Object.entries(COASTAL_ZONES)) {
      const c = z.center;
      if (!Array.isArray(c) || c.length < 2 || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) {
        bad.push(`${slug}: no usable center`);
        continue;
      }
      const [[s, w], [n, e]] = z.bbox;
      if (c[0] < s || c[0] > n || c[1] < w || c[1] > e) bad.push(`${slug}: center outside bbox`);
    }
    expect(bad).toEqual([]);
  });

  it('lands on the center, never the bbox midpoint, wherever the two differ', () => {
    const wrong = [];
    for (const [slug, z] of Object.entries(COASTAL_ZONES)) {
      const map = fakeMap();
      landOnCoastalZone(map, z);
      if (map.calls.length !== 1) { wrong.push(`${slug}: setView called ${map.calls.length}x`); continue; }
      const got = map.calls[0].center;
      if (km(got, z.center) > 0.001) wrong.push(`${slug}: landed off-center`);
      if (map.calls[0].zoom !== COASTAL_LANDING_ZOOM) wrong.push(`${slug}: wrong zoom`);
      // The regression itself: for a zone whose two candidates are far apart, landing on the
      // midpoint must be detectably wrong rather than "close enough".
      if (km(z.center, bboxMid(z.bbox)) > 5 && km(got, bboxMid(z.bbox)) < 1) {
        wrong.push(`${slug}: landed on the bbox midpoint`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('Murrells Inlet lands on the inlet, not on Myrtle Beach', () => {
    const z = COASTAL_ZONES['coast_murrells_inlet_sc'];
    const map = fakeMap();
    landOnCoastalZone(map, z);
    // The inlet. Myrtle Beach is ~33.68, which is where the bbox midpoint is.
    expect(map.calls[0].center[0] < 33.6).toBe(true);
    expect(km(map.calls[0].center, bboxMid(z.bbox)) > 15).toBe(true);
  });

  it('falls back to the bbox midpoint only when there is no center', () => {
    const map = fakeMap();
    const ok = landOnCoastalZone(map, { bbox: [[33.0, -80.0], [34.0, -79.0]] });
    expect(ok).toBe(true);
    expect(map.calls[0].center).toEqual([33.5, -79.5]);
  });

  it('refuses a zone it cannot place instead of moving the map somewhere arbitrary', () => {
    const map = fakeMap();
    expect(landOnCoastalZone(map, null)).toBe(false);
    expect(landOnCoastalZone(map, {})).toBe(false);
    expect(landOnCoastalZone(map, { bbox: [[NaN, 1], [2, 3]] })).toBe(false);
    expect(map.calls.length).toBe(0);
  });
});

describe('picking a ramp never shows you less water than you had', () => {
  // The bug: onRampChange() hard-set zoom 15. Harmless while coastal opened at zoom 11 and you
  // were always zooming IN -- but with the zoom-13 floor you arrive already zoomed in, so
  // picking a ramp while working a creek at zoom 17 threw you back out to 15.
  it('zooms IN when you are further out than the ramp floor', () => {
    const map = { z: 12, calls: [], getZoom() { return this.z; },
                  setView(c, z) { this.calls.push({ c, z }); } };
    focusRamp(map, 33.5475, -79.0448);
    expect(map.calls[0].z).toBe(RAMP_MIN_ZOOM);
  });

  it('HOLDS the zoom when you are already closer than the floor', () => {
    for (const z of [15, 16, 17, 18]) {
      const map = { z, calls: [], getZoom() { return this.z; },
                    setView(c, zz) { this.calls.push({ c, z: zz }); } };
      focusRamp(map, 33.5475, -79.0448);
      expect(map.calls[0].z, `at zoom ${z}`).toBe(z);
    }
  });

  it('still recentres on the ramp, whatever the zoom', () => {
    const map = { z: 17, calls: [], getZoom() { return this.z; },
                  setView(c, z) { this.calls.push({ c, z }); } };
    focusRamp(map, 33.5475, -79.0448);
    expect(map.calls[0].c).toEqual([33.5475, -79.0448]);
  });

  it('falls back to the floor when the map cannot report a zoom, and refuses bad input', () => {
    const map = { calls: [], setView(c, z) { this.calls.push({ c, z }); } };
    expect(focusRamp(map, 33.5, -79.0)).toBe(true);
    expect(map.calls[0].z).toBe(RAMP_MIN_ZOOM);
    expect(focusRamp(map, NaN, -79.0)).toBe(false);
    expect(focusRamp(null, 33.5, -79.0)).toBe(false);
    expect(map.calls.length).toBe(1);
  });
});
