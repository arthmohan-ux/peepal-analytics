// netlify/functions/feedback-report.js — read the Feedback tab back for the monthly audit.
// Reporting only: nothing here feeds the prompt or changes answers.
const { recentFeedback, summariseFeedback } = require('../lib/copilot');

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
    const rows = await recentFeedback(1000);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: summariseFeedback(rows), feedback: rows }),
    };
  } catch (e) {
    console.error('feedback-report error:', e);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to load feedback: ' + (e.message || 'unknown') }) };
  }
};
