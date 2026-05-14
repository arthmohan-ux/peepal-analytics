const { getSheetData } = require('../lib/sheets');

function validateAuth(event) {
  const authHeader = event.headers['authorization'] || '';
  if (!authHeader.startsWith('Basic ')) return false;
  const token = authHeader.replace('Basic ', '');
  const decoded = Buffer.from(token, 'base64').toString('utf8');
  const [username, password] = decoded.split(':');
  return username === process.env.SITE_USERNAME && password === process.env.SITE_PASSWORD;
}

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

exports.handler = async (event) => {
  if (!validateAuth(event)) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  try {
    const [joineeRows, dropRows, engagementRows] = await Promise.all([
      getSheetData('Joinees All'), getSheetData('Offer Drop All'), getSheetData('Client Last Engagement'),
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
      const [ay, am] = monthMap[a]; const [by, bm] = monthMap[b];
      return ay !== by ? by - ay : bm - am;
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ joinees, drops, engagement, meta: { fys, fyqs, industries, months, engagementModels } }),
    };
  } catch (err) {
    console.error('Analytics error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch analytics data' }) };
  }
};
