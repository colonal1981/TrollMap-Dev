/**
 * Catch Verification Photo Lightbox — full-screen viewer for a
 * catch photo with species/lure/depth/time/notes metadata.
 *
 * Triggered by the 🖼️ Photo button in the catch log.
 */

import { state } from '../core/state.js';
import { esc } from '../utils/escape.js';

window.showCatchPhoto = function showCatchPhoto(i) {
  const c = state.CATCHES[i];
  if (!c || !c.photo) return;

  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;z-index:4000;background:rgba(0,0,0,0.85);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px';
  modal.innerHTML = `
    <div style="max-width:90vw;max-height:90vh;display:flex;flex-direction:column;align-items:center;background:var(--panel);border:1px solid var(--accent);border-radius:12px;overflow:hidden;padding:16px;box-shadow:0 8px 32px rgba(0,0,0,0.8)">
      <div style="width:100%;display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <b style="color:var(--accent2);font-size:16px">🐟 ${esc(c.species || 'Fish')} ${c.length ? c.length + '"' : ''} — Verification Photo</b>
        <button style="background:none;border:none;color:#fff;font-size:22px;cursor:pointer" id="closePhotoBtn">✕</button>
      </div>
      <img src="${c.photo}" style="max-width:100%;max-height:72vh;object-fit:contain;border-radius:8px">
      <div style="color:var(--text);font-size:13px;margin-top:12px;background:var(--panel2);padding:8px 14px;border-radius:8px;width:100%;text-align:center">
        <b>Lure:</b> ${esc(c.lure || '—')} · <b>Depth:</b> ${esc(c.depth ? c.depth + 'ft' : '—')} · <b>Time:</b> ${esc(c.time || '—')}
        ${c.notes ? `<div style="color:var(--muted);font-size:12px;margin-top:4px">${esc(c.notes)}</div>` : ''}
      </div>
    </div>
  `;
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  modal.querySelector('#closePhotoBtn').addEventListener('click', () => modal.remove());
  document.body.appendChild(modal);
};
