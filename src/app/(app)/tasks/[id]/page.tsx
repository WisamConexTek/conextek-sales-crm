import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getTaskDetail, type TaskDetail } from "@/lib/service/tasks";
import { getLists } from "@/lib/service/lists";
import { Badge, Card, DemoBadge, LeadLink, StatusBadge } from "@/components/ui";
import { Ref } from "@/components/Ref";
import { fmtDateTime } from "@/lib/format";

const EVENT: Record<string, { label: string; tone: "gray" | "blue" | "green" | "amber" | "red" | "purple" }> = {
  task_created: { label: "Task created", tone: "gray" },
  progress_note: { label: "Progress note", tone: "blue" },
  completion_note: { label: "Completion note", tone: "green" },
  submitted: { label: "Submitted for approval", tone: "amber" },
  approved: { label: "Approved", tone: "green" },
  rejected: { label: "Rejected", tone: "red" },
  changes_requested: { label: "Changes requested", tone: "amber" },
  completed: { label: "Completed", tone: "green" },
  pending: { label: "Pending", tone: "gray" },
};

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireUser();
  const taskId = Number((await params).id);
  if (!Number.isInteger(taskId) || taskId < 1) notFound();
  let t: TaskDetail;
  try { t = await getTaskDetail(me, taskId); } catch { notFound(); }
  const lists = await getLists(true);
  const typeLab = Object.fromEntries(lists.task_type.map((i) => [i.key, i.label]));
  const progress = t.notes.filter((n) => n.kind === "progress");

  return (
    <div className="max-w-4xl space-y-5">
      <div className="text-sm"><Link href="/my-work">← My Work</Link></div>
      {t.is_demo ? <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"><b>TEST DATA.</b> Excluded from the dashboard and report totals.</div> : null}
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">{t.title} {t.is_demo ? <DemoBadge /> : null}</h1>
            <div className="mt-1"><Ref kind="Task" id={t.id} href={`/tasks/${t.id}`} /></div>
          </div>
          <StatusBadge status={t.status} approvalFrom={t.approval_from} />
        </div>
        <dl className="mt-4 grid gap-x-6 gap-y-3 text-sm md:grid-cols-3">
          <div><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Lead</dt><dd><LeadLink id={t.lead_id} company={t.company} /></dd></div>
          <div><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Assigned to</dt><dd>{t.assignee_name}</dd></div>
          <div><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Assigned by</dt><dd>{t.created_by_name} · {fmtDateTime(t.created_at)}</dd></div>
          <div><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Type</dt><dd>{t.task_type ? typeLab[t.task_type] ?? t.task_type : "—"}</dd></div>
          <div><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Due</dt><dd>{t.due_at ? fmtDateTime(t.due_at) : "—"}</dd></div>
          <div><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Approval from</dt><dd>{t.approval_from ? (t.approval_from === "wisam" ? "Wisam" : "Chief") : "Not needed"}</dd></div>
          {t.completed_at && <div><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Completed</dt><dd>{fmtDateTime(t.completed_at)}{t.completed_by_name ? ` by ${t.completed_by_name}` : ""}</dd></div>}
        </dl>
        {t.instructions && <div className="mt-4 rounded-md bg-slate-50 p-3 text-sm whitespace-pre-wrap"><div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Instructions</div>{t.instructions}</div>}
        {t.change_request && t.status === "changes_requested" && <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm whitespace-pre-wrap"><div className="mb-1 text-xs font-medium uppercase tracking-wide text-red-700">Changes requested</div>{t.change_request}</div>}
        {t.completion_note && <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm whitespace-pre-wrap"><div className="mb-1 text-xs font-medium uppercase tracking-wide text-emerald-800">Completion note</div>{t.completion_note}</div>}
      </Card>

      <Card title={`Progress notes (${progress.length})`}>
        {progress.length === 0 ? <p className="text-sm text-slate-500">No progress notes yet.</p> : (
          <ul className="space-y-2">
            {[...progress].reverse().map((n) => (
              <li key={n.id} className="rounded border border-slate-100 p-2 text-sm"><div className="whitespace-pre-wrap">{n.body}</div>
                <div className="mt-1 text-xs text-slate-500">{n.actor_name ?? "—"} · {fmtDateTime(n.created_at)}</div></li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-slate-400">Every progress note is kept — adding a newer note or a completion note never replaces an earlier one.</p>
      </Card>

      <Card title={`Approvals (${t.approvals.length})`}>
        {t.approvals.length === 0 ? <p className="text-sm text-slate-500">Nothing submitted yet.</p> : (
          <ul className="divide-y divide-slate-100">
            {t.approvals.map((a) => (
              <li key={a.id} className="py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Ref kind="Approval" id={a.id} href={`/approvals?id=${a.id}`} />
                  <Badge tone="gray">{a.kind}</Badge>
                  <Badge tone={a.status === "approved" ? "green" : a.status === "rejected" ? "red" : a.status === "pending" ? "purple" : "amber"}>{EVENT[a.status]?.label ?? a.status}</Badge>
                  <span className="font-medium">{a.title}</span>
                </div>
                <div className="mt-1 text-xs text-slate-500">Submitted by {a.submitted_by_name} · {fmtDateTime(a.submitted_at)}{a.decided_at ? ` · ${EVENT[a.status]?.label ?? a.status} by ${a.decided_by_name} · ${fmtDateTime(a.decided_at)}` : ` · waiting on ${a.requires === "wisam" ? "Wisam" : "Chief"}`}</div>
                {a.comment && <p className="mt-1 whitespace-pre-wrap text-slate-700">“{a.comment}”</p>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Timeline">
        <ol className="relative space-y-3 border-l border-slate-200 pl-5">
          {t.timeline.map((e, i) => (
            <li key={i} className="relative">
              <span className="absolute -left-[26px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-slate-400 ring-1 ring-slate-300" />
              <div className="flex flex-wrap items-center gap-2"><Badge tone={(EVENT[e.event]?.tone ?? "gray")}>{EVENT[e.event]?.label ?? e.event}</Badge>
                <span className="text-xs text-slate-500">{e.actor ?? "—"} · {fmtDateTime(e.at)}</span></div>
              {e.text && <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-sm text-slate-700">{e.text}</p>}
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
