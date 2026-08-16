/**
 * USGS NIMS camera frames in the boat-ramp popup.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 * NIMS imagery is Public Domain.
 *
 * SELECTION: nearest camera SITE on the SAME water, within 20 km, then every view that site
 * has. Nothing otherwise.
 *
 * THE SELECTION AND THE FRAME FETCH NOW LIVE IN utils/cameras.js, because the conditions card
 * became a second consumer on 2026-08-16 and a copied frame cache is two caches that can
 * disagree about how old a picture is. This file is the POPUP DOM and the ramp's own rule for
 * turning a DNR waterbody name into a registry slug; everything below that is shared.
 */

import { CF_WORKER_URL } from '../core/state.js';
import { resolveR2Key } from '../data/lake-keys.js';
import { esc } from '../utils/escape.js';
import { camerasOnWater, nearestSite, cameraFrame, ageLabel } from '../utils/cameras.js';

export function camerasForRamp(ramp) {
  if (!ramp || typeof ramp.lat !== 'number' || typeof ramp.lon !== 'number') return [];
  // resolveR2Key() is authoritative when it answers, but it answers on the REGISTRY's name for
  // the water and a ramp carries the DNR feed's name. Both are offered; camerasOnWater takes
  // whichever lands, and nearestSite decides.
  return nearestSite(
    camerasOnWater({ slug: resolveR2Key(ramp.lake), name: ramp.lake }),
    ramp.lat, ramp.lon);
}

/**
 * Fill the .ramp-cam placeholder inside an open popup. Safe to call more than once.
 *
 * 22 of the 47 visible cameras in this footprint are DAYLIGHT ONLY, so the age is not
 * decoration -- open a popup at 22:00 and the newest frame is from 20:15, a real image
 * correctly served and completely misleading with nothing next to it saying so.
 */
export async function attachRampCameras(popupEl, ramp) {
  const box = popupEl && popupEl.querySelector ? popupEl.querySelector('.ramp-cam') : null;
  if (!box || box.dataset.camState) return;
  const cams = camerasForRamp(ramp);
  if (!cams.length) {
    box.remove();
    return;
  }
  box.dataset.camState = 'loading';
  box.innerHTML = '<span style="font-size:11px;color:#9aa">loading camera…</span>';

  const parts = [];
  for (const c of cams) {
    let f = null;
    try {
      f = await cameraFrame(c.camId, { worker: CF_WORKER_URL });
    } catch (err) {
      parts.push(`<div style="font-size:11px;color:#e57373">\u{1F4F7} ${esc(c.name)} — unreachable</div>`);
      continue;
    }
    if (!f || !f.urls || !f.urls.small) {
      parts.push(`<div style="font-size:11px;color:#e57373">\u{1F4F7} ${esc(c.name)} — ${esc(f && f.error ? f.error : 'no frame')}</div>`);
      continue;
    }
    const warn = f.stale ? '#ffb74d' : '#aed581';
    parts.push(`
      <div style="margin-top:6px">
        <img class="ramp-cam-img" src="${esc(f.urls.small)}" alt="${esc(c.name)}" loading="lazy"
             style="width:100%;max-width:320px;border-radius:4px;display:block${f.stale ? ';opacity:.6' : ''}">
        <div style="font-size:11px;color:${warn}">\u{1F4F7} ${esc(c.name)} · ${esc(ageLabel(f.ageMinutes))}${f.stale ? ' · STALE' : ''}${c.period === 'daylight' ? ' · daylight only' : ''}</div>
        <div style="font-size:10px;color:#8a8a8a">${c.km.toFixed(1)} km from this ramp · USGS, public domain</div>
      </div>`);
  }
  box.innerHTML = parts.join('');
  box.dataset.camState = 'done';

  // Attached here rather than as an inline onerror: the handler needs the element it replaces,
  // and an inline attribute is also the first thing a content-security-policy would refuse.
  for (const img of box.querySelectorAll('.ramp-cam-img')) {
    img.addEventListener('error', () => {
      const d = document.createElement('div');
      d.style.cssText = 'font-size:11px;color:#e57373';
      d.textContent = 'frame did not load';
      img.replaceWith(d);
    }, { once: true });
  }
}
