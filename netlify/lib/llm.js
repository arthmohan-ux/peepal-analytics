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
const PRIMARY_MODEL = process.env.LLM_MODEL || process.env.MOONSHOT_MODEL || 'gemini-3.5-flash';

const IS_GEMINI = /googleapis\.com/i.test(BASE_URL);
const GEMINI_FALLBACKS = ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-flash-latest', 'gemini-3.5-flash-lite', 'gemini-2.0-flash'];

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

async function chat(messages, { temperature = 0.3, jsonMode = true, maxTokens = 1400 } = {}) {
  if (!API_KEY) throw new Error('LLM_API_KEY is not set');
  const opts = { temperature, maxTokens };
  const models = candidateModels();
  let lastErr;

  for (const model of models) {
    try {
      return await callOnce(model, messages, opts, jsonMode);
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || '');
      // JSON mode unsupported for this model? retry same model without it.
      if (jsonMode && /response_format|json|invalid|400/i.test(msg)) {
        try { return await callOnce(model, messages, opts, false); }
        catch (e2) { lastErr = e2; }
      }
      // Model missing/deprecated? try the next candidate. Otherwise stop.
      if (!/404|not\s*found|not_found|does not exist|no longer available|unsupported|permission|403/i.test(String(lastErr.message))) {
        throw lastErr;
      }
    }
  }
  throw lastErr;
}

module.exports = { chat, MODEL };
