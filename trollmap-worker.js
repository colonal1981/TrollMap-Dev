var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// trollmap-worker.js
var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Sync-Token, X-Image-Type, X-Lake, X-Date, X-Lat, X-Lon, X-Species-Hint, X-Assume-Board",
  "Access-Control-Max-Age": "60"
};
var JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };
var TEXT_HEADERS = { ...CORS, "Content-Type": "text/plain; charset=utf-8" };
var SYNC_TOKEN = "";

// ─── LLM Provider Abstraction (Groq → OpenRouter → Cerebras fallback) ──────────────────
// Updated 2026-07-11: Fix deprecation fallout.
// - Groq: llama-3.3-70b-versatile is deprecated Aug 16 2026; recommended is openai/gpt-oss-120b [1](https://console.groq.com/docs/deprecations)[2](https://console.groq.com/docs/batch)
// - Cerebras: valid models are llama-3.3-70b, llama-3.1-8b, qwen-3-32b, gpt-oss-120b etc — NOT llama3.1-70b [3](https://tokenmix.ai/blog/cerebras-api-key-access-speed-tests-2026)
// - OpenRouter free: use 3.3 variant
// We now try multiple model candidates per provider in order, and fall back across providers.
var LLM_PROVIDERS = [
  {
    name: "gemini",
    baseUrl: null, // uses Google's native SDK-style REST, handled in callLLM
    keyEnv: "GEMINI_API_KEY",
    defaultModel: "gemini-2.5-flash",
    models: [
      "gemini-2.5-flash",
      "gemini-2.0-flash-001",
      "gemini-2.5-flash-lite"
    ],
    headers: (key) => ({ "x-goog-api-key": key, "Content-Type": "application/json" }),
    isGemini: true,
    excludeFromGeneral: true,
    transformPayload: (p) => ({
      systemInstruction: { parts: [{ text: p.messages.find(m => m.role === 'system')?.content || '' }] },
      contents: [{ parts: [{ text: p.messages.find(m => m.role === 'user')?.content || '' }] }],
      generationConfig: {
        temperature: p.temperature || 0.15,
        maxOutputTokens: p.max_tokens || 1500,
        responseMimeType: p.response_format?.type === 'json_object' ? 'application/json' : undefined,
        thinkingConfig: { thinkingBudget: 0 }
      }
    }),
  },
  {
    name: "groq",
    baseUrl: "https://api.groq.com/openai/v1/chat/completions",
    keyEnv: "GROQ_API_KEY",
    defaultModel: "openai/gpt-oss-120b",
    models: [
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant"
    ],
    headers: (key) => ({ "Authorization": `Bearer ${key}`, "Content-Type": "application/json" }),
    transformPayload: (p) => p,
  },
  {
    name: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    keyEnv: "OPENROUTER_API_KEY",
    defaultModel: "meta-llama/llama-3.3-70b-instruct:free",
    models: [
      "meta-llama/llama-3.3-70b-instruct:free",
      "meta-llama/llama-3.1-70b-instruct:free",
      "openai/gpt-oss-120b:free",
      "qwen/qwen3-32b:free",
      "meta-llama/llama-4-scout-17b-16e-instruct:free"
    ],
    headers: (key) => ({
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://trollmap.dev",
      "X-Title": "TrollMap"
    }),
    transformPayload: (p) => p,
  },
  {
    name: "cerebras",
    baseUrl: "https://api.cerebras.ai/v1/chat/completions",
    keyEnv: "CEREBRAS_API_KEY",
    defaultModel: "gpt-oss-120b",
    models: [
      "gpt-oss-120b",
      "gemma-4-31b"
    ],
    headers: (key) => ({ "Authorization": `Bearer ${key}`, "Content-Type": "application/json" }),
    transformPayload: (p) => p,
  }
,
  {
    name: "nvidia",
    baseUrl: "https://integrate.api.nvidia.com/v1/chat/completions",
    keyEnv: "NVIDIA_API_KEY",
    defaultModel: "meta/llama-4-maverick-17b-128e-instruct",
    models: [
      "meta/llama-4-maverick-17b-128e-instruct"
    ],
    headers: (key) => ({ "Authorization": `Bearer ${key}`, "Content-Type": "application/json" }),
    transformPayload: (p) => p,
  }
];

function extractLLMText(data) {
  const message = data?.choices?.[0]?.message;
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      return part?.text || part?.content || "";
    }).join("").trim();
  }
  if (typeof data?.output_text === "string") return data.output_text.trim();
  return "";
}
__name(extractLLMText, "extractLLMText");

async function callLLM(env, payload, preferredProvider = null) {
  const providers = preferredProvider
    ? LLM_PROVIDERS.filter(p => p.name === preferredProvider)
    : LLM_PROVIDERS.filter(p => env[p.keyEnv] && !p.excludeFromGeneral);

  if (!providers.length) {
    throw new Error("No LLM provider configured. Set GROQ_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY, or CEREBRAS_API_KEY");
  }

  let lastError;
  for (const provider of providers) {
    const key = env[provider.keyEnv];
    if (!key) continue;

    // ── Gemini uses a different API (Google native REST, not OpenAI-compatible) ──
    if (provider.isGemini) {
      const modelCandidates = provider.models?.length ? provider.models : [provider.defaultModel];
      for (const modelId of modelCandidates) {
        try {
          const geminiPayload = provider.transformPayload(payload);
          const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${key}`;
          const r = await fetch(geminiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(geminiPayload)
          });
          let data;
          try { data = await r.json(); } catch (_) {
            const txt = await r.text().catch(() => "");
            throw new Error(`gemini/${modelId}: HTTP ${r.status} non-JSON ${txt.slice(0,200)}`);
          }
          if (!r.ok) {
            const msg = data.error?.message || data.error || `HTTP ${r.status}`;
            const msgStr = typeof msg === "string" ? msg : JSON.stringify(msg).slice(0,400);
            throw new Error(`gemini/${modelId}: ${msgStr}`);
          }
          // Convert Gemini response to OpenAI-compatible shape for extractLLMText
          const geminiText = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!geminiText) throw new Error(`gemini/${modelId}: empty content`);
          const compatData = { choices: [{ message: { content: geminiText } }] };
          return { provider: "gemini", model: modelId, data: compatData, _geminiRaw: geminiText.slice(0, 200) };
        } catch (e) {
          lastError = e;
          console.warn(`LLM gemini/${modelId} failed: ${e.message}`);
          continue;
        }
      }
      continue; // exhausted Gemini models, move to next provider
    }

    const modelCandidates = provider.models?.length ? provider.models : [provider.defaultModel];
    for (const modelId of modelCandidates) {
      try {
        const providerPayload = { ...payload, model: modelId };
        const body = provider.transformPayload(providerPayload);
        const r = await fetch(provider.baseUrl, {
          method: "POST",
          headers: provider.headers(key),
          body: JSON.stringify(body)
        });
        let data;
        try {
          data = await r.json();
        } catch (_) {
          const txt = await r.text().catch(() => "");
          throw new Error(`${provider.name}/${modelId}: HTTP ${r.status} non-JSON ${txt.slice(0,200)}`);
        }
        if (!r.ok) {
          const msg = data.error?.message || data.error || data.message || `HTTP ${r.status}`;
          const msgStr = typeof msg === "string" ? msg : JSON.stringify(msg).slice(0,400);
          if (/does not exist|decommissioned|not found|invalid.*model|No such model/i.test(msgStr)) {
            console.warn(`LLM provider ${provider.name} model ${modelId} rejected: ${msgStr}`);
            lastError = new Error(`${provider.name}/${modelId}: ${msgStr}`);
            continue;
          }
          throw new Error(`${provider.name}/${modelId}: ${msgStr}`);
        }

        if (Array.isArray(data?.choices) && data.choices.length) {
          const text = extractLLMText(data);
          if (!text) {
            const choice = data.choices[0] || {};
            const finish = choice.finish_reason ? ` finish_reason=${choice.finish_reason}` : "";
            const reasoning = choice.message?.reasoning || choice.message?.reasoning_content || "";
            const hint = reasoning ? ` reasoning=${String(reasoning).slice(0,160)}` : "";
            throw new Error(`${provider.name}/${modelId}: empty assistant content.${finish}${hint}`);
          }
        }

        return { provider: provider.name, model: modelId, data };
      } catch (e) {
        lastError = e;
        const isModelErr = /does not exist|decommissioned|not found|invalid.*model|No such model/i.test(e.message);
        console.warn(`LLM ${provider.name}/${modelId} failed: ${e.message}`);
        if (isModelErr) continue;
        continue;
      }
    }
  }
  throw lastError || new Error("All LLM providers/models failed");
}
__name(callLLM, "callLLM");
async function isAuthorized(request, env) {
  const want = env && env.SYNC_TOKEN || typeof SYNC_TOKEN !== "undefined" && SYNC_TOKEN || null;
  if (!want) return false;
  const got = request.headers.get("X-Sync-Token");
  return got === want;
}
__name(isAuthorized, "isAuthorized");
function chartpackKey(lake, filename) {
  const safeLake = String(lake).toLowerCase().replace(/[^a-z0-9_\-]/g, "_");
  const safeFile = String(filename).replace(/[^a-z0-9_.\-\/]/gi, "_");
  return `${safeLake}/${safeFile}`;
}
__name(chartpackKey, "chartpackKey");
async function handleChartpackList(env) {
  const out = [];
  let cursor;
  do {
    const listed = await env.R2_TROLLMAP_CHARTPACKS.list({ cursor });
    for (const obj of listed.objects) {
      const slash = obj.key.indexOf("/");
      if (slash < 0) continue;
      const lake = obj.key.slice(0, slash);
      const file = obj.key.slice(slash + 1);
      let entry = out.find((e) => e.name === lake);
      if (!entry) {
        entry = { name: lake, files: [], bytes: 0 };
        out.push(entry);
      }
      entry.files.push(file);
      entry.bytes += obj.size || 0;
    }
    cursor = listed.truncated ? listed.cursor : null;
  } while (cursor);
  for (const e of out) e.files.sort();
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { chartpacks: out, count: out.length };
}
__name(handleChartpackList, "handleChartpackList");
var LAKES = {
  wateree: { duke: "wateree", river: "02148000", normalPool: 225.5, ahq: "lake-wateree" },
  wylie: { duke: "wylie", pool: "02146000", normalPool: 569.4, ahq: "lake-wylie" },
  norman: { duke: "norman", river: "02142500", normalPool: 760 },
  // No AHQ page for Norman (NC lake)
  keowee: { duke: "keowee", river: "02163500", normalPool: 800, ahq: "lake-keowee" },
  jocassee: { duke: "jocassee", normalPool: 1110, ahq: "lake-jocassee" },
  hickory: { duke: "hickory", river: "02143500", normalPool: 935 },
  james: { duke: "james", normalPool: 1200 },
  rhodhiss: { duke: "rhodhiss", normalPool: 995.1 },
  "mountain island": { duke: "mountain island", normalPool: 647.5 },
  murray: { dominion: true, pool: "02168500", normalPool: 358, ahq: "lake-murray" },
  marion: { sepa: "marion", pool: "02169921", normalPool: 75, ahq: "santee-cooper-lake-marion-lake-moultrie" },
  moultrie: { sepa: "moultrie", pool: "02172000", normalPool: 75.5, ahq: "santee-cooper-lake-marion-lake-moultrie" },
  thurmond: { sepa: "thurmond", pool: "02196485", normalPool: 330, ahq: "clarks-hill-lake-thurmond" },
  hartwell: { sepa: "hartwell", pool: "02187010", normalPool: 660, ahq: "lake-hartwell" },
  russell: { sepa: "russell", pool: "02191743", normalPool: 475, ahq: "lake-russell" }
};
var LAKE_INTEL = {
  wateree: {
    displayName: "Lake Wateree",
    primarySportFish: ["Largemouth bass", "Striped bass", "Catfish", "Crappie", "White perch"],
    forage: ["Threadfin shad", "Gizzard shad", "Blueback herring (system-dependent)", "White perch"],
    stocking: "Managed as a Catawba-Wateree reservoir; striper/hybrid regulations and stocking can change, verify SCDNR before harvest.",
    spottedBass: "Spotted bass are present in the broader Catawba system but Wateree is still generally discussed as largemouth/striper/catfish water; verify local tournament reports for current spotted-bass pressure.",
    habitat: "Classic river-run reservoir: creek arms, rocky points, docks, riprap, bridge pilings, humps, channel swings, blowdowns, brush piles, and lower-lake bait schools.",
    bottom: "Mix of clay, rock, gravel, sand, and old river/creek-channel silt. Hard bottom around points/riprap is key for bass; deeper channel edges for stripers.",
    hazards: "Drawdown exposes shallow shoals and long points. Wind stacks up on the main lake. Below Wateree Dam is a separate river/tailwater hazard zone with generation surges.",
    seasonalPattern: "Spring: points/backs of creeks. Summer: main-lake humps/channel edges and low-light schooling. Fall: bait migration. Winter: deeper bait and slower presentations.",
    tacticalNotes: ["Use electronics to follow bait before committing to a trolling pass.", "Wind-blown points and bridge funnels can concentrate bait.", "Confirm current Duke lake stage and ramp usability before dawn launches."]
  },
  murray: {
    displayName: "Lake Murray",
    primarySportFish: ["Striped bass", "Largemouth bass", "Catfish", "Crappie", "Bream"],
    forage: ["Blueback herring", "Threadfin shad", "Gizzard shad"],
    stocking: "Known regional striper reservoir; verify current SCDNR stocking/harvest notices and seasonal closures before targeting/keeping fish.",
    spottedBass: "Spotted bass are not the defining fishery like Keowee/Hartwell; largemouth and stripers are the headline sport fisheries.",
    habitat: "Deep clear lower lake near the dam, long points, humps, shoals, docks, riprap, creek arms, bridges, and offshore bait schools.",
    bottom: "Mostly clay/sand with rock, gravel, and riprap; lower-lake clearer water and offshore structure matter heavily.",
    hazards: "Recreational boat traffic can be intense. Wind across open lower lake gets rough for kayaks. Drawdowns expose shallow points and shoals.",
    seasonalPattern: "Spring shoreline/points; summer early/late striper schooling and deeper bait; fall herring/shad movement; winter deep fish and birds/bait clues.",
    tacticalNotes: ["Blueback herring behavior drives a lot of Murray striper/bass movement.", "Plan around boat traffic and wind fetch.", "Use USGS 02168500 for reservoir pool, not the downstream Saluda gauge."]
  },
  marion: {
    displayName: "Lake Marion",
    primarySportFish: ["Largemouth bass", "Striped bass", "Catfish", "Crappie", "Bream"],
    forage: ["Threadfin shad", "Gizzard shad", "Blueback herring in parts of Santee-Cooper system", "Panfish"],
    stocking: "Santee Cooper system management changes seasonally; striped bass rules/closures are especially important to verify.",
    spottedBass: "Spotted bass are not the main story; largemouth, catfish, crappie, bream, and stripers dominate angler focus.",
    habitat: "Very shallow, sprawling, stump-filled reservoir with cypress, grass, swamp edges, old river runs, standing/flooded timber, canals, flats, drops, and brush.",
    bottom: "Mud, silt, sand, old river-channel edges, stump fields, swamp timber, and shallow flats. Hard edges/ditches can be high-value when water moves.",
    hazards: "Major stump and standing timber hazard lake. Navigation can be dangerous outside marked channels, especially at low water or in wind/fog.",
    seasonalPattern: "Spring shallow cover/spawning pockets; summer current/river runs and shaded timber; fall bait movement; winter deep holes/creek channels and crappie structure.",
    tacticalNotes: ["Treat it like a navigation lake first and a fishing lake second.", "Use marked channels and idle in unfamiliar stump fields.", "Wind can make broad shallow water rough quickly."]
  },
  moultrie: {
    displayName: "Lake Moultrie",
    primarySportFish: ["Catfish", "Largemouth bass", "Striped bass", "Crappie", "Bream"],
    forage: ["Shad", "Herring", "Panfish"],
    stocking: "Part of Santee Cooper; verify current SCDNR/Santee Cooper striper rules and stocking notices.",
    spottedBass: "Not generally a spotted-bass takeover lake; focus is catfish, largemouth, crappie, bream, and stripers.",
    habitat: "Broad bowl-like lake with grass edges, canals, dikes, deep open-water areas, shell/hard spots, drops, and Santee-Cooper current influences.",
    bottom: "Mud/sand/shell/hard spots with old inundated features and canal/dike influences.",
    hazards: "Open-water wind fetch is serious for kayaks. Current/wind around canal/dike areas can surprise. Verify lake level and wind before crossing.",
    seasonalPattern: "Catfish year-round on ledges/drifts; bass around grass/hard edges; crappie around brush/canals; striper patterns depend heavily on season/rules.",
    tacticalNotes: ["Wind direction matters as much as lake level.", "Use USGS 02172000 for Moultrie pool, not downstream/tailrace gauges."]
  },
  keowee: {
    displayName: "Lake Keowee",
    primarySportFish: ["Spotted bass", "Largemouth bass", "Crappie", "Catfish"],
    forage: ["Blueback herring", "Threadfin shad"],
    stocking: "Clear Duke reservoir; bass fishery is strongly herring-driven. Verify SCDNR for current creel/length rules.",
    spottedBass: "Yes \u2014 spotted bass are a dominant/major population and can outcompete largemouth in clear herring lakes. Expect offshore/herring-oriented behavior.",
    habitat: "Deep clear water, steep points, docks, cane/brush, rock, humps, shoals, long tapering points, and blueback-oriented offshore zones.",
    bottom: "Rock, clay, sand, gravel, steep banks, and deep clear-water structure.",
    hazards: "Clear water demands long casts/light line. Boat traffic and steep banks. Rapid weather/wind on open water.",
    seasonalPattern: "Spring herring spawn points; summer deep docks/brush/offshore; fall schooling; winter vertical/deep finesse.",
    tacticalNotes: ["Think spotted bass + blueback herring first.", "Use natural colors and electronics-heavy offshore strategy."]
  },
  hartwell: {
    displayName: "Lake Hartwell",
    primarySportFish: ["Spotted bass", "Largemouth bass", "Striped bass", "Hybrid bass", "Catfish", "Crappie"],
    forage: ["Blueback herring", "Threadfin shad", "Gizzard shad"],
    stocking: "Large Savannah River reservoir with striper/hybrid management; verify GA/SC regulations depending where you fish.",
    spottedBass: "Strong spotted bass population; blueback herring has shifted many bass patterns offshore and roam-oriented.",
    habitat: "Huge clear-to-stained reservoir with timber in upper arms, docks, clay/rock points, humps, creek channels, bridges, brush, and cane piles.",
    bottom: "Clay, rock, gravel, sand, channel silt, and timbered creek/river areas.",
    hazards: "Big water, boat traffic, state-line regulations, standing timber in some areas, and long runs in wind.",
    seasonalPattern: "Herring spawn in spring; offshore brush/points in summer; schooling in fall; deep timber/ditches in winter.",
    tacticalNotes: ["Find bait first.", "Spotted bass and stripers both track herring heavily.", "Know whether you are in SC or GA for license/rules."]
  },
  thurmond: {
    displayName: "Clarks Hill / J. Strom Thurmond Lake",
    primarySportFish: ["Striped bass", "Hybrid bass", "Largemouth bass", "Crappie", "Catfish"],
    forage: ["Blueback herring", "Threadfin shad", "Gizzard shad"],
    stocking: "USACE/Savannah River reservoir with striper/hybrid stocking/management; verify GA/SC rules.",
    spottedBass: "Spotted bass exist in the region but Thurmond is more commonly framed around largemouth, stripers/hybrids, crappie, and catfish than a spotted-bass takeover lake.",
    habitat: "Large reservoir with standing timber in many arms, points, humps, bridges, creek channels, brush piles, hydrilla/grass where present, and deep lower-lake water.",
    bottom: "Clay, rock, sand, gravel, channel silt, and extensive timbered structure.",
    hazards: "Standing timber, long open-water runs, low-water ramp issues, and state-line regulations.",
    seasonalPattern: "Spring points/pockets; summer deep humps/timber/thermocline; fall schooling; winter deep bait and channel structure.",
    tacticalNotes: ["Excellent electronics lake.", "For stripers/hybrids, bait depth and oxygen/thermocline matter."]
  },
  russell: {
    displayName: "Lake Russell",
    primarySportFish: ["Spotted bass", "Largemouth bass", "Striped bass", "Crappie", "Catfish"],
    forage: ["Blueback herring", "Threadfin shad"],
    stocking: "USACE Savannah River lake with relatively stable pool; verify GA/SC rules and striper management notices.",
    spottedBass: "Spotted bass are important and often strong due to clear water/herring-style patterns.",
    habitat: "Deep clear reservoir, standing timber, steep rocky banks, points, humps, creek channels, and limited shoreline development.",
    bottom: "Rock, clay, gravel, sand, and timbered old channels.",
    hazards: "Standing timber and deep clear water. State-line/license considerations.",
    seasonalPattern: "Herring/point bite in spring; deep timber/offshore in summer/winter; schooling in fall.",
    tacticalNotes: ["Stable water means fish may relate more to bait/season than drawdown.", "Timber edges are key."]
  },
  jocassee: {
    displayName: "Lake Jocassee",
    primarySportFish: ["Trout", "Smallmouth bass", "Spotted bass", "Largemouth bass"],
    forage: ["Blueback herring", "Threadfin shad", "Alewife/herring-type forage"],
    stocking: "Deep cold clear reservoir with trout management; verify SCDNR trout/bass rules.",
    spottedBass: "Spotted bass are present; deep clear-water tactics matter more than shallow power fishing much of the year.",
    habitat: "Extremely deep, clear, steep, rocky reservoir with timber, cliffs, waterfalls, and cold-water zones.",
    bottom: "Rock, steep clay/stone banks, deep timber, and very deep basins.",
    hazards: "Depth drops fast. Cold water, sudden mountain weather, limited access, and long paddle distances.",
    seasonalPattern: "Trout/cold-water patterns, deep vertical electronics work, and clear-water finesse bass tactics.",
    tacticalNotes: ["Safety first: cold deep water and limited shoreline access.", "Electronics and downrigger/vertical presentations shine."]
  }
};
async function fetchText(url, opts = {}) {
  const res = await fetch(url, {
    cf: { cacheTtl: 120, cacheEverything: true },
    headers: { "User-Agent": "TrollMap/10 Worker", "Accept": "text/html,application/json,*/*" },
    ...opts
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
}
__name(fetchText, "fetchText");
async function fetchUsgs(site, paramCd, periodDays = 2) {
  const out = {};
  const jsonUrl = `https://waterservices.usgs.gov/nwis/iv/?sites=${site}&parameterCd=${paramCd}&format=json&period=P${periodDays}D`;
  try {
    const r = await fetch(jsonUrl, { cf: { cacheTtl: 120 } });
    if (r.ok) {
      const j = await r.json();
      for (const ts of j?.value?.timeSeries || []) {
        const code = ts?.variable?.variableCode?.[0]?.value;
        const vals = ts?.values?.[0]?.values || [];
        const good = vals.filter((v) => v.value !== "" && v.value !== "-999999" && v.value != null);
        if (!good.length) continue;
        const latest = parseFloat(good[good.length - 1].value);
        if (!isFinite(latest)) continue;
        if (code === "00010") out.tempC = latest;
        if (code === "00065") out.gageHeight = latest;
        if (code === "00062") out.elevation = latest;
        if (code === "62614") out.elevation = latest;
        if (code === "62615") out.elevation = latest;
        if (code === "63160") out.elevationNavd88 = latest;
        if (code === "00060") out.streamflow = latest;
        out.timestamp = good[good.length - 1].dateTime;
      }
    }
  } catch (_) {
  }
  if (out.tempC != null || out.gageHeight != null || out.elevation != null) return out;
  try {
    const rdbUrl = `https://waterservices.usgs.gov/nwis/iv/?sites=${site}&parameterCd=${paramCd}&format=rdb&period=P${periodDays}D`;
    const r = await fetch(rdbUrl, { cf: { cacheTtl: 120 } });
    if (!r.ok) return out;
    const text = await r.text();
    const lines = text.split("\n").filter((l) => l && !l.startsWith("#"));
    if (lines.length < 3) return out;
    const header = lines[0].split("	");
    const dataLines = lines.slice(2).filter((l) => l.startsWith("USGS"));
    if (!dataLines.length) return out;
    const last = dataLines[dataLines.length - 1].split("	");
    for (let i = 4; i < header.length; i++) {
      const h = header[i];
      if (!h || h.endsWith("_cd")) continue;
      const m = h.match(/_(\d{5})(?:_|$)/);
      if (!m) continue;
      const code = m[1];
      const v = parseFloat(last[i]);
      if (!isFinite(v)) continue;
      if (code === "00010" && out.tempC == null) out.tempC = v;
      if (code === "00065" && out.gageHeight == null) out.gageHeight = v;
      if (code === "00062" && out.elevation == null) out.elevation = v;
      if (code === "62614" && out.elevation == null) out.elevation = v;
      if (code === "62615" && out.elevation == null) out.elevation = v;
      if (code === "63160" && out.elevationNavd88 == null) out.elevationNavd88 = v;
      if (code === "00060" && out.streamflow == null) out.streamflow = v;
    }
    if (!out.timestamp && last[2]) out.timestamp = `${last[2]} ${last[3] || ""}`.trim();
  } catch (_) {
  }
  return out;
}
__name(fetchUsgs, "fetchUsgs");
async function fetchDukeApi() {
  try {
    const r = await fetch("https://api.hydro-derived.duke-energy.app/lakes/current-level", {
      cf: { cacheTtl: 120, cacheEverything: true },
      headers: {
        "User-Agent": "TrollMap/10 Worker",
        "Origin": "https://lakes.hydro-derived.duke-energy.app",
        "Referer": "https://lakes.hydro-derived.duke-energy.app/",
        "Accept": "application/json"
      }
    });
    if (!r.ok) return null;
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) return null;
    return arr;
  } catch (_) {
    return null;
  }
}
__name(fetchDukeApi, "fetchDukeApi");
function normalizeDukeRow(row) {
  const actual = parseFloat(row.Actual);
  const elevMatch = String(row.Elevation || "").match(/([0-9]+(?:\.[0-9]+)?)/);
  const fullPool = elevMatch ? parseFloat(elevMatch[1]) : null;
  if (!isFinite(actual)) return null;
  let pct = null, ft = null;
  if (actual > 100 || fullPool && Math.abs(actual - fullPool) < fullPool * 0.1 && actual > 50) {
    ft = actual;
    pct = fullPool ? actual / fullPool * 100 : null;
  } else {
    pct = actual;
    ft = fullPool ? actual / 100 * fullPool : null;
  }
  return {
    name: row.LakeDisplayName || row.LakeName || "",
    pct: pct != null ? Math.round(pct * 100) / 100 : null,
    ft: ft != null ? Math.round(ft * 100) / 100 : null,
    fullPool,
    target: parseFloat(row.Target),
    min: parseFloat(row.Min),
    max: parseFloat(row.Max),
    date: row.Date,
    specialMessage: Array.isArray(row.SpecialMessage) && row.SpecialMessage[0] ? row.SpecialMessage[0].Text : null
  };
}
__name(normalizeDukeRow, "normalizeDukeRow");
async function getDukeLake(nameFragment) {
  const arr = await fetchDukeApi();
  if (!arr) return null;
  const frag = nameFragment.toLowerCase();
  const row = arr.find((r) => (r.LakeDisplayName || "").toLowerCase().includes(frag) || (r.LakeName || "").toLowerCase().includes(frag));
  return row ? normalizeDukeRow(row) : null;
}
__name(getDukeLake, "getDukeLake");
async function fetchDukeDashboard(basin = "1") {
  const arr = await fetchDukeApi();
  if (!arr) return null;
  const lines = arr.map((r) => {
    const n = normalizeDukeRow(r);
    if (!n) return "";
    return `${n.name} \xB7 ${n.ft != null ? n.ft.toFixed(2) : "NA"} \xB7 ${n.pct != null ? n.pct.toFixed(2) + "%" : "NA"} \xB7 target ${isFinite(n.target) ? n.target : "NA"} \xB7 full ${n.fullPool || "NA"}`;
  }).filter(Boolean);
  return { url: "https://api.hydro-derived.duke-energy.app/lakes/current-level", text: lines.join("\n"), json: arr };
}
__name(fetchDukeDashboard, "fetchDukeDashboard");
async function fetchSanteeCooper() {
  const urls = [
    "https://www.santeecooper.com/community/lakes-and-recreation/lake-levels.aspx",
    "https://www.santeecooper.com/community/lakes-and-recreation/lake-levels"
  ];
  for (const u of urls) {
    const r = await fetchText(u);
    if (r.ok && r.text) {
      const marion = r.text.match(/Marion[^0-9]{0,40}([0-9]{2}\.[0-9]{1,2})/i);
      const moultrie = r.text.match(/Moultrie[^0-9]{0,40}([0-9]{2}\.[0-9]{1,2})/i);
      if (marion || moultrie) {
        return {
          marion: marion ? parseFloat(marion[1]) : null,
          moultrie: moultrie ? parseFloat(moultrie[1]) : null,
          source: u
        };
      }
    }
  }
  return null;
}
__name(fetchSanteeCooper, "fetchSanteeCooper");
async function fetchUsaceSavannah(lakeKey) {
  const urls = [
    "https://water.sas.usace.army.mil/Lakes.htm",
    "https://water.sas.usace.army.mil/"
  ];
  for (const u of urls) {
    const r = await fetchText(u);
    if (r.ok && r.text) {
      const name = { thurmond: "Thurmond", hartwell: "Hartwell", russell: "Russell" }[lakeKey];
      if (!name) return null;
      const m = r.text.match(new RegExp(name + "[^0-9]{0,80}([0-9]{3}\\.[0-9]{1,2})", "i"));
      if (m) return { elevation: parseFloat(m[1]), source: u };
    }
  }
  return null;
}
__name(fetchUsaceSavannah, "fetchUsaceSavannah");
async function fetchAhqWaterTemp(slug) {
  if (!slug) return null;
  const url = `https://www.anglersheadquarters.com/pages/${slug}-fishing-report`;
  const r = await fetchText(url);
  if (!r.ok || !r.text) return null;
  const numericRe = /(?:morning\s+)?(?:surface\s+)?water\s+temperatures?\s+(?:are|is|range)\s+(?:about\s+|around\s+|from\s+|approximately\s+)?(\d{2,3})(?:\s*(?:to|[-–])\s*(\d{2,3}))?\s*degrees/i;
  const m = r.text.match(numericRe);
  if (m) {
    const a = parseInt(m[1]), b = m[2] ? parseInt(m[2]) : null;
    const tempF = b ? Math.round((a + b) / 2) : a;
    return { tempF, source: url, raw: m[0], range: b ? [a, b] : null };
  }
  const vagueRe = /water\s+temperatures?\s+(?:are\s+|is\s+|now\s+)?(?:in\s+the\s+)?(lower|low|mid|upper|high)?\s*(\d{2,3})s(?:\s*(?:to|[-–])\s*(lower|low|mid|upper|high)?\s*(\d{2,3})s)?/i;
  const v = r.text.match(vagueRe);
  if (v) {
    const band = /* @__PURE__ */ __name((mod, base) => {
      const b2 = parseInt(base);
      if (!mod || mod === "mid") return b2 + 5;
      if (mod === "lower" || mod === "low") return b2 + 2;
      if (mod === "upper" || mod === "high") return b2 + 8;
      return b2 + 5;
    }, "band");
    const a = band(v[1], v[2]);
    const b = v[4] ? band(v[3], v[4]) : null;
    const tempF = b ? Math.round((a + b) / 2) : a;
    return { tempF, source: url, raw: v[0], range: b ? [a, b] : null, approx: true };
  }
  return null;
}
__name(fetchAhqWaterTemp, "fetchAhqWaterTemp");
var LAKE_INTEL_SOURCE_REGISTRY = {
  "default": {
    "official": [
      {
        "label": "SCDNR Freshwater Size & Possession Limits (eRegulations)",
        "url": "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits",
        "trust": "OFFICIAL"
      }
    ],
    "habitat": [],
    "reports": [],
    "model": []
  },
  "wateree": {
    "official": [
      {
        "label": "Duke Energy Catawba-Wateree Lake Levels",
        "url": "https://lakes.hydro-derived.duke-energy.app/",
        "trust": "OFFICIAL_UTILITY",
        "use": "pool level / advisories"
      },
      {
        "label": "SCDNR Freshwater Size & Possession Limits (eRegulations)",
        "url": "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits",
        "trust": "OFFICIAL",
        "use": "seasons, limits, creel rules"
      },
      {
        "label": "USGS Wateree River near Camden 02148000",
        "url": "https://waterdata.usgs.gov/monitoring-location/02148000/",
        "trust": "OFFICIAL_PROXY",
        "use": "below-dam river temp/flow only, not lake pool"
      }
    ],
    "habitat": [
      {
        "label": "SCDNR fish attractor / public access GIS",
        "url": "https://data-scdnr.opendata.arcgis.com/",
        "trust": "OFFICIAL_GIS",
        "use": "ramps, public access, attractors when present"
      }
    ],
    "reports": [
      {
        "label": "Angler's Headquarters Lake Wateree Fishing Report",
        "url": "https://www.anglersheadquarters.com/pages/lake-wateree-fishing-report",
        "trust": "THIRD_PARTY_VERIFY",
        "use": "surface temp, clarity, bite/pattern report"
      }
    ],
    "model": [
      {
        "label": "LakeMonster Lake Wateree",
        "url": "https://lakemonster.com/lake/SC/Lake-Wateree-water-temperature-1072",
        "trust": "MODEL_VERIFY",
        "use": "surface temp estimate, weather, species/context"
      }
    ]
  },
  "murray": {
    "official": [
      {
        "label": "USGS Lake Murray near Columbia 02168500",
        "url": "https://waterdata.usgs.gov/monitoring-location/02168500/",
        "trust": "OFFICIAL",
        "use": "reservoir elevation"
      },
      {
        "label": "Dominion Energy Lake Murray Management",
        "url": "https://www.dominionenergy.com/projects-and-facilities/hydroelectric-power/lake-murray",
        "trust": "OFFICIAL_UTILITY",
        "use": "lake management / drawdown notices"
      },
      {
        "label": "SCDNR Freshwater Size & Possession Limits (eRegulations)",
        "url": "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits",
        "trust": "OFFICIAL",
        "use": "seasons and limits"
      }
    ],
    "habitat": [
      {
        "label": "SCDNR public access / fish habitat GIS",
        "url": "https://data-scdnr.opendata.arcgis.com/",
        "trust": "OFFICIAL_GIS"
      }
    ],
    "reports": [
      {
        "label": "Angler's Headquarters Lake Murray Fishing Report",
        "url": "https://www.anglersheadquarters.com/pages/lake-murray-fishing-report",
        "trust": "THIRD_PARTY_VERIFY"
      }
    ],
    "model": [
      {
        "label": "LakeMonster Lake Murray",
        "url": "https://lakemonster.com/lake/SC/Lake-Murray-water-temperature-1071",
        "trust": "MODEL_VERIFY"
      }
    ]
  },
  "marion": {
    "official": [
      {
        "label": "USGS Lake Marion near Elloree 02169921",
        "url": "https://waterdata.usgs.gov/monitoring-location/02169921/",
        "trust": "OFFICIAL",
        "use": "reservoir elevation"
      },
      {
        "label": "Santee Cooper Lake Data",
        "url": "https://www.santeecooper.com/community/lakes/lake-data/",
        "trust": "OFFICIAL_UTILITY",
        "use": "lake data / rule curve context"
      },
      {
        "label": "SCDNR Freshwater Size & Possession Limits (eRegulations)",
        "url": "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits",
        "trust": "OFFICIAL",
        "use": "Santee Cooper system rules"
      }
    ],
    "habitat": [
      {
        "label": "SCDNR public access / habitat GIS",
        "url": "https://data-scdnr.opendata.arcgis.com/",
        "trust": "OFFICIAL_GIS"
      }
    ],
    "reports": [
      {
        "label": "Angler's Headquarters Santee Cooper Fishing Report",
        "url": "https://www.anglersheadquarters.com/pages/santee-cooper-lake-marion-lake-moultrie-fishing-report",
        "trust": "THIRD_PARTY_VERIFY"
      }
    ],
    "model": []
  },
  "moultrie": {
    "official": [
      {
        "label": "USGS Lake Moultrie near Pinopolis 02172000",
        "url": "https://waterdata.usgs.gov/monitoring-location/02172000/",
        "trust": "OFFICIAL",
        "use": "reservoir elevation"
      },
      {
        "label": "Santee Cooper Lake Data",
        "url": "https://www.santeecooper.com/community/lakes/lake-data/",
        "trust": "OFFICIAL_UTILITY",
        "use": "lake data / rule curve context"
      },
      {
        "label": "SCDNR Freshwater Size & Possession Limits (eRegulations)",
        "url": "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits",
        "trust": "OFFICIAL"
      }
    ],
    "habitat": [
      {
        "label": "SCDNR public access / habitat GIS",
        "url": "https://data-scdnr.opendata.arcgis.com/",
        "trust": "OFFICIAL_GIS"
      }
    ],
    "reports": [
      {
        "label": "Angler's Headquarters Santee Cooper Fishing Report",
        "url": "https://www.anglersheadquarters.com/pages/santee-cooper-lake-marion-lake-moultrie-fishing-report",
        "trust": "THIRD_PARTY_VERIFY"
      }
    ],
    "model": []
  },
  "keowee": {
    "official": [
      {
        "label": "Duke Energy Lake Levels",
        "url": "https://lakes.hydro-derived.duke-energy.app/",
        "trust": "OFFICIAL_UTILITY",
        "use": "pool level / advisories"
      },
      {
        "label": "SCDNR Freshwater Size & Possession Limits (eRegulations)",
        "url": "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits",
        "trust": "OFFICIAL"
      }
    ],
    "habitat": [
      {
        "label": "SCDNR public access / habitat GIS",
        "url": "https://data-scdnr.opendata.arcgis.com/",
        "trust": "OFFICIAL_GIS"
      }
    ],
    "reports": [
      {
        "label": "Angler's Headquarters Lake Keowee Fishing Report",
        "url": "https://www.anglersheadquarters.com/pages/lake-keowee-fishing-report",
        "trust": "THIRD_PARTY_VERIFY"
      }
    ],
    "model": [
      {
        "label": "LakeMonster Lake Keowee",
        "url": "https://lakemonster.com/lake/SC/Lake-Keowee-water-temperature-1068",
        "trust": "MODEL_VERIFY"
      }
    ]
  },
  "hartwell": {
    "official": [
      {
        "label": "USGS Hartwell Lake 02187010",
        "url": "https://waterdata.usgs.gov/monitoring-location/02187010/",
        "trust": "OFFICIAL",
        "use": "reservoir elevation"
      },
      {
        "label": "USACE Savannah District Lake Levels",
        "url": "https://water.sas.usace.army.mil/",
        "trust": "OFFICIAL_FEDERAL",
        "use": "USACE lake levels"
      },
      {
        "label": "SCDNR / GA DNR Freshwater Regs (eRegulations)",
        "url": "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits",
        "trust": "OFFICIAL"
      }
    ],
    "reports": [
      {
        "label": "Angler's Headquarters Lake Hartwell Fishing Report",
        "url": "https://www.anglersheadquarters.com/pages/lake-hartwell-fishing-report",
        "trust": "THIRD_PARTY_VERIFY"
      }
    ],
    "model": [
      {
        "label": "LakeMonster Lake Hartwell",
        "url": "https://lakemonster.com/lake/GA/Lake-Hartwell-water-temperature-1029",
        "trust": "MODEL_VERIFY"
      }
    ]
  },
  "thurmond": {
    "official": [
      {
        "label": "USACE Savannah District Thurmond Lake",
        "url": "https://water.sas.usace.army.mil/",
        "trust": "OFFICIAL_FEDERAL",
        "use": "lake level / ramp context"
      },
      {
        "label": "SCDNR / GA DNR Freshwater Regs (eRegulations)",
        "url": "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits",
        "trust": "OFFICIAL"
      }
    ],
    "reports": [
      {
        "label": "Angler's Headquarters Clarks Hill Fishing Report",
        "url": "https://www.anglersheadquarters.com/pages/clarks-hill-lake-thurmond-fishing-report",
        "trust": "THIRD_PARTY_VERIFY"
      }
    ],
    "model": []
  },
  "russell": {
    "official": [
      {
        "label": "USACE Savannah District Russell Lake",
        "url": "https://water.sas.usace.army.mil/",
        "trust": "OFFICIAL_FEDERAL",
        "use": "lake level / project info"
      },
      {
        "label": "SCDNR / GA DNR Freshwater Regs (eRegulations)",
        "url": "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits",
        "trust": "OFFICIAL"
      }
    ],
    "reports": [
      {
        "label": "Angler's Headquarters Lake Russell Fishing Report",
        "url": "https://www.anglersheadquarters.com/pages/lake-russell-fishing-report",
        "trust": "THIRD_PARTY_VERIFY"
      }
    ],
    "model": []
  },
  "jocassee": {
    "official": [
      {
        "label": "Duke Energy Lake Levels",
        "url": "https://lakes.hydro-derived.duke-energy.app/",
        "trust": "OFFICIAL_UTILITY"
      },
      {
        "label": "SCDNR Freshwater Size & Possession Limits (eRegulations)",
        "url": "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits",
        "trust": "OFFICIAL"
      }
    ],
    "reports": [
      {
        "label": "Angler's Headquarters Lake Jocassee Fishing Report",
        "url": "https://www.anglersheadquarters.com/pages/lake-jocassee-fishing-report",
        "trust": "THIRD_PARTY_VERIFY"
      }
    ],
    "model": []
  },
  "norman": {
    "official": [
      {
        "label": "Duke Energy Lake Levels",
        "url": "https://lakes.hydro-derived.duke-energy.app/",
        "trust": "OFFICIAL_UTILITY"
      }
    ],
    "reports": [],
    "model": [
      {
        "label": "LakeMonster Lake Norman",
        "url": "https://lakemonster.com/lake/NC/Lake-Norman-water-temperature-232",
        "trust": "MODEL_VERIFY"
      }
    ]
  }
};
var LAKEMONSTER_IDS = {
  wateree: 1072,
  murray: 1071,
  keowee: 1068,
  hartwell: 1029,
  norman: 232
};
async function fetchLakeMonsterIntel(key) {
  const id = LAKEMONSTER_IDS[key];
  if (!id) return null;
  const url = `https://lakemonster.com/lake/SC/${encodeURIComponent((LAKE_INTEL[key]?.displayName || key).replace(/\s+/g, "-"))}-water-temperature-${id}`;
  try {
    const r = await fetchText(url);
    if (!r.ok || !r.text) return null;
    const text = stripHtml(r.text);
    const water = text.match(/(?:Right Now[\s\S]{0,250}?Water\s*|Water\s*)(\d{2,3})°/i) || text.match(/Water\s*(\d{2,3})°F/i);
    const acres = text.match(/([0-9,]+)\s*acres/i);
    const elev = text.match(/([0-9,]+)\s*ft\s*elev/i);
    const fishCount = text.match(/(\d+)\s*fish species/i);
    const bite = text.match(/Bite\s*(\d\s*\/\s*5)/i);
    const pressure = text.match(/Pressure\s*([0-9.]+)\s*(rising|falling|stable)/i);
    const wind = text.match(/Wind\s*(\d{1,2})\s*mph\s*([A-Z]{1,3})?/i);
    const species = [];
    const speciesNames = ["Largemouth bass", "Smallmouth bass", "Spotted bass", "Striped bass", "White bass", "Bluegill", "Black crappie", "White crappie", "Catfish", "Channel catfish", "Flathead catfish", "Blue catfish", "Walleye", "Trout"];
    for (const sp of speciesNames) {
      if (new RegExp(sp.replace(/ /g, "\\s+"), "i").test(text) && !species.includes(sp)) species.push(sp);
    }
    let context = "";
    const ctxMatch = text.match(/Today['’]?s forecast for Lake[^.]+\./i) || text.match(/Fishable[\s\S]{0,450}?water temp[\s\S]{0,250}/i);
    if (ctxMatch) context = ctxMatch[0].replace(/\s+/g, " ").trim().slice(0, 500);
    return {
      source: url,
      note: "VERIFY: LakeMonster is a third-party/model/aggregate source, not official DNR/USGS/utility data.",
      waterTemp_F: water ? parseInt(water[1], 10) : null,
      acreage: acres ? acres[1] : null,
      elevation_ft: elev ? elev[1] : null,
      fishSpeciesCount: fishCount ? parseInt(fishCount[1], 10) : null,
      species: species.slice(0, 12),
      biteRating: bite ? bite[1].replace(/\s+/g, "") : null,
      pressure: pressure ? `${pressure[1]} ${pressure[2]}` : null,
      wind: wind ? `${wind[1]} mph${wind[2] ? " " + wind[2] : ""}` : null,
      context
    };
  } catch (_) {
    return null;
  }
}
__name(fetchLakeMonsterIntel, "fetchLakeMonsterIntel");
function stripHtml(html) {
  return String(html || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}
__name(stripHtml, "stripHtml");
async function fetchAhqFishingReport(slug) {
  if (!slug) return null;
  const url = "https://www.anglersheadquarters.com/pages/" + slug + "-fishing-report";
  try {
    const r = await fetchText(url);
    if (!r.ok || !r.text) return null;

    // AHQ pages have a large nav/product header before the fishing report.
    // Anchor in raw HTML BEFORE stripping tags — nav links are <a> elements
    // that disappear on strip, but the text they generate still lands in the
    // stripped output before the real report content.
    // Strategy: find the first <article, <div class="rte", or a known
    // AHQ content marker in raw HTML and slice there before stripping.
    let rawHtml = r.text;
    const htmlAnchors = [
      rawHtml.search(/<article[\s>]/i),
      rawHtml.search(/class=["'][^"']*\brte\b[^"']*["']/i),
      rawHtml.search(/class=["'][^"']*article[^"']*body[^"']*["']/i),
      rawHtml.search(/Learn more about/i),
      rawHtml.search(/Recent [A-Za-z]+ (Lake|Fishing)/i),
    ].filter(i => i >= 0);
    if (htmlAnchors.length) {
      rawHtml = rawHtml.slice(Math.min(...htmlAnchors));
    }

    const text = stripHtml(rawHtml);

    const idxs = [
      text.search(/morning surface water temp/i),
      text.search(/water temp/i),
      text.search(/striper|striped bass|largemouth|crappie|catfish/i),
      text.search(/fishing has been|bite has been|fish are/i),
    ].filter((i) => i >= 0);
    if (!idxs.length) return null;
    const idx = Math.min(...idxs);
    let summary = text.slice(Math.max(0, idx - 100), idx + 900).trim();
    if (summary.length > 1e3) summary = summary.slice(0, 1e3) + "\u2026";
    return { source: url, summary };
  } catch (_) {
    return null;
  }
}
__name(fetchAhqFishingReport, "fetchAhqFishingReport");
function lakeKeyFromName(lakeName) {
  const raw = String(lakeName || "").toLowerCase();
  const normalized = raw.replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const aliases = {
    wateree: "wateree",
    murray: "murray",
    marion: "marion",
    moultrie: "moultrie",
    monticello: "monticello",
    greenwood: "greenwood",
    secession: "secession",
    keowee: "keowee",
    jocassee: "jocassee",
    hartwell: "hartwell",
    thurmond: "thurmond", 
    "clarks hill": "thurmond",
    "clark hill": "thurmond",
    russell: "russell",
    wylie: "wylie",
    norman: "norman"
  };
  for (const [frag, key] of Object.entries(aliases)) {
    if (normalized.includes(frag)) return key;
  }
  return normalized.split(" ")[0] || "";
}
__name(lakeKeyFromName, "lakeKeyFromName");
var LAKE_CLARITY_PROFILES = {
  wateree: {
    displayName: "Lake Wateree",
    center: [34.41, -80.86],
    defaultNote: "Runoff usually stains upper/northern creeks first; lower/deeper main-lake water near the dam generally stays clearer longest.",
    zones: [
      { name: "Upper river / north end", sensitivity: 1.45, base: 10, likely: "stains first from Catawba/Wateree inflow and clay banks", ramps: ["Lugoff / upstream river ramps"] },
      { name: "Dutchmans Creek / upper west arms", sensitivity: 1.35, base: 8, likely: "creek-arm runoff and shallow clay banks; expect mudlines after rain", ramps: ["Dutchmans Creek area"] },
      { name: "Wateree Creek", sensitivity: 1.25, base: 8, likely: "first major cove south of dam; can muddy in backs while mouth stays fishable", ramps: ["Wateree Creek Access Area"] },
      { name: "Beaver Creek / State Park side", sensitivity: 1.05, base: 6, likely: "moderate runoff; pockets stain before main points", ramps: ["Lake Wateree State Park", "Beaver Creek Access"] },
      { name: "Colonel / June Creek", sensitivity: 1.05, base: 6, likely: "creek backs stain, mouths create fishable color breaks", ramps: ["Colonel Creek", "June Creek"] },
      { name: "Lower main-lake channel / dam basin", sensitivity: 0.7, base: 2, likely: "deepest/clearest available water after rain", ramps: ["Clearwater Cove Marina", "Buck Hill / lower lake ramps"] }
    ]
  },
  murray: {
    displayName: "Lake Murray",
    center: [34.08, -81.35],
    defaultNote: "Upper river/creek arms stain first; dam/lower-lake herring water generally stays clearer.",
    zones: [
      { name: "Upper Saluda / river arms", sensitivity: 1.4, base: 8, likely: "muddy first after rain", ramps: ["River Bend", "Kempsons Bridge"] },
      { name: "Major creek backs", sensitivity: 1.15, base: 6, likely: "stained backs, cleaner mouths", ramps: ["creek-arm ramps"] },
      { name: "Mid-lake points / islands", sensitivity: 0.9, base: 3, likely: "slight stain after moderate rain", ramps: ["Hilton", "Dreher Island"] },
      { name: "Dam / lower lake", sensitivity: 0.65, base: 1, likely: "clearest water and herring-oriented bite", ramps: ["Lake Murray Dam", "Larry Koon"] }
    ]
  },
  marion: {
    displayName: "Lake Marion",
    center: [33.55, -80.3],
    defaultNote: "Large shallow stump/swamp reservoir; rain creates tannic/muddy creek water and debris risk, especially in upper/swamp sections.",
    zones: [
      { name: "Upper swamp / river runs", sensitivity: 1.55, base: 12, likely: "muddy/tannic and debris-prone", ramps: ["Rimini", "Low Falls"] },
      { name: "Stump flats / shallow coves", sensitivity: 1.25, base: 10, likely: "stained with navigation hazards", ramps: ["Taw Caw", "John C. Land"] },
      { name: "Main-lake open water", sensitivity: 0.9, base: 6, likely: "wind-stained but more buffered than creek backs", ramps: ["Santee State Park"] },
      { name: "Canal / dam-influenced areas", sensitivity: 0.8, base: 4, likely: "often fishable but wind/current dependent", ramps: ["C. Alex Harvin III"] }
    ]
  },
  moultrie: {
    displayName: "Lake Moultrie",
    center: [33.28, -80.05],
    defaultNote: "Wind-driven clarity matters as much as rain; broad open water can muddy quickly on windward banks.",
    zones: [
      { name: "Windward open lake", sensitivity: 1.1, base: 8, likely: "wind-stained/choppy", ramps: ["open-water ramps"] },
      { name: "Protected leeward banks/canals", sensitivity: 0.75, base: 3, likely: "best clarity after weather", ramps: ["protected canals"] },
      { name: "Shallow grass/hard-edge zones", sensitivity: 1, base: 6, likely: "can be stained but productive on moving bait", ramps: ["Fred L. Day", "Hatchery"] }
    ]
  },
  keowee: {
    displayName: "Lake Keowee",
    center: [34.7, -82.9],
    defaultNote: "Deep clear herring lake; runoff affects backs of creeks first while main points often stay clear.",
    zones: [
      { name: "Creek backs", sensitivity: 1.15, base: 5, likely: "slight stain after rain", ramps: ["creek ramps"] },
      { name: "Main-lake points / lower lake", sensitivity: 0.45, base: 0, likely: "usually clear", ramps: ["South Cove", "High Falls"] }
    ]
  },
  hartwell: {
    displayName: "Lake Hartwell",
    center: [34.48, -82.85],
    defaultNote: "Huge herring reservoir; upper arms stain first, lower main lake stays clearer.",
    zones: [
      { name: "Upper river arms", sensitivity: 1.35, base: 8, likely: "stained/muddy after rain", ramps: ["upper-arm ramps"] },
      { name: "Creek arms", sensitivity: 1.05, base: 5, likely: "backs stain, mouths fishable", ramps: ["creek ramps"] },
      { name: "Lower main lake", sensitivity: 0.65, base: 2, likely: "clearest available water", ramps: ["Green Pond", "Broyles"] }
    ]
  }
};
function classifyClarity(score) {
  if (score < 20) return { clarity: "Clear", label: "Clear", select: "Clear" };
  if (score < 40) return { clarity: "Slight stain", label: "Slight stain", select: "Stained" };
  if (score < 65) return { clarity: "Stained", label: "Stained", select: "Stained" };
  if (score < 85) return { clarity: "Muddy", label: "Muddy", select: "Muddy" };
  return { clarity: "Muddy / debris risk", label: "Muddy / debris risk", select: "Muddy" };
}
__name(classifyClarity, "classifyClarity");
function clarityLurePack(clarity) {
  const c = String(clarity || "").toLowerCase();
  if (c.includes("clear")) return {
    colors: ["Blueback herring", "Natural pearl", "Ghost shad", "Bone", "Silver flash"],
    tactics: ["longer leads", "fluorocarbon leaders", "natural profiles", "fish deeper/clearer main-lake structure"]
  };
  if (c.includes("slight")) return {
    colors: ["Pearl/chartreuse", "Sexy shad", "Tennessee shad", "Silver/gold mix", "UV white"],
    tactics: ["target creek-mouth color breaks", "slightly larger profile", "moderate vibration"]
  };
  if (c.includes("stained")) return {
    colors: ["Chartreuse/white", "Firetiger", "Gold/copper", "Orange belly", "Black back"],
    tactics: ["fish mudline edges", "use vibration/rattles", "shorten lead around cover"]
  };
  return {
    colors: ["Black/blue", "Chartreuse/black", "Bright white/chartreuse", "Orange/red craw", "large dark silhouette"],
    tactics: ["avoid backs unless targeting catfish/cover", "fish seams and hard edges", "maximize vibration/scent", "watch debris"]
  };
}
__name(clarityLurePack, "clarityLurePack");
async function fetchOpenMeteoRain(lat, lon, tripDate) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=precipitation_sum,windspeed_10m_max,winddirection_10m_dominant&past_days=3&forecast_days=7&timezone=America%2FNew_York`;
    const r = await fetch(url, { cf: { cacheTtl: 900, cacheEverything: true } });
    if (!r.ok) return null;
    const j = await r.json();
    const times = j?.daily?.time || [];
    const precip = j?.daily?.precipitation_sum || [];
    const wind = j?.daily?.windspeed_10m_max || [];
    const wdir = j?.daily?.winddirection_10m_dominant || [];
    const idx = Math.max(0, times.indexOf(tripDate || (/* @__PURE__ */ new Date()).toISOString().slice(0, 10)));
    const mm = /* @__PURE__ */ __name((i) => i >= 0 && i < precip.length && isFinite(precip[i]) ? precip[i] : 0, "mm");
    const p24 = mm(idx - 1);
    const p48 = mm(idx - 2);
    const p72 = mm(idx - 3);
    const pTrip = mm(idx);
    const total72 = p24 + p48 + p72 + 0.5 * pTrip;
    return {
      source: url,
      date: times[idx] || tripDate,
      precip24_mm: p24,
      precip48_mm: p48,
      precip72_mm: p72,
      precipTrip_mm: pTrip,
      weighted72_mm: total72,
      weighted72_in: +(total72 / 25.4).toFixed(2),
      windMax_mph: wind[idx] != null ? Math.round(wind[idx] * 0.621371) : null,
      windDirection_deg: wdir[idx] ?? null
    };
  } catch (_) {
    return null;
  }
}
__name(fetchOpenMeteoRain, "fetchOpenMeteoRain");
async function getLakeClarity(lakeName, tripDate) {
  const key = lakeKeyFromName(lakeName);
  const profile = LAKE_CLARITY_PROFILES[key] || { displayName: lakeName, center: [34, -81], defaultNote: "No custom clarity model yet; generic creek/runoff model used.", zones: [{ name: "Creeks/upper arms", sensitivity: 1.2, base: 6, likely: "stain first", ramps: [] }, { name: "Main lake/lower basin", sensitivity: 0.75, base: 2, likely: "clearest available water", ramps: [] }] };
  const [lat, lon] = profile.center;
  const rain = await fetchOpenMeteoRain(lat, lon, tripDate);
  const rainIn = rain?.weighted72_in ?? 0;
  const rainScore = rain ? Math.min(100, rainIn * 35 + rain.precip24_mm / 25.4 * 25 + rain.precipTrip_mm / 25.4 * 20) : 20;
  const zones = profile.zones.map((z) => {
    const score = Math.max(0, Math.min(100, z.base + rainScore * z.sensitivity));
    const cls = classifyClarity(score);
    const pack2 = clarityLurePack(cls.clarity);
    return { ...z, score: Math.round(score), clarity: cls.clarity, select: cls.select, lureColors: pack2.colors, tactics: pack2.tactics };
  });
  const avg = zones.reduce((a, z) => a + z.score, 0) / Math.max(1, zones.length);
  const overall = classifyClarity(avg);
  const bestZones = [...zones].sort((a, b) => a.score - b.score).slice(0, 3);
  const dirtyZones = [...zones].sort((a, b) => b.score - a.score).slice(0, 3);
  const rampRecommendations = bestZones.map((z, i) => ({
    zone: z.name,
    ramps: z.ramps || [],
    score: Math.max(0, 100 - z.score),
    why: `${z.clarity}; ${z.likely}. ${i === 0 ? "Best clarity/safety starting point." : "Secondary option."}`
  }));
  const pack = clarityLurePack(overall.clarity);
  return {
    lake: profile.displayName || lakeName,
    key,
    tripDate,
    confidence: rain ? "medium: forecast/rainfall model, verify at ramp" : "low: no rainfall feed, generic model",
    summary: rain ? `${profile.displayName || lakeName}: ${rain.weighted72_in}" weighted rain/runoff signal. ${overall.clarity} overall predicted; upper/creek arms likely dirtier than lower/main lake.` : `${profile.displayName || lakeName}: generic clarity estimate. Verify locally.`,
    overall: { clarity: overall.clarity, select: overall.select, score: Math.round(avg), lureColors: pack.colors, tactics: pack.tactics },
    rain,
    zones,
    bestZones,
    dirtyZones,
    rampRecommendations,
    note: profile.defaultNote,
    verify: "Predicted from rainfall/forecast/wind/lake-zone rules \u2014 verify water color at the ramp before committing."
  };
}
__name(getLakeClarity, "getLakeClarity");
function getLakeIntelSourceRegistry(key) {
  const base = LAKE_INTEL_SOURCE_REGISTRY.default || {};
  const lake = LAKE_INTEL_SOURCE_REGISTRY[key] || {};
  const merged = { official: [], habitat: [], reports: [], model: [] };
  for (const tier of Object.keys(merged)) {
    merged[tier] = [...base[tier] || [], ...lake[tier] || []];
  }
  const officialCount = merged.official.length + merged.habitat.length;
  const verifyCount = merged.reports.length + merged.model.length;
  return {
    ...merged,
    summary: {
      officialCount,
      verifyCount,
      trustModel: "OFFICIAL/CURATED facts first; THIRD_PARTY/MODEL sources are supplemental and must be verified."
    }
  };
}
__name(getLakeIntelSourceRegistry, "getLakeIntelSourceRegistry");
async function getLakeIntel(lakeName) {
  const key = lakeKeyFromName(lakeName);
  const sourceRegistry = getLakeIntelSourceRegistry(key);
  const profile = LAKE_INTEL[key] || {
    displayName: lakeName || key || "Unknown lake",
    primarySportFish: [],
    forage: [],
    stocking: "VERIFY: No curated stocking profile yet. Check state DNR stocking, creel-limit, and lake-management pages before relying on this.",
    spottedBass: "No verified spotted-bass note yet.",
    habitat: "No curated habitat profile yet.",
    bottom: "Unknown / verify with Navionics, sonar logs, local reports, and state habitat maps.",
    hazards: "Unknown / verify ramps, lake level, stump fields, timber, shoals, and boat traffic locally.",
    seasonalPattern: "Use current water temperature, forage, and recent reports to build a pattern.",
    tacticalNotes: ["No verified curated profile yet \u2014 treat this as a research checklist, not a fact sheet."]
  };
  const lakeCfg = LAKES[key];
  const latestReport = lakeCfg?.ahq ? await fetchAhqFishingReport(lakeCfg.ahq) : null;
  const lakeMonster = await fetchLakeMonsterIntel(key);
  const sources = [
    { label: "State fisheries / regulations", url: "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits" }
  ];
  if (latestReport?.source) sources.push({ label: "Angler's Headquarters fishing report (VERIFY: third-party scraped text)", url: latestReport.source });
  if (lakeMonster?.source) sources.push({ label: "LakeMonster lake context (VERIFY: third-party aggregate/model)", url: lakeMonster.source });
  if (lakeCfg) sources.push({ label: "TrollMap live level worker", url: `/lake?lake=${encodeURIComponent(key)}` });
  return {
    lake: profile.displayName || lakeName,
    key,
    profile,
    latestReport,
    lakeMonster,
    sourceRegistry,
    sources,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    confidence: LAKE_INTEL[key] ? "curated_profile_plus_live_scrape_when_available" : "generic_unverified_profile"
  };
}
__name(getLakeIntel, "getLakeIntel");
var RIVERS = {
  wateree: {
    label: "Wateree River (below Wateree Dam)",
    operator: "Duke Energy",
    damName: "Wateree Dam",
    damLakeKey: "wateree",
    // → cross-link to LAKES.wateree pool data
    dukeBasinId: 1,
    // → fetchDukeFlowArrivals(1) returns the Catawba/Wateree schedule
    // River centerline reference points: river_mi 0 = dam, increasing downstream.
    // CORRECTED 2026-06-18 — previous version had several errors:
    //   * Dam coords were ~11 mi off (had -80.86, actual -80.7004 per damsoftheworld.com & SC Picture Project)
    //   * June Creek + Colonel Creek were placed on the RIVER but they're actually
    //     ramps on LAKE Wateree (above the dam) — wrong waterbody entirely
    //   * Sparkleberry Swamp was placed at mile 35; it's actually at the BOTTOM end
    //     of the free-flowing river, at the head of Lake Marion (~mile 48)
    //   * Total length "75 mi" from SC Encyclopedia includes the Catawba portion
    //     above Lake Wateree; the free-flowing river BELOW the dam is ~48 mi
    riverLength_mi: 48,
    surgeSpeed_mph: 2.5,
    // calibrated: Duke API anchor (Hwy 1/601, 7.4 mi) arrives ~3h after generation start
    // Duke's "Highway 1/Highway 601 Landing" mile-marker corresponds to the
    // USGS 02148000 gauge: "7.4 mi downstream from Wateree Dam, at river mile 68.8"
    // (per USGS site metadata https://waterdata.usgs.gov/nwis/wys_rpt/?site_no=02148000)
    dukeAnchorRiverMi: 7.4,
    dukeAnchorLat: 34.2446,
    dukeAnchorLon: -80.654,
    // Surge severity attenuation — piecewise model calibrated against the
    // documented paddler observation of "5 ft surge still arriving at mile 35"
    // (paddling.com Wateree trip report) and the fact that the river fans into
    // Lake Marion at the confluence (~mile 48) where the surge dissipates fast.
    //   miles  0-20: 1.00 → 0.80   (full severity)
    //   miles 20-40: 0.80 → 0.60   (moderate — matches "5 ft at mile 35")
    //   miles 40-48: 0.60 → 0.20   (rapid attenuation as river enters Marion)
    //   past 48:     0.20          (in lake — surge dispersed into vast volume)
    surgeAttenuation: { type: "piecewise", knots: [
      { mi: 0, sev: 1 },
      { mi: 20, sev: 0.8 },
      { mi: 40, sev: 0.6 },
      { mi: 48, sev: 0.2 },
      { mi: 999, sev: 0.2 }
    ] },
    // Centerline waypoints (N → S, downstream). Only VERIFIED locations.
    // River-miles calibrated using sinuosity factor ~1.07 derived from the
    // known Dam → Camden segment (6.9 mi straight-line = 7.4 river miles).
    // Centerline waypoints sourced from VERIFIED TrollMap LAUNCHES data
    // (index.html line 1164 "Wateree River" entry) plus USGS gauge metadata.
    // River-miles calibrated using sinuosity factor 1.07 derived from the
    // Dam → Hwy 1 segment (USGS metadata: site 02148000 = "7.4 mi downstream
    // from Wateree Dam, at river mile 68.8").
    centerline: [
      { name: "Wateree Dam (Duke hydro plant)", lat: 34.3376, lon: -80.7004, mi: 0 },
      { name: "Lugoff (TrollMap)", lat: 34.33346, lon: -80.69973, mi: 0.3 },
      {
        name: "Highway 1 / Camden (TrollMap; USGS 02148000 site)",
        lat: 34.24486,
        lon: -80.65403,
        mi: 7.4
      },
      { name: "WT Billy Tolar (TrollMap)", lat: 33.94721, lon: -80.62891, mi: 29 },
      { name: "USGS 02148315 (below Eastover)", lat: 33.8285, lon: -80.6204, mi: 38 },
      {
        name: "Wateree/Congaree confluence (Sparkleberry / head of Lake Marion)",
        lat: 33.72,
        lon: -80.46,
        mi: 48
      }
    ],
    gauges: [
      {
        site: "02148000",
        name: "Wateree River near Camden, SC",
        primary: true,
        lat: 34.2446,
        lon: -80.654,
        riverMi: 7.4
      },
      {
        site: "02148315",
        name: "Wateree River below Eastover, SC",
        lat: 33.8285,
        lon: -80.6204,
        riverMi: 38
      }
    ],
    // Tuned for Wateree River below the dam — typical baseflow ~500 cfs,
    // generation spikes to 5000-9000 cfs.
    kayakThresholds: {
      cfsCalm: 800,
      cfsNormal: 2500,
      cfsPushy: 5e3,
      cfsDanger: 8e3,
      gageRiseDangerFtPerHr: 1,
      // dam-release surge cutoff
      coldTempStressF: 55
    },
    notes: "Wateree Dam generation typically pulses afternoons/evenings. A sudden rise of 2+ ft in <1 hour means generation just started \u2014 be off the water or well off the channel BEFORE this happens."
  },
  congaree: {
    label: "Congaree River (Columbia, SC)",
    operator: "Confluence of Saluda (Dominion) + Broad (SCE&G)",
    damName: "Lake Murray Dam (via Saluda) + Parr Shoals (via Broad)",
    gauges: [
      {
        site: "02169500",
        name: "Congaree River at Columbia, SC",
        primary: true,
        lat: 33.9971,
        lon: -81.047
      },
      {
        site: "02169672",
        name: "Columbia Canal at Columbia, SC",
        lat: 33.9837,
        lon: -81.0353
      }
    ],
    kayakThresholds: {
      cfsCalm: 2e3,
      cfsNormal: 6e3,
      cfsPushy: 12e3,
      cfsDanger: 2e4,
      gageRiseDangerFtPerHr: 0.8,
      coldTempStressF: 55
    },
    notes: "Receives both Saluda (cold, dam-fed) and Broad (warm). Both Lake Murray and Parr Shoals can pulse independently."
  },
  saluda: {
    label: "Lower Saluda River (below Lake Murray Dam)",
    operator: "Dominion Energy",
    damName: "Lake Murray (Saluda Hydroelectric)",
    damLakeKey: "murray",
    dominionSaluda: true,
    // → scrape dominionenergy.com for color-coded flow status
    gauges: [
      {
        site: "02168504",
        name: "Saluda River below Lake Murray Dam",
        primary: true,
        lat: 34.0539,
        lon: -81.2559
      },
      {
        site: "02169000",
        name: "Saluda River near Columbia, SC",
        lat: 33.9913,
        lon: -81.1031
      }
    ],
    // Cold tailwater — coming off the bottom of Lake Murray. Often 52-58°F
    // even in summer. Class II-III rapids when generating.
    kayakThresholds: {
      cfsCalm: 700,
      cfsNormal: 2500,
      cfsPushy: 5500,
      cfsDanger: 9e3,
      gageRiseDangerFtPerHr: 1.5,
      coldTempStressF: 60
      // higher cutoff — this river is cold even in summer
    },
    notes: "COLD TAILWATER. Water is typically 50-58\xB0F year-round (from bottom of Lake Murray). Hypothermia is a serious capsize risk even in July. Dominion generation pulses can raise flow from 700 \u2192 7000 cfs in 30 min. Famous trout fishery for the same reason it's dangerous."
  },
  broad: {
    label: "Broad River (above Columbia, SC)",
    operator: "SCE&G / Dominion (Parr Shoals)",
    damName: "Parr Shoals Dam",
    dukeBasinId: 10,
    // → BroadRiver basin in Duke API (basin 10)
    gauges: [
      {
        site: "02161000",
        name: "Broad River near Carlisle, SC",
        primary: true,
        lat: 34.5878,
        lon: -81.4214
      },
      {
        site: "02156500",
        name: "Broad River near Gaffney, SC",
        lat: 35.0001,
        lon: -81.6131
      },
      {
        site: "02160991",
        name: "Broad River at Alston, SC",
        lat: 34.2737,
        lon: -81.2754
      }
    ],
    kayakThresholds: {
      cfsCalm: 800,
      cfsNormal: 3e3,
      cfsPushy: 7e3,
      cfsDanger: 12e3,
      gageRiseDangerFtPerHr: 1.2,
      coldTempStressF: 55
    },
    notes: "Less dam-controlled than Saluda. Major flood risk after heavy rain in the upstream piedmont."
  },
  santee: {
    label: "Santee River (below Lake Marion)",
    operator: "Santee Cooper / USACE",
    damName: "Wilson Dam (Lake Marion) + Santee Rediversion Canal",
    damLakeKey: "marion",
    gauges: [
      {
        site: "02171645",
        name: "Santee River near Pineville, SC (Fort Church)",
        primary: true,
        lat: 33.4196,
        lon: -80.0142
      }
    ],
    kayakThresholds: {
      cfsCalm: 1500,
      cfsNormal: 5e3,
      cfsPushy: 15e3,
      cfsDanger: 25e3,
      gageRiseDangerFtPerHr: 1,
      coldTempStressF: 55
    },
    notes: "Tidal influence in lower reaches. The Rediversion Canal returns flow to the Santee from the Cooper system \u2014 flow direction can reverse."
  },
  cooper: {
    label: "Cooper River (Pinopolis tailrace to Charleston Harbor)",
    operator: "Santee Cooper",
    damName: "Pinopolis Dam (Lake Moultrie)",
    damLakeKey: "moultrie",
    gauges: [
      {
        site: "02172040",
        name: "Cooper River at Mobay near Goose Creek, SC",
        primary: true,
        lat: 33.0429,
        lon: -79.9587
      },
      {
        site: "02172053",
        name: "Cooper River at Filbin Creek (tidal)",
        lat: 32.8807,
        lon: -79.974
      }
    ],
    kayakThresholds: {
      cfsCalm: 500,
      cfsNormal: 2500,
      cfsPushy: 6e3,
      cfsDanger: 12e3,
      gageRiseDangerFtPerHr: 2,
      // tidal — gauge swings a lot naturally
      coldTempStressF: 50
    },
    notes: "TIDAL throughout most fishable sections. Gauge height swings ~5 ft with the tide regardless of dam. Pinopolis lock is operated 4x/day for boat passage. Salinity gradient \u2014 saltwater intrusion past the Tee Creek area on incoming tides."
  }
};
function assessKayakSafety(riverKey, gaugeData, thresholds) {
  const t = thresholds;
  const reasons = [];
  const metrics = {};
  let level = "go";
  const escalate = /* @__PURE__ */ __name((newLevel) => {
    const order = { "go": 0, "caution": 1, "no-go": 2 };
    if (order[newLevel] > order[level]) level = newLevel;
  }, "escalate");
  const cfs = gaugeData.streamflow;
  if (cfs != null) {
    metrics.streamflow_cfs = cfs;
    if (cfs >= t.cfsDanger) {
      escalate("no-go");
      reasons.push(`Streamflow ${cfs} cfs is in the DANGER zone (>${t.cfsDanger} for kayak/canoe). Strong current, swimming hazardous.`);
    } else if (cfs >= t.cfsPushy) {
      escalate("caution");
      reasons.push(`Streamflow ${cfs} cfs is PUSHY for kayaks (>${t.cfsPushy}). Experienced paddlers only.`);
    } else if (cfs >= t.cfsNormal) {
      reasons.push(`Streamflow ${cfs} cfs is normal-to-high \u2014 paddleable with care.`);
    } else if (cfs >= t.cfsCalm) {
      reasons.push(`Streamflow ${cfs} cfs is in the comfortable kayaking range.`);
    } else {
      reasons.push(`Streamflow ${cfs} cfs is LOW \u2014 expect skinny water and possible portaging over shoals.`);
    }
  }
  if (gaugeData.rateOfRiseFtPerHr != null) {
    metrics.rate_of_rise_ft_per_hr = Math.round(gaugeData.rateOfRiseFtPerHr * 100) / 100;
    if (gaugeData.rateOfRiseFtPerHr >= t.gageRiseDangerFtPerHr) {
      escalate("no-go");
      reasons.push(`\u26A0 RAPID RISE: gauge is rising at ${metrics.rate_of_rise_ft_per_hr} ft/hr \u2014 likely dam generation surge or flash flood. Get off the river.`);
    } else if (gaugeData.rateOfRiseFtPerHr >= t.gageRiseDangerFtPerHr * 0.5) {
      escalate("caution");
      reasons.push(`Gauge rising at ${metrics.rate_of_rise_ft_per_hr} ft/hr \u2014 possible dam release starting. Monitor closely.`);
    }
  }
  if (gaugeData.tempC != null) {
    const tempF = Math.round(gaugeData.tempC * 9 / 5 + 32);
    metrics.water_temp_F = tempF;
    if (tempF < t.coldTempStressF) {
      escalate("caution");
      reasons.push(`Water temp ${tempF}\xB0F \u2014 COLD-WATER capsize risk. Wear PFD + appropriate thermal protection (drysuit/wetsuit recommended below ${t.coldTempStressF}\xB0F).`);
    }
  }
  if (!reasons.length) reasons.push("Conditions appear normal \u2014 paddleable.");
  return { status: level, reasons, metrics };
}
__name(assessKayakSafety, "assessKayakSafety");
function snapToRiver(centerline, userLat, userLon) {
  let best = null;
  for (const wp of centerline) {
    const d = Math.hypot((wp.lat - userLat) * 69, (wp.lon - userLon) * 55);
    if (!best || d < best.dist) best = { dist: d, wp };
  }
  return best;
}
__name(snapToRiver, "snapToRiver");
function interpolateSeverity(att, mi) {
  if (!att) return 1;
  if (att.type === "piecewise" && Array.isArray(att.knots) && att.knots.length >= 2) {
    const ks = att.knots;
    if (mi <= ks[0].mi) return ks[0].sev;
    if (mi >= ks[ks.length - 1].mi) return ks[ks.length - 1].sev;
    for (let i = 0; i < ks.length - 1; i++) {
      const a = ks[i], b = ks[i + 1];
      if (mi >= a.mi && mi <= b.mi) {
        const t2 = (mi - a.mi) / Math.max(1e-3, b.mi - a.mi);
        return a.sev + t2 * (b.sev - a.sev);
      }
    }
  }
  const t = Math.max(0, Math.min(1, (mi - (att.fullSeverityMi || 0)) / Math.max(1, (att.dispersedMi || 70) - (att.fullSeverityMi || 0))));
  return Math.max(att.minFactor || 0.2, 1 - t * (1 - (att.minFactor || 0.2)));
}
__name(interpolateSeverity, "interpolateSeverity");
function estimateSurgeAt(river, userLat, userLon) {
  if (!river.centerline || userLat == null || userLon == null) return null;
  const snap = snapToRiver(river.centerline, userLat, userLon);
  if (!snap || snap.dist > 10) return null;
  const userRiverMi = snap.wp.mi;
  const minutesFromDam = userRiverMi / river.surgeSpeed_mph * 60;
  const severity = interpolateSeverity(river.surgeAttenuation, userRiverMi);
  return {
    nearestWaypoint: snap.wp.name,
    distance_to_waypoint_mi: Math.round(snap.dist * 10) / 10,
    river_mile_from_dam: Math.round(userRiverMi * 10) / 10,
    river_miles_remaining_to_confluence: Math.round((river.riverLength_mi - userRiverMi) * 10) / 10,
    minutes_from_generation_start: Math.round(minutesFromDam),
    surge_speed_mph: river.surgeSpeed_mph,
    surge_severity_factor: Math.round(severity * 100) / 100,
    surge_severity_label: severity > 0.75 ? "full" : severity > 0.5 ? "moderate" : severity > 0.3 ? "reduced" : "minor"
  };
}
__name(estimateSurgeAt, "estimateSurgeAt");
async function getRiver(key, opts = {}) {
  const cfg = RIVERS[key];
  if (!cfg) return { error: `unknown river: ${key}` };
  const out = {
    river: cfg.label,
    operator: cfg.operator,
    dam: cfg.damName,
    notes: cfg.notes,
    gauges: [],
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  };
  for (const g of cfg.gauges) {
    const data = await fetchUsgs(
      g.site,
      "00010,00060,00065,63160",
      /*periodDays*/
      2
    );
    const rec = {
      site: g.site,
      name: g.name,
      lat: g.lat,
      lon: g.lon,
      primary: !!g.primary,
      streamflow_cfs: data.streamflow ?? null,
      gage_height_ft: data.gageHeight ?? null,
      water_elevation_ft_navd88: data.elevationNavd88 ?? null,
      water_temperature_F: data.tempC != null ? Math.round(data.tempC * 9 / 5 + 32) : null,
      water_temperature_C: data.tempC ?? null,
      timestamp: data.timestamp ?? null
    };
    if (g.primary) {
      const rate = await computeGageRateOfRise(g.site);
      if (rate != null) rec.rate_of_rise_ft_per_hr = Math.round(rate * 100) / 100;
    }
    out.gauges.push(rec);
  }
  if (cfg.damLakeKey && LAKES[cfg.damLakeKey]) {
    try {
      const lakeData = await resolveLake(cfg.damLakeKey);
      out.upstream_lake = {
        name: cfg.damLakeKey,
        elevation_ft: lakeData.elevation_ft,
        percent_full: lakeData.percent_full,
        full_pool_ft: lakeData.full_pool_ft,
        special_message: lakeData.special_message
      };
    } catch (_) {
    }
  }
  if (cfg.dukeBasinId) {
    const sched = await fetchDukeFlowArrivals(cfg.dukeBasinId);
    if (sched && sched.arrivals.length) {
      out.dam_schedule = {
        type: "duke_flow_arrivals",
        operator: "Duke Energy",
        basinName: sched.basinName,
        lastUpdated: sched.lastUpdated,
        next: sched.arrivals[0],
        upcoming: sched.arrivals.slice(0, 6),
        source: sched.source
      };
      if (cfg.dukeAnchorRiverMi != null && sched.arrivals[0].arrivalEpoch) {
        const anchorTravelMs = cfg.dukeAnchorRiverMi / cfg.surgeSpeed_mph * 3600 * 1e3;
        out.dam_schedule.generationStartEpoch = sched.arrivals[0].arrivalEpoch - anchorTravelMs;
      }
    }
  }
  if (cfg.dominionSaluda) {
    const dom = await fetchDominionSaludaStatus();
    if (dom) {
      out.dam_schedule = {
        type: "dominion_color_status",
        operator: "Dominion Energy",
        currentColor: dom.currentColor,
        plannedColor: dom.plannedColor,
        currentRange: dom.currentRange,
        plannedRange: dom.plannedRange,
        currentCfsBand: dom.currentCfsBand,
        plannedCfsBand: dom.plannedCfsBand,
        colorLegend: dom.colorLegend,
        source: dom.source
      };
    }
  }
  if (opts.userLat != null && opts.userLon != null) {
    const loc = estimateSurgeAt(cfg, opts.userLat, opts.userLon);
    if (loc) {
      out.user_location = {
        lat: opts.userLat,
        lon: opts.userLon,
        ...loc
      };
      if (out.dam_schedule?.generationStartEpoch != null) {
        const surgeAtUserEpoch = out.dam_schedule.generationStartEpoch + loc.minutes_from_generation_start * 60 * 1e3;
        out.user_location.surge_arrival_epoch = surgeAtUserEpoch;
        out.user_location.surge_arrival_iso = new Date(surgeAtUserEpoch).toISOString();
        out.user_location.minutes_until_surge_at_user = Math.round((surgeAtUserEpoch - Date.now()) / 6e4);
      }
    }
  }
  const primary = out.gauges.find((g) => g.primary) || out.gauges[0];
  if (primary) {
    const assessment = assessKayakSafety(key, {
      streamflow: primary.streamflow_cfs,
      tempC: primary.water_temperature_C,
      rateOfRiseFtPerHr: primary.rate_of_rise_ft_per_hr
    }, cfg.kayakThresholds);
    if (out.user_location?.minutes_until_surge_at_user != null) {
      const m = out.user_location.minutes_until_surge_at_user;
      const sev = out.user_location.surge_severity_factor;
      const sevLabel = out.user_location.surge_severity_label;
      const arrTime = new Date(out.user_location.surge_arrival_epoch).toLocaleTimeString("en-US", { timeZone: "America/New_York" });
      const riverMi = out.user_location.river_mile_from_dam;
      const imminentMin = 120 / Math.max(0.5, sev);
      const headsUpMin = 360 / Math.max(0.5, sev);
      if (m > 0 && m < imminentMin && sev >= 0.5) {
        const order = { "go": 0, "caution": 1, "no-go": 2 };
        if (order[assessment.status] < 2) assessment.status = "no-go";
        assessment.reasons.unshift(
          `\u{1F6D1} ${sevLabel.toUpperCase()} dam surge arrives at YOUR LOCATION (river mile ${riverMi}) in ${m} min (~${arrTime} ET). Get off the water now.`
        );
      } else if (m > 0 && m < headsUpMin) {
        if (assessment.status === "go") assessment.status = "caution";
        const hrs = Math.round(m / 60 * 10) / 10;
        assessment.reasons.unshift(
          `\u26A0 ${sevLabel.toUpperCase()} dam surge expected at YOUR LOCATION (river mile ${riverMi}, ~${out.user_location.river_miles_remaining_to_confluence} mi above confluence) at ~${arrTime} ET (in ${hrs}h). Plan to be off the water by then.`
        );
      } else if (m > 0) {
        const hrs = Math.round(m / 60 * 10) / 10;
        assessment.reasons.push(
          `\u2139 Next dam surge reaches your location (mile ${riverMi}) in ~${hrs}h (${sevLabel} severity at this distance \u2014 surge weakens with distance from dam).`
        );
      }
    } else if (out.dam_schedule?.type === "duke_flow_arrivals" && out.dam_schedule.next) {
      const next = out.dam_schedule.next;
      const minutesUntil = (next.arrivalEpoch - Date.now()) / 6e4;
      if (minutesUntil > 0 && minutesUntil < 120) {
        const order = { "go": 0, "caution": 1, "no-go": 2 };
        if (order[assessment.status] < 2) assessment.status = "no-go";
        assessment.reasons.unshift(
          `\u{1F6D1} SCHEDULED DAM RELEASE arrives at ${next.mileMarkerName} in ${Math.round(minutesUntil)} min (~${new Date(next.arrivalEpoch).toLocaleTimeString("en-US", { timeZone: "America/New_York" })} ET). Severity decreases with distance from dam \u2014 pass your coordinates with ?lat=X&lon=Y for a location-specific estimate.`
        );
      } else if (minutesUntil > 0 && minutesUntil < 360) {
        if (assessment.status === "go") assessment.status = "caution";
        assessment.reasons.unshift(
          `\u26A0 Dam release scheduled to arrive at ${next.mileMarkerName} at ~${new Date(next.arrivalEpoch).toLocaleTimeString("en-US", { timeZone: "America/New_York" })} ET (in ${Math.round(minutesUntil / 60 * 10) / 10}h). For location-specific timing, pass your coordinates with ?lat=X&lon=Y.`
        );
      }
    }
    if (out.dam_schedule?.type === "dominion_color_status") {
      const cur = out.dam_schedule.currentColor;
      if (cur === "red") {
        assessment.status = "no-go";
        assessment.reasons.unshift("\u{1F6D1} Dominion reports current flow in RED RANGE \u2014 class IV-V whitewater, dangerous even for experts.");
      } else if (cur === "yellow") {
        if (assessment.status === "go") assessment.status = "caution";
        assessment.reasons.unshift("\u26A0 Dominion reports current flow in YELLOW RANGE \u2014 experienced paddlers only.");
      } else if (cur === "blue") {
        assessment.reasons.push("Dominion reports current flow in BLUE RANGE (normal/safe paddling).");
      }
      const plan = out.dam_schedule.plannedColor;
      if (plan && plan !== cur) {
        if (plan === "red" || plan === "yellow") {
          if (assessment.status === "go") assessment.status = "caution";
          assessment.reasons.push(`\u26A0 Dominion forecasts flow rising to ${plan.toUpperCase()} range \u2014 be ready to exit.`);
        }
      }
    }
    out.kayak_assessment = assessment;
  }
  return out;
}
__name(getRiver, "getRiver");
async function computeGageRateOfRise(site) {
  try {
    const url = `https://waterservices.usgs.gov/nwis/iv/?sites=${site}&parameterCd=00065&format=rdb&period=PT3H`;
    const r = await fetch(url, { cf: { cacheTtl: 120 } });
    if (!r.ok) return null;
    const text = await r.text();
    const lines = text.split("\n").filter((l) => l && !l.startsWith("#"));
    if (lines.length < 4) return null;
    const header = lines[0].split("	");
    let col = -1;
    for (let i = 4; i < header.length; i++) {
      if (header[i] && !header[i].endsWith("_cd") && header[i].includes("00065")) {
        col = i;
        break;
      }
    }
    if (col < 0) return null;
    const dataLines = lines.slice(2).filter((l) => l.startsWith("USGS"));
    if (dataLines.length < 4) return null;
    const samples = dataLines.map((l) => {
      const p = l.split("	");
      const v = parseFloat(p[col]);
      const [date, time] = p[2].split(" ");
      const ts = (/* @__PURE__ */ new Date(`${date}T${time}:00`)).getTime();
      return { ts, v };
    }).filter((s) => isFinite(s.v) && isFinite(s.ts));
    if (samples.length < 2) return null;
    const latest = samples[samples.length - 1];
    const targetTs = latest.ts - 60 * 60 * 1e3;
    let closest = samples[0];
    let bestDiff = Math.abs(samples[0].ts - targetTs);
    for (const s of samples) {
      const d = Math.abs(s.ts - targetTs);
      if (d < bestDiff) {
        closest = s;
        bestDiff = d;
      }
    }
    const dtHr = (latest.ts - closest.ts) / 36e5;
    if (dtHr <= 0) return null;
    return (latest.v - closest.v) / dtHr;
  } catch (_) {
    return null;
  }
}
__name(computeGageRateOfRise, "computeGageRateOfRise");
var DUKE_API_BASE = "https://api.hydro-derived.duke-energy.app";
async function fetchDukeFlowArrivals(basinId) {
  try {
    const r = await fetch(`${DUKE_API_BASE}/rivers/flow-arrivals/${basinId}`, {
      cf: { cacheTtl: 300, cacheEverything: true },
      headers: {
        "User-Agent": "TrollMap/12 Worker",
        "Origin": "https://lakes.hydro-derived.duke-energy.app",
        "Referer": "https://lakes.hydro-derived.duke-energy.app/"
      }
    });
    if (!r.ok) return null;
    const j = await r.json();
    const out = [];
    const now = Date.now();
    for (const dam of j?.Dams || []) {
      for (const ev of dam?.FlowArrivalRecessions || []) {
        const arr = ev.Arrival ? /* @__PURE__ */ new Date(ev.Arrival + (ev.Arrival.endsWith("Z") ? "" : "-04:00")) : null;
        const rec = ev.Recedes ? /* @__PURE__ */ new Date(ev.Recedes + (ev.Recedes.endsWith("Z") ? "" : "-04:00")) : null;
        if (!arr || arr.getTime() < now - 12 * 3600 * 1e3) continue;
        out.push({
          damName: ev.DamName,
          mileMarkerName: ev.MileMarkerName,
          arrival: ev.Arrival,
          recedes: ev.Recedes,
          arrivalEpoch: arr ? arr.getTime() : null,
          recedesEpoch: rec ? rec.getTime() : null
        });
      }
    }
    out.sort((a, b) => (a.arrivalEpoch || 0) - (b.arrivalEpoch || 0));
    return {
      basinName: j.RiverBasinName,
      basinId: j.RiverBasinId,
      lastUpdated: j.LastUpdated,
      arrivals: out,
      source: `${DUKE_API_BASE}/rivers/flow-arrivals/${basinId}`
    };
  } catch (e) {
    return null;
  }
}
__name(fetchDukeFlowArrivals, "fetchDukeFlowArrivals");
async function fetchDominionSaludaStatus() {
  const COLOR_RANGES = {
    green: { min: 0, max: 350, label: "GREEN \u2014 very low, scraping likely" },
    blue: { min: 350, max: 2e3, label: "BLUE \u2014 normal/safe paddling range" },
    yellow: { min: 2e3, max: 8e3, label: "YELLOW \u2014 high flow, experienced paddlers only" },
    red: { min: 8e3, max: 2e4, label: "RED \u2014 DANGEROUS, class IV-V whitewater, do not enter" }
  };
  try {
    const r = await fetch("https://www.dominionenergy.com/about/lakes-and-recreation/lower-saluda-river-sc", {
      cf: { cacheTtl: 600, cacheEverything: true },
      headers: { "User-Agent": "TrollMap/12 Worker", "Accept": "text/html" }
    });
    if (!r.ok) return null;
    const html = await r.text();
    const cur = html.match(/currently in the[^<]{0,40}<span[^>]*>\s*(blue|yellow|red|green)/i);
    const plan = html.match(/expected to be in the[^<]{0,40}<span[^>]*>\s*(blue|yellow|red|green)/i);
    const currentColor = cur ? cur[1].toLowerCase() : null;
    const plannedColor = plan ? plan[1].toLowerCase() : null;
    return {
      currentColor,
      plannedColor,
      currentRange: currentColor ? COLOR_RANGES[currentColor]?.label : null,
      plannedRange: plannedColor ? COLOR_RANGES[plannedColor]?.label : null,
      currentCfsBand: currentColor ? COLOR_RANGES[currentColor] : null,
      plannedCfsBand: plannedColor ? COLOR_RANGES[plannedColor] : null,
      source: "https://www.dominionenergy.com/about/lakes-and-recreation/lower-saluda-river-sc",
      colorLegend: COLOR_RANGES
    };
  } catch (e) {
    return null;
  }
}
__name(fetchDominionSaludaStatus, "fetchDominionSaludaStatus");
async function resolveLake(lakeName) {
  const key = Object.keys(LAKES).find((k) => lakeName.toLowerCase().includes(k));
  if (!key) return { error: `unknown lake: ${lakeName}` };
  const cfg = LAKES[key];
  const out = {
    waterbody: key,
    elevation_ft: null,
    water_temperature_F: null,
    sources: [],
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  };
  if (cfg.pool) {
    const u = await fetchUsgs(cfg.pool, "00010,00062,62614,62615,00065");
    if (u?.elevation != null) {
      out.elevation_ft = round2(u.elevation);
      out.sources.push(`USGS ${cfg.pool} (reservoir elevation)`);
    } else if (u?.gageHeight != null && !cfg.river) {
      out.elevation_ft = round2(u.gageHeight);
      out.sources.push(`USGS ${cfg.pool} (gage height \u2014 verify against published pool)`);
    }
    if (u?.tempC != null) {
      out.water_temperature_F = Math.round(u.tempC * 9 / 5 + 32);
      out.sources.push(`USGS ${cfg.pool} (temp)`);
    }
  }
  if (out.elevation_ft == null && cfg.duke) {
    const lake = await getDukeLake(cfg.duke);
    if (lake) {
      if (lake.ft != null) out.elevation_ft = lake.ft;
      if (lake.pct != null) out.percent_full = lake.pct;
      out.full_pool_ft = lake.fullPool;
      out.display_level = lake.pct;
      out.display_unit = "% full pond";
      out.display_full_pool = 100;
      if (isFinite(lake.target)) out.target = lake.target;
      out.sources.push("Duke API /lakes/current-level");
      if (lake.specialMessage) out.special_message = lake.specialMessage;
    }
  }
  if (out.elevation_ft == null && cfg.sepa) {
    if (cfg.sepa === "marion" || cfg.sepa === "moultrie") {
      const sc = await fetchSanteeCooper();
      if (sc?.[cfg.sepa] != null) {
        out.elevation_ft = sc[cfg.sepa];
        out.sources.push("Santee Cooper");
      }
    } else {
      const us = await fetchUsaceSavannah(cfg.sepa);
      if (us?.elevation != null) {
        out.elevation_ft = us.elevation;
        out.sources.push("USACE");
      }
    }
  }
  if (out.water_temperature_F == null && cfg.river) {
    const u = await fetchUsgs(cfg.river, "00010,00065,00060,63160");
    if (u?.tempC != null) {
      out.water_temperature_F = Math.round(u.tempC * 9 / 5 + 32);
      out.sources.push(`USGS ${cfg.river} (water temp)`);
    }
    if (u?.gageHeight != null) out.river_gage_height_ft = u.gageHeight;
    if (u?.streamflow != null) out.river_streamflow_cfs = u.streamflow;
    if (u?.elevationNavd88 != null) out.river_water_elevation_ft_navd88 = u.elevationNavd88;
    if (u?.timestamp) out.usgs_timestamp = u.timestamp;
  }
  if (out.water_temperature_F == null && cfg.ahq) {
    const a = await fetchAhqWaterTemp(cfg.ahq);
    if (a?.tempF != null) {
      out.water_temperature_F = a.tempF;
      out.water_temperature_source = `Angler's Headquarters report${a.approx ? " (estimated from range)" : ""}: "${a.raw}"`;
      if (a.range) out.water_temperature_range_F = a.range;
      out.sources.push(`Angler's Headquarters (${cfg.ahq})`);
    }
  }
  if (out.elevation_ft == null && cfg.normalPool) {
    out.elevation_ft = cfg.normalPool;
    out.sources.push("published normal pool (fallback)");
  }
  if (out.full_pool_ft == null && cfg.normalPool) out.full_pool_ft = cfg.normalPool;
  if (out.display_level == null && out.elevation_ft != null) {
    out.display_level = out.elevation_ft;
    out.display_unit = "ft";
    out.display_full_pool = cfg.normalPool || out.full_pool_ft || null;
  }
  out.status = out.elevation_ft != null ? "success" : "no_data";
  return out;
}
__name(resolveLake, "resolveLake");
function round2(n) {
  return Math.round(n * 100) / 100;
}
__name(round2, "round2");
var SYNC_STORES = ["plan", "spread", "catch", "chart", "layer"];
async function ensureSyncSchema(db) {
  try {
    await db.exec("CREATE TABLE IF NOT EXISTS sync_items (id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, lastModified TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (type, id))");
  } catch (e) {
    if (!String(e).includes("already exists") && !String(e).includes("SQLITE_ERROR")) throw e;
  }
  try {
    await db.exec("CREATE INDEX IF NOT EXISTS idx_sync_modified ON sync_items(lastModified)");
  } catch (e) {
    if (!String(e).includes("already exists") && !String(e).includes("SQLITE_ERROR")) throw e;
  }
}
__name(ensureSyncSchema, "ensureSyncSchema");
async function handleSyncPush(request, env, type, id) {
  if (!SYNC_STORES.includes(type)) {
    return new Response(JSON.stringify({ error: `unknown type: ${type}` }), { headers: JSON_HEADERS, status: 400 });
  }
  const body = await request.json();
  const { lastModified = (/* @__PURE__ */ new Date()).toISOString(), deleted = false, ...data } = body;
  await ensureSyncSchema(env.DB);
  await env.DB.prepare(
    `INSERT INTO sync_items (id, type, payload, lastModified, deleted)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(type, id) DO UPDATE SET
       payload=excluded.payload,
       lastModified=excluded.lastModified,
       deleted=excluded.deleted`
  ).bind(id, type, JSON.stringify(data), lastModified, deleted ? 1 : 0).run();
  return new Response(JSON.stringify({ ok: true, type, id, lastModified }), { headers: JSON_HEADERS });
}
__name(handleSyncPush, "handleSyncPush");
async function handleSyncListUpdates(url, env) {
  await ensureSyncSchema(env.DB);
  const since = url.searchParams.get("since");
  let rows;
  if (since) {
    rows = await env.DB.prepare(
      `SELECT type, id, lastModified, deleted FROM sync_items WHERE lastModified > ?1 ORDER BY lastModified ASC LIMIT 500`
    ).bind(since).all();
  } else {
    rows = await env.DB.prepare(
      `SELECT type, id, lastModified, deleted FROM sync_items ORDER BY lastModified ASC LIMIT 500`
    ).all();
  }
  const items = (rows.results || []).map((r) => ({
    key: `${r.type}/${r.id}`,
    lastModified: r.lastModified,
    deleted: r.deleted === 1
  }));
  return new Response(JSON.stringify({ items, count: items.length }), { headers: JSON_HEADERS });
}
__name(handleSyncListUpdates, "handleSyncListUpdates");
async function handleSyncGet(env, type, id) {
  await ensureSyncSchema(env.DB);
  const row = await env.DB.prepare(
    `SELECT payload, lastModified, deleted FROM sync_items WHERE type=?1 AND id=?2`
  ).bind(type, id).first();
  if (!row) return new Response(JSON.stringify({ error: "not found" }), { headers: JSON_HEADERS, status: 404 });
  const data = JSON.parse(row.payload);
  return new Response(JSON.stringify({
    ...data,
    lastModified: row.lastModified,
    deleted: row.deleted === 1
  }), { headers: JSON_HEADERS });
}
__name(handleSyncGet, "handleSyncGet");
async function handleSyncDelete(env, type, id) {
  await ensureSyncSchema(env.DB);
  await env.DB.prepare(
    `INSERT INTO sync_items (id, type, payload, lastModified, deleted)
     VALUES (?1, ?2, '{}', ?3, 1)
     ON CONFLICT(type, id) DO UPDATE SET deleted=1, lastModified=excluded.lastModified`
  ).bind(id, type, (/* @__PURE__ */ new Date()).toISOString()).run();
  return new Response(JSON.stringify({ ok: true, tombstoned: `${type}/${id}` }), { headers: JSON_HEADERS });
}
__name(handleSyncDelete, "handleSyncDelete");
async function handleSyncMigrate(request, env) {
  await ensureSyncSchema(env.DB);
  const body = await request.json();
  const items = body.items || [];
  let count = 0;
  const errors = [];
  for (const item of items) {
    try {
      const { type, id, lastModified = (/* @__PURE__ */ new Date()).toISOString(), ...data } = item;
      if (!SYNC_STORES.includes(type) || !id) continue;
      await env.DB.prepare(
        `INSERT INTO sync_items (id, type, payload, lastModified, deleted)
         VALUES (?1, ?2, ?3, ?4, 0)
         ON CONFLICT(type, id) DO UPDATE SET
           payload=excluded.payload,
           lastModified=excluded.lastModified,
           deleted=0`
      ).bind(String(id), type, JSON.stringify(data), lastModified).run();
      count++;
    } catch (e) {
      errors.push({ item, error: e.message });
    }
  }
  return new Response(JSON.stringify({ ok: true, imported: count, errors }), { headers: JSON_HEADERS });
}
__name(handleSyncMigrate, "handleSyncMigrate");
function contourGeojsonKey(lake) {
  return `${lake.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}/vectors/contours.geojson`;
}
__name(contourGeojsonKey, "contourGeojsonKey");
async function handleContourGeojsonGet(env, lake) {
  const key = contourGeojsonKey(lake);
  const obj = await env.R2_TROLLMAP_CHARTPACKS.get(key);
  if (!obj) return new Response(JSON.stringify({ error: "no vectorized contours for this lake yet" }), { headers: JSON_HEADERS, status: 404 });
  return new Response(obj.body, { headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
__name(handleContourGeojsonGet, "handleContourGeojsonGet");
async function handleContourGeojsonPut(request, env, lake) {
  const body = await request.arrayBuffer();
  if (!body || body.byteLength === 0) {
    return new Response(JSON.stringify({ error: "empty body" }), { headers: JSON_HEADERS, status: 400 });
  }
  const key = contourGeojsonKey(lake);
  await env.R2_TROLLMAP_CHARTPACKS.put(key, body, {
    httpMetadata: { contentType: "application/json", cacheControl: "no-store" }
  });
  return new Response(JSON.stringify({ ok: true, key, bytes: body.byteLength }), { headers: JSON_HEADERS });
}
__name(handleContourGeojsonPut, "handleContourGeojsonPut");
var SPECIES_MIDLANDS_SANTEE = [
  "Striped Bass",
  "Largemouth Bass",
  "White Bass / Hybrid",
  "Chain Pickerel",
  "Bowfin",
  "Bowfin (Mudfish)",
  "Black Crappie",
  "White Crappie",
  "Crappie",
  "Bluegill",
  "Redear Sunfish (Shellcracker)",
  "Redbreast Sunfish",
  "Sunfish (Panfish)",
  "Yellow Perch",
  "Blue Catfish",
  "Channel Catfish",
  "Flathead Catfish",
  "Catfish",
  "Longnose Gar",
  "Spotted Gar",
  "Gar",
  "American Shad",
  "Herring",
  "Common Carp",
  "Grass Carp",
  "Tilapia"
];
var SPECIES_UPSTATE = [
  "Spotted Bass",
  "Largemouth Bass",
  "Smallmouth Bass",
  "Striped Bass",
  "Rainbow / Brown Trout",
  "Trout",
  "Black Crappie",
  "White Crappie",
  "Crappie",
  "Channel Catfish",
  "Catfish",
  "Walleye",
  "Yellow Perch",
  "Bluegill",
  "Chain Pickerel"
];
var SPECIES_COASTAL_SALTWATER = [
  "Red Drum (Redfish)",
  "Speckled Trout (Spotted Seatrout)",
  "Flounder",
  "Black Drum",
  "Sheepshead",
  "Bluefish",
  "Spanish Mackerel",
  "Black Sea Bass",
  "Atlantic Croaker",
  "Whiting / Sea Mullet",
  "Cobia",
  "Striped Bass",
  "Ladyfish",
  "Jack Crevalle",
  // freshwater strays in tidal creeks
  "Largemouth Bass",
  "Bowfin",
  "Catfish",
  "Bluegill",
  "Sunfish (Panfish)",
  "Gar"
];
var SPECIES_ALL_TROLLMAP = [.../* @__PURE__ */ new Set([
  ...SPECIES_MIDLANDS_SANTEE,
  ...SPECIES_UPSTATE,
  ...SPECIES_COASTAL_SALTWATER,
  // catch-journal canonical aliases
  "Spotted Bass",
  "Smallmouth Bass",
  "Blue Catfish",
  "Channel Catfish",
  "Flathead Catfish",
  "Bowfin",
  "Chain Pickerel",
  "Bluegill",
  "Redear Sunfish (Shellcracker)",
  "Sunfish (Panfish)",
  "Warmouth",
  "Yellow Perch",
  "White Perch",
  "Longnose Gar",
  "Gar",
  "Red Drum (Redfish)",
  "Speckled Trout (Spotted Seatrout)",
  "Flounder",
  "American Shad",
  "White Bass / Hybrid",
  "Crappie",
  "Catfish",
  "Other Fish",
  "Not Fish"
])].sort();
function getSpeciesListForGps(lat, lon) {
  if (!isFinite(lat) || !isFinite(lon)) return SPECIES_MIDLANDS_SANTEE;
  if (lon > -80.2 && lat < 33.8) return SPECIES_COASTAL_SALTWATER;
  if (lat > 34.5 && lon < -82) return SPECIES_UPSTATE;
  return SPECIES_MIDLANDS_SANTEE;
}
__name(getSpeciesListForGps, "getSpeciesListForGps");
var MAX_BIOLOGICAL_LENGTH = {
  "Largemouth Bass": 26.5,
  "Spotted Bass": 24,
  "Smallmouth Bass": 24.5,
  "Black Crappie": 18.5,
  "White Crappie": 18.5,
  "Crappie": 18.5,
  "Bluegill": 14,
  "Redear Sunfish (Shellcracker)": 15,
  "Redbreast Sunfish": 12,
  "Sunfish (Panfish)": 14,
  "Yellow Perch": 16,
  "White Bass / Hybrid": 30,
  "Chain Pickerel": 28.5,
  "Bowfin": 36,
  "Bowfin (Mudfish)": 36,
  "Striped Bass": 52,
  "Flounder": 32,
  "Speckled Trout (Spotted Seatrout)": 34,
  "Red Drum (Redfish)": 55
};
function checkBiologicalLength(species, length) {
  if (!length || !species) return [true, ""];
  const maxLen = MAX_BIOLOGICAL_LENGTH[species] ?? MAX_BIOLOGICAL_LENGTH[species?.replace(" (Mudfish)", "")] ?? 60;
  if (length > maxLen) return [false, `\u26A0\uFE0F LENGTH ANOMALY: Reported length (${length} in) exceeds biological limit for ${species} (max ~${maxLen} in).`];
  if (length < 3) return [false, `\u26A0\uFE0F LENGTH ANOMALY: Reported length (${length} in) is implausibly small.`];
  return [true, ""];
}
__name(checkBiologicalLength, "checkBiologicalLength");
var PURE_SALTWATER = /* @__PURE__ */ new Set([
  "Red Drum (Redfish)",
  "Speckled Trout (Spotted Seatrout)",
  "Flounder",
  "Black Drum",
  "Sheepshead",
  "Bluefish",
  "Spanish Mackerel",
  "Black Sea Bass",
  "Atlantic Croaker",
  "Whiting / Sea Mullet",
  "Cobia",
  "Ladyfish",
  "Jack Crevalle"
]);
var PURE_FRESHWATER = /* @__PURE__ */ new Set([
  "Largemouth Bass",
  "Spotted Bass",
  "Smallmouth Bass",
  "Black Crappie",
  "White Crappie",
  "Crappie",
  "Chain Pickerel",
  "Bowfin",
  "Bowfin (Mudfish)",
  "Bluegill",
  "Redear Sunfish (Shellcracker)",
  "Redbreast Sunfish",
  "Sunfish (Panfish)",
  "Warmouth",
  "Walleye",
  "Rainbow / Brown Trout",
  "Trout",
  "Blue Catfish",
  "Channel Catfish",
  "Flathead Catfish",
  "Catfish",
  "Longnose Gar",
  "Spotted Gar",
  "Gar",
  "Yellow Perch",
  "White Perch",
  "Common Carp",
  "Grass Carp",
  "Tilapia"
]);
function checkEcologicalReality(lat, lon, species) {
  if (!isFinite(lat) || !isFinite(lon) || !species) return [true, ""];
  const s = String(species);
  if (["Not Fish", "No Fish", "Unknown", "Other Fish", "", "Other"].includes(s)) return [true, ""];
  if (34.3 <= lat && lat <= 34.42 && -80.22 <= lon && lon <= -80.08) {
    if (/Striped Bass|Striper|Hybrid/i.test(s)) {
      return [false, `\u26A0\uFE0F ECOLOGICAL ANOMALY: ${s} reported in Lake Robinson area (Darlington Co). Lake Robinson has NO established Striped Bass population.`];
    }
  }
  if (34.24 <= lat && lat <= 34.38 && -81.38 <= lon && lon <= -81.25) {
    if (/Striped Bass|Striper/i.test(s)) {
      return [false, `\u26A0\uFE0F ECOLOGICAL ANOMALY: ${s} reported in Monticello/Parr Reservoir area. No stocked striper population here.`];
    }
  }
  const is_murrells_inlet = 33.45 <= lat && lat <= 33.7 && lon >= -79.15;
  const is_charleston_coast = lat <= 32.9 && lon >= -79.95;
  const is_southern_coast = lat <= 32.45 && lon >= -80.75;
  if (is_murrells_inlet || is_charleston_coast || is_southern_coast) {
    if (PURE_FRESHWATER.has(s) || /Bass|Crappie|Pickerel|Bowfin|Catfish|Bluegill|Sunfish|Perch|Gar/i.test(s) && !/Striped Bass|White Bass|Sea Bass/i.test(s)) {
      const pureCheck = [...PURE_FRESHWATER].some((pf) => s === pf);
      if (pureCheck) {
        const place = is_murrells_inlet ? "Murrells Inlet / Grand Strand Estuary" : "High-Salinity Coastal Marine Estuary";
        return [false, `\u26A0\uFE0F ECOLOGICAL ANOMALY: Pure freshwater species (${s}) reported in ${place}.`];
      }
    }
  }
  if (lon <= -80.35 && lat >= 33.2) {
    if (PURE_SALTWATER.has(s)) {
      return [false, `\u26A0\uFE0F ECOLOGICAL ANOMALY: Pure saltwater marine species (${s}) reported in inland freshwater reservoir.`];
    }
  }
  if (/Smallmouth Bass/i.test(s)) {
    const in_monticello_parr = 34.15 <= lat && lat <= 34.45 && -81.45 <= lon && lon <= -81.15;
    const in_upstate_mountains = lat >= 34.5 && lon <= -82;
    if (!(in_monticello_parr || in_upstate_mountains)) {
      return [false, `\u26A0\uFE0F ECOLOGICAL ANOMALY: Smallmouth Bass reported outside valid habitat (only possible in Monticello/Parr Reservoir or cold Upstate mountain waters).`];
    }
  }
  if (/Trout|Walleye/i.test(s)) {
    if (lat < 34.5 || lon > -82) {
      return [false, `\u26A0\uFE0F ECOLOGICAL ANOMALY: Coldwater species (${s}) reported outside cold mountain waters.`];
    }
  }
  return [true, ""];
}
__name(checkEcologicalReality, "checkEcologicalReality");
function buildStage1Prompt(species_list, assume_board = false, lat = null, lon = null) {
  const species_str = species_list.map((s) => `"${s}"`).join(", ");
  const gps_tag = isFinite(lat) && isFinite(lon) ? `Photo GPS location: lat=${lat.toFixed(4)}, lon=${lon.toFixed(4)} \u2014 ${lon > -80.2 && lat < 33.8 ? "COASTAL SALTWATER" : "INLAND FRESHWATER"}` : `Photo GPS location: GPS unknown`;
  const board_task = assume_board ? `TASK 1 \u2014 BUMP BOARD: This photo is confirmed to contain a fish on a bump board. on_bump_board = true.` : `TASK 1 \u2014 BUMP BOARD DETECTION
A bump board is ANY rigid measuring device with a perpendicular nose stop and inch markings.
Common boards: Ketch Board (yellow), Hawg Trough, Golden Rule, homemade wood board.
IMPORTANT: Do NOT reject bump board because:
  - board is dirty, wet, or has stickers on it
  - numbers are faded or partially visible
  - board edge is cropped out of frame
  - fish tail hangs slightly off the end
If ANY measuring device with markings is present under the fish \u2192 on_bump_board = true`;
  return `You are a precise fisheries technician for a South Carolina kayak angler.
Return ONLY valid JSON. Temperature = 0. No guessing. No placeholders.
${gps_tag}
IMPORTANT: Use the GPS location to rule out impossible species. Inland freshwater GPS = no saltwater fish possible.

${board_task}

TASK 2 \u2014 SPECIES IDENTIFICATION
This angler fishes South Carolina freshwater lakes AND coastal saltwater. Species priority rules:

STRIPED BASS (highest priority freshwater):
  - 7-8 UNBROKEN horizontal black stripes running full body length
  - Forked tail, two separate dorsal fins
  - JUVENILE RULE: Never classify as White Bass/Hybrid because fish is small (<20 inches)
  - If continuous horizontal stripes are visible \u2192 classify as Striped Bass regardless of size

BOWFIN:
  - Single LONG dorsal fin running most of body length (not two separate fins)
  - Rounded tail (not forked)
  - Dark eyespot near base of tail \u2014 WARNING: this eyespot looks like a redfish spot but bowfin are FRESHWATER
  - Olive/brown/dark color, no stripes
  - CRITICAL: Bowfin have ONE continuous dorsal fin. Red Drum have TWO separate dorsal fins.
  - If GPS coordinates are inland/freshwater and fish has eyespot \u2192 Bowfin, NOT Red Drum

CHAIN PICKEREL:
  - Long duck-bill snout, very toothy
  - Chain-link or reticulated pattern on sides (not stripes)
  - Elongated body

CATFISH:
  - Visible whiskers/barbels around mouth
  - Smooth skin, no scales
  - No horizontal stripes
  - Blue Catfish: slate blue, straight anal fin
  - Channel Catfish: olive with dark spots, rounded anal fin
  - Flathead Catfish: flat broad head, lower jaw protruding, mottled yellow/brown

BASS (Largemouth / Spotted / Smallmouth):
  - Largemouth: jaw PAST eye, dorsal deeply notched, dark lateral blotchy band, no tongue tooth patch
  - Spotted Bass: jaw to MID-eye, rough tooth patch on tongue, dorsal fins connected, rows small spots below lateral line
  - Smallmouth: bronze, vertical bars, jaw BEFORE eye \u2013 ONLY Upstate / Jocassee / Broad River \u2013 DO NOT default Smallmouth in Wateree/Murray/Marion

CRAPPIE:
  - Deep compressed panfish
  - Black Crappie: 7-8 dorsal spines, irregular speckling
  - White Crappie: 5-6 dorsal spines, vertical barring
  - If spines not countable \u2192 "Crappie"

SUNFISH / PANFISH:
  - Bluegill: blue-purple gill flap, vertical barring, orange breast
  - Redear Sunfish (Shellcracker): red/orange margin on opercular flap
  - If uncertain beyond family \u2192 "Sunfish (Panfish)"

SALTWATER SPECIES (if coastal GPS or saltwater environment visible):
  - Red Drum (Redfish): copper/bronze body, ONE OR MORE black spots near tail base, TWO separate dorsal fins, no stripes, chin NO barbels
  - Speckled Trout: silver with scattered black spots on body AND fins, canine teeth
  - Flounder: FLAT fish, both eyes on same side, lies flat, mottled brown

GAR:
  - Long needle snout, ganoid diamond scales, long cylindrical body
  - Longnose Gar: snout >2\xD7 head length

Species choices (pick closest match): [${species_str}, "Other Fish"]

TASK 3 \u2014 LENGTH MEASUREMENT
ONLY if fish is on bump board:
  Step 1: Find nose touching bump stop (this is the 0 mark)
  Step 2: Find the FURTHEST tail tip \u2014 not the body end, the actual fin tip
  Step 3: Read ruler mark where tail tip ends
  Step 4: Round to nearest 0.25 inch \u2014 tail pinched \u2013 if ruler mark is not clearly readable \u2192 length_inches = null
  Step 5: If ruler mark is not clearly readable \u2192 length_inches = null
  CRITICAL \u2014 IGNORE ALL OF THESE when reading length:
    - Numbers on fish finders, GPS units, depth sounders, or any electronics in the photo
    - Stickers or labels on the board
    - The far end of the board
    - Your estimate of how big the fish looks
  READ ONLY the ruler mark on the bump board where the tail tip ends

Return ONLY this JSON:
{"has_fish": <true/false>, "on_bump_board": <true/false>, "species": "<exact species from list>", "length_inches": <number or null>, "confidence": "high|medium|low", "notes": "<what you see: tail tip position, visible ruler marks, species field marks>"}`;
}
__name(buildStage1Prompt, "buildStage1Prompt");
var CATCH_JSON_SCHEMA = {
  type: "OBJECT",
  properties: {
    has_fish: { type: "BOOLEAN" },
    on_bump_board: { type: "BOOLEAN" },
    species: { type: "STRING" },
    length_inches: { type: ["NUMBER", "NULL"] },
    confidence: { type: "STRING", enum: ["high", "medium", "low"] },
    notes: { type: "STRING" }
  },
  required: ["has_fish", "on_bump_board", "species", "confidence"]
};
async function handleIdentifyCatch(request, env) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");
  const latHeader = parseFloat(request.headers.get("X-Lat"));
  const lonHeader = parseFloat(request.headers.get("X-Lon"));
  const lake = request.headers.get("X-Lake") || "";
  const date = request.headers.get("X-Date") || "";
  const speciesHintHeader = (request.headers.get("X-Species-Hint") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const mimeType = request.headers.get("X-Image-Type") || request.headers.get("Content-Type") || "image/jpeg";
  const imageBuffer = await request.arrayBuffer();
  const bytes = new Uint8Array(imageBuffer);
  let binary = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  const base64String = btoa(binary);
  let species_list = speciesHintHeader.length ? speciesHintHeader : getSpeciesListForGps(latHeader, lonHeader);
  const extra = ["Striped Bass", "Largemouth Bass", "Spotted Bass", "Smallmouth Bass", "Crappie", "Blue Catfish", "Channel Catfish", "Flathead Catfish", "Catfish", "Bowfin", "Bowfin (Mudfish)", "Chain Pickerel", "Bluegill", "Redear Sunfish (Shellcracker)", "Sunfish (Panfish)", "Yellow Perch", "White Bass / Hybrid", "Longnose Gar", "Gar", "Red Drum (Redfish)", "Speckled Trout (Spotted Seatrout)", "Flounder", "American Shad", "Other Fish", "Not Fish"];
  species_list = [.../* @__PURE__ */ new Set([...species_list, ...extra])];
  const assume_board = (request.headers.get("X-Assume-Board") || "").toLowerCase() === "true";
  const prompt = buildStage1Prompt(species_list, assume_board, isFinite(latHeader) ? latHeader : null, isFinite(lonHeader) ? lonHeader : null);
  const payload = {
    systemInstruction: { parts: [{ text: "You are a precise fisheries technician. Return ONLY valid JSON. Temperature = 0." }] },
    contents: [{ parts: [
      { text: prompt },
      { inlineData: { mime_type: mimeType, data: base64String } }
    ] }],
    generationConfig: {
      temperature: 0,
      response_mime_type: "application/json",
      response_schema: CATCH_JSON_SCHEMA
    }
  };
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const geminiResp = await fetch(geminiUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (!geminiResp.ok) {
    const errText = await geminiResp.text();
    throw new Error(`Gemini API ${geminiResp.status}: ${errText.slice(0, 300)}`);
  }
  const geminiData = await geminiResp.json();
  const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error("Empty response from Gemini");
  let analysis;
  try {
    analysis = JSON.parse(rawText);
  } catch (e) {
    const m = rawText.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("Gemini returned non-JSON: " + rawText.slice(0, 200));
    analysis = JSON.parse(m[0]);
  }
  const SPECIES_MAP = {
    "Bowfin (Mudfish)": "Bowfin",
    "Mudfish": "Bowfin",
    "Black Crappie": "Crappie",
    "White Crappie": "Crappie",
    "Red Drum": "Red Drum (Redfish)",
    "Redfish": "Red Drum (Redfish)",
    "Spotted Seatrout": "Speckled Trout (Spotted Seatrout)",
    "Speckled Trout": "Speckled Trout (Spotted Seatrout)",
    "Redear Sunfish": "Redear Sunfish (Shellcracker)",
    "Shellcracker": "Redear Sunfish (Shellcracker)",
    "Bluegill": "Bluegill",
    "Panfish": "Sunfish (Panfish)",
    "Bream": "Sunfish (Panfish)",
    "White Bass": "White Bass / Hybrid",
    "Hybrid Bass": "White Bass / Hybrid",
    "Hybrid": "White Bass / Hybrid",
    "Wiper": "White Bass / Hybrid",
    "Striper": "Striped Bass",
    "Striped bass": "Striped Bass",
    "Largemouth bass": "Largemouth Bass",
    "Spotted bass": "Spotted Bass",
    "Smallmouth bass": "Smallmouth Bass",
    "Blue catfish": "Blue Catfish",
    "Channel catfish": "Channel Catfish",
    "Flathead catfish": "Flathead Catfish",
    "No Fish": "Not Fish",
    "None": "Not Fish",
    "Shad": "American Shad"
  };
  let species = analysis.species || "Other Fish";
  species = SPECIES_MAP[species] || species;
  const has_fish = analysis.has_fish ?? true;
  const on_bump_board = analysis.on_bump_board ?? false;
  let length_inches = analysis.length_inches;
  if (length_inches != null) {
    length_inches = Math.round(Number(length_inches) * 4) / 4;
  }
  let confidence = analysis.confidence || "medium";
  let notes = analysis.notes || "";
  if (isFinite(latHeader) && isFinite(lonHeader) && has_fish) {
    const [eco_ok, eco_warn] = checkEcologicalReality(latHeader, lonHeader, species);
    if (!eco_ok) {
      notes = `${eco_warn} | ${notes}`.replace(/^\s*\|\s*|\s*\|\s*$/g, "");
      confidence = "low";
      if (/Bowfin.*Red Drum|Red Drum.*Bowfin|eyespot/i.test(eco_warn)) {
        if (lonHeader <= -80.35) species = "Bowfin";
      }
    }
  }
  if (length_inches != null && has_fish) {
    const [len_ok, len_warn] = checkBiologicalLength(species, Number(length_inches));
    if (!len_ok) {
      notes = `${len_warn} | ${notes}`.replace(/^\s*\|\s*|\s*\|\s*$/g, "");
      confidence = "low";
    }
  }
  const out = {
    // fish_sorter_v4 canonical (python-compatible)
    has_fish,
    on_bump_board,
    species,
    length_inches: length_inches ?? null,
    confidence,
    notes,
    // catch-journal.js camelCase compat
    lengthInches: length_inches ?? null,
    species_confidence: confidence === "high" ? 0.9 : confidence === "medium" ? 0.65 : 0.4,
    // extended v2 fields
    length_source: on_bump_board ? length_inches != null ? "board_ruler" : "board_no_read" : "body_estimate",
    board_detected: !!on_bump_board,
    board_type: on_bump_board ? "generic" : "none",
    measurement_confidence: confidence,
    data_quality: {
      species: confidence === "high" ? "ai_verified" : "ai",
      length: on_bump_board && length_inches != null ? "board_verified" : length_inches != null ? "estimated" : "missing",
      lure: "missing",
      speed: "missing",
      depth: "missing",
      gps: isFinite(latHeader) && isFinite(lonHeader) ? "exif" : "missing"
    },
    trollmap_tags: [],
    source_model: "gemini-2.5-flash fish_sorter_v4"
  };
  if (/Bowfin/i.test(species)) out.trollmap_tags.push("reaction_feeder", "vegetation_trolling_target");
  if (/Striped Bass/i.test(species)) out.trollmap_tags.push("trolling_primary", "thermocline");
  if (/Red Drum|Redfish/i.test(species)) out.trollmap_tags.push("inshore", "tide_dependent");
  if (on_bump_board) out.trollmap_tags.push("board_measured");
  return out;
}
__name(handleIdentifyCatch, "handleIdentifyCatch");
async function handleIdentifyCatchV2(request, env) {
  let ctx = {};
  let mime_type = "image/jpeg";
  let image_base64 = null;
  try {
    const body = await request.json();
    image_base64 = body.image_base64;
    mime_type = body.mime_type || mime_type;
    ctx = body.context || {};
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: "invalid JSON body \u2013 expected {image_base64, context{}}" }), { status: 400, headers: JSON_HEADERS });
  }
  if (!image_base64) {
    return new Response(JSON.stringify({ success: false, error: "missing image_base64" }), { status: 400, headers: JSON_HEADERS });
  }
  const fakeReq = {
    headers: { get: /* @__PURE__ */ __name((k) => {
      const map = {
        "X-Image-Type": mime_type,
        "Content-Type": mime_type,
        "X-Lake": ctx.lake || "",
        "X-Date": ctx.date || "",
        "X-Lat": ctx.lat != null ? String(ctx.lat) : "",
        "X-Lon": ctx.lon != null ? String(ctx.lon) : "",
        "X-Species-Hint": (ctx.species_hint || []).join(","),
        "X-Assume-Board": ctx.assume_board ? "true" : ""
      };
      return map[k] || null;
    }, "get") },
    arrayBuffer: /* @__PURE__ */ __name(async () => {
      const bin = atob(image_base64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return arr.buffer;
    }, "arrayBuffer")
  };
  const analysis = await handleIdentifyCatch(fakeReq, env);
  return new Response(JSON.stringify({
    success: true,
    analysis,
    context_used: ctx,
    taxonomy_version: "fish_sorter_v4 / TrollMap v13",
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  }), { headers: JSON_HEADERS });
}
__name(handleIdentifyCatchV2, "handleIdentifyCatchV2");
var COACH_SYSTEM_PROMPT = `You are an expert kayak fishing guide and tactical advisor for TrollMap.

Your job is to review a trolling plan and find EXACTLY ONE improvement \u2014 the single change most likely to increase catch rate given the conditions, fish behavior, and angler equipment.

ANGLER CONSTRAINTS (never violate these):
- Spinning rods only \u2014 no conventional reels, no downriggers
- No freshwater live bait
- Maximum 2 rods in the water at once (port + starboard)
- Equipment list is fixed \u2014 only suggest lures the angler owns
- Kayak platform: Native Watersports Slayer Propel Max 12.5 + NK180 24V stern-mount electric outboard motor
  Faster speeds drain battery faster; speed suggestions must be realistic for a full-day kayak session
- Depth control: lead length only (no downriggers, no planer boards)
- If the plan includes a planMeta.speedRationale, the speed was deliberately chosen by the primary AI guide. Do NOT suggest changing speed unless you have a specific safety concern or strong catch-rate evidence that directly contradicts the rationale.

LURE-SPECIFIC HARD CONSTRAINTS (non-negotiable):
- Flutter Spoon: angler owns exactly ONE system \u2014 3/4oz Nichols 4" Shattered Glass Silver + 2oz torpedo
  inline weight (2.75oz total). Color is ALWAYS Shattered Glass Silver \u2014 no other color exists.
  This is a TROLLING presentation at 1.6-2.4mph, NOT a vertical jigging lure.
  Only ONE rod can run the flutter spoon at any time.
- A-Rig (umbrella rig): comes in Light/Medium/Heavy sizes. Port and Starboard CAN both run
  A-rigs simultaneously at different sizes/leads to cover different depth zones.
- Port and Starboard rods are COMPLEMENTARY \u2014 they should cover different depth zones or
  presentations simultaneously, not the same lure on both rods.

ROD PAIRING LOGIC:
- A valid spread has two DIFFERENT presentations covering different water column zones
- Flutter Spoon + A-Rig is a valid pairing (different action profiles, different depths)
- A-Rig Light + A-Rig Medium is a valid pairing (same family, different depths)
- Flutter Spoon + Flutter Spoon is INVALID \u2014 only one spoon system exists
- Do NOT swap lures between port and starboard if it creates an invalid pairing
- Do NOT suggest flutter_spoon_color changes \u2014 color is always Shattered Glass Silver

YOU MAY ONLY SUGGEST CHANGES TO THESE FIELDS:
lure, lure_size, lead_length, trolling_speed, target_depth,
phase_timing, rod_assignment, inline_weight, route_pattern, casting_stop_suggestion

YOU MUST NEVER SUGGEST CHANGES TO:
lure_color for flutter spoon, species, lake, launch_ramp, weather, safety_limits,
battery_limits, gear_not_owned, live_bait, conventional_reels

RESPONSE FORMAT \u2014 return ONLY this JSON object, no other text:
{
  "has_suggestion": true,
  "suggestion": {
    "field": "the field being changed",
    "phase": 1,
    "rod": "Port",
    "current_value": "what it is now",
    "recommended_value": "what to change it to",
    "confidence": 0.87,
    "reasons": ["reason 1", "reason 2", "reason 3"],
    "warnings": ["any cautions"],
    "evidence_sources": ["catch_history", "water_temp", "clarity", "solunar", "structure", "community_spots", "general_knowledge"]
  },
  "no_suggestion_reason": "only populate if has_suggestion is false"
}

If you cannot find a meaningful improvement, set has_suggestion to false.
Never invent lures the angler does not own. Never suggest live bait.`;
async function handleCoachPlan(request, env) {
  try {
    const body = await request.json();
    const { payload, previousSuggestions = [] } = body;
    if (!payload) {
      return new Response(JSON.stringify({ success: false, error: "Missing payload" }), { status: 400, headers: JSON_HEADERS });
    }
    let userMessage = `Review this trolling plan and find ONE improvement.

PLAN:
${JSON.stringify(payload, null, 2)}`;
    if (previousSuggestions.length > 0) {
      const accepted = previousSuggestions.filter((s) => s.status === "accepted" || !s.status);
      const skipped = previousSuggestions.filter((s) => s.status === "skipped");
      if (accepted.length > 0) {
        userMessage += `

ACCEPTED CHANGES \u2014 these are now LIVE in the plan, do not reverse or re-suggest:
`;
        accepted.forEach((s, i) => {
          userMessage += `${i + 1}. [ACCEPTED] ${s.field}${s.phase ? ` Phase ${s.phase}` : ""}${s.rod ? ` ${s.rod}` : ""}: "${s.current_value}" \u2192 "${s.recommended_value}"
`;
        });
      }
      if (skipped.length > 0) {
        userMessage += `
SKIPPED SUGGESTIONS \u2014 angler passed on these, do not re-suggest:
`;
        skipped.forEach((s, i) => {
          userMessage += `${i + 1}. [SKIPPED] ${s.field}${s.phase ? ` Phase ${s.phase}` : ""}${s.rod ? ` ${s.rod}` : ""}: "${s.current_value}" \u2192 "${s.recommended_value}"
`;
        });
      }
      userMessage += `
CURRENT SPREAD STATE (after accepted changes):
- Check accepted changes above to understand what each rod is currently running
- Do not suggest a change that would undo an accepted change or create an invalid rod pairing
`;
    }
    userMessage += `

Return ONLY the JSON object. Find the single highest-confidence improvement, or set has_suggestion to false if the plan is already well-optimized.`;
    const llmPayload = {
      model: "openai/gpt-oss-120b",
      messages: [
        { role: "system", content: COACH_SYSTEM_PROMPT },
        { role: "user", content: userMessage }
      ],
      temperature: 0.15,
      max_tokens: 800,
      response_format: { type: "json_object" }
    };
    const { data } = await callLLM(env, llmPayload);
    let suggestion = {};
    try {
      suggestion = JSON.parse(data.choices?.[0]?.message?.content || "{}");
    } catch (_) {
      suggestion = { has_suggestion: false, no_suggestion_reason: "Parse error" };
    }
    return new Response(JSON.stringify({ success: true, ...suggestion }), { headers: JSON_HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers: JSON_HEADERS });
  }
}
__name(handleCoachPlan, "handleCoachPlan");
// ─── LAKE RESEARCH MODULE ─────────────────────────────────────────────────
// Implements spec v1.0: Lake Research permanent intelligence profiles

// ─── EXTENDED EVIDENCE ACQUISITION PIPELINE FUNCTIONS ───

async function handleResearchLimnologyData(request, env) {
  const body = await request.json().catch(() => ({}));
  const { lakeName, bboxNorth, bboxSouth, bboxEast, bboxWest } = body;
  if (!lakeName) return new Response(JSON.stringify({ ok: false, error: 'missing lakeName' }), { status: 400, headers: JSON_HEADERS });
  if (bboxNorth == null || bboxSouth == null || bboxEast == null || bboxWest == null) {
    return new Response(JSON.stringify({ ok: false, error: 'missing bbox — provide bboxNorth/South/East/West from lake GeoJSON' }), { status: 400, headers: JSON_HEADERS });
  }

  const chars = ['Temperature, water', 'Dissolved oxygen (DO)', 'Dissolved oxygen'];
  // WQP query requires: characteristicType=Physical, providers NWIS+WQX,
  // dataProfile=resultPhysChem, and a date range
  const wqpUrl = `https://www.waterqualitydata.us/data/Result/search?` +
    `bBox=${bboxWest},${bboxSouth},${bboxEast},${bboxNorth}` +
    `&siteType=Lake%2C+Reservoir%2C+Impoundment` +
    `&characteristicType=Physical` +
    `&characteristicName=${chars.map(c => encodeURIComponent(c)).join('&characteristicName=')}` +
    `&providers=NWIS&providers=WQX` +
    `&dataProfile=resultPhysChem` +
    `&mimeType=csv&sorted=no` +
    `&startDateLo=01-01-2015&startDateHi=12-31-2026`;

  let csvText;
  try {
    const wqpRes = await fetch(wqpUrl, {
      headers: { 'User-Agent': 'TrollMap/1.0 (fishing intelligence platform; contact: trollmap@colonal1981.workers.dev)' }
    });
    if (!wqpRes.ok) throw new Error(`WQP HTTP ${wqpRes.status}`);
    csvText = await wqpRes.text();
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: `WQP fetch failed: ${e.message}`, thermocline: null }), { headers: JSON_HEADERS });
  }

  function parseCSVLine(line) {
    const result = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (ch === ',' && !inQ) {
        result.push(cur.trim()); cur = '';
      } else {
        cur += ch;
      }
    }
    result.push(cur.trim());
    return result;
  }

  const lines = csvText.split('\n').filter(Boolean);
  if (lines.length < 2) {
    return new Response(JSON.stringify({ ok: true, recordCount: 0, thermocline: null, oxygen: null, surfaceWater: null, note: 'No WQP monitoring data found for this lake boundary' }), { headers: JSON_HEADERS });
  }

  const headers = parseCSVLine(lines[0]);
  const col = (name) => headers.findIndex(h => h.toLowerCase().includes(name.toLowerCase()));
  const iChar = col('characteristicname');
  const iValue = col('resultmeasurevalue');
  const iUnit = col('resultmeasure/measureunitcode');
  const iDepth = col('activitydepthheightmeasure/measurevalue');
  const iDepthU = col('activitydepthheightmeasure/measureunitcode');
  const iDate = col('activitystartdate');
  const iProject = col('projectname');
  const iLoc = col('monitoringlocationname');

  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const char = cols[iChar] || '';
    const valRaw = cols[iValue] || '';
    const unit = cols[iUnit] || '';
    const depRaw = cols[iDepth] || '';
    const depUnit = cols[iDepthU] || '';
    const date = cols[iDate] || '';
    const project = cols[iProject] || '';
    const location = cols[iLoc] || '';
    const val = parseFloat(valRaw);
    if (isNaN(val)) continue;
    let dep = parseFloat(depRaw);
    let depthFt = null;
    if (!isNaN(dep) && dep >= 0) {
      depthFt = dep;
      if (depUnit.toLowerCase().includes('m') && !depUnit.toLowerCase().includes('ft')) depthFt = dep * 3.28084;
      depthFt = Math.round(depthFt * 10) / 10;
    }
    const lowerChar = char.toLowerCase();
    let type = null;
    if (/temperature/.test(lowerChar)) type = 'temperature';
    else if (/dissolved oxygen|oxygen/.test(lowerChar)) type = 'do';
    else if (/turbidity/.test(lowerChar)) type = 'turbidity';
    else if (/conductivity/.test(lowerChar)) type = 'conductivity';
    else if (/alkalinity/.test(lowerChar)) type = 'alkalinity';
    else if (/hardness/.test(lowerChar)) type = 'hardness';
    if (!type) continue;
    let value = val;
    let outUnit = unit;
    if (type === 'temperature' && (unit.toLowerCase().includes('deg c') || unit === 'deg C' || unit === 'C')) {
      value = val * 9 / 5 + 32;
      outUnit = 'deg F';
    }
    const month = date ? parseInt(date.split('-')[1], 10) : null;
    records.push({ type, value: Math.round(value * 100) / 100, unit: outUnit, depthFt, month, date, project, location });
  }

  if (records.length === 0) {
    return new Response(JSON.stringify({ ok: true, recordCount: 0, thermocline: null, oxygen: null, surfaceWater: null, note: 'WQP returned data but no usable records found' }), { headers: JSON_HEADERS });
  }

  const depthRecords = records.filter(r => r.depthFt != null);
  const summerDepthRecs = depthRecords.filter(r => r.month >= 6 && r.month <= 9);
  const summerDO = summerDepthRecs.filter(r => r.type === 'do');
  const summerTemp = summerDepthRecs.filter(r => r.type === 'temperature');
  const allDO = depthRecords.filter(r => r.type === 'do');

  let thermocline = null;
  if (summerDO.length >= 3) {
    const doBins = {};
    for (const r of summerDO) {
      const bin = Math.floor(r.depthFt / 2) * 2;
      if (!doBins[bin]) doBins[bin] = [];
      doBins[bin].push(r.value);
    }
    const sortedBins = Object.keys(doBins).map(Number).sort((a, b) => a - b);
    for (const bin of sortedBins) {
      const vals = doBins[bin].slice().sort((a, b) => a - b);
      const median = vals[Math.floor(vals.length / 2)];
      if (median < 4) {
        thermocline = { depthFt: bin, confidence: summerDO.length >= 10 ? 88 : summerDO.length >= 5 ? 75 : 60, method: 'derived_from_do_profile', evidenceCount: summerDO.length };
        break;
      }
    }
  }
  if (!thermocline && summerTemp.length >= 3) {
    const tempBins = {};
    for (const r of summerTemp) {
      const bin = Math.floor(r.depthFt / 2) * 2;
      if (!tempBins[bin]) tempBins[bin] = [];
      tempBins[bin].push(r.value);
    }
    const sortedBins = Object.keys(tempBins).map(Number).sort((a, b) => a - b);
    let maxGradient = 0, maxBin = null;
    for (let i = 1; i < sortedBins.length; i++) {
      const shallowVals = tempBins[sortedBins[i - 1]].slice().sort((a, b) => a - b);
      const deepVals = tempBins[sortedBins[i]].slice().sort((a, b) => a - b);
      const shallowMed = shallowVals[Math.floor(shallowVals.length / 2)];
      const deepMed = deepVals[Math.floor(deepVals.length / 2)];
      const gradient = shallowMed - deepMed;
      if (gradient > maxGradient) { maxGradient = gradient; maxBin = sortedBins[i - 1]; }
    }
    if (maxBin != null && maxGradient >= 3) {
      thermocline = { depthFt: maxBin, confidence: summerTemp.length >= 10 ? 80 : summerTemp.length >= 5 ? 65 : 50, method: 'derived_from_temp_gradient', evidenceCount: summerTemp.length };
    }
  }

  let oxygen = null;
  if (allDO.length >= 3) {
    const bins = {};
    for (const r of allDO) {
      const bin = Math.floor(r.depthFt / 2) * 2;
      if (!bins[bin]) bins[bin] = [];
      bins[bin].push(r.value);
    }
    const sortedBins = Object.keys(bins).map(Number).sort((a, b) => a - b);
    let anoxicBelowFt = null;
    for (const bin of sortedBins) {
      const vals = bins[bin].slice().sort((a, b) => a - b);
      const median = vals[Math.floor(vals.length / 2)];
      if (median < 2) { anoxicBelowFt = bin; break; }
    }
    oxygen = { anoxicBelowFt, note: anoxicBelowFt != null ? `Median dissolved oxygen drops below 2 mg/L near ${anoxicBelowFt} ft in available depth-profile samples.` : null };
  }

  const latestDateByType = {};
  for (const r of records) {
    if (!latestDateByType[r.type] || r.date > latestDateByType[r.type]) latestDateByType[r.type] = r.date;
  }
  const summarizeType = (type) => {
    const latestDate = latestDateByType[type];
    if (!latestDate) return null;
    const vals = records.filter(r => r.type === type && r.date === latestDate).map(r => r.value).filter(v => isFinite(v));
    if (!vals.length) return null;
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const programs = [...new Set(records.filter(r => r.type === type && r.date === latestDate).map(r => r.project).filter(Boolean))];
    return { value: Math.round(avg * 100) / 100, lastObserved: latestDate, sampleCount: vals.length, programs };
  };

  const surfaceWater = {
    recentTempF: summarizeType('temperature')?.value ?? null,
    recentDissolvedOxygenMgL: summarizeType('do')?.value ?? null,
    recentTurbidityNTU: summarizeType('turbidity')?.value ?? null,
    recentConductivity: summarizeType('conductivity')?.value ?? null,
    recentAlkalinityMgL: summarizeType('alkalinity')?.value ?? null,
    recentHardnessMgL: summarizeType('hardness')?.value ?? null,
    lastObserved: [summarizeType('temperature')?.lastObserved, summarizeType('do')?.lastObserved, summarizeType('turbidity')?.lastObserved].filter(Boolean).sort().slice(-1)[0] || null,
    programs: [...new Set(records.map(r => r.project).filter(Boolean))],
    note: 'Summary reflects the most recent available surface/grab samples by characteristic from WQP/SCDES monitoring sites within the lake boundary.'
  };

  const out = {
    ok: true,
    lakeName,
    recordCount: records.length,
    depthProfileCount: depthRecords.length,
    summerRecords: summerDepthRecs.length,
    lastObserved: records.map(r => r.date).filter(Boolean).sort().slice(-1)[0] || null,
    thermocline,
    oxygen,
    surfaceWater,
    note: thermocline ? null : depthRecords.length ? 'Depth-profile records exist but were insufficient to derive a defensible thermocline.' : 'Monitoring data were found, but available records are surface/grab samples rather than depth profiles.'
  };
  return new Response(JSON.stringify(out), { headers: JSON_HEADERS });
}
__name(handleResearchLimnologyData, 'handleResearchLimnologyData');

async function handleResearchDiscover(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || "").trim();
  const state = String(body.state || "SC").trim().toUpperCase();

  if (!lakeName) {
    return new Response(JSON.stringify({ success: false, error: "Missing lakeName" }), { status: 400, headers: JSON_HEADERS });
  }

  // Derive base name for relevance filtering (e.g. "Lake Wateree, SC" -> "wateree")
  const baseName = String(lakeName).replace(/^Lake\s+/i,'').replace(/,\s*(SC|NC|GA)\s*$/i,'').replace(/\s+Reservoir$/i,'').replace(/\s+Lake$/i,'').trim();
  const baseLower = baseName.toLowerCase();
  const otherLakeNames = ['murray','marion','moultrie','hartwell','keowee','jocassee','thurmond','clarks hill','clark hill','russell','wylie','norman','hickory','james','rhodhiss','mountain island','wateree','robinson','monticello','greenwood','secession','yates','martin'];
  const offLakePattern = (title, url) => {
    const combined = `${title} ${url}`.toLowerCase();
    // Filter irrelevant document types regardless of lake
    if (/wetlands.management|wma.wetlands|wildlife.management.area|hunting.*pdf|upland.*habitat|prescribed.burn|waterfowl.impound/i.test(combined)) return 'irrelevant_doc_type';
    if (/nrc\.gov\/docs\//i.test(combined)) return 'nrc_nuclear_doc';
    for (const other of otherLakeNames) {
      if (other === baseLower) continue;
      if (combined.includes(`lake ${other}`) && !combined.includes(baseLower)) {
        const isLakeSpecificReg = /regulations|regs\.html|description\.html/.test(combined) && /lake (murray|marion|moultrie|hartwell|keowee|jocassee|greenwood|secession|yates|martin)/.test(combined);
        if (isLakeSpecificReg) return other;
      }
      if (/regs\.html|description\.html/.test(combined) && combined.includes(`/${other}/`) && !combined.includes(baseLower)) return other;
    }
    return null;
  };

  // Resolve state-specific agencies and domains dynamically
  // Fix 2026-07-12: dnr.sc.gov/fishregs now 404s — official regs moved to eRegulations
  // For SC, we search both dnr.sc.gov (lake descriptions still work) AND eregulations.com (new regs host)
  let dnrName = "SCDNR";
  let dnrDomain = "dnr.sc.gov";
  let regsSiteFilter = "site:dnr.sc.gov OR site:eregulations.com";
  if (state === "NC") { dnrName = "NCWRC"; dnrDomain = "ncwildlife.org"; regsSiteFilter = "site:ncwildlife.org OR site:eregulations.com"; }
  else if (state === "GA") { dnrName = "GADNR"; dnrDomain = "georgiawildlife.com"; regsSiteFilter = "site:georgiawildlife.com OR site:eregulations.com"; }

  // Use baseName in queries to improve Tavily hit rate (avoid ", SC" suffix which hurts)
  const queryLake = baseName || lakeName;
  const stateFullName = { SC: 'South Carolina', NC: 'North Carolina', GA: 'Georgia' }[state] || 'South Carolina';
  // CREDIT BUDGET: reduced from 8 queries × (search+extract)=16 Tavily calls
  // to 4 queries × search-only = 4 calls. Extract is wasteful here because
  // the proxy-download step will fetch full content anyway.
  const queryPatterns = [
    `"${queryLake}" (fisheries OR biology OR \"striped bass\" OR crappie OR \"largemouth\") ${dnrName}`,
    `"${queryLake}" (regulations OR \"creel limit\" OR \"size limit\" OR \"bag limit\") (${regsSiteFilter})`,
    `"${queryLake}" (limnology OR thermocline OR \"water quality\" OR \"dissolved oxygen\") (USACE OR USGS OR EPA)`,
    // EPA NSCEP — covers both "Report on Lake X" and "Report on X Lake" naming
    `"Report on Lake ${queryLake}" OR "Report on ${queryLake} Lake" OR "${queryLake}" (NESWP OR eutrophication OR nepis)`,
  ];

  let discoveredSources = [];
  const googleApiKey = env.GOOGLE_SEARCH_API_KEY || env.GOOGLE_CSE_KEY;
  const googleCx = env.GOOGLE_SEARCH_CX || env.GOOGLE_CSE_CX;
  const tavilyApiKey = env.TAVILY_API_KEY || env.TAVILY_KEY;

  // CREDIT BUDGET: search-only, no extract. The proxy-download step fetches
  // full page content via Firecrawl or basic fetch, so Tavily extract is
  // redundant here (was costing 4-8 extra credits per run for no benefit).
  if (tavilyApiKey) {
    for (const q of queryPatterns) {
      try {
        const searchRes = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Authorization": `Bearer ${tavilyApiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query: q, search_depth: "basic", max_results: 3, include_raw_content: false, exclude_domains: [] })
        });
        if (!searchRes.ok) continue;
        const searchData = await searchRes.json();
        for (const r of (searchData.results || [])) {
          const off = offLakePattern(r.title||'', r.url||'');
          if (off) { console.log(`filtered off-lake ${off} for ${baseName}: ${r.url}`); continue; }
          const isPdf = String(r.url||'').toLowerCase().endsWith('.pdf');
          let host = "Tavily";
          try { host = new URL(r.url).hostname; } catch {}
          let authority = host;
          if (/dnr\.sc\.gov/.test(host) || /eregulations\.com/.test(host)) authority = "SCDNR";
          else if (/usgs\.gov/.test(host)) authority = "USGS";
          else if (/usace\.army\.mil/.test(host)) authority = "USACE";
          else if (/nepis\.epa\.gov|epa\.gov/.test(host)) authority = "EPA NSCEP";
          else if (/dnr|wildlife/.test(host)) authority = dnrName;
          discoveredSources.push({
            title: (r.title || `${queryLake} - ${host}`).replace(/\s+/g,' ').trim().slice(0,180),
            type: isPdf ? "PDF" : "HTML",
            authority,
            url: r.url,
            priority: (r.title||'').toLowerCase().includes(baseLower) ? 1 : 2,
            score: r.score || 0
          });
        }
      } catch (err) {
        console.warn(`Tavily search failed for [${q}]: ${err.message}`);
      }
    }
  } else if (googleApiKey && googleCx) {
    for (const q of queryPatterns) {
      try {
        const url = `https://customsearch.googleapis.com/customsearch/v1?key=${encodeURIComponent(googleApiKey)}&cx=${encodeURIComponent(googleCx)}&q=${encodeURIComponent(q)}`;
        const res = await fetch(url);
        if (!res.ok) continue;
        const data = await res.json();
        const items = data.items || [];
        for (const item of items) {
          const off = offLakePattern(item.title||'', item.link||'');
          if (off) continue;
          const isPdf = String(item.link||'').toLowerCase().endsWith('.pdf') || String(item.mime||'').includes('pdf');
          discoveredSources.push({
            title: (item.title||`${queryLake} Resource`).slice(0,180),
            type: isPdf ? "PDF" : "HTML",
            authority: item.displayLink || "Google Search",
            url: item.link,
            priority: (item.title||'').toLowerCase().includes(baseLower) ? 1 : 2
          });
        }
      } catch (err) { console.warn(`Google search failed: ${err.message}`); }
    }
  }

  // Deduplicate by URL and by normalized title to avoid "Lake Wateree, SC Document" duplicates
  const seenUrls = new Set();
  const seenTitles = new Set();
  let filtered = [];
  for (const src of discoveredSources) {
    const normUrl = String(src.url||'').split('?')[0].toLowerCase();
    const normTitle = String(src.title||'').toLowerCase().replace(/\s+/g,' ').trim();
    if (seenUrls.has(normUrl)) continue;
    if (normUrl.includes('pocket') && normTitle.includes('pocket')) continue; // skip generic pocket guide here, client also skips
    // skip exact title dupes coming from Tavily generic naming
    if (seenTitles.has(normTitle) && normTitle.includes('document') && normTitle.length < 40) continue;
    // off-lake final check
    const off = offLakePattern(src.title, src.url);
    if (off) continue;
    seenUrls.add(normUrl);
    seenTitles.add(normTitle);
    filtered.push(src);
  }
  discoveredSources = filtered;

  // Sort by priority (1 = lake-specific) then by score
  // Per-lake pre-seeded authoritative sources — always included regardless of Tavily results
  const LAKE_SEEDS = {
    wateree: [
      { title: "Lake Wateree SCDNR Lake Description", type: "HTML", authority: "SCDNR", url: "https://www.dnr.sc.gov/lakes/wateree/description.html", priority: 1 },
      { title: "Lake Wateree Regulations", type: "HTML", authority: "SCDNR", url: "https://www.dnr.sc.gov/lakes/wateree/regs.html", priority: 1 },
      { title: "SC Freshwater Fish Size & Possession Limits (eRegulations)", type: "HTML", authority: "SCDNR", url: "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits", priority: 1 },
      { title: "SCDNR Striped Bass Species Page (current regulations & biology)", type: "HTML", authority: "SCDNR", url: "https://www.dnr.sc.gov/fish/species/stripedbass.html", priority: 1 },
    ],
    murray: [
      { title: "Lake Murray SCDNR Lake Description", type: "HTML", authority: "SCDNR", url: "https://www.dnr.sc.gov/lakes/murray/description.html", priority: 1 },
      { title: "Lake Murray Regulations", type: "HTML", authority: "SCDNR", url: "https://www.dnr.sc.gov/lakes/murray/regs.html", priority: 1 },
      { title: "SC Freshwater Game Fishing Regulations (eRegulations)", type: "HTML", authority: "SCDNR", url: "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits", priority: 1 },
    ],
    marion: [
      { title: "Lake Marion SCDNR Lake Description", type: "HTML", authority: "SCDNR", url: "https://www.dnr.sc.gov/lakes/marion/description.html", priority: 1 },
      { title: "Lake Marion Regulations", type: "HTML", authority: "SCDNR", url: "https://www.dnr.sc.gov/lakes/marion/regs.html", priority: 1 },
      { title: "SC Freshwater Game Fishing Regulations (eRegulations)", type: "HTML", authority: "SCDNR", url: "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits", priority: 1 },
    ],
    moultrie: [
      { title: "Lake Moultrie SCDNR Lake Description", type: "HTML", authority: "SCDNR", url: "https://www.dnr.sc.gov/lakes/moultrie/description.html", priority: 1 },
      { title: "Lake Moultrie Regulations", type: "HTML", authority: "SCDNR", url: "https://www.dnr.sc.gov/lakes/moultrie/regs.html", priority: 1 },
      { title: "SC Freshwater Fish Size & Possession Limits (eRegulations)", type: "HTML", authority: "SCDNR", url: "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits", priority: 1 },
    ],
    monticello: [
      { title: "Lake Monticello SCDNR Lake Description", type: "HTML", authority: "SCDNR", url: "https://www.dnr.sc.gov/lakes/monticello/description.html", priority: 1 },
      { title: "Lake Monticello Regulations", type: "HTML", authority: "SCDNR", url: "https://www.dnr.sc.gov/lakes/monticello/regs.html", priority: 1 },
      { title: "SC Freshwater Fish Size & Possession Limits (eRegulations)", type: "HTML", authority: "SCDNR", url: "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits", priority: 1 },
    ],
    keowee: [
      { title: "Lake Keowee SCDNR Lake Description", type: "HTML", authority: "SCDNR", url: "https://www.dnr.sc.gov/lakes/keowee/description.html", priority: 1 },
      { title: "Lake Keowee Regulations", type: "HTML", authority: "SCDNR", url: "https://www.dnr.sc.gov/lakes/keowee/regs.html", priority: 1 },
      { title: "SC Freshwater Fish Size & Possession Limits (eRegulations)", type: "HTML", authority: "SCDNR", url: "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits", priority: 1 },
    ],
    greenwood: [
      { title: "Lake Greenwood SCDNR Lake Description", type: "HTML", authority: "SCDNR", url: "https://www.dnr.sc.gov/lakes/greenwood/description.html", priority: 1 },
      { title: "Lake Greenwood Regulations", type: "HTML", authority: "SCDNR", url: "https://www.dnr.sc.gov/lakes/greenwood/regs.html", priority: 1 },
      { title: "SC Freshwater Fish Size & Possession Limits (eRegulations)", type: "HTML", authority: "SCDNR", url: "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits", priority: 1 },
    ],
  };

  // Default seeds for EVERY tristate lake (SC/NC/GA) — not just the hand-curated LAKE_SEEDS list.
  // EPA NEPI S search URL is included so the download step always has a path into NSCEP.
  const defaultStateSeeds = [];
  if (state === 'SC') {
    defaultStateSeeds.push(
      { title: `Lake ${baseName} SCDNR Lake Description`, type: "HTML", authority: "SCDNR", url: `https://www.dnr.sc.gov/lakes/${baseLower}/description.html`, priority: 1 },
      { title: `Lake ${baseName} Regulations`, type: "HTML", authority: "SCDNR", url: `https://www.dnr.sc.gov/lakes/${baseLower}/regs.html`, priority: 1 },
      { title: "SC Freshwater Fish Size & Possession Limits (eRegulations)", type: "HTML", authority: "SCDNR", url: "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits", priority: 1 },
    );
  } else if (state === 'NC') {
    defaultStateSeeds.push(
      { title: "NC Freshwater Fishing Regulations (eRegulations)", type: "HTML", authority: "NCWRC", url: "https://www.eregulations.com/northcarolina/fishing/freshwater-fishing-regulations", priority: 1 },
    );
  } else if (state === 'GA') {
    defaultStateSeeds.push(
      { title: "GA Freshwater Fishing Regulations (eRegulations)", type: "HTML", authority: "GA DNR", url: "https://www.eregulations.com/georgia/fishing/freshwater-fishing-regulations", priority: 1 },
    );
  }
  // EPA NSCEP search landing for this lake — proxy will harvest raw-text links via Firecrawl
  defaultStateSeeds.push({
    title: `EPA NSCEP search: Report on ${baseName} / Lake ${baseName}`,
    type: "HTML",
    authority: "EPA NSCEP",
    url: buildNepisSearchUrl(lakeName, state, baseName),
    priority: 1,
    source: 'nepis_seed'
  });

  // Inject seeds — seeds always take guaranteed slots, prepend so they sort first
  const seeds = [...(LAKE_SEEDS[baseLower] || []), ...defaultStateSeeds];
  const guaranteedSeeds = [];
  for (const seed of seeds) {
    const normUrl = String(seed.url || '').split('?')[0].toLowerCase();
    if (seenUrls.has(normUrl) || seenUrls.has(seed.url)) continue;
    seenUrls.add(normUrl);
    seenUrls.add(seed.url);
    guaranteedSeeds.push(seed);
  }
  // Prepend seeds so they beat Tavily results in sort
  discoveredSources = [...guaranteedSeeds, ...discoveredSources];

  discoveredSources.sort((a,b)=> (a.priority-b.priority) || ((b.score||0)-(a.score||0)));

  // If zero results, use curated fallback
  if (discoveredSources.length === 0) {
    discoveredSources = [
      {
        title: `${lakeName} SCDNR Fisheries Management - Annual Report Section`,
        type: "PDF",
        authority: "SCDNR",
        url: "https://www.dnr.sc.gov/fish/fwfi/files/2017_annual_report.pdf",
        priority: 2
      },
      {
        title: `SC Freshwater Fishing Regulations (covers ${lakeName} creel/size limits)`,
        type: "PDF",
        authority: "SCDNR",
        url: "https://dc.statelibrary.sc.gov/server/api/core/bitstreams/7d7100f0-3b63-4d07-921c-d9a37e3f2b46/content",
        priority: 2
      },
      {
        title: `${lakeName} - SCDNR Lakes Information`,
        type: "HTML",
        authority: "SCDNR",
        url: `https://www.dnr.sc.gov/lakes/${baseLower}/description.html`,
        priority: 1
      }
    ];
  }

  // Seeds are guaranteed in final list; fill remaining slots with Tavily results
  const tavilySources = discoveredSources.filter(s => !guaranteedSeeds.includes(s));
  const remainingSlots = Math.max(0, 10 - guaranteedSeeds.length);
  const tavilyFill = tavilySources.filter(s => s.priority===1).slice(0, remainingSlots);
  const tavilyGeneric = tavilySources.filter(s => s.priority!==1);
  let finalList = [...guaranteedSeeds, ...tavilyFill, ...tavilyGeneric].slice(0,10);
  if (finalList.length < 3) finalList = discoveredSources.slice(0,10);

  return new Response(JSON.stringify({ success: true, sources: finalList, baseName, filteredCount: discoveredSources.length - finalList.length }), { headers: JSON_HEADERS });
}
__name(handleResearchDiscover, "handleResearchDiscover");

async function handleResearchProxyDownload(request, env) {
  const url = new URL(request.url);
  const target = url.searchParams.get("url");
  const sourceType = url.searchParams.get("type") || ""; // "PDF" or "HTML"
  if (!target) {
    return new Response(JSON.stringify({ success: false, error: "Missing url parameter" }), { status: 400, headers: JSON_HEADERS });
  }

  // Route HTML sources through Firecrawl ONLY for JS-rendered SPAs and NEPIS pages.
  // CREDIT BUDGET: static HTML pages (SCDNR descriptions, USGS, etc.) work fine with
  // basic fetch + HTML stripping. Firecrawl costs 1 credit per scrape, so we only
  // use it when necessary.
  const firecrawlKey = env.FIRECRAWL_API_KEY || env.FIRECRAWL_KEY;
  const isHtml = sourceType.toUpperCase() === 'HTML' || (!target.toLowerCase().includes('.pdf') && !sourceType.toUpperCase().includes('PDF'));
  // EPA NSCEP / NEPIS ZyNET:
  //  - Search results page (ZyActionS) — harvest document links
  //  - Document landing (ZyActionD) — extract raw-text / PDF format links
  const isNepisSearch = /nepis\.epa\.gov/i.test(target) && /[?&]ZyAction=ZyActionS\b/i.test(target);
  const isNepisLanding = /nepis\.epa\.gov/i.test(target) && (/[?&]ZyAction=ZyActionD\b/i.test(target) || /zypdf\.cgi/i.test(target));
  const isNepisAny = /nepis\.epa\.gov|ZyNET\.exe/i.test(target);
  // Only use Firecrawl for JS-heavy SPAs and NEPIS pages (saves ~8 Firecrawl credits per run)
  const needsFirecrawl = isNepisSearch || isNepisLanding || isNepisAny || /eregulations\.com/i.test(target);

  if (firecrawlKey && isHtml && needsFirecrawl) {
    try {
      // Search-results page: return markdown of the results list so the client can
      // store it, AND surface ZyActionD links in X-Nepis-Documents for follow-up.
      if (isNepisSearch) {
        const scrapeRes = await fetch('https://api.firecrawl.dev/v1/scrape', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${firecrawlKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: target,
            formats: ['links', 'markdown'],
            onlyMainContent: true,
            waitFor: 2500,
            timeout: 25000
          })
        });
        if (scrapeRes.ok) {
          const scrapeData = await scrapeRes.json();
          const md = scrapeData.data?.markdown || scrapeData.markdown || '';
          const links = scrapeData.data?.links || scrapeData.links || [];
          const docLinks = [];
          for (const link of links) {
            const url = typeof link === 'string' ? link : (link.url || '');
            if (/ZyActionD=/i.test(url)) {
              docLinks.push({
                url,
                title: (typeof link === 'object' && link.title) ? String(link.title).slice(0, 180) : 'EPA NSCEP document'
              });
            }
          }
          // Also pull from markdown
          for (const m of md.matchAll(/https?:\/\/[^\s)"']+ZyActionD[^\s)"']*/g)) {
            if (!docLinks.some(d => d.url === m[0])) docLinks.push({ url: m[0], title: 'EPA NSCEP document' });
          }
          if (md.length > 100 || docLinks.length) {
            // If we found a single clear document, fetch its raw .txt download directly.
            if (docLinks.length === 1) {
              const docUrl = docLinks[0].url;
              const rawTextUrl = toNepisRawTextUrl(docUrl);
              if (rawTextUrl) {
                try {
                  const rawRes = await fetch(rawTextUrl, {
                    headers: {
                      'User-Agent': 'TrollMap/15.3 Evidence Engine',
                      'Accept': 'text/plain,*/*'
                    }
                  });
                  if (rawRes.ok) {
                    const rawText = await rawRes.text();
                    if (rawText.length > 200) {
                      const firstLine = rawText.split('\n')[0] || '';
                      const metaMatch = firstLine.match(/^([A-Z]+[0-9]+)(Report on (?:Lake )?.+?)([0-9]{1,3})([0-9]{4})([A-Z].*)$/i);
                      const title = metaMatch ? metaMatch[2].trim() : (docLinks[0].title || '');
                      const headers = new Headers({
                        'Content-Type': 'text/plain; charset=utf-8',
                        'Access-Control-Allow-Origin': '*',
                        'X-Source': 'firecrawl',
                        'X-Nepis-Format': 'raw_text',
                        'X-Nepis-Title': title.slice(0, 180),
                        'X-Nepis-Doc-Url': docUrl,
                        'X-Nepis-RawText': rawTextUrl
                      });
                      return new Response(rawText, { headers });
                    }
                  }
                } catch (e) {
                  console.warn(`NEPI S single-doc raw-text fetch failed: ${e.message}`);
                }
              }
            }
            // Multi-doc search results: return markdown catalog + document URL list
            const catalog = [
              `# EPA NSCEP search results`,
              ``,
              `Found ${docLinks.length} document landing page(s).`,
              ``,
              ...docLinks.slice(0, 15).map((d, i) => `${i + 1}. [${d.title}](${d.url})`),
              ``,
              `---`,
              ``,
              md.slice(0, 50000)
            ].join('\n');
            const headers = new Headers({
              'Content-Type': 'text/plain; charset=utf-8',
              'Access-Control-Allow-Origin': '*',
              'X-Source': 'firecrawl',
              'X-Nepis-Format': 'search_results',
              'X-Nepis-Doc-Count': String(docLinks.length),
              // First few document URLs for client follow-up (header size limit)
              'X-Nepis-Documents': JSON.stringify(docLinks.slice(0, 5).map(d => d.url)).slice(0, 1500)
            });
            return new Response(catalog, { headers });
          }
        }
      }

      // Two-step for EPA NSCEP document landing pages: first extract format links,
      // then scrape the raw-text URL for clean markdown (avoids TIFF/OCR).
      if (isNepisLanding || (isNepisAny && !isNepisSearch)) {
        // NSCEP viewer URLs share the same File= parameter as the raw-text download.
        // Try to fetch the .txt download directly before paying for a Firecrawl scrape.
        const rawTextUrl = toNepisRawTextUrl(target);
        if (rawTextUrl) {
          try {
            const rawRes = await fetch(rawTextUrl, {
              headers: {
                'User-Agent': 'TrollMap/15.3 Evidence Engine',
                'Accept': 'text/plain,*/*'
              }
            });
            if (rawRes.ok) {
              const rawText = await rawRes.text();
              if (rawText.length > 200) {
                // The first metadata line concatenates pubnumber + title + pages + year + ...
                // e.g. "NESWP434Report on Lake Marion,... EPA Region IV601976NEPIS..."
                // or   "NESWP440Report on Wateree Lake,... EPA Region IV481975NEPIS..."
                const firstLine = rawText.split('\n')[0] || '';
                const metaMatch = firstLine.match(/^([A-Z]+[0-9]+)(Report on (?:Lake )?.+?)([0-9]{1,3})([0-9]{4})([A-Z].*)$/i);
                const title = metaMatch ? metaMatch[2].trim() : '';
                const headers = new Headers({
                  'Content-Type': 'text/plain; charset=utf-8',
                  'Access-Control-Allow-Origin': '*',
                  'X-Source': 'firecrawl',
                  'X-Nepis-Format': 'raw_text',
                  'X-Nepis-Title': title.slice(0, 180),
                  'X-Nepis-RawText': rawTextUrl
                });
                return new Response(rawText, { headers });
              }
            }
          } catch (eRaw) {
            console.warn(`Direct NSCEP raw-text fetch failed: ${eRaw.message}`);
          }
        }

        const landRes = await fetch('https://api.firecrawl.dev/v1/scrape', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${firecrawlKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: target,
            formats: ['markdown', 'json'],
            onlyMainContent: true,
            timeout: 25000,
            jsonOptions: {
              schema: {
                type: 'object',
                properties: {
                  report_metadata: {
                    type: 'object',
                    properties: {
                      title: { type: 'string' },
                      pub_number: { type: 'string' }
                    }
                  },
                  available_formats: {
                    type: 'object',
                    properties: {
                      pdf_url: { type: 'string', description: 'Link containing ZyPDF.cgi or .pdf' },
                      raw_text_url: { type: 'string', description: 'Link to the raw text, ASCII, or TXT version of the report' },
                      tiff_url: { type: 'string', description: 'Link to the TIFF image files' }
                    }
                  }
                },
                required: ['report_metadata', 'available_formats']
              }
            }
          })
        });
        if (landRes.ok) {
          const landData = await landRes.json();
          const extracted = landData.data?.json || landData.json || {};
          const formats = extracted.available_formats || {};
          const rawTextUrl = formats.raw_text_url || formats.text_url || null;
          const pdfUrl = formats.pdf_url || null;
          const title = extracted.report_metadata?.title || '';
          // Prefer raw text endpoint — Firecrawl markdown of a .txt/ASCII page is clean
          if (rawTextUrl && /^https?:\/\//i.test(rawTextUrl)) {
            try {
              const textRes = await fetch('https://api.firecrawl.dev/v1/scrape', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${firecrawlKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: rawTextUrl, formats: ['markdown'], onlyMainContent: true, timeout: 25000 })
              });
              if (textRes.ok) {
                const textData = await textRes.json();
                const markdown = textData.data?.markdown || textData.markdown || '';
                if (markdown && markdown.length > 100) {
                  const headers = new Headers({
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Access-Control-Allow-Origin': '*',
                    'X-Source': 'firecrawl',
                    'X-Nepis-Format': 'raw_text',
                    'X-Nepis-Title': title.slice(0, 180),
                    'X-Nepis-Pdf': pdfUrl || ''
                  });
                  return new Response(markdown, { headers });
                }
              }
            } catch (e2) {
              console.warn(`NSCEP raw-text scrape failed: ${e2.message}`);
            }
          }
          // Fall back to landing-page markdown if format extraction didn't yield text
          const landMd = landData.data?.markdown || landData.markdown || '';
          if (landMd && landMd.length > 100) {
            const headers = new Headers({
              'Content-Type': 'text/plain; charset=utf-8',
              'Access-Control-Allow-Origin': '*',
              'X-Source': 'firecrawl',
              'X-Nepis-Format': 'landing',
              'X-Nepis-Title': title.slice(0, 180),
              'X-Nepis-Pdf': pdfUrl || '',
              'X-Nepis-RawText': rawTextUrl || ''
            });
            return new Response(landMd, { headers });
          }
        }
      }

      // Standard Firecrawl markdown scrape for HTML pages (eRegulations, SCDNR, etc.)
      // waitFor helps JS-rendered SPAs like eRegulations populate table rows
      const isSpa = /eregulations\.com/i.test(target);
      const fcRes = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${firecrawlKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: target,
          formats: ['markdown'],
          onlyMainContent: true,
          waitFor: isSpa ? 3000 : 0,
          timeout: 25000
        })
      });
      if (fcRes.ok) {
        const fcData = await fcRes.json();
        const markdown = fcData.data?.markdown || fcData.markdown || '';
        if (markdown && markdown.length > 100) {
          // Return as text/plain so lake-research.js can use it directly without pdf.js
          const headers = new Headers({ 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'X-Source': 'firecrawl' });
          return new Response(markdown, { headers });
        }
      }
      // Fall through to basic fetch if Firecrawl fails
    } catch (e) {
      console.warn(`Firecrawl failed for ${target}: ${e.message} — falling back to basic fetch`);
    }
  }

  try {
    const response = await fetch(target, {
      headers: {
        "User-Agent": "TrollMap/15.3 Evidence Engine",
        "Accept": "*/*"
      }
    });

    if (!response.ok) {
      return new Response(JSON.stringify({ success: false, error: `HTTP Error ${response.status}: Failed to retrieve file from source.` }), { status: response.status, headers: JSON_HEADERS });
    }

    const headers = new Headers(response.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    return new Response(response.body, { headers });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 502, headers: JSON_HEADERS });
  }
}
__name(handleResearchProxyDownload, "handleResearchProxyDownload");

// ─── DATASET HUNTER ──────────────────────────────────────────────────────────
// Uses Firecrawl /v1/map to crawl authoritative agency sites and find
// stocking reports, creel surveys, fisheries assessments, and academic papers
// for a given lake. Returns a ranked list of discovered dataset URLs.
//
// Target sources per state:
//   SC  — dnr.sc.gov (stocking, creel, annual reports, lake descriptions)
//   NC  — ncwildlife.org
//   GA  — georgiawildlife.com
//   All — USGS ScienceBase, USACE, Google Scholar via Tavily
//
// Route: POST /research/dataset-hunt  { lakeName, state }

const DATASET_HUNT_TARGETS = {
  SC: [
    { label: 'SCDNR Fisheries',        url: 'https://www.dnr.sc.gov/fish/',         depth: 3 },
    { label: 'SCDNR Lakes',            url: 'https://www.dnr.sc.gov/lakes/',         depth: 2 },
    { label: 'SCDNR Publications',     url: 'https://www.dnr.sc.gov/publications/',  depth: 2 },
    // EPA NSCEP / NEPI S — "Report on Lake …" water-quality series + other SC lake reports
    { label: 'EPA NSCEP / NEPI S',      url: 'https://nepis.epa.gov/',               depth: 1, isNepis: true },
  ],
  NC: [
    { label: 'NCWRC Fisheries',        url: 'https://www.ncwildlife.org/fishing',    depth: 2 },
    { label: 'EPA NSCEP / NEPI S',      url: 'https://nepis.epa.gov/',               depth: 1, isNepis: true },
  ],
  GA: [
    { label: 'GA DNR Fisheries',       url: 'https://georgiawildlife.com/fishing',   depth: 2 },
    { label: 'EPA NSCEP / NEPI S',      url: 'https://nepis.epa.gov/',               depth: 1, isNepis: true },
  ],
};

// Keywords that indicate a URL is a dataset/report worth harvesting
const DATASET_KEYWORDS = [
  'stocking','creel','survey','report','annual','fisheries','assessment',
  'population','management','study','research','limnology','water quality',
  'electrofishing','monitoring','harvest','biology','publication',
  // EPA NSCEP lake reports
  'report on lake','neswp','nepis','water quality','eutrophication','trophic'
];

// Score a URL for relevance to a given lake
function scoreDatasetUrl(url, title, lakeName) {
  const baseName = lakeName.replace(/^Lake\s+/i,'').replace(/,\s*(SC|NC|GA).*$/i,'').trim().toLowerCase();
  const combined = `${url} ${title}`.toLowerCase();
  let score = 0;
  if (combined.includes(baseName)) score += 40;
  for (const kw of DATASET_KEYWORDS) {
    if (combined.includes(kw)) score += 5;
  }
  if (/\.pdf$/i.test(url)) score += 10; // PDFs are usually actual reports
  if (/annual.report|creel.survey|stocking.report/i.test(combined)) score += 20;
  if (/nepis\.epa\.gov|zynet\.exe|zypdf\.cgi/i.test(url)) score += 15; // EPA NSCEP docs
  if (/report on lake/i.test(combined)) score += 25;
  if (/\d{4}/.test(url)) score += 5; // has a year — likely a dated report
  return score;
}

// Build EPA NSCEP search-results URL(s) for a lake.
// Historical EPA "Report on Lake …" series (1970s–80s) uses INCONSISTENT naming:
//   Most lakes:  "Report on Lake Murray"   (Lake before name)
//   Wateree etc: "Report on Wateree Lake"  (name before Lake)
// Using title filter "Report on" (not "Report on Lake") catches BOTH conventions
// since the lake name is in the Query field anyway.
function buildNepisSearchUrl(lakeName, state, queryOverride = null) {
  const baseName = String(lakeName || '').replace(/^Lake\s+/i, '').replace(/,\s*(SC|NC|GA|VA|TN).*$/i, '').trim();
  const stateName = { SC: 'South Carolina', NC: 'North Carolina', GA: 'Georgia', VA: 'Virginia', TN: 'Tennessee' }[String(state || 'SC').toUpperCase()] || 'South Carolina';
  const query = encodeURIComponent(queryOverride || baseName || stateName);
  // Use "Report on" (not "Report on Lake") so both naming conventions match:
  //   "Report on Lake Murray" AND "Report on Wateree Lake"
  const titleField = encodeURIComponent('Report on');
  // Indexes cover historical EPA lake reports (1970s–2020)
  const indexes = [
    '2016 Thru 2020', '2011 Thru 2015', '2006 Thru 2010', '2000 Thru 2005',
    '1995 Thru 1999', '1991 Thru 1994', '1986 Thru 1990', '1981 Thru 1985',
    '1976 Thru 1980', 'Prior to 1976'
  ].map(i => `Index=${encodeURIComponent(i)}`).join('&');
  return `https://nepis.epa.gov/Exe/ZyNET.exe?ZyAction=ZyActionS&User=ANONYMOUS&Password=anonymous&Client=EPA&SearchBack=ZyActionL&SortMethod=h%7C-&MaximumDocuments=15&ImageQuality=r85g16%2Fr85g16%2Fx150y150g16%2Fi500&Display=hpfr&DefSeekPage=&Toc=&TocEntry=&TocRestrict=n&QField=title%5E${titleField}&UseQField=title&Docs=&SearchMethod=1&Time=&FullText=&IntQFieldOp=1&Query=${query}&ExtQFieldOp=1&FuzzyDegree=0&${indexes}`;
}

// Convert an EPA NSCEP document viewer/landing URL into the raw-text download URL.
// The viewer endpoint uses ZyActionD=ZyDocument and displays scanned page images.
// The same .txt endpoint with ZyActionW=Download returns the OCR/plain-text file
// referenced by the File= parameter.
function toNepisRawTextUrl(landingUrl) {
  try {
    const url = new URL(landingUrl);
    if (!/nepis\.epa\.gov/i.test(url.hostname)) return null;
    if (!/\.txt$/i.test(url.pathname)) return null;
    // Already a download link — nothing to do.
    if (/ZyActionW=Download/i.test(url.search)) return landingUrl;
    // Switch from the viewer action to the download action, keeping File= etc.
    url.searchParams.delete('ZyActionD');
    url.searchParams.set('ZyActionW', 'Download');
    // Retain existing SearchMethod and Display if present; only default if missing
    if (!url.searchParams.has('SearchMethod')) {
      url.searchParams.set('SearchMethod', '1');
    }
    if (!url.searchParams.has('Display')) {
      url.searchParams.set('Display', 'hpfr');
    }
    return url.toString();
  } catch (e) {
    return null;
  }
}

// Queries to run against NEPI S for any SC/NC/GA (tristate) lake
function buildNepisQueryVariants(lakeName, state) {
  // Normalize: "Clarks Hill / Thurmond, SC/GA" → try both names; "High Rock Lake, NC" → "High Rock"
  let raw = String(lakeName || '').replace(/,\s*(SC|NC|GA|VA|TN)(\/(SC|NC|GA|VA|TN))?\s*$/i, '').trim();
  raw = raw.replace(/\s+Lake$/i, '').replace(/^Lake\s+/i, '').trim();
  const parts = raw.split(/\s*\/\s*|\s+or\s+/i).map(p => p.replace(/^Lake\s+/i, '').replace(/\s+Lake$/i, '').trim()).filter(Boolean);
  const primary = parts[0] || raw;
  const stateCode = String(state || 'SC').toUpperCase();
  const stateName = { SC: 'South Carolina', NC: 'North Carolina', GA: 'Georgia', VA: 'Virginia', TN: 'Tennessee' }[stateCode] || 'South Carolina';
  // Aliases that help NEPI S title search (Clarks Hill vs Thurmond, etc.)
  const aliasMap = {
    thurmond: ['Thurmond', 'Clarks Hill', "Clark's Hill", 'J. Strom Thurmond'],
    'clarks hill': ['Clarks Hill', 'Thurmond', "Clark's Hill"],
    'clark hill': ['Clarks Hill', 'Thurmond'],
    'j strom thurmond': ['Thurmond', 'Clarks Hill'],
    hartwell: ['Hartwell'],
    russell: ['Russell'],
    murray: ['Murray'],
    wateree: ['Wateree'],
    marion: ['Marion'],
    moultrie: ['Moultrie'],
    keowee: ['Keowee'],
    jocassee: ['Jocassee'],
    greenwood: ['Greenwood'],
    norman: ['Norman'],
    wylie: ['Wylie'],
    secession: ['Secession'],
    monticello: ['Monticello'],
    'high rock': ['High Rock'],
    tillery: ['Tillery'],
    badin: ['Badin'],
    blewett: ['Blewett Falls'],
    'blewett falls': ['Blewett Falls'],
    jordan: ['Jordan', 'B. Everett Jordan'],
    'b everett jordan': ['Jordan', 'B. Everett Jordan'],
    falls: ['Falls'],
    hickory: ['Hickory'],
    rhodhiss: ['Rhodhiss'],
    kerr: ['Kerr', 'Buggs Island'],
    'buggs island': ['Kerr', 'Buggs Island'],
    gaston: ['Gaston'],
    bowen: ['Bowen'],
    blalock: ['Blalock'],
    robinson: ['Robinson'],
    'fishing creek': ['Fishing Creek'],
    parr: ['Parr'],
  };
  const variants = new Set();
  const addName = (n) => {
    if (!n) return;
    variants.add(n);
    if (!/^lake\s+/i.test(n)) variants.add(`Lake ${n}`);
  };
  // Primary + slash-split parts
  for (const p of parts) {
    addName(p);
    const key = p.toLowerCase();
    for (const a of (aliasMap[key] || [])) addName(a);
  }
  // Also match primary key against alias map
  const primaryKey = primary.toLowerCase();
  for (const a of (aliasMap[primaryKey] || [])) addName(a);
  // State name helps the historical "Report on Lake … South Carolina" series
  // CREDIT BUDGET: reduced from 8 variants to 2 — primary name + state name.
  // The NSCEP title filter is now "Report on" (not "Report on Lake"), so both
  // naming conventions are caught with a single search per variant.
  variants.add(stateName);
  return [...variants].filter(Boolean).slice(0, 2);
}
__name(buildNepisSearchUrl, 'buildNepisSearchUrl');
__name(buildNepisQueryVariants, 'buildNepisQueryVariants');

async function handleResearchDatasetHunt(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || '').trim();
  const state    = String(body.state || 'SC').trim().toUpperCase();

  if (!lakeName) {
    return new Response(JSON.stringify({ ok: false, error: 'missing lakeName' }), { status: 400, headers: JSON_HEADERS });
  }

  const firecrawlKey = env.FIRECRAWL_API_KEY || env.FIRECRAWL_KEY;
  const tavilyKey    = env.TAVILY_API_KEY || env.TAVILY_KEY;
  const baseName     = lakeName.replace(/^Lake\s+/i,'').replace(/,\s*(SC|NC|GA).*$/i,'').trim();
  const baseNameLower = baseName.toLowerCase();

  const discovered = [];
  const seenUrls   = new Set();

  // Helper: ingest a list of Firecrawl/Tavily links into discovered[]
  const ingestLink = (url, title, authority, source, minScore = 5) => {
    if (!url || seenUrls.has(url)) return;
    seenUrls.add(url);
    const score = scoreDatasetUrl(url, title || '', lakeName);
    if (score < minScore) return;
    discovered.push({
      url,
      title: (title || url.split('/').pop().replace(/[-_]/g, ' ').replace(/\.pdf$/i, '').trim() || url).slice(0, 180),
      type: /\.pdf$/i.test(url) || /ZyPDF/i.test(url) ? 'PDF' : 'HTML',
      authority,
      source,
      score,
    });
  };

  // Helper: scrape/map one NEPI S search-results URL and harvest ZyActionD links
  const harvestNepisSearchPage = async (mapUrl, queryLabel) => {
    if (!firecrawlKey) return;
    try {
      // Prefer /v1/scrape with links — more reliable on ZyNET dynamic results than /map
      const scrapeRes = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${firecrawlKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: mapUrl,
          formats: ['links', 'markdown'],
          onlyMainContent: true,
          waitFor: 2000,
          timeout: 25000
        })
      });
      if (scrapeRes.ok) {
        const scrapeData = await scrapeRes.json();
        const links = scrapeData.data?.links || scrapeData.links || [];
        const md = scrapeData.data?.markdown || scrapeData.markdown || '';
        // Also pull ZyActionD URLs embedded in markdown
        const mdUrls = [...md.matchAll(/https?:\/\/[^\s)"']+/g)].map(m => m[0]);
        const all = [...links.map(l => typeof l === 'string' ? { url: l } : l), ...mdUrls.map(u => ({ url: u }))];
        for (const link of all) {
          const url = typeof link === 'string' ? link : (link.url || link);
          if (!url) continue;
          if (!/ZyActionD|ZyPDF|nepis\.epa\.gov/i.test(url)) continue;
          // Prefer lake-name relevance; still keep strong EPA hits
          const title = (typeof link === 'object' && link.title) ? String(link.title) : `EPA NSCEP — ${queryLabel || baseName}`;
          const score = scoreDatasetUrl(url, title + ' ' + md.slice(0, 300), lakeName);
          if (score < 20 && !new RegExp(baseName, 'i').test(title + url + md.slice(0, 500))) continue;
          ingestLink(url, title, 'EPA NSCEP', 'firecrawl_nepis_scrape', 15);
        }
        return;
      }
      console.warn(`NEPI S scrape failed for query="${queryLabel}": HTTP ${scrapeRes.status}`);
    } catch (e) {
      console.warn(`NEPI S harvest error for "${queryLabel}": ${e.message}`);
    }
    // Fallback: Firecrawl /v1/map
    try {
      const mapRes = await fetch('https://api.firecrawl.dev/v1/map', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${firecrawlKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: mapUrl, search: baseName, limit: 30, ignoreSitemap: true })
      });
      if (!mapRes.ok) return;
      const mapData = await mapRes.json();
      for (const link of (mapData.links || [])) {
        const url = typeof link === 'string' ? link : (link.url || link);
        if (!url || !/ZyActionD|ZyPDF|nepis\.epa\.gov/i.test(url)) continue;
        const title = (typeof link === 'object' && link.title) ? String(link.title) : `EPA NSCEP — ${queryLabel || baseName}`;
        ingestLink(url, title, 'EPA NSCEP', 'firecrawl_nepis_map', 15);
      }
    } catch (e) {
      console.warn(`NEPI S map fallback error: ${e.message}`);
    }
  };

  // ── Phase 1: Firecrawl /v1/map — crawl agency sites for report URLs ──
  // CREDIT BUDGET: skip agency map entirely — the discover step already seeds
  // SCDNR/NCWRC/GADNR lake description and regulations pages, and proxy-download
  // can handle them with basic fetch. Only run NEPIS searches here since they
  // need Firecrawl to harvest ZyActionD links from dynamic search results.
  if (firecrawlKey) {
    const targets = DATASET_HUNT_TARGETS[state] || DATASET_HUNT_TARGETS.SC;
    for (const target of targets) {
      if (!target.isNepis) continue; // skip agency maps — already seeded by discover
      // Run NEPIS queries (capped to 2 variants by buildNepisQueryVariants)
      const variants = buildNepisQueryVariants(lakeName, state);
      for (const q of variants) {
        const mapUrl = buildNepisSearchUrl(lakeName, state, q);
        await harvestNepisSearchPage(mapUrl, q);
      }
    }
  }

  // ── Phase 2: Tavily targeted searches for reports and academic papers ──
  if (tavilyKey) {
    const stateName = { SC: 'South Carolina', NC: 'North Carolina', GA: 'Georgia' }[state] || 'South Carolina';
    const dnrSite = state === 'NC' ? 'site:ncwildlife.org' : state === 'GA' ? 'site:georgiawildlife.com' : 'site:dnr.sc.gov';
    const huntQueries = [
      `\"${baseName}\" creel survey fisheries assessment filetype:pdf`,
      `\"${baseName}\" annual fisheries report ${dnrSite}`,
      // EPA NSCEP — covers both "Report on Lake X" and "Report on X Lake" naming
      `\"Report on Lake ${baseName}\" OR \"Report on ${baseName} Lake\" site:nepis.epa.gov`,
    ];
    for (const q of huntQueries) {
      try {
        const searchRes = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${tavilyKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: q, search_depth: 'basic', max_results: 3, include_raw_content: false })
        });
        if (!searchRes.ok) continue;
        const searchData = await searchRes.json();
        for (const r of (searchData.results || [])) {
          if (!r.url || seenUrls.has(r.url)) continue;
          seenUrls.add(r.url);
          const score = scoreDatasetUrl(r.url, r.title || '', lakeName);
          if (score < 5) continue;
          let authority = 'Web';
          try {
            const host = new URL(r.url).hostname;
            if (/dnr\.sc\.gov/.test(host))        authority = 'SCDNR';
            else if (/ncwildlife\.org/.test(host)) authority = 'NCWRC';
            else if (/georgiawildlife/.test(host)) authority = 'GA DNR';
            else if (/usgs\.gov/.test(host))       authority = 'USGS';
            else if (/usace\.army\.mil/.test(host))authority = 'USACE';
            else if (/nepis\.epa\.gov|epa\.gov/.test(host)) authority = 'EPA NSCEP';
            else if (/edu$/.test(host))            authority = 'Academic';
          } catch (_) {}
          discovered.push({
            url: r.url,
            title: (r.title || '').slice(0, 180),
            type: /\.pdf$/i.test(r.url) || /ZyPDF/i.test(r.url) ? 'PDF' : 'HTML',
            authority,
            source: 'tavily',
            score,
            snippet: (r.content || '').slice(0, 300),
          });
        }
      } catch (e) {
        console.warn(`Tavily dataset hunt failed for [${q}]: ${e.message}`);
      }
    }
  }

  // ── Sort and dedupe by score ──
  discovered.sort((a, b) => b.score - a.score);

  // ── Cache in R2 for 7 days ──
  try {
    const safe = lakeName.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    await env.TROLLMAP_DATA.put(
      `lake_packages/${safe}/dataset_hunt.json`,
      JSON.stringify({ lakeName, state, datasets: discovered, cachedAt: new Date().toISOString() }),
      { expirationTtl: 60 * 60 * 24 * 7 }
    );
  } catch (_) {}

  return new Response(JSON.stringify({
    ok: true,
    lakeName,
    state,
    datasetCount: discovered.length,
    firecrawlUsed: !!firecrawlKey,
    tavilyUsed: !!tavilyKey,
    datasets: discovered,
  }), { headers: JSON_HEADERS });
}
__name(handleResearchDatasetHunt, 'handleResearchDatasetHunt');


function normalizeResearchName(s) {
  return String(s || '').toLowerCase().replace(/&amp;/g, '&').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}
__name(normalizeResearchName, "normalizeResearchName");

function hasResearchValue(v) {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}
__name(hasResearchValue, "hasResearchValue");

function buildEvidence(sourceType, sourceLabel, sourceUrl, quote, method, extra = {}) {
  return { sourceType, sourceLabel, sourceUrl, quote: quote || null, method, ...extra };
}
__name(buildEvidence, "buildEvidence");

function titleCaseWords(s) {
  return String(s || '').split(/\s+/).filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}
__name(titleCaseWords, "titleCaseWords");

const RESEARCH_SPECIES_CANON = {
  'black crappie': 'Black Crappie',
  'white crappie': 'White Crappie',
  'crappie': 'Crappie',
  'striped bass': 'Striped Bass',
  'largemouth bass': 'Largemouth Bass',
  'spotted bass': 'Spotted Bass',
  'smallmouth bass': 'Smallmouth Bass',
  'hybrid bass': 'White Bass / Hybrid',
  'white bass': 'White Bass / Hybrid',
  'white bass hybrid': 'White Bass / Hybrid',
  'striped bass x white bass hybrid': 'White Bass / Hybrid',
  'catfish': 'Catfish',
  'blue catfish': 'Blue Catfish',
  'channel catfish': 'Channel Catfish',
  'flathead catfish': 'Flathead Catfish',
  'bluegill': 'Bluegill',
  'redear sunfish': 'Redear Sunfish (Shellcracker)',
  'shellcracker': 'Redear Sunfish (Shellcracker)',
  'redbreast sunfish': 'Redbreast Sunfish',
  'chain pickerel': 'Chain Pickerel',
  'bowfin': 'Bowfin',
  'yellow perch': 'Yellow Perch',
  'white perch': 'White Perch',
  'threadfin shad': 'Threadfin Shad',
  'gizzard shad': 'Gizzard Shad',
  'blueback herring': 'Blueback Herring',
  'american shad': 'American Shad',
  'trout': 'Trout',
  'rainbow trout': 'Rainbow Trout',
  'brown trout': 'Brown Trout',
  'walleye': 'Walleye',
  'gar': 'Gar',
  'longnose gar': 'Longnose Gar'
};

function canonicalizeResearchSpecies(raw) {
  const n = normalizeResearchName(raw).replace(/\*/g, '').trim();
  if (!n) return null;
  return RESEARCH_SPECIES_CANON[n] || titleCaseWords(n);
}
__name(canonicalizeResearchSpecies, "canonicalizeResearchSpecies");

function uniqueResearchSpecies(items) {
  const out = [];
  const seen = new Set();
  for (const raw of items || []) {
    const s = canonicalizeResearchSpecies(raw);
    if (!s) continue;
    const key = normalizeResearchName(s);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}
__name(uniqueResearchSpecies, "uniqueResearchSpecies");

function splitSpeciesText(text) {
  const cleaned = String(text || '').replace(/\([^)]*\)/g, ' ').replace(/\band\b/gi, ',').replace(/;/g, ',');
  return cleaned.split(',').map(s => s.trim()).filter(Boolean);
}
__name(splitSpeciesText, "splitSpeciesText");

function parseSCDNRDescriptionFacts(lakeName, url, html) {
  const text = stripHtml(html).replace(/\s+/g, ' ').trim();
  const identity = { aliases: [], counties: [] };
  const biology = { primaryForage: [], secondaryForage: [], predatorSpecies: [], speciesAbundance: {}, knownStockings: [], baitfishMovement: null, forageCalendar: {}, notes: [] };
  const habitat = { structuralElements: {}, cover: [], vegetation: [], standingTimber: null, dockDensity: null, artificialHabitat: [], artificialHabitatDetails: { attractorCount: null, attractorTypes: [] }, notes: null };
  const navigation = { ramps: [], hazards: [], notes: null, accessPointCount: null, publicRampCount: null, privateAccessCount: null };
  const evidence = { identity: {}, biology: {}, habitat: {}, navigation: {} };

  const store = (section, field, entry) => {
    if (!evidence[section]) evidence[section] = {};
    if (!evidence[section][field]) evidence[section][field] = [];
    evidence[section][field].push(entry);
  };

  const mArea = text.match(/Acres of Surface Water:\s*([0-9,]+)/i);
  if (mArea) {
    identity.surfaceAreaAcres = parseInt(mArea[1].replace(/,/g, ''), 10) || null;
    store('identity', 'surfaceAreaAcres', buildEvidence('official_document', 'SCDNR Lake Description', url, mArea[0], 'regex_exact_text'));
  }
  // Note: SCDNR description page lists pool elevation as "Maximum Depth" and
  // average river depth as "Average Depth" — both are misleading and not the
  // actual lake depth. Do not parse these fields from this source.
  const mShore = text.match(/Miles of Shoreline:\s*([0-9,]+(?:\.[0-9]+)?)/i);
  if (mShore) {
    identity.shorelineLengthMi = parseFloat(mShore[1].replace(/,/g, ''));
    store('identity', 'shorelineLengthMi', buildEvidence('official_document', 'SCDNR Lake Description', url, mShore[0], 'regex_exact_text'));
  }
  const mCounties = text.match(/Counties Lake is Within:\s*([^*]+?)(?:Average Depth:|Maximum Depth:|Boat Ramps:)/i);
  if (mCounties) {
    identity.counties = mCounties[1].split(',').map(s => s.trim()).filter(Boolean);
    store('identity', 'counties', buildEvidence('official_document', 'SCDNR Lake Description', url, `Counties Lake is Within: ${mCounties[1].trim()}`, 'regex_exact_text'));
  }
  const mOwner = text.match(/Owned and Managed by:\s*([^*]+?)(?:Boat Ramps:|Fish Attractors:|$)/i);
  if (mOwner) {
    identity.reservoirOwner = mOwner[1].replace(/\[[^\]]*\]/g, '').trim().replace(/\s+/g, ' ');
    store('identity', 'reservoirOwner', buildEvidence('official_document', 'SCDNR Lake Description', url, `Owned and Managed by: ${identity.reservoirOwner}`, 'regex_exact_text'));
  }
  const mPool = text.match(/Full pond elevation is\s*([0-9.]+)\s*feet/i);
  if (mPool) {
    identity.normalPoolFt = parseFloat(mPool[1]);
    store('identity', 'normalPoolFt', buildEvidence('official_document', 'SCDNR Lake Description', url, mPool[0], 'regex_exact_text'));
  }
  const mYear = text.match(/created in\s*(\d{4})/i) || text.match(/operation of .*? in\s*(\d{4})/i);
  if (mYear) {
    identity.yearImpounded = parseInt(mYear[1], 10);
    store('identity', 'yearImpounded', buildEvidence('official_document', 'SCDNR Lake Description', url, mYear[0], 'regex_exact_text'));
  }
  const mDam = text.match(/The\s+([A-Z][A-Za-z0-9\- ]+? Dam)\s+is\s+[0-9,]+\s+feet\s+long/i);
  if (mDam) {
    identity.damName = mDam[1].trim();
    store('identity', 'damName', buildEvidence('official_document', 'SCDNR Lake Description', url, mDam[0], 'regex_exact_text'));
  }
  const mRiver = text.match(/largest of the ([A-Za-z\- ]+?) lakes/i) || text.match(/upper most of the two beautiful water bodies that comprise ([A-Za-z\- ]+?) reservoir/i);
  if (mRiver) {
    identity.riverSystem = mRiver[1].trim();
    store('identity', 'riverSystem', buildEvidence('official_document', 'SCDNR Lake Description', url, mRiver[0], 'regex_exact_text'));
  }
  const mArchetype = text.match(/([0-9,]+ acre [a-z\- ]+ reservoir)/i);
  if (mArchetype) {
    identity.archetype = mArchetype[1].trim();
    store('identity', 'archetype', buildEvidence('official_document', 'SCDNR Lake Description', url, mArchetype[0], 'regex_exact_text'));
  }

  const mSport = text.match(/Popular sport fish on .*? include ([^.]+)\./i) || text.match(/best known for its ([^.]+?) fishery but it serves host to ([^.]+?)\./i);
  if (mSport) {
    const speciesText = mSport[1] + (mSport[2] ? ', ' + mSport[2] : '');
    biology.predatorSpecies = uniqueResearchSpecies(splitSpeciesText(speciesText));
    if (biology.predatorSpecies.length) {
      store('biology', 'predatorSpecies', buildEvidence('official_document', 'SCDNR Lake Description', url, mSport[0], 'regex_exact_text'));
    }
  }
  const mStock = text.match(/stocks? ([a-z ]+?) regularly/i);
  if (mStock) {
    const stocked = canonicalizeResearchSpecies(mStock[1]);
    if (stocked) {
      biology.knownStockings = [{ species: stocked, agency: 'SCDNR', note: 'Stocked regularly' }];
      store('biology', 'knownStockings', buildEvidence('official_document', 'SCDNR Lake Description', url, mStock[0], 'regex_exact_text'));
    }
  }

  const mAttr = text.match(/Fish Attractors:\s*([0-9,]+)/i);
  if (mAttr) {
    habitat.artificialHabitat = ['SCDNR fish attractors'];
    habitat.artificialHabitatDetails.attractorCount = parseInt(mAttr[1].replace(/,/g, ''), 10) || null;
    const note = `${habitat.artificialHabitatDetails.attractorCount} official SCDNR fish attractors listed on the lake page.`;
    habitat.notes = habitat.notes ? `${habitat.notes} ${note}` : note;
    store('habitat', 'artificialHabitatDetails', buildEvidence('official_document', 'SCDNR Lake Description', url, mAttr[0], 'regex_exact_text'));
  }
  const mRamps = text.match(/Boat Ramps:\s*([0-9,]+)/i);
  if (mRamps) {
    navigation.accessPointCount = parseInt(mRamps[1].replace(/,/g, ''), 10) || null;
    store('navigation', 'accessPointCount', buildEvidence('official_document', 'SCDNR Lake Description', url, mRamps[0], 'regex_exact_text'));
  }
  const mAccess = text.match(/There are\s*([0-9]+) access points in the Lake/i);
  if (mAccess) {
    navigation.accessPointCount = parseInt(mAccess[1], 10) || navigation.accessPointCount || null;
    store('navigation', 'accessPointCount', buildEvidence('official_document', 'SCDNR Lake Description', url, mAccess[0], 'regex_exact_text'));
  }
  const mPublicPrivate = text.match(/maintain\s*([a-z0-9]+) public boat access areas.*?Five are privately owned and operated/i);
  if (mPublicPrivate) {
    const n = parseInt(String(mPublicPrivate[1]).replace(/[^0-9]/g, ''), 10);
    if (isFinite(n)) navigation.publicRampCount = n;
    navigation.privateAccessCount = 5;
    store('navigation', 'publicRampCount', buildEvidence('official_document', 'SCDNR Lake Description', url, mPublicPrivate[0], 'regex_exact_text'));
  }

  return { identity, biology, habitat, navigation, evidence, sources: [{ label: 'SCDNR Lake Description', url, trust: 'OFFICIAL', sourceType: 'official_document' }] };
}
__name(parseSCDNRDescriptionFacts, "parseSCDNRDescriptionFacts");

const RESEARCH_RAMP_SOURCES = {
  SC: {
    url: "https://services.arcgis.com/acgZYxoN5Oj8pDLa/arcgis/rest/services/South_Carolina_Public_Water_Access_PUBLIC_VIEW/FeatureServer/0/query",
    label: 'SCDNR South Carolina Public Water Access',
    idField: 'OBJECTID',
    filter: (p) => p.WaterAccessType === 'Boat Ramp' && String(p.Status || '').toLowerCase() === 'active' && String(p.PublicAccess || '').toLowerCase() !== 'closed',
    name: (p) => p.WaterAccessName,
    wb: (p) => p.Waterbody,
    lat: (p) => p.Latitude,
    lon: (p) => p.Longitude,
    meta: (p) => ({ lanes: p.LaunchLanes, dock: p.CourtesyDock, fee: false, species: p.SpeciesList, county: p.County, owner: p.Owner, comments: p.Comments })
  },
  GA: {
    url: "https://services6.arcgis.com/9QlSLDqa0P1cHLhu/arcgis/rest/services/WRD_Water_Access_Points/FeatureServer/0/query",
    label: 'Georgia DNR WRD Water Access Points',
    idField: 'FID',
    filter: (p) => String(p.Ramp || '').toUpperCase() === 'Y' && !['closed', 'inactive'].includes(String(p.Status || '').toLowerCase()),
    name: (p) => p.Name,
    wb: (p) => p.Waterbody,
    lat: (p) => p.Latitude,
    lon: (p) => p.Longitude,
    meta: (p) => ({ lanes: p.NumLanes, dock: p.Dock, fee: String(p.Fee || '').toUpperCase() === 'Y', species: p.SpeciesList || '', county: p.County, owner: p.Owner, motorRestrictions: p.MotorRest })
  },
  NC: {
    url: "https://services1.arcgis.com/YfqBAUM5nWR3yhGP/arcgis/rest/services/NCWRC_Boating_Access_Areas_view/FeatureServer/0/query",
    label: 'NC Wildlife Resources Commission Boating Access Areas',
    idField: 'OBJECTID',
    filter: (p) => !String(p.Site_Status || 'OPEN').toUpperCase().includes('CLOSED'),
    name: (p) => p.BAA_Name,
    wb: (p) => p.Water_Access || p.BAA_Alias,
    lat: (p) => p.Latitude,
    lon: (p) => p.Longitude,
    meta: (p) => ({ lanes: p.Launch_Lane_No, dock: p.Courtesy_Dock_No || p.Fix_Dock_No, fee: false, species: '', county: p.County, owner: p.Owner, motorRestrictions: p.Motorboats_Restricted })
  }
};

const RESEARCH_ATTRACTOR_SOURCES = {
  SC: {
    url: "https://services.arcgis.com/acgZYxoN5Oj8pDLa/arcgis/rest/services/SCDNR_Freshwater_Fish_Attractors_Public_Web_App/FeatureServer/0/query",
    label: 'SCDNR Freshwater Fish Attractors',
    idField: 'OBJECTID',
    filter: () => true,
    name: (p) => p.FishAttractorName,
    wb: (p) => p.Waterbody,
    lat: (p) => p.lat_dd,
    lon: (p) => p.lon_dd,
    type: (p) => p.Material
  },
  GA: {
    url: "https://services6.arcgis.com/9QlSLDqa0P1cHLhu/arcgis/rest/services/Fish_Attractors_for_Download/FeatureServer/0/query",
    label: 'Georgia DNR Fish Attractors',
    idField: 'OBJECTID',
    filter: () => true,
    name: (p) => p.note,
    wb: (p) => p.waterbody,
    lat: () => null,
    lon: () => null,
    type: (p) => `${p.attractor_code || ''} ${p.attractor_code_other || ''}`.trim()
  },
  NC: {
    url: "https://services1.arcgis.com/YfqBAUM5nWR3yhGP/arcgis/rest/services/Fish_Attractors_public_view/FeatureServer/0/query",
    label: 'NC WRC Fish Attractors',
    idField: 'OBJECTID',
    filter: () => true,
    name: (p) => `${p.Waterbody} Attractor`,
    wb: (p) => p.Waterbody,
    lat: (p) => p.Latitude,
    lon: (p) => p.Longitude,
    type: (p) => `${p.Structure1 || ''} ${p.Structure2 || ''}`.trim() || p.Attractor_Type
  }
};

async function fetchArcGISGrouped(env, cacheKey, sourceDef, buildRecord) {
  try {
    const cached = await env.R2_TROLLMAP_CHARTPACKS.get(cacheKey);
    if (cached) {
      const txt = await cached.text();
      return JSON.parse(txt);
    }
  } catch (_) {}
  const allFeatures = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const params = new URLSearchParams({ outFields: '*', where: '1=1', f: 'geojson', resultOffset: offset, resultRecordCount: pageSize, orderByFields: sourceDef.idField || 'OBJECTID' });
    const resp = await fetch(`${sourceDef.url}?${params.toString()}`, { headers: { 'User-Agent': 'TrollMap/1.0 (Cloudflare Worker)', 'Accept': 'application/json' }, cf: { cacheTtl: 0 } });
    if (!resp.ok) throw new Error(`ArcGIS HTTP ${resp.status}`);
    const data = await resp.json();
    const features = data.features || [];
    allFeatures.push(...features);
    if (features.length < pageSize) break;
    offset += pageSize;
  }
  const waterbodies = {};
  for (const feat of allFeatures) {
    const p = feat.properties || {};
    if (!sourceDef.filter(p)) continue;
    const wb = String(sourceDef.wb(p) || 'Unknown').trim();
    const rec = buildRecord(feat, p);
    if (!rec) continue;
    if (!waterbodies[wb]) waterbodies[wb] = [];
    waterbodies[wb].push(rec);
  }
  const result = { waterbodies };
  try {
    await env.R2_TROLLMAP_CHARTPACKS.put(cacheKey, JSON.stringify(result), { httpMetadata: { contentType: 'application/json' }, customMetadata: { fetchedAt: new Date().toISOString() } });
  } catch (_) {}
  return result;
}
__name(fetchArcGISGrouped, "fetchArcGISGrouped");

function waterbodyMatchesLake(lakeName, waterbodyName) {
  const a = normalizeResearchName(lakeName).replace(/^lake /, '');
  const b = normalizeResearchName(waterbodyName).replace(/^lake /, '');
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
}
__name(waterbodyMatchesLake, "waterbodyMatchesLake");


function stripHtmlPreserveTables(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<li>/gi, '• ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
__name(stripHtmlPreserveTables, "stripHtmlPreserveTables");

function extractHtmlTableRows(html) {
  const rows = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(String(html || '')))) {
    const rowHtml = rowMatch[1];
    const cellRe = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
    const cells = [];
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowHtml))) {
      const txt = stripHtmlPreserveTables(cellMatch[1]).replace(/\s+/g, ' ').trim();
      if (txt) cells.push(txt);
    }
    if (cells.length >= 2) rows.push(cells);
  }
  return rows;
}
__name(extractHtmlTableRows, "extractHtmlTableRows");

// Parse markdown pipe-delimited tables (from Firecrawl/normalized text)
// Firecrawl and basic HTML strippers often flatten multi-row tables into ONE long line
// with empty cells between rows:  | a | b | c | d | | e | f | g | h |
// The previous regex walked that line greedily and misaligned columns, so eRegulations
// tables produced garbage rows and zero usable length/creel limits.
function extractMarkdownTableRows(text) {
  const rows = [];
  const str = String(text || '');
  if (!str.includes('|')) return rows;

  // 1) Primary path: insert newlines at empty-cell row separators, then parse lines
  const normalized = str
    .replace(/\|\s*\|/g, '|\n|')          // empty cell between rows → newline
    .replace(/\r\n/g, '\n');

  for (const line of normalized.split('\n')) {
    if (!line.includes('|')) continue;
    // Keep empty trailing cells so 4-col alignment survives; only trim each cell
    let cells = line.split('|').map(c => c.replace(/\s+/g, ' ').trim());
    // Drop leading/trailing empties created by edge pipes
    if (cells.length && cells[0] === '') cells = cells.slice(1);
    if (cells.length && cells[cells.length - 1] === '') cells = cells.slice(0, -1);
    if (!cells.length) continue;
    // Separator / spacer rows
    if (cells.every(c => !c || /^[-:\s]+$/.test(c))) continue;
    // Header-ish single-label rows (section titles spanning the table)
    if (cells.length === 1) continue;
    // Prefer 4-column regulation rows; pad shorter rows, truncate longer
    if (cells.length >= 4) {
      rows.push(cells.slice(0, 4));
    } else if (cells.length === 3) {
      rows.push([...cells, '']);
    } else if (cells.length === 2 && cells[0] && cells[1]) {
      rows.push([cells[0], cells[1], '', '']);
    }
  }

  // 2) Fallback: non-overlapping 4-cell regex if still empty (defensive)
  if (rows.length === 0) {
    const rowRe = /\|([^|\n]{1,500})\|([^|\n]{1,500})\|([^|\n]{1,500})\|([^|\n]{1,500})\|/g;
    let m;
    let pos = 0;
    while ((m = rowRe.exec(str)) !== null) {
      // Advance past this match without re-consuming the trailing |
      if (m.index < pos) continue;
      const cells = [m[1].trim(), m[2].trim(), m[3].trim(), m[4].trim()];
      pos = m.index + m[0].length - 1;
      if (!cells[0] && !cells[1]) continue;
      if (cells.every(c => !c || /^[-:\s]+$/.test(c))) continue;
      rows.push(cells);
      rowRe.lastIndex = pos;
    }
  }
  return rows;
}
__name(extractMarkdownTableRows, "extractMarkdownTableRows");

function lakeMentionedInCell(lakeName, cellText) {
  // Strip state suffix (", SC" etc) and "Lake" prefix before matching
  const cleanName = String(lakeName || '').replace(/,\s*(SC|NC|GA|TN)\s*$/i, '').trim();
  const lake = normalizeResearchName(cleanName).replace(/^lake /, '').trim();
  const cell = normalizeResearchName(cellText);
  if (!lake || !cell) return false;
  // Use base lake name (e.g. "wateree") for matching
  const baseLake = lake.split(' ')[0];
  if (!baseLake) return false;
  // Reject dam/map/tailwater mentions that share the lake's name
  // ("Wateree Dam", "below Wateree Dam") — those are not the reservoir itself
  if (new RegExp(`\\b${baseLake}\\s+dam\\b`).test(cell)) return false;
  if (/\btailwater\b|\briver system\b|\breach\b/.test(cell) && !new RegExp(`\\blake\\s+${baseLake}\\b`).test(cell) && !cell.includes(`lakes `) /* multi-lake lists use "Lakes A, B, Wateree" */) {
    // Allow multi-lake exception lists like "Lakes Blalock, Greenwood, ..., Wateree, Wylie"
    // which contain the base name as a listed lake, not as a dam/system label
    const multiLakeList = /\blakes?\b/.test(cell) && cell.includes(baseLake);
    if (!multiLakeList) return false;
  }
  // Multi-lake lists: "Lakes Blalock, Greenwood, Jocassee, ..., Wateree, Wylie"
  if (cell.includes(baseLake)) return true;
  if (cell.includes(lake)) return true;
  return false;
}
__name(lakeMentionedInCell, "lakeMentionedInCell");

function parseSCRegulationsFromHtml(lakeName, regsUrl, html, lakeSpecificHtml = '') {
  let rows = extractHtmlTableRows(html);
  // Fall back to markdown table parser if HTML parser found nothing
  // (normalized eRegulations docs are Firecrawl markdown / stripped text, not raw HTML)
  if (!rows.length) rows = extractMarkdownTableRows(html);
  const regs = {
    state: 'SC',
    lastUpdated: null,
    generalStateRegulations: { lengthLimits: {}, creelLimits: {} },
    lakeSpecificRegulations: { hasExceptions: null, creelLimits: {}, sizeLimits: {}, specialRules: [], closedSeasons: [] },
    notes: 'Always verify exact lake exceptions at official agency site before fishing.'
  };
  const evidence = { regulations: {} };
  const addEvidence = (field, quote, method='table_row') => {
    evidence.regulations[field] = (evidence.regulations[field] || []).concat([buildEvidence('official_document', 'SCDNR / eRegulations', regsUrl, quote, method)]);
  };

  const plain = stripHtmlPreserveTables(html);
  const mUpdated = plain.match(/Last Updated:\s*([A-Za-z]+\s+\d{1,2},\s*\d{4})/i);
  if (mUpdated) {
    regs.lastUpdated = mUpdated[1].trim();
    addEvidence('lastUpdated', mUpdated[0], 'regex_exact_text');
  }

  const isHeaderRow = (waterBody, fish) => {
    const w = normalizeResearchName(waterBody);
    const f = normalizeResearchName(fish);
    return w === 'water body' || f === 'fish' || w === 'size limit' || f === 'size limit';
  };

  for (const row of rows) {
    const cells = row.map(c => String(c || '').replace(/\s+/g, ' ').trim());
    if (cells.length < 4) continue;
    const [waterBody, fish, size, limit] = cells;
    if (!waterBody || !fish) continue;
    if (isHeaderRow(waterBody, fish)) continue;
    // Skip seasonal continuation rows that got misaligned (size looks like a date range with no water body species)
    if (/^(june|july|aug|sept|oct|nov|dec|jan|feb|mar|apr|may)\b/i.test(waterBody) && !/bass|catfish|crappie|bream|sunfish|perch|pickerel|walleye|eel/i.test(fish)) {
      continue;
    }

    const fishNorm = normalizeResearchName(fish);
    const waterNorm = normalizeResearchName(waterBody);

    const applyGeneral = (speciesName, sizeValue, limitValue) => {
      if (sizeValue) regs.generalStateRegulations.lengthLimits[speciesName] = sizeValue;
      if (limitValue) regs.generalStateRegulations.creelLimits[speciesName] = limitValue;
      addEvidence(`general.${speciesName}`, `${waterBody} | ${fish} | ${size} | ${limit}`);
    };
    const applyLakeSpecific = (speciesName, sizeValue, limitValue) => {
      regs.lakeSpecificRegulations.hasExceptions = true;
      if (sizeValue) regs.lakeSpecificRegulations.sizeLimits[speciesName] = sizeValue;
      if (limitValue) regs.lakeSpecificRegulations.creelLimits[speciesName] = limitValue;
      addEvidence(`lakeSpecific.${speciesName}`, `${waterBody} | ${fish} | ${size} | ${limit}`);
    };

    // Statewide game/nongame species (exact or starts-with statewide)
    if (waterNorm === 'statewide' || waterNorm.startsWith('statewide ')) {
      if (fishNorm === 'crappie') applyGeneral('Crappie', size, limit);
      if (fishNorm.includes('bream')) applyGeneral('Bream', size, limit);
      if (fishNorm === 'redbreast sunfish') applyGeneral('Redbreast Sunfish', size, limit);
      if (fishNorm === 'chain pickerel') applyGeneral('Chain Pickerel', size, limit);
      if (fishNorm === 'redfin pickerel') applyGeneral('Redfin Pickerel', size, limit);
      if (fishNorm.includes('yellow perch')) applyGeneral('Yellow Perch', size, limit);
      if (fishNorm === 'blue catfish') applyGeneral('Blue Catfish', size, limit);
      if (fishNorm === 'american eel') applyGeneral('American Eel', size, limit);
      if (fishNorm.includes('walleye') || fishNorm.includes('sauger')) applyGeneral('Walleye / Sauger', size, limit);
      if (fishNorm === 'white bass') applyGeneral('White Bass', size, limit);
      if (fishNorm === 'smallmouth bass' && waterNorm.startsWith('statewide except')) applyGeneral('Smallmouth Bass', size, limit);
      if (fishNorm.includes('redeye') && waterNorm.startsWith('statewide except')) applyGeneral('Redeye Bass', size, limit);
      if (fishNorm === 'spotted bass' && waterNorm.startsWith('statewide except')) applyGeneral('Spotted Bass', size, limit);
    }

    if (waterNorm.startsWith('statewide except the water bodies listed below') && fishNorm === 'largemouth bass') {
      applyGeneral('Largemouth Bass', size, limit);
    }
    // Lake-specific largemouth (Wateree is listed in the 14" exception group)
    if (lakeMentionedInCell(lakeName, waterBody) && fishNorm === 'largemouth bass') {
      applyLakeSpecific('Largemouth Bass', size, limit);
    }
    // Other lake-specific black bass exceptions
    if (lakeMentionedInCell(lakeName, waterBody) && (fishNorm === 'smallmouth bass' || fishNorm.includes('redeye') || fishNorm === 'spotted bass')) {
      const speciesName = fishNorm === 'smallmouth bass' ? 'Smallmouth Bass'
        : fishNorm.includes('redeye') ? 'Redeye Bass'
        : 'Spotted Bass';
      applyLakeSpecific(speciesName, size, limit);
    }
  }

  // Striper / hybrid rows need multi-row handling because closures/season text split across rows.
  //
  // CRITICAL: Exception rows are waterbody-specific. Do NOT map "Santee River system",
  // "Wateree Dam" map captions, Cooper River, or other river/tailwater rows onto a lake
  // just because the lake name appears nearby (e.g. Wateree Dam on the Santee system map).
  // Lake Wateree the RESERVOIR is NOT listed as a striper exception — statewide applies.
  // Lakes that ARE listed by name (Murray, Russell, Hartwell, Thurmond, etc.) get those rows.
  const striperRows = rows.filter(r => {
    const f = normalizeResearchName(r[1] || '');
    return f.includes('striped or hybrid') || f.includes('striped hybrid or white') || f.includes('striped bass');
  });
  // Typo on the live page: "list below" (missing 'ed') — match both forms
  const statewideStriper = striperRows.find(r => {
    const w = normalizeResearchName(r[0] || '');
    return w.startsWith('statewide except the water bodies list below')
      || w.startsWith('statewide except the water bodies listed below')
      || (w.startsWith('statewide except') && !lakeMentionedInCell(lakeName, r[0] || ''));
  });
  if (statewideStriper && statewideStriper.length >= 4) {
    regs.generalStateRegulations.lengthLimits['Striped Bass / Hybrid'] = statewideStriper[2];
    regs.generalStateRegulations.creelLimits['Striped Bass / Hybrid'] = statewideStriper[3];
    addEvidence('general.Striped Bass / Hybrid', statewideStriper.join(' | '));
  }

  // Lake-specific striper ONLY when the waterbody CELL explicitly names this lake
  // (e.g. "Lake Murray", "Lake Russell", "Lake Hartwell & Lake Thurmond").
  // Reject river/system/tailwater/map rows — those are not the reservoir.
  // Note: multi-lake exception lists like "Lakes Blalock, ..., Wateree, Wylie and the
  // middle reach of the Saluda..." still count as lake lists (they start with "Lakes").
  const isRiverOrSystemRow = (waterBody) => {
    const w = String(waterBody || '');
    // Multi-lake lists are reservoir exceptions, not river rows (even if they also
    // mention a river reach at the end of the list)
    if (/^\s*Lakes?\b/i.test(w)) return false;
    // Explicit river / system / reach / tailwater language
    if (/\briver system\b|\btailwater\b|\breach\b|\bbackwaters of\b|\bconfluence\b/i.test(w)) return true;
    // "X River" without "Lake X" as the subject
    if (/\b[A-Za-z]+ River\b/i.test(w) && !/\bLakes?\s+[A-Za-z]/i.test(w)) return true;
    // Coastal river laundry-list rows
    if (/Ashepoo|Waccamaw|Pee Dee|Edisto|Combahee|Cooper River/i.test(w) && !/\bLake\b/i.test(w)) return true;
    return false;
  };
  const lakeSpecificStriper = striperRows.find(r => {
    const waterBody = r[0] || '';
    if (isRiverOrSystemRow(waterBody)) return false;
    // Require the lake name to appear as a listed waterbody, not as a dam/map label
    return lakeMentionedInCell(lakeName, waterBody);
  });
  if (lakeSpecificStriper && lakeSpecificStriper.length >= 4) {
    regs.lakeSpecificRegulations.hasExceptions = true;
    regs.lakeSpecificRegulations.sizeLimits['Striped Bass / Hybrid'] = lakeSpecificStriper[2];
    regs.lakeSpecificRegulations.creelLimits['Striped Bass / Hybrid'] = lakeSpecificStriper[3];
    addEvidence('lakeSpecific.Striped Bass / Hybrid', lakeSpecificStriper.join(' | '));
  }
  // When the lake is NOT on any striper exception row, statewide is what applies on the lake.
  // Mirror statewide into lake-applicable convenience fields WITHOUT marking hasExceptions
  // for striper (LMB or other exceptions may still set hasExceptions).
  if (!lakeSpecificStriper && statewideStriper && statewideStriper.length >= 4) {
    // Do not put statewide into lakeSpecific size/creel maps as if it were an exception —
    // keep it only under generalStateRegulations. Flattened lengthLimits/creelLimits below
    // still surface the statewide rule for UI convenience.
    regs.notes = (regs.notes || '') +
      ' Striped bass/hybrid: this waterbody is not listed as a striper exception on eRegulations; statewide rule applies on the lake. River/tailwater rows (e.g. Santee River system) do not apply to the reservoir.';
  }

  // Lake-specific SCDNR regs page (static HTML) — e.g. 14" largemouth at Wateree
  const lakePlain = stripHtmlPreserveTables(lakeSpecificHtml || '');
  const mLmb = lakePlain.match(/no largemouth bass less than\s*([0-9]+)\s*inches/i);
  if (mLmb) {
    regs.lakeSpecificRegulations.hasExceptions = true;
    regs.lakeSpecificRegulations.sizeLimits['Largemouth Bass'] = `${mLmb[1]} inches min`;
    addEvidence('lakeSpecific.Largemouth Bass', mLmb[0], 'regex_exact_text');
  }
  // Nongame device limits from lake regs page
  if (/trotlines/i.test(lakePlain) || /traps/i.test(lakePlain)) {
    const deviceNote = lakePlain.match(/Allowable Nongame Devices[\s\S]{0,400}/i);
    if (deviceNote) {
      regs.lakeSpecificRegulations.specialRules = regs.lakeSpecificRegulations.specialRules || [];
      const note = deviceNote[0].replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!regs.lakeSpecificRegulations.specialRules.includes(note)) {
        regs.lakeSpecificRegulations.specialRules.push(note);
        addEvidence('lakeSpecific.specialRules', note, 'regex_exact_text');
      }
    }
  }

  // Closed seasons: ONLY from a striper exception row that actually names THIS lake.
  // Do not attach Santee River system / coastal river summer closures to unlisted lakes.
  if (lakeSpecificStriper) {
    const lakeStriperText = lakeSpecificStriper.join(' | ');
    // Also scan the next raw striper continuation rows only if they share the same waterbody start
    // (season splits like "June 1 - Sept. 30: any length" sometimes land in adjacent cells)
    const closureMatch = lakeStriperText.match(/June\s*1[56]\s*[-–]\s*Sept\.?\s*30[^.|]{0,40}closed/i)
      || lakeStriperText.match(/closed\s*(?:to\s*(?:the\s*)?taking|season)?[^.|]{0,40}June\s*1[56]/i);
    if (closureMatch) {
      const already = (regs.lakeSpecificRegulations.closedSeasons || []).some(c => /June\s*1[56]/i.test(c.period || ''));
      if (!already) {
        regs.lakeSpecificRegulations.closedSeasons.push({
          species: 'Striped Bass / Hybrid',
          period: 'June 16 - Sept. 30',
          note: `Closed per eRegulations exception row for ${String(lakeSpecificStriper[0] || '').slice(0, 80)}`
        });
        addEvidence('lakeSpecific.closedSeasons', closureMatch[0], 'regex_exact_text');
      }
    }
  }

  // Flatten convenience fields for UI/back-compat
  regs.lengthLimits = { ...regs.generalStateRegulations.lengthLimits, ...regs.lakeSpecificRegulations.sizeLimits };
  regs.creelLimits = { ...regs.generalStateRegulations.creelLimits, ...regs.lakeSpecificRegulations.creelLimits };

  return { regulations: regs, evidence, sources: [{ label: 'SCDNR / eRegulations', url: regsUrl, trust: 'OFFICIAL', sourceType: 'official_document' }] };
}
__name(parseSCRegulationsFromHtml, "parseSCRegulationsFromHtml");

async function getRampSpeciesFacts(env, lakeName, state) {
  const sourceDef = RESEARCH_RAMP_SOURCES[state];
  if (!sourceDef) return null;
  const data = await fetchArcGISGrouped(env, `ramps/${String(state).toLowerCase()}/ramps.json`, sourceDef, (feat, p) => {
    const lat = parseFloat(sourceDef.lat(p));
    const lon = parseFloat(sourceDef.lon(p));
    if (!isFinite(lat) || !isFinite(lon)) return null;
    return { name: String(sourceDef.name(p) || 'Unknown').trim(), lat, lon, ...sourceDef.meta(p) };
  });
  const matches = Object.entries(data.waterbodies || {}).filter(([wb]) => waterbodyMatchesLake(lakeName, wb));
  if (!matches.length) return null;
  const ramps = matches.flatMap(([, arr]) => arr || []);
  const predatorSpecies = uniqueResearchSpecies(ramps.flatMap(r => splitSpeciesText(r.species || '')));
  return { ramps, predatorSpecies, sourceLabel: sourceDef.label };
}
__name(getRampSpeciesFacts, "getRampSpeciesFacts");

async function getAttractorFacts(env, lakeName, state) {
  const sourceDef = RESEARCH_ATTRACTOR_SOURCES[state];
  if (!sourceDef) return null;
  const data = await fetchArcGISGrouped(env, `attractors/${String(state).toLowerCase()}/attractors.json`, sourceDef, (feat, p) => {
    const lat = parseFloat(sourceDef.lat(p) || feat.geometry?.coordinates?.[1]);
    const lon = parseFloat(sourceDef.lon(p) || feat.geometry?.coordinates?.[0]);
    if (!isFinite(lat) || !isFinite(lon)) return null;
    return { name: String(sourceDef.name(p) || 'Attractor').trim(), lat, lon, type: String(sourceDef.type(p) || 'Unknown').trim() };
  });
  const matches = Object.entries(data.waterbodies || {}).filter(([wb]) => waterbodyMatchesLake(lakeName, wb));
  if (!matches.length) return null;
  const attractors = matches.flatMap(([, arr]) => arr || []);
  const typeCounts = {};
  for (const a of attractors) {
    const t = a.type || 'Unknown';
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  }
  return { attractors, typeCounts, sourceLabel: sourceDef.label };
}
__name(getAttractorFacts, "getAttractorFacts");

function buildFactualSummary(profile) {
  const parts = [];
  const id = profile.identity || {};
  const bio = profile.biology || {};
  const lim = profile.limnology || {};
  const hab = profile.habitat || {};
  if (id.archetype || id.surfaceAreaAcres || id.maxDepthFt) {
    parts.push(`${profile.lakeName} ${id.archetype ? `is a ${String(id.archetype).toLowerCase()}` : 'is a reservoir/lake'}${id.surfaceAreaAcres ? ` with about ${Number(id.surfaceAreaAcres).toLocaleString()} surface acres` : ''}${id.maxDepthFt ? ` and a maximum depth near ${id.maxDepthFt} feet` : ''}.`);
  }
  if (bio.predatorSpecies?.length) {
    parts.push(`Confirmed sport fish documented for this waterbody include ${bio.predatorSpecies.join(', ')}${bio.knownStockings?.length ? `; documented stocking notes include ${bio.knownStockings.map(s => s.species).join(', ')}` : ''}.`);
  }
  if (hasResearchValue(lim.surfaceWater) || lim.waterClarity?.secchiFt || lim.thermocline?.summerDepthFt) {
    const limBits = [];
    if (lim.waterClarity?.secchiFt) limBits.push(`Secchi clarity around ${lim.waterClarity.secchiFt} ft when observed`);
    if (lim.surfaceWater?.recentTempF != null) limBits.push(`recent surface water about ${lim.surfaceWater.recentTempF}°F`);
    if (lim.surfaceWater?.recentDissolvedOxygenMgL != null) limBits.push(`recent surface dissolved oxygen about ${lim.surfaceWater.recentDissolvedOxygenMgL} mg/L`);
    if (lim.thermocline?.summerDepthFt) limBits.push(`summer thermocline near ${Array.isArray(lim.thermocline.summerDepthFt) ? lim.thermocline.summerDepthFt.join('-') : lim.thermocline.summerDepthFt} ft`);
    if (limBits.length) parts.push(`Available limnology data indicate ${limBits.join('; ')}.`);
  }
  const attrCount = hab.artificialHabitatDetails?.attractorCount;
  if (attrCount || hab.cover?.length || hab.notes) {
    const habBits = [];
    if (attrCount) habBits.push(`${attrCount} mapped fish attractors`);
    if (hab.cover?.length) habBits.push(`cover includes ${hab.cover.slice(0, 4).join(', ')}`);
    if (habBits.length) parts.push(`Habitat facts currently confirm ${habBits.join('; ')}.`);
  }
  return parts.join(' ').trim() || null;
}
__name(buildFactualSummary, "buildFactualSummary");

async function handleResearchDeterministicFacts(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || body.lake || '').trim();
  const state = String(body.state || 'SC').trim().toUpperCase();
  if (!lakeName) return new Response(JSON.stringify({ ok: false, error: 'missing lakeName' }), { status: 400, headers: JSON_HEADERS });

  const profile = {
    lakeName,
    state,
    identity: { aliases: [], counties: [] },
    biology: { primaryForage: [], secondaryForage: [], predatorSpecies: [], speciesAbundance: {}, knownStockings: [], baitfishMovement: null, forageCalendar: {}, notes: [] },
    limnology: { waterClarity: { typical: null, color: null, secchiFt: null, note: null }, surfaceWater: {}, thermocline: { summerDepthFt: null, method: null, note: null }, oxygen: { depletionDepthFt: null, anoxicBelowFt: null, note: null }, trophicStatus: null, flowCharacteristics: null, seasonalDrawdownFt: null },
    habitat: { structuralElements: {}, cover: [], vegetation: [], standingTimber: null, dockDensity: null, artificialHabitat: [], artificialHabitatDetails: { attractorCount: null, attractorTypes: [] }, notes: null },
    navigation: { ramps: [], hazards: [], notes: null },
    regulations: { state, generalStateRegulations: { lengthLimits: {}, creelLimits: {} }, lakeSpecificRegulations: { hasExceptions: null, creelLimits: {}, sizeLimits: {}, specialRules: [], closedSeasons: [] }, notes: null },
    summary: { text: null, keywords: [] },
    evidence: { identity: {}, biology: {}, limnology: {}, habitat: {}, navigation: {}, regulations: {}, summary: {} },
    sources: []
  };

  const mergeEvidence = (section, field, entries) => {
    if (!entries?.length) return;
    if (!profile.evidence[section]) profile.evidence[section] = {};
    profile.evidence[section][field] = (profile.evidence[section][field] || []).concat(entries);
  };

  // Deterministic extraction from cached normalized documents. Scientific tables are
  // especially easy for an LLM to misalign, so parse high-value measurements and
  // explicit prose directly before any extracted LLM facts are merged on the client.
  try {
    const slug = lakeKeyFromName(lakeName);
    const candidateKeys = [
      `lake_packages/${sanitizeLakeId(lakeName)}/normalized_documents.json`,
      `lake_packages/${sanitizeLakeId('Lake ' + slug)}/normalized_documents.json`,
      `lake_packages/${sanitizeLakeId(slug)}/normalized_documents.json`,
      `lake_packages/lake_${slug}_${state.toLowerCase()}/normalized_documents.json`,
    ];
    let normalizedDocs = [];
    let normalizedKey = null;
    const seenKeys = new Set();
    for (const key of candidateKeys) {
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const obj = await env.R2_TROLLMAP_CHARTPACKS.get(key);
      if (!obj) continue;
      const docs = JSON.parse(await obj.text());
      if (!Array.isArray(docs) || !docs.length) continue;
      normalizedDocs = docs;
      normalizedKey = key;
      break;
    }

    if (normalizedDocs.length) {
      const docText = (doc) => String(doc?.fullText || doc?.text || '');
      const docIdentity = (doc) => `${doc?.title || ''} ${doc?.authority || ''} ${doc?.url || ''}`;
      const epaDocs = normalizedDocs.filter(d => /\bEPA\b|NSCEP|NEPIS|nepis\.epa\.gov/i.test(docIdentity(d)));
      const anglersDocs = normalizedDocs.filter(d => /Angler(?:'|&#39;)?s Headquarters|anglersheadquarters\.com/i.test(docIdentity(d)));
      const scdnrDocs = normalizedDocs.filter(d => /\bSCDNR\b|dnr\.sc\.gov\/lakes\//i.test(docIdentity(d)));
      const findMatch = (docs, regex) => {
        for (const doc of docs) {
          const match = docText(doc).match(regex);
          if (match) return { doc, match };
        }
        return null;
      };
      const addCachedEvidence = (section, field, found, quote = null) => {
        if (!found) return;
        const { doc, match } = found;
        const label = doc.title || doc.authority || 'Cached normalized document';
        const url = doc.url || `r2:${normalizedKey}`;
        const isOfficial = /\bEPA\b|NSCEP|NEPIS|\bSCDNR\b|dnr\.sc\.gov|epa\.gov/i.test(docIdentity(doc));
        mergeEvidence(section, field, [buildEvidence(
          isOfficial ? 'official_document' : 'web_document',
          label,
          url,
          String(quote || match[0]).replace(/\s+/g, ' ').trim(),
          'cached_document_regex',
          { normalizedKey }
        )]);
        if (!profile.sources.some(s => s.url === url)) {
          profile.sources.push({ label, url, trust: isOfficial ? 'OFFICIAL' : 'SECONDARY', sourceType: isOfficial ? 'official_document' : 'web_document' });
        }
      };

      // EPA morphometry reports meters. Convert to feet rather than repeating the
      // SCDNR sidebar's incorrect "6.9 feet" label.
      const meanDepth = findMatch(epaDocs, /\bMean depth:\s*([0-9]+(?:\.[0-9]+)?)\s*meters?\b/i);
      if (meanDepth) {
        const meters = parseFloat(meanDepth.match[1]);
        if (isFinite(meters) && meters > 0) {
          profile.identity.averageDepthFt = Math.round(meters * 3.28084 * 10) / 10;
          addCachedEvidence('identity', 'averageDepthFt', meanDepth);
        }
      }

      // The SCDNR page's ~225 ft "maximum depth" is the 225.5 ft full-pool
      // elevation. Prefer the explicit lake-specific deepest-point statement.
      const maxDepth = findMatch(anglersDocs, /\bdeepest point is\s+(?:approximately\s+|around\s+|about\s+)?([0-9]+(?:\.[0-9]+)?)\s*feet\b/i);
      if (maxDepth) {
        const feet = parseFloat(maxDepth.match[1]);
        if (isFinite(feet) && feet > 0) {
          profile.identity.maxDepthFt = feet;
          addCachedEvidence('identity', 'maxDepthFt', maxDepth);
        }
      }

      // EPA's flattened table lists one row per header. The SECCHI row is the final
      // 0.3-0.5 m range with a 0.4 m mean; 10-35 / 17 are alkalinity values.
      const secchi = findMatch(epaDocs, /SECCHI\s*\(METERS\)[\s\S]{0,1800}?(0?\.3\s*-\s*0?\.5\s+(0?\.4)\s+\.?0?\.3)\s+CHEMICAL/i);
      if (secchi) {
        const meters = parseFloat(secchi.match[2]);
        if (isFinite(meters) && meters > 0) {
          profile.limnology.waterClarity.secchiFt = Math.round(meters * 3.28084 * 10) / 10;
          addCachedEvidence('limnology', 'waterClarity.secchiFt', secchi, `SECCHI (METERS) ${secchi.match[1]}`);
        }
      }

      const trophic = findMatch(epaDocs, /\bSurvey data indicate\s+[^.]{0,100}?\bis\s+(eutrophic|mesotrophic|oligotrophic)\b/i);
      if (trophic) {
        profile.limnology.trophicStatus = trophic.match[1].toLowerCase();
        addCachedEvidence('limnology', 'trophicStatus', trophic);
      }

      const forage = findMatch(anglersDocs, /\bmain forage base is\s+threadfin\s+and\s+gizzard\s+shad\b/i);
      if (forage) {
        profile.biology.primaryForage = uniqueResearchSpecies([...(profile.biology.primaryForage || []), 'Threadfin shad', 'Gizzard shad']);
        addCachedEvidence('biology', 'primaryForage', forage);
      }

      const hydroelectric = findMatch([...scdnrDocs, ...anglersDocs], /\bWateree Hydroelectric Station\b/i)
        || findMatch([...scdnrDocs, ...anglersDocs], /\bHydroelectric Station\b/i);
      if (hydroelectric) {
        profile.identity.archetype = 'Hydroelectric reservoir';
        addCachedEvidence('identity', 'archetype', hydroelectric);
      }

      const retention = findMatch(epaDocs, /\bMean hydraulic retention time:\s*([0-9]+(?:\.[0-9]+)?)\s*days\b/i);
      if (retention) {
        const days = parseFloat(retention.match[1]);
        if (isFinite(days) && days > 0) {
          profile.limnology.flowCharacteristics = `Mean hydraulic retention time: ${days} days`;
          addCachedEvidence('limnology', 'flowCharacteristics', retention);
        }
      }

      const vegetation = findMatch(epaDocs, /\b(?:Survey limnologists\s+)?did not observe any macrophytes\b/i);
      if (vegetation) {
        profile.habitat.vegetation = ['None observed'];
        addCachedEvidence('habitat', 'vegetation', vegetation);
      }
    }
  } catch (e) {
    console.warn(`cached deterministic fact extraction failed for ${lakeName}: ${e.message}`);
  }

  // SCDNR lake description (SC only)
  if (state === 'SC') {
    const slug = lakeKeyFromName(lakeName);
    const descUrl = `https://www.dnr.sc.gov/lakes/${slug}/description.html`;
    try {
      const descRes = await fetch(descUrl, { headers: { 'User-Agent': 'TrollMap/16 Evidence Engine', 'Accept': 'text/html' }, cf: { cacheTtl: 86400, cacheEverything: true } });
      if (descRes.ok) {
        const html = await descRes.text();
        const parsed = parseSCDNRDescriptionFacts(lakeName, descUrl, html);
        Object.assign(profile.identity, parsed.identity || {});
        profile.biology.predatorSpecies = uniqueResearchSpecies([...(profile.biology.predatorSpecies || []), ...((parsed.biology || {}).predatorSpecies || [])]);
        if ((parsed.biology || {}).knownStockings?.length) profile.biology.knownStockings = parsed.biology.knownStockings;
        profile.habitat.artificialHabitat = [...new Set([...(profile.habitat.artificialHabitat || []), ...((parsed.habitat || {}).artificialHabitat || [])])];
        if (parsed.habitat?.artificialHabitatDetails?.attractorCount != null) profile.habitat.artificialHabitatDetails.attractorCount = parsed.habitat.artificialHabitatDetails.attractorCount;
        if (parsed.habitat?.notes) profile.habitat.notes = parsed.habitat.notes;
        if (parsed.navigation?.accessPointCount != null) profile.navigation.accessPointCount = parsed.navigation.accessPointCount;
        if (parsed.navigation?.publicRampCount != null) profile.navigation.publicRampCount = parsed.navigation.publicRampCount;
        if (parsed.navigation?.privateAccessCount != null) profile.navigation.privateAccessCount = parsed.navigation.privateAccessCount;
        for (const src of parsed.sources || []) profile.sources.push(src);
        for (const [sec, fields] of Object.entries(parsed.evidence || {})) for (const [field, entries] of Object.entries(fields || {})) mergeEvidence(sec, field, entries);
      }
    } catch (e) {
      console.warn(`deterministic description fetch failed for ${lakeName}: ${e.message}`);
    }
  }

  // Deterministic SC regulations from official pages
  // eRegulations is a JS-rendered React app — content is scraped via Firecrawl during
  // discovery and stored in normalized_documents.json. We parse those tables here.
  if (state === 'SC') {
    const slug = lakeKeyFromName(lakeName);
    const regsUrl = 'https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits';
    const lakeRegsUrl = `https://www.dnr.sc.gov/lakes/${slug}/regs.html`;
    const firecrawlKey = env.FIRECRAWL_API_KEY || env.FIRECRAWL_KEY;
    try {
      let regsHtml = '';
      let lakeRegsHtml = '';
      // Try multiple R2 keys — lake name may be saved as "Lake Wateree, SC" or "Lake Wateree"
      const candidateKeys = [
        `lake_packages/${sanitizeLakeId(lakeName)}/normalized_documents.json`,
        `lake_packages/${sanitizeLakeId('Lake ' + slug)}/normalized_documents.json`,
        `lake_packages/${sanitizeLakeId(slug)}/normalized_documents.json`,
        `lake_packages/lake_${slug}_sc/normalized_documents.json`,
      ];
      const seenKeys = new Set();
      try {
        for (const normKey of candidateKeys) {
          if (seenKeys.has(normKey)) continue;
          seenKeys.add(normKey);
          const normObj = await env.R2_TROLLMAP_CHARTPACKS.get(normKey);
          if (!normObj) continue;
          const normDocs = JSON.parse(await normObj.text());
          if (!Array.isArray(normDocs) || !normDocs.length) continue;
          const regsDoc = normDocs.find(d => d.url && /eregulations\.com/i.test(d.url) && /freshwater-fish-size|possession-limits|freshwater-game/i.test(d.url + (d.title || '')))
            || normDocs.find(d => d.url && /eregulations\.com/i.test(d.url));
          const lakeRegsDoc = normDocs.find(d => d.url && d.url.includes(`/lakes/${slug}/regs`))
            || normDocs.find(d => /lake.*regulations/i.test(d.title || '') && d.url && d.url.includes(slug));
          if (regsDoc?.fullText) regsHtml = regsDoc.fullText;
          if (lakeRegsDoc?.fullText) lakeRegsHtml = lakeRegsDoc.fullText;
          profile._regsDebug = {
            normKey,
            normDocsCount: normDocs.length,
            regsDocFound: !!regsDoc,
            regsFullTextLen: regsDoc?.fullText?.length || 0,
            lakeRegsDocFound: !!lakeRegsDoc,
            extractionMethod: regsDoc?.extractionMethod || null,
            regsHtmlLen: regsHtml.length
          };
          if (regsHtml) break;
        }
      } catch (e) {
        console.warn(`normalized regs load failed: ${e.message}`);
        profile._regsDebug = { loadError: e.message };
      }

      // Live Firecrawl scrape of eRegulations if normalized docs missing/empty
      // (eRegulations is a React SPA — plain fetch returns shell HTML with no table rows)
      if (!regsHtml && firecrawlKey) {
        try {
          const fcRes = await fetch('https://api.firecrawl.dev/v1/scrape', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${firecrawlKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: regsUrl,
              formats: ['markdown'],
              onlyMainContent: true,
              waitFor: 3000,
              timeout: 25000
            })
          });
          if (fcRes.ok) {
            const fcData = await fcRes.json();
            const md = fcData.data?.markdown || fcData.markdown || '';
            if (md && md.length > 200) {
              regsHtml = md;
              profile._regsDebug = { ...(profile._regsDebug || {}), liveFirecrawl: true, regsHtmlLen: md.length };
            }
          }
        } catch (e) {
          console.warn(`live Firecrawl eRegulations scrape failed: ${e.message}`);
        }
      }

      // Fall back to direct fetch of lake-specific regs page (static HTML, no JS needed)
      if (!lakeRegsHtml) {
        try {
          const lakeRegsRes = await fetch(lakeRegsUrl, { headers: { 'User-Agent': 'TrollMap/16 Evidence Engine', 'Accept': 'text/html' }, cf: { cacheTtl: 86400, cacheEverything: true } });
          if (lakeRegsRes.ok) lakeRegsHtml = await lakeRegsRes.text();
        } catch (_) {}
      }

      // Even without statewide eRegs, lake-specific page alone is useful (14" LMB etc.)
      if (regsHtml || lakeRegsHtml) {
        try {
          profile._regsDebug = profile._regsDebug || {};
          profile._regsDebug.htmlRows = regsHtml ? extractHtmlTableRows(regsHtml).length : 0;
          profile._regsDebug.mdRows = regsHtml ? extractMarkdownTableRows(regsHtml).length : 0;
          profile._regsDebug.first100chars = (regsHtml || lakeRegsHtml || '').slice(0, 100);
          const parsedRegs = parseSCRegulationsFromHtml(lakeName, regsUrl, regsHtml || '', lakeRegsHtml || '');
          const pr = parsedRegs.regulations || {};
          if (pr.state) profile.regulations.state = pr.state;
          if (pr.lastUpdated) profile.regulations.lastUpdated = pr.lastUpdated;
          if (pr.generalStateRegulations) {
            profile.regulations.generalStateRegulations = profile.regulations.generalStateRegulations || { lengthLimits: {}, creelLimits: {} };
            // Deep-merge nested length/creel maps so we don't wipe partial data
            profile.regulations.generalStateRegulations.lengthLimits = {
              ...(profile.regulations.generalStateRegulations.lengthLimits || {}),
              ...(pr.generalStateRegulations.lengthLimits || {})
            };
            profile.regulations.generalStateRegulations.creelLimits = {
              ...(profile.regulations.generalStateRegulations.creelLimits || {}),
              ...(pr.generalStateRegulations.creelLimits || {})
            };
          }
          if (pr.lakeSpecificRegulations) {
            const lsr = profile.regulations.lakeSpecificRegulations || { hasExceptions: null, creelLimits: {}, sizeLimits: {}, specialRules: [], closedSeasons: [] };
            if (pr.lakeSpecificRegulations.hasExceptions != null) lsr.hasExceptions = pr.lakeSpecificRegulations.hasExceptions;
            lsr.creelLimits = { ...(lsr.creelLimits || {}), ...(pr.lakeSpecificRegulations.creelLimits || {}) };
            lsr.sizeLimits = { ...(lsr.sizeLimits || {}), ...(pr.lakeSpecificRegulations.sizeLimits || {}) };
            lsr.specialRules = [...new Set([...(lsr.specialRules || []), ...(pr.lakeSpecificRegulations.specialRules || [])])];
            lsr.closedSeasons = [...(lsr.closedSeasons || []), ...(pr.lakeSpecificRegulations.closedSeasons || [])];
            profile.regulations.lakeSpecificRegulations = lsr;
          }
          if (pr.lengthLimits) profile.regulations.lengthLimits = { ...(profile.regulations.lengthLimits || {}), ...pr.lengthLimits };
          if (pr.creelLimits) profile.regulations.creelLimits = { ...(profile.regulations.creelLimits || {}), ...pr.creelLimits };
          if (pr.notes) profile.regulations.notes = pr.notes;
          for (const src of parsedRegs.sources || []) profile.sources.push(src);
          for (const [sec, fields] of Object.entries(parsedRegs.evidence || {})) for (const [field, entries] of Object.entries(fields || {})) mergeEvidence(sec, field, entries);
          profile._regsDebug.parsedCreelLimits = parsedRegs.regulations?.generalStateRegulations?.creelLimits || {};
          profile._regsDebug.parsedGeneralLength = parsedRegs.regulations?.generalStateRegulations?.lengthLimits || {};
          profile._regsDebug.parsedLakeSpecific = parsedRegs.regulations?.lakeSpecificRegulations || {};
          profile._regsDebug.parsedOk = Object.keys(profile._regsDebug.parsedCreelLimits).length > 0
            || Object.keys(profile._regsDebug.parsedGeneralLength).length > 0
            || Object.keys(profile._regsDebug.parsedLakeSpecific?.sizeLimits || {}).length > 0;
        } catch (regsErr) {
          profile._regsDebug = profile._regsDebug || {};
          profile._regsDebug.parseError = regsErr.message;
        }
      }
    } catch (e) {
      console.warn(`deterministic regulations fetch failed for ${lakeName}: ${e.message}`);
    }
  }

  // Structured ramps/species
  try {
    const rampFacts = await getRampSpeciesFacts(env, lakeName, state);
    if (rampFacts) {
      profile.navigation.ramps = rampFacts.ramps.map(r => ({ name: r.name, lat: Math.round(r.lat * 1e6) / 1e6, lon: Math.round(r.lon * 1e6) / 1e6, lanes: r.lanes || null, county: r.county || null, owner: r.owner || null }));
      profile.biology.predatorSpecies = uniqueResearchSpecies([...(profile.biology.predatorSpecies || []), ...(rampFacts.predatorSpecies || [])]);
      mergeEvidence('navigation', 'ramps', [buildEvidence('official_structured', rampFacts.sourceLabel, `worker:/ramps?state=${state}`, null, 'structured_waterbody_aggregation', { count: profile.navigation.ramps.length })]);
      if (rampFacts.predatorSpecies?.length) mergeEvidence('biology', 'predatorSpecies', [buildEvidence('official_structured', rampFacts.sourceLabel, `worker:/ramps?state=${state}`, null, 'structured_species_aggregation', { speciesCount: rampFacts.predatorSpecies.length })]);
      profile.sources.push({ label: rampFacts.sourceLabel, url: `worker:/ramps?state=${state}`, trust: 'OFFICIAL_GIS', sourceType: 'official_structured' });
    }
  } catch (e) {
    console.warn(`deterministic ramps fetch failed for ${lakeName}: ${e.message}`);
  }

  // Structured attractors
  try {
    const attractorFacts = await getAttractorFacts(env, lakeName, state);
    if (attractorFacts) {
      profile.habitat.artificialHabitat = [...new Set([...(profile.habitat.artificialHabitat || []), 'Fish attractors'])];
      profile.habitat.artificialHabitatDetails.attractorCount = attractorFacts.attractors.length;
      profile.habitat.artificialHabitatDetails.attractorTypes = Object.keys(attractorFacts.typeCounts || {}).sort();
      if (!profile.habitat.notes && attractorFacts.attractors.length) {
        profile.habitat.notes = `${attractorFacts.attractors.length} mapped fish attractors available from ${attractorFacts.sourceLabel}.`;
      }
      mergeEvidence('habitat', 'artificialHabitatDetails', [buildEvidence('official_structured', attractorFacts.sourceLabel, `worker:/attractors?state=${state}`, null, 'structured_waterbody_aggregation', { count: attractorFacts.attractors.length, types: profile.habitat.artificialHabitatDetails.attractorTypes })]);
      profile.sources.push({ label: attractorFacts.sourceLabel, url: `worker:/attractors?state=${state}`, trust: 'OFFICIAL_GIS', sourceType: 'official_structured' });
    }
  } catch (e) {
    console.warn(`deterministic attractors fetch failed for ${lakeName}: ${e.message}`);
  }

  // Simple deterministic summary from explicit facts only
  profile.summary.text = buildFactualSummary(profile);
  profile.summary.keywords = uniqueResearchSpecies([...(profile.biology.predatorSpecies || []), ...(profile.biology.primaryForage || []), ...(profile.habitat.artificialHabitatDetails?.attractorTypes || [])]).slice(0, 12);
  if (profile.summary.text) {
      mergeEvidence('summary', 'text', [buildEvidence('internal_synthesis', 'TrollMap deterministic profile synthesis', 'internal:deterministic-facts', null, 'deterministic_fact_synthesis')]);
  }

  return new Response(JSON.stringify({ ok: true, lakeName, state, profile }), { headers: JSON_HEADERS });
}
__name(handleResearchDeterministicFacts, "handleResearchDeterministicFacts");

async function handleResearchSaveNormalized(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || "").trim();
  const documents = body.documents || [];

  if (!lakeName || !documents.length) {
    return new Response(JSON.stringify({ success: false, error: "Missing lakeName or documents payload" }), { status: 400, headers: JSON_HEADERS });
  }

  const safe = sanitizeLakeId(lakeName);
  const key = `lake_packages/${safe}/normalized_documents.json`;

  await env.R2_TROLLMAP_CHARTPACKS.put(key, JSON.stringify(documents, null, 2), {
    httpMetadata: { contentType: "application/json" }
  });

  return new Response(JSON.stringify({ success: true, key }), { headers: JSON_HEADERS });
}
__name(handleResearchSaveNormalized, "handleResearchSaveNormalized");

async function handleResearchGetNormalized(env, lakeName) {
  const safe = sanitizeLakeId(lakeName);
  const key = `lake_packages/${safe}/normalized_documents.json`;
  const obj = await env.R2_TROLLMAP_CHARTPACKS.get(key);
  if (!obj) return new Response(JSON.stringify({ok:false, error:`no normalized documents for ${lakeName}`}), {status:404, headers:JSON_HEADERS});
  const text = await obj.text();
  let docs;
  try { docs = JSON.parse(text); } catch { return new Response(JSON.stringify({ok:false, error:"corrupt normalized documents"}), {status:500, headers:JSON_HEADERS}); }
  return new Response(JSON.stringify({ok:true, lakeName, count: docs.length, documents: docs}), {headers:JSON_HEADERS});
}
__name(handleResearchGetNormalized, "handleResearchGetNormalized");

async function handleResearchAnalyzeFacts(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || "").trim();
  const baseName = String(body.baseName || body.lakeName || "").replace(/^Lake\s+/i,'').replace(/,\s*(SC|NC|GA)\s*$/i,'').trim() || lakeName;
  const state = String(body.state||'SC').trim();
  const documents = body.documents || [];

  if (!lakeName || !documents.length) {
    return new Response(JSON.stringify({ success: false, error: "Missing lakeName or documents payload" }), { status: 400, headers: JSON_HEADERS });
  }

  // Build context from already lake-filtered chunks (client did extractRelevantChunks)
  // Include quality scores to help LLM prioritize
  const contextParts = documents.map((d, idx) => {
    const docText = d.text || d.fullText || "";
    const quality = d.quality || {};
    const comp = quality.composite || quality.authority || 50;
    return `--- DOCUMENT ${idx+1} [composite=${comp}] ---\nTitle: ${d.title}\nURL: ${d.url||'unknown'}\nRelevant excerpt (${docText.length} chars):\n${docText.slice(0, 25000)}`;
  });
  const context = contextParts.join("\n\n");
  const totalChars = context.length;

  // If context huge, trim hard to 80k chars for Gemini context
  let finalContext = context;
  if (context.length > 80000) finalContext = context.slice(0, 80000) + "\n\n[TRIMMED FOR TOKEN LIMIT]";

  const prompt = `You are TrollMap Fact Gathering Engine v3. Extract VERIFIED granular facts about "${lakeName}" (base name "${baseName}", state ${state}) from the provided document excerpts.

CRITICAL RULES:
1. Focus on "${baseName}" specifically. Documents may be statewide SCDNR reports - ONLY extract data where the lake name "${baseName}" or "${lakeName}" is mentioned OR where the section clearly applies to all SC lakes (for regulations).
2. For regulations: DISTINGUISH general statewide limits vs lake-specific exceptions. Example: SC has general statewide creel limits, but ${lakeName} may have special striped bass creel, crappie limits, or closed seasons. Extract BOTH if present. Use categories: "creelLimit_general", "creelLimit_lakeSpecific", "sizeLimit_general", "sizeLimit_lakeSpecific", "closedSeason", "regulations".
3. Required categories (try to extract at least one fact per category if present):
   - identity: riverSystem, archetype, surfaceArea, maxDepth, averageDepth, damName, yearImpounded
   - limnology: clarity, thermocline, oxygen, waterColor, secchi
   - biology/forage: primaryForage, secondaryForage, predatorSpecies, baitfishMovement, stocking
   - habitat: bottomComposition, cover, points, humps, creekArms, standingTimber, dockDensity
   - navigation: ramps, hazards, shoals
   - regulations: as above
   - trolling: general trolling notes if mentioned (rare in DNR docs)
   - summary: 1-sentence overview
4. DATA EXTRACTION: Much of the best data is in TABLES. You MUST extract from tables. 
   - Each fact MUST include: fact (concise sentence), page (estimate 1 if HTML, or number from "--- PAGE X ---"), confidence (0-100), source (doc title), quote (the most relevant verbatim snippet from context), category (from list above).
   - QUOTE RULE: If the fact comes from a table, the quote should be the relevant row or cell content. Do not obsess over word count (10-30 words); prioritize verbatim accuracy over length.
5. If a doc has NO mention of "${baseName}" and is not a general regulations doc, skip it — do not hallucinate.
6. If after scanning you find 0 lake-specific facts, THEN extract 1-2 general SC statewide fishing regulation facts and label confidence 60 and category "regulations_general" — so pipeline doesn't return empty.
7. Do NOT invent numbers. If surface area not stated, do NOT guess. Omit that category.
8. UNIT WARNINGS: For Lake Wateree specifically, the SCDNR description page contains known label/unit errors. "Average Depth: 6.9 feet" conflicts with the EPA morphometry value "Mean depth: 6.9 meters" (22.6 ft), and "Maximum Depth: Approximately 225 feet" repeats the 225.5 ft full-pool elevation rather than lake depth (the lake-specific Anglers HQ description says the deepest point is around 90 ft). In the flattened EPA summary table, 10-35 / 17 / 16 are total alkalinity values in mg/L; the SECCHI (METERS) row is 0.3-0.5 / mean 0.4 / median 0.3. Never shift values between table rows, and convert meters to feet (×3.28084) for *Ft fields.
9. Return ONLY valid JSON. No markdown, no explanation.

Context (${totalChars} chars total, showing ${finalContext.length}):
${finalContext}

Return ONLY this JSON:
{
  "extracted_facts": [
    {
      "fact": "Lake Wateree is part of the Catawba-Wateree river system.",
      "page": 1,
      "confidence": 92,
      "source": "SCDNR Lakes Information",
      "quote": "Lake Wateree is impounded on the Catawba-Wateree River",
      "category": "riverSystem"
    },
    {
      "fact": "Summer thermocline develops between 12 and 18 feet in Lake Wateree.",
      "page": 12,
      "confidence": 88,
      "source": "2017 Annual Report",
      "quote": "thermocline was observed between 12 and 18 ft during summer stratification",
      "category": "thermocline"
    },
    {
      "fact": "General SC statewide creel limit for largemouth bass is 5 per day.",
      "page": 1,
      "confidence": 95,
      "source": "SC Freshwater Fishing Regulations",
      "quote": "Largemouth bass: 5 per day",
      "category": "creelLimit_general"
    },
    {
      "fact": "Lake Wateree striped bass creel limit is 10 per day with no minimum size in lower lake during open season.",
      "page": 1,
      "confidence": 85,
      "source": "SC Freshwater Fishing Regulations",
      "quote": "Lake Wateree striped bass: 10 per day, no size limit",
      "category": "creelLimit_lakeSpecific"
    }
  ]
}
If you truly cannot find ANY verifiable fact, return {"extracted_facts":[]} but you should try hard for regulations at minimum.

`;

  const payload = {
    messages: [
      { role: "system", content: "You are a precise fact extraction engine. Return ONLY valid JSON with extracted_facts array. Never hallucinate. Quote must be verbatim from context. Confidence 0-100. Categories must be from allowed list." },
      { role: "user", content: prompt }
    ],
    temperature: 0.08,
    max_tokens: 8000,
    response_format: { type: "json_object" }
  };

  try {
    const { data } = await callLLM(env, payload, null); // use general chain (Groq 120b -> Cerebras 120b), not Gemini
    const text = extractLLMText(data);
    const parsed = extractJsonPossibly(text);
    if (!parsed) {
      console.warn(`Fact extraction returned non-JSON: ${text.slice(0,500)}`);
      return new Response(JSON.stringify({ success: true, extracted_facts: [], raw: text.slice(0,1000), warning: "non-JSON returned" }), { headers: JSON_HEADERS });
    }
    let facts = parsed.extracted_facts || parsed.facts || parsed || [];
    if (!Array.isArray(facts)) {
      // sometimes LLM returns object with categories as keys
      if (typeof facts === 'object') {
        const flattened = [];
        for (const [k,v] of Object.entries(facts)) {
          if (Array.isArray(v)) flattened.push(...v);
          else if (typeof v === 'object' && v.fact) flattened.push({ ...v, category: v.category||k });
        }
        facts = flattened;
      } else facts = [];
    }
    // Normalize and filter
    facts = facts.map(f=> ({
      fact: String(f.fact||'').trim().slice(0,500),
      page: parseInt(f.page)||1,
      confidence: Math.min(99, Math.max(10, parseInt(f.confidence)||70)),
      source: String(f.source||'Unknown').slice(0,180),
      quote: String(f.quote||'').trim().slice(0,400),
      category: String(f.category||'general').trim().slice(0,50)
    })).filter(f=> f.fact.length > 10 && (f.quote.length > 3 || f.confidence >= 70));

    // Quality filter: drop facts that obviously don't mention baseName unless they are general regulations
    const generalCats = new Set(['regulations_general','creelLimit_general','sizeLimit_general','regulations','closedSeason']);
    const filteredFacts = facts.filter(f=>{
      const catLower = f.category.toLowerCase();
      const isGeneralReg = generalCats.has(catLower) || catLower.includes('general') || /creel|size limit|regulation/.test(catLower);
      if (isGeneralReg) return true; // keep general regs even without lake mention
      // otherwise require lake mention in fact or quote or source mentions base
      const combined = `${f.fact} ${f.quote} ${f.source}`.toLowerCase();
      return combined.includes(baseName.toLowerCase()) || combined.includes(lakeName.toLowerCase());
    });

    let outFacts = filteredFacts.length ? filteredFacts : facts; // if filtering removed all, keep original to avoid 0

    // FALLBACK PASS: if still 0 facts, retry with simpler prompt focused only on regulations docs
    if (outFacts.length === 0) {
      console.warn(`handleResearchAnalyzeFacts: primary pass returned 0 facts — running fallback regulations pass`);
      // Prefer HTML/regulations docs for fallback (shorter, more focused)
      const regsDocs = documents.filter(d => /regulation|regs|creel|html/i.test((d.title||'') + (d.url||'')));
      const fallbackDocs = regsDocs.length ? regsDocs : documents.slice(0, 3);
      const fallbackContext = fallbackDocs.map((d,i) => `--- DOC ${i+1}: ${d.title} ---\n${(d.text||d.fullText||'').slice(0,15000)}`).join('\n\n');
      const fallbackPrompt = `Extract fishing regulations from these documents for ${lakeName} or general SC statewide rules.

For each rule found, return a JSON object. Include creel limits, size limits, closed seasons, and any lake-specific rules.
Even general statewide SC rules are valuable. Return as many facts as you can find.

Documents:
${fallbackContext.slice(0, 40000)}

Return ONLY valid JSON:
{
  "extracted_facts": [
    {"fact": "...", "page": 1, "confidence": 80, "source": "...", "quote": "text from doc or empty string if not found", "category": "creelLimit_general"}
  ]
}`;
      try {
        const fbPayload = {
          messages: [
            { role: "system", content: "Extract fishing regulation facts. Return ONLY valid JSON with extracted_facts array. Include any creel limits, size limits, seasons, or rules you find. The quote field can be empty string if you cannot find verbatim text — do NOT skip facts just because you cannot quote them." },
            { role: "user", content: fallbackPrompt }
          ],
          temperature: 0.05,
          max_tokens: 4000,
          response_format: { type: "json_object" }
        };
        const preferGemini = !!env.GEMINI_API_KEY;
        const { data: fbData } = await callLLM(env, fbPayload, preferGemini ? 'gemini' : null);
        const fbText = extractLLMText(fbData);
        const fbParsed = extractJsonPossibly(fbText);
        if (fbParsed) {
          let fbFacts = fbParsed.extracted_facts || fbParsed.facts || [];
          if (!Array.isArray(fbFacts)) fbFacts = [];
          fbFacts = fbFacts.map(f => ({
            fact: String(f.fact||'').trim().slice(0,500),
            page: parseInt(f.page)||1,
            confidence: Math.min(99, Math.max(10, parseInt(f.confidence)||65)),
            source: String(f.source||'Unknown').slice(0,180),
            quote: String(f.quote||f.fact||'').trim().slice(0,400),
            category: String(f.category||'regulations_general').trim().slice(0,50)
          })).filter(f => f.fact.length > 10); // no quote requirement in fallback
          if (fbFacts.length > 0) {
            console.log(`handleResearchAnalyzeFacts: fallback pass recovered ${fbFacts.length} regulation facts`);
            outFacts = fbFacts;
          }
        }
      } catch (fbErr) {
        console.warn(`handleResearchAnalyzeFacts fallback pass failed: ${fbErr.message}`);
      }
    }

    return new Response(JSON.stringify({ success: true, extracted_facts: outFacts, meta: { totalDocs: documents.length, contextChars: totalChars, filteredOut: facts.length - outFacts.length } }), { headers: JSON_HEADERS });
  } catch (e) {
    console.error(`handleResearchAnalyzeFacts LLM failed: ${e.message}`);
    return new Response(JSON.stringify({ success: false, error: e.message }), { status: 502, headers: JSON_HEADERS });
  }
}
__name(handleResearchAnalyzeFacts, "handleResearchAnalyzeFacts");

async function handleResearchDedupeContradictions(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const facts = body.facts || [];

  const normalize = (s) => String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ').slice(0,200);
  const deduplicated = [];
  const contradictions = [];
  const seenFactMap = new Map(); // normalized fact -> index in deduped
  const categoryGroups = new Map(); // category -> array of facts

  for (const f of facts) {
    const factNorm = normalize(f.fact);
    if (!factNorm) continue;
    const cat = String(f.category||'general').toLowerCase().trim();

    // Deduplicate exact or near-identical facts
    if (seenFactMap.has(factNorm)) {
      const existingIdx = seenFactMap.get(factNorm);
      const existing = deduplicated[existingIdx];
      existing.sourcesAgree = (existing.sourcesAgree||1)+1;
      // keep higher confidence quote
      if ((f.confidence||0) > (existing.confidence||0)) {
        existing.confidence = f.confidence;
        existing.quote = f.quote || existing.quote;
        existing.source = f.source || existing.source;
      }
      continue;
    }
    // Near-duplicate check: if one fact contains the other (>80% overlap) treat as same
    let isNearDup = false;
    for (let i=0;i<deduplicated.length;i++) {
      const existingNorm = normalize(deduplicated[i].fact);
      if (factNorm.length > 20 && existingNorm.length > 20) {
        if (factNorm.includes(existingNorm.slice(0, Math.floor(existingNorm.length*0.8))) || existingNorm.includes(factNorm.slice(0, Math.floor(factNorm.length*0.8)))) {
          const existing = deduplicated[i];
          existing.sourcesAgree = (existing.sourcesAgree||1)+1;
          if ((f.confidence||0) > (existing.confidence||0)) {
            existing.confidence = f.confidence;
            existing.quote = f.quote || existing.quote;
          }
          seenFactMap.set(factNorm, i);
          isNearDup = true;
          break;
        }
      }
    }
    if (isNearDup) continue;

    // Contradiction detection — ONLY mutually exclusive claims on the SAME specific attribute.
    // Biology/forage facts are NEVER considered for contradictions (they are almost always complementary).
    // Only identity (acreage, depth, elevation) and regulations (creel/size limits) can produce real conflicts.
    const group = categoryGroups.get(cat) || [];
    const IMPORTANT_CATEGORIES = new Set(['identity', 'surfacearea', 'maxdepth', 'averagedepth', 'elevation', 'regulations', 'creellimit_lakespecific', 'sizelimit_lakespecific', 'creellimit', 'sizelimit']);

    if (!IMPORTANT_CATEGORIES.has(cat) && !cat.includes('identity') && !cat.includes('regulation')) {
      // skip biology/forage/limnology/habitat/navigation entirely — they produce false positives
    } else {
      for (const prev of group) {
        const prevText = String(prev.fact).toLowerCase();
        const currText = String(f.fact).toLowerCase();

        // Only look for direct numeric conflicts on the exact same attribute
        // e.g. "13,710 acres" vs "13,025 acres" for surface area, or two different creel limits
        let numberConflict = false;
        const numsPrev = prevText.match(/\d+(?:\.\d+)?/g) || [];
        const numsCurr = currText.match(/\d+(?:\.\d+)?/g) || [];

        if (numsPrev.length && numsCurr.length) {
          const nPrev = parseFloat(numsPrev[0]);
          const nCurr = parseFloat(numsCurr[0]);
          if (isFinite(nPrev) && isFinite(nCurr) && nPrev !== nCurr) {
            // Require the facts to be talking about the exact same measurable attribute
            // (surface area, max depth, creel limit, size limit, elevation, etc.)
            const sameAttr = /acre|surface|depth|elevation|pool|creel|limit|size/i.test(prevText) &&
                             /acre|surface|depth|elevation|pool|creel|limit|size/i.test(currText);
            const relDiff = Math.abs(nPrev - nCurr) / Math.max(1, Math.min(nPrev, nCurr));
            if (sameAttr && relDiff > 0.05) { // >5% difference on same attribute
              numberConflict = true;
            }
          }
        }

        if (numberConflict) {
          contradictions.push({
            field: f.category,
            factA: prev.fact,
            quoteA: prev.quote,
            pageA: prev.page,
            confidenceA: prev.confidence,
            sourceA: prev.source,
            factB: f.fact,
            quoteB: f.quote,
            pageB: f.page,
            confidenceB: f.confidence,
            sourceB: f.source,
            reason: 'mutually exclusive numeric claim on same attribute'
          });
        }
      }
    }
    // Add to deduped
    const entry = { ...f, sourcesAgree: 1 };
    const idx = deduplicated.length;
    deduplicated.push(entry);
    seenFactMap.set(factNorm, idx);
    if (!categoryGroups.has(cat)) categoryGroups.set(cat, []);
    categoryGroups.get(cat).push(entry);
  }

  // Sort deduplicated by confidence desc
  deduplicated.sort((a,b)=> (b.confidence||0)-(a.confidence||0));

  return new Response(JSON.stringify({ success: true, deduplicated_facts: deduplicated, contradictions, meta: { input: facts.length, deduped: deduplicated.length, contradictions: contradictions.length } }), { headers: JSON_HEADERS });
}
__name(handleResearchDedupeContradictions, "handleResearchDedupeContradictions");

// ── GAP QUERY TEMPLATES ──────────────────────────────────────────────────────
const GAP_QUERIES = {
  "limnology.thermocline.summerDepthFt":   (lake, dnr) => `"${lake}" thermocline depth summer stratification fishing`,
  "limnology.oxygen.depletionDepthFt":     (lake, dnr) => `"${lake}" dissolved oxygen depletion depth summer fish floor`,
  "biology.predatorSpecies":               (lake, dnr) => `"${lake}" fish species gamefish bass crappie catfish striped`,
  "biology.primaryForage":                 (lake, dnr) => `"${lake}" forage fish shad herring baitfish`,
  "regulations.lakeSpecificRegulations":   (lake, dnr) => `"${lake}" fishing regulations specific creel limit size limit site:${dnr}`,
};

// ── MAPPING AGENT — maps extracted facts to profile schema, nulls everything else ──
async function handleResearchMapFacts(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || '').trim();
  const facts = body.facts || [];
  const gapTexts = body.gapTexts || []; // raw text from targeted gap searches
  const pass = body.pass || 1;

  if (!lakeName) {
    return new Response(JSON.stringify({ success: false, error: "Missing lakeName" }), { status: 400, headers: JSON_HEADERS });
  }

  // If neither facts nor gap texts are provided, return empty null profile
  if (!facts.length && !gapTexts.length) {
    const emptyProfile = { identity: { lakeName }, limnology: {}, biology: {}, habitat: {}, navigation: {}, regulations: {}, trollingIntelligence: {} };
    return new Response(JSON.stringify({ success: true, profile: emptyProfile, provider: 'none', model: 'none', pass, factsUsed: 0, note: 'No facts or gap texts provided — all fields null' }), { headers: JSON_HEADERS });
  }

  const factsText = facts.map(f => `[${f.category}] ${f.fact} (Source: ${f.source}, Confidence: ${f.confidence}%)`).join('\n');
  const gapTextsSection = gapTexts.length ? `\n\nADDITIONAL TARGETED SEARCH RESULTS (extract any relevant facts for the null fields):\n${gapTexts.map(g => `[Searching for: ${g.field}]\n${g.text}`).join('\n\n---\n\n').slice(0, 4000)}` : '';

  const prompt = `You are a data mapping agent. You have a list of verified facts and potentially some raw research excerpts (gap texts) for ${lakeName}.

Your job is to map this information to the correct fields in the profile schema below.

STRICT RULES:
- Use the "VERIFIED FACTS" list primarily.
- Use "ADDITIONAL TARGETED SEARCH RESULTS" to fill in null fields. You MUST extract data from these excerpts, including from tables.
- If the data is in a table, treat the row/cell as a verified fact.
- Do NOT infer, estimate, or use any knowledge beyond the provided text.
- Null is correct when data is missing — it means unknown, not bad data.

VERIFIED FACTS FROM OFFICIAL DOCUMENTS:
${factsText.slice(0, 8000)}
${gapTextsSection}

Map this information to this exact JSON schema. Every null means no information was found for that field:
{
  "identity": {
    "lakeName": "${lakeName}",
    "state": null,
    "county": null,
    "riverSystem": null,
    "reservoirOwner": null,
    "surfaceAreaAcres": null,
    "maxDepthFt": null,
    "averageDepthFt": null,
    "normalPoolFt": null,
    "shorelinesLengthMi": null,
    "damName": null,
    "yearImpounded": null,
    "archetype": null,
    "aliases": []
  },
  "limnology": {
    "waterClarity": {"typical": null, "color": null, "secchiFt": null, "note": null},
    "thermocline": {"summerDepthFt": null, "strength": null, "winterMix": null, "note": null},
    "oxygen": {"depletionDepthFt": null, "anoxicBelowFt": null, "note": null},
    "trophicStatus": null,
    "flowCharacteristics": null,
    "seasonalDrawdownFt": null
  },
  "biology": {
    "primaryForage": [],
    "secondaryForage": [],
    "predatorSpecies": [],
    "speciesAbundance": {},
    "knownStockings": [],
    "invasiveSpecies": []
  },
  "habitat": {
    "bottomComposition": {},
    "cover": [],
    "vegetation": {},
    "structuralElements": {},
    "artificialHabitat": [],
    "dockDensity": null,
    "standingTimber": null,
    "notes": null
  },
  "navigation": {
    "ramps": [],
    "hazards": [],
    "notes": null
  },
  "regulations": {
    "state": null,
    "generalStateRegulations": {"lengthLimits": {}, "creelLimits": {}},
    "lakeSpecificRegulations": {"hasExceptions": null, "creelLimits": {}, "sizeLimits": {}, "specialRules": [], "closedSeasons": []},
    "notes": null
  },
  "trollingIntelligence": {}
}

Return ONLY valid JSON matching this schema exactly. No explanations.`;

  const payload = {
    messages: [
      { role: "system", content: "You are a strict data mapping agent. Map facts to schema fields only. Return valid JSON only. Never add information not in the facts list." },
      { role: "user", content: prompt }
    ],
    temperature: 0.05,
    max_tokens: 3000,
    response_format: { type: "json_object" }
  };

  try {
    const { data, provider, model } = await callLLM(env, payload, null);
    const text = extractLLMText(data);
    const parsed = extractJsonPossibly(text);
    if (!parsed) return new Response(JSON.stringify({ success: false, error: "Mapping agent returned non-JSON" }), { status: 502, headers: JSON_HEADERS });
    return new Response(JSON.stringify({ success: true, profile: parsed, provider, model, pass, factsUsed: facts.length }), { headers: JSON_HEADERS });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), { status: 502, headers: JSON_HEADERS });
  }
}
__name(handleResearchMapFacts, "handleResearchMapFacts");

// ── GAP ANALYSIS — identify null fields and return targeted search queries ──
async function handleResearchGapAnalysis(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || '').trim();
  const profile = body.profile || {};
  const state = String(body.state || 'SC').toUpperCase();

  const dnrDomain = state === 'NC' ? 'ncwildlife.org OR eregulations.com' : state === 'GA' ? 'georgiawildlife.com OR eregulations.com' : 'dnr.sc.gov OR eregulations.com'; // Fix 2026-07-12: dnr.sc.gov/fishregs 404s -> eRegulations
  const baseName = lakeName.replace(/^Lake\s+/i,'').replace(/,\s*(SC|NC|GA)\s*$/i,'').trim();

  // Only check fields that directly affect Smart Plan quality
  const nullFields = [];
  const check = (path, val) => {
    if (val === null || val === undefined || val === '' || (Array.isArray(val) && !val.length) || (typeof val === 'object' && !Array.isArray(val) && !Object.keys(val).length)) {
      nullFields.push(path);
    }
  };

  const lim = profile.limnology || {};
  check('limnology.thermocline.summerDepthFt', lim.thermocline?.summerDepthFt);
  check('limnology.oxygen.depletionDepthFt', lim.oxygen?.depletionDepthFt);

  const bio = profile.biology || {};
  check('biology.predatorSpecies', bio.predatorSpecies);
  check('biology.primaryForage', bio.primaryForage);

  const reg = profile.regulations || {};
  const lakeRegs = reg.lakeSpecificRegulations || {};
  if (!lakeRegs.hasExceptions && !Object.keys(lakeRegs.creelLimits||{}).length) {
    nullFields.push('regulations.lakeSpecificRegulations');
  }

  // Build targeted queries for null fields
  const gapQueries = nullFields
    .filter(f => GAP_QUERIES[f])
    .map(f => ({ field: f, query: GAP_QUERIES[f](baseName, dnrDomain) }));

  return new Response(JSON.stringify({
    success: true,
    nullFields,
    gapQueries,
    totalGaps: nullFields.length,
    searchableGaps: gapQueries.length
  }), { headers: JSON_HEADERS });
}
__name(handleResearchGapAnalysis, "handleResearchGapAnalysis");

// ── GAP SEARCH — targeted Tavily search + extract + fact extraction for one null field ──
async function handleResearchGapSearch(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || '').trim();
  const state = String(body.state || 'SC').toUpperCase();
  const field = String(body.field || '').trim();
  const query = String(body.query || '').trim();

  if (!lakeName || !query) return new Response(JSON.stringify({ success: false, error: "Missing lakeName or query", extracted_facts: [], rawText: '' }), { status: 400, headers: JSON_HEADERS });

  const tavilyKey = env.TAVILY_API_KEY || env.TAVILY_KEY;
  if (!tavilyKey) return new Response(JSON.stringify({ success: false, error: "No Tavily key", extracted_facts: [], rawText: '' }), { headers: JSON_HEADERS });

  try {
    // Search
    const searchRes = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tavilyKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, search_depth: 'basic', max_results: 3 })
    });
    if (!searchRes.ok) return new Response(JSON.stringify({ success: false, error: `Tavily search ${searchRes.status}`, extracted_facts: [], rawText: '' }), { headers: JSON_HEADERS });
    const searchData = await searchRes.json();
    const urls = (searchData.results||[]).map(r => r.url).filter(Boolean).slice(0, 3);
    if (!urls.length) return new Response(JSON.stringify({ success: true, extracted_facts: [], rawText: '', note: "No results found" }), { headers: JSON_HEADERS });

    // Extract — return raw text, let mapping agent handle it directly
    const extractRes = await fetch('https://api.tavily.com/extract', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tavilyKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls, query: `${lakeName} ${field}`, extract_depth: 'basic', format: 'markdown' })
    });
    if (!extractRes.ok) return new Response(JSON.stringify({ success: true, extracted_facts: [], rawText: '', note: "Extract failed" }), { headers: JSON_HEADERS });
    const extractData = await extractRes.json();
    const rawText = (extractData.results||[]).map(r => r.raw_content||'').join('\n').slice(0, 8000);

    // Return raw text — no LLM extraction here to avoid CPU timeout
    // The mapping agent will receive this as additional context in Pass 2
    return new Response(JSON.stringify({ success: true, extracted_facts: [], rawText, field, query, urls }), { headers: JSON_HEADERS });

  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message, extracted_facts: [], rawText: '' }), { status: 502, headers: JSON_HEADERS });
  }
}
__name(handleResearchGapSearch, "handleResearchGapSearch");

// ─── ORIGINAL LAKE RESEARCH MODULE FUNCTIONS ───

function sanitizeLakeId(name) {
  return String(name || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'unknown_lake';
}
__name(sanitizeLakeId, "sanitizeLakeId");

function lakeResearchMasterKey(lakeName) {
  return `lakes/${sanitizeLakeId(lakeName)}.json`;
}
__name(lakeResearchMasterKey, "lakeResearchMasterKey");

function lakeResearchVersionKey(lakeName, version) {
  return `lakes/versions/${sanitizeLakeId(lakeName)}/v${version}.json`;
}
__name(lakeResearchVersionKey, "lakeResearchVersionKey");

function lakePackageKey(lakeName, filename) {
  return `lake_packages/${sanitizeLakeId(lakeName)}/${filename}`;
}
__name(lakePackageKey, "lakePackageKey");

function extractJsonPossibly(txt) {
  if (!txt) return null;
  let t = String(txt).trim();
  // strip code fences
  t = t.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(t); } catch (_) {}
  // find first { ... last }
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s >=0 && e > s) {
    try { return JSON.parse(t.slice(s, e+1)); } catch (_) {}
  }
  return null;
}
__name(extractJsonPossibly, "extractJsonPossibly");

var RESEARCH_AGENTS = {
  identity: {
    label: "Lake Identity",
    order: 1,
    system: "You are a hydrologist and reservoir authority specialist. Research the lake using authoritative sources: USGS, USACE, EPA, State DNR, reservoir owners (Duke Energy, Dominion, Santee Cooper, USACE Savannah, etc). Return ONLY valid JSON. Never explain, never speculate, never estimate. Unknown numeric values must be exact numbers or null, never string approximations. Do not include fishing advice.",
    userTemplate: (lakeName, state, prev) => `Research the following lake using authoritative sources only.

Lake: ${lakeName}
State: ${state || 'USA'}

Return ONLY this JSON structure, no markdown, no commentary:
{
  "identity": {
    "lakeName": "${lakeName}",
    "aliases": ["alternate names"],
    "state": "${state || ''}",
    "county": "primary county or null",
    "riverSystem": "river system name e.g. Catawba-Wateree, Santee Cooper, Savannah River",
    "reservoirOwner": "owner operator e.g. Duke Energy, Dominion Energy, Santee Cooper, USACE",
    "surfaceAreaAcres": number or null,
    "maxDepthFt": number or null,
    "averageDepthFt": number or null,
    "elevationFt": number or null,
    "normalPoolFt": number or null,
    "gpsCenter": {"lat": number, "lon": number} or null,
    "type": "reservoir | natural | tidal etc",
    "archetype": "e.g. lowland river-run reservoir, highland deep reservoir, shallow stump-filled reservoir, deep clear herring lake, bowl-like",
    "damName": "dam name or null",
    "yearImpounded": number or null
  },
  "sources": [
    {"label":"USGS / Agency source...", "url":"https://...", "trust":"OFFICIAL"},
    {"label":"State DNR...", "url":"https://...", "trust":"OFFICIAL"}
  ]
}

CRITICAL: surfaceAreaAcres, maxDepthFt, averageDepthFt, elevationFt, normalPoolFt, and yearImpounded MUST be strict numbers or null (e.g. 13000, not "13,000 approx").
Trust values: OFFICIAL for USGS/USACE/EPA/State DNR/Owner, OFFICIAL_GIS for GIS, THIRD_PARTY for reports, MODEL for aggregates.
Only use supported sources. If uncertain, set field null and omit source.
Return JSON only.`,
    expectedKey: "identity"
  },
  limnology: {
    label: "Limnology",
    order: 2,
    system: "You are a limnologist. Describe how the lake behaves physically and chemically. Pay special attention to summer stratification, thermocline depths, oxygen depletion floors, and turbidity/color after rainfall. Never recommend fishing or tackle. Return ONLY JSON.",
    userTemplate: (lakeName, state, prev) => `Research limnology for:

Lake: ${lakeName}
State: ${state}

${prev?._extractedFacts?.filter(f => /limnology|thermocline|oxygen|clarity|secchi|trophic|color|turbid|stratif|depth|anoxic/i.test(f.category + ' ' + f.fact)).length > 0 ? `VERIFIED FACTS FROM OFFICIAL DOCUMENTS (use these as primary source — override training data):
${prev._extractedFacts.filter(f => /limnology|thermocline|oxygen|clarity|secchi|trophic|color|turbid|stratif|depth|anoxic/i.test(f.category + ' ' + f.fact)).map(f => `• ${f.fact} (Source: ${f.source})`).join('\n')}

` : ''}Previous Identity data (use for context):
${JSON.stringify(prev?.identity || prev || {}, null, 2).slice(0, 3000)}

Return ONLY:
{
  "limnology": {
    "waterClarity": {"typical":"Clear | Stained | Muddy after rain etc", "color":"", "secchiFt": number|null, "note":""},
    "thermocline": {"summerDepthFt": [12,18] or null, "strength":"weak | moderate | strong", "winterMix":"full | partial", "note":"detail seasonal thermal stratification"},
    "oxygen": {"depletionDepthFt": number|null, "anoxicBelowFt": number|null, "note":"summer/fall dissolved oxygen floor where fish cannot survive below"},
    "waterColor": "e.g. green tint, brown stain, red clay runoff after heavy rains",
    "flowCharacteristics": "river-run vs bowl, retention time, generation current effects",
    "seasonalDrawdownFt": number|null,
    "bottomHardness": "clay rock sand mud gravel etc",
    "mixingType": "dimictic, monomictic, polymictic etc or null",
    "phTypical": number|null,
    "trophicStatus": "oligotrophic | mesotrophic | eutrophic | null"
  },
  "sources": [{"label":"","url":"","trust":"OFFICIAL"}]
}
JSON only. No fishing advice.`,
    expectedKey: "limnology"
  },
  biology: {
    label: "Fisheries Biology",
    order: 3,
    system: "You are a fisheries biologist. Research the food chain, primary/secondary forage, baitfish seasonal movements, and predator gamefish for this lake. CRITICAL: You MUST ONLY list species that are explicitly mentioned in the provided extracted facts. Do NOT add species not supported by evidence. If the facts do not mention a species, it is NOT present in this lake. Never recommend tackle or fishing methods. Return ONLY JSON.",
    userTemplate: (lakeName, state, prev) => {
      const facts = prev?._extractedFacts || [];
      const biologyFacts = facts.filter(f => /biology|forage|species|predator|stocking|invasive|fisheries|shad|herring|bass|crappie|catfish|walleye|smallmouth|spotted/i.test(f.category || ''));
      // Limit to ~15k chars to avoid context overflow
      let factsText = biologyFacts.length > 0
        ? biologyFacts.map(f => `[${f.category}] ${f.fact} (source: ${f.source}, page ${f.page}, confidence ${f.confidence}%)\n  Quote: "${f.quote}"`).join('\n\n')
        : 'No biology-specific facts were extracted from documents. You must return empty/unknown fields — do NOT invent species.';
      if (factsText.length > 15000) factsText = factsText.slice(0, 15000) + '\n\n[TRIMMED — remaining facts omitted]';
      return `Research fisheries biology for:

Lake: ${lakeName}
State: ${state}

Context:
${JSON.stringify({identity: prev?.identity, limnology: prev?.limnology}, null, 2).slice(0, 3000)}

EXTRACTED FACTS FROM AUTHORITATIVE DOCUMENTS (your primary source of truth):
${factsText}

CRITICAL RULES:
- ONLY list species that are explicitly mentioned in the extracted facts above.
- If a species (e.g. Spotted Bass, Smallmouth Bass, Walleye) is NOT in the facts, do NOT include it.
- If no biology facts were extracted, return empty arrays/objects and null fields — never invent.
- The "..." placeholder in predatorSpecies is FORBIDDEN. Use an empty array [] if unknown.

Return ONLY:
{
  "biology": {
    "primaryForage": [{"species":"Threadfin Shad or Blueback Herring etc","abundance":"high | moderate | low","notes":"detail seasonal depth preferences"}],
    "secondaryForage": [{"species":"Gizzard Shad or Crawfish etc","abundance":"high | moderate | low","notes":""}],
    "predatorSpecies": ["Largemouth Bass","Striped Bass","Crappie","Catfish"],
    "speciesAbundance": {"Largemouth Bass":"moderate","Striped Bass":"high", "Crappie":"high"},
    "baitfishMovement": "seasonal migration between shallow creek arms in spring/fall and main river channel swings in summer/winter",
    "knownStockings": [{"species":"Striped Bass","agency":"SCDNR","year":2023,"note":""}],
    "invasiveSpecies": ["Blueback Herring","Hydrilla"],
    "forageCalendar": {"spring":"...", "summer":"...", "fall":"...", "winter":"..."}
  },
  "sources": [{"label":"","url":"","trust":"OFFICIAL"}]
}
JSON only. Never recommend tackle.`;
    },
    expectedKey: "biology"
  },
  habitat: {
    label: "Habitat",
    order: 4,
    system: "You are an aquatic habitat specialist. Map permanent fish habitat and structural features specific to this lake. No fishing advice. Return ONLY JSON.",
    userTemplate: (lakeName, state, prev) => `Research habitat for:

Lake: ${lakeName}
State: ${state}

Context:
${JSON.stringify({identity: prev?.identity, limnology: prev?.limnology}, null, 2).slice(0, 4000)}

Return ONLY:
{
  "habitat": {
    "bottomComposition": {"clay":"moderate","rock":"high","sand":"low","mud":"moderate","gravel":"moderate","note":""},
    "cover": ["standing timber","brush piles","docks","stumps","etc"],
    "vegetation": {"hydrilla":"none|low|moderate|high","grass":"...","milfoil":"...","lily":"...","note":""},
    "artificialHabitat": ["SCDNR fish attractors","brush piles","etc"],
    "structuralElements": {
      "points": "abundant | moderate | few - description e.g. long tapering red clay points",
      "humps": "description of offshore humps and island tops",
      "creekArms": "description of primary creek arms and feeder creeks",
      "channelLedges": "description of old river channel swings and drop-offs",
      "flats": "description of shallow flats",
      "bridges": "description of bridge pilings and causeways",
      "riprap": "description of riprap along dams and bridges"
    },
    "dockDensity": "low | medium | high",
    "bridgePilings": true,
    "standingTimber": "none | light | moderate | heavy — note specific creek arms or upper reaches",
    "notes": "overall habitat assessment"
  },
  "sources": [{"label":"","url":"","trust":"OFFICIAL_GIS"}]
}
JSON only.`,
    expectedKey: "habitat"
  },
  navigation: {
    label: "Navigation",
    order: 5,
    system: "You are a boating safety specialist. Identify safe navigation info, hazards, shoals, and boat ramps for this lake. Return ONLY JSON.",
    userTemplate: (lakeName, state, prev) => `Research navigation and boating safety for:

Lake: ${lakeName}
State: ${state}

Return ONLY:
{
  "navigation": {
    "ramps": [{"name":"Clearwater Cove or Lake Wateree State Park etc","lat":34.37,"lon":-80.72,"lanes":2}],
    "hazards": [{"type":"shoal|stump|timber|rock|dam","location":"upper river / creek mouths","description":"details on fluctuating water hazards or shallow stumps outside marked channel"}],
    "shoals": ["description of shallow shoals"],
    "standingTimberAreas": ["upper arms / specific creeks"],
    "bridgeHazards": ["low clearance at high pool for specific bridges"],
    "idleZones": ["near dam or marinas"],
    "dangerousAreas": ["below dam tailwater surge zone at generation"],
    "notes": "overall navigation safety and water level fluctuation warnings"
  },
  "sources": [{"label":"","url":"","trust":"OFFICIAL"}]
}
JSON only.`,
    expectedKey: "navigation"
  },
  regulations: {
    label: "Regulations",
    order: 6,
    system: "You are a fishing regulations specialist. You will be given the LIVE official regulations page content in _regsSource.content. READ THAT CONTENT CAREFULLY — do not use training data for specific limits. Extract ALL species rules from the page. For each species: check if the lake appears in an exception list. If the lake is listed in an exception, use that exception rule. If the lake is NOT listed as an exception, the statewide rule applies. Extract statewide rules AND any lake-specific exceptions. Return ONLY valid JSON. Never invent limits — if unknown after reading the page, set field null.",
    userTemplate: (lakeName, state, prev) => `Extract fishing regulations for this waterbody from the LIVE REGULATIONS PAGE provided below:

Lake: ${lakeName}
State: ${state || 'SC'}

LIVE REGULATIONS PAGE CONTENT:
${prev?._regsSource?.content ? prev._regsSource.content.slice(0, 10000) : 'Not available — use training data as fallback only'}

SOURCE URL: ${prev?._regsSource?.url || 'https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits'}

INSTRUCTIONS:
1. Read the regulations page content above carefully
2. For each species, find the row(s) that apply to ${lakeName}
3. If ${lakeName} is explicitly listed in an exception row, use that exception rule
4. If ${lakeName} is NOT listed in any exception, the statewide rule applies
5. Extract rules for ALL species: Largemouth Bass, Striped Bass, Hybrid Bass, White Bass, Crappie, Blue Catfish, Channel Catfish, Flathead Catfish, Bream, Redbreast Sunfish, Chain Pickerel, Yellow Perch
6. Note any closed seasons or special rules

Return ONLY this structure:
{
  "regulations": {
    "state": "${state || 'SC'}",
    "lastUpdated": "2026-07-10 estimated or null",
    "generalStateRegulations": {
      "lengthLimits": {"Largemouth Bass":"statewide limit e.g. 14in","Striped Bass":"statewide limit e.g. 26in","Crappie":"statewide limit"},
      "creelLimits": {"Largemouth Bass":"5","Striped Bass":"3","Crappie":"30"}
    },
    "lakeSpecificRegulations": {
      "hasExceptions": true,
      "creelLimits": {"Striped Bass": "specific creel limit for ${lakeName} if different from statewide, or same", "Crappie": "specific creel limit for ${lakeName} if different from statewide"},
      "sizeLimits": {"Striped Bass": "specific size/length limit for ${lakeName} if different e.g. no minimum size", "Largemouth Bass": "specific size limit for ${lakeName}"},
      "closedSeasons": [
        {"species": "Striped Bass or other", "period": "exact dates e.g. June 1 - Sept 30", "times": "applicable hours/times or all day", "note": "closure details e.g. lower lake closed or catch & release only"}
      ],
      "specialRules": ["Any other lake-specific rules, gear restrictions, or tailwater/dam sanctuary times"]
    },
    "lengthLimits": {"Largemouth Bass":"14in minimum (or lake specific)","Striped Bass":"Lake specific - see exceptions or statewide limit"},
    "creelLimits": {"Largemouth Bass":"5","Striped Bass":"Lake specific limit e.g. 10 or 3","Crappie":"Lake specific limit e.g. 20 or 30"},
    "protectedSpecies": ["Shortnose Sturgeon", "..."],
    "seasonalClosures": [{"species":"Striped Bass","period":"June 1 - Sept 30 if applicable","note":""}],
    "licenseRequirements": "State freshwater fishing license required...",
    "specialRegulations": ["List key lake specific rules and exceptions here as well"],
    "notes": "Always verify exact lake exceptions at official agency site before fishing.",
    "sourceUrl": "https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits"
  },
  "sources": [{"label":"SCDNR / Agency Regulations for ${lakeName}","url":"https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits","trust":"OFFICIAL"}]
}
Return JSON only. Never invent limits - if unknown, set field null.`,
    expectedKey: "regulations"
  },
  trolling: {
    label: "Trolling Intelligence",
    order: 7,
    system: "You are a fisheries biologist and professional trolling guide. You are given a verified lake profile containing limnology, biology, forage, habitat, and other sections. DO NOT SEARCH THE INTERNET. Use ONLY supplied JSON. Reference the biology/forage data extensively — use Threadfin Shad dominance, thermocline depth, oxygen depletion floor, and structural habitat data to inform your depth/structure/forage recommendations. Do NOT recommend routes, speeds, colors, or specific lures. CRITICAL: Only include species listed in the biology.predatorSpecies array. Do NOT add species not confirmed by biology. Return JSON only.",
    userTemplate: (lakeName, state, prev) => {
      const bio = prev?.biology || prev?.forage || {};
      const confirmedSpecies = Array.isArray(bio.predatorSpecies) ? bio.predatorSpecies : [];
      const speciesList = confirmedSpecies.length > 0 ? confirmedSpecies : ['(none confirmed — biology section empty)'];
      const speciesArrayStr = speciesList.map(s => `"${s}"`).join(', ');
      const exampleSpecies = speciesList[0] || 'SpeciesName';
      return `You are given a verified lake profile. Use ONLY this JSON - no internet.

Lake: ${lakeName}
Full profile so far (reference biology/forage, limnology including thermocline depth & oxygen floor, and habitat structure):
${JSON.stringify(prev, null, 2).slice(0, 12000)}

CONFIRMED SPECIES FROM BIOLOGY (ONLY these species — do not add others):
${speciesList.join(', ')}

Task: Translate lake science into long-term trolling intelligence. This is stable knowledge, not today's plan. Use the forage data (e.g. Threadfin Shad dominance), thermocline depth, oxygen depletion floor, and structural habitat from the profile to inform your recommendations.

CRITICAL: Only generate trolling intelligence for the confirmed species listed above. Do NOT invent species. If biology confirmed no species, return empty trollingIntelligence object.

Return ONLY:
{
  "trollingIntelligence": {
    "${exampleSpecies}": {
      "summer": {
        "preferredDepth": [12,18],
        "structures": ["channel ledges","creek mouths","long points"],
        "forage": ["Threadfin Shad"],
        "recommendedPresentations": ["MR Crankbait","DD Crankbait","A-Rig"],
        "notes": "general behavior — reference thermocline and oxygen floor if applicable"
      },
      "fall": {"preferredDepth":[8,15],"structures":[],"forage":[],"recommendedPresentations":[],"notes":""},
      "winter": {"preferredDepth":[20,35],"structures":[],"forage":[],"recommendedPresentations":[],"notes":""},
      "spring": {"preferredDepth":[5,15],"structures":[],"forage":[],"recommendedPresentations":[],"notes":""}
    }
  },
  "sources": [{"label":"Derived from lake profile","trust":"DERIVED"}]
}

Species list MUST be ONLY: [${speciesArrayStr}] — derived from biology.predatorSpecies. Do NOT add species not in this list.
preferredDepth MUST be a 2-element number array [minDepthFt, maxDepthFt] or null.
No speeds, no colors, no routes - only stable patterns.
JSON only.`;
    },
    expectedKey: "trollingIntelligence"
  },
  summary: {
    label: "AI Summary",
    order: 8,
    system: "You summarize a lake profile into a readable human description, max 500 words. Use only supplied JSON. Never invent facts. Return JSON with text field.",
    userTemplate: (lakeName, state, prev) => `Summarize this lake profile for a kayak angler. Max 500 words. Use only supplied JSON. Never invent facts.

Profile:
${JSON.stringify(prev, null, 2).slice(0, 15000)}

Return ONLY:
{
  "summary": {
    "text": "Lake Wateree is a lowland river-run reservoir... Primary trolling opportunities are ... Always check lake specific fishing regulations for season closures and creel limits before launching.",
    "keywords": ["river-run","striped bass","channel ledges","Threadfin Shad","regulations"]
  },
  "sources": [{"label":"Derived from lake profile","trust":"DERIVED"}]
}

Plain text summary in text field, no markdown headers, no bullet list - 2-3 paragraphs max.
JSON only.`,
    expectedKey: "summary"
  }
};

function calculateSectionConfidence(sources, hasData, sectionType) {
  if (!hasData) return { percent: 0, level: "missing", reason: "no data" };
  const src = Array.isArray(sources) ? sources : [];

  // ── Trolling / TrollingIntelligence — data-structure validated scoring ──
  // Trolling has no citable sources (fishing tactics aren't USGS-published),
  // so source-count scoring always under-reports. Instead, validate the output
  // structure: does it have species × season entries with depth/structure/forage?
  if (sectionType === 'trolling' || sectionType === 'trollingIntelligence') {
    const sectionData = arguments[3]; // passed by handleResearchAgent
    let speciesCount = 0, structuredSeasons = 0;
    if (sectionData && typeof sectionData === 'object') {
      for (const [species, seasons] of Object.entries(sectionData)) {
        if (typeof seasons !== 'object' || !seasons) continue;
        speciesCount++;
        for (const season of ['spring','summer','fall','winter']) {
          const s = seasons[season];
          if (s && typeof s === 'object') {
            const hasDepth = Array.isArray(s.preferredDepth) && s.preferredDepth.length === 2;
            const hasStruct = Array.isArray(s.structures) && s.structures.length > 0;
            const hasForage = Array.isArray(s.forage) && s.forage.length > 0;
            if (hasDepth && (hasStruct || hasForage)) structuredSeasons++;
          }
        }
      }
    }
    if (speciesCount >= 3 && structuredSeasons >= 6) return { percent: 80, level: "high", reason: `validated: ${speciesCount} species, ${structuredSeasons} structured seasons`, trollingValidation: true };
    if (speciesCount >= 2 && structuredSeasons >= 3) return { percent: 65, level: "medium", reason: `validated: ${speciesCount} species, ${structuredSeasons} structured seasons`, trollingValidation: true };
    if (speciesCount >= 1 && structuredSeasons >= 1) return { percent: 50, level: "low", reason: `validated: ${speciesCount} species, ${structuredSeasons} structured seasons`, trollingValidation: true };
    // Fall through to source-count scoring if structure is empty
  }

  // ── Regulations — data-structure validation for general statewide limits + lake-specific exceptions ──
  if (sectionType === 'regulations') {
    const sectionData = arguments[3];
    if (sectionData && typeof sectionData === 'object') {
      const hasLakeSpecific = sectionData.lakeSpecificRegulations && typeof sectionData.lakeSpecificRegulations === 'object';
      const hasGeneralState = sectionData.generalStateRegulations && typeof sectionData.generalStateRegulations === 'object';
      const hasClosedSeasons = (hasLakeSpecific && Array.isArray(sectionData.lakeSpecificRegulations.closedSeasons)) || Array.isArray(sectionData.seasonalClosures);
      let officialSources = 0;
      for (const s of src) {
        if (String(s.trust||'').toUpperCase().includes('OFFICIAL') || /DNR|WILDLIFE|FISHREGS|CODE|AGENCY/.test(String(s.label||'').toUpperCase())) officialSources++;
      }
      if (hasLakeSpecific && hasGeneralState && officialSources >= 1) {
        const pct = Math.min(99, 85 + (officialSources > 1 ? 8 : 0) + (hasClosedSeasons ? 5 : 0));
        return { percent: pct, level: pct >= 95 ? "very high" : "high", reason: `validated: state limits + lake exceptions (${officialSources} official sources)`, regulationsValidation: true };
      }
      if ((hasLakeSpecific || hasGeneralState) && officialSources >= 1) {
        return { percent: 75, level: "medium", reason: `validated regulations structure (${officialSources} official sources)`, regulationsValidation: true };
      }
    }
  }

  if (!src.length) return { percent: 45, level: "low", reason: "no sources, AI estimate" };
  let score = 0;
  let official = 0, secondary = 0, model = 0, derived = 0;
  for (const s of src) {
    const trust = String(s.trust || '').toUpperCase();
    const label = String(s.label || '').toUpperCase();
    if (trust.includes('OFFICIAL') || /USGS|USACE|EPA|DNR|WILDLIFE|DUKE|DOMINION|SANTEE|SAVANNAH|CORPS/.test(label)) {
      score += 30; official++;
    } else if (trust.includes('DERIVED')) {
      score += 20; derived++;
    } else if (trust.includes('OFFICIAL_GIS') || trust.includes('THIRD_PARTY') || /SURVEY|FISH|REPORT|SAMPLE/.test(label)) {
      score += 15; secondary++;
    } else {
      score += 5; model++;
    }
  }
  // bonus for multiple agreeing sources
  if (official >= 3) score += 20;
  else if (official >=2) score += 10;
  else if (official >=1 && secondary >=1) score += 8;
  if (src.length >=3) score += 10;
  else if (src.length >=2) score += 5;

  let pct = Math.min(99, Math.max(10, score));
  // cap based on source quality
  if (official ===0 && secondary ===0) pct = Math.min(pct, 65);
  if (official ===0 && derived===0) pct = Math.min(pct, 75);

  let level = "low";
  if (pct >= 95) level = "very high";
  else if (pct >= 85) level = "high";
  else if (pct >= 70) level = "medium";
  else if (pct >= 50) level = "low";
  else level = "needs review";

  return {
    percent: pct,
    level,
    officialCount: official,
    secondaryCount: secondary,
    totalSources: src.length,
    reason: `${official} official, ${secondary} secondary, ${src.length} total`
  };
}
__name(calculateSectionConfidence, "calculateSectionConfidence");

async function handleResearchAgent(request, env) {
  let body;
  try { body = await request.json(); } catch { return new Response(JSON.stringify({success:false, error:"invalid JSON body"}), {status:400, headers:JSON_HEADERS}); }
  const lakeName = String(body.lakeName || body.lake || '').trim();
  const state = String(body.state || '').trim() || 'SC';
  const agentKey = String(body.agent || '').trim().toLowerCase();
  const previousResults = body.previousResults || body.context || {};
  if (!lakeName) return new Response(JSON.stringify({success:false, error:"missing lakeName"}), {status:400, headers:JSON_HEADERS});
  const agent = RESEARCH_AGENTS[agentKey];
  if (!agent) return new Response(JSON.stringify({success:false, error:`unknown agent ${agentKey}. Valid: ${Object.keys(RESEARCH_AGENTS).join(', ')}`}), {status:400, headers:JSON_HEADERS});

  // Ground identity agent with known LAKES constant to reduce hallucination
  let groundedPrev = previousResults;
  if (agentKey === 'identity') {
    const lookupKey = lakeKeyFromName(lakeName);
    const known = LAKES[lookupKey];
    if (known) {
      groundedPrev = {...previousResults, _knownBaseline: {lakeKey: lookupKey, ...known, note:"This is TrollMap curated baseline — verify against official sources, don't trust blindly"}};
    }
  }

  // Ground regulations agent with live eRegulations page — replaces LLM memory with actual current rules
  if (agentKey === 'regulations') {
    const regsUrls = {
      SC: 'https://www.eregulations.com/southcarolina/fishing/freshwater-fish-size-possession-limits',
      NC: 'https://www.eregulations.com/northcarolina/fishing/freshwater-fishing-regulations',
      GA: 'https://www.eregulations.com/georgia/fishing/freshwater-fishing-regulations',
    };
    const regsUrl = regsUrls[state] || regsUrls.SC;
    try {
      const regsRes = await fetch(regsUrl, {
        headers: { 'User-Agent': 'TrollMap/15 Evidence Engine', 'Accept': 'text/html' },
        cf: { cacheTtl: 86400, cacheEverything: true }
      });
      if (regsRes.ok) {
        let regsText = await regsRes.text();
        regsText = regsText
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s{2,}/g, ' ')
          .trim()
          .slice(0, 12000);
        groundedPrev = {
          ...previousResults,
          _regsSource: {
            url: regsUrl,
            content: regsText,
            note: 'LIVE OFFICIAL REGULATIONS PAGE — use this as authoritative source. Extract ALL species rules that apply to ' + lakeName + '. For statewide rules, check if ' + lakeName + ' appears in any exception list. If not listed as an exception, the statewide rule applies. Do NOT use training data for specific limits.'
          }
        };
      }
    } catch (e) {
      console.warn('Regulations page fetch failed: ' + e.message);
    }
  }

  const systemPrompt = agent.system;
  const userPrompt = agent.userTemplate(lakeName, state, groundedPrev);

  const payload = {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.15,
    max_tokens: agentKey === 'trolling' ? 2000 : agentKey === 'summary' ? 800 : 1500,
    response_format: { type: "json_object" }
  };

  const start = Date.now();
  let llmResult;
  try {
    // Route identity and limnology through Gemini to preserve Groq 120b budget for later agents
    // Gemini handles factual/encyclopedic tasks well — ideal for lake facts and water science
    const useGemini = (agentKey === 'identity' || agentKey === 'limnology') && env.GEMINI_API_KEY;
    llmResult = await callLLM(env, payload, useGemini ? 'gemini' : null);
  } catch (e) {
    return new Response(JSON.stringify({success:false, error:`LLM failed: ${e.message}`, agent: agentKey, lakeName}), {status: 502, headers: JSON_HEADERS});
  }
  const rawText = extractLLMText(llmResult.data);
  const parsed = extractJsonPossibly(rawText);
  if (!parsed) {
    return new Response(JSON.stringify({success:false, error:"Agent returned non-JSON", raw: rawText.slice(0, 800), agent: agentKey}), {status: 502, headers: JSON_HEADERS});
  }

  const dataKey = agent.expectedKey;
  const sectionData = (parsed[dataKey] && Object.keys(parsed[dataKey]).length > 0) ? parsed[dataKey] : (parsed[agentKey] && Object.keys(parsed[agentKey] || {}).length > 0) ? parsed[agentKey] : parsed;
  const sources = parsed.sources || sectionData?.sources || [];
  const hasData = sectionData && (typeof sectionData === 'object' ? Object.keys(sectionData).filter(k => k !== 'sources').length > 0 : true);
  const confidence = calculateSectionConfidence(sources, hasData, agentKey, sectionData);

  return new Response(JSON.stringify({
    success: true,
    agent: agentKey,
    label: agent.label,
    order: agent.order,
    lakeName,
    state,
    data: parsed,
    section: sectionData,
    sectionKey: dataKey,
    sources,
    confidence,
    meta: {
      provider: llmResult.provider,
      model: llmResult.model,
      durationMs: Date.now() - start,
      timestamp: new Date().toISOString()
    },
    raw: rawText.slice(0, 2000)
  }), {headers: JSON_HEADERS});
}
__name(handleResearchAgent, "handleResearchAgent");

async function handleResearchList(env) {
  const prefix = "lakes/";
  let cursor;
  const masters = [];
  const versions = [];
  do {
    const listed = await env.R2_TROLLMAP_CHARTPACKS.list({ prefix, cursor });
    for (const obj of listed.objects) {
      if (obj.key.includes("/versions/")) {
        versions.push({key: obj.key, size: obj.size, uploaded: obj.uploaded});
      } else if (obj.key.startsWith("lakes/") && obj.key.endsWith(".json") && !obj.key.includes("lake_packages")) {
        masters.push({key: obj.key, size: obj.size, uploaded: obj.uploaded, id: obj.key.replace(/^lakes\//,'').replace(/\.json$/,'')});
      }
    }
    cursor = listed.truncated ? listed.cursor : null;
  } while (cursor);
  masters.sort((a,b)=>a.key.localeCompare(b.key));
  return new Response(JSON.stringify({ok:true, count: masters.length, lakes: masters, versionFiles: versions.length, timestamp: new Date().toISOString()}), {headers: JSON_HEADERS});
}
__name(handleResearchList, "handleResearchList");

async function handleResearchGet(env, lakeId) {
  const safe = sanitizeLakeId(lakeId);
  const masterKey = `lakes/${safe}.json`;
  const obj = await env.R2_TROLLMAP_CHARTPACKS.get(masterKey);
  if (!obj) return new Response(JSON.stringify({ok:false, error:`no profile for ${lakeId} (${safe})`}), {status:404, headers:JSON_HEADERS});
  const text = await obj.text();
  let data;
  try { data = JSON.parse(text); } catch { data = {raw:text}; }
  // also try to list package files
  let packageFiles = [];
  try {
    const pkgListed = await env.R2_TROLLMAP_CHARTPACKS.list({prefix: `lake_packages/${safe}/`});
    packageFiles = pkgListed.objects.map(o=>({key:o.key, size:o.size, name:o.key.split('/').pop()}));
  } catch {}
  let versionList = [];
  try {
    const vListed = await env.R2_TROLLMAP_CHARTPACKS.list({prefix: `lakes/versions/${safe}/`});
    versionList = vListed.objects.map(o=>({key:o.key, size:o.size, version: (o.key.match(/v(\d+)\.json/)||[])[1]||null})).sort((a,b)=> (parseInt(b.version||0)-parseInt(a.version||0)));
  } catch {}
  return new Response(JSON.stringify({ok:true, lakeId: lakeId, sanitized: safe, masterKey, profile: data, packageFiles, versions: versionList}), {headers: JSON_HEADERS});
}
__name(handleResearchGet, "handleResearchGet");

async function handleResearchSave(request, env) {
  let body;
  try { body = await request.json(); } catch { return new Response(JSON.stringify({ok:false, error:"invalid JSON"}), {status:400, headers:JSON_HEADERS}); }
  const lakeName = String(body.lakeName || body.profile?.lakeName || body.profile?.identity?.lakeName || '').trim();
  if (!lakeName) return new Response(JSON.stringify({ok:false, error:"missing lakeName"}), {status:400, headers:JSON_HEADERS});
  const safe = sanitizeLakeId(lakeName);
  const incomingProfile = body.profile || body;
  const packageParts = body.packageParts || body.parts || {};
  const notes = body.notes || incomingProfile.notes || "";

  // Determine next version
  let nextVersion = 1;
  let existingMeta = null;
  try {
    const existingObj = await env.R2_TROLLMAP_CHARTPACKS.get(`lakes/${safe}.json`);
    if (existingObj) {
      const txt = await existingObj.text();
      const existing = JSON.parse(txt);
      existingMeta = existing.metadata || {};
      const v = parseInt(existingMeta.version || existingMeta.versionNumber || 0);
      if (v) nextVersion = v+1;
      else {
        // list versions to find max
        const vList = await env.R2_TROLLMAP_CHARTPACKS.list({prefix:`lakes/versions/${safe}/`});
        let maxV = 0;
        for (const o of vList.objects) {
          const m = o.key.match(/v(\d+)\.json/);
          if (m) maxV = Math.max(maxV, parseInt(m[1]));
        }
        nextVersion = maxV+1 || 2;
      }
    }
  } catch {}

  // Calculate confidence per section if not provided
  // Canonical sections only — skip aliased duplicates (forage=biology, trollingIntelligence=trolling)
  const sections = ["identity","limnology","biology","habitat","navigation","regulations","trolling","summary"];
  const confidence = incomingProfile.confidence || {};
  const sources = incomingProfile.sources || [];
  // build overall confidence
  let confSum = 0, confCount = 0;
  for (const sec of sections) {
    const secData = incomingProfile[sec] || packageParts[sec];
    if (secData) {
      if (!confidence[sec]) {
        // Look for sources on the section data or use incomingProfile sources
        const src = (typeof secData === 'object' && secData.sources) || incomingProfile.sources || [];
        const calc = calculateSectionConfidence(src, true, sec, secData);
        confidence[sec] = calc;
      }
      if (confidence[sec]?.percent) { confSum += confidence[sec].percent; confCount++; }
    }
  }
  // Remove any aliased duplicate confidence keys that would bloat the object
  delete confidence.forage;
  delete confidence.trollingIntelligence;
  let overallConf = confCount ? Math.round(confSum/confCount) : 75;

  // Merge master profile per spec section 6
  const now = new Date().toISOString();
  const master = {
    lakeName: incomingProfile.lakeName || lakeName,
    aliases: incomingProfile.aliases || incomingProfile.identity?.aliases || [],
    state: incomingProfile.state || packageParts.identity?.state || "",
    riverSystem: incomingProfile.riverSystem || incomingProfile.identity?.riverSystem || "",
    archetype: incomingProfile.archetype || incomingProfile.identity?.archetype || "",
    surfaceAreaAcres: incomingProfile.surfaceAreaAcres ?? incomingProfile.identity?.surfaceAreaAcres ?? null,
    maxDepthFt: incomingProfile.maxDepthFt ?? incomingProfile.identity?.maxDepthFt ?? null,
    averageDepthFt: incomingProfile.averageDepthFt ?? incomingProfile.identity?.averageDepthFt ?? null,
    limnology: incomingProfile.limnology || packageParts.limnology || {},
    forage: incomingProfile.forage || incomingProfile.biology || packageParts.biology || packageParts.forage || {},
    biology: incomingProfile.biology || incomingProfile.forage || {},
    habitat: incomingProfile.habitat || packageParts.habitat || {},
    navigation: incomingProfile.navigation || packageParts.navigation || {},
    regulations: incomingProfile.regulations || packageParts.regulations || {},
    trolling: incomingProfile.trolling || incomingProfile.trollingIntelligence || packageParts.trolling || packageParts.trollingIntelligence || null,
    trollingIntelligence: incomingProfile.trollingIntelligence || incomingProfile.trolling || null,
    summary: incomingProfile.summary || packageParts.summary || {},
    evidence: incomingProfile.evidence || packageParts.evidence || {},
    sources: incomingProfile.sources || sources || [],
    confidence: {...confidence, overall: {percent: overallConf, level: overallConf>=95?'very high':overallConf>=85?'high':overallConf>=70?'medium':'low'}},
    metadata: {
      version: `${nextVersion}.0`,
      versionNumber: nextVersion,
      status: incomingProfile.metadata?.status || body.status || (nextVersion===1?"draft":"verified"),
      lastUpdated: now,
      createdAt: existingMeta?.createdAt || now,
      createdBy: body.requestedBy || incomingProfile.metadata?.createdBy || "Ryan",
      verified: !!(body.verified || incomingProfile.metadata?.verified),
      verifiedAt: body.verified ? now : (existingMeta?.verifiedAt||null),
      lakeId: safe,
      previousVersion: existingMeta?.version || null
    },
    notes: notes,
    researchLog: incomingProfile.researchLog || body.researchLog || {requestTime: now, completedAgents: Object.keys(packageParts)},
    _extractedFacts: incomingProfile._extractedFacts || [],
    _extractedFactsCount: incomingProfile._extractedFactsCount || (incomingProfile._extractedFacts || []).length,
    _wqpLimnology: incomingProfile._wqpLimnology || null
  };

  // Ensure metadata status logic: first save draft -> user approves to verified via approve endpoint, but allow direct verified if requested
  if (body.approve || body.status === 'verified') {
    master.metadata.status = 'verified';
    master.metadata.verified = true;
    master.metadata.verifiedAt = now;
  }

  const masterJson = JSON.stringify(master, null, 2);
  if (masterJson.length > 250*1024) {
    console.warn(`Lake profile ${safe} exceeds 250KB: ${masterJson.length}`);
  }

  // Save current master
  await env.R2_TROLLMAP_CHARTPACKS.put(`lakes/${safe}.json`, masterJson, {
    httpMetadata: {contentType:"application/json"},
    customMetadata: {version: String(nextVersion), status: master.metadata.status, lakeName: lakeName, updated: now}
  });
  // Save version copy
  await env.R2_TROLLMAP_CHARTPACKS.put(`lakes/versions/${safe}/v${nextVersion}.json`, masterJson, {
    httpMetadata: {contentType:"application/json"},
    customMetadata: {version: String(nextVersion), lakeName: lakeName}
  });

  // Save package parts (hybrid)
  const partKeys = ['identity','limnology','biology','forage','habitat','navigation','regulations','trolling','trollingIntelligence','summary','evidence'];
  for (const k of partKeys) {
    const partData = packageParts[k] || master[k];
    if (partData) {
      await env.R2_TROLLMAP_CHARTPACKS.put(`lake_packages/${safe}/${k}.json`, JSON.stringify(partData, null, 2), {
        httpMetadata: {contentType:"application/json"},
        customMetadata: {lakeName, version: String(nextVersion)}
      });
    }
  }
  // Save sources, research_log, metadata as separate files for Inspector
  await env.R2_TROLLMAP_CHARTPACKS.put(`lake_packages/${safe}/sources.json`, JSON.stringify(master.sources||[], null, 2), {httpMetadata:{contentType:"application/json"}});
  await env.R2_TROLLMAP_CHARTPACKS.put(`lake_packages/${safe}/metadata.json`, JSON.stringify(master.metadata, null, 2), {httpMetadata:{contentType:"application/json"}});
  await env.R2_TROLLMAP_CHARTPACKS.put(`lake_packages/${safe}/evidence.json`, JSON.stringify(master.evidence||{}, null, 2), {httpMetadata:{contentType:"application/json"}});
  await env.R2_TROLLMAP_CHARTPACKS.put(`lake_packages/${safe}/research_log.json`, JSON.stringify(master.researchLog||{}, null, 2), {httpMetadata:{contentType:"application/json"}});
  if (master.notes) {
    await env.R2_TROLLMAP_CHARTPACKS.put(`lake_packages/${safe}/notes.md`, String(master.notes), {httpMetadata:{contentType:"text/markdown"}});
  }

  return new Response(JSON.stringify({ok:true, lakeId: safe, lakeName, version: nextVersion, masterKey: `lakes/${safe}.json`, overallConfidence: overallConf, status: master.metadata.status, bytes: masterJson.length}), {headers: JSON_HEADERS});
}
__name(handleResearchSave, "handleResearchSave");

async function handleResearchApprove(request, env) {
  let body;
  try { body = await request.json(); } catch { return new Response(JSON.stringify({ok:false, error:"invalid JSON"}), {status:400, headers:JSON_HEADERS}); }
  const lakeName = String(body.lakeName || body.lake || '').trim();
  if (!lakeName) return new Response(JSON.stringify({ok:false, error:"missing lakeName"}), {status:400, headers:JSON_HEADERS});
  const safe = sanitizeLakeId(lakeName);
  const masterKey = `lakes/${safe}.json`;
  const obj = await env.R2_TROLLMAP_CHARTPACKS.get(masterKey);
  if (!obj) return new Response(JSON.stringify({ok:false, error:`no profile for ${lakeName}`}), {status:404, headers:JSON_HEADERS});
  const txt = await obj.text();
  let profile;
  try { profile = JSON.parse(txt); } catch { return new Response(JSON.stringify({ok:false, error:"corrupt JSON"}), {status:500, headers:JSON_HEADERS}); }
  profile.metadata = profile.metadata||{};
  profile.metadata.status = "verified";
  profile.metadata.verified = true;
  profile.metadata.verifiedAt = new Date().toISOString();
  profile.metadata.approvedBy = body.approvedBy || "Ryan";
  if (body.notes) profile.notes = body.notes;
  const newJson = JSON.stringify(profile, null, 2);
  await env.R2_TROLLMAP_CHARTPACKS.put(masterKey, newJson, {httpMetadata:{contentType:"application/json"}, customMetadata:{version: String(profile.metadata.versionNumber||profile.metadata.version||1), status:"verified"}});
  // also save as new version? keep same version but mark verified
  return new Response(JSON.stringify({ok:true, lakeId: safe, lakeName, status:"verified", version: profile.metadata.version||profile.metadata.versionNumber}), {headers: JSON_HEADERS});
}
__name(handleResearchApprove, "handleResearchApprove");

async function handleResearchDelete(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const lakeName = String(body.lakeName || body.lake || '').trim();
  if (!lakeName) return new Response(JSON.stringify({ ok:false, error:'missing lakeName' }), { status:400, headers:JSON_HEADERS });
  const safe = sanitizeLakeId(lakeName);
  const keys = [`lakes/${safe}.json`];
  try {
    const pkg = await env.R2_TROLLMAP_CHARTPACKS.list({ prefix: `lake_packages/${safe}/` });
    for (const o of pkg.objects) keys.push(o.key);
  } catch {}
  try {
    const vers = await env.R2_TROLLMAP_CHARTPACKS.list({ prefix: `lakes/versions/${safe}/` });
    for (const o of vers.objects) keys.push(o.key);
  } catch {}
  for (const key of keys) {
    try { await env.R2_TROLLMAP_CHARTPACKS.delete(key); } catch {}
  }
  return new Response(JSON.stringify({ ok:true, lakeName, deleted: keys.length }), { headers: JSON_HEADERS });
}
__name(handleResearchDelete, "handleResearchDelete");

async function handleResearchPackage(env, lakeId) {
  const safe = sanitizeLakeId(lakeId);
  const listed = await env.R2_TROLLMAP_CHARTPACKS.list({prefix: `lake_packages/${safe}/`});
  if (!listed.objects.length) return new Response(JSON.stringify({ok:false, error:`no package for ${lakeId}`}), {status:404, headers:JSON_HEADERS});
  const files = [];
  for (const o of listed.objects) {
    files.push({key:o.key, name:o.key.split('/').pop(), size:o.size, uploaded:o.uploaded});
  }
  files.sort((a,b)=>a.name.localeCompare(b.name));
  return new Response(JSON.stringify({ok:true, lakeId: lakeId, sanitized: safe, count: files.length, files}), {headers: JSON_HEADERS});
}
__name(handleResearchPackage, "handleResearchPackage");

async function handleResearchPackageFile(env, lakeId, filename) {
  const safe = sanitizeLakeId(lakeId);
  const key = `lake_packages/${safe}/${filename}`;
  const obj = await env.R2_TROLLMAP_CHARTPACKS.get(key);
  if (!obj) return new Response(JSON.stringify({ok:false, error:`no file ${filename} for ${lakeId}`}), {status:404, headers:JSON_HEADERS});
  const body = await obj.arrayBuffer();
  const ct = filename.endsWith('.json') ? 'application/json' : filename.endsWith('.md') ? 'text/markdown' : 'application/octet-stream';
  return new Response(body, {headers: {...CORS, "Content-Type": ct, "Cache-Control":"no-store"}});
}
__name(handleResearchPackageFile, "handleResearchPackageFile");

async function handleEnhancedLakeIntel(lakeName, env) {
  // merges curated LAKE_INTEL with researched profile if exists
  const key = lakeKeyFromName(lakeName);
  const curated = await getLakeIntel(lakeName);
  let researched = null;
  let researchedProfile = null;
  try {
    const safe = sanitizeLakeId(lakeName);
    // try full lakeName sanitized, then key sanitized
    let obj = await env.R2_TROLLMAP_CHARTPACKS.get(`lakes/${safe}.json`);
    if (!obj) {
      const safeKey = sanitizeLakeId(key);
      obj = await env.R2_TROLLMAP_CHARTPACKS.get(`lakes/${safeKey}.json`);
    }
    if (obj) {
      const txt = await obj.text();
      researchedProfile = JSON.parse(txt);
      researched = {
        exists: true,
        lakeName: researchedProfile.lakeName,
        version: researchedProfile.metadata?.version,
        status: researchedProfile.metadata?.status,
        lastUpdated: researchedProfile.metadata?.lastUpdated,
        overallConfidence: researchedProfile.confidence?.overall,
        summary: researchedProfile.summary,
        trollingIntelligence: researchedProfile.trollingIntelligence || researchedProfile.trolling,
        fullProfile: researchedProfile
      };
    }
  } catch {}
  return {...curated, researched, hasResearchedProfile: !!researched};
}
__name(handleEnhancedLakeIntel, "handleEnhancedLakeIntel");

var trollmap_worker_default = {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const lake = (url.searchParams.get("lake") || "").toLowerCase();
    try {
      if (path === "/identify-catch" && request.method === "POST") {
        try {
          const analysis = await handleIdentifyCatch(request, env);
          return new Response(JSON.stringify({ success: true, analysis }), { headers: JSON_HEADERS });
        } catch (err) {
          return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: JSON_HEADERS });
        }
      }
      if (path === "/identify-catch-v2" && request.method === "POST") {
        try {
          return await handleIdentifyCatchV2(request, env);
        } catch (err) {
          return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: JSON_HEADERS });
        }
      }
      if (path === "/audit-plan" && request.method === "POST") {
        try {
          const body = await request.json();
          const SYSTEM_PROMPT = `You are a crusty, veteran South Carolina fishing guide. You have zero patience for "textbook" plans that make no tactical sense in the real world. You speak plainly and critically.

ANGLER PROFILE \u2014 apply these constraints strictly:
- Watercraft: Native Watersports Slayer Propel Max 12.5 pedal kayak + NK180 Pro 24V bow-mount trolling motor
- Rods: Spinning rods ONLY. A-rigs on spinning rods are confirmed working gear.
- No lead-core, no conventional reels, no planer boards, no downriggers
- Depth control: Lead length only.
- Max 2 rods in the water simultaneously.
- Trolling-first angler.
- Freshwater live bait: NOT available (no livewell).

TACTICAL AUDIT RULES \u2014 Flag these as MAJOR ERRORS:
1. DEPTH MISMATCHES: 
   - Flag any A-Rig or Deep Crankbait running shallower than 10-12ft. (Trolling an A-Rig at 5ft is a waste of time).
   - Flag any lure with a max dive of 15ft being run in 25ft of water without clear rationale.
   - Flag any "Deep" lure running too deep for the target species/season (e.g., Stripers in summer usually stack 16-20ft; 30ft is too deep).
2. LURE MISMATCHES:
   - If the plan calls for "Shallow" water (<10ft) but uses an A-Rig, flag it. Suggest Squarebills, Lipless, Spinnerbaits, or Topwater.
3. LOGIC GAPS:
   - If the plan suggests "Dawn" tactics but uses deep-water lures at depths that don't match morning schooling behavior.

CRITIQUE FORMAT \u2014 respond ONLY with valid JSON, no markdown fences:
{
  "overall_score": <1-10>,
  "confidence": "<high|medium|low>",
  "verdict": "<one punchy, honest sentence overall take>",
  "scores": {
    "depth_alignment": <1-10>,
    "lure_selection": <1-10>,
    "speed_cadence": <1-10>,
    "battery_management": <1-10>,
    "safety": <1-10>
  },
  "flags": ["<specific tactical error>", ...],
  "fixes": ["<actionable professional fix>", ...],
  "keeper_moves": ["<what actually makes sense>", ...],
  "local_intel": "<one SC-specific tip the plan missed>"
}

Be direct. If the plan is tactically stupid, say so. Keep flags and fixes to 2-3 items each.`;
          const p = body.plan || body;
          const meta = p.meta || p;
          const spread = (p.spread || []).map((r2) => ({
            side: r2.side,
            position: r2.position,
            rod: r2.rod || "",
            reel: r2.reel || "",
            lure: r2.lure || r2.notes?.split("\xB7")[0]?.trim() || "",
            depth: r2.depth,
            lead: r2.lead,
            notes: r2.notes?.slice(0, 120) || ""
          })).filter((r2) => r2.lure || r2.notes);
          const cleanPlan = {
            lake: meta.lake || p.lake,
            species: meta.species || p.species,
            date: meta.date || p.date,
            ramp: meta.ramp || p.ramp,
            launchTime: meta.launchTime || p.launchTime,
            returnTime: meta.returnTime || p.returnTime,
            waterTemp: meta.waterTemp || p.waterTemp ? `${meta.waterTemp || p.waterTemp}` : null,
            poolLevel: meta.poolLevel || p.poolLevel || null,
            weather: meta.weather || p.weather || "",
            clarity: meta.clarity || p.clarity || "",
            motor: meta.motor || p.motor || "",
            solunar: meta.solunar || p.solunar || "",
            spread: spread.slice(0, 6),
            tackle: p.tackle || "",
            safety: p.safety || "",
            notes: p.notes || "",
            rationale: (p.rationale || "").slice(0, 1500)
            // first 800 chars of rationale only
          };
          const userMessage = `Audit this trolling plan. Apply the angler profile constraints strictly \u2014 flag anything that assumes gear or bait this angler does not have. Identify the single most dangerous safety gap if any. Return ONLY the JSON object described in your system prompt.

PLAN DATA:
${JSON.stringify(cleanPlan, null, 2)}`;
          const payload = {
            model: "openai/gpt-oss-120b",
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: userMessage }
            ],
            temperature: 0.15,
            response_format: { type: "json_object" }
          };
          const { data } = await callLLM(env, payload, "groq");
          let audit = {};
          try {
            audit = JSON.parse(data.choices?.[0]?.message?.content || "{}");
          } catch (_) {
            audit = { error: "parse failed", raw: data.choices?.[0]?.message?.content };
          }
          return new Response(JSON.stringify({ success: true, audit }), { headers: JSON_HEADERS });
        } catch (err) {
          return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: JSON_HEADERS });
        }
      }
      if (path === "/coach-plan" && request.method === "POST") {
        return handleCoachPlan(request, env);
      }
      if (path === "/groq-query" && request.method === "POST") {
        try {
          const body = await request.json();
          const { messages, model, max_tokens = 200, temperature = 0.2, response_format } = body;
          if (!messages?.length) return new Response(JSON.stringify({ error: "Missing messages" }), { status: 400, headers: JSON_HEADERS });
          const { provider, model: usedModel, data } = await callLLM(env, { messages, model, max_tokens, temperature, response_format });
          const headers = { ...JSON_HEADERS, "X-LLM-Provider": provider, "X-LLM-Model": usedModel };
          // Attach provider info to payload for frontend debugging without breaking OpenAI shape
          if (data && typeof data === "object" && !data._trollmap) {
            data._trollmap = { provider, model: usedModel };
          }
          return new Response(JSON.stringify(data), { headers });
        } catch (e) {
          return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: JSON_HEADERS });
        }
      }
      // ── LAKE RESEARCH ROUTES ─────────────────────────────────────
      if (path === "/research/limnology-data" && request.method === "POST") {
        return handleResearchLimnologyData(request, env);
      }
      if (path === "/research/deterministic-facts" && request.method === "POST") {
        return handleResearchDeterministicFacts(request, env);
      }
      if (path === "/research/discover" && request.method === "POST") {
        return handleResearchDiscover(request, env);
      }
      if (path === "/research/dataset-hunt" && request.method === "POST") {
        return handleResearchDatasetHunt(request, env);
      }
      if (path === "/research/proxy-download" && request.method === "GET") {
        return handleResearchProxyDownload(request, env);
      }
      if (path === "/research/get-normalized" && request.method === "GET") {
        const lake = url.searchParams.get("lake") || url.searchParams.get("lakeName") || "";
        if (!lake) return new Response(JSON.stringify({ok:false, error:"missing lake param"}), {status:400, headers:JSON_HEADERS});
        return handleResearchGetNormalized(env, lake);
      }
      if (path === "/research/save-normalized" && request.method === "POST") {
        return handleResearchSaveNormalized(request, env);
      }
      if (path === "/research/analyze-facts" && request.method === "POST") {
        return handleResearchAnalyzeFacts(request, env);
      }
      if (path === "/research/dedupe-contradictions" && request.method === "POST") {
        return handleResearchDedupeContradictions(request, env);
      }
      if (path === "/research/map-facts" && request.method === "POST") {
        return handleResearchMapFacts(request, env);
      }
      if (path === "/research/gap-analysis" && request.method === "POST") {
        return handleResearchGapAnalysis(request, env);
      }
      if (path === "/research/gap-search" && request.method === "POST") {
        return handleResearchGapSearch(request, env);
      }
      if (path === "/research/agent" && request.method === "POST") {
        return handleResearchAgent(request, env);
      }
      if ((path === "/research/list" || path === "/lakes/list") && request.method === "GET") {
        return handleResearchList(env);
      }
      if (path === "/research/get" && request.method === "GET") {
        const lake = url.searchParams.get("lake") || url.searchParams.get("lakeName") || "";
        if (!lake) return new Response(JSON.stringify({ok:false, error:"missing lake param"}), {status:400, headers:JSON_HEADERS});
        return handleResearchGet(env, lake);
      }
      if (path === "/research/save" && request.method === "POST") {
        return handleResearchSave(request, env);
      }
      if (path === "/research/approve" && request.method === "POST") {
        return handleResearchApprove(request, env);
      }
      if (path === "/research/delete" && request.method === "POST") {
        return handleResearchDelete(request, env);
      }
      if (path === "/research/package" && request.method === "GET") {
        const lake = url.searchParams.get("lake") || "";
        if (!lake) return new Response(JSON.stringify({ok:false, error:"missing lake"}), {status:400, headers:JSON_HEADERS});
        const file = url.searchParams.get("file");
        if (file) return handleResearchPackageFile(env, lake, file);
        return handleResearchPackage(env, lake);
      }
      if (path === "/lake-research" && request.method === "GET") {
        const lake = url.searchParams.get("lake") || "";
        if (!lake) return new Response(JSON.stringify({ok:false, error:"missing lake"}), {status:400, headers:JSON_HEADERS});
        const enhanced = await handleEnhancedLakeIntel(lake, env);
        return new Response(JSON.stringify(enhanced, null, 2), {headers: JSON_HEADERS});
      }
      if (path.startsWith("/lakes/") && request.method === "GET") {
        // /lakes/<id>.json or /lakes/<id> -> get master
        const m = path.match(/^\/lakes\/([^\/]+)(?:\.json)?$/);
        if (m) {
          return handleResearchGet(env, decodeURIComponent(m[1]));
        }
      }

      if (path === "/detect-structure" && request.method === "POST") {
        try {
          const body = await request.json();
          const apiKey = env.GEMINI_API_KEY;
          if (!apiKey) {
            return new Response(JSON.stringify({ success: false, error: "GEMINI_API_KEY not configured" }), { status: 500, headers: JSON_HEADERS });
          }
          const {
            image_base64,
            mime_type = "image/jpeg",
            bounds,
            image_width = 1024,
            image_height = 600
          } = body;
          if (!image_base64 || !bounds?.north || !bounds?.south || !bounds?.east || !bounds?.west) {
            return new Response(JSON.stringify({ success: false, error: "missing image_base64 or bounds" }), { status: 400, headers: JSON_HEADERS });
          }
          const SYSTEM_PROMPT = `You are analyzing a satellite/aerial image of a South Carolina lake or river for fishing-relevant structures.

First, confirm water is visible. If no water body is present, return {"has_water":false,"features":[],"image_notes":"No water visible"}.

STRICT RULE: Only report structures that have a VISIBLE PHYSICAL CONNECTION to the shoreline or are clearly sitting in/on the water. A structure floating in open water with no visible connection to shore is almost certainly a false read \u2014 omit it. When in doubt, omit.

For each structure DIRECTLY OVER OR TOUCHING the water, identify:
- Docks/boat docks (rectangular platforms extending from shore over water \u2014 must be attached to shore)
- Piers (longer linear walkways into water \u2014 must connect to land)
- Boat ramps (light-colored concrete sloping from shore into water)
- Boathouses (roofed structures over water \u2014 must be shore-connected)
- Timber/logs (clearly visible debris in the water, not shadows)
- Fish attractors (dark man-made patches in shallow water near shore)

DO NOT flag: swimming pools, buildings set back from water, roads, shadows, trees, boat wakes, reflections, open water with no structure, or anything without a clear physical connection to shore or the water surface.

Return position as precise FRACTION of image dimensions:
- x_frac: 0.0 (left edge) to 1.0 (right edge)
- y_frac: 0.0 (top edge) to 1.0 (bottom edge)

Place the fraction at the point where the structure meets the water, not the far end. Only include structures you are 75%+ confident about. Fewer accurate results is better than many uncertain ones.`;
          const userPrompt = `Analyze this ${image_width}x${image_height} satellite image. Bounds: N=${bounds.north.toFixed(6)}, S=${bounds.south.toFixed(6)}, E=${bounds.east.toFixed(6)}, W=${bounds.west.toFixed(6)}. Return ONLY valid JSON: {"has_water":true,"features":[{"type":"dock|pier|boat_ramp|boathouse|timber|fish_attractor","x_frac":0.0,"y_frac":0.0,"confidence":0.0,"description":"brief","fishing_notes":"why this matters"}],"image_notes":"description"}`;
          const payload = {
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [{ parts: [
              { text: userPrompt },
              { inlineData: { mime_type, data: image_base64 } }
            ] }],
            generationConfig: {
              temperature: 0,
              response_mime_type: "application/json",
              thinkingConfig: { thinkingBudget: 0 }
            }
          };
          const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
          let r, attempts = 0;
          while (attempts < 3) {
            r = await fetch(geminiUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
            if (r.status !== 503) break;
            attempts++;
            if (attempts < 3) await new Promise((res) => setTimeout(res, 1e3 * attempts));
          }
          if (!r.ok) {
            const errText = await r.text();
            return new Response(JSON.stringify({ success: false, error: `Gemini ${r.status}: ${errText.slice(0, 300)}` }), { status: r.status, headers: JSON_HEADERS });
          }
          const gData = await r.json();
          const rawText = gData.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!rawText) return new Response(JSON.stringify({ success: false, error: "Empty Gemini response" }), { status: 500, headers: JSON_HEADERS });
          let result = {};
          try {
            result = JSON.parse(rawText);
          } catch (_) {
            result = { error: "parse failed", raw: rawText.slice(0, 500) };
          }
          const latRange = bounds.north - bounds.south;
          const lonRange = bounds.east - bounds.west;
          if (Array.isArray(result.features)) {
            result.features = result.features.map((f) => ({
              ...f,
              lat: bounds.north - f.y_frac * latRange,
              lon: bounds.west + f.x_frac * lonRange
            }));
            const before = result.features.length;
            result.features = result.features.filter((f) => {
              const fromWest = (f.lon - bounds.west) / lonRange;
              const fromEast = (bounds.east - f.lon) / lonRange;
              const fromNorth = (bounds.north - f.lat) / latRange;
              const fromSouth = (f.lat - bounds.south) / latRange;
              return Math.min(fromWest, fromEast, fromNorth, fromSouth) <= 0.35;
            });
            const dropped = before - result.features.length;
            if (dropped > 0) {
              result.image_notes = (result.image_notes || "") + ` [${dropped} open-water false positive${dropped > 1 ? "s" : ""} removed]`;
            }
          }
          return new Response(JSON.stringify({ success: true, ...result }), { headers: JSON_HEADERS });
        } catch (err) {
          return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: JSON_HEADERS });
        }
      }
      if (path === "/ramps") {
        const state = (url.searchParams.get("state") || "SC").toUpperCase();
        const forceRefresh = url.searchParams.has("refresh");
        const cacheKey = `ramps/${state.toLowerCase()}/ramps.json`;
        const CACHE_TTL_DAYS = 7;
        const RAMP_SOURCES = {
          SC: {
            url: "https://services.arcgis.com/acgZYxoN5Oj8pDLa/arcgis/rest/services/South_Carolina_Public_Water_Access_PUBLIC_VIEW/FeatureServer/0/query",
            filter: /* @__PURE__ */ __name((p) => p.WaterAccessType === "Boat Ramp" && p.Status?.toLowerCase() === "active" && p.PublicAccess?.toLowerCase() !== "closed", "filter"),
            name: /* @__PURE__ */ __name((p) => p.WaterAccessName, "name"),
            wb: /* @__PURE__ */ __name((p) => p.Waterbody, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.Latitude, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.Longitude, "lon"),
            meta: /* @__PURE__ */ __name((p) => ({ lanes: p.LaunchLanes, dock: p.CourtesyDock, fee: false, species: p.SpeciesList, county: p.County, owner: p.Owner, comments: p.Comments }), "meta"),
            label: "SCDNR South Carolina Public Water Access"
          },
          GA: {
            url: "https://services6.arcgis.com/9QlSLDqa0P1cHLhu/arcgis/rest/services/WRD_Water_Access_Points/FeatureServer/0/query",
            idField: "FID",
            // GA's objectIdFieldName is FID, not OBJECTID — using OBJECTID in orderByFields causes a 400 from ArcGIS, silently zeroing out results
            // Real schema confirmed 2026-07-03 via outFields=* query — field
            // names (Name/Waterbody/Latitude/Longitude/Status) were already
            // correct, but Ramp/Fee are single-letter "Y"/"N" booleans, not
            // the strings "yes"/"no" this filter was checking for. Every
            // record failed the check, so GA returned 0 waterbodies/0 ramps
            // regardless of cache state.
            filter: /* @__PURE__ */ __name((p) => String(p.Ramp || "").toUpperCase() === "Y" && !["closed", "inactive"].includes(String(p.Status || "").toLowerCase()), "filter"),
            name: /* @__PURE__ */ __name((p) => p.Name, "name"),
            wb: /* @__PURE__ */ __name((p) => p.Waterbody, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.Latitude, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.Longitude, "lon"),
            meta: /* @__PURE__ */ __name((p) => ({ lanes: p.NumLanes, dock: p.Dock, fee: String(p.Fee || "").toUpperCase() === "Y", county: p.County, owner: p.Owner, motorRestrictions: p.MotorRest }), "meta"),
            label: "Georgia DNR WRD Water Access Points"
          },
          NC: {
            url: "https://services1.arcgis.com/YfqBAUM5nWR3yhGP/arcgis/rest/services/NCWRC_Boating_Access_Areas_view/FeatureServer/0/query",
            // Real schema confirmed 2026-07-03 via outFields=* query — NC WRC does NOT
            // use STATUS/SITE_NAME/WATER_BODY like SC/GA. Every prior field guess missed,
            // so all 267 records collapsed into a single "Unknown" waterbody bucket.
            filter: /* @__PURE__ */ __name((p) => !String(p.Site_Status || "OPEN").toUpperCase().includes("CLOSED"), "filter"),
            name: /* @__PURE__ */ __name((p) => p.BAA_Name, "name"),
            wb: /* @__PURE__ */ __name((p) => p.Water_Access || p.BAA_Alias, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.Latitude, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.Longitude, "lon"),
            meta: /* @__PURE__ */ __name((p) => ({ lanes: p.Launch_Lane_No, dock: p.Courtesy_Dock_No || p.Fix_Dock_No, fee: false, county: p.County, owner: p.Owner, motorRestrictions: p.Motorboats_Restricted }), "meta"),
            label: "NC Wildlife Resources Commission Boating Access Areas"
          }
        };
        const source = RAMP_SOURCES[state];
        if (!source) {
          return new Response(JSON.stringify({ error: `Unknown state: ${state}. Use SC, GA, or NC.` }), { headers: JSON_HEADERS, status: 400 });
        }
        if (!forceRefresh) {
          try {
            const cached = await env.R2_TROLLMAP_CHARTPACKS.get(cacheKey);
            if (cached) {
              const meta = cached.customMetadata || {};
              const fetchedAt = meta.fetchedAt ? new Date(meta.fetchedAt) : null;
              const ageMs = fetchedAt ? Date.now() - fetchedAt.getTime() : Infinity;
              if (ageMs < CACHE_TTL_DAYS * 24 * 60 * 60 * 1e3) {
                const body = await cached.text();
                return new Response(body, { headers: { ...JSON_HEADERS, "X-Cache": "HIT", "X-Cache-Age": String(Math.round(ageMs / 36e5)) + "h" } });
              }
            }
          } catch (_) {
          }
        }
        async function fetchAllRampFeatures(baseUrl, idField = "OBJECTID") {
          const allFeatures = [];
          let offset = 0;
          const pageSize2 = 1e3;
          while (true) {
            const params = new URLSearchParams({ outFields: "*", where: "1=1", f: "geojson", resultOffset: offset, resultRecordCount: pageSize2, orderByFields: idField });
            const resp = await fetch(`${baseUrl}?${params}`, {
              headers: { "User-Agent": "TrollMap/1.0 (Cloudflare Worker)", "Accept": "application/json" },
              cf: { cacheTtl: 0 }
            });
            if (!resp.ok) throw new Error(`ArcGIS HTTP ${resp.status}`);
            const data = await resp.json();
            const features = data.features || [];
            allFeatures.push(...features);
            if (features.length < pageSize2) break;
            offset += pageSize2;
          }
          return allFeatures;
        }
        __name(fetchAllRampFeatures, "fetchAllRampFeatures");
        try {
          const features = await fetchAllRampFeatures(source.url, source.idField);
          const waterbodies = {};
          for (const feat of features) {
            const p = feat.properties || {};
            if (!source.filter(p)) continue;
            const lat = parseFloat(source.lat(p));
            const lon = parseFloat(source.lon(p));
            if (!isFinite(lat) || !isFinite(lon) || lat === 0 || lon === 0) continue;
            const wb = (source.wb(p) || "Unknown").trim();
            const name = (source.name(p) || "Unknown").trim();
            if (!waterbodies[wb]) waterbodies[wb] = [];
            waterbodies[wb].push({ name, lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6, ...source.meta(p) });
          }
          for (const wb of Object.keys(waterbodies)) {
            waterbodies[wb].sort((a, b) => a.name.localeCompare(b.name));
          }
          const result = {
            state,
            source: source.label,
            fetched: (/* @__PURE__ */ new Date()).toISOString(),
            count: Object.values(waterbodies).reduce((s, r) => s + r.length, 0),
            waterbodyCount: Object.keys(waterbodies).length,
            waterbodies
          };
          const body = JSON.stringify(result);
          await env.R2_TROLLMAP_CHARTPACKS.put(cacheKey, body, {
            httpMetadata: { contentType: "application/json" },
            customMetadata: { fetchedAt: result.fetched, state, count: String(result.count) }
          });
          return new Response(body, { headers: { ...JSON_HEADERS, "X-Cache": "MISS", "X-Ramp-Count": String(result.count) } });
        } catch (err) {
          try {
            const stale = await env.R2_TROLLMAP_CHARTPACKS.get(cacheKey);
            if (stale) {
              const body = await stale.text();
              return new Response(body, { headers: { ...JSON_HEADERS, "X-Cache": "STALE", "X-Cache-Error": err.message } });
            }
          } catch (_) {
          }
          return new Response(JSON.stringify({ error: `Failed to fetch ${state} ramp data: ${err.message}` }), { headers: JSON_HEADERS, status: 502 });
        }
      }
      if (path === "/paddle") {
        const state = (url.searchParams.get("state") || "SC").toUpperCase();
        const forceRefresh = url.searchParams.has("refresh");
        const cacheKey = `paddle/${state.toLowerCase()}/paddle.json`;
        const CACHE_TTL_DAYS = 7;
        const PADDLE_SOURCES = {
          SC: {
            url: "https://services.arcgis.com/acgZYxoN5Oj8pDLa/arcgis/rest/services/South_Carolina_Public_Water_Access_PUBLIC_VIEW/FeatureServer/0/query",
            filter: /* @__PURE__ */ __name((p) => p.WaterAccessType === "Paddle Launch" && p.Status?.toLowerCase() === "active" && p.PublicAccess?.toLowerCase() !== "closed", "filter"),
            name: /* @__PURE__ */ __name((p) => p.WaterAccessName, "name"),
            wb: /* @__PURE__ */ __name((p) => p.Waterbody, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.Latitude, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.Longitude, "lon"),
            meta: /* @__PURE__ */ __name((p) => ({ subtype: p.WaterAccessSubType, county: p.County, owner: p.Owner }), "meta")
          },
          GA: {
            url: "https://services6.arcgis.com/9QlSLDqa0P1cHLhu/arcgis/rest/services/WRD_Water_Access_Points/FeatureServer/0/query",
            idField: "FID",
            // GA's objectIdFieldName is FID, not OBJECTID
            filter: /* @__PURE__ */ __name((p) => String(p.CanoeAcc || "").toLowerCase() === "y" && !["closed", "inactive"].includes(String(p.Status || "").toLowerCase()), "filter"),
            name: /* @__PURE__ */ __name((p) => p.Name, "name"),
            wb: /* @__PURE__ */ __name((p) => p.Waterbody, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.Latitude, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.Longitude, "lon"),
            meta: /* @__PURE__ */ __name((p) => ({ county: p.County, owner: p.Owner }), "meta")
          },
          NC: {
            url: "https://services1.arcgis.com/YfqBAUM5nWR3yhGP/arcgis/rest/services/NCWRC_Boating_Access_Areas_view/FeatureServer/0/query",
            filter: /* @__PURE__ */ __name((p) => (String(p.Non_Motorized_Access || "").toLowerCase() === "yes" || String(p.Portable_Boat_Access_Type || "").length > 0) && String(p.Site_Status || "").toLowerCase() === "open", "filter"),
            name: /* @__PURE__ */ __name((p) => p.BAA_Name, "name"),
            wb: /* @__PURE__ */ __name((p) => p.Water_Access, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.Latitude, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.Longitude, "lon"),
            meta: /* @__PURE__ */ __name((p) => ({ type: p.Portable_Boat_Access_Type, county: p.County, owner: p.Owner }), "meta")
          }
        };
        const source = PADDLE_SOURCES[state];
        if (!source) return new Response(JSON.stringify({ error: `Unknown state: ${state}` }), { headers: JSON_HEADERS, status: 400 });
        if (!forceRefresh) {
          const cached = await env.R2_TROLLMAP_CHARTPACKS.get(cacheKey);
          if (cached) {
            const ageDays = (Date.now() - new Date(cached.uploaded).getTime()) / 864e5;
            if (ageDays < CACHE_TTL_DAYS) {
              return new Response(await cached.text(), { headers: { ...JSON_HEADERS, "X-Cache": "HIT", "X-Cache-Age-Days": ageDays.toFixed(1) } });
            }
          }
        }
        try {
          let allFeatures = [];
          let offset = 0;
          const idField = source.idField || "OBJECTID";
          while (true) {
            const params = new URLSearchParams({ outFields: "*", where: "1=1", f: "geojson", resultOffset: offset, resultRecordCount: 1e3, orderByFields: idField });
            const resp = await fetch(`${source.url}?${params.toString()}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            if (data.features) allFeatures.push(...data.features);
            if (!data.features || data.features.length < pageSize) break;
            offset += 1e3;
          }
          const waterbodies = {};
          for (const feat of allFeatures) {
            const p = feat.properties || {};
            if (!source.filter(p)) continue;
            let wb = String(source.wb(p) || "Unknown Waterbody").trim() || "Unknown Waterbody";
            let name = String(source.name(p) || "Unnamed Launch").trim();
            const lat = Number(source.lat(p) || feat.geometry?.coordinates?.[1]);
            const lon = Number(source.lon(p) || feat.geometry?.coordinates?.[0]);
            if (!lat || !lon || isNaN(lat) || isNaN(lon)) continue;
            if (!waterbodies[wb]) waterbodies[wb] = [];
            waterbodies[wb].push({ name, lat, lon, meta: source.meta(p) });
          }
          const result = { state, source: source.url, count: Object.values(waterbodies).flat().length, waterbodies };
          const body = JSON.stringify(result);
          await env.R2_TROLLMAP_CHARTPACKS.put(cacheKey, body, { customMetadata: { uploaded: (/* @__PURE__ */ new Date()).toISOString() } });
          return new Response(body, { headers: { ...JSON_HEADERS, "X-Cache": "MISS" } });
        } catch (err) {
          return new Response(JSON.stringify({ error: err.message }), { headers: JSON_HEADERS, status: 502 });
        }
      }
      if (path === "/bank-pier") {
        const state = (url.searchParams.get("state") || "SC").toUpperCase();
        const forceRefresh = url.searchParams.has("refresh");
        const cacheKey = `bankpier/${state.toLowerCase()}/bankpier.json`;
        const CACHE_TTL_DAYS = 7;
        const BANKPIER_SOURCES = {
          SC: {
            url: "https://services.arcgis.com/acgZYxoN5Oj8pDLa/arcgis/rest/services/South_Carolina_Public_Water_Access_PUBLIC_VIEW/FeatureServer/0/query",
            filter: /* @__PURE__ */ __name((p) => (p.WaterAccessType === "Bank" || p.WaterAccessType === "Pier" || String(p.FishingPier || "").toLowerCase() === "yes") && p.Status?.toLowerCase() === "active" && p.PublicAccess?.toLowerCase() !== "closed", "filter"),
            name: /* @__PURE__ */ __name((p) => p.WaterAccessName, "name"),
            wb: /* @__PURE__ */ __name((p) => p.Waterbody, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.Latitude, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.Longitude, "lon"),
            meta: /* @__PURE__ */ __name((p) => ({ type: p.WaterAccessType, pier: p.FishingPier }), "meta")
          },
          GA: {
            url: "https://services6.arcgis.com/9QlSLDqa0P1cHLhu/arcgis/rest/services/WRD_Water_Access_Points/FeatureServer/0/query",
            idField: "FID",
            // GA's objectIdFieldName is FID, not OBJECTID
            filter: /* @__PURE__ */ __name((p) => (String(p.BankFish || "").toLowerCase() === "y" || String(p.PierFish || "").toLowerCase() === "y") && !["closed", "inactive"].includes(String(p.Status || "").toLowerCase()), "filter"),
            name: /* @__PURE__ */ __name((p) => p.Name, "name"),
            wb: /* @__PURE__ */ __name((p) => p.Waterbody, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.Latitude, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.Longitude, "lon"),
            meta: /* @__PURE__ */ __name((p) => ({ bankFish: p.BankFish, pierFish: p.PierFish }), "meta")
          },
          NC: {
            url: "https://services1.arcgis.com/YfqBAUM5nWR3yhGP/arcgis/rest/services/NCWRC_Public_Fishing_Areas_view/FeatureServer/0/query",
            filter: /* @__PURE__ */ __name((p) => String(p.Site_Status || "").toLowerCase() === "open", "filter"),
            name: /* @__PURE__ */ __name((p) => p.PFA_Name, "name"),
            wb: /* @__PURE__ */ __name((p) => p.Water_Access, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.Latitude, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.Longitude, "lon"),
            meta: /* @__PURE__ */ __name((p) => ({ pier: p.Fishing_Pier, bank: p.Bank_Access }), "meta")
          }
        };
        const source = BANKPIER_SOURCES[state];
        if (!source) return new Response(JSON.stringify({ error: `Unknown state: ${state}` }), { headers: JSON_HEADERS, status: 400 });
        if (!forceRefresh) {
          const cached = await env.R2_TROLLMAP_CHARTPACKS.get(cacheKey);
          if (cached) {
            const ageDays = (Date.now() - new Date(cached.uploaded).getTime()) / 864e5;
            if (ageDays < CACHE_TTL_DAYS) {
              return new Response(await cached.text(), { headers: { ...JSON_HEADERS, "X-Cache": "HIT", "X-Cache-Age-Days": ageDays.toFixed(1) } });
            }
          }
        }
        try {
          let allFeatures = [];
          let offset = 0;
          const idField = source.idField || "OBJECTID";
          while (true) {
            const params = new URLSearchParams({ outFields: "*", where: "1=1", f: "geojson", resultOffset: offset, resultRecordCount: 1e3, orderByFields: idField });
            const resp = await fetch(`${source.url}?${params.toString()}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            if (data.features) allFeatures.push(...data.features);
            if (!data.features || data.features.length < pageSize) break;
            offset += 1e3;
          }
          const waterbodies = {};
          for (const feat of allFeatures) {
            const p = feat.properties || {};
            if (!source.filter(p)) continue;
            let wb = String(source.wb(p) || "Unknown Waterbody").trim() || "Unknown Waterbody";
            let name = String(source.name(p) || "Unnamed Spot").trim();
            const lat = Number(source.lat(p) || feat.geometry?.coordinates?.[1]);
            const lon = Number(source.lon(p) || feat.geometry?.coordinates?.[0]);
            if (!lat || !lon || isNaN(lat) || isNaN(lon)) continue;
            if (!waterbodies[wb]) waterbodies[wb] = [];
            waterbodies[wb].push({ name, lat, lon, meta: source.meta(p) });
          }
          for (const wb of Object.keys(waterbodies)) waterbodies[wb].sort((a, b) => a.name.localeCompare(b.name));
          const result = { state, source: source.url, count: Object.values(waterbodies).flat().length, waterbodies };
          const body = JSON.stringify(result);
          await env.R2_TROLLMAP_CHARTPACKS.put(cacheKey, body, { customMetadata: { uploaded: (/* @__PURE__ */ new Date()).toISOString() } });
          return new Response(body, { headers: { ...JSON_HEADERS, "X-Cache": "MISS" } });
        } catch (err) {
          return new Response(JSON.stringify({ error: err.message }), { headers: JSON_HEADERS, status: 502 });
        }
      }
      if (path === "/attractors") {
        const state = (url.searchParams.get("state") || "SC").toUpperCase();
        const forceRefresh = url.searchParams.has("refresh");
        const cacheKey = `attractors/${state.toLowerCase()}/attractors.json`;
        const CACHE_TTL_DAYS = 7;
        const ATTRACTOR_SOURCES = {
          SC: {
            url: "https://services.arcgis.com/acgZYxoN5Oj8pDLa/arcgis/rest/services/SCDNR_Freshwater_Fish_Attractors_Public_Web_App/FeatureServer/0/query",
            filter: /* @__PURE__ */ __name((p) => true, "filter"),
            // All records in this DB are attractors
            name: /* @__PURE__ */ __name((p) => p.FishAttractorName, "name"),
            wb: /* @__PURE__ */ __name((p) => p.Waterbody, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.lat_dd, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.lon_dd, "lon"),
            type: /* @__PURE__ */ __name((p) => p.Material, "type")
          },
          GA: {
            url: "https://services6.arcgis.com/9QlSLDqa0P1cHLhu/arcgis/rest/services/Fish_Attractors_for_Download/FeatureServer/0/query",
            // NOTE: different GA feature service than /ramps, /paddle, /bank-pier
            // (which all use WRD_Water_Access_Points, confirmed idField: FID).
            // This one hasn't been checked against its own schema — don't assume
            // FID applies here too. If this route also returns 0 for GA, query
            // this service's outFields=* first to confirm its real
            // objectIdFieldName before guessing at an idField override.
            filter: /* @__PURE__ */ __name((p) => true, "filter"),
            name: /* @__PURE__ */ __name((p) => p.note, "name"),
            wb: /* @__PURE__ */ __name((p) => p.waterbody, "wb"),
            lat: /* @__PURE__ */ __name((p) => null, "lat"),
            // We pull from geometry
            lon: /* @__PURE__ */ __name((p) => null, "lon"),
            type: /* @__PURE__ */ __name((p) => `${p.attractor_code || ""} ${p.attractor_code_other || ""}`.trim(), "type")
          },
          NC: {
            url: "https://services1.arcgis.com/YfqBAUM5nWR3yhGP/arcgis/rest/services/Fish_Attractors_public_view/FeatureServer/0/query",
            filter: /* @__PURE__ */ __name((p) => true, "filter"),
            name: /* @__PURE__ */ __name((p) => `${p.Waterbody} Attractor`, "name"),
            // NC doesn't have names, just types
            wb: /* @__PURE__ */ __name((p) => p.Waterbody, "wb"),
            lat: /* @__PURE__ */ __name((p) => p.Latitude, "lat"),
            lon: /* @__PURE__ */ __name((p) => p.Longitude, "lon"),
            type: /* @__PURE__ */ __name((p) => `${p.Structure1 || ""} ${p.Structure2 || ""}`.trim() || p.Attractor_Type, "type")
          }
        };
        const source = ATTRACTOR_SOURCES[state];
        if (!source) return new Response(JSON.stringify({ error: `Unknown state: ${state}` }), { headers: JSON_HEADERS, status: 400 });
        if (!forceRefresh) {
          const cached = await env.R2_TROLLMAP_CHARTPACKS.get(cacheKey);
          if (cached) {
            const ageDays = (Date.now() - new Date(cached.uploaded).getTime()) / 864e5;
            if (ageDays < CACHE_TTL_DAYS) {
              return new Response(await cached.text(), { headers: { ...JSON_HEADERS, "X-Cache": "HIT", "X-Cache-Age-Days": ageDays.toFixed(1) } });
            }
          }
        }
        try {
          let allFeatures = [];
          let offset = 0;
          while (true) {
            const params = new URLSearchParams({ outFields: "*", where: "1=1", f: "geojson", resultOffset: offset, resultRecordCount: 1e3, orderByFields: "OBJECTID" });
            const resp = await fetch(`${source.url}?${params.toString()}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            if (data.features) allFeatures.push(...data.features);
            if (!data.features || data.features.length < 1e3) break;
            offset += 1e3;
          }
          const waterbodies = {};
          for (const feat of allFeatures) {
            const p = feat.properties || {};
            if (!source.filter(p)) continue;
            let wb = String(source.wb(p) || "Unknown Waterbody").trim() || "Unknown Waterbody";
            let name = String(source.name(p) || "Attractor").trim() || "Attractor";
            const lat = Number(source.lat(p) || feat.geometry?.coordinates?.[1]);
            const lon = Number(source.lon(p) || feat.geometry?.coordinates?.[0]);
            if (!lat || !lon || isNaN(lat) || isNaN(lon)) continue;
            if (!waterbodies[wb]) waterbodies[wb] = [];
            waterbodies[wb].push({ name, lat, lon, type: String(source.type(p) || "Unknown").trim() });
          }
          for (const wb of Object.keys(waterbodies)) waterbodies[wb].sort((a, b) => a.name.localeCompare(b.name));
          const result = { state, source: source.url, count: Object.values(waterbodies).flat().length, waterbodies };
          const body = JSON.stringify(result);
          await env.R2_TROLLMAP_CHARTPACKS.put(cacheKey, body, { customMetadata: { uploaded: (/* @__PURE__ */ new Date()).toISOString() } });
          return new Response(body, { headers: { ...JSON_HEADERS, "X-Cache": "MISS" } });
        } catch (err) {
          return new Response(JSON.stringify({ error: err.message }), { headers: JSON_HEADERS, status: 502 });
        }
      }
      if (path === "/duke" || url.searchParams.has("duke")) {
        const format = (url.searchParams.get("format") || "text").toLowerCase();
        const d = await fetchDukeDashboard(url.searchParams.get("basin") || "1");
        if (!d) {
          return new Response(JSON.stringify({ error: "Duke API unreachable" }), { headers: JSON_HEADERS, status: 502 });
        }
        if (format === "json") {
          return new Response(JSON.stringify(d.json, null, 2), { headers: { ...JSON_HEADERS, "X-Source": d.url } });
        }
        return new Response(d.text, { headers: { ...TEXT_HEADERS, "X-Source": d.url } });
      }
      if (path === "/usgs") {
        const site = url.searchParams.get("site");
        const params = url.searchParams.get("params") || "00010,00065";
        if (!site) return new Response('{"error":"missing site"}', { headers: JSON_HEADERS, status: 400 });
        const r = await fetch(`https://waterservices.usgs.gov/nwis/iv/?sites=${site}&parameterCd=${params}&format=json&period=P2D`);
        const t = await r.text();
        return new Response(t, { headers: JSON_HEADERS, status: r.status });
      }
      if (path === "/lake-clarity") {
        const name = url.searchParams.get("lake") || url.searchParams.get("waterbody") || "";
        const dateParam = url.searchParams.get("date") || (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
        if (!name) return new Response(JSON.stringify({ error: "missing lake" }), { headers: JSON_HEADERS, status: 400 });
        const data = await getLakeClarity(name, dateParam);
        return new Response(JSON.stringify(data, null, 2), { headers: JSON_HEADERS });
      }
      if (path === "/lake-intel-sources") {
        const name = url.searchParams.get("lake") || "";
        if (name) {
          const key = lakeKeyFromName(name);
          return new Response(JSON.stringify({ key, registry: getLakeIntelSourceRegistry(key) }, null, 2), { headers: JSON_HEADERS });
        }
        return new Response(JSON.stringify(LAKE_INTEL_SOURCE_REGISTRY, null, 2), { headers: JSON_HEADERS });
      }
      if (path === "/lake-intel") {
        const name = url.searchParams.get("lake") || url.searchParams.get("waterbody") || "";
        if (!name) return new Response(JSON.stringify({ error: "missing lake" }), { headers: JSON_HEADERS, status: 400 });
        // Enhanced with researched profile if exists
        try {
          const enhanced = await handleEnhancedLakeIntel(name, env);
          return new Response(JSON.stringify(enhanced, null, 2), { headers: JSON_HEADERS });
        } catch {
          const intel = await getLakeIntel(name);
          return new Response(JSON.stringify(intel, null, 2), { headers: JSON_HEADERS });
        }
      }
      if (path === "/river" || url.searchParams.has("river")) {
        const r = (url.searchParams.get("river") || "").toLowerCase();
        if (!r) {
          return new Response(JSON.stringify({
            error: "missing river",
            available: Object.keys(RIVERS)
          }), { headers: JSON_HEADERS, status: 400 });
        }
        const key = Object.keys(RIVERS).find((k) => r.includes(k) || k.includes(r));
        if (!key) {
          return new Response(JSON.stringify({
            error: `unknown river: ${r}`,
            available: Object.keys(RIVERS)
          }), { headers: JSON_HEADERS, status: 404 });
        }
        const userLat = parseFloat(url.searchParams.get("lat"));
        const userLon = parseFloat(url.searchParams.get("lon"));
        const opts = isFinite(userLat) && isFinite(userLon) ? { userLat, userLon } : {};
        const data = await getRiver(key, opts);
        return new Response(JSON.stringify(data, null, 2), { headers: JSON_HEADERS });
      }
      if (path === "/duke-flow-arrivals") {
        const basin = url.searchParams.get("basin") || "1";
        const sched = await fetchDukeFlowArrivals(basin);
        if (!sched) return new Response(JSON.stringify({ error: "Duke flow-arrivals unavailable", basin }), { headers: JSON_HEADERS, status: 502 });
        return new Response(JSON.stringify(sched, null, 2), { headers: JSON_HEADERS });
      }
      if (path === "/dominion-saluda") {
        const status = await fetchDominionSaludaStatus();
        if (!status) return new Response(JSON.stringify({ error: "Dominion Saluda page unavailable" }), { headers: JSON_HEADERS, status: 502 });
        return new Response(JSON.stringify(status, null, 2), { headers: JSON_HEADERS });
      }
      if (path === "/rivers") {
        const list = Object.entries(RIVERS).map(([k, v]) => ({
          key: k,
          label: v.label,
          operator: v.operator,
          dam: v.damName,
          primaryGauge: (v.gauges.find((g) => g.primary) || v.gauges[0]).site
        }));
        return new Response(JSON.stringify(list, null, 2), { headers: JSON_HEADERS });
      }
      if (path === "/lake") {
        if (!lake) return new Response('{"error":"missing lake"}', { headers: JSON_HEADERS, status: 400 });
        const result = await resolveLake(lake);
        return new Response(JSON.stringify(result, null, 2), { headers: JSON_HEADERS });
      }
      if (path.startsWith("/sync")) {
        if (!env.DB) return new Response(JSON.stringify({ error: "D1 not configured" }), { headers: JSON_HEADERS, status: 503 });
        if (!await isAuthorized(request, env)) {
          return new Response(JSON.stringify({ error: "unauthorized" }), { headers: JSON_HEADERS, status: 401 });
        }
        try {
          if (path === "/sync/migrate" && request.method === "POST") {
            return await handleSyncMigrate(request, env);
          }
          const purgeMatch = path.match(/^\/sync\/purge-type\/([^\/]+)$/);
          if (purgeMatch && request.method === "DELETE") {
            const pType = purgeMatch[1];
            await ensureSyncSchema(env.DB);
            await env.DB.prepare("DELETE FROM sync_items WHERE type = ?1").bind(pType).run();
            return new Response(JSON.stringify({ ok: true, purged: pType }), { headers: JSON_HEADERS });
          }
          if (path === "/sync/list-updates" && request.method === "GET") {
            return await handleSyncListUpdates(url, env);
          }
          const itemMatch = path.match(/^\/sync\/item\/([^\/]+)\/(.+)$/);
          if (itemMatch) {
            const [, type, id] = itemMatch;
            if (request.method === "POST") return await handleSyncPush(request, env, type, id);
            if (request.method === "GET") return await handleSyncGet(env, type, id);
            if (request.method === "DELETE") return await handleSyncDelete(env, type, id);
          }
          const keyMatch = path.match(/^\/sync\/item\/(.+)$/);
          if (keyMatch && request.method === "GET") {
            const parts = keyMatch[1].split("/");
            const type = parts[0];
            const id = parts.slice(1).join("/");
            return await handleSyncGet(env, type, id);
          }
          return new Response(JSON.stringify({ error: "unknown sync route" }), { headers: JSON_HEADERS, status: 404 });
        } catch (syncErr) {
          return new Response(JSON.stringify({ error: `sync error: ${syncErr.message}` }), { headers: JSON_HEADERS, status: 500 });
        }
      }
      const contourMatch = path.match(/^\/contours\/([^\/]+)\/geojson$/);
      if (contourMatch) {
        const lakeArg = contourMatch[1];
        if (request.method === "GET") return handleContourGeojsonGet(env, lakeArg);
        if (request.method === "POST" || request.method === "PUT") {
          if (!await isAuthorized(request, env)) {
            return new Response(JSON.stringify({ error: "unauthorized" }), { headers: JSON_HEADERS, status: 401 });
          }
          return handleContourGeojsonPut(request, env, lakeArg);
        }
      }
      if (path === "/chartpacks/lake-boundary" && request.method === "GET") {
        const lakeName = url.searchParams.get("lake") || "";
        if (!lakeName) return new Response(JSON.stringify({ error: "missing lake param" }), { status: 400, headers: JSON_HEADERS });
        // Boundaries stored under boundaries/ prefix with _3dhp suffix
        const safeId = sanitizeLakeId(lakeName);
        const shortKey = lakeKeyFromName(lakeName);
        const candidates = [
          `boundaries/${safeId}_3dhp.geojson`,
          `boundaries/lake_${shortKey}_3dhp.geojson`,
          `boundaries/${safeId}.geojson`,
          `boundaries/${shortKey}.geojson`,
        ];
        let geoObj = null;
        for (const key of candidates) {
          geoObj = await env.R2_TROLLMAP_CHARTPACKS.get(key).catch(() => null);
          if (geoObj) break;
        }
        if (!geoObj) return new Response(JSON.stringify({ error: "no boundary data found", lake: lakeName, tried: candidates }), { status: 404, headers: JSON_HEADERS });
        const geoText = await geoObj.text();
        return new Response(geoText, { headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" } });
      }

      if (path === "/chartpacks/list") {
        const data = await handleChartpackList(env);
        return new Response(JSON.stringify(data, null, 2), { headers: JSON_HEADERS });
      }
      const idxMatch = path.match(/^\/chartpacks\/([^/]+)\/index\.json$/);
      if (idxMatch) {
        const lakeName = idxMatch[1];
        const prefix = chartpackKey(lakeName, "");
        const listed = await env.R2_TROLLMAP_CHARTPACKS.list({ prefix });
        const tiles = /* @__PURE__ */ new Set();
        let totalBytes = 0;
        for (const obj of listed.objects) {
          const fname = obj.key.slice(prefix.length);
          totalBytes += obj.size || 0;
          const m = fname.match(/(?:^|\/)iboating_R(\d{3})_C(\d{3})_contours\.georef\.json$/i);
          if (m) tiles.add(`iboating_R${m[1]}_C${m[2]}`);
        }
        return new Response(JSON.stringify({
          lake: lakeName,
          tiles: [...tiles].sort(),
          total_bytes: totalBytes
        }), { headers: { ...CORS, ...JSON_HEADERS, "Cache-Control": "no-store" } });
      }
      const cpMatch = path.match(/^\/chartpacks\/([^/]+)\/(.+)$/);
      if (cpMatch) {
        const [, lakeName, file] = cpMatch;
        const key = chartpackKey(lakeName, file);
        if (request.method === "GET") {
          const obj = await env.R2_TROLLMAP_CHARTPACKS.get(key);
          if (!obj) return new Response('{"error":"not found"}', { headers: JSON_HEADERS, status: 404 });
          let ct = "application/octet-stream";
          if (file.endsWith(".png")) ct = "image/png";
          else if (file.endsWith(".json")) ct = "application/json";
          const headers = { ...CORS, "Content-Type": ct, "Cache-Control": "no-store" };
          return new Response(obj.body, { headers });
        }
        if (request.method === "POST") {
          if (!await isAuthorized(request, env)) {
            return new Response('{"error":"unauthorized"}', { headers: JSON_HEADERS, status: 401 });
          }
          const buf = await request.arrayBuffer();
          if (!buf || buf.byteLength === 0) {
            return new Response('{"error":"empty body"}', { headers: JSON_HEADERS, status: 400 });
          }
          await env.R2_TROLLMAP_CHARTPACKS.put(key, buf, {
            httpMetadata: {
              contentType: file.endsWith(".png") ? "image/png" : "application/json",
              cacheControl: "public, max-age=3600"
            }
          });
          return new Response(JSON.stringify({ uploaded: key, bytes: buf.byteLength }), { headers: JSON_HEADERS });
        }
        return new Response('{"error":"method not allowed"}', { headers: JSON_HEADERS, status: 405 });
      }
      return new Response(JSON.stringify({
        ok: true,
        worker: "trollmap-worker",
        version: 15.6,
        changelog: "2026-07-13 v15.6: Fix eRegulations → regulations JSON pipeline. Root cause: Firecrawl flattens multi-row markdown tables into one line with empty-cell separators; extractMarkdownTableRows misaligned columns so parseSCRegulationsFromHtml returned empty creel/size maps (UI showed empty regs). Fixed table parser (split on | |), expanded species matching (striper Santee-system rows for Wateree, lake regs page 14\" LMB), live Firecrawl fallback when normalized docs missing, multi-key R2 lookup for normalized_documents.json. EPA NSCEP/NEPIS two-step Firecrawl workflow (search results → ZyActionD landing → raw_text_url markdown). Dataset-hunt + discovery seeds include lake regs.html + eRegulations. UI regulations viewer now renders size+creel grids, closed seasons, special rules. Previous v15.5: SCDNR fishregs 404 → eRegulations migration.",
        evidencePipeline: {
          version: "v4",
          fixes: [
            "alias dedupe: Lake Wateree, SC no longer becomes Lake Lake Wateree",
            "discovery filter: drops Lake Murray/Marion regs when searching Wateree",
            "skip generic pocket guide 50MB PDF",
            "scoring now composite auth/relevance/freshness/completeness, not all 98",
            "extraction uses lake-relevant 20k char chunks, not blind 100k slices, total 120k cap",
            "Gemini prompt now asks for riverSystem/archetype/surfaceArea/etc + general vs lake-specific creel/size + fallback to general regs if 0 lake facts",
            "dedupe by fact text similarity not category, contradiction detection numeric+species conflict",
            "master profile status forced draft if <3 facts or 0 facts, prevents false verified 98%",
            "client defensive: non-JSON detection for worker 404, large PDF skip, off-lake penalize"
          ],
          lastBugLog: "Wateree run 2026-07-12 22:14 — 10 docs but 0 facts + verified 98% -> now draft + filter"
        },
        routes: [
          "/research/agent                    \u2014 run single AI research agent (identity|limnology|biology|habitat|navigation|regulations|trolling|summary) — uses full callLLM chain (groq 120b primary → fallback), grounded with known LAKES baseline for identity",
          "/research/list or /lakes/list      \u2014 list all researched lake master profiles",
          "/research/get?lake=...             \u2014 get master profile + package file list + versions",
          "/research/save                     \u2014 save merged profile (master + hybrid package + version)",
          "/research/approve                  \u2014 mark profile verified",
          "/research/package?lake=...         \u2014 list package files for lake",
          "/research/package?lake=...&file=... \u2014 get single package file",
          "/lake-research?lake=...            \u2014 enhanced lake intel with researched profile if exists",
          "/lakes/<id>                        \u2014 shortcut get master profile",
          "/sync/item/:type/:id               \u2014 push/get/delete a sync item (auth required)",
          "/sync/list-updates?since=<ts>      \u2014 delta list for cross-device sync (auth required)",
          "/sync/migrate                      \u2014 bulk import all local data (auth required)",
          "/contours/:lake/geojson            \u2014 serve/upload vectorized contour GeoJSON",
          "/duke?basin=1|2|3                      \u2014 raw Duke lake levels",
          "/lake?lake=wateree                     \u2014 unified lake JSON",
          "/lake-clarity?lake=wateree&date=YYYY-MM-DD \u2014 runoff clarity/ramp/lure forecast",
          "/lake-intel-sources?lake=wateree       \u2014 trust-tier source registry",
          "/lake-intel?lake=murray|marion|wateree    \u2014 fisherman lake profile + latest report scrape + researched if exists",
          "/river?river=wateree|congaree|saluda|broad|santee|cooper",
          "/rivers                                \u2014 list all rivers",
          "/duke-flow-arrivals?basin=1|2|3|6|10|11 \u2014 raw Duke scheduled dam releases",
          "/dominion-saluda                       \u2014 raw Dominion color-coded status",
          "/usgs?site=...&params=...              \u2014 raw USGS pass-through",
          "/chartpacks/list                       \u2014 list all uploaded chartpack lakes",
          "/chartpacks/<lake>/<file>             \u2014 serve or upload chartpack file"
        ]
      }, null, 2), { headers: JSON_HEADERS });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { headers: JSON_HEADERS, status: 500 });
    }
  }
};
export {
  trollmap_worker_default as default
};
//# sourceMappingURL=trollmap-worker.js.map