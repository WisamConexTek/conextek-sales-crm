import Link from "next/link";
import { requireUser, can, isManager } from "@/lib/auth";
import { getReport, getRangeReport, rate, type Granularity, type Metrics } from "@/lib/service/reports";
import { assignableUsers } from "@/lib/service/users";
import { Card, PageHeader, Stat } from "@/components/ui";
import { pct } from "@/lib/format";
import { todayYmd } from "@/lib/db";
import { q, sget, snum, type SP } from "@/lib/view";

const COLS: [keyof Metrics | "fb" | "fub", string][] = [
  ["leads_added", "Leads added"], ["first_emails", "First emails"], ["fb", "First-email bounce"], ["follow_ups", "Follow-ups"], ["fub", "Follow-up bounce"],
  ["replies", "Replies"], ["meetings", "Meetings"], ["won", "Won"], ["lost", "Lost"], ["completed", "Tasks done"],
];
const cell = (m: Metrics, k: keyof Metrics | "fb" | "fub") =>
  k === "fb" ? (m.first_emails ? `${pct(rate(m.first_email_bounces, m.first_emails))} (${m.first_email_bounces}/${m.first_emails})` : "—")
  : k === "fub" ? (m.follow_ups ? `${pct(rate(m.follow_up_bounces, m.follow_ups))} (${m.follow_up_bounces}/${m.follow_ups})` : "—")
  : m[k];

export default async function Reports({ searchParams }: { searchParams: SP }) {
  const me = await requireUser();
  const sp = await searchParams;
  const g = (["day", "week", "month"].includes(sget(sp, "g") ?? "") ? sget(sp, "g") : "day") as Granularity;
  if (sget(sp, "all") === "1" || sget(sp, "from") || (!sget(sp, "g") && !sget(sp, "at"))) return RangeView({ me, sp });
  const r = await getReport(me, { granularity: g, at: sget(sp, "at"), employee: snum(sp, "employee") });
  const users = await assignableUsers();
  const team = can(me, "reports.view") || isManager(me);
  const base = { g, employee: r.employee ?? undefined };
  const t = r.totals;
  const title = { day: "Daily", week: "Weekly", month: "Monthly" }[g];

  return (
    <div className="space-y-5">
      <PageHeader title={team ? "Reports" : "My numbers"} sub={`${title} view · ${r.current.label} · timezone ${r.tz} · counted from logged records only`}>
        {(["day", "week", "month"] as Granularity[]).map((x) => <Link key={x} href={`/reports${q({ ...base, g: x })}`} className={`btn ${x === g ? "btn-primary" : ""}`}>{{ day: "Daily", week: "Weekly", month: "Monthly" }[x]}</Link>)}
        {can(me, "reports.export") && <Link href={`/export/report${q({ ...base, at: r.at })}`} className="btn">Export CSV</Link>}
      </PageHeader>

      <div className="card flex flex-wrap items-end gap-3 p-3">
        <Link href={`/reports${q({ ...base, at: r.prevStart })}`} className="btn btn-sm">← Earlier</Link>
        <Link href={`/reports${q(base)}`} className="btn btn-sm">Current</Link>
        {r.nextStart <= todayYmd() && <Link href={`/reports${q({ ...base, at: r.nextStart })}`} className="btn btn-sm">Later →</Link>}
        {team && (
          <form className="ml-auto flex items-end gap-2">
            <input type="hidden" name="g" value={g} /><input type="hidden" name="at" value={r.at} />
            <div><label className="label">Employee</label><select name="employee" defaultValue={r.employee ?? ""} className="input"><option value="">Everyone</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
            <button className="btn">Apply</button>
          </form>
        )}
      </div>

      <RangeForm team={team} users={users} employee={r.employee} />
      <UnknownNotice c={r.unknownCounts} canFix={can(me, "history.import")} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
        <Stat label="Leads added" value={t.leads_added} />
        <Stat label="First emails sent" value={t.first_emails} />
        <Stat label="First-email bounce rate" value={pct(rate(t.first_email_bounces, t.first_emails))} sub={`${t.first_email_bounces} of ${t.first_emails}`} tone={rate(t.first_email_bounces, t.first_emails)! > 0.05 ? "red" : undefined} />
        <Stat label="Follow-ups sent" value={t.follow_ups} sub={`bounce ${pct(rate(t.follow_up_bounces, t.follow_ups))} (${t.follow_up_bounces}/${t.follow_ups})`} />
        <Stat label="Replies" value={t.replies} tone={t.replies ? "green" : undefined} />
        <Stat label="Meetings" value={t.meetings} />
        <Stat label="Won" value={t.won} tone={t.won ? "green" : undefined} />
        <Stat label="Lost" value={t.lost} />
        <Stat label="Tasks completed" value={t.completed} />
        <Stat label="Overdue now" value={r.totalOverdue} tone={r.totalOverdue ? "red" : undefined} sub="open tasks past due, as of now" />
      </div>

      {team && (
        <Card title={`By employee — ${r.current.label}`}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="border-b border-slate-200"><tr><th className="th">Employee</th>{COLS.map(([, l]) => <th key={l} className="th">{l}</th>)}<th className="th">Overdue now</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {r.byEmployee.map((e) => (
                  <tr key={e.user.id}><td className="td font-medium">{e.user.name}{!e.user.active && <span className="text-xs text-slate-400"> (disabled)</span>}</td>
                    {COLS.map(([k]) => <td key={k} className="td whitespace-nowrap">{cell(e.m, k)}</td>)}
                    <td className={`td ${e.overdue ? "font-medium text-red-600" : ""}`}>{e.overdue}</td></tr>
                ))}
                <tr className="bg-slate-50 font-semibold"><td className="td">Total</td>{COLS.map(([k]) => <td key={k} className="td whitespace-nowrap">{cell(t, k)}</td>)}<td className="td">{r.totalOverdue}</td></tr>
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card title={`${title} breakdown`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="border-b border-slate-200"><tr><th className="th">Period</th>{COLS.map(([, l]) => <th key={l} className="th">{l}</th>)}</tr></thead>
            <tbody className="divide-y divide-slate-100">
              {[...r.buckets].reverse().map((b) => (
                <tr key={b.start} className={b.start === r.current.start ? "bg-brand-50/50" : ""}>
                  <td className="td whitespace-nowrap font-medium"><Link href={`/reports${q({ ...base, at: b.start })}`}>{b.label}</Link></td>
                  {COLS.map(([k]) => <td key={k} className="td whitespace-nowrap">{cell(b.m, k)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="text-xs text-slate-500">
        <b>How numbers are counted.</b> Only records that were actually logged are counted — nothing is estimated and test data is excluded. Each thing is counted on the date it <b>happened</b>, not the date it was entered:
        leads on their original lead date, sends and replies on the day they were sent/received, bounces on the day the bounce happened. Records with an unknown date are never put into a period (see “All data”).
        First-email and follow-up figures are kept separate. Bounce rate = bounces that happened in the period ÷ emails (or follow-ups) sent in the period. Meetings / Won / Lost count stage changes into a stage flagged that way in Settings.
        Tasks completed are counted on the completion date. “Overdue now” is a live snapshot, not a historical figure.
      </p>
    </div>
  );
}

type U = { id: number; name: string } | Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
function RangeForm({ team, users, employee, from, to }: { team: boolean; users: U[]; employee: number | null; from?: string; to?: string }) {
  return (
    <form className="card flex flex-wrap items-end gap-3 p-3">
      <div><label className="label">From</label><input type="date" name="from" defaultValue={from} className="input" required /></div>
      <div><label className="label">To</label><input type="date" name="to" defaultValue={to} className="input" /></div>
      {team && <div><label className="label">Employee</label><select name="employee" defaultValue={employee ?? ""} className="input"><option value="">Everyone</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>}
      <button className="btn">Custom period</button>
      <Link href={`/reports${q({ all: 1, employee })}`} className="btn btn-primary">All data (since the beginning)</Link>
    </form>
  );
}
function UnknownNotice({ c, canFix }: { c: { leads: number; activities: number }; canFix: boolean }) {
  if (!c.leads && !c.activities) return null;
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      {c.leads} lead{c.leads === 1 ? "" : "s"} and {c.activities} activit{c.activities === 1 ? "y" : "ies"} have no known original date. They are not counted in any dated period (we never assume “today”); they are included under “All data”.
      {canFix && <> <Link href="/settings/history">Fix dates →</Link></>}
    </div>
  );
}

async function RangeView({ me, sp }: { me: Awaited<ReturnType<typeof requireUser>>; sp: Record<string, string | string[] | undefined> }) {
  const all = sget(sp, "all") === "1" || !sget(sp, "from");
  const r = await getRangeReport(me, { all, from: sget(sp, "from"), to: sget(sp, "to"), employee: snum(sp, "employee") });
  const users = await assignableUsers();
  const team = can(me, "reports.view") || isManager(me);
  const t = r.totals;
  const title = all ? `All data · ${r.from} → ${r.to} (+ unknown dates)` : `${r.from} → ${r.to}`;
  const brk = { day: "Daily", week: "Weekly", month: "Monthly" }[r.breakdown];
  const exp = q({ all: all ? 1 : undefined, from: all ? undefined : r.from, to: all ? undefined : r.to, employee: r.employee });
  return (
    <div className="space-y-5">
      <PageHeader title={team ? "Reports" : "My numbers"} sub={`${title} · timezone ${r.tz} · counted from logged records only`}>
        <Link href="/reports?g=day" className="btn">Daily / weekly / monthly</Link>
        {can(me, "reports.export") && <Link href={`/export/report${exp}`} className="btn">Export CSV</Link>}
      </PageHeader>
      <RangeForm team={team} users={users} employee={r.employee} from={r.from} to={r.to} />
      <UnknownNotice c={r.unknownCounts} canFix={can(me, "history.import")} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
        <Stat label="Leads added" value={t.leads_added} sub={r.unknown ? `${r.unknown.leads_added} with unknown date` : undefined} />
        <Stat label="First emails sent" value={t.first_emails} />
        <Stat label="First-email bounce rate" value={pct(rate(t.first_email_bounces, t.first_emails))} sub={`${t.first_email_bounces} of ${t.first_emails}`} tone={rate(t.first_email_bounces, t.first_emails)! > 0.05 ? "red" : undefined} />
        <Stat label="Follow-ups sent" value={t.follow_ups} sub={`bounce ${pct(rate(t.follow_up_bounces, t.follow_ups))} (${t.follow_up_bounces}/${t.follow_ups})`} />
        <Stat label="Replies" value={t.replies} tone={t.replies ? "green" : undefined} />
        <Stat label="Meetings" value={t.meetings} />
        <Stat label="Won" value={t.won} tone={t.won ? "green" : undefined} />
        <Stat label="Lost" value={t.lost} />
        <Stat label="Tasks completed" value={t.completed} />
        <Stat label="Overdue now" value={r.totalOverdue} tone={r.totalOverdue ? "red" : undefined} sub="open tasks past due, as of now" />
      </div>
      {team && (
        <Card title="By employee">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="border-b border-slate-200"><tr><th className="th">Employee</th>{COLS.map(([, l]) => <th key={l} className="th">{l}</th>)}</tr></thead>
              <tbody className="divide-y divide-slate-100">
                {r.byEmployee.map((e) => (
                  <tr key={e.user.id}><td className="td font-medium">{e.user.name}{!e.user.active && <span className="text-xs text-slate-400"> (disabled)</span>}</td>{COLS.map(([k]) => <td key={k} className="td whitespace-nowrap">{cell(e.m, k)}</td>)}</tr>
                ))}
                <tr className="bg-slate-50 font-semibold"><td className="td">Total</td>{COLS.map(([k]) => <td key={k} className="td whitespace-nowrap">{cell(t, k)}</td>)}</tr>
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <Card title={`${brk} breakdown (dated records only)`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="border-b border-slate-200"><tr><th className="th">Period</th>{COLS.map(([, l]) => <th key={l} className="th">{l}</th>)}</tr></thead>
            <tbody className="divide-y divide-slate-100">
              {[...r.buckets].reverse().map((b) => (
                <tr key={b.start}><td className="td whitespace-nowrap font-medium">{b.label}</td>{COLS.map(([k]) => <td key={k} className="td whitespace-nowrap">{cell(b.m, k)}</td>)}</tr>
              ))}
              {r.unknown && <tr className="bg-amber-50/60"><td className="td font-medium">Date unknown</td>{COLS.map(([k]) => <td key={k} className="td whitespace-nowrap">{cell(r.unknown!, k)}</td>)}</tr>}
            </tbody>
          </table>
        </div>
      </Card>
      <p className="text-xs text-slate-500">Each thing is counted on the date it happened (lead date, send date, reply date, bounce date) — not the day it was entered. {all ? "“All data” includes records whose date is unknown; they appear on their own row." : "Records with an unknown date are not included in a custom period."} Test data is always excluded.</p>
    </div>
  );
}
