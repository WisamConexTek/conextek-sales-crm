import { Suspense } from "react";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { dashScope, resolvePeriod } from "@/lib/service/dashboard";
import { assignableUsers } from "@/lib/service/users";
import { addDays, todayYmd } from "@/lib/db";
import { Flash, PageHeader } from "@/components/ui";
import { Skeleton } from "@/components/dashboard/charts";
import { ActivitySection, LeadsWaiting, NeedsAction, PipelineSection, ResultsSection, SendingToday, TeamSection, WorkQueue } from "@/components/dashboard/sections";
import { q, sget, snum, type SP } from "@/lib/view";

/**
 * The dashboard, top to bottom, answers three questions in order:
 *   1. What needs a person right now?   (live: approvals, replies, late and blocked work, sending limits)
 *   2. What did we get done?            (the selected period, compared with the one before)
 *   3. Where does everything stand?     (pipeline by stage and campaign, the team, the latest activity)
 * Each section loads its own data (src/lib/service/dashboard.ts) and streams in on its own.
 */
export default async function Dashboard({ searchParams }: { searchParams: SP }) {
  const me = await requireUser();
  const sp = await searchParams;
  const sc = dashScope(me, snum(sp, "employee"));
  const period = resolvePeriod({ from: sget(sp, "from"), to: sget(sp, "to"), all: sget(sp, "all") === "1" });
  const users = sc.teamView ? await assignableUsers() : [];
  const today = todayYmd();
  const who = sc.teamView ? (sc.requested ? users.find((u) => u.id === sc.requested)?.name ?? "one person" : "whole team") : "your work";
  const preset = (label: string, key: string, params: Record<string, string | number | undefined>) => (
    <Link href={`/${q({ ...params, employee: sc.requested })}`} className={`btn btn-sm ${period.preset === key ? "btn-primary" : ""}`}>{label}</Link>
  );
  const props = { me, sc };

  return (
    <div className="space-y-6">
      <div>
        <PageHeader title="Dashboard" sub={`${who} · results for ${period.label.toLowerCase()}`}>
          {preset("Today", "today", { from: today, to: today })}
          {preset("7 days", "7d", {})}
          {preset("30 days", "30d", { from: addDays(today, -29), to: today })}
          {preset("All data", "all", { all: 1 })}
        </PageHeader>
        <Flash ok={sget(sp, "ok")} err={sget(sp, "err")} />
        <details className="card -mt-2 px-3 py-2 text-sm" open={period.preset === "custom" || !!sc.requested}>
          <summary className="text-slate-600">{sc.teamView ? "Custom dates and person" : "Custom dates"}</summary>
          <form className="mt-2 flex flex-wrap items-end gap-3 pb-1">
            <div><label className="label" htmlFor="dash-from">From</label><input id="dash-from" type="date" name="from" defaultValue={period.all ? "" : period.from} className="input" /></div>
            <div><label className="label" htmlFor="dash-to">To</label><input id="dash-to" type="date" name="to" defaultValue={period.all ? "" : period.to} className="input" /></div>
            {sc.teamView && (
              <div>
                <label className="label" htmlFor="dash-emp">Person</label>
                <select id="dash-emp" name="employee" defaultValue={sc.requested ?? ""} className="input">
                  <option value="">Everyone</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </div>
            )}
            <button className="btn btn-primary">Apply</button>
            <Link href="/" className="btn">Reset</Link>
          </form>
        </details>
      </div>

      <Suspense fallback={<Skeleton className="h-28" />}><NeedsAction {...props} /></Suspense>

      <div className={`grid gap-5 ${sc.manager ? "lg:grid-cols-3" : ""}`}>
        <div className={sc.manager ? "lg:col-span-2" : ""}><Suspense fallback={<Skeleton className="h-72" />}><WorkQueue {...props} /></Suspense></div>
        {sc.manager && <Suspense fallback={<Skeleton className="h-72" />}><SendingToday {...props} /></Suspense>}
      </div>

      <Suspense fallback={<Skeleton className="h-48" />}><LeadsWaiting {...props} /></Suspense>
      <Suspense fallback={<Skeleton className="h-72" />}><ResultsSection {...props} period={period} /></Suspense>
      {sc.teamView ? (
        <>
          <Suspense fallback={<Skeleton className="h-64" />}><PipelineSection {...props} period={period} /></Suspense>
          <Suspense fallback={<Skeleton className="h-48" />}><TeamSection {...props} period={period} /></Suspense>
          <Suspense fallback={<Skeleton className="h-64" />}><ActivitySection {...props} /></Suspense>
        </>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          <Suspense fallback={<Skeleton className="h-64" />}><PipelineSection {...props} period={period} /></Suspense>
          <Suspense fallback={<Skeleton className="h-64" />}><ActivitySection {...props} /></Suspense>
        </div>
      )}
    </div>
  );
}
