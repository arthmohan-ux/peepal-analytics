# Peepal BD Copilot — Knowledge Base Handover

**One rule above all:** the BD Copilot answers *only* from the Google Sheet. Nothing else. No internet, no model "general knowledge" for facts. If it isn't in the sheet, the bot doesn't know it. That means **the sheet is the product** — enrich the sheet and the bot gets smarter; leave it stale and the bot goes stale.

There are two kinds of tabs.

---

## 1. Data tabs — automatic, do NOT hand-edit for the bot

`Joinees All`, `Offer Drop All`, `Client Last Engagement`, and the 11 industry tabs.

You maintain these as you already do (monthly). The bot recomputes everything from them automatically: totals, per-company revenue/joinees/drops, designations, roles, seniority, skills, years of experience, HQ/geography, financial year, and clients-worked-with. **New closures, new companies, new skills appear on their own** within ~30 minutes (cache refresh). You never touch these tabs "for the bot."

---

## 2. Curated tabs — this is where you ENRICH the bot

Three tabs. Append a row to add knowledge. Never delete or rename the header row. No formulas.

### `Sources` — proof stories and selling techniques (10 columns)

| Column | What goes in it |
|---|---|
| `source_id` | Unique id. Continue the pattern: `CS-009`, `CS-010` for case studies; `M-008` for methods. |
| `type` | `case_study` (a delivered engagement you can narrate) · `proof_point` (a short punchy result) · `method` (a repeatable approach, not a single story) · `industry_insight` |
| `client` | The client's name **spelled exactly as in `Joinees All` (Client Cleaned)** so numbers fuse. Leave blank for a general method. |
| `industry` | The industry value as it appears in the data (e.g. `Consulting`, `BFSI`, `Telecom`, `IT Prod`, `Manufacturing`, `Pharma`, `Aviation`). Blank = industry-agnostic. |
| `problem` | The challenge — what you lead with on a call. |
| `intervention` | What Peepal did. |
| `result_client_safe` | **The wording the bot is allowed to say out loud to a client.** Keep it client-safe. |
| `result_internal` | Internal-only: exact/approx metrics, "do not name the incumbent", etc. **The bot will never say this to a client.** |
| `bd_usage` | When to pull this story (the "match the prospect's problem" trigger). |
| `tags` | Free keywords: `rpo, scale, compliance` … |

### `Doctrine` — ICP, services, commercials, targeting, PEEPAL Way (8 columns)

| Column | What goes in it |
|---|---|
| `id` | Unique id, continue `D-###`. |
| `category` | One of: `definition`, `icp_firmographic`, `excluded_industry`, `sweet_spot`, `service_term`, `service_line`, `service_fit`, `commercials`, `company`, `peepal_way`, `stage`, `converting`, `not_converting`, `sub_icp`, `contact`, `timing`, `key_designations` |
| `item` | Short label (the thing itself). |
| `detail` | The description. |
| `examples` | Named companies or examples (optional). |
| `action` | The recommended move / window / fit (optional). |
| `audience` | **`general`** = may be referenced near a client. **`internal`** = rep-only strategy the bot must never say aloud (targeting status, fee grid, converting/not-converting lists). When in doubt, use `internal`. |
| `tags` | Free keywords. |

### `Playbook` — how to sell (8 columns, same schema as Doctrine)

`category` is one of: `mindset`, `operating_model`, `research`, `first_call`, `discovery`, `meeting_prep`, `meeting_run`, `data_usage`, `delivery`, `followup`, `reliability`, `at_risk`, `reactivation`, `personal_dev`, `operating_rhythm`. These load only when someone asks a "how do I sell / what do I say" question.

---

## 3. What goes WHERE — quick decision guide

- A delivered client win you want to tell as a story → **Sources** (`case_study` or `proof_point`).
- A reusable selling move not tied to one client → **Sources** (`method`).
- A rule about who we target, our services, pricing, or the PEEPAL Way → **Doctrine**.
- Coaching on running a call/meeting/follow-up → **Playbook**.
- More closures / new clients / new skills → **nothing to do** — update the data tabs as usual; it flows automatically.

---

## 4. How to add a row (the actual process)

1. Draft the row content (use the LLM prompts in section 5).
2. In the target tab, click the first empty cell of a new row at the bottom.
3. Paste. If pasting TSV (tab-separated), it drops cleanly into columns. **Do not** disturb the header row.
4. Wait up to ~30 min (cache refresh) — or it appears on the next cold start.

**Formatting caution:** your text has commas, arrows, and line breaks. Always paste **tab-separated (TSV)**, not comma-separated, and keep each row on a single line (replace any internal line breaks with spaces). The LLM prompts below handle this for you.

---

## 5. LLM formatting prompts (paste into any LLM with your raw notes)

### For a new `Sources` row

```
You are formatting a knowledge row for Peepal Consulting's BD Copilot "Sources" tab.
Output EXACTLY ONE tab-separated (TSV) line, no header, values in this column order:
source_id, type, client, industry, problem, intervention, result_client_safe, result_internal, bd_usage, tags

Rules:
- type is one of: case_study, proof_point, method, industry_insight
- client must be the client name as it appears in our tracker, or blank for a general method
- industry is one of: Consulting, BFSI, Telecom, IT Prod, Manufacturing, Pharma, Aviation, IT Services, Media, FMCG, Real Estate (or blank)
- result_client_safe = ONLY wording safe to say to a client out loud
- result_internal = exact/approximate metrics and any "do not say" notes; never client-facing
- Replace any line breaks inside a field with a space. Separate the 10 fields with a TAB character. No commas used as delimiters.
- Use the next id after the highest existing one (tell me if unsure).

My raw notes:
<<< paste your notes here >>>
```

### For a new `Doctrine` row

```
You are formatting a knowledge row for Peepal Consulting's BD Copilot "Doctrine" tab.
Output EXACTLY ONE tab-separated (TSV) line, no header, values in this column order:
id, category, item, detail, examples, action, audience, tags

Rules:
- category is one of: definition, icp_firmographic, excluded_industry, sweet_spot, service_term, service_line, service_fit, commercials, company, peepal_way, stage, converting, not_converting, sub_icp, contact, timing, key_designations
- audience is "general" ONLY if it is safe to reference near a client; otherwise "internal" (targeting status, pricing, converting/not-converting lists are ALWAYS internal)
- Replace line breaks inside a field with a space. Separate the 8 fields with a TAB. No commas as delimiters.
- Use the next D-### id.

My raw notes:
<<< paste your notes here >>>
```

### For a new `Playbook` row

```
You are formatting a knowledge row for Peepal Consulting's BD Copilot "Playbook" tab (how-to-sell coaching).
Output EXACTLY ONE tab-separated (TSV) line, no header, values in this column order:
id, category, item, detail, examples, action, audience, tags

Rules:
- category is one of: mindset, operating_model, research, first_call, discovery, meeting_prep, meeting_run, data_usage, delivery, followup, reliability, at_risk, reactivation, personal_dev, operating_rhythm
- audience is usually "internal" (rep guidance)
- Replace line breaks inside a field with a space. Separate the 8 fields with a TAB. No commas as delimiters.
- Use the next P-### id.

My raw notes:
<<< paste your notes here >>>
```

---

## 6. Guardrail reminder

The `result_internal` field (Sources) and `audience=internal` rows (Doctrine/Playbook) are how the bot knows what it must **never say to a client** — exact case-study metrics, the fee grid, "skip / not-converting" company status. If something should never be spoken aloud on a call, it goes in `result_internal` or is marked `audience=internal`. When unsure, mark it internal.
