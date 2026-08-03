// netlify/functions/queries.js — return recent logged queries (for the recent-10 + view-all UI).
const { recentQueries } = require('../lib/copilot');

function validate(event) {
  const a = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  if (!a.startsWith('Basic ')) return false;
  const d = Buffer.from(a.replace('Basic ', ''), 'base64').toString('utf8');
  const [u, p] = d.split(':');
  return u === process.env.SITE_USERNAME && p === process.env.SITE_PASSWORD;
}

exports.handler = async (event) => {
  if (!validate(event)) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  try {
    const queries = await recentQueries(200); // newest first; UI shows 10 + full filterable list
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ queries }) };
  } catch (e) {
    console.error('queries error:', e);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to load queries: ' + (e.message || 'unknown') }) };
  }
};
