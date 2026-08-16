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
    waterTempSite: null,
    usaceTargetFt: null,
    usaceProject: null,
    flowCfs: null,
    flowGauge: null,
    stageFt: null,
    clarity: null,
    turbidityFnu: null,
    turbidityGauge: null,
    oxygenMgL: null,
    oxygenGauge: null,
    clarityScore: null,
    clarityIsMeasured: false,
    clarityNote: null,
    releases: null,
    releasesRefused: null,
    currentKn: null,
    currentType: null,
    currentAt: null,
    currentStation: null,
    tideStation: null,
    nextTide: null,
    floodCategory: null,
    floodActionFt: null,
    stageVsActionFt: null,
    gaugeOutOfService: null,
    flowAnomaly: null,
    flowBand: null,
    flowMedian: null,
    flowYears: null,
    flowPeriod: null,
    flowAnomalyOf: null,
    generatingNow: null,
    generationNext: null,
    tvaVsGuideFt: null,
    tvaGuideFt: null,
    droughtLevel: null,
    droughtLevels: null,
    salinityPpt: null,
    conductanceUsCm: null,
    saltBasis: null,
    saltGauge: null,
    tidalFlowCfs: null,
    trend24h: null,
    trend7d: null,
    trendUnits: null,
    trendMeasures: null,
    trendCoversHours: null,
    pressureMb: null,
    pressureFrom: null,
    windMph: null,
    windDirDeg: null,
    gustMph: null,
    obsStation: null,
    obsKmAway: null,
    pressure3h: null,
    pressureStale: null,
    civilDawn: null,
    civilDusk: null,
    sunrise: null,
    sunset: null,
    moonPhase: null,
    moonIllumination: null,
    popPct: null,
    surgeFt: null,
    currentDirDeg: null,
    tvaDischargeCfs: null,
    tvaTailwaterFt: null,
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

  // `water.water_temp` is the RESOLVED answer: the Worker searches every USGS site the binding
  // knows, nearest first, because NWPS publishes no temperature at all and a lake whose pool
  // gauge is an NWPS lid can never answer this from its own gauge. Wateree is exactly that.
  // pickWaterTemp() stays as the fallback for a response from before that field existed.
  const wt = w.water_temp || null;
  if (wt && Number.isFinite(wt.f)) {
    out.waterTempF = wt.f;
    out.waterTempFrom = wt.below_dam ? 'tailwater' : (wt.role || 'gauge');
    out.waterTempGauge = wt.name || null;
    out.waterTempSite = wt.usgs_site || null;
  } else {
    const t = pickWaterTemp(w);
    out.waterTempF = t.f;
    out.waterTempFrom = t.from;
    out.waterTempGauge = t.name;
  }

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

  // A MEASURED turbidity beats a modelled clarity and is labelled differently everywhere it
  // appears. `clarity` below is a rainfall model over a historical Secchi baseline; this is an
  // instrument reading from today.
  if (w.turbidity && Number.isFinite(w.turbidity.fnu)) {
    out.turbidityFnu = w.turbidity.fnu;
    out.turbidityGauge = w.turbidity.name || null;
  }
  if (w.dissolved_oxygen && Number.isFinite(w.dissolved_oxygen.mg_l)) {
    out.oxygenMgL = w.dissolved_oxygen.mg_l;
    out.oxygenGauge = w.dissolved_oxygen.name || null;
  }

  // ── LAUNCH DECISIONS THAT WERE ALREADY ON THE RESPONSE ──────────────────────────────────
  // flood_category, flood_thresholds, in_service and out_of_service_message come back on every
  // NWPS gauge and the string never appeared anywhere in js/. "Action stage" on a river is a
  // launch decision, and a gauge that is switched off is a different answer from a gauge
  // reading zero.
  for (const role of ['pool', 'tailwater', 'gauge']) {
    const g = w[role];
    if (!g) continue;
    // NWPS says "no_flooding" when it is fine. That is an answer, not an absence, so it is kept
    // and the consumer decides whether it is worth printing.
    if (out.floodCategory == null && g.flood_category) out.floodCategory = g.flood_category;
    const act = g.flood_thresholds && g.flood_thresholds.action;
    if (out.floodActionFt == null && Number.isFinite(act)) {
      out.floodActionFt = act;
      if (Number.isFinite(g.stage)) out.stageVsActionFt = Math.round((g.stage - act) * 100) / 100;
    }
    if (!out.gaugeOutOfService && g.in_service === false) {
      out.gaugeOutOfService = { name: g.name || null, role,
                                message: g.out_of_service_message || null };
    }
  }

  // FLOW ALONE IS NOT A FACT ABOUT TODAY. 1,240 ft3/s means nothing without knowing what this
  // river usually runs. NOAA's anomaly_category is its own code and is deliberately NOT
  // translated here — the Worker refuses to guess its direction and so does this.
  // WHERE TODAY SITS IN THIS RIVER'S OWN HISTORY. This is what NOAA's anomaly_category was
  // standing in for, and it is a sentence rather than a code: "below the 10th percentile for
  // August 16, over 96 years". A band between published set points, never an interpolated
  // figure — the Worker refuses to invent one and so does this.
  const fh = w.flow_vs_history || null;
  if (fh && fh.label) {
    out.flowBand = fh.label;
    out.flowMedian = Number.isFinite(fh.median) ? fh.median : null;
    out.flowYears = Number.isFinite(fh.years) ? fh.years : null;
    out.flowPeriod = fh.period || null;
  }

  const riv = j.rivers || null;
  if (riv) {
    const best = (riv.named || []).concat(riv.unnamed || [])
      .find((r) => Number.isFinite(r.anomaly));
    if (best) {
      out.flowAnomaly = best.anomaly;
      out.flowAnomalyOf = best.name || null;
    }
  }

  // ── TVA: the generation IS the current ──────────────────────────────────────────────────
  // conditions.js says it in its own comment — "on a TVA tailwater the current is the whole
  // question" — and then nothing has ever read generating_now, generation or vs_guide_ft.
  const tva = w.tva || null;
  if (tva) {
    if (typeof tva.generating_now === 'boolean') out.generatingNow = tva.generating_now;
    const gen = Array.isArray(tva.generation) ? tva.generation : [];
    // The next entry that has units turning, not the first row of the feed.
    out.generationNext = gen.find((g) => g && g.generators > 0) || null;
    if (Number.isFinite(tva.discharge_cfs)) out.tvaDischargeCfs = tva.discharge_cfs;
    if (Number.isFinite(tva.tailwater_ft)) out.tvaTailwaterFt = tva.tailwater_ft;
    if (Number.isFinite(tva.vs_guide_ft)) out.tvaVsGuideFt = tva.vs_guide_ft;
    if (Number.isFinite(tva.guide_curve_ft)) out.tvaGuideFt = tva.guide_curve_ft;
  }

  // ── The Corps' drought state ────────────────────────────────────────────────────────────
  // A drought level is not a reading and not a target — it is the rule the lake will be run
  // under, and the Savannah district publishes the release cut in the level's own comment.
  const us = w.usace || null;
  if (us && Array.isArray(us.drought_levels) && us.drought_levels.length) {
    out.droughtLevels = us.drought_levels;
    // Which one today's elevation has actually fallen to, if any. Levels are elevations, so the
    // lake is IN a drought level when it sits at or below that level's elevation.
    const lvl = Number.isFinite(out.levelFt)
      ? us.drought_levels.filter((d) => Number.isFinite(d.ft) && out.levelFt <= d.ft)
          .sort((a, b) => a.ft - b.ft)[0] || null
      : null;
    out.droughtLevel = lvl;
  }

  // SALT. Salinity in ppt where a site publishes it, specific conductance otherwise, and
  // `saltBasis` says which — they are not the same number and the conversion between them is
  // deliberately not performed anywhere in this codebase.
  if (w.salt) {
    out.saltBasis = w.salt.basis || null;
    out.saltGauge = w.salt.name || null;
    if (Number.isFinite(w.salt.ppt)) out.salinityPpt = w.salt.ppt;
    if (Number.isFinite(w.salt.us_cm)) out.conductanceUsCm = w.salt.us_cm;
  }
  // Net flow with the tidal sloshing removed. On a tidal river the raw discharge swings sign
  // twice a day and its instantaneous value answers nothing.
  if (w.tidal_flow && Number.isFinite(w.tidal_flow.cfs)) out.tidalFlowCfs = w.tidal_flow.cfs;

  // A level is a point; a trip is a decision. Two feet down and steady is a different lake from
  // two feet down and falling.
  const tr = w.trend || null;
  if (tr) {
    if (Number.isFinite(tr.change_24h)) out.trend24h = tr.change_24h;
    if (Number.isFinite(tr.change_7d)) out.trend7d = tr.change_7d;
    out.trendUnits = tr.units || null;
    out.trendMeasures = tr.measures || null;
    out.trendCoversHours = Number.isFinite(tr.covers_hours) ? tr.covers_hours : null;
  }

  out.releases = w.releases || null;
  // A projection that was REJECTED and one that was never available are different facts, and
  // only the first one names a table entry that needs fixing. It reaches the card so a wrong
  // hand-typed basin id is visible rather than looking like a river Duke does not publish.
  out.releasesRefused = w.releases_refused || null;

  // CLARITY IS A MODEL AND THE FLAG SAYS SO. `measured` non-null means a WQP Secchi or
  // turbidity baseline exists and the rainfall model adjusted it; null means the number is
  // rainfall and hand-authored zone offsets alone. Ryan should never see a modelled figure
  // printed the way a gauge reading is printed -- absence of data is not clear water, which is
  // the sentence the Worker itself puts in `measuredNote`.
  // ── TIDE AND CURRENT ────────────────────────────────────────────────────────────────────
  // The Worker has requested currents_predictions at MAX_SLACK since tideBlock was written and
  // nothing has ever read it. On the 16 coastal zones the current is the single biggest
  // variable — slack water and a running ebb are different trips on the same tide.
  const td = j.tide || null;
  if (td) {
    out.tideStation = (td.station && (td.station.name || td.station.id)) || null;
    const now = Date.now();
    // The next event, not the first of the day. A tide table you have to read past is not an
    // answer to "what is the water doing".
    const upcoming = (td.highs_lows || [])
      .map((x) => ({ ...x, ms: Date.parse(String(x.time).replace(' ', 'T')) }))
      .filter((x) => Number.isFinite(x.ms) && x.ms >= now)
      .sort((a, b) => a.ms - b.ms);
    if (upcoming.length) {
      out.nextTide = { type: upcoming[0].type === 'H' ? 'high' : 'low',
                       ft: upcoming[0].ft, at: upcoming[0].time };
    }
    const cev = ((td.currents && td.currents.events) || [])
      .map((x) => ({ ...x, ms: Date.parse(String(x.time).replace(' ', 'T')) }))
      .filter((x) => Number.isFinite(x.ms) && x.ms >= now)
      .sort((a, b) => a.ms - b.ms);
    // MEASURED VERSUS PREDICTED, WHICH IS THE SURGE. tideBlock has fetched the measured water
    // level for the stations flagged `measured` since it was written, and its own comment says
    // why: a predicted tide is astronomy, a measured one carries the wind. On a blow that
    // difference is the whole story and nothing has ever read it.
    if (td.measured_level && Number.isFinite(td.measured_level.ft)) {
      const near = (td.highs_lows || [])
        .map((x) => ({ ...x, ms: Date.parse(String(x.time).replace(' ', 'T')) }))
        .filter((x) => Number.isFinite(x.ms) && Number.isFinite(x.ft));
      const atMs = Date.parse(String(td.measured_level.at).replace(' ', 'T'));
      // Only against a prediction close in time. Comparing a measured level with a high three
      // hours away measures the tide, not the surge.
      let best = null;
      for (const p of near) {
        if (!Number.isFinite(atMs)) break;
        if (Math.abs(p.ms - atMs) > 45 * 60 * 1000) continue;
        if (!best || Math.abs(p.ms - atMs) < Math.abs(best.ms - atMs)) best = p;
      }
      if (best) out.surgeFt = Math.round((td.measured_level.ft - best.ft) * 100) / 100;
    }
    if (cev.length) {
      out.currentKn = Number.isFinite(cev[0].speed_kn) ? cev[0].speed_kn : null;
      // The set, in degrees. CO-OPS gives the mean flood and ebb directions on every event, so
      // which one applies depends on what the water is doing at that event.
      const md = /flood/i.test(cev[0].type || '') ? cev[0].mean_flood_dir : cev[0].mean_ebb_dir;
      if (Number.isFinite(Number(md))) out.currentDirDeg = Number(md);
      // CO-OPS types: flood, ebb, slack. Passed through rather than reworded.
      out.currentType = cev[0].type || null;
      out.currentAt = cev[0].time || null;
      out.currentStation = (td.currents.station && (td.currents.station.name || td.currents.station.id)) || null;
    }
    // BAROMETRIC PRESSURE, and the trend is the part that matters. A stale reading is dropped
    // rather than shown: Charleston answered `date=latest` with an eleven-day-old value on
    // 2026-08-16, and a barometer from last week presented as now is worse than no barometer.
    const pr = td.pressure;
    if (pr && Number.isFinite(pr.mb) && !pr.stale) {
      out.pressureMb = pr.mb;
      out.pressure3h = Number.isFinite(pr.change_3h) ? pr.change_3h : null;
      out.pressureStale = false;
    } else if (pr && pr.stale) {
      out.pressureStale = true;
    }

    // COASTAL WATER TEMPERATURE. A tide station answers where no USGS site exists, which on the
    // coast is most of them. It does not outrank a USGS reading — it fills the hole.
    if (out.waterTempF == null && td.water_temp && Number.isFinite(td.water_temp.f)) {
      out.waterTempF = td.water_temp.f;
      out.waterTempFrom = 'tide_station';
      out.waterTempGauge = td.water_temp.name || null;
    }
  }

  // ── THE NEAREST WEATHER OBSERVATION ─────────────────────────────────────────────────────
  // MapClick returns it on a call already made for every water, and it is the only barometer
  // available on an inland lake — CO-OPS covers the 16 coastal zones and there are 348 lakes.
  // A coastal reading from the bound tide station is preferred where it exists, because that
  // station is on the water and the ASOS can be 50 km inland.
  const obs = (j.forecast && j.forecast.observation) || null;
  if (obs) {
    out.obsStation = obs.name || obs.station || null;
    out.obsKmAway = Number.isFinite(obs.km_from_point) ? obs.km_from_point : null;
    if (Number.isFinite(obs.wind_mph)) out.windMph = obs.wind_mph;
    if (Number.isFinite(obs.wind_dir_deg)) out.windDirDeg = obs.wind_dir_deg;
    if (Number.isFinite(obs.gust_mph)) out.gustMph = obs.gust_mph;
    if (out.pressureMb == null && Number.isFinite(obs.pressure_mb)) {
      out.pressureMb = obs.pressure_mb;
      out.pressureFrom = 'nws_station';
      // No trend from here. MapClick is one observation, not a series, and inventing a
      // direction from a single reading is not a trend.
    }
  }
  if (out.pressureMb != null && out.pressureFrom == null) out.pressureFrom = 'tide_station';

  // ── ALMANAC ─────────────────────────────────────────────────────────────────────────────
  // CIVIL TWILIGHT, NOT SUNRISE. The fishing day starts when you can see to launch and ends
  // when you cannot, and in South Carolina that is roughly 25 minutes either side of the sun.
  // Sunrise has been read for as long as this route has existed; civil dawn never has.
  const alm = j.almanac || null;
  if (alm) {
    if (alm.sun) {
      out.civilDawn = alm.sun.civil_dawn || null;
      out.civilDusk = alm.sun.civil_dusk || null;
      out.sunrise = alm.sun.rise || null;
      out.sunset = alm.sun.set || null;
    }
    if (alm.moon) {
      out.moonPhase = alm.moon.phase || null;
      // USNO sends this as a string with a percent sign, e.g. "44%". Kept verbatim rather than
      // parsed to a number, because the only thing anyone does with it is read it.
      out.moonIllumination = alm.moon.illumination || null;
    }
  }

  // The chance of rain for the first forecast period. `pop` can legitimately be 0, so the
  // finite check matters — this is the Number('') family and a 0 here is a real answer.
  const per = (j.forecast && j.forecast.periods) || [];
  if (per.length && Number.isFinite(Number(per[0].pop_pct))) out.popPct = Number(per[0].pop_pct);

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

  // A COASTAL ZONE LEADS WITH THE CURRENT. It has no full pool to be below and its "level" is a
  // tide that is always moving; what decides the trip is which way the water is running and how
  // hard. Same reasoning that puts flow first on a river.
  if (c.currentKn != null || c.currentType) {
    const kn = c.currentKn != null ? `${Math.abs(c.currentKn).toFixed(1)} kn` : '';
    bits.push([c.currentType, kn].filter(Boolean).join(' ').trim());
  }
  // A foot of surge is not a rounding error on a two-foot tide.
  if (c.surgeFt != null && Math.abs(c.surgeFt) >= 0.3) {
    bits.push(`${c.surgeFt > 0 ? '+' : '−'}${Math.abs(c.surgeFt).toFixed(1)} ft vs predicted`);
  }
  if (c.nextTide) bits.push(`${c.nextTide.type} ${c.nextTide.at ? String(c.nextTide.at).slice(11, 16) : ''}`.trim());

  // The band goes next to the flow, because the number means nothing without it.
  if (isRiver && c.flowBand) bits.push(c.flowBand.replace(' percentile', 'th pct').replace(/the (\d+)th/g, '$1'));
  if (isRiver && (c.tidalFlowCfs != null || c.flowCfs != null)) {
    // The tidally filtered figure wins where it exists: on a tidal river the raw discharge
    // reverses twice a day, so its instantaneous value is not the river's flow.
    const net = c.tidalFlowCfs != null;
    bits.push(`${Math.round(net ? c.tidalFlowCfs : c.flowCfs).toLocaleString()} ft³/s${net ? ' net' : ''}`);
    if (c.stageFt != null) bits.push(`${c.stageFt.toFixed(1)} ft stage`);
  } else if (c.belowFullPoolFt != null) {
    const b = c.belowFullPoolFt;
    bits.push(Math.abs(b) < 0.05 ? 'at full pool'
      : b > 0 ? `${b.toFixed(2)} ft down` : `${Math.abs(b).toFixed(2)} ft up`);
  } else if (c.levelFt != null) {
    bits.push(`${c.levelFt.toFixed(2)} ft`);
  }

  // The arrow is the whole point of the trend on a single line. A flat 24 h says "steady",
  // which is an answer, not a gap.
  // A falling barometer is one of the few weather facts anglers act on directly. Only the
  // DIRECTION goes on the line; the absolute reading lives on the card.
  if (c.pressure3h != null && Math.abs(c.pressure3h) >= 0.5) {
    bits.push(`baro ${c.pressure3h > 0 ? '↑' : '↓'}${Math.abs(c.pressure3h).toFixed(1)}mb/3h`);
  }
  // Wind decides whether a bank is fishable at all. Only worth the line once it is blowing.
  if (c.windMph != null && c.windMph >= 8) {
    const dir = c.windDirDeg != null
      ? ['N','NE','E','SE','S','SW','W','NW'][Math.round(((c.windDirDeg % 360) / 45)) % 8] : '';
    bits.push(`${dir}${dir ? ' ' : ''}${Math.round(c.windMph)}${c.gustMph != null && c.gustMph > c.windMph ? `g${Math.round(c.gustMph)}` : ''} mph`);
  }
  if (c.trend24h != null) {
    const d = c.trend24h;
    bits.push(Math.abs(d) < 0.01 ? 'steady 24h'
      : `${d > 0 ? '↑' : '↓'}${Math.abs(d).toFixed(2)}${c.trendUnits ? ` ${c.trendUnits}` : ''}/24h`);
  }
  if (c.waterTempF != null) {
    // A tailwater temperature is the river below the dam. One character rather than silence.
    bits.push(`${c.waterTempF}°F${c.waterTempFrom === 'tailwater' ? '*' : ''}`);
  }
  // A live turbidity reading is a measurement and loses the tilde. The model keeps it.
  // A flood category worth naming. "no_flooding" is the normal state and saying it every day
  // trains you to stop reading the line.
  if (c.floodCategory && !/^no[_ ]?flood/i.test(c.floodCategory)) {
    bits.push(String(c.floodCategory).replace(/_/g, ' '));
  }
  if (c.gaugeOutOfService) bits.push('gauge out of service');
  // GENERATING is the current on a TVA tailwater, so it belongs on the line rather than behind
  // a click. `false` is as useful as `true` here — "not generating" is why nothing is moving.
  if (c.generatingNow === true) bits.push('generating');
  else if (c.generatingNow === false) bits.push('not generating');
  if (c.droughtLevel) bits.push(String(c.droughtLevel.level).toLowerCase());
  if (c.turbidityFnu != null) bits.push(`${c.turbidityFnu} FNU`);
  else if (c.clarity) bits.push(`${c.clarityIsMeasured ? '' : '~'}${c.clarity}`);
  if (c.oxygenMgL != null) bits.push(`${c.oxygenMgL} mg/L O₂`);
  // On an estuary this is the line trout and redfish sit on. Conductance is shown in its own
  // unit rather than converted, so nothing reads as a salinity that was not measured as one.
  if (c.salinityPpt != null) bits.push(`${c.salinityPpt} ppt`);
  else if (c.conductanceUsCm != null) bits.push(`${c.conductanceUsCm.toLocaleString()} µS/cm`);

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
      (c.clarity && !c.clarityIsMeasured && c.turbidityFnu == null)
        ? '~ clarity is modelled from rainfall, not measured — absence of data is not clear water' : null,
    ].filter(Boolean),
  };
}
