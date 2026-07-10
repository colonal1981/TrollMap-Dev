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
import {
  SPECIES_BEHAVIOR, getSeason, checkRegulations, resolveLakeKey,
} from '../data/species-intel.js';
import * as IntelV2 from '../data/species-intel-v2.js';
import { isLiveBaitAvailable } from '../data/fishing-style-profile.js';
import { buildFishingContext, buildGroqCoachPayload } from './smart-plan-context.js';
import { startCoachSession } from './groq-coach.js';
import { renderSmartPlanUI, syncSpread, reelForLure } from './smart-plan-ui.js';

const BATTERY_AH_DEFAULT = 100;
const MOTOR_AMP_AVG      = 6;
const PHASE_1_END_OFFSET_MIN = 60;
const PHASE_2_END_OFFSET_MIN = 210;

// ── Dynamic inventory name list (loaded from tackle-inventory.js at runtime) ──
let _cachedTrollableNames = null;

async function getTrollableNames() {
  if (_cachedTrollableNames) return _cachedTrollableNames;
  const inv = await getInventory();
  _cachedTrollableNames = inv.filter(l => l.trollable).map(l => l.name);
  return _cachedTrollableNames;
}

// ── Groq lure name sanitizer ──────────────────────────────────────────────────
function sanitizeGroqLureName(raw, targetDepthFt, inventoryNames) {
  if (!raw) return depthFallbackLure(targetDepthFt, inventoryNames);
  const r = String(raw).toLowerCase().trim();

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

function isStaticTechnique(rawLureName) {
  if (!rawLureName) return false;
  const s = rawLureName.toLowerCase();
  if (s.includes('topwater') || s.includes('buzz') || s.includes('plopper') || s.includes('spook')) return true;
  if (s.includes('free-line') || s.includes('downline') || s.includes('live') || s.includes('cut bait')) return true;
  if (s.includes('anchor') || s.includes('finesse') || s.includes('wacky') || s.includes('drop_shot')) return true;
  return false;
}

// ── Geo helpers ───────────────────────────────────────────────────────────────
function geoDistanceFt(lat1, lon1, lat2, lon2) {
  const R = 20902231, D = Math.PI / 180;
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Infinity;
  const p1=lat1*D, p2=lat2*D, dp=(lat2-lat1)*D, dl=(lon2-lon1)*D;
  const a = Math.sin(dp/2)**2 + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── Sunrise ───────────────────────────────────────────────────────────────────
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

// ── Solunar ───────────────────────────────────────────────────────────────────
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

const LAKE_CENTERS = {
  'Lake Wateree':    { lat: 34.37, lon: -80.73 },
  'Lake Murray':     { lat: 34.06, lon: -81.32 },
  'Lake Marion':     { lat: 33.55, lon: -80.30 },
  'Lake Moultrie':   { lat: 33.28, lon: -80.05 },
  'Lake Monticello': { lat: 34.44, lon: -81.21 },
  'Parr Reservoir':  { lat: 34.30, lon: -81.16 },
};

function getLakeCenter(lakeName) {
  const key = Object.keys(LAKE_CENTERS).find(k =>
    lakeName.toLowerCase().includes(k.toLowerCase().replace('lake ', ''))
  );
  return key ? LAKE_CENTERS[key] : { lat: 34.37, lon: -80.73 };
}

function computeRangeMiles(speedMph) {
  const spd = speedMph || 2.0;
  const bms = window.ACTIVE_BLE_BMS;
  if (bms?.connected && bms.remainingAh > 0 && bms.current > 0.1)
    return (bms.remainingAh / bms.current * spd) / 2;
  return (BATTERY_AH_DEFAULT / MOTOR_AMP_AVG * spd) / 2;
}

// ── Phase boundaries ──────────────────────────────────────────────────────────
function computePhases(launchTimeStr, returnTimeStr, dateStr, lakeName) {
  const center = getLakeCenter(lakeName);
  const sunriseH = computeSunrise(center.lat, center.lon, dateStr);
  const sol = computeSolunar(center.lat, center.lon, dateStr);

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

// ── Ramp evaluation ───────────────────────────────────────────────────────────
async function getRampEvaluation(lakeName, species, season, phaseRecs, weatherStr, roughWeather) {
  try {
    const { evaluateRamps, parseWindDeg } = await import('./ryan-ramps.js');
    const targetZones = [];
    phaseRecs.forEach(rec => {
      if (!rec) return;
      if (rec.depthMin < 18) targetZones.push('shallow_flats', 'clearwater_cove');
      else targetZones.push('channel_ledges', 'mid_channel');
    });
    const windDeg = parseWindDeg(weatherStr);
    const speedMph = parseFloat(document.getElementById('planSpeed')?.value) || 2.0;
    return evaluateRamps({
      lakeName, currentRampKey: document.getElementById('planRamp')?.value || '',
      targetZones: [...new Set(targetZones)], windDeg,
      rangeMiles: computeRangeMiles(speedMph), roughWeather,
    });
  } catch (_) { return null; }
}

function buildRampRationaleText(rampEval) {
  if (!rampEval) return '';
  const lines = ['', '── RAMP EVALUATION ──'];
  if (rampEval.recommended) lines.push(`Recommended: ${rampEval.recommended}`);
  if (rampEval.reason) lines.push(`Reason: ${rampEval.reason}`);
  if (rampEval.flags?.length) lines.push(...rampEval.flags.map(f => `⚠ ${f}`));
  return lines.join('\n');
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
      if (closest<=maxDistFt) allChains.push({chain,len,closest,depth});
    }
  }
  if (!allChains.length) return [];

  allChains.sort((a,b)=>(a.closest*2-a.len)-(b.closest*2-b.len));
  const best=allChains[0];
  console.log(`[scout] best chain: depth=${best.depth}ft len=${Math.round(best.len)}ft closest=${Math.round(best.closest)}ft`);

  let nearIdx=0, nearDist=Infinity;
  for (let i=0; i<best.chain.length; i++) {
    const d=geoDistanceFt(refLat,refLon,best.chain[i][0],best.chain[i][1]);
    if (d<nearDist) { nearDist=d; nearIdx=i; }
  }

  const walk = (start, dir) => {
    const pts=[{lat:best.chain[start][0],lon:best.chain[start][1],depth:best.depth}];
    let traveled=0, carry=0;
    for (let i=start+dir; dir>0?i<best.chain.length:i>=0; i+=dir) {
      const prev=best.chain[i-dir], curr=best.chain[i];
      const segFt=geoDistanceFt(prev[0],prev[1],curr[0],curr[1]);
      carry+=segFt; traveled+=segFt;
      if (traveled>=budgetFt) break;
      if (carry>=stepFt) { pts.push({lat:curr[0],lon:curr[1],depth:best.depth}); carry=0; }
    }
    return pts;
  };

  const fwd=walk(nearIdx,1), rev=walk(nearIdx,-1);
  return fwd.length>=rev.length ? fwd : rev;
}

async function generateScoutWaypoints(phases, bands, rampLat, rampLon, rangeMiles, speedMph=2.0, phaseInfo) {
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
  const budgetFt=Math.min(totalDurH/2*speedMph*5280*0.8,3.0*5280);
  const STEP_FT=150;

  bands=(bands||[]).map((b,i)=>({...b,phase:i+1}));
  let totalAdded=0;
  const phaseWaypoints={};

  for (const band of bands) {
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
    speedMph:   2.0,
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
  const phaseInfo =computePhases(launchTime,returnTime,dateStr,lakeName);
  const sol       =phaseInfo.solunar;
  const rangeMiles=computeRangeMiles(speedMph);
  const clarity   =document.getElementById('planClarity')?.value||'Clear';
  const rampName  =document.getElementById('planRamp')?.value||'unknown ramp';
  const weatherStr=document.getElementById('planWeather')?.value||'';

  const inventoryNames = await getTrollableNames();

  function hStr(h){
    const hh=Math.floor(((h%24)+24)%24),mm=String(Math.round((h%1)*60)).padStart(2,'0');
    return `${hh%12||12}:${mm} ${hh<12?'AM':'PM'}`;
  }

  const solunarStr=`Majors: ${hStr(sol.major1)}, ${hStr(sol.major2)} · Minors: ${hStr(sol.minor1)}, ${hStr(sol.minor2)}`;
  const totalDurH=phaseInfo.phases.length?(phaseInfo.phases[phaseInfo.phases.length-1].end-phaseInfo.phases[0].start):6;

  // ── Unified Groq Call ────────────────────────────────────────────────
  const planPrompt=`You are an expert fishing guide for ${lakeName}, South Carolina.
Build a trolling plan for today targeting ${sp}.

TRIP:
- Date: ${dateStr}
- Launch: ${hStr(phaseInfo.phases[0]?.start||6)} from ${rampName}
- Return: ${hStr(phaseInfo.phases[phaseInfo.phases.length-1]?.end||12)}
- Duration: ${totalDurH.toFixed(1)} hours on water
- Season: ${season}
- Water temp: ${waterTempF?waterTempF+'°F':'unknown'}
- Clarity: ${clarity}
- Solunar majors: ${hStr(sol.major1)}, ${hStr(sol.major2)}

PLATFORM:
- Kayak (Native Watersports Slayer Propel Max 12.5, pedal drive + electric motor)
- 2 rods max in water simultaneously (port + starboard)
- No live bait, no downriggers, no planer boards, spinning rods only
- Depth controlled by lead length only

AVAILABLE TACKLE — use ONLY these exact names, no others:
${inventoryNames.join(', ')}

ROUTE STRUCTURE: Pick two depth bands. Band 1 = shallower morning run. Band 2 = deeper mid-morning run.
Each band trolled outbound and back (4 routes total).

Return ONLY valid JSON, no markdown:
{
  "speed": <mph>,
  "speedRationale": "<one sentence why>",
  "band1": {
    "depthMin": <ft>, "depthMax": <ft>,
    "port": "<exact inventory name>", "starboard": "<exact inventory name>",
    "portColor": "<color>", "starboardColor": "<color>",
    "portLeadFt": <ft>, "starboardLeadFt": <ft>,
    "why": "<one sentence species behavior>"
  },
  "band2": {
    "depthMin": <ft>, "depthMax": <ft>,
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

  try {
    if (outEl) outEl.value='⏳ Calling Groq (/groq-query)…';
    const res=await fetch(`${CF_WORKER_URL}/groq-query`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'llama-3.3-70b-versatile',messages:[{role:'user',content:planPrompt}],max_tokens:1000,temperature:0.3}),
    });
    
    rawGroqText = await res.text();
    
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${rawGroqText.slice(0,200)}`);
    } 

    const data = JSON.parse(rawGroqText);
    const content = data.choices?.[0]?.message?.content?.trim();
    
    if (!content) throw new Error('Groq returned empty content');
    
    const clean = content.replace(/```json|```/g,'').trim();
    const si = clean.indexOf('{'), ei = clean.lastIndexOf('}');
    
    if (si === -1 || ei === -1) throw new Error(`No JSON object in response`);
    
    groqPlan = JSON.parse(clean.slice(si, ei+1));

  } catch(e) {
    console.error('[smart-plan] Groq Error:', e.message);
    isFallback = true;
    
    const phaseRecs=phaseInfo.phases.map(p=>getPhaseRecommendation(sp,lakeName,season,p.num,waterTempF));
    const r1=phaseRecs[0]||{depthMin:12,depthMax:18,speed:1.8};
    const r2=phaseRecs[1]||{depthMin:22,depthMax:28,speed:1.8};
    
    const fallPort1  = depthFallbackLure(r1.depthMin + 2, inventoryNames);
    const fallStbd1  = depthFallbackLure(r1.depthMax - 2, inventoryNames);
    const fallPort2  = depthFallbackLure(r2.depthMin + 2, inventoryNames);
    const fallStbd2  = depthFallbackLure(r2.depthMax - 2, inventoryNames);
    
    groqPlan={
      speed:r1.speed||1.8, speedRationale:'Species-intel fallback — Groq unavailable',
      band1:{depthMin:r1.depthMin,depthMax:r1.depthMax,port:fallPort1,starboard:fallStbd1,portColor:'Natural',starboardColor:'Metallic',portLeadFt:40,starboardLeadFt:50,why:'Fallback: mid-depth morning run'},
      band2:{depthMin:r2.depthMin,depthMax:r2.depthMax,port:fallPort2,starboard:fallStbd2,portColor:'Natural',starboardColor:'Natural',portLeadFt:50,starboardLeadFt:60,why:'Fallback: deep mid-morning run'},
      structureFocus:'Look for baitfish marks suspended over channel edges on the fishfinder.',
      adjustmentTip:'Shorten lead 10ft and slow to 1.5mph if no bites.',
      scoutNotes:`Groq API Failed (${e.message}). Running Fallback Plan.\n\n── RAW GROQ DEBUG ──\nResponse: ${rawGroqText || 'No raw response received'}\nStack: ${e.stack}`,
      fishfinderNarrative: `⚠ Groq Narrative Failed. Fallback: Look for baitfish marks suspended over drop-offs.`
    };
  }

  const b1mid=(groqPlan.band1.depthMin+groqPlan.band1.depthMax)/2;
  const b2mid=(groqPlan.band2.depthMin+groqPlan.band2.depthMax)/2;
  groqPlan.band1.port      =sanitizeGroqLureName(groqPlan.band1.port,      b1mid-2, inventoryNames);
  groqPlan.band1.starboard =sanitizeGroqLureName(groqPlan.band1.starboard,  b1mid+2, inventoryNames);
  groqPlan.band2.port      =sanitizeGroqLureName(groqPlan.band2.port,      b2mid-2, inventoryNames);
  groqPlan.band2.starboard =sanitizeGroqLureName(groqPlan.band2.starboard,  b2mid+2, inventoryNames);

  const smartSpeedMph=groqPlan.speed||1.8;
  const speedEl=document.getElementById('planSpeed');
  if (speedEl) speedEl.value=String(smartSpeedMph);

  // ── Build rod rows ────────────────────────────────────────────────────────
  function buildRodFromGroq(lureName,colorName,depthFt,slotIdx,phaseLabel,groqLeadFt) {
    const finalLure = inventoryNames.includes(lureName) ? lureName : inventoryNames[0];
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
    rod.lead=groqLeadFt?String(groqLeadFt):String(autoCalculateLead(rod,smartSpeedMph));
    return rod;
  }

  const routeRods={
    'Ph1 Outbound':[buildRodFromGroq(groqPlan.band1.port,groqPlan.band1.portColor,b1mid-2,0,'Ph1 Out',groqPlan.band1.portLeadFt),buildRodFromGroq(groqPlan.band1.starboard,groqPlan.band1.starboardColor,b1mid+2,1,'Ph1 Out',groqPlan.band1.starboardLeadFt)],
    'Ph1 Inbound': [buildRodFromGroq(groqPlan.band1.port,groqPlan.band1.portColor,b1mid-2,0,'Ph1 In',groqPlan.band1.portLeadFt), buildRodFromGroq(groqPlan.band1.starboard,groqPlan.band1.starboardColor,b1mid+2,1,'Ph1 In',groqPlan.band1.starboardLeadFt)],
    'Ph2 Outbound':[buildRodFromGroq(groqPlan.band2.port,groqPlan.band2.portColor,b2mid-2,0,'Ph2 Out',groqPlan.band2.portLeadFt),buildRodFromGroq(groqPlan.band2.starboard,groqPlan.band2.starboardColor,b2mid+2,1,'Ph2 Out',groqPlan.band2.starboardLeadFt)],
    'Ph2 Inbound': [buildRodFromGroq(groqPlan.band2.port,groqPlan.band2.portColor,b2mid-2,0,'Ph2 In',groqPlan.band2.portLeadFt), buildRodFromGroq(groqPlan.band2.starboard,groqPlan.band2.starboardColor,b2mid+2,1,'Ph2 In',groqPlan.band2.starboardLeadFt)],
  };

  // ── Clear + ramp lookup ───────────────────────────────────────────────────
  clearExistingSmartPlanTracks();
  window._smartPlanCommittedTracks=[];

  let rampLat=null,rampLon=null;
  const selectedRampKey=document.getElementById('planRamp')?.value||'';
  const normN=v=>String(v||'').toLowerCase().replace(/[_-]+/g,' ').replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim();
  const cleanLake=normN(String(lakeName||'').replace(/\([^)]*\)/g,' ').replace(/,.*$/,''));
  const rampMatch=(a,b)=>{const x=normN(a),y=normN(b);return!!x&&!!y&&(x===y||x.includes(y)||y.includes(x));};

  try {
    const {WATEREE_RAMPS,MARION_RAMPS,MOULTRIE_RAMPS,MURRAY_RAMPS,MONTICELLO_RAMPS}=await import('./ryan-ramps.js');
    const lakeRampMap={'lake wateree':WATEREE_RAMPS,'wateree':WATEREE_RAMPS,'lake marion':MARION_RAMPS,'marion':MARION_RAMPS,'lake moultrie':MOULTRIE_RAMPS,'moultrie':MOULTRIE_RAMPS,'lake murray':MURRAY_RAMPS,'murray':MURRAY_RAMPS,'lake monticello':MONTICELLO_RAMPS,'monticello':MONTICELLO_RAMPS};
    const GUARANTEED={'clearwater cove':[34.37927,-80.72881],'clearwater cove marina':[34.37927,-80.72881],'clearwater':[34.37927,-80.72881],'colonel creek':[34.36885,-80.79724],'colonel creek landing':[34.36885,-80.79724],'taylor creek':[34.3830,-80.7374],'wateree creek':[34.4696,-80.9139]};
    if (selectedRampKey) { for (const [k,c] of Object.entries(GUARANTEED)) { if (rampMatch(selectedRampKey,k)){rampLat=c[0];rampLon=c[1];break;} } }
    if (rampLat==null) {
      const rampList=lakeRampMap[cleanLake]||[];
      const found=rampList.find(r=>rampMatch(r.key,selectedRampKey)||rampMatch(r.name,selectedRampKey))||rampList[0];
      if (found){rampLat=found.lat;rampLon=found.lon;}
    }
  } catch(e){}
  if (rampLat==null){const c=getLakeCenter(lakeName);rampLat=c.lat;rampLon=c.lon;}

  // ── Generate waypoints ────────────────────────────────────────────────────
  setStatus('Building contour waypoints…',true);
  const totalWaypoints=await generateScoutWaypoints(
    phaseInfo.phases,
    [{depthMin:groqPlan.band1.depthMin,depthMax:groqPlan.band1.depthMax},{depthMin:groqPlan.band2.depthMin,depthMax:groqPlan.band2.depthMax}],
    rampLat,rampLon,rangeMiles,smartSpeedMph,phaseInfo
  );

  window._smartPlanPhaseRoutes=[
    {phase:1,phaseName:'Shallow',depthMin:groqPlan.band1.depthMin,depthMax:groqPlan.band1.depthMax,speed:smartSpeedMph,window:'Band 1'},
    {phase:2,phaseName:'Deep',   depthMin:groqPlan.band2.depthMin,depthMax:groqPlan.band2.depthMax,speed:smartSpeedMph,window:'Band 2'},
  ];
  applyStoredSmartPlanDepth();
  syncSpread(null,routeRods);
  window._smartPlanRouteRods=routeRods;

  // ── Ramp evaluation ───────────────────────────────────────────────────────
  const windMatch=weatherStr.match(/(\d+)\s*mph/i);
  const windMph=windMatch?parseInt(windMatch[1]):0;
  const phaseRecsForRamp=phaseInfo.phases.map(p=>getPhaseRecommendation(sp,lakeName,season,p.num,waterTempF));
  const rampEval=await getRampEvaluation(lakeName,sp,season,phaseRecsForRamp,weatherStr,windMph>15);

  // ── Build full scout text ──────────────────────────────────────────────────
  const b1p=routeRods['Ph1 Outbound'][0];
  const b1s=routeRods['Ph1 Outbound'][1];
  const b2p=routeRods['Ph2 Outbound'][0];
  const b2s=routeRods['Ph2 Outbound'][1];

  const scoutText=[
    `════════ GROQ SMART PLAN ════════`,
    `${sp} — ${lakeName} — ${season}`,
    `Date: ${dateStr}  Launch: ${hStr(phaseInfo.phases[0]?.start||6)}  Return: ${hStr(phaseInfo.phases[phaseInfo.phases.length-1]?.end||12)}`,
    `Sunrise: ${hStr(phaseInfo.sunriseH)}  Range: ${rangeMiles.toFixed(1)}mi`,
    `Solunar: ${solunarStr}`,
    `Water: ${waterTempF?waterTempF+'°F':'unknown'}  Clarity: ${clarity}`,
    '',
    `── SPEED (Groq) ──`,
    `${smartSpeedMph}mph${groqPlan.speedRationale?' — '+groqPlan.speedRationale:''}`,
    '',
    `── BAND 1 — ${groqPlan.band1.depthMin}-${groqPlan.band1.depthMax}ft  [Ph1 Out + Ph1 In] ──`,
    `Port:      ${b1p.lure}`,
    `           Color: ${b1p.color}  Lead: ${b1p.lead}ft  Depth: ${b1p.depth}ft`,
    `Starboard: ${b1s.lure}`,
    `           Color: ${b1s.color}  Lead: ${b1s.lead}ft  Depth: ${b1s.depth}ft`,
    `Why: ${groqPlan.band1.why}`,
    '',
    `── BAND 2 — ${groqPlan.band2.depthMin}-${groqPlan.band2.depthMax}ft  [Ph2 Out + Ph2 In] ──`,
    `Port:      ${b2p.lure}`,
    `           Color: ${b2p.color}  Lead: ${b2p.lead}ft  Depth: ${b2p.depth}ft`,
    `Starboard: ${b2s.lure}`,
    `           Color: ${b2s.color}  Lead: ${b2s.lead}ft  Depth: ${b2s.depth}ft`,
    `Why: ${groqPlan.band2.why}`,
    '',
    `── FISHFINDER TARGET ──`,
    groqPlan.structureFocus||'',
    '',
    `── IF NO BITES AFTER 30 MIN ──`,
    groqPlan.adjustmentTip||'',
    '',
    `── GUIDE NOTES ──`,
    groqPlan.scoutNotes||'',
    groqPlan.fishfinderNarrative ? '\n── PER-ROUTE FISHFINDER GUIDE ──\n'+groqPlan.fishfinderNarrative : '',
    rampEval ? buildRampRationaleText(rampEval) : '',
    '',
    `════════════════════════════════`,
    `${totalWaypoints} waypoints · 4 routes committed to map`,
    ``,
    `════════ RAW GROQ DEBUG ════════`,
    rawGroqText || 'No raw response received'
  ].filter(l=>l!==null&&l!==undefined).join('\n');

  if (outEl) outEl.value=scoutText;

  // Combine all of Groq's textual advice into one comprehensive report for the UI box
  const fullScoutReport = [
    groqPlan.scoutNotes ? `📝 OVERVIEW:\n${groqPlan.scoutNotes}` : '',
    groqPlan.structureFocus ? `🔎 FISHFINDER TARGET:\n${groqPlan.structureFocus}` : '',
    groqPlan.fishfinderNarrative ? `📺 SONAR GUIDE:\n${groqPlan.fishfinderNarrative}` : '',
    groqPlan.adjustmentTip ? `💡 ADJUSTMENT TIP:\n${groqPlan.adjustmentTip}` : '',
    groqPlan.speedRationale ? `🚤 SPEED RATIONALE:\n${groqPlan.speedRationale}` : ''
  ].filter(Boolean).join('\n\n');

  renderSmartPlanUI({
    routeRods,
    scoutReport: fullScoutReport || null,
    speedMph: smartSpeedMph,
    phases: phaseInfo.phases,
    solunar: solunarStr
  });


  // ── Intel displays ────────────────────────────────────────────────────────
  const intelSection=document.getElementById('planIntelSection');
  if (intelSection) intelSection.style.display='block';
  const solunarDisplay=document.getElementById('planSolunarDisplay');
  if (solunarDisplay) solunarDisplay.textContent=solunarStr;
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
    const fishingContext=await buildFishingContext({species:sp,lakeName,season,clarity,waterTempF,speedMph:smartSpeedMph,dateStr,launchTime,rampLat,rampLon});
    const coachSpread=Object.entries(routeRods).flatMap(([routeName,rods])=>
      rods.map(r=>({route:routeName,side:r.side,rod:r.rod||'',lure:r.lure||'',color:r.color||'',depth:r.depth||'',lead:r.lead||'',notes:(r.notes||'').slice(0,80)}))
    );
    const coachPayload=buildGroqCoachPayload(fishingContext,{
      phases:phaseInfo.phases,
      phaseRecs:[
        {depthMin:groqPlan.band1.depthMin,depthMax:groqPlan.band1.depthMax,speed:smartSpeedMph,lures:[groqPlan.band1.port,groqPlan.band1.starboard],notes:groqPlan.band1.why},
        {depthMin:groqPlan.band2.depthMin,depthMax:groqPlan.band2.depthMax,speed:smartSpeedMph,lures:[groqPlan.band2.port,groqPlan.band2.starboard],notes:groqPlan.band2.why},
      ],
      spread:coachSpread, solunarStr,
      poolLevel:document.getElementById('planPoolLevel')?.value||null,
      weather:weatherStr, rationale:scoutText.split('════════ RAW GROQ DEBUG ════════')[0], rampName:selectedRampKey||'', rangeMiles,
    });
    startCoachSession(coachPayload);
  } catch(e){console.warn('[smart-plan] Coach session failed:',e.message);}

  const wayptMsg=totalWaypoints>0
    ?`✓ Plan built — ${totalWaypoints} waypoints, 4 routes @ ${smartSpeedMph}mph, coach reviewing…`
    : isFallback 
      ? `⚠ Plan built with fallback logic.`
      : '⚠ No waypoints — load contour data first (Contour Data tab)';
  setStatus(wayptMsg,totalWaypoints>0 && !isFallback);

  return {groqPlan,phaseInfo,rangeMiles};
}

setTimeout(()=>{ document.getElementById('runSmartPlanBtn')?.addEventListener('click',runSmartPlan); },800);

window.runSmartPlan=runSmartPlan;
window.applyStoredSmartPlanDepth=applyStoredSmartPlanDepth;

console.log('[smart-plan] module ready — scout waypoint mode');
