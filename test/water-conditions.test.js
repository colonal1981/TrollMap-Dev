// One read for the state of the water.
//
// This replaced three answers to one question: a seven-lake hand-typed UTILITY_FEEDS table, a
// Duke/Dominion/Santee if-chain matched on the SECOND WORD of the feed name, and a /lake call
// that returned a percent for Duke lakes and feet for everything else — into the same two form
// fields. The assertions here are mostly about the seams where those disagreed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cToF, conditionsUrl, pickWaterTemp, readConditions, fetchWaterConditions, levelSentence }
  from '../js/utils/water-conditions.js';

const REC = { slug: 'wateree_lake', name: 'Wateree Lake', displayName: 'Wateree Lake (Kershaw Co, SC)',
              lat: 34.3459, lon: -80.7011, state: 'SC' };

const envelope = (water, extra = {}) => ({ slug: REC.slug, water, ...extra });

test('the URL carries the centroid, because the Worker has no registry', () => {
  const u = new URL(conditionsUrl('https://w.example', REC));
  assert.equal(u.pathname, '/conditions/wateree_lake');
  assert.equal(u.searchParams.get('lat'), '34.3459');
  assert.equal(u.searchParams.get('lon'), '-80.7011');
});

test('no slug or no centroid is null, not a request that 400s', () => {
  assert.equal(conditionsUrl('https://w.example', { slug: 'x' }), null);
  assert.equal(conditionsUrl('https://w.example', { lat: 1, lon: 2 }), null);
  assert.equal(conditionsUrl('', REC), null);
});

test('a trailing slash on the worker base does not double up', () => {
  assert.ok(conditionsUrl('https://w.example/', REC).startsWith('https://w.example/conditions/'));
});

test('fresh=1 is opt-in — the registry changes when the PIPELINE uploads', () => {
  assert.equal(new URL(conditionsUrl('https://w.example', REC)).searchParams.get('fresh'), null);
  assert.equal(new URL(conditionsUrl('https://w.example', REC, { fresh: true })).searchParams.get('fresh'), '1');
});

test('celsius converts, and a missing temperature stays missing', () => {
  assert.equal(cToF(25), 77);
  assert.equal(cToF(null), null);
  assert.equal(cToF(undefined), null);
  // 0 °C is a temperature, not an absent one. This is the Number('') family.
  assert.equal(cToF(0), 32);
});

test('temperature comes from the pool before the tailwater', () => {
  const t = pickWaterTemp({ pool: { water_temp_c: 28, name: 'Pool' },
                            tailwater: { water_temp_c: 22, name: 'Below dam' } });
  assert.equal(t.from, 'pool');
  assert.equal(t.f, 82.4);
});

test('a tailwater temperature is labelled as one — it is the river, not the lake', () => {
  const t = pickWaterTemp({ pool: { water_temp_c: null }, tailwater: { water_temp_c: 22, name: 'Below dam' } });
  assert.equal(t.from, 'tailwater');
  assert.equal(t.name, 'Below dam');
});

test('the drawdown survives when there is no elevation at all', () => {
  // Brookfield's Chilhowee. `level - full` is NaN here; the number that answers the question
  // is sitting in below_full_pool_ft.
  const c = readConditions(envelope({
    display_name: 'Chilhowee Lake (Monroe Co, TN)', feature_type: 'lake',
    chart_datum: { level_ft: null, full_pool_ft: null, below_full_pool_ft: 1.18,
                   source: 'Brookfield / safewaters.com — Chilhowee', pending: null },
    operator: { url: 'https://www.safewaters.com/facility/chilhowee/', observed_at: 'x' },
  }));
  assert.equal(c.belowFullPoolFt, 1.18);
  assert.equal(c.levelFt, null);
  assert.equal(c.pending, null);
  assert.equal(c.levelUrl, 'https://www.safewaters.com/facility/chilhowee/');
  assert.match(levelSentence(c), /1\.18 ft below full pool/);
});

test('the feed name is not printed twice', () => {
  // chart_datum.source already reads "Brookfield / safewaters.com — Chilhowee" on the operator
  // path, so reading w.operator.feed_name as a fallback said Chilhowee twice.
  const c = readConditions(envelope({
    display_name: 'Chilhowee Lake', feature_type: 'lake',
    chart_datum: { below_full_pool_ft: 1.18, source: 'Brookfield / safewaters.com — Chilhowee' },
    operator: { feed_name: 'Chilhowee' },
  }));
  assert.equal((levelSentence(c).match(/Chilhowee/g) || []).length, 1);
});

test('a Corps target rides along and is never subtracted', () => {
  const c = readConditions(envelope({
    display_name: 'Hartwell Lake', feature_type: 'lake',
    chart_datum: { level_ft: 651.7, full_pool_ft: 660, below_full_pool_ft: 8.3, source: 'X' },
    usace: { project: 'Hartwell', conservation_pool_ft: 660 },
  }));
  assert.equal(c.usaceTargetFt, 660);
  assert.equal(c.usaceProject, 'Hartwell');
  assert.equal(c.belowFullPoolFt, 8.3, 'the target must not become the drawdown');
});

test('an unbound water says so instead of reading as zero', () => {
  const c = readConditions({ slug: 'x', water: null, pending: { water: 'no row for "x" in the registry' } });
  assert.equal(c.ok, true);
  assert.equal(c.belowFullPoolFt, null);
  assert.match(c.pending, /no row/);
});

test('a request failure, an empty answer and a real zero are three different states', () => {
  const fail = readConditions(null);
  assert.equal(fail.ok, false);
  assert.equal(fail.error, 'no response');

  const empty = readConditions(envelope({ display_name: 'L', feature_type: 'lake',
    chart_datum: { below_full_pool_ft: null, pending: 'no source publishes a level' } }));
  assert.equal(empty.ok, true);
  assert.equal(empty.error, null);
  assert.match(empty.pending, /no source/);

  const atFull = readConditions(envelope({ display_name: 'L', feature_type: 'lake',
    chart_datum: { level_ft: 225.5, full_pool_ft: 225.5, below_full_pool_ft: 0, source: 'X' } }));
  assert.equal(atFull.belowFullPoolFt, 0);
  assert.match(levelSentence(atFull), /at full pool/);
});

test('above full pool reads as above, not as a negative drawdown', () => {
  const c = readConditions(envelope({ display_name: 'L', feature_type: 'lake',
    chart_datum: { level_ft: 227, full_pool_ft: 225.5, below_full_pool_ft: -1.5, source: 'X' } }));
  assert.match(levelSentence(c), /1\.50 ft above full pool/);
});

test('fetch failure is a stated error, never a silent fallback level', () => {
  return fetchWaterConditions('https://w.example', REC, {
    fetch: () => Promise.reject(new Error('offline')),
  }).then((c) => {
    assert.equal(c.error, 'offline');
    assert.equal(c.belowFullPoolFt, null);
    // The old code wrote a hardcoded normalPool into the form here, which the trip decision
    // then read as a live reading.
    assert.equal(c.levelFt, null);
  });
});

test('a non-200 with a JSON body still reports the status', () => {
  return fetchWaterConditions('https://w.example', REC, {
    fetch: () => Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ oops: 1 }) }),
  }).then((c) => assert.equal(c.error, 'HTTP 400'));
});

test('a lake with no centroid never reaches the network', () => {
  let called = false;
  return fetchWaterConditions('https://w.example', { slug: 'x' }, {
    fetch: () => { called = true; return Promise.resolve({ ok: true, json: () => ({}) }); },
  }).then((c) => {
    assert.equal(called, false);
    assert.match(c.error, /centroid/);
  });
});

// ── the one line that has to fit ────────────────────────────────────────────────────────────
import { conditionsStrip } from '../js/utils/water-conditions.js';

const strip = (water, extra = {}) => conditionsStrip(readConditions({ slug: 's', water, ...extra }));

test('a lake leads with the drawdown — the number that decides the ramp', () => {
  const s = strip({ display_name: 'Thurmond', feature_type: 'lake',
    chart_datum: { level_ft: 323.08, full_pool_ft: 330, below_full_pool_ft: 6.92,
                   source: 'Southern Company / Georgia Power — Clark Hill (Thurmond Dam)' },
    pool: { water_temp_c: 29, name: 'Modoc' } });
  assert.match(s.text, /^6\.92 ft down/);
  assert.match(s.text, /84\.2°F/);
  assert.match(s.text, /Southern Company \/ Georgia Power$/, 'the source, not the feed row');
  assert.equal(s.tone, 'ok');
});

test('a river leads with FLOW — stage alone does not say what it is doing', () => {
  const s = strip({ display_name: 'Broad River', feature_type: 'river',
    chart_datum: { pending: 'not a lake — a river or coastal zone has no full pool to be below' },
    gauge: { flow: 1240.4, stage: 3.21, name: 'Alston' } });
  assert.match(s.text, /1,240 ft³\/s/);
  assert.match(s.text, /3\.2 ft stage/);
});

test('a projected release reaches the strip; an observed discharge does not', () => {
  const base = { display_name: 'Wateree River', feature_type: 'river',
                 gauge: { flow: 900, name: 'g' } };
  const proj = strip({ ...base, releases: { kind: 'projected', operator: 'Duke Energy',
    next: { mileMarkerName: 'Hwy 601' }, items: [] } });
  assert.match(proj.text, /release → Hwy 601/);
  // Brookfield's discharge IS the flow number two fields to the left. Printing it again as a
  // schedule is exactly what `kind` exists to prevent.
  const obs = strip({ ...base, releases: { kind: 'observed', operator: 'Brookfield',
    next: null, items: [{ cfs: 9448 }] } });
  assert.ok(!/release/.test(obs.text), obs.text);
});

test('a modelled clarity is marked, a measured one is not', () => {
  const model = strip({ display_name: 'L', feature_type: 'lake',
    chart_datum: { below_full_pool_ft: 1 } }, { clarity: { overall: { clarity: 'Stained', score: 40 }, measured: null } });
  assert.match(model.text, /~Stained/);
  assert.ok(model.footnotes.some((f) => /modelled from rainfall/.test(f)));

  const meas = strip({ display_name: 'L', feature_type: 'lake',
    chart_datum: { below_full_pool_ft: 1 } }, { clarity: { overall: { clarity: 'Clear', score: 5 }, measured: { avgSecchiDepthFt: 8 } } });
  assert.match(meas.text, /· Clear/);
  assert.ok(!/~/.test(meas.text));
  assert.ok(!meas.footnotes.some((f) => /modelled/.test(f)));
});

test('a tailwater temperature is starred and the footnote says why', () => {
  const s = strip({ display_name: 'L', feature_type: 'lake',
    chart_datum: { below_full_pool_ft: 2 },
    tailwater: { water_temp_c: 20, name: 'Below dam' } });
  assert.match(s.text, /68°F\*/);
  assert.ok(s.footnotes.some((f) => /below the dam/.test(f)));
});

test('at full pool says so rather than printing 0.00 ft down', () => {
  const s = strip({ display_name: 'L', feature_type: 'lake',
    chart_datum: { below_full_pool_ft: 0, level_ft: 225.5, full_pool_ft: 225.5 } });
  assert.match(s.text, /at full pool/);
});

test('nothing to say is idle, and an error is bad — they look different', () => {
  assert.equal(conditionsStrip(null).tone, 'idle');
  assert.equal(conditionsStrip({ error: 'offline' }).tone, 'bad');
  const empty = strip({ display_name: 'L', feature_type: 'lake',
    chart_datum: { pending: 'no source publishes a level for this water' } });
  assert.equal(empty.tone, 'idle');
  assert.match(empty.text, /no source publishes/);
});

test('the resolved water_temp wins, and a tailrace reading is still marked', () => {
  // NWPS publishes no temperature, so Wateree's pool gauge can never answer this. The Worker
  // resolves it from the nearest USGS site that reports 00010 — for Wateree that is
  // "LAKE WATEREE TAILRACE ABOVE CAMDEN", which is below the dam and must say so.
  const c = readConditions({ slug: 'wateree_lake', water: {
    display_name: 'Wateree Lake (Kershaw Co, SC)', feature_type: 'lake',
    chart_datum: { level_ft: 223.5, full_pool_ft: 225.5, below_full_pool_ft: 2, source: 'Duke Energy' },
    pool: { lid: 'WATS1', name: 'Wateree River at Lake Wateree Dam', stage: 223.5 },
    water_temp: { c: 29.4, f: 84.9, usgs_site: '02147801',
                  name: 'LAKE WATEREE TAILRACE ABOVE CAMDEN, SC', role: 'gauge', below_dam: true },
  } });
  assert.equal(c.waterTempF, 84.9);
  assert.equal(c.waterTempFrom, 'tailwater', 'below the dam is not the lake');
  assert.equal(c.waterTempSite, '02147801');
  assert.match(conditionsStrip(c).text, /84\.9°F\*/);
});

test('an on-lake reading is not marked as a tailrace one', () => {
  const c = readConditions({ slug: 's', water: { display_name: 'L', feature_type: 'lake',
    chart_datum: { below_full_pool_ft: 1 },
    water_temp: { c: 26, f: 78.8, usgs_site: '123', name: 'Mid-lake', role: 'pool', below_dam: false } } });
  assert.equal(c.waterTempFrom, 'pool');
  assert.ok(!/°F\*/.test(conditionsStrip(c).text));
});

test('a refused release projection reaches the client, it does not vanish', () => {
  const c = readConditions({ slug: 'broad_river', water: {
    display_name: 'Broad River (Newberry Co, SC)', feature_type: 'river',
    chart_datum: { pending: 'not a lake' },
    releases: null,
    releases_refused: { operator: 'Duke Energy', basin_id: 10, basin_name: 'Yadkin-Pee Dee',
                        why: 'RIVERS.dukeBasinId 10 returned "Yadkin-Pee Dee", which does not name Broad River.' },
  } });
  assert.equal(c.releases, null);
  assert.match(c.releasesRefused.why, /does not name Broad River/);
  assert.equal(c.releasesRefused.basin_id, 10);
  // and it must not sneak into the one-line strip as though a release were coming
  assert.ok(!/release/.test(conditionsStrip(c).text), conditionsStrip(c).text);
});

test('a measured turbidity replaces the modelled clarity and loses the tilde', () => {
  const c = readConditions({ slug: 's', water: {
    display_name: 'L', feature_type: 'lake',
    chart_datum: { below_full_pool_ft: 2 },
    turbidity: { fnu: 12.4, name: 'Tailrace sonde', usgs_site: '02147801' },
  }, clarity: { overall: { clarity: 'Stained', score: 40 }, measured: null } });
  const s = conditionsStrip(c);
  assert.match(s.text, /12\.4 FNU/);
  assert.ok(!/~Stained/.test(s.text), 'a reading must not sit behind a model');
  assert.ok(!s.footnotes.some((f) => /modelled from rainfall/.test(f)));
});

test('with no turbidity reading the modelled clarity still shows, still marked', () => {
  const c = readConditions({ slug: 's', water: { display_name: 'L', feature_type: 'lake',
    chart_datum: { below_full_pool_ft: 2 } },
    clarity: { overall: { clarity: 'Stained' }, measured: null } });
  const s = conditionsStrip(c);
  assert.match(s.text, /~Stained/);
  assert.ok(s.footnotes.some((f) => /modelled from rainfall/.test(f)));
});

test('dissolved oxygen reaches the strip with its unit', () => {
  const c = readConditions({ slug: 's', water: { display_name: 'L', feature_type: 'lake',
    chart_datum: { below_full_pool_ft: 1 },
    dissolved_oxygen: { mg_l: 3.8, name: 'Tailrace', usgs_site: '02147801' } } });
  assert.equal(c.oxygenMgL, 3.8);
  assert.match(conditionsStrip(c).text, /3\.8 mg\/L O₂/);
});

test('each reading keeps its own site — they need not come from one gauge', () => {
  const c = readConditions({ slug: 's', water: { display_name: 'L', feature_type: 'lake',
    chart_datum: { below_full_pool_ft: 1 },
    water_temp: { c: 26, f: 78.8, usgs_site: 'AAA', name: 'Mid-lake', role: 'pool', below_dam: false },
    dissolved_oxygen: { mg_l: 4.1, name: 'Tailrace', usgs_site: 'BBB' } } });
  assert.equal(c.waterTempSite, 'AAA');
  assert.equal(c.oxygenGauge, 'Tailrace');
});

// ── tide and current: served since tideBlock was written, read by nothing until now ──────────
const FUTURE = () => {
  const d = new Date(Date.now() + 90 * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const PAST = () => {
  const d = new Date(Date.now() - 90 * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

test('the NEXT current event is used, not the first of the day', () => {
  const c = readConditions({ slug: 'coast_charleston_sc', water: {
    display_name: 'Charleston Harbor, SC', feature_type: 'coastal', chart_datum: { pending: 'not a lake' } },
    tide: {
      station: { id: '8665530', name: 'Charleston' },
      highs_lows: [{ time: PAST(), ft: 5.4, type: 'H' }, { time: FUTURE(), ft: 0.3, type: 'L' }],
      currents: { station: { id: 'CP0101', name: 'Fort Sumter Range' },
        events: [{ time: PAST(), type: 'flood', speed_kn: 1.8 },
                 { time: FUTURE(), type: 'ebb', speed_kn: -2.1 }] },
    } });
  assert.equal(c.currentType, 'ebb', 'a tide table you have to read past is not an answer');
  assert.equal(c.currentKn, -2.1);
  assert.equal(c.nextTide.type, 'low');
  assert.equal(c.currentStation, 'Fort Sumter Range');
});

test('a coastal zone leads its strip with the current', () => {
  const c = readConditions({ slug: 'x', water: {
    display_name: 'Winyah Bay', feature_type: 'coastal', chart_datum: { pending: 'not a lake' } },
    tide: { station: { id: '1', name: 'S' },
      highs_lows: [{ time: FUTURE(), ft: 4.1, type: 'H' }],
      currents: { station: { id: 'c' }, events: [{ time: FUTURE(), type: 'flood', speed_kn: 1.4 }] } } });
  const s = conditionsStrip(c);
  assert.match(s.text, /^flood 1\.4 kn/);
  assert.match(s.text, /high /);
});

test('a tide station fills the coastal water temperature hole, and says so', () => {
  // Most coastal zones have no USGS site at all, so 00010 can never answer there.
  const c = readConditions({ slug: 'x', water: {
    display_name: 'ACE Basin', feature_type: 'coastal', chart_datum: { pending: 'not a lake' } },
    tide: { station: { id: '1', name: 'Fripp' }, highs_lows: [],
            water_temp: { f: 84.1, at: 't', name: 'Fripp Inlet' } } });
  assert.equal(c.waterTempF, 84.1);
  assert.equal(c.waterTempFrom, 'tide_station');
  assert.equal(c.waterTempGauge, 'Fripp Inlet');
});

test('a USGS reading outranks the tide station — the station fills a hole, it does not win', () => {
  const c = readConditions({ slug: 'x', water: {
    display_name: 'L', feature_type: 'lake', chart_datum: { below_full_pool_ft: 1 },
    water_temp: { c: 26, f: 78.8, usgs_site: 'AAA', name: 'Mid-lake', role: 'pool', below_dam: false } },
    tide: { station: { id: '1', name: 'S' }, highs_lows: [],
            water_temp: { f: 84.1, at: 't', name: 'Somewhere else' } } });
  assert.equal(c.waterTempF, 78.8);
  assert.equal(c.waterTempFrom, 'pool');
});

test('no currents bound is silence, not a zero-knot slack', () => {
  const c = readConditions({ slug: 'x', water: {
    display_name: 'L', feature_type: 'coastal', chart_datum: { pending: 'not a lake' } },
    tide: { station: { id: '1', name: 'S' }, highs_lows: [], currents: null } });
  assert.equal(c.currentKn, null);
  assert.equal(c.currentType, null);
  assert.ok(!/slack/.test(conditionsStrip(c).text));
});

test('an all-in-the-past tide table yields no next event rather than a stale one', () => {
  const c = readConditions({ slug: 'x', water: {
    display_name: 'L', feature_type: 'coastal', chart_datum: { pending: 'not a lake' } },
    tide: { station: { id: '1' }, highs_lows: [{ time: PAST(), ft: 5, type: 'H' }],
            currents: { station: {}, events: [{ time: PAST(), type: 'ebb', speed_kn: 2 }] } } });
  assert.equal(c.nextTide, null);
  assert.equal(c.currentType, null);
});

// ── launch decisions that were already on the response ──────────────────────────────────────
test('action stage is read, and the strip stays quiet when there is no flooding', () => {
  const c = readConditions({ slug: 'x', water: {
    display_name: 'Broad River', feature_type: 'river', chart_datum: { pending: 'not a lake' },
    gauge: { name: 'Alston', stage: 3.2, flow: 1240, flood_category: 'no_flooding',
             flood_thresholds: { action: 12, minor: 15 }, in_service: true } } });
  assert.equal(c.floodActionFt, 12);
  assert.equal(c.stageVsActionFt, -8.8);
  assert.equal(c.floodCategory, 'no_flooding');
  // Saying "no flooding" every day trains you to stop reading the line.
  assert.ok(!/no.flood/i.test(conditionsStrip(c).text), conditionsStrip(c).text);
});

test('a real flood category reaches the strip', () => {
  const c = readConditions({ slug: 'x', water: {
    display_name: 'Broad River', feature_type: 'river', chart_datum: { pending: 'not a lake' },
    gauge: { name: 'Alston', stage: 13.4, flow: 22000, flood_category: 'action',
             flood_thresholds: { action: 12 }, in_service: true } } });
  assert.match(conditionsStrip(c).text, /action/);
  assert.equal(c.stageVsActionFt, 1.4);
});

test('a switched-off gauge is not a gauge reading zero', () => {
  const c = readConditions({ slug: 'x', water: {
    display_name: 'R', feature_type: 'river', chart_datum: { pending: 'not a lake' },
    gauge: { name: 'Alston', stage: 0, flow: 0, in_service: false,
             out_of_service_message: 'Gauge removed for maintenance' } } });
  assert.equal(c.gaugeOutOfService.message, 'Gauge removed for maintenance');
  assert.match(conditionsStrip(c).text, /gauge out of service/);
});

test('the flow anomaly is passed through with its sign and never translated', () => {
  // NOAA's anomaly_category is a code into a legend nobody here has read. The Worker refuses to
  // guess its direction; so does the client.
  const c = readConditions({ slug: 'x', water: {
    display_name: 'R', feature_type: 'river', chart_datum: { pending: 'not a lake' },
    gauge: { flow: 1240, name: 'g' } },
    rivers: { named: [{ name: 'Broad River', flow: 1240, anomaly: -0.38, anomaly_category: 3 }], unnamed: [] } });
  assert.equal(c.flowAnomaly, -0.38);
  assert.equal(c.flowAnomalyOf, 'Broad River');
});

// ── TVA generation and the Corps' drought state ─────────────────────────────────────────────
test('generating now reaches the strip, and so does NOT generating', () => {
  // "not generating" is why nothing is moving on a tailwater, which is as useful as the yes.
  const on = readConditions({ slug: 'x', water: { display_name: 'L', feature_type: 'lake',
    chart_datum: { below_full_pool_ft: 1 },
    tva: { generating_now: true, generation: [{ generators: 2, day: 'Sat', time: '14:00' }], vs_guide_ft: -1.4, guide_curve_ft: 1075 } } });
  assert.equal(on.generatingNow, true);
  assert.equal(on.generationNext.generators, 2);
  assert.equal(on.tvaVsGuideFt, -1.4);
  assert.match(conditionsStrip(on).text, /generating/);

  const off = readConditions({ slug: 'x', water: { display_name: 'L', feature_type: 'lake',
    chart_datum: { below_full_pool_ft: 1 }, tva: { generating_now: false, generation: [] } } });
  assert.equal(off.generatingNow, false);
  assert.match(conditionsStrip(off).text, /not generating/);
});

test('the next generation entry is the next one TURNING, not the first row of the feed', () => {
  const c = readConditions({ slug: 'x', water: { display_name: 'L', feature_type: 'lake',
    chart_datum: { below_full_pool_ft: 1 },
    tva: { generating_now: false,
           generation: [{ generators: 0, time: '08:00' }, { generators: 3, time: '15:00' }] } } });
  assert.equal(c.generationNext.generators, 3);
  assert.equal(c.generationNext.time, '15:00');
});

test('a drought level is only entered when the elevation has actually fallen to it', () => {
  const levels = [{ level: 'Drought Level 1', ft: 656, comment: 'Reduction at Thurmond to 4200 cfs' },
                  { level: 'Drought Level 2', ft: 654, comment: null },
                  { level: 'Drought Level 3', ft: 650, comment: null }];
  const above = readConditions({ slug: 'x', water: { display_name: 'Hartwell', feature_type: 'lake',
    chart_datum: { level_ft: 658.2, full_pool_ft: 660, below_full_pool_ft: 1.8 },
    usace: { project: 'Hartwell', conservation_pool_ft: 660, drought_levels: levels } } });
  assert.equal(above.droughtLevel, null, 'above every level is not in one');
  assert.equal(above.droughtLevels.length, 3);

  const inIt = readConditions({ slug: 'x', water: { display_name: 'Hartwell', feature_type: 'lake',
    chart_datum: { level_ft: 653.1, full_pool_ft: 660, below_full_pool_ft: 6.9 },
    usace: { project: 'Hartwell', conservation_pool_ft: 660, drought_levels: levels } } });
  // At 653.1 the lake is below both Level 1 and Level 2; the deepest one it has reached wins.
  // 653.1 is below Level 1 (656) AND Level 2 (654) but above Level 3 (650). The answer is the
  // DEEPEST level it has fallen past, not the first one in the published list.
  assert.equal(inIt.droughtLevel.level, 'Drought Level 2');
  assert.match(conditionsStrip(inIt).text, /drought level 2/);
});

test('no drought levels published is silence, not "no drought"', () => {
  const c = readConditions({ slug: 'x', water: { display_name: 'L', feature_type: 'lake',
    chart_datum: { level_ft: 100, below_full_pool_ft: 1 },
    usace: { project: 'P', conservation_pool_ft: 101, drought_levels: [] } } });
  assert.equal(c.droughtLevels, null);
  assert.equal(c.droughtLevel, null);
});

// ── salt and net flow on the coast ──────────────────────────────────────────────────────────
test('salinity is reported as salinity when a site publishes it', () => {
  const c = readConditions({ slug: 'x', water: { display_name: 'Winyah Bay', feature_type: 'coastal',
    chart_datum: { pending: 'not a lake' },
    salt: { basis: 'salinity', ppt: 18.4, name: 'Winyah Bay at Georgetown' } } });
  assert.equal(c.salinityPpt, 18.4);
  assert.equal(c.saltBasis, 'salinity');
  assert.equal(c.conductanceUsCm, null);
  assert.match(conditionsStrip(c).text, /18\.4 ppt/);
});

test('conductance is shown in its own unit and NEVER converted to salinity', () => {
  // The Practical Salinity Scale conversion exists. Doing it here would produce a number that
  // looks like a measurement without being one, which is the rule this codebase keeps relearning.
  const c = readConditions({ slug: 'x', water: { display_name: 'ACE Basin', feature_type: 'coastal',
    chart_datum: { pending: 'not a lake' },
    salt: { basis: 'specific_conductance', us_cm: 41200, name: 'Edisto' } } });
  assert.equal(c.conductanceUsCm, 41200);
  assert.equal(c.salinityPpt, null, 'a converted salinity must not appear');
  assert.equal(c.saltBasis, 'specific_conductance');
  assert.match(conditionsStrip(c).text, /41,200 µS\/cm/);
  assert.ok(!/ppt/.test(conditionsStrip(c).text));
});

test('a tidal river reports the FILTERED flow, because the raw one reverses twice a day', () => {
  const c = readConditions({ slug: 'x', water: { display_name: 'Cooper River', feature_type: 'river',
    chart_datum: { pending: 'not a lake' },
    gauge: { flow: -3100, stage: 2.1, name: 'g' },
    tidal_flow: { cfs: 940.5, name: 'Cooper River at Charleston' } } });
  assert.equal(c.tidalFlowCfs, 940.5);
  assert.equal(c.flowCfs, -3100, 'the raw reading is still carried');
  assert.match(conditionsStrip(c).text, /941 ft³\/s net/);
});

test('with no tidal filter the ordinary discharge is used and not labelled net', () => {
  const c = readConditions({ slug: 'x', water: { display_name: 'Broad River', feature_type: 'river',
    chart_datum: { pending: 'not a lake' }, gauge: { flow: 1240, name: 'g' } } });
  assert.match(conditionsStrip(c).text, /1,240 ft³\/s/);
  assert.ok(!/net/.test(conditionsStrip(c).text));
});

test('no salt reading is silence — absence is not fresh water', () => {
  const c = readConditions({ slug: 'x', water: { display_name: 'L', feature_type: 'coastal',
    chart_datum: { pending: 'not a lake' } } });
  assert.equal(c.salinityPpt, null);
  assert.equal(c.conductanceUsCm, null);
  assert.equal(c.saltBasis, null);
  assert.ok(!/ppt|µS/.test(conditionsStrip(c).text));
});

test('the trend reaches the strip as an arrow, and steady says steady', () => {
  const falling = readConditions({ slug: 'x', water: { display_name: 'L', feature_type: 'lake',
    chart_datum: { below_full_pool_ft: 2, level_ft: 223.5 },
    trend: { latest: 223.5, change_24h: -0.42, change_7d: -1.9, units: 'ft',
             measures: 'Pool Elevation', covers_hours: 720 } } });
  assert.equal(falling.trend24h, -0.42);
  assert.match(conditionsStrip(falling).text, /↓0\.42 ft\/24h/);

  const steady = readConditions({ slug: 'x', water: { display_name: 'L', feature_type: 'lake',
    chart_datum: { below_full_pool_ft: 2 },
    trend: { change_24h: 0, change_7d: 0.1, units: 'ft' } } });
  assert.match(conditionsStrip(steady).text, /steady 24h/);
});

test('a trend the series cannot support does not reach the strip at all', () => {
  const c = readConditions({ slug: 'x', water: { display_name: 'L', feature_type: 'lake',
    chart_datum: { below_full_pool_ft: 2 },
    trend: { change_24h: null, change_7d: null, units: 'ft', covers_hours: 6 } } });
  assert.equal(c.trend24h, null);
  assert.ok(!/24h/.test(conditionsStrip(c).text));
});

test('a falling barometer reaches the strip; a flat one does not clutter it', () => {
  const falling = readConditions({ slug: 'x', water: { display_name: 'Charleston Harbor',
    feature_type: 'coastal', chart_datum: { pending: 'not a lake' } },
    tide: { station: { id: '1' }, highs_lows: [],
            pressure: { mb: 1012.4, change_3h: -2.1, stale: false } } });
  assert.equal(falling.pressureMb, 1012.4);
  assert.match(conditionsStrip(falling).text, /baro ↓2\.1mb\/3h/);

  const flat = readConditions({ slug: 'x', water: { display_name: 'C', feature_type: 'coastal',
    chart_datum: { pending: 'not a lake' } },
    tide: { station: { id: '1' }, highs_lows: [],
            pressure: { mb: 1018, change_3h: -0.2, stale: false } } });
  assert.equal(flat.pressureMb, 1018);
  assert.ok(!/baro/.test(conditionsStrip(flat).text), 'a 0.2 mb wobble is not news');
});

test('a stale barometer is withheld from the number and reported as stale', () => {
  const c = readConditions({ slug: 'x', water: { display_name: 'C', feature_type: 'coastal',
    chart_datum: { pending: 'not a lake' } },
    tide: { station: { id: '1' }, highs_lows: [],
            pressure: { mb: 1021.3, change_3h: null, stale: true, age_minutes: 15846 } } });
  assert.equal(c.pressureMb, null, 'an eleven-day-old reading must not print as now');
  assert.equal(c.pressureStale, true);
  assert.ok(!/baro/.test(conditionsStrip(c).text));
});

// ── the nearest weather observation, which was being parsed and thrown away ──────────────────
const OBS = {
  station: 'KCUB', name: 'Columbia - Jim Hamilton L.B. Owens Airport',
  temp_f: 81, dewpoint_f: 75, humidity_pct: 82,
  wind_mph: 14, wind_dir_deg: 225, gust_mph: 22,
  visibility_mi: 10, pressure_mb: 1016, sea_level_pressure_inhg: 30.01,
  wind_chill_f: null, km_from_point: 50.2, observed_at: '16 Aug 17:53 pm EDT',
};

test('an inland lake gets its barometer from the nearest NWS station', () => {
  // CO-OPS covers the 16 coastal zones. There are 348 lakes, and this is the only barometer
  // any of them can have.
  const c = readConditions({ slug: 'wateree_lake', water: { display_name: 'Wateree Lake',
    feature_type: 'lake', chart_datum: { below_full_pool_ft: 2 } },
    forecast: { observation: OBS } });
  assert.equal(c.pressureMb, 1016);
  assert.equal(c.pressureFrom, 'nws_station');
  assert.equal(c.pressure3h, null, 'one observation is not a trend');
  assert.equal(c.obsKmAway, 50.2);
});

test('a coastal tide station outranks the inland ASOS for pressure', () => {
  // The tide station is ON the water; the ASOS can be 50 km inland.
  const c = readConditions({ slug: 'x', water: { display_name: 'Charleston Harbor',
    feature_type: 'coastal', chart_datum: { pending: 'not a lake' } },
    forecast: { observation: OBS },
    tide: { station: { id: '1' }, highs_lows: [],
            pressure: { mb: 1012.4, change_3h: -2.1, stale: false } } });
  assert.equal(c.pressureMb, 1012.4);
  assert.equal(c.pressureFrom, 'tide_station');
  assert.equal(c.pressure3h, -2.1);
});

test('wind reaches the strip once it is blowing, with a compass point', () => {
  const c = readConditions({ slug: 'x', water: { display_name: 'L', feature_type: 'lake',
    chart_datum: { below_full_pool_ft: 1 } }, forecast: { observation: OBS } });
  assert.equal(c.windMph, 14);
  assert.equal(c.gustMph, 22);
  assert.match(conditionsStrip(c).text, /SW 14g22 mph/);
});

test('a calm day does not spend a line on the wind', () => {
  const c = readConditions({ slug: 'x', water: { display_name: 'L', feature_type: 'lake',
    chart_datum: { below_full_pool_ft: 1 } },
    forecast: { observation: { ...OBS, wind_mph: 3, gust_mph: null } } });
  assert.equal(c.windMph, 3);
  assert.ok(!/mph/.test(conditionsStrip(c).text));
});

test('a missing gust does not become a gust of nothing', () => {
  // MapClick sends the literal string "NA"; the Worker turns that into null before it gets here.
  const c = readConditions({ slug: 'x', water: { display_name: 'L', feature_type: 'lake',
    chart_datum: { below_full_pool_ft: 1 } },
    forecast: { observation: { ...OBS, gust_mph: null } } });
  assert.equal(c.gustMph, null);
  assert.match(conditionsStrip(c).text, /SW 14 mph/);
  assert.ok(!/g0|gNaN|gnull/.test(conditionsStrip(c).text));
});

test('no observation at all leaves every field null rather than zero', () => {
  const c = readConditions({ slug: 'x', water: { display_name: 'L', feature_type: 'lake',
    chart_datum: { below_full_pool_ft: 1 } }, forecast: { observation: null } });
  assert.equal(c.windMph, null);
  assert.equal(c.pressureMb, null);
  assert.equal(c.obsStation, null);
});

// ── the last of the fields that were served and never read ──────────────────────────────────
test('civil twilight is read, because that is when the fishing day starts and ends', () => {
  const c = readConditions({ slug: 'x', water: { display_name: 'L', feature_type: 'lake',
    chart_datum: { below_full_pool_ft: 1 } },
    almanac: { sun: { civil_dawn: '6:23 a.m.', rise: '6:47 a.m.', set: '8:04 p.m.',
                      civil_dusk: '8:28 p.m.' },
               moon: { phase: 'Waning Crescent', illumination: '44%' } } });
  assert.equal(c.civilDawn, '6:23 a.m.');
  assert.equal(c.civilDusk, '8:28 p.m.');
  assert.equal(c.sunrise, '6:47 a.m.');
  assert.equal(c.moonIllumination, '44%', 'kept verbatim — the only thing done with it is read it');
});

test('a rain chance of zero is an answer, not an absence', () => {
  // The Number('') family. 0% and "no forecast" must not look the same.
  const zero = readConditions({ slug: 'x', water: { display_name: 'L', feature_type: 'lake',
    chart_datum: { below_full_pool_ft: 1 } },
    forecast: { periods: [{ name: 'Today', pop_pct: 0 }] } });
  assert.equal(zero.popPct, 0);

  const none = readConditions({ slug: 'x', water: { display_name: 'L', feature_type: 'lake',
    chart_datum: { below_full_pool_ft: 1 } }, forecast: { periods: [{ name: 'Today' }] } });
  assert.equal(none.popPct, null);
});

const TIDE = (measuredFt, atOffsetMin, predFt) => {
  const base = Date.now();
  const iso = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  return { station: { id: '8665530' },
    highs_lows: [{ time: iso(base), ft: predFt, type: 'H' }],
    measured_level: { ft: measuredFt, at: iso(base + atOffsetMin * 60000) } };
};

test('the surge is the measured level against the prediction for the same moment', () => {
  const c = readConditions({ slug: 'x', water: { display_name: 'Charleston Harbor',
    feature_type: 'coastal', chart_datum: { pending: 'not a lake' } }, tide: TIDE(6.6, 10, 5.4) });
  assert.equal(c.surgeFt, 1.2);
  assert.match(conditionsStrip(c).text, /\+1\.2 ft vs predicted/);
});

test('a prediction hours away measures the tide, not the surge, and is refused', () => {
  const c = readConditions({ slug: 'x', water: { display_name: 'C', feature_type: 'coastal',
    chart_datum: { pending: 'not a lake' } }, tide: TIDE(6.6, 180, 5.4) });
  assert.equal(c.surgeFt, null);
});

test('a surge inside the noise floor stays off the one-line strip', () => {
  const c = readConditions({ slug: 'x', water: { display_name: 'C', feature_type: 'coastal',
    chart_datum: { pending: 'not a lake' } }, tide: TIDE(5.5, 5, 5.4) });
  assert.equal(c.surgeFt, 0.1);
  assert.ok(!/vs predicted/.test(conditionsStrip(c).text));
});

test('the current set uses the flood direction on a flood and the ebb on an ebb', () => {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');
  const mk = (type) => readConditions({ slug: 'x', water: { display_name: 'C',
    feature_type: 'coastal', chart_datum: { pending: 'not a lake' } },
    tide: { station: { id: '1' }, highs_lows: [], currents: { station: {}, events: [
      { time: future, type, speed_kn: 1.5, mean_flood_dir: 310, mean_ebb_dir: 130 }] } } });
  assert.equal(mk('flood').currentDirDeg, 310);
  assert.equal(mk('ebb').currentDirDeg, 130);
});

test("TVA's own discharge and tailwater are read", () => {
  const c = readConditions({ slug: 'x', water: { display_name: 'L', feature_type: 'lake',
    chart_datum: { below_full_pool_ft: 1 },
    tva: { discharge_cfs: 12400, tailwater_ft: 812.4, generating_now: true, generation: [] } } });
  assert.equal(c.tvaDischargeCfs, 12400);
  assert.equal(c.tvaTailwaterFt, 812.4);
});

test('the flow band reaches the strip next to the flow, because the number needs it', () => {
  const c = readConditions({ slug: 'x', water: { display_name: 'Broad River', feature_type: 'river',
    chart_datum: { pending: 'not a lake' },
    gauge: { flow: 310, name: 'Alston', usgs_site: '02148000' },
    flow_vs_history: { label: 'below the 10th percentile', median: 1500, years: 96,
                       period: '1930–2026', flow_cfs: 310, usgs_site: '02148000',
                       note: 'a band between published set points, not an interpolated percentile' } } });
  assert.equal(c.flowBand, 'below the 10th percentile');
  assert.equal(c.flowMedian, 1500);
  assert.equal(c.flowYears, 96);
  const s = conditionsStrip(c).text;
  assert.match(s, /310 ft³\/s/);
  assert.match(s, /below 10th pct/);
});

test('a lake gets no flow band — the percentile of a lake discharge is nobody\'s question', () => {
  const c = readConditions({ slug: 'x', water: { display_name: 'L', feature_type: 'lake',
    chart_datum: { below_full_pool_ft: 2 }, flow_vs_history: null } });
  assert.equal(c.flowBand, null);
  assert.ok(!/pct/.test(conditionsStrip(c).text));
});

test('an empty field says WHY when the site catalogue can answer', () => {
  const c = readConditions({ slug: 'x', water: { display_name: 'L', feature_type: 'lake',
    chart_datum: { below_full_pool_ft: 1 }, sites_catalogued: 2,
    unpublished_parameters: [{ code: '63680', label: 'turbidity' },
                             { code: '00480', label: 'salinity' }] } });
  assert.equal(c.unpublished.length, 2);
  assert.equal(c.unpublished[0].label, 'turbidity');
  // and it stays off the one-line strip — this is a note about the registry, not the water
  assert.ok(!/turbidity/.test(conditionsStrip(c).text));
});

test('no catalogue read means no claim about what is unpublished', () => {
  // Silence about a field means "not fetched". Saying "nobody publishes it" without having
  // looked would be a stronger claim than we hold.
  const c = readConditions({ slug: 'x', water: { display_name: 'L', feature_type: 'lake',
    chart_datum: { below_full_pool_ft: 1 }, sites_catalogued: 0, unpublished_parameters: null } });
  assert.equal(c.unpublished, null);
});
