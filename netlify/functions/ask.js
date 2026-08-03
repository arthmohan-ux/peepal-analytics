// netlify/functions/ask.js
// BD Copilot query endpoint. Auth-gated (same Basic token as the rest of the app).
// Flow: scope the question -> assemble bounded context -> call Kimi -> return two-section JSON.

const { getPack, assembleContext } = require('../lib/kb');
const { chat, MODEL } = require('../lib/llm');

function validateAuth(event) {
  const authHeader = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  if (!authHeader.startsWith('Basic ')) return false;
  const decoded = Buffer.from(authHeader.replace('Basic ', ''), 'base64').toString('utf8');
  const [u, p] = decoded.split(':');
  return u === process.env.SITE_USERNAME && p === process.env.SITE_PASSWORD;
}

const SYSTEM_RULES = `You are Peepal Consulting's BD Copilot. You help a business-development rep prepare things to say on a live client/prospect call, drawn ONLY from the DATA and KNOWLEDGE provided in the context block.

HARD RULES:
1. NUMBERS: Use only the exact numbers given in the context (totals, per-company, per-industry). NEVER invent, estimate, or sum numbers yourself. If a specific number is not in the context, say you don't have it rather than guessing. Company/industry TOTALS are exact; anything labelled "heuristic/approximate" (e.g. seniority splits) must be presented as approximate.
2. STORIES: When citing a case study, prefer the "SAY THIS (client-safe)" wording. NEVER speak any line marked "INTERNAL ONLY" to a client — that includes exact case-study metrics, competitor names to avoid, and internal notes.
3. INTERNAL DOCTRINE: Anything marked "(INTERNAL ONLY)" — targeting status like skip/not-converting/disqualified, the fee grid, converting/not-converting company lists — is rep-only strategy. Use it to shape the OPINION section, but NEVER phrase it as something to say aloud to the client.
4. Prefer the story/insight whose PROBLEM mirrors the prospect's. Match, don't recite.

OUTPUT: Respond with a single JSON object, no prose outside it, with these keys:
{
  "grounded": "Markdown. The call-ready answer, strictly from the data/stories. Lead with the single most apt point (primary), then secondary and tertiary points, most-apt to least. Use concrete numbers from the context. If fusing a story, use the client-safe wording. Short, punchy, ready to say on a call.",
  "opinion": "Markdown. Your internal read/angle for the rep: how to play it, which service to steer to, ICP/stage/targeting cautions. May use INTERNAL-ONLY doctrine. If the data is thin, say so and keep this conservative.",
  "confidence": "high | medium | low  (how well the data actually supports the answer)",
  "sources_used": ["source_id or doctrine id you leaned on"]
}
If the question is a follow-up, use the conversation so far to resolve references (e.g. "their drops" = the company discussed).`;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  if (!validateAuth(event)) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: JSON.stringify({ error: 'Bad request' }) }; }

  const question = String(payload.question || '').trim();
  const history = Array.isArray(payload.history) ? payload.history.slice(-8) : []; // [{role:'user'|'assistant', content}]
  if (!question) return { statusCode: 400, body: JSON.stringify({ error: 'Empty question' }) };

  try {
    const pack = await getPack();

    // Scope from the whole conversation so follow-ups resolve ("what about their drops?")
    const convText = history.filter((m) => m.role === 'user').map((m) => m.content).join(' ') + ' ' + question;
    const { context, scope } = assembleContext(convText, pack);

    const messages = [
      { role: 'system', content: SYSTEM_RULES },
      { role: 'system', content: 'CONTEXT (this is your only source of truth):\n\n' + context },
    ];
    // prior turns for reference resolution (assistant turns are the grounded text only, kept short)
    history.forEach((m) => {
      if (m.role === 'user') messages.push({ role: 'user', content: String(m.content).slice(0, 800) });
      else if (m.role === 'assistant') messages.push({ role: 'assistant', content: String(m.content).slice(0, 1200) });
    });
    messages.push({ role: 'user', content: question });

    const raw = await chat(messages, { temperature: 0.3, jsonMode: true, maxTokens: 1400 });

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch {
      // Fallback: return the raw text as grounded so the UI still shows something useful
      parsed = { grounded: raw || 'No answer.', opinion: '', confidence: 'low', sources_used: [] };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grounded: parsed.grounded || '',
        opinion: parsed.opinion || '',
        confidence: parsed.confidence || 'medium',
        sources_used: parsed.sources_used || [],
        debug: { model: MODEL, matchedCompanies: scope.companies.map((c) => c.name), industries: scope.industries },
      }),
    };
  } catch (err) {
    console.error('ask error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Copilot failed: ' + (err.message || 'unknown') }) };
  }
};
