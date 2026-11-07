import Link from "next/link";
import { requireUser, can, isManager } from "@/lib/auth";
import { getDashboard } from "@/lib/service/reports";
import { assignableUsers } from "@/lib/service/users";
import { addDays, todayYmd } from "@/lib/db";
import { Card, Empty, Flash, LeadLink, PageHeader, Stat, StatusBadge, Badge } from "@/components/ui";
import { fmtShort, pct } from "@/lib/format";
import { MESSAGE_KIND_LABEL, ACTIVITY_TYPE_LABEL } from "@/lib/constants";
import { q, sget, snum, type SP, stageMeta } from "@/lib/view";

export default async function Dashboard({ searchParams }: { searchParams: SP }) {
  const me = await requireUser();
  const sp = await searchParams;
  const d = await getDashboard(me, { from: sget(sp, "from"), to: sget(sp, "to"), employee: snum(sp, "employee"), all: sget(sp, "all") === "1" || (!sget(sp, "from") && !sget(sp, "to")) });
  const users = await assignableUsers();
  const teamView = can(me, "reports.view") || isManager(me);
  const today = todayYmd();
  const range = d.all ? "All data (since the beginning)" : d.from === d.to ? (d.from === today ? "Today" : d.from) : `${d.from} → ${d.to}`;
  const maxStage = Math.max(1, ...d.byStage.map((s) => s.n));
  const sm = await stageMeta();
  const empName = d.employee ? users.find((u) => u.id === d.employee)?.name : null;
  const preset = (label: string, from: string, to: string) => (
    <Link href={`/${q({ from, to, employee: d.employee })}`} className={`btn btn-sm ${!d.all && d.from === from && d.to === to ? "btn-primary" : ""}`}>{label}</Link>
  );

  return (
    <div>
      <PageHeader title="Dashboard" sub={`${range}${empName ? ` · ${empName}` : teamView ? " · whole team" : " · your work"}`}>
        {preset("Today", today, today)}
        {preset("Yesterday", addDays(today, -1), addDays(today, -1))}
        {preset("7 days", addDays(today, -6), today)}
        {preset("30 days", addDays(today, -29), today)}
        <Link href={`/${q({ all: 1, employee: d.employee })}`} className={`btn btn-sm ${d.all ? "btn-primary" : ""}`}>All data</Link>
      </PageHeader>
      <Flash ok={sget(sp, "ok")} err={sget(sp, "err")} />

      {(d.unknownCounts.leads > 0 || d.unknownCounts.activities > 0) && (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {d.unknownCounts.leads} lead{d.unknownCounts.leads === 1 ? "" : "s"} and {d.unknownCounts.activities} activit{d.unknownCounts.activities === 1 ? "y" : "ies"} have no known original date, so they are <b>not</b> counted in dated periods
          {d.all ? " (they are included in this all-data view)." : " — they only show under “All data”."}
          {can(me, "history.import") && <> <Link href="/settings/history">Fix dates →</Link></>}
        </div>
      )}
      <form className="card mb-5 flex flex-wrap items-end gap-3 p-3">
        <div><label className="label">From</label><input type="date" name="from" defaultValue={d.from} className="input" /></div>
        <div><label className="label">To</label><input type="date" name="to" defaultValue={d.to} className="input" /></div>
        {teamView && (
          <div>
            <label className="label">Employee</label>
            <select name="employee" defaultValue={d.employee ?? ""} className="input">
              <option value="">Everyone</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
        )}
        <button className="btn btn-primary">Apply</button>
        <Link href="/" className="btn">Reset</Link>
      </form>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label={`Activity · ${range.toLowerCase()}`} value={d.m.first_emails + d.m.follow_ups + (d.counts.research ?? 0) + (d.counts.draft ?? 0) + (d.counts.status ?? 0) + d.m.replies}
          sub={`${d.m.first_emails} first emails · ${d.m.follow_ups} follow-ups · ${d.counts.research ?? 0} research · ${d.counts.status ?? 0} stage changes · ${d.m.leads_added} leads added`} />
        <Stat label="New replies" value={d.m.replies} href="/reports" tone={d.m.replies ? "green" : undefined} sub={`${d.m.meetings} meetings · ${d.m.won} won · ${d.m.lost} lost`} />
        <Stat label="First-email bounce rate" value={pct(d.firstBounceRate)} tone={d.firstBounceRate != null && d.firstBounceRate > 0.05 ? "red" : undefined}
          sub={`${d.m.first_email_bounces} of ${d.m.first_emails} first emails · follow-ups: ${pct(d.followBounceRate)} (${d.m.follow_up_bounces}/${d.m.follow_ups})`} />
        <Stat label="Overdue tasks" value={d.overdueCount} tone={d.overdueCount ? "red" : undefined} href="/my-work" sub="as of now" />
        <Stat label="Approvals waiting" value={d.pending.chief + d.pending.wisam} href="/approvals" tone={d.pending.chief + d.pending.wisam ? "amber" : undefined}
          sub={`${d.pending.chief} on Chief · ${d.pending.wisam} on Wisam`} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Leads by stage" right={<Link href="/leads" className="text-xs">All leads →</Link>} className="lg:col-span-1">
          {d.byStage.every((s) => s.n === 0) ? <Empty>No leads yet.</Empty> : (
            <ul className="space-y-2">
              {d.byStage.map((s) => (
                <li key={s.key}>
                  <Link href={`/leads${q({ stage: s.key, owner: d.employee })}`} className="block no-underline hover:no-underline">
                    <div className="flex justify-between text-sm"><span className="text-slate-700">{s.label}{!sm.byKey[s.key]?.active && <span className="text-xs text-slate-400"> (retired)</span>}</span><span className="font-medium">{s.n}</span></div>
                    <div className="mt-0.5 h-2 rounded bg-slate-100"><div className={`h-2 rounded ${s.flag === "won" ? "bg-emerald-500" : s.flag === "lost" ? "bg-red-400" : s.flag === "closed" ? "bg-slate-400" : "bg-brand-500"}`} style={{ width: `${(s.n / maxStage) * 100}%` }} /></div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Approvals waiting" right={<Link href="/approvals" className="text-xs">Open →</Link>}>
          {d.pendingList.length === 0 ? <Empty>Nothing waiting for approval.</Empty> : (
            <ul className="divide-y divide-slate-100">
              {d.pendingList.map((a) => (
                <li key={a.id} className="flex items-start justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <Link href="/approvals" className="block truncate font-medium">{a.title}</Link>
                    <div className="text-xs text-slate-500">{a.company ?? "No lead"} · {a.submitted_by_name} · {fmtShort(a.created_at)}</div>
                  </div>
                  <Badge tone={a.requires === "wisam" ? "purple" : "amber"}>{a.requires === "wisam" ? "Wisam" : "Chief"}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={`Overdue tasks (${d.overdueCount})`} right={<Link href="/my-work" className="text-xs">My Work →</Link>}>
          {d.overdueTasks.length === 0 ? <Empty>No overdue tasks.</Empty> : (
            <ul className="divide-y divide-slate-100">
              {d.overdueTasks.map((t) => (
                <li key={t.id} className="py-2">
                  <div className="flex justify-between gap-2"><span className="font-medium">{t.title}</span><StatusBadge status={t.status} /></div>
                  <div className="text-xs text-slate-500">{t.company ? <LeadLink id={t.lead_id} company={t.company} /> : "No lead"} · {t.assignee_name} · <span className="text-red-600">due {fmtShort(t.due_at)}</span></div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="New replies" className="lg:col-span-1">
          {d.replies.length === 0 ? <Empty>No replies recorded in this period.</Empty> : (
            <ul className="divide-y divide-slate-100">
              {d.replies.map((r) => (
                <li key={r.id} className="py-2">
                  <div className="flex justify-between gap-2"><LeadLink id={r.lead_id} company={r.company} /><span className="text-xs text-slate-500">{fmtShort(r.occurred_at)}</span></div>
                  <p className="line-clamp-2 text-xs text-slate-600">{r.body || r.title}</p>
                  <div className="text-xs text-slate-400">recorded by {r.actor_name}</div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Latest activity" className="lg:col-span-2">
          {d.feed.length === 0 ? <Empty>No activity recorded in this period.</Empty> : (
            <ul className="divide-y divide-slate-100">
              {d.feed.map((a) => (
                <li key={a.id} className="flex items-baseline justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <Badge tone="gray">{a.type === "message" ? MESSAGE_KIND_LABEL[a.message_kind] ?? "Message" : ACTIVITY_TYPE_LABEL[a.type] ?? a.type}</Badge>{" "}
                    <LeadLink id={a.lead_id} company={a.company} />
                    {a.title && <span className="text-slate-500"> — {a.title}</span>}
                  </div>
                  <div className="shrink-0 text-xs text-slate-500">{a.actor_name} · {fmtShort(a.occurred_at)}</div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <p className="mt-4 text-xs text-slate-400">Numbers come only from records logged in the CRM. Demo data is never counted.</p>
    </div>
  );
}
