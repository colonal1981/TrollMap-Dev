/**
 * READING WHAT WAS SENT AND WHAT CAME BACK — the two pure questions behind the bench.
 *
 * Split out of plan-bench.js because that file touches the DOM and these do not, so these can be
 * tested against a real saved plan without a browser. Same reason every other pure thing in this
 * app lives under utils/.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 */

/** A prompt section heading is a line in CAPS with no lowercase in it. Nothing else marks them. */
const HEADING = /^[A-Z0-9][A-Z0-9 ,\'\u2019\-\u2014\u2013()/.:!?]{6,}$/;

/**
 * The prompt, split where it already divides itself.
 *
 * The prompt is one 76,000-character string assembled from blocks that each open with a shouted
 * heading -- WHERE THE WATER IS TODAY, WHAT THE LIGHT IS DOING, HOW LONG HE HAS. Splitting on
 * those reads the structure the prompt already has rather than inventing one for it, so a block
 * added to plan-prompt.js shows up in the bench without this file being touched.
 */
export function splitPrompt(user) {
  const lines = String(user || '').split('\n');
  const out = [];
  let cur = { title: 'OPENING', body: [] };
  for (const ln of lines) {
    const t = ln.trim();
    if (t && HEADING.test(t) && !/^[{[]/.test(t)) {
      if (cur.body.join('\n').trim() || cur.title !== 'OPENING') out.push(cur);
      cur = { title: t, body: [] };
    } else {
      cur.body.push(ln);
    }
  }
  out.push(cur);
  return out.filter((s) => s.body.join('\n').trim() || s.title !== 'OPENING');
}

/**
 * WHAT THE MODEL SAID THAT THE PLAN DOES NOT CARRY.
 *
 * Ryan's second question, asked twice: "do we throw away good data because we tuned this to 1
 * lake instead of making it work for all the lakes we could run a plan on". Measured rather than
 * argued -- every leaf value in the answer, looked for in the assembled plan. A value that is
 * nowhere in the plan was dropped, whatever the reason, and the reason is then worth knowing.
 *
 * Short strings are skipped: a rod id or a single digit appearing somewhere in a large object
 * proves nothing either way, and reporting them would bury the values that matter.
 */
export function droppedFromAnswer(response, plan) {
  const hay = JSON.stringify(plan || {});
  const out = [];
  const walk = (node, path) => {
    if (node == null) return;
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`));
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
      return;
    }
    const s = String(node);
    if (!s.trim() || s.length < 3) return;
    const probe = s.length > 40 ? s.slice(0, 40) : s;
    if (!hay.includes(probe)) out.push({ path, value: s.length > 120 ? `${s.slice(0, 120)}\u2026` : s });
  };
  walk(response, '');
  return out;
}
