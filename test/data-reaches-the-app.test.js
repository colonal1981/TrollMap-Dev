import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * DOES THE DATA WE BUILD ACTUALLY REACH THE APP?
 *
 * Ryan, 2026-08-07: "is there tests or audits that we could add that would catch stuff like
 * this... we made all of this data available and the client side knew nothing about it."
 *
 * It happened three times in two days, and it was invisible every time because NOTHING BROKE:
 *
 *   trolling_runs / water_features / water_graph  built, uploaded, and no client reference
 *   POST /water/{slug}/plan                       built, verified, deployed, never called --
 *                                                 SmartPlan went on stitching contours in the
 *                                                 browser instead
 *   structure.geojson                             in every pack, while lake-research-engine.js
 *                                                 re-derived humps and ledges from raw contours
 *
 * A second, better implementation landing in the pipeline does not make the first one fail. It
 * makes it REDUNDANT, silently, and the only symptom is that the answers are worse than the
 * data supports. No exception is thrown, no test goes red, and the progress bar still says the
 * step succeeded.
 *
 * So: assert the WIRING, not the behaviour. Every layer we pay to build and store must be read
 * by something, every layer the app fetches must be something we ship, and every Worker route
 * must have a caller. Where one of those is legitimately unwired, it goes in an allowlist WITH
 * A REASON — which turns an invisible gap into a line someone has to justify deleting.
 */

const py = (f) => readFileSync(path.join(ROOT, 'Scripts', f), 'utf8');

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith('.js') || e.endsWith('.mjs')) out.push(p);
  }
  return out;
}
const SOURCES = [...walk(path.join(ROOT, 'js')), ...walk(path.join(ROOT, 'Worker'))];
const CODE = SOURCES.map((f) => readFileSync(f, 'utf8')).join('\n');
const whoReads = (needle) =>
  SOURCES.filter((f) => readFileSync(f, 'utf8').includes(needle))
         .map((f) => path.relative(ROOT, f));

// ── the uploader is the source of truth for what reaches R2 ─────────────────────────────────
const UP = py('upload_garmin_to_r2.py');
const LAYERS = Object.fromEntries(
  [...UP.matchAll(/^\s*"([a-z_]+)":\s*"([^"]+)",/gm)].map((m) => [m[1], m[2]]));
const PIPELINE_ONLY = new Set(
  (UP.match(/PIPELINE_ONLY\s*=\s*\{([^}]*)\}/)?.[1] || '')
    .split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean));

// THERE IS MORE THAN ONE UPLOADER. upload_to_r2_coastal.py ships the i-Boating supplementals --
// including `shoreline.geojson`, which is NOT the same file as `garmin_shoreline.geojson` and
// exists for coastal zones only. Reading just the Garmin uploader made this test call a real
// coastal layer an orphan; reading just the coastal one would do the reverse.
const COASTAL_UP = (() => { try { return py('../scripts/upload_to_r2_coastal.py'); } catch { return ''; } })();
const COASTAL_LAYERS = new Set(
  [...COASTAL_UP.matchAll(/^\s*'([A-Za-z0-9_.-]+\.geojson)',/gm)].map((m) => m[1]));

describe('every layer we upload is read by something', () => {
  it('the uploader still declares a layer map this test can read', () => {
    // If this ever goes empty the rest of the file passes vacuously, which is the failure mode
    // it exists to prevent. A green check that never ran is worse than a red one.
    expect(Object.keys(LAYERS).length > 8).toBe(true);
    expect(PIPELINE_ONLY.size > 0).toBe(true);
  });

  // A layer uploaded and never read is bytes in R2, bandwidth on a boat ramp, and a build step
  // whose output nobody sees. Every entry here needs a reason, not a shrug.
  const UNREAD_OK = {
    boundary: 'uploaded by upload_boundaries_to_r2.py and fetched by resolveBoundaryKey with a '
            + '_3dhp suffix, so the bare filename never appears in source',
    areas: 'legacy i-Boating layer, opt-in only, never named in a --layers run',
    depth_regions: 'legacy i-Boating layer, opt-in only',
    waterbodies: 'legacy plural spelling kept so old manifests still resolve',
  };

  for (const [key, file] of Object.entries(LAYERS)) {
    if (PIPELINE_ONLY.has(key)) continue;
    it(`${file} has a consumer`, () => {
      // Match the FILENAME or the layer KEY. The client composes its URLs -- fetchSupplemental()
      // builds `${layer}.geojson` from a GARMIN_LAYERS key -- so a literal filename search sees
      // nothing and calls a perfectly wired layer an orphan. That false positive is worse than
      // no test, because the next person deletes a live layer to make the suite green.
      const readers = whoReads(file).concat(whoReads(`${key}:`)).concat(whoReads(`'${key}'`));
      if (readers.length) return;
      expect(UNREAD_OK[key] ? `allowed: ${UNREAD_OK[key]}` : `${file} is uploaded to R2 and `
        + `nothing in js/ or Worker/ reads it. Either wire it up or add it to UNREAD_OK with a `
        + `reason.`).toBe(UNREAD_OK[key] ? `allowed: ${UNREAD_OK[key]}` : 'a consumer');
    });
  }
});

describe('every layer the app fetches is one we actually ship', () => {
  it('no chartpack fetch names a layer the uploader does not upload', () => {
    // The other direction: a client fetching a file that no uploader writes 404s forever, and a
    // 404 on an optional layer looks exactly like "this lake has none of that".
    const shipped = new Set([...Object.values(LAYERS), ...COASTAL_LAYERS]);
    const fetched = new Set(
      [...CODE.matchAll(/chartpacks\/\$\{[^}]+\}\/([A-Za-z0-9_.-]+\.(?:geojson|bin))/g)]
        .map((m) => m[1]));
    const KNOWN_EXTERNAL = new Set([
      'osm-structures.geojson',      // fetch_osm_structures.py
      'oyster_beds.geojson',         // trollmap_pipeline_coastal.py
      'marsh_edges.geojson',         // trollmap_pipeline_coastal.py
      'depth_soundings.geojson',     // trollmap_pipeline_coastal.py
      'fishing_lines.geojson', 'fishing_points.geojson', // i-Boating supplementals
    ]);
    const orphans = [...fetched].filter((f) => !shipped.has(f) && !KNOWN_EXTERNAL.has(f));
    expect(orphans).toEqual([]);
  });
});

describe('every Worker route has a caller', () => {
  // This is the one that would have caught SmartPlan. POST /water/{slug}/plan was built,
  // verified against Wateree, deployed, and called by nobody for a day while the browser went
  // on stitching contours itself.
  const ROUTE_FILES = ['water.js', 'conditions.js', 'cameras.js'];
  const UNCALLED_OK = {
    '/conditions/': 'Phase 2. The envelope returns water:null and tide:null until '
                  + 'water_bindings.json is in R2, so there is nothing to call it for yet. '
                  + 'Tracked in 00_START_HERE.md under Also open.',
  };

  for (const f of ROUTE_FILES) {
    const src = readFileSync(path.join(ROOT, 'Worker', f), 'utf8');
    // The route inventory each module exports, e.g. WATER_ROUTES.
    const listed = [...src.matchAll(/'(?:POST\s+)?(\/[a-z-]+)\//g)].map((m) => m[1] + '/');
    const prefixes = [...new Set(listed)];
    for (const prefix of prefixes) {
      it(`${f}: something calls ${prefix}`, () => {
        const callers = SOURCES
          .filter((s) => s.includes(`${path.sep}js${path.sep}`))
          .filter((s) => readFileSync(s, 'utf8').includes(prefix))
          .map((s) => path.relative(ROOT, s));
        if (callers.length) return;
        expect(UNCALLED_OK[prefix]
          ? `allowed: ${UNCALLED_OK[prefix]}`
          : `${prefix} is served by Worker/${f} and no file in js/ calls it. The Worker is doing `
          + `work nobody asked for. Wire it, or add it to UNCALLED_OK with a reason.`)
          .toBe(UNCALLED_OK[prefix] ? `allowed: ${UNCALLED_OK[prefix]}` : 'a caller');
      });
    }
  }
});

describe('the client does not re-derive what the pipeline already built', () => {
  // The third shape of the same bug: not an unread layer or an uncalled route, but a browser
  // reimplementation of a pipeline step, sitting next to the file it should be reading.
  const BANNED = [
    { fn: 'function stitchContourFragments',
      why: 'build_trolling_runs.py stitches contours offline; the browser version could not '
         + 'know whether a run was reachable from water' },
    { fn: 'function walkContourForWaypoints',
      why: 'POST /water/{slug}/plan returns validated geometry; walking contours in the browser '
         + 'is what drew connecting lines over land' },
    { fn: 'function deriveContourStructures',
      why: 'build_structure.py derives humps from contour NESTING and ships structure.geojson; '
         + 'the browser version grid-bucketed centroids and kept 8 per lake per research run' },
  ];
  for (const { fn, why } of BANNED) {
    it(`${fn}() has not come back`, () => {
      const found = SOURCES.filter((f) => readFileSync(f, 'utf8').includes(fn))
                           .map((f) => path.relative(ROOT, f));
      expect(found.length ? `${found.join(', ')} — ${why}` : 'gone').toBe('gone');
    });
  }
});

/**
 * A PLACEHOLDER PAINTED INTO MARKUP THAT DOES NOT EXIST IS THE SAME BUG, ONE LAYER IN.
 *
 * utility-sync.js wrote to `utilityAssessmentBox`, `utilitySyncStatus`, `uTitle`, `uDesc`,
 * `uLink` and `syncDukeBtn` for months. All six appear ZERO times in index.html. Nothing threw,
 * nothing went red, and the only symptom was that Ryan could not find the data anywhere in the
 * app — which is indistinguishable from never having fetched it.
 *
 * The conditions strip added a camera placeholder on 2026-08-16: cardHtml() emits a
 * `.cond-cams` div and fillCameras() finds it afterwards. Two halves in one file, either of
 * which can be renamed without the other noticing.
 *
 * SCOPED ON PURPOSE. Widening this to every getElementById in every module is a real audit and
 * a separate job; this covers the surface that has already failed this way once.
 */
describe('the markup a module writes into is markup that exists', () => {
  const strip = readFileSync(path.join(ROOT, 'js/modules/conditions-strip.js'), 'utf8');
  const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  it('every element the strip looks up by id is in index.html', () => {
    const ids = [...strip.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    const missing = ids.filter((id) => !new RegExp(`id=["']${id}["']`).test(html));
    expect(missing).toEqual([]);
  });

  it('the camera placeholder is emitted by the same file that fills it', () => {
    expect(strip).toContain('class="cond-cams"');
    expect(strip).toContain(".querySelector('.cond-cams')");
  });

  it('and the card is repainted through the function that emits it', () => {
    // cardHtml() writes the placeholder; if nothing calls fillCameras after that innerHTML,
    // the card says "reading N live views" forever.
    expect(/e\.card\.innerHTML = cardHtml\(rec, c\)[\s\S]{0,120}fillCameras\(/.test(strip)).toBe(true);
  });

  it('the images carry the class their error handler binds to', () => {
    expect(strip).toContain('class="cond-cam-img"');
    expect(strip).toContain("querySelectorAll('.cond-cam-img')");
  });
});


/**
 * THE SAME TEST, POINTED AT THE FILE THAT HAS 57 ROUTES IN IT.
 *
 * The block above covers water.js, conditions.js and cameras.js — the three modules that export a
 * route inventory. `trollmap-worker.js` exports none and was never checked, and it is where the
 * app's original API lives. Ryan, 2026-08-17: *"whats next on the list of hard coded things that
 * never got expanded when the app grew."* Measuring `LAKES` to answer that found its only public
 * door, `/lake`, has no caller at all — the route `resolveLake()` exists to serve.
 *
 * THE MATCHER IS THE WHOLE TEST, and three separate things fooled a loose one:
 *
 *   /lake-intel, /lakes/     a substring match says /lake is called. It is not.
 *   /\/lakes\/[^/]+\/regs/   a regex literal in lake-research-engine.js is not a fetch.
 *   "a `/lake` call"         a COMMENT in utility-sync.js describing what it used to do.
 *
 * So: comments are stripped first, the route must be preceded by a quote, a backtick or the `}`
 * that closes `${worker}`, and followed by something that is not a word character. That admits
 * both `fetch(`${worker}/lake-clarity?...`)` and the `{ path: '/ramps' }` table in
 * access-index.js, and refuses prose and regexes.
 *
 * A route with no caller is not automatically a bug — some are curled by hand and some are
 * reached through internal functions rather than over HTTP. But it must be SAID, with a reason,
 * which is what UNCALLED_OK is. The list below is the running tab; nothing here is deleted until
 * Ryan does the deletion pass.
 */
describe('every route in trollmap-worker.js has a caller', () => {
  const WORKER = readFileSync(path.join(ROOT, 'Worker/trollmap-worker.js'), 'utf8');

  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

  const CLIENT = SOURCES
    .filter((f) => f.includes(`${path.sep}js${path.sep}`))
    .map((f) => [path.relative(ROOT, f), stripComments(readFileSync(f, 'utf8'))]);

  const routes = [...new Set([
    ...[...WORKER.matchAll(/path\s*===\s*["'](\/[A-Za-z0-9_\-/]+)["']/g)].map((m) => m[1]),
    ...[...WORKER.matchAll(/path\.startsWith\(\s*["'](\/[A-Za-z0-9_\-/]+)["']/g)].map((m) => m[1]),
  ])].sort();

  // Reached over HTTP by something that is not the browser, or reached internally.
  const UNCALLED_OK = {
    '/build': 'curled by hand — it is how the deployed version gets checked. AUDIT_FINDINGS_2026-08-06.',
    '/dominion-saluda': 'the ROUTE is unreferenced but assessKayakSafety() calls the function behind it. '
                      + 'AUDIT_FINDINGS_2026-08-06.',
    '/duke-flow-arrivals': 'same — internal caller, not an HTTP one. conditions.js imports '
                         + 'fetchDukeFlowArrivals directly.',
    '/debug/regs-cache': 'a debug route, curled by hand when the regulations digest looks wrong.',

    // ── no caller, no internal use found. THE RUNNING TAB. ────────────────────────────────────
    // '/lake' was here from 2026-08-17 with the note "Deletion tab". Deleted 2026-08-25, along
    // with the CWMS_PROJECT table, the water.sas.usace.army.mil scrape and the Santee Cooper
    // reader that only it reached. The tab worked; it just needed someone to act on it.
    '/duke': 'no caller, and fetchDukeDashboard() behind it has no other caller either — unlike '
           + '/duke-flow-arrivals, whose function conditions.js imports directly. It is a raw '
           + 'per-basin dump advertised in this Worker\'s own route help, so it reads as a '
           + 'hand-curled debug door rather than a mistake. Same tab as /lake was on: it works, '
           + 'nothing asks for it, and it needs a decision rather than a guess. Its `?duke` '
           + 'search-param trigger — which hijacked ANY path carrying that parameter — was '
           + 'removed 2026-08-25.',
    '/lake-research': 'no caller. Superseded by /research/get, which three modules do call.',
    '/lake-intel-sources': 'no caller. Goes with LAKE_INTEL_SOURCE_REGISTRY, already on the tab.',
    '/lakes/': 'no caller. A shortcut alias for /research/get.',
    '/lakes/list': 'no caller. Alias of /research/list, which research-ids.js does call.',
    '/chartpacks/list': 'no caller. The client lists packs from the registry index instead.',
    '/rivers': 'no caller. Would return Object.keys(RIVERS) — the 6-of-90 menu.',
    '/sync/migrate': 'no caller. A one-shot schema migration.',
    '/usgs': 'no caller. Every USGS read now goes through /conditions or the research engine.',

    // ── research routes with no BROWSER caller; some may be operator-curled during a run ──────
    '/research/approve': 'no client caller — may be curled during a research run. Needs a decision.',
    '/research/dataset-hunt': 'no client caller. Needs a decision.',
    '/research/gap-analysis': 'no client caller. Needs a decision.',
    '/research/gap-search': 'no client caller. Needs a decision.',
    '/research/map-facts': 'no client caller. Needs a decision.',
    '/research/shared/publish': 'no client caller. The shared store is written through /shared/store.',
    '/research/shared/quarantine': 'no client caller. Needs a decision.',
    '/research/shared/status': 'no client caller. Needs a decision.',
    '/research/thermocline-search': 'no client caller. /research/limnology-data is the one that runs.',
  };

  const callersOf = (route) => {
    const re = new RegExp(`(?<=['"\`}])${route.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?![A-Za-z0-9_-])`);
    return CLIENT.filter(([, src]) => re.test(src)).map(([f]) => f);
  };

  for (const route of routes) {
    it(`something calls ${route}`, () => {
      const callers = callersOf(route);
      if (callers.length) return;
      expect(UNCALLED_OK[route]
        ? `allowed: ${UNCALLED_OK[route]}`
        : `${route} is served by Worker/trollmap-worker.js and no file in js/ calls it. The Worker `
        + `is doing work nobody asked for. Wire it, or add it to UNCALLED_OK with a reason.`)
        .toBe(UNCALLED_OK[route] ? `allowed: ${UNCALLED_OK[route]}` : 'a caller');
    });
  }

  // AN ALLOWLIST THAT OUTLIVES ITS ROUTE IS A LIE THAT READS AS DUE DILIGENCE. When a route is
  // finally deleted, its excuse has to go with it.
  it('no allowlist entry names a route that no longer exists', () => {
    const gone = Object.keys(UNCALLED_OK).filter((r) => !routes.includes(r));
    expect(gone).toEqual([]);
  });

  // And an entry that stops being needed must not sit there implying the route is dead.
  it('no allowlist entry covers a route that IS called', () => {
    const stale = Object.keys(UNCALLED_OK).filter((r) => callersOf(r).length);
    expect(stale).toEqual([]);
  });
});
