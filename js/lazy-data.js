/**
 * lazy-data.js — on-demand loader for optional GIS data files.
 * Normalizes arrays, FeatureCollections, and common wrapped shapes
 * into a plain array of records with:
 *   { name, type, latitude, longitude, ... }
 */

function normalizeRows(value) {
  if (Array.isArray(value)) return value;

  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.rows)) return value.rows;
  if (Array.isArray(value?.data)) return value.data;

  if (Array.isArray(value?.features)) {
    return value.features.map((f) => {
      const p = f?.properties || {};
      const coords = f?.geometry?.coordinates || [];

      return {
        ...p,
        name:
          p.name ?? p.Name ?? p.NAME ??
          f?.name ?? 'Unnamed',
        type:
          p.type ?? p.Type ?? p.TYPE ??
          f?.type ?? '',
        latitude:
          p.latitude ?? p.lat ?? p.LATITUDE ?? p.LAT ??
          f?.latitude ?? f?.lat ??
          coords[1],
        longitude:
          p.longitude ?? p.lon ?? p.lng ?? p.LONGITUDE ?? p.LON ?? p.LNG ??
          f?.longitude ?? f?.lon ?? f?.lng ??
          coords[0],
      };
    });
  }

  return [];
}

async function loadJsonRows(path) {
  try {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) return [];
    const raw = await res.json();
    return normalizeRows(raw);
  } catch (_) {
    return [];
  }
}

// loadBankPier / loadPaddle / loadHotspots lived here and read
// data/tristate-bank-pier.json, tristate-paddle.json and tristate-hotspots.json.
// All three were point-in-time snapshots of DNR ArcGIS services the Worker already
// proxies live, and they were the reason a new SCDNR attractor never appeared
// without someone regenerating a file by hand. gis-toggles.js now pulls all four
// states from the Worker. The loaders and the files are deleted, deliberately --
// re-adding a local snapshot reintroduces the drift.
window.TrollMapData = {};