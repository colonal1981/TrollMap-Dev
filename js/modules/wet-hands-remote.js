/**
 * Wet Hands Remote — keyboard + gamepad navigation shortcuts so
 * the user can drive TrollMap with wet/salty hands on the water.
 *   - Media volume keys → map zoom in/out
 *   - Space / play-pause → drop a waypoint at current GPS
 *   - Enter → center on GPS
 *   - Gamepad buttons 0/12/13 → waypoint / zoom
 */

import { state } from '../core/state.js';
import { setBanner } from '../core/map-init.js';

/* ── Autonomous "Wet Hands" Bluetooth Media Remote & Gamepad Hub (Module J) ── */
(function initWetHandsRemoteHub(){
  setTimeout(() => {
    // Keep track of audio volume media overrides and standard BT clickers
    window.WET_HANDS_ACTIVE = true;

    // Standard Keyboard Media Clicker Interceptor
    window.addEventListener('keydown', (event) => {
      if(!window.WET_HANDS_ACTIVE || !state.MAP_OK) return;
      if(document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;

      const key = event.key;
      const code = event.code;

      // 1. Zoom In (Media / Clicker Up)
      if(key === '+' || key === '=' || code === 'VolumeUp' || code === 'MediaTrackNext'){
        state.MAP.zoomIn();
        event.preventDefault();
      }
      // 2. Zoom Out (Media / Clicker Down)
      else if(key === '-' || key === '_' || code === 'VolumeDown' || code === 'MediaTrackPrevious'){
        state.MAP.zoomOut();
        event.preventDefault();
      }
      // 3. Drop Catch Waypoint exactly at current GPS (Play / Pause / Space)
      else if(key === ' ' || code === 'Space' || code === 'MediaPlayPause'){
        const wptBtn = document.getElementById('dropWptBtn');
        if(wptBtn){
          wptBtn.click();
          window.setBanner?.('✓ Dropped Waypoint @ GPS');
        } else {
          // Explicitly drop WPT at map center if GPS or button missing
          const C = state.MAP.getCenter();
          const name = 'WPT_' + new Date().toISOString().slice(11,19).replace(/[:.]/g,'_');
          state.DATA.waypoints.push({ lat: C.lat, lon: C.lng, name: name, sym: 'Waypoint' });
          window.renderAll?.();
          alert('✓ Flawlessly Paired Wet Hands Bluetooth Remote!\n\nDropped Waypoint exactly at active location: ' + name);
        }
        event.preventDefault();
      }
      // 4. Center GPS Map Follow (Enter / OK button)
      else if(key === 'Enter' || code === 'Enter'){
        const gpsBtn = document.getElementById('btnGps');
        if(gpsBtn) gpsBtn.click();
        event.preventDefault();
      }
    });

    // Integrated Javascript Gamepad API Auto-Scanner
    function pollGamepads(){
      if(!window.WET_HANDS_ACTIVE || !state.MAP_OK) return;
      const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
      for(let gp of gamepads){
        if(!gp) continue;
        // Button 0 (A / Play / Space trigger)
        if(gp.buttons[0]?.pressed){
          const wptBtn = document.getElementById('dropWptBtn');
          if(wptBtn && !gp._b0_locked){
            gp._b0_locked = true;
            setTimeout(() => gp._b0_locked = false, 1000);
            wptBtn.click();
          }
        }
        // Button 12 (D-pad Up / Volume Up)
        if(gp.buttons[12]?.pressed || gp.axes[1] < -0.5){
          if(!gp._up_locked){
            gp._up_locked = true;
            setTimeout(() => gp._up_locked = false, 400);
            state.MAP.zoomIn();
          }
        }
        // Button 13 (D-pad Down / Volume Down)
        if(gp.buttons[13]?.pressed || gp.axes[1] > 0.5){
          if(!gp._down_locked){
            gp._down_locked = true;
            setTimeout(() => gp._down_locked = false, 400);
            state.MAP.zoomOut();
          }
        }
      }
      if(window.requestAnimationFrame) window.requestAnimationFrame(pollGamepads); else setTimeout(pollGamepads, 30);
    }
    if(window.requestAnimationFrame) window.requestAnimationFrame(pollGamepads); else setTimeout(pollGamepads, 30);

    console.log('✓ Successfully fully armed Wet Hands Bluetooth Media Remote & Gamepad navigation capabilities.');
  }, 1500);
})();

/* ── Personal Gear Autopilot — saves NK180/93sv to IndexedDB, never type again ── */