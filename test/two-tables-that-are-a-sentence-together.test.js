// THE HABITAT MATRIX AND THE CHARTED BOTTOM, READ BY ONE RESEARCH PROMPT AND NOTHING ELSE.
//
// `species_habitat_weights.json` is the South Atlantic habitat matrix — every species scored
// against six structure classes and seven substrate classes, BY LIFE STAGE.
// `enc_seabed_by_zone.json` is what NOAA's ENC cells label the bottom as per coastal zone, in the
// SAME substrate vocabulary. Both were built 2026-09-03 and both had exactly one reader,
// `Worker/research/agents.js`. By the standing test — a fact counts when it reaches
// buildPlanRequest() — neither counted.
//
// Apart they are columns of numbers. Together they are a sentence, and the sentence is the reason
// they are read in one module: a sheepshead rates hard bottom 3.5 and fine 1.0, Charleston's
// chart labels 3 hard-bottom features against 212 fine, so the bottom it wants is the rarest
// thing on the chart there and has to be met on the 281 pilings and 88 rip-rap runs the same file
// counts. A reader that took either table alone could not say that.
//
// WHAT IS DELIBERATELY NOT BUILT, and the measurement that decided it: the matrix's six structure
// classes are channel_edge, creek_mouth, dock_piling, grass_flat, marsh_edge and oyster. Measured
// on coast_charleston_sc's trolling_runs.geojson, 2026-09-15 — 11,939 runs, and `near[]` carries
// hump, pile, hazard, point, cove, obstruction and creek_mouth, with NOT ONE marsh_edge, oyster,
// grass_flat or dock_piling mark. Two of six can reach the leg ranker; the four that cannot are
// the four the matrix rates highest for every inshore fish in the roster. structureWeights()
// already wrote the rule: "Inventing a weight for a type the pipeline never emits would look like
// it worked and do nothing." So this goes to the MODEL and says out loud that the ranker was
// blind to it, rather than leading a weight nothing emits.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from './expect-shim.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(here, '..', f), 'utf8');
const HAB = JSON.parse(readFileSync(join(here, 'fixtures/species_habitat_weights.sample.json'), 'utf8'));
const SEA = JSON.parse(readFileSync(join(here, 'fixtures/enc_seabed_by_zone.sample.json'), 'utf8'));

const {
  primeSeabedHabitat, seabedHabitatFor, seabedHabitatPrimed, _resetSeabedHabitat,
  HABITAT_PATH, SEABED_PATH,
} = await import('../js/data/seabed-habitat.js');

const serve = (hab = HAB, sea = SEA, okHab = true, okSea = true) => async (u) =>
  u.includes('species_habitat')
    ? { ok: okHab, json: async () => hab }
    : { ok: okSea, json: async () => sea };

const prime = async (...a) => {
  _resetSeabedHabitat();
  return primeSeabedHabitat({ worker: 'https://w', fetch: serve(...a) });
};

describe('two registries, one route, and one failing does not take the other down', () => {
  it('both travel the /chartpacks/_registry path every registry travels', async () => {
    const asked = [];
    _resetSeabedHabitat();
    await primeSeabedHabitat({ worker: 'https://w',
      fetch: async (u) => { asked.push(u); return serve()(u); } });
    expect(asked.sort()).toEqual([`https://w${SEABED_PATH}`, `https://w${HABITAT_PATH}`].sort());
    expect(HABITAT_PATH).toContain('/chartpacks/_registry/');
    expect(SEABED_PATH).toContain('/chartpacks/_registry/');
  });

  it('the matrix without the chart is still half a block', async () => {
    await prime(HAB, SEA, true, false);
    expect(seabedHabitatPrimed()).toEqual({ habitat: true, seabed: false });
    const r = seabedHabitatFor('coast_charleston_sc', 'Sheepshead');
    expect(r).toBeTruthy();
    expect(r.stages.adult.substrates.length).toBeGreaterThan(0);
    expect(r.bottom).toEqual([]);
    // AND NO SENTENCE IS MADE OUT OF ONE TABLE. "the bottom it wants is not here" is a much
    // stronger claim than "we did not read the chart", and only one of them is true.
    expect(r.wantsRare).toBeNull();
  });

  it('the chart without the matrix is the other half', async () => {
    await prime(HAB, SEA, false, true);
    const r = seabedHabitatFor('coast_charleston_sc', 'Sheepshead');
    expect(r.matrixName).toBeNull();
    expect(r.bottom.length).toBeGreaterThan(0);
    expect(r.wantsRare).toBeNull();
  });

  it('neither is silence', async () => {
    await prime(HAB, SEA, false, false);
    expect(seabedHabitatFor('coast_charleston_sc', 'Sheepshead')).toBeNull();
  });

  it('a body with the wrong shape is refused, not cached as an answer', async () => {
    _resetSeabedHabitat();
    await primeSeabedHabitat({ worker: 'https://w',
      fetch: async () => ({ ok: true, json: async () => ({ note: 'an error page parses as JSON' }) }) });
    expect(seabedHabitatPrimed()).toEqual({ habitat: false, seabed: false });
  });

  it('an inland water has no zone, so the whole thing is silent', async () => {
    await prime();
    expect(seabedHabitatFor(null, 'Largemouth Bass')).toBeNull();
  });
});

describe('the stages are kept apart, which is the point of the file', () => {
  it('red drum rate marsh edge 4 as juveniles and 2 as adults, and both survive', async () => {
    await prime();
    const r = seabedHabitatFor('coast_charleston_sc', 'Red Drum (Redfish)');
    const adult = r.stages.adult.structures.find((x) => x.key === 'marsh_edge');
    const juv = r.stages.juvenile.structures.find((x) => x.key === 'marsh_edge');
    expect(adult.rank).toBe(2);
    expect(juv.rank).toBe(4);
  });

  it('NOTHING collapses them to one number', async () => {
    // The registry's own warning: "A caller that takes the strongest number across stages makes
    // every adult weight too strong." There is no field here that could carry that mistake.
    await prime();
    const r = seabedHabitatFor('coast_charleston_sc', 'Red Drum (Redfish)');
    expect(Object.keys(r.stages).sort()).toEqual(['adult', 'juvenile', 'larva', 'spawning']);
    expect(r.structures).toBe(undefined);
    expect(r.substrates).toBe(undefined);
  });

  it('a 0.0 is a rating and is kept, not read as an absence', async () => {
    await prime();
    const r = seabedHabitatFor('coast_winyah_bay_sc', 'Speckled Trout (Spotted Seatrout)');
    const larva = r.stages.larva.structures.find((x) => x.key === 'oyster');
    expect(larva.rank).toBe(0);
  });
});

describe('the sentence the two tables make', () => {
  it('a sheepshead wants the rarest bottom on the Charleston chart', async () => {
    await prime();
    const r = seabedHabitatFor('coast_charleston_sc', 'Sheepshead');
    expect(r.wantsRare.wants).toEqual(['hard']);
    expect(r.wantsRare.rating).toBe(3.5);
    expect(r.wantsRare.scarce).toBe(true);
    expect(r.wantsRare.dominant).toBe('fine');
    expect(r.wantsRare.chartedFeatures).toBe(3);
  });

  it('...and the same chart agrees with a red drum', async () => {
    await prime();
    const r = seabedHabitatFor('coast_charleston_sc', 'Red Drum (Redfish)');
    expect(r.wantsRare.wants).toEqual(['fine']);
    expect(r.wantsRare.scarce).toBe(false);
  });

  it('A TIE AT THE TOP IS A TIE, NOT A WINNER', async () => {
    // Seatrout rate fine 2.0 and shell 2.0. `ranked` breaks ties alphabetically so it can return a
    // list; taking [0] would turn that tie into "wants fine", which the matrix never says.
    await prime();
    const r = seabedHabitatFor('coast_winyah_bay_sc', 'Speckled Trout (Spotted Seatrout)');
    expect(r.wantsRare.wants.sort()).toEqual(['fine', 'shell']);
  });

  it('MEDIUM IS NOT A PREFERENCE, and is flagged as one that does not decide the fish', async () => {
    await prime();
    const trout = seabedHabitatFor('coast_winyah_bay_sc', 'Speckled Trout (Spotted Seatrout)');
    expect(trout.wantsRare.weak).toBe(true);
    // The same fish rates grass flat and marsh edge Very High, which is where the day is decided.
    const top = trout.stages.adult.structures[0];
    expect(top.rank).toBe(4);
    // ...and a fish whose bottom rating IS high is not flagged.
    expect(seabedHabitatFor('coast_charleston_sc', 'Sheepshead').wantsRare.weak).toBe(false);
  });

  it('the hard structure the seabed does not carry is named, and trimmed', async () => {
    await prime();
    const r = seabedHabitatFor('coast_charleston_sc', 'Sheepshead');
    expect(r.chartStructure.length).toBeLessThan(7);
    expect(r.chartStructure.map((c) => c.key)).toContain('piling');
    // Sorted by count, so the biggest thing to fish leads.
    for (let i = 1; i < r.chartStructure.length; i++) {
      expect(r.chartStructure[i - 1].rank >= r.chartStructure[i].rank).toBe(true);
    }
  });

  it('restricted areas come through as COUNTS, and a zone with none says nothing', async () => {
    await prime();
    expect(seabedHabitatFor('coast_charleston_sc', 'Sheepshead').restricted.length).toBeGreaterThan(0);
    expect(seabedHabitatFor('coast_winyah_bay_sc', 'Sheepshead').restricted).toEqual([]);
  });
});

describe('it reaches buildPlanRequest, and both planners fill it', () => {
  const prompt = src('js/modules/plan-prompt.js');
  const engine = src('js/modules/smart-plan-v2.js');
  const smart = src('js/modules/smart-plan-v2-wiring.js');
  const pick = src('js/modules/plan-water-ui.js');

  it('the block is rendered into the prompt body', () => {
    expect(prompt).toContain('${seabedHabitatBlock(o.seabedHabitat)}');
  });

  it('the engine passes it through', () => {
    expect(engine).toMatch(/seabedHabitat:\s*o\.seabedHabitat/);
  });

  for (const [who, text] of [['Smart Plan', smart], ['Pick Water', pick]]) {
    it(`${who} resolves it off the ZONE, not the state`, () => {
      // The ENC bottom is filed per coastal zone; regulationStateFor() would answer 'SC' for a
      // reservoir three hundred miles inland and hand it a Charleston Harbor bottom.
      expect(text).toMatch(/seabedHabitat:\s*seabedHabitatFor\(detectCoastalZone\(/);
    });

    it(`${who} primes both tables before the prompt is built`, () => {
      const warm = text.indexOf('await primeSeabedHabitat(');
      const read = text.indexOf('seabedHabitatFor(detectCoastalZone(');
      expect(warm).toBeGreaterThan(-1);
      expect(read).toBeGreaterThan(warm);
    });
  }
});

describe('the block says what it is and what the ranker could not do with it', () => {
  // RUN, DO NOT READ. The first version of this block greped plan-prompt.js for its own sentences
  // and went red on two of them — not because the words were missing, but because they sit either
  // side of a string concatenation. Four guards in this suite have failed that way. The rendered
  // block is what the model is handed, so the rendered block is what is asserted.
  let render;
  const out = async (zone, species) => {
    if (!render) ({ seabedHabitatBlock: render } = await import('../js/modules/plan-prompt.js'));
    await prime();
    return render(seabedHabitatFor(zone, species));
  };

  it('says the highest number across stages is NOT the adult number', async () => {
    expect(await out('coast_charleston_sc', 'Red Drum (Redfish)'))
      .toContain('HIGHEST NUMBER ACROSS THEM IS NOT THE ADULT NUMBER');
  });

  it('calls the matrix regional, not a measurement of this creek', async () => {
    const t = await out('coast_charleston_sc', 'Red Drum (Redfish)');
    expect(t).toContain('REGIONAL rating for the whole South Atlantic');
    expect(t).toContain('not a measurement of this creek');
  });

  it('says the ENC number counts what the chart LABELS, not area', async () => {
    expect(await out('coast_charleston_sc', 'Red Drum (Redfish)'))
      .toContain('count of what the CHART LABELS, not a fraction of the bottom');
  });

  it('AND ADMITS THE LEG RANKING WAS BLIND TO ALL OF IT', async () => {
    // The difference between "this leg was chosen for its marsh edge" (false) and "work the marsh
    // edge along this leg" (an instruction he can follow off a map layer already drawn).
    const t = await out('coast_charleston_sc', 'Red Drum (Redfish)');
    expect(t).toContain('THE LEG RANKING COULD NOT USE ANY OF THIS');
    expect(t).toContain('never say a leg was chosen for habitat it was not scored on');
  });

  it('never turns a count of restricted areas into navigation', async () => {
    const t = await out('coast_charleston_sc', 'Red Drum (Redfish)');
    expect(t).toContain('WE HOLD THE COUNT AND NOT THE SHAPES');
    // ...and a zone with none does not print an empty caution.
    expect(await out('coast_winyah_bay_sc', 'Red Drum (Redfish)')).not.toContain('HOLD THE COUNT');
  });

  it('a sheepshead on Charleston gets the warning; a red drum gets the agreement', async () => {
    expect(await out('coast_charleston_sc', 'Sheepshead'))
      .toContain('Do not hunt for that bottom; meet it on STRUCTURE instead');
    expect(await out('coast_charleston_sc', 'Red Drum (Redfish)'))
      .toContain('the bottom and the fish agree in this zone');
  });

  it('a seatrout is told the bottom is not what decides it', async () => {
    const t = await out('coast_winyah_bay_sc', 'Speckled Trout (Spotted Seatrout)');
    expect(t).toContain('BOTTOM IS NOT WHAT DECIDES THIS FISH');
    expect(t).toContain('fine and shell');          // the tie, named as a tie
    expect(t).not.toContain('rates highest (2)');   // never sold as a preference
  });

  it('nothing at all is silent, not an empty heading', async () => {
    if (!render) ({ seabedHabitatBlock: render } = await import('../js/modules/plan-prompt.js'));
    expect(render(null)).toBe('');
  });
});

describe('the loader is shared, because three copies is how they drift', () => {
  it('inshore-season reads through registry-loader, not its own fetch', () => {
    const s = src('js/data/inshore-season.js');
    expect(s).toContain("from './registry-loader.js'");
    expect(s).not.toMatch(/let _cache = null/);
  });

  it('seabed-habitat does too', () => {
    expect(src('js/data/seabed-habitat.js')).toContain("from './registry-loader.js'");
  });

  it('and the loader refuses a bad body rather than holding it for twelve hours', () => {
    const s = src('js/data/registry-loader.js');
    expect(s).toContain('A BAD BODY IS NOT CACHED AS AN ANSWER');
    expect(s).toMatch(/if \(!got\) return null;/);
  });
});
