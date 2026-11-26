// netlify/lib/data.js
// Loads the tracker into clean, queryable tables and keeps them fresh.
//
//   - Columns are found by HEADER NAME, never by position, so inserting or moving a column
//     in the sheet cannot silently shift every number.
//   - Values are read unformatted (dates as serial numbers), so nothing depends on how a
//     cell is displayed.
//   - Freshness: a long-running server reloads in the background every TRACKER_REFRESH_MS
//     (default 5 min). Any request that finds data older than TRACKER_MAX_AGE_MS
//     (default 10 min) reloads before answering. A failed reload keeps the last good copy
//     but marks it stale, and that warning reaches the answer and /api/copilot/health.
//   - Dev: set TRACKER_JSON=/path/to/dump.json ({ "Tab name": [[row], ...] }) to run
//     without Google credentials.

const fs = require('fs');
const sheets = require('./sheets');

const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };
const REFRESH_MS = int(process.env.TRACKER_REFRESH_MS, 5 * 60 * 1000);
const MAX_AGE_MS = int(process.env.TRACKER_MAX_AGE_MS, 10 * 60 * 1000);

const TAB = { joinees: 'Joinees All', drops: 'Offer Drop All', engagement: 'Client Last Engagement' };
const KB_TABS = ['Sources', 'Doctrine', 'Playbook', 'Coaching', 'Aliases'];
const INDUSTRY_TABS = [
  'IT - Product', 'Media and Entertainment', 'BFSI', 'Consulting',
  'Manufacturing & Engineering', 'Telecommunications', 'FMCG, Retail & Consumer Commerc',
  'IT - Services & Consulting', 'Pharma', 'Real Estate', 'Aviation',
];

// Header names the loader accepts for each field (compared after lower-casing and
// dropping everything but letters and digits). First match wins.
const HEADERS = {
  joinees: {
    date: ['date of joining', 'joining date', 'doj'],
    client: ['client cleaned', 'client final', 'client name', 'client'],
    hq: ['hq location', 'hq', 'client hq'],
    industry: ['industry'],
    billing: ['peepal billing amount', 'billing amount', 'billing'],
    designation: ['designation'],
    function: ['function/role/business unit', 'business unit', 'function'],
    yoe: ['years of experience', 'yoe', 'experience'],
    location: ['joining location', 'location'],
    previous_company: ['previous company'],
  },
  drops: {
    date: ['offer date', 'date of offer', 'date'],
    client: ['client cleaned', 'client final', 'client name', 'client'],
    hq: ['hq location', 'hq'],
    designation: ['designation', 'role'],
    industry: ['industry'],
  },
  engagement: {
    client: ['client'],
    engagement_model: ['engagement model', 'model'],
    first_engagement: ['first engagement date', 'first engagement'],
    last_engagement: ['last engagement date', 'last engagement'],
    end: ['end date', 'end'],
  },
};
const REQUIRED = { joinees: ['date', 'client'], drops: ['date', 'client'], engagement: ['client'] };

// ── small helpers ─────────────────────────────────────────────────────────────
const hnorm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
const norm = hnorm;
const pad2 = (n) => String(n).padStart(2, '0');
const str = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
function num(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

const MONTH_IDX = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// Returns 'YYYY-MM-DD' or null. Serial numbers are what the API returns for real date
// cells; the string branches cover dates someone typed as text.
function toIsoDate(v) {
  if (v == null || v === '') return null;
  let y, m, d, mm;
  if (typeof v === 'number') {
    if (v < 20000 || v > 80000) return null; // 1954..2119; also rejects stray time-only cells
    const dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000);
    return dt.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if ((mm = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) { y = +mm[1]; m = +mm[2]; d = +mm[3]; }
  else if ((mm = s.match(/^(\d{1,2})[\s\-./]*([A-Za-z]{3,})[\s\-.,/]*(\d{2,4})/))) { d = +mm[1]; m = MONTH_IDX[mm[2].slice(0, 3).toLowerCase()]; y = +mm[3]; }
  else if ((mm = s.match(/^([A-Za-z]{3,})[\s\-.]*(\d{1,2}),?[\s\-.]*(\d{2,4})/))) { m = MONTH_IDX[mm[1].slice(0, 3).toLowerCase()]; d = +mm[2]; y = +mm[3]; }
  else if ((mm = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})/))) { // ambiguous: Indian sheets write day first
    const a = +mm[1], b = +mm[2]; y = +mm[3];
    if (b > 12) { m = a; d = b; } else { d = a; m = b; }
  } else return null;
  if (y < 100) y += 2000;
  if (!y || !m || m < 1 || m > 12 || !d || d > 31 || y < 1990 || y > 2100) return null;
  return y + '-' + pad2(m) + '-' + pad2(d);
}

function fyOf(y, m) { const s = m >= 4 ? y : y - 1; return s + '-' + pad2((s + 1) % 100); }
function fyQuarterOf(m) { return m >= 4 && m <= 6 ? 'Q1' : m >= 7 && m <= 9 ? 'Q2' : m >= 10 ? 'Q3' : 'Q4'; }
function timeFields(iso) {
  if (!iso) return { year: null, month: null, fy: null, fy_quarter: null, half: null };
  const y = +iso.slice(0, 4), m = +iso.slice(5, 7);
  const fy = fyOf(y, m);
  return { year: y, month: iso.slice(0, 7), fy, fy_quarter: fy + ' ' + fyQuarterOf(m), half: y + (m <= 6 ? ' H1' : ' H2') };
}
function expBand(yoe) {
  if (yoe == null) return null;
  if (yoe < 4) return 'Junior (0-4 yrs)';
  if (yoe < 8) return 'Mid (4-8 yrs)';
  if (yoe < 12) return 'Senior (8-12 yrs)';
  if (yoe < 15) return 'Very Senior (12-15 yrs)';
  return 'Leadership (15+ yrs)';
}

const PLACEHOLDER = /^(check|unknown|tbd|na|n\/a|-|none|null|0)$/i;
const clean = (v) => { const s = str(v); return PLACEHOLDER.test(s) ? '' : s; };

// Map header -> column index for one tab. Returns { cols, missing }.
function mapHeaders(headerRow, spec) {
  const hs = (headerRow || []).map(hnorm);
  const cols = {}; const missing = [];
  for (const [field, names] of Object.entries(spec)) {
    let idx = -1;
    for (const n of names) { idx = hs.indexOf(hnorm(n)); if (idx >= 0) break; }
    if (idx < 0) for (const n of names) { const k = hnorm(n); idx = hs.findIndex((h) => h && h.startsWith(k)); if (idx >= 0) break; }
    if (idx >= 0) cols[field] = idx; else missing.push(field);
  }
  return { cols, missing };
}

// Most common spelling wins as the display name for everything sharing a key.
function canonicaliser(keyFn) {
  const votes = new Map();
  return {
    add(v) { const s = str(v); if (!s) return; const k = keyFn(s); if (!k) return; const b = votes.get(k) || new Map(); b.set(s, (b.get(s) || 0) + 1); votes.set(k, b); },
    get(v) { const s = str(v); if (!s) return ''; const b = votes.get(keyFn(s)); if (!b) return s; return [...b.entries()].sort((a, z) => z[1] - a[1] || (a[0] < z[0] ? -1 : 1))[0][0]; },
  };
}
const CITY_ALIAS = { bengaluru: 'bangalore', banglore: 'bangalore', gurugram: 'gurgaon', bombay: 'mumbai', madras: 'chennai', kolkatta: 'kolkata', calcutta: 'kolkata', trivandram: 'trivandrum', thiruvananthapuram: 'trivandrum' };
const cityKey = (s) => { const k = String(s).toLowerCase().replace(/[^a-z/]/g, ''); return k.split('/').map((p) => CITY_ALIAS[p] || p).join('/'); };

function rowsToObjects(rws) {
  if (!rws || rws.length < 2) return [];
  const headers = rws[0].map((h) => String(h || '').trim().toLowerCase());
  return rws.slice(1)
    .filter((r) => r && r.some((c) => String(c == null ? '' : c).trim() !== ''))
    .map((r) => { const o = {}; headers.forEach((h, i) => { if (h) o[h] = r[i] != null ? String(r[i]).trim() : ''; }); return o; });
}

// ── reading the raw tabs ──────────────────────────────────────────────────────
async function readTabs() {
  const wanted = [TAB.joinees, TAB.drops, TAB.engagement, ...KB_TABS, ...INDUSTRY_TABS];
  if (process.env.TRACKER_JSON) {
    const dump = JSON.parse(fs.readFileSync(process.env.TRACKER_JSON, 'utf8'));
    const out = {}; wanted.forEach((t) => { if (dump[t]) out[t] = dump[t]; });
    return out;
  }
  // Only ask for tabs that exist (a missing tab would fail the whole batch). Match
  // tolerantly so "Joinees All " with a trailing space still loads.
  const titles = await sheets.listTabs();
  const byKey = new Map(titles.map((t) => [hnorm(t), t]));
  const pairs = wanted.map((w) => [w, byKey.get(hnorm(w))]).filter(([, real]) => real);
  const got = await sheets.batchGetTabs(pairs.map(([, real]) => real));
  const out = {}; pairs.forEach(([w, real]) => { out[w] = got[real]; });
  return out;
}

// ── build ─────────────────────────────────────────────────────────────────────
async function build() {
  const t0 = Date.now();
  const tabs = await readTabs();
  const problems = [];
  const mapped = {};
  for (const key of ['joinees', 'drops', 'engagement']) {
    const rows = tabs[TAB[key]];
    if (!rows || !rows.length) {
      if (key !== 'engagement') throw new Error(`Tab "${TAB[key]}" not found or empty`);
      mapped[key] = { rows: [], cols: {} }; continue;
    }
    const { cols, missing } = mapHeaders(rows[0], HEADERS[key]);
    const req = missing.filter((f) => REQUIRED[key].includes(f));
    if (req.length) throw new Error(`Tab "${TAB[key]}" has no column for: ${req.join(', ')}. Headers seen: ${rows[0].join(' | ')}`);
    if (missing.length) problems.push(`"${TAB[key]}" has no column for ${missing.join(', ')}`);
    mapped[key] = { rows: rows.slice(1), cols };
  }
  const cell = (r, cols, f) => (cols[f] === undefined ? undefined : r[cols[f]]);

  // Pass 1: spellings, so every row gets one canonical client / city name.
  const clientNames = canonicaliser(norm);
  const cityNames = canonicaliser(cityKey);
  const J = mapped.joinees, D = mapped.drops, E = mapped.engagement;
  J.rows.forEach((r) => { clientNames.add(cell(r, J.cols, 'client')); cityNames.add(cell(r, J.cols, 'location')); });
  D.rows.forEach((r) => clientNames.add(cell(r, D.cols, 'client')));

  // Client industry / HQ by majority vote (joinee rows count double), ignoring placeholders.
  const vote = new Map();
  const tally = (client, field, v, w) => { const x = clean(v); if (!client || !x) return; const k = norm(client) + '|' + field; const b = vote.get(k) || new Map(); b.set(x, (b.get(x) || 0) + w); vote.set(k, b); };
  J.rows.forEach((r) => { const c = clientNames.get(cell(r, J.cols, 'client')); tally(c, 'industry', cell(r, J.cols, 'industry'), 1); tally(c, 'hq', cell(r, J.cols, 'hq'), 1); });
  D.rows.forEach((r) => { const c = clientNames.get(cell(r, D.cols, 'client')); tally(c, 'industry', cell(r, D.cols, 'industry'), 0.5); tally(c, 'hq', cell(r, D.cols, 'hq'), 0.5); });
  const winner = (client, field) => { const b = vote.get(norm(client) + '|' + field); return b ? [...b.entries()].sort((a, z) => z[1] - a[1])[0][0] : ''; };

  let badDates = 0;
  const joinees = [];
  J.rows.forEach((r) => {
    const client = clientNames.get(cell(r, J.cols, 'client'));
    if (!client) return;
    const date = toIsoDate(cell(r, J.cols, 'date'));
    if (!date) badDates++;
    const yoeN = num(cell(r, J.cols, 'yoe'));
    const yoe = yoeN != null && yoeN >= 0 && yoeN < 60 ? Math.round(yoeN * 10) / 10 : null;
    const designation = str(cell(r, J.cols, 'designation'));
    const fn = str(cell(r, J.cols, 'function'));
    joinees.push(Object.assign({ date }, timeFields(date), {
      client,
      industry: clean(cell(r, J.cols, 'industry')) || winner(client, 'industry'),
      hq: clean(cell(r, J.cols, 'hq')) || winner(client, 'hq'),
      billing: num(cell(r, J.cols, 'billing')),
      designation, function: fn, role_text: (designation + ' | ' + fn).trim(),
      yoe, exp_band: expBand(yoe),
      location: cityNames.get(cell(r, J.cols, 'location')),
      previous_company: str(cell(r, J.cols, 'previous_company')),
    }));
  });

  const offer_drops = [];
  D.rows.forEach((r) => {
    const client = clientNames.get(cell(r, D.cols, 'client'));
    if (!client) return;
    const date = toIsoDate(cell(r, D.cols, 'date'));
    if (!date) badDates++;
    offer_drops.push(Object.assign({ date }, timeFields(date), {
      client,
      industry: clean(cell(r, D.cols, 'industry')) || winner(client, 'industry'),
      hq: clean(cell(r, D.cols, 'hq')) || winner(client, 'hq'),
      designation: str(cell(r, D.cols, 'designation')),
    }));
  });

  // Engagement tab: only rows that name a client are usable.
  const engagements = [];
  const engByKey = new Map();
  E.rows.forEach((r) => {
    const raw = str(cell(r, E.cols, 'client'));
    if (!raw) return;
    const client = clientNames.get(raw) || raw;
    const endRaw = cell(r, E.cols, 'end');
    const status = typeof endRaw === 'string' && /active/i.test(endRaw) ? 'Active' : '';
    const e = {
      client, engagement_model: clean(cell(r, E.cols, 'engagement_model')),
      first_engagement: toIsoDate(cell(r, E.cols, 'first_engagement')),
      last_engagement: toIsoDate(cell(r, E.cols, 'last_engagement')),
      end_date: status ? null : toIsoDate(endRaw), status: status || (toIsoDate(endRaw) ? 'Ended' : ''),
    };
    engagements.push(e); engByKey.set(norm(client), e);
  });

  // One row per client, derived from the rows above.
  const cmap = new Map();
  const ensure = (name) => {
    const k = norm(name);
    if (!cmap.has(k)) cmap.set(k, { client: name, industry: winner(name, 'industry'), hq: winner(name, 'hq'), joinees: 0, offer_drops: 0, billing: 0, first_join: null, last_join: null, last_offer_drop: null });
    return cmap.get(k);
  };
  joinees.forEach((j) => {
    const c = ensure(j.client); c.joinees++; c.billing += j.billing || 0;
    if (j.date) { if (!c.first_join || j.date < c.first_join) c.first_join = j.date; if (!c.last_join || j.date > c.last_join) c.last_join = j.date; }
  });
  offer_drops.forEach((d) => { const c = ensure(d.client); c.offer_drops++; if (d.date && (!c.last_offer_drop || d.date > c.last_offer_drop)) c.last_offer_drop = d.date; });
  engagements.forEach((e) => ensure(e.client));
  const clients = [...cmap.values()].map((c) => {
    const e = engByKey.get(norm(c.client)) || {};
    const total = c.joinees + c.offer_drops;
    return Object.assign(c, {
      billing: Math.round(c.billing), avg_billing_per_joinee: c.joinees ? Math.round(c.billing / c.joinees) : null,
      total_offers: total, offer_drop_rate: total ? Math.round((c.offer_drops / total) * 1000) / 10 : null,
      first_join_fy: c.first_join ? timeFields(c.first_join).fy : null,
      engagement_model: e.engagement_model || '', first_engagement: e.first_engagement || null,
      last_engagement: e.last_engagement || null, engagement_status: e.status || '',
    });
  });

  // Clients tabs (one per industry): companies engaged in each subsector and roles we can fill.
  const clients_tab = [];
  INDUSTRY_TABS.forEach((tabName) => {
    const rws = tabs[tabName];
    if (!rws || rws.length < 2) return;
    const header = rws[0];
    for (let ci = 2; ci < header.length - 1; ci++) {
      const val = str(header[ci]), next = str(header[ci + 1]);
      if (!val || /requisition|roles closed/i.test(val) || !/requisition/i.test(next)) continue;
      const companies = new Set(), roles = new Set();
      for (let r = 2; r < rws.length; r++) {
        const comp = str(rws[r] && rws[r][ci]); const cap = str(rws[r] && rws[r][ci + 1]);
        if (comp) companies.add(comp);
        if (cap && !/requisition/i.test(cap)) roles.add(cap);
      }
      if (companies.size || roles.size) clients_tab.push({ id: 'CT-' + (clients_tab.length + 1), industry_tab: tabName, subsector: val, companies: [...companies], roles: [...roles] });
    }
  });

  const kb = {};
  KB_TABS.forEach((t) => { kb[t.toLowerCase()] = rowsToObjects(tabs[t]); });

  const maxDate = (rows) => rows.reduce((m, r) => (r.date && r.date > m ? r.date : m), '');
  const blank = (f) => joinees.filter((j) => j[f] == null || j[f] === '').length;
  const coverage = {
    joinees: joinees.length, offerDrops: offer_drops.length, clients: clients.filter((c) => c.joinees > 0).length,
    latestJoinee: maxDate(joinees) || null, latestOfferDrop: maxDate(offer_drops) || null, unparseableDates: badDates,
    blanks: { designation: blank('designation'), function: blank('function'), yoe: blank('yoe'), location: blank('location'), billing: blank('billing') },
    clientsWithoutIndustry: clients.filter((c) => c.joinees > 0 && !c.industry).map((c) => c.client),
    engagementRowsWithoutClient: E.rows.filter((r) => !str(cell(r, E.cols, 'client')) && r.some((x) => x !== '' && x != null)).length,
    problems,
  };

  return { loadedAt: Date.now(), buildMs: Date.now() - t0, tables: { joinees, offer_drops, clients, engagements }, clients_tab, kb, coverage };
}

// ── cache ─────────────────────────────────────────────────────────────────────
let cache = null;
let building = null;
let lastError = null; // { message, at }

function load() {
  if (!building) {
    building = build()
      .then((d) => { cache = d; lastError = null; return d; })
      .catch((e) => { lastError = { message: e.message, at: Date.now() }; console.error('[data] reload failed:', e.message); throw e; })
      .finally(() => { building = null; });
  }
  return building;
}

// Returns the data, reloading first when it is too old. If a reload fails and an older
// copy exists, the older copy is returned and freshness() reports it as stale.
async function getData({ force = false } = {}) {
  if (force || !cache) return load();
  if (Date.now() - cache.loadedAt > MAX_AGE_MS) {
    try { return await load(); } catch (_) { return cache; }
  }
  return cache;
}

function freshness(d = cache) {
  if (!d) return { loaded: false, lastError };
  const ageSec = Math.round((Date.now() - d.loadedAt) / 1000);
  return {
    loaded: true, loadedAt: new Date(d.loadedAt).toISOString(), ageSec,
    latestJoinee: d.coverage.latestJoinee, latestOfferDrop: d.coverage.latestOfferDrop,
    stale: ageSec * 1000 > MAX_AGE_MS || !!lastError, lastError,
  };
}

// Long-running server only (Render / local). Serverless functions rely on getData's age check.
let timer = null;
function startAutoRefresh() {
  if (timer) return;
  timer = setInterval(() => { load().catch(() => {}); }, REFRESH_MS);
  if (timer.unref) timer.unref();
}

function clearData() { cache = null; }

module.exports = { getData, freshness, startAutoRefresh, clearData, toIsoDate, timeFields, norm, mapHeaders, HEADERS, REFRESH_MS, MAX_AGE_MS };
