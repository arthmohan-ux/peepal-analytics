// netlify/lib/copilot.js
// Shared BD Copilot logic used by both the Netlify function and the Express server.
// Delimited output format (no strict JSON) so answers stream cleanly and never break
// the UI on truncation.

const { getPack, assembleContext } = require('./kb');
const { ensureTab, appendRows } = require('./sheets');

const QUERY_TYPES = ['Company lookup', 'Skill/Role', 'Industry', 'Geography', 'Objection handling', 'Pricing', 'ICP/Targeting', 'Case study', 'Other'];

const SYSTEM = `You are Peepal Consulting's BD Copilot. You help a business-development rep prepare things to say on a live client/prospect call, drawn ONLY from the DATA and KNOWLEDGE in the context block.

HARD RULES:
1. NUMBERS: Use only the exact numbers in the context. NEVER invent, estimate, or sum numbers yourself. If a number is not present, say you don't have it. Totals are exact; anything labelled heuristic/approximate must be presented as approximate.
2. STORIES: Prefer the "SAY THIS (client-safe)" wording. NEVER speak any line marked "INTERNAL ONLY" to a client.
3. INTERNAL DOCTRINE: Anything marked "(INTERNAL ONLY)" is rep-only strategy — use it in the READ section, never as something to say aloud.
4. Prefer the story whose PROBLEM mirrors the prospect's. Match, don't recite.

OUTPUT FORMAT — respond in EXACTLY this shape, nothing before or after:
[[SAY]]
<the call-ready answer, in markdown. Lead with the single most apt point, then secondary and tertiary, most-apt first. BE SPECIFIC TO THIS QUESTION: use concrete numbers, named proof points, real client examples and stacks from the context. Do NOT write generic boilerplate that could apply to any prospect. If it's a strategy/advice question with no specific client, still ground it in concrete Peepal proof (specific metrics, named sub-ICP companies, real stacks) rather than vague claims. Client-safe wording. Short and punchy. FORMATTING: wrap hard facts and numbers in **bold**, and use *italics* to emphasise the key phrase to lean on. Do not over-format — bold the facts, italicise sparingly.>
[[READ]]
<your internal read for the rep: how to play it, which service to steer to, ICP/stage/targeting cautions. May use INTERNAL-ONLY doctrine. If data is thin, say so and stay conservative.>
[[META]]
confidence: high|medium|low
type: one of [${QUERY_TYPES.join(', ')}]
sources: comma-separated ids you leaned on`;

async function prepare(question, history) {
  const pack = await getPack();
  const convText = (history || []).filter((m) => m.role === 'user').map((m) => m.content).join(' ') + ' ' + question;
  const { context, scope } = assembleContext(convText, pack);
  const messages = [{ role: 'system', content: SYSTEM + '\n\nCONTEXT (your only source of truth):\n\n' + context }];
  (history || []).forEach((m) => {
    if (m.role === 'user') messages.push({ role: 'user', content: String(m.content).slice(0, 800) });
    else if (m.role === 'assistant') messages.push({ role: 'assistant', content: String(m.content).slice(0, 1200) });
  });
  messages.push({ role: 'user', content: question });
  return { messages, scope, industryTag: tagIndustry(question, scope) };
}

// Industry tag for logging — robust: sub-vertical map first, then a directly named
// industry, then a single clearly-named company's industry, else General.
function tagIndustry(question, scope) {
  const q = (question || '').toLowerCase();
  if (/\b(what can you|what do you|what all|help with|your capabilities|who are you|how do you work)\b/.test(q)) return 'General';
  const subICP = [
    ['semiconductor', 'Manufacturing'], ['medtech', 'Manufacturing'], ['medical device', 'Manufacturing'], ['med device', 'Manufacturing'],
    ['fintech', 'BFSI'], ['insurance', 'BFSI'], ['healthcare', 'Pharma'],
  ];
  for (const [kw, ind] of subICP) if (q.includes(kw)) return ind;
  if (scope.namedIndustries && scope.namedIndustries.length) return scope.namedIndustries[0];
  if (scope.companies && scope.companies.length === 1 && scope.companies[0].industry) return scope.companies[0].industry;
  return 'General';
}

// Split the delimited model output into sections.
function parseSections(text) {
  const t = String(text || '');
  const say = t.match(/\[\[SAY\]\]([\s\S]*?)(?:\[\[READ\]\]|\[\[META\]\]|$)/i);
  const read = t.match(/\[\[READ\]\]([\s\S]*?)(?:\[\[META\]\]|$)/i);
  const meta = t.match(/\[\[META\]\]([\s\S]*)$/i);
  const grounded = say ? say[1].trim() : t.trim();
  const opinion = read ? read[1].trim() : '';
  let confidence = 'medium', type = 'Other', sources = '';
  if (meta) {
    const mc = meta[1].match(/confidence:\s*(high|medium|low)/i); if (mc) confidence = mc[1].toLowerCase();
    const mt = meta[1].match(/type:\s*([^\n]+)/i); if (mt) type = mt[1].trim().replace(/^\[|\]$/g, '');
    const ms = meta[1].match(/sources:\s*([^\n]+)/i); if (ms) sources = ms[1].trim();
  }
  return { grounded, opinion, confidence, type, sources };
}

const LOG_TAB = 'QueryLog';
const LOG_HEADERS = ['Timestamp', 'Question', 'Type', 'Industry', 'Confidence', 'Sources', 'User'];
const FEEDBACK_TAB = 'Feedback';
const FEEDBACK_HEADERS = ['Timestamp', 'Question', 'Answer', 'Vote', 'Note', 'Sources', 'User'];

async function logQuery({ question, type, industry, confidence, sources, user }) {
  try {
    await ensureTab(LOG_TAB, LOG_HEADERS);
    await appendRows(LOG_TAB, [[new Date().toISOString(), question || '', type || '', industry || '', confidence || '', sources || '', user || '']]);
  } catch (e) { console.error('logQuery failed:', e.message); }
}

async function saveFeedback({ question, answer, vote, note, sources, user }) {
  await ensureTab(FEEDBACK_TAB, FEEDBACK_HEADERS);
  await appendRows(FEEDBACK_TAB, [[new Date().toISOString(), question || '', (answer || '').slice(0, 4000), vote || '', note || '', sources || '', user || '']]);
}

async function recentQueries(limit = 50) {
  const { getSheetData } = require('./sheets');
  let rows = [];
  try { rows = await getSheetData(LOG_TAB); } catch (_) { return []; }
  if (!rows || rows.length < 2) return [];
  const out = rows.slice(1).map((r) => ({
    timestamp: r[0] || '', question: r[1] || '', type: r[2] || '', industry: r[3] || '', confidence: r[4] || '', sources: r[5] || '',
  })).filter((q) => q.question);
  return out.reverse().slice(0, limit); // newest first
}

module.exports = { SYSTEM, QUERY_TYPES, prepare, parseSections, logQuery, saveFeedback, recentQueries, LOG_TAB, FEEDBACK_TAB };
