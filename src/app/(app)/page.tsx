import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { dashScope, resolvePeriod } from "@/lib/service/dashboard";
import { assignableUsers } from "@/lib/service/users";
import { addDays, todayYmd } from "@/lib/db";
import { Flash } from "@/components/ui";
import { Band, Skeleton } from "@/components/dashboard/charts";
import { Activity, Agents, Campaigns, FollowUps, FunnelPanel, Kpis, NeedsYou, Replies, Sending, Stages, Team, TodayWork, Trend } from "@/components/dashboard/sections";
import { q, sget, snum, type SP } from "@/lib/view";

/**
 * The dashboard reads top to bottom as one story, and every band holds panels that belong together:
 *   1. Performance  - the selected period: headline numbers, how they moved, and the funnel they add up to.
 *   2. Right now    - live: what needs a person, the work in motion, and today's sending limits.
 *   3. Pipeline     - where the leads stand, by stage and by campaign.
 *   4. Team         - who is carrying what, what the AI agents did, and the latest activity.
 * Each panel loads its own data (src/lib/service/dashboard.ts) and streams in on its own.
 */
export default async function Dashboard({ searchParams }: { searchParams: SP }) {
  const me = await requireUser();
  const sp = await searchParams;
  const sc = dashScope(me, snum(sp, "employee"));
  const period = resolvePeriod({ from: sget(sp, "from"), to: sget(sp, "to"), all: sget(sp, "all") === "1" });
  const users = sc.teamView ? await assignableUsers() : [];
  const today = todayYmd();
  const person = sc.requested ? users.find((u) => u.id === sc.requested)?.name ?? "One person" : null;
  const who = sc.teamView ? person ?? "Whole team" : "Your work";
  const preset = (label: string, key: string, params: Record<string, string | number | undefined>) => (
    <Link href={`/${q({ ...params, employee: sc.requested })}`} aria-current={period.preset === key ? "true" : undefined}
      className={`rounded-md px-3 py-1.5 text-[13px] font-medium no-underline hover:no-underline ${period.preset === key ? "bg-brand-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"}`}>{label}</Link>
  );
  const custom = period.preset === "custom" || !!sc.requested;
  const p = { me, sc };
  const pp = { me, sc, period };
  const slot = (className: string, node: ReactNode, h = "h-80") => <Suspense fallback={<Skeleton className={`${h} ${className}`} />}>{node}</Suspense>;
  const row = "grid gap-3 lg:grid-cols-12";

  return (
    <div className="space-y-8">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Dashboard</h1>
            <p className="mt-0.5 text-sm text-slate-500">{who} · {period.label}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="panel inline-flex gap-0.5 p-1" role="group" aria-label="Period">
              {preset("Today", "today", { from: today, to: today })}
              {preset("7 days", "7d", {})}
              {preset("30 days", "30d", { from: addDays(today, -29), to: today })}
              {preset("All data", "all", { all: 1 })}
            </div>
            <details className="relative">
              <summary className={`panel list-none px-3 py-2.5 text-[13px] font-medium [&::-webkit-details-marker]:hidden ${custom ? "border-brand-500 text-brand-700" : "text-slate-600"}`}>{custom ? (person ? `${person}${period.preset === "custom" ? " · custom dates" : ""}` : "Custom dates") : sc.teamView ? "Dates and person" : "Custom dates"} ▾</summary>
              <form className="panel absolute right-0 z-20 mt-2 w-72 space-y-3 p-4 shadow-lg">
                <div className="grid grid-cols-2 gap-3">
                  <div><label className="label" htmlFor="dash-from">From</label><input id="dash-from" type="date" name="from" defaultValue={period.all ? "" : period.from} className="input" /></div>
                  <div><label className="label" htmlFor="dash-to">To</label><input id="dash-to" type="date" name="to" defaultValue={period.all ? "" : period.to} className="input" /></div>
                </div>
                {sc.teamView && (
                  <div>
                    <label className="label" htmlFor="dash-emp">Person</label>
                    <select id="dash-emp" name="employee" defaultValue={sc.requested ?? ""} className="input">
                      <option value="">Everyone</option>
                      {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </select>
                  </div>
                )}
                <div className="flex gap-2"><button className="btn btn-primary flex-1">Apply</button><Link href="/" className="btn">Reset</Link></div>
              </form>
            </details>
          </div>
        </div>
        <Flash ok={sget(sp, "ok")} err={sget(sp, "err")} />
      </div>

      <Band title="Performance" sub={period.prev ? `${period.label}, compared with the ${period.days === 1 ? "day" : `${period.days} days`} before` : "Everything recorded so far"}>
        {slot("", <Kpis {...pp} />, "h-36")}
        <div className={`mt-3 ${row}`}>
          {slot("lg:col-span-12 xl:col-span-8", <Trend {...pp} className="lg:col-span-12 xl:col-span-8" />)}
          {slot("lg:col-span-12 xl:col-span-4", <FunnelPanel {...pp} className="lg:col-span-12 xl:col-span-4" />)}
        </div>
      </Band>

      <Band title="Right now" live sub="Not limited to the selected period">
        <div className={row}>
          {slot(sc.manager ? "lg:col-span-6 xl:col-span-4" : "lg:col-span-6 xl:col-span-5", <NeedsYou {...p} className={sc.manager ? "lg:col-span-6 xl:col-span-4" : "lg:col-span-6 xl:col-span-5"} />, "h-96")}
          {slot(sc.manager ? "lg:col-span-6 xl:col-span-5" : "lg:col-span-6 xl:col-span-7", <TodayWork {...p} className={sc.manager ? "lg:col-span-6 xl:col-span-5" : "lg:col-span-6 xl:col-span-7"} />, "h-96")}
          {sc.manager && slot("lg:col-span-12 xl:col-span-3", <Sending {...p} className="lg:col-span-12 xl:col-span-3" />, "h-96")}
        </div>
        {sc.teamView && <div className="mt-3">{slot("", <FollowUps />, "h-44")}</div>}
      </Band>

      <Band title="Pipeline" sub={sc.teamView ? "Where the leads stand, by stage and by campaign, and what they answer" : "Where your leads stand"}>
        <div className={row}>
          {slot("lg:col-span-12 xl:col-span-5", <Stages {...pp} className="lg:col-span-12 xl:col-span-5" />)}
          <div className="flex flex-col gap-3 lg:col-span-12 xl:col-span-7">
            {sc.teamView ? slot("", <Campaigns {...pp} />, "h-52") : slot("flex-1", <Activity {...p} className="flex-1" />, "h-52")}
            {slot("flex-1", <Replies {...p} className="flex-1" />, "h-28")}
          </div>
        </div>
      </Band>

      {sc.teamView && (
        <Band title="Team and activity" sub="Who is carrying what, and what just happened">
          <div className={row}>
            {slot(sc.manager ? "lg:col-span-12 xl:col-span-6" : "lg:col-span-12 xl:col-span-8", <Team {...pp} className={sc.manager ? "lg:col-span-12 xl:col-span-6" : "lg:col-span-12 xl:col-span-8"} />)}
            {sc.manager && slot("lg:col-span-6 xl:col-span-3", <Agents {...p} className="lg:col-span-6 xl:col-span-3" />)}
            {slot(sc.manager ? "lg:col-span-6 xl:col-span-3" : "lg:col-span-6 xl:col-span-4", <Activity {...p} className={sc.manager ? "lg:col-span-6 xl:col-span-3" : "lg:col-span-6 xl:col-span-4"} />)}
          </div>
        </Band>
      )}
    </div>
  );
}
