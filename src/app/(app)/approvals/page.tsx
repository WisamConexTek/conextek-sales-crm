import Link from "next/link";
import { requireUser, can } from "@/lib/auth";
import { listApprovals, canDecide } from "@/lib/service/tasks";
import { all } from "@/lib/db";
import { decideApprovalAction, escalateApprovalAction } from "@/app/actions";
import { Badge, Card, Empty, Flash, LeadLink, PageHeader, DemoBadge } from "@/components/ui";
import { Ref } from "@/components/Ref";
import { fmtDateTime } from "@/lib/format";
import { ACTIVITY_TYPE_LABEL } from "@/lib/constants";
import { demoOn, sget, snum, type SP } from "@/lib/view";
import type { Row } from "@/lib/db";

const KIND = { draft: "Draft", findings: "Findings", other: "Work" } as Record<string, string>;
const who = (r: string) => (r === "wisam" ? "Wisam" : "Chief");

export default async function Approvals({ searchParams }: { searchParams: SP }) {
  const me = await requireUser();
  const sp = await searchParams;
  const oneId = snum(sp, "id");
  const tab = sget(sp, "tab") === "decided" ? "decided" : "pending";
  const includeDemo = await demoOn();
  const all_ = await listApprovals(me, oneId ? { includeDemo: true, id: oneId } : { includeDemo });
  const rows = oneId ? all_ : all_.filter((a) => (tab === "pending" ? a.status === "pending" : a.status !== "pending"));
  const nPending = all_.filter((a) => a.status === "pending").length;
  const leadIds = [...new Set(rows.map((r) => r.lead_id).filter(Boolean))] as number[];
  const ctx: Record<number, Row[]> = {};
  for (const id of leadIds) ctx[id] = await all("SELECT a.type,a.title,a.body,a.occurred_at,a.message_kind,u.name AS actor_name FROM activities a JOIN users u ON u.id=a.actor_id WHERE a.lead_id=? AND a.type<>'approval' ORDER BY a.occurred_at DESC,a.id DESC LIMIT 4", [id]);
  const decisionLabel: Record<string, string> = { approved: "Approved", rejected: "Rejected", changes_requested: "Changes requested" };
  const groups = oneId ? [{ title: `Approval #${oneId}`, rows }] : tab === "pending" ? (["chief", "wisam"] as const).map((r) => ({ title: `Waiting on ${who(r)}`, rows: rows.filter((a) => a.requires === r) })) : [{ title: "Decided", rows }];

  return (
    <div className="space-y-5">
      <PageHeader title="Approvals" sub="Submitted work with its lead and context. Approval is a review decision — it never sends anything.">
        <Link href="/approvals" className={`btn ${tab === "pending" && !oneId ? "btn-primary" : ""}`}>Pending ({nPending})</Link>
        <Link href="/approvals?tab=decided" className={`btn ${tab === "decided" && !oneId ? "btn-primary" : ""}`}>Decided</Link>
      </PageHeader>
      <Flash ok={sget(sp, "ok")} err={sget(sp, "err")} />
      {rows.length === 0 && <Card><Empty>{oneId ? "That approval was not found (or you do not have access)." : tab === "pending" ? "Nothing is waiting for approval." : "No decisions yet."}</Empty></Card>}

      {groups.map((g) => g.rows.length > 0 && (
        <div key={g.title} className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-700">{g.title} ({g.rows.length})</h2>
          {g.rows.map((a) => {
            const c = canDecide(me, a);
            return (
              <Card key={a.id}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="text-base font-semibold text-slate-900">{a.title} {a.is_demo ? <DemoBadge /> : null} <Ref kind="Approval" id={a.id} href={`/approvals?id=${a.id}`} /></div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      <Badge tone="gray">{KIND[a.kind]}</Badge> · submitted by <b>{a.submitted_by_name}</b> · {fmtDateTime(a.created_at)} · task: <Link href={`/tasks/${a.task_id}`}>{a.task_title}</Link> <Ref kind="Task" id={a.task_id} href={`/tasks/${a.task_id}`} />
                    </div>
                  </div>
                  {a.status === "pending" ? <Badge tone={a.requires === "wisam" ? "purple" : "amber"}>Pending {who(a.requires)}</Badge>
                    : <Badge tone={a.status === "approved" ? "green" : a.status === "rejected" ? "red" : "amber"}>{decisionLabel[a.status]}</Badge>}
                </div>

                <div className="mt-3 grid gap-4 lg:grid-cols-3">
                  <div className="lg:col-span-2">
                    <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Submitted content</div>
                    <div className="max-h-96 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-3 text-sm whitespace-pre-wrap">{a.content}</div>
                    {a.task_instructions && <p className="mt-2 text-xs text-slate-500"><b>Task instructions:</b> {a.task_instructions}</p>}
                  </div>
                  <div className="text-sm">
                    <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Lead context</div>
                    {a.lead_id ? (
                      <>
                        <div><LeadLink id={a.lead_id} company={a.company} /> <span className="text-xs text-slate-500">· stage {a.stage}</span></div>
                        <ul className="mt-2 space-y-1.5">
                          {(ctx[a.lead_id] ?? []).map((h, i) => (
                            <li key={i} className="rounded border border-slate-100 p-2 text-xs"><b>{ACTIVITY_TYPE_LABEL[h.type] ?? h.type}</b> · {h.actor_name} · {fmtDateTime(h.occurred_at)}
                              <div className="line-clamp-2 text-slate-600">{h.type === "status" ? h.body : h.title || h.body}</div></li>
                          ))}
                          {(ctx[a.lead_id] ?? []).length === 0 && <li className="text-xs text-slate-400">No history yet.</li>}
                        </ul>
                      </>
                    ) : <p className="text-slate-400">Not linked to a lead.</p>}
                  </div>
                </div>

                {a.status !== "pending" && (
                  <div className="mt-3 rounded-md bg-slate-50 p-3 text-sm">
                    <b>{decisionLabel[a.status]}</b> by {a.decided_by_name ?? "—"} · {fmtDateTime(a.decided_at)}
                    {a.comment && <p className="mt-1 whitespace-pre-wrap text-slate-700">“{a.comment}”</p>}
                  </div>
                )}

                {a.status === "pending" && (
                  <div className="mt-3 border-t border-slate-100 pt-3">
                    {a.comment && a.requires === "wisam" && <p className="mb-2 text-sm text-slate-600"><b>Escalation note:</b> {a.comment}</p>}
                    {c.ok ? (
                      <form action={decideApprovalAction} className="space-y-2">
                        <input type="hidden" name="id" value={a.id} /><input type="hidden" name="_back" value={oneId ? `/approvals?id=${oneId}` : `/approvals${tab === "decided" ? "?tab=decided" : ""}`} />
                        <textarea name="comment" className="input" placeholder="Comment (required to reject or request changes)" />
                        <div className="flex flex-wrap gap-2">
                          <button name="decision" value="approved" className="btn btn-ok">Approve</button>
                          <button name="decision" value="changes_requested" className="btn">Request changes</button>
                          <button name="decision" value="rejected" className="btn btn-danger">Reject</button>
                          {a.requires === "chief" && me.role !== "owner" && (
                            <button formAction={escalateApprovalAction} className="btn ml-auto" title="Hand this up to Wisam">Escalate to Wisam</button>
                          )}
                        </div>
                      </form>
                    ) : (
                      <div className="flex flex-wrap items-center gap-3">
                        <p className="text-sm text-slate-500">{c.reason}</p>
                        {can(me, "approvals.decide") && a.requires === "chief" && a.submitted_by !== me.id && me.role !== "owner" && (
                          <form action={escalateApprovalAction}><input type="hidden" name="id" value={a.id} /><button className="btn btn-sm">Escalate to Wisam</button></form>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      ))}
    </div>
  );
}
