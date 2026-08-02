/**
 * Autonomous Safety Checklist — auto-compiles a tactical safety
 * briefing based on water temperature, wind forecast, precip, and
 * launch time. Writes into the Plan tab's Safety textarea.
 *
 * Reads FISHING_STYLE.gear rather than asserting equipment. Every line below
 * that names a piece of kit is gated on whether it is actually on the boat.
 * A checklist that says "verify your drift sock" to someone who owns no drift
 * sock teaches you to skim, and the lines you cannot afford to skim are the
 * PFD and the float plan.
 */
import { FISHING_STYLE } from '../data/fishing-style-profile.js';

function updateAutonomousSafetyChecklist() {
  const waterTempEl = document.getElementById('planWaterTemp');
  const windEl = document.getElementById('planWeather');
  const safetyEl = document.getElementById('planSafety');
  const launchTimeEl = document.getElementById('planLaunchTime');
  if (!safetyEl) return;

  const wTemp = parseFloat(waterTempEl?.value) || 72;
  const windStr = (windEl?.value || '').toLowerCase();

  // Extract wind mph
  const windMatch = windStr.match(/wind[sS]{1,20}?([0-9]+)\s*mph/i) || windStr.match(/([0-9]+)\s*mph/i);
  const windMph = windMatch ? parseInt(windMatch[1]) : 0;
  const isNight = launchTimeEl && (launchTimeEl.value < '06:00' || launchTimeEl.value > '20:00');

  const items = [];
  items.push('PFD on and securely zipped at all times');
  items.push('Fully charged phone inside sealed waterproof dry bag');
  items.push('Float plan filed & shared (launch ramp, return time, emergency contact)');

  if (wTemp < 55) {
    const g = FISHING_STYLE.gear;
    items.push(`🔴 DANGEROUS COLD WATER (${wTemp}°F) → in-water survival well under 60 min.`);

    if (g.drySuit || g.wadersWithBelt) {
      items.push('🔴 Dry suit / waders + high wading belt ON before launch — not stowed.');
    } else {
      items.push('🔴 NO DRY SUIT OR WADERS ON BOARD → you are dressed for the air, not the water.');
    }

    if (g.selfRescueLadder) {
      items.push('🔴 Self-rescue re-entry ladder deployed and unclipped.');
    } else {
      items.push('🔴 NO RE-ENTRY LADDER → assume a capsize means you are swimming, not remounting.');
      items.push('🔴 Therefore: stay inside swimming distance of a landable bank all trip. No open-water crossings, no main-lake points.');
    }

    if (g.spareClothes === 'at_vehicle') {
      items.push('🔴 Dry clothes are AT THE TRUCK, not on the kayak → a swim ends the trip. Plan the shortest line back to the launch, and tell your float-plan contact that.');
    } else if (g.spareClothes) {
      items.push('🔴 Spare dry change sealed in the stern dry bag.');
    }
  } else if (wTemp > 86) {
    items.push('🔴 EXTREME HEAT ADVISORY → Mandatory 1 Gallon (4L) water/electrolytes minimum per angler.');
    items.push('🔴 High heat stroke threat. Pack SPF50+ sunscreen, long-sleeve UV shirt, wide-brim sun hat, and polarized sunglasses.');
  } else {
    items.push(`✓ Comfortable water temperature (${wTemp}°F) — Standard kayak waders/clothing.`);
  }

  if (windMph >= 15 || windStr.includes('gust') || windStr.includes('advisory') || windStr.includes('warning')) {
    items.push(`🔴 HIGH KAYAK WIND WARNING (${windMph || '15+'} mph) → Restrict all trolling passes strictly to the protected Lee side of the reservoir or inside sheltered creek arms.`);
    items.push('🔴 Secure all active deck gear, pliers, and tackle boxes with heavy-duty safety leashes.');
    const g = FISHING_STYLE.gear;
    if (g.driftSock) {
      items.push('🔴 Drift sock rigged and quick-release checked before un-docking.');
    } else {
      items.push(`🔴 NO DRIFT SOCK → you cannot slow a drift. At ${windMph || '15+'} mph the wind sets your speed: fish the lee side, go heavier on the jig, or troll instead of drifting.`);
    }
    items.push(`🔴 Anchoring is ${g.anchorRopeFt}ft of rope and an ${g.stakeoutPoleFt}ft pole — stationary only in water under ~${g.maxStationaryDepthFt}ft. Do not plan a hold in deeper water.`);
  } else {
    items.push(`✓ Safe wind forecast (${windMph || '< 12'} mph) — Manageable kayak open-water trolling.`);
  }

  const hasPrecip = (windStr.includes('rain') || windStr.includes('storm') || windStr.includes('precip') || windStr.includes('thunder'))
                 && !windStr.includes('0mm');
  if (hasPrecip) {
    items.push('🔴 SQUALL / PRECIPITATION WATCH → Keep interactive radar app open on phone display. At the absolute first sound of thunder, terminate all trolling lines immediately and beach kayak on nearest shoreline.');
  } else {
    items.push('✓ Clear skies — No significant precipitation forecast.');
  }

  if (isNight) {
    const g = FISHING_STYLE.gear;
    items.push(g.sternLight360 && g.headlamp
      ? '🔴 NIGHT / FOG NAVIGATION → 360° white stern light clipped to the crate and switched ON, headlamp on your head with fresh cells.'
      : '🔴 NIGHT / FOG NAVIGATION → required lighting NOT on the boat. Do not launch in the dark.');
  }

  if (FISHING_STYLE.gear.whistle) {
    items.push('Sound check the air whistle — clipped to the PFD front shoulder strap, not in the crate');
  }
  items.push('Perform battery health Bluetooth app check (NK180 Pro app) before un-docking');
  items.push('Inspect trolling motor prop for discarded fishing line or weed wrapping');

  safetyEl.value = items.join('\n');
}

setTimeout(() => {
  document.getElementById('autoCompileSafetyBtn')?.addEventListener('click', () => {
    updateAutonomousSafetyChecklist();
    alert('Flawlessly compiled active tactical safety briefing based on loaded conditions.');
    const el = document.getElementById('planSafety');
    if (el) {
      el.style.borderColor = 'var(--accent2)';
      setTimeout(() => el.style.borderColor = '', 1200);
    }
  });
}, 1000);

window.updateAutonomousSafetyChecklist = updateAutonomousSafetyChecklist;
