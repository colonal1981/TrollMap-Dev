/**
 * utils/solunar.js — moon-driven feeding windows. ONE implementation.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHY THIS FILE EXISTS
 *
 * TrollMap had two, and they disagreed by up to eleven hours:
 *
 *   plan-builder.js:749  calcSolunar()    real ecliptic longitude, GMST, local hour angle
 *   smart-plan.js:230    computeSolunar() moon mean longitude only, no hour-angle correction,
 *                                         and a hardcoded `- 5` baking in Eastern time
 *
 *   date         smart-plan major1   plan-builder major1
 *   2026-08-02   1:57 PM             2:56 AM        ~11 h apart
 *   2026-08-10   6:56 AM             10:08 AM       ~3 h
 *   2026-08-17   12:47 AM            3:51 PM        ~9 h
 *
 * Worse than the disagreement was which one reached the user. plan-builder wrote
 * `window._trollmapSolunar`, which notifications.js reads to fire bite-window alerts.
 * smart-plan wrote `window._smartPlanSolunar`, which NOTHING read. So the Smart Plan timeline
 * displayed one algorithm's numbers while the alerts fired on the other's, and Smart Plan's
 * own answer was computed and thrown away.
 *
 * This is plan-builder's model, moved intact. The consolidation deliberately does NOT improve
 * the maths: mixing "use one implementation" with "use a better implementation" makes it
 * impossible to tell which change moved a number. The one thing fixed is a genuine rounding
 * bug — see hourToStr.
 *
 * KNOWN LIMITATION, unchanged from the original and NOT silently fixed here:
 * local time is approximated as `lon / 15`, i.e. solar time, so it is standard time year
 * round and runs an hour early during daylight saving. For SC/NC/GA/TN (lon ~-80) that is
 * -5.33 h, close to EST. Fixing it means using the viewer's real DST-aware offset, which
 * shifts every displayed window by an hour in summer — a visible change that deserves its own
 * decision rather than riding along inside a refactor. `solunarFor()` takes an `offsetHours`
 * override so that change is one argument away when it is wanted.
 */

const DEG = Math.PI / 180;

/** Julian Date for noon UT on a YYYY-MM-DD string. */
function julianDay(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return NaN;
  return ms / 86400000 + 2440587.5;
}

/**
 * Decimal hours -> "H:MM AM/PM".
 *
 * The original rounded minutes independently of the hour, so 13.999 produced "1:60 PM".
 * Rounding to whole minutes first and letting the carry propagate is the fix; it is a
 * formatting bug, not a change to the model.
 */
export function hourToStr(h) {
  if (!Number.isFinite(h)) return '—';
  let mins = Math.round((((h % 24) + 24) % 24) * 60);
  mins %= 1440;
  const hh = Math.floor(mins / 60);
  const mm = mins % 60;
  return `${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
}

/** Moon phase name from the sun-moon ecliptic longitude difference, in degrees. */
function phaseNameFor(phaseDeg) {
  if (phaseDeg < 22.5 || phaseDeg >= 337.5) return 'New Moon';
  if (phaseDeg < 67.5) return 'Waxing Crescent';
  if (phaseDeg < 112.5) return 'First Quarter';
  if (phaseDeg < 157.5) return 'Waxing Gibbous';
  if (phaseDeg < 202.5) return 'Full Moon';
  if (phaseDeg < 247.5) return 'Waning Gibbous';
  if (phaseDeg < 292.5) return 'Last Quarter';
  return 'Waning Crescent';
}

/**
 * Major and minor feeding windows for a place and a date.
 *
 * @param {string} dateStr        YYYY-MM-DD
 * @param {number} lat            degrees north (accepted for signature stability; the transit
 *                                calculation is longitude-driven, latitude affects rise/set
 *                                times this model does not compute)
 * @param {number} lon            degrees east, negative in the US
 * @param {number} [offsetHours]  hours to add to UT for local time. Defaults to lon/15 —
 *                                see the DST note in the file header.
 * @returns {{major1,major2,minor1,minor2, major1Str,major2Str,minor1Str,minor2Str,
 *            phaseName, illum, rating, ratingClass}}
 */
export function solunarFor(dateStr, lat, lon, offsetHours) {
  const JD = julianDay(dateStr);
  if (!Number.isFinite(JD) || !Number.isFinite(lon)) {
    return { major1: NaN, major2: NaN, minor1: NaN, minor2: NaN,
             major1Str: '—', major2Str: '—', minor1Str: '—', minor2Str: '—',
             phaseName: '', illum: 0, rating: 'STRONG', ratingClass: 'rp-strong' };
  }
  const D = JD - 2451545.0;

  // Moon mean longitude, mean anomaly, argument of latitude.
  const L0 = (218.316 + 13.176396 * D) % 360;
  const M = (134.963 + 13.064993 * D) % 360;
  const F = (93.272 + 13.229350 * D) % 360;

  // Ecliptic longitude, three largest periodic terms.
  const lam = L0 + 6.289 * Math.sin(M * DEG)
                 - 1.274 * Math.sin(2 * F * DEG - M * DEG)
                 + 0.658 * Math.sin(2 * F * DEG);

  // Right ascension via the obliquity of the ecliptic.
  const lamR = lam * DEG;
  const eps = 23.439 * DEG;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lamR), Math.cos(lamR)) / DEG;

  // Meridian crossing: local hour angle of the moon at 0h, converted to a transit time.
  const GMST = (280.46061837 + 360.98564736629 * D) % 360;
  const LHA = (GMST + lon - ra + 360) % 360;
  const transitUT = (12 - LHA / 15 + 24) % 24;

  const off = Number.isFinite(offsetHours) ? offsetHours : lon / 15;
  const major1 = (transitUT + off + 24 * 2) % 24;   // +48 so a large negative offset stays positive
  const major2 = (major1 + 12) % 24;
  const minor1 = (major1 + 6) % 24;
  const minor2 = (major1 + 18) % 24;

  // Illumination from the sun-moon longitude difference.
  const sunL = (280.460 + 0.9856474 * D) % 360;
  const sunM = (357.528 + 0.9856003 * D) % 360;
  const sunLam = sunL + 1.915 * Math.sin(sunM * DEG) + 0.020 * Math.sin(2 * sunM * DEG);
  const phaseDeg = (lam - sunLam + 360 * 3) % 360;
  const illum = Math.round((1 - Math.cos(phaseDeg * DEG)) / 2 * 100);
  const phaseName = phaseNameFor(phaseDeg);

  const isNewFull = phaseName.includes('New') || phaseName.includes('Full');
  const isQuarter = phaseName.includes('Quarter');

  return {
    major1, major2, minor1, minor2,
    major1Str: hourToStr(major1), major2Str: hourToStr(major2),
    minor1Str: hourToStr(minor1), minor2Str: hourToStr(minor2),
    phaseName, illum,
    rating: isNewFull ? 'BEST' : isQuarter ? 'GOOD' : 'STRONG',
    ratingClass: isNewFull ? 'rp-best' : isQuarter ? 'rp-good-p' : 'rp-strong',
  };
}
