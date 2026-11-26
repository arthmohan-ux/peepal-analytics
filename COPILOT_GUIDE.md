# BD Copilot: how it works and how to keep making it better

## 1. How an answer is built

1. **Load the sheet.** `netlify/lib/data.js` reads Joinees All, Offer Drop All, Client Last Engagement, the 11 Clients tabs and the knowledge tabs (Sources, Doctrine, Playbook, plus the optional Coaching and Aliases) in one request. Columns are found **by header name**, so adding or moving a column does not break anything. Client names and city spellings are merged ("Bengaluru", "bangalore" → Bangalore).
2. **Give the model the map.** The model gets the table layout, every client in the tracker with its industry and activity, the values that exist (industries, HQs, cities), today's date and how far the data runs.
3. **The model asks, the code counts.** The model calls `query_tracker` (filter, group, count, sum, average, rank, list rows) and `search_knowledge` (Playbook, Doctrine, Sources, Clients tabs) as many times as the question needs. `netlify/lib/query.js` does every calculation, so numbers are exact. The model never counts.
4. **It picks one of two answer modes.**
   - **Data mode** (the default): an answer for the rep. Numbers, lists, tables, comparisons, revenue. Shown as *Answer, for you* plus *How it was counted*.
   - **Call mode**: words for a client. *Say this*, *Proof*, *Ask next*, and *For you only*. Used for objections, pitches and "what do I say".
5. **Log it.** QueryLog records the question, confidence, evidence, the queries that ran (Matched column), latency and model.

Under every answer the UI shows the queries that ran and **"Tracker data to [date]"**, so a stale or empty answer is visible at a glance.

The rule to remember: *if an answer is wrong, look at the queries it ran first* (shown under the answer, and in QueryLog). A wrong filter is a prompt or alias fix; a wrong number from a right filter is a data fix.

## 2. Keeping the data fresh

- The Render server re-reads the sheet in the background every **5 minutes** (`TRACKER_REFRESH_MS`).
- Any question that finds data older than **10 minutes** (`TRACKER_MAX_AGE_MS`) re-reads the sheet before answering. This covers the Netlify functions and a server that just woke up.
- **Reload data** in the Copilot header re-reads immediately.
- If a reload fails, the Copilot keeps the last good copy, the answer says the data may be out of date, and `/api/copilot/health` shows the error under `data.lastError`. Nothing fails silently any more.

## 3. The weekly loop (20 minutes)

Open `https://peepal-analytics.onrender.com/api/copilot/gaps?days=7` while signed in. It returns:

- `weakQuestions`: every question answered with low confidence or no evidence, with the queries it ran
- `namesNotInData`: company names reps asked about that the tracker does not have
- `byType`: which kinds of question fail most
- `medianLatencyMs`: speed

Then open the Feedback tab and read every thumbs-down note.

| What went wrong | Fix | Where |
|---|---|---|
| A client was not recognised ("KPMG Global Services", "JPMC") | Add an alias row | Aliases tab |
| A real client shows as "not in the data" | The name in the tracker differs. Add an alias, or fix the tracker name | Aliases tab or Joinees All |
| A skill search missed obvious rows ("SRE", "RPA") | Add a skill alias listing the words the tracker uses | Aliases tab |
| The number is right but the line is weak or off-message | Write the approved line once | Coaching tab |
| An objection got a generic answer | Add a Playbook row tagged `objection` | Playbook tab |
| Reps keep asking for a story that does not exist | Write the case study | Sources tab |
| A count looks low or a client is missing from an industry | The tracker row is blank or mislabelled | Joinees All |
| The answer contradicts something the BD lead knows | Coaching row now, data fix after | Coaching tab |

After editing any tab, click **Reload data** (or wait up to 5 minutes). No deploy needed.

## 4. The two optional tabs

Create these tabs in the same Google Sheet with the header row exactly as shown. The Copilot runs without them.

### Aliases

| alias | maps_to | kind | relation |
|---|---|---|---|
| kpmg global services | KGS | company | |
| jpmc | Jp Morgan | company | |
| legal tech | Consulting | industry | adjacent |
| hedge fund | BFSI | industry | direct |
| sre | sre, site reliability, devops | skill | |
| rpa | rpa, uipath, automation anywhere, blue prism | skill | |

- `company` aliases are applied by the query engine itself: a filter on "jpmc" returns Jp Morgan rows. `maps_to` must be the client name as it appears in Joinees All.
- `industry` and `skill` aliases are given to the model as instructions ("when a rep says X, search for Y"). `relation: adjacent` makes it say honestly that the proof is the closest neighbour, not the exact space.

### Coaching

| id | triggers | guidance | say_line | audience | active |
|---|---|---|---|---|---|
| C-001 | too expensive, pricing is high, fee is high | Never discount on the call. Ask what they compare against first. Then anchor on the 90-day replacement and time-to-fill. | I hear you on cost. Can I ask what you are comparing us against? | general | yes |
| C-002 | bot model, build operate transfer | Disqualify until transfer. Do not pitch RPO. Offer to stay in touch. | | internal | yes |

- `triggers` is a comma list of phrases. If any appears in the question, the row is used and outranks everything else.
- `say_line` is optional. If present the Copilot uses it as the line to say.
- Set `active` to `no` to switch a row off without deleting it.

## 5. Writing knowledge rows that get found

`search_knowledge` ranks rows by word overlap with what the model searches for, with the title, tags and category counting most.

- **Playbook objections:** put the objection in the `item` column in the client's own words ("We already have vendors"). Tag it `objection`. Put the words to say in `action`.
- **Sources:** `bd_usage` and `tags` decide when a story is pulled. Write `bd_usage` as "Use when the prospect says or is ...". Fill `result_client_safe` or the story is treated as a technique, never as a Peepal win. `result_internal` never reaches a client line.
- **Doctrine:** set `audience` to `internal` for anything a client must never hear.
- Give every row an `id`. Ids show up in the sources line under each answer.

## 6. Tracker fixes that raise accuracy now

Ordered by impact. Current counts are in `/api/copilot/health`.

1. **Function/Business Unit is blank on about half of all joinees** (2,778 of 5,450 in the 26 Nov copy). Skill answers ("how many Guidewire", "AI hires") can only find rows where the skill is written in Designation or Function, so they are floors. Filling Function for EY GDS fixes most of it.
2. **Years of experience is blank on about a quarter of joinees** and joining location on about a fifth. Seniority and city answers say so, but they are partial.
3. **Client Last Engagement is mostly empty.** 1,011 of 1,285 rows have no client name and Engagement Model is blank on every row, so "which clients are RPO" cannot be answered. New and dormant clients are worked out from joinee dates instead.
4. **22 clients with joinees have no industry** (Industry says CHECK or is blank): Forvis Mazars, Aon Consulting, Fractal Analytics, Wattpower Systems and others. They are missing from every industry answer. `clientsWithoutIndustrySample` in health lists them.
5. **FIS vs Fiserv:** the Offer Drop normalizer maps "fis" to Fiserv, so Fiserv shows 27 offer drops and 0 joinees. They are different companies.
6. **Industry labels:** FMCG (100) and Retail (38) are separate labels, as are IT Services and IT Prod. Merge them in the sheet if they should be one.

## 7. The normalizer scripts (.gs) point at the wrong columns

The four Apps Script normalizers use fixed column numbers from an older sheet layout. Do not run them until they find columns by header.

| Script | Writes to | That column is now | Should be |
|---|---|---|---|
| `normalizeJoineesAllBusinessFunctionUnits` | Joinees L (12) | Designation | M (13) |
| `normalizeDesignations` | Joinees K (11) | Invoice Amount by Vibha | L (12) |
| `normalizeOfferDropAllClientFinal` | Offer Drop E (5) | FY | G (7) |
| `normalizeOfferDropAllRolesGranular` | Offer Drop H (8) | HQ Location | I (9) |

*The business unit one is the dangerous one.* Its remove-list contains "Manager", "Consultant", "Senior", "Staff" and "Associate", so pointed at Designation it would blank hundreds of titles.

Add this helper once and replace the four hard-coded numbers with it:

```javascript
function colByHeader_(sheet, header) {
  const row = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const i = row.findIndex(h => String(h).trim().toLowerCase() === header.toLowerCase());
  if (i < 0) throw new Error('Column "' + header + '" not found in ' + sheet.getName());
  return i + 1;
}
```

```javascript
const targetCol = colByHeader_(sheet, 'Function/Role/Business Unit'); // was 12
const targetCol = colByHeader_(sheet, 'Client Cleaned');              // was 5
const targetCol = colByHeader_(sheet, 'Designation');                 // was 8 (Offer Drop)
// in normalizeDesignations(): const col = colByHeader_(sheet, 'Designation'); and use col in place of 11
```

The Copilot does not depend on these scripts: it merges client and city spellings itself when it loads the sheet.

## 8. Settings

Set in Render, Environment.

| Variable | Default | What it does |
|---|---|---|
| `LLM_API_KEY` | | Required |
| `LLM_MODEL` | `gemini-3.8-flash` | Primary model. It must support function calling. |
| `LLM_FALLBACK_MODELS` | 3.6 Flash, 3.5 Flash-Lite, 3.1 Flash-Lite | Tried in order if the primary fails or is slow |
| `LLM_REASONING_EFFORT` | `minimal` | The model now plans queries, so if it picks wrong filters, try `low` before anything else |
| `COPILOT_MAX_ROUNDS` | `6` | Most query rounds per answer. The last round must answer. |
| `TRACKER_REFRESH_MS` | `300000` | Background reload interval (Render) |
| `TRACKER_MAX_AGE_MS` | `600000` | Data older than this is reloaded before answering |
| `LLM_HEDGE_MS`, `LLM_FIRST_TOKEN_MS`, `LLM_COOLDOWN_MS` | 6s, 12s, 5 min | Model racing and fallback, unchanged |

A typical answer is two model rounds: one to run the queries, one to write. If a model fails partway, the answer restarts once on the next model.

Netlify functions time out after 10 seconds by default, which a multi-query answer can exceed. Render is the deployment to use for the Copilot.

## 9. Debugging one answer

```bash
node scripts/copilot-debug.js "java hires in bfsi last year"
```

Prints every query the model ran, the mode, confidence and the full answer.

```bash
node scripts/copilot-debug.js --query '{"table":"joinees","filters":[{"field":"month","op":"eq","value":"2026-11"}],"group_by":["client"]}'
```

Runs one query exactly as the model would. No model call, so it is free and instant. Use it to check a number by hand.

```bash
node scripts/copilot-debug.js --golden
```

Runs the regression questions in `scripts/golden.json`. Number checks are recomputed from the live data each time, so they do not go stale. Run it before every deploy, and add any question you fix.

All three need the same env vars as the server. To run without Google credentials, set `TRACKER_JSON` to a JSON dump of the tabs (`{"Joinees All": [[...header], [...row]], ...}`) with dates as sheet serial numbers.

## 10. When code is the right fix

| Change | Where |
|---|---|
| A new column the model should be able to query | `HEADERS` in `netlify/lib/data.js` (header names it accepts) and `FIELDS` in `netlify/lib/query.js` (what the model is told) |
| A header was renamed in the sheet | Add the new name to `HEADERS` in `data.js` |
| A city spelling that should merge | `CITY_ALIAS` in `data.js` |
| A built-in client nickname | `BUILTIN_ALIASES` in `query.js` (or, better, the Aliases tab) |
| How the model should read a kind of question | `RULES` in `netlify/lib/copilot.js`. Change it last, and only for something wrong across many answers |

## 11. Endpoints

| Endpoint | Use |
|---|---|
| `POST /api/ask` | `{question, history, user, stream}`. With `stream: true` it returns server-sent events: `meta` (data freshness), `tool` (each query), `delta` (text), `done` (the answer). |
| `POST /api/copilot/refresh` | Re-read the sheet now. Same as the Reload data button. |
| `GET /api/copilot/health` | Data freshness and last reload error, row counts, latest dates, blank-field counts, clients with no industry, model status. |
| `GET /api/copilot/gaps?days=30` | The weekly review. |
| `GET /api/feedback` | All votes with a summary by type, industry and month. |
