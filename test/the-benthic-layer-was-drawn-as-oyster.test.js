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

describe('neither BENTHIC layer is drawn, and both are still routed', () => {
  // MEASURED ON RYAN'S OWN RUN, 2026-09-15. Georgia's BENTHIC loads 1,208 features and all four
  // Georgia zones report "NONE inside this zone" — it is offshore live bottom, outside every
  // inshore boundary. South Carolina has no BENTHIC layer at all. SAV exists only in North
  // Carolina's and the app offers no North Carolina zone. So NO zone the app offers can carry
  // either file, and a toggle that can only ever say "none for this zone" is an unused object
  // with a colour.
  //
  // The extractor still writes both, because the routing is correct and a zone list that regains
  // North Carolina must keep working. That asymmetry is the subject of the contract test below.
  it('no button exists for either', () => {
    for (const btn of ['btnHardBottom', 'btnSav']) {
      expect(HTML).not.toContain(`id="${btn}"`);
      expect(LAYERS).not.toContain(`button: '${btn}'`);
    }
  });

  it('and neither is registered as a layer', () => {
    const m = /const COASTAL_IDS = \[([^\]]*)\]/.exec(LAYERS);
    expect(Boolean(m)).toBe(true);
    expect(m[1]).not.toContain("'hard'");
    expect(m[1]).not.toContain("'sav'");
    // The three that DO have data are still there.
    for (const id of ['oyster', 'marsh', 'soundings']) expect(m[1]).toContain(`'${id}'`);
  });

  it('THE BUILDER WENT WITH THEM — no dead function left behind', () => {
    // A registered layer removed without its builder is the "unused objects" rule this project
    // keeps: the next reader cannot tell a retired path from a forgotten one.
    expect(LAYERS).not.toContain('function benthicLayer(');
    expect(LAYERS).not.toContain('STYLE.hard');
  });

  it('but the app is NOT blind to hard bottom — the PLANNER reads the count', () => {
    // Asserted on the reader, not on a sentence about the reader. The first version of this
    // matched the phrase "ENC seabed registry" in the header comment and went red because the
    // words fall either side of a line wrap — the sixth time in this suite a guard has read prose
    // instead of code.
    //
    // Charleston's ENC chart labels three hard-bottom features against 212 fine, and
    // seabedHabitatFor() carries that per-zone substrate count into the prompt, which is why the
    // model is told to meet a sheepshead on STRUCTURE rather than hunt for bottom that is not
    // there. A count in the prompt answers the question; a map toggle with no polygons behind it
    // does not.
    const seabed = src('js/data/seabed-habitat.js');
    expect(seabed).toContain('enc_seabed_by_zone.json');
    expect(seabed).toMatch(/bySubstrate/);
    expect(src('js/modules/plan-prompt.js')).toContain('${seabedHabitatBlock(o.seabedHabitat)}');
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
