import Link from "next/link";
import { requireUser, can } from "@/lib/auth";
import { listTasks } from "@/lib/service/tasks";
import { getLists } from "@/lib/service/lists";
import { assignableUsers } from "@/lib/service/users";
import { listLeads } from "@/lib/service/leads";
import { updateTaskAction, submitTaskAction, completeTaskAction, createTaskAction } from "@/app/actions";
import { Card, Empty, Field, Flash, LeadLink, Opts, PageHeader, StatusBadge, DemoBadge } from "@/components/ui";
import { fmtDateTime, isOverdue } from "@/lib/format";
import { demoOn, q, sget, snum, type SP } from "@/lib/view";
import type { Row } from "@/lib/db";

export default async function MyWork({ searchParams }: { searchParams: SP }) {
  const me = await requireUser();
  const sp = await searchParams;
  const teamView = can(me, "tasks.view_all") || me.role !== "employee";
  const emp = sget(sp, "employee");
  const assignee = !teamView || !emp ? me.id : emp === "all" ? undefined : snum(sp, "employee");
  const showDone = sget(sp, "done") === "1";
  const includeDemo = await demoOn();
  const [tasks, lists, users, leads] = await Promise.all([
    listTasks(me, { assignee, includeDemo }),
    getLists(), assignableUsers(),
    can(me, "tasks.assign") || can(me, "tasks.create_own") ? listLeads(me, { pageSize: 200, sort: "company", includeDemo }) : Promise.resolve({ rows: [] as Row[] }),
  ]);
  const back = `/my-work${q({ employee: emp, done: showDone ? 1 : undefined })}`;
  const mineView = assignee === me.id;
  const open = tasks.filter((t) => !["completed", "cancelled"].includes(t.status));
  const done = tasks.filter((t) => ["completed", "cancelled"].includes(t.status)).slice(0, 30);
  const groups: [string, string, Row[]][] = [
    ["changes_requested", "Changes requested — fix and resubmit", open.filter((t) => t.status === "changes_requested")],
    ["approved", "Approved — do the work, record it, then mark complete", open.filter((t) => t.status === "approved")],
    ["active", "To do / in progress", open.filter((t) => ["todo", "in_progress"].includes(t.status))],
    ["waiting", "Waiting for approval", open.filter((t) => t.status === "waiting_approval")],
  ];
  const typeLab = Object.fromEntries(lists.task_type.map((i) => [i.key, i.label]));

  const TaskCard = ({ t }: { t: Row }) => {
    const mine = t.assignee_id === me.id;
    const overdue = isOverdue(t.due_at) && ["todo", "in_progress", "changes_requested", "approved"].includes(t.status);
    const editable = !["completed", "cancelled"].includes(t.status);
    return (
      <div className={`rounded-md border p-3 ${t.status === "changes_requested" ? "border-red-200 bg-red-50/40" : "border-slate-200"}`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="font-medium text-slate-900">{t.title} {t.is_demo ? <DemoBadge /> : null}</div>
            <div className="mt-0.5 text-xs text-slate-500">
              {t.lead_id ? <LeadLink id={t.lead_id} company={t.company} /> : "No lead"}
              {" · "}{t.assignee_name}{t.task_type ? ` · ${typeLab[t.task_type] ?? t.task_type}` : ""} · assigned by {t.created_by_name}
              {t.due_at && <> · <span className={overdue ? "font-medium text-red-600" : ""}>due {fmtDateTime(t.due_at)}{overdue ? " (overdue)" : ""}</span></>}
            </div>
          </div>
          <StatusBadge status={t.status} approvalFrom={t.approval_from} />
        </div>
        {t.instructions && <div className="mt-2 rounded bg-slate-50 p-2 text-sm whitespace-pre-wrap"><span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Instructions: </span>{t.instructions}</div>}
        {t.change_request && t.status === "changes_requested" && <div className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-sm whitespace-pre-wrap"><span className="text-xs font-semibold uppercase tracking-wide text-red-700">Changes requested: </span>{t.change_request}</div>}
        {t.progress_note && <p className="mt-2 text-sm text-slate-600"><span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Progress: </span>{t.progress_note}</p>}
        {t.status === "waiting_approval" && t.pending_approval_id && <p className="mt-2 text-xs text-slate-500">Submitted — <Link href="/approvals">view in Approvals</Link></p>}

        {editable && (mine || can(me, "tasks.assign")) && (
          <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
            {["todo", "in_progress", "changes_requested"].includes(t.status) && (
              <details className="min-w-60"><summary className="btn btn-sm inline-flex">Update progress</summary>
                <form action={updateTaskAction} className="mt-2 space-y-2">
                  <input type="hidden" name="_back" value={back} /><input type="hidden" name="id" value={t.id} />
                  <select name="status" className="input" defaultValue={t.status === "todo" ? "todo" : "in_progress"}><option value="todo">To do</option><option value="in_progress">In progress</option></select>
                  <textarea name="progress_note" className="input" placeholder="Short progress note" defaultValue={t.progress_note ?? ""} />
                  <button className="btn btn-sm btn-primary">Save</button>
                </form></details>
            )}
            {mine && t.approval_from && ["todo", "in_progress", "changes_requested"].includes(t.status) && can(me, "approvals.submit") && (
              <details className="min-w-72"><summary className="btn btn-sm btn-primary inline-flex">Submit for {t.approval_from === "wisam" ? "Wisam's" : "Chief's"} approval</summary>
                <form action={submitTaskAction} className="mt-2 space-y-2">
                  <input type="hidden" name="_back" value={back} /><input type="hidden" name="id" value={t.id} />
                  <select name="kind" className="input"><option value="draft">Draft message</option><option value="findings">Research findings</option><option value="other">Other</option></select>
                  <input name="title" className="input" placeholder="Title (optional)" />
                  <textarea name="content" className="input min-h-40" placeholder="Paste the full draft or findings for review" required />
                  <p className="text-xs text-slate-500">Approval is not sending. You'll record the send separately once it really happens.</p>
                  <button className="btn btn-sm btn-primary">Submit</button>
                </form></details>
            )}
            {(t.approval_from ? t.status === "approved" : ["todo", "in_progress", "changes_requested"].includes(t.status)) && (
              <details className="min-w-60"><summary className="btn btn-sm btn-ok inline-flex">Mark complete</summary>
                <form action={completeTaskAction} className="mt-2 space-y-2">
                  <input type="hidden" name="_back" value={back} /><input type="hidden" name="id" value={t.id} />
                  <textarea name="note" className="input" placeholder="What was done? (optional)" />
                  {t.lead_id && <p className="text-xs text-slate-500">Sent something? <Link href={`/leads/${t.lead_id}?record=1`}>Record it on the lead</Link> first.</p>}
                  <button className="btn btn-sm btn-ok">Complete</button>
                </form></details>
            )}
            {(can(me, "tasks.assign") || t.created_by === me.id) && (
              <form action={updateTaskAction}><input type="hidden" name="_back" value={back} /><input type="hidden" name="id" value={t.id} /><input type="hidden" name="status" value="cancelled" />
                <button className="btn btn-sm btn-danger">Cancel task</button></form>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-5">
      <PageHeader title="My Work" sub={mineView ? "Your assigned tasks, deadlines and Chief's instructions" : assignee ? `Queue for ${users.find((u) => u.id === assignee)?.name}` : "Everyone's queue"}>
        {teamView && (
          <form className="flex items-center gap-2">
            <select name="employee" defaultValue={emp ?? ""} className="input w-auto"><option value="">Just me</option><option value="all">Everyone</option>{users.filter((u) => u.id !== me.id).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
            <button className="btn">View</button>
          </form>
        )}
      </PageHeader>
      <Flash ok={sget(sp, "ok")} err={sget(sp, "err")} />

      {(can(me, "tasks.assign") || can(me, "tasks.create_own")) && (
        <Card>
          <details>
            <summary className="text-sm font-semibold text-brand-700">+ {can(me, "tasks.assign") ? "Assign or create a task" : "Add a future task for myself"}</summary>
            <form action={createTaskAction} className="mt-3 grid gap-3 md:grid-cols-4">
              <input type="hidden" name="_back" value={back} />
              <Field label="Task *" className="md:col-span-2"><input name="title" className="input" required /></Field>
              <Field label="Lead"><select name="lead_id" className="input" defaultValue=""><option value="">— none —</option>{leads.rows.map((l) => <option key={l.id} value={l.id}>{l.company}</option>)}</select></Field>
              <Field label="Due"><input type="datetime-local" name="due_at" className="input" /></Field>
              {can(me, "tasks.assign") && <Field label="Assign to"><select name="assignee_id" className="input" defaultValue={me.id}>{users.map((u) => <option key={u.id} value={u.id}>{u.name}{u.id === me.id ? " (me)" : ""}</option>)}</select></Field>}
              <Field label="Type (sets approver)"><select name="task_type" className="input"><Opts items={lists.task_type.map((i) => ({ key: i.key, label: `${i.label} — ${i.flag === "wisam" ? "Wisam approves" : "Chief approves"}` }))} empty="—" /></select></Field>
              {can(me, "tasks.assign") && <Field label="Approval"><select name="approval" className="input" defaultValue="default"><option value="default">Per type</option><option value="chief">Chief</option><option value="wisam">Wisam</option><option value="none">No approval needed</option></select></Field>}
              <Field label="Instructions" className="md:col-span-4"><textarea name="instructions" className="input" /></Field>
              <div><button className="btn btn-primary">Create task</button></div>
            </form>
          </details>
        </Card>
      )}

      {open.length === 0 && <Card><Empty>No open tasks. 🎉</Empty></Card>}
      {groups.map(([k, title, rows]) => rows.length > 0 && (
        <Card key={k} title={`${title} (${rows.length})`}><div className="space-y-3">{rows.map((t) => <TaskCard key={t.id} t={t} />)}</div></Card>
      ))}

      <div>
        <Link href={`/my-work${q({ employee: emp, done: showDone ? undefined : 1 })}`} className="text-sm">{showDone ? "Hide" : "Show"} recently completed / cancelled</Link>
        {showDone && <Card className="mt-3" title="Completed / cancelled">{done.length === 0 ? <Empty>None.</Empty> : <div className="space-y-3">{done.map((t) => <TaskCard key={t.id} t={t} />)}</div>}</Card>}
      </div>
    </div>
  );
}
