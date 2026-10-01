// Personal use only, not for distribution or resale; not for navigation.
/**
 * CLAUDE ON THIS PC WRITES THE PLAN WHEN IT IS THERE, AND GEMINI WHEN IT IS NOT.
 *
 * Ryan, 2026-09-26: "i already pay for this so i might as well use it... my computer stays on and
 * connected to claude... i normally don't run plans from my phone... i plan here on the computer".
 * `Scripts/claude_plan_bridge.py` runs `claude -p` on his subscription and listens on this PC's
 * loopback address only. This module asks it first and falls back to the Worker's Gemini chain
 * (modelAsker) whenever it is not running, is busy failing, or says the usage limit is reached.
 *
 * NOTHING ELSE CHANGES. The request is the one the planner already built, the answer comes back in
 * the Worker's shape and is read by the same parser, and every check after it runs the same. The
 * plan's `exchange` says which one answered (`provider`, `model`), and when Claude was tried and
 * Gemini answered, `claudeBridge` says why -- a plan that says who wrote it can be argued with.
 *
 * THE BROWSER ASKS ONCE. A public https page calling 127.0.0.1 is a local-network request: Chrome and
 * Edge show "allow this site to access devices on your local network" the first time and remember
 * the answer. Until he allows it the health check fails and Gemini answers, which is the same as
 * the bridge not running.
 */

// THE SAME NUMBER AS `PORT` IN Scripts/claude_plan_bridge.py -- the two must agree.
export const CLAUDE_BRIDGE_URL = 'http://127.0.0.1:8791';

// A DEADLINE FOR THE HEALTH CHECK, NOT A TUNING KNOB. A bridge that is not running refuses at once;
// this only has to outlast the one-time "allow local network access" prompt while he reads it.
const HEALTH_TIMEOUT_MS = 60000;

/** {up, model, busy} from the bridge, or {up:false, why}. Never throws. */
export async function claudeBridgeStatus(url = CLAUDE_BRIDGE_URL, { fetchImpl = fetch } = {}) {
  try {
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? AbortSignal.timeout(HEALTH_TIMEOUT_MS) : undefined;
    const r = await fetchImpl(`${url}/health`, { signal });
    if (!r.ok) return { up: false, why: `the bridge answered HTTP ${r.status}` };
    const h = await r.json();
    if (!h || !h.ok) return { up: false, why: 'the bridge did not say it was ready' };
    if (h.claude === false) return { up: false, why: 'the bridge is running but cannot find the claude CLI' };
    return { up: true, model: h.model || null, busy: !!h.busy };
  } catch (e) {
    return { up: false, why: 'Claude is not running on this PC (Scripts\\claude_plan_bridge.py)' };
  }
}

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
  const fetchImpl = o.fetchImpl || fetch;
  const say = typeof o.say === 'function' ? o.say : () => {};
  return async (req) => {
    const st = await claudeBridgeStatus(url, { fetchImpl });
    let why = st.why;
    if (st.up) {
      say(`Asking Claude (${st.model || 'the bridge'}) on this PC — a plan takes a minute or two.`);
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
        const r = await fetchImpl(`${url}/ask`, {
          method: 'POST',
          body: JSON.stringify({ system: req.system, user: req.user }),
        });
        const text = await r.text();
        let data = null;
        try { data = JSON.parse(text); } catch { data = null; }
        if (r.ok && data) {
          const out = readAnswer(data, text);
          if (out.content) return out;
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
    // The Gemini asker returns {content, meta}; a bare string is still a valid answer.
    if (g && typeof g === 'object' && typeof g.content === 'string') {
      return { content: g.content, meta: { ...(g.meta || {}), claudeBridge: why } };
    }
    return g;
  };
}

/** The bridge's body, in modelAsker()'s {content, meta} -- the same fields, read the same way. */
function readAnswer(data, text) {
  const content = data.choices?.[0]?.message?.content || '';
  const u = data.usage || {};
  const t = data._trollmap || {};
  return {
    content,
    meta: {
      finishReason: data.choices?.[0]?.finish_reason ?? null,
      model: data.model || t.model || null,
      provider: t.provider || 'claude (this PC)',
      promptTokens: u.prompt_tokens ?? null,
      completionTokens: u.completion_tokens ?? null,
      totalTokens: u.total_tokens ?? null,
      seconds: t.seconds ?? null,
      apiListPriceUsd: t.apiListPriceUsd ?? null,
      bodyBytes: text.length,
      contentChars: content.length,
      askedAt: new Date().toISOString(),
    },
  };
}
