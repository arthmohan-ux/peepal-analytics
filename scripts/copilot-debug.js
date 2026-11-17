#!/usr/bin/env node
// Shows what the Copilot's retrieval does with a question, without calling the model.
// Use it to answer "why did it say that?" and to check a fix before deploying.
//
//   node scripts/copilot-debug.js "java hires in bfsi last year"      one question, summary
//   node scripts/copilot-debug.js -v "diage"                          plus the full context sent to the model
//   node scripts/copilot-debug.js --golden                            run scripts/golden.json and report pass/fail
//
// Needs the same env vars as the server (SHEET_ID + Google service account).
const path = require('path');
const kb = require('../netlify/lib/kb');

function summary(q, r) {
  const s = r.scope;
  return [
    `Q: ${q}`,
    `  type: ${r.type} | evidence: ${r.evidence} | mode: ${r.mode}${r.inherited ? ' | scope inherited from previous turn' : ''}`,
    `  clients: ${s.companies.map((c) => `${c.name} (${c.joinees})`).join(', ') || '-'}` + (s.fuzzyNotes.length ? `  [fuzzy: ${s.fuzzyNotes.map((f) => f.typed + ' -> ' + f.resolved).join(', ')}]` : ''),
    `  clients-tab only: ${s.touched.map((t) => t.name).join(', ') || '-'} | not in data: ${s.unknownNames.join(', ') || '-'}`,
    `  industries direct: ${s.directIndustries.join(', ') || '-'} | adjacent: ${s.adjacencyNotes.map((n) => n.term + ' -> ' + n.industries.join('/')).join('; ') || '-'}`,
    `  skills: ${s.skills.map((x) => `${x.term} (${x.total})`).join(', ') || '-'} | dates: ${s.ranges.map((x) => `${x.label} [${x.from}..${x.to}]`).join(', ') || '-'}`,
    `  fact cards: ${r.facts.map((f) => f.label + ' = ' + f.value).join(' | ') || '-'}`,
    `  sources: ${r.sources.join(', ') || '-'}`,
    `  context size: client-safe ${r.clientSafe.length} chars, technique ${r.technique.length}, internal ${r.internal.length}`,
  ].join('\n');
}

(async () => {
  const args = process.argv.slice(2);
  const pack = await kb.getPack();
  if (args[0] === '--golden') {
    const cases = require(path.join(__dirname, 'golden.json'));
    let pass = 0; const fails = [];
    for (const c of cases) {
      const r = kb.assembleContext(c.q, pack, { prevQuestion: c.prev || '' });
      const s = r.scope; const problems = [];
      if (c.type && r.type !== c.type) problems.push(`type ${r.type}, expected ${c.type}`);
      if (c.evidence && r.evidence !== c.evidence) problems.push(`evidence ${r.evidence}, expected ${c.evidence}`);
      if (c.client && !s.companies.some((x) => x.name === c.client)) problems.push(`client ${c.client} not resolved`);
      if (c.noClient && s.companies.length) problems.push(`resolved ${s.companies.map((x) => x.name).join(',')}, expected no client`);
      if (c.industry && !s.directIndustries.includes(c.industry)) problems.push(`industry ${c.industry} not direct`);
      if (c.adjacent && !s.adjacencyNotes.some((n) => n.industries.includes(c.adjacent))) problems.push(`adjacent ${c.adjacent} missing`);
      if (c.skill && !s.skills.some((x) => x.term === c.skill)) problems.push(`skill "${c.skill}" missing (got ${s.skills.map((x) => x.term).join(',') || 'none'})`);
      if (c.unknown && !s.unknownNames.some((n) => n.toLowerCase().includes(c.unknown))) problems.push(`"${c.unknown}" should be flagged not-in-data`);
      if (c.range && !s.ranges.length) problems.push('no date range parsed');
      if (c.exact && !/## EXACT ANSWER/.test(r.clientSafe)) problems.push('no EXACT ANSWER block');
      if (problems.length) fails.push({ q: c.q, problems }); else pass++;
    }
    console.log(`${pass}/${cases.length} passed`);
    fails.forEach((f) => console.log(`FAIL: ${f.q}\n      ${f.problems.join('; ')}`));
    process.exit(fails.length ? 1 : 0);
  }
  const verbose = args[0] === '-v'; if (verbose) args.shift();
  for (const q of args) {
    const r = kb.assembleContext(q, pack, {});
    console.log(summary(q, r));
    if (verbose) console.log('\n===== CLIENT-SAFE =====\n' + r.clientSafe + '\n\n===== TECHNIQUE =====\n' + r.technique + '\n\n===== INTERNAL =====\n' + r.internal + '\n');
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
