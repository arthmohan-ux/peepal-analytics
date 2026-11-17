// netlify/functions/ask.js: BD Copilot endpoint for the Netlify deploy (non-streaming).
// All logic lives in ../lib/copilot so this and the Express server stay identical.
const copilot = require('../lib/copilot');

function validate(event) {
  const a = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  if (!a.startsWith('Basic ')) return false;
  const d = Buffer.from(a.slice(6), 'base64').toString('utf8');
  const i = d.indexOf(':');
  if (i < 0) return false;
  return d.slice(0, i) === process.env.SITE_USERNAME && d.slice(i + 1) === process.env.SITE_PASSWORD;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  if (!validate(event)) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: JSON.stringify({ error: 'Bad request' }) }; }
  const question = String(body.question || '').trim().slice(0, 2000);
  const history = Array.isArray(body.history) ? body.history.slice(-8) : [];
  const user = String(body.user || '').slice(0, 80);
  if (!question) return { statusCode: 400, body: JSON.stringify({ error: 'Empty question' }) };
  try {
    const out = await copilot.answer({ question, history, user });
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out) };
  } catch (e) {
    console.error('ask error:', e);
    return { statusCode: 500, body: JSON.stringify({ error: 'Copilot failed: ' + (e.message || 'unknown') }) };
  }
};
