/**
 * guide-reports.js -- what the guides on his five lakes said this month, verbatim and dated.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 2026-10-01: "Did my idea of pulling guide reports from the top guides for the 5 main lakes
 * around me get built?" It had not (APP_CHANGE_REQUESTS item 42). Then: "I think the plan could
 * benefit from these reports, don't you?", and on the Marion striper plan whose lanes were all
 * shallow: "depth itself shouldn't be weighted i dont think... but guide reports that put fish in
 * certain depth of water should count towards something". So unlike reports.js (the trip report
 * only, his 8/15 call), what this route returns goes to the plan.
 *
 * WHERE EACH ONE PUBLISHES, measured 2026-10-01:
 *
 *   SCDNR Freshwater Fishing Trends   dnr.sc.gov/news/freshwater.html. Angler's Headquarters' monthly
 *                                     summary, posted free; one section per lake, guides by name.
 *                                     THE PAGE STATES NO DATE: the text names the month ("in
 *                                     September"), and that is all it has.
 *   Angler's Headquarters (weekly)    anglersheadquarters.com/blogs/ahq-report, one weekly post per
 *                                     lake, guides by name, every entry dated. THE NEWEST FOUR OR
 *                                     FIVE WEEKS ARE FOR MEMBERS ("We reserve only the newest
 *                                     reports for members"); everything older is free. So what is
 *                                     read is the plan's month in each of the last three years.
 *                                     Corrected 2026-10-01: this said AHQ's pages were paid teasers.
 *   Santee Cooper Country (site)      santeecoopercountry.org/fishing/fishing-reports/, Capt. Joe
 *                                     Dennis and Kyle Austin. Dated by the page's own modified time.
 *   Santee Cooper Country (Facebook)  the same report, usually days before the site.
 *   Wolfe's Guide Service (Facebook)  Capt. Jason Wolfe, a monthly Wateree post. No site reports.
 *   Lake Murray monthly (YouTube)     Capt. Chip Bragg (stripers) and Capt. Chris Blanchette
 *                                     (largemouth), on Blanchette's channel. The channel's feed lists
 *                                     the videos; Firecrawl reads the transcript (1 credit a video,
 *                                     kept forever in KV, because a transcript never changes).
 *
 * FACEBOOK IS READ WITHOUT AN ACCOUNT. A page's feed asks for a login; a single post does not.
 * TinyFish search finds the posts by URL, TinyFish fetch reads them, and both are free. No
 * Facebook login is used, and none should be: that is Ryan's account. A new post takes about a
 * day to reach search by its own URL, and a share of it (the October report was shared by New
 * Country 105.3 The Cat within hours) is read the same way and says whose share it is.
 *
 * NOTHING IS SUMMARISED. Every `text` is what the source wrote. Every date says where it came from
 * (`publishedFrom`), and a source that states none says so (`published: null`).
 */

import { CORS, JSON_HEADERS, isAuthorized } from './worker-core.js';
import { decodeEntities } from '../js/utils/html-text.js';
import { dayEastern } from './places.js';
import { tinyfishSearch, tinyfishFetch, checkFirecrawlBudget, recordFirecrawlUsage }
  from './research/clients.js';
import { lakeIndex, identityNamesForRow } from './registry.js';
import { resolveResearchStorageId } from './research/keys.js';

const UA = 'TrollMap/1.0 (personal fishing app)';

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

// ── who publishes for which water ───────────────────────────────────────────────────────────

const SCDNR = {
  kind: 'scdnr', label: 'SCDNR Freshwater Fishing Trends',
  url: 'https://www.dnr.sc.gov/news/freshwater.html',
  note: "Angler's Headquarters' monthly summary, posted free by SCDNR. The page states no date.",
};
const SCC_GUIDES = 'Capt. Joe Dennis and Capt. Kyle Austin';
const SCC_SITE = {
  kind: 'page', label: 'Santee Cooper Country fishing report', guides: SCC_GUIDES,
  url: 'https://www.santeecoopercountry.org/fishing/fishing-reports/',
};
const SCC_FB = {
  kind: 'facebook', label: 'Santee Cooper Country on Facebook', guides: SCC_GUIDES,
  author: 'Santee Cooper Country',
  url: 'https://www.facebook.com/santeecoopercountrysouthcarolina',
  // The second form is their own heading in quotes. Measured 2026-10-01: only it brought back the
  // preview that names the month ("OCTOBER 2026 FISHING REPORT ..."); the first returned the page
  // with "2026 FISHING REPORT ..." and no month in it.
  queries: (m) => [`Santee Cooper Country ${m} fishing report`, `"${m} fishing report" Santee Cooper`],
};
const WOLFE_FB = {
  kind: 'facebook', label: "Wolfe's Guide Service on Facebook", guides: 'Capt. Jason Wolfe',
  author: "Wolfe's Guide Service LLC",
  url: 'https://www.facebook.com/p/Wolfes-Guide-Service-LLC-100068648221854/',
  queries: (m) => [`Wolfe's Guide Service Lake Wateree ${m} fishing report`],
};
const MURRAY_YT = {
  kind: 'youtube', label: 'Lake Murray monthly fishing report (YouTube)',
  guides: 'Capt. Chip Bragg (stripers) and Capt. Chris Blanchette (largemouth)',
  channelId: 'UC24B2lkw-BgqjADvrMLJZMg', titleRe: /\blake murray\b/i,
  url: 'https://www.youtube.com/@BigFishBlanch',
};

// ── ANGLER'S HEADQUARTERS, THE PLAN'S MONTH IN EACH OF THE LAST THREE YEARS ─────────────────
//
// Ryan, 2026-10-01, pasting their October 19, 2023 Santee Cooper report (Capt. Bobby Winters):
// "we need notes like this", and "the difference being that this one calls out upper and lower
// lake... the new October one we found does not". Their newest weeks are for members, so the
// current one cannot be read; the same month in earlier years can. Asked how many years: "i
// actually like the idea of the last 3 years... this way the history is there". Asked whether
// last year's depths should mark lanes: "Reading only". So these carry `role` and are never this
// month's report (utils/report-water.js isCurrentReport). No sign-in is ever used: that would be
// his account.
const AHQ_BASE = 'https://www.anglersheadquarters.com';
const AHQ_YEARS = 3;
export const ahqOn = (tag, title) => ({
  kind: 'ahq', label: "Angler's Headquarters weekly report",
  guides: "Angler's Headquarters (each guide is named in the text)",
  tag, title, url: `${AHQ_BASE}/blogs/ahq-report/tagged/${tag}`,
});

/**
 * THE INDIVIDUAL GUIDES, keyed by the registry slug of the water each one fishes. FOREIGN KEYS,
 * not a gate: a guide's Facebook page or YouTube channel is a person, and no registry field says
 * where a person fishes. Declared in test/hand-written-tables.test.js.
 *
 * SCDNR's page and Angler's Headquarters used to be listed here too, for his five lakes only.
 * Ryan, 2026-10-02: "remember my rule no lake gets something that isn't available to all", then
 * "build the general version of both the gauges and the guides... the individual guide reports
 * can probably stay but we can do general searches for the other major lakes... i would keep it
 * to the ones that have research profiles". Both now come from generalSources() below, matched
 * by name, for every water with a research profile; Monticello had only those two and is no
 * longer listed here.
 */
export const GUIDE_SOURCES = {
  wateree_lake: [WOLFE_FB],
  lake_murray: [MURRAY_YT],
  lake_marion: [SCC_SITE, SCC_FB],
  lake_moultrie: [SCC_SITE, SCC_FB],
};

// ── WHO REPORTS ON WHICH WATER, BY NAME, FOR EVERY WATER WITH A RESEARCH PROFILE ─────────────
//
// SCDNR's page has one section per lake ("Lake Russell", "Clarks Hill (Lake Thurmond)", "Santee
// Cooper"), and Angler's Headquarters links one report page per lake from its blog
// ("/pages/santee-cooper-lake-marion-lake-moultrie-fishing-report"). Both are matched to a water by
// the words in its own registry names -- its name and every name it has been known by -- with the
// words every lake shares taken out. AHQ's page names are also what says "Santee Cooper" is Lake
// Marion and Lake Moultrie, so they carry SCDNR's "Santee Cooper" section to those two lakes.
// Both are South Carolina sources about lakes and the coast, so a water is matched only when one
// of its states is SC and it is not a river.

/** Words that name no particular water. Grammar and the kinds of water, not lakes. */
const COMMON_WORDS = new Set(['lake', 'lakes', 'reservoir', 'res', 'pond', 'river', 'creek', 'the',
  'of', 'and', 'at', 'on', 'in', 'fishing', 'report', 'reports', 'updates', 'update', 'most',
  'detailed', 'system', 'area', 'north', 'south', 'east', 'west', 'upper', 'lower', 'sc', 'ga',
  'nc', 'tn', 'va', 'co', 'county', 'island', 'inlet', 'harbor', 'bay', 'sound']);

/** The words that name this water and no other kind of thing, from any of its names. */
export function nameTokens(names) {
  const out = new Set();
  for (const raw of names || []) {
    let n = String(raw || '').replace(/\([^)]*\)/g, ' ');
    if (n.includes(' - ')) n = n.split(' - ').pop();             // "Camp Creek - Lake Hartwell"
    n = n.replace(/,\s*[A-Z]{2}(\/[A-Z]{2})*\s*$/, '');          // ", SC" / ", GA/SC"
    // A trailing s is dropped from every word on both sides, so "Clarks Hill" and "Clark Hill" --
    // both in Thurmond's own names -- are one name, and so are AHQ's page and SCDNR's heading.
    for (const w of n.toLowerCase().split(/[^a-z]+/)) {
      if (w.length > 1 && !COMMON_WORDS.has(w)) out.add(w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
    }
  }
  return out;
}

/** Every name the registry row knows this water by. */
export function rowNames(row) {
  return [row && row.name, row && row.display_name, ...((row && row.legacy_display_names) || [])].filter(Boolean);
}

/** The states the water is in: "(Lincoln Co, GA/SC)" says two. */
export function rowStates(row) {
  const out = new Set([String((row && row.state) || '').toUpperCase()].filter(Boolean));
  const m = String((row && row.display_name) || '').match(/,\s*([A-Z]{2}(?:\/[A-Z]{2})*)\)\s*$/);
  if (m) m[1].split('/').forEach((x) => out.add(x));
  return [...out];
}

/** Angler's Headquarters' lake and coast pages, each with the tag and title its weekly posts use. */
export function parseAhqIndex(md, links) {
  const titles = new Map();
  for (const m of String(md || '').matchAll(/^\*\s+(.+?)\s*$/gm)) {
    const t = m[1].trim();
    titles.set(t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), t);
  }
  const tags = [...new Set((links || []).map((u) => (String(u).match(/\/blogs\/ahq-report\/tagged\/([a-z0-9-]+)/) || [])[1])
    .filter(Boolean))];
  const out = [];
  for (const u of new Set(links || [])) {
    const m = String(u).match(/\/pages\/([a-z0-9-]+)-fishing-report\/?$/);
    if (!m) continue;
    const page = m[1];
    const tag = tags.filter((t) => page === t || page.startsWith(`${t}-`)).sort((a, b) => b.length - a.length)[0];
    if (!tag) continue;
    const title = titles.get(tag) || tag.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
    out.push({ page, tag, title, tokens: [...nameTokens([page.replace(/-/g, ' ')])],
               lake: page.split('-').includes('lake') });
  }
  return out;
}

/**
 * AHQ pages that name this water, and the words they add to its names (the bridge for SCDNR).
 *
 * A page names the water when every naming word of the page is in ONE of the water's names
 * ("lake-russell" in "Lake Richard B. Russell"), or every naming word of the water's own name is
 * on the page ("Lake Marion" on "santee-cooper-lake-marion-lake-moultrie"). One name at a time,
 * and the second only for the water's own name, because a coastal water's names include every
 * creek in it: "North Santee River" is one of the Santee Delta's, and the Santee Delta is not what
 * AHQ's Santee Cooper page is about. A page with "lake" in its name is matched to lakes only, and
 * one without it to the rest.
 */
export function matchAhq(index, w) {
  const sets = (w.names || []).map((n) => nameTokens([n])).filter((x) => x.size);
  const own = (w.primary || []).map((n) => nameTokens([n])).filter((x) => x.size);
  const isLake = w.featureType === 'lake';
  const hit = (index || []).filter((e) => e.lake === isLake && e.tokens.length
    && (sets.some((x) => e.tokens.every((t) => x.has(t)))
      || own.some((x) => [...x].every((t) => e.tokens.includes(t)))));
  const bridge = new Set(w.tokens || []);
  for (const e of hit) e.tokens.forEach((t) => bridge.add(t));
  return { hit, bridge };
}

/** SCDNR section titles whose every naming word is one of this water's (bridge included). */
export function matchScdnr(titles, bridge) {
  return (titles || []).filter((t) => {
    const w = [...nameTokens([t])];
    return w.length > 0 && w.every((x) => bridge.has(x));
  });
}

/** `### ` headings on SCDNR's page. */
export function scdnrTitles(md) {
  return [...String(md || '').matchAll(/^###\s+(.+?)\s*$/gm)].map((m) => m[1].trim());
}

/**
 * THE GENERAL SEARCH'S HITS THAT ARE FISHING REPORTS ON THIS WATER FROM THE PLAN'S MONTH OR THE
 * ONE BEFORE. Measured 2026-10-02 on "Lake Greenwood" fishing report October 2026: of ten hits,
 * the one that was a report was the one whose TITLE names the lake and says fishing report ("Lake
 * Greenwood Fishing Report Sep 6th, 2026"); the others were how-to pages, other lakes' posts that
 * mention it, a tackle shop's index and Instagram. So: title names the water and says fishing
 * report, and the date is in the window. Pages already read by name are left to their readers.
 */
export function pickSearchHits(results, tokens, dateStr, nowMs = Date.now(), skipHosts = []) {
  const y = Number(dateStr.slice(0, 4));
  const mi = Number(dateStr.slice(5, 7)) - 1;
  const from = Date.UTC(mi === 0 ? y - 1 : y, mi === 0 ? 11 : mi - 1, 1);
  const to = Date.UTC(mi === 11 ? y + 1 : y, mi === 11 ? 0 : mi + 1, 1);
  const when = (d) => {
    const s = String(d || '').trim();
    const rel = s.match(/^(\d+)\s+(minute|hour|day|week)s?\s+ago$/i);
    if (rel) {
      const ms = { minute: 60e3, hour: 3600e3, day: 864e5, week: 7 * 864e5 }[rel[2].toLowerCase()];
      return nowMs - Number(rel[1]) * ms;
    }
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  };
  return (results || []).filter((r) => {
    const host = String(r.url || '').replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
    if (skipHosts.some((h) => host === h || host.endsWith(`.${h}`))) return false;
    const title = String(r.title || '');
    if (!/fishing report/i.test(title)) return false;
    if (![...nameTokens([title])].some((t) => tokens.has(t))) return false;
    const t = when(r.date);
    return t != null && t >= from && t < to;
  }).map((r) => ({ ...r, when: new Date(when(r.date)).toISOString().slice(0, 10) }));
}

const AHQ_BLOG = `${AHQ_BASE}/blogs/ahq-report`;
const SEARCHED_ELSEWHERE = ['dnr.sc.gov', 'anglersheadquarters.com', 'facebook.com', 'instagram.com',
  'youtube.com', 'tiktok.com'];

/**
 * Every source this water gets by name: SCDNR's section, AHQ's weekly reports, and a search for
 * this month's fishing reports -- for a water with a research profile, and only then (his words).
 * `why` says what was not looked for and why.
 */
export async function generalSources(slug, env) {
  const why = [];
  let idx;
  try { idx = await lakeIndex(env); } catch (e) { return { sources: [], why: [`the registry could not be read: ${e.message}`] }; }
  const row = idx && idx[slug];
  if (!row) return { sources: [], why: [`${slug} is not in the registry`] };
  const bucket = env && env.R2_TROLLMAP_CHARTPACKS;
  const found = bucket ? await resolveResearchStorageId(row.name || slug,
    (id) => bucket.head(`lakes/${id}.json`).catch(() => null), identityNamesForRow(idx, row, slug)) : null;
  if (!found) {
    return { sources: [], why: [`${row.name || slug} has no research profile, so no reports are searched for it`] };
  }
  const tokens = nameTokens(rowNames(row));
  const w = { names: rowNames(row), primary: [row.name, row.display_name].filter(Boolean),
              featureType: row.feature_type, tokens: [...tokens] };
  const sources = [];
  const sc = rowStates(row).includes('SC');
  if (sc && row.feature_type !== 'river') {
    sources.push({ kind: 'ahq-any', label: "Angler's Headquarters weekly report", url: AHQ_BLOG, w });
  }
  // SCDNR's page is its FRESHWATER fishing trends: lakes.
  if (sc && row.feature_type === 'lake') sources.push({ ...SCDNR, kind: 'scdnr-any', w });
  if (!sc) why.push('SCDNR and Angler\'s Headquarters report on South Carolina water only');
  sources.push({ kind: 'search', label: 'Found by a web search for this month\'s fishing reports',
    name: String(row.name || slug).replace(/,\s*[A-Z]{2}(\/[A-Z]{2})*$/, ''), tokens, url: null });
  return { sources, why, profile: found.id };
}

// The AHQ index is read once per Worker run, not once per water: every water asks the same page.
// Only a page that parsed to something is kept.
let _ahqIndex = null;
export function _resetAhqIndex() { _ahqIndex = null; }
async function ahqIndex(env) {
  if (_ahqIndex) return _ahqIndex;
  const hit = await tfPage(env, AHQ_BLOG, { links: true });
  const index = parseAhqIndex(hit.text, hit.links || []);
  if (!index.length) throw new Error("Angler's Headquarters' blog listed no report pages");
  _ahqIndex = index;
  return index;
}

async function readAhqAny(src, env, dateStr) {
  const { hit } = matchAhq(await ahqIndex(env), src.w);
  if (!hit.length) throw new Error("no Angler's Headquarters report page names this water");
  const out = [];
  const seen = new Set();
  const failed = [];
  for (const e of hit) {
    if (seen.has(e.tag)) continue;
    seen.add(e.tag);
    try { out.push(...await readAhq(ahqOn(e.tag, e.title), env, dateStr)); } catch (err) { failed.push(`${e.title}: ${err.message}`); }
  }
  if (!out.length) throw new Error(failed.join('; ') || 'nothing found');
  if (failed.length) out.partial = `not found: ${failed.join('; ')}`;
  return out;
}

async function readScdnrAny(src, env) {
  const { bridge } = matchAhq(await ahqIndex(env).catch(() => []), src.w);
  const hit = await tfPage(env, src.url);
  const titles = matchScdnr(scdnrTitles(hit.text), bridge);
  if (!titles.length) throw new Error('no section on the page names this water');
  return titles.map((section) => {
    const sec = parseScdnrSection(hit.text, section);
    return sec ? {
      kind: 'scdnr', label: `${src.label} -- ${section}`, guides: null, url: src.url,
      published: null, publishedFrom: null, undated: true, monthNamed: null,
      monthsNamed: sec.monthsNamed, note: src.note, text: sec.text,
    } : null;
  }).filter(Boolean);
}

async function readSearch(src, env, dateStr) {
  const y = Number(dateStr.slice(0, 4));
  const mi = Number(dateStr.slice(5, 7)) - 1;
  const after = `${mi === 0 ? y - 1 : y}-${String(mi === 0 ? 12 : mi).padStart(2, '0')}-01`;
  const query = `"${src.name}" fishing report ${MONTHS[mi]} ${y}`;
  const r = await tinyfishSearch({ query, after_date: after,
    purpose: `Find this month's fishing reports for ${src.name}` }, env);
  const picks = pickSearchHits((r && r.results) || [], src.tokens, dateStr, Date.now(), SEARCHED_ELSEWHERE)
    .slice(0, 10);                                     // TinyFish fetch takes ten URLs a call
  if (!picks.length) throw new Error(`no fishing report on ${src.name} dated this month or last in the search for ${query}`);
  const f = await tinyfishFetch({ urls: picks.map((p) => p.url), format: 'markdown' }, env);
  const byUrl = new Map(((f && f.results) || []).map((h) => [h.url, h]));
  const out = picks.map((p) => {
    const h = byUrl.get(p.url);
    const text = h && String(h.text || '').trim();
    if (!text) return null;
    return {
      kind: 'search', label: `${p.title}`, guides: null, url: p.url,
      published: p.when, publishedFrom: 'the date the search gave for the page',
      via: `found by a web search for ${query}`,
      monthNamed: MONTHS[Number(p.when.slice(5, 7)) - 1], monthsNamed: monthsNamed(text), text,
    };
  }).filter(Boolean);
  if (!out.length) throw new Error(`${picks.length} report page(s) found and none could be read`);
  return out;
}


// ── parsers (pure, tested) ──────────────────────────────────────────────────────────────────

// "May" and "March" are also a verb, so they count only capitalised ("Fish may also move
// shallower" put May on SCDNR's September Murray section, 2026-10-01). The rest are unambiguous in
// any case, which keeps Wolfe's "sept".
const MONTH_RE = /\b(January|February|April|June|July|August|September|Sept|October|November|December)\b/gi;
const MONTH_VERB_RE = /\b(May|March|MAY|MARCH)\b/g;

/** Month names a text uses, full form, in the order they first appear. */
export function monthsNamed(text) {
  const out = [];
  const t = String(text || '');
  const hits = [...t.matchAll(MONTH_RE), ...t.matchAll(MONTH_VERB_RE)].sort((a, b) => a.index - b.index);
  for (const m of hits) {
    const w = m[1].toLowerCase() === 'sept' ? 'September'
      : m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

/**
 * The month a report names WITH its year -- "OCTOBER 2026 FISHING REPORT", "April 2026 Fishing
 * report" -- as YYYY-MM, or null. A post's own date is better; this is for text that has no other.
 */
export function monthYearNamed(text) {
  const m = String(text || '').match(new RegExp(`\\b(${MONTHS.join('|')})\\s+(20\\d\\d)\\b`, 'i'));
  if (!m) return null;
  const mi = MONTHS.findIndex((x) => x.toLowerCase() === m[1].toLowerCase());
  return `${m[2]}-${String(mi + 1).padStart(2, '0')}`;
}

/** One lake's section of the SCDNR page, as TinyFish returns it in markdown. */
export function parseScdnrSection(md, section) {
  const lines = String(md || '').split('\n');
  const want = String(section).trim().toLowerCase();
  const at = lines.findIndex((l) => /^###\s+/.test(l) && l.replace(/^###\s+/, '').trim().toLowerCase() === want);
  if (at < 0) return null;
  const body = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (/^#{1,3}\s+/.test(lines[i])) break;
    if (/^\s*most detailed .* updates\s*$/i.test(lines[i])) continue;
    body.push(lines[i]);
  }
  const text = body.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return text ? { text, monthsNamed: monthsNamed(text) } : null;
}

/** Santee Cooper Country's report page: the report, without the archive links under it. */
export function parseSccSite(md, meta) {
  const s = String(md || '');
  const start = s.search(/^#\s+/m);
  let text = start >= 0 ? s.slice(start) : s;
  const cut = text.search(new RegExp(`^#{4}\\s+(${MONTHS.join('|')})\\s*$`, 'm'));
  if (cut > 0) text = text.slice(0, cut);
  text = text.trim();
  if (!text) return null;
  const modified = meta && meta.article && (meta.article.modified_time || meta.article.published_time);
  const published = /^\d{4}-\d{2}-\d{2}/.test(String(modified || '')) ? String(modified).slice(0, 10) : null;
  return {
    text, published, publishedFrom: published ? 'the page\'s own last-modified time' : null,
    monthNamed: monthsNamed(text.slice(0, 200))[0] || null,
  };
}

const MON3 = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/**
 * The date Facebook shows on a post, as a calendar day in Eastern time.
 *
 * Facebook prints "5h", "Yesterday at 4:13 PM", "September 1 at 5:04 PM", or, for an older year,
 * "December 5, 2025". A day with no year is the most recent such day that is not in the future.
 * "4y" is a year, not a day, and comes back without one. `nowMs` is when the post was read.
 */
export function facebookDate(line, nowMs = Date.now()) {
  const t = String(line || '').trim();
  const day = (ms) => dayEastern(new Date(ms));
  const rel = t.match(/^(\d+)\s*(m|min|mins|h|hr|hrs|d|w)$/i);
  if (rel) {
    const n = Number(rel[1]);
    const u = rel[2].toLowerCase();
    const ms = u.startsWith('m') ? n * 60e3 : u.startsWith('h') ? n * 3600e3
      : u === 'd' ? n * 86400e3 : n * 7 * 86400e3;
    return { date: day(nowMs - ms), how: `Facebook shows "${t}"` };
  }
  if (/^(just now|today)\b/i.test(t)) return { date: day(nowMs), how: `Facebook shows "${t}"` };
  if (/^yesterday\b/i.test(t)) return { date: day(nowMs - 86400e3), how: `Facebook shows "${t}"` };
  const md = t.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,\s*(\d{4}))?(?:\s+at\s+.*)?$/);
  if (md) {
    const mi = MON3[md[1].slice(0, 3).toLowerCase()];
    if (mi === undefined) return null;
    const today = day(nowMs);
    let year = md[3] ? Number(md[3]) : Number(today.slice(0, 4));
    const fmt = (y) => `${y}-${String(mi + 1).padStart(2, '0')}-${String(Number(md[2])).padStart(2, '0')}`;
    if (!md[3] && fmt(year) > today) year -= 1;
    return { date: fmt(year), how: `Facebook shows "${t}"${md[3] ? '' : ', and the year is the latest that is not in the future'}` };
  }
  return null;
}

const STOP_LINE = /^(All reactions:|Seen by |\d+\s+comments?$|Like$|Comment$|Share$|Most relevant$)/;

/**
 * One Facebook post as TinyFish returns it. Null unless `author` wrote it -- as the poster, or as
 * the post someone else shared. A share says whose share it is in `via`.
 */
export function parseFacebookPost(md, author, nowMs = Date.now()) {
  const lines = String(md || '').split('\n');
  const norm = (s) => String(s).replace(/[’`]/g, "'").trim().toLowerCase();
  const name = (l) => { const m = l.match(/^#{3,4}\s+\*\*(.+?)\*\*\s*$/); return m ? m[1] : null; };
  const first = lines.map(name).find(Boolean) || null;
  const at = lines.findIndex((l) => { const n = name(l); return n && norm(n) === norm(author); });
  if (at < 0) return null;
  let i = at + 1;
  while (i < lines.length && !lines[i].trim()) i++;
  const dateLine = (lines[i] || '').trim();
  const when = facebookDate(dateLine, nowMs);
  const body = [];
  for (let j = i + 1; j < lines.length; j++) {
    if (STOP_LINE.test(lines[j].trim())) break;
    body.push(lines[j]);
  }
  const text = body.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return null;
  return {
    text,
    published: when ? when.date : null,
    publishedFrom: when ? `${when.how}, read ${dayEastern(new Date(nowMs))}` : null,
    via: first && norm(first) !== norm(author) ? `shared by ${first}` : null,
    monthNamed: monthsNamed(text.slice(0, 300))[0] || null,
  };
}

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" };
const unent = (s) => String(s || '').replace(/&(amp|lt|gt|quot|#39|apos);/g, (m) => ENT[m]);

/** A YouTube channel feed: every video's id, title and upload instant. */
export function parseYoutubeFeed(xml) {
  const out = [];
  for (const m of String(xml || '').matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const id = (e.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1];
    const title = (e.match(/<title>([^<]*)<\/title>/) || [])[1];
    const published = (e.match(/<published>([^<]+)<\/published>/) || [])[1];
    if (id && title) out.push({ videoId: id, title: unent(title), published: published || null });
  }
  return out;
}

/**
 * The newest report video for the water, and -- when it is not already that -- the newest one named
 * for the plan's month in an earlier year, which is the same season's pattern.
 */
export function pickYoutube(entries, titleRe, month) {
  const reports = (entries || []).filter((e) => titleRe.test(e.title) && /\breport\b/i.test(e.title))
    .sort((a, b) => String(b.published).localeCompare(String(a.published)));
  const newest = reports[0] || null;
  const sameMonth = month
    ? reports.find((e) => e !== newest && new RegExp(`\\b${month}\\b`, 'i').test(e.title)) || null
    : null;
  return { newest, sameMonth };
}

/** Firecrawl's markdown for a YouTube watch page: the upload day and the spoken transcript. */
export function parseYoutubeScrape(md) {
  const s = String(md || '');
  const uploaded = (s.match(/\*\*Uploaded at\*\*:\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || null;
  const at = s.search(/^##\s+Transcript\s*$/m);
  if (at < 0) return null;
  const transcript = s.slice(at).replace(/^##\s+Transcript\s*\n/, '')
    .split('\n').map((l) => l.trim()).filter(Boolean).join(' ')
    .replace(/\s+/g, ' ').trim();
  return transcript ? { uploaded, transcript } : null;
}

// ── Angler's Headquarters (pure, tested) ───────────────────────────────────────────────────

/**
 * The date in a post's title: "AHQ INSIDER Santee Cooper (SC) 2025 Week 47 Fishing Report --
 * Updated November 19" is 2025-11-19. An old title has a season ("Winter 2017/18 ... Updated
 * January 18"), and a January to June date in it is the second year.
 */
export function ahqTitleDate(title) {
  const t = String(title || '');
  const u = t.match(new RegExp(`Updated\\s+(${MONTHS.join('|')})\\s+(\\d{1,2})\\b`, 'i'));
  const y = t.match(/\b(20\d\d)(?:\/(\d\d))?\b/);
  if (!u || !y) return null;
  const mi = MONTHS.findIndex((x) => x.toLowerCase() === u[1].toLowerCase());
  const year = y[2] && mi <= 5 ? Number(`20${y[2]}`) : Number(y[1]);
  return `${year}-${String(mi + 1).padStart(2, '0')}-${String(u[2]).padStart(2, '0')}`;
}

/** A tag listing page's posts, from the <h4> titles TinyFish returns: [{ url, title, date }]. */
export function parseAhqListing(html) {
  const out = [];
  for (const m of String(html || '').matchAll(/<h4[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h4>/gi)) {
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    const href = /^https?:/.test(m[1]) ? m[1] : `${AHQ_BASE}${m[1]}`;
    out.push({ url: href.replace(/[?#].*$/, ''), title, date: ahqTitleDate(title) });
  }
  return out;
}

/**
 * Which posts hold one year's month for one lake, best first. Each post repeats the entries of
 * the weeks before it (the October 19, 2023 post runs back to July 14), so the first post AFTER
 * the month holds all of it. The last one inside the month holds all but its last days, and is
 * the one tried when the first is missing or no longer reaches back.
 */
export function pickAhqPosts(posts, title, year, mi) {
  const ym = `${year}-${String(mi + 1).padStart(2, '0')}`;
  const mine = (posts || []).filter((p) => p.date && String(p.title).includes(`AHQ INSIDER ${title}`));
  const after = mine.filter((p) => p.date.slice(0, 7) > ym).sort((a, b) => a.date.localeCompare(b.date));
  const within = mine.filter((p) => p.date.slice(0, 7) === ym).sort((a, b) => b.date.localeCompare(a.date));
  return [after[0], within[0]].filter(Boolean);
}

const AHQ_DATE_LINE = new RegExp(`^(${MONTHS.join('|')})\\s+(\\d{1,2})$`);
const AHQ_END = /^(We use cookies|#+\s*Search\b|#+\s*Get Hooked|Join AHQ Premier|Leave a comment)/i;

/**
 * One month's entries off a post, verbatim, newest first, each opened by its own date with the
 * year added ("October 19, 2023"). Null when the post has none for that month.
 */
export function parseAhqEntries(md, year, mi) {
  const entries = [];
  let cur = null;
  for (const raw of String(md || '').split('\n')) {
    const line = raw.trim();
    if (AHQ_END.test(line)) break;
    const d = line.match(AHQ_DATE_LINE);
    if (d) {
      cur = { mi: MONTHS.indexOf(d[1]), day: Number(d[2]), lines: [] };
      entries.push(cur);
      continue;
    }
    if (cur) cur.lines.push(raw.replace(/\s+$/, ''));
  }
  const keep = entries.filter((e) => e.mi === mi && e.lines.join('').trim());
  if (!keep.length) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return {
    dates: keep.map((e) => `${year}-${pad(mi + 1)}-${pad(e.day)}`),
    text: keep.map((e) => `${MONTHS[mi]} ${e.day}, ${year}\n${e.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}`)
      .join('\n\n'),
  };
}

// ── fetching ────────────────────────────────────────────────────────────────────────────────

async function tfPage(env, url, extra = {}) {
  const r = await tinyfishFetch({ urls: [url], format: 'markdown', ttl: 0, ...extra }, env);
  const hit = (r && r.results || [])[0];
  if (!hit) {
    const err = (r && r.errors || [])[0];
    throw new Error(err ? `${err.error}` : 'no result');
  }
  return hit;
}

async function readScdnr(src, env) {
  const hit = await tfPage(env, src.url);
  const sec = parseScdnrSection(hit.text, src.section);
  if (!sec) throw new Error(`no "${src.section}" section on the page`);
  return [{
    kind: src.kind, label: `${src.label} -- ${src.section}`, guides: null, url: src.url,
    // NO SINGLE MONTH: the September page also names August behind it and October and November
    // ahead of it ("It usually isn't until October and November that..."). All of them are kept.
    published: null, publishedFrom: null, undated: true, monthNamed: null,
    monthsNamed: sec.monthsNamed, note: src.note, text: sec.text,
  }];
}

async function readSccSite(src, env) {
  const hit = await tfPage(env, src.url, { page_metadata: true });
  const p = parseSccSite(hit.text, hit.page_metadata);
  if (!p) throw new Error('the page had no report text');
  return [{ kind: src.kind, label: src.label, guides: src.guides, url: src.url, ...p }];
}

const pageOf = (u) => String(u || '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
const isPostUrl = (u) => /^https:\/\/(www\.|m\.)?facebook\.com\//.test(u)
  && /\/(posts|photos|videos|permalink)\b/.test(u) && !/\/(groups|fb-answers)\//.test(u);

async function readFacebook(src, env, month, prevMonth) {
  const queries = [...src.queries(month), ...src.queries(prevMonth)];
  const found = await Promise.all(queries.map((q) => tinyfishSearch({
    query: q, include_domains: 'facebook.com',
    purpose: `Find ${src.author}'s monthly fishing report post on Facebook`,
  }, env).catch(() => null)));
  const hits = found.flatMap((r) => (r && r.results) || []);
  const urls = [...new Set(hits.map((x) => x.url).filter(isPostUrl))]
    .slice(0, 10);                                     // TinyFish fetch takes ten URLs a call
  const now = Date.now();
  const r = urls.length ? await tinyfishFetch({ urls, format: 'markdown', ttl: 0 }, env) : null;
  const posts = ((r && r.results) || []).map((hit) => {
    const p = parseFacebookPost(hit.text, src.author, now);
    return p && /fishing report/i.test(p.text) ? { ...p, url: hit.final_url || hit.url } : null;
  }).filter(Boolean)
    .sort((a, b) => String(b.published || '').localeCompare(String(a.published || '')));
  const out = posts.length ? [{ kind: src.kind, label: src.label, guides: src.guides, ...posts[0] }] : [];
  // ── A NEWER POST SEARCH CAN SEE AND NOBODY CAN READ YET ─────────────────────────────────────
  //
  // Measured the evening of 2026-10-01: the October report, posted that afternoon, came back from
  // search only as the PAGE, with a preview: "OCTOBER 2026 FISHING REPORT Santee Cooper & Cooper
  // River STRIPERS Striper season opens October 1st, and anglers should start looking for fish in
  // 30-45 feet of water along flats and creek areas." The page needs a login and the post had no
  // URL in search yet, so the newest readable post was August's. The preview is the only copy of
  // the newest report there is, so it goes in, labelled as a search preview of a post nobody read,
  // and only when the month it names is newer than the newest post that was read.
  const page = pageOf(src.url);
  const previews = hits.filter((x) => pageOf(x.url) === page && /fishing report/i.test(x.snippet || '')
    && monthYearNamed(x.snippet))
    .sort((a, b) => String(monthYearNamed(b.snippet)).localeCompare(String(monthYearNamed(a.snippet)))
      || String(b.snippet).length - String(a.snippet).length);
  const pv = previews[0];
  const readMonth = out[0] ? String(out[0].published || '').slice(0, 7) : '';
  if (pv && monthYearNamed(pv.snippet) > readMonth) {
    out.push({
      kind: src.kind, label: `${src.label} -- search preview only, the post itself could not be read yet`,
      guides: src.guides, url: src.url, published: null, publishedFrom: null, preview: true,
      monthYear: monthYearNamed(pv.snippet), monthNamed: monthsNamed(pv.snippet)[0] || null,
      monthsNamed: monthsNamed(pv.snippet), text: String(pv.snippet).trim(),
    });
  }
  if (!out.length) throw new Error(urls.length ? `read ${urls.length} post(s); none was a fishing report by ${src.author}`
                                               : 'search found no post by URL');
  return out;
}

async function transcriptOf(env, videoId) {
  const key = `guide:yt:${videoId}`;
  if (env.KV) {
    const hit = await env.KV.get(key, 'json');
    if (hit) return hit;
  }
  const fk = env.FIRECRAWL_API_KEY || env.FIRECRAWL_KEY;
  if (!fk) throw new Error('no FIRECRAWL_API_KEY on the Worker');
  const budget = await checkFirecrawlBudget(env, 1);
  if (!budget.allowed) throw new Error(budget.reason);
  const res = await fetch('https://api.firecrawl.dev/v2/scrape', {
    method: 'POST',
    headers: { Authorization: `Bearer ${fk}`, 'Content-Type': 'application/json' },
    // maxAge 0: a live scrape. The first Worker call, without it, came back with no transcript on
    // 2026-10-01 while the same request with maxAge 0 through Firecrawl's MCP had the whole of it.
    body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${videoId}`, formats: ['markdown'],
                           onlyMainContent: true, maxAge: 0, timeout: 90000 }),
  });
  if (!res.ok) throw new Error(`Firecrawl HTTP ${res.status}`);
  await recordFirecrawlUsage(env, 1);
  const data = await res.json();
  const md = (data && data.data && data.data.markdown) || (data && data.markdown) || '';
  const p = parseYoutubeScrape(md);
  if (!p) {
    const meta = (data && data.data && data.data.metadata) || {};
    throw new Error(`Firecrawl returned no transcript (${md.length} characters of markdown, `
      + `postprocessors ${JSON.stringify(meta.postprocessorsUsed || [])}, cache ${meta.cacheState || 'unknown'})`);
  }
  if (env.KV) await env.KV.put(key, JSON.stringify(p));      // a transcript never changes
  return p;
}

async function readYoutube(src, env, month) {
  const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${src.channelId}`,
    { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`channel feed HTTP ${r.status}`);
  const { newest, sameMonth } = pickYoutube(parseYoutubeFeed(await r.text()), src.titleRe, month);
  if (!newest) throw new Error('no report video in the channel feed');
  const out = [];
  const failed = [];
  for (const [v, role] of [[newest, 'newest'], [sameMonth, 'same month, an earlier year']]) {
    if (!v) continue;
    // One video failing does not lose the other.
    let t;
    try { t = await transcriptOf(env, v.videoId); } catch (e) { failed.push(`${v.title}: ${e.message}`); continue; }
    out.push({
      kind: src.kind, label: `${src.label}: ${v.title}`, guides: src.guides,
      url: `https://www.youtube.com/watch?v=${v.videoId}`,
      published: t.uploaded || (v.published ? String(v.published).slice(0, 10) : null),
      publishedFrom: t.uploaded ? 'the upload date YouTube shows' : 'the channel feed',
      monthNamed: monthsNamed(v.title)[0] || null, role, text: t.transcript,
    });
  }
  if (!out.length) throw new Error(failed.join('; '));
  return out;
}

/**
 * The plan's month in each of the last three years. A past month's report never changes, so each
 * is kept in KV for good once read, and the listing is read only for a year not yet kept. Ten
 * listing pages (about 22 posts each, newest first) reach back past three years: on Santee Cooper
 * page 3 was February to August 2025 on 2026-10-01.
 */
async function readAhq(src, env, dateStr) {
  const y = Number(dateStr.slice(0, 4));
  const mi = Number(dateStr.slice(5, 7)) - 1;
  const years = Array.from({ length: AHQ_YEARS }, (_, k) => y - 1 - k);
  const keyOf = (yr) => `guide:ahq:v1:${src.tag}:${yr}-${String(mi + 1).padStart(2, '0')}`;
  const got = new Map();
  const failed = [];
  if (env.KV) {
    for (const yr of years) {
      const hit = await env.KV.get(keyOf(yr), 'json');
      if (hit) got.set(yr, hit);
    }
  }
  const need = years.filter((yr) => !got.has(yr));
  if (need.length) {
    const pages = Array.from({ length: 10 }, (_, k) => `${src.url}?page=${k + 1}`);
    const lr = await tinyfishFetch({ urls: pages, format: 'html', include_selectors: ['h4'] }, env);
    const posts = ((lr && lr.results) || []).flatMap((h) => parseAhqListing(h.text));
    const picks = need.map((yr) => ({ yr, cands: pickAhqPosts(posts, src.title, yr, mi), why: [] }));
    const fetchPosts = async (urls) => {
      if (!urls.length) return new Map();
      const r = await tinyfishFetch({ urls, format: 'markdown', exclude_selectors: ['nav', 'header', 'footer'] }, env);
      return new Map(((r && r.results) || []).map((h) => [String(h.url).replace(/[?#].*$/, ''), h]));
    };
    const tryPost = (p, c, h) => {
      if (!h) { p.why.push(`${c.title}: not fetched`); return; }
      if (/doesn.t look like you have access/i.test(h.text)) { p.why.push(`${c.title}: members only`); return; }
      const e = parseAhqEntries(h.text, p.yr, mi);
      if (e) { p.e = e; p.c = c; } else p.why.push(`${c.title}: no ${MONTHS[mi]} entries on it`);
    };
    // Each year's best post in one call; the fallback only for a year whose best had nothing.
    const first = await fetchPosts(picks.filter((p) => p.cands[0]).map((p) => p.cands[0].url));
    for (const p of picks) if (p.cands[0]) tryPost(p, p.cands[0], first.get(p.cands[0].url));
    const retry = picks.filter((p) => !p.e && p.cands[1]);
    const second = await fetchPosts(retry.map((p) => p.cands[1].url));
    for (const p of retry) tryPost(p, p.cands[1], second.get(p.cands[1].url));
    for (const p of picks) {
      if (!p.cands.length) p.why.push(`no ${src.title} post dated in or after ${MONTHS[mi]} ${p.yr} on the first ten listing pages`);
      if (!p.e) { failed.push(`${p.yr}: ${p.why.join('; ')}`); continue; }
      const rep = {
        kind: src.kind, label: `${src.label} -- ${src.title}, ${MONTHS[mi]} ${p.yr}`, guides: src.guides,
        url: p.c.url, published: p.e.dates[0], publishedFrom: `its newest ${MONTHS[mi]} entry`,
        role: 'same month, an earlier year', monthNamed: MONTHS[mi], monthsNamed: [MONTHS[mi]], text: p.e.text,
      };
      got.set(p.yr, rep);
      if (env.KV) await env.KV.put(keyOf(p.yr), JSON.stringify(rep));
    }
  }
  const out = years.filter((yr) => got.has(yr)).map((yr) => got.get(yr));
  if (!out.length) throw new Error(failed.join('; ') || 'nothing found');
  if (failed.length) out.partial = `not found: ${failed.join('; ')}`;
  return out;
}

const READERS = { scdnr: readScdnr, page: readSccSite, facebook: readFacebook, youtube: readYoutube, ahq: readAhq,
  'scdnr-any': readScdnrAny, 'ahq-any': readAhqAny, search: readSearch };

/** Every listed source for one water, each one's failure said rather than swallowed. */
export async function gatherGuideReports(slug, env, dateStr) {
  const general = await generalSources(slug, env);
  const sources = [...(GUIDE_SOURCES[slug] || []), ...general.sources];
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || '')) ? String(dateStr) : dayEastern();
  const mi = Number(d.slice(5, 7)) - 1;
  const y = Number(d.slice(0, 4));
  const month = MONTHS[mi];
  const prev = mi === 0 ? `${MONTHS[11]} ${y - 1}` : `${MONTHS[mi - 1]} ${y}`;
  const settled = await Promise.allSettled(sources.map((s) => {
    const fn = READERS[s.kind];
    return s.kind === 'facebook' ? fn(s, env, `${month} ${y}`, prev)
      : s.kind === 'youtube' ? fn(s, env, month)
        : (s.kind === 'ahq' || s.kind === 'ahq-any' || s.kind === 'search') ? fn(s, env, d) : fn(s, env);
  }));
  const reports = [];
  const checked = [];
  settled.forEach((r, i) => {
    const s = sources[i];
    if (r.status === 'fulfilled') {
      reports.push(...r.value);
      checked.push({ label: s.label, url: s.url, ok: true, ...(r.value.partial ? { why: r.value.partial } : {}) });
    }
    else checked.push({ label: s.label, url: s.url, ok: false, why: String(r.reason && r.reason.message || r.reason) });
  });
  return { slug, date: d, reports, checked,
           ...(general.why.length ? { notSearched: general.why } : {}),
           none: sources.length ? null : (general.why.join('; ') || `no guide sources for ${slug}`) };
}

// ── route ───────────────────────────────────────────────────────────────────────────────────

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...JSON_HEADERS, ...CORS } });

/**
 * GET /guide-reports/<slug>?date=YYYY-MM-DD[&fresh=1]
 *
 * Kept in KV for the Eastern day it was read, per plan month, so a day of re-planning asks each
 * source once. Open like /reports: search and fetch are free, and the one thing that costs -- a
 * transcript, 1 Firecrawl credit -- is kept forever per video and sits behind the Firecrawl hard
 * stop. `fresh=1` skips the day's copy and is token-guarded, because it is the one way to ask
 * every source again on demand.
 */
export async function handleGuideReports(request, env, url) {
  const mm = url.pathname.match(/^\/guide-reports\/([a-z0-9_]+)\/?$/);
  if (!mm) return null;
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (request.method !== 'GET') return json({ error: 'GET' }, 405);
  const fresh = url.searchParams.get('fresh') === '1';
  if (fresh && !await isAuthorized(request, env)) return json({ error: 'unauthorized' }, 401);
  const slug = mm[1];
  const date = url.searchParams.get('date') || dayEastern();
  // v2 since the search preview was added (2026-10-01): a day kept by v1 has no preview in it.
  // v3 the same evening: the quoted search form and the live transcript scrape. v4: "may" is a verb.
  // v5: Angler's Headquarters, the plan's month in each of the last three years.
  // v6, 2026-10-02: SCDNR, AHQ and a search for every water with a research profile.
  const key = `guide:reports:v6:${slug}:${String(date).slice(0, 7)}:${dayEastern()}`;
  if (env.KV && !fresh) {
    const hit = await env.KV.get(key, 'json');
    if (hit) return json({ ...hit, cached: true });
  }
  const body = { ...await gatherGuideReports(slug, env, date), readAt: new Date().toISOString() };
  // A day where every source failed is not kept, so the next plan asks again.
  if (env.KV && body.reports.length) await env.KV.put(key, JSON.stringify(body), { expirationTtl: 2 * 86400 });
  return json(body);
}
