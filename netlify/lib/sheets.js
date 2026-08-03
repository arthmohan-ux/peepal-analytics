const { google } = require('googleapis');

function jwt(scope) {
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  return new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: privateKey,
    scopes: [scope],
  });
}

async function readClient() {
  const auth = jwt('https://www.googleapis.com/auth/spreadsheets.readonly');
  await auth.authorize();
  return google.sheets({ version: 'v4', auth });
}

async function writeClient() {
  const auth = jwt('https://www.googleapis.com/auth/spreadsheets');
  await auth.authorize();
  return google.sheets({ version: 'v4', auth });
}

async function getSheetData(sheetName) {
  const sheets = await readClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: `'${sheetName}'`,
  });
  return res.data.values || [];
}

// Create the tab (with a header row) only if it doesn't already exist.
async function ensureTab(sheetName, headers) {
  const sheets = await writeClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: process.env.SHEET_ID });
  const exists = (meta.data.sheets || []).some((s) => s.properties.title === sheetName);
  if (exists) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: process.env.SHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
  });
  if (headers && headers.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SHEET_ID,
      range: `'${sheetName}'!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    });
  }
}

// Append one or more rows to the bottom of a tab. rows = array of arrays.
async function appendRows(sheetName, rows) {
  const sheets = await writeClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SHEET_ID,
    range: `'${sheetName}'!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
}

module.exports = { getSheetData, ensureTab, appendRows };
