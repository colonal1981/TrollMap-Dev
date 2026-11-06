// Personal use only, not for distribution or resale; not for navigation.
/**
 * CLAUDE THROUGH THE WORKER, ON THE MONTHLY API CREDIT HIS MAX PLAN CARRIES.
 *
 * Ryan, 2026-10-18: "does the free api credits that anthropic is now giving to max subscribers
 * help us in anyway with this app... should we use this instead of how we are currently doing the
 * plans and pics?". Put to him: the Worker asks Claude first for a plan and for the fish photos,
 * then Claude on his PC (Scripts/claude_plan_bridge.py), then Gemini. He made the key and put it
 * in the Worker himself: "its been added to worker".
 *
 * WHY. The bridge answers only while his PC is on and its window is open, so a plan from his phone
 * at the ramp has always been Gemini's. From here the same model answers from anywhere.
 *
 * WHAT IT SPENDS. Anthropic's terms (platform.claude.com/docs/en/about-claude/api-credits-for-
 * subscribers): Max 5x carries $100 of API credit a month, for the API and not for Claude Code;
 * unused credit expires each billing cycle. When it is spent the API refuses ("Your credit balance
 * is too low...") and nothing is charged; the app then asks the bridge, then Gemini. The bridge's
 * `claude -p` runs on his Max login and is not covered by the credit, so the order costs his Max
 * allowance nothing until the month's credit is gone.
 *
 * THE SAME QUESTION AS THE BRIDGE, ANSWERED IN THE BRIDGE'S SHAPE. /claude/ask takes {system, user,
 * effort?} and answers in the OpenAI shape /ask and /groq-query return; /claude/look takes {prompt,
 * images} and answers {text, _trollmap}. js/modules/claude-bridge.js reads both with the same code.
 * The model is the bridge's (PLAN_MODEL "opus" on his PC runs claude-opus-5-5), and so is the
 * effort: none is sent unless the request names one, so Opus answers at its own default, as the
 * CLI did.
 *
 * A PLAN IS STREAMED THROUGH, UNREAD; A PHOTO IS ONE REQUEST. A request here gets 10 ms of CPU on the
 * free plan; waiting on the answer costs none, and reading a stream of thinking events, one parse
 * each, would. So the Worker never parses one: a plan's stream is handed to the page as it comes
 * (askClaudeStream(), since 11/6, when a long plan's one request was cut off at 125 s with HTTP 524),
 * and the page reads it. Opus 5.5 answered his plans in 122-141 s on the bridge (APP_CHANGE_REQUESTS.md
 * item 52). A request that fails here costs a plan nothing: the app asks the bridge next.
 *
 * WHO MAY CALL IT. The two routes that spend are behind the same gate as the routes that change
 * stored state (SPENDING_ROUTES in trollmap-worker.js). That gate is the sync token, which ships in
 * the page, so it is not access control (js/utils/worker-auth.js says so); what it buys is that a
 * scanner that finds the URL cannot spend the credit.
 */
import { CORS } from './worker-core.js';

// "it should be using Claude Opus 5.5 same as what i am talking to you on" (Ryan, 2026-10-08, of
// the fish ID; the plans were already on it, item 52).
export const CLAUDE_MODEL = 'claude-opus-5-5';

const API = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';

// THE BRIDGE'S OWN WORDS (ASK in Scripts/claude_plan_bridge.py), so a plan is asked the same way
// on either route. A test holds the two equal.
export const ASK = 'Answer the request below with the one JSON object it asks for, and nothing else.';

const reply = (status, body) => new Response(JSON.stringify(body),
  { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const headersFor = (env) => ({ 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': API_VERSION,
                               'content-type': 'application/json' });

// THE MODEL'S OWN CEILING, ASKED OF THE MODELS API, NOT TYPED HERE. max_tokens is required, and
// thinking counts against it; only what is written is billed. Kept for the isolate's life.
const _maxOut = new Map();
export async function maxOutputTokens(env, model, fetchImpl = fetch) {
  if (_maxOut.has(model)) return _maxOut.get(model);
  const r = await fetchImpl(`${API}/v1/models/${encodeURIComponent(model)}`, { headers: headersFor(env) });
  const d = await r.json().catch(() => null);
  if (!r.ok || !(Number(d?.max_tokens) > 0)) {
    throw Object.assign(new Error(`the Models API did not give ${model}'s max_tokens: `
      + (d?.error?.message || `HTTP ${r.status}`)), { upstream: r.status, body: d });
  }
  _maxOut.set(model, Number(d.max_tokens));
  return Number(d.max_tokens);
}

/** The API's refusal, as the app reads it: {error, creditOut}. */
export function refusalOf(status, body) {
  const msg = body?.error?.message || `HTTP ${status}`;
  return {
    error: `Claude API ${status}: ${msg}`,
    // The words the API answers a spent credit with (the subscriber-credit page), or a billing error.
    creditOut: /credit balance is too low/i.test(msg) || body?.error?.type === 'billing_error',
  };
}

/** The Messages body, or the refusal before any is sent: {body} or {fail}. */
async function messageBody(env, { system, content, effort }, fetchImpl) {
  if (!env || !env.ANTHROPIC_API_KEY) {
    return { fail: { ok: false, status: 503, error: 'the Worker has no ANTHROPIC_API_KEY', creditOut: false, noKey: true } };
  }
  let max;
  try {
    max = await maxOutputTokens(env, CLAUDE_MODEL, fetchImpl);
  } catch (e) {
    const why = e.body ? refusalOf(e.upstream, e.body) : { error: e.message, creditOut: false };
    return { fail: { ok: false, status: 502, ...why } };
  }
  return { body: {
    model: CLAUDE_MODEL,
    max_tokens: max,
    ...(typeof system === 'string' && system ? { system } : {}),
    messages: [{ role: 'user', content }],
    // The API judges the value; the planner's re-ask is the one caller that names one ("low").
    ...(typeof effort === 'string' && effort ? { output_config: { effort } } : {}),
  } };
}

/**
 * ONE MESSAGES CALL, STREAMED STRAIGHT THROUGH. {ok:true, body} (the API's own event stream, unread) or the refusal.
 *
 * His Moultrie day of 11/6, laid in the reports' areas, sent Opus a 234,000-character prompt (twenty legs); the one
 * request with nothing coming back for two minutes was cut off at 125 s with HTTP 524 and the plan went to Gemini.
 * The plan before it had taken 134 s and come back. A stream sends the answer as it is written, so nothing sits idle
 * long enough to be cut. The Worker hands the stream on without reading it, which costs it no CPU (the reason given
 * above for one request); the page reads it (claude-bridge.js).
 */
export async function askClaudeStream(env, { system, content, effort }, { fetchImpl = fetch } = {}) {
  const m = await messageBody(env, { system, content, effort }, fetchImpl);
  if (m.fail) return m.fail;
  const r = await fetchImpl(`${API}/v1/messages`, { method: 'POST', headers: headersFor(env),
                                                   body: JSON.stringify({ ...m.body, stream: true }) });
  if (!r.ok || !r.body) {
    const data = await r.json().catch(() => null);
    return { ok: false, status: 502, ...refusalOf(r.status, data) };
  }
  return { ok: true, body: r.body };
}

/** One Messages call. {ok:true, data, seconds} or {ok:false, status, error, creditOut}. */
export async function askClaude(env, { system, content, effort }, { fetchImpl = fetch, now = Date.now } = {}) {
  const t0 = now();
  const m = await messageBody(env, { system, content, effort }, fetchImpl);
  if (m.fail) return m.fail;
  const body = m.body;
  const r = await fetchImpl(`${API}/v1/messages`, { method: 'POST', headers: headersFor(env),
                                                   body: JSON.stringify(body) });
  const data = await r.json().catch(() => null);
  const seconds = Math.round((now() - t0) / 100) / 10;
  if (!r.ok || !data || data.type === 'error') return { ok: false, status: 502, ...refusalOf(r.status, data) };
  return { ok: true, data, seconds };
}

const textOf = (data) => (data.content || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('');

/** The Messages answer in the OpenAI shape the bridge's /ask returns (to_openai() there). */
export function toOpenAi(data, seconds, effort) {
  const u = data.usage || {};
  const prompt = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
    .reduce((s, k) => s + (Number(u[k]) || 0), 0);
  const completion = Number(u.output_tokens) || 0;
  return {
    choices: [{ index: 0, finish_reason: data.stop_reason === 'max_tokens' ? 'length' : 'stop',
                message: { role: 'assistant', content: textOf(data) } }],
    model: data.model || CLAUDE_MODEL,
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
    _trollmap: { provider: 'claude (API)', model: data.model || CLAUDE_MODEL, modelAsked: CLAUDE_MODEL,
                 seconds, effort: effort || null, stopReason: data.stop_reason || null },
  };
}

/** GET /claude/health: whether the Worker holds a key, and which model it asks. Spends nothing. */
export function handleClaudeHealth(env) {
  return reply(200, { ok: true, key: !!(env && env.ANTHROPIC_API_KEY), model: CLAUDE_MODEL });
}

/** POST /claude/ask {system, user, effort?}: a plan. */
export async function handleClaudeAsk(request, env, o = {}) {
  let req;
  try { req = await request.json(); } catch { return reply(400, { error: 'the body is not JSON' }); }
  const { system, user, effort, stream } = req || {};
  if (typeof user !== 'string' || !user.trim()) return reply(400, { error: 'no user prompt' });
  // A PAGE THAT READS A STREAM ASKS FOR ONE (`stream: true`), and gets the API's events as they are written.
  if (stream === true) {
    const s = await askClaudeStream(env, { system, content: [{ type: 'text', text: `${ASK}\n\n${user}` }], effort }, o);
    if (!s.ok) return reply(s.status, { error: s.error, creditOut: s.creditOut, ...(s.noKey ? { noKey: true } : {}) });
    return new Response(s.body, { status: 200, headers: { ...CORS, 'Content-Type': 'text/event-stream; charset=utf-8',
                                                          'Cache-Control': 'no-cache', 'X-Claude-Model-Asked': CLAUDE_MODEL } });
  }
  const r = await askClaude(env, { system, content: [{ type: 'text', text: `${ASK}\n\n${user}` }], effort }, o);
  if (!r.ok) return reply(r.status, { error: r.error, creditOut: r.creditOut, ...(r.noKey ? { noKey: true } : {}) });
  return reply(200, toOpenAi(r.data, r.seconds, effort));
}

/** The /look message: the prompt, then each photo after its own label -- look_message() in the bridge. */
export function lookContent(prompt, images) {
  const content = [{ type: 'text', text: prompt }];
  for (const im of images) {
    if (im.label) content.push({ type: 'text', text: String(im.label) });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: im.data } });
  }
  return content;
}

/** POST /claude/look {prompt, images:[{label?, data}]}: the fish photos. */
export async function handleClaudeLook(request, env, o = {}) {
  let req;
  try { req = await request.json(); } catch { return reply(400, { error: 'the body is not JSON' }); }
  const { prompt, images } = req || {};
  if (typeof prompt !== 'string' || !prompt.trim()) return reply(400, { error: 'no prompt' });
  if (!Array.isArray(images) || !images.length
      || !images.every((i) => i && typeof i.data === 'string' && i.data)) {
    return reply(400, { error: 'no photos, or a photo with no data' });
  }
  const r = await askClaude(env, { content: lookContent(prompt, images) }, o);
  if (!r.ok) return reply(r.status, { error: r.error, creditOut: r.creditOut, ...(r.noKey ? { noKey: true } : {}) });
  return reply(200, { text: textOf(r.data),
                      _trollmap: { provider: 'claude (API)', model: r.data.model || CLAUDE_MODEL,
                                   modelAsked: CLAUDE_MODEL, seconds: r.seconds } });
}
