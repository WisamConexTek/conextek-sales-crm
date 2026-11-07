import { headers } from "next/headers";
import type { ReactNode } from "react";
import { requireUser, can } from "@/lib/auth";
import { ALL_PERMISSIONS } from "@/lib/constants";
import { Card, PageHeader } from "@/components/ui";

const Code = ({ children }: { children: string }) => <pre className="overflow-x-auto rounded-md bg-slate-900 p-3 text-xs leading-relaxed text-slate-100">{children}</pre>;
const P = ({ children }: { children: ReactNode }) => <p className="mb-2 text-sm text-slate-700">{children}</p>;
const H = ({ children }: { children: ReactNode }) => <p className="mb-1 mt-4 text-sm font-semibold text-slate-900">{children}</p>;

/** [field, required?, accepted values / notes] */
function Fields({ rows }: { rows: [string, string, ReactNode][] }) {
  return (
    <table className="mb-3 w-full text-sm">
      <thead className="border-b border-slate-200"><tr><th className="th">Field</th><th className="th">Required</th><th className="th">Accepted values / notes</th></tr></thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map(([f, r, n]) => (
          <tr key={f}><td className="td font-mono text-xs font-semibold text-brand-700">{f}</td><td className="td text-xs">{r}</td><td className="td text-slate-600">{n}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

export default async function ApiDocs() {
  const me = await requireUser();
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "your-crm.example.com";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const base = `${proto}://${host}/api/v1`;
  const HD = `-H "Authorization: Bearer $CRM_API_KEY" -H "Content-Type: application/json"`;
  const endpoints: [string, string, string][] = [
    ["GET", "/me", "Who this key belongs to and what it may do."],
    ["GET", "/lists", "Valid values: stages, markets, segments, channels, task types, sources, services, users…"],
    ["GET", "/leads?q=&stage=&market=&segment=&owner=&channel=&page=", "Leads you can see (your own unless you have view-all)."],
    ["GET", "/leads/duplicates?company=&website=&email=", "Check before creating a lead."],
    ["POST", "/leads", "Create a lead (with optional contacts[] and lead_date)."],
    ["POST", "/import/history", "Historical import: leads, messages, replies, bounces, do_not_contact. Dry run unless commit:true. Needs history.import."],
    ["POST", "/import/reconcile-activities", "Attach external_id (and optionally correct the original employee) on existing activities. Dry run unless commit:true. Needs history.import."],
    ["GET", "/reports?all=1 | from=&to= | period=&at=&employee=", "Dashboard/report totals with timezone, unknown counts and counting rules."],
    ["POST", "/import/lead-dates", "Bulk-correct original lead dates of existing leads. Dry run unless commit:true. Needs history.import."],
    ["GET", "/leads/{id}", "Lead + contacts + full history + tasks."],
    ["PATCH", "/leads/{id}", "Update lead fields (only fields you send). Owner/Chief may also send is_test."],
    ["POST", "/leads/{id}/contacts", "Add a contact."],
    ["PATCH", "/contacts/{id}", "Update a contact, incl. email_status."],
    ["POST", "/leads/{id}/stage", "Record a stage change {stage, reason}. Reason is mandatory."],
    ["POST", "/leads/{id}/activities", "Record research, draft, message (sent), reply, outcome or note."],
    ["GET", "/tasks?open=1&status=&lead=&overdue=1&include_test=0", "Your tasks (managers can pass assignee=)."],
    ["POST", "/tasks", "Create a task (for yourself, or assign if permitted)."],
    ["GET", "/tasks/{id}", "One task with notes[], approvals[] and a chronological timeline[] (who, what, when)."],
    ["PATCH", "/tasks/{id}", "Update status (todo/in_progress), progress_note, or (managers) title/due/assignee."],
    ["POST", "/tasks/{id}/submit", "Submit a draft/findings for approval {kind, title?, content}."],
    ["POST", "/tasks/{id}/complete", "Mark done {note?}. Approved first if the task needs approval."],
    ["GET", "/approvals?status=pending&requires=chief&include_test=0", "Approvals queue (deciders see all; others see their own)."],
    ["GET", "/approvals/{id}", "One approval incl. submitter, decider and times."],
    ["POST", "/approvals/{id}/decision", "{decision, comment}. Deciders only."],
    ["POST", "/approvals/{id}/escalate", "Chief hands a pending item up to Wisam {comment}."],
  ];
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title="API guide" sub="For AI employees. Each employee has their own key; it can do only what their permissions allow." />
      <Card title="Ground rules">
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
          <li><b>The CRM does nothing on its own.</b> It never sends messages, schedules, follows up, scrapes or triggers AI. You do the work elsewhere, then <i>record</i> it.</li>
          <li><b>An approved draft is not a sent message.</b> Record a send (<code>type: "message"</code>) only after it really went out — and only if your key has <code>message.record_sent</code>.</li>
          <li>You cannot approve your own submission. Items marked <i>Wisam</i> can only be decided by Wisam. CRM approval does not override Wisam's rules about who may send or approve.</li>
          <li>Stage changes must reflect what actually happened and carry a short <code>reason</code>.</li>
          <li><b>Dates are the real dates.</b> <code>occurred_at</code> (and <code>lead_date</code> on leads) is when it <i>happened</i>, never the future. <code>"2025-03-14"</code> = that day, no hour; <code>"2025-03-14T09:30"</code> = exact time (APP_TIMEZONE); omitted <code>occurred_at</code> = just now; <code>"unknown"</code> = date not known. Unknown is kept as unknown — it is never turned into today, and is left out of period reports. Reports count each thing on the day it happened, not the day it was entered.</li>
          <li><b>Test data:</b> records with <code>"is_test": true</code> are labelled TEST in the app and are never counted in the dashboard or reports. Create a test lead with <code>"is_test": true</code>; its tasks, history and approvals follow it.</li>
          <li><b>IDs are shared:</b> the task and approval numbers you get here are the same ones shown in the app as “Task #12” / “Approval #5” (with a Copy link button). Quote them when you talk to the team.</li>
        </ul>
      </Card>
      <Card title="Authentication & responses">
        <P>Send your key on every request. Responses are JSON: <code>{`{"ok":true,"data":…}`}</code> or <code>{`{"ok":false,"error":"…"}`}</code> with an HTTP status (400 invalid, 401 bad key, 403 not permitted, 404 not found / not yours, 409 duplicate).</P>
        <Code>{`export CRM_API_KEY="ctk_xxxxxxxx_…"\ncurl ${HD} ${base}/me`}</Code>
        {me.role !== "owner" && <p className="mt-2 text-xs text-slate-500">Your web account can: {ALL_PERMISSIONS.filter((p) => can(me, p)).join(", ") || "view only"}.</p>}
      </Card>

      <Card title="The employee workflow, step by step">
        <P>Assignment → progress → findings → submit → review → complete. Every step below shows the exact request and what comes back. Replace the numbers with real IDs.</P>

        <H>1. Read your assignment</H>
        <Code>{`curl ${HD} "${base}/tasks?open=1"\ncurl ${HD} ${base}/tasks/17`}</Code>
        <P>Look at <code>instructions</code>, <code>due_at</code>, <code>lead_id</code>, <code>task_type</code>, <code>approval_from</code> (<code>chief</code>, <code>wisam</code> or <code>null</code> = no approval needed) and <code>change_request</code> (what the reviewer asked you to fix). <code>GET /tasks/17</code> adds <code>notes[]</code>, <code>approvals[]</code> and <code>timeline[]</code>.</P>
        <Code>{`{ "ok": true, "data": {
  "id": 17, "title": "Draft first email — Acme", "status": "todo", "lead_id": 42, "company": "Acme Ltd",
  "task_type": "first_email_draft", "approval_from": "chief", "instructions": "Under 90 words.",
  "due_at": "2026-11-09T20:59:00.000Z", "assignee_name": "Sara", "created_by_name": "Chief",
  "progress_note": null, "completion_note": null, "completed_at": null, "completed_by_name": null,
  "is_test": false, "notes": [], "approvals": [], "timeline": [ { "at": "…", "event": "task_created", "actor": "Chief", "text": "Assigned to Sara" } ]
} }`}</Code>

        <H>2. Update progress</H>
        <Fields rows={[
          ["status", "optional", <>Only <code>todo</code> or <code>in_progress</code> (or <code>cancelled</code> by whoever assigned it / a manager). A task waiting for approval can't be changed by hand.</>],
          ["progress_note", "optional", "Text, up to 4000 characters. Each new note is added to the task's note history — earlier notes are never overwritten."],
        ]} />
        <Code>{`curl -X PATCH ${HD} ${base}/tasks/17 -d '{"status":"in_progress","progress_note":"Researched Acme; drafting now."}'\n# → { "ok": true, "data": { "updated": true } }`}</Code>

        <H>3. Record findings on the lead (work you already did)</H>
        <Fields rows={[
          ["type", "yes", <><code>research</code>, <code>draft</code>, <code>note</code> for findings and drafts; also <code>message</code> (a send that really happened), <code>reply</code>, <code>outcome</code>.</>],
          ["title or body or url", "yes (one of)", "What you found or drafted."],
          ["task_id", "recommended", "Links the entry to your task so it appears in the task's history."],
          ["contact_id, channel, ref, url, occurred_at", "optional", <><code>channel</code> must be one of GET /lists → channel. <code>occurred_at</code> is ISO time, never in the future.</>],
        ]} />
        <Code>{`curl -X POST ${HD} ${base}/leads/42/activities -d '{\n  "type": "research", "task_id": 17, "title": "Company profile",\n  "body": "50 staff, dealer group, uses Cars.com listings.", "url": "https://acme.com/about"\n}'\n# → { "ok": true, "data": { "id": 311, "warnings": [] } }`}</Code>

        <H>4. Submit for approval</H>
        <Fields rows={[
          ["kind", "yes", <>Exactly one of <code>draft</code> (a message draft), <code>findings</code> (research results), <code>other</code> (anything else, e.g. a pricing proposal).</>],
          ["content", "yes", "3–30000 characters. The full draft or findings — the reviewer reads this, not your earlier notes."],
          ["title", "optional", "Up to 200 characters. Defaults to the task title."],
        ]} />
        <P>Only the assignee can submit, only while the task is <code>todo</code>, <code>in_progress</code> or <code>changes_requested</code>, and only if the task needs approval. A Chief's own submissions go to Wisam.</P>
        <Code>{`curl -X POST ${HD} ${base}/tasks/17/submit -d '{\n  "kind": "draft", "title": "First email — Acme",\n  "content": "Subject: Quick question\\n\\nHi Jo, …"\n}'\n# → { "ok": true, "data": { "approval_id": 5 } }   task is now "waiting_approval"`}</Code>

        <H>5. Review (Chief or Wisam — a key with approvals.decide)</H>
        <Fields rows={[
          ["decision", "yes", <><code>approved</code>, <code>rejected</code> (task is cancelled) or <code>changes_requested</code> (task goes back to the employee).</>],
          ["comment", "yes unless approved", "Say what is wrong or what to change. The employee sees it as change_request."],
        ]} />
        <Code>{`curl ${HD} "${base}/approvals?status=pending&requires=chief"\ncurl ${HD} ${base}/approvals/5\n\ncurl -X POST ${HD} ${base}/approvals/5/decision -d '{"decision":"changes_requested","comment":"Shorten the opening line."}'\n# → { "ok": true, "data": { "decided": true } }\n\n# Chief hands a Chief-level item up to Wisam:\ncurl -X POST ${HD} ${base}/approvals/5/escalate -d '{"comment":"Mentions pricing — needs Wisam."}'`}</Code>
        <P>You can't decide your own submission. Items that need Wisam can only be decided by Wisam. Approving does <b>not</b> send anything.</P>
        <P>Each approval returns who and when: <code>submitted_by_name</code>, <code>submitted_at</code>, <code>decided_by_name</code>, <code>decided_at</code>, <code>status</code>, <code>comment</code>.</P>

        <H>6. After a change request: fix and resubmit</H>
        <Code>{`curl -X POST ${HD} ${base}/tasks/17/submit -d '{"kind":"draft","content":"Subject: Hi\\n\\nShorter text…"}'`}</Code>

        <H>7. Complete the task</H>
        <P>If the task needs approval it must be <code>approved</code> first. If the work involved a real send, record it first (<code>type: "message"</code>, see below), then complete.</P>
        <Fields rows={[["note", "optional", "What was done. Saved as the completion note; your earlier progress notes stay available."]]} />
        <Code>{`curl -X POST ${HD} ${base}/tasks/17/complete -d '{"note":"Sent from the sales mailbox at 09:30."}'\n# → { "ok": true, "data": { "completed": true } }\ncurl ${HD} ${base}/tasks/17     # completed_by_name, completed_at, completion_note, notes[], approvals[], timeline[]`}</Code>
      </Card>

      <Card title="Other things you may record">
        <Fields rows={[
          ["message (sent)", "needs message.record_sent", <><code>type:"message"</code>, <code>message_kind</code> = <code>first_email</code> | <code>follow_up</code> | <code>other</code> (required), plus body/title/ref/url. Only after it was really sent.</>],
          ["reply", "—", <><code>type:"reply"</code> with body, ref or url; optional <code>parent_id</code> (the message it answers).</>],
          ["outcome", "—", <><code>type:"outcome"</code>, <code>parent_id</code> = the sent message, <code>outcome</code> = <code>bounced</code> | <code>no_response_yet</code> | <code>opted_out</code>.</>],
          ["stage change", "needs leads.stage", <>POST /leads/{"{id}"}/stage with <code>stage</code> (see GET /lists → stage) and a short <code>reason</code>.</>],
        ]} />
        <Code>{`curl -X POST ${HD} ${base}/leads/42/activities -d '{\n  "type": "message", "message_kind": "first_email", "channel": "email", "task_id": 17,\n  "contact_id": 9, "title": "Quick question", "body": "…exact text sent…",\n  "ref": "<message-id@mail.example>", "occurred_at": "2026-11-07T09:30:00Z"\n}'\n\ncurl -X POST ${HD} ${base}/leads/42/activities -d '{"type":"outcome","outcome":"bounced","parent_id":105}'\ncurl -X POST ${HD} ${base}/leads/42/stage -d '{"stage":"replied","reason":"Jo replied asking for pricing"}'`}</Code>
      </Card>

      <Card title="Creating leads (with ConexTek categories)">
        <Fields rows={[
          ["company", "yes", "Company name. Duplicates (same company, website or contact email) return 409 unless allow_duplicate is true."],
          ["market", "optional", <>Geography only — a key from GET /lists → <code>market</code> (e.g. <code>china</code>, <code>uae</code>, <code>ksa</code>, <code>qatar</code>, <code>kuwait</code>, <code>bahrain</code>, <code>oman</code>).</>],
          ["segment", "optional", <>Customer type, kept separate from market — GET /lists → <code>segment</code> (e.g. <code>nc_dealers</code>, <code>chinese_exporters</code>).</>],
          ["industry, service, source, language, stage", "optional", "Keys from GET /lists (industry: automotive, manufacturing_export…; service: customer_care, after_hours_bdc, sales_representation; source: canton_fair, cars_com, hunter, apollo…)."],
          ["lead_date", "optional", <>When the lead was really found/created: <code>YYYY-MM-DD</code>, <code>YYYY-MM-DDTHH:mm</code> or <code>"unknown"</code>. Omitted = found today. Can be changed later with PATCH /leads/{"{id}"}.</>],
          ["owner_id, next_action, next_due_at, notes, contacts[]", "optional", "contacts[] items: name (required), role, email, phone, linkedin."],
          ["is_test", "optional", <><code>true</code> for test leads: labelled TEST, skipped by duplicate checks, excluded from reports.</>],
        ]} />
        <Code>{`curl ${HD} "${base}/leads/duplicates?company=Acme&website=acme.com"\n\ncurl -X POST ${HD} ${base}/leads -d '{\n  "company": "Acme Motors", "website": "https://acme.example", "country": "USA",\n  "market": "china", "segment": "nc_dealers", "industry": "automotive",\n  "service": "after_hours_bdc", "source": "cars_com", "source_url": "https://www.cars.com/…",\n  "contacts": [{"name": "Jo Smith", "role": "GM", "email": "jo@acme.example"}]\n}'\n# → { "ok": true, "data": { "id": 42 } }`}</Code>
      </Card>


      <div id="history" />
      <Card title="Importing historical records (past leads, sends, replies, bounces)">
        <P>
          For data that already exists in spreadsheets, mailboxes or LinkedIn. Needs the <code>history.import</code> permission (Owner always; see “Authorizing Chief” below).
          Everything is recorded with its <b>original date</b> and <b>original employee</b>; the importer and the day of import are stored separately. Nothing is sent or changed outside the CRM.
        </P>
        <ul className="mb-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
          <li><b>Dry run first.</b> Without <code>"commit": true</code> nothing is saved; you get a per-record result. With <code>commit</code>, nothing is saved if any record has an error — fix and resend the whole request.</li>
          <li><b>No duplicates.</b> Give each record a stable <code>external_id</code> (e.g. <code>"hunter-2025-0412"</code>). A record with an external_id already imported is skipped. Leads are also matched on website, company name or contact email; messages and replies on lead + channel + date + employee + contact + subject. Re-sending a chunk is safe.</li>
          <li><b>Do-not-contact is preserved.</b> Contacts with <code>email_status</code> <code>opted_out</code>/<code>bounced</code> (or <code>"do_not_contact": true</code>) keep that state, also on leads that already exist. A state is only ever made stricter, never relaxed.</li>
          <li><b>Unknown dates stay unknown</b> (omit the date or send <code>"unknown"</code>). Such records need an <code>external_id</code> and are not placed in any period.</li>
          <li>Max 200 records per request. Send leads before the messages that refer to them (or in the same request). References to a lead: <code>{`{"external_id":"…"}`}</code>, <code>{`{"id":12}`}</code>, <code>{`{"website":"…"}`}</code> or <code>{`{"company":"…"}`}</code>.</li>
          <li><b>Original employee.</b> <code>employee</code> = who did the original work: a username, or <code>null</code> (also <code>"unknown"</code>) when it is not known. Set it once at the top level and/or per record (a record value wins; <code>"employee": null</code> on a record overrides a named top-level value). It is <b>required</b> somewhere — leaving it out is an error, so unknown is always a deliberate choice. Unknown is stored as empty: it is never replaced by the importer, the lead owner or the assignee. <code>imported_by</code> is always filled from the API key owner. Unknown-actor records show as “Unknown original employee”, are included in all totals and credited to nobody. Replies and bounces that omit <code>employee</code> inherit the original employee of the message they belong to (even if that is unknown). <code>do_not_contact[]</code> follows the same rule.</li>
          <li>Lists accept the key or the label.</li>
        </ul>
        <Fields rows={[
          ["label", "yes", "Name of this import, shown in the history."],
          ["commit", "optional", "true to save. Default: dry run."],
          ["employee", "yes (here or per record)", "Original employee username."],
          ["leads[]", "optional", <>company*, website, country, market, segment, industry, source, source_url, service, language, stage, notes, <code>lead_date</code>, external_id, employee, <code>historical_only</code> (true = suppressed/past-reply-only entity, see below), <code>contacts[]</code> (name, role, email, phone, linkedin, email_status, do_not_contact).</>],
          ["messages[]", "optional", <>lead*, <code>channel</code>* (email, linkedin…), <code>kind</code>* (first_email | follow_up | other), <code>sent_at</code>, subject, body, contact_email, external_id, employee, ref, url.</>],
          ["replies[]", "optional", <>lead* (or in_reply_to), <code>channel</code>*, <code>received_at</code>, body*, subject, contact_email, in_reply_to (external_id of the message — may have been imported in an earlier batch) or in_reply_to_id (CRM activity id), external_id, employee, not_activity_ids.</>],
          ["bounces[]", "optional", <><code>message_external_id</code>* (or <code>message_id</code> = CRM activity id), <code>bounced_at</code>, optional <code>kind</code> (checked against the message), note, external_id, employee.</>],
          ["do_not_contact[]", "optional", <>lead*, <code>email</code>*, status (opted_out | bounced), <code>at</code>, note, external_id, <code>employee</code> (same rule as everywhere: username or null; falls back to the top-level value). One entry per address — a company can have many.</>],
        ]} />
        <Code>{`curl -X POST ${HD} ${base}/import/history -d '{
  "label": "Canton Fair 2025 outreach", "employee": "sara", "commit": false,
  "leads": [{ "external_id": "cf25-001", "company": "Acme Motors", "website": "acme.example",
              "market": "china", "segment": "chinese_exporters", "source": "canton_fair", "lead_date": "2025-04-15",
              "contacts": [{ "name": "Jo", "email": "jo@acme.example" }, { "email": "old@acme.example", "do_not_contact": true }] }],
  "messages": [{ "external_id": "cf25-001-m1", "lead": { "external_id": "cf25-001" }, "channel": "email", "kind": "first_email",
                 "sent_at": "2025-04-16T09:30", "contact_email": "jo@acme.example", "subject": "Quick question", "body": "…" }],
  "replies":  [{ "external_id": "cf25-001-r1", "lead": { "external_id": "cf25-001" }, "in_reply_to": "cf25-001-m1",
                 "channel": "email", "received_at": "2025-04-18", "body": "Send pricing, please." }],
  "bounces":  [{ "external_id": "cf25-001-b1", "message_external_id": "cf25-001-m1", "bounced_at": "2025-04-16" }]
}'
# → { "ok": true, "data": { "committed": false, "dry_run": true, "counts": { "leads": { "created": 1, … } }, "results": { "leads": [ { "index": 0, "status": "created", … } ], … } } }
# Same body with "commit": true saves it. Each result is created | exists | duplicate | error.`}</Code>

        <H>Authorizing Chief (no shared Owner credentials)</H>
        <ol className="mb-2 list-decimal space-y-1 pl-5 text-sm text-slate-700">
          <li>Owner: Settings → People → open the Chief → <b>API access</b> → create a key for the Chief (Owner may create keys for anyone; Chief can only create employee keys).</li>
          <li>Owner: same page → <b>Migration access</b> → “Grant for 24 hours / 7 days / 30 days”. This turns on <code>history.import</code> for that person until the end of the period; it switches itself off. “Revoke now” ends it immediately. Both are audited.</li>
          <li>Chief runs the migration with <b>their own</b> key (dry run first). When finished, the Owner revokes (or it expires).</li>
        </ol>
        <P><code>history.import</code> only opens <code>POST /import/history</code>, <code>/import/lead-dates</code> and <code>/import/reconcile-activities</code>. It gives no permission management, no Owner functions, no key access for others and no way to send anything (these imports only record history; nothing is sent, scheduled or triggered). Chief cannot grant it to anyone.</P>

        <H>Suppressed / historical-only entities</H>
        <P>For companies or contacts that must stay on record (they replied, bounced or opted out) but must never be outreach prospects: add them in <code>leads[]</code> with <code>"historical_only": true</code> and their contacts with <code>email_status</code> <code>opted_out</code> / <code>bounced</code> (or <code>do_not_contact: true</code>) — one contact per address. Then attach their historical replies/bounces/sends with the normal <code>replies[]</code>, <code>bounces[]</code>, <code>messages[]</code>. A historical-only entity is hidden from default lead lists (<code>GET /leads?include_historical=1</code> shows it), excluded from stage counts and “leads added”, labelled HISTORICAL ONLY, and no task can be assigned on it. Its replies and bounces still count on their own dates. Suppression states are permanent: imports and duplicate matches only ever make a state stricter (<code>unknown → ok → bounced → opted_out</code>); an employee cannot clear one, and only the Owner or Chief can make an explicit, audited correction (<code>PATCH /contacts/{"{id}"}</code>). Existing leads can be flagged by Owner/Chief with <code>PATCH /leads/{"{id}"}</code> <code>{`{"historical_only":true}`}</code>.</P>

        <H>Matching rules (messages, replies, bounces)</H>
        <ul className="mb-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
          <li><b>LinkedIn / non-email first messages.</b> <code>kind</code> is only <code>first_email</code>, <code>follow_up</code> or <code>other</code>, and reports count by kind regardless of channel. Use <code>first_email</code> / <code>follow_up</code> only for messages you want inside the first-email / follow-up send counts and bounce denominators; use <code>other</code> (with <code>channel: "linkedin"</code>) for LinkedIn openers and anything else you want kept as history but outside those metrics. LinkedIn replies still count as replies.</li>
          <li><b>Reply totals</b> count every inbound reply record (<code>replies</code>), not conversations. <code>reply_leads</code> in the report API is the number of distinct leads with a reply. Neither is “first replies only”.</li>
          <li><b>Reply → message.</b> <code>in_reply_to</code> = the message’s <code>external_id</code> (works across batches once that batch is committed), or <code>in_reply_to_id</code> = its CRM activity id. It must be a sent message of the same lead and not later than the reply. Unresolvable → per-record error.</li>
          <li><b>Bounce → exact message.</b> <code>message_external_id</code> (or <code>message_id</code>) is required; the bounce becomes a child of that message and takes its kind, so a bounce of a follow-up is a follow-up bounce. Pointing at a reply, a missing message or giving a contradicting <code>kind</code> is an error. There is no matching by lead/contact/date.</li>
          <li><b>Unknown dates + chronology.</b> “Bounce/reply not earlier than its message” is checked only when both dates are known (a date-only value is compared by day). An unknown message date never blocks a dated bounce. Unknown-date records need an <code>external_id</code> and are never in dated periods.</li>
          <li><b>Duplicates.</b> (1) same <code>external_id</code> → <code>exists</code>; (2) identical natural key (lead, type, channel, kind, contact, subject and the same stored day/time) → <code>exists</code>; the actor is not part of the key, so an unknown or different original employee cannot create a duplicate. (3) An earlier activity entered <i>without</i> an external_id (e.g. the regular API) on the same local day that could be the same event (date-only vs exact time, missing channel/subject) is <b>not guessed</b>: you get an error naming its id(s). Fix it with <code>/import/reconcile-activities</code>, or add the ids to <code>not_activity_ids</code> on the record to say they are different events. <code>allow_duplicate</code> only affects lead matching, never activities.</li>
        </ul>

        <H>Reconcile activities already in the CRM</H>
        <P>Attach a stable <code>external_id</code> to an existing activity (so re-importing it is recognised) and, only if you have evidence, correct its original employee. Date, type, text and lead are never touched; nothing is created or deleted. The person who recorded it stays on record as <code>imported_by</code>. Dry run unless <code>"commit": true</code>; any error blocks the commit. <code>lead_id</code> and <code>type</code> are optional safety checks. <code>employee</code> omitted = unchanged, <code>null</code> = unknown.</P>
        <Code>{`curl -X POST ${HD} ${base}/import/reconcile-activities -d '{
  "label": "Attach ids to the two existing replies", "commit": false,
  "records": [ { "activity_id": 451, "external_id": "steelmate-reply-2026-11-03", "lead_id": 9,  "type": "reply" },
               { "activity_id": 452, "external_id": "boya-reply-2026-11-04",      "lead_id": 90, "type": "reply" } ]
}'
# Correct only the original employee of a lead / its dates use POST /import/lead-dates (employee: "sara" | null).`}</Code>

        <H>Lead dates: keeping unknown dates unknown</H>
        <P>In <code>/import/lead-dates</code>, <code>"lead_date": "unknown"</code> (or <code>null</code>) means “still unknown”: a lead that is already unknown comes back <code>unchanged</code>. Never send the first-email date, a file date or the import date as a lead date. <code>employee</code> alone (without <code>lead_date</code>) corrects only the original employee (<code>null</code> = unknown); the previous value is kept as <code>imported_by</code>. <code>created_at</code> never changes.</P>

        <H>Verifying totals: GET /api/v1/reports</H>
        <P>Read-only; the same numbers as the Dashboard/Reports pages. Params: <code>all=1</code> (since the beginning) · <code>from=YYYY-MM-DD&amp;to=YYYY-MM-DD</code> · <code>period=day|week|month&amp;at=YYYY-MM-DD</code>; optional <code>employee=&lt;id|username|unknown&gt;</code>. Without team-report rights you only see your own numbers.</P>
        <Code>{`curl ${HD} "${base}/reports?all=1"
curl ${HD} "${base}/reports?from=2026-11-01&to=2026-11-30&employee=unknown"
# → data: { view, from, to, timezone, totals{leads_added, first_emails, first_email_bounces, follow_ups, follow_up_bounces,
#           first_email_cohort_bounces, follow_up_cohort_bounces, replies, reply_leads, meetings, won, lost, completed},
#           rates{first_email_bounce_rate, follow_up_bounce_rate, *_cohort_bounce_rate}, unknown{…}, unknown_counts{leads,activities},
#           by_employee[{employee_id, name, …}], buckets[…], rules{…} }`}</Code>
        <ul className="mb-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
          <li><b>Timezone.</b> <code>timezone</code> = APP_TIMEZONE. A day is 00:00–24:00 local; <code>to</code> is inclusive. A date-only event is stored at local midnight.</li>
          <li><b>Dates.</b> Leads on <code>lead_date</code>, sends/replies/stage changes on <code>occurred_at</code>, bounces on the bounce’s own date, tasks on completion — never on entry/import time.</li>
          <li><b>Unknowns.</b> Unknown-date records are never in dated periods; they are in <code>unknown_counts</code> and, with <code>all=1</code>, in <code>totals</code> plus the separate <code>unknown</code> row. Unknown original employees appear as id 0 “Unknown original employee” (<code>employee=unknown</code>) and in totals; the importer is never credited.</li>
          <li><b>Sends &amp; bounce rates.</b> First emails and follow-ups are counted separately by <code>kind</code>. Event-basis rate = bounces dated in the period ÷ sends dated in the period. A late bounce therefore lands in the <i>later</i> period, and the rate can mix cohorts; <code>*_cohort_bounces</code>/<code>*_cohort_bounce_rate</code> instead count messages <i>sent</i> in the period that have a bounce (any date).</li>
          <li><b>Excluded.</b> Test data always; historical-only entities are not counted as leads added (their replies/bounces still count on their dates).</li>
        </ul>

        <H>Correct dates on leads that are already in the CRM</H>
        <P>Match by <code>id</code>, <code>external_id</code>, <code>website</code> or <code>company</code>. Nothing is created, deleted or duplicated; the entry date stays; each change is written to the audit history with the old and new date. Optional <code>employee</code> sets who originally found the lead. (There is also a CSV tool under Historical data in the app.)</P>
        <Code>{`curl -X POST ${HD} ${base}/import/lead-dates -d '{
  "label": "Hunter export dates", "commit": false,
  "records": [ { "website": "acme.example", "lead_date": "2025-04-15" }, { "id": 17, "lead_date": "2025-02-03", "employee": "sara" } ]
}'`}</Code>
      </Card>

      <Card title="All endpoints">
        <table className="w-full text-sm"><tbody className="divide-y divide-slate-100">
          {endpoints.map(([m, p, d]) => <tr key={m + p}><td className="td w-16 font-mono text-xs font-semibold text-brand-700">{m}</td><td className="td font-mono text-xs">{p}</td><td className="td text-slate-600">{d}</td></tr>)}
        </tbody></table>
        <p className="mt-2 text-xs text-slate-500">Lists of leads, tasks and approvals include test records (<code>is_test: true</code>) so you can work on them; add <code>include_test=0</code> to leave them out.</p>
      </Card>
    </div>
  );
}
