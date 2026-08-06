/**
 * USGS NIMS camera frames in the boat-ramp popup.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 * NIMS imagery is Public Domain.
 *
 * SELECTION: nearest camera SITE on the SAME water, within 20 km, then every view that site
 * has. Nothing otherwise.
 *
 * Distance alone picks the wrong water, measured: Pick Hill Access on the BROAD RIVER takes
 * "Little Hope Creek at Charlotte", 60 km away in a different watershed, and WT Billy Tolar on
 * WATEREE takes a CONGAREE camera at 21.6 km. Both are the nearest camera by distance and both
 * are wrong. So the water has to agree first and the distance only breaks ties -- the same
 * two-signal shape the gauge bindings use, for the same reason.
 *
 * The same-water test is already settled at build time: build_camera_index.py binds each
 * camera to a registry slug by polygon. All this does at runtime is resolve the ramp's lake
 * name to that same slug.
 *
 * NO PROXY, DELIBERATELY. The frame comes back as an S3 URL and goes straight into img.src.
 * CORS governs fetch() and canvas readback, not <img src> -- a cross-origin image has always
 * been allowed to DISPLAY -- so there is nothing to test and no Worker bandwidth spent on
 * image bytes.
 */

import { CF_WORKER_URL } from '../core/state.js';
import { resolveR2Key } from '../data/lake-keys.js';
import { esc } from '../utils/escape.js';
import { CAMERA_INDEX_BUILT, NIMS_CAMERAS } from '../data/cameras.js';

const MAX_KM = 20;

// Frames land every 5, 15 or 60 minutes depending on the camera, and the Worker already edge-
// caches for 120 s. This second cache exists because Leaflet rebuilds every ramp marker on any
// map move, so the same popup can be opened repeatedly within seconds.
const FRAME_TTL_MS = 120000;
const _frames = new Map();

function kmBetween(aLat, aLon, bLat, bLon) {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function camerasForRamp(ramp) {
  if (!CAMERA_INDEX_BUILT || !NIMS_CAMERAS.length) return [];
  if (!ramp || typeof ramp.lat !== 'number' || typeof ramp.lon !== 'number') return [];

  // TWO WAYS TO THE SAME WATER, and the app needs both.
  //
  // resolveR2Key() is authoritative when it answers, but it answers on the REGISTRY's name for
  // the water, and a ramp carries the DNR feed's name. Those vocabularies do not agree: the
  // registry says "Lynches River (Darlington Co, SC)" and the feed says "Lynches River"; the
  // registry says "Congaree River (to SC-601) (Richland Co, SC)" and the feed says "Congaree
  // River". Measured across all four state feeds, ZERO of the 17 camera waters matched a DNR
  // waterbody name through resolveR2Key alone.
  //
  // So the build step ships `waterAliases` -- the display name with its parentheticals peeled
  // off, one layer at a time. That is deliberately NOT done inside resolveR2Key: collapsing
  // "Lake Wallace (Marlboro Co, SC)" to "Lake Wallace" is exactly the ambiguity lint:keys
  // fails on, and a name that means two different lakes must not silently resolve to one.
  // It is safe here because an alias only NOMINATES candidates -- the 20 km test below decides
  // -- and the ambiguous cases are reaches of one river, where nearest is the right answer.
  const slug = resolveR2Key(ramp.lake);
  const want = String(ramp.lake || '').trim().toLowerCase();
  const onWater = NIMS_CAMERAS.filter(
    (c) => (slug && c.slug === slug) ||
           (!!want && Array.isArray(c.waterAliases) && c.waterAliases.includes(want))
  );
  if (!onWater.length) return [];

  let best = null;
  for (const c of onWater) {
    const d = kmBetween(ramp.lat, ramp.lon, c.lat, c.lon);
    if (d > MAX_KM) continue;
    if (!best || d < best.d) best = { d, cam: c };
  }
  if (!best) return [];

  // Every view AT THAT SITE, keyed on nwisId -- UPSTREAM/DOWNSTREAM pairs are two views of one
  // reach and both are wanted. Deduped on camId and never on nwisId, because more than one
  // camera per site is the normal case, not a duplicate.
  const site = best.cam.nwisId
    ? onWater.filter((c) => c.nwisId === best.cam.nwisId)
    : [best.cam];
  const seen = new Set();
  const out = [];
  for (const c of site) {
    if (seen.has(c.camId)) continue;
    seen.add(c.camId);
    out.push({ ...c, km: kmBetween(ramp.lat, ramp.lon, c.lat, c.lon) });
  }
  return out;
}

async function frameFor(camId) {
  const hit = _frames.get(camId);
  if (hit && Date.now() - hit.t < FRAME_TTL_MS) return hit.v;
  const res = await fetch(`${CF_WORKER_URL}/cameras/frame?camId=${encodeURIComponent(camId)}`);
  if (!res.ok) throw new Error(`frame ${res.status}`);
  const v = await res.json();
  _frames.set(camId, { t: Date.now(), v });
  return v;
}

function ageLabel(mins) {
  if (mins == null) return 'time unknown';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  return `${h} h ${mins % 60} min ago`;
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
      f = await frameFor(c.camId);
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
