// netlify/lib/llm.js
// Provider-agnostic chat completion over any OpenAI-compatible endpoint.
// Everything is set through env vars, so changing model or provider needs no code change.
//
//   LLM_API_KEY            required   Gemini AI Studio key (or any OpenAI-compatible key)
//   LLM_BASE_URL           optional   default https://generativelanguage.googleapis.com/v1beta/openai
//   LLM_MODEL              optional   default gemini-3.8-flash
//   LLM_FALLBACK_MODELS    optional   comma list tried in order after the primary
//   LLM_REASONING_EFFORT   optional   minimal | low | medium | high. Default "minimal": the hard work
//                                     (filtering, counting) is done in kb.js, so the model only has
//                                     to phrase. Set to "off" to send nothing.
//   LLM_FIRST_TOKEN_MS     optional   default 12000. A model that has not started writing by then is dropped.
//   LLM_HEDGE_MS           optional   default 6000. If the current model is still silent by then, the next
//                                     model starts in parallel. Whichever writes first wins; the other is cancelled.
//   LLM_IDLE_MS            optional   default 20000. Max silence between chunks once an answer has started.
//   LLM_COOLDOWN_MS        optional   default 300000. A model that just failed is skipped for this long,
//                                     so one bad model costs one question, not every question.
// Back-compat aliases still read: MOONSHOT_API_KEY / MOONSHOT_MODEL / MOONSHOT_BASE_URL

const API_KEY = process.env.LLM_API_KEY || process.env.MOONSHOT_API_KEY;
const BASE_URL = (process.env.LLM_BASE_URL || process.env.MOONSHOT_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/$/, '');
const PRIMARY_MODEL = process.env.LLM_MODEL || process.env.MOONSHOT_MODEL || 'gemini-3.8-flash';
const IS_GEMINI = /googleapis\.com/i.test(BASE_URL);
const FALLBACKS = (process.env.LLM_FALLBACK_MODELS || (IS_GEMINI ? 'gemini-3.6-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite' : ''))
  .split(',').map((s) => s.trim()).filter(Boolean);
const EFFORT = (process.env.LLM_REASONING_EFFORT || 'minimal').toLowerCase();
const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };
const FIRST_TOKEN_MS = int(process.env.LLM_FIRST_TOKEN_MS, 12000);
const HEDGE_MS = int(process.env.LLM_HEDGE_MS, 6000);
const IDLE_MS = int(process.env.LLM_IDLE_MS || process.env.LLM_TIMEOUT_MS, 20000);
const COOLDOWN_MS = int(process.env.LLM_COOLDOWN_MS, 5 * 60 * 1000);
const MODEL = PRIMARY_MODEL;

function candidateModels() {
  const list = [PRIMARY_MODEL];
  for (const m of FALLBACKS) if (!list.includes(m)) list.push(m);
  return list;
}

// ── model health ──────────────────────────────────────────────────────────────
// model -> { until, reason }. Models cooling down go to the back of the queue,
// not out of it, so the chain never runs dry.
const cooling = new Map();
// If a model rejects the effort level, step up to the next one it accepts rather than
// dropping the field: with no field, Gemini 3 thinks at its default level, which is slower.
const EFFORT_LADDER = ['minimal', 'low', 'medium', 'high'];
const effortFor = new Map(); // model -> effort that model accepts, or 'off'
function currentEffort(model) { return effortFor.has(model) ? effortFor.get(model) : EFFORT; }
function stepEffort(model) {
  const i = EFFORT_LADDER.indexOf(currentEffort(model));
  effortFor.set(model, i >= 0 && i < EFFORT_LADDER.length - 1 ? EFFORT_LADDER[i + 1] : 'off');
}

function orderedModels() {
  const now = Date.now();
  const all = candidateModels();
  const ok = all.filter((m) => !(cooling.get(m) && cooling.get(m).until > now));
  const cool = all.filter((m) => !ok.includes(m));
  return ok.concat(cool);
}

// Gemini puts a retry hint in 429 bodies ("retryDelay": "37s").
function retryHintMs(msg) {
  const m = /retry ?delay"?\s*:\s*"?(\d+(?:\.\d+)?)s/i.exec(msg || '') || /retry in (\d+(?:\.\d+)?)\s*s/i.exec(msg || '');
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : 0;
}
function coolDown(model, err) {
  const ms = Math.max(COOLDOWN_MS, retryHintMs(err && err.message));
  cooling.set(model, { until: Date.now() + ms, reason: String((err && err.message) || err).slice(0, 200) });
  console.warn(`[llm] ${model} skipped for ${Math.round(ms / 1000)}s: ${String((err && err.message) || err).slice(0, 200)}`);
}
function status() {
  const now = Date.now();
  return candidateModels().map((m) => {
    const c = cooling.get(m);
    const base = { model: m, effort: currentEffort(m) };
    return c && c.until > now ? Object.assign(base, { coolingForSec: Math.round((c.until - now) / 1000), lastError: c.reason }) : Object.assign(base, { ok: true });
  });
}

const isAuth = (e) => e.status === 401 || e.status === 403;
const isEffortReject = (e) => e.status === 400 && /reasoning|effort|thinking|unknown (name|field)|unrecognized|invalid value/i.test(e.message);

// ── one streaming attempt against one model ──────────────────────────────────
// Resolves { text } when the stream ends. Calls hooks.first() on the first content
// chunk; if that returns false the attempt cancels itself (another model won).
async function attempt(model, messages, { temperature, maxTokens }, ctl, hooks) {
  const body = { model, messages, temperature, max_tokens: maxTokens, stream: true };
  const effort = currentEffort(model);
  if (effort !== 'off') body.reasoning_effort = effort;

  let timer = setTimeout(() => ctl.abort(new Error(`no answer from ${model} within ${FIRST_TOKEN_MS / 1000}s`)), FIRST_TOKEN_MS);
  let full = '';
  let started = false;
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const err = new Error(`LLM ${res.status}: ${detail.slice(0, 400)}`);
      err.status = res.status;
      if (isEffortReject(err) && body.reasoning_effort) {
        clearTimeout(timer);
        stepEffort(model);
        return attempt(model, messages, { temperature, maxTokens }, ctl, hooks);
      }
      throw err;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let delta = '';
        try {
          const j = JSON.parse(payload);
          delta = (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) || '';
        } catch (_) { continue; } // keep-alive or partial line
        if (!delta) continue;
        if (!started) {
          started = true;
          if (!hooks.first()) { ctl.abort(); return { text: '' }; }
        }
        clearTimeout(timer);
        timer = setTimeout(() => ctl.abort(new Error(`${model} stalled mid-answer`)), IDLE_MS);
        full += delta;
        hooks.delta(delta);
      }
    }
    if (!full.trim()) { const e = new Error(`${model} returned no text`); e.status = 503; throw e; }
    return { text: full };
  } catch (e) {
    const err = ctl.signal.aborted && ctl.signal.reason instanceof Error ? ctl.signal.reason : e;
    if (started) err.partial = full;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── hedged race across the model chain ───────────────────────────────────────
// Start the healthiest model. If it errors, start the next one at once. If it is
// merely slow, start the next one after HEDGE_MS without cancelling the first.
// The first model to produce text wins and every other attempt is cancelled.
// Returns { text, model, tried } where tried lists models that lost or failed.
function streamChat(messages, { temperature = 0.2, maxTokens = 1500 } = {}, onDelta = () => {}) {
  if (!API_KEY) return Promise.reject(new Error('LLM_API_KEY is not set'));
  const models = orderedModels();
  const t0 = Date.now();

  return new Promise((resolve, reject) => {
    const live = new Map(); // model -> AbortController
    const started = new Map(); // model -> launch time
    const tried = [];
    let next = 0;
    let winner = null;
    let finished = false;
    let lastErr = null;
    let hedge = null;

    const end = (fn, val) => {
      if (finished) return;
      finished = true;
      clearTimeout(hedge);
      for (const [m, c] of live) if (m !== (val && val.model)) c.abort();
      fn(val);
    };

    const launch = () => {
      if (finished || winner) return;
      clearTimeout(hedge);
      if (next >= models.length) {
        if (live.size === 0) end(reject, lastErr || new Error('No model available'));
        return;
      }
      const model = models[next++];
      const ctl = new AbortController();
      live.set(model, ctl);
      started.set(model, Date.now());
      hedge = setTimeout(launch, HEDGE_MS);

      attempt(model, messages, { temperature, maxTokens }, ctl, {
        first: () => {
          if (winner) return false;
          winner = model;
          clearTimeout(hedge);
          for (const [m, c] of live) {
            if (m === model) continue;
            c.abort();
            // A model that started first and was still silent when a later one answered is
            // benched, so the next question does not wait out the hedge on it again.
            const silentFor = Date.now() - started.get(m);
            if (silentFor > Date.now() - started.get(model)) coolDown(m, new Error(`silent for ${(silentFor / 1000).toFixed(1)}s while ${model} answered`));
            tried.push({ model: m, ms: Date.now() - t0, error: 'slower, cancelled' });
          }
          cooling.delete(model);
          return true;
        },
        delta: (d) => { if (winner === model) onDelta(d); },
      }).then(({ text }) => {
        live.delete(model);
        if (winner === model) end(resolve, { text, model, tried, firstTokenModel: model, ms: Date.now() - t0 });
        else if (!winner && live.size === 0 && next >= models.length) end(reject, lastErr || new Error('No model answered'));
      }).catch((e) => {
        live.delete(model);
        if (finished) return;
        if (winner && winner !== model) return; // a loser we cancelled
        if (winner === model) { // failed mid-answer: never switch models halfway through a sentence
          e.status = 0;
          e.message = 'stream interrupted: ' + e.message;
          return end(reject, e);
        }
        lastErr = e;
        tried.push({ model, ms: Date.now() - t0, error: String(e.message || e).slice(0, 160) });
        if (isAuth(e)) return end(reject, e); // a bad key fails the same on every model
        coolDown(model, e);
        launch(); // do not wait for the hedge timer
      });
    };

    launch();
  });
}

// Non-streaming callers get the same race, collected into one string.
function chat(messages, opts = {}) {
  return streamChat(messages, opts, () => {});
}

module.exports = { chat, streamChat, MODEL, candidateModels, status };
