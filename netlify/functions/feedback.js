// netlify/functions/feedback.js — save a thumbs up/down + note to the Feedback tab.
const { saveFeedback } = require('../lib/copilot');

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
  let b;
  try { b = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: JSON.stringify({ error: 'Bad request' }) }; }
  if (!b.vote) return { statusCode: 400, body: JSON.stringify({ error: 'Missing vote' }) };
  try {
    await saveFeedback({ question: b.question, answer: b.answer, vote: b.vote, note: b.note, sources: b.sources, user: b.user });
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    console.error('feedback error:', e);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to save feedback: ' + (e.message || 'unknown') }) };
  }
};
