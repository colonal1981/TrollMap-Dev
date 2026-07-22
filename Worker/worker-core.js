// worker-core.js — Shared infrastructure: CORS headers, LLM provider chain, fetchText


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
    // Pay-tier Gemini — limnology agent only
    name: "gemini",
    baseUrl: null,
    keyEnv: "GEMINI_API_KEY",
  defaultModel: "gemini-3.1-pro-preview",
models: [
  "gemini-3.1-pro-preview",
  "gemini-2.5-pro",
  "gemini-2.5-flash"
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
      }
    }),
  },
  {
    // Free-tier Gemini — general agents primary (500 RPD, 250K TPM)
    name: "gemini-free",
    baseUrl: null,
    keyEnv: "GEMINI_FREE_API_KEY",
    defaultModel: "gemini-3.1-flash-lite",
    models: [
      "gemini-3.1-flash-lite",
    ],
    headers: (key) => ({ "x-goog-api-key": key, "Content-Type": "application/json" }),
    isGemini: true,
    transformPayload: (p) => ({
      systemInstruction: { parts: [{ text: p.messages.find(m => m.role === 'system')?.content || '' }] },
      contents: [{ parts: [{ text: p.messages.find(m => m.role === 'user')?.content || '' }] }],
      generationConfig: {
        temperature: p.temperature || 0.15,
        maxOutputTokens: p.max_tokens || 1500,
        responseMimeType: p.response_format?.type === 'json_object' ? 'application/json' : undefined,
      }
    }),
  },
  {
    // Free-tier Gemini — fallback when first free key hits rate limits
    name: "gemini-free2",
    baseUrl: null,
    keyEnv: "GEMINI_FREE2_API_KEY",
    defaultModel: "gemini-3.1-flash-lite",
    models: [ "gemini-3.1-flash-lite" ],
    headers: (key) => ({ "x-goog-api-key": key, "Content-Type": "application/json" }),
    isGemini: true,
    transformPayload: (p) => ({
      systemInstruction: { parts: [{ text: p.messages.find(m => m.role === 'system')?.content || '' }] },
      contents: [{ parts: [{ text: p.messages.find(m => m.role === 'user')?.content || '' }] }],
      generationConfig: { temperature: p.temperature || 0.15, maxOutputTokens: p.max_tokens || 1500, responseMimeType: p.response_format?.type === 'json_object' ? 'application/json' : undefined }
    }),
  },
  {
    name: "gemini-free3",
    baseUrl: null,
    keyEnv: "GEMINI_FREE3_API_KEY",
    defaultModel: "gemini-3.1-flash-lite",
    models: [ "gemini-3.1-flash-lite" ],
    headers: (key) => ({ "x-goog-api-key": key, "Content-Type": "application/json" }),
    isGemini: true,
    transformPayload: (p) => ({
      systemInstruction: { parts: [{ text: p.messages.find(m => m.role === 'system')?.content || '' }] },
      contents: [{ parts: [{ text: p.messages.find(m => m.role === 'user')?.content || '' }] }],
      generationConfig: { temperature: p.temperature || 0.15, maxOutputTokens: p.max_tokens || 1500, responseMimeType: p.response_format?.type === 'json_object' ? 'application/json' : undefined }
    }),
  },
  {
    name: "gemini-free4",
    baseUrl: null,
    keyEnv: "GEMINI_FREE4_API_KEY",
    defaultModel: "gemini-3.1-flash-lite",
    models: [ "gemini-3.1-flash-lite" ],
    headers: (key) => ({ "x-goog-api-key": key, "Content-Type": "application/json" }),
    isGemini: true,
    transformPayload: (p) => ({
      systemInstruction: { parts: [{ text: p.messages.find(m => m.role === 'system')?.content || '' }] },
      contents: [{ parts: [{ text: p.messages.find(m => m.role === 'user')?.content || '' }] }],
      generationConfig: { temperature: p.temperature || 0.15, maxOutputTokens: p.max_tokens || 1500, responseMimeType: p.response_format?.type === 'json_object' ? 'application/json' : undefined }
    }),
  },
  {
    name: "gemini-free5",
    baseUrl: null,
    keyEnv: "GEMINI_FREE5_API_KEY",
    defaultModel: "gemini-3.1-flash-lite",
    models: [ "gemini-3.1-flash-lite" ],
    headers: (key) => ({ "x-goog-api-key": key, "Content-Type": "application/json" }),
    isGemini: true,
    transformPayload: (p) => ({
      systemInstruction: { parts: [{ text: p.messages.find(m => m.role === 'system')?.content || '' }] },
      contents: [{ parts: [{ text: p.messages.find(m => m.role === 'user')?.content || '' }] }],
      generationConfig: { temperature: p.temperature || 0.15, maxOutputTokens: p.max_tokens || 1500, responseMimeType: p.response_format?.type === 'json_object' ? 'application/json' : undefined }
    }),
  },
  {
    name: "groq",
    baseUrl: "https://api.groq.com/openai/v1/chat/completions",
    keyEnv: "GROQ_API_KEY",
    defaultModel: "openai/gpt-oss-120b",
    models: [
      "openai/gpt-oss-120b",
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
      "gpt-oss-120b"
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

// Round-robin counter for gemini-free key rotation across concurrent requests
// Incremented atomically per call so concurrent analyze-facts requests hit different keys
let _geminiRoundRobinIdx = 0;

async function callLLM(env, payload, preferredProvider = null) {
  // If no preferred provider specified and we have multiple gemini-free keys,
  // auto-rotate across them to spread RPM load
  if (!preferredProvider) {
    const freeKeys = ['gemini-free', 'gemini-free2', 'gemini-free3', 'gemini-free4', 'gemini-free5'];
    const available = freeKeys.filter(name => {
      const p = LLM_PROVIDERS.find(p => p.name === name);
      return p && env[p.keyEnv];
    });
    if (available.length > 1) {
      preferredProvider = available[_geminiRoundRobinIdx % available.length];
      _geminiRoundRobinIdx++;
    }
  }
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
        // Retry on 429 for all providers — 2 retries with 2s/4s backoff
        const maxAttempts = 3;
        let r;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          if (attempt > 1) {
            const delay = attempt === 2 ? 2000 : 4000;
            console.warn(`${provider.name}/${modelId} rate limited (429) — retry ${attempt}/${maxAttempts} after ${delay}ms`);
            await new Promise(res => setTimeout(res, delay));
          }
          r = await fetch(provider.baseUrl, {
            method: "POST",
            headers: provider.headers(key),
            body: JSON.stringify(body)
          });
          if (r.status !== 429) break;
        }
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
async function isAuthorized(request, env) {
  const want = env && env.SYNC_TOKEN || typeof SYNC_TOKEN !== "undefined" && SYNC_TOKEN || null;
  if (!want) return false;
  const got = request.headers.get("X-Sync-Token");
  return got === want;
}
function chartpackKey(lake, filename) {
  const safeLake = String(lake).toLowerCase().replace(/[^a-z0-9_\-]/g, "_");
  const safeFile = String(filename).replace(/[^a-z0-9_.\-\/]/gi, "_");
  return `${safeLake}/${safeFile}`;
}
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

export { CORS, JSON_HEADERS, TEXT_HEADERS, extractLLMText, callLLM, isAuthorized };
