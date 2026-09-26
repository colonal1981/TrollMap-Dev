// research/shared.js — split from worker-research.js (behavior-preserving)
//
// It held the shared R2 document registry (research/shared/) and its six routes. /check, /query
// and /store went with the Research tab, their only caller, and /publish, /status and /quarantine
// had none; all went on 2026-09-25. What is left is the /debug/regs-cache handler. The R2 prefix
// is left for prune_r2_objects.py.
import { STATE_REGULATIONS_CONFIG, fetchStateRegulations, getLakeRegulations, tinyfishFetch } from './clients.js';

async function handleResearchRegsDebug(request, env) {
  const url = new URL(request.url);
  const state = url.searchParams.get('state')?.toUpperCase();
  const lake = url.searchParams.get('lake') || '';
  const raw = url.searchParams.get('raw') === '1';
  const bust = url.searchParams.get('bust') === '1';
  if (!state) return new Response(JSON.stringify({ error: '?state= required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  try {
    const config = STATE_REGULATIONS_CONFIG[state];
    if (!config) return new Response(JSON.stringify({ error: 'No config for state' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    if (raw) {
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      const result = await tinyfishFetch({ urls: config.pages.map(p => p.url), format: 'markdown' }, env);
      const text = result.results?.[0]?.text || '';
      const lmbIdx = text.search(/largemouth bass/i);
      return new Response(JSON.stringify({ state, url: config.pages[0].url, length: text.length, lmbIdx, preview: text.slice(offset, offset + 3000) }, null, 2), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
    // bust=1 clears KV cache so fresh parse runs
    if (bust) {
      await env.KV.delete(`regulations:${state}:v4`).catch(() => {});
      await env.KV.delete(`regulations:${state}:v3`).catch(() => {});
      await env.KV.delete(`regulations:${state}:v2`).catch(() => {});
    }
    const stateRegs = await fetchStateRegulations(state, env);
    const lakeRegs = lake ? getLakeRegulations(stateRegs, lake) : null;
    return new Response(JSON.stringify({
      state, lake: lake || null,
      generalKeys: Object.keys(stateRegs.general || {}),
      lakeSpecificKeys: Object.keys(stateRegs.lakeSpecific || {}).slice(0, 20),
      lakeRegs: lakeRegs || null,
      sampleGeneral: Object.fromEntries(Object.entries(stateRegs.general || {}).slice(0, 5)),
    }, null, 2), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message, stack: e.stack?.slice(0, 500) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

export { handleResearchRegsDebug };
