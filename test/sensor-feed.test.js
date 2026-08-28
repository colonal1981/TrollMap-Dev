// A PUBLIC OPERATOR SENSOR, WHERE NO NETWORK GAUGE EXISTS.
//
// Randleman Lake (Randolph Co, NC) is 2,919 acres and has no USGS, CWMS or NWS level gauge on
// it -- its only bound USGS site is DEEP RIVER NEAR RANDLEMAN, below the dam, which answers
// `no current value`. PTRWA runs a sensor on the lake and publishes it. The feed was recorded
// on 2026-08-27, bound as `levels.primary: 'sensor'`, and read by nothing, so the card said
// `full pool is known; today's level is not` over a live reading.
//
// The fixture is the real payload's shape, with the real numbers off
// _pagesrc/licor_66308fa1.json captured 2026-08-27: level 681.456 ft against a full pool of
// 682, and 83.82 °F.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeSensor, sensorSourceOf, sensorReading } from '../Worker/sensor.js';

const SOURCE = {
  source: 'sensor',
  name: 'Piedmont Triad Regional Water Authority (PTRWA)',
  key: {
    dashboard: '66308fa1-1b12-4db4-b581-06e1003268d9',
    channel: '6a8fcf43-1bcf-455f-a569-8f9e6eeb0cff',
    metric: 'com.onset.sensordata.waterlevel_us',
  },
};

const PAYLOAD = { success: true, value: { records: [
  { channelUUID: 'bde1957b-8b9e-4ad5-bf36-c1c318862e00', metricName: 'Water Temperature',
    metricUnits: '°F', sensorSerialNumber: '20895081-3',
    datum: { valid: [[1787791800000, 83.9], [1787792100000, 83.82]] } },
  { channelUUID: '6a8fcf43-1bcf-455f-a569-8f9e6eeb0cff', metricName: 'Water Level',
    metricUnits: 'feet', sensorSerialNumber: '20895081-4',
    datum: { valid: [[1787791800000, 681.44], [1787792100000, 681.456]] } },
] } };

test('the last point of each series is the reading, and feet and degrees are told apart', () => {
  const r = shapeSensor(PAYLOAD, SOURCE);
  assert.equal(r.level_ft, 681.46);
  assert.equal(r.water_f, 83.8);
  assert.equal(r.units, 'feet');
  assert.equal(r.station, '20895081-4');
  assert.equal(r.observed_at, new Date(1787792100000).toISOString());
});

test('a payload with no points at all is null, not zero', () => {
  assert.equal(shapeSensor({ success: true, value: { records: [
    { metricName: 'Water Level', metricUnits: 'feet', datum: { valid: [] } }] } }, SOURCE), null);
  assert.equal(shapeSensor({ success: true, value: { records: [] } }, SOURCE), null);
  assert.equal(shapeSensor(null, SOURCE), null);
});

test('the sensor source is found on the binding by name, not by position', () => {
  const b = { levels: { primary: 'sensor', sources: [
    { source: 'usgs:00062', key: { site: '02099500' } }, SOURCE] } };
  assert.equal(sensorSourceOf(b).name, SOURCE.name);
  assert.equal(sensorSourceOf({ levels: { sources: [] } }), null);
  assert.equal(sensorSourceOf({}), null);
});

test('THE REQUEST CARRIES NO CREDENTIAL, and the dashboard id travels in the body', async () => {
  // The public dashboard authorises the call with its own id. A bare request 404s, which is why
  // this must never be "fixed" by adding a header.
  let seen = null;
  await sensorReading(SOURCE, async (url, body, referer) => {
    seen = { url, body, referer };
    return PAYLOAD;
  });
  assert.match(seen.url, /\/api\/v2\/timeseriesdata$/);
  assert.equal(seen.body.dashboardUUID, SOURCE.key.dashboard);
  assert.equal(seen.body.channels[0].channelUUID, SOURCE.key.channel);
  assert.equal(seen.body.channels[0].metricName, SOURCE.key.metric);
  assert.match(seen.referer, /dashboards\/public\/66308fa1-1b12-4db4-b581-06e1003268d9\/true$/);
  const flat = JSON.stringify(seen).toLowerCase();
  for (const word of ['authorization', 'bearer', 'apikey', 'api_key', 'token', 'password']) {
    assert.equal(flat.includes(word), false, `the request must not carry ${word}`);
  }
});

test('a source missing any part of its key asks for nothing', async () => {
  let called = false;
  const post = async () => { called = true; return PAYLOAD; };
  assert.equal(await sensorReading({ source: 'sensor', key: { dashboard: 'x' } }, post), null);
  assert.equal(await sensorReading({ source: 'sensor' }, post), null);
  assert.equal(called, false);
});
