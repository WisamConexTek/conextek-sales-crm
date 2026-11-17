import Link from "next/link";
import type { ReactNode } from "react";
import type { Actor } from "@/lib/auth";
import { loadActions, loadAgentIds, loadAttention, loadBoard, loadFeed, loadPipeline, loadResults, loadSending, type Period, type Scope } from "@/lib/service/dashboard";
import { Badge, LeadLink } from "@/components/ui";
import { Avatar, BarRow, Columns, DataTable, Delta, Funnel, Icon, KpiCard, Legend, Mini, More, Panel, Quiet, RateBar, Ring, Segments, type IconName } from "@/components/dashboard/charts";
import { fmtShort, fmtYmd, pct } from "@/lib/format";
import { ACTIVITY_TYPE_LABEL, MESSAGE_KIND_LABEL } from "@/lib/constants";
import { rate } from "@/lib/service/reports";
import { q } from "@/lib/view";

/* Each export is one dashboard panel: it loads its own data and renders it. The page arranges them and streams them independently. */

type P = { me: Actor; sc: Scope };
type PP = P & { period: Period };

const ago = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const m = (Date.now() - new Date(iso).getTime()) / 60000;
  return m < 1 ? "now" : m < 60 ? `${Math.floor(m)}m` : m < 48 * 60 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const STATE = {
  overdue: { label: "Overdue", bar: "bg-red-500", dot: "bg-red-500" },
  ready: { label: "Ready", bar: "bg-emerald-500", dot: "bg-emerald-500" },
  blocked: { label: "Blocked", bar: "bg-amber-400", dot: "bg-amber-400" },
  planned: { label: "Planned", bar: "bg-slate-300", dot: "bg-slate-300" },
} as const;
type OpenState = keyof typeof STATE;
const STATES = Object.keys(STATE) as OpenState[];
const SENDER = { active: ["Active", "bg-emerald-500"], warming_up: ["Warming up", "bg-amber-400"], paused: ["Paused", "bg-red-500"], inactive: ["Off", "bg-slate-300"] } as const;
const REPLY_TONE: Record<string, "green" | "sky" | "red" | "gray"> = { interested: "green", soft: "sky", not_interested: "red", other: "gray" };
const SENT: { name: string; className: string }[] = [{ name: "First emails", className: "bg-viz-1" }, { name: "Follow-ups", className: "bg-viz-2" }];
const REPLIES = [{ name: "Replies", className: "bg-viz-3" }];

/** A panel that fails shows a short note in its own place; the rest of the dashboard keeps working. */
async function guard(title: string, className: string, render: () => Promise<ReactNode>): Promise<ReactNode> {
  try {
    return await render();
  } catch (e) {
    console.error(`Dashboard panel "${title}" failed:`, e);
    return <Panel title={title} className={className}><p className="text-sm text-red-700">This part could not be loaded just now. The rest of the dashboard is not affected.</p></Panel>;
  }
}

/* ================= 1. Performance (the selected period) ================= */

export function Kpis({ me, sc, period }: PP) {
  return guard("Results", "", async () => {
    const r = await loadResults(me, sc, period);
    const m = r.totals, pm = r.prev?.totals;
    const sent = m.first_emails + m.follow_ups;
    const replyRate = rate(m.reply_leads, m.first_emails), prevReply = pm ? rate(pm.reply_leads, pm.first_emails) : null;
    const bounce = r.rates.firstBounce, prevBounce = r.prev?.rates.firstBounce ?? null;
    const pts = (n: number) => `${(n * 100).toFixed(1)} pts`;
    const b = r.buckets.length >= 2 ? r.buckets : null;
    return (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard icon="mail" tint="bg-viz-1/10 text-viz-1" label="Emails sent" value={sent} delta={pm && <Delta cur={sent} prev={pm.first_emails + pm.follow_ups} />}
          sub={`${m.first_emails} first · ${plural(m.follow_ups, "follow-up")}`} trend={b?.map((x) => x.m.first_emails + x.m.follow_ups)} />
        <KpiCard icon="reply" tint="bg-viz-3/10 text-viz-3" label="Replies" value={m.replies} delta={pm && <Delta cur={m.replies} prev={pm.replies} />}
          sub={`from ${plural(m.reply_leads, "lead")}`} trend={b?.map((x) => x.m.replies)} />
        <KpiCard icon="rate" tint="bg-viz-3/10 text-viz-3" label="Reply rate" value={pct(replyRate)} delta={replyRate != null && prevReply != null && <Delta cur={replyRate} prev={prevReply} fmt={pts} />}
          sub={`${m.reply_leads} of ${plural(m.first_emails, "first email")}`} trend={b?.map((x) => rate(x.m.reply_leads, x.m.first_emails) ?? 0)} />
        <KpiCard icon="alert" tint={bounce != null && bounce > 0.02 ? "bg-red-50 text-red-600" : "bg-slate-100 text-slate-600"} label="Bounce rate" value={<span className={bounce != null && bounce > 0.02 ? "text-red-600" : ""}>{pct(bounce)}</span>}
          delta={bounce != null && prevBounce != null && <Delta cur={bounce} prev={prevBounce} goodUp={false} fmt={pts} />}
          sub={`${m.first_email_bounces} of ${m.first_emails} · limit 2%`} trend={b?.map((x) => rate(x.m.first_email_bounces, x.m.first_emails) ?? 0)} />
        <KpiCard icon="calendar" tint="bg-brand-50 text-brand-700" label="Meetings" value={m.meetings} delta={pm && <Delta cur={m.meetings} prev={pm.meetings} />}
          sub={`${m.won} won · ${m.lost} lost`} trend={b?.map((x) => x.m.meetings)} />
        <KpiCard icon="userPlus" tint="bg-brand-50 text-brand-700" label="Leads added" value={m.leads_added} delta={pm && <Delta cur={m.leads_added} prev={pm.leads_added} />}
          sub={`${plural(m.completed, "task")} completed`} trend={b?.map((x) => x.m.leads_added)} />
      </div>
    );
  });
}

export function Trend({ me, sc, period, className = "" }: PP & { className?: string }) {
  return guard("Outreach over time", className, async () => {
    const r = await loadResults(me, sc, period);
    const b = r.buckets;
    const unknown = r.unknownCounts.leads + r.unknownCounts.activities;
    const fix = me.perms.has("history.import") || me.role === "owner";
    return (
      <Panel className={className} title="Outreach over time" hint={`Emails sent and replies received, per ${r.breakdown}`} right={<Legend series={[...SENT, ...REPLIES]} />}>
        {b.length < 2 ? <Quiet>One day is selected. Choose 7 or 30 days to see how the numbers move.</Quiet> : (
          <>
            <Columns unit="emails" series={SENT} buckets={b.map((x) => ({ label: x.label, values: [x.m.first_emails, x.m.follow_ups] }))} xLabels={false} />
            <div className="mb-1 ml-9 mt-3 text-[11px] font-medium uppercase tracking-wide text-slate-500">Replies</div>
            <Columns unit="replies" series={REPLIES} buckets={b.map((x) => ({ label: x.label, values: [x.m.replies] }))} height="h-16" />
            <DataTable head={["Period", "First emails", "Follow-ups", "Replies"]} rows={b.map((x) => [x.label, x.m.first_emails, x.m.follow_ups, x.m.replies])} />
          </>
        )}
        {unknown > 0 && <p className="mt-2 text-xs text-slate-500">{plural(unknown, "record")} with no known date only count under “All data”. {fix && <Link href="/settings/history">Fix dates →</Link>}</p>}
      </Panel>
    );
  });
}

export function FunnelPanel({ me, sc, period, className = "" }: PP & { className?: string }) {
  return guard("Outreach funnel", className, async () => {
    const m = (await loadResults(me, sc, period)).totals;
    return (
      <Panel className={className} title="Outreach funnel" hint="From first email to a won deal" right={<More href="/reports">Reports</More>}>
        {m.first_emails + m.reply_leads + m.meetings + m.won === 0 ? <Quiet>Nothing was sent or answered in this period.</Quiet> : (
          <Funnel steps={[
            { label: "First emails sent", value: m.first_emails },
            { label: "Leads that replied", value: m.reply_leads },
            { label: "Meetings", value: m.meetings },
            { label: "Won", value: m.won },
          ]} />
        )}
      </Panel>
    );
  });
}

/* ================= 2. Right now (live) ================= */

function ActionRow({ n, label, sub, href, tone, icon }: { n: number; label: string; sub: ReactNode; href: string; tone: "red" | "amber"; icon: IconName }) {
  const hot = n > 0;
  const tile = !hot ? "bg-slate-100 text-slate-400" : tone === "red" ? "bg-red-50 text-red-700 ring-1 ring-red-200" : "bg-amber-50 text-amber-800 ring-1 ring-amber-200";
  return (
    <li>
      <Link href={href} className="group flex items-center gap-3 rounded-lg px-2 py-2 text-inherit no-underline hover:bg-slate-50 hover:no-underline">
        <span className={`flex h-10 w-11 shrink-0 items-center justify-center rounded-lg text-lg font-semibold tabular-nums ${tile}`}>{hot ? n : <Icon name="check" />}</span>
        <span className="min-w-0 flex-1">
          <span className={`flex items-center gap-1.5 text-sm font-medium ${hot ? "text-slate-900" : "text-slate-500"}`}><Icon name={icon} className="h-3.5 w-3.5 text-slate-400" />{label}</span>
          <span className="block truncate text-xs text-slate-500">{sub}</span>
        </span>
        <Icon name="chevron" className="h-4 w-4 text-slate-300 group-hover:text-slate-500" />
      </Link>
    </li>
  );
}

export function NeedsYou({ me, sc, className = "" }: P & { className?: string }) {
  return guard("Needs you", className, async () => {
    const [a, board, att, sending] = await Promise.all([loadActions(me, sc), loadBoard(me, sc), loadAttention(me, sc), sc.manager ? loadSending() : Promise.resolve(null)]);
    const emp = sc.teamView ? sc.requested : undefined;
    const names = (rows: { company?: string }[]) => rows.slice(0, 2).map((l) => l.company).filter(Boolean).join(", ");
    const total = (a.sendApprovals ?? 0) + (a.toDecide ?? 0) + att.unansweredCount + board.counts.overdue + board.counts.blocked + att.quietCount;
    const alerts: ReactNode[] = [];
    for (const s of sending?.senders.filter((x) => x.status === "paused") ?? []) alerts.push(<>Sender <b>{s.name}</b> is paused: {s.paused?.reason ?? "no reason recorded"}. {me.role === "owner" && <Link href="/settings?tab=senders">Review →</Link>}</>);
    if (a.crmPending > 0) alerts.push(<><b>{plural(a.crmPending, "message")}</b> sent but not fully recorded. Do not resend; reconcile first.</>);
    if (sending && sending.pushedTotal > 0) alerts.push(<><b>{plural(sending.pushedTotal, "approved send")}</b> will not fit in today&apos;s limit and moved to the next day.</>);
    if (a.changesRequested > 0) alerts.push(<><b>{plural(a.changesRequested, "task")}</b> came back with changes requested. <Link href="/my-work">Open →</Link></>);
    if (board.noDate > 0) alerts.push(<>{plural(board.noDate, "open task")} with no date can never show as late.</>);
    return (
      <Panel className={className} pad={false} title="Needs you" right={total ? <span className="rounded-full bg-red-50 px-2 py-0.5 font-semibold text-red-700">{plural(total, "item")}</span> : <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-semibold text-emerald-700">All clear</span>}>
        <ul className="px-2 pb-2 pt-1.5">
          {a.sendApprovals !== null && <ActionRow n={a.sendApprovals} icon="send" tone="amber" label="Drafts to approve for sending" href="/send-approvals" sub={a.sendApprovals ? "Waiting for your OK before anyone sends" : "Nothing is waiting for you"} />}
          {a.toDecide !== null
            ? <ActionRow n={a.toDecide} icon="check" tone="amber" label="Task approvals" href="/approvals" sub={a.toDecide ? `Oldest has waited ${ago(a.oldestToDecide)}` : "Nothing to decide"} />
            : <ActionRow n={a.mineWaiting} icon="clock" tone="amber" label="Your work in approval" href="/approvals" sub="Submitted, waiting for a decision" />}
          <ActionRow n={att.unansweredCount} icon="reply" tone="red" label="Replies not answered" href={`/leads${q({ attention: "unanswered", owner: emp })}`}
            sub={att.unansweredCount ? `Oldest ${ago(att.unanswered[0]?.reply_at)} · ${names(att.unanswered)}` : "Every reply has a response"} />
          <ActionRow n={board.counts.overdue} icon="clock" tone="red" label="Overdue tasks" href={`/schedule${q({ open: 1, state: "overdue", employee: emp })}`} sub={board.counts.overdue ? `Oldest is ${ago(board.oldestOverdue)} late` : "Nothing is late"} />
          <ActionRow n={board.counts.blocked} icon="block" tone="amber" label="Blocked tasks" href={`/schedule${q({ open: 1, state: "blocked", employee: emp })}`} sub="Waiting on an approval, a draft or a fix" />
          <ActionRow n={att.quietCount} icon="moon" tone="amber" label="Leads with nothing planned" href={`/leads${q({ attention: "quiet", owner: emp })}`} sub={att.quietCount ? `Quiet 7+ days · ${names(att.quiet)}` : "Every open lead has a next step"} />
        </ul>
        {alerts.length > 0 && (
          <ul className="space-y-1.5 border-t border-slate-100 px-4 py-3">
            {alerts.map((x, i) => <li key={i} className="flex gap-2 text-xs text-amber-900"><Icon name="alert" className="mt-px h-3.5 w-3.5 text-amber-600" /><span>{x}</span></li>)}
          </ul>
        )}
      </Panel>
    );
  });
}

export function TodayWork({ me, sc, className = "" }: P & { className?: string }) {
  return guard("Work in motion", className, async () => {
    const b = await loadBoard(me, sc);
    const emp = sc.teamView ? sc.requested : undefined;
    const open = STATES.reduce((a, s) => a + b.counts[s], 0);
    return (
      <Panel className={className} title="Work in motion" hint="Everything late, plus today and tomorrow" right={<More href={`/schedule${q({ open: 1, employee: emp })}`}>Open all</More>}>
        <div className="flex items-end justify-between gap-4">
          <div className="flex gap-6"><Mini label="Open" value={open} /><Mini label="Ready to send" value={b.counts.ready} tone={b.counts.ready ? "text-emerald-600" : "text-slate-400"} /><Mini label="Done today" value={b.completedToday} /></div>
        </div>
        <div className="mt-3"><Segments parts={STATES.map((s) => ({ key: s, label: STATE[s].label, value: b.counts[s], className: STATE[s].bar }))} className="h-3" /></div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {STATES.map((s) => (
            <Link key={s} href={`/schedule${q({ open: 1, state: s, employee: emp })}`} className="inline-flex items-center gap-1.5 text-slate-600 no-underline hover:text-slate-900 hover:no-underline">
              <span className={`h-2 w-2 rounded-full ${STATE[s].dot}`} />{STATE[s].label} <b className="font-semibold text-slate-900 tabular-nums">{b.counts[s]}</b>
            </Link>
          ))}
        </div>
        {b.items.length === 0 ? <div className="mt-3"><Quiet>Nothing is late and nothing is planned for today or tomorrow.</Quiet></div> : (
          <ul className="mt-3 divide-y divide-slate-100 border-t border-slate-100">
            {b.items.slice(0, 5).map((t) => (
              <li key={t.id} className="flex items-center gap-2.5 py-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${STATE[t.state as OpenState]?.dot ?? "bg-slate-300"}`} title={t.state} />
                <div className="min-w-0 flex-1">
                  <Link href={`/tasks/${t.id}`} className="block truncate text-[13px] font-medium">{t.title}</Link>
                  <div className="truncate text-xs text-slate-500" title={t.reason ?? undefined}>{t.company ?? "No lead"}{sc.taskEmployee ? "" : ` · ${t.employee}`}{t.reason ? ` · ${t.reason}` : ""}</div>
                </div>
                <div className={`shrink-0 text-right text-xs tabular-nums ${t.state === "overdue" ? "font-medium text-red-700" : "text-slate-500"}`}>{t.date_only ? fmtYmd(t.on) : fmtShort(t.sort_at)}</div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    );
  });
}

export function Sending({ me, className = "" }: P & { className?: string }) {
  return guard("Sending today", className, async () => {
    const s = await loadSending();
    return (
      <Panel className={className} title="Sending today" hint="Against each daily limit" right={me.role === "owner" ? <More href="/settings?tab=senders">Senders</More> : undefined}>
        {s.senders.length === 0 ? <Quiet>No senders are set up.</Quiet> : (
          <ul className="space-y-4">
            {s.senders.map((x) => {
              const hot = x.bounceRate7 !== null && x.bounceRate7 > 0.02;
              return (
                <li key={x.id} className="flex items-center gap-3">
                  <Ring used={x.used} reserved={x.reserved} cap={x.unlimited ? null : (x.cap as number)} tone={x.status === "paused" || x.status === "inactive" ? "off" : "ok"} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5"><span className="truncate text-sm font-medium text-slate-900" title={x.email}>{x.name}</span><span className={`h-2 w-2 shrink-0 rounded-full ${SENDER[x.status][1]}`} /><span className="shrink-0 text-xs text-slate-500">{SENDER[x.status][0]}</span></div>
                    <div className="mt-0.5 text-xs text-slate-600"><b className="font-semibold text-slate-900">{x.reserved}</b> waiting{x.unlimited ? "" : <> · <b className="font-semibold text-slate-900">{x.remaining}</b> left</>}{x.pushed ? <span className="text-amber-700"> · {x.pushed} moved to next day</span> : ""}</div>
                    <div className="mt-0.5 truncate text-xs text-slate-500">7 days: <span className={hot ? "font-semibold text-red-700" : ""}>{x.bounceRate7 !== null ? pct(x.bounceRate7) : "0%"} bounced</span> · {plural(x.replies7, "reply", "replies")}{x.complaints7 ? <span className="font-semibold text-red-700"> · {plural(x.complaints7, "complaint")}</span> : ""}</div>
                    {x.paused && <div className="mt-1 truncate text-xs font-medium text-red-700" title={x.paused.reason ?? undefined}>{x.paused.kind === "auto" ? "Paused automatically" : "Paused"}: {x.paused.reason}</div>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-4 flex gap-4 border-t border-slate-100 pt-3 text-[11px] text-slate-500">
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-brand-600" />Sent</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-brand-500/50" />Approved, waiting</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-brand-100" />Left</span>
        </div>
      </Panel>
    );
  });
}

/* ================= 3. Pipeline ================= */

export function Stages({ me, sc, period, className = "" }: PP & { className?: string }) {
  return guard("Leads by stage", className, async () => {
    const p = await loadPipeline(me, sc, period);
    const emp = sc.teamView ? sc.requested : undefined;
    const total = p.stages.reduce((a, s) => a + s.n, 0);
    const won = p.stages.filter((s) => s.flag === "won").reduce((a, s) => a + s.n, 0);
    const closed = p.stages.filter((s) => s.flag === "lost" || s.flag === "closed").reduce((a, s) => a + s.n, 0);
    const max = Math.max(1, ...p.stages.map((s) => s.n));
    return (
      <Panel className={className} title="Leads by stage" hint="Where every lead stands now" right={<More href={`/leads${q({ owner: emp })}`}>All leads</More>}>
        {total === 0 ? <Quiet>No leads yet.</Quiet> : (
          <>
            <div className="mb-3 flex gap-6 border-b border-slate-100 pb-3"><Mini label="In progress" value={total - won - closed} /><Mini label="Won" value={won} tone={won ? "text-emerald-600" : "text-slate-400"} /><Mini label="Lost or closed" value={closed} tone="text-slate-500" /></div>
            {p.stages.map((s) => (
              <BarRow key={s.key} label={<>{s.label}{s.retired && <span className="text-xs text-slate-400"> (retired)</span>}</>} value={s.n} max={max} total={total} href={`/leads${q({ stage: s.key, owner: emp })}`}
                tone={s.flag === "won" ? "bg-emerald-500" : s.flag === "lost" || s.flag === "closed" ? "bg-slate-400" : "bg-brand-600"} />
            ))}
          </>
        )}
      </Panel>
    );
  });
}

export function Campaigns({ me, sc, period, className = "" }: PP & { className?: string }) {
  return guard("Campaigns", className, async () => {
    const p = await loadPipeline(me, sc, period);
    const c = p.campaigns ?? [];
    const scale = Math.max(0.1, ...c.map((x) => x.replyRate ?? 0));
    const th = "px-2 pb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500";
    return (
      <Panel className={className} title="Campaigns" hint={`Size now · results ${period.all ? "since the beginning" : period.label.toLowerCase()}`} right={<More href="/campaigns">Campaigns</More>}>
        {c.length === 0 ? <Quiet>No campaigns yet.</Quiet> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[540px] text-[13px]">
              <thead><tr className="border-b border-slate-200">
                <th className={`${th} text-left`}>Campaign</th><th className={`${th} text-right`}>Leads</th><th className={`${th} text-right`}>Sent</th>
                <th className={`${th} text-right`} title="Leads that replied ÷ leads that got a first email in the period">Reply rate</th>
                <th className={`${th} text-right`} title="First emails that bounced ÷ first emails sent in the period">Bounced</th>
                <th className={`${th} text-right`} title="Drafts waiting for send approval, and open tasks">Waiting</th>
              </tr></thead>
              <tbody className="divide-y divide-slate-100 tabular-nums">
                {c.map((x) => {
                  const hot = x.firstBounceRate !== null && x.firstBounceRate > 0.02;
                  return (
                    <tr key={x.id} className="hover:bg-slate-50">
                      <td className="px-2 py-2.5"><Link href={`/leads?campaign=${x.id}`} className="font-medium">{x.name}</Link>{x.status !== "active" && <> <Badge tone={x.status === "paused" ? "amber" : "gray"}>{x.status}</Badge></>}</td>
                      <td className="px-2 py-2.5 text-right font-semibold text-slate-900">{x.leads}</td>
                      <td className="px-2 py-2.5 text-right"><b className="font-semibold text-slate-900">{x.firstEmails + x.followUps}</b>{x.followUps > 0 && <div className="text-[11px] text-slate-500">{x.followUps} follow-up{x.followUps === 1 ? "" : "s"}</div>}</td>
                      <td className="px-2 py-2.5 text-right"><RateBar rate={x.replyRate} scale={scale} />{x.replyRate != null && <div className="text-[11px] text-slate-500">{plural(x.replyLeads, "lead")}</div>}</td>
                      <td className={`px-2 py-2.5 text-right ${hot ? "font-semibold text-red-700" : x.firstBounceRate ? "text-slate-700" : "text-slate-400"}`}>{pct(x.firstBounceRate)}</td>
                      <td className="px-2 py-2.5 text-right">
                        {x.waitingSendApproval > 0 && <Link href="/send-approvals" className="no-underline"><Badge tone="amber">{x.waitingSendApproval} to approve</Badge></Link>}
                        <div className="text-[11px]"><Link href={`/schedule?open=1&campaign=${x.id}`} className="text-slate-500">{plural(x.openTasks, "open task")}</Link></div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {p.unassigned > 0 && <p className="mt-3 text-xs text-slate-500"><b className="text-amber-700">{plural(p.unassigned, "lead")}</b> in no campaign. <Link href="/campaigns">Assign →</Link></p>}
      </Panel>
    );
  });
}

export function Replies({ me, sc, className = "" }: P & { className?: string }) {
  return guard("Latest replies", className, async () => {
    const a = await loadAttention(me, sc);
    const emp = sc.teamView ? sc.requested : undefined;
    return (
      <Panel className={className} title="Latest replies" hint="What leads are saying" right={a.unansweredCount ? <More href={`/leads${q({ attention: "unanswered", owner: emp })}`}>{a.unansweredCount} not answered</More> : undefined}>
        {a.replies.length === 0 ? <Quiet>No replies recorded yet.</Quiet> : (
          <ul className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            {a.replies.slice(0, 4).map((r) => (
              <li key={r.id} className="min-w-0 border-l-2 border-viz-3/50 pl-3">
                <div className="flex items-center gap-2"><span className="min-w-0 truncate text-[13px]"><LeadLink id={r.lead_id} company={r.company} /></span>{r.classification ? <Badge tone={REPLY_TONE[r.classification] ?? "gray"}>{String(r.classification).replace(/_/g, " ")}</Badge> : null}<span className="ml-auto shrink-0 text-[11px] text-slate-500">{ago(r.occurred_at)} ago</span></div>
                <p className="mt-0.5 line-clamp-2 text-xs text-slate-600">{r.title || r.body}</p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    );
  });
}

/* ================= 4. Team and activity ================= */

export function Team({ me, sc, period, className = "" }: PP & { className?: string }) {
  return guard("Team", className, async () => {
    const [r, b, agents] = await Promise.all([loadResults(me, sc, period), loadBoard(me, sc), loadAgentIds()]);
    const load = new Map(b.workload.map((w) => [w.id, w]));
    const ids = new Set<number>([...r.byEmployee.map((e) => e.id), ...b.workload.map((w) => w.id)]);
    const rows = [...ids].map((id) => {
      const e = r.byEmployee.find((x) => x.id === id), w = load.get(id);
      return { id, name: e?.name ?? w?.name ?? `#${id}`, m: e?.m, w };
    }).filter((x) => x.w || (x.m && Object.values(x.m).some(Boolean)))
      .sort((a, z) => (z.w?.overdue ?? 0) - (a.w?.overdue ?? 0) || (z.w?.open ?? 0) - (a.w?.open ?? 0));
    const maxOpen = Math.max(1, ...rows.map((x) => x.w?.open ?? 0));
    const th = "px-2 pb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500";
    const num = (n: number | undefined) => <td className={`px-2 py-2 text-right ${n ? "font-semibold text-slate-900" : "text-slate-300"}`}>{n ?? 0}</td>;
    const back = { from: period.all ? undefined : period.from, to: period.all ? undefined : period.to, all: period.all ? 1 : undefined };
    return (
      <Panel className={className} title="Team" hint={`Open work now · output ${period.label.toLowerCase()}`} right={<More href="/my-work?employee=all">All tasks</More>}>
        {rows.length === 0 ? <Quiet>No open work and nothing recorded in this period.</Quiet> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-[13px]">
              <thead><tr className="border-b border-slate-200">
                <th className={`${th} text-left`}>Person</th><th className={`${th} w-[34%] text-left`}>Open work</th>
                <th className={`${th} text-right`}>Emails</th><th className={`${th} text-right`}>Replies</th><th className={`${th} text-right`}>Leads</th><th className={`${th} text-right`} title="Tasks completed in the period">Done</th>
              </tr></thead>
              <tbody className="divide-y divide-slate-100 tabular-nums">
                {rows.map((x) => {
                  const w = x.w;
                  const rest = w ? Math.max(0, w.open - w.overdue - w.blocked - w.ready) : 0;
                  return (
                    <tr key={x.id} className="hover:bg-slate-50">
                      <td className="px-2 py-2">
                        <div className="flex items-center gap-2.5"><Avatar name={x.name} agent={agents.has(x.id)} />
                          <div className="min-w-0">{x.id ? <Link href={`/${q({ employee: x.id, ...back })}`} className="font-medium">{x.name}</Link> : <span className="font-medium text-slate-700">{x.name}</span>}{agents.has(x.id) && <div className="text-[11px] text-slate-500">AI agent</div>}</div>
                        </div>
                      </td>
                      <td className="px-2 py-2">
                        {w ? (
                          <div className="flex items-center gap-2">
                            <div className="flex-1"><div style={{ width: `${Math.max(8, (w.open / maxOpen) * 100)}%` }}><Segments parts={[{ key: "overdue", label: "Overdue", value: w.overdue, className: STATE.overdue.bar }, { key: "ready", label: "Ready", value: w.ready, className: STATE.ready.bar }, { key: "blocked", label: "Blocked", value: w.blocked, className: STATE.blocked.bar }, { key: "rest", label: "Planned or later", value: rest, className: STATE.planned.bar }]} /></div></div>
                            <span className="w-7 text-right font-semibold text-slate-900">{w.open}</span>
                          </div>
                        ) : <span className="text-slate-300">—</span>}
                        {w && w.overdue > 0 && <div className="mt-0.5 text-[11px] font-medium text-red-700">{w.overdue} overdue</div>}
                      </td>
                      {num(x.m ? x.m.first_emails + x.m.follow_ups : undefined)}{num(x.m?.replies)}{num(x.m?.leads_added)}{num(x.m?.completed)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-100 pt-3 text-[11px] text-slate-500">
          {STATES.map((s) => <span key={s} className="inline-flex items-center gap-1.5"><span className={`h-2 w-2 rounded-full ${STATE[s].dot}`} />{s === "planned" ? "Planned or later" : STATE[s].label}</span>)}
        </div>
      </Panel>
    );
  });
}

export function Agents({ me, sc, className = "" }: P & { className?: string }) {
  return guard("AI agents", className, async () => {
    const [f, agents] = await Promise.all([loadFeed(me, sc), loadAgentIds()]);
    const api = f.api;
    return (
      <Panel className={className} title="AI agents" hint="API calls, last 24 hours" right={<More href="/agents">Every step</More>}>
        {!api || (api.last24h.length === 0 && api.steps.length === 0) ? <Quiet>Nothing has come in through the API yet.</Quiet> : (
          <>
            {api.last24h.length > 0 && (
              <ul className="space-y-2.5">
                {api.last24h.map((x) => (
                  <li key={x.id}>
                    <Link href={`/agents?actor=${x.id}`} className="flex items-center gap-2.5 text-inherit no-underline hover:no-underline">
                      <Avatar name={x.who} agent={agents.has(x.id)} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2"><span className="truncate text-[13px] font-medium text-slate-900">{x.who}</span><span className="shrink-0 text-[11px] text-slate-500">{ago(x.lastAt)} ago</span></span>
                        <span className="block truncate text-xs text-slate-500"><b className="font-semibold text-slate-900">{x.n}</b> steps · <b className="font-semibold text-slate-900">{x.changes}</b> changes{x.refused ? <span className="font-semibold text-amber-700"> · {x.refused} refused</span> : ""}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {api.steps.length > 0 && (
              <>
                <div className={`mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500 ${api.last24h.length ? "mt-4 border-t border-slate-100 pt-3" : ""}`}>Latest steps</div>
                <ul className="space-y-2">
                  {api.steps.slice(0, 5).map((s) => {
                    const bad = s.outcome === "refused" || s.outcome === "error";
                    return (
                      <li key={s.id} className="flex gap-2 text-xs">
                        <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${s.outcome === "error" ? "bg-red-500" : bad ? "bg-amber-400" : "bg-emerald-500"}`} />
                        <span className="min-w-0 flex-1">
                          <span className={`block truncate font-medium ${bad ? "text-amber-800" : "text-slate-800"}`} title={s.error ?? undefined}>{s.step}{s.outcome === "refused" ? " (refused)" : s.outcome === "error" ? " (error)" : ""}</span>
                          <span className="block truncate text-slate-500">{s.actor_name ?? "no valid key"}{s.company ? ` · ${s.company}` : s.task_id ? ` · task #${s.task_id}` : ""} · {ago(s.at)} ago</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </>
        )}
      </Panel>
    );
  });
}

const FEED_DOT: Record<string, string> = { reply: "bg-viz-3", message: "bg-viz-1", outcome: "bg-amber-400", task: "bg-slate-300", draft: "bg-brand-500", research: "bg-brand-500" };

export function Activity({ me, sc, className = "" }: P & { className?: string }) {
  return guard("Latest activity", className, async () => {
    const f = await loadFeed(me, sc);
    return (
      <Panel className={className} title="Latest activity" hint="Work recorded on leads">
        {f.feed.length === 0 ? <Quiet>No activity recorded yet.</Quiet> : (
          <ul className="space-y-2.5">
            {f.feed.map((a) => (
              <li key={a.id} className="flex gap-2.5 text-xs">
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${FEED_DOT[a.type] ?? "bg-slate-300"}`} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5"><span className="truncate text-[13px]"><LeadLink id={a.lead_id} company={a.company} /></span>{a.type === "reply" && a.classification ? <Badge tone={REPLY_TONE[a.classification] ?? "gray"}>{String(a.classification).replace(/_/g, " ")}</Badge> : null}</span>
                  <span className="block truncate text-slate-500">{a.type === "message" ? MESSAGE_KIND_LABEL[a.message_kind] ?? "Message" : ACTIVITY_TYPE_LABEL[a.type] ?? a.type} · {a.actor_name} · {fmtShort(a.occurred_at)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    );
  });
}
