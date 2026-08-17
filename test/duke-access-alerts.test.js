// What is shut, and why the water is where it is.
//
// Ryan pasted /access-alerts on 2026-08-17. It carries the reason behind a number the card was
// already showing: Lake Wateree reads "No Flow Release" three days running because
//
//   "On May 1, 2026, the Catawba Wateree River Basin entered Stage 2 of the Low Inflow Protocol
//    (LIP) ... recreation flow schedules have been suspended as required under Stage 2 of the LIP."
//
// A stated zero with its cause beside it is a different fact from a stated zero on its own.
import { decodeEntities, alertText, alertLinks, splitNotices, parseAccessAlerts,
         alertsForWater, droughtNoticeFor } from '../Worker/conditions.js';

let fails = 0;
const check = (name, cond, got) => {
  if (cond) { console.log(`  ok   ${name}`); return; }
  fails++; console.log(`  FAIL ${name}${got === undefined ? '' : ` — got ${JSON.stringify(got)}`}`);
};

const BASIN_1 = { RiverId: 1, RiverName: 'Catawba', riverDescription: 'Catawba - Wateree' };
const BASIN_6 = { RiverId: 6, RiverName: 'Keowee Toxaway', riverDescription: 'Keowee - Toxaway' };

// Verbatim fragments off the live payload, entities and all.
const ALL_PROJECTS = '<p>On&nbsp;February&nbsp;2,&nbsp;2026,&nbsp;the&nbsp;Keowee&nbsp;Toxaway&nbsp;River'
  + '&nbsp;basin&nbsp;entered&nbsp;Stage&nbsp;2&nbsp;of&nbsp;the&nbsp;Low&nbsp;Inflow&nbsp;Protocol'
  + '&nbsp;(LIP).</p><p>-</p><p>On&nbsp;May&nbsp;1,&nbsp;2026,&nbsp;the&nbsp;Catawba&nbsp;Wateree'
  + '&nbsp;River&nbsp;Basin&nbsp;entered&nbsp;Stage&nbsp;2&nbsp;of&nbsp;the&nbsp;Low&nbsp;Inflow'
  + '&nbsp;Protocol&nbsp;(LIP)&nbsp;due&nbsp;to&nbsp;significantly&nbsp;below&nbsp;average&nbsp;rainfall'
  + '&nbsp;...&nbsp;recreation&nbsp;flow&nbsp;schedules&nbsp;have&nbsp;been&nbsp;suspended&nbsp;as'
  + '&nbsp;required&nbsp;under&nbsp;Stage&nbsp;2&nbsp;of&nbsp;the&nbsp;LIP.</p><p>&nbsp;-</p>'
  + '<p>The&nbsp;majority&nbsp;of&nbsp;Hurricane&nbsp;Helene&nbsp;storm&nbsp;related&nbsp;lake&nbsp;debris'
  + '&nbsp;has&nbsp;been&nbsp;addressed.</p>';

const BUCK_HILL = '<p>Buck&nbsp;Hill&nbsp;Access&nbsp;Area&nbsp;will&nbsp;close&nbsp;on&nbsp;March'
  + '&nbsp;2,&nbsp;2026&nbsp;for&nbsp;approximately&nbsp;one&nbsp;year&nbsp;due&nbsp;to&nbsp;construction'
  + '&nbsp;work&nbsp;at&nbsp;the&nbsp;Wateree&nbsp;hydro&nbsp;facility.&nbsp;Please&nbsp;use&nbsp;alternate'
  + '&nbsp;sites,&nbsp;such&nbsp;as&nbsp;Colonels&nbsp;Creek&nbsp;or&nbsp;White&nbsp;Oak&nbsp;Creek.</p>';

const SOUTH_POINT = '<p>South&nbsp;Point&nbsp;Access&nbsp;Area&nbsp;is&nbsp;under&nbsp;the&nbsp;management'
  + '&nbsp;of&nbsp;Gaston&nbsp;County.&nbsp;<a href="https://www.gastongov.com/Facilities/Facility/'
  + 'Details/South-Point-Access-51" rel="noopener noreferrer" target="_blank">Facilities&nbsp;&bull;'
  + '&nbsp;South&nbsp;Point&nbsp;Access</a></p>';

const PAYLOAD = [
  { riverName: 'All Projects', alerts: [
    { riverbasinId: 0, alertId: 133, lakepondDesc: null, alertText: ALL_PROJECTS,
      locationDesc: 'All Projects', locationName: 'All Projects', locationType: 'RIVERBASIN',
      lastUpdated: '2026-05-19T14:27:23.831108' }] },
  { riverName: 'Catawba - Wateree', alerts: [
    { riverbasinId: 1, alertId: 34, lakepondDesc: 'Lake Wateree', alertText: BUCK_HILL,
      locationDesc: 'Buck Hill Access Area', locationName: 'Buck Hill Access Area',
      locationType: 'POI', lastUpdated: '2026-02-11T20:47:08.944244' },
    { riverbasinId: 1, alertId: 202, lakepondDesc: 'Lake Wylie', alertText: SOUTH_POINT,
      locationDesc: 'South Point Access Area - Day Use', locationName: 'South Point Access Area - Day Use',
      locationType: 'POI', lastUpdated: '2026-02-19T18:27:52.837843' },
    { riverbasinId: 1, alertId: 80, lakepondDesc: 'Lake Hickory',
      alertText: '<p>The&nbsp;Oxford&nbsp;Dam&nbsp;Canoe&nbsp;Portage&nbsp;will&nbsp;be&nbsp;closed.</p>',
      locationDesc: 'Oxford Dam Canoe Portage', locationName: 'Oxford Dam Canoe Portage',
      locationType: 'POI', lastUpdated: '2026-02-19T18:40:39.195023' }] },
  { riverName: 'Unknown', alerts: [
    { riverbasinId: -1, alertId: 463, lakepondDesc: null,
      alertText: '<p>The&nbsp;Markland&nbsp;Project&nbsp;tailrace&nbsp;is&nbsp;closed.</p>',
      locationDesc: 'Ohio River', locationName: 'Ohio River', locationType: 'RIVERBASIN',
      lastUpdated: '2026-08-13T18:30:26.442760' }] },
];

console.log('== every space in this payload is an entity ==');
{
  // "On&nbsp;May&nbsp;1" — a naive tag strip yields one unbroken word.
  check('nbsp becomes a space', decodeEntities('On&nbsp;May&nbsp;1') === 'On May 1');
  check('numeric entities', decodeEntities('caf&#233;') === 'café');
  check('hex entities', decodeEntities('&#x2014;') === '—');
  check('an unknown entity is left alone rather than eaten',
    decodeEntities('&notathing;') === '&notathing;', decodeEntities('&notathing;'));

  const t = alertText(BUCK_HILL);
  check('reads as a sentence', /^Buck Hill Access Area will close on March 2, 2026/.test(t), t.slice(0, 60));
  check('and names the alternates', /Colonels Creek or White Oak Creek/.test(t));
  check('no tags survive', !/[<>]/.test(t));
  check('empty in, empty out', alertText(null) === '' && alertText('') === '');

  const li = alertText('<ul><li>one</li><li>two</li></ul>');
  check('a list keeps its items apart', li === '• one\n• two', li);
}

console.log('\n== the county that actually runs the ramp ==');
{
  // Several alerts are nothing but a pointer at somebody else. Dropping the href turns "here is
  // who to ask" into "there is a notice".
  const links = alertLinks(SOUTH_POINT);
  check('the href is kept', links.length === 1 && /gastongov\.com/.test(links[0]), links);
  check('no links is an empty list', alertLinks(BUCK_HILL).length === 0);
  check('relative and javascript hrefs are refused',
    alertLinks('<a href="/x">a</a><a href="javascript:alert(1)">b</a>').length === 0);
}

console.log('\n== "All Projects" is several notices in one field ==');
{
  const parts = splitNotices(alertText(ALL_PROJECTS));
  check('split on the lone-hyphen paragraph', parts.length === 3, parts.length);
  check('first is Keowee', /Keowee Toxaway/.test(parts[0]));
  check('second is Catawba-Wateree', /Catawba Wateree/.test(parts[1]));
  check('third is the Helene debris note', /Helene/.test(parts[2]));
  check('an empty text is no notices', splitNotices('').length === 0);
}

console.log('\n== the reason behind the zero ==');
{
  const alerts = parseAccessAlerts(PAYLOAD);
  const d = droughtNoticeFor(alerts, BASIN_1);
  check('found for the Catawba-Wateree', !!d);
  check('stage read off the text', d.stage === 2, d && d.stage);
  check('and it says recreation flows are suspended', d.suspends_recreation_flows === true);
  check('the text is the Catawba paragraph, not the Keowee one',
    /Catawba Wateree/.test(d.text) && !/Keowee/.test(d.text), d && d.text.slice(0, 50));

  // The same blob carries Keowee's, and asking for Keowee must not return Catawba's.
  const k = droughtNoticeFor(alerts, BASIN_6);
  check('Keowee gets its own paragraph', k && /Keowee Toxaway/.test(k.text) && !/Catawba/.test(k.text),
    k && k.text.slice(0, 50));
  check('a basin with no notice is null',
    droughtNoticeFor(alerts, { RiverId: 11, RiverName: 'PigeonRiver', riverDescription: 'Pigeon River' }) === null);
  check('no roster row, no guess', droughtNoticeFor(alerts, null) === null);
}

console.log('\n== the alerts about THIS water ==');
{
  const alerts = parseAccessAlerts(PAYLOAD);
  check('the Ohio River is not filed under a basin', alerts.find((a) => a.place === 'Ohio River').basin_id === null);

  const WATEREE_GAUGES = ['Catawba River at Cedar Creek Reservoir/Rocky Ck-Cedar Ck Dam',
                          'Wateree River at Lake Wateree Dam'];
  const mine = alertsForWater(alerts, 'Wateree Lake (Kershaw Co, SC)', WATEREE_GAUGES);
  check('Buck Hill, and only Buck Hill', mine.length === 1 && mine[0].place === 'Buck Hill Access Area',
    mine.map((a) => a.place));
  check('a basin-wide notice is not an access alert',
    !mine.some((a) => a.kind === 'RIVERBASIN'), mine.map((a) => a.kind));

  // Lake Hickory's alert is about the OXFORD dam portage and never says "Hickory" in its title.
  // lakepondDesc does.
  const hick = alertsForWater(alerts, 'Lake Hickory (Catawba Co, NC)',
                              ['Catawba River at Lake Hickory/Oxford Dam']);
  check('Hickory finds its portage through lakepondDesc', hick.length === 1, hick.map((a) => a.place));

  check('a water with nothing shut has nothing', alertsForWater(alerts, 'Lake Murray', []).length === 0);
  check('no name, no match', alertsForWater(alerts, '', []).length === 0);
  check('nothing published is an empty list', alertsForWater(null, 'Wateree Lake', []).length === 0);
  check('parse of nothing is an empty list', parseAccessAlerts(null).length === 0);
}

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURES'}`);
process.exit(fails ? 1 : 0);
