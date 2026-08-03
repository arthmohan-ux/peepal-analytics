// netlify/lib/kb.js
// Builds the exact number pack + loads the curated KB tabs (Sources, Doctrine, Playbook),
// then assembles a scoped, bounded context for the BD Copilot.
// Numbers are precomputed here so the LLM only ever LOOKS UP values, never sums them.

const { getSheetData } = require('./sheets');

// ── config ──────────────────────────────────────────────────────────────────
const INDUSTRY_SHEETS = [
  'IT - Product', 'Media and Entertainment', 'BFSI', 'Consulting',
  'Manufacturing & Engineering', 'Telecommunications', 'FMCG, Retail & Consumer Commerc',
  'IT - Services & Consulting', 'Pharma', 'Real Estate', 'Aviation',
];
const KB_TABS = ['Sources', 'Doctrine', 'Playbook'];
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min; sheet changes ~monthly, so this is generous

// ── small helpers ─────────────────────────────────────────────────────────────
function safeFloat(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function safeDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
}

// Heuristic seniority tier from a designation string. Conservative; flagged as heuristic downstream.
function seniorityTier(desig) {
  const d = String(desig || '').toLowerCase();
  if (/\b(chief|cxo|ceo|cto|coo|cfo|vp|vice president|head|director|principal|partner)\b/.test(d)) return 'Leadership';
  if (/\b(manager|lead|architect|staff)\b/.test(d)) return 'Manager/Lead';
  if (/\b(senior|sr\.?|specialist|consultant)\b/.test(d)) return 'Senior';
  if (/\b(junior|jr\.?|associate|analyst|executive|trainee|intern|fresher)\b/.test(d)) return 'Junior/Entry';
  return 'Mid/Other';
}

// Industry adjacency — used to widen insight scope to neighbouring sectors.
// Keys/values are matched loosely (normalized substring), so both sheet-short
// ('BFSI','Telecom','IT Prod') and display names work.
const ADJACENCY = {
  bfsi: ['insurance', 'fintech', 'consulting'],
  insurance: ['bfsi', 'fintech'],
  consulting: ['bfsi', 'itservices'],
  itprod: ['itservices', 'telecom', 'semiconductor'],
  itservicesconsulting: ['itprod', 'consulting'],
  telecom: ['itprod'],
  manufacturing: ['engineering', 'semiconductor', 'medicaldevices', 'aviation'],
  pharma: ['healthcare', 'medicaldevices'],
  realestate: [],
  aviation: ['manufacturing'],
  mediaandentertainment: [],
  fmcg: ['retail'],
};
function adjacentTo(industryKeyNorm) {
  for (const [k, v] of Object.entries(ADJACENCY)) {
    if (industryKeyNorm.includes(k) || k.includes(industryKeyNorm)) return v;
  }
  return [];
}

// ── pack builder (cached) ─────────────────────────────────────────────────────
let _cache = null; // { at, pack }

async function buildPack() {
  const [joineeRows, dropRows, engRows, ...kbAndIndustry] = await Promise.all([
    getSheetData('Joinees All'),
    getSheetData('Offer Drop All'),
    getSheetData('Client Last Engagement'),
    ...KB_TABS.map((t) => getSheetData(t).catch(() => [])),
    ...INDUSTRY_SHEETS.map((t) => getSheetData(t).catch(() => [])),
  ]);
  const kbRows = kbAndIndustry.slice(0, KB_TABS.length);
  const industryRows = kbAndIndustry.slice(KB_TABS.length);

  // --- companies from Joinees + Drops ---
  const companies = {}; // key: normalized name -> stats
  function ensure(name) {
    const k = norm(name);
    if (!companies[k]) {
      companies[k] = {
        name: String(name).trim(), industry: '', hq: '',
        joinees: 0, drops: 0, revenue: 0,
        byDesig: {}, byRole: {}, bySeniority: {},
        firstJoin: null, lastJoin: null,
      };
    }
    return companies[k];
  }

  joineeRows.slice(1).forEach((r) => {
    if (!r || !r[0] || !r[6]) return;
    const c = ensure(r[6]);
    c.joinees += 1;
    c.revenue += safeFloat(r[9]);
    if (!c.industry && r[8]) c.industry = String(r[8]).trim();
    if (!c.hq && r[7]) c.hq = String(r[7]).trim();
    const desig = r[11] ? String(r[11]).trim() : '';
    const role = r[12] ? String(r[12]).trim() : '';
    if (desig) { c.byDesig[desig] = (c.byDesig[desig] || 0) + 1; const t = seniorityTier(desig); c.bySeniority[t] = (c.bySeniority[t] || 0) + 1; }
    if (role) c.byRole[role] = (c.byRole[role] || 0) + 1;
    const d = safeDate(r[0]);
    if (d) { if (!c.firstJoin || d < c.firstJoin) c.firstJoin = d; if (!c.lastJoin || d > c.lastJoin) c.lastJoin = d; }
  });

  dropRows.slice(1).forEach((r) => {
    if (!r || !r[0] || !r[6]) return;
    const c = ensure(r[6]);
    c.drops += 1;
    if (!c.industry && r[9]) c.industry = String(r[9]).trim();
    if (!c.hq && r[7]) c.hq = String(r[7]).trim();
  });

  // --- engagement (model + dates) ---
  const engagement = {}; // norm name -> {model, first, last, end}
  engRows.slice(1).forEach((r) => {
    if (!r || !r[0]) return;
    engagement[norm(r[0])] = {
      model: r[1] ? String(r[1]).trim() : '',
      first: safeDate(r[2]) || '', last: safeDate(r[3]) || '', end: safeDate(r[4]) || '',
    };
  });
  Object.values(companies).forEach((c) => {
    const e = engagement[norm(c.name)];
    if (e) c.engagement = e;
  });

  // --- industry rollups ---
  const industries = {}; // display value -> rollup
  Object.values(companies).forEach((c) => {
    const ind = c.industry || 'Unknown';
    if (!industries[ind]) industries[ind] = { name: ind, companies: 0, joinees: 0, drops: 0, revenue: 0, bySeniority: {}, topCompanies: [] };
    const I = industries[ind];
    I.companies += 1; I.joinees += c.joinees; I.drops += c.drops; I.revenue += c.revenue;
    for (const [t, n] of Object.entries(c.bySeniority)) I.bySeniority[t] = (I.bySeniority[t] || 0) + n;
  });
  Object.values(industries).forEach((I) => {
    I.topCompanies = Object.values(companies)
      .filter((c) => (c.industry || 'Unknown') === I.name)
      .sort((a, b) => b.joinees - a.joinees)
      .slice(0, 25)
      .map((c) => ({ name: c.name, joinees: c.joinees, drops: c.drops, revenue: c.revenue }));
  });

  // --- totals ---
  const totals = {
    companies: Object.keys(companies).length,
    joinees: Object.values(companies).reduce((s, c) => s + c.joinees, 0),
    drops: Object.values(companies).reduce((s, c) => s + c.drops, 0),
    revenue: Object.values(companies).reduce((s, c) => s + c.revenue, 0),
  };

  // --- Clients Worked With (touched, not necessarily closed) per industry ---
  const clientsWorked = {}; // display industry name -> [{subsector, companies:[...]}]
  industryRows.forEach((rows, i) => {
    if (!rows || rows.length < 2) return;
    const header = rows[0];
    const subs = [];
    for (let ci = 2; ci < header.length - 1; ci++) {
      const val = header[ci], next = header[ci + 1];
      if (val && !String(val).includes('Requisition') && next && String(next).includes('Requisition')) subs.push({ ci, name: String(val).trim() });
    }
    const out = [];
    subs.forEach(({ ci, name }) => {
      const set = new Set();
      for (let r = 2; r < rows.length; r++) {
        const comp = rows[r] && rows[r][ci] ? String(rows[r][ci]).trim() : '';
        if (comp) set.add(comp);
      }
      if (set.size) out.push({ subsector: name, companies: [...set] });
    });
    if (out.length) clientsWorked[INDUSTRY_SHEETS[i]] = out;
  });

  // --- curated KB tabs -> arrays of row objects ---
  function rowsToObjects(rows) {
    if (!rows || rows.length < 2) return [];
    const headers = rows[0].map((h) => String(h || '').trim());
    return rows.slice(1)
      .filter((r) => r && r.some((c) => String(c || '').trim() !== ''))
      .map((r) => { const o = {}; headers.forEach((h, i) => { o[h] = r[i] != null ? String(r[i]).trim() : ''; }); return o; });
  }
  const kb = {};
  KB_TABS.forEach((t, i) => { kb[t.toLowerCase()] = rowsToObjects(kbRows[i]); });

  return { at: Date.now(), totals, companies, industries, clientsWorked, engagement, kb };
}

async function getPack(force = false) {
  if (!force && _cache && (Date.now() - _cache.at) < CACHE_TTL_MS) return _cache.pack;
  const pack = await buildPack();
  _cache = { at: Date.now(), pack };
  return pack;
}

// ── formatting helpers for context ────────────────────────────────────────────
function fmtRs(n) {
  if (!n) return '0';
  if (n >= 1e7) return '₹' + (n / 1e7).toFixed(2) + 'Cr';
  if (n >= 1e5) return '₹' + (n / 1e5).toFixed(2) + 'L';
  return '₹' + Math.round(n).toLocaleString('en-IN');
}
function topEntries(obj, n) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
}

// ── scope + context assembly ──────────────────────────────────────────────────
// Derive which companies / industries the conversation is about, from ALL user text.
function deriveScope(userText, pack) {
  const t = ' ' + norm(userText) + ' ';
  const matchedCompanies = [];
  for (const c of Object.values(pack.companies)) {
    const nk = norm(c.name);
    if (nk.length >= 3 && t.includes(nk)) matchedCompanies.push(c);
  }
  // industries: match by name token
  const matchedIndustries = new Set();
  for (const I of Object.values(pack.industries)) {
    const ik = norm(I.name);
    if (ik && ik !== 'unknown' && t.includes(ik)) matchedIndustries.add(I.name);
  }
  matchedCompanies.forEach((c) => { if (c.industry) matchedIndustries.add(c.industry); });
  // adjacency widen
  const widened = new Set(matchedIndustries);
  matchedIndustries.forEach((ind) => adjacentTo(norm(ind)).forEach((a) => {
    for (const I of Object.values(pack.industries)) if (norm(I.name).includes(a)) widened.add(I.name);
  }));
  // dedupe companies, cap
  const seen = new Set();
  const comps = matchedCompanies.filter((c) => { const k = norm(c.name); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 8);
  return { companies: comps, industries: [...matchedIndustries], widenedIndustries: [...widened] };
}

function companyBlock(c) {
  const lines = [];
  lines.push(`### ${c.name}`);
  lines.push(`Industry: ${c.industry || 'Unknown'} | HQ: ${c.hq || 'Unknown'} | Joinees(closures): ${c.joinees} | Offer drops: ${c.drops} | Revenue: ${fmtRs(c.revenue)}`);
  if (c.firstJoin || c.lastJoin) lines.push(`Activity window: ${c.firstJoin || '?'} to ${c.lastJoin || '?'}`);
  if (c.engagement && c.engagement.model) lines.push(`Engagement model: ${c.engagement.model}`);
  const desigs = topEntries(c.byDesig, 10);
  if (desigs.length) lines.push('Top designations (exact counts): ' + desigs.map(([d, n]) => `${d} (${n})`).join('; '));
  const roles = topEntries(c.byRole, 8);
  if (roles.length) lines.push('Top functions/roles (exact counts): ' + roles.map(([d, n]) => `${d} (${n})`).join('; '));
  const sen = topEntries(c.bySeniority, 6);
  if (sen.length) lines.push('By seniority (heuristic, approximate): ' + sen.map(([d, n]) => `${d} (${n})`).join('; '));
  return lines.join('\n');
}

function industryBlock(I) {
  const lines = [];
  lines.push(`### Industry: ${I.name}`);
  lines.push(`Companies: ${I.companies} | Joinees: ${I.joinees} | Drops: ${I.drops} | Revenue: ${fmtRs(I.revenue)}`);
  const sen = topEntries(I.bySeniority, 6);
  if (sen.length) lines.push('By seniority (heuristic): ' + sen.map(([d, n]) => `${d} (${n})`).join('; '));
  if (I.topCompanies.length) lines.push('Top companies (by closures): ' + I.topCompanies.slice(0, 15).map((c) => `${c.name} (${c.joinees} joinees, ${fmtRs(c.revenue)})`).join('; '));
  return lines.join('\n');
}

function matchIndustryLoose(rowIndustry, scopeIndustries) {
  const ri = norm(rowIndustry);
  if (!ri) return false;
  return scopeIndustries.some((s) => { const sk = norm(s); return sk.includes(ri) || ri.includes(sk); });
}

function assembleContext(userText, pack) {
  const scope = deriveScope(userText, pack);
  const parts = [];

  // 1) Totals (always)
  parts.push('## FIRM-WIDE TOTALS (exact)\n' + `Companies: ${pack.totals.companies} | Joinees: ${pack.totals.joinees} | Offer drops: ${pack.totals.drops} | Revenue: ${fmtRs(pack.totals.revenue)}`);

  // 2) Scoped companies (exact numbers)
  if (scope.companies.length) {
    parts.push('## MATCHED COMPANIES (exact numbers - use these, never invent)\n' + scope.companies.map(companyBlock).join('\n\n'));
  }

  // 3) Scoped industries
  if (scope.industries.length) {
    const blocks = scope.industries.map((n) => pack.industries[n]).filter(Boolean).map(industryBlock);
    if (blocks.length) parts.push('## MATCHED INDUSTRIES (exact numbers)\n' + blocks.join('\n\n'));
  }
  // If nothing matched, give a compact industry summary so general questions still work
  if (!scope.companies.length && !scope.industries.length) {
    const rows = Object.values(pack.industries).sort((a, b) => b.revenue - a.revenue)
      .map((I) => `${I.name}: ${I.companies} cos, ${I.joinees} joinees, ${I.drops} drops, ${fmtRs(I.revenue)}`);
    parts.push('## INDUSTRY SUMMARY (exact)\n' + rows.join('\n'));
  }

  // 4) Clients Worked With — only for scoped industries (touched, not necessarily closed)
  const cwIndustries = scope.industries.length ? scope.industries : [];
  const cwBlocks = [];
  for (const [sheetName, subs] of Object.entries(pack.clientsWorked)) {
    if (cwIndustries.length && !matchIndustryLoose(sheetName, cwIndustries)) continue;
    if (!cwIndustries.length) continue; // don't dump all 1,687 for general questions
    cwBlocks.push(`### ${sheetName}\n` + subs.map((s) => `${s.subsector}: ${s.companies.slice(0, 40).join(', ')}`).join('\n'));
  }
  if (cwBlocks.length) parts.push('## CLIENTS WORKED WITH (touched, not necessarily closed)\n' + cwBlocks.join('\n\n'));

  // 5) Case studies / methods (Sources) — bd_usage index always; full rows for scoped clients/industries + widened
  const src = pack.kb.sources || [];
  const usageIndex = src.map((s) => `${s.source_id} [${s.type}] ${s.client || s.industry || 'general'}: ${s.bd_usage}`).join('\n');
  parts.push('## STORY INDEX (pick the story whose PROBLEM mirrors the prospect)\n' + usageIndex);
  const scopedClientsNorm = new Set(scope.companies.map((c) => norm(c.name)));
  const fullSources = src.filter((s) => {
    if (s.client && scopedClientsNorm.has(norm(s.client))) return true;
    if (s.industry && matchIndustryLoose(s.industry, scope.widenedIndustries)) return true;
    if (!s.client && !s.industry) return true; // general methods
    return false;
  });
  if (fullSources.length) {
    parts.push('## RELEVANT STORIES (full)\n' + fullSources.map((s) =>
      `### ${s.source_id} - ${s.client || s.industry || 'general'} [${s.type}]\n` +
      `Problem: ${s.problem}\nIntervention: ${s.intervention}\n` +
      (s.result_client_safe ? `SAY THIS (client-safe): ${s.result_client_safe}\n` : '') +
      (s.result_internal ? `INTERNAL ONLY (do not say to a client): ${s.result_internal}\n` : '') +
      `When to use: ${s.bd_usage}`
    ).join('\n\n'));
  }

  // 6) Doctrine — always-on general rows + scoped internal rows
  const doc = pack.kb.doctrine || [];
  const alwaysCats = new Set(['definition', 'icp_firmographic', 'excluded_industry', 'sweet_spot', 'service_term', 'service_line', 'service_fit', 'peepal_way', 'company', 'commercials']);
  const docAlways = doc.filter((d) => alwaysCats.has(d.category));
  const docScoped = doc.filter((d) => !alwaysCats.has(d.category) && (
    (d.examples && scope.companies.some((c) => norm(d.examples).includes(norm(c.name)))) ||
    matchIndustryLoose(d.industry || '', scope.widenedIndustries) ||
    ['stage', 'converting', 'not_converting', 'sub_icp', 'contact', 'timing'].includes(d.category)
  ));
  const docLine = (d) => `- [${d.category}] ${d.item}${d.detail ? ': ' + d.detail : ''}${d.examples ? ' | e.g. ' + d.examples : ''}${d.action ? ' | ACTION: ' + d.action : ''}${d.audience === 'internal' ? ' | (INTERNAL ONLY)' : ''}`;
  const docRows = [...docAlways, ...docScoped];
  if (docRows.length) parts.push('## DOCTRINE (ICP, targeting, services, commercials, PEEPAL Way)\n' + docRows.map(docLine).join('\n'));

  // 7) Playbook — the always-useful how-to-sell chapters
  const pb = pack.kb.playbook || [];
  const pbCats = new Set(['mindset', 'first_call', 'discovery', 'data_usage', 'meeting_run', 'followup', 'reliability', 'reactivation', 'at_risk', 'delivery', 'research']);
  const pbRows = pb.filter((p) => pbCats.has(p.category));
  if (pbRows.length) parts.push('## PLAYBOOK (how to sell)\n' + pbRows.map((p) => `- [${p.category}] ${p.item}${p.detail ? ': ' + p.detail : ''}${p.action ? ' | ' + p.action : ''}`).join('\n'));

  return { context: parts.join('\n\n'), scope };
}

module.exports = { getPack, assembleContext, fmtRs };
