// The guide curve, the drought stage as a NUMBER, and where this date usually sits.
//
// Ryan found /lakes/operating-range/24 on 2026-08-17 while looking for something else, and the 24
// is Lake Wateree's `lakepondLocationId` — which /access-alerts already publishes for every Duke
// lake. A foreign key that cannot be derived and did not have to be typed.
//
// Everything in the payload is Duke's 100-ft index, where 100 is full pond and one unit is one
// foot, the same scale normalizeDukeRow decodes. So `average - target` is feet off the guide curve
// with no conversion.
import { parseOperatingRange, levelVsSameDate, dukeLocationIdFor, parseAccessAlerts }
  from '../Worker/conditions.js';

let fails = 0;
const check = (name, cond, got) => {
  if (cond) { console.log(`  ok   ${name}`); return; }
  fails++; console.log(`  FAIL ${name}${got === undefined ? '' : ` — got ${JSON.stringify(got)}`}`);
};

// Rows transcribed from the live payload. Numbers are STRINGS in it, which matters.
const HISTORY = [];
const years = ['2021', '2022', '2023', '2024', '2025'];
const augLevels = { 2021: '96.5', 2022: '97.3', 2023: '94.7', 2024: '97.7', 2025: '98.1' };
for (const y of years) {
  for (let d = 14; d <= 20; d += 1) {
    HISTORY.push({ locationId: 24, average: augLevels[y], date: `${y}-08-${d}`,
                   target: '97', min: '94', max: '100', droughtStage: -1 });
  }
}
// The 2026 run into Stage 2, verbatim shape: -1 through April 16, 1 from April 17, 2 from May 2.
HISTORY.push({ locationId: 24, average: '96.3', date: '2026-04-16', target: '97', min: '94',  max: '100', droughtStage: 0 });
HISTORY.push({ locationId: 24, average: '96.3', date: '2026-04-17', target: '97', min: '93',  max: '100', droughtStage: 1 });
HISTORY.push({ locationId: 24, average: '95.9', date: '2026-05-01', target: '97', min: '93',  max: '100', droughtStage: 1 });
HISTORY.push({ locationId: 24, average: '96',   date: '2026-05-02', target: '97', min: '92.5', max: '100', droughtStage: 2 });
HISTORY.push({ locationId: 24, average: '97.9', date: '2026-08-16', target: '97', min: '92.5', max: '100', droughtStage: 2 });

const PAYLOAD = {
  lakeDetails: { LakeName: 'Lake Wateree',
                 // The parenthesis is never closed in the live payload.
                 Elevation: '225.5 ft (AMSL, NGVD 29 datum',
                 lastUpdated: '2026-08-16T21:23:57' },
  history: HISTORY,
  forecast: [{ date: '2026-08-17', max: 100, min: 94, target: 97 },
             { date: '2026-08-18', max: 100, min: 94, target: 97 }],
  operatingRange: [
    { lakepond_id: 16, Day: 1, Month: 1,  Min: 93.0, Max: 100.0, Target: 94.5 },
    { lakepond_id: 16, Day: 1, Month: 8,  Min: 94.0, Max: 100.0, Target: 97.0 },
    { lakepond_id: 16, Day: 1, Month: 12, Min: 93.0, Max: 100.0, Target: 95.0 },
  ],
};

console.log('== the guide curve ==');
{
  const g = parseOperatingRange(PAYLOAD);
  check('the lake names itself', g.name === 'Lake Wateree');
  // 225.5 ft (AMSL, NGVD 29 datum   <- the paren never closes, which is why this is a regex
  check('full pond survives a malformed string', g.full_pond_ft === 225.5, g.full_pond_ft);
  check('today is the last row', g.today.date === '2026-08-16' && g.today.level === 97.9, g.today);
  // The index is a hundred-foot band under full pond, so this subtraction is already in feet.
  check('feet above the guide curve, no conversion', g.vs_target_ft === 0.9, g.vs_target_ft);
  check('the monthly curve comes through in order',
    g.monthly.map((m) => m.month).join() === '1,8,12', g.monthly.map((m) => m.month));
  check('the forecast comes through', g.forecast.length === 2);
  check('nothing at all is null', parseOperatingRange(null) === null);
  check('an empty history is null', parseOperatingRange({ history: [] }) === null);
}

console.log('\n== the Low Inflow Protocol as a number ==');
{
  const g = parseOperatingRange(PAYLOAD);
  check('stage 2 today', g.drought_stage === 2);
  // The access-alerts paragraph says "entered Stage 2 of the LIP on May 1, 2026". The history says
  // it by changing from 1 to 2 between the 1st and the 2nd. Two sources, one fact.
  check('and it says when it started', g.drought_since === '2026-05-02', g.drought_since);

  // -1 IS NOT A STAGE. It means none declared, and reading it as a level would put every lake in
  // the country at "stage minus one" — the -999 family again.
  const clear = parseOperatingRange({ ...PAYLOAD, history: [
    { average: '97', date: '2026-08-16', target: '97', min: '94', max: '100', droughtStage: -1 }] });
  check('minus one is no drought, not stage minus one', clear.drought_stage === null, clear.drought_stage);
  check('and no start date is invented', clear.drought_since === null);
}

console.log('\n== "97.9" means nothing on its own ==');
{
  // Wateree runs a three-foot summer band and spends most of August within a foot of target.
  const h = levelVsSameDate(PAYLOAD, '2026-08-16');
  check('a rank against the same week in every year on file', !!h);
  check('five years of readings', h.years === 5, h.years);
  // 2025 ran 98.1 this week and 2026 is at 97.9, so it does NOT beat every year — 24 of 30
  // readings, which is the high side and not the top. My first draft of this assertion said it
  // beat all of them; the code was right and I was wrong, which is the point of writing the
  // expected number out rather than comparing to the count.
  check('24 of 30 readings are below it', h.higher_than === 24 && h.n === 30, [h.higher_than, h.n]);
  check('and that is the high side, not the top', h.band === 'on the high side', h.band);
  check('the window is stated, not implied', h.window_days === 3);

  // A lower value has to land lower.
  const low = { ...PAYLOAD, history: [...HISTORY.slice(0, -1),
    { locationId: 24, average: '93.0', date: '2026-08-16', target: '97', min: '92.5', max: '100', droughtStage: 2 }] };
  check('a low reading reads low', levelVsSameDate(low, '2026-08-16').higher_than === 0);
  check('and says so', /lower than almost every other year/.test(levelVsSameDate(low, '2026-08-16').band));

  // NOT ENOUGH HISTORY IS NOT AN ANSWER. Four readings cannot place a value.
  const thin = { history: [{ average: '97', date: '2026-08-16' }, { average: '96', date: '2025-08-16' }] };
  check('two readings is not a rank', levelVsSameDate(thin, '2026-08-16') === null);
  check('a date with no reading is null', levelVsSameDate(PAYLOAD, '2026-03-04') === null);
  check('a malformed date is null', levelVsSameDate(PAYLOAD, 'today') === null);
  check('no payload is null', levelVsSameDate(null, '2026-08-16') === null);
}

console.log('\n== the id is published, not typed ==');
{
  const alerts = parseAccessAlerts([
    { riverName: 'Catawba - Wateree', alerts: [
      { riverbasinId: 1, alertId: 34, lakepondDesc: 'Lake Wateree', lakepondLocationId: 24,
        alertText: '<p>Buck&nbsp;Hill&nbsp;closed.</p>', locationDesc: 'Buck Hill Access Area',
        locationName: 'Buck Hill Access Area', locationType: 'POI' },
      { riverbasinId: 1, alertId: 80, lakepondDesc: 'Lake Hickory', lakepondLocationId: 21,
        alertText: '<p>Portage&nbsp;closed.</p>', locationDesc: 'Oxford Dam Canoe Portage',
        locationName: 'Oxford Dam Canoe Portage', locationType: 'POI' }] },
  ]);
  check('the location id rides on the parsed alert',
    alerts[0].water_location_id === 24, alerts[0].water_location_id);
  check('Wateree resolves to 24', dukeLocationIdFor(alerts, 'Wateree Lake (Kershaw Co, SC)') === 24);
  check('Hickory resolves to 21',
    dukeLocationIdFor(alerts, 'Lake Hickory (Catawba Co, NC)') === 21);
  check('a water with no alert has no id', dukeLocationIdFor(alerts, 'Lake Murray') === null);
  check('no name, no id', dukeLocationIdFor(alerts, '') === null);

  // TWO IDS FOR ONE NAME IS A REFUSAL, not a coin toss.
  const ambiguous = parseAccessAlerts([{ riverName: 'x', alerts: [
    { riverbasinId: 1, lakepondDesc: 'Lake Robinson', lakepondLocationId: 50, alertText: '<p>a</p>',
      locationName: 'a', locationType: 'POI' },
    { riverbasinId: 1, lakepondDesc: 'Lake Robinson', lakepondLocationId: 51, alertText: '<p>b</p>',
      locationName: 'b', locationType: 'POI' }] }]);
  check('two ids for one name is nothing', dukeLocationIdFor(ambiguous, 'Lake Robinson') === null);
}


// ── the sentence that was on the wire the whole time ─────────────────────────────────────────
import { chartDatumShape, archiveAlerts, expiredAlertsFor, ALERT_ARCHIVE_PREFIX }
  from '../Worker/conditions.js';

// Verbatim, pasted by Ryan 2026-08-17 after the card said the lake was higher than 24 of 30
// readings for the week and could not say why.
const WATEREE_NOTICE =
  'Due to planned maintenance at the Wateree Hydro Station the week of August 17, 2026, Lake '
  + 'Wateree water levels are expected to rise over the weekend and remain near 99.0 feet (local '
  + 'datum) during the week. The higher water level is needed to support barge operations related '
  + 'to maintenance activities.';

console.log('\n== fetched on every request and never shown ==');
{
  // normalizeDukeRow has parsed SpecialMessage since it was written and /lake and /duke carried
  // it. /conditions - the route the card uses - dropped it.
  const cd = chartDatumShape({ slug: 'wateree_lake', display_name: 'Wateree Lake (Kershaw Co, SC)' },
    { duke: { ft: 223.4, fullPool: 225.5, belowFullPoolFt: 2.1, duke_feed_name: 'Lake Wateree',
              specialMessage: WATEREE_NOTICE,
              specialMessages: [{ text: WATEREE_NOTICE, eventDate: '2026-08-14T00:00:00' },
                                { text: 'An older notice.', eventDate: '2026-03-01T00:00:00' }] } });
  check('the level still comes through', cd.below_full_pool_ft === 2.1);
  check('and so does the sentence explaining it', cd.operator_message === WATEREE_NOTICE);
  check('99.0 local datum is in it', /99\.0 feet \(local datum\)/.test(cd.operator_message));
  check('so is the barge', /barge operations/.test(cd.operator_message));
  check('the whole array travels, dated', cd.operator_messages.length === 2);

  // A lake with no notice must not grow an empty one.
  const quiet = chartDatumShape({ slug: 'x', display_name: 'X' },
    { duke: { ft: 1, fullPool: 2, belowFullPoolFt: 1 } });
  check('no message is no key', !('operator_message' in quiet));
}

console.log('\n== keep them, because the effect outlives the explanation ==');
{
  // Ryan: "if we were reading their alert messages last week you would know too". Duke takes
  // notices down; the thing they describe can outlast them.
  const store = new Map();
  const bucket = {
    head: async (k) => (store.has(k) ? { key: k } : null),
    put: async (k, body) => { store.set(k, body); },
    get: async (k) => (store.has(k) ? { text: async () => store.get(k) } : null),
    list: async ({ prefix }) => ({ objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }),
  };
  const env = { R2_TROLLMAP_CHARTPACKS: bucket };

  const OLD = [{ id: 999, basin_id: 1, water: 'Lake Wateree', water_location_id: 24,
                 place: 'Lake Wateree', kind: 'LAKEPOND', text: WATEREE_NOTICE, links: [],
                 last_updated: '2026-08-14T00:00:00' }];
  check('first write of the day lands', await archiveAlerts(env, OLD, '2026-08-14') === true);
  check('the same day twice is one object', await archiveAlerts(env, OLD, '2026-08-14') === false);
  check('the key is dated', store.has(`${ALERT_ARCHIVE_PREFIX}2026-08-14.json`));
  check('nothing to archive writes nothing', await archiveAlerts(env, [], '2026-08-15') === false);
  check('no bucket is not a throw', await archiveAlerts({}, OLD, '2026-08-15') === false);

  // A week later the notice is gone from the live feed and the lake is still high.
  const gone = await expiredAlertsFor(env, [], 'Wateree Lake (Kershaw Co, SC)',
    ['Wateree River at Lake Wateree Dam']);
  check('the taken-down notice comes back', gone.length === 1, gone.map((a) => a.id));
  check('LABELLED as no longer posted, never as live', gone[0].no_longer_posted === true);
  check('with the day it was last seen', gone[0].last_seen === '2026-08-14');

  // AND A NOTICE THAT IS STILL LIVE IS NOT ALSO HISTORY.
  const stillUp = await expiredAlertsFor(env, OLD, 'Wateree Lake', ['Wateree River at Lake Wateree Dam']);
  check('a live notice is not duplicated into the archive row', stillUp.length === 0, stillUp);
  check('another lake gets nothing', (await expiredAlertsFor(env, [], 'Lake Murray', [])).length === 0);
  check('no bucket is an empty list', (await expiredAlertsFor({}, [], 'Wateree Lake', [])).length === 0);
}


// ── the drawdown schedule is data, not a PDF to read ────────────────────────────────────────
import { dukePoolManagement } from '../Worker/conditions.js';
import { identityBaseline as baseline } from '../Worker/registry.js';

// The real twelve rows, off the lake page Ryan pasted: Jan 93/94.5/100, Feb 93/95/100,
// Mar–Oct 94/97/100, Nov 93/97/100, Dec 93/95/100.
const TWELVE = [
  [1, 93, 94.5], [2, 93, 95], [3, 94, 97], [4, 94, 97], [5, 94, 97], [6, 94, 97],
  [7, 94, 97], [8, 94, 97], [9, 94, 97], [10, 94, 97], [11, 93, 97], [12, 93, 95],
].map(([Month, Min, Target]) => ({ lakepond_id: 16, Day: 1, Month, Min, Max: 100.0, Target }));

const FULL_PAYLOAD = { ...PAYLOAD, operatingRange: TWELVE };

console.log('\n== the CRA pool table, as JSON ==');
{
  // The identity prompt describes this table and tells an LLM to find it in a PDF:
  // "Month(s) | Guide Curve (target ft) | Minimum ft | Maximum ft (local datum, typically 93-100)".
  const pm = dukePoolManagement(FULL_PAYLOAD);
  check('all twelve months', pm.poolManagement.byMonth.length === 12);
  const aug = pm.poolManagement.byMonth.find((m) => m.month === 8);
  check('August target 97 on the index', aug.targetIndex === 97 && aug.minIndex === 94);
  check('and named', aug.monthName === 'Aug');

  // THE DATUM BUG THE PROMPT HAD. "normalPoolFt to the Maximum column value" is 100 — the top of
  // the local index — where the field wants feet NGVD/NAVD.
  check('normalPoolFt is the real elevation, not 100', pm.normalPoolFt === 225.5, pm.normalPoolFt);
  check('and says which datum it is in', /AMSL/.test(pm.normalPoolDatum));
  check('the index top is published separately', pm.fullPondIndex === 100);
  // amsl = fullPond - (100 - index). August target 97 -> 225.5 - 3 = 222.5.
  check('August target converts to 222.5 ft AMSL', aug.targetFt === 222.5, aug.targetFt);
  check('and its floor to 219.5', aug.minFt === 219.5, aug.minFt);
  check('the max converts back to full pond', aug.maxFt === 225.5, aug.maxFt);

  // The drawdown is the swing in the TARGET across the year: 97 in summer, 94.5 in January.
  check('seasonal drawdown is 2.5 ft', pm.seasonalDrawdownFt === 2.5, pm.seasonalDrawdownFt);
  check('and it is a scheduled one', pm.drawdownType === 'scheduled');

  // A LAKE HELD FLAT ALL YEAR HAS NO DRAWDOWN, and saying zero is the answer rather than omitting.
  const flat = dukePoolManagement({ ...FULL_PAYLOAD,
    operatingRange: TWELVE.map((r) => ({ ...r, Target: 97 })) });
  check('a flat lake draws down zero feet', flat.seasonalDrawdownFt === 0, flat.seasonalDrawdownFt);
  check('and is typed "none", not left null', flat.drawdownType === 'none');

  check('no operating range is null', dukePoolManagement(null) === null);
  check('an empty one is null', dukePoolManagement({ history: HISTORY, operatingRange: [] }) === null);
}

console.log('\n== and it reaches the identity agent as a baseline ==');
{
  const row = { slug: 'wateree_lake', name: 'Wateree Lake', state: 'SC',
                display_name: 'Wateree Lake (Kershaw Co, SC)', county: 'Kershaw',
                gnis: 'gnis:1227425', area_acres: 11756.3, feature_type: 'lake' };
  const b = baseline(row, { ft: 225.5, source: 'Duke live feed' }, dukePoolManagement(FULL_PAYLOAD));
  check('the schedule rides along', b.poolManagement.byMonth.length === 12);
  check('drawdownType travels', b.drawdownType === 'scheduled');
  check('so does the swing', b.seasonalDrawdownFt === 2.5);
  check('normalPoolFt is the elevation', b.normalPoolFt === 225.5);
  check('with its datum stated', /AMSL/.test(b.normalPoolDatum));
  check('and the source is the API, not a PDF', /operating-range/.test(b.normalPoolSource));

  // A lake with no operating range keeps the plain baseline and grows no empty schedule.
  const plain = baseline(row, { ft: 225.5, source: 'Duke live feed' }, null);
  check('no schedule is no key', !('poolManagement' in plain));
  check('but the live pool still stands', plain.normalPoolFt === 225.5);
}

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURES'}`);
process.exit(fails ? 1 : 0);
