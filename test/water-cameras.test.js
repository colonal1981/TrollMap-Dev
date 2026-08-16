// One camera roster, two questions, and they are not the same question.
//
// Ryan, 2026-08-16: *"for the cameras we have USGS would it be possible for those to be
// displayed in the top bar now with all of the other information"*. The ramp popup has shown
// frames since 2026-08-05, so the tempting move was to copy `camerasForRamp` into the strip.
// That would have been wrong twice: a copied frame cache is two caches that can disagree about
// how old a picture is, and a ramp's rule answers a question the strip is not asking.
//
//   A RAMP is a point   -> nearest camera SITE on the same water, every view that site has.
//   A WATER is not      -> every camera bound to the slug. On the Congaree that is four
//                          cameras from Columbia down to Fort Motte, which are four answers
//                          and not three worse copies of one.
//
// Every coordinate below is read from js/data/cameras.js, not invented.
import { camerasOnWater, camerasForWater, nearestSite, cameraFrame, ageLabel, _clearFrameCache }
  from '../js/utils/cameras.js';
import { camerasForRamp } from '../js/modules/ramp-cameras.js';
import { NIMS_CAMERAS } from '../js/data/cameras.js';

let fails = 0;
const check = (name, cond, got) => {
  if (cond) { console.log(`  ok   ${name}`); return; }
  fails++; console.log(`  FAIL ${name}${got === undefined ? '' : ` — got ${JSON.stringify(got)}`}`);
};

const CAYCE = { lat: 33.932389, lon: -81.017333 };      // SC_Congaree_River_below_Cayce, both views
const COLUMBIA = { lat: 33.99321, lon: -81.049815 };    // SC_Congaree_River_at_Columbia

console.log('== a water is not a point ==');
{
  const cams = camerasForWater('congaree_river');
  check('all four Congaree cameras, not the nearest one', cams.length === 4, cams.map((c) => c.camId));
  check('sorted by name so the order does not depend on the roster file',
    cams.map((c) => c.name).join('|') === [...cams.map((c) => c.name)].sort((a, b) => a.localeCompare(b)).join('|'),
    cams.map((c) => c.name));
  // Two cameras, one name, one nwisId, two camIds. Deduping on either of the first two would
  // silently drop a view.
  const cayce = cams.filter((c) => c.name === 'Congaree River below Cayce');
  check('UPSTREAM and DOWNSTREAM at one site both survive', cayce.length === 2, cayce.map((c) => c.camId));
  check('deduped on camId', new Set(cams.map((c) => c.camId)).size === cams.length);
}

console.log('\n== the alias path, which is the only way a DNR ramp name resolves ==');
{
  check('slug finds Lynches', camerasForWater('lynches_river').length === 2);
  check('bare feed name finds the same two', camerasForWater(null, 'Lynches River').length === 2,
    camerasForWater(null, 'Lynches River').map((c) => c.camId));
  check('a parenthetical registry name also lands',
    camerasForWater(null, 'Lynches River (Darlington Co, SC)').length === 2);
  check('neither slug nor name is nothing, not everything',
    camerasOnWater({}).length === 0, camerasOnWater({}).length);
}

console.log('\n== 437 of 454 waters have no camera, and that is the normal answer ==');
check('lake_murray has none', camerasForWater('lake_murray').length === 0);
check('a slug nobody bound has none', camerasForWater('some_pond_nobody_bound').length === 0);

console.log('\n== the ramp rule: the water agrees FIRST, distance only breaks ties ==');
{
  // Distance alone picks the wrong water — measured: Pick Hill Access on the BROAD RIVER takes
  // "Little Hope Creek at Charlotte" 60 km away, and WT Billy Tolar on WATEREE takes a CONGAREE
  // camera at 21.6 km. Here is that failure at its most extreme: a Lake Murray ramp sitting on
  // the exact pixel of a Congaree camera. Zero kilometres, and still not this water.
  const wrongWater = camerasForRamp({ lake: 'Lake Murray', ...COLUMBIA });
  check('zero km on the wrong water returns nothing', wrongWater.length === 0, wrongWater);

  const atCayce = camerasForRamp({ lake: 'Congaree River', ...CAYCE });
  check('the site you are standing at, both views', atCayce.length === 2, atCayce.map((c) => c.camId));
  check('not the Columbia camera 7 km upstream',
    !atCayce.some((c) => c.camId === 'SC_Congaree_River_at_Columbia'), atCayce.map((c) => c.camId));
  check('km is carried so the popup can say how far',
    atCayce.every((c) => typeof c.km === 'number' && c.km < 0.001), atCayce.map((c) => c.km));

  // The 20 km ceiling still applies on the right water. This point is on the Congaree by name
  // and about 100 km from the nearest of its cameras.
  const farOff = camerasForRamp({ lake: 'Congaree River', lat: 33.0, lon: -80.0 });
  check('right water, too far, nothing', farOff.length === 0, farOff.map((c) => c.camId));

  check('a ramp with no coordinates is not a point',
    camerasForRamp({ lake: 'Congaree River' }).length === 0);
  check('no ramp at all', camerasForRamp(null).length === 0);
}

console.log('\n== the two rules disagree, which is the whole reason both exist ==');
{
  const byWater = camerasForWater('congaree_river').map((c) => c.camId).sort();
  const byRamp = camerasForRamp({ lake: 'Congaree River', ...CAYCE }).map((c) => c.camId).sort();
  check('the water sees more than the ramp does', byWater.length > byRamp.length, [byWater.length, byRamp.length]);
  check('and everything the ramp sees, the water sees too',
    byRamp.every((id) => byWater.includes(id)), byRamp);
}

console.log('\n== nearestSite is pure and takes the list it is given ==');
{
  const onWater = camerasOnWater({ slug: 'great_pee_dee_river' });
  const got = nearestSite(onWater, 34.300278, -79.634444);
  check('UPSTREAM and DOWNSTREAM share an nwisId and both come back', got.length === 2,
    got.map((c) => c.camId));
  check('an empty list is empty, not everything', nearestSite([], 34, -80).length === 0);
  check('a null list does not throw', nearestSite(null, 34, -80).length === 0);
  check('a tighter ceiling excludes', nearestSite(onWater, 34.6, -79.634444, 5).length === 0);
}

console.log('\n== ONE frame cache, shared ==');
{
  _clearFrameCache();
  let calls = 0;
  const stub = async (u) => {
    calls++;
    return { ok: true, json: async () => ({ camId: 'X', name: 'X cam', ageMinutes: 12, url: u }) };
  };
  const a = await cameraFrame('SC_Congaree_River_at_Columbia', { worker: 'https://w/', fetch: stub, now: 1000 });
  const b = await cameraFrame('SC_Congaree_River_at_Columbia', { worker: 'https://w/', fetch: stub, now: 2000 });
  check('a second read inside the TTL does not refetch', calls === 1, calls);
  check('and returns the same object', a === b);
  check('the trailing slash on the worker base does not double up',
    /^https:\/\/w\/cameras\/frame\?camId=/.test(a.url), a.url);

  await cameraFrame('SC_Congaree_River_at_Columbia', { worker: 'https://w', fetch: stub, now: 1000 + 120001 });
  check('past the TTL it refetches', calls === 2, calls);

  const bad = async () => ({ ok: false, status: 502, json: async () => ({}) });
  let threw = null;
  try { await cameraFrame('NEW_CAM', { worker: 'https://w', fetch: bad }); } catch (e) { threw = e; }
  check('a 502 throws rather than caching a failure', /502/.test(String(threw && threw.message)), String(threw));
  _clearFrameCache();
}

console.log('\n== the age is not decoration ==');
{
  // 22 of the 47 visible cameras here are DAYLIGHT ONLY. Open the app at 22:00 and the newest
  // frame is from 20:15 — a real image, correctly served, completely misleading unlabelled.
  check('minutes', ageLabel(12) === '12 min ago', ageLabel(12));
  check('hours and minutes', ageLabel(135) === '2 h 15 min ago', ageLabel(135));
  check('an absent timestamp says so instead of reading as fresh',
    ageLabel(null) === 'time unknown', ageLabel(null));
  check('zero is now, not unknown', ageLabel(0) === '0 min ago', ageLabel(0));
  const daylight = NIMS_CAMERAS.filter((c) => c.slug && c.period === 'daylight').length;
  check('the roster still carries period, which the card reads', daylight > 0, daylight);
}

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURES'}`);
process.exit(fails ? 1 : 0);
