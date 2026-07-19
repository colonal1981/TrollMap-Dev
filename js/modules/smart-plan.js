/**
 * smart-plan.js — TrollMap Smart Plan Orchestrator
 *
 * Scout waypoint mode: Groq picks depth bands + lures, contour data places
 * waypoints, 4 out-and-back routes are built. Coach reviews the full plan.
 */

import { state, CF_WORKER_URL } from '../core/state.js';
import { renderAll } from '../core/map-init.js';
import { esc } from '../utils/escape.js';
import { newRodRow } from '../utils/rod-row.js';
import { renderSpread, autoCalculateLead, LURE_DIVE_DEPTHS } from './spread-builder.js';
import { getActiveContour } from './contour-data.js';
import { selectBestLure, getInventory } from '../data/tackle-inventory.js';
import { getLureColor } from '../data/lure-knowledge.js';
import { getPhaseDepth, getStrategySpeed, normalizeSpecies, getPresentationPriority, getPhaseNotes } from '../data/species-strategies.js';
import { SPECIES_BEHAVIOR, SPECIES_BEHAVIOR_V2, getSeason, checkRegulations, resolveLakeKey } from '../data/species-intel.js';
const IntelV2 = { SPECIES_BEHAVIOR_V2, resolveLakeKey, checkRegulations, getSeason };
import { isLiveBaitAvailable } from '../data/fishing-style-profile.js';
import { buildFishingContext, buildGroqCoachPayload } from './smart-plan-context.js';
import { startCoachSession } from './groq-coach.js';
import { renderSmartPlanUI, syncSpread, reelForLure } from './smart-plan-ui.js';

// Pull from the universal worker-backed access database
import { getLoadedAccessIndex } from '../data/access-index.js';
import { LAKE_DB } from '../data/lakes.js';

const BATTERY_AH_DEFAULT = 100;
const MOTOR_AMP_AVG      = 6;
const PHASE_1_END_OFFSET_MIN = 60;
const PHASE_2_END_OFFSET_MIN = 210;

// ── Dynamic inventory name list (loaded from tackle-inventory.js at runtime) ──
let _cachedTrollableNames = null;

// Maps annotated prompt string → clean inventory name
// e.g. "SR Crankbait (3-5ft) [3-5ft dive | 1.2-1.8mph]" → "SR Crankbait (3-5ft)"
let _cachedAnnotatedToClean = null;

async function getTrollableNames() {
  if (_cachedTrollableNames) return _cachedTrollableNames;
  const inv = await getInventory();
  _cachedAnnotatedToClean = {};
  _cachedTrollableNames = inv.filter(l => l.trollable).map(l => {
    const depthStr = (l.diveDepthMin != null && l.diveDepthMax != null)
      ? (l.diveDepthMin === 0 ? 'surface' : `${l.diveDepthMin}-${l.diveDepthMax}ft dive`)
      : 'variable depth (lead controls)';
    const speedStr = `${l.trollSpeedMin}-${l.trollSpeedMax}mph`;
    const annotated = `${l.name} [${depthStr} | ${speedStr}]`;
    _cachedAnnotatedToClean[annotated.toLowerCase()] = l.name;
    return annotated;
  });
  return _cachedTrollableNames;
}

// Strip the [...] annotation bracket from a lure name returned by Groq
function stripLureAnnotation(raw) {
  if (!raw) return raw;
  // Remove everything from " [" onward
  return String(raw).replace(/\s*\[.*$/, '').trim();
}

/**
 * Apply the physical speed ceiling for one trolling pass.
 *
 * A pass has exactly two lures in the water, so its boat speed is limited by
 * the lower trollSpeedMax of that pass's port and starboard lures.  This is
 * deliberately per-pass: Band 1's lures must not constrain Band 2, and vice
 * versa.  The returned speed is safe to use for both the outbound and inbound
 * route for that band.
 */
export function capPassSpeed(requestedSpeed, lureNames, inventory, fallbackSpeed = 1.8) {
  const requested = Number.parseFloat(requestedSpeed);
  const requestedMph = Number.isFinite(requested) && requested > 0 ? requested : fallbackSpeed;
  const selectedLures = (lureNames || []).map((name) => {
    const cleanName = String(stripLureAnnotation(name) || '').toLowerCase();
    return (inventory || []).find((lure) =>
      lure?.trollable && String(lure.name || '').toLowerCase() === cleanName,
    );
  }).filter(Boolean);
  const maxSpeeds = selectedLures
    .map((lure) => Number.parseFloat(lure.trollSpeedMax))
    .filter((speed) => Number.isFinite(speed) && speed > 0);
  const maxMph = maxSpeeds.length ? Math.min(...maxSpeeds) : null;
  const appliedMph = maxMph == null ? requestedMph : Math.min(requestedMph, maxMph);
  const limitingLures = maxMph == null ? [] : selectedLures
    .filter((lure) => Number.parseFloat(lure.trollSpeedMax) === maxMph);

  return {
    requestedMph,
    appliedMph,
    maxMph,
    selectedLures,
    limitingLures,
    wasCapped: maxMph != null && requestedMph > maxMph,
  };
}

// ── Groq lure name sanitizer ──────────────────────────────────────────────────
function sanitizeGroqLureName(raw, targetDepthFt, inventoryNames) {
  if (!raw) return depthFallbackLure(targetDepthFt, inventoryNames);
  // Strip the annotation bracket Groq sometimes returns with the name
  const stripped = stripLureAnnotation(raw);
  // Also check direct map from annotated string
  if (_cachedAnnotatedToClean) {
    const direct = _cachedAnnotatedToClean[String(raw).toLowerCase().trim()];
    if (direct) return direct;
  }
  const r = String(stripped).toLowerCase().trim();

  const exact = inventoryNames.find(n => n.toLowerCase() === r);
  if (exact) return exact;

  const substr = inventoryNames.find(n => {
    const nl = n.toLowerCase();
    return nl.includes(r) || r.includes(nl);
  });
  if (substr) return substr;

  const rWords = r.replace(/[^a-z0-9"]/g, ' ').split(/\s+/).filter(w => w.length > 2);
  let bestName = null, bestScore = 0;
  for (const name of inventoryNames) {
    const nl = name.toLowerCase();
    const score = rWords.filter(w => nl.includes(w)).length;
    if (score > bestScore) { bestScore = score; bestName = name; }
  }
  if (bestScore >= 1) return bestName;

  return depthFallbackLure(targetDepthFt, inventoryNames);
}

function depthFallbackLure(depthFt, inventoryNames) {
  const d = parseFloat(depthFt) || 15;
  const findMatch = (...keywords) => {
    return inventoryNames.find(n => keywords.some(k => n.toLowerCase().includes(k)));
  };
  if (d < 8)  return findMatch('squarebill', 'sr crankbait', 'lipless', 'spinnerbait') || inventoryNames[0];
  if (d < 14) return findMatch('mr crankbait', 'dd1', 'a-rig light', 'swimbait 3.8') || inventoryNames[0];
  if (d < 20) return findMatch('dd1', 'dd2', 'a-rig medium', 'swimbait 4.6', 'umbrella') || inventoryNames[0];
  if (d < 26) return findMatch('dd2', 'dd3', 'a-rig heavy', 'swimbait 5"', 'flutter spoon') || inventoryNames[0];
  return findMatch('dd3', 'dd4', 'flutter spoon', 'bucktail') || inventoryNames[0];
}

// ── Geo helpers ───────────────────────────────────────────────────────────────
function geoDistanceFt(lat1, lon1, lat2, lon2) {
  const R = 20902231, D = Math.PI / 180;
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Infinity;
  const p1=lat1*D, p2=lat2*D, dp=(lat2-lat1)*D, dl=(lon2-lon1)*D;
  const a = Math.sin(dp/2)**2 + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── Sunrise & Solunar ─────────────────────────────────────────────────────────
function computeSunrise(lat, lon, dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const JD = Math.floor(d / 86400000) + 2440587.5;
  const n = JD - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * Math.PI / 180;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * Math.PI / 180;
  const sinDec = Math.sin(23.439 * Math.PI / 180) * Math.sin(lambda);
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosH = (Math.cos(90.833 * Math.PI / 180) - sinDec * Math.sin(lat * Math.PI / 180))
               / (cosDec * Math.cos(lat * Math.PI / 180));
  if (Math.abs(cosH) > 1) return 6.0;
  const H = Math.acos(cosH) * 180 / Math.PI;
  const RA = Math.atan2(Math.cos(23.439 * Math.PI / 180) * Math.sin(lambda), Math.cos(lambda)) * 180 / Math.PI;
  const t = 720 - 4 * (lon + H) - (RA - 15 * ((JD - 2451545) / 36525 * 360.9856474 % 360)) / 15;
  return ((t / 60) + 24) % 24 - 5;
}

function computeSolunar(lat, lon, dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const JD = Math.floor(d / 86400000) + 2440587.5;
  const T = (JD - 2451545.0) / 36525;
  const Lm = 218.3164 + 481267.8812 * T;
  const moonTransitUT = (360 - (Lm % 360)) / 15;
  const offsetH = lon / 15;
  const major1 = ((moonTransitUT + offsetH + 24) % 24) - 5;
  const major2 = (major1 + 12) % 24;
  return { major1, major2, minor1: (major1 + 6) % 24, minor2: (major1 + 18) % 24 };
}

function computeRangeMiles(speedMph) {
  const spd = speedMph || 2.0;
  const bms = window.ACTIVE_BLE_BMS;
  if (bms?.connected && bms.remainingAh > 0 && bms.current > 0.1)
    return (bms.remainingAh / bms.current * spd) / 2;
  return (BATTERY_AH_DEFAULT / MOTOR_AMP_AVG * spd) / 2;
}

// ── Phase boundaries ──────────────────────────────────────────────────────────
function computePhases(launchTimeStr, returnTimeStr, dateStr, lat, lon) {
  const sunriseH = computeSunrise(lat, lon, dateStr);
  const sol = computeSolunar(lat, lon, dateStr);

  function parseT(t) {
    if (!t) return null;
    const m = t.match(/(\d+):(\d+)\s*(am|pm)?/i);
    if (!m) return null;
    let h = parseInt(m[1]), min = parseInt(m[2]);
    if (m[3]?.toLowerCase() === 'pm' && h < 12) h += 12;
    if (m[3]?.toLowerCase() === 'am' && h === 12) h = 0;
    return h + min / 60;
  }

  const launchH = parseT(launchTimeStr) || 6.0;
  const returnH = parseT(returnTimeStr) || 12.0;
  let p1End = sunriseH + PHASE_1_END_OFFSET_MIN / 60;
  let p2End = sunriseH + PHASE_2_END_OFFSET_MIN / 60;

  [sol.major1, sol.major2].forEach(t => {
    if (t >= launchH && t <= p1End + 0.5) p1End = Math.max(p1End, t + 1.0);
    if (t >= p1End  && t <= p2End + 0.5) p2End = Math.max(p2End, t + 1.0);
  });
  [sol.minor1, sol.minor2].forEach(t => {
    if (t >= launchH && t <= p1End + 0.25) p1End = Math.max(p1End, t + 0.5);
  });

  p1End = Math.min(p1End, returnH - 1.0);
  p2End = Math.min(p2End, returnH - 0.5);
  if (p1End >= p2End) p1End = launchH + (returnH - launchH) / 3;
  if (p2End >= returnH) p2End = launchH + 2 * (returnH - launchH) / 3;

  function hStr(h) {
    const hh = Math.floor(((h % 24) + 24) % 24);
    const mm = Math.round((h % 1) * 60);
    return `${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
  }

  return {
    sunriseH, solunar: sol,
    phases: [
      { num:1, name:'Dawn',       start:launchH, end:p1End,   startStr:hStr(launchH), endStr:hStr(p1End)   },
      { num:2, name:'Transition', start:p1End,   end:p2End,   startStr:hStr(p1End),   endStr:hStr(p2End)   },
      { num:3, name:'Deep',       start:p2End,   end:returnH, startStr:hStr(p2End),   endStr:hStr(returnH) },
    ],
  };
}

// ── Per-phase species-intel lookup (fallback context for rationale) ────────────
function getPhaseRecommendation(species, lakeName, season, phaseNum, waterTempF) {
  const v2sp = IntelV2?.SPECIES_BEHAVIOR_V2?.[species];
  if (v2sp) {
    const lakeKeyV2 = (IntelV2.resolveLakeKey
      ? (IntelV2.resolveLakeKey(lakeName, v2sp) || 'default_SC_reservoir')
      : (v2sp[lakeName] ? lakeName : 'default_SC_reservoir'));
    const lakeNode = v2sp[lakeKeyV2] || v2sp['default_SC_reservoir'] || v2sp['Coastal SC Inshore'];
    const sNode = lakeNode?.[season];
    if (sNode) {
      let [dMin, dMax] = typeof sNode.preferredDepth === 'function'
        ? sNode.preferredDepth(waterTempF) : (sNode.preferredDepth || [5, 15]);
      const spread = dMax - dMin;
      if (phaseNum === 1)      { dMax = Math.round(dMin + spread * 0.45); }
      else if (phaseNum === 2) { dMin = Math.round(dMin + spread * 0.25); dMax = Math.round(dMin + spread * 0.5); }
      else                     { dMin = Math.round(dMin + spread * 0.55); }
      const speed = Array.isArray(sNode.preferredSpeed) ? sNode.preferredSpeed[0] : (sNode.preferredSpeed || 1.8);
      return {
        depthMin: Math.round(dMin), depthMax: Math.round(dMax),
        lures: sNode.preferredPresentation || [], speed,
        notes: Array.isArray(sNode.notes) ? sNode.notes.join(' · ') : (sNode.notes || ''),
        structure: sNode.preferredStructure || [],
      };
    }
  }
  const lakeKey = resolveLakeKey(lakeName, SPECIES_BEHAVIOR);
  const seasonData = SPECIES_BEHAVIOR[lakeKey]?.[species]?.[season];
  if (!seasonData) return null;
  const todKeys = { 1:'dawn', 2:'day', 3:'day' };
  const tod = seasonData.timeOfDay[todKeys[phaseNum]] || seasonData.timeOfDay['day'];
  if (!tod) return null;
  let [dMin, dMax] = typeof seasonData.depthBand === 'function'
    ? seasonData.depthBand(waterTempF) : [...seasonData.depthBand];
  return { depthMin:Math.round(dMin), depthMax:Math.round(dMax), lures:tod.lures||[], speed:tod.speed||2.0, notes:tod.notes||'' };
}

// ── Contour walk ──────────────────────────────────────────────────────────────
function stitchContourFragments(fragments, TOL_FT = 50) {
  const segs = fragments.filter(c => c.length >= 2).map(c => c.map(([lo, la]) => [la, lo]));
  const used = new Array(segs.length).fill(false);
  const chains = [];

  function dist2(a, b) {
    const dlat=(a[0]-b[0])*364000, dlon=(a[1]-b[1])*364000*Math.cos(a[0]*Math.PI/180);
    return Math.sqrt(dlat*dlat+dlon*dlon);
  }
  function bearing(a, b) { return Math.atan2((b[1]-a[1])*Math.cos(a[0]*Math.PI/180), b[0]-a[0])*180/Math.PI; }
  function angleDiff(a, b) { let d=Math.abs(a-b)%360; return d>180?360-d:d; }

  for (let s=0; s<segs.length; s++) {
    if (used[s]) continue;
    used[s] = true;
    let chain = segs[s].slice(), grew = true;
    while (grew) {
      grew = false;
      const head=chain[0], tail=chain[chain.length-1];
      const tBrng=chain.length>=2?bearing(chain[chain.length-2],tail):0;
      const hBrng=chain.length>=2?bearing(chain[1],head):0;
      let bJ=-1, bScore=Infinity, bOp=null;
      for (let j=0; j<segs.length; j++) {
        if (used[j]) continue;
        const c=segs[j], a=c[0], b=c[c.length-1];
        const cands=[
          {d:dist2(tail,a),op:'TA',turn:angleDiff(tBrng,bearing(a,c[Math.min(1,c.length-1)]))},
          {d:dist2(tail,b),op:'TB',turn:angleDiff(tBrng,bearing(b,c[Math.max(0,c.length-2)]))},
          {d:dist2(head,a),op:'HA',turn:angleDiff(hBrng,bearing(a,c[Math.min(1,c.length-1)]))},
          {d:dist2(head,b),op:'HB',turn:angleDiff(hBrng,bearing(b,c[Math.max(0,c.length-2)]))},
        ];
        for (const cand of cands) {
          if (cand.d>TOL_FT||cand.turn>90) continue;
          const sc=cand.d+cand.turn;
          if (sc<bScore) { bScore=sc; bJ=j; bOp=cand.op; }
        }
      }
      if (bJ>=0) {
        const c=segs[bJ].slice(); used[bJ]=true; grew=true;
        if (bOp==='TA') chain=chain.concat(c);
        else if (bOp==='TB') chain=chain.concat(c.reverse());
        else if (bOp==='HA') chain=c.reverse().concat(chain);
        else chain=c.concat(chain);
      }
    }
    chains.push(chain);
  }
  return chains;
}

function walkContourForWaypoints(depthMin, depthMax, refLat, refLon, maxDistFt, budgetFt, stepFt=150) {
  const contour = getActiveContour();
  const gj = contour?.smart || contour?.raw;
  if (!gj?.features?.length) return [];

  const inRange = gj.features.filter(f => {
    const d = f.properties?.depth_ft;
    if (d==null||d<depthMin||d>depthMax) return false;
    const coords = f.geometry?.coordinates;
    if (!coords?.length) return false;
    return coords.some(([lo,la]) => geoDistanceFt(refLat,refLon,la,lo)<=maxDistFt);
  });
  if (!inRange.length) return [];

  const byDepth = new Map();
  for (const f of inRange) {
    const d=f.properties.depth_ft;
    if (!byDepth.has(d)) byDepth.set(d,[]);
    byDepth.get(d).push(f.geometry.coordinates);
  }

  const allChains = [];
  for (const [depth, frags] of byDepth) {
    for (const chain of stitchContourFragments(frags)) {
      if (chain.length<2) continue;
      let len=0;
      for (let i=1; i<chain.length; i++) len+=geoDistanceFt(chain[i-1][0],chain[i-1][1],chain[i][0],chain[i][1]);
      if (len<stepFt*2) continue;
      let closest=Infinity;
      for (let i=0; i<chain.length; i+=Math.max(1,Math.floor(chain.length/40))) {
        const d2=geoDistanceFt(refLat,refLon,chain[i][0],chain[i][1]);
        if (d2<closest) closest=d2;
      }
      // Compute average distance from shore — channel chains score higher than bank-huggers
      let avgShoreDist = 0;
      if (boundaryRing) {
        const sampleStep = Math.max(1, Math.floor(chain.length / 20));
        let sampleCount = 0;
        for (let i = 0; i < chain.length; i += sampleStep) {
          avgShoreDist += distToRingFt(chain[i][0], chain[i][1]);
          sampleCount++;
        }
        avgShoreDist = sampleCount ? avgShoreDist / sampleCount : 0;
      }
      if (closest<=maxDistFt) allChains.push({chain,len,closest,depth,avgShoreDist});
    }
  }
  if (!allChains.length) return [];

  // Score: prefer chains that are close to ramp, long, AND furthest from shore (channel preference)
  // avgShoreDist bonus is capped at 500ft so it doesn't overwhelm proximity on wide open water
  allChains.sort((a,b) => {
    const scoreA = a.closest*2 - a.len - Math.min(a.avgShoreDist, 500);
    const scoreB = b.closest*2 - b.len - Math.min(b.avgShoreDist, 500);
    return scoreA - scoreB;
  });
  const best=allChains[0];
  console.log(`[scout] best chain: depth=${best.depth}ft len=${Math.round(best.len)}ft closest=${Math.round(best.closest)}ft avgShoreDist=${Math.round(best.avgShoreDist)}ft`);

  let nearIdx=0, nearDist=Infinity;
  for (let i=0; i<best.chain.length; i++) {
    const d=geoDistanceFt(refLat,refLon,best.chain[i][0],best.chain[i][1]);
    if (d<nearDist) { nearDist=d; nearIdx=i; }
  }

  const SHORE_STANDOFF_FT = 100;

  // Build boundary ring for standoff check
  let boundaryRing = null;
  try {
    const bgj = window.LAKE_BOUNDARY_GEOJSON;
    if (bgj?.features?.length) {
      let bestRing = null, bestLen = 0;
      for (const feat of bgj.features) {
        const geom = feat.geometry;
        const rings = geom?.type === 'Polygon' ? [geom.coordinates[0]]
          : geom?.type === 'MultiPolygon' ? geom.coordinates.map(p => p[0])
          : [];
        for (const ring of rings) {
          if (ring?.length > bestLen) { bestRing = ring; bestLen = ring.length; }
        }
      }
      if (bestRing) boundaryRing = bestRing; // [[lon, lat], ...]
    }
  } catch (_) {}

  function distToRingFt(lat, lon) {
    if (!boundaryRing) return Infinity;
    let minDist = Infinity;
    for (let i = 0; i < boundaryRing.length; i++) {
      const d = geoDistanceFt(lat, lon, boundaryRing[i][1], boundaryRing[i][0]);
      if (d < minDist) minDist = d;
    }
    return minDist;
  }

  const walk = (start, dir) => {
    const pts=[{lat:best.chain[start][0],lon:best.chain[start][1],depth:best.depth}];
    let traveled=0, carry=0;
    for (let i=start+dir; dir>0?i<best.chain.length:i>=0; i+=dir) {
      const prev=best.chain[i-dir], curr=best.chain[i];
      const segFt=geoDistanceFt(prev[0],prev[1],curr[0],curr[1]);
      carry+=segFt; traveled+=segFt;
      if (traveled>=budgetFt) break;
      if (carry>=stepFt) {
        const ptLat=curr[0], ptLon=curr[1];
        const lastPt = pts[pts.length-1];
        const midLat = (lastPt.lat + ptLat) / 2;
        const midLon = (lastPt.lon + ptLon) / 2;
        // Drop waypoints where path midpoint is very close to shore (likely crossing land)
        if (distToRingFt(midLat, midLon) >= 50) {
          pts.push({lat:ptLat,lon:ptLon,depth:best.depth});
        }
        carry=0;
      }
    }
    return pts;
  };

  const fwd=walk(nearIdx,1), rev=walk(nearIdx,-1);
  return fwd.length>=rev.length ? fwd : rev;
}

async function generateScoutWaypoints(phases, bands, rampLat, rampLon, rangeMiles, speedsMph=2.0, phaseInfo) {
  if (!state.DATA) state.DATA={};
  if (!Array.isArray(state.DATA.waypoints)) state.DATA.waypoints=[];
  state.DATA.waypoints=state.DATA.waypoints.filter(w=>!w.scoutWaypoint);
  if (!state.DATA.tracks) state.DATA.tracks=[];
  state.DATA.tracks=state.DATA.tracks.filter(t=>!t.scoutRoute);

  if (Number.isFinite(rampLat)&&Number.isFinite(rampLon)) {
    state.DATA.waypoints.push({name:'Launch',lat:rampLat,lon:rampLon,sym:'Boat Ramp',role:'launch_ramp',scoutWaypoint:true});
  }

  const p=phaseInfo?.phases||phases;
  const totalDurH=p.length?(p[p.length-1].end-p[0].start):6;
  const maxDistFt=Math.min(rangeMiles,4.0)*5280;
  const STEP_FT=150;

  bands=(bands||[]).map((b,i)=>({...b,phase:i+1}));
  let totalAdded=0;
  const phaseWaypoints={};

  for (const band of bands) {
    const passSpeed = Array.isArray(speedsMph)
      ? speedsMph[band.phase - 1]
      : speedsMph;
    const safePassSpeed = Number.isFinite(Number(passSpeed)) && Number(passSpeed) > 0
      ? Number(passSpeed)
      : 2.0;
    // Each band has its own out-and-back pass, so size its waypoint budget at
    // that pass's applied speed rather than borrowing speed from the other band.
    const budgetFt=Math.min(totalDurH/2*safePassSpeed*5280*0.8,3.0*5280);
    const pts=walkContourForWaypoints(band.depthMin,band.depthMax,rampLat,rampLon,maxDistFt,budgetFt,STEP_FT);
    if (!pts.length) { console.warn(`[scout] Ph${band.phase}: no waypoints for ${band.depthMin}-${band.depthMax}ft`); continue; }
    phaseWaypoints[band.phase]=pts.map(pt=>[pt.lat,pt.lon]);
    pts.forEach((pt,j)=>{
      state.DATA.waypoints.push({name:`Ph${band.phase}-${j+1}`,lat:pt.lat,lon:pt.lon,sym:'Fishing Area',scoutWaypoint:true,phase:band.phase,depth:pt.depth});
      totalAdded++;
    });
    console.log(`[scout] Ph${band.phase} (${band.depthMin}-${band.depthMax}ft): ${pts.length} waypoints`);
  }

  buildScoutRoutes(phaseWaypoints);
  renderAll();
  return totalAdded;
}

function buildScoutRoutes(phaseWaypoints) {
  if (!state.DATA.tracks) state.DATA.tracks=[];
  state.DATA.tracks=state.DATA.tracks.filter(t=>!t.scoutRoute);
  
  const amplitude = 20, wave = 500;
  const inboundOffset = 30; 

  function makeTrack(waypoints, name, offset = 0) {
    const out=[]; let totalDist=0;
    for (let i=0; i<waypoints.length-1; i++) {
      const p1=waypoints[i], p2=waypoints[i+1];
      const dlat=p2[0]-p1[0], dlon=p2[1]-p1[1];
      const latM=(p1[0]+p2[0])/2, cosLat=Math.cos(latM*Math.PI/180);
      const segFt=Math.sqrt((dlat*364000)**2+(dlon*364000*cosLat)**2);
      if (segFt<5) continue;
      const brng=Math.atan2(dlon*cosLat,dlat), perp=brng+Math.PI/2;
      const pLat=Math.cos(perp)/364000, pLon=Math.sin(perp)/(364000*cosLat);
      const steps=Math.max(2,Math.ceil(segFt/50));
      
      for (let s=(i===0?0:1); s<=steps; s++) {
        const t=s/steps, lat=p1[0]+dlat*t, lon=p1[1]+dlon*t;
        const d=totalDist+segFt*t;
        const swing = (amplitude * Math.sin(2*Math.PI*d/wave)) + offset;
        out.push([lat+swing*pLat,lon+swing*pLon]);
      }
      totalDist+=segFt;
    }
    return {name,pts:out,scoutRoute:true,smartPlan:true};
  }

  for (const [phNum,pts] of Object.entries(phaseWaypoints).sort()) {
    if (pts.length<2) continue;
    const out = makeTrack(pts, `Ph${phNum} Outbound`, 0);
    if (out.pts.length>=2) { state.DATA.tracks.push(out); console.log(`[scout-routes] Ph${phNum} Outbound: ${out.pts.length}pts`); }
    
    const inn = makeTrack([...pts].reverse(), `Ph${phNum} Inbound`, inboundOffset);
    if (inn.pts.length>=2) { state.DATA.tracks.push(inn); console.log(`[scout-routes] Ph${phNum} Inbound: ${inn.pts.length}pts`); }
  }
}

function isSmartPlanTrack(t) {
  const name=String(t?.name||'');
  return !!(t?.smartPlan||name.startsWith('Phase ')||name.startsWith('Connector:'));
}

function clearExistingSmartPlanTracks() {
  if (!state.DATA?.tracks?.length) return 0;
  const before=state.DATA.tracks.length;
  state.DATA.tracks=state.DATA.tracks.filter(t=>!isSmartPlanTrack(t));
  return before-state.DATA.tracks.length;
}

function readPlanInputs() {
  return {
    lakeName:   document.getElementById('planLake')?.value||'',
    dateStr:    document.getElementById('planDate')?.value||new Date().toISOString().slice(0,10),
    launchTime: document.getElementById('planLaunchTime')?.value||'6:00 AM',
    returnTime: document.getElementById('planReturnTime')?.value||'12:00 PM',
    waterTempF: parseFloat(document.getElementById('planWaterTemp')?.value)||null,
    speedMph:   parseFloat(document.getElementById('planSpeed')?.value)||2.0,
    species:    [...document.querySelectorAll('#planSpeciesChecks input:checked')].map(c=>c.value),
  };
}

export function applyStoredSmartPlanDepth() {
  const routes=window._smartPlanPhaseRoutes;
  if (!routes?.length) return;
  const p1=routes.find(r=>r.phase===1);
  if (!p1) return;
  const minEl=document.getElementById('rbDepthMin');
  const maxEl=document.getElementById('rbDepthMax');
  if (minEl) minEl.value=p1.depthMin;
  if (maxEl) maxEl.value=p1.depthMax;
}

// ── Main entry point ──────────────────────────────────────────────────────────
export async function runSmartPlan() {
  const {lakeName,dateStr,launchTime,returnTime,waterTempF,speedMph,species}=readPlanInputs();
  const outEl   =document.getElementById('planSmartPlanOutput');
  const statusEl=document.getElementById('smartPlanStatus');
  function setStatus(msg,ok){ if(statusEl){statusEl.textContent=msg;statusEl.style.color=ok?'var(--accent2)':'var(--warn)';} }

  if (!lakeName)       { setStatus('Select a lake first',false); return; }
  if (!species.length) { setStatus('Check at least one target species',false); return; }

  const date=new Date(dateStr+'T12:00:00');
  const sp=species[0];
  const regCheck=checkRegulations(lakeName,sp,date);
  if (!regCheck.legal) {
    setStatus(`⚠ ${sp} not legal: ${regCheck.reason?.slice(0,60)}`,false);
    if (outEl) outEl.value=`REGULATION BLOCK:\n${regCheck.reason}`;
    return;
  }

  setStatus('Asking Groq for fishing plan…',true);
  if (outEl) outEl.value='⏳ Loading inventory + building plan…';

  const season    =getSeason(date);
  const clarity   =document.getElementById('planClarity')?.value||'Clear';
  const rampName  =document.getElementById('planRamp')?.value||'unknown ramp';

  // ── Fetch full Open-Meteo forecast BEFORE reading planWeather (bug fix)
  // Ensures Groq prompt always has fresh wind/conditions even if Preview was never opened.
  let weatherStr = document.getElementById('planWeather')?.value || '';
  try {
    const lakeEntry = LAKE_DB[lakeName] || Object.values(LAKE_DB).find(e => lakeName.toLowerCase().includes((e.name||'').toLowerCase().split(',')[0]));
    if (lakeEntry && lakeEntry.center) {
      const [lat, lon] = lakeEntry.center;
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        `&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,windspeed_10m_max,winddirection_10m_dominant,precipitation_sum` +
        `&timezone=auto&start_date=${dateStr}&end_date=${dateStr}`;
      const res = await fetch(url, { signal: AbortSignal.timeout?.(4500) });
      if (res.ok) {
        const data = await res.json();
        if (data?.daily) {
          const D = data.daily;
          const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
          const windD = dirs[Math.round((D.winddirection_10m_dominant?.[0] || 0) / 22.5) % 16];
          const windMph = Math.round((D.windspeed_10m_max?.[0] || 0) * 0.621371);
          const precip = D.precipitation_sum?.[0] || 0;
          const weatherVal = `Wind ${windD} ${windMph} mph · Precip ${precip}mm`;
          const weatherEl = document.getElementById('planWeather');
          if (weatherEl) weatherEl.value = weatherVal;
          weatherStr = weatherVal;
        }
      }
    }
  } catch (_) { /* non-fatal: fall back to whatever is already in the field */ }

  // ── Universal DNR Ramp Lookup ───────────────────────────────────────────
  clearExistingSmartPlanTracks();
  window._smartPlanCommittedTracks=[];

  let rampLat=null, rampLon=null;
  const idx = getLoadedAccessIndex();
  const lakePoints = idx.byLake.get(lakeName) || [];
  
  const normN = v => String(v||'').toLowerCase().replace(/[_-]+/g,' ').replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim();
  const rampMatch = (a,b) => { const x=normN(a), y=normN(b); return !!x && !!y && (x===y || x.includes(y) || y.includes(x)); };
  
  const found = lakePoints.find(p => rampMatch(p.name, rampName)) || lakePoints[0];
  if (found) { rampLat = found.lat; rampLon = found.lon; }
  
  if (rampLat == null) {
    const opt = document.querySelector('#planRamp option:checked');
    if (opt && opt.dataset.lat) { rampLat = parseFloat(opt.dataset.lat); rampLon = parseFloat(opt.dataset.lon); }
  }
  if (rampLat == null) { rampLat = 34.0; rampLon = -81.0; }

  const phaseInfo = computePhases(launchTime, returnTime, dateStr, rampLat, rampLon);
  const sol       = phaseInfo.solunar;
  let rangeMiles= computeRangeMiles(speedMph);
  const inventoryNames = await getTrollableNames();
  const inventory = await getInventory();

  function hStr(h){
    const hh=Math.floor(((h%24)+24)%24),mm=String(Math.round((h%1)*60)).padStart(2,'0');
    return `${hh%12||12}:${mm} ${hh<12?'AM':'PM'}`;
  }

  const solunarStr=`Majors: ${hStr(sol.major1)}, ${hStr(sol.major2)} · Minors: ${hStr(sol.minor1)}, ${hStr(sol.minor2)}`;
  const totalDurH=phaseInfo.phases.length?(phaseInfo.phases[phaseInfo.phases.length-1].end-phaseInfo.phases[0].start):6;

  // ── Pull our local intel FIRST ───────────────────────────────────────
  const fishingContext = await buildFishingContext({
    species: sp, lakeName, season, clarity, waterTempF,
    speedMph: speedMph,
    dateStr, launchTime, rampLat, rampLon
  });
  
  const researchedSummary = fishingContext?.researchedSummary || null;
  const researchedTrolling = fishingContext?.researchedTrolling || null;
  const hasResearched = fishingContext?.hasResearchedProfile || false;
  const researchedMeta = fishingContext?.researchedProfile?.metadata || null;

  // ── Unified Groq Call (State-Agnostic Prompt + Guided Creativity) ─────
  // Token-optimized: only inject target species slice, not entire trolling intel map
  let researchedTrollingSlice = null;
  if (hasResearched && researchedTrolling) {
    // researchedTrolling structure: { "Striped Bass": {summer:{...}}, "Largemouth Bass": {...}, ... }
    // Extract only the target species + 1-2 additional common species to keep token low
    const targetKey = Object.keys(researchedTrolling).find(k => k.toLowerCase().includes(sp.toLowerCase().split(' ')[0]) || sp.toLowerCase().includes(k.toLowerCase().split(' ')[0]));
    if (targetKey) {
      researchedTrollingSlice = { [targetKey]: researchedTrolling[targetKey] };
    } else {
      // species not covered in researched profile — will fall back to generic, note it
      researchedTrollingSlice = { _note: `Research profile exists but does not contain ${sp}. Use generic species intel for ${sp}.`, availableSpecies: Object.keys(researchedTrolling).slice(0,6) };
    }
  }

  const researchedBlock = hasResearched && researchedMeta ? `
🧠 VERIFIED LAKE RESEARCH (v${researchedMeta.version||'?'} ${researchedMeta.status||''} ${fishingContext.researchedProfile?.confidence?.overall?.percent||'?'}% — prioritize for permanent facts, adapt for today's conditions):
Summary: ${String(researchedSummary||'').slice(0,350)}
${researchedTrollingSlice ? `Trolling (target species only ${sp}): ${JSON.stringify(researchedTrollingSlice, null, 0).slice(0,900)}` : ''}
Limnology: archetype=${String(fishingContext.researchedProfile?.archetype||'').slice(0,60)} trophic=${String(fishingContext.researchedProfile?.limnology?.trophicStatus||'')} thermocline=${fishingContext.researchedProfile?.limnology?.thermocline?.summerDepthFt ? `${fishingContext.researchedProfile.limnology.thermocline.summerDepthFt}ft (${fishingContext.researchedProfile.limnology.thermocline.strength||'unknown strength'})` : 'unknown'} anoxicBelow=${fishingContext.researchedProfile?.limnology?.oxygen?.anoxicBelowFt ? `${fishingContext.researchedProfile.limnology.oxygen.anoxicBelowFt}ft` : 'unknown'} clarity=${String(fishingContext.researchedProfile?.limnology?.waterClarity?.typical||'unknown')}${fishingContext.researchedProfile?.limnology?.waterClarity?.secchiFt ? ` secchi=${fishingContext.researchedProfile.limnology.waterClarity.secchiFt}ft` : ''} flow=${String(fishingContext.researchedProfile?.limnology?.flowCharacteristics||'').slice(0,120)||'none'}${fishingContext.researchedProfile?.limnology?.dailyFluctuationFt ? ` dailySwing=${fishingContext.researchedProfile.limnology.dailyFluctuationFt}ft` : ''}
Habitat key: ${String(fishingContext.researchedProfile?.habitat?.structuralElements ? Object.values(fishingContext.researchedProfile.habitat.structuralElements).join('; ').slice(0,200) : '').slice(0,200)}
Note: This profile is authoritative for permanent lake characteristics (type, structure, forage, thermocline). For dynamic species behavior, blend researched baseline with generic species intel and today's water temp/weather. If researched conflicts with generic, prefer researched for permanent facts, generic for dynamic.
` : '';


  // ── Pull species-intel-v2 data for this species + season ─────────────
  const v2sp = IntelV2?.SPECIES_BEHAVIOR_V2?.[sp];
  let speciesIntelBlock = '';
  if (v2sp) {
    const lakeKeyV2 = (IntelV2.resolveLakeKey
      ? (IntelV2.resolveLakeKey(lakeName, v2sp) || 'default_SC_reservoir')
      : (v2sp[lakeName] ? lakeName : 'default_SC_reservoir'));
    const sNode = v2sp[lakeKeyV2]?.[season] || v2sp['default_SC_reservoir']?.[season];
    if (sNode) {
      const depthRange = typeof sNode.preferredDepth === 'function'
        ? sNode.preferredDepth(waterTempF) : (sNode.preferredDepth || [5, 20]);
      const speedRange = Array.isArray(sNode.preferredSpeed)
        ? sNode.preferredSpeed : [sNode.preferredSpeed || 1.8, sNode.preferredSpeed || 1.8];
      const notes = Array.isArray(sNode.notes) ? sNode.notes.join(' · ') : (sNode.notes || '');
      speciesIntelBlock = `
SPECIES INTEL — ${sp} in ${season} on ${lakeName} (use this as your primary depth/speed/structure baseline):
- Preferred depth range: ${depthRange[0]}–${depthRange[1]}ft
- Preferred trolling speed: ${speedRange[0]}–${speedRange[1]} mph
- Key structure: ${(sNode.preferredStructure || []).join(', ') || 'general structure'}
- Presentations: ${(sNode.preferredPresentation || []).join(', ') || 'general trolling'}
- Lure families: ${(sNode.lureFamilies || []).join(', ') || 'see tackle list'}
- Colors: ${(sNode.preferredColors || []).join(', ') || 'match forage'}
${notes ? `- Notes: ${notes}` : ''}

Use this as your baseline. Today's conditions — water temp, clarity, wind, and solunar — should drive your final depth and speed decisions within this general range. You may adjust outside it if conditions strongly support doing so.`;
    }
  }

  // ── Catch history context ─────────────────────────────────────────────
  const catchSummary = fishingContext?.catchSummary;
  let catchBlock = '';
  if (catchSummary && catchSummary.totalCatches > 0) {
    catchBlock = `
ANGLER CATCH HISTORY — ${sp} on ${lakeName} (${catchSummary.totalCatches} catches logged):
- Average catch depth: ${catchSummary.avgDepthFt != null ? catchSummary.avgDepthFt + 'ft' : 'unknown'}
- Best time of day: ${catchSummary.bestTime || 'unknown'}
- Top lures: ${catchSummary.topLures.map(l => `${l.lure} (${l.count}x)`).join(', ') || 'none logged'}`;
  }

  // ── Unified Groq Call (Species-Driven Prompt) ─────────────────────────
  const planPrompt=`You are an expert fishing guide for ${lakeName}.
Build a trolling plan for today targeting ${sp}.

TRIP & CONDITIONS:
- Date: ${dateStr}
- Launch: ${hStr(phaseInfo.phases[0]?.start||6)} from ${rampName}
- Return: ${hStr(phaseInfo.phases[phaseInfo.phases.length-1]?.end||12)}
- Duration: ${totalDurH.toFixed(1)} hours on water
- Season: ${season}
- Weather/Wind Forecast: ${weatherStr || 'Unknown'}
- Water temp: ${waterTempF?waterTempF+'°F':'unknown'}
- Clarity: ${clarity}
- Solunar majors: ${hStr(sol.major1)}, ${hStr(sol.major2)}

SAFETY & RAMP EVALUATION (GO / NO-GO):
You must evaluate the weather and wind forecast against the platform (12.5ft Kayak). 
- Sustained winds > 15mph or gusts > 20mph are NO-GO conditions for a kayak.
- Evaluate the launch ramp (${rampName}) against the wind direction. Will it be a dangerous windward launch?
- If conditions are unsafe, set "isGo" to false and explain why in "safetyWarning".
${speciesIntelBlock}
${catchBlock}

${researchedBlock}

YOUR ROLE:
You are the expert guide on the water *today*. The SPECIES INTEL above is your starting point — use it to understand where this species generally holds in this season, then make your own call based on today's actual conditions. A good guide doesn't just read a data sheet; he reads the water.

PLATFORM CONSTRAINTS (STRICT - DO NOT BREAK THESE):
- Kayak (Native Watersports Slayer Propel Max 12.5, pedal drive + electric motor)
- 2 rods max in water simultaneously (port + starboard)
- No live bait, no downriggers, no planer boards, spinning rods only

AVAILABLE TACKLE — use ONLY these exact names, no others:
${inventoryNames.join(', ')}

TROLLING-SPEED LIMITS (HARD): Every tackle name above includes its physical trolling-speed range in brackets. Pick a separate speed for each band. Band 1's speed applies to BOTH its outbound and inbound pass; Band 2's speed applies to BOTH its outbound and inbound pass. A band's speed must never exceed the lower maximum speed of its selected port and starboard lures. The two bands may use different speeds.

ROUTE STRUCTURE: Pick two depth bands that reflect where ${sp} actually hold during ${season}. Do not default to a shallow-then-deep morning pattern unless the species intel supports it.

Return ONLY valid JSON, no markdown:
{
  "isGo": <boolean>,
  "safetyWarning": "<If isGo is false, explain the hazard. If true, write 'Conditions look safe for a kayak.'>",
  "rampEvaluation": "<One sentence evaluating the wind exposure for the selected boat ramp>",
  "speed": <legacy fallback mph; set this equal to band1.speed>,
  "speedRationale": "<one sentence covering the two pass speeds>",
  "band1": {
    "depthMin": <ft>, "depthMax": <ft>, "speed": <mph>,
    "speedRationale": "<why this pass speed fits both selected lures>",
    "port": "<exact inventory name>", "starboard": "<exact inventory name>",
    "portColor": "<color>", "starboardColor": "<color>",
    "portLeadFt": <ft>, "starboardLeadFt": <ft>,
    "why": "<one sentence species behavior>"
  },
  "band2": {
    "depthMin": <ft>, "depthMax": <ft>, "speed": <mph>,
    "speedRationale": "<why this pass speed fits both selected lures>",
    "port": "<exact inventory name>", "starboard": "<exact inventory name>",
    "portColor": "<color>", "starboardColor": "<color>",
    "portLeadFt": <ft>, "starboardLeadFt": <ft>,
    "why": "<one sentence species behavior>"
  },
  "structureFocus": "<fishfinder signature to find>",
  "adjustmentTip": "<if no bites after 30min, do this>",
  "scoutNotes": "<2-3 sentence tactical overview>",
  "fishfinderNarrative": "<A short 150-word narrative telling the angler what to look for on the sonar screen during these routes, and how to work the specific lures rigged.>"
}`;

  let groqPlan=null;
  let rawGroqText = '';
  let isFallback = false;
  let llmProviderInfo = null;

  try {
    if (outEl) outEl.value='⏳ Calling Groq (/groq-query)… [openai/gpt-oss-120b → fallback chain]';
    const res=await fetch(`${CF_WORKER_URL}/groq-query`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        messages:[
          {role:'system',content:'You are TrollMap Smart Plan. Return only one valid JSON object and no markdown.'},
          {role:'user',content:planPrompt}
        ],
        max_tokens:3000,
        temperature:0.25,
        response_format:{type:'json_object'}
      }),
    });

    rawGroqText = await res.text();
    const provHeader = res.headers.get('X-LLM-Provider');
    const modelHeader = res.headers.get('X-LLM-Model');
    if (provHeader) {
      llmProviderInfo = `${provHeader}/${modelHeader}`;
      console.log(`[smart-plan] LLM provider: ${llmProviderInfo}`);
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${rawGroqText.slice(0,400)}`);
    }

    const data = JSON.parse(rawGroqText);
    if (data._trollmap) {
      llmProviderInfo = `${data._trollmap.provider}/${data._trollmap.model}`;
      console.log(`[smart-plan] LLM resolved to ${llmProviderInfo}`);
    }
    const rawContent = data.choices?.[0]?.message?.content;
    const content = (Array.isArray(rawContent)
      ? rawContent.map(part => (typeof part === 'string' ? part : (part?.text || part?.content || ''))).join('')
      : (rawContent || data.output_text || '')).trim();

    if (!content) {
      const finish = data.choices?.[0]?.finish_reason;
      throw new Error(`LLM returned empty content${finish ? ` (finish_reason=${finish})` : ''}`);
    }

    const clean = content.replace(/```json|```/g,'').trim();
    const si = clean.indexOf('{'), ei = clean.lastIndexOf('}');

    if (si === -1 || ei === -1) throw new Error(`No JSON object in response: ${clean.slice(0,200)}`);

    groqPlan = JSON.parse(clean.slice(si, ei+1));
    console.log(`[smart-plan] ✓ Groq plan parsed via ${llmProviderInfo || 'unknown provider'}`);

  } catch(e) {
    console.error('[smart-plan] Groq Error:', e.message, e.stack || '');
    isFallback = true;
    
    const phaseRecs=phaseInfo.phases.map(p=>getPhaseRecommendation(sp,lakeName,season,p.num,waterTempF));
    const r1=phaseRecs[0]||{depthMin:12,depthMax:18,speed:1.8};
    const r2=phaseRecs[1]||{depthMin:22,depthMax:28,speed:1.8};
    
    const fallPort1  = depthFallbackLure(r1.depthMin + 2, inventoryNames);
    const fallStbd1  = depthFallbackLure(r1.depthMax - 2, inventoryNames);
    const fallPort2  = depthFallbackLure(r2.depthMin + 2, inventoryNames);
    const fallStbd2  = depthFallbackLure(r2.depthMax - 2, inventoryNames);
    
    groqPlan={
      isGo: true,
      safetyWarning: `Groq API Failed (${e.message}). Proceed with caution.`,
      rampEvaluation: "Could not evaluate wind exposure due to API failure.",
      speed:r1.speed||1.8, speedRationale:'Species-intel fallback — Groq unavailable',
      band1:{depthMin:r1.depthMin,depthMax:r1.depthMax,speed:r1.speed||1.8,speedRationale:'Species-intel fallback speed for Band 1',port:fallPort1,starboard:fallStbd1,portColor:'Natural',starboardColor:'Metallic',portLeadFt:40,starboardLeadFt:50,why:'Fallback: mid-depth morning run'},
      band2:{depthMin:r2.depthMin,depthMax:r2.depthMax,speed:r2.speed||1.8,speedRationale:'Species-intel fallback speed for Band 2',port:fallPort2,starboard:fallStbd2,portColor:'Natural',starboardColor:'Natural',portLeadFt:50,starboardLeadFt:60,why:'Fallback: deep mid-morning run'},
      structureFocus:'Look for baitfish marks suspended over channel edges on the fishfinder.',
      adjustmentTip:'Shorten lead 10ft and slow to 1.5mph if no bites.',
      scoutNotes:`Groq API Failed (${e.message}). Running Fallback Plan.`,
      fishfinderNarrative: `⚠ Groq Narrative Failed. Fallback: Look for baitfish marks suspended over drop-offs.`
    };
  }

  // ── Safety Abort ────────────────────────────────────────────────────────
  if (groqPlan.isGo === false) {
    setStatus(`🚨 NO-GO: Unsafe Conditions for Kayak`, false);
    const abortMessage = `🚨 ABORT TRIP 🚨\n\nAI Guide Evaluation:\n${groqPlan.safetyWarning}\n\nRamp Evaluation:\n${groqPlan.rampEvaluation}\n\nDo not launch the kayak in these conditions.`;
    
    renderSmartPlanUI({
      routeRods: {},
      scoutReport: `${abortMessage}\n\n── RAW JSON OUTPUT ──\n${JSON.stringify(groqPlan, null, 2)}`,
      speedMph: 0,
      phases: [],
      solunar: solunarStr
    });
    return;
  }

  const b1mid=(groqPlan.band1.depthMin+groqPlan.band1.depthMax)/2;
  const b2mid=(groqPlan.band2.depthMin+groqPlan.band2.depthMax)/2;
  groqPlan.band1.port      =sanitizeGroqLureName(groqPlan.band1.port,      b1mid-2, inventoryNames);
  groqPlan.band1.starboard =sanitizeGroqLureName(groqPlan.band1.starboard,  b1mid+2, inventoryNames);
  groqPlan.band2.port      =sanitizeGroqLureName(groqPlan.band2.port,      b2mid-2, inventoryNames);
  groqPlan.band2.starboard =sanitizeGroqLureName(groqPlan.band2.starboard,  b2mid+2, inventoryNames);

  // Speed is guarded per pass, not across all four lures. Each band keeps its
  // own speed for its outbound + inbound run, capped only by the two lures
  // actually in the water during that run.
  const band1SpeedGuard = capPassSpeed(
    groqPlan.band1?.speed ?? groqPlan.speed,
    [groqPlan.band1.port, groqPlan.band1.starboard],
    inventory,
  );
  const band2SpeedGuard = capPassSpeed(
    groqPlan.band2?.speed ?? groqPlan.speed,
    [groqPlan.band2.port, groqPlan.band2.starboard],
    inventory,
  );
  const band1Speed = band1SpeedGuard.appliedMph;
  const band2Speed = band2SpeedGuard.appliedMph;
  const passSpeedGuards = [
    { label: 'Band 1', guard: band1SpeedGuard },
    { label: 'Band 2', guard: band2SpeedGuard },
  ];
  const speedCapNotes = passSpeedGuards.filter(({ guard }) => guard.wasCapped).map(({ label, guard }) => {
    const limitingNames = [...new Set(guard.limitingLures.map((lure) => lure.name))].join(' + ');
    console.warn(
      `[smart-plan] ${label} speed override: Groq requested ${guard.requestedMph} mph; ` +
      `${limitingNames} limits this pass to ${guard.maxMph} mph.`,
    );
    return `⚠ ${label} speed capped at ${guard.appliedMph} mph (Groq requested ${guard.requestedMph} mph; ${limitingNames} max ${guard.maxMph} mph).`;
  });

  // Keep the normalized speeds on the plan so every downstream consumer uses
  // the applied, lure-safe value. Root speed remains a Band 1 legacy fallback.
  groqPlan.band1.speed = band1Speed;
  groqPlan.band2.speed = band2Speed;
  groqPlan.speed = band1Speed;
  const routeSpeeds = {
    'Ph1 Outbound': band1Speed,
    'Ph1 Inbound': band1Speed,
    'Ph2 Outbound': band2Speed,
    'Ph2 Inbound': band2Speed,
  };
  const speedEl = document.getElementById('planSpeed');
  // #planSpeed is retained for older saved-plan consumers; phase speeds below
  // are the source of truth for this Smart Plan.
  if (speedEl) speedEl.value = String(band1Speed);
  rangeMiles = computeRangeMiles(Math.max(band1Speed, band2Speed));

  // ── Build rod rows ────────────────────────────────────────────────────────
  function buildRodFromGroq(lureName,colorName,depthFt,slotIdx,phaseLabel,bandSpeedMph) {
    // Strip annotation bracket in case it leaked through sanitizer
    const cleanLureName = stripLureAnnotation(lureName);
    const bareNames = inventoryNames.map(n => stripLureAnnotation(n));
    const finalLure = bareNames.includes(cleanLureName)
      ? cleanLureName
      : (inventoryNames.map(n => stripLureAnnotation(n)).find(n => n === cleanLureName) || bareNames[0]);
    const reel=reelForLure(finalLure);
    const rod={
      side:slotIdx===0?'Port':'Starboard', position:'Mid',
      rod:"7' M Mod-Fast Spinning (Ugly Stik Lite Pro)", reel,
      lure:finalLure, color:colorName||getLureColor(finalLure,clarity.toLowerCase().includes('mud')?'muddy':clarity.toLowerCase().includes('stain')?'stained':'clear'),
      depth:String(depthFt), lead:'0', notes:phaseLabel,
      trailerSize:'', arigWeight:'', jigWeight:'',
    };
    if (finalLure?.toLowerCase().includes('a-rig')) {
      const isLight=finalLure.includes('Light')||finalLure.includes('1.65');
      const isMedium=finalLure.includes('Medium')||finalLure.includes('2.65');
      rod.arigWeight =isLight?'~1.65oz (5-wire light)':isMedium?'~2.65oz (5-wire medium)':'~3.5oz (5-wire heavy)';
      rod.trailerSize=isLight?'3.8" swimbait':isMedium?'4.6" swimbait':'5" swimbait';
      rod.jigWeight  =isLight?'1/8oz × 5':isMedium?'3/16oz × 5':'1/4oz × 5';
    }
    // Always use physics-based lead — ignore Groq's lead suggestion
    let calcLead = autoCalculateLead(rod, bandSpeedMph || band1Speed);
    // Cap variable-depth lures (A-rigs, spoons, swimbaits etc) at 80ft on a kayak
    const lureL = (rod.lure||'').toLowerCase();
    // Variable-depth lures: A-rigs, spoons, swimbaits, spinnerbaits etc.
    // These are depth-controlled by lead length — cap at 80ft on a kayak.
    const isVarDepth = lureL.includes('a-rig') || lureL.includes('swimbait') ||
      lureL.includes('spoon') || lureL.includes('spinnerbait') ||
      lureL.includes('chatterbait') || lureL.includes('bucktail') ||
      lureL.includes('marabou') || lureL.includes('jighead') ||
      lureL.includes('road runner');
    if (isVarDepth && calcLead > 80) calcLead = 80;
    // Crankbaits have a physical dive curve — long lead doesn't make them go deeper,
    // it just puts them farther back. Cap at 100ft on a kayak (realistic maximum).
    const isCrankbait = lureL.includes('crankbait') || lureL.includes('lipless') ||
      lureL.includes('blade vibe');
    if (isCrankbait && calcLead > 100) calcLead = 100;
    rod.lead = String(calcLead);
    return rod;
  }

  const routeRods = {
    'Ph1 Outbound': [
      buildRodFromGroq(groqPlan.band1.port,      groqPlan.band1.portColor,  b1mid-2, 0, 'Ph1 Out', band1Speed),
      buildRodFromGroq(groqPlan.band1.starboard,  groqPlan.band1.starboardColor, b1mid+2, 1, 'Ph1 Out', band1Speed),
    ],
    'Ph1 Inbound': [
      buildRodFromGroq(groqPlan.band1.port,      groqPlan.band1.portColor,  b1mid-2, 0, 'Ph1 In',  band1Speed),
      buildRodFromGroq(groqPlan.band1.starboard,  groqPlan.band1.starboardColor, b1mid+2, 1, 'Ph1 In',  band1Speed),
    ],
    'Ph2 Outbound': [
      buildRodFromGroq(groqPlan.band2.port,      groqPlan.band2.portColor,  b2mid-2, 0, 'Ph2 Out', band2Speed),
      buildRodFromGroq(groqPlan.band2.starboard,  groqPlan.band2.starboardColor, b2mid+2, 1, 'Ph2 Out', band2Speed),
    ],
    'Ph2 Inbound': [
      buildRodFromGroq(groqPlan.band2.port,      groqPlan.band2.portColor,  b2mid-2, 0, 'Ph2 In',  band2Speed),
      buildRodFromGroq(groqPlan.band2.starboard,  groqPlan.band2.starboardColor, b2mid+2, 1, 'Ph2 In',  band2Speed),
    ],
  };

  // ── Generate waypoints ────────────────────────────────────────────────────
  setStatus('Building contour waypoints…',true);
  const totalWaypoints=await generateScoutWaypoints(
    phaseInfo.phases,
    [{depthMin:groqPlan.band1.depthMin,depthMax:groqPlan.band1.depthMax},{depthMin:groqPlan.band2.depthMin,depthMax:groqPlan.band2.depthMax}],
    rampLat,rampLon,rangeMiles,[band1Speed, band2Speed],phaseInfo
  );

  // Expose phase timing for notifications module
  if (phaseInfo?.phases?.length) {
    window._trollmapPhases = phaseInfo.phases.map(p => ({ startH: p.start, endH: p.end, num: p.num }));
    if (window.trollmapLoadPhaseNotifications) window.trollmapLoadPhaseNotifications(phaseInfo.phases);
  }
  window._smartPlanPhaseRoutes = [
    { phase:1, phaseName:'Shallow', depthMin:groqPlan.band1.depthMin, depthMax:groqPlan.band1.depthMax, speed:band1Speed, window:'Band 1' },
    { phase:2, phaseName:'Deep',    depthMin:groqPlan.band2.depthMin, depthMax:groqPlan.band2.depthMax, speed:band2Speed, window:'Band 2' },
  ];
  applyStoredSmartPlanDepth();
  // Populate targetDepth display field from band depths
  const targetDepthEl = document.getElementById('planTargetDepth');
  if (targetDepthEl) {
    targetDepthEl.value = `${groqPlan.band1.depthMin}-${groqPlan.band1.depthMax}ft / ${groqPlan.band2.depthMin}-${groqPlan.band2.depthMax}ft`;
  }
  syncSpread(null,routeRods,routeSpeeds);
  window._smartPlanRouteRods=routeRods;

  // ── Build route-aware casting stop candidates ───────────────────────────
  // Only structures that lie within STOP_RADIUS_FT of the actual route
  // tracks are included. Each stop carries phase + approximate elapsed
  // time so the coach knows WHEN and WHERE to tell the angler to pause.
  const STOP_RADIUS_FT = 250; // how close to the route a structure must be
  const stopCandidates = [];
  const addedCoords = []; // dedup by proximity

  // Haversine distance in feet
  function distFt(lat1, lon1, lat2, lon2) {
    const R = 3958.8 * 5280;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 +
      Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  // For a given lat/lon, find the closest point on any smart plan track.
  // Returns { distFt, trackName, ptIdx, progressPct } or null.
  function nearestRoutePoint(lat, lon) {
    const tracks = (state.DATA?.tracks || []).filter(t => t.smartPlan);
    let best = null;
    for (const track of tracks) {
      const pts = track.pts || [];
      for (let i = 0; i < pts.length; i++) {
        const d = distFt(lat, lon, pts[i][0], pts[i][1]);
        if (!best || d < best.distFt) {
          best = { distFt: d, trackName: track.name, ptIdx: i, progressPct: Math.round(i / pts.length * 100) };
        }
      }
    }
    return best;
  }

  // Estimate elapsed time at a route point given track speed
  function etaMinutes(trackName, progressPct, rangeMiles, phaseSpeeds) {
    const speed = trackName?.includes('Ph2') ? (phaseSpeeds?.band2 || 2) : (phaseSpeeds?.band1 || 1.8);
    const trackMiles = rangeMiles / 4; // 4 tracks total
    const elapsedMiles = trackMiles * progressPct / 100;
    return Math.round(elapsedMiles / speed * 60);
  }

  function tryAddStop(candidate) {
    if (!candidate.lat || !candidate.lon) {
      // No coords — research profile structural notes, include without route filter
      // but cap at 2 of these since they have no spatial grounding
      const ungrounded = stopCandidates.filter(s => !s.lat);
      if (ungrounded.length >= 2) return;
      stopCandidates.push(candidate);
      return;
    }
    // Dedup — skip if we already have a stop within 300ft of this one
    if (addedCoords.some(c => distFt(candidate.lat, candidate.lon, c.lat, c.lon) < 300)) return;
    // Route proximity check
    const nearest = nearestRoutePoint(candidate.lat, candidate.lon);
    if (!nearest || nearest.distFt > STOP_RADIUS_FT) return;
    // Enrich with route context
    candidate.routeContext = {
      trackName: nearest.trackName,
      distFromRouteFt: Math.round(nearest.distFt),
      progressPct: nearest.progressPct,
      etaMin: etaMinutes(nearest.trackName, nearest.progressPct, rangeMiles, { band1: band1Speed, band2: band2Speed }),
    };
    addedCoords.push({ lat: candidate.lat, lon: candidate.lon });
    stopCandidates.push(candidate);
  }

  try {
    const researchedProfile = fishingContext?.researchedProfile;
    const habitat = researchedProfile?.habitat || {};
    const biology = researchedProfile?.biology || {};
    const season = fishingContext?.season || getSeason(new Date());

    // ── 1. Supplemental attractors — GPS-grounded, highest priority ──
    if (rampLat && rampLon && window.getSupplementalContext) {
      try {
        // Search the full route extent, not just the ramp
        const routeTracks = (state.DATA?.tracks || []).filter(t => t.smartPlan);
        const allPts = routeTracks.flatMap(t => t.pts || []);
        // Compute route bounding box center for a broader search
        if (allPts.length) {
          const lats = allPts.map(p => p[0]);
          const lons = allPts.map(p => p[1]);
          const cLat = (Math.min(...lats) + Math.max(...lats)) / 2;
          const cLon = (Math.min(...lons) + Math.max(...lons)) / 2;
          const radiusMi = Math.max(1.0,
            distFt(Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)) / 5280 / 2
          );
          const ctx = window.getSupplementalContext(cLat, cLon, radiusMi);
          for (const a of (ctx.attractors || [])) {
            if (!a.lat || !a.lon) continue;
            tryAddStop({
              type: 'fish_attractor',
              name: a.name || 'Fish Attractor',
              lat: a.lat, lon: a.lon,
              score: 9,
              reason: 'Mapped fish attractor on or near route — confirmed brush pile / structure',
              structureType: 'artificial attractor',
            });
          }
          for (const sp of (ctx.fishingPoints || [])) {
            if (!sp.lat || !sp.lon) continue;
            tryAddStop({
              type: 'community_spot',
              name: sp.name || 'Community Fishing Spot',
              lat: sp.lat, lon: sp.lon,
              score: 6,
              reason: 'Community-marked fishing location on or near route',
              structureType: 'community spot',
            });
          }
        }
      } catch (_) {}
    }

    // ── 2. My Structures (QuickDraw pins) — GPS-grounded ──
    if (window.getMyStructures) {
      try {
        for (const s of window.getMyStructures()) {
          if (!s.lat || !s.lon) continue;
          tryAddStop({
            type: s.type || 'custom_pin',
            name: s.name || 'My Structure',
            lat: s.lat, lon: s.lon,
            score: Math.min(10, (s.quality || 5) + 2),
            reason: `Angler-marked structure (quality ${s.quality || '?'}/10)`,
            structureType: s.type || 'custom',
          });
        }
      } catch (_) {}
    }

    // ── 3. Contour-derived humps and ledges — GPS-grounded from geospatial adapter ──
    const structuralElements = researchedProfile?.habitat?.structuralElements || {};
    for (const hump of (structuralElements.humpCoordinates || [])) {
      if (!hump.lat || !hump.lon) continue;
      tryAddStop({
        type: 'hump',
        name: `Offshore Hump ${hump.id?.replace('hump_', '#') || ''}${hump.areaAcres ? ` (~${hump.areaAcres}ac)` : ''}`,
        lat: hump.lat, lon: hump.lon,
        score: 8,
        reason: `Closed contour loop — offshore high spot${hump.depth ? ` at ~${hump.depth}ft` : ''}. Stripers and suspended fish stage over humps in summer.`,
        structureType: 'offshore hump',
      });
    }
    for (const ledge of (structuralElements.ledgeCoordinates || [])) {
      if (!ledge.lat || !ledge.lon) continue;
      tryAddStop({
        type: 'ledge',
        name: `Depth Ledge / Drop-off ${ledge.id?.replace('ledge_', '#') || ''}`,
        lat: ledge.lat, lon: ledge.lon,
        score: 7,
        reason: `High contour density (${ledge.contourDensity} contours) — active depth break. Fish transition through here as conditions change.`,
        structureType: 'channel ledge / drop-off',
      });
    }

    // ── 4. Research profile structural notes — ungrounded, max 2 ──
    const attractorCount = habitat.artificialHabitatDetails?.attractorCount;
    if (attractorCount > 0) {
      tryAddStop({
        type: 'fish_attractor',
        name: `${attractorCount} Mapped Fish Attractors (lake-wide)`,
        score: 7,
        reason: `${attractorCount} official attractors on this lake — watch sonar for brushpile signatures`,
        structureType: 'artificial attractor',
      });
    }
    const spawnTiming = biology.spawnTiming || {};
    const targetSpawn = spawnTiming[sp] || spawnTiming[Object.keys(spawnTiming).find(k => k.toLowerCase().includes((sp||'').toLowerCase().split(' ')[0])) || ''];
    if (targetSpawn && (season === 'spring' || season === 'winter')) {
      tryAddStop({
        type: 'spawn_flat',
        name: 'Spawning Flats / Coves',
        score: 8,
        reason: `${sp} spawn timing: ${targetSpawn} — shallow coves and flats are primary targets this season`,
        structureType: 'shallow flat / spawning area',
      });
    }

    stopCandidates.sort((a, b) => b.score - a.score);
    stopCandidates.splice(8);

  } catch (stopErr) {
    console.warn('[smart-plan] Stop candidate build failed:', stopErr.message);
  }

  // Build the Hybrid Report: Beautiful readable text on top, raw JSON on bottom
  const b1p=routeRods['Ph1 Outbound'][0], b1s=routeRods['Ph1 Outbound'][1];
  const b2p=routeRods['Ph2 Outbound'][0], b2s=routeRods['Ph2 Outbound'][1];

  const scoutText=[
    `════════ TACTICAL OVERVIEW ════════`,
    llmProviderInfo ? `LLM: ${llmProviderInfo}${isFallback ? ' (FALLBACK)' : ''}` : (isFallback ? 'LLM: fallback (Groq unavailable)' : ''),
    groqPlan.scoutNotes||'',
    `Pass speeds: Band 1 outbound + inbound ${band1Speed} mph · Band 2 outbound + inbound ${band2Speed} mph.`,
    ...speedCapNotes,
    '',
    `════════ SAFETY & RAMP ════════`,
    groqPlan.safetyWarning,
    groqPlan.rampEvaluation,
    '',
    `════════ BAND 1 — ${groqPlan.band1.depthMin}-${groqPlan.band1.depthMax}ft ════════`,
    `Why: ${groqPlan.band1.why}`,
    `Pass speed: ${band1Speed} mph (outbound + inbound)`,
    `Port: ${b1p.lure} (${b1p.color}) — Lead: ${b1p.lead}ft`,
    `Stbd: ${b1s.lure} (${b1s.color}) — Lead: ${b1s.lead}ft`,
    '',
    `════════ BAND 2 — ${groqPlan.band2.depthMin}-${groqPlan.band2.depthMax}ft ════════`,
    `Why: ${groqPlan.band2.why}`,
    `Pass speed: ${band2Speed} mph (outbound + inbound)`,
    `Port: ${b2p.lure} (${b2p.color}) — Lead: ${b2p.lead}ft`,
    `Stbd: ${b2s.lure} (${b2s.color}) — Lead: ${b2s.lead}ft`,
    '',
    `════════ FISHFINDER GUIDE ════════`,
    `Target: ${groqPlan.structureFocus||''}`,
    groqPlan.fishfinderNarrative ? '\n'+groqPlan.fishfinderNarrative : '',
    '',
    `💡 Tip: ${groqPlan.adjustmentTip||''}`,
    '',
    `════════ RAW JSON DEBUG ════════`,
    rawGroqText || JSON.stringify(groqPlan, null, 2)
  ].filter(l=>l!==null&&l!==undefined).join('\n');

  // Write completed plan to textarea + store for plan-builder.js
  if (outEl) outEl.value = scoutText;
  window._smartPlanRationale = scoutText;

  renderSmartPlanUI({
    routeRods,
    scoutReport: scoutText,
    speedMph: band1Speed,
    routeSpeeds,
    phases: phaseInfo.phases,
    solunar: solunarStr,
    stopCandidates,
  });

  // ── Intel displays ────────────────────────────────────────────────────────
  const intelSection=document.getElementById('planIntelSection');
  if (intelSection) intelSection.style.display='block';
  const solunarDisplay=document.getElementById('planSolunarDisplay');
  if (solunarDisplay) solunarDisplay.textContent=solunarStr;
  // Store solunar for plan-builder.js to read when saving the plan
  window._smartPlanSolunar = solunarStr;
  // Also write to the hidden solunar meta field if it exists
  const solunarMetaEl = document.getElementById('planSolunar');
  if (solunarMetaEl) solunarMetaEl.value = solunarStr;
  const lakeIntelVal=document.getElementById('planLakeIntel')?.value||'';
  const lakeIntelDisplay=document.getElementById('planLakeIntelDisplay');
  if (lakeIntelDisplay&&lakeIntelVal) lakeIntelDisplay.textContent=lakeIntelVal;
  const clarityIntelVal=document.getElementById('planClarityIntel')?.value||'';
  const clarityIntelDisplay=document.getElementById('planClarityIntelDisplay');
  if (clarityIntelDisplay&&clarityIntelVal) clarityIntelDisplay.textContent=clarityIntelVal;
  const safetyDisplay=document.getElementById('planSafetyDisplay');
  if (safetyDisplay) {
    safetyDisplay.innerHTML=['• File a float plan with someone onshore before launching.','• Kayak: Native Watersports Slayer Propel Max 12.5 — confirm bilge plug is in.','• Motor: NK180 Pro 24V — check battery level before launch.','• PFD on at all times. Phone in dry bag.','• Check weather before launch — conditions can change rapidly on open water.',`• Return time: ${document.getElementById('planReturnTime')?.value||'set return time'}`].map(s=>`<div style="margin-bottom:4px">${s}</div>`).join('');
  }

  // ── Groq Coach ────────────────────────────────────────────────────────────
  try {
    const coachSpread=Object.entries(routeRods).flatMap(([routeName,rods])=>
      rods.map(r=>({route:routeName,side:r.side,rod:r.rod||'',lure:r.lure||'',color:r.color||'',depth:r.depth||'',lead:r.lead||'',notes:(r.notes||'').slice(0,80)}))
    );

    // ADDED: speed and speedRationale passed explicitly into planState
    const coachPayload=buildGroqCoachPayload(fishingContext,{
      phases:phaseInfo.phases,
      phaseRecs:[
        {depthMin:groqPlan.band1.depthMin,depthMax:groqPlan.band1.depthMax,speed:band1Speed,lures:[groqPlan.band1.port,groqPlan.band1.starboard],notes:groqPlan.band1.why},
        {depthMin:groqPlan.band2.depthMin,depthMax:groqPlan.band2.depthMax,speed:band2Speed,lures:[groqPlan.band2.port,groqPlan.band2.starboard],notes:groqPlan.band2.why},
      ],
      spread:coachSpread, solunarStr,
      speed: band1Speed,
      phaseSpeeds: { band1: band1Speed, band2: band2Speed },
      speedRationale: groqPlan.speedRationale,
      poolLevel:document.getElementById('planPoolLevel')?.value||null,
      weather:weatherStr, rationale: "Raw JSON dump sent", rampName:rampName||'', rangeMiles,
      stopCandidates: stopCandidates.length > 0 ? stopCandidates : undefined,
    });
    startCoachSession(coachPayload);
  } catch(e){console.warn('[smart-plan] Coach session failed:',e.message);}

  const wayptMsg=totalWaypoints>0
    ? (isFallback
        ? `⚠ Fallback plan — ${totalWaypoints} waypoints; Band1 ${band1Speed}mph, Band2 ${band2Speed}mph (Groq down, using local intel)`
        : `✓ Plan built via ${llmProviderInfo || 'Groq'} — ${totalWaypoints} waypoints; Band1 ${band1Speed}mph, Band2 ${band2Speed}mph, coach reviewing…`)
    : isFallback
      ? `⚠ Plan built with fallback logic but no contour data — load contours first.`
      : '⚠ No waypoints — load contour data first (Contour Data tab)';
  setStatus(wayptMsg,totalWaypoints>0 && !isFallback);

  // Reload notification session with fresh plan data
  if (window.trollmapReloadNotificationSession) window.trollmapReloadNotificationSession();
  return {groqPlan,phaseInfo,rangeMiles};
}

setTimeout(()=>{ document.getElementById('runSmartPlanBtn')?.addEventListener('click',runSmartPlan); },800);

window.runSmartPlan=runSmartPlan;
window.applyStoredSmartPlanDepth=applyStoredSmartPlanDepth;

console.log('[smart-plan] module ready — universal access + dynamic safety');