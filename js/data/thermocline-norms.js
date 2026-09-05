/**
 * thermocline-norms.js -- where the thermocline typically sits, by lake max
 * depth and month, from 1669 EPA National Lakes Assessment summer casts.
 *
 * NOT A MEASUREMENT OF ANY WATER. This answers "a lake this deep, this month,"
 * and it is read ONLY where the Water Quality Portal and the document casts both
 * came up empty. Every row carries its interquartile spread and whatever prints
 * it must print that too: at the ninetieth percentile the error on a big lake is
 * still twenty feet, and a number with no band beside it is how Lake Wateree
 * carried a fabricated 27 ft thermocline for months.
 *
 * The depth classes are the quartiles of max_depth_ft across the waters the app
 * offers, rounded to 5 ft -- not four numbers somebody liked.
 *
 * GENERATED FILE -- DO NOT EDIT BY HAND.
 * Source of truth: EPA NLA profile CSVs under registry/_nla/
 * Regenerate:      py Scripts/build_thermocline_norms.py --go --repo .
 * Guarded by:      test/a-norm-is-not-a-measurement.test.js
 *
 * Personal use only, not for distribution or resale; not for navigation.
 */
export const THERMOCLINE_NORMS = {
  "depthClassEdgesFt": [
    15,
    25,
    60
  ],
  "byMonth": {
    "6": {
      "medianFt": 12.8,
      "p25Ft": 8.2,
      "p75Ft": 18.0,
      "casts": 256
    },
    "7": {
      "medianFt": 14.8,
      "p25Ft": 11.1,
      "p75Ft": 18.0,
      "casts": 374
    },
    "8": {
      "medianFt": 14.8,
      "p25Ft": 11.5,
      "p75Ft": 21.3,
      "casts": 289
    },
    "9": {
      "medianFt": 20.9,
      "p25Ft": 14.8,
      "p75Ft": 24.6,
      "casts": 134
    }
  },
  "byDepthClassAndMonth": {
    "0:6": {
      "medianFt": 9.2,
      "p25Ft": 4.9,
      "p75Ft": 10.9,
      "casts": 56,
      "stdErrFt": 0.7
    },
    "0:7": {
      "medianFt": 10.3,
      "p25Ft": 8.2,
      "p75Ft": 11.3,
      "casts": 71,
      "stdErrFt": 0.3
    },
    "0:8": {
      "medianFt": 10.6,
      "p25Ft": 8.2,
      "p75Ft": 11.5,
      "casts": 62,
      "stdErrFt": 0.4
    },
    "0:9": {
      "medianFt": 11.3,
      "p25Ft": 7.4,
      "p75Ft": 11.9,
      "casts": 18,
      "stdErrFt": 1.0
    },
    "1:6": {
      "medianFt": 11.5,
      "p25Ft": 8.2,
      "p75Ft": 14.8,
      "casts": 82,
      "stdErrFt": 0.7
    },
    "1:9": {
      "medianFt": 14.8,
      "p25Ft": 13.6,
      "p75Ft": 18.3,
      "casts": 30,
      "stdErrFt": 0.8
    },
    "2:6": {
      "medianFt": 14.8,
      "p25Ft": 11.5,
      "p75Ft": 21.3,
      "casts": 84,
      "stdErrFt": 1.0
    },
    "2:8": {
      "medianFt": 18.0,
      "p25Ft": 14.8,
      "p75Ft": 24.6,
      "casts": 109,
      "stdErrFt": 0.9
    },
    "3:6": {
      "medianFt": 21.3,
      "p25Ft": 18.0,
      "p75Ft": 32.0,
      "casts": 34,
      "stdErrFt": 2.2
    },
    "3:7": {
      "medianFt": 18.1,
      "p25Ft": 14.8,
      "p75Ft": 24.6,
      "casts": 56,
      "stdErrFt": 1.2
    },
    "3:8": {
      "medianFt": 26.2,
      "p25Ft": 21.3,
      "p75Ft": 34.4,
      "casts": 52,
      "stdErrFt": 1.7
    },
    "3:9": {
      "medianFt": 32.8,
      "p25Ft": 24.6,
      "p75Ft": 44.3,
      "casts": 28,
      "stdErrFt": 3.5
    }
  }
};

/** The depth class a lake falls in, or null when its max depth is unknown. */
export function depthClassFor(maxDepthFt) {
  const d = Number(maxDepthFt);
  if (!Number.isFinite(d) || d <= 0) return null;
  const e = THERMOCLINE_NORMS.depthClassEdgesFt;
  return d < e[0] ? 0 : d < e[1] ? 1 : d < e[2] ? 2 : 3;
}

/**
 * The typical thermocline for a lake this deep in this month, or null.
 *
 * The depth-class row is preferred and the month row is the fallback, because a
 * class is published only where its spread is NARROWER than the month's -- see
 * build_thermocline_norms.py. Outside June-September there is no answer here at
 * all: a lake that is not stratified has no thermocline to state.
 */
export function thermoclineNorm(maxDepthFt, month) {
  const m = Number(month);
  if (!(m >= 6 && m <= 9)) return null;
  const c = depthClassFor(maxDepthFt);
  const cell = c === null ? null
    : THERMOCLINE_NORMS.byDepthClassAndMonth[`${c}:${m}`] || null;
  const row = cell || THERMOCLINE_NORMS.byMonth[String(m)] || null;
  if (!row) return null;
  return { ...row, month: m, basis: cell ? 'depth class and month' : 'month' };
}
