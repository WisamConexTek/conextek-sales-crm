import Link from "next/link";
import { requireUser, isManager } from "@/lib/auth";
import { HttpError } from "@/lib/auth";
import { workPlan } from "@/lib/service/workplan";
import { WORK_ROLES, WORK_ROLE_LABEL, type WorkRole } from "@/lib/constants";
import { addDays, todayYmd } from "@/lib/db";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { SortTh } from "@/components/Sort";
import { parseSort, sortRows } from "@/lib/sort";
import { fmtShort, fmtYmd } from "@/lib/format";
import { q, sget, type SP } from "@/lib/view";

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The daily plan: what each role has to prepare for a day, worked out from each sender's capacity. One tab per role. */
const GROUP_TONE: Record<string, "blue" | "amber" | "green" | "gray" | "purple"> = { window: "blue", overdue: "amber", first_floor: "green", late: "gray", first: "purple" };
const PREP: Record<string, string> = { draft_needed: "No draft yet", internal_review: "Waiting for the Chief", user_approval_needed: "Waiting for the Owner", ready_for_execution: "Approved", validation_needed: "Approved, blocked" };

export default async function PlanPage({ searchParams }: { searchParams: SP }) {
  const me = await requireUser();
  const sp = await searchParams;
  const today = todayYmd();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(sget(sp, "date") ?? "") ? (sget(sp, "date") as string) : today;
  const seeAll = isManager(me) || me.perms.has("compliance.view");
  const wanted = (WORK_ROLES as readonly string[]).includes(sget(sp, "role") ?? "") ? (sget(sp, "role") as WorkRole) : undefined;
  const sort = sget(sp, "sort");
  let plan: any, error: string | null = null;
  try { plan = await workPlan(me, { date, role: seeAll ? wanted ?? (me.role === "owner" ? "owner" : me.role === "chief" ? "chief" : "compliance") : undefined }); }
  catch (e) { if (!(e instanceof HttpError)) throw e; error = e.message; }
  if (error || !plan) return <div className="space-y-5"><PageHeader title="Daily plan" /><Card><Empty>{error}</Empty></Card></div>;
  const role: WorkRole = plan.role;
  const v = plan.view;
  const href = (o: Record<string, string | undefined>) => `/plan${q({ date: date === today ? undefined : date, role: seeAll ? role : undefined, sort, ...o })}`;
  const days = [0, 1, 2, 3, 4, 5].map((n) => addDays(today, n));
  const itemSpec = { title: (i: any) => i.title, type: (i: any) => i.type, company: (i: any) => i.company, group: (i: any) => i.group_label ?? i.kind, due: (i: any) => i.due_on, days_overdue: (i: any) => i.days_overdue, draft: (i: any) => (i.has_draft ? 1 : 0), deadline: (i: any) => i.draft_deadline, status: (i: any) => i.prep };
  const ps = parseSort(sort, Object.keys(itemSpec));
  const th = (label: string, field: string) => <SortTh label={label} field={field} sort={ps.applied} href={(s) => href({ sort: s })} />;
  const Items = ({ items }: { items: any[] }) => !items.length ? <Empty>Nothing planned.</Empty> : (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] text-sm">
        <thead className="bg-slate-50"><tr>{th("Message", "title")}{th("Priority group", "group")}{th("Due", "due")}{th("Days overdue", "days_overdue")}{th("Draft", "draft")}{th("Drafting deadline", "deadline")}{th("Status", "status")}</tr></thead>
        <tbody className="divide-y divide-slate-100">
          {sortRows(items, itemSpec, ps).map((i) => (
            <tr key={i.task_id}>
              <td className="td max-w-[300px]"><Link href={`/tasks?task=${i.task_id}`} className="block truncate font-medium">{i.title}</Link>{i.thread_subject ? <div className="truncate text-xs text-slate-500">{i.thread_subject}</div> : null}</td>
              <td className="td whitespace-nowrap">{i.group ? <Badge tone={GROUP_TONE[i.group] ?? "gray"}>{i.group_label}</Badge> : <span className="text-slate-400">does not fit the day</span>}{i.late ? <span className="ml-1 text-[10px] font-semibold text-slate-500">LATE</span> : null}</td>
              <td className="td whitespace-nowrap">{i.due_on ? fmtYmd(i.due_on) : "No date"}{i.window_end_on ? <div className="text-xs text-slate-500">window to {fmtYmd(i.window_end_on)}</div> : null}</td>
              <td className="td tabular-nums">{i.days_overdue > 0 ? <span className="font-semibold text-red-700">{i.days_overdue}</span> : ""}</td>
              <td className="td">{i.has_draft ? <Badge tone="green">done</Badge> : <Badge tone="amber">to draft</Badge>}</td>
              <td className="td whitespace-nowrap text-slate-600">{i.has_draft ? "" : i.draft_deadline ? fmtShort(i.draft_deadline) : ""}</td>
              <td className="td whitespace-nowrap text-slate-600">{PREP[i.prep] ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  const Tasks = ({ rows, empty }: { rows: any[]; empty: string }) => !rows?.length ? <Empty>{empty}</Empty> : (
    <ul className="divide-y divide-slate-100">
      {rows.map((t) => (
        <li key={t.task_id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
          <Link href={`/tasks?task=${t.task_id}`} className="font-medium">{t.title}</Link>
          <span className="text-xs text-slate-500">{t.due_at ? `by ${fmtShort(t.due_at)}` : t.due_on ? fmtYmd(t.due_on) : "no date"}{t.days_overdue > 0 ? <b className="ml-2 text-red-700">{t.days_overdue} days overdue</b> : null}{t.blocker ? ` · ${t.blocker}` : ""}{t.reason ? ` · ${t.reason}` : ""}</span>
        </li>
      ))}
    </ul>
  );
  const Shortfalls = ({ list }: { list: any[] }) => !list?.length ? null : (
    <Card title="Shortfalls for tomorrow">
      <ul className="space-y-1.5 text-sm">{list.map((s) => <li key={s.id} className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-900"><b>{WORK_ROLE_LABEL[s.role as WorkRole] ?? s.role}:</b> {s.message}</li>)}</ul>
    </Card>
  );

  return (
    <div className="space-y-5">
      <PageHeader title="Daily plan" sub={`${date === today ? "Today" : date === addDays(today, 1) ? "Tomorrow" : fmtYmd(date)} · ${WORK_ROLE_LABEL[role]} · worked out from each sender's capacity, follow-ups first`}>
        <div className="panel inline-flex gap-0.5 p-1" role="group" aria-label="Day">
          {days.map((d, n) => <Link key={d} href={href({ date: d === today ? undefined : d })} aria-current={d === date ? "true" : undefined} className={`rounded-md px-2.5 py-1.5 text-[13px] font-medium no-underline hover:no-underline ${d === date ? "bg-brand-600 text-white! shadow-sm" : "text-slate-600 hover:bg-slate-100"}`}>{n === 0 ? "Today" : n === 1 ? "Tomorrow" : fmtYmd(d).replace(/ \d{4}$/, "")}</Link>)}
        </div>
      </PageHeader>
      {seeAll && (
        <div className="panel flex flex-wrap gap-1 p-1" role="tablist" aria-label="Role">
          {WORK_ROLES.map((r) => <Link key={r} role="tab" aria-selected={r === role} href={href({ role: r, sort: undefined })} className={`rounded-md px-3 py-1.5 text-[13px] font-medium no-underline hover:no-underline ${r === role ? "bg-brand-600 text-white! shadow-sm" : "text-slate-600 hover:bg-slate-100"}`}>{WORK_ROLE_LABEL[r]}</Link>)}
        </div>
      )}
      {plan.gaps.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          <div className="font-semibold">Still to prepare for this day</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">{plan.gaps.map((g: any, i: number) => <li key={i}>{g.message}</li>)}</ul>
        </div>
      )}

      {role === "writer" && (
        <>
          <p className="text-sm text-slate-600"><b className="text-slate-900">{v.total_to_draft}</b> message{v.total_to_draft === 1 ? "" : "s"} to draft. Drafting deadline: {v.drafting_deadline_default}.</p>
          {v.senders.map((s: any) => (
            <Card key={s.sender.id} title={`${s.sender.display_name} · ${s.to_draft} to draft, ${s.done} done`}>
              <Items items={s.items} />
              {s.new_first_emails_waiting_for_a_lead > 0 && <p className="mt-2 text-sm text-slate-600">{s.new_first_emails_waiting_for_a_lead} new first-email slot{s.new_first_emails_waiting_for_a_lead === 1 ? "" : "s"} waiting for a lead from the Lead Hunter.</p>}
            </Card>
          ))}
          {v.without_sender.length > 0 && <Card title="First emails with no sender chosen yet"><Items items={v.without_sender} /></Card>}
        </>
      )}
      {role === "hunter" && (
        <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {v.needs.map((n: any) => (
              <div key={n.sender.id} className="card p-4">
                <div className="text-xs font-medium text-slate-500">{n.sender.display_name}{n.campaign ? ` · ${n.campaign.name}` : ""}</div>
                <div className="mt-2 flex items-baseline gap-2"><span className="text-[28px] font-semibold leading-none tabular-nums text-slate-900">{n.need_leads}</span><span className="text-sm text-slate-600">new lead{n.need_leads === 1 ? "" : "s"} needed</span></div>
                <div className="mt-1 text-xs text-slate-500">{n.need_with_buffer} with the {Math.round(v.buffer * 100)}% buffer · {n.first_email_slots} first-email slot{n.first_email_slots === 1 ? "" : "s"}, {n.prepared} with a lead</div>
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-500">{v.rule}</p>
          <Card title="Research tasks"><Tasks rows={v.research_tasks} empty="No research tasks." /></Card>
        </>
      )}
      {role === "inbox" && (<><Card title="Replies to handle"><Tasks rows={v.handle_reply} empty="No reply is waiting." /></Card><Card title="Waiting (soft bounce or out of office)"><Tasks rows={v.waiting} empty="Nothing is on hold." /></Card></>)}
      {role === "linkedin" && (<><Card title="LinkedIn steps due"><Tasks rows={v.steps_due} empty="No LinkedIn step is due." /></Card><Card title="Coming up"><Tasks rows={v.upcoming} empty="Nothing further planned." /></Card></>)}
      {role === "chief" && (
        <>
          <Shortfalls list={v.shortfalls} />
          <Card title={`Drafts waiting for your review (${v.waiting_editorial_review.length})`}><Items items={v.waiting_editorial_review} /></Card>
          <Card title={`Waiting for the Owner's send approval (${v.waiting_owner_send_approval.length})`}><Items items={v.waiting_owner_send_approval} /></Card>
          <Card title="Reviews"><Tasks rows={v.reviews} empty="No review is open." /></Card>
          {v.not_fitting_the_day.length > 0 && <Card title={`Does not fit this day's capacity (${v.not_fitting_the_day.length})`}><Items items={v.not_fitting_the_day} /></Card>}
        </>
      )}
      {role === "compliance" && <Card title="Compliance"><p className="text-sm text-slate-700">{v.overdue_follow_ups} overdue follow-up{v.overdue_follow_ups === 1 ? "" : "s"}, {v.late_items} late item{v.late_items === 1 ? "" : "s"}, {v.open_shortfalls} open shortfall{v.open_shortfalls === 1 ? "" : "s"}. <Link href="/compliance">Open the compliance report</Link></p></Card>}
      {role === "owner" && (
        <>
          <Shortfalls list={v.shortfalls} />
          <div className="grid gap-3 md:grid-cols-2">
            {v.planned_sends.map((s: any) => (
              <div key={s.sender.id} className="card p-4">
                <div className="flex items-center justify-between"><div className="font-semibold text-slate-900">{s.sender.display_name}</div><div className="text-xs text-slate-500">cap {s.cap ?? "none"}</div></div>
                <div className="mt-2 text-[28px] font-semibold leading-none tabular-nums text-slate-900">{s.planned}<span className="ml-2 text-sm font-normal text-slate-600">planned send{s.planned === 1 ? "" : "s"}</span></div>
                <dl className="mt-3 space-y-1 text-[13px]">
                  {plan.priority_order.map((g: any) => <div key={g.group} className="flex justify-between"><dt className="text-slate-600">{g.position}. {g.label}</dt><dd className="font-medium tabular-nums">{s.slots[g.group]}</dd></div>)}
                  <div className="flex justify-between border-t border-slate-100 pt-1"><dt className="text-slate-600">First-email slots with no lead yet</dt><dd className="font-medium tabular-nums">{s.empty_first_email_slots}</dd></div>
                  {s.not_fitting > 0 && <div className="flex justify-between text-amber-800"><dt>Does not fit the day</dt><dd className="font-medium tabular-nums">{s.not_fitting}</dd></div>}
                </dl>
              </div>
            ))}
          </div>
          <Card title="Waiting for you"><p className="text-sm text-slate-700">{v.approvals_waiting} draft{v.approvals_waiting === 1 ? "" : "s"} planned for this day wait for your send approval{v.earliest_deadline ? `, the earliest due ${fmtYmd(v.earliest_deadline)}` : ""}. <Link href="/send-approvals">Open send approvals</Link></p></Card>
        </>
      )}
    </div>
  );
}
