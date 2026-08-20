import { describe, it, expect } from './expect-shim.mjs';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(path.join(ROOT, 'js/modules/smart-plan-route.js'), 'utf8');
// smart-plan.js carried these assertions until v1 was deleted on 2026-08-20. Scanning the whole
// js/ tree instead of one file is strictly stronger: the walker cannot come back ANYWHERE.
const JS_SRC = (function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const q = path.join(dir, e);
    if (statSync(q).isDirectory()) walk(q, out);
    else if (e.endsWith('.js')) out.push([path.relative(ROOT, q), readFileSync(q, 'utf8')]);
  }
  return out;
})(path.join(ROOT, 'js'));

/**
 * SmartPlan sends INTENT and receives GEOMETRY.
 *
 * The three failures Ryan described -- couldn't follow a contour, couldn't leave the boat
 * positioned for the next leg, drew connecting routes over land -- were one cause: the browser
 * built the route itself from a list of points. These assertions are about that not creeping
 * back in, because it would creep back in silently: a plan drawn over land still renders.
 */
describe('SmartPlan asks for a route instead of building one', () => {
  it('the in-browser contour walker is gone and stays gone', () => {
    // stitchContourFragments / walkContourForWaypoints / buildScoutRoutes joined contour pieces,
    // walked them dropping a waypoint every 150 ft, then connected those with straight lines and
    // a sine wave. build_trolling_runs.py does the stitching offline against the whole pack and
    // records reachability the browser could never know.
    for (const gone of ['function stitchContourFragments', 'function walkContourForWaypoints',
                        'function buildScoutRoutes']) {
      const where = JS_SRC.filter(([, code]) => code.includes(gone)).map(([f]) => f);
      expect(where.join(',') || 'none', `${gone} defined in ${where.join(', ')}`).toBe('none');
    }
  });

  it('the route comes from POST /water/{slug}/plan', () => {
    expect(/\/water\/\$\{encodeURIComponent\(slug\)\}\/plan/.test(SRC)).toBe(true);
    expect(/method:\s*'POST'/.test(SRC)).toBe(true);
  });

  it('there is NO fallback to a locally-built route', () => {
    // Falling back would keep the thing being removed alive forever, and a plan drawn over land
    // is worse than no plan. Failure must reach the user as a reason.
    // v1 surfaced this through window._smartPlanRouteError, which went with v1 on 2026-08-20.
    // v2 carries the same guarantee as a VALUE rather than a global: the fetcher returns a
    // reason and the wiring renders it, so a failure still reaches the user as words.
    const wiring = readFileSync(path.join(ROOT, 'js/modules/smart-plan-v2-wiring.js'), 'utf8');
    expect(/problems/.test(wiring)).toBe(true);
    expect(/return \{ ok: false, reason:/.test(SRC)).toBe(true);
  });

  it('coordinates are flipped exactly once, in one place', () => {
    // The Worker answers GeoJSON [lon, lat]; everything in state.DATA is [lat, lon]. This is the
    // single most likely place for the whole feature to go quietly wrong -- a flipped route
    // still draws, just in Kansas.
    const flips = [...SRC.matchAll(/\[lon,\s*lat\]\)\s*=>\s*\[lat,\s*lon\]/g)];
    expect(flips.length).toBe(1);
  });

  it('the launch is sent [lon, lat], matching the Worker contract', () => {
    expect(/launch:\s*\[rampLon,\s*rampLat\]/.test(SRC)).toBe(true);
  });

  it('sends ONE depth per leg, not a band', () => {
    // Garmin's contours are metric-derived: near twelve feet the charted lines are 11.2 and 12.1
    // with nothing between. The router answers with the NEAREST charted line and says which.
    // Sending a band and hoping something falls inside it is how the old code found nothing.
    expect(/depth_ft:\s*ft\b/.test(SRC)).toBe(true);
    expect(SRC.includes('depthMin') && SRC.includes('depthMax')).toBe(true);
  });

  it('does not score, rank or pick water', () => {
    // `has` and `relief` are filters. Which water is worth fishing depends on species, season
    // and forage, and that lives in trollingIntelligence -- not in this adapter.
    //
    // SCAN CODE, NOT PROSE. The first version of this failed on the module's own comment saying
    // it does no scoring -- the same way check-imports.mjs once failed on its own header example.
    // Note the `m` flag: the tree is CRLF, and in JS \r is a line terminator, so /\/\/.*$/
    // WITHOUT `m` matches nothing at all and this would silently scan the comments anyway.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '')
                    .replace(/^\s*\/\/.*$/gm, '')
                    .replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const banned of ['score', 'ranking', 'bestLeg', 'relevance(']) {
      expect(code.toLowerCase().includes(banned.toLowerCase()), banned).toBe(false);
    }
  });
});
