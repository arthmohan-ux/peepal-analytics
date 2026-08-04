// netlify/lib/llm.js
// Provider-agnostic chat completion over any OpenAI-compatible endpoint.
// Configured for Google Gemini (free tier) by default; swap providers via env vars only.
//   LLM_API_KEY    (required)  your Gemini AI Studio key
//   LLM_BASE_URL   (optional)  default https://generativelanguage.googleapis.com/v1beta/openai
//   LLM_MODEL      (optional)  default gemini-3.5-flash
// Back-compat aliases still read: MOONSHOT_API_KEY / MOONSHOT_MODEL / MOONSHOT_BASE_URL
//
// Self-healing: if the configured model returns a "not found / deprecated" error on a
// Gemini endpoint, it falls through a list of known-good Gemini models automatically,
// and if JSON mode isn't supported it retries without it. This means model-name drift
// never requires a redeploy.

const API_KEY = process.env.LLM_API_KEY || process.env.MOONSHOT_API_KEY;
const BASE_URL = (process.env.LLM_BASE_URL || process.env.MOONSHOT_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/$/, '');
// Default to Flash-Lite: it barely "thinks", so it returns in a few seconds and stays
// under Netlify's function timeout. The heavy thinking models (plain Flash) time out.
const PRIMARY_MODEL = process.env.LLM_MODEL || process.env.MOONSHOT_MODEL || 'gemini-3.5-flash-lite';

const IS_GEMINI = /googleapis\.com/i.test(BASE_URL);
const GEMINI_FALLBACKS = ['gemini-3.5-flash-lite', 'gemini-2.0-flash', 'gemini-flash-latest', 'gemini-3.6-flash', 'gemini-3.5-flash'];

const MODEL = PRIMARY_MODEL; // exported for debug display

function candidateModels() {
  const list = [PRIMARY_MODEL];
  if (IS_GEMINI) for (const m of GEMINI_FALLBACKS) if (!list.includes(m)) list.push(m);
  return list;
}

async function callOnce(model, messages, { temperature, maxTokens }, useJson) {
  const body = { model, messages, temperature, max_tokens: maxTokens };
  if (useJson) body.response_format = { type: 'json_object' };
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`LLM ${res.status}: ${detail.slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isMissing = (m) => /404|not\s*found|not_found|does not exist|no longer available|unsupported|permission|403/i.test(m);
const isTransient = (m) => /\b(429|500|502|503|504)\b|unavailable|overloaded|high demand|rate.?limit|try again|deadline|timeout/i.test(m);

async function chat(messages, { temperature = 0.3, jsonMode = true, maxTokens = 1400 } = {}) {
  if (!API_KEY) throw new Error('LLM_API_KEY is not set');
  const opts = { temperature, maxTokens };
  const models = candidateModels();
  let lastErr;

  for (const model of models) {
    // up to 3 attempts per model to ride out transient overloads (503/429)
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await callOnce(model, messages, opts, jsonMode);
      } catch (e) {
        lastErr = e;
        const msg = String(e.message || '');
        // JSON mode unsupported? retry same model once without it.
        if (jsonMode && /response_format|json|invalid_request|400/i.test(msg)) {
          try { return await callOnce(model, messages, opts, false); }
          catch (e2) { lastErr = e2; }
        }
        if (isTransient(msg) && attempt < 2) { await sleep(700 * (attempt + 1)); continue; } // retry same model
        break; // give up on this model; try the next candidate
      }
    }
    // only move to the next model for missing/deprecated or exhausted-transient errors
    if (!isMissing(String(lastErr.message)) && !isTransient(String(lastErr.message))) throw lastErr;
  }
  throw lastErr;
}

// ── streaming ────────────────────────────────────────────────────────────────
async function streamOnce(model, messages, { temperature, maxTokens }, onDelta) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: true }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`LLM ${res.status}: ${detail.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let full = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        const delta = j.choices?.[0]?.delta?.content || '';
        if (delta) { full += delta; onDelta(delta); }
      } catch (_) { /* ignore keep-alives / partial lines */ }
    }
  }
  return full;
}

// Streams tokens via onDelta(text). Returns the full text. Falls through models on
// missing/transient errors just like chat().
async function streamChat(messages, { temperature = 0.3, maxTokens = 1600 } = {}, onDelta = () => {}) {
  if (!API_KEY) throw new Error('LLM_API_KEY is not set');
  const models = candidateModels();
  let lastErr;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await streamOnce(model, messages, { temperature, maxTokens }, onDelta);
      } catch (e) {
        lastErr = e;
        const m = String(e.message || '');
        if (isTransient(m) && attempt < 1) { await sleep(700); continue; }
        break;
      }
    }
    if (!isMissing(String(lastErr.message)) && !isTransient(String(lastErr.message))) throw lastErr;
  }
  throw lastErr;
}

module.exports = { chat, streamChat, MODEL };
