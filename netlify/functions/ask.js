// netlify/functions/ask.js — BD Copilot endpoint (non-streaming, reliable CJS style).
// Uses the delimited output format (fixes the raw-JSON render bug) and logs each query.
const { prepare, cleanSay, parseRead, logQuery } = require('../lib/copilot');
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
    // Two parallel calls: SAY sees client-safe context only (can't leak); READ sees everything.
    const [sayRaw, readRaw] = await Promise.all([
      chat(prep.sayMessages, { temperature: 0.5, jsonMode: false, maxTokens: 900 }),
      chat(prep.readMessages, { temperature: 0.5, jsonMode: false, maxTokens: 900 }),
    ]);
    const grounded = cleanSay(sayRaw);
    const read = parseRead(readRaw);
    await logQuery({ question, type: read.type, industry: prep.industryTag, confidence: read.confidence, sources: read.sources, user });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grounded, opinion: read.opinion,
        confidence: read.confidence, sources: read.sources,
        industry: prep.industryTag, type: read.type,
      }),
    };
  } catch (e) {
    console.error('ask error:', e);
    return { statusCode: 500, body: JSON.stringify({ error: 'Copilot failed: ' + (e.message || 'unknown') }) };
  }
};
