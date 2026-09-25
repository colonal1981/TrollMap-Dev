// research/text-date.js — the date of the text a fact's quote came from.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// A FACT HAD NO DATE. `_extractedFacts` carried {fact, quote, source, page, confidence, category},
// so a 2007 regulation and a 2016 one read as the same kind of fact, and a weekly report page
// such as AHQ INSIDER -- twenty dated entries under one title -- gave its July entry and its
// January entry nothing to tell them apart. The dates were always in the text.
//
// THE RULE, in order, and the first that answers wins:
//   1. The nearest DATE LINE above the quote -- a line that is only a date ("October 30",
//      "January 22, 2026", "2025-03-14"). This is Scripts/claude_species.py's rule for the
//      packet (`_DATE_LINE`, and "date lines are section breaks too"), ported, not re-invented:
//      a weekly report's entries are dated only by the line above them.
//   2. The page's own date: a full date in its title, else the first date STAMPED on the page in
//      the top 4,000 characters of its text (claude_species.py's `_DATE_ANY` over the same span),
//      else a year in its title. A stamp is a date written as the page's date -- see isStamp() --
//      and not one inside a sentence, which is an event the page describes.
//   3. null. `fetchedAt` is when we read the page, not when it was written, and is never a date.
//
// `textDateFrom` says which of these answered and quotes what it read, so the date can be checked
// against the page by anyone reading the fact.

const MONTH = String.raw`(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?`;
// Verbatim from claude_species.py. JS has no inline `re.I`, so the flag goes on the literal.
const DATE_LINE = new RegExp(String.raw`^\W*(?:${MONTH}\s+\d{1,2}(?:,?\s+\d{4})?|\d{1,2}\s+${MONTH},?\s+\d{4}|\d{4}-\d{2}-\d{2})\W*$`, 'i');
const DATE_ANY = new RegExp(String.raw`(?:${MONTH}\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+${MONTH},?\s+\d{4}|\b\d{4}-\d{2}-\d{2}\b|(?:Published|Updated)[:\s*]+[A-Za-z]{3,9}\.? \d{1,2},? \d{4})`, 'gi');
const TOP_OF_PAGE = 4000;   // claude_species.py's `text[:4000]`: one span for both readers of it

const WEEKDAY = String.raw`(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)\.?`;
// A byline: "by" and a name, every word of it capitalised ("by Jay", "By Brian Cope").
const BYLINE = String.raw`by\s+[A-Z][\w.'’-]*(?:\s+[A-Z][\w.'’-]*)*`;
const LABEL = /\b(?:Published|Updated|Posted)(?:\s+on)?[\s:*|·,–—-]*$/i;
// Case-sensitive, or "recorded by the state on March 5, 1952" would read as a byline.
const BYLINE_LABEL = new RegExp(String.raw`\b[Bb]${BYLINE.slice(1)}(?:\s+on)?[\s:*|·,–—-]*$`);
const ONLY = new RegExp(String.raw`^[\W_]*(?:${WEEKDAY}[\W_]*)?(?:${BYLINE}[\W_]*)?$`);

/**
 * Is the DATE_ANY match `m` written as the page's date, or inside a sentence?
 *
 * Measured by the desktop session on 1,145 stored facts of Wateree, Murray, Greenwood and Marion
 * (2026-09-25): 166 of 371 facts dated "near the top" took a date out of running prose -- 14
 * Grokipedia facts dated 1952-03-05 from "a managed maximum of 442.02 feet recorded on March 5,
 * 1952", six Santee Cooper facts dated 1942 from "On Feb. 17, 1942, Santee Cooper first
 * generated electricity", a bibliography entry, a survey night, and Carolina Sportsman's clock
 * flattened into a navigation line ("...Gift Subscription July 14, 2026 Search for: Home...").
 *
 * A stamp is a date whose line holds nothing else but a weekday and a byline ("Wednesday, Jul 08
 * 2026", "- by Jay - 25 February, 2026"); a date labelled Published, Updated, Posted or by a
 * byline; or the date that ends a heading ("## New size limits ... May 7, 2018"), the page's own
 * dated heading. Nothing counts characters: the rule reads what is written around the date.
 */
function isStamp(text, m) {
  const start = text.lastIndexOf('\n', m.index - 1) + 1;
  const endNl = text.indexOf('\n', m.index + m[0].length);
  const line = text.slice(start, endNl < 0 ? text.length : endNl);
  const before = text.slice(start, m.index);
  const after = text.slice(m.index + m[0].length, endNl < 0 ? text.length : endNl);
  if (/^(?:Published|Updated)/i.test(m[0])) return true;          // DATE_ANY's own labelled form
  if (ONLY.test(before + ' ' + after)) return true;
  if (LABEL.test(before) || BYLINE_LABEL.test(before)) return true;
  return /^\s*#/.test(line) && /^[\W_]*$/.test(after);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n) => String(n).padStart(2, '0');

/** {y, m, d} from a date written any way DATE_LINE or DATE_ANY accepts; y is null if unwritten. */
function parseDate(s) {
  const str = String(s || '');
  let m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(str);
  if (m) return { y: +m[1], m: +m[2], d: +m[3] };
  const mon = new RegExp(MONTH, 'i').exec(str);
  if (!mon) return null;
  const month = MONTHS.indexOf(mon[0].slice(0, 3).toLowerCase()) + 1;
  const after = str.slice(mon.index + mon[0].length);
  const before = str.slice(0, mon.index);
  const dayAfter = /^\s*(\d{1,2})\b/.exec(after);
  const dayBefore = /\b(\d{1,2})\s*$/.exec(before);
  const day = dayAfter ? +dayAfter[1] : dayBefore ? +dayBefore[1] : null;
  const year = /\b(\d{4})\b/.exec(dayAfter ? after.slice(dayAfter[0].length) : after);
  if (!month || !day) return null;
  return { y: year ? +year[1] : null, m: month, d: day };
}

const iso = ({ y, m, d }) => (y ? `${y}-${pad(m)}-${pad(d)}` : `--${pad(m)}-${pad(d)}`);
const mdKey = ({ m, d }) => m * 100 + d;

/**
 * The calendar days the fetch instant falls on anywhere on Earth (UTC-12 to UTC+14), so a page read
 * late in the evening Eastern and stamped with tomorrow's date is still caught. Carolina Sportsman
 * prints today's date as a line of its own above every article: read on 2026-09-25, its 2016
 * Wateree crappie article carried "September 25, 2026" and no other date. Used only to refuse a
 * date, never to give one.
 */
function fetchDays(fetchedAt) {
  const t = Date.parse(fetchedAt || '');
  if (!Number.isFinite(t)) return new Set();
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  return new Set([day(t - 12 * 3600e3), day(t), day(t + 14 * 3600e3)]);
}

/** The single year a string names, or null if it names none or several. */
function soleYear(s) {
  const ys = [...new Set((String(s || '').match(/\b(?:1[89]|20)\d{2}\b/g) || []))];
  return ys.length === 1 ? +ys[0] : null;
}

/**
 * The same normalisation extract.js's attributeToBlock() uses to find a quote in its text --
 * lower case, every run of non-alphanumerics one space -- kept with the offset each character
 * came from, so a hit maps back to a line of the page.
 */
function normalizedWithOffsets(text) {
  const chars = [];
  const at = [];
  let space = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i].toLowerCase();
    if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
      chars.push(c); at.push(i); space = false;
    } else if (!space) {
      chars.push(' '); at.push(i); space = true;
    }
  }
  return { norm: chars.join(''), at };
}
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Link targets are not text a quote could have been copied from: "[Dearal Rodgers](http://...) of
// Camden" is quoted as "Dearal Rodgers of Camden". extract.js uses this same function to read a
// link-heavy page; it never crosses a line, so the date lines stay where they were.
const delink = (text) => String(text || '')
  .replace(/!?\[([^\]]*)\]\((?:[^()\s]|\([^)\s]*\))*\)/g, '$1')
  .replace(/https?:\/\/\S+/g, ' ');

/**
 * Everything about one document that dating its facts needs, worked out once: extract.js dates
 * every fact of a document against the same text, and the Worker's CPU budget is milliseconds.
 */
function readPage(doc) {
  const text = delink(doc.text || doc.fullText || '');
  const title = String(doc.title || '');

  // THE SITE'S CLOCK is the page's FIRST stamped date, near the top, falling on a fetch day -- and
  // nothing else: a report's own entries and its title are never taken for it, even when one was
  // written the day the page was read. A clock flattened into a line of navigation is no stamp
  // and never reaches this; a clock on its own line from a page served out of a cache on another
  // day passes it, which nothing on the page can tell apart from a real date.
  const clock = fetchDays(doc.fetchedAt);
  const top = text.slice(0, TOP_OF_PAGE);
  const stamps = [...top.matchAll(DATE_ANY)].filter((m) => isStamp(text, m));
  const first = stamps[0];
  const firstDate = first && parseDate(first[0]);
  const clockAt = firstDate && firstDate.y && clock.has(iso(firstDate)) ? first.index : -1;

  // Every date line, in page order, with the offset where its line starts.
  const lines = [];
  let pos = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    const isClock = clockAt >= pos && clockAt <= pos + line.length;
    if (t && !isClock && DATE_LINE.test(t)) {
      const p = parseDate(t);
      if (p) lines.push({ at: pos, text: t, date: p });
    }
    pos += line.length + 1;
  }

  // The page's own date. A title that names one year and a month and day is a full date:
  // "AHQ INSIDER Lake Wateree (SC) 2026 Week 9 Fishing Report – Updated February 25".
  let page = null;
  const titleYear = soleYear(title);
  const inTitle = [...title.matchAll(DATE_ANY)].map((m) => parseDate(m[0])).find((p) => p && p.y);
  const titleMd = parseDate(title);
  if (inTitle) page = { date: inTitle, from: `page date in the title: "${title}"` };
  else if (titleYear && titleMd && !titleMd.y) {
    page = { date: { ...titleMd, y: titleYear }, from: `page date in the title: "${title}"` };
  }
  if (!page) {
    for (const m of stamps) {
      const p = parseDate(m[0]);
      if (p && p.y && m.index !== clockAt) { page = { date: p, from: `page date near the top: "${m[0].trim()}"` }; break; }
    }
  }
  // A year alone, from the title or else a heading on the page.
  let year = page?.date.y ? { y: page.date.y, from: page.from.replace(/^page date/, 'the page date') } : null;
  if (!year && titleYear) year = { y: titleYear, from: 'the title' };
  if (!year) {
    const heading = text.split('\n').find((l) => /^\s*#/.test(l) && soleYear(l));
    if (heading) year = { y: soleYear(heading), from: `the heading "${heading.trim().replace(/^#+\s*/, '')}"` };
  }
  if (!page && titleYear) page = { date: { y: titleYear }, from: `page date in the title: "${title}"`, yearOnly: true };

  return { text, lines, page, year, years: yearsOfBareLines(lines, page, year), index: null };
}

/**
 * The year of every date line that writes none, from THE ORDER OF THE PAGE ITSELF.
 *
 * A weekly report lists its entries newest first, so going down the page the month and day fall,
 * and where they rise instead -- October under January -- the year before has begun. A page that
 * lists oldest first rises, and a fall is the new year. Which way this page runs is what most of
 * its steps do; a page whose steps split evenly does not say, and its entries get no year.
 *
 * The walk gives each entry its year relative to the newest one; the newest takes its year from
 * the page's full date (the year before it, if its month and day come later in the calendar than
 * the page's -- a report does not describe a day after it was written), else from the year in
 * the title or a heading. "2026 Week 9" runs February 25 back to October 2: the Octobers are 2025.
 */
function yearsOfBareLines(lines, page, year) {
  const bare = lines.filter((l) => !l.date.y);
  const out = new Map();
  if (!bare.length) return out;
  const keys = bare.map((l) => mdKey(l.date));
  const downs = keys.slice(1).filter((k, i) => k < keys[i]).length;
  const ups = keys.slice(1).filter((k, i) => k > keys[i]).length;
  const why = (s) => bare.forEach((l) => out.set(l, { y: null, why: s }));
  if (downs && ups && downs === ups) {
    why('month and day only: the page\'s dated entries run neither newest-first nor oldest-first');
    return out;
  }
  const newestFirst = downs >= ups;
  const order = newestFirst ? bare : [...bare].reverse();   // newest first, either way
  const p = page?.date;
  let y;
  let from;
  if (p && p.y && p.m && p.d) {
    y = mdKey(order[0].date) <= mdKey(p) ? p.y : p.y - 1;
    from = page.from.replace(/^page date/, 'the page date');
  } else if (year) {
    y = year.y;
    from = year.from;
  } else {
    why('month and day only: no year is written on the page');
    return out;
  }
  order.forEach((l, i) => {
    if (i && mdKey(l.date) > mdKey(order[i - 1].date)) y -= 1;
    out.set(l, { y, why: `year from ${from}, counted back through the page's own ${newestFirst ? 'newest-first' : 'oldest-first'} order` });
  });
  return out;
}

function dateOfLine(line, pg) {
  const said = `date line above the quote: "${line.text}"`;
  if (line.date.y) return { textDate: iso(line.date), textDateFrom: said };
  const r = pg.years.get(line);
  return { textDate: iso({ ...line.date, y: r.y }), textDateFrom: `${said}; ${r.why}` };
}

function pageDate(pg) {
  if (!pg.page) return { textDate: null, textDateFrom: null };
  const p = pg.page.date;
  return { textDate: pg.page.yearOnly ? String(p.y) : iso(p), textDateFrom: pg.page.from };
}

/**
 * {textDate, textDateFrom} for a fact read out of `doc`. `textDate` is "YYYY-MM-DD", "YYYY" for a
 * page dated only by the year in its title, "--MM-DD" when the page writes no year, or null.
 * Pass the same `page` object for every fact of one document; it is filled in on first use.
 */
function textDateOf(fact, doc, page = null) {
  const pg = page || readPage(doc || {});
  const q = norm(fact && fact.quote);
  let offset = -1;
  if (q.length >= 12) {   // attributeToBlock's own floor for trusting a quote match
    if (!pg.index) pg.index = normalizedWithOffsets(pg.text);
    const hit = pg.index.norm.indexOf(q);
    if (hit >= 0) offset = pg.index.at[hit];
  }
  if (offset >= 0) {
    const above = pg.lines.filter((l) => l.at <= offset).pop();
    if (above) return dateOfLine(above, pg);
    return pageDate(pg);
  }
  // Not found on the page. On a page of dated entries it could be any of them, and the page's
  // date would be the newest entry's, not necessarily this one's.
  if (pg.lines.length) {
    return { textDate: null, textDateFrom: 'quote not found on a page of dated entries, so which entry it came from is not known' };
  }
  return pageDate(pg);
}

export { textDateOf, readPage, delink };
