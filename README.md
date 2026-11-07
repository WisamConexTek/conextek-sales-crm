# ConexTek Sales CRM

Internal CRM where AI employees (via API) and people (via the web UI) record sales work. **It automates nothing**: it never sends messages, runs schedules, generates follow-ups, scrapes sites, assigns work or triggers AI. Work happens outside; employees then *record* it.

- **Stack:** Next.js (App Router) + TypeScript, SQLite/libSQL (file locally, Turso in production), Tailwind. One codebase serves the UI and the REST API (`/api/v1`).
- **Pages:** Dashboard · Leads · Lead detail · My Work · Approvals · Reports · Settings & Permissions · API guide.

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
- **Chief:** assigns work, reviews, adjusts employee permissions (never beyond his own, never approval/assign rights), resets employee passwords.
- **Employees:** only leads assigned to them (unless granted *view all*) and only the actions enabled on their account. Presets (Researcher, Outreach, Read-only) + per-person toggles.
- Nobody can approve their own submission (Chief's own submissions go to Wisam). Items needing **Wisam** can only be decided by the Owner; which task types need Wisam is configured in Settings → Lists.
- *Approved ≠ sent.* Approval changes task status only. A send is recorded separately (`message.record_sent` permission) and only for things that already happened (no future timestamps).
- Stage changes require a short reason. Stages, markets, channels, industries, sources, services, languages and task types are editable; task statuses and activity outcomes are fixed.

## Reports — how numbers are counted
Only logged records; demo data excluded. First-email and follow-up counts and bounce rates are separate. Bounce rate = sends in the period with a recorded bounce ÷ sends in the period. Meetings/Won/Lost = stage changes into a stage flagged that way. "Overdue" is a live snapshot.

## API
See the in-app **API guide** (curl examples), or `GET /api/v1/lists`. Auth: `Authorization: Bearer ctk_…`. Keys act with the owning employee's exact permissions and stop working if the employee is disabled.

## Security notes
Passwords are bcrypt-hashed; API keys are stored hashed (shown once); sessions are signed httpOnly cookies and are invalidated by a password change; 5 failed logins lock an account for 15 minutes; CSV exports neutralise spreadsheet formulas; every administrative change is written to the read-only history (Settings → Change history). There is no e-mail based reset — Owner/Chief issue a temporary password that must be changed at next sign-in.
