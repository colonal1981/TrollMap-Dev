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
// THE DATA IS GOOD AND THE FILENAME WAS WRONG. The South Atlantic habitat matrix the planner
// reads scores six structure classes and two of them are exactly these: grass flat is 4.0 for an
// adult seatrout, and hard bottom is what a sheepshead wants -- `hard` 3.5 against `fine` 1.0 for
// the mud that is everywhere. Charleston's ENC chart labels three hard-bottom features in the
// whole zone and Georgia has 1,208 polygons of it. Two layers of their own now.
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

describe('the two layers exist and are not oyster', () => {
  it('both are registered and both have a button to press', () => {
    for (const [id, btn] of [['hard', 'btnHardBottom'], ['sav', 'btnSav']]) {
      expect(LAYERS).toContain(`id: '${id}', button: '${btn}'`);
      expect(HTML).toContain(`id="${btn}"`);
    }
  });

  it('they are dropped with the rest when the zone changes', () => {
    // A layer registered and left out of COASTAL_IDS stays drawn over the next zone's water.
    const m = /const COASTAL_IDS = \[([^\]]*)\]/.exec(LAYERS);
    expect(Boolean(m)).toBe(true);
    for (const id of ['oyster', 'hard', 'sav', 'marsh', 'soundings']) {
      expect(m[1]).toContain(`'${id}'`);
    }
  });

  it('neither of them fetches the oyster file', () => {
    const i = LAYERS.indexOf('id: \'hard\'');
    const blk = LAYERS.slice(i, LAYERS.indexOf('id: \'soundings\''));
    expect(blk).toContain("file: 'hard_bottom'");
    expect(blk).toContain("file: 'sav'");
    expect(blk).not.toContain('oyster');
  });

  it('and they do not wear the oyster colour', () => {
    // Drawn in the same brown they were wrongly drawn in, the correction would be invisible.
    const m = /const STYLE = \{([\s\S]*?)\n\};/.exec(LAYERS);
    const oyster = /oyster:\s*\{\s*color:\s*'(#[0-9a-f]{6})'/i.exec(m[1])[1].toLowerCase();
    for (const key of ['hard', 'sav']) {
      const c = new RegExp(`${key}:\\s*\\{\\s*color:\\s*'(#[0-9a-f]{6})'`, 'i').exec(m[1])[1];
      expect(c.toLowerCase()).not.toBe(oyster);
    }
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

  it('every file the extractor writes from BENTHIC is a file the map asks for', () => {
    // Two halves of one contract, in two languages. The whole defect was these disagreeing.
    const m = /BENTHIC_SUBELEMENT_FILES = \{([\s\S]*?)\n\}/.exec(PY);
    expect(Boolean(m)).toBe(true);
    const written = [...m[1].matchAll(/'([a-z_]+\.geojson)'/g)].map((x) => x[1]);
    expect(written.length > 0).toBe(true);
    for (const f of written) {
      expect(LAYERS).toContain(`file: '${f.replace(/\.geojson$/, '')}'`);
    }
  });

  it('and oyster_beds is NOT among them', () => {
    const m = /BENTHIC_SUBELEMENT_FILES = \{([\s\S]*?)\n\}/.exec(PY);
    expect(m[1]).not.toContain('oyster_beds');
  });
});
