/**
 * ONE READ FOR THE STATE OF THE WATER.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 2026-08-16: *"i will almost never want anything alongside... i hate the bolt on
 * approach... merge reduce make better, make it smarter are almost always going to be my
 * answer."*
 *
 * WHAT THIS REPLACES, and it is three separate answers to one question:
 *
 *   utility-sync.js   UTILITY_FEEDS — SEVEN lakes, hand-typed `normalPool` and `minPool`,
 *                     then /lake, then the Duke dashboard, then USGS, each with its own
 *                     idea of what "level" means. Duke lakes came back as a PERCENT and
 *                     everything else as FEET, in the same form field.
 *   plan-builder.js   fetchDamLevels() plus a Duke/Dominion/Santee if-chain, matched with
 *                     `lakeLower.includes(k.split(' ')[1])` — the second word of the feed
 *                     name. "mountain island" reduces to `island`, so any water whose name
 *                     contains it took Mountain Island Lake's elevation.
 *   Worker            /conditions, which already resolves all of this from
 *                     water_bindings.json — 147 bound lakes, 19 with a live operator feed —
 *                     and which NOTHING IN THE APP HAS EVER CALLED.
 *
 * ONE UNIT: FEET BELOW FULL POOL. The percent scale was never a measurement, it was Duke's
 * display convention — a hundred-foot band hung under full pond, so 98.00 means two feet
 * down. The Worker converts it in normalizeDukeRow, so a percent never has to leave the feed.
 * A lake is not more or less drawn down because of who owns the dam.
 *
 * THE DRAWDOWN IS THE ANSWER, not `level - full`. Brookfield's Chilhowee and Calderwood
 * publish feet-below-full-pool and no absolute elevation at all, so a consumer that subtracts
 * two numbers gets nothing on those lakes while the number it wanted sits right there.
 *
 * Pure but for `fetchWaterConditions`, which takes its fetch. No DOM, no Leaflet, no globals —
 * so it can be tested.
 */

/** Celsius to Fahrenheit, one decimal. Null in, null out. */
export function cToF(c) {
  return Number.isFinite(c) ? Math.round((c * 9 / 5 + 32) * 10) / 10 : null;
}

/**
 * The /conditions URL for a lake record.
 *
 * lat and lon are REQUIRED by the route and the reason is written into its 400: the Worker has
 * no lake registry, and the client already knows the centroid it selected.
 */
export function conditionsUrl(worker, rec, opts = {}) {
  if (!worker || !rec || !rec.slug) return null;
  const lat = Number(rec.lat);
  const lon = Number(rec.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const p = new URLSearchParams({ lat: String(lat), lon: String(lon) });
  if (opts.date) p.set('date', opts.date);
  if (Number.isFinite(opts.tz)) p.set('tz', String(opts.tz));
  // The registry changes when the PIPELINE uploads, not when the Worker deploys, so a new
  // binding is invisible for up to an hour without this. See handleConditions.
  if (opts.fresh) p.set('fresh', '1');
  return `${String(worker).replace(/\/+$/, '')}/conditions/${encodeURIComponent(rec.slug)}?${p}`;
}

/** The first gauge carrying a temperature, and which one it was. Pool, then tailwater, then
 *  the nearest. A tailwater temperature is the river below the dam and is labelled as such
 *  rather than being passed off as the lake's. */
export function pickWaterTemp(water) {
  if (!water) return { f: null, from: null, name: null };
  for (const role of ['pool', 'tailwater', 'gauge']) {
    const g = water[role];
    const f = cToF(g && g.water_temp_c);
    if (f != null) return { f, from: role, name: (g && g.name) || null };
  }
  return { f: null, from: null, name: null };
}

/**
 * The conditions envelope as the three numbers a trip needs, or a stated reason there are none.
 *
 * `pending` and a null level are DIFFERENT from a level of zero, and both are different from a
 * failed request. Every one of those has bitten this codebase, so each gets its own field.
 */
export function readConditions(j) {
  const out = {
    ok: false,
    slug: (j && j.slug) || null,
    displayName: null,
    levelFt: null,
    fullPoolFt: null,
    belowFullPoolFt: null,
    levelSource: null,
    levelUrl: null,
    feedName: null,
    observedAt: null,
    waterTempF: null,
    waterTempFrom: null,
    waterTempGauge: null,
    usaceTargetFt: null,
    usaceProject: null,
    flowCfs: null,
    flowGauge: null,
    stageFt: null,
    clarity: null,
    clarityScore: null,
    clarityIsMeasured: false,
    clarityNote: null,
    releases: null,
    featureType: null,
    pending: null,
    error: null,
  };
  if (!j || typeof j !== 'object') { out.error = 'no response'; return out; }
  if (j.error) { out.error = String(j.error); return out; }
  out.ok = true;

  const w = j.water || null;
  if (!w) {
    // `water: null` means the slug is not in water_bindings.json at all, which is a registry
    // gap and not a quiet zero. handleConditions puts the fix in `pending`.
    out.pending = (j.pending && j.pending.water) || 'this water is not bound in the registry';
    return out;
  }
  out.displayName = w.display_name || null;
  out.featureType = w.feature_type || null;

  const cd = w.chart_datum || null;
  if (cd) {
    out.levelFt = Number.isFinite(cd.level_ft) ? cd.level_ft : null;
    out.fullPoolFt = Number.isFinite(cd.full_pool_ft) ? cd.full_pool_ft : null;
    out.belowFullPoolFt = Number.isFinite(cd.below_full_pool_ft) ? cd.below_full_pool_ft : null;
    out.levelSource = cd.source || null;
    // ONLY chart_datum's own. The operator path already writes the feed row into `source`
    // ("Brookfield / safewaters.com — Chilhowee"), so reading w.operator.feed_name as a
    // fallback prints the same name twice.
    out.feedName = cd.feed_name || null;
    out.pending = cd.pending || null;
  }
  if (w.operator) {
    if (w.operator.observed_at) out.observedAt = w.operator.observed_at;
    // The page a person can open to check the number themselves. Only from the operator,
    // because that is the only source here that publishes a per-lake page.
    if (w.operator.url) out.levelUrl = w.operator.url;
  }

  const t = pickWaterTemp(w);
  out.waterTempF = t.f;
  out.waterTempFrom = t.from;
  out.waterTempGauge = t.name;

  // REPORTED, NEVER SUBTRACTED. The Corps publishes what the lake is SUPPOSED to be at today;
  // turning that into a drawdown needs an elevation from a gauge whose vertical datum is not
  // guaranteed to be the Corps'. It rides along so a person can see both numbers.
  if (w.usace && Number.isFinite(w.usace.conservation_pool_ft)) {
    out.usaceTargetFt = w.usace.conservation_pool_ft;
    out.usaceProject = w.usace.project || null;
  }
  // FLOW AND STAGE, for a river. The pool gauge is the lake; on a river the nearest gauge is
  // the water you are on. Flow is the number that decides a river trip and it is separate from
  // level -- a river can be at a normal stage and pushing 8,000 cfs.
  for (const role of ['gauge', 'tailwater', 'pool']) {
    const g = w[role];
    if (!g) continue;
    if (out.flowCfs == null && Number.isFinite(g.flow)) { out.flowCfs = g.flow; out.flowGauge = g.name || null; }
    if (out.stageFt == null && Number.isFinite(g.stage)) out.stageFt = g.stage;
  }

  out.releases = w.releases || null;

  // CLARITY IS A MODEL AND THE FLAG SAYS SO. `measured` non-null means a WQP Secchi or
  // turbidity baseline exists and the rainfall model adjusted it; null means the number is
  // rainfall and hand-authored zone offsets alone. Ryan should never see a modelled figure
  // printed the way a gauge reading is printed -- absence of data is not clear water, which is
  // the sentence the Worker itself puts in `measuredNote`.
  const cl = j.clarity || null;
  if (cl && cl.overall) {
    out.clarity = cl.overall.clarity || null;
    out.clarityScore = Number.isFinite(cl.overall.score) ? cl.overall.score : null;
    out.clarityIsMeasured = !!cl.measured;
    out.clarityNote = cl.measuredNote || null;
  }
  return out;
}

/** One request. `fetchImpl` is injectable so this is testable without a network. */
export async function fetchWaterConditions(worker, rec, opts = {}) {
  const url = conditionsUrl(worker, rec, opts);
  if (!url) return { ...readConditions(null), error: 'no slug or centroid for this water' };
  const impl = opts.fetch || (typeof fetch === 'function' ? fetch : null);
  if (!impl) return { ...readConditions(null), error: 'no fetch available' };
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), opts.timeoutMs || 12000) : null;
  try {
    const r = await impl(url, ctl ? { signal: ctl.signal } : undefined);
    const j = await r.json();
    const read = readConditions(j);
    if (!r.ok && !read.error) read.error = `HTTP ${r.status}`;
    return read;
  } catch (e) {
    return { ...readConditions(null), error: String((e && e.message) || e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One sentence naming the number and where it came from, or why there is none. */
export function levelSentence(c) {
  if (!c) return 'No lake-level source was consulted.';
  if (c.error) return `Lake level lookup failed: ${c.error}`;
  if (c.belowFullPoolFt == null && c.levelFt == null) {
    return c.pending || 'No source publishes a level for this water.';
  }
  const bits = [];
  if (c.levelFt != null) bits.push(`${c.levelFt.toFixed(2)} ft`);
  if (c.belowFullPoolFt != null) {
    const d = c.belowFullPoolFt;
    bits.push(d === 0 ? 'at full pool'
      : d > 0 ? `${d.toFixed(2)} ft below full pool`
              : `${Math.abs(d).toFixed(2)} ft above full pool`);
  }
  if (c.fullPoolFt != null) bits.push(`full pool ${c.fullPoolFt} ft`);
  const src = c.feedName ? `${c.levelSource} — ${c.feedName}` : c.levelSource;
  return `${bits.join(' · ')}${src ? ` (${src})` : ''}`;
}

/**
 * The one line that fits in a topbar, and the reason each piece earns its place.
 *
 * Ryan, 2026-08-16, on what he wants to know BEFORE he starts planning: *"current level,
 * current water temp, current water clarity... and if it is a river current flow rate and
 * projected releases if applicable."*
 *
 * So a river leads with FLOW, not level: a river at a normal stage pushing 8,000 cfs is a
 * different trip from the same stage at 400, and the stage alone does not say which. A lake
 * leads with the drawdown, because that is the number that decides whether the ramp works.
 *
 * A modelled clarity carries `~`. It is one character and it is the difference between a
 * reading and a guess.
 */
export function conditionsStrip(c) {
  if (!c) return { text: 'No water selected', tone: 'idle' };
  if (c.error) return { text: `Conditions unavailable — ${c.error}`, tone: 'bad' };

  const isRiver = c.featureType === 'river';
  const bits = [];

  if (isRiver && c.flowCfs != null) {
    bits.push(`${Math.round(c.flowCfs).toLocaleString()} ft³/s`);
    if (c.stageFt != null) bits.push(`${c.stageFt.toFixed(1)} ft stage`);
  } else if (c.belowFullPoolFt != null) {
    const b = c.belowFullPoolFt;
    bits.push(Math.abs(b) < 0.05 ? 'at full pool'
      : b > 0 ? `${b.toFixed(2)} ft down` : `${Math.abs(b).toFixed(2)} ft up`);
  } else if (c.levelFt != null) {
    bits.push(`${c.levelFt.toFixed(2)} ft`);
  }

  if (c.waterTempF != null) {
    // A tailwater temperature is the river below the dam. One character rather than silence.
    bits.push(`${c.waterTempF}°F${c.waterTempFrom === 'tailwater' ? '*' : ''}`);
  }
  if (c.clarity) bits.push(`${c.clarityIsMeasured ? '' : '~'}${c.clarity}`);

  // Only a PROJECTION gets a place in the strip. An observed discharge is already the flow
  // number two fields to the left, and printing it again as though it were a schedule is the
  // mistake `kind` exists to prevent.
  if (c.releases && c.releases.kind === 'projected' && c.releases.next) {
    const n = c.releases.next;
    bits.push(`release → ${n.mileMarkerName || n.damName || 'downstream'}`);
  }

  if (!bits.length) {
    return { text: c.pending || 'No source publishes conditions for this water', tone: 'idle' };
  }
  const src = c.levelSource ? c.levelSource.split(' — ')[0] : null;
  return {
    text: bits.join(' · ') + (src ? ` · ${src}` : ''),
    tone: 'ok',
    // The strip cannot carry a caveat, so it carries a mark and the expanded card explains it.
    footnotes: [
      c.waterTempFrom === 'tailwater' ? '* water temperature is from the tailwater gauge, below the dam — not the lake' : null,
      c.clarity && !c.clarityIsMeasured ? '~ clarity is modelled from rainfall, not measured — absence of data is not clear water' : null,
    ].filter(Boolean),
  };
}
