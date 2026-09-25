// a-refusal-is-waited-out-not-walked.test.js
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan's dashboards, 2026-09-25, on all five free Gemini projects: both Lite models 503 / 500 RPD,
// every Flash model 21-23 / 20, about 5,500 requests counted. The day's two run logs got back about
// 900 answers. Then the batch ran out of Lite after 28 of 30 waters, and two waters on Flash spent
// all 400 Flash requests on about 40 answers. A refused request -- 429 for RPM, 503 "high demand"
// -- still counts against RPD, and callLLM answered every refusal by asking the next slot at once.
//
// These drive the real /research/analyze-facts handler, one document a request, the way
// Scripts/research_lakes.py drives it: new reads started at the batch's pace, a refused read asked
// again after EXTRACT_RETRY_WAITS (8, 20, 60 s) -- or Google's own delay when it asked for longer.
// Google is a stub that meters every slot (free key x model) as Google does, from
// GEMINI_FREE_LIMITS: a request over the slot's RPM in the last 60 s is refused 429 with "Please
// retry in N s" and the per-minute quotaId; a request past the slot's RPD is refused 429 with
// "limit: 500" and the per-day quotaId; and EVERY request, refused or not, counts toward RPD.
// Time is a fake clock, so a batch of minutes runs in milliseconds.
//
// "walking" is this callLLM without { waitOnRateRefusal }: a per-minute refusal is answered by the
// next slot at once, as every read did before. "waiting" is the read as the batch now asks for it.
// Both draw their starts per call and both leave a "high demand" model out for the rest of the call,
// so the difference between them is the per-minute rule alone. The number compared is requests sent
// per answer -- the number research_lakes.py now prints on every water.
//
//   node --test test/a-refusal-is-waited-out-not-walked.test.js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handleResearchAnalyzeFacts } from '../Worker/research/extract.js';
import { GEMINI_FREE_LIMITS, GEMINI_FREE_MODELS, GEMINI_FREE_FLASH_MODELS, GEMINI_FREE_SPARE_MODELS,
  rateRefusal, forgetSpentSlots }
  from '../Worker/worker-core.js';

const ENV = { GEMINI_FREE_API_KEY: 'k1', GEMINI_FREE2_API_KEY: 'k2', GEMINI_FREE3_API_KEY: 'k3',
  GEMINI_FREE4_API_KEY: 'k4', GEMINI_FREE5_API_KEY: 'k5' };
// Scripts/research_lakes.py: EXTRACT_RETRY_WAITS, and _TRANSIENT, the refusals it retries.
const EXTRACT_RETRY_WAITS_S = [8, 20, 60];
const TRANSIENT = /high demand|rate.?limit|\brate\b|quota|\b429\b|\b50[234]\b|overloaded|unavailable|timed? ?out/i;

// Google's error bodies, in the shape the Gemini API sends them.
const perMinute = (model, rpm, seconds) => ({ error: { code: 429, status: 'RESOURCE_EXHAUSTED',
  message: 'You exceeded your current quota, please check your plan and billing details. For more '
    + 'information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\n'
    + '* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, '
    + `limit: ${rpm}, model: ${model}\nPlease retry in ${seconds.toFixed(1)}s.`,
  details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{
      quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
      quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
      quotaDimensions: { location: 'global', model }, quotaValue: String(rpm) }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: `${Math.ceil(seconds)}s` },
  ] } });
const perDay = (model, rpd) => ({ error: { code: 429, status: 'RESOURCE_EXHAUSTED',
  message: 'You exceeded your current quota, please check your plan and billing details. For more '
    + 'information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\n'
    + '* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, '
    + `limit: ${rpd}, model: ${model}\nPlease retry in 41.2s.`,
  details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{
      quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
      quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
      quotaDimensions: { location: 'global', model }, quotaValue: String(rpd) }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '41s' },
  ] } });
const DEMAND = { error: { code: 503, status: 'UNAVAILABLE', message: 'This model is currently '
  + 'experiencing high demand. Spikes in demand are usually temporary. Please try again later.' } };

describe('which refusal it is, from Google\'s own words', () => {
  test('per minute, with the delay Google asked for', () => {
    assert.deepEqual(rateRefusal(429, perMinute('gemini-3.5-flash-lite', 15, 35.4), 'gemini-3.5-flash-lite'),
      { kind: 'minute', retryAfterMs: 36000 }, 'RetryInfo.retryDelay first');
    const bare = perMinute('gemini-3.5-flash-lite', 15, 35.4);
    bare.error.details = [];
    assert.deepEqual(rateRefusal(429, bare, 'gemini-3.5-flash-lite'), { kind: 'minute', retryAfterMs: 35400 },
      'the message\'s "Please retry in 35.4s" when there is no detail');
  });
  test('per day: "limit: 500", which no wait inside a run brings back', () => {
    assert.equal(rateRefusal(429, perDay('gemini-3.1-flash-lite', 500), 'gemini-3.1-flash-lite').kind, 'day');
    const bare = perDay('gemini-3.1-flash-lite', 500);
    bare.error.details = [];
    assert.equal(rateRefusal(429, bare, 'gemini-3.1-flash-lite').kind, 'day',
      'the limit named in the message is the model\'s RPD in GEMINI_FREE_LIMITS');
    const flash = perDay('gemini-3.8-flash', 20);
    flash.error.details = [];
    assert.equal(rateRefusal(429, flash, 'gemini-3.8-flash').kind, 'day');
  });
  test('"high demand", and what is not a rate refusal at all', () => {
    assert.deepEqual(rateRefusal(503, DEMAND, 'gemini-3.5-flash-lite'), { kind: 'demand', retryAfterMs: null });
    assert.equal(rateRefusal(500, { error: { message: 'An internal error has occurred.' } }, 'm'), null);
    assert.equal(rateRefusal(404, { error: { message: 'models/x is not found' } }, 'm'), null);
  });
});

/**
 * Google, metered per slot from GEMINI_FREE_LIMITS, on a fake clock. `spent` names models whose
 * RPD is already used on every key (the afternoon of 2026-09-25: Lite); `demand(model, t)` is a
 * "high demand" spell, which Google applies to a model whatever the key.
 */
function google({ spent = [], demand = () => false } = {}) {
  const clock = { now: 0 };
  const slots = new Map();
  const slot = (k, m) => {
    if (!slots.has(`${k}|${m}`)) {
      slots.set(`${k}|${m}`, { counted: spent.includes(m) ? GEMINI_FREE_LIMITS[m].rpd : 0, served: [] });
    }
    return slots.get(`${k}|${m}`);
  };
  const reply = (body, status) => new Response(JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json' } });
  const fetch = async (url) => {
    const [, model, key] = String(url).match(/models\/([^:]+):generateContent\?key=(\w+)/);
    const lim = GEMINI_FREE_LIMITS[model];
    const s = slot(key, model);
    s.counted += 1;                                   // refused or not, it counts against the day
    if (s.counted > lim.rpd) return reply(perDay(model, lim.rpd), 429);
    if (demand(model, clock.now)) return reply(DEMAND, 503);
    s.served = s.served.filter((t) => clock.now - t < 60000);
    if (s.served.length >= lim.rpm) {
      return reply(perMinute(model, lim.rpm, (s.served[0] + 60000 - clock.now) / 1000), 429);
    }
    s.served.push(clock.now);
    return reply({ candidates: [{ content: { parts: [{ text: '{"extracted_facts":[]}' }] } }] }, 200);
  };
  return { clock, fetch, slots };
}

const DOC = { title: 'Lake Murray striper report', url: 'https://a.example/1',
  text: 'Striped bass on Lake Murray hold on the main lake points at 30 to 40 feet in late summer, '
      + 'following the herring schools that stay near the thermocline.' };

/**
 * A batch of `reads`, started `perMinute` at a time, each asked again after the waits while its
 * refusal is "not now". `isolatePerRead` forgets every slot a per-day refusal marked before each
 * read -- a new Worker isolate for every request, the worst case for that memory.
 * -> { sent, answered, perAnswer, lost, minutes }
 */
// mulberry32, a standard 32-bit generator, so where each call starts is the same every run.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function batch({ reads, perMinute, waiting, extractModels, isolatePerRead = false, g }) {
  const real = globalThis.fetch;
  const realRandom = Math.random;
  globalThis.fetch = g.fetch;
  Math.random = seeded(20260925);
  forgetSpentSlots();
  const queue = Array.from({ length: reads }, (_, i) => ({ t: Math.round(i * 60000 / perMinute), attempt: 0 }));
  let sent = 0, answered = 0, lost = 0;
  try {
    while (queue.length) {
      queue.sort((a, b) => a.t - b.t);
      const ev = queue.shift();
      g.clock.now = ev.t;
      if (isolatePerRead) forgetSpentSlots();
      const res = await handleResearchAnalyzeFacts(new Request('https://w.example/x', {
        method: 'POST', body: JSON.stringify({ lakeName: 'Lake Murray, SC', baseName: 'Murray', state: 'SC',
          docIndex: 0, documents: [DOC], ...(waiting ? { waitOnRefusal: true } : {}),
          ...(extractModels ? { extractModels } : {}) }) }), ENV);
      const body = await res.json();
      sent += body.meta.llm.sent;
      const r = body.meta.docResults[0];
      if (!r.error) { answered += 1; continue; }
      if (TRANSIENT.test(r.error) && ev.attempt < EXTRACT_RETRY_WAITS_S.length) {
        const wait = Math.max(EXTRACT_RETRY_WAITS_S[ev.attempt] * 1000, r.retryAfterMs || 0);
        queue.push({ t: ev.t + wait, attempt: ev.attempt + 1 });
      } else {
        lost += 1;
      }
    }
  } finally { globalThis.fetch = real; Math.random = realRandom; }
  return { sent, answered, lost, perAnswer: answered ? +(sent / answered).toFixed(2) : Infinity,
           minutes: +(g.clock.now / 60000).toFixed(1) };
}

const show = (name, r) => console.log(`${name.padEnd(46)} ${String(r.sent).padStart(5)} sent / `
  + `${String(r.answered).padStart(4)} answered = ${String(r.perAnswer).padStart(5)} per answer, `
  + `${r.lost} lost, ${r.minutes} min`);

describe('requests sent per answer, walking against waiting', () => {
  test('Flash first with Lite spent for the day: the afternoon of 2026-09-25', async () => {
    // Two waters' reads on --extract-models flash at the pace it inherited from Lite (60 a minute).
    const run = (opts) => batch({ reads: 100, perMinute: 60, extractModels: 'flash', ...opts,
      g: google({ spent: GEMINI_FREE_MODELS }) });
    // Spread over twenty Flash slots, 60 a minute is under their 100, and the Lite slots that
    // are spent are asked once and then left out. The 2026-09-25 cost -- ~400 Flash requests for
    // ~40 answers -- needs the calls piled onto the same slots, which is what drawing the start
    // per call ends (a-fresh-isolate-does-not-start-on-the-first-slot.test.js).
    const walking = await run({ waiting: false });
    const waiting = await run({ waiting: true });
    const waitingFresh = await run({ waiting: true, isolatePerRead: true });
    show('flash, walking', walking);
    show('flash, waiting', waiting);
    show('flash, waiting, a new isolate every read', waitingFresh);
    for (const r of [waiting, waitingFresh]) {
      assert.ok(r.perAnswer <= 1.25, `waiting spent ${r.perAnswer} an answer`);
      assert.equal(r.lost, 0);
    }
  });

  test('Lite through a spell of "high demand" on 3.5 Flash Lite', async () => {
    // Minutes 2 and 3 of the batch: every 3.5 Flash Lite request refused, on every key.
    const demand = (m, t) => m === 'gemini-3.5-flash-lite' && t >= 120000 && t < 240000;
    const run = (opts) => batch({ reads: 300, perMinute: 60, ...opts, g: google({ demand }) });
    const walking = await run({ waiting: false });
    const waiting = await run({ waiting: true });
    show('lite + demand spell, walking', walking);
    show('lite + demand spell, waiting', waiting);
    // A demand spell is met by the other model on the same key, whether the caller waits or not
    // (stopOnRefusal); waiting must cost nothing extra here and lose nothing.
    assert.ok(waiting.perAnswer <= walking.perAnswer + 0.02, `${waiting.perAnswer} against ${walking.perAnswer}`);
    assert.ok(waiting.perAnswer < 1.3);
    assert.equal(waiting.lost, 0, 'every read answered in the end');
  });

  test('a burst past one slot\'s minute: every slot at its RPM', async () => {
    // 300 reads at 300 a minute -- twice what ten Lite slots at 15 RPM take.
    const run = (opts) => batch({ reads: 300, perMinute: 300, ...opts, g: google() });
    const walking = await run({ waiting: false });
    const waiting = await run({ waiting: true });
    show('lite burst at 2x capacity, walking', walking);
    show('lite burst at 2x capacity, waiting', waiting);
    assert.ok(waiting.perAnswer < walking.perAnswer / 3, `${waiting.perAnswer} against ${walking.perAnswer}`);
  });
});

test('every model the ladders ask has its row in the table', () => {
  for (const m of [...GEMINI_FREE_MODELS, ...GEMINI_FREE_FLASH_MODELS, ...GEMINI_FREE_SPARE_MODELS]) {
    assert.ok(GEMINI_FREE_LIMITS[m], `${m} has no limits row`);
  }
});
