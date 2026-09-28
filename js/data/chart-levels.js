/**
 * chart-levels.js -- the level Garmin's chart was made at, per water, MEASURED against Ryan's own
 * sounder. One row per water he has logged; every other water has no row, and a water with no row
 * is planned on the chart as it stands.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHY THIS EXISTS
 *
 * Until 2026-09-27 the app took every lake chart as sounded at FULL POOL and took the whole
 * drawdown off every charted depth (poolOffsetFt() in water-conditions.js). Ryan had said so on
 * 2026-08-26 -- "so garmin is charted at full pool... we know what the lake level is" -- and the
 * Worker's chartDatumShape() said it of every pack. Nobody had measured it.
 *
 * Measured the night of 2026-09-27, when he asked whether the depth key was accurate. His unit's
 * ACTIVE LOG carries the sounder's depth on every track point, so every trip he exports is a
 * survey of the chart. On Wateree, reading the chart at each point from the pack's depth bands and
 * from the contours within 5 m (`_scratch/chartcheck/`):
 *
 *     day          chart minus sounder     lake below full pool       chart made at, below full
 *     2026-08-29   +0.46 / +0.43 ft        2.83  NWPS WATS1 97.17     2.37 / 2.40
 *     2026-08-31   +0.62 / +0.72 ft        2.84  NWPS WATS1 97.16     2.22 / 2.12
 *     2026-09-26   +1.08 / +1.08 ft        3.40  Duke, the plan's      2.32 / 2.32
 *
 * At full pool the chart would read 2.8-3.4 ft deeper than the sounder. It reads 0.4-1.1 ft deeper,
 * and the level it implies holds at about 2.3 ft below full pool while the lake moved 0.6 ft -- so
 * on 9/28, 3.5 ft down, the water was about 1.2 ft shallower than the chart and the app was taking
 * off 3.5. The transducer's own depth below the surface is unknown and is folded into the figure,
 * which is right for the one thing that reads it hardest: the Contour alarm reads the same sounder.
 *
 * WHAT A WATER WITH NO ROW GETS. Ryan, asked the same night: the chart as it stands, and the plan
 * says it is not corrected. Keeping the full drawdown was the other choice, and on the one lake
 * measured it was 2.3 ft wrong.
 *
 * ADDING A WATER: measure it the same way from one of his exports on that water and the lake's
 * level on those days, then add the row with the days it came from. A row without its days is a
 * number nobody can check.
 */
export const CHART_LEVELS = Object.freeze({
  wateree_lake: Object.freeze({
    belowFullPoolFt: 2.3,
    measured: Object.freeze([
      Object.freeze({ day: '2026-08-29', chartMinusSounderFt: 0.45, belowFullPoolFt: 2.83,
                      level: 'NWPS WATS1 97.17' }),
      Object.freeze({ day: '2026-08-31', chartMinusSounderFt: 0.67, belowFullPoolFt: 2.84,
                      level: 'NWPS WATS1 97.16' }),
      Object.freeze({ day: '2026-09-26', chartMinusSounderFt: 1.08, belowFullPoolFt: 3.40,
                      level: 'Duke Energy, in the saved plan' }),
    ]),
    how: "his unit's ACTIVE LOG (26SEP26EXPORT.GPX) against the pack's depth bands and contours",
  }),
});

/** The measured chart level for a water, or null when nobody has measured it. */
export function chartLevelFor(slug) {
  return (slug && Object.prototype.hasOwnProperty.call(CHART_LEVELS, slug))
    ? CHART_LEVELS[slug] : null;
}

/** The days a chart level was measured on, for a sentence: "2026-08-29, 2026-08-31 and 2026-09-26". */
export function measuredDays(row) {
  const d = ((row && row.measured) || []).map((m) => m.day);
  return d.length > 1 ? `${d.slice(0, -1).join(', ')} and ${d[d.length - 1]}` : (d[0] || '');
}
