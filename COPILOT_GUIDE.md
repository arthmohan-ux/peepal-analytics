# BD Copilot: how it works and how to keep making it better

## 1. How an answer is built

1. **Read the sheet.** `netlify/lib/kb.js` loads Joinees All, Offer Drop All, Client Last Engagement, the 11 Clients tabs, and the knowledge tabs (Sources, Doctrine, Playbook, plus the optional Coaching and Aliases). It is cached for 30 minutes.
2. **Work out what the question is about.** Clients (exact, alias, half-typed, misspelt), industries (direct or adjacent), skills, date ranges, city, seniority.
3. **Compute the exact answer in code.** The row filter runs for precisely the combination asked ("Java + BFSI", "Wipro + Hyderabad + FY25-26"). The model never counts.
4. **Rate the evidence.** Direct, adjacent or absent. This sets the confidence badge. The model can lower it, never raise it.
5. **Pick the technique.** The few Playbook and Doctrine rows that match the question, not the whole tab.
6. **Ask the model to phrase it.** Output is five parts: Say this, Proof, Ask next, For you only, and metadata.
7. **Log it.** QueryLog now also records Evidence, Matched (what retrieval resolved), LatencyMs and Model.

The rule to remember: *if an answer is wrong, the fix is almost never the prompt.* It is the data, a missing row in a knowledge tab, or an alias.

## 2. The weekly loop (20 minutes)

Open `https://peepal-analytics.onrender.com/api/copilot/gaps?days=7` while signed in. It returns:

- `weakQuestions`: every question answered with low confidence or no evidence
- `namesNotInData`: company names reps asked about that the tracker does not have
- `byType`: which kinds of question fail most
- `medianLatencyMs`: speed

Then open the Feedback tab and read every thumbs-down note.

For each weak question, find the row in this table and make that fix.

| What went wrong | Fix | Where |
|---|---|---|
| A client was not recognised ("KPMG Global Services", "JPMC") | Add an alias row | Aliases tab |
| A real client shows as "not in the data" | The name in the tracker differs. Add an alias, or fix the tracker name | Aliases tab or Joinees All |
| A space is asked about that Peepal has not worked in ("solar", "legal") | Add an adjacent-industry alias so it bridges to the nearest proof | Aliases tab |
| A skill word finds nothing ("SRE", "RPA") | Add a skill alias listing the words the tracker uses | Aliases tab |
| The number is right but the line is weak or off-message | Write the approved line once | Coaching tab |
| An objection got a generic answer | Add a Playbook row tagged `objection` | Playbook tab |
| Reps keep asking for a story that does not exist | Write the case study | Sources tab |
| A count looks low or a client is missing from an industry | The tracker row is blank or mislabelled | Joinees All |
| The answer contradicts something the BD lead knows | Coaching row now, data fix after | Coaching tab |

After editing any tab, click **Reload data** in the Copilot header. No deploy needed.

## 3. The two new tabs

Create these tabs in the same Google Sheet. Header row exactly as shown. Both are optional: the Copilot runs without them.

### Aliases

| alias | maps_to | kind | relation |
|---|---|---|---|
| kpmg global services | KGS | company | |
| jpmc | Jp Morgan | company | |
| legal tech | Consulting | industry | adjacent |
| hedge fund | BFSI | industry | direct |
| sre | sre, site reliability, devops | skill | |
| rpa | rpa, uipath, automation anywhere, blue prism | skill | |

- `kind` is `company`, `industry` or `skill`.
- For a company, `maps_to` is the client name exactly as it appears in Joinees All.
- For an industry, `maps_to` is the tracker's industry label (BFSI, Manufacturing, IT Prod). `relation` is `direct` when the word means that industry and `adjacent` when it is only the nearest neighbour. Adjacent makes the Copilot say honestly that it is the closest proof.
- For a skill, `maps_to` is a comma list of words to search in designation and business unit.

### Coaching

| id | triggers | guidance | say_line | audience | active |
|---|---|---|---|---|---|
| C-001 | too expensive, pricing is high, fee is high | Never discount on the call. Ask what they compare against first. Then anchor on the 90-day replacement and time-to-fill. | I hear you on cost. Can I ask what you are comparing us against? | general | yes |
| C-002 | bot model, build operate transfer | Disqualify until transfer. Do not pitch RPO. Offer to stay in touch. | | internal | yes |

- `triggers` is a comma list of phrases. If any appears in the question, the row is used.
- `guidance` is the instruction to the Copilot. It outranks everything else.
- `say_line` is optional. If present the Copilot uses it as the line to say.
- Set `active` to `no` to switch a row off without deleting it.

This is the fastest way to correct the Copilot. One row, one click on Reload data.

## 4. Writing knowledge rows that get picked

Rows are ranked by word overlap with the question, so wording matters.

- **Playbook objections:** put the objection in the `item` column in the client's own words ("We already have vendors"). Tag it `objection`. Put the actual words to say in `action`.
- **Sources:** `bd_usage` and `tags` decide when a story is pulled. Write `bd_usage` as "Use when the prospect says or is ...". Fill `result_client_safe` or the story is treated as a technique, never as a Peepal win.
- **Doctrine:** set `audience` to `internal` for anything a client must never hear. Internal rows only ever appear in "For you only".
- Give every row an `id`. Ids show up in Sources under each answer, so you can see which row drove it.

The biggest content gap today: Sources has 8 real proof points for 261 clients. Every new client-safe case study directly raises answer quality. Start with Wipro, Citi, Goldman Sachs, KGS and Swiss Re, the largest clients with no story.

## 5. Tracker fixes that raise accuracy now

Ordered by impact.

1. **Citi has no industry or HQ.** All 247 Citi rows in Joinees All say `CHECK`. Citi is therefore missing from every BFSI answer. Set Industry to BFSI and HQ to USA.
2. **85 clients have no industry**, 10 of them with joinees (AppViewX, Expedia, Analytical Wizard and others). `/api/copilot/health` lists them.
3. **Business unit is blank on 52% of joinees.** 1,106 rows have only a grade title ("Senior Consultant 1", "Manager"), so they cannot be counted as tech or non-tech, or found by skill. Filling this for EY GDS alone fixes most of it.
4. **Designation is blank on 45% of offer drops.** Drop analysis by role is half blind.
5. **Client Last Engagement:** the Engagement Model column is empty on every row, so "which clients are RPO" cannot be answered. 1,028 rows have dates but no client name.
6. **Offer Drop client names:** 77 do not match a Joinees client. Some are notes, not clients ("Final Select- NO JR yet", "Chaitra/Beena").
7. **TVH** is tagged Manufacturing on 68 rows and "Manufacturing & Engineering" on 1.
8. **FIS vs Fiserv:** the client normalizer maps "fis" to Fiserv. They are different companies and FIS has 36 joinees.

## 6. The normalizer scripts (.gs) point at the wrong columns

The four Apps Script normalizers use fixed column numbers from an older sheet layout.

| Script | Writes to | That column is now | Should be |
|---|---|---|---|
| `normalizeJoineesAllBusinessFunctionUnits` | Joinees L (12) | Designation | M (13) |
| `normalizeDesignations` | Joinees K (11) | Invoice Amount by Vibha | L (12) |
| `normalizeOfferDropAllClientFinal` | Offer Drop E (5) | FY | G (7) |
| `normalizeOfferDropAllRolesGranular` | Offer Drop H (8) | HQ Location | I (9) |

*Do not run the business unit one as it stands.* Its remove-list contains "Manager", "Consultant", "Senior", "Staff" and "Associate", so pointed at the Designation column it would blank 348 designations.

Make them find the column by header so this cannot happen again. Add this helper once:

```javascript
function colByHeader_(sheet, header) {
  const row = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const i = row.findIndex(h => String(h).trim().toLowerCase() === header.toLowerCase());
  if (i < 0) throw new Error('Column "' + header + '" not found in ' + sheet.getName());
  return i + 1;
}
```

Then replace the four hard-coded numbers:

```javascript
const targetCol = colByHeader_(sheet, 'Function/Role/Business Unit'); // was 12
const targetCol = colByHeader_(sheet, 'Client Cleaned');              // was 5
const targetCol = colByHeader_(sheet, 'Designation');                 // was 8 (Offer Drop)
// in normalizeDesignations(): const col = colByHeader_(sheet, 'Designation'); and use col in place of 11
```

## 7. Model settings

Set in Render, Environment.

| Variable | Value | Why |
|---|---|---|
| `LLM_API_KEY` | your key | unchanged |
| `LLM_MODEL` | `gemini-3.8-flash` | Primary model. If it is slow or rate-limited, the chain below covers it. |
| `LLM_REASONING_EFFORT` | `minimal` | Counting is done in code, so the model only phrases. If a model rejects `minimal`, the code steps up to `low` for that model by itself. |
| `LLM_FALLBACK_MODELS` | optional | Defaults to 3.6 Flash, then 3.5 Flash-Lite, then 3.1 Flash-Lite. |
| `LLM_HEDGE_MS` | optional, default `6000` | If the current model has not started writing by then, the next one starts alongside it. First to write wins. |
| `LLM_FIRST_TOKEN_MS` | optional, default `12000` | A model silent this long is dropped for that question. |
| `LLM_COOLDOWN_MS` | optional, default `300000` | A model that failed or lost a race by being silent is skipped for 5 minutes, so it costs one slow answer, not every answer. |

### Why an answer is slow

Retrieval takes well under a second. Nearly all wait time is the model. Open `/api/copilot/health` and read `models`:

- `ok: true` on every model: the model is just slow. Lower `LLM_REASONING_EFFORT`, or move a Flash-Lite model to the front of the chain.
- `coolingForSec` on the primary with a `429` in `lastError`: you are hitting the free-tier rate limit on that model. Put the model that keeps answering first in `LLM_MODEL`, or attach billing.
- `coolingForSec` with "silent" or "no answer": the model is overloaded at Google's end. The chain is already covering it.

Every streamed answer also carries `model` and, when something failed, `tried`, so you can see which model answered and what lost.

Free tier or paid: the free tier works. The reason to attach billing is data use and rate limits, not quality. Prompts carry client names, closure counts and billing figures.

To try another provider, change `LLM_BASE_URL`, `LLM_MODEL` and `LLM_API_KEY`. Any OpenAI-compatible endpoint works. Run the same ten questions on both and compare before switching.

## 8. Debugging one answer

```bash
node scripts/copilot-debug.js "java hires in bfsi last year"
node scripts/copilot-debug.js -v "diage"        # also prints the full context sent to the model
node scripts/copilot-debug.js --golden          # 34 regression questions, pass or fail
```

It needs the same env vars as the server. It does not call the model, so it is free and instant.

When you fix something, add the question to `scripts/golden.json` so it cannot silently break later. Run `--golden` before every deploy.

## 9. When code is the right fix

Only for these, all in `netlify/lib/kb.js`:

| Change | Constant |
|---|---|
| A word should not be searched as a skill | `STOPWORDS` or `GENERIC_SKILL` |
| A client name collides with an ordinary word | `COMPANY_MATCH_SKIP` or `WEAK_FIRST_WORD` |
| A synonym group for a skill family | `SKILL_GROUPS` |
| How designations group into tech and non-tech | `FAMILIES` |
| A new kind of question | `RE` and `classify()` |

The wording rules live in `SYSTEM` in `netlify/lib/copilot.js`. Change them last, and only for something that is wrong across many answers.

## 10. Endpoints

| Endpoint | Use |
|---|---|
| `POST /api/ask` | `{question, history, user, stream}`. With `stream: true` it returns server-sent events. |
| `POST /api/copilot/refresh` | Re-read the sheet now. Same as the Reload data button. |
| `GET /api/copilot/health` | Row counts, latest dates, model in use, clients with no industry. |
| `GET /api/copilot/gaps?days=30` | The weekly review. |
| `GET /api/feedback` | All votes with a summary by type, industry and month. |
