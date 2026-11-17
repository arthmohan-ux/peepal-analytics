const express = require('express');
const path = require('path');
const crypto = require('crypto');
const copilot = require('./netlify/lib/copilot');

const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy; needed for a real client IP
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── AUTH HELPERS ──
// Constant-time compare so the password cannot be guessed from response timing.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a || '')).digest();
  const hb = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function checkCreds(username, password) {
  if (!process.env.SITE_USERNAME || !process.env.SITE_PASSWORD) return false;
  return safeEqual(username, process.env.SITE_USERNAME) & safeEqual(password, process.env.SITE_PASSWORD);
}
function validateBasicAuth(req) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Basic ')) return false;
  const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
  const i = decoded.indexOf(':'); // split on the FIRST colon so a password containing ":" still works
  if (i < 0) return false;
  return !!checkCreds(decoded.slice(0, i), decoded.slice(i + 1));
}

// Login throttle: 10 failed attempts per IP per 15 minutes.
const failedLogins = new Map();
function tooManyFailures(ip) {
  const rec = failedLogins.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > 15 * 60 * 1000) { failedLogins.delete(ip); return false; }
  return rec.count >= 10;
}
function noteFailure(ip) {
  const rec = failedLogins.get(ip);
  if (!rec || Date.now() - rec.first > 15 * 60 * 1000) failedLogins.set(ip, { first: Date.now(), count: 1 });
  else rec.count++;
}

// ── SHEETS HELPER (use shared module) ──
const { getSheetData } = require('./netlify/lib/sheets');

// ── POST /api/auth ──
app.post('/api/auth', (req, res) => {
  const ip = req.ip || 'unknown';
  if (tooManyFailures(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const { username, password } = req.body || {};
  if (!checkCreds(username, password)) { noteFailure(ip); return res.status(401).json({ error: 'Invalid credentials' }); }
  failedLogins.delete(ip);
  const token = Buffer.from(`${username}:${password}`).toString('base64');
  res.json({ token });
});

// ── POST /api/ask (BD Copilot) ──
// Send { stream: true } to get Server-Sent Events: a "meta" event with the fact cards the
// moment retrieval finishes, "delta" events while the model writes, then "done" with the
// parsed answer. Without it the endpoint returns one JSON object, as before.
app.post('/api/ask', async (req, res) => {
  if (!validateBasicAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
  const b = req.body || {};
  const question = String(b.question || '').trim().slice(0, 2000);
  const history = Array.isArray(b.history) ? b.history.slice(-8) : [];
  const user = String(b.user || '').slice(0, 80);
  if (!question) return res.status(400).json({ error: 'Empty question' });

  if (!b.stream) {
    try { return res.json(await copilot.answer({ question, history, user })); }
    catch (e) { console.error('ask error:', e); return res.status(500).json({ error: 'Copilot failed: ' + (e.message || 'unknown') }); }
  }

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (event, data) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  try {
    const out = await copilot.answer({ question, history, user }, (ev) => send(ev.type, ev));
    send('done', out);
  } catch (e) {
    console.error('ask stream error:', e);
    send('error', { error: 'Copilot failed: ' + (e.message || 'unknown') });
  }
  res.end();
});

// ── POST /api/feedback ──
app.post('/api/feedback', async (req, res) => {
  if (!validateBasicAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
  const b = req.body || {};
  if (!b.vote) return res.status(400).json({ error: 'Missing vote' });
  try { await copilot.saveFeedback(b); res.json({ ok: true }); }
  catch (e) { console.error('feedback error:', e); res.status(500).json({ error: e.message }); }
});

// ── GET /api/feedback: every vote plus a summary ──
app.get('/api/feedback', async (req, res) => {
  if (!validateBasicAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const rows = await copilot.recentFeedback(1000);
    res.json({ summary: copilot.summariseFeedback(rows), feedback: rows });
  } catch (e) { console.error('feedback read error:', e); res.status(500).json({ error: e.message }); }
});

// ── GET /api/queries ──
app.get('/api/queries', async (req, res) => {
  if (!validateBasicAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
  try { const queries = await copilot.recentQueries(200); res.json({ queries }); }
  catch (e) { console.error('queries error:', e); res.status(500).json({ error: e.message }); }
});

// ── Copilot upkeep ──
// POST /api/copilot/refresh   re-read the sheet now (after editing Sources / Playbook / Coaching / Aliases)
// GET  /api/copilot/health    what the Copilot is reading: row counts, latest dates, model, data-hygiene flags
// GET  /api/copilot/gaps      the weekly review: questions it could not answer well, names not in the data
app.post('/api/copilot/refresh', async (req, res) => {
  if (!validateBasicAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
  try { copilot.clearPack(); res.json({ ok: true, health: await copilot.health() }); }
  catch (e) { console.error('refresh error:', e); res.status(500).json({ error: e.message }); }
});
app.get('/api/copilot/health', async (req, res) => {
  if (!validateBasicAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
  try { res.json(await copilot.health()); }
  catch (e) { console.error('health error:', e); res.status(500).json({ error: e.message }); }
});
app.get('/api/copilot/gaps', async (req, res) => {
  if (!validateBasicAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
  try { res.json(await copilot.gapReport(Math.min(365, parseInt(req.query.days, 10) || 30))); }
  catch (e) { console.error('gaps error:', e); res.status(500).json({ error: e.message }); }
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
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  // Build the Copilot's data pack now so the first question is not the slow one.
  if (process.env.SHEET_ID) require('./netlify/lib/kb').getPack().then(() => console.log('Copilot pack ready')).catch((e) => console.error('Copilot pack warm-up failed:', e.message));
});
