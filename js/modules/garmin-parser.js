/**
 * Garmin Catch Parser — import a GPX file from a Garmin chartplotter
 * and pull FISH/CATCH/STRIPER/BASS/KEEPER/REDFISH/CRAPPIE waypoints
 * into the catch journal.
 *
 * Tip: on the Garmin, name catch waypoints starting with "FISH" or
 * "CATCH" so this parser can find them.
 */

import { state } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { renderCatchLog } from './catch-journal.js';

/**
 * Classify a waypoint's species from the name/symbol text. Returns
 * the best-guess species name (or "Fish" if unknown).
 */
function classifySpecies(name, sym) {
  const txt = name + sym;
  if (/striper|stripe/i.test(txt)) return 'Striped Bass';
  if (/bass/i.test(txt))         return 'Largemouth Bass';
  if (/red|drum/i.test(txt))     return 'Redfish';
  if (/crappie/i.test(txt))      return 'Crappie';
  return 'Fish';
}

/**
 * Parse a length value like "28in" or "32\"" out of free text.
 * Returns empty string if no match.
 */
function parseLength(text) {
  const m = text.match(/(\d{1,2})\s*(?:in|inch|"|')/i);
  return m ? m[1] : '';
}

function wireInput() {
  const input = document.getElementById('garminParserInput');
  const label = document.getElementById('btnGarminParser');
  if (!input) return;

  input.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (label) {
      label.style.background = 'var(--accent)';
      label.style.color = '#000';
    }

    try {
      const text = await file.text();
      const xml = new DOMParser().parseFromString(text, 'text/xml');
      const wpts = xml.getElementsByTagName('wpt');

      // Trip date from GPX metadata if available, else today.
      const today = new Date().toISOString().slice(0, 10);
      const metaTime = xml.querySelector('metadata time');
      const tripDate = metaTime ? metaTime.textContent.slice(0, 10) : today;

      let imported = 0;
      for (const wpt of wpts) {
        const nameEl = wpt.getElementsByTagName('name')[0];
        const symEl  = wpt.getElementsByTagName('sym')[0];
        const cmtEl  = wpt.getElementsByTagName('cmt')[0] || wpt.getElementsByTagName('desc')[0];
        const name = nameEl?.textContent || '';
        const sym  = symEl?.textContent  || '';
        const cmt  = cmtEl?.textContent  || '';

        // Only import catch-like waypoints.
        if (!/fish|catch|striper|bass|keeper|red|crappie/i.test(name + sym + cmt)) continue;

        const lat = parseFloat(wpt.getAttribute('lat'));
        const lon = parseFloat(wpt.getAttribute('lon'));
        if (isNaN(lat) || isNaN(lon)) continue;

        const timeEl = wpt.getElementsByTagName('time')[0];
        const timeStr = timeEl
          ? new Date(timeEl.textContent).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
          : '';

        state.CATCHES.unshift({
          species: classifySpecies(name, sym),
          length: parseLength(name + cmt),
          depth: '', lure: '', lead: '',
          time: timeStr,
          notes: `Imported from Garmin GPX: ${esc(name)}${cmt ? ' — ' + esc(cmt) : ''}`,
          date: tripDate,
          lake: document.getElementById('planLake')?.value || '',
          lat: lat.toFixed(5),
          lon: lon.toFixed(5),
        });
        imported++;
      }

      if (imported) {
        renderCatchLog();
        await window.DB?.put?.('journal', { name: 'catches', data: state.CATCHES }).catch(() => {});
        document.querySelector('#bottomNav button[data-tab="plan"]')?.click();
        setTimeout(() => { document.getElementById('catchLog')?.scrollIntoView({ behavior: 'smooth' }); }, 400);
        alert(`✅ Imported ${imported} catch${imported > 1 ? 'es' : ''} from ${file.name}\nDate: ${tripDate}\nCheck your Catch Journal.`);
      } else {
        alert(`No FISH/CATCH waypoints found in ${file.name}.\n\nTip: On your Garmin, name waypoints starting with "FISH" or "CATCH" when you mark a catch.`);
      }
    } catch (err) {
      alert('Error parsing GPX: ' + err.message);
    } finally {
      if (label) {
        label.style.background = '';
        label.style.color = '';
      }
      input.value = '';
    }
  });
}

wireInput();
console.log('✓ Garmin Active Track / Catch Parser armed.');
