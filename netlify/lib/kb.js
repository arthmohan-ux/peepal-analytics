// netlify/lib/kb.js
// Builds the exact number pack + loads the curated KB tabs, then assembles a scoped,
// bounded context for the BD Copilot.
//
// Design rule: CODE answers the "what / how many / who / when" from the tracker rows.
// The LLM only phrases what is already computed here. It never sums, filters or guesses.
//
// What this file does, in order:
//   1. buildPack()        reads the sheet once (cached) into per-client stats + a row store
//   2. deriveScope()      works out what the question is about: clients (exact + fuzzy),
//                         industries (direct vs adjacent), skills, date ranges, seniority
//   3. crossFilter()      runs the exact filter over the rows (e.g. Java + BFSI + last 3 months)
//   4. assembleContext()  packs three bins: CLIENT-SAFE facts, TECHNIQUE, INTERNAL ONLY
//                         and returns code-computed facts / sources / evidence level / type

const { getSheetData } = require('./sheets');

// ── config ──────────────────────────────────────────────────────────────────
const INDUSTRY_SHEETS = [
  'IT - Product', 'Media and Entertainment', 'BFSI', 'Consulting',
  'Manufacturing & Engineering', 'Telecommunications', 'FMCG, Retail & Consumer Commerc',
  'IT - Services & Consulting', 'Pharma', 'Real Estate', 'Aviation',
];
const KB_TABS = ['Sources', 'Doctrine', 'Playbook'];
// Optional tabs. If a tab does not exist the Copilot simply runs without it.
//   Coaching: id | triggers | guidance | say_line | audience | active
//   Aliases:  alias | maps_to | kind (company|industry|skill) | relation (direct|adjacent)
const OPTIONAL_TABS = ['Coaching', 'Aliases'];
const CACHE_TTL_MS = 30 * 60 * 1000;

// ── small helpers ─────────────────────────────────────────────────────────────
function safeFloat(v) { const n = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isNaN(n) ? 0 : n; }
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function toWords(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function pad2(n) { return String(n).padStart(2, '0'); }
// Word-boundary phrase matcher so "Xperi" doesn't match "experience" and "EY GDS" matches "ey gds".
function phraseRegex(name) {
  const toks = toWords(name).split(' ').filter(Boolean).map(esc);
  if (!toks.length || toks.join('').length < 3) return null;
  return new RegExp('\\b' + toks.join('[^a-z0-9]+') + '\\b', 'i');
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_IDX = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// Sheet dates arrive as display strings whose format depends on the sheet locale
// (9/14/2026 in a US sheet, 14/09/2026 in an Indian one). `new Date()` silently swaps
// day and month on the second form. The tracker carries its own Year and Month columns,
// so use them to decide which number is the month.
function parseSheetDate(v, yearCol, monthCol) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  const hintM = MONTH_IDX[String(monthCol || '').trim().slice(0, 3).toLowerCase()] || null;
  let y, m, d, mm;
  if ((mm = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) { y = +mm[1]; m = +mm[2]; d = +mm[3]; }
  else if ((mm = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/))) {
    const a = +mm[1], b = +mm[2]; y = +mm[3]; if (y < 100) y += 2000;
    if (hintM && a === hintM && b !== hintM) { m = a; d = b; }
    else if (hintM && b === hintM && a !== hintM) { m = b; d = a; }
    else if (a > 12) { d = a; m = b; }
    else { m = a; d = b; }
  } else if ((mm = s.match(/^(\d{1,2})[\s\-]([A-Za-z]{3,})[\s\-,]*(\d{2,4})/))) {
    d = +mm[1]; m = MONTH_IDX[mm[2].slice(0, 3).toLowerCase()]; y = +mm[3]; if (y < 100) y += 2000;
  } else if (/^\d{5}(\.\d+)?$/.test(s)) { // raw Sheets serial number
    const dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(parseFloat(s)) * 86400000);
    y = dt.getUTCFullYear(); m = dt.getUTCMonth() + 1; d = dt.getUTCDate();
  } else {
    const dt = new Date(s);
    if (isNaN(dt.getTime())) return null;
    y = dt.getFullYear(); m = dt.getMonth() + 1; d = dt.getDate();
  }
  if (!y || !m || m < 1 || m > 12 || y < 1990 || y > 2100) return null;
  d = d || 1;
  return { y, m, d, ym: y + '-' + pad2(m), iso: y + '-' + pad2(m) + '-' + pad2(d) };
}
function monthLabel(key) {
  const [y, m] = String(key).split('-');
  return (MONTH_ABBR[parseInt(m, 10) - 1] || m) + ' ' + y;
}
function ymAdd(ym, n) {
  let [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return Math.floor(t / 12) + '-' + pad2((t % 12) + 1);
}
function fyOf(y, m) { return m >= 4 ? y + '-' + (y + 1) : (y - 1) + '-' + y; }

const QUARTER_ORDER = ['Q1 (Apr-Jun)', 'Q2 (Jul-Sep)', 'Q3 (Oct-Dec)', 'Q4 (Jan-Mar)'];
function quarterOfMonth(m) {
  if (m >= 4 && m <= 6) return 'Q1 (Apr-Jun)';
  if (m >= 7 && m <= 9) return 'Q2 (Jul-Sep)';
  if (m >= 10 && m <= 12) return 'Q3 (Oct-Dec)';
  return 'Q4 (Jan-Mar)';
}

// YOE-based experience bands
const EXP_BAND_ORDER = ['Junior (0-4 yrs)', 'Mid (4-8 yrs)', 'Senior (8-12 yrs)', 'Very Senior (12-15 yrs)', 'Leadership (15+ yrs)'];
function expBand(yoe) {
  if (yoe < 4) return 'Junior (0-4 yrs)';
  if (yoe < 8) return 'Mid (4-8 yrs)';
  if (yoe < 12) return 'Senior (8-12 yrs)';
  if (yoe < 15) return 'Very Senior (12-15 yrs)';
  return 'Leadership (15+ yrs)';
}

// Function family from designation + business unit text. Heuristic, labelled as such
// downstream. Order matters: the first family that matches wins.
const FAMILIES = [
  ['Enterprise platforms (SAP, Oracle, ServiceNow, Guidewire, Dynamics, Salesforce)', /\b(sap|oracle|servicenow|service now|snow|guidewire|msd|dynamics|d365|f&o|salesforce|sfdc|workday|netsuite|mulesoft|pega|aem|anaplan|onestream|hyperion|informatica|syniti|bods|cpq)\b/],
  ['QA & testing', /\b(qa|sdet|test|testing|tester|quality assurance|quality analyst)\b/],
  ['Data, analytics & AI', /\b(data|ai|ml|aiml|genai|gen ai|machine learning|analytics|bi|tableau|power bi|databricks|snowflake|etl|hadoop|spark|statistician|statistical|scientist|llm|nlp|daai|mis)\b/],
  ['Cloud, DevOps, infra & security', /\b(cloud|devops|sre|aws|azure|gcp|kubernetes|infra|infrastructure|network|linux|unix|security|cyber|infosec|iam|platform|dba|database|administrator|techops)\b/],
  ['Software engineering', /\b(software|developer|engineer|engineering|sde\d?|sse|java|net|dotnet|python|react|reactjs|angular|node|nodejs|full stack|fullstack|frontend|front end|backend|ios|android|embedded|firmware|architect|technical lead|tech lead|programmer|mainframe|ui|ado\d|c\+\+|c#)(?![a-z])/],
  ['Finance, tax, audit & risk', /\b(finance|financial|tax|audit|auditor|assurance|accounts?|accounting|accountant|fp&a|treasury|risk|compliance|kyc|aml|controller|valuation|actuary|actuarial|credit|fsrm|tprm|tpraas|sat|costing|cost|rtr|p2p|otc|underwriter|securities|equity|ibd|fro|sbs|sis|wam|strategy)\b/],
  ['HR & talent acquisition', /\b(hr|hrbp|talent|recruiter|recruitment|ta|payroll|c&b)\b/],
  ['Sales & marketing', /\b(sales|marketing|account manager|business development|campaign|content|brand|customer success|adops)\b/],
  ['Product, program & business analysis', /\b(product|program|project|pmo|scrum|business analyst|ba|bsa|delivery manager)\b/],
  ['Operations & support', /\b(operations|support|service desk|helpdesk|customer care|process|coordinator)\b/],
];
const TECH_FAMILIES = new Set(FAMILIES.slice(0, 5).map((f) => f[0]));
const UNCLASSIFIED = 'Unclassified (grade or band title only)';
function familyOf(combo) {
  if (!combo) return UNCLASSIFIED;
  for (const [name, re] of FAMILIES) if (re.test(combo)) return name;
  return UNCLASSIFIED;
}

// Industry adjacency: widens story/doctrine scope to neighbouring sectors.
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
  const names = ['Joinees All', 'Offer Drop All', 'Client Last Engagement', ...KB_TABS, ...OPTIONAL_TABS, ...INDUSTRY_SHEETS];
  const all = await Promise.all(names.map((t, i) => (i < 3 ? getSheetData(t) : getSheetData(t).catch(() => []))));
  const [joineeRows, dropRows, engRows] = all;
  const kbRows = all.slice(3, 3 + KB_TABS.length);
  const optRows = all.slice(3 + KB_TABS.length, 3 + KB_TABS.length + OPTIONAL_TABS.length);
  const industryRows = all.slice(3 + KB_TABS.length + OPTIONAL_TABS.length);

  const companies = {}; // normalized name -> stats
  function ensure(name) {
    const k = norm(name);
    if (!companies[k]) {
      companies[k] = {
        key: k, name: String(name).trim(), industry: '', hq: '', _ind: {}, _hq: {},
        joinees: 0, drops: 0, revenue: 0,
        byDesig: {}, byRole: {}, byFamily: {}, byDropDesig: {},
        exp: { sum: 0, count: 0, min: null, max: null }, byExpBand: {},
        byLocation: {}, byPrev: {}, byQuarter: {}, byMonth: {},
        firstJoin: null, lastJoin: null, lastOffer: null,
      };
    }
    return companies[k];
  }

  // A client's industry and HQ are taken by majority vote across its rows, ignoring
  // placeholders. Taking the first row seen let one "CHECK" cell drop a whole client
  // (Citi, 247 joinees) out of its industry.
  const PLACEHOLDER = /^(check|unknown|tbd|na|n\/a|-|)$/i;
  const vote = (bucket, v, w = 1) => { const x = String(v || '').trim(); if (x && !PLACEHOLDER.test(x)) bucket[x] = (bucket[x] || 0) + w; };
  const winner = (bucket) => { const e = Object.entries(bucket).sort((a, b) => b[1] - a[1])[0]; return e ? e[0] : ''; };
  const splitIndustry = []; // clients tagged with more than one industry in the sheet

  const rows = [];   // one compact record per joinee: the row store the cross-filter runs on
  const drops = [];  // one compact record per offer drop
  const byFY = {}, byQuarter = {}, byFYQ = {}, byMonth = {};
  const bump = (bucket, key, field, amt) => {
    if (!key) return;
    (bucket[key] = bucket[key] || { joinees: 0, drops: 0, revenue: 0 });
    bucket[key][field] += (amt === undefined ? 1 : amt);
  };
  let maxJoin = null, maxOffer = null, badDates = 0;

  joineeRows.slice(1).forEach((r) => {
    if (!r || !r[0] || !r[6]) return;
    const c = ensure(r[6]);
    const bill = safeFloat(r[9]);
    c.joinees += 1; c.revenue += bill;
    vote(c._ind, r[8]); vote(c._hq, r[7]);
    const dt = parseSheetDate(r[0], r[1], r[2]);
    if (!dt) badDates++;
    const desig = r[11] ? String(r[11]).trim() : '';
    const role = r[12] ? String(r[12]).trim() : '';
    const combo = (desig + ' ' + role).toLowerCase().replace(/\s+/g, ' ').trim();
    const fam = familyOf(combo);
    const yoeRaw = parseFloat(r[13]);
    const yoe = (!isNaN(yoeRaw) && yoeRaw >= 0 && yoeRaw < 60) ? yoeRaw : null;
    const loc = r[14] ? String(r[14]).trim() : '';
    let fy = null, q = null;
    if (dt) {
      fy = fyOf(dt.y, dt.m); q = quarterOfMonth(dt.m);
      bump(byFY, fy, 'joinees'); bump(byFY, fy, 'revenue', bill);
      c.byQuarter[q] = (c.byQuarter[q] || 0) + 1;
      bump(byQuarter, q, 'joinees'); bump(byQuarter, q, 'revenue', bill);
      const fq = fy + ' ' + q.split(' ')[0];
      bump(byFYQ, fq, 'joinees'); bump(byFYQ, fq, 'revenue', bill);
      c.byMonth[dt.ym] = (c.byMonth[dt.ym] || 0) + 1;
      bump(byMonth, dt.ym, 'joinees'); bump(byMonth, dt.ym, 'revenue', bill);
      if (!c.firstJoin || dt.iso < c.firstJoin) c.firstJoin = dt.iso;
      if (!c.lastJoin || dt.iso > c.lastJoin) c.lastJoin = dt.iso;
      if (!maxJoin || dt.iso > maxJoin) maxJoin = dt.iso;
    }
    if (desig) c.byDesig[desig] = (c.byDesig[desig] || 0) + 1;
    if (role) c.byRole[role] = (c.byRole[role] || 0) + 1;
    c.byFamily[fam] = (c.byFamily[fam] || 0) + 1;
    if (yoe !== null) {
      c.exp.sum += yoe; c.exp.count += 1;
      c.exp.min = c.exp.min === null ? yoe : Math.min(c.exp.min, yoe);
      c.exp.max = c.exp.max === null ? yoe : Math.max(c.exp.max, yoe);
      const band = expBand(yoe);
      c.byExpBand[band] = (c.byExpBand[band] || 0) + 1;
    }
    if (loc) c.byLocation[loc] = (c.byLocation[loc] || 0) + 1;
    const prev = r[15] ? String(r[15]).trim() : '';
    if (prev) c.byPrev[prev] = (c.byPrev[prev] || 0) + 1;
    rows.push({ ck: c.key, iso: dt ? dt.iso : null, ym: dt ? dt.ym : null, fy, q, desig, role, combo, fam, yoe, loc, bill });
  });

  dropRows.slice(1).forEach((r) => {
    if (!r || !r[0] || !r[6]) return;
    const c = ensure(r[6]);
    c.drops += 1;
    vote(c._ind, r[9], 0.5); vote(c._hq, r[7], 0.5); // joinee rows outvote offer-drop rows
    const dt = parseSheetDate(r[0], r[1], r[2]);
    if (dt) {
      const fy = fyOf(dt.y, dt.m), q = quarterOfMonth(dt.m);
      bump(byFY, fy, 'drops'); bump(byQuarter, q, 'drops'); bump(byFYQ, fy + ' ' + q.split(' ')[0], 'drops'); bump(byMonth, dt.ym, 'drops');
      if (!c.lastOffer || dt.iso > c.lastOffer) c.lastOffer = dt.iso;
      if (!maxOffer || dt.iso > maxOffer) maxOffer = dt.iso;
    }
    const desig = r[8] ? String(r[8]).trim() : '';
    if (desig) c.byDropDesig[desig] = (c.byDropDesig[desig] || 0) + 1;
    drops.push({ ck: c.key, ym: dt ? dt.ym : null, desig, combo: desig.toLowerCase() });
  });

  Object.values(companies).forEach((c) => {
    c.industry = winner(c._ind); c.hq = winner(c._hq);
    if (Object.keys(c._ind).length > 1) splitIndustry.push(`${c.name}: ${Object.entries(c._ind).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + Math.round(v)).join(' / ')}`);
    delete c._ind; delete c._hq;
  });

  // engagement model + dates
  const engagement = {};
  engRows.slice(1).forEach((r) => {
    if (!r || !r[0]) return;
    const f = parseSheetDate(r[2]), l = parseSheetDate(r[3]), e = parseSheetDate(r[4]);
    engagement[norm(r[0])] = { model: r[1] ? String(r[1]).trim() : '', first: f ? f.iso : '', last: l ? l.iso : '', end: e ? e.iso : '' };
  });
  Object.values(companies).forEach((c) => { const e = engagement[c.key]; if (e) c.engagement = e; });

  // industry rollups
  const industries = {};
  Object.values(companies).forEach((c) => {
    const ind = c.industry || 'Unknown';
    if (!industries[ind]) industries[ind] = { name: ind, companies: 0, joinees: 0, drops: 0, revenue: 0, byExpBand: {}, byQuarter: {}, byMonth: {}, byFamily: {}, topCompanies: [] };
    const I = industries[ind];
    I.companies += 1; I.joinees += c.joinees; I.drops += c.drops; I.revenue += c.revenue;
    for (const [b, n] of Object.entries(c.byExpBand)) I.byExpBand[b] = (I.byExpBand[b] || 0) + n;
    for (const [q, n] of Object.entries(c.byQuarter)) I.byQuarter[q] = (I.byQuarter[q] || 0) + n;
    for (const [m, n] of Object.entries(c.byMonth)) I.byMonth[m] = (I.byMonth[m] || 0) + n;
    for (const [f, n] of Object.entries(c.byFamily)) I.byFamily[f] = (I.byFamily[f] || 0) + n;
  });
  Object.values(industries).forEach((I) => {
    I.topCompanies = Object.values(companies)
      .filter((c) => (c.industry || 'Unknown') === I.name)
      .sort((a, b) => b.joinees - a.joinees).slice(0, 25)
      .map((c) => ({ name: c.name, joinees: c.joinees, drops: c.drops, revenue: c.revenue }));
  });

  const byHQ = {};
  Object.values(companies).forEach((c) => {
    const hq = c.hq || 'Unknown';
    if (!byHQ[hq]) byHQ[hq] = { hq, companies: 0, joinees: 0, drops: 0, revenue: 0 };
    const H = byHQ[hq]; H.companies++; H.joinees += c.joinees; H.drops += c.drops; H.revenue += c.revenue;
  });

  const byModel = {};
  Object.entries(engagement).forEach(([nk, e]) => {
    if (!e.model) return;
    (byModel[e.model] = byModel[e.model] || []).push(companies[nk] ? companies[nk].name : nk);
  });

  const byLocation = {};
  Object.values(companies).forEach((c) => {
    for (const [loc, n] of Object.entries(c.byLocation)) {
      const L = (byLocation[loc] = byLocation[loc] || { location: loc, joinees: 0, companies: 0 });
      L.joinees += n; L.companies += 1;
    }
  });

  const totals = {
    companies: Object.keys(companies).length,
    clientsWithJoinees: Object.values(companies).filter((c) => c.joinees > 0).length,
    joinees: rows.length, drops: drops.length,
    revenue: Object.values(companies).reduce((s, c) => s + c.revenue, 0),
  };

  // Clients tab per industry: companies touched + roles we can fill. `touched` lets the
  // resolver say "listed in the Clients tab but no recorded closures" instead of nothing.
  const clientsWorked = {};
  const touched = {};
  industryRows.forEach((rws, i) => {
    if (!rws || rws.length < 2) return;
    const header = rws[0];
    const subs = [];
    for (let ci = 2; ci < header.length - 1; ci++) {
      const val = header[ci], next = header[ci + 1];
      if (val && !/Requisition|Roles closed/i.test(String(val)) && next && /Requisition/i.test(String(next))) subs.push({ ci, name: String(val).trim() });
    }
    const out = [];
    subs.forEach(({ ci, name }) => {
      const comps = new Set(), caps = new Set();
      for (let r = 2; r < rws.length; r++) {
        const comp = rws[r] && rws[r][ci] ? String(rws[r][ci]).trim() : '';
        const cap = rws[r] && rws[r][ci + 1] ? String(rws[r][ci + 1]).trim() : '';
        if (comp) {
          comps.add(comp);
          const bare = comp.replace(/\s*[\[(].*$/, '').trim();
          const k = norm(bare);
          if (k.length >= 3 && !touched[k]) touched[k] = { name: bare, sheet: INDUSTRY_SHEETS[i], subsector: name };
        }
        if (cap && !cap.toLowerCase().includes('requisition')) caps.add(cap);
      }
      if (comps.size || caps.size) out.push({ subsector: name, companies: [...comps], capabilities: [...caps] });
    });
    if (out.length) clientsWorked[INDUSTRY_SHEETS[i]] = out;
  });

  function rowsToObjects(rws) {
    if (!rws || rws.length < 2) return [];
    const headers = rws[0].map((h) => String(h || '').trim().toLowerCase());
    return rws.slice(1)
      .filter((r) => r && r.some((c) => String(c || '').trim() !== ''))
      .map((r) => { const o = {}; headers.forEach((h, i) => { if (h) o[h] = r[i] != null ? String(r[i]).trim() : ''; }); return o; });
  }
  const kb = {};
  KB_TABS.forEach((t, i) => { kb[t.toLowerCase()] = rowsToObjects(kbRows[i]); });
  OPTIONAL_TABS.forEach((t, i) => { kb[t.toLowerCase()] = rowsToObjects(optRows[i]); });

  // unclassified-industry clients: a data-hygiene number surfaced in /api/copilot/health
  const junkIndustryClients = Object.values(companies).filter((c) => /^(check|unknown|tbd|)$/i.test(c.industry || '')).map((c) => c.name);

  return {
    at: Date.now(), totals, companies, rows, drops, industries, byHQ, byFY, byQuarter, byFYQ, byMonth, byModel, byLocation,
    clientsWorked, touched, engagement, kb,
    coverage: { lastJoin: maxJoin, lastOffer: maxOffer, badDates, junkIndustryClients, splitIndustry },
  };
}

async function getPack(force = false) {
  if (!force && _cache && (Date.now() - _cache.at) < CACHE_TTL_MS) return _cache.pack;
  const pack = await buildPack();
  _cache = { at: Date.now(), pack };
  return pack;
}
function clearPack() { _cache = null; }

// ── formatting helpers ────────────────────────────────────────────────────────
function fmtRs(n) {
  if (!n) return '0';
  if (n >= 1e7) return '₹' + (n / 1e7).toFixed(2) + 'Cr';
  if (n >= 1e5) return '₹' + (n / 1e5).toFixed(2) + 'L';
  return '₹' + Math.round(n).toLocaleString('en-IN');
}
function topEntries(obj, n) { return Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n); }
function listTop(obj, n) { return topEntries(obj, n).map(([k, v]) => `${k} (${v})`).join('; '); }

// ── tokenising ────────────────────────────────────────────────────────────────
const STOPWORDS = new Set([
  'what', 'have', 'has', 'had', 'we', 'our', 'us', 'the', 'and', 'or', 'for', 'with', 'from', 'are', 'is', 'do', 'does', 'did',
  'how', 'many', 'much', 'who', 'can', 'you', 'they', 'them', 'their', 'been', 'closed', 'closure', 'closures', 'close',
  'joinee', 'joinees', 'joined', 'hire', 'hires', 'hiring', 'hired', 'role', 'roles', 'client', 'clients', 'company', 'companies',
  'industry', 'industries', 'revenue', 'offer', 'offers', 'drop', 'drops', 'about', 'around', 'give', 'show', 'list', 'tell',
  'say', 'this', 'that', 'these', 'those', 'get', 'got', 'any', 'all', 'some', 'more', 'most', 'versus', 'done', 'work', 'worked',
  'working', 'placed', 'placements', 'candidates', 'people', 'name', 'names', 'which', 'where', 'when', 'seniority', 'senior',
  'junior', 'model', 'models', 'track', 'record', 'numbers', 'experience', 'should', 'would', 'could', 'approach', 'new',
  'given', 'need', 'needs', 'want', 'help', 'helps', 'info', 'pattern', 'patterns', 'level', 'levels', 'further', 'across',
  'range', 'ranges', 'let', 'know', 'like', 'good', 'best', 'proof', 'similar', 'such', 'also', 'just', 'not', 'non', 'only',
  'into', 'out', 'was', 'were', 'will', 'being', 'than', 'then', 'there', 'here', 'they', 'talking', 'pitching', 'pitch',
  'meeting', 'call', 'tomorrow', 'today', 'think', 'thinks', 'says', 'said', 'year', 'years', 'month', 'months', 'quarter',
  'last', 'past', 'previous', 'between', 'during', 'since', 'kind', 'sort', 'type', 'types', 'specific', 'specially', 'mind',
  'keep', 'everything', 'anything', 'something', 'strongest', 'relevant', 'position', 'positions', 'yoe', 'band', 'entire',
  'database', 'details', 'detail', 'currently', 'recently', 'recent', 'time', 'whose', 'anywhere', 'can', 'its', 'his', 'her',
  'jan', 'january', 'feb', 'february', 'mar', 'march', 'apr', 'april', 'may', 'jun', 'june', 'jul', 'july', 'aug', 'august',
  'vendor', 'vendors', 'partner', 'partners', 'conversation', 'internal', 'expensive', 'requirement', 'requirements', 'warm', 'email', 'interested', 'budget', 'strong', 'enough', 'exact', 'vertical', 'firms', 'firm', 'space', 'sector', 'hard', 'unique', 'looking', 'thing', 'things', 'examples', 'example', 'story', 'stories', 'case', 'study', 'studies', 'capability', 'capabilities', 'pitched', 'previously', 'catered', 'cater', 'volume', 'overall', 'total', 'number', 'average', 'every', 'add', 'one', 'biggest', 'largest', 'really', 'actually', 'still', 'ever', 'yet', 'mostly', 'both', 'each', 'other', 'another', 'same', 'different', 'various', 'including', 'within', 'without', 'over', 'under', 'after', 'before', 'because', 'why', 'please', 'thanks', 'track', 'record', 'cracked', 'placed', 'talk', 'ask', 'doing', 'going', 'based', 'using', 'tried', 'done', 'drive', 'area', 'areas', 'side', 'play', 'plays', 'heavy', 'focus', 'focused', 'level',
  'head', 'gcc', 'india', 'indian', 'centre', 'center', 'global', 'setup', 'setting', 'building', 'scaling',
  'sep', 'sept', 'september', 'oct', 'october', 'nov', 'november', 'dec', 'december', 'billing', 'billed', 'reaching',
]);
// Short tokens that are real skills, so the 3-character minimum does not drop them.
const SHORT_SKILLS = new Set(['ai', 'ml', 'qa', 'ui', 'ux', 'bi', 'hr', 'ta', 'c#', 'go', 'pm', 'ba']);
// Words too generic to search on their own ("engineer" matches a third of the tracker).
const GENERIC_SKILL = new Set(['engineer', 'developer', 'analyst', 'manager', 'consultant', 'lead', 'associate', 'specialist',
  'tech', 'technology', 'technical', 'product', 'service', 'services', 'software', 'senior', 'staff', 'team', 'business', 'project', 'program', 'operation']);
function stem(w) { return w.length > 4 && /[^s]s$/.test(w) ? w.slice(0, -1) : w; }
function tokenize(t) {
  const out = [];
  for (const w of String(t || '').toLowerCase().split(/[^a-z0-9+#.]+/)) {
    const x = w.replace(/^\.+|\.+$/g, '');
    if (!x || STOPWORDS.has(x)) continue;
    if (x.length >= 3 || SHORT_SKILLS.has(x)) out.push(stem(x));
  }
  return out;
}
function uniq(a) { return [...new Set(a)]; }

// ── skill search over the row store ───────────────────────────────────────────
// Synonym groups: the word a rep types is often not the word in the tracker.
// One group = one regex, so "cybersecurity" returns one unioned count instead of
// separate "security (30)" and "cyber (3)" fragments.
const SKILL_GROUPS = [
  { label: 'cyber security', trig: /\b(cyber ?security|cyber|infosec|information security|security)\b/i, src: 'cyber|security|infosec|vulnerab|threat|\\biam\\b' },
  { label: 'AI / ML / GenAI', trig: /\b(ai|ml|aiml|ai\/ml|gen ?ai|agentic|llms?|machine learning|deep learning|artificial intelligence|applied scien\w*)\b/i, src: '\\bai\\b|\\bml\\b|aiml|gen ?ai|\\bllm|machine learning|deep learning|agentic|\\bnlp\\b|computer vision|data scien|applied scien' },
  { label: 'data engineering', trig: /\bdata (eng\w*|pipeline\w*|platform\w*)\b/i, src: 'data eng|\\betl\\b|databricks|pyspark|snowflake|hadoop|big ?data|informatica|talend|datastage' },
  { label: 'data science', trig: /\bdata scien\w*\b/i, src: 'data scien|scientist|statistic' },
  { label: 'full stack', trig: /\bfull ?stack\b/i, src: 'full ?stack|\\bfsd\\b|\\bmern\\b' },
  { label: 'front end', trig: /\bfront ?end\b/i, src: 'front ?end|\\bui\\b|react|angular|\\bvue' },
  { label: 'back end', trig: /\bback ?end\b/i, src: 'back ?end' },
  { label: 'QA / testing', trig: /\b(qa|sdet|testing|testers?|test engineers?|quality assurance)\b/i, src: '\\bqa\\b|sdet|\\btest|quality a' },
  { label: 'DevOps / SRE', trig: /\b(dev ?ops|sre|site reliability)\b/i, src: 'dev ?ops|\\bsre\\b|site reliab|devsecops' },
  { label: '.NET', trig: /(^|[^a-z])(\.net|dot ?net)\b/i, src: '\\.net|dot ?net' },
  { label: 'software engineering', trig: /\b(software (engg?|engineering|engineers?|developers?|development)|swe|sde)\b/i, src: 'software|\\bsde\\d?\\b|\\bsse\\b|developer|programmer' },
  { label: 'risk', trig: /\brisk\b/i, src: 'risk|fsrm|tprm|tpraas|\\borm\\b|\\bmrm\\b' },
  { label: 'finance & accounting', trig: /\b(finance|f&a|accounting|accounts)\b/i, src: 'financ|account|fp&a|\\brtr\\b|\\bp2p\\b|controller|treasury' },
  { label: 'tax', trig: /\b(tax|taxation)\b/i, src: '\\btax' },
  { label: 'audit', trig: /\b(audit|auditors?|assurance)\b/i, src: 'audit|assurance' },
  { label: 'HR / talent acquisition', trig: /\b(hr|human resources|talent acquisition|recruiters?)\b/i, src: '\\bhr\\b|hrbp|talent|recruit' },
  { label: 'sales & marketing', trig: /\b(sales|marketing)\b/i, src: 'sales|marketing' },
];

function summarise(list, pack) {
  const byClient = {}, byDesig = {}, byRole = {}, byBand = {}, byInd = {}, byFam = {}, byYm = {}, lastByClient = {};
  let eS = 0, eN = 0, eMin = null, eMax = null, first = null, last = null;
  for (const r of list) {
    const c = pack.companies[r.ck]; const nm = c ? c.name : r.ck;
    byClient[nm] = (byClient[nm] || 0) + 1;
    if (r.desig) byDesig[r.desig] = (byDesig[r.desig] || 0) + 1;
    if (r.role) byRole[r.role] = (byRole[r.role] || 0) + 1;
    byFam[r.fam] = (byFam[r.fam] || 0) + 1;
    const ind = (c && c.industry) || 'Unknown'; byInd[ind] = (byInd[ind] || 0) + 1;
    if (r.yoe !== null) { eS += r.yoe; eN++; eMin = eMin === null ? r.yoe : Math.min(eMin, r.yoe); eMax = eMax === null ? r.yoe : Math.max(eMax, r.yoe); const b = expBand(r.yoe); byBand[b] = (byBand[b] || 0) + 1; }
    if (r.ym) byYm[r.ym] = (byYm[r.ym] || 0) + 1;
    if (r.iso) { if (!first || r.iso < first) first = r.iso; if (!last || r.iso > last) last = r.iso; if (!lastByClient[nm] || r.iso > lastByClient[nm]) lastByClient[nm] = r.iso; }
  }
  return { n: list.length, byClient, byDesig, byRole, byBand, byInd, byFam, byYm, lastByClient, first, last,
    yoe: eN ? { avg: (eS / eN).toFixed(1), min: eMin, max: eMax, n: eN } : null };
}

function skillSearch(label, src, pack) {
  let re; try { re = new RegExp(src, 'i'); } catch (_) { return null; }
  const hits = pack.rows.filter((r) => r.combo && re.test(r.combo));
  const s = summarise(hits, pack);
  return { term: label, src, re, total: s.n, sum: s };
}

function tokenRegexSrc(tok) {
  const e = esc(tok);
  return /[a-z0-9]$/.test(tok) ? '\\b' + e + 's?\\b' : '(^|[^a-z0-9])' + e + '(?![a-z0-9])';
}

// ── date ranges ───────────────────────────────────────────────────────────────
const MON_PAT = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, nine: 9, twelve: 12, couple: 2, few: 3 };
function fyRange(startYear) { return { from: startYear + '-04', to: (startYear + 1) + '-03' }; }

// Returns up to 3 ranges: { from:'YYYY-MM', to:'YYYY-MM', label }. Month granularity.
function parseRanges(text, now) {
  const t = ' ' + String(text || '').toLowerCase().replace(/[–—]/g, '-') + ' ';
  const nowYm = now.getFullYear() + '-' + pad2(now.getMonth() + 1);
  const nowFyStart = now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1;
  const out = [];
  const add = (from, to, label) => { if (from > to) { const x = from; from = to; to = x; } if (!out.some((r) => r.from === from && r.to === to)) out.push({ from, to, label }); };
  let m;

  // relative windows
  const rel = /\b(?:past|last|previous|recent)\s+(\d+|one|two|three|four|five|six|nine|twelve|couple of|few)?\s*(week|month|quarter|year)s?\b/g;
  while ((m = rel.exec(t))) {
    const raw = (m[1] || '').replace(' of', '');
    const n = raw ? (parseInt(raw, 10) || NUM_WORDS[raw] || 1) : 1;
    const unit = m[2];
    if (!m[1] && unit === 'month') { const p = ymAdd(nowYm, -1); add(p, p, 'last month (' + monthLabel(p) + ')'); continue; }
    if (!m[1] && unit === 'year') { const y = now.getFullYear() - 1; add(y + '-01', y + '-12', 'last calendar year (' + y + ')'); continue; }
    if (!m[1] && unit === 'quarter') { // previous FY quarter
      const qStart = (ym) => { const mo = +ym.split('-')[1]; const s = mo >= 4 && mo <= 6 ? 4 : mo >= 7 && mo <= 9 ? 7 : mo >= 10 ? 10 : 1; return ym.split('-')[0] + '-' + pad2(s); };
      const cur = qStart(nowYm); const from = ymAdd(cur, -3); add(from, ymAdd(from, 2), 'last quarter (' + monthLabel(from) + ' to ' + monthLabel(ymAdd(from, 2)) + ')'); continue;
    }
    const months = unit === 'week' ? Math.max(1, Math.ceil(n / 4)) : unit === 'quarter' ? n * 3 : unit === 'year' ? n * 12 : n;
    const from = ymAdd(nowYm, -months);
    add(from, nowYm, `last ${n} ${unit}${n > 1 ? 's' : ''} (${monthLabel(from)} to ${monthLabel(nowYm)})`);
  }
  if (/\bthis month\b/.test(t)) add(nowYm, nowYm, 'this month (' + monthLabel(nowYm) + ')');
  if (/\b(this|current) (calendar )?year\b/.test(t)) add(now.getFullYear() + '-01', nowYm, 'this calendar year to date');
  if (/\b(this|current) (fy|financial year|fiscal year)\b|\bytd\b|\byear to date\b/.test(t)) { const r = fyRange(nowFyStart); add(r.from, nowYm, `this FY to date (FY ${nowFyStart}-${nowFyStart + 1})`); }
  if (/\b(last|previous) (fy|financial year|fiscal year)\b/.test(t)) { const r = fyRange(nowFyStart - 1); add(r.from, r.to, `last FY (${nowFyStart - 1}-${nowFyStart})`); }
  if (/\b(this|current) quarter\b/.test(t)) { const mo = now.getMonth() + 1; const s = mo >= 4 && mo <= 6 ? 4 : mo >= 7 && mo <= 9 ? 7 : mo >= 10 ? 10 : 1; const from = now.getFullYear() + '-' + pad2(s); add(from, ymAdd(from, 2), 'this quarter'); }

  // explicit FY: "2025-2026", "2025-26", "FY25", "FY 25-26", "FY2026"; optional quarter in front
  const consumed = [];
  const fyA = /\b(?:q([1-4])\s*(?:of\s*)?)?(?:fy\s*'?)?(20\d{2})\s*[-\/]\s*(?:20)?(\d{2})\b/g;
  while ((m = fyA.exec(t))) {
    const y1 = +m[2], y2 = 2000 + +m[3];
    if (y2 !== y1 + 1) continue; // "2025-03" style month tokens are not FYs
    consumed.push([m.index, m.index + m[0].length]);
    const r = fyRange(y1);
    if (m[1]) { const qs = ymAdd(r.from, (+m[1] - 1) * 3); add(qs, ymAdd(qs, 2), `Q${m[1]} FY ${y1}-${y2}`); }
    else add(r.from, r.to, `FY ${y1}-${y2}`);
  }
  const fyC = /\b(?:q([1-4])\s*(?:of\s*)?)?fy\s*'?(\d{2})\s*[-\/]\s*(\d{2})\b/g; // "FY25-26"
  while ((m = fyC.exec(t))) {
    const y1 = 2000 + +m[2], y2 = 2000 + +m[3];
    if (y2 !== y1 + 1) continue;
    consumed.push([m.index, m.index + m[0].length]);
    const r = fyRange(y1);
    if (m[1]) { const qs = ymAdd(r.from, (+m[1] - 1) * 3); add(qs, ymAdd(qs, 2), `Q${m[1]} FY ${y1}-${y2}`); }
    else add(r.from, r.to, `FY ${y1}-${y2}`);
  }
  const fyB = /\b(?:q([1-4])\s*(?:of\s*)?)?fy\s*'?(\d{2}|20\d{2})\b(?!\s*[-\/]\s*\d)/g;
  while ((m = fyB.exec(t))) {
    let end = +m[2]; if (end < 100) end += 2000; // FY25 = Apr 2024 to Mar 2025
    consumed.push([m.index, m.index + m[0].length]);
    const r = fyRange(end - 1);
    if (m[1]) { const qs = ymAdd(r.from, (+m[1] - 1) * 3); add(qs, ymAdd(qs, 2), `Q${m[1]} FY ${end - 1}-${end}`); }
    else add(r.from, r.to, `FY ${end - 1}-${end}`);
  }
  const inConsumed = (i) => consumed.some(([a, b]) => i >= a && i < b);

  // date points: "march 2025", "mar '25", "2025 march", "2025-03", bare month, bare year
  const pts = [];
  const p1 = new RegExp('\\b' + MON_PAT + "\\b\\.?[\\s,']{0,3}(20\\d{2}|\\d{2})?\\b", 'g');
  while ((m = p1.exec(t))) {
    if (inConsumed(m.index)) continue;
    if (m[1] === 'may' && !m[2]) continue; // the modal verb
    let y = m[2] ? +m[2] : null; if (y !== null && y < 100) y += 2000;
    pts.push({ i: m.index, end: m.index + m[0].length, mo: MONTH_IDX[m[1].slice(0, 3)], y });
  }
  const p2 = /\b(20\d{2})-(0[1-9]|1[0-2])\b/g;
  while ((m = p2.exec(t))) if (!inConsumed(m.index)) pts.push({ i: m.index, end: m.index + m[0].length, mo: +m[2], y: +m[1] });
  const p3 = /\b(20[0-3]\d)\b/g;
  while ((m = p3.exec(t))) {
    if (inConsumed(m.index) || pts.some((p) => m.index >= p.i && m.index < p.end)) continue;
    // "2025 march": attach the year to the following month point if it has none
    const nxt = pts.find((p) => p.y === null && p.i > m.index && p.i - (m.index + 4) <= 3);
    if (nxt) { nxt.y = +m[1]; continue; }
    pts.push({ i: m.index, end: m.index + 4, mo: null, y: +m[1] });
  }
  pts.sort((a, b) => a.i - b.i);
  // fill a missing year from a neighbour ("january to march 2026")
  pts.forEach((p, i) => { if (p.y === null) { const nb = pts.slice(i + 1).find((x) => x.y !== null) || pts.slice(0, i).reverse().find((x) => x.y !== null); if (nb) p.y = nb.y; } });
  const dated = pts.filter((p) => p.y !== null);
  const startOf = (p) => (p.mo ? p.y + '-' + pad2(p.mo) : p.y + '-01');
  const endOf = (p) => (p.mo ? p.y + '-' + pad2(p.mo) : p.y + '-12');
  const lab = (p) => (p.mo ? MONTH_ABBR[p.mo - 1] + ' ' + p.y : String(p.y));
  const isRange = /\b(between|from)\b[^.?!]*\b(to|and|till|until|through|thru)\b|\d\s*(to|till|until|through|-)\s*[a-z0-9]/.test(t);
  if (dated.length >= 2 && isRange) {
    let a = dated[0], b = dated[1];
    if (startOf(a) > endOf(b) && a.mo && b.mo && pts[0].y === b.y) a = Object.assign({}, a, { y: a.y - 1 });
    add(startOf(a), endOf(b), lab(a) + ' to ' + lab(b));
  } else if (dated.length >= 1 && /\b(since|after|from|starting)\b/.test(t) && !isRange) {
    add(startOf(dated[0]), nowYm, 'since ' + lab(dated[0]));
  } else {
    dated.slice(0, 3).forEach((p) => add(startOf(p), endOf(p), p.mo ? lab(p) : 'calendar year ' + p.y));
  }

  // "currently / recently / ongoing": recent activity = last 6 months
  if (!out.length && /\b(currently|right now|these days|at present|ongoing|recently|lately|active (clients?|accounts?|roles?)|working on|live (roles?|accounts?|clients?))\b/.test(t)) {
    const from = ymAdd(nowYm, -6);
    add(from, nowYm, `recent activity, last 6 months (${monthLabel(from)} to ${monthLabel(nowYm)})`);
  }
  return out.slice(0, 3);
}

// ── fuzzy client resolution ───────────────────────────────────────────────────
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
// Client names that are also everyday BD words: never auto-match these.
const COMPANY_MATCH_SKIP = new Set(['target', 'meeting', 'call', 'help', 'lead', 'scale', 'pilot', 'bot', 'array', 'aspect', 'jana', 'kiwi']);
// Everyday shorthand for tracked clients. Add more in the Aliases tab, no deploy needed.
const BUILTIN_ALIASES = { ey: 'EY GDS', 'e&y': 'EY GDS', 'ernst & young': 'EY GDS', 'ernst and young': 'EY GDS', kpmg: 'KGS', 'kpmg global services': 'KGS',
  goldman: 'Goldman Sachs', citibank: 'Citi', citigroup: 'Citi', jpmc: 'Jp Morgan', 'jpmorgan': 'Jp Morgan', 'jp morgan chase': 'Jp Morgan',
  'de shaw': 'D E Shaw', 'd.e. shaw': 'D E Shaw', cnh: 'CNHI', 'cnh industrial': 'CNHI', sonnys: "Sonny's", swissre: 'Swiss Re', united: 'United Airlines',
  'true value hub': 'TVH', 'fis global': 'FIS', 'bombay stock exchange': 'Bombay Stock Exchange', bse: 'Bombay Stock Exchange' };
// First words too ordinary to stand in for a whole client name ("applied" is not Applied Materials).
const WEAK_FIRST_WORD = new Set(['applied', 'general', 'global', 'smart', 'business', 'decision', 'insight', 'state', 'capital', 'credit', 'market',
  'master', 'people', 'true', 'seven', 'river', 'blue', 'near', 'giant', 'electronic', 'evolving', 'procure', 'analytical', 'depth', 'data', 'tata',
  'cross', 'curl', 'delta', 'lucy', 'open', 'spicy', 'thomas', 'stan', 'contract', 'clover', 'joule', 'maxim', 'monarch', 'nissan', 'power', 'tiger', 'trampoline']);
const NOT_A_NAME = new Set(['client', 'clients', 'company', 'companies', 'prospect', 'vendor', 'vendors', 'firm', 'gcc', 'team', 'someone',
  'them', 'him', 'her', 'the', 'this', 'that', 'new', 'big', 'small', 'large', 'global', 'indian', 'foreign', 'german', 'american',
  'japanese', 'startup', 'bank', 'banks', 'insurer', 'retailer', 'manufacturer', 'cto', 'chro', 'head', 'founder', 'leadership']);
// Phrases that introduce a prospect name: "talking to Airbus", "a company called Genpact".
const INTRO_RE = /\b(?:talking to|speaking (?:to|with)|meeting(?: with)?|pitching(?: to)?|on (?:a )?call with|call with|reaching out to|approaching|prospect(?:ing)?(?: is)?|company called|client called|firm called|called|named|about|for|with|at)\s+((?:[A-Z][\w&.'-]*|[a-z][\w&.'-]{2,})(?:\s+[A-Z][\w&.'-]*){0,2})/g;

function resolveClients(question, pack, aliasCompanies) {
  const lowerText = ' ' + toWords(question) + ' ';
  const exact = [], fuzzy = [], touchedHits = [], unknown = [];
  const seen = new Set();
  const take = (c, how, term, bare) => { if (seen.has(c.key)) return; seen.add(c.key); (how === 'exact' ? exact : fuzzy).push(how === 'exact' ? c : { c, term, bare: !!bare }); };

  for (const c of Object.values(pack.companies)) {
    if (COMPANY_MATCH_SKIP.has(c.key)) continue;
    const re = phraseRegex(c.name);
    if (re && re.test(lowerText)) take(c, 'exact');
  }
  // aliases from the Aliases tab ("KPMG Global Services" -> KGS)
  const allAliases = Object.entries(BUILTIN_ALIASES).map(([alias, maps_to]) => ({ alias, maps_to })).concat(aliasCompanies);
  for (const a of allAliases) {
    const toks = a.alias.toLowerCase().split(/\s+/).map(esc);
    const re = new RegExp('(^|[^a-z0-9&])' + toks.join('[^a-z0-9&]*') + '(?![a-z0-9&])', 'i');
    if (re.test(String(question))) { const c = pack.companies[norm(a.maps_to)]; if (c) take(c, 'exact'); }
  }
  // a distinctive first word stands in for the full name: "wipro digital", "telstra india", "capillary"
  const firstWords = {};
  for (const c of Object.values(pack.companies)) { const fw = toWords(c.name).split(' ')[0]; (firstWords[fw] = firstWords[fw] || []).push(c); }
  for (const [fw, list] of Object.entries(firstWords)) {
    if (fw.length < 5 || list.length !== 1 || WEAK_FIRST_WORD.has(fw) || STOPWORDS.has(fw) || GENERIC_SKILL.has(fw) || COMPANY_MATCH_SKIP.has(list[0].key)) continue;
    if (lowerText.includes(' ' + fw + ' ')) take(list[0], 'exact');
  }
  // glued spelling: "chaipoint" for "Chai Point"
  const qNormToks = toWords(question).split(' ').filter(Boolean);
  for (const tok of qNormToks) {
    if (tok.length < 6) continue;
    const c = pack.companies[tok];
    if (c && !COMPANY_MATCH_SKIP.has(c.key)) take(c, 'exact');
  }

  // Fuzzy only where a name is clearly intended: a bare 1-3 word lookup, or an introduced name.
  const contentToks = tokenize(question);
  const candidates = [];
  const bare = qNormToks.length <= 3;
  const bareSet = new Set();
  if (bare && contentToks.length) [qNormToks.join(' '), ...qNormToks].forEach((x) => { candidates.push(x); bareSet.add(x); });
  let m; INTRO_RE.lastIndex = 0;
  while ((m = INTRO_RE.exec(String(question)))) {
    const raw = m[1].trim();
    const first = raw.split(/\s+/)[0];
    const capitalised = /^[A-Z]/.test(first);
    // lower-case introduced names only count after a strong cue ("called", "talking to")
    const strong = /(called|named|talking to|speaking|pitching|call with|reaching out to|approaching)\s*$/i.test(m[0].slice(0, m[0].length - m[1].length));
    if (!capitalised && !strong) continue;
    candidates.push(raw, first);
  }
  const names = Object.values(pack.companies).filter((c) => !COMPANY_MATCH_SKIP.has(c.key));
  for (const candRaw of uniq(candidates)) {
    const cand = norm(candRaw);
    if (cand.length < 4 || NOT_A_NAME.has(cand) || STOPWORDS.has(cand)) continue;
    if (toWords(candRaw).split(' ').every((w) => STOPWORDS.has(w) || NOT_A_NAME.has(w) || w.length < 3)) continue;
    if ([...seen].some((k) => k.includes(cand) || cand.includes(k))) continue; // already resolved exactly
    let best = null;
    for (const c of names) {
      const firstWord = norm(toWords(c.name).split(' ')[0]);
      let score = 0;
      if (c.key === cand) score = 100;
      else if (firstWord === cand && cand.length >= 4) score = 80;                      // "wissen" -> Wissen Technology
      else if (c.key.startsWith(cand) && cand.length >= 4) score = 70 - (c.key.length - cand.length); // "diage" -> Diageo
      else if (cand.length >= 5) {
        const d = editDistance(cand, c.key, cand.length >= 8 ? 2 : 1);
        if (d <= (cand.length >= 8 ? 2 : 1)) score = 60 - d * 10;
        else if (firstWord.length >= 5) { const d2 = editDistance(cand, firstWord, 1); if (d2 <= 1) score = 50; }
      }
      if (score && (!best || score > best.score || (score === best.score && c.joinees > best.c.joinees))) best = { c, score };
    }
    if (best && !(WEAK_FIRST_WORD.has(cand) || GENERIC_SKILL.has(cand))) { take(best.c, 'fuzzy', candRaw, bareSet.has(candRaw)); continue; }
    // Clients tab: touched but no recorded closure
    const th = pack.touched[cand] || Object.entries(pack.touched).find(([k]) => k.startsWith(cand) && cand.length >= 5);
    if (th) { const t = Array.isArray(th) ? th[1] : th; if (!touchedHits.some((x) => x.name === t.name)) touchedHits.push(t); continue; }
    unknown.push({ name: candRaw, bare: bareSet.has(candRaw) });
  }
  // Clients-tab names typed exactly ("Morgan Stanley")
  for (const [k, t] of Object.entries(pack.touched)) {
    if (pack.companies[k] || k.length < 5) continue;
    const re = phraseRegex(t.name);
    if (re && re.test(lowerText) && !touchedHits.some((x) => x.name === t.name)) touchedHits.push(t);
  }
  // an unknown fragment of something already resolved is not a second prospect
  const resolvedNorm = [...exact.map((c) => c.key), ...fuzzy.map((f) => f.c.key), ...touchedHits.map((t) => norm(t.name))];
  const unknownClean = unknown.filter((u) => !resolvedNorm.some((k) => k.includes(norm(u.name)) || norm(u.name).includes(k)));
  return { exact, fuzzy, touchedHits: touchedHits.slice(0, 4), unknown: unknownClean, contentToks };
}

// ── scope ─────────────────────────────────────────────────────────────────────
const JUNK_INDUSTRIES = new Set(['unknown', 'check', 'test', 'tbd', 'na', 'n/a', '-', '']);
// The query word MEANS a tracked industry: evidence is DIRECT.
const DIRECT_ALIASES = [
  [/\b(bfsi|banks?|banking|financial services|wealth management|asset management|capital markets|hedge funds?|investment banks?|nbfc)\b/i, 'bfsi'],
  [/\b(insurance|insurers?|underwriting|reinsurance)\b/i, 'bfsi'],
  [/\b(pharma|pharmaceuticals?|life sciences|healthcare|health care|health-?tech)\b/i, 'pharma'],
  [/\b(telecom|telecoms|telcos?|telecommunications)\b/i, 'telecom'],
  [/\b(manufacturing|manufacturers?|industrial)\b/i, 'manufactur'],
  [/\b(consulting firms?|consultanc(y|ies)|professional services|big ?4|big four|audit firms?)\b/i, 'consulting'],
  [/\b(aviation|airlines?)\b/i, 'aviation'],
  [/\b(real estate|realty|proptech)\b/i, 'realestate'],
  [/\b(fmcg|retail|retailers?|consumer goods|cpg)\b/i, 'fmcg'],
  [/\b(fmcg|retail|retailers?)\b/i, 'retail'],
  [/\b(media|entertainment|ott|broadcasting|publishing|advertising)\b/i, 'media'],
];
// The query word is a space we do NOT track; the listed industry is the closest parent.
const INDUSTRY_SYNONYMS = [
  ['fintech', 'bfsi'], ['payments', 'bfsi'],
  ['aerospace', 'aviation'], ['defence', 'aviation'], ['defense', 'aviation'], ['airbus', 'aviation'], ['boeing', 'aviation'],
  ['solar', 'manufactur'], ['renewable', 'manufactur'], ['renewables', 'manufactur'], ['cleantech', 'manufactur'], ['clean energy', 'manufactur'],
  ['energy', 'manufactur'], ['battery', 'manufactur'], ['ev', 'manufactur'], ['electric vehicle', 'manufactur'],
  ['automotive', 'manufactur'], ['auto', 'manufactur'], ['packaging', 'manufactur'], ['packing', 'manufactur'], ['logistics', 'manufactur'],
  ['semiconductor', 'manufactur'], ['semiconductors', 'manufactur'], ['chip', 'manufactur'], ['chips', 'manufactur'],
  ['medtech', 'manufactur'], ['medical device', 'manufactur'], ['medical devices', 'manufactur'], ['iot', 'manufactur'], ['wearable', 'manufactur'],
  ['electronics', 'manufactur'], ['hardware', 'manufactur'],
  ['edtech', 'itprod'], ['saas', 'itprod'], ['ecommerce', 'fmcg'], ['e-commerce', 'fmcg'],
  ['legal', 'consulting'], ['law firm', 'consulting'],
];

function deriveScope(question, pack, now) {
  const userText = String(question || '');
  const lowerText = ' ' + toWords(userText) + ' ';
  const aliases = (pack.kb.aliases || []).filter((a) => a.alias && a.maps_to);
  const aliasCompanies = aliases.filter((a) => /^comp/i.test(a.kind || 'company'));
  const aliasIndustries = aliases.filter((a) => /^ind/i.test(a.kind || ''));
  const aliasSkills = aliases.filter((a) => /^skill|^role/i.test(a.kind || ''));

  const res = resolveClients(userText, pack, aliasCompanies);
  let companies = [...res.exact, ...res.fuzzy.filter((f) => !f.bare).map((f) => f.c)].slice(0, 8);
  let fuzzyNotes = res.fuzzy.filter((f) => !f.bare).map((f) => ({ typed: f.term, resolved: f.c.name }));

  // industries
  const negTech = /\bnon[\s-]?(tech|technical|it)\b|\bnot (tech|technical)\b|\boutside (of )?tech\b/i.test(userText);
  const directIndustries = new Set();
  const realIndustries = Object.values(pack.industries).filter((I) => I.name && !JUNK_INDUSTRIES.has(I.name.toLowerCase().trim()));
  const addBySub = (sub, set) => { for (const I of realIndustries) if (norm(I.name).includes(sub)) set.add(I.name); };
  for (const I of realIndustries) {
    const re = phraseRegex(I.name);
    if (re && re.test(lowerText)) directIndustries.add(I.name);
  }
  for (const [re, sub] of DIRECT_ALIASES) if (re.test(userText)) addBySub(sub, directIndustries);
  const itSector = !negTech && (/\bIT\b/.test(userText)
    || /\b(it|i\.t\.?)[\s\-/&]*(sector|industry|space|vertical|prod|product|products|services|service|companies|clients|firms)\b/i.test(userText)
    || /\b(in|for|within|across|just|only)\s+it\b\s*[?.!]*$/i.test(userText.trim())
    || /\b(tech|technology|software|product) (companies|company|firms?|clients?|industry|industries|sector)\b/i.test(userText));
  if (itSector) {
    if (/\bproducts?\b/i.test(userText) && !/\bservices?\b/i.test(userText)) addBySub('itprod', directIndustries);
    else if (/\bservices?\b/i.test(userText) && !/\bproducts?\b/i.test(userText)) addBySub('itserv', directIndustries);
    else { addBySub('itprod', directIndustries); addBySub('itserv', directIndustries); }
  }
  const adjacentIndustries = new Set();
  const adjacencyNotes = [];
  const noteAdj = (term, sub) => {
    const hit = [];
    for (const I of realIndustries) if (norm(I.name).includes(sub) && !directIndustries.has(I.name)) { adjacentIndustries.add(I.name); hit.push(I.name); }
    if (hit.length) adjacencyNotes.push({ term, industries: hit });
  };
  for (const [kw, sub] of INDUSTRY_SYNONYMS) if (new RegExp('\\b' + esc(kw) + 's?\\b', 'i').test(lowerText)) noteAdj(kw, sub);
  for (const a of aliasIndustries) {
    const re = phraseRegex(a.alias); if (!re || !re.test(lowerText)) continue;
    const sub = norm(a.maps_to);
    if (/^adj/i.test(a.relation || '')) noteAdj(a.alias, sub); else addBySub(sub, directIndustries);
  }
  // a matched client is direct evidence; its industry is only surrounding context
  const contextIndustries = new Set();
  companies.forEach((c) => { if (c.industry && !JUNK_INDUSTRIES.has(c.industry.toLowerCase()) && !directIndustries.has(c.industry)) contextIndustries.add(c.industry); });

  const matchedIndustries = uniq([...directIndustries, ...adjacentIndustries]);
  const widened = new Set([...matchedIndustries, ...contextIndustries]);
  [...widened].forEach((ind) => adjacentTo(norm(ind)).forEach((a) => { for (const I of realIndustries) if (norm(I.name).includes(a)) widened.add(I.name); }));

  // skills: synonym groups first, then phrases, then single tokens
  const compNorm = norm(companies.map((c) => c.name).join(' ')) + norm(res.fuzzy.filter((f) => !f.bare).map((f) => f.term).join(' '));
  const indWords = new Set(toWords([...matchedIndustries].join(' ')).split(' '));
  const skills = []; const usedToks = new Set();
  const pushSkill = (s) => { if (s && s.total >= 2 && !skills.some((x) => x.term === s.term)) skills.push(s); };
  if (!negTech) {
    for (const g of SKILL_GROUPS) {
      const hits = [...userText.matchAll(new RegExp(g.trig.source, 'gi'))];
      if (!hits.length) continue;
      if (g.label === 'finance & accounting' && directIndustries.size && /financial services/i.test(userText)) continue;
      pushSkill(skillSearch(g.label, g.src, pack));
      hits.forEach((h) => tokenize(h[0]).forEach((t) => usedToks.add(t)));
    }
    for (const a of aliasSkills) {
      const re = phraseRegex(a.alias);
      if (re && re.test(lowerText)) { pushSkill(skillSearch(a.alias, a.maps_to.split(/[,;|]/).map((x) => esc(x.trim())).filter(Boolean).join('|'), pack)); tokenize(a.alias).forEach((t) => usedToks.add(t)); }
    }
    const isObjection = RE.objection.test(userText);
    const toks = isObjection ? [] : res.contentToks.filter((t) => !usedToks.has(t) && !compNorm.includes(norm(t)) && !indWords.has(t));
    for (let i = 0; i < toks.length - 1; i++) { // adjacent pairs as phrases: "risk analyst", "solution architect"
      const a = toks[i], b = toks[i + 1];
      if (GENERIC_SKILL.has(a) && GENERIC_SKILL.has(b)) continue;
      const s = skillSearch(a + ' ' + b, '\\b' + esc(a) + 's?[^a-z0-9]+' + esc(b) + 's?\\b', pack);
      if (s && s.total >= 2) { pushSkill(s); usedToks.add(a); usedToks.add(b); }
    }
    for (const tok of uniq(toks)) {
      if (usedToks.has(tok) || GENERIC_SKILL.has(tok) || /^\d+$/.test(tok)) continue;
      const one = skillSearch(tok, tokenRegexSrc(tok), pack);
      if (one && one.total >= 3) pushSkill(one); // a lone word needs 3+ hits to count as a skill
    }
  }
  const skillList = skills.slice(0, 4);
  const anyTopic = skillList.length || directIndustries.size || adjacentIndustries.size;
  // a bare 1-3 word query that is clearly a topic ("data scientist roles") is not a fuzzy client lookup
  if (!anyTopic && !companies.length) {
    const bareFuzzy = res.fuzzy.filter((f) => f.bare);
    companies = bareFuzzy.map((f) => f.c).slice(0, 3);
    fuzzyNotes = bareFuzzy.slice(0, 3).map((f) => ({ typed: f.term, resolved: f.c.name }));
    companies.forEach((c) => { if (c.industry && !JUNK_INDUSTRIES.has(c.industry.toLowerCase())) { contextIndustries.add(c.industry); widened.add(c.industry); } });
  }
  const unknownNames = res.unknown.filter((u) => {
    if (u.bare && anyTopic) return false; // "SAP roles", "pharma": a topic, not a company
    const ws = tokenize(u.name);
    return ws.length && !ws.every((w) => usedToks.has(w) || skillList.some((sk) => sk.re.test(w)));
  }).map((u) => u.name).filter((n, i, a) => !a.some((o, j) => j !== i && o.length > n.length && o.toLowerCase().includes(n.toLowerCase())));

  // geography
  const hqs = [];
  for (const hq of Object.keys(pack.byHQ || {})) {
    if (hq === 'Unknown' || JUNK_INDUSTRIES.has(hq.toLowerCase())) continue;
    const toks = toWords(hq).split(' ').filter(Boolean); const joined = toks.join('');
    if (joined.length < 2 || ['us', 'we', 'it', 'in', 'on', 'the'].includes(joined)) continue;
    if (new RegExp('\\b' + toks.map(esc).join('[^a-z0-9]+') + '\\b', 'i').test(lowerText)) hqs.push(hq);
  }
  if (/\b(US|U\.S\.|american)\b/.test(userText) && pack.byHQ.USA && !hqs.includes('USA')) hqs.push('USA');
  const locations = [];
  const LOC_ALIAS = { bengaluru: 'Bangalore', gurugram: 'Gurgaon', bombay: 'Mumbai', madras: 'Chennai', ncr: 'Noida' };
  for (const loc of Object.keys(pack.byLocation || {})) {
    const toks = toWords(loc).split(' ').filter(Boolean);
    if (toks.join('').length < 3) continue;
    if (new RegExp('\\b' + toks.map(esc).join('[^a-z0-9]+') + '\\b', 'i').test(lowerText)) locations.push(loc);
  }
  for (const [k, v] of Object.entries(LOC_ALIAS)) if (new RegExp('\\b' + k + '\\b', 'i').test(lowerText) && pack.byLocation[v] && !locations.includes(v)) locations.push(v);
  const models = [];
  for (const mdl of Object.keys(pack.byModel || {})) { const re = phraseRegex(mdl); if (re && re.test(lowerText)) models.push(mdl); }

  // seniority
  const SENIORITY_KW = [
    [/\b(junior|entry.?level|freshers?|early.?career|campus)\b/i, 'junior'],
    [/\b(mid.?level|mid.?career|intermediate)\b/i, 'mid'],
    [/\b(leadership|cxo|c.?suite|director.?level|vp.?level|executive (search|hiring|roles?))\b/i, 'leadership'],
    [/\bvery.?senior\b/i, 'very_senior'],
    [/\b(senior|sr)\b/i, 'senior'],
  ];
  let seniorityFilter = null;
  for (const [re, level] of SENIORITY_KW) if (re.test(userText)) { seniorityFilter = level; break; }
  const topSeniorIntent = /\b(most senior|senior.?most|highest|top.?level|leadership (roles?|hires?|positions?)|senior (roles?|positions?|hires?)|toughest|hardest|niche|nasty)\b/i.test(userText);

  const ranges = parseRanges(userText, now || new Date());
  const quarterIntent = /\b(q[1-4]|quarter|quarterly|seasonal|seasonality|time of year|busiest)\b/i.test(userText);
  const monthIntent = /\b(which month|monthly|per month|each month|by month|month.?wise|trend)\b/i.test(userText);
  const dropIntent = /\b(offer.?drops?|drop.?outs?|dropped|declined|backed out|no.?shows?|renege|offer.?to.?join|conversion)\b/i.test(userText);
  const listClientsIntent = /\b(list|which|what|all|name)\b[^.?!]*\b(clients?|companies|accounts?|logos)\b/i.test(userText) || /\bname.?drop\b/i.test(userText);

  return {
    companies, fuzzyNotes, touched: res.touchedHits, unknownNames,
    industries: matchedIndustries, directIndustries: [...directIndustries], adjacentIndustries: [...adjacentIndustries],
    contextIndustries: [...contextIndustries], adjacencyNotes, namedIndustries: [...directIndustries], widenedIndustries: [...widened],
    skills: skillList, hqs, models, locations, seniorityFilter, topSeniorIntent, negTech,
    ranges, quarterIntent, monthIntent, dropIntent, listClientsIntent,
  };
}

// True when the question names something concrete of its own. Follow-ups like "roles?"
// or "what experience band" do not, and inherit the previous turn's scope instead.
function hasEntities(scope) {
  return !!(scope.companies.length || scope.industries.length || scope.skills.length || scope.hqs.length ||
    scope.locations.length || scope.touched.length || scope.unknownNames.length || scope.negTech);
}

// ── exact cross-filter ────────────────────────────────────────────────────────
const SENIORITY_TEST = {
  junior: (y) => y < 4, mid: (y) => y >= 4 && y < 8, senior: (y) => y >= 8, very_senior: (y) => y >= 12, leadership: (y) => y >= 15,
};
const SENIORITY_LABEL = { junior: 'Junior (0-4 yrs)', mid: 'Mid (4-8 yrs)', senior: 'Senior+ (8+ yrs)', very_senior: 'Very Senior+ (12+ yrs)', leadership: 'Leadership (15+ yrs)' };

function crossFilter(scope, pack) {
  const ckSet = scope.companies.length ? new Set(scope.companies.map((c) => c.key)) : null;
  const indList = scope.directIndustries.length ? scope.directIndustries : scope.adjacentIndustries;
  const indSet = !ckSet && indList.length ? new Set(indList) : null;
  const locSet = scope.locations.length ? new Set(scope.locations) : null;
  const hqSet = scope.hqs.length ? new Set(scope.hqs) : null;
  const sen = scope.seniorityFilter && (!scope.skills.length || scope.topSeniorIntent) ? SENIORITY_TEST[scope.seniorityFilter] : null;
  const baseDims = [];
  if (ckSet) baseDims.push('client = ' + scope.companies.map((c) => c.name).join(' or '));
  if (indSet) baseDims.push('industry = ' + indList.join(' or ') + (scope.directIndustries.length ? '' : ' (ADJACENT industry, not the exact space asked about)'));
  if (locSet) baseDims.push('joining location = ' + scope.locations.join(' or '));
  if (hqSet) baseDims.push('client HQ = ' + scope.hqs.join(' or '));
  if (sen) baseDims.push('experience = ' + SENIORITY_LABEL[scope.seniorityFilter] + ' (only rows that carry years of experience)');
  if (scope.negTech) baseDims.push('function = NON-TECH (heuristic function families)');

  const base = (r) => {
    const c = pack.companies[r.ck];
    if (ckSet && !ckSet.has(r.ck)) return false;
    if (indSet && !(c && indSet.has(c.industry))) return false;
    if (locSet && !locSet.has(r.loc)) return false;
    if (hqSet && !(c && hqSet.has(c.hq))) return false;
    if (sen && !(r.yoe !== null && sen(r.yoe))) return false;
    if (scope.negTech && (TECH_FAMILIES.has(r.fam) || r.fam === UNCLASSIFIED)) return false;
    return true;
  };
  const skillOpts = scope.skills.length ? scope.skills.slice(0, 3) : [null];
  const rangeOpts = scope.ranges.length ? scope.ranges.slice(0, 2) : [null];
  const results = [];
  for (const sk of skillOpts) for (const rg of rangeOpts) {
    const dims = baseDims.slice();
    if (sk) dims.push(`role/skill matches "${sk.term}"`);
    if (rg) dims.push('joined in ' + rg.label);
    if (dims.length < 2 && !rg && !scope.negTech && !sen) continue; // a single dimension already has its own block
    const list = pack.rows.filter((r) => base(r) && (!sk || (r.combo && sk.re.test(r.combo))) && (!rg || (r.ym && r.ym >= rg.from && r.ym <= rg.to)));
    let dropN = null;
    if (rg) dropN = pack.drops.filter((d) => { const c = pack.companies[d.ck]; return d.ym && d.ym >= rg.from && d.ym <= rg.to && (!ckSet || ckSet.has(d.ck)) && (!indSet || (c && indSet.has(c.industry))) && (!sk || sk.re.test(d.combo)); }).length;
    results.push({ dims, sum: summarise(list, pack), range: rg, skill: sk, dropN, list });
  }
  return results;
}

function crossBlock(res, scope, pack) {
  const s = res.sum; const L = [];
  L.push(`### FILTER: ${res.dims.join(' AND ')}`);
  let head = `RESULT: ${s.n} joinees (closures)`;
  if (res.dropN !== null && !scope.seniorityFilter && !scope.locations.length && !scope.negTech) head += `, ${res.dropN} offer drops`;
  L.push(head + '.' + (s.n === 0 ? ' This is a real zero for this exact filter, not missing data.' : ''));
  if (!s.n) return L.join('\n');
  const nClients = Object.keys(s.byClient).length;
  const cap = scope.listClientsIntent || res.range ? 60 : 15;
  if (nClients > 1 || !scope.companies.length) {
    const ents = topEntries(s.byClient, cap).map(([k, v]) => res.range ? `${k} (${v}, last join ${s.lastByClient[k]})` : `${k} (${v})`);
    L.push(`Clients (${nClients}${nClients > cap ? ', top ' + cap + ' shown' : ', complete list'}): ` + ents.join('; '));
  }
  L.push('Designations closed: ' + listTop(s.byDesig, 14));
  if (Object.keys(s.byRole).length) L.push('Functions / business units: ' + listTop(s.byRole, 10));
  if (Object.keys(s.byInd).length > 1) L.push('By industry: ' + listTop(s.byInd, 8));
  if (scope.negTech || Object.keys(s.byFam).length > 1) L.push('By function family (heuristic): ' + listTop(s.byFam, 8));
  if (scope.negTech) L.push(`Not counted either way: ${pack.rows.filter((r) => r.fam === UNCLASSIFIED).length} joinees whose row has only a grade title (Senior Consultant, Manager, Analyst). Call the non-tech number a floor, not a total.`);
  const bands = EXP_BAND_ORDER.map((b) => [b, s.byBand[b] || 0]).filter(([, n]) => n > 0);
  if (bands.length) L.push('By experience band: ' + bands.map(([b, n]) => `${b}: ${n}`).join('; '));
  if (s.yoe) L.push(`Years of experience: avg ${s.yoe.avg}, range ${s.yoe.min}-${s.yoe.max} (${s.yoe.n} of ${s.n} rows carry YOE)`);
  const yms = Object.keys(s.byYm).sort();
  if (res.range && yms.length && yms.length <= 24) L.push('By month: ' + yms.map((k) => `${monthLabel(k)}: ${s.byYm[k]}`).join('; '));
  else if (s.first) L.push(`Window: ${s.first} to ${s.last}`);
  if (scope.topSeniorIntent) {
    const top = res.list.filter((r) => r.yoe !== null && r.desig).sort((a, b) => b.yoe - a.yoe).slice(0, 12)
      .map((r) => `${r.desig}${r.role ? ' / ' + r.role : ''} at ${pack.companies[r.ck].name} (${r.yoe} yrs)`);
    if (top.length) L.push('Most senior closures by years of experience: ' + top.join('; '));
  }
  return L.join('\n');
}

// ── context blocks ────────────────────────────────────────────────────────────
function bandLines(byExpBand) {
  const out = [];
  const bands = EXP_BAND_ORDER.map((b) => [b, byExpBand[b] || 0]).filter(([, n]) => n > 0);
  if (bands.length) {
    out.push('By experience band: ' + bands.map(([b, n]) => `${b}: ${n}`).join('; '));
    const sp = (byExpBand['Senior (8-12 yrs)'] || 0) + (byExpBand['Very Senior (12-15 yrs)'] || 0) + (byExpBand['Leadership (15+ yrs)'] || 0);
    if (sp > 0) out.push(`Senior+ (8+ yrs experience): ${sp} joinees`);
  }
  return out;
}
function companyBlock(c) {
  const L = [`### ${c.name}`];
  L.push(`Industry: ${c.industry || 'Unknown'} | HQ: ${c.hq || 'Unknown'} | Joinees (closures): ${c.joinees} | Offer drops: ${c.drops}`);
  if (!c.joinees) L.push('NOTE: no joinee on record for this client. It appears only through offers that did not convert. Do not present it as a delivered client.');
  if (c.firstJoin || c.lastJoin) L.push(`Activity window: first join ${c.firstJoin || '?'}, most recent join ${c.lastJoin || '?'}`);
  if (c.engagement && c.engagement.model) L.push(`Engagement model: ${c.engagement.model}`);
  if (Object.keys(c.byDesig).length) L.push('Top designations (exact counts): ' + listTop(c.byDesig, 12));
  if (Object.keys(c.byRole).length) L.push('Top functions / business units (exact counts): ' + listTop(c.byRole, 10));
  if (Object.keys(c.byFamily).length > 1) L.push('By function family (heuristic): ' + listTop(c.byFamily, 6));
  L.push(...bandLines(c.byExpBand));
  if (c.exp.count) L.push(`Years of experience closed: avg ${(c.exp.sum / c.exp.count).toFixed(1)}, range ${c.exp.min}-${c.exp.max} (${c.exp.count} rows with data)`);
  const cq = QUARTER_ORDER.map((q) => [q, c.byQuarter[q] || 0]).filter(([, n]) => n > 0);
  if (cq.length) L.push('By quarter (all years combined): ' + cq.map(([q, n]) => `${q}: ${n}`).join('; '));
  if (Object.keys(c.byLocation).length) L.push('Joining locations: ' + listTop(c.byLocation, 6));
  return L.join('\n');
}
function industryBlock(I, tag) {
  const L = [`### Industry: ${I.name}${tag ? ' [' + tag + ']' : ''}`];
  L.push(`Clients: ${I.companies} | Joinees: ${I.joinees} | Offer drops: ${I.drops}`);
  L.push(...bandLines(I.byExpBand));
  if (Object.keys(I.byFamily).length) L.push('By function family (heuristic): ' + listTop(I.byFamily, 7));
  const iq = QUARTER_ORDER.map((q) => [q, I.byQuarter[q] || 0]).filter(([, n]) => n > 0);
  if (iq.length) { const pk = iq.slice().sort((a, b) => b[1] - a[1])[0]; L.push('By quarter (all years combined): ' + iq.map(([q, n]) => `${q}: ${n}`).join('; ') + ` | peak: ${pk[0]} (${pk[1]})`); }
  if (I.topCompanies.length) L.push('Clients by closures: ' + I.topCompanies.slice(0, 20).map((c) => `${c.name} (${c.joinees})`).join('; '));
  return L.join('\n');
}
function matchIndustryLoose(rowIndustry, scopeIndustries) {
  const ri = norm(rowIndustry);
  if (!ri) return false;
  return scopeIndustries.some((s) => { const sk = norm(s); return sk.includes(ri) || ri.includes(sk); });
}

// ── intent ────────────────────────────────────────────────────────────────────
const QUERY_TYPES = ['Company lookup', 'Skill/Role', 'Industry', 'Geography', 'Time/Trend', 'Objection handling', 'Pricing', 'ICP/Targeting', 'Meeting prep', 'Case study', 'Other'];
const RE = {
  objection: /\b(they|client|prospect|he|she)\b[^.?!]{0,40}\b(said|says|say|saying|thinks?|told|claims?|feels?|asked|wants?|keeps?|don'?t|doesn'?t|won'?t|only)\b|\b(too expensive|pricing is high|already have (enough )?(vendors|partners)|enough (recruitment )?partners|strong internal team|no requirements?|not hiring|send (me )?an? email|not interested|no budget|empanel\w*|five minutes|no gaps|don'?t work with (vendors|partners|agencies)|objection|push ?back)\b/i,
  pricing: /\b(commercials?|fees?|pricing|price|rates?|commission|charges?|cost|margin|discount|percentage|expensive|replacement|payment terms|retention clause)\b/i,
  icp: /\b(icp|qualif\w+|who (should|do) (i|we) (target|approach|contact|reach)|ideal (client|customer)|right (person|contact|title)|decision.?maker|which title|should (i|we) (target|pursue|go after)|is .{2,40} a (good )?fit|sweet spot|disqualif\w+)\b/i,
  meeting: /\b(meeting|tomorrow|prep(are|aration)?|research|agenda|first call|cold call|reaching out|reach out|pitch(ing)?|approach|talking to|speaking (to|with)|on (a )?call|open(ing)? line|ice.?breaker|what (can|should|do) i (say|talk|ask|keep)|how (do|should) i)\b/i,
  followup: /\b(follow.?up|nurtur\w+|ghost(ed|ing)?|stay (warm|relevant|in touch)|keep (it )?warm|went quiet|gone quiet|dormant|reactivat\w+|re-?engage|sour(ed)?|at.?risk)\b/i,
  casestudy: /\b(case stud(y|ies)|stor(y|ies)|example of|proof point|narrat\w+)\b/i,
  capability: /^\s*(hi|hello|hey|help|what (all )?can you (do|help)|what do you do|who are you)\b/i,
};
function classify(question, scope) {
  const q = String(question || '');
  if (RE.objection.test(q)) return 'Objection handling';
  if (RE.icp.test(q)) return 'ICP/Targeting';
  if (RE.pricing.test(q)) return 'Pricing';
  if (RE.casestudy.test(q)) return 'Case study';
  if (RE.meeting.test(q) || RE.followup.test(q)) return 'Meeting prep';
  if (scope.ranges.length || scope.quarterIntent || scope.monthIntent) return 'Time/Trend';
  if (scope.companies.length || scope.touched.length || scope.unknownNames.length) return 'Company lookup';
  if (scope.skills.length || scope.topSeniorIntent || scope.negTech) return 'Skill/Role';
  if (scope.industries.length) return 'Industry';
  if (scope.hqs.length || scope.locations.length) return 'Geography';
  return 'Other';
}

// relevance score of a KB row against the question
function kbScore(text, qToks) {
  const hay = ' ' + toWords(text) + ' ';
  let s = 0;
  for (const t of qToks) if (t.length >= 3 && hay.includes(' ' + t)) s += 2;
  return s;
}

// ── context assembly ──────────────────────────────────────────────────────────
// prevQuestion: the previous user turn. Used only when the current question names nothing itself.
function assembleContext(question, pack, opts = {}) {
  const now = opts.now || new Date();
  let scope = deriveScope(question, pack, now);
  let inherited = false;
  // Inherit the previous turn's scope only for a real follow-up: short or anaphoric
  // ("roles?", "what about their drops?"), and not a fresh advice question.
  const wordCount = toWords(question).split(' ').filter(Boolean).length;
  const anaphora = /\b(they|them|their|those|these|that client|that company|same|it|its|there|what about|how about|and what|also)\b/i.test(question);
  const freshAdvice = RE.objection.test(question) || RE.icp.test(question) || RE.pricing.test(question) || RE.capability.test(question);
  if (!hasEntities(scope) && opts.prevQuestion && !freshAdvice && (wordCount <= 7 || anaphora)) {
    const prev = deriveScope(opts.prevQuestion, pack, now);
    if (hasEntities(prev)) {
      const keep = { ranges: scope.ranges.length ? scope.ranges : prev.ranges, seniorityFilter: scope.seniorityFilter || prev.seniorityFilter,
        topSeniorIntent: scope.topSeniorIntent, quarterIntent: scope.quarterIntent, monthIntent: scope.monthIntent, dropIntent: scope.dropIntent, listClientsIntent: scope.listClientsIntent || prev.listClientsIntent };
      scope = Object.assign({}, prev, keep); inherited = true;
    }
  }
  const type = classify(question, scope);
  const qToks = uniq(tokenize(question));
  const parts = [];          // CLIENT-SAFE facts
  const technique = [];      // how to handle it: playbook + coaching (shapes wording, is not a fact source)
  const internalParts = [];  // INTERNAL ONLY
  const sources = [];        // code-computed list of what was actually put in front of the model
  const facts = [];          // deterministic fact cards for the UI
  const addSource = (s) => { if (s && !sources.includes(s)) sources.push(s); };

  // 0) approved guidance from the Coaching tab: beats everything else
  const coaching = (pack.kb.coaching || []).filter((r) => !/^(no|false|0|off)$/i.test(r.active || '') && (r.triggers || '').split(/[,;|\n]/).map((x) => x.trim()).filter(Boolean)
    .some((trg) => { const re = phraseRegex(trg); return re && re.test(' ' + toWords(question) + ' '); }));
  if (coaching.length) {
    technique.push('## APPROVED GUIDANCE (written by Peepal BD leadership for this exact situation. Follow it over your own judgement.)\n' +
      coaching.slice(0, 4).map((r) => `- ${r.id ? '[' + r.id + '] ' : ''}${r.guidance || ''}${r.say_line ? ' | APPROVED LINE TO SAY: "' + r.say_line + '"' : ''}`).join('\n'));
    coaching.slice(0, 4).forEach((r) => addSource(r.id || 'Coaching'));
  }

  // 1) the exact answer, computed
  const cross = crossFilter(scope, pack);
  if (cross.length) {
    parts.push('## EXACT ANSWER (computed from the tracker rows for precisely this question. Quote these numbers; do not recompute.)\n' +
      cross.map((r) => crossBlock(r, scope, pack)).join('\n\n') +
      `\nTracker coverage: latest joinee on record ${pack.coverage.lastJoin || '?'}, latest offer drop ${pack.coverage.lastOffer || '?'}. Anything after that is not in the data yet.`);
    const c0 = cross[0];
    facts.push({ label: c0.range ? c0.range.label.replace(/\s*\(.*$/, '') : (scope.directIndustries.length || scope.companies.length || !scope.adjacentIndustries.length ? 'Exact match' : 'Closest match (adjacent)'), value: c0.sum.n + ' closures', sub: c0.dims.join(' + ').slice(0, 110) });
    cross.forEach((r) => topEntries(r.sum.byClient, 5).forEach(([k]) => addSource(k)));
  }

  // 2) evidence directness
  const realClients = scope.companies.filter((c) => c.joinees > 0);
  const strongSkill = scope.skills.some((s) => s.total >= 5);
  const crossHit = cross.some((r) => r.sum.n > 0);
  const crossAllZero = cross.length > 0 && !crossHit;
  let evidence = 'absent';
  const hasDirect = realClients.length || scope.directIndustries.length;
  if (crossAllZero) evidence = (hasDirect && scope.ranges.length && !scope.skills.length) ? 'direct' : (hasDirect || scope.adjacentIndustries.length || scope.skills.length) ? 'adjacent' : 'absent';
  else if (realClients.length || scope.directIndustries.length || (strongSkill && !scope.adjacencyNotes.length) || (crossHit && !scope.adjacencyNotes.length)) evidence = 'direct';
  else if (scope.adjacencyNotes.length || scope.skills.length || scope.touched.length || scope.companies.length || crossHit) evidence = 'adjacent';
  if (scope.adjacencyNotes.length && !realClients.length && !scope.directIndustries.length) evidence = 'adjacent';
  if (scope.unknownNames.length && !realClients.length && evidence === 'direct' && !scope.directIndustries.length && !strongSkill) evidence = 'adjacent';
  {
    const bits = [];
    if (inherited) bits.push('FOLLOW-UP: the question names nothing itself, so the scope below is carried over from the previous question.');
    if (realClients.length) bits.push('DIRECT: named client(s) with closures on record: ' + realClients.map((c) => `${c.name} (${c.joinees})`).join(', ') + '.');
    scope.fuzzyNotes.forEach((f) => bits.push(`NAME MATCH: the rep typed "${f.typed}"; closest tracked client is "${f.resolved}". Answer for ${f.resolved} and say that is the client you read it as.`));
    scope.companies.filter((c) => !c.joinees).forEach((c) => bits.push(`OFFERS ONLY: ${c.name} has ${c.drops} offer(s) that did not convert and zero joinees. Not a delivered client.`));
    scope.touched.forEach((t) => bits.push(`CLIENTS TAB ONLY: "${t.name}" is listed in the Clients tab (${t.sheet} / ${t.subsector}) but has no joinee or offer in the tracker. You may say Peepal has worked in that company's space; do not quote closures for it.`));
    scope.unknownNames.forEach((n) => bits.push(`NOT IN THE DATA: "${n}" does not appear anywhere in the tracker or the Clients tab. Treat it as a new prospect. Never imply past work with it. Pivot to the nearest real proof and a discovery question.`));
    if (scope.directIndustries.length) bits.push('DIRECT: industry tracked by name: ' + scope.directIndustries.join(', ') + '.');
    scope.adjacencyNotes.forEach((n) => bits.push(`ADJACENT: "${n.term}" is not a space the tracker has. The nearest tracked industry is ${n.industries.join(' / ')}. Anything from ${n.industries.join(' / ')} is adjacent proof for "${n.term}", never direct.`));
    if (scope.skills.length) bits.push('ROLE/SKILL evidence: ' + scope.skills.map((s) => `${s.term} (${s.total})`).join(', ') + '. These counts span all industries unless the EXACT ANSWER block narrows them.');
    if (scope.negTech) bits.push('NON-TECH ask: use the function-family split. "Tech" and "non-tech" are a heuristic grouping of designations, so call the number approximate.');
    if (evidence === 'absent') bits.push('Nothing in the data matches this question. Say so plainly and move to a discovery question. Do not stretch unrelated numbers.');
    parts.push(`## EVIDENCE DIRECTNESS (read first)\nOVERALL: ${evidence.toUpperCase()}\n` + bits.join('\n'));
  }

  // 3) always-on totals (counts only; billing lives in the internal bin)
  const fyAll = Object.keys(pack.byFY || {}).sort();
  parts.push('## FIRM-WIDE TOTALS (exact)\n' +
    `Clients with at least one joinee: ${pack.totals.clientsWithJoinees} | Joinees (closures): ${pack.totals.joinees} | Offer drops: ${pack.totals.drops}\n` +
    'By financial year (Apr-Mar): ' + fyAll.slice(-8).map((fy) => `${fy}: ${pack.byFY[fy].joinees} joinees, ${pack.byFY[fy].drops} drops`).join(' | '));

  // 4) scoped clients, industries, skills
  if (scope.companies.length) {
    parts.push('## MATCHED CLIENTS (exact numbers)\n' + scope.companies.map(companyBlock).join('\n\n'));
    scope.companies.forEach((c) => addSource(c.name));
    const c = scope.companies[0];
    facts.push({ label: c.name, value: c.joinees + ' closures', sub: c.lastJoin ? `${c.firstJoin.slice(0, 4)} to ${c.lastJoin.slice(0, 7)}${c.drops ? ' · ' + c.drops + ' offer drops' : ''}` : (c.drops + ' offers, none joined') });
    const tr = topEntries(Object.keys(c.byRole).length ? c.byRole : c.byDesig, 3).map(([k]) => k).join(', ');
    if (tr) facts.push({ label: 'Top roles', value: tr, sub: c.exp.count ? `avg ${(c.exp.sum / c.exp.count).toFixed(1)} yrs experience` : '' });
  }
  if (scope.industries.length) {
    const blocks = scope.industries.map((n) => pack.industries[n]).filter(Boolean)
      .map((I) => industryBlock(I, scope.directIndustries.includes(I.name) ? 'DIRECT' : 'ADJACENT to the ask'));
    if (blocks.length) parts.push('## MATCHED INDUSTRIES (exact numbers)\n' + blocks.join('\n\n'));
    scope.industries.forEach((n) => {
      const I = pack.industries[n]; if (!I) return;
      addSource(n + ' industry');
      if (facts.length < 5) facts.push({ label: n + (scope.directIndustries.includes(n) ? '' : ' (adjacent)'), value: I.joinees + ' closures', sub: `${I.companies} clients · top: ${I.topCompanies.slice(0, 3).map((c) => c.name).join(', ')}` });
    });
  }
  if (scope.skills.length) {
    const blocks = scope.skills.map((s) => {
      const u = s.sum; const L = [`### "${s.term}": ${s.total} closures (joinees whose designation or business unit matches)`];
      L.push('Clients: ' + listTop(u.byClient, 15));
      L.push('Actual designations: ' + listTop(u.byDesig, 12));
      L.push('By industry: ' + listTop(u.byInd, 6));
      if (u.yoe) L.push(`Years of experience: avg ${u.yoe.avg}, range ${u.yoe.min}-${u.yoe.max} (${u.yoe.n} rows with data)`);
      L.push(...bandLines(u.byBand));
      return L.join('\n');
    });
    parts.push('## SKILL / ROLE MATCHES (exact, all industries and all years)\n' + blocks.join('\n\n'));
    scope.skills.forEach((s) => {
      addSource(`"${s.term}" roles`);
      if (facts.length < 5) facts.push({ label: s.term, value: s.total + ' closures', sub: 'top: ' + topEntries(s.sum.byClient, 3).map(([k, v]) => `${k} ${v}`).join(', ') });
    });
  }
  if (scope.topSeniorIntent && !cross.length) {
    const pool = pack.rows.filter((r) => r.yoe !== null && r.desig).sort((a, b) => b.yoe - a.yoe).slice(0, 15)
      .map((r) => `${r.desig}${r.role ? ' / ' + r.role : ''} at ${pack.companies[r.ck].name} (${r.yoe} yrs)`);
    parts.push('## MOST SENIOR CLOSURES, FIRM-WIDE (by years of experience, exact)\n' + pool.join('; '));
    addSource('Senior closures');
  }
  if (scope.hqs.length) {
    parts.push('## CLIENT HQ GEOGRAPHY (exact)\n' + scope.hqs.map((hq) => {
      const H = pack.byHQ[hq];
      const tops = Object.values(pack.companies).filter((c) => (c.hq || 'Unknown') === hq && c.joinees).sort((a, b) => b.joinees - a.joinees).slice(0, 20).map((c) => `${c.name} (${c.joinees})`).join('; ');
      return `### ${hq}\nClients: ${H.companies} | Joinees: ${H.joinees} | Offer drops: ${H.drops}\nClients by closures: ${tops}`;
    }).join('\n\n'));
    scope.hqs.forEach((h) => addSource(h + ' HQ clients'));
  }
  if (scope.locations.length) {
    parts.push('## JOINING LOCATION (India city where candidates joined, exact)\n' + scope.locations.map((loc) => {
      const L = pack.byLocation[loc];
      const tops = Object.values(pack.companies).filter((c) => c.byLocation[loc]).sort((a, b) => b.byLocation[loc] - a.byLocation[loc]).slice(0, 15).map((c) => `${c.name} (${c.byLocation[loc]})`).join('; ');
      return `### ${loc}\nJoinees hired into this location: ${L.joinees} across ${L.companies} clients\nClients: ${tops}`;
    }).join('\n\n'));
    scope.locations.forEach((l) => addSource(l + ' hires'));
  }
  if (scope.models.length) {
    parts.push('## ENGAGEMENT MODEL (exact)\n' + scope.models.map((mdl) => `### ${mdl}\nClients (${pack.byModel[mdl].length}): ${pack.byModel[mdl].slice(0, 50).join(', ')}`).join('\n\n'));
  }
  if (scope.negTech && !cross.length) {
    const fam = {}; pack.rows.forEach((r) => { fam[r.fam] = (fam[r.fam] || 0) + 1; });
    parts.push('## FUNCTION FAMILY SPLIT, FIRM-WIDE (heuristic grouping of designation + business unit)\n' + listTop(fam, 12));
  }

  // 5) seasonality and monthly trend
  if (scope.quarterIntent) {
    const qRows = QUARTER_ORDER.map((q) => [q, pack.byQuarter[q]]).filter(([, Q]) => Q && Q.joinees);
    if (qRows.length) {
      const peak = qRows.slice().sort((a, b) => b[1].joinees - a[1].joinees)[0];
      const keys = Object.keys(pack.byFYQ).sort().slice(-16);
      parts.push('## SEASONALITY (exact; Indian FY quarters, all years combined)\n' + qRows.map(([q, Q]) => `${q}: ${Q.joinees} joinees, ${Q.drops} drops`).join('\n') +
        `\nPeak quarter firm-wide: ${peak[0]} (${peak[1].joinees}).\nLast 16 FY quarters: ` + keys.map((k) => `${k}: ${pack.byFYQ[k].joinees}`).join(' | ') +
        '\nPer-industry and per-client quarter splits are inside their own blocks above.');
      addSource('Quarterly totals');
    }
  }
  if (scope.monthIntent && !scope.ranges.length) {
    const keys = Object.keys(pack.byMonth).sort().slice(-24);
    const scopedInd = scope.industries.map((n) => pack.industries[n]).filter(Boolean).slice(0, 2);
    parts.push('## BY MONTH (exact, last 24 months with data)\n' + keys.map((mk) => {
      const F = pack.byMonth[mk]; const extra = scopedInd.map((I) => `${I.name} ${I.byMonth[mk] || 0}`).join(', ');
      return `${monthLabel(mk)}: ${F.joinees} joinees, ${F.drops} drops${extra ? ' | ' + extra : ''}`;
    }).join('\n'));
    addSource('Monthly totals');
  }

  // 6) nothing specific matched: compact industry summary so general questions still work
  const nothingScoped = !scope.companies.length && !scope.industries.length && !scope.skills.length && !scope.hqs.length && !scope.locations.length && !cross.length;
  if (nothingScoped) {
    const rws = Object.values(pack.industries).filter((I) => !JUNK_INDUSTRIES.has(I.name.toLowerCase())).sort((a, b) => b.joinees - a.joinees)
      .map((I) => `${I.name}: ${I.companies} clients, ${I.joinees} joinees | top clients: ${I.topCompanies.slice(0, 6).map((c) => `${c.name} (${c.joinees})`).join(', ')}`);
    parts.push('## INDUSTRY SUMMARY (exact)\n' + rws.join('\n'));
    if (!facts.length) facts.push({ label: 'Firm-wide', value: pack.totals.joinees.toLocaleString('en-IN') + ' closures', sub: pack.totals.clientsWithJoinees + ' clients since 2004' });
  }

  // 7) Clients tab for scoped industries
  if (scope.industries.length) {
    const cwBlocks = [];
    for (const [sheetName, subs] of Object.entries(pack.clientsWorked)) {
      if (!matchIndustryLoose(sheetName, scope.industries)) continue;
      cwBlocks.push(`### ${sheetName}\n` + subs.map((s) => {
        const comp = s.companies.length ? `  Companies: ${s.companies.slice(0, 25).join(', ')}` : '';
        const cap = s.capabilities.length ? `  Roles we can fill: ${s.capabilities.slice(0, 25).join(', ')}` : '';
        return `${s.subsector}:\n${[comp, cap].filter(Boolean).join('\n')}`;
      }).join('\n'));
    }
    if (cwBlocks.length) parts.push('## CLIENTS TAB (companies engaged in each subsector and roles we can fill. Engaged does not mean closed: only the tracker blocks above prove closures.)\n' + cwBlocks.join('\n\n'));
  }

  // 8) stories
  const src = pack.kb.sources || [];
  const isAdvice = ['Objection handling', 'Meeting prep', 'ICP/Targeting', 'Pricing', 'Case study'].includes(type) || nothingScoped;
  const scopedClientsNorm = new Set(scope.companies.map((c) => c.key));
  const scoredStories = src.map((s) => {
    let sc = kbScore((s.bd_usage || '') + ' ' + (s.tags || '') + ' ' + (s.problem || ''), qToks);
    if (s.client && scopedClientsNorm.has(norm(s.client))) sc += 10;
    if (s.industry && matchIndustryLoose(s.industry, scope.widenedIndustries)) sc += 4;
    if (type === 'Objection handling' && /objection/i.test(s.tags || '')) sc += 3;
    return { s, sc };
  }).filter((x) => x.sc >= 4).sort((a, b) => b.sc - a.sc).slice(0, isAdvice ? 4 : 3).map((x) => x.s);
  if (src.length) parts.push('## STORY INDEX (one line each; the full text of the best matches follows)\n' + src.map((s) => `${s.source_id} [${s.type}] ${s.client || s.industry || 'general'}: ${s.bd_usage}`).join('\n'));
  if (scoredStories.length) {
    parts.push('## RELEVANT STORIES (client-safe wording)\n' + scoredStories.map((s) =>
      `### ${s.source_id} - ${s.client || s.industry || 'general'} [${s.type}]\nProblem: ${s.problem}\nWhat Peepal did: ${s.intervention}\n` +
      (s.result_client_safe ? `Client-safe result (say it this way): ${s.result_client_safe}\n` : 'No client-safe result: this is a technique, not delivered work. Never present it as a Peepal case.\n') +
      `When to use: ${s.bd_usage}`).join('\n\n'));
    const withInternal = scoredStories.filter((s) => s.result_internal);
    if (withInternal.length) internalParts.push('## CASE METRICS (internal)\n' + withInternal.map((s) => `### ${s.source_id} - ${s.client || s.industry || 'general'}\n${s.result_internal}`).join('\n'));
    scoredStories.forEach((s) => addSource(s.source_id));
  }

  // 9) doctrine: ranked, not dumped
  const doc = pack.kb.doctrine || [];
  const catBoost = {};
  const boost = (cats, n) => cats.forEach((c) => { catBoost[c] = Math.max(catBoost[c] || 0, n); });
  if (type === 'Pricing' || RE.pricing.test(question)) boost(['commercials'], 8);
  if (type === 'ICP/Targeting') boost(['icp_firmographic', 'excluded_industry', 'sweet_spot', 'stage', 'converting', 'not_converting', 'sub_icp', 'contact', 'timing', 'key_designations'], 6);
  if (type === 'Meeting prep') boost(['service_fit', 'positioning', 'contact', 'stage'], 3);
  if (type === 'Objection handling') boost(['service_fit', 'service_line', 'positioning'], 3);
  if (RE.capability.test(question) || nothingScoped) boost(['company', 'positioning', 'peepal_way', 'service_line'], 5);
  boost(['positioning', 'service_line'], 1);
  const docRows = doc.map((d) => {
    let sc = kbScore([d.item, d.detail, d.tags, d.examples].join(' '), qToks) + (catBoost[d.category] || 0);
    if (d.examples && scope.companies.some((c) => norm(d.examples).includes(c.key))) sc += 6;
    return { d, sc };
  }).filter((x) => x.sc >= 3).sort((a, b) => b.sc - a.sc).slice(0, 16).map((x) => x.d);
  const docLine = (d) => `- [${d.id || d.category}] ${d.item}${d.detail ? ': ' + d.detail : ''}${d.examples ? ' | e.g. ' + d.examples : ''}${d.action ? ' | ACTION: ' + d.action : ''}`;
  const docSafe = docRows.filter((d) => d.audience !== 'internal');
  const docInt = docRows.filter((d) => d.audience === 'internal');
  if (docSafe.length) parts.push('## PEEPAL DOCTRINE (company facts, services, positioning: client-safe)\n' + docSafe.map(docLine).join('\n'));
  if (docInt.length) internalParts.push('## INTERNAL DOCTRINE (fees, targeting rules, skip lists)\n' + docInt.map(docLine).join('\n'));
  docRows.slice(0, 4).forEach((d) => { if (d.id) addSource(d.id); });

  // 10) playbook: ranked technique rows
  if (isAdvice) {
    const pb = pack.kb.playbook || [];
    const pBoost = {};
    const pb2 = (cats, n) => cats.forEach((c) => { pBoost[c] = Math.max(pBoost[c] || 0, n); });
    if (type === 'Meeting prep') { pb2(['research', 'first_call', 'discovery'], 3); if (/\b(meeting|tomorrow|agenda)\b/i.test(question)) pb2(['meeting_prep', 'meeting_run'], 4); }
    if (RE.followup.test(question)) pb2(['followup', 'reactivation', 'at_risk'], 5);
    if (type === 'Case study') pb2(['mindset', 'meeting_run'], 2);
    if (/\b(review|qbr|numbers|data|dashboard)\b/i.test(question)) pb2(['data_usage'], 4);
    const rowsP = pb.map((p) => {
      let sc = kbScore([p.item, p.detail, p.tags, p.action].join(' '), qToks) + (pBoost[p.category] || 0);
      if (type === 'Objection handling' && /objection/i.test(p.tags || '')) sc += 3 + kbScore(p.item, qToks) * 2;
      if (type === 'Objection handling' && /mirroring|next-step/i.test(p.tags || '')) sc += 4;
      return { p, sc };
    }).filter((x) => x.sc >= 4).sort((a, b) => b.sc - a.sc).slice(0, 10).map((x) => x.p);
    if (rowsP.length) {
      technique.push('## PLAYBOOK (Peepal technique for this situation. Sample language here may be adapted into SAY. Market intel and internal notes in it are for the rep only.)\n' +
        rowsP.map((p) => `- [${p.id || p.category}] ${p.item}${p.detail ? ': ' + p.detail : ''}${p.action ? ' | DO: ' + p.action : ''}`).join('\n'));
      rowsP.slice(0, 3).forEach((p) => { if (p.id) addSource(p.id); });
    }
  }

  // 11) internal-only numbers: billing and sourcing
  {
    const L = [`Firm-wide billing on record: ${fmtRs(pack.totals.revenue)}. By FY: ` + fyAll.slice(-6).map((fy) => `${fy} ${fmtRs(pack.byFY[fy].revenue)}`).join(' | ')];
    scope.companies.forEach((c) => {
      L.push(`${c.name}: billing ${fmtRs(c.revenue)}${c.joinees ? ', avg ' + fmtRs(c.revenue / c.joinees) + ' per joinee' : ''}` + (Object.keys(c.byPrev).length ? ` | joinees came from: ${listTop(c.byPrev, 6)}` : ''));
    });
    scope.industries.forEach((n) => { const I = pack.industries[n]; if (I) L.push(`${n}: billing ${fmtRs(I.revenue)}`); });
    cross.forEach((r) => { if (r.sum.n) L.push(`Filter [${r.dims.join(' AND ')}]: billing ${fmtRs(r.list.reduce((s, x) => s + x.bill, 0))}`); });
    internalParts.push('## BILLING AND SOURCING (internal: never quote billing, fees or where candidates were hired from to a client)\n' + L.join('\n'));
  }

  if (scope.dropIntent) {
    const L = [`Firm-wide: ${pack.totals.joinees} joinees vs ${pack.totals.drops} offer drops = ${(pack.totals.joinees / (pack.totals.joinees + pack.totals.drops) * 100).toFixed(1)}% offer-to-join on recorded offers.`];
    scope.companies.forEach((c) => { if (c.joinees + c.drops) L.push(`${c.name}: ${c.joinees} joined, ${c.drops} dropped = ${(c.joinees / (c.joinees + c.drops) * 100).toFixed(1)}% offer-to-join` + (Object.keys(c.byDropDesig).length ? ` | roles that dropped most: ${listTop(c.byDropDesig, 8)}` : '') + (c.lastOffer ? ` | latest drop on record ${c.lastOffer}` : '')); });
    scope.industries.forEach((n) => { const I = pack.industries[n]; if (I && I.joinees + I.drops) L.push(`${n}: ${I.joinees} joined, ${I.drops} dropped = ${(I.joinees / (I.joinees + I.drops) * 100).toFixed(1)}% offer-to-join`); });
    L.push('The Offer Drop tab only logs offers that did NOT convert, so this ratio is joinees / (joinees + logged drops). Designation is blank on roughly half the drop rows.');
    internalParts.push('## OFFER DROPS (internal performance data: for the rep and for client reviews of that same client only)\n' + L.join('\n'));
    addSource('Offer Drop tab');
  }

  const techniqueHits = technique.length;
  const mode = (type === 'ICP/Targeting' || (type === 'Pricing' && !RE.objection.test(question)) || RE.capability.test(question)) ? 'internal' : 'client';
  return {
    clientSafe: parts.join('\n\n'), technique: technique.join('\n\n'), internal: internalParts.join('\n\n'),
    scope, type, evidence, mode, facts: mode === 'internal' ? [] : facts.slice(0, 5), sources: sources.slice(0, 12), inherited, techniqueHits,
  };
}

// Industry tag for the query log.
function industryTag(scope) {
  if (scope.directIndustries.length) return scope.directIndustries[0];
  if (scope.companies.length === 1 && scope.companies[0].industry) return scope.companies[0].industry;
  if (scope.adjacentIndustries.length) return scope.adjacentIndustries[0] + ' (adjacent)';
  return 'General';
}

module.exports = { getPack, clearPack, assembleContext, deriveScope, parseRanges, parseSheetDate, industryTag, fmtRs, QUERY_TYPES };
