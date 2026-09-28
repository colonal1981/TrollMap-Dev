// The battery readings are kept.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Ryan, 2026-09-28, on Wateree, after measuring 2.0 A at 1.9 mph into the wind against the app's
// 4.6 A: "Does trollmap have a log for the battery meter that it has?" It did not. ble-motor.js
// polled the BMS every 3 s and overwrote one object. Now every basic-info reading is kept on the
// phone and saved as a CSV that joins to the Garmin track by UTC time.
//
// What these hold:
//   1. the CSV carries each reading as the BMS gave it, signed amps included, in UTC ISO time;
//   2. a missing value is an empty cell, never 0;
//   3. ble-motor.js keeps every reading it decodes, and the page has the button to save them.

import { describe, it } from './expect-shim.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bmsLogCsv, logReading } from '../js/utils/bms-log.js';

describe('the battery readings are kept', () => {
  it('writes each reading as the BMS gave it, in UTC time a GPX track joins on', () => {
    const csv = bmsLogCsv([
      { t: Date.UTC(2026, 8, 28, 14, 5, 3), volts: 26.5, amps: -2.0, soc: 71,
        remainingAh: 71.2, capacityAh: 100, tempC: 24.35, device: 'P21S001HL21S100A' },
    ]);
    const [head, row] = csv.trim().split('\n');
    assert.equal(head, 'time_utc,volts,amps,draw_a,watts,soc_pct,remaining_ah,capacity_ah,temp_c,device');
    assert.equal(row, '2026-09-28T14:05:03.000Z,26.50,-2.00,2.00,53.0,71,71.20,100.00,24.4,"P21S001HL21S100A"');
  });

  it('leaves a missing value empty rather than writing 0', () => {
    const row = bmsLogCsv([{ t: 0, volts: 26.4, amps: null, soc: null }]).trim().split('\n')[1];
    assert.equal(row, '1970-01-01T00:00:00.000Z,26.40,,,,,,,,');
  });

  it('writes a header and nothing else when nothing was kept', () => {
    assert.equal(bmsLogCsv([]).trim().split('\n').length, 1);
  });

  it('does nothing, and says so, where there is no IndexedDB (node)', async () => {
    assert.equal(await logReading({ volts: 26, amps: -1 }), false);
  });

  it('is fed by every reading ble-motor.js decodes, and the page can save it', () => {
    const src = readFileSync(new URL('../js/modules/ble-motor.js', import.meta.url), 'utf8');
    const basic = src.slice(src.indexOf('function updateDisplayFromBasic'), src.indexOf('function updateCells'));
    assert.match(basic, /logReading\(\{ volts: voltage, amps: current,/);
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    assert.match(html, /id="btnBmsLogExport"/);
    assert.match(html, /id="bmsLogCount"/);
  });
});
