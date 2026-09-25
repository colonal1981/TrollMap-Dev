// a-fresh-isolate-does-not-start-on-the-first-slot.test.js
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan's dashboards, 2026-09-25, on all five free Gemini projects: peak RPM 17 to 26 on the Lite
// models against a limit of 15, and 5 to 8 on the Flash models against 5 -- while the client paced
// the whole pool at 60 a minute, about 6 a minute per Lite slot if the load were spread.
//
// callLLM picked a call's first key and model from module-level counters, seeded when the module
// loaded and stepped once per call. A Worker isolate is short-lived and every research call is its
// own request, so a fresh isolate makes one or two calls: where they start is where the seed says.
// If the seed is the same in every isolate, every fresh one sends its first call to the same slot.
//
// Each fresh isolate here is a fresh load of worker-core.js, with the module-load seed held the
// same in all of them (Math.random returns 0 while the module evaluates) -- the case the dashboards
// look like. Then each makes ONE call. Measured with this file against the code before the change
// (the three counters): all twenty isolates started on key 1, gemini-3.5-flash-lite; with Flash
// first, all twenty on key 1, gemini-3.8-flash. After it, the start is drawn inside the isolate's
// first request, where randomness is allowed and differs per isolate.
//
//   node --test test/a-fresh-isolate-does-not-start-on-the-first-slot.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GEMINI_FREE_FLASH_MODELS } from '../Worker/worker-core.js';

const ENV = { GEMINI_FREE_API_KEY: 'k1', GEMINI_FREE2_API_KEY: 'k2', GEMINI_FREE3_API_KEY: 'k3',
  GEMINI_FREE4_API_KEY: 'k4', GEMINI_FREE5_API_KEY: 'k5' };
const PAYLOAD = { messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }] };
const ISOLATES = 20;

// mulberry32, a standard 32-bit generator: the calls' own draws, the same every run.
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

/** Twenty fresh isolates, one call each. -> the slot ("key/model") each call's first request hit. */
async function firstSlots(opts, tag) {
  const real = { random: Math.random, fetch: globalThis.fetch };
  const draws = seeded(20260925);
  const slots = [];
  try {
    for (let i = 0; i < ISOLATES; i++) {
      Math.random = () => 0;                         // the same seed in every isolate
      const { callLLM } = await import(`../Worker/worker-core.js?isolate=${tag}-${i}`);
      Math.random = draws;                            // what the call itself draws
      let first = null;
      globalThis.fetch = async (url) => {
        const m = String(url).match(/models\/([^:]+):generateContent\?key=(\w+)/);
        first = first || `${m[2]}/${m[1]}`;
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }),
          { status: 200, headers: { 'content-type': 'application/json' } });
      };
      await callLLM(ENV, PAYLOAD, null, opts);
      slots.push(first);
    }
  } finally {
    Math.random = real.random;
    globalThis.fetch = real.fetch;
  }
  return slots;
}

const tally = (xs) => xs.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());

test('twenty fresh isolates spread their first Lite call over the ten slots', async () => {
  const slots = await firstSlots({ spreadModels: true }, 'lite');
  const per = tally(slots);
  assert.ok(per.size >= 7, `${per.size} of 10 slots used: ${[...per].join(' ')}`);
  assert.ok(Math.max(...per.values()) <= 6, `no slot takes more than 6 of 20 (all 20 before): ${[...per].join(' ')}`);
  assert.ok(new Set(slots.map((s) => s.split('/')[0])).size >= 4, 'the keys spread');
  assert.equal(new Set(slots.map((s) => s.split('/')[1])).size, 2, 'both Lite models start calls');
});

test('and their first Flash call over the twenty Flash slots', async () => {
  const slots = await firstSlots({ firstModels: GEMINI_FREE_FLASH_MODELS }, 'flash');
  const per = tally(slots);
  assert.ok(per.size >= 10, `${per.size} of 20 slots used: ${[...per].join(' ')}`);
  assert.ok(Math.max(...per.values()) <= 4, `no slot takes more than 4 of 20: ${[...per].join(' ')}`);
  assert.equal(new Set(slots.map((s) => s.split('/')[1])).size, GEMINI_FREE_FLASH_MODELS.length,
    'every Flash model starts calls');
});
