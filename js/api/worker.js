/**
 * js/api/worker.js — Centralized Worker client (Phase 5 frontend structure)
 *
 * Single place for CF_WORKER_URL and all fetch calls to trollmap-worker.
 * Provides typed paths, timeouts, auth header handling, and consistent error shape.
 *
 * Previously, 30+ files used template literals `${CF_WORKER_URL}/path` directly,
 * duplicating URL construction, timeout handling, and auth logic.
 *
 * Usage:
 *   import { workerFetch, getLake, getRamps, CF_WORKER_URL } from '../api/worker.js';
 *   const data = await getLake('Lake Wateree, SC');
 *
 * The client is intentionally behavior-preserving: it uses same headers, same
 * cache settings, and same error handling as previous direct fetches.
 */

import { CF_WORKER_URL as CF_URL } from '../core/state.js';

export const CF_WORKER_URL = CF_URL;
const DEFAULT_TIMEOUT_MS = 15000;

function getWorkerUrl() {
  // Allow override via window for Pages preview / local dev
  if (typeof window !== 'undefined') {
    return (
      window.TROLLMAP_WORKER_URL ||
      window.TROLLMAP_WORKER_BASE ||
      window.WORKER_URL ||
      window.API_BASE ||
      window.CF_WORKER_URL ||
      CF_URL ||
      'https://trollmap-worker.colonal1981.workers.dev'
    ).replace(/\/$/, '');
  }
  return (CF_URL || 'https://trollmap-worker.colonal1981.workers.dev').replace(/\/$/, '');
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, {
      ...opts,
      signal: controller ? controller.signal : opts.signal,
    });
    return res;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function workerFetch(path, opts = {}) {
  const base = getWorkerUrl();
  const url = path.startsWith('http') ? path : `${base}${path.startsWith('/') ? '' : '/'}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
  };
  // Add auth token if available in localStorage or env
  try {
    const token = localStorage.getItem('trollmap_sync_token') || localStorage.getItem('SYNC_TOKEN');
    if (token) headers['Authorization'] = `Bearer ${token}`;
  } catch (_) {}
  const res = await fetchWithTimeout(url, { ...opts, headers }, opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  return res;
}

export async function workerGetJson(path, opts = {}) {
  const res = await workerFetch(path, { method: 'GET', ...opts });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Worker GET ${path} ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

export async function workerPostJson(path, body, opts = {}) {
  const res = await workerFetch(path, {
    method: 'POST',
    body: JSON.stringify(body),
    ...opts,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Worker POST ${path} ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// ── Typed helpers for common routes ───────────────────────────────────────

export const getLake = (lakeName) => workerGetJson(`/lake?lake=${encodeURIComponent(lakeName)}`);
export const getLakeIntel = (lakeName) => workerGetJson(`/lake-intel?lake=${encodeURIComponent(lakeName)}`);
export const getLakeClarity = (lakeName, date) =>
  workerGetJson(`/lake-clarity?lake=${encodeURIComponent(lakeName)}&date=${encodeURIComponent(date || new Date().toISOString().slice(0, 10))}`);

export const getRamps = (state = 'SC', forceRefresh = false) =>
  workerGetJson(`/ramps?state=${encodeURIComponent(state)}${forceRefresh ? '&refresh=1' : ''}`);
export const getPaddle = (state = 'SC') => workerGetJson(`/paddle?state=${encodeURIComponent(state)}`);
export const getBankPier = (state = 'SC') => workerGetJson(`/bank-pier?state=${encodeURIComponent(state)}`);
export const getAttractors = (state = 'SC') => workerGetJson(`/attractors?state=${encodeURIComponent(state)}`);

export const getRiver = (river, lat, lon) => {
  const params = new URLSearchParams({ river });
  if (lat != null) params.set('lat', String(lat));
  if (lon != null) params.set('lon', String(lon));
  return workerGetJson(`/river?${params}`);
};

export const groqQuery = (messages, opts = {}) =>
  workerPostJson('/groq-query', { messages, ...opts });

export const coachPlan = (payload, previousSuggestions = []) =>
  workerPostJson('/coach-plan', { payload, previousSuggestions });

// Research pipeline — typed wrappers
export const researchDiscover = (body) => workerPostJson('/research/discover', body);
export const researchProxyDownload = (url) =>
  workerGetJson(`/research/proxy-download?url=${encodeURIComponent(url)}`);
export const researchProxyDownloadBatch = (body) => workerPostJson('/research/proxy-download-batch', body);
export const researchDeterministicFacts = (body) => workerPostJson('/research/deterministic-facts', body);
export const researchGetNormalized = (lake) =>
  workerGetJson(`/research/get-normalized?lake=${encodeURIComponent(lake)}`);
export const researchSaveNormalized = (body) => workerPostJson('/research/save-normalized', body);
export const researchAnalyzeFacts = (body) => workerPostJson('/research/analyze-facts', body);
export const researchDedupe = (body) => workerPostJson('/research/dedupe-contradictions', body);
export const researchAgentLlm = (body) => workerPostJson('/research/agent-llm', body);
export const researchLimnologyData = (body) => workerPostJson('/research/limnology-data', body);
export const researchList = () => workerGetJson('/research/list');
export const researchGet = (lake) => workerGetJson(`/research/get?lake=${encodeURIComponent(lake)}`);
export const researchSave = (body) => workerPostJson('/research/save', body);
export const researchPackage = (lake, file) =>
  file
    ? workerGetJson(`/research/package?lake=${encodeURIComponent(lake)}&file=${encodeURIComponent(file)}`)
    : workerGetJson(`/research/package?lake=${encodeURIComponent(lake)}`);
export const sharedCheck = (body) => workerPostJson('/research/shared/check', body);
export const sharedStore = (body) => workerPostJson('/research/shared/store', body);
export const sharedQuery = (body) => workerPostJson('/research/shared/query', body);
export const visionScan = (body) => workerPostJson('/research/vision-scan', body);
export const visionScanSave = (body) => workerPostJson('/research/vision-scan-save', body);
export const visionScanStatus = (lakeName) =>
  workerGetJson(`/research/vision-scan-status?lake=${encodeURIComponent(lakeName)}`);

// Chartpacks / contours
export const getContourGeojson = (lakeKey) =>
  workerFetch(`/chartpacks/${encodeURIComponent(lakeKey)}/contours.geojson?v=${Date.now()}`, {
    method: 'GET',
    headers: {},
  }).then((r) => {
    if (!r.ok) throw new Error(`contour ${lakeKey} ${r.status}`);
    return r.json();
  });

export const getSupplementalLayer = (lakeKey, layer) =>
  workerFetch(`/chartpacks/supplemental/${encodeURIComponent(lakeKey)}/${encodeURIComponent(layer)}.geojson?v=${Date.now()}`, {
    method: 'GET',
  }).then((r) => {
    if (!r.ok) throw new Error(`supplemental ${lakeKey}/${layer} ${r.status}`);
    return r.json();
  });

// For backward compat, expose CF_WORKER_URL on window if needed
if (typeof window !== 'undefined') {
  window.CF_WORKER_URL = window.CF_WORKER_URL || CF_URL;
}

console.log('[api/worker] module ready — centralized client');
