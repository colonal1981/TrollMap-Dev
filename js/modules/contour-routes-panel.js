/**
 * contour-routes-panel.js — Right slide-in panel for all contour and
 * routing functionality. Consolidates:
 *   - Smart Route (reuses smartRoutePanel from smart-route.js)
 *   - Pinch Point Finder (reuses pinchPanel from pinch-point-finder.js)
 *   - Cloud Chartpacks (reuses cloudChartpacksPanel from cloud-chartpacks.js)
 *   - Contour Capture (reuses contourJobPanel from contour-job-export.js)
 *   - Troll Lane Generator (reuses Generate tab form from troll-generator.js)
 *
 * Strategy: build a tabbed slide panel, move existing module panels inside
 * it rather than rebuilding their logic. Modules keep all their wiring.
 */

(function initContourRoutesPanel() {
  // Wait for DOM and other modules to finish building their panels
  if (!window.L) { setTimeout(initContourRoutesPanel, 300); return; }

  // ── Build the shell panel ──────────────────────────────────────────────

  const shell = document.createElement('div');
  shell.id = 'contourRoutesShell';
  shell.style.cssText = `
    position: fixed;
    top: var(--topH, 48px);
    right: 0;
    bottom: var(--navH, 54px);
    width: 360px;
    background: rgba(11,22,35,.98);
    border-left: 1px solid var(--line);
    z-index: 900;
    display: none;
    flex-direction: column;
    overflow: hidden;
    box-shadow: -4px 0 24px rgba(0,0,0,.6);
    font-size: 12px;
  `;

  shell.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--line);flex-shrink:0;background:var(--panel)">
      <span style="color:var(--accent);font-weight:700;font-size:14px">🗺️ Contours &amp; Routes</span>
      <button id="crPanelClose" style="background:none;border:none;color:var(--muted);font-size:18px;cursor:pointer;padding:0 4px;line-height:1">✕</button>
    </div>

    <!-- Tab bar -->
    <div id="crTabBar" style="display:flex;border-bottom:1px solid var(--line);flex-shrink:0;background:var(--panel)">
      <button class="cr-tab active" data-tab="smartRoute" style="flex:1;height:36px;font-size:11px;border:none;border-bottom:2px solid var(--accent2);background:transparent;color:var(--accent2);font-weight:700;cursor:pointer">🧠 Smart Route</button>
      <button class="cr-tab" data-tab="trollGen" style="flex:1;height:36px;font-size:11px;border:none;border-bottom:2px solid transparent;background:transparent;color:var(--muted);cursor:pointer">🛶 Troll Gen</button>
      <button class="cr-tab" data-tab="capture" style="flex:1;height:36px;font-size:11px;border:none;border-bottom:2px solid transparent;background:transparent;color:var(--muted);cursor:pointer">📡 Capture</button>
      <button class="cr-tab" data-tab="cloud" style="flex:1;height:36px;font-size:11px;border:none;border-bottom:2px solid transparent;background:transparent;color:var(--muted);cursor:pointer">☁️ Cloud</button>
    </div>

    <!-- Tab content areas -->
    <div id="crBody" style="flex:1;overflow-y:auto;position:relative">
      <div id="crTab-smartRoute" class="cr-tab-body" style="display:block;padding:10px 14px"></div>
      <div id="crTab-trollGen"   class="cr-tab-body" style="display:none;padding:10px 14px"></div>
      <div id="crTab-capture"    class="cr-tab-body" style="display:none;padding:10px 14px"></div>
      <div id="crTab-cloud"      class="cr-tab-body" style="display:none;padding:10px 14px"></div>
    </div>
  `;

  document.getElementById('panel-map')?.appendChild(shell);

  // ── Tab switching ──────────────────────────────────────────────────────

  function switchTab(name) {
    shell.querySelectorAll('.cr-tab').forEach(btn => {
      const active = btn.dataset.tab === name;
      btn.style.color = active ? 'var(--accent2)' : 'var(--muted)';
      btn.style.borderBottom = active ? '2px solid var(--accent2)' : '2px solid transparent';
      btn.style.fontWeight = active ? '700' : '400';
    });
    shell.querySelectorAll('.cr-tab-body').forEach(div => {
      div.style.display = div.id === `crTab-${name}` ? 'block' : 'none';
    });
    // Trigger cloud list load when switching to cloud tab
    if (name === 'cloud') {
      document.getElementById('cloudChartpacksRefresh')?.click();
    }
  }

  shell.querySelectorAll('.cr-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // ── Open/close ─────────────────────────────────────────────────────────

  function openPanel(tab) {
    shell.style.display = 'flex';
    if (tab) switchTab(tab);
    // Shrink map to avoid overlap (optional — Leaflet reflows on invalidateSize)
    setTimeout(() => window._map?.invalidateSize?.(), 50);
  }

  function closePanel() {
    shell.style.display = 'none';
    setTimeout(() => window._map?.invalidateSize?.(), 50);
  }

  document.getElementById('btnContourRoutes')?.addEventListener('click', () => {
    if (shell.style.display === 'none') openPanel('smartRoute');
    else closePanel();
  });

  document.getElementById('crPanelClose')?.addEventListener('click', closePanel);

  // Also wire old standalone buttons to open the right tab
  document.getElementById('btnSmartRoute')?.addEventListener('click', () => openPanel('smartRoute'));
  document.getElementById('btnCloudChartpacks')?.addEventListener('click', () => openPanel('cloud'));
  document.getElementById('btnDrawContour')?.addEventListener('click', () => openPanel('capture'));
  document.getElementById('btnPinchFinder')?.addEventListener('click', () => openPanel('smartRoute'));

  // ── Move module panels into tabs after modules have loaded ─────────────

  function adoptPanels() {
    // Smart Route panel → smartRoute tab
    const srPanel = document.getElementById('smartRoutePanel');
    const srTarget = document.getElementById('crTab-smartRoute');
    if (srPanel && srTarget && !srTarget.contains(srPanel)) {
      // Strip the panel's own absolute positioning — it's now in-flow
      srPanel.style.cssText = 'display:block;position:static;border:none;background:none;padding:0;box-shadow:none;width:auto';
      srTarget.appendChild(srPanel);
      // Move pinch section into smart route tab too
      const ppPanel = document.getElementById('pinchPanel');
      if (ppPanel) {
        ppPanel.style.cssText = 'display:block;position:static;border:1px solid var(--line);border-radius:8px;margin-top:10px;width:auto';
        srTarget.appendChild(ppPanel);
      }
    }

    // Contour job panel → capture tab
    const cjPanel = document.getElementById('contourJobPanel');
    const cjTarget = document.getElementById('crTab-capture');
    if (cjPanel && cjTarget && !cjTarget.contains(cjPanel)) {
      cjPanel.style.cssText = 'display:block;position:static;border:none;background:none;padding:0;box-shadow:none;width:auto';
      cjTarget.appendChild(cjPanel);
    }

    // Cloud chartpacks panel → cloud tab
    const ccPanel = document.getElementById('cloudChartpacksPanel');
    const ccTarget = document.getElementById('crTab-cloud');
    if (ccPanel && ccTarget && !ccTarget.contains(ccPanel)) {
      ccPanel.style.cssText = 'display:block;position:static;border:none;background:none;padding:0;box-shadow:none;width:auto';
      // Hide the old close/open button inside the panel since shell handles that
      ccPanel.querySelector('#cloudChartpacksClose')?.remove();
      ccTarget.appendChild(ccPanel);
    }

    // Troll generator — pull from Generate tab form into trollGen tab
    const trollTarget = document.getElementById('crTab-trollGen');
    const genCard = document.querySelector('#panel-generate .card');
    if (genCard && trollTarget && !trollTarget.contains(genCard)) {
      const wrapper = document.createElement('div');
      wrapper.appendChild(genCard.cloneNode(true));
      trollTarget.innerHTML = wrapper.innerHTML;
      // Re-wire buttons after cloning (IDs remain, troll-generator.js already wired originals)
      // The original Generate tab still works; this is a visual mirror
      // For a real merge we'd need to move not clone — doing that safely:
      trollTarget.innerHTML = '';
      trollTarget.appendChild(genCard);
    }
  }

  // Adopt panels after all modules have had time to build them
  setTimeout(adoptPanels, 2000);

  // ── Wire GPS popup ─────────────────────────────────────────────────────

  const gpsPopup = document.getElementById('gpsPanelPopup');
  document.getElementById('btnGpsPanel')?.addEventListener('click', (e) => {
    if (!gpsPopup) return;
    const open = gpsPopup.classList.toggle('open');
    e.currentTarget.style.background = open ? 'var(--accent)' : '';
    e.currentTarget.style.color = open ? '#000' : '';
  });
  document.getElementById('gpsPopupClose')?.addEventListener('click', () => {
    gpsPopup?.classList.remove('open');
    document.getElementById('btnGpsPanel').style.background = '';
    document.getElementById('btnGpsPanel').style.color = '';
  });

  console.log('[contour-routes-panel] shell ready');
})();
