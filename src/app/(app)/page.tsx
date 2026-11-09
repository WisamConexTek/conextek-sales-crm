import Link from "next/link";
import { requireUser, can, isManager } from "@/lib/auth";
import { getDashboard } from "@/lib/service/reports";
import { sendApprovalPreview } from "@/lib/service/sends";
import { schedule } from "@/lib/service/schedule";
import { assignableUsers } from "@/lib/service/users";
import { addDays, todayYmd } from "@/lib/db";
import { Card, Empty, Flash, LeadLink, PageHeader, Stat, StatusBadge, Badge } from "@/components/ui";
import { fmtShort, fmtYmd, pct } from "@/lib/format";
import { MESSAGE_KIND_LABEL, ACTIVITY_TYPE_LABEL } from "@/lib/constants";
import { q, sget, snum, type SP, stageMeta } from "@/lib/view";

const ago = (iso: string | null | undefined) => { if (!iso) return "—"; const h = (Date.now() - new Date(iso).getTime()) / 3600000; return h < 1 ? "under 1h" : h < 48 ? `${Math.floor(h)}h` : `${Math.floor(h / 24)}d`; };

export default async function Dashboard({ searchParams }: { searchParams: SP }) {
  const me = await requireUser();
  const sp = await searchParams;
  const d = await getDashboard(me, { from: sget(sp, "from"), to: sget(sp, "to"), employee: snum(sp, "employee"), all: sget(sp, "all") === "1" || (!sget(sp, "from") && !sget(sp, "to")) });
  const users = await assignableUsers();
  const sendPrev = await sendApprovalPreview(me, 5);
  const wk = await schedule(me, { from: todayYmd(), to: addDays(todayYmd(), 1) });
  const wkNext = wk.rows.filter((r) => r.state !== "completed").sort((a, b) => (a.state === "overdue" ? 0 : 1) - (b.state === "overdue" ? 0 : 1)).slice(0, 6);
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

      <div className="mb-5 grid gap-5 lg:grid-cols-2">
        {sendPrev && (
          <Card title={`Send approvals waiting: ${sendPrev.count}`} right={<Link href="/send-approvals" className="btn btn-primary btn-sm no-underline">{sendPrev.count ? "Review & approve →" : "Open →"}</Link>}>
            {sendPrev.items.length === 0 ? <Empty>No message versions are waiting for your send approval.</Empty> : (
              <ul className="divide-y divide-slate-100">{sendPrev.items.map((v) => (
                <li key={v.id as number} className="py-1.5 text-sm">
                  <div className="flex justify-between gap-2"><LeadLink id={v.lead_id as number} company={v.company as string} /><Badge tone="purple">{v.campaign as string}</Badge></div>
                  <div className="truncate text-xs text-slate-500" dir="auto">{(v.subject as string) || "(no subject)"}</div>
                </li>))}
                {sendPrev.count > sendPrev.items.length && <li className="py-1.5 text-xs text-slate-500">…and {sendPrev.count - sendPrev.items.length} more</li>}
              </ul>
            )}
          </Card>
        )}
        <Card title="Today & Tomorrow" right={<Link href="/schedule" className="text-xs">Open →</Link>}>
          <div className="mb-2 flex flex-wrap gap-2 text-sm">
            {(["overdue", "blocked", "ready", "completed"] as const).map((s) => <Link key={s} href={`/schedule?state=${s}`} className="no-underline"><Badge tone={s === "overdue" ? "red" : s === "blocked" ? "amber" : s === "ready" ? "green" : "blue"}>{s[0].toUpperCase() + s.slice(1)}: {wk.counts[s]}</Badge></Link>)}
            <span className="text-xs text-slate-400">today &amp; tomorrow · live</span>
          </div>
          {wkNext.length === 0 ? <Empty>Nothing open for today or tomorrow.</Empty> : (
            <ul className="divide-y divide-slate-100">{wkNext.map((r) => (
              <li key={r.id as number} className="py-1.5 text-sm">
                <div className="flex justify-between gap-2"><span className="min-w-0 truncate"><Link href={`/tasks/${r.id}`}>{(r.company as string) ?? r.title}</Link> <span className="text-xs text-slate-500">{(r.action_type as string) ?? (r.channel as string) ?? ""}</span></span>
                  <span className="shrink-0 text-xs text-slate-500">{r.date_only ? `${fmtYmd(r.on as string)} · date only` : fmtShort(r.at as string)} · <Badge tone={r.state === "overdue" ? "red" : r.state === "blocked" ? "amber" : r.state === "ready" ? "green" : "gray"}>{r.state as string}</Badge></span></div>
                {r.reason ? <div className={`text-xs ${r.state === "overdue" ? "text-red-600" : "text-slate-500"}`}>{r.reason as string}</div> : null}
              </li>))}
            </ul>
          )}
        </Card>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label={`Activity · ${range.toLowerCase()}`} value={d.m.first_emails + d.m.follow_ups + (d.counts.research ?? 0) + (d.counts.draft ?? 0) + (d.counts.status ?? 0) + d.m.replies}
          sub={`${d.m.first_emails} first emails · ${d.m.follow_ups} follow-ups · ${d.counts.research ?? 0} research · ${d.counts.status ?? 0} stage changes · ${d.m.leads_added} leads added`} />
        <Stat label="New replies" value={d.m.replies} href="/reports" tone={d.m.replies ? "green" : undefined} sub={`${d.m.meetings} meetings · ${d.m.won} won · ${d.m.lost} lost`} />
        <Stat label="First-email bounce rate" value={pct(d.firstBounceRate)} tone={d.firstBounceRate != null && d.firstBounceRate > 0.05 ? "red" : undefined}
          sub={`${d.m.first_email_bounces} of ${d.m.first_emails} first emails · follow-ups: ${pct(d.followBounceRate)} (${d.m.follow_up_bounces}/${d.m.follow_ups})`} />
        <Stat label="Overdue tasks" value={d.overdueCount} tone={d.overdueCount ? "red" : undefined} href="/my-work"
          sub={d.overdueCount ? `${d.attention.overdueOld} overdue 7+ days · oldest ${ago(d.overdueTasks[0]?.due_at)} · ${d.attention.dueToday} due today` : `${d.attention.dueToday} due today · ${d.attention.dueTomorrow} tomorrow`} />
        {sendPrev ? (
          <Stat label="Send approvals" value={sendPrev.count} href="/send-approvals" tone={sendPrev.count ? "amber" : undefined}
            sub={<>waiting for your OK to send · <Link href="/approvals">{d.pending.chief + d.pending.wisam} task approvals</Link></>} />
        ) : (
                  <Stat label="Approvals waiting" value={d.pending.chief + d.pending.wisam} href="/approvals" tone={d.pending.chief + d.pending.wisam ? "amber" : undefined}
            sub={`${d.pending.chief} on Chief · ${d.pending.wisam} on Wisam${d.pending.chief + d.pending.wisam ? ` · oldest waiting ${ago([d.attention.oldestApproval.chief, d.attention.oldestApproval.wisam].filter(Boolean).sort()[0])}` : ""}`} />
        )}
      </div>

      <Card title="Needs attention now" className="mb-5" right={<span className="text-xs text-slate-500">live · not limited to the date range</span>}>
        <div className="grid gap-5 md:grid-cols-3">
          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Replies not answered yet ({d.attention.unanswered.length})</div>
            {d.attention.unanswered.length === 0 ? <Empty>Every reply from the last 30 days has a response.</Empty> : (
              <ul className="divide-y divide-slate-100">{d.attention.unanswered.map((l) => (
                <li key={l.id} className="flex justify-between gap-2 py-1.5 text-sm"><LeadLink id={l.id} company={l.company} /><span className="shrink-0 text-xs text-red-600">waiting {ago(l.reply_at)}</span></li>
              ))}</ul>
            )}
          </div>
          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Open leads with nothing planned ({d.attention.staleCount})</div>
            {d.attention.stale.length === 0 ? <Empty>Every open lead has work planned or recent activity.</Empty> : (
              <ul className="divide-y divide-slate-100">{d.attention.stale.map((l) => (
                <li key={l.id} className="flex justify-between gap-2 py-1.5 text-sm"><LeadLink id={l.id} company={l.company} /><span className="shrink-0 text-xs text-slate-500">{l.owner_name ?? "no owner"} · quiet {ago(l.last_at)}</span></li>
              ))}</ul>
            )}
            <p className="mt-1 text-xs text-slate-400">No open task and no activity for 7+ days; won, lost and closed leads excluded.</p>
          </div>
          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Workload by person</div>
            {d.attention.workload.length === 0 ? <Empty>No open tasks.</Empty> : (
              <table className="w-full text-sm"><thead><tr className="text-left text-xs text-slate-500"><th className="font-normal">Who</th><th className="font-normal">Open</th><th className="font-normal">Overdue</th><th className="font-normal">Today</th><th className="font-normal">In approval</th></tr></thead>
                <tbody>{d.attention.workload.map((w) => (
                  <tr key={w.id}><td className="py-0.5">{w.name}</td><td>{w.open}</td><td className={w.overdue ? "font-medium text-red-600" : ""}>{w.overdue}</td><td>{w.today}</td><td>{w.waiting}</td></tr>
                ))}</tbody></table>
            )}
            {d.attention.noDueDate > 0 && <p className="mt-1 text-xs text-amber-700">{d.attention.noDueDate} open task{d.attention.noDueDate === 1 ? " has" : "s have"} no due date, so they can never become overdue.</p>}
          </div>
        </div>
      </Card>

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

        {!sendPrev && <Card title="Approvals waiting" right={<Link href="/approvals" className="text-xs">Open →</Link>}>
          {d.pendingList.length === 0 ? <Empty>Nothing waiting for approval.</Empty> : (
            <ul className="divide-y divide-slate-100">
              {d.pendingList.map((a) => (
                <li key={a.id} className="flex items-start justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <Link href={`/approvals?id=${a.id}`} className="block truncate font-medium">{a.title}</Link>
                    <div className="text-xs text-slate-500">{a.company ?? "No lead"} · {a.kind} · from {a.submitted_by_name} · <span className={Date.now() - new Date(a.created_at).getTime() > 2 * 86400000 ? "text-red-600" : ""}>waiting {ago(a.created_at)}</span></div>
                  </div>
                  <Badge tone={a.requires === "wisam" ? "purple" : "amber"}>{a.requires === "wisam" ? "Wisam" : "Chief"}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>}

        <Card title={`Overdue tasks (${d.overdueCount})`} right={<Link href="/my-work" className="text-xs">My Work →</Link>}>
          {d.overdueTasks.length === 0 ? <Empty>No overdue tasks.</Empty> : (
            <>
            {d.attention.overdueByPerson.length > 1 && <p className="mb-1 text-xs text-slate-500">{d.attention.overdueByPerson.map((p) => `${p.name}: ${p.n}`).join(" · ")}</p>}
            <ul className="divide-y divide-slate-100">
              {d.overdueTasks.map((t) => (
                <li key={t.id} className="py-2">
                  <div className="flex justify-between gap-2"><Link href={`/tasks/${t.id}`} className="font-medium">{t.title}</Link><StatusBadge status={t.status} /></div>
                  <div className="text-xs text-slate-500">{t.company ? <LeadLink id={t.lead_id} company={t.company} /> : "No lead"} · {t.assignee_name} · <span className="text-red-600">{ago(t.due_at)} overdue (due {fmtShort(t.due_at)})</span></div>
                </li>
              ))}
            </ul>
            </>
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
