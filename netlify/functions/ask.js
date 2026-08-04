// netlify/functions/ask.js — BD Copilot endpoint (non-streaming, reliable CJS style).
// Uses the delimited output format (fixes the raw-JSON render bug) and logs each query.
const { prepare, parseSections, logQuery } = require('../lib/copilot');
const { chat } = require('../lib/llm');

function validate(event) {
  const a = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  if (!a.startsWith('Basic ')) return false;
  const d = Buffer.from(a.replace('Basic ', ''), 'base64').toString('utf8');
  const [u, p] = d.split(':');
  return u === process.env.SITE_USERNAME && p === process.env.SITE_PASSWORD;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  if (!validate(event)) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: JSON.stringify({ error: 'Bad request' }) }; }
  const question = String(body.question || '').trim();
  const history = Array.isArray(body.history) ? body.history.slice(-8) : [];
  const user = String(body.user || '');
  if (!question) return { statusCode: 400, body: JSON.stringify({ error: 'Empty question' }) };

  try {
    const prep = await prepare(question, history);
    const raw = await chat(prep.messages, { temperature: 0.5, jsonMode: false, maxTokens: 2048 });
    const parsed = parseSections(raw);
    await logQuery({ question, type: parsed.type, industry: prep.industryTag, confidence: parsed.confidence, sources: parsed.sources, user });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grounded: parsed.grounded, opinion: parsed.opinion,
        confidence: parsed.confidence, sources: parsed.sources,
        industry: prep.industryTag, type: parsed.type,
      }),
    };
  } catch (e) {
    console.error('ask error:', e);
    return { statusCode: 500, body: JSON.stringify({ error: 'Copilot failed: ' + (e.message || 'unknown') }) };
  }
};
