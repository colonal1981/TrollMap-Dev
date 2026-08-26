// THE ONLY PATH IN THIS APP THAT INTERRUPTS RYAN, AND IT HAS NEVER RUN IN THE FIELD.
//
// Ryan, 2026-08-25: "honestly completely untested... i have not actually been on the water since
// we turned that feature on."
//
// It carries NWS warnings to his phone and on to the Echomap. Every link in it fails SILENTLY:
// a permission never granted, a constructor that throws on Android, a poll whose worker URL was
// never passed, a fetch that 502s. On a phone in a dry bag none of those is visible as anything.
// These tests stand in for the field trip we have not taken.
import test from 'node:test';
import assert from 'node:assert';

// notifications.js assigns to `window` at module scope, so the environment has to exist BEFORE
// the import. That is why this file imports dynamically rather than at the top.
function stubEnv({ withServiceWorker = true, constructorThrows = false, permission = 'granted' } = {}) {
  const shown = [];
  const w = globalThis;
  w.window = w;
  w.document = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, addEventListener() {} }),
  };
  class FakeNotification {
    constructor(title, opts) {
      if (constructorThrows) throw new TypeError('Illegal constructor');
      shown.push({ via: 'page', title, body: opts && opts.body });
    }
    close() {}
  }
  FakeNotification.permission = permission;
  FakeNotification.requestPermission = async () => permission;
  w.Notification = FakeNotification;
  // Node 21+ ships its own read-only `navigator`, so a plain assignment throws. The browser
  // this code actually runs in has a writable one; defineProperty is how the test gets there.
  Object.defineProperty(w, 'navigator', { configurable: true, writable: true, value: {
    geolocation: { getCurrentPosition: () => {}, watchPosition: () => 1, clearWatch: () => {} },
    serviceWorker: withServiceWorker ? {
      getRegistration: async () => ({
        active: {}, scope: 'https://x/',
        showNotification: async (title, opts) => { shown.push({ via: 'sw', title, body: opts && opts.body }); },
      }),
    } : undefined,
  } });
  w.fetch = async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) });
  return shown;
}

async function load() {
  // A fresh module per test, so `_enabled` and the timers from one do not leak into the next.
  return import(`../js/modules/notifications.js?t=${Date.now()}${Math.random()}`);
}

test('a notification goes out through the SERVICE WORKER when one is registered', async () => {
  const shown = stubEnv({ withServiceWorker: true });
  const m = await load();
  await m.enableNotifications();
  try {
    const st = await m.selfTest();
    const fired = st.checks.find((c) => c.name === 'notification actually shown');
    assert.equal(fired.ok, true);
    assert.equal(m.lastFire().via, 'serviceWorker');
    assert.ok(shown.some((s) => s.via === 'sw'), 'the service worker was the one asked');
  } finally { m.disableNotifications(); }
});

test('with no service worker it falls back to the page constructor', async () => {
  const shown = stubEnv({ withServiceWorker: false });
  const m = await load();
  await m.enableNotifications();
  try {
    await m.selfTest();
    assert.equal(m.lastFire().via, 'page');
    assert.equal(m.lastFire().ok, true);
    assert.ok(shown.some((s) => s.via === 'page'));
  } finally { m.disableNotifications(); }
});

test('ANDROID: no service worker and a throwing constructor is a REPORTED failure, not a silent one', async () => {
  // Chrome on Android has not supported `new Notification()` since 2016; it throws
  // "Illegal constructor". Before 2026-08-25 that became a console.warn on a device with no
  // console open — every alert lost, and nothing anywhere said so.
  stubEnv({ withServiceWorker: false, constructorThrows: true });
  const m = await load();
  await m.enableNotifications();
  try {
    const st = await m.selfTest();
    const fired = st.checks.find((c) => c.name === 'notification actually shown');
    assert.equal(fired.ok, false);
    assert.equal(st.ok, false, 'the whole self-test must fail, not just one line');
    assert.match(m.lastFire().error || '', /Illegal constructor/);
  } finally { m.disableNotifications(); }
});

test('a service worker rescues the Android case the page constructor cannot', async () => {
  // Same throwing constructor, but a registration present: this is the actual fix.
  const shown = stubEnv({ withServiceWorker: true, constructorThrows: true });
  const m = await load();
  await m.enableNotifications();
  try {
    await m.selfTest();
    assert.equal(m.lastFire().ok, true);
    assert.equal(m.lastFire().via, 'serviceWorker');
    assert.ok(shown.every((s) => s.via === 'sw'));
  } finally { m.disableNotifications(); }
});

test('permission not granted is reported before anything else is blamed', async () => {
  stubEnv({ permission: 'denied' });
  const m = await load();
  const st = await m.selfTest();
  const perm = st.checks.find((c) => c.name === 'permission granted');
  assert.equal(perm.ok, false);
  assert.equal(perm.detail, 'denied');
  assert.equal(st.ok, false);
});

test('a session with no worker URL says the poll has never run', async () => {
  // This is the defect found in plan-water-ui.js on 2026-08-25: loadSessionFromPlan was called
  // without { worker }, so pollHazards() returned on its first line every five minutes forever
  // while the Smart Plan path polled correctly. The self-test has to NAME that, because from
  // the outside a poll that never runs looks exactly like a sky with no weather in it.
  stubEnv();
  const m = await load();
  await m.enableNotifications();
  try {
    m.loadSessionFromPlan({ legs: [], spots: [] }, { weatherByHour: null });
    const st = await m.selfTest();
    const cfg = st.checks.find((c) => c.name === 'hazard poll configured');
    assert.equal(cfg.ok, false);
    assert.match(cfg.detail, /without \{ worker \}|no worker URL/);
  } finally { m.disableNotifications(); }
});

test('given a worker and a launch point, the poll is configured and the endpoint is exercised', async () => {
  stubEnv();
  const m = await load();
  await m.enableNotifications();
  try {
    m.loadSessionFromPlan({ legs: [], spots: [] }, {
      weatherByHour: null,
      worker: 'https://worker.example/',
      launch: { lat: 34.05, lon: -81.22 },
    });
    const st = await m.selfTest();
    assert.equal(st.checks.find((c) => c.name === 'hazard poll configured').ok, true);
    // The trailing slash is stripped when the session is loaded, so the URL cannot be built
    // with a double slash that some hosts 404.
    assert.equal(st.checks.find((c) => c.name === 'hazard poll configured').detail,
                 'https://worker.example');
    assert.equal(st.checks.find((c) => c.name === 'hazard endpoint answers').ok, true);
  } finally { m.disableNotifications(); }
});

// ── WHAT THE WATCH ACTUALLY CARRIES ─────────────────────────────────────────────────────────
//
// Ryan's self-test on 2026-08-26 read `trip watch armed true, 1 cue(s), 2 device(s), until
// 2026-08-25T19:00:00.000Z`. Both numbers were wrong in the same direction: the window had
// already closed, and the one cue was the return-time warning. The bite windows and the day's
// clock came from `window._trollmapSolunar` and `window._trollmapPhases`, written by the v1
// builder and by nothing at all respectively.

function watchPosts() {
  const posts = [];
  const prior = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/alerts/watch')) {
      posts.push(JSON.parse((init && init.body) || '{}'));
      return { ok: true, status: 200,
               json: async () => ({ ok: true, until: null, cues: 0, devices: 1 }) };
    }
    return prior(url, init);
  };
  return posts;
}

const PLAN = { legs: [], spots: [] };
const AT_LAUNCH = { worker: 'https://w.example', launch: { lat: 34.38, lon: -80.73 } };

test('the bite windows travel with the watch instead of waiting on a window global', async () => {
  stubEnv();
  const posts = watchPosts();
  const m = await load();
  await m.enableNotifications();
  try {
    m.loadSessionFromPlan(PLAN, { ...AT_LAUNCH, date: '2026-09-01', returnTime: '15:00',
      solunar: { major1: 7.5, major2: 19.5, minor1: 1.5, minor2: 13.5 } });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(posts.length, 1, 'exactly one watch was registered');
    const majors = posts[0].cues.filter((c) => c.title === 'Solunar Major');
    assert.equal(majors.length, 2, 'both majors, not zero');
    const first = new Date(majors[0].at);
    assert.equal(first.getHours(), 7);
    assert.equal(first.getMinutes(), 30);
  } finally { m.disableNotifications(); }
});

test('every cue is placed on the day being FISHED, not the day the plan was built', async () => {
  // The bug exactly: hours-of-day resolved against local midnight of the build day, so a plan
  // made the night before armed a watch that the next cron sweep deleted as expired.
  stubEnv();
  const posts = watchPosts();
  const m = await load();
  await m.enableNotifications();
  try {
    m.loadSessionFromPlan(PLAN, { ...AT_LAUNCH, date: '2026-09-01', returnTime: '15:00',
      solunar: { major1: 7.5, major2: 19.5 } });
    await new Promise((r) => setTimeout(r, 20));
    const until = new Date(posts[0].until);
    assert.equal(until.getFullYear(), 2026);
    assert.equal(until.getMonth(), 8);           // September, zero-based
    assert.equal(until.getDate(), 1);
    assert.equal(until.getHours(), 15);
    for (const c of posts[0].cues) assert.equal(new Date(c.at).getDate(), 1);
  } finally { m.disableNotifications(); }
});

test('no solunar handed over means no solunar cues, silently invented by nothing', async () => {
  stubEnv();
  const posts = watchPosts();
  const m = await load();
  await m.enableNotifications();
  try {
    m.loadSessionFromPlan(PLAN, { ...AT_LAUNCH, date: '2026-09-01', returnTime: '15:00' });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(posts[0].cues.filter((c) => c.title === 'Solunar Major').length, 0);
    assert.equal(posts[0].cues.length, 1, 'the return-time warning, and only that');
  } finally { m.disableNotifications(); }
});

test('a plan with no date still arms, against today, rather than throwing', async () => {
  stubEnv();
  const posts = watchPosts();
  const m = await load();
  await m.enableNotifications();
  try {
    m.loadSessionFromPlan(PLAN, { ...AT_LAUNCH, returnTime: '23:30' });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(posts.length, 1);
    const until = new Date(posts[0].until);
    assert.equal(until.getDate(), new Date().getDate());
  } finally { m.disableNotifications(); }
});
