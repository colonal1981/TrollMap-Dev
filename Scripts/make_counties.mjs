/**
 * make_counties.mjs -- flatten us-atlas counties-10m TopoJSON into a GeoJSON the Python
 * pipeline can read, with the county name, its FIPS code and its state abbreviation.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 *   node make_counties.mjs > counties_500k.geojson
 *
 * WHY THIS FILE: consolidate_lake_index.py already assigns `state` by point-in-polygon
 * against gz_2010_us_040_00_500k.json. County is the same operation one level finer, and
 * this is the missing input. us-atlas ships the Census cartographic boundaries as TopoJSON
 * on npm, which is reachable from the build container when census.gov is not.
 *
 * The geometry is WGS84 lon/lat (the -albers- variants are the projected ones), so it drops
 * straight into the existing lookup with no reprojection.
 */
import * as topojson from 'topojson-client';
import topo from 'us-atlas/counties-10m.json' with { type: 'json' };

const ABBR = {
  '01':'AL','02':'AK','04':'AZ','05':'AR','06':'CA','08':'CO','09':'CT','10':'DE','11':'DC',
  '12':'FL','13':'GA','15':'HI','16':'ID','17':'IL','18':'IN','19':'IA','20':'KS','21':'KY',
  '22':'LA','23':'ME','24':'MD','25':'MA','26':'MI','27':'MN','28':'MS','29':'MO','30':'MT',
  '31':'NE','32':'NV','33':'NH','34':'NJ','35':'NM','36':'NY','37':'NC','38':'ND','39':'OH',
  '40':'OK','41':'OR','42':'PA','44':'RI','45':'SC','46':'SD','47':'TN','48':'TX','49':'UT',
  '50':'VT','51':'VA','53':'WA','54':'WV','55':'WI','56':'WY','60':'AS','66':'GU','69':'MP',
  '72':'PR','78':'VI',
};

const fc = topojson.feature(topo, topo.objects.counties);
const features = [];
for (const f of fc.features) {
  const fips = String(f.id || '');
  const st = ABBR[fips.slice(0, 2)];
  if (!st) continue;                       // territories us-atlas does not label
  features.push({
    type: 'Feature',
    properties: { county: f.properties.name, fips, state: st },
    geometry: f.geometry,
  });
}
features.sort((a, b) => a.properties.fips.localeCompare(b.properties.fips));
process.stdout.write(JSON.stringify({
  type: 'FeatureCollection',
  note: 'US county boundaries, WGS84. Built from the us-atlas npm package (Census '
      + 'cartographic boundaries, 1:10m). Input to consolidate_lake_index.py.',
  features,
}));
