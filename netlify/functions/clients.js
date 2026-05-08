const { getSheetData } = require('../lib/sheets');

const INDUSTRY_SHEETS = [
  'IT - Product',
  'Media and Entertainment',
  'BFSI',
  'Consulting',
  'Manufacturing & Engineering',
  'Telecommunications',
  'FMCG, Retail & Consumer Commerc',
  'IT - Services & Consulting',
  'Pharma',
  'Real Estate',
  'Aviation',
];

const DISPLAY_NAMES = {
  'IT - Product': 'IT – Product',
  'Media and Entertainment': 'Media & Entertainment',
  'BFSI': 'BFSI',
  'Consulting': 'Consulting',
  'Manufacturing & Engineering': 'Manufacturing & Engineering',
  'Telecommunications': 'Telecommunications',
  'FMCG, Retail & Consumer Commerc': 'FMCG, Retail & Consumer',
  'IT - Services & Consulting': 'IT – Services & Consulting',
  'Pharma': 'Pharma',
  'Real Estate': 'Real Estate',
  'Aviation': 'Aviation',
};

function validateAuth(event) {
  const authHeader = event.headers['authorization'] || '';
  if (!authHeader.startsWith('Basic ')) return false;
  const token = authHeader.replace('Basic ', '');
  const decoded = Buffer.from(token, 'base64').toString('utf8');
  const [username, password] = decoded.split(':');
  return (
    username === process.env.SITE_USERNAME &&
    password === process.env.SITE_PASSWORD
  );
}

function parseSheet(rows) {
  if (!rows || rows.length < 2) return {};

  const headerRow = rows[0];

  // Find subsector columns: a subsector col is followed by a "Requisition" col
  const subsectors = [];
  for (let i = 2; i < headerRow.length - 1; i++) {
    const val = headerRow[i];
    const next = headerRow[i + 1];
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
      if (company || role) {
        entries.push({ company, role });
      }
    }
    if (entries.length > 0) {
      subsectorData[name] = entries;
    }
  });

  return subsectorData;
}

exports.handler = async (event) => {
  if (!validateAuth(event)) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: 'Unauthorized' }),
    };
  }

  try {
    const result = {};

    await Promise.all(
      INDUSTRY_SHEETS.map(async (sheetName) => {
        const rows = await getSheetData(sheetName);
        const parsed = parseSheet(rows);
        const displayName = DISPLAY_NAMES[sheetName];
        result[displayName] = parsed;
      })
    );

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };
  } catch (err) {
    console.error('Sheets fetch error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to fetch sheet data' }),
    };
  }
};
