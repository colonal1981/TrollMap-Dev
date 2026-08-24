/**
 * reports.js — recent fishing reports for one water, from the people who were on it.
 *
 * Ryan, 2026-08-15: *"maybe a way to just scan for updated guide reports during the planning...
 * this doesn't need to go to the llm for anything maybe just to me in the trip html report"*
 *
 * NOTHING HERE IS SUMMARISED, AND THAT IS THE POINT. A guide report's whole value is that a
 * person who was on the water wrote it. Paraphrased it is worth nothing and cannot be checked,
 * so every field below is either verbatim text or a date read off the source.
 *
 * FOUR SOURCES, TRACED 2026-08-15, THREE OF THEM WORTH HAVING
 *
 *   GA   georgiawildlife.blog/category/fishing/feed/     RSS. Weekly, every Friday. Newest item
 *                                                        on the day this was written: 14 Aug.
 *   NC   carolinasportsman.com/category/field-reports/
 *        fishing-reports/feed/                           RSS. Newest 8 Aug.
 *                                                        NOTE the /category/ path -- the bare
 *                                                        /field-reports/fishing-reports/feed/ is
 *                                                        the COMMENTS feed and is empty.
 *   SC   anglersheadquarters.com                         Per-water pages, no date anywhere.
 *   TN   tn.gov/twra/fishing/weekly-fishing-report.html  Dated inline, and STALE: every one of
 *                                                        its 13 entries is April or May.
 *
 * THE TWO FEEDS CARRY A REAL pubDate AND AHQ DOES NOT. That difference is preserved all the way
 * to the caller rather than smoothed over: a feed item gets `published`, an AHQ page gets
 * `published: null` and `undated: true`. Printing "updated 3 days ago" on a page that states no
 * date would be a derived claim wearing a fact's clothes, which is the mistake that cost this
 * codebase a Duke drawdown number in August.
 *
 * TENNESSEE IS INCLUDED AND FLAGGED, NOT SILENTLY DROPPED. It is called a weekly report and has
 * not moved since 27 May; of its thirteen lakes only Fort Loudoun and Norris Tailwater are water
 * this app ships. The parser reads the date it states and the caller can refuse it. Dropping the
 * source outright would hide that it exists; trusting it would print May conditions in August.
 *
 * NO PER-LAKE TABLE. AHQ is resolved through its own state hub page, which lists every water it
 * covers and the slug for each. The hub is the index, so a lake AHQ adds appears without a code
 * change -- the opposite of `LAKES`, `LAKE_INTEL` and the nine hardcoded `ahq` keys in
 * worker-data.js that this replaces.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 */

import { CORS, JSON_HEADERS } from './worker-core.js';

const UA = 'TrollMap/1.0 (personal fishing app)';

export const REPORT_SOURCES = {
  GA: {
    kind: 'rss',
    label: 'Georgia DNR — Georgia Wildlife Blog',
    url: 'https://georgiawildlife.blog/category/fishing/feed/',
    cadence: 'weekly, Fridays; from 2026-08-14 it rotates one region of the state per week',
  },
  NC: {
    kind: 'rss',
    label: 'Carolina Sportsman — Field Reports',
    url: 'https://www.carolinasportsman.com/category/field-reports/fishing-reports/feed/',
    cadence: 'as posted',
  },
  SC: {
    kind: 'ahq',
    label: "Angler's Headquarters",
    hub: 'https://www.anglersheadquarters.com/pages/south-carolina-fishing-reports',
    cadence: 'undated',
  },
  TN: {
    kind: 'twra',
    label: 'TWRA — Weekly Fishing Report',
    url: 'https://www.tn.gov/twra/fishing/weekly-fishing-report.html',
    cadence: 'nominally weekly; stale since 2026-05-27',
  },
};

// AHQ also covers NC and GA lakes. Those two states already have a dated feed, so AHQ is the
// SC path here -- but the hub pattern is stated so a future NC/GA lake with no feed coverage
// can reach it without inventing a new mechanism.
//
// NC AND GA NO LONGER HAVE A HUB. Measured 2026-08-24 by capture_upstreams.py: the SC hub
// returns 200 while `/pages/north-carolina-fishing-reports` and `/pages/georgia-fishing-reports`
// both return 404. AHQ reorganised and kept only the SC index. They are NULL rather than deleted
// so the shape of the fallback survives and a reader gets "no hub" instead of a dead fetch --
// the per-lake pages (`/pages/lake-hartwell-fishing-report`) are all still live, so a future
// NC/GA lake reaches AHQ by lake slug, not by state hub.
export const AHQ_HUBS = {
  SC: 'https://www.anglersheadquarters.com/pages/south-carolina-fishing-reports',
  NC: null,
  GA: null,
};

// ── name matching ───────────────────────────────────────────────────────────────────────────

// The same stop words the registry's own matchers use. "Lake" and "Reservoir" carry no
// information -- every candidate has one -- and leaving them in makes "Lake X" match "Lake Y".
const STOP = new Set(['lake', 'lakes', 'reservoir', 'res', 'the', 'a', 'of', 'at', 'near', 'on']);

// Verbatim from trollmap-worker.js:468, plus the two words that name the water BELOW a dam.
// A name carrying one of these is a DIFFERENT body of water from the lake it is named after,
// and tailwater-vs-pool is the exact distinction that bound Wateree to the wrong reservoir on
// 2026-08-15. TWRA publishes "Norris Tailwater"; Norris Lake is not it.
const FLOWING_RE = /\b(river|creek|canal|branch|run|fork|swamp|slough|tailwater|tailrace)\b/i;

const rx = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Agencies abbreviate and the registry does not. TWRA publishes "Ft. Loudoun Reservoir" and
// "Ft Patrick Henry Reservoir"; the registry says "Fort Loudoun Lake". Two waters, one of them
// shipped, both lost to three characters. In a water name these two are never anything else.
const ABBREV = { ft: 'fort', mt: 'mount' };

export function reportTokens(s) {
  return new Set(String(s || '')
    .replace(/\([^)]*\)/g, ' ')            // drop the county parenthetical
    .replace(/,\s*[A-Z]{2}(\/[A-Z]{2})?\b/g, ' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOP.has(t))
    .map((t) => ABBREV[t] || t));
}

/**
 * Does `text` name this water?
 *
 * EVERY distinctive token must appear. Not "any" -- a single shared word is how "Lake Russell"
 * became "Richard B Russell" in the Worker's lake resolver earlier the same day.
 * "Zach Neill's Lake Junaluska largemouth" must match Lake Junaluska and nothing else.
 *
 * AND NOT ONLY AS A COUNTY. Measured against the live index 2026-08-16: 21 of the 156 county
 * names it carries are ALSO the entire distinctive name of a water it ships -- Marion, Oconee,
 * Greenwood, Cherokee, Jackson, Richland, York and fifteen more. Without this guard a headline
 * of the shape Carolina Sportsman actually publishes -- "Brantley Hawkins' Wilson County bass"
 * -- prints a county story as a lake report, and it would do it on Lake Marion, the biggest
 * water here. The lookahead rejects a token only when EVERY occurrence of it is followed by
 * "County", so "Lake Marion in Marion County" still matches. It spans hyphens and underscores
 * as well as spaces, because the haystack includes the item's link and the same story arrives
 * there as ".../brantley-hawkins-wilson-county-bass/".
 */
export function namesWater(text, waterNames) {
  const hay = String(text || '').toLowerCase();
  for (const nm of waterNames) {
    const toks = [...reportTokens(nm)];
    if (!toks.length) continue;
    if (toks.every((t) => new RegExp(`\\b${rx(t)}\\b(?![\\s\\-_]+count(?:y|ies)\\b)`).test(hay))) {
      return nm;
    }
  }
  return null;
}

/**
 * Name against name -- for a source that publishes a WATER NAME rather than prose.
 *
 * `namesWater` scans free text and can only ever ask "is this name in there". A hub link or a
 * TWRA heading IS a name, so the comparison can run both ways, and it has to: the registry says
 * "Charleston Harbor, SC" where AHQ says "charleston", and requiring every registry token would
 * lose all five SC coastal reports. Subset in EITHER direction, then:
 *
 *   - the surplus tokens are checked against FLOWING_RE, because they are what distinguishes
 *     Wateree River from Wateree Lake and Norris Tailwater from Norris Lake;
 *   - the best overlap wins, NOT the first hit. First-past-the-post has been fixed twice in this
 *     codebase in one week -- the binder and consolidate both had it -- and the AHQ hub is its
 *     shape again, with "lake-hartwell" and "clarks-hill-lake-thurmond" on the same page.
 *
 * Measured against the live index 2026-08-16: 17 of 128 SC waters resolve to an AHQ entry, all
 * 17 correct, against 12 under the one-way rule.
 */
export function matchWaterName(candidate, waterNames, opts = {}) {
  // WHICH SIDE MAY BE BROADER IS NOT A DETAIL. Extra tokens on the REGISTRY side are usually a
  // fuller official name -- AHQ says "charleston", the registry says "Charleston Harbor, SC".
  // Extra tokens on the SOURCE side can mean a different water entirely: Duke publishes
  // "Mountain Island Lake" and the registry ships "Mountain Lake", and those are not the same
  // reservoir. Sources that aggregate need the loose direction -- AHQ's one page for
  // "santee cooper lake marion lake moultrie" serves both Marion and Moultrie -- so it stays
  // the default, and a source that never aggregates passes sourceMayBeBroader: false.
  const { sourceMayBeBroader = true } = opts;
  const cand = reportTokens(candidate);
  if (!cand.size) return null;
  let best = null;
  for (const nm of waterNames) {
    const w = reportTokens(nm);
    if (!w.size) continue;
    const candInW = [...cand].every((t) => w.has(t));
    const wInCand = [...w].every((t) => cand.has(t));
    if (!candInW && !(wInCand && sourceMayBeBroader)) continue;
    const extra = candInW ? [...w].filter((t) => !cand.has(t)) : [...cand].filter((t) => !w.has(t));
    if (extra.some((t) => FLOWING_RE.test(t))) continue;
    let overlap = 0;
    for (const t of cand) if (w.has(t)) overlap += 1;
    if (!best || overlap > best.overlap) best = { name: nm, overlap };
  }
  return best ? best.name : null;
}

/** The AHQ hub entry that matches this water BEST, or null. Pure, so the choice is testable. */
export function pickAhqEntry(entries, waterNames) {
  let best = null;
  for (const e of entries || []) {
    const matched = matchWaterName(e.name, waterNames);
    if (!matched) continue;
    const cand = reportTokens(e.name); const w = reportTokens(matched);
    let overlap = 0;
    for (const t of cand) if (w.has(t)) overlap += 1;
    if (!best || overlap > best.overlap) best = { entry: e, matched, overlap };
  }
  return best;
}

// ── parsers, all pure ───────────────────────────────────────────────────────────────────────

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  if (!m) return null;
  return m[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim() || null;
};

/** RSS 2.0 -> [{title, link, published, description}]. No XML parser in a Worker; this is enough. */
export function parseRss(xml) {
  const out = [];
  const body = String(xml || '');
  const re = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(body)) !== null) {
    const it = m[1];
    const title = tag(it, 'title');
    if (!title) continue;
    const pub = tag(it, 'pubDate');
    const ms = pub ? Date.parse(pub) : NaN;
    out.push({
      title,
      link: tag(it, 'link'),
      published: Number.isFinite(ms) ? new Date(ms).toISOString() : null,
      published_raw: pub,
      // Kept short and verbatim. A description is a teaser, not the report.
      description: (tag(it, 'description') || '').replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ').trim().slice(0, 400) || null,
    });
  }
  return out;
}

/**
 * TWRA's page, into dated entries.
 *
 * TWO THINGS HERE ARE NOT OBVIOUS AND BOTH WERE MEASURED, NOT GUESSED.
 *
 * 1. THE DASH IS NOT ONE CHARACTER. Seven of the thirteen headings use an EN DASH and six use a
 *    plain hyphen -- Kentucky Lake, Nickajack, Normandy, Old Hickory, Percy Priest and Reelfoot
 *    are the hyphens. Matching only one of them silently loses six of thirteen lakes. And on the
 *    wire the en dash arrives as `&#8211;`, so it has to be decoded BEFORE the blanket
 *    numeric-entity rule or the heading loses its separator entirely and the entry disappears.
 *
 * 2. THE NAME CAPTURE MUST BE ANCHORED TO A LINE. Unanchored, the lazy capture walks BACKWARD
 *    into the previous entry's prose: run against real-shaped text it produced a water called
 *    "Crappie moving deeper. Cordell Hull", and put "Big Sandy" -- an actual Kentucky Lake
 *    embayment -- directly in front of the name matcher. That is a false attachment waiting to
 *    happen, so the heading is matched at the start of a line and the class holds no newline.
 *
 * Takes the page's HTML, because that is what the fetcher hands it. Block tags become newlines
 * first; the headings are heading elements, so that is where the line structure comes from.
 */
export function parseTwra(html) {
  const t = String(html || '')
    .replace(/<(?:script|style)[\s\S]*?<\/(?:script|style)>/gi, ' ')
    .replace(/<\/?(?:h[1-6]|p|div|br|li|tr|td|section|article|ul|ol)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;?/gi, ' ')
    .replace(/&(?:ndash|#8211);/gi, '\u2013')
    .replace(/&(?:mdash|#8212);/gi, '\u2014')
    .replace(/&amp;/gi, '&')
    .replace(/&#\d+;/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]*/g, '\n');
  const re = /^ ?([A-Z][A-Za-z' ]{2,40}?) ?[\u2013\u2014-] ?(\d{1,2}\/\d{1,2}\/\d{2,4})/gm;
  const hits = [];
  let m;
  while ((m = re.exec(t)) !== null) hits.push({ name: m[1].trim(), date: m[2], at: m.index, end: re.lastIndex });
  return hits.map((h, i) => {
    const body = t.slice(h.end, i + 1 < hits.length ? hits[i + 1].at : Math.min(t.length, h.end + 1200))
      .replace(/\s+/g, ' ').trim();
    const [mo, da, yr] = h.date.split('/').map(Number);
    const year = yr < 100 ? 2000 + yr : yr;
    const d = new Date(Date.UTC(year, mo - 1, da));
    return {
      title: `${h.name} \u2014 ${h.date}`,
      water: h.name,
      published: Number.isFinite(d.getTime()) ? d.toISOString() : null,
      published_raw: h.date,
      description: body.slice(0, 900) || null,
    };
  });
}

/** The AHQ state hub lists every water it covers: /pages/<slug>-fishing-report. */
export function parseAhqHub(html) {
  const out = new Map();
  const re = /href="(?:https?:\/\/[^"]*)?\/pages\/([a-z0-9-]+)-fishing-report"/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    const slug = m[1];
    if (!out.has(slug)) out.set(slug, `https://www.anglersheadquarters.com/pages/${slug}-fishing-report`);
  }
  return [...out].map(([slug, url]) => ({ slug, url, name: slug.replace(/-/g, ' ') }));
}

/**
 * Pull the report text out of an AHQ page.
 *
 * Lifted from `fetchAhqFishingReport` in worker-data.js, which fought this page for long enough
 * to grow five fallback anchors. Kept as a pure function so the anchors can be tested against a
 * saved page instead of against the live site.
 */
export function parseAhqPage(html) {
  let raw = String(html || '');
  const anchors = [
    raw.search(/<article[\s>]/i),
    raw.search(/class=["'][^"']*\brte\b[^"']*["']/i),
    raw.search(/class=["'][^"']*article[^"']*body[^"']*["']/i),
    raw.search(/Learn more about/i),
    raw.search(/Recent [A-Za-z]+ (Lake|Fishing)/i),
  ].filter((i) => i >= 0);
  if (anchors.length) raw = raw.slice(Math.min(...anchors));
  const text = raw.replace(/(?:<script|<style)[\s\S]*?<\/(?:script|style)>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;?/g, ' ')
    .replace(/&amp;/g, '&').replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const idxs = [
    text.search(/morning surface water temp/i),
    text.search(/water temp/i),
    text.search(/striper|striped bass|largemouth|crappie|catfish/i),
    text.search(/fishing has been|bite has been|fish are/i),
  ].filter((i) => i >= 0);
  if (!idxs.length) return null;
  const i = Math.min(...idxs);
  let s = text.slice(Math.max(0, i - 100), i + 900).trim();
  if (s.length > 1000) s = `${s.slice(0, 1000)}…`;
  return s || null;
}

/**
 * A feed item's ARTICLE, as text. Needed, and this is the measurement that says so.
 *
 * The Georgia feed is the best of the four sources -- dated, weekly, posted yesterday -- and
 * matching against the feed alone can NEVER return anything. Checked live 2026-08-16: no item
 * carries `content:encoded`, and the excerpt on the newest item reads "Starting this week, the
 * Georgia Fishing Report will highlight one region of the state each week" and names no water
 * at all. The article behind that same link names eight: Allatoona, Lanier, HARTWELL, West
 * Point, Weiss, Rocky Mountain PFA, Unicoi and Moccasin Creek. Hartwell is water this app
 * ships. So the names are one fetch past the feed, and a module that stops at the feed ships a
 * source that is structurally incapable of matching.
 *
 * Sliced to the article region first, for the same reason `parseAhqPage` is: a blog sidebar
 * that lists every lake the site has ever covered would match every lake.
 */
export function articleText(html) {
  let raw = String(html || '');
  const start = [
    raw.search(/class=["'][^"']*\bentry-content\b[^"']*["']/i),
    raw.search(/<article[\s>]/i),
  ].filter((i) => i >= 0);
  if (start.length) raw = raw.slice(Math.min(...start));
  const end = raw.search(/<\/article>/i);
  if (end > 0) raw = raw.slice(0, end);
  return raw
    .replace(/<(?:script|style)[\s\S]*?<\/(?:script|style)>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;?/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40000);
}

// How many article pages one feed is allowed to cost, and how old an item may be before it is
// not worth a fetch. Both are stated in the response rather than applied quietly -- a cap the
// caller cannot see reads as "we looked at everything" when it is not.
export const ARTICLE_SCAN_LIMIT = 3;
export const ARTICLE_MAX_AGE_DAYS = 45;

/**
 * Which items are worth fetching in full: newest first, only ones the excerpt did not already
 * match, only ones inside the age window, capped. Pure -- `nowMs` is passed in, never read.
 */
export function rssScanPlan(xml, waterNames, nowMs, limit = ARTICLE_SCAN_LIMIT) {
  const all = parseRss(xml);
  const fresh = all.filter((it) => {
    if (!it.link) return false;
    if (namesWater(`${it.title} ${it.description || ''} ${it.link}`, waterNames)) return false;
    if (!it.published) return true;
    const age = (nowMs - Date.parse(it.published)) / 86400000;
    return age <= ARTICLE_MAX_AGE_DAYS;
  });
  return { links: fresh.slice(0, limit).map((it) => it.link), candidates: fresh.length, limit };
}

// ── the shape the caller gets ───────────────────────────────────────────────────────────────

/**
 * Pure. Everything above, assembled for one water.
 *
 * `matched` is the registry name that matched, so a wrong hit is debuggable from the response
 * instead of requiring the source to be re-fetched.
 */
export function shapeReports({ rssByState = {}, articlesByLink = {}, twraText = null,
                               ahqText = null, ahqUrl = null }, waterNames, state) {
  const items = [];
  for (const [st, xml] of Object.entries(rssByState)) {
    const src = REPORT_SOURCES[st];
    for (const it of parseRss(xml)) {
      // `matched_in` travels with the item because the two are not equally strong: a name in
      // the headline is the post being about that water, a name in the body may be one line of
      // an eight-lake roundup.
      let where = 'excerpt';
      let hit = namesWater(`${it.title} ${it.description || ''} ${it.link || ''}`, waterNames);
      if (!hit && it.link && articlesByLink[it.link]) {
        hit = namesWater(articlesByLink[it.link], waterNames);
        where = 'article';
      }
      if (!hit) continue;
      items.push({ ...it, matched: hit, matched_in: where, source: src ? src.label : st,
                   source_state: st, undated: !it.published });
    }
  }
  if (twraText) {
    const src = REPORT_SOURCES.TN;
    for (const it of parseTwra(twraText)) {
      // A heading is a name, not prose -- and "Norris Tailwater" must not become Norris Lake.
      const hit = matchWaterName(it.water, waterNames);
      if (!hit) continue;
      items.push({ ...it, link: src.url, matched: hit, source: src.label, source_state: 'TN',
                   undated: !it.published,
                   // Said on the item, not left to the reader to work out.
                   caution: 'TWRA has not updated this page since 2026-05-27' });
    }
  }
  items.sort((a, b) => (b.published || '').localeCompare(a.published || ''));

  return {
    water_state: state || null,
    // Dated items, newest first. The only ones that can honestly claim to be recent.
    items,
    // AHQ, kept separate BECAUSE it carries no date. Merging it into `items` would put undated
    // text next to dated text and invite the reader to assume it is current.
    undated: ahqText ? [{ source: REPORT_SOURCES.SC.label, link: ahqUrl, text: ahqText,
                          published: null, undated: true }] : [],
    // "Nobody looked here" and "nothing to report" are different answers.
    checked: Object.keys(rssByState).concat(twraText ? ['TN'] : [], ahqUrl ? ['AHQ'] : []),
    // Said out loud, not applied quietly -- AND the units have to match, or the statement is
    // worse than silence. The cap is PER FEED: a two-feed lookup legitimately reads six
    // articles against a limit of three, and the first version of this field reported exactly
    // that as `articles_read: 6, article_limit: 3`, which reads as a cap being violated.
    scanned: {
      articles_read: Object.keys(articlesByLink).length,
      article_limit_per_feed: ARTICLE_SCAN_LIMIT,
      feeds_scanned: Object.keys(rssByState).length,
    },
    none_found: !items.length && !ahqText,
  };
}

// ── fetch ───────────────────────────────────────────────────────────────────────────────────

async function text(url, ms = 8000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: c.signal });
    return r.ok ? await r.text() : null;
  } catch (_) { return null; } finally { clearTimeout(t); }
}

const _cache = new Map();
function cached(key, ttlMs, fn) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return Promise.resolve(hit.v);
  return fn().then((v) => { _cache.set(key, { t: Date.now(), v }); if (_cache.size > 32) _cache.delete(_cache.keys().next().value); return v; });
}

/** Reports for one water. `waterNames` is name + display_name + every legacy name. */
export async function fetchReports(waterNames, state) {
  const TTL = 30 * 60 * 1000;
  // Both feeds every time regardless of the water's state: Carolina Sportsman posts SC water
  // and the Georgia blog covers border reservoirs. The name match decides, not the state.
  const [ga, nc, twra, hubHtml] = await Promise.all([
    cached('rss:GA', TTL, () => text(REPORT_SOURCES.GA.url)),
    cached('rss:NC', TTL, () => text(REPORT_SOURCES.NC.url)),
    state === 'TN' ? cached('twra', TTL, () => text(REPORT_SOURCES.TN.url)) : Promise.resolve(null),
    AHQ_HUBS[state] ? cached(`ahqhub:${state}`, 6 * TTL, () => text(AHQ_HUBS[state])) : Promise.resolve(null),
  ]);

  let ahqText = null; let ahqUrl = null;
  if (hubHtml) {
    const best = pickAhqEntry(parseAhqHub(hubHtml), waterNames);
    if (best) {
      ahqUrl = best.entry.url;
      const page = await cached(`ahq:${best.entry.slug}`, TTL, () => text(best.entry.url));
      ahqText = page ? parseAhqPage(page) : null;
    }
  }
  const rssByState = {};
  if (ga) rssByState.GA = ga;
  if (nc) rssByState.NC = nc;

  // The excerpt is not the post. See articleText() for the measurement.
  const now = Date.now();
  const links = [];
  for (const xml of Object.values(rssByState)) links.push(...rssScanPlan(xml, waterNames, now).links);
  const articlesByLink = {};
  await Promise.all([...new Set(links)].map(async (link) => {
    const html = await cached(`art:${link}`, 6 * TTL, () => text(link));
    if (html) articlesByLink[link] = articleText(html);
  }));

  return shapeReports({ rssByState, articlesByLink, twraText: twra, ahqText, ahqUrl }, waterNames, state);
}

// ── route ───────────────────────────────────────────────────────────────────────────────────

/**
 * GET /reports/<slug>?names=A|B|C&state=SC
 *
 * Returns null when the path is not ours, the same contract handleWaterRoute and
 * handleConditions use, so this cannot shadow an existing route.
 *
 * THE CLIENT SENDS THE NAMES, and that is deliberate: as `handleConditions` says in its own
 * 400, "the Worker has no lake registry". The client already holds the row it selected, with
 * `name`, `display_name` and every `legacy_display_names` entry -- which is the full alias set
 * the matcher needs, and the reason "Lake Russell" reaches Richard B Russell Lake at all.
 * Rebuilding that list in the Worker would be a second copy of the registry to keep in step.
 */
export async function handleReports(request, env, url) {
  const mm = url.pathname.match(/^\/reports\/([^/]+)$/);
  if (!mm) return null;
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (request.method !== 'GET') {
    return new Response('{"error":"method not allowed"}', { status: 405, headers: { ...CORS, ...JSON_HEADERS } });
  }
  const names = (url.searchParams.get('names') || '').split('|').map((x) => x.trim()).filter(Boolean);
  const state = (url.searchParams.get('state') || '').trim().toUpperCase() || null;
  if (!names.length) {
    return new Response(JSON.stringify({
      error: 'names is required',
      why: 'the Worker has no lake registry; the client knows the row it selected',
      how: '/reports/<slug>?names=Wateree%20Lake|Lake%20Wateree,%20SC&state=SC',
    }), { status: 400, headers: { ...CORS, ...JSON_HEADERS } });
  }
  const body = await fetchReports(names, state).catch((err) => ({
    error: 'fetch failed', detail: err && err.message, items: [], undated: [], checked: [], none_found: true,
  }));
  return new Response(JSON.stringify({ slug: mm[1], sources: REPORT_SOURCES, ...body }, null, 2), {
    headers: { ...CORS, ...JSON_HEADERS, 'Cache-Control': 'public, max-age=900' },
  });
}
