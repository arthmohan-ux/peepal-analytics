// netlify/lib/llm.js
// Provider-agnostic chat completion over any OpenAI-compatible endpoint.
// Everything is set through env vars, so changing model or provider needs no code change.
//
//   LLM_API_KEY            required   Gemini AI Studio key (or any OpenAI-compatible key)
//   LLM_BASE_URL           optional   default https://generativelanguage.googleapis.com/v1beta/openai
//   LLM_MODEL              optional   default gemini-3.8-flash
//   LLM_FALLBACK_MODELS    optional   comma list tried in order if the primary is missing or overloaded
//   LLM_REASONING_EFFORT   optional   minimal | low | medium | high. Default "low": the hard work
//                                     (filtering, counting) is done in kb.js, so the model only has
//                                     to phrase. Low keeps answers fast enough to use on a live call.
//                                     Set to "off" to send nothing (for providers that reject the field).
//   LLM_TIMEOUT_MS         optional   default 45000
// Back-compat aliases still read: MOONSHOT_API_KEY / MOONSHOT_MODEL / MOONSHOT_BASE_URL

const API_KEY = process.env.LLM_API_KEY || process.env.MOONSHOT_API_KEY;
const BASE_URL = (process.env.LLM_BASE_URL || process.env.MOONSHOT_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/$/, '');
const PRIMARY_MODEL = process.env.LLM_MODEL || process.env.MOONSHOT_MODEL || 'gemini-3.8-flash';
const IS_GEMINI = /googleapis\.com/i.test(BASE_URL);
const FALLBACKS = (process.env.LLM_FALLBACK_MODELS || (IS_GEMINI ? 'gemini-3.6-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite' : ''))
  .split(',').map((s) => s.trim()).filter(Boolean);
const EFFORT = (process.env.LLM_REASONING_EFFORT || 'low').toLowerCase();
const TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '45000', 10);
const MODEL = PRIMARY_MODEL;

function candidateModels() {
  const list = [PRIMARY_MODEL];
  for (const m of FALLBACKS) if (!list.includes(m)) list.push(m);
  return list;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Move to the next model only when this one is gone or overloaded. A bad key (401/403)
// fails the same way on every model, so it is raised immediately instead of retried.
const isMissing = (e) => e.status === 404 || /not\s*found|does not exist|no longer available|is not supported|deprecated/i.test(e.message);
const isTransient = (e) => [408, 429, 500, 502, 503, 504].includes(e.status) || e.name === 'AbortError' || /overloaded|unavailable|high demand|timed? ?out|ECONNRESET|fetch failed/i.test(e.message);
const isAuth = (e) => e.status === 401 || e.status === 403;

async function post(body, signal) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`LLM ${res.status}: ${detail.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

function buildBody(model, messages, { temperature, maxTokens }, withEffort, stream) {
  const body = { model, messages, temperature, max_tokens: maxTokens };
  if (withEffort && EFFORT && EFFORT !== 'off') body.reasoning_effort = EFFORT;
  if (stream) body.stream = true;
  return body;
}

// Runs fn(model, withEffort) across the candidate models with retry on overload.
// If a provider rejects reasoning_effort (400), retries that model once without it.
async function withFallback(fn) {
  if (!API_KEY) throw new Error('LLM_API_KEY is not set');
  let lastErr;
  for (const model of candidateModels()) {
    let withEffort = true;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await fn(model, withEffort); }
      catch (e) {
        lastErr = e;
        if (isAuth(e)) throw e;
        if (e.status === 400 && withEffort && /reasoning|effort|unknown (name|field)|unrecognized/i.test(e.message)) { withEffort = false; continue; }
        if (isTransient(e) && attempt < 2) { await sleep(600 * (attempt + 1)); continue; }
        break;
      }
    }
    if (!isMissing(lastErr) && !isTransient(lastErr)) throw lastErr;
  }
  throw lastErr;
}

// Returns { text, model }.
async function chat(messages, { temperature = 0.2, maxTokens = 3000 } = {}) {
  return withFallback(async (model, withEffort) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await post(buildBody(model, messages, { temperature, maxTokens }, withEffort, false), ctl.signal);
      const data = await res.json();
      const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
      if (!text.trim()) { const e = new Error('LLM returned an empty answer (finish_reason: ' + ((data.choices && data.choices[0] && data.choices[0].finish_reason) || 'unknown') + ')'); e.status = 503; throw e; }
      return { text, model };
    } finally { clearTimeout(timer); }
  });
}

// Streams tokens through onDelta(text). Returns { text, model }.
// Once a model has started emitting text we never switch models mid-answer.
async function streamChat(messages, { temperature = 0.2, maxTokens = 3000 } = {}, onDelta = () => {}) {
  return withFallback(async (model, withEffort) => {
    const ctl = new AbortController();
    let timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let full = '';
    try {
      const res = await post(buildBody(model, messages, { temperature, maxTokens }, withEffort, true), ctl.signal);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        clearTimeout(timer); timer = setTimeout(() => ctl.abort(), TIMEOUT_MS); // idle timeout, reset per chunk
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload);
            const delta = (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) || '';
            if (delta) { full += delta; onDelta(delta); }
          } catch (_) { /* keep-alive or partial line */ }
        }
      }
      if (!full.trim()) { const e = new Error('LLM stream ended with no text'); e.status = 503; throw e; }
      return { text: full, model };
    } catch (e) {
      if (full) { e.status = 0; e.message = 'stream interrupted: ' + e.message; e.partial = full; } // do not retry a half-sent answer
      throw e;
    } finally { clearTimeout(timer); }
  });
}

module.exports = { chat, streamChat, MODEL, candidateModels };
