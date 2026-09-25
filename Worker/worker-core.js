// worker-core.js — Shared infrastructure: CORS headers, LLM provider chain, fetchText


// trollmap-worker.js
var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Sync-Token, X-Image-Type, X-Lake, X-Date, X-Lat, X-Lon, X-Species-Hint, X-Assume-Board",
  "Access-Control-Max-Age": "60"
};
var JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };
var TEXT_HEADERS = { ...CORS, "Content-Type": "text/plain; charset=utf-8" };
var SYNC_TOKEN = "";

// ─── LLM Provider Abstraction (Groq → OpenRouter → Cerebras fallback) ──────────────────
// Updated 2026-07-11: Fix deprecation fallout.
// - Groq: llama-3.3-70b-versatile is deprecated Aug 16 2026; recommended is openai/gpt-oss-120b [1](https://console.groq.com/docs/deprecations)[2](https://console.groq.com/docs/batch)
// - Cerebras: valid models are llama-3.3-70b, llama-3.1-8b, qwen-3-32b, gpt-oss-120b etc — NOT llama3.1-70b [3](https://tokenmix.ai/blog/cerebras-api-key-access-speed-tests-2026)
// - OpenRouter free: use 3.3 variant
// We now try multiple model candidates per provider in order, and fall back across providers.
/**
 * THE FREE-TIER MODEL LADDER, IN ONE PLACE FOR ALL FIVE KEYS.
 *
 * Ryan, 2026-09-01: "google has added 3.5 flash lite to the free tier... i am guessing 3.1 will
 * be shutdown at some point. same rates as 3.1 flash lite" -- 15 RPM, 250,000 TPM, 500 RPD per
 * key, which is the budget the batch is paced against.
 *
 * 3.5 first and 3.1 behind it, so the newer model is used while the older one is still there to
 * catch a bad day, and the day Google retires 3.1 nothing needs editing: callLLM already walks a
 * provider's model list and moves on when one fails.
 *
 * Five copies of this array were five chances to update four of them. It was one line per key
 * when there was one model; it is a ladder now, and a ladder wants a single definition.
 */
const GEMINI_FREE_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
];

/**
 * THE FULL FLASH MODELS, FOR THE ANSWERS THAT MATTER MOST -- TRIED FIRST ONLY WHEN ASKED.
 *
 * Ryan, 2026-09-24, off his AI Studio page: 3.5, 3.6, 3.7 and 3.8 Flash each carry 5 RPM,
 * 250,000 TPM and 20 RPD per free key. Four models on five keys is twenty allowances, 400 calls a
 * day, and nothing used any of them. Too few for document extraction (a water can be fifty reads);
 * enough for the species groups, five calls a water, which write the trolling answers. Endpoints
 * as ai.google.dev/gemini-api/docs/models lists them, 2026-09-24; 2.5 Flash left out on his call
 * ("quite a ways behind in gemini land"), and 3 Flash is a preview.
 *
 * A caller passes { firstModels: GEMINI_FREE_FLASH_MODELS } and callLLM tries these on EVERY free
 * key before any Lite model, then falls to the Lite ladder exactly as before -- so a spent Flash
 * allowance costs a species nothing, it is answered by Lite as it always was.
 */
const GEMINI_FREE_FLASH_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
];

/**
 * THE SPARE MODELS: what is left on the day Lite and Flash are both spent. Ryan, 2026-09-25, with
 * all five projects at 503/500 on both Lite models and 21-23/20 on every Flash model and four
 * waters of a batch still to read: "we have flash 2.5 and flash 3 still left 5 rpm 250k tpm and
 * 20 rpd" -- and 2.5 Flash-Lite, 10 RPM and 20 RPD. Three models on five keys, 300 calls a day.
 * Model codes as ai.google.dev/gemini-api/docs/models lists them. Asked for by name only
 * (`extractModels` / `groupModels: 'spare'`); nothing reaches them by default.
 */
const GEMINI_FREE_SPARE_MODELS = [
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
];

/** The `firstModels` a request's `extractModels` / `groupModels` name, or null for Lite as always. */
function firstModelsFor(name) {
  if (name === 'flash') return GEMINI_FREE_FLASH_MODELS;
  if (name === 'spare') return GEMINI_FREE_SPARE_MODELS;
  return null;
}

/**
 * GOOGLE'S FREE-TIER LIMITS, PER MODEL -- ONE TABLE, BESIDE THE MODEL LISTS IT DESCRIBES.
 *
 * Off Ryan's AI Studio dashboards, 2026-09-25: the same on all five free projects he had then
 * (TrollmapFree to Trollmapfree5), and projects six to nine, added that evening, are on the same free
 * tier. How many there are is not written here or anywhere in the source -- only the Worker's
 * secrets know, and geminiFreeProviders(env) counts them; the research routes report the count as
 * meta.freeKeys, which is where Scripts/research_lakes.py takes it from. Google meters each model on its own, per project: "Rate limits are applied per
 * project, not per API key ... Requests per day (RPD) quotas reset at midnight Pacific time"
 * (ai.google.dev/gemini-api/docs/rate-limits, read 2026-09-25). TPM is 250,000 on both Lite and
 * Flash, from the same pages (the notes on GEMINI_FREE_MODELS and GEMINI_FREE_FLASH_MODELS), and
 * on 3 Flash and 2.5 Flash ("5 rpm 250k tpm and 20 rpd", the note on GEMINI_FREE_SPARE_MODELS).
 * 2.5 Flash-Lite's TPM was not given, so it is null rather than a guess.
 *
 * Read by rateRefusal() below, to tell a per-minute refusal from a per-day one when Google's error
 * names only its limit, and by Scripts/research_lakes.py, through node, to pace a run to the
 * models it asks for. Change a limit here and both follow.
 */
const GEMINI_FREE_LIMITS = {
  "gemini-3.5-flash-lite": { rpm: 15, rpd: 500, tpm: 250000 },
  "gemini-3.1-flash-lite": { rpm: 15, rpd: 500, tpm: 250000 },
  "gemini-3.8-flash":      { rpm: 5,  rpd: 20,  tpm: 250000 },
  "gemini-3.7-flash":      { rpm: 5,  rpd: 20,  tpm: 250000 },
  "gemini-3.6-flash":      { rpm: 5,  rpd: 20,  tpm: 250000 },
  "gemini-3.5-flash":      { rpm: 5,  rpd: 20,  tpm: 250000 },
  "gemini-3-flash-preview": { rpm: 5, rpd: 20,  tpm: 250000 },
  "gemini-2.5-flash":      { rpm: 5,  rpd: 20,  tpm: 250000 },
  "gemini-2.5-flash-lite": { rpm: 10, rpd: 20,  tpm: null },
};

// ── THE FREE GEMINI KEYS: EVERY ONE THE WORKER HOLDS, NOT A LIST OF FIVE ────────────────────────
//
// Ryan, 2026-09-25, after adding projects six to nine as GEMINI_FREE6_API_KEY ... GEMINI_FREE9_API_KEY
// (Google caps a person at ten): the five entries that stood in LLM_PROVIDERS were one entry copied
// five times, and callLLM named them a second time, so a sixth key needed a sixth copy and a sixth
// name and the new four sat unread. Now the keys are GEMINI_FREE_API_KEY, then GEMINI_FREE2_API_KEY,
// GEMINI_FREE3_API_KEY ... for as long as the next one exists -- read by name rather than by listing
// the environment, so nothing about how a binding is enumerated can hide one. Adding a project is
// adding its secret.
const geminiRequest = (p) => ({
  systemInstruction: { parts: [{ text: p.messages.find(m => m.role === 'system')?.content || '' }] },
  contents: [{ parts: [{ text: p.messages.find(m => m.role === 'user')?.content || '' }] }],
  generationConfig: {
    temperature: p.temperature || 0.15,
    maxOutputTokens: p.max_tokens || 1500,
    responseMimeType: p.response_format?.type === 'json_object' ? 'application/json' : undefined,
  }
});

function geminiFreeProvider(suffix) {
  return {
    // Free-tier Gemini: each key is its own project, with its own limits per model.
    name: `gemini-free${suffix}`,
    baseUrl: null,
    keyEnv: `GEMINI_FREE${suffix}_API_KEY`,
    defaultModel: "gemini-3.5-flash-lite",
    models: GEMINI_FREE_MODELS,
    headers: (key) => ({ "x-goog-api-key": key, "Content-Type": "application/json" }),
    isGemini: true,
    transformPayload: geminiRequest,
  };
}

/** The free Gemini providers `env` holds a key for, in order: GEMINI_FREE_API_KEY, then 2, 3, ... */
function geminiFreeProviders(env) {
  const out = [];
  for (let n = 1; ; n++) {
    const p = geminiFreeProvider(n === 1 ? '' : String(n));
    if (!env || !env[p.keyEnv]) return out;
    out.push(p);
  }
}

/** Every provider a request can use: the pay-tier Gemini, each free key, then the others. */
function providersFor(env) {
  return [...LLM_PROVIDERS.filter((p) => p.isGemini), ...geminiFreeProviders(env),
          ...LLM_PROVIDERS.filter((p) => !p.isGemini)];
}

var LLM_PROVIDERS = [
  {
    // Pay-tier Gemini — limnology agent only
    name: "gemini",
    baseUrl: null,
    keyEnv: "GEMINI_API_KEY",
  defaultModel: "gemini-3.1-pro-preview",
models: [
  "gemini-3.1-pro-preview",
  "gemini-2.5-pro",
  "gemini-2.5-flash"
],
    headers: (key) => ({ "x-goog-api-key": key, "Content-Type": "application/json" }),
    isGemini: true,
    excludeFromGeneral: true,
    transformPayload: (p) => ({
      systemInstruction: { parts: [{ text: p.messages.find(m => m.role === 'system')?.content || '' }] },
      contents: [{ parts: [{ text: p.messages.find(m => m.role === 'user')?.content || '' }] }],
      generationConfig: {
        temperature: p.temperature || 0.15,
        maxOutputTokens: p.max_tokens || 1500,
        responseMimeType: p.response_format?.type === 'json_object' ? 'application/json' : undefined,
      }
    }),
  },
  {
    name: "groq",
    baseUrl: "https://api.groq.com/openai/v1/chat/completions",
    keyEnv: "GROQ_API_KEY",
    defaultModel: "openai/gpt-oss-120b",
    models: [
      "openai/gpt-oss-120b",
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant"
    ],
    headers: (key) => ({ "Authorization": `Bearer ${key}`, "Content-Type": "application/json" }),
    transformPayload: (p) => p,
  },
  {
    name: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    keyEnv: "OPENROUTER_API_KEY",
    defaultModel: "meta-llama/llama-3.3-70b-instruct:free",
    models: [
      "meta-llama/llama-3.3-70b-instruct:free",
      "meta-llama/llama-3.1-70b-instruct:free",
      "openai/gpt-oss-120b:free",
      "qwen/qwen3-32b:free",
      "meta-llama/llama-4-scout-17b-16e-instruct:free"
    ],
    headers: (key) => ({
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://trollmap.dev",
      "X-Title": "TrollMap"
    }),
    transformPayload: (p) => p,
  },
  {
    name: "cerebras",
    baseUrl: "https://api.cerebras.ai/v1/chat/completions",
    keyEnv: "CEREBRAS_API_KEY",
    defaultModel: "gpt-oss-120b",
    models: [
      "gpt-oss-120b"
    ],
    headers: (key) => ({ "Authorization": `Bearer ${key}`, "Content-Type": "application/json" }),
    transformPayload: (p) => p,
  }

];

function extractLLMText(data) {
  const message = data?.choices?.[0]?.message;
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      return part?.text || part?.content || "";
    }).join("").trim();
  }
  if (typeof data?.output_text === "string") return data.output_text.trim();
  return "";
}

// WHERE A CALL STARTS IS DRAWN BY THE CALL, NOT READ OFF THE ISOLATE.
//
// This was three module-level counters -- the key, the Lite model, the Flash model -- each seeded
// with Math.random() when the module loaded and stepped once per call. Module state belongs to a
// Worker isolate, and Cloudflare starts and drops isolates as it likes; every analyze-facts and
// agent-llm call is its own request. So where a call started depended on how many calls this
// isolate had made and on what the seed was when the isolate was born -- and a fresh isolate
// makes one or two calls. If the seed does not differ between isolates, every fresh one sends its
// first call to the same key and the same model. (Workers restricts generating random values at
// global scope -- "Disallowed operation called within global scope. Asynchronous I/O ..., setting
// a timeout, and generating random values are not allowed within global scope." -- so what a
// module-load seed is worth there is not something this file should be resting on.)
//
// Measured 2026-09-16 across Ryan's five Gemini projects after six research runs (152 requests):
//
//     key 1   60 / 500 RPD        key 4   14 / 500
//     key 2   43 / 500            key 5   12 / 500
//     key 3   22 / 500
//
// and 2026-09-25, on all five projects: peak RPM 17 to 26 on the Lite models against a limit of
// 15, 5 to 8 on the Flash models against 5, while the client paced the whole pool at 60 a minute.
// Both are the shape of calls piling onto the same slot, not of load spread over twenty.
//
// So where an isolate starts is drawn with Math.random() INSIDE its first request, where it is
// allowed and differs from isolate to isolate, and every later call in that isolate steps one on
// from it: key s, s+1, ... around the ring, and the model ladder likewise. Twenty isolates making
// one call each land where twenty draws land (test/a-fresh-isolate-does-not-start-on-the-first-slot
// .test.js), and one isolate making nine calls on nine keys asks each key once
// (test/every-free-key-is-used.test.js) -- a fresh draw per call would leave keys unasked.
//
// BOTH MODELS, EACH ON ITS OWN QUOTA -- FOR THE CALLS THAT ASK. Ryan, 2026-09-24, with one key's
// AI Studio usage page open: "and we could make it so it hits both models separately right".
// Gemini 3.5 Flash Lite 8/15 RPM, 43/500 RPD; Gemini 3.1 Flash Lite 2/15 RPM, 0/500 RPD. The
// free tier meters each model on its own, so a caller that passes { spreadModels: true } gets the
// Lite ladder turned from a drawn start too. Opt-in, not the default: document extraction asks
// (Worker/research/extract.js), and callers that did not ask -- the species groups among them --
// keep 3.5 first, so the model that answers them does not change under them. The Flash pass
// ({ firstModels }) always starts at a drawn model.
const _drawn = {};   // lane ("key", "lite", "first") -> { offset, calls }; offset drawn in a request
function drawStart(n, lane) {
  if (n < 2) return 0;
  const d = _drawn[lane] || (_drawn[lane] = { offset: Math.floor(Math.random() * 1e9), calls: 0 });
  return (d.offset + d.calls++) % n;
}

/**
 * One generateContent call. Throws with the model's name on anything that is not an answer.
 *
 * `uncapped` drops maxOutputTokens. The caps in this Worker were sized for Flash-Lite, which does
 * not think before answering; the full Flash models do, and a thinking model spends its thinking
 * against the same output budget -- a 5,000-token cap sized for the answer alone can end the reply
 * before the answer starts. The model's own ceiling applies instead. Free tier, input-metered.
 *
 * THE TEXT IS EVERY NON-THOUGHT PART, JOINED. A thinking model can return more than one part, and
 * reading only the first is how an answer arrives as "empty content".
 */
async function geminiCall(provider, key, modelId, payload, uncapped = false, sent = null) {
  const geminiPayload = provider.transformPayload(payload);
  if (uncapped && geminiPayload.generationConfig) delete geminiPayload.generationConfig.maxOutputTokens;
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${key}`;
  // One entry per request that left this Worker, whatever came back. See sentRecord().
  const rec = sent ? sentRecord(sent, provider, modelId) : {};
  let r;
  try {
    r = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiPayload)
    });
  } catch (e) {
    // The platform's "too many subrequests" never left the Worker, so it is not a request Google
    // counted. Anything else thrown by fetch may have reached it; status 0 says we cannot tell.
    if (sent && invocationSpent(e)) sent.pop();
    throw e;
  }
  rec.http = r.status;
  let data;
  try { data = await r.json(); } catch (_) {
    const txt = await r.text().catch(() => "");
    throw new Error(`gemini/${modelId}: HTTP ${r.status} non-JSON ${txt.slice(0,200)}`);
  }
  if (!r.ok) {
    const msg = data.error?.message || data.error || `HTTP ${r.status}`;
    const msgStr = typeof msg === "string" ? msg : JSON.stringify(msg).slice(0,400);
    const err = new Error(`gemini/${modelId}: ${msgStr}`);
    err.http = r.status;
    err.refusal = rateRefusal(r.status, data, modelId);
    if (err.refusal) Object.assign(err.refusal, { key: rec.key, model: modelId });
    throw err;
  }
  // Convert Gemini response to OpenAI-compatible shape for extractLLMText
  const parts = data.candidates?.[0]?.content?.parts || [];
  const geminiText = parts.filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
  if (!geminiText) throw new Error(`gemini/${modelId}: empty content`);
  rec.answered = true;
  const compatData = { choices: [{ message: { content: geminiText } }] };
  return { provider: "gemini", model: modelId, data: compatData, _geminiRaw: geminiText.slice(0, 200) };
}

/**
 * EVERY REQUEST callLLM SENDS, WRITTEN DOWN -- BECAUSE GOOGLE COUNTS THEM ALL.
 *
 * Ryan's five AI Studio dashboards, 2026-09-25: both Lite models at 503 / 500 RPD and every Flash
 * model at 21-23 / 20 on all five projects -- about 5,500 requests counted. The two batch logs of
 * that day (research_20260925_130135.log, research_20260925_163204.log) got back about 900
 * answers, perhaps 1,050 with the morning's runs. Four requests in five counted against the day
 * and produced nothing, and nothing on the batch's screen could show it: a call that walked ten
 * refusals before an answer printed as one answer.
 *
 * So each request that leaves the Worker is one entry here -- the free key's number (1-5, as the
 * dashboards are TrollmapFree to Trollmapfree5) or the provider's name, the model, `http` -- the
 * HTTP status, 0 when fetch threw -- and whether it answered. callLLM hands the list back on its result as
 * `requests`, and on the error it throws as `err.requests`; the research handlers return it in
 * `meta.llmRequests`, and Scripts/research_lakes.py prints requests sent per answer.
 */
function sentRecord(sent, provider, model) {
  const m = /^gemini-free(\d*)$/.exec(provider.name);
  const rec = { key: m ? Number(m[1] || 1) : provider.name, model, http: 0, answered: false };
  sent.push(rec);
  return rec;
}

/** { sent, answered } over one or more request lists. */
function countRequests(requests) {
  const list = Array.isArray(requests) ? requests : [];
  return { sent: list.length, answered: list.filter((r) => r && r.answered).length };
}

// THE PLATFORM HAS REFUSED THIS INVOCATION ANY MORE FETCHES, so no key and no model further down
// the ladder can answer -- every one would throw the same sentence without reaching Google. Its
// own words: "Too many subrequests by single Worker invocation." (Ryan's batch log, 2026-09-25).
// Thrown straight out, so the caller sees the reason and not a ladder of copies of it. Workers
// Free allows 50 external subrequests per invocation:
// developers.cloudflare.com/workers/platform/limits/#subrequests.
function invocationSpent(e) {
  return /too many subrequests/i.test(String((e && e.message) || ''));
}

/**
 * A RATE REFUSAL, READ FROM GOOGLE'S OWN ERROR -- AND WHICH KIND IT IS.
 *
 *   "minute"  429 on a per-minute quota (requests or tokens). The slot is free again inside a
 *             minute, and Google says when: "Please retry in 35.4s" in the message, the same as
 *             `retryDelay` in its RetryInfo detail.
 *   "demand"  503 "This model is currently experiencing high demand ... Please try again later."
 *   "day"     429 on a per-day quota ("limit: 500, model: gemini-3.1-flash-lite"). The slot is
 *             spent until midnight Pacific; no wait inside a run brings it back.
 *
 * Which quota was hit is named by Google in the error's QuotaFailure detail
 * (`quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier"`, "...PerMinute..."). When the
 * detail is missing, the message's "limit: N, model: M" is compared with M's row in
 * GEMINI_FREE_LIMITS. A 429 that says neither is taken as per-minute: waiting on it costs no
 * request, and walking on it costs one per slot. null for anything that is not a rate refusal.
 */
function rateRefusal(status, data, modelId) {
  const err = (data && data.error) || {};
  const msg = typeof err.message === "string" ? err.message : "";
  const details = Array.isArray(err.details) ? err.details : [];
  const retryInfo = details.find((d) => /RetryInfo$/.test(String(d && d["@type"])));
  const delay = retryInfo && /^([\d.]+)s$/.exec(String(retryInfo.retryDelay || ""));
  const said = /retry in ([\d.]+)\s*(ms|s)\b/i.exec(msg);
  const retryAfterMs = delay ? Math.round(Number(delay[1]) * 1000)
    : said ? Math.round(Number(said[1]) * (said[2].toLowerCase() === "ms" ? 1 : 1000)) : null;
  if (status === 503 || err.status === "UNAVAILABLE") {
    return /high demand|overloaded|try again later/i.test(msg) ? { kind: "demand", retryAfterMs } : null;
  }
  if (status !== 429 && err.status !== "RESOURCE_EXHAUSTED") return null;
  const quotaIds = details.flatMap((d) => (Array.isArray(d && d.violations) ? d.violations : []))
    .map((v) => String(v.quotaId || ""));
  if (quotaIds.some((q) => /PerDay/i.test(q))) return { kind: "day", retryAfterMs };
  if (quotaIds.some((q) => /PerMinute/i.test(q))) return { kind: "minute", retryAfterMs };
  const lim = /limit:\s*(\d+),\s*model:\s*([\w.-]+)/i.exec(msg);
  const row = lim && (GEMINI_FREE_LIMITS[lim[2]] || GEMINI_FREE_LIMITS[modelId]);
  if (row && Number(lim[1]) === row.rpd && row.rpd !== row.rpm) return { kind: "day", retryAfterMs };
  return { kind: "minute", retryAfterMs };
}

// SLOTS THAT HAVE SAID THEIR DAY IS SPENT, until midnight Pacific -- when Google resets RPD. A
// per-day refusal is final for the day, and asking that slot again is one more counted request
// for one more refusal. Module state, so it lasts as long as the isolate does and no longer; it
// only ever saves requests, since a slot is left out only after Google itself said it was spent.
const _spentToday = new Map();   // "gemini-free3|gemini-3.5-flash-lite" -> "2026-09-25" (Pacific)
function pacificDay() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
}
function spentToday(provider, modelId) {
  return _spentToday.get(`${provider.name}|${modelId}`) === pacificDay();
}
function markSpent(provider, modelId) {
  _spentToday.set(`${provider.name}|${modelId}`, pacificDay());
}
/** Tests only: a fresh day for every slot. */
function forgetSpentSlots() { _spentToday.clear(); }

function turnLadder(models, start) {
  const n = models.length;
  if (n < 2 || !start) return models;
  const k = start % n;
  return [...models.slice(k), ...models.slice(0, k)];
}

async function callLLM(env, payload, preferredProvider = null, opts = {}) {
  // If no preferred provider specified and we have multiple gemini-free keys,
  // auto-rotate across them to spread RPM load
  // THE ROTATION PICKS WHERE THE ROTATION STARTS, NOT WHERE IT ENDS -- AND IT NEVER LEAVES THE
  // FREE GEMINI KEYS.
  //
  // It was written to spread RPM across several free Gemini keys, and it did -- but it set
  // `preferredProvider`, and the line below reads that as "this provider and no other". So from
  // the moment a second free key existed, EVERY general LLM call in this Worker became
  // single-provider: one key, its model list, then throw. The whole fallback chain -- the other
  // free keys, groq, openrouter, cerebras -- was unreachable on any call that did not name a
  // provider outright, which is all of them.
  //
  // Measured 2026-09-01, two consecutive runs of the fisheries batch. Both lost a whole species
  // group to the same sentence: "gemini/gemini-3.1-flash-lite: This model is currently
  // experiencing high demand." First run took the crappie group off Lake Sidney Lanier
  // (Hall Co, GA); second run took the bass group, three species of five.
  //
  // GROQ, OPENROUTER AND CEREBRAS ARE NOT THE ANSWER AND MUST NOT BE IN THIS CHAIN. Ryan,
  // 2026-09-01: "you can't use groq and cerebras... the rpm for them is completely different so
  // is the token size limits... that is why they were removed." They are still in LLM_PROVIDERS
  // for callers that name them outright, and a first attempt at this fix let the rotated chain
  // fall through to them -- which would have sent a 160,000-character fisheries prompt at a
  // provider whose limits were never sized for it. The fallback stays inside the free Gemini
  // keys, which share one shape of request.
  //
  // An EXPLICIT preferredProvider still pins -- a caller that names a provider means it.
  const PROVIDERS = providersFor(env);
  let rotated = false;
  let keyOrder = null;
  if (!preferredProvider) {
    const available = PROVIDERS.filter((p) => /^gemini-free/.test(p.name)).map((p) => p.name);
    if (available.length > 1) {
      keyOrder = turnLadder(available, drawStart(available.length, 'key'));
      preferredProvider = keyOrder[0];
      rotated = true;
    }
  }
  const providers = !preferredProvider
    ? PROVIDERS.filter(p => env[p.keyEnv] && !p.excludeFromGeneral)
    : rotated
      // The drawn key first, then the OTHER FREE GEMINI KEYS round the ring from it, and nothing
      // else. Same model family, same request shape, same limits -- a spike on one key is
      // answered by another key rather than by a provider sized differently.
      ? keyOrder.map((name) => PROVIDERS.find((p) => p.name === name))
      : PROVIDERS.filter(p => p.name === preferredProvider);

  if (!providers.length) {
    throw new Error("No LLM provider configured. Set GROQ_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY, or CEREBRAS_API_KEY");
  }

  const modelStart = opts && opts.spreadModels
    ? drawStart(GEMINI_FREE_MODELS.length, 'lite') : 0;

  const sent = [];
  try {
    const got = await walkLadder(env, payload, providers, modelStart, opts, sent);
    return { ...got, requests: sent };
  } catch (e) {
    if (e && typeof e === "object") e.requests = sent;
    throw e;
  }
}

async function walkLadder(env, payload, providers, modelStart, opts, sent) {
  let lastError;
  // Models that said "high demand" during THIS call; see stopOnRefusal().
  const busy = new Set();

  // THE FIRST MODELS, ON EVERY FREE KEY, BEFORE THE LADDER. Model by model across the keys in this
  // call's rotated order, each call starting at a drawn model, so twenty calls spread over all
  // twenty allowances. Everything that refuses falls through to the loop below, unchanged.
  if (opts && Array.isArray(opts.firstModels) && opts.firstModels.length) {
    const freeKeys = providers.filter((p) => p.isGemini && /^gemini-free/.test(p.name) && env[p.keyEnv]);
    for (const modelId of turnLadder(opts.firstModels, drawStart(opts.firstModels.length, 'first'))) {
      for (const provider of freeKeys) {
        if (busy.has(modelId) || spentToday(provider, modelId)) continue;
        try {
          return await geminiCall(provider, env[provider.keyEnv], modelId, payload, true, sent);
        } catch (e) {
          if (invocationSpent(e)) throw e;
          lastError = e;
          console.warn(`LLM gemini/${modelId} (first) failed: ${e.message}`);
          if (stopOnRefusal(e, provider, modelId, opts, busy)) throw e;
        }
      }
    }
  }

  for (const provider of providers) {
    const key = env[provider.keyEnv];
    if (!key) continue;

    // ── Gemini uses a different API (Google native REST, not OpenAI-compatible) ──
    if (provider.isGemini) {
      const modelCandidates = turnLadder(
        provider.models?.length ? provider.models : [provider.defaultModel], modelStart);
      for (const modelId of modelCandidates) {
        if (busy.has(modelId) || spentToday(provider, modelId)) continue;
        try {
          return await geminiCall(provider, key, modelId, payload, false, sent);
        } catch (e) {
          if (invocationSpent(e)) throw e;
          lastError = e;
          console.warn(`LLM gemini/${modelId} failed: ${e.message}`);
          if (stopOnRefusal(e, provider, modelId, opts, busy)) throw e;
          continue;
        }
      }
      continue; // exhausted Gemini models, move to next provider
    }

    const modelCandidates = provider.models?.length ? provider.models : [provider.defaultModel];
    for (const modelId of modelCandidates) {
      try {
        const providerPayload = { ...payload, model: modelId };
        const body = provider.transformPayload(providerPayload);
        // Retry on 429 for all providers — 2 retries with 2s/4s backoff
        const maxAttempts = 3;
        let r, rec;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          if (attempt > 1) {
            const delay = attempt === 2 ? 2000 : 4000;
            console.warn(`${provider.name}/${modelId} rate limited (429) — retry ${attempt}/${maxAttempts} after ${delay}ms`);
            await new Promise(res => setTimeout(res, delay));
          }
          rec = sentRecord(sent, provider, modelId);
          r = await fetch(provider.baseUrl, {
            method: "POST",
            headers: provider.headers(key),
            body: JSON.stringify(body)
          });
          rec.http = r.status;
          if (r.status !== 429) break;
        }
        let data;
        try {
          data = await r.json();
        } catch (_) {
          const txt = await r.text().catch(() => "");
          throw new Error(`${provider.name}/${modelId}: HTTP ${r.status} non-JSON ${txt.slice(0,200)}`);
        }
        if (!r.ok) {
          const msg = data.error?.message || data.error || data.message || `HTTP ${r.status}`;
          const msgStr = typeof msg === "string" ? msg : JSON.stringify(msg).slice(0,400);
          if (/does not exist|decommissioned|not found|invalid.*model|No such model/i.test(msgStr)) {
            console.warn(`LLM provider ${provider.name} model ${modelId} rejected: ${msgStr}`);
            lastError = new Error(`${provider.name}/${modelId}: ${msgStr}`);
            continue;
          }
          throw new Error(`${provider.name}/${modelId}: ${msgStr}`);
        }

        if (Array.isArray(data?.choices) && data.choices.length) {
          const text = extractLLMText(data);
          if (!text) {
            const choice = data.choices[0] || {};
            const finish = choice.finish_reason ? ` finish_reason=${choice.finish_reason}` : "";
            const reasoning = choice.message?.reasoning || choice.message?.reasoning_content || "";
            const hint = reasoning ? ` reasoning=${String(reasoning).slice(0,160)}` : "";
            throw new Error(`${provider.name}/${modelId}: empty assistant content.${finish}${hint}`);
          }
        }

        rec.answered = true;
        return { provider: provider.name, model: modelId, data };
      } catch (e) {
        lastError = e;
        const isModelErr = /does not exist|decommissioned|not found|invalid.*model|No such model/i.test(e.message);
        console.warn(`LLM ${provider.name}/${modelId} failed: ${e.message}`);
        if (isModelErr) continue;
        continue;
      }
    }
  }
  if (!lastError && !sent.length && providers.some((p) => p.isGemini)) {
    // Nothing was asked: every slot this call could reach has already said its day is spent.
    const e = new Error("gemini: every free key and model this call could ask has said its day "
                      + "is spent (per-day limit); none is asked again before midnight Pacific");
    e.refusal = { kind: "day", retryAfterMs: null };
    throw e;
  }
  throw lastError || new Error("All LLM providers/models failed");
}

/**
 * WHAT A RATE REFUSAL DOES TO THE WALK.
 *
 * Ryan's dashboards, 2026-09-25: ~5,500 requests counted for ~900 answers. A refused request
 * counts against the day like any other, and callLLM answered every refusal by asking the next
 * slot at once -- on a busy minute one call walked all ten Lite slots, and with Flash first thirty.
 *
 *   "day"     The slot is spent until midnight Pacific. It is marked (markSpent) so no later call
 *             in this isolate asks it again, and the walk goes on: another slot may not be spent.
 *   "demand"  "This model is currently experiencing high demand" -- Google names the MODEL, not
 *             the key. The model is left out for the rest of this call, on every key, and the walk
 *             goes on to the next model: on the same key, a different allowance. Measured in
 *             test/a-refusal-is-waited-out-not-walked.test.js before this rule was written: a spell
 *             of demand on 3.5 Flash Lite cost 1.24 requests an answer when the walk moved on to
 *             3.1, and 1.39 -- with four reads lost -- when the call stopped and the caller waited,
 *             because half the retries drew 3.5 again inside the same spell. When every model the
 *             call could ask is busy, the walk ends and the caller waits, as for "minute".
 *   "minute"  The slot's minute is full, and Google says when it is free: "Please retry in 35.4s".
 *             For a caller that passed { waitOnRateRefusal: true } the walk ends here, and the
 *             error goes back with `refusal: { kind, retryAfterMs, key, model }` for the caller to
 *             wait out -- which costs no requests. Measured in the same test: 300 reads sent at
 *             twice what the ten Lite slots take cost 11.28 requests an answer walking, 2.01
 *             waiting. A caller that did not ask walks as before; the app's own reads have no wait
 *             of their own to fall back on.
 */
function stopOnRefusal(e, provider, modelId, opts, busy) {
  const kind = e && e.refusal && e.refusal.kind;
  if (kind === "day") { markSpent(provider, modelId); return false; }
  if (kind === "demand") { busy.add(modelId); return false; }
  return !!(kind === "minute" && opts && opts.waitOnRateRefusal);
}
async function isAuthorized(request, env) {
  const want = env && env.SYNC_TOKEN || typeof SYNC_TOKEN !== "undefined" && SYNC_TOKEN || null;
  if (!want) return false;
  const got = request.headers.get("X-Sync-Token");
  return got === want;
}
function chartpackKey(lake, filename) {
  const safeLake = String(lake).toLowerCase().replace(/[^a-z0-9_\-]/g, "_");
  const safeFile = String(filename).replace(/[^a-z0-9_.\-\/]/gi, "_");
  return `${safeLake}/${safeFile}`;
}
/**
 * Every object in the bucket, grouped by the prefix before the first slash.
 *
 * `detail` turns each `files` entry from a bare name into { name, bytes, gzip }. Scripts/r2_audit.py
 * is the caller: working out what can be deleted needs a size per OBJECT, and a per-lake total
 * cannot answer "how much would dropping waterbody.geojson everywhere actually free?". `gzip`
 * reports the stored Content-Encoding so a re-upload can be checked for having landed rather
 * than assumed -- the 2026-08-05 storage work is invisible from the outside otherwise.
 *
 * The default shape is unchanged, because a summary of 12,972 objects should not cost 12,972
 * inline records unless someone asked for them.
 */
async function handleChartpackList(env, { detail = false } = {}) {
  const byName = new Map();
  let cursor;
  let objects = 0;
  do {
    const listed = await env.R2_TROLLMAP_CHARTPACKS.list({
      cursor,
      include: detail ? ["httpMetadata"] : undefined,
    });
    for (const obj of listed.objects) {
      const slash = obj.key.indexOf("/");
      if (slash < 0) continue;
      const lake = obj.key.slice(0, slash);
      const file = obj.key.slice(slash + 1);
      let entry = byName.get(lake);
      if (!entry) {
        entry = { name: lake, files: [], bytes: 0 };
        byName.set(lake, entry);   // Map, not out.find() -- that was O(n^2) over 1,567 prefixes
      }
      entry.files.push(detail
        ? { name: file, bytes: obj.size || 0, gzip: obj.httpMetadata?.contentEncoding === "gzip" }
        : file);
      entry.bytes += obj.size || 0;
      objects++;
    }
    cursor = listed.truncated ? listed.cursor : null;
  } while (cursor);
  const out = [...byName.values()];
  for (const e of out) {
    e.files.sort((a, b) => String(detail ? a.name : a).localeCompare(String(detail ? b.name : b)));
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return {
    chartpacks: out,
    count: out.length,
    objects,
    bytes: out.reduce((n, e) => n + e.bytes, 0),
  };
}

/**
 * Body stream for an R2 object, decompressed here if it was stored gzipped.
 *
 * WHY THE WORKER UNWRAPS INSTEAD OF PASSING THE ENCODING THROUGH
 *
 * The old chartpack route called obj.writeHttpMetadata(headers) and streamed obj.body straight
 * out. For a gzipped object that copies `Content-Encoding: gzip` onto the response -- and
 * Cloudflare's edge then compresses the Worker's output AGAIN on the way to the browser. Two
 * gzip layers arrive under one header, the browser unwraps exactly one, and r.json() gets a
 * gzip stream and throws. That was measured on 2026-08-01 and the conclusion drawn from it was
 * "storage is cheap, upload raw" -- which threw away 85% of the chartpack bytes to avoid a
 * header problem. What the measurement actually proved is that PASSTHROUGH breaks. Unwrapping
 * in the Worker was never tried.
 *
 * So: R2 stores one gzip layer, this strips it, and the edge re-compresses on the wire exactly
 * as it already does for raw JSON. Storage drops, wire size is unchanged, and the browser sees
 * plain JSON. DecompressionStream is a streaming transform -- it does not buffer the object
 * and it does not read against the Worker's CPU budget the way a manual inflate would.
 *
 * Content-Length is deleted with the encoding: R2 reports the COMPRESSED size, and announcing
 * it over a decompressed body truncates the response at the stored byte count. That failure
 * looks like a corrupt JSON tail, not like a header bug, so it is worth the extra line.
 *
 * Safe on raw objects: no contentEncoding means the body is returned untouched.
 */
function r2Body(obj, headers) {
  const enc = obj && obj.httpMetadata && obj.httpMetadata.contentEncoding;
  if (!enc || String(enc).toLowerCase() !== "gzip") return obj.body;
  headers.delete("Content-Encoding");
  headers.delete("Content-Length");
  return obj.body.pipeThrough(new DecompressionStream("gzip"));
}

/**
 * Text of an R2 object, decompressed here if it was stored gzipped.
 *
 * obj.text() and obj.json() do NOT honour the stored Content-Encoding -- R2 hands back the
 * bytes it holds, so on a gzipped object obj.text() returns gzip framing as mojibake and the
 * JSON.parse after it throws "Unexpected token" on byte 0x1f. Every read-and-parse in this
 * Worker goes through here so that whether a given key happens to be gzipped stops being
 * something a caller has to know.
 *
 * Returns null for a missing object so `if (!obj)` callers can keep their shape.
 */
async function r2Text(obj) {
  if (!obj) return null;
  const enc = obj.httpMetadata && obj.httpMetadata.contentEncoding;
  if (!enc || String(enc).toLowerCase() !== "gzip") return obj.text();
  return new Response(obj.body.pipeThrough(new DecompressionStream("gzip"))).text();
}

/**
 * EVERY object under a prefix, following the cursor to the end of the listing.
 *
 * R2's `list()` returns ONE page. It sets `truncated` and hands back a `cursor`, and it is
 * allowed to return fewer keys than the limit and still be truncated -- so "did I get under a
 * thousand?" is not a safe test, and a caller that asks once is reading a prefix of the bucket
 * while believing it read the bucket.
 *
 * Found for the third time on 2026-09-05, in the WQP limnology sweep. `lakes/` holds 80 profiles
 * and 802 `lakes/versions/<id>/vN.json` history objects, and R2 orders keys lexicographically, so
 * the version block sits between `lakes/tuckertown_lake_nc.json` and the four ids that sort after
 * the word "versions":
 *
 *   lakes/w_kerr_scott_reservoir_wilkes_co_nc.json
 *   lakes/watauga_lake_tn.json
 *   lakes/watauga_tn.json
 *   lakes/white_lake_bladen_co_nc.json
 *
 * The sweep asked once, so those four were never in its candidate list. All four hold a profile,
 * none has a `limnology-cache/<id>.json`, and none has a row in `_sweep.json` -- by the sweep's
 * own due test they were first in line, and they were never reached. The firing at 19:06 on
 * 2026-09-04 pulled ONE water with two slots to spend and then stopped, because as far as it
 * could see there was nothing left after Tuckertown. That short firing is the visible symptom of
 * a listing that ended early.
 *
 * `handleResearchList` paginates, which is why /research/list reports all 80 while the sweep
 * behaves as though there are 76. Two readers of the same prefix disagreeing about what is in it
 * is the shape this bug takes every time; there is now one reader.
 *
 * `keep` is applied per page so a caller that wants 80 of 882 keys does not hold 882.
 */
async function listAllR2(bucket, prefix, keep) {
  const out = [];
  let cursor;
  do {
    const listed = await bucket.list({ prefix, cursor });
    for (const o of listed.objects || []) if (!keep || keep(o)) out.push(o);
    cursor = listed.truncated ? listed.cursor : null;
  } while (cursor);
  return out;
}

// chartpackKey and handleChartpackList were defined here AND, byte for byte, again in
// trollmap-worker.js -- and the copies here were not exported and not called, so this file
// carried thirty lines that could never run while the live copy drifted independently.
// Exported now; trollmap-worker.js imports them.
export { CORS, JSON_HEADERS, TEXT_HEADERS, extractLLMText, callLLM, countRequests, rateRefusal, forgetSpentSlots,
  GEMINI_FREE_MODELS, GEMINI_FREE_FLASH_MODELS, GEMINI_FREE_SPARE_MODELS, GEMINI_FREE_LIMITS,
  geminiFreeProviders, firstModelsFor, isAuthorized, chartpackKey, handleChartpackList, r2Body, r2Text, listAllR2 };
