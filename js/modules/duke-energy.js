/**
 * Duke Energy scraper — proxies the live Duke Energy lake-level
 * dashboard through the Cloudflare worker (because GitHub Pages
 * can't fetch lakes.duke-energy.com directly due to CORS).
 *
 * Parses both the live dashboard HTML AND the legacy Duke JSON
 * format, normalizing into { elevation_ft, percent_full, full_pool,
 * target, min, max, diff, trend, special_message, source, basin }.
 *
 * Module also exposes `fetchDamLevels()` which tries each of the
 * three basins in order until it gets a populated response.
 */

import { CF_WORKER_URL } from '../core/state.js';

const STATE_NAME_MAP = {
  wateree: 'wateree',
  norman: 'norman',
  wylie: 'wylie',
  keowee: 'keowee',
  jocassee: 'jocassee',
  hickory: 'hickory',
  james: 'james',
  rhodhiss: 'rhodhiss',
  'mountain island': 'mountain island',
};

/**
 * Parse a Duke Energy dashboard text (HTML or JSON) into a
 * normalized map of { lakeName → info }. Returns null if nothing
 * parseable was found.
 */
export function parseDukeText(text, basinId) {
  if (!text || text.length < 10) return null;

  const lakes = {};

  // 1. Try JSON / txt format first
  try {
    let entries = [];
    const trimmed = text.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      entries = JSON.parse(trimmed.startsWith('[') ? trimmed : `[${trimmed}]`);
    } else {
      entries = [...trimmed.matchAll(/\{[^}]+\}/g)]
        .map((m) => { try { return JSON.parse(m[0]); } catch { return null; } })
        .filter(Boolean);
    }
    for (const lake of entries) {
      const name = (lake.LakeDisplayName || lake.LakeName || '').toLowerCase().trim();
      const actual = parseFloat(lake.Actual);
      if (!name || isNaN(actual)) continue;
      const target = parseFloat(lake.Target);
      const elevMatch = String(lake.Elevation || '').match(/([0-9]+(?:\.[0-9]+)?)/);
      const fullPool = elevMatch ? parseFloat(elevMatch[1]) : null;
      const isPercentActual = fullPool && actual <= 100;
      const diff = actual - target;
      lakes[name] = {
        elevation: isPercentActual ? (actual / 100) * fullPool : actual,
        percentFull: isPercentActual ? actual : null,
        fullPool: isNaN(fullPool) ? null : fullPool,
        target: isNaN(target) ? null : target,
        min: parseFloat(lake.Min) || null,
        max: parseFloat(lake.Max) || null,
        diff: isNaN(diff) ? null : parseFloat(diff.toFixed(2)),
        trend: isNaN(target) ? 'Unknown' : diff > 0.3 ? 'Above Target' : diff < -0.3 ? 'Below Target' : 'On Target',
        specialMessage: lake.SpecialMessage?.trim().split('\n')[0] || null,
        source: 'Duke Energy (via worker)',
        basin: basinId,
      };
    }
    if (Object.keys(lakes).length) return { duke: lakes };
  } catch (_) {}

  // 2. Worker-synthesized text: "Lake Wateree · 220.76 · 97.90% · target 98 · full 225.5"
  const synthRe = /Lake\s+([A-Za-z\s]+?)\s*[·•]\s*([\d.]+)\s*[·•][^\n]*?full\s+([\d.]+)/gi;
  let sm;
  while ((sm = synthRe.exec(text)) !== null) {
    const rawName = (sm[1] || '').trim().toLowerCase();
    const elev = parseFloat(sm[2]);
    const fullPool = parseFloat(sm[3]);
    if (!rawName || isNaN(elev)) continue;

    let key = rawName;
    for (const [frag, canon] of Object.entries(STATE_NAME_MAP)) {
      if (rawName.includes(frag)) { key = canon; break; }
    }
    lakes[key] = {
      elevation: elev,
      percentFull: (() => {
        const pm = text.slice(Math.max(0, sm.index), synthRe.lastIndex + 40).match(/[·•]\s*([\d.]+)%/);
        return pm ? parseFloat(pm[1]) : null;
      })(),
      fullPool: isNaN(fullPool) ? null : fullPool,
      target: null, min: null, max: null,
      diff: isNaN(fullPool) ? null : parseFloat((elev - fullPool).toFixed(2)),
      trend: isNaN(fullPool) ? 'Live from Duke API' : elev > fullPool + 0.3 ? 'Above Full Pool' : elev < fullPool - 0.3 ? 'Below Full Pool' : 'Near Full Pool',
      specialMessage: null,
      source: 'Duke API via worker',
      basin: basinId,
    };
  }
  if (Object.keys(lakes).length) return { duke: lakes };

  // 3. Tolerant extraction (legacy HTML scrape patterns)
  const patterns = [
    /Lake\s+([A-Za-z\s]+?)\s*[·•]\s*([\d.]+)\s*[·•]/gi,
    /Lake\s+([A-Za-z\s]+?)\s*[:\-]\s*([\d.]+)\s*(?:ft|feet)?/gi,
    /"lakeName"\s*:\s*"([^"]+)"[^}]*"level"\s*:\s*([\d.]+)/gi,
  ];
  for (const regex of patterns) {
    let m;
    while ((m = regex.exec(text)) !== null) {
      const rawName = (m[1] || '').trim().toLowerCase();
      const elev = parseFloat(m[2]);
      if (!rawName || isNaN(elev)) continue;
      let key = rawName;
      for (const [frag, canon] of Object.entries(STATE_NAME_MAP)) {
        if (rawName.includes(frag)) { key = canon; break; }
      }
      if (!lakes[key] || lakes[key].elevation === undefined) {
        lakes[key] = {
          elevation: elev,
          target: null, min: null, max: null, diff: null,
          trend: 'Live from Duke dashboard',
          specialMessage: null,
          source: 'Duke Energy (live dashboard via worker)',
          basin: basinId,
        };
      }
    }
    if (Object.keys(lakes).length) break;
  }

  return Object.keys(lakes).length ? { duke: lakes } : null;
}

/** Last-resort direct browser fetch (will usually fail due to CORS). */
async function fetchDukeDirect() {
  const lakes = {};
  for (const basinId of [1, 2, 3]) {
    try {
      const res = await fetch(`https://lakes.duke-energy.com/Data/Lakes/${basinId}.txt`);
      if (!res.ok) continue;
      const text = await res.text();
      const parsed = parseDukeText(text, basinId);
      if (parsed) Object.assign(lakes, parsed.duke || {});
    } catch (_) {}
  }
  return Object.keys(lakes).length ? { duke: lakes } : null;
}

/**
 * Fetch live Duke dashboard data. Tries basins 1/2/3 in order via
 * the Cloudflare worker proxy. Falls back to direct fetch (which
 * usually fails due to CORS).
 */
export async function fetchDamLevels() {
  for (const basin of [1, 2, 3]) {
    try {
      const res = await fetch(`${CF_WORKER_URL}/duke?basin=${basin}`);
      if (res.ok) {
        const text = await res.text();
        const parsed = parseDukeText(text, basin);
        if (parsed && Object.keys(parsed.duke || {}).length) return parsed;
      }
    } catch (_) {}
  }
  return await fetchDukeDirect();
}
