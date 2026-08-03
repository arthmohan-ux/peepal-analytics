// netlify/functions/ask.mjs — streaming BD Copilot endpoint (Netlify Functions v2).
// Streams the answer as Server-Sent Events so text appears as it generates.
import { prepare, parseSections, logQuery } from '../lib/copilot.js';
import { streamChat } from '../lib/llm.js';

function validate(req) {
  const a = req.headers.get('authorization') || '';
  if (!a.startsWith('Basic ')) return false;
  const d = Buffer.from(a.slice(6), 'base64').toString('utf8');
  const [u, p] = d.split(':');
  return u === process.env.SITE_USERNAME && p === process.env.SITE_PASSWORD;
}
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!validate(req)) return json({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
  const question = String(body.question || '').trim();
  const history = Array.isArray(body.history) ? body.history.slice(-8) : [];
  const user = String(body.user || '');
  if (!question) return json({ error: 'Empty question' }, 400);

  let prep;
  try { prep = await prepare(question, history); }
  catch (e) { return json({ error: 'prepare failed: ' + (e.message || 'unknown') }, 500); }

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(enc.encode('data: ' + JSON.stringify(obj) + '\n\n'));
      let full = '';
      try {
        full = await streamChat(prep.messages, { maxTokens: 1600 }, (delta) => send({ t: 'delta', v: delta }));
      } catch (e) {
        send({ t: 'error', v: 'Copilot failed: ' + (e.message || 'unknown') });
        controller.close();
        return;
      }
      const parsed = parseSections(full);
      send({ t: 'done', confidence: parsed.confidence, type: parsed.type, sources: parsed.sources, industry: prep.industryTag });
      controller.close();
      // log after the stream is delivered (fire-and-forget within the function)
      await logQuery({ question, type: parsed.type, industry: prep.industryTag, confidence: parsed.confidence, sources: parsed.sources, user });
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  });
};
