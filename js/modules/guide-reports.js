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
 * utils/report-water.js. A report Ryan read himself and pasted in joins them here, on every
 * planner, through askGuideReports() -- see pasted-reports.js.
 */

import { supersede, reportWaterForPlan, SANTEE_LAKES, placeNamesIn, namesOnlyOn } from '../utils/report-water.js';
import { loadPasted, pastedForWater, pastedAsReports } from './pasted-reports.js';

/**
 * The names on only one of the two Santee Cooper charts, for santeeLakesIn() in report-water.js.
 *
 * Read off the packs HERE and not in the Worker: the two lakes' place files are about 2 MB of JSON
 * and the Worker has 10 ms of CPU a request. Never throws; null when either pack could not be read,
 * and then a lake is known from its name and "upper"/"lower lake" only.
 */
export async function santeePlaces({ worker, fetchImpl } = {}) {
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!worker || !f) return null;
  const get = async (slug, file) => {
    try {
      const r = await f(`${String(worker).replace(/\/+$/, '')}/chartpacks/${slug}/${file}`);
      return r && r.ok ? await r.json() : null;
    } catch (_) { return null; }
  };
  const read = async (slug) => {
    const [pois, waterFeatures, launches] = await Promise.all([
      get(slug, 'pois.geojson'), get(slug, 'water_features.geojson'), get(slug, 'launches.json')]);
    return pois || launches ? placeNamesIn({ pois, waterFeatures, launches }) : null;
  };
  const [a, b] = await Promise.all(SANTEE_LAKES.map(read));
  return a && b ? namesOnlyOn(a, b) : null;
}

/** Marion or Moultrie: which lake a report's water is to be about, and the names that tell. */
const lakeOf = (guide) => (guide && SANTEE_LAKES.includes(guide.slug)
  ? { slug: guide.slug, places: guide.places || null } : null);
const lakeWord = (slug) => (slug === 'lake_marion' ? 'Marion' : slug === 'lake_moultrie' ? 'Moultrie' : slug);

/**
 * GET /guide-reports/<slug> for the plan's day. Never throws: a failure comes back as `{error}` and
 * the plan says the reports could not be read, rather than planning as though there were none.
 *
 * The reports Ryan pasted for this water are added to whatever the Worker answered -- and still
 * reach the plan when the Worker could not be read (`{error, reports}`). `pasted` is the list to
 * use; left out, this device's are read (none under node).
 */
export async function askGuideReports({ worker, slug, date, fetchImpl, timeoutMs = 60000, pasted } = {}) {
  if (!worker || !slug) return { error: 'no Worker or no water to ask about' };
  const pastedAsk = Array.isArray(pasted) ? Promise.resolve(pasted) : loadPasted();
  const mine = async (sourceReports) => pastedAsReports(pastedForWater(await pastedAsk, slug), date, sourceReports);
  // The water asked about rides on every answer: lakeOf() reads it to tell Marion's water from
  // Moultrie's, and a paste can reach the plan on an answer the Worker never gave.
  const withMine = async (out) => {
    const m = await mine([]);
    return m.length ? { slug, ...out, reports: supersede(m) } : { slug, ...out };
  };
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) return withMine({ error: 'no fetch' });
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  // On Marion and Moultrie the two charts' place names are read alongside, to tell which lake a
  // report's sentence is about.
  const placesAsk = SANTEE_LAKES.includes(slug) ? santeePlaces({ worker, fetchImpl: f }) : null;
  try {
    const q = date ? `?date=${encodeURIComponent(date)}` : '';
    const r = await f(`${String(worker).replace(/\/+$/, '')}/guide-reports/${encodeURIComponent(slug)}${q}`,
      ctl ? { signal: ctl.signal } : undefined);
    const places = placesAsk ? { places: await placesAsk } : {};
    if (!r || !r.ok) return withMine({ error: `the Worker answered HTTP ${r ? r.status : '?'}`, ...places });
    const body = await r.json();
    const theirs = body.reports || [];
    return { slug, ...body, reports: supersede([...theirs, ...await mine(theirs)]), ...places };
  } catch (e) {
    return withMine({ error: e && e.name === 'AbortError' ? `no answer in ${Math.round(timeoutMs / 1000)} s`
      : String((e && e.message) || e), ...(placesAsk ? { places: await placesAsk } : {}) });
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
  if (!guide || !(guide.reports || []).length) return [];
  const off = Number.isFinite(Number(offsetFt)) && offsetFt !== null ? Number(offsetFt) : null;
  return reportWaterForPlan(guide.reports, species, planDate, lakeOf(guide)).map((w) => ({
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
  if (r.preview) return `NOT DATED: a search preview of a post naming ${r.monthYear || r.monthNamed || 'no month'}; only this much of it could be read`;
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
  const cannot = guide.error ? `They could not be read today (${guide.error}). Say so in \`scoutNotes\`; do not write as though nobody reported.` : null;
  const any = (guide.reports || []).length > 0;
  if (cannot && !any) return `${head}${cannot}\n`;
  // Why there are none, in the Worker's words: no research profile, or nothing that reports on it.
  if (guide.none && !any) return `${head}No guide reports were looked for on this water: ${guide.none}.\n`;
  const live = (guide.reports || []).filter((r) => !r.supersededBy);
  const old = (guide.reports || []).filter((r) => r.supersededBy);
  const failed = (guide.checked || []).filter((c) => !c.ok);
  const L = [head.trimEnd()];
  if (cannot) L.push(`The guides' sources: ${cannot} What Ryan pasted himself is below.`);
  L.push(`Read ${String(guide.readAt || '').slice(0, 10) || 'today'} from the sources below, VERBATIM. These are people who were on this water. `
    + `Each says who wrote it and when, and one that states no date says so. Weigh each by its date against ${planDate || 'the day planned'}, `
    + `and say in \`scoutNotes\` which you used and how old each was. A report about the whole system (Santee Cooper is Marion and Moultrie) `
    + `says so in its text; take the part about this water.`);
  L.push('Where a report from this month or last names a DEPTH OF WATER for the species ("30-45 feet of water"), the candidate lanes over that '
    + 'water (their median depth is in it) carry it as `reportWater`, and where the ranking had offered none, the best lane over it was added and says `offeredForReport`. '
    + 'That is the depth of the WATER the guides found fish over, not the depth to run a bait at. '
    + 'A report marked "same month, an earlier year" is history: read it for the pattern this month usually brings; its water marks no lane.');
  if (live.some((r) => r.pasted)) {
    L.push('A report headed "Pasted by Ryan" is one he read himself -- a post, a text, a page -- and pasted in, with the date he gave it '
      + 'and, where he named them, who wrote it and which lake it is about. Weigh it as you would the guides\' own: by its date and by who wrote it.');
  }
  const lake = lakeOf(guide);
  if (lake) {
    L.push(`On Marion and Moultrie a depth of water counts for the lanes only from a sentence that says which lake it is about: by name, `
      + `"upper lake" (Marion) or "lower lake" (Moultrie), or a place on only one of the two charts, and the rest of its paragraph goes with it. `
      + `A depth that says neither is printed below and is on no lane: read it knowing it may be ${lake.slug === 'lake_marion' ? "Moultrie's" : "Marion's"} water.`
      + (lake.places ? '' : " (The two charts' place names could not be read today, so only the lakes' names and upper/lower lake were used.)"));
  }
  for (const r of live) {
    L.push('');
    L.push(`--- ${r.label}${r.guides ? ` (${r.guides})` : ''} -- ${whenOf(r)}${r.via ? `, ${r.via}` : ''}${r.role && r.role !== 'newest' ? ` -- ${r.role}` : ''}`
      + `${r.aboutLake ? ` -- about ${r.aboutLake === 'lake_marion' ? 'Lake Marion' : 'Lake Moultrie'}, he said` : ''}`
      + `${r.outdatedBy ? ` -- older than "${r.outdatedBy}" by the same guides, so printed whole but its depths of water are not counted` : ''}`);
    if (r.url) L.push(r.url);
    if (r.note) L.push(r.note);
    L.push(String(r.text || '').trim());
  }
  for (const r of old) L.push(`\n(An older report by the same guides, ${r.label}, ${whenOf(r)}, is not repeated: ${r.supersededBy} is newer.)`);
  if (failed.length) {
    L.push('\nCould not be read today:');
    for (const c of failed) L.push(`- ${c.label}: ${c.why}`);
  }
  const water = reportWaterForPlan(guide.reports, species, planDate, lake);
  if (water.length) {
    L.push('\nThe depths of water those reports name for the species, as read off their own sentences:');
    for (const w of water) {
      L.push(`- ${w.species}: ${fmtFt(w.ft)} of water${w.lake ? ` on ${lakeWord(w.lake)} (said in ${w.lakeFrom})` : ''} -- ${w.label}: "${w.quote}"`);
    }
  }
  return `${L.join('\n')}\n`;
}
