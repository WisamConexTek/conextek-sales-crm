import Link from "next/link";
import { requireUser, can, isManager } from "@/lib/auth";
import { assignableUsers } from "@/lib/service/users";
import { listCampaigns } from "@/lib/service/campaigns";
import { listSenders } from "@/lib/service/senders";
import { getTaskDetail } from "@/lib/service/tasks";
import { listTasksView, taskSummary, enrich, whatToDo, DUE_FILTERS, OVERDUE_BUCKETS, type TaskRow } from "@/lib/service/tasklist";
import { TASK_DISPLAY_TYPES, TASK_STATUS_LABEL } from "@/lib/constants";
import { todayYmd } from "@/lib/db";
import { Badge, DemoBadge, Empty, Flash } from "@/components/ui";
import { SortTh } from "@/components/Sort";
import { fmtDateTime, fmtShort, fmtYmd } from "@/lib/format";
import { demoOn, sget, snum, type SP } from "@/lib/view";

/**
 * Tasks: one compact row per task. It opens on Everyone, open work only, most overdue first.
 * The long text (instructions, evidence, notes, history) lives in the side panel that a row opens, never in the table.
 * Every filter, the sort and the open task are in the address bar, so a refresh or a shared link shows the same view.
 */
const STATE_TONE: Record<string, "red" | "amber" | "green" | "gray" | "blue"> = { overdue: "red", blocked: "amber", ready: "green", planned: "gray", completed: "blue", cancelled: "gray" };
const STATE_LABEL: Record<string, string> = { overdue: "Overdue", blocked: "Blocked", ready: "Ready", planned: "Planned", completed: "Completed", cancelled: "Cancelled" };
const DUE_LABEL: Record<string, string> = { overdue: "Overdue", today: "Today", tomorrow: "Tomorrow", this_week: "This week", none: "No date" };
const EVENT_LABEL: Record<string, string> = { task_created: "Created", progress_note: "Progress note", submitted: "Submitted for approval", approved: "Approved", rejected: "Rejected", changes_requested: "Changes requested", completed: "Completed" };

function statusText(t: TaskRow) {
  if (t.status === "cancelled") return "Cancelled";
  if (t.status === "completed") return t.sent_at ? "Sent" : "Completed";
  if (t.status === "waiting_approval") return "Waiting for approval";
  if (t.status === "changes_requested") return "Changes requested";
  return STATE_LABEL[t.state] ?? t.state;
}
function Overdue({ t }: { t: TaskRow }) {
  if (t.status === "completed" || t.status === "cancelled") return null;
  const d = t.days_overdue;
  if (d === null) return t.due_day ? null : <span className="text-xs text-slate-400">No date</span>;
  if (d === 0) return <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">Due today</span>;
  const cls = d >= 8 ? "bg-red-100 text-red-800" : d >= 3 ? "bg-orange-100 text-orange-800" : "bg-amber-100 text-amber-800";
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${cls}`}>{d} day{d === 1 ? "" : "s"}</span>;
}
function DueCell({ t }: { t: TaskRow }) {
  if (t.due_on) return <span className="whitespace-nowrap">{fmtYmd(t.due_on as string)}</span>;
  if (t.due_at) return <span className="whitespace-nowrap">{fmtShort(t.due_at as string)}</span>;
  if (t.scheduled_on || t.scheduled_at) return <span className="whitespace-nowrap text-slate-500"><span className="text-[11px] uppercase tracking-wide text-slate-400">Scheduled</span> · {t.scheduled_on ? fmtYmd(t.scheduled_on as string) : fmtShort(t.scheduled_at as string)}</span>;
  return <span className="text-slate-400">No date</span>;
}

export default async function TasksPage({ searchParams }: { searchParams: SP }) {
  const me = await requireUser();
  const sp = await searchParams;
  const team = can(me, "tasks.view_all") || isManager(me);
  const assignee = team ? snum(sp, "assignee") : undefined;
  const stateRaw = sget(sp, "state");
  const status = stateRaw === "all" ? "all" : sget(sp, "status") ?? "open";
  const state = stateRaw === "all" ? undefined : stateRaw;
  const rawTypes = sp.type === undefined ? [] : Array.isArray(sp.type) ? sp.type : [sp.type];
  const types = rawTypes.flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean);
  const campaignRaw = sget(sp, "campaign"), senderRaw = sget(sp, "sender");
  const idOrNone = (v?: string): number | "none" | undefined => (v === "none" ? "none" : v && /^\d+$/.test(v) ? Number(v) : undefined);
  const due = sget(sp, "due"), daysOverdue = sget(sp, "days_overdue")?.replace("8plus", "8+"), search = sget(sp, "q"), sort = sget(sp, "sort");
  const showTest = sget(sp, "test") === "1" && (await demoOn());
  const blocked = sget(sp, "blocked") === "1";
  const page = snum(sp, "page") ?? 1;
  const openId = snum(sp, "task");

  const [list, summary, users, campaigns, senders] = await Promise.all([
    listTasksView(me, { assignee, status: state === "completed" || state === "cancelled" ? state : status, state, types, campaign: idOrNone(campaignRaw), sender: idOrNone(senderRaw), due, daysOverdue, blocked, q: search, includeTest: showTest, sort, defaultSort: "-days_overdue", page, pageSize: 50 }),
    taskSummary(me, { assignee, includeTest: showTest }),
    team ? assignableUsers() : Promise.resolve([]),
    listCampaigns(),
    listSenders(),
  ]);
  const detail = openId ? await getTaskDetail(me, openId).catch(() => null) : null;
  const open = detail ? enrich(Object.assign(detail, list.all.find((t) => t.id === openId) ?? {}) as never, todayYmd()) : null;

  // Every link on the page is built from the current view, so nothing a person chose is lost by clicking something else.
  const cur: Record<string, string | undefined> = { assignee: assignee ? String(assignee) : undefined, state: stateRaw, type: types.length ? types.join(",") : undefined, campaign: campaignRaw, sender: senderRaw, due, days_overdue: daysOverdue, blocked: blocked ? "1" : undefined, q: search, test: showTest ? "1" : undefined, sort };
  const url = (over: Record<string, string | number | undefined | null>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...cur, ...over })) if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
    const s = u.toString();
    return s ? `/tasks?${s}` : "/tasks";
  };
  const filtersOn = !!(state || types.length || campaignRaw || senderRaw || due || daysOverdue || blocked || search || status !== "open" || showTest);
  const who = assignee ? users.find((u) => u.id === assignee)?.name ?? "One person" : team ? "Everyone" : "Your tasks";
  const chip = (label: string, count: number, on: boolean, href: string, tone: "red" | "amber" | "slate" | "blue") => {
    const tones = { red: "border-red-200 bg-red-50 text-red-800", amber: "border-amber-200 bg-amber-50 text-amber-900", slate: "border-slate-200 bg-white text-slate-700", blue: "border-sky-200 bg-sky-50 text-sky-900" };
    return (
      <Link href={href} aria-pressed={on} className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[13px] font-medium no-underline hover:no-underline ${on ? "border-brand-600! bg-brand-600! text-white!" : count ? tones[tone] : "border-slate-200 bg-white text-slate-400"}`}>
        <span>{label}</span><span className="text-base font-semibold tabular-nums leading-none">{count}</span>
      </Link>
    );
  };
  const toggle = (key: string, value: string) => url({ [key]: cur[key] === value ? undefined : value, page: undefined, task: undefined });
  const th = (label: string, field: string, cls = "") => <SortTh label={label} field={field} sort={list.applied_sort === "-days_overdue" && !sort ? undefined : list.applied_sort} href={(s) => url({ sort: s, page: undefined, task: undefined })} className={cls} />;
  const from = list.total ? (list.page - 1) * list.page_size + 1 : 0, to = Math.min(list.page * list.page_size, list.total);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Tasks</h1>
          <p className="mt-0.5 text-sm text-slate-500">{who} · {status === "open" && !state ? "open tasks" : state ? STATE_LABEL[state]?.toLowerCase() ?? state : status === "all" ? "all tasks" : status} · times in Asia/Hebron</p>
        </div>
        <div className="flex gap-2">
          <Link href="/my-work" className="btn">My work</Link>
          <Link href="/plan" className="btn">Today / tomorrow plan</Link>
        </div>
      </div>
      <Flash ok={sget(sp, "ok")} err={sget(sp, "err")} />

      {team && (
        <div className="panel flex flex-wrap items-center gap-1 p-1" role="group" aria-label="Whose tasks">
          <Link href={url({ assignee: undefined, page: undefined, task: undefined })} aria-current={!assignee ? "true" : undefined} className={`rounded-md px-3 py-1.5 text-[13px] font-medium no-underline hover:no-underline ${!assignee ? "bg-brand-600 text-white! shadow-sm" : "text-slate-600 hover:bg-slate-100"}`}>Everyone</Link>
          {users.map((u) => (
            <Link key={u.id} href={url({ assignee: u.id, page: undefined, task: undefined })} aria-current={assignee === u.id ? "true" : undefined} className={`rounded-md px-3 py-1.5 text-[13px] font-medium no-underline hover:no-underline ${assignee === u.id ? "bg-brand-600 text-white! shadow-sm" : "text-slate-600 hover:bg-slate-100"}`}>{u.name}</Link>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {chip("Overdue", summary.overdue.total, due === "overdue", toggle("due", "overdue"), "red")}
        {!assignee && summary.overdue.by_assignee.slice(0, 5).map((b) => (
          <Link key={b.assignee_id} href={url({ assignee: b.assignee_id, due: "overdue", page: undefined, task: undefined })} className="inline-flex items-center gap-1.5 rounded-lg border border-red-100 bg-white px-2.5 py-1.5 text-xs text-red-800 no-underline hover:bg-red-50 hover:no-underline">{b.name} <b className="tabular-nums">{b.count}</b></Link>
        ))}
        {chip("Blocked", summary.blocked, blocked, url({ blocked: blocked ? undefined : "1", page: undefined, task: undefined }), "amber")}
        {chip("Due today", summary.due_today, due === "today", toggle("due", "today"), "blue")}
        {chip("Due tomorrow", summary.due_tomorrow, due === "tomorrow", toggle("due", "tomorrow"), "slate")}
        {chip("No date", summary.no_date, due === "none", toggle("due", "none"), "slate")}
        <span className="ml-auto text-xs text-slate-500">{summary.open} open in total</span>
      </div>

      <form className="card p-3" action="/tasks">
        {assignee && <input type="hidden" name="assignee" value={assignee} />}
        {sort && <input type="hidden" name="sort" value={sort} />}
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-48 flex-1"><label className="label" htmlFor="t-q">Search</label><input id="t-q" name="q" defaultValue={search ?? ""} placeholder="Title or company" className="input" /></div>
          <div><label className="label" htmlFor="t-status">Status</label>
            <select id="t-status" name="state" defaultValue={state ?? (status === "all" ? "all" : "")} className={`input ${state || status === "all" ? "border-brand-500! bg-brand-50!" : ""}`}>
              <option value="">Open</option><option value="overdue">Overdue</option><option value="blocked">Blocked</option><option value="ready">Ready</option><option value="planned">Planned</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option><option value="all">Everything</option>
            </select></div>
          <div><label className="label" htmlFor="t-camp">Campaign</label>
            <select id="t-camp" name="campaign" defaultValue={campaignRaw ?? ""} className={`input ${campaignRaw ? "border-brand-500! bg-brand-50!" : ""}`}><option value="">All</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}<option value="none">No campaign</option></select></div>
          <div><label className="label" htmlFor="t-sender">Sender</label>
            <select id="t-sender" name="sender" defaultValue={senderRaw ?? ""} className={`input ${senderRaw ? "border-brand-500! bg-brand-50!" : ""}`}><option value="">All</option>{senders.map((s) => <option key={s.id} value={s.id}>{s.display_name}</option>)}<option value="none">No sender</option></select></div>
          <div><label className="label" htmlFor="t-due">Due</label>
            <select id="t-due" name="due" defaultValue={due ?? ""} className={`input ${due ? "border-brand-500! bg-brand-50!" : ""}`}><option value="">Any time</option>{DUE_FILTERS.map((d) => <option key={d} value={d}>{DUE_LABEL[d]}</option>)}</select></div>
          <div><label className="label" htmlFor="t-days">Days overdue</label>
            <select id="t-days" name="days_overdue" defaultValue={daysOverdue ?? ""} className={`input ${daysOverdue ? "border-brand-500! bg-brand-50!" : ""}`}><option value="">Any</option>{OVERDUE_BUCKETS.map((b) => <option key={b} value={b}>{b === "8+" ? "8 or more" : `${b.replace("-", " to ")}`}</option>)}</select></div>
          <div className="flex gap-2"><button className="btn btn-primary">Apply</button>{(filtersOn || assignee || sort) && <Link href="/tasks" className="btn">Reset</Link>}</div>
        </div>
        <details className="mt-3" open={types.length > 0}>
          <summary className="text-[13px] font-medium text-slate-600">Type{types.length ? ` · ${types.join(", ")}` : ""} and more</summary>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
            {TASK_DISPLAY_TYPES.map((t) => <label key={t} className="inline-flex items-center gap-1.5 text-[13px] text-slate-700"><input type="checkbox" name="type" value={t} defaultChecked={types.includes(t)} /> {t}</label>)}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 border-t border-slate-100 pt-2">
            <label className="inline-flex items-center gap-1.5 text-[13px] text-slate-700"><input type="checkbox" name="blocked" value="1" defaultChecked={blocked} /> Blocked only</label>
            <label className="inline-flex items-center gap-1.5 text-[13px] text-slate-700"><input type="checkbox" name="test" value="1" defaultChecked={showTest} /> Show test tasks</label>
          </div>
        </details>
      </form>

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[1120px] text-[13px] [&_td]:px-2 [&_th]:px-2 [&_td:first-child]:pl-3.5 [&_th:first-child]:pl-3.5">
          <thead className="bg-slate-50">
            <tr>
              {th("Task", "title")}{th("Type", "type")}{th("Lead and company", "company")}{th("Campaign", "campaign")}{th("Owner", "owner")}{th("Sender", "sender")}{th("Status", "status")}{th("Due date", "due")}{th("Overdue", "days_overdue")}
              <th className="th">Blocker</th>{th("Last update", "updated")}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {list.rows.map((t) => (
              <tr key={t.id as number} className={`relative hover:bg-brand-50/40 ${openId === t.id ? "bg-brand-50/70" : ""}`}>
                <td className="td max-w-[230px]">
                  <Link href={url({ task: t.id as number, page: list.page > 1 ? list.page : undefined })} scroll={false} title={`Open: ${t.display_title}`} className="block truncate font-medium text-slate-900! no-underline after:absolute after:inset-0 hover:no-underline focus-visible:outline-2 focus-visible:outline-brand-500">{t.display_title}</Link>
                  {!!t.is_demo && <DemoBadge />}{!!t.is_late && <span className="ml-1 rounded bg-slate-100 px-1 text-[10px] font-semibold text-slate-600">LATE</span>}
                </td>
                <td className="td whitespace-nowrap"><span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-700" title={t.step_number ? `Step ${t.step_number} of ${t.step_total}` : undefined}>{t.display_type}</span></td>
                <td className="td max-w-[150px]">{t.lead_id ? <Link href={`/leads/${t.lead_id}`} title={(t.company as string) ?? ""} className="relative z-10 block truncate">{t.company as string}</Link> : <span className="text-slate-400">No lead</span>}</td>
                <td className="td whitespace-nowrap text-slate-600">{t.campaign_name ?? <span className="text-slate-300">—</span>}</td>
                <td className="td whitespace-nowrap">{t.assignee_name as string}</td>
                <td className="td whitespace-nowrap text-slate-600">{t.sender?.display_name ?? <span className="text-slate-300">—</span>}</td>
                <td className="td whitespace-nowrap"><Badge tone={STATE_TONE[t.live_status] ?? "gray"}>{statusText(t)}</Badge></td>
                <td className="td"><DueCell t={t} /></td>
                <td className="td"><Overdue t={t} /></td>
                <td className="td max-w-[170px]"><span className="block truncate text-xs text-slate-600" title={t.blocker_short ?? ""}>{t.blocker_short ?? ""}</span></td>
                <td className="td whitespace-nowrap text-xs text-slate-500" title={fmtDateTime(t.updated_at as string)}>{fmtShort(t.updated_at as string)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!list.rows.length && <Empty>{filtersOn ? "No task matches these filters." : "No open tasks."} {filtersOn && <Link href={url({ state: undefined, type: undefined, campaign: undefined, sender: undefined, due: undefined, days_overdue: undefined, blocked: undefined, q: undefined, test: undefined })}>Clear the filters</Link>}</Empty>}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600">
        <span>{list.total ? `${from} to ${to} of ${list.total}` : "0 tasks"}{list.applied_sort ? ` · sorted by ${list.applied_sort.replace(/^-/, "").replace(/_/g, " ")}${list.applied_sort.startsWith("-") ? ", highest first" : ""}` : ""}</span>
        <span className="flex gap-2">
          {list.page > 1 && <Link className="btn" href={url({ page: list.page - 1 === 1 ? undefined : list.page - 1, task: undefined })}>Previous</Link>}
          {list.has_more && <Link className="btn" href={url({ page: list.page + 1, task: undefined })}>Next</Link>}
        </span>
      </div>

      {open && detail && (
        <>
          <Link href={url({ task: undefined, page: list.page > 1 ? list.page : undefined })} scroll={false} aria-label="Close the task panel" className="fixed inset-0 z-30 bg-slate-900/20" />
          <aside aria-label={`Task ${open.id}`} className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[560px] flex-col border-l border-slate-200 bg-white shadow-2xl">
            <header className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-xs"><span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-medium text-slate-700">{open.display_type}</span><Badge tone={STATE_TONE[open.live_status] ?? "gray"}>{statusText(open)}</Badge><Overdue t={open} />{!!open.is_late && <Badge tone="gray">LATE</Badge>}</div>
                <h2 className="mt-1.5 text-lg font-semibold leading-snug text-slate-900">{open.display_title}</h2>
              </div>
              <Link href={url({ task: undefined, page: list.page > 1 ? list.page : undefined })} scroll={false} className="btn btn-sm shrink-0">Close</Link>
            </header>
            <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm">
                <div><dt className="text-xs text-slate-500">Company</dt><dd>{open.lead_id ? <Link href={`/leads/${open.lead_id}`}>{open.company as string}</Link> : "No lead"}</dd></div>
                <div><dt className="text-xs text-slate-500">Campaign</dt><dd>{open.campaign_name ?? "None"}</dd></div>
                <div><dt className="text-xs text-slate-500">Owner</dt><dd>{open.assignee_name as string}</dd></div>
                <div><dt className="text-xs text-slate-500">Sender</dt><dd>{open.sender ? <>{open.sender.display_name}<span className="block text-xs text-slate-500">{open.sender.email}</span></> : "Not set"}</dd></div>
                <div><dt className="text-xs text-slate-500">Due</dt><dd><DueCell t={open} />{open.window_end_on ? <span className="block text-xs text-slate-500">Window to {fmtYmd(open.window_end_on as string)}</span> : null}</dd></div>
                {open.step_number ? <div><dt className="text-xs text-slate-500">Sequence step</dt><dd>Step {open.step_number as number} of {open.step_total as number}{open.experiment_labels.length ? <span className="block text-xs text-slate-500">Labels: {open.experiment_labels.join(", ")}</span> : null}</dd></div> : null}
                {open.thread_subject ? <div className="col-span-2"><dt className="text-xs text-slate-500">Thread</dt><dd>{open.thread_subject as string}</dd></div> : null}
              </dl>

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">What to do</h3>
                <p className="mt-1.5 rounded-lg bg-brand-50 px-3 py-2.5 text-sm text-slate-800">{whatToDo(open)}</p>
                {open.instructions ? (
                  <>
                    <h4 className="mt-3 text-xs font-medium text-slate-500">Instructions</h4>
                    <div className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[13px] leading-relaxed text-slate-700">{open.instructions as string}</div>
                  </>
                ) : null}
              </section>

              {(open.reason || open.blockers || open.hold_reason || open.moved_reason) && open.status !== "completed" && open.status !== "cancelled" ? (
                <section>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Why blocked</h3>
                  <div className="mt-1.5 space-y-1.5 whitespace-pre-wrap break-words rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-[13px] text-amber-950">
                    {open.reason ? <p>{open.reason as string}</p> : open.blockers ? <p>{open.blockers as string}</p> : null}
                    {open.moved_reason ? <p className="text-amber-900/80">Moved{open.rescheduled_from_on ? ` from ${fmtYmd(open.rescheduled_from_on)}` : open.rescheduled_from ? ` from ${fmtShort(open.rescheduled_from as string)}` : ""}: {open.moved_reason}</p> : null}
                  </div>
                </section>
              ) : null}

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">History</h3>
                <ol className="mt-2 space-y-2.5 border-l border-slate-200 pl-4">
                  {detail.timeline.map((e, i) => (
                    <li key={i} className="relative text-[13px]">
                      <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-slate-300" aria-hidden="true" />
                      <div className="text-slate-800"><b className="font-medium">{EVENT_LABEL[e.event] ?? e.event.replace(/_/g, " ")}</b>{e.actor ? ` · ${e.actor}` : ""}</div>
                      <div className="text-xs text-slate-500">{fmtDateTime(e.at)}</div>
                      {e.text && e.event !== "progress_note" ? <div className="mt-0.5 line-clamp-3 break-words text-slate-600">{e.text}</div> : null}
                    </li>
                  ))}
                </ol>
                {open.sent_at ? <p className="mt-2 text-[13px] text-slate-600">Sent {fmtDateTime(open.sent_at as string)}</p> : null}
                {detail.approvals.length > 0 && (
                  <ul className="mt-2 space-y-1 text-[13px] text-slate-600">
                    {detail.approvals.map((a) => <li key={a.id as number}>Approval #{a.id as number}: {String(a.status).replace(/_/g, " ")}{a.decided_by_name ? ` by ${a.decided_by_name}` : ""}{a.comment ? ` · ${a.comment}` : ""}</li>)}
                  </ul>
                )}
              </section>

              <details className="rounded-lg border border-slate-200">
                <summary className="px-3 py-2 text-[13px] font-medium text-slate-700">Internal notes ({detail.notes.length + (open.completion_note && !detail.notes.some((n) => n.kind === "completion") ? 1 : 0)})</summary>
                <div className="space-y-2 border-t border-slate-100 px-3 py-2.5">
                  {detail.notes.map((n) => (
                    <div key={n.id as number} className="text-[13px]">
                      <div className="text-xs text-slate-500">{n.kind === "completion" ? "Completion note" : "Progress note"} · {(n.actor_name as string) ?? "Unknown"} · {fmtDateTime(n.created_at as string)}</div>
                      <div className="whitespace-pre-wrap break-words text-slate-700">{n.body as string}</div>
                    </div>
                  ))}
                  {open.completion_note && !detail.notes.some((n) => n.kind === "completion") ? <div className="whitespace-pre-wrap break-words text-[13px] text-slate-700">{open.completion_note as string}</div> : null}
                  {!detail.notes.length && !open.completion_note ? <p className="text-[13px] text-slate-500">No notes on this task.</p> : null}
                </div>
              </details>

              <section className="rounded-lg bg-slate-50 px-3 py-2.5 text-xs text-slate-600">
                <div><span className="text-slate-500">Original title:</span> <span className="break-words text-slate-800">{open.title as string}</span></div>
                <div className="mt-1">Task #{open.id as number} · stored status {TASK_STATUS_LABEL[open.status as keyof typeof TASK_STATUS_LABEL] ?? (open.status as string)}{open.prep_status ? ` · ${String(open.prep_status).replace(/_/g, " ")}` : ""}{open.action_type ? ` · ${open.action_type as string}` : ""}</div>
                <div className="mt-1">Created {fmtDateTime(open.created_at as string)} by {open.created_by_name as string} · updated {fmtDateTime(open.updated_at as string)}</div>
              </section>
            </div>
            <footer className="flex flex-wrap gap-2 border-t border-slate-100 px-5 py-3">
              <Link href={`/tasks/${open.id}`} className="btn btn-primary">Open the full task</Link>
              {open.lead_id ? <Link href={`/leads/${open.lead_id}`} className="btn">Lead</Link> : null}
              {open.campaign_id ? <Link href={`/campaigns?campaign=${open.campaign_id}`} className="btn">Campaign</Link> : null}
            </footer>
          </aside>
        </>
      )}
    </div>
  );
}
