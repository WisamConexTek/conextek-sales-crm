import Link from "next/link";
import type { ReactNode } from "react";
import type { Actor } from "@/lib/auth";
import { loadActions, loadAttention, loadBoard, loadFeed, loadPipeline, loadResults, loadSending, type Period, type Scope } from "@/lib/service/dashboard";
import { Badge, Card, Empty, LeadLink } from "@/components/ui";
import { BarRow, ColumnChart, Delta, Kpi, Meter, Tile } from "@/components/dashboard/charts";
import { fmtShort, fmtYmd, pct } from "@/lib/format";
import { ACTIVITY_TYPE_LABEL, MESSAGE_KIND_LABEL } from "@/lib/constants";
import { q } from "@/lib/view";

/* Each export is one dashboard section: it loads its own data and renders it. The page streams them independently. */

type P = { me: Actor; sc: Scope };
type PP = P & { period: Period };

const ago = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const h = (Date.now() - new Date(iso).getTime()) / 3600000;
  return h < 1 ? "under 1h" : h < 48 ? `${Math.floor(h)}h` : `${Math.floor(h / 24)}d`;
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const STATE_TONE = { overdue: "red", blocked: "amber", ready: "green", planned: "gray", completed: "blue" } as const;
const SENDER_TONE = { active: "green", warming_up: "amber", paused: "red", inactive: "gray" } as const;
const SENDER_LABEL = { active: "Active", warming_up: "Warming up", paused: "Paused", inactive: "Off" } as const;
const REPLY_TONE: Record<string, "green" | "sky" | "red" | "gray"> = { interested: "green", soft: "sky", not_interested: "red", other: "gray" };

/** A section that fails shows a short note in its own place; the rest of the dashboard keeps working. */
async function guard(title: string, render: () => Promise<ReactNode>): Promise<ReactNode> {
  try {
    return await render();
  } catch (e) {
    console.error(`Dashboard section "${title}" failed:`, e);
    return <Card title={title}><p className="text-sm text-red-700">This section could not be loaded just now. The rest of the dashboard is not affected.</p></Card>;
  }
}

const Sub = ({ children }: { children: ReactNode }) => <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">{children}</div>;
const More = ({ href, children }: { href: string; children: ReactNode }) => <Link href={href} className="text-xs">{children}</Link>;

/* ---------- 1. Needs action now ---------- */
export function NeedsAction({ me, sc }: P) {
  return guard("Needs action now", async () => {
    const [a, board, att, sending] = await Promise.all([loadActions(me, sc), loadBoard(me, sc), loadAttention(me, sc), sc.manager ? loadSending() : Promise.resolve(null)]);
    const emp = sc.teamView ? sc.requested : undefined;
    const paused = sending?.senders.filter((s) => s.status === "paused") ?? [];
    const alerts: ReactNode[] = [];
    for (const s of paused) alerts.push(<>Sender <b>{s.name}</b> is paused{s.paused?.kind === "auto" ? " automatically" : ""}: {s.paused?.reason ?? "no reason recorded"}. {me.role === "owner" ? <Link href="/settings?tab=senders">Review and resume →</Link> : "Only the Owner can resume it."}</>);
    if (a.crmPending > 0) alerts.push(<><b>{plural(a.crmPending, "message")}</b> {a.crmPending === 1 ? "was" : "were"} sent but the CRM record is not complete. Do not resend; reconcile {a.crmPending === 1 ? "it" : "them"} first.</>);
    if (sending && sending.pushedTotal > 0) alerts.push(<><b>{plural(sending.pushedTotal, "approved send")}</b> will not fit in today&apos;s sending limit and {sending.pushedTotal === 1 ? "is" : "are"} pushed to the next day. <Link href="/schedule?open=1">Open the work queue →</Link></>);
    if (a.changesRequested > 0) alerts.push(<><b>{plural(a.changesRequested, "task")}</b> came back with changes requested. <Link href="/my-work">Open My Work →</Link></>);
    if (board.noDate > 0) alerts.push(<>{plural(board.noDate, "open task")} {board.noDate === 1 ? "has" : "have"} no date, so {board.noDate === 1 ? "it" : "they"} can never show as late.</>);
    if (board.truncated) alerts.push(<>More than 500 open tasks are due by tomorrow; the task counters cover the first 500.</>);
    return (
      <section aria-label="Needs action now">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-slate-800">Needs action now</h2>
          <span className="text-xs text-slate-500">live · not limited to the selected period</span>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {a.sendApprovals !== null && <Tile label="Send approvals" value={a.sendApprovals} tone="amber" href="/send-approvals" sub={a.sendApprovals ? "drafts waiting for your OK to send" : "nothing waiting for you"} />}
          {a.toDecide !== null
            ? <Tile label="Task approvals" value={a.toDecide} tone="amber" href="/approvals" sub={a.toDecide ? `oldest waiting ${ago(a.oldestToDecide)}` : "nothing to decide"} />
            : <Tile label="Your work in approval" value={a.mineWaiting} href="/approvals" sub="submitted, waiting for a decision" />}
          <Tile label="Replies not answered" value={att.unansweredCount} tone="red" href={`/leads${q({ attention: "unanswered", owner: emp })}`} sub={att.unansweredCount ? `oldest waiting ${ago(att.unanswered[0]?.reply_at)}` : "every reply has a response"} />
          <Tile label="Overdue tasks" value={board.counts.overdue} tone="red" href={`/schedule${q({ open: 1, state: "overdue", employee: emp })}`} sub={board.counts.overdue ? `oldest ${ago(board.oldestOverdue)} late` : "nothing is late"} />
          <Tile label="Blocked tasks" value={board.counts.blocked} tone="amber" href={`/schedule${q({ open: 1, state: "blocked", employee: emp })}`} sub="waiting on an approval, a draft or a fix" />
          <Tile label="Leads with nothing planned" value={att.quietCount} tone="amber" href={`/leads${q({ attention: "quiet", owner: emp })}`} sub="open, no task, quiet 7+ days" />
        </div>
        {alerts.length > 0 && (
          <ul className="mt-3 space-y-1.5">
            {alerts.map((x, i) => <li key={i} className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{x}</li>)}
          </ul>
        )}
      </section>
    );
  });
}

/* ---------- 2. Work queue ---------- */
export function WorkQueue({ me, sc }: P) {
  return guard("Work queue", async () => {
    const b = await loadBoard(me, sc);
    const emp = sc.teamView ? sc.requested : undefined;
    const chip = (state: "overdue" | "ready" | "blocked" | "planned", label: string) => (
      <Link key={state} href={`/schedule${q({ open: 1, state, employee: emp })}`} className="no-underline"><Badge tone={STATE_TONE[state]}>{label}: {b.counts[state]}</Badge></Link>
    );
    return (
      <Card title="Work queue · late, today and tomorrow" right={<More href={`/schedule${q({ open: 1, employee: emp })}`}>Open all →</More>}>
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          {chip("overdue", "Overdue")}{chip("ready", "Ready")}{chip("blocked", "Blocked")}{chip("planned", "Planned")}
          <Badge tone="blue">Done today: {b.completedToday}</Badge>
        </div>
        {b.items.length === 0 ? <Empty>Nothing is late and nothing is planned for today or tomorrow.</Empty> : (
          <ul className="divide-y divide-slate-100">
            {b.items.map((t) => (
              <li key={t.id} className="py-2 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link href={`/tasks/${t.id}`} className="font-medium">{t.title}</Link>
                    <div className="text-xs text-slate-500">
                      {t.company ? <LeadLink id={t.lead_id} company={t.company} /> : "No lead"}
                      {sc.taskEmployee ? "" : ` · ${t.employee}`}{t.campaign ? ` · ${t.campaign}` : ""}{t.channel ? ` · ${t.channel}` : ""}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <Badge tone={STATE_TONE[t.state]}>{t.state}</Badge>
                    <div className="mt-0.5 text-xs text-slate-500">{t.date_only ? fmtYmd(t.on) : fmtShort(t.sort_at)}</div>
                  </div>
                </div>
                {t.reason && <div className={`mt-0.5 text-xs ${t.state === "overdue" ? "text-red-700" : "text-amber-800"}`}>{t.reason}</div>}
              </li>
            ))}
          </ul>
        )}
        {b.total > b.items.length && <p className="mt-2 text-xs text-slate-500">Showing {b.items.length} of {b.total}: late work first, then ready, blocked and planned.</p>}
      </Card>
    );
  });
}

/* ---------- 3. Sending today (managers) ---------- */
export function SendingToday({ me }: P) {
  return guard("Sending today", async () => {
    const s = await loadSending();
    return (
      <Card title="Sending today" right={me.role === "owner" ? <More href="/settings?tab=senders">Manage senders →</More> : undefined}>
        {s.senders.length === 0 ? <Empty>No senders are set up.</Empty> : (
          <ul className="space-y-4">
            {s.senders.map((x) => (
              <li key={x.id}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0"><div className="truncate text-sm font-medium text-slate-900">{x.name}</div><div className="truncate text-xs text-slate-500">{x.email}</div></div>
                  <Badge tone={SENDER_TONE[x.status]}>{SENDER_LABEL[x.status]}</Badge>
                </div>
                {x.unlimited ? <p className="mt-1.5 text-xs text-slate-600">{x.used} sent today · {x.reserved} approved and waiting · no daily limit</p> : (
                  <>
                    <div className="mt-2"><Meter used={x.used} reserved={x.reserved} cap={x.cap as number} /></div>
                    <p className="mt-1 text-xs text-slate-600">
                      <b className="text-slate-900">{x.used}</b> sent · <b className="text-slate-900">{x.reserved}</b> approved and waiting · {x.remaining} left of {x.cap}
                      {x.warmupNotStarted ? " · warm-up not started" : x.warmup ? " · warm-up" : ""}{x.pushed ? ` · ${x.pushed} pushed to next day` : ""}
                    </p>
                  </>
                )}
                <p className="mt-0.5 text-xs text-slate-500">
                  Last 7 days: {x.sent7} sent · <span className={x.bounceRate7 !== null && x.bounceRate7 > 0.03 ? "font-semibold text-red-700" : ""}>{x.bounces7} bounced{x.bounceRate7 !== null ? ` (${pct(x.bounceRate7)})` : ""}</span> · {plural(x.replies7, "reply", "replies")}
                  {x.complaints7 ? <span className="font-semibold text-red-700"> · {plural(x.complaints7, "spam complaint")}</span> : ""}
                </p>
                {x.paused && <p className="mt-1 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-800">{x.paused.kind === "auto" ? "Paused automatically: " : "Paused: "}{x.paused.reason}</p>}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 border-t border-slate-100 pt-2 text-xs text-slate-500">A sender pauses itself when its 7-day bounce rate passes 3% or it gets a spam complaint.</p>
      </Card>
    );
  });
}

/* ---------- 4. Leads that wait on someone ---------- */
export function LeadsWaiting({ me, sc }: P) {
  return guard("Leads that need someone", async () => {
    const a = await loadAttention(me, sc);
    const emp = sc.teamView ? sc.requested : undefined;
    return (
      <Card title="Leads that need someone">
        <div className="grid gap-6 md:grid-cols-3">
          <div>
            <Sub>Replies not answered ({a.unansweredCount})</Sub>
            {a.unanswered.length === 0 ? <Empty>Every reply from the last 30 days has a response.</Empty> : (
              <ul className="divide-y divide-slate-100">{a.unanswered.map((l) => (
                <li key={l.id} className="flex justify-between gap-2 py-1.5 text-sm"><span className="min-w-0 truncate"><LeadLink id={l.id} company={l.company} />{!sc.employee && l.owner_name ? <span className="text-xs text-slate-500"> · {l.owner_name}</span> : null}</span><span className="shrink-0 text-xs text-red-700">waiting {ago(l.reply_at)}</span></li>
              ))}</ul>
            )}
            {a.unansweredCount > a.unanswered.length && <More href={`/leads${q({ attention: "unanswered", owner: emp })}`}>See all {a.unansweredCount} →</More>}
          </div>
          <div>
            <Sub>Open leads with nothing planned ({a.quietCount})</Sub>
            {a.quiet.length === 0 ? <Empty>Every open lead has work planned or recent activity.</Empty> : (
              <ul className="divide-y divide-slate-100">{a.quiet.map((l) => (
                <li key={l.id} className="flex justify-between gap-2 py-1.5 text-sm"><span className="min-w-0 truncate"><LeadLink id={l.id} company={l.company} /></span><span className="shrink-0 text-xs text-slate-500">{l.owner_name ?? "no owner"} · quiet {ago(l.last_at)}</span></li>
              ))}</ul>
            )}
            {a.quietCount > a.quiet.length && <More href={`/leads${q({ attention: "quiet", owner: emp })}`}>See all {a.quietCount} →</More>}
          </div>
          <div>
            <Sub>Latest replies</Sub>
            {a.replies.length === 0 ? <Empty>No replies recorded yet.</Empty> : (
              <ul className="divide-y divide-slate-100">{a.replies.map((r) => (
                <li key={r.id} className="py-1.5 text-sm">
                  <div className="flex justify-between gap-2"><span className="min-w-0 truncate"><LeadLink id={r.lead_id} company={r.company} /></span><span className="shrink-0 text-xs text-slate-500">{fmtShort(r.occurred_at)}</span></div>
                  <div className="flex items-start gap-2">{r.classification ? <Badge tone={REPLY_TONE[r.classification] ?? "gray"}>{String(r.classification).replace(/_/g, " ")}</Badge> : null}<p className="line-clamp-1 min-w-0 text-xs text-slate-600">{r.body || r.title}</p></div>
                </li>
              ))}</ul>
            )}
          </div>
        </div>
      </Card>
    );
  });
}

/* ---------- 5. Results for the period ---------- */
export function ResultsSection({ me, sc, period }: PP) {
  return guard("Results", async () => {
    const r = await loadResults(me, sc, period);
    const m = r.totals, pm = r.prev?.totals;
    const vs = period.prev ? "vs the period before" : "";
    const d = (cur: number, prev: number | undefined, goodUp = true) => (pm ? <><Delta cur={cur} prev={prev} goodUp={goodUp} /> {vs}</> : null);
    const buckets = r.buckets;
    const unknown = r.unknownCounts.leads + r.unknownCounts.activities;
    return (
      <Card title={`Results · ${period.label}`} right={<More href="/reports">Full reports →</More>}>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Kpi label="First emails sent" value={m.first_emails} delta={d(m.first_emails, pm?.first_emails)} />
          <Kpi label="Follow-ups sent" value={m.follow_ups} delta={d(m.follow_ups, pm?.follow_ups)} />
          <Kpi label="Replies received" value={m.replies} delta={d(m.replies, pm?.replies)} sub={`from ${plural(m.reply_leads, "lead")}`} />
          <Kpi label="First-email bounce rate" value={pct(r.rates.firstBounce)}
            delta={r.prev && r.rates.firstBounce != null && r.prev.rates.firstBounce != null ? <><Delta cur={r.rates.firstBounce} prev={r.prev.rates.firstBounce} goodUp={false} fmt={(n) => `${(n * 100).toFixed(1)} pts`} /> {vs}</> : null}
            sub={`${m.first_email_bounces} of ${m.first_emails}`} />
          <Kpi label="Leads added" value={m.leads_added} delta={d(m.leads_added, pm?.leads_added)} />
          <Kpi label="Meetings" value={m.meetings} delta={d(m.meetings, pm?.meetings)} sub={`${m.won} won · ${m.lost} lost`} />
        </div>
        {buckets.length >= 2 && (
          <div className="mt-5 grid gap-6 lg:grid-cols-2">
            <ColumnChart title={`Messages sent per ${r.breakdown}`} unit="messages" series={[{ name: "First emails", className: "bg-viz-1" }, { name: "Follow-ups", className: "bg-viz-2" }]}
              buckets={buckets.map((b) => ({ label: b.label, values: [b.m.first_emails, b.m.follow_ups] }))} />
            <ColumnChart title={`Replies received per ${r.breakdown}`} unit="replies" series={[{ name: "Replies", className: "bg-viz-3" }]}
              buckets={buckets.map((b) => ({ label: b.label, values: [b.m.replies] }))} />
          </div>
        )}
        <p className="mt-4 text-xs text-slate-500">
          Counted on the day each thing happened, from records logged in the CRM. Test data is never counted.
          {unknown > 0 && <> {plural(r.unknownCounts.leads, "lead")} and {plural(r.unknownCounts.activities, "activity", "activities")} have no known date, so they only count under “All data”.{" "}{me.perms.has("history.import") || me.role === "owner" ? <Link href="/settings/history">Fix dates →</Link> : null}</>}
        </p>
      </Card>
    );
  });
}

/* ---------- 6. Pipeline ---------- */
export function PipelineSection({ me, sc, period }: PP) {
  return guard("Pipeline", async () => {
    const p = await loadPipeline(me, sc, period);
    const max = Math.max(1, ...p.stages.map((s) => s.n));
    const totalLeads = p.stages.reduce((a, s) => a + s.n, 0);
    const emp = sc.teamView ? sc.requested : undefined;
    const stages = (
      <Card title={`Leads by stage · ${totalLeads} now`} right={<More href={`/leads${q({ owner: emp })}`}>All leads →</More>}>
        {totalLeads === 0 ? <Empty>No leads yet.</Empty> : (
          <div>
            {p.stages.map((s) => (
              <BarRow key={s.key} label={s.label} note={s.retired ? <span className="text-xs text-slate-400"> (retired)</span> : null} value={s.n} max={max} href={`/leads${q({ stage: s.key, owner: emp })}`}
                tone={s.flag === "won" ? "bg-emerald-600" : s.flag === "lost" || s.flag === "closed" ? "bg-slate-400" : "bg-brand-600"} />
            ))}
            <p className="mt-2 text-xs text-slate-500">Purple: open pipeline · green: won · grey: lost or closed. Click a stage to open its leads.</p>
          </div>
        )}
      </Card>
    );
    if (!p.campaigns) return stages;
    return (
      <div className="grid gap-5 xl:grid-cols-3">
        {stages}
        <Card className="xl:col-span-2" title={`Campaigns · activity ${period.all ? "since the beginning" : period.label.toLowerCase()}`} right={<More href="/campaigns">Campaigns →</More>}>
          {p.campaigns.length === 0 ? <Empty>No campaigns yet.</Empty> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="border-b border-slate-200"><tr>{["Campaign", "Leads", "To approve", "Tasks", "First emails", "Replied", "Reply %", "Bounce %"].map((h, i) => <th key={h} className={`th whitespace-nowrap ${i ? "text-right" : ""}`}>{h}</th>)}</tr></thead>
                <tbody className="divide-y divide-slate-100 tabular-nums">
                  {p.campaigns.map((c) => (
                    <tr key={c.id}>
                      <td className="td whitespace-nowrap"><Link href={`/leads?campaign=${c.id}`} className="font-medium">{c.name}</Link>{c.status !== "active" && <> <Badge tone={c.status === "paused" ? "amber" : "gray"}>{c.status}</Badge></>}</td>
                      <td className="td text-right"><Link href={`/leads?campaign=${c.id}`}>{c.leads}</Link></td>
                      <td className={`td text-right ${c.waitingSendApproval ? "font-semibold text-amber-700" : "text-slate-400"}`}>{c.waitingSendApproval}</td>
                      <td className="td text-right"><Link href={`/schedule?open=1&campaign=${c.id}`}>{c.openTasks}</Link></td>
                      <td className="td whitespace-nowrap text-right">{c.firstEmails}{c.followUps > 0 && <span className="text-xs text-slate-500"> +{c.followUps} follow-up{c.followUps === 1 ? "" : "s"}</span>}</td>
                      <td className="td text-right">{c.replyLeads}</td>
                      <td className="td text-right">{pct(c.replyRate)}</td>
                      <td className={`td text-right ${c.firstBounceRate !== null && c.firstBounceRate > 0.03 ? "font-semibold text-red-700" : ""}`}>{pct(c.firstBounceRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-xs text-slate-500">
            Leads, drafts waiting for send approval (“To approve”) and open tasks (“Tasks”) are as of now. Replied = leads that replied in the period. Reply rate = leads that replied ÷ leads that got a first email in the period; bounce rate = first emails that bounced ÷ first emails sent.
            {p.unassigned > 0 && <> <b className="text-amber-700">{plural(p.unassigned, "lead")}</b> {p.unassigned === 1 ? "is" : "are"} in no campaign. <Link href="/campaigns">Assign →</Link></>}
          </p>
        </Card>
      </div>
    );
  });
}

/* ---------- 7. Team ---------- */
export function TeamSection({ me, sc, period }: PP) {
  return guard("Team", async () => {
    const [r, b] = await Promise.all([loadResults(me, sc, period), loadBoard(me, sc)]);
    const load = new Map(b.workload.map((w) => [w.id, w]));
    const ids = new Set<number>([...r.byEmployee.map((e) => e.id), ...b.workload.map((w) => w.id)]);
    const rows = [...ids].map((id) => {
      const e = r.byEmployee.find((x) => x.id === id), w = load.get(id);
      return { id, name: e?.name ?? w?.name ?? `#${id}`, m: e?.m, w };
    }).filter((x) => x.w || (x.m && Object.values(x.m).some(Boolean)))
      .sort((a, z) => (z.w?.overdue ?? 0) - (a.w?.overdue ?? 0) || (z.w?.open ?? 0) - (a.w?.open ?? 0));
    const num = (n: number | undefined, warn = false) => <td className={`td text-right ${n && warn ? "font-semibold text-red-700" : n ? "" : "text-slate-400"}`}>{n ?? 0}</td>;
    return (
      <Card title="Team · open work now and output in the period" right={<More href="/my-work?employee=all">All tasks →</More>}>
        {rows.length === 0 ? <Empty>No open work and nothing recorded in this period.</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b border-slate-200">
                <tr><th className="th" /><th className="th border-l border-slate-100 text-center" colSpan={4}>Now</th><th className="th border-l border-slate-100 text-center" colSpan={5}>{period.label}</th></tr>
                <tr>{["Person", "Open", "Overdue", "Blocked", "In approval", "First emails", "Follow-ups", "Replies", "Leads added", "Tasks done"].map((h, i) => <th key={h} className={`th ${i ? "text-right" : ""}`}>{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-slate-100 tabular-nums">
                {rows.map((x) => (
                  <tr key={x.id}>
                    <td className="td font-medium">{x.id ? <Link href={`/${q({ employee: x.id, from: period.all ? undefined : period.from, to: period.all ? undefined : period.to, all: period.all ? 1 : undefined })}`}>{x.name}</Link> : x.name}</td>
                    {num(x.w?.open)}{num(x.w?.overdue, true)}{num(x.w?.blocked)}{num(x.w?.waiting)}
                    {num(x.m?.first_emails)}{num(x.m?.follow_ups)}{num(x.m?.replies)}{num(x.m?.leads_added)}{num(x.m?.completed)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-slate-500">Click a name to see the dashboard for that person only. Overdue and blocked use the same live status as the Today &amp; Tomorrow page.</p>
      </Card>
    );
  });
}

/* ---------- 8. What just happened ---------- */

export function ActivitySection({ me, sc }: P) {
  return guard("Latest activity", async () => {
    const f = await loadFeed(me, sc);
    const feed = (
      <Card title="Latest work recorded">
        {f.feed.length === 0 ? <Empty>No activity recorded yet.</Empty> : (
          <ul className="divide-y divide-slate-100">
            {f.feed.map((a) => (
              <li key={a.id} className="flex items-baseline justify-between gap-3 py-2 text-sm">
                <div className="min-w-0 truncate">
                  <Badge tone="gray">{a.type === "message" ? MESSAGE_KIND_LABEL[a.message_kind] ?? "Message" : ACTIVITY_TYPE_LABEL[a.type] ?? a.type}</Badge>{" "}
                  <LeadLink id={a.lead_id} company={a.company} />{a.title && <span className="text-slate-500"> — {a.title}</span>}
                </div>
                <div className="shrink-0 text-xs text-slate-500">{a.actor_name} · {fmtShort(a.occurred_at)}</div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    );
    if (!f.api) return feed;
    return (
      <div className="grid gap-5 lg:grid-cols-2">
        {feed}
        <Card title="Agent activity through the API" right={<More href="/agents">Every step →</More>}>
          {f.api.last24h.length > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
              <span className="text-slate-500">Last 24 hours:</span>
              {f.api.last24h.map((x) => (
                <Link key={x.id} href={`/agents?actor=${x.id}`} className="no-underline"><Badge tone={x.refused ? "amber" : "purple"}>{x.who}: {plural(x.n, "step")}, {plural(x.changes, "change")}{x.refused ? `, ${x.refused} refused` : ""}</Badge></Link>
              ))}
            </div>
          )}
          {f.api.steps.length === 0 ? <Empty>Nothing has come in through the API yet.</Empty> : (
            <ul className="divide-y divide-slate-100">
              {f.api.steps.map((s) => (
                <li key={s.id} className="py-2 text-sm">
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="min-w-0 truncate">
                      <span className={`font-medium ${s.outcome === "ok" || s.outcome === "replayed" ? "text-slate-900" : "text-amber-800"}`}>{s.step}</span>
                      {s.lead_id ? <> · <LeadLink id={s.lead_id} company={s.company} /></> : s.task_id ? <> · <Link href={`/tasks/${s.task_id}`}>task #{s.task_id}</Link></> : null}
                      {s.outcome === "refused" && <> <Badge tone="amber">refused</Badge></>}{s.outcome === "error" && <> <Badge tone="red">error</Badge></>}
                    </div>
                    <div className="shrink-0 text-xs text-slate-500">{s.actor_name ?? "no valid key"} · {fmtShort(s.at)}</div>
                  </div>
                  {s.error && <div className="truncate text-xs text-amber-800">{s.error}</div>}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-slate-500">Every call is listed: reads, changes and the ones the CRM refused.</p>
        </Card>
      </div>
    );
  });
}
