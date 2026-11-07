import { headers } from "next/headers";
import { requireUser, can } from "@/lib/auth";
import { ALL_PERMISSIONS } from "@/lib/constants";
import { Card, PageHeader } from "@/components/ui";

const Code = ({ children }: { children: string }) => <pre className="overflow-x-auto rounded-md bg-slate-900 p-3 text-xs leading-relaxed text-slate-100">{children}</pre>;

export default async function ApiDocs() {
  const me = await requireUser();
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "your-crm.example.com";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const base = `${proto}://${host}/api/v1`;
  const H = `-H "Authorization: Bearer $CRM_API_KEY" -H "Content-Type: application/json"`;
  const endpoints: [string, string, string][] = [
    ["GET", "/me", "Who this key belongs to and what it may do."],
    ["GET", "/lists", "Valid values: stages, markets, channels, task types, users…"],
    ["GET", "/leads?q=&stage=&market=&owner=&channel=&page=", "Leads you can see (your own unless you have view-all)."],
    ["GET", "/leads/duplicates?company=&website=&email=", "Check before creating a lead."],
    ["POST", "/leads", "Create a lead (with optional contacts[])."],
    ["GET", "/leads/{id}", "Lead + contacts + full history + tasks."],
    ["PATCH", "/leads/{id}", "Update lead fields (only fields you send)."],
    ["POST", "/leads/{id}/contacts", "Add a contact."],
    ["PATCH", "/contacts/{id}", "Update a contact, incl. email_status."],
    ["POST", "/leads/{id}/stage", "Record a stage change {stage, reason}. Reason is mandatory."],
    ["POST", "/leads/{id}/activities", "Record research, draft, message (sent), reply, outcome or note."],
    ["GET", "/tasks?open=1&status=&lead=&overdue=1", "Your tasks (managers can pass assignee=)."],
    ["POST", "/tasks", "Create a task (for yourself, or assign if permitted)."],
    ["GET", "/tasks/{id}", "One task incl. instructions and requested changes."],
    ["PATCH", "/tasks/{id}", "Update status (todo/in_progress), progress_note, or (managers) title/due/assignee."],
    ["POST", "/tasks/{id}/submit", "Submit a draft/findings for approval {kind, title?, content}."],
    ["POST", "/tasks/{id}/complete", "Mark done {note?}. Approved first if the task needs approval."],
    ["GET", "/approvals?status=pending&requires=chief", "Approvals queue (deciders see all; others see their own)."],
    ["POST", "/approvals/{id}/decision", "{decision: approved|rejected|changes_requested, comment}. Deciders only."],
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
          <li><code>occurred_at</code> may be in the past but never the future.</li>
        </ul>
      </Card>
      <Card title="Authentication">
        <p className="mb-2 text-sm text-slate-700">Send your key on every request. Responses are JSON: <code>{`{"ok":true,"data":…}`}</code> or <code>{`{"ok":false,"error":"…"}`}</code> with an HTTP status (400 invalid, 401 bad key, 403 not permitted, 404 not found / not yours, 409 duplicate).</p>
        <Code>{`export CRM_API_KEY="ctk_xxxxxxxx_…"\ncurl ${H} ${base}/me`}</Code>
        {me.role !== "owner" && <p className="mt-2 text-xs text-slate-500">Your web account can: {ALL_PERMISSIONS.filter((p) => can(me, p)).join(", ") || "view only"}.</p>}
      </Card>
      <Card title="Endpoints">
        <table className="w-full text-sm"><tbody className="divide-y divide-slate-100">
          {endpoints.map(([m, p, d]) => <tr key={m + p}><td className="td w-16 font-mono text-xs font-semibold text-brand-700">{m}</td><td className="td font-mono text-xs">{p}</td><td className="td text-slate-600">{d}</td></tr>)}
        </tbody></table>
      </Card>
      <Card title="Examples (copy & paste)">
        <div className="space-y-4">
          <div><p className="mb-1 text-sm font-medium">1. Check for a duplicate, then create a lead</p>
            <Code>{`curl ${H} "${base}/leads/duplicates?company=Acme&website=acme.com"\n\ncurl -X POST ${H} ${base}/leads -d '{\n  "company": "Acme Ltd", "website": "https://acme.com", "country": "UAE",\n  "market": "uae", "industry": "technology", "language": "en",\n  "source": "linkedin", "source_url": "https://linkedin.com/company/acme",\n  "service": "website", "next_action": "Find decision maker", "next_due_at": "2026-12-01",\n  "contacts": [{"name": "Jo Smith", "role": "CTO", "email": "jo@acme.com", "linkedin": "https://linkedin.com/in/jo"}]\n}'`}</Code></div>
          <div><p className="mb-1 text-sm font-medium">2. Record research</p>
            <Code>{`curl -X POST ${H} ${base}/leads/42/activities -d '{\n  "type": "research", "title": "Company profile",\n  "body": "50 staff, uses Shopify, no CRM visible.", "url": "https://acme.com/about"\n}'`}</Code></div>
          <div><p className="mb-1 text-sm font-medium">3. Submit a draft for approval (task assigned by Chief)</p>
            <Code>{`curl ${H} "${base}/tasks?open=1"\n\ncurl -X POST ${H} ${base}/tasks/17/submit -d '{\n  "kind": "draft", "title": "First email — Acme",\n  "content": "Subject: Quick question\\n\\nHi Jo, …"\n}'`}</Code></div>
          <div><p className="mb-1 text-sm font-medium">4. After approval AND after it was really sent: record the send, then complete the task</p>
            <Code>{`curl -X POST ${H} ${base}/leads/42/activities -d '{\n  "type": "message", "message_kind": "first_email", "channel": "email",\n  "contact_id": 9, "title": "Quick question", "body": "…exact text sent…",\n  "ref": "<message-id@mail.example>", "occurred_at": "2026-11-07T09:30:00Z"\n}'\n\ncurl -X POST ${H} ${base}/tasks/17/complete -d '{"note": "Sent from sales mailbox"}'`}</Code></div>
          <div><p className="mb-1 text-sm font-medium">5. Record a bounce / reply / stage change</p>
            <Code>{`# bounce of message activity 105\ncurl -X POST ${H} ${base}/leads/42/activities -d '{"type":"outcome","outcome":"bounced","parent_id":105}'\n\n# reply\ncurl -X POST ${H} ${base}/leads/42/activities -d '{"type":"reply","contact_id":9,"body":"Thanks — can you send pricing?"}'\n\n# stage change (reason required)\ncurl -X POST ${H} ${base}/leads/42/stage -d '{"stage":"replied","reason":"Jo replied asking for pricing"}'`}</Code></div>
          <div><p className="mb-1 text-sm font-medium">6. Chief: review</p>
            <Code>{`curl ${H} "${base}/approvals?status=pending"\ncurl -X POST ${H} ${base}/approvals/5/decision -d '{"decision":"changes_requested","comment":"Shorten the opening line."}'`}</Code></div>
        </div>
      </Card>
    </div>
  );
}
