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
 *     2026-09-28   +0.89 / +0.89 ft        3.51  NWPS WATS1 96.49     2.62 / 2.62   (sounder checked)
 *
 * At full pool the chart would read 2.8-3.5 ft deeper than the sounder. It reads 0.4-1.1 ft deeper,
 * and the level it implies holds at 2.1-2.6 ft below full pool (median 2.35) while the lake moved
 * 0.7 ft -- so on 9/28, 3.5 ft down, the water was about 1.2 ft shallower than the chart and the app
 * was taking off 3.5. The transducer sits a few inches under the surface with no Keel Offset, so the sounder
 * reads depth below the transducer; that is folded into the figure, which is right for the one
 * thing that reads it hardest: the Contour alarm reads the same sounder.
 *
 * WHAT A WATER WITH NO ROW GETS. Ryan, asked the same night: the chart as it stands, and the plan
 * says it is not corrected. Keeping the full drawdown was the other choice, and on the one lake
 * measured it was 2.3 ft wrong.
 *
 * ADDING A WATER: measure it the same way from one of his exports on that water and the lake's
 * level on those days, then add the row with the days it came from. A row without its days is a
 * number nobody can check.
 */
//
// REVERTED AND PUT BACK, 2026-09-27 TO 09-28. `89da675` took this table out the same night on two
// things: Garmin's statement that Navionics lake charts are made at full pool, and a sand bar Ryan
// could see dry at 34.37814, -80.73880 where the chart says 2-3 ft. It left open whether his sounder
// read about 2 ft deep. On the water on 9/28 he settled both: "keel offset was at 0. At the ramp the
// board and the sonar matched within inches", and the sand bar "is not on Garmin maps at all there
// is buoy at the end of the sandbar and Garmin shows that buoy in 11ft. It was in about 2ft". So the
// chart is wrong at that bar by 9 ft and it never spoke to the level; the sounder is true; and the
// 9/28 track (28SEP26EXPORT.GPX, 989 points) read +0.89 ft with the lake 3.51 ft down, a chart
// 2.62 ft below full pool, in line with the other three days.
//
// THE ROW'S LEVEL IS THE MEDIAN OF ITS DAYS, computed here, not typed. Each day says what the chart
// was made at: that day's drawdown less how much deeper the chart read than the sounder. A new day
// is a new row in `measured` and the figure moves with it.
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const impliedLevel = (m) => m.belowFullPoolFt - m.chartMinusSounderFt;
const levelRow = (row) => Object.freeze({
  ...row,
  measured: Object.freeze(row.measured.map((m) => Object.freeze(m))),
  belowFullPoolFt: Math.round(median(row.measured.map(impliedLevel)) * 100) / 100,
});

export const CHART_LEVELS = Object.freeze({
  wateree_lake: levelRow({
    measured: [
      { day: '2026-08-29', chartMinusSounderFt: 0.45, belowFullPoolFt: 2.83,
        level: 'NWPS WATS1 97.17' },
      { day: '2026-08-31', chartMinusSounderFt: 0.67, belowFullPoolFt: 2.84,
        level: 'NWPS WATS1 97.16' },
      { day: '2026-09-26', chartMinusSounderFt: 1.08, belowFullPoolFt: 3.40,
        level: 'Duke Energy, in the saved plan' },
      { day: '2026-09-28', chartMinusSounderFt: 0.89, belowFullPoolFt: 3.51,
        level: 'NWPS WATS1 96.49 at 15:00 EDT; Duke 222.0 ft' },
    ],
    how: "his unit's ACTIVE LOG (26SEP26EXPORT.GPX, 28SEP26EXPORT.GPX) against the pack's depth bands "
       + 'and contours; on 9/28 his Keel Offset read 0 and a measuring board matched the sounder',
  }),
  // LAKE MARION, 2026-10-08, Wyboo Creek. Ryan, comparing the day's track with Option 1: "so this
  // appears to match what i saw on my sounder vs the map... so it looks like marion was charted by
  // garmin at full pool", and of what he saw on the water: "on my fish finder compared from the chart
  // i to the depth i am given from the sonar there was approximately a 4ft difference".
  //
  // His active log says the same with each charted band read by its DEEPER number (`depth_max_ft`,
  // the number this app reads: depthGrid(), plan-water-index.js, the map's colours): the chart read
  // 3.98 ft deeper than the sounder over 918 points (the app's own grid 3.99; the RSD sonar trace,
  // 17,924 one-second readings, 4.03), and the same from 5 to 30 ft (`_scratch/marion_level_1008/`).
  // The lake was 4.01 ft down. So the chart is at full pool, as Garmin says.
  //
  // THIS ROW FIRST SAID 0.6 FT BELOW (`261a117`), off the band's MIDDLE and the contour lines (3.41),
  // half a foot shallower than the number the app reads -- my reading, not his sounder. Ryan: "just
  // fix marion". Wateree's row above is read at the band's middle too and is left as it is: "i have
  // no idea for wateree".
  //
  // THE GAUGE'S MARK IS NGVD29, WHATEVER ITS NWS RECORD SAYS. NWS lists LMES1 and PNVS1 as NAVD88,
  // but the numbers they publish are USGS's NGVD29 series (73.50 at 13:00 EDT on 9/13 on both, where
  // the NAVD88 series read 72.43), and Santee Cooper's 76.8 is on that scale (PNVS1 states "76.8: Full
  // pool" on it). Read against NAVD88 the lake would have looked 1.07 ft further down.
  lake_marion: levelRow({
    measured: [
      { day: '2026-10-08', chartMinusSounderFt: 3.98, belowFullPoolFt: 4.01,
        level: 'USGS 02169921 (NWS LMES1) 72.78-72.81 ft NGVD29, 12:15-17:06 EDT; full pool 76.8' },
    ],
    how: "his unit's ACTIVE LOG (08OCT2026.GPX, 918 points), each band read by its deeper number as the "
       + 'app reads it; his fish finder showed him about 4 ft; the RSD sonar trace read 4.03',
  }),
});

/** The measured chart level for a water, or null when nobody has measured it. */
export function chartLevelFor(slug) {
  return (slug && Object.prototype.hasOwnProperty.call(CHART_LEVELS, slug))
    ? CHART_LEVELS[slug] : null;
}

/** The days a chart level was measured on, for a sentence: "2026-08-29, 2026-08-31 and 2026-09-28". */
export function measuredDays(row) {
  const d = ((row && row.measured) || []).map((m) => m.day);
  return d.length > 1 ? `${d.slice(0, -1).join(', ')} and ${d[d.length - 1]}` : (d[0] || '');
}
