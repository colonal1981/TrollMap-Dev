/**
 * lazy-data.js — on-demand loader for the optional GIS data files
 * (bank/pier spots, kayak launches, fish attractors). The files
 * live under data/ and aren't pre-cached; this loader is called by
 * gis-toggles.js when the user first clicks one of those toggles.
 *
 * If you don't have these data files, the toggles will simply show
 * an empty layer (which is fine — they're optional).
 */

window.TrollMapData = {
  async loadBankPier() {
    try {
      const res = await fetch('./data/tristate-bank-pier.json');
      if (!res.ok) return [];
      return await res.json();
    } catch (_) {
      return [];
    }
  },
  async loadPaddle() {
    try {
      const res = await fetch('./data/tristate-paddle.json');
      if (!res.ok) return [];
      return await res.json();
    } catch (_) {
      return [];
    }
  },
  async loadHotspots() {
    try {
      const res = await fetch('./data/tristate-hotspots.json');
      if (!res.ok) return [];
      return await res.json();
    } catch (_) {
      return [];
    }
  },
};
