const { google } = require('googleapis');
const fs = require('fs');

function jwt(scope) {
  // Try secret file first (Render), fall back to env vars (Netlify/local)
  const secretPath = '/etc/secrets/service-account.json';
  if (fs.existsSync(secretPath)) {
    const creds = JSON.parse(fs.readFileSync(secretPath, 'utf8'));
    return new google.auth.JWT({ email: creds.client_email, key: creds.private_key, scopes: [scope] });
  }
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  return new google.auth.JWT({ email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, key: privateKey, scopes: [scope] });
}

// One authorised client per scope, reused. Previously every sheet read re-ran the JWT
// handshake, so building the Copilot's data pack did it 15+ times in a row.
const _clients = {};
function client(scope) {
  if (!_clients[scope]) {
    const auth = jwt(scope);
    _clients[scope] = auth.authorize().then(() => google.sheets({ version: 'v4', auth }))
      .catch((e) => { delete _clients[scope]; throw e; });
  }
  return _clients[scope];
}
const readClient = () => client('https://www.googleapis.com/auth/spreadsheets.readonly');
const writeClient = () => client('https://www.googleapis.com/auth/spreadsheets');

async function getSheetData(sheetName) {
  const sheets = await readClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.SHEET_ID, range: `'${sheetName}'` });
  return res.data.values || [];
}

// Create the tab (with a header row) only if it doesn't already exist. Result is cached
// so a log write does not fetch the whole spreadsheet's metadata every time.
const _tabReady = {};
async function ensureTab(sheetName, headers) {
  if (_tabReady[sheetName]) return;
  const sheets = await writeClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: process.env.SHEET_ID, fields: 'sheets.properties.title' });
  const exists = (meta.data.sheets || []).some((s) => s.properties.title === sheetName);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: process.env.SHEET_ID, requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] } });
  }
  if (headers && headers.length) await ensureHeaders(sheetName, headers);
  _tabReady[sheetName] = true;
}

// Make sure row 1 carries every expected header. Columns added to the code later
// (e.g. Type / Industry / Confidence on Feedback) get their header written instead of
// leaving unlabeled data columns.
async function ensureHeaders(sheetName, headers) {
  const sheets = await writeClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.SHEET_ID, range: `'${sheetName}'!1:1` });
  const current = (res.data.values && res.data.values[0]) || [];
  const same = headers.every((h, i) => String(current[i] || '').trim() === h);
  if (same) return;
  // never overwrite a header someone renamed by hand: only fill blanks and extend
  const merged = headers.map((h, i) => (String(current[i] || '').trim() ? current[i] : h));
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.SHEET_ID, range: `'${sheetName}'!A1`, valueInputOption: 'RAW', requestBody: { values: [merged] },
  });
}

// Append one or more rows to the bottom of a tab. rows = array of arrays.
async function appendRows(sheetName, rows) {
  const sheets = await writeClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SHEET_ID, range: `'${sheetName}'!A1`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: rows },
  });
}

module.exports = { getSheetData, ensureTab, ensureHeaders, appendRows };
