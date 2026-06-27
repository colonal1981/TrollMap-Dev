/**
 * Personal Gear Autopilot — saves the user motor (NK180 Pro) and
 * sonar (Garmin ECHOMAP UHD2 93sv) profile to IndexedDB so it
 * auto-fills on every page load.
 */

/* ── Personal Gear Autopilot — saves NK180/93sv to IndexedDB, never type again ── */
(function initGearAutopilot(){
  setTimeout(async () => {
    const motorEl = document.getElementById('planMotor');
    const sonarEl = document.getElementById('planSonar');
    if(!motorEl || !sonarEl) return;
    // Load saved profile
    if(window.DB?.db){
      try {
        const saved = await window.DB.get('settings', 'personal_gear_profile');
        if(saved){
          if(saved.motor) motorEl.value = saved.motor;
          if(saved.sonar) sonarEl.value = saved.sonar;
        }
      } catch(_){}
    }
    // Save on any change
    async function saveGear(){
      if(!window.DB?.db) return;
      try {
        await window.DB.put('settings', {
          key: 'personal_gear_profile',
          motor: motorEl.value,
          sonar: sonarEl.value,
          savedAt: new Date().toISOString()
        });
      } catch(_){}
    }
    motorEl.addEventListener('change', saveGear);
    sonarEl.addEventListener('change', saveGear);
    console.log('✓ Personal Gear Autopilot armed — NK180/93sv profile loaded from IndexedDB.');
  }, 1200);
})();

/* ── Auto-Crop Navionics Screenshot ── */
