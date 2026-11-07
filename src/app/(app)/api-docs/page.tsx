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
          For data that already exists in spreadsheets, mailboxes or LinkedIn. Needs the <code>history.import</code> permission (Owner by default; the Owner may grant it to one trusted key).
          Everything is recorded with its <b>original date</b> and <b>original employee</b>; the importer and the day of import are stored separately. Nothing is sent or changed outside the CRM.
        </P>
        <ul className="mb-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
          <li><b>Dry run first.</b> Without <code>"commit": true</code> nothing is saved; you get a per-record result. With <code>commit</code>, nothing is saved if any record has an error — fix and resend the whole request.</li>
          <li><b>No duplicates.</b> Give each record a stable <code>external_id</code> (e.g. <code>"hunter-2025-0412"</code>). A record with an external_id already imported is skipped. Leads are also matched on website, company name or contact email; messages and replies on lead + channel + date + employee + contact + subject. Re-sending a chunk is safe.</li>
          <li><b>Do-not-contact is preserved.</b> Contacts with <code>email_status</code> <code>opted_out</code>/<code>bounced</code> (or <code>"do_not_contact": true</code>) keep that state, also on leads that already exist. A state is only ever made stricter, never relaxed.</li>
          <li><b>Unknown dates stay unknown</b> (omit the date or send <code>"unknown"</code>). Such records need an <code>external_id</code> and are not placed in any period.</li>
          <li>Max 200 records per request. Send leads before the messages that refer to them (or in the same request). References to a lead: <code>{`{"external_id":"…"}`}</code>, <code>{`{"id":12}`}</code>, <code>{`{"website":"…"}`}</code> or <code>{`{"company":"…"}`}</code>.</li>
          <li><code>employee</code> (a username) = who did the original work; set it once at the top or per record. Lists accept the key or the label.</li>
        </ul>
        <Fields rows={[
          ["label", "yes", "Name of this import, shown in the history."],
          ["commit", "optional", "true to save. Default: dry run."],
          ["employee", "yes (here or per record)", "Original employee username."],
          ["leads[]", "optional", <>company*, website, country, market, segment, industry, source, source_url, service, language, stage, notes, <code>lead_date</code>, external_id, employee, <code>contacts[]</code> (name, role, email, phone, linkedin, email_status, do_not_contact).</>],
          ["messages[]", "optional", <>lead*, <code>channel</code>* (email, linkedin…), <code>kind</code>* (first_email | follow_up | other), <code>sent_at</code>, subject, body, contact_email, external_id, employee, ref, url.</>],
          ["replies[]", "optional", <>lead* (or in_reply_to), <code>channel</code>*, <code>received_at</code>, body*, subject, contact_email, in_reply_to (external_id of the message), external_id, employee.</>],
          ["bounces[]", "optional", <><code>message_external_id</code>* (or <code>message_id</code>), <code>bounced_at</code>, note, external_id, employee.</>],
          ["do_not_contact[]", "optional", <>lead*, <code>email</code>*, status (opted_out | bounced), <code>at</code>, note, external_id.</>],
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
