/**
 * guide-reports.js -- the guides' monthly reports, asked of the Worker and handed to the plan.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 2026-10-01, item 42: reports from the top guides on his five lakes, and "I think the plan
 * could benefit from these reports, don't you?". Then, on a Marion striper plan whose twelve lanes
 * were all shallow: "depth itself shouldn't be weighted i dont think... but guide reports that put
 * fish in certain depth of water should count towards something".
 *
 * So three things happen with them, and no weight is added to anything:
 *   1. the plan reads every report, verbatim, dated, in its own block (guideReportsBlock);
 *   2. the water a current report names for the species is carried to the lane selector
 *      (reportWaterForLanes), which marks the lanes over it and offers the best one over it when
 *      the ranking left none -- see selectCandidates() in plan-candidates.js;
 *   3. the trip report shows what the plan read.
 * Gathering is the Worker's (Worker/guide-reports.js); reading the water out of a report is
 * utils/report-water.js.
 */

import { supersede, reportWaterForPlan } from '../utils/report-water.js';

/**
 * GET /guide-reports/<slug> for the plan's day. Never throws: a failure comes back as `{error}` and
 * the plan says the reports could not be read, rather than planning as though there were none.
 */
export async function askGuideReports({ worker, slug, date, fetchImpl, timeoutMs = 60000 } = {}) {
  if (!worker || !slug) return { error: 'no Worker or no water to ask about' };
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) return { error: 'no fetch' };
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const q = date ? `?date=${encodeURIComponent(date)}` : '';
    const r = await f(`${String(worker).replace(/\/+$/, '')}/guide-reports/${encodeURIComponent(slug)}${q}`,
      ctl ? { signal: ctl.signal } : undefined);
    if (!r || !r.ok) return { error: `the Worker answered HTTP ${r ? r.status : '?'}` };
    const body = await r.json();
    return { ...body, reports: supersede(body.reports || []) };
  } catch (e) {
    return { error: e && e.name === 'AbortError' ? `no answer in ${Math.round(timeoutMs / 1000)} s`
      : String((e && e.message) || e) };
  } finally {
    if (t) clearTimeout(t);
  }
}

/**
 * The water this month's reports name for the species, in the chart's terms for the lane selector.
 *
 * A report's "30-45 feet of water" is today's water. The lanes carry Garmin's chart depths, and the
 * chart is only corrected to today where its level has been measured (chart-levels.js). So
 * `offsetFt` is poolOffsetFt(): today = chart - offsetFt, and the chart range is the report's plus
 * it. Where it is null the comparison is against the chart as it stands, and each row says so.
 */
export function reportWaterForLanes(guide, species, planDate, offsetFt = null) {
  if (!guide || guide.error) return [];
  const off = Number.isFinite(Number(offsetFt)) && offsetFt !== null ? Number(offsetFt) : null;
  return reportWaterForPlan(guide.reports, species, planDate).map((w) => ({
    ...w,
    chartFt: off == null ? w.ft
      : [w.ft[0] + off, w.ft[1] == null ? null : w.ft[1] + off].map((v) => (v == null ? v : Math.round(v * 10) / 10)),
    chartBasis: off == null
      ? "compared with the chart as it stands -- this water's chart level has not been measured"
      : `the chart is ${off} ft deeper than today's water here, so ${off} ft was added`,
  }));
}

const fmtFt = (ft) => (ft[1] == null ? `${ft[0]}+ ft` : ft[0] === ft[1] ? `${ft[0]} ft` : `${ft[0]}-${ft[1]} ft`);

function whenOf(r) {
  if (r.published) return `${r.published}${r.publishedFrom ? ` (${r.publishedFrom})` : ''}`;
  const named = (r.monthsNamed && r.monthsNamed.length) ? r.monthsNamed.join(' and ') : r.monthNamed;
  return `NO DATE STATED${named ? `; the text speaks of ${named}` : ''}`;
}

/**
 * The prompt block. Empty string when the caller had nothing to say (an old caller); a sentence
 * when the water has no sources or the Worker could not be reached, because "no reports" and
 * "could not read the reports" are different things for the plan to say.
 */
export function guideReportsBlock(guide, species, planDate) {
  if (guide == null) return '';
  const head = '\nWHAT THE GUIDES ON THIS WATER REPORTED\n';
  if (guide.error) return `${head}They could not be read today (${guide.error}). Say so in \`scoutNotes\`; do not write as though nobody reported.\n`;
  if (guide.none) return `${head}No guide sources are listed for this water.\n`;
  const live = (guide.reports || []).filter((r) => !r.supersededBy);
  const old = (guide.reports || []).filter((r) => r.supersededBy);
  const failed = (guide.checked || []).filter((c) => !c.ok);
  const L = [head.trimEnd()];
  L.push(`Read ${String(guide.readAt || '').slice(0, 10) || 'today'} from the sources below, VERBATIM. These are people who were on this water. `
    + `Each says who wrote it and when, and one that states no date says so. Weigh each by its date against ${planDate || 'the day planned'}, `
    + `and say in \`scoutNotes\` which you used and how old each was. A report about the whole system (Santee Cooper is Marion and Moultrie) `
    + `says so in its text; take the part about this water.`);
  L.push('Where a report from this month or last names a DEPTH OF WATER for the species ("30-45 feet of water"), the candidate lanes over that '
    + 'water (their median depth is in it) carry it as `reportWater`, and where the ranking had offered none, the best lane over it was added and says `offeredForReport`. '
    + 'That is the depth of the WATER the guides found fish over, not the depth to run a bait at.');
  for (const r of live) {
    L.push('');
    L.push(`--- ${r.label}${r.guides ? ` (${r.guides})` : ''} -- ${whenOf(r)}${r.via ? `, ${r.via}` : ''}${r.role && r.role !== 'newest' ? ` -- ${r.role}` : ''}`);
    if (r.url) L.push(r.url);
    if (r.note) L.push(r.note);
    L.push(String(r.text || '').trim());
  }
  for (const r of old) L.push(`\n(An older report by the same guides, ${r.label}, ${whenOf(r)}, is not repeated: ${r.supersededBy} is newer.)`);
  if (failed.length) {
    L.push('\nCould not be read today:');
    for (const c of failed) L.push(`- ${c.label}: ${c.why}`);
  }
  const water = reportWaterForPlan(guide.reports, species, planDate);
  if (water.length) {
    L.push('\nThe depths of water those reports name for the species, as read off their own sentences:');
    for (const w of water) L.push(`- ${w.species}: ${fmtFt(w.ft)} of water -- ${w.label}: "${w.quote}"`);
  }
  return `${L.join('\n')}\n`;
}
