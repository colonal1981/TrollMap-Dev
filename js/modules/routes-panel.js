/**
 * routes-panel.js — Right slide-in panel shell with 3 tabs:
 *   Capture | Contour Data | Route Builder
 *
 * Builds the panel DOM, wires the toolbar button, and calls each
 * sub-module to populate its tab.
 */

import { buildContourDataPanel }  from './contour-data.js';
import { buildRouteBuilderPanel } from './route-builder.js';

const TABS = [
  { id: 'contourData',  label: '🗂 Contour Data'   },
  { id: 'routeBuilder', label: '🗺️ Route Builder'  },
];

function buildShell() {
  const existing = document.getElementById('routesPanelShell');
  if (existing) return existing;

  const shell = document.createElement('div');
  shell.id = 'routesPanelShell';
  shell.style.cssText = `
    position: fixed;
    top: var(--topH, 48px);
    right: 0;
    bottom: var(--navH, 54px);
    width: 340px;
    max-width: 92vw;
    background: rgba(11,22,35,.98);
    border-left: 1px solid var(--line);
    z-index: 900;
    display: none;
    flex-direction: column;
    overflow: hidden;
    box-shadow: -4px 0 24px rgba(0,0,0,.6);
    font-size: 12px;
  `;

  // Header
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:9px 14px;border-bottom:1px solid var(--line);flex-shrink:0;background:var(--panel)';
  header.innerHTML = `
    <span style="color:var(--accent);font-weight:700;font-size:13px">🗺️ Contours &amp; Routes</span>
    <button id="rpClose" style="background:none;border:none;color:var(--muted);font-size:18px;cursor:pointer;padding:0 4px;line-height:1">✕</button>
  `;
  shell.appendChild(header);

  // Tab bar
  const tabBar = document.createElement('div');
  tabBar.id = 'rpTabBar';
  tabBar.style.cssText = 'display:flex;border-bottom:1px solid var(--line);flex-shrink:0;background:var(--panel)';
  TABS.forEach(tab => {
    const btn = document.createElement('button');
    btn.dataset.tab = tab.id;
    btn.className = 'rp-tab';
    btn.textContent = tab.label;
    btn.style.cssText = `flex:1;height:34px;font-size:10px;font-weight:600;border:none;border-bottom:2px solid transparent;background:transparent;color:var(--muted);cursor:pointer;padding:0 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis`;
    tabBar.appendChild(btn);
  });
  shell.appendChild(tabBar);

  // Body — one div per tab
  const body = document.createElement('div');
  body.style.cssText = 'flex:1;overflow-y:auto;position:relative';
  TABS.forEach(tab => {
    const pane = document.createElement('div');
    pane.id = `rpPane-${tab.id}`;
    pane.style.cssText = 'display:none;padding:10px 14px';
    body.appendChild(pane);
  });
  shell.appendChild(body);

  document.getElementById('panel-map')?.appendChild(shell);
  return shell;
}

function switchTab(shell, tabId) {
  shell.querySelectorAll('.rp-tab').forEach(btn => {
    const active = btn.dataset.tab === tabId;
    btn.style.color = active ? 'var(--accent2)' : 'var(--muted)';
    btn.style.borderBottom = active ? '2px solid var(--accent2)' : '2px solid transparent';
    btn.style.fontWeight = active ? '700' : '600';
    btn.style.background = active ? 'rgba(118,255,3,.06)' : 'transparent';
  });
  TABS.forEach(tab => {
    const pane = document.getElementById(`rpPane-${tab.id}`);
    if (pane) pane.style.display = tab.id === tabId ? 'block' : 'none';
  });
}

let panelOpen = false;
let tabsPopulated = {};

function openPanel(shell, tabId) {
  shell.style.display = 'flex';
  panelOpen = true;
  switchTab(shell, tabId);

  // Lazy-populate tab content on first open
  if (!tabsPopulated[tabId]) {
    const pane = document.getElementById(`rpPane-${tabId}`);
    if (pane) {
      if (tabId === 'contourData')  buildContourDataPanel(pane);
      if (tabId === 'routeBuilder') buildRouteBuilderPanel(pane);
    }
    tabsPopulated[tabId] = true;
  }

  // Shrink map pane to avoid overlap
  const mapEl = document.getElementById('map');
  if (mapEl) {
    mapEl.style.marginRight = '340px';
    setTimeout(() => window.MAP?.invalidateSize?.(), 100);
  }
}

function closePanel(shell) {
  shell.style.display = 'none';
  panelOpen = false;
  const mapEl = document.getElementById('map');
  if (mapEl) {
    mapEl.style.marginRight = '';
    setTimeout(() => window.MAP?.invalidateSize?.(), 100);
  }
}

function init() {
  const shell = buildShell();

  // Toolbar button
  document.getElementById('btnContourRoutes')?.addEventListener('click', () => {
    if (panelOpen) closePanel(shell);
    else openPanel(shell, 'contourData');
  });

  // Close button
  document.getElementById('rpClose')?.addEventListener('click', () => closePanel(shell));

  // Tab clicks
  shell.querySelectorAll('.rp-tab').forEach(btn => {
    btn.addEventListener('click', () => openPanel(shell, btn.dataset.tab));
  });

  // Legacy button redirects → open panel on correct tab
  document.getElementById('btnSmartRoute')?.addEventListener('click', () => openPanel(shell, 'routeBuilder'));
  document.getElementById('btnCloudChartpacks')?.addEventListener('click', () => openPanel(shell, 'contourData'));
  document.getElementById('btnPinchFinder')?.addEventListener('click', () => openPanel(shell, 'routeBuilder'));

  // GPS popup — position above the GPS button
  const gpsPopup = document.getElementById('gpsPanelPopup');
  const gpsBtn = document.getElementById('btnGpsPanel');
  gpsBtn?.addEventListener('click', (e) => {
    if (!gpsPopup) return;
    const rect = gpsBtn.getBoundingClientRect();
    gpsPopup.style.display = gpsPopup.style.display === 'none' ? 'block' : 'none';
    if (gpsPopup.style.display === 'block') {
      gpsPopup.style.left = rect.left + 'px';
      gpsPopup.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
      gpsPopup.style.right = 'auto';
      gpsPopup.style.top = 'auto';
      gpsBtn.style.borderColor = 'var(--accent)';
      gpsBtn.style.color = 'var(--accent)';
    } else {
      gpsBtn.style.borderColor = '';
      gpsBtn.style.color = '';
    }
  });
  document.getElementById('gpsPopupClose')?.addEventListener('click', () => {
    if (gpsPopup) gpsPopup.style.display = 'none';
    if (gpsBtn) { gpsBtn.style.borderColor = ''; gpsBtn.style.color = ''; }
  });
  // Close GPS popup when clicking outside
  document.addEventListener('click', (e) => {
    if (gpsPopup && gpsPopup.style.display === 'block' &&
        !gpsPopup.contains(e.target) && e.target !== gpsBtn) {
      gpsPopup.style.display = 'none';
      if (gpsBtn) { gpsBtn.style.borderColor = ''; gpsBtn.style.color = ''; }
    }
  });

  // Wire data-active-color buttons for consistent toggle appearance
  document.querySelectorAll('.map-toolbar button[data-active-color]').forEach(btn => {
    const color = btn.dataset.activeColor;
    btn._origColor = '';
    btn._origBorder = '';
    btn.addEventListener('trollmap:activate', () => {
      btn.style.color = color;
      btn.style.borderColor = color;
      btn.style.background = color + '18';
    });
    btn.addEventListener('trollmap:deactivate', () => {
      btn.style.color = '';
      btn.style.borderColor = '';
      btn.style.background = '';
    });
  });

  // Mark Contours & Routes button as open/closed
  const crBtn = document.getElementById('btnContourRoutes');
  const origOpen = openPanel;
  const origClose = closePanel;

  console.log('[routes-panel] shell ready');
}

// Wait for DOM to be ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  setTimeout(init, 500);  // after other modules have wired their buttons
}
