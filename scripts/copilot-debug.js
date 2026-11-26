#!/usr/bin/env node
// Debug the BD Copilot from the command line.
//
//   node scripts/copilot-debug.js --query '{"table":"joinees","filters":[{"field":"month","op":"eq","value":"2026-11"}],"group_by":["client"]}'
//       Run one query exactly as the model would. No model call: free and instant.
//   node scripts/copilot-debug.js "how many joinees in nov 2026"
//       Full answer with the model. Prints every query it ran, then the answer.
//   node scripts/copilot-debug.js --golden
//       Runs scripts/golden.json through the model and checks each answer (numbers are
//       re-computed from the live data, so the checks never go stale).
//       --from N starts at question N; --pause S waits S seconds between questions
//       (the Gemini free tier allows about 15 requests a minute).
//
// Env: the same as the server (SHEET_ID + Google credentials, LLM_API_KEY ...), or
// TRACKER_JSON=/path/dump.json to read a local dump instead of the sheet.

const path = require('path');
const data = require('../netlify/lib/data');
const { runTool } = require('../netlify/lib/query');
const copilot = require('../netlify/lib/copilot');

const fmtIN = (n) => Number(n).toLocaleString('en-IN');
const fmtUS = (n) => Number(n).toLocaleString('en-US');
const countOf = (r) => (r.totals && r.totals.count != null ? r.totals.count : r.matched_rows);

async function ask(question, history = []) {
  const events = [];
  const out = await copilot.answer({ question, history, user: 'debug' }, (e) => { if (e.type === 'tool') events.push(e.summary + (e.ok ? ` → ${e.matched != null ? e.matched + ' rows' : 'ok'}` : ` (error: ${String(e.error || '').slice(0, 120)})`)); });
  return { out, events };
}

async function golden({ from = 1, pause = 0 } = {}) {
  const d = await data.getData();
  const cases = require(path.join(__dirname, 'golden.json')).slice(Math.max(0, from - 1));
  let pass = 0, first = true;
  for (const c of cases) {
    if (!first && pause) await new Promise((r) => setTimeout(r, pause * 1000)); // stay under free-tier rate limits
    first = false;
    const problems = [];
    let res;
    try { res = await ask(c.q, c.prev ? [{ role: 'user', content: c.prev }, { role: 'assistant', content: c.prevAnswer || '' }] : []); }
    catch (e) { console.log(`FAIL  ${c.q}\n      error: ${e.message}`); continue; }
    const { out, events } = res;
    const text = [out.grounded, out.proof, out.opinion].join('\n');
    if (c.mode && out.mode !== c.mode) problems.push(`mode ${out.mode}, expected ${c.mode}`);
    if (c.evidence && !c.evidence.split('|').includes(out.evidence)) problems.push(`evidence ${out.evidence}, expected ${c.evidence}`);
    if (c.mustQuery && !events.length) problems.push('ran no query');
    (c.contains || []).forEach((s) => { if (!text.toLowerCase().includes(String(s).toLowerCase())) problems.push(`missing "${s}"`); });
    if (c.containsLatestJoinee) {
      const iso = d.coverage.latestJoinee; const [y, m, dd] = iso.split('-');
      const mon = new Date(iso + 'T00:00:00Z').toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
      if (![iso, `${+dd} ${mon}`, `${mon} ${+dd}`, `${dd}/${m}/${y}`].some((s) => text.includes(s))) problems.push(`latest joinee date ${iso} not stated`);
    }
    if (c.check) {
      const r = runTool(d, 'query_tracker', c.check);
      const n = countOf(r);
      if (![String(n), fmtIN(n), fmtUS(n)].some((s) => new RegExp('(^|[^0-9,])' + s.replace(/[.,]/g, '\\$&') + '([^0-9,]|$)').test(text))) problems.push(`expected the number ${n} (from ${JSON.stringify(c.check.filters || [])})`);
    }
    if (problems.length) console.log(`FAIL  ${c.q}\n      ${problems.join('; ')}\n      queries: ${events.join(' | ') || 'none'}\n      answer: ${out.grounded.replace(/\s+/g, ' ').slice(0, 220)}`);
    else { pass++; console.log(`pass  ${c.q}  (${(out.ms / 1000).toFixed(1)}s, ${events.length} queries, ${out.model})`); }
  }
  console.log(`\n${pass}/${cases.length} passed`);
  if (pass < cases.length) process.exitCode = 1;
}

(async () => {
  const args = process.argv.slice(2);
  if (!args.length) { console.log('Usage: copilot-debug.js "question" | --query \'{json}\' | --golden'); return; }
  if (args[0] === '--golden') { // --golden [--from N] [--pause SECONDS]
    const opt = (k) => { const i = args.indexOf(k); return i > 0 ? parseInt(args[i + 1], 10) || 0 : 0; };
    return golden({ from: opt('--from') || 1, pause: opt('--pause') });
  }
  if (args[0] === '--query') {
    const d = await data.getData();
    console.log(JSON.stringify(runTool(d, args[2] || 'query_tracker', JSON.parse(args[1])), null, 2));
    return;
  }
  const { out, events } = await ask(args.join(' '));
  console.log('Data:', JSON.stringify(out.dataAsOf));
  console.log('Queries:\n  ' + (events.join('\n  ') || 'none'));
  console.log(`\nMode: ${out.mode} | confidence: ${out.confidence} | evidence: ${out.evidence} | type: ${out.type} | ${out.model} | ${(out.ms / 1000).toFixed(1)}s, ${out.rounds} rounds\n`);
  console.log(out.grounded);
  if (out.proof) console.log('\n[PROOF]\n' + out.proof);
  if (out.ask) console.log('\n[ASK]\n' + out.ask);
  if (out.opinion) console.log('\n[' + (out.mode === 'client' ? 'READ' : 'NOTES') + ']\n' + out.opinion);
})().catch((e) => { console.error(e); process.exit(1); });
