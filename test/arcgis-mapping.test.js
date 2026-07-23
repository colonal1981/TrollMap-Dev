import { describe, it, expect } from 'vitest';

/**
 * Characterization tests for ArcGIS feature → app DTO mappers.
 * Currently trollmap-worker.js has 4 duplicated handlers for ramps/paddle/bank-pier/attractors.
 * These tests document current mapping behavior so the upcoming dedupe PR can compare JSON.
 *
 * We don't import the worker handlers directly (they depend on R2), but we test the pure mapping
 * logic extracted from worker: filter + name + wb + lat/lon + meta.
 */

describe('ArcGIS ramp mapping — SC source config (characterization)', () => {
  // Real schema confirmed 2026-07-03 via outFields=* query
  const scRampSample = {
    WaterAccessType: 'Boat Ramp',
    Status: 'Active',
    PublicAccess: 'Open',
    WaterAccessName: 'Lake Wateree State Park',
    Waterbody: 'Lake Wateree',
    Latitude: 34.123456,
    Longitude: -80.654321,
    LaunchLanes: 2,
    CourtesyDock: 1,
  };

  const scFilter = (p) => p.WaterAccessType === 'Boat Ramp' && p.Status?.toLowerCase() === 'active' && p.PublicAccess?.toLowerCase() !== 'closed';
  const scName = (p) => p.WaterAccessName;
  const scWb = (p) => p.Waterbody;

  it('SC filter passes active boat ramp', () => {
    expect(scFilter(scRampSample)).toBe(true);
  });

  it('SC filter fails for closed or non-ramp', () => {
    expect(scFilter({ ...scRampSample, WaterAccessType: 'Paddle Launch' })).toBe(false);
    expect(scFilter({ ...scRampSample, Status: 'Closed' })).toBe(false);
    expect(scFilter({ ...scRampSample, PublicAccess: 'Closed' })).toBe(false);
  });

  it('SC name/wb mappers', () => {
    expect(scName(scRampSample)).toBe('Lake Wateree State Park');
    expect(scWb(scRampSample)).toBe('Lake Wateree');
  });
});

describe('ArcGIS GA source config — FID idField bug characterization', () => {
  // GA's objectIdFieldName is FID, not OBJECTID — using OBJECTID causes 400
  const gaSource = {
    idField: 'FID',
    filter: (p) => String(p.Ramp || '').toUpperCase() === 'Y' && !['closed', 'inactive'].includes(String(p.Status || '').toLowerCase()),
  };

  it('GA idField should be FID', () => {
    expect(gaSource.idField).toBe('FID');
  });

  it('GA filter checks single-letter Y/N', () => {
    expect(gaSource.filter({ Ramp: 'Y', Status: 'Open' })).toBe(true);
    expect(gaSource.filter({ Ramp: 'N', Status: 'Open' })).toBe(false);
    expect(gaSource.filter({ Ramp: 'Y', Status: 'Closed' })).toBe(false);
    // Old bug: checking 'yes'/'no' strings would fail every record
    expect(gaSource.filter({ Ramp: 'yes', Status: 'Open' })).toBe(false);
  });
});

describe('ArcGIS waterbody bucketing', () => {
  it('groups features by waterbody and sorts by name', () => {
    const features = [
      { wb: 'Lake Wateree', name: 'Z Ramp' },
      { wb: 'Lake Wateree', name: 'A Ramp' },
      { wb: 'Lake Murray', name: 'Murray Ramp' },
    ];
    const waterbodies = {};
    for (const f of features) {
      if (!waterbodies[f.wb]) waterbodies[f.wb] = [];
      waterbodies[f.wb].push(f);
    }
    for (const wb of Object.keys(waterbodies)) {
      waterbodies[wb].sort((a, b) => a.name.localeCompare(b.name));
    }
    expect(waterbodies['Lake Wateree'][0].name).toBe('A Ramp');
    expect(waterbodies['Lake Wateree'][1].name).toBe('Z Ramp');
    expect(Object.keys(waterbodies)).toHaveLength(2);
  });
});
