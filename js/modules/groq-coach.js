/**
 * groq-coach.js — Iterative Groq fishing coach UI.
 *
 * Replaces the one-shot /audit-plan call with an iterative loop:
 *   1. Send full context + plan to /coach-plan
 *   2. Groq returns ONE suggestion
 *   3. User sees suggestion with confidence + reasons + warnings + evidence sources
 *   4. User accepts or rejects
 *   5. If accepted → apply change to plan, send updated plan back
 *   6. Repeat until Groq says has_suggestion: false or user stops
 *
 * Allowed fields whitelist enforced both in worker prompt and here on accept.
 */

import { state } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { renderSpread } from './spread-builder.js';
import { newRodRow } from '../utils/rod-row.js';

const CF_WORKER_URL = window.CF_WORKER_URL || 'https://trollmap-worker.colonal1981.workers.dev';

// ── State ─────────────────────────────────────────────────────────────────────
let _coachPayload      = null;   // full context payload sent to worker
let _previousSuggestions = [];   // accepted suggestions — sent back so Groq doesn't repeat
let _currentSuggestion = null;   // last suggestion returned
let _coachRunning      = false;
let _iterationCount    = 0;
const MAX_ITERATIONS   = 6;      // hard stop after 6 rounds

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start a coaching session.
 * Called by smart-plan.js after the plan is built.
 *
 * @param {object} coachPayload - built by buildGroqCoachPayload() in smart-plan-context.js
 */
export function startCoachSession(coachPayload) {
  _coachPayload       = coachPayload;
  _previousSuggestions = [];
  _currentSuggestion  = null;
  _coachRunning       = false;
  _iterationCount     = 0;

  renderCoachPanel();
  showCoachPanel();
}

/**
 * Stop the coaching session and hide the panel.
 */
export function stopCoachSession() {
  _coachRunning = false;
  hideCoachPanel();
}

// ── Panel rendering ───────────────────────────────────────────────────────────

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
    panel.style.cssText = `
      position:fixed;bottom:80px;right:16px;width:340px;max-height:70vh;
      overflow-y:auto;z-index:2000;background:var(--panel);
      border:1px solid var(--accent2);border-radius:10px;
      box-shadow:0 4px 24px rgba(0,0,0,.6);display:none;font-family:system-ui;
    `;
    document.body.appendChild(panel);
  }

  panel.innerHTML = `
    <div style="padding:12px 14px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center">
      <span style="font-weight:700;font-size:13px;color:var(--accent2)">🎣 Fishing Coach</span>
      <div style="display:flex;gap:8px;align-items:center">
        <span style="font-size:10px;color:var(--muted)" id="coachIterCount"></span>
        <button id="coachCloseBtn" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px;padding:0">✕</button>
      </div>
    </div>
    <div id="coachBody" style="padding:12px 14px">
      <p style="color:var(--muted);font-size:12px;margin:0">
        Your plan is ready. Click <b>Start Coach</b> to get suggestions from Groq — one at a time, you decide each one.
      </p>
      <button id="coachStartBtn" style="margin-top:10px;width:100%;padding:8px;font-weight:700;font-size:12px;border:1px solid var(--accent2);border-radius:6px;background:var(--accent2);color:#062d00;cursor:pointer">
        Start Coach →
      </button>
    </div>
  `;

  panel.querySelector('#coachCloseBtn')?.addEventListener('click', stopCoachSession);
  panel.querySelector('#coachStartBtn')?.addEventListener('click', runNextCoachIteration);
}

async function runNextCoachIteration() {
  if (_coachRunning) return;
  if (_iterationCount >= MAX_ITERATIONS) {
    renderCoachDone('Maximum iterations reached. Your plan has been optimized.');
    return;
  }

  _coachRunning = true;
  _iterationCount++;

  const body = document.getElementById('coachBody');
  const iterEl = document.getElementById('coachIterCount');
  if (iterEl) iterEl.textContent = `${_iterationCount}/${MAX_ITERATIONS}`;

  if (body) {
    body.innerHTML = `
      <div style="text-align:center;padding:20px 0">
        <div style="font-size:22px;margin-bottom:8px">🎣</div>
        <div style="font-size:12px;color:var(--muted)">Groq is reviewing your plan...</div>
      </div>
    `;
  }

  try {
    const r = await fetch(`${CF_WORKER_URL}/coach-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payload: _coachPayload,
        previousSuggestions: _previousSuggestions,
      }),
    });

    const data = await r.json();
    _coachRunning = false;

    if (!data.success) {
      renderCoachError(data.error || 'Coach request failed');
      return;
    }

    if (!data.has_suggestion) {
      renderCoachDone(data.no_suggestion_reason || 'No further improvements found. Your plan looks solid.');
      return;
    }

    _currentSuggestion = data.suggestion;
    renderSuggestion(data.suggestion);

  } catch (e) {
    _coachRunning = false;
    renderCoachError(e.message);
  }
}

function renderSuggestion(s) {
  const body = document.getElementById('coachBody');
  if (!body) return;

  const confidencePct = Math.round((s.confidence || 0) * 100);
  const confColor = confidencePct >= 80 ? 'var(--good)' : confidencePct >= 60 ? 'var(--warn)' : 'var(--bad)';

  const reasonsHtml = (s.reasons || []).map(r =>
    `<div style="color:var(--good);font-size:11px;margin:2px 0">✓ ${esc(r)}</div>`
  ).join('');

  const warningsHtml = (s.warnings || []).map(w =>
    `<div style="color:var(--warn);font-size:11px;margin:2px 0">⚠ ${esc(w)}</div>`
  ).join('');

  const evidenceHtml = (s.evidence_sources || []).map(e =>
    `<span style="font-size:10px;background:var(--panel2);border:1px solid var(--line);border-radius:4px;padding:1px 5px;margin:1px">${esc(e.replace(/_/g,' '))}</span>`
  ).join('');

  const targetStr = [
    s.phase ? `Phase ${s.phase}` : null,
    s.rod || null,
  ].filter(Boolean).join(' · ');

  body.innerHTML = `
    <div style="font-size:11px;color:var(--muted);margin-bottom:8px">Suggestion ${_iterationCount}</div>

    <div style="background:var(--panel2);border-radius:8px;padding:10px;margin-bottom:10px">
      <div style="font-size:10px;color:var(--muted);margin-bottom:4px">${esc(targetStr || 'All phases')}</div>
      <div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:6px">
        Change <span style="color:var(--accent2)">${esc(s.field?.replace(/_/g,' ') || '')}</span>
      </div>
      <div style="display:flex;gap:6px;align-items:center;font-size:12px;margin-bottom:8px">
        <span style="color:var(--bad);text-decoration:line-through">${esc(String(s.current_value || ''))}</span>
        <span style="color:var(--muted)">→</span>
        <span style="color:var(--good);font-weight:700">${esc(String(s.recommended_value || ''))}</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
        <div style="font-size:11px;color:var(--muted)">Confidence:</div>
        <div style="font-size:13px;font-weight:700;color:${confColor}">${confidencePct}%</div>
      </div>
      ${reasonsHtml}
      ${warningsHtml}
      ${evidenceHtml ? `<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:3px">${evidenceHtml}</div>` : ''}
    </div>

    <div style="display:flex;gap:8px">
      <button id="coachAcceptBtn" style="flex:1;padding:8px;font-weight:700;font-size:12px;border:1px solid var(--good);border-radius:6px;background:var(--good);color:#000;cursor:pointer">
        ✓ Accept
      </button>
      <button id="coachRejectBtn" style="flex:1;padding:8px;font-weight:700;font-size:12px;border:1px solid var(--line);border-radius:6px;background:var(--panel2);color:var(--text);cursor:pointer">
        ✗ Skip
      </button>
    </div>
    <button id="coachStopBtn" style="width:100%;margin-top:6px;padding:6px;font-size:11px;border:none;background:none;color:var(--muted);cursor:pointer;text-decoration:underline">
      Done — lock plan
    </button>
  `;

  body.querySelector('#coachAcceptBtn')?.addEventListener('click', acceptSuggestion);
  body.querySelector('#coachRejectBtn')?.addEventListener('click', rejectSuggestion);
  body.querySelector('#coachStopBtn')?.addEventListener('click', () => {
    renderCoachDone('Plan locked. Good fishing!');
  });
}

function acceptSuggestion() {
  if (!_currentSuggestion) return;
  const s = _currentSuggestion;

  // Apply the change to the plan
  applyCoachSuggestion(s);

  // Record it so Groq doesn't repeat
  _previousSuggestions.push({
    field:             s.field,
    phase:             s.phase,
    rod:               s.rod,
    current_value:     s.current_value,
    recommended_value: s.recommended_value,
  });

  // Update the payload with current plan state
  updateCoachPayloadFromPlan();

  // Run next iteration
  runNextCoachIteration();
}

function rejectSuggestion() {
  // Skip this suggestion without applying — still track it so Groq doesn't repeat
  if (_currentSuggestion) {
    _previousSuggestions.push({
      field:             _currentSuggestion.field,
      phase:             _currentSuggestion.phase,
      rod:               _currentSuggestion.rod,
      current_value:     _currentSuggestion.current_value,
      recommended_value: `[REJECTED] ${_currentSuggestion.recommended_value}`,
    });
  }
  runNextCoachIteration();
}

function renderCoachDone(message) {
  const body = document.getElementById('coachBody');
  if (!body) return;
  body.innerHTML = `
    <div style="text-align:center;padding:16px 0">
      <div style="font-size:28px;margin-bottom:8px">✅</div>
      <div style="font-size:12px;color:var(--text);font-weight:600;margin-bottom:6px">Plan Optimized</div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:12px">${esc(message)}</div>
      <div style="font-size:10px;color:var(--muted)">${_previousSuggestions.filter(s => !s.recommended_value?.startsWith('[REJECTED]')).length} suggestions accepted · ${_previousSuggestions.filter(s => s.recommended_value?.startsWith('[REJECTED]')).length} skipped</div>
    </div>
    <button id="coachCloseBtn2" style="width:100%;padding:8px;font-size:12px;border:1px solid var(--line);border-radius:6px;background:var(--panel2);color:var(--text);cursor:pointer">
      Close
    </button>
  `;
  body.querySelector('#coachCloseBtn2')?.addEventListener('click', stopCoachSession);
}

function renderCoachError(message) {
  const body = document.getElementById('coachBody');
  if (!body) return;
  body.innerHTML = `
    <div style="color:var(--bad);font-size:12px;margin-bottom:10px">⚠ Coach error: ${esc(message)}</div>
    <button id="coachRetryBtn" style="width:100%;padding:8px;font-size:12px;border:1px solid var(--accent2);border-radius:6px;background:transparent;color:var(--accent2);cursor:pointer">
      Retry
    </button>
  `;
  body.querySelector('#coachRetryBtn')?.addEventListener('click', runNextCoachIteration);
}

// ── Apply suggestion to plan ──────────────────────────────────────────────────

function applyCoachSuggestion(s) {
  const { field, phase, rod, recommended_value } = s;

  // Helper to find rod rows for a phase/rod combination
  const getRodRows = () => {
    return state.SPREAD?.filter(r => {
      const phaseMatch = !phase || r.notes?.includes(`[Ph${phase}:`);
      const rodMatch   = !rod || rod === 'Both' || r.side?.includes(rod);
      return phaseMatch && rodMatch;
    }) || [];
  };

  switch (field) {
    case 'lure':
      getRodRows().forEach(r => { r.lure = recommended_value; });
      break;
    case 'lure_color':
      getRodRows().forEach(r => { r.color = recommended_value; });
      break;
    case 'lead_length':
      getRodRows().forEach(r => { r.lead = String(recommended_value); });
      break;
    case 'trolling_speed': {
      const speedEl = document.getElementById('planSpeed');
      if (speedEl) speedEl.value = String(recommended_value);
      break;
    }
    case 'target_depth':
      getRodRows().forEach(r => { r.depth = String(recommended_value); });
      break;
    case 'inline_weight':
      getRodRows().forEach(r => { r.notes = (r.notes || '') + ` · Coach: add ${recommended_value} inline weight`; });
      break;
    case 'casting_stop_suggestion': {
      const notesEl = document.getElementById('planNotes');
      if (notesEl) notesEl.value = (notesEl.value || '') + `\nCoach suggestion: ${recommended_value}`;
      break;
    }
    case 'lure_size':
      getRodRows().forEach(r => { r.notes = (r.notes || '') + ` · Coach: use ${recommended_value}`; });
      break;
    default:
      // For other fields, append to notes
      getRodRows().forEach(r => { r.notes = (r.notes || '') + ` · Coach: ${field} → ${recommended_value}`; });
  }

  renderSpread();
}

/**
 * After accepting a suggestion, update the coach payload to reflect
 * the current plan state so Groq has accurate data next iteration.
 */
function updateCoachPayloadFromPlan() {
  if (!_coachPayload?.phases) return;
  // Update speed
  const speed = parseFloat(document.getElementById('planSpeed')?.value);
  if (!isNaN(speed)) {
    _coachPayload.phases?.forEach(p => { if (p.speed) p.speed = speed; });
  }
  // Update rod data from spread
  _coachPayload.phases?.forEach((phase, i) => {
    const phaseNum = i + 1;
    const rodPair = state.SPREAD?.filter(r => r.notes?.includes(`[Ph${phaseNum}:`)).slice(0, 2) || [];
    if (rodPair[0]) {
      phase.port = { lure: rodPair[0].lure, color: rodPair[0].color, lead: rodPair[0].lead, depth: rodPair[0].depth };
    }
    if (rodPair[1]) {
      phase.starboard = { lure: rodPair[1].lure, color: rodPair[1].color, lead: rodPair[1].lead, depth: rodPair[1].depth };
    }
  });
}
