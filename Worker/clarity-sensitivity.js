/**
 * clarity-sensitivity.js -- how hard rain moves THIS water, read off its own watershed.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHY THIS EXISTS
 *
 * Ryan, 2026-09-24: *"what i said for clarity that was not right was that it was only on 6
 * waters... i have nothing to say about the method... i just thought it was already on all waters
 * since i had already asked for everything for one water to be on all of them"*.
 *
 * The clarity model is `score = base + rainScore * sensitivity`. Six lakes carry a hand-authored
 * sensitivity per zone in LAKE_CLARITY_PROFILES. Every other water got the same two numbers,
 * 1.2 for "creeks/upper arms" and 0.75 for "main lake", so a lake draining 250 times its own
 * surface and a lake draining 12 times it were told the same rain moved them the same amount.
 *
 * WHAT IS PHYSICAL, AND WHAT IS NOT CLAIMED
 *
 *     flush ratio = catchment km2 / lake surface km2
 *
 * A lake that drains a large watershed for its size takes more runoff per unit of water it holds,
 * so it colours faster. That is the method build_lake_drainage.py was written for, and it never
 * ran because it asked NHDPlus over the network for a number this app already had:
 * registry/water_chain.json carries each water's drainage at its outlet (`drainage_km2`) and its
 * NHD surface (`nhd_area_km2`), measured from NHDPlus HR and checked against USACE's surveyed
 * drainage to a median of 0.2%. The Worker already reads that file for dam releases; the surface
 * was added to what is published for this.
 *
 * `drainage_km2`, NOT `local_drainage_km2`. The local figure swaps in NHD's divergence drainage
 * for a water flagged `side_channel`, which is right for an oxbow's gauge -- and the flag misfires
 * on a lake whose outlet is a diversion. Nantahala Lake is a storage reservoir on the Nantahala
 * River with 235.6 km2 above its outlet; its outlet flowline is a divergence carrying 0.016 km2,
 * so the local figure called it 0.003 times its own surface -- the clearest-draining water in the
 * app. Lake Juliette and Red Bluff Lake the same way. Clarity wants the water that ARRIVES, which
 * for an oxbow in flood is the river's anyway.
 *
 * No formula turning the ratio into the model's scale is asserted. The ratio is RANKED across every
 * lake in the chain and placed on the range the generic zones already span, 0.75 to 1.2 -- read
 * from GENERIC_LAKE_ZONES below, not typed twice. So the calibration the model already had stays,
 * and only the ORDERING becomes each water's own.
 *
 * CHECKED AGAINST THE SIX PEOPLE WROTE BY HAND, 2026-09-24. The six hand profiles are an ordering
 * nobody derived from drainage. Their mean zone sensitivities against the flush ratio:
 *
 *     wateree_lake   hand 1.142   ratio 257.6          Spearman, hand vs ratio:
 *     lake_marion    hand 1.125   ratio 102.2              topographic (this)   0.886
 *     lake_murray    hand 1.025   ratio  31.7              routed through canals 0.600
 *     hartwell_lake  hand 1.017   ratio  39.9              increment below the
 *     lake_moultrie  hand 0.950   ratio   1.2                waters upstream     0.314
 *     lake_keowee    hand 0.800   ratio  16.5
 *
 * Two neighbours swap. Murray and Hartwell, which the hand table has 0.008 apart; and Moultrie
 * and Keowee, where the drainage puts Moultrie last -- its own topographic catchment is 287 km2,
 * because its river arrives from Marion through the Diversion Canal -- and the hand author, who
 * rated it by wind ("wind-driven clarity matters as much as rain"), put it fifth. Routing the
 * canal's water in does worse (0.600), which is why the TOPOGRAPHIC drainage is the one used:
 * what comes down the canal has already settled in Marion.
 *
 * RIVERS ARE NOT RANKED. A river piece's "surface" is however much of the river the registry
 * happened to cut, so drainage over it describes the cut, not the water. Coastal zones run their
 * own tidal model. Both say so in the payload rather than borrowing a lake's number.
 */

/** The two zones every water without a hand-authored profile gets, and the model's range. */
export const GENERIC_LAKE_ZONES = Object.freeze([
  Object.freeze({ name: "Creeks/upper arms", sensitivity: 1.2, base: 6, likely: "stain first" }),
  Object.freeze({ name: "Main lake/lower basin", sensitivity: 0.75, base: 2, likely: "clearest available water" }),
]);

const round3 = (x) => Math.round(x * 1000) / 1000;

/** [lowest, highest] sensitivity the generic zones span -- the range ranks are placed on. */
export function sensitivityRange(zones = GENERIC_LAKE_ZONES) {
  const s = zones.map((z) => Number(z.sensitivity)).filter(Number.isFinite);
  return [Math.min(...s), Math.max(...s)];
}

/** The generic zones' mean sensitivity: what one number stands for across both zones. */
export function meanSensitivity(zones = GENERIC_LAKE_ZONES) {
  return zones.reduce((a, z) => a + z.sensitivity, 0) / Math.max(1, zones.length);
}

const STREAM_RIVER_FTYPE = 460;   // NHD FType for a StreamRiver area polygon

/** A chain row that is a river, by the registry's own feature_type where it has the water. */
function isRiver(slug, row, index) {
  const reg = index && index[slug];
  if (reg && typeof reg === 'object' && reg.feature_type) return reg.feature_type === 'river';
  return Number(row && row.nhd_ftype) === STREAM_RIVER_FTYPE;
}

function ratioOf(row) {
  const d = Number(row && row.drainage_km2);
  const a = Number(row && row.nhd_area_km2);
  return d > 0 && a > 0 ? d / a : null;
}

const _ranks = new WeakMap();

/**
 * Every lake in the chain, ranked by flush ratio: slug -> { pos (0..1), rank, of, ratio }.
 * Ties share their mean position, so two equal ratios can never get different numbers because
 * of the order a file happened to list them in. Cached per chain object -- the loader keeps one
 * per isolate for an hour, so this sorts ~350 numbers once an hour.
 */
export function watershedRanks(chain, index = null) {
  if (!chain || typeof chain !== 'object') return new Map();
  const hit = _ranks.get(chain);
  if (hit && hit.index === index) return hit.map;
  const rows = [];
  for (const [slug, row] of Object.entries(chain)) {
    const r = ratioOf(row);
    if (r == null || isRiver(slug, row, index)) continue;
    rows.push([r, slug]);
  }
  rows.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
  const map = new Map();
  const n = rows.length;
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && rows[j + 1][0] === rows[i][0]) j++;
    const pos = n > 1 ? ((i + j) / 2) / (n - 1) : 0.5;
    for (let k = i; k <= j; k++) map.set(rows[k][1], { pos, rank: Math.round((i + j) / 2) + 1, of: n, ratio: rows[k][0] });
    i = j + 1;
  }
  _ranks.set(chain, { index, map });
  return map;
}

/**
 * This water's own sensitivity, or an object saying why it has none.
 *
 *   { value, source: 'watershed', flushRatio, drainageKm2, surfaceKm2, rank, of, why }
 *   { value: null, source: 'generic', why }     -- a river, or a water the chain did not place
 */
export function watershedSensitivity(chain, slug, opts = {}) {
  const index = opts.index || null;
  const [lo, hi] = opts.range || sensitivityRange();
  const row = chain && slug ? chain[slug] : null;
  if (!row) {
    return { value: null, source: 'generic',
             why: slug ? `${slug} is not in water_chain.json, so the generic rates stand`
                       : 'no registry water was named, so the generic rates stand' };
  }
  if (isRiver(slug, row, index)) {
    return { value: null, source: 'generic',
             why: 'a river piece has no pool for its watershed to be measured against -- its '
                + '"surface" is however much river the registry cut -- so the generic rates stand' };
  }
  const got = watershedRanks(chain, index).get(slug);
  if (!got) {
    return { value: null, source: 'generic',
             why: `${slug} has no drainage or no surface area in water_chain.json` };
  }
  const value = round3(lo + got.pos * (hi - lo));
  const drainageKm2 = Math.round(Number(row.drainage_km2));
  const surfaceKm2 = Math.round(Number(row.nhd_area_km2) * 10) / 10;
  return {
    value, source: 'watershed',
    flushRatio: Math.round(got.ratio * 10) / 10,
    drainageKm2, surfaceKm2, rank: got.rank, of: got.of,
    why: `its watershed is ${drainageKm2.toLocaleString('en-US')} km² against `
       + `${surfaceKm2} km² of water, ${Math.round(got.ratio * 10) / 10} times its own surface: `
       + `${got.rank} of ${got.of} lakes from the slowest-staining, placed on the model's own `
       + `${lo}–${hi} range`,
  };
}

/**
 * The generic zones with this water's sensitivity. Each zone keeps its share of the generic
 * spread -- creeks 1.2/0.975 of the lake's number, main lake 0.75/0.975 -- so the water's level
 * comes from its watershed and the creek-versus-main-lake split stays the one the model had.
 * The mean of the returned zones is `value` (to the third decimal), which is what `atLaunch`
 * applies.
 */
export function zonesForSensitivity(value, zones = GENERIC_LAKE_ZONES) {
  const m = meanSensitivity(zones);
  return zones.map((z) => ({ ...z, ramps: [], sensitivity: round3(z.sensitivity * value / m) }));
}
