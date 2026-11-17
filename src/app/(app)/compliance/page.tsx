import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { complianceReport, listSuppressions } from "@/lib/service/compliance";
import { Card, Empty, PageHeader, Stat } from "@/components/ui";
import { SortTh } from "@/components/Sort";
import { parseSort, sortRows, type SortSpec } from "@/lib/sort";
import { fmtDateTime, fmtYmd } from "@/lib/format";
import { q, sget, type SP } from "@/lib/view";

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Read-only: follow-ups that did not happen, leads with nothing planned, stalled drafts and replies left waiting. */
export default async function CompliancePage({ searchParams }: { searchParams: SP }) {
  const me = await requireUser();
  const sp = await searchParams;
  const date = sget(sp, "date");
  const [r, supp] = await Promise.all([complianceReport(me, date), listSuppressions(me, { limit: 1 })]);
  const href = (o: Record<string, string | undefined>) => `/compliance${q({ date, s1: sget(sp, "s1"), s2: sget(sp, "s2"), s3: sget(sp, "s3"), s4: sget(sp, "s4"), ...o })}`;
  const table = (key: string, rows: any[], cols: [string, string, (x: any) => any, ((x: any) => any)?][], empty: string) => {
    const spec: SortSpec<any> = Object.fromEntries(cols.map(([, f, get]) => [f, get]));
    const ps = parseSort(sget(sp, key), Object.keys(spec));
    if (!rows.length) return <Empty>{empty}</Empty>;
    return (
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-slate-50"><tr>{cols.map(([label, f]) => <SortTh key={f} label={label} field={f} sort={ps.applied} href={(s) => href({ [key]: s })} />)}</tr></thead>
          <tbody className="divide-y divide-slate-100">
            {sortRows(rows, spec, ps).slice(0, 300).map((x, i) => <tr key={i}>{cols.map(([, f, get, show]) => <td key={f} className="td">{show ? show(x) : get(x) ?? ""}</td>)}</tr>)}
          </tbody>
        </table>
        {rows.length > 300 && <p className="px-3 py-2 text-xs text-slate-500">Showing the first 300 of {rows.length}. The CSV has all of them.</p>}
      </div>
    );
  };
  const lead = (x: any) => <Link href={`/leads/${x.lead_id}`} className="font-medium">{x.company}</Link>;
  const s = r.sections;
  return (
    <div className="space-y-5">
      <PageHeader title="Compliance" sub={`${fmtYmd(r.date)} · read-only · findings go to the Chief`}>
        <form className="flex items-end gap-2"><input type="date" name="date" defaultValue={r.date} className="input" aria-label="Report date" /><button className="btn">Show</button></form>
        <a className="btn" href={`/export/compliance${q({ date })}`}>Download CSV</a>
      </PageHeader>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Follow-ups due and not sent" value={r.summary.follow_ups_due_not_sent} sub={`${r.summary.overdue_follow_ups} past their due day`} tone={r.summary.follow_ups_due_not_sent ? "red" : "green"} />
        <Stat label="Contacted leads with no next step" value={r.summary.active_contacted_leads_without_next_step} sub="should be 0" tone={r.summary.active_contacted_leads_without_next_step ? "red" : "green"} />
        <Stat label="Stalled drafts" value={r.summary.stalled} sub="no draft, or waiting too long" tone={r.summary.stalled ? "amber" : "green"} />
        <Stat label="Replies not handled in time" value={r.summary.replies_not_handled_in_time} sub={`limit ${r.thresholds.reply_sla_working_hours} working hours`} tone={r.summary.replies_not_handled_in_time ? "red" : "green"} />
      </div>
      {r.suppression.may_be_incomplete && <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">{r.suppression.note} Entries now: {supp.total}.</div>}
      <Card title={`1. Follow-ups due or overdue, not sent (${s.follow_ups_due_not_sent.length})`}>
        {table("s1", s.follow_ups_due_not_sent, [["Company", "company", (x) => x.company, lead], ["Campaign", "campaign", (x) => x.campaign], ["Sender", "sender", (x) => x.sender], ["Step", "step", (x) => x.step], ["Due", "due_on", (x) => x.due_on, (x) => fmtYmd(x.due_on)], ["Days overdue", "days_overdue", (x) => x.days_overdue, (x) => (x.days_overdue > 0 ? <b className="text-red-700">{x.days_overdue}</b> : "")], ["State", "state", (x) => x.state]], "Every follow-up that is due has been sent.")}
      </Card>
      <Card title={`2. Active contacted leads with no next step (${s.active_contacted_leads_without_next_step.length})`}>
        {table("s2", s.active_contacted_leads_without_next_step, [["Company", "company", (x) => x.company, lead], ["Campaign", "campaign", (x) => x.campaign], ["Stage", "stage", (x) => x.stage], ["Messages sent", "messages_sent", (x) => x.messages_sent], ["Last sent", "last_sent_at", (x) => x.last_sent_at, (x) => fmtDateTime(x.last_sent_at)]], "Every contacted lead has a next step.")}
        {s.active_contacted_leads_without_next_step.length > 0 && <p className="mt-2 text-xs text-slate-500">The Owner or the Chief can plan these in Settings, Follow-up sequences, Backfill.</p>}
      </Card>
      <Card title={`3. Stalled (${s.stalled_sequences.length})`}>
        {table("s3", s.stalled_sequences, [["Company", "company", (x) => x.company, lead], ["Step", "step", (x) => x.step], ["Owner", "assignee", (x) => x.assignee], ["Due", "due_on", (x) => x.due_on, (x) => (x.due_on ? fmtYmd(x.due_on) : "")], ["What is stuck", "reason", (x) => x.reason]], "Nothing is stalled.")}
      </Card>
      <Card title={`4. Replies not handled in time (${s.replies_not_handled_in_time.length})`}>
        {table("s4", s.replies_not_handled_in_time, [["Company", "company", (x) => x.company, lead], ["Received", "received_at", (x) => x.received_at, (x) => fmtDateTime(x.received_at)], ["Class", "classification", (x) => x.classification], ["Hours waiting", "hours_waiting", (x) => x.hours_waiting], ["Deadline", "deadline", (x) => x.deadline, (x) => (x.deadline ? fmtDateTime(x.deadline) : "")]], "Every reply was answered in time.")}
      </Card>
    </div>
  );
}
