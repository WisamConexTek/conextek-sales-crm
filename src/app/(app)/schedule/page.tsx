import Link from "next/link";
import { requireUser, can, isManager } from "@/lib/auth";
import { schedule, STATES } from "@/lib/service/schedule";
import { assignableUsers } from "@/lib/service/users";
import { listCampaigns, listChannels, listProjects } from "@/lib/service/campaigns";
import { addDays, todayYmd } from "@/lib/db";
import { Badge, Card, Empty, LeadLink, PageHeader, StatusBadge } from "@/components/ui";
import { fmtShort, fmtDate, fmtDateTime, isDateOnlyTime } from "@/lib/format";
import { q, sget, snum, type SP } from "@/lib/view";

const PREP: Record<string, string> = { validation_needed: "Validation needed", draft_needed: "Draft needed", internal_review: "Internal review", user_approval_needed: "User approval needed", ready_for_execution: "Ready for authorized execution" };
const TONE = { overdue: "red", blocked: "amber", ready: "green", planned: "gray", completed: "blue" } as const;

export default async function Schedule({ searchParams }: { searchParams: SP }) {
  const me = await requireUser();
  const sp = await searchParams;
  const today = todayYmd(), tomorrow = addDays(today, 1);
  const date = sget(sp, "date");
  const view = sget(sp, "view") === "tomorrow" ? "tomorrow" : date ? undefined : "today";
  const f = { view: view as "today" | "tomorrow" | undefined, date, employee: snum(sp, "employee"), project: snum(sp, "project"), campaign: snum(sp, "campaign"), channel: sget(sp, "channel"), state: sget(sp, "state") };
  const [r, users, camps, channels, projects] = await Promise.all([schedule(me, f), assignableUsers(), listCampaigns(), listChannels(), listProjects()]);
  const team = can(me, "tasks.view_all") || isManager(me);
  const keep = { employee: f.employee, project: f.project, campaign: f.campaign, channel: f.channel, state: f.state };
  const label = r.from === today ? "Today" : r.from === tomorrow ? "Tomorrow" : r.from;
  return (
    <div className="space-y-5">
      <PageHeader title="Today & Tomorrow" sub={`${label} · ${r.from} · times shown in ${r.timezone}`}>
        <Link href={`/schedule${q({ ...keep, view: "today" })}`} className={`btn ${r.from === today && !date ? "btn-primary" : ""}`}>Today</Link>
        <Link href={`/schedule${q({ ...keep, view: "tomorrow" })}`} className={`btn ${r.from === tomorrow && !date ? "btn-primary" : ""}`}>Tomorrow</Link>
      </PageHeader>
      <form className="card flex flex-wrap items-end gap-3 p-3">
        <div><label className="label">Date</label><input type="date" name="date" defaultValue={r.from} className="input" /></div>
        {team && <div><label className="label">Employee</label><select name="employee" defaultValue={f.employee ?? ""} className="input"><option value="">Everyone</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>}
        <div><label className="label">Project</label><select name="project" defaultValue={f.project ?? ""} className="input"><option value="">All</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
        <div><label className="label">Campaign</label><select name="campaign" defaultValue={f.campaign ?? ""} className="input"><option value="">All</option>{camps.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <div><label className="label">Channel</label><select name="channel" defaultValue={f.channel ?? ""} className="input"><option value="">All</option>{channels.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}</select></div>
        <div><label className="label">Status</label><select name="state" defaultValue={f.state ?? ""} className="input"><option value="">All</option>{STATES.map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}</select></div>
        <button className="btn btn-primary">Apply</button><Link href="/schedule" className="btn">Reset</Link>
      </form>
      <div className="flex flex-wrap gap-2 text-sm">
        {STATES.map((s) => <Link key={s} href={`/schedule${q({ ...keep, date: r.from, state: f.state === s ? undefined : s })}`} className="no-underline"><Badge tone={TONE[s]}>{s[0].toUpperCase() + s.slice(1)}: {r.counts[s]}</Badge></Link>)}
      </div>
      <Card>
        {r.rows.length === 0 ? <Empty>Nothing scheduled for this day with these filters. Tasks appear here when they have a scheduled time or a due date on that day.</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs uppercase tracking-wide text-slate-500"><th className="py-1 pr-3 font-medium">When</th><th className="pr-3 font-medium">Employee</th><th className="pr-3 font-medium">Project / campaign</th><th className="pr-3 font-medium">Lead / contact</th><th className="pr-3 font-medium">Channel · action</th><th className="pr-3 font-medium">Preparation</th><th className="font-medium">Status</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {r.rows.map((t) => (
                  <tr key={t.id} className="align-top">
                    <td className="py-2 pr-3 whitespace-nowrap">{t.sent_at ? <>{fmtDateTime(t.sent_at)}<div className="text-xs text-emerald-700">sent at this time</div></> : isDateOnlyTime(t.at) ? <>{fmtDate(t.at)}<div className="text-xs text-slate-400">date only (no set time)</div></> : <>{fmtShort(t.at)}<div className="text-xs text-slate-400">{t.at_source === "due_at" ? "due date (no schedule)" : "scheduled"}</div></>}</td>
                    <td className="pr-3">{t.employee}</td>
                    <td className="pr-3">{t.campaign ? <>{t.project}<div className="text-xs text-slate-500">{t.campaign}</div></> : <span className="text-amber-700">no campaign</span>}</td>
                    <td className="pr-3">{t.company ? <LeadLink id={t.lead_id} company={t.company} /> : "—"}<div className="text-xs text-slate-500">{t.contact ?? ""}</div></td>
                    <td className="pr-3">{t.channel ?? "—"}<div className="text-xs text-slate-500">{t.action_type ?? ""}</div></td>
                    <td className="pr-3">{t.prep_label ? <span className="font-medium text-emerald-700">{t.prep_label}</span> : t.prep_status ? PREP[t.prep_status] : <span className="text-slate-400">not set</span>}{t.message_version_id ? <div className="text-xs text-slate-500">message version #{t.message_version_id}</div> : null}{t.state === "completed" && t.activity_id ? <div className="text-xs text-slate-500">activity #{t.activity_id}</div> : null}{t.blocked_reason && <div className="text-xs text-amber-700">Blocker: {t.blocked_reason}</div>}</td>
                    <td><Badge tone={TONE[t.state as keyof typeof TONE]}>{t.state}</Badge>{t.is_overdue && t.state === "blocked" && <div className="text-xs text-red-600">also overdue</div>}<div className="mt-1"><Link href={`/tasks/${t.id}`} className="text-xs">{t.title}</Link></div><StatusBadge status={t.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="text-xs text-slate-400">“Ready” is a preparation state only. It never means someone is allowed to contact the lead: that needs the Owner’s send authorization and a passing eligibility check.</p>
    </div>
  );
}
