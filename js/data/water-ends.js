/**
 * water-ends.js -- the ends of a lake as Ryan names them, and the landings in each.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 2026-11-22, planning Monday on Wateree, where the reports for those weeks named two places and said "the lower
 * end" again and again: "another suggestion would be figuring out what we call the lower end and which ramps fall into
 * it... i bet there are reports that say at the lower end or by the dam... anything south of beaver creek i would call
 * lower end. middle from beaver north to state park and then upper end from state park north". Then, with a picture of
 * the landings in front of him: "i would have drawn it straight across the lake and given beaver creek, june creek, and
 * dutchman to middle. then state park, taylor and wateree creek to upper". Lugoff is not here: "lugoff is the river below
 * the dam".
 *
 * The keys are the report reader's own names for the parts of a lake (`area` on a statement, Scripts/report_places.py:
 * 'lower lake' for "lower end / lower lake / lower part / down the lake / near the dam", 'mid lake' for "mid-lake /
 * middle section", 'upper lake' for "upper end / up the lake / headwaters"). Each end is ITS LANDINGS, as he gave them:
 * any spot on the lake is in the end of the landing nearest it. A landing that is closed still marks its end.
 */

export const WATER_ENDS = Object.freeze({
  wateree_lake: Object.freeze({
    said: 'Ryan, 2026-11-22',
    ends: Object.freeze([
      Object.freeze({ key: 'lower lake', name: 'Lower end', landings: Object.freeze([
        { name: 'Clearwater Cove', at: [-80.728814, 34.379271] },
        { name: 'Colonel Creek', at: [-80.797237, 34.368854] },
        { name: 'Molly Creek', at: [-80.787994, 34.382753] },
        { name: 'Buckhill Landing', at: [-80.707209, 34.335864] },
        { name: 'Lakeside Marina', at: [-80.6993, 34.3641] },
      ]) }),
      Object.freeze({ key: 'mid lake', name: 'Middle', landings: Object.freeze([
        { name: 'Beaver Creek', at: [-80.770029, 34.434081] },
        { name: 'June Creek', at: [-80.829429, 34.391261] },
        { name: 'Dutchman Marina', at: [-80.8679, 34.4241] },
      ]) }),
      Object.freeze({ key: 'upper lake', name: 'Upper end', landings: Object.freeze([
        { name: 'Lake Wateree State Park', at: [-80.858374, 34.432841] },
        { name: 'Taylor Creek', at: [-80.875784, 34.43773] },
        { name: 'Wateree Creek Access Area', at: [-80.913862, 34.469605] },
      ]) }),
    ]),
  }),
});

const metres = (a, b) => {
  const kx = 111320 * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  return Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * 110540);
};

/** The ends of this water, or [] where he has not named them. */
export function endsOf(slug) {
  return (WATER_ENDS[slug] && WATER_ENDS[slug].ends) || [];
}

/** The end a spot ([lon, lat]) is in: the end of the landing nearest it. Null where the water has no ends. */
export function endAt(slug, at) {
  if (!Array.isArray(at)) return null;
  let best = null, bm = Infinity;
  for (const e of endsOf(slug)) for (const l of e.landings) {
    const m = metres(l.at, at);
    if (m < bm) { bm = m; best = e; }
  }
  return best;
}

/**
 * Where an end is fished from this ramp: by the ramp when the ramp is in it, otherwise at its landing nearest the ramp
 * (as the crow flies; the area day measures it by water). {at, byRamp, landing}.
 */
export function endFrom(slug, end, ramp) {
  if (!end || !Array.isArray(ramp)) return null;
  const mine = endAt(slug, ramp);
  if (mine && mine.key === end.key) return { at: ramp, byRamp: true, landing: null };
  const l = end.landings.slice().sort((a, b) => metres(a.at, ramp) - metres(b.at, ramp))[0];
  return l ? { at: l.at, byRamp: false, landing: l.name } : null;
}
