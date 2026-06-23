/**
 * Live Utility & USGS sync — pulls real-time lake pool elevation
 * and water temperature for the selected Plan lake from:
 *
 *   1. The Cloudflare worker /lake endpoint (preferred — unified
 *      datum, keeps Duke's public % full-pond scale intact)
 *   2. USGS Water Services (temperature only — never use river
 *      stage below a dam as pool elevation)
 *   3. Duke Energy live dashboard (via duke-energy.js)
 *
 * Populates the Plan form's Full Pool / Current Level / Water Temp
 * fields and the Live Utility Callout box.
 */

import { state, CF_WORKER_URL } from '../core/state.js';
import { LAKE_DB } from '../data/lakes.js';
import { fetchDamLevels } from './duke-energy.js';

// ── Lake → Utility-feed map ──────────────────────────────────────────────

const UTILITY_FEEDS = {
  'Lake Wateree': {
    utility: 'Duke Energy', usgsId: '02148000', normalPool: '100.0', minPool: '92.5',
    dashUrl: 'https://lakes.hydro-derived.duke-energy.app/index.html',
    desc: 'Duke Energy manages Lake Wateree pool elevation (authoritative). USGS 02148000 is the river gauge BELOW the dam — used ONLY for water temperature fallback. Never use river stage (00065) as pool level.',
  },
  'Lake Wylie': {
    utility: 'Duke Energy', usgsId: '02146000', normalPool: '100.0', minPool: '92.6',
    dashUrl: 'https://lakes.hydro-derived.duke-energy.app/index.html',
    desc: 'Duke Energy manages Lake Wylie. Automated browser sync queries live water monitoring feeds.',
  },
  'Lake Norman': {
    utility: 'Duke Energy', usgsId: '02142500', normalPool: '100.0', minPool: '91.0',
    dashUrl: 'https://lakes.hydro-derived.duke-energy.app/index.html',
    desc: 'Duke Energy manages Lake Norman. Live automated browser sync queries clean stream gauges.',
  },
  'Lake Keowee': {
    utility: 'Duke Energy', usgsId: '02063000', normalPool: '100.0', minPool: '93.0',
    dashUrl: 'https://lakes.hydro-derived.duke-energy.app/index.html',
    desc: 'Duke Energy operational system. Sync retrieves real-time water conditions.',
  },
  'Lake Murray': {
    utility: 'Dominion Energy', normalPool: '358.0', minPool: '356.0',
    dashUrl: 'https://www.dominionenergy.com/projects-and-facilities/hydroelectric-power/lake-murray',
    desc: 'Dominion Energy manages Lake Murray (Normal Summer Pool: 358 ft · Winter: 357 ft). Direct browser sync derives normal operating curve.',
  },
  'Lake Marion': {
    utility: 'Santee Cooper', normalPool: '75.0', minPool: '73.0',
    dashUrl: 'https://www.santeecooper.com/community/lakes-and-recreation/lake-levels.aspx',
    desc: 'Santee Cooper manages Lake Marion (Normal Target Pool: 75.0 ft). Direct browser sync evaluates live operating curves.',
  },
  'Lake Moultrie': {
    utility: 'Santee Cooper', normalPool: '74.5', minPool: '72.0',
    dashUrl: 'https://www.santeecooper.com/community/lakes-and-recreation/lake-levels.aspx',
    desc: 'Santee Cooper manages Lake Moultrie (Normal Target Pool: 74.5 ft). Direct browser sync evaluates live operating curves.',
  },
};

/** Look up a UTILITY_FEEDS key by case-insensitive substring match. */
function lookupFeed(cleanStr) {
  return Object.keys(UTILITY_FEEDS).find((k) => cleanStr.toLowerCase().includes(k.toLowerCase()) || k.toLowerCase().includes(cleanStr.toLowerCase()));
}

/** Same, but for LAKE_DB. */
function lookupLakeDbKey(cleanStr) {
  return Object.keys(LAKE_DB || {}).find((k) => cleanStr.toLowerCase().includes(k.toLowerCase()) || k.toLowerCase().includes(cleanStr.toLowerCase()));
}

function say(msg, isErr) {
  const statusEl = document.getElementById('utilitySyncStatus');
  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.style.color = isErr ? 'var(--bad)' : 'var(--accent2)';
}

/** Pull the latest temperature from a USGS gauge (00010 param). */
async function fetchUsgsTemp(siteId) {
  const url = `https://waterservices.usgs.gov/nwis/iv/?sites=${siteId}&parameterCd=00010&format=json&period=P1D`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    const data = await res.json();
    const ts = data?.value?.timeSeries?.find((s) => s.variable.variableCode[0].value === '00010');
    const vals = ts?.values?.[0]?.values || [];
    const good = vals.filter((v) => v.value !== '' && v.value !== '-999999' && v.value != null);
    if (!good.length) return null;
    const tempC = parseFloat(good[good.length - 1].value);
    return isFinite(tempC) ? Math.round(tempC * 9 / 5 + 32) : null;
  } catch (_) {
    return null;
  }
}

/** Main sync function — pulled live data and writes it into the form. */
export async function syncUtilityData() {
  const lakeStr = document.getElementById('planLake')?.value
                || document.getElementById('lakeSelect')?.value
                || 'Lake Wateree, SC';

  // River trips delegate to syncPlanRiverData (when available)
  if (typeof window.isPlanRiverValue === 'function' && window.isPlanRiverValue(lakeStr)) {
    if (typeof window.syncPlanRiverData === 'function') await window.syncPlanRiverData();
    return;
  }

  const cleanStr = lakeStr.split(',')[0].trim();
  const lKey = lookupFeed(cleanStr);
  const feed = lKey ? UTILITY_FEEDS[lKey] : null;
  const lkDbKey = lookupLakeDbKey(cleanStr);
  const lkEntry = lkDbKey ? LAKE_DB[lkDbKey] : null;

  say('Syncing USGS / Utility streams…', false);
  const syncBtn = document.getElementById('syncDukeBtn');
  if (syncBtn) { syncBtn.style.background = 'var(--accent)'; syncBtn.style.color = '#000'; }

  try {
    let poolResult = NaN;
    let tempResult = NaN;
    let liveFullPool = null;

    // 0. Preferred: unified worker /lake endpoint
    try {
      const lakeUrl = `${CF_WORKER_URL}/lake?lake=${encodeURIComponent(cleanStr)}`;
      const lr = await fetch(lakeUrl);
      if (lr.ok) {
        const lj = await lr.json();
        const isDukeLake = feed && (feed.utility || '').toLowerCase().includes('duke');
        if (isDukeLake && typeof lj.percent_full === 'number') {
          poolResult = lj.percent_full;
          liveFullPool = 100.0;
        } else if (typeof lj.display_level === 'number') {
          poolResult = lj.display_level;
          liveFullPool = typeof lj.display_full_pool === 'number' ? lj.display_full_pool : (typeof lj.full_pool_ft === 'number' ? lj.full_pool_ft : liveFullPool);
        } else if (isDukeLake && typeof lj.elevation_ft === 'number' && typeof lj.full_pool_ft === 'number' && lj.full_pool_ft > 0) {
          poolResult = (lj.elevation_ft / lj.full_pool_ft) * 100;
          liveFullPool = 100.0;
        } else if (typeof lj.elevation_ft === 'number') {
          poolResult = lj.elevation_ft;
          if (typeof lj.full_pool_ft === 'number') liveFullPool = lj.full_pool_ft;
        }
        if (typeof lj.water_temperature_F === 'number') tempResult = lj.water_temperature_F;
      }
    } catch (_) {}

    // 1. Duke live dashboard (preferred for Duke lakes)
    if (poolResult !== poolResult /* NaN check */ && feed && (feed.utility || '').toLowerCase().includes('duke')) {
      try {
        const d = await fetchDamLevels();
        if (d && d.duke) {
          for (const [k, v] of Object.entries(d.duke)) {
            const kk = String(k || '').toLowerCase();
            const matchesSelectedLake = cleanStr.includes(kk) || kk.includes(cleanStr.replace(/^lake\s+/, '').trim());
            if (matchesSelectedLake && v && typeof v.elevation === 'number') {
              if (typeof v.percentFull === 'number') { poolResult = v.percentFull; liveFullPool = 100.0; }
              else if (typeof v.fullPool === 'number' && v.fullPool > 0) { poolResult = (v.elevation / v.fullPool) * 100; liveFullPool = 100.0; }
              else { poolResult = v.elevation; if (typeof v.fullPool === 'number') liveFullPool = v.fullPool; }
              break;
            }
          }
      } catch (_) {}
    }

    // 2. USGS temperature fallback (only)
    if (isNaN(tempResult)) {
      const usgsTargetId = feed?.usgsId || lkEntry?.usgs?.site;
      if (usgsTargetId) {
        const t = await fetchUsgsTemp(usgsTargetId);
        if (t != null) tempResult = t;
      }
    }

    // Prefer real Duke pool if we got one
    if (poolResult !== poolResult /* NaN */ && feed && (feed.utility || '').toLowerCase().includes('duke')) {
      // Already assigned above in step 1
    }

    // 3. Fallback to published normal pool
    const normalTarget = liveFullPool || feed?.normalPool || lkEntry?.normalPool || null;
    if (isNaN(poolResult)) {
      if (normalTarget != null) poolResult = parseFloat(normalTarget);
      else {
        say(`No verified live lake-level source for ${cleanStr || 'this waterbody'}.`, true);
        return;
      }
    }

    // Populate form inputs
    const fPoolEl = document.getElementById('planFullPool');
    if (fPoolEl) fPoolEl.value = parseFloat(normalTarget).toFixed(1);
    const poolEl = document.getElementById('planPoolLevel');
    if (poolEl && !isNaN(poolResult)) poolEl.value = poolResult.toFixed(1);
    const wTempEl = document.getElementById('planWaterTemp');
    if (wTempEl && !isNaN(tempResult)) wTempEl.value = tempResult;

    say(`✓ Live pull: ${(!isNaN(poolResult) ? poolResult.toFixed(1) : '—')} ft ${(!isNaN(tempResult) ? '· ' + tempResult + '°F' : '')}`, false);
  } catch (err) {
    console.warn('Live USGS / Utility sync warning:', err);
    say('Provisional baseline operating curves loaded.', false);
    const normalTarget = feed?.normalPool || lkEntry?.normalPool || '100.0';
    const poolEl = document.getElementById('planPoolLevel');
    if (poolEl) poolEl.value = parseFloat(normalTarget).toFixed(1);
  } finally {
    const syncBtn = document.getElementById('syncDukeBtn');
    if (syncBtn) setTimeout(() => { syncBtn.style.background = ''; syncBtn.style.color = ''; }, 1000);
  }
}

window.syncUtilityData = syncUtilityData;

// ── Wire the Lake dropdown + sync button ────────────────────────────────

function wireLakeDropdown() {
  const lakeSel = document.getElementById('planLake');
  const boxEl = document.getElementById('utilityAssessmentBox');
  const titleEl = document.getElementById('uTitle');
  const descEl = document.getElementById('uDesc');
  const verifyLink = document.getElementById('uLink');

  if (!lakeSel) return;

  lakeSel.addEventListener('change', (e) => {
    const lakeStr = e.target.value || '';
    const cleanStr = lakeStr.split(',')[0].trim();
    const lKey = lookupFeed(cleanStr);
    const feed = lKey ? UTILITY_FEEDS[lKey] : null;

    if (boxEl) {
      if (!feed) {
        boxEl.style.display = 'none';
      } else {
        boxEl.style.display = 'block';
        if (titleEl) titleEl.textContent = `${feed.utility} Management (${lKey})`;
        if (descEl) descEl.textContent = feed.desc;
        if (verifyLink) verifyLink.href = feed.dashUrl;
      }
    }
    syncUtilityData();
  });
}

function wireSyncButton() {
  document.getElementById('syncDukeBtn')?.addEventListener('click', syncUtilityData);
}

setTimeout(() => {
  wireLakeDropdown();
  wireSyncButton();
  // Auto-trigger once on app load (gives the form an initial fill)
  setTimeout(syncUtilityData, 800);
}, 500);
