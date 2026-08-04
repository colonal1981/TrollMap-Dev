import { describe, it, expect } from './expect-shim.mjs';
import { groupFeaturesByWaterbody, flagIsYes, hasText, handleGisRoute } from '../Worker/core/arcgis.js';

/**
 * These tests import the REAL grouping function, unlike arcgis-mapping.test.js which
 * re-implements the predicates inline and therefore cannot catch a filter that names a
 * field the layer does not return.
 *
 * That failure mode has now bitten twice:
 *   - GA ramps compared 'yes'/'no' against a column carrying Y/N.
 *   - TN paddle compared p.IncludeWeb, which lives only in the layer's server-side
 *     viewDefinitionQuery and is never present in the response.
 * Both produced count: 0 and an empty waterbodies object, which is indistinguishable
 * from a state that genuinely has no access sites.
 */

// Real rows from
// services3.arcgis.com/PWXNAH2YKmZY7lBq/.../Paddling_Access_Sites/FeatureServer/0
// pulled 2026-08-04 with outFields=*. Note CanoeLanding varies across rows that are
// all legitimately paddling access.
const TN_PADDLE_ROWS = [
  { Name: 'Henry Horton Park', Waterway: 'Duck River', Type: 'Paddling', CanoeLanding: 'Yes', Launchable: 'Up to 17ft', County: 'MARSHALL', Owner: 'TDEC', Latitude: 35.5989, Longitude: -86.6906 },
  { Name: 'Black Fox', Waterway: 'Norris Reservoir', Type: 'Paddling', CanoeLanding: 'No', Launchable: 'Up to 26 ft.', County: 'GRAINGER', Owner: 'TVA', Latitude: 36.2237, Longitude: -83.7561 },
  { Name: 'Wanamaker Access', Waterway: 'Collins River', Type: 'Paddling', CanoeLanding: null, Launchable: null, County: 'GRUNDY', Owner: 'TWRA', Latitude: 35.4794, Longitude: -85.6642 },
];

const asFeatures = (rows) => rows.map((properties) => ({ properties, geometry: null }));

const TN_SOURCE = {
  filter: (p) => p.Type === 'Paddling',
  name: (p) => p.Name,
  wb: (p) => p.Waterway,
  lat: (p) => p.Latitude,
  lon: (p) => p.Longitude,
  meta: (p) => ({ county: p.County, owner: p.Owner, type: 'Paddling Access' }),
  metaNested: true,
};

describe('TN paddle source filter', () => {
  it('keeps every paddling site the view returns', () => {
    const { waterbodies, stats } = groupFeaturesByWaterbody(asFeatures(TN_PADDLE_ROWS), TN_SOURCE);
    expect(stats.kept).toBe(3);
    expect(stats.filtered).toBe(0);
    expect(stats.filterRejectedAll).toBe(false);
    expect(Object.keys(waterbodies)).toHaveLength(3);
  });

  it('keeps paddle sites whose CanoeLanding is No or null', () => {
    // The tempting "fix" was CanoeLanding === 'Yes'. It would have silently halved the feed.
    const { stats } = groupFeaturesByWaterbody(
      asFeatures(TN_PADDLE_ROWS.filter((r) => r.CanoeLanding !== 'Yes')),
      TN_SOURCE,
    );
    expect(stats.kept).toBe(2);
  });

  it('nests meta the way the paddle route has always shaped it', () => {
    const { waterbodies } = groupFeaturesByWaterbody(asFeatures(TN_PADDLE_ROWS), TN_SOURCE);
    const entry = waterbodies['Duck River'][0];
    expect(entry.name).toBe('Henry Horton Park');
    expect(entry.meta.type).toBe('Paddling Access');
    expect(entry.meta.county).toBe('MARSHALL');
  });
});

describe('filter-rejects-everything guard', () => {
  it('flags the exact bug that emptied TN paddle', () => {
    const broken = { ...TN_SOURCE, filter: (p) => p.IncludeWeb === 'Yes' };
    const { waterbodies, stats } = groupFeaturesByWaterbody(asFeatures(TN_PADDLE_ROWS), broken);
    expect(Object.keys(waterbodies)).toHaveLength(0);
    expect(stats.fetched).toBe(3);
    expect(stats.filtered).toBe(3);
    expect(stats.filterRejectedAll).toBe(true);
  });

  it('flags the GA ramps case-mismatch shape too', () => {
    const rows = [{ Ramp: 'Y', Status: 'Open', Name: 'x', Waterbody: 'w', Latitude: 33, Longitude: -84 }];
    const broken = { filter: (p) => p.Ramp === 'yes', name: (p) => p.Name, wb: (p) => p.Waterbody, lat: (p) => p.Latitude, lon: (p) => p.Longitude };
    const { stats } = groupFeaturesByWaterbody(asFeatures(rows), broken);
    expect(stats.filterRejectedAll).toBe(true);
  });

  it('does not flag an empty upstream response', () => {
    // No features at all is a legitimate (if unusual) upstream state, not a broken filter.
    const { stats } = groupFeaturesByWaterbody([], TN_SOURCE);
    expect(stats.fetched).toBe(0);
    expect(stats.filterRejectedAll).toBe(false);
  });

  it('does not flag a filter that rejects only some rows', () => {
    const mixed = [...TN_PADDLE_ROWS, { Name: 'Ramp Only', Waterway: 'Duck River', Type: 'Boat Launch', Latitude: 35.5, Longitude: -86.6 }];
    const { stats } = groupFeaturesByWaterbody(asFeatures(mixed), TN_SOURCE);
    expect(stats.fetched).toBe(4);
    expect(stats.kept).toBe(3);
    expect(stats.filtered).toBe(1);
    expect(stats.filterRejectedAll).toBe(false);
  });

  it('counts coordinate drops separately from filter rejections', () => {
    const noCoords = [{ Name: 'Nowhere', Waterway: 'Duck River', Type: 'Paddling', Latitude: null, Longitude: null }];
    const { stats } = groupFeaturesByWaterbody(asFeatures(noCoords), TN_SOURCE);
    expect(stats.filtered).toBe(0);
    expect(stats.dropped).toBe(1);
    expect(stats.kept).toBe(0);
    expect(stats.filterRejectedAll).toBe(false);
  });
});

describe('flagIsYes — the coded-value-domain trap', () => {
  it('accepts every encoding the four agencies actually return', () => {
    // GA writes Y/N. NC returns the numeric CODE 1/0 while its viewer shows YES/NO.
    // SC writes Yes/No. All three are the same "is this flag set" question.
    for (const v of [1, '1', 'Y', 'y', 'YES', 'yes', 'Yes', true, 'true', 'T']) {
      expect(flagIsYes(v)).toBe(true);
    }
  });

  it('rejects the unset encodings, including numeric zero', () => {
    for (const v of [0, '0', 'N', 'n', 'NO', 'no', false, 'false', null, undefined, '', '   ']) {
      expect(flagIsYes(v)).toBe(false);
    }
  });

  it('would have caught the NC paddle miss', () => {
    // What the layer actually returns for a qualifying site.
    const ncRow = { Non_Motorized_Access: 1, Portable_Boat_Access_Type: null, Site_Status: 'OPEN' };
    const oldFilter = (p) => (String(p.Non_Motorized_Access || '').toLowerCase() === 'yes'
                              || String(p.Portable_Boat_Access_Type || '').length > 0)
                             && String(p.Site_Status || '').toLowerCase() === 'open';
    const newFilter = (p) => (flagIsYes(p.Non_Motorized_Access) || hasText(p.Portable_Boat_Access_Type))
                             && String(p.Site_Status || '').toLowerCase() === 'open';
    expect(oldFilter(ncRow)).toBe(false);   // 125 of 136 sites lost here
    expect(newFilter(ncRow)).toBe(true);
  });

  it('still rejects a closed site with the flag set', () => {
    const closed = { Non_Motorized_Access: 1, Site_Status: 'CLOSED TEMPORARILY' };
    const f = (p) => (flagIsYes(p.Non_Motorized_Access) || hasText(p.Portable_Boat_Access_Type))
                     && String(p.Site_Status || '').toLowerCase() === 'open';
    expect(f(closed)).toBe(false);
  });

  it('hasText ignores whitespace-only free text', () => {
    expect(hasText('CONCRETE STEPS')).toBe(true);
    expect(hasText('  ')).toBe(false);
    expect(hasText(null)).toBe(false);
  });
});

describe('TN bank-pier source filter', () => {
  it('keeps fishing sites that the old IncludeWeb check threw away', () => {
    const rows = [
      { Name: 'Cedar Creek', Waterway: 'Norris Reservoir', Type: 'Fishing Site', County: 'CAMPBELL', Latitude: 36.29, Longitude: -84.09 },
      { Name: 'Boat Only', Waterway: 'Norris Reservoir', Type: 'Boat Launch', County: 'CAMPBELL', Latitude: 36.28, Longitude: -84.08 },
    ];
    const src = { filter: (p) => p.Type === 'Fishing Site', name: (p) => p.Name, wb: (p) => p.Waterway, lat: (p) => p.Latitude, lon: (p) => p.Longitude };
    const { stats } = groupFeaturesByWaterbody(asFeatures(rows), src);
    expect(stats.kept).toBe(1);

    const oldSrc = { ...src, filter: (p) => p.IncludeWeb === 'Yes' };
    const old = groupFeaturesByWaterbody(asFeatures(rows), oldSrc);
    expect(old.stats.kept).toBe(0);
    expect(old.stats.filterRejectedAll).toBe(true);
  });
});

describe('misconfigured source is refused, not papered over', () => {
  // A dropped `url:` line made handleGisRoute fetch "undefined?outFields=*&...", which
  // threw, which hit the stale-cache fallback, which returned a body an older build had
  // written to R2 -- warning text and all. Four deploys were diagnosed against a response
  // that the deployed code had not produced. The url must be rejected up front.
  const R2 = { get: async () => ({ text: async () => '{"count":999}', uploaded: new Date(0) }) };
  const env = { R2_TROLLMAP_CHARTPACKS: R2 };
  const call = (sources, state) => handleGisRoute({
    env,
    url: new URL(`https://x/paddle?state=${state}&refresh`),
    cachePrefix: 'paddle',
    ttlDays: 7,
    sources,
    buildResult: (st, src, wbs, count) => ({ state: st, count }),
  });

  it('returns 500 naming the missing key rather than fetching undefined', async () => {
    const resp = await call({ TN: { filter: () => true, name: (p) => p.n, wb: (p) => p.w } }, 'TN');
    expect(resp.status).toBe(500);
    const body = await resp.json();
    expect(body.error).toBe('paddle source for TN is missing "url"');
  });

  it('does NOT fall back to stale cache for a config bug', async () => {
    // The stale body would be count:999 and would look like real data.
    const resp = await call({ TN: { filter: () => true, name: (p) => p.n, wb: (p) => p.w } }, 'TN');
    const body = await resp.json();
    expect(body.count).toBe(undefined);
  });

  it('names each required key it finds missing', async () => {
    const resp = await call({ SC: { url: 'https://example.invalid/query', name: (p) => p.n, wb: (p) => p.w } }, 'SC');
    const body = await resp.json();
    expect(body.error).toBe('paddle source for SC is missing "filter"');
  });
});
