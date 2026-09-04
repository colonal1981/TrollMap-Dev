// r2Text is used by /chartpacks/lake-boundary (line ~1711). It was added to worker-core.js
// and exported there, but never added to this import list -- so that route threw
// `ReferenceError: r2Text is not defined` and returned HTTP 500 for every lake.
import { CORS, JSON_HEADERS, TEXT_HEADERS, callLLM, isAuthorized, chartpackKey, handleChartpackList, r2Body, r2Text } from './worker-core.js';

// Bump on every edit to this file. See ARCGIS_BUILD in core/arcgis.js.
const WORKER_BUILD = 'worker-2026-08-07a';

import { fetchDukeFlowArrivals, dukeRowForNames, LAKES, LAKE_INTEL, LAKE_INTEL_SOURCE_REGISTRY, LAKEMONSTER_IDS, LAKE_CLARITY_PROFILES, RIVERS, lakeKeyFromName, fetchText, fetchUsgs, fetchAhqWaterTemp, fetchAhqFishingReport, fetchLakeMonsterIntel, getLakeIntel, getLakeClarity, getLakeIntelSourceRegistry, getDukeLake } from './worker-data.js';
import { SPECIES_MIDLANDS_SANTEE, SPECIES_UPSTATE, SPECIES_COASTAL_SALTWATER, SPECIES_ALL_TROLLMAP, MAX_BIOLOGICAL_LENGTH, PURE_SALTWATER, PURE_FRESHWATER, getSpeciesListForGps, checkBiologicalLength, checkEcologicalReality } from './worker-species.js';
import { handleGisRoute, flagIsYes, hasText, ARCGIS_BUILD } from './core/arcgis.js';
import { RAMP_SOURCES } from './core/ramp-sources.js';
import { handleWaterRoute } from './water.js';
import { handleConditions, handleHazards } from './conditions.js';
import { handleCameras } from './cameras.js';
import { handleAlerts, runAlertSweep } from './alerts.js';
import { handleReports } from './reports.js';
import { fetchStateRegulations, getLakeRegulations } from './research/clients.js';
import { regulationsTable, lakeIndex, resolveRegistryRow } from './registry.js';
import { handleResearchThermoclineSearch, handleResearchLimnologyData, refreshStaleLimnology, handleResearchDiscover, handleResearchProxyDownload, handleResearchProxyDownloadBatch, handleResearchDatasetHunt, handleResearchDeterministicFacts, handleResearchSaveNormalized, handleResearchGetNormalized, registrySpeciesFor, speciesFoodHabits, handleResearchAnalyzeFacts, handleResearchDedupeContradictions, handleResearchMapFacts, handleResearchGapAnalysis, handleResearchGapSearch, handleResearchAgent, handleResearchList, handleResearchGet, handleResearchSave, handleResearchRegsDebug, handleResearchApprove, handleResearchDelete, handleResearchDeleteNormalizedDoc, handleResearchPackage, handleResearchPackageFile, handleEnhancedLakeIntel, RESEARCH_AGENTS, GAP_QUERIES, sanitizeLakeId, lakeResearchMasterKey, lakePackageKey, handleResearchValidationPass, handleSharedCheck, handleSharedStore, handleSharedQuery, handleSharedPublish, handleSharedStatus, handleSharedQuarantine } from './worker-research.js';


/**
 * Routes that CHANGE stored state and must carry the shared token.
 *
 * WHY A LIST AT THE ROUTER RATHER THAN A CHECK PER HANDLER
 *
 * isAuthorized() was called at exactly three places -- /sync/*, the contour upload and the
 * chartpack upload -- and NOWHERE in research/*.js. So until 2026-08-03 anyone who knew the
 * URL could POST /research/save to overwrite a lake's entire research profile, POST
 * /research/approve to mark an unverified profile verified, or POST /research/delete to remove
 * a lake's master profile, every version of it and all its package files from R2. No token, no
 * check, next to a /sync surface that was gated.
 *
 * A per-handler check is one more thing to forget the next time a route is added, and
 * forgetting is exactly what happened. One gate, one list, and the list is the thing to review.
 *
 * NOT deny-by-default on method, deliberately: several POST routes are read-shaped LLM and
 * search proxies the app calls with no token (/groq-query, /identify-catch,
 * /research/discover), and blanket-gating them would break the app in ways only clicking every
 * button would reveal. Deny-by-default becomes safe once every client call goes through one
 * helper -- see utils/worker-auth.js. This list is precise instead.
 */
const MUTATING_ROUTES = [
  "/research/save",
  "/research/approve",
  "/research/delete",
  "/research/delete-normalized-doc",
  "/research/save-normalized",
  "/research/shared/store",
  "/research/shared/publish",
  "/research/shared/quarantine",
  // Writes env.TROLLMAP_DATA, a binding wrangler.toml does not declare -- so the write throws
  // into a `catch (_) {}` and has never once succeeded. Listed anyway: the day that binding is
  // added, this becomes a live unauthenticated write, and nobody would think to come back here.
  "/research/dataset-hunt",
];

/**
 * True when this request is allowed to proceed. Non-mutating requests always are.
 */
async function allowMutation(request, url, path, env) {
  let mutating = MUTATING_ROUTES.includes(path);
  // A GET that deletes three KV entries is still a write, whatever the verb says.
  if (path === "/debug/regs-cache" && url.searchParams.get("bust")) mutating = true;
  if (!mutating) return true;
  return await isAuthorized(request, env);
}

function assessKayakSafety(riverKey, gaugeData, thresholds) {
  const t = thresholds;
  const reasons = [];
  const metrics = {};
  let level = "go";
  const escalate = (newLevel) => {
    const order = { "go": 0, "caution": 1, "no-go": 2 };
    if (order[newLevel] > order[level]) level = newLevel;
  };
  const cfs = gaugeData.streamflow;
  if (cfs != null) {
    metrics.streamflow_cfs = cfs;
    if (cfs >= t.cfsDanger) {
      escalate("no-go");
      reasons.push(`Streamflow ${cfs} cfs is in the DANGER zone (>${t.cfsDanger} for kayak/canoe). Strong current, swimming hazardous.`);
    } else if (cfs >= t.cfsPushy) {
      escalate("caution");
      reasons.push(`Streamflow ${cfs} cfs is PUSHY for kayaks (>${t.cfsPushy}). Experienced paddlers only.`);
    } else if (cfs >= t.cfsNormal) {
      reasons.push(`Streamflow ${cfs} cfs is normal-to-high \u2014 paddleable with care.`);
    } else if (cfs >= t.cfsCalm) {
      reasons.push(`Streamflow ${cfs} cfs is in the comfortable kayaking range.`);
    } else {
      reasons.push(`Streamflow ${cfs} cfs is LOW \u2014 expect skinny water and possible portaging over shoals.`);
    }
  }
  if (gaugeData.rateOfRiseFtPerHr != null) {
    metrics.rate_of_rise_ft_per_hr = Math.round(gaugeData.rateOfRiseFtPerHr * 100) / 100;
    if (gaugeData.rateOfRiseFtPerHr >= t.gageRiseDangerFtPerHr) {
      escalate("no-go");
      reasons.push(`\u26A0 RAPID RISE: gauge is rising at ${metrics.rate_of_rise_ft_per_hr} ft/hr \u2014 likely dam generation surge or flash flood. Get off the river.`);
    } else if (gaugeData.rateOfRiseFtPerHr >= t.gageRiseDangerFtPerHr * 0.5) {
      escalate("caution");
      reasons.push(`Gauge rising at ${metrics.rate_of_rise_ft_per_hr} ft/hr \u2014 possible dam release starting. Monitor closely.`);
    }
  }
  if (gaugeData.tempC != null) {
    const tempF = Math.round(gaugeData.tempC * 9 / 5 + 32);
    metrics.water_temp_F = tempF;
    if (tempF < t.coldTempStressF) {
      escalate("caution");
      reasons.push(`Water temp ${tempF}\xB0F \u2014 COLD-WATER capsize risk. Wear PFD + appropriate thermal protection (drysuit/wetsuit recommended below ${t.coldTempStressF}\xB0F).`);
    }
  }
  if (!reasons.length) reasons.push("Conditions appear normal \u2014 paddleable.");
  return { status: level, reasons, metrics };
}
function snapToRiver(centerline, userLat, userLon) {
  let best = null;
  for (const wp of centerline) {
    const d = Math.hypot((wp.lat - userLat) * 69, (wp.lon - userLon) * 55);
    if (!best || d < best.dist) best = { dist: d, wp };
  }
  return best;
}
function interpolateSeverity(att, mi) {
  if (!att) return 1;
  if (att.type === "piecewise" && Array.isArray(att.knots) && att.knots.length >= 2) {
    const ks = att.knots;
    if (mi <= ks[0].mi) return ks[0].sev;
    if (mi >= ks[ks.length - 1].mi) return ks[ks.length - 1].sev;
    for (let i = 0; i < ks.length - 1; i++) {
      const a = ks[i], b = ks[i + 1];
      if (mi >= a.mi && mi <= b.mi) {
        const t2 = (mi - a.mi) / Math.max(1e-3, b.mi - a.mi);
        return a.sev + t2 * (b.sev - a.sev);
      }
    }
  }
  const t = Math.max(0, Math.min(1, (mi - (att.fullSeverityMi || 0)) / Math.max(1, (att.dispersedMi || 70) - (att.fullSeverityMi || 0))));
  return Math.max(att.minFactor || 0.2, 1 - t * (1 - (att.minFactor || 0.2)));
}
function estimateSurgeAt(river, userLat, userLon) {
  if (!river.centerline || userLat == null || userLon == null) return null;
  const snap = snapToRiver(river.centerline, userLat, userLon);
  if (!snap || snap.dist > 10) return null;
  const userRiverMi = snap.wp.mi;
  const minutesFromDam = userRiverMi / river.surgeSpeed_mph * 60;
  const severity = interpolateSeverity(river.surgeAttenuation, userRiverMi);
  return {
    nearestWaypoint: snap.wp.name,
    distance_to_waypoint_mi: Math.round(snap.dist * 10) / 10,
    river_mile_from_dam: Math.round(userRiverMi * 10) / 10,
    river_miles_remaining_to_confluence: Math.round((river.riverLength_mi - userRiverMi) * 10) / 10,
    minutes_from_generation_start: Math.round(minutesFromDam),
    surge_speed_mph: river.surgeSpeed_mph,
    surge_severity_factor: Math.round(severity * 100) / 100,
    surge_severity_label: severity > 0.75 ? "full" : severity > 0.5 ? "moderate" : severity > 0.3 ? "reduced" : "minor"
  };
}
async function getRiver(key, opts = {}) {
  const cfg = RIVERS[key];
  if (!cfg) return { error: `unknown river: ${key}` };
  const out = {
    river: cfg.label,
    operator: cfg.operator,
    dam: cfg.damName,
    notes: cfg.notes,
    gauges: [],
    timestamp: (new Date()).toISOString()
  };
  for (const g of cfg.gauges) {
    const data = await fetchUsgs(
      g.site,
      "00010,00060,00065,63160",
      /*periodDays*/
      2
    );
    const rec = {
      site: g.site,
      name: g.name,
      lat: g.lat,
      lon: g.lon,
      primary: !!g.primary,
      streamflow_cfs: data.streamflow ?? null,
      gage_height_ft: data.gageHeight ?? null,
      water_elevation_ft_navd88: data.elevationNavd88 ?? null,
      water_temperature_F: data.tempC != null ? Math.round(data.tempC * 9 / 5 + 32) : null,
      water_temperature_C: data.tempC ?? null,
      timestamp: data.timestamp ?? null
    };
    if (g.primary) {
      const rate = await computeGageRateOfRise(g.site);
      if (rate != null) rec.rate_of_rise_ft_per_hr = Math.round(rate * 100) / 100;
    }
    out.gauges.push(rec);
  }
  if (cfg.damLakeKey && LAKES[cfg.damLakeKey]) {
    try {
      const lakeData = await resolveLake(cfg.damLakeKey);
      out.upstream_lake = {
        name: cfg.damLakeKey,
        elevation_ft: lakeData.elevation_ft,
        percent_full: lakeData.percent_full,
        full_pool_ft: lakeData.full_pool_ft,
        special_message: lakeData.special_message
      };
    } catch (err) {
      // The upstream lake's level is half of reading a dam report -- whether they are
      // generating is mostly a question of how full the pool above is. Dropping it silently
      // hands back a report that looks complete and is missing the causal half.
      console.warn(`[gauges] upstream lake ${cfg.damLakeKey} unavailable:`, err && err.message);
    }
  }
  if (cfg.dukeBasinId) {
    const sched = await fetchDukeFlowArrivals(cfg.dukeBasinId);
    if (sched && sched.arrivals.length) {
      out.dam_schedule = {
        type: "duke_flow_arrivals",
        operator: "Duke Energy",
        basinName: sched.basinName,
        lastUpdated: sched.lastUpdated,
        next: sched.arrivals[0],
        upcoming: sched.arrivals.slice(0, 6),
        source: sched.source
      };
      if (cfg.dukeAnchorRiverMi != null && sched.arrivals[0].arrivalEpoch) {
        const anchorTravelMs = cfg.dukeAnchorRiverMi / cfg.surgeSpeed_mph * 3600 * 1e3;
        out.dam_schedule.generationStartEpoch = sched.arrivals[0].arrivalEpoch - anchorTravelMs;
      }
    }
  }
  if (cfg.dominionSaluda) {
    const dom = await fetchDominionSaludaStatus();
    if (dom) {
      out.dam_schedule = {
        type: "dominion_color_status",
        operator: "Dominion Energy",
        currentColor: dom.currentColor,
        plannedColor: dom.plannedColor,
        currentRange: dom.currentRange,
        plannedRange: dom.plannedRange,
        currentCfsBand: dom.currentCfsBand,
        plannedCfsBand: dom.plannedCfsBand,
        colorLegend: dom.colorLegend,
        source: dom.source
      };
    }
  }
  if (opts.userLat != null && opts.userLon != null) {
    const loc = estimateSurgeAt(cfg, opts.userLat, opts.userLon);
    if (loc) {
      out.user_location = {
        lat: opts.userLat,
        lon: opts.userLon,
        ...loc
      };
      if (out.dam_schedule?.generationStartEpoch != null) {
        const surgeAtUserEpoch = out.dam_schedule.generationStartEpoch + loc.minutes_from_generation_start * 60 * 1e3;
        out.user_location.surge_arrival_epoch = surgeAtUserEpoch;
        out.user_location.surge_arrival_iso = new Date(surgeAtUserEpoch).toISOString();
        out.user_location.minutes_until_surge_at_user = Math.round((surgeAtUserEpoch - Date.now()) / 6e4);
      }
    }
  }
  const primary = out.gauges.find((g) => g.primary) || out.gauges[0];
  if (primary) {
    const assessment = assessKayakSafety(key, {
      streamflow: primary.streamflow_cfs,
      tempC: primary.water_temperature_C,
      rateOfRiseFtPerHr: primary.rate_of_rise_ft_per_hr
    }, cfg.kayakThresholds);
    if (out.user_location?.minutes_until_surge_at_user != null) {
      const m = out.user_location.minutes_until_surge_at_user;
      const sev = out.user_location.surge_severity_factor;
      const sevLabel = out.user_location.surge_severity_label;
      const arrTime = new Date(out.user_location.surge_arrival_epoch).toLocaleTimeString("en-US", { timeZone: "America/New_York" });
      const riverMi = out.user_location.river_mile_from_dam;
      const imminentMin = 120 / Math.max(0.5, sev);
      const headsUpMin = 360 / Math.max(0.5, sev);
      if (m > 0 && m < imminentMin && sev >= 0.5) {
        const order = { "go": 0, "caution": 1, "no-go": 2 };
        if (order[assessment.status] < 2) assessment.status = "no-go";
        assessment.reasons.unshift(
          `\u{1F6D1} ${sevLabel.toUpperCase()} dam surge arrives at YOUR LOCATION (river mile ${riverMi}) in ${m} min (~${arrTime} ET). Get off the water now.`
        );
      } else if (m > 0 && m < headsUpMin) {
        if (assessment.status === "go") assessment.status = "caution";
        const hrs = Math.round(m / 60 * 10) / 10;
        assessment.reasons.unshift(
          `\u26A0 ${sevLabel.toUpperCase()} dam surge expected at YOUR LOCATION (river mile ${riverMi}, ~${out.user_location.river_miles_remaining_to_confluence} mi above confluence) at ~${arrTime} ET (in ${hrs}h). Plan to be off the water by then.`
        );
      } else if (m > 0) {
        const hrs = Math.round(m / 60 * 10) / 10;
        assessment.reasons.push(
          `\u2139 Next dam surge reaches your location (mile ${riverMi}) in ~${hrs}h (${sevLabel} severity at this distance \u2014 surge weakens with distance from dam).`
        );
      }
    } else if (out.dam_schedule?.type === "duke_flow_arrivals" && out.dam_schedule.next) {
      const next = out.dam_schedule.next;
      const minutesUntil = (next.arrivalEpoch - Date.now()) / 6e4;
      if (minutesUntil > 0 && minutesUntil < 120) {
        const order = { "go": 0, "caution": 1, "no-go": 2 };
        if (order[assessment.status] < 2) assessment.status = "no-go";
        assessment.reasons.unshift(
          `\u{1F6D1} SCHEDULED DAM RELEASE arrives at ${next.mileMarkerName} in ${Math.round(minutesUntil)} min (~${new Date(next.arrivalEpoch).toLocaleTimeString("en-US", { timeZone: "America/New_York" })} ET). Severity decreases with distance from dam \u2014 pass your coordinates with ?lat=X&lon=Y for a location-specific estimate.`
        );
      } else if (minutesUntil > 0 && minutesUntil < 360) {
        if (assessment.status === "go") assessment.status = "caution";
        assessment.reasons.unshift(
          `\u26A0 Dam release scheduled to arrive at ${next.mileMarkerName} at ~${new Date(next.arrivalEpoch).toLocaleTimeString("en-US", { timeZone: "America/New_York" })} ET (in ${Math.round(minutesUntil / 60 * 10) / 10}h). For location-specific timing, pass your coordinates with ?lat=X&lon=Y.`
        );
      }
    }
    if (out.dam_schedule?.type === "dominion_color_status") {
      const cur = out.dam_schedule.currentColor;
      if (cur === "red") {
        assessment.status = "no-go";
        assessment.reasons.unshift("\u{1F6D1} Dominion reports current flow in RED RANGE \u2014 class IV-V whitewater, dangerous even for experts.");
      } else if (cur === "yellow") {
        if (assessment.status === "go") assessment.status = "caution";
        assessment.reasons.unshift("\u26A0 Dominion reports current flow in YELLOW RANGE \u2014 experienced paddlers only.");
      } else if (cur === "blue") {
        assessment.reasons.push("Dominion reports current flow in BLUE RANGE (normal/safe paddling).");
      }
      const plan = out.dam_schedule.plannedColor;
      if (plan && plan !== cur) {
        if (plan === "red" || plan === "yellow") {
          if (assessment.status === "go") assessment.status = "caution";
          assessment.reasons.push(`\u26A0 Dominion forecasts flow rising to ${plan.toUpperCase()} range \u2014 be ready to exit.`);
        }
      }
    }
    out.kayak_assessment = assessment;
  }
  return out;
}
async function computeGageRateOfRise(site) {
  try {
    const url = `https://waterservices.usgs.gov/nwis/iv/?sites=${site}&parameterCd=00065&format=rdb&period=PT3H`;
    const r = await fetch(url, { cf: { cacheTtl: 120 } });
    if (!r.ok) return null;
    const text = await r.text();
    const lines = text.split("\n").filter((l) => l && !l.startsWith("#"));
    if (lines.length < 4) return null;
    const header = lines[0].split("	");
    let col = -1;
    for (let i = 4; i < header.length; i++) {
      if (header[i] && !header[i].endsWith("_cd") && header[i].includes("00065")) {
        col = i;
        break;
      }
    }
    if (col < 0) return null;
    const dataLines = lines.slice(2).filter((l) => l.startsWith("USGS"));
    if (dataLines.length < 4) return null;
    const samples = dataLines.map((l) => {
      const p = l.split("	");
      const v = parseFloat(p[col]);
      const [date, time] = p[2].split(" ");
      const ts = (new Date(`${date}T${time}:00`)).getTime();
      return { ts, v };
    }).filter((s) => isFinite(s.v) && isFinite(s.ts));
    if (samples.length < 2) return null;
    const latest = samples[samples.length - 1];
    const targetTs = latest.ts - 60 * 60 * 1e3;
    let closest = samples[0];
    let bestDiff = Math.abs(samples[0].ts - targetTs);
    for (const s of samples) {
      const d = Math.abs(s.ts - targetTs);
      if (d < bestDiff) {
        closest = s;
        bestDiff = d;
      }
    }
    const dtHr = (latest.ts - closest.ts) / 36e5;
    if (dtHr <= 0) return null;
    return (latest.v - closest.v) / dtHr;
  } catch (_) {
    return null;
  }
}
async function fetchDominionSaludaStatus() {
  const COLOR_RANGES = {
    green: { min: 0, max: 350, label: "GREEN \u2014 very low, scraping likely" },
    blue: { min: 350, max: 2e3, label: "BLUE \u2014 normal/safe paddling range" },
    yellow: { min: 2e3, max: 8e3, label: "YELLOW \u2014 high flow, experienced paddlers only" },
    red: { min: 8e3, max: 2e4, label: "RED \u2014 DANGEROUS, class IV-V whitewater, do not enter" }
  };
  try {
    const r = await fetch("https://www.dominionenergy.com/about/lakes-and-recreation/lower-saluda-river-sc", {
      cf: { cacheTtl: 600, cacheEverything: true },
      headers: { "User-Agent": "TrollMap/12 Worker", "Accept": "text/html" }
    });
    if (!r.ok) return null;
    const html = await r.text();
    const cur = html.match(/currently in the[^<]{0,40}<span[^>]*>\s*(blue|yellow|red|green)/i);
    const plan = html.match(/expected to be in the[^<]{0,40}<span[^>]*>\s*(blue|yellow|red|green)/i);
    const currentColor = cur ? cur[1].toLowerCase() : null;
    const plannedColor = plan ? plan[1].toLowerCase() : null;
    return {
      currentColor,
      plannedColor,
      currentRange: currentColor ? COLOR_RANGES[currentColor]?.label : null,
      plannedRange: plannedColor ? COLOR_RANGES[plannedColor]?.label : null,
      currentCfsBand: currentColor ? COLOR_RANGES[currentColor] : null,
      plannedCfsBand: plannedColor ? COLOR_RANGES[plannedColor] : null,
      source: "https://www.dominionenergy.com/about/lakes-and-recreation/lower-saluda-river-sc",
      colorLegend: COLOR_RANGES
    };
  } catch (e) {
    return null;
  }
}
// LAKES is keyed by short nicknames -- wateree, marion, james, russell -- and this matched them
// as bare substrings of whatever name the caller passed. Measured against the 456 display names
// in lake_index.json on 2026-08-15, FIVE waters resolved to a different lake's utility config:
//
//   Wateree River                 -> "wateree"  = Lake Wateree's Duke pool, on the river BELOW it
//   Graves Lake (Marion Co, SC)   -> "marion"   = Lake Marion, Santee Cooper
//   Russ Lake (Marion Co, SC)     -> "marion"   = same
//   Lake Russell                  -> "russell"  = Richard B Russell, a different lake in GA
//   Hartwell Lake (Anderson Co)   -> "hartwell" = the arm slug, harmless and being deleted
//
// The county suffix is the new part. Display names gained "(Marion Co, SC)" so two lakes of the
// same name could be told apart, and every substring matcher keyed on a short name inherited a
// second surface to collide on. Two of the five are county names, not lake names.
//
// Three guards, cheapest first. This is the sixth member of the substring-matcher family the
// deletion tab already lists; the real fix is resolving by registry slug, which needs the slug
// to reach here.
const FLOWING_RE = /\b(river|creek|canal|branch|run|fork|swamp|slough)\b/i;
function resolveLakeKey(lakeName) {
  // 1. The county parenthetical is metadata, not part of the water's name.
  const bare = String(lakeName || '').replace(/\s*\([^)]*\)\s*/g, ' ').trim().toLowerCase();
  // 2. Every key in LAKES is a lake. Flowing water never takes a lake's pool config -- that is
  //    how Wateree River was being handed Lake Wateree's Duke reading.
  if (FLOWING_RE.test(bare)) return null;
  // 3. Whole word, so "russ lake" cannot match "russell" and a key cannot match mid-word.
  return Object.keys(LAKES).find((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(bare)) || null;
}
async function resolveLake(lakeName) {
  const key = resolveLakeKey(lakeName);
  if (!key) return { error: `unknown lake: ${lakeName}` };
  const cfg = LAKES[key];
  const out = {
    waterbody: key,
    elevation_ft: null,
    water_temperature_F: null,
    sources: [],
    timestamp: (new Date()).toISOString()
  };
  if (cfg.pool) {
    const u = await fetchUsgs(cfg.pool, "00010,00062,62614,62615,00065");
    if (u?.elevation != null) {
      out.elevation_ft = round2(u.elevation);
      out.sources.push(`USGS ${cfg.pool} (reservoir elevation)`);
    } else if (u?.gageHeight != null && !cfg.river) {
      out.elevation_ft = round2(u.gageHeight);
      out.sources.push(`USGS ${cfg.pool} (gage height \u2014 verify against published pool)`);
    }
    if (u?.tempC != null) {
      out.water_temperature_F = Math.round(u.tempC * 9 / 5 + 32);
      out.sources.push(`USGS ${cfg.pool} (temp)`);
    }
  }
  if (out.elevation_ft == null && cfg.duke) {
    const lake = await getDukeLake(cfg.duke);
    if (lake) {
      if (lake.ft != null) out.elevation_ft = lake.ft;
      // `index` is Duke's own published number and `display_full_pool` 100 is the scale it sits
      // on, so the card shows what his own lake page shows and he can check one against the other.
      // The unit is NOT a percentage -- see normalizeDukeRow: it is feet inside a 100 ft band
      // hung under full pond, which is why 100 minus it is a drawdown in feet.
      if (lake.index != null) out.display_level = lake.index;
      out.below_full_pool_ft = lake.belowFullPoolFt;
      out.full_pool_ft = lake.fullPool;
      out.display_unit = "ft below full pond scale (100 = full)";
      out.display_full_pool = 100;
      if (isFinite(lake.target)) out.target = lake.target;
      out.sources.push("Duke API /lakes/current-level");
      if (lake.specialMessage) out.special_message = lake.specialMessage;
    }
  }
  // THE SEPA BRANCH IS GONE, AND SO IS EVERYTHING ONLY IT REACHED.
  //
  // Ryan, 2026-08-25: *"nothing hand written... everything expandable... if i decide to add
  // every single lake that garmin has in the US into the app tomorrow this stuff should be able
  // to expand with it"*.
  //
  // What stood here was three hard-coded Corps lakes plus Marion and Moultrie, reached only
  // through the `/lake` route -- which had no caller anywhere in js/. Behind it: a six-row
  // CWMS_PROJECT table, a scrape of water.sas.usace.army.mil for a three-digit number sitting
  // next to a lake name, and a CWMS series fetch. None of it could ever run, and none of it
  // could have grown past the five lakes somebody typed.
  //
  // `/conditions` already answers all five off `water_bindings.json` with nothing typed:
  // usaceLevels() picks the project from the district's own roster of published conservation
  // pools and evaluates the seasonal curve for today, so Hartwell knows it is meant to be at
  // 660 in summer and 656 in winter without a constant anywhere. Marion and Moultrie resolve
  // through their bound USGS sites.
  //
  // resolveLake() stays because getRiver() calls it for the two rivers that name a dam lake,
  // Wateree River and Saluda. Neither of those lakes carried `sepa`, which is why this branch
  // was unreachable in the first place.

  if (out.water_temperature_F == null && cfg.river) {
    const u = await fetchUsgs(cfg.river, "00010,00065,00060,63160");
    if (u?.tempC != null) {
      out.water_temperature_F = Math.round(u.tempC * 9 / 5 + 32);
      out.sources.push(`USGS ${cfg.river} (water temp)`);
    }
    if (u?.gageHeight != null) out.river_gage_height_ft = u.gageHeight;
    if (u?.streamflow != null) out.river_streamflow_cfs = u.streamflow;
    if (u?.elevationNavd88 != null) out.river_water_elevation_ft_navd88 = u.elevationNavd88;
    if (u?.timestamp) out.usgs_timestamp = u.timestamp;
  }
  if (out.water_temperature_F == null && cfg.ahq) {
    const a = await fetchAhqWaterTemp(cfg.ahq);
    if (a?.tempF != null) {
      out.water_temperature_F = a.tempF;
      out.water_temperature_source = `Angler's Headquarters report${a.approx ? " (estimated from range)" : ""}: "${a.raw}"`;
      if (a.range) out.water_temperature_range_F = a.range;
      out.sources.push(`Angler's Headquarters (${cfg.ahq})`);
    }
  }
  if (out.elevation_ft == null && cfg.normalPool) {
    out.elevation_ft = cfg.normalPool;
    out.sources.push("published normal pool (fallback)");
  }
  if (out.full_pool_ft == null && cfg.normalPool) out.full_pool_ft = cfg.normalPool;
  if (out.display_level == null && out.elevation_ft != null) {
    out.display_level = out.elevation_ft;
    out.display_unit = "ft";
    out.display_full_pool = cfg.normalPool || out.full_pool_ft || null;
  }
  out.status = out.elevation_ft != null ? "success" : "no_data";
  return out;
}
function round2(n) {
  return Math.round(n * 100) / 100;
}
var SYNC_STORES = ["plan", "spread", "catch", "chart", "layer"];
async function ensureSyncSchema(db) {
  try {
    await db.exec("CREATE TABLE IF NOT EXISTS sync_items (id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, lastModified TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (type, id))");
  } catch (e) {
    if (!String(e).includes("already exists") && !String(e).includes("SQLITE_ERROR")) throw e;
  }
  try {
    await db.exec("CREATE INDEX IF NOT EXISTS idx_sync_modified ON sync_items(lastModified)");
  } catch (e) {
    if (!String(e).includes("already exists") && !String(e).includes("SQLITE_ERROR")) throw e;
  }
}
async function handleSyncPush(request, env, type, id) {
  if (!SYNC_STORES.includes(type)) {
    return new Response(JSON.stringify({ error: `unknown type: ${type}` }), { headers: JSON_HEADERS, status: 400 });
  }
  const body = await request.json();
  const { lastModified = (new Date()).toISOString(), deleted = false, ...data } = body;
  await ensureSyncSchema(env.DB);
  const payload = JSON.stringify(data);
  try {
    await env.DB.prepare(
      `INSERT INTO sync_items (id, type, payload, lastModified, deleted)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(type, id) DO UPDATE SET
         payload=excluded.payload,
         lastModified=excluded.lastModified,
         deleted=excluded.deleted`
    ).bind(id, type, payload, lastModified, deleted ? 1 : 0).run();
  } catch (dbErr) {
    // NAME THE ROW AND ITS SIZE. `/sync/item/catch/catches` has been returning a bare 500 on
    // every page load, and D1's own message ("D1_ERROR", a constraint name, a limit) says
    // nothing about WHICH record hit it. The catch journal is stored as ONE row holding every
    // catch ever logged, so it grows without bound and is the first candidate for any size
    // limit -- but that is a guess until the number is in the error, so here is the number.
    const kb = (payload.length / 1024).toFixed(1);
    throw new Error(`${type}/${id} insert failed at ${kb} KB payload: ${dbErr.message}`);
  }
  return new Response(JSON.stringify({ ok: true, type, id, lastModified, bytes: payload.length }),
                      { headers: JSON_HEADERS });
}
async function handleSyncListUpdates(url, env) {
  await ensureSyncSchema(env.DB);
  const since = url.searchParams.get("since");
  let rows;
  if (since) {
    rows = await env.DB.prepare(
      `SELECT type, id, lastModified, deleted FROM sync_items WHERE lastModified > ?1 ORDER BY lastModified ASC LIMIT 500`
    ).bind(since).all();
  } else {
    rows = await env.DB.prepare(
      `SELECT type, id, lastModified, deleted FROM sync_items ORDER BY lastModified ASC LIMIT 500`
    ).all();
  }
  const items = (rows.results || []).map((r) => ({
    key: `${r.type}/${r.id}`,
    lastModified: r.lastModified,
    deleted: r.deleted === 1
  }));
  return new Response(JSON.stringify({ items, count: items.length }), { headers: JSON_HEADERS });
}
async function handleSyncGet(env, type, id) {
  await ensureSyncSchema(env.DB);
  const row = await env.DB.prepare(
    `SELECT payload, lastModified, deleted FROM sync_items WHERE type=?1 AND id=?2`
  ).bind(type, id).first();
  if (!row) return new Response(JSON.stringify({ error: "not found" }), { headers: JSON_HEADERS, status: 404 });
  const data = JSON.parse(row.payload);
  return new Response(JSON.stringify({
    ...data,
    lastModified: row.lastModified,
    deleted: row.deleted === 1
  }), { headers: JSON_HEADERS });
}
async function handleSyncDelete(env, type, id) {
  await ensureSyncSchema(env.DB);
  await env.DB.prepare(
    `INSERT INTO sync_items (id, type, payload, lastModified, deleted)
     VALUES (?1, ?2, '{}', ?3, 1)
     ON CONFLICT(type, id) DO UPDATE SET deleted=1, lastModified=excluded.lastModified`
  ).bind(id, type, (new Date()).toISOString()).run();
  return new Response(JSON.stringify({ ok: true, tombstoned: `${type}/${id}` }), { headers: JSON_HEADERS });
}
async function handleSyncMigrate(request, env) {
  await ensureSyncSchema(env.DB);
  const body = await request.json();
  const items = body.items || [];
  let count = 0;
  const errors = [];
  for (const item of items) {
    try {
      const { type, id, lastModified = (new Date()).toISOString(), ...data } = item;
      if (!SYNC_STORES.includes(type) || !id) continue;
      await env.DB.prepare(
        `INSERT INTO sync_items (id, type, payload, lastModified, deleted)
         VALUES (?1, ?2, ?3, ?4, 0)
         ON CONFLICT(type, id) DO UPDATE SET
           payload=excluded.payload,
           lastModified=excluded.lastModified,
           deleted=0`
      ).bind(String(id), type, JSON.stringify(data), lastModified).run();
      count++;
    } catch (e) {
      errors.push({ item, error: e.message });
    }
  }
  return new Response(JSON.stringify({ ok: true, imported: count, errors }), { headers: JSON_HEADERS });
}
function contourGeojsonKey(lake) {
  return `${lake.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}/vectors/contours.geojson`;
}
async function handleContourGeojsonGet(env, lake) {
  const key = contourGeojsonKey(lake);
  const obj = await env.R2_TROLLMAP_CHARTPACKS.get(key);
  if (!obj) return new Response(JSON.stringify({ error: "no vectorized contours for this lake yet" }), { headers: JSON_HEADERS, status: 404 });
  const vcHeaders = new Headers(CORS);
  obj.writeHttpMetadata(vcHeaders);
  const vcBody = r2Body(obj, vcHeaders);         // unwrap gzip here (see chartpack route)
  vcHeaders.set("Content-Type", "application/json");
  vcHeaders.set("Cache-Control", "no-store");
  return new Response(vcBody, { headers: vcHeaders });
}
async function handleContourGeojsonPut(request, env, lake) {
  const body = await request.arrayBuffer();
  if (!body || body.byteLength === 0) {
    return new Response(JSON.stringify({ error: "empty body" }), { headers: JSON_HEADERS, status: 400 });
  }
  const key = contourGeojsonKey(lake);
  await env.R2_TROLLMAP_CHARTPACKS.put(key, body, {
    httpMetadata: { contentType: "application/json", cacheControl: "no-store" }
  });
  return new Response(JSON.stringify({ ok: true, key, bytes: body.byteLength }), { headers: JSON_HEADERS });
}
function buildStage1Prompt(species_list, assume_board = false, lat = null, lon = null) {
  const species_str = species_list.map((s) => `"${s}"`).join(", ");
  const gps_tag = isFinite(lat) && isFinite(lon) ? `Photo GPS location: lat=${lat.toFixed(4)}, lon=${lon.toFixed(4)} \u2014 ${lon > -80.2 && lat < 33.8 ? "COASTAL SALTWATER" : "INLAND FRESHWATER"}` : `Photo GPS location: GPS unknown`;
  const board_task = assume_board ? `TASK 1 \u2014 BUMP BOARD: This photo is confirmed to contain a fish on a bump board. on_bump_board = true.` : `TASK 1 \u2014 BUMP BOARD DETECTION
A bump board is ANY rigid measuring device with a perpendicular nose stop and inch markings.
Common boards: Ketch Board (yellow), Hawg Trough, Golden Rule, homemade wood board.
IMPORTANT: Do NOT reject bump board because:
  - board is dirty, wet, or has stickers on it
  - numbers are faded or partially visible
  - board edge is cropped out of frame
  - fish tail hangs slightly off the end
If ANY measuring device with markings is present under the fish \u2192 on_bump_board = true`;
  return `You are a precise fisheries technician for a South Carolina kayak angler.
Return ONLY valid JSON. Temperature = 0. No guessing. No placeholders.
${gps_tag}
IMPORTANT: Use the GPS location to rule out impossible species. Inland freshwater GPS = no saltwater fish possible.

${board_task}

TASK 2 \u2014 SPECIES IDENTIFICATION
This angler fishes South Carolina freshwater lakes AND coastal saltwater. Species priority rules:

STRIPED BASS (highest priority freshwater):
  - 7-8 UNBROKEN horizontal black stripes running full body length
  - Forked tail, two separate dorsal fins
  - JUVENILE RULE: Never classify as White Bass/Hybrid because fish is small (<20 inches)
  - If continuous horizontal stripes are visible \u2192 classify as Striped Bass regardless of size

BOWFIN:
  - Single LONG dorsal fin running most of body length (not two separate fins)
  - Rounded tail (not forked)
  - Dark eyespot near base of tail \u2014 WARNING: this eyespot looks like a redfish spot but bowfin are FRESHWATER
  - Olive/brown/dark color, no stripes
  - CRITICAL: Bowfin have ONE continuous dorsal fin. Red Drum have TWO separate dorsal fins.
  - If GPS coordinates are inland/freshwater and fish has eyespot \u2192 Bowfin, NOT Red Drum

CHAIN PICKEREL:
  - Long duck-bill snout, very toothy
  - Chain-link or reticulated pattern on sides (not stripes)
  - Elongated body

CATFISH:
  - Visible whiskers/barbels around mouth
  - Smooth skin, no scales
  - No horizontal stripes
  - Blue Catfish: slate blue, straight anal fin
  - Channel Catfish: olive with dark spots, rounded anal fin
  - Flathead Catfish: flat broad head, lower jaw protruding, mottled yellow/brown

BASS (Largemouth / Spotted / Smallmouth):
  - Largemouth: jaw PAST eye, dorsal deeply notched, dark lateral blotchy band, no tongue tooth patch
  - Spotted Bass: jaw to MID-eye, rough tooth patch on tongue, dorsal fins connected, rows small spots below lateral line
  - Smallmouth: bronze, vertical bars, jaw BEFORE eye \u2013 ONLY Upstate / Jocassee / Broad River \u2013 DO NOT default Smallmouth in Wateree/Murray/Marion

CRAPPIE:
  - Deep compressed panfish
  - Black Crappie: 7-8 dorsal spines, irregular speckling
  - White Crappie: 5-6 dorsal spines, vertical barring
  - If spines not countable \u2192 "Crappie"

SUNFISH / PANFISH:
  - Bluegill: blue-purple gill flap, vertical barring, orange breast
  - Redear Sunfish (Shellcracker): red/orange margin on opercular flap
  - If uncertain beyond family \u2192 "Sunfish (Panfish)"

SALTWATER SPECIES (if coastal GPS or saltwater environment visible):
  - Red Drum (Redfish): copper/bronze body, ONE OR MORE black spots near tail base, TWO separate dorsal fins, no stripes, chin NO barbels
  - Speckled Trout: silver with scattered black spots on body AND fins, canine teeth
  - Flounder: FLAT fish, both eyes on same side, lies flat, mottled brown

GAR:
  - Long needle snout, ganoid diamond scales, long cylindrical body
  - Longnose Gar: snout >2\xD7 head length

Species choices (pick closest match): [${species_str}, "Other Fish"]

TASK 3 \u2014 LENGTH MEASUREMENT
ONLY if fish is on bump board:
  Step 1: Find nose touching bump stop (this is the 0 mark)
  Step 2: Find the FURTHEST tail tip \u2014 not the body end, the actual fin tip
  Step 3: Read ruler mark where tail tip ends
  Step 4: Round to nearest 0.25 inch \u2014 tail pinched \u2013 if ruler mark is not clearly readable \u2192 length_inches = null
  Step 5: If ruler mark is not clearly readable \u2192 length_inches = null
  CRITICAL \u2014 IGNORE ALL OF THESE when reading length:
    - Numbers on fish finders, GPS units, depth sounders, or any electronics in the photo
    - Stickers or labels on the board
    - The far end of the board
    - Your estimate of how big the fish looks
  READ ONLY the ruler mark on the bump board where the tail tip ends

Return ONLY this JSON:
{"has_fish": <true/false>, "on_bump_board": <true/false>, "species": "<exact species from list>", "length_inches": <number or null>, "confidence": "high|medium|low", "notes": "<what you see: tail tip position, visible ruler marks, species field marks>"}`;
}
var CATCH_JSON_SCHEMA = {
  type: "OBJECT",
  properties: {
    has_fish: { type: "BOOLEAN" },
    on_bump_board: { type: "BOOLEAN" },
    species: { type: "STRING" },
    length_inches: { type: ["NUMBER", "NULL"] },
    confidence: { type: "STRING", enum: ["high", "medium", "low"] },
    notes: { type: "STRING" }
  },
  required: ["has_fish", "on_bump_board", "species", "confidence"]
};
async function handleIdentifyCatch(request, env) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");
  const latHeader = parseFloat(request.headers.get("X-Lat"));
  const lonHeader = parseFloat(request.headers.get("X-Lon"));
  const lake = request.headers.get("X-Lake") || "";
  const date = request.headers.get("X-Date") || "";
  const speciesHintHeader = (request.headers.get("X-Species-Hint") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const mimeType = request.headers.get("X-Image-Type") || request.headers.get("Content-Type") || "image/jpeg";
  const imageBuffer = await request.arrayBuffer();
  const bytes = new Uint8Array(imageBuffer);
  let binary = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  const base64String = btoa(binary);
  let species_list = speciesHintHeader.length ? speciesHintHeader : getSpeciesListForGps(latHeader, lonHeader);
  const extra = ["Striped Bass", "Largemouth Bass", "Spotted Bass", "Smallmouth Bass", "Crappie", "Blue Catfish", "Channel Catfish", "Flathead Catfish", "Catfish", "Bowfin", "Bowfin (Mudfish)", "Chain Pickerel", "Bluegill", "Redear Sunfish (Shellcracker)", "Sunfish (Panfish)", "Yellow Perch", "White Bass / Hybrid", "Longnose Gar", "Gar", "Red Drum (Redfish)", "Speckled Trout (Spotted Seatrout)", "Flounder", "American Shad", "Other Fish", "Not Fish"];
  species_list = [...new Set([...species_list, ...extra])];
  const assume_board = (request.headers.get("X-Assume-Board") || "").toLowerCase() === "true";
  const prompt = buildStage1Prompt(species_list, assume_board, isFinite(latHeader) ? latHeader : null, isFinite(lonHeader) ? lonHeader : null);
  const payload = {
    systemInstruction: { parts: [{ text: "You are a precise fisheries technician. Return ONLY valid JSON. Temperature = 0." }] },
    contents: [{ parts: [
      { text: prompt },
      { inlineData: { mime_type: mimeType, data: base64String } }
    ] }],
    generationConfig: {
      temperature: 0,
      response_mime_type: "application/json",
      response_schema: CATCH_JSON_SCHEMA
    }
  };
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const geminiResp = await fetch(geminiUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (!geminiResp.ok) {
    const errText = await geminiResp.text();
    throw new Error(`Gemini API ${geminiResp.status}: ${errText.slice(0, 300)}`);
  }
  const geminiData = await geminiResp.json();
  const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error("Empty response from Gemini");
  let analysis;
  try {
    analysis = JSON.parse(rawText);
  } catch (e) {
    const m = rawText.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("Gemini returned non-JSON: " + rawText.slice(0, 200));
    analysis = JSON.parse(m[0]);
  }
  const SPECIES_MAP = {
    "Bowfin (Mudfish)": "Bowfin",
    "Mudfish": "Bowfin",
    "Black Crappie": "Crappie",
    "White Crappie": "Crappie",
    "Red Drum": "Red Drum (Redfish)",
    "Redfish": "Red Drum (Redfish)",
    "Spotted Seatrout": "Speckled Trout (Spotted Seatrout)",
    "Speckled Trout": "Speckled Trout (Spotted Seatrout)",
    "Redear Sunfish": "Redear Sunfish (Shellcracker)",
    "Shellcracker": "Redear Sunfish (Shellcracker)",
    "Bluegill": "Bluegill",
    "Panfish": "Sunfish (Panfish)",
    "Bream": "Sunfish (Panfish)",
    "White Bass": "White Bass / Hybrid",
    "Hybrid Bass": "White Bass / Hybrid",
    "Hybrid": "White Bass / Hybrid",
    "Wiper": "White Bass / Hybrid",
    "Striper": "Striped Bass",
    "Striped bass": "Striped Bass",
    "Largemouth bass": "Largemouth Bass",
    "Spotted bass": "Spotted Bass",
    "Smallmouth bass": "Smallmouth Bass",
    "Blue catfish": "Blue Catfish",
    "Channel catfish": "Channel Catfish",
    "Flathead catfish": "Flathead Catfish",
    "No Fish": "Not Fish",
    "None": "Not Fish",
    "Shad": "American Shad"
  };
  let species = analysis.species || "Other Fish";
  species = SPECIES_MAP[species] || species;
  const has_fish = analysis.has_fish ?? true;
  const on_bump_board = analysis.on_bump_board ?? false;
  let length_inches = analysis.length_inches;
  if (length_inches != null) {
    length_inches = Math.round(Number(length_inches) * 4) / 4;
  }
  let confidence = analysis.confidence || "medium";
  let notes = analysis.notes || "";
  if (isFinite(latHeader) && isFinite(lonHeader) && has_fish) {
    const [eco_ok, eco_warn] = checkEcologicalReality(latHeader, lonHeader, species);
    if (!eco_ok) {
      notes = `${eco_warn} | ${notes}`.replace(/^\s*\|\s*|\s*\|\s*$/g, "");
      confidence = "low";
      if (/Bowfin.*Red Drum|Red Drum.*Bowfin|eyespot/i.test(eco_warn)) {
        if (lonHeader <= -80.35) species = "Bowfin";
      }
    }
  }
  if (length_inches != null && has_fish) {
    const [len_ok, len_warn] = checkBiologicalLength(species, Number(length_inches));
    if (!len_ok) {
      notes = `${len_warn} | ${notes}`.replace(/^\s*\|\s*|\s*\|\s*$/g, "");
      confidence = "low";
    }
  }
  const out = {
    // fish_sorter_v4 canonical (python-compatible)
    has_fish,
    on_bump_board,
    species,
    length_inches: length_inches ?? null,
    confidence,
    notes,
    // catch-journal.js camelCase compat
    lengthInches: length_inches ?? null,
    species_confidence: confidence === "high" ? 0.9 : confidence === "medium" ? 0.65 : 0.4,
    // extended v2 fields
    length_source: on_bump_board ? length_inches != null ? "board_ruler" : "board_no_read" : "body_estimate",
    board_detected: !!on_bump_board,
    board_type: on_bump_board ? "generic" : "none",
    measurement_confidence: confidence,
    data_quality: {
      species: confidence === "high" ? "ai_verified" : "ai",
      length: on_bump_board && length_inches != null ? "board_verified" : length_inches != null ? "estimated" : "missing",
      lure: "missing",
      speed: "missing",
      depth: "missing",
      gps: isFinite(latHeader) && isFinite(lonHeader) ? "exif" : "missing"
    },
    trollmap_tags: [],
    source_model: "gemini-2.5-flash fish_sorter_v4"
  };
  if (/Bowfin/i.test(species)) out.trollmap_tags.push("reaction_feeder", "vegetation_trolling_target");
  if (/Striped Bass/i.test(species)) out.trollmap_tags.push("trolling_primary", "thermocline");
  if (/Red Drum|Redfish/i.test(species)) out.trollmap_tags.push("inshore", "tide_dependent");
  if (on_bump_board) out.trollmap_tags.push("board_measured");
  return out;
}
async function handleIdentifyCatchV2(request, env) {
  let ctx = {};
  let mime_type = "image/jpeg";
  let image_base64 = null;
  try {
    const body = await request.json();
    image_base64 = body.image_base64;
    mime_type = body.mime_type || mime_type;
    ctx = body.context || {};
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: "invalid JSON body \u2013 expected {image_base64, context{}}" }), { status: 400, headers: JSON_HEADERS });
  }
  if (!image_base64) {
    return new Response(JSON.stringify({ success: false, error: "missing image_base64" }), { status: 400, headers: JSON_HEADERS });
  }
  const fakeReq = {
    headers: { get: (k) => {
      const map = {
        "X-Image-Type": mime_type,
        "Content-Type": mime_type,
        "X-Lake": ctx.lake || "",
        "X-Date": ctx.date || "",
        "X-Lat": ctx.lat != null ? String(ctx.lat) : "",
        "X-Lon": ctx.lon != null ? String(ctx.lon) : "",
        "X-Species-Hint": (ctx.species_hint || []).join(","),
        "X-Assume-Board": ctx.assume_board ? "true" : ""
      };
      return map[k] || null;
    } },
    arrayBuffer: async () => {
      const bin = atob(image_base64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return arr.buffer;
    }
  };
  const analysis = await handleIdentifyCatch(fakeReq, env);
  return new Response(JSON.stringify({
    success: true,
    analysis,
    context_used: ctx,
    taxonomy_version: "fish_sorter_v4 / TrollMap v13",
    timestamp: (new Date()).toISOString()
  }), { headers: JSON_HEADERS });
}
// The Groq coach was deleted 2026-08-20 with SmartPlan v1. COACH_SYSTEM_PROMPT and
// handleCoachPlan lived here and were reached only through /coach-plan, whose only caller
// was js/modules/groq-coach.js, which was imported only by js/modules/smart-plan.js --
// unreachable since v2 shipped. Ryan, 2026-08-20: "Cut v1, let the coach go".
// ─── LAKE RESEARCH MODULE ─────────────────────────────────────────────────
// Implements spec v1.0: Lake Research permanent intelligence profiles


var trollmap_worker_default = {
  /**
   * THE CRON, AND THE REASON THERE IS ONE.
   *
   * Every other thing this Worker does happens because a browser asked. This one happens because
   * a clock did, and it is the only path that can reach Ryan with the app closed and the phone
   * asleep. Wired to a five-minute cron in wrangler.toml, matching the cadence the
   * in-page poll already used, so the two paths cannot disagree about how current an alert is.
   *
   * A THROW HERE IS SILENT. Cloudflare does not retry a failed scheduled run and nothing is
   * watching it, so the sweep swallows per-watch failures internally and this logs the summary —
   * `wrangler tail` is the only place a bad sweep is visible.
   */
  async scheduled(event, env, ctx) {
    const summary = await runAlertSweep(env).catch((e) => ({ error: e && e.message }));
    console.log('[alerts] sweep', JSON.stringify(summary));

    // THE SECOND THING THE CLOCK IS FOR, AND IT RUNS AFTER THE ALERTS AND CANNOT DISTURB THEM.
    //
    // Ryan's 2026-09-01 plan, step 4: "give WQP a TTL and put its refresh on the existing cron",
    // gated to the oldest waters per firing so the card rolls over inside a month. The thermocline
    // and the anoxic boundary are climatological -- derived once from a depth-profile pull, not
    // read off an instrument today -- so they belong on a slow clock and not in a plan's critical
    // path. Every firing where nothing is past its thirty days costs two R2 listings and stops.
    //
    // SEPARATELY AWAITED AND SEPARATELY CAUGHT. runAlertSweep is the only path that reaches Ryan
    // with the app closed and the phone asleep; a throw here is silent and Cloudflare does not
    // retry, so a bad WQP day must not be able to take the alerts with it.
    const limn = await refreshStaleLimnology(env).catch((e) => ({ error: e && e.message }));
    if (limn && (limn.refreshed || limn.failed?.length || limn.error)) {
      console.log('[limnology] sweep', JSON.stringify(limn));
    }
  },

  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const lake = (url.searchParams.get("lake") || "").toLowerCase();

    // One gate for every route that changes stored state. See MUTATING_ROUTES above.
    if (!(await allowMutation(request, url, path, env))) {
      return new Response(JSON.stringify({ error: "unauthorized", path }),
                          { status: 401, headers: JSON_HEADERS });
    }

    try {
      // Which code is actually live. Both markers come from different files in the
      // bundle: if they disagree with each other, or with what is in main, the
      // deployed bundle is not the repo and no amount of reading the source will
      // explain the behaviour you are seeing.
      if (path === "/build") {
        return new Response(JSON.stringify({
          worker: WORKER_BUILD,
          arcgis: ARCGIS_BUILD,
        }), { headers: JSON_HEADERS });
      }
      if (path === "/identify-catch" && request.method === "POST") {
        try {
          const analysis = await handleIdentifyCatch(request, env);
          return new Response(JSON.stringify({ success: true, analysis }), { headers: JSON_HEADERS });
        } catch (err) {
          return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: JSON_HEADERS });
        }
      }
      if (path === "/identify-catch-v2" && request.method === "POST") {
        try {
          return await handleIdentifyCatchV2(request, env);
        } catch (err) {
          return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: JSON_HEADERS });
        }
      }
      if (path === "/groq-query" && request.method === "POST") {
        try {
          const body = await request.json();
          const { messages, model, max_tokens = 200, temperature = 0.2, response_format } = body;
          if (!messages?.length) return new Response(JSON.stringify({ error: "Missing messages" }), { status: 400, headers: JSON_HEADERS });
          const { provider, model: usedModel, data } = await callLLM(env, { messages, model, max_tokens, temperature, response_format });
          const headers = { ...JSON_HEADERS, "X-LLM-Provider": provider, "X-LLM-Model": usedModel };
          // Attach provider info to payload for frontend debugging without breaking OpenAI shape
          if (data && typeof data === "object" && !data._trollmap) {
            data._trollmap = { provider, model: usedModel };
          }
          return new Response(JSON.stringify(data), { headers });
        } catch (e) {
          return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: JSON_HEADERS });
        }
      }
      // ── LAKE RESEARCH ROUTES ─────────────────────────────────────
      if (path === "/research/thermocline-search" && request.method === "POST") {
        return handleResearchThermoclineSearch(request, env);
      }


      if (path === "/research/limnology-data" && request.method === "POST") {
        return handleResearchLimnologyData(request, env);
      }
      if (path === "/research/deterministic-facts" && request.method === "POST") {
        return handleResearchDeterministicFacts(request, env);
      }
      if (path === "/research/discover" && request.method === "POST") {
        return handleResearchDiscover(request, env);
      }
      if (path === "/research/dataset-hunt" && request.method === "POST") {
        return handleResearchDatasetHunt(request, env);
      }
      if (path === "/research/proxy-download" && request.method === "GET") {
        return handleResearchProxyDownload(request, env);
      }
      if (path === "/research/get-normalized" && request.method === "GET") {
        const lake = url.searchParams.get("lake") || url.searchParams.get("lakeName") || "";
        if (!lake) return new Response(JSON.stringify({ok:false, error:"missing lake param"}), {status:400, headers:JSON_HEADERS});
        return handleResearchGetNormalized(env, lake);
      }
      if (path === "/research/save-normalized" && request.method === "POST") {
        return handleResearchSaveNormalized(request, env);
      }
      if (path === "/research/analyze-facts" && request.method === "POST") {
        return handleResearchAnalyzeFacts(request, env);
      }
      if (path === "/research/dedupe-contradictions" && request.method === "POST") {
        return handleResearchDedupeContradictions(request, env);
      }
      if (path === "/research/map-facts" && request.method === "POST") {
        return handleResearchMapFacts(request, env);
      }
      if (path === "/research/gap-analysis" && request.method === "POST") {
        return handleResearchGapAnalysis(request, env);
      }
      if (path === "/research/gap-search" && request.method === "POST") {
        return handleResearchGapSearch(request, env);
      }
      if (path === "/research/agent-llm" && request.method === "POST") {
        return handleResearchAgent(request, env);
      }
      if ((path === "/research/list" || path === "/lakes/list") && request.method === "GET") {
        return handleResearchList(env);
      }
      if (path === "/research/get" && request.method === "GET") {
        const lake = url.searchParams.get("lake") || url.searchParams.get("lakeName") || "";
        if (!lake) return new Response(JSON.stringify({ok:false, error:"missing lake param"}), {status:400, headers:JSON_HEADERS});
        // `?version=N` serves lakes/versions/<id>/vN.json instead of the master. Read-only, and
        // it changes nothing about the default call.
        const vRaw = url.searchParams.get("version");
        const version = vRaw == null || vRaw === "" ? null : Number(vRaw);
        if (version != null && (!Number.isInteger(version) || version < 1)) {
          return new Response(JSON.stringify({ok:false, error:`version must be a positive integer, got ${vRaw}`}),
            {status:400, headers:JSON_HEADERS});
        }
        return handleResearchGet(env, lake, version);
      }
      if (path === "/research/save" && request.method === "POST") {
        return handleResearchSave(request, env);
      }
      if (path === "/research/approve" && request.method === "POST") {
        return handleResearchApprove(request, env);
      }
      if (path === "/research/delete" && request.method === "POST") {
        return handleResearchDelete(request, env);
      }
      if (path === "/research/delete-normalized-doc" && request.method === "POST") {
        return handleResearchDeleteNormalizedDoc(request, env);
      }
      if (path === "/research/proxy-download-batch" && request.method === "POST") {
        return handleResearchProxyDownloadBatch(request, env);
      }
      // ── Phase 2: Shared R2 document registry ──────────────────────────────
      if (path === "/research/shared/check" && request.method === "POST") {
        return handleSharedCheck(request, env);
      }
      if (path === "/research/shared/store" && request.method === "POST") {
        return handleSharedStore(request, env);
      }
      if (path === "/research/shared/query" && request.method === "POST") {
        return handleSharedQuery(request, env);
      }
      if (path === "/research/shared/publish" && request.method === "POST") {
        return handleSharedPublish(request, env);
      }
      if (path === "/research/shared/status" && request.method === "GET") {
        return handleSharedStatus(request, env);
      }
      if (path === "/research/shared/quarantine" && request.method === "POST") {
        return handleSharedQuarantine(request, env);
      }
      if (path === "/research/package" && request.method === "GET") {
        const lake = url.searchParams.get("lake") || "";
        if (!lake) return new Response(JSON.stringify({ok:false, error:"missing lake"}), {status:400, headers:JSON_HEADERS});
        const file = url.searchParams.get("file");
        if (file) return handleResearchPackageFile(env, lake, file);
        return handleResearchPackage(env, lake);
      }
      if (path === "/lake-research" && request.method === "GET") {
        const lake = url.searchParams.get("lake") || "";
        if (!lake) return new Response(JSON.stringify({ok:false, error:"missing lake"}), {status:400, headers:JSON_HEADERS});
        const enhanced = await handleEnhancedLakeIntel(lake, env);
        return new Response(JSON.stringify(enhanced, null, 2), {headers: JSON_HEADERS});
      }
      if (path.startsWith("/lakes/") && request.method === "GET") {
        // /lakes/<id>.json or /lakes/<id> -> get master
        const m = path.match(/^\/lakes\/([^\/]+)(?:\.json)?$/);
        if (m) {
          return handleResearchGet(env, decodeURIComponent(m[1]));
        }
      }
      if (path === '/research/validation-pass' && request.method === 'POST') return handleResearchValidationPass(request, env);


      if (path === "/ramps") {
        // ONE TABLE, IN Worker/core/ramp-sources.js.
        //
        // This was a copy, and research/facts-util.js had the other one. Only that one read a
        // species list -- so SC's arrived here and GA's forty-eight yes/no columns were never
        // asked for at all. See the header of ramp-sources.js for what each state's copy said
        // and which half of each disagreement survived.
        return handleGisRoute({
          env,
          url,
          cachePrefix: "ramps",
          ttlDays: 7,
          sources: RAMP_SOURCES,
          buildResult: (state, source, waterbodies, count) => ({
            state,
            source: source.label,
            fetched: new Date().toISOString(),
            count,
            waterbodyCount: Object.keys(waterbodies).length,
            waterbodies,
          }),
        });
      }

      if (path === "/paddle") {
        const PADDLE_SOURCES = {
          SC: {
            url: "https://services.arcgis.com/acgZYxoN5Oj8pDLa/arcgis/rest/services/South_Carolina_Public_Water_Access_PUBLIC_VIEW/FeatureServer/0/query",
            filter: (p) => p.WaterAccessType === "Paddle Launch" && p.Status?.toLowerCase() === "active" && p.PublicAccess?.toLowerCase() !== "closed",
            name: (p) => p.WaterAccessName,
            wb: (p) => p.Waterbody,
            lat: (p) => p.Latitude,
            lon: (p) => p.Longitude,
            meta: (p) => ({ subtype: p.WaterAccessSubType, county: p.County, owner: p.Owner }),
            metaNested: true,
          },
          GA: {
            url: "https://services6.arcgis.com/9QlSLDqa0P1cHLhu/arcgis/rest/services/WRD_Water_Access_Points/FeatureServer/0/query",
            idField: "FID",
            filter: (p) => flagIsYes(p.CanoeAcc) && !["closed", "inactive"].includes(String(p.Status || "").toLowerCase()),
            name: (p) => p.Name,
            wb: (p) => p.Waterbody,
            lat: (p) => p.Latitude,
            lon: (p) => p.Longitude,
            meta: (p) => ({ county: p.County, owner: p.Owner }),
            metaNested: true,
          },
          NC: {
            url: "https://services1.arcgis.com/YfqBAUM5nWR3yhGP/arcgis/rest/services/NCWRC_Boating_Access_Areas_view/FeatureServer/0/query",
            // Non_Motorized_Access is a coded-value domain: the viewer shows YES/NO,
            // the REST response returns 1/0. Comparing it to "yes" matched NOTHING --
            // the only sites getting through were the 11 with free-text
            // Portable_Boat_Access_Type, out of 136 that qualify. Verified 2026-08-04:
            // `where=Non_Motorized_Access=1 AND Site_Status='OPEN'` returns 136.
            // Site_Status IS stored as text ('OPEN'), so that half stays a string compare.
            filter: (p) => (flagIsYes(p.Non_Motorized_Access) || hasText(p.Portable_Boat_Access_Type)) && String(p.Site_Status || "").toLowerCase() === "open",
            name: (p) => p.BAA_Name,
            wb: (p) => p.Water_Access,
            lat: (p) => p.Latitude,
            lon: (p) => p.Longitude,
            meta: (p) => ({ type: p.Portable_Boat_Access_Type, county: p.County, owner: p.Owner }),
            metaNested: true,
          },
          TN: {
            url: "https://services3.arcgis.com/PWXNAH2YKmZY7lBq/arcgis/rest/services/Paddling_Access_Sites/FeatureServer/0/query",
            // Paddling_Access_Sites is a VIEW over TWRA's AllAccessSites layer, and its
            // viewDefinitionQuery is already "(Type = 'Paddling') AND (IncludeWeb = 'Yes')".
            // Both halves are applied server-side. IncludeWeb is not in the layer's field
            // list, so it never comes back in the response -- p.IncludeWeb was `undefined`
            // on every row and this filter rejected all 34 sites. Verified 2026-08-04
            // against the layer definition. Type IS returned, so re-checking it here is a
            // real assertion rather than a tautology: if TWRA ever repoints this view at
            // the unfiltered layer, we still only take paddling sites.
            // Do NOT filter on CanoeLanding -- it is "No" or null on legitimate paddle
            // sites (Black Fox and Dodd Hollow, among others).
            filter: (p) => p.Type === "Paddling",
            name: (p) => p.Name,
            wb: (p) => p.Waterway,
            lat: (p) => p.Latitude,
            lon: (p) => p.Longitude,
            meta: (p) => ({ county: p.County, owner: p.Owner, type: "Paddling Access" }),
            metaNested: true,
          }
        };
        return handleGisRoute({
          env,
          url,
          cachePrefix: "paddle",
          ttlDays: 7,
          sources: PADDLE_SOURCES,
          buildResult: (state, source, waterbodies, count) => ({
            state,
            source: source.url,
            count,
            waterbodies,
          }),
        });
      }

      if (path === "/bank-pier") {
        const BANKPIER_SOURCES = {
          SC: {
            url: "https://services.arcgis.com/acgZYxoN5Oj8pDLa/arcgis/rest/services/South_Carolina_Public_Water_Access_PUBLIC_VIEW/FeatureServer/0/query",
            filter: (p) => (p.WaterAccessType === "Bank" || p.WaterAccessType === "Pier" || flagIsYes(p.FishingPier)) && p.Status?.toLowerCase() === "active" && p.PublicAccess?.toLowerCase() !== "closed",
            name: (p) => p.WaterAccessName,
            wb: (p) => p.Waterbody,
            lat: (p) => p.Latitude,
            lon: (p) => p.Longitude,
            meta: (p) => ({ type: p.WaterAccessType, pier: p.FishingPier }),
            metaNested: true,
          },
          GA: {
            url: "https://services6.arcgis.com/9QlSLDqa0P1cHLhu/arcgis/rest/services/WRD_Water_Access_Points/FeatureServer/0/query",
            idField: "FID",
            filter: (p) => (flagIsYes(p.BankFish) || flagIsYes(p.PierFish)) && !["closed", "inactive"].includes(String(p.Status || "").toLowerCase()),
            name: (p) => p.Name,
            wb: (p) => p.Waterbody,
            lat: (p) => p.Latitude,
            lon: (p) => p.Longitude,
            meta: (p) => ({ bankFish: p.BankFish, pierFish: p.PierFish }),
            metaNested: true,
          },
          NC: {
            url: "https://services1.arcgis.com/YfqBAUM5nWR3yhGP/arcgis/rest/services/NCWRC_Public_Fishing_Areas_view/FeatureServer/0/query",
            filter: (p) => String(p.Site_Status || "").toLowerCase() === "open",
            name: (p) => p.PFA_Name,
            wb: (p) => p.Water_Access,
            lat: (p) => p.Latitude,
            lon: (p) => p.Longitude,
            meta: (p) => ({ pier: p.Fishing_Pier, bank: p.Bank_Access }),
            metaNested: true,
          },
          TN: {
            url: "https://services3.arcgis.com/PWXNAH2YKmZY7lBq/arcgis/rest/services/Fishing_Sites/FeatureServer/0/query",
            // Same bug as TN paddle. Fishing_Sites is a view over AllAccessSites whose
            // viewDefinitionQuery is "(Type = 'Fishing Site') AND (IncludeWeb = 'Yes')",
            // and IncludeWeb is NOT in the view's field list -- so this rejected all 118
            // sites. (The TN /ramps view, Boat_Launch_Sites, DOES expose IncludeWeb,
            // which is why that one feed kept working and hid the pattern.)
            filter: (p) => p.Type === "Fishing Site",
            name: (p) => p.Name,
            wb: (p) => p.Waterway,
            lat: (p) => p.Latitude,
            lon: (p) => p.Longitude,
            meta: (p) => ({ type: p.Type, pier: p.FishingPier === "Yes", county: p.County, owner: p.Owner }),
            metaNested: true,
          }
        };
        return handleGisRoute({
          env,
          url,
          cachePrefix: "bankpier",
          ttlDays: 7,
          sources: BANKPIER_SOURCES,
          buildResult: (state, source, waterbodies, count) => ({
            state,
            source: source.url,
            count,
            waterbodies,
          }),
        });
      }

      if (path === "/attractors") {
        // Read verbatim from the service's own cvd_attractor_code domain, 2026-08-06.
        const GA_ATTRACTOR_CODES = {
          AJK: "A Jack", ADU: "Air Diffuser Unit", BLD: "Boulders", CON: "Concrete",
          CRT: "Crate", GVL: "Gravel", HNH: "Honeyhole", MBK: "Mossback Trophy Tree XL",
          PAL: "Plastic Pallet Tent", PCP: "Porcupine Balls", PVC: "PVC Cube",
          PVT: "PVC Trees", RRP: "Rip Rap", STB: "Stake Bed", TRE: "Trees/Brush",
          UNK: "Unknown", OTH: "Other", other: "Other",
        };
        const ATTRACTOR_SOURCES = {
          SC: {
            url: "https://services.arcgis.com/acgZYxoN5Oj8pDLa/arcgis/rest/services/SCDNR_Freshwater_Fish_Attractors_Public_Web_App/FeatureServer/0/query",
            filter: (p) => true,
            name: (p) => p.FishAttractorName,
            wb: (p) => p.Waterbody,
            lat: (p) => p.lat_dd,
            lon: (p) => p.lon_dd,
            type: (p) => p.Material,
            metaMode: "type",
          },
          // GA carried `lat: () => null, lon: () => null` -- every one of its 2,202
          // attractors came back with no position and was dropped by the client's
          // isFinite guard. It went unnoticed because the front end took GA from a
          // static snapshot instead of this route. Field names verified against the
          // service: lowercase `latitude` / `longitude`, esriFieldTypeDouble.
          GA: {
            url: "https://services6.arcgis.com/9QlSLDqa0P1cHLhu/arcgis/rest/services/Fish_Attractors_for_Download/FeatureServer/0/query",
            filter: (p) => true,
            name: (p) => (p.note || "").trim() || `${p.waterbody || "GA"} attractor`,
            wb: (p) => p.waterbody,
            lat: (p) => p.latitude,
            lon: (p) => p.longitude,
            // attractor_code is a coded-value domain; the raw code ("TRE", "PAL") is
            // meaningless to a user AND defeats the PVC/TREE icon test in gis-toggles.
            type: (p) => GA_ATTRACTOR_CODES[p.attractor_code]
              || (p.attractor_code_other || "").trim()
              || p.attractor_code
              || "Unknown",
            metaMode: "type",
          },
          NC: {
            url: "https://services1.arcgis.com/YfqBAUM5nWR3yhGP/arcgis/rest/services/Fish_Attractors_public_view/FeatureServer/0/query",
            filter: (p) => true,
            name: (p) => `${p.Waterbody} Attractor`,
            wb: (p) => p.Waterbody,
            lat: (p) => p.Latitude,
            lon: (p) => p.Longitude,
            type: (p) => `${p.Structure1 || ""} ${p.Structure2 || ""}`.trim() || p.Attractor_Type,
            metaMode: "type",
          },
          TN: {
            url: "https://services3.arcgis.com/PWXNAH2YKmZY7lBq/arcgis/rest/services/Fish_Attractor_Locations_view/FeatureServer/0/query",
            filter: (p) => true,
            name: (p) => p.Site_Name || (p.Embayment ? `${p.WaterBody} - ${p.Embayment}` : `${p.WaterBody} Attractor`),
            wb: (p) => p.WaterBody,
            lat: (p) => p.YLat,
            lon: (p) => p.XLong,
            type: (p) => [p.StructureTypes, p.Artificial, p.Natural_].filter(Boolean).join(", ") || "Unknown",
            metaMode: "type",
          }
        };
        return handleGisRoute({
          env,
          url,
          cachePrefix: "attractors",
          ttlDays: 7,
          sources: ATTRACTOR_SOURCES,
          buildResult: (state, source, waterbodies, count) => ({
            state,
            source: source.url,
            count,
            waterbodies,
          }),
        });
      }
      // The `/duke` route stood here and is gone, 2026-08-25. It had no caller in js/, and
      // fetchDukeDashboard() behind it had no other caller either -- unlike /duke-flow-arrivals,
      // whose function conditions.js imports directly. Its `?basin=` parameter was a lie: the
      // function ignored the argument and returned every Duke lake regardless. And its second
      // trigger, `url.searchParams.has("duke")`, answered ANY path carrying that parameter with
      // a raw dump instead of the route asked for. The normalised Duke reading reaches the app
      // through /conditions, which is where the client looks.
      // THE ON-WATER ALERT. One ArcGIS query, five-minute cache, no fan-out -- see handleHazards.
      if (path === "/hazards") {
        const r = await handleHazards(request, env, url);
        if (r) return r;
      }
      if (path === "/usgs") {
        const site = url.searchParams.get("site");
        const params = url.searchParams.get("params") || "00010,00065";
        if (!site) return new Response('{"error":"missing site"}', { headers: JSON_HEADERS, status: 400 });
        const r = await fetch(`https://waterservices.usgs.gov/nwis/iv/?sites=${site}&parameterCd=${params}&format=json&period=P2D`);
        const t = await r.text();
        return new Response(t, { headers: JSON_HEADERS, status: r.status });
      }
      // THE REGULATIONS DIGEST, WHICH THE CLIENT HAD NO PATH TO.
      //
      // fetchStateRegulations parses the official state digest PDFs and caches the result keyed
      // to the digest identity, so a digest swap busts its own cache. The research agents have
      // read it since 2026-08-03. The browser could not: js/data/species-intel.js gates
      // checkRegulations() on a table of SIX named waters, and on the other 448 it returned
      // "no specific regulation data available" - which neither of its two callers read.
      //
      // A STATEWIDE LIMIT APPLIES TO EVERY WATER IN THE STATE. That is the whole gain here: 454
      // waters get the general table instead of 6 getting a hand-typed one.
      //
      // `hasExceptions` says whether the lake-specific half found anything, so a caller can tell
      // "this lake has its own rule" from "the statewide rule applies", which are different
      // sentences to put in front of somebody about to keep a fish.
      if (path === "/regulations") {
        const st = (url.searchParams.get("state") || "").trim().toUpperCase();
        const lake = url.searchParams.get("lake") || "";
        if (!st) {
          return new Response(JSON.stringify({ error: "missing state" }), { headers: JSON_HEADERS, status: 400 });
        }
        try {
          const stateRegs = await fetchStateRegulations(st, env);
          const forLake = lake ? getLakeRegulations(stateRegs, lake) : null;

          // THE BOOKS, PARSED. Separate from the digest parse above and deliberately so: this
          // half is built offline by build_regulations_table.py, deterministically, and read
          // from R2. The LLM digest parse answers "what are the limits"; this answers "is it
          // shut", which the route could not do at all until now.
          //
          // ITS FAILURE MUST NOT TAKE THE DIGEST DOWN WITH IT. A missing R2 object is a
          // pipeline state, not a request error, so it is reported in `closures_error` and the
          // limits still travel.
          let bookRules = null, closures = [], booksError = null, bookSlug = null;
          let coastalClosures = [], coastalSource = null;
          let bookStatewide = [], bookStatewideSource = null, bookStatewideDamaged = 0;
          // ROWS THE BOOK HAS FOR THIS FISH AND THIS ROUTE WOULD NOT SERVE. A withheld row
          // is not a silence, and the difference decides whether anything else may answer.
          let bookWithheld = [];
          let areaScopedHeld = 0;
          try {
            const [table, index] = await Promise.all([
              regulationsTable(env), lakeIndex(env),
            ]);
            const row = lake ? resolveRegistryRow(index, lake) : null;
            bookSlug = row && row.slug ? row.slug : null;
            const entry = bookSlug ? (table.by_water || {})[bookSlug] : null;
            // THE BOOK'S OWN RULE FOR THIS WATER, PROJECTED THE WAY book_statewide IS.
            // `entry` is the build's shape. Passing the tree through and leaving the browser to
            // re-read `cells` is the mistake the statewide block below already names: a record
            // carrying only cells arrives and is dropped, which is exactly what happened -- the
            // book's 14-inch largemouth rule for Wateree crossed the wire on every request and
            // nothing could read it. Same fields, same names, so livePolicyFor can answer from a
            // by-water rule without parsing prose.
            bookRules = entry ? {
              state: entry.state || null,
              display_name: entry.display_name || null,
              rules: (entry.rules || []).map((r) => ({
                source: r.source || null, table: r.table || null, label: r.label || null,
                page: r.page == null ? null : r.page, address: r.address || null,
                address_is_a_reach: !!r.address_is_a_reach,
                species: r.species || null,
                plan_species: Array.isArray(r.plan_species) ? r.plan_species : [],
                species_basis: r.species_basis || null,
                size_limit: r.size_limit || null, creel_limit: r.creel_limit || null,
                matched_via: r.matched_via || null,
                cells: Array.isArray(r.cells) ? r.cells : [],
                text_cut_by_the_grid: Array.isArray(r.text_cut_by_the_grid)
                  ? r.text_cut_by_the_grid : undefined,
              })),
            } : null;
            // Flattened so a caller never walks a tree to answer one question. Each record
            // keeps its species and the sentence it came from -- the sentence is what a person
            // can check, and it is the only thing that survives a disagreement.
            const walk = (recs) => {
              for (const r of (recs || [])) {
                for (const c of (r.closures || [])) {
                  // AN ARM IS NOT A LAKE, AND WE ARE NOT CARRYING ARMS. Ryan, 2026-08-29:
                  // "forget about the partial closures... i dont even want them in the app".
                  // Two records reach this branch, both on the Santee lakes, and the mechanism
                  // that made them expressible -- naming the ramps inside the closed area --
                  // cannot work for an area whose only access is not public, which is what
                  // Potato Creek turned out to be. Read at build time and counted in the report
                  // so nothing goes quiet; not served, so nothing gates a trip on a piece of
                  // water this app does not route anybody to.
                  if (c.applies_to === 'area') { areaScopedHeld += 1; continue; }
                  closures.push({
                    effect: c.effect, applies_to: c.applies_to,
                    start: c.start || null, end: c.end || null,
                    species: c.species || null, species_known: !!c.species_known,
                    // Resolved at BUILD time from registry/species_map.json, so neither this
                    // route nor the browser does the judgement. `Striped or Hybrid Bass or a
                    // combination` arrives already knowing it governs two checkboxes.
                    plan_species: Array.isArray(c.plan_species) ? c.plan_species : [],
                    species_basis: c.species_basis || null,
                    also_covers: Array.isArray(c.also_covers) ? c.also_covers : undefined,
                    text: c.text, source: r.source || null,
                  });
                }
                walk(r.rules);
              }
            };
            walk(entry && entry.rules);

            // THE COAST HAS NO WATER TO RESOLVE, so a coastal closure can never arrive through
            // by_water. A saltwater rule is set per STATE -- the same reason `saltwater` limits
            // below are filed by state -- and before this it arrived nowhere at all:
            // checkCoastalRegulations() had a hand-written table of fifteen species and no
            // book behind it. GA's OPEN SEASON column is the first real source; SC's and NC's
            // saltwater pages are not in the offline specs yet, so those two states still get
            // an empty list and MUST NOT read it as permission -- `coastal_source` is what
            // tells "read, nothing to say" from "never read".
            //
            // THE BOOK'S OWN STATEWIDE LIMITS, which until now were built and never served.
            //
            // `general` above is the digest parsed by an LLM at request time; this is the same
            // book parsed offline, deterministically, and it carries the sentence it came from
            // and the plan checkboxes it governs, both resolved at build time. Ryan's framing
            // of why it matters: "most lakes do not have a specific limit... unless you are
            // extracting the general regulation for each species and assigning that to each
            // lake". This is that extraction, reaching a caller for the first time.
            //
            // It does NOT replace `general`. The two are separate answers from the same book
            // and a disagreement between them is worth seeing, not hiding -- so both travel and
            // neither is silently preferred.
            for (const r of ((table.statewide || {})[st] || [])) {
              if (r.scope !== 'statewide coastal') {
                bookStatewideSource = r.source || bookStatewideSource;
                // A ROW THE GRID CUT THROUGH IS NOT A LIMIT. NC's statewide largemouth rule
                // reads `14-inch minimum, except 2 may be less than 14 inches` and the ruled
                // reader returns `14-inch minimum, e` / `xcept 2 may be`. The build marks those
                // rows by checking every word against the page's own text, and they are counted
                // here rather than served: a mangled limit in front of somebody about to keep a
                // fish is worse than no limit, because it looks like an answer. The count
                // travels so this reads as a known gap and not as a book that says nothing.
                if (Array.isArray(r.text_cut_by_the_grid) && r.text_cut_by_the_grid.length) {
                  bookStatewideDamaged += 1;
                  bookWithheld.push({
                    species: r.species || null,
                    plan_species: Array.isArray(r.plan_species) ? r.plan_species : [],
                    why: 'the grid cut the text', source: r.source || null });
                  continue;
                }
                // A DEFAULT THAT COVERS ONE KIND OF WATER MUST NOT ANSWER FOR THE OTHERS.
                // NC's statewide striped bass rule is written for `Impounded inland waters and
                // their tributaries`, and NC sets its rivers and sounds separately by
                // management area. We offer 17 rivers and 3 coastal waters in that state; served
                // without this filter every one of them would be handed an impoundment's 20-inch
                // minimum that the book gives them nowhere. Where the water did not resolve
                // there is no feature type to test, so a scoped record is withheld rather than
                // guessed at -- the same direction every other unknown here is resolved in.
                if (Array.isArray(r.applies_to_feature_types) && r.applies_to_feature_types.length) {
                  const ft = row && row.feature_type ? String(row.feature_type) : null;
                  if (!ft || !r.applies_to_feature_types.includes(ft)) {
                    bookWithheld.push({
                      species: r.species || null,
                      plan_species: Array.isArray(r.plan_species) ? r.plan_species : [],
                      why: ft ? `the book writes this for ${r.applies_to_feature_types.join(', ')} `
                              + `and this water is a ${ft}`
                              : 'the water did not resolve, so its type is unknown',
                      applies_to_feature_types: r.applies_to_feature_types,
                      source: r.source || null });
                    continue;
                  }
                }
                bookStatewide.push({
                  species: r.species || null,
                  // Carried so a card can say WHY this default applies here -- `impounded
                  // inland waters` is a narrower sentence than `statewide` and reads as one.
                  applies_to_feature_types: Array.isArray(r.applies_to_feature_types)
                    ? r.applies_to_feature_types : undefined,
                  // The two numbers a caller actually asks for, pulled out at build time by
                  // reading which column is which off the book's own header. livePolicyFor()
                  // reads sizeLimit and creelLimit and nothing else, so a record carrying only
                  // `cells` would arrive and be dropped.
                  size_limit: r.size_limit || null,
                  creel_limit: r.creel_limit || null,
                  // Resolved at BUILD time from registry/species_map.json. An empty array here
                  // means the book named a fish the plan form has no checkbox for -- NOT that
                  // the lookup failed; `species_basis` is what says which.
                  plan_species: Array.isArray(r.plan_species) ? r.plan_species : [],
                  species_basis: r.species_basis || null,
                  also_covers: Array.isArray(r.also_covers) ? r.also_covers : undefined,
                  // The sentence is what a person can check, and the only thing that survives
                  // a disagreement with the digest parse.
                  cells: Array.isArray(r.cells) ? r.cells : [],
                  address: r.address || null,
                  source: r.source || null, page: r.page || null,
                });
                continue;
              }
              coastalSource = r.source || coastalSource;
              for (const c of (r.closures || [])) {
                coastalClosures.push({
                  effect: c.effect, applies_to: c.applies_to,
                  start: c.start || null, end: c.end || null,
                  species: c.species || null, species_known: !!c.species_known,
                  plan_species: Array.isArray(c.plan_species) ? c.plan_species : [],
                  species_basis: c.species_basis || null,
                  text: c.text, note: c.note || null, source: r.source || null,
                });
              }
            }
          } catch (err) {
            booksError = String((err && err.message) || err);
          }
          return new Response(JSON.stringify({
            state: st,
            lake: lake || null,
            // `failed` travels. A parse that broke and a state that publishes no lake-specific
            // rules both look like an empty object, and only one of them is a bug.
            parse_failed: !!stateRegs.failed,
            parse_error: stateRegs.error || null,
            general: stateRegs.general || {},
            lake_specific: forLake ? forLake.lakeSpecificRegulations : null,
            has_exceptions: forLake ? forLake.hasExceptions : null,
            // THE SAME DIGEST, THE SALTWATER HALF. fetchStateRegulations() parses pages 21-29 of
            // the book it already downloaded for the freshwater half. Statewide only -- there is
            // no saltwater equivalent of "Lake Wateree striped bass", so there is no
            // saltwater_lake_specific to return.
            //
            // ABSENT AND EMPTY ARE DIFFERENT ANSWERS and both are honest ones. `{}` means the
            // state has saltwater and the parse produced no rows; a state with no coast returns
            // `{}` too and `saltwater_source` stays null, which is what tells them apart. A
            // caller must not read either as permission.
            saltwater: stateRegs.saltwater || {},
            saltwater_source: stateRegs.saltwaterSource || null,

            // Parsed offline from the same book as `closures`, and filed by STATE because that
            // is how a saltwater rule is set. `coastal_source` null means no state's coastal
            // pages have been parsed into the offline table yet -- not that the coast is open.
            coastal_closures: coastalClosures,
            coastal_source: coastalSource,

            // ABSENT AND EMPTY ARE DIFFERENT ANSWERS, the same discipline `saltwater_source`
            // keeps: a null source means no book has been parsed into the offline table for
            // this state, which is not the same as a state whose book sets no statewide limit.
            // A caller must not read either as permission.
            book_statewide: bookStatewide,
            book_statewide_source: bookStatewideSource,
            // Rows the book prints and this pipeline could not read cleanly. Not served, but
            // said out loud -- `book_statewide: []` with a non-zero count here means the book
            // was read and the reading is not trustworthy yet, which is a third answer from
            // both "no rule" and "never read".
            book_statewide_damaged: bookStatewideDamaged,

            // ROWS THE BOOK HAS FOR THIS WATER THAT THIS ROUTE WOULD NOT SERVE, and why.
            // A SILENCE AND A REFUSAL ARE DIFFERENT ANSWERS. `general` is an LLM reading of the
            // same book, and where it disagrees with a deliberate withholding it is not adding
            // coverage -- it is undoing a guard. NC's statewide striped bass rule is written for
            // `Impounded inland waters and their tributaries`; withheld from a river above, the
            // digest then answered the river with the impoundment's 20-inch minimum anyway.
            // Naming what was withheld is what lets livePolicyFor refuse to backfill it.
            book_withheld: bookWithheld,

            // Area-scoped closures read and not served -- see the walk() above.
            closures_area_scoped_held: areaScopedHeld,

            // THE CLOSURES. `book_slug` is null when the name did not resolve to a registry
            // water, which is a DIFFERENT answer from a water with no closures and has to stay
            // tellable apart -- resolveRegistryRow refuses an ambiguous name rather than
            // guessing, and a refusal must not read as "open".
            book_slug: bookSlug,
            book_rules: bookRules,
            closures,
            closures_error: booksError,

            note: "This route answers from the same book twice. `general` and `saltwater` are "
                + "the state digest parsed by an LLM at request time. `book_statewide`, "
                + "`book_rules`, `closures` and `coastal_closures` are that book parsed "
                + "offline by build_regulations_table.py with no LLM in the path, each record "
                + "carrying the sentence it came from and the plan checkboxes it governs. "
                + "Where the two disagree the sentence is the thing to check. `closures` is "
                + "empty both when a water has none and when the name did not resolve; "
                + "`book_slug` is what tells those apart, and a null `book_statewide_source` "
                + "means no book was read for this state rather than a state that sets no "
                + "limit. `book_statewide_damaged` counts rows the book prints that the ruled "
                + "reader sliced through mid-word; they are withheld rather than served, so a "
                + "non-zero count is a known gap and not an open season. Verify before you "
                + "keep one.",
          }, null, 2), { headers: { ...JSON_HEADERS, "Cache-Control": "public, max-age=3600" } });
        } catch (err) {
          return new Response(JSON.stringify({ error: String(err && err.message || err), state: st }),
            { headers: JSON_HEADERS, status: 502 });
        }
      }
      if (path === "/lake-clarity") {
        const name = url.searchParams.get("lake") || url.searchParams.get("waterbody") || "";
        const dateParam = url.searchParams.get("date") || (new Date()).toISOString().slice(0, 10);
        if (!name) return new Response(JSON.stringify({ error: "missing lake" }), { headers: JSON_HEADERS, status: 400 });
        const data = await getLakeClarity(name, dateParam, env);
        return new Response(JSON.stringify(data, null, 2), { headers: JSON_HEADERS });
      }
      if (path === "/lake-intel-sources") {
        const name = url.searchParams.get("lake") || "";
        if (name) {
          const key = lakeKeyFromName(name);
          return new Response(JSON.stringify({ key, registry: getLakeIntelSourceRegistry(key) }, null, 2), { headers: JSON_HEADERS });
        }
        return new Response(JSON.stringify(LAKE_INTEL_SOURCE_REGISTRY, null, 2), { headers: JSON_HEADERS });
      }
      if (path === "/lake-intel") {
        const name = url.searchParams.get("lake") || url.searchParams.get("waterbody") || "";
        if (!name) return new Response(JSON.stringify({ error: "missing lake" }), { headers: JSON_HEADERS, status: 400 });
        // Enhanced with researched profile if exists
        try {
          const enhanced = await handleEnhancedLakeIntel(name, env);
          return new Response(JSON.stringify(enhanced, null, 2), { headers: JSON_HEADERS });
        } catch (err) {
          // Falling back to base intel is correct -- some intel beats a 500. But the two
          // responses have the same shape, so a permanently broken enhanced path degrades
          // every lake to the unresearched answer and nothing anywhere says so. This is the
          // most consequential silent catch in the Worker: it hides the researched profile,
          // which is the thing the whole research pipeline exists to produce.
          console.error(`[lake-intel] enhanced path failed for ${name}, serving base intel:`, err && err.message);
          const intel = await getLakeIntel(name);
          return new Response(JSON.stringify(intel, null, 2), { headers: JSON_HEADERS });
        }
      }
      // THE SPECIES A WATER HAS, WITHOUT A RESEARCH PROFILE AND WITHOUT AN LLM.
      //
      // Ryan, 2026-09-04: "now wire up the fish species to the other states for the refactor".
      // South Carolina and Georgia publish species on their ramp feeds and the browser already
      // has those -- see Worker/core/ramp-sources.js. North Carolina and Tennessee publish none
      // there; their fish are in registry/nc_species_by_lake.json and
      // registry/agency_lake_facts.json, and until now only the research pipeline read either.
      //
      // Four R2 reads behind cached loaders, no ArcGIS and no model, so a plan can ask on every
      // run. It deliberately does NOT call the deterministic-facts handler, which also fetches
      // Duke's operating range for identityGrounding() -- a plan must not wait on Duke to learn
      // what fish are in the lake.
      if (path === "/species") {
        const name = url.searchParams.get("lake") || url.searchParams.get("waterbody") || "";
        if (!name) return new Response(JSON.stringify({ error: "missing lake" }), { headers: JSON_HEADERS, status: 400 });
        const state = (url.searchParams.get("state") || "").toUpperCase();
        // `?species=` is optional and answers a DIFFERENT question from the rest of this route:
        // what that fish eats, statewide, out of the state's own guide. Asked here rather than
        // from its own route because the plan already makes this call and the answer travels
        // with the water's forage, which is the half it is meant to be read against.
        const target = url.searchParams.get("species") || "";
        try {
          const [reg, food] = await Promise.all([
            registrySpeciesFor(env, name, state),
            target ? speciesFoodHabits(env, target) : Promise.resolve(null),
          ]);
          return new Response(JSON.stringify({
            lake: name,
            slug: reg.slug,
            predatorSpecies: reg.predatorSpecies,
            knownStockings: reg.knownStockings,
            // What the agency says those fish EAT, off the same page and quoted from it.
            // See forageFromAgencyPages().
            primaryForage: reg.primaryForage,
            // Statewide and per-species; `statewide: true` says so, because a sentence about what
            // stripers eat in South Carolina is not a sentence about this reservoir.
            foodHabits: food,
            // Which of these say what is IN the water and which say only that a rule or an
            // advisory names a fish. A roster and a floor are different claims and the caller
            // has to be able to tell them apart -- see registrySpeciesFor().
            sources: reg.sources,
          }, null, 2), { headers: JSON_HEADERS });
        } catch (err) {
          console.error(`[species] failed for ${name}:`, err && err.message);
          return new Response(JSON.stringify({ error: String(err && err.message || err) }), { headers: JSON_HEADERS, status: 500 });
        }
      }
      if (path === "/river" || url.searchParams.has("river")) {
        const r = (url.searchParams.get("river") || "").toLowerCase();
        if (!r) {
          return new Response(JSON.stringify({
            error: "missing river",
            available: Object.keys(RIVERS)
          }), { headers: JSON_HEADERS, status: 400 });
        }
        const key = Object.keys(RIVERS).find((k) => r.includes(k) || k.includes(r));
        if (!key) {
          return new Response(JSON.stringify({
            error: `unknown river: ${r}`,
            available: Object.keys(RIVERS)
          }), { headers: JSON_HEADERS, status: 404 });
        }
        const userLat = parseFloat(url.searchParams.get("lat"));
        const userLon = parseFloat(url.searchParams.get("lon"));
        const opts = isFinite(userLat) && isFinite(userLon) ? { userLat, userLon } : {};
        const data = await getRiver(key, opts);
        return new Response(JSON.stringify(data, null, 2), { headers: JSON_HEADERS });
      }
      if (path === "/duke-flow-arrivals") {
        const basin = url.searchParams.get("basin") || "1";
        const sched = await fetchDukeFlowArrivals(basin);
        if (!sched) return new Response(JSON.stringify({ error: "Duke flow-arrivals unavailable", basin }), { headers: JSON_HEADERS, status: 502 });
        return new Response(JSON.stringify(sched, null, 2), { headers: JSON_HEADERS });
      }
      if (path === "/dominion-saluda") {
        const status = await fetchDominionSaludaStatus();
        if (!status) return new Response(JSON.stringify({ error: "Dominion Saluda page unavailable" }), { headers: JSON_HEADERS, status: 502 });
        return new Response(JSON.stringify(status, null, 2), { headers: JSON_HEADERS });
      }
      if (path === "/rivers") {
        const list = Object.entries(RIVERS).map(([k, v]) => ({
          key: k,
          label: v.label,
          operator: v.operator,
          dam: v.damName,
          primaryGauge: (v.gauges.find((g) => g.primary) || v.gauges[0]).site
        }));
        return new Response(JSON.stringify(list, null, 2), { headers: JSON_HEADERS });
      }
      if (path.startsWith("/sync")) {
        if (!env.DB) return new Response(JSON.stringify({ error: "D1 not configured" }), { headers: JSON_HEADERS, status: 503 });
        if (!await isAuthorized(request, env)) {
          return new Response(JSON.stringify({ error: "unauthorized" }), { headers: JSON_HEADERS, status: 401 });
        }
        try {
          if (path === "/sync/migrate" && request.method === "POST") {
            return await handleSyncMigrate(request, env);
          }
          const purgeMatch = path.match(/^\/sync\/purge-type\/([^\/]+)$/);
          if (purgeMatch && request.method === "DELETE") {
            const pType = purgeMatch[1];
            await ensureSyncSchema(env.DB);
            await env.DB.prepare("DELETE FROM sync_items WHERE type = ?1").bind(pType).run();
            return new Response(JSON.stringify({ ok: true, purged: pType }), { headers: JSON_HEADERS });
          }
          if (path === "/sync/list-updates" && request.method === "GET") {
            return await handleSyncListUpdates(url, env);
          }
          const itemMatch = path.match(/^\/sync\/item\/([^\/]+)\/(.+)$/);
          if (itemMatch) {
            const [, type, id] = itemMatch;
            if (request.method === "POST") return await handleSyncPush(request, env, type, id);
            if (request.method === "GET") return await handleSyncGet(env, type, id);
            if (request.method === "DELETE") return await handleSyncDelete(env, type, id);
          }
          const keyMatch = path.match(/^\/sync\/item\/(.+)$/);
          if (keyMatch && request.method === "GET") {
            const parts = keyMatch[1].split("/");
            const type = parts[0];
            const id = parts.slice(1).join("/");
            return await handleSyncGet(env, type, id);
          }
          return new Response(JSON.stringify({ error: "unknown sync route" }), { headers: JSON_HEADERS, status: 404 });
        } catch (syncErr) {
          return new Response(JSON.stringify({ error: `sync error: ${syncErr.message}` }), { headers: JSON_HEADERS, status: 500 });
        }
      }
      const contourMatch = path.match(/^\/contours\/([^\/]+)\/geojson$/);
      if (contourMatch) {
        const lakeArg = contourMatch[1];
        if (request.method === "GET") return handleContourGeojsonGet(env, lakeArg);
        if (request.method === "POST" || request.method === "PUT") {
          if (!await isAuthorized(request, env)) {
            return new Response(JSON.stringify({ error: "unauthorized" }), { headers: JSON_HEADERS, status: 401 });
          }
          return handleContourGeojsonPut(request, env, lakeArg);
        }
      }
      // Compute plane over the pack layers, and the conditions envelope. Both return
      // null when the path is not theirs, so neither can shadow an existing route.
      const waterRes = await handleWaterRoute(request, env, url);
      if (waterRes) return waterRes;
      const condRes = await handleConditions(request, env, url);
      if (condRes) return condRes;
      // Same contract again: null when the path is not ours. The camera roster is baked
      // into js/data/cameras.js at build time -- this serves only the CURRENT FRAME.
      const camRes = await handleCameras(request, env, url);
      if (camRes) return camRes;
      // PUSH ALERTS. Same null-when-not-ours contract. This is the only route family whose
      // point is to work while the app is CLOSED -- Ryan's phone rides in a PFD pocket with the
      // screen off, which is exactly the state that freezes the in-page hazard poll.
      const alertRes = await handleAlerts(request, env, url);
      if (alertRes) return alertRes;
      // Recent fishing reports for one water. Same null-when-not-ours contract. Nothing here
      // goes to an LLM -- Ryan, 2026-08-15: "this doesn't need to go to the llm for anything
      // maybe just to me in the trip html report".
      const repRes = await handleReports(request, env, url);
      if (repRes) return repRes;

      if (path === "/chartpacks/lake-boundary" && request.method === "GET") {
        const lakeName = url.searchParams.get("lake") || "";
        if (!lakeName) return new Response(JSON.stringify({ error: "missing lake param" }), { status: 400, headers: JSON_HEADERS });
        const safeId = sanitizeLakeId(lakeName);
        const shortKey = lakeKeyFromName(lakeName);
        // New clean structure: {slug}/boundary.geojson
        // Fallback to old boundaries/ prefix for any files not yet migrated
        const candidates = [
          `${safeId}/boundary.geojson`,
          `${shortKey}/boundary.geojson`,
          `lake_${shortKey}/boundary.geojson`,
        ];
        let geoObj = null;
        for (const key of candidates) {
          geoObj = await env.R2_TROLLMAP_CHARTPACKS.get(key).catch(() => null);
          if (geoObj) break;
        }
        if (!geoObj) return new Response(JSON.stringify({ error: "no boundary data found", lake: lakeName, tried: candidates }), { status: 404, headers: JSON_HEADERS });
        const geoText = await r2Text(geoObj);
        return new Response(geoText, { headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" } });
      }

      if (path === "/chartpacks/list") {
        // ?detail=1 adds a size and the stored encoding per object. Scripts/r2_audit.py needs
        // both: one to say what a deletion frees, the other to verify a gzip re-upload landed.
        const data = await handleChartpackList(env, { detail: url.searchParams.has("detail") });
        return new Response(JSON.stringify(data, null, 2), { headers: JSON_HEADERS });
      }
      if (path === "/debug/regs-cache") {
        return handleResearchRegsDebug(request, env);
      }
      const idxMatch = path.match(/^\/chartpacks\/([^/]+)\/index\.json$/);
      if (idxMatch) {
        const lakeName = idxMatch[1];
        const prefix = chartpackKey(lakeName, "");
        const listed = await env.R2_TROLLMAP_CHARTPACKS.list({ prefix });
        const tiles = new Set();
        let totalBytes = 0;
        for (const obj of listed.objects) {
          const fname = obj.key.slice(prefix.length);
          totalBytes += obj.size || 0;
          const m = fname.match(/(?:^|\/)iboating_R(\d{3})_C(\d{3})_contours\.georef\.json$/i);
          if (m) tiles.add(`iboating_R${m[1]}_C${m[2]}`);
        }
        return new Response(JSON.stringify({
          lake: lakeName,
          tiles: [...tiles].sort(),
          total_bytes: totalBytes
        }), { headers: { ...CORS, ...JSON_HEADERS, "Cache-Control": "no-store" } });
      }
      const cpMatch = path.match(/^\/chartpacks\/([^/]+)\/(.+)$/);
      if (cpMatch) {
        const [, lakeName, file] = cpMatch;
        const key = chartpackKey(lakeName, file);
        if (request.method === "GET") {
          // Packs are immutable between uploads, yet this served `no-store`, so Wateree's
          // 9.7 MB of contours and 18.6 MB of depth areas came down again on EVERY load --
          // no edge cache, no browser cache -- with trolling_runs and water_features now on
          // top. ETag plus a short max-age: inside five minutes the browser does not ask, and
          // after that it revalidates and gets a bodyless 304 unless the pack was rebuilt.
          // Five minutes rather than a day because packs are rebuilt daily right now, and a
          // stale contour set after a build is worse than a re-fetch.
          const inm = request.headers.get("If-None-Match");
          const want = inm ? inm.replace(/^W\//, "").replace(/"/g, "").trim() : null;
          const obj = await env.R2_TROLLMAP_CHARTPACKS.get(
            key, want ? { onlyIf: { etagDoesNotMatch: want } } : undefined);
          if (!obj) return new Response('{"error":"not found"}', { headers: JSON_HEADERS, status: 404 });
          // R2 returns an R2Object with NO body when onlyIf fails -- the etag matched and the
          // client's copy is current. That is the 304, and it is the whole saving.
          if (!obj.body) {
            const h304 = new Headers(CORS);
            h304.set("ETag", obj.httpEtag);
            h304.set("Cache-Control", "public, max-age=300, must-revalidate");
            return new Response(null, { status: 304, headers: h304 });
          }
          let ct = "application/octet-stream";
          if (file.endsWith(".png")) ct = "image/png";
          else if (file.endsWith(".json") || file.endsWith(".geojson")) ct = "application/json";
          // The pipeline uploads gzipped (depth_areas 24.2 MB -> 3.4 MB in R2). r2Body strips
          // that layer here rather than echoing Content-Encoding, because the edge compresses
          // the Worker's output again and the browser only unwraps once -- see the long note
          // on r2Body in worker-core.js. writeHttpMetadata still runs first so anything else
          // stored on the object survives; r2Body removes only what it invalidates.
          const headers = new Headers(CORS);
          obj.writeHttpMetadata(headers);
          const body = r2Body(obj, headers);
          headers.set("Content-Type", ct);
          // After writeHttpMetadata, which copies stored metadata over these two.
          headers.set("Cache-Control", "public, max-age=300, must-revalidate");
          headers.set("ETag", obj.httpEtag);
          return new Response(body, { headers });
        }
        if (request.method === "POST") {
          if (!await isAuthorized(request, env)) {
            return new Response('{"error":"unauthorized"}', { headers: JSON_HEADERS, status: 401 });
          }
          const buf = await request.arrayBuffer();
          if (!buf || buf.byteLength === 0) {
            return new Response('{"error":"empty body"}', { headers: JSON_HEADERS, status: 400 });
          }
          await env.R2_TROLLMAP_CHARTPACKS.put(key, buf, {
            httpMetadata: {
              contentType: file.endsWith(".png") ? "image/png"
                         : file.endsWith(".bin") ? "application/octet-stream"
                         : "application/json",
              cacheControl: "public, max-age=3600"
            }
          });
          return new Response(JSON.stringify({ uploaded: key, bytes: buf.byteLength }), { headers: JSON_HEADERS });
        }
        return new Response('{"error":"method not allowed"}', { headers: JSON_HEADERS, status: 405 });
      }
      return new Response(JSON.stringify({
        ok: true,
        worker: "trollmap-worker",
        version: 15.6,
        changelog: "2026-07-13 v15.6: Fix eRegulations → regulations JSON pipeline. Root cause: Firecrawl flattens multi-row markdown tables into one line with empty-cell separators; extractMarkdownTableRows misaligned columns so parseSCRegulationsFromHtml returned empty creel/size maps (UI showed empty regs). Fixed table parser (split on | |), expanded species matching (striper Santee-system rows for Wateree, lake regs page 14\" LMB), live Firecrawl fallback when normalized docs missing, multi-key R2 lookup for normalized_documents.json. EPA NSCEP/NEPIS two-step Firecrawl workflow (search results → ZyActionD landing → raw_text_url markdown). Dataset-hunt + discovery seeds include lake regs.html + eRegulations. UI regulations viewer now renders size+creel grids, closed seasons, special rules. Previous v15.5: SCDNR fishregs 404 → eRegulations migration.",
        evidencePipeline: {
          version: "v4",
          fixes: [
            "alias dedupe: Lake Wateree, SC no longer becomes Lake Lake Wateree",
            "discovery filter: drops Lake Murray/Marion regs when searching Wateree",
            "skip generic pocket guide 50MB PDF",
            "scoring now composite auth/relevance/freshness/completeness, not all 98",
            "extraction uses lake-relevant 20k char chunks, not blind 100k slices, total 120k cap",
            "Gemini prompt now asks for riverSystem/archetype/surfaceArea/etc + general vs lake-specific creel/size + fallback to general regs if 0 lake facts",
            "dedupe by fact text similarity not category, contradiction detection numeric+species conflict",
            "master profile status forced draft if <3 facts or 0 facts, prevents false verified 98%",
            "client defensive: non-JSON detection for worker 404, large PDF skip, off-lake penalize"
          ],
          lastBugLog: "Wateree run 2026-07-12 22:14 — 10 docs but 0 facts + verified 98% -> now draft + filter"
        },
        routes: [
          "/research/list or /lakes/list      \u2014 list all researched lake master profiles",
          "/research/get?lake=...             \u2014 get master profile + package file list + versions",
          "/research/save                     \u2014 save merged profile (master + hybrid package + version)",
          "/research/approve                  \u2014 mark profile verified",
          "/research/package?lake=...         \u2014 list package files for lake",
          "/research/package?lake=...&file=... \u2014 get single package file",
          "/lake-research?lake=...            \u2014 enhanced lake intel with researched profile if exists",
          "/lakes/<id>                        \u2014 shortcut get master profile",
          "/sync/item/:type/:id               \u2014 push/get/delete a sync item (auth required)",
          "/sync/list-updates?since=<ts>      \u2014 delta list for cross-device sync (auth required)",
          "/sync/migrate                      \u2014 bulk import all local data (auth required)",
          "/contours/:lake/geojson            \u2014 serve/upload vectorized contour GeoJSON",
          "/lake?lake=wateree                     \u2014 unified lake JSON",
          "/lake-clarity?lake=wateree&date=YYYY-MM-DD \u2014 runoff clarity/ramp/lure forecast",
          "/lake-intel-sources?lake=wateree       \u2014 trust-tier source registry",
          "/lake-intel?lake=murray|marion|wateree    \u2014 fisherman lake profile + latest report scrape + researched if exists",
          "/river?river=wateree|congaree|saluda|broad|santee|cooper",
          "/rivers                                \u2014 list all rivers",
          "/duke-flow-arrivals?basin=1|2|3|6|10|11 \u2014 raw Duke scheduled dam releases",
          "/dominion-saluda                       \u2014 raw Dominion color-coded status",
          "/usgs?site=...&params=...              \u2014 raw USGS pass-through",
          "/chartpacks/list                       \u2014 list all uploaded chartpack lakes",
          "/chartpacks/<lake>/<file>             \u2014 serve or upload chartpack file"
        ]
      }, null, 2), { headers: JSON_HEADERS });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { headers: JSON_HEADERS, status: 500 });
    }
  }
};
export {
  trollmap_worker_default as default
};
