/**
 * groq-coach.js — TrollMap Fishing Coach (Chat Mode)
 *
 * Replaces the auto-suggestion loop with a free-text chat panel.
 * The coach has full plan context and responds as an expert guide.
 * You ask anything — "are you sure about 2.5mph with a lipless?",
 * "what if the wind picks up?", "should I start deeper?" — Groq answers
 * in context, knowing your exact rig, conditions, and plan.
 *
 * Also retains a "Get Suggestion" button for the original one-at-a-time
 * structured suggestion flow if you want a concrete change applied to the plan.
 */

import { state } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { renderSpread, autoCalculateLead } from './spread-builder.js';

const CF_WORKER_URL = window.CF_WORKER_URL || 'https://trollmap-worker.colonal1981.workers.dev';

// ── State ─────────────────────────────────────────────────────────────────────
let _coachPayload        = null;
let _chatHistory         = [];   // [{role:'user'|'assistant', content:'...'}]
let _suggestionHistory   = [];   // accepted/skipped structured suggestions
let _currentSuggestion   = null;
let _busy                = false;

// ── Public API ────────────────────────────────────────────────────────────────
export function startCoachSession(coachPayload) {
  _coachPayload      = coachPayload;
  _chatHistory       = [];
  _suggestionHistory = [];
  _currentSuggestion = null;
  _busy              = false;

  renderCoachPanel();
  showCoachPanel();
}

export function stopCoachSession() {
  _busy = false;
  hideCoachPanel();
}

// ── Panel lifecycle ───────────────────────────────────────────────────────────
function showCoachPanel() {
  const panel = document.getElementById('groqCoachPanel');
  if (panel) panel.style.display = 'block';
}

function hideCoachPanel() {
  const panel = document.getElementById('groqCoachPanel');
  if (panel) panel.style.display = 'none';
}

function renderCoachPanel() {
  let panel = document.getElementById('groqCoachPanel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'groqCoachPanel';
    document.body.appendChild(panel);
  }

  panel.style.cssText = `
    position:fixed;bottom:80px;right:16px;width:360px;max-height:75vh;
    display:flex;flex-direction:column;z-index:2000;
    background:var(--panel);border:1px solid var(--accent2);
    border-radius:10px;box-shadow:0 4px 24px rgba(0,0,0,.6);
    font-family:system-ui;overflow:hidden;
  `;

  panel.innerHTML = `
    <!-- Header -->
    <div style="padding:10px 14px;border-bottom:1px solid var(--line);
                display:flex;justify-content:space-between;align-items:center;
                flex-shrink:0">
      <span style="font-weight:700;font-size:13px;color:var(--accent2)">🎣 Guide Chat</span>
      <div style="display:flex;gap:8px;align-items:center">
        <button id="coachSuggestBtn" title="Get a structured plan suggestion"
          style="font-size:10px;padding:3px 8px;border:1px solid var(--accent2);
                 border-radius:4px;background:transparent;color:var(--accent2);cursor:pointer">
          Get Suggestion
        </button>
        <button id="coachCloseBtn"
          style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px;padding:0">✕</button>
      </div>
    </div>

    <!-- Chat messages -->
    <div id="coachMessages"
      style="flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:10px;min-height:0">
      <div id="coachWelcome" style="background:var(--panel2);border-radius:8px;padding:10px;font-size:11px;color:var(--muted)">
        <div style="color:var(--text);font-weight:600;margin-bottom:4px">Plan loaded. Ask me anything.</div>
        <div style="margin-bottom:4px">Examples:</div>
        <div style="color:var(--accent2);cursor:pointer;margin:2px 0" class="coach-quick">Are you sure about that speed?</div>
        <div style="color:var(--accent2);cursor:pointer;margin:2px 0" class="coach-quick">What if the wind picks up?</div>
        <div style="color:var(--accent2);cursor:pointer;margin:2px 0" class="coach-quick">Should I start shallower?</div>
        <div style="color:var(--accent2);cursor:pointer;margin:2px 0" class="coach-quick">Why that lure on starboard?</div>
      </div>
    </div>

    <!-- Suggestion panel (hidden until Get Suggestion is clicked) -->
    <div id="coachSuggestionArea" style="display:none;border-top:1px solid var(--line);padding:10px 14px;flex-shrink:0"></div>

    <!-- Input -->
    <div style="border-top:1px solid var(--line);padding:10px 14px;flex-shrink:0;display:flex;gap:8px">
      <textarea id="coachInput" rows="2" placeholder="Ask the guide anything…"
        style="flex:1;background:var(--panel2);border:1px solid var(--line);border-radius:6px;
               color:var(--text);font-size:12px;padding:6px 8px;resize:none;font-family:system-ui;
               outline:none"></textarea>
      <button id="coachSendBtn"
        style="padding:0 12px;background:var(--accent2);border:none;border-radius:6px;
               color:#062d00;font-weight:700;font-size:12px;cursor:pointer;flex-shrink:0">
        Ask
      </button>
    </div>
  `;

  // Wire events
  panel.querySelector('#coachCloseBtn').addEventListener('click', stopCoachSession);
  panel.querySelector('#coachSendBtn').addEventListener('click', sendChatMessage);
  panel.querySelector('#coachSuggestBtn').addEventListener('click', runStructuredSuggestion);

  const input = panel.querySelector('#coachInput');
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
  });

  // Quick prompt chips
  panel.querySelectorAll('.coach-quick').forEach(el => {
    el.addEventListener('click', () => {
      input.value = el.textContent;
      sendChatMessage();
    });
  });
}

// ── Chat ──────────────────────────────────────────────────────────────────────
function buildSystemPrompt() {
  if (!_coachPayload) return 'You are an expert kayak fishing guide.';

  const p = _coachPayload;
  const cond = p.conditions || {};
  const profile = p.anglerProfile || {};
  const meta = p.planMeta || {};

  // Flatten spread into a readable rig description
  const spreadLines = (p.spread || []).map(r =>
    `  ${r.route} ${r.side}: ${r.lure} (${r.color}, ${r.depth}ft, ${r.lead}ft lead)`
  ).join('\n');

  // Phase depth bands
  const phaseLines = (p.phases || []).map((ph, i) => {
    const bandNum = i + 1;
    const role = bandNum === 1 ? 'Dawn run (first light → ~90min post-sunrise)'
               : bandNum === 2 ? 'Mid-morning run (deeper, post-dawn)'
               : 'Late run';
    const timeStr = (ph.startStr && ph.endStr) ? ` | ${ph.startStr} – ${ph.endStr}` : '';
    const speedStr = ph.speed || meta.speed || '?';
    return `  Band ${bandNum} [${role}${timeStr}]: ${ph.depthMin}-${ph.depthMax}ft @ ${speedStr}mph`;
  }).join('\n');

  const catchNote = p.intelligence?.catchHistory
    ? `Angler has ${p.intelligence.catchHistory.totalCatches} logged catches on this lake. Avg depth: ${p.intelligence.catchHistory.avgDepthFt}ft. Top lures: ${p.intelligence.catchHistory.topLures?.map(l=>l.lure).join(', ')}.`
    : 'No prior catch history on this lake.';

  return `You are an expert kayak fishing guide on ${cond.lake || 'this lake'}.

CURRENT PLAN:
- Species: ${cond.species || 'unknown'}
- Season: ${cond.season || 'unknown'}
- Water temp: ${cond.waterTemp || 'unknown'}
- Clarity: ${cond.clarity || 'unknown'}
- Weather: ${cond.weather || 'unknown'}
- Solunar: ${cond.solunar || 'unknown'}
- Pool level: ${cond.poolLevel || 'unknown'}
- Speed: ${meta.speed || '?'}mph${meta.speedRationale ? ` (${meta.speedRationale})` : ''}
- Ramp: ${p.route?.ramp || 'unknown'}, range: ${p.route?.rangeMiles?.toFixed(1) || '?'}mi

DEPTH BANDS:
${phaseLines || '  (none)'}

ROD ASSIGNMENTS:
${spreadLines || '  (none)'}

ANGLER PROFILE:
- Platform: ${profile.gear || 'kayak'}
- Rods: ${profile.rodSetup || 'spinning only'}
- No live bait. Max 2 rods. Depth by lead length only. No downriggers.

CATCH HISTORY:
${catchNote}

INSTRUCTIONS:
- Answer the angler's questions directly and honestly.
- If they challenge a decision, explain the reasoning — or admit if it's uncertain.
- Keep answers concise — 2-4 sentences unless they ask for detail.
- Never suggest gear the angler doesn't own.
- If you'd recommend a change, say so clearly and explain why.
- Band 1 is ALWAYS the dawn/early-morning run. Band 2 is ALWAYS the deeper mid-morning run. Do not confuse which band runs at which time of day.
- When discussing depth changes, be specific about which band and why that depth is or is not appropriate for the time of day and conditions.`;
}

async function sendChatMessage() {
  if (_busy) return;
  const input = document.getElementById('coachInput');
  const text = (input?.value || '').trim();
  if (!text) return;

  input.value = '';
  appendMessage('user', text);
  _chatHistory.push({ role: 'user', content: text });

  _busy = true;
  const thinkingId = appendThinking();

  try {
    const messages = [
      { role: 'system', content: buildSystemPrompt() },
      ..._chatHistory,
    ];

    const res = await fetch(`${CF_WORKER_URL}/groq-query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        max_tokens: 400,
        temperature: 0.4,
      }),
    });

    removeThinking(thinkingId);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content?.trim() || '(no response)';

    _chatHistory.push({ role: 'assistant', content: reply });
    appendMessage('assistant', reply);
  } catch (e) {
    removeThinking(thinkingId);
    appendMessage('error', `Error: ${e.message}`);
  }

  _busy = false;
}

// ── Message rendering ─────────────────────────────────────────────────────────
function getMessagesEl() {
  return document.getElementById('coachMessages');
}

function appendMessage(role, text) {
  const el = getMessagesEl();
  if (!el) return;

  // Hide welcome on first real message
  const welcome = document.getElementById('coachWelcome');
  if (welcome) welcome.style.display = 'none';

  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'display:flex;flex-direction:column;' +
    (role === 'user' ? 'align-items:flex-end;' : 'align-items:flex-start;');

  const div = document.createElement('div');
  div.style.cssText = role === 'user'
    ? 'background:var(--accent2);color:#062d00;border-radius:8px 8px 2px 8px;padding:8px 10px;font-size:12px;max-width:85%;'
    : role === 'error'
    ? 'background:var(--panel2);border:1px solid var(--warn);color:var(--warn);border-radius:8px 8px 8px 2px;padding:8px 10px;font-size:11px;max-width:90%;'
    : 'background:var(--panel2);border:1px solid var(--line);color:var(--text);border-radius:8px 8px 8px 2px;padding:8px 10px;font-size:12px;max-width:90%;line-height:1.5;';

  div.textContent = text;
  wrapper.appendChild(div);

  // Add "Apply this" button after assistant messages that might contain plan changes
  if (role === 'assistant') {
    const applyBtn = document.createElement('button');
    applyBtn.textContent = '⚡ Apply this to plan';
    applyBtn.style.cssText = 'margin-top:4px;font-size:10px;padding:3px 8px;' +
      'border:1px solid var(--accent2);border-radius:4px;background:transparent;' +
      'color:var(--accent2);cursor:pointer;align-self:flex-start;';
    applyBtn.addEventListener('click', () => extractAndApplyFromChat(text, applyBtn));
    wrapper.appendChild(applyBtn);
  }

  el.appendChild(wrapper);
  el.scrollTop = el.scrollHeight;
}

// ── Extract plan changes from chat response and apply them ────────────────────
async function extractAndApplyFromChat(assistantText, btn) {
  if (_busy) return;
  _busy = true;
  btn.textContent = '⏳ Extracting…';
  btn.disabled = true;

  try {
    const extractPrompt = `The fishing guide said this:

"${assistantText}"

Extract any concrete plan changes from that response as a JSON array.
Each change: {"field": "trolling_speed|lead_length|lure|lure_color|target_depth|inline_weight", "phase": 1|2|null, "rod": "Port"|"Starboard"|"Both"|null, "current_value": "what it is now or null", "recommended_value": "the new value"}

If no concrete changes are suggested, return [].
Return ONLY the JSON array, nothing else.`;

    const res = await fetch(`${CF_WORKER_URL}/groq-query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: extractPrompt }],
        max_tokens: 300,
        temperature: 0.1,
      }),
    });

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content?.trim() || '[]';
    const clean = raw.replace(/```json|```/g, '').trim();

    let changes = [];
    try { changes = JSON.parse(clean); } catch (_) { changes = []; }

    if (!Array.isArray(changes) || changes.length === 0) {
      btn.textContent = '— Nothing concrete to apply';
      btn.disabled = true;
      setTimeout(() => { btn.textContent = '⚡ Apply this to plan'; btn.disabled = false; }, 2000);
      _busy = false;
      return;
    }

    // Apply each extracted change
    let applied = [];
    for (const s of changes) {
      if (!s.field || s.recommended_value == null) continue;
      applyCoachSuggestion(s);
      applied.push(`${s.field.replace(/_/g,' ')} → ${s.recommended_value}`);
      _suggestionHistory.push({ ...s, status: 'accepted' });
    }

    btn.textContent = `✓ Applied: ${applied.join(', ')}`;
    btn.disabled = true;
    appendMessage('assistant', `Applied to plan: ${applied.join(', ')}`);

  } catch (e) {
    btn.textContent = '⚠ Extract failed';
    btn.disabled = true;
    setTimeout(() => { btn.textContent = '⚡ Apply this to plan'; btn.disabled = false; }, 2000);
  }

  _busy = false;
}

let _thinkingCounter = 0;
function appendThinking() {
  const el = getMessagesEl();
  if (!el) return null;
  const id = `thinking_${++_thinkingCounter}`;
  const div = document.createElement('div');
  div.id = id;
  div.style.cssText = 'align-self:flex-start;color:var(--muted);font-size:11px;padding:4px 2px;';
  div.textContent = '⏳ Guide is thinking…';
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
  return id;
}

function removeThinking(id) {
  if (id) document.getElementById(id)?.remove();
}

// ── Structured suggestion (original coach flow, on demand) ────────────────────
async function runStructuredSuggestion() {
  if (_busy) return;
  const area = document.getElementById('coachSuggestionArea');
  if (!area) return;

  area.style.display = 'block';
  area.innerHTML = `<div style="font-size:11px;color:var(--muted);text-align:center;padding:8px 0">⏳ Getting suggestion…</div>`;

  _busy = true;
  try {
    const res = await fetch(`${CF_WORKER_URL}/coach-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payload: _coachPayload,
        previousSuggestions: _suggestionHistory,
      }),
    });

    const data = await res.json();
    _busy = false;

    if (!data.success || !data.has_suggestion) {
      area.innerHTML = `<div style="font-size:11px;color:var(--muted);text-align:center;padding:8px 0">
        ${data.no_suggestion_reason || 'Plan looks solid — no changes suggested.'}
        <button id="coachHideSuggestion" style="display:block;margin:8px auto 0;font-size:11px;background:none;border:none;color:var(--muted);cursor:pointer;text-decoration:underline">Dismiss</button>
      </div>`;
      area.querySelector('#coachHideSuggestion')?.addEventListener('click', () => { area.style.display = 'none'; });
      return;
    }

    _currentSuggestion = data.suggestion;
    renderSuggestionCard(area, data.suggestion);
  } catch (e) {
    _busy = false;
    area.innerHTML = `<div style="font-size:11px;color:var(--warn)">Error: ${esc(e.message)}</div>`;
  }
}

function renderSuggestionCard(container, s) {
  const pct = Math.round((s.confidence || 0) * 100);
  const confColor = pct >= 80 ? 'var(--good)' : pct >= 60 ? 'var(--warn)' : 'var(--bad)';
  const target = [s.phase ? `Band ${s.phase}` : null, s.rod].filter(Boolean).join(' · ');

  const reasonsHtml = (s.reasons || []).map(r =>
    `<div style="color:var(--good);font-size:11px;margin:1px 0">✓ ${esc(r)}</div>`
  ).join('');

  const warningsHtml = (s.warnings || []).map(w =>
    `<div style="color:var(--warn);font-size:11px;margin:1px 0">⚠ ${esc(w)}</div>`
  ).join('');

  container.innerHTML = `
    <div style="font-size:10px;color:var(--muted);margin-bottom:6px">
      Suggestion${target ? ` · ${esc(target)}` : ''}
      <span style="float:right;font-weight:700;color:${confColor}">${pct}%</span>
    </div>
    <div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:4px">
      Change <span style="color:var(--accent2)">${esc(s.field?.replace(/_/g,' ') || '')}</span>
    </div>
    <div style="display:flex;gap:6px;align-items:center;font-size:12px;margin-bottom:8px">
      <span style="color:var(--bad);text-decoration:line-through">${esc(String(s.current_value || ''))}</span>
      <span style="color:var(--muted)">→</span>
      <span style="color:var(--good);font-weight:700">${esc(String(s.recommended_value || ''))}</span>
    </div>
    ${reasonsHtml}${warningsHtml}
    <div style="display:flex;gap:6px;margin-top:8px">
      <button id="suggAccept" style="flex:1;padding:6px;font-size:11px;font-weight:700;border:1px solid var(--accent2);border-radius:5px;background:var(--accent2);color:var(--panel);cursor:pointer">✓ Apply</button>
      <button id="suggSkip"   style="flex:1;padding:6px;font-size:11px;border:1px solid var(--line);border-radius:5px;background:var(--panel2);color:var(--text);cursor:pointer">✗ Skip</button>
      <button id="suggDismiss" style="padding:6px 8px;font-size:11px;border:none;background:none;color:var(--muted);cursor:pointer">✕</button>
    </div>
  `;

  container.querySelector('#suggAccept')?.addEventListener('click', () => {
    applyCoachSuggestion(s);
    _suggestionHistory.push({ ...s, status: 'accepted' });
    // Echo to chat
    appendMessage('assistant', `Applied: ${s.field?.replace(/_/g,' ')} changed from ${s.current_value} to ${s.recommended_value}.`);
    container.style.display = 'none';
  });

  container.querySelector('#suggSkip')?.addEventListener('click', () => {
    _suggestionHistory.push({ ...s, recommended_value: `[SKIPPED] ${s.recommended_value}`, status: 'skipped' });
    container.style.display = 'none';
  });

  container.querySelector('#suggDismiss')?.addEventListener('click', () => {
    container.style.display = 'none';
  });
}

// ── Apply suggestion to plan ──────────────────────────────────────────────────
function applyCoachSuggestion(s) {
  const { field, phase, rod, recommended_value } = s;

  const getRodRows = () => state.SPREAD?.filter(r => {
    const phaseMatch = !phase || r.notes?.includes(`Ph${phase}`);
    const rodMatch   = !rod || rod === 'Both' || r.side?.includes(rod);
    return phaseMatch && rodMatch;
  }) || [];

  const currentSpeed = parseFloat(document.getElementById('planSpeed')?.value) || 2.0;

  switch (field) {
    case 'lure':
      getRodRows().forEach(r => {
        r.lure = recommended_value;
        r.lead = String(autoCalculateLead(r, currentSpeed));
      });
      break;
    case 'lure_color': getRodRows().forEach(r => { r.color = recommended_value; }); break;
    case 'lead_length': getRodRows().forEach(r => { r.lead = String(recommended_value); }); break;
    case 'trolling_speed': {
      const el = document.getElementById('planSpeed');
      if (el) el.value = String(recommended_value);
      (state.SPREAD || []).forEach(r => {
        r.lead = String(autoCalculateLead(r, parseFloat(recommended_value)));
      });
      break;
    }
    case 'target_depth':
      getRodRows().forEach(r => {
        r.depth = String(recommended_value);
        r.lead = String(autoCalculateLead(r, currentSpeed));
      });
      break;
    case 'inline_weight':
      getRodRows().forEach(r => { r.notes = (r.notes||'') + ` · Coach: add ${recommended_value} inline weight`; });
      break;
    default:
      getRodRows().forEach(r => { r.notes = (r.notes||'') + ` · Coach: ${field} → ${recommended_value}`; });
  }

  // Sync _coachPayload.spread so follow-up chat sees updated state
  if (_coachPayload && state.SPREAD) {
    _coachPayload.spread = (window._smartPlanRouteRods
      ? Object.entries(window._smartPlanRouteRods).flatMap(([routeName, rods]) =>
          rods.map(r => ({
            route: routeName, side: r.side, rod: r.rod||'',
            lure: r.lure||'', color: r.color||'',
            depth: r.depth||'', lead: r.lead||'',
            notes: (r.notes||'').slice(0,80),
          }))
        )
      : state.SPREAD.map(r => ({
          side: r.side, lure: r.lure||'', color: r.color||'',
          depth: r.depth||'', lead: r.lead||'', notes: (r.notes||'').slice(0,80),
        }))
    );
  }

  renderSpread();
}
