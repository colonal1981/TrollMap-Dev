import { CORS, JSON_HEADERS, TEXT_HEADERS, callLLM, isAuthorized } from './worker-core.js'; 
import { LAKES, LAKE_INTEL, LAKE_INTEL_SOURCE_REGISTRY, LAKEMONSTER_IDS, LAKE_CLARITY_PROFILES, RIVERS, lakeKeyFromName, fetchText, fetchUsgs, fetchAhqWaterTemp, fetchAhqFishingReport, fetchLakeMonsterIntel, getLakeIntel, getLakeClarity, getLakeIntelSourceRegistry, getDukeLake, fetchSanteeCooper, fetchUsaceSavannah, fetchCwmsLakeLevel, fetchDukeDashboard } from './worker-data.js';
import { SPECIES_MIDLANDS_SANTEE, SPECIES_UPSTATE, SPECIES_COASTAL_SALTWATER, SPECIES_ALL_TROLLMAP, MAX_BIOLOGICAL_LENGTH, PURE_SALTWATER, PURE_FRESHWATER, getSpeciesListForGps, checkBiologicalLength, checkEcologicalReality } from './worker-species.js';
import { handleResearchThermoclineSearch, handleResearchLimnologyData, handleResearchDiscover, handleResearchProxyDownload, handleResearchProxyDownloadBatch, handleResearchDatasetHunt, handleResearchDeterministicFacts, handleResearchSaveNormalized, handleResearchGetNormalized, handleResearchAnalyzeFacts, handleResearchDedupeContradictions, handleResearchMapFacts, handleResearchGapAnalysis, handleResearchGapSearch, handleResearchAgent, handleResearchAgentPipeline, handleResearchList, handleResearchGet, handleResearchSave, handleResearchApprove, handleResearchDelete, handleResearchDeleteNormalizedDoc, handleResearchPackage, handleResearchPackageFile, handleEnhancedLakeIntel, RESEARCH_AGENTS, GAP_QUERIES, sanitizeLakeId, lakeResearchMasterKey, lakePackageKey, handleResearchValidationPass, handleSharedCheck, handleSharedStore, handleSharedQuery, handleSharedPublish, handleSharedStatus, handleSharedQuarantine } from './worker-research.js';

var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

function chartpackKey(lake, filename) {
  const safeLake = String(lake).toLowerCase().replace(/[^a-z0-9_\-]/g, "_");
  const safeFile = String(filename).replace(/[^a-z0-9_.\-\/]/gi, "_");
  return `${safeLake}/${safeFile}`;
}
__name(chartpackKey, "chartpackKey");
async function handleChartpackList(env) {
  const out = [];
  let cursor;
  do {
    const listed = await env.R2_TROLLMAP_CHARTPACKS.list({ cursor });
    for (const obj of listed.objects) {
      const slash = obj.key.indexOf("/");
      if (slash < 0) continue;
      const lake = obj.key.slice(0, slash);
      const file = obj.key.slice(slash + 1);
      let entry = out.find((e) => e.name === lake);
      if (!entry) {
        entry = { name: lake, files: [], bytes: 0 };
        out.push(entry);
      }
      entry.files.push(file);
      entry.bytes += obj.size || 0;
    }
    cursor = listed.truncated ? listed.cursor : null;
  } while (cursor);
  for (const e of out) e.files.sort();
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { chartpacks: out, count: out.length };
}
__name(handleChartpackList, "handleChartpackList");
function assessKayakSafety(riverKey, gaugeData, thresholds) {
  const t = thresholds;
  const reasons = [];
  const metrics = {};
  let level = "go";
  const escalate = /* @__PURE__ */ __name((newLevel) => {
    const order = { "go": 0, "caution": 1, "no-go": 2 };
    if (order[newLevel] > order[level]) level = newLevel;
  }, "escalate");
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
__name(assessKayakSafety, "assessKayakSafety");
function snapToRiver(centerline, userLat, userLon) {
  let best = null;
  for (const wp of centerline) {
    const d = Math.hypot((wp.lat - userLat) * 69, (wp.lon - userLon) * 55);
    if (!best || d < best.dist) best = { dist: d, wp };
  }
  return best;
}
__name(snapToRiver, "snapToRiver");
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
__name(interpolateSeverity, "interpolateSeverity");
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
__name(estimateSurgeAt, "estimateSurgeAt");
async function getRiver(key, opts = {}) {
  const cfg = RIVERS[key];
  if (!cfg) return { error: `unknown river: ${key}` };
  const out = {
    river: cfg.label,
    operator: cfg.operator,
    dam: cfg.damName,
    notes: cfg.notes,
    gauges: [],
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
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
    } catch (_) {
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
__name(getRiver, "getRiver");
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
      const ts = (/* @__PURE__ */ new Date(`${date}T${time}:00`)).getTime();
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
__name(computeGageRateOfRise, "computeGageRateOfRise");
var DUKE_API_BASE = "https://api.hydro-derived.duke-energy.app";
async function fetchDukeFlowArrivals(basinId) {
  try {
    const r = await fetch(`${DUKE_API_BASE}/rivers/flow-arrivals/${basinId}`, {
      cf: { cacheTtl: 300, cacheEverything: true },
      headers: {
        "User-Agent": "TrollMap/12 Worker",
        "Origin": "https://lakes.hydro-derived.duke-energy.app",
        "Referer": "https://lakes.hydro-derived.duke-energy.app/"
      }
    });
    if (!r.ok) return null;
    const j = await r.json();
    const out = [];
    const now = Date.now();
    for (const dam of j?.Dams || []) {
      for (const ev of dam?.FlowArrivalRecessions || []) {
        const arr = ev.Arrival ? /* @__PURE__ */ new Date(ev.Arrival + (ev.Arrival.endsWith("Z") ? "" : "-04:00")) : null;
        const rec = ev.Recedes ? /* @__PURE__ */ new Date(ev.Recedes + (ev.Recedes.endsWith("Z") ? "" : "-04:00")) : null;
        if (!arr || arr.getTime() < now - 12 * 3600 * 1e3) continue;
        out.push({
          damName: ev.DamName,
          mileMarkerName: ev.MileMarkerName,
          arrival: ev.Arrival,
          recedes: ev.Recedes,
          arrivalEpoch: arr ? arr.getTime() : null,
          recedesEpoch: rec ? rec.getTime() : null
        });
      }
    }
    out.sort((a, b) => (a.arrivalEpoch || 0) - (b.arrivalEpoch || 0));
    return {
      basinName: j.RiverBasinName,
      basinId: j.RiverBasinId,
      lastUpdated: j.LastUpdated,
      arrivals: out,
      source: `${DUKE_API_BASE}/rivers/flow-arrivals/${basinId}`
    };
  } catch (e) {
    return null;
  }
}
__name(fetchDukeFlowArrivals, "fetchDukeFlowArrivals");
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
__name(fetchDominionSaludaStatus, "fetchDominionSaludaStatus");
async function resolveLake(lakeName) {
  const key = Object.keys(LAKES).find((k) => lakeName.toLowerCase().includes(k));
  if (!key) return { error: `unknown lake: ${lakeName}` };
  const cfg = LAKES[key];
  const out = {
    waterbody: key,
    elevation_ft: null,
    water_temperature_F: null,
    sources: [],
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
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
      if (lake.pct != null) out.percent_full = lake.pct;
      out.full_pool_ft = lake.fullPool;
      out.display_level = lake.pct;
      out.display_unit = "% full pond";
      out.display_full_pool = 100;
      if (isFinite(lake.target)) out.target = lake.target;
      out.sources.push("Duke API /lakes/current-level");
      if (lake.specialMessage) out.special_message = lake.specialMessage;
    }
  }
  if (out.elevation_ft == null && cfg.sepa) {
    if (cfg.sepa === "marion" || cfg.sepa === "moultrie") {
      const sc = await fetchSanteeCooper();
      if (sc?.[cfg.sepa] != null) {
        out.elevation_ft = sc[cfg.sepa];
        out.sources.push("Santee Cooper");
      }
    } else {
      // Try the USACE CWMS Data API first for authoritative near-real-time elevation.
      const cwms = await fetchCwmsLakeLevel(lakeName, key);
      if (cwms?.elevation_ft != null) {
        out.elevation_ft = round2(cwms.elevation_ft);
        out.sources.push(`USACE CWMS ${cwms.location || key}`);
        out.cwms = {
          location: cwms.location,
          source: cwms.source,
          timestamp: cwms.timestamp,
          method: cwms.method
        };
      }
      if (out.elevation_ft == null) {
        const us = await fetchUsaceSavannah(cfg.sepa);
        if (us?.elevation != null) {
          out.elevation_ft = us.elevation;
          out.sources.push("USACE Savannah District");
        }
      }
    }
  }
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
__name(resolveLake, "resolveLake");
function round2(n) {
  return Math.round(n * 100) / 100;
}
__name(round2, "round2");
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
__name(ensureSyncSchema, "ensureSyncSchema");
async function handleSyncPush(request, env, type, id) {
  if (!SYNC_STORES.includes(type)) {
    return new Response(JSON.stringify({ error: `unknown type: ${type}` }), { headers: JSON_HEADERS, status: 400 });
  }
  const body = await request.json();
  const { lastModified = (/* @__PURE__ */ new Date()).toISOString(), deleted = false, ...data } = body;
  await ensureSyncSchema(env.DB);
  await env.DB.prepare(
    `INSERT INTO sync_items (id, type, payload, lastModified, deleted)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(type, id) DO UPDATE SET
       payload=excluded.payload,
       lastModified=excluded.lastModified,
       deleted=excluded.deleted`
  ).bind(id, type, JSON.stringify(data), lastModified, deleted ? 1 : 0).run();
  return new Response(JSON.stringify({ ok: true, type, id, lastModified }), { headers: JSON_HEADERS });
}
__name(handleSyncPush, "handleSyncPush");
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
__name(handleSyncListUpdates, "handleSyncListUpdates");
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
__name(handleSyncGet, "handleSyncGet");
async function handleSyncDelete(env, type, id) {
  await ensureSyncSchema(env.DB);
  await env.DB.prepare(
    `INSERT INTO sync_items (id, type, payload, lastModified, deleted)
     VALUES (?1, ?2, '{}', ?3, 1)
     ON CONFLICT(type, id) DO UPDATE SET deleted=1, lastModified=excluded.lastModified`
  ).bind(id, type, (/* @__PURE__ */ new Date()).toISOString()).run();
  return new Response(JSON.stringify({ ok: true, tombstoned: `${type}/${id}` }), { headers: JSON_HEADERS });
}
__name(handleSyncDelete, "handleSyncDelete");
async function handleSyncMigrate(request, env) {
  await ensureSyncSchema(env.DB);
  const body = await request.json();
  const items = body.items || [];
  let count = 0;
  const errors = [];
  for (const item of items) {
    try {
      const { type, id, lastModified = (/* @__PURE__ */ new Date()).toISOString(), ...data } = item;
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
__name(handleSyncMigrate, "handleSyncMigrate");
function contourGeojsonKey(lake) {
  return `${lake.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}/vectors/contours.geojson`;
}
__name(contourGeojsonKey, "contourGeojsonKey");
async function handleContourGeojsonGet(env, lake) {
  const key = contourGeojsonKey(lake);
  const obj = await env.R2_TROLLMAP_CHARTPACKS.get(key);
  if (!obj) return new Response(JSON.stringify({ error: "no vectorized contours for this lake yet" }), { headers: JSON_HEADERS, status: 404 });
  return new Response(obj.body, { headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
__name(handleContourGeojsonGet, "handleContourGeojsonGet");
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
__name(handleContourGeojsonPut, "handleContourGeojsonPut");
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
__name(buildStage1Prompt, "buildStage1Prompt");
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
  species_list = [.../* @__PURE__ */ new Set([...species_list, ...extra])];
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
__name(handleIdentifyCatch, "handleIdentifyCatch");
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
    headers: { get: /* @__PURE__ */ __name((k) => {
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
    }, "get") },
    arrayBuffer: /* @__PURE__ */ __name(async () => {
      const bin = atob(image_base64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return arr.buffer;
    }, "arrayBuffer")
  };
  const analysis = await handleIdentifyCatch(fakeReq, env);
  return new Response(JSON.stringify({
    success: true,
    analysis,
    context_used: ctx,
    taxonomy_version: "fish_sorter_v4 / TrollMap v13",
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  }), { headers: JSON_HEADERS });
}
__name(handleIdentifyCatchV2, "handleIdentifyCatchV2");
var COACH_SYSTEM_PROMPT = `You are an expert kayak fishing guide and tactical advisor for TrollMap.

Your job is to review a trolling plan and find EXACTLY ONE improvement \u2014 the single change most likely to increase catch rate given the conditions, fish behavior, and angler equipment.

ANGLER CONSTRAINTS (never violate these):
- Spinning rods only \u2014 no conventional reels, no downriggers
- No freshwater live bait
- Maximum 2 rods in the water at once (port + starboard)
- Equipment list is fixed \u2014 only suggest lures the angler owns
- Kayak platform: Native Watersports Slayer Propel Max 12.5 + NK180 24V stern-mount electric outboard motor
  Faster speeds drain battery faster; speed suggestions must be realistic for a full-day kayak session
- Depth control: lead length only (no downriggers, no planer boards)
- If the plan includes a planMeta.speedRationale, the speed was deliberately chosen by the primary AI guide. Do NOT suggest changing speed unless you have a specific safety concern or strong catch-rate evidence that directly contradicts the rationale.

LURE-SPECIFIC HARD CONSTRAINTS (non-negotiable):
- Flutter Spoon: angler owns exactly ONE system \u2014 3/4oz Nichols 4" Shattered Glass Silver + 2oz torpedo
  inline weight (2.75oz total). Color is ALWAYS Shattered Glass Silver \u2014 no other color exists.
  This is a TROLLING presentation at 1.6-2.4mph, NOT a vertical jigging lure.
  Only ONE rod can run the flutter spoon at any time.
- A-Rig (umbrella rig): comes in Light/Medium/Heavy sizes. Port and Starboard CAN both run
  A-rigs simultaneously at different sizes/leads to cover different depth zones.
- Port and Starboard rods are COMPLEMENTARY \u2014 they should cover different depth zones or
  presentations simultaneously, not the same lure on both rods.

ROD PAIRING LOGIC:
- A valid spread has two DIFFERENT presentations covering different water column zones
- Flutter Spoon + A-Rig is a valid pairing (different action profiles, different depths)
- A-Rig Light + A-Rig Medium is a valid pairing (same family, different depths)
- Flutter Spoon + Flutter Spoon is INVALID \u2014 only one spoon system exists
- Do NOT swap lures between port and starboard if it creates an invalid pairing
- Do NOT suggest flutter_spoon_color changes \u2014 color is always Shattered Glass Silver

YOU MAY ONLY SUGGEST CHANGES TO THESE FIELDS:
lure, lure_size, lead_length, trolling_speed, target_depth,
phase_timing, rod_assignment, inline_weight, route_pattern, casting_stop_suggestion

YOU MUST NEVER SUGGEST CHANGES TO:
lure_color for flutter spoon, species, lake, launch_ramp, weather, safety_limits,
battery_limits, gear_not_owned, live_bait, conventional_reels

RESPONSE FORMAT \u2014 return ONLY this JSON object, no other text:
{
  "has_suggestion": true,
  "suggestion": {
    "field": "the field being changed",
    "phase": 1,
    "rod": "Port",
    "current_value": "what it is now",
    "recommended_value": "what to change it to",
    "confidence": 0.87,
    "reasons": ["reason 1", "reason 2", "reason 3"],
    "warnings": ["any cautions"],
    "evidence_sources": ["catch_history", "water_temp", "clarity", "solunar", "structure", "community_spots", "general_knowledge"]
  },
  "no_suggestion_reason": "only populate if has_suggestion is false"
}

If you cannot find a meaningful improvement, set has_suggestion to false.
Never invent lures the angler does not own. Never suggest live bait.`;
async function handleCoachPlan(request, env) {
  try {
    const body = await request.json();
    const { payload, previousSuggestions = [] } = body;
    if (!payload) {
      return new Response(JSON.stringify({ success: false, error: "Missing payload" }), { status: 400, headers: JSON_HEADERS });
    }
    let userMessage = `Review this trolling plan and find ONE improvement.

PLAN:
${JSON.stringify(payload, null, 2)}`;
    if (previousSuggestions.length > 0) {
      const accepted = previousSuggestions.filter((s) => s.status === "accepted" || !s.status);
      const skipped = previousSuggestions.filter((s) => s.status === "skipped");
      if (accepted.length > 0) {
        userMessage += `

ACCEPTED CHANGES \u2014 these are now LIVE in the plan, do not reverse or re-suggest:
`;
        accepted.forEach((s, i) => {
          userMessage += `${i + 1}. [ACCEPTED] ${s.field}${s.phase ? ` Phase ${s.phase}` : ""}${s.rod ? ` ${s.rod}` : ""}: "${s.current_value}" \u2192 "${s.recommended_value}"
`;
        });
      }
      if (skipped.length > 0) {
        userMessage += `
SKIPPED SUGGESTIONS \u2014 angler passed on these, do not re-suggest:
`;
        skipped.forEach((s, i) => {
          userMessage += `${i + 1}. [SKIPPED] ${s.field}${s.phase ? ` Phase ${s.phase}` : ""}${s.rod ? ` ${s.rod}` : ""}: "${s.current_value}" \u2192 "${s.recommended_value}"
`;
        });
      }
      userMessage += `
CURRENT SPREAD STATE (after accepted changes):
- Check accepted changes above to understand what each rod is currently running
- Do not suggest a change that would undo an accepted change or create an invalid rod pairing
`;
    }
    userMessage += `

Return ONLY the JSON object. Find the single highest-confidence improvement, or set has_suggestion to false if the plan is already well-optimized.`;
    const llmPayload = {
      model: "openai/gpt-oss-120b",
      messages: [
        { role: "system", content: COACH_SYSTEM_PROMPT },
        { role: "user", content: userMessage }
      ],
      temperature: 0.15,
      max_tokens: 800,
      response_format: { type: "json_object" }
    };
    const { data } = await callLLM(env, llmPayload);
    let suggestion = {};
    try {
      suggestion = JSON.parse(data.choices?.[0]?.message?.content || "{}");
    } catch (_) {
      suggestion = { has_suggestion: false, no_suggestion_reason: "Parse error" };
    }
    return new Response(JSON.stringify({ success: true, ...suggestion }), { headers: JSON_HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers: JSON_HEADERS });
  }
}
__name(handleCoachPlan, "handleCoachPlan");
// ─── LAKE RESEARCH MODULE ─────────────────────────────────────────────────
// Implements spec v1.0: Lake Research permanent intelligence profiles


var trollmap_worker_default = {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const lake = (url.searchParams.get("lake") || "").toLowerCase();
    try {
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
      if (path === "/audit-plan" && request.method === "POST") {
        try {
          const body = await request.json();
          const SYSTEM_PROMPT = `You are a crusty, veteran South Carolina fishing guide. You have zero patience for "textbook" plans that make no tactical sense in the real world. You speak plainly and critically.

ANGLER PROFILE \u2014 apply these constraints strictly:
- Watercraft: Native Watersports Slayer Propel Max 12.5 pedal kayak + NK180 Pro 24V bow-mount trolling motor
- Rods: Spinning rods ONLY. A-rigs on spinning rods are confirmed working gear.
- No lead-core, no conventional reels, no planer boards, no downriggers
- Depth control: Lead length only.
- Max 2 rods in the water simultaneously.
- Trolling-first angler.
- Freshwater live bait: NOT available (no livewell).

TACTICAL AUDIT RULES \u2014 Flag these as MAJOR ERRORS:
1. DEPTH MISMATCHES: 
   - Flag any A-Rig or Deep Crankbait running shallower than 10-12ft. (Trolling an A-Rig at 5ft is a waste of time).
   - Flag any lure with a max dive of 15ft being run in 25ft of water without clear rationale.
   - Flag any "Deep" lure running too deep for the target species/season (e.g., Stripers in summer usually stack 16-20ft; 30ft is too deep).
2. LURE MISMATCHES:
   - If the plan calls for "Shallow" water (<10ft) but uses an A-Rig, flag it. Suggest Squarebills, Lipless, Spinnerbaits, or Topwater.
3. LOGIC GAPS:
   - If the plan suggests "Dawn" tactics but uses deep-water lures at depths that don't match morning schooling behavior.

CRITIQUE FORMAT \u2014 respond ONLY with valid JSON, no markdown fences:
{
  "overall_score": <1-10>,
  "confidence": "<high|medium|low>",
  "verdict": "<one punchy, honest sentence overall take>",
  "scores": {
    "depth_alignment": <1-10>,
    "lure_selection": <1-10>,
    "speed_cadence": <1-10>,
    "battery_management": <1-10>,
    "safety": <1-10>
  },
  "flags": ["<specific tactical error>", ...],
  "fixes": ["<actionable professional fix>", ...],
  "keeper_moves": ["<what actually makes sense>", ...],
  "local_intel": "<one SC-specific tip the plan missed>"
}

Be direct. If the plan is tactically stupid, say so. Keep flags and fixes to 2-3 items each.`;
          const p = body.plan || body;
          const meta = p.meta || p;
          const spread = (p.spread || []).map((r2) => ({
            side: r2.side,
            position: r2.position,
            rod: r2.rod || "",
            reel: r2.reel || "",
            lure: r2.lure || r2.notes?.split("\xB7")[0]?.trim() || "",
            depth: r2.depth,
            lead: r2.lead,
            notes: r2.notes?.slice(0, 120) || ""
          })).filter((r2) => r2.lure || r2.notes);
          const cleanPlan = {
            lake: meta.lake || p.lake,
            species: meta.species || p.species,
            date: meta.date || p.date,
            ramp: meta.ramp || p.ramp,
            launchTime: meta.launchTime || p.launchTime,
            returnTime: meta.returnTime || p.returnTime,
            waterTemp: meta.waterTemp || p.waterTemp ? `${meta.waterTemp || p.waterTemp}` : null,
            poolLevel: meta.poolLevel || p.poolLevel || null,
            weather: meta.weather || p.weather || "",
            clarity: meta.clarity || p.clarity || "",
            motor: meta.motor || p.motor || "",
            solunar: meta.solunar || p.solunar || "",
            spread: spread.slice(0, 6),
            tackle: p.tackle || "",
            safety: p.safety || "",
            notes: p.notes || "",
            rationale: (p.rationale || "").slice(0, 1500)
            // first 800 chars of rationale only
          };
          const userMessage = `Audit this trolling plan. Apply the angler profile constraints strictly \u2014 flag anything that assumes gear or bait this angler does not have. Identify the single most dangerous safety gap if any. Return ONLY the JSON object described in your system prompt.

PLAN DATA:
${JSON.stringify(cleanPlan, null, 2)}`;
          const payload = {
            model: "openai/gpt-oss-120b",
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: userMessage }
            ],
            temperature: 0.15,
            response_format: { type: "json_object" }
          };
          const { data } = await callLLM(env, payload, "groq");
          let audit = {};
          try {
            audit = JSON.parse(data.choices?.[0]?.message?.content || "{}");
          } catch (_) {
            audit = { error: "parse failed", raw: data.choices?.[0]?.message?.content };
          }
          return new Response(JSON.stringify({ success: true, audit }), { headers: JSON_HEADERS });
        } catch (err) {
          return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: JSON_HEADERS });
        }
      }
      if (path === "/coach-plan" && request.method === "POST") {
        return handleCoachPlan(request, env);
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
      if (path === "/research/agent" && request.method === "POST") {
        return handleResearchAgentPipeline(request, env);
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
        return handleResearchGet(env, lake);
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
        const state = (url.searchParams.get("state") || "SC").toUpperCase();
        const forceRefresh = url.searchParams.has("refresh");
        const cacheKey = `ramps/${state.toLowerCase()}/ramps.json`;
        const CACHE_TTL_DAYS = 7;
        const RAMP_SOURCES = {
          SC: {
            url: "https://services.arcgis.com/acgZYxoN5Oj8pDLa/arcgis/rest/services/South_Carolina_Public_Water_Access_PUBLIC_VIEW/FeatureServer/0/query",
            filter: /* @__PURE__ */ __name((p) => p.WaterAccessType === "Boat Ramp" && p.Status?.toLowerCase() === "active" && p.PublicAccess?.toLowerCase() !== "closed", "filter"),
            name: /* @__PURE__ */ __name((p) => p.WaterAccessName, "name"),
            wb: /* @__PURE__ */ __name((p) => p.Waterbody, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.Latitude, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.Longitude, "lon"),
            meta: /* @__PURE__ */ __name((p) => ({ lanes: p.LaunchLanes, dock: p.CourtesyDock, fee: false, species: p.SpeciesList, county: p.County, owner: p.Owner, comments: p.Comments }), "meta"),
            label: "SCDNR South Carolina Public Water Access"
          },
          GA: {
            url: "https://services6.arcgis.com/9QlSLDqa0P1cHLhu/arcgis/rest/services/WRD_Water_Access_Points/FeatureServer/0/query",
            idField: "FID",
            // GA's objectIdFieldName is FID, not OBJECTID — using OBJECTID in orderByFields causes a 400 from ArcGIS, silently zeroing out results
            // Real schema confirmed 2026-07-03 via outFields=* query — field
            // names (Name/Waterbody/Latitude/Longitude/Status) were already
            // correct, but Ramp/Fee are single-letter "Y"/"N" booleans, not
            // the strings "yes"/"no" this filter was checking for. Every
            // record failed the check, so GA returned 0 waterbodies/0 ramps
            // regardless of cache state.
            filter: /* @__PURE__ */ __name((p) => String(p.Ramp || "").toUpperCase() === "Y" && !["closed", "inactive"].includes(String(p.Status || "").toLowerCase()), "filter"),
            name: /* @__PURE__ */ __name((p) => p.Name, "name"),
            wb: /* @__PURE__ */ __name((p) => p.Waterbody, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.Latitude, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.Longitude, "lon"),
            meta: /* @__PURE__ */ __name((p) => ({ lanes: p.NumLanes, dock: p.Dock, fee: String(p.Fee || "").toUpperCase() === "Y", county: p.County, owner: p.Owner, motorRestrictions: p.MotorRest }), "meta"),
            label: "Georgia DNR WRD Water Access Points"
          },
          NC: {
            url: "https://services1.arcgis.com/YfqBAUM5nWR3yhGP/arcgis/rest/services/NCWRC_Boating_Access_Areas_view/FeatureServer/0/query",
            // Real schema confirmed 2026-07-03 via outFields=* query — NC WRC does NOT
            // use STATUS/SITE_NAME/WATER_BODY like SC/GA. Every prior field guess missed,
            // so all 267 records collapsed into a single "Unknown" waterbody bucket.
            filter: /* @__PURE__ */ __name((p) => !String(p.Site_Status || "OPEN").toUpperCase().includes("CLOSED"), "filter"),
            name: /* @__PURE__ */ __name((p) => p.BAA_Name, "name"),
            wb: /* @__PURE__ */ __name((p) => p.Water_Access || p.BAA_Alias, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.Latitude, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.Longitude, "lon"),
            meta: /* @__PURE__ */ __name((p) => ({ lanes: p.Launch_Lane_No, dock: p.Courtesy_Dock_No || p.Fix_Dock_No, fee: false, county: p.County, owner: p.Owner, motorRestrictions: p.Motorboats_Restricted }), "meta"),
            label: "NC Wildlife Resources Commission Boating Access Areas"
          },
          TN: {
            url: "https://services3.arcgis.com/PWXNAH2YKmZY7lBq/arcgis/rest/services/Boat_Launch_Sites/FeatureServer/0/query",
            filter: /* @__PURE__ */ __name((p) => p.Type === "Boat Launch" && p.IncludeWeb === "Yes" && !["closed", "inactive"].includes(String(p.Status || "").toLowerCase()), "filter"),
            name: /* @__PURE__ */ __name((p) => p.Name, "name"),
            wb: /* @__PURE__ */ __name((p) => p.Waterway, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.Latitude, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.Longitude, "lon"),
            meta: /* @__PURE__ */ __name((p) => ({ lanes: p.Lanes, dock: p.CourtesyDock === "Yes" ? 1 : 0, fee: p.AccessFee === "Yes", county: p.County, owner: p.Owner, restrooms: p.Restrooms === "Yes", handicap: p.HandicapPark === "Yes", canoeLanding: p.CanoeLanding === "Yes" }), "meta"),
            label: "Tennessee Wildlife Resources Agency Boat Launch Sites"
          }
        };
        const source = RAMP_SOURCES[state];
        if (!source) {
          return new Response(JSON.stringify({ error: `Unknown state: ${state}. Use SC, GA, NC, or TN.` }), { headers: JSON_HEADERS, status: 400 });
        }
        if (!forceRefresh) {
          try {
            const cached = await env.R2_TROLLMAP_CHARTPACKS.get(cacheKey);
            if (cached) {
              const meta = cached.customMetadata || {};
              const fetchedAt = meta.fetchedAt ? new Date(meta.fetchedAt) : null;
              const ageMs = fetchedAt ? Date.now() - fetchedAt.getTime() : Infinity;
              if (ageMs < CACHE_TTL_DAYS * 24 * 60 * 60 * 1e3) {
                const body = await cached.text();
                return new Response(body, { headers: { ...JSON_HEADERS, "X-Cache": "HIT", "X-Cache-Age": String(Math.round(ageMs / 36e5)) + "h" } });
              }
            }
          } catch (_) {
          }
        }
        async function fetchAllRampFeatures(baseUrl, idField = "OBJECTID") {
          const allFeatures = [];
          let offset = 0;
          const pageSize2 = 1e3;
          while (true) {
            const params = new URLSearchParams({ outFields: "*", where: "1=1", f: "geojson", resultOffset: offset, resultRecordCount: pageSize2, orderByFields: idField });
            const resp = await fetch(`${baseUrl}?${params}`, {
              headers: { "User-Agent": "TrollMap/1.0 (Cloudflare Worker)", "Accept": "application/json" },
              cf: { cacheTtl: 0 }
            });
            if (!resp.ok) throw new Error(`ArcGIS HTTP ${resp.status}`);
            const data = await resp.json();
            const features = data.features || [];
            allFeatures.push(...features);
            if (features.length < pageSize2) break;
            offset += pageSize2;
          }
          return allFeatures;
        }
        __name(fetchAllRampFeatures, "fetchAllRampFeatures");
        try {
          const features = await fetchAllRampFeatures(source.url, source.idField);
          const waterbodies = {};
          for (const feat of features) {
            const p = feat.properties || {};
            if (!source.filter(p)) continue;
            const lat = parseFloat(source.lat(p));
            const lon = parseFloat(source.lon(p));
            if (!isFinite(lat) || !isFinite(lon) || lat === 0 || lon === 0) continue;
            const wb = (source.wb(p) || "Unknown").trim();
            const name = (source.name(p) || "Unknown").trim();
            if (!waterbodies[wb]) waterbodies[wb] = [];
            waterbodies[wb].push({ name, lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6, ...source.meta(p) });
          }
          for (const wb of Object.keys(waterbodies)) {
            waterbodies[wb].sort((a, b) => a.name.localeCompare(b.name));
          }
          const result = {
            state,
            source: source.label,
            fetched: (/* @__PURE__ */ new Date()).toISOString(),
            count: Object.values(waterbodies).reduce((s, r) => s + r.length, 0),
            waterbodyCount: Object.keys(waterbodies).length,
            waterbodies
          };
          const body = JSON.stringify(result);
          await env.R2_TROLLMAP_CHARTPACKS.put(cacheKey, body, {
            httpMetadata: { contentType: "application/json" },
            customMetadata: { fetchedAt: result.fetched, state, count: String(result.count) }
          });
          return new Response(body, { headers: { ...JSON_HEADERS, "X-Cache": "MISS", "X-Ramp-Count": String(result.count) } });
        } catch (err) {
          try {
            const stale = await env.R2_TROLLMAP_CHARTPACKS.get(cacheKey);
            if (stale) {
              const body = await stale.text();
              return new Response(body, { headers: { ...JSON_HEADERS, "X-Cache": "STALE", "X-Cache-Error": err.message } });
            }
          } catch (_) {
          }
          return new Response(JSON.stringify({ error: `Failed to fetch ${state} ramp data: ${err.message}` }), { headers: JSON_HEADERS, status: 502 });
        }
      }
      if (path === "/paddle") {
        const state = (url.searchParams.get("state") || "SC").toUpperCase();
        const forceRefresh = url.searchParams.has("refresh");
        const cacheKey = `paddle/${state.toLowerCase()}/paddle.json`;
        const CACHE_TTL_DAYS = 7;
        const PADDLE_SOURCES = {
          SC: {
            url: "https://services.arcgis.com/acgZYxoN5Oj8pDLa/arcgis/rest/services/South_Carolina_Public_Water_Access_PUBLIC_VIEW/FeatureServer/0/query",
            filter: /* @__PURE__ */ __name((p) => p.WaterAccessType === "Paddle Launch" && p.Status?.toLowerCase() === "active" && p.PublicAccess?.toLowerCase() !== "closed", "filter"),
            name: /* @__PURE__ */ __name((p) => p.WaterAccessName, "name"),
            wb: /* @__PURE__ */ __name((p) => p.Waterbody, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.Latitude, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.Longitude, "lon"),
            meta: /* @__PURE__ */ __name((p) => ({ subtype: p.WaterAccessSubType, county: p.County, owner: p.Owner }), "meta")
          },
          GA: {
            url: "https://services6.arcgis.com/9QlSLDqa0P1cHLhu/arcgis/rest/services/WRD_Water_Access_Points/FeatureServer/0/query",
            idField: "FID",
            // GA's objectIdFieldName is FID, not OBJECTID
            filter: /* @__PURE__ */ __name((p) => String(p.CanoeAcc || "").toLowerCase() === "y" && !["closed", "inactive"].includes(String(p.Status || "").toLowerCase()), "filter"),
            name: /* @__PURE__ */ __name((p) => p.Name, "name"),
            wb: /* @__PURE__ */ __name((p) => p.Waterbody, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.Latitude, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.Longitude, "lon"),
            meta: /* @__PURE__ */ __name((p) => ({ county: p.County, owner: p.Owner }), "meta")
          },
          NC: {
            url: "https://services1.arcgis.com/YfqBAUM5nWR3yhGP/arcgis/rest/services/NCWRC_Boating_Access_Areas_view/FeatureServer/0/query",
            filter: /* @__PURE__ */ __name((p) => (String(p.Non_Motorized_Access || "").toLowerCase() === "yes" || String(p.Portable_Boat_Access_Type || "").length > 0) && String(p.Site_Status || "").toLowerCase() === "open", "filter"),
            name: /* @__PURE__ */ __name((p) => p.BAA_Name, "name"),
            wb: /* @__PURE__ */ __name((p) => p.Water_Access, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.Latitude, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.Longitude, "lon"),
            meta: /* @__PURE__ */ __name((p) => ({ type: p.Portable_Boat_Access_Type, county: p.County, owner: p.Owner }), "meta")
          },
          TN: {
            url: "https://services3.arcgis.com/PWXNAH2YKmZY7lBq/arcgis/rest/services/Paddling_Access_Sites/FeatureServer/0/query",
            filter: /* @__PURE__ */ __name((p) => p.IncludeWeb === "Yes", "filter"),
            name: /* @__PURE__ */ __name((p) => p.Name, "name"),
            wb: /* @__PURE__ */ __name((p) => p.Waterway, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.Latitude, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.Longitude, "lon"),
            meta: /* @__PURE__ */ __name((p) => ({ county: p.County, owner: p.Owner, type: "Paddling Access" }), "meta")
          }
        };
        const source = PADDLE_SOURCES[state];
        if (!source) return new Response(JSON.stringify({ error: `Unknown state: ${state}` }), { headers: JSON_HEADERS, status: 400 });
        if (!forceRefresh) {
          const cached = await env.R2_TROLLMAP_CHARTPACKS.get(cacheKey);
          if (cached) {
            const ageDays = (Date.now() - new Date(cached.uploaded).getTime()) / 864e5;
            if (ageDays < CACHE_TTL_DAYS) {
              return new Response(await cached.text(), { headers: { ...JSON_HEADERS, "X-Cache": "HIT", "X-Cache-Age-Days": ageDays.toFixed(1) } });
            }
          }
        }
        try {
          let allFeatures = [];
          let offset = 0;
          const idField = source.idField || "OBJECTID";
          while (true) {
            const params = new URLSearchParams({ outFields: "*", where: "1=1", f: "geojson", resultOffset: offset, resultRecordCount: 1e3, orderByFields: idField });
            const resp = await fetch(`${source.url}?${params.toString()}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            if (data.features) allFeatures.push(...data.features);
            if (!data.features || data.features.length < 1e3) break;
            offset += 1e3;
          }
          const waterbodies = {};
          for (const feat of allFeatures) {
            const p = feat.properties || {};
            if (!source.filter(p)) continue;
            let wb = String(source.wb(p) || "Unknown Waterbody").trim() || "Unknown Waterbody";
            let name = String(source.name(p) || "Unnamed Launch").trim();
            const lat = Number(source.lat(p) || feat.geometry?.coordinates?.[1]);
            const lon = Number(source.lon(p) || feat.geometry?.coordinates?.[0]);
            if (!lat || !lon || isNaN(lat) || isNaN(lon)) continue;
            if (!waterbodies[wb]) waterbodies[wb] = [];
            waterbodies[wb].push({ name, lat, lon, meta: source.meta(p) });
          }
          const result = { state, source: source.url, count: Object.values(waterbodies).flat().length, waterbodies };
          const body = JSON.stringify(result);
          await env.R2_TROLLMAP_CHARTPACKS.put(cacheKey, body, { customMetadata: { uploaded: (/* @__PURE__ */ new Date()).toISOString() } });
          return new Response(body, { headers: { ...JSON_HEADERS, "X-Cache": "MISS" } });
        } catch (err) {
          return new Response(JSON.stringify({ error: err.message }), { headers: JSON_HEADERS, status: 502 });
        }
      }
      if (path === "/bank-pier") {
        const state = (url.searchParams.get("state") || "SC").toUpperCase();
        const forceRefresh = url.searchParams.has("refresh");
        const cacheKey = `bankpier/${state.toLowerCase()}/bankpier.json`;
        const CACHE_TTL_DAYS = 7;
        const BANKPIER_SOURCES = {
          SC: {
            url: "https://services.arcgis.com/acgZYxoN5Oj8pDLa/arcgis/rest/services/South_Carolina_Public_Water_Access_PUBLIC_VIEW/FeatureServer/0/query",
            filter: /* @__PURE__ */ __name((p) => (p.WaterAccessType === "Bank" || p.WaterAccessType === "Pier" || String(p.FishingPier || "").toLowerCase() === "yes") && p.Status?.toLowerCase() === "active" && p.PublicAccess?.toLowerCase() !== "closed", "filter"),
            name: /* @__PURE__ */ __name((p) => p.WaterAccessName, "name"),
            wb: /* @__PURE__ */ __name((p) => p.Waterbody, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.Latitude, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.Longitude, "lon"),
            meta: /* @__PURE__ */ __name((p) => ({ type: p.WaterAccessType, pier: p.FishingPier }), "meta")
          },
          GA: {
            url: "https://services6.arcgis.com/9QlSLDqa0P1cHLhu/arcgis/rest/services/WRD_Water_Access_Points/FeatureServer/0/query",
            idField: "FID",
            // GA's objectIdFieldName is FID, not OBJECTID
            filter: /* @__PURE__ */ __name((p) => (String(p.BankFish || "").toLowerCase() === "y" || String(p.PierFish || "").toLowerCase() === "y") && !["closed", "inactive"].includes(String(p.Status || "").toLowerCase()), "filter"),
            name: /* @__PURE__ */ __name((p) => p.Name, "name"),
            wb: /* @__PURE__ */ __name((p) => p.Waterbody, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.Latitude, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.Longitude, "lon"),
            meta: /* @__PURE__ */ __name((p) => ({ bankFish: p.BankFish, pierFish: p.PierFish }), "meta")
          },
          NC: {
            url: "https://services1.arcgis.com/YfqBAUM5nWR3yhGP/arcgis/rest/services/NCWRC_Public_Fishing_Areas_view/FeatureServer/0/query",
            filter: /* @__PURE__ */ __name((p) => String(p.Site_Status || "").toLowerCase() === "open", "filter"),
            name: /* @__PURE__ */ __name((p) => p.PFA_Name, "name"),
            wb: /* @__PURE__ */ __name((p) => p.Water_Access, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.Latitude, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.Longitude, "lon"),
            meta: /* @__PURE__ */ __name((p) => ({ pier: p.Fishing_Pier, bank: p.Bank_Access }), "meta")
          },
          TN: {
            url: "https://services3.arcgis.com/PWXNAH2YKmZY7lBq/arcgis/rest/services/Fishing_Sites/FeatureServer/0/query",
            filter: /* @__PURE__ */ __name((p) => p.IncludeWeb === "Yes", "filter"),
            name: /* @__PURE__ */ __name((p) => p.Name, "name"),
            wb: /* @__PURE__ */ __name((p) => p.Waterway, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.Latitude, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.Longitude, "lon"),
            meta: /* @__PURE__ */ __name((p) => ({ type: p.Type, pier: p.FishingPier === "Yes", county: p.County, owner: p.Owner }), "meta")
          }
        };
        const source = BANKPIER_SOURCES[state];
        if (!source) return new Response(JSON.stringify({ error: `Unknown state: ${state}` }), { headers: JSON_HEADERS, status: 400 });
        if (!forceRefresh) {
          const cached = await env.R2_TROLLMAP_CHARTPACKS.get(cacheKey);
          if (cached) {
            const ageDays = (Date.now() - new Date(cached.uploaded).getTime()) / 864e5;
            if (ageDays < CACHE_TTL_DAYS) {
              return new Response(await cached.text(), { headers: { ...JSON_HEADERS, "X-Cache": "HIT", "X-Cache-Age-Days": ageDays.toFixed(1) } });
            }
          }
        }
        try {
          let allFeatures = [];
          let offset = 0;
          const idField = source.idField || "OBJECTID";
          while (true) {
            const params = new URLSearchParams({ outFields: "*", where: "1=1", f: "geojson", resultOffset: offset, resultRecordCount: 1e3, orderByFields: idField });
            const resp = await fetch(`${source.url}?${params.toString()}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            if (data.features) allFeatures.push(...data.features);
            if (!data.features || data.features.length < 1e3) break;
            offset += 1e3;
          }
          const waterbodies = {};
          for (const feat of allFeatures) {
            const p = feat.properties || {};
            if (!source.filter(p)) continue;
            let wb = String(source.wb(p) || "Unknown Waterbody").trim() || "Unknown Waterbody";
            let name = String(source.name(p) || "Unnamed Spot").trim();
            const lat = Number(source.lat(p) || feat.geometry?.coordinates?.[1]);
            const lon = Number(source.lon(p) || feat.geometry?.coordinates?.[0]);
            if (!lat || !lon || isNaN(lat) || isNaN(lon)) continue;
            if (!waterbodies[wb]) waterbodies[wb] = [];
            waterbodies[wb].push({ name, lat, lon, meta: source.meta(p) });
          }
          for (const wb of Object.keys(waterbodies)) waterbodies[wb].sort((a, b) => a.name.localeCompare(b.name));
          const result = { state, source: source.url, count: Object.values(waterbodies).flat().length, waterbodies };
          const body = JSON.stringify(result);
          await env.R2_TROLLMAP_CHARTPACKS.put(cacheKey, body, { customMetadata: { uploaded: (/* @__PURE__ */ new Date()).toISOString() } });
          return new Response(body, { headers: { ...JSON_HEADERS, "X-Cache": "MISS" } });
        } catch (err) {
          return new Response(JSON.stringify({ error: err.message }), { headers: JSON_HEADERS, status: 502 });
        }
      }
      if (path === "/attractors") {
        const state = (url.searchParams.get("state") || "SC").toUpperCase();
        const forceRefresh = url.searchParams.has("refresh");
        const cacheKey = `attractors/${state.toLowerCase()}/attractors.json`;
        const CACHE_TTL_DAYS = 7;
        const ATTRACTOR_SOURCES = {
          SC: {
            url: "https://services.arcgis.com/acgZYxoN5Oj8pDLa/arcgis/rest/services/SCDNR_Freshwater_Fish_Attractors_Public_Web_App/FeatureServer/0/query",
            filter: /* @__PURE__ */ __name((p) => true, "filter"),
            // All records in this DB are attractors
            name: /* @__PURE__ */ __name((p) => p.FishAttractorName, "name"),
            wb: /* @__PURE__ */ __name((p) => p.Waterbody, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.lat_dd, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.lon_dd, "lon"),
            type: /* @__PURE__ */ __name((p) => p.Material, "type")
          },
          GA: {
            url: "https://services6.arcgis.com/9QlSLDqa0P1cHLhu/arcgis/rest/services/Fish_Attractors_for_Download/FeatureServer/0/query",
            // NOTE: different GA feature service than /ramps, /paddle, /bank-pier
            // (which all use WRD_Water_Access_Points, confirmed idField: FID).
            // This one hasn't been checked against its own schema — don't assume
            // FID applies here too. If this route also returns 0 for GA, query
            // this service's outFields=* first to confirm its real
            // objectIdFieldName before guessing at an idField override.
            filter: /* @__PURE__ */ __name((p) => true, "filter"),
            name: /* @__PURE__ */ __name((p) => p.note, "name"),
            wb: /* @__PURE__ */ __name((p) => p.waterbody, "wb"),
            lat: /* @__PURE__ */ __name((p) => null, "lat"),
            // We pull from geometry
            lon: /* @__PURE__ */ __name((p) => null, "lon"),
            type: /* @__PURE__ */ __name((p) => `${p.attractor_code || ""} ${p.attractor_code_other || ""}`.trim(), "type")
          },
          NC: {
            url: "https://services1.arcgis.com/YfqBAUM5nWR3yhGP/arcgis/rest/services/Fish_Attractors_public_view/FeatureServer/0/query",
            filter: /* @__PURE__ */ __name((p) => true, "filter"),
            name: /* @__PURE__ */ __name((p) => `${p.Waterbody} Attractor`, "name"),
            // NC doesn't have names, just types
            wb: /* @__PURE__ */ __name((p) => p.Waterbody, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.Latitude, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.Longitude, "lon"),
            type: /* @__PURE__ */ __name((p) => `${p.Structure1 || ""} ${p.Structure2 || ""}`.trim() || p.Attractor_Type, "type")
          },
          TN: {
            url: "https://services3.arcgis.com/PWXNAH2YKmZY7lBq/arcgis/rest/services/Fish_Attractor_Locations_view/FeatureServer/0/query",
            filter: /* @__PURE__ */ __name((p) => true, "filter"),
            name: /* @__PURE__ */ __name((p) => p.Site_Name || (p.Embayment ? `${p.WaterBody} - ${p.Embayment}` : `${p.WaterBody} Attractor`), "name"),
            wb: /* @__PURE__ */ __name((p) => p.WaterBody, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.YLat, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.XLong, "lon"),
            type: /* @__PURE__ */ __name((p) => [p.StructureTypes, p.Artificial, p.Natural_].filter(Boolean).join(", ") || "Unknown", "type")
          }
        };
        const source = ATTRACTOR_SOURCES[state];
        if (!source) return new Response(JSON.stringify({ error: `Unknown state: ${state}` }), { headers: JSON_HEADERS, status: 400 });
        if (!forceRefresh) {
          const cached = await env.R2_TROLLMAP_CHARTPACKS.get(cacheKey);
          if (cached) {
            const ageDays = (Date.now() - new Date(cached.uploaded).getTime()) / 864e5;
            if (ageDays < CACHE_TTL_DAYS) {
              return new Response(await cached.text(), { headers: { ...JSON_HEADERS, "X-Cache": "HIT", "X-Cache-Age-Days": ageDays.toFixed(1) } });
            }
          }
        }
        try {
          let allFeatures = [];
          let offset = 0;
          while (true) {
            const params = new URLSearchParams({ outFields: "*", where: "1=1", f: "geojson", resultOffset: offset, resultRecordCount: 1e3, orderByFields: "OBJECTID" });
            const resp = await fetch(`${source.url}?${params.toString()}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            if (data.features) allFeatures.push(...data.features);
            if (!data.features || data.features.length < 1e3) break;
            offset += 1e3;
          }
          const waterbodies = {};
          for (const feat of allFeatures) {
            const p = feat.properties || {};
            if (!source.filter(p)) continue;
            let wb = String(source.wb(p) || "Unknown Waterbody").trim() || "Unknown Waterbody";
            let name = String(source.name(p) || "Attractor").trim() || "Attractor";
            const lat = Number(source.lat(p) || feat.geometry?.coordinates?.[1]);
            const lon = Number(source.lon(p) || feat.geometry?.coordinates?.[0]);
            if (!lat || !lon || isNaN(lat) || isNaN(lon)) continue;
            if (!waterbodies[wb]) waterbodies[wb] = [];
            waterbodies[wb].push({ name, lat, lon, type: String(source.type(p) || "Unknown").trim() });
          }
          for (const wb of Object.keys(waterbodies)) waterbodies[wb].sort((a, b) => a.name.localeCompare(b.name));
          const result = { state, source: source.url, count: Object.values(waterbodies).flat().length, waterbodies };
          const body = JSON.stringify(result);
          await env.R2_TROLLMAP_CHARTPACKS.put(cacheKey, body, { customMetadata: { uploaded: (/* @__PURE__ */ new Date()).toISOString() } });
          return new Response(body, { headers: { ...JSON_HEADERS, "X-Cache": "MISS" } });
        } catch (err) {
          return new Response(JSON.stringify({ error: err.message }), { headers: JSON_HEADERS, status: 502 });
        }
      }
      if (path === "/duke" || url.searchParams.has("duke")) {
        const format = (url.searchParams.get("format") || "text").toLowerCase();
        const d = await fetchDukeDashboard(url.searchParams.get("basin") || "1");
        if (!d) {
          return new Response(JSON.stringify({ error: "Duke API unreachable" }), { headers: JSON_HEADERS, status: 502 });
        }
        if (format === "json") {
          return new Response(JSON.stringify(d.json, null, 2), { headers: { ...JSON_HEADERS, "X-Source": d.url } });
        }
        return new Response(d.text, { headers: { ...TEXT_HEADERS, "X-Source": d.url } });
      }
      if (path === "/usgs") {
        const site = url.searchParams.get("site");
        const params = url.searchParams.get("params") || "00010,00065";
        if (!site) return new Response('{"error":"missing site"}', { headers: JSON_HEADERS, status: 400 });
        const r = await fetch(`https://waterservices.usgs.gov/nwis/iv/?sites=${site}&parameterCd=${params}&format=json&period=P2D`);
        const t = await r.text();
        return new Response(t, { headers: JSON_HEADERS, status: r.status });
      }
      if (path === "/lake-clarity") {
        const name = url.searchParams.get("lake") || url.searchParams.get("waterbody") || "";
        const dateParam = url.searchParams.get("date") || (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
        if (!name) return new Response(JSON.stringify({ error: "missing lake" }), { headers: JSON_HEADERS, status: 400 });
        const data = await getLakeClarity(name, dateParam);
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
        } catch {
          const intel = await getLakeIntel(name);
          return new Response(JSON.stringify(intel, null, 2), { headers: JSON_HEADERS });
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
      if (path === "/lake") {
        if (!lake) return new Response('{"error":"missing lake"}', { headers: JSON_HEADERS, status: 400 });
        const result = await resolveLake(lake);
        return new Response(JSON.stringify(result, null, 2), { headers: JSON_HEADERS });
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
      if (path === "/chartpacks/lake-boundary" && request.method === "GET") {
        const lakeName = url.searchParams.get("lake") || "";
        if (!lakeName) return new Response(JSON.stringify({ error: "missing lake param" }), { status: 400, headers: JSON_HEADERS });
        // Boundaries stored under boundaries/ prefix with _3dhp suffix
        const safeId = sanitizeLakeId(lakeName);
        const shortKey = lakeKeyFromName(lakeName);
        const candidates = [
          `boundaries/${safeId}_3dhp.geojson`,
          `boundaries/lake_${shortKey}_3dhp.geojson`,
          `boundaries/${safeId}.geojson`,
          `boundaries/${shortKey}.geojson`,
        ];
        let geoObj = null;
        for (const key of candidates) {
          geoObj = await env.R2_TROLLMAP_CHARTPACKS.get(key).catch(() => null);
          if (geoObj) break;
        }
        if (!geoObj) return new Response(JSON.stringify({ error: "no boundary data found", lake: lakeName, tried: candidates }), { status: 404, headers: JSON_HEADERS });
        const geoText = await geoObj.text();
        return new Response(geoText, { headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" } });
      }

      if (path === "/chartpacks/list") {
        const data = await handleChartpackList(env);
        return new Response(JSON.stringify(data, null, 2), { headers: JSON_HEADERS });
      }
      if (path === "/debug/regs-cache") {
        const state = url.searchParams.get('state')?.toUpperCase();
        if (!state) return new Response('?state= required', { status: 400 });
        const cached = await env.KV.get(`regulations:${state}:v2`, { type: 'json' });
        return new Response(JSON.stringify({ state, cached }, null, 2), { headers: { ...CORS, ...JSON_HEADERS, 'Cache-Control': 'no-store' } });
      }
        // Check each catalog key for contour data presence in R2
        const CATALOG_KEYS = [
          'lake_thurmond_russell','lake_hickory_rhodhiss','lake_greenwood_secession',
          'lake_monticello_parr','yadkin_river_chain','lake_norman_mountain_island',
          'lake_wateree_fishing_creek','lake_juliette_high_falls','lake_marion','lake_moultrie',
          'lake_murray','saluda_river_arm','lake_hartwell','lake_wylie','mountain_island_lake',
          'lake_norman','high_point_lake','bear_creek_reservoir_ga','john_d_long_lake',
          'prestwood_lake','hb_robinson_lake','lake_jocassee','lake_keowee','lake_summit',
          'north_fork_reservoir','lake_adger','lake_robinson_greenville','north_saluda_reservoir',
          'lake_cunningham','lake_blalock','lake_bowen','lake_lure','lake_james','john_h_moss_lake',
          'lookout_shoals_lake','w_kerr_scott_reservoir','belews_lake','randleman_lake',
          'shearon_harris_reservoir','buckhorn_reservoir','mayo_lake','hyco_lake','lake_michie',
          'kerr_lake','lake_gaston','lake_townsend','lake_mackintosh','lake_reidsville',
          'oak_hollow_higgins','lake_brandt','auman_lake','jordan_lake','falls_lake',
          'bonnie_doone_lake','kornbow_lake','fort_loudoun_lake','tellico_lake','melton_hill_lake',
          'watts_bar_lake','lake_chilhowee','chickamauga_lake','nickajack_lake','fontana_lake',
          'hiwassee_lake','lake_chatuge','watauga_lake','norris_lake','douglas_lake',
          'cherokee_lake','boone_lake','south_holston_lake','nantahala_lake','lake_santeetlah',
          'lake_cheoah','lake_glenville','lake_toxaway','bear_creek_lake','lake_lanier',
          'lake_allatoona','lake_blue_ridge','lake_nottely','lake_burton','lake_seed',
          'parksville_lake','west_point_lake','lake_sinclair','lake_oconee','lake_jackson_ga',
          'tobesofkee_reservoir','lake_blackshear','watauga_boone_chain','catawba_narrows',
          'lake_lure','lake_cunningham','lake_brandt','lake_gaston','lake_michie',
          'lake_reidsville','lookout_shoals_lake',
        ];
        const CONTOUR_FILES = ['depth_areas.geojson','contours.pbf','contours.geojson'];
        const results = [];
        const seen = new Set();
        for (const key of CATALOG_KEYS) {
          if (seen.has(key)) continue;
          seen.add(key);
          const listed = await env.R2_TROLLMAP_CHARTPACKS.list({ prefix: `supplemental/${key}/` });
          const files = listed.objects.map(o => o.key.replace(`supplemental/${key}/`, ''));
          const hasContours = files.some(f => CONTOUR_FILES.includes(f));
          const hasShoreline = files.includes('shoreline.geojson');
          const hasDepthAreas = files.includes('depth_areas.geojson');
          results.push({ key, files, hasContours, hasShoreline, hasDepthAreas });
        }
        const withContours = results.filter(r => r.hasContours).map(r => r.key).sort();
        const withoutContours = results.filter(r => !r.hasContours).map(r => ({ key: r.key, files: r.files }));
        return new Response(JSON.stringify({
          total: results.length,
          withContours: withContours.length,
          withoutContours: withoutContours.length,
          researchable: withContours,
          noContourData: withoutContours,
        }, null, 2), { headers: { ...CORS, ...JSON_HEADERS, 'Cache-Control': 'no-store' } });
      }
      const idxMatch = path.match(/^\/chartpacks\/([^/]+)\/index\.json$/);
      if (idxMatch) {
        const lakeName = idxMatch[1];
        const prefix = chartpackKey(lakeName, "");
        const listed = await env.R2_TROLLMAP_CHARTPACKS.list({ prefix });
        const tiles = /* @__PURE__ */ new Set();
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
          const obj = await env.R2_TROLLMAP_CHARTPACKS.get(key);
          if (!obj) return new Response('{"error":"not found"}', { headers: JSON_HEADERS, status: 404 });
          let ct = "application/octet-stream";
          if (file.endsWith(".png")) ct = "image/png";
          else if (file.endsWith(".json")) ct = "application/json";
          const headers = { ...CORS, "Content-Type": ct, "Cache-Control": "no-store" };
          return new Response(obj.body, { headers });
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
              contentType: file.endsWith(".png") ? "image/png" : "application/json",
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
          "/research/agent                    \u2014 run single AI research agent (identity|limnology|biology|habitat|navigation|regulations|trolling|summary) — uses full callLLM chain (groq 120b primary → fallback), grounded with known LAKES baseline for identity",
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
          "/duke?basin=1|2|3                      \u2014 raw Duke lake levels",
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
