// netlify/lib/llm.js
// Provider-agnostic chat completion. Defaults to Moonshot Kimi (OpenAI-compatible).
// To port to another provider later, change only these three env vars — no code change.
//   LLM_API_KEY    (required)  e.g. your Moonshot key
//   LLM_BASE_URL   (optional)  default https://api.moonshot.ai/v1
//   LLM_MODEL      (optional)  default kimi-k2-0711-preview
// Backwards-compatible aliases: MOONSHOT_API_KEY / MOONSHOT_MODEL / MOONSHOT_BASE_URL

const API_KEY = process.env.LLM_API_KEY || process.env.MOONSHOT_API_KEY;
const BASE_URL = (process.env.LLM_BASE_URL || process.env.MOONSHOT_BASE_URL || 'https://api.moonshot.ai/v1').replace(/\/$/, '');
const MODEL = process.env.LLM_MODEL || process.env.MOONSHOT_MODEL || 'kimi-k2-0711-preview';

async function chat(messages, { temperature = 0.3, jsonMode = true, maxTokens = 1400 } = {}) {
  if (!API_KEY) throw new Error('LLM_API_KEY (or MOONSHOT_API_KEY) is not set');

  const body = {
    model: MODEL,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`LLM ${res.status}: ${detail.slice(0, 500)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

module.exports = { chat, MODEL };
