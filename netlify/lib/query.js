// netlify/lib/query.js
// The tools the Copilot's model can call. The model decides WHAT to ask; this file does
// every filter, count, sum and sort, so numbers are always exact.
//
//   query_tracker     filter / group / aggregate / list rows over the tracker tables
//   search_knowledge  keyword search over Playbook, Doctrine, Sources and the Clients tabs

const { norm } = require('./data');

// ── table schemas (also shown to the model) ───────────────────────────────────
const TIME = {
  date: ['date', 'YYYY-MM-DD'],
  year: ['num', 'calendar year, e.g. 2026'],
  month: ['month', "calendar month 'YYYY-MM', e.g. '2026-11'"],
  fy: ['text', "Indian financial year Apr-Mar, e.g. '2025-26' = Apr 2025 to Mar 2026"],
  fy_quarter: ['text', "e.g. '2026-27 Q3'. Q1 Apr-Jun, Q2 Jul-Sep, Q3 Oct-Dec, Q4 Jan-Mar"],
  half: ['text', "calendar half, e.g. '2026 H2' (Jul-Dec)"],
};
const FIELDS = {
  joinees: Object.assign({}, TIME, {
    client: ['text', 'client name (use names from the client roster)'],
    industry: ['text', 'client industry, e.g. Consulting, BFSI, IT Services, IT Prod, Manufacturing, Telecom, Aviation, FMCG, Retail, Pharma/Healthcare'],
    hq: ['text', 'client HQ country, e.g. USA, UK, India'],
    billing: ['num', 'INTERNAL: Peepal billing amount in INR for this joinee'],
    designation: ['text', 'job title / grade, e.g. "Senior Consultant 1", "SDE3"'],
    function: ['text', 'function / skill / business unit, e.g. "Guidewire", "AI & Data". Blank on about half the rows'],
    role_text: ['text', 'designation and function together. Search skills here with contains / contains_word'],
    yoe: ['num', 'candidate years of experience. Blank on about a quarter of rows'],
    exp_band: ['text', 'Junior (0-4 yrs) | Mid (4-8 yrs) | Senior (8-12 yrs) | Very Senior (12-15 yrs) | Leadership (15+ yrs)'],
    location: ['text', 'India city the candidate joined in, e.g. Bangalore, Hyderabad, Pune'],
    previous_company: ['text', 'INTERNAL: where the candidate came from'],
  }),
  offer_drops: Object.assign({}, TIME, {
    client: ['text', 'client name'],
    industry: ['text', 'client industry'],
    hq: ['text', 'client HQ country'],
    designation: ['text', 'role offered. Blank on about half the rows'],
  }),
  clients: {
    client: ['text', 'client name'],
    industry: ['text', 'majority industry across its rows'],
    hq: ['text', 'HQ country'],
    joinees: ['num', 'all-time joinees (closures)'],
    offer_drops: ['num', 'all-time logged offer drops'],
    total_offers: ['num', 'joinees + offer_drops'],
    offer_drop_rate: ['num', 'INTERNAL: offer_drops / total_offers * 100'],
    billing: ['num', 'INTERNAL: all-time billing INR'],
    avg_billing_per_joinee: ['num', 'INTERNAL: INR'],
    first_join: ['date', 'first joinee date: when Peepal first closed a role there'],
    first_join_fy: ['text', 'FY of the first joinee'],
    last_join: ['date', 'most recent joinee date'],
    last_offer_drop: ['date', 'most recent offer drop'],
    engagement_model: ['text', 'from Client Last Engagement tab (mostly blank)'],
    first_engagement: ['date', 'from Client Last Engagement tab'],
    last_engagement: ['date', 'from Client Last Engagement tab'],
    engagement_status: ['text', "'Active', 'Ended' or blank"],
  },
  engagements: {
    client: ['text', 'client name'],
    engagement_model: ['text', 'mostly blank'],
    first_engagement: ['date', ''],
    last_engagement: ['date', ''],
    end_date: ['date', ''],
    status: ['text', "'Active', 'Ended' or blank"],
  },
};
const TABLE_INFO = {
  joinees: 'one row per candidate who JOINED a client (a closure). Candidate names are not included.',
  offer_drops: 'one row per accepted offer that did NOT convert to a joining.',
  clients: 'one row per client, all-time rollups. Use for rankings, first/last activity, new or dormant clients, drop rates.',
  engagements: 'Client Last Engagement tab. Sparse: most rows have no client.',
};
const OPS = ['eq', 'neq', 'in', 'not_in', 'contains', 'not_contains', 'contains_word', 'not_contains_word', 'gt', 'gte', 'lt', 'lte', 'between', 'empty', 'not_empty'];

// ── helpers ───────────────────────────────────────────────────────────────────
class ToolError extends Error {}
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lc = (v) => String(v == null ? '' : v).toLowerCase().trim();
const isBlank = (v) => v == null || v === '';
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

// "FY25-26", "2025-2026", "fy 2025-26", "FY26" -> "2025-26"
function normFY(v) {
  const s = lc(v); let m;
  if ((m = s.match(/(?:20)?(\d{2})\s*[-/–]\s*(?:20)?(\d{2})\b/))) return '20' + m[1] + '-' + m[2];
  if ((m = s.match(/fy\s*'?(?:20)?(\d{2})\b/))) { const e = +m[1]; return '20' + String(e - 1).padStart(2, '0') + '-' + String(e).padStart(2, '0'); }
  return String(v).trim();
}
function normFYQ(v) { const s = String(v); const q = (s.match(/q\s*([1-4])/i) || [])[1]; const fy = normFY(s.replace(/q\s*[1-4]/i, '')); return q ? fy + ' Q' + q : fy; }
function normHalf(v) { const s = String(v); const y = (s.match(/(20\d{2})/) || [])[1]; const h = (s.match(/h\s*([12])/i) || [])[1]; return y && h ? y + ' H' + h : s.trim(); }
function normDateArg(v) {
  const s = String(v).trim(); let m;
  if ((m = s.match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/))) return m[1] + (m[2] ? '-' + m[2].padStart(2, '0') : '') + (m[3] ? '-' + m[3].padStart(2, '0') : '');
  throw new ToolError(`Date value "${s}" must look like YYYY, YYYY-MM or YYYY-MM-DD`);
}

// ── client name resolution ────────────────────────────────────────────────────
const BUILTIN_ALIASES = {
  ey: 'EY GDS', 'e&y': 'EY GDS', 'ernst & young': 'EY GDS', 'ernst and young': 'EY GDS', 'kpmg global services': 'KGS',
  goldman: 'Goldman Sachs', gs: 'Goldman Sachs', citibank: 'Citi', citigroup: 'Citi', jpmc: 'Jp Morgan', jpmorgan: 'Jp Morgan', 'jp morgan chase': 'Jp Morgan',
  'de shaw': 'D E Shaw', 'cnh industrial': 'CNHI', sonnys: "Sonny's", swissre: 'Swiss Re', 'true value hub': 'TVH', 'fis global': 'FIS',
  bse: 'Bombay Stock Exchange', 'electronic arts': 'Electronic Arts',
};
function clientResolver(data) {
  const byKey = new Map(data.tables.clients.map((c) => [norm(c.client), c.client]));
  const aliases = new Map(Object.entries(BUILTIN_ALIASES).map(([a, t]) => [norm(a), t]));
  (data.kb.aliases || []).filter((a) => a.alias && a.maps_to && /^comp/i.test(a.kind || 'company')).forEach((a) => aliases.set(norm(a.alias), a.maps_to));
  const names = data.tables.clients.map((c) => c.client);
  const joineesOf = new Map(data.tables.clients.map((c) => [c.client, c.joinees]));
  return function resolve(value) {
    const k = norm(value);
    if (!k) return { name: null };
    if (byKey.has(k)) return { name: byKey.get(k) };
    if (aliases.has(k) && byKey.has(norm(aliases.get(k)))) return { name: byKey.get(norm(aliases.get(k))), note: `read "${value}" as ${byKey.get(norm(aliases.get(k)))}` };
    let best = null;
    for (const n of names) {
      const nk = norm(n); const fw = norm(String(n).split(/\s+/)[0]);
      let s = 0;
      if (fw === k && k.length >= 3) s = 80;
      else if (nk.startsWith(k) && k.length >= 4) s = 70;
      else if (nk.includes(k) && k.length >= 5) s = 60;
      else if (k.length >= 5) { const d = editDistance(k, nk, k.length >= 8 ? 2 : 1); if (d <= (k.length >= 8 ? 2 : 1)) s = 55; else if (fw.length >= 5 && editDistance(k, fw, 1) <= 1) s = 50; }
      if (s && (!best || s > best.s || (s === best.s && (joineesOf.get(n) || 0) > (joineesOf.get(best.n) || 0)))) best = { n, s };
    }
    if (best) return { name: best.n, note: `no client named exactly "${value}"; read it as ${best.n}` };
    return { name: null, note: `no client named "${value}" in the tracker` };
  };
}

// ── query_tracker ─────────────────────────────────────────────────────────────
function makePredicate(f, table, schema, resolve, warnings) {
  const def = schema[f.field];
  if (!def) throw new ToolError(`Unknown field "${f.field}" for table ${table}. Fields: ${Object.keys(schema).join(', ')}`);
  const type = def[0];
  const op = f.op || 'eq';
  if (!OPS.includes(op)) throw new ToolError(`Unknown op "${op}". Ops: ${OPS.join(', ')}`);
  let vals = Array.isArray(f.values) && f.values.length ? f.values.slice() : f.value != null && f.value !== '' ? [f.value] : [];
  vals = vals.map((v) => String(v));
  if (!['empty', 'not_empty'].includes(op) && !vals.length) throw new ToolError(`Filter on ${f.field} with op ${op} needs value or values`);
  const field = f.field;
  const get = (r) => r[field];

  if (op === 'empty') return (r) => isBlank(get(r));
  if (op === 'not_empty') return (r) => !isBlank(get(r));

  // normalise the values for the field
  if (field === 'client' && ['eq', 'neq', 'in', 'not_in'].includes(op)) {
    vals = vals.map((v) => { const r = resolve(v); if (r.note) warnings.push(r.note); return r.name ? norm(r.name) : '\u0000nomatch'; });
  } else if (field === 'fy') vals = vals.map(normFY);
  else if (field === 'fy_quarter') vals = vals.map(normFYQ);
  else if (field === 'half') vals = vals.map(normHalf);
  else if (type === 'date' || type === 'month') { if (!/contains/.test(op)) vals = vals.map(normDateArg); }

  if (['contains', 'not_contains'].includes(op)) {
    const needles = vals.map(lc);
    const hit = (r) => { const h = lc(get(r)); return needles.some((n) => h.includes(n)); };
    return op === 'contains' ? hit : (r) => !hit(r);
  }
  if (['contains_word', 'not_contains_word'].includes(op)) {
    const res = vals.map((v) => { const t = lc(v); const end = /[a-z0-9]$/.test(t) ? '(?:s|es)?(?![a-z0-9])' : '(?![a-z0-9])'; return new RegExp('(^|[^a-z0-9])' + esc(t) + end, 'i'); });
    const hit = (r) => { const h = String(get(r) == null ? '' : get(r)); return res.some((re) => re.test(h)); };
    return op === 'contains_word' ? hit : (r) => !hit(r);
  }
  if (['eq', 'neq', 'in', 'not_in'].includes(op)) {
    let eq;
    if (type === 'num') { const ns = vals.map(Number); eq = (r) => get(r) != null && ns.includes(Number(get(r))); }
    else if (type === 'date' || type === 'month') eq = (r) => { const v = get(r); return !!v && vals.some((x) => String(v).slice(0, x.length) === x); };
    else if (field === 'client') eq = (r) => vals.includes(norm(get(r)));
    else { const ks = vals.map(norm); eq = (r) => ks.includes(norm(get(r))); }
    return op === 'eq' || op === 'in' ? eq : (r) => !eq(r);
  }
  // range ops
  if (type === 'num') {
    const n = vals.map(Number);
    if (n.some((x) => !Number.isFinite(x))) throw new ToolError(`Field ${field} is numeric; got ${vals.join(', ')}`);
    const v = (r) => (get(r) == null || get(r) === '' ? null : Number(get(r)));
    if (op === 'between') { if (n.length < 2) throw new ToolError('between needs values [low, high]'); return (r) => v(r) != null && v(r) >= n[0] && v(r) <= n[1]; }
    const cmp = { gt: (a) => a > n[0], gte: (a) => a >= n[0], lt: (a) => a < n[0], lte: (a) => a <= n[0] }[op];
    return (r) => v(r) != null && cmp(v(r));
  }
  // text / date / month ranges compare as strings, truncated to the value's precision,
  // so lte '2026-11' includes every day of November.
  const cut = (r, x) => (get(r) == null || get(r) === '' ? null : String(get(r)).slice(0, x.length));
  if (op === 'between') {
    if (vals.length < 2) throw new ToolError('between needs values [from, to]');
    const [a, b] = vals; return (r) => { const x = cut(r, a), y = cut(r, b); return x != null && x >= a && y <= b; };
  }
  const x0 = vals[0];
  const cmp = { gt: (a) => a > x0, gte: (a) => a >= x0, lt: (a) => a < x0, lte: (a) => a <= x0 }[op];
  return (r) => { const a = cut(r, x0); return a != null && cmp(a); };
}

function parseMetric(m, schema) {
  const s = String(m).trim();
  const shorthand = { count: ['count'], share: ['share'], distinct_clients: ['distinct', 'client'], sum_billing: ['sum', 'billing'], avg_billing: ['avg', 'billing'], avg_yoe: ['avg', 'yoe'], first_date: ['min', 'date'], last_date: ['max', 'date'] };
  let fn, field;
  if (shorthand[s]) [fn, field] = shorthand[s];
  else { const mm = s.match(/^(sum|avg|min|max|median|distinct)\s*[:(]\s*([a-z_]+)\s*\)?$/i); if (!mm) throw new ToolError(`Unknown metric "${s}". Use count, share, sum:field, avg:field, min:field, max:field, median:field, distinct:field`); fn = mm[1].toLowerCase(); field = mm[2]; }
  if (field && !schema[field]) throw new ToolError(`Metric ${s}: unknown field "${field}"`);
  if (['sum', 'avg', 'median'].includes(fn) && schema[field][0] !== 'num') throw new ToolError(`Metric ${s}: ${field} is not numeric`);
  return { key: s, fn, field };
}

function compute(metric, rows, totalMatched) {
  const { fn, field } = metric;
  if (fn === 'count') return rows.length;
  if (fn === 'share') return totalMatched ? Math.round((rows.length / totalMatched) * 1000) / 10 : 0;
  const vals = rows.map((r) => r[field]).filter((v) => !isBlank(v));
  if (fn === 'distinct') return new Set(vals.map((v) => norm(v))).size;
  if (!vals.length) return null;
  if (fn === 'min' || fn === 'max') { const s = vals.slice().sort((a, b) => (typeof a === 'number' ? a - b : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0)); return fn === 'min' ? s[0] : s[s.length - 1]; }
  const ns = vals.map(Number);
  const round = (x) => (field === 'billing' || /billing/.test(field) ? Math.round(x) : Math.round(x * 10) / 10);
  if (fn === 'sum') return round(ns.reduce((a, b) => a + b, 0));
  if (fn === 'avg') return round(ns.reduce((a, b) => a + b, 0) / ns.length);
  if (fn === 'median') { const s = ns.slice().sort((a, b) => a - b); const h = Math.floor(s.length / 2); return round(s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2); }
  return null;
}

const CHRONO = new Set(['date', 'year', 'month', 'fy', 'fy_quarter', 'half']);
const MAX_RESULT_CHARS = 14000;

function queryTracker(data, args, resolve) {
  const table = args.table;
  const schema = FIELDS[table];
  if (!schema) throw new ToolError(`Unknown table "${table}". Tables: ${Object.keys(FIELDS).join(', ')}`);
  const warnings = [];
  const filters = Array.isArray(args.filters) ? args.filters : [];
  const preds = filters.map((f) => makePredicate(f, table, schema, resolve, warnings));
  const all = data.tables[table];
  const rows = all.filter((r) => preds.every((p) => p(r)));
  const out = { table, filters: filters.map(describeFilter).join(' AND ') || 'none', matched_rows: rows.length };

  // Coverage: the latest date in this table, so the model never mistakes "after the data ends" for zero.
  if (schema.date) out.table_has_data_through = data.tables[table].reduce((m, r) => (r.date && r.date > m ? r.date : m), '') || null;

  const select = Array.isArray(args.select) ? args.select.filter(Boolean) : [];
  const groupBy = Array.isArray(args.group_by) ? args.group_by.filter(Boolean).slice(0, 3) : [];
  groupBy.concat(select).forEach((g) => { if (!schema[g]) throw new ToolError(`Unknown field "${g}" for table ${table}. Fields: ${Object.keys(schema).join(', ')}`); });
  const dir = String(args.sort_dir || '').toLowerCase() === 'asc' ? 1 : -1;

  if (select.length && !groupBy.length) { // row listing
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 25, 1), 200);
    const sortBy = args.sort_by && schema[args.sort_by] ? args.sort_by : schema.date ? 'date' : null;
    let list = rows.slice();
    if (sortBy) list.sort((a, b) => { const x = a[sortBy], y = b[sortBy]; if (isBlank(x)) return 1; if (isBlank(y)) return -1; return (x > y ? 1 : x < y ? -1 : 0) * (args.sort_by ? dir : -1); });
    out.rows = list.slice(0, limit).map((r) => Object.fromEntries(select.map((f) => [f, isBlank(r[f]) ? null : r[f]])));
    out.shown = out.rows.length;
    if (rows.length > out.rows.length) out.note = `showing ${out.rows.length} of ${rows.length} rows`;
  } else {
    const metrics = (Array.isArray(args.metrics) && args.metrics.length ? args.metrics : ['count']).map((m) => parseMetric(m, schema));
    if (!groupBy.length) {
      out.totals = Object.fromEntries(metrics.map((m) => [m.key, compute(m, rows, rows.length)]));
    } else {
      const groups = new Map();
      for (const r of rows) {
        const key = groupBy.map((g) => (isBlank(r[g]) ? '(blank)' : String(r[g]))).join('\u0001');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      }
      let list = [...groups.entries()].map(([k, rs]) => {
        const o = {}; k.split('\u0001').forEach((v, i) => { o[groupBy[i]] = v; });
        metrics.forEach((m) => { o[m.key] = compute(m, rs, rows.length); });
        return o;
      });
      const sortKey = args.sort_by && (groupBy.includes(args.sort_by) || metrics.some((m) => m.key === args.sort_by)) ? args.sort_by
        : (groupBy.length === 1 && CHRONO.has(groupBy[0]) ? groupBy[0] : metrics[0].key);
      const sdir = args.sort_by ? dir : (CHRONO.has(sortKey) ? 1 : -1);
      list.sort((a, b) => { const x = a[sortKey], y = b[sortKey]; if (x == null) return 1; if (y == null) return -1; return (x > y ? 1 : x < y ? -1 : 0) * sdir; });
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 50, 1), 400);
      out.total_groups = list.length;
      out.groups = list.slice(0, limit);
      if (list.length > limit) out.note = `showing ${limit} of ${list.length} groups, sorted by ${sortKey}`;
      // nullable averages: say how many rows actually carried the value
      metrics.filter((m) => ['avg', 'min', 'max', 'median'].includes(m.fn) && schema[m.field] && schema[m.field][0] === 'num').forEach((m) => {
        const withV = rows.filter((r) => !isBlank(r[m.field])).length;
        if (withV < rows.length) warnings.push(`${m.field} is filled on ${withV} of ${rows.length} matched rows; ${m.key} uses only those`);
      });
    }
    if (!groupBy.length) metrics.filter((m) => ['avg', 'min', 'max', 'median'].includes(m.fn) && schema[m.field][0] === 'num').forEach((m) => {
      const withV = rows.filter((r) => !isBlank(r[m.field])).length;
      if (withV < rows.length) warnings.push(`${m.field} is filled on ${withV} of ${rows.length} matched rows; ${m.key} uses only those`);
    });
  }
  if (warnings.length) out.warnings = [...new Set(warnings)];
  // keep tool results bounded
  let s = JSON.stringify(out);
  while (s.length > MAX_RESULT_CHARS && ((out.groups && out.groups.length > 10) || (out.rows && out.rows.length > 10))) {
    if (out.groups) out.groups = out.groups.slice(0, Math.floor(out.groups.length * 0.7));
    if (out.rows) out.rows = out.rows.slice(0, Math.floor(out.rows.length * 0.7));
    out.note = `result trimmed to ${(out.groups || out.rows).length} entries to fit; narrow the query or lower the limit for the rest`;
    s = JSON.stringify(out);
  }
  return out;
}

function describeFilter(f) {
  const v = Array.isArray(f.values) && f.values.length ? f.values.join('|') : f.value != null ? f.value : '';
  return `${f.field} ${f.op || 'eq'}${v !== '' ? ' ' + v : ''}`;
}
function describeCall(name, args) {
  if (name === 'search_knowledge') return `knowledge("${String(args.query || '').slice(0, 40)}")`;
  if (name !== 'query_tracker') return name;
  const bits = [args.table];
  if (args.filters && args.filters.length) bits.push('[' + args.filters.map(describeFilter).join('; ') + ']');
  if (args.group_by && args.group_by.length) bits.push('by ' + args.group_by.join(','));
  if (args.select && args.select.length) bits.push('rows');
  return bits.join(' ');
}

// ── search_knowledge ──────────────────────────────────────────────────────────
const KSTOP = new Set('the and for with what how who can are our you does did have has had this that from about into when which where why give show tell any all some more most not but was were will would could should them they their there here client clients company companies say said says do we us is it in of on to a an i me my or be as at by'.split(' '));
function ktoks(q) { return [...new Set(lc(q).split(/[^a-z0-9+#&.]+/).map((w) => w.replace(/^\.+|\.+$/g, '')).filter((w) => w && !KSTOP.has(w) && (w.length >= 3 || ['ai', 'ml', 'qa', 'ba', 'hr', 'ta', 'c#', 'bd'].includes(w))))]; }
function kscore(toks, strong, weak) {
  const S = ' ' + lc(strong).replace(/[^a-z0-9+#&.]+/g, ' ') + ' ', W = ' ' + lc(weak).replace(/[^a-z0-9+#&.]+/g, ' ') + ' ';
  let s = 0;
  for (const t of toks) {
    const stem = t.length > 5 ? t.slice(0, 5) : t;
    if (S.includes(' ' + t)) s += 3; else if (t.length > 5 && S.includes(' ' + stem)) s += 2;
    if (W.includes(' ' + t)) s += 1; else if (t.length > 5 && W.includes(' ' + stem)) s += 0.5;
  }
  return s;
}
function searchKnowledge(data, args) {
  const toks = ktoks(args.query || '');
  if (!toks.length) throw new ToolError('query needs at least one meaningful word');
  const kinds = Array.isArray(args.kinds) && args.kinds.length ? args.kinds : ['playbook', 'doctrine', 'sources', 'clients_tab'];
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 6, 1), 12);
  const cands = [];
  if (kinds.includes('playbook')) (data.kb.playbook || []).forEach((p) => cands.push({ kind: 'playbook', sc: kscore(toks, [p.item, p.tags, p.category].join(' '), [p.detail, p.action, p.examples].join(' ')), row: { id: p.id, category: p.category, item: p.item, detail: p.detail, examples: p.examples, action: p.action, audience: p.audience || 'general' } }));
  if (kinds.includes('doctrine')) (data.kb.doctrine || []).forEach((d) => cands.push({ kind: 'doctrine', sc: kscore(toks, [d.item, d.tags, d.category].join(' '), [d.detail, d.action, d.examples].join(' ')), row: { id: d.id, category: d.category, item: d.item, detail: d.detail, examples: d.examples, action: d.action, audience: d.audience || 'general' } }));
  if (kinds.includes('sources')) (data.kb.sources || []).forEach((s) => cands.push({ kind: 'sources', sc: kscore(toks, [s.client, s.industry, s.tags, s.bd_usage].join(' '), [s.problem, s.intervention, s.result_client_safe].join(' ')), row: { id: s.source_id, type: s.type, client: s.client, industry: s.industry, problem: s.problem, intervention: s.intervention, result_client_safe: s.result_client_safe || '(none: a technique, not a Peepal win)', result_internal_ONLY: s.result_internal, when_to_use: s.bd_usage } }));
  if (kinds.includes('clients_tab')) (data.clients_tab || []).forEach((c) => cands.push({ kind: 'clients_tab', sc: kscore(toks, [c.industry_tab, c.subsector, c.companies.join(' ')].join(' '), c.roles.join(' ')), row: { id: c.id, industry_tab: c.industry_tab, subsector: c.subsector, companies_engaged_not_necessarily_closed: c.companies.join('; '), roles_we_can_fill: c.roles.join('; ') } }));
  const top = cands.filter((c) => c.sc >= 2).sort((a, b) => b.sc - a.sc).slice(0, limit);
  return { query: args.query, results: top.map((c) => Object.assign({ kind: c.kind }, c.row)), note: top.length ? undefined : 'nothing matched; try other words' };
}

// ── tool definitions (OpenAI function-calling format) ─────────────────────────
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'query_tracker',
      description: 'Run an exact query over Peepal\'s hiring tracker. Filter rows, then either aggregate (group_by + metrics) or list rows (select). Call it as many times as you need; every number in your answer must come from a result.',
      parameters: {
        type: 'object',
        properties: {
          table: { type: 'string', enum: Object.keys(FIELDS), description: 'joinees | offer_drops | clients | engagements' },
          filters: {
            type: 'array', description: 'All filters must match (AND). Use values for in/not_in/between or to OR several terms in contains/contains_word.',
            items: {
              type: 'object',
              properties: {
                field: { type: 'string' },
                op: { type: 'string', enum: OPS },
                value: { type: 'string' },
                values: { type: 'array', items: { type: 'string' } },
              },
              required: ['field', 'op'],
            },
          },
          group_by: { type: 'array', items: { type: 'string' }, description: 'Up to 3 fields, e.g. ["client"], ["month"], ["industry","fy"]' },
          metrics: { type: 'array', items: { type: 'string' }, description: 'Default ["count"]. Also: share (% of matched rows), distinct_clients, sum_billing, avg_yoe, first_date, last_date, or fn:field with fn in sum|avg|min|max|median|distinct' },
          select: { type: 'array', items: { type: 'string' }, description: 'List matching rows with these fields instead of aggregating (no group_by)' },
          sort_by: { type: 'string', description: 'A metric key or group field. Default: time fields ascending, otherwise first metric descending' },
          sort_dir: { type: 'string', enum: ['desc', 'asc'] },
          limit: { type: 'integer', description: 'Groups (default 50, max 400) or rows (default 25, max 200)' },
        },
        required: ['table'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_knowledge',
      description: 'Keyword search over Peepal\'s Playbook (BD technique, objection handling), Doctrine (company facts, services, fees, targeting rules), Sources (case studies) and the Clients tabs (companies engaged per industry subsector and roles Peepal can fill). Use for how-to, objections, pitches, case studies, positioning, and to check prospects that are not in the tracker.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords, e.g. "strong internal team objection" or "Mazars"' },
          kinds: { type: 'array', items: { type: 'string', enum: ['playbook', 'doctrine', 'sources', 'clients_tab'] } },
          limit: { type: 'integer', description: 'Default 6, max 12' },
        },
        required: ['query'],
      },
    },
  },
];

// Executes one tool call. Never throws: errors go back to the model so it can fix the call.
function runTool(data, name, args) {
  const resolve = clientResolver(data);
  try {
    if (name === 'query_tracker') return queryTracker(data, args || {}, resolve);
    if (name === 'search_knowledge') return searchKnowledge(data, args || {});
    return { error: `Unknown tool ${name}` };
  } catch (e) {
    return { error: e instanceof ToolError ? e.message : 'Query failed: ' + e.message };
  }
}

// Schema text for the system prompt.
function schemaText() {
  return Object.entries(FIELDS).map(([t, fields]) => `TABLE ${t}: ${TABLE_INFO[t]}\n` + Object.entries(fields).map(([f, [type, desc]]) => `  - ${f} (${type})${desc ? ': ' + desc : ''}`).join('\n')).join('\n\n');
}

module.exports = { TOOLS, FIELDS, runTool, queryTracker, searchKnowledge, clientResolver, describeCall, schemaText, normFY };
