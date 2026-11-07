import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser, can, isManager } from "@/lib/auth";
import { getLead } from "@/lib/service/leads";
import { getLists } from "@/lib/service/lists";
import { assignableUsers } from "@/lib/service/users";
import {
  recordActivityAction, setStageAction, updateLeadAction, addContactAction, updateContactAction, createTaskAction, setLeadTestAction,
} from "@/app/actions";
import { Ref } from "@/components/Ref";
import { RecordForm } from "@/components/RecordForm";
import { Badge, Card, DemoBadge, EmailStatusBadge, Field, Flash, Opts, OutcomeBadge, StageBadge, StatusBadge } from "@/components/ui";
import { fmtDate, fmtDateTime, fmtEvent, isOverdue, toLocalInput, toDateInput } from "@/lib/format";
import { ACTIVITY_TYPE_LABEL, MESSAGE_KIND_LABEL, EMAIL_STATUSES, EMAIL_STATUS_LABEL } from "@/lib/constants";
import { sget, type SP } from "@/lib/view";

const TYPE_TONE: Record<string, "blue" | "green" | "purple" | "amber" | "gray" | "red" | "sky"> = {
  research: "sky", draft: "amber", message: "blue", reply: "green", outcome: "red", task: "gray", status: "purple", approval: "amber", note: "gray",
};

export default async function LeadPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const me = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const leadId = Number(id);
  if (!Number.isInteger(leadId)) notFound();
  let data;
  try { data = await getLead(me, leadId); } catch { notFound(); }
  const { lead, contacts, history, tasks } = data;
  const [lists, users] = await Promise.all([getLists(true), assignableUsers()]);
  const lab = (kind: string) => Object.fromEntries(lists[kind].map((i) => [i.key, i.label]));
  const stageLab = lab("stage");
  const flag = Object.fromEntries(lists.stage.map((i) => [i.key, i.flag]));
  const active = (k: string) => lists[k].filter((i) => i.active).map((i) => ({ key: i.key, label: i.label }));
  const withCurrent = (k: string, cur: string | null) => {
    const a = active(k);
    return cur && !a.find((x) => x.key === cur) ? [...a, { key: cur, label: `${lab(k)[cur] ?? cur} (retired)` }] : a;
  };
  const back = `/leads/${leadId}`;
  const asc = sget(sp, "order") === "asc";
  const hist = asc ? [...history].reverse() : history;
  const sentMessages = history.filter((h) => h.type === "message").map((h) => ({ id: h.id as number, label: `${fmtDateTime(h.occurred_at)} · ${MESSAGE_KIND_LABEL[h.message_kind] ?? "Message"}${h.title ? ` · ${h.title}` : ""}` }));
  const canEdit = can(me, "leads.edit");
  const lastAct = lead.last_activity_at;

  const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
    <div><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{k}</dt><dd className="mt-0.5 break-words">{v || <span className="text-slate-400">—</span>}</dd></div>
  );
  const ext = (u: string | null) => (u ? <a href={/^https?:/i.test(u) ? u : `https://${u}`} target="_blank" rel="noopener noreferrer">{u}</a> : null);

  return (
    <div className="space-y-5">
      <div className="text-sm"><Link href="/leads">← Leads</Link></div>
      <Flash ok={sget(sp, "ok")} err={sget(sp, "err")} />

      {lead.is_demo ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <b>TEST DATA.</b> This lead and its tasks, history and approvals are excluded from the dashboard and all report totals.
          {isManager(me) && <form action={setLeadTestAction} className="ml-3 inline"><input type="hidden" name="_back" value={back} /><input type="hidden" name="id" value={leadId} /><input type="hidden" name="is_test" value="0" /><button className="btn btn-sm">Mark as real data</button></form>}
        </div>
      ) : null}

      {/* ---- Summary ---- */}
      <Card>
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">{lead.company} {lead.is_demo ? <DemoBadge /> : null}{lead.historical_only ? <span className="ml-2 rounded bg-slate-200 px-2 py-0.5 align-middle text-xs font-medium text-slate-700" title="Kept only for past replies, bounces and opt-outs. Not an outreach prospect.">HISTORICAL ONLY</span> : null}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-500">
              <StageBadge stage={lead.stage} label={stageLab[lead.stage] ?? lead.stage} flag={flag[lead.stage]} />
              <span>Owner: <b className="text-slate-700">{lead.owner_name ?? "Unassigned"}</b></span>
              <span>· Lead date: <b className={lead.lead_date ? "text-slate-700" : "text-amber-700"}>{fmtEvent(lead.lead_date, lead.lead_date_precision)}</b>{lead.created_by_name ? ` · found by ${lead.created_by_name}` : " · found by unknown employee"}</span>
              <span>· Entered in CRM {fmtDate(lead.created_at)}{lead.imported_by_name ? ` by ${lead.imported_by_name} (import)` : ""}</span>
            </div>
          </div>
          {can(me, "leads.stage") && (
            <form action={setStageAction} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="_back" value={back} /><input type="hidden" name="id" value={leadId} />
              <div><label className="label">Move to stage</label>
                <select name="stage" className="input" defaultValue={lead.stage}>{lists.stage.filter((i) => i.active || i.key === lead.stage).map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}</select></div>
              <div><label className="label">What actually happened? *</label><input name="reason" className="input w-64" placeholder="e.g. Jo replied asking for pricing" required minLength={3} /></div>
              <button className="btn btn-primary">Record stage change</button>
            </form>
          )}
        </div>
        <dl className="grid gap-x-6 gap-y-4 md:grid-cols-4">
          <Row k="Website" v={ext(lead.website)} />
          <Row k="Industry" v={lab("industry")[lead.industry] ?? lead.industry} />
          <Row k="Country" v={lead.country} />
          <Row k="Target market" v={lab("market")[lead.market] ?? lead.market} />
          <Row k="Customer segment" v={lab("segment")[lead.segment] ?? lead.segment} />
          <Row k="Preferred language" v={lab("language")[lead.language] ?? lead.language} />
          <Row k="Lead source" v={<>{lab("source")[lead.source] ?? lead.source}{lead.source_url && <> · {ext(lead.source_url)}</>}</>} />
          <Row k="Service of interest" v={lab("service")[lead.service] ?? lead.service} />
          <Row k="Last activity" v={lastAct ? fmtDateTime(lastAct) : null} />
          <Row k="Next action" v={lead.next_action} />
          <Row k="Due" v={lead.next_due_at ? <span className={isOverdue(lead.next_due_at) ? "font-medium text-red-600" : ""}>{fmtDate(lead.next_due_at)}{isOverdue(lead.next_due_at) ? " · overdue" : ""}</span> : null} />
        </dl>
        {lead.notes && <div className="mt-4 rounded-md bg-slate-50 p-3 text-sm whitespace-pre-wrap"><div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Notes</div>{lead.notes}</div>}

        {canEdit && (
          <details className="mt-4 border-t border-slate-100 pt-3">
            <summary className="text-sm font-medium text-brand-700">Edit lead details</summary>
            <form action={updateLeadAction} className="mt-3 grid gap-3 md:grid-cols-3">
              <input type="hidden" name="_back" value={back} /><input type="hidden" name="id" value={leadId} />
              <Field label="Company"><input name="company" defaultValue={lead.company} className="input" required /></Field>
              <Field label="Website"><input name="website" defaultValue={lead.website ?? ""} className="input" /></Field>
              <Field label="Country"><input name="country" defaultValue={lead.country ?? ""} className="input" /></Field>
              <Field label="Industry"><select name="industry" defaultValue={lead.industry ?? ""} className="input"><Opts items={withCurrent("industry", lead.industry)} empty="—" /></select></Field>
              <Field label="Target market (geography)"><select name="market" defaultValue={lead.market ?? ""} className="input"><Opts items={withCurrent("market", lead.market)} empty="—" /></select></Field>
              <Field label="Customer segment"><select name="segment" defaultValue={lead.segment ?? ""} className="input"><Opts items={withCurrent("segment", lead.segment)} empty="—" /></select></Field>
              <Field label="Preferred language"><select name="language" defaultValue={lead.language ?? ""} className="input"><Opts items={withCurrent("language", lead.language)} empty="—" /></select></Field>
              <Field label="Lead source"><select name="source" defaultValue={lead.source ?? ""} className="input"><Opts items={withCurrent("source", lead.source)} empty="—" /></select></Field>
              <Field label="Source link"><input name="source_url" defaultValue={lead.source_url ?? ""} className="input" /></Field>
              <Field label="Service of interest"><select name="service" defaultValue={lead.service ?? ""} className="input"><Opts items={withCurrent("service", lead.service)} empty="—" /></select></Field>
              {can(me, "tasks.assign") && (
                <Field label="Assigned employee"><select name="owner_id" defaultValue={lead.owner_id ?? ""} className="input"><option value="">Unassigned</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
              )}
              <Field label="Lead date (when it was really found)"><input type="date" name="lead_date" defaultValue={toDateInput(lead.lead_date)} className="input" /><span className="text-xs text-slate-500">Empty = unknown. Not the day it was entered here.</span></Field>
              <Field label="Next action" className="md:col-span-2"><input name="next_action" defaultValue={lead.next_action ?? ""} className="input" /></Field>
              <Field label="Due date"><input type="date" name="next_due_at" defaultValue={lead.next_due_at ? toLocalInput(lead.next_due_at).slice(0, 10) : ""} className="input" /></Field>
              <Field label="Notes" className="md:col-span-3"><textarea name="notes" defaultValue={lead.notes ?? ""} className="input" /></Field>
              <div className="md:col-span-3"><button className="btn btn-primary">Save changes</button></div>
            </form>
          </details>
        )}
        {isManager(me) && !lead.is_demo && (
          <form action={setLeadTestAction} className="mt-3 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3 text-sm text-slate-600">
            <input type="hidden" name="_back" value={back} /><input type="hidden" name="id" value={leadId} /><input type="hidden" name="is_test" value="1" />
            <button className="btn btn-sm">Mark as test data</button>
            <span className="text-xs">Use for leads created while testing. It stays visible but is labelled TEST and removed from dashboard and report totals (tasks, history and approvals included).</span>
          </form>
        )}
      </Card>

      {/* ---- Contacts ---- */}
      <Card title={`Contacts (${contacts.length})`}>
        {contacts.length === 0 && <p className="text-sm text-slate-500">No contacts yet.</p>}
        <div className="grid gap-3 md:grid-cols-2">
          {contacts.map((c) => (
            <div key={c.id} className="rounded-md border border-slate-200 p-3">
              <div className="flex items-start justify-between gap-2">
                <div><div className="font-medium">{c.name} {c.is_primary ? <Badge tone="blue">Primary</Badge> : null}</div><div className="text-xs text-slate-500">{c.role ?? "No role listed"}</div></div>
                <EmailStatusBadge s={c.email_status} />
              </div>
              <dl className="mt-2 space-y-0.5 text-sm">
                <div>{c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : <span className="text-slate-400">No email</span>}</div>
                <div>{c.phone ?? <span className="text-slate-400">No phone</span>}</div>
                <div className="flex flex-wrap gap-3">{c.linkedin && ext(c.linkedin)}{c.other_social && ext(c.other_social)}</div>
                {c.notes && <div className="text-xs text-slate-500">{c.notes}</div>}
              </dl>
              {canEdit && (
                <form action={updateContactAction} className="mt-2 flex items-center gap-2 border-t border-slate-100 pt-2">
                  <input type="hidden" name="_back" value={back} /><input type="hidden" name="id" value={c.id} />
                  <select name="email_status" defaultValue={c.email_status} className="input w-auto py-1 text-xs">{EMAIL_STATUSES.map((s) => <option key={s} value={s}>Email: {EMAIL_STATUS_LABEL[s]}</option>)}</select>
                  <button className="btn btn-sm">Update</button>
                </form>
              )}
            </div>
          ))}
        </div>
        {canEdit && (
          <details className="mt-3">
            <summary className="text-sm font-medium text-brand-700">+ Add contact</summary>
            <form action={addContactAction} className="mt-3 grid gap-3 md:grid-cols-3">
              <input type="hidden" name="_back" value={back} /><input type="hidden" name="lead_id" value={leadId} />
              <Field label="Name *"><input name="name" className="input" required /></Field>
              <Field label="Role"><input name="role" className="input" /></Field>
              <Field label="Email"><input name="email" type="email" className="input" /></Field>
              <Field label="Phone"><input name="phone" className="input" /></Field>
              <Field label="LinkedIn"><input name="linkedin" className="input" /></Field>
              <Field label="Other social"><input name="other_social" className="input" /></Field>
              <div className="md:col-span-3"><button className="btn btn-primary">Add contact</button></div>
            </form>
          </details>
        )}
      </Card>

      {/* ---- Tasks ---- */}
      <Card title={`Tasks (${tasks.length})`}>
        {tasks.length > 0 && (
          <ul className="mb-3 divide-y divide-slate-100">
            {tasks.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div><Link href={`/tasks/${t.id}`} className="font-medium">{t.title}</Link> <Ref kind="Task" id={t.id} href={`/tasks/${t.id}`} /><div className="text-xs text-slate-500">{t.assignee_name}{t.due_at ? ` · due ${fmtDate(t.due_at)}` : ""}{t.completed_at ? ` · completed ${fmtDateTime(t.completed_at)}${t.completed_by_name ? ` by ${t.completed_by_name}` : ""}` : ""}</div></div>
                <StatusBadge status={t.status} approvalFrom={t.approval_from} />
              </li>
            ))}
          </ul>
        )}
        {(can(me, "tasks.assign") || can(me, "tasks.create_own")) && (
          <details>
            <summary className="text-sm font-medium text-brand-700">+ New task for this lead</summary>
            <form action={createTaskAction} className="mt-3 grid gap-3 md:grid-cols-3">
              <input type="hidden" name="_back" value={back} /><input type="hidden" name="lead_id" value={leadId} />
              <Field label="Task *"><input name="title" className="input" required /></Field>
              <Field label="Type (sets who approves)"><select name="task_type" className="input"><Opts items={active("task_type")} empty="—" /></select></Field>
              <Field label="Due"><input type="datetime-local" name="due_at" className="input" /></Field>
              {can(me, "tasks.assign") && <Field label="Assign to"><select name="assignee_id" defaultValue={me.id} className="input">{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>}
              <Field label="Instructions" className="md:col-span-3"><textarea name="instructions" className="input" /></Field>
              <div className="md:col-span-3"><button className="btn btn-primary">Create task</button></div>
            </form>
          </details>
        )}
      </Card>

      {/* ---- History ---- */}
      <Card title={`Work history (${history.length})`} right={<Link href={`${back}?order=${asc ? "desc" : "asc"}`} className="text-xs">{asc ? "Oldest first ↑" : "Newest first ↓"}</Link>}>
        {can(me, "activity.record") && (
          <details className="mb-5 rounded-md border border-brand-100 bg-brand-50/40 p-3" open={sget(sp, "record") === "1"}>
            <summary className="text-sm font-semibold text-brand-700">+ Record work done</summary>
            <div className="mt-3">
              <RecordForm action={recordActivityAction} leadId={leadId} back={back} contacts={contacts.map((c) => ({ id: c.id, label: c.name + (c.email ? ` <${c.email}>` : "") }))}
                messages={sentMessages} channels={active("channel")} canSend={can(me, "message.record_sent")} />
            </div>
          </details>
        )}
        {history.length === 0 ? <p className="py-4 text-center text-sm text-slate-500">Nothing recorded yet.</p> : (
          <ol className="relative space-y-4 border-l border-slate-200 pl-5">
            {hist.map((h) => (
              <li key={h.id} className="relative">
                <span className="absolute -left-[26px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-slate-400 ring-1 ring-slate-300" />
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={TYPE_TONE[h.type] ?? "gray"}>{h.type === "message" ? MESSAGE_KIND_LABEL[h.message_kind] ?? "Message" : h.type === "outcome" ? "Outcome" : ACTIVITY_TYPE_LABEL[h.type] ?? h.type}</Badge>
                  <OutcomeBadge outcome={h.outcome} />
                  {h.type === "status" && <span className="text-sm">{stageLab[h.stage_from] ?? h.stage_from} → <b>{stageLab[h.stage_to] ?? h.stage_to}</b></span>}
                  {h.title && h.type !== "status" && <span className="font-medium">{h.title}</span>}
                </div>
                {h.body && (h.body.length > 400
                  ? <details className="mt-1 text-sm"><summary className="line-clamp-2 cursor-pointer whitespace-pre-wrap text-slate-700">{h.body}</summary><p className="mt-1 whitespace-pre-wrap text-slate-700">{h.body}</p></details>
                  : <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{h.body}</p>)}
                <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-slate-500">
                  <span className={h.actor_unknown ? "italic text-amber-700" : ""}>{h.actor_name} · <span className={h.occurred_precision === "unknown" ? "text-amber-700" : ""}>{fmtEvent(h.occurred_at, h.occurred_precision)}</span></span>
                  {h.imported_by_name && <span title={`Registered ${fmtDateTime(h.created_at)}`}>Imported by {h.imported_by_name} on {fmtDate(h.created_at)}</span>}
                  {h.contact_name && <span>Contact: {h.contact_name}</span>}
                  {h.channel && <span>Channel: {lab("channel")[h.channel] ?? h.channel}</span>}
                  {h.ref && <span>Ref: <code className="rounded bg-slate-100 px-1">{h.ref}</code></span>}
                  {h.task_id && <Link href={`/tasks/${h.task_id}`}>Task #{h.task_id}</Link>}
                  {h.approval_id && <Link href={`/approvals?id=${h.approval_id}`}>Approval #{h.approval_id}</Link>}
                  {h.url && <a href={h.url} target="_blank" rel="noopener noreferrer">Open link ↗</a>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
