// Worker/router.js — Phase 2/3 refactor: route table + orphan decisions
// Behavior-preserving: same paths as before, but organized and documented
// Orphan routes from audit are now grouped in admin section with deprecation notes

import { CORS, JSON_HEADERS, TEXT_HEADERS, callLLM, isAuthorized } from './worker-core.js';
import { handleGisRoute } from './core/arcgis.js';

// GIS source definitions are now in core/arcgis.js via handleGisRoute, but we keep source maps here
// for backward compat and for fixture comparison. Actual handling delegated to handleGisRoute.

export const GIS_ROUTES = {
  '/ramps': { cachePrefix: 'ramps', ttlDays: 7 },
  '/paddle': { cachePrefix: 'paddle', ttlDays: 7 },
  '/bank-pier': { cachePrefix: 'bankpier', ttlDays: 7 },
  '/attractors': { cachePrefix: 'attractors', ttlDays: 7 },
};

// Research routes that are actively used by frontend (live)
// Must preserve exact paths and response shapes
export const LIVE_RESEARCH_ROUTES = [
  '/research/discover',
  '/research/proxy-download',
  '/research/proxy-download-batch',
  '/research/deterministic-facts',
  '/research/get-normalized',
  '/research/save-normalized',
  '/research/analyze-facts',
  '/research/dedupe-contradictions',
  '/research/agent-llm',
  '/research/validation-pass',
  '/research/limnology-data',
  '/research/get',
  '/research/save',
  '/research/list',
  '/research/delete',
  '/research/delete-normalized-doc',
  '/research/package',
  '/research/shared/check',
  '/research/shared/store',
  '/research/shared/query',
  '/research/vision-scan',
  '/research/vision-scan-save',
  '/research/vision-scan-status',
  '/lake-research',
  '/lakes/list',
];

// Orphan / admin routes — no frontend caller as of 2026-07-22 audit
// Decision per REFACTOR_AUDIT.md Phase 3:
// - Keep as admin behind auth or with deprecation header if used via curl/runbook
// - Delete audit-plan (superseded by coach-plan)
// - Keep duke-flow-arrivals, dominion-saluda, rivers, lake-intel-sources as debug (move to admin)
export const ORPHAN_ROUTES = {
  // Research orphans — admin only, may be used via curl for manual research
  '/research/dataset-hunt': { recommendation: 'keep_admin', reason: 'EPA NSCEP + SCDNR annual report discovery, manual via curl', action: 'keep behind auth or move to /admin' },
  '/research/gap-analysis': { recommendation: 'keep_admin', reason: 'Gap analysis for research', action: 'keep admin' },
  '/research/gap-search': { recommendation: 'keep_admin', reason: 'Targeted Tavily search for null field', action: 'keep admin' },
  '/research/map-facts': { recommendation: 'keep_admin', reason: 'Mapping agent', action: 'keep admin' },
  '/research/thermocline-search': { recommendation: 'keep_admin', reason: 'Thermocline guide article search, now also triggered inline by limnology-data when no depth data', action: 'keep admin, used internally' },
  '/research/approve': { recommendation: 'keep', reason: 'Mark profile verified — should wire button in research UI', action: 'keep, wire UI button in future PR' },
  '/research/shared/publish': { recommendation: 'keep_admin', reason: 'Shared registry publish', action: 'keep admin, finish feature or hide' },
  '/research/shared/status': { recommendation: 'keep_admin', reason: 'Shared registry status', action: 'keep admin' },
  '/research/shared/quarantine': { recommendation: 'keep_admin', reason: 'Shared registry quarantine', action: 'keep admin' },
  // Orphan debug routes — move to admin
  '/audit-plan': { recommendation: 'delete', reason: 'Superseded by /coach-plan, no frontend caller', action: 'DELETED in this refactor (Phase 3)' },
  '/duke-flow-arrivals': { recommendation: 'keep_admin', reason: 'Raw Duke scheduled dam releases, used by /river indirectly', action: 'keep as debug, move to admin' },
  '/dominion-saluda': { recommendation: 'keep_admin', reason: 'Raw Dominion color status, used by /river indirectly', action: 'keep as debug' },
  '/rivers': { recommendation: 'keep_admin', reason: 'List all rivers', action: 'keep as debug' },
  '/lake-intel-sources': { recommendation: 'keep_admin', reason: 'Trust-tier source registry debug', action: 'keep as debug' },
  '/chartpacks/list': { recommendation: 'keep_admin', reason: 'List all uploaded chartpack lakes', action: 'keep, move to admin' },
  '/chartpacks/supplemental-audit': { recommendation: 'keep_admin', reason: 'Audit which catalog keys have contour data', action: 'keep admin' },
  '/debug/regs-cache': { recommendation: 'keep_admin', reason: 'Regs cache debug', action: 'keep admin' },
  '/sync/migrate': { recommendation: 'keep_auth', reason: 'One-shot bulk import, auth required', action: 'keep behind auth' },
};

// Main router table — order matters (more specific first)
// Each entry: { method, path (exact string or regex or prefix), handlerName, section }
export const ROUTE_TABLE = [
  // CORS preflight handled before table
  { method: 'POST', path: '/identify-catch', section: 'ai', note: 'Gemini fish ID' },
  { method: 'POST', path: '/identify-catch-v2', section: 'ai', note: 'v2 wrapper' },
  { method: 'POST', path: '/coach-plan', section: 'ai', note: 'Groq coach' },
  { method: 'POST', path: '/groq-query', section: 'ai', note: 'LLM provider chain' },
  // Research live (frontend actively uses)
  { method: 'POST', path: '/research/discover', section: 'research_live' },
  { method: 'GET', path: '/research/proxy-download', section: 'research_live' },
  { method: 'GET', path: '/research/get-normalized', section: 'research_live' },
  { method: 'POST', path: '/research/save-normalized', section: 'research_live' },
  { method: 'POST', path: '/research/analyze-facts', section: 'research_live' },
  { method: 'POST', path: '/research/dedupe-contradictions', section: 'research_live' },
  { method: 'POST', path: '/research/map-facts', section: 'research_orphan_admin' },
  { method: 'POST', path: '/research/gap-analysis', section: 'research_orphan_admin' },
  { method: 'POST', path: '/research/gap-search', section: 'research_orphan_admin' },
  { method: 'POST', path: '/research/agent', section: 'research_live' },
  { method: 'POST', path: '/research/agent-llm', section: 'research_live' },
  { method: 'GET', path: '/research/list', section: 'research_live' },
  { method: 'GET', path: '/lakes/list', section: 'research_live', alias: '/research/list' },
  { method: 'GET', path: '/research/get', section: 'research_live' },
  { method: 'POST', path: '/research/save', section: 'research_live' },
  { method: 'POST', path: '/research/approve', section: 'research_orphan' },
  { method: 'POST', path: '/research/delete', section: 'research_live' },
  { method: 'POST', path: '/research/delete-normalized-doc', section: 'research_live' },
  { method: 'POST', path: '/research/proxy-download-batch', section: 'research_live' },
  { method: 'POST', path: '/research/shared/check', section: 'research_live' },
  { method: 'POST', path: '/research/shared/store', section: 'research_live' },
  { method: 'POST', path: '/research/shared/query', section: 'research_live' },
  { method: 'POST', path: '/research/shared/publish', section: 'research_orphan_admin' },
  { method: 'GET', path: '/research/shared/status', section: 'research_orphan_admin' },
  { method: 'POST', path: '/research/shared/quarantine', section: 'research_orphan_admin' },
  { method: 'GET', path: '/research/package', section: 'research_live' },
  { method: 'GET', path: '/lake-research', section: 'research_live' },
  { method: 'GET', path: /^\/lakes\/.+/, section: 'research_live', note: 'shortcut /lakes/<id>' },
  { method: 'POST', path: '/research/validation-pass', section: 'research_live' },
  { method: 'POST', path: '/research/vision-scan', section: 'research_live', note: 'was 404, now wired P0' },
  { method: 'POST', path: '/research/vision-scan-save', section: 'research_live' },
  { method: 'GET', path: '/research/vision-scan-status', section: 'research_live' },
  { method: 'POST', path: '/research/thermocline-search', section: 'research_orphan_admin' },
  { method: 'POST', path: '/research/limnology-data', section: 'research_live' },
  { method: 'POST', path: '/research/deterministic-facts', section: 'research_live' },
  { method: 'POST', path: '/research/dataset-hunt', section: 'research_orphan_admin' },
  // GIS — now deduped via core/arcgis.js
  { method: 'GET', path: '/ramps', section: 'gis', note: 'SC/NC/GA/TN DNR boat ramps, cached 7d in R2, unified helper' },
  { method: 'GET', path: '/paddle', section: 'gis' },
  { method: 'GET', path: '/bank-pier', section: 'gis' },
  { method: 'GET', path: '/attractors', section: 'gis' },
  // Lake live
  { method: 'GET', path: '/duke', section: 'lake_live' },
  { method: 'GET', path: '/usgs', section: 'lake_live' },
  { method: 'GET', path: '/lake-clarity', section: 'lake_live' },
  { method: 'GET', path: '/lake-intel-sources', section: 'lake_live_admin' },
  { method: 'GET', path: '/lake-intel', section: 'lake_live' },
  { method: 'GET', path: '/river', section: 'lake_live', note: 'river safety with Duke/Dominion schedule + USGS + surge estimate' },
  { method: 'GET', path: '/duke-flow-arrivals', section: 'lake_live_admin' },
  { method: 'GET', path: '/dominion-saluda', section: 'lake_live_admin' },
  { method: 'GET', path: '/rivers', section: 'lake_live_admin' },
  { method: 'GET', path: '/lake', section: 'lake_live' },
  // Sync
  { method: 'POST', path: '/sync/migrate', section: 'sync_auth' },
  { method: 'DELETE', path: /^\/sync\/purge-type\/.+/, section: 'sync_auth' },
  { method: 'GET', path: '/sync/list-updates', section: 'sync_auth' },
  { method: 'GET', path: /^\/sync\/item\/.+/, section: 'sync_auth' },
  { method: 'POST', path: /^\/sync\/item\/.+/, section: 'sync_auth' },
  { method: 'DELETE', path: /^\/sync\/item\/.+/, section: 'sync_auth' },
  // Contours
  { method: 'GET', path: /^\/contours\/.+\/geojson$/, section: 'chartpacks' },
  { method: 'POST', path: /^\/contours\/.+\/geojson$/, section: 'chartpacks_auth' },
  { method: 'PUT', path: /^\/contours\/.+\/geojson$/, section: 'chartpacks_auth' },
  // Chartpacks
  { method: 'GET', path: '/chartpacks/lake-boundary', section: 'chartpacks' },
  { method: 'GET', path: '/chartpacks/list', section: 'admin' },
  { method: 'GET', path: '/debug/regs-cache', section: 'admin' },
  { method: 'GET', path: '/chartpacks/supplemental-audit', section: 'admin' },
  { method: 'GET', path: /^\/chartpacks\/.+\/index\.json$/, section: 'chartpacks' },
  { method: 'GET', path: /^\/chartpacks\/.+\/.+$/, section: 'chartpacks' },
  { method: 'POST', path: /^\/chartpacks\/.+\/.+$/, section: 'chartpacks_auth' },
  // Root
  { method: 'GET', path: '/', section: 'root', note: 'version + changelog (should move to /version)' },
];

// Helper to match route
export function matchRoute(method, pathname) {
  for (const route of ROUTE_TABLE) {
    if (route.method && route.method !== method) continue;
    if (typeof route.path === 'string') {
      if (route.path === pathname) return route;
    } else if (route.path instanceof RegExp) {
      if (route.path.test(pathname)) return route;
    }
  }
  return null;
}

// For smoke checklist and audit: list all paths
export function listAllPaths() {
  return ROUTE_TABLE.map(r => `${r.method} ${r.path instanceof RegExp ? r.path.toString() : r.path} [${r.section}]`);
}
