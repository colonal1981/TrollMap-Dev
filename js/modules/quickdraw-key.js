/**
 * Garmin Quickdraw 8-Band Depth Key — a floating legend showing
 * the standard 0-10, 10-20, 20-28, 28-36, 36-45, 45-55, 55-65, >65 ft
 * depth color bands and the recommended lure choice for each zone.
 */

(function initQuickdrawKeyModule() {
  let keyOpen = false;
  const btn = document.getElementById('btnQuickdrawKey');
  if (!btn) return;

  const container = document.createElement('div');
  container.id = 'quickdrawColorKeyOverlay';
  container.className = 'no-print';
  container.style.cssText = 'position:absolute;top:12px;right:58px;z-index:650;background:rgba(11,22,35,0.92);border:1px solid var(--accent);border-radius:10px;padding:8px 12px;font-size:11px;box-shadow:0 4px 16px rgba(0,0,0,0.6);display:none;flex-direction:column;gap:4px;max-width:280px';

  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;border-bottom:1px solid var(--line);padding-bottom:4px">
      <b style="color:var(--accent);font-size:12px">🌈 Garmin Quickdraw 8-Band Depth Key</b>
      <button id="closeQuickdrawKey" style="background:none;border:none;color:#fff;font-size:14px;padding:0 4px;cursor:pointer">✕</button>
    </div>
    <div style="display:flex;align-items:center;gap:6px"><span style="width:16px;height:12px;background:#d32f2f;border-radius:2px;display:inline-block;flex-shrink:0"></span><b style="color:#ffcdd2;width:55px;flex-shrink:0">0–10 ft</b> <span style="color:#aaa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Shallow hazards / Topwater zone</span></div>
    <div style="display:flex;align-items:center;gap:6px"><span style="width:16px;height:12px;background:#f57c00;border-radius:2px;display:inline-block;flex-shrink:0"></span><b style="color:#ffe0b2;width:55px;flex-shrink:0">10–20 ft</b> <span style="color:#aaa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Secondary flats / Squarebills</span></div>
    <div style="display:flex;align-items:center;gap:6px"><span style="width:16px;height:12px;background:#fbc02d;border-radius:2px;display:inline-block;flex-shrink:0"></span><b style="color:#fff9c4;width:55px;flex-shrink:0">20–28 ft</b> <span style="color:#76ff03;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Prime Striper Ledge / Medium A-Rig</span></div>
    <div style="display:flex;align-items:center;gap:6px"><span style="width:16px;height:12px;background:#388e3c;border-radius:2px;display:inline-block;flex-shrink:0"></span><b style="color:#c8e6c9;width:55px;flex-shrink:0">28–36 ft</b> <span style="color:#00e5ff;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Deep River Channel Drop / 3oz A-Rig</span></div>
    <div style="display:flex;align-items:center;gap:6px"><span style="width:16px;height:12px;background:#0288d1;border-radius:2px;display:inline-block;flex-shrink:0"></span><b style="color:#b3e5fc;width:55px;flex-shrink:0">36–45 ft</b> <span style="color:#aaa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Deep Creek Basins / Spoons</span></div>
    <div style="display:flex;align-items:center;gap:6px"><span style="width:16px;height:12px;background:#1565c0;border-radius:2px;display:inline-block;flex-shrink:0"></span><b style="color:#bbdefb;width:55px;flex-shrink:0">45–55 ft</b> <span style="color:#aaa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Main Lake Deep Channel Grooves</span></div>
    <div style="display:flex;align-items:center;gap:6px"><span style="width:16px;height:12px;background:#6a1b9a;border-radius:2px;display:inline-block;flex-shrink:0"></span><b style="color:#e1bee7;width:55px;flex-shrink:0">55–65 ft</b> <span style="color:#aaa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Reservoir Trench Bottoms</span></div>
    <div style="display:flex;align-items:center;gap:6px"><span style="width:16px;height:12px;background:#f5f5f5;border-radius:2px;display:inline-block;flex-shrink:0"></span><b style="color:#fff;width:55px;flex-shrink:0">&gt; 65 ft</b> <span style="color:#aaa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Abyss / Dam Face Channels</span></div>
    <div style="margin-top:2px;font-size:10px;color:var(--warn);border-top:1px solid var(--line);padding-top:4px">
      💡 Tactical Tip: Rely entirely on color edges (e.g. Yellow/Green border) to troll perfect lines. Zoom out to see 2+ miles!
    </div>
  `;
  document.getElementById('panel-map')?.appendChild(container);

  btn.addEventListener('click', () => {
    keyOpen = !keyOpen;
    container.style.display = keyOpen ? 'flex' : 'none';
    btn.style.background = keyOpen ? 'var(--accent)' : '';
    btn.style.color = keyOpen ? '#000' : '';
  });

  document.getElementById('closeQuickdrawKey')?.addEventListener('click', () => {
    keyOpen = false;
    container.style.display = 'none';
    btn.style.background = '';
    btn.style.color = '';
  });
})();
