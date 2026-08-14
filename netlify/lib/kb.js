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
function toWords(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
// Word-boundary phrase matcher so "Xperi" doesn't match "experience" and "EY GDS" matches "ey gds".
function phraseRegex(name) {
  const toks = toWords(name).split(' ').filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!toks.length || toks.join('').length < 3) return null;
  return new RegExp('\\b' + toks.join('[^a-z0-9]+') + '\\b', 'i');
}
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

// YOE-based experience bands (more reliable than designation heuristic)
const EXP_BAND_ORDER = ['Junior (0-4 yrs)', 'Mid (4-8 yrs)', 'Senior (8-12 yrs)', 'Very Senior (12-15 yrs)', 'Leadership (15+ yrs)'];
function expBand(yoe) {
  if (yoe < 4) return 'Junior (0-4 yrs)';
  if (yoe < 8) return 'Mid (4-8 yrs)';
  if (yoe < 12) return 'Senior (8-12 yrs)';
  if (yoe < 15) return 'Very Senior (12-15 yrs)';
  return 'Leadership (15+ yrs)';
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
        byDesig: {}, byRole: {}, bySeniority: {}, skillIndex: {},
        exp: { sum: 0, count: 0, min: null, max: null }, expByCombo: {}, byExpBand: {}, bandByCombo: {},
        byLocation: {}, byPrev: {},
        firstJoin: null, lastJoin: null,
      };
    }
    return companies[k];
  }

  const byFY = {}; // financial-year rollup: fy -> {joinees, drops, revenue}
  const isFY = (v) => /^\d{4}-\d{4}$/.test(String(v || '').trim());

  joineeRows.slice(1).forEach((r) => {
    if (!r || !r[0] || !r[6]) return;
    const c = ensure(r[6]);
    c.joinees += 1;
    c.revenue += safeFloat(r[9]);
    if (isFY(r[4])) { const fy = String(r[4]).trim(); (byFY[fy] = byFY[fy] || { joinees: 0, drops: 0, revenue: 0 }); byFY[fy].joinees++; byFY[fy].revenue += safeFloat(r[9]); }
    if (!c.industry && r[8]) c.industry = String(r[8]).trim();
    if (!c.hq && r[7]) c.hq = String(r[7]).trim();
    const desig = r[11] ? String(r[11]).trim() : '';
    const role = r[12] ? String(r[12]).trim() : '';
    if (desig) { c.byDesig[desig] = (c.byDesig[desig] || 0) + 1; const t = seniorityTier(desig); c.bySeniority[t] = (c.bySeniority[t] || 0) + 1; }
    if (role) c.byRole[role] = (c.byRole[role] || 0) + 1;
    // exact skill/role index: one entry per joinee (designation + function combined), no double count
    const combo = ((desig || '') + ' ' + (role || '')).toLowerCase().replace(/\s+/g, ' ').trim();
    if (combo) c.skillIndex[combo] = (c.skillIndex[combo] || 0) + 1;
    // years of experience (col 13) — per company and per skill-combo
    const yoe = parseFloat(r[13]);
    if (!isNaN(yoe) && yoe >= 0 && yoe < 60) {
      c.exp.sum += yoe; c.exp.count += 1;
      c.exp.min = c.exp.min === null ? yoe : Math.min(c.exp.min, yoe);
      c.exp.max = c.exp.max === null ? yoe : Math.max(c.exp.max, yoe);
      const band = expBand(yoe);
      c.byExpBand[band] = (c.byExpBand[band] || 0) + 1;
      if (combo) {
        const e = (c.expByCombo[combo] = c.expByCombo[combo] || { sum: 0, count: 0, min: null, max: null });
        e.sum += yoe; e.count += 1;
        e.min = e.min === null ? yoe : Math.min(e.min, yoe);
        e.max = e.max === null ? yoe : Math.max(e.max, yoe);
        c.bandByCombo[combo] = c.bandByCombo[combo] || {};
        c.bandByCombo[combo][band] = (c.bandByCombo[combo][band] || 0) + 1;
      }
    }
    const loc = r[14] ? String(r[14]).trim() : '';
    if (loc) c.byLocation[loc] = (c.byLocation[loc] || 0) + 1;
    const prev = r[15] ? String(r[15]).trim() : '';
    if (prev) c.byPrev[prev] = (c.byPrev[prev] || 0) + 1;
    const d = safeDate(r[0]);
    if (d) { if (!c.firstJoin || d < c.firstJoin) c.firstJoin = d; if (!c.lastJoin || d > c.lastJoin) c.lastJoin = d; }
  });

  dropRows.slice(1).forEach((r) => {
    if (!r || !r[0] || !r[6]) return;
    const c = ensure(r[6]);
    c.drops += 1;
    if (!c.industry && r[9]) c.industry = String(r[9]).trim();
    if (!c.hq && r[7]) c.hq = String(r[7]).trim();
    if (isFY(r[4])) { const fy = String(r[4]).trim(); (byFY[fy] = byFY[fy] || { joinees: 0, drops: 0, revenue: 0 }); byFY[fy].drops++; }
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
    if (!industries[ind]) industries[ind] = { name: ind, companies: 0, joinees: 0, drops: 0, revenue: 0, bySeniority: {}, byExpBand: {}, topCompanies: [] };
    const I = industries[ind];
    I.companies += 1; I.joinees += c.joinees; I.drops += c.drops; I.revenue += c.revenue;
    for (const [t, n] of Object.entries(c.bySeniority)) I.bySeniority[t] = (I.bySeniority[t] || 0) + n;
    for (const [b, n] of Object.entries(c.byExpBand)) I.byExpBand[b] = (I.byExpBand[b] || 0) + n;
  });
  Object.values(industries).forEach((I) => {
    I.topCompanies = Object.values(companies)
      .filter((c) => (c.industry || 'Unknown') === I.name)
      .sort((a, b) => b.joinees - a.joinees)
      .slice(0, 25)
      .map((c) => ({ name: c.name, joinees: c.joinees, drops: c.drops, revenue: c.revenue }));
  });

  // --- HQ rollup (from company-level HQ) ---
  const byHQ = {};
  Object.values(companies).forEach((c) => {
    const hq = c.hq || 'Unknown';
    if (!byHQ[hq]) byHQ[hq] = { hq, companies: 0, joinees: 0, drops: 0, revenue: 0 };
    const H = byHQ[hq]; H.companies++; H.joinees += c.joinees; H.drops += c.drops; H.revenue += c.revenue;
  });

  // --- engagement model -> clients ---
  const byModel = {};
  Object.entries(engagement).forEach(([nk, e]) => {
    if (!e.model) return;
    const comp = Object.values(companies).find((c) => norm(c.name) === nk);
    (byModel[e.model] = byModel[e.model] || []).push(comp ? comp.name : nk);
  });

  // --- joining-location rollup (col 14, where candidates joined) ---
  const byLocation = {};
  Object.values(companies).forEach((c) => {
    for (const [loc, n] of Object.entries(c.byLocation)) {
      const L = (byLocation[loc] = byLocation[loc] || { location: loc, joinees: 0, companies: 0 });
      L.joinees += n; L.companies += 1;
    }
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
      const companies = new Set();
      const capabilities = new Set(); // requisition roles we can fill (col ci+1)
      for (let r = 2; r < rows.length; r++) {
        const comp = rows[r] && rows[r][ci] ? String(rows[r][ci]).trim() : '';
        const cap = rows[r] && rows[r][ci + 1] ? String(rows[r][ci + 1]).trim() : '';
        if (comp) companies.add(comp);
        if (cap && !cap.toLowerCase().includes('requisition')) capabilities.add(cap);
      }
      if (companies.size || capabilities.size) out.push({ subsector: name, companies: [...companies], capabilities: [...capabilities] });
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

  return { at: Date.now(), totals, companies, industries, byHQ, byFY, byModel, byLocation, clientsWorked, engagement, kb };
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

// ── skill / role search across joinee designations + functions (exact) ────────
const STOPWORDS = new Set([
  'what', 'have', 'has', 'had', 'we', 'our', 'us', 'the', 'and', 'or', 'for', 'with', 'from',
  'are', 'is', 'do', 'does', 'did', 'how', 'many', 'much', 'who', 'can', 'you', 'they', 'them',
  'their', 'been', 'closed', 'closure', 'closures', 'close', 'joinee', 'joinees', 'joined',
  'hire', 'hires', 'hiring', 'hired', 'role', 'roles', 'client', 'clients', 'company', 'companies',
  'industry', 'industries', 'revenue', 'offer', 'offers', 'drop', 'drops', 'about', 'around',
  'give', 'show', 'list', 'tell', 'say', 'this', 'that', 'these', 'those', 'get', 'got', 'any',
  'all', 'some', 'more', 'most', 'versus', 'done', 'work', 'worked', 'placed', 'placements',
  'candidates', 'people', 'name', 'names', 'which', 'where', 'when', 'seniority', 'senior', 'junior',
  'model', 'models', 'track', 'record', 'numbers', 'experience', 'clients',
  'should', 'would', 'could', 'approach', 'new', 'give', 'given', 'need', 'needs', 'want', 'help', 'helps',
  'info', 'pattern', 'patterns', 'level', 'levels', 'further', 'across', 'company', 'tell', 'range', 'ranges',
  'let', 'know', 'about', 'like', 'good', 'best', 'closed', 'close',
]);
function tokenize(t) {
  return [...new Set(String(t || '').toLowerCase().split(/[^a-z0-9+#]+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w)))];
}
function skillSearch(term, pack) {
  const re = new RegExp('\\b' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
  let total = 0; const perCo = {}; const byInd = {}; const bands = {};
  let expSum = 0, expCount = 0, expMin = null, expMax = null;
  for (const c of Object.values(pack.companies)) {
    let n = 0;
    for (const [combo, cnt] of Object.entries(c.skillIndex)) {
      if (!re.test(combo)) continue;
      n += cnt;
      const e = c.expByCombo[combo];
      if (e && e.count) { expSum += e.sum; expCount += e.count; expMin = expMin === null ? e.min : Math.min(expMin, e.min); expMax = expMax === null ? e.max : Math.max(expMax, e.max); }
      if (c.bandByCombo && c.bandByCombo[combo]) { for (const [b, bn] of Object.entries(c.bandByCombo[combo])) bands[b] = (bands[b] || 0) + bn; }
    }
    if (n > 0) { perCo[c.name] = n; total += n; const ind = c.industry || 'Unknown'; byInd[ind] = (byInd[ind] || 0) + n; }
  }
  const yoe = expCount ? { avg: (expSum / expCount).toFixed(1), min: expMin, max: expMax, n: expCount } : null;
  return { term, total, top: Object.entries(perCo).sort((a, b) => b[1] - a[1]).slice(0, 15), byInd, yoe, bands };
}

// ── scope + context assembly ──────────────────────────────────────────────────
// Derive which companies / industries the conversation is about, from ALL user text.
// Company names that are also everyday BD verbs/words — skip auto-matching them as clients
// (e.g. "who should I target" must not match the retailer "Target").
const COMPANY_MATCH_SKIP = new Set(['target', 'meeting', 'call', 'help', 'lead', 'scale', 'pilot']);

function deriveScope(userText, pack) {
  const lowerText = ' ' + toWords(userText) + ' ';
  const matchedCompanies = [];
  for (const c of Object.values(pack.companies)) {
    if (COMPANY_MATCH_SKIP.has(norm(c.name))) continue;
    const re = phraseRegex(c.name);
    if (re && re.test(lowerText)) matchedCompanies.push(c);
  }
  // industries: word-boundary match on the industry name (skip junk/placeholder values)
  const JUNK_INDUSTRIES = new Set(['unknown', 'check', 'test', 'tbd', 'na', 'n/a', '-', '']);
  // DIRECT: the industry name literally appears in the query.
  const directIndustries = new Set();
  for (const I of Object.values(pack.industries)) {
    if (!I.name || JUNK_INDUSTRIES.has(I.name.toLowerCase().trim())) continue;
    const re = phraseRegex(I.name);
    if (re && re.test(lowerText)) directIndustries.add(I.name);
  }
  // ADJACENT: a sub-vertical word (fintech, solar) maps to a PARENT/related industry we track.
  const INDUSTRY_SYNONYMS = [
    ['tech', 'it'], ['technology', 'it'], ['software', 'it'], ['saas', 'it'],
    ['banking', 'bfsi'], ['bank', 'bfsi'], ['finance', 'bfsi'], ['financial', 'bfsi'], ['fintech', 'bfsi'], ['insurance', 'bfsi'],
    ['airline', 'aviation'], ['airlines', 'aviation'], ['aerospace', 'aviation'],
    ['telecom', 'telecom'], ['telco', 'telecom'],
    ['pharma', 'pharma'], ['pharmaceutical', 'pharma'], ['healthcare', 'pharma'],
    ['manufacturing', 'manufactur'], ['engineering', 'manufactur'],
    ['retail', 'fmcg'], ['fmcg', 'fmcg'], ['consumer', 'fmcg'],
    ['media', 'media'], ['entertainment', 'media'],
    ['consulting', 'consulting'], ['advisory', 'consulting'],
    ['solar', 'manufactur'], ['renewable', 'manufactur'], ['cleantech', 'manufactur'], ['clean energy', 'manufactur'],
    ['energy', 'manufactur'], ['battery', 'manufactur'], ['ev', 'manufactur'], ['electric vehicle', 'manufactur'],
    ['automotive', 'manufactur'], ['auto', 'manufactur'], ['industrial', 'manufactur'], ['electronics', 'it'], ['hardware', 'it'],
    ['semiconductor', 'manufactur'], ['semiconductors', 'manufactur'], ['chip', 'manufactur'], ['chips', 'manufactur'], ['medtech', 'manufactur'], ['medical device', 'manufactur'],
  ];
  const adjacentIndustries = new Set();
  const adjacencyNotes = []; // { term, industries } — the query mentioned a space we don't directly track
  for (const [kw, indSub] of INDUSTRY_SYNONYMS) {
    if (!new RegExp('\\b' + kw + '\\b', 'i').test(lowerText)) continue;
    const hit = [];
    for (const I of Object.values(pack.industries)) {
      if (I.name && !JUNK_INDUSTRIES.has(I.name.toLowerCase().trim()) && norm(I.name).includes(indSub) && !directIndustries.has(I.name)) {
        adjacentIndustries.add(I.name); if (!hit.includes(I.name)) hit.push(I.name);
      }
    }
    // only note as adjacency if the query term isn't itself a direct industry name
    if (hit.length && !directIndustries.has(kw)) adjacencyNotes.push({ term: kw, industries: hit });
  }
  // a matched company is DIRECT evidence; its whole industry is only adjacent context
  matchedCompanies.forEach((c) => { if (c.industry && !directIndustries.has(c.industry)) adjacentIndustries.add(c.industry); });

  const matchedIndustries = new Set([...directIndustries, ...adjacentIndustries]);
  const namedIndustries = [...directIndustries]; // for the tag: only truly-named industries
  // adjacency widen
  const widened = new Set(matchedIndustries);
  matchedIndustries.forEach((ind) => adjacentTo(norm(ind)).forEach((a) => {
    for (const I of Object.values(pack.industries)) if (norm(I.name).includes(a)) widened.add(I.name);
  }));
  // dedupe companies, cap
  const seen = new Set();
  const comps = matchedCompanies.filter((c) => { const k = norm(c.name); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 8);

  // skill / role / skill-stack matches (e.g. "java", "guidewire", "sap", "cyber")
  const compNorm = norm(comps.map((c) => c.name).join(' '));
  // compound/synonym expansion so one-word queries hit the multi-word skill index
  const SKILL_SYN = {
    cybersecurity: ['security', 'cyber'], infosec: ['security', 'cyber'], cyber: ['security'],
    fullstack: ['full stack'], devops: ['devops'], mlops: ['mlops'], genai: ['gen ai', 'genai'],
    ml: ['machine learning'], ai: ['ai', 'genai'], qa: ['quality', 'test'], sdet: ['sdet', 'test'],
    frontend: ['front end'], backend: ['back end'], dataengineering: ['data engineer'],
  };
  const skillTokens = new Set(tokenize(userText));
  for (const t of [...skillTokens]) if (SKILL_SYN[t]) SKILL_SYN[t].forEach((s) => skillTokens.add(s));
  const skills = [];
  const seenTerms = new Set();
  for (const tok of skillTokens) {
    if (compNorm.includes(tok) || seenTerms.has(tok)) continue; // already covered
    const s = skillSearch(tok, pack);
    if (s.total >= 2) { skills.push(s); seenTerms.add(tok); }
  }
  skills.sort((a, b) => b.total - a.total);

  // HQ / geography (allow 2-char codes like UK, but deny pronoun collisions)
  const hqs = [];
  for (const hq of Object.keys(pack.byHQ || {})) {
    if (hq === 'Unknown') continue;
    const toks = toWords(hq).split(' ').filter(Boolean);
    const joined = toks.join('');
    if (joined.length < 2 || ['us', 'we', 'it', 'in', 'on', 'the'].includes(joined)) continue;
    const re = new RegExp('\\b' + toks.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^a-z0-9]+') + '\\b', 'i');
    if (re.test(lowerText)) hqs.push(hq);
  }
  // engagement models
  const models = [];
  for (const m of Object.keys(pack.byModel || {})) {
    const re = phraseRegex(m);
    if (re && re.test(lowerText)) models.push(m);
  }
  // financial years (explicit YYYY-YYYY tokens)
  const fyToks = userText.match(/\b\d{4}-\d{4}\b/g) || [];
  const fys = Object.keys(pack.byFY || {}).filter((fy) => fyToks.includes(fy));

  // joining locations (India cities, col 14)
  const locations = [];
  for (const loc of Object.keys(pack.byLocation || {})) {
    const toks = toWords(loc).split(' ').filter(Boolean);
    if (toks.join('').length < 3) continue;
    const re = new RegExp('\\b' + toks.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^a-z0-9]+') + '\\b', 'i');
    if (re.test(lowerText)) locations.push(loc);
  }

  // Seniority / experience level detection (synonyms for each tier)
  const SENIORITY_KW = [
    [/\b(junior|entry.?level|fresher|early.?career)\b/i, 'junior'],
    [/\b(mid.?level|mid.?career|intermediate)\b/i, 'mid'],
    [/\bvery.?senior\b/i, 'very_senior'],
    [/\b(senior)\b/i, 'senior'],
    [/\b(leadership|executive|c.?suite|director.?level|vp.?level)\b/i, 'leadership'],
  ];
  let seniorityFilter = null;
  for (const [re, level] of SENIORITY_KW) {
    if (re.test(userText)) { seniorityFilter = level; break; }
  }

  return { companies: comps, industries: [...matchedIndustries], directIndustries: [...directIndustries], adjacentIndustries: [...adjacentIndustries], adjacencyNotes, namedIndustries, widenedIndustries: [...widened], skills: skills.slice(0, 3), hqs, models, fys, locations, seniorityFilter };
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
  const expBands = EXP_BAND_ORDER.map(b => [b, c.byExpBand[b] || 0]).filter(([, n]) => n > 0);
  if (expBands.length) {
    lines.push('By experience band: ' + expBands.map(([b, n]) => `${b}: ${n}`).join('; '));
    const seniorPlus = (c.byExpBand['Senior (8-12 yrs)'] || 0) + (c.byExpBand['Very Senior (12-15 yrs)'] || 0) + (c.byExpBand['Leadership (15+ yrs)'] || 0);
    if (seniorPlus > 0) lines.push(`Senior+ (8+ yrs experience): ${seniorPlus} joinees`);
  }
  if (c.exp && c.exp.count) lines.push(`Years of experience closed: avg ${(c.exp.sum / c.exp.count).toFixed(1)} yrs, range ${c.exp.min}-${c.exp.max} yrs (across ${c.exp.count} with data)`);
  const locs = topEntries(c.byLocation, 6);
  if (locs.length) lines.push('Joining locations (where they joined): ' + locs.map(([l, n]) => `${l} (${n})`).join('; '));
  const prevs = topEntries(c.byPrev, 6);
  if (prevs.length) lines.push('Sourced from (previous companies): ' + prevs.map(([p, n]) => `${p} (${n})`).join('; '));
  return lines.join('\n');
}

function industryBlock(I) {
  const lines = [];
  lines.push(`### Industry: ${I.name}`);
  lines.push(`Companies: ${I.companies} | Joinees: ${I.joinees} | Drops: ${I.drops} | Revenue: ${fmtRs(I.revenue)}`);
  const expBands = EXP_BAND_ORDER.map(b => [b, I.byExpBand[b] || 0]).filter(([, n]) => n > 0);
  if (expBands.length) {
    lines.push('By experience band: ' + expBands.map(([b, n]) => `${b}: ${n}`).join('; '));
    const seniorPlus = (I.byExpBand['Senior (8-12 yrs)'] || 0) + (I.byExpBand['Very Senior (12-15 yrs)'] || 0) + (I.byExpBand['Leadership (15+ yrs)'] || 0);
    if (seniorPlus > 0) lines.push(`Senior+ (8+ yrs experience): ${seniorPlus} joinees`);
  }
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
  const parts = [];        // CLIENT-SAFE bin — usable in SAY (spoken to the client) and READ
  const internalParts = []; // INTERNAL-ONLY bin — READ only, never sent to the SAY call

  // 1) Totals (always) + compact by-financial-year (cheap, enables trend/year questions)
  parts.push('## FIRM-WIDE TOTALS (exact)\n' + `Companies: ${pack.totals.companies} | Joinees: ${pack.totals.joinees} | Offer drops: ${pack.totals.drops} | Revenue: ${fmtRs(pack.totals.revenue)}`);
  const fyAll = Object.keys(pack.byFY || {}).sort();
  if (fyAll.length) {
    parts.push('## BY FINANCIAL YEAR (exact, all years)\n' + fyAll.map((fy) => { const F = pack.byFY[fy]; return `${fy}: ${F.joinees} joinees, ${F.drops} drops, ${fmtRs(F.revenue)}`; }).join('\n'));
  }

  // EVIDENCE DIRECTNESS — tells the model what's DIRECT vs ADJACENT vs ABSENT for this query
  {
    const direct = [];
    if (scope.companies && scope.companies.length) direct.push('named client(s): ' + scope.companies.map((c) => c.name).join(', '));
    if (scope.directIndustries && scope.directIndustries.length) direct.push('industry named directly: ' + scope.directIndustries.join(', '));
    const roleEv = (scope.skills || []).map((s) => `${s.term} (${s.total})`);
    const adjLines = (scope.adjacencyNotes || []).map((n) => `"${n.term}" is NOT a space we directly track — the closest is ${n.industries.join('/')} (parent/adjacent). Treat any ${n.industries.join('/')} evidence as ADJACENT to "${n.term}", never as direct ${n.term} proof.`);
    const bits = [];
    if (direct.length) bits.push('DIRECT evidence present: ' + direct.join('; ') + '.');
    if (roleEv.length) bits.push('ROLE/SKILL evidence: ' + roleEv.join(', ') + ' — these are role-level counts across ALL industries, NOT proof of any specific industry.');
    if (adjLines.length) bits.push('ADJACENT: ' + adjLines.join(' '));
    if (!direct.length && !roleEv.length && !adjLines.length) bits.push('Nothing specific matched this query — you likely have NO direct evidence. Say so honestly rather than stretching unrelated data.');
    if (scope.seniorityFilter) {
      const tierLabel = { junior: 'Junior (0-4 yrs)', mid: 'Mid (4-8 yrs)', senior: 'Senior (8-12 yrs)', very_senior: 'Very Senior (12-15 yrs)', leadership: 'Leadership (15+ yrs)' };
      const senNote = scope.seniorityFilter === 'senior' ? 'Use the "Senior+ (8+ yrs)" pre-computed totals and the Senior/Very Senior/Leadership band counts below.' :
        scope.seniorityFilter === 'very_senior' ? 'Use the Very Senior (12-15 yrs) and Leadership (15+ yrs) band counts below.' :
        `Use the "${tierLabel[scope.seniorityFilter]}" band counts below.`;
      bits.push(`SENIORITY: The query asks about ${tierLabel[scope.seniorityFilter]}-level placements. Experience bands: Junior 0-4 yrs, Mid 4-8 yrs, Senior 8-12 yrs, Very Senior 12-15 yrs, Leadership 15+ yrs. ${senNote}`);
    }
    parts.push('## EVIDENCE DIRECTNESS (read FIRST — classify before you claim; never present adjacent/role evidence as direct)\n' + bits.join('\n'));
  }

  // 2) Scoped companies (exact numbers)
  if (scope.companies.length) {
    parts.push('## MATCHED COMPANIES (exact numbers - use these, never invent)\n' + scope.companies.map(companyBlock).join('\n\n'));
  }

  // 3) Scoped industries
  if (scope.industries.length) {
    const blocks = scope.industries.map((n) => pack.industries[n]).filter(Boolean).map(industryBlock);
    if (blocks.length) parts.push('## MATCHED INDUSTRIES (exact numbers)\n' + blocks.join('\n\n'));
  }
  // 3b) Skill / role / stack matches (exact search of designations + functions)
  if (scope.skills && scope.skills.length) {
    const blocks = scope.skills.map((s) => {
      const top = s.top.map(([name, n]) => `${name} (${n})`).join('; ');
      const inds = Object.entries(s.byInd).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([i, n]) => `${i} (${n})`).join('; ');
      const yoeLine = s.yoe ? `\nYears of experience: avg ${s.yoe.avg} yrs, range ${s.yoe.min}-${s.yoe.max} yrs (across ${s.yoe.n} with data)` : '';
      const bandLine = s.bands && Object.keys(s.bands).length ? '\nBy experience band: ' + EXP_BAND_ORDER.map(b => [b, s.bands[b] || 0]).filter(([, n]) => n > 0).map(([b, n]) => `${b}: ${n}`).join('; ') : '';
      const senPlus = s.bands ? (s.bands['Senior (8-12 yrs)'] || 0) + (s.bands['Very Senior (12-15 yrs)'] || 0) + (s.bands['Leadership (15+ yrs)'] || 0) : 0;
      const senPlusLine = senPlus > 0 ? `\nSenior+ (8+ yrs): ${senPlus}` : '';
      return `### "${s.term}" — ${s.total} closures (joinees whose designation/function mentions "${s.term}")\nTop companies: ${top}\nBy industry: ${inds}${yoeLine}${bandLine}${senPlusLine}`;
    });
    parts.push('## SKILL / ROLE MATCHES (exact - searched across all joinee designations & functions)\n' + blocks.join('\n\n'));
  }

  // 3c) HQ / geography (exact)
  if (scope.hqs && scope.hqs.length) {
    const blocks = scope.hqs.map((hq) => {
      const H = pack.byHQ[hq];
      const tops = Object.values(pack.companies).filter((c) => (c.hq || 'Unknown') === hq).sort((a, b) => b.joinees - a.joinees).slice(0, 15).map((c) => `${c.name} (${c.joinees})`).join('; ');
      return `### ${hq}\nCompanies: ${H.companies} | Joinees: ${H.joinees} | Drops: ${H.drops} | Revenue: ${fmtRs(H.revenue)}\nTop companies: ${tops}`;
    });
    parts.push('## HQ / GEOGRAPHY (exact)\n' + blocks.join('\n\n'));
  }

  // 3d) Engagement model (exact)
  if (scope.models && scope.models.length) {
    const blocks = scope.models.map((m) => `### ${m}\nClients (${pack.byModel[m].length}): ${pack.byModel[m].slice(0, 50).join(', ')}`);
    parts.push('## ENGAGEMENT MODEL (exact)\n' + blocks.join('\n\n'));
  }

  // 3e) Specific financial year(s) asked about
  if (scope.fys && scope.fys.length) {
    parts.push('## MATCHED FINANCIAL YEAR (exact)\n' + scope.fys.map((fy) => { const F = pack.byFY[fy]; return `${fy}: ${F.joinees} joinees, ${F.drops} drops, ${fmtRs(F.revenue)}`; }).join('\n'));
  }

  // 3f) Joining location (India city where candidates joined)
  if (scope.locations && scope.locations.length) {
    const blocks = scope.locations.map((loc) => {
      const L = pack.byLocation[loc];
      const tops = Object.values(pack.companies).filter((c) => c.byLocation[loc]).sort((a, b) => (b.byLocation[loc] || 0) - (a.byLocation[loc] || 0)).slice(0, 12).map((c) => `${c.name} (${c.byLocation[loc]})`).join('; ');
      return `### ${loc}\nJoinees hired into this location: ${L.joinees} across ${L.companies} companies\nTop companies: ${tops}`;
    });
    parts.push('## JOINING LOCATION (exact - India city where candidates joined)\n' + blocks.join('\n\n'));
  }

  // If nothing matched at all, give a compact industry summary so general questions still work
  if (!scope.companies.length && !scope.industries.length && !(scope.skills && scope.skills.length) && !(scope.hqs && scope.hqs.length) && !(scope.models && scope.models.length)) {
    const rows = Object.values(pack.industries).sort((a, b) => b.revenue - a.revenue)
      .map((I) => {
        const top = (I.topCompanies || []).slice(0, 5).map((c) => `${c.name} (${c.joinees})`).join(', ');
        return `${I.name}: ${I.companies} cos, ${I.joinees} joinees, ${I.drops} drops, ${fmtRs(I.revenue)}${top ? ' | top clients: ' + top : ''}`;
      });
    parts.push('## INDUSTRY SUMMARY (exact — use the named top clients as proof points)\n' + rows.join('\n'));
  }

  // 4) Clients Worked With — only for scoped industries (touched, not necessarily closed)
  const cwIndustries = scope.industries.length ? scope.industries : [];
  const cwBlocks = [];
  for (const [sheetName, subs] of Object.entries(pack.clientsWorked)) {
    if (cwIndustries.length && !matchIndustryLoose(sheetName, cwIndustries)) continue;
    if (!cwIndustries.length) continue; // only inject for scoped industries
    cwBlocks.push(`### ${sheetName}\n` + subs.map((s) => {
      const comp = s.companies && s.companies.length ? `  Companies worked with: ${s.companies.slice(0, 40).join(', ')}` : '';
      const cap = s.capabilities && s.capabilities.length ? `  Requisition capabilities (roles we can fill): ${s.capabilities.slice(0, 40).join(', ')}` : '';
      return `${s.subsector}:\n${[comp, cap].filter(Boolean).join('\n')}`;
    }).join('\n'));
  }
  if (cwBlocks.length) parts.push('## CLIENTS WORKED WITH + REQUISITION CAPABILITIES (touched, not necessarily closed; capabilities = roles we can fill)\n' + cwBlocks.join('\n\n'));

  // Intent: is this a "how to sell / what do I say" question, or a pure data lookup?
  // Advice questions get the full playbook + doctrine + general method stories.
  // Data lookups stay lean (big token saving) and skip the selling material.
  const hasData = scope.companies.length || scope.industries.length || (scope.skills && scope.skills.length) || (scope.hqs && scope.hqs.length) || (scope.fys && scope.fys.length);
  const adviceIntent = /\b(say|said|saying|pitch|pitching|objection|convince|respond|response|angle|position|positioning|sell|selling|talk|handle|name.?drop|reactivat|dormant|follow.?up|nurtur|approach|advice|strategy|strateg|reframe|icp|qualify|qualified|target|meeting|first call|cold call|what do i|how do i|how should|what should|should i say)\b/i.test(userText) || !hasData;

  // 5) Case studies / methods (Sources)
  const src = pack.kb.sources || [];
  parts.push('## STORY INDEX (pick the story whose PROBLEM mirrors the prospect)\n' + src.map((s) => `${s.source_id} [${s.type}] ${s.client || s.industry || 'general'}: ${s.bd_usage}`).join('\n'));
  const scopedClientsNorm = new Set(scope.companies.map((c) => norm(c.name)));
  // pull a story if the query keywords match its "when to use" / tags / problem (e.g. "GCC" -> Xylem)
  const qToks = tokenize(userText);
  const storyKwHit = (s) => {
    const hay = ((s.bd_usage || '') + ' ' + (s.tags || '') + ' ' + (s.problem || '')).toLowerCase();
    return qToks.some((t) => t.length >= 3 && hay.includes(t));
  };
  const fullSources = src.filter((s) => {
    if (s.client && scopedClientsNorm.has(norm(s.client))) return true;
    if (s.industry && matchIndustryLoose(s.industry, scope.widenedIndustries)) return true;
    if (storyKwHit(s)) return true; // story whose usage/problem matches the query
    if (!s.client && !s.industry) return adviceIntent; // general methods for advice questions
    return false;
  }).slice(0, 8); // cap to keep the prompt bounded
  if (fullSources.length) {
    // client-safe half of each story (problem, intervention, client-safe result, when to use)
    parts.push('## RELEVANT STORIES (full)\n' + fullSources.map((s) =>
      `### ${s.source_id} - ${s.client || s.industry || 'general'} [${s.type}]\n` +
      `Problem: ${s.problem}\nIntervention: ${s.intervention}\n` +
      (s.result_client_safe ? `Client-safe result: ${s.result_client_safe}\n` : '') +
      `When to use: ${s.bd_usage}`
    ).join('\n\n'));
    // internal-only half (exact/approximate case metrics + handling notes) → internal bin
    const internalStories = fullSources.filter((s) => s.result_internal);
    if (internalStories.length) {
      internalParts.push('## CASE METRICS (INTERNAL — rep-only, never spoken to the client)\n' +
        internalStories.map((s) => `### ${s.source_id} - ${s.client || s.industry || 'general'}\n${s.result_internal}`).join('\n'));
    }
  }

  // 6) Doctrine — core definitions always; the rest (ICP/PEEPAL Way/commercials/targeting) only for advice questions
  const doc = pack.kb.doctrine || [];
  const coreCats = new Set(['definition', 'service_term', 'service_line', 'positioning']);
  const adviceCats = new Set(['icp_firmographic', 'excluded_industry', 'sweet_spot', 'service_fit', 'peepal_way', 'company', 'commercials', 'key_designations']);
  const wantsCommercials = /\b(commercial|commercials|fee|fees|pricing|price|rate|rates|commission|charge|charges|cost|margin|discount|percentage)\b/i.test(userText);
  const docBase = doc.filter((d) => coreCats.has(d.category) || (adviceIntent && adviceCats.has(d.category)) || (wantsCommercials && (d.category === 'commercials' || d.category === 'service_line')));
  const docScoped = doc.filter((d) => !coreCats.has(d.category) && !adviceCats.has(d.category) && (
    (d.examples && scope.companies.some((c) => norm(d.examples).includes(norm(c.name)))) ||
    matchIndustryLoose(d.industry || '', scope.widenedIndustries) ||
    ((adviceIntent || hasData) && ['stage', 'converting', 'not_converting', 'sub_icp', 'contact', 'timing'].includes(d.category))
  ));
  const docLine = (d) => `- [${d.category}] ${d.item}${d.detail ? ': ' + d.detail : ''}${d.examples ? ' | e.g. ' + d.examples : ''}${d.action ? ' | ACTION: ' + d.action : ''}`;
  const docRows = [...docBase, ...docScoped];
  // route doctrine by audience: general → client-safe bin, internal → internal bin
  const docClientSafe = docRows.filter((d) => d.audience !== 'internal');
  const docInternal = docRows.filter((d) => d.audience === 'internal');
  if (docClientSafe.length) parts.push('## DOCTRINE (ICP, services, PEEPAL Way, targeting)\n' + docClientSafe.map(docLine).join('\n'));
  if (docInternal.length) internalParts.push('## INTERNAL DOCTRINE (fees, skip/not-converting status, targeting — rep-only, never spoken to the client)\n' + docInternal.map(docLine).join('\n'));

  // 7) Playbook — the how-to-sell chapters, only for advice questions
  if (adviceIntent) {
    const pb = pack.kb.playbook || [];
    const pbCats = new Set(['mindset', 'first_call', 'discovery', 'data_usage', 'meeting_run', 'meeting_prep', 'followup', 'reliability', 'reactivation', 'at_risk', 'delivery', 'research', 'personal_dev', 'operating_model', 'operating_rhythm']);
    const pbRows = pb.filter((p) => pbCats.has(p.category));
    if (pbRows.length) parts.push('## PLAYBOOK (how to sell)\n' + pbRows.map((p) => `- [${p.category}] ${p.item}${p.detail ? ': ' + p.detail : ''}${p.action ? ' | ' + p.action : ''}`).join('\n'));
  }

  return { clientSafe: parts.join('\n\n'), internal: internalParts.join('\n\n'), scope, adviceIntent };
}

module.exports = { getPack, assembleContext, fmtRs };
