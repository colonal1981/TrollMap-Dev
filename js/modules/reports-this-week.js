/**
 * reports-this-week.js -- years of fishing reports on this water, for this time of year, handed to the plan.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 11/6: "I am a fisherman... i am not a striper fisherman... I troll... if that means i catch stripers great,
 * if that means i catch largemouth still great... just knowing whether the fish are on the bottom, suspended or
 * feeding on bait on the surface helps... if the app can tell me that i should be throwing a certain type of topwater
 * bait in a certain area at a certain time i will do that... the one thing i am not going to do... is live bait in
 * freshwater on my kayak... i am not going to sit and work a grass flat or a bank for 8 hours".
 *
 * WHERE IT COMES FROM: Scripts/reports_step.py keeps one file per water beside its research profile
 * (lake_packages/<id>/reports.json): SCDNR's column and The Sumter Item's reprint (2004 on), AHQ's posts, Carolina
 * Sportsman, Georgia DNR's weekly blog, Santee Cooper Country, Bassmaster, the Lake Murray videos. Each statement
 * is a source's own words, dated, read for the fish, where they sat, the depths, the lures (bait apart), the time of
 * day and the places, on his chart. See claude/THE_REPORT_STATEMENT_CONTRACT_2026-11-05.md.
 *
 * WHAT HAPPENS HERE, at plan time, nothing stored (the contract's rule: "this week" is derived, never kept):
 *   askThisWeek()   reads the water's file through the gated /research/reports (his token from worker-auth.js),
 *                   and keeps every statement dated within three weeks either side of the plan's day, in any year
 *                   from 2008 (the cutoff offered 11/6, his to change; earlier ones are counted, not used), trimmed;
 *   thisWeekBlock() writes the plan's block for the species he picked: where the fish sat, how deep, the kinds of
 *                   water, the named places with their positions, the lures (and which ones the reports troll), the
 *                   time of day, and the guides' own words, dated. Bait is struck; a bait report still says where.
 */

import { workerAuthOnly } from '../utils/worker-auth.js';

export const WINDOW_DAYS = 21;
export const SINCE_YEAR = 2008;
export const MAX_KEPT = 2000;   // a safety cap: the counts read every report in the window; the plan saves only the block

const DAY = 86400000;
const doy = (y, m, d) => (Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / DAY;

/** Days between two dates' places in the year, either way round the new year. */
function yearGap(a, b) {
  const g = Math.abs(a - b);
  return Math.min(g, 365 - g);
}

/** Does a statement dated `date` ('YYYY-MM-DD' or 'YYYY-MM') fall within `days` of the plan's day of the year? */
export function inWindow(date, planDate, days = WINDOW_DAYS) {
  const p = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(planDate || ''));
  const s = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(String(date || ''));
  if (!p || !s) return false;
  const pd = doy(+p[1], +p[2], +p[3]);
  if (s[3]) return yearGap(doy(+s[1], +s[2], +s[3]), pd) <= days;
  // a month alone counts when any day of it is in the window
  const first = doy(+s[1], +s[2], 1), last = doy(+s[1], +s[2], 28);
  return yearGap(first, pd) <= days || yearGap(last, pd) <= days || (first <= pd && pd <= last);
}

const usefulness = (s) => (s.way.length ? 8 : 0) + (s.lu.length ? 4 : 0) + (s.pos.length ? 3 : 0)
  + (s.dep.length ? 2 : 0) + (s.pl.length ? 2 : 0) + (s.tm.length ? 1 : 0);

/** A report's words up to `n` characters, ended at a word, with the cut shown. */
const cut = (t, n) => (t.length <= n ? t : `${t.slice(0, t.lastIndexOf(' ', n) > n * 0.6 ? t.lastIndexOf(' ', n) : n)}...`);

/** One statement, trimmed to what the plan reads. */
export function trim(s) {
  const sent = s.sentences || [];
  return {
    d: s.date, src: s.source, sp: s.species || [], t: cut(String(s.text || ''), 480),
    who: s.who || [], lu: s.lures || [], bait: s.bait || [], tm: s.time_of_day || [],
    way: [...new Set(sent.flatMap((x) => x.his_way || []))],
    pos: [...new Set(sent.flatMap((x) => x.fish || []))],
    dep: (s.depths || []).map((x) => ({ ft: x.ft, k: x.kind })),
    pl: (s.places || []).map((p) => ({ n: p.name, lon: p.lon, lat: p.lat, ...(p.far_apart ? { far: true } : {}),
                                       ...(p.approx ? { approx: true } : {}) })),
    ar: s.area || [], kw: s.kinds_of_water || [], f: s.water_temp_f_said ?? null,
  };
}

/** The statements for this time of year, most useful first, with what was left out counted. */
export function pickThisWeek(statements, planDate, { days = WINDOW_DAYS, since = SINCE_YEAR, max = MAX_KEPT } = {}) {
  const near = (statements || []).filter((s) => inWindow(s.date, planDate, days));
  const older = near.filter((s) => +String(s.date).slice(0, 4) < since).length;
  const kept = near.filter((s) => +String(s.date).slice(0, 4) >= since).map(trim)
    .sort((a, b) => usefulness(b) - usefulness(a) || String(b.d).localeCompare(String(a.d)));
  const years = new Set(kept.map((s) => String(s.d).slice(0, 4)));
  return { planDate, days, since, total: (statements || []).length, near: near.length, older,
           years: years.size, statements: kept.slice(0, max), cut: Math.max(0, kept.length - max) };
}

/**
 * Which report fish a plan's species means. The app's names ("Striped Bass", "Largemouth Bass", "Crappie", "Blue
 * Catfish") to the contract's (report_contract.SPECIES). Nothing picked: every fish.
 */
export function reportFish(species) {
  const want = new Set();
  for (const raw of [].concat(species || [])) {
    const n = String(raw && (raw.name || raw.label || raw.id) || raw).toLowerCase();
    if (/striper|striped/.test(n)) { want.add('striped bass'); want.add('hybrid striped bass'); }
    if (/hybrid/.test(n)) want.add('hybrid striped bass');
    if (/white bass/.test(n)) want.add('white bass');
    if (/largemouth|black bass|^bass$/.test(n)) { want.add('largemouth bass'); want.add('black bass'); }
    if (/spot/.test(n)) { want.add('spotted bass'); want.add('black bass'); }
    if (/smallmouth/.test(n)) { want.add('smallmouth bass'); want.add('black bass'); }
    if (/crappie/.test(n)) want.add('crappie');
    if (/cat/.test(n)) want.add('catfish');
    if (/bream|bluegill|sunfish|redear|shellcracker/.test(n)) { want.add('bream'); want.add('shellcracker'); }
    if (/white perch/.test(n)) want.add('white perch');
    if (/yellow perch/.test(n)) want.add('yellow perch');
    if (/trout/.test(n)) want.add('trout');
    if (/walleye/.test(n)) want.add('walleye');
  }
  return want;
}

const count = (arr) => {
  const m = new Map();
  for (const x of arr) m.set(x, (m.get(x) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
const list = (pairs, n = 8) => pairs.slice(0, n).map(([k, v]) => `${k} ${v}`).join(', ');
const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))]; };
function band(dep, kind) {
  const ft = dep.filter((x) => x.k === kind).flatMap((x) => (x.ft.length === 2 ? [(x.ft[0] + x.ft[1]) / 2] : x.ft));
  if (!ft.length) return null;
  return { n: ft.length, lo: Math.round(pct(ft, 0.25)), hi: Math.round(pct(ft, 0.75)), mid: Math.round(pct(ft, 0.5)) };
}

const bandText = (b) => (b.n === 1 ? `${b.mid} ft (one figure)`
  : `middle ${b.mid} ft, ${b.lo === b.hi ? `most at ${b.lo} ft` : `most ${b.lo}-${b.hi} ft`} (${b.n} figures)`);

/** What the picked statements say for one fish: counts the plan and the card can both read. */
export function summarize(tw, fishSet) {
  const st = (tw && tw.statements || []).filter((s) => !fishSet || !fishSet.size || s.sp.some((x) => fishSet.has(x)));
  const places = new Map();
  for (const s of st) for (const p of s.pl) {
    const e = places.get(p.n) || { name: p.n, lon: p.lon, lat: p.lat, n: 0, far: !!p.far };
    e.n += 1; places.set(p.n, e);
  }
  const lures = new Map();
  for (const s of st) for (const l of s.lu) {
    const e = lures.get(l) || { lure: l, n: 0, trolled: 0, times: [] };
    e.n += 1; if (s.way.includes(l)) e.trolled += 1; e.times.push(...s.tm); lures.set(l, e);
  }
  return {
    n: st.length,
    sources: count(st.map((s) => s.src)),
    position: count(st.flatMap((s) => s.pos)),
    fishDepth: band(st.flatMap((s) => s.dep), 'fish'),
    waterDepth: band(st.flatMap((s) => s.dep), 'water'),
    kinds: count(st.flatMap((s) => s.kw)),
    areas: count(st.flatMap((s) => s.ar)),
    places: [...places.values()].sort((a, b) => b.n - a.n),
    lures: [...lures.values()].sort((a, b) => b.n - a.n).map((e) => ({ ...e, times: count(e.times) })),
    times: count(st.flatMap((s) => s.tm)),
    baitOnly: st.filter((s) => s.bait.length && !s.lu.length).length,
    temps: st.map((s) => s.f).filter((f) => Number.isFinite(f)),
    // the most useful first, no more than two from one year, so one season does not speak for all of them
    quotes: (() => {
      const per = new Map(), out = [];
      for (const s of st) {
        if (!(s.lu.length || s.pos.length || s.dep.length || s.pl.length)) continue;
        const y = String(s.d).slice(0, 4);
        if ((per.get(y) || 0) >= 2) continue;
        per.set(y, (per.get(y) || 0) + 1); out.push(s);
        if (out.length >= 10) break;
      }
      return out;
    })(),
  };
}

/** A source as the plan and the map print it; his own pastes say so (report_pasted.py, 11/6). */
export const srcName = (src) => (src === 'PASTED' ? 'Pasted by Ryan' : src);

const NAMES = { 'striped bass': 'Stripers', 'hybrid striped bass': 'Hybrids', 'black bass': 'Bass', 'largemouth bass': 'Largemouth',
  'spotted bass': 'Spotted bass', 'smallmouth bass': 'Smallmouth', crappie: 'Crappie', catfish: 'Catfish', bream: 'Bream',
  shellcracker: 'Shellcracker', 'white perch': 'White perch', 'yellow perch': 'Yellow perch', trout: 'Trout', 'white bass': 'White bass' };

/**
 * THE PLACES THE REPORTS NAME FOR THIS TIME OF YEAR, for the map (report-spots-layer.js): one per named place, with how
 * many reports name it and, fish by fish, where they sat, the lures (and which are trolled), the time of day, the depths
 * and the guides' own words. Every fish: he takes whatever bites (11/6). Most-named first. Pure.
 */
export function placesThisWeek(tw) {
  const by = new Map();
  for (const s of (tw && tw.statements) || []) {
    for (const p of s.pl) {
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
      const e = by.get(p.n) || { name: p.n, lat: p.lat, lon: p.lon, far: !!p.far, approx: !!p.approx, st: [] };
      if (!e.st.includes(s)) e.st.push(s);
      by.set(p.n, e);
    }
  }
  return [...by.values()].map((e) => {
    const fish = count(e.st.flatMap((s) => s.sp)).map(([f, n]) => {
      const S = summarize({ statements: e.st }, new Set([f]));
      return { fish: f, name: NAMES[f] || f, n, position: S.position, lures: S.lures.map((l) => ({ lure: l.lure, n: l.n, trolled: l.trolled })),
               times: S.times, fishDepth: S.fishDepth, waterDepth: S.waterDepth, baitOnly: S.baitOnly };
    });
    const years = [...new Set(e.st.map((s) => String(s.d).slice(0, 4)))].sort();
    const quotes = summarize({ statements: e.st }, null).quotes.slice(0, 3)
      .map((q) => ({ d: q.d, src: srcName(q.src), who: q.who, t: q.t }));
    return { name: e.name, lat: e.lat, lon: e.lon, far: e.far, approx: e.approx, n: e.st.length,
             years: years.length ? `${years[0]}-${years[years.length - 1]}` : '', fish, quotes };
  }).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}

const M_PER_DEG = 111320;
/** Metres between two [lon, lat], as the crow flies. */
export function crowM(a, b) {
  const kx = M_PER_DEG * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  return Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * M_PER_DEG);
}

/**
 * WHERE THE REPORTS SAY TO FISH, as turns for the day's loops (plan-water-ui.js trollForMe). Ryan, 11/6: "the entire
 * point of this was to fix the fact that the app has no idea what actual water use unless i have catches", and "even
 * with catches i dont like it... because i am telling the app where to tell me to fish instead of the app telling me".
 *
 * The places the reports name within three weeks of the day in any year from 2008 (placesThisWeek), counted for his
 * fish -- or, where no report names a place for it, for any fish, said so. Only those within `reachM` of the ramp as
 * the crow flies (the loop then measures by water and says which it cannot reach). Most-named first, at least `apartM`
 * apart, at most `max` (a day is at most four loops). The depth is the water those reports put his fish over, this
 * time of year, lake-wide. Pure.
 */
// THE WATER IS LONGER THAN THE CROW: a loop out to a place and back runs round points and up the channel. Measured 11/6
// on Murray from the Dreher Island tournament ramp: Buffalo Creek is 7 km as the crow flies and its loop trolled 22.8 km.
export const WATER_OVER_CROW = 1.6;

export function turnsFromReports(tw, species, { ramp = null, reachM = Infinity, budgetM = null, max = 4, apartM = 1000 } = {}) {
  // A DAY THAT FITS (11/6, the same Murray try): every turn is a loop out from the ramp and back, so the turns taken
  // must fit the day between them, not each on its own. The first Murray day took one loop to Buffalo Creek, 428
  // minutes of a 360-minute day, and reached none of the other three.
  const dayM = Number.isFinite(budgetM) ? budgetM : 2 * reachM;
  const places = placesThisWeek(tw);
  const want = reportFish(species);
  const forFish = (p, all) => p.fish.filter((f) => all || want.has(f.fish));
  const pick = (all) => {
    const ranked = places.map((p) => ({ p, fish: forFish(p, all) }))
      .map((x) => ({ ...x, n: x.fish.reduce((a, f) => a + f.n, 0) }))
      .filter((x) => x.n > 0 && (!ramp || crowM(ramp, [x.p.lon, x.p.lat]) <= reachM))
      .sort((a, b) => b.n - a.n || b.p.n - a.p.n || a.p.name.localeCompare(b.p.name));
    const out = [];
    let used = 0;
    for (const x of ranked) {
      if (out.length >= max) break;
      if (out.some((y) => crowM([y.p.lon, y.p.lat], [x.p.lon, x.p.lat]) < apartM)) continue;
      const cost = ramp ? 2 * crowM(ramp, [x.p.lon, x.p.lat]) * WATER_OVER_CROW : 0;
      if (ramp && used + cost > dayM) continue;
      used += cost;
      out.push(x);
    }
    return out;
  };
  // a fish he picked that no report names (Bowfin), or one with no place near: the places for any fish, said so
  const asked = [].concat(species || []).filter(Boolean).length > 0;
  let anyFish = false;
  let chosen = want.size ? pick(false) : [];
  if (!chosen.length) { chosen = pick(true); anyFish = chosen.length > 0 && asked; }
  const fishSet = anyFish || !want.size ? null : want;
  const S = summarize(tw, fishSet);
  const turns = chosen.map(({ p, fish, n }) => {
    const said = fish.map((f) => {
      const bits = [f.position.length ? `${f.position.slice(0, 2).map(([w, k]) => `${w} ${k}`).join(', ')}` : '',
        f.lures.filter((l) => l.trolled).slice(0, 2).map((l) => `${l.lure} trolled ${l.trolled}`).join(', '),
        f.times.length ? f.times.slice(0, 2).map(([w, k]) => `${w} ${k}`).join(', ') : ''].filter(Boolean);
      return `${f.name} ${f.n}${bits.length ? ` (${bits.join('; ')})` : ''}`;
    }).join('; ');
    return { at: [p.lon, p.lat], name: p.name, n, total: p.n, years: p.years, far: p.far, approx: p.approx,
             why: `${p.name}: ${n} report${n === 1 ? '' : 's'} within ${tw.days} days of this date (${p.years})`
               + `${said ? ` — ${said}` : ''}${p.far ? '. The chart prints this name in more than one spot' : ''}` };
  });
  return { turns, anyFish, waterFt: S.waterDepth ? [S.waterDepth.lo, S.waterDepth.hi] : null,
           waterN: S.waterDepth ? S.waterDepth.n : 0, places: places.length };
}

/**
 * WHICH RAMP, BY THE REPORTS (item 78, "the ramp is chosen with it"; Ryan, 11/6: "how does this help me figure out which
 * ramp i should actually launch from"). Every landing on the water his ramp launches onto, scored by the reports that
 * name places for his fish this time of year within a day's reach of it (turnsFromReports from each). Best first. The
 * ramp he picked is marked; `better` is the best one when it has clearly more than his (at least two reports more, and
 * a half again as many), else null. A heads-up with its reason, never a block. Pure.
 */
export function rampsByReports(tw, species, landings, { reachM = Infinity, budgetM = null, current = null, nearM = 150 } = {}) {
  const seen = [];
  const rows = (landings || []).filter((l) => l && Number.isFinite(Number(l.lon)) && Number.isFinite(Number(l.lat)))
    // one row a landing: a list can carry the same ramp more than once
    .filter((l) => { const at = [Number(l.lon), Number(l.lat)]; if (seen.some((a) => crowM(a, at) < 50)) return false; seen.push(at); return true; })
    .map((l) => {
      const at = [Number(l.lon), Number(l.lat)];
      const r = turnsFromReports(tw, species, { ramp: at, reachM, budgetM });
      return { name: l.name || l.label || 'a landing', at, score: r.turns.reduce((a, t) => a + t.n, 0),
               spots: r.turns.map((t) => ({ name: t.name, n: t.n })), anyFish: r.anyFish,
               isCurrent: !!(current && crowM(current, at) <= nearM) };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  let mine = rows.find((r) => r.isCurrent) || null;
  if (!mine && current) {
    const r = turnsFromReports(tw, species, { ramp: current, reachM, budgetM });
    mine = { name: 'your ramp', at: current, score: r.turns.reduce((a, t) => a + t.n, 0), spots: r.turns.map((t) => ({ name: t.name, n: t.n })), isCurrent: true };
  }
  const top = rows.find((r) => !r.isCurrent);
  const better = top && mine && top.score >= mine.score + 2 && top.score >= mine.score * 1.5 ? top : null;
  return { rows, mine, better };
}

/** One fish's lines. `full` adds the reports' own words; a fish he did not pick gets the facts only. */
function fishLines(tw, f, full, quotes = 6) {
  const S = summarize(tw, new Set([f]));
  if (!S.n) return [];
  const L = ['', `${NAMES[f] || f}: ${S.n} reports (${list(S.sources.map(([k, n]) => [srcName(k), n]), 6)}).`];
  if (S.position.length) L.push(`  Where they sat: ${list(S.position)}.`);
  if (S.fishDepth) L.push(`  Fish depth stated: ${bandText(S.fishDepth)}.`);
  if (S.waterDepth) L.push(`  Water depth they fished over: ${bandText(S.waterDepth)}.`);
  if (S.kinds.length) L.push(`  Kinds of water: ${list(S.kinds)}.`);
  if (S.areas.length) L.push(`  Parts of the lake: ${list(S.areas)}.`);
  if (S.places.length) {
    L.push(`  Named places: ${S.places.slice(0, full ? 10 : 5).map((p) => `${p.name} ${p.n} (${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`
      + `${p.far ? ', far apart' : ''})`).join('; ')}.`);
  }
  if (S.lures.length) {
    L.push(`  Lures: ${S.lures.slice(0, full ? 10 : 5).map((l) => `${l.lure} ${l.n}${l.trolled ? ` (trolled ${l.trolled})` : ''}`
      + `${l.times.length ? ` [${l.times.slice(0, 2).map(([t, n]) => `${t} ${n}`).join(', ')}]` : ''}`).join('; ')}.`);
  }
  if (S.times.length) L.push(`  Time of day named: ${list(S.times)}.`);
  if (S.baitOnly) L.push(`  ${S.baitOnly} of these fished bait only: read them for where and how deep.`);
  if (S.temps.length) L.push(`  Water temperature the reports gave: ${Math.min(...S.temps)}-${Math.max(...S.temps)} F.`);
  if (full) for (const q of S.quotes.slice(0, quotes)) L.push(`  - ${q.d} ${srcName(q.src)}${q.who.length ? ` (${q.who.join(', ')})` : ''}: "${q.t}"`);
  return L;
}

/**
 * The prompt block. '' when nothing was asked; a sentence when the file could not be read or holds nothing for this
 * time of year, because "no reports" and "could not read them" are different things for the plan to say. A saved
 * plan's (forSaving) is printed as it was read.
 *
 * The fish he picked come first with the reports' own words; up to three others the reports name this time of year
 * follow with the facts only, because he fishes for whatever bites (11/6).
 */
export function thisWeekBlock(tw, species, planDate) {
  if (!tw) return '';
  if (typeof tw.block === 'string') return tw.block;
  const head = '\nWHAT YEARS OF FISHING REPORTS SAY FOR THIS TIME OF YEAR\n';
  if (tw.error) return `${head}The reports kept for this water could not be read today (${tw.error}). Say so in \`scoutNotes\`.\n`;
  if (tw.none) return `${head}No fishing reports are kept for this water yet.\n`;
  if (!tw.statements || !tw.statements.length) {
    return `${head}No report kept for this water falls within ${tw.days || WINDOW_DAYS} days of ${planDate || 'the day planned'} in any year from ${tw.since || SINCE_YEAR}.\n`;
  }
  const asked = [].concat(species || []).filter(Boolean);
  const want = reportFish(asked);
  const all = count(tw.statements.flatMap((s) => s.sp)).map(([k]) => k);
  const picked = all.filter((k) => want.has(k));
  // nothing picked, or nothing the reports name: the three fish they say most about, in full
  const main = picked.length ? picked : all.slice(0, 3);
  const others = all.filter((k) => !main.includes(k)).slice(0, 3);
  const L = [head.trimEnd()];
  L.push(`${tw.near} reports on this water fall within ${tw.days} days of this date in other years; ${tw.statements.length} from ${tw.since} on `
    + `are read here (${tw.years} years${tw.older ? `; ${tw.older} older ones not used` : ''}${tw.cut ? `; ${tw.cut} less useful ones cut` : ''}). `
    + 'They are history for this time of year, not a report of today: weigh them under any current report above, and against his own fish.');
  L.push('Ryan trolls, for whatever bites, and fishes NO live bait on fresh water. A report that used bait still says where the fish were, '
    + 'how deep and when: use that, never the bait. A short casting stop is welcome where the reports put fish at a place and time '
    + '(a topwater bite at first light on points, schooling fish on top); never a day spent working one bank or flat.');
  L.push('"Trolled" counts the reports that troll that lure; the times in brackets are when the reports that name it were fishing it. '
    + 'A named place carries its position on his chart; one marked "far apart" is a name the chart prints in more than one spot.');
  if (asked.length && !picked.length) {
    L.push(`None of these reports names ${asked.join(' or ')}; below are the fish they say most about.`);
  }
  // his picks in full; with more than three picked, fewer of each one's own words, so the block stays readable
  for (const f of main) L.push(...fishLines(tw, f, true, main.length > 3 ? 3 : 6));
  if (others.length) {
    L.push('', `ALSO IN THESE REPORTS, this time of year (he takes whatever bites on his way):`);
    for (const f of others) L.push(...fishLines(tw, f, false));
  }
  return `${L.join('\n')}\n`;
}

/**
 * What a saved plan keeps: the counts and the block exactly as the plan read it, not the statements (some hundreds of
 * them, which the trip report does not need and a synced plan should not carry).
 */
export function forSaving(tw, species, planDate) {
  if (!tw) return null;
  const { statements, ...rest } = tw;
  return { ...rest, kept: (statements || []).length, block: thisWeekBlock(tw, species, planDate) };
}

/**
 * Read the water's reports and pick this time of year. Never throws: `{error}` when the file cannot be read. A water
 * with no file (not one of the SC waters yet) answers `{none}`.
 */
export async function askThisWeek({ worker, slug, date, fetchImpl, timeoutMs = 30000 } = {}) {
  if (!worker || !slug || !date) return null;
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) return { error: 'no fetch' };
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    // His own Worker, and only it, gets the token (worker-auth.js): the route is gated like the save.
    const workerBase = String(worker).replace(/\/+$/, '');
    const r = await f(`${workerBase}/research/reports?water=${encodeURIComponent(slug)}`,
      { headers: workerAuthOnly(), ...(ctl ? { signal: ctl.signal } : {}) });
    if (r && r.status === 404) return { none: `no reports kept for ${slug}`, statements: [], days: WINDOW_DAYS, since: SINCE_YEAR };
    if (!r || !r.ok) return { error: `the Worker answered HTTP ${r ? r.status : '?'}` };
    const body = await r.json();
    return pickThisWeek(body.statements || [], date);
  } catch (e) {
    return { error: e && e.name === 'AbortError' ? `no answer in ${Math.round(timeoutMs / 1000)} s` : String((e && e.message) || e) };
  } finally {
    if (t) clearTimeout(t);
  }
}
