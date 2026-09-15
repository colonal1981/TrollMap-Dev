// THE BENTHIC LAYER WAS DRAWN AS OYSTER, AND IT IS NOT OYSTER.
//
// extract_coastal_habitat.py wrote every ESI BENTHIC polygon into oyster_beds.geojson, and
// coastal-layers.js drew that file with the tooltip "Oyster bed — redfish on moving water".
// Resolved through BIOFILE on 2026-09-15 -- BENTHIC carries a RARNUM and two geometry
// measurements and nothing else, so BIOFILE is the only place either geodatabase says what its
// polygons ARE:
//
//   Georgia          1,208 polygons, SUBELEMENT `hardbottom`, "Hardbottom community"
//   North Carolina   9,750 polygons, four parts `sav` -- loose watermilfoil, submerged aquatic
//                    vegetation -- to one part `hardbottom`, "Rock reef"
//
// Not one oyster in either. Charleston was never affected: South Carolina has no BENTHIC layer
// and its oyster comes from SCDNR's own file, which is why the one zone anybody had looked at
// looked right.
//
// THE DATA IS GOOD AND THE FILENAME WAS WRONG. Hard bottom is what a sheepshead wants -- `hard`
// 3.5 against `fine` 1.0 for the mud that is everywhere -- and where a red drum spawns.
// Charleston's ENC chart labels three hard-bottom features in the whole zone; Georgia has 1,208
// polygons of it. It is a layer of its own now.
//
// SAV IS ROUTED AND NOT DRAWN, and that asymmetry is the point of two of the tests below. It
// comes only from North Carolina's BENTHIC and the app offers no North Carolina zone, so a
// toggle for it could only ever report "none for this zone". Measured 2026-09-03 against the
// national seagrass compilation, 1,051,164 polygons: NC 6,258, SC 0, GA 0 -- absent from the file
// entirely, not merely scarce, which is what the South Atlantic Bight is. On this coast flooded
// Spartina IS the grass flat and the marsh layer already carries that job. The extractor still
// routes sav, because the routing is correct and a zone list that regains NC must keep working.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from './expect-shim.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(here, '..', f), 'utf8');
const LAYERS = src('js/modules/coastal-layers.js');
const HTML = src('index.html');

/** The builder, lifted and run — the tooltip is the thing that was wrong, so the tooltip is what
 *  gets asserted, not the source line that writes it. */
function buildTooltips(props, opts, gj = { features: [{ properties: props, geometry: {} }] }) {
  const i = LAYERS.indexOf('function benthicLayer(');
  const fn = LAYERS.slice(i, LAYERS.indexOf('\n}\n', i) + 2);
  const L = { geoJSON: (g, o) => ({ _o: o }) };
  // eslint-disable-next-line no-new-func
  const make = new Function('fetchCoastalLayer', '_renderer', 'L', `${fn}; return benthicLayer;`);
  const benthicLayer = make(async () => gj, null, L);
  return benthicLayer('coast_test', opts).then((layer) => {
    if (!layer) return null;
    let text = null;
    layer._o.onEachFeature({ properties: props }, { bindTooltip: (t) => { text = t; } });
    return text;
  });
}

const HARD = { file: 'hard_bottom', style: { color: '#8d8b86', fill: '#8d8b86' },
               label: '🪨 Hard bottom', why: 'sheepshead and black drum hold on it' };

describe('hard bottom is a layer of its own and is not oyster', () => {
  it('it is registered and has a button to press', () => {
    expect(LAYERS).toContain("id: 'hard', button: 'btnHardBottom'");
    expect(HTML).toContain('id="btnHardBottom"');
  });

  it('it is dropped with the rest when the zone changes', () => {
    // A layer registered and left out of COASTAL_IDS stays drawn over the next zone's water.
    const m = /const COASTAL_IDS = \[([^\]]*)\]/.exec(LAYERS);
    expect(Boolean(m)).toBe(true);
    for (const id of ['oyster', 'hard', 'marsh', 'soundings']) {
      expect(m[1]).toContain(`'${id}'`);
    }
  });

  it('it does not fetch the oyster file', () => {
    const i = LAYERS.indexOf("id: 'hard'");
    const blk = LAYERS.slice(i, LAYERS.indexOf("id: 'soundings'"));
    expect(blk).toContain("file: 'hard_bottom'");
    expect(blk).not.toContain('oyster');
  });

  it('and it does not wear the oyster colour', () => {
    // Drawn in the same brown it was wrongly drawn in, the correction would be invisible.
    const m = /const STYLE = \{([\s\S]*?)\n\};/.exec(LAYERS);
    const oyster = /oyster:\s*\{\s*color:\s*'(#[0-9a-f]{6})'/i.exec(m[1])[1].toLowerCase();
    const hard = /hard:\s*\{\s*color:\s*'(#[0-9a-f]{6})'/i.exec(m[1])[1].toLowerCase();
    expect(hard).not.toBe(oyster);
  });

  it('SAV HAS NO BUTTON, because no zone the app offers can ever carry the file', () => {
    // A toggle that can only ever say "none for this zone" is an unused object with a colour.
    //
    // MATCHED ON THE WHOLE ATTRIBUTE, NOT THE PREFIX. The first version of this asserted
    // `HTML.not.toContain('btnSav')` and went red against `btnSaveMasterJson`, which is a
    // save button in the research tab. An id test that matches a prefix will eventually meet
    // a longer id, and this suite has the same lesson written down for species names, where
    // `Red Drum` sits inside nothing and `Black Drum` contains `Drum`.
    expect(HTML).not.toContain('id="btnSav"');
    expect(LAYERS).not.toContain("button: 'btnSav'");
    expect(LAYERS).not.toContain("id: 'sav'");
  });
});

describe('the tooltip says what the polygon is, in the data’s own words', () => {
  it('leads with the BIOFILE name and the concentration', async () => {
    // Before this the browser got a RARNUM and nothing else, which is exactly why nobody could
    // see these were not oyster. DENSE and SPARSE is the difference between a reef worth stopping
    // on and a scattering.
    const t = await buildTooltips({ NAME: 'Hardbottom community', CONC: 'DENSE' }, HARD);
    expect(t).toContain('Hardbottom community');
    expect(t).toContain('(dense)');
    expect(t).toContain('sheepshead');
  });

  it('a name that is not the label still shows — North Carolina’s is "Rock reef"', async () => {
    const t = await buildTooltips({ NAME: 'Rock reef', CONC: '-' }, HARD);
    expect(t).toContain('Rock reef');
    // `-` is the ESI empty marker and must not print as a concentration.
    expect(t).not.toContain('(-)');
  });

  it('a feature with no attributes at all still gets a readable tooltip', async () => {
    const t = await buildTooltips({}, HARD);
    expect(t).toContain('🪨 Hard bottom');
    expect(t).not.toContain('undefined');
    expect(t).not.toContain('—  —');
  });

  it('a zone with no such file draws nothing rather than an empty layer', async () => {
    const i = LAYERS.indexOf('function benthicLayer(');
    const fn = LAYERS.slice(i, LAYERS.indexOf('\n}\n', i) + 2);
    // eslint-disable-next-line no-new-func
    const make = new Function('fetchCoastalLayer', '_renderer', 'L', `${fn}; return benthicLayer;`);
    const built = await make(async () => null, null, { geoJSON: () => ({}) })('coast_x', HARD);
    expect(built).toBeNull();
  });
});

describe('the extractor and the map agree about the filenames', () => {
  const PY = src('Scripts/extract_coastal_habitat.py');

  it('every file the map asks for is a file the extractor writes', () => {
    // Two halves of one contract, in two languages, and this is the direction that matters: a map
    // asking for a file nothing produces is a button that can never work. The reverse is allowed
    // and is deliberate -- sav is written and not drawn, because it exists only for zones the app
    // does not offer, and dropping the routing would break a zone list that regains them.
    const m = /BENTHIC_SUBELEMENT_FILES = \{([\s\S]*?)\n\}/.exec(PY);
    expect(Boolean(m)).toBe(true);
    const written = [...m[1].matchAll(/'([a-z_]+\.geojson)'/g)].map((x) => x[1]);
    expect(written.length > 0).toBe(true);
    const asked = [...LAYERS.matchAll(/file: '([a-z_]+)'/g)].map((x) => `${x[1]}.geojson`);
    for (const f of asked) {
      // oyster_beds and marsh_edges come from their own sources, not from BENTHIC.
      if (!['hard_bottom.geojson', 'sav.geojson'].includes(f)) continue;
      expect(written).toContain(f);
    }
    // And hard bottom, which IS drawn, must be among the written.
    expect(written).toContain('hard_bottom.geojson');
  });

  it('and oyster_beds is NOT among them', () => {
    const m = /BENTHIC_SUBELEMENT_FILES = \{([\s\S]*?)\n\}/.exec(PY);
    expect(m[1]).not.toContain('oyster_beds');
  });
});
