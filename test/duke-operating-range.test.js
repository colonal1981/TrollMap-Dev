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

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURES'}`);
process.exit(fails ? 1 : 0);
