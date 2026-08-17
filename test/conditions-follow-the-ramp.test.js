// The point you ask about is the answer you get.
//
// Ryan, 2026-08-17, after picking one landing and still seeing four Congaree camera views:
// *"it would be nice to get the gauge and camera just for the ramp that is selected."*
//
// waterBlock() has always chosen `water.gauge` as the nearest bound gauge to the lat/lon on the
// request, and the client has always sent the water's CENTROID. On the Congaree that centroid
// sits 46 km from Bates Bridge, up toward Columbia. CFMS1 — "Congaree River above Fort Motte",
// USGS 02169750, 113 m from the ramp — was bound, fetched every time, and never chosen. The
// capability existed and was never reached, which is the same as no capability.
//
// AND THE FIX HAS A TRAP IN IT. Once the point can be a ramp, "nearest gauge" on a lake is
// often the tailrace: of the 49 lakes carrying a pool gauge, 39 also carry gauges that are not
// the lake. Thurmond has "Savannah River near Clarks Hill" and "Stevens Creek". Asked directly,
// Ryan chose: on a lake the pool stays the lake's number.
import { conditionsUrl, readConditions } from '../js/utils/water-conditions.js';

let fails = 0;
const check = (name, cond, got) => {
  if (cond) { console.log(`  ok   ${name}`); return; }
  fails++; console.log(`  FAIL ${name}${got === undefined ? '' : ` — got ${JSON.stringify(got)}`}`);
};

const CONGAREE = { slug: 'congaree_river', lat: 34.053631, lon: -80.98814 };   // registry centroid
const BATES = { name: 'Bates Bridge', lat: 33.75333, lon: -80.64472 };          // the launch

console.log('== the point on the request ==');
{
  const centroid = conditionsUrl('https://w', CONGAREE);
  check('no launch selected still asks about the centroid',
    /lat=34.053631&lon=-80.98814/.test(centroid), centroid);

  const atRamp = conditionsUrl('https://w', CONGAREE, { point: BATES });
  check('a launch replaces it', /lat=33.75333&lon=-80.64472/.test(atRamp), atRamp);
  check('and the slug is untouched — a launch is not a different water',
    /\/conditions\/congaree_river\?/.test(atRamp), atRamp);

  // A ramp whose coords did not parse must not silently become the centroid's neighbour or
  // NaN in a query string. It falls back to the water, which is the previous behaviour.
  check('a point with no numbers falls back to the water',
    /lat=34.053631/.test(conditionsUrl('https://w', CONGAREE, { point: { lat: NaN, lon: -80.6 } })));
  check('a half-built point falls back too',
    /lat=34.053631/.test(conditionsUrl('https://w', CONGAREE, { point: { name: 'x' } })));
  check('no centroid and no point is no url',
    conditionsUrl('https://w', { slug: 'x' }, { point: { lat: 'a', lon: 'b' } }) === null);
}

// Two gauges reading two different things, which is the whole difficulty.
const POOL_ELEV = { name: 'THURMOND LAKE NEAR PLUM BRANCH, SC', stage: 323.08,
                    stage_basis: 'elevation_above_datum', km_from_point: 11.4, flow: null };
const TAILRACE = { name: 'SAVANNAH RIVER NEAR CLARKS HILL, S.C.', stage: 6.2,
                   stage_basis: 'gage_height', km_from_point: 0.4, flow: 5200 };

console.log('\n== a lake has one surface ==');
{
  const c = readConditions({ slug: 'thurmond', water: {
    feature_type: 'lake', pool: POOL_ELEV, tailwater: null, gauge: TAILRACE } });
  check('the pool is the lake, even with the tailrace 11 km closer to the launch',
    c.stageFt === 323.08, [c.stageFt, c.stageGauge]);
  check('and it is labelled as an elevation', c.stageBasis === 'elevation_above_datum', c.stageBasis);
  check('the role is carried so the card can say which gauge won',
    c.stageGaugeRole === 'pool', c.stageGaugeRole);
  check('distance from the launch is carried', c.stageGaugeKm === 11.4, c.stageGaugeKm);
  // Flow is not a lake fact and the pool does not publish one, so it still falls through —
  // but it is NAMED, so a discharge from the tailrace cannot read as the lake doing something.
  check('flow falls through to the gauge that has one', c.flowCfs === 5200, c.flowCfs);
  check('and says whose it is', /clarks hill/i.test(c.flowGauge || ''), c.flowGauge);
}

console.log('\n== a river does not ==');
{
  const GADS = { name: 'Congaree River at Congaree National Park', stage: 4.18,
                 stage_basis: 'gage_height', flow: 4170, km_from_point: 21.5 };
  const CFMS = { name: 'Congaree River above Fort Motte SC', stage: 75.25,
                 stage_basis: 'gage_height', flow: null, km_from_point: 0.1 };

  const c = readConditions({ slug: 'congaree_river', water: {
    feature_type: 'river', pool: GADS, tailwater: null, gauge: CFMS } });
  check('the gauge at the launch wins the stage', c.stageFt === 75.25, [c.stageFt, c.stageGauge]);
  check('named', /Fort Motte/.test(c.stageGauge || ''), c.stageGauge);
  check('at 0.1 km', c.stageGaugeKm === 0.1, c.stageGaugeKm);
  // CFMS1 publishes no discharge — NWPS returns secondary -999 on it — so the flow legitimately
  // comes from 21.5 km upstream. That is fine, and the distance is why it must be said out loud.
  check('flow falls through to the one that has it', c.flowCfs === 4170, c.flowCfs);
  check('and carries how far away that was', c.flowGaugeKm === 21.5, c.flowGaugeKm);
}

console.log('\n== coastal is not a lake ==');
{
  const c = readConditions({ slug: 'coast_x', water: {
    feature_type: 'coastal', pool: { name: 'far pool', stage: 99, km_from_point: 30 },
    tailwater: null, gauge: { name: 'near gauge', stage: 1.2, km_from_point: 0.5 } } });
  check('nearest wins, same as a river', c.stageFt === 1.2, [c.stageFt, c.stageGauge]);
}

console.log('\n== the threshold still comes from the gauge that gave the stage ==');
{
  // This is the bug from 2026-08-16 and it must not come back through the new ordering: an
  // elevation above datum minus another gauge's local action stage is a number that looks like
  // feet and is not.
  const c = readConditions({ slug: 'thurmond', water: {
    feature_type: 'lake',
    pool: { ...POOL_ELEV, flood_thresholds: null },
    tailwater: null,
    gauge: { ...TAILRACE, flood_thresholds: { action: 14 } } } });
  check('no action-stage comparison when the threshold belongs to a different gauge',
    c.stageVsActionFt === null, c.stageVsActionFt);
  check('and no action figure is invented', c.floodActionFt === null, c.floodActionFt);
}

console.log('\n== nothing selected is still nothing ==');
{
  const c = readConditions({ slug: 'x', water: { feature_type: 'lake', pool: null, tailwater: null, gauge: null } });
  check('no stage', c.stageFt === null);
  check('no distance invented', c.stageGaugeKm === null && c.flowGaugeKm === null);
}

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURES'}`);
process.exit(fails ? 1 : 0);
