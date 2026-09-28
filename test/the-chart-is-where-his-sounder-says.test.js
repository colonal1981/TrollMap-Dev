// The chart is where his sounder says it is, not at full pool.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-09-27: "is the depth key in the app accurate? is that what i should set my garmin depth
// shadings to?" Answering it meant reading his unit's ACTIVE LOG, which carries the sounder's depth
// on every track point, against the Wateree pack. On 8/29, 8/31 and 9/26 the chart read 0.4-1.1 ft
// deeper than the sounder -- not the 2.8-3.4 ft a full-pool chart would -- and the level it implies
// held at about 2.3 ft below full pool (js/data/chart-levels.js). Every "today" depth the app
// printed on Wateree was 2.3 ft too shallow. Asked what an unmeasured lake should get, he chose the
// chart as it stands, said so.
//
// What these hold:
//   1. the table's rows carry their days, and each row agrees with its own days;
//   2. readConditions puts the measured chart level on the water state, and only where there is one;
//   3. poolOffsetFt is the lake against the chart's level, and null for a chart nobody measured;
//   4. a leg start flag names the alarm band in today's water and the shading band on the chart.

import { describe, it } from './expect-shim.mjs';
import assert from 'node:assert/strict';
import { CHART_LEVELS, chartLevelFor, measuredDays } from '../js/data/chart-levels.js';
import { readConditions, poolOffsetFt } from '../js/utils/water-conditions.js';
import { planWaypoints } from '../js/modules/plan-tracks.js';

const body = (slug, below) => ({
  slug,
  water: { slug, display_name: slug, feature_type: 'lake',
           chart_datum: { below_full_pool_ft: below, level_ft: 225.5 - below, full_pool_ft: 225.5,
                          source: 'Duke Energy' } },
});

describe('the chart level is a measurement with its days on it', () => {
  it('every row names the days it came from, and agrees with them', () => {
    for (const [slug, row] of Object.entries(CHART_LEVELS)) {
      assert.ok(row.measured.length > 0, `${slug} has no days`);
      for (const m of row.measured) {
        // What that day says the chart was made at: the lake's drawdown less how much deeper the
        // chart read than the sounder. The row's figure has to sit with its own days.
        const implied = m.belowFullPoolFt - m.chartMinusSounderFt;
        assert.ok(Math.abs(implied - row.belowFullPoolFt) <= 0.25,
          `${slug} ${m.day}: implies ${implied.toFixed(2)}, row says ${row.belowFullPoolFt}`);
      }
    }
    assert.equal(chartLevelFor('wateree_lake').belowFullPoolFt, 2.3);
    assert.equal(chartLevelFor('lake_murray'), null, 'nobody has measured Murray');
    assert.equal(measuredDays(chartLevelFor('wateree_lake')), '2026-08-29, 2026-08-31 and 2026-09-26');
  });
});

describe('the water state carries it, and the offset is against it', () => {
  it('Wateree 3.5 ft down is 1.2 ft shallower than its chart, not 3.5', () => {
    const ws = readConditions(body('wateree_lake', 3.5));
    assert.equal(ws.chartBelowFullPoolFt, 2.3);
    assert.equal(poolOffsetFt(ws), 1.2);
  });

  it('a lake nobody has measured gets the chart as it stands', () => {
    const ws = readConditions(body('lake_murray', 5.56));
    assert.equal(ws.belowFullPoolFt, 5.56, 'the level is still read and still said');
    assert.equal(ws.chartBelowFullPoolFt, null);
    assert.equal(poolOffsetFt(ws), null);
  });
});

describe('the start flag tells the alarm from the shading', () => {
  it('the alarm band is today\'s water and the shading band is the chart', () => {
    const leg = { id: 'L1', type: 'troll', depthFt: 20, drawdownFt: 1.2, startM: 0, lengthM: 900,
                  coordinates: [[-80.72, 34.37], [-80.71, 34.37]], stops: [], marks: [] };
    const start = planWaypoints({ legs: [leg] }).find((w) => w.legStart);
    assert.equal(start.name, 'L1 start 14-24ft');            // 20 - 1.2 = 18.8, the sounder's
    assert.equal(start.tacticalNote,
      'start of L1: Contour alarm 14-24ft; Depth Shading 15-25ft on the chart');
  });

  it('with no offset the two are one band', () => {
    const leg = { id: 'L1', type: 'troll', depthFt: 20, startM: 0, lengthM: 900,
                  coordinates: [[-80.72, 34.37], [-80.71, 34.37]], stops: [], marks: [] };
    const start = planWaypoints({ legs: [leg] }).find((w) => w.legStart);
    assert.equal(start.tacticalNote, 'start of L1: Contour alarm and Depth Shading 15-25ft');
  });
});
