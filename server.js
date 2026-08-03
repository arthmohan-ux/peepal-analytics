const express = require('express');
const path = require('path');
const { google } = require('googleapis');
const { streamChat } = require('./netlify/lib/llm');
const { prepare, parseSections, logQuery, saveFeedback, recentQueries } = require('./netlify/lib/copilot');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── AUTH HELPERS ──
function validateBasicAuth(req) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Basic ')) return false;
  const decoded = Buffer.from(authHeader.replace('Basic ', ''), 'base64').toString('utf8');
  const [username, password] = decoded.split(':');
  return username === process.env.SITE_USERNAME && password === process.env.SITE_PASSWORD;
}

// ── SHEETS HELPER ──
async function getSheetData(sheetName) {
  const privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  await auth.authorize();
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: `'${sheetName}'`,
  });
  return res.data.values || [];
}

// ── POST /api/auth ──
app.post('/api/auth', (req, res) => {
  const { username, password } = req.body || {};
  if (username !== process.env.SITE_USERNAME || password !== process.env.SITE_PASSWORD) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = Buffer.from(`${username}:${password}`).toString('base64');
  res.json({ token });
});

// ── POST /api/ask (BD Copilot, streaming SSE) ──
app.post('/api/ask', async (req, res) => {
  if (!validateBasicAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
  const question = String((req.body && req.body.question) || '').trim();
  const history = Array.isArray(req.body && req.body.history) ? req.body.history.slice(-8) : [];
  const user = String((req.body && req.body.user) || '');
  if (!question) return res.status(400).json({ error: 'Empty question' });

  let prep;
  try { prep = await prepare(question, history); }
  catch (e) { return res.status(500).json({ error: 'prepare failed: ' + (e.message || 'unknown') }); }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');

  let full = '';
  try { full = await streamChat(prep.messages, { maxTokens: 1600 }, (d) => send({ t: 'delta', v: d })); }
  catch (e) { send({ t: 'error', v: 'Copilot failed: ' + (e.message || 'unknown') }); return res.end(); }

  const parsed = parseSections(full);
  send({ t: 'done', confidence: parsed.confidence, type: parsed.type, sources: parsed.sources, industry: prep.industryTag });
  res.end();
  logQuery({ question, type: parsed.type, industry: prep.industryTag, confidence: parsed.confidence, sources: parsed.sources, user });
});

// ── POST /api/feedback ──
app.post('/api/feedback', async (req, res) => {
  if (!validateBasicAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
  const b = req.body || {};
  if (!b.vote) return res.status(400).json({ error: 'Missing vote' });
  try { await saveFeedback(b); res.json({ ok: true }); }
  catch (e) { console.error('feedback error:', e); res.status(500).json({ error: e.message }); }
});

// ── GET /api/queries ──
app.get('/api/queries', async (req, res) => {
  if (!validateBasicAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
  try { const queries = await recentQueries(200); res.json({ queries }); }
  catch (e) { console.error('queries error:', e); res.status(500).json({ error: e.message }); }
});

// ── GET /api/clients ──
const INDUSTRY_SHEETS = [
  'IT - Product', 'Media and Entertainment', 'BFSI', 'Consulting',
  'Manufacturing & Engineering', 'Telecommunications', 'FMCG, Retail & Consumer Commerc',
  'IT - Services & Consulting', 'Pharma', 'Real Estate', 'Aviation',
];
const DISPLAY_NAMES = {
  'IT - Product': 'IT – Product', 'Media and Entertainment': 'Media & Entertainment',
  'BFSI': 'BFSI', 'Consulting': 'Consulting', 'Manufacturing & Engineering': 'Manufacturing & Engineering',
  'Telecommunications': 'Telecommunications', 'FMCG, Retail & Consumer Commerc': 'FMCG, Retail & Consumer',
  'IT - Services & Consulting': 'IT – Services & Consulting', 'Pharma': 'Pharma',
  'Real Estate': 'Real Estate', 'Aviation': 'Aviation',
};

function parseClientSheet(rows) {
  if (!rows || rows.length < 2) return {};
  const headerRow = rows[0];
  const subsectors = [];
  for (let i = 2; i < headerRow.length - 1; i++) {
    const val = headerRow[i], next = headerRow[i + 1];
    if (val && !val.includes('Requisition') && next && next.includes('Requisition')) {
      subsectors.push({ colIdx: i, name: val.trim() });
    }
  }
  const subsectorData = {};
  subsectors.forEach(({ colIdx, name }) => {
    const entries = [];
    for (let r = 2; r < rows.length; r++) {
      const row = rows[r];
      const company = row[colIdx] ? row[colIdx].trim() : '';
      const role = row[colIdx + 1] ? row[colIdx + 1].trim() : '';
      if (company || role) entries.push({ company, role });
    }
    if (entries.length > 0) subsectorData[name] = entries;
  });
  return subsectorData;
}

app.get('/api/clients', async (req, res) => {
  if (!validateBasicAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = {};
    await Promise.all(INDUSTRY_SHEETS.map(async (sheetName) => {
      const rows = await getSheetData(sheetName);
      result[DISPLAY_NAMES[sheetName]] = parseClientSheet(rows);
    }));
    res.json(result);
  } catch (err) {
    console.error('Clients error:', err.message);
    res.status(500).json({ error: 'Failed to fetch client data' });
  }
});

// ── GET /api/analytics ──
function safeFloat(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

function safeDate(v) {
  if (!v) return { date: null, year: null, month: null };
  const d = new Date(v);
  if (isNaN(d.getTime())) return { date: null, year: null, month: null };
  return { date: d.toISOString().split('T')[0], year: d.getFullYear(), month: d.getMonth() + 1 };
}

function safeFY(v) {
  if (!v) return null;
  const s = String(v);
  if (s.startsWith('=') || s.includes('object') || !s[0]?.match(/\d/)) return null;
  if (/^\d{4}-\d{4}$/.test(s)) return s;
  return null;
}

const MONTH_NAMES = {1:'Jan',2:'Feb',3:'Mar',4:'Apr',5:'May',6:'Jun',7:'Jul',8:'Aug',9:'Sep',10:'Oct',11:'Nov',12:'Dec'};

function fyQuarter(month, fy) {
  if (!month || !fy) return null;
  const q = month >= 4 && month <= 6 ? 'Q1' : month >= 7 && month <= 9 ? 'Q2' : month >= 10 && month <= 12 ? 'Q3' : 'Q4';
  return `${fy} ${q}`;
}

function parseJoinees(rows) {
  return rows.slice(1).filter(r => r[0] && r[6]).map(r => {
    const { date, year, month } = safeDate(r[0]);
    const fy = safeFY(r[4]);
    return {
      date, year, month, fy,
      fyq: fyQuarter(month, fy),
      month_label: month && year ? `${MONTH_NAMES[month]} ${year}` : null,
      name: r[5] || '', client: r[6], hq: r[7] || '', industry: r[8] || '',
      billing: safeFloat(r[9]), designation: r[11] || '', role: r[12] || '', location: r[14] || '',
    };
  });
}

function parseDrops(rows) {
  return rows.slice(1).filter(r => r[0] && r[6]).map(r => {
    const { date, year, month } = safeDate(r[0]);
    const fy = safeFY(r[4]);
    return {
      date, year, month, fy,
      fyq: fyQuarter(month, fy),
      month_label: month && year ? `${MONTH_NAMES[month]} ${year}` : null,
      name: r[5] || '', client: r[6], hq: r[7] || '', industry: r[9] || '', designation: r[8] || '',
    };
  });
}

function parseEngagement(rows) {
  const result = {};
  rows.slice(1).forEach(r => {
    if (!r[0]) return;
    result[r[0]] = {
      model: r[1] ? String(r[1]).trim() : '',
      first_date: safeDate(r[2]).date || '',
      last_date: safeDate(r[3]).date || '',
      end_date: safeDate(r[4]).date || '',
    };
  });
  return result;
}

app.get('/api/analytics', async (req, res) => {
  if (!validateBasicAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const [joineeRows, dropRows, engagementRows] = await Promise.all([
      getSheetData('Joinees All'),
      getSheetData('Offer Drop All'),
      getSheetData('Client Last Engagement'),
    ]);

    const joinees = parseJoinees(joineeRows);
    const drops = parseDrops(dropRows);
    const engagement = parseEngagement(engagementRows);

    const fys = [...new Set(joinees.map(j => j.fy).filter(Boolean))].sort().reverse();
    const fyqs = [...new Set(joinees.map(j => j.fyq).filter(Boolean))].sort().reverse();
    const industries = [...new Set(joinees.map(j => j.industry).filter(Boolean))].sort();
    const engagementModels = [...new Set(Object.values(engagement).map(e => e.model).filter(Boolean))].sort();

    const monthMap = {};
    joinees.forEach(j => { if (j.month_label && j.year && j.month) monthMap[j.month_label] = [j.year, j.month]; });
    const months = Object.keys(monthMap).sort((a, b) => {
      const [ay, am] = monthMap[a], [by, bm] = monthMap[b];
      return ay !== by ? by - ay : bm - am;
    });

    res.json({ joinees, drops, engagement, meta: { fys, fyqs, industries, months, engagementModels } });
  } catch (err) {
    console.error('Analytics error:', err.message);
    res.status(500).json({ error: 'Failed to fetch analytics data' });
  }
});

// ── SERVE FRONTEND ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
