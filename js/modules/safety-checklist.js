/**
 * Autonomous Safety Checklist — auto-compiles a tactical safety
 * briefing based on water temperature, wind forecast, precip, and
 * launch time. Writes into the Plan tab's Safety textarea.
 */

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
    items.push('🔴 DANGEROUS COLD WATER (Hypothermia Threat) → Survival time < 60 mins. Mandatory dry suit or heavy waders with high wading belt.');
    items.push('🔴 Kayak emergency self-rescue re-entry ladder deployed and unclipped.');
    items.push('🔴 Pack full spare dry change of clothes in sealed stern dry bag.');
  } else if (wTemp > 86) {
    items.push('🔴 EXTREME HEAT ADVISORY → Mandatory 1 Gallon (4L) water/electrolytes minimum per angler.');
    items.push('🔴 High heat stroke threat. Pack SPF50+ sunscreen, long-sleeve UV shirt, wide-brim sun hat, and polarized sunglasses.');
  } else {
    items.push(`✓ Comfortable water temperature (${wTemp}°F) — Standard kayak waders/clothing.`);
  }

  if (windMph >= 15 || windStr.includes('gust') || windStr.includes('advisory') || windStr.includes('warning')) {
    items.push(`🔴 HIGH KAYAK WIND WARNING (${windMph || '15+'} mph) → Restrict all trolling passes strictly to the protected Lee side of the reservoir or inside sheltered creek arms.`);
    items.push('🔴 Secure all active deck gear, pliers, and tackle boxes with heavy-duty safety leashes.');
    items.push('🔴 Verify kayak drift sock, anchor trolley system, and 30ft quick-release anchor rope before un-docking.');
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
    items.push('🔴 NIGHT / FOG NAVIGATION → Mandatory 360° white stern visibility light clipped to kayak crate + high-output LED headlamp.');
  }

  items.push('Perform Coast Guard emergency air whistle check (clipped directly to PFD front shoulder strap)');
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
