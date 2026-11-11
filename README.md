# ConexTek Sales CRM

Internal CRM where AI employees (via API) and people (via the web UI) record sales work. **It automates nothing**: it never sends messages, runs schedules, generates follow-ups, scrapes sites, assigns work or triggers AI. Work happens outside; employees then *record* it.

- **Stack:** Next.js (App Router) + TypeScript, SQLite/libSQL (file locally, Turso in production), Tailwind. One codebase serves the UI and the REST API (`/api/v1`).
- **Pages:** Dashboard · Leads · Lead detail · My Work · Today & Tomorrow · Approvals · Send approvals · Reports · Campaigns · Agent activity · Settings & Permissions · API guide.

## Run locally
```bash
npm install
cp .env.example .env.local     # set AUTH_SECRET, OWNER_PASSWORD
npm run dev                    # http://localhost:3000  (log in as OWNER_USERNAME)
npm test                       # 56 rule checks against a throwaway database
npm run seed:demo              # optional: labelled demo data (excluded from reports)
npm run seed:demo -- --remove  # delete it again
```
The database and the Owner account are created automatically on first start. The Owner must change the initial password at first sign-in.

## Deploy free (Vercel + Turso)
1. Create a Turso database (free): `turso db create conextek-crm` → `turso db show conextek-crm --url` and `turso db tokens create conextek-crm`.
2. Import the project into Vercel and set environment variables:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `libsql://…turso.io` |
| `DATABASE_AUTH_TOKEN` | Turso token |
| `AUTH_SECRET` | `openssl rand -base64 48` |
| `OWNER_USERNAME` / `OWNER_NAME` / `OWNER_PASSWORD` | the first Owner login (used only when the DB has no users) |
| `APP_TIMEZONE` | e.g. `Asia/Dubai` — defines "today" and report day/week/month boundaries |

3. Deploy. Tables are created on first request. Then open **Settings → Team** to add Chief/employees and **issue each AI employee their own API key**.

Notes: Vercel's free *Hobby* plan is licensed for non-commercial use — for company use you likely need Vercel Pro (or another Node host). The app uses Node APIs (`node:crypto`, bcryptjs) and has been built/tested for a Node runtime; Cloudflare Workers is **not** tested.

## Roles & rules (enforced server-side, same for UI and API)
- **Owner (Wisam):** everything.
- **Chief:** assigns work, reviews, adds employees, adjusts employee permissions (never beyond his own, never approval/assign/key rights), resets employee passwords, and issues/revokes **employee** API keys (permission `keys.manage`, which the Owner can switch off). Chief never sees or touches the Owner's or another Chief's keys.
- **Test data:** any lead can be flagged test (checkbox on creation, `is_test` in the API, or "Mark as test data" on the lead page for Owner/Chief). The lead, its tasks, history and approvals stay visible but are labelled TEST and are never counted in the dashboard or reports.
- **Lists:** Target markets (geography) and Customer segments (e.g. NC dealers, Chinese exporters) are separate lists, editable in Settings → Lists & stages.
- **Employees:** only leads assigned to them (unless granted *view all*) and only the actions enabled on their account. Presets (Researcher, Outreach, Read-only) + per-person toggles.
- Nobody can approve their own submission (Chief's own submissions go to Wisam). Items needing **Wisam** can only be decided by the Owner; which task types need Wisam is configured in Settings → Lists.
- *Approved ≠ sent.* Approval changes task status only. A send is recorded separately (`message.record_sent` permission) and only for things that already happened (no future timestamps).
- Stage changes require a short reason. Stages, markets, channels, industries, sources, services, languages and task types are editable; task statuses and activity outcomes are fixed.

## Reports — how numbers are counted
Only logged records; demo and test-flagged data excluded. Everything is counted on the date it **happened**, not the date it was entered: leads on `lead_date` (original date), sends/replies/stage changes on `occurred_at`, bounces on the bounce's own date. Bounce rate = bounces in the period ÷ sends in the period (first emails and follow-ups kept separate). Records with an **unknown** date are never placed in a period (never "today"); they only appear in the **All data** view (dashboard and reports), which also exists next to a custom from → to period. "Overdue" is a live snapshot.

## Historical data & original dates
- `leads.lead_date` (+ `lead_date_precision` day|time, NULL = unknown) is separate from `created_at` (entry day). Activities have `occurred_precision` (time|day|unknown). Leads existing before this feature have an unknown lead date until corrected.
- **Correct dates in bulk:** Historical data page (CSV: `lead_date` + id/external_id/website/company, optional `employee`) or `POST /api/v1/import/lead-dates`. Dry run first; only updates existing leads; each change audited (old → new); `created_at` untouched.
- **Import past records:** `POST /api/v1/import/history` (leads, messages, replies, bounces, do_not_contact). Dry run unless `"commit": true`; any error blocks the commit; duplicates skipped via `external_id` / website / company / email / natural key; do-not-contact and bounced states preserved (only ever escalated); original employee (`actor`/`created_by`) kept apart from `imported_by`; every import is an `import_batches` row plus an audit entry. Needs the `history.import` permission. Owner always; the Owner can grant it to a Chief/employee for 24h–90 days (Settings → user → Migration access, auto-expires, revocable, audited). It only opens the import / lead-date / reconcile endpoints.
- **Timestamps:** explicit `Z`/offset inputs keep the exact instant; zone-less times use the APP_TIMEZONE offset valid at that instant (ambiguous/skipped clock times are rejected); `POST /api/v1/import/activity-times` corrects existing event times (dry run, audited). Import batches: ≤100 records recommended; stuck batches answer 413, not 504.
- **Unknown original employee:** `employee: null` (stored NULL, never the importer). **Historical-only entities** (`historical_only`) keep suppressed companies on record without making them prospects. **Reconcile:** `POST /api/v1/import/reconcile-activities`. **Verification:** `GET /api/v1/reports`.

## API
For AI agents: `GET /api/v1/guide` (briefing), `GET /api/v1/openapi.json` (OpenAPI 3.1), `GET /api/v1/work/next` (what to do now) and `GET /api/v1/changes?since=` (what happened since the last run). An MCP server with the same abilities is at `POST /api/mcp`. Every call (reads, changes, refusals) is logged in `api_requests` and shown on the **Agent activity** page; agents group a run with the `X-Run-Id` header and make retries safe with `Idempotency-Key`. Errors carry a stable `code`.

See the in-app **API guide** (curl examples), or `GET /api/v1/lists`. Auth: `Authorization: Bearer ctk_…`. Keys act with the owning employee's exact permissions and stop working if the employee is disabled.

## Security notes
Passwords are bcrypt-hashed; API keys are stored hashed (shown once); sessions are signed httpOnly cookies and are invalidated by a password change; 5 failed logins lock an account for 15 minutes; CSV exports neutralise spreadsheet formulas; every administrative change is written to the read-only history (Settings → Change history). There is no e-mail based reset — Owner/Chief set (or generate) a password when creating an account or resetting one. Nobody is forced to change it; people can change their own under Account. Chief can add employees (not other Chiefs) with employee presets only.

## Campaign foundations (migration 5, additive)
Projects, campaigns, channels, lead↔campaign membership history, structured task planning fields (`scheduled_at`, `channel`, `action_type`, `prep_status`, `blockers`, `campaign_id`) and a read-only `legacy_archive` of notes/instructions. Nothing existing is changed; no lead is placed in a campaign without evidence (see `GET /api/v1/campaigns/unassigned`). Before touching production: `npx tsx scripts/baseline.ts --out data/baselines/before.json`, back up, test the restore with `scripts/restore-test.ts`, deploy, then `scripts/baseline.ts --compare data/baselines/before.json` must print RECONCILED. Details in `/api-docs#campaigns`.

### Phase 3 views
`/schedule` (Today & Tomorrow, filters, overdue/blocked/ready/planned/completed), `/campaigns` (report cards, status, review queue), lead page "Where this lead stands" panel with campaign transfer, task "Planning" card. Arabic/mixed text aligns per paragraph (`unicode-bidi: plaintext`). Report definitions: `GET /api/v1/campaigns/report` → `rules`.
