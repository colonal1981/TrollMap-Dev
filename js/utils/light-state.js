/**
 * light-state.js — WHAT THE LIGHT IS AT A GIVEN MOMENT OF A GIVEN DAY ON A GIVEN WATER.
 *
 * Ryan, 2026-09-14, correcting the way I had written the problem up: *"we need to be careful with
 * just saying hour blindness... it really is light blindness... meaning if it was an overcast day
 * then topwater all day might be ok... i still say might because you just never know with fish"*.
 *
 * That is the whole design in two sentences. The CLOCK is only an index into the light. What makes
 * a bite a low-light bite is the light, and the light is set by two measured things: where the sun
 * is, which the almanac answers exactly, and what the sky is doing, which the forecast answers
 * hour by hour.
 *
 * And then, asked to make the app light aware for the whole day rather than at the launch:
 * *"lets go ahead and make sure that the app is light aware through out the whole day... so that
 * techniques that work in low light or colors that should be used during low light are known"*.
 *
 * ── WHAT THIS REPLACED ──────────────────────────────────────────────────────────────────────────
 *
 * species-intel.js carried the opposite of this:
 *
 *     export function getTimeOfDay(launchTimeStr) {
 *       const hour = parseInt(String(launchTimeStr).split(':')[0], 10);
 *       if (hour < 8)  return TOD.DAWN;
 *       if (hour < 17) return TOD.DAY;
 *       if (hour < 20) return TOD.DUSK;
 *       return TOD.NIGHT;
 *     }
 *
 * Four invented numbers, no almanac, no sky, and read off the LAUNCH time — so it answered once
 * for a nine-hour day and called 07:59 in December dawn and 08:01 in June day. Nothing imported
 * it, which is the only reason it never did any harm. It is gone.
 *
 * ── NOTHING HERE IS A NUMBER SOMEBODY CHOSE ─────────────────────────────────────────────────────
 *
 * The boundaries are civil twilight and sunrise/sunset from USNO, carried by water-conditions.js,
 * which has said why since it was written: *"CIVIL TWILIGHT, NOT SUNRISE. The fishing day starts
 * when you can see to launch and ends when you cannot"*.
 *
 * "The sky is not letting the light through" is a set of WMO weather codes, which is what those
 * words MEAN in the code table Open-Meteo answers in — overcast is 3, fog is 45 and 48, and
 * everything from 51 up is falling out of the sky. It is not a cloud percentage compared against
 * a number, because no such number exists anywhere that could be cited. The percentage travels
 * alongside as the fact it is, exactly as hourlyWeather() hands it over: *"Kept as the number
 * Open-Meteo sent -- no band, no label. Whoever reads it decides what counts as overcast, and this
 * file is not that reader."* This file is that reader.
 *
 * ── ABSENT IS ABSENT ────────────────────────────────────────────────────────────────────────────
 *
 * With no almanac there is no answer and `lightAt` returns null, the same rule lightPromptBlock has
 * always followed: a guess about first light is worse than no sentence about it. With an almanac
 * and no sky, the state resolves and `low` is decided by the sun alone, and `skyKnown` says so, so
 * no reader can mistake a missing forecast for a clear one.
 */

// THE ONE LIST OF WORDS THAT MEAN LIGHT, because two readers need it and they must not drift.
//
// Ryan enumerated it himself, 2026-09-05, on what a source actually says: *"its not going to say
// at 6am... early morning... dawn... first thing... first light... midday... evening... overcast
// vs daylight"*. A research fact and a lure's recorded technique are both free text written by
// somebody else, and the only way to find the light in them is to look for these words. Having one
// lexicon rather than a regex at each call site is what keeps the two answers the same answer.
//
// EACH PHRASE CARRIES WHICH LIGHT IT MEANS, and that pairing is a dictionary fact rather than a
// fishing one: "dawn" means low light in English, and saying so commits the app to no claim about
// fish. What it must NOT do is put a number on any of it -- there is no threshold here, only which
// of the three lights a phrase is talking about.
//
//   'low'    — the light is down, by hour or by sky
//   'bright' — the middle of a clear day, said as such
//   'night'  — after dark, which is neither of the other two and is not something Ryan fishes
export const LIGHT_PHRASES = {
  'first light': 'low', daybreak: 'low', dawn: 'low', sunup: 'low', sunrise: 'low',
  'early morning': 'low', 'early and late': 'low', 'first thing': 'low', 'crack of day': 'low',
  dusk: 'low', sundown: 'low', sunset: 'low', 'last light': 'low', evening: 'low',
  twilight: 'low', nightfall: 'low',
  overcast: 'low', cloudy: 'low', 'cloud cover': 'low', 'low light': 'low', 'low-light': 'low',
  shade: 'low', shaded: 'low',
  midday: 'bright', 'mid-day': 'bright', 'middle of the day': 'bright', 'high sun': 'bright',
  'bright sun': 'bright', 'full sun': 'bright', sunny: 'bright',
  'after dark': 'night', 'at night': 'night', night: 'night', nocturnal: 'night',
};

/** Which of the three lights a phrase means, or null for a phrase not in the lexicon. */
export function lightKindOf(phrase) {
  return LIGHT_PHRASES[String(phrase || '').toLowerCase()] || null;
}

// Longest first, so 'first light' is found before 'light' would be and 'early morning' before
// 'morning'. Word-boundaried, because 'night' must not match inside 'nightcrawler'.
const PHRASE_RE = new RegExp(
  `\\b(${Object.keys(LIGHT_PHRASES).sort((a, b) => b.length - a.length)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'gi');

/**
 * Every light phrase in a piece of free text, lowercased and de-duplicated, in the order found.
 * Empty array when there are none — which is the common case and is not a failure.
 */
export function lightPhrasesIn(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  for (const m of text.matchAll(PHRASE_RE)) {
    const p = m[1].toLowerCase();
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

// ── the clock ────────────────────────────────────────────────────────────────────────────────────

/** 'HH:MM' or 'HH:MM:SS' -> decimal hours. Anything else -> null. */
export function hhmmToHours(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t == null ? '' : t).trim());
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (!Number.isFinite(h) || !Number.isFinite(mi) || h > 24 || mi > 59) return null;
  return h + mi / 60;
}

/** Decimal hours -> 'HH:MM', for putting a computed boundary back into a sentence. */
export function hoursToHhmm(x) {
  if (!Number.isFinite(x)) return '';
  const t = ((x % 24) + 24) % 24;
  const h = Math.floor(t + 1e-9);
  const m = Math.round((t - h) * 60);
  return m === 60 ? `${String((h + 1) % 24).padStart(2, '0')}:00`
                  : `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * The four boundaries of the day as decimal hours, off the water state's almanac.
 *
 * Returns null when there is nothing to work with. `partial` is true when sunrise and sunset are
 * known but civil twilight is not: the middle of the day is then answerable and the ends are not,
 * and every caller has to be able to tell that apart from a complete answer.
 */
export function lightWindows(ws) {
  if (!ws || ws.error) return null;
  const dawn = hhmmToHours(ws.civilDawn);
  const rise = hhmmToHours(ws.sunrise);
  const set = hhmmToHours(ws.sunset);
  const dusk = hhmmToHours(ws.civilDusk);
  if (rise == null && set == null && dawn == null && dusk == null) return null;
  return { dawn, rise, set, dusk, partial: !(dawn != null && dusk != null) };
}

// ── the sky ──────────────────────────────────────────────────────────────────────────────────────

/**
 * WHETHER THE SKY IS LETTING THE LIGHT THROUGH, from the WMO code and nothing else.
 *
 * 3 is overcast. 45 and 48 are fog. 51 and up is drizzle, rain, snow, showers or thunder — all of
 * them mean cloud thick enough to be raining out of, so a thunderstorm at noon is not full
 * daylight and the old `code === 3` test called it that. 0, 1 and 2 are clear, mainly clear and
 * partly cloudy, and none of those dims a day.
 */
export function skyDims(code) {
  const c = Number(code);
  if (!Number.isFinite(c)) return null;
  return c === 3 || c === 45 || c === 48 || c >= 51;
}

/** What the sky code says in words, for a sentence. Null when the code is not one we name. */
export function skyWord(code) {
  const c = Number(code);
  if (!Number.isFinite(c)) return null;
  if (c === 0) return 'clear';
  if (c === 1) return 'mainly clear';
  if (c === 2) return 'partly cloudy';
  if (c === 3) return 'overcast';
  if (c === 45 || c === 48) return 'fog';
  if (c >= 95) return 'thunderstorm';
  if (c >= 80) return 'showers';
  if (c >= 71 && c <= 77) return 'snow';
  if (c >= 51) return 'rain';
  return null;
}

/** The forecast row for a whole hour, by the hour number hourlyWeather() keys on. */
export function skyAt(weatherByHour, hour) {
  const h = Math.floor(Number(hour));
  if (!Array.isArray(weatherByHour) || !Number.isFinite(h)) return null;
  return weatherByHour.find((w) => w && Number(w.hour) === h) || null;
}

// ── the answer ───────────────────────────────────────────────────────────────────────────────────

/**
 * THE LIGHT AT ONE MOMENT. `{ state, low, ... }`, or null when the almanac is missing.
 *
 * `state` is the sun: 'dark', 'first light', 'daylight', 'last light', or null where only sunrise
 * and sunset are known and the moment falls outside them.
 *
 * `low` is the thing a presentation actually turns on, and it is EITHER cause: twilight, or a sky
 * the light is not getting through. That is Ryan's correction made into one boolean — *"if it was
 * an overcast day then topwater all day might be ok"* — and `why` always names which cause it was,
 * so no reader has to take the boolean on trust.
 */
export function lightAt(ws, weatherByHour, at) {
  const w = lightWindows(ws);
  const t = typeof at === 'number' ? at : hhmmToHours(at);
  if (!w || t == null) return null;

  let state = null;
  if (w.rise != null && w.set != null && t >= w.rise && t < w.set) state = 'daylight';
  else if (w.dawn != null && w.rise != null && t >= w.dawn && t < w.rise) state = 'first light';
  else if (w.set != null && w.dusk != null && t >= w.set && t < w.dusk) state = 'last light';
  else if (w.dawn != null && w.dusk != null && (t < w.dawn || t >= w.dusk)) state = 'dark';

  const sky = skyAt(weatherByHour, Math.floor(t));
  const dims = sky ? skyDims(sky.code) : null;
  const word = sky ? skyWord(sky.code) : null;
  const cloudPct = sky && sky.cloudPct != null ? Number(sky.cloudPct) : null;

  const sunLow = state === 'first light' || state === 'last light' || state === 'dark';
  const low = sunLow || dims === true;

  const why = [];
  if (state === 'first light') why.push(`civil dawn ${ws.civilDawn} to sunrise ${ws.sunrise}`);
  else if (state === 'last light') why.push(`sunset ${ws.sunset} to civil dusk ${ws.civilDusk}`);
  else if (state === 'dark') why.push('outside civil twilight');
  else if (state === 'daylight') why.push(`sunrise ${ws.sunrise} to sunset ${ws.sunset}`);
  if (word) why.push(`${word}${cloudPct != null ? ` (${cloudPct}% cloud)` : ''}, WMO ${sky.code}`);
  else why.push('no sky forecast for this hour');

  return {
    state,
    low,
    lowBySun: sunLow,
    lowBySky: dims === true,
    skyKnown: !!sky,
    skyWord: word,
    cloudPct,
    code: sky && sky.code != null ? Number(sky.code) : null,
    at: hoursToHhmm(t),
    why: why.join('; '),
    partialAlmanac: w.partial,
  };
}

/**
 * ONE ROW PER HOUR OF THE TRIP, already resolved.
 *
 * lightPromptBlock used to hand the model two lists — the twilight boundaries, and the cloud
 * percentage for each hour — and leave it to work out which hours were low light. It is the same
 * shape as the time budget, where the model *"was handed '06:00' and '15:00' and left to do the
 * arithmetic, and it does not do the arithmetic"*. So the arithmetic is done here.
 */
export function lightTimeline(ws, weatherByHour, launchTime, returnTime) {
  const w = lightWindows(ws);
  const lo = hhmmToHours(launchTime);
  const hi = hhmmToHours(returnTime);
  if (!w || lo == null || hi == null || hi <= lo) return [];

  // SAMPLED AT THE MOMENTS THE ANSWER CAN CHANGE, NOT ON THE HOUR.
  //
  // The first draft of this walked whole hours and it lost first light completely on the very case
  // it was written for: a 06:30 launch with civil dawn at 06:32 and sunrise at 06:58 reported
  // "dark at 06:00, daylight at 07:00" -- the twenty-six minutes of first light fell inside hour 6
  // and hour 6 had already been sampled at 06:30, two minutes before it started. An hourly sample
  // cannot see a boundary that sits inside an hour, and every one of these boundaries sits inside
  // an hour.
  //
  // So the samples are the launch, every hour mark the trip crosses (that is where the SKY changes,
  // because the forecast is hourly), and every almanac boundary inside the trip (that is where the
  // SUN changes). All three are measured times; none is a step chosen for convenience.
  const marks = [lo];
  for (let h = Math.ceil(lo + 1e-9); h < hi; h++) marks.push(h);
  for (const b of [w.dawn, w.rise, w.set, w.dusk]) {
    if (b != null && b > lo && b < hi) marks.push(b);
  }
  marks.sort((a, b) => a - b);

  const rows = [];
  for (const at of marks) {
    if (rows.length && Math.abs(rows[rows.length - 1].atHours - at) < 1 / 3600) continue;
    const l = lightAt(ws, weatherByHour, at);
    if (l) rows.push({ hour: Math.floor(at), atHours: at, ...l });
  }
  return rows;
}

/**
 * The trip's light in one sentence's worth of facts: which states it touches, and when each of the
 * boundaries inside the trip falls. For a block that has to say what changes and when.
 */
export function lightSummary(ws, weatherByHour, launchTime, returnTime) {
  const rows = lightTimeline(ws, weatherByHour, launchTime, returnTime);
  if (!rows.length) return null;
  const end = hhmmToHours(returnTime);
  const states = [];
  const changes = [];
  for (const r of rows) {
    const key = `${r.state || 'unknown'}|${r.low}`;
    if (!states.length || states[states.length - 1].key !== key) {
      states.push({ key, state: r.state, low: r.low, from: r.at, fromHours: r.atHours,
                    lowBySky: r.lowBySky, lowBySun: r.lowBySun, skyWord: r.skyWord,
                    cloudPct: r.cloudPct, cloudMin: r.cloudPct, cloudMax: r.cloudPct });
      if (states.length > 1) changes.push(r);
    } else {
      const cur = states[states.length - 1];
      // THE SPREAD ACROSS THE RUN, not just its first hour. A run is merged on the light STATE, and
      // clear, mainly clear and partly cloudy are all "not low light" -- so a stretch can run from
      // 54% cloud down to 12% inside one run, and reporting only the first hour would state a
      // constancy nobody measured.
      if (r.cloudPct != null) {
        cur.cloudMin = cur.cloudMin == null ? r.cloudPct : Math.min(cur.cloudMin, r.cloudPct);
        cur.cloudMax = cur.cloudMax == null ? r.cloudPct : Math.max(cur.cloudMax, r.cloudPct);
      }
      // AND A RUN IS "not forecast" ONLY IF NO HOUR OF IT WAS. A 09:00 launch into a forecast that
      // starts at 10:00 merges into one daylight run whose FIRST sample had no sky, and reporting
      // that as the run's sky said "sky not forecast for these hours" over two hours that were
      // forecast. Absent is absent for the hour, not for the stretch.
      if (!cur.skyWord && r.skyWord) cur.skyWord = r.skyWord;
    }
  }
  // A run ends where the next one starts, and the last ends when he is off the water. Without this
  // a stretch of the day is a start time with no finish, which is how "overcast until" becomes
  // "overcast" and gets carried across the whole trip.
  for (let i = 0; i < states.length; i++) {
    const to = i + 1 < states.length ? states[i + 1].fromHours : end;
    states[i].to = hoursToHhmm(to);
    states[i].toHours = to;
    states[i].minutes = Math.round((to - states[i].fromHours) * 60);
  }
  const lowMin = states.filter((s) => s.low).reduce((a, s) => a + s.minutes, 0);
  const totalMin = Math.round((end - states[0].fromHours) * 60);
  return {
    rows,
    runs: states,
    changes,
    lowMin,
    totalMin,
    allLow: states.every((s) => s.low),
    noneLow: states.every((s) => !s.low),
    lowBySkyRuns: states.filter((s) => s.lowBySky).length,
  };
}

/**
 * THE LIGHT ON ONE LEG, from the leg's own estimated start and its own duration.
 *
 * Ryan asked for the app to be light aware "through out the whole day", and a day is made of legs.
 * A leg is a stretch of time, not an instant, so it can start in first light and end in daylight —
 * on a 40-minute pass launched at 06:30 that is not an edge case, it is the first leg of most of
 * his trips. So this answers with the light it STARTS in and, separately, whether the light changes
 * on it and to what, rather than picking one label and hiding the other.
 *
 * Null when the almanac is missing or the leg has no estimated start, which is the same silence
 * every other reader of the almanac keeps.
 */
export function legLightFor(ws, weatherByHour, startHhmm, minutes) {
  const from = hhmmToHours(startHhmm);
  const min = Number(minutes);
  if (from == null || !Number.isFinite(min) || min <= 0) return null;
  const sum = lightSummary(ws, weatherByHour, hoursToHhmm(from), hoursToHhmm(from + min / 60));
  if (!sum || !sum.runs.length) return null;
  const first = sum.runs[0];
  const next = sum.runs.length > 1 ? sum.runs[1] : null;
  return {
    from: first.from,
    to: sum.runs[sum.runs.length - 1].to,
    state: first.state,
    low: first.low,
    lowBySun: first.lowBySun,
    lowBySky: first.lowBySky,
    skyWord: first.skyWord,
    cloudPct: first.cloudPct,
    // WHETHER THE LIGHT CHANGES WHILE HE IS ON THIS LEG. A leg that crosses sunrise is one leg with
    // two lights on it, and a single label for it would be wrong at one end or the other.
    changesAt: next ? next.from : null,
    changesTo: next ? next.state : null,
    changesToLow: next ? next.low : null,
    allLow: sum.allLow,
    lowMin: sum.lowMin,
    totalMin: sum.totalMin,
  };
}

/**
 * The one short phrase for a card: `first light · low light` / `daylight · overcast 95%`.
 * Empty string when there is no answer, never a dash.
 */
export function lightLabel(light) {
  if (!light || !light.state) return '';
  const sky = light.skyWord
    ? `${light.skyWord}${light.cloudPct != null ? ` ${light.cloudPct}%` : ''}` : '';
  const head = light.low && !light.lowBySun ? `${light.state} · LOW LIGHT` : light.state;
  const turn = light.changesTo && light.changesTo !== light.state
    ? ` → ${light.changesTo} at ${light.changesAt}` : '';
  return `${head}${sky ? ` · ${sky}` : ''}${turn}`;
}

/**
 * WHICH LIGHTS A PIECE OF FREE TEXT NAMES, as a set: `['low']`, `['low','bright']`, `[]`.
 *
 * A source that says "shallow flats early and late, deeper channels mid-day" names both, and both
 * halves are instructions — so this returns the set rather than picking one and dropping the other.
 */
export function lightKindsIn(text) {
  const out = [];
  for (const p of lightPhrasesIn(text)) {
    const k = lightKindOf(p);
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

/**
 * WHETHER A LEG'S MEASURED LIGHT MATCHES WHAT A PIECE OF TEXT NAMES. `null` when the text names no
 * light at all, which is the common case and is not a disagreement.
 *
 * `low` is the leg's own measured boolean out of lightAt(): twilight, or a sky the light is not
 * getting through. Nothing here re-derives it.
 */
export function lightAgrees(light, kinds) {
  if (!light || !Array.isArray(kinds) || !kinds.length) return null;
  const wantsLow = kinds.includes('low');
  const wantsBright = kinds.includes('bright');
  if (wantsLow && wantsBright) return true;      // the text covers both, so any light is named
  if (wantsLow) return light.low === true;
  if (wantsBright) return light.low === false;
  return null;                                   // 'night' only — say nothing about a day trip
}
