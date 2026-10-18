// Personal use only, not for distribution or resale; not for navigation.
/**
 * CLAUDE WRITES THE PLAN AND READS THE FISH: THROUGH THE WORKER ON HIS API CREDIT FIRST, THEN ON
 * THIS PC, THEN GEMINI.
 *
 * Ryan, 2026-09-26: "i already pay for this so i might as well use it... my computer stays on and
 * connected to claude... i normally don't run plans from my phone... i plan here on the computer".
 * `Scripts/claude_plan_bridge.py` runs `claude -p` on his subscription and listens on this PC's
 * loopback address only.
 *
 * Ryan, 2026-10-18, of the monthly API credit Max now carries: "should we use this instead of how
 * we are currently doing the plans and pics?". Put to him -- the Worker first, the bridge next,
 * Gemini last -- he put the key in the Worker: "its been added to worker". The Worker's
 * /claude/ask and /claude/look (Worker/claude-api.js) ask the same model the bridge does and answer
 * in the bridge's shape, so from his phone at the ramp a plan is Claude's too. When the month's
 * credit is spent the API refuses and costs nothing, and the bridge answers as before.
 *
 * NOTHING ELSE CHANGES. The request is the one the planner already built, the answer comes back in
 * the Worker's shape and is read by the same parser, and every check after it runs the same. The
 * plan's `exchange` says which one answered (`provider`, `model`); when the Worker's Claude did
 * not, `claudeApi` says why, and when the bridge did not, `claudeBridge` does -- a plan that says
 * who wrote it can be argued with.
 *
 * THE BROWSER ASKS ONCE. A public https page calling 127.0.0.1 is a local-network request: Chrome and
 * Edge show "allow this site to access devices on your local network" the first time and remember
 * the answer. Until he allows it the health check fails and Gemini answers, which is the same as
 * the bridge not running.
 */

import { ANSWER_STEP } from '../utils/step-timer.js';
import { CF_WORKER_URL } from '../core/state.js';
import { workerHeaders } from '../utils/worker-auth.js';

// THE SAME NUMBER AS `PORT` IN Scripts/claude_plan_bridge.py -- the two must agree.
export const CLAUDE_BRIDGE_URL = 'http://127.0.0.1:8791';

// The Worker that holds the API key (Worker/claude-api.js). `apiUrl: null` asks only the bridge.
export const CLAUDE_API_URL = CF_WORKER_URL;

// A DEADLINE FOR THE HEALTH CHECK, NOT A TUNING KNOB. A bridge that is not running refuses at once;
// this only has to outlast the one-time "allow local network access" prompt while he reads it.
const HEALTH_TIMEOUT_MS = 60000;

/** {up, model, effort, busy} from the bridge, or {up:false, why}. Never throws. */
export async function claudeBridgeStatus(url = CLAUDE_BRIDGE_URL, { fetchImpl = fetch } = {}) {
  try {
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? AbortSignal.timeout(HEALTH_TIMEOUT_MS) : undefined;
    const r = await fetchImpl(`${url}/health`, { signal });
    if (!r.ok) return { up: false, why: `the bridge answered HTTP ${r.status}` };
    const h = await r.json();
    if (!h || !h.ok) return { up: false, why: 'the bridge did not say it was ready' };
    if (h.claude === false) return { up: false, why: 'the bridge is running but cannot find the claude CLI' };
    return { up: true, model: h.model || null, effort: h.effort || null, busy: !!h.busy };
  } catch (e) {
    return { up: false, why: 'Claude is not running on this PC (Scripts\\claude_plan_bridge.py)' };
  }
}

/** {up, model} when the Worker holds a key for Claude, or {up:false, why}. Never throws; spends nothing. */
export async function claudeApiStatus(url = CLAUDE_API_URL, { fetchImpl = fetch } = {}) {
  try {
    const r = await fetchImpl(`${url}/claude/health`);
    if (!r.ok) return { up: false, why: `the Worker's Claude answered HTTP ${r.status}` };
    const h = await r.json();
    if (!h || !h.ok) return { up: false, why: "the Worker's Claude did not say it was ready" };
    if (!h.key) return { up: false, why: 'the Worker has no API key for Claude' };
    return { up: true, model: h.model || null };
  } catch (e) {
    return { up: false, why: `the Worker could not be reached (${e.message})` };
  }
}

/**
 * Whether any Claude can answer: the Worker's, else this PC's. {up, via, model} or {up:false, why}.
 * The catch upload asks this once per drop.
 */
export async function claudeStatus({ apiUrl = CLAUDE_API_URL, url = CLAUDE_BRIDGE_URL, fetchImpl = fetch } = {}) {
  const api = apiUrl ? await claudeApiStatus(apiUrl, { fetchImpl }) : { up: false, why: 'not asked' };
  if (api.up) return { up: true, via: 'API', model: api.model };
  const pc = await claudeBridgeStatus(url, { fetchImpl });
  if (pc.up) return { up: true, via: 'this PC', model: pc.model };
  return { up: false, why: `${api.why}; ${pc.why}` };
}

/**
 * One POST to the Worker's Claude: {data, text}, or throws an Error whose `creditOut` is true when
 * the month's API credit is spent and `noKey` when the Worker holds none. The sync token goes with
 * it (workerHeaders): these routes spend.
 */
async function apiPost(worker, route, body, fetchImpl) {
  // `worker` is CLAUDE_API_URL, TrollMap's own Worker (CF_WORKER_URL): the token goes nowhere else.
  const r = await fetchImpl(`${worker}${route}`, { method: 'POST', headers: workerHeaders(),
                                                   body: JSON.stringify(body) });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  if (r.ok && data && !data.error) return { data, text };
  throw Object.assign(new Error((data && data.error) || `HTTP ${r.status}`),
                      { creditOut: !!(data && data.creditOut), noKey: !!(data && data.noKey) });
}

const apiWhyOf = (e) => (e.creditOut ? `this month's API credit is spent (${e.message})`
  : `Claude through the Worker failed: ${e.message}`);

/**
 * An asker with the same contract as modelAsker(): ({system, user}) => {content, meta}.
 *
 * @param {function} fallback  the Gemini asker, modelAsker(CF_WORKER_URL)
 * @param {object}   [o]
 * @param {string}   [o.url]        the bridge
 * @param {function} [o.fetchImpl]  for tests
 * @param {function} [o.say]        status line: (text) => void
 */
export function claudeFirstAsker(fallback, o = {}) {
  const url = o.url || CLAUDE_BRIDGE_URL;
  const apiUrl = o.apiUrl === undefined ? CLAUDE_API_URL : o.apiUrl;
  const fetchImpl = o.fetchImpl || fetch;
  const say = typeof o.say === 'function' ? o.say : () => {};
  return async (req) => {
    // THE WORKER'S CLAUDE FIRST: the month's API credit, from anywhere. Any failure goes on to the
    // bridge, so a refusal costs the plan a second and nothing else.
    let apiWhy = null;
    if (apiUrl) {
      say(`Asking Claude through the Worker${req.effort ? ` (${req.effort} effort)` : ''}…`);
      try {
        const { data, text } = await apiPost(apiUrl, '/claude/ask', { system: req.system, user: req.user,
                                                            ...(req.effort ? { effort: req.effort } : {}) }, fetchImpl);
        const out = readAnswer(data, text, 'claude (API)');
        if (out.content) { say(ANSWER_STEP); return out; }
        apiWhy = 'Claude through the Worker answered with nothing in it';
      } catch (e) {
        apiWhy = apiWhyOf(e);
      }
      say(`${apiWhy} — trying Claude on this PC.`);
    }
    const withApiWhy = (out) => (apiWhy && out && typeof out === 'object' && out.meta
      ? { ...out, meta: { ...out.meta, claudeApi: apiWhy } } : out);
    const st = await claudeBridgeStatus(url, { fetchImpl });
    let why = st.why;
    if (st.up) {
      // It said "a plan takes a minute or two". His bridge log, 2026-10-02: 8 to 11 minutes an ask.
      // The step timer says how long it took; this line says only what is happening.
      const effort = req.effort || st.effort;
      say(`Asking Claude (${st.model || 'the bridge'}${effort ? `, ${effort} effort` : ''}) on this PC…`);
      try {
        // A SIMPLE REQUEST, SO CHROME SENDS NO PREFLIGHT. Ryan, 2026-10-01: "I am getting the same
        // error... the plan i uploaded less than hour ago ran on claude just fine", with both "Local
        // network" and "Apps on device" allowed for the site. The GET to /health went through and
        // the POST to /ask was refused ("Permission was denied ... `loopback` address space") --
        // same page, same permission, same Chrome process (154, started 1:55 pm, which wrote his
        // 2:10 pm plan). The one difference between the two requests was the preflight a JSON
        // Content-Type forces. With no header a string body goes as text/plain, which needs none,
        // and the bridge reads the body as JSON whatever it is labelled. (A second bridge had also
        // been started on the port at 3:21 pm, before the single-bridge fix; it may have been part
        // of it too. Not proven either way.)
        // `effort` only when the planner set one -- the re-ask does (correctedRequest() in
        // plan-prompt.js); a first ask goes at whatever the bridge was started with.
        const r = await fetchImpl(`${url}/ask`, {
          method: 'POST',
          body: JSON.stringify({ system: req.system, user: req.user,
                                 ...(req.effort ? { effort: req.effort } : {}) }),
        });
        const text = await r.text();
        let data = null;
        try { data = JSON.parse(text); } catch { data = null; }
        if (r.ok && data) {
          const out = readAnswer(data, text);
          if (out.content) { say(ANSWER_STEP); return withApiWhy(out); }
          why = 'Claude answered with nothing in it';
        } else {
          why = `Claude on this PC failed: ${(data && data.error) || `HTTP ${r.status}`}`;
          if (data && data.usageLimit) why = `Claude's usage limit is reached (${data.error})`;
        }
      } catch (e) {
        // THE HEALTH CHECK ANSWERED AND THIS DID NOT. On 2026-10-01 Chrome said why in the console
        // and the plan did not: "Permission was denied for this request to access the `loopback`
        // address space" -- the site's local network permission, refused on the POST after the GET
        // had gone through. A fetch says only "Failed to fetch", so the likely cause is named here
        // beside the bridge closing, which is the other way to get the same TypeError.
        why = `the bridge stopped answering: ${e.message}. If Chrome's console says "Permission was `
          + 'denied ... loopback", allow this site\'s local network access (the icon left of the '
          + 'address bar, Site settings); otherwise the bridge window closed';
      }
    }
    say(`${why} — asking Gemini.`);
    const g = await fallback(req);
    say(ANSWER_STEP);
    // The Gemini asker returns {content, meta}; a bare string is still a valid answer.
    if (g && typeof g === 'object' && typeof g.content === 'string') {
      return { content: g.content, meta: { ...(g.meta || {}), claudeBridge: why,
                                           ...(apiWhy ? { claudeApi: apiWhy } : {}) } };
    }
    return g;
  };
}

/**
 * PHOTOS TO CLAUDE: the Worker's POST /claude/look on the API credit, then the bridge's POST /look.
 * The catch upload's fish ID (2026-10-08, his "All fish to claude"); the questions are
 * js/utils/claude-fish-id.js.
 *
 * @param {string} prompt
 * @param {{label?: string, data: string}[]} images  base64 JPEGs, each sent after its label
 * @returns {{text: string, model: string|null, seconds: number|null, via: 'API'|'this PC'}}
 * @throws  an Error whose `usageLimit` is true when neither Claude can answer for the rest of the
 *          drop: the credit is spent (or the Worker has no key) and the bridge is at its usage
 *          limit or not running
 *
 * The bridge's is a simple request, as /ask is (no Content-Type header, so no preflight): see
 * claudeFirstAsker().
 */
export async function claudeLook(prompt, images, { url = CLAUDE_BRIDGE_URL, apiUrl = CLAUDE_API_URL,
                                                   fetchImpl = fetch } = {}) {
  let apiErr = null;
  if (apiUrl) {
    try {
      const { data } = await apiPost(apiUrl, '/claude/look', { prompt, images }, fetchImpl);
      if (typeof data.text === 'string') {
        return { text: data.text, model: data._trollmap?.model || null, seconds: data._trollmap?.seconds ?? null, via: 'API' };
      }
      apiErr = new Error('Claude through the Worker answered with no text');
    } catch (e) {
      apiErr = e;
    }
  }
  let r, text;
  try {
    r = await fetchImpl(`${url}/look`, { method: 'POST', body: JSON.stringify({ prompt, images }) });
    text = await r.text();
  } catch (e) {
    throw both(apiErr, e, true);
  }
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  if (r.ok && data && typeof data.text === 'string') {
    return { text: data.text, model: data._trollmap?.model || null, seconds: data._trollmap?.seconds ?? null, via: 'this PC' };
  }
  const e = Object.assign(new Error((data && data.error) || `HTTP ${r.status}`), { usageLimit: !!(data && data.usageLimit) });
  throw both(apiErr, e, e.usageLimit);
}

// The bridge's failure, with the Worker's in front of it when there was one. `pcOut` is the bridge
// being unable to answer again this drop (its usage limit, or not running).
function both(apiErr, pcErr, pcOut) {
  if (!apiErr) return pcErr;
  const apiOut = !!(apiErr.creditOut || apiErr.noKey);
  return Object.assign(new Error(`${apiWhyOf(apiErr)}; on this PC: ${pcErr.message}`),
                       { usageLimit: apiOut && !!pcOut });
}

/** The bridge's (or the Worker's Claude's) body, in modelAsker()'s {content, meta} -- the same fields, read the same way. */
function readAnswer(data, text, provider = 'claude (this PC)') {
  const content = data.choices?.[0]?.message?.content || '';
  const u = data.usage || {};
  const t = data._trollmap || {};
  return {
    content,
    meta: {
      finishReason: data.choices?.[0]?.finish_reason ?? null,
      model: data.model || t.model || null,
      provider: t.provider || provider,
      promptTokens: u.prompt_tokens ?? null,
      completionTokens: u.completion_tokens ?? null,
      totalTokens: u.total_tokens ?? null,
      seconds: t.seconds ?? null,
      effort: t.effort ?? null,
      apiListPriceUsd: t.apiListPriceUsd ?? null,
      bodyBytes: text.length,
      contentChars: content.length,
      askedAt: new Date().toISOString(),
    },
  };
}
